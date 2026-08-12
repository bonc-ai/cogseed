import * as crypto from 'node:crypto';
import { Mutex } from 'async-mutex';

import { nowIso, readJson, safeId, writeJson } from '../../storage';
import {
  userMessagingDeliveryLedgerFile,
  userMessagingInboundLedgerFile,
} from '../../paths';
import type {
  DeliveryLedgerEntry,
  InboundLedgerEntry,
  JsonCompatibleValue,
  MessagingDeliveryLedgerFile,
  MessagingInboundLedgerFile,
} from './types';

const inboundLocks = new Map<string, Mutex>();
const deliveryLocks = new Map<string, Mutex>();
const pendingInbound = new Map<string, Set<string>>();
const pendingDeliveries = new Map<string, Set<string>>();
const MAX_DELIVERY_TEXT_LENGTH = 12_000;
const MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH = 160;
/** Card JSON replay cap: touchpoint cards are small, and the ledger is a
 * machine-private JSON file that restart recovery replays verbatim. */
const MAX_DELIVERY_CARD_JSON_LENGTH = 16_000;

/** Validated card payload kept for restart recovery; invalid or oversized
 * cards are dropped so a corrupt entry can never wedge a delivery. */
function normalizeDeliveryCard(raw: unknown): Record<string, JsonCompatibleValue> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return undefined;
  }
  if (!serialized || serialized.length > MAX_DELIVERY_CARD_JSON_LENGTH) return undefined;
  return raw as Record<string, JsonCompatibleValue>;
}

/** Terminal-state waiters keyed by `<uid>\0<delivery key>`. A waiter registers
 * only after a first non-terminal read, then re-reads; state changes between
 * the read and the registration are caught by that second read. */
const deliveryWaiters = new Map<string, Set<() => void>>();

function waiterKey(uid: string, key: string): string {
  return `${uid}\u0000${key}`;
}

function isTerminalDeliveryStatus(status: DeliveryLedgerEntry['status']): boolean {
  return status === 'sent' || status === 'failed' || status === 'cancelled';
}

function notifyDeliveryWaiters(uid: string, key: string): void {
  const listeners = deliveryWaiters.get(waiterKey(uid, key));
  if (!listeners) return;
  deliveryWaiters.delete(waiterKey(uid, key));
  for (const listener of listeners) listener();
}

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function assertInstanceId(instanceId: string): void {
  if (!safeId(instanceId)) throw new Error('invalid messaging instance id');
}

function getLock(map: Map<string, Mutex>, uid: string): Mutex {
  let lock = map.get(uid);
  if (!lock) {
    lock = new Mutex();
    map.set(uid, lock);
  }
  return lock;
}

function boundedKey(value: string, field: string): string {
  const key = value.trim();
  if (!key || key.length > 512 || key.includes('\0')) throw new Error(`invalid ${field}`);
  return key;
}

function pendingContains(entries: Map<string, Set<string>>, uid: string, key: string): boolean {
  return entries.get(uid)?.has(key) === true;
}

function markPending(entries: Map<string, Set<string>>, uid: string, key: string): void {
  let keys = entries.get(uid);
  if (!keys) {
    keys = new Set();
    entries.set(uid, keys);
  }
  keys.add(key);
}

function clearPending(entries: Map<string, Set<string>>, uid: string, key: string): void {
  const keys = entries.get(uid);
  if (!keys) return;
  keys.delete(key);
  if (!keys.size) entries.delete(uid);
}

