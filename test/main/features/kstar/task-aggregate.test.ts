import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecallCandidateRecord } from '../../../../src/main/features/recall/candidate-service';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-task-aggregate-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function attachCompleteLearningProvenance(
  store: Awaited<ReturnType<typeof import('../../../../src/main/features/kstar/requirement-store')>>,
  requirement: Awaited<ReturnType<typeof store.readKstarRequirement>> extends infer _ ? any : never,
) {
  const recallStore = await import('../../../../src/main/features/recall/store');
  const forecasts = await import('../../../../src/main/features/recall/world-model');
  const episodes = await import('../../../../src/main/features/kstar/episode-store');
  const projectionId = `proj-${requirement.id}`;
  const forecastId = `wf-${requirement.id}`;
  const episodeId = `kse-${requirement.id}`;
  const confirmedAt = '2026-08-09T00:00:00.000Z';
  await recallStore.writeRecallJsonRecord('user-a', 'projections', projectionId, {
    schemaVersion: 1, ownerId: 'user-a', id: projectionId, taskRunId: requirement.taskId,
    purpose: requirement.goalText, authorization: 'user_confirmed', assetIds: [], assetVersions: {},
    sourceRefs: [], omittedRefs: [], status: 'confirmed', createdAt: confirmedAt, confirmedAt,
  });
  await forecasts.saveWorldModelForecast('user-a', {
    schemaVersion: 1, ownerId: 'user-a', id: forecastId, taskRunId: requirement.taskId,
    requirementId: requirement.id, projectionId, projectionConfirmedAt: confirmedAt,
    assetVersions: {}, ruleRefs: ['rule:asset-a:1'], snapshotId: 'snap-a', provenanceComplete: true,
    input: {
      k: { projectionId, abilityAssetRefs: [], abilityAssets: [], assetVersions: {}, rules: [] },
      s: { snapshotId: 'snap-a', conversationSummary: requirement.goalText },
      t: { userGoal: requirement.goalText, constraints: [] },
    },
    forecast: {
      aHat: { plan: ['verify'], expectedTools: ['verify'], expectedActors: ['commander'] },
      rHat: { summary: requirement.goalText, acceptanceSignals: [], predictedFiles: [] },
      predictedRisks: [],
    },
    createdAt: confirmedAt,
  });
  await episodes.writeKstarEpisode('user-a', {
    schemaVersion: 1, ownerId: 'user-a', id: episodeId, sessionId: `gconv-${requirement.conversationId}`,
    taskRunId: requirement.taskId, projectionId, forecastId,
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] }, s: {},
    t: { userGoal: requirement.goalText, constraints: [] },
    a: { toolCalls: [{ name: 'verify', status: 'ok' }], agentActions: [] },
    r: { status: 'completed', finalText: 'Completed with evidence.', producedFiles: [] },
    evidenceRefs: [{ kind: 'execution', id: episodeId }], createdAt: confirmedAt, updatedAt: confirmedAt,
  });
  const updated = { ...requirement, projectionId, projectionIds: [projectionId], forecastId, episodeIds: [episodeId] };
  await store.replaceKstarRequirement('user-a', updated);
  return updated;
}

async function seedClosedTask() {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const closure = await import('../../../../src/main/features/kstar/requirement-closure');
  const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-a', title: 'OAuth review task' });
  const requirement = store.createKstarRequirementRecord('user-a', {
    taskId: task.id, conversationId: 'cid-a', userMessageIds: ['msg-a'],
    title: 'OAuth callback review', goalText: 'Review OAuth callback and refresh token',
  });
  await store.replaceKstarTask('user-a', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id, status: 'closing', closeReason: 'user_complete' });
  await store.replaceKstarRequirement('user-a', { ...requirement, status: 'waiting_review' });
  const closed = await closure.closeKstarRequirement('user-a', {
    requirementId: requirement.id,
    userFeedback: { verdict: 'partial', text: '下次必须覆盖 refresh token 的跨账号复用检查' },
  });
  const provenanced = await attachCompleteLearningProvenance(store, closed);
  const state = store.createInitialConversationTaskState('user-a', 'cid-a');
  const readyState = {
    ...state,
    currentTaskId: task.id,
    currentRequirementId: requirement.id,
    requirementJustClosed: requirement.id,
    taskComplete: true,
  };
  await store.writeConversationTaskState('user-a', readyState);
  return { store, task, requirement: provenanced, state: readyState };
}

