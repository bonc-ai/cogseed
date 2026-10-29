import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/**
 * 探针 r2（红队-越权与状态，新一轮 r2）：审批决定的 check-then-act 竞态——
 * 用户「拒绝」的 AI 变更提议被并发「确认」覆盖，内容照样生效。
 *
 * 发现（读码）：decideAssetChangeProposal（asset-approval-service.ts:294-370）的
 * 终态检查（:302 state === 'confirmed' || 'rejected' → 拒绝处置）在**读侧**，
 * 后续 patchProposal（:207-217）的 updater 在锁内**不复核 state**（直接
 * {...raw, ...patch} 覆盖）。confirm 分支先 updateAbilityAsset（多段 IO，链长）、
 * 再 patch state=confirmed；reject 分支只 read+patch（链短）。并发进入时：
 * reject 先完成（state=rejected 落盘）→ confirm 继续跑（不再看 state）→ 内容
 * 生效 + patch confirmed 覆盖 rejected——「已拒绝的变更被应用」，治理动作与
 * 用户意图相反，且审计流同时留下 approval_rejected 与 approval_confirmed
 * 两条矛盾记录。
 * 修法唯一方向：patchProposal 的 updater 锁内复核终态（或把 decide 的状态机
 * 迁入单锁段），本探针锁定现状（竞态可稳定复现）。
 * 风格对齐 probe-r1-purge-tombstone-residue.test.ts（同域探针）。
 *
 * 收尾状态（2026-10-01 记账员）：对应待议 **P-r2-2（拍板：锁内 CAS+补偿回滚）**——
 * 主用例已随修复启用（断言反转：恰一个决定生效、被拒内容不留资产、审计不矛盾）；
 * 本探针为上遍遗留、本轮甄别去重组 2 并入同一待议项。
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
const UID = 'probe-r2-ap';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2ap-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACT = { actor: 'user' as const, reason: 'probe' };

const APPROVED_STATEMENT = 'APPROVAL_RACE_改后正文：所有对外输出先走审阅队列';

describe('probe r2 › 审批决定 check-then-act 竞态', () => {
  it('【P-r2-2 已修】并发 confirm+reject：恰有一个决定生效，被拒绝的变更不留在资产上', async () => {
    const { createAbilityAsset, readAbilityAsset } = await import('../../src/main/features/recall/asset-service');
    const {
      createAssetChangeProposal,
      decideAssetChangeProposal,
      readAssetChangeProposal,
    } = await import('../../src/main/features/recall/asset-approval-service');
    const { listRecallJsonlRecords } = await import('../../src/main/features/recall/store');

    const id = 'aa-ap-race';
    const now = new Date().toISOString();
    await seedStoredAbilityAsset(UID, {
      schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
      sourceCandidateIds: [`cand-${id}`], reviewDecisionId: 'rd_probeapract',
      type: 'personal', title: '演示资产', statement: '改前正文',
      evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general',
      status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud',
      version: '1', createdAt: now, updatedAt: now,
    }, ACT);

    const { proposal } = await createAssetChangeProposal(UID, {
      assetId: id,
      reason: 'AI 提议收紧输出纪律',
      baselineVersion: '1',
      before: '改前正文',
      after: APPROVED_STATEMENT,
      fields: ['statement'],
      payload: { statement: APPROVED_STATEMENT },
    });
    expect(proposal.state).toBe('pending');

    // 并发两个相反决定：reject 链短几乎必先完成（state=rejected），confirm
    // 链长后到——修复后靠锁内 CAS（写前复核 + patch 迁移复核）保证只有一个生效。
    const [confirmResult, rejectResult] = await Promise.all([
      decideAssetChangeProposal(UID, proposal.id, 'confirm'),
      decideAssetChangeProposal(UID, proposal.id, 'reject'),
    ]);

    // 恰有一个决定成功：两个都 ok=true（旧漏洞的「双成功」）不允许再出现。
    const wins = [confirmResult.ok, rejectResult.ok].filter(Boolean).length;
    expect(wins).toBe(1);

    // 提议终态与赢家一致，不存在「rejected 被 confirmed 覆盖」的翻转。
    const finalProposal = await readAssetChangeProposal(UID, proposal.id);
    expect(['confirmed', 'rejected']).toContain(finalProposal?.state);
    const winner = finalProposal?.state === 'confirmed' ? confirmResult : rejectResult;
    expect(winner.ok).toBe(true);

    // 被拒绝的内容不留在资产上：reject 赢时正文保持原值（即便 confirm 的资产
    // 写入曾短暂生效，也会被补偿回滚到提议前的取值）。
    const asset = await readAbilityAsset(UID, id);
    if (finalProposal?.state === 'rejected') {
      expect(asset.statement).toBe('改前正文');
    } else {
      expect(asset.statement).toBe(APPROVED_STATEMENT);
    }

    // 审计不再出现「拒绝后被确认覆盖生效」的矛盾对：approval_confirmed 若与
    // approval_rejected 并存，confirmed 那行必须写明是冲突回执/回滚，不是生效。
    const audit = await listRecallJsonlRecords(UID, 'ability-asset-audit', id, 0);
    const rows = audit as unknown as Array<{ action?: string; reason?: string }>;
    if (rows.some((row) => row.action === 'approval_rejected')) {
      const confirmedRows = rows.filter((row) => row.action === 'approval_confirmed');
      for (const row of confirmedRows) {
        expect(String(row.reason || '')).toContain('回滚');
      }
    }
  });
});
