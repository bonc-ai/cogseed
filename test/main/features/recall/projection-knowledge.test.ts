import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-projection-knowledge-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function createAsset(input: { judgment: string; summary: string; causal?: boolean }) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate('user-a', {
      spaceId: 'workspace-a',
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: input.causal ? 'rule' : 'skill_method',
    suggestedScope: 'review',
    sourceRefs: [{ kind: 'execution', id: `exec-${input.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }],
  });
  return candidates.promoteRecallCandidate('user-a', candidate.id, {
    actor: 'user',
    ...(input.causal ? {
      causalRule: {
        cause: 'A required validation is omitted',
        effect: 'The result can be incorrect',
        mitigation: 'Run the validation before completion',
        severity: 'high',
        deltaR: -0.8,
      },
    } : {}),
  });
}

describe('committed projection knowledge', () => {
  it('loads only the exact assets frozen by the confirmed projection', async () => {
    const selected = await createAsset({ judgment: 'Validate OAuth callback state before exchange.', summary: 'OAuth rule', causal: true });
    const unprojected = await createAsset({ judgment: 'When deploying the billing service, run the migration check first, then deploy, then verify the health endpoint.', summary: 'Billing deploy', causal: false });
    const refs = await import('../../../../src/main/features/recall/workspace-refs');
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const knowledge = await import('../../../../src/main/features/recall/projection-knowledge');
    await refs.addWorkspaceAssetReference('user-a', { assetId: selected.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    // promote 自动挂载的 ref 用候选 scope（review）；测试要模拟"显式收窄到
    // other"：先移除自动挂载，再手动挂 other。
    await refs.removeWorkspaceAssetReference('user-a', `war-${unprojected.asset.id}-workspace-a`);
    await refs.addWorkspaceAssetReference('user-a', { assetId: unprojected.asset.id, workspaceId: 'workspace-a', scope: 'other' });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);

    const loaded = await knowledge.loadCommittedProjectionKnowledge('user-a', confirmed.id);

    expect(loaded.abilityAssetRefs).toEqual([selected.asset.id]);
    expect(loaded.assetVersions).toEqual(confirmed.assetVersions);
    expect(loaded.abilityAssets.map((asset) => asset.id)).not.toContain(unprojected.asset.id);
    expect(loaded.rules).toEqual([
      expect.objectContaining({
        id: `rule:${selected.asset.id}:${selected.asset.version}`,
        assetId: selected.asset.id,
        assetVersion: selected.asset.version,
      }),
    ]);
  });

  it('rejects preview projections as an execution knowledge boundary', async () => {
    const selected = await createAsset({ judgment: 'When reviewing a callback, check the state parameter first, then verify the redirect target, then confirm the token exchange result.', summary: 'Callback review', causal: false });
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const knowledge = await import('../../../../src/main/features/recall/projection-knowledge');
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-preview', purpose: 'review',
    });
    expect(preview.assetIds).toContain(selected.asset.id);

    await expect(knowledge.loadCommittedProjectionKnowledge('user-a', preview.id))
      .rejects.toMatchObject({ code: 'projection_not_committed' });
  });
});
