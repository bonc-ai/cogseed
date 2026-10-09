import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let tmp: string; let previous: string | undefined;
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-workspace-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmp; });
afterEach(() => { if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });
async function modules() { const [candidates, refs] = await Promise.all([import('../../../../src/main/features/recall/candidate-service'), import('../../../../src/main/features/recall/workspace-refs')]); return { candidates, refs }; }

describe('Recall workspace asset references', () => {
  it('references one asset from multiple workspaces without copying ownership', async () => {
    const { candidates, refs } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Preserve source evidence.', suggestedType: 'rule', suggestedScope: 'project,review', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const first = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'project,review' });
    const duplicate = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'project,review' });
    const second = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-b', scope: 'project' });
    expect(duplicate.id).toBe(first.id);
    expect(second.assetId).toBe(first.assetId);
    expect((await refs.listWorkspaceAssetReferences('user-a', asset.id)).map((ref) => ref.workspaceId)).toEqual(['workspace-a', 'workspace-b']);
  });

  it('permits scope narrowing and preserves removal history', async () => {
    const { candidates, refs } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Use source evidence.', suggestedType: 'rule', suggestedScope: 'project,review', sourceRefs: [{ kind: 'memory', id: 'mem-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const reference = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'project,review' });
    const narrowed = await refs.updateWorkspaceAssetReference('user-a', reference.id, { scope: 'project' });
    expect(narrowed.scope).toBe('project');
    await expect(refs.updateWorkspaceAssetReference('user-a', reference.id, { scope: 'project,review,global' })).rejects.toThrow(/expand/i);
    await refs.removeWorkspaceAssetReference('user-a', reference.id);
    expect(await refs.listWorkspaceAssetReferences('user-a', asset.id)).toEqual([]);
    expect((await refs.listWorkspaceAssetReferenceHistory('user-a', reference.id)).map((entry) => entry.action)).toEqual(['added', 'scope_updated', 'removed']);
  });
});
