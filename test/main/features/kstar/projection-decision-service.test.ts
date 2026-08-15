import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-projection-decision-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedProjection(options: { confirm?: boolean } = {}) {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const projections = await import('../../../../src/main/features/recall/context-projection');

  const task = store.createKstarTaskRecord('user-a', {
    conversationId: 'cid-a',
    workspaceId: 'workspace-a',
    title: 'Fix OAuth callback',
  });
  const requirement = store.createKstarRequirementRecord('user-a', {
    taskId: task.id,
    conversationId: 'cid-a',
    userMessageIds: ['msg-a'],
    title: 'Fix OAuth callback',
    goalText: 'Fix OAuth callback',
  });
  task.requirementIds = [requirement.id];
  task.currentRequirementId = requirement.id;
  const preview = await projections.previewContextProjection('user-a', {
    taskRunId: task.id,
    workspaceId: 'workspace-a',
    purpose: 'Use frozen OAuth review knowledge',
    taskText: 'Fix OAuth callback',
  });
  const projection = options.confirm
    ? await projections.confirmContextProjection('user-a', preview.id)
    : preview;
  requirement.projectionId = projection.id;
  requirement.projectionIds = [projection.id];
  await store.replaceKstarTask('user-a', task);
  await store.replaceKstarRequirement('user-a', requirement);
  await store.writeConversationTaskState('user-a', {
    ...store.createInitialConversationTaskState('user-a', 'cid-a'),
    currentTaskId: task.id,
    currentRequirementId: requirement.id,
    taskComplete: false,
  });
  return { task, requirement, projection };
}

