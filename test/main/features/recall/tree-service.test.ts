import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tree-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, usage, tree, store, capabilities] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/usage-service'),
    import('../../../../src/main/features/recall/tree-service'),
    import('../../../../src/main/features/recall/store'),
    import('../../../../src/main/features/recall/candidate-capabilities'),
  ]);
  return { candidates, assets, usage, tree, store, capabilities };
}

async function seedAsset(
  userId: string,
  judgment: string,
  sourceRef: { kind: 'conversation' | 'memory'; id: string },
) {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment,
    suggestedType: 'rule',
    suggestedScope: 'review',
    sourceRefs: [sourceRef],
  });
  const { asset } = await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
  return { candidate, asset };
}

describe('cognition tree asset relation contract', () => {
  it('projects only formal assets and their declared relations', async () => {
    const { assets, usage, tree } = await modules();
    const base = await seedAsset(
      'u',
      'Use explicit contracts for persisted relationships.',
      { kind: 'memory', id: 'mem-a' },
    );
    const refinement = await seedAsset(
      'u',
      'Version persisted relationship contracts explicitly.',
      { kind: 'conversation', id: 'conv-a' },
    );
    const updated = await assets.updateAbilityAsset('u', refinement.asset.id, {
      relations: [{ kind: 'refines', assetId: base.asset.id, note: 'Narrows the storage boundary.' }],
      derivedFrom: [base.asset.id],
      reason: 'Declare the asset relationship contract.',
      actor: 'user',
    });
    await usage.recordRecallUsage('u', {
      assetId: updated.id,
      assetVersion: updated.version,
      taskRunId: 'task-a',
      outcome: 'better',
    });

    const graph = await tree.rebuildCognitionTree('u');

    expect(graph).toMatchObject({
      contract: 'ability_asset_relations',
      contractVersion: 2,
      ownerId: 'u',
      id: 'graph',
    });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      `asset:${base.asset.id}`,
      `asset:${updated.id}`,
    ].sort());
    expect(graph.nodes.every((node) => node.type === 'asset')).toBe(true);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: `asset:${updated.id}`,
      assetType: 'rule',
      status: 'active',
      maturity: 'bud',
      version: '2',
    }));
    expect(graph.edges).toEqual([{
      from: `asset:${updated.id}`,
      to: `asset:${base.asset.id}`,
      type: 'asset_relation',
      kind: 'refines',
      note: 'Narrows the storage boundary.',
    }]);

    // Provenance stays on the asset; it is not converted into tree nodes/edges.
    const stored = await assets.readAbilityAsset('u', updated.id);
    expect(stored.derivedFrom).toEqual([base.asset.id]);
    expect(stored.sourceSessionIds).toEqual(['conv-a']);
    expect(JSON.stringify(graph)).not.toContain('source:');
    // 这两条候选都已经晋升（confirmed，canPromote=false），所以树上没有芽。
    expect(JSON.stringify(graph)).not.toContain('candidate:');
    expect(JSON.stringify(graph)).not.toContain('usage:');
    expect(JSON.stringify(graph)).not.toContain('derived_from');

    expect(await tree.readCognitionTree('u')).toEqual(graph);
  });

  it('preserves a declared relation when its target asset is not locally present', async () => {
    const { assets, tree } = await modules();
    const source = await seedAsset(
      'u-dangling',
      'Keep declared relationships available for later resolution.',
      { kind: 'memory', id: 'mem-b' },
    );
    await assets.updateAbilityAsset('u-dangling', source.asset.id, {
      relations: [{ kind: 'depends_on', assetId: 'asset-from-another-snapshot' }],
      reason: 'Declare an externally resolved dependency.',
      actor: 'user',
    });

    const graph = await tree.rebuildCognitionTree('u-dangling');

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([{
      from: `asset:${source.asset.id}`,
      to: 'asset:asset-from-another-snapshot',
      type: 'asset_relation',
      kind: 'depends_on',
    }]);
  });

  it('rebuilds a persisted pre-contract lifecycle graph on read', async () => {
    const { tree, store } = await modules();
    const current = await seedAsset(
      'u-legacy',
      'Only formal assets belong in the relationship graph.',
      { kind: 'memory', id: 'mem-legacy' },
    );
    await store.writeRecallJsonRecord('u-legacy', 'tree', 'graph', {
      schemaVersion: 1,
      ownerId: 'u-legacy',
      id: 'graph',
      nodes: [
        { id: 'source:memory:mem-legacy', type: 'source', label: 'memory:mem-legacy' },
        { id: `candidate:${current.candidate.id}`, type: 'candidate', label: current.candidate.judgment },
      ],
      edges: [{
        from: 'source:memory:mem-legacy',
        to: `candidate:${current.candidate.id}`,
        type: 'evidence',
      }],
      updatedAt: new Date().toISOString(),
    });

    const graph = await tree.readCognitionTree('u-legacy');

    expect(graph?.contract).toBe('ability_asset_relations');
    expect(graph?.nodes).toEqual([expect.objectContaining({
      id: `asset:${current.asset.id}`,
      type: 'asset',
    })]);
    expect(graph?.edges).toEqual([]);
  });

  it('rejects a malformed current asset relation contract', async () => {
    const { tree, store } = await modules();
    await store.writeRecallJsonRecord('u-malformed', 'tree', 'graph', {
      schemaVersion: 2,
      ownerId: 'u-malformed',
      id: 'graph',
      contract: 'ability_asset_relations',
      contractVersion: 2,
      nodes: [],
      edges: [{
        from: 'asset:missing-source',
        to: 'asset:unresolved-target',
        type: 'asset_relation',
        kind: 'related_to',
      }],
      updatedAt: new Date().toISOString(),
    });

    await expect(tree.readCognitionTree('u-malformed'))
      .rejects.toThrow('malformed cognition tree asset relation contract');
  });
});

