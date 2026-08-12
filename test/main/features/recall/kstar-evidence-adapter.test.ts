/**
 * N1 pure layer: evidence grouping and candidate-input construction.
 *
 * Everything here runs without disk, IPC, engine, or renderer. The
 * side-effecting entry that would call `saveRecallCandidate` does not exist
 * yet, so nothing in this file asserts that a candidate was stored.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCandidateInput,
  groupEvidenceIntoRuns,
  makeRunKey,
  runAnchorRef,
  type EvidenceRecord,
  type EvidenceRun,
  type RecognizerOutput,
} from '../../../../src/main/features/recall/kstar-evidence-adapter';

const REAL = { mode: 'real', provider: 'meta-skill-engine-mcp' };

function toolCycle(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'tool-conv1-agent1-turn1-call1',
    type: 'tool_cycle',
    conversation_id: 'conv1',
    agent_id: 'agent1',
    turn_id: 'turn1',
    tool_name: 'read_file',
    status: 'succeeded',
    is_error: false,
    result_preview: 'read 40 lines',
    result_size: 1024,
    created_at: '2026-08-06T00:00:01.000Z',
    boundary: REAL,
    ...overrides,
  };
}

function contribution(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'contribution-conv1-agent1-turn1-msg1',
    type: 'conversation_message',
    conversation_id: 'conv1',
    agent_id: 'agent1',
    turn_id: 'turn1',
    message_id: 'msg1',
    actual_action: 'summarized the file',
    actual_result: 'produced a 3-point summary',
    outcome_status: 'completed',
    created_at: '2026-08-06T00:00:09.000Z',
    boundary: REAL,
    ...overrides,
  };
}

function runStart(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'run-start-conv1-agent1-turn1',
    type: 'agent_run_result',
    conversation_id: 'conv1',
    agent_id: 'agent1',
    turn_id: 'turn1',
    phase: 'start',
    created_at: '2026-08-06T00:00:00.000Z',
    boundary: REAL,
    ...overrides,
  };
}

function close(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: `collab-conv1-commander-${Date.now()}`,
    type: 'collaboration_close',
    conversation_id: 'conv1',
    commander_id: 'commander',
    outcome_status: 'completed',
    created_at: '2026-08-06T00:00:10.000Z',
    boundary: REAL,
    ...overrides,
  };
}

const RECOGNIZED: RecognizerOutput = { judgment: 'Summarize a long file before dispatching it.' };

function onlyRun(records: EvidenceRecord[]): EvidenceRun {
  const { runs } = groupEvidenceIntoRuns(records);
  expect(runs).toHaveLength(1);
  return runs[0];
}

// ── 6.1 Normal ───────────────────────────────────────────────

describe('normal aggregation', () => {
  it('N-1 folds a run of tool cycles plus a contribution into one candidate', () => {
    const run = onlyRun([
      runStart(),
      toolCycle({ id: 'tool-conv1-agent1-turn1-call1', created_at: '2026-08-06T00:00:01.000Z' }),
      toolCycle({ id: 'tool-conv1-agent1-turn1-call2', created_at: '2026-08-06T00:00:02.000Z' }),
      toolCycle({ id: 'tool-conv1-agent1-turn1-call3', created_at: '2026-08-06T00:00:03.000Z' }),
      contribution(),
    ]);

    expect(run.runKey).toBe(makeRunKey('conv1', 'agent1', 'turn1'));
    expect(run.toolCycles).toHaveLength(3);
    expect(run.contribution?.id).toBe('contribution-conv1-agent1-turn1-msg1');
    expect(run.startedAt).toBe('2026-08-06T00:00:00.000Z');

    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const kinds = built.input.sourceRefs as Array<{ kind: string; id: string }>;
    expect(kinds[0]).toMatchObject({ kind: 'execution', id: runAnchorRef(run.runKey).id });
    expect(kinds[1]).toMatchObject({ kind: 'conversation', id: 'conv1' });
    expect(kinds).toHaveLength(2 + 3 + 1);
  });

  it('N-2 orders tool cycles by created_at regardless of input order', () => {
    const run = onlyRun([
      toolCycle({ id: 'tool-c', created_at: '2026-08-06T00:00:03.000Z' }),
      toolCycle({ id: 'tool-a', created_at: '2026-08-06T00:00:01.000Z' }),
      toolCycle({ id: 'tool-b', created_at: '2026-08-06T00:00:02.000Z' }),
    ]);

    expect(run.toolCycles.map((r) => r.id)).toEqual(['tool-a', 'tool-b', 'tool-c']);

    // Stable ordering keeps the downstream fingerprint stable across replays.
    const shuffled = onlyRun([
      toolCycle({ id: 'tool-b', created_at: '2026-08-06T00:00:02.000Z' }),
      toolCycle({ id: 'tool-c', created_at: '2026-08-06T00:00:03.000Z' }),
      toolCycle({ id: 'tool-a', created_at: '2026-08-06T00:00:01.000Z' }),
    ]);
    const idsOf = (r: EvidenceRun) => {
      const built = buildCandidateInput(r, RECOGNIZED);
      return built.ok ? (built.input.sourceRefs as Array<{ id: string }>).map((x) => x.id) : [];
    };
    expect(idsOf(shuffled)).toEqual(idsOf(run));
  });

  it('N-3 passes a supplied confidence through untouched', () => {
    const run = onlyRun([toolCycle()]);
    const built = buildCandidateInput(run, { ...RECOGNIZED, confidence: 0.8125 });
    expect(built.ok && built.input.confidence).toBe(0.8125);
  });

  it('N-3b leaves confidence absent when the recognizer gives none', () => {
    const run = onlyRun([toolCycle()]);
    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok && 'confidence' in built.input).toBe(false);
  });

  it('N-4 defaults type and scope when the recognizer omits them', () => {
    const run = onlyRun([toolCycle()]);
    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok && built.input.suggestedType).toBe('skill_method');
    expect(built.ok && built.input.suggestedScope).toBe('agent:agent1');
  });

  it('N-4b honours recognizer-supplied type and scope', () => {
    const run = onlyRun([toolCycle()]);
    const built = buildCandidateInput(run, { ...RECOGNIZED, suggestedType: 'rule', suggestedScope: 'global' });
    expect(built.ok && built.input.suggestedType).toBe('rule');
    expect(built.ok && built.input.suggestedScope).toBe('global');
  });

  it('keeps only the last contribution when a run reports more than one', () => {
    const run = onlyRun([
      contribution({ id: 'contribution-1', message_id: 'msg1', created_at: '2026-08-06T00:00:05.000Z' }),
      contribution({ id: 'contribution-2', message_id: 'msg2', created_at: '2026-08-06T00:00:07.000Z' }),
    ]);
    expect(run.contribution?.id).toBe('contribution-2');
  });
});

// ── 6.2 Missing ──────────────────────────────────────────────

describe('missing input', () => {
  it('M-1 skips with no_judgment and builds nothing', () => {
    const run = onlyRun([toolCycle(), contribution()]);
    for (const verdict of [null, { judgment: '' }, { judgment: '   ' }] as Array<RecognizerOutput | null>) {
      const built = buildCandidateInput(run, verdict);
      expect(built).toEqual({ ok: false, reason: 'no_judgment' });
    }
  });

  it('M-2 refuses to attribute a record missing turn_id', () => {
    const { runs, unattributed } = groupEvidenceIntoRuns([toolCycle({ turn_id: undefined })]);
    expect(runs).toHaveLength(0);
    expect(unattributed).toEqual([
      { evidenceId: 'tool-conv1-agent1-turn1-call1', reason: 'incomplete_run' },
    ]);
  });

  it('M-2b requires all three of conversation, agent and turn', () => {
    for (const missing of ['conversation_id', 'agent_id', 'turn_id'] as const) {
      const { runs, unattributed } = groupEvidenceIntoRuns([toolCycle({ [missing]: '' })]);
      expect(runs, `missing ${missing}`).toHaveLength(0);
      expect(unattributed[0].reason).toBe('incomplete_run');
    }
  });

  it('M-3 treats collaboration_close as a conversation signal, never a run', () => {
    const { runs, closes, unattributed } = groupEvidenceIntoRuns([close()]);
    expect(runs).toHaveLength(0);
    expect(unattributed).toHaveLength(0);
    expect(closes).toEqual([
      { conversationId: 'conv1', outcomeStatus: 'completed', evidenceId: expect.stringContaining('collab-conv1-commander-') },
    ]);
  });

  it('M-3b keeps a close out of the run key even when it sits beside real work', () => {
    const { runs, closes } = groupEvidenceIntoRuns([toolCycle(), close(), contribution()]);
    expect(runs).toHaveLength(1);
    expect(runs[0].toolCycles).toHaveLength(1);
    expect(closes).toHaveLength(1);
    // The close has no agent_id/turn_id; folding it in would corrupt the key.
    expect(runs[0].runKey).toBe(makeRunKey('conv1', 'agent1', 'turn1'));
  });

  it('M-4 skips a run whose only record is the start marker', () => {
    const run = onlyRun([runStart()]);
    expect(buildCandidateInput(run, RECOGNIZED)).toEqual({ ok: false, reason: 'no_evidence_refs' });
  });
});

// ── 6.3 Duplicate ────────────────────────────────────────────

describe('duplicates within a batch', () => {
  it('D-1 collapses a record repeated in the same batch', () => {
    const run = onlyRun([toolCycle(), toolCycle(), toolCycle()]);
    expect(run.toolCycles).toHaveLength(1);
  });

  it('D-3 dedups replayed pending evidence by evidence id', () => {
    const run = onlyRun([
      toolCycle({ id: 'tool-a', created_at: '2026-08-06T00:00:01.000Z' }),
      toolCycle({ id: 'tool-b', created_at: '2026-08-06T00:00:02.000Z' }),
      toolCycle({ id: 'tool-a', created_at: '2026-08-06T00:00:01.000Z' }),
    ]);
    expect(run.toolCycles.map((r) => r.id)).toEqual(['tool-a', 'tool-b']);
  });

  it('D-4 keeps two distinct runs apart even with an identical judgment', () => {
    const { runs } = groupEvidenceIntoRuns([
      toolCycle({ id: 'tool-x', turn_id: 'turnA' }),
      toolCycle({ id: 'tool-y', turn_id: 'turnB' }),
    ]);
    expect(runs).toHaveLength(2);

    const anchors = runs.map((r) => {
      const built = buildCandidateInput(r, RECOGNIZED);
      return built.ok ? (built.input.sourceRefs as Array<{ id: string }>)[0].id : '';
    });
    expect(anchors[0]).not.toBe(anchors[1]);
  });

  it('produces a stable anchor for the same run key and distinct ones otherwise', () => {
    expect(runAnchorRef('a::b::c').id).toBe(runAnchorRef('a::b::c').id);
    expect(runAnchorRef('a::b::c').id).not.toBe(runAnchorRef('a::b::d').id);
  });

  it('anchors survive normalization, which drops ids outside [A-Za-z0-9_-]', () => {
    // The run key contains "::"; a raw key as the ref id would be discarded and
    // the anchor would silently disappear.
    const anchor = runAnchorRef(makeRunKey('conv1', 'agent1', 'turn1'));
    expect(anchor.id).toMatch(/^run-[0-9a-f]{16}$/);
    expect(anchor.title).toContain('conv1');
  });

  it('does not claim cross-batch deduplication', () => {
    // Same batch content, two separate calls: the pure layer has no memory, so
    // both produce the run. Skipping already-ingested runs needs stored
    // candidates, which belongs to the side-effecting entry.
    const batch = [toolCycle(), contribution()];
    expect(groupEvidenceIntoRuns(batch).runs).toHaveLength(1);
    expect(groupEvidenceIntoRuns(batch).runs).toHaveLength(1);
  });
});

// ── 6.4 Invalid / hostile ────────────────────────────────────

describe('invalid and hostile input', () => {
  it('I-1 refuses a run built on degraded evidence', () => {
    const run = onlyRun([toolCycle({ boundary: { mode: 'degraded', reason: 'engine_unavailable' } }), contribution()]);
    expect(run.degraded).toBe(true);
    expect(buildCandidateInput(run, RECOGNIZED)).toEqual({ ok: false, reason: 'degraded_evidence' });
  });

  it('I-1b treats a missing boundary as degraded rather than assuming real', () => {
    const run = onlyRun([toolCycle({ boundary: undefined }), contribution()]);
    expect(run.degraded).toBe(true);
  });

  it('I-1c marks the whole run degraded when any single member is', () => {
    const run = onlyRun([
      toolCycle({ id: 'tool-a' }),
      toolCycle({ id: 'tool-b', boundary: { mode: 'degraded' } }),
    ]);
    expect(run.degraded).toBe(true);
  });

  it('I-2 redacts credentials out of result_preview', () => {
    const run = onlyRun([
      toolCycle({ result_preview: 'called api with Authorization: Bearer sk-secret-value-123' }),
      contribution({ actual_result: 'token=super-secret-token done' }),
    ]);
    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok).toBe(true);
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain('sk-secret-value-123');
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).toContain('[REDACTED]');
  });

  it('I-3 truncates an oversized preview', () => {
    const run = onlyRun([toolCycle({ result_preview: 'x'.repeat(10_000) })]);
    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refs = built.input.sourceRefs as Array<{ excerpt?: string }>;
    for (const ref of refs) {
      if (ref.excerpt) expect(ref.excerpt.length).toBeLessThanOrEqual(240);
    }
  });

  it('I-4 never lets arguments_shape reach the candidate', () => {
    const run = onlyRun([
      toolCycle({
        arguments_shape: { path: '/Users/someone/private/secrets.txt', query: 'internal-project-codename' },
      }),
    ]);
    const built = buildCandidateInput(run, RECOGNIZED);
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain('secrets.txt');
    expect(serialized).not.toContain('internal-project-codename');
    expect(serialized).not.toContain('arguments_shape');
  });

  it('I-5 caps source refs while keeping both anchors and the outcome', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      toolCycle({ id: `tool-${String(i).padStart(4, '0')}`, created_at: `2026-08-06T00:${String(i % 60).padStart(2, '0')}:00.000Z` }));
    const run = onlyRun([...many, contribution()]);

    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refs = built.input.sourceRefs as Array<{ kind: string; id: string }>;

    expect(refs.length).toBeLessThanOrEqual(100);
    expect(refs[0].id).toBe(runAnchorRef(run.runKey).id);
    expect(refs[1]).toMatchObject({ kind: 'conversation', id: 'conv1' });
    expect(refs[refs.length - 1]).toMatchObject({ kind: 'conversation', id: 'msg1' });
  });

  it('I-6 skips malformed records without aborting the batch', () => {
    const { runs, unattributed } = groupEvidenceIntoRuns([
      null,
      undefined,
      'a string',
      42,
      [],
      { type: 'tool_cycle' },
      toolCycle(),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].toolCycles).toHaveLength(1);
    expect(unattributed.filter((u) => u.reason === 'malformed').length).toBeGreaterThanOrEqual(5);
  });

  it('I-6b tolerates a non-array batch', () => {
    expect(groupEvidenceIntoRuns(undefined as never)).toEqual({ runs: [], closes: [], unattributed: [] });
  });

  it('drops a ref whose id would not survive normalization', () => {
    // Ids outside [A-Za-z0-9_-] are discarded downstream; counting them here
    // would overstate how much evidence the candidate actually carries.
    const run = onlyRun([toolCycle({ id: 'tool/with/slashes' })]);
    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const ids = (built.input.sourceRefs as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain('tool/with/slashes');
  });
});

// ── 6.5 Cross-session ────────────────────────────────────────

describe('cross-session behaviour', () => {
  it('X-1 separates the same agent working in two conversations', () => {
    const { runs } = groupEvidenceIntoRuns([
      toolCycle({ id: 'tool-1', conversation_id: 'convA' }),
      toolCycle({ id: 'tool-2', conversation_id: 'convB' }),
    ]);
    expect(runs.map((r) => r.conversationId).sort()).toEqual(['convA', 'convB']);
  });

  it('X-2 separates two agents inside one conversation', () => {
    const { runs } = groupEvidenceIntoRuns([
      toolCycle({ id: 'tool-1', agent_id: 'agentA' }),
      toolCycle({ id: 'tool-2', agent_id: 'agentB' }),
    ]);
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.toolCycles).toHaveLength(1);
  });

  it('X-3 separates two turns of the same agent', () => {
    const { runs } = groupEvidenceIntoRuns([
      toolCycle({ id: 'tool-1', turn_id: 'turn1' }),
      toolCycle({ id: 'tool-2', turn_id: 'turn2' }),
    ]);
    expect(runs.map((r) => r.turnId).sort()).toEqual(['turn1', 'turn2']);
  });

  it('X-4 emits the conversation ref that sourceSessionIds is derived from', () => {
    // N2 builds an asset's sourceSessionIds from conversation-kind refs, so the
    // candidate must carry one for that derivation to find anything.
    const run = onlyRun([toolCycle({ conversation_id: 'convX' })]);
    const built = buildCandidateInput(run, RECOGNIZED);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const conversationRefs = (built.input.sourceRefs as Array<{ kind: string; id: string }>)
      .filter((r) => r.kind === 'conversation');
    expect(conversationRefs.map((r) => r.id)).toContain('convX');
  });
});

// ── Purity ───────────────────────────────────────────────────

describe('purity', () => {
  it('does not mutate the records it is given', () => {
    const records = [toolCycle(), contribution(), close()];
    const before = JSON.stringify(records);
    const { runs } = groupEvidenceIntoRuns(records);
    buildCandidateInput(runs[0], RECOGNIZED);
    expect(JSON.stringify(records)).toBe(before);
  });

  it('imports nothing that performs IO', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      new URL('../../../../src/main/features/recall/kstar-evidence-adapter.ts', import.meta.url),
      'utf8',
    );
    // Check the import statements, not prose: comments legitimately name the
    // store functions this layer stays away from.
    const imports = [...source.matchAll(/^import[^;]+from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      '../../storage',        // safeId, a pure validator
      './candidate-service',  // types only
      './source-service',     // shared redaction
      'node:crypto',          // anchor digest
    ].sort());

    // And no runtime call into the persisting layer.
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toContain('saveRecallCandidate(');
    expect(withoutComments).not.toContain('writeRecall');
    expect(withoutComments).not.toContain('readRecall');
  });
});