async function writeCompletedEpisode(store: Awaited<ReturnType<typeof import('../../../../src/main/features/kstar/requirement-store')>>, episodeId: string) {
  const episodes = await import('../../../../src/main/features/kstar/episode-store');
  await episodes.writeKstarEpisode('user-a', {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: episodeId,
    sessionId: 'gconv-cid-auto-signal',
    taskRunId: 'task-auto-signal',
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: {},
    t: { userGoal: 'Produce the requested deliverable', constraints: [] },
    a: { toolCalls: [{ name: 'write_file', status: 'ok' }], agentActions: [] },
    r: { status: 'completed', finalText: 'Produced the requested deliverable.', producedFiles: ['deliverable.md'] },
    evidenceRefs: [{ kind: 'execution', id: 'task-auto-signal' }],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:01:00.000Z',
  });
}

const fakeCandidate = (id: string): RecallCandidateRecord => ({
  schemaVersion: 2, ownerId: 'user-a', id, taxonomyVersion: 2, status: 'pending',
  judgment: 'candidate', suggestedType: 'personal', suggestedScope: 'general', sourceRefs: [],
  createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
});

async function seedWorldModelForecast(requirementId: string): Promise<string> {
  const { saveWorldModelForecast } = await import('../../../../src/main/features/recall/world-model');
  const record = {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'wf-task-aggregate-forecast',
    taskRunId: 'task-auto-signal',
    requirementId,
    input: {
      k: { abilityAssetRefs: [], rules: [] },
      s: { conversationSummary: 'Produce the requested deliverable' },
      t: { userGoal: 'Produce the requested deliverable', constraints: [] },
    },
    forecast: {
      aHat: { plan: ['write_file'], expectedTools: ['write_file'], expectedActors: ['commander'] },
      rHat: {
        summary: 'Produced the requested deliverable.',
        acceptanceSignals: [],
        predictedFiles: ['deliverable.md'],
      },
      predictedRisks: [],
    },
    createdAt: '2026-08-09T00:00:00.000Z',
  };
  await saveWorldModelForecast('user-a', record as any);
  return record.id;
}

