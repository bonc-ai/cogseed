/** 墓碑已提交但冻结副本未清理时的重试恢复边界（重入 + 通道）。 */
import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
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
  const now = new Date().toISOString();
  // 直接落历史记录（test-only 种子）：本探针考重试通道，不考创建门。
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

/** 构造「级联中途失败」的等价残留：一个引用该资产的投影，冻结副本里带正文。 */
function seedResidueProjection(id: string, suffix: string): string {
  const projDir = path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'projections');
  fs.mkdirSync(projDir, { recursive: true });
  const projPath = path.join(projDir, `pj-sm1-${suffix}.json`);
  fs.writeFileSync(projPath, JSON.stringify({
    schemaVersion: 1, ownerId: UID, id: `pj-sm1-${suffix}`,
    taskRunId: `tr-sm1-${suffix}`, purpose: 'task', assetIds: [id],
    // asProjection 必需字段：缺这三个会被整条跳过（清理面读不进来的投影
    // 等于没构造出残留现场——原探针从未跑过，夹具一直缺这几项）。
    sourceRefs: [], omittedRefs: [], authorization: 'user',
    assetVersions: { [id]: '1' },
    assetVersionSnapshots: { [id]: { version: '1', snapshot: { statement: '正文残留' } } },
    status: 'confirmed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  return projPath;
}

describe('purge 后冻结副本的重试与清扫通道', () => {
  it('墓碑已落、投影冻结副本残留：同入口重试可重入并把副本清掉', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-sm1');
    await assets.deleteAbilityAsset(UID, 'aa-sm1', ACT);
    // 第一次 purge 正常完成 = setStatus 落墓碑的等价终态。
    const purged = await assets.purgeAbilityAsset(UID, 'aa-sm1', ACT);
    expect(purged.status).toBe('purged');

    const projPath = seedResidueProjection('aa-sm1', 'a');

    // 应然契约：重试同一 purge 入口不再被 assertNotPurged 挡住——墓碑已落
    // 仍可重入级联清理，clearAssetFromAllProjections 随重入执行。
    const retried = await assets.purgeAbilityAsset(UID, 'aa-sm1', ACT);
    expect(retried.status).toBe('purged');
    const left = JSON.parse(fs.readFileSync(projPath, 'utf8')) as Record<string, unknown>;
    expect(left.assetIds).toEqual([]);
    expect(left.assetVersionSnapshots).toBeUndefined();
    expect(JSON.stringify(left)).not.toContain('正文残留');
  });

  it('启动清扫兜底：purge 后仍残留的投影冻结副本被 sweep 清除（无人工入口也收口）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-sm1b');
    await assets.deleteAbilityAsset(UID, 'aa-sm1b', ACT);
    await assets.purgeAbilityAsset(UID, 'aa-sm1b', ACT);

    // 模拟旁路残留（历史数据/级联半途失败的等价现场）：purge 完成后落进来的
    // 引用该资产的投影冻结副本。
    const projPath = seedResidueProjection('aa-sm1b', 'b');

    const report = await assets.sweepPurgedAbilityAssetVersionStreams(UID);
    expect(report.sweptProjectionAssets).toContain('aa-sm1b');
    expect(report.clearedProjections).toBeGreaterThan(0);
    const left = JSON.parse(fs.readFileSync(projPath, 'utf8')) as Record<string, unknown>;
    expect(left.assetVersionSnapshots).toBeUndefined();
    expect(JSON.stringify(left)).not.toContain('正文残留');
  });
});