function normalizeInbound(raw: Partial<MessagingInboundLedgerFile>): MessagingInboundLedgerFile {
  // Fresh containers on every fallback: spreading the shared EMPTY constant
  // keeps the same entries reference, leaking writes into later reads of
  // missing files (same class of bug as touchpoints ledger).
  if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return { version: 1, entries: {} };
  const entries: Record<string, InboundLedgerEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    const candidate = value as InboundLedgerEntry;
    if (!candidate || typeof candidate.updatedAt !== 'string' || !['pending', 'accepted', 'rejected', 'duplicate', 'failed'].includes(candidate.status)) continue;
    entries[key] = {
      key,
      status: candidate.status,
      ...(typeof candidate.cid === 'string' ? { cid: candidate.cid } : {}),
      ...(typeof candidate.internalMessageId === 'string' && candidate.internalMessageId.trim()
        ? { internalMessageId: candidate.internalMessageId.trim().slice(0, 160) }
        : {}),
      ...(typeof candidate.replyToMessageId === 'string' && candidate.replyToMessageId.trim()
        ? { replyToMessageId: candidate.replyToMessageId.trim().slice(0, 512) }
        : {}),
      ...(typeof candidate.threadId === 'string' && candidate.threadId.trim()
        ? { threadId: candidate.threadId.trim().slice(0, 512) }
        : {}),
      ...(candidate.replyInThread === true ? { replyInThread: true } : {}),
      ...(typeof candidate.reason === 'string' ? { reason: candidate.reason.slice(0, 300) } : {}),
      receivedAt: typeof candidate.receivedAt === 'string' ? candidate.receivedAt : candidate.updatedAt,
      updatedAt: candidate.updatedAt,
    };
  }
  return { version: 1, entries };
}

function normalizeDelivery(raw: Partial<MessagingDeliveryLedgerFile>): MessagingDeliveryLedgerFile {
  if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return { version: 1, entries: {} };
  const entries: Record<string, DeliveryLedgerEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    const candidate = value as DeliveryLedgerEntry;
    if (!candidate || typeof candidate.updatedAt !== 'string'
      || !['pending', 'retry_pending', 'sent', 'failed', 'cancelled'].includes(candidate.status)) continue;
    const text = typeof candidate.text === 'string' && candidate.text.trim()
      ? candidate.text.trim().slice(0, MAX_DELIVERY_TEXT_LENGTH)
      : undefined;
    const idempotencyKey = typeof candidate.idempotencyKey === 'string' && candidate.idempotencyKey.trim()
      ? candidate.idempotencyKey.trim().slice(0, MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH)
      : undefined;
    const card = normalizeDeliveryCard(candidate.card);
    // Old ledgers retained only a text hash. They cannot safely replay a
    // delivery after restart, so make their interrupted records terminal
    // instead of leaving an invisible permanent pending state.
    const replayable = !!text && !!idempotencyKey;
    const rawStatus = candidate.status;
    const status = (rawStatus === 'pending' || rawStatus === 'retry_pending') && !replayable
      ? 'failed'
      : rawStatus;
    const externalChatId = String(candidate.externalChatId || '').slice(0, 512);
    entries[key] = {
      key,
      instanceId: String(candidate.instanceId || '').slice(0, 160),
      // Legacy ledgers kept only an untyped chat id; default those recipients
      // to chat_id so restart recovery keeps the historical reply semantics.
      recipientId: String(candidate.recipientId || candidate.externalChatId || '').slice(0, 512),
      recipientIdType: candidate.recipientIdType === 'open_id' ? 'open_id' : 'chat_id',
      ...(externalChatId ? { externalChatId } : {}),
      sourceMessageId: String(candidate.sourceMessageId || '').slice(0, 160),
      textHash: String(candidate.textHash || '').slice(0, 128),
      ...(text ? { text } : {}),
      ...(card ? { card } : {}),
      ...(typeof candidate.replyToMessageId === 'string' && candidate.replyToMessageId.trim()
        ? { replyToMessageId: candidate.replyToMessageId.trim().slice(0, 512) }
        : {}),
      ...(typeof candidate.threadId === 'string' && candidate.threadId.trim()
        ? { threadId: candidate.threadId.trim().slice(0, 512) }
        : {}),
      ...(candidate.replyInThread === true ? { replyInThread: true } : {}),
      ...(typeof candidate.contextTokenRef === 'string' && candidate.contextTokenRef.trim()
        ? { contextTokenRef: candidate.contextTokenRef.trim().slice(0, 512) }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      status,
      ...(typeof candidate.externalDeliveryId === 'string' ? { externalDeliveryId: candidate.externalDeliveryId.slice(0, 512) } : {}),
      ...(typeof candidate.error === 'string'
        ? { error: candidate.error.slice(0, 500) }
        : status === 'failed' && !replayable && (rawStatus === 'pending' || rawStatus === 'retry_pending')
          ? { error: 'legacy delivery payload unavailable for recovery' }
          : {}),
      attempts: Number.isInteger(candidate.attempts) && candidate.attempts >= 0 ? candidate.attempts : 0,
      ...(status === 'retry_pending' && typeof candidate.nextAttemptAt === 'string' && candidate.nextAttemptAt.trim()
        ? { nextAttemptAt: candidate.nextAttemptAt.trim().slice(0, 80) }
        : {}),
      updatedAt: candidate.updatedAt,
    };
  }
  return { version: 1, entries };
}

