/**
 * Test: Snapshot contract enforcement
 * Covers: generation CAS, conflict detection, base_generation validation
 */
import { describe, it, expect } from 'vitest';
import type { SkillSnapshot } from '../src/types/snapshot';
import { createSnapshot, mutateSnapshot } from '../src/persistence/snapshot-state';

describe('Snapshot generation contract', () => {
  it('should increment generation exactly once per mutation', () => {
    const initial = createSnapshot('test-skill');
    expect(initial.generation).toBe(1);

    const updated = mutateSnapshot(initial, { name: 'Test Skill' });
    expect(updated.generation).toBe(2);

    const secondUpdate = mutateSnapshot(updated, { category: 'test' });
    expect(secondUpdate.generation).toBe(3);
  });

  it('should throw SNAPSHOT_GENERATION_CONFLICT on stale base_generation', () => {
    const initial = createSnapshot('test-skill');
    const updated = mutateSnapshot(initial, { name: 'First Update' });

    // Attempt to mutate from stale generation
    expect(() => {
      mutateSnapshot(initial, { name: 'Stale Update' });
    }).toThrow(/SNAPSHOT_GENERATION_CONFLICT/);
  });

  it('should preserve generation on read operations', () => {
    const snapshot = createSnapshot('test-skill');
    const cloned = JSON.parse(JSON.stringify(snapshot));
    expect(cloned.generation).toBe(snapshot.generation);
  });

  it('should include generation in stable hash computation', () => {
    const s1 = createSnapshot('test-skill');
    const s2 = mutateSnapshot(s1, {});

    // Same content, different generation = different hash
    expect(s1.snapshot_hash).not.toBe(s2.snapshot_hash);
  });
});
