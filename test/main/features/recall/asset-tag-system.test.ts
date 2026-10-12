/**
 * 标签系统主进程端到端（specs/012 T015，US-201 AC1~AC4）。
 *
 * 在 ability-tag.test.ts（库与写入路径的单元不变量）之上，这里钉**系统行为**：
 *  - AC1 打标 → 按标签筛出的集合正确（含库条目自动补建与派生计数）；
 *  - AC2 「未分类」批量补标后离开该集合（tags 缺失与 [] 同口径）；
 *  - AC3 重命名/合并后所有相关资产联动更新，verifyNoOrphans 通过；
 *  - AC4 删除标签时资产本体零改动（version/activeVersion/statement/status/scope）。
 *
 * 另附 IPC 接线的源码级断言（T009）：九条通道齐、批量互斥与条数闸在
 * ipc/index.ts 单点收口（通道面已由 experience-ipc.test.ts 先例覆盖协议层）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  batchAssetTags,
  listTags,
  verifyNoOrphans,
} from '../../../../src/main/features/recall/ability-tag-service';

const assetService = () => import('../../../../src/main/features/recall/asset-service');

async function activate(userId: string): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(userId);
}

function decisionIdOf(assetId: string): string {
  const stem = assetId.replace(/[^A-Za-z0-9]/g, '').padEnd(8, '0').slice(0, 40);
  return `rd_${stem}`;
}

/** 建一条 v1、无标签的种子资产（形状对齐 ability-tag.test.ts 先例）。 */
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
  }, { actor: 'user', reason: 'tag system seed' });
}

const tagKey = (name: string) => name.trim().toLocaleLowerCase();

/** 按标签名筛资产（与渲染层 matchesTagFilter 同一大口径：大小写不敏感）。
 *  listAbilityAssets 按 updatedAt 倒序，这里排序后比对（筛的是集合，不是顺序）。 */
async function assetsWithTag(userId: string, name: string) {
  const { listAbilityAssets } = await assetService();
  return (await listAbilityAssets(userId))
    .filter((asset) => (asset.tags || []).some((entry) => tagKey(entry) === tagKey(name)))
    .map((asset) => asset.id)
    .sort();
}

/** 「未分类」集合（!tags || tags.length===0，与渲染层 T012 判据一致）。 */
async function untaggedAssets(userId: string) {
  const { listAbilityAssets } = await assetService();
  return (await listAbilityAssets(userId))
    .filter((asset) => !asset.tags || asset.tags.length === 0)
    .map((asset) => asset.id)
    .sort();
}

