import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 空间引用列表逐条隔离坏 JSON：坏文件不阻断好引用的显示与投影。
 * 删除坏文件前后，好引用的值与可见性保持一致。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-wsref-badfile-r4';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-wsref-badfile-r4-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const users = await import('../../src/main/features/users');
  users.activateUser(UID);
  const refs = await import('../../src/main/features/recall/workspace-refs');
  const assets = await import('../../src/main/features/recall/asset-service');
  const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
  // addWorkspaceAssetReference 先 readAbilityAsset 校验资产在场（:52）——
  // 探针按真实链路先建资产。
  const now = new Date().toISOString();
  for (const suffix of ['1', '2']) {
    await seedStoredAbilityAsset(UID, {
      schemaVersion: 2,
      ownerId: UID,
      id: `ast-good-${suffix}`,
      candidateId: `cand-wsref-${suffix}`,
      sourceCandidateIds: [`cand-wsref-${suffix}`],
      reviewDecisionId: `rd_wsref_probe_${suffix}`,
      type: 'rule',
      title: `引用探针资产${suffix}`,
      statement: `发布前核对回滚方案（wsref ${suffix}）。`,
      evidenceRefs: [{ kind: 'conversation', id: `conv-wsref-${suffix}` }],
      scope: 'project',
      status: 'active',
      lifecycleStatus: 'user_confirmed_unverified',
      maturity: 'bud',
      version: '1',
      createdAt: now,
      updatedAt: now,
    } as any, { actor: 'user', reason: 'wsref 探针创建' });
  }
  return { refs, recallJsonRecordPath };
}

describe('workspace-refs 坏 JSON 逐条降级', () => {
  it('对照组：两条好引用正常列出', async () => {
    const { refs } = await setup();
    await refs.addWorkspaceAssetReference(UID, { assetId: 'ast-good-1', workspaceId: 'wsp-a', scope: '只读引用' });
    await refs.addWorkspaceAssetReference(UID, { assetId: 'ast-good-2', workspaceId: 'wsp-b', scope: '编辑引用' });
    const list = await refs.listWorkspaceAssetReferences(UID);
    expect(list.length).toBe(2);
  });

  it('回归：并存一条坏引用文件（截断 JSON）→ 坏档跳过，好引用照常列出', async () => {
    const { refs, recallJsonRecordPath } = await setup();
    await refs.addWorkspaceAssetReference(UID, { assetId: 'ast-good-1', workspaceId: 'wsp-a', scope: '只读引用' });

    // 模拟云同步撕裂另一条引用文件（写半截 JSON）。
    const badPath = recallJsonRecordPath(UID, 'workspace-refs', 'wsref-bad-torn-file');
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    fs.writeFileSync(badPath, '{"schemaVersion":2,"ownerId":"torn', 'utf8');

    // 修复前（漏洞）：一条坏档让整个列表 rejects（IPC 通道与投影装配三处同断）。
    // 修复后：坏条目降级跳过（照 listAbilityAssets/listExperiences 先例），
    // 好引用照常列出。
    const withBad = await refs.listWorkspaceAssetReferences(UID);
    expect(withBad.length).toBe(1);
    expect(withBad[0].assetId).toBe('ast-good-1');

    // 剔除坏文件后行为一致（坏档只影响自身、不拖累也不改变好引用可见性）。
    fs.rmSync(badPath);
    const list = await refs.listWorkspaceAssetReferences(UID);
    expect(list.length).toBe(1);
    expect(list[0].assetId).toBe('ast-good-1');
  });
});
