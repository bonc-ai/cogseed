/**
 * Phase 13 / T118b：回滚演练的**数据侧**前置条件。
 *
 * `plan.md` 承诺了一条「可逆的本地回滚点」，但回滚里有一步是危险的：清理孤儿目录
 * `<uid>/local/marketplace/versions/`。它可能仍被**非终态 Task** 钉固——删早了，正在跑的
 * 使用就会读不到内容。因此清理**必须先确认无人钉固**，而这个判定要复用 `pin-scan.ts`
 * 的唯一一份扫描（T049a），不另起一套。
 *
 * 本文件把该前置条件在临时工作区里**实跑**一遍。清单与完整步骤见
 * `specs/010-hub-skill-client-lifecycle/rollback-rehearsal.md`。
 *
 * ⚠️ 代码侧的回退步骤（删新增目录、逐 hunk 还原既有文件）**不在此执行**——在有未提交
 * 成果的工作区里执行它等于销毁工作。那部分按 dry-run 核验，结论记在上述清单里。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';
import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-rollback-'));
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
const pinScan = await import('../../../../src/main/features/marketplace/pin-scan');
const installed = await import('../../../../src/main/features/marketplace/installed-version');
const paths = await import('../../../../src/main/paths');

const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_rb_${uidSeq}`;
  listCogSeedTasks.mockReset();
  listCogSeedTasks.mockResolvedValue([]);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function landVersionCopy(version: string): Promise<void> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const src = path.join(workspace, 'sources', UID, version);
  fs.mkdirSync(src, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(src, true);
  await store.writeVersionCopy(
    UID, { contentId: CONTENT_ID, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
  );
}

function setCurrentInstall(version: string): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(),
  }));
}

function task(status: string, version: string): CogSeedTaskRecord {
  return {
    status,
    skillVersionPins: [{ skillId: CONTENT_ID, version, manifestHash: '' }],
  } as unknown as CogSeedTaskRecord;
}

/**
 * 回滚清理的**唯一判据**：`versions/` 里还有没有副本被在用集合命中。
 *
 * 复用 `pin-scan.ts` 的唯一一份扫描；扫描不可信时返回「不安全」——拿不准就不删，
 * 与回收侧同一个保守方向。
 */
async function safeToRemoveVersionsTree(uid: string): Promise<{ safe: boolean; reason: string }> {
  const scan = await pinScan.scanActivePins(uid);
  if (!scan.trustworthy) return { safe: false, reason: `pin scan not trustworthy: ${scan.reason ?? 'unknown'}` };
  const pinned = store.listVersionCopies(uid)
    .filter((copy) => scan.inUse.has(pinScan.pinKey(copy.contentId, copy.version)));
  return pinned.length === 0
    ? { safe: true, reason: 'no active pin points into the versions tree' }
    : { safe: false, reason: `${pinned.length} version copy still pinned` };
}

describe('T118b 回滚演练（数据侧实跑）', () => {
  describe('⭐ 清理孤儿 `versions/` 前必须确认无非终态 pin', () => {
    it('非终态 Task 钉固时判定为**不安全**，不清理', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      listCogSeedTasks.mockResolvedValue([task('running', '1.0.0')]);

      const verdict = await safeToRemoveVersionsTree(UID);

      expect(verdict.safe).toBe(false);
      expect(verdict.reason).toContain('still pinned');
    });

    it('⚠️ `recoverable` 同样拦住清理（它不是终态）', async () => {
      await landVersionCopy('1.0.0');
      listCogSeedTasks.mockResolvedValue([task('recoverable', '1.0.0')]);

      expect((await safeToRemoveVersionsTree(UID)).safe).toBe(false);
    });

    it('⚠️ 扫描不可信时判定为不安全 —— 拿不准就不删', async () => {
      await landVersionCopy('1.0.0');
      listCogSeedTasks.mockRejectedValue(new Error('task store unavailable'));

      const verdict = await safeToRemoveVersionsTree(UID);

      expect(verdict.safe).toBe(false);
      expect(verdict.reason).toContain('not trustworthy');
    });

    it('全部终态时判定为安全', async () => {
      await landVersionCopy('1.0.0');
      await landVersionCopy('2.0.0');
      listCogSeedTasks.mockResolvedValue([
        task('completed', '1.0.0'), task('failed', '2.0.0'), task('cancelled', '1.0.0'),
      ]);

      expect(await safeToRemoveVersionsTree(UID)).toMatchObject({ safe: true });
    });
  });

  describe('⭐ 实跑一次：安全时清理，之后客户端仍可用', () => {
    it('删除 `versions/` 后 current install 仍在、仍可判定版本', async () => {
      await landVersionCopy('1.0.0');
      await landVersionCopy('2.0.0');
      setCurrentInstall('2.0.0');
      listCogSeedTasks.mockResolvedValue([task('completed', '1.0.0')]);

      const verdict = await safeToRemoveVersionsTree(UID);
      expect(verdict.safe).toBe(true);

      // 实跑清理。
      fs.rmSync(paths.userMarketplaceVersionsDir(UID), { recursive: true, force: true });

      // 回滚后的客户端：安装树完好，版本判定仍走同一入口。
      expect(fs.existsSync(paths.userMarketplaceVersionsDir(UID))).toBe(false);
      expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID))).toBe(true);
      expect(installed.installedVersionOf(UID, CONTENT_ID)).toBe('2.0.0');
      // 副本没了，因此该内容不再被判为 Hub 托管——pin 分派会走回创作流原路径，
      // 这正是回滚到基线该有的样子。
      expect(store.listVersionCopies(UID, CONTENT_ID)).toEqual([]);
      expect(store.hubPinIdentity(UID, CONTENT_ID)).toBeNull();
    });

    it('⚠️ 两棵树互不牵连：清理副本不会顺手删掉用户已安装的内容', async () => {
      await landVersionCopy('1.0.0');
      setCurrentInstall('1.0.0');
      const installDir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      const versionsDir = paths.userMarketplaceVersionsDir(UID);

      expect(installDir.startsWith(versionsDir)).toBe(false);
      fs.rmSync(versionsDir, { recursive: true, force: true });
      expect(fs.existsSync(path.join(installDir, 'SKILL.md'))).toBe(true);
    });
  });
});
