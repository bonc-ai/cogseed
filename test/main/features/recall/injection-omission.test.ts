import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// US-604（2026-09-25 验收修复）AC4/AC7：发送前重检被拦**不再静默**——用户显式引用
// 的资产被拦时留一条 omitted 回执（带规则标识），界面据此说明"本轮未带入 + 哪条规则"。
// 同时守住 AC3：留痕与回读都只含标题与规则标识，不含正文、不含内部 id。

let tmpDir: string;
let prevRoot: string | undefined;
const UID = 'user-omission';
const CID = 'conv-omission-1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-omission-'));
  prevRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedPinnedAsset(assetId: string, statement: string) {
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const projection = await import('../../../../src/main/features/recall/context-projection');
  const now = new Date().toISOString();
  const asset = await assets.createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id: assetId, candidateId: `cand-${assetId}`,
    sourceCandidateIds: [`cand-${assetId}`], reviewDecisionId: `rd_${assetId.slice(3)}padpadpad`,
    // 标题闸门（设计 3.2）：正文前缀当标题过不了闸门，取正文尾部片段做合规种子。
    type: 'personal', title: statement.slice(-8).replace(/[。，、；：！？…）)\]\]】》"'\s]+$/, '') || '钉住样本', statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${assetId}`, taxonomyVersion: 2, subtype: 'session' }],
    scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'seed' });
  const pinned = await projection.previewContextProjection(UID, {
    taskRunId: `user-attach-${assetId}-${CID}`,
    purpose: 'user_pinned',
    authorization: 'user_confirmed',
    conversationId: CID,
    confirm: true,
    explicitAssetIds: [asset.id],
  });
  return { asset, pinned };
}

describe('投影通道被拦的留痕（US-604 AC4/AC7）', () => {
  it('用户 @ 钉住的资产被拦 → 写 omitted 回执，会话级查询回读标题与规则', async () => {
    const { asset, pinned } = await seedPinnedAsset('aa-omit-1', '被暂停后本轮不该带上这条内容。');
    const { recordProjectionOmission } = await import('../../../../src/main/features/recall/projection-omission');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    await recordProjectionOmission(UID, pinned, asset, 'paused', 'turn-omit-1');

    const omissions = await projection.listConversationOmissions(UID, CID);
    expect(omissions).toHaveLength(1);
    expect(omissions[0]).toMatchObject({ assetId: asset.id, title: asset.title, reason: 'paused', taskRunId: 'turn-omit-1' });
    // 只给这五个字段：标题 + 规则 + 轮次 + 时间 + 资产 id（定位用）。
    expect(Object.keys(omissions[0]).sort()).toEqual(['assetId', 'createdAt', 'reason', 'taskRunId', 'title']);
  });

  it('同一轮重复留痕幂等；换一轮追加一条（能说明"最近这一轮"）', async () => {
    const { asset, pinned } = await seedPinnedAsset('aa-omit-2', '同一轮不该留两条痕。');
    const { recordProjectionOmission } = await import('../../../../src/main/features/recall/projection-omission');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    await recordProjectionOmission(UID, pinned, asset, 'paused', 'turn-omit-2');
    await recordProjectionOmission(UID, pinned, asset, 'paused', 'turn-omit-2');
    expect(await projection.listConversationOmissions(UID, CID)).toHaveLength(1);

    await recordProjectionOmission(UID, pinned, asset, 'source_unavailable', 'turn-omit-3');
    const after = await projection.listConversationOmissions(UID, CID);
    expect(after).toHaveLength(2);
    // 倒序：最近一轮在最前。
    expect(after[0].taskRunId).toBe('turn-omit-3');
  });

  it('模型自选 / 语义投影被拦不留痕（常态省略不刷屏）', async () => {
    const { asset } = await seedPinnedAsset('aa-omit-3', '模型自选被拦不该进用户引用留痕。');
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const { recordProjectionOmission } = await import('../../../../src/main/features/recall/projection-omission');

    const modelSelected = await projection.previewContextProjection(UID, {
      taskRunId: 'turn-model-omit',
      purpose: 'model_selected',
      authorization: 'model_selected',
      conversationId: CID,
      confirm: true,
    });
    await recordProjectionOmission(UID, modelSelected, asset, 'paused', 'turn-model-omit');

    expect(await projection.listConversationOmissions(UID, CID)).toEqual([]);
  });

  it('留痕与回读都不含正文（AC3 不泄露受限内容）', async () => {
    const statement = '受限正文：这条内容的具体口径不该出现在留痕里。';
    const { asset, pinned } = await seedPinnedAsset('aa-omit-4', statement);
    const { recordProjectionOmission } = await import('../../../../src/main/features/recall/projection-omission');
    const injection = await import('../../../../src/main/features/recall/injection-receipt');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    await recordProjectionOmission(UID, pinned, asset, 'paused', 'turn-omit-4');

    const receipts = await injection.listInjectionReceipts(UID, 'turn-omit-4');
    expect(JSON.stringify(receipts)).not.toContain(statement);
    const omissions = await projection.listConversationOmissions(UID, CID);
    expect(JSON.stringify(omissions)).not.toContain(statement);
    // 标题可以出现（用户看得懂），正文不行。
    expect(omissions[0].title).toBe(asset.title);
  });

  it('没有规则标识时如实给空串（界面按「未知」呈现，不编造）', async () => {
    const { asset, pinned } = await seedPinnedAsset('aa-omit-5', '旧回执没有原因字段。');
    const injection = await import('../../../../src/main/features/recall/injection-receipt');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    // 直接写一条不带 reason 的 omitted 回执（模拟旧数据/异常路径）。
    await injection.recordInjectionReceipt(UID, {
      taskRunId: 'turn-omit-5', projectionId: pinned.id, assetId: asset.id, assetVersion: '1',
      boundary: 'real', status: 'omitted', channel: 'projection',
    });

    const omissions = await projection.listConversationOmissions(UID, CID);
    expect(omissions[0].reason).toBe('');
  });
});

