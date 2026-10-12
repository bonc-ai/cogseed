/**
 * 探针（状态机审计员 · 新循环第 1 轮）：purge 半途中断后重试被自己的墓碑挡住。
 *
 * 链路（读码 asset-service.ts:1345-1389 + store.ts:122-138）：
 * purgeAbilityAsset = setStatus('purged')（先落墓碑）→ removeRecallJsonlStream
 * （删版本流）→ cascadePurgeAssetReferences（清三个用量流 + 投影冻结副本）。
 * 三段之间都是独立 await，任一段 IO 故障/进程中断都会留下「墓碑已落、级联未清」
 * 的状态。而 setStatus 的 updater 首行 assertNotPurged(:1038) 对已 purged 记录
 * 直接 throw——重试 purge 在第一步就被挡，级联段永远执行不到。
 * store.ts:160 注释明说 removeRecallJsonlStream「清除要可重入，半路失败后重试
 * 不该被绊住」，但 purgeAbilityAsset 整体不可重入，设计意图与实现矛盾。
 *
 * 等价构造：第一次 purge 正常完成（= setStatus 已落墓碑的等价终态），再在投影
 * 目录放置含正文的冻结副本（= 级联未清的残留），断言第二次 purge 被拒、残留
 * 无法经任何产品通道清除（cascadePurgeAssetReferences 无独立入口，全仓仅
 * purgeAbilityAsset 一个调用方）。
 * 2026-09-30 r1 收尾（记账员）：对应待议 P-r1-1（与 probe-r5-purge-
 * nonretryable-cascade 用例 1 同题异构：r5 用 chmod 制造真实 IO 故障，本探针
 * 用等价构造测投影冻结副本残留通道）→ it.skip，断言锁定现状，拍板后反转。
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
const UID = 'probe-sm1-purge';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm1p-'));
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

describe('probe-sm1 › purge 生命周期断链（待议 P-r1-1，拍板前 skip）', () => {
  it.skip('墓碑已落、级联残留未清时：重试 purge 被 assertNotPurged 挡住，投影冻结副本无通道可清', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-sm1');
    await assets.deleteAbilityAsset(UID, 'aa-sm1', ACT);
    // 第一次 purge 正常完成 = setStatus 落墓碑的等价终态。
    const purged = await assets.purgeAbilityAsset(UID, 'aa-sm1', ACT);
    expect(purged.status).toBe('purged');

    // 构造「级联中途失败」的等价残留：一个引用该资产的投影文件，冻结副本里
    // 带正文（对应第一次 purge 的 cascadePurgeAssetReferences 未完成状态）。
    const projDir = path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'projections');
    fs.mkdirSync(projDir, { recursive: true });
    const projPath = path.join(projDir, 'pj-sm1.json');
    fs.writeFileSync(projPath, JSON.stringify({
      schemaVersion: 1, ownerId: UID, id: 'pj-sm1',
      taskRunId: 'tr-sm1', purpose: 'task', assetIds: ['aa-sm1'],
      assetVersions: { 'aa-sm1': '1' },
      assetVersionSnapshots: { 'aa-sm1': { version: '1', snapshot: { statement: '正文残留' } } },
      status: 'confirmed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));

    // 重试 purge：在 setStatus 的 assertNotPurged 即被拒——级联段（含
    // clearAssetFromAllProjections）永远执行不到。
    await expect(assets.purgeAbilityAsset(UID, 'aa-sm1', ACT))
      .rejects.toThrow(/has been purged/);

    // 残留原样滞留：没有第二个产品入口能清它。
    const left = JSON.parse(fs.readFileSync(projPath, 'utf8'));
    expect(left.assetVersionSnapshots['aa-sm1'].snapshot.statement).toBe('正文残留');
  });
});
