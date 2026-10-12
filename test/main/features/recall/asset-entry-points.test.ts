import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// US-604 AC5/AC6/AC2（2026-09-25 验收修复，Phase 8 收口用例）：
//   ① 换引用入口不绕过——显式挂载 / 模型检索 / 旧版本注入 / 关联经验（出生继承）
//      四条路径对同一条受限资产都拦或不带入；
//   ② 恢复后按当前授权重新判定，回退旧版本不绕过；
//   ③ 目标 Agent 白名单：错误 Agent 的回合不带入并留痕，正确 Agent 带入。

let tmp: string;
let prev: string | undefined;
const UID = 'user-a';

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-entry-points-'));
  prev = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  if (prev === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [users, assets, projection, promptInjection, storage, layout, injection, runtime, selection] = await Promise.all([
    import('../../../../src/main/features/users'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
    import('../../../../src/main/features/recall/injection-receipt'),
    import('../../../../src/main/features/recall/formal-assets/runtime'),
    import('../../../../src/main/features/recall/cognition-selection'),
  ]);
  users.activateUser(UID);
  return { assets, projection, promptInjection, storage, layout, injection, runtime, selection };
}

async function seedAsset(
  assets: Awaited<ReturnType<typeof modules>>['assets'],
  id: string,
  statement: string,
  extra: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  return assets.createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_${id.slice(3)}padpadpad`,
    // 标题不能是正文前缀（3.1 判定第 3 项）：取正文尾部片段做合规标题种子。
    type: 'personal', title: statement.slice(-8).replace(/[。，、；：！？…）)\]】》"'\s]+$/, '') || `条目标题${id.slice(-4)}`, statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}`, taxonomyVersion: 2, subtype: 'session' }],
    scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
    ...extra,
  }, { actor: 'user', reason: 'seed' });
}

/** 用户 @ 钉到会话：confirmed 投影 + 卡片消息（下一轮注入靠它被发现）。 */
async function pinToConversation(
  mods: Awaited<ReturnType<typeof modules>>,
  assetId: string,
  cid: string,
) {
  const pinned = await mods.projection.previewContextProjection(UID, {
    taskRunId: `user-attach-${assetId}-${cid}`,
    purpose: 'user_pinned',
    authorization: 'user_confirmed',
    conversationId: cid,
    confirm: true,
    explicitAssetIds: [assetId],
  });
  const messageFile = mods.layout.conversationMessageFile(UID, cid);
  await fs.promises.mkdir(path.dirname(messageFile), { recursive: true });
  await mods.storage.appendJsonlAtomic(messageFile, {
    id: `msg-${pinned.id}`, ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'card',
    recall_projection_card: { projectionId: pinned.id },
  });
  return pinned;
}

const turn = (cid: string, taskRunId: string, extra: Record<string, unknown> = {}) => ({
  cid, taskRunId, taskText: '随手问一句', ...extra,
});

describe('换引用入口不绕过（US-604 AC5）', () => {
  it('暂停资产在四条引用路径上都不带入', async () => {
    const mods = await modules();
    const asset = await seedAsset(mods.assets, 'aa-entry-1', '暂停之后任何入口都不该带上这条内容。');
    await pinToConversation(mods, asset.id, 'cid-entry');
    await mods.assets.pauseAbilityAsset(UID, asset.id, { actor: 'user', reason: 'test pause' });
    const live = await mods.assets.readAbilityAsset(UID, asset.id);

    // ① 显式挂载（用户主动挑）
    await expect(mods.projection.previewContextProjection(UID, {
      taskRunId: 'turn-entry-attach', purpose: 'user_pinned', authorization: 'user_confirmed',
      confirm: true, explicitAssetIds: [asset.id],
    })).rejects.toMatchObject({ code: 'projection_asset_inactive' });

    // ② 模型检索（工具侧共用同一道闸门）
    const gate = mods.runtime.evaluateAssetRuntimeEligibility({
      status: live.status, maturity: live.maturity, lifecycleStatus: live.lifecycleStatus, scope: live.scope,
      ...(live.scopePolicy ? { scopePolicy: live.scopePolicy } : {}),
    }, { silentDefaultInjection: true, sourceAvailable: true });
    expect(gate.eligible).toBe(false);
    expect(mods.runtime.assetRuntimeBlockRule(live.status, gate.reasons)).toBe('paused');

    // ③ 旧版本注入（每轮重检 + 留痕）
    const injected = await mods.promptInjection.buildRecallTurnPromptContext(UID, turn('cid-entry', 'turn-entry-inject'));
    expect(injected.promptBlock).not.toContain(asset.title);
    const omissions = await mods.injection.listInjectionReceipts(UID, 'turn-entry-inject');
    expect(omissions.some((receipt) => receipt.status === 'omitted' && receipt.reason === 'paused')).toBe(true);

    // ④ 关联经验＝出生继承
    const reasons = mods.selection.classifyInheritedAsset(
      { id: asset.id, version: '1' } as never,
      live,
      { scope: 'general' },
    );
    expect(reasons.length, '继承路径也要拦').toBeGreaterThan(0);
  });
});

