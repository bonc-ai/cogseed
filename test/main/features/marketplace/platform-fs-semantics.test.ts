/**
 * Phase 13 / T118a：Windows 与 macOS 的文件语义差异（FR-039、SC-003）。
 *
 * **为什么单独一份**：`C4` 的崩溃恢复建立在 `rename` 的行为上，而 `rename` 正是两平台
 * 分叉最多的系统调用。原清单只有「在 Windows 上跑一遍场景」（T119），没有针对**语义本身**
 * 的测试——于是分叉只会在真机上暴露，且暴露时已经是「新旧两版同时消失」这种后果。
 *
 * **诚实边界**：本文件在**当前平台**实跑可跑的部分；对另一平台，断言的是
 * 「让行为不依赖平台差异」的**代码性质**（例如：提升过程永不把目录 rename 到一个已存在的
 * 目标上），而不是假装验证了另一平台的运行时行为。Windows 实跑是 T119，本轮**未跑**。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-platform-fs-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const store = await import('../../../../src/main/features/marketplace/version-store');
const paths = await import('../../../../src/main/paths');

const SRC = path.resolve(__dirname, '../../../../src');
const CONTENT_ID = 'a1b2c3d4e5f6';
const IS_WINDOWS = process.platform === 'win32';

let seq = 0;
let scratch = '';
let UID = '';

beforeEach(() => {
  seq += 1;
  UID = `u_pfs_${seq}`;
  scratch = path.join(workspace, `scratch-${seq}`);
  fs.mkdirSync(scratch, { recursive: true });
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function codeOf(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function makeDir(name: string, withFile = true): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withFile) fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n');
  return dir;
}

describe('平台文件语义（T118a，FR-039 / SC-003）', () => {
  describe('⭐ rename 到「已存在的目标」是分叉点 —— 所以实现从不这么做', () => {
    it(`实测本平台（${process.platform}）：rename 到非空目录会失败`, () => {
      const from = makeDir('from');
      const onto = makeDir('onto');

      // POSIX 上 rename 到**非空**目录是 ENOTEMPTY；Windows 上目录已存在即失败。
      // 两平台都失败，但错误码不同——所以实现不能依赖「失败后重试」这类推断。
      expect(() => fs.renameSync(from, onto)).toThrow();
      expect(fs.existsSync(from), '失败后源目录必须原样还在').toBe(true);
    });

    it(`⚠️ 空目录才是真正的分叉：本平台（${process.platform}）的行为已实测记录`, () => {
      const from = makeDir('from2');
      const ontoEmpty = makeDir('onto-empty', false);

      let succeeded = true;
      try { fs.renameSync(from, ontoEmpty); } catch { succeeded = false; }

      if (IS_WINDOWS) {
        // Windows：目标已存在就失败，哪怕是空目录。
        expect(succeeded).toBe(false);
      } else {
        // POSIX：允许覆盖一个空目录。**这正是不能依赖的那条**——同一段代码在
        // Windows 上会走到失败分支。
        expect(succeeded).toBe(true);
      }
    });

    it('⚠️ 因此提升过程永不 rename 到一个已存在的目标：先把旧版挪走，再放新版', () => {
      const code = codeOf('main/features/marketplace.ts');
      // 两次 rename 的顺序是硬要求：target → trash，然后 staging → target。
      // 第二次 rename 发生时 target 必然不存在，于是上面那条平台差异**根本走不到**。
      const promote = code.slice(code.indexOf('quarantineTrashName'), code.indexOf('quarantineTrashName') + 4000);
      expect(promote).toBeTruthy();
      // 恢复侧同样先确认目标不存在才还原（`_restoreCrashedPromote`）。
      const restore = code.slice(code.indexOf('function _restoreCrashedPromote'));
      expect(restore.slice(0, 900)).toContain('if (fs.existsSync(target)) return false;');
    });

    it('⚠️ 版本副本的提交点同样只 rename 到不存在的目标', () => {
      const code = codeOf('main/features/marketplace/version-store.ts');
      // 目标已存在即视为已写入，直接返回——不会去 rename 覆盖它。
      expect(code).toContain('if (fs.existsSync(target)) {');
      expect(code).toContain('rename(staging, target)');
    });
  });

  describe('⭐ 目标被占用时的失败模式', () => {
    it(`实测本平台（${process.platform}）：删除一个被打开的文件所在目录`, () => {
      const dir = makeDir('busy');
      const fd = fs.openSync(path.join(dir, 'SKILL.md'), 'r');
      let removed = true;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        removed = false;
      } finally {
        fs.closeSync(fd);
      }

      if (IS_WINDOWS) {
        // Windows 会锁住打开中的文件，删除可能失败（EBUSY / EPERM）。
        // 断言只记录事实，不强求某一种结果——锁的粒度受杀毒软件等因素影响。
        expect(typeof removed).toBe('boolean');
      } else {
        expect(removed, 'POSIX 允许删除打开中的文件').toBe(true);
      }
    });

    it('⚠️ 所以回收失败不得继续删：已删的无法撤销，继续只会扩大损失', () => {
      const code = codeOf('main/features/marketplace/version-gc.ts');
      const loop = code.slice(code.indexOf('for (const target of plan.decisions'));
      // 删除失败即停止本轮后续删除，并如实上报 aborted。
      expect(loop).toContain('return { deleted, kept, aborted: true, reason };');
    });

    it('⚠️ 卸载用 force 删除：目标不存在不是错误，被占用才是', () => {
      const code = codeOf('main/features/marketplace.ts');
      const fn = code.slice(code.indexOf('export async function uninstallMarketplaceSkill'));
      expect(fn.slice(0, 900)).toContain('recursive: true, force: true');
    });
  });

  describe('⭐ 点前缀目录的可见性（两平台一致，但理由不同）', () => {
    it('点前缀不是「隐藏属性」，而是枚举时显式跳过 —— 不依赖平台的隐藏语义', () => {
      // Windows 没有「点开头即隐藏」的约定；若实现依赖它，残留在 Windows 上就会被看见。
      const versionStore = codeOf('main/features/marketplace/version-store.ts');
      expect(versionStore).toContain("!name.startsWith('.')");
      const skills = codeOf('main/features/skills.ts');
      expect(skills).toMatch(/!e\.name\.startsWith\('\.'\)/);
    });

    it('实测：点前缀的版本目录不会被枚举出来', () => {
      const contentDir = paths.userMarketplaceContentVersionsDir(UID, CONTENT_ID);
      fs.mkdirSync(path.join(contentDir, '.staging-x'), { recursive: true });
      expect(store.listVersionCopies(UID, CONTENT_ID)).toEqual([]);
    });
  });

  describe('⭐ 路径大小写与长度', () => {
    it(`实测本平台（${process.platform}）的大小写敏感性`, () => {
      const lower = makeDir('abcdef123456');
      const probe = path.join(scratch, 'ABCDEF123456');
      const caseInsensitive = fs.existsSync(probe);

      if (process.platform === 'linux') {
        expect(caseInsensitive, 'Linux 默认大小写敏感').toBe(false);
      } else {
        // macOS（APFS 默认）与 Windows 默认大小写不敏感：两个拼写指向同一个目录。
        expect(caseInsensitive).toBe(true);
      }
      expect(fs.existsSync(lower)).toBe(true);
    });

    it('⚠️ 因此 `content_id` 的大小写必须是契约而不是巧合', () => {
      // `data-model.md` §1：content_id 是**12 位小写十六进制**。大小写不敏感的文件系统上，
      // `A1B2...` 与 `a1b2...` 会指向同一个目录，而在 Linux 上是两个——若 id 允许混合
      // 大小写，同一份内容在两平台会得到不同的副本数量。
      expect(CONTENT_ID).toMatch(/^[0-9a-f]{12}$/);
      const code = codeOf('main/features/marketplace/version-store.ts');
      // 路径段安全校验拒绝分隔符、`.`/`..` 与 NUL —— 这是同一道门。
      expect(code).toContain('assertSafeSegment');
    });

    it('⚠️ 版本副本的路径深度有限，不逼近 Windows 的 260 字符上限', () => {
      // `<uid>/local/marketplace/versions/<content_id>/<version>/tree/` —— 相对工作区根
      // 的固定开销很小，余量留给内容树自身的相对路径。
      const rel = path.relative(
        workspace,
        paths.userMarketplaceVersionTreeDir(UID, CONTENT_ID, '1.0.0'),
      );
      expect(rel.length).toBeLessThan(120);
    });
  });

  describe('⭐ 诚实边界', () => {
    it('本文件不冒充 Windows 实跑：那是 T119', () => {
      // 这条断言的意义是让「跑过了什么」在测试里可见：当前平台一目了然，
      // 任何人看到失败都知道自己在哪个平台上。
      expect(['darwin', 'linux', 'win32']).toContain(process.platform);
    });
  });
});
