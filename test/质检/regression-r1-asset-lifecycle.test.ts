/**
 * 探针 r1（边界测试员）→ r1 收尾整理为混合回归文件（记账员，2026-09-30）：
 * - active 回归（锁定既有正确行为）：30 天整点边界、epoch 过期、deleted
 *   终态全拒（2026-09-28 红队修复的回归验证）、expectedVersion 乐观锁、
 *   purged 终态与墓碑可读。
 * - 待议项（it.skip）：P-r1-7 deletedAt 未来时间戳 restore 复活、
 *   P-r1-27 archived 资产内容可变性（该用例即「补测试锁现状」方案的雏形，
 *   拍板后按方向启用或反转断言）。见 round-1-甄别.md toPending。
 *
 * 覆盖：保留期 30 天整点/过去/未来/epoch 时间戳、deleted 后内容与状态
 * 变更全拒、expectedVersion 乐观锁、二次 delete 幂等不续期、purged 后全拒。
 * 风格对齐 test/main/features/recall/family.test.ts（资产创建样例）。
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
const UID = 'probe-r1-asset';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1a-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function assetFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${id}.json`);
}

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

async function mkAsset(id: string) {
  const assets = await loadAssets();
  const now = new Date().toISOString();
  return assets.createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('regression r1 › 资产状态机边界（待议项已 skip）', () => {
  it('保留期恰好 30 天整：isWithinDeletionRetention 用严格小于——整点已过期，restore 拒绝', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-edge');
    await assets.deleteAbilityAsset(UID, 'aa-edge', ACT);
    // 手工把 deletedAt 拨到恰好 30 天前（+1ms 容差取整点）
    const raw = JSON.parse(fs.readFileSync(assetFile('aa-edge'), 'utf8'));
    raw.deletedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    fs.writeFileSync(assetFile('aa-edge'), JSON.stringify(raw));
    await expect(assets.restoreAbilityAsset(UID, 'aa-edge', ACT))
      .rejects.toThrow(/retention window has expired/);
    // 29.99 天 → 可恢复
    await mkAsset('aa-edge2');
    await assets.deleteAbilityAsset(UID, 'aa-edge2', ACT);
    const raw2 = JSON.parse(fs.readFileSync(assetFile('aa-edge2'), 'utf8'));
    raw2.deletedAt = new Date(Date.now() - 29.99 * 86_400_000).toISOString();
    fs.writeFileSync(assetFile('aa-edge2'), JSON.stringify(raw2));
    const restored = await assets.restoreAbilityAsset(UID, 'aa-edge2', ACT);
    expect(restored.status).toBe('active');
    expect(restored.deletedAt).toBeUndefined(); // 恢复清掉 deletedAt
  });

  // 待议 P-r1-7：deletedAt 未来时间戳保留期判定恒真、restore 复活。是否加
  // 方向检查牵连 sweep 语义（会不会把未来时间戳当已过期自动 purge），拍板前
  // skip；断言锁定的是「现状 restore 成功」。
  it.skip('deletedAt 在未来（时钟拨快 10 天）：保留期判定恒真——restore 成功', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-future');
    await assets.deleteAbilityAsset(UID, 'aa-future', ACT);
    const raw = JSON.parse(fs.readFileSync(assetFile('aa-future'), 'utf8'));
    raw.deletedAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
    fs.writeFileSync(assetFile('aa-future'), JSON.stringify(raw));
    const restored = await assets.restoreAbilityAsset(UID, 'aa-future', ACT);
    expect(restored.status).toBe('active'); // 未来时间戳未被视为异常
  });

  it('deletedAt = epoch 0：早已过期，restore 拒绝、仅剩 purge 一条路', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-epoch');
    await assets.deleteAbilityAsset(UID, 'aa-epoch', ACT);
    const raw = JSON.parse(fs.readFileSync(assetFile('aa-epoch'), 'utf8'));
    raw.deletedAt = '1970-01-01T00:00:00.000Z';
    fs.writeFileSync(assetFile('aa-epoch'), JSON.stringify(raw));
    await expect(assets.restoreAbilityAsset(UID, 'aa-epoch', ACT))
      .rejects.toThrow(/retention window has expired/);
  });

  it('deleted 终态：update/pause/resume/archive/revoke 全拒（2026-09-28 红队修复的回归验证）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-del');
    await assets.deleteAbilityAsset(UID, 'aa-del', ACT);
    await expect(assets.updateAbilityAsset(UID, 'aa-del', { statement: '改文', reason: 'r', actor: 'user' } as any))
      .rejects.toThrow(/deleted ability asset cannot be changed/);
    await expect(assets.pauseAbilityAsset(UID, 'aa-del', ACT)).rejects.toThrow(/deleted ability asset cannot be changed/);
    await expect(assets.resumeAbilityAsset(UID, 'aa-del', ACT)).rejects.toThrow(/deleted ability asset cannot be changed/);
    await expect(assets.archiveAbilityAsset(UID, 'aa-del', ACT)).rejects.toThrow(/deleted ability asset cannot be changed/);
    await expect(assets.revokeAbilityAsset(UID, 'aa-del', ACT)).rejects.toThrow(/deleted ability asset cannot be changed/);
    // 重复 delete 幂等：ok 且不刷新 deletedAt
    const first = JSON.parse(fs.readFileSync(assetFile('aa-del'), 'utf8'));
    await new Promise((r) => setTimeout(r, 5));
    await assets.deleteAbilityAsset(UID, 'aa-del', ACT);
    const second = JSON.parse(fs.readFileSync(assetFile('aa-del'), 'utf8'));
    expect(second.deletedAt).toBe(first.deletedAt);
  });

  it('expectedVersion 乐观锁：版本不符的状态变更被拒（并发双写防护）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-ver');
    await expect(assets.pauseAbilityAsset(UID, 'aa-ver', { ...ACT, expectedVersion: '2' }))
      .rejects.toThrow(/version conflict: expected v2, current v1/);
    const okPause = await assets.pauseAbilityAsset(UID, 'aa-ver', { ...ACT, expectedVersion: '1' });
    expect(okPause.status).toBe('paused');
  });

  it('purged 终态：一切 setStatus 均拒、内容字段已清空', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-purge');
    await assets.deleteAbilityAsset(UID, 'aa-purge', ACT);
    const purged = await assets.purgeAbilityAsset(UID, 'aa-purge', ACT);
    expect(purged.title).toBe('');
    expect(purged.statement).toBe('');
    await expect(assets.restoreAbilityAsset(UID, 'aa-purge', ACT)).rejects.toThrow(/has been purged/);
    await expect(assets.pauseAbilityAsset(UID, 'aa-purge', ACT)).rejects.toThrow(/has been purged/);
    await expect(assets.deleteAbilityAsset(UID, 'aa-purge', ACT)).rejects.toThrow(/has been purged/);
    // purged 记录仍可读（墓碑），历史回执不指向虚空
    const tomb = await assets.readAbilityAsset(UID, 'aa-purge');
    expect(tomb.status).toBe('purged');
  });

  // 待议 P-r1-27：archived 资产可被 updateAbilityAsset 改内容并 bump 版本，
  // 正式测试零断言锁定。本用例即选项 A（补测试锁现状）的雏形；拍板选 A 则
  // 启用本用例，选 B（冻结+守卫）则反转为 rejects 断言。
  it.skip('archived 非终态：内容仍可改（与 deleted 口径刻意区分）——行为记录', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-arch');
    await assets.archiveAbilityAsset(UID, 'aa-arch', ACT);
    const updated = await assets.updateAbilityAsset(UID, 'aa-arch', { statement: '归档后改文。', reason: 'r', actor: 'user' } as any);
    expect(updated.statement).toBe('归档后改文。');
    expect(updated.status).toBe('archived');
  });
});
