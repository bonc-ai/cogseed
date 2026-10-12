/**
 * 回归 sm1（原探针「merge 锁内不复核终态」断言反转）：
 * mergeAbilityAssets 两处锁内 updater 必须复核 assertMutableAbilityAsset。
 *
 * 链路（读码 asset-service.ts mergeAbilityAssets）：
 * 锁外预检 assertMutableAbilityAsset(source/target) 之后要经历多次 IO（版本流
 * 搬运 append × N、target 主记录更新），最后才轮到 source 归档 updater——
 * 该 updater 曾只挡 purged（assertNotPurged）与已合并（mergedIntoAssetId），
 * 不挡 deleted/revoked。updateRecallJsonRecord 锁内重读盘（store.ts），预检
 * 通过后窗口期内被删除/撤回的 source 仍会被强制改成 archived——绕过 setStatus
 * 的终态守卫（deleted 只许 →deleted/purged/restored）；archived 又是 restore
 * 的合法源，资产由此绕过删除保留期复活，且 archived 记录残留 deletedAt。
 *
 * 修复（2026-09-30 r1）：merge 两处锁内 updater 与 rollback/select/update 同款
 * 复核 assertMutableAbilityAsset（挡 purged/revoked/deleted 三终态）。
 *
 * 时序构造（确定性时序同款）：先持有 source 记录的 fileEditLock，
 * mergePromise 在最后归档 source 时排队等锁；持锁期间把盘上 source 置为
 * deleted；放锁后断言 merge 被终态守卫拒绝，盘上 source 保持 deleted。
 * 注：merge 抛错时 target 主记录与版本流已先落盘——两段写非原子是已知边界
 * （target 侧自身有锁内复核，不会出现非法跃迁），不在本回归范围。
 */
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

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-sm1-merge';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm1m-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

function assetFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${id}.json`);
}

async function mkAsset(id: string) {
  const assets = await loadAssets();
  const now = new Date().toISOString();
  return assets.createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('回归 sm1 › merge 锁内复核终态', () => {
  it('锁外预检后 source 被并发删除：锁内终态守卫拒绝归档，盘上保持 deleted（无非法跃迁、无 deletedAt 脏残留）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-src2');
    await mkAsset('aa-tgt2');

    const { fileEditLock } = await import('../../src/main/util/locks');
    const srcPath = assetFile('aa-src2');
    const lockT = fileEditLock(assetFile('aa-tgt2'));
    const lockS = fileEditLock(srcPath);

    // 先持有 target 锁并挂起：merge 的锁外预检（无锁读盘）必然先完成，
    // 然后卡在 target 主记录更新的锁队列上——此刻窗口期开始。
    let releaseT!: () => void;
    const heldT = new Promise<void>((resolve) => {
      void lockT.runExclusive(async () => {
        resolve();
        await new Promise<void>((r) => { releaseT = r; });
      });
    });
    await heldT;

    const mergePromise = assets.mergeAbilityAssets(UID, 'aa-src2', 'aa-tgt2', { actor: 'user', reason: 'probe merge' });
    // 等 merge 走完预检（读到 active）与版本流搬运、在 target 锁上排队。
    await new Promise((r) => setTimeout(r, 150));
    // 窗口期内：把 source 置为 deleted（等价于另一个删除操作落盘）。
    await lockS.runExclusive(() => {
      const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      raw.status = 'deleted';
      raw.deletedAt = new Date().toISOString();
      fs.writeFileSync(srcPath, JSON.stringify(raw));
    });
    // 放行 target 锁：merge 继续执行，最后归档 source 时锁内读到 deleted。
    releaseT();

    // 回归主体：锁内终态守卫拒绝 deleted→archived 非法跃迁。
    await expect(mergePromise).rejects.toThrow(/deleted ability asset cannot be changed/);

    // source 保持 deleted 终态：没有 mergedIntoAssetId，没有「archived 带
    // deletedAt」的脏状态外泄。
    const after = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    expect(after.status).toBe('deleted');
    expect(after.mergedIntoAssetId).toBeUndefined();
    expect(typeof after.deletedAt).toBe('string');
  });

  it('对照组：无并发时 deleted source 在锁外预检即被拒（既有正确行为）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-src3');
    await mkAsset('aa-tgt3');
    await assets.deleteAbilityAsset(UID, 'aa-src3', ACT);
    await expect(assets.mergeAbilityAssets(UID, 'aa-src3', 'aa-tgt3', { actor: 'user', reason: 'probe' }))
      .rejects.toThrow(/deleted ability asset cannot be changed/);
  });
});
