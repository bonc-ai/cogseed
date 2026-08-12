import * as crypto from 'node:crypto';
import { Mutex } from 'async-mutex';

import { readJson, safeId, writeJson } from '../../storage';
import { userTouchpointLedgerFile } from '../../paths';
import { TouchpointContractError } from './errors';
import { validateTouchpointActionEnvelope } from './intents';
import type {
  TouchpointActionContract,
  TouchpointActionEnvelopeInput,
  TouchpointActionRecord,
  TouchpointIntent,
  TouchpointIntentStatus,
  TouchpointLedgerFile,
} from './types';

const locks = new Map<string, Mutex>();
const TERMINAL_STATUSES = new Set<TouchpointIntentStatus>(['sent', 'failed', 'expired', 'cancelled', 'suppressed']);
function timestampIso(): string {
  return new Date().toISOString();
}

const VALID_TRANSITIONS: Readonly<Record<TouchpointIntentStatus, readonly TouchpointIntentStatus[]>> = {
  planned: ['ready', 'suppressed', 'cancelled', 'expired'],
  ready: ['sending', 'suppressed', 'cancelled', 'expired'],
  sending: ['sent', 'retry_pending', 'failed', 'cancelled'],
  retry_pending: ['sending', 'failed', 'cancelled', 'expired'],
  sent: [],
  failed: ['retry_pending', 'cancelled'],
  expired: [],
  cancelled: [],
  suppressed: [],
};

function assertUserId(userId: string): void {
  if (!safeId(userId)) throw new TouchpointContractError('invalid_user_id', 'Touchpoint user id is invalid.', 'userId');
}

function getLock(userId: string): Mutex {
  let lock = locks.get(userId);
  if (!lock) {
    lock = new Mutex();
    locks.set(userId, lock);
  }
  return lock;
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function normalizeContractInput(raw: unknown): TouchpointActionContract['input'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as { label?: unknown; placeholder?: unknown; required?: unknown };
  const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim().slice(0, 120) : '';
  if (!label) return undefined;
  const placeholder = typeof candidate.placeholder === 'string' && candidate.placeholder.trim()
    ? candidate.placeholder.trim().slice(0, 120)
    : undefined;
  return {
    label,
    ...(placeholder ? { placeholder } : {}),
    ...(candidate.required === true ? { required: true } : {}),
  };
}

function normalizeIntent(raw: unknown): TouchpointIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<TouchpointIntent>;
  if (candidate.version !== 1 || typeof candidate.intentId !== 'string' || typeof candidate.userId !== 'string'
    || typeof candidate.eventId !== 'string' || !candidate.subject || typeof candidate.subject.type !== 'string'
    || typeof candidate.subject.id !== 'string' || !candidate.content || typeof candidate.content.title !== 'string'
    || typeof candidate.channel !== 'string' || typeof candidate.template !== 'string'
    || typeof candidate.priority !== 'string' || typeof candidate.availableFrom !== 'string' || typeof candidate.expiresAt !== 'string'
    || typeof candidate.dedupeKey !== 'string' || typeof candidate.status !== 'string'
    || typeof candidate.createdAt !== 'string' || typeof candidate.updatedAt !== 'string') return null;
  if (!safeId(candidate.userId) || !safeId(candidate.intentId) || !safeId(candidate.eventId)) return null;
  if (!Number.isFinite(Date.parse(candidate.availableFrom)) || !Number.isFinite(Date.parse(candidate.expiresAt))) return null;
  if (!Number.isFinite(Date.parse(candidate.createdAt)) || !Number.isFinite(Date.parse(candidate.updatedAt))) return null;
  if (!Number.isInteger(candidate.attempts) || candidate.attempts < 0 || candidate.attempts > 1000) return null;
  if (!['feishu'].includes(candidate.channel) || !['daily_briefing', 'ontology_confirmation', 'task_approval', 'task_result', 'task_failure', 'deadline_risk', 'calendar_conflict', 'binding_status'].includes(candidate.template)) return null;
  if (!['low', 'normal', 'high', 'urgent'].includes(candidate.priority)) return null;
  if (!['planned', 'ready', 'suppressed', 'sending', 'sent', 'retry_pending', 'failed', 'expired', 'cancelled'].includes(candidate.status)) return null;
  const contractInput = candidate.actionContract?.input === undefined ? undefined : normalizeContractInput(candidate.actionContract.input);
  const actionContract = candidate.actionContract && candidate.actionContract.version === 1 && Array.isArray(candidate.actionContract.allowedActions)
    ? {
      version: 1 as const,
      allowedActions: [...candidate.actionContract.allowedActions],
      ...(contractInput ? { input: contractInput } : {}),
    }
    : undefined;
  return {
    version: 1,
    intentId: candidate.intentId,
    userId: candidate.userId,
    eventId: candidate.eventId,
    subject: { type: candidate.subject.type, id: candidate.subject.id },
    content: { title: candidate.content.title, ...(candidate.content.body ? { body: candidate.content.body } : {}) },
    ...(typeof candidate.contextRef === 'string' ? { contextRef: candidate.contextRef } : {}),
    channel: candidate.channel as TouchpointIntent['channel'],
    template: candidate.template as TouchpointIntent['template'],
    priority: candidate.priority as TouchpointIntent['priority'],
    availableFrom: new Date(Date.parse(candidate.availableFrom)).toISOString(),
    expiresAt: new Date(Date.parse(candidate.expiresAt)).toISOString(),
    dedupeKey: candidate.dedupeKey,
    requiresAction: candidate.requiresAction === true,
    ...(actionContract ? { actionContract } : {}),
    status: candidate.status as TouchpointIntentStatus,
    createdAt: new Date(Date.parse(candidate.createdAt)).toISOString(),
    updatedAt: new Date(Date.parse(candidate.updatedAt)).toISOString(),
    attempts: candidate.attempts,
    ...(normalizeText(candidate.externalDeliveryId, 512) ? { externalDeliveryId: normalizeText(candidate.externalDeliveryId, 512) } : {}),
    ...(normalizeText(candidate.error, 500) ? { error: normalizeText(candidate.error, 500) } : {}),
    ...(typeof candidate.nextAttemptAt === 'string' && Number.isFinite(Date.parse(candidate.nextAttemptAt))
      ? { nextAttemptAt: new Date(Date.parse(candidate.nextAttemptAt)).toISOString() }
      : {}),
  };
}

