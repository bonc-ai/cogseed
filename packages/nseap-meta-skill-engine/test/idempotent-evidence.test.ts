/**
 * Test: Idempotent evidence deduplication
 * Same evidence_id should not create duplicate episodes
 */
import { describe, it, expect } from 'vitest';
import { createSnapshot, addEvidence } from '../src/persistence/snapshot-state';

describe('Idempotent evidence contract', () => {
  it('should create episode for new evidence_id', () => {
    const snapshot = createSnapshot('skill-a');

    const updated = addEvidence(snapshot, {
      evidence_id: 'ev-001',
      task_description: 'Test task',
      outcome: 'success',
      timestamp: new Date().toISOString()
    });

    expect(updated.episodes).toHaveLength(1);
    expect(updated.episodes[0].evidence_id).toBe('ev-001');
  });

  it('should deduplicate same evidence_id without creating second episode', () => {
    const snapshot = createSnapshot('skill-b');

    const first = addEvidence(snapshot, {
      evidence_id: 'ev-duplicate',
      task_description: 'First attempt',
      outcome: 'success',
      timestamp: '2026-07-26T10:00:00Z'
    });

    expect(first.episodes).toHaveLength(1);

    // Second submission with same evidence_id
    const second = addEvidence(first, {
      evidence_id: 'ev-duplicate',
      task_description: 'Second attempt (should be ignored)',
      outcome: 'failure',
      timestamp: '2026-07-26T11:00:00Z'
    });

    // Should still have only 1 episode
    expect(second.episodes).toHaveLength(1);
    // Original episode preserved
    expect(second.episodes[0].task_description).toBe('First attempt');
    expect(second.episodes[0].outcome).toBe('success');
  });

  it('should increment generation even when evidence is deduplicated', () => {
    const s1 = createSnapshot('skill-c');

    const s2 = addEvidence(s1, {
      evidence_id: 'ev-gen-test',
      task_description: 'Task',
      outcome: 'success',
      timestamp: new Date().toISOString()
    });

    expect(s2.generation).toBe(2);

    // Duplicate evidence still increments generation
    const s3 = addEvidence(s2, {
      evidence_id: 'ev-gen-test',
      task_description: 'Duplicate',
      outcome: 'failure',
      timestamp: new Date().toISOString()
    });

    expect(s3.generation).toBe(3);
    expect(s3.episodes).toHaveLength(1); // Still only 1 episode
  });

  it('should allow different evidence_ids to create multiple episodes', () => {
    const snapshot = createSnapshot('skill-d');

    const s1 = addEvidence(snapshot, {
      evidence_id: 'ev-001',
      task_description: 'Task 1',
      outcome: 'success',
      timestamp: '2026-07-26T10:00:00Z'
    });

    const s2 = addEvidence(s1, {
      evidence_id: 'ev-002',
      task_description: 'Task 2',
      outcome: 'success',
      timestamp: '2026-07-26T11:00:00Z'
    });

    const s3 = addEvidence(s2, {
      evidence_id: 'ev-003',
      task_description: 'Task 3',
      outcome: 'failure',
      timestamp: '2026-07-26T12:00:00Z'
    });

    expect(s3.episodes).toHaveLength(3);
    expect(s3.episodes.map(e => e.evidence_id)).toEqual(['ev-001', 'ev-002', 'ev-003']);
  });
});
