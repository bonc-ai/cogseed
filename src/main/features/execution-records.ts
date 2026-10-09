/**
 * User-local execution records shared by in-process and CLI-backed agents.
 *
 * Invariants:
 *   - One immutable-identity record per execution, written atomically.
 *   - One append-only events.jsonl stream with monotonic one-based `seq`.
 *   - Record updates and event appends share a per-execution mutex.
 *   - Persisted metadata is recursively bounded/redacted and never contains
 *     full prompts, credentials, or arbitrary absolute paths.
 *   - Output bodies live in the execution Result Store; records/events keep
 *     only a validated `output:<ref>` handle.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { userLocalRoot } from '../paths';
import { safeId, writeJson } from '../storage';
import { resolveArtifactDir } from './chat_artifacts';
import { fileEditLock } from '../util/locks';
import { sanitizeLogTextForUpload } from '../util/log-sanitize';
import { persistToolResult } from '../util/tool-result-cap';
import { logErrorRef, maskId } from '../util/log-redact';

const log = createLogger('execution-records');

const MAX_ID_LENGTH = 160;
const MAX_PERMISSION_LENGTH = 160;
const MAX_RESULT_REF_LENGTH = 512;
const MAX_EVENT_TYPE_LENGTH = 80;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_KEYS = 64;
const MAX_ARRAY_ITEMS = 64;
const MAX_INLINE_STRING = 2_048;
const MAX_INLINE_OUTPUT = 4_096;
const MAX_METADATA_JSON_CHARS = 12_000;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';

const PERMISSION_RE = /^[A-Za-z0-9_.:/-]+$/;
const EVENT_TYPE_RE = /^[A-Za-z0-9_.:-]+$/;
const RESULT_REF_RE = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_.-]+$/;
const SENSITIVE_KEY_RE = /(?:api.?key|access.?token|refresh.?token|id.?token|oauth|authorization|cookie|secret|password|passwd|private.?key|client.?secret)/i;
const PROMPT_KEY_RE = /(?:^|_)(?:prompt|system_prompt|user_prompt|messages?|instructions?)(?:$|_)/i;
const PATH_KEY_RE = /(?:^|_)(?:path|paths|cwd|working_dir|workspace)(?:$|_)/i;
const INLINE_SENSITIVE_VALUE_RE = new RegExp(
  String.raw`\b((?:api_?key|access_?token|refresh_?token|id_?token|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie))(\s*[:=]\s*)([^,;&\n]+)`,
  'gi',
);
const INLINE_PROMPT_VALUE_RE = /\b((?:system|user)?_?prompt|instructions?)(\s*[:=]\s*)([^,;&\n]+)/gi;
const GENERIC_POSIX_ABS_PATH_RE = /(^|[\s'",(=])(\/(?!\/)[^\s'",)]+)/g;
const UNC_ABS_PATH_RE = /(^|[\s'",(=])(\\\\[^\s'",)]+)/g;

export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type ExecutionKind = 'core-agent' | 'codex' | 'local-agent' | 'openclaw';
export type ExecutionBoundary = 'real' | 'degraded' | 'test-double';

export interface ExecutionRecord {
  executionId: string;
  uid: string;
  kind: ExecutionKind;
  sessionId: string;
  conversationId?: string;
  agentId?: string;
  cli?: string;
  contextId?: string;
  receiptId?: string;
  resultRef?: string;
  status: ExecutionStatus;
  boundary: ExecutionBoundary;
  permissionMode: string;
  artifactIds: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ExecutionEvent {
  seq: number;
  type: string;
  at: string;
  metadata: Record<string, unknown>;
}

export interface CreateExecutionInput {
  executionId: string;
  kind: ExecutionKind;
  sessionId: string;
  conversationId?: string;
  agentId?: string;
  cli?: string;
  contextId?: string;
  receiptId?: string;
  resultRef?: string;
  status?: 'queued' | 'running';
  boundary: ExecutionBoundary;
  permissionMode: string;
}

export interface UpdateExecutionInput {
  sessionId?: string;
  contextId?: string;
  receiptId?: string;
  resultRef?: string;
  status?: ExecutionStatus;
  boundary?: ExecutionBoundary;
  permissionMode?: string;
}

export interface AppendExecutionEventInput {
  type: string;
  metadata?: Record<string, unknown>;
  at?: string;
}

export interface ExecutionArtifactRef {
  cid: string;
  artifactId: string;
  title: string;
}

export interface CompleteExecutionInput {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  sessionId?: string;
  contextId?: string;
  receiptId?: string;
  resultRef?: string;
  output?: string;
  boundary?: ExecutionBoundary;
}

export interface ExecutionLifecycleStartInput {
  kind?: ExecutionKind;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  cli?: string;
  contextId?: string;
  receiptId?: string;
}

export interface ExecutionLifecycleSink {
  queued(input?: ExecutionLifecycleStartInput): Promise<void>;
  started(input?: ExecutionLifecycleStartInput): Promise<void>;
  event(type: string, metadata?: Record<string, unknown>, at?: string): Promise<void>;
  artifact(artifact: ExecutionArtifactRef): Promise<void>;
  terminal(input: CompleteExecutionInput): Promise<ExecutionRecord>;
}

function requireId(value: unknown, field: string, allowPending = false): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_ID_LENGTH ||
    (!safeId(value) && !(allowPending && value === 'pending'))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function optionalId(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireId(value, field);
}

function requireKind(value: unknown): ExecutionKind {
  if (value === 'core-agent' || value === 'codex' || value === 'local-agent' || value === 'openclaw') return value;
  throw new Error('invalid execution kind');
}

function requireBoundary(value: unknown): ExecutionBoundary {
  if (value === 'real' || value === 'degraded' || value === 'test-double') return value;
  throw new Error('invalid execution boundary');
}

function requireStatus(value: unknown): ExecutionStatus {
  if (
    value === 'queued' || value === 'running' || value === 'completed' ||
    value === 'failed' || value === 'cancelled' || value === 'timed_out'
  ) return value;
  throw new Error('invalid execution status');
}

function requirePermissionMode(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value.length > MAX_PERMISSION_LENGTH ||
    !PERMISSION_RE.test(value)
  ) throw new Error('invalid permission mode');
  return value;
}

function requireResultRef(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value.length > MAX_RESULT_REF_LENGTH ||
    path.isAbsolute(value) || value.includes('..') || !RESULT_REF_RE.test(value)
  ) throw new Error('invalid result ref');
  return value;
}

function optionalResultRef(value: unknown): string | undefined {
  return value === undefined ? undefined : requireResultRef(value);
}

function terminal(status: ExecutionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out';
}

function validateTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (terminal(from)) throw new Error('execution is already terminal');
  if (from === 'running' && to === 'queued') throw new Error('execution status cannot return to queued');
}

export function executionDir(userId: string, executionId: string): string {
  const safeExecutionId = requireId(executionId, 'execution id');
  return path.join(userLocalRoot(userId), 'kstar', 'executions', safeExecutionId);
}

export function executionRecordPath(userId: string, executionId: string): string {
  return path.join(executionDir(userId, executionId), 'record.json');
}

export function executionEventsPath(userId: string, executionId: string): string {
  return path.join(executionDir(userId, executionId), 'events.jsonl');
}

function executionOutputsDir(userId: string, executionId: string): string {
  return path.join(executionDir(userId, executionId), 'outputs');
}

function executionLock(userId: string, executionId: string) {
  return fileEditLock(executionRecordPath(userId, executionId));
}

function parseRecord(raw: string): ExecutionRecord {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('execution record is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('execution record is malformed');
  }
  const row = value as Record<string, unknown>;
  const record: ExecutionRecord = {
    executionId: requireId(row.executionId, 'execution id'),
    uid: typeof row.uid === 'string' && row.uid ? row.uid : (() => { throw new Error('execution record is malformed'); })(),
    kind: requireKind(row.kind),
    sessionId: requireId(row.sessionId, 'session id', true),
    ...(optionalId(row.conversationId, 'conversation id') ? { conversationId: optionalId(row.conversationId, 'conversation id') } : {}),
    ...(optionalId(row.agentId, 'agent id') ? { agentId: optionalId(row.agentId, 'agent id') } : {}),
    ...(optionalId(row.cli, 'cli') ? { cli: optionalId(row.cli, 'cli') } : {}),
    ...(optionalId(row.contextId, 'context id') ? { contextId: optionalId(row.contextId, 'context id') } : {}),
    ...(optionalId(row.receiptId, 'receipt id') ? { receiptId: optionalId(row.receiptId, 'receipt id') } : {}),
    ...(optionalResultRef(row.resultRef) ? { resultRef: optionalResultRef(row.resultRef) } : {}),
    status: requireStatus(row.status),
    boundary: requireBoundary(row.boundary),
    permissionMode: requirePermissionMode(row.permissionMode),
    artifactIds: Array.isArray(row.artifactIds)
      ? Array.from(new Set(row.artifactIds.map((id) => requireId(id, 'artifact id'))))
      : (() => { throw new Error('execution record is malformed'); })(),
    startedAt: typeof row.startedAt === 'string' && row.startedAt ? row.startedAt : (() => { throw new Error('execution record is malformed'); })(),
    updatedAt: typeof row.updatedAt === 'string' && row.updatedAt ? row.updatedAt : (() => { throw new Error('execution record is malformed'); })(),
    ...(typeof row.completedAt === 'string' && row.completedAt ? { completedAt: row.completedAt } : {}),
  };
  return record;
}

async function readUnlocked(userId: string, executionId: string): Promise<ExecutionRecord> {
  try {
    const record = parseRecord(await fs.readFile(executionRecordPath(userId, executionId), 'utf8'));
    if (record.uid !== userId || record.executionId !== executionId) {
      throw new Error('execution record identity mismatch');
    }
    return record;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('execution record not found');
    throw err;
  }
}

export async function create(userId: string, input: CreateExecutionInput): Promise<ExecutionRecord> {
  const executionId = requireId(input.executionId, 'execution id');
  const recordPath = executionRecordPath(userId, executionId);
  return executionLock(userId, executionId).runExclusive(async () => {
    try {
      await fs.access(recordPath);
      throw new Error('execution record already exists');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const now = new Date().toISOString();
    const record: ExecutionRecord = {
      executionId,
      uid: userId,
      kind: requireKind(input.kind),
      sessionId: requireId(input.sessionId, 'session id', true),
      ...(optionalId(input.conversationId, 'conversation id') ? { conversationId: input.conversationId } : {}),
      ...(optionalId(input.agentId, 'agent id') ? { agentId: input.agentId } : {}),
      ...(optionalId(input.cli, 'cli') ? { cli: input.cli } : {}),
      ...(optionalId(input.contextId, 'context id') ? { contextId: input.contextId } : {}),
      ...(optionalId(input.receiptId, 'receipt id') ? { receiptId: input.receiptId } : {}),
      ...(optionalResultRef(input.resultRef) ? { resultRef: input.resultRef } : {}),
      status: input.status ? requireStatus(input.status) : 'queued',
      boundary: requireBoundary(input.boundary),
      permissionMode: requirePermissionMode(input.permissionMode),
      artifactIds: [],
      startedAt: now,
      updatedAt: now,
    };
    await writeJson(recordPath, record);
    return record;
  });
}

export async function read(userId: string, executionId: string): Promise<ExecutionRecord> {
  requireId(executionId, 'execution id');
  return readUnlocked(userId, executionId);
}

export async function list(userId: string): Promise<ExecutionRecord[]> {
  const root = path.join(userLocalRoot(userId), 'kstar', 'executions');
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: ExecutionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    try { records.push(await readUnlocked(userId, entry.name)); }
    catch (err) {
      log.warn('skipping unreadable execution record', {
        user_id: maskId(userId),
        execution_id: maskId(entry.name),
        error: logErrorRef(err),
      });
    }
  }
  return records.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function assertKnownPatchKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allow.has(key));
  if (unknown.length) throw new Error(`immutable or unknown execution field: ${unknown[0]}`);
}

export async function update(
  userId: string,
  executionId: string,
  input: UpdateExecutionInput,
): Promise<ExecutionRecord> {
  requireId(executionId, 'execution id');
  assertKnownPatchKeys(input as Record<string, unknown>, [
    'sessionId', 'contextId', 'receiptId', 'resultRef', 'status', 'boundary', 'permissionMode',
  ]);
  return executionLock(userId, executionId).runExclusive(async () => {
    const current = await readUnlocked(userId, executionId);
    if (terminal(current.status)) throw new Error('execution is already terminal');
    const nextStatus = input.status === undefined ? current.status : requireStatus(input.status);
    if (input.status !== undefined && terminal(nextStatus)) {
      throw new Error('use complete() for terminal execution status');
    }
    validateTransition(current.status, nextStatus);
    const now = new Date().toISOString();
    const next: ExecutionRecord = {
      ...current,
      ...(input.sessionId !== undefined ? { sessionId: requireId(input.sessionId, 'session id', true) } : {}),
      ...(input.contextId !== undefined ? { contextId: requireId(input.contextId, 'context id') } : {}),
      ...(input.receiptId !== undefined ? { receiptId: requireId(input.receiptId, 'receipt id') } : {}),
      ...(input.resultRef !== undefined ? { resultRef: requireResultRef(input.resultRef) } : {}),
      ...(input.boundary !== undefined ? { boundary: requireBoundary(input.boundary) } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: requirePermissionMode(input.permissionMode) } : {}),
      status: nextStatus,
      updatedAt: now,
      ...(terminal(nextStatus) ? { completedAt: now } : {}),
    };
    await writeJson(executionRecordPath(userId, executionId), next);
    return next;
  });
}

function sanitizeString(value: string, maxLength = MAX_INLINE_STRING): string {
  const safe = sanitizeLogTextForUpload(value)
    .replace(INLINE_SENSITIVE_VALUE_RE, (_match, field: string, separator: string) => (
      `${field}${separator}${REDACTED}`
    ))
    .replace(INLINE_PROMPT_VALUE_RE, (_match, field: string, separator: string) => (
      `${field}${separator}${REDACTED}`
    ))
    .replace(GENERIC_POSIX_ABS_PATH_RE, (_match, prefix: string) => `${prefix}[PATH]`)
    .replace(UNC_ABS_PATH_RE, (_match, prefix: string) => `${prefix}[PATH]`);
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength)}${TRUNCATED}`;
}

function sanitizeMetadataValue(value: unknown, key: string, depth: number): unknown {
  if (SENSITIVE_KEY_RE.test(key) || PROMPT_KEY_RE.test(key)) return REDACTED;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (
      PATH_KEY_RE.test(key) &&
      (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('\\'))
    ) return '[PATH]';
    return sanitizeString(value);
  }
  if (depth >= MAX_METADATA_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeMetadataValue(item, key, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) bounded.push(TRUNCATED);
    return bounded;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [nestedKey, nestedValue] of entries.slice(0, MAX_METADATA_KEYS)) {
      output[sanitizeString(nestedKey, 120)] = sanitizeMetadataValue(nestedValue, nestedKey, depth + 1);
    }
    if (entries.length > MAX_METADATA_KEYS) output._truncated = true;
    return output;
  }
  return sanitizeString(String(value));
}

function spillOutput(userId: string, executionId: string, output: string): string {
  const abs = persistToolResult(executionOutputsDir(userId, executionId), 'output', output);
  return requireResultRef(`output:${path.basename(abs, '.txt')}`);
}

function sanitizeMetadata(
  userId: string,
  executionId: string,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source).slice(0, MAX_METADATA_KEYS)) {
    if (key === 'output' && typeof value === 'string' && value.length > MAX_INLINE_OUTPUT) {
      bounded.resultRef = spillOutput(userId, executionId, value);
      bounded.outputChars = value.length;
      continue;
    }
    bounded[sanitizeString(key, 120)] = sanitizeMetadataValue(value, key, 0);
  }
  if (Object.keys(source).length > MAX_METADATA_KEYS) bounded._truncated = true;
  const serialized = JSON.stringify(bounded);
  if (serialized.length > MAX_METADATA_JSON_CHARS) {
    return {
      _truncated: true,
      originalChars: serialized.length,
      keys: Object.keys(bounded).slice(0, MAX_METADATA_KEYS),
    };
  }
  return bounded;
}

async function countEvents(eventsPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(eventsPath, 'utf8');
    return raw.split('\n').reduce((count, line) => count + (line.trim() ? 1 : 0), 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

export async function appendEvent(
  userId: string,
  executionId: string,
  input: AppendExecutionEventInput,
): Promise<ExecutionEvent> {
  requireId(executionId, 'execution id');
  if (
    typeof input.type !== 'string' || !input.type || input.type.length > MAX_EVENT_TYPE_LENGTH ||
    !EVENT_TYPE_RE.test(input.type)
  ) throw new Error('invalid execution event type');
  return executionLock(userId, executionId).runExclusive(async () => {
    await readUnlocked(userId, executionId);
    const eventsPath = executionEventsPath(userId, executionId);
    const event: ExecutionEvent = {
      seq: (await countEvents(eventsPath)) + 1,
      type: input.type,
      at: input.at && !Number.isNaN(Date.parse(input.at)) ? input.at : new Date().toISOString(),
      metadata: sanitizeMetadata(userId, executionId, input.metadata),
    };
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  });
}

export async function readEvents(userId: string, executionId: string): Promise<ExecutionEvent[]> {
  requireId(executionId, 'execution id');
  let raw: string;
  try { raw = await fs.readFile(executionEventsPath(userId, executionId), 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const events: ExecutionEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error('execution event log is malformed'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('execution event log is malformed');
    const row = value as Record<string, unknown>;
    if (
      typeof row.seq !== 'number' || row.seq !== events.length + 1 ||
      typeof row.type !== 'string' || typeof row.at !== 'string' ||
      !row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)
    ) throw new Error('execution event log is malformed');
    events.push(row as unknown as ExecutionEvent);
  }
  return events;
}

export async function attachArtifact(
  userId: string,
  executionId: string,
  artifact: ExecutionArtifactRef,
): Promise<ExecutionRecord> {
  requireId(executionId, 'execution id');
  const cid = requireId(artifact.cid, 'conversation id');
  const artifactId = requireId(artifact.artifactId, 'artifact id');
  if (typeof artifact.title !== 'string' || !artifact.title.trim() || artifact.title.length > 240) {
    throw new Error('invalid artifact title');
  }
  return executionLock(userId, executionId).runExclusive(async () => {
    const current = await readUnlocked(userId, executionId);
    if (current.conversationId && current.conversationId !== cid) {
      throw new Error('artifact conversation does not match execution');
    }
    const resolved = resolveArtifactDir(userId, cid, artifactId);
    if (!resolved.ok) throw new Error(`artifact reference is invalid: ${(resolved as { error: string }).error}`);
    if (current.artifactIds.includes(artifactId)) return current;
    const next: ExecutionRecord = {
      ...current,
      artifactIds: [...current.artifactIds, artifactId],
      updatedAt: new Date().toISOString(),
    };
    await writeJson(executionRecordPath(userId, executionId), next);
    return next;
  });
}

export async function complete(
  userId: string,
  executionId: string,
  input: CompleteExecutionInput,
): Promise<ExecutionRecord> {
  requireId(executionId, 'execution id');
  assertKnownPatchKeys(input as unknown as Record<string, unknown>, [
    'status', 'sessionId', 'contextId', 'receiptId', 'resultRef', 'output', 'boundary',
  ]);
  return executionLock(userId, executionId).runExclusive(async () => {
    const current = await readUnlocked(userId, executionId);
    if (terminal(current.status)) throw new Error('execution is already terminal');
    const status = requireStatus(input.status);
    if (!terminal(status)) throw new Error('completion status must be terminal');
    const resultRef = input.output !== undefined
      ? spillOutput(userId, executionId, input.output)
      : optionalResultRef(input.resultRef);
    const now = new Date().toISOString();
    const next: ExecutionRecord = {
      ...current,
      ...(input.sessionId !== undefined ? { sessionId: requireId(input.sessionId, 'session id', true) } : {}),
      ...(input.contextId !== undefined ? { contextId: requireId(input.contextId, 'context id') } : {}),
      ...(input.receiptId !== undefined ? { receiptId: requireId(input.receiptId, 'receipt id') } : {}),
      ...(resultRef ? { resultRef } : {}),
      ...(input.boundary !== undefined ? { boundary: requireBoundary(input.boundary) } : {}),
      status,
      updatedAt: now,
      completedAt: now,
    };
    await writeJson(executionRecordPath(userId, executionId), next);
    return next;
  });
}

function normalizeLifecycleMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  return meta;
}

export function createLifecycleSink(
  userId: string,
  input: {
    executionId: string;
    kind?: ExecutionKind;
    conversationId?: string;
    agentId?: string;
    cli?: string;
    contextId?: string;
    receiptId?: string;
    boundary: ExecutionBoundary;
    permissionMode: string;
    sessionId?: string;
  },
): ExecutionLifecycleSink {
  const executionId = requireId(input.executionId, 'execution id');
  let created = false;
  let started = false;
  const ensureCreated = async (start?: ExecutionLifecycleStartInput): Promise<ExecutionRecord> => {
    if (!created) {
      const kind = start?.kind ?? input.kind;
      if (!kind) throw new Error('execution lifecycle kind is required before persistence');
      const record = await create(userId, {
        executionId,
        kind,
        sessionId: start?.sessionId ?? input.sessionId ?? 'pending',
        ...(start?.conversationId ?? input.conversationId ? { conversationId: start?.conversationId ?? input.conversationId } : {}),
        ...(start?.agentId ?? input.agentId ? { agentId: start?.agentId ?? input.agentId } : {}),
        ...(start?.cli ?? input.cli ? { cli: start?.cli ?? input.cli } : {}),
        ...(start?.contextId ?? input.contextId ? { contextId: start?.contextId ?? input.contextId } : {}),
        ...(start?.receiptId ?? input.receiptId ? { receiptId: start?.receiptId ?? input.receiptId } : {}),
        boundary: input.boundary,
        permissionMode: input.permissionMode,
        status: 'queued',
      });
      created = true;
      return record;
    }
    return read(userId, executionId);
  };
  const recordPhase = async (phase: string, metadata?: Record<string, unknown>, at?: string): Promise<void> => {
    await ensureCreated();
    await appendEvent(userId, executionId, { type: phase, metadata: normalizeLifecycleMeta(metadata), at });
  };
  return {
    async queued(input?: ExecutionLifecycleStartInput): Promise<void> {
      await ensureCreated(input);
      await recordPhase('queued', {
        ...(input?.kind ? { kind: input.kind } : {}),
        ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input?.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input?.agentId ? { agentId: input.agentId } : {}),
        ...(input?.cli ? { cli: input.cli } : {}),
        ...(input?.contextId ? { contextId: input.contextId } : {}),
        ...(input?.receiptId ? { receiptId: input.receiptId } : {}),
      });
    },
    async started(input?: ExecutionLifecycleStartInput): Promise<void> {
      const record = await ensureCreated(input);
      if (!started) {
        started = true;
        await update(userId, executionId, {
          ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input?.contextId ? { contextId: input.contextId } : {}),
          ...(input?.receiptId ? { receiptId: input.receiptId } : {}),
          status: 'running',
        });
      } else if (input?.sessionId && record.sessionId !== input.sessionId) {
        await update(userId, executionId, { sessionId: input.sessionId });
      }
      await recordPhase('started', {
        ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input?.contextId ? { contextId: input.contextId } : {}),
        ...(input?.receiptId ? { receiptId: input.receiptId } : {}),
      });
    },
    async event(type: string, metadata?: Record<string, unknown>, at?: string): Promise<void> {
      await recordPhase(type, metadata, at);
    },
    async artifact(artifact: ExecutionArtifactRef): Promise<void> {
      await ensureCreated();
      await attachArtifact(userId, executionId, artifact);
      await recordPhase('artifact', artifact as unknown as Record<string, unknown>);
    },
    async terminal(input: CompleteExecutionInput): Promise<ExecutionRecord> {
      await ensureCreated({ sessionId: input.sessionId });
      await recordPhase('terminal', { status: input.status, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
      return complete(userId, executionId, input);
    },
  };
}

export async function readResult(userId: string, executionId: string, resultRef: string): Promise<string> {
  requireId(executionId, 'execution id');
  const ref = requireResultRef(resultRef);
  if (!ref.startsWith('output:')) throw new Error('unsupported result ref');
  const name = ref.slice('output:'.length);
  if (!safeId(name.replace(/\./g, '_'))) throw new Error('invalid result ref');
  const outputPath = path.join(executionOutputsDir(userId, executionId), `${name}.txt`);
  const root = path.resolve(executionOutputsDir(userId, executionId));
  const resolved = path.resolve(outputPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('invalid result ref');
  return fs.readFile(resolved, 'utf8');
}
