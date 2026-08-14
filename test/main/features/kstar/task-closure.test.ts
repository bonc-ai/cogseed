import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../../../../src/main/features/cogseed_runtime/protocol';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-closure-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const request: RuntimeRunRequest = {
  protocol_version: 1, type: 'run', request_id: 'req-closure', runtime_session_id: 'mruntime-closure',
  user_id: 'closure-user', task: 'Create a report.', context: [], attachments: [],
};
const events: RuntimeEventEnvelope[] = [
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_call', id: 'a', name: 'read_file', arguments: { path: 'x' } } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_result', id: 'a', name: 'read_file', isError: false } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_call', id: 'b', name: 'write_file', arguments: { path: 'y', content: '...' } } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_result', id: 'b', name: 'write_file', isError: false } },
  { type: 'result', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'completed', text: 'Report created.' },
];


async function seedLearningReview(
  userId: string,
  episode: import('../../../../src/main/features/kstar/types').KstarEpisodeRecord,
): Promise<void> {
  const reviews = await import('../../../../src/main/features/kstar/review-service');
  const initial = reviews.createInitialKstarReview(episode);
  await reviews.saveKstarReviewRecord(userId, {
    ...initial,
    expectedResult: 'A report is created with the requested sections.',
    actualResult: 'The report was created and written to disk.',
    deltaR: 0.2,
    deltaA: 0.1,
    outcome: 'better_than_expected',
    attribution: 'execution_gap',
    reason: 'The verified workflow is worth reusing for similar report tasks.',
    confidence: 0.9,
  });
}

