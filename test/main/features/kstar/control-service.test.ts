import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const forecastMock = vi.hoisted(() => ({
  commitCommanderForecast: vi.fn(),
}));

vi.mock('../../../../src/main/features/kstar/forecast-commit', () => forecastMock);
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  forecastMock.commitCommanderForecast.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-control-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function hostContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-a',
    conversationId: 'cid-a',
    sourceMessageId: 'msg-a',
    workspaceId: 'workspace-a',
    allowedToolNames: new Set(['read_file', 'kstar_control']),
    ...overrides,
  };
}

function createStateInput(idempotencyKey = 'turn-a:create') {
  return {
    operation: 'upsert_state',
    idempotencyKey,
    task: {
      operation: 'create',
      title: 'Fix OAuth callback',
    },
    requirement: {
      operation: 'create',
      goalText: 'Validate OAuth state before token exchange',
      expectedResult: {
        summary: 'OAuth callback state is validated',
        acceptanceSignals: ['OAuth callback test passes'],
        source: 'user_message',
        confidence: 0.9,
      },
    },
  };
}

async function seedOpenControlState() {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const task = store.createKstarTaskRecord('user-a', {
    conversationId: 'cid-a',
    workspaceId: 'workspace-a',
    title: 'Existing task',
  });
  const requirement = store.createKstarRequirementRecord('user-a', {
    taskId: task.id,
    conversationId: 'cid-a',
    userMessageIds: ['msg-a'],
    title: 'Existing requirement',
    goalText: 'Complete the existing requirement',
  });
  task.requirementIds = [requirement.id];
  task.currentRequirementId = requirement.id;
  await store.replaceKstarTask('user-a', task);
  await store.replaceKstarRequirement('user-a', requirement);
  await store.writeConversationTaskState('user-a', {
    ...store.createInitialConversationTaskState('user-a', 'cid-a'),
    currentTaskId: task.id,
    currentRequirementId: requirement.id,
  });
  return { store, task, requirement };
}

async function recordCounts() {
  const records = await import('../../../../src/main/features/kstar/episode-store');
  const [tasks, requirements] = await Promise.all([
    records.listKstarJsonRecords('user-a', 'tasks'),
    records.listKstarJsonRecords('user-a', 'requirements'),
  ]);
  return { tasks: tasks.length, requirements: requirements.length };
}

