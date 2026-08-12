import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  mateRuntimeSessionsDir,
  userChatsDir,
  userCloudRoot,
  userLocalSessionsDir,
  userSessionsDir,
} from '../../paths';
import { genId12, safeId } from '../../storage';
import { isPathAllowed } from '../../util/path-sandbox';

export const MATE_AGENT_RUNTIME_PROTOCOL_VERSION = 2;

export type RuntimeStatus = 'started' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RuntimeTextContext {
  type: 'text';
  content: string;
  label?: string;
}

export interface RuntimeFileContext {
  type: 'file';
  path: string;
  label?: string;
}

export type RuntimeContextItem = RuntimeTextContext | RuntimeFileContext;

export interface RuntimeAttachment {
  type: 'file';
  path: string;
  name?: string;
}

export interface RuntimeRunRequest {
  protocol_version: number;
  type: 'run';
  request_id: string;
  runtime_session_id: string;
  user_id: string;
  task: string;
  context: RuntimeContextItem[];
  attachments: RuntimeAttachment[];
  agent_id?: string;
  model_profile?: string;
  working_dir?: string;
  read_only_roots?: string[];
  writable_roots?: string[];
  /** Trusted capability grants derived by the main process from the persisted
   *  Mate task/session (never self-declared by the worker or the model). The
   *  tool runner filters its catalog by these; the host router re-validates
   *  against the persisted session independently. */
  capabilities?: string[];
}

export interface RuntimeCancelRequest {
  protocol_version: number;
  type: 'cancel';
  request_id: string;
}

export interface RuntimeHelloRequest {
  type: 'hello';
  protocol_version: number;
}

export interface RuntimeHelloResponse {
  type: 'hello';
  protocol_version: number;
  capabilities: string[];
}

/** Capability grants a Runtime run can carry. Only `messaging.proactive`
 *  exists today; it enables the Commander-only Feishu/Lark send tools. */