describe('恢复与回退后重新判定（US-604 AC6）', () => {
  it('暂停时不带入，恢复后按当前授权重新放行', async () => {
    const mods = await modules();
    const asset = await seedAsset(mods.assets, 'aa-entry-2', '恢复之后应该重新带上这条内容。');
    await pinToConversation(mods, asset.id, 'cid-resume');

    await mods.assets.pauseAbilityAsset(UID, asset.id, { actor: 'user', reason: 'test pause' });
    const paused = await mods.promptInjection.buildRecallTurnPromptContext(UID, turn('cid-resume', 'turn-resume-1'));
    expect(paused.promptBlock).not.toContain(asset.title);

    await mods.assets.resumeAbilityAsset(UID, asset.id, { actor: 'user', reason: 'test resume' });
    const resumed = await mods.promptInjection.buildRecallTurnPromptContext(UID, turn('cid-resume', 'turn-resume-2'));
    expect(resumed.promptBlock).toContain(asset.title);
  });

  it('来源授权失效后，恢复资产状态也不自动放行', async () => {
    const mods = await modules();
    const asset = await seedAsset(mods.assets, 'aa-entry-3', '来源撤权后恢复状态也不该放行。');
    await pinToConversation(mods, asset.id, 'cid-source');
    const sourceControl = await import('../../../../src/main/features/recall/source-control');

    await sourceControl.pauseCognitionSource(UID, asset.evidenceRefs[0]);
    await mods.assets.pauseAbilityAsset(UID, asset.id, { actor: 'user', reason: 'test pause' });
    await mods.assets.resumeAbilityAsset(UID, asset.id, { actor: 'user', reason: 'test resume' });

    const injected = await mods.promptInjection.buildRecallTurnPromptContext(UID, turn('cid-source', 'turn-source-1'));
    expect(injected.promptBlock).not.toContain(asset.title);
    const omissions = await mods.injection.listInjectionReceipts(UID, 'turn-source-1');
    expect(omissions.some((receipt) => receipt.status === 'omitted' && receipt.reason === 'source_unavailable')).toBe(true);
  });
});

describe('目标 Agent 白名单（US-604 AC2）', () => {
  it('错误 Agent 的回合不带入并留痕；被授权的 Agent 正常带入', async () => {
    const mods = await modules();
    const asset = await seedAsset(mods.assets, 'aa-entry-agent', '只允许指定 Agent 使用这条内容。', {
      scopePolicy: { agentIds: ['agent-allowed'] },
    });
    await pinToConversation(mods, asset.id, 'cid-agent');

    const wrong = await mods.promptInjection.buildRecallTurnPromptContext(
      UID, turn('cid-agent', 'turn-agent-wrong', { agentId: 'agent-other' }),
    );
    expect(wrong.promptBlock).not.toContain(asset.title);
    const omissions = await mods.injection.listInjectionReceipts(UID, 'turn-agent-wrong');
    // Agent 白名单落在 scopePolicy.agentIds 上，闸门报的是 scope_mismatch → 规则标识
    // 为 'scope'（界面文案「作用范围不包含当前场景」）；只有声明 targetAgents 的资产
    // 才会报 target_agent_not_allowed → 'agent'。两者都拦、都可见，粒度差异记录在此。
    expect(omissions.some((receipt) => receipt.status === 'omitted' && receipt.reason === 'scope')).toBe(true);

    const right = await mods.promptInjection.buildRecallTurnPromptContext(
      UID, turn('cid-agent', 'turn-agent-right', { agentId: 'agent-allowed' }),
    );
    expect(right.promptBlock).toContain(asset.title);
  });
});
