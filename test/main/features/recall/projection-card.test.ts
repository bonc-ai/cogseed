import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-projection-card-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, refs, projection, cards] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/projection-card'),
  ]);
  return { candidates, assets, refs, projection, cards };
}

async function createAsset(input: { userId?: string; judgment: string; summary: string; scope?: string; sourceId: string }) {
  const { candidates } = await modules();
  const userId = input.userId || 'user-a';
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: 'rule',
    suggestedScope: input.scope || 'review,project',
    sourceRefs: [{ kind: 'execution', id: input.sourceId }],
  });
  return candidates.promoteRecallCandidate(userId, candidate.id);
}

const fakeSemanticOptions = {
  embedTexts: async (texts: string[]) => texts.map((text) => text.toLowerCase().includes('oauth') ? [1, 0] : [0, 1]),
};

describe('Recall projection chat card', () => {
  it('builds a preview-only card with asset summaries, omitted reasons, and user decision actions', async () => {
    const included = await createAsset({
      judgment: 'Keep architecture decisions in a decision log before changing runtime boundaries.',
      summary: 'Use decision logs for architecture changes',
      sourceId: 'exec-included',
    });
    const omitted = await createAsset({
      judgment: 'Do not inject paused ability assets into current tasks.',
      summary: 'Paused assets remain visible as omissions',
      sourceId: 'exec-paused',
    });
    const { refs, assets, projection, cards } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: included.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await refs.addWorkspaceAssetReference('user-a', { assetId: omitted.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await assets.pauseAbilityAsset('user-a', omitted.asset.id, 'needs rework');

    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review' });
    const card = await cards.buildProjectionCard('user-a', preview.id);

    expect(card).toMatchObject({
      kind: 'recall_projection_card',
      projectionId: preview.id,
      taskRunId: 'task-a',
      workspaceId: 'workspace-a',
      purpose: 'review',
      status: 'preview',
      summary: { includedCount: 1, omittedCount: 1, sourceRefCount: 1 },
      includedAssetIds: [included.asset.id],
      availableActions: ['confirm', 'add_asset', 'modify_scope', 'defer', 'reject'],
    });
    expect(card.assetSummaries).toEqual([
      expect.objectContaining({
        assetId: included.asset.id,
        title: 'Use decision logs for architecture changes',
        type: 'rule',
        status: 'active',
        maturity: 'seed',
        scope: 'review,project',
      }),
    ]);
    expect(card.omittedAssetRefs).toEqual([
      expect.objectContaining({ assetId: omitted.asset.id, reason: 'asset_paused' }),
    ]);
    expect(JSON.stringify(card)).not.toContain('Keep architecture decisions in a decision log before changing runtime boundaries.');
  });



  it('includes semantic match metadata in asset summaries', async () => {
    const oauth = await createAsset({ judgment: 'Review OAuth callback security.', summary: 'OAuth review workflow', sourceId: 'exec-oauth' });
    const database = await createAsset({ judgment: 'Review database migration safety.', summary: 'Database review workflow', sourceId: 'exec-db' });
    const { refs, projection, cards } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: oauth.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await refs.addWorkspaceAssetReference('user-a', { assetId: database.asset.id, workspaceId: 'workspace-a', scope: 'review' });

    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', taskText: 'OAuth security review' }, fakeSemanticOptions);
    const card = await cards.buildProjectionCard('user-a', preview.id);

    expect(card.assetSummaries.map((asset) => asset.assetId)).toEqual([oauth.asset.id, database.asset.id]);
    expect(card.assetSummaries[0]).toEqual(expect.objectContaining({ matchMethod: 'semantic', matchScore: expect.any(Number) }));
  });

  it('renders deferred and rejected decisions without confirm actions', async () => {
    const included = await createAsset({ judgment: 'Use source evidence in reviews.', summary: 'Use source evidence', sourceId: 'exec-a' });
    const { refs, projection, cards } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: included.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review' });

    const deferred = await projection.deferContextProjection('user-a', preview.id, 'decide later');
    expect(deferred.status).toBe('deferred');
    const deferredCard = await cards.buildProjectionCard('user-a', preview.id);
    expect(deferredCard.availableActions).toEqual(['modify_scope', 'reject']);
    expect(deferredCard.decisionNote).toBe('decide later');

    await projection.rejectContextProjection('user-a', preview.id, 'not useful here');
    const rejectedCard = await cards.buildProjectionCard('user-a', preview.id);
    expect(rejectedCard.status).toBe('rejected');
    expect(rejectedCard.availableActions).toEqual([]);
    expect(rejectedCard.decisionNote).toBe('not useful here');
    await expect(projection.confirmContextProjection('user-a', preview.id)).rejects.toThrow(/not confirmable/i);
  });
});
