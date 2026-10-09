/**
 * 复用回执闭环：注入 → 回执 → reuse turn id → 终态证明绑定 → 资产可升档。
 *
 * 起因是实机观测：`proj-auto-*` 显示资产真实注入过 26 次，而回执只有 4 张，
 * 23 条迁移证明里 19 条 `receiptId: null` / `assetVersions: []`，于是
 * `evaluateEffectivenessProof` 一律 `E_RECALL_TRANSFER_RECEIPT_MISSING`，
 * 「已验证资产」恒为 0。断点有两处，本文件各钉一条：
 *
 *  1. CogSeed Runtime 那条注入路径**从不落回执**（全仓 prepareReceipt 调用方
 *     只在 group_chat/bus.ts）。注入发生了却没有加载凭证。
 *  2. 同路径的终态事件（cogseed_backend/recall-bridge）**不传 reuse_turn_ids**，
 *     即使有回执也绑不上。
 *
 * 关键约束（也是这几条用例真正在守的东西）：回执只在**确实注入了资产**时产生，
 * 没有注入就必须保持空——不能为了让链路变绿而伪造加载事实。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmp: string;
let previous: string | undefined;
const USER = 'user-reuse';
const CID = 'cid-reuse';

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-reuse-receipt-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function mods() {
  const [candidates, assets, refs, projection, runtimeContext, receipts, terminalProof, proofs, storage, layout] =
    await Promise.all([
      import('../../../../src/main/features/recall/candidate-service'),
      import('../../../../src/main/features/recall/asset-service'),
      import('../../../../src/main/features/recall/workspace-refs'),
      import('../../../../src/main/features/recall/context-projection'),
      import('../../../../src/main/features/cogseed_backend/runtime-asset-context'),
      import('../../../../src/main/features/p3394/context-reuse-receipt'),
      import('../../../../src/main/features/recall/terminal-proof'),
      import('../../../../src/main/features/recall/proof-service'),
      import('../../../../src/main/storage'),
      import('../../../../src/main/util/project-layout'),
    ]);
  return { candidates, assets, refs, projection, runtimeContext, receipts, terminalProof, proofs, storage, layout };
}

async function bindProjection(projectionId: string, messageId: string) {
  const { storage, layout } = await mods();
  const file = layout.conversationMessageFile(USER, CID);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await storage.appendJsonlAtomic(file, {
    id: messageId, ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'projection',
    recall_projection_card: { projectionId },
  });
}

/** 一条正式资产。手动已确认投影不按成熟度收口（那道闸只管自动静默注入），
 *  所以这里保留 promote 后的原始成熟度，终态用例才能真正验证「升档」发生了。 */
async function injectableAsset(seed: string, maturity?: 'transfer_validated') {
  const { candidates, assets } = await mods();
  const saved = await candidates.saveRecallCandidate(USER, {
    judgment: `改运行时边界前先写决策日志（${seed}）`,
    value: '让后续评审不必重建上下文',
    summary: '架构变更前先写决策日志',
    suggestedType: 'rule',
    suggestedScope: 'review,project',
    suggestedAction: 'create',
    spaceId: 'workspace-a',
    sourceRefs: [{ kind: 'execution', id: `exec-${seed}` }],
    evidenceRefs: [{ kind: 'execution', id: `exec-${seed}` }],
    applicableWhen: ['架构评审与运行时边界变更时'],
    forbiddenWhen: ['没有决定的头脑风暴'],
  });
  const promoted = await candidates.promoteRecallCandidate(USER, saved.id, { actor: 'user' });
  if (maturity) await assets.setAbilityAssetMaturity(USER, promoted.asset.id, maturity);
  return promoted.asset;
}

