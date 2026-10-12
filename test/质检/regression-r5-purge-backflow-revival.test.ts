/**
 * 回归 r5（原探针「purge 级联完整性 · 删除后复活」断言反转）：
 * purge 级联必须清掉本体回流候选，purged 正文不得经候选确认写回普通组。
 *
 * 背景：本探针原与 test/质检/probe-r1-backflow-purge-revival.test.ts 独立重证
 * 同一复活链（候选池 `asset-backflow-<assetId>` 携正文存活 → confirmCandidate
 * 写回组流水区）。2026-09-30 r1 修复后断言反转入回归：级联清单已含候选池
 * （asset-service.ts cascadePurgeAssetReferences 动态 import rejectCandidate
 * 精确移除该回流候选），复活终点应被堵死。
 *
 * PoEntry 是 {id,text,...} 对象（model.ts），正文断言用 entry.text，
 * 不用 String(entry)（恒为 '[object Object]'）。
 * 风格对齐 regression-r1-asset-lifecycle.test.ts。
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
const UID = 'probe-r5-bf';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r5d-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SECRET = 'PURGED_SECRET_r5_演示环境一律先打快照再执行任何写操作';
const ACT = { actor: 'user' as const, reason: 'probe' };

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
  return (pool?.candidate_updates || []).find((c: { candidate_id?: string }) => c?.candidate_id === candidateId) || null;
}

describe('回归 r5 › purge 级联清本体回流候选（复活终点堵死 · entry.text 断言）', () => {
  it('purged 回流候选被级联移除；confirmCandidate 无处确认，正文进不了组流水区（entry.text 断言）', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { backflowAssetToOntologyPool } = await import('../../src/main/features/recall/ontology-backflow');
    const { confirmCandidate } = await import('../../src/main/features/personal_ontology_candidates');
    const { createGroup } = await import('../../src/main/features/personal_ontology_groups');
    const { loadPoDocSync } = await import('../../src/main/features/po/store');

    const asset = await mkRuleAsset('aa-bf-r5');
    expect(await backflowAssetToOntologyPool(UID, asset)).toMatchObject({ offered: true });

    // 真实生命周期：delete → purge（用户手动彻底清除路径）
    await assets.deleteAbilityAsset(UID, 'aa-bf-r5', ACT);
    const purged = await assets.purgeAbilityAsset(UID, 'aa-bf-r5', ACT);
    expect(purged.status).toBe('purged');
    expect(purged.statement).toBe(''); // 主记录正文确已清空

    // ① 级联已覆盖候选池：回流候选被精确移除
    const after = await findBackflowCandidate('asset-backflow-aa-bf-r5');
    expect(after).toBeNull();

    // ② 复活终点堵死：确认候选失败（candidate not found），正文写不进组流水区
    const created = await createGroup(UID, '复活观测组r5');
    expect(created.ok).toBe(true);
    const result = await confirmCandidate(UID, 'asset-backflow-aa-bf-r5', {
      toGlobalMemory: false,
      toGroupIds: [created.group!.group_id],
    });
    expect(result.ok).toBe(false);

    const doc = loadPoDocSync(UID);
    const group = doc.groups.find((g: { title?: string }) => g.title === '复活观测组r5');
    expect(group).toBeDefined();
    const entries = (group?.entries || []) as Array<{ text?: string }>;
    // 正文断言用 entry.text（PoEntry 是对象，String(entry) 恒为 '[object Object]'）
    expect(entries.some((entry) => String(entry?.text || '').includes('PURGED_SECRET'))).toBe(false);
  });
});
