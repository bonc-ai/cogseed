import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid-collab';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-collab-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(tmpDir, 'data');
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('group_chat collaboration › storage layout', () => {
  it('places workflow state under the conversation group directory', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const paths = c.collaborationPaths(TEST_UID, TEST_CID);
    expect(paths.rootDir).toBe(path.join(tmpDir, 'data', TEST_UID, 'cloud', 'chats', TEST_CID, 'collaboration'));
    expect(paths.runsDir).toBe(path.join(paths.rootDir, 'workflow_runs'));
    expect(paths.contextsDir).toBe(path.join(paths.rootDir, 'workflow_contexts'));
    expect(paths.activeFile).toBe(path.join(paths.rootDir, 'active.json'));
    expect(paths.eventsFile).toBe(path.join(paths.rootDir, 'events.jsonl'));
  });

  it('returns null when no active workflow exists', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    await expect(c.readActiveWorkflowRun(TEST_UID, TEST_CID)).resolves.toBeNull();
    await expect(c.readActiveSharedTaskContext(TEST_UID, TEST_CID)).resolves.toBeNull();
  });
});

describe('group_chat collaboration › workflow lifecycle', () => {
  it('plans pending workflow steps and starts only dependency-ready steps', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Plan before dispatch',
      kind: 'implementation',
      created_by: 'commander',
    });

    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: 'Research options', actor_id: 'researcher', type: 'discussion_round' },
    ]);
    const first = planned.steps[0];
    const plannedNext = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: 'Implement chosen option', actor_id: 'coder', type: 'implementation', depends_on: [first.id] },
    ]);
    const second = plannedNext.steps[1];

    await expect(c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, second.id)).rejects.toThrow(/dependencies are not completed/);
    const started = await c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, first.id);
    expect(started.status).toBe('running');
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, first.id, {
      status: 'completed',
      result_summary: 'Research done.',
    });
    const startedSecond = await c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, second.id);
    expect(startedSecond.status).toBe('running');

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 20);
    expect(events.map((event) => event.type)).toContain('workflow_planned');
  });

  it('creates an active workflow run with an empty shared context', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const created = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Coordinate Hermes and Codex',
      kind: 'discussion',
      created_by: 'commander',
    });

    expect(created.run.status).toBe('running');
    expect(created.run.phase).toBe('created');
    expect(created.run.context_id).toBe(created.context.id);
    expect(created.context.objective).toBe('Coordinate Hermes and Codex');
    expect(created.context.facts).toEqual([]);

    const activeRun = await c.readActiveWorkflowRun(TEST_UID, TEST_CID);
    const activeContext = await c.readActiveSharedTaskContext(TEST_UID, TEST_CID);
    expect(activeRun?.id).toBe(created.run.id);
    expect(activeContext?.id).toBe(created.context.id);
  });

  it('reuses the active running workflow for ensureActiveWorkflowRun', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const first = await c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'First objective',
      kind: 'custom',
      created_by: 'commander',
    });
    const second = await c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Second objective',
      kind: 'custom',
      created_by: 'commander',
    });
    expect(second.run.id).toBe(first.run.id);
    expect(second.context.id).toBe(first.context.id);
    expect(second.run.objective).toBe('First objective');
  });
});

describe('group_chat collaboration › steps and gates', () => {
  it('starts and completes a dispatch step with a passing evidence gate', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Coordinate agents',
      kind: 'discussion',
      created_by: 'commander',
    });

    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Ask reviewer',
      actor_id: 'reviewer',
      type: 'dispatch',
      source_tool: 'dispatch_to',
    });
    expect(step.status).toBe('running');

    const completed = await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: 'completed',
      result_summary: 'Reviewer found no blockers.',
    });
    expect(completed.status).toBe('completed');

    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: 'dispatch_result_present',
      status: 'passed',
      checks: [{ name: 'result_summary_present', status: 'passed' }],
    });
    expect(gate.status).toBe('passed');

    const next = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(next?.steps[0].gate_result_id).toBe(gate.id);
    const context = await c.readActiveSharedTaskContext(TEST_UID, TEST_CID);
    expect(context?.gates.map((g) => g.id)).toContain(gate.id);
  });

  it('records failed steps without marking the whole run completed', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Coordinate agents',
      kind: 'discussion',
      created_by: 'commander',
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Ask tester',
      actor_id: 'tester',
      type: 'dispatch',
      source_tool: 'run_worker',
    });
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: 'failed',
      result_summary: 'Tester failed to run.',
    });
    const next = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(next?.status).toBe('running');
    expect(next?.steps[0].status).toBe('failed');
  });
});

