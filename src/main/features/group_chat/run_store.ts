/**
 * 多 Agent 协作运行记录（PRD FR-016/017 的耐久载体）。
 *
 * 一次用户提交 = 一个 run：成员 / 点名 / 按来源配置在提交时冻结，actor 的派发与
 * 终态挂在它上面。文件落在会话的 group 目录 `runs/<runId>.json`，按目录扫描读取
 * （不做聚合索引，遵守 Data Domains 约定）。
 *
 * 本模块只负责「建的准、读得回、写得安全」；状态推进（终态、汇总）在 bus 的回合
 * 生命周期里调用 `updateRunActor` / `finalizeRun`。
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { conversationLayout } from '../../util/project-layout';
import { fileEditLock } from '../../util/locks';
import { createLogger } from '../../logger';
import {
  genId12, nowIso, readJson, writeJson, safeId,
} from '../../storage';
import { maskId } from '../../util/log-redact';

const log = createLogger('group_chat.run_store');

type RunRecordLock = ReturnType<typeof fileEditLock>;

// Vitest can reconstruct this module (and util/locks) while retaining callers
// from an earlier loader. Pin the first mutex created for each absolute run
// file on globalThis so every in-process loader serializes the same record.
const RUN_RECORD_LOCKS_KEY = Symbol.for('cogseed.group_chat.run_store.locks');
const runRecordLocks: Map<string, RunRecordLock> = ((globalThis as any)[RUN_RECORD_LOCKS_KEY] ??=
  new Map<string, RunRecordLock>());

function runRecordLock(file: string): RunRecordLock {
  let lock = runRecordLocks.get(file);
  if (!lock) {
    lock = fileEditLock(file);
    runRecordLocks.set(file, lock);
  }
  return lock;
}

export type RunActorTerminal =
  | 'pending'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'stopped'
  | 'removed';

export interface RunActorRecord {
  agent_id: string;
  /** 本 run 内派发给该 actor 的回合 id，按发生顺序。 */
  dispatched: string[];
  attempts: number;
  terminal: RunActorTerminal;
  /** Durable retry operation that exclusively owns this actor while pending. */
  retry_operation_id?: string;
  /** 终态原因（failure_kind / member_removed / sequential_not_established …）。 */
  reason?: string;
  /** 该 actor 在本 run 中真正落盘的产出；调用成功不等于有贡献。 */
  produced?: {
    messages: number;
    artifacts: string[];
  };
}

export interface RunSummary {
  contributed: Array<{ agent_id: string; messages: number; artifacts: string[] }>;
  missing: Array<{ agent_id: string; reason: string; terminal?: RunActorTerminal }>;
}

export interface RunSummaryPublication {
  status: 'pending' | 'published';
  /** Stable across retries so reconciliation can de-duplicate the JSONL append. */
  message_id: string;
  /** Identifies this exact finalization; changes when retry/stop reopens the run. */
  publication_id: string;
}

export type RunExecutionConfig = {
  provider?: string;
  model?: string;
  effort?: 'off' | 'low' | 'high';
};

export interface RunAttachmentDescriptor {
  /** Current attachment storage uses the conversation-relative filename as its stable id. */
  id: string;
  name: string;
  kind?: 'text' | 'pdf' | 'docx' | 'spreadsheet' | 'presentation' | 'image' | 'video' | 'audio';
  bytes?: number;
  mtime?: number;
}

export interface RunReferenceDescriptor {
  source_cid: string;
  source_title: string;
  source_msg_id: string;
  from_actor: string;
  from_name?: string;
  source_ts: string;
  text: string;
  attachments?: Array<{ name: string; kind?: string }>;
  produced?: string[];
}

export interface RunInputSnapshot {
  submitted_text: string;
  member_agent_ids: string[];
  mention_agent_ids: string[];
  mention_order: string[];
  external_agent_ids: string[];
  source_configs?: Record<string, RunExecutionConfig>;
  attachment_ids: string[];
  attachments: RunAttachmentDescriptor[];
  references: RunReferenceDescriptor[];
  requires_sequential: boolean;
}

