/**
 * meeting_refs — 会议引用包 `MeetingAssetPack`（specs/013 · FR-010 / US-502 / T011）
 *
 * 是什么：一份会议文档引用了哪些资产、**引用时是哪一版**。三场景（纠错依据/
 * 纪要双引用/待办引用）共用这一份冻结来源（data-model §1.2）。
 *
 * 三条硬纪律（specs/013 不变量）：
 *   1. **冻结版不变味**（SC-004）：`version`/`title`/`type` 一旦写入永不回写；
 *      重复 attach 只刷 `at`/`via`，**不覆盖既有版本**（否则等于偷偷升版）。
 *      版本取值表达式与投影逐字一致：`String(asset.activeVersion || asset.version || '1')`
 *      （`recall/context-projection.ts` buildExplicitAssetView 的 assetVersions 构造，
 *      2026-09-25 实测 :767）。
 *   2. **准入判据复用既有函数，不新写一套**：`readAbilityAsset`（存在性）+
 *      `evaluateAssetRuntimeEligibility`（`formal-assets/runtime` 的统一准入闸，
 *      用户主动挑选语义 = `silentDefaultInjection:false`，与 buildExplicitAssetView
 *      的无 agentId 分支同一套；阻断原因用既有 `assetRuntimeBlockRule` 收敛成
 *      规则标识）。失败一律**码化**，渲染层按码翻四语规则名。
 *   3. **不存资产正文**：条目只有 id/版本（≤…）/标题（≤120）/类型/来源/时间
 *      （隐私边界 D20；读时派生 stale/available 是 T037 的活，本模块不落库状态）。
 *
 * 存储：`<uid>/cloud/cogseed/transcript/meeting-refs/<docKey>.json`（与词表同域，
 * research D2）；`docKey` 派生复用 meeting_doc 的确定性函数。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { safeId } from '../storage';
import { userMeetingRefsDir } from '../paths';
import { docKeyForDocId, getMeetingDoc, MAX_DOC_ID_CHARS, MeetingDocError } from './meeting_doc';
import { foldText } from './transcript_glossary';
import type { CorrectionCandidate } from './transcript_auto_correct';
import type { MeetingConclusion, MeetingConclusionAssetRef } from './meeting_conclusions';
import { readAbilityAsset } from './recall/asset-service';
import {
  assetRuntimeBlockRule,
  evaluateAssetRuntimeEligibility,
} from './recall/formal-assets/runtime';
import type { RecallAbilityAssetRecord } from './recall/candidate-service';

const log = createLogger('meeting-refs');

export const MEETING_REF_SCHEMA_VERSION = 1;
/** 引用条数上限（data-model §1.2：同一 assetId 只留一条，不同资产有界 100）。 */
export const MAX_MEETING_ASSET_REFS = 100;
/** 标题快照上限（对齐 source-service 的标题上限）。 */
const MAX_TITLE_CHARS = 120;

export type MeetingRefVia = 'attach' | 'conclusion' | 'action_draft';
export type MeetingAssetType = 'personal' | 'rule' | 'template' | 'skill_method' | 'fact';

/**
 * 会议侧引用包错误（失败一律码化 + 归因，见 `contracts/tool-contract.md` §5；
 * 渲染层按码翻四语，不上屏英文原文、不露内部 id）。
 */
export type MeetingRefErrorCode =
  | 'invalid_doc_id'      // schema
  | 'invalid_asset_id'    // schema
  | 'invalid_via'         // schema
  | 'asset_missing'       // data
  | 'asset_inactive'      // permission/data
  | 'asset_ineligible'    // permission（按规则标识翻规则名）
  | 'ref_pack_full';      // data

export class MeetingRefError extends Error {
  constructor(
    message: string,
    readonly code: MeetingRefErrorCode,
    /** 准入被哪条既有规则拦的（`assetRuntimeBlockRule` 的稳定标识，非用户文案）。 */
    readonly blockRule?: string,
  ) {
    super(message);
    this.name = 'MeetingRefError';
  }
}

