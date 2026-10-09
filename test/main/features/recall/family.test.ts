import { describe, expect, it } from 'vitest';
import {
  buildSameFamilyPatches,
  collectStaticFamilyGroups,
  computeStaticFamilyKey,
} from '../../../../src/main/features/recall/family';

// 判族引擎（纯逻辑层）：静态族键（本体组 > KStar 轮次）+ 分组 + 关系补丁幂等。

const baseAsset = {
  id: 'aa-x',
  ontologyRefs: undefined,
  learningProvenance: undefined,
};

describe('computeStaticFamilyKey', () => {
  it('ontology group wins over episode provenance', () => {
    const key = computeStaticFamilyKey({
      ...baseAsset,
      ontologyRefs: [{ groupId: 'grp-about-me' }],
      learningProvenance: { episodeId: 'ep-1' } as never,
    });
    expect(key).toBe('group:grp-about-me');
  });

  it('falls back to the kstar episode id', () => {
    const key = computeStaticFamilyKey({
      ...baseAsset,
      learningProvenance: { episodeId: 'ep-42' } as never,
    });
    expect(key).toBe('episode:ep-42');
  });

  it('returns null when neither signal exists', () => {
    expect(computeStaticFamilyKey(baseAsset)).toBeNull();
  });
});

describe('collectStaticFamilyGroups', () => {
  it('groups by key and drops singleton groups', () => {
    const groups = collectStaticFamilyGroups([
      { ...baseAsset, id: 'aa-a', ontologyRefs: [{ groupId: 'grp-me' }] },
      { ...baseAsset, id: 'aa-b', ontologyRefs: [{ groupId: 'grp-me' }] },
      { ...baseAsset, id: 'aa-c', ontologyRefs: [{ groupId: 'grp-lonely' }] },
      { ...baseAsset, id: 'aa-d', learningProvenance: { episodeId: 'ep-9' } as never },
      { ...baseAsset, id: 'aa-e', learningProvenance: { episodeId: 'ep-9' } as never },
      { ...baseAsset, id: 'aa-f' },
    ]);
    expect([...groups.keys()].sort()).toEqual(['episode:ep-9', 'group:grp-me']);
    expect([...groups.get('group:grp-me')!].sort()).toEqual(['aa-a', 'aa-b']);
    expect([...groups.get('episode:ep-9')!].sort()).toEqual(['aa-d', 'aa-e']);
  });
});

