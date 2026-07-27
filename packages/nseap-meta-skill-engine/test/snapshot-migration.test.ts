/**
 * Test: Snapshot migration contract
 */
import { describe, it, expect } from 'vitest';
import { migrateSnapshot, getCurrentSchemaVersion } from '../src/migration/snapshot-migrations';

describe('Snapshot migration', () => {
  it('should identify current schema version', () => {
    const version = getCurrentSchemaVersion();
    expect(version).toBe('1.0.0');
  });

  it('should migrate v0.9.0 snapshot to v1.0.0', () => {
    const v090Snapshot = {
      skill_id: 'test-skill',
      version: 1, // old field name
      hash: 'abc123', // old field name
      episodes: [],
      created: '2026-01-01T00:00:00Z', // old field name
      updated: '2026-01-01T00:00:00Z' // old field name
    };

    const migrated = migrateSnapshot(v090Snapshot, '0.9.0');

    expect(migrated.generation).toBe(1);
    expect(migrated.snapshot_hash).toBeTruthy();
    expect(migrated.created_at).toBe('2026-01-01T00:00:00Z');
    expect(migrated.updated_at).toBe('2026-01-01T00:00:00Z');
    expect(migrated).not.toHaveProperty('version');
    expect(migrated).not.toHaveProperty('hash');
  });

  it('should handle missing optional fields gracefully', () => {
    const minimalSnapshot = {
      skill_id: 'minimal',
      version: 1,
      episodes: []
    };

    const migrated = migrateSnapshot(minimalSnapshot, '0.9.0');

    expect(migrated.generation).toBe(1);
    expect(migrated.created_at).toBeTruthy();
    expect(migrated.updated_at).toBeTruthy();
  });

  it('should preserve episodes during migration', () => {
    const snapshotWithEpisodes = {
      skill_id: 'test',
      version: 2,
      episodes: [
        { evidence_id: 'ev1', task: 'Task 1', outcome: 'success', timestamp: '2026-01-01T00:00:00Z' }
      ]
    };

    const migrated = migrateSnapshot(snapshotWithEpisodes, '0.9.0');

    expect(migrated.episodes).toHaveLength(1);
    expect(migrated.episodes[0].evidence_id).toBe('ev1');
  });

  it('should be idempotent for current version snapshots', () => {
    const currentSnapshot = {
      skill_id: 'current',
      generation: 3,
      snapshot_hash: 'xyz789',
      episodes: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z'
    };

    const migrated = migrateSnapshot(currentSnapshot, '1.0.0');

    expect(migrated).toEqual(currentSnapshot);
  });
});
