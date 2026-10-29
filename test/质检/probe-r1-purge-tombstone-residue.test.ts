/** 彻底清除后的墓碑语义字段残留；覆盖 causalRule、tags、scope 及来源信息。 */
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
const UID = 'probe-r1-purge';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1p-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function assetFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${id}.json`);
}

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

async function mkAsset(id: string) {
  const now = new Date().toISOString();
  // 直接落历史记录（test-only 种子）：本探针考墓碑字段清理面，不考创建门。
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: '演示纪律', statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('purge 墓碑可识别内容清理面', () => {
  it('purge 后 causalRule/tags/scope/learningProvenance 及扩展面全部清空（含盘上与读回口径）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-purge-residue');

    // 手工把可识别内容写上资产（模拟晋升时冻结的因果规则 + 用户打的标签、
    // 手写的 scope、复盘归因明细、敏感分级与编辑决定——都是产品真实写路径
    // 会产生的字段）
    const rawPath = assetFile('aa-purge-residue');
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as Record<string, unknown>;
    raw.causalRule = {
      cause: '在合成测试工作区执行覆盖写入脚本',
      effect: '临时测试数据被覆盖，基线比较无法复用',
      mitigation: '对合成测试工作区执行写操作前先打快照',
      severity: 'high',
      deltaR: -0.5,
    };
    raw.tags = ['合成写入', '快照纪律'];
    raw.scope = '仅限合成测试工作区';
    raw.familyName = '合成快照族';
    raw.learningProvenance = {
      projectionId: 'proj-1', episodeId: 'ep-1', ruleRefs: [],
      attribution: 'execution_gap',
      actionDelta: { missingTools: [], unexpectedTools: [], missingActors: [], unexpectedActors: [], missingPlanSteps: ['先打快照'], extraActions: [], failedActions: [], orderMismatch: false },
    };
    raw.sensitivity = 'L1';
    raw.userEditDecision = {
      id: 'ed_probe-r1-purge-01', ownerId: UID, cid: 'cid-probe-1', sourceMessageId: 'msg-probe-1',
      method: 'exact_patch', targetId: 'aa-purge-residue', previousVersion: '1',
      previousActiveVersion: '1', committedVersion: '1', changedFields: ['statement'],
      patch: { statement: '陈述 aa-purge-residue。' }, createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(rawPath, JSON.stringify(raw));

    // 走真实生命周期：delete → purge（到期清扫同款路径）
    await assets.deleteAbilityAsset(UID, 'aa-purge-residue', ACT);
    const purged = await assets.purgeAbilityAsset(UID, 'aa-purge-residue', ACT);
    expect(purged.status).toBe('purged');

    // 对照组：清单内字段确实清了
    expect(purged.title).toBe('');
    expect(purged.statement).toBe('');
    expect((purged as unknown as Record<string, unknown>).familyName).toBeUndefined();
    expect(purged.evidenceRefs).toEqual([]);

    // 应然契约：四类内容在返回值里全部清空（scope 是 string 必填 → 空串口径）
    const residue = purged as unknown as Record<string, unknown>;
    expect(residue.causalRule).toBeUndefined();
    expect(residue.tags).toBeUndefined();
    expect(residue.scope).toBe('');
    expect(residue.learningProvenance).toBeUndefined();
    // 扩展清理面：分级声明与内嵌 patch 的编辑/授权凭据同样不留
    expect(residue.sensitivity).toBeUndefined();
    expect(residue.userEditDecision).toBeUndefined();
    expect(residue.standingPreferenceAuthority).toBeUndefined();

    // 盘上同样清空（不是只在返回值里）
    const onDisk = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.causalRule).toBeUndefined();
    expect(onDisk.tags).toBeUndefined();
    expect(onDisk.scope).toBe('');
    expect(onDisk.learningProvenance).toBeUndefined();
    expect(onDisk.sensitivity).toBeUndefined();
    expect(onDisk.userEditDecision).toBeUndefined();

    // 墓碑读回口径：asAsset purged 分支不再透传这些字段（历史回执读墓碑
    // 看不到内容；老墓碑读到也归一）。再手工把老口径字段塞回盘上模拟存量墓碑。
    const legacy = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as Record<string, unknown>;
    legacy.causalRule = raw.causalRule;
    legacy.tags = ['合成写入'];
    legacy.scope = '仅限合成测试工作区';
    legacy.learningProvenance = raw.learningProvenance;
    fs.writeFileSync(rawPath, JSON.stringify(legacy));
    const tomb = await assets.readAbilityAsset(UID, 'aa-purge-residue');
    const tombResidue = tomb as unknown as Record<string, unknown>;
    expect(tombResidue.causalRule).toBeUndefined();
    expect(tombResidue.tags).toBeUndefined();
    expect(tombResidue.scope).toBe('');
    expect(tombResidue.learningProvenance).toBeUndefined();
  });
});