describe('KSTAR task aggregation', () => {
  it('consumes requirementJustClosed and closes the task without bridging candidates (precipitation is single-path)', async () => {
    const { store, task, requirement } = await seedClosedTask();
    const aggregate = await import('../../../../src/main/features/kstar/task-aggregate');
    let bridgeCalls = 0;
    const result = await aggregate.drainKstarTaskState('user-a', 'cid-a', {
      candidateBridge: async () => {
        bridgeCalls += 1;
        return [fakeCandidate('cand-a')];
      },
    });

    // 沉淀路径收口（2026-08-17）：drain 不再产候选——统一走 requirement 级
    // 路径（task-level-precipitation）。任务/会话关闭职责保留。
    expect(result).toMatchObject({
      task: { id: task.id, status: 'closed' },
      proposals: [],
      candidates: [],
    });
    expect(result?.closedRequirements[0]).toMatchObject({ id: requirement.id, status: 'closed' });
    expect(bridgeCalls).toBe(0);
    const cleared = await store.readConversationTaskState('user-a', 'cid-a');
    expect(cleared?.taskComplete).toBe(false);
    expect(cleared?.requirementJustClosed).toBeUndefined();
    expect(cleared?.currentTaskId).toBeUndefined();
    expect(cleared?.currentRequirementId).toBeUndefined();
    await expect(store.readKstarTask('user-a', task.id)).resolves.toMatchObject({ status: 'closed', candidateRunId: `kstc-${task.id}` });

    await expect(aggregate.drainKstarTaskState('user-a', 'cid-a')).resolves.toBeNull();
    expect(bridgeCalls).toBe(0);
  });



  it('keeps the task lifecycle attached to the existing umbrella records rather than a separate lifecycle tree', async () => {
    const { store, task, requirement } = await seedClosedTask();
    const state = await store.readConversationTaskState('user-a', 'cid-a');
    expect(state).toMatchObject({ currentTaskId: task.id, currentRequirementId: requirement.id, taskComplete: true });
    expect(await store.readKstarTask('user-a', task.id)).toMatchObject({ id: task.id, requirementIds: [requirement.id], currentRequirementId: requirement.id, status: 'closing' });
    expect(await store.readKstarRequirement('user-a', requirement.id)).toMatchObject({ id: requirement.id, taskId: task.id, status: 'closed' });
  });



  it('does not bridge a candidate when world-model provenance is incomplete', async () => {
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const aggregate = await import('../../../../src/main/features/kstar/task-aggregate');
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-auto-signal', title: 'Auto signal task' });
    const requirement = store.createKstarRequirementRecord('user-a', {
      taskId: task.id, conversationId: 'cid-auto-signal', userMessageIds: ['msg-auto'], title: 'Auto signal task', goalText: 'Produce the requested deliverable',
    });
    requirement.episodeIds = ['kse-auto-signal'];
    const forecastId = await seedWorldModelForecast(requirement.id);
    await writeCompletedEpisode(store, 'kse-auto-signal');
    await store.replaceKstarTask('user-a', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id, status: 'closing', closeReason: 'user_complete' });
    await store.replaceKstarRequirement('user-a', { ...requirement, status: 'waiting_review', forecastId });
    const state = store.createInitialConversationTaskState('user-a', 'cid-auto-signal');
    await store.writeConversationTaskState('user-a', { ...state, currentTaskId: task.id, currentRequirementId: requirement.id, requirementJustClosed: requirement.id, taskComplete: true });

    const result = await aggregate.drainKstarTaskState('user-a', 'cid-auto-signal', {
      candidateBridge: async () => {
        throw new Error('incomplete provenance must not reach the candidate bridge');
      },
    });

    expect(result?.proposals).toEqual([]);
    expect(result?.candidates).toEqual([]);
  });

  it('does not bridge requirement candidates when closed review has no learning signal', async () => {
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const closure = await import('../../../../src/main/features/kstar/requirement-closure');
    const aggregate = await import('../../../../src/main/features/kstar/task-aggregate');
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-nosignal', title: 'Check wording' });
    const requirement = store.createKstarRequirementRecord('user-a', {
      taskId: task.id, conversationId: 'cid-nosignal', userMessageIds: ['msg-a'], title: 'Check wording', goalText: 'Check wording',
    });
    await store.replaceKstarTask('user-a', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id, status: 'closing', closeReason: 'user_complete' });
    await store.replaceKstarRequirement('user-a', { ...requirement, status: 'waiting_review' });
    const closed = await closure.closeKstarRequirement('user-a', { requirementId: requirement.id, userFeedback: { verdict: 'skip', text: 'No reusable lesson.' } });
    const state = store.createInitialConversationTaskState('user-a', 'cid-nosignal');
    await store.writeConversationTaskState('user-a', { ...state, currentTaskId: task.id, currentRequirementId: requirement.id, requirementJustClosed: requirement.id, taskComplete: true });

    let bridgeCalls = 0;
    const result = await aggregate.drainKstarTaskState('user-a', 'cid-nosignal', { candidateBridge: async () => { bridgeCalls += 1; return [fakeCandidate('unexpected')]; } });

    expect(closed.aar?.candidateSeed).toBeUndefined();
    expect(result?.proposals).toEqual([]);
    expect(result?.candidates).toEqual([]);
    expect(bridgeCalls).toBe(0);
  });

  it('creates the next task and requirement after closing a topic switch', async () => {
    const { store, task, requirement, state } = await seedClosedTask();
    await store.replaceConversationTaskState('user-a', {
      ...state,
      pendingTaskStart: { userMessageId: 'msg-switch', text: '设计发票导出', reason: 'topic_switch' },
    });
    vi.resetModules();
    const aggregate = await import('../../../../src/main/features/kstar/task-aggregate');
    const resumedStore = await import('../../../../src/main/features/kstar/requirement-store');

    const result = await aggregate.drainKstarTaskState('user-a', 'cid-a', { candidateBridge: async () => [] });
    const nextState = await resumedStore.readConversationTaskState('user-a', 'cid-a');

    expect(result?.task).toMatchObject({ id: task.id, status: 'closed' });
    expect(await resumedStore.readKstarTask('user-a', task.id)).toMatchObject({ status: 'closed', closeReason: 'user_complete' });
    expect(await resumedStore.readKstarRequirement('user-a', requirement.id)).toMatchObject({ status: 'closed' });
    expect(nextState?.taskComplete).toBe(false);
    expect(nextState?.pendingTaskStart).toBeUndefined();
    expect(nextState?.currentTaskId).toMatch(/^kst-/);
    expect(nextState?.currentRequirementId).toMatch(/^ksreq-/);
    expect(nextState?.currentTaskId).not.toBe(task.id);
    expect(await resumedStore.readKstarRequirement('user-a', nextState!.currentRequirementId!)).toMatchObject({
      taskId: nextState!.currentTaskId, goalText: '设计发票导出', userMessageIds: ['msg-switch'], status: 'open',
    });
  });
});
