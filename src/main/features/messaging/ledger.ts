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
    if (!candidate || typeof candidate.updatedAt !== 'string' || !['pending', 'sent', 'failed', 'cancelled'].includes(candidate.status)) continue;
    entries[key] = {
      key,
      instanceId: String(candidate.instanceId || '').slice(0, 160),
      externalChatId: String(candidate.externalChatId || '').slice(0, 512),
      sourceMessageId: String(candidate.sourceMessageId || '').slice(0, 160),
      textHash: String(candidate.textHash || '').slice(0, 128),
      status: candidate.status,
      ...(typeof candidate.externalDeliveryId === 'string' ? { externalDeliveryId: candidate.externalDeliveryId.slice(0, 512) } : {}),
      ...(typeof candidate.error === 'string' ? { error: candidate.error.slice(0, 500) } : {}),
      attempts: Number.isInteger(candidate.attempts) && candidate.attempts >= 0 ? candidate.attempts : 0,
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

export async function completeInbound(uid: string, key: string, patch: Pick<InboundLedgerEntry, 'status'> & Partial<Pick<InboundLedgerEntry, 'cid' | 'reason'>>): Promise<InboundLedgerEntry> {
  assertUserId(uid);
  boundedKey(key, 'inbound key');
  return getLock(inboundLocks, uid).runExclusive(async () => {
    const data = normalizeInbound(await readJson<Partial<MessagingInboundLedgerFile>>(userMessagingInboundLedgerFile(uid)));
    const current = data.entries[key] || { key, status: 'failed' as const, receivedAt: nowIso(), updatedAt: nowIso() };
    const next: InboundLedgerEntry = {
      ...current,
      status: patch.status,
      ...(patch.cid ? { cid: patch.cid } : {}),
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

export async function beginDelivery(uid: string, entry: Omit<DeliveryLedgerEntry, 'status' | 'attempts' | 'updatedAt'>): Promise<{ duplicate: boolean; entry: DeliveryLedgerEntry }> {
  assertUserId(uid);
  assertInstanceId(entry.instanceId);
  boundedKey(entry.key, 'delivery key');
  return getLock(deliveryLocks, uid).runExclusive(async () => {
    const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
    const existing = data.entries[entry.key];
    if (existing && (
      existing.status === 'sent'
      || existing.status === 'cancelled'
      || (existing.status === 'pending' && pendingContains(pendingDeliveries, uid, entry.key))
    )) {
      return { duplicate: true, entry: existing };
    }
    const next: DeliveryLedgerEntry = {
      ...entry,
      status: 'pending',
      attempts: (existing?.attempts || 0) + 1,
      updatedAt: nowIso(),
    };
    data.entries[entry.key] = next;
    await writeJson(userMessagingDeliveryLedgerFile(uid), data);
    markPending(pendingDeliveries, uid, entry.key);
    return { duplicate: false, entry: next };
  });
}

export async function finishDelivery(uid: string, key: string, patch: Pick<DeliveryLedgerEntry, 'status'> & Partial<Pick<DeliveryLedgerEntry, 'externalDeliveryId' | 'error'>>): Promise<DeliveryLedgerEntry> {
  assertUserId(uid);
  boundedKey(key, 'delivery key');
  return getLock(deliveryLocks, uid).runExclusive(async () => {
    const data = normalizeDelivery(await readJson<Partial<MessagingDeliveryLedgerFile>>(userMessagingDeliveryLedgerFile(uid)));
    const current = data.entries[key];
    if (!current) throw new Error('delivery ledger entry not found');
    const next: DeliveryLedgerEntry = {
      ...current,
      status: patch.status,
      ...(patch.externalDeliveryId ? { externalDeliveryId: patch.externalDeliveryId.slice(0, 512) } : {}),
      ...(patch.error ? { error: patch.error.slice(0, 500) } : {}),
      updatedAt: nowIso(),
    };
    data.entries[key] = next;
    await writeJson(userMessagingDeliveryLedgerFile(uid), data);
    clearPending(pendingDeliveries, uid, key);
    return next;
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