describe('group_chat collaboration › workflow controls', () => {
  it('retries, skips, resumes, and aborts workflow runs', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Control workflow',
      kind: 'implementation',
      created_by: 'commander',
    });
    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: 'Implement', actor_id: 'coder', type: 'implementation' },
    ]);
    const step = planned.steps[0];
    await c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, step.id);
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: 'failed',
      result_summary: 'Tests failed.',
    });

    const retry = await c.retryWorkflowStep(TEST_UID, TEST_CID, run.id, step.id);
    expect(retry.status).toBe('pending');
    const skipped = await c.skipWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, 'Not needed.');
    expect(skipped.status).toBe('skipped');
    const resumed = await c.resumeWorkflowRun(TEST_UID, TEST_CID, run.id, 'Continue manually.');
    expect(resumed.status).toBe('running');
    const aborted = await c.abortWorkflowRun(TEST_UID, TEST_CID, run.id, 'User stopped.');
    expect(aborted.status).toBe('cancelled');

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 30);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'step_retried',
      'step_skipped',
      'workflow_resumed',
      'workflow_aborted',
    ]));
  });
});

describe('group_chat collaboration › context patches', () => {
  it('merges facts, proposed decisions, risks, open questions, and artifacts', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Shared state design',
      kind: 'discussion',
      created_by: 'commander',
    });

    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'reviewer',
      facts_add: [{ text: 'events.jsonl is append-only', source: 'agent', confidence: 'high' }],
      decisions_proposed: [{ text: 'Use JSONL as the source of truth', source: 'agent', confidence: 'high', reason: 'It avoids snapshot overwrite loss.' }],
      risks_add: [{ text: 'Markdown snapshots can go stale', source: 'agent', confidence: 'medium', severity: 'medium' }],
      open_questions_add: [{ text: 'Do we need a helper command?', source: 'agent', confidence: 'medium' }],
      artifacts_add: [{ id: 'artifact-1', type: 'research_note', path: 'docs/research/tutti-agent-communication.md', summary: 'Tutti research note' }],
    });

    expect(updated.facts.map((item) => item.text)).toContain('events.jsonl is append-only');
    expect(updated.decisions.map((item) => item.text)).toContain('Use JSONL as the source of truth');
    expect(updated.risks[0].severity).toBe('medium');
    expect(updated.open_questions[0].text).toBe('Do we need a helper command?');
    expect(updated.artifacts[0].id).toBe('artifact-1');
  });

  it('keeps conflicting decisions out of decisions and records them as open questions', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Conflict handling',
      kind: 'discussion',
      created_by: 'commander',
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-a',
      decisions_proposed: [{ text: 'Do not use Redis for local POC', source: 'agent', confidence: 'high' }],
    });
    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-b',
      decisions_proposed: [{ text: 'Use Redis for local POC', source: 'agent', confidence: 'high', conflicts_with: ['Do not use Redis for local POC'] }],
    });
    expect(updated.decisions.map((item) => item.text)).toEqual(['Do not use Redis for local POC']);
    expect(updated.open_questions.some((item) => item.text.includes('Conflicting decision proposed'))).toBe(true);
  });

  it('writes an append-only collaboration event for each context patch', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Audit context patches',
      kind: 'discussion',
      created_by: 'commander',
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-a',
      summary: 'Added audit fact',
      facts_add: [{ text: 'Context patches are audited' }],
    });

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 10);
    expect(events.map((event) => event.type)).toEqual(['workflow_created', 'context_patch_applied']);
    expect(events[1]).toMatchObject({
      run_id: context.run_id,
      context_id: context.id,
      actor_id: 'agent-a',
      summary: 'Added audit fact',
      payload: expect.objectContaining({ facts_added: 1 }),
    });
  });

  it('builds a compact shared context summary', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Summarize context',
      kind: 'discussion',
      created_by: 'commander',
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-a',
      facts_add: [{ text: 'Fact A', source: 'agent', confidence: 'high' }],
      decisions_proposed: [{ text: 'Decision A', source: 'agent', confidence: 'high' }],
    });
    const summary = await c.buildSharedContextSummary(TEST_UID, TEST_CID, context.id);
    expect(summary).toContain('Objective: Summarize context');
    expect(summary).toContain('- Fact A');
    expect(summary).toContain('- Decision A');
  });
});

