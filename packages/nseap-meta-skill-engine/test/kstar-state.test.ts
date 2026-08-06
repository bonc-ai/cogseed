import { describe, expect, it } from 'vitest';
import {
  KstarState,
  KSTAR_SCHEMA_VERSION,
  computeStateHash,
  createEmptyState,
  parseState,
} from '../src/persistence/kstar-state';

/** Evidence in the shape features/p3394/kstar-bus-integration.ts actually sends. */
function toolCycleEvidence(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'tool_cycle',
    conversation_id: 'c1',
    agent_id: 'a1',
    turn_id: 't1',
    tool_name: 'read_file',
    status: 'succeeded',
    ...overrides,
  };
}

describe('KstarState round-trip', () => {
  it('exports a snapshot that imports back unchanged', () => {
    const a = new KstarState();
    a.recordEvidence(toolCycleEvidence('tool-c1-a1-t1-call1'));
    a.recordEvidence(toolCycleEvidence('tool-c1-a1-t1-call2'));
    const exported = a.export();

    const b = new KstarState();
    const { generation, evidence_count } = b.import(exported);

    expect(generation).toBe(2);
    expect(evidence_count).toBe(2);
    expect(b.export()).toEqual(exported);
  });

  it('survives a JSON serialization hop, as the PC snapshot file does', () => {
    const a = new KstarState();
    a.recordEvidence(toolCycleEvidence('tool-1'));
    const onDisk = JSON.parse(JSON.stringify(a.export()));

    const b = new KstarState();
    expect(() => b.import(onDisk)).not.toThrow();
    expect(b.export().evidence).toHaveLength(1);
  });

  it('accumulates across process restarts instead of starting over', () => {
    // Restart is what makes this matter: a fresh engine hydrated from disk must
    // append to prior history rather than replace it.
    const first = new KstarState();
    first.recordEvidence(toolCycleEvidence('run-1'));
    const afterFirst = first.export();

    const second = new KstarState();
    second.import(afterFirst);
    second.recordEvidence(toolCycleEvidence('run-2'));
    const afterSecond = second.export();

    expect(afterSecond.evidence.map((e) => e.id)).toEqual(['run-1', 'run-2']);
    expect(afterSecond.generation).toBe(2);
  });

  it('keeps evidence fields the engine has no schema for', () => {
    const state = new KstarState();
    state.recordEvidence(
      toolCycleEvidence('tool-1', {
        boundary: { epoch: 3, sender: 'agent-x' },
        result_size: 2048,
        delta_r: 0.25,
      }),
    );

    const [record] = state.export().evidence;
    expect(record.boundary).toEqual({ epoch: 3, sender: 'agent-x' });
    expect(record.result_size).toBe(2048);
    expect(record.delta_r).toBe(0.25);
  });
});

describe('KstarState deduplication', () => {
  it('treats a repeated id as a no-op', () => {
    const state = new KstarState();
    const first = state.recordEvidence(toolCycleEvidence('tool-1'));
    const before = state.export();
    const second = state.recordEvidence(toolCycleEvidence('tool-1', { status: 'failed' }));
    const after = state.export();

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(after.evidence).toHaveLength(1);
    // Pending-evidence replay re-sends records after an outage, so a duplicate
    // must not bump the generation or rewrite the snapshot.
    expect(after).toEqual(before);
  });

  it('rejects evidence without a usable id', () => {
    const state = new KstarState();
    expect(() => state.recordEvidence({ type: 'tool_cycle' })).toThrow(/id is required/);
    expect(() => state.recordEvidence({ id: '', type: 'tool_cycle' })).toThrow(/id is required/);
    expect(() => state.recordEvidence({ id: 42 })).toThrow(/id is required/);
    expect(() => state.recordEvidence(null)).toThrow(/must be an object/);
    expect(() => state.recordEvidence([])).toThrow(/must be an object/);
  });
});

describe('parseState validation', () => {
  function validSnapshot() {
    const state = new KstarState();
    state.recordEvidence(toolCycleEvidence('tool-1'));
    return state.export();
  }

  it('accepts an empty freshly created state', () => {
    expect(() => parseState(createEmptyState())).not.toThrow();
  });

  it('rejects a snapshot whose hash does not match its contents', () => {
    const tampered = validSnapshot();
    tampered.evidence[0].status = 'failed';
    expect(() => parseState(tampered)).toThrow(/snapshot_hash mismatch/);
  });

  it('rejects a truncated evidence list even when the rest looks intact', () => {
    const truncated = validSnapshot();
    truncated.evidence = [];
    expect(() => parseState(truncated)).toThrow(/snapshot_hash mismatch/);
  });

  it('rejects an unknown schema_version rather than guessing', () => {
    const future = { ...validSnapshot(), schema_version: KSTAR_SCHEMA_VERSION + 1 };
    expect(() => parseState(future)).toThrow(/unsupported schema_version/);
  });

  it('rejects structurally broken snapshots', () => {
    expect(() => parseState(null)).toThrow(/empty/);
    expect(() => parseState(undefined)).toThrow(/empty/);
    expect(() => parseState('{}')).toThrow(/must be an object/);
    expect(() => parseState([])).toThrow(/must be an object/);
    expect(() => parseState({ ...validSnapshot(), generation: -1 })).toThrow(/non-negative integer/);
    expect(() => parseState({ ...validSnapshot(), generation: 1.5 })).toThrow(/non-negative integer/);
    expect(() => parseState({ ...validSnapshot(), evidence: {} })).toThrow(/must be an array/);
  });

  it('rejects an evidence entry that lost its id', () => {
    const broken = validSnapshot();
    (broken.evidence as unknown[])[0] = { type: 'tool_cycle' };
    expect(() => parseState(broken)).toThrow(/missing a string id/);
  });
});

describe('computeStateHash', () => {
  it('ignores key insertion order', () => {
    const state = new KstarState();
    state.recordEvidence(toolCycleEvidence('tool-1'));
    const snapshot = state.export();
    const reordered = {
      updated_at: snapshot.updated_at,
      evidence: snapshot.evidence,
      created_at: snapshot.created_at,
      snapshot_hash: snapshot.snapshot_hash,
      generation: snapshot.generation,
      schema_version: snapshot.schema_version,
    };

    expect(computeStateHash(reordered)).toBe(computeStateHash(snapshot));
  });

  it('changes when any recorded field changes', () => {
    const state = new KstarState();
    state.recordEvidence(toolCycleEvidence('tool-1'));
    const snapshot = state.export();
    const mutated = {
      ...snapshot,
      evidence: [{ ...snapshot.evidence[0], status: 'failed' }],
    };

    expect(computeStateHash(mutated)).not.toBe(computeStateHash(snapshot));
  });
});
