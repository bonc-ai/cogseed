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

  it('creates and binds a Projection, then posts its card once', async () => {
    const seeded = await seedOpenControlState();
    const service = await import('../../../../src/main/features/kstar/control-service');
    const postProjectionCard = vi.fn(async () => undefined);

    const result = await service.executeKstarControl(hostContext({ postProjectionCard }), {
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
    });
    expect(postProjectionCard).toHaveBeenCalledTimes(1);
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
});
