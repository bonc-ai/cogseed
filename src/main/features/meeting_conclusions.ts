/**
 * meeting_conclusions — 纪要条目实体 `MeetingConclusion`（specs/013 · US-502 / T034~T036）
 *
 * 是什么：会议纪要里的一条关键结论 + **双引用**（FR-003）——
 *   - `transcriptRefs`：段落锚点 `{utteranceId, blockIndex, from, to}`，沿用
 *     `SourceUtterance.id` 的 `U0001` 体系（transcript_rewrite.ts:66-73「这是锚点，
 *     不随清理变化」；id 由 `transcript_clean_pipeline.parseSource` 冻结解析产出）；
 *   - `assetRefs`：结论引用的资产，版本快照**从本文件的引用包取**（meeting_refs
 *     的同一份冻结，data-model §1.3——挂载时的准入与冻结发生在 attach，这里只取）。
 *
 * 三条硬纪律（specs/013 不变量表）：
 *   1. **双引用不存正文**：记录里只有 id/版本/标题（≤120 快照）/摘要（≤240）/锚点。
 *      `options.text` 只进不出——仅供锚点解析（T036），绝不落盘。
 *   2. **冻结版不变味**：`assetRefs[].version` 复制自引用包的冻结值；资产事后升版
 *      不回写（与现状对比是读时派生，见 meeting_refs::listMeetingAssetRefViews，T037）。
 *   3. **旧数据降级为不可关联，不报错**（Edge Case）：锚点缺失/解析不到 ⇒
 *      `unlinkable ∈ {no_transcript_ref, anchor_not_found, legacy_record}`，条目照常可读。
 *
 * 存储（data-model §0）：与引用包**同文件** `<uid>/cloud/cogseed/transcript/meeting-refs/
 * <docKey>.json` 的 `conclusions[]`——同一份文档的引用与条目天然同生命周期。本模块
 * 读写该文件时**原样保留 `assetRefs`**（引用包由 meeting_refs 管理，职责不越界）。
 *
 * T034 范围：save / list / confirm。
 * T045/T046 范围：`buildConclusionCandidateInput`（结论→候选的**确定性组装**，
 * 单一函数出口）与 `precipitateMeetingConclusion`（必过确认闸的沉淀写口，只到
 * 候选不到资产——调既有 `saveRecallCandidate`，不放宽其 `reviewReady`）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../logger';
import { userMeetingRefsDir } from '../paths';
import { docKeyForDocId, getMeetingDoc, MAX_DOC_ID_CHARS } from './meeting_doc';
import { MEETING_REF_SCHEMA_VERSION } from './meeting_refs';
import type { MeetingAssetRef, MeetingAssetType } from './meeting_refs';
import { parseSource } from './transcript_clean_pipeline';
import { saveRecallCandidate } from './recall/candidate-service';
import type { SaveRecallCandidateInput } from './recall/candidate-service';
import { cognitionContextFileSourceId } from './recall/source-catalog';

const log = createLogger('meeting-conclusions');

/** 摘要上限（IPC 契约 §4「文本有界」：summary ≤240）。 */
export const MAX_MEETING_CONCLUSION_SUMMARY = 240;
/** 条目 id 上限（对齐 §4 的 itemId ≤128）。 */
export const MAX_CONCLUSION_ID_CHARS = 128;
/** 锚点 utteranceId 形态：`U0001` 体系（`U` + 1~8 位数字，parseSource 逐字同源）。 */
const UTTERANCE_ID_RE = /^U\d{1,8}$/;

export type MeetingConclusionStatus = 'draft' | 'confirmed' | 'precipitated';
/** 不可关联的原因（如实标注，不猜、不报错；data-model §1.3）。 */
export type MeetingUnlinkableReason = 'no_transcript_ref' | 'anchor_not_found' | 'legacy_record';

/**
 * 会议侧纪要错误（失败一律码化 + 归因 schema/data/workflow；渲染层按码翻四语）。
 * `invalid_*` = 形状不合法；`item_not_found` = 条目不存在。
 * 沉淀线新增（T046/T048，contracts/ipc.md §1.3 失败码表）：
 *   - `not_confirmed`：未确认就沉淀（workflow）；
 *   - `unknown_scenario`：suggestedType 不在既有资产类型枚举（schema）；
 *   - `field_not_available`：tags/category（012 边界，如实拒绝不静默丢弃）；
 *   - `candidate_write_failed`：既有候选写失败（data，含敏感内容闸命中）。
 */
export type MeetingConclusionErrorCode =
  | 'invalid_doc_id'
  | 'invalid_summary'
  | 'invalid_item_id'
  | 'invalid_input'
  | 'invalid_anchor'
  | 'item_not_found'
  | 'not_confirmed'
  | 'unknown_scenario'
  | 'field_not_available'
  | 'candidate_write_failed';

