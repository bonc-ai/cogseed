/**
 * p3394-archive.test.ts — IPC archive route tests
 *
 * Contract tests:
 * 1. listArchives returns chronological list of archived snapshots
 * 2. readArchive returns full archived state by timestamp
 * 3. checkMigrationStatus returns migration stamp details
 * 4. Archive routes are read-only (no write operations)
 * 5. Invalid timestamps return not found
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  migrateLegacyState,
  checkMigrationStatus,
} from '../../../src/main/features/p3394/kstar-migration';
import { listArchives, readArchive } from '../../../src/main/features/p3394/kstar-store';

describe('p3394 archive IPC routes', () => {
  let testRoot: string;
  let testUid: string;
  let legacyStatePath: string;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kstar-ipc-archive-test-'));
    testUid = 'test-user-ipc';
    process.env.ORKAS_WORKSPACE_ROOT = testRoot;

    const legacyDir = path.join(testRoot, testUid, 'local', 'p3394');
    await fs.mkdir(legacyDir, { recursive: true });
    legacyStatePath = path.join(legacyDir, 'kstar-state.json');
  });

  afterEach(async () => {
    delete process.env.ORKAS_WORKSPACE_ROOT;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  describe('listArchives route', () => {
    test('returns empty list when no archives exist', async () => {
      const archives = await listArchives(testUid);
      expect(archives).toEqual([]);
    });

    test('returns chronological list after migration', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      await migrateLegacyState(testUid, legacyStatePath);

      const archives = await listArchives(testUid);
      expect(archives.length).toBe(1);
      expect(archives[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    test('returns multiple archives in chronological order', async () => {
      const legacyState1 = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState1));
      const first = await migrateLegacyState(testUid, legacyStatePath);

      // Create second archive manually (simulate another migration)
      const archiveDir = path.join(testRoot, testUid, 'local', 'kstar', 'archives');
      const secondTimestamp = '2999-12-31T23-59-59';
      const legacyState2 = { version: 2, runs: [{ id: 'run-2' }], updated_at: '2999-12-31T23:59:59' };
      await fs.writeFile(path.join(archiveDir, `${secondTimestamp}.json`), JSON.stringify(legacyState2));

      const archives = await listArchives(testUid);
      expect(archives.length).toBe(2);
      expect(archives[0]).toBe(secondTimestamp);
      expect(archives[1]).toBe(first.archived_timestamp);
    });
  });

  describe('readArchive route', () => {
    test('returns null for non-existent archive', async () => {
      const archive = await readArchive(testUid, '2026-07-26T10-00-00');
      expect(archive).toBeNull();
    });

    test('returns full archived state by timestamp', async () => {
      const legacyState = {
        version: 1,
        runs: [{ id: 'run-1', status: 'completed', actual_result: 'Success' }],
        experience_candidates: [{ id: 'exp-1', summary: 'Test' }],
        updated_at: '2026-07-26T10:00:00',
      };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      const timestamp = result.archived_timestamp!;

      const archive = await readArchive(testUid, timestamp);
      expect(archive).toEqual(legacyState);
    });

    test('rejects invalid timestamp format', async () => {
      const archive = await readArchive(testUid, 'invalid-timestamp');
      expect(archive).toBeNull();
    });
  });

  describe('checkMigrationStatus route', () => {
    test('returns not migrated when no stamp exists', async () => {
      const status = await checkMigrationStatus(testUid);
      expect(status.migrated).toBe(false);
      expect(status.stamp).toBeUndefined();
    });

    test('returns migrated with stamp after migration', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      await migrateLegacyState(testUid, legacyStatePath);

      const status = await checkMigrationStatus(testUid);
      expect(status.migrated).toBe(true);
      expect(status.stamp?.legacy_hash).toBeTruthy();
      expect(status.stamp?.legacy_path).toBe(legacyStatePath);
      expect(status.stamp?.migrated_at).toBeTruthy();
    });

    test('check is read-only (does not modify state)', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      const before = await checkMigrationStatus(testUid);
      expect(before.migrated).toBe(false);

      // Check should not trigger migration
      const after = await checkMigrationStatus(testUid);
      expect(after.migrated).toBe(false);

      // File should still exist
      const exists = await fs.access(legacyStatePath).then(() => true, () => false);
      expect(exists).toBe(true);
    });
  });

  describe('archive routes are read-only', () => {
    test('archives cannot be modified through read operations', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      const result = await migrateLegacyState(testUid, legacyStatePath);
      const timestamp = result.archived_timestamp!;

      // Read archive
      const archive = await readArchive(testUid, timestamp);
      expect(archive).toBeTruthy();

      // Mutate the returned object
      if (archive) {
        (archive as any).runs = [{ id: 'tampered' }];
      }

      // Re-read should return original
      const reread = await readArchive(testUid, timestamp);
      expect(reread).toEqual(legacyState);
      expect((reread as any).runs).toEqual([]);
    });

    test('list archives does not expose write operations', async () => {
      const legacyState = { version: 1, runs: [], updated_at: '2026-07-26T10:00:00' };
      await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));

      await migrateLegacyState(testUid, legacyStatePath);

      const archives = await listArchives(testUid);
      expect(archives.length).toBe(1);

      // Mutating the returned list should not affect storage
      archives.push('fake-timestamp');

      const reread = await listArchives(testUid);
      expect(reread.length).toBe(1);
      expect(reread).not.toContain('fake-timestamp');
    });
  });
});