export interface RunRecord {
  version: 1;
  run_id: string;
  cid: string;
  created_at: string;
  updated_at: string;
  /** Authoritative immutable submission snapshot. Runtime state must never rewrite it. */
  input_snapshot: RunInputSnapshot;
  /** 提交原文（含点名标记）——运行审计用，不参与 prompt 拼装。 */
  submitted_text: string;
  member_agent_ids: string[];
  mention_agent_ids: string[];
  /** 点名在正文出现的顺序：顺序依赖的方向依据（设计 §4.4）。 */
  mention_order: string[];
  /** 外接实例（cli / p3394-gateway）：不可见其他成员，配置各自独立。 */
  external_agent_ids: string[];
  source_configs?: Record<string, RunExecutionConfig>;
  /** 顺序意图（确定性检测）：本条是否必须形成依赖链。 */
  requires_sequential: boolean;
  /** 已发生的纠正轮数（上限 1，设计 §4.4）。 */
  corrections: number;
  actors: RunActorRecord[];
  status: 'running' | 'completed' | 'failed' | 'blocked' | 'stopped';
  summary?: RunSummary;
  summary_publication?: RunSummaryPublication;
}

export interface CreateRunInput {
  uid: string;
  cid: string;
  runId?: string;
  submittedText: string;
  memberAgentIds: string[];
  mentionAgentIds: string[];
  externalAgentIds?: string[];
  sourceConfigs?: Record<string, RunExecutionConfig>;
  attachmentIds?: string[];
  attachmentDescriptors?: RunAttachmentDescriptor[];
  references?: RunReferenceDescriptor[];
  requiresSequential?: boolean;
  projectHint?: string | null;
}

export function runIdOf(): string {
  return `run_${genId12()}`;
}

export function runSummaryMessageId(runId: string): string {
  if (!safeId(runId)) throw new Error('invalid run id');
  return `run-summary-${runId}`;
}

function legacyRunSummaryPublicationId(runId: string): string {
  return `legacy-${runId}`;
}

export function runsDirOf(uid: string, cid: string, projectHint?: string | null): string {
  return path.join(conversationLayout(uid, cid, projectHint).groupDir, 'runs');
}

export function runFileOf(
  uid: string,
  cid: string,
  runId: string,
  projectHint?: string | null,
): string {
  if (!safeId(runId)) throw new Error('invalid run id');
  return path.join(runsDirOf(uid, cid, projectHint), `${runId}.json`);
}

/** 规范化：去重、剔除保留 id（协调者/用户不是 agent 成员）、保持输入顺序。 */
function normalizeIds(ids: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (typeof raw !== 'string' || !safeId(raw)) continue;
    if (raw === 'commander' || raw === 'user' || raw === 'cogseed') continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

const RUN_TERMINALS = new Set<RunActorTerminal>([
  'pending', 'done', 'failed', 'blocked', 'stopped', 'removed',
]);
const RUN_STATUSES = new Set<RunRecord['status']>([
  'running', 'completed', 'failed', 'blocked', 'stopped',
]);
const ATTACHMENT_KINDS = new Set<NonNullable<RunAttachmentDescriptor['kind']>>([
  'text', 'pdf', 'docx', 'spreadsheet', 'presentation', 'image', 'video', 'audio',
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validAttachmentLocator(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

function decodeIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !safeId(id)) return null;
    if (id === 'commander' || id === 'user' || id === 'cogseed') return null;
    if (out.includes(id)) return null;
    out.push(id);
  }
  return out;
}

function decodeNonEmptyStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || out.includes(item)) return null;
    out.push(item);
  }
  return out;
}

