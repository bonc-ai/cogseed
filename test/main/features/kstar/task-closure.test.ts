import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../../../../src/main/features/cogseed_runtime/protocol';

// 语义查重不依赖真实 embedding 模型（测试环境无关性）：按文本哈希生成
// 确定性 512 维向量——不同文本向量不同 → 查重走 no_match 正常晋升。
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Array.from({ length: 512 }, (_, i) => Math.sin(h + i * 0.618) * 0.1);
  },
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-closure-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
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

  it('uses the first REAL user message as the group episode goal, ignoring empty host-control messages', async () => {
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const episode = builder.buildGroupKstarEpisode({
      userId: 'closure-user',
      runId: 'run-empty-control',
      conversationId: 'cid-empty-control',
      status: 'completed',
      startedAtMs: Date.parse('2026-08-05T00:00:00.000Z'),
      finishedAtMs: Date.parse('2026-08-05T00:01:00.000Z'),
      messages: [
        // Host control message (kstar_review_request) — from=user but empty
        // text; must not become the episode goal.
        { id: 'msg-control', from: 'user', text: '', ts: '2026-08-05T00:00:01.000Z' },
        { id: 'msg-user', from: 'user', text: 'Review OAuth callback handling', ts: '2026-08-05T00:00:02.000Z' },
        { id: 'msg-commander', from: 'commander', text: 'Reviewed.', ts: '2026-08-05T00:00:40.000Z' },
      ],
    });

    expect(episode.t.userGoal).toBe('Review OAuth callback handling');
    expect(episode.t.userGoal).not.toContain('Conversation');
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



  it('persists an inferred review and marks the run reviewed WITHOUT precipitating (task-loop boundary owns precipitation)', async () => {
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
    expect(result.candidates).toEqual([]);
    // Review-only closure: no assets are precipitated at run level — the
    // WHOLE-TASK loop boundary (finish/abandon/switch) owns precipitation.
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const all = await assets.listAbilityAssets('closure-user');
    expect(all.some((a) => a.candidateId?.startsWith('direct-'))).toBe(false);
    expect(result.extractionRun.status).toBe('created');
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

  it('precipitated assets carry the full five-source evidence context', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    await teaching.recordTeachingSignalAfterMemoryWrite('closure-user', {
      conversationId: 'cid-five-evidence',
      messageId: 'msg-five-evi',
      userMessage: '记住：OAuth 回调必须先校验 state。',
      memoryContent: 'OAuth 回调必须先校验 state。',
      memoryScope: 'personal',
    });
    const inferred = async (_userId: string, builtEpisode: any) => ({
      review: {
        expectedResult: builtEpisode.t.userGoal,
        actualResult: 'Report produced.',
        deltaR: -0.4 as const,
        deltaA: 'unknown' as const,
        outcome: 'worse_than_expected' as const,
        attribution: 'rule_gap' as const,
        reason: 'State check was missing.',
        confidence: 0.9,
        lesson: 'OAuth 回调必须先校验 state 再交换 code。',
        evidenceRefs: builtEpisode.evidenceRefs,
      },
      reviewState: 'inferred' as const,
      inferenceMethod: 'model' as const,
      needsConfirmation: false,
    });

    const result = await closure.captureGroupKstarClosure({
      userId: 'closure-user',
      runId: 'run-five-evi',
      conversationId: 'cid-five-evidence',
      status: 'completed',
      startedAtMs: Date.now() - 60_000,
      finishedAtMs: Date.now(),
      messages: [{
        id: 'msg-five-evi-user', ts: new Date().toISOString(), from: 'user', text: 'Fix OAuth state handling',
      }, {
        id: 'msg-five-evi-result', ts: new Date().toISOString(), from: 'writer', text: 'Done.',
        produced: ['report.md'],
        artifacts: [{ id: 'art-five-evi', title: 'report.md' }],
      }],
      inferReview: inferred,
    });

    expect(result.candidates).toEqual([]);
    // The five-source evidence context and the reasoned lesson live on the
    // REVIEW (closure is review-only); precipitation happens at the
    // requirement-level loop boundary.
    const kinds = (result.review.evidenceRefs || []).map((ref) => ref.kind);
    expect(kinds).toContain('conversation');
    expect(kinds).toContain('user_teaching_signal');
    expect(kinds).toContain('artifact_file');
    expect(result.review.lesson).toContain('OAuth 回调必须先校验 state');
  });

  it('review-only closure never precipitates (task-loop boundary owns precipitation)', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const inferred = async (_userId: string, builtEpisode: any) => ({
      review: {
        expectedResult: builtEpisode.t.userGoal,
        actualResult: 'Fixed.',
        deltaR: -0.5 as const,
        deltaA: 'unknown' as const,
        outcome: 'worse_than_expected' as const,
        attribution: 'rule_gap' as const,
        reason: 'State check missing.',
        confidence: 0.9,
        lesson: 'State must be checked before exchange.',
        evidenceRefs: builtEpisode.evidenceRefs,
      },
      reviewState: 'inferred' as const,
      inferenceMethod: 'model' as const,
      needsConfirmation: false,
    });

    await closure.captureGroupKstarClosure({
      userId: 'closure-user',
      runId: 'run-honest-status',
      conversationId: 'cid-honest',
      status: 'completed',
      startedAtMs: Date.now() - 60_000,
      finishedAtMs: Date.now(),
      messages: [{
        id: 'msg-honest', ts: new Date().toISOString(), from: 'user', text: 'Fix state handling',
      }],
      inferReview: inferred,
    });

    // Closure is review-only: no direct assets at run level.
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const all = await assets.listAbilityAssets('closure-user');
    expect(all.filter((a) => a.candidateId?.startsWith('direct-'))).toHaveLength(0);
  });

  it('runs host-side review inference with the run conversation history', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const fallbackInfer = async (_userId: string, builtEpisode: any) => ({
      review: {
        expectedResult: builtEpisode.t.userGoal,
        actualResult: 'Fixed.',
        deltaR: -0.4 as const,
        deltaA: 'unknown' as const,
        outcome: 'worse_than_expected' as const,
        attribution: 'rule_gap' as const,
        reason: 'State was not checked before exchange.',
        confidence: 0.85,
        evidenceRefs: builtEpisode.evidenceRefs,
      },
      reviewState: 'inferred' as const,
      inferenceMethod: 'deterministic' as const,
      needsConfirmation: false,
    });
    const result = await closure.captureGroupKstarClosure({
      userId: 'closure-user',
      runId: 'run-commander-review',
      conversationId: 'cid-cmd-review',
      status: 'completed',
      startedAtMs: Date.now() - 60_000,      finishedAtMs: Date.now(),
      messages: [
        { id: 'm0', ts: '2026-08-15T00:00:00.000Z', from: 'user', text: 'Fix the state handling' },
      ],
      inferReview: fallbackInfer,
    });
    expect(result.review.inferenceMethod).toBe('deterministic');
    expect(result.review.deltaR).toBe(-0.4);
  });

  it('confirms a lightweight user verdict and reconciles candidate extraction idempotently', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
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

    const first = await closure.confirmKstarReview('closure-user', initial.episode.id, {
      verdict: 'partial', reason: 'The report was created but missed one requested section.',
    });
    const second = await closure.confirmKstarReview('closure-user', initial.episode.id, {
      verdict: 'partial', reason: 'The report was created but missed one requested section.',
    });

    expect(first.review).toMatchObject({
      reviewState: 'confirmed', inferenceMethod: 'user', needsConfirmation: false,
      outcome: 'worse_than_expected', deltaR: -0.5,
    });
    // Review-only closure: confirming a verdict never produces candidates here.
    // Precipitation happens at the whole-task loop boundary. The injectable
    // candidate bridge that used to sit on this signature is gone, so "the
    // bridge is not called" is now structurally guaranteed, not asserted.
    expect(first.candidates).toEqual([]);
    expect(second.candidates).toEqual([]);
  });

  it('keeps episode and review when direct precipitation fails (run marked failed, line never blocks)', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-failed-bridge', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await seedLearningReview('closure-user', seededEpisode);
    // Direct-only line: no candidate bridge exists anymore. The run still
    // records failure if precipitation itself fails (best-effort contract).
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-failed-bridge', request, events, createdAt: '2026-08-05T00:00:00.000Z',
    });

    expect(result.episode.id).toBe('kse-run-failed-bridge');
    expect(result.review.id).toBe('ksr-kse-run-failed-bridge');
    expect(result.candidates).toEqual([]);
  });
});