describe('group_chat collaboration › nested dispatch recording', () => {
  it('recordNestedDispatchStep wraps a successful nested dispatch result', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const recorded = await c.recordNestedDispatchStep(TEST_UID, TEST_CID, {
      objective: 'User asks for review',
      actor_id: 'reviewer',
      actor_name: 'Reviewer',
      source_tool: 'dispatch_to',
      task: 'Review the plan',
      result: 'No blockers.',
    });
    expect(recorded.step.status).toBe('completed');
    expect(recorded.gate.status).toBe('passed');
    expect(recorded.run.steps).toHaveLength(1);
    expect(recorded.context.agent_outputs[recorded.step.id].summary).toBe('No blockers.');
  });

  it('marks empty nested dispatch results as needs_review without blocking later dispatches', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const recorded = await c.recordNestedDispatchStep(TEST_UID, TEST_CID, {
      objective: 'User asks for review',
      actor_id: 'reviewer',
      actor_name: 'Reviewer',
      source_tool: 'dispatch_to',
      task: 'Review the plan',
      result: '   ',
    });
    expect(recorded.step.status).toBe('completed');
    expect(recorded.gate.status).toBe('needs_review');
    expect(recorded.gate.reason).toBe('Nested dispatch returned an empty result.');
    expect(recorded.run.status).toBe('running');
    expect(recorded.run.phase).toBe('dispatch');

    const followup = await c.recordNestedDispatchStep(TEST_UID, TEST_CID, {
      objective: 'User asks for review',
      actor_id: 'coder',
      actor_name: 'Coder',
      source_tool: 'run_worker',
      task: 'Continue after empty reviewer result',
      result: 'Follow-up completed.',
    });
    expect(followup.run.status).toBe('running');
    expect(followup.run.steps).toHaveLength(2);
    expect(followup.gate.status).toBe('passed');
    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);
    expect(snapshot?.blocking_gate).toBeUndefined();
  });
});


