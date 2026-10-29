import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 资产生命周期边界：30 天保留期、epoch 与未来时间戳、终态守卫、乐观版本锁及墓碑读取。 */
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
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('资产状态机边界', () => {
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

  // 未来 deletedAt 与保留期清扫的时间方向语义已对齐：恢复侧拒绝（不可能的
  // 删除时刻不能证明「还能恢复」），清扫侧不因它判「已到期」（时间不明 ≠ 已到期）。
  it('deletedAt 在未来（时钟拨快 10 天）：保留期判定不再恒真——restore 拒绝，资产保留待处置', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-future');
    await assets.deleteAbilityAsset(UID, 'aa-future', ACT);
    const raw = JSON.parse(fs.readFileSync(assetFile('aa-future'), 'utf8'));
    raw.deletedAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
    fs.writeFileSync(assetFile('aa-future'), JSON.stringify(raw));
    await expect(assets.restoreAbilityAsset(UID, 'aa-future', ACT))
      .rejects.toThrow(/retention window has expired/);
    // 视图口径同源：时间不明（既不可恢复、也无剩余天数），不是「还能恢复 40 天」。
    const stillDeleted = await assets.readAbilityAsset(UID, 'aa-future');
    const view = assets.describeDeletedAbilityAsset(stillDeleted);
    expect(view.restorable).toBe(false);
    expect(view.retentionUnknown).toBe(true);
    expect(view.retentionDaysLeft).toBeNull();
    // 清扫不把未来时间戳当已到期：isWithinDeletionRetention 维持原语义，
    // 该记录不会被自动彻底清除（时间不明等人工处置）。
    expect(assets.isWithinDeletionRetention(stillDeleted)).toBe(true);
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

  it('deleted 终态：update/pause/resume/archive/revoke 全拒', async () => {
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

  // 归档内容是否可变与删除保留期内不可变是不同的状态边界。
  // 已确认口径：archived 不是终态，允许继续修改内容，状态保持 archived。
  it('archived 非终态：内容仍可改（与 deleted 口径刻意区分）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-arch');
    await assets.archiveAbilityAsset(UID, 'aa-arch', ACT);
    const updated = await assets.updateAbilityAsset(UID, 'aa-arch', { statement: '归档后改文。', reason: 'r', actor: 'user' } as any);
    expect(updated.statement).toBe('归档后改文。');
    expect(updated.status).toBe('archived');
  });
});
