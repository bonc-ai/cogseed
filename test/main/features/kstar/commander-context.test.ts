import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-commander-kstar-context-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedContext() {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const projections = await import('../../../../src/main/features/recall/context-projection');
  const worldModel = await import('../../../../src/main/features/recall/world-model');

  const task = store.createKstarTaskRecord('user-a', {
    conversationId: 'cid-a',
    workspaceId: 'private-workspace',
    title: 'Current task',
  });
  const requirement = store.createKstarRequirementRecord('user-a', {
    taskId: task.id,
    conversationId: 'cid-a',
    userMessageIds: ['msg-a'],
    title: 'Current requirement',
    goalText: `Current goal ${'x'.repeat(2_500)}`,
    rHat: {
      summary: `Expected ${'y'.repeat(2_500)}`,
      acceptanceSignals: Array.from({ length: 30 }, (_, index) => `signal-${index}-${'z'.repeat(600)}`),
      source: 'model',
      confidence: 0.8,
    },
  });
  const projection = await projections.previewContextProjection('user-a', {
    taskRunId: task.id,
    workspaceId: 'private-workspace',
    purpose: `Review ${'p'.repeat(100)}`,
    taskText: requirement.goalText.slice(0, 1_900),
  });
  const forecast = worldModel.buildWorldModelForecastRecord('user-a', {
    taskRunId: task.id,
    requirementId: requirement.id,
    projectionId: projection.id,
    projectionConfirmedAt: projection.createdAt,
    assetVersions: {},
    ruleRefs: [],
    snapshotId: 'snap-a',
    simulationInput: {
      k: { abilityAssetRefs: [], rules: [] },
      s: { conversationSummary: 'private summary' },
      t: { userGoal: 'Current goal', constraints: [] },
    },
    forecast: {
      aHat: { plan: ['Answer'], expectedTools: [], expectedActors: ['commander'] },
      rHat: { summary: 'Result', acceptanceSignals: ['done'], predictedFiles: [] },
      predictedRisks: [],
      selectedCandidateId: 'path-a',
    },
  });
  await worldModel.saveWorldModelForecast('user-a', forecast);
  requirement.projectionId = projection.id;
  requirement.projectionIds = [projection.id];
  requirement.forecastId = forecast.id;
  task.requirementIds = [requirement.id];
  task.currentRequirementId = requirement.id;
  await store.replaceKstarTask('user-a', task);
  await store.replaceKstarRequirement('user-a', requirement);
  await store.writeConversationTaskState('user-a', {
    ...store.createInitialConversationTaskState('user-a', 'cid-a'),
    currentTaskId: task.id,
    currentRequirementId: requirement.id,
    controlReceipts: [{
      idempotencyKey: 'turn-a:create',
      inputHash: 'a'.repeat(64),
      operation: 'upsert_state',
      actor: 'commander',
      conversationId: 'cid-a',
      taskId: task.id,
      requirementId: requirement.id,
      status: 'ok',
      result: { ok: true, status: 'state_committed', taskId: task.id, requirementId: requirement.id },
      createdAt: '2026-08-14T00:00:00.000Z',
    }],
  });

  const unrelated = store.createKstarTaskRecord('user-a', {
    conversationId: 'cid-other',
    title: 'Unrelated secret task',
  });
  await store.replaceKstarTask('user-a', unrelated);
  return { task, requirement, projection, forecast };
}

describe('Commander KStar context', () => {
  it('reads and bounds only the current conversation facts', async () => {
    const seeded = await seedContext();
    const module = await import('../../../../src/main/features/kstar/commander-context');

    const context = await module.readCommanderKstarContext('user-a', 'cid-a', {
      confirmation: { projectionId: seeded.projection.id, decision: 'approved' },
    });

    expect(context).toMatchObject({
      conversationId: 'cid-a',
      task: { id: seeded.task.id, status: 'open', title: 'Current task' },
      requirement: { id: seeded.requirement.id, status: 'open' },
      pendingProjection: { id: seeded.projection.id, status: 'preview' },
      forecast: { id: seeded.forecast.id, selectedCandidateId: 'path-a' },
      confirmation: { projectionId: seeded.projection.id, decision: 'approved' },
    });
    expect(context.requirement?.goalText.length).toBeLessThanOrEqual(2_000);
    expect(context.requirement?.expectedResult?.summary.length).toBeLessThanOrEqual(2_000);
    expect(context.requirement?.expectedResult?.acceptanceSignals).toHaveLength(20);
    expect(context.requirement?.expectedResult?.acceptanceSignals.every((signal) => signal.length <= 500)).toBe(true);
    expect(context.pendingProjection?.purpose.length).toBeLessThanOrEqual(2_000);

    const rendered = module.renderCommanderKstarContextBlock(context);
    expect(rendered).toContain('Ordinary conversation requires no KStar write');
    expect(rendered).not.toContain('private-workspace');
    expect(rendered).not.toContain('Unrelated secret task');
    expect(rendered).not.toContain('controlReceipts');
    expect(rendered).not.toContain('inputHash');
    expect(rendered).not.toContain('credential');
  });

  it('renders a bounded none state without instructing Task creation', async () => {
    const module = await import('../../../../src/main/features/kstar/commander-context');

    const context = await module.readCommanderKstarContext('user-a', 'cid-empty');
    const rendered = module.renderCommanderKstarContextBlock(context);

    expect(context).toEqual({ conversationId: 'cid-empty' });
    expect(rendered).toContain('"status":"none"');
    expect(rendered).not.toMatch(/must create|create a task/i);
  });
});