export const RUNTIME_CAPABILITIES = Object.freeze(['messaging.proactive'] as const);

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export function isRuntimeCapability(value: string): value is RuntimeCapability {
  return (RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

export const RUNTIME_HOST_TOOL_NAMES = Object.freeze([
  'office_read', 'office_create', 'office_edit', 'office_render',
  'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot',
  'mate_delegate', 'mate_tasks', 'mate_cancel', 'mate_retry_step', 'mate_skip_step', 'mate_resume_workflow', 'mate_workflow',
  'messaging_list_targets', 'messaging_send',
] as const);

export type RuntimeHostToolName = typeof RUNTIME_HOST_TOOL_NAMES[number];

export function isRuntimeHostToolName(name: string): name is RuntimeHostToolName {
  return (RUNTIME_HOST_TOOL_NAMES as readonly string[]).includes(name);
}

export interface RuntimeHostToolCall {
  type: 'host_tool_call';
  request_id: string;
  runtime_session_id: string;
  call_id: string;
  name: RuntimeHostToolName;
  input: Record<string, unknown>;
}

export interface RuntimeHostToolResult {
  type: 'host_tool_result';
  request_id: string;
  runtime_session_id: string;
  call_id: string;
  content: string;
  is_error?: boolean;
}

export type RuntimeWorkerRequest = RuntimeHelloRequest | RuntimeRunRequest | RuntimeCancelRequest | { type: 'health'; request_id?: string } | { type: 'shutdown' } | RuntimeHostToolResult;

export interface RuntimeEventEnvelope {
  type: 'event' | 'result' | 'error';
  request_id: string;
  runtime_session_id: string;
  status: RuntimeStatus;
  text?: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export type RuntimeNormalizeErrorCode =
  | 'E_RUNTIME_INVALID_REQUEST'
  | 'E_RUNTIME_FORBIDDEN_FIELD'
  | 'E_RUNTIME_INVALID_ID'
  | 'E_RUNTIME_PATH_DENIED'
  | 'E_RUNTIME_TRANSCRIPT_PATH';

export type RuntimeNormalizeResult =
  | { ok: true; request: RuntimeRunRequest }
  | { ok: false; code: RuntimeNormalizeErrorCode; error: string };

export interface RuntimeNormalizeOptions {
  allowedRoots: readonly string[];
  requestId?: string;
  runtimeSessionId?: string;
}

const FORBIDDEN_FIELDS = new Set([
  'cid',
  'conversation_id',
  'conversationId',
  'session_id',
  'sessionId',
  'transcript_path',
  'conversation_file',
  'conversationFile',
]);

function fail(code: RuntimeNormalizeErrorCode, error: string): RuntimeNormalizeResult {
  return { ok: false, code, error };
}

function runtimeId(prefix: 'req' | 'mruntime', provided?: string): string {
  if (provided) return provided;
  return `${prefix}-${genId12()}`;
}

function validateId(value: string, expectedPrefix: 'req' | 'mruntime', field: string): RuntimeNormalizeResult | null {
  if (!value.startsWith(`${expectedPrefix}-`) || !safeId(value)) {
    return fail('E_RUNTIME_INVALID_ID', `invalid ${field}`);
  }
  return null;
}

function realOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const resolved = path.resolve(p);
    let existing = resolved;
    const missing: string[] = [];
    while (existing && existing !== path.dirname(existing)) {
      try {
        existing = fs.realpathSync(existing);
        break;
      } catch {
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    return missing.length ? path.join(existing, ...missing) : existing;
  }
}

function isProjectTranscriptPath(uid: string, candidate: string): boolean {
  const realCandidate = realOrResolve(candidate);
  if (!realCandidate.endsWith('.jsonl')) return false;
  const realCloudRoot = realOrResolve(userCloudRoot(uid));
  const relative = path.relative(realCloudRoot, realCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments.length >= 4
    && segments[0] === 'projects'
    && Boolean(segments[1])
    && (segments[2] === 'chats' || segments[2] === 'sessions')
    && Boolean(segments[3]);
}

function isTranscriptPath(uid: string, candidate: string): boolean {
  const realCandidate = realOrResolve(candidate);
  if (!realCandidate.endsWith('.jsonl')) return false;
  const transcriptRoots = [
    userChatsDir(uid),
    userSessionsDir(uid),
    userLocalSessionsDir(uid),
    mateRuntimeSessionsDir(uid),
  ];
  return isPathAllowed(realCandidate, transcriptRoots) || isProjectTranscriptPath(uid, realCandidate);
}

function normalizeFilePath(uid: string, rawPath: unknown, allowedRoots: readonly string[]): { ok: true; path: string } | { ok: false; code: RuntimeNormalizeErrorCode; error: string } {
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) {
    return { ok: false, code: 'E_RUNTIME_PATH_DENIED', error: 'runtime file path must be absolute' };
  }
  const resolved = path.resolve(rawPath);
  if (isTranscriptPath(uid, resolved)) {
    return { ok: false, code: 'E_RUNTIME_TRANSCRIPT_PATH', error: 'Runtime request cannot include CogSeed transcript paths' };
  }
  if (!isPathAllowed(resolved, allowedRoots)) {
    return { ok: false, code: 'E_RUNTIME_PATH_DENIED', error: 'runtime file path is outside the explicit sandbox' };
  }
  return { ok: true, path: resolved };
}

function normalizeContext(uid: string, value: unknown, allowedRoots: readonly string[]): { ok: true; context: RuntimeContextItem[]; roots: string[] } | { ok: false; code: RuntimeNormalizeErrorCode; error: string } {
  if (value === undefined || value === null) return { ok: true, context: [], roots: [] };
  if (!Array.isArray(value)) return { ok: false, code: 'E_RUNTIME_INVALID_REQUEST', error: 'runtime context must be an array' };
  const context: RuntimeContextItem[] = [];
  const roots: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return { ok: false, code: 'E_RUNTIME_INVALID_REQUEST', error: 'invalid runtime context item' };
    const type = (item as any).type;
    if (type === 'text') {
      const content = (item as any).content;
      if (typeof content !== 'string') return { ok: false, code: 'E_RUNTIME_INVALID_REQUEST', error: 'text context content must be a string' };
      const out: RuntimeTextContext = { type: 'text', content };
      if (typeof (item as any).label === 'string') out.label = (item as any).label;
      context.push(out);
      continue;
    }
    if (type === 'file') {
      const normalized = normalizeFilePath(uid, (item as any).path, allowedRoots);
      if (normalized.ok === false) return { ok: false, code: normalized.code, error: normalized.error };
      const out: RuntimeFileContext = { type: 'file', path: normalized.path };
      if (typeof (item as any).label === 'string') out.label = (item as any).label;
      context.push(out);
      roots.push(normalized.path);
      continue;
    }
    return { ok: false, code: 'E_RUNTIME_INVALID_REQUEST', error: 'unsupported runtime context item type' };
  }
  return { ok: true, context, roots };
}

function normalizeAttachments(uid: string, value: unknown, allowedRoots: readonly string[]): { ok: true; attachments: RuntimeAttachment[]; roots: string[] } | { ok: false; code: RuntimeNormalizeErrorCode; error: string } {
  if (value === undefined || value === null) return { ok: true, attachments: [], roots: [] };
  if (!Array.isArray(value)) return { ok: false, code: 'E_RUNTIME_INVALID_REQUEST', error: 'runtime attachments must be an array' };
  const attachments: RuntimeAttachment[] = [];
  const roots: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || (item as any).type !== 'file') {
      return { ok: false, code: 'E_RUNTIME_INVALID_REQUEST', error: 'unsupported runtime attachment' };
    }
    const normalized = normalizeFilePath(uid, (item as any).path, allowedRoots);
    if (normalized.ok === false) return { ok: false, code: normalized.code, error: normalized.error };
    const out: RuntimeAttachment = { type: 'file', path: normalized.path };
    if (typeof (item as any).name === 'string') out.name = (item as any).name;
    attachments.push(out);
    roots.push(normalized.path);
  }
  return { ok: true, attachments, roots };
}

