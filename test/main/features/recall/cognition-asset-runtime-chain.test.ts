/**
 * 认知资产主链 E2E：candidate → 用户确认 → 正式资产版本 → Runtime 真实消费。
 *
 * merge 后 develop 新增了 `buildRuntimeAssetContext`（cogseed_backend），它是
 * Runtime 侧读取已确认资产的唯一入口。这套用例把两段链路接起来验证，并**钉住
 * 修订的传播边界**：资产改版不会自动进入已确认投影的注入内容，必须重新确认。
 * 这一条如果没有测试，Phase 3 的"编辑资产生成新版本"看起来生效、实际 Runtime
 * 仍在用旧版本，而且没有任何地方会告诉用户。
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
const USER = 'user-chain';
const CID = 'cid-chain';

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-asset-runtime-chain-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function mods() {
  const [candidates, assets, refs, projection, runtimeContext, storage, layout, caps] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/cogseed_backend/runtime-asset-context'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
    import('../../../../src/main/features/recall/candidate-capabilities'),
  ]);
  return { candidates, assets, refs, projection, runtimeContext, storage, layout, caps };
}

/** 绑定投影到会话：Runtime 侧就是靠这条消息找到已确认投影的。 */
async function bindProjection(projectionId: string, messageId: string) {
  const { storage, layout } = await mods();
  const file = layout.conversationMessageFile(USER, CID);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await storage.appendJsonlAtomic(file, {
    id: messageId, ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'projection',
    recall_projection_card: { projectionId },
  });
}

