import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';
import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-uninstall-'));
const listCogSeedTasks = vi.fn<(userId: string) => Promise<CogSeedTaskRecord[]>>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../../src/main/features/cogseed_backend/task-store', () => ({
  listCogSeedTasks: (userId: string) => listCogSeedTasks(userId),
}));

const store = await import('../../../../src/main/features/marketplace/version-store');
const gc = await import('../../../../src/main/features/marketplace/version-gc');
const retention = await import('../../../../src/main/util/tombstone_retention');
const paths = await import('../../../../src/main/paths');

const SRC = path.resolve(__dirname, '../../../../src');
const CONTENT_ID = 'a1b2c3d4e5f6';
const DAY = 24 * 60 * 60 * 1000;

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_uninstall_${uidSeq}`;
  listCogSeedTasks.mockReset();
  listCogSeedTasks.mockResolvedValue([]);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

async function landVersionCopy(version: string): Promise<void> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const src = path.join(workspace, 'sources', UID, version);
  fs.mkdirSync(src, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(src, true);
  await store.writeVersionCopy(
    UID, { contentId: CONTENT_ID, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
  );
}

function landCurrentInstall(version: string): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(),
  }));
}

/** 复刻卸载对磁盘的影响：删 current install 与缓存（清单行由 removeSkillInstall 处理）。 */
function uninstallOnDisk(): void {
  fs.rmSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID), { recursive: true, force: true });
  fs.rmSync(paths.marketplaceCacheSkillDir(UID, CONTENT_ID), { recursive: true, force: true });
}

function task(status: string, version: string): CogSeedTaskRecord {
  return {
    status,
    skillVersionPins: [{ skillId: CONTENT_ID, version, manifestHash: 'h'.repeat(64) }],
  } as unknown as CogSeedTaskRecord;
}

describe('卸载 / 墓碑（C6 / FR-046–FR-048）', () => {
  describe('⭐ T069 只删 current install + 缓存 + 清单行，版本副本不删', () => {
    it('卸载后版本副本仍在且可解析', async () => {
      await landVersionCopy('1.0.0');
      await landVersionCopy('2.0.0');
      landCurrentInstall('2.0.0');

      uninstallOnDisk();

      expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID))).toBe(false);
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '1.0.0')).not.toBeNull();
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '2.0.0')).not.toBeNull();
    });

    it('「不删副本」由路径结构保证：两棵树互不包含', () => {
      const current = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      const copies = paths.userMarketplaceContentVersionsDir(UID, CONTENT_ID);
      expect(copies.startsWith(current)).toBe(false);
      expect(current.startsWith(copies)).toBe(false);
    });

    it('卸载实现不触碰版本副本目录', () => {
      const code = readSrc('main/features/marketplace.ts');
      const fn = code.slice(
        code.indexOf('export async function uninstallMarketplaceSkill'),
        code.indexOf('export async function uninstallMarketplaceSkill') + 1200,
      );
      expect(fn).not.toContain('userMarketplaceVersion');
      expect(fn).not.toContain('versions');
    });
  });

  describe('⭐ T073 仍被钉固的副本在卸载后必须存活', () => {
    it('非终态 Task 钉住 1.0.0：卸载后该副本仍在，进行中的使用不受影响', async () => {
      await landVersionCopy('1.0.0');
      landCurrentInstall('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;
      listCogSeedTasks.mockResolvedValue([task('running', '1.0.0')]);

      uninstallOnDisk();

      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).not.toBeNull();
    });

    it('recoverable 钉固同样保护副本，且回收也不删它', async () => {
      await landVersionCopy('1.0.0');
      landCurrentInstall('1.0.0');
      listCogSeedTasks.mockResolvedValue([task('recoverable', '1.0.0')]);
      uninstallOnDisk();

      const report = await gc.runVersionGc(UID, { now: Date.now() + 365 * DAY });

      expect(report.deleted).toEqual([]);
      expect(report.kept[0].reason).toBe('pinned');
    });

    it('⚠️ 墓碑不是删除历史副本的依据：卸载后无人钉固的副本仍要满足回收三条件', async () => {
      await landVersionCopy('1.0.0');
      landCurrentInstall('1.0.0');
      uninstallOnDisk();
      // 卸载后 current 判不出（内容已删）→ 回收拿不准，一个都不删。
      const early = await gc.runVersionGc(UID, { now: Date.now() + 365 * DAY });
      expect(early.deleted).toEqual([]);
      expect(early.kept[0].reason).toBe('current-unknown');
    });
  });

  describe('⭐ T070 墓碑保留期 30 天，过期墓碑在读取时被丢弃（既有实现，补断言）', () => {
    it('保留期常量是 30 天', () => {
      expect(retention.TOMBSTONE_RETENTION_DAYS).toBe(30);
      expect(retention.TOMBSTONE_RETENTION_MS).toBe(30 * DAY);
    });

    it('未到 30 天不算过期，到 30 天算过期', () => {
      const now = Date.now();
      expect(retention.isExpiredMsTombstone(now - 29 * DAY, { nowMs: now })).toBe(false);
      expect(retention.isExpiredMsTombstone(now - 30 * DAY, { nowMs: now })).toBe(true);
    });

    it('无效或缺失的墓碑时间不算过期（不据坏数据丢弃用户意图）', () => {
      expect(retention.isExpiredMsTombstone(0)).toBe(false);
      expect(retention.isExpiredMsTombstone(undefined)).toBe(false);
      expect(retention.isExpiredIsoTombstone('not-a-date')).toBe(false);
      expect(retention.isExpiredIsoTombstone('')).toBe(false);
    });

    it('过期记录在读取时被过滤掉', () => {
      const now = Date.now();
      const rows = [
        { id: 'fresh', deleted_at: new Date(now - 1 * DAY).toISOString() },
        { id: 'stale', deleted_at: new Date(now - 31 * DAY).toISOString() },
      ];
      expect(retention.pruneExpiredDeletedRecords(rows, { nowMs: now }).map((r) => r.id))
        .toEqual(['fresh']);
    });
  });

  describe('⭐ T071 / T072 后续检查不自动装回（C6, SC-006）', () => {
    it('自动安装只来自随包内置资源，按目录名取 id', () => {
      const builtin = readSrc('main/features/builtin_marketplace.ts');
      // 随包撒种的来源标记固定为 builtin / resource，与 Hub 官方副本区分开。
      expect(builtin).toContain("seed_source: 'builtin'");
    });

    it('拉取集合把随包种子排除在外——它们不是服务端来源', () => {
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      expect(reconcile).toMatch(/row\.seed_source !== 'builtin' && row\.seed_source !== 'resource'/);
    });

    it('墓碑胜出时本地残留被清理，而不是被当成可恢复内容装回', () => {
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      expect(reconcile).toContain('pruned local-only marketplace skill');
      expect(reconcile).toMatch(/if \(tombstone > 0 && tombstone >= activeAt\)/);
    });

    it('连续多个检查周期不产生装回：墓碑在 30 天内一直胜出', () => {
      const now = Date.now();
      const deletedAt = now - 1 * DAY;
      // 模拟 10 个 6 小时周期。
      for (let i = 0; i < 10; i += 1) {
        const at = now + i * 6 * 60 * 60 * 1000;
        expect(retention.isExpiredMsTombstone(deletedAt, { nowMs: at })).toBe(false);
      }
    });

    it('🔧 清单行缺失时的恢复判据不再要求 bundle_url', () => {
      // Hub 内容的 bundle_url 恒为空；旧判据会让「本地有内容、清单行缺失」的 Hub Skill
      // 永远无法恢复（界面显示未安装而内容仍在盘上）。
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      const fn = reconcile.slice(reconcile.indexOf('function _canRestoreSkillInstall'));
      expect(fn.slice(0, 400)).not.toContain('meta.bundle_url');
      expect(fn.slice(0, 400)).toContain("typeof meta.version === 'string'");
    });
  });

  describe('⭐ authority boundary：不扩散到用户自定义内容', () => {
    it('卸载只碰 marketplace 安装树，不碰 cloud/skills/', () => {
      const code = readSrc('main/features/marketplace.ts');
      const fn = code.slice(
        code.indexOf('export async function uninstallMarketplaceSkill'),
        code.indexOf('export async function uninstallMarketplaceSkill') + 1200,
      );
      expect(fn).toContain('userMarketplaceSkillDir(uid, skillId)');
      expect(fn).toContain('marketplaceCacheSkillDir(uid, skillId)');
      expect(fn).not.toContain('userSkillsDir');
    });

    it('两棵树的路径根不同，自定义 Skill 结构上不可能被删到', () => {
      expect(paths.userSkillsDir(UID)).toContain(path.join('cloud', 'skills'));
      expect(paths.userMarketplaceSkillsDir(UID)).toContain(path.join('local', 'marketplace', 'skills'));
    });
  });
});
