import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `paths.ts` 的 WS_ROOT 是模块级常量：工作区在导入前建好且只建一次，用例按 uid 隔离。
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-crash-recovery-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../../src/main/util/retry', () => ({
  fetchWithRetry: vi.fn(),
  fetchAndReadWithRetry: vi.fn(),
  serverErrorEnvelopeOf: () => null,
}));

const marketplace = await import('../../../../src/main/features/marketplace');
const paths = await import('../../../../src/main/paths');

const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_crash_${uidSeq}`;
  fs.mkdirSync(paths.userMarketplaceSkillsDir(UID), { recursive: true });
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function skillsRoot(): string {
  return paths.userMarketplaceSkillsDir(UID);
}

/** 写一棵内容树（带 success marker），代表「某一版已在盘上」。 */
function writeTree(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, 'scripts', 'ok.sh'), '#!/bin/sh\necho ok\n');
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(),
  }));
}

/**
 * 复刻「promote 两次 rename 之间进程终止」后的磁盘状态：
 *   `rename(target → .trash-*)` 已完成，`rename(staging → target)` 未执行。
 * 此时旧版内容的**唯一副本**只在 `.trash-*` 里，`target` 不存在。
 */
function crashBetweenRenames(oldVersion: string): string {
  const trash = path.join(skillsRoot(), marketplace.quarantineTrashName(CONTENT_ID, 'deadbeefcafe'));
  writeTree(trash, oldVersion);
  return trash;
}

describe('marketplace 崩溃恢复（发现 15 / FR-039 / C4）', () => {
  describe('⭐ T050 回归：崩溃后旧版必须仍然可用', () => {
    it('target 缺失 + 有 .trash-* → 启动期清理必须**恢复**旧版，而不是把它一并删掉', () => {
      crashBetweenRenames('1.0.0');
      const target = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      expect(fs.existsSync(target)).toBe(false);

      marketplace.cleanupOrphanedStagingDirs(UID);

      // 基线行为是 `.trash-*` 一律删除 → 新旧两版同时消失、target 从未恢复。
      expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('version: 1.0.0');
      expect(fs.existsSync(path.join(target, 'scripts', 'ok.sh'))).toBe(true);
      // 恢复之后不再留残留。
      expect(fs.readdirSync(skillsRoot()).filter((n) => n.startsWith('.trash-'))).toEqual([]);
    });
  });

  describe('T052 三种组合', () => {
    it('① target 缺失 + 有 .trash-* → 恢复', () => {
      crashBetweenRenames('1.0.0');
      marketplace.cleanupOrphanedStagingDirs(UID);
      expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir(UID, CONTENT_ID), 'SKILL.md'))).toBe(true);
    });

    it('② target 已存在 + 有 .trash-* → 删 trash，不动 target', () => {
      const target = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      writeTree(target, '2.0.0');
      crashBetweenRenames('1.0.0');

      marketplace.cleanupOrphanedStagingDirs(UID);

      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('version: 2.0.0');
      expect(fs.readdirSync(skillsRoot()).filter((n) => n.startsWith('.trash-'))).toEqual([]);
    });

    it('③ .staging-* 任何情况下一律删除（未验证内容不得留存）', () => {
      const staging = path.join(skillsRoot(), marketplace.quarantineStagingName('feedfacefeed'));
      writeTree(staging, '3.0.0');
      const target = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      writeTree(target, '2.0.0');

      marketplace.cleanupOrphanedStagingDirs(UID);

      expect(fs.existsSync(staging)).toBe(false);
      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('version: 2.0.0');
    });

    it('③b target 缺失时 .staging-* 也不得被当成可恢复内容', () => {
      const staging = path.join(skillsRoot(), marketplace.quarantineStagingName('feedfacefeed'));
      writeTree(staging, '3.0.0');

      marketplace.cleanupOrphanedStagingDirs(UID);

      expect(fs.existsSync(staging)).toBe(false);
      // staging 里的内容**未通过质量门与安全扫描**，恢复它等于把未验证内容装上。
      expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID))).toBe(false);
    });
  });

  describe('恢复的边界', () => {
    it('无法从名字解析出 content_id 的旧式 .trash-* 仍然删除（不猜目标）', () => {
      const legacy = path.join(skillsRoot(), '.trash-deadbeef');
      writeTree(legacy, '1.0.0');

      marketplace.cleanupOrphanedStagingDirs(UID);

      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID))).toBe(false);
    });

    it('trash 里没有 SKILL.md 时不恢复——那不是一份可用内容', () => {
      const trash = path.join(skillsRoot(), marketplace.quarantineTrashName(CONTENT_ID, 'deadbeefcafe'));
      fs.mkdirSync(trash, { recursive: true });
      fs.writeFileSync(path.join(trash, 'notes.txt'), 'partial');

      marketplace.cleanupOrphanedStagingDirs(UID);

      expect(fs.existsSync(trash)).toBe(false);
      expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID))).toBe(false);
    });

    it('恢复后的目录用的是正式名，不再带点前缀（崩溃残留不得被 loader 可见的意图保留）', () => {
      crashBetweenRenames('1.0.0');
      marketplace.cleanupOrphanedStagingDirs(UID);

      const names = fs.readdirSync(skillsRoot());
      expect(names).toContain(CONTENT_ID);
      expect(names.filter((n) => n.startsWith('.'))).toEqual([]);
    });
  });

  describe('trash 名字必须能定位它属于哪个内容', () => {
    it('quarantineTrashName 把 content_id 编进名字，且仍是点前缀', () => {
      const name = marketplace.quarantineTrashName(CONTENT_ID, 'deadbeefcafe');
      expect(name.startsWith('.trash-')).toBe(true);
      expect(name).toContain(CONTENT_ID);
      expect(marketplace.contentIdFromTrashName(name)).toBe(CONTENT_ID);
    });

    it('旧式名字解析为 null，调用方据此选择删除而不是乱恢复', () => {
      expect(marketplace.contentIdFromTrashName('.trash-deadbeef')).toBeNull();
      expect(marketplace.contentIdFromTrashName('.staging-deadbeef')).toBeNull();
    });

    it('content_id 含连字符时仍能正确解析（按最后一段 hex 切分）', () => {
      const weird = 'a1b2-c3d4-e5f6';
      const name = marketplace.quarantineTrashName(weird, 'deadbeefcafe');
      expect(marketplace.contentIdFromTrashName(name)).toBe(weird);
    });
  });
});
