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
 * 结论确认仅维护会议记录；不创建 Recall 候选。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../logger';
import { userMeetingRefsDir } from '../paths';
import { docKeyForDocId, MAX_DOC_ID_CHARS } from './meeting_doc';
import { MEETING_REF_SCHEMA_VERSION } from './meeting_refs';
import { emitMeetingStage } from './meeting_stage_events';
import type { MeetingAssetRef, MeetingAssetType } from './meeting_refs';
import { parseSource } from './transcript_clean_pipeline';

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
 */
export type MeetingConclusionErrorCode =
  | 'invalid_doc_id'
  | 'invalid_summary'
  | 'invalid_item_id'
  | 'invalid_input'
  | 'invalid_anchor'
  | 'item_not_found';

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
  /** 历史沉淀去向：保留旧候选 id 的读兼容，不再生成。 */
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
 * 只改本记录状态，不创建候选或资产。
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

    // 会议环节完成事件：纪要条目**首次**确认时广播一次，供会议产物沉淀消费
    // （specs/009-meeting-output-archive 契约 A4 / T018）。
    // 只在 draft → confirmed 这个真实跃迁上发；重复确认走下面的幂等返回，不发事件。
    // 位置纪律：writeBody 成功之后才发；emitMeetingStage 永不抛异常，不影响本函数契约。
    //
    // 内容边界（重要，别误解）：`transcriptRefs` 只携带**锚点**（utteranceId / blockIndex /
    // 句内偏移），本模块不保存转写正文切片。所以沉淀出去的是一份**可回查的条目摘要**，
    // 不是转写原文 —— 产出文本里显式标注这一点，避免读者把它当成完整纪要。
    emitMeetingStage({
      stage: 'conclusion_confirmed',
      uid,
      docKey: docKeyForDocId(id),
      docId: id,
      artifactKind: 'minutes',
      sourceText: renderConfirmedConclusionForKb(next),
      confirmed: true,
      // 每条结论一个版本段 → 各自独立成文件，不互相覆盖（FR-005）。
      version: next.id,
      at,
    });

    return viewOfStored(next, id);
  }
  return viewOfStored(current, id);
}

/**
 * 把一条**已确认**的纪要条目渲染成可沉淀的 Markdown。
 *
 * 单独成函数是为了让单测能直接断言产出文本，不必走事件链路。
 * 显式标注「条目摘要、非转写原文」是因为本模块只持有锚点、不持有正文 —— 标注是为了不误导读者。
 */
export function renderConfirmedConclusionForKb(c: MeetingConclusion): string {
  const lines: string[] = [
    `# 会议纪要条目（已确认）`,
    ``,
    `- 来源文档：\`${c.docId}\``,
    `- 条目 id：\`${c.id}\``,
    `- 确认时间：${c.updatedAt}`,
    `- 条目类型：会议结论条目摘要（**非转写原文**；正文请按下方锚点回查）`,
    ``,
    `## 摘要`,
    ``,
    c.summary || '（无摘要）',
    ``,
  ];

  lines.push(`## 转写回查锚点`, ``);
  if (Array.isArray(c.transcriptRefs) && c.transcriptRefs.length) {
    for (const ref of c.transcriptRefs) {
      lines.push(`- 段落 \`${ref.utteranceId}\`（第 ${ref.blockIndex} 段，偏移 ${ref.from}–${ref.to}）`);
    }
  } else {
    // 历史数据可能缺结构化引用；如实说明，不报错也不假装有。
    lines.push(`（本条无可关联的转写锚点${c.unlinkable ? `：${c.unlinkable}` : ''}）`);
  }
  lines.push(``);

  if (Array.isArray(c.assetRefs) && c.assetRefs.length) {
    lines.push(`## 关联资产（引用时的冻结版）`, ``);
    for (const a of c.assetRefs) {
      const version = typeof a.version === 'string' ? a.version : '';
      lines.push(`- \`${a.assetId}\`${version ? `（v${version}）` : ''}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}
