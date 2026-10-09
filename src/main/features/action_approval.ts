/**
 * Unified human approval gate for sensitive Runtime actions.
 *
 * The main process owns pending state, expiry, user decisions, and the local
 * audit trail. Renderers can only answer an opaque request id; they never
 * submit the action payload that will be executed.
 */

import * as crypto from 'node:crypto';

import { actionApprovalAuditFile } from '../paths';
import { appendJsonlAtomic, nowIso } from '../storage';
import { createLogger, redact } from '../logger';

const log = createLogger('action-approval');
export const ACTION_APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ActionApprovalKind = 'bash' | 'run_skill' | 'connector_call';
export type ActionApprovalRisk = 'high' | 'critical';
export type ActionApprovalDecision = 'approve' | 'deny';
export type ActionApprovalExecutionPhase = 'started' | 'succeeded' | 'failed';

export interface ActionApprovalInput {
  userId: string;
  runtimeSessionId: string;
  runtimeRequestId: string;
  actor: string;
  action: ActionApprovalKind;
  /** Full human-readable target, delivered to the approval modal only. */
  target: string;
  /** Full human-readable least-privilege scope, delivered to the modal only. */
  scope: string;
  /** Safe, compact labels used in the persistent audit instead of raw inputs. */
  auditTarget: string;
  auditScope: string;
  risk: ActionApprovalRisk;
  reasons: string[];
  /** SHA-256 of the exact worker-side action intent; never shown to the user. */
  fingerprint: string;
  signal?: AbortSignal | null;
}

export type ActionApprovalResult =
  | { approved: true; requestId: string }
  | {
    approved: false;
    code: 'E_ACTION_APPROVAL_DENIED' | 'E_ACTION_APPROVAL_EXPIRED' | 'E_ACTION_APPROVAL_CANCELLED' | 'E_ACTION_APPROVAL_UNAVAILABLE' | 'E_ACTION_APPROVAL_INVALID';
  };

interface PendingApproval {
  input: ActionApprovalInput;
  requestId: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: ActionApprovalResult) => void;
  onAbort?: () => void;
}

interface ApprovedApproval {
  input: ActionApprovalInput;
  requestId: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  started: boolean;
}

interface ApprovalAuditRecord {
  event: 'requested' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'execution_started' | 'execution_succeeded' | 'execution_failed';
  request_id: string;
  runtime_session_id: string;
  runtime_request_id: string;
  actor: string;
  action: ActionApprovalKind;
  target_summary: string;
  scope_summary: string;
  risk: ActionApprovalRisk;
  reasons: string[];
  fingerprint_prefix: string;
  at: string;
  result_code?: string;
}

const pending = new Map<string, PendingApproval>();
const approved = new Map<string, ApprovedApproval>();
let broadcastOverride: ((channel: string, payload: unknown) => boolean | void) | null = null;

function compact(value: unknown, max = 500): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function isApprovalKind(value: unknown): value is ActionApprovalKind {
  return value === 'bash' || value === 'run_skill' || value === 'connector_call';
}

function isRisk(value: unknown): value is ActionApprovalRisk {
  return value === 'high' || value === 'critical';
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function normalizedReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => compact(item, 80))
    .filter(Boolean)
    .slice(0, 8);
}

function validInput(input: ActionApprovalInput): boolean {
  return Boolean(
    input.userId
    && input.runtimeSessionId
    && input.runtimeRequestId
    && compact(input.actor, 120)
    && isApprovalKind(input.action)
    && compact(input.target, 2_000)
    && compact(input.scope, 1_000)
    && compact(input.auditTarget, 300)
    && compact(input.auditScope, 300)
    && isRisk(input.risk)
    && isFingerprint(input.fingerprint),
  );
}

function broadcast(channel: string, payload: unknown): boolean {
  if (broadcastOverride) {
    return broadcastOverride(channel, payload) !== false;
  }
  try {
    // Keep the feature independent of the IPC module at load time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../ipc') as { broadcastToRenderer?: (name: string, value: unknown) => void };
    if (!ipc.broadcastToRenderer) return false;
    ipc.broadcastToRenderer(channel, payload);
    return true;
  } catch {
    return false;
  }
}

async function appendAudit(input: ActionApprovalInput, requestId: string, event: ApprovalAuditRecord['event'], resultCode?: string): Promise<void> {
  const record: ApprovalAuditRecord = {
    event,
    request_id: requestId,
    runtime_session_id: input.runtimeSessionId,
    runtime_request_id: input.runtimeRequestId,
    actor: compact(input.actor, 120),
    action: input.action,
    target_summary: compact(input.auditTarget, 300),
    scope_summary: compact(input.auditScope, 300),
    risk: input.risk,
    reasons: normalizedReasons(input.reasons),
    fingerprint_prefix: input.fingerprint.slice(0, 16),
    at: nowIso(),
    ...(resultCode ? { result_code: compact(resultCode, 160) } : {}),
  };
  try {
    // Audit summaries are deliberately pre-sanitized; redact remains a final
    // safeguard for accidental secrets in a future caller.
    const safe = redact(record) as ApprovalAuditRecord;
    safe.request_id = record.request_id;
    safe.runtime_session_id = record.runtime_session_id;
    safe.runtime_request_id = record.runtime_request_id;
    await appendJsonlAtomic(actionApprovalAuditFile(input.userId), safe);
  } catch (error) {
    log.warn('approval audit append failed', { event, action: input.action, error: error instanceof Error ? error.message : String(error) });
  }
}