describe('规则标识跨入口同一套说法（US-604 AC1/AC5 的机制面）', () => {
  it('assetRuntimeBlockRule 覆盖全部阻断原因，且状态优先于作用域', async () => {
    const runtime = await import('../../../../src/main/features/recall/formal-assets/runtime');

    expect(runtime.assetRuntimeBlockRule('paused', ['status_not_active'])).toBe('paused');
    expect(runtime.assetRuntimeBlockRule('active', ['target_agent_not_allowed'])).toBe('agent');
    expect(runtime.assetRuntimeBlockRule('active', ['scope_mismatch'])).toBe('scope');
    expect(runtime.assetRuntimeBlockRule('active', ['maturity_below_default_use'])).toBe('maturity');
    expect(runtime.assetRuntimeBlockRule('active', ['forbidden_context'])).toBe('forbidden_context');
    expect(runtime.assetRuntimeBlockRule('active', ['not_applicable_context'])).toBe('not_applicable_context');
    expect(runtime.assetRuntimeBlockRule('active', ['source_unavailable'])).toBe('source_unavailable');
    // 状态最具体：同时命中状态与作用域时报状态。
    expect(runtime.assetRuntimeBlockRule('revoked', ['status_not_active', 'scope_mismatch'])).toBe('revoked');
    expect(runtime.assetRuntimeBlockRule('active', [])).toBe('unknown');
  });

  it('挂载口与注入口共用同一份映射（两处说法不打架）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../../../src/main/features/recall');
    const attachSource = fs.readFileSync(path.join(root, 'context-projection.ts'), 'utf8');
    const injectSource = fs.readFileSync(path.join(root, 'prompt-injection.ts'), 'utf8');

    // 两处都引用同一个映射函数，而不是各写一份 if 链。
    expect(attachSource).toContain('assetRuntimeBlockRule');
    expect(injectSource).toContain('assetRuntimeBlockRule');
  });
});