export interface MeetingAssetRef {
  assetId: string;
  /** **冻结版**：引用时的在用版。取值表达式与既有投影逐字一致（文件头纪律 1）。 */
  version: string;
  /** 引用时的标题快照（≤120）。资产后来改名，这里仍是当时名（不变味）。 */
  title: string;
  /** 引用时的类型快照。 */
  type: MeetingAssetType;
  /** 引用来源：谁把它引起来的。 */
  via: MeetingRefVia;
  /** 引用建立/最近确认时间。 */
  at: string;
}

export interface MeetingAssetPack {
  schemaVersion: 1;
  docId: string;
  /** 有界 100；同一 assetId 只保留最新一次引用（重复引用不叠条目，只刷新 at/via）。 */
  assetRefs: MeetingAssetRef[];
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function meetingRefsFile(uid: string, docId: string): string {
  return path.join(userMeetingRefsDir(uid), `${docKeyForDocId(docId)}.json`);
}

function emptyPack(docId: string): MeetingAssetPack {
  const at = nowIso();
  return { schemaVersion: MEETING_REF_SCHEMA_VERSION, docId, assetRefs: [], createdAt: at, updatedAt: at };
}

function readPack(uid: string, docId: string): MeetingAssetPack | null {
  const file = meetingRefsFile(uid, docId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MeetingAssetPack>;
    if (!raw || typeof raw !== 'object' || raw.docId !== docId) return null;
    if (raw.schemaVersion !== MEETING_REF_SCHEMA_VERSION) {
      log.warn('meeting ref pack unknown schema version; treated as missing', { schemaVersion: raw.schemaVersion });
      return null;
    }
    if (!Array.isArray(raw.assetRefs)) return null;
    return raw as MeetingAssetPack;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') log.warn('meeting ref pack unreadable; treated as missing', { code });
    return null;
  }
}

function writePack(uid: string, pack: MeetingAssetPack): void {
  const file = meetingRefsFile(uid, pack.docId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pack, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function requireDocId(docId: string): string {
  const id = typeof docId === 'string' ? docId.trim() : '';
  if (!id || id.length > MAX_DOC_ID_CHARS) {
    throw new MeetingRefError('invalid meeting docId', 'invalid_doc_id');
  }
  return id;
}

function normalizeVia(via: unknown): MeetingRefVia {
  if (via === undefined || via === null || via === '') return 'attach';
  if (via === 'attach' || via === 'conclusion' || via === 'action_draft') return via;
  throw new MeetingRefError('invalid meeting ref via', 'invalid_via');
}

/**
 * 准入：`readAbilityAsset` + `evaluateAssetRuntimeEligibility`（既有判据，不新写）。
 * 失败码化：missing → `asset_missing`；非 active → `asset_inactive`；其余阻断 →
 * `asset_ineligible`（带 `assetRuntimeBlockRule` 的稳定规则标识）。
 *
 * 说明：与 buildExplicitAssetView 的差别只有一处——会议挂载不检查
 * `sourceAvailable`（来源撤权）：会议引用是**追溯指针**不是注入授权，撤权后
 * 该不该继续引用由读时的 `available`/`stale` 呈现如实说（T037/T039），不在
 * 写入侧静默拒绝（那会让"当时引用过"这一事实消失）。
 */
async function admitAsset(uid: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  let asset: RecallAbilityAssetRecord;
  try {
    asset = await readAbilityAsset(uid, assetId);
  } catch {
    throw new MeetingRefError(`meeting ref asset missing: ${assetId}`, 'asset_missing');
  }
  if (asset.status !== 'active') {
    throw new MeetingRefError(`meeting ref asset not active: ${assetId}`, 'asset_inactive', assetRuntimeBlockRule(asset.status, ['status_not_active']));
  }
  const gate = evaluateAssetRuntimeEligibility({
    status: asset.status,
    maturity: asset.maturity,
    lifecycleStatus: asset.lifecycleStatus,
    scope: asset.scope,
    ...(asset.crossScopeConfirmedAt ? { crossScopeConfirmedAt: asset.crossScopeConfirmedAt } : {}),
    ...(asset.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}),
    ...(asset.applicableWhen ? { applicableWhen: asset.applicableWhen } : {}),
    ...(asset.forbiddenWhen ? { forbiddenWhen: asset.forbiddenWhen } : {}),
    ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
  }, {
    // 用户主动挂载（不是静默默认注入）：成熟度与适用条件不作硬门槛，
    // 权限与状态门照过——与 buildExplicitAssetView 的语义一致。
    silentDefaultInjection: false,
  });
  if (!gate.eligible && gate.reasons.length) {
    throw new MeetingRefError(
      `meeting ref asset ineligible: ${assetId}`,
      'asset_ineligible',
      assetRuntimeBlockRule(asset.status, gate.reasons),
    );
  }
  return asset;
}

export interface AttachMeetingAssetResult {
  /** 命中幂等分支时为刷新后的既有条目（version/title/type 保持冻结值）。 */
  ref: MeetingAssetRef;
  pack: MeetingAssetPack;
}

/**
 * 挂载/确认一条资产引用（用户发起；重复 attach 幂等：**不覆盖既有 version**，
 * 只刷 `at`/`via`）。冻结版表达式与投影逐字一致（文件头纪律 1）。
 */
export async function attachMeetingAsset(
  uid: string,
  docId: string,
  assetId: string,
  via: MeetingRefVia | undefined = 'attach',
): Promise<AttachMeetingAssetResult> {
  const id = requireDocId(docId);
  const asset = typeof assetId === 'string' && safeId(assetId) ? assetId : '';
  if (!asset) throw new MeetingRefError('invalid meeting assetId', 'invalid_asset_id');
  const viaValue = normalizeVia(via);
  // 先过准入（读现状），再进幂等分支——重复引用也要确认资产今天仍然可用。
  const record = await admitAsset(uid, asset);

  const pack = readPack(uid, id) ?? emptyPack(id);
  const at = nowIso();
  const existing = pack.assetRefs.find((ref) => ref.assetId === asset);
  if (existing) {
    // 冻结版不变味：version/title/type 一律保留写入时的值，只刷 at/via。
    existing.via = viaValue;
    existing.at = at;
    pack.updatedAt = at;
    writePack(uid, pack);
    return { ref: existing, pack };
  }
  if (pack.assetRefs.length >= MAX_MEETING_ASSET_REFS) {
    // 不静默挤掉最旧引用（那等于偷偷撤销用户建立过的引用）：如实拒绝。
    throw new MeetingRefError('meeting ref pack is full', 'ref_pack_full');
  }
  const ref: MeetingAssetRef = {
    assetId: asset,
    version: String(record.activeVersion || record.version || '1'),
    title: String(record.title ?? '').slice(0, MAX_TITLE_CHARS),
    type: record.type,
    via: viaValue,
    at,
  };
  pack.assetRefs.push(ref);
  pack.updatedAt = at;
  writePack(uid, pack);
  return { ref, pack };
}

/** 撤销一条资产引用（幂等：条目不存在时返回当前包，不报错）。 */
export async function detachMeetingAsset(
  uid: string,
  docId: string,
  assetId: string,
): Promise<MeetingAssetPack> {
  const id = requireDocId(docId);
  const asset = typeof assetId === 'string' && safeId(assetId) ? assetId : '';
  if (!asset) throw new MeetingRefError('invalid meeting assetId', 'invalid_asset_id');
  const pack = readPack(uid, id);
  if (!pack) return emptyPack(id);
  const before = pack.assetRefs.length;
  pack.assetRefs = pack.assetRefs.filter((ref) => ref.assetId !== asset);
  if (pack.assetRefs.length !== before) {
    pack.updatedAt = nowIso();
    writePack(uid, pack);
  }
  return pack;
}

/** 该文档的资产引用清单（只读；缺失 → 空数组。现状对比/stale 是读时派生，T037）。 */
export async function listMeetingAssetRefs(uid: string, docId: string): Promise<MeetingAssetRef[]> {
  const id = requireDocId(docId);
  const pack = readPack(uid, id);
  return pack ? [...pack.assetRefs] : [];
}

/** 该文档的引用包整体（缺失 → 空 pack；纪要双引用从同一份冻结取，T035 用）。 */
export async function readMeetingAssetPack(uid: string, docId: string): Promise<MeetingAssetPack> {
  const id = requireDocId(docId);
  return readPack(uid, id) ?? emptyPack(id);
}

// ── T027：资产规范名进纠错依据（specs/013 FR-001 后半的依据来源）─────────────

/**
 * 本会议挂载资产的"规范名"清单条目（specs/013 T027）。
 *
 * `name` = 资产 statement 的规范形态（退 title；取值表达式与候选服务的既有
 * 资产文本形态一致 `String(asset.statement || asset.title || '')`，不新写一套）。
 * `version`/`title` 一律取**引用包里的冻结值**——不是资产的当前版（SC-004：
 * 依据标注的是"开会当时引用的那一版"，资产事后升版不改变当时的依据）。
 */
export interface MeetingAssetCanonicalName {
  /** 资产规范名（statement ‖ title，主进程内存内匹配用；不进引用包、不进候选 refs）。 */
  name: string;
  assetId: string;
  /** 挂载时的**冻结版**（非当前版）。 */
  version: string;
  /** 挂载时的标题快照（≤120）。 */
  title: string;
}

/**
 * 本会议的资产规范名清单（只读派生，specs/013 T027）。
 *
 * - `version`/`title` 取引用包冻结值；`name` **读时**从资产现记录取
 *   （引用包不存正文，隐私边界 D20——规范名只在主进程内存里做匹配，
 *   不落引用包、不进候选 refs）；
 * - 资产已彻底删除（读不到）或已非 `active` → 该条**如实跳过**（宁少不多，
 *   不造依据）：停用资产的规范名不再作为纠错依据；引用本身的 stale/available
 *   呈现是 T037 的活，这里只管"参不参与匹配"这道闸。
 */
export async function listMeetingAssetCanonicalNames(
  uid: string,
  docId: string,
): Promise<MeetingAssetCanonicalName[]> {
  const id = requireDocId(docId);
  const pack = readPack(uid, id);
  if (!pack || !pack.assetRefs.length) return [];
  const out: MeetingAssetCanonicalName[] = [];
  for (const ref of pack.assetRefs) {
    let asset: RecallAbilityAssetRecord;
    try {
      asset = await readAbilityAsset(uid, ref.assetId);
    } catch {
      continue; // 资产已删/不可读：如实跳过，不造依据
    }
    if (asset.status !== 'active') continue;
    const name = String(asset.statement || asset.title || '').trim();
    if (!name) continue;
    out.push({ name, assetId: ref.assetId, version: ref.version, title: ref.title });
  }
  return out;
}

/**
 * 把资产规范名追加进候选依据（specs/013 T027）：候选建议写法（`correct`，
 * 折叠比较——与 `attachOntologyRefs` 同一套折叠与命中判据）命中规范名 →
 * 给该候选**追加** `{ source:'asset', assetId, version, title }` 并列依据，
 * `version` 用清单带来的冻结值。
 *
 * 只读纯函数（形态逐字对齐 `attachOntologyRefs`）：未命中的候选**原样返回**
 * （对象不复制、refs 不动）；命中则产出新对象（不改入参）；同一 assetId
 * 不重复追加（幂等）。
 */
export function attachAssetRefs(
  candidates: CorrectionCandidate[],
  names: MeetingAssetCanonicalName[],
): CorrectionCandidate[] {
  if (!names.length || !candidates.length) return candidates;
  const byFoldedName = new Map<string, MeetingAssetCanonicalName>();
  for (const item of names) {
    const key = foldText(String(item?.name ?? '')).trim();
    if (!key || byFoldedName.has(key)) continue;
    byFoldedName.set(key, item);
  }
  return candidates.map((candidate) => {
    const hit = byFoldedName.get(foldText(candidate.correct ?? '').trim());
    if (!hit) return candidate;
    const existing = Array.isArray(candidate.refs) ? candidate.refs : [];
    if (existing.some((ref) => ref.source === 'asset' && ref.assetId === hit.assetId)) return candidate;
    return {
      ...candidate,
      refs: [...existing, { source: 'asset', assetId: hit.assetId, version: hit.version, title: hit.title }],
    };
  });
}

// re-export：IPC 层（T013）与 meeting_conclusions（T035）共用同一套 docId 校验语义。
export { MeetingDocError };

// ── T037：读时派生视图 `MeetingAssetRefView`（specs/013 FR-004「可与现状对比」）───

/**
 * 引用条目的**读时派生**视图（不落库——冻结版永不回写，对比永远是现算）：
 *
 * | 字段 | 计算 | 语义对齐 |
 * |---|---|---|
 * | `currentVersion` | `String(asset.activeVersion \|\| asset.version \|\| '1')` | 与投影同一表达式（`context-projection.ts:767`，逐字） |
 * | `currentTitle`   | 资产当前标题（≤120） | 供「冻结版 vs 现状」对比展示 |
 * | `stale`          | `currentVersion !== version` | **逐字对齐** `projection-card.ts:26`/`:111`：「钉住的版本 ≠ 资产当前版本」 |
 * | `available`      | 资产当前 `status === 'active'` | 归档/暂停/删除/彻底不可读 ⇒ false（「被引用版本已不存在」由文案如实呈现，T039） |
 *
 * 资产**彻底不可读**（已物理删除等）时：`available:false` + `currentVersion:''` +
 * `currentTitle:''` + `stale:false`——**不假装读到了那一版**（'' = 现状未知，
 * 不是猜出来的一版）；`stale:false` 只表示「无漂移证据」，不表示「没漂移」。
 */
export interface MeetingAssetRefView extends MeetingAssetRef {
  /** 现状版本（读时派生）；资产不可读时为 `''`（现状未知，不猜）。 */
  currentVersion: string;
  /** 现状标题（读时派生，≤120）；资产不可读时为 `''`。 */
  currentTitle: string;
  /** `currentVersion !== version`（语义与 `projection-card.ts:26` 同名同义）。 */
  stale: boolean;
  /** 资产当前 `status === 'active'`；归档/暂停/删除/不可读 ⇒ `false`。 */
  available: boolean;
}

/** 单条视图派生（纯函数；`asset === null` = 资产已彻底删除/不可读）。 */
export function deriveMeetingAssetRefView(
  ref: MeetingAssetRef,
  asset: RecallAbilityAssetRecord | null,
): MeetingAssetRefView {
  if (!asset) {
    return { ...ref, currentVersion: '', currentTitle: '', stale: false, available: false };
  }
  // 与投影逐字同一表达式（文件头纪律 1；不写第二套版本取值）。
  const currentVersion = String(asset.activeVersion || asset.version || '1');
  return {
    ...ref,
    currentVersion,
    currentTitle: String(asset.title ?? '').slice(0, MAX_TITLE_CHARS),
    // 逐字对齐 projection-card.ts:111：「钉住的版本 !== 当前版本」才算漂移。
    stale: currentVersion !== ref.version,
    available: asset.status === 'active',
  };
}

/**
 * 该文档引用清单的**现状对比视图**（只读派生，绝不回写引用包）。
 * 单条资产读失败只影响该条（如实 `available:false`），不拖垮整张清单。
 */
export async function listMeetingAssetRefViews(uid: string, docId: string): Promise<MeetingAssetRefView[]> {
  const id = requireDocId(docId);
  const pack = readPack(uid, id);
  if (!pack || !pack.assetRefs.length) return [];
  const views: MeetingAssetRefView[] = [];
  for (const ref of pack.assetRefs) {
    let asset: RecallAbilityAssetRecord | null = null;
    try {
      asset = await readAbilityAsset(uid, ref.assetId);
    } catch {
      asset = null; // 已彻底删除等：如实呈现，不抛错、不假装读到
    }
    views.push(deriveMeetingAssetRefView(ref, asset));
  }
  return views;
}

// ── T050/T052：确定性跨会议关联（specs/013 · US-505 / FR-007）───────────────

/** 命中方式：按 assetId 反查（asset）或按术语对规范名的折叠等值命中（term）。 */
export type MeetingRelatedMatchedBy = 'asset' | 'term';

/**
 * 一条「上次提到」关联建议（contracts/ipc.md §1.5 返回体）：
 * 哪场会（docId/title）· 哪条结论（conclusionId/summary）· 相关资产标识
 * （assetIds，只有 id——不含资产正文，隐私边界 D20）· 怎么命中的（matchedBy）。
 */
export interface RelatedMeetingRef {
  docId: string;
  title: string;
  conclusionId: string;
  summary: string;
  assetIds: string[];
  matchedBy: MeetingRelatedMatchedBy;
}

export interface RelatedMeetingRefsOptions {
  /** 本次查询的会议（**自身不进结果**——自己引用自己不是「上次提到」）。 */
  docId?: string;
  /** 反查用资产 id 清单（contracts/ipc.md §1.5：每项 safeId、≤50）。 */
  assetIds?: string[];
  /** 术语清单（每项 ≤60、≤20；对规范名做折叠等值命中）。 */
  terms?: string[];
}

/** 域扫描的最小条目（conclusions 是 meeting_conclusions 落进同一文件的段；只取关联要用的字段）。 */
interface MeetingRefsDomainEntry {
  docId: string;
  updatedAt: string;
  conclusions: Array<Partial<MeetingConclusion>>;
}

/**
 * 遍历用户 meeting-refs 域（`meeting-refs/*.json`，data-model §4 的既定口径：
 * 单用户量级直扫、无索引）。坏文件/未知 schemaVersion/无 docId 的文件**跳过**
 * 不报错（对齐 `listMeetingDocs` 的容错）；输出按 `updatedAt` 倒序、同刻按
 * `docId` 升序——**纯文件内容派生的全序**，同输入两次扫描结果逐字节一致。
 */
function scanMeetingRefsDomain(uid: string): MeetingRefsDomainEntry[] {
  const dir = userMeetingRefsDir(uid);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // 域不存在（该用户还没有任何会议引用）：空域，不报错
  }
  const out: MeetingRefsDomainEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: Partial<MeetingAssetPack> & { conclusions?: unknown; updatedAt?: unknown };
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // 单文件损坏不拖垮清单（对齐 listMeetingDocs 的容错口径）
    }
    if (!raw || typeof raw !== 'object' || typeof raw.docId !== 'string' || !raw.docId) continue;
    if (raw.docId.length > MAX_DOC_ID_CHARS) continue; // 脏长度会让下游 requireDocId 抛错：跳过
    if (raw.schemaVersion !== MEETING_REF_SCHEMA_VERSION) continue; // 不认识的版本：不猜字段（data-model §3）
    out.push({
      docId: raw.docId,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      conclusions: Array.isArray(raw.conclusions)
        ? raw.conclusions.filter((c): c is Partial<MeetingConclusion> => !!c && typeof c === 'object')
        : [],
    });
  }
  return out.sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)) || (a.docId < b.docId ? -1 : 1));
}

