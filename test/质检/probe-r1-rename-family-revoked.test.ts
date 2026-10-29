/**
 * 族重命名对终态成员（revoked/deleted）的保护（回归态）：revoked
 * 与 deleted 同口径排除——不被连带改 familyName/刷新 updatedAt；经终态成员
 * 连接的族连通性随之断开，单活成员不再构成可改名族。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, emit: () => {}, off: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r1-fam';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1fam-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACT = { actor: 'user' as const, reason: 'probe' };

function assetFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${id}.json`);
}

async function mkAsset(id: string) {
  // 直写既有记录（test-only 种子通道）：createAbilityAsset 首建要求候选池里
  // 存在对应 nightly 候选（formation-creation-gate），探针合成资产不走候选链。
  const { seedStoredAbilityAsset } = await import('../helpers/stored-ability-asset');
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: '演示资产', statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  } as never, ACT);
}

/** 手工写 same_family 关系（模拟挂族写入的真实产物形态）。 */
function writeRelations(id: string, peerIds: string[], extra: Record<string, unknown> = {}) {
  const file = assetFile(id);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.relations = peerIds.map((peer) => ({ kind: 'same_family', assetId: peer }));
  Object.assign(raw, extra);
  fs.writeFileSync(file, JSON.stringify(raw));
}

describe('renameAssetFamily 终态成员保护', () => {
  it('revoked 成员被排除：不被改名不刷 updatedAt；残余单活成员不构成族；纯活族正常改名', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { renameAssetFamily } = await import('../../src/main/features/recall/family');

    // 族一：revoked + active 互指；族二：deleted + active 互指；族三：两个 active 互指
    await mkAsset('aa-fam-revoked');
    await mkAsset('aa-fam-live');
    await mkAsset('aa-fam-del');
    await mkAsset('aa-fam-del-live');
    await mkAsset('aa-fam-live2');
    const revokedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    writeRelations('aa-fam-revoked', ['aa-fam-live'], { updatedAt: revokedAt });
    writeRelations('aa-fam-live', ['aa-fam-revoked', 'aa-fam-live2']);
    writeRelations('aa-fam-del', ['aa-fam-del-live']);
    writeRelations('aa-fam-del-live', ['aa-fam-del']);
    writeRelations('aa-fam-live2', ['aa-fam-live']);

    await assets.revokeAbilityAsset(UID, 'aa-fam-revoked', ACT);
    await assets.deleteAbilityAsset(UID, 'aa-fam-del', ACT);
    const tombBefore = JSON.parse(fs.readFileSync(assetFile('aa-fam-revoked'), 'utf8'));

    // 以活资产为锚改族名：有效族 = {live, live2}（revoked 断开 live—revoked 边）。
    const renamed = await renameAssetFamily(UID, 'aa-fam-live', '新族名');
    expect(renamed).toContain('aa-fam-live');
    expect(renamed).toContain('aa-fam-live2');
    expect(renamed).not.toContain('aa-fam-revoked');

    // revoked 墓碑不被连带改写：familyName 未被设置、updatedAt 原样。
    const tomb = await assets.readAbilityAsset(UID, 'aa-fam-revoked');
    expect((tomb as unknown as Record<string, unknown>).familyName).toBeUndefined();
    expect(tomb.updatedAt).toBe(tombBefore.updatedAt);

    // 对照组：deleted 成员同样不被改写。
    const deleted = await assets.readAbilityAsset(UID, 'aa-fam-del');
    expect((deleted as unknown as Record<string, unknown>).familyName).toBeUndefined();

    // 对照组：统一终态守卫——单笔通道对 revoked 一律拒绝。
    await expect(assets.updateAbilityAsset(UID, 'aa-fam-revoked', {
      statement: '绕过尝试', actor: 'user', reason: 'probe',
    })).rejects.toThrow(/revoked ability asset cannot be changed/);
  });

  it('族里只剩 revoked + 单活成员：改名按无族拒绝（不再连带墓碑）', async () => {
    const { renameAssetFamily } = await import('../../src/main/features/recall/family');
    await mkAsset('aa-solo-revoked');
    await mkAsset('aa-solo-live');
    writeRelations('aa-solo-revoked', ['aa-solo-live']);
    writeRelations('aa-solo-live', ['aa-solo-revoked']);
    const { revokeAbilityAsset } = await import('../../src/main/features/recall/asset-service');
    await revokeAbilityAsset(UID, 'aa-solo-revoked', ACT);
    await expect(renameAssetFamily(UID, 'aa-solo-live', '孤族')).rejects.toThrow(/does not belong to a family/);
  });
});
