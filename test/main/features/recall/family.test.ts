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
});
