import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-world-model-bridge-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedProjection() {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const refs = await import('../../../../src/main/features/recall/workspace-refs');
  const projections = await import('../../../../src/main/features/recall/context-projection');
  const selected = await candidates.saveRecallCandidate('user-a', {
    judgment: `Validate OAuth callback state. ${'x'.repeat(2_100)}`,
    summary: 'OAuth callback validation',
    suggestedType: 'rule',
    suggestedScope: 'review',
    sourceRefs: [{ kind: 'execution', id: 'exec-oauth' }],
  });
  const promoted = await candidates.promoteRecallCandidate('user-a', selected.id, {
    actor: 'user',
    causalRule: {
      cause: 'OAuth state is not checked',
      effect: 'The callback can accept an invalid session',
      mitigation: 'Validate state before exchanging the code',
      severity: 'high',
      deltaR: -0.8,
    },
  });
  const unrelated = await candidates.saveRecallCandidate('user-a', {
    judgment: 'Deploy the billing database.',
    summary: 'Billing deployment',
    suggestedType: 'skill_method',
    suggestedScope: 'billing',
    sourceRefs: [{ kind: 'execution', id: 'exec-billing' }],
  });
  const unrelatedAsset = (await candidates.promoteRecallCandidate('user-a', unrelated.id, { actor: 'user' })).asset;
  await refs.addWorkspaceAssetReference('user-a', { assetId: promoted.asset.id, workspaceId: 'workspace-a', scope: 'review' });
  await refs.addWorkspaceAssetReference('user-a', { assetId: unrelatedAsset.id, workspaceId: 'workspace-a', scope: 'billing' });
  const preview = await projections.previewContextProjection('user-a', {
    taskRunId: 'kst-task-a', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Fix OAuth callback',
  });
  return {
    selected: promoted.asset,
    unrelated: unrelatedAsset,
    projection: await projections.confirmContextProjection('user-a', preview.id),
  };
}

const simulationResult = {
  aHat: { plan: ['Inspect callback', 'Fix state validation'], expectedTools: ['read_file', 'write_file'], expectedActors: ['commander'] },
  rHat: { summary: 'OAuth callback state is validated', acceptanceSignals: ['OAuth callback test passes'], predictedFiles: ['src/auth/callback.ts'] },
  predictedRisks: [],
};

describe('KSTAR world-model bridge', () => {
  it('builds bounded K only from the committed projection and persists redacted K/S/T provenance', async () => {
    const seeded = await seedProjection();
    const bridge = await import('../../../../src/main/features/kstar/world-model-bridge');
    const record = await bridge.runWorldModelAtBoundary('user-a', {
      taskRunId: 'kst-task-a',
      requirementId: 'ksreq-a',
      committedProjectionId: seeded.projection.id,
      workspaceId: 'workspace-a',
      taskText: 'Fix OAuth callback',
      constraints: ['Do not change the public API'],
      acceptanceCriteria: ['OAuth callback test passes'],
    }, {
      runSimulation: async () => simulationResult,
      getWorkspaceAvailability: async () => true,
    });

    expect(record).toMatchObject({
      projectionId: seeded.projection.id,
      projectionConfirmedAt: seeded.projection.confirmedAt,
      assetVersions: seeded.projection.assetVersions,
      snapshotId: expect.stringMatching(/^snap-/),
      provenanceComplete: true,
      input: {
        k: {
          projectionId: seeded.projection.id,
          abilityAssetRefs: [seeded.selected.id],
          abilityAssets: [expect.objectContaining({ id: seeded.selected.id, version: seeded.selected.version })],
        },
        s: {
          workspaceId: 'workspace-a',
          environment: { workspaceAvailable: true, modelConfigured: expect.any(Boolean), fileSystemAvailable: true, shellAvailable: true },
          lifecycle: { projectionStatus: 'confirmed' },
        },
        t: {
          userGoal: 'Fix OAuth callback',
          constraints: ['Do not change the public API'],
          acceptanceCriteria: ['OAuth callback test passes'],
        },
      },
    });
    expect(record.input.k.abilityAssets[0].statement.length).toBeLessThanOrEqual(2_000);
    expect(record.input.k.abilityAssetRefs).not.toContain(seeded.unrelated.id);
    expect(record.ruleRefs).toEqual([`rule:${seeded.selected.id}:${seeded.selected.version}`]);
    expect(JSON.stringify(record.input.s)).not.toContain(tmpDir);
  });

  it('rejects a preview projection and does not persist a Forecast', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const projections = await import('../../../../src/main/features/recall/context-projection');
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Review the callback.', summary: 'Callback review', suggestedType: 'rule', suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'exec-preview' }],
    });
    await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const preview = await projections.previewContextProjection('user-a', { taskRunId: 'kst-preview', purpose: 'review' });
    const bridge = await import('../../../../src/main/features/kstar/world-model-bridge');

    await expect(bridge.runWorldModelAtBoundary('user-a', {
      taskRunId: 'kst-preview', requirementId: 'ksreq-preview', committedProjectionId: preview.id,
      taskText: 'Review callback', constraints: [], acceptanceCriteria: [],
    }, { runSimulation: async () => simulationResult }))
      .rejects.toMatchObject({ code: 'projection_not_committed' });
  });
});