describe('buildSameFamilyPatches', () => {
  it('creates mutual same_family relations and is idempotent against existing ones', () => {
    const groups = new Map([['group:grp-me', ['aa-a', 'aa-b']]]);
    const existing = new Map([
      ['aa-a', [{ kind: 'same_family' as const, assetId: 'aa-b' }]],
      ['aa-b', []],
    ]);
    const patches = buildSameFamilyPatches(groups, existing);
    // aa-a 已有关系 → 不再生成；aa-b 缺 → 补一条指向 aa-a。
    expect(patches).toEqual([
      { assetId: 'aa-b', addRelations: [{ kind: 'same_family', assetId: 'aa-a' }] },
    ]);
  });

  it('never relates an asset to itself and de-duplicates repeated members', () => {
    const groups = new Map([['group:grp-me', ['aa-a', 'aa-a', 'aa-b']]]);
    const patches = buildSameFamilyPatches(groups, new Map());
    const forA = patches.find((patch) => patch.assetId === 'aa-a');
    const forB = patches.find((patch) => patch.assetId === 'aa-b');
    expect(forA?.addRelations).toEqual([{ kind: 'same_family', assetId: 'aa-b' }]);
    expect(forA?.addRelations.every((rel) => rel.assetId !== 'aa-a')).toBe(true);
    expect(forB?.addRelations).toEqual([{ kind: 'same_family', assetId: 'aa-a' }]);
  });

describe('collectSemanticFamilyGroups', () => {
  const mk = (id: string, statement: string) => ({
    id, statement, title: '', updatedAt: '2026-09-19T00:00:00Z',
    ontologyRefs: undefined, learningProvenance: undefined,
  });

  it('clusters semantically close orphans and skips statically keyed assets', async () => {
    const family = await import('../../../../src/main/features/recall/family');
    // 注入向量：a 与 b 相似（cos=0.96），c 无关。
    const { _injectEmbeddingForTest, clearEmbedCacheForTest } = await import('../../../../src/main/features/recall/similarity');
    clearEmbedCacheForTest();
    _injectEmbeddingForTest('user-fam-sem', '周报三个固定板块。', [1, 0]);
    _injectEmbeddingForTest('user-fam-sem', '周报固定三个板块：进展、风险、计划。', [0.96, 0.28]);
    _injectEmbeddingForTest('user-fam-sem', '数据库迁移前必须备份。', [0, 1]);
    const groups = await family.collectSemanticFamilyGroups('user-fam-sem', [
      { ...mk('aa-a', '周报三个固定板块。') },
      { ...mk('aa-b', '周报固定三个板块：进展、风险、计划。') },
      { ...mk('aa-c', '数据库迁移前必须备份。') },
      { ...mk('aa-keyed', '周报再提一句。'), ontologyRefs: [{ groupId: 'grp-me' }] },
    ]);
    expect(groups.size).toBe(1);
    const key = [...groups.keys()][0];
    expect(key.startsWith('sem:')).toBe(true);
    expect([...groups.get(key)!].sort()).toEqual(['aa-a', 'aa-b']);
  });

  it('returns empty silently when embedding is unavailable', async () => {
    const family = await import('../../../../src/main/features/recall/family');
    const groups = await family.collectSemanticFamilyGroups('user-fam-none', [
      mk('aa-x', '一句话。'), mk('aa-y', '另一句话。'),
    ], { embedForDedup: async () => null });
    expect(groups.size).toBe(0);
  });
});


describe('renameAssetFamily', () => {
  it('renames every same_family member and empty name clears it', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-family-rename');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const family = await import('../../../../src/main/features/recall/family');
    const now = new Date().toISOString();
    const mk = async (id: string) => assets.createAbilityAsset('user-family-rename', {
      schemaVersion: 2, ownerId: 'user-family-rename', id, candidateId: `cand-${id}`,
      sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_familyren${id.slice(-8)}`.padEnd(16, 'x'),
      type: 'personal', title: `条目${id.slice(-2)}`, statement: `同族内容 ${id}。`,
      evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
      lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      relations: [{ kind: 'same_family', assetId: id === 'aa-fr-1' ? 'aa-fr-2' : 'aa-fr-1' }],
      createdAt: now, updatedAt: now,
    }, { actor: 'user', reason: 'family rename seed' });
    await mk('aa-fr-1');
    await mk('aa-fr-2');

    const updated = await family.renameAssetFamily('user-family-rename', 'aa-fr-1', '沟通偏好');
    expect(updated.sort()).toEqual(['aa-fr-1', 'aa-fr-2']);
    const after = await assets.readAbilityAsset('user-family-rename', 'aa-fr-2');
    expect(after.familyName).toBe('沟通偏好');

    // 清空恢复默认
    await family.renameAssetFamily('user-family-rename', 'aa-fr-2', '');
    const cleared = await assets.readAbilityAsset('user-family-rename', 'aa-fr-1');
    expect(cleared.familyName || '').toBe('');
  });

  it('rejects a lone asset that has no family', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-family-lone');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const family = await import('../../../../src/main/features/recall/family');
    const now = new Date().toISOString();
    await assets.createAbilityAsset('user-family-lone', {
      schemaVersion: 2, ownerId: 'user-family-lone', id: 'aa-lone-1', candidateId: 'cand-lone',
      sourceCandidateIds: ['cand-lone'], reviewDecisionId: 'rd_familylone00000',
      type: 'personal', title: '孤条', statement: '无族内容。',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-lone' }], scope: 'general', status: 'active',
      lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
      createdAt: now, updatedAt: now,
    }, { actor: 'user', reason: 'lone seed' });
    await expect(family.renameAssetFamily('user-family-lone', 'aa-lone-1', 'x'))
      .rejects.toThrow('does not belong to a family');
  });
});

});
