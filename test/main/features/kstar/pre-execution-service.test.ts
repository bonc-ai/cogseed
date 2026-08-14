import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-pre-execution-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seed() {
  const requirementStore = await import('../../../../src/main/features/kstar/requirement-store');
  const projectionStore = await import('../../../../src/main/features/recall/context-projection');
  const groupState = await import('../../../../src/main/features/group_chat/state');
  const task = requirementStore.createKstarTaskRecord('user-a', {
    conversationId: 'cid-a', title: 'Fix OAuth callback', workspaceId: 'workspace-a',
  });
  const requirement = requirementStore.createKstarRequirementRecord('user-a', {
    taskId: task.id,
    conversationId: 'cid-a',
    userMessageIds: ['msg-a'],
    title: 'Fix OAuth callback',
    goalText: 'Fix OAuth callback',
    rHat: { summary: 'OAuth callback works', acceptanceSignals: ['OAuth test passes'], source: 'user_message', confidence: 1 },
  });
  const preview = await projectionStore.previewContextProjection('user-a', {
    taskRunId: task.id,
    workspaceId: 'workspace-a',
    purpose: 'Fix OAuth callback',
    taskText: 'Fix OAuth callback',
  });
  requirement.projectionId = preview.id;
  requirement.projectionIds = [preview.id];
  task.requirementIds = [requirement.id];
  task.currentRequirementId = requirement.id;
  await requirementStore.replaceKstarRequirement('user-a', requirement);
  await requirementStore.replaceKstarTask('user-a', task);
  await groupState.setPendingProjectionDispatch('user-a', 'cid-a', {
    projectionId: preview.id,
    requirementId: requirement.id,
    taskRunId: task.id,
    userMessageId: 'msg-a',
    userMessageText: 'Fix OAuth callback',
    status: 'waiting_confirmation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { task, requirement, preview, requirementStore, groupState };
}

function fakeForecast(requirementId: string, taskRunId: string) {
  return {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'wf-a',
    taskRunId,
    requirementId,
    input: {
      k: { abilityAssetRefs: [], rules: [] },
      s: { workspaceId: 'workspace-a', conversationSummary: 'Fix OAuth callback' },
      t: { userGoal: 'Fix OAuth callback', constraints: [] },
    },
    forecast: {
      aHat: { plan: ['fix'], expectedTools: ['write_file'], expectedActors: ['commander'] },
      rHat: { summary: 'OAuth callback works', acceptanceSignals: ['OAuth test passes'], predictedFiles: [] },
      predictedRisks: [],
    },
    createdAt: new Date().toISOString(),
  } as any;
}

describe('KSTAR pre-execution orchestration', () => {
  it('keeps the dispatch pending when Forecast fails', async () => {
    const seeded = await seed();
    const service = await import('../../../../src/main/features/kstar/pre-execution-service');
    let resumeCalls = 0;
    const error = Object.assign(new Error('model configuration is required'), { code: 'model_not_configured' });

    await expect(service.confirmProjectionAndPrepareDispatch('user-a', {
      cid: 'cid-a', projectionId: seeded.preview.id,
    }, {
      runWorldModel: async () => { throw error; },
      resumeDispatch: async () => { resumeCalls += 1; return true; },
    })).rejects.toMatchObject({ code: 'model_not_configured' });

    expect((await seeded.groupState.readState('user-a', 'cid-a')).pending_projection_dispatch)
      .toMatchObject({ status: 'world_model_failed', errorCode: 'model_not_configured' });
    expect(resumeCalls).toBe(0);
    expect((await seeded.requirementStore.readKstarRequirement('user-a', seeded.requirement.id))?.forecastId)
      .toBeUndefined();
  });

  it('persists Forecast then marks ready and resumes exactly once', async () => {
    const seeded = await seed();
    const service = await import('../../../../src/main/features/kstar/pre-execution-service');
    let resumeCalls = 0;
    const forecast = fakeForecast(seeded.requirement.id, seeded.task.id);

    const result = await service.confirmProjectionAndPrepareDispatch('user-a', {
      cid: 'cid-a', projectionId: seeded.preview.id,
    }, {
      runWorldModel: async () => forecast,
      resumeDispatch: async () => { resumeCalls += 1; return true; },
    });

    expect(result).toMatchObject({ resumed: true, forecast: { id: 'wf-a' } });
    expect(resumeCalls).toBe(1);
    expect((await seeded.requirementStore.readKstarRequirement('user-a', seeded.requirement.id))?.forecastId)
      .toBe('wf-a');
    expect((await seeded.groupState.readState('user-a', 'cid-a')).pending_projection_dispatch)
      .toMatchObject({ status: 'ready_to_dispatch', forecastId: 'wf-a' });
  });
});