function decodeSourceConfigs(value: unknown): Record<string, RunExecutionConfig> | null {
  if (!plainObject(value)) return null;
  const out: Record<string, RunExecutionConfig> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key !== 'internal' && !safeId(key)) return null;
    if (!plainObject(raw)) return null;
    const provider = raw.provider;
    const model = raw.model;
    const effort = raw.effort;
    if (provider !== undefined && (typeof provider !== 'string' || !provider.trim())) return null;
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) return null;
    if (effort !== undefined && effort !== 'off' && effort !== 'low' && effort !== 'high') return null;
    if (model === undefined && effort === undefined) return null;
    out[key] = {
      ...(typeof provider === 'string' ? { provider } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(effort === 'off' || effort === 'low' || effort === 'high' ? { effort } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

function decodeAttachment(value: unknown): RunAttachmentDescriptor | null {
  if (!plainObject(value) || !validAttachmentLocator(value.id) || !validAttachmentLocator(value.name)) return null;
  if (value.kind !== undefined && !ATTACHMENT_KINDS.has(value.kind as RunAttachmentDescriptor['kind'])) return null;
  if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0)) return null;
  if (value.mtime !== undefined && (!Number.isSafeInteger(value.mtime) || Number(value.mtime) < 0)) return null;
  return {
    id: value.id,
    name: value.name,
    ...(value.kind ? { kind: value.kind as RunAttachmentDescriptor['kind'] } : {}),
    ...(value.bytes !== undefined ? { bytes: Number(value.bytes) } : {}),
    ...(value.mtime !== undefined ? { mtime: Number(value.mtime) } : {}),
  };
}

function decodeReference(value: unknown): RunReferenceDescriptor | null {
  if (!plainObject(value)
    || !safeId(value.source_cid)
    || !safeId(value.source_msg_id)
    || !safeId(value.from_actor)
    || typeof value.source_title !== 'string'
    || !validIso(value.source_ts)
    || typeof value.text !== 'string') return null;
  if (value.from_name !== undefined && typeof value.from_name !== 'string') return null;
  let attachments: RunReferenceDescriptor['attachments'];
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) return null;
    attachments = [];
    for (const raw of value.attachments) {
      if (!plainObject(raw) || !validAttachmentLocator(raw.name)) return null;
      if (raw.kind !== undefined && !ATTACHMENT_KINDS.has(raw.kind as RunAttachmentDescriptor['kind'])) return null;
      attachments.push({
        name: raw.name,
        ...(raw.kind ? { kind: raw.kind as RunAttachmentDescriptor['kind'] } : {}),
      });
    }
  }
  let produced: string[] | undefined;
  if (value.produced !== undefined) {
    const decoded = decodeNonEmptyStrings(value.produced);
    if (!decoded) return null;
    produced = decoded;
  }
  return {
    source_cid: value.source_cid as string,
    source_title: value.source_title,
    source_msg_id: value.source_msg_id as string,
    from_actor: value.from_actor as string,
    ...(typeof value.from_name === 'string' ? { from_name: value.from_name } : {}),
    source_ts: value.source_ts,
    text: value.text,
    ...(attachments?.length ? { attachments } : {}),
    ...(produced?.length ? { produced } : {}),
  };
}

function decodeInputSnapshot(value: unknown): RunInputSnapshot | null {
  if (!plainObject(value) || typeof value.submitted_text !== 'string' || typeof value.requires_sequential !== 'boolean') return null;
  const memberIds = decodeIds(value.member_agent_ids);
  const mentionIds = decodeIds(value.mention_agent_ids);
  const mentionOrder = decodeIds(value.mention_order);
  const externalIds = decodeIds(value.external_agent_ids);
  if (!memberIds || !mentionIds || !mentionOrder || !externalIds) return null;
  if (mentionOrder.some((id) => !mentionIds.includes(id))) return null;
  let sourceConfigs: Record<string, RunExecutionConfig> | undefined;
  if (value.source_configs !== undefined) {
    const decoded = decodeSourceConfigs(value.source_configs);
    if (!decoded) return null;
    sourceConfigs = decoded;
  }
  if (!Array.isArray(value.attachment_ids) || !Array.isArray(value.attachments) || !Array.isArray(value.references)) return null;
  const attachmentIds: string[] = [];
  for (const id of value.attachment_ids) {
    if (!validAttachmentLocator(id) || attachmentIds.includes(id)) return null;
    attachmentIds.push(id);
  }
  const attachments: RunAttachmentDescriptor[] = [];
  for (const raw of value.attachments) {
    const decoded = decodeAttachment(raw);
    if (!decoded || attachments.some((item) => item.id === decoded.id)) return null;
    attachments.push(decoded);
  }
  if (attachmentIds.some((id) => !attachments.some((item) => item.id === id))) return null;
  const references: RunReferenceDescriptor[] = [];
  for (const raw of value.references) {
    const decoded = decodeReference(raw);
    if (!decoded) return null;
    references.push(decoded);
  }
  return {
    submitted_text: value.submitted_text,
    member_agent_ids: memberIds,
    mention_agent_ids: mentionIds,
    mention_order: mentionOrder,
    external_agent_ids: externalIds,
    ...(sourceConfigs ? { source_configs: sourceConfigs } : {}),
    attachment_ids: attachmentIds,
    attachments,
    references,
    requires_sequential: value.requires_sequential,
  };
}

