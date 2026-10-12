/**
 * 探针（状态机审计员 · 新循环第 2 轮）：purge 删整流与并发 append 无互斥 +
 * 行数缓存不失效。
 *
 * 读码对照（storage.ts / recall/store.ts）：
 * - removeJsonlRecords（storage.ts:380）注释与实现都「与 appendJsonlAtomic
 *   共享同一把 _getLineLock」；
 * - removeRecallJsonlStream（recall/store.ts:162-175）删整流时**直接 fs.rm**，
 *   不取行锁、不调 invalidateLineCount（storage.ts:244 专为「文件被删除后
 *   让下一次 append 重新计数」准备的钩子从未被调用）。
 *
 * 后果（purge 场景，ability-asset-versions/<assetId> 流）：
 * 1. 在途 append（已过锁外终态预检、主记录已写、appendVersion 正在路上的
 *    update/merge）在 rm 之后到达 → appendFile 重建流文件 → **purged 资产的
 *    版本流复活一条含正文的快照**，「内容与记录一并清除」破防；
 * 2. _lineCounts 缓存不失效 → 重建后的第一条 append 拿到 stale msgIndex。
 *
 * 等价构造：purge 正常完成（流已 rm）后模拟在途 append 落盘，断言它不经
 * 任何防护写成功、流可读回、msgIndex 用了 stale 计数。
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
const UID = 'probe-sm2-rm';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm2r-'));
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

function versionRecord(assetId: string, version: string, statement: string) {
  return {
    schemaVersion: 1, ownerId: UID, id: `${assetId}-v${version}`, assetId, version,
    at: new Date().toISOString(), reason: 'probe', actor: 'user' as const,
    snapshot: {
      candidateId: `cand-${assetId}`, type: 'personal', title: `资产 ${assetId}`,
      statement, evidenceRefs: [], scope: 'general',
      lifecycleStatus: 'user_confirmed_unverified', version,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  };
}

describe('probe-sm2 › purge 删整流无锁 rm 与在途 append 交错', () => {
  it('purge 完成后在途 append 重建版本流：正文快照复活且 msgIndex 用 stale 计数', async () => {
    const assets = await loadAssets();
    // msgIndex 断言必须直调底层 appendJsonlAtomic：真实链路 appendVersion 走
    // appendRecallJsonlRecord，但它把 AtomicAppendResult 丢弃只返回裸 record——
    // 行号分配本身发生在 appendJsonlAtomic（storage.ts:225 的锁+行数缓存），
    // 直调同一写入口与真实链路等价（同锁、同缓存、同文件）。
    const { appendJsonlAtomic } = await import('../../src/main/storage');
    const { recallJsonlPath } = await import('../../src/main/features/recall/paths');
    const streamPath = recallJsonlPath(UID, 'ability-asset-versions', 'aa-sm2');
    await mkAsset('aa-sm2');

    // 建立流与行数缓存。msgIndex 从 1 起：mkAsset → createAbilityAsset 已经为
    // 初始 v1 写过一条快照（asset-service.ts:548「空流先补初始版本」），流里
    // 已有 1 行、缓存计数=1——初版探针没算这条，误以为首条是 0。
    const first = await appendJsonlAtomic(streamPath, versionRecord('aa-sm2', '1', '陈述 v1。'));
    expect(first.msgIndex).toBe(1);

    // 正常软删 + 彻底清除：removeRecallJsonlStream 直接 fs.rm（无行锁、无 invalidate）。
    await assets.deleteAbilityAsset(UID, 'aa-sm2', ACT);
    await assets.purgeAbilityAsset(UID, 'aa-sm2', ACT);

    // 模拟「rm 前已通过锁外预检、appendVersion 在路上」的在途写：重建流文件。
    const second = await appendJsonlAtomic(streamPath, versionRecord('aa-sm2', '2', 'purge 后复活的正文 v2。'));

    // stale 计数：rm 不清缓存（计数仍=2），重建后的流只有本条 1 行，正确行号
    // 应为 0，实际拿到旧缓存值 2——「purge 后第一条 append 用 stale msgIndex」
    // 的实证（若 removeRecallJsonlStream 补调 invalidateLineCount，此处回 0）。
    expect(second.msgIndex).toBe(2);

    // purged 资产的版本流可读回复活快照（含正文）。
    const versions = await assets.listAbilityAssetVersions(UID, 'aa-sm2');
    expect(versions.length).toBe(1);
    expect(String(versions[0].snapshot.statement || '')).toContain('purge 后复活的正文');
  });
});