describe('AC1/AC2：打标 → 筛选集合 / 未分类批量补标后离开', () => {
  it('打标后按标签筛出正确集合，库条目自动补建、派生计数正确', async () => {
    await activate('user-ags-ac1');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-ags-ac1', 'aa-ac1-1');
    await seedAsset('user-ags-ac1', 'aa-ac1-2');
    await seedAsset('user-ags-ac1', 'aa-ac1-3');
    await updateAbilityAsset('user-ags-ac1', 'aa-ac1-1', { tags: ['发布'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-ags-ac1', 'aa-ac1-2', { tags: ['发布', '沟通'], reason: '打标', actor: 'user' });
    // 筛选集合（渲染层按 tags 内存过滤，这里用同一判据在主进程侧验数据正确）。
    expect(await assetsWithTag('user-ags-ac1', '发布')).toEqual(['aa-ac1-1', 'aa-ac1-2']);
    expect(await assetsWithTag('user-ags-ac1', '沟通')).toEqual(['aa-ac1-2']);
    expect(await untaggedAssets('user-ags-ac1')).toEqual(['aa-ac1-3']);
    // 库条目随打标自动补建（不必先建库），派生计数 = 引用资产数。
    const tags = await listTags('user-ags-ac1');
    const byName = new Map(tags.map((tag) => [tag.name, tag]));
    expect(byName.get('发布')?.assetCount).toBe(2);
    expect(byName.get('沟通')?.assetCount).toBe(1);
    await verifyNoOrphans('user-ags-ac1').then((report) => expect(report.ok).toBe(true));
  });

  it('「未分类」批量补标后离开该集合；tags 缺失与 [] 同口径', async () => {
    await activate('user-ags-ac2');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-ags-ac2', 'aa-ac2-1'); // tags 缺失
    await seedAsset('user-ags-ac2', 'aa-ac2-2'); // tags 缺失，之后置 []
    await updateAbilityAsset('user-ags-ac2', 'aa-ac2-2', { tags: [], reason: '清空', actor: 'user' });
    // 缺失与 [] 在「未分类」口径下是同一集合。
    expect(await untaggedAssets('user-ags-ac2')).toEqual(['aa-ac2-1', 'aa-ac2-2']);
    const report = await batchAssetTags('user-ags-ac2', ['aa-ac2-1', 'aa-ac2-2'], { add: ['发布'] });
    expect(report.updated).toBe(2);
    expect(report.failed).toBe(0);
    expect(await untaggedAssets('user-ags-ac2')).toEqual([]);
    expect(await assetsWithTag('user-ags-ac2', '发布')).toEqual(['aa-ac2-1', 'aa-ac2-2']);
    // 幂等：重跑同一批不重复加（unchanged）。
    const again = await batchAssetTags('user-ags-ac2', ['aa-ac2-1', 'aa-ac2-2'], { add: ['发布'] });
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(2);
  });
});

describe('AC3：重命名/合并全联动 + 无孤儿', () => {
  it('重命名 100% 联动：所有引用资产的标签同步换名，id 不变、formerNames 追加', async () => {
    await activate('user-ags-ac3r');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-ags-ac3r', 'aa-ac3r-1');
    await seedAsset('user-ags-ac3r', 'aa-ac3r-2');
    await seedAsset('user-ags-ac3r', 'aa-ac3r-3');
    await updateAbilityAsset('user-ags-ac3r', 'aa-ac3r-1', { tags: ['发布', '沟通'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-ags-ac3r', 'aa-ac3r-2', { tags: ['发布'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-ags-ac3r', 'aa-ac3r-3', { tags: ['沟通'], reason: '打标', actor: 'user' });
    const before = await listTags('user-ags-ac3r');
    const beforeId = before.find((tag) => tag.name === '发布')?.id;

    const { renameTag } = await import('../../../../src/main/features/recall/ability-tag-service');
    const { tag, report } = await renameTag('user-ags-ac3r', String(beforeId), '发版');
    expect(tag.id).toBe(beforeId); // 重命名不变 id
    expect(tag.formerNames).toContain('发布');
    expect(report.updated).toBe(2);
    // 联动：引用「发布」的两条全部换名，沟通不动。
    expect(await assetsWithTag('user-ags-ac3r', '发版')).toEqual(['aa-ac3r-1', 'aa-ac3r-2']);
    expect(await assetsWithTag('user-ags-ac3r', '发布')).toEqual([]);
    expect(await assetsWithTag('user-ags-ac3r', '沟通')).toEqual(['aa-ac3r-1', 'aa-ac3r-3']);
    const orphan = await verifyNoOrphans('user-ags-ac3r');
    expect(orphan.ok).toBe(true);
  });

  it('合并后源名零引用：源条目保留为 merged、源名进 aliases、verifyNoOrphans 通过', async () => {
    await activate('user-ags-ac3m');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-ags-ac3m', 'aa-ac3m-1');
    await seedAsset('user-ags-ac3m', 'aa-ac3m-2');
    await updateAbilityAsset('user-ags-ac3m', 'aa-ac3m-1', { tags: ['发布', '沟通'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-ags-ac3m', 'aa-ac3m-2', { tags: ['发布'], reason: '打标', actor: 'user' });
    const before = await listTags('user-ags-ac3m');
    const sourceId = before.find((tag) => tag.name === '沟通')?.id;
    const targetId = before.find((tag) => tag.name === '发布')?.id;

    const { mergeTag } = await import('../../../../src/main/features/recall/ability-tag-service');
    const { tag, mergedFrom, report } = await mergeTag('user-ags-ac3m', String(sourceId), String(targetId));
    expect(mergedFrom.state).toBe('merged'); // 源条目保留（供"旧标去哪了"追问）
    expect(tag.aliases).toContain('沟通');
    expect(report.updated).toBe(1); // 只有 aa-ac3m-1 引用了沟通
    // 合并后：目标集合吸收源集合，源名零引用。
    expect(await assetsWithTag('user-ags-ac3m', '发布')).toEqual(['aa-ac3m-1', 'aa-ac3m-2']);
    expect(await assetsWithTag('user-ags-ac3m', '沟通')).toEqual([]);
    const orphan = await verifyNoOrphans('user-ags-ac3m');
    expect(orphan.ok).toBe(true);
  });
});

describe('AC4：删除标签时资产本体零改动', () => {
  it('deleteTag 只摘除标签；version/activeVersion/statement/status/scope 全部不变', async () => {
    await activate('user-ags-ac4');
    const { updateAbilityAsset, readAbilityAsset } = await assetService();
    await seedAsset('user-ags-ac4', 'aa-ac4-1');
    // 先做一次内容更新，让 version/activeVersion 有非平凡值可比对。
    await updateAbilityAsset('user-ags-ac4', 'aa-ac4-1', { statement: '更新后的正文。', reason: '改正文', actor: 'user' });
    await updateAbilityAsset('user-ags-ac4', 'aa-ac4-1', { tags: ['发布', '沟通'], reason: '打标', actor: 'user' });
    const before = await readAbilityAsset('user-ags-ac4', 'aa-ac4-1');
    const tags = await listTags('user-ags-ac4');
    const tagId = tags.find((tag) => tag.name === '发布')?.id;

    const { deleteTag } = await import('../../../../src/main/features/recall/ability-tag-service');
    const { report } = await deleteTag('user-ags-ac4', String(tagId));
    expect(report.updated).toBe(1);
    const after = await readAbilityAsset('user-ags-ac4', 'aa-ac4-1');
    // 本体五项逐字段不变（US-201 AC4 原文口径）。
    expect(after.version).toBe(before.version);
    expect(after.activeVersion).toBe(before.activeVersion);
    expect(after.statement).toBe(before.statement);
    expect(after.status).toBe(before.status);
    expect(after.scope).toBe(before.scope);
    // 只有标签被摘除。
    expect(after.tags).toEqual(['沟通']);
    const orphan = await verifyNoOrphans('user-ags-ac4');
    expect(orphan.ok).toBe(true);
  });

  it('清空（[]）回到「未分类」；库条目计数随之归零', async () => {
    await activate('user-ags-ac4b');
    const { updateAbilityAsset } = await assetService();
    await seedAsset('user-ags-ac4b', 'aa-ac4b-1');
    await updateAbilityAsset('user-ags-ac4b', 'aa-ac4b-1', { tags: ['独标'], reason: '打标', actor: 'user' });
    await updateAbilityAsset('user-ags-ac4b', 'aa-ac4b-1', { tags: [], reason: '清空', actor: 'user' });
    expect(await untaggedAssets('user-ags-ac4b')).toEqual(['aa-ac4b-1']);
    const tags = await listTags('user-ags-ac4b');
    expect(tags.find((tag) => tag.name === '独标')?.assetCount).toBe(0);
  });
});

describe('T009：IPC 通道接线（源码级，ipc/index.ts 单点收口）', () => {
  const ipcSource = fs.readFileSync(
    path.join(__dirname, '../../../../src/main/ipc/index.ts'),
    'utf8',
  );

  it('九条标签通道齐：recall.tags.* 六条 + recall.assets.tags.* 两条 + 只读 ranking', () => {
    for (const channel of [
      "'recall.tags.list'",
      "'recall.tags.create'",
      "'recall.tags.rename'",
      "'recall.tags.merge'",
      "'recall.tags.delete'",
      "'recall.tags.suggestions'",
      "'recall.assets.tags.set'",
      "'recall.assets.tags.batch'",
      "'recall.catalog.ranking'",
    ]) {
      expect(ipcSource).toContain(channel);
    }
  });

  it('批量三语义互斥与条数闸在 IPC 层先挡（非法入参 throw invalid …）', () => {
    expect(ipcSource).toContain('replace cannot combine with add/remove');
    expect(ipcSource).toContain('requires at least one action');
    expect(ipcSource).toContain('ABILITY_TAG_BATCH_MAX_ASSETS');
  });

  it('recall.assets.update 已透传 tags，且省略 ≠ 清空（形状闸 + 服务层规范化）', () => {
    expect(ipcSource).toContain('invalid recall asset tags');
    expect(ipcSource).toContain('...(tags !== undefined ? { tags } : {})');
  });
});
