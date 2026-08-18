/**
 * Phase 1 状态矩阵 + 跨入口一致性。
 *
 * 这套测试的重点不是"字段值对不对"，而是**同一条候选在每个入口拿到的判断
 * 是同一个**：IPC DTO、批量晋升、inbox 待办、待处理计数，四个地方不能各自
 * 解释 raw status。历史上的坏法是"代码在、测试绿、实机坏"，所以固定用接近
 * 实机的分布（多条 confirmed + 多条 weak_observation + 0 条 pending_review）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-candidate-caps-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const caps = async () => import('../../../../src/main/features/recall/candidate-capabilities');
const service = async () => import('../../../../src/main/features/recall/candidate-service');

const ACTIONABLE_STATUSES = ['observed', 'weak_observation', 'pending_review', 'deferred', 'failed'] as const;
const TERMINAL_STATUSES = ['confirmed', 'rejected', 'ignored', 'expired', 'superseded'] as const;
const ALL_STATUSES = [...ACTIONABLE_STATUSES, ...TERMINAL_STATUSES] as const;

describe('Recall candidate capability matrix', () => {
  it('maps every backend status to an explicit product state', async () => {
    const { getRecallCandidateCapabilities } = await caps();
    const matrix = Object.fromEntries(ALL_STATUSES.map((status) => {
      const c = getRecallCandidateCapabilities({ status });
      return [status, [c.displayState, c.canEdit, c.canConfirm, c.canPromote, c.canReject,
        c.canDefer, c.canRetry, c.canBatchSelect, c.needsUserAction, c.countsAsPending,
        c.isSnoozed, c.isTerminal, c.disabledReason ?? '-'].join('|')];
    }));
    expect(matrix).toEqual({
      observed:         'needs_review|true|true|true|true|true|false|true|true|true|false|false|-',
      weak_observation: 'weak_evidence|true|true|true|true|true|false|true|true|true|false|false|-',
      pending_review:   'needs_review|true|true|true|true|true|false|true|true|true|false|false|-',
      deferred:         'deferred|true|true|true|true|true|false|true|true|true|true|false|-',
      failed:           'failed|true|true|true|true|true|true|true|true|true|false|false|-',
      confirmed:        'confirmed|false|false|false|false|false|false|false|false|false|false|true|candidate_confirmed',
      rejected:         'rejected|false|false|false|false|false|false|false|false|false|false|true|candidate_rejected',
      ignored:          'ignored|false|false|false|false|false|false|false|false|false|false|true|candidate_ignored',
      expired:          'expired|false|false|false|false|false|false|false|false|false|false|true|candidate_expired',
      superseded:       'superseded|false|false|false|false|false|false|false|false|false|false|true|candidate_superseded',
    });
  });

  it('never derives needsUserAction and countsAsPending from a raw status guess', async () => {
    const { tryGetRecallCandidateCapabilities } = await caps();
    // 未经 normalize 的旧值不得被当成可操作候选。
    expect(tryGetRecallCandidateCapabilities({ status: 'promoted' })).toBeUndefined();
    expect(tryGetRecallCandidateCapabilities({ status: 'pending' })).toBeUndefined();
    expect(tryGetRecallCandidateCapabilities({ status: 'weak_observation' })?.needsUserAction).toBe(true);
  });

  it('does not claim a weak observation is actionable while it has no evidence', async () => {
    const { getRecallCandidateCapabilities } = await caps();
    // 记录不变量：refs 为空的候选迁不出 weak_observation。UI 说"可处理"就是假话，
    // 而且真让它走一遍会写出读不回来的记录，拖垮整份候选列表。
    const bare = getRecallCandidateCapabilities({ status: 'weak_observation', sourceRefs: [], evidenceRefs: [] });
    expect(bare.canPromote).toBe(false);
    expect(bare.canReject).toBe(false);
    expect(bare.countsAsPending).toBe(false);
    expect(bare.disabledReason).toBe('candidate_evidence_insufficient');
    // 补证据是唯一出路，所以编辑始终开着。
    expect(bare.canEdit).toBe(true);
    expect(bare.displayState).toBe('weak_evidence');

    const withEvidence = getRecallCandidateCapabilities({
      status: 'weak_observation', sourceRefs: [{}], evidenceRefs: [{}],
    });
    expect(withEvidence.canPromote).toBe(true);
    expect(withEvidence.countsAsPending).toBe(true);
    expect(withEvidence.disabledReason).toBeUndefined();

    // 只带其中一个字段的局部 DTO 不应被误判成"没有证据"。
    expect(getRecallCandidateCapabilities({ status: 'weak_observation', evidenceRefs: [{}] }).canPromote).toBe(true);
    // 终态不受证据影响。
    expect(getRecallCandidateCapabilities({ status: 'confirmed', sourceRefs: [], evidenceRefs: [] }).disabledReason)
      .toBe('candidate_confirmed');
  });

  it('keeps high-risk candidates out of batch select but still individually actionable', async () => {
    const { getRecallCandidateCapabilities } = await caps();
    const high = getRecallCandidateCapabilities({ status: 'weak_observation', risk: 'high' });
    expect(high.canPromote).toBe(true);
    expect(high.canBatchSelect).toBe(false);
    expect(high.batchBlockedReason).toBe('candidate_high_risk_needs_single_review');
    expect(high.disabledReason).toBeUndefined();
    expect(getRecallCandidateCapabilities({ status: 'weak_observation', risk: 'medium' }).canBatchSelect).toBe(true);
  });
});

describe('Recall candidate capability — cross-entry consistency', () => {
  /** 接近实机的分布：多条 confirmed、多条 weak_observation、0 条 pending_review。 */
  async function realisticPool(userId = 'u-caps') {
    const candidates = await service();
    const weak = [];
    for (const n of [1, 2, 3]) {
      weak.push(await candidates.saveRecallCandidate(userId, {
        judgment: `弱证据判断 ${n}`,
        suggestedType: 'rule',
        suggestedScope: 'product',
        sourceRefs: [{ kind: 'memory', id: `mem-${n}` }],
        // 数据是完整的，弱的是"证据强度"这个判断本身——这正是实机分布：
        // 候选字段齐全，只是系统还不认为它够格自动进复核。
        evidenceRefs: [{ kind: 'memory', id: `mem-${n}` }],
        // 边界齐全：把 promotion gate（缺边界）和状态门禁分开验，否则测试会
        // 因为另一条 gate 而绿/红，看不出状态判据到底有没有生效。
        applicableWhen: ['产品决策评审时'],
        forbiddenWhen: ['涉及对外承诺时'],
        forceWeakObservation: true,
      }));
    }
    const settled = [];
    for (const n of [4, 5]) {
      const saved = await candidates.saveRecallCandidate(userId, {
        judgment: `已处理判断 ${n}`,
        suggestedType: 'rule',
        suggestedScope: 'product',
        sourceRefs: [{ kind: 'memory', id: `mem-${n}` }],
        evidenceRefs: [{ kind: 'memory', id: `mem-${n}` }],
        forceWeakObservation: true,
      });
      settled.push(await candidates.rejectRecallCandidate(userId, saved.id, 'not useful'));
    }
    return { userId, weak, settled, candidates };
  }

  it('counts weak_observation as pending even with zero pending_review candidates', async () => {
    const { getRecallCandidateCapabilities } = await caps();
    const { userId, candidates } = await realisticPool();
    const pool = await candidates.listRecallCandidates(userId);

    expect(pool.filter((c) => c.status === 'pending_review')).toHaveLength(0);
    // Dashboard / 待我处理 计数的唯一口径。
    const pending = pool.filter((c) => getRecallCandidateCapabilities(c).countsAsPending);
    expect(pending).toHaveLength(3);
    expect(pool.filter((c) => getRecallCandidateCapabilities(c).canBatchSelect)).toHaveLength(3);
  });

  it('feeds the inbox from needsUserAction, not from pending_review', async () => {
    const { buildCognitionInbox } = await import('../../../../src/main/features/recall/formal-assets/inbox');
    const items = buildCognitionInbox({
      assets: [],
      candidates: [
        { id: 'c-weak', status: 'weak_observation', judgment: '证据较弱但可确认', suggestedType: 'rule', evidenceRefs: [{}] },
        { id: 'c-confirmed', status: 'confirmed', judgment: '已确认', suggestedType: 'rule', evidenceRefs: [{}] },
        { id: 'c-rejected', status: 'rejected', judgment: '已拒绝', suggestedType: 'rule', evidenceRefs: [{}] },
      ],
      unavailableSourceIds: new Set(),
    });
    const candidateItems = items.filter((i) => i.kind === 'candidate_pending_review');
    expect(candidateItems.map((i) => i.id)).toEqual(['candidate:c-weak']);
  });

  it('lets batch promote consume canPromote and rejects terminal candidates with a stable code', async () => {
    const { RECALL_CANDIDATE_NOT_PROMOTABLE_ERROR_CODE } = await caps();
    const { userId, weak, settled, candidates } = await realisticPool();

    const result = await candidates.batchPromoteRecallCandidates(userId, [weak[0].id, settled[0].id]);
    // 终态候选被稳定错误码拒绝，而不是"请求成功但什么也没发生"。
    expect(result.failed).toContainEqual({
      candidateId: settled[0].id,
      error: RECALL_CANDIDATE_NOT_PROMOTABLE_ERROR_CODE,
    });
    // weak_observation 不再因为"不是 pending_review"被挡在批量之外。
    expect(result.failed.find((f) => f.candidateId === weak[0].id)?.error)
      .not.toBe(RECALL_CANDIDATE_NOT_PROMOTABLE_ERROR_CODE);
  });

  it('keeps the weak-evidence gate against system actors while letting users decide', async () => {
    const { userId, weak, candidates } = await realisticPool();

    // 系统不得替用户把弱证据候选变成资产。
    await expect(candidates.promoteRecallCandidate(userId, weak[1].id, { actor: 'system' }))
      .rejects.toThrow('candidate evidence is insufficient for review');

    // 用户显式确认后可以沉淀，并且候选进入 confirmed 终态、能力随之收敛。
    const { getRecallCandidateCapabilities } = await caps();
    const promoted = await candidates.promoteRecallCandidate(userId, weak[1].id, { actor: 'user' });
    expect(promoted.asset.id).toBeTruthy();
    expect(promoted.candidate.status).toBe('confirmed');
    const after = getRecallCandidateCapabilities(promoted.candidate);
    expect(after.isTerminal).toBe(true);
    expect(after.canEdit).toBe(false);
    expect(after.canPromote).toBe(false);
    expect(after.disabledReason).toBe('candidate_confirmed');

    // 用户拒绝一条弱候选也不再被证据门禁拦住。
    const rejected = await candidates.rejectRecallCandidate(userId, weak[2].id, '不需要');
    expect(rejected.status).toBe('rejected');
    expect(getRecallCandidateCapabilities(rejected).countsAsPending).toBe(false);
  });

  it('rejects terminal candidate updates with a stable error code', async () => {
    const { RECALL_CANDIDATE_TERMINAL_ERROR_CODE } = await caps();
    const { userId, settled, candidates } = await realisticPool();
    await expect(candidates.updateRecallCandidate(userId, settled[0].id, {
      judgment: '试图改一条已拒绝的候选',
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'memory', id: 'mem-4' }],
    })).rejects.toMatchObject({ code: RECALL_CANDIDATE_TERMINAL_ERROR_CODE });
  });
});

