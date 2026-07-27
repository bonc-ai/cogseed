/**
 * kstar-recovery.test.ts — Boot health, pending evidence replay, schema degradation
 *
 * Contract tests:
 * 1. checkKstarDegraded: known schema → not degraded
 * 2. checkKstarDegraded: unknown/newer schema version → degraded
 * 3. checkKstarDegraded: no stamp → not degraded
 * 4. replayPendingEvidence: empty log → 0 replayed, 0 remaining
 * 5. replayPendingEvidence: successful delivery drops record
 * 6. replayPendingEvidence: failed delivery keeps record
 * 7. replayPendingEvidence: records without id are never dropped
 * 8. replayPendingEvidence: concurrent append during replay is preserved
 * 9. replayPendingEvidence: partial success (some succeed, some fail)
 * 10. runKstarBootRecovery: newer schema → degraded, no replay
 * 11. runKstarBootRecovery: no adapter → not degraded, replayed=0
 * 12. runKstarBootRecovery: adapter available → replay runs
 * 13. Recovery is idempotent (replay twice delivers nothing on second pass)
 * 14. clearMigrationStamp allows re-migration recovery path
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  checkKstarDegraded,
  replayPendingEvidence,
  runKstarBootRecovery,
} from '../../../../src/main/features/p3394/kstar-recovery';
import {
  appendPendingEvidence,
  compactPendingEvidence,
  getPendingEvidencePath,
} from '../../../../src/main/features/p3394/kstar-store';
import {
  migrateLegacyState,
  clearMigrationStamp,
} from '../../../../src/main/features/p3394/kstar-migration';

// kstar-store.ts and kstar-migration.ts capture WS_ROOT as a module-level
// constant at import time (before any beforeEach can change the env var).
// The global vitest tmp dir is pinned by setup-env.ts before any module is
// loaded. We work with that frozen root: each test gets a unique uid so state
// never leaks between tests, and afterEach cleans the uid sub-tree.
const MODULE_WS_ROOT = process.env.ORKAS_WORKSPACE_ROOT!;

describe('kstar-recovery', () => {
  let testUid: string;
  let legacyStatePath: string;

  beforeEach(async () => {
    // Unique uid per test — shared WS_ROOT means we must never share a uid.
    testUid = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const legacyDir = path.join(MODULE_WS_ROOT, testUid, 'local', 'p3394');
    await fs.mkdir(legacyDir, { recursive: true });
    legacyStatePath = path.join(legacyDir, 'kstar-state.json');
  });

  afterEach(async () => {
    await fs.rm(path.join(MODULE_WS_ROOT, testUid), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── Migration stamp helpers ──────────────────────────────────────────────

  async function runMigration(schemaVersion?: string): Promise<void> {
    const legacyState = {
      version: schemaVersion ? Number(schemaVersion.split('.')[0]) : 1,
      runs: [],
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(legacyStatePath, JSON.stringify(legacyState));
    const result = await migrateLegacyState(testUid, legacyStatePath);
    expect(result.status).toBe('completed');

    if (schemaVersion) {
      // Overwrite the stamp's legacy_schema_version to simulate a future build.
      const stampPath = path.join(MODULE_WS_ROOT, testUid, 'local', 'kstar', '.migration-stamp.json');
      const stamp = JSON.parse(await fs.readFile(stampPath, 'utf8'));
      stamp.legacy_schema_version = schemaVersion;
      await fs.writeFile(stampPath, JSON.stringify(stamp, null, 2));
    }
  }

  // ── checkKstarDegraded ──────────────────────────────────────────────────

  describe('checkKstarDegraded', () => {
    test('returns not degraded when no migration stamp exists', async () => {
      const result = await checkKstarDegraded(testUid);
      expect(result.degraded).toBe(false);
      expect(result.stamp).toBeUndefined();
    });

    test('returns not degraded for known schema version 1', async () => {
      await runMigration('1');
      const result = await checkKstarDegraded(testUid);
      expect(result.degraded).toBe(false);
    });

    test('returns not degraded for known schema version 1.0.0', async () => {
      await runMigration('1.0.0');
      const result = await checkKstarDegraded(testUid);
      expect(result.degraded).toBe(false);
    });

    test('returns degraded for unknown newer schema version', async () => {
      await runMigration('2.0.0');
      const result = await checkKstarDegraded(testUid);
      expect(result.degraded).toBe(true);
      expect(result.reason).toContain('newer schema');
      expect(result.stamp?.legacy_schema_version).toBe('2.0.0');
    });

    test('returns degraded for unrecognized schema version string', async () => {
      await runMigration('9.9.9');
      const result = await checkKstarDegraded(testUid);
      expect(result.degraded).toBe(true);
    });

    test('does not modify any state', async () => {
      await runMigration('1');
      const before = await checkKstarDegraded(testUid);
      const after = await checkKstarDegraded(testUid);
      expect(before.degraded).toBe(after.degraded);
      expect(before.stamp?.migrated_at).toBe(after.stamp?.migrated_at);
    });
  });

  // ── replayPendingEvidence ───────────────────────────────────────────────

  describe('replayPendingEvidence', () => {
    test('returns 0 replayed and 0 remaining for empty log', async () => {
      const sink = vi.fn().mockResolvedValue({ success: true });
      const result = await replayPendingEvidence(testUid, sink);
      expect(result.replayed).toBe(0);
      expect(result.remaining).toBe(0);
      expect(sink).not.toHaveBeenCalled();
    });

    test('replays records and drops them on success', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', tool_name: 'read_file', delta_r: 0.1 });
      await appendPendingEvidence(testUid, { id: 'ev-002', type: 'tool_cycle', tool_name: 'write_file', delta_r: 0.2 });

      const sink = vi.fn().mockResolvedValue({ success: true });
      const result = await replayPendingEvidence(testUid, sink);

      expect(result.replayed).toBe(2);
      expect(result.remaining).toBe(0);
      expect(sink).toHaveBeenCalledTimes(2);

      // Log should be empty after successful replay
      const logPath = getPendingEvidencePath(testUid);
      const afterContent = await fs.readFile(logPath, 'utf8');
      expect(afterContent.trim()).toBe('');
    });

    test('keeps records in log on delivery failure', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });

      const sink = vi.fn().mockResolvedValue({ success: false });
      const result = await replayPendingEvidence(testUid, sink);

      expect(result.replayed).toBe(0);
      expect(result.remaining).toBe(1);
    });

    test('keeps records in log when sink throws', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });

      const sink = vi.fn().mockRejectedValue(new Error('Engine timeout'));
      const result = await replayPendingEvidence(testUid, sink);

      expect(result.replayed).toBe(0);
      expect(result.remaining).toBe(1);
    });

    test('records without an id are never dropped', async () => {
      // Record with no id cannot be safely deduped/acked
      await appendPendingEvidence(testUid, { type: 'tool_cycle', delta_r: 0.1 });

      const sink = vi.fn().mockResolvedValue({ success: true });
      const result = await replayPendingEvidence(testUid, sink);

      // sink is never called for id-less records
      expect(sink).not.toHaveBeenCalled();
      expect(result.replayed).toBe(0);
      expect(result.remaining).toBe(1);
    });

    test('partial success: successful records dropped, failed records kept', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });
      await appendPendingEvidence(testUid, { id: 'ev-002', type: 'tool_cycle', delta_r: 0.2 });
      await appendPendingEvidence(testUid, { id: 'ev-003', type: 'tool_cycle', delta_r: 0.3 });

      const sink = vi.fn().mockImplementation(async (record: Record<string, unknown>) => {
        // Only ev-001 and ev-003 succeed
        return { success: record.id === 'ev-001' || record.id === 'ev-003' };
      });

      const result = await replayPendingEvidence(testUid, sink);

      expect(result.replayed).toBe(2);
      expect(result.remaining).toBe(1);

      // ev-002 should still be in the log
      const logPath = getPendingEvidencePath(testUid);
      const logContent = await fs.readFile(logPath, 'utf8');
      const lines = logContent.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const remaining = JSON.parse(lines[0]);
      expect(remaining.id).toBe('ev-002');
    });

    test('records appended concurrently during replay are preserved', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });

      // Append a new record while replay is in progress (simulated between phase 1 and phase 3)
      const sink = vi.fn().mockImplementation(async () => {
        // Append a new record as if another thread appended evidence during replay
        await appendPendingEvidence(testUid, { id: 'ev-concurrent', type: 'tool_cycle', delta_r: 0.5 });
        return { success: true };
      });

      const result = await replayPendingEvidence(testUid, sink);

      // ev-001 was replayed, ev-concurrent was concurrently appended and preserved
      expect(result.replayed).toBe(1);
      expect(result.remaining).toBe(1); // ev-concurrent

      const logPath = getPendingEvidencePath(testUid);
      const logContent = await fs.readFile(logPath, 'utf8');
      const lines = logContent.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).id).toBe('ev-concurrent');
    });

    test('is idempotent: second replay delivers nothing', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });

      const sink = vi.fn().mockResolvedValue({ success: true });

      const first = await replayPendingEvidence(testUid, sink);
      expect(first.replayed).toBe(1);
      expect(first.remaining).toBe(0);

      // Second call with empty log
      const second = await replayPendingEvidence(testUid, sink);
      expect(second.replayed).toBe(0);
      expect(second.remaining).toBe(0);
      expect(sink).toHaveBeenCalledTimes(1);
    });
  });

  // ── runKstarBootRecovery ────────────────────────────────────────────────

  describe('runKstarBootRecovery', () => {
    test('returns degraded when stamp has newer schema, skips replay', async () => {
      await runMigration('2.0.0');
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });

      const getAdapter = vi.fn();
      const result = await runKstarBootRecovery(testUid, getAdapter);

      expect(result.degraded).toBe(true);
      expect(result.degradedReason).toContain('newer schema');
      // Evidence was NOT replayed because we're degraded
      expect(getAdapter).not.toHaveBeenCalled();
      // Evidence remains in queue
      const logPath = getPendingEvidencePath(testUid);
      const logContent = await fs.readFile(logPath, 'utf8');
      expect(logContent.trim()).not.toBe('');
    });

    test('returns not degraded with replayed=0 when adapter unavailable', async () => {
      await runMigration('1');
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });

      // Adapter is null (Engine not started)
      const getAdapter = vi.fn().mockResolvedValue(null);
      const result = await runKstarBootRecovery(testUid, getAdapter);

      expect(result.degraded).toBe(false);
      expect(result.replayed).toBe(0);
      expect(result.remaining).toBe(0);
    });

    test('replays evidence when adapter is available', async () => {
      await runMigration('1');
      await appendPendingEvidence(testUid, { id: 'ev-001', type: 'tool_cycle', delta_r: 0.1 });
      await appendPendingEvidence(testUid, { id: 'ev-002', type: 'tool_cycle', delta_r: 0.2 });

      const sink = vi.fn().mockResolvedValue({ success: true });
      const getAdapter = vi.fn().mockResolvedValue(sink);
      const result = await runKstarBootRecovery(testUid, getAdapter);

      expect(result.degraded).toBe(false);
      expect(result.replayed).toBe(2);
      expect(result.remaining).toBe(0);
    });

    test('recovers after clearMigrationStamp removes newer schema', async () => {
      await runMigration('2.0.0');

      let check = await checkKstarDegraded(testUid);
      expect(check.degraded).toBe(true);

      // Operator clears the stamp to allow re-migration to a known schema
      await clearMigrationStamp(testUid);

      check = await checkKstarDegraded(testUid);
      expect(check.degraded).toBe(false);
    });

    test('returns migrated=true when stamp present (known schema)', async () => {
      await runMigration('1');
      const getAdapter = vi.fn().mockResolvedValue(null);
      const result = await runKstarBootRecovery(testUid, getAdapter);
      expect(result.migrated).toBe(true);
    });

    test('returns migrated=false when no stamp', async () => {
      const getAdapter = vi.fn().mockResolvedValue(null);
      const result = await runKstarBootRecovery(testUid, getAdapter);
      expect(result.migrated).toBe(false);
    });

    test('does not propagate exception from getRecordEvidence', async () => {
      await runMigration('1');
      const getAdapter = vi.fn().mockRejectedValue(new Error('Adapter init failed'));

      // Should not throw; error is swallowed and pending log untouched
      await expect(runKstarBootRecovery(testUid, getAdapter)).resolves.not.toThrow();
      const result = await runKstarBootRecovery(testUid, getAdapter);
      expect(result.degraded).toBe(false);
      expect(result.replayed).toBe(0);
    });
  });

  // ── compactPendingEvidence idempotency ─────────────────────────────────

  describe('compactPendingEvidence idempotency', () => {
    test('compact on empty log is a no-op', async () => {
      // Should not throw even when the JSONL file does not yet exist
      await expect(
        compactPendingEvidence(testUid, (records) => records),
      ).resolves.not.toThrow();
    });

    test('compact with identity fold preserves all records', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-1', type: 'tool_cycle' });
      await appendPendingEvidence(testUid, { id: 'ev-2', type: 'tool_cycle' });

      await compactPendingEvidence(testUid, (records) => records);

      const logPath = getPendingEvidencePath(testUid);
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(2);
    });

    test('compact can deduplicate by id', async () => {
      await appendPendingEvidence(testUid, { id: 'ev-1', type: 'tool_cycle', delta_r: 0.1 });
      await appendPendingEvidence(testUid, { id: 'ev-1', type: 'tool_cycle', delta_r: 0.2 }); // duplicate
      await appendPendingEvidence(testUid, { id: 'ev-2', type: 'tool_cycle', delta_r: 0.3 });

      await compactPendingEvidence(testUid, (records) => {
        const seen = new Set<string>();
        return (records as Array<Record<string, unknown>>).filter((r) => {
          const id = String(r.id || '');
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      });

      const logPath = getPendingEvidencePath(testUid);
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).delta_r).toBe(0.1); // first occurrence kept
    });
  });
});
