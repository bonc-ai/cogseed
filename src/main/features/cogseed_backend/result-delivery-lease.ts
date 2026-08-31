// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import { assertCogSeedUserId, cogseedResultDeliveryLeaseFile } from './paths';

const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_WAIT_MS = 0;

interface PersistedLease {
  schemaVersion: 1;
  token: string;
  pid: number;
  acquiredAt: string;
}

export interface CogSeedResultDeliveryLease {
  readonly executionId: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export interface AcquireCogSeedResultDeliveryLeaseOptions {
  staleAfterMs?: number;
  waitMs?: number;
  retryDelayMs?: number;
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function token(): string {
  return randomBytes(16).toString('hex');
}

function validateLease(value: unknown): PersistedLease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.token !== 'string' || !/^[a-f0-9]{32}$/.test(row.token)
    || typeof row.pid !== 'number' || !Number.isSafeInteger(row.pid) || row.pid <= 0
    || typeof row.acquiredAt !== 'string') return null;
  return row as unknown as PersistedLease;
}

async function readLease(file: string): Promise<{ lease: PersistedLease | null; mtimeMs: number } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { lease: validateLease(parsed), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, 'EPERM');
  }
}

async function removeIfStillOwned(file: string, expectedToken: string): Promise<boolean> {
  const current = await readLease(file);
  if (!current || current.lease?.token !== expectedToken) return false;
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function evictStaleLease(file: string, expectedToken: string | null): Promise<boolean> {
  const backup = `${file}.stale-${process.pid}-${token()}`;
  try {
    await fs.rename(file, backup);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
  const moved = await readLease(backup);
  if ((moved?.lease?.token ?? null) === expectedToken) {
    await fs.unlink(backup).catch(() => {});
    return true;
  }
  // Another contender replaced the stale inode between our read and rename.
  // Restore that live candidate only when the canonical name is still free;
  // its owner also verifies the token before every irreversible step.
  try { await fs.link(backup, file); } catch { /* a newer owner already won */ }
  await fs.unlink(backup).catch(() => {});
  return false;
}

async function tryAcquire(
  userId: string,
  executionId: string,
  staleAfterMs: number,
): Promise<CogSeedResultDeliveryLease | null> {
  const file = cogseedResultDeliveryLeaseFile(userId, executionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const owner: PersistedLease = {
    schemaVersion: 1,
    token: token(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
    const current = await readLease(file);
    if (!current) return null;
    const ageMs = Date.now() - current.mtimeMs;
    const live = current.lease && processIsAlive(current.lease.pid);
    if (ageMs <= staleAfterMs || live) return null;
    // Rename fences the exact stale inode. If a contender replaced it after
    // our read, `evictStaleLease` restores that candidate instead of deleting it.
    await evictStaleLease(file, current.lease?.token ?? null);
    return null;
  }

  let released = false;
  const heartbeatMs = Math.max(250, Math.floor(staleAfterMs / 3));
  const heartbeat = setInterval(() => {
    void readLease(file).then(async (current) => {
      if (!released && current?.lease?.token === owner.token) {
        const now = new Date();
        await fs.utimes(file, now, now).catch(() => {});
      }
    }).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    executionId,
    async assertOwned() {
      const current = await readLease(file);
      if (released || current?.lease?.token !== owner.token) {
        const reason = released ? 'released' : !current ? 'missing' : !current.lease ? 'malformed' : 'replaced';
        throw new Error(`CogSeed result delivery lease lost (${reason})`);
      }
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await removeIfStillOwned(file, owner.token);
    },
  };
}

export async function acquireCogSeedResultDeliveryLease(
  userId: string,
  executionId: string,
  options: AcquireCogSeedResultDeliveryLeaseOptions = {},
): Promise<CogSeedResultDeliveryLease | null> {
  assertCogSeedUserId(userId);
  const staleAfterMs = Math.max(100, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS);
  const retryDelayMs = Math.max(5, options.retryDelayMs ?? 20);
  const deadline = Date.now() + waitMs;
  do {
    const lease = await tryAcquire(userId, executionId, staleAfterMs);
    if (lease) return lease;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, Math.max(1, deadline - Date.now()))));
  } while (true);
}
