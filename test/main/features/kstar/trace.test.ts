import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string; let previous: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-trace-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(() => { if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });

it('returns a sanitized trace for a conversation and distinguishes skipped forecast', async () => {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-trace', title: 'Trace task' });
  const requirement = store.createKstarRequirementRecord('user-a', { taskId: task.id, conversationId: 'cid-trace', userMessageIds: ['msg-trace'], title: 'Trace task', goalText: 'Inspect the trace' });
  requirement.forecastStatus = 'skipped'; requirement.forecastError = 'projection not confirmed yet';
  task.requirementIds = [requirement.id]; task.currentRequirementId = requirement.id;
  await store.replaceKstarRequirement('user-a', requirement); await store.replaceKstarTask('user-a', task);
  await store.writeConversationTaskState('user-a', { ...store.createInitialConversationTaskState('user-a', 'cid-trace'), currentTaskId: task.id, currentRequirementId: requirement.id, taskComplete: false });
  const trace = await (await import('../../../../src/main/features/kstar/trace')).readKstarTrace('user-a', { conversationId: 'cid-trace' });
  expect(trace.nodes.map((entry) => entry.stage)).toEqual(expect.arrayContaining(['task', 'requirement', 'projection', 'forecast']));
  expect(trace.nodes.find((entry) => entry.stage === 'forecast')).toMatchObject({ status: 'skipped' });
  expect(JSON.stringify(trace)).not.toContain('statement');
});

it('reads the task conversation when only taskId is supplied and includes persisted lifecycle records', async () => {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const episodes = await import('../../../../src/main/features/kstar/episode-store');
  const recallStore = await import('../../../../src/main/features/recall/store');
  const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-task-only', title: 'Task-only trace' });
  const requirement = store.createKstarRequirementRecord('user-a', {
    taskId: task.id, conversationId: task.conversationId, userMessageIds: ['msg-task-only'],
    title: 'Task-only trace', goalText: 'Trace all lifecycle records',
  });
  const projectionA = await recallStore.writeRecallJsonRecord('user-a', 'projections', 'proj-trace-a', {
    schemaVersion: 1, ownerId: 'user-a', id: 'proj-trace-a', taskRunId: 'run-trace-a',
    purpose: 'trace', authorization: 'not_required', assetIds: [], sourceRefs: [], omittedRefs: [],
    status: 'preview', createdAt: '2026-09-03T00:00:00.000Z',
  });
  const projectionB = await recallStore.writeRecallJsonRecord('user-a', 'projections', 'proj-trace-b', {
    schemaVersion: 1, ownerId: 'user-a', id: 'proj-trace-b', taskRunId: 'run-trace-b',
    purpose: 'trace', authorization: 'not_required', assetIds: [], sourceRefs: [], omittedRefs: [],
    status: 'confirmed', createdAt: '2026-09-03T00:00:01.000Z', decidedAt: '2026-09-03T00:00:02.000Z',
  });
  requirement.projectionId = projectionB.id;
  requirement.projectionIds = [projectionA.id, projectionB.id];
  requirement.forecastId = 'forecast-trace';
  requirement.forecastStatus = 'committed';
  task.requirementIds = [requirement.id]; task.currentRequirementId = requirement.id;
  await store.replaceKstarRequirement('user-a', requirement); await store.replaceKstarTask('user-a', task);
  await recallStore.writeRecallJsonRecord('user-a', 'world-model-forecasts', 'forecast-trace', {
    schemaVersion: 1, ownerId: 'user-a', id: 'forecast-trace', projectionId: projectionB.id,
    projectionConfirmedAt: '2026-09-03T00:00:02.000Z', assetVersions: {}, ruleRefs: [], snapshotId: 'snapshot-trace',
    createdAt: '2026-09-03T00:00:03.000Z', forecast: { selectedCandidateId: 'candidate-trace' },
  });
  await episodes.writeKstarJsonRecord('user-a', 'extraction-runs', {
    schemaVersion: 1, ownerId: 'user-a', id: 'ksx-episode-trace', episodeId: 'episode-trace', reviewId: 'review-trace',
    candidateIds: ['candidate-trace'], createdAssetIds: ['asset-trace'], failureIds: [], status: 'partial',
    createdAt: '2026-09-03T00:00:04.000Z', updatedAt: '2026-09-03T00:00:05.000Z',
  });
  const episode = {
    schemaVersion: 1 as const, ownerId: 'user-a', id: 'episode-trace', sessionId: 'session-trace', sessionKind: 'cogseed_runtime' as const,
    taskRunId: 'run-trace-b', k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] }, s: {},
    t: { userGoal: 'Trace all lifecycle records', constraints: [] }, a: { toolCalls: [], agentActions: [] },
    r: { status: 'completed' as const, producedFiles: [], finalText: 'done' }, evidenceRefs: [],
    createdAt: '2026-09-03T00:00:06.000Z', updatedAt: '2026-09-03T00:00:07.000Z',
  };
  await episodes.writeKstarEpisode('user-a', episode);
  requirement.episodeIds = [episode.id];
  await store.replaceKstarRequirement('user-a', requirement);

  const trace = await (await import('../../../../src/main/features/kstar/trace')).readKstarTrace('user-a', { taskId: task.id });

  expect(trace.conversationId).toBe('cid-task-only');
  expect(trace.taskId).toBe(task.id);
  expect(trace.nodes.filter((entry) => entry.stage === 'projection')).toEqual([
    expect.objectContaining({ primaryId: projectionA.id, status: 'pending' }),
    expect.objectContaining({ primaryId: projectionB.id, status: 'ok' }),
  ]);
  expect(trace.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'forecast', primaryId: 'forecast-trace', status: 'ok' }),
    expect.objectContaining({ stage: 'extraction', primaryId: 'ksx-episode-trace', status: 'degraded' }),
    expect.objectContaining({ stage: 'precipitation', primaryId: 'ksx-episode-trace', status: 'degraded', summary: expect.stringContaining('asset-trace') }),
  ]));
});

it('includes a control failure persisted with only conversationId', async () => {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const failures = await import('../../../../src/main/features/kstar/failure-service');
  const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-failure-only', title: 'Failure trace' });
  await store.replaceKstarTask('user-a', task);
  await failures.recordKstarFailure('user-a', {
    conversationId: task.conversationId, stage: 'control_receipt', errorCode: 'control_failed',
    errorMessage: 'control receipt failed', operationKey: 'op-failure-only',
  });

  const trace = await (await import('../../../../src/main/features/kstar/trace')).readKstarTrace('user-a', { taskId: task.id });

  expect(trace.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'failure', errorCode: 'control_failed', summary: 'control receipt failed' }),
  ]));
});