describe('Recall candidate capability — normalize and persistence', () => {
  it('migrates legacy superseded on read and exposes it as read-only', async () => {
    const { getRecallCandidateCapabilities } = await caps();
    const candidates = await service();
    const userId = 'u-legacy';
    const saved = await candidates.saveRecallCandidate(userId, {
      judgment: '旧数据候选',
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'memory', id: 'mem-legacy' }],
      forceWeakObservation: true,
    });

    // 直接把落盘状态改成历史遗留的 superseded，模拟旧版本写下的记录。
    const file = findCandidateFile(tmpDir, saved.id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, status: 'superseded' }));

    const reloaded = await candidates.readRecallCandidate(userId, saved.id);
    expect(reloaded.status).toBe('ignored');
    const capability = getRecallCandidateCapabilities(reloaded);
    expect(capability.isTerminal).toBe(true);
    expect(capability.countsAsPending).toBe(false);
    expect(capability.canPromote).toBe(false);
  });

  it('does not drift after a renderer reload or app restart', async () => {
    const { getRecallCandidateCapabilities } = await caps();
    const candidates = await service();
    const userId = 'u-restart';
    const saved = await candidates.saveRecallCandidate(userId, {
      judgment: '重启后仍应可处理',
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'memory', id: 'mem-restart' }],
      forceWeakObservation: true,
    });
    const before = getRecallCandidateCapabilities(saved);
    expect(before.displayState).toBe('weak_evidence');

    // 重新加载模块 = renderer reload / 应用重启后重新读盘。
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/recall/candidate-service');
    const { getRecallCandidateCapabilities: afterFn } = await caps();
    const reloaded = await restarted.readRecallCandidate(userId, saved.id);
    expect(afterFn(reloaded)).toEqual(before);
  });

  it('ships capabilities as a DTO projection without writing them back to storage', async () => {
    const { getRecallCandidateCapabilities, withRecallCandidateCapabilities } = await caps();
    const candidates = await service();
    const userId = 'u-dto';
    const saved = await candidates.saveRecallCandidate(userId, {
      judgment: 'DTO 投影不落盘',
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'memory', id: 'mem-dto' }],
      forceWeakObservation: true,
    });
    const dto = withRecallCandidateCapabilities(saved);
    expect(dto.capabilities).toEqual(getRecallCandidateCapabilities(saved));

    const stored = JSON.parse(fs.readFileSync(findCandidateFile(tmpDir, saved.id), 'utf8'));
    expect(stored.capabilities).toBeUndefined();
  });

  it('degrades an unrecognized status to read-only instead of failing the read', async () => {
    const { withRecallCandidateCapabilities } = await caps();
    // 一条坏记录不该让整份候选列表读失败——这是历史上"整个沉淀 degraded"的成因。
    const dto = withRecallCandidateCapabilities({ id: 'c-x', status: 'from_the_future' });
    expect(dto.capabilities.displayState).toBe('unknown');
    expect(dto.capabilities.disabledReason).toBe('candidate_state_unknown');
    expect(dto.capabilities.canPromote).toBe(false);
    expect(dto.capabilities.canEdit).toBe(false);
    expect(dto.capabilities.countsAsPending).toBe(false);
  });
});

function findCandidateFile(root: string, candidateId: string): string {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === `${candidateId}.json`) return full;
    }
  }
  throw new Error(`candidate file not found: ${candidateId}`);
}
