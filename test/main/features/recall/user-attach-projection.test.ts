import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 用户主动使用（2026-09-19）：显式资产投影——绕语义门、过状态硬门、钉在用版，
// attachToConversation 组合 = confirmed 投影 + 卡消息进会话 JSONL（下一轮
// projectionIdsForConversation 命中）。

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-attach';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-attach-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedActiveAsset(
  assets: typeof import('../../../../src/main/features/recall/asset-service'),
  id: string,
  statement: string,
  extra: Partial<Parameters<typeof assets.createAbilityAsset>[1]> = {},
) {
  const now = new Date().toISOString();
  return assets.createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_${id.slice(3)}padpadpad`,
    // 标题闸门（设计 3.2）：正文前缀当标题过不了闸门，取尾部片段。
    type: 'personal', title: statement.slice(-8).replace(/[。，、；：！？…）)\]\]】》"'\s]+$/, '') || '挂载样本', statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}`, taxonomyVersion: 2, subtype: 'session' }],
    scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
    ...extra,
  }, { actor: 'user', reason: 'seed' });
}

function attachInput(assetId: string, taskRunId: string, agentId?: string) {
  return {
    taskRunId,
    purpose: 'user_pinned',
    authorization: 'user_confirmed' as const,
    confirm: true,
    explicitAssetIds: [assetId],
    ...(agentId ? { agentId } : {}),
  };
}

async function expectAttachRejectedWithCode(
  projection: typeof import('../../../../src/main/features/recall/context-projection'),
  assetId: string,
  taskRunId: string,
  code: string,
  agentId?: string,
) {
  const error = await projection.previewContextProjection(UID, attachInput(assetId, taskRunId, agentId))
    .then(() => undefined, (err: unknown) => err as Error & { code?: string });
  expect(error, '显式挂载必须被拒绝').toBeInstanceOf(Error);
  // 码是界面说明「哪条规则」的唯一依据（US-604 AC1）：没有码，渲染层只能上屏英文原文。
  expect(error?.code).toBe(code);
  return error as Error & { code?: string };
}

describe('用户 @ 钉住的资产：回显与撤销（US-601 AC2/AC3 的 IPC 面）', () => {
  it('attach → 引用条回显（名称 + 冻结版本）→ 撤销后不再回显', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    const asset = await seedActiveAsset(assets, 'aa-pin-list', '引用条要能回显这条内容。');
    await projection.previewContextProjection(UID, {
      ...attachInput(asset.id, 'user-attach-pin-list'),
      conversationId: 'conv-pin-list',
    });

    const before = await projection.listUserPinnedAssets(UID, 'conv-pin-list');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ assetId: asset.id, title: asset.title, version: '1' });
    // 只给 projectionId/assetId/title/version 四个字段——不含正文、不含多余内部键。
    expect(Object.keys(before[0]).sort()).toEqual(['assetId', 'projectionId', 'title', 'version']);

    await projection.revokeUserPinnedProjection(UID, before[0].projectionId);
    expect(await projection.listUserPinnedAssets(UID, 'conv-pin-list')).toEqual([]);
  });

  it('模型自选投影不进用户引用条（两条授权线互不串台）', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    const asset = await seedActiveAsset(assets, 'aa-pin-model', '模型挑的，不该出现在用户引用条里。');
    const created = await projection.previewContextProjection(UID, {
      taskRunId: 'turn-pin-model',
      purpose: 'model_selected',
      authorization: 'model_selected',
      conversationId: 'conv-pin-model',
      confirm: true,
    });
    await projection.appendAssetsToModelSelectedProjection(UID, created.id, [asset.id]);

    expect(await projection.listUserPinnedAssets(UID, 'conv-pin-model')).toEqual([]);
  });

  it('资产读不到时标题留空，绝不回落内部 id（界面给泛称）', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    const asset = await seedActiveAsset(assets, 'aa-pin-gone', '这条随后会被彻底删掉。');
    await projection.previewContextProjection(UID, {
      ...attachInput(asset.id, 'user-attach-pin-gone'),
      conversationId: 'conv-pin-gone',
    });
    await assets.purgeAbilityAsset(UID, asset.id, { actor: 'user', reason: 'test purge' }).catch(() => {});

    const items = await projection.listUserPinnedAssets(UID, 'conv-pin-gone');
    if (items.length) {
      expect(items[0].title).toBe('');
      expect(String(items[0].title)).not.toContain('aa-pin-gone');
    }
  });
});

