import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 删除历史版本与切换在用版使用同一资产锁并在锁内重查版本流。
 * 在投影冻结窗口排队一次 select：删除先完成后，select 应拒绝已删除
 * 的版本，在用版本指针不能指向不存在的快照。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

// 时序注入钩子：挂在 globalThis 上绕开 vi.mock 工厂的 hoisting 限制。
// deleteAbilityAssetVersion 在 active 检查之后调用 listAllConfirmedProjections，
// 钩子在此刻执行「并发对手方」selectAbilityAssetVersion，然后放行原实现。
type ProbeHook = (uid: string) => Promise<void> | undefined;
const g = globalThis as unknown as { __probeR6Hook?: ProbeHook; __probeR6Calls?: number };
vi.mock('../../src/main/features/recall/context-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/features/recall/context-projection')>();
  return {
    ...actual,
    listAllConfirmedProjections: async (uid: string) => {
      g.__probeR6Calls = (g.__probeR6Calls || 0) + 1;
      if (g.__probeR6Hook) await g.__probeR6Hook(uid);
      return actual.listAllConfirmedProjections(uid);
    },
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r6-race';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r6a-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  g.__probeR6Hook = undefined;
  g.__probeR6Calls = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

const ASSET_ID = 'aa-p6race01';

async function seedThreeVersions() {
  const assets = await loadAssets();
  const now = new Date().toISOString();
  await seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id: ASSET_ID, candidateId: `cand-${ASSET_ID}`,
    sourceCandidateIds: [`cand-${ASSET_ID}`], reviewDecisionId: 'rd_prober6seed01',
    type: 'personal', title: '资产 r6', statement: '第一版正文。',
    evidenceRefs: [{ kind: 'conversation', id: `conv-${ASSET_ID}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
  // bump 到 v2、v3（update 每次 append 一版；无投影时刷新为 no-op）
  await assets.updateAbilityAsset(UID, ASSET_ID, { title: '资产 r6 v2', reason: 'bump 2', actor: 'user' });
  const afterV3 = await assets.updateAbilityAsset(UID, ASSET_ID, { title: '资产 r6 v3', reason: 'bump 3', actor: 'user' });
  expect(afterV3.version).toBe('3');
  const versions = await assets.listAbilityAssetVersions(UID, ASSET_ID);
  expect(versions.map((v) => v.version)).toEqual(['1', '2', '3']);
  return assets;
}

describe('删除历史版本与在用版切换的并发一致性', () => {
  it('对照组：select 先落盘，delete 同版本被守卫拒绝（无竞态时守卫有效）', async () => {
    const assets = await seedThreeVersions();
    const selected = await assets.selectAbilityAssetVersion(UID, ASSET_ID, '2', { actor: 'user', reason: '切 v2 为在用' });
    expect(String(selected.activeVersion || selected.version)).toBe('2');
    await expect(
      assets.deleteAbilityAssetVersion(UID, ASSET_ID, '2', { actor: 'user', reason: '删在用版' }),
    ).rejects.toThrow(/cannot delete the active version/);
    const versions = await assets.listAbilityAssetVersions(UID, ASSET_ID);
    expect(versions.map((v) => v.version)).toContain('2');
  });

  it('竞态主用例：delete 检查+删除同锁后，窗口内的 select 被锁内重校拒绝，在用版本不蒸发', async () => {
    const assets = await seedThreeVersions();
    // 并发对手方：在 delete 的锁定窗口内（投影冻结段）发起 select——修复后
    // delete 全程持资产记录锁，select 的记录写在同一把锁上排队，delete 先
    // 完成、select 随后锁内重列版本流发现 v2 已删而拒绝。钩子不能 await
    // select（那会与 delete 互等成死锁），发射后由主用例收尾统一断言。
    let selectPromise: Promise<unknown> | undefined;
    g.__probeR6Hook = async () => {
      selectPromise = assets.selectAbilityAssetVersion(UID, ASSET_ID, '2', { actor: 'user', reason: '竞态对手方' });
    };
    // delete v2：锁内复核时 active=v3 放行；物理删除在锁内完成。
    await assets.deleteAbilityAssetVersion(UID, ASSET_ID, '2', { actor: 'user', reason: '删 v2' });
    expect(g.__probeR6Calls).toBeGreaterThan(0); // 钩子确实在锁内窗口被调用
    expect(selectPromise).toBeDefined();
    // 排队的 select 在 delete 释放锁后运行：锁内重校发现 v2 已物理删除 → 拒绝。
    await expect(selectPromise).rejects.toThrow(/version not found/i);

    const asset = await assets.readAbilityAsset(UID, ASSET_ID);
    const versions = await assets.listAbilityAssetVersions(UID, ASSET_ID);
    // 终态断言（修复后）：在用版仍是 v3（select 未生效），v2 已删且没有任何
    // 指针指向蒸发版本——「在用版本不可删」的自留承诺成立。
    expect(String(asset.activeVersion || asset.version)).toBe('3');
    expect(versions.map((v) => v.version)).toEqual(['1', '3']);
    await expect(assets.readAbilityAssetVersionSnapshot(UID, ASSET_ID, '2')).resolves.toBeNull();
  });
});