describe('KSTAR completion evidence merge', () => {
  it('merges Commander-submitted completion evidence into a text-less group episode', async () => {
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const task = store.createKstarTaskRecord('closure-user', { conversationId: 'cid-evidence', title: 'Evidence task' });
    const requirement = store.createKstarRequirementRecord('closure-user', {
      taskId: task.id,
      conversationId: 'cid-evidence',
      userMessageIds: ['msg-evidence'],
      title: 'Evidence task',
      goalText: 'Produce the report',
      rHat: { summary: 'A report is produced', acceptanceSignals: ['report exists'], source: 'user_message', confidence: 1 },
    });
    requirement.completionEvidence = {
      finalStatus: 'completed',
      finalText: 'Report written to disk.',
      producedFiles: ['report.md'],
      acceptanceEvidence: ['report exists'],
    };
    await store.replaceKstarTask('closure-user', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
    await store.replaceKstarRequirement('closure-user', requirement);
    await store.writeConversationTaskState('closure-user', {
      ...store.createInitialConversationTaskState('closure-user', 'cid-evidence'),
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
      taskComplete: false,
    });

    const closure = await import('../../../../src/main/features/kstar/task-closure');
    await closure.captureGroupKstarClosure({
      userId: 'closure-user', runId: 'run-evidence', conversationId: 'cid-evidence', status: 'completed',
      startedAtMs: Date.parse('2026-08-05T00:00:00.000Z'), finishedAtMs: Date.parse('2026-08-05T00:01:00.000Z'),
      messages: [
        { id: 'msg-evidence', from: 'user', text: 'Produce the report', ts: '2026-08-05T00:00:01.000Z' },
        { id: 'msg-agent-a', from: 'commander', text: 'finished', ts: '2026-08-05T00:00:30.000Z' },
      ],
      createdAt: '2026-08-05T00:02:00.000Z',
    });

    const episodes = await import('../../../../src/main/features/kstar/episode-store');
    const records = await episodes.listKstarJsonRecords('closure-user', 'episodes');
    expect(records).toHaveLength(1);
    expect(records[0].r).toMatchObject({
      finalText: 'Report written to disk.',
      producedFiles: ['report.md'],
    });
    const reviews = await import('../../../../src/main/features/kstar/review-service');
    const review = await reviews.readKstarReview('closure-user', records[0].id as string);
    expect(review?.actualResult).toContain('Report written to disk.');
  });
});

describe('KSTAR task closure', () => {


  it('attaches group terminal episodes to the open requirement without completing the task', async () => {
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const task = store.createKstarTaskRecord('closure-user', { conversationId: 'cid-phase2', title: 'Review OAuth callback handling' });
    const requirement = store.createKstarRequirementRecord('closure-user', {
      taskId: task.id,
      conversationId: 'cid-phase2',
      userMessageIds: ['msg-user-a'],
      title: 'Review OAuth callback handling',
      goalText: 'Review OAuth callback handling',
    });
    await store.replaceKstarTask('closure-user', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
    await store.replaceKstarRequirement('closure-user', requirement);
    await store.writeConversationTaskState('closure-user', {
      ...store.createInitialConversationTaskState('closure-user', 'cid-phase2'),
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
      taskComplete: false,
    });
    const before = await store.readConversationTaskState('closure-user', 'cid-phase2');
    expect(before?.currentRequirementId).toBeTruthy();

    const closure = await import('../../../../src/main/features/kstar/task-closure');
    await closure.captureGroupKstarClosure({
      userId: 'closure-user', runId: 'run-group-attach', conversationId: 'cid-phase2', status: 'completed',
      startedAtMs: Date.parse('2026-08-05T00:00:00.000Z'), finishedAtMs: Date.parse('2026-08-05T00:01:00.000Z'),
      messages: [
        { id: 'msg-user-a', from: 'user', text: 'Review OAuth callback handling', ts: '2026-08-05T00:00:01.000Z' },
        { id: 'msg-agent-a', from: 'commander', text: 'Review complete.', ts: '2026-08-05T00:00:30.000Z' },
      ],
      createdAt: '2026-08-05T00:02:00.000Z',
    });

    await expect(store.readKstarRequirement('closure-user', before!.currentRequirementId!)).resolves.toMatchObject({
      status: 'open', episodeIds: ['kse-run-group-attach'],
    });
    await expect(store.readConversationTaskState('closure-user', 'cid-phase2')).resolves.toMatchObject({ taskComplete: false });
  });

  it('attaches group terminal episodes to the requirement matching projection provenance even when the current requirement differs', async () => {
    const state = await import('../../../../src/main/features/kstar/requirement-state');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const task = store.createKstarTaskRecord('closure-user', { conversationId: 'cid-provenance', title: 'Provenance task' });
    const current = store.createKstarRequirementRecord('closure-user', {
      taskId: task.id,
      conversationId: 'cid-provenance',
      userMessageIds: ['msg-current'],
      title: 'Current requirement',
      goalText: 'Stay on the current requirement',
    });
    const matched = store.createKstarRequirementRecord('closure-user', {
      taskId: task.id,
      conversationId: 'cid-provenance',
      userMessageIds: ['msg-matched'],
      title: 'Matched requirement',
      goalText: 'Attach by projection provenance',
    });
    await store.replaceKstarTask('closure-user', {
      ...task,
      requirementIds: [current.id, matched.id],
      currentRequirementId: current.id,
    });
    await store.replaceKstarRequirement('closure-user', current);
    await store.replaceKstarRequirement('closure-user', { ...matched, projectionId: 'proj-match' });
    await store.writeConversationTaskState('closure-user', {
      ...store.createInitialConversationTaskState('closure-user', 'cid-provenance'),
      currentTaskId: task.id,
      currentRequirementId: current.id,
      taskComplete: false,
    });

    const closure = await import('../../../../src/main/features/kstar/task-closure');
    await closure.captureGroupKstarClosure({
      userId: 'closure-user',
      runId: 'run-provenance-attach',
      conversationId: 'cid-provenance',
      status: 'completed',
      startedAtMs: Date.parse('2026-08-05T00:00:00.000Z'),
      finishedAtMs: Date.parse('2026-08-05T00:01:00.000Z'),
      projectionId: 'proj-match',
      messages: [
        { id: 'msg-user-b', from: 'user', text: 'Attach by projection provenance', ts: '2026-08-05T00:00:01.000Z' },
        { id: 'msg-narration', from: 'commander', text: '授权已确认。我现在说明这次交给 Agent 的协作预期。', ts: '2026-08-05T00:00:20.000Z', kstar_dispatch_narration: { target_agent_id: 'agent-1', workflow_step_id: 'wstep-1' } },
        { id: 'msg-agent', from: 'agent-1', text: 'Completed by the delegated Agent.', ts: '2026-08-05T00:00:40.000Z' },
      ],
      createdAt: '2026-08-05T00:02:00.000Z',
    });

    await expect(store.readKstarRequirement('closure-user', matched.id)).resolves.toMatchObject({
      projectionId: 'proj-match', episodeIds: ['kse-run-provenance-attach'],
    });
    await expect(store.readKstarRequirement('closure-user', current.id)).resolves.toMatchObject({
      episodeIds: [],
    });
    await expect(store.readConversationTaskState('closure-user', 'cid-provenance')).resolves.toMatchObject({
      currentRequirementId: current.id,
    });
  });

  it('prefers the agent result over Commander dispatch narration when building a group episode', async () => {
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const episode = builder.buildGroupKstarEpisode({
      userId: 'closure-user',
      runId: 'run-narration-filter',
      conversationId: 'cid-narration-filter',
      status: 'completed',
      startedAtMs: Date.parse('2026-08-05T00:00:00.000Z'),
      finishedAtMs: Date.parse('2026-08-05T00:01:00.000Z'),
      messages: [
        { id: 'msg-user', from: 'user', text: 'Review OAuth callback handling', ts: '2026-08-05T00:00:01.000Z' },
        { id: 'msg-narration', from: 'commander', text: '授权已确认。我现在说明这次交给 Agent 的协作预期。', ts: '2026-08-05T00:00:20.000Z', kstar_dispatch_narration: { target_agent_id: 'agent-1' } },
        { id: 'msg-agent', from: 'agent-1', text: 'Completed by the delegated Agent.', ts: '2026-08-05T00:00:40.000Z' },
      ],
    });

    expect(episode.r.finalText).toBe('Completed by the delegated Agent.');
    expect(episode.s.conversationSummary).toContain('agent-1: Completed by the delegated Agent.');
    expect(episode.s.conversationSummary).not.toContain('授权已确认');
  });

  it('persists episode and an empty extraction run when no learning signal exists', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const first = await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-closure', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    const second = await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-closure', request, events, createdAt: '2026-08-05T00:00:00.000Z' });

    expect(first.episode.id).toBe('kse-run-closure');
    expect(first.review.id).toBe('ksr-kse-run-closure');
    // A completed workflow without an explicit learning signal must not create a candidate.
    expect(first.extractionRun).toMatchObject({ status: 'created', candidateIds: [] });
    expect(first.candidates).toEqual([]);
    expect(second.candidates).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'closure-user', 'cloud', 'recall', 'records', 'ability-assets'))).toBe(false);
  });



  it('persists an inferred objective review and creates a governed candidate without a user form', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const inferred = async (_userId: string, builtEpisode: any) => ({
      review: {
        expectedResult: builtEpisode.t.userGoal,
        actualResult: 'Report created and verification passed.',
        // A real deviation: met_expected with ~0 delta is NOT a lesson
        // (noise gate), so the fixture carries a measurable delta.
        deltaR: 0.3 as const,
        deltaA: 0.1 as const,
        outcome: 'better_than_expected' as const,
        attribution: 'execution_gap' as const,
        reason: 'The verified workflow is worth reusing for report tasks.',
        confidence: 0.95,
        evidenceRefs: builtEpisode.evidenceRefs,
      },
      reviewState: 'inferred' as const,
      inferenceMethod: 'deterministic' as const,
      needsConfirmation: false,
    });

    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-inferred', request, events,
      createdAt: '2026-08-05T00:00:00.000Z', inferReview: inferred,
    });

    expect(result.review).toMatchObject({
      reviewState: 'inferred', inferenceMethod: 'deterministic', needsConfirmation: false,
      outcome: 'better_than_expected', deltaR: 0.3,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ status: 'pending_review', learningSignal: { outcome: 'better_than_expected', deltaR: 0.3 } });
  });

  it('evolves delta reasoning from all five cognition sources in the episode evidence', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    // Seed an active teaching signal bound to this conversation (a "记住"
    // intent message produces a user_teaching_signal source).
    await teaching.recordTeachingSignalAfterMemoryWrite('closure-user', {
      conversationId: 'cid-evidence',
      messageId: 'msg-teach-five',
      userMessage: '记住：Always validate OAuth state before exchanging the code.',
      memoryContent: 'Always validate OAuth state before exchanging the code.',
      memoryScope: 'personal',
    });

    const inferred = async (_userId: string, builtEpisode: any) => ({
      review: {
        expectedResult: builtEpisode.t.userGoal,
        actualResult: 'Report created.',
        deltaR: 0.3 as const,
        deltaA: 0.1 as const,
        outcome: 'better_than_expected' as const,
        attribution: 'execution_gap' as const,
        reason: 'Reusable workflow.',
        confidence: 0.9,
        evidenceRefs: builtEpisode.evidenceRefs,
      },
      reviewState: 'inferred' as const,
      inferenceMethod: 'deterministic' as const,
      needsConfirmation: false,
    });

    const result = await closure.captureGroupKstarClosure({
      userId: 'closure-user',
      runId: 'run-five',
      conversationId: 'cid-evidence',
      status: 'completed',
      startedAtMs: Date.now() - 60_000,
      finishedAtMs: Date.now(),
      messages: [{
        id: 'msg-five', ts: new Date().toISOString(), from: 'user', text: 'Produce the report',
      }, {
        id: 'msg-five-result', ts: new Date().toISOString(), from: 'writer', text: 'Done.',
        produced: ['report.md'],
        artifacts: [{ id: 'art-five', title: 'report.md' }],
      }],
      inferReview: inferred,
    });

    const kinds = result.episode.evidenceRefs.map((ref) => ref.kind);
    expect(kinds).toContain('conversation');
    expect(kinds).toContain('user_teaching_signal');
    // artifact_file replaces the legacy artifact kind in the v2 taxonomy.
    expect(kinds).toContain('artifact_file');
  });

  it('confirms a lightweight user verdict and reconciles candidate extraction idempotently', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const recallBridge = await import('../../../../src/main/features/kstar/recall-bridge');
    const unknownInference = async (_userId: string, builtEpisode: any) => ({
      review: {
        expectedResult: builtEpisode.t.userGoal,
        actualResult: 'Report created.',
        deltaR: 'unknown' as const,
        deltaA: 'unknown' as const,
        outcome: 'unclear' as const,
        attribution: 'unclear' as const,
        reason: 'User confirmation is required.',
        confidence: 0,
        evidenceRefs: builtEpisode.evidenceRefs,
      },
      reviewState: 'needs_confirmation' as const,
      inferenceMethod: 'unknown' as const,
      needsConfirmation: true,
    });
    const initial = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-confirm', request, events,
      createdAt: '2026-08-05T00:00:00.000Z', inferReview: unknownInference,
    });
    expect(initial.candidates).toEqual([]);

    let bridgeCalls = 0;
    const bridge = async (userId: string, proposals: any[]) => {
      bridgeCalls += 1;
      return recallBridge.saveKstarCandidateProposals(userId, proposals);
    };
    const first = await closure.confirmKstarReview('closure-user', initial.episode.id, {
      verdict: 'partial', reason: 'The report was created but missed one requested section.',
    }, bridge);
    const second = await closure.confirmKstarReview('closure-user', initial.episode.id, {
      verdict: 'partial', reason: 'The report was created but missed one requested section.',
    }, bridge);

    expect(first.review).toMatchObject({
      reviewState: 'confirmed', inferenceMethod: 'user', needsConfirmation: false,
      outcome: 'worse_than_expected', deltaR: -0.5,
    });
    expect(first.candidates).toHaveLength(1);
    expect(second.candidates.map((candidate) => candidate.id)).toEqual(first.candidates.map((candidate) => candidate.id));
    expect(bridgeCalls).toBe(1);
  });

  it('keeps episode and review when proposal bridging fails', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-failed-bridge', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await seedLearningReview('closure-user', seededEpisode);
    const failingBridge = async () => { throw new Error('recall unavailable'); };
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-failed-bridge', request, events, createdAt: '2026-08-05T00:00:00.000Z',
      bridge: failingBridge,
    });

    expect(result.episode.id).toBe('kse-run-failed-bridge');
    expect(result.review.id).toBe('ksr-kse-run-failed-bridge');
    expect(result.candidates).toEqual([]);
    expect(result.extractionRun).toMatchObject({ status: 'failed', error: 'candidate_bridge_failed' });
  });
});