describe('显式挂载的权限与状态门（2026-09-25 验收修复 US-601 AC4 / US-604 AC1）', () => {
  it('暂停资产：码化 projection_asset_inactive，消息保持既有可匹配串，且不泄露正文', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    const statement = '受限正文：季度奖金核算口径不得外发。';
    const asset = await seedActiveAsset(assets, 'aa-gate-paused', statement);
    await assets.pauseAbilityAsset(UID, asset.id, { actor: 'user', reason: 'test pause' });

    const error = await expectAttachRejectedWithCode(projection, asset.id, 'user-attach-gate-1', 'projection_asset_inactive');
    // 既有断言口径不变（暂停 = not active），界面文案另走 code 映射。
    expect(error.message).toMatch(/not active/);
    expect(error.message).not.toContain(statement);
  });

  it('来源被停用：码化 projection_source_unavailable', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const sourceControl = await import('../../../../src/main/features/recall/source-control');

    const asset = await seedActiveAsset(assets, 'aa-gate-source', '来源撤权后不得继续带入。');
    await sourceControl.pauseCognitionSource(UID, asset.evidenceRefs[0]);

    await expectAttachRejectedWithCode(projection, asset.id, 'user-attach-gate-2', 'projection_source_unavailable');
  });

  it('作用域限定 Agent：接收者已知才当场拦，未知则留给每轮注入闸门', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    const asset = await seedActiveAsset(assets, 'aa-gate-agent', '只允许指定 Agent 使用。', {
      scopePolicy: { agentIds: ['agent-allowed'] },
    });

    // 接收者已知且不在白名单 → 当场拦，码化说明是权限范围。
    await expectAttachRejectedWithCode(projection, asset.id, 'user-attach-gate-3', 'projection_asset_ineligible', 'agent-other');

    // 接收者已知且在白名单 → 放行并钉住在用版。
    const allowed = await projection.previewContextProjection(UID, attachInput(asset.id, 'user-attach-gate-4', 'agent-allowed'));
    expect(allowed.status).toBe('confirmed');
    expect(allowed.assetVersions?.[asset.id]).toBe('1');

    // 接收者未知（普通会话还没定接收者）→ 不当场拦：目的地相关维度交给每轮
    // 注入闸门判定，那里知道真实 agentId，且被拦会留 omitted 回执（界面可见）。
    const deferred = await projection.previewContextProjection(UID, attachInput(asset.id, 'user-attach-gate-5'));
    expect(deferred.status).toBe('confirmed');
  });

  it('资产不存在：码化 projection_asset_missing', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const projection = await import('../../../../src/main/features/recall/context-projection');

    const error = await projection.previewContextProjection(UID, attachInput('aa-doesnotexist1', 'user-attach-gate-6'))
      .then(() => undefined, (err: unknown) => err as Error & { code?: string });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/not found/);
    expect(error?.code).toBe('projection_asset_missing');
  });
});

describe('explicit-asset projection (user attach)', () => {
  it('pins the exact asset without semantic selection and rejects paused ones', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const projection = await import('../../../../src/main/features/recall/context-projection');

    const pinned = await seedActiveAsset(assets, 'aa-attach-pinned', '用户钉住的偏好内容。');
    const projectionRecord = await projection.previewContextProjection(UID, {
      taskRunId: 'user-attach-test-1',
      purpose: 'user_pinned',
      authorization: 'user_confirmed',
      conversationId: 'conv-attach-1',
      confirm: true,
      explicitAssetIds: [pinned.id],
    });
    // 显式模式：指定的资产原样进投影（语义无关也进来），confirmed、钉在用版。
    expect(projectionRecord.status).toBe('confirmed');
    expect(projectionRecord.assetIds).toEqual([pinned.id]);
    expect(projectionRecord.assetVersions?.[pinned.id]).toBe('1');

    // 暂停资产过不了硬门。
    await assets.pauseAbilityAsset(UID, pinned.id, { actor: 'user', reason: 'test pause' });
    await expect(projection.previewContextProjection(UID, {
      taskRunId: 'user-attach-test-2',
      purpose: 'user_pinned',
      authorization: 'user_confirmed',
      confirm: true,
      explicitAssetIds: [pinned.id],
    })).rejects.toThrow(/not active/);
  });
});
