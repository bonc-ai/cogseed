/**
 * 回归 r1（原探针「purged 资产借本体回流候选复活」断言反转）：
 * purge 级联必须清掉本体回流候选池里的 `asset-backflow-<assetId>` 候选。
 *
 * 链路（读码）：
 *  - 晋升 create 落点把资产 statement 全文投进本体候选池（candidate-service.ts
 *    → ontology-backflow.ts backflowAssetToOntologyPool，candidate_id 固定
 *    `asset-backflow-<assetId>`，memory_text=statement）；
 *  - purgeAbilityAsset 的级联清单（asset-service.ts cascadePurgeAssetReferences）
 *    曾不含本体候选池——purge 后候选原样躺在池里，confirmCandidate 又不查
 *    来源资产存活性，确认即把已 purge 的正文写回普通组，「不可恢复」被打破；
 *  - 修复（2026-09-30 r1）：级联第五步动态 import rejectCandidate +
 *    backflowCandidateIdFor，按 `asset-backflow-<assetId>` 精确移除该候选
 *    （不存在时 {ok:false} 不抛错，幂等），不动池内其他候选。
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
const UID = 'probe-r1-bf';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1bf-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SECRET = 'PURGED_SECRET_演示环境一律先打快照再执行任何写操作';

const ACT = { actor: 'user' as const, reason: 'probe' };

/** 建一条 rule 资产（type=rule 在回流白名单里，ontology-backflow.ts:41）。 */
async function mkRuleAsset(id: string) {
  const { createAbilityAsset } = await import('../../src/main/features/recall/asset-service');
  const now = new Date().toISOString();
  return createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'rule', title: '演示纪律', statement: SECRET,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, ACT);
}

async function findBackflowCandidate(candidateId: string) {
  const { listCandidates } = await import('../../src/main/features/personal_ontology_candidates');
  const pool = await listCandidates(UID);
  return (pool?.candidate_updates || []).find((c) => c?.candidate_id === candidateId) || null;
}

describe('回归 r1 › purge 级联清本体回流候选（复活通道堵死）', () => {
  it('purge 级联移除回流候选：正文副本不再留在池里（对照组：主记录正文已清空）', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { backflowAssetToOntologyPool } = await import('../../src/main/features/recall/ontology-backflow');

    const asset = await mkRuleAsset('aa-bf-revive');
    // 晋升链同款回流（candidate-service.ts 调用的就是这个函数）
    const offered = await backflowAssetToOntologyPool(UID, asset);
    expect(offered.offered).toBe(true);

    const before = await findBackflowCandidate('asset-backflow-aa-bf-revive');
    expect(before).not.toBeNull();
    expect(String(before!.memory_text || '')).toContain('PURGED_SECRET');

    // 走真实生命周期：delete → purge（用户手动彻底清除路径）
    await assets.deleteAbilityAsset(UID, 'aa-bf-revive', ACT);
    const purged = await assets.purgeAbilityAsset(UID, 'aa-bf-revive', ACT);
    expect(purged.status).toBe('purged');
    // 对照组：主记录与版本流的正文确实清了
    expect(purged.statement).toBe('');
    expect(purged.title).toBe('');

    // 回归主体：候选池的回流候选被级联精确移除（正文全文不再留在池里）
    const after = await findBackflowCandidate('asset-backflow-aa-bf-revive');
    expect(after).toBeNull();
  });

  it('复活终点被堵死：purge 后 confirmCandidate 找不到候选，正文进不了普通组流水区', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { backflowAssetToOntologyPool } = await import('../../src/main/features/recall/ontology-backflow');
    const { confirmCandidate } = await import('../../src/main/features/personal_ontology_candidates');
    const { createGroup } = await import('../../src/main/features/personal_ontology_groups');
    const { loadPoDocSync } = await import('../../src/main/features/po/store');

    const asset = await mkRuleAsset('aa-bf-revive2');
    await backflowAssetToOntologyPool(UID, asset);
    await assets.deleteAbilityAsset(UID, 'aa-bf-revive2', ACT);
    await assets.purgeAbilityAsset(UID, 'aa-bf-revive2', ACT);

    const created = await createGroup(UID, '复活观测组');
    expect(created.ok).toBe(true);
    expect(created.group?.group_id).toBeTruthy();

    // 用户在候选池点确认：候选已被 purge 级联移除，确认失败、无处可写
    const result = await confirmCandidate(UID, 'asset-backflow-aa-bf-revive2', {
      toGlobalMemory: false,
      toGroupIds: [created.group!.group_id],
    });
    expect(result.ok).toBe(false);

    // 回归主体：purge 掉的正文没有落进普通组流水区
    const doc = loadPoDocSync(UID);
    const group = doc.groups.find((g) => g.title === '复活观测组');
    expect(group).toBeDefined();
    const entries = (group?.entries || []) as Array<{ text?: unknown }>;
    expect(entries.some((entry) => String(entry?.text ?? entry).includes('PURGED_SECRET'))).toBe(false);
  });
});