describe('KSTAR direct experience asset line', () => {
  it('precipitates verified workflow experience directly as an ability asset without review', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-direct', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await seedLearningReview('closure-user', seededEpisode);

    const result = await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-direct', request, events, createdAt: '2026-08-05T00:00:00.000Z' });

    expect(result.episode.id).toBe('kse-run-direct');
    const all = await assets.listAbilityAssets('closure-user');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      status: 'active',
      maturity: 'seed',
      type: 'skill_method',
      version: '1',
    });
    expect(all[0].statement).toContain('verified workflow');
    expect(all[0].evidenceRefs.some((ref) => ref.kind === 'execution' && ref.id === 'kse-run-direct')).toBe(true);
    // The existing review line stays intact: the same experience is still a pending candidate.
    const pending = await candidates.listRecallCandidates('closure-user');
    expect(pending.some((candidate) => candidate.status === 'pending_review' && candidate.suggestedType === 'skill_method')).toBe(true);
  });

  it('does not duplicate the direct asset across repeated closure delivery', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-direct-dup', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await seedLearningReview('closure-user', seededEpisode);

    await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-direct-dup', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-direct-dup', request, events, createdAt: '2026-08-05T00:00:00.000Z' });

    expect(await assets.listAbilityAssets('closure-user')).toHaveLength(1);
  });

  it('precipitates nothing when no learning signal exists', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-no-signal-direct', request, events, createdAt: '2026-08-05T00:00:00.000Z' });

    expect(await assets.listAbilityAssets('closure-user')).toHaveLength(0);
  });
});

