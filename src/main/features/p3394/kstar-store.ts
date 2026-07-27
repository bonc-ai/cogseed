/**
 * kstar-store.ts — User-isolated KSTAR state persistence
 *
 * Provides atomic snapshot write/read with .previous backup, append-only
 * pending evidence log with compact, and archive list/read. All operations
 * are per-user and serialized via async-mutex.
 *
 * Layout:
 *   <uid>/local/kstar/
 *     snapshot.json           — current opaque Engine state
 *     snapshot.json.previous  — last snapshot before current write
 *     pending-evidence.jsonl  — append-only log, folded by compact
 *     archives/
 *       2026-07-26T10-00-00.json
 *       2026-07-25T15-30-00.json
 *       ...
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import { createLogger } from '../../logger';

const log = createLogger('p3394.kstar-store');

// Resolve the workspace root at call time. Tests and multi-user startup can
// change the active root after module load, so never cache it here.
function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}

const userLocalRoot = (uid: string) => path.join(workspaceRoot(), uid, 'local');
const userKstarDir = (uid: string) => path.join(userLocalRoot(uid), 'kstar');
const kstarArchivesDir = (uid: string) => path.join(userKstarDir(uid), 'archives');

export function getKstarSnapshotPath(uid: string): string {
  return path.join(userKstarDir(uid), 'snapshot.json');
}

export function getPendingEvidencePath(uid: string): string {
  return path.join(userKstarDir(uid), 'pending-evidence.jsonl');
}

// Per-user mutex for atomic operations
const userMutexes = new Map<string, Mutex>();

function getUserMutex(uid: string): Mutex {
  let mutex = userMutexes.get(uid);
  if (!mutex) {
    mutex = new Mutex();
    userMutexes.set(uid, mutex);
  }
  return mutex;
}

// ── Snapshot operations ─────────────────────────────────────────────────

/**
 * Atomically write KSTAR snapshot with .previous backup.
 *
 * First write creates snapshot.json. Second write backs up current to
 * snapshot.json.previous, then writes new snapshot.json. Third+ writes
 * overwrite .previous with the old current before writing new current.
 */
export async function writeKstarSnapshot(
  uid: string,
  snapshot: unknown,
): Promise<void> {
  const mutex = getUserMutex(uid);
  await mutex.runExclusive(async () => {
    const dir = userKstarDir(uid);
    await fs.mkdir(dir, { recursive: true });

    const snapshotPath = getKstarSnapshotPath(uid);
    const previousPath = snapshotPath + '.previous';
    const tmpPath = snapshotPath + `.${process.pid}.${Date.now()}.tmp`;

    try {
      // Check if current snapshot exists
      const currentExists = await fs
        .access(snapshotPath)
        .then(() => true)
        .catch(() => false);

      // If current exists, back it up to .previous
      if (currentExists) {
        try {
          await fs.copyFile(snapshotPath, previousPath);
        } catch (err) {
          log.warn('failed to backup snapshot', { uid, error: (err as Error).message });
        }
      }

      // Write new snapshot atomically
      await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
      await fs.rename(tmpPath, snapshotPath);

      log.info('wrote kstar snapshot', { uid, hasBackup: currentExists });
    } catch (err) {
      // Clean up tmp file if rename failed
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  });
}

/**
 * Read current KSTAR snapshot or return null if missing.
 */
export async function readKstarSnapshot(uid: string): Promise<unknown | null> {
  const snapshotPath = getKstarSnapshotPath(uid);
  try {
    const content = await fs.readFile(snapshotPath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ── Pending evidence log ────────────────────────────────────────────────

/**
 * Append one evidence record to pending-evidence.jsonl.
 *
 * Thread-safe via per-user mutex. Each record is one JSON line.
 */
export async function appendPendingEvidence(
  uid: string,
  record: unknown,
): Promise<void> {
  const mutex = getUserMutex(uid);
  await mutex.runExclusive(async () => {
    const dir = userKstarDir(uid);
    await fs.mkdir(dir, { recursive: true });

    const logPath = getPendingEvidencePath(uid);
    const line = JSON.stringify(record) + '\n';
    await fs.appendFile(logPath, line, 'utf8');
  });
}

/**
 * Compact pending evidence log by reading all records, folding via the
 * provided function, and rewriting the log atomically.
 *
 * The folder function receives all parsed records and returns the subset
 * to retain. Common patterns:
 *   - Deduplication: filter by stable ID
 *   - Windowing: return last N records
 *   - Aggregation: merge similar records
 */
export async function compactPendingEvidence(
  uid: string,
  folder: (records: unknown[]) => unknown[],
): Promise<void> {
  const mutex = getUserMutex(uid);
  await mutex.runExclusive(async () => {
    const logPath = getPendingEvidencePath(uid);

    // Read all records
    let content: string;
    try {
      content = await fs.readFile(logPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Log doesn't exist yet; nothing to compact
        return;
      }
      throw err;
    }

    const lines = content.trim().split('\n').filter((l) => l.trim());
    const records = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((r) => r !== null);

    // Apply folder
    const retained = folder(records);

    // Rewrite log atomically
    const tmpPath = logPath + `.${process.pid}.${Date.now()}.tmp`;
    try {
      const newContent = retained.map((r) => JSON.stringify(r)).join('\n') + '\n';
      await fs.writeFile(tmpPath, newContent, 'utf8');
      await fs.rename(tmpPath, logPath);

      log.info('compacted pending evidence', {
        uid,
        before: records.length,
        after: retained.length,
      });
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  });
}

// ── Archive operations ──────────────────────────────────────────────────

export interface KstarArchiveEntry {
  timestamp: string; // ISO format: 2026-07-26T10-00-00
  path: string;
}

/**
 * List archived snapshots sorted by timestamp descending (newest first).
 */
export async function listKstarArchives(uid: string): Promise<KstarArchiveEntry[]> {
  const dir = kstarArchivesDir(uid);
  try {
    const entries = await fs.readdir(dir);
    const archives = entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const timestamp = name.replace(/\.json$/, '');
        return {
          timestamp,
          path: path.join(dir, name),
        };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return archives;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Read an archived snapshot by timestamp.
 */
export async function readKstarArchive(
  uid: string,
  timestamp: string,
): Promise<unknown | null> {
  const archivePath = path.join(kstarArchivesDir(uid), `${timestamp}.json`);
  try {
    const content = await fs.readFile(archivePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Short-form aliases used by IPC routes and tests
export async function listArchives(uid: string): Promise<string[]> {
  const entries = await listKstarArchives(uid);
  return entries.map((e) => e.timestamp);
}

export async function readArchive(uid: string, timestamp: string): Promise<unknown | null> {
  return readKstarArchive(uid, timestamp);
}