/** 关联建议里的会议展示名：文档模型标题（只读探测），缺失回退文件名段（与 buildConclusionCandidateInput 同一表达式）。 */
function meetingDisplayTitle(uid: string, docId: string): string {
  try {
    const doc = getMeetingDoc(uid, docId, { create: false });
    if (doc?.title) return String(doc.title).slice(0, MAX_TITLE_CHARS);
  } catch {
    // docId 超界等形状问题：回退文件名段，不让一条脏记录拖垮整张清单
  }
  return docId.split(/[\\/]/).filter(Boolean).pop() || docId;
}

/**
 * 【T050】确定性跨会议关联（只读；零语义、零模型调用）。
 *
 * 口径（research.md D13 / contracts/ipc.md §1.5）：
 *   - **assetIds 路**：反查历史会议结论条目的 `assetRefs[].assetId` 精确成员
 *     命中——会议引用包/结论里只有 id/版本/标题快照，成员判断就是全部判据；
 *   - **terms 路**：对历史会议**挂载资产的规范名**做字符串命中——规范名取
 *     既有读函数 `listMeetingAssetCanonicalNames`（statement‖title，T027），
 *     命中判据复用 `attachAssetRefs` 的折叠等值（`foldText(a).trim() ===
 *     foldText(b).trim()`，与 `attachOntologyRefs` 同一套，不新写第二套判据）；
 *     词条/规范名之外的形态（无关词）折叠后不相等 ⇒ 不命中，无误报；
 *   - `assetIds` 与 `terms` 都空 ⇒ 空数组（不报错）；
 *   - 同一条结论被两路同时命中 ⇒ 只出一条，`matchedBy:'asset'`（资产命中是
 *     更强的信号；不重复列）；
 *   - 结果条目 = 历史会议的**一条结论**（conclusion 级）：只有真正引用过命中
 *     资产的结论才算「上次提到」（宁少不多，不造关联）。
 *
 * 【T052】历史缺结构化引用降级（Edge Case）：结论无锚点（无 `transcriptRefs`
 * 字段/为空，含 legacy_record、no_transcript_ref 旧形态）或无 `assetRefs` ⇒
 * 该条**不进关联结果、不报错**——没有任何「猜测性」关联。
 *
 * 不变量（tasks.md 反漂移表）：**只给建议，不自动建立引用**——本函数纯只读，
 * 不写任何文件；「点了才落库」是面板按钮 + `attachMeetingAsset` 的事（T051）。
 */
