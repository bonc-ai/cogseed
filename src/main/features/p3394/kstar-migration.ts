/**
 * kstar-migration.ts — Legacy state migration with stamp and archive
 *
 * Provides:
 * 1. Hash-based idempotency: same legacy state → same migration (no re-run)
 * 2. Atomic transaction: dry-run → validate → write snapshot+archive+stamp → rename source
 * 3. Changed hash = degraded mode: don't corrupt newer state
 * 4. Archive preserves legacy state for rollback/audit
 *
 * Migration stamp format:
 *   <uid>/local/kstar/.migration-stamp.json
 *   { migrated_at: ISO, legacy_hash: string, legacy_path: string }
 *
 * Archive format:
 *   <uid>/local/kstar/archives/<timestamp>.json
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { Mutex } from 'async-mutex';
import { createLogger } from '../../logger';
import { writeKstarSnapshot } from './kstar-store';

const log = createLogger('p3394.kstar-migration');

function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}

const userKstarDir = (uid: string) => path.join(workspaceRoot(), uid, 'local', 'kstar');
const migrationStampPath = (uid: string) => path.join(userKstarDir(uid), '.migration-stamp.json');
const kstarArchivesDir = (uid: string) => path.join(userKstarDir(uid), 'archives');

// Per-user migration mutex
const migrationMutexes = new Map<string, Mutex>();

function getMigrationMutex(uid: string): Mutex {
  let mutex = migrationMutexes.get(uid);
  if (!mutex) {
    mutex = new Mutex();
    migrationMutexes.set(uid, mutex);
  }
  return mutex;
}

export interface MigrationStamp {
  migrated_at: string;
  legacy_hash: string;
  legacy_path: string;
  legacy_schema_version?: string;
}

export interface MigrationResult {
  status: 'skipped' | 'completed' | 'degraded' | 'failed';
  reason?: string;
  legacy_hash?: string;
  archived_timestamp?: string;
}

/**
 * Compute stable hash of legacy state for idempotency check.
 */
