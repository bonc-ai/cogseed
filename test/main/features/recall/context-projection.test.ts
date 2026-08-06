import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let tmp: string; let previous: string | undefined;
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-projection-')); previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmp; });
afterEach(() => { if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });
async function modules() { const [candidates, assets, refs, projection] = await Promise.all([import('../../../../src/main/features/recall/candidate-service'), import('../../../../src/main/features/recall/asset-service'), import('../../../../src/main/features/recall/workspace-refs'), import('../../../../src/main/features/recall/context-projection')]); return { candidates, assets, refs, projection }; }
async function createAsset() { const { candidates } = await modules(); const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Preserve source evidence in reviews.', suggestedType: 'rule', suggestedScope: 'review,project', sourceRefs: [{ kind: 'execution', id: 'exec-a' }, { kind: 'memory', id: 'mem-a' }] }); return candidates.promoteRecallCandidate('user-a', candidate.id); }

describe('RecallView and ContextProjection', () => {
  it('previews workspace-scoped active assets and explains omitted assets', async () => {
    const { asset } = await createAsset();
    const { refs, assets, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const otherCandidate = await (await modules()).candidates.saveRecallCandidate('user-a', { judgment: 'Only use archived data with confirmation.', suggestedType: 'rule', suggestedScope: 'archive', sourceRefs: [{ kind: 'memory', id: 'mem-b' }] });
    const other = await (await modules()).candidates.promoteRecallCandidate('user-a', otherCandidate.id);
    await assets.pauseAbilityAsset('user-a', other.asset.id, 'not ready');

    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed' });
    expect(preview.status).toBe('preview');
    expect(preview.assetIds).toEqual([asset.id]);
    expect(preview.sourceRefs.map((ref) => ref.id)).toEqual(['exec-a', 'mem-a']);
    expect(preview.omittedRefs).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: other.asset.id, reason: 'asset_paused' })]));
  });

  it('confirms a non-expired projection once and rejects expired projections', async () => {
    const { asset } = await createAsset();
    const { refs, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed', expiresAt: '2099-01-01T00:00:00.000Z' });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    expect(confirmed.status).toBe('confirmed');
    await expect(projection.confirmContextProjection('user-a', preview.id)).rejects.toThrow(/already confirmed/i);

    const expired = await projection.previewContextProjection('user-a', { taskRunId: 'task-b', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed', expiresAt: '2000-01-01T00:00:00.000Z' });
    await expect(projection.confirmContextProjection('user-a', expired.id)).rejects.toThrow(/expired/i);
  });
});
