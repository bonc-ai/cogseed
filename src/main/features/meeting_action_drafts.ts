/**
 * meeting_action_drafts — 会议草稿待办 `MeetingActionDraft`（specs/013 · FR-005 / US-503 / T040~T042）
 *
 * 是什么：从会议转写里长出来的**行动项草稿**——"谁说的、哪一段、引用了什么资产"，
 * 默认 `draft` 态，由用户显式确认（→ `confirmed`）或丢弃（→ `discarded`）。
 *
 * 三条硬纪律（specs/013 data-model §1.4，全部由本模块保证）：
 *   1. **状态机封闭**：只允许 `draft→confirmed` / `draft→discarded`，其余迁移一律拒
 *      （`invalid_status_transition`）。确认后只允许写 `confirmedTarget` 一处，
 *      不重发、不改摘要、不追加引用。
 *   2. **未确认零外发**（SC-003）：`assertActionDraftSendable`（本模块导出）是
 *      **唯一**外发闸——非 `confirmed` 一律抛 `draft_not_confirmed`。任何落点/外发
 *      调用必须先过它；本模块内写 `confirmedTarget` 的位置只有
 *      `applyActionDraftTarget` 一处，且入口先过闸。
 *   3. **中断可续办**：只落盘，不做任何超时/会话结束的状态迁移——草稿保留在
 *      cloud 域的文件里，重启后仍是 `draft`（`confirmedTarget` 仍缺失）。
 *
 * 存储：`<uid>/cloud/cogseed/transcript/action-drafts/<docKey>.json`（一文档一文件；
 * `docKey` 派生复用 meeting_doc 的确定性函数——草稿要跨会话/设备续办 → cloud 域）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../logger';
import { userMeetingActionDraftsDir } from '../paths';
import { docKeyForDocId, MAX_DOC_ID_CHARS } from './meeting_doc';
import type { MeetingAssetRef } from './meeting_refs';

const log = createLogger('meeting-action-drafts');

export const MEETING_ACTION_DRAFT_SCHEMA_VERSION = 1;
/** 行动项摘要上限（data-model §1.4：≤240）。 */
export const MAX_ACTION_DRAFT_SUMMARY_CHARS = 240;
/** 说话人上限（对齐 meeting_doc 的 MAX_SPEAKER_CHARS）。 */
const MAX_OWNER_SPEAKER_CHARS = 60;
/** 单文档草稿数上限（防御性有界：脏输入不该让文件无限膨胀）。 */
export const MAX_ACTION_DRAFTS_PER_DOC = 200;
/** 单条草稿的锚点/引用上限（同上，防御性有界）。 */
const MAX_TRANSCRIPT_REFS = 50;
const MAX_ASSET_REFS = 20;

export type MeetingActionDraftStatus = 'draft' | 'confirmed' | 'discarded';
export type MeetingActionDraftTargetKind = 'local' | 'scheduled_task' | 'session_task';

/** 会议侧错误（失败码化：渲染层按 code 翻四语，不上屏英文原文）。 */
export type MeetingActionDraftErrorCode =
  | 'invalid_doc_id'          // schema
  | 'invalid_summary'         // schema
  | 'invalid_input'           // schema
  | 'draft_not_found'         // data
  | 'invalid_status_transition' // 状态机（T040②）
  | 'draft_not_confirmed'     // 外发闸（T041/SC-003）
  | 'target_already_set'      // 确认后落点只写一处（不重发）
  | 'draft_store_full';       // data

export class MeetingActionDraftError extends Error {
  constructor(message: string, readonly code: MeetingActionDraftErrorCode) {
    super(message);
    this.name = 'MeetingActionDraftError';
  }
}

/** 稳定段落锚点（沿用 SourceUtterance.id 体系；data-model §1.3 同形）。 */
export interface MeetingTranscriptAnchor {
  /** `U0001` 起的稳定段落 id（这是锚点，不随清理变化）。 */
  utteranceId: string;
  /** 文档里的段落序号（0 起）。 */
  blockIndex: number;
  /** 句内起止偏移（相对该段落文本）。 */
  from: number;
  to: number;
}

