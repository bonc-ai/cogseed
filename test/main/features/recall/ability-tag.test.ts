import { describe, expect, it } from 'vitest';

import {
  ABILITY_ASSET_TAGS_MAX,
  ABILITY_TAG_BATCH_MAX_ASSETS,
  ABILITY_TAG_NAME_MAX_LENGTH,
  batchAssetTags,
  createTag,
  deleteTag,
  ensureAbilityTags,
  listTags,
  mergeTag,
  normalizeAbilityTagList,
  renameTag,
  setAssetTags,
  suggestMerges,
  verifyNoOrphans,
} from '../../../../src/main/features/recall/ability-tag-service';

// 标签库 + 资产标签写入路径的不变量用例（specs/012 T004/T005；tasks.md
// 「不变量」§I 与 data-model §9 逐条对应）。排序（T006）与权重（T007）的用例
// Phase 1 曾暂挂在本文件，T021 落地时已平移到 asset-ranking.test.ts（专属文件）。

const assetService = () => import('../../../../src/main/features/recall/asset-service');
const store = () => import('../../../../src/main/features/recall/store');

async function activate(userId: string): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(userId);
}

function decisionIdOf(assetId: string): string {
  const stem = assetId.replace(/[^A-Za-z0-9]/g, '').padEnd(8, '0').slice(0, 40);
  return `rd_${stem}`;
}

/** 建一条 v1、无标签的种子资产（形状对齐 family.test.ts 的先例）。 */
async function seedAsset(userId: string, assetId: string, title = `条目${assetId}`): Promise<void> {
  const { createAbilityAsset } = await assetService();
  const now = new Date().toISOString();
  await createAbilityAsset(userId, {
    schemaVersion: 2,
    ownerId: userId,
    id: assetId,
    candidateId: `cand-${assetId}`,
    sourceCandidateIds: [`cand-${assetId}`],
    reviewDecisionId: decisionIdOf(assetId),
    type: 'personal',
    title,
    statement: `内容 ${assetId}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${assetId}` }],
    scope: 'general',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'bud',
    version: '1',
    createdAt: now,
    updatedAt: now,
  }, { actor: 'user', reason: 'tag test seed' });
}

describe('normalizeAbilityTagList（规范化唯一处）', () => {
  it('trim + 大小写不敏感去重，保留首次出现的原样', () => {
    expect(normalizeAbilityTagList([' 发布流程 ', '发布流程', '发布流程'.toUpperCase(), '对外沟通']))
      .toEqual(['发布流程', '对外沟通']);
  });

  it('单一字符串与非数组拒绝（不自动包成数组）', () => {
    expect(() => normalizeAbilityTagList('发布流程' as unknown as string[])).toThrow('invalid ability asset tags');
    expect(() => normalizeAbilityTagList([1, 2] as unknown as string[])).toThrow('invalid ability asset tags');
  });

  it('空串/纯空白条目拒绝，不静默丢弃', () => {
    expect(() => normalizeAbilityTagList(['  '])).toThrow('invalid ability asset tags entry');
    expect(() => normalizeAbilityTagList([''])).toThrow('invalid ability asset tags entry');
  });

  it(`单条超 ${ABILITY_TAG_NAME_MAX_LENGTH} 字拒绝不截断`, () => {
    expect(() => normalizeAbilityTagList(['标'.repeat(ABILITY_TAG_NAME_MAX_LENGTH + 1)]))
      .toThrow(`exceeds ${ABILITY_TAG_NAME_MAX_LENGTH} chars`);
  });

  it(`超 ${ABILITY_ASSET_TAGS_MAX} 条拒绝不截断（去重后才计）`, () => {
    const thirteen = Array.from({ length: ABILITY_ASSET_TAGS_MAX + 1 }, (_, index) => `标签${index}`);
    expect(() => normalizeAbilityTagList(thirteen)).toThrow(`exceeds ${ABILITY_ASSET_TAGS_MAX} entries`);
    // 原始 13 条但去重后 ≤12：合法（口径 = 去重后 ≤12）。
    expect(normalizeAbilityTagList([...thirteen.slice(0, ABILITY_ASSET_TAGS_MAX), `标签0`]))
      .toHaveLength(ABILITY_ASSET_TAGS_MAX);
  });
});