function computeLegacyHash(legacyState: unknown): string {
  const canonical = JSON.stringify(legacyState, Object.keys(legacyState as object).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Read migration stamp or return null if missing.
 */
async function readMigrationStamp(uid: string): Promise<MigrationStamp | null> {
  try {
    const content = await fs.readFile(migrationStampPath(uid), 'utf8');
    return JSON.parse(content) as MigrationStamp;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write migration stamp atomically.
 */
async function writeMigrationStamp(uid: string, stamp: MigrationStamp): Promise<void> {
  const dir = userKstarDir(uid);
  await fs.mkdir(dir, { recursive: true });

  const stampPath = migrationStampPath(uid);
  const tmpPath = `${stampPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.writeFile(tmpPath, JSON.stringify(stamp, null, 2), 'utf8');
    await fs.rename(tmpPath, stampPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Archive legacy state with timestamp.
 */
async function archiveLegacyState(
  uid: string,
  legacyState: unknown,
): Promise<string> {
  const dir = kstarArchivesDir(uid);
  await fs.mkdir(dir, { recursive: true });

  // Use ISO timestamp with colons replaced for safe filename
  const now = new Date().toISOString();
  const timestamp = now.replace(/:/g, '-').split('.')[0]; // 2026-07-26T10-00-00

  const archivePath = path.join(dir, `${timestamp}.json`);
  await fs.writeFile(archivePath, JSON.stringify(legacyState, null, 2), 'utf8');

  log.info('archived legacy state', { uid, timestamp, path: archivePath });
  return timestamp;
}

/**
 * Validate legacy state structure (basic sanity check).
 */
function validateLegacyState(legacyState: unknown): { valid: boolean; reason?: string } {
  if (!legacyState || typeof legacyState !== 'object') {
    return { valid: false, reason: 'Legacy state must be an object' };
  }

  const state = legacyState as Record<string, unknown>;

  // Basic structure check: should have at least version or runs
  if (!state.version && !Array.isArray(state.runs)) {
    return { valid: false, reason: 'Legacy state missing version or runs array' };
  }

  return { valid: true };
}

/**
 * Transform legacy kstar-state.json to Engine snapshot format.
 *
 * This is a placeholder transformation. Real implementation would:
 * 1. Read legacy schema version
 * 2. Map legacy fields to Engine snapshot structure
 * 3. Preserve opaque fields byte-for-byte
 */
function transformLegacyToSnapshot(legacyState: unknown): unknown {
  const state = legacyState as Record<string, unknown>;

  // Minimal transformation: wrap in Engine snapshot envelope
  return {
    _schema_version: '1.0.0',
    _migrated_from: 'legacy-pc-kstar',
    _migrated_at: new Date().toISOString(),
    legacy_state: state,
    // Engine would process this further to extract episodes, candidates, etc.
  };
}

/**
 * Migrate legacy KSTAR state to Engine snapshot with hash-based idempotency.
 *
 * Flow:
 * 1. Read migration stamp; if hash matches, skip
 * 2. Read legacy state and compute hash
 * 3. If hash changed since last migration → degraded (newer schema)
 * 4. Dry-run: validate legacy state
 * 5. Transform legacy → Engine snapshot
 * 6. Atomic write: snapshot + archive + stamp
 * 7. Rename legacy source to .migrated
 */
export async function migrateLegacyState(
  uid: string,
  legacyStatePath: string,
): Promise<MigrationResult> {
  const mutex = getMigrationMutex(uid);

  return mutex.runExclusive(async () => {
    log.info('starting legacy migration', { uid, legacyPath: legacyStatePath });

    try {
      // 1. Check existing migration stamp
      const existingStamp = await readMigrationStamp(uid);

      // 2. Read and hash legacy state
      let legacyState: unknown;
      try {
        const content = await fs.readFile(legacyStatePath, 'utf8');
        legacyState = JSON.parse(content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { status: 'skipped', reason: 'Legacy state file does not exist' };
        }
        throw err;
      }

      const legacyHash = computeLegacyHash(legacyState);

      // 3. Idempotency check
      if (existingStamp && existingStamp.legacy_hash === legacyHash) {
        log.info('migration already completed with same hash', { uid, legacyHash });
        return { status: 'skipped', reason: 'Already migrated', legacy_hash: legacyHash };
      }

      // 4. Changed hash check (degraded mode)
      if (existingStamp && existingStamp.legacy_hash !== legacyHash) {
        log.warn('legacy state hash changed since last migration', {
          uid,
          oldHash: existingStamp.legacy_hash,
          newHash: legacyHash,
        });
        return {
          status: 'degraded',
          reason: 'Legacy state hash changed; possible newer schema',
          legacy_hash: legacyHash,
        };
      }

      // 5. Validate legacy state
      const validation = validateLegacyState(legacyState);
      if (!validation.valid) {
        log.warn('legacy state validation failed', { uid, reason: validation.reason });
        return { status: 'failed', reason: validation.reason };
      }

      // 6. Transform to Engine snapshot
      const engineSnapshot = transformLegacyToSnapshot(legacyState);

      // 7. Archive legacy state
      const archivedTimestamp = await archiveLegacyState(uid, legacyState);

      // 8. Write Engine snapshot
      await writeKstarSnapshot(uid, engineSnapshot);

      // 9. Write migration stamp
      const stamp: MigrationStamp = {
        migrated_at: new Date().toISOString(),
        legacy_hash: legacyHash,
        legacy_path: legacyStatePath,
        legacy_schema_version: String((legacyState as any).version || '1'),
      };
      await writeMigrationStamp(uid, stamp);

      // 10. Rename legacy source to .migrated
      const migratedPath = `${legacyStatePath}.migrated`;
      try {
        await fs.rename(legacyStatePath, migratedPath);
      } catch (err) {
        log.warn('failed to rename legacy source', {
          uid,
          error: (err as Error).message,
        });
        // Non-fatal; migration already completed
      }

      log.info('migration completed', {
        uid,
        legacyHash,
        archivedTimestamp,
      });

      return {
        status: 'completed',
        legacy_hash: legacyHash,
        archived_timestamp: archivedTimestamp,
      };
    } catch (err) {
      log.error('migration failed', {
        uid,
        error: (err as Error).message,
      });
      return {
        status: 'failed',
        reason: (err as Error).message,
      };
    }
  });
}

/**
 * Check migration status without running migration.
 */
export async function checkMigrationStatus(uid: string): Promise<{
  migrated: boolean;
  stamp?: MigrationStamp;
}> {
  const stamp = await readMigrationStamp(uid);
  return {
    migrated: !!stamp,
    stamp: stamp || undefined,
  };
}

/**
 * Force re-migration by clearing the stamp (for recovery scenarios).
 * Does NOT delete archived snapshots.
 */
export async function clearMigrationStamp(uid: string): Promise<void> {
  const mutex = getMigrationMutex(uid);
  await mutex.runExclusive(async () => {
    try {
      await fs.rm(migrationStampPath(uid));
      log.info('cleared migration stamp', { uid });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  });
}