export function normalizeRuntimeRunRequest(uid: string, raw: unknown, opts: RuntimeNormalizeOptions): RuntimeNormalizeResult {
  if (!safeId(uid)) return fail('E_RUNTIME_INVALID_ID', 'invalid user id');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('E_RUNTIME_INVALID_REQUEST', 'runtime request must be an object');
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (FORBIDDEN_FIELDS.has(key)) return fail('E_RUNTIME_FORBIDDEN_FIELD', `field ${key} is not accepted by Runtime requests`);
  }
  const task = (raw as any).task;
  if (typeof task !== 'string' || !task.trim()) return fail('E_RUNTIME_INVALID_REQUEST', 'runtime task must be a non-empty string');

  const request_id = runtimeId('req', opts.requestId || (raw as any).request_id);
  const runtime_session_id = runtimeId('mruntime', opts.runtimeSessionId || (raw as any).runtime_session_id);
  const badReq = validateId(request_id, 'req', 'request_id');
  if (badReq) return badReq;
  const badSession = validateId(runtime_session_id, 'mruntime', 'runtime_session_id');
  if (badSession) return badSession;

  const context = normalizeContext(uid, (raw as any).context, opts.allowedRoots);
  if (context.ok === false) return { ok: false, code: context.code, error: context.error };
  const attachments = normalizeAttachments(uid, (raw as any).attachments, opts.allowedRoots);
  if (attachments.ok === false) return { ok: false, code: attachments.code, error: attachments.error };

  const agentId = (raw as any).agent_id;
  if (agentId !== undefined && (typeof agentId !== 'string' || !safeId(agentId))) return fail('E_RUNTIME_INVALID_ID', 'invalid agent_id');
  const modelProfile = (raw as any).model_profile;
  if (modelProfile !== undefined && (typeof modelProfile !== 'string' || !safeId(modelProfile))) return fail('E_RUNTIME_INVALID_ID', 'invalid model_profile');
  const workingDir = (raw as any).working_dir;
  if (workingDir !== undefined) {
    const normalized = normalizeFilePath(uid, workingDir, opts.allowedRoots);
    if (normalized.ok === false) return { ok: false, code: normalized.code, error: normalized.error };
  }
  const capabilities = (raw as any).capabilities;
  if (capabilities !== undefined) {
    if (!Array.isArray(capabilities) || capabilities.length > 8
      || capabilities.some((item) => typeof item !== 'string' || !isRuntimeCapability(item))) {
      return fail('E_RUNTIME_INVALID_REQUEST', 'runtime capabilities must be a bounded array of known capability names');
    }
  }

  const readOnlyRoots = Array.from(new Set([...context.roots, ...attachments.roots]));
  const request: RuntimeRunRequest = {
    protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION,
    type: 'run',
    request_id,
    runtime_session_id,
    user_id: uid,
    task: task.trim(),
    context: context.context,
    attachments: attachments.attachments,
  };
  if (agentId) request.agent_id = agentId;
  if (modelProfile) request.model_profile = modelProfile;
  if (typeof workingDir === 'string') {
    request.working_dir = path.resolve(workingDir);
    request.writable_roots = [request.working_dir];
  }
  if (readOnlyRoots.length) request.read_only_roots = readOnlyRoots;
  if (capabilities?.length) request.capabilities = [...capabilities] as string[];
  return { ok: true, request };
}

export function buildRuntimePrompt(input: Pick<RuntimeRunRequest, 'task' | 'context' | 'attachments'>): string {
  const parts = [
    'CogSeed Runtime request.',
    'Use only the explicit task, context, and attachments listed in this request. Do not infer or request CogSeed transcripts.',
    '',
    '## Task',
    input.task,
  ];
  if (input.context?.length) {
    parts.push('', '## Explicit context');
    input.context.forEach((item, idx) => {
      if (item.type === 'text') {
        parts.push(`### Text ${idx + 1}${item.label ? ` — ${item.label}` : ''}`, item.content);
      } else {
        parts.push(`### File ${idx + 1}${item.label ? ` — ${item.label}` : ''}`, item.path);
      }
    });
  }
  if (input.attachments?.length) {
    parts.push('', '## Explicit attachments');
    input.attachments.forEach((item, idx) => {
      parts.push(`- ${item.name || `attachment ${idx + 1}`}: ${item.path}`);
    });
  }
  return parts.join('\n');
}

export function isRuntimeTerminalEvent(event: RuntimeEventEnvelope): boolean {
  return event.type === 'result' || event.status === 'failed' || event.status === 'cancelled' || event.type === 'error';
}