export function inboundKey(instanceId: string, externalMessageId: string): string {
  assertInstanceId(instanceId);
  return `${instanceId}:${boundedKey(externalMessageId, 'external message id')}`;
}

export function deliveryKey(instanceId: string, sourceMessageId: string): string {
  assertInstanceId(instanceId);
  return `${instanceId}:${boundedKey(sourceMessageId, 'source message id')}`;
}

export function textHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function readInbound(uid: string, key: string): Promise<InboundLedgerEntry | null> {
  assertUserId(uid);
  boundedKey(key, 'inbound key');
  const data = normalizeInbound(await readJson<Partial<MessagingInboundLedgerFile>>(userMessagingInboundLedgerFile(uid)));
  return data.entries[key] || null;
}

export async function reserveInbound(uid: string, key: string, receivedAt = nowIso()): Promise<{ duplicate: boolean; entry: InboundLedgerEntry }> {
  assertUserId(uid);
  boundedKey(key, 'inbound key');
  return getLock(inboundLocks, uid).runExclusive(async () => {
    const data = normalizeInbound(await readJson<Partial<MessagingInboundLedgerFile>>(userMessagingInboundLedgerFile(uid)));
    const existing = data.entries[key];
    // A duplicate entry is an inbound message already consumed (e.g. its id was
    // marked seen when the burst merger swallowed it into a later batch), so a
    // redelivery of the same platform message id must keep being rejected
    // instead of being dispatched again.
    if (existing && (
      existing.status === 'accepted'
      || existing.status === 'rejected'
      || existing.status === 'duplicate'
      || (existing.status === 'pending' && pendingContains(pendingInbound, uid, key))
    )) {
      return { duplicate: true, entry: { ...existing, status: 'duplicate', updatedAt: nowIso() } };
    }
    const entry: InboundLedgerEntry = { key, status: 'pending', receivedAt, updatedAt: nowIso() };
    data.entries[key] = entry;
    await writeJson(userMessagingInboundLedgerFile(uid), data);
    markPending(pendingInbound, uid, key);
    return { duplicate: false, entry };
  });
}

export async function completeInbound(
  uid: string,
  key: string,
  patch: Pick<InboundLedgerEntry, 'status'> & Partial<Pick<InboundLedgerEntry, 'cid' | 'internalMessageId' | 'replyToMessageId' | 'threadId' | 'replyInThread' | 'reason'>>,
): Promise<InboundLedgerEntry> {
  assertUserId(uid);
  boundedKey(key, 'inbound key');
  return getLock(inboundLocks, uid).runExclusive(async () => {
    const data = normalizeInbound(await readJson<Partial<MessagingInboundLedgerFile>>(userMessagingInboundLedgerFile(uid)));
    const current = data.entries[key] || { key, status: 'failed' as const, receivedAt: nowIso(), updatedAt: nowIso() };
    const next: InboundLedgerEntry = {
      ...current,
      status: patch.status,
      ...(patch.cid ? { cid: patch.cid } : {}),
      ...(patch.internalMessageId ? { internalMessageId: patch.internalMessageId.slice(0, 160) } : {}),
      ...(patch.replyToMessageId ? { replyToMessageId: patch.replyToMessageId.slice(0, 512) } : {}),
      ...(patch.threadId ? { threadId: patch.threadId.slice(0, 512) } : {}),
      ...(patch.replyInThread === true ? { replyInThread: true } : {}),
      ...(patch.reason ? { reason: patch.reason.slice(0, 300) } : {}),
      updatedAt: nowIso(),
    };
    data.entries[key] = next;
    await writeJson(userMessagingInboundLedgerFile(uid), data);
    clearPending(pendingInbound, uid, key);
    return next;
  });
}