async function seedLegacyPending(status: 'waiting_confirmation' | 'forecasting' | 'world_model_failed' | 'ready_to_dispatch', forecastId?: string) {
  const groupState = await import('../../../../src/main/features/group_chat/state');
  await groupState.setPendingProjectionDispatch('user-a', 'cid-legacy', {
    projectionId: 'proj-legacy',
    requirementId: 'ksreq-legacy',
    taskRunId: 'kst-legacy',
    userMessageId: 'msg-legacy',
    userMessageText: '帮我修复登录问题',
    status,
    ...(forecastId ? { forecastId } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function forecastFiles(): string[] {
  const dir = path.join(tmpDir, 'user-a', 'cloud', 'recall', 'records', 'world-model-forecasts');
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

describe('KStar Projection decision resume', () => {
  it('approves once and resumes the same Commander session', async () => {
    const seeded = await seedProjection();
    const module = await import('../../../../src/main/features/kstar/projection-decision-service');
    const enqueueControl = vi.fn(async () => undefined);

    const first = await module.confirmProjectionAndResumeCommander('user-a', {
      cid: 'cid-a',
      projectionId: seeded.projection.id,
    }, { enqueueControl });
    const second = await module.confirmProjectionAndResumeCommander('user-a', {
      cid: 'cid-a',
      projectionId: seeded.projection.id,
    }, { enqueueControl });

    expect(first.resumed).toBe(true);
    expect(second.resumed).toBe(false);
    expect(first.projection.status).toBe('confirmed');
    expect(enqueueControl).toHaveBeenCalledTimes(1);
    expect(enqueueControl).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-a',
      cid: 'cid-a',
      control: expect.objectContaining({
        type: 'kstar_projection_decision',
        projectionId: seeded.projection.id,
        decision: 'approved',
        confirmedSnapshot: { assetIds: [], ruleRefs: [] },
      }),
    }));
    expect(JSON.stringify(enqueueControl.mock.calls[0][0].control)).not.toContain(tmpDir);
  });

  it('rejects without creating a Forecast and resumes with rejected', async () => {
    const seeded = await seedProjection();
    const module = await import('../../../../src/main/features/kstar/projection-decision-service');
    const enqueueControl = vi.fn(async () => undefined);

    const result = await module.rejectProjectionAndResumeCommander('user-a', {
      cid: 'cid-a',
      projectionId: seeded.projection.id,
      note: 'not now',
    }, { enqueueControl });

    expect(result.projection.status).toBe('rejected');
    expect(result.resumed).toBe(true);
    expect(enqueueControl).toHaveBeenCalledWith(expect.objectContaining({
      control: expect.objectContaining({
        type: 'kstar_projection_decision',
        projectionId: seeded.projection.id,
        decision: 'rejected',
      }),
    }));
    expect(forecastFiles()).toEqual([]);
  });

  it.each(['world_model_failed', 'forecasting'] as const)(
    'translates legacy %s into one Commander continuation with the original text',
    async (status) => {
      await seedLegacyPending(status);
      const module = await import('../../../../src/main/features/kstar/projection-decision-service');
      const enqueueControl = vi.fn(async () => undefined);

      const first = await module.recoverLegacyPendingProjectionDispatch('user-a', 'cid-legacy', { enqueueControl });
      const second = await module.recoverLegacyPendingProjectionDispatch('user-a', 'cid-legacy', { enqueueControl });

      expect(first).toBe('resumed');
      expect(second).toBe('none');
      expect(enqueueControl).toHaveBeenCalledTimes(1);
      expect(enqueueControl).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-a',
        cid: 'cid-legacy',
        control: expect.objectContaining({
          type: 'kstar_projection_decision',
          decision: 'approved',
          legacy: expect.objectContaining({ originalText: '帮我修复登录问题' }),
        }),
      }));
      expect(JSON.stringify(enqueueControl.mock.calls[0][0].control)).not.toContain('forecastId');
      const groupState = await import('../../../../src/main/features/group_chat/state');
      expect((await groupState.readState('user-a', 'cid-legacy')).pending_projection_dispatch).toBeUndefined();
    },
  );

  it('translates legacy ready_to_dispatch with its forecast id and clears the marker', async () => {
    await seedLegacyPending('ready_to_dispatch', 'wmf-legacy');
    const module = await import('../../../../src/main/features/kstar/projection-decision-service');
    const enqueueControl = vi.fn(async () => undefined);

    const first = await module.recoverLegacyPendingProjectionDispatch('user-a', 'cid-legacy', { enqueueControl });
    const second = await module.recoverLegacyPendingProjectionDispatch('user-a', 'cid-legacy', { enqueueControl });

    expect(first).toBe('resumed');
    expect(second).toBe('none');
    expect(enqueueControl).toHaveBeenCalledTimes(1);
    expect(enqueueControl.mock.calls[0][0].control.legacy).toMatchObject({
      requirementId: 'ksreq-legacy',
      taskRunId: 'kst-legacy',
      forecastId: 'wmf-legacy',
      originalText: '帮我修复登录问题',
    });
    const groupState = await import('../../../../src/main/features/group_chat/state');
    expect((await groupState.readState('user-a', 'cid-legacy')).pending_projection_dispatch).toBeUndefined();
  });

  it('leaves legacy waiting_confirmation pending for the user card', async () => {
    await seedLegacyPending('waiting_confirmation');
    const module = await import('../../../../src/main/features/kstar/projection-decision-service');
    const enqueueControl = vi.fn(async () => undefined);

    expect(await module.recoverLegacyPendingProjectionDispatch('user-a', 'cid-legacy', { enqueueControl })).toBe('waiting_confirmation');
    expect(enqueueControl).not.toHaveBeenCalled();
    const groupState = await import('../../../../src/main/features/group_chat/state');
    expect((await groupState.readState('user-a', 'cid-legacy')).pending_projection_dispatch?.status).toBe('waiting_confirmation');
  });

  it('resumes a confirmed retry without re-confirming side effects', async () => {
    const seeded = await seedProjection({ confirm: true });
    const module = await import('../../../../src/main/features/kstar/projection-decision-service');
    const enqueueControl = vi.fn(async () => undefined);

    const result = await module.retryProjectionInCommander('user-a', {
      cid: 'cid-a',
      projectionId: seeded.projection.id,
    }, { enqueueControl });

    expect(result.projection.status).toBe('confirmed');
    expect(result.resumed).toBe(true);
    expect(enqueueControl).toHaveBeenCalledTimes(1);
    expect(enqueueControl.mock.calls[0][0].control.decision).toBe('approved');
  });
});