function normalizeAction(raw: unknown): TouchpointActionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<TouchpointActionRecord>;
  if (candidate.version !== 1 || typeof candidate.actionId !== 'string' || typeof candidate.intentId !== 'string'
    || typeof candidate.userId !== 'string' || typeof candidate.action !== 'string' || typeof candidate.occurredAt !== 'string'
    || typeof candidate.signatureHash !== 'string' || typeof candidate.consumedAt !== 'string') return null;
  if (!safeId(candidate.userId) || !safeId(candidate.actionId) || !safeId(candidate.intentId)) return null;
  if (!/^[0-9a-f]{64}$/.test(candidate.signatureHash)) return null;
  if (!Number.isFinite(Date.parse(candidate.occurredAt)) || !Number.isFinite(Date.parse(candidate.consumedAt))) return null;
  const content = normalizeText(candidate.content, 2_000);
  return {
    version: 1,
    actionId: candidate.actionId,
    intentId: candidate.intentId,
    userId: candidate.userId,
    action: candidate.action as TouchpointActionRecord['action'],
    occurredAt: new Date(Date.parse(candidate.occurredAt)).toISOString(),
    signatureHash: candidate.signatureHash,
    consumedAt: new Date(Date.parse(candidate.consumedAt)).toISOString(),
    ...(content ? { content } : {}),
  };
}

function normalizeLedger(raw: unknown): TouchpointLedgerFile {
  // Fresh containers on every fallback: the empty ledger is a shared module
  // constant, and spreading it keeps the same intents/actions references —
  // a reserved intent would then leak into later reads of missing files.
  if (!raw || typeof raw !== 'object') return { version: 1, intents: {}, actions: {} };
  const candidate = raw as Partial<TouchpointLedgerFile>;
  if (candidate.version !== 1 || !candidate.intents || typeof candidate.intents !== 'object' || !candidate.actions || typeof candidate.actions !== 'object') {
    return { version: 1, intents: {}, actions: {} };
  }
  const intents: Record<string, TouchpointIntent> = {};
  for (const [key, value] of Object.entries(candidate.intents)) {
    const normalized = normalizeIntent(value);
    if (normalized && normalized.intentId === key) intents[key] = normalized;
  }
  const actions: Record<string, TouchpointActionRecord> = {};
  for (const [key, value] of Object.entries(candidate.actions)) {
    const normalized = normalizeAction(value);
    if (normalized && normalized.actionId === key) actions[key] = normalized;
  }
  return { version: 1, intents, actions };
}

async function withLedger<T>(userId: string, callback: (ledger: TouchpointLedgerFile) => Promise<T>): Promise<T> {
  assertUserId(userId);
  return getLock(userId).runExclusive(async () => {
    const ledger = normalizeLedger(await readJson(userTouchpointLedgerFile(userId)));
    const result = await callback(ledger);
    await writeJson(userTouchpointLedgerFile(userId), ledger);
    return result;
  });
}

function isActive(intent: TouchpointIntent): boolean {
  return !TERMINAL_STATUSES.has(intent.status);
}

export async function reserveTouchpointIntent(
  userId: string,
  intent: TouchpointIntent,
): Promise<{ created: boolean; intent: TouchpointIntent }> {
  assertUserId(userId);
  if (intent.userId !== userId) throw new TouchpointContractError('user_mismatch', 'Touchpoint intent belongs to another user.', 'intent.userId');
  return withLedger(userId, async (ledger) => {
    const existing = Object.values(ledger.intents).find((candidate) => candidate.userId === userId
      && candidate.dedupeKey === intent.dedupeKey && isActive(candidate));
    if (existing) return { created: false, intent: existing };
    const sameId = ledger.intents[intent.intentId];
    if (sameId && sameId.dedupeKey !== intent.dedupeKey) {
      throw new TouchpointContractError('invalid_identifier', 'Touchpoint intent id is already used by another intent.', 'intentId');
    }
    ledger.intents[intent.intentId] = { ...intent, attempts: intent.attempts ?? 0, updatedAt: timestampIso() };
    return { created: true, intent: ledger.intents[intent.intentId] };
  });
}