/** 谁说的：说话人 + 可选段落锚点（带来源，data-model §1.4）。 */
export interface MeetingActionDraftOwner {
  speaker: string;
  anchor?: MeetingTranscriptAnchor;
}

export interface MeetingActionDraft {
  /** `ma_<hash(docId + blockIndex + 归一化摘要)>`，确定性派生（T040）。 */
  id: string;
  docId: string;
  /** 行动项摘要（≤240）。**不是**转写正文切片。 */
  summary: string;
  owner?: MeetingActionDraftOwner;
  transcriptRefs: MeetingTranscriptAnchor[];
  assetRefs: Array<Pick<MeetingAssetRef, 'assetId' | 'version' | 'title' | 'type'>>;
  status: MeetingActionDraftStatus;
  confirmedAt?: string;
  /** 确认后的落点引用（v1 为本地状态；只经 `applyActionDraftTarget` 写入）。 */
  confirmedTarget?: { kind: MeetingActionDraftTargetKind; ref?: string };
  createdAt: string;
  updatedAt: string;
}

/** 一文档一文件的落盘形态（与 MeetingAssetPack 同模式）。 */
export interface MeetingActionDraftStore {
  schemaVersion: 1;
  docId: string;
  drafts: MeetingActionDraft[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveActionDraftInput {
  docId: string;
  summary: string;
  owner?: MeetingActionDraftOwner;
  transcriptRefs?: MeetingTranscriptAnchor[];
  assetRefs?: Array<Pick<MeetingAssetRef, 'assetId' | 'version' | 'title' | 'type'>>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function draftsFile(uid: string, docId: string): string {
  return path.join(userMeetingActionDraftsDir(uid), `${docKeyForDocId(docId)}.json`);
}

function requireDocId(docId: string): string {
  const id = typeof docId === 'string' ? docId.trim() : '';
  if (!id || id.length > MAX_DOC_ID_CHARS) {
    throw new MeetingActionDraftError('invalid meeting docId', 'invalid_doc_id');
  }
  return id;
}

function readStore(uid: string, docId: string): MeetingActionDraftStore | null {
  const file = draftsFile(uid, docId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MeetingActionDraftStore>;
    if (!raw || typeof raw !== 'object' || raw.docId !== docId) return null;
    if (raw.schemaVersion !== MEETING_ACTION_DRAFT_SCHEMA_VERSION) {
      // 记录版本不认识：如实报，不猜字段（与 meeting_doc/readPack 同口径）。
      log.warn('meeting action draft store unknown schema version; treated as missing', { schemaVersion: raw.schemaVersion });
      return null;
    }
    if (!Array.isArray(raw.drafts)) return null;
    return raw as MeetingActionDraftStore;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') log.warn('meeting action draft store unreadable; treated as missing', { code });
    return null;
  }
}

function writeStore(uid: string, store: MeetingActionDraftStore): void {
  const file = draftsFile(uid, store.docId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── T040：id 确定性派生 ───────────────────────────────────────────────────

/** 摘要归一化：压掉全部空白——"下周 排期" 与 "下周排期" 是同一条待办。 */
function normalizeSummary(summary: string): string {
  return String(summary ?? '').replace(/\s+/g, '').trim();
}

/**
 * `ma_<hash(docId + blockIndex + 归一化摘要)>`（data-model §1.4）：
 * 同一输入永远同一 id ⇒ 幂等；无锚点时 blockIndex 记 -1（同样确定）。
 */
export function actionDraftId(input: { docId: string; summary: string; blockIndex?: number }): string {
  const blockIndex = Number.isFinite(input.blockIndex)
    ? Math.max(0, Math.floor(input.blockIndex))
    : -1;
  const digest = createHash('sha256')
    .update(`${input.docId}\n${blockIndex}\n${normalizeSummary(input.summary)}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `ma_${digest}`;
}

// ── 输入收敛（有界 + 形状校验；脏输入在门口拒，不落盘） ────────────────────

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return Array.from(text).slice(0, max).join('');
}

function normalizeAnchors(value: unknown): MeetingTranscriptAnchor[] {
  if (!Array.isArray(value)) return [];
  const out: MeetingTranscriptAnchor[] = [];
  for (const raw of value.slice(0, MAX_TRANSCRIPT_REFS)) {
    const item = raw as Partial<MeetingTranscriptAnchor>;
    const utteranceId = boundedText(item?.utteranceId, 128);
    const blockIndex = Number(item?.blockIndex);
    const from = Number(item?.from);
    const to = Number(item?.to);
    if (!utteranceId) continue;
    if (!Number.isFinite(blockIndex) || blockIndex < 0) continue;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) continue;
    out.push({ utteranceId, blockIndex: Math.floor(blockIndex), from: Math.floor(from), to: Math.floor(to) });
  }
  return out;
}

const ASSET_TYPES: ReadonlySet<string> = new Set(['personal', 'rule', 'template', 'skill_method', 'fact']);

function normalizeAssetRefs(value: unknown): Array<Pick<MeetingAssetRef, 'assetId' | 'version' | 'title' | 'type'>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Pick<MeetingAssetRef, 'assetId' | 'version' | 'title' | 'type'>> = [];
  for (const raw of value.slice(0, MAX_ASSET_REFS)) {
    const item = raw as Partial<Pick<MeetingAssetRef, 'assetId' | 'version' | 'title' | 'type'>>;
    const assetId = boundedText(item?.assetId, 128);
    if (!assetId) continue;
    const type = typeof item?.type === 'string' && ASSET_TYPES.has(item.type)
      ? item.type as MeetingAssetRef['type']
      : undefined;
    if (!type) continue; // 引用类型不认识：不猜（冻结快照的 type 不允许编）
    out.push({
      assetId,
      version: String(item?.version ?? '1').slice(0, 64),
      title: boundedText(item?.title, 120) ?? '',
      type,
    });
  }
  return out;
}

function normalizeOwner(value: unknown): MeetingActionDraftOwner | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<MeetingActionDraftOwner>;
  const speaker = boundedText(item?.speaker, MAX_OWNER_SPEAKER_CHARS);
  if (!speaker) return undefined;
  const anchor = normalizeAnchors([item?.anchor]);
  return { speaker, ...(anchor.length ? { anchor: anchor[0] } : {}) };
}

// ── T040：save / list / confirm / discard ──────────────────────────────────

/**
 * 保存/更新一条草稿（默认 `draft` 态）。
 *
 * 幂等（T040③）：`id` 确定性派生 ⇒ 同输入永远命中同一条，**不新增**；
 * 内容也一致时不写盘（盘上零变化）。状态优先：
 *   - `draft` 态：允许刷新内容字段（摘要/来源/引用）——草稿就是给人改的；
 *   - `confirmed` 态：**不重发**——摘要/引用一概不动，原样返回（确认后的
 *     唯一可写字段是 `confirmedTarget`，且只经 `applyActionDraftTarget`）；
 *   - `discarded` 态：不复活——丢弃是用户的明确动作，同 id 再 save 只回现状。
 */
export function saveActionDraft(uid: string, input: SaveActionDraftInput): MeetingActionDraft {
  const docId = requireDocId(input?.docId);
  const summary = boundedText(input?.summary, MAX_ACTION_DRAFT_SUMMARY_CHARS);
  if (!summary) throw new MeetingActionDraftError('invalid meeting action summary', 'invalid_summary');
  const transcriptRefs = normalizeAnchors(input?.transcriptRefs);
  const assetRefs = normalizeAssetRefs(input?.assetRefs);
  const owner = normalizeOwner(input?.owner);
  const blockIndex = transcriptRefs[0]?.blockIndex ?? owner?.anchor?.blockIndex;
  const id = actionDraftId({ docId, summary, blockIndex });

  const store = readStore(uid, docId);
  const existing = store?.drafts.find((draft) => draft.id === id);
  if (existing) {
    if (existing.status === 'draft') {
      const next: MeetingActionDraft = {
        ...existing,
        summary,
        ...(owner ? { owner } : {}),
        transcriptRefs,
        assetRefs,
        updatedAt: nowIso(),
      };
      // 幂等的完整形态：内容没变就不落盘（updatedAt 也不动，盘上零变化）。
      const sameContent = next.summary === existing.summary
        && JSON.stringify(next.owner) === JSON.stringify(existing.owner)
        && JSON.stringify(next.transcriptRefs) === JSON.stringify(existing.transcriptRefs)
        && JSON.stringify(next.assetRefs) === JSON.stringify(existing.assetRefs);
      if (sameContent) return existing;
      const updated: MeetingActionDraftStore = {
        ...(store as MeetingActionDraftStore),
        drafts: (store as MeetingActionDraftStore).drafts.map((draft) => (draft.id === id ? next : draft)),
        updatedAt: nowIso(),
      };
      writeStore(uid, updated);
      return next;
    }
    // confirmed / discarded：不重发、不复活，原样返回（上方文件头纪律 1）。
    return existing;
  }

  if (store && store.drafts.length >= MAX_ACTION_DRAFTS_PER_DOC) {
    // 不静默挤掉旧草稿（那等于丢用户没处置过的待办）：如实拒绝。
    throw new MeetingActionDraftError('meeting action draft store is full', 'draft_store_full');
  }
  const at = nowIso();
  const draft: MeetingActionDraft = {
    id,
    docId,
    summary,
    ...(owner ? { owner } : {}),
    transcriptRefs,
    assetRefs,
    status: 'draft',
    createdAt: at,
    updatedAt: at,
  };
  const base = store ?? { schemaVersion: MEETING_ACTION_DRAFT_SCHEMA_VERSION, docId, drafts: [] as MeetingActionDraft[], createdAt: at, updatedAt: at };
  const created: MeetingActionDraftStore = { ...base, drafts: [...base.drafts, draft], updatedAt: at };
  writeStore(uid, created);
  return draft;
}

/** 该文档的草稿清单（只读；缺失 → 空数组。可按状态过滤）。 */
export function listActionDrafts(
  uid: string,
  docId: string,
  opts: { status?: MeetingActionDraftStatus } = {},
): MeetingActionDraft[] {
  const id = requireDocId(docId);
  const store = readStore(uid, id);
  if (!store) return [];
  const rows = opts?.status
    ? store.drafts.filter((draft) => draft.status === opts.status)
    : [...store.drafts];
  return rows.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function findDraft(store: MeetingActionDraftStore | null, draftId: string): MeetingActionDraft {
  const draft = store?.drafts.find((item) => item.id === draftId);
  if (!draft) throw new MeetingActionDraftError(`meeting action draft not found: ${draftId}`, 'draft_not_found');
  return draft;
}

function transition(
  uid: string,
  docId: string,
  draftId: string,
  to: 'confirmed' | 'discarded',
): MeetingActionDraft {
  const id = requireDocId(docId);
  const draftRef = typeof draftId === 'string' ? draftId.trim() : '';
  if (!draftRef) throw new MeetingActionDraftError('invalid meeting action draft id', 'invalid_input');
  const store = readStore(uid, id);
  const draft = findDraft(store, draftRef);
  // T040②：状态机封闭——只允许 draft→confirmed / draft→discarded，
  // 其余迁移（重复确认、丢弃已确认、复活已丢弃……）一律拒。
  if (draft.status !== 'draft') {
    throw new MeetingActionDraftError(
      `invalid status transition: ${draft.status} → ${to}`,
      'invalid_status_transition',
    );
  }
  const at = nowIso();
  const next: MeetingActionDraft = {
    ...draft,
    status: to,
    ...(to === 'confirmed' ? { confirmedAt: at } : {}),
    updatedAt: at,
  };
  const updated: MeetingActionDraftStore = {
    ...(store as MeetingActionDraftStore),
    drafts: (store as MeetingActionDraftStore).drafts.map((item) => (item.id === draftRef ? next : item)),
    updatedAt: at,
  };
  writeStore(uid, updated);
  return next;
}

/** 用户确认（`draft→confirmed`）：只改本记录状态 + `confirmedAt`，无任何外发。 */
export function confirmActionDraft(uid: string, docId: string, draftId: string): MeetingActionDraft {
  return transition(uid, docId, draftId, 'confirmed');
}

/** 用户丢弃（`draft→discarded`）：条目保留（状态章可见），移除是渲染层的显示取舍。 */
export function discardActionDraft(uid: string, docId: string, draftId: string): MeetingActionDraft {
  return transition(uid, docId, draftId, 'discarded');
}

// ── T041：外发闸唯一处（SC-003 的实现面） ─────────────────────────────────

/**
 * 外发闸（**唯一**）：`status !== 'confirmed'`（draft / discarded / 形状不对）
 * 一律抛 `draft_not_confirmed`。任何落点/外发调用必须先过它——本模块内
 * `confirmedTarget` 的写入点只有 `applyActionDraftTarget` 一处，且入口第一行
 * 就是本函数；模块外没有第二处（测试以源码扫描钉住这一不变量）。
 */
export function assertActionDraftSendable(draft: MeetingActionDraft | null | undefined): void {
  if (!draft || draft.status !== 'confirmed') {
    throw new MeetingActionDraftError(
      `action draft not confirmed: ${draft?.id ?? '(missing)'}`,
      'draft_not_confirmed',
    );
  }
}

/**
 * 确认后的落点写入（v1 为本地状态；落点形态见待总控确认 C-001）。
 * 这是 `confirmedTarget` 的**唯一**写入点：先过外发闸（T041），再写一处；
 * 同一落点重试幂等返回，不同落点拒绝改写（不重发，data-model §1.4）。
 */
export function applyActionDraftTarget(
  uid: string,
  docId: string,
  draftId: string,
  target: { kind: MeetingActionDraftTargetKind; ref?: string },
): MeetingActionDraft {
  const id = requireDocId(docId);
  const draftRef = typeof draftId === 'string' ? draftId.trim() : '';
  if (!draftRef) throw new MeetingActionDraftError('invalid meeting action draft id', 'invalid_input');
  const kind = target?.kind;
  if (kind !== 'local' && kind !== 'scheduled_task' && kind !== 'session_task') {
    throw new MeetingActionDraftError('invalid meeting action target kind', 'invalid_input');
  }
  const ref = boundedText(target?.ref, 500);

  const store = readStore(uid, id);
  const draft = findDraft(store, draftRef);
  // 外发闸：非 confirmed 一律拒（draft 态 ⇒ 抛错且无任何写入）。
  assertActionDraftSendable(draft);
  if (draft.confirmedTarget) {
    const same = draft.confirmedTarget.kind === kind && (draft.confirmedTarget.ref ?? '') === (ref ?? '');
    if (same) return draft;
    // 确认后的落点只写一处：换落点不是本闸放行的动作（要改先走新草稿）。
    throw new MeetingActionDraftError('meeting action draft target already set', 'target_already_set');
  }
  const at = nowIso();
  const next: MeetingActionDraft = {
    ...draft,
    confirmedTarget: { kind, ...(ref ? { ref } : {}) },
    updatedAt: at,
  };
  const updated: MeetingActionDraftStore = {
    ...(store as MeetingActionDraftStore),
    drafts: (store as MeetingActionDraftStore).drafts.map((item) => (item.id === draftRef ? next : item)),
    updatedAt: at,
  };
  writeStore(uid, updated);
  return next;
}