export async function getDelivery(uid: string, key: string): Promise<DeliveryLedgerEntry | null> {
  assertUserId(uid);
  boundedKey(key, 'delivery key');
  const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
  return data.entries[key] || null;
}

/** Reverse lookup of a delivered message by its platform delivery id.
 * Reaction events carry the outbound message id without any chat context;
 * this resolves the owning delivery (and its chat) locally so a reaction on
 * a message we never sent is simply ignored. The ledger keeps terminal
 * entries, so the match survives the delivery being finished long ago. */
export async function getDeliveryByExternalId(
  uid: string,
  instanceId: string,
  externalDeliveryId: string,
): Promise<DeliveryLedgerEntry | null> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const id = externalDeliveryId.trim();
  if (!id || id.length > 512) return null;
  const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
  for (const entry of Object.values(data.entries)) {
    if (entry.instanceId === instanceId && entry.externalDeliveryId === id) return entry;
  }
  return null;
}

export async function beginDelivery(
  uid: string,
  entry: Omit<DeliveryLedgerEntry, 'status' | 'attempts' | 'updatedAt' | 'nextAttemptAt' | 'idempotencyKey'> & {
    idempotencyKey?: string;
  },
): Promise<{ duplicate: boolean; entry: DeliveryLedgerEntry }> {
  assertUserId(uid);
  assertInstanceId(entry.instanceId);
  boundedKey(entry.key, 'delivery key');
  const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, MAX_DELIVERY_TEXT_LENGTH) : '';
  if (!text) throw new Error('delivery text required for recovery');
  const card = entry.card === undefined ? undefined : normalizeDeliveryCard(entry.card);
  if (entry.card !== undefined && !card) throw new Error('delivery card payload invalid');
  const recipientId = typeof entry.recipientId === 'string' && entry.recipientId.trim()
    ? entry.recipientId.trim().slice(0, 512)
    : typeof entry.externalChatId === 'string'
      ? entry.externalChatId.trim().slice(0, 512)
      : '';
  if (!recipientId) throw new Error('delivery recipient required for recovery');
  const recipientIdType = entry.recipientIdType === 'open_id' ? 'open_id' : 'chat_id';
  return getLock(deliveryLocks, uid).runExclusive(async () => {
    const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
    const existing = data.entries[entry.key];
    const now = Date.now();
    const retryDueAt = existing?.nextAttemptAt ? Date.parse(existing.nextAttemptAt) : Number.NaN;
    if (existing && (existing.status === 'sent'
      || existing.status === 'cancelled'
      || existing.status === 'failed'
      || (existing.status === 'pending' && pendingContains(pendingDeliveries, uid, entry.key))
      || (existing.status === 'retry_pending' && Number.isFinite(retryDueAt) && retryDueAt > now))) {
      return { duplicate: true, entry: existing };
    }
    if (existing && existing.textHash !== entry.textHash) {
      throw new Error('delivery payload hash does not match existing outbox entry');
    }
    const next: DeliveryLedgerEntry = {
      ...(existing || entry),
      recipientId,
      recipientIdType,
      text: existing?.text || text,
      card: existing?.card || card,
      idempotencyKey: existing?.idempotencyKey
        || (typeof entry.idempotencyKey === 'string' && entry.idempotencyKey.trim()
          ? entry.idempotencyKey.trim().slice(0, MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH)
          : crypto.randomUUID()),
      status: 'pending',
      attempts: (existing?.attempts || 0) + 1,
      updatedAt: nowIso(),
    };
    delete next.nextAttemptAt;
    delete next.error;
    data.entries[entry.key] = next;
    await writeJson(userMessagingDeliveryLedgerFile(uid), data);
    markPending(pendingDeliveries, uid, entry.key);
    return { duplicate: false, entry: next };
  });
}

