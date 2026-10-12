/**
 * 探针 r5（边界测试员 · 第 5 轮）→ 主题：setStatus 幂等早退与守卫的次序。
 *
 * 疑点：setStatus 的 updater 内部（asset-service.ts:1054-1055）——
 *   if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
 *   guard?.(current);
 * 幂等早退发生在 guard 之前：已应用的评审决定重放会**跳过 guard**。对
 * pause/resume 等纯状态路径无害（早退不落任何变更），但 purgeAbilityAsset
 * 在 setStatus 返回后**无条件**执行 removeRecallJsonlStream + 级联清理——
 * guard（requireDeleted：保留期清扫只许清 deleted）被跳过时，破坏性后续照跑。
 *
 * 现行三个 purge 调用方（ipc:2787/:2930、retention:80）都不带 reviewDecisionId，
 * 故属潜在陷阱（未来调用方/复用 input 对象即可踩中），非现行故障——对照组
 * 证明不带 rd 时 guard 正常拒绝。风格对齐 regression-r1-asset-lifecycle.test.ts。
 *
 * 2026-09-30 r1 收尾（记账员）：对应待议 P-r1-2（A 交换次序/B 仅 purge 内
 * 二次校验/C 收紧幂等判定，影响面不同待拍板）→ it.skip。注：本用例内嵌
 * 「不带 rd 时 guard 正常拒绝」对照断言（甄别 R-2 反证曾引其 :64-90 作幂等
 * 早退行为锁定），整例 skip 后该锁定随停——拍板 P-r1-2 时需拆分或反转本用例。
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
const UID = 'probe-r5-guard';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r5b-'));
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

describe('probe r5 › purge 幂等早退跳过 requireDeleted 守卫（待议 P-r1-2，拍板前 skip）', () => {
  it.skip('带已应用 reviewDecisionId 的 purge：guard 被跳过、状态未变但版本流被清空', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-p5b');
    const RD = 'rd_probeR5Guard01';
    const SC = 'cand-aa-p5b';
    // 先经一次评审交接动作把 RD 写进 appliedReviewDecisionIds（模拟既有评审已应用）
    await assets.pauseAbilityAsset(UID, 'aa-p5b', { actor: 'system', reason: '评审暂停', reviewDecisionId: RD, sourceCandidateId: SC });
    const paused = await assets.readAbilityAsset(UID, 'aa-p5b');
    expect(paused.status).toBe('paused');
    expect(paused.appliedReviewDecisionIds).toContain(RD);
    expect((await assets.listAbilityAssetVersions(UID, 'aa-p5b')).length).toBeGreaterThan(0);

    // 对照组：不带 rd 的同款清扫 purge 被 requireDeleted 守卫拒绝（guard 本身有效）
    await expect(
      assets.purgeAbilityAsset(UID, 'aa-p5b', { actor: 'system', reason: '清扫' }, { requireDeleted: true }),
    ).rejects.toThrow(/retention purge requires a deleted asset/);

    // 主探针：带已应用 rd → setStatus 幂等早退（guard 跳过）→ 破坏性后续照跑
    const result = await assets.purgeAbilityAsset(
      UID, 'aa-p5b',
      { actor: 'system', reason: '清扫', reviewDecisionId: RD, sourceCandidateId: SC },
      { requireDeleted: true },
    );
    expect(result.status).toBe('paused');   // 状态没变（未清成墓碑）
    expect(result.statement).toContain('陈述'); // 内容没清
    expect(await assets.listAbilityAssetVersions(UID, 'aa-p5b')).toEqual([]); // 版本流却被清空
  });
});
