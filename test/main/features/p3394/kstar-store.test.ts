/**
 * kstar-store.test.ts — Per-user KSTAR snapshot + pending evidence log
 *
 * Contract tests:
 * 1. Per-user paths under <uid>/local/kstar/
 * 2. Atomic snapshot write with .previous backup
 * 3. Append-only pending-evidence.jsonl with fold/compact
 * 4. Archive list/detail (read previous snapshots)
 * 5. Per-user mutex (no torn writes)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  writeKstarSnapshot,
  readKstarSnapshot,
  appendPendingEvidence,
  compactPendingEvidence,
  listKstarArchives,
  readKstarArchive,
  getKstarSnapshotPath,
  getPendingEvidencePath,
} from '../../../../src/main/features/p3394/kstar-store';

describe('kstar-store', () => {
  let testRoot: string;
  let testUid: string;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kstar-store-test-'));
    testUid = 'test-user-001';
    process.env.ORKAS_WORKSPACE_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.ORKAS_WORKSPACE_ROOT;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  describe('snapshot write/read', () => {
    test('writes opaque snapshot with atomic rename', async () => {
      const snapshot = { _opaque: 'engine-state-v1', data: 'test' };
      await writeKstarSnapshot(testUid, snapshot);

      const snapshotPath = getKstarSnapshotPath(testUid);
      const content = await fs.readFile(snapshotPath, 'utf8');
      const parsed = JSON.parse(content);

      expect(parsed._opaque).toBe('engine-state-v1');
      expect(parsed.data).toBe('test');
    });

    test('reads snapshot or returns null when missing', async () => {
      const missing = await readKstarSnapshot(testUid);
      expect(missing).toBeNull();

      const snapshot = { _opaque: 'v2', value: 42 };
      await writeKstarSnapshot(testUid, snapshot);

      const loaded = await readKstarSnapshot(testUid);
      expect(loaded).toEqual(snapshot);
    });

    test('creates .previous backup on second write', async () => {
      const first = { _opaque: 'v1', gen: 1 };
      await writeKstarSnapshot(testUid, first);

      const second = { _opaque: 'v2', gen: 2 };
      await writeKstarSnapshot(testUid, second);

      const current = await readKstarSnapshot(testUid);
      expect(current).toEqual(second);

      const snapshotPath = getKstarSnapshotPath(testUid);
      const previousPath = snapshotPath + '.previous';
      const previous = JSON.parse(await fs.readFile(previousPath, 'utf8'));
      expect(previous).toEqual(first);
    });

    test('overwrites .previous on third write', async () => {
      await writeKstarSnapshot(testUid, { gen: 1 });
      await writeKstarSnapshot(testUid, { gen: 2 });
      await writeKstarSnapshot(testUid, { gen: 3 });

      const snapshotPath = getKstarSnapshotPath(testUid);
      const previousPath = snapshotPath + '.previous';
      const previous = JSON.parse(await fs.readFile(previousPath, 'utf8'));
      expect(previous.gen).toBe(2);
    });
  });

  describe('pending evidence log', () => {
    test('appends evidence records to jsonl', async () => {
      const ev1 = { id: 'ev-001', type: 'success', tool: 'search' };
      const ev2 = { id: 'ev-002', type: 'failure', tool: 'read_file' };

      await appendPendingEvidence(testUid, ev1);
      await appendPendingEvidence(testUid, ev2);

      const logPath = getPendingEvidencePath(testUid);
      const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');

      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0])).toEqual(ev1);
      expect(JSON.parse(lines[1])).toEqual(ev2);
    });

    test('compacts log by folding records', async () => {
      await appendPendingEvidence(testUid, { id: 'a', count: 1 });
      await appendPendingEvidence(testUid, { id: 'b', count: 2 });
      await appendPendingEvidence(testUid, { id: 'c', count: 3 });

      const folder = (records: unknown[]) =>
        records.slice(-2); // keep last 2

      await compactPendingEvidence(testUid, folder);

      const logPath = getPendingEvidencePath(testUid);
      const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');

      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0])).toEqual({ id: 'b', count: 2 });
      expect(JSON.parse(lines[1])).toEqual({ id: 'c', count: 3 });
    });

    test('compact is safe when log is missing', async () => {
      await compactPendingEvidence(testUid, (r) => r);
      // Should not throw
      const logPath = getPendingEvidencePath(testUid);
      const exists = await fs.access(logPath).then(() => true, () => false);
      expect(exists).toBe(false);
    });
  });

  describe('archive list/read', () => {
    test('lists no archives when directory is empty', async () => {
      const archives = await listKstarArchives(testUid);
      expect(archives).toEqual([]);
    });

    test('lists archived snapshots sorted by timestamp desc', async () => {
      const archiveDir = path.join(testRoot, testUid, 'local', 'kstar', 'archives');
      await fs.mkdir(archiveDir, { recursive: true });

      await fs.writeFile(
        path.join(archiveDir, '2026-07-25T10-00-00.json'),
        JSON.stringify({ gen: 1 }),
      );
      await fs.writeFile(
        path.join(archiveDir, '2026-07-26T12-00-00.json'),
        JSON.stringify({ gen: 2 }),
      );
      await fs.writeFile(
        path.join(archiveDir, '2026-07-24T08-00-00.json'),
        JSON.stringify({ gen: 0 }),
      );

      const archives = await listKstarArchives(testUid);
      expect(archives.length).toBe(3);
      expect(archives[0].timestamp).toBe('2026-07-26T12-00-00');
      expect(archives[1].timestamp).toBe('2026-07-25T10-00-00');
      expect(archives[2].timestamp).toBe('2026-07-24T08-00-00');
    });

    test('reads archived snapshot by timestamp', async () => {
      const archiveDir = path.join(testRoot, testUid, 'local', 'kstar', 'archives');
      await fs.mkdir(archiveDir, { recursive: true });

      const snapshot = { _opaque: 'archived', data: 'old' };
      const timestamp = '2026-07-20T15-30-00';
      await fs.writeFile(
        path.join(archiveDir, `${timestamp}.json`),
        JSON.stringify(snapshot),
      );

      const loaded = await readKstarArchive(testUid, timestamp);
      expect(loaded).toEqual(snapshot);
    });

    test('returns null when archive does not exist', async () => {
      const loaded = await readKstarArchive(testUid, '2026-01-01T00-00-00');
      expect(loaded).toBeNull();
    });
  });

  describe('concurrency', () => {
    test('concurrent writes serialize via per-user mutex', async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        writeKstarSnapshot(testUid, { gen: i }),
      );

      await Promise.all(writes);

      const final = await readKstarSnapshot(testUid);
      expect(typeof final?.gen).toBe('number');
      expect(final?.gen).toBeGreaterThanOrEqual(0);
      expect(final?.gen).toBeLessThan(10);
    });

    test('concurrent appends do not interleave lines', async () => {
      const appends = Array.from({ length: 20 }, (_, i) =>
        appendPendingEvidence(testUid, { seq: i }),
      );

      await Promise.all(appends);

      const logPath = getPendingEvidencePath(testUid);
      const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');

      expect(lines.length).toBe(20);
      const seqs = lines.map((l) => JSON.parse(l).seq);
      expect(new Set(seqs).size).toBe(20); // all unique
    });
  });

  describe('path derivation', () => {
    test('derives correct paths from uid', () => {
      const snapshotPath = getKstarSnapshotPath(testUid);
      expect(snapshotPath).toContain(testUid);
      expect(snapshotPath).toContain('local/kstar');
      expect(snapshotPath).toMatch(/snapshot\.json$/);

      const logPath = getPendingEvidencePath(testUid);
      expect(logPath).toContain(testUid);
      expect(logPath).toContain('local/kstar');
      expect(logPath).toMatch(/pending-evidence\.jsonl$/);
    });
  });
});