describe('group_chat collaboration › gate control flow', () => {
  it('blocks new workflow steps when a gate needs review, then resumes after approval', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Gate controlled workflow',
      kind: 'review',
      created_by: 'commander',
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Review output',
      actor_id: 'reviewer',
      type: 'review',
    });
    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: 'human_review',
      status: 'needs_review',
      reason: 'Needs a human decision.',
      checks: [{ name: 'human_review_required', status: 'needs_review' }],
    });

    const blockedRun = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(blockedRun?.status).toBe('blocked');
    expect(blockedRun?.phase).toBe('gate_needs_review');
    await expect(c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Should not start',
      actor_id: 'coder',
      type: 'implementation',
    })).rejects.toThrow(/workflow run is blocked by gate/);

    const approved = await c.reviewCollaborationGate(TEST_UID, TEST_CID, gate.id, {
      decision: 'approve',
      reviewed_by: 'user',
      reason: 'Looks good.',
    });
    expect(approved.run.status).toBe('running');
    expect(approved.gate.status).toBe('passed');
    expect(approved.gate.review_decision).toBe('approved');

    const next = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Continue',
      actor_id: 'coder',
      type: 'implementation',
    });
    expect(next.status).toBe('running');

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 20);
    expect(events.map((event) => event.type)).toContain('gate_reviewed');
  });

  it('marks dependent pending steps blocked by a gate and unblocks them after approval', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Dependency gate workflow',
      kind: 'implementation',
      created_by: 'commander',
    });
    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: 'Review checkpoint', actor_id: 'reviewer', type: 'gate' },
    ]);
    const gateStep = planned.steps[0];
    const withDependent = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: 'Dependent implementation', actor_id: 'coder', type: 'implementation', depends_on: [gateStep.id] },
    ]);
    const dependent = withDependent.steps[1];
    await c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, gateStep.id);
    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, gateStep.id, {
      name: 'review_gate',
      status: 'needs_review',
      reason: 'Needs approval.',
      checks: [{ name: 'approval', status: 'needs_review' }],
    });

    let blockedRun = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(blockedRun?.steps.find((step) => step.id === dependent.id)?.status).toBe('blocked');

    await c.reviewCollaborationGate(TEST_UID, TEST_CID, gate.id, {
      decision: 'approve',
      reviewed_by: 'user',
    });
    blockedRun = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(blockedRun?.steps.find((step) => step.id === dependent.id)?.status).toBe('pending');
  });

  it('injects a blocking gate instruction into shared context prompt blocks', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Prompt gate awareness',
      kind: 'review',
      created_by: 'commander',
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Human review',
      actor_id: 'reviewer',
      type: 'gate',
    });
    await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: 'human_review',
      status: 'needs_review',
      reason: 'Manual confirmation is required.',
      checks: [{ name: 'manual_confirmation', status: 'needs_review' }],
    });

    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);
    expect(snapshot?.blocking_gate?.name).toBe('human_review');
    const block = await bus._buildActiveSharedTaskContextBlockForTest(TEST_UID, TEST_CID);

    expect(block).toContain('### Blocking Gate');
    expect(block).toContain('Gate: human_review');
    expect(block).toContain('Status: needs_review');
    expect(block).toContain('Do not call dispatch_to, hand_off_to, or run_worker');
  });

  it('keeps the workflow blocked when a gate review is rejected', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Rejected gate workflow',
      kind: 'review',
      created_by: 'commander',
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Quality gate',
      actor_id: 'reviewer',
      type: 'gate',
    });
    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: 'quality_gate',
      status: 'failed',
      reason: 'Output is incomplete.',
      checks: [{ name: 'deliverable_complete', status: 'failed' }],
    });

    const rejected = await c.reviewCollaborationGate(TEST_UID, TEST_CID, gate.id, {
      decision: 'reject',
      reviewed_by: 'user',
      reason: 'Still incomplete.',
    });

    expect(rejected.run.status).toBe('blocked');
    expect(rejected.run.phase).toBe('gate_rejected');
    expect(rejected.gate.status).toBe('failed');
    expect(rejected.gate.review_decision).toBe('rejected');
    await expect(c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Still blocked',
      actor_id: 'coder',
      type: 'implementation',
    })).rejects.toThrow(/workflow run is blocked by gate/);
  });
});

describe('group_chat collaboration › structured context patch extraction', () => {
  it('extracts valid context-patch blocks and removes them from visible text', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const result = c.extractContextPatchBlocks('Summary for user.\n<context-patch>\n{"facts_add":[{"text":"Shared files are the first transport"}],"decisions_proposed":[{"text":"Keep Redis out of the local POC"}]}\n</context-patch>\nTail.', 'agent-a');

    expect(result.errors).toEqual([]);
    expect(result.cleanText).toBe('Summary for user.\nTail.');
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].added_by).toBe('agent-a');
    expect(result.patches[0].facts_add?.[0].text).toBe('Shared files are the first transport');
    expect(result.patches[0].decisions_proposed?.[0].text).toBe('Keep Redis out of the local POC');
  });

  it('rejects look-alike and malformed context-patch blocks without stripping them', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const malformed = 'Visible\n<context-patch>{bad json}</context-patch>';
    const result = c.extractContextPatchBlocks(malformed, 'agent-a');

    expect(result.patches).toEqual([]);
    expect(result.cleanText).toBe(malformed);
    expect(result.errors[0]).toContain('invalid context-patch JSON');

    const lookalike = c.extractContextPatchBlocks('<context_patch>{"facts_add":[{"text":"wrong tag"}]}</context_patch>', 'agent-a');
    expect(lookalike.cleanText).toContain('<context_patch>');
    expect(lookalike.patches).toEqual([]);
  });
});