export class MeetingConclusionError extends Error {
  constructor(message: string, readonly code: MeetingConclusionErrorCode) {
    super(message);
    this.name = 'MeetingConclusionError';
  }
}

/** 段落锚点：`U0001` 体系（utteranceId 为主定位，blockIndex 供旧数据兜底）。 */
export interface MeetingTranscriptAnchor {
  /** 稳定段落锚点（SourceUtterance.id，`U0001` 起按原文顺序；不随清理变化）。 */
  utteranceId: string;
  /** 段落序号（0 起，相对 parseSource 产出；无 id 的旧数据定位用）。 */
  blockIndex: number;
  /** 句内起始偏移（相对该段文本）。 */
  from: number;
  /** 句内结束偏移（相对该段文本，不含 to）。 */
  to: number;
}

/** 纪要条目里的资产引用快照（从本文件引用包复制的冻结值，data-model §1.3）。 */
export interface MeetingConclusionAssetRef {
  assetId: string;
  /** 引用时的冻结版（与引用包同一份冻结，不是当前版）。 */
  version: string;
  /** 引用时的标题快照（≤120）。 */
  title: string;
  /** 引用时的类型快照。 */
  type: MeetingAssetType;
}

export interface MeetingConclusion {
  /** 确定性派生：`mc_<sha1(docId + blockIndex + from + to + 归一化摘要)>`。 */
  id: string;
  docId: string;
  /** 摘要/标题（≤240）。**不是**转写正文切片。 */
  summary: string;
  /** 转写引用（空 = 不可关联，见 unlinkable）。 */
  transcriptRefs: MeetingTranscriptAnchor[];
  /** 资产引用（可空）。快照取自本文件的引用包（同一份冻结）。 */
  assetRefs: MeetingConclusionAssetRef[];
  status: MeetingConclusionStatus;
  /** 沉淀去向：候选 id（T045/T046 回填，本模块只留字段位）。 */
  candidateId?: string;
  precipitatedAt?: string;
  /** 不可关联原因（历史纪要缺结构化引用时如实标注，不报错）。 */
  unlinkable?: MeetingUnlinkableReason;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingConclusionInput {
  summary: string;
  /** 段落锚点清单（缺省/空 ⇒ unlinkable:'no_transcript_ref'）。 */
  transcriptRefs?: MeetingTranscriptAnchor[];
  /**
   * 要关联的资产：assetId 清单（字符串或 `{assetId}` 对象皆可，IPC 直通形态）。
   * 版本快照**从本文件引用包取**——不在包里的 assetId 没有冻结版可取，
   * 如实跳过（宁少不多，不造引用）；挂载（准入+冻结）是 attach 的职责，这里不做。
   */
  assetRefs?: Array<string | { assetId: string }>;
}

export interface SaveMeetingConclusionOptions {
  /** 显式 id（编辑既有条目用；缺省确定性派生）。须过 `safeId` 形态且 ≤128。 */
  id?: string;
  /**
   * 转写正文——**只进不出**：仅供锚点解析（解析不到 ⇒ anchor_not_found），
   * 绝不落盘（记录里只有锚点，没有正文）。
   */
  text?: string;
}

// ── 存储（与引用包同文件，data-model §0）────────────────────────────────

/** 引用包文件的完整落盘形态（`conclusions` 由本模块维护，`assetRefs` 原样保留）。 */
interface MeetingRefsFileBody {
  schemaVersion: number;
  docId: string;
  assetRefs: MeetingAssetRef[];
  conclusions?: MeetingConclusion[];
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function meetingRefsBodyFile(uid: string, docId: string): string {
  return path.join(userMeetingRefsDir(uid), `${docKeyForDocId(docId)}.json`);
}

function readBody(uid: string, docId: string): MeetingRefsFileBody | null {
  const file = meetingRefsBodyFile(uid, docId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MeetingRefsFileBody>;
    if (!raw || typeof raw !== 'object' || raw.docId !== docId) return null;
    if (raw.schemaVersion !== MEETING_REF_SCHEMA_VERSION) {
      // 记录版本不认识：如实当缺失，不猜字段（data-model §3）。
      log.warn('meeting conclusions carrier unknown schema version; treated as missing', { schemaVersion: raw.schemaVersion });
      return null;
    }
    if (!Array.isArray(raw.assetRefs)) return null;
    return raw as MeetingRefsFileBody;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') log.warn('meeting conclusions carrier unreadable; treated as missing', { code });
    return null;
  }
}

function writeBody(uid: string, body: MeetingRefsFileBody): void {
  const file = meetingRefsBodyFile(uid, body.docId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── 校验与归一 ──────────────────────────────────────────────────────────

function requireDocId(docId: string): string {
  const id = typeof docId === 'string' ? docId.trim() : '';
  if (!id || id.length > MAX_DOC_ID_CHARS) {
    throw new MeetingConclusionError('invalid meeting docId', 'invalid_doc_id');
  }
  return id;
}

/** 摘要归一（id 派生用）：trim + 折叠空白——只影响派生键，不改存储内容。 */
function normalizeSummaryForId(summary: string): string {
  return String(summary ?? '').trim().replace(/\s+/g, ' ');
}

function requireSummary(summary: unknown): string {
  if (typeof summary !== 'string') {
    throw new MeetingConclusionError('meeting conclusion summary must be a string', 'invalid_summary');
  }
  const text = summary.trim();
  if (!text || Array.from(text).length > MAX_MEETING_CONCLUSION_SUMMARY) {
    throw new MeetingConclusionError('meeting conclusion summary empty or over 240 chars', 'invalid_summary');
  }
  return text;
}

/** 锚点清单归一：逐条校验形状（U 体系 + 整数偏移 + from<to），去重保序。 */
function normalizeAnchors(value: unknown): MeetingTranscriptAnchor[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MeetingConclusionError('meeting conclusion transcriptRefs must be an array', 'invalid_input');
  }
  const out: MeetingTranscriptAnchor[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      throw new MeetingConclusionError('meeting conclusion anchor must be an object', 'invalid_anchor');
    }
    const { utteranceId, blockIndex, from, to } = raw as Record<string, unknown>;
    if (typeof utteranceId !== 'string' || !UTTERANCE_ID_RE.test(utteranceId)) {
      throw new MeetingConclusionError('meeting conclusion anchor utteranceId must follow U0001 scheme', 'invalid_anchor');
    }
    if (!Number.isInteger(blockIndex) || (blockIndex as number) < 0) {
      throw new MeetingConclusionError('meeting conclusion anchor blockIndex must be a non-negative integer', 'invalid_anchor');
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) <= (from as number)) {
      throw new MeetingConclusionError('meeting conclusion anchor offsets must satisfy 0 <= from < to', 'invalid_anchor');
    }
    const key = `${utteranceId}:${blockIndex}:${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ utteranceId, blockIndex: blockIndex as number, from: from as number, to: to as number });
  }
  return out;
}

/** 资产引用入参归一为 assetId 清单（字符串或 `{assetId}` 皆可），去重保序。 */
function normalizeAssetIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MeetingConclusionError('meeting conclusion assetRefs must be an array', 'invalid_input');
  }
  const ids: string[] = [];
  for (const entry of value) {
    const id = typeof entry === 'string'
      ? entry.trim()
      : entry && typeof entry === 'object' && typeof (entry as { assetId?: unknown }).assetId === 'string'
        ? ((entry as { assetId: string }).assetId).trim()
        : '';
    if (!id) {
      throw new MeetingConclusionError('meeting conclusion assetRef missing assetId', 'invalid_input');
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ── 锚点解析（T036）─────────────────────────────────────────────────────

/** 锚点解析结果（**不含正文**——只有定位信息，正文永远在知识库里）。 */
export interface ResolvedMeetingAnchor {
  utteranceId: string;
  speaker: string;
  at: string;
  from: number;
  to: number;
}

/**
 * 解析单个锚点到转写的具体段落（纯函数）。
 *
 * - 主定位：`utteranceId`（U 体系，与 `parseSource` 冻结解析同源）；
 * - 兜底：id 没命中时按 `blockIndex` 定位（无 id 的旧数据）；
 * - 解析不到（无该段 / 偏移越界）⇒ 返回 `null`——**不抛错**，降级由调用方标注
 *   `unlinkable:'anchor_not_found'`（Edge Case「旧数据降级为不可关联，不报错」）。
 */
export function resolveMeetingTranscriptAnchor(
  anchor: MeetingTranscriptAnchor,
  utterances: Array<{ id: string; speaker?: string; at?: string; text: string }>,
): ResolvedMeetingAnchor | null {
  if (!anchor || typeof anchor !== 'object') return null;
  const byId = utterances.find((u) => u && u.id === anchor.utteranceId);
  const target = byId
    ?? (Number.isInteger(anchor.blockIndex) && anchor.blockIndex >= 0 ? utterances[anchor.blockIndex] : undefined);
  if (!target) return null;
  const text = String(target.text ?? '');
  const from = anchor.from;
  const to = anchor.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > text.length) return null;
  return {
    utteranceId: target.id,
    speaker: String(target.speaker ?? ''),
    at: String(target.at ?? ''),
    from,
    to,
  };
}

/** 哪些锚点解析不到（纯函数；save 的 anchor_not_found 判定与面板定位共用同一判据）。 */
export function unresolvedMeetingAnchorIds(text: string, anchors: MeetingTranscriptAnchor[]): string[] {
  const utterances = parseSource(String(text ?? ''));
  return anchors
    .filter((anchor) => resolveMeetingTranscriptAnchor(anchor, utterances) === null)
    .map((anchor) => anchor.utteranceId);
}

// ── id 派生（T034：确定性 ⇒ 幂等 upsert）────────────────────────────────

/**
 * 纪要条目 id：`mc_<sha1 前 12 位>`，输入 = `docId + 首锚点(blockIndex/from/to) +
 * 归一化摘要`（data-model §1.3 公式）。同输入同 id（幂等）；无锚点时锚点位为空串。
 */
export function meetingConclusionIdFor(
  docId: string,
  input: Pick<MeetingConclusionInput, 'summary' | 'transcriptRefs'>,
): string {
  const first = Array.isArray(input.transcriptRefs) && input.transcriptRefs.length
    ? input.transcriptRefs[0]
    : null;
  const anchorKey = first ? `${first.blockIndex}:${first.from}:${first.to}` : '';
  const digest = createHash('sha1')
    .update(`${docId}\n${anchorKey}\n${normalizeSummaryForId(input.summary ?? '')}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `mc_${digest}`;
}

// ── 读侧视图（T036：条目照常可读，旧数据如实降级）────────────────────────

const UNLINKABLE_REASONS = new Set<string>(['no_transcript_ref', 'anchor_not_found', 'legacy_record']);

/**
 * 存储记录 → 返回视图（只读，不回写）：
 * - 无 `transcriptRefs` 字段（旧数据/手造旧记录）⇒ `unlinkable:'legacy_record'`；
 * - 有字段但为空 ⇒ 存储值 ?? `'no_transcript_ref'`；
 * - 有锚点 ⇒ 保持存储值（正常记录无该键；save 存过的 anchor_not_found 原样带出）。
 */
function viewOfStored(raw: unknown, docId: string): MeetingConclusion {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Partial<MeetingConclusion>;
  const anchors = Array.isArray(record.transcriptRefs) ? record.transcriptRefs : null;
  const storedUnlinkable = typeof record.unlinkable === 'string' && UNLINKABLE_REASONS.has(record.unlinkable)
    ? (record.unlinkable as MeetingUnlinkableReason)
    : undefined;
  const transcriptRefs = anchors
    ? anchors.filter((a): a is MeetingTranscriptAnchor => !!a && typeof a === 'object')
    : [];
  let unlinkable = storedUnlinkable;
  if (anchors === null) unlinkable = 'legacy_record';
  else if (!transcriptRefs.length && !unlinkable) unlinkable = 'no_transcript_ref';
  return {
    id: typeof record.id === 'string' ? record.id : '',
    docId: typeof record.docId === 'string' ? record.docId : docId,
    summary: typeof record.summary === 'string' ? record.summary : '',
    transcriptRefs,
    assetRefs: Array.isArray(record.assetRefs)
      ? record.assetRefs.filter((r): r is MeetingConclusionAssetRef => !!r && typeof r === 'object')
      : [],
    status: record.status === 'confirmed' || record.status === 'precipitated' ? record.status : 'draft',
    ...(typeof record.candidateId === 'string' ? { candidateId: record.candidateId } : {}),
    ...(typeof record.precipitatedAt === 'string' ? { precipitatedAt: record.precipitatedAt } : {}),
    ...(unlinkable ? { unlinkable } : {}),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}

// ── 写口（T034/T035）────────────────────────────────────────────────────

/**
 * 保存/编辑一条纪要结论（幂等 upsert：同输入同 id ⇒ 覆盖既有条目，不新增）。
 *
 * - `summary` ≤240 非空，否则 `invalid_summary`；
 * - 锚点逐条校验（U 体系/整数偏移），形状不合法 ⇒ `invalid_anchor`（schema 错误
 *   该报就报；**解析不到**才走降级，两者不同）；
 * - `assetRefs` 快照**只从本文件引用包取**（同一份冻结）：不在包里的 assetId
 *   如实跳过——挂载（准入+冻结版）是 `attachMeetingAsset` 的职责，save 不越权；
 * - `options.text` 仅供锚点解析（只进不出）：全部锚点解析不到 ⇒
 *   `unlinkable:'anchor_not_found'`（部分解析到仍算可关联，不标）；
 * - upsert 保留 `createdAt`/`status`/`candidateId`（不隐式改状态机；编辑不回退确认）。
 */
export function saveMeetingConclusion(
  uid: string,
  docId: string,
  conclusion: MeetingConclusionInput,
  options: SaveMeetingConclusionOptions = {},
): MeetingConclusion {
  const id = requireDocId(docId);
  if (!conclusion || typeof conclusion !== 'object') {
    throw new MeetingConclusionError('meeting conclusion input must be an object', 'invalid_input');
  }
  const summary = requireSummary(conclusion.summary);
  const anchors = normalizeAnchors(conclusion.transcriptRefs);
  const assetIds = normalizeAssetIds(conclusion.assetRefs);

  let itemId = '';
  if (options.id !== undefined && options.id !== null) {
    if (typeof options.id !== 'string') {
      throw new MeetingConclusionError('meeting conclusion id must be a string', 'invalid_item_id');
    }
    itemId = options.id.trim();
    if (!itemId || itemId.length > MAX_CONCLUSION_ID_CHARS || !/^[A-Za-z0-9_-]+$/.test(itemId)) {
      throw new MeetingConclusionError('invalid meeting conclusion id', 'invalid_item_id');
    }
  } else {
    itemId = meetingConclusionIdFor(id, conclusion);
  }

  const body = readBody(uid, id)
    ?? ({ schemaVersion: MEETING_REF_SCHEMA_VERSION, docId: id, assetRefs: [], createdAt: nowIso(), updatedAt: nowIso() } as MeetingRefsFileBody);

  // T035：资产快照从本文件的引用包取（同一份冻结；不在包里的跳过，不造引用）。
  const assetRefs: MeetingConclusionAssetRef[] = [];
  for (const assetId of assetIds) {
    const frozen = body.assetRefs.find((ref) => ref && ref.assetId === assetId);
    if (!frozen) continue;
    assetRefs.push({
      assetId: frozen.assetId,
      version: String(frozen.version ?? ''),
      title: String(frozen.title ?? ''),
      type: frozen.type,
    });
  }

  // T036：锚点降级判定（text 只进不出；不传 = 不做解析判定，不编造结论）。
  let unlinkable: MeetingUnlinkableReason | undefined;
  if (!anchors.length) {
    unlinkable = 'no_transcript_ref';
  } else if (typeof options.text === 'string'
    && unresolvedMeetingAnchorIds(options.text, anchors).length === anchors.length) {
    unlinkable = 'anchor_not_found';
  }

  const at = nowIso();
  const conclusions = Array.isArray(body.conclusions) ? body.conclusions : [];
  const existingIndex = conclusions.findIndex((c) => c && c.id === itemId);
  const existing = existingIndex >= 0 ? conclusions[existingIndex] : undefined;
  const next: MeetingConclusion = {
    id: itemId,
    docId: id,
    summary,
    transcriptRefs: anchors,
    assetRefs,
    // upsert 保留既有状态与沉淀去向（编辑不该隐式改状态机；非法存量值按 draft 兜底）。
    status: existing && (existing.status === 'confirmed' || existing.status === 'precipitated') ? existing.status : 'draft',
    ...(existing?.candidateId ? { candidateId: existing.candidateId } : {}),
    ...(existing?.precipitatedAt ? { precipitatedAt: existing.precipitatedAt } : {}),
    ...(unlinkable ? { unlinkable } : {}),
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
  if (existingIndex >= 0) conclusions[existingIndex] = next;
  else conclusions.push(next);
  body.conclusions = conclusions;
  body.updatedAt = at;
  writeBody(uid, body);
  return next;
}

/** 该文档的纪要结论清单（只读；缺失 ⇒ 空数组；旧数据降级为不可关联，照常可读）。 */
export function listMeetingConclusions(uid: string, docId: string): MeetingConclusion[] {
  const id = requireDocId(docId);
  const body = readBody(uid, id);
  if (!body || !Array.isArray(body.conclusions)) return [];
  return body.conclusions.map((raw) => viewOfStored(raw, id));
}

/**
 * 确认一条纪要结论（`draft → confirmed`）。**不产生任何候选/资产副作用**——
 * 只改本记录状态（沉淀是 T045/T046 的 precipitate 通道的事，confirm 不碰）。
 * 已 confirmed/precipitated ⇒ 幂等返回原样（不报错、不再写盘）。
 */
export function confirmMeetingConclusion(uid: string, docId: string, conclusionId: string): MeetingConclusion {
  const id = requireDocId(docId);
  const itemId = typeof conclusionId === 'string' ? conclusionId.trim() : '';
  if (!itemId || itemId.length > MAX_CONCLUSION_ID_CHARS) {
    throw new MeetingConclusionError('invalid meeting conclusion id', 'invalid_item_id');
  }
  const body = readBody(uid, id);
  if (!body || !Array.isArray(body.conclusions)) {
    throw new MeetingConclusionError('meeting conclusion not found', 'item_not_found');
  }
  const index = body.conclusions.findIndex((c) => c && c.id === itemId);
  if (index < 0) {
    throw new MeetingConclusionError('meeting conclusion not found', 'item_not_found');
  }
  const current = body.conclusions[index];
  if (current.status === 'draft') {
    const at = nowIso();
    const next = { ...current, status: 'confirmed' as const, updatedAt: at };
    body.conclusions[index] = next;
    body.updatedAt = at;
    writeBody(uid, body);
    return viewOfStored(next, id);
  }
  return viewOfStored(current, id);
}

// ── T045/T046：沉淀为候选（组装 + 必过确认闸的写口）──────────────────────

/** 既有资产类型枚举（`AbilityAssetType`，candidate-service 单点维护；此处只镜像值域做校验）。 */
const PRECIPITATE_TYPES: ReadonlySet<string> = new Set(['personal', 'rule', 'template', 'skill_method', 'fact']);
/** 沉淀入参的文本上限（对齐 SaveRecallCandidateInput 的 judgment/value 上界）。 */
const MAX_PRECIPITATE_TEXT = 4_000;
/** suggestedScope 上限（对齐 candidate-service 的 boundedText(suggestedScope, 500)）。 */
const MAX_PRECIPITATE_SCOPE = 500;

/**
 * 沉淀入参（contracts/ipc.md §1.3 `.precipitate` 的 `input`）。
 *
 * **不含 tags/category**（012 边界）：这两个键一旦**收到**就 `field_not_available`
 * 拒绝（T048）——不静默丢弃、不映射 `assetType`/`familyName`。类型上保留
 * `unknown` 位只为让「收到了」可判定。
 */
export interface MeetingPrecipitateInput {
  /** 资产类型建议；缺省 `personal`；枚举外 ⇒ `unknown_scenario`。 */
  suggestedType?: string;
  /** 作用域建议；缺省 `personal`；须非空 ≤500。 */
  suggestedScope?: string;
  /** 判断陈述；缺省用结论摘要。 */
  judgment?: string;
  /** 「为什么以后有用」；缺省由 saveRecallCandidate 兜底为 judgment。 */
  value?: string;
  /** 规则类候选的适用/禁用边界（既有门槛，透传）。 */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  /** 012 边界：收到即拒（field_not_available）；见接口注释。 */
  tags?: unknown;
  category?: unknown;
}

/** 结论来源文档的元信息（sourceRefs 的 title/sourceVersion 取这里，不另起算）。 */
export interface ConclusionCandidateSource {
  docId: string;
  /** 展示标题（≤120）；缺省从 docId 派生文件名。 */
  title?: string;
  /** 文档版本信号（mtime 字符串化）；缺省不写该键（不编造版本）。 */
  sourceVersion?: string;
}

/**
 * 沉淀幂等键：`mtg-<sha1 前 16 位>`（data-model §1.6：`hash(docId + conclusionId)`）。
 * 同一 (docId, conclusionId) 恒同值 ⇒ saveRecallCandidate 的 captureKey 分支
 * 命中即返回既有，不重复建账；形态过 `safeId`（`mtg-` + 十六进制）。
 */
export function conclusionCaptureKey(docId: string, conclusionId: string): string {
  return `mtg-${createHash('sha1').update(`${docId}\n${conclusionId}`, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * 【T045】结论 → 候选的**确定性组装**（单一函数出口，零模型调用）。
 *
 * 产出 `SaveRecallCandidateInput`，字段填法照 data-model §1.6（不新增候选结构）：
 *   - `judgment`：overrides.judgment 优先，缺省结论摘要（≤240 ≤ 4000 ✓）；
 *   - `value`：**仅显式给值时才带键**（缺省交给 saveRecallCandidate 兜底为 judgment）；
 *   - `suggestedType`/`suggestedScope`：缺省 `personal`；
 *   - `suggestedAction`：显式 `'create'`——会议沉淀语义就是新建候选；且不显式给
 *     action 时，既有 `reviewReady` 的 `(hasExplicitAction || !hasExplicitValue)`
 *     会把「显式给了 value」的候选打落 weak_observation（入参形状导致的假阴性，
 *     不是证据弱），显式 create 让其余判据（value/sourceRefs/evidenceRefs/scope）
 *     原样生效——**不改 candidate-service 一行**；
 *   - `sourceRefs`：恰 1 条 `artifact_file/context_file`，id 用
 *     `cognitionContextFileSourceId(docId)`（source-catalog 单点同源，与来源目录
 *     的 id 逐字一致）；title 取文档展示名、sourceVersion 取 mtime 信号（缺省不写）；
 *   - `evidenceRefs`：每个段落锚点一条（同 id、`title` = 定位描述「文档 · 段落
 *     U0001」、`excerpt` = 结论摘要 ≤240）——**不含转写正文**（双引用纪律：
 *     正文永远在知识库，这里只有锚点定位 + 摘要）。无锚点 ⇒ 空数组 ⇒ 既有
 *     `reviewReady` 判 false ⇒ 候选落 `weak_observation`（**如实行为，不是缺陷**，
 *     T046 验收③；不给锚点硬造证据才是缺陷）；
 *   - `captureKey = conclusionCaptureKey(docId, conclusionId)`（幂等）；
 *   - **不传 `origin`**：由既有 `deriveCandidateOrigin` 依 captureKey 派生 `capture`；
 *   - `risk`/`spaceId`/`taskRunId`/`targetAssetId` 均不带（会议不是空间/任务/改进提案）。
 *
 * 打标钩子位（T048，012 边界——**预留，不实现**）：
 *   // [tags hook] 012 标签系统接管点：候选晋升为正式资产后，由资产管家
 *   // （update_ability_asset 的 fields.tags，旧 category 键收编为一条标签）打标。
 *   // 在 012 与会议沉淀线打通**之前**，precipitate 入口对 tags/category 一律
 *   // field_not_available 如实拒绝（见 precipitateMeetingConclusion），不映射
 *   // assetType/familyName、不静默丢弃；届时写标签的唯一入口就是本函数。
 */
export function buildConclusionCandidateInput(
  conclusion: MeetingConclusion,
  source: ConclusionCandidateSource,
  overrides: MeetingPrecipitateInput = {},
): SaveRecallCandidateInput {
  if (!conclusion || typeof conclusion !== 'object') {
    throw new MeetingConclusionError('meeting conclusion must be an object', 'invalid_input');
  }
  const docId = String(source?.docId || conclusion.docId || '').trim();
  if (!docId) {
    throw new MeetingConclusionError('conclusion candidate source missing docId', 'invalid_doc_id');
  }
  const judgment = String(overrides.judgment ?? '').trim() || String(conclusion.summary ?? '').trim();
  if (!judgment) {
    throw new MeetingConclusionError('meeting conclusion judgment empty', 'invalid_summary');
  }
  // 文档展示名：显式给优先；缺省取 docId 的文件名段（与 meeting_doc 的派生同思路）。
  const title = String(source?.title ?? '').trim()
    || docId.split(/[\\/]/).filter(Boolean).pop() || docId;
  const contextRef = {
    kind: 'artifact_file' as const,
    subtype: 'context_file' as const,
    scope: 'personal' as const,
    id: cognitionContextFileSourceId(docId),
    title,
    ...(String(source?.sourceVersion ?? '').trim() ? { sourceVersion: String(source.sourceVersion).trim() } : {}),
  };
  const anchors = Array.isArray(conclusion.transcriptRefs) ? conclusion.transcriptRefs : [];
  const evidenceRefs = anchors.map((anchor) => ({
    ...contextRef,
    // 定位描述（不存正文）：「哪份文档 · 哪一段」。excerpt = 结论摘要（≤240）。
    title: `${title} · ${anchor.utteranceId}`,
    excerpt: String(conclusion.summary ?? ''),
  }));
  return {
    judgment,
    ...(overrides.value !== undefined && String(overrides.value).trim() ? { value: String(overrides.value).trim() } : {}),
    suggestedType: (String(overrides.suggestedType ?? '').trim() || 'personal') as MeetingAssetType,
    suggestedScope: String(overrides.suggestedScope ?? '').trim() || 'personal',
    suggestedAction: 'create',
    sourceRefs: [contextRef],
    evidenceRefs,
    captureKey: conclusionCaptureKey(docId, conclusion.id),
    ...(Array.isArray(overrides.applicableWhen) ? { applicableWhen: overrides.applicableWhen } : {}),
    ...(Array.isArray(overrides.forbiddenWhen) ? { forbiddenWhen: overrides.forbiddenWhen } : {}),
    // [tags hook] 见函数注释的打标钩子位：012 落地前会议侧不写 tags/category。
  };
}

/**
 * 【T046】沉淀一条已确认的纪要结论为**候选**（必过确认闸；只到候选不到资产）。
 *
 * - `status === 'draft'` ⇒ `not_confirmed` 拒绝（沉淀必过用户确认，FR-006）；
 * - 已 `precipitated` ⇒ 走同一 captureKey 幂等路径（saveRecallCandidate 命中
 *   既有即返回），不重复建账；回填时保留首个 precipitatedAt；
 * - 组装收在 `buildConclusionCandidateInput`（单一出口）；写候选走**既有**
 *   `saveRecallCandidate`（reviewReady / assertNotForbiddenToPersist / promote
 *   门槛一行不改——无锚点落 weak_observation 是既有闸的如实行为）；
 * - 写失败（含敏感内容闸命中）⇒ `candidate_write_failed`，本记录不回填
 *   candidateId（不留「记了候选 id 但没真的建」的中间态，data-model §1.5）；
 * - 成功 ⇒ 回填 `candidateId` + `status:'precipitated'` + `precipitatedAt`。
 *
 * 【T048】tags/category（012 边界）：入参**收到**任一键（own property 且值非
 * undefined）⇒ `field_not_available` 拒绝。文案指向**已上线**的标签路径：候选
 * 晋升为正式资产后经资产管家打标（`update_ability_asset` 的 `fields.tags`；
 * 旧 `category` 键在资产管家侧已收编为一条标签，合并去重）——不是映射、不是
 * 静默丢弃，也不指向任何未上线的未来功能。
 */
export async function precipitateMeetingConclusion(
  uid: string,
  docId: string,
  conclusionId: string,
  input: MeetingPrecipitateInput = {},
): Promise<{ conclusion: MeetingConclusion; candidateId: string }> {
  const id = requireDocId(docId);
  const itemId = typeof conclusionId === 'string' ? conclusionId.trim() : '';
  if (!itemId || itemId.length > MAX_CONCLUSION_ID_CHARS) {
    throw new MeetingConclusionError('invalid meeting conclusion id', 'invalid_item_id');
  }
  // T048：tags/category 如实拒绝（先于其他校验——「不支持的键」比「值不合法」更早说清）。
  for (const field of ['tags', 'category'] as const) {
    if (input !== null && typeof input === 'object'
      && Object.prototype.hasOwnProperty.call(input, field)
      && (input as Record<string, unknown>)[field] !== undefined) {
      throw new MeetingConclusionError(
        `${field} is not available on meeting precipitation; tag the promoted asset via the asset steward (update_ability_asset fields.tags) instead`,
        'field_not_available',
      );
    }
  }
  if (input && typeof input === 'object') {
    if (input.suggestedType !== undefined && !PRECIPITATE_TYPES.has(String(input.suggestedType).trim())) {
      throw new MeetingConclusionError('unknown suggested type', 'unknown_scenario');
    }
    if (input.suggestedScope !== undefined) {
      const scope = String(input.suggestedScope).trim();
      if (!scope || scope.length > MAX_PRECIPITATE_SCOPE) {
        throw new MeetingConclusionError('invalid suggested scope', 'invalid_input');
      }
    }
    for (const field of ['judgment', 'value'] as const) {
      const text = (input as Record<string, unknown>)[field];
      if (text !== undefined && (typeof text !== 'string' || text.length > MAX_PRECIPITATE_TEXT)) {
        throw new MeetingConclusionError(`invalid precipitate ${field}`, 'invalid_input');
      }
    }
  }

  const body = readBody(uid, id);
  if (!body || !Array.isArray(body.conclusions)) {
    throw new MeetingConclusionError('meeting conclusion not found', 'item_not_found');
  }
  const index = body.conclusions.findIndex((c) => c && c.id === itemId);
  if (index < 0) {
    throw new MeetingConclusionError('meeting conclusion not found', 'item_not_found');
  }
  const stored = body.conclusions[index];
  if (stored.status !== 'confirmed' && stored.status !== 'precipitated') {
    // 必过确认闸：draft（或存量脏值）一律拒绝，不许绕过用户确认直进候选池。
    throw new MeetingConclusionError('meeting conclusion is not confirmed', 'not_confirmed');
  }

  // 来源文档元信息：读既有统一文档模型（只读探测，不惰性创建——沉淀不该顺手建文档）。
  const doc = getMeetingDoc(uid, id, { create: false });
  const candidateInput = buildConclusionCandidateInput(
    viewOfStored(stored, id),
    {
      docId: id,
      ...(doc?.title ? { title: doc.title } : {}),
      ...(doc?.sourceVersion ? { sourceVersion: doc.sourceVersion } : {}),
    },
    input,
  );

  let candidateId: string;
  try {
    const candidate = await saveRecallCandidate(uid, candidateInput);
    candidateId = candidate.id;
  } catch (error) {
    // 既有候选写失败（含 assertNotForbiddenToPersist 命中）：码化透传，不回填。
    log.warn('meeting conclusion precipitation failed', { conclusionId: itemId, error: (error as Error).message });
    throw new MeetingConclusionError((error as Error).message || 'recall candidate write failed', 'candidate_write_failed');
  }

  const at = nowIso();
  const next: MeetingConclusion = {
    ...stored,
    status: 'precipitated',
    candidateId,
    // 幂等重沉淀保留首个 precipitatedAt（时间戳只记第一次真正建账）。
    precipitatedAt: stored.precipitatedAt ?? at,
    updatedAt: at,
  };
  body.conclusions[index] = next;
  body.updatedAt = at;
  writeBody(uid, body);
  return { conclusion: viewOfStored(next, id), candidateId };
}
