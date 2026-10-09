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

async function seedActiveAsset(assets: typeof import('../../../../src/main/features/recall/asset-service'), id: string, statement: string) {
  const now = new Date().toISOString();
  return assets.createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_${id.slice(3)}padpadpad`,
    type: 'personal', title: statement.slice(0, 8), statement,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'seed' });
}

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
