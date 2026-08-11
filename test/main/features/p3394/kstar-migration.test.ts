/**
 * kstar-migration.test.ts — Legacy migration with stamp and archive
 *
 * Contract tests:
 * 1. Hash-based idempotency: same legacy state → skip migration
 * 2. Atomic transaction: dry-run → validate → write snapshot+archive+stamp → rename source
 * 3. Changed hash = degraded: don't corrupt newer state
 * 4. Archive preserves legacy state for rollback/audit
 * 5. Validation failures abort before writes
 * 6. Stamp tracks legacy hash and path
 * 7. Per-user mutex serializes migrations
 * 8. Failed rename is non-fatal (snapshot already written)
 * 9. Status check without side effects
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  migrateLegacyState,
  checkMigrationStatus,
  clearMigrationStamp,
} from '../../../../src/main/features/p3394/kstar-migration';
import { readKstarSnapshot } from '../../../../src/main/features/p3394/kstar-store';

describe('kstar-migration', () => {
  let testRoot: string;
  let testUid: string;
  let legacyStatePath: string;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kstar-migration-test-'));
    testUid = 'test-user-001';
    process.env.ORKAS_WORKSPACE_ROOT = testRoot;

    // Create legacy state path
    const legacyDir = path.join(testRoot, testUid, 'local', 'p3394');
    await fs.mkdir(legacyDir, { recursive: true });
    legacyStatePath = path.join(legacyDir, 'kstar-state.json');
  });

  afterEach(async () => {
    delete process.env.ORKAS_WORKSPACE_ROOT;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  describe('idempotency', () => {
    test('migrates legacy state on first run', async () => {
      const legacyState = {
        version: 1,
        runs: [],
        experience_candidates: [],
        tool_cycles: [],
        updated_at: '2026-07-26T10:00:00',
      };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2));

      const result = await migrateLegacyState(testUid, legacyStatePath);

      expect(result.status).toBe('completed');
      expect(result.legacy_hash).toBeTruthy();
      expect(result.archived_timestamp).toBeTruthy();
    });

    test('skips migration when hash matches existing stamp', async () => {
      const legacyState = {
        version: 1,
        runs: [{ id: 'run-1', status: 'completed' }],
        updated_at: '2026-07-26T10:00:00',
      };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2));

      // First migration
      const first = await migrateLegacyState(testUid, legacyStatePath);
      expect(first.status).toBe('completed');

      // Restore legacy file (simulate it wasn't renamed)
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2));

      // Second migration with same state
      const second = await migrateLegacyState(testUid, legacyStatePath);
      expect(second.status).toBe('skipped');
      expect(second.reason).toContain('Already migrated');
      expect(second.legacy_hash).toBe(first.legacy_hash);
    });

    test('returns degraded when legacy hash changes', async () => {
      const legacyStateV1 = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyStateV1, null, 2));

      // First migration
      const first = await migrateLegacyState(testUid, legacyStatePath);
      expect(first.status).toBe('completed');

      // Change legacy state (simulate newer schema)
      const legacyStateV2 = {
        version: 2,
        runs: [{ id: 'new-run' }],
        updated_at: '2026-07-26T11:00:00',
      };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyStateV2, null, 2));

      // Second migration with changed state
      const second = await migrateLegacyState(testUid, legacyStatePath);
      expect(second.status).toBe('degraded');
      expect(second.reason).toContain('hash changed');
      expect(second.legacy_hash).not.toBe(first.legacy_hash);
    });
  });

  describe('atomic transaction', () => {
    test('writes snapshot, archive, and stamp atomically', async () => {
      const legacyState = {
        version: 1,
        runs: [{ id: 'run-1', conversation_id: 'conv-1' }],
        experience_candidates: [{ id: 'exp-1', summary: 'Test' }],
        updated_at: '2026-07-26T10:00:00',
      };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      expect(result.status).toBe('completed');

      // Check snapshot was written
      const snapshot = await readKstarSnapshot(testUid);
      expect(snapshot).toBeTruthy();
      expect((snapshot as any)._migrated_from).toBe('legacy-pc-kstar');

      // Check archive was created
      const archiveDir = path.join(testRoot, testUid, 'local', 'kstar', 'archives');
      const archives = await fs.readdir(archiveDir);
      expect(archives.length).toBe(1);
      expect(archives[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);

      // Check stamp was written
      const stampPath = path.join(testRoot, testUid, 'local', 'kstar', '.migration-stamp.json');
      const stampContent = await fs.readFile(stampPath, 'utf8');
      const stamp = JSON.parse(stampContent);
      expect(stamp.legacy_hash).toBe(result.legacy_hash);
      expect(stamp.legacy_path).toBe(legacyStatePath);
      expect(stamp.migrated_at).toBeTruthy();
    });

    test('renames legacy source to .migrated after successful migration', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2));

      await migrateLegacyState(testUid, legacyStatePath);

      // Original should be renamed
      const originalExists = await fs.access(legacyStatePath).then(() => true, () => false);
      expect(originalExists).toBe(false);

      // .migrated should exist
      const migratedPath = `${legacyStatePath}.migrated`;
      const migratedExists = await fs.access(migratedPath).then(() => true, () => false);
      expect(migratedExists).toBe(true);
    });

    test('archives preserve full legacy state for rollback', async () => {
      const legacyState = {
        version: 1,
        runs: [
          { id: 'run-1', status: 'completed', actual_result: 'Success' },
          { id: 'run-2', status: 'failed', actual_result: 'Error' },
        ],
        experience_candidates: [{ id: 'exp-1', summary: 'Test experience' }],
        tool_cycles: [{ id: 'cycle-1', tool_name: 'read_file' }],
        updated_at: '2026-07-26T10:00:00',
      };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      expect(result.archived_timestamp).toBeTruthy();

      // Read archive and verify it matches original
      const archivePath = path.join(
        testRoot,
        testUid,
        'local',
        'kstar',
        'archives',
        `${result.archived_timestamp}.json`,
      );
      const archivedContent = await fs.readFile(archivePath, 'utf8');
      const archived = JSON.parse(archivedContent);

      expect(archived).toEqual(legacyState);
    });
  });

  describe('validation', () => {
    test('aborts migration for invalid legacy state', async () => {
      // Invalid: not an object
      await fs.writeFile(legacyStatePath, JSON.stringify('not an object'));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('must be an object');

      // No snapshot should be written
      const snapshot = await readKstarSnapshot(testUid);
      expect(snapshot).toBeNull();
    });

    test('aborts migration for malformed legacy state', async () => {
      // Missing version and runs
      const malformed = { foo: 'bar' };
      await fs.writeFile(legacyStatePath, JSON.stringify(malformed));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('missing version or runs');
    });

    test('accepts legacy state with version field', async () => {
      const legacyState = { version: 1, updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      expect(result.status).toBe('completed');
    });

    test('accepts legacy state with runs array', async () => {
      const legacyState = { runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      expect(result.status).toBe('completed');
    });
  });

  describe('status check', () => {
    test('returns not migrated when stamp is missing', async () => {
      const status = await checkMigrationStatus(testUid);
      expect(status.migrated).toBe(false);
      expect(status.stamp).toBeUndefined();
    });

    test('returns migrated with stamp details after migration', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      await migrateLegacyState(testUid, legacyStatePath);

      const status = await checkMigrationStatus(testUid);
      expect(status.migrated).toBe(true);
      expect(status.stamp?.legacy_hash).toBeTruthy();
      expect(status.stamp?.legacy_path).toBe(legacyStatePath);
      expect(status.stamp?.migrated_at).toBeTruthy();
    });

    test('check does not modify state', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      await checkMigrationStatus(testUid);

      // Legacy state should still exist
      const exists = await fs.access(legacyStatePath).then(() => true, () => false);
      expect(exists).toBe(true);

      // No snapshot should be written
      const snapshot = await readKstarSnapshot(testUid);
      expect(snapshot).toBeNull();
    });
  });

  describe('stamp management', () => {
    test('clears migration stamp for re-migration', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      // First migration
      await migrateLegacyState(testUid, legacyStatePath);
      let status = await checkMigrationStatus(testUid);
      expect(status.migrated).toBe(true);

      // Clear stamp
      await clearMigrationStamp(testUid);
      status = await checkMigrationStatus(testUid);
      expect(status.migrated).toBe(false);
    });

    test('clear stamp does not delete archived snapshots', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      const archivedTimestamp = result.archived_timestamp!;

      await clearMigrationStamp(testUid);

      // Archive should still exist
      const archivePath = path.join(
        testRoot,
        testUid,
        'local',
        'kstar',
        'archives',
        `${archivedTimestamp}.json`,
      );
      const exists = await fs.access(archivePath).then(() => true, () => false);
      expect(exists).toBe(true);
    });

    test('clear stamp is safe when stamp does not exist', async () => {
      await clearMigrationStamp(testUid);
      // Should not throw

      const status = await checkMigrationStatus(testUid);
      expect(status.migrated).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('skips migration when legacy file does not exist', async () => {
      const result = await migrateLegacyState(testUid, legacyStatePath);
      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('does not exist');
    });

    test('handles concurrent migration attempts via mutex', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      // Launch concurrent migrations
      const migrations = [
        migrateLegacyState(testUid, legacyStatePath),
        migrateLegacyState(testUid, legacyStatePath),
        migrateLegacyState(testUid, legacyStatePath),
      ];

      const results = await Promise.all(migrations);

      // One should complete, others should skip
      const completed = results.filter((r) => r.status === 'completed');
      const skipped = results.filter((r) => r.status === 'skipped');

      expect(completed.length).toBe(1);
      expect(skipped.length).toBe(2);
    });

    test('migration continues if legacy source rename fails', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      const legacyDir = path.dirname(legacyStatePath);
      await fs.chmod(legacyDir, 0o555);
      try {
        const result = await migrateLegacyState(testUid, legacyStatePath);

        // Migration should still complete (rename failure is non-fatal)
        expect(result.status).toBe('completed');

        // Snapshot should exist and legacy source remains for retry/audit
        const snapshot = await readKstarSnapshot(testUid);
        expect(snapshot).toBeTruthy();
        await expect(fs.access(legacyStatePath)).resolves.toBeUndefined();
      } finally {
        await fs.chmod(legacyDir, 0o755).catch(() => {});
      }
    });
  });
});
