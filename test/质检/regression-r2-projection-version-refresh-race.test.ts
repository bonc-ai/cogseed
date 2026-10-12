/**
 * 红队探针 r2：committed 投影版本刷新的乱序回退竞态（并发与时序面）。
 *
 * 靶点（读码推演）：
 * - updateAbilityAsset 改标题 bump 版本后异步刷新 committed 投影的
 *   assetVersions（asset-service.ts:871-876），注释自认「资产写已落盘：刷新
 *   失败只记 error 不回滚」；两次连续标题变更各自触发一次 refresh——refresh
 *   之间没有单调版本检查（context-projection.ts:1271 起，updater 只查
 *   `=== newVersion` 相同跳过，不拒绝回退到更旧版本）。
 * - refresh 遍历全部投影文件（readdir + Promise.all 读盘），投影多时耗时可
 *   观——旧 refresh 的 updater 完全可以晚于新 refresh 应用。
 * - committed 校验器强校验 `expected[assetId] !== asset.version → throw`，
 *   「每回合注入整体失败（projection_asset_version_changed）且无任何回退」
 *   （context-projection.ts:1181 注释）。
 *
 * 预言：后应用的旧版本 refresh 会把投影 assetVersions 回退到旧版本 →
 * 与资产当前版本失配 → validate 整组拒绝注入（非法态，无自愈）。
 *
 * 2026-09-30 r2 修复（F-r2-3）：refreshCommittedProjectionAssetVersion 锁内
 * updater 加单调版本守卫（仅 Number(newVersion) > 当前值才覆写，NaN 保守
 * 跳过），计数仅在真正覆写时 +1。本探针已反转为回归测试。
 *
 * 2026-09-30 r2 收尾（记账员）：由 probe- 改名 regression-，正式收编为
 * F-r2-3 的回归测试（本文件全部用例对应该已修项，无待议用例）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../helpers/drain-main-runtime';

let tmp: string;
let previous: string | undefined;
beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2-proj-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});
afterEach(async () => {
  try {
    await drainMainRuntimeForTest('user-a');
  } finally {
    if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

async function modules() {
  const [candidates, assets, projection] = await Promise.all([
    import('../../src/main/features/recall/candidate-service'),
    import('../../src/main/features/recall/asset-service'),
    import('../../src/main/features/recall/context-projection'),
  ]);
  return { candidates, assets, projection };
}

describe('regression r2（F-r2-3 已修）: committed 投影版本刷新的乱序回退（已堵，转为回归）', () => {
  // r2 修复（F-r2-3）：refreshCommittedProjectionAssetVersion 的锁内 updater
  // 加单调版本守卫——后到的旧 refresh 不再回退投影版本，计数仅在真正覆写时 +1。
  it('后到的旧版本 refresh 被单调守卫拒绝：不回退、不计数，validate 继续通过', async () => {
    const { candidates, assets, projection } = await modules();

    // 造资产（沿用正式晋升链路）并抬到可注入档位。
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Preserve source evidence in reviews.',
      summary: 'Evidence preservation rule',
      suggestedType: 'rule',
      applicableWhen: ['Formal review with traceable evidence'],
      forbiddenWhen: ['Informal discussion'],
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    await assets.setAbilityAssetMaturity('user-a', promoted.asset.id, 'transfer_validated');
    const assetId = promoted.asset.id;

    // committed 投影：preview → confirm，冻结 assetVersions = v0。
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-r2-probe',
      purpose: 'review',
    });
    expect(preview.assetIds).toContain(assetId);
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    const frozenVersion = String(confirmed.assetVersions?.[assetId]);
    expect(frozenVersion).toBeTruthy();

    // 语义前提：当前投影与资产版本一致时校验通过。
    await expect(projection.validateCommittedProjectionAssetVersions('user-a', confirmed)).resolves.toBeTruthy();

    // 场景：资产改标题 bump 到 v1，updateAbilityAsset 自动把投影刷到 v1
    //（代表"快的、新的 refresh 先完成"）。
    const updated = await assets.updateAbilityAsset('user-a', assetId, {
      title: '探针新标题',
      reason: 'probe r2 title change',
      actor: 'user',
    });
    const bumped = String(updated.version);
    expect(bumped).not.toBe(frozenVersion);
    const afterAutoRefresh = (await projection.listAllConfirmedProjections('user-a'))
      .find((p) => p.id === confirmed.id);
    expect(String(afterAutoRefresh?.assetVersions?.[assetId])).toBe(bumped);

    // 竞态主体：第一次标题变更触发的 refresh（旧版本 v0）此刻才应用——
    // 单调守卫拒绝回退：返回 0（未覆写不计数）。
    const refreshedStale = await projection.refreshCommittedProjectionAssetVersion('user-a', assetId, frozenVersion);
    expect(refreshedStale).toBe(0);

    // 无回退：投影版本保持 v1，与资产当前版本一致。
    const afterStale = (await projection.listAllConfirmedProjections('user-a'))
      .find((p) => p.id === confirmed.id);
    expect(String(afterStale?.assetVersions?.[assetId])).toBe(bumped);

    // 合法态：committed 校验器继续通过，注入不受乱序影响。
    await expect(projection.validateCommittedProjectionAssetVersions('user-a', afterStale as never))
      .resolves.toBeTruthy();
  });
});