function clearPending(item: PendingApproval): void {
  clearTimeout(item.timer);
  if (item.input.signal && item.onAbort) item.input.signal.removeEventListener('abort', item.onAbort);
}

async function settlePending(item: PendingApproval, decision: ActionApprovalDecision | 'expired' | 'cancelled' | 'unavailable'): Promise<void> {
  if (!pending.delete(item.requestId)) return;
  clearPending(item);
  if (decision === 'approve') {
    const timer = setTimeout(() => {
      const grant = approved.get(item.requestId);
      if (!grant) return;
      approved.delete(item.requestId);
      void appendAudit(grant.input, grant.requestId, 'expired', 'approval_not_consumed');
    }, Math.max(1, item.expiresAt - Date.now()));
    timer.unref?.();
    approved.set(item.requestId, { input: item.input, requestId: item.requestId, expiresAt: item.expiresAt, timer, started: false });
    await appendAudit(item.input, item.requestId, 'approved');
    item.resolve({ approved: true, requestId: item.requestId });
    return;
  }
  const event = decision === 'deny' || decision === 'unavailable'
    ? 'denied'
    : decision === 'expired' ? 'expired' : 'cancelled';
  const code = decision === 'expired'
    ? 'E_ACTION_APPROVAL_EXPIRED'
    : decision === 'cancelled'
      ? 'E_ACTION_APPROVAL_CANCELLED'
      : decision === 'unavailable'
        ? 'E_ACTION_APPROVAL_UNAVAILABLE'
        : 'E_ACTION_APPROVAL_DENIED';
  await appendAudit(item.input, item.requestId, event, code);
  item.resolve({ approved: false, code });
}

export async function requestActionApproval(input: ActionApprovalInput): Promise<ActionApprovalResult> {
  if (!validInput(input)) return { approved: false, code: 'E_ACTION_APPROVAL_INVALID' };
  if (input.signal?.aborted) return { approved: false, code: 'E_ACTION_APPROVAL_CANCELLED' };

  const requestId = `approval-${crypto.randomBytes(12).toString('hex')}`;
  const expiresAt = Date.now() + ACTION_APPROVAL_TTL_MS;
  return new Promise<ActionApprovalResult>((resolve) => {
    const timer = setTimeout(() => {
      const item = pending.get(requestId);
      if (item) void settlePending(item, 'expired');
    }, ACTION_APPROVAL_TTL_MS);
    timer.unref?.();
    const item: PendingApproval = { input, requestId, expiresAt, timer, resolve };
    const onAbort = () => { void settlePending(item, 'cancelled'); };
    item.onAbort = onAbort;
    input.signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(requestId, item);
    void (async () => {
      await appendAudit(input, requestId, 'requested');
      const sent = broadcast('action-approval:request', {
        request_id: requestId,
        actor: compact(input.actor, 120),
        action: input.action,
        target: compact(input.target, 2_000),
        scope: compact(input.scope, 1_000),
        risk: input.risk,
        reasons: normalizedReasons(input.reasons),
        expires_at: new Date(expiresAt).toISOString(),
      });
      if (!sent) await settlePending(item, 'unavailable');
    })();
  });
}

export async function respondActionApproval(requestId: string, decision: ActionApprovalDecision): Promise<{ handled: boolean }> {
  const item = pending.get(requestId);
  if (!item) return { handled: false };
  await settlePending(item, decision);
  return { handled: true };
}

export async function recordActionApprovalExecution(input: {
  userId: string;
  runtimeSessionId: string;
  runtimeRequestId: string;
  requestId: string;
  phase: ActionApprovalExecutionPhase;
  resultCode?: string;
}): Promise<{ handled: boolean }> {
  const grant = approved.get(input.requestId);
  if (!grant
      || grant.input.userId !== input.userId
      || grant.input.runtimeSessionId !== input.runtimeSessionId
      || grant.input.runtimeRequestId !== input.runtimeRequestId) {
    return { handled: false };
  }
  if (Date.now() >= grant.expiresAt) {
    approved.delete(input.requestId);
    clearTimeout(grant.timer);
    await appendAudit(grant.input, grant.requestId, 'expired', 'approval_expired_before_execution');
    return { handled: false };
  }
  if (input.phase === 'started') {
    if (grant.started) return { handled: false };
    grant.started = true;
    await appendAudit(grant.input, grant.requestId, 'execution_started');
    return { handled: true };
  }
  if (!grant.started) return { handled: false };
  approved.delete(input.requestId);
  clearTimeout(grant.timer);
  await appendAudit(grant.input, grant.requestId, input.phase === 'succeeded' ? 'execution_succeeded' : 'execution_failed', input.resultCode);
  return { handled: true };
}

export function _setActionApprovalBroadcastForTest(fn: ((channel: string, payload: unknown) => boolean | void) | null): void {
  broadcastOverride = fn;
}

export function _resetActionApprovalForTest(): void {
  for (const item of pending.values()) clearPending(item);
  for (const item of approved.values()) clearTimeout(item.timer);
  pending.clear();
  approved.clear();
  broadcastOverride = null;
}