export async function finishDelivery(
  uid: string,
  key: string,
  patch: Pick<DeliveryLedgerEntry, 'status'> & Partial<Pick<DeliveryLedgerEntry, 'externalDeliveryId' | 'error' | 'nextAttemptAt'>>,
): Promise<DeliveryLedgerEntry> {
  assertUserId(uid);
  boundedKey(key, 'delivery key');
  return getLock(deliveryLocks, uid).runExclusive(async () => {
    const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
    const current = data.entries[key];
    if (!current) throw new Error('delivery ledger entry not found');
    if (current.status === 'cancelled' && patch.status !== 'cancelled') {
      clearPending(pendingDeliveries, uid, key);
      return current;
    }
    const nextAttemptAt = patch.status === 'retry_pending' && typeof patch.nextAttemptAt === 'string'
      && Number.isFinite(Date.parse(patch.nextAttemptAt))
      ? patch.nextAttemptAt
      : undefined;
    const next: DeliveryLedgerEntry = {
      ...current,
      status: patch.status,
      ...(patch.externalDeliveryId ? { externalDeliveryId: patch.externalDeliveryId.slice(0, 512) } : {}),
      ...(patch.error ? { error: patch.error.slice(0, 500) } : {}),
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
      updatedAt: nowIso(),
    };
    data.entries[key] = next;
    await writeJson(userMessagingDeliveryLedgerFile(uid), data);
    clearPending(pendingDeliveries, uid, key);
    if (isTerminalDeliveryStatus(next.status)) notifyDeliveryWaiters(uid, key);
    return next;
  });
}

/** Wait for a delivery to reach a terminal state (`sent`, `failed`, or
 * `cancelled`). Resolves with the terminal ledger entry. The caller aborts
 * (AbortSignal) or times out by cancelling the delivery through
 * `cancelDelivery`; the wait itself never mutates the ledger. */
export async function waitForDeliveryTerminal(
  uid: string,
  key: string,
  opts: { signal?: AbortSignal | null; timeoutMs?: number } = {},
): Promise<DeliveryLedgerEntry> {
  assertUserId(uid);
  boundedKey(key, 'delivery key');
  const waitKey = waiterKey(uid, key);
  return new Promise<DeliveryLedgerEntry>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort as EventListener);
      const listeners = deliveryWaiters.get(waitKey);
      if (listeners) {
        listeners.delete(listener);
        if (!listeners.size) deliveryWaiters.delete(waitKey);
      }
      fn();
    };
    const onAbort = (): void => settle(() => reject(new Error('delivery wait aborted')));
    const resolveTerminal = (entry: DeliveryLedgerEntry | null): void => {
      if (settled) return;
      if (!entry) {
        settle(() => reject(new Error('delivery ledger entry not found')));
        return;
      }
      if (isTerminalDeliveryStatus(entry.status)) settle(() => resolve(entry));
    };
    const listener = (): void => {
      void getDelivery(uid, key).then(resolveTerminal, (error) => settle(() => reject(error)));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        settle(() => reject(new Error('delivery wait aborted')));
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)) {
      timer = setTimeout(() => settle(() => reject(new Error('delivery wait timed out'))), Math.max(0, opts.timeoutMs));
      if (typeof timer.unref === 'function') timer.unref();
    }
    void getDelivery(uid, key).then((entry) => {
      if (settled) return;
      if (!entry || isTerminalDeliveryStatus(entry.status)) {
        resolveTerminal(entry);
        return;
      }
      // Register after the first read, then re-read: a finish that happened
      // between the read and the registration is caught by the second read.
      let listeners = deliveryWaiters.get(waitKey);
      if (!listeners) {
        listeners = new Set();
        deliveryWaiters.set(waitKey, listeners);
      }
      listeners.add(listener);
      void getDelivery(uid, key).then(resolveTerminal, (error) => settle(() => reject(error)));
    }, (error) => settle(() => reject(error)));
  });
}

/** Cancel exactly one recoverable delivery. Terminal and unknown deliveries
 * return false. Wakes any waiter on the same key. */
export async function cancelDelivery(uid: string, key: string, reason: string): Promise<boolean> {
  assertUserId(uid);
  boundedKey(key, 'delivery key');
  const boundedReason = reason.trim().slice(0, 500) || 'delivery cancelled';
  return getLock(deliveryLocks, uid).runExclusive(async () => {
    const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
    const current = data.entries[key];
    if (!current || (current.status !== 'pending' && current.status !== 'retry_pending')) return false;
    current.status = 'cancelled';
    current.error = boundedReason;
    delete current.nextAttemptAt;
    current.updatedAt = nowIso();
    clearPending(pendingDeliveries, uid, key);
    await writeJson(userMessagingDeliveryLedgerFile(uid), data);
    notifyDeliveryWaiters(uid, key);
    return true;
  });
}

