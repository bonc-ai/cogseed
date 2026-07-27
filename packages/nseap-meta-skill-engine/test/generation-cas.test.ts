/**
 * Test: Generation CAS (Compare-And-Swap) semantics
 * Ensures mutations are linearizable and conflict-free
 */
import { describe, it, expect } from 'vitest';
import { createSnapshot, mutateSnapshot } from '../src/persistence/snapshot-state';

describe('Generation CAS semantics', () => {
  it('should accept mutation with correct base_generation', () => {
    const s1 = createSnapshot('skill-a');
    expect(s1.generation).toBe(1);

    const s2 = mutateSnapshot(s1, { name: 'Updated' });
    expect(s2.generation).toBe(2);
    expect(s2.name).toBe('Updated');
  });

  it('should reject mutation with incorrect base_generation', () => {
    const s1 = createSnapshot('skill-a');
    const s2 = mutateSnapshot(s1, { name: 'Branch A' });
    const s3 = mutateSnapshot(s2, { name: 'Branch A continued' });

    // s1 is now stale (current generation is 3)
    expect(() => {
      mutateSnapshot(s1, { name: 'Branch B' });
    }).toThrow(/SNAPSHOT_GENERATION_CONFLICT/);
  });

  it('should handle concurrent mutation attempts correctly', () => {
    const base = createSnapshot('skill-concurrent');

    // First mutation wins
    const winner = mutateSnapshot(base, { name: 'Winner' });
    expect(winner.generation).toBe(2);

    // Second mutation from same base fails
    expect(() => {
      mutateSnapshot(base, { name: 'Loser' });
    }).toThrow(/SNAPSHOT_GENERATION_CONFLICT/);
  });

  it('should allow retry after conflict with fresh generation', () => {
    const s1 = createSnapshot('skill-retry');
    const s2 = mutateSnapshot(s1, { name: 'First' });

    // Stale attempt fails
    expect(() => {
      mutateSnapshot(s1, { name: 'Stale' });
    }).toThrow();

    // Retry with fresh generation succeeds
    const s3 = mutateSnapshot(s2, { name: 'Fresh Retry' });
    expect(s3.generation).toBe(3);
    expect(s3.name).toBe('Fresh Retry');
  });
});
