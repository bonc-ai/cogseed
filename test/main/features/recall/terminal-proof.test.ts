import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['reviewing governed work'], forbiddenWhen: ['outside the review scope'] };
beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-terminal-proof-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});
afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, refs, projection, terminalProof, storage, layout, proofs, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/terminal-proof'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
    import('../../../../src/main/features/recall/proof-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, refs, projection, terminalProof, storage, layout, proofs, assets };
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

async function confirmedProjection(taskRunId: string) {
  const { candidates, refs, projection } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: 'Use confirmed evidence in task reviews.',
    summary: 'Use confirmed evidence',
    suggestedType: 'rule',
    ...RULE_BOUNDARY,
    suggestedScope: 'review',
    sourceRefs: [{ kind: 'execution', id: `exec-${taskRunId}` }],
  });
  const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
  await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection('user-a', {
    taskRunId, workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed',
  });
  return { asset, projection: await projection.confirmContextProjection('user-a', preview.id) };
}

async function attachCard(cid: string, projectionId: string) {
  const { storage, layout } = await modules();
  const file = layout.conversationMessageFile('user-a', cid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await storage.appendJsonlAtomic(file, {
    id: `msg-${projectionId}`, ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'preview',
    recall_projection_card: { projectionId },
  });
}

describe('Recall terminal transfer proof handler', () => {
  it('completes one transfer proof for a completed task and is idempotent on duplicate terminal events', async () => {
    const { projection } = await confirmedProjection('run-a');
    const { terminalProof, proofs, assets } = await modules();
    const event = { run_id: 'run-a', user_id: 'user-a', conversation_id: 'cid-a', status: 'completed' as const, projection_id: projection.id, started_at_ms: 1, finished_at_ms: 2 };

    const first = await terminalProof.handleRecallTaskTerminal(event);
    const second = await terminalProof.handleRecallTaskTerminal(event);

    expect(first).toMatchObject({ handled: true, proof: { projectionId: projection.id, executionId: 'run-a', status: 'succeeded' } });
    expect(second).toMatchObject({ handled: true, proof: { id: first.proof?.id, status: 'succeeded' } });
    expect((await proofs.listTransferProofs('user-a'))).toHaveLength(1);
    // PRD 3.6：Transfer Verified 要求真实加载 + 生成 Receipt。任务跑完但没有
    // 回执时，只证明了"这次运行结束了"，不证明资产被正确带入——不升档。
    expect((await assets.listAbilityAssets('user-a'))[0].maturity).not.toBe('transfer_validated');
  });

  it('advances maturity only when a reuse receipt proves the assets were loaded', async () => {
    const { asset, projection } = await confirmedProjection('run-receipt');
    const { terminalProof, proofs, assets } = await modules();
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');

    // 本次运行真实落过的回执：executionId 是 `turn-<turnId>`，与 execution-records
    // 同名；reusedRefs 记的是"本轮真的注入了哪几条"。
    const targetSessionId = 'gmember-cid-a-agent-a';
    await receipts.prepareReceipt('user-a', {
      executionId: 'turn-t1',
      targetSessionId,
      reusedRefs: [asset.id],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:inherited'],
      boundary: 'real',
    }, { sessionId: targetSessionId });

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-receipt',
      user_id: 'user-a',
      conversation_id: 'cid-a',
      status: 'completed' as const,
      projection_id: projection.id,
      // 显式一一关联：终态事件带上本次运行落过回执的轮次，不靠时间窗反查。
      reuse_turn_ids: ['t1'],
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    expect(result).toMatchObject({ handled: true, proof: { status: 'succeeded', receiptId: expect.any(String), receiptExecutionId: 'turn-t1' } });
    const advanced = (await assets.listAbilityAssets('user-a')).find((a) => a.id === asset.id);
    expect(advanced?.maturity).toBe('transfer_validated');
    expect((await proofs.listTransferProofs('user-a')).some((p) => p.receiptId)).toBe(true);
  });

  /**
   * 回合收尾会把回执从 prepared 收成终态（bus.ts 的 completeReceipt）。
   * 这条钉住终态回执仍然构成升档证据——否则"让回执真正闭合"这件事本身会
   * 把升档链打断，那比停在 prepared 更糟。
   *
   * 三种终态的语义分工：
   *   completed  回合正常收尾 → 算数
   *   degraded   回合被中断/报错，但注入确实发生过 → 仍算数
   *   rejected   这次复用被拒绝/无效 → 不算数（bus 不会写它，这里守住下游语义）
   */
  it.each([
    ['completed', true],
    ['degraded', true],
    ['rejected', false],
  ] as const)('treats a %s receipt as loading evidence: %s', async (status, shouldAdvance) => {
    const { asset, projection } = await confirmedProjection(`run-${status}`);
    const { terminalProof, assets } = await modules();
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');

    const targetSessionId = 'gconv-cid-a';
    await receipts.prepareReceipt('user-a', {
      executionId: `turn-${status}`,
      targetSessionId,
      reusedRefs: [asset.id],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:projection'],
      boundary: 'real',
    }, { sessionId: targetSessionId });
    // 回合收尾做的就是这一步。
    await receipts.completeReceipt('user-a', `turn-${status}`, { status });

    await terminalProof.handleRecallTaskTerminal({
      run_id: `run-${status}`,
      user_id: 'user-a',
      conversation_id: 'cid-a',
      status: 'completed' as const,
      projection_id: projection.id,
      reuse_turn_ids: [status],
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    const advanced = (await assets.listAbilityAssets('user-a')).find((a) => a.id === asset.id);
    expect(advanced?.maturity === 'transfer_validated').toBe(shouldAdvance);
  });

  it('advances receipt-covered assets even when they differ from the committed projection (receipt-first)', async () => {
    const { asset, projection } = await confirmedProjection('run-receipt-first');
    const { candidates } = await modules();
    // 另一条真实资产：本次运行真的注入了它，但它不在提交投影的冻结清单里。
    const other = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Live-loaded asset outside the committed projection.',
      summary: 'Live-loaded asset',
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'exec-run-receipt-first' }],
    });
    const { asset: otherAsset } = await candidates.promoteRecallCandidate('user-a', other.id, { actor: 'user' });
    const { terminalProof, assets } = await modules();
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    const targetSessionId = 'gconv-cid-a';
    // 回执只覆盖 otherAsset——提交投影里的 asset 本轮并未被注入。
    await receipts.prepareReceipt('user-a', {
      executionId: 'turn-t-receipt-first',
      targetSessionId,
      reusedRefs: [otherAsset.id],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:projection'],
      boundary: 'real',
    }, { sessionId: targetSessionId });

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-receipt-first',
      user_id: 'user-a',
      conversation_id: 'cid-a',
      status: 'completed' as const,
      projection_id: projection.id,
      reuse_turn_ids: ['t-receipt-first'],
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    expect(result).toMatchObject({ handled: true, proof: { status: 'succeeded' } });
    expect(result.handled && result.proof.receiptId).toBeTruthy();
    // 以回执为准：真实加载并生成回执的资产升档……
    const advanced = (await assets.listAbilityAssets('user-a')).find((a) => a.id === otherAsset.id);
    expect(advanced?.maturity).toBe('transfer_validated');
    // ……提交投影里本轮没被加载的资产不升档（投影只是治理记录，不是证明锚点）。
    const untouched = (await assets.listAbilityAssets('user-a')).find((a) => a.id === asset.id);
    expect(untouched?.maturity).not.toBe('transfer_validated');
  });

  it('advances maturity when multiple receipts jointly cover the projected assets (union, not single-receipt full cover)', async () => {
    // B4 回归场景：多回合任务每回合注入不同资产 → 回执分散。chen 版要求单张
    // 回执覆盖全部 assetVersions → 永不升档。并集判定：全部资产被任一回执
    // 覆盖即算迁移证明成立。
    const { asset, projection } = await confirmedProjection('run-union-receipts');
    const { candidates } = await modules();
    const other = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Second asset injected in a later turn of the same run.',
      summary: 'Second asset',
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'exec-run-union-receipts' }],
    });
    const { asset: otherAsset } = await candidates.promoteRecallCandidate('user-a', other.id, { actor: 'user' });
    const { terminalProof, assets, proofs } = await modules();
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    // 回合 1 只注入 asset；回合 2 只注入 otherAsset——两张回执各覆盖一半。
    await receipts.prepareReceipt('user-a', {
      executionId: 'turn-union-1', targetSessionId: 'gconv-cid-union',
      reusedRefs: [asset.id], omittedRefs: [],
      permissionMode: 'read-only', allowedScopes: ['cognition:projection'], boundary: 'real',
    }, { sessionId: 'gconv-cid-union' });
    await receipts.prepareReceipt('user-a', {
      executionId: 'turn-union-2', targetSessionId: 'gconv-cid-union',
      reusedRefs: [otherAsset.id], omittedRefs: [],
      permissionMode: 'read-only', allowedScopes: ['cognition:projection'], boundary: 'real',
    }, { sessionId: 'gconv-cid-union' });

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-union-receipts', user_id: 'user-a', conversation_id: 'cid-union',
      status: 'completed' as const, projection_id: projection.id,
      reuse_turn_ids: ['union-1', 'union-2'],
      started_at_ms: 1, finished_at_ms: 2,
    });

    expect(result).toMatchObject({ handled: true, proof: { status: 'succeeded', receiptId: expect.any(String) } });
    const assetsList = await assets.listAbilityAssets('user-a');
    expect(assetsList.find((a) => a.id === asset.id)?.maturity).toBe('transfer_validated');
    expect(assetsList.find((a) => a.id === otherAsset.id)?.maturity).toBe('transfer_validated');
    expect((await proofs.listTransferProofs('user-a')).some((p) => p.receiptId)).toBe(true);
  });

  it('ignores a receipt that covers no existing asset', async () => {
    const { asset, projection } = await confirmedProjection('run-unrelated');
    const { terminalProof, assets } = await modules();
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    const targetSessionId = 'gmember-cid-a-agent-b';
    await receipts.prepareReceipt('user-a', {
      executionId: 'turn-t2',
      targetSessionId,
      reusedRefs: ['aa-some-other-asset'],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:inherited'],
      boundary: 'real',
    }, { sessionId: targetSessionId });

    await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-unrelated',
      user_id: 'user-a',
      conversation_id: 'cid-a',
      status: 'completed' as const,
      projection_id: projection.id,
      reuse_turn_ids: ['t2'],
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    const untouched = (await assets.listAbilityAssets('user-a')).find((a) => a.id === asset.id);
    expect(untouched?.maturity).not.toBe('transfer_validated');
  });


  it('completes a CogSeed-shaped terminal event through the shared notification source', async () => {
    const { projection } = await confirmedProjection('cogseed-run-a');
    await attachCard('cogseed-cid-a', projection.id);
    const { proofs } = await modules();
    const source = await import('../../../../src/main/features/task_notification_terminal_source');
    const bridge = await import('../../../../src/main/features/group_chat/recall-terminal-proof');
    const stop = bridge.startGroupChatRecallTerminalProofs();
    try {
      source.publishTaskNotificationTerminal({
        run_id: 'cogseed-run-a',
        user_id: 'user-a',
        conversation_id: 'cogseed-cid-a',
        status: 'completed',
        started_at_ms: 10,
        finished_at_ms: 20,
      });

      await eventually(async () => {
        await expect(proofs.listTransferProofs('user-a')).resolves.toEqual([
          expect.objectContaining({ projectionId: projection.id, executionId: 'cogseed-run-a', status: 'succeeded' }),
        ]);
      });
    } finally {
      stop();
    }
  });
  it('uses explicit Mate projection and attempt metadata without requiring a projection card message', async () => {
    const { projection } = await confirmedProjection('logical-run-a');
    const { terminalProof, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'logical-run-a',
      user_id: 'user-a',
      conversation_id: 'cogseed-cid-a',
      status: 'completed',
      started_at_ms: 1,
      finished_at_ms: 2,
      projection_id: projection.id,
      logical_run_id: 'logical-run-a',
      execution_id: 'cogseed-attempt-a',
    });

    expect(result).toMatchObject({ handled: true, proof: { projectionId: projection.id, executionId: 'cogseed-attempt-a', status: 'succeeded' } });
    expect(await proofs.listTransferProofs('user-a')).toEqual([
      expect.objectContaining({ projectionId: projection.id, executionId: 'cogseed-attempt-a' }),
    ]);
  });

  it('persists a wake request id when terminal proof is attached to a confirmed projection', async () => {
    const { projection } = await confirmedProjection('run-wake-binding');
    const { terminalProof, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-wake-binding',
      user_id: 'user-a',
      conversation_id: 'cid-wake-binding',
      status: 'completed',
      started_at_ms: 1,
      finished_at_ms: 2,
      projection_id: projection.id,
      wake_request_id: 'wake-a',
    });

    expect(result).toMatchObject({ handled: true, proof: { projectionId: projection.id, wakeRequestId: 'wake-a' } });
    expect(await proofs.listTransferProofs('user-a')).toEqual([
      expect.objectContaining({ projectionId: projection.id, wakeRequestId: 'wake-a' }),
    ]);
  });

  it('ignores explicit Mate proof metadata when the logical run does not match the projection', async () => {
    const { projection } = await confirmedProjection('logical-run-b');
    const { terminalProof, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'wrong-run',
      user_id: 'user-a',
      conversation_id: 'cogseed-cid-b',
      status: 'completed',
      started_at_ms: 1,
      finished_at_ms: 2,
      projection_id: projection.id,
      logical_run_id: 'wrong-run',
      execution_id: 'cogseed-attempt-b',
    });

    expect(result).toEqual({ handled: false, reason: 'no_confirmed_projection' });
    expect(await proofs.listTransferProofs('user-a')).toEqual([]);
  });

  it('records a rejected transfer without advancing maturity when the task fails', async () => {
    const { projection, asset } = await confirmedProjection('run-failed');
    const { terminalProof, assets, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-failed', user_id: 'user-a', conversation_id: 'cid-failed', status: 'failed', projection_id: projection.id, started_at_ms: 1, finished_at_ms: 2,
    });

    expect(result).toMatchObject({ handled: true, proof: { status: 'rejected', executionId: 'run-failed' } });
    // 被拒的迁移不推进成熟度：起点 bud 就该还是 bud。
    expect((await assets.readAbilityAsset('user-a', asset.id)).maturity).toBe('bud');
    expect((await proofs.listTransferProofs('user-a'))[0].status).toBe('rejected');
  });

  it('ignores terminal events with no confirmed projection card', async () => {
    const { terminalProof, proofs } = await modules();
    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-none', user_id: 'user-a', conversation_id: 'cid-none', status: 'completed', started_at_ms: 1, finished_at_ms: 2,
    });
    expect(result).toEqual({ handled: false, reason: 'no_confirmed_projection' });
    expect(await proofs.listTransferProofs('user-a')).toEqual([]);
  });

});
