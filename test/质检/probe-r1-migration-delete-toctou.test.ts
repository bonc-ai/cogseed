import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 经验迁移在写出经验与物理迁出资产之间可能遇到用户删除。
 * 用经验记录锁固定交错：迁出段须在资产锁内重查终态；已删除的主记录和
 * 版本保留，经验若已写出则如实记录迁移未完成，不能声称迁移成功。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const UID = 'user-mig-toctou-r1';
const ASSET = 'ast-mig-toctou';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mig-toctou-r1-'));
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
  const assets = await import('../../src/main/features/recall/asset-service');
  const migration = await import('../../src/main/features/recall/experience-migration');
  const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
  const { fileEditLock } = await import('../../src/main/util/locks');
  return { assets, migration, recallJsonRecordPath, fileEditLock };
}

/** KSTAR 经验类资产夹具（照 experience-migration.test.ts 同款：带
 *  learningProvenance 的判据正例，以测试 helper 预置历史记录）。 */
async function seedAsset(status: 'active' | 'deleted') {
  const { assets } = await setup();
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 1,
    ownerId: UID,
    id: ASSET,
    candidateId: `cand-${ASSET}`,
    title: `经验资产-${ASSET}`,
    statement: `发布前必须核对回滚方案（${ASSET}）`,
    type: 'rule',
    scope: 'project',
    evidenceRefs: [{ kind: 'execution', id: `exec-${ASSET}` }],
    reviewDecisionId: 'legacy-untracked',
    lifecycleStatus: 'system_precipitated_unverified',
    status,
    maturity: 'transfer_validated',
    version: '1',
    learningProvenance: {
      projectionId: `prj-${ASSET}`,
      episodeId: `kse-${ASSET}`,
      ruleRefs: [],
      attribution: 'execution_gap' as const,
    },
    createdAt: now,
    updatedAt: now,
  }, 'migration toctou probe fixture');
}

function userAction(reason: string) {
  return { actor: 'user' as const, reason };
}

describe('经验迁移的锁内终态复核', () => {
  it('对照组：无并发时 deleted 资产按判据跳过（terminal_status），保留期与 restore 都在', async () => {
    const { assets, migration, recallJsonRecordPath } = await setup();
    await seedAsset('active');
    // 走真实删除路径落 deletedAt（直接种子 deleted 态缺 deletedAt，保留期判过期）。
    const deleted = await assets.deleteAbilityAsset(UID, ASSET, userAction('对照组删除'));
    expect(deleted.status).toBe('deleted');

    const run = await migration.runExperienceMigration(UID, [ASSET]);
    expect(run.migrated).toBe(0);
    expect(run.details.some((d) => 'reason' in d && d.reason === 'terminal_status')).toBe(true);

    // 判据生效：主记录仍是 deleted 墓碑（保留期内），restore 可回 active。
    const recPath = recallJsonRecordPath(UID, 'ability-assets', ASSET);
    expect(fs.existsSync(recPath)).toBe(true);
    const restored = await assets.restoreAbilityAsset(UID, ASSET, userAction('对照组恢复'));
    expect(restored.status).toBe('active');
  });

  it('判据通过后、物理迁出前资产被删除 → 锁内复核拒绝迁出，已写经验记 failed、保留期/restore 完好', async () => {
    const { assets, migration, recallJsonRecordPath, fileEditLock } = await setup();
    await seedAsset('active');
    const assetPath = recallJsonRecordPath(UID, 'ability-assets', ASSET);
    // writeExperienceForAsset 的经验 id 是确定性的 exp-mig-<assetId>（:341）。
    const expPath = recallJsonRecordPath(UID, 'experiences', `exp-mig-${ASSET}`);

    // 确定性时序：预持经验记录锁，把迁移卡在 ②写经验 与 ③物理迁出 之间。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(expPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const runP = migration.runExperienceMigration(UID, [ASSET]);
    await new Promise((r) => setTimeout(r, 30));

    // 持锁期间走真实用户路径删除资产（资产记录锁空闲，立即完成落盘）。
    const deleted = await assets.deleteAbilityAsset(UID, ASSET, userAction('窗口期内用户删除'));
    expect(deleted.status).toBe('deleted');
    const onDisk = JSON.parse(fs.readFileSync(assetPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.status).toBe('deleted'); // 删除已先于迁出落盘

    release();
    await holder;
    const run = await runP;

    // 迁出段锁内复核终态：已删资产不物理迁出。
    // 本场景经验条目已写出（②在删除前完成）→ 记 failed（asset_removal_failed），
    // 不是 migrated、也不是 skipped。
    expect(run.migrated).toBe(0);
    expect(run.failed).toBe(1);
    expect(run.details.some((d) => 'reason' in d && d.reason === 'asset_removal_failed')).toBe(true);

    // 已删资产的主记录保留为墓碑：保留期内 restore 通道完好。
    expect(fs.existsSync(assetPath)).toBe(true);
    const kept = JSON.parse(fs.readFileSync(assetPath, 'utf8')) as Record<string, unknown>;
    expect(kept.status).toBe('deleted');
    const restored = await assets.restoreAbilityAsset(UID, ASSET, userAction('保留期内恢复'));
    expect(restored.status).toBe('active');

    // 而经验条目已写出（半迁如实可见——正是记 failed 而非 skipped 的依据）。
    expect(fs.existsSync(expPath)).toBe(true);
    const exp = JSON.parse(fs.readFileSync(expPath, 'utf8')) as Record<string, unknown>;
    expect(String(exp.body)).toContain('发布前必须核对回滚方案');
  });
});
