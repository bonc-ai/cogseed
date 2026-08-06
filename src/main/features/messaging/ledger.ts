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
  MessagingDeliveryLedgerFile,
  MessagingInboundLedgerFile,
} from './types';

const inboundLocks = new Map<string, Mutex>();
const deliveryLocks = new Map<string, Mutex>();
const pendingInbound = new Map<string, Set<string>>();
const pendingDeliveries = new Map<string, Set<string>>();
const EMPTY_INBOUND: MessagingInboundLedgerFile = { version: 1, entries: {} };
const EMPTY_DELIVERY: MessagingDeliveryLedgerFile = { version: 1, entries: {} };
const MAX_DELIVERY_TEXT_LENGTH = 12_000;
const MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH = 160;

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
  if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return { ...EMPTY_INBOUND };
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
  if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return { ...EMPTY_DELIVERY };
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
    // Old ledgers retained only a text hash. They cannot safely replay a
    // delivery after restart, so make their interrupted records terminal
    // instead of leaving an invisible permanent pending state.
    const replayable = !!text && !!idempotencyKey;
    const rawStatus = candidate.status;
    const status = (rawStatus === 'pending' || rawStatus === 'retry_pending') && !replayable
      ? 'failed'
      : rawStatus;
    entries[key] = {
      key,
      instanceId: String(candidate.instanceId || '').slice(0, 160),
      externalChatId: String(candidate.externalChatId || '').slice(0, 512),
      sourceMessageId: String(candidate.sourceMessageId || '').slice(0, 160),
      textHash: String(candidate.textHash || '').slice(0, 128),
      ...(text ? { text } : {}),
      ...(typeof candidate.replyToMessageId === 'string' && candidate.replyToMessageId.trim()
        ? { replyToMessageId: candidate.replyToMessageId.trim().slice(0, 512) }
        : {}),
      ...(typeof candidate.threadId === 'string' && candidate.threadId.trim()
        ? { threadId: candidate.threadId.trim().slice(0, 512) }
        : {}),
      ...(candidate.replyInThread === true ? { replyInThread: true } : {}),
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
    if (existing && (
      existing.status === 'accepted'
      || existing.status === 'rejected'
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
      text: existing?.text || text,
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
    return next;
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
    let cancelled = 0;
    for (const entry of Object.values(data.entries)) {
      if (entry.instanceId !== instanceId || (entry.status !== 'pending' && entry.status !== 'retry_pending')) continue;
      entry.status = 'cancelled';
      entry.error = boundedReason;
      delete entry.nextAttemptAt;
      entry.updatedAt = nowIso();
      clearPending(pendingDeliveries, uid, entry.key);
      cancelled += 1;
    }
    if (cancelled) await writeJson(userMessagingDeliveryLedgerFile(uid), data);
    return cancelled;
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