export async function relatedMeetingRefs(
  uid: string,
  options: RelatedMeetingRefsOptions = {},
): Promise<RelatedMeetingRef[]> {
  const selfDocId = typeof options?.docId === 'string' ? options.docId.trim() : '';
  const assetIdSet = new Set(
    (Array.isArray(options?.assetIds) ? options.assetIds : [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const foldedTerms = new Set(
    (Array.isArray(options?.terms) ? options.terms : [])
      .filter((term): term is string => typeof term === 'string')
      .map((term) => foldText(term).trim())
      .filter(Boolean),
  );
  if (!assetIdSet.size && !foldedTerms.size) return []; // 两路都空 ⇒ 空数组，不报错

  const out: RelatedMeetingRef[] = [];
  for (const entry of scanMeetingRefsDomain(uid)) {
    if (selfDocId && entry.docId === selfDocId) continue; // 自身会议不进「上次提到」
    // terms 路的规范名清单：既有读函数（T027）——资产已删/非 active 的条目
    // 它自己会如实跳过（不造名字）；terms 路没开就不读（不多花一次盘）。
    const canonicalNames = foldedTerms.size
      ? await listMeetingAssetCanonicalNames(uid, entry.docId)
      : [];
    for (const conclusion of entry.conclusions) {
      // T052：无锚点（旧形态/无转写引用）或无 assetRefs ⇒ 不进结果、不报错。
      if (!Array.isArray(conclusion.transcriptRefs) || !conclusion.transcriptRefs.length) continue;
      const refs = Array.isArray(conclusion.assetRefs)
        ? conclusion.assetRefs.filter((r): r is MeetingConclusionAssetRef =>
            !!r && typeof r === 'object' && typeof r.assetId === 'string' && !!r.assetId)
        : [];
      if (!refs.length) continue;

      const byAsset = dedupeStrings(refs.filter((r) => assetIdSet.has(r.assetId)).map((r) => r.assetId));
      let matchedBy: MeetingRelatedMatchedBy | null = null;
      let matchedIds: string[] = [];
      if (byAsset.length) {
        matchedBy = 'asset';
        matchedIds = byAsset;
      } else if (foldedTerms.size) {
        // 折叠等值命中（attachAssetRefs 的同一判据）：规范名折叠后与术语折叠后相等。
        const byTerm: string[] = [];
        for (const ref of refs) {
          const canonical = canonicalNames.find((item) => item.assetId === ref.assetId);
          if (!canonical) continue;
          if (foldedTerms.has(foldText(canonical.name).trim())) byTerm.push(ref.assetId);
        }
        if (byTerm.length) {
          matchedBy = 'term';
          matchedIds = dedupeStrings(byTerm);
        }
      }
      if (!matchedBy) continue;
      out.push({
        docId: entry.docId,
        title: meetingDisplayTitle(uid, entry.docId),
        conclusionId: typeof conclusion.id === 'string' ? conclusion.id : '',
        summary: typeof conclusion.summary === 'string' ? conclusion.summary : '',
        assetIds: matchedIds,
        matchedBy,
      });
    }
  }
  return out;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