/** 实机分布里最常见的起点：证据较弱、等用户确认的候选。 */
async function weakCandidateToAsset() {
  const { candidates, assets, caps } = await mods();
  const saved = await candidates.saveRecallCandidate(USER, {
    judgment: '架构决策要在改运行时边界之前写进决策日志',
    value: '让后续评审不必重建上下文',
    summary: '架构变更前先写决策日志',
    suggestedType: 'rule',
    suggestedScope: 'review,project',
    suggestedAction: 'create',
    spaceId: 'workspace-a',
    sourceRefs: [{ kind: 'execution', id: 'exec-chain' }],
    evidenceRefs: [{ kind: 'execution', id: 'exec-chain' }],
    applicableWhen: ['架构评审与运行时边界变更时'],
    forbiddenWhen: ['没有决定的头脑风暴'],
    forceWeakObservation: true,
  });
  expect(saved.status).toBe('weak_observation');
  // 用户侧 capability 说它可确认——这正是 Phase 1 放开的那一档。
  expect(caps.getRecallCandidateCapabilities(saved).canPromote).toBe(true);

  const promoted = await candidates.promoteRecallCandidate(USER, saved.id, { actor: 'user' });
  expect(promoted.candidate.status).toBe('confirmed');
  expect(promoted.asset.version).toBe('1');
  // 注入闸门按成熟度收口；本用例考的是版本传播，先抬到够格档位。
  await assets.setAbilityAssetMaturity(USER, promoted.asset.id, 'transfer_validated');
  return promoted;
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

describe('cognition asset chain reaches the CogSeed Runtime', () => {
  it('carries a user-confirmed weak observation all the way into the runtime context', async () => {
    const { runtimeContext } = await mods();
    const promoted = await weakCandidateToAsset();
    const confirmed = await confirmedProjectionFor(promoted.asset.id, 'task-1', 'msg-1');
    expect(confirmed.assetVersions?.[promoted.asset.id]).toBe('1');

    const items = await runtimeContext.buildRuntimeAssetContext(USER, CID);

    // Runtime 真实消费：不是"函数被调用了"，而是资产内容确实进了上下文块。
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('text');
    expect(items[0].label).toBe('Confirmed reusable ability assets');
    expect(items[0].content).toContain('架构决策要在改运行时边界之前写进决策日志');
    expect(items[0].content.length).toBeLessThanOrEqual(runtimeContext.MAX_RUNTIME_ASSET_CONTEXT_CHARS);
  });

  it('keeps injecting the confirmed version after the asset is revised, until it is confirmed again', async () => {
    const { assets, runtimeContext } = await mods();
    const promoted = await weakCandidateToAsset();
    await confirmedProjectionFor(promoted.asset.id, 'task-1', 'msg-1');

    // Phase 3 的修订出口：改内容 → 生成新版本。
    const revised = await assets.updateAbilityAsset(USER, promoted.asset.id, {
      statement: '架构决策必须写明取舍与被否决的方案',
      reason: '补上被否决方案',
      actor: 'user',
    });
    expect(revised.version).toBe('2');

    const afterRevision = await runtimeContext.buildRuntimeAssetContext(USER, CID);
    // 边界：用户确认的是 v1，注入的就还是 v1 的冻结快照——不能在用户背后
    // 把 v2 顶上去。代价是修订不会自动生效，UI 目前**没有**任何地方说明这点。
    expect(afterRevision[0].content).toContain('架构决策要在改运行时边界之前写进决策日志');
    expect(afterRevision[0].content).not.toContain('被否决的方案');

    // 重新确认一次投影后，修订才真正进入 Runtime。
    await assets.setAbilityAssetMaturity(USER, promoted.asset.id, 'transfer_validated');
    const reconfirmed = await confirmedProjectionFor(promoted.asset.id, 'task-2', 'msg-2');
    expect(reconfirmed.assetVersions?.[promoted.asset.id]).toBe('2');

    const afterReconfirm = await runtimeContext.buildRuntimeAssetContext(USER, CID);
    expect(afterReconfirm[0].content).toContain('被否决的方案');
  });

  it('survives a reload: the chain is read back from disk, not from memory', async () => {
    const promoted = await weakCandidateToAsset();
    await confirmedProjectionFor(promoted.asset.id, 'task-1', 'msg-1');

    // 模块重载 = renderer 刷新 / 应用重启后重新读盘。
    vi.resetModules();
    const reloaded = await import('../../../../src/main/features/cogseed_backend/runtime-asset-context');
    const candidatesAfter = await import('../../../../src/main/features/recall/candidate-service');
    const capsAfter = await import('../../../../src/main/features/recall/candidate-capabilities');

    const items = await reloaded.buildRuntimeAssetContext(USER, CID);
    expect(items[0].content).toContain('架构决策要在改运行时边界之前写进决策日志');

    const candidate = await candidatesAfter.readRecallCandidate(USER, promoted.candidate.id);
    expect(candidate.status).toBe('confirmed');
    expect(candidate.promotedAssetId).toBe(promoted.asset.id);
    const capability = capsAfter.getRecallCandidateCapabilities(candidate);
    expect(capability.isTerminal).toBe(true);
    expect(capability.canEdit).toBe(false);
    expect(capability.displayState).toBe('confirmed');
  });

  it('injects nothing when the conversation has no confirmed projection', async () => {
    const { runtimeContext } = await mods();
    await weakCandidateToAsset();
    expect(await runtimeContext.buildRuntimeAssetContext(USER, CID)).toEqual([]);
  });
});

describe('the projection card tells the user their confirmed version drifted', () => {
  it('marks the asset stale and keeps the confirmed version visible', async () => {
    const { assets, projection } = await mods();
    const cardModule = await import('../../../../src/main/features/recall/projection-card');
    const promoted = await weakCandidateToAsset();
    const confirmed = await confirmedProjectionFor(promoted.asset.id, 'task-1', 'msg-1');

    const before = await cardModule.buildProjectionCard(USER, confirmed.id);
    expect(before.staleAssetIds).toEqual([]);
    expect(before.assetSummaries[0]).toMatchObject({ version: '1', confirmedVersion: '1' });
    expect(before.assetSummaries[0].stale).toBeUndefined();

    await assets.updateAbilityAsset(USER, promoted.asset.id, {
      statement: '架构决策必须写明取舍与被否决的方案', reason: '补上被否决方案', actor: 'user',
    });

    const after = await cardModule.buildProjectionCard(USER, confirmed.id);
    // 告知，但不改注入：确认的还是 v1，卡片同时给出 live 的 v2。
    expect(after.staleAssetIds).toEqual([promoted.asset.id]);
    expect(after.assetSummaries[0]).toMatchObject({ version: '2', confirmedVersion: '1', stale: true });

    // 投影本身不被改写——注入内容仍然锁在 v1。
    const stored = await projection.readContextProjection(USER, confirmed.id);
    expect(stored.assetVersions?.[promoted.asset.id]).toBe('1');
    expect(stored.status).toBe('confirmed');
  });

  it('does not mark a preview projection stale (it pins versions only on confirmation)', async () => {
    const { assets, refs, projection } = await mods();
    const cardModule = await import('../../../../src/main/features/recall/projection-card');
    const promoted = await weakCandidateToAsset();
    await refs.addWorkspaceAssetReference(USER, { assetId: promoted.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection(USER, {
      taskRunId: 'task-preview', workspaceId: 'workspace-a', purpose: 'review',
    });
    await assets.updateAbilityAsset(USER, promoted.asset.id, {
      statement: '改内容', reason: 'preview 阶段的改动', actor: 'user',
    });

    const card = await cardModule.buildProjectionCard(USER, preview.id);
    expect(card.staleAssetIds).toEqual([]);
    expect(card.assetSummaries[0].stale).toBeUndefined();
  });
});