describe('KStar Commander control service', () => {
  it('creates Task and Requirement only for an explicit create and replays the same key', async () => {
    const service = await import('../../../../src/main/features/kstar/control-service');

    const first = await service.executeKstarControl(hostContext(), createStateInput());
    const second = await service.executeKstarControl(hostContext(), createStateInput());

    expect(first).toMatchObject({ ok: true, status: 'state_committed' });
    expect(second).toMatchObject({ ok: true, status: 'state_committed', replayed: true });
    expect(await recordCounts()).toEqual({ tasks: 1, requirements: 1 });
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const state = await store.readConversationTaskState('user-a', 'cid-a');
    expect(state?.controlReceipts).toHaveLength(1);
    expect(state?.controlReceipts?.[0]).toMatchObject({
      operation: 'upsert_state',
      actor: 'commander',
      status: 'ok',
      conversationId: 'cid-a',
    });
  });

  it('self-heals an empty upsert_state from the triggering user message (host routing fallback)', async () => {
    const service = await import('../../../../src/main/features/kstar/control-service');
    const result = await service.executeKstarControl({
      ...hostContext(),
      sourceMessageText: '审查一下 bus.ts 的守卫实现',
    }, {
      operation: 'upsert_state',
      idempotencyKey: 'turn-heal:create',
      // No task/requirement payloads — the Commander emitted an empty call.
    });

    expect(result).toMatchObject({ ok: true, status: 'state_committed' });
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const task = await store.readKstarTask('user-a', (result as { taskId: string }).taskId);
    expect(task?.title).toBe('审查一下 bus.ts 的守卫实现');
    const requirement = await store.readKstarRequirement('user-a', (result as { requirementId: string }).requirementId);
    expect(requirement?.goalText).toBe('审查一下 bus.ts 的守卫实现');
  });

  it('rejects arbitrary ids and reuse of one key for different normalized input', async () => {
    const service = await import('../../../../src/main/features/kstar/control-service');

    await expect(service.executeKstarControl(hostContext(), {
      operation: 'upsert_state',
      idempotencyKey: 'turn-a:update',
      task: { operation: 'update', taskId: 'kst-other', title: 'Spoofed' },
      requirement: { operation: 'keep', requirementId: 'ksreq-other' },
    })).resolves.toMatchObject({ ok: false, code: 'kstar_control_invalid_input' });

    await service.executeKstarControl(hostContext(), createStateInput('same-key'));
    await expect(service.executeKstarControl(hostContext(), {
      operation: 'abandon',
      idempotencyKey: 'same-key',
      result: { closeReason: 'Changed intent' },
    })).resolves.toMatchObject({ ok: false, code: 'kstar_control_invalid_input' });
    expect(await recordCounts()).toEqual({ tasks: 1, requirements: 1 });
  });

  it('updates only the current persisted Task and Requirement', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');

    const result = await service.executeKstarControl(hostContext(), {
      operation: 'upsert_state',
      idempotencyKey: 'turn-a:update-current',
      task: { operation: 'update', taskId: seeded.task.id, title: 'Updated task' },
      requirement: {
        operation: 'update',
        requirementId: seeded.requirement.id,
        goalText: 'Updated requirement goal',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'state_committed',
      taskId: seeded.task.id,
      requirementId: seeded.requirement.id,
    });
    await expect(seeded.store.readKstarTask('user-a', seeded.task.id))
      .resolves.toMatchObject({ title: 'Updated task' });
    await expect(seeded.store.readKstarRequirement('user-a', seeded.requirement.id))
      .resolves.toMatchObject({ goalText: 'Updated requirement goal' });
  });

  it('moves finish into the existing closure pipeline, persists evidence, and replays idempotently', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');
    const input = {
      operation: 'finish',
      idempotencyKey: 'turn-a:finish',
      result: {
        finalStatus: 'completed',
        finalText: 'The task is complete.',
        producedFiles: ['report.md'],
        acceptanceEvidence: ['OAuth callback test passes'],
      },
    };

    const first = await service.executeKstarControl(hostContext(), input);
    const second = await service.executeKstarControl(hostContext(), input);

    expect(first).toMatchObject({ ok: true, status: 'finished', taskId: seeded.task.id });
    expect(second).toMatchObject({ ok: true, status: 'finished', replayed: true });
    await expect(seeded.store.readKstarTask('user-a', seeded.task.id))
      .resolves.toMatchObject({ status: 'closing', closeReason: 'user_complete' });
    await expect(seeded.store.readKstarRequirement('user-a', seeded.requirement.id))
      .resolves.toMatchObject({
        status: 'waiting_review',
        completionEvidence: {
          finalStatus: 'completed',
          finalText: 'The task is complete.',
          producedFiles: ['report.md'],
          acceptanceEvidence: ['OAuth callback test passes'],
        },
      });
    await expect(seeded.store.readConversationTaskState('user-a', 'cid-a'))
      .resolves.toMatchObject({
        requirementJustClosed: seeded.requirement.id,
        taskComplete: true,
      });
  });

  it('records the close reason when a task is abandoned', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');

    const result = await service.executeKstarControl(hostContext(), {
      operation: 'abandon',
      idempotencyKey: 'turn-a:abandon-evidence',
      result: { closeReason: 'User cancelled the task' },
    });

    expect(result).toMatchObject({ ok: true, status: 'abandoned', taskId: seeded.task.id });
    await expect(seeded.store.readKstarRequirement('user-a', seeded.requirement.id))
      .resolves.toMatchObject({
        status: 'abandoned',
        completionEvidence: { closeReason: 'User cancelled the task' },
      });
  });

  it('abandons without creating a replacement Task', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');

    const result = await service.executeKstarControl(hostContext(), {
      operation: 'abandon',
      idempotencyKey: 'turn-a:abandon',
      result: { closeReason: 'User cancelled the task' },
    });

    expect(result).toMatchObject({ ok: true, status: 'abandoned', taskId: seeded.task.id });
    await expect(seeded.store.readKstarTask('user-a', seeded.task.id))
      .resolves.toMatchObject({ status: 'abandoned', closeReason: 'aborted' });
    await expect(seeded.store.readKstarRequirement('user-a', seeded.requirement.id))
      .resolves.toMatchObject({ status: 'abandoned' });
    const state = await seeded.store.readConversationTaskState('user-a', 'cid-a');
    expect(state).toMatchObject({ taskComplete: false });
    expect(state).not.toHaveProperty('currentTaskId');
    expect(state).not.toHaveProperty('currentRequirementId');
    expect(await recordCounts()).toEqual({ tasks: 1, requirements: 1 });
  });

  it('creates and binds an auto-confirmed Projection without posting a card', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');

    const result = await service.executeKstarControl(hostContext(), {
      operation: 'request_projection',
      idempotencyKey: 'turn-a:projection',
      projection: {
        requirementId: seeded.requirement.id,
        purpose: 'Use frozen OAuth review knowledge',
        taskText: 'Complete the existing requirement',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'projection_confirmed',
      taskId: seeded.task.id,
      requirementId: seeded.requirement.id,
      projectionId: expect.stringMatching(/^proj-/),
      next_step: expect.stringContaining('commit_forecast'),
    });
    await expect(seeded.store.readKstarRequirement('user-a', seeded.requirement.id))
      .resolves.toMatchObject({
        projectionId: (result as { projectionId: string }).projectionId,
        projectionIds: [(result as { projectionId: string }).projectionId],
      });
    // workspace_policy line: the projection is confirmed on creation.
    const projections = await import('../../../../src/main/features/recall/context-projection');
    await expect(projections.readContextProjection('user-a', (result as { projectionId: string }).projectionId))
      .resolves.toMatchObject({
        status: 'confirmed',
        authorization: 'workspace_policy',
        confirmedAt: expect.any(String),
      });
  });

  it('commits Forecast candidates with the host-bound allowed tool set', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');
    await seeded.store.replaceKstarRequirement('user-a', {
      ...seeded.requirement,
      projectionId: 'proj-a',
      projectionIds: ['proj-a'],
    });
    forecastMock.commitCommanderForecast.mockResolvedValue({
      id: 'wf-a',
      forecast: { selectedCandidateId: 'path-a' },
    });

    const result = await service.executeKstarControl(hostContext(), {
      operation: 'commit_forecast',
      idempotencyKey: 'turn-a:forecast',
      forecast: {
        taskRunId: seeded.task.id,
        requirementId: seeded.requirement.id,
        projectionId: 'proj-a',
        candidates: [{ id: 'path-a' }, { id: 'path-b' }],
        constraints: ['No public API change'],
        acceptanceCriteria: ['Tests pass'],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'forecast_committed',
      taskId: seeded.task.id,
      requirementId: seeded.requirement.id,
      projectionId: 'proj-a',
      forecastId: 'wf-a',
      selectedCandidateId: 'path-a',
    });
    expect(forecastMock.commitCommanderForecast).toHaveBeenCalledWith('user-a', expect.objectContaining({
      taskRunId: seeded.task.id,
      requirementId: seeded.requirement.id,
      projectionId: 'proj-a',
      taskText: seeded.requirement.goalText,
      allowedToolNames: new Set(['read_file', 'kstar_control']),
    }));
  });

  it('accepts a STRINGIFIED forecast payload (deepseek emits nested objects as JSON strings) and resolves real ids from state', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');
    await seeded.store.replaceKstarRequirement('user-a', {
      ...seeded.requirement,
      projectionId: 'proj-a',
      projectionIds: ['proj-a'],
    });
    forecastMock.commitCommanderForecast.mockResolvedValue({
      id: 'wf-string',
      forecast: { selectedCandidateId: 'path-a' },
    });

    // Live-observed shape: forecast arrives as a quoted JSON string, and the
    // model GUESSED ids it cannot know (taskRunId filled with the projection
    // id). The host must parse the string and resolve real ids from state.
    const result = await service.executeKstarControl(hostContext(), {
      operation: 'commit_forecast',
      idempotencyKey: 'turn-a:forecast-string',
      forecast: JSON.stringify({
        taskRunId: 'proj-a', // model-guessed, wrong
        requirementId: 'ksreq-guessed',
        projectionId: 'proj-a',
        taskText: 'Review obsidian code',
        candidates: [
          { id: 'path-a', plan: ['explore'], expectedTools: ['list_files'], expectedActors: ['commander'], predictedResult: 'report' },
          { id: 'path-b', plan: ['read'], expectedTools: ['read_file'], expectedActors: ['commander'], predictedResult: 'report' },
        ],
      }),
    });

    expect(result).toMatchObject({ ok: true, status: 'forecast_committed', forecastId: 'wf-string' });
    // The host resolved REAL ids from state, not the model's guesses.
    expect(forecastMock.commitCommanderForecast).toHaveBeenCalledWith('user-a', expect.objectContaining({
      taskRunId: seeded.task.id,
      requirementId: seeded.requirement.id,
      projectionId: 'proj-a',
      taskText: seeded.requirement.goalText,
    }));
  });

  it('rejects a stringified forecast whose payload is not valid JSON', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');
    await seeded.store.replaceKstarRequirement('user-a', {
      ...seeded.requirement,
      projectionId: 'proj-a',
      projectionIds: ['proj-a'],
    });

    const result = await service.executeKstarControl(hostContext(), {
      operation: 'commit_forecast',
      idempotencyKey: 'turn-a:forecast-bad-string',
      forecast: 'not json at all',
    });

    expect(result).toMatchObject({ ok: false, code: 'kstar_control_invalid_input' });
  });

  it('switches to a new Task on task:create, closes the old one, and precipitates requirement-level assets (B2)', async () => {
    const seeded = await seedOpenControlState();
    // Seed one episode + learning review so precipitation has evidence.
    const types = await import('../../../../src/main/features/kstar/types');
    const episode: types.KstarEpisodeRecord = {
      schemaVersion: 1,
      ownerId: 'user-a',
      id: 'kse-b2-a',
      sessionId: 'sess-b2-a',
      sessionKind: 'cogseed_runtime',
      taskRunId: 'run-b2-a',
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
      s: { workspaceId: 'workspace-a' },
      t: { userGoal: 'Complete the existing requirement', constraints: [] },
      a: {
        toolCalls: [
          { name: 'read_file', status: 'ok', argumentsSummary: '{}' },
          { name: 'write_file', status: 'ok', argumentsSummary: '{}' },
        ],
        agentActions: [],
      },
      r: { status: 'completed', producedFiles: [], finalText: 'done' },
      evidenceRefs: [{ kind: 'context', id: 'ctx-b2-a' }],
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    };
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    await episodeStore.writeKstarEpisode('user-a', episode);
    const reviews = await import('../../../../src/main/features/kstar/review-service');
    const initial = reviews.createInitialKstarReview(episode);
    await reviews.saveKstarReviewRecord('user-a', {
      ...initial,
      expectedResult: 'The task is done.',
      actualResult: 'The task is done.',
      deltaR: 0.2,
      deltaA: 0.1,
      outcome: 'better_than_expected',
      attribution: 'execution_gap',
      reason: 'The workflow is reusable.',
      confidence: 0.9,
    });
    // Bind the episode to the open requirement.
    await seeded.store.replaceKstarRequirement('user-a', {
      ...seeded.requirement,
      episodeIds: ['kse-b2-a'],
    });

    const service = await import('../../../../src/main/features/kstar/control-service');
    const result = await service.executeKstarControl(hostContext(), {
      operation: 'upsert_state',
      idempotencyKey: 'turn-b2:switch',
      task: { operation: 'create', title: 'New task after switch' },
      requirement: { operation: 'create', goalText: 'Fresh goal after the switch' },
    });

    expect(result).toMatchObject({ ok: true, status: 'state_committed' });
    // Old task closed with topic_switch, old requirement parked for review.
    await expect(seeded.store.readKstarTask('user-a', seeded.task.id))
      .resolves.toMatchObject({ status: 'closing', closeReason: 'topic_switch' });
    await expect(seeded.store.readKstarRequirement('user-a', seeded.requirement.id))
      .resolves.toMatchObject({ status: 'waiting_review' });
    // New task/requirement became current.
    const state = await seeded.store.readConversationTaskState('user-a', 'cid-a');
    expect(state?.currentTaskId).not.toBe(seeded.task.id);
    const newTask = await seeded.store.readKstarTask('user-a', state!.currentTaskId!);
    expect(newTask).toMatchObject({ title: 'New task after switch', status: 'open' });
    const newRequirement = await seeded.store.readKstarRequirement('user-a', state!.currentRequirementId!);
    expect(newRequirement).toMatchObject({ goalText: 'Fresh goal after the switch' });
    // Requirement-level precipitation ran: one skill_method asset + candidate.
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const abilityAssets = await assets.listAbilityAssets('user-a');
    const precipitated = abilityAssets.filter((asset) => asset.candidateId?.startsWith('direct-'));
    expect(precipitated).toHaveLength(1);
    expect(precipitated[0]).toMatchObject({ type: 'skill_method', status: 'active' });
    // Direct-only line: no cognitive-precipitation candidates are created.
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect(await candidates.listRecallCandidates('user-a')).toHaveLength(0);
    expect(await recordCounts()).toEqual({ tasks: 2, requirements: 2 });
  });

  it('finish precipitates requirement-level assets from episode evidence (B7)', async () => {
    const seeded = await seedOpenControlState();
    const types = await import('../../../../src/main/features/kstar/types');
    const episode: types.KstarEpisodeRecord = {
      schemaVersion: 1,
      ownerId: 'user-a',
      id: 'kse-b7-a',
      sessionId: 'sess-b7-a',
      sessionKind: 'cogseed_runtime',
      taskRunId: 'run-b7-a',
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
      s: { workspaceId: 'workspace-a' },
      t: { userGoal: 'Complete the existing requirement', constraints: [] },
      a: {
        toolCalls: [
          { name: 'read_file', status: 'ok', argumentsSummary: '{}' },
          { name: 'write_file', status: 'ok', argumentsSummary: '{}' },
        ],
        agentActions: [],
      },
      r: { status: 'completed', producedFiles: [], finalText: 'done' },
      evidenceRefs: [{ kind: 'context', id: 'ctx-b7-a' }],
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    };
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    await episodeStore.writeKstarEpisode('user-a', episode);
    const reviews = await import('../../../../src/main/features/kstar/review-service');
    const initial = reviews.createInitialKstarReview(episode);
    await reviews.saveKstarReviewRecord('user-a', {
      ...initial,
      deltaR: 0.2,
      deltaA: 0.1,
      outcome: 'better_than_expected',
      attribution: 'execution_gap',
      reason: 'The workflow is reusable.',
      confidence: 0.9,
    });
    await seeded.store.replaceKstarRequirement('user-a', {
      ...seeded.requirement,
      episodeIds: ['kse-b7-a'],
    });

    const service = await import('../../../../src/main/features/kstar/control-service');
    await service.executeKstarControl(hostContext(), {
      operation: 'finish',
      idempotencyKey: 'turn-b7:finish',
      result: { finalStatus: 'completed', finalText: 'done.', producedFiles: [], acceptanceEvidence: [] },
    });

    const assets = await import('../../../../src/main/features/recall/asset-service');
    const abilityAssets = await assets.listAbilityAssets('user-a');
    expect(abilityAssets.filter((asset) => asset.candidateId?.startsWith('direct-'))).toHaveLength(1);
  });
});
