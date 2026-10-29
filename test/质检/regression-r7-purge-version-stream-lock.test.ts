import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 版本流终态保护：启动清扫移除 purged 或无主记录的残留流，活资产不动；
 * purge 删除后复核并再清旁路残留，merge 在目标被清除后拒绝追加快照。
 * 时序钩子只位于无锁边界，避免重入同锁造成死等。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

// 时序钩子（一次性，按流 id 定向；风格对齐 probe-r7-purge-append-interleave）：
// - __rmHook：removeRecallJsonlStream 的返回沿——purge 删流刚完成、双向复核
//   尚未复读的窗口，模拟旁路写漏网重建流。
// - __listHook：listRecallJsonlRecords 的调用前沿——merge 入口校验已过、
//   首条版本追加尚未开始的窗口，模拟对手方完整 purge target。
const g = globalThis as unknown as {
  __regR7RmHook?: { stream: string; run: () => Promise<void> };
  __regR7ListHook?: { stream: string; run: () => Promise<void> };
};
vi.mock('../../src/main/features/recall/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/features/recall/store')>();
  return {
    ...actual,
    removeRecallJsonlStream: async (...args: Parameters<typeof actual.removeRecallJsonlStream>) => {
      await actual.removeRecallJsonlStream(...args);
      const hook = g.__regR7RmHook;
      if (hook && hook.stream === args[2]) {
        g.__regR7RmHook = undefined; // 一次性：复核触发的第二次清除不再注入
        await hook.run();
      }
    },
    listRecallJsonlRecords: async (...args: Parameters<typeof actual.listRecallJsonlRecords>) => {
      const hook = g.__regR7ListHook;
      if (hook && hook.stream === args[2]) {
        g.__regR7ListHook = undefined;
        await hook.run();
      }
      return actual.listRecallJsonlRecords(...args);
    },
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'reg-r7-lock';

// 单模块世界（2026-10-19 教训）：本文件 vi.mock 的 importOriginal 只在首个
// 用例的模块世界捕获一次 actual；若每例 resetModules+换 tmpDir，mock 代理的
// 真实 store 仍指向前一世界的 WS_ROOT，rm/复读会写进已删除的旧目录，用例
// 变成「假绿」。整个文件共用一个工作区（各用例资产 id 互不重叠），mock 与
// 断言从此同一世界。
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-reg-r7lock-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterAll(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  g.__regR7RmHook = undefined;
  g.__regR7ListHook = undefined;
});

const SECRET = 'PURGED_SECRET_r7lock_演示环境一律先打快照再执行任何写操作';
const ACT = { actor: 'user' as const, reason: 'probe' };

function versionStreamFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'jsonl', 'ability-asset-versions', `${id}.jsonl`);
}

function assetFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${id}.json`);
}

async function mkAsset(id: string, statement = SECRET) {
  const { createAbilityAsset } = await import('../../src/main/features/recall/asset-service');
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_reg${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'rule', title: '演示纪律', statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, ACT);
}

/** 用底层 appendJsonlAtomic 构造清除后的残留快照，验证启动补偿能移除它。
 * recall/store 的追加入口拒绝 purged 资产写入，因此此处模拟旧数据绕过记录层
 * 的情形，不通过受保护的业务写入入口构造。 */
async function rebuildLeakedStream(id: string) {
  const { appendJsonlAtomic } = await import('../../src/main/storage');
  const { recallJsonlPath } = await import('../../src/main/features/recall/paths');
  await appendJsonlAtomic(recallJsonlPath(UID, 'ability-asset-versions', id), {
    schemaVersion: 1, ownerId: UID, id: `${id}-v2`, assetId: id, version: '2',
    at: new Date().toISOString(), reason: 'leaked late append', actor: 'user',
    snapshot: {
      title: '演示纪律', statement: SECRET, type: 'rule',
      evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }],
    },
  } as never);
}

describe('purge×版本流三道防线', () => {
  it('启动清扫：purged 墓碑与记录已除名（迁移后）的泄漏流被清，活资产的流保留', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');

    // 泄漏现场 A：purged 资产名下被重建的流（修复前在途 append 所留）。
    const idA = 'aa-r7sw-a';
    await mkAsset(idA);
    await assets.deleteAbilityAsset(UID, idA, ACT);
    await assets.purgeAbilityAsset(UID, idA, ACT);
    await rebuildLeakedStream(idA);
    expect(fs.existsSync(versionStreamFile(idA))).toBe(true);

    // 泄漏现场 B：记录已迁出并被物理删除（记录面不存在），流却残留。
    const idB = 'aa-r7sw-b';
    await mkAsset(idB);
    fs.rmSync(assetFile(idB));
    await rebuildLeakedStream(idB);

    // 对照：活资产的流必须原样保留。
    const idLive = 'aa-r7sw-live';
    await mkAsset(idLive);
    expect(fs.existsSync(versionStreamFile(idLive))).toBe(true);

    const report = await assets.sweepPurgedAbilityAssetVersionStreams(UID);
    expect(report.sweptStreams.sort()).toEqual([idA, idB].sort());
    expect(report.purgedTombs).toBe(1); // A 有墓碑；B 是记录已除名
    expect(fs.existsSync(versionStreamFile(idA))).toBe(false);
    expect(fs.existsSync(versionStreamFile(idB))).toBe(false);
    expect(fs.existsSync(versionStreamFile(idLive))).toBe(true);
    // 幂等：再扫一遍空转。
    const again = await assets.sweepPurgedAbilityAssetVersionStreams(UID);
    expect(again.sweptStreams).toEqual([]);
  });

  it('purge 双向复核：rm 后复读发现残留（旁路写）→ 再清一次，终态无正文', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const id = 'aa-r7res';
    await mkAsset(id);
    await assets.deleteAbilityAsset(UID, id, ACT);

    // 注入：purge 的第一次删流返回沿（复核复读之前），旁路写漏网重建一条含正文的行。
    g.__regR7RmHook = {
      stream: id,
      run: () => rebuildLeakedStream(id),
    };

    await assets.purgeAbilityAsset(UID, id, ACT);

    // 复核触发的第二次清除把旁路残留也删掉了：终态流不存在、读回为空。
    expect(fs.existsSync(versionStreamFile(id))).toBe(false);
    expect(await assets.listAbilityAssetVersions(UID, id)).toEqual([]);
    const purged = await assets.readAbilityAsset(UID, id);
    expect(purged.status).toBe('purged');
    expect(purged.statement).toBe('');
  });

  it('merge 搬运收口：归并入口校验后 target 被 purge → 后续追加被拒，target 流不复活', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const idS = 'aa-r7mg-s';
    const idT = 'aa-r7mg-t';
    await mkAsset(idS, `${SECRET} source`);
    await mkAsset(idT, `${SECRET} target`);
    await assets.updateAbilityAsset(UID, idS, { statement: `${SECRET} source v2`, reason: 'bump', actor: 'user' });

    // 注入：merge 读 source 版本流（入口校验已过、尚未追加）时，对手方完整
    // purge target——正是修复前「入口校验放行、追加在路上」的复活窗口。
    g.__regR7ListHook = {
      stream: idS,
      run: async () => {
        await assets.deleteAbilityAsset(UID, idT, ACT);
        await assets.purgeAbilityAsset(UID, idT, ACT);
      },
    };

    await expect(assets.mergeAbilityAssets(UID, idS, idT, ACT)).rejects.toThrow(/purged/);

    // 终态：target 是墓碑、流没有因归并在途追加而复活。
    const purged = await assets.readAbilityAsset(UID, idT);
    expect(purged.status).toBe('purged');
    expect(fs.existsSync(versionStreamFile(idT))).toBe(false);
    expect(await assets.listAbilityAssetVersions(UID, idT)).toEqual([]);
  });
});