describe('group_chat collaboration › conflict resolution and event replay', () => {
  it('resolves conflicting decisions and replays the collaboration event log', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Resolve conflict',
      kind: 'discussion',
      created_by: 'commander',
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-a',
      decisions_proposed: [{ text: 'Use shared files first' }],
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-b',
      decisions_proposed: [{ text: 'Use Redis first', conflicts_with: ['Use shared files first'] }],
    });
    let current = await c.readSharedTaskContext(TEST_UID, TEST_CID, context.id);
    expect(current?.open_questions.some((item) => item.text.includes('Conflicting decision proposed'))).toBe(true);

    current = await c.resolveContextConflict(TEST_UID, TEST_CID, context.id, {
      decision: 'accept',
      text: 'Use shared files first',
      resolved_by: 'user',
      reason: 'Matches local PC constraints.',
    });

    expect(current.decisions.map((item) => item.text)).toContain('Use shared files first');
    expect(current.open_questions.some((item) => item.text.includes('Conflicting decision proposed'))).toBe(false);
    const replay = await c.replayCollaborationEvents(TEST_UID, TEST_CID);
    expect(replay.total_events).toBeGreaterThanOrEqual(4);
    expect(replay.by_type.context_patch_applied).toBe(2);
    expect(replay.by_type.conflict_resolved).toBe(1);
  });
});

describe('group_chat collaboration › discussion protocol', () => {
  it('records proposal/critique/revision discussion rounds as workflow steps and events', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Discuss architecture',
      kind: 'discussion',
      created_by: 'commander',
    });

    const step = await c.recordDiscussionRound(TEST_UID, TEST_CID, run.id, {
      title: 'Proposal critique revision',
      actor_id: 'reviewer',
      opinion: 'SharedTaskContext is the right local state layer.',
      critiques: ['Gate resume needs explicit handling.'],
      revision: 'Add gate approval resume before planner automation.',
    });

    expect(step.status).toBe('completed');
    expect(step.type).toBe('discussion_round');
    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 20);
    expect(events.map((event) => event.type)).toContain('discussion_recorded');
  });
});

describe('group_chat collaboration › runtime snapshot', () => {
  it('summarizes active workflow status and context counts for IPC', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Expose shared state',
      kind: 'discussion',
      created_by: 'commander',
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Review context',
      actor_id: 'reviewer',
      type: 'review',
    });
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: 'completed',
      result_summary: 'Looks consistent.',
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'reviewer',
      facts_add: [{ text: 'Runtime status includes collaboration counts' }],
      decisions_proposed: [{ text: 'Show a compact renderer card' }],
      risks_add: [{ text: 'Renderer must tolerate missing collaboration data', severity: 'low' }],
      open_questions_add: [{ text: 'Do we need expand/collapse later?' }],
    });

    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);

    expect(snapshot?.run_id).toBe(run.id);
    expect(snapshot?.context_id).toBe(context.id);
    expect(snapshot?.objective).toBe('Expose shared state');
    expect(snapshot?.steps).toHaveLength(1);
    expect(snapshot?.steps[0].status).toBe('completed');
    expect(snapshot?.facts_count).toBe(1);
    expect(snapshot?.decisions_count).toBe(1);
    expect(snapshot?.risks_count).toBe(1);
    expect(snapshot?.open_questions_count).toBe(1);
    expect(snapshot?.facts_preview[0].text).toBe('Runtime status includes collaboration counts');
    expect(snapshot?.decisions_preview[0].text).toBe('Show a compact renderer card');
    expect(snapshot?.risks_preview[0].severity).toBe('low');
    expect(snapshot?.open_questions_preview[0].text).toBe('Do we need expand/collapse later?');
    expect(snapshot?.recent_events.map((event) => event.type)).toEqual([
      'workflow_created',
      'step_started',
      'step_completed',
      'context_patch_applied',
    ]);
  });
});

describe('group_chat collaboration › runtime facade', () => {
  it('includes the active collaboration snapshot in runtimeStatus', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const groupChat = await import('../../../../src/main/features/group_chat');
    await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Runtime facade snapshot',
      kind: 'discussion',
      created_by: 'commander',
    });

    const runtime = await groupChat.runtimeStatus(TEST_UID, TEST_CID);

    expect(runtime.processing).toBe(false);
    expect(runtime.collaboration?.objective).toBe('Runtime facade snapshot');
  });
});