export async function getTouchpointIntent(userId: string, intentId: string): Promise<TouchpointIntent | null> {
  assertUserId(userId);
  if (!safeId(intentId)) throw new TouchpointContractError('invalid_identifier', 'Touchpoint intent id is invalid.', 'intentId');
  const ledger = normalizeLedger(await readJson(userTouchpointLedgerFile(userId)));
  const intent = ledger.intents[intentId];
  return intent?.userId === userId ? intent : null;
}

export async function listTouchpointIntents(userId: string): Promise<TouchpointIntent[]> {
  assertUserId(userId);
  const ledger = normalizeLedger(await readJson(userTouchpointLedgerFile(userId)));
  return Object.values(ledger.intents)
    .filter((intent) => intent.userId === userId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || right.intentId.localeCompare(left.intentId));
}

export async function transitionTouchpointIntent(
  userId: string,
  intentId: string,
  expectedStatuses: readonly TouchpointIntentStatus[],
  patch: {
    status: TouchpointIntentStatus;
    externalDeliveryId?: string;
    error?: string;
    nextAttemptAt?: string;
  },
): Promise<TouchpointIntent> {
  assertUserId(userId);
  if (!safeId(intentId)) throw new TouchpointContractError('invalid_identifier', 'Touchpoint intent id is invalid.', 'intentId');
  return withLedger(userId, async (ledger) => {
    const intent = ledger.intents[intentId];
    if (!intent || intent.userId !== userId) throw new TouchpointContractError('intent_not_found', 'Touchpoint intent was not found.', 'intentId');
    if (!expectedStatuses.includes(intent.status)) {
      throw new TouchpointContractError('invalid_status_transition', `Touchpoint intent is ${intent.status}, not an expected state.`, 'status');
    }
    if (!VALID_TRANSITIONS[intent.status].includes(patch.status)) {
      throw new TouchpointContractError('invalid_status_transition', `Touchpoint intent cannot move from ${intent.status} to ${patch.status}.`, 'status');
    }
    const nextAttemptAt = patch.nextAttemptAt === undefined ? undefined : new Date(Date.parse(patch.nextAttemptAt));
    if (patch.nextAttemptAt !== undefined && !Number.isFinite(nextAttemptAt.getTime())) {
      throw new TouchpointContractError('invalid_timestamp', 'Touchpoint next attempt time is invalid.', 'nextAttemptAt');
    }
    const updated: TouchpointIntent = {
      ...intent,
      status: patch.status,
      attempts: intent.attempts + (patch.status === 'sending' ? 1 : 0),
      ...(patch.externalDeliveryId ? { externalDeliveryId: patch.externalDeliveryId.slice(0, 512) } : {}),
      ...(patch.error ? { error: patch.error.slice(0, 500) } : {}),
      ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}),
      updatedAt: timestampIso(),
    };
    ledger.intents[intentId] = updated;
    return updated;
  });
}

export async function consumeTouchpointAction(
  userId: string,
  input: TouchpointActionEnvelopeInput,
  now = new Date(),
): Promise<{ duplicate: boolean; action: TouchpointActionRecord }> {
  assertUserId(userId);
  if (!safeId(input.intentId)) throw new TouchpointContractError('intent_not_found', 'Touchpoint intent was not found.', 'intentId');
  return withLedger(userId, async (ledger) => {
    const intent = ledger.intents[input.intentId];
    if (!intent || intent.userId !== userId) throw new TouchpointContractError('intent_not_found', 'Touchpoint intent was not found.', 'intentId');
    if (intent.status !== 'sent') throw new TouchpointContractError('intent_not_actionable', 'Touchpoint intent is not actionable.', 'status');
    const existing = ledger.actions[input.actionId];
    if (existing) return { duplicate: true, action: existing };
    const action = validateTouchpointActionEnvelope(userId, intent, input, now);
    const signatureHash = crypto.createHash('sha256').update(action.signature, 'utf8').digest('hex');
    const record: TouchpointActionRecord = {
      version: 1,
      actionId: action.actionId,
      intentId: action.intentId,
      userId: action.userId,
      action: action.action,
      occurredAt: action.occurredAt,
      signatureHash,
      consumedAt: now.toISOString(),
      ...(action.content ? { content: action.content } : {}),
    };
    ledger.actions[record.actionId] = record;
    return { duplicate: false, action: record };
  });
}

export async function readTouchpointLedgerForTest(userId: string): Promise<TouchpointLedgerFile> {
  assertUserId(userId);
  return normalizeLedger(await readJson(userTouchpointLedgerFile(userId)));
}