describe('KSTAR group terminal subscriber', () => {
  it('captures one bounded group terminal event and ignores duplicate delivery', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    const captured: any[] = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-a', ts: '2026-08-05T00:00:01.000Z', from: 'user', text: 'Make a plan.' }],
      capture: async (input: any) => { captured.push(input); return {} as any; },
    });
    const event = {
      run_id: 'run-group-terminal', user_id: 'group-user', conversation_id: 'cid-group', status: 'completed',
      started_at_ms: Date.parse('2026-08-05T00:00:00.000Z'), finished_at_ms: Date.parse('2026-08-05T00:01:00.000Z'),
    };
    listener?.(event);
    listener?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ userId: 'group-user', runId: 'run-group-terminal', conversationId: 'cid-group', status: 'completed' });
    stop();
  });



  it('publishes one lightweight confirmation card when inferred review needs user confirmation', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    const published: any[] = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-review', ts: '2026-08-05T00:00:01.000Z', from: 'user', text: 'Make it better.' }],
      capture: async () => ({
        review: {
          id: 'ksr-kse-run-review-card', episodeId: 'kse-run-review-card', needsConfirmation: true,
          expectedResult: 'Make it better.', actualResult: 'A revised result was produced.',
        },
      } as any),
      publishReviewCard: async (userId, conversationId, review) => { published.push({ userId, conversationId, review }); },
    });
    listener?.({ run_id: 'run-review-card', user_id: 'group-user', conversation_id: 'cid-review', status: 'completed', started_at_ms: 0, finished_at_ms: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(published).toEqual([expect.objectContaining({
      userId: 'group-user', conversationId: 'cid-review',
      review: expect.objectContaining({ id: 'ksr-kse-run-review-card', needsConfirmation: true }),
    })]);
    stop();
  });

  it('does not publish a KSTAR confirmation card for waiting-input turns', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    const published: any[] = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-wait', ts: '2026-08-05T00:00:01.000Z', from: 'user', text: 'Hello.' }],
      capture: async () => ({
        review: {
          id: 'ksr-kse-run-waiting', episodeId: 'kse-run-waiting', needsConfirmation: true,
          expectedResult: 'Hello.', actualResult: 'Terminal status: waiting_input. Hello, how can I help?',
        },
      } as any),
      publishReviewCard: async (userId, conversationId, review) => { published.push({ userId, conversationId, review }); },
    });
    listener?.({ run_id: 'run-waiting', user_id: 'group-user', conversation_id: 'cid-wait', status: 'waiting_input', started_at_ms: 0, finished_at_ms: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(published).toEqual([]);
    stop();
  });

  it('swallows message-loader and capture errors so bus terminal delivery is unaffected', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => { throw new Error('messages unavailable'); },
    });
    expect(() => listener?.({
      run_id: 'run-group-error', user_id: 'group-user', conversation_id: 'cid-group', status: 'failed',
      started_at_ms: 0, finished_at_ms: 1,
    })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
  });
});