/**
 * G-8「芽」。
 *
 * 芽的判据在 tree-service 一处：`getRecallCandidateCapabilities().canPromote`
 * 且过 `validatePromotionByAssetType` 晋升闸门。这一组测试盯的是产品承诺的
 * 那条不变量——**用户确认之后，芽必须消失、叶片必须出现，同一次 rebuild 里
 * 不能两个都在**。只靠"晋升会把状态改成 confirmed，所以 canPromote 变 false"
 * 这条推理是不够的：晋升路径不止一条，任何一条忘了落状态，用户看到的就是
 * 同一条认知在树上出现两次。
 */
describe('cognition tree candidate buds (G-8)', () => {
  async function seedCandidate(
    userId: string,
    input: {
      judgment: string;
      suggestedType: 'personal' | 'rule' | 'template' | 'skill_method';
      suggestedScope?: string;
      sourceRefs?: { kind: 'conversation' | 'memory'; id: string }[];
    },
  ) {
    const { candidates } = await modules();
    return candidates.saveRecallCandidate(userId, {
      judgment: input.judgment,
      suggestedType: input.suggestedType,
      suggestedScope: input.suggestedScope ?? 'review',
      sourceRefs: input.sourceRefs ?? [{ kind: 'memory', id: `mem-${input.suggestedType}` }],
    });
  }

  it('projects promotable candidates as buds mounted on their suggestedType branch', async () => {
    const { tree } = await modules();
    const rule = await seedCandidate('u-bud', {
      judgment: 'Confirm the applicable scope before a rule becomes formal.',
      suggestedType: 'rule',
      sourceRefs: [{ kind: 'conversation', id: 'conv-rule' }],
    });
    const personal = await seedCandidate('u-bud', {
      judgment: 'I work in China time and always read dates in that timezone.',
      suggestedType: 'personal',
      sourceRefs: [{ kind: 'memory', id: 'mem-personal' }],
    });

    const graph = await tree.rebuildCognitionTree('u-bud');

    expect(graph.contractVersion).toBe(2);
    const buds = graph.nodes.filter((node) => node.type === 'candidate');
    expect(buds.map((node) => node.id).sort()).toEqual([
      `candidate:${rule.id}`, `candidate:${personal.id}`,
    ].sort());
    // 挂载只认候选自己的 suggestedType，不做二次分类推断。
    expect(buds).toContainEqual(expect.objectContaining({
      id: `candidate:${rule.id}`, type: 'candidate', assetType: 'rule',
    }));
    expect(buds).toContainEqual(expect.objectContaining({
      id: `candidate:${personal.id}`, type: 'candidate', assetType: 'personal',
    }));
    // 芽不带资产生命周期字段，也不长边。
    for (const bud of buds) {
      expect(bud).not.toHaveProperty('maturity');
      expect(bud).not.toHaveProperty('version');
    }
    expect(graph.edges).toEqual([]);

    expect(await tree.readCognitionTree('u-bud')).toEqual(graph);
  });

  it('keeps rejected and failed candidates off the tree', async () => {
    const { candidates, tree, store, capabilities } = await modules();
    const rejected = await seedCandidate('u-off', {
      judgment: 'Confirm the applicable and forbidden range before a rule ships.',
      suggestedType: 'rule',
      sourceRefs: [{ kind: 'memory', id: 'mem-rejected' }],
    });
    await candidates.rejectRecallCandidate('u-off', rejected.id, 'not worth keeping');
    const failed = await seedCandidate('u-off', {
      judgment: 'Confirm the applicable and forbidden range before a rule ships twice.',
      suggestedType: 'rule',
      sourceRefs: [{ kind: 'memory', id: 'mem-failed' }],
    });
    // 沉淀失败没有对外的 setter：失败状态由晋升路径内部落盘。直接写一条
    // 真实形状的 failed 记录，模拟磁盘上已经存在的那种候选。
    const storedFailed = await store.readRecallJsonRecord('u-off', 'candidates', failed.id);
    await store.writeRecallJsonRecord('u-off', 'candidates', failed.id, {
      ...storedFailed, status: 'failed', failureCode: 'asset_write_failed',
    });

    const graph = await tree.rebuildCognitionTree('u-off');

    expect(graph.nodes.filter((node) => node.type === 'candidate')).toEqual([]);
    // failed 的 canPromote 其实是 true（重试仍可晋升），所以这条挡不住靠 canPromote，
    // 它是 tree-service 里一条独立的产品判断，必须有测试钉住。
    const reread = await candidates.readRecallCandidate('u-off', failed.id);
    expect(reread.status).toBe('failed');
    expect(capabilities.getRecallCandidateCapabilities(reread).canPromote).toBe(true);
  });

  it('keeps candidates that fail the formal asset bar off the tree', async () => {
    const { tree } = await modules();
    // template 必须是可复用结构；一句泛泛的描述过不了晋升闸门，
    // 那它在树上就不该有一个点得进去、进去却确认不成的芽。
    const belowBar = await seedCandidate('u-bar', {
      judgment: 'The team had a good discussion today.',
      suggestedType: 'template',
      sourceRefs: [{ kind: 'memory', id: 'mem-bar' }],
    });

    const graph = await tree.rebuildCognitionTree('u-bar');

    expect(graph.nodes.map((node) => node.id)).not.toContain(`candidate:${belowBar.id}`);
  });

  /** G-8 的核心不变量。这条不接受"推理上应该成立"。 */
  it('replaces the bud with an asset leaf on promotion, never both in one rebuild', async () => {
    const { candidates, tree } = await modules();
    const candidate = await seedCandidate('u-promote', {
      judgment: 'Confirm the applicable and forbidden range before a rule ships.',
      suggestedType: 'rule',
      sourceRefs: [{ kind: 'conversation', id: 'conv-promote' }],
    });

    const before = await tree.rebuildCognitionTree('u-promote');
    expect(before.nodes.map((node) => node.id)).toEqual([`candidate:${candidate.id}`]);

    const { asset } = await candidates.promoteRecallCandidate('u-promote', candidate.id, { actor: 'user' });
    const after = await tree.rebuildCognitionTree('u-promote');

    expect(after.nodes.map((node) => node.id)).toEqual([`asset:${asset.id}`]);
    expect(after.nodes.map((node) => node.id)).not.toContain(`candidate:${candidate.id}`);
    expect(after.nodes.filter((node) => node.type === 'candidate')).toEqual([]);
    expect(after.nodes.filter((node) => node.type === 'asset')).toHaveLength(1);
    // 读口和重建口给出同一棵树：用户刷新页面不会看回那颗已经确认掉的芽。
    expect(await tree.readCognitionTree('u-promote')).toEqual(after);
  });

  /**
   * 同一条认知不能既是芽又是叶——即使候选记录本身没被正确落成 confirmed。
   * 这是对上面那条不变量的第二道保险：树是投影，投影层自己也要拒绝双现。
   */
  it('drops a bud whose promoted asset is already on the tree even if the candidate状态没落', async () => {
    const { candidates, tree, store } = await modules();
    const candidate = await seedCandidate('u-drift', {
      judgment: 'Confirm the applicable and forbidden range before a rule ships.',
      suggestedType: 'rule',
      sourceRefs: [{ kind: 'conversation', id: 'conv-drift' }],
    });
    const { asset } = await candidates.promoteRecallCandidate('u-drift', candidate.id, { actor: 'user' });
    // 人为把候选状态改回可晋升，模拟"某条晋升路径忘了落状态"。
    const stored = await store.readRecallJsonRecord('u-drift', 'candidates', candidate.id);
    await store.writeRecallJsonRecord('u-drift', 'candidates', candidate.id, {
      ...stored, status: 'pending_review', promotedAssetId: asset.id,
    });

    const graph = await tree.rebuildCognitionTree('u-drift');

    expect(graph.nodes.map((node) => node.id)).toEqual([`asset:${asset.id}`]);
  });

  /** 旧用户的 v1 树记录不能读坏，也不能因为契约升级丢掉已有资产。 */
  it('rebuilds a persisted v1 asset-only tree into v2 without losing the existing assets', async () => {
    const { tree, store } = await modules();
    const existing = await seedAsset(
      'u-v1',
      'Version persisted projections explicitly.',
      { kind: 'memory', id: 'mem-v1' },
    );
    const pending = await seedCandidate('u-v1', {
      judgment: 'Confirm the applicable and forbidden range before a rule ships.',
      suggestedType: 'rule',
      sourceRefs: [{ kind: 'conversation', id: 'conv-v1' }],
    });
    await store.writeRecallJsonRecord('u-v1', 'tree', 'graph', {
      schemaVersion: 2,
      ownerId: 'u-v1',
      id: 'graph',
      contract: 'ability_asset_relations',
      contractVersion: 1,
      nodes: [{
        id: `asset:${existing.asset.id}`,
        type: 'asset',
        assetType: 'rule',
        label: existing.asset.title,
        status: 'active',
        maturity: 'bud',
        version: existing.asset.version,
      }],
      edges: [],
      updatedAt: new Date().toISOString(),
    });

    const graph = await tree.readCognitionTree('u-v1');

    expect(graph?.contractVersion).toBe(2);
    expect(graph?.nodes.map((node) => node.id).sort()).toEqual([
      `asset:${existing.asset.id}`, `candidate:${pending.id}`,
    ].sort());
  });

  it('rejects a v2 record carrying an unknown node type', async () => {
    const { tree, store } = await modules();
    await store.writeRecallJsonRecord('u-badnode', 'tree', 'graph', {
      schemaVersion: 2,
      ownerId: 'u-badnode',
      id: 'graph',
      contract: 'ability_asset_relations',
      contractVersion: 2,
      nodes: [{ id: 'usage:u-1', type: 'usage', label: 'used once' }],
      edges: [],
      updatedAt: new Date().toISOString(),
    });

    await expect(tree.readCognitionTree('u-badnode'))
      .rejects.toThrow('malformed cognition tree asset relation contract');
  });
});