describe('标签库：创建/唯一性/派生计数（T003）', () => {
  it('同名（大小写不敏感）创建返回既有条目，不建重复', async () => {
    await activate('user-tag-create');
    const first = await createTag('user-tag-create', 'Release');
    expect(first.created).toBe(true);
    const again = await createTag('user-tag-create', ' release ');
    expect(again.created).toBe(false);
    expect(again.tag.id).toBe(first.tag.id);
    expect(again.tag.name).toBe('Release');
    const list = await listTags('user-tag-create');
    expect(list.filter((tag) => tag.name.toLocaleLowerCase() === 'release')).toHaveLength(1);
  });

  it('usageCount/assetCount/lastUsedAt 读时派生：打标即计数，删除库条目零资产改动', async () => {
    await activate('user-tag-derive');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-tag-derive', 'aa-derive-1');
    await seedAsset('user-tag-derive', 'aa-derive-2');
    await updateAbilityAsset('user-tag-derive', 'aa-derive-1', { tags: ['发布流程'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-tag-derive', 'aa-derive-2', { tags: ['发布流程', '对外沟通'], reason: '打标', actor: 'user' });
    const tags = await listTags('user-tag-derive');
    const byName = new Map(tags.map((tag) => [tag.name, tag]));
    expect(byName.get('发布流程')?.assetCount).toBe(2);
    expect(byName.get('对外沟通')?.assetCount).toBe(1);
    expect(byName.get('发布流程')?.lastUsedAt).toBeTruthy();
  });

  it('listTags 常用置顶口径：assetCount DESC → lastUsedAt DESC → name 字典序', async () => {
    await activate('user-tag-order');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-tag-order', 'aa-ord-1');
    await seedAsset('user-tag-order', 'aa-ord-2');
    await updateAbilityAsset('user-tag-order', 'aa-ord-1', { tags: ['甲甲', '乙乙'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-tag-order', 'aa-ord-2', { tags: ['甲甲'], reason: '打标', actor: 'user' });
    const list = await listTags('user-tag-order');
    expect(list.map((tag) => tag.name)).toEqual(['甲甲', '乙乙']);
  });

  it('listTags 零写入正文：纯读不产生库条目', async () => {
    await activate('user-tag-readonly');
    await seedAsset('user-tag-readonly', 'aa-ro-1');
    const before = await listTags('user-tag-readonly');
    expect(before).toEqual([]);
    const { readAbilityAsset } = await assetService();
    const asset = await readAbilityAsset('user-tag-readonly', 'aa-ro-1');
    expect(asset.tags).toBeUndefined();
  });

  it('ensureAbilityTags 补建缺失条目；打标路径自动补建（createdFrom=ai 走模型来源）', async () => {
    await activate('user-tag-ensure');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-tag-ensure', 'aa-ens-1');
    const created = await ensureAbilityTags('user-tag-ensure', ['新标']);
    expect(created).toHaveLength(1);
    await updateAbilityAsset('user-tag-ensure', 'aa-ens-1', { tags: ['新标', '模型标'], reason: '打标', actor: 'ai' });
    const list = await listTags('user-tag-ensure');
    expect(new Set(list.map((tag) => [tag.name, tag.createdFrom] as const))).toEqual(new Set([
      ['新标', 'user'],
      ['模型标', 'ai'],
    ]));
  });
});

describe('资产标签写入路径（T004）', () => {
  it('标签改动不 bump 版本：version/activeVersion 前后不变、版本流不增、version-diff 无标签项', async () => {
    await activate('user-tag-nobump');
    const { updateAbilityAsset, readAbilityAsset, listAbilityAssetVersions } = await assetService();
    const { buildAssetVersionDiffs } = await import('../../../../src/main/features/recall/formal-assets/version-diff');
    await seedAsset('user-tag-nobump', 'aa-nb-1');
    await updateAbilityAsset('user-tag-nobump', 'aa-nb-1', { tags: ['发布流程'], reason: '打标', actor: 'user' });
    let asset = await readAbilityAsset('user-tag-nobump', 'aa-nb-1');
    expect(asset.tags).toEqual(['发布流程']);
    expect(asset.version).toBe('1');
    expect(asset.activeVersion).toBeUndefined();
    // 再改一次标签 + 一次正文更新之后，版本流仍然只记内容那次。
    await updateAbilityAsset('user-tag-nobump', 'aa-nb-1', { tags: ['发布流程', '对外沟通'], reason: '补标', actor: 'user' });
    await updateAbilityAsset('user-tag-nobump', 'aa-nb-1', { statement: '改后的正文。', reason: '改正文', actor: 'user' });
    await updateAbilityAsset('user-tag-nobump', 'aa-nb-1', { tags: ['对外沟通'], reason: '去标', actor: 'user' });
    asset = await readAbilityAsset('user-tag-nobump', 'aa-nb-1');
    expect(asset.version).toBe('2');
    expect(asset.activeVersion).toBe('2');
    const versions = await listAbilityAssetVersions('user-tag-nobump', 'aa-nb-1');
    expect(versions).toHaveLength(2);
    const diffs = buildAssetVersionDiffs('user-tag-nobump', versions);
    expect(diffs.length).toBeGreaterThan(0);
    for (const diff of diffs) {
      expect(diff.changes.every((change) => change.field !== 'tags')).toBe(true);
    }
    // 版本快照本身不含 tags（元数据不进版本链）。
    expect(versions.every((version) => !('tags' in version.snapshot))).toBe(true);
  });

  it('台账 reason 含「标签：旧 → 新」', async () => {
    await activate('user-tag-audit');
    const { updateAbilityAsset, listAbilityAssetAudit } = await assetService();
    await seedAsset('user-tag-audit', 'aa-au-1');
    await updateAbilityAsset('user-tag-audit', 'aa-au-1', { tags: ['甲'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-tag-audit', 'aa-au-1', { tags: ['乙'], reason: '换标', actor: 'user' });
    const audits = await listAbilityAssetAudit('user-tag-audit', 'aa-au-1');
    const tagAudits = audits.filter((record) => record.reason?.includes('标签：'));
    expect(tagAudits.length).toBeGreaterThanOrEqual(2);
    expect(tagAudits.some((record) => record.reason?.includes('标签：（无） → 甲'))).toBe(true);
    expect(tagAudits.some((record) => record.reason?.includes('标签：甲 → 乙'))).toBe(true);
  });

  it('tags 缺失 = 不改标签（省略≠清空）；显式 [] = 清空（盘上键缺席）', async () => {
    await activate('user-tag-omit');
    const { updateAbilityAsset, readAbilityAsset } = await assetService();
    await seedAsset('user-tag-omit', 'aa-om-1');
    await updateAbilityAsset('user-tag-omit', 'aa-om-1', { tags: ['甲'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-tag-omit', 'aa-om-1', { reason: '只动原因', actor: 'user' });
    let asset = await readAbilityAsset('user-tag-omit', 'aa-om-1');
    expect(asset.tags).toEqual(['甲']);
    await updateAbilityAsset('user-tag-omit', 'aa-om-1', { tags: [], reason: '清空', actor: 'user' });
    asset = await readAbilityAsset('user-tag-omit', 'aa-om-1');
    expect(asset.tags).toBeUndefined();
  });

  it('超限拒绝不截断：13 条 / 21 字 / 单一字符串', async () => {
    await activate('user-tag-limit');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-tag-limit', 'aa-lim-1');
    const thirteen = Array.from({ length: 13 }, (_, index) => `标签${index}`);
    await expect(updateAbilityAsset('user-tag-limit', 'aa-lim-1', { tags: thirteen, reason: '超限', actor: 'user' }))
      .rejects.toThrow(`exceeds ${ABILITY_ASSET_TAGS_MAX} entries`);
    await expect(updateAbilityAsset('user-tag-limit', 'aa-lim-1', { tags: ['标'.repeat(21)], reason: '超长', actor: 'user' }))
      .rejects.toThrow(`exceeds ${ABILITY_TAG_NAME_MAX_LENGTH} chars`);
    await expect(updateAbilityAsset('user-tag-limit', 'aa-lim-1', { tags: '甲' as unknown as string[], reason: '错形状', actor: 'user' }))
      .rejects.toThrow('invalid ability asset tags');
  });

  it('formal-assets 白名单透传：listFormalAssets 带出 tags、缺省不伪造空数组', async () => {
    await activate('user-tag-formal');
    const { updateAbilityAsset } = await assetService();
    const { listFormalAssets } = await import('../../../../src/main/features/recall/formal-assets/repository');
    await seedAsset('user-tag-formal', 'aa-fm-1');
    await seedAsset('user-tag-formal', 'aa-fm-2');
    await updateAbilityAsset('user-tag-formal', 'aa-fm-1', { tags: ['发布流程'], reason: '打标', actor: 'user' });
    const formal = await listFormalAssets('user-tag-formal');
    const byId = new Map(formal.map((asset) => [asset.assetId, asset]));
    expect(byId.get('aa-fm-1')?.tags).toEqual(['发布流程']);
    expect(byId.get('aa-fm-2')?.tags).toBeUndefined();
    expect('tags' in (byId.get('aa-fm-2') || {})).toBe(false);
  });
});

describe('标签管理三动作：重命名 / 合并 / 删除（T003/T005）', () => {
  async function seedThree(userId: string): Promise<void> {
    await seedAsset(userId, 'aa-mg-1');
    await seedAsset(userId, 'aa-mg-2');
    await seedAsset(userId, 'aa-mg-3');
    const { updateAbilityAsset } = await assetService();
    await updateAbilityAsset(userId, 'aa-mg-1', { tags: ['发布流程'], reason: '打标', actor: 'user' });
    await updateAbilityAsset(userId, 'aa-mg-2', { tags: ['发布流程', '对外沟通'], reason: '打标', actor: 'user' });
  }

  it('重命名 100% 联动：资产全部改写、formerNames 追加、id 不变、无孤儿', async () => {
    await activate('user-tag-rename');
    await seedThree('user-tag-rename');
    const { readAbilityAsset } = await assetService();
    const before = (await listTags('user-tag-rename')).find((tag) => tag.name === '发布流程')!;
    const { tag, report } = await renameTag('user-tag-rename', before.id, '发版流程');
    expect(tag.id).toBe(before.id);
    expect(tag.formerNames).toContain('发布流程');
    expect(report.updated).toBe(2);
    expect((await readAbilityAsset('user-tag-rename', 'aa-mg-1')).tags).toEqual(['发版流程']);
    expect((await readAbilityAsset('user-tag-rename', 'aa-mg-2')).tags).toEqual(['发版流程', '对外沟通']);
    expect((await readAbilityAsset('user-tag-rename', 'aa-mg-3')).tags).toBeUndefined();
    expect((await verifyNoOrphans('user-tag-rename')).ok).toBe(true);
    // 联动也不 bump 版本（资产本体只有标签变了）。
    expect((await readAbilityAsset('user-tag-rename', 'aa-mg-1')).version).toBe('1');
  });

  it('重命名到其它 active 占用的名字被拒（该用合并）', async () => {
    await activate('user-tag-rename-clash');
    await seedThree('user-tag-rename-clash');
    const tags = await listTags('user-tag-rename-clash');
    const source = tags.find((tag) => tag.name === '发布流程')!;
    await expect(renameTag('user-tag-rename-clash', source.id, '对外沟通'))
      .rejects.toThrow('already in use by another active tag');
  });

  it('合并：源条目保留为 merged、源名进目标 aliases、零资产引用源名', async () => {
    await activate('user-tag-merge');
    await seedAsset('user-tag-merge', 'aa-mr-1');
    await seedAsset('user-tag-merge', 'aa-mr-2');
    const { updateAbilityAsset, readAbilityAsset } = await assetService();
    await updateAbilityAsset('user-tag-merge', 'aa-mr-1', { tags: ['发版', '发布'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-tag-merge', 'aa-mr-2', { tags: ['发布'], reason: '打标', actor: 'user' });
    const tags = await listTags('user-tag-merge');
    const source = tags.find((tag) => tag.name === '发版')!;
    const target = tags.find((tag) => tag.name === '发布')!;
    const result = await mergeTag('user-tag-merge', source.id, target.id);
    expect(result.mergedFrom.state).toBe('merged');
    expect(result.tag.aliases).toContain('发版');
    expect((await readAbilityAsset('user-tag-merge', 'aa-mr-1')).tags).toEqual(['发布']);
    expect((await readAbilityAsset('user-tag-merge', 'aa-mr-2')).tags).toEqual(['发布']);
    const all = await listTags('user-tag-merge', { includeRetired: true });
    expect(all.find((tag) => tag.name === '发版')?.state).toBe('merged');
    expect((await listTags('user-tag-merge')).some((tag) => tag.name === '发版')).toBe(false);
    expect((await verifyNoOrphans('user-tag-merge')).ok).toBe(true);
    await expect(mergeTag('user-tag-merge', source.id, source.id)).rejects.toThrow('distinct');
  });

  it('删除只摘除标签：资产本体（version/statement/status/scope）零改动', async () => {
    await activate('user-tag-delete');
    await seedAsset('user-tag-delete', 'aa-dl-1');
    const { updateAbilityAsset, readAbilityAsset } = await assetService();
    await updateAbilityAsset('user-tag-delete', 'aa-dl-1', { tags: ['临时标'], reason: '打标', actor: 'user' });
    const before = await readAbilityAsset('user-tag-delete', 'aa-dl-1');
    const tag = (await listTags('user-tag-delete')).find((entry) => entry.name === '临时标')!;
    const { tag: deleted } = await deleteTag('user-tag-delete', tag.id);
    expect(deleted.state).toBe('archived');
    const after = await readAbilityAsset('user-tag-delete', 'aa-dl-1');
    expect(after.tags).toBeUndefined();
    expect(after.version).toBe(before.version);
    expect(after.activeVersion).toBe(before.activeVersion);
    expect(after.statement).toBe(before.statement);
    expect(after.status).toBe(before.status);
    expect(after.scope).toBe(before.scope);
    expect((await verifyNoOrphans('user-tag-delete')).ok).toBe(true);
    // 归档条目不硬删：includeRetired 里还在。
    expect((await listTags('user-tag-delete', { includeRetired: true })).some((entry) => entry.name === '临时标')).toBe(true);
  });

  it('verifyNoOrphans 如实报警：库条目被外部改坏 → 孤儿与重名都被点名', async () => {
    await activate('user-tag-orphan');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-tag-orphan', 'aa-or-1');
    await updateAbilityAsset('user-tag-orphan', 'aa-or-1', { tags: ['孤标'], reason: '打标', actor: 'user' });
    // 外部改坏：把库条目归档，资产引用即成孤儿。
    const tag = (await listTags('user-tag-orphan')).find((entry) => entry.name === '孤标')!;
    const { updateRecallJsonRecord } = await store();
    await updateRecallJsonRecord('user-tag-orphan', 'ability-tags', tag.id, (current) => ({
      ...(current || {}),
      state: 'archived',
    } as never));
    const report = await verifyNoOrphans('user-tag-orphan');
    expect(report.ok).toBe(false);
    expect(report.orphans).toEqual([{ name: '孤标', assetIds: ['aa-or-1'] }]);
  });
});

describe('批量打标（T003）', () => {
  it('三种语义不混：replace 与 add/remove 同给被拒；至少给一个动作', async () => {
    await activate('user-tag-batch');
    await seedAsset('user-tag-batch', 'aa-bt-1');
    await expect(batchAssetTags('user-tag-batch', ['aa-bt-1'], { replace: ['甲'], add: ['乙'] })).rejects.toThrow('cannot combine');
    await expect(batchAssetTags('user-tag-batch', ['aa-bt-1'], {})).rejects.toThrow('at least one action');
  });

  it('add/remove/replace 语义正确且幂等；超 12 条的资产记 failed 不截断', async () => {
    await activate('user-tag-batch2');
    const { updateAbilityAsset, readAbilityAsset } = await assetService();
    await seedAsset('user-tag-batch2', 'aa-bt-2');
    await seedAsset('user-tag-batch2', 'aa-bt-3');
    await updateAbilityAsset('user-tag-batch2', 'aa-bt-2', { tags: ['甲', '乙'], reason: '打标', actor: 'user' });
    let report = await batchAssetTags('user-tag-batch2', ['aa-bt-2', 'aa-bt-3'], { add: ['甲', '丙'] });
    expect(report.updated).toBe(2);
    expect((await readAbilityAsset('user-tag-batch2', 'aa-bt-2')).tags).toEqual(['甲', '乙', '丙']);
    expect((await readAbilityAsset('user-tag-batch2', 'aa-bt-3')).tags).toEqual(['甲', '丙']);
    // 幂等：重复 add 落 unchanged，不产生第二条台账级写入。
    report = await batchAssetTags('user-tag-batch2', ['aa-bt-2'], { add: ['甲'] });
    expect(report.updated).toBe(0);
    expect(report.unchanged).toBe(1);
    report = await batchAssetTags('user-tag-batch2', ['aa-bt-2'], { remove: ['乙'] });
    expect((await readAbilityAsset('user-tag-batch2', 'aa-bt-2')).tags).toEqual(['甲', '丙']);
    report = await batchAssetTags('user-tag-batch2', ['aa-bt-2', 'aa-bt-3'], { replace: ['只留这个'] });
    expect((await readAbilityAsset('user-tag-batch2', 'aa-bt-2')).tags).toEqual(['只留这个']);
    // 超限：11 条存量 + add 2 条 → 该资产 failed，另一个成功，存量不动。
    await updateAbilityAsset('user-tag-batch2', 'aa-bt-2', { tags: Array.from({ length: 11 }, (_, index) => `标${index}`), reason: '铺满', actor: 'user' });
    report = await batchAssetTags('user-tag-batch2', ['aa-bt-2', 'aa-bt-3'], { add: ['新甲', '新乙'] });
    expect(report.items.find((item) => item.assetId === 'aa-bt-2')?.status).toBe('failed');
    expect(report.items.find((item) => item.assetId === 'aa-bt-3')?.status).toBe('updated');
    expect((await readAbilityAsset('user-tag-batch2', 'aa-bt-2')).tags).toHaveLength(11);
    expect((await verifyNoOrphans('user-tag-batch2')).ok).toBe(true);
  });

  it(`批量超过 ${ABILITY_TAG_BATCH_MAX_ASSETS} 条资产被拒（提示分批）`, async () => {
    await activate('user-tag-batch3');
    const ids = Array.from({ length: ABILITY_TAG_BATCH_MAX_ASSETS + 1 }, (_, index) => `aa-fake-${index}`);
    await expect(batchAssetTags('user-tag-batch3', ids, { add: ['甲'] }))
      .rejects.toThrow(`exceeds ${ABILITY_TAG_BATCH_MAX_ASSETS} assets`);
  });
});

describe('同义合并建议（T003：只建议不合并）', () => {
  it('aliases 命中与名字相似都给建议；合并后的停用源不参与', async () => {
    await activate('user-tag-suggest');
    const { writeRecallJsonRecord } = await store();
    await createTag('user-tag-suggest', '发布流程');
    await createTag('user-tag-suggest', '发版流程');
    // 手工挂一条带 aliases 的条目（正式入口是合并写入 aliases）。
    await writeRecallJsonRecord('user-tag-suggest', 'ability-tags', 'tg-testalias001', {
      schemaVersion: 1,
      ownerId: 'user-tag-suggest',
      id: 'tg-testalias001',
      name: '上线',
      state: 'active',
      aliases: ['发版流程'],
      createdFrom: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    const suggestions = await suggestMerges('user-tag-suggest');
    expect(suggestions.some((s) => s.sourceName === '上线' && s.targetName === '发版流程' && s.reason === 'alias')).toBe(true);
    expect(suggestions.some((s) => s.reason === 'similar' && [s.sourceName, s.targetName].sort().join('/') === '发布流程/发版流程')).toBe(true);
    // 只读：建议不改动任何条目。
    expect((await listTags('user-tag-suggest')).some((tag) => tag.name === '发布流程')).toBe(true);
  });
});