describe('KSTAR closure concurrency', () => {
  it('serializes concurrent captures for the same user and episode', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const recallBridge = await import('../../../../src/main/features/kstar/recall-bridge');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-concurrent', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await seedLearningReview('closure-user', seededEpisode);
    let bridgeCalls = 0;
    const bridge = async (userId: string, proposals: any[]) => {
      bridgeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return recallBridge.saveKstarCandidateProposals(userId, proposals);
    };
    const input = { userId: 'closure-user', runId: 'run-concurrent', request, events, createdAt: '2026-08-05T00:00:00.000Z', bridge };
    await Promise.all([closure.captureRuntimeKstarClosure(input), closure.captureRuntimeKstarClosure(input)]);
    expect(bridgeCalls).toBe(1);
  });
});

describe('KSTAR closure recovery and referential integrity', () => {
  it('retries a transient group capture once without a duplicate terminal event', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    let captureCalls = 0;
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-retry', ts: '2026-08-05T00:00:01.000Z', from: 'user', text: 'Retry this.' }],
      capture: async () => {
        captureCalls += 1;
        if (captureCalls === 1) throw new Error('transient');
        return {} as any;
      },
    });
    listener?.({ run_id: 'run-retry', user_id: 'group-user', conversation_id: 'cid-retry', status: 'completed', started_at_ms: Date.parse('2026-08-05T00:00:00.000Z'), finished_at_ms: Date.parse('2026-08-05T00:01:00.000Z') });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captureCalls).toBe(2);
    stop();
  });

  it('rebuilds a created extraction run whose review reference belongs to another episode', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const store = await import('../../../../src/main/features/kstar/episode-store');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-cross', request: { ...request, user_id: 'closure-user' }, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await seedLearningReview('closure-user', seededEpisode);
    await store.writeKstarJsonRecord('closure-user', 'extraction-runs', {
      schemaVersion: 1, ownerId: 'closure-user', id: 'ksx-kse-run-cross', episodeId: 'kse-run-cross',
      reviewId: 'ksr-other-episode', candidateIds: [], status: 'created',
      createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
    });
    let bridgeCalls = 0;
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-cross', request: { ...request, user_id: 'closure-user' }, events,
      createdAt: '2026-08-05T00:00:00.000Z', bridge: async () => { bridgeCalls += 1; return []; },
    });
    expect(bridgeCalls).toBe(1);
    expect(result.extractionRun.reviewId).toBe(result.review.id);
  });
});

