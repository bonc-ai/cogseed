import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * group 入口（startGroupChatRecallTerminalProofs）的投影发现测试。
 * T2.3（2026-09-13）：普通会话（无 KSTAR requirement）终态事件不带
 * projection_id，旧兜底只扫消息里的手工投影卡——自动投影（proj-auto-*）
 * 从不发卡，注入了资产也永远进不了证明链。新兜底按 reuse_turn_ids 反查
 * 「confirmed、未过期、taskRunId=该 turn」的投影。
 */

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-group-recall-terminal-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const RULE_BOUNDARY = { applicableWhen: ['reviewing governed work'], forbiddenWhen: ['outside the review scope'] };

async function confirmedTurnProjection(userId: string, turnId: string) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const projection = await import('../../../../src/main/features/recall/context-projection');
  const candidate = await createNightlyCandidateFixture(userId, {
    judgment: 'Use confirmed evidence in task reviews.',
    summary: 'Confirmed evidence habit',
    suggestedType: 'rule',
    ...RULE_BOUNDARY,
    suggestedScope: 'review',
    sourceRefs: [{ kind: 'execution', id: `exec-${turnId}` }],
  });
  const promoted = await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
  const preview = await projection.previewContextProjection(userId, {
    taskRunId: turnId, workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed',
  });
  const confirmed = await projection.confirmContextProjection(userId, preview.id);
  return { asset: promoted.asset, projection: confirmed };
}

describe('group-chat recall terminal proof entry', () => {
  it('discovers turn-level projections from reuse_turn_ids when the event has no projection_id (T2.3)', async () => {
    const userId = 'user-gtp';
    const turnId = 'tx-group-1';
    const { asset } = await confirmedTurnProjection(userId, turnId);
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await receipts.prepareReceipt(userId, {
      executionId: `turn-${turnId}`,
      targetSessionId: 'gconv-cid-gtp',
      reusedRefs: [asset.id],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:projection'],
      boundary: 'real',
    }, { sessionId: 'gconv-cid-gtp' });

    const entry = await import('../../../../src/main/features/group_chat/recall-terminal-proof');
    let deliver: ((event: unknown) => void) | undefined;
    const stop = entry.startGroupChatRecallTerminalProofs(
      (listener) => {
        deliver = (event) => listener(event as never);
        return () => { deliver = undefined; };
      },
      async () => [],
    );
    try {
      expect(deliver).toBeTypeOf('function');
      deliver!({
        run_id: 'run-gtp-1',
        user_id: userId,
        conversation_id: 'cid-gtp',
        status: 'completed',
        started_at_ms: 1,
        finished_at_ms: 2,
        logical_run_id: 'run-gtp-1',
        reuse_turn_ids: [turnId],
      });

      const proofs = await import('../../../../src/main/features/recall/proof-service');
      const assets = await import('../../../../src/main/features/recall/asset-service');
      // Proof success is persisted before the asset and receipt updates. Wait for
      // all terminal outcomes before asserting completion and removing test data.
      await vi.waitFor(async () => {
        const list = await proofs.listTransferProofs(userId);
        expect(list.some((proof) => proof.status === 'succeeded' && proof.receiptId)).toBe(true);
        expect((await assets.readAbilityAsset(userId, asset.id)).maturity).toBe('transfer_validated');
        expect((await receipts.readReceipt(userId, `turn-${turnId}`)).status).toBe('completed');
      }, { timeout: 5_000 });
    } finally {
      stop();
    }
  });

  it('still discovers the target turn projection when confirmed projections exceed the default list clamp (F-r1-24)', async () => {
    const userId = 'user-gtp-clamp';
    const turnId = 'tx-group-clamp';
    // 目标 turn 投影最先创建（createdAt 最早）；projectionNowIso 单调递增，
    // 之后的 filler 在降序排序里全部排在它前面。
    const { asset } = await confirmedTurnProjection(userId, turnId);
    const projection = await import('../../../../src/main/features/recall/context-projection');
    // 20 条更新的 confirmed 投影把目标挤到 listContextProjections 默认
    // clamp（limit=20）之外：修复前终局反查用该默认列表，注入过资产的
    // 这轮进不了证明链（实机零证明回归）。
    for (let i = 0; i < 20; i += 1) {
      await projection.previewContextProjection(userId, {
        taskRunId: `tx-filler-${i}`, workspaceId: 'workspace-a', purpose: 'review',
        authorization: 'user_confirmed', explicitAssetIds: [asset.id], confirm: true,
      });
    }
    // 夹具自检：目标投影确实落在默认 clamp 的输入池之外。
    const clamped = await projection.listContextProjections(userId);
    expect(clamped).toHaveLength(20);
    expect(clamped.some((item) => item.taskRunId === turnId)).toBe(false);

    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await receipts.prepareReceipt(userId, {
      executionId: `turn-${turnId}`,
      targetSessionId: 'gconv-cid-clamp',
      reusedRefs: [asset.id],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:projection'],
      boundary: 'real',
    }, { sessionId: 'gconv-cid-clamp' });

    const entry = await import('../../../../src/main/features/group_chat/recall-terminal-proof');
    let deliver: ((event: unknown) => void) | undefined;
    const stop = entry.startGroupChatRecallTerminalProofs(
      (listener) => {
        deliver = (event) => listener(event as never);
        return () => { deliver = undefined; };
      },
      async () => [],
    );
    try {
      expect(deliver).toBeTypeOf('function');
      deliver!({
        run_id: 'run-gtp-clamp',
        user_id: userId,
        conversation_id: 'cid-clamp',
        status: 'completed',
        started_at_ms: 1,
        finished_at_ms: 2,
        logical_run_id: 'run-gtp-clamp',
        reuse_turn_ids: [turnId],
      });

      const proofs = await import('../../../../src/main/features/recall/proof-service');
      const assets = await import('../../../../src/main/features/recall/asset-service');
      await vi.waitFor(async () => {
        const list = await proofs.listTransferProofs(userId);
        expect(list.some((proof) => proof.status === 'succeeded' && proof.receiptId)).toBe(true);
        expect((await assets.readAbilityAsset(userId, asset.id)).maturity).toBe('transfer_validated');
      }, { timeout: 5_000 });
    } finally {
      stop();
    }
  });

  it('still ignores terminals with neither a projection id nor reusable turns', async () => {
    const entry = await import('../../../../src/main/features/group_chat/recall-terminal-proof');
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    let deliver: ((event: unknown) => void) | undefined;
    const stop = entry.startGroupChatRecallTerminalProofs(
      (listener) => {
        deliver = (event) => listener(event as never);
        return () => { deliver = undefined; };
      },
      async () => [],
    );
    try {
      deliver!({
        run_id: 'run-gtp-empty', user_id: 'user-gtp2', conversation_id: 'cid-gtp2',
        status: 'completed', started_at_ms: 1, finished_at_ms: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await proofs.listTransferProofs('user-gtp2')).toEqual([]);
    } finally {
      stop();
    }
  });
});
