import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previousRoot: string | undefined;
const UID = 'formal-assets-user';

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-formal-assets-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [formal, candidates, groups, users] = await Promise.all([
    import('../../../../src/main/features/recall/formal-assets'),
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/personal_ontology_groups'),
    import('../../../../src/main/features/users'),
  ]);
  users.activateUser(UID);
  return { formal, candidates, groups };
}

async function promoteRule(candidates: Awaited<ReturnType<typeof modules>>['candidates']) {
  const candidate = await candidates.saveRecallCandidate(UID, {
    judgment: '正式评审必须先讲产品模型，再谈实现细节。',
    value: '避免评审跑偏到实现细节上。',
    suggestedType: 'rule',
    suggestedScope: 'review',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'execution', id: 'exec-formal' }],
    evidenceRefs: [{ kind: 'execution', id: 'exec-formal' }],
  });
  return candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
}

describe('formal asset canonical boundary', () => {
  it('returns the four formal asset types in one envelope shape', async () => {
    const { formal, candidates } = await modules();
    const { asset } = await promoteRule(candidates);

    const list = await formal.listFormalAssets(UID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      assetId: asset.id,
      assetType: 'rule',
      owner: UID,
      version: '1',
      // 三条状态轴各就各位，互不代替。
      lifecycleStatus: 'user_confirmed_unverified',
      maturity: 'bud',
      status: 'active',
    });
    expect(list[0].payload).toEqual({ kind: 'rule' });
  });

  // PRD 3.3：支撑对象不占四类一级分类。个人本体分组曾被合成 `CA-PERSONAL-*`
  // 混进资产列表，边界建立后它们连进都进不来。
  it('never lets personal ontology groups into the formal asset API', async () => {
    const { formal, candidates, groups } = await modules();
    await promoteRule(candidates);
    const created = await groups.createGroup(UID, 'Research ontology');
    expect(created.ok).toBe(true);

    const list = await formal.listFormalAssets(UID);
    expect(list).toHaveLength(1);
    expect(list.every((asset) => asset.assetType === 'rule')).toBe(true);
    expect(list.some((asset) => asset.assetId.startsWith('CA-PERSONAL-'))).toBe(false);
  });

  it('treats a non-formal id as absent rather than returning a support object', async () => {
    const { formal, candidates, groups } = await modules();
    await promoteRule(candidates);
    const created = await groups.createGroup(UID, 'Research ontology');

    await expect(formal.getFormalAsset(UID, `CA-PERSONAL-${created.group?.group_id}`)).resolves.toBeUndefined();
    await expect(formal.getFormalAsset(UID, 'aa-does-not-exist')).resolves.toBeUndefined();
  });

  it('filters by asset type and governance status', async () => {
    const { formal, candidates } = await modules();
    const { asset } = await promoteRule(candidates);

    await expect(formal.listFormalAssets(UID, { assetType: 'personal' })).resolves.toEqual([]);
    await expect(formal.listFormalAssets(UID, { assetType: 'rule' })).resolves.toHaveLength(1);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.pauseAbilityAsset(UID, asset.id, { actor: 'user', reason: 'paused for the test' });
    await expect(formal.listFormalAssets(UID, { activeOnly: true })).resolves.toEqual([]);
    await expect(formal.listFormalAssets(UID)).resolves.toHaveLength(1);
  });

  it('returns an empty timeline for anything that is not a formal asset', async () => {
    const { formal, candidates, groups } = await modules();
    const { asset } = await promoteRule(candidates);
    const created = await groups.createGroup(UID, 'Research ontology');

    await expect(formal.listFormalAssetTimeline(UID, `CA-PERSONAL-${created.group?.group_id}`)).resolves.toEqual([]);
    const timeline = await formal.listFormalAssetTimeline(UID, asset.id);
    expect(timeline.length).toBeGreaterThan(0);
  });
});