async function confirmedProjectionFor(assetId: string, taskRunId: string, messageId: string) {
  const { refs, projection } = await mods();
  await refs.addWorkspaceAssetReference(USER, { assetId, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection(USER, {
    taskRunId, workspaceId: 'workspace-a', purpose: 'review',
  });
  const confirmed = await projection.confirmContextProjection(USER, preview.id);
  await bindProjection(confirmed.id, messageId);
  return confirmed;
}

describe('CogSeed Runtime 注入侧落回执', () => {
  it('真的注入了资产时，按 turn-<taskId> 落回执，refs 是真实资产 id', async () => {
    const { runtimeContext, receipts } = await mods();
    const asset = await injectableAsset('a1');
    await confirmedProjectionFor(asset.id, 'task-run-a1', 'msg-a1');

    const items = await runtimeContext.buildRuntimeAssetContext(USER, CID, 'cogseed-task-a1');
    expect(items.length).toBe(1);

    const receipt = await receipts.readReceipt(USER, 'turn-cogseed-task-a1');
    expect(receipt.reusedRefs).toContain(asset.id);
    expect(receipt.boundary).toBe('real');
  });

  it('没有已确认投影（= 没有注入）时不落回执，也不返回内容——不伪造加载事实', async () => {
    const { runtimeContext, receipts } = await mods();
    const items = await runtimeContext.buildRuntimeAssetContext(USER, CID, 'cogseed-task-empty');
    expect(items).toEqual([]);
    await expect(receipts.readReceipt(USER, 'turn-cogseed-task-empty')).rejects.toThrow();
  });

  it('不带 taskId 调用时只装配上下文、不落回执（回执必须能被终态回指）', async () => {
    const { runtimeContext, receipts } = await mods();
    const asset = await injectableAsset('a3');
    await confirmedProjectionFor(asset.id, 'task-run-a3', 'msg-a3');

    const items = await runtimeContext.buildRuntimeAssetContext(USER, CID);
    expect(items.length).toBe(1);
    await expect(receipts.readReceipt(USER, 'turn-undefined')).rejects.toThrow();
  });
});

describe('终态证明按 reuse turn id 绑定回执', () => {
  it('注入过的任务：证明拿到 receiptId 且 assetVersions 非空，资产升到 transfer_validated', async () => {
    const { runtimeContext, terminalProof, proofs, assets } = await mods();
    const asset = await injectableAsset('b1');
    const projection = await confirmedProjectionFor(asset.id, 'task-run-b1', 'msg-b1');
    const before = (await assets.listAbilityAssets(USER)).find((a) => a.id === asset.id);
    expect(before?.maturity).not.toBe('transfer_validated');

    await runtimeContext.buildRuntimeAssetContext(USER, CID, 'cogseed-task-b1');

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'cogseed-task-b1',
      user_id: USER,
      conversation_id: CID,
      status: 'completed',
      projection_id: projection.id,
      logical_run_id: 'task-run-b1',
      execution_id: 'cogseed-exec-b1',
      reuse_turn_ids: ['cogseed-task-b1'],
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    expect(result.handled).toBe(true);
    const proof = (await proofs.listTransferProofs(USER)).find((p) => p.executionId === 'cogseed-exec-b1');
    expect(proof?.receiptId).toBeTruthy();
    expect(proof?.assetVersions.map((a) => a.assetId)).toContain(asset.id);
    const advanced = (await assets.listAbilityAssets(USER)).find((a) => a.id === asset.id);
    expect(advanced?.maturity).toBe('transfer_validated');
  });

  it('没有注入过的任务：reuse_turn_ids 为空 → 证明不带 receiptId，资产不升档', async () => {
    const { terminalProof, proofs, assets } = await mods();
    const asset = await injectableAsset('b2');
    const projection = await confirmedProjectionFor(asset.id, 'task-run-b2', 'msg-b2');

    await terminalProof.handleRecallTaskTerminal({
      run_id: 'cogseed-task-b2',
      user_id: USER,
      conversation_id: CID,
      status: 'completed',
      projection_id: projection.id,
      logical_run_id: 'task-run-b2',
      execution_id: 'cogseed-exec-b2',
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    const proof = (await proofs.listTransferProofs(USER)).find((p) => p.executionId === 'cogseed-exec-b2');
    expect(proof?.receiptId).toBeUndefined();
    const still = (await assets.listAbilityAssets(USER)).find((a) => a.id === asset.id);
    expect(still?.maturity).not.toBe('transfer_validated');
  });

  /**
   * 实机 21/23 条迁移证明就是这个形状：锚投影是任务级的、assetIds 为空
   * （KSTAR lifecycle 的 committed projection），真实注入的资产住在按回合
   * 生成的 proj-auto-* 上。「以回执为准」的设计允许空投影当治理锚——资产事实
   * 由回执覆盖。此前缺的是回执本身，补上之后这条形状必须能走通，否则那 26 条
   * 有资产的自动投影仍然一条都升不了档。
   */
  it('锚投影 assetIds 为空时，资产事实仍由回执覆盖，证明照样升档', async () => {
    const { runtimeContext, terminalProof, proofs, assets, projection } = await mods();
    const asset = await injectableAsset('d1');
    // 注入侧：绑定到会话的已确认投影带着真实资产，回执据此产生。
    await confirmedProjectionFor(asset.id, 'task-run-d1', 'msg-d1');
    await runtimeContext.buildRuntimeAssetContext(USER, CID, 'cogseed-task-d1');

    // 锚投影：另建一条**不含任何资产**的已确认投影，模拟任务级 committed projection。
    // 用任务类型词把资产筛掉：资产 scope='review,project' 不含 'unrelated-topic'，
    // 也不含 * / general / space，scopeAppliesToPurpose 因此排除它。换 workspace
    // 没用——资产池是全局共享的。
    const emptyPreview = await projection.previewContextProjection(USER, {
      taskRunId: 'task-run-d1-anchor', workspaceId: 'workspace-a', purpose: 'unrelated-topic',
    });
    const anchor = await projection.confirmContextProjection(USER, emptyPreview.id);
    expect(anchor.assetIds).toEqual([]);

    await terminalProof.handleRecallTaskTerminal({
      run_id: 'cogseed-task-d1',
      user_id: USER,
      conversation_id: CID,
      status: 'completed',
      projection_id: anchor.id,
      logical_run_id: 'task-run-d1-anchor',
      execution_id: 'cogseed-exec-d1',
      reuse_turn_ids: ['cogseed-task-d1'],
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    const proof = (await proofs.listTransferProofs(USER)).find((p) => p.executionId === 'cogseed-exec-d1');
    expect(proof?.receiptId).toBeTruthy();
    expect(proof?.assetVersions.map((a) => a.assetId)).toContain(asset.id);
    const advanced = (await assets.listAbilityAssets(USER)).find((a) => a.id === asset.id);
    expect(advanced?.maturity).toBe('transfer_validated');
  });

  it('存在多张回执时，只认本任务那张（别的任务的回执不混进来）', async () => {
    const { runtimeContext, terminalProof, proofs } = await mods();
    const own = await injectableAsset('c1');
    const projection = await confirmedProjectionFor(own.id, 'task-run-c1', 'msg-c1');
    await runtimeContext.buildRuntimeAssetContext(USER, CID, 'cogseed-task-c1');

    // 另一条任务的回执：同一用户、同一会话，但 turn key 不同。
    const { receipts } = await mods();
    await receipts.prepareReceipt(USER, {
      executionId: 'turn-cogseed-task-other',
      targetSessionId: CID,
      reusedRefs: ['aa-not-in-this-task'],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:projection'],
      boundary: 'real',
    }, { sessionId: CID });

    await terminalProof.handleRecallTaskTerminal({
      run_id: 'cogseed-task-c1',
      user_id: USER,
      conversation_id: CID,
      status: 'completed',
      projection_id: projection.id,
      logical_run_id: 'task-run-c1',
      execution_id: 'cogseed-exec-c1',
      reuse_turn_ids: ['cogseed-task-c1'],
      started_at_ms: 1,
      finished_at_ms: 2,
    });

    const proof = (await proofs.listTransferProofs(USER)).find((p) => p.executionId === 'cogseed-exec-c1');
    const ids = proof?.assetVersions.map((a) => a.assetId) || [];
    expect(ids).toContain(own.id);
    expect(ids).not.toContain('aa-not-in-this-task');
  });
});

/**
 * 链路的最后一段：transfer_validated → effectiveness_validated。
 *
 * 实机上 8 次「有用」全部 evidenceRefs=[]，被 proof-service.ts:262 如实降级成
 * insufficient_evidence，于是 6 条 transfer_validated 资产卡在那里。渲染层
 * （skills.js:2507）对已评价的使用记录直接返回 {ok:false, reason:'rated'}，
 * 用户没有补证据的入口——所以这批存量目前无解。
 *
 * 这两条用例钉住的是：**后端本身不阻止补证据重评**，卡点只在 UI 那道闸。
 * 谁将来做「修改评价」语义，可以据此确认不需要动 proof-service。
 */
describe('补证据后重评（后端能力）', () => {
  async function succeededTransferWith(seed: string) {
    const { runtimeContext, terminalProof, proofs, assets } = await mods();
    const asset = await injectableAsset(seed);
    const projection = await confirmedProjectionFor(asset.id, `task-run-${seed}`, `msg-${seed}`);
    await runtimeContext.buildRuntimeAssetContext(USER, CID, `cogseed-task-${seed}`);
    await terminalProof.handleRecallTaskTerminal({
      run_id: `cogseed-task-${seed}`,
      user_id: USER,
      conversation_id: CID,
      status: 'completed',
      projection_id: projection.id,
      logical_run_id: `task-run-${seed}`,
      execution_id: `cogseed-exec-${seed}`,
      reuse_turn_ids: [`cogseed-task-${seed}`],
      started_at_ms: 1,
      finished_at_ms: 2,
    });
    const transfer = (await proofs.listTransferProofs(USER)).find((p) => p.executionId === `cogseed-exec-${seed}`);
    expect(transfer?.receiptId).toBeTruthy();
    const current = (await assets.listAbilityAssets(USER)).find((a) => a.id === asset.id);
    expect(current?.maturity).toBe('transfer_validated');
    return { asset, transfer: transfer! };
  }

  it('无引用的「更好」如实降级成 Evidence 不足，不推动成熟度', async () => {
    const { proofs, assets } = await mods();
    const { asset, transfer } = await succeededTransferWith('e1');

    const proof = await proofs.evaluateEffectivenessProof(USER, {
      transferProofId: transfer.id,
      outcome: 'better',
      observedResult: 'User feedback: positive',
      evidenceRefs: [],
    });
    expect(proof.outcome).toBe('insufficient_evidence');
    const still = (await assets.listAbilityAssets(USER)).find((a) => a.id === asset.id);
    expect(still?.maturity).toBe('transfer_validated');
  });

  it('同一条迁移证明上补一次带引用的「更好」，能升到 effectiveness_validated', async () => {
    const { proofs, assets } = await mods();
    const { asset, transfer } = await succeededTransferWith('e2');

    // 第一次：无引用 → 降级，卡住。
    await proofs.evaluateEffectivenessProof(USER, {
      transferProofId: transfer.id,
      outcome: 'better',
      observedResult: 'User feedback: positive',
      evidenceRefs: [],
    });

    // 第二次：补上可回查的引用 → 后端不拦，结论成立。
    const second = await proofs.evaluateEffectivenessProof(USER, {
      transferProofId: transfer.id,
      outcome: 'better',
      observedResult: '这次直接按资产里的结构出了初稿，没有再返工。',
      evidenceRefs: [{ kind: 'execution_evaluation', subtype: 'evaluation', id: `cogseed-exec-e2` }],
    });
    expect(second.outcome).toBe('better');

    const advanced = (await assets.listAbilityAssets(USER)).find((a) => a.id === asset.id);
    expect(advanced?.maturity).toBe('effectiveness_validated');
    // 两条结论都留在链上——补证据是追加，不是抹掉此前那次如实记录。
    const all = (await proofs.listEffectivenessProofs(USER)).filter((p) => p.transferProofId === transfer.id);
    expect(all.map((p) => p.outcome).sort()).toEqual(['better', 'insufficient_evidence']);
  });
});