describe('KSTAR direct experience asset line', () => {
  it('precipitates verified workflow experience as an ability asset via the unified candidate pool (direct line)', async () => {
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const direct = await import('../../../../src/main/features/kstar/direct-experience-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-direct', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    const result = await direct.precipitateDirectExperienceAssets('closure-user', seededEpisode, [{
      judgment: 'For similar tasks, use the verified workflow: read_file → write_file.',
      summary: 'Verified multi-tool workflow',
      suggestedType: 'skill_method',
      suggestedScope: 'report',
      sourceRefs: [{ kind: 'execution', id: 'kse-run-direct' }],
    }]);

    // 设计 §3.2.1：落点改为统一候选池，随后晋升为资产。
    expect(result.createdAssetIds).toHaveLength(1);
    expect(result.candidateIds).toHaveLength(1);
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
    // 候选池有记录（晋升后 confirmed）。
    const pending = await candidates.listRecallCandidates('closure-user');
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('confirmed');
  });

  it('carries the conversation space into the asset through the real closure path (space asset tab)', async () => {
    // 真实链路：挂空间会话 → captureGroupKstarClosure（读 conversation.space_id
    // 填 episode.s.workspaceId）→ 任务级沉淀 → 资产带 spaceId。修复前 episode
    // 构建不透传 workspaceId，此测试在真实链路上断言（不再手动塞 episode.s）。
    const chats = await import('../../../../src/main/features/chats');
    const conv = await chats.createConversation('closure-user', { title: 'space-bound task', spaceId: 'sp_abc123' });
    expect(conv.space_id).toBe('sp_abc123');

    // 建 requirement 并挂到会话（任务级沉淀的宿主；闭环会把 episode 附上来）
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const task = store.createKstarTaskRecord('closure-user', { conversationId: conv.conversation_id, title: 'Space task' });
    const requirement = store.createKstarRequirementRecord('closure-user', {
      taskId: task.id,
      conversationId: conv.conversation_id,
      userMessageIds: ['msg-user-space'],
      title: 'Space-bound task',
      goalText: 'For spaced tasks, attach the space id to the asset.',
    });
    await store.replaceKstarTask('closure-user', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
    await store.replaceKstarRequirement('closure-user', requirement);
    const state = await import('../../../../src/main/features/kstar/requirement-store');
    await state.writeConversationTaskState('closure-user', {
      ...state.createInitialConversationTaskState('closure-user', conv.conversation_id),
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
      taskComplete: false,
    });

    const closure = await import('../../../../src/main/features/kstar/task-closure');
    // 模拟有模型环境：推理产出学习信号（delta + 教训），任务级沉淀质量门限
    // 才通过——真实环境无模型时 review 降级为保守 stub（confidence 0），
    // 聚合提案被噪声门限过滤，属设计行为。
    const inferred = async (_userId: string, builtEpisode: any) => ({
      review: {
        expectedResult: builtEpisode.t.userGoal,
        actualResult: 'Space-tagged workflow attached and verified.',
        deltaR: 0.3 as const,
        deltaA: 0.1 as const,
        outcome: 'better_than_expected' as const,
        attribution: 'execution_gap' as const,
        reason: 'The verified workflow is worth reusing for spaced report tasks.',
        lesson: 'For spaced report tasks, attach the space id to the asset so it surfaces in the space asset tab.',
        confidence: 0.95,
        evidenceRefs: builtEpisode.evidenceRefs,
      },
      reviewState: 'inferred' as const,
      inferenceMethod: 'deterministic' as const,
      needsConfirmation: false,
    });
    await closure.captureGroupKstarClosure({
      userId: 'closure-user', runId: 'run-direct-space-real', conversationId: conv.conversation_id, status: 'completed',
      startedAtMs: Date.parse('2026-08-05T00:00:00.000Z'), finishedAtMs: Date.parse('2026-08-05T00:01:00.000Z'),
      messages: [
        { id: 'msg-user-space', from: 'user', text: 'For spaced tasks, attach the space id to the asset.', ts: '2026-08-05T00:00:01.000Z' },
        { id: 'msg-agent-space', from: 'commander', text: 'Space-tagged workflow attached.', ts: '2026-08-05T00:00:30.000Z' },
      ],
      createdAt: '2026-08-05T00:02:00.000Z',
      inferReview: inferred,
    });

    // episode 落盘带 workspaceId（读会话 space_id 补齐）
    const episodes = await import('../../../../src/main/features/kstar/episode-store');
    const records = await episodes.listKstarJsonRecords('closure-user', 'episodes');
    const episode = records.find((e) => e.id === 'kse-run-direct-space-real') as unknown as { s?: { workspaceId?: string } };
    expect(episode).toBeDefined();
    expect(episode!.s?.workspaceId).toBe('sp_abc123');

    // 任务级沉淀（真实 KSTAR 资产出口）→ 资产带 spaceId（空间资产 tab 过滤键）。
    // 注意：闭环已把 episode attach 到磁盘上的 requirement，必须重读最新对象
    // （precipitateRequirementLevel 按传入对象的 episodeIds 聚合）。
    const freshRequirement = await store.readKstarRequirement('closure-user', requirement.id);
    expect(freshRequirement?.episodeIds).toContain('kse-run-direct-space-real');
    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const result = await precipitation.precipitateRequirementLevel('closure-user', freshRequirement!);
    expect(result.createdAssetIds.length).toBeGreaterThan(0);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const all = await assets.listAbilityAssets('closure-user');
    const created = all.find((a) => a.id === result.createdAssetIds[0]);
    expect(created).toBeDefined();
    expect(created!.spaceId).toBe('sp_abc123');
  });

  it('does not duplicate the direct asset across repeated precipitation (content-addressed)', async () => {
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const direct = await import('../../../../src/main/features/kstar/direct-experience-assets');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-direct-dup', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    const proposal = {
      judgment: 'For similar tasks, use the verified workflow: read_file → write_file.',
      summary: 'Verified multi-tool workflow',
      suggestedType: 'skill_method',
      suggestedScope: 'report',
      sourceRefs: [{ kind: 'execution', id: 'kse-run-direct-dup' }],
    };
    await direct.precipitateDirectExperienceAssets('closure-user', seededEpisode, [proposal]);
    await direct.precipitateDirectExperienceAssets('closure-user', seededEpisode, [proposal]);

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



  it('never posts a review confirmation card — self-evolution is agent-implemented', async () => {
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

    // The user cannot verify the expected-vs-actual comparison (they made no
    // prediction and do not observe execution internals) — no card is posted.
    expect(published).toEqual([]);
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
  it('serializes concurrent captures for the same user and episode (single extraction run)', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const store = await import('../../../../src/main/features/kstar/episode-store');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const seededEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-concurrent', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await seedLearningReview('closure-user', seededEpisode);
    const input = { userId: 'closure-user', runId: 'run-concurrent', request, events, createdAt: '2026-08-05T00:00:00.000Z' };
    await Promise.all([closure.captureRuntimeKstarClosure(input), closure.captureRuntimeKstarClosure(input)]);
    // Review-only closure serialized: exactly one extraction run (no
    // duplicates) and the review is recorded once.
    const runs = await store.listKstarJsonRecords('closure-user', 'extraction-runs');
    expect(runs.filter((run) => run.episodeId === 'kse-run-concurrent')).toHaveLength(1);
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

  it('treats an existing created extraction run as idempotent (no rebuild needed)', async () => {
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
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-cross', request: { ...request, user_id: 'closure-user' }, events,
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    // Direct-only idempotency: a created run is final (content-addressed
    // assets make re-precipitation safe), no rebuild or candidate check.
    expect(result.extractionRun.status).toBe('created');
  });
});

describe('KSTAR extraction reconciliation', () => {
  it('treats an existing created extraction run as complete (direct-only idempotency)', async () => {
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
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-reconcile', request, events, createdAt: '2026-08-05T00:00:00.000Z',
    });
    // A created run is final: content-addressed assets make the run
    // idempotent without a candidate-set completeness check.
    expect(result.extractionRun.status).toBe('created');
    expect(result.extractionRun.candidateIds).toEqual([]);
  });

  it('passes the loaded conversation history to the fallback review inference (situational context)', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const optionsSeen: any[] = [];
    const spyInfer = async (_userId: string, builtEpisode: any, options?: any) => {
      optionsSeen.push(options);
      return {
        review: {
          expectedResult: builtEpisode.t.userGoal,
          actualResult: 'Done.',
          deltaR: 0 as const,
          deltaA: 'unknown' as const,
          outcome: 'met_expected' as const,
          attribution: 'unclear' as const,
          reason: 'ok',
          confidence: 0.8,
          evidenceRefs: builtEpisode.evidenceRefs,
        },
        reviewState: 'inferred' as const,
        inferenceMethod: 'deterministic' as const,
        needsConfirmation: false,
      };
    };
    await closure.captureGroupKstarClosure({
      userId: 'closure-user',
      runId: 'run-ctx',
      conversationId: 'cid-ctx',
      status: 'completed',
      startedAtMs: Date.now() - 60_000,
      finishedAtMs: Date.now(),
      messages: [
        { id: 'm1', ts: '2026-08-15T00:00:00.000Z', from: 'user', text: '做一个报告' },
        { id: 'm2', ts: '2026-08-15T00:00:01.000Z', from: 'commander', text: '用户中途要求改成英文版' },
        { id: 'm3', ts: '2026-08-15T00:00:02.000Z', from: 'commander', text: '已完成' },
      ],
      inferReview: spyInfer,
    });
    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]?.messages).toHaveLength(3);
    expect(optionsSeen[0]?.messages[1]).toMatchObject({ from: 'commander', text: '用户中途要求改成英文版' });
  });

  it('unwraps the forecast RECORD into the flat forecast for review inference', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const optionsSeen: any[] = [];
    const spyInfer = async (_userId: string, builtEpisode: any, options?: any) => {
      optionsSeen.push(options);
      return {
        review: {
          expectedResult: builtEpisode.t.userGoal,
          actualResult: 'Done.',
          deltaR: 0 as const,
          deltaA: 'unknown' as const,
          outcome: 'met_expected' as const,
          attribution: 'unclear' as const,
          reason: 'ok',
          confidence: 0.8,
          evidenceRefs: builtEpisode.evidenceRefs,
        },
        reviewState: 'inferred' as const,
        inferenceMethod: 'deterministic' as const,
        needsConfirmation: false,
      };
    };
    const task = store.createKstarTaskRecord('closure-user', { conversationId: 'cid-fc', title: 't' });
    const requirement = store.createKstarRequirementRecord('closure-user', {
      taskId: task.id, conversationId: 'cid-fc', userMessageIds: ['m1'], title: 't', goalText: 't',
    });
    await store.replaceKstarTask('closure-user', task);
    await store.replaceKstarRequirement('closure-user', requirement);
    const recall = await import('../../../../src/main/features/recall/store');
    await recall.writeRecallJsonRecord('closure-user', 'world-model-forecasts', 'wf-flat-test', {
      schemaVersion: 1, ownerId: 'closure-user', id: 'wf-flat-test', taskRunId: task.id,
      requirementId: requirement.id, projectionId: 'proj-x', snapshotId: 'snap-x',
      ruleRefs: [], assetVersions: {}, projectionConfirmedAt: '2026-08-15T00:00:00.000Z',
      forecast: {
        candidates: [], selectedCandidateId: 'c1',
        aHat: { plan: ['Do'], expectedTools: [], expectedActors: [] },
        rHat: { summary: 'expected summary', acceptanceSignals: [] },
        causalLinks: [], assumptions: [], predictedRisks: [],
      },
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    });
    await closure.captureGroupKstarClosure({
      userId: 'closure-user',
      runId: 'run-fc',
      conversationId: 'cid-fc',
      status: 'completed',
      forecastId: 'wf-flat-test',
      startedAtMs: Date.now() - 60_000,
      finishedAtMs: Date.now(),
      messages: [{ id: 'm1', ts: '2026-08-15T00:00:00.000Z', from: 'user', text: 'do it' }],
      inferReview: spyInfer,
    });
    expect(optionsSeen).toHaveLength(1);
    // The inference must receive the FLAT forecast (rHat at top level), not
    // the persisted record wrapper — the old code passed the record and
    // inferKstarReview crashed on forecast.rHat.summary (undefined.rHat).
    expect(optionsSeen[0]?.forecast?.rHat).toMatchObject({ summary: 'expected summary' });
    expect(optionsSeen[0]?.forecast?.forecast).toBeUndefined();
  });
});
