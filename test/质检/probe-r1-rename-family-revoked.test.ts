/**
 * 探针 r1（红队-越权与状态，新一轮 r1）：renameAssetFamily 对 revoked 终态资产改写。
 *
 * 发现（读码）：
 *  - family.ts:242 的成员过滤只挡 `purged`/`deleted`，漏了同为终态的 `revoked`；
 *  - family.ts:265-269 的逐成员直写 updater 里没有任何终态守卫
 *    （对照 asset-service.ts:1005 assertMutableAbilityAsset：revoked/deleted/purged
 *    一律「cannot be changed」，版本组写路径 2026-09-16 起统一收口）；
 *  - 后果：revoked（撤回=终态）资产被连带改写 familyName 并刷新 updatedAt——
 *    对照 purgeAbilityAsset 特意清除 familyName 的口径（asset-service.ts:1371-1373
 *    「族名是用户手写的分类名（元数据），与正文同属可识别内容」）。
 *  - 附带面：写入用 `...(current || {})` 兜底（family.ts:266），不做 asAsset
 *    复核——current 为空时会落一条非资产形状的裸记录。
 * 风格对齐 probe-r1-purge-tombstone-residue.test.ts（同域探针）。
 * 2026-09-30 r1 收尾（记账员）：对应待议 P-r1-7（最小补第三终态 vs 锁内
 * 终态复核，两案都合理待拍板）→ it.skip。断言锁定的「revoked 被连带改写」
 * 是现状，拍板修复后反转。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
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
  const { createAbilityAsset } = await import('../../src/main/features/recall/asset-service');
  const now = new Date().toISOString();
  return createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: '演示资产', statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, ACT);
}

/** 手工写 same_family 关系（模拟挂族写入的真实产物形态
 *  asset.relations = [{ kind: 'same_family', assetId }]，family.ts:251 的读法）。 */
function writeRelations(id: string, peerIds: string[], extra: Record<string, unknown> = {}) {
  const file = assetFile(id);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.relations = peerIds.map((peer) => ({ kind: 'same_family', assetId: peer }));
  Object.assign(raw, extra);
  fs.writeFileSync(file, JSON.stringify(raw));
}

describe('probe r1 › renameAssetFamily 改写 revoked 终态资产（待议 P-r1-7，拍板前 skip）', () => {
  it.skip('revoked 成员被连带改 familyName + 刷新 updatedAt（对照组：deleted 成员被跳过）', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { renameAssetFamily } = await import('../../src/main/features/recall/family');

    // 族一：revoked + active 互指；族二：deleted + active 互指
    await mkAsset('aa-fam-revoked');
    await mkAsset('aa-fam-live');
    await mkAsset('aa-fam-del');
    await mkAsset('aa-fam-del-live');
    const revokedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    writeRelations('aa-fam-revoked', ['aa-fam-live'], { updatedAt: revokedAt });
    writeRelations('aa-fam-live', ['aa-fam-revoked']);
    writeRelations('aa-fam-del', ['aa-fam-del-live']);
    writeRelations('aa-fam-del-live', ['aa-fam-del']);

    await assets.revokeAbilityAsset(UID, 'aa-fam-revoked', ACT);
    await assets.deleteAbilityAsset(UID, 'aa-fam-del', ACT);

    // 以 active 资产为锚改族名（正常用户操作：给活资产族改名）
    const renamed = await renameAssetFamily(UID, 'aa-fam-live', '新族名');

    // 发现主体：revoked 终态资产进了改名清单并被改写
    expect(renamed).toContain('aa-fam-revoked');
    const tomb = await assets.readAbilityAsset(UID, 'aa-fam-revoked');
    expect((tomb as unknown as Record<string, unknown>).familyName).toBe('新族名');
    // updatedAt 从固 定旧值被刷新（影响 listAbilityAssets 的 updatedAt 降序排序）
    expect(tomb.updatedAt).not.toBe(revokedAt);

    // 对照组：deleted 成员被 :242 的过滤挡住，未被改写
    const deleted = await assets.readAbilityAsset(UID, 'aa-fam-del');
    expect((deleted as unknown as Record<string, unknown>).familyName).toBeUndefined();

    // 对照组：统一终态守卫在本域的既有口径——单笔通道对 revoked 一律拒绝
    await expect(assets.updateAbilityAsset(UID, 'aa-fam-revoked', {
      statement: '绕过尝试', actor: 'user', reason: 'probe',
    })).rejects.toThrow(/revoked ability asset cannot be changed/);
  });
});
