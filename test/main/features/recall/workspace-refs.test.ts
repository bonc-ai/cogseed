import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
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
    const candidate = await createNightlyCandidateFixture('user-a', { judgment: 'Preserve source evidence.', summary: 'Evidence preservation rule', suggestedType: 'rule', suggestedScope: 'project,review', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] });
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
    const candidate = await createNightlyCandidateFixture('user-a', { judgment: 'Use source evidence.', summary: 'Evidence usage rule', suggestedType: 'rule', suggestedScope: 'project,review', sourceRefs: [{ kind: 'memory', id: 'mem-a' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const reference = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'project,review' });
    const narrowed = await refs.updateWorkspaceAssetReference('user-a', reference.id, { scope: 'project' });
    expect(narrowed.scope).toBe('project');
    await expect(refs.updateWorkspaceAssetReference('user-a', reference.id, { scope: 'project,review,global' })).rejects.toThrow(/expand/i);
    await refs.removeWorkspaceAssetReference('user-a', reference.id);
    expect(await refs.listWorkspaceAssetReferences('user-a', asset.id)).toEqual([]);
    expect((await refs.listWorkspaceAssetReferenceHistory('user-a', reference.id)).map((entry) => entry.action)).toEqual(['added', 'scope_updated', 'removed']);
  });

  it('坏档逐条降级（r4）：一条坏引用 JSON 不炸整份引用列表，好引用照常列出（对齐 listExperiences / listAbilityAssets / listRecallCandidates 口径）', async () => {
    const { candidates, refs } = await modules();
    const candidate = await createNightlyCandidateFixture('user-a', { judgment: 'Keep source evidence.', summary: 'Evidence keeping rule', suggestedType: 'rule', suggestedScope: 'project', sourceRefs: [{ kind: 'memory', id: 'mem-w' }] });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const good = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'project' });
    const unreadable = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-b', scope: 'project' });
    const malformed = await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-c', scope: 'project' });

    const dir = path.join(tmp, 'user-a', 'cloud', 'recall', 'records', 'workspace-refs');
    // 坏档一：截断 JSON——store 读层 parse 就抛（无 errno code），走第一层降级。
    fs.writeFileSync(path.join(dir, `${unreadable.id}.json`), '{"id": "trunc');
    // 坏档二：形状错——JSON 有效但 enabled 非 boolean，asReference 抛，走第二层降级。
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${malformed.id}.json`), 'utf8'));
    raw.enabled = 'yes';
    fs.writeFileSync(path.join(dir, `${malformed.id}.json`), JSON.stringify(raw));

    // 修复前：任一坏档让整个列表 rejects（IPC workspaceRefs.list 与
    // context-projection 的投影/注入装配一并失败，好引用不可见）；
    // 修复后：坏档逐条跳过，好引用照常返回。
    expect((await refs.listWorkspaceAssetReferences('user-a', asset.id)).map((ref) => ref.workspaceId)).toEqual(['workspace-a']);
    expect((await refs.listWorkspaceAssetReferences('user-a')).map((ref) => ref.id)).toEqual([good.id]);
  });
});