export async function listRecoverableDeliveries(uid: string, instanceId: string, now = Date.now()): Promise<DeliveryLedgerEntry[]> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
  return Object.values(data.entries)
    .filter((entry) => {
      if (entry.instanceId !== instanceId || pendingContains(pendingDeliveries, uid, entry.key)) return false;
      if (entry.status === 'pending') return !!entry.text && !!entry.idempotencyKey;
      if (entry.status !== 'retry_pending' || !entry.text || !entry.idempotencyKey) return false;
      const retryAt = entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : Number.NaN;
      return !Number.isFinite(retryAt) || retryAt <= now;
    })
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export async function nextRecoverableDeliveryAt(uid: string, instanceId: string): Promise<number | null> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
  let next: number | null = null;
  for (const entry of Object.values(data.entries)) {
    if (entry.instanceId !== instanceId || pendingContains(pendingDeliveries, uid, entry.key)) continue;
    if (entry.status === 'pending' && entry.text && entry.idempotencyKey) return Date.now();
    if (entry.status !== 'retry_pending' || !entry.text || !entry.idempotencyKey) continue;
    const retryAt = entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : Number.NaN;
    const candidate = Number.isFinite(retryAt) ? retryAt : Date.now();
    if (next === null || candidate < next) next = candidate;
  }
  return next;
}

export async function cancelRecoverableDeliveriesForInstance(uid: string, instanceId: string, reason: string): Promise<number> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const boundedReason = reason.trim().slice(0, 500) || 'delivery cancelled';
  return getLock(deliveryLocks, uid).runExclusive(async () => {
    const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
    const cancelledKeys: string[] = [];
    for (const entry of Object.values(data.entries)) {
      if (entry.instanceId !== instanceId || (entry.status !== 'pending' && entry.status !== 'retry_pending')) continue;
      entry.status = 'cancelled';
      entry.error = boundedReason;
      delete entry.nextAttemptAt;
      entry.updatedAt = nowIso();
      clearPending(pendingDeliveries, uid, entry.key);
      cancelledKeys.push(entry.key);
    }
    if (cancelledKeys.length) {
      await writeJson(userMessagingDeliveryLedgerFile(uid), data);
      for (const key of cancelledKeys) notifyDeliveryWaiters(uid, key);
    }
    return cancelledKeys.length;
  });
}

async function removeInboundEntriesForInstance(uid: string, instanceId: string): Promise<number> {
  return getLock(inboundLocks, uid).runExclusive(async () => {
    const data = normalizeInbound(await readJson<Partial<MessagingInboundLedgerFile>>(userMessagingInboundLedgerFile(uid)));
    const prefix = `${instanceId}:`;
    const keys = Object.keys(data.entries).filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      delete data.entries[key];
      clearPending(pendingInbound, uid, key);
    }
    if (keys.length) await writeJson(userMessagingInboundLedgerFile(uid), data);
    return keys.length;
  });
}

async function removeDeliveryEntriesForInstance(uid: string, instanceId: string): Promise<number> {
  return getLock(deliveryLocks, uid).runExclusive(async () => {
    const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
    const keys = Object.entries(data.entries)
      .filter(([, entry]) => entry.instanceId === instanceId)
      .map(([key]) => key);
    for (const key of keys) {
      delete data.entries[key];
      clearPending(pendingDeliveries, uid, key);
    }
    if (keys.length) await writeJson(userMessagingDeliveryLedgerFile(uid), data);
    return keys.length;
  });
}

export async function removeEntriesForInstance(uid: string, instanceId: string): Promise<{ inbound: number; delivery: number }> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const [inbound, delivery] = await Promise.all([
    removeInboundEntriesForInstance(uid, instanceId),
    removeDeliveryEntriesForInstance(uid, instanceId),
  ]);
  return { inbound, delivery };
}

export const _ledgerTestHooks = { normalizeInbound, normalizeDelivery };