function decodeActor(value: unknown): RunActorRecord | null {
  if (!plainObject(value) || !safeId(value.agent_id)) return null;
  const dispatched = decodeIds(value.dispatched);
  if (!dispatched || !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0 || !RUN_TERMINALS.has(value.terminal as RunActorTerminal)) return null;
  if (value.reason !== undefined && typeof value.reason !== 'string') return null;
  if (value.retry_operation_id !== undefined || value.terminal === 'pending') {
    if (value.retry_operation_id !== undefined && !safeId(value.retry_operation_id)) return null;
    if (value.retry_operation_id !== undefined && value.terminal !== 'pending') return null;
  }
  let produced: RunActorRecord['produced'];
  if (value.produced !== undefined) {
    if (!plainObject(value.produced)
      || !Number.isSafeInteger(value.produced.messages)
      || Number(value.produced.messages) < 0) return null;
    const artifacts = decodeNonEmptyStrings(value.produced.artifacts);
    if (!artifacts) return null;
    produced = { messages: Number(value.produced.messages), artifacts };
  }
  return {
    agent_id: value.agent_id as string,
    dispatched,
    attempts: Number(value.attempts),
    terminal: value.terminal as RunActorTerminal,
    ...(typeof value.retry_operation_id === 'string'
      ? { retry_operation_id: value.retry_operation_id }
      : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(produced ? { produced } : {}),
  };
}

function normalizeRecord(raw: unknown, expected?: { cid: string; runId: string }): RunRecord | null {
  if (!plainObject(raw) || raw.version !== 1 || !safeId(raw.run_id) || !safeId(raw.cid)) return null;
  if (expected && (raw.cid !== expected.cid || raw.run_id !== expected.runId)) return null;
  if (!validIso(raw.created_at) || !validIso(raw.updated_at)) return null;
  const inputSnapshot = decodeInputSnapshot(raw.input_snapshot);
  if (!inputSnapshot) return null;
  if (raw.submitted_text !== inputSnapshot.submitted_text
    || JSON.stringify(raw.member_agent_ids) !== JSON.stringify(inputSnapshot.member_agent_ids)
    || JSON.stringify(raw.mention_agent_ids) !== JSON.stringify(inputSnapshot.mention_agent_ids)
    || JSON.stringify(raw.mention_order) !== JSON.stringify(inputSnapshot.mention_order)
    || JSON.stringify(raw.external_agent_ids) !== JSON.stringify(inputSnapshot.external_agent_ids)
    || JSON.stringify(raw.source_configs) !== JSON.stringify(inputSnapshot.source_configs)
    || raw.requires_sequential !== inputSnapshot.requires_sequential) return null;
  if (!Number.isSafeInteger(raw.corrections) || Number(raw.corrections) < 0) return null;
  if (!Array.isArray(raw.actors) || !RUN_STATUSES.has(raw.status as RunRecord['status'])) return null;
  const actors: RunActorRecord[] = [];
  for (const value of raw.actors) {
    const actor = decodeActor(value);
    if (!actor || actors.some((item) => item.agent_id === actor.agent_id)) return null;
    actors.push(actor);
  }
  let summary: RunSummary | undefined;
  if (raw.summary !== undefined) {
    const decoded = normalizeSummary(raw.summary);
    if (!decoded) return null;
    summary = decoded;
  }
  let summaryPublication: RunSummaryPublication | undefined;
  if (raw.summary_publication !== undefined) {
    if (!summary || !plainObject(raw.summary_publication)) return null;
    const publicationStatus = raw.summary_publication.status;
    const messageId = raw.summary_publication.message_id;
    const rawPublicationId = raw.summary_publication.publication_id;
    const publicationId = rawPublicationId === undefined
      ? legacyRunSummaryPublicationId(raw.run_id as string)
      : rawPublicationId;
    if ((publicationStatus !== 'pending' && publicationStatus !== 'published')
      || messageId !== runSummaryMessageId(raw.run_id as string)
      || !safeId(publicationId)) return null;
    summaryPublication = {
      status: publicationStatus,
      message_id: messageId,
      publication_id: publicationId as string,
    };
  }
  return {
    version: 1,
    run_id: raw.run_id as string,
    cid: raw.cid as string,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    input_snapshot: inputSnapshot,
    submitted_text: inputSnapshot.submitted_text,
    member_agent_ids: inputSnapshot.member_agent_ids,
    mention_agent_ids: inputSnapshot.mention_agent_ids,
    mention_order: inputSnapshot.mention_order,
    external_agent_ids: inputSnapshot.external_agent_ids,
    ...(inputSnapshot.source_configs ? { source_configs: inputSnapshot.source_configs } : {}),
    requires_sequential: inputSnapshot.requires_sequential,
    corrections: Number(raw.corrections),
    actors,
    status: raw.status as RunRecord['status'],
    ...(summary ? { summary } : {}),
    ...(summaryPublication ? { summary_publication: summaryPublication } : {}),
  };
}

function normalizeArtifactIds(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function normalizeSummary(value: unknown): RunSummary | null {
  if (!plainObject(value) || !Array.isArray(value.contributed) || !Array.isArray(value.missing)) return null;
  const contributed: RunSummary['contributed'] = [];
  for (const item of value.contributed) {
    if (!plainObject(item) || !safeId(item.agent_id)
      || !Number.isSafeInteger(item.messages) || Number(item.messages) < 0) return null;
    const artifacts = decodeNonEmptyStrings(item.artifacts);
    if (!artifacts) return null;
    contributed.push({ agent_id: item.agent_id as string, messages: Number(item.messages), artifacts });
  }
  const missing: RunSummary['missing'] = [];
  for (const item of value.missing) {
    if (!plainObject(item) || !safeId(item.agent_id) || typeof item.reason !== 'string' || !item.reason) return null;
    if (item.terminal !== undefined && !RUN_TERMINALS.has(item.terminal as RunActorTerminal)) return null;
    missing.push({
      agent_id: item.agent_id as string,
      reason: item.reason,
      ...(item.terminal !== undefined ? { terminal: item.terminal as RunActorTerminal } : {}),
    });
  }
  return { contributed, missing };
}

/** 提交被接受时建立 run；成员/点名/配置在这里冻结（FR-014/016）。 */
export async function createRun(input: CreateRunInput): Promise<RunRecord | null> {
  if (!safeId(input.uid) || !safeId(input.cid)) return null;
  const memberAgentIds = normalizeIds(input.memberAgentIds);
  const mentionAgentIds = normalizeIds(input.mentionAgentIds);
  const externalAgentIds = normalizeIds(input.externalAgentIds);
  const attachmentIds = Array.from(new Set(
    (input.attachmentIds || []).filter(validAttachmentLocator),
  ));
  const attachmentDescriptors: RunAttachmentDescriptor[] = [];
  for (const raw of input.attachmentDescriptors || []) {
    const decoded = decodeAttachment(raw);
    if (!decoded || attachmentDescriptors.some((item) => item.id === decoded.id)) return null;
    attachmentDescriptors.push(decoded);
  }
  for (const id of attachmentIds) {
    if (!attachmentDescriptors.some((item) => item.id === id)) {
      attachmentDescriptors.push({ id, name: id });
    }
  }
  const references: RunReferenceDescriptor[] = [];
  for (const raw of input.references || []) {
    const decoded = decodeReference(raw);
    if (!decoded) return null;
    references.push(decoded);
  }
  let sourceConfigs: Record<string, RunExecutionConfig> | undefined;
  if (input.sourceConfigs) {
    const decoded = decodeSourceConfigs(input.sourceConfigs);
    if (!decoded) return null;
    sourceConfigs = decoded;
  }
  const runId = input.runId || runIdOf();
  if (!safeId(runId)) return null;
  const now = nowIso();
  const actors: RunActorRecord[] = [];
  // 派发对象先按「点名」登记；无点名时成员就是候选范围，实际派发由 bus 决定。
  for (const id of (mentionAgentIds.length ? mentionAgentIds : [])) {
    actors.push({ agent_id: id, dispatched: [], attempts: 0, terminal: 'pending' });
  }
  const inputSnapshot: RunInputSnapshot = {
    submitted_text: String(input.submittedText || ''),
    member_agent_ids: memberAgentIds,
    mention_agent_ids: mentionAgentIds,
    mention_order: mentionAgentIds.length ? mentionAgentIds : [],
    external_agent_ids: externalAgentIds,
    ...(sourceConfigs ? { source_configs: sourceConfigs } : {}),
    attachment_ids: attachmentIds,
    attachments: attachmentDescriptors,
    references,
    requires_sequential: input.requiresSequential === true,
  };
  const record: RunRecord = {
    version: 1,
    run_id: runId,
    cid: input.cid,
    created_at: now,
    updated_at: now,
    input_snapshot: inputSnapshot,
    submitted_text: inputSnapshot.submitted_text,
    member_agent_ids: inputSnapshot.member_agent_ids,
    mention_agent_ids: inputSnapshot.mention_agent_ids,
    mention_order: inputSnapshot.mention_order,
    external_agent_ids: inputSnapshot.external_agent_ids,
    ...(inputSnapshot.source_configs ? { source_configs: inputSnapshot.source_configs } : {}),
    requires_sequential: inputSnapshot.requires_sequential,
    corrections: 0,
    actors,
    status: 'running',
  };
  const file = runFileOf(input.uid, input.cid, runId, input.projectHint);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await runRecordLock(file).runExclusive(async () => writeJson(file, record));
  } catch (err) {
    // run 记录是审计与协作范围的载体，但写失败不能阻断用户提交本身。
    log.warn(`create run failed cid=${maskId(input.cid)}: ${(err as Error).message}`);
    return null;
  }
  log.info('run created', {
    cid: maskId(input.cid),
    run_id: maskId(runId),
    members: memberAgentIds.length,
    mentions: mentionAgentIds.length,
    external: externalAgentIds.length,
    sequential: record.input_snapshot.requires_sequential,
  });
  return record;
}

export async function readRun(
  uid: string,
  cid: string,
  runId: string,
  projectHint?: string | null,
): Promise<RunRecord | null> {
  if (!safeId(uid) || !safeId(cid) || !safeId(runId)) return null;
  try {
    const raw = await readJson(runFileOf(uid, cid, runId, projectHint));
    return normalizeRecord(raw, { cid, runId });
  } catch {
    return null;
  }
}

/** 只读最近一次运行的 id（历史回读/调试用，不做聚合索引）。 */
export async function listRunIds(
  uid: string,
  cid: string,
  projectHint?: string | null,
): Promise<string[]> {
  try {
    const dir = runsDirOf(uid, cid, projectHint);
    const entries = await fsp.readdir(dir);
    return entries
      .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/** 读改写一个 run：并发安全（同一 run 的回合终态可能同时到达）。 */
export async function updateRun(
  uid: string,
  cid: string,
  runId: string,
  mutate: (record: RunRecord) => RunRecord | null,
  projectHint?: string | null,
): Promise<RunRecord | null> {
  if (!safeId(uid) || !safeId(cid) || !safeId(runId)) return null;
  const file = runFileOf(uid, cid, runId, projectHint);
  try {
    return await runRecordLock(file).runExclusive(async () => {
      const current = normalizeRecord(await readJson(file), { cid, runId });
      if (!current) return null;
      const frozenInput = JSON.stringify(current.input_snapshot);
      const next = mutate(current);
      if (!next) return current;
      if (JSON.stringify(next.input_snapshot) !== frozenInput) {
        throw new Error('run input snapshot is immutable');
      }
      next.updated_at = nowIso();
      const decoded = normalizeRecord(next, { cid, runId });
      if (!decoded) throw new Error('invalid run record mutation');
      await writeJson(file, decoded);
      return decoded;
    });
  } catch (err) {
    log.warn(`update run failed run=${maskId(runId)}: ${(err as Error).message}`);
    return null;
  }
}

/** 记录一次派发：actor 不存在则补建（协调者也可能被点名派发）。 */
export async function recordRunDispatch(
  uid: string,
  cid: string,
  runId: string,
  agentId: string,
  turnId: string,
  projectHint?: string | null,
): Promise<RunRecord | null> {
  if (!safeId(agentId) || !turnId) return null;
  return updateRun(uid, cid, runId, (record) => {
    let actor = record.actors.find((a) => a.agent_id === agentId);
    // Stop/removal is a durable dispatch guard, not merely a UI state. A
    // delayed Wake approval or post-turn callback may arrive after abort;
    // recording that late dispatch would make the stopped actor look revived
    // and undermine restart recovery. Only prepareRunRetry may reopen it.
    if (record.status !== 'running' || (actor && actor.terminal !== 'pending')) return record;
    if (!actor) {
      actor = { agent_id: agentId, dispatched: [], attempts: 0, terminal: 'pending' };
      record.actors.push(actor);
    }
    if (!actor.dispatched.includes(turnId)) {
      actor.dispatched.push(turnId);
      actor.attempts += 1;
    }
    return record;
  }, projectHint);
}

export interface RecordRunActorTerminalInput {
  terminal: Exclude<RunActorTerminal, 'pending'>;
  reason?: string;
  messages?: number;
  artifacts?: string[];
}

/** 记录 actor 的权威终态与实际产出。已停止的 actor 不会被迟到回调覆盖。 */
export async function recordRunActorTerminal(
  uid: string,
  cid: string,
  runId: string,
  agentId: string,
  input: RecordRunActorTerminalInput,
  projectHint?: string | null,
): Promise<RunRecord | null> {
  if (!safeId(agentId)) return null;
  return updateRun(uid, cid, runId, (record) => {
    let actor = record.actors.find((candidate) => candidate.agent_id === agentId);
    if (!actor) {
      actor = { agent_id: agentId, dispatched: [], attempts: 0, terminal: 'pending' };
      record.actors.push(actor);
    }
    if (actor.terminal === 'stopped' || actor.terminal === 'removed') return record;
    if (actor.terminal === 'done' && input.terminal !== 'done') return record;
    const previousProduced = actor.terminal === 'done' && input.terminal === 'done'
      ? actor.produced
      : undefined;
    actor.terminal = input.terminal;
    delete actor.retry_operation_id;
    if (input.reason) actor.reason = String(input.reason);
    else delete actor.reason;
    actor.produced = {
      messages: (previousProduced?.messages || 0)
        + Math.max(0, Number.isFinite(input.messages) ? Number(input.messages) : 0),
      artifacts: normalizeArtifactIds([
        ...(previousProduced?.artifacts || []),
        ...(input.artifacts || []),
      ]),
    };
    return record;
  }, projectHint);
}

/** 按真实终态收口 run，生成可持久化的贡献/缺失清单。 */
export async function finalizeRun(
  uid: string,
  cid: string,
  runId: string,
  projectHint?: string | null,
): Promise<RunRecord | null> {
  return updateRun(uid, cid, runId, (record) => {
    const authoritativeStatus = record.status === 'running' ? null : record.status;
    const contributed: RunSummary['contributed'] = [];
    const missing: RunSummary['missing'] = [];
    for (const actor of record.actors) {
      const produced = actor.produced || { messages: 0, artifacts: [] };
      if (
        actor.terminal === 'done'
        && (produced.messages > 0 || produced.artifacts.length > 0)
      ) {
        contributed.push({
          agent_id: actor.agent_id,
          messages: produced.messages,
          artifacts: produced.artifacts.slice(),
        });
        continue;
      }
      if (actor.terminal === 'done') {
        missing.push({ agent_id: actor.agent_id, reason: 'no_contribution' });
        continue;
      }
      if (actor.terminal === 'pending') {
        missing.push({ agent_id: actor.agent_id, reason: 'no_terminal' });
        continue;
      }
      missing.push({
        agent_id: actor.agent_id,
        reason: actor.reason || actor.terminal,
      });
    }
    record.summary = { contributed, missing };
    if (authoritativeStatus) {
      record.status = authoritativeStatus;
    } else if (record.actors.length > 0 && missing.length === 0) {
      record.status = 'completed';
    } else if (record.actors.some((actor) => actor.terminal === 'blocked')) {
      record.status = 'blocked';
    } else if (
      record.actors.length > 0
      && record.actors.every((actor) => (
        actor.terminal === 'done'
        || actor.terminal === 'stopped'
        || actor.terminal === 'removed'
      ))
      && record.actors.some((actor) => actor.terminal === 'stopped' || actor.terminal === 'removed')
    ) {
      record.status = 'stopped';
    } else {
      record.status = 'failed';
    }
    if (!record.summary_publication) {
      record.summary_publication = {
        status: 'pending',
        message_id: runSummaryMessageId(record.run_id),
        publication_id: genId12(),
      };
    }
    return record;
  }, projectHint);
}

/**
 * Publish one exact outbox generation while holding the run lock. Stop/retry
 * mutations therefore happen wholly before or wholly after the durable JSONL
 * write, never between snapshot validation and publication acknowledgement.
 */
export async function publishPendingRunSummary(
  uid: string,
  cid: string,
  runId: string,
  publicationId: string,
  publish: (record: RunRecord) => Promise<void>,
  projectHint?: string | null,
): Promise<RunRecord | null> {
  if (!safeId(uid) || !safeId(cid) || !safeId(runId) || !safeId(publicationId)) return null;
  const file = runFileOf(uid, cid, runId, projectHint);
  try {
    return await runRecordLock(file).runExclusive(async () => {
      const current = normalizeRecord(await readJson(file), { cid, runId });
      const publication = current?.summary_publication;
      if (!current
        || !current.summary
        || current.status === 'running'
        || !publication
        || publication.status !== 'pending'
        || publication.publication_id !== publicationId) return current;

      await publish(structuredClone(current));
      publication.status = 'published';
      current.updated_at = nowIso();
      const decoded = normalizeRecord(current, { cid, runId });
      if (!decoded) throw new Error('invalid published run record');
      await writeJson(file, decoded);
      return decoded;
    });
  } catch (err) {
    log.warn(`publish run summary failed run=${maskId(runId)}: ${(err as Error).message}`);
    return null;
  }
}

export interface StopRunInput {
  agentIds?: string[];
  reason?: string;
  terminal?: 'stopped' | 'removed';
}

/** 停止整个 run 或其中指定 actor；已完成的贡献永不回滚。 */
export async function stopRun(
  uid: string,
  cid: string,
  runId: string,
  input: StopRunInput = {},
  projectHint?: string | null,
): Promise<RunRecord | null> {
  const scopedIds = normalizeIds(input.agentIds);
  const fullRun = scopedIds.length === 0;
  const terminal = input.terminal || 'stopped';
  const reason = input.reason || (terminal === 'removed' ? 'member_removed' : 'user_stopped');
  return updateRun(uid, cid, runId, (record) => {
    const targets = new Set(scopedIds);
    if (fullRun) record.status = 'stopped';
    else {
      for (const agentId of scopedIds) {
        if (record.actors.some((actor) => actor.agent_id === agentId)) continue;
        record.actors.push({
          agent_id: agentId,
          dispatched: [],
          attempts: 0,
          terminal,
          reason,
        });
      }
    }
    for (const actor of record.actors) {
      if (!fullRun && !targets.has(actor.agent_id)) continue;
      if (actor.terminal === 'done') continue;
      actor.terminal = terminal;
      delete actor.retry_operation_id;
      actor.reason = reason;
    }
    delete record.summary;
    delete record.summary_publication;
    return record;
  }, projectHint);
}

const RETRYABLE_TERMINALS = new Set<RunActorTerminal>([
  'failed', 'blocked', 'stopped', 'removed',
]);

/** Pure retry-scope selector shared by the claim writer and state mutation. */
export function retryableRunActorIds(
  record: RunRecord,
  requestedAgentIds?: string[],
): string[] {
  const requested = normalizeIds(requestedAgentIds);
  const filter = requested.length ? new Set(requested) : null;
  return record.actors
    .filter((actor) => RETRYABLE_TERMINALS.has(actor.terminal))
    .filter((actor) => !filter || filter.has(actor.agent_id))
    .map((actor) => actor.agent_id);
}

/** 只重置未完成终态；已完成 actor 与其产出原样保留。 */
export async function prepareRunRetry(
  uid: string,
  cid: string,
  runId: string,
  requestedAgentIds?: string[],
  retryOperationId?: string,
  projectHint?: string | null,
): Promise<{ run: RunRecord; retry_agent_ids: string[] } | null> {
  if (retryOperationId !== undefined && !safeId(retryOperationId)) return null;
  let retryAgentIds: string[] = [];
  const run = await updateRun(uid, cid, runId, (record) => {
    retryAgentIds = retryableRunActorIds(record, requestedAgentIds);
    if (!retryAgentIds.length) return null;
    const targets = new Set(retryAgentIds);
    for (const actor of record.actors) {
      if (!targets.has(actor.agent_id)) continue;
      actor.terminal = 'pending';
      if (retryOperationId) actor.retry_operation_id = retryOperationId;
      else delete actor.retry_operation_id;
      delete actor.reason;
      delete actor.produced;
    }
    record.status = 'running';
    delete record.summary;
    delete record.summary_publication;
    return record;
  }, projectHint);
  return run && retryAgentIds.length ? { run, retry_agent_ids: retryAgentIds } : null;
}