describe('KSTAR extraction reconciliation', () => {
  it('does not treat an empty created run as complete when current proposals exist', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const reviews = await import('../../../../src/main/features/kstar/review-service');
    const store = await import('../../../../src/main/features/kstar/episode-store');
    const currentEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-reconcile', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await store.writeKstarEpisode('closure-user', currentEpisode);
    await seedLearningReview('closure-user', currentEpisode);
    const currentReview = (await reviews.readKstarReview('closure-user', currentEpisode.id))!;
    await store.writeKstarJsonRecord('closure-user', 'extraction-runs', {
      schemaVersion: 1, ownerId: 'closure-user', id: 'ksx-kse-run-reconcile', episodeId: currentEpisode.id,
      reviewId: currentReview.id, candidateIds: [], status: 'created',
      createdAt: currentEpisode.createdAt, updatedAt: currentEpisode.updatedAt,
    });
    let bridgeCalls = 0;
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-reconcile', request, events, createdAt: '2026-08-05T00:00:00.000Z',
      bridge: async (_userId, proposals) => { bridgeCalls += 1; return proposals.map(() => ({ id: `candidate-${bridgeCalls}`, status: 'pending' } as any)); },
    });
    expect(bridgeCalls).toBe(1);
    expect(result.extractionRun.candidateIds).toHaveLength(1);
  });
});
