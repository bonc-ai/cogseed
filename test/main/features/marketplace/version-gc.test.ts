import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord, CogSeedTaskStatus } from '../../../../src/main/features/cogseed_backend/types';
import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

// `paths.ts` 的 WS_ROOT 是模块级常量，装载后不再变：工作区必须在导入前建好且只建一次，
// 用例之间靠各自独立的 uid 隔离（与 version-store.test.ts 同一处理）。
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-version-gc-'));

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

const gc = await import('../../../../src/main/features/marketplace/version-gc');
const store = await import('../../../../src/main/features/marketplace/version-store');
const paths = await import('../../../../src/main/paths');

const CONTENT_ID = 'a1b2c3d4e5f6';
const DAY = 24 * 60 * 60 * 1000;

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_version_gc_${uidSeq}`;
  listCogSeedTasks.mockReset();
  listCogSeedTasks.mockResolvedValue([]);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function task(status: CogSeedTaskStatus, contentId: string, version: string): CogSeedTaskRecord {
  return {
    status,
    skillVersionPins: [{ skillId: contentId, version, manifestHash: 'h'.repeat(64) }],
  } as unknown as CogSeedTaskRecord;
}

/** 真写一份版本副本到磁盘。 */
async function writeCopy(version: string, contentId = CONTENT_ID): Promise<void> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const src = path.join(workspace, 'sources', UID, `${contentId}-${version}`);
  fs.mkdirSync(src, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(src, true);
  await store.writeVersionCopy(
    UID, { contentId, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
  );
}

function exists(version: string, contentId = CONTENT_ID): boolean {
  return fs.existsSync(paths.userMarketplaceVersionDir(UID, contentId, version));
}

/** 能判定 current 版本的解析器；用于把条件②从「判不出」变成可判定。 */
function currentIs(version: string | null): gc.CurrentVersionResolver {
  return async () => version;
}

describe('marketplace/version-gc', () => {
  describe('⭐ 四种情形只删第四种（FR-051 / FR-052，SC-009 误删数 0）', () => {
    it('被非终态钉固 / 被 recoverable 钉固 / 未过宽限期 / 已过宽限期 —— 只有最后一个被删', async () => {
      await writeCopy('1.0.0');  // 被 running 钉固
      await writeCopy('1.1.0');  // 被 recoverable 钉固
      await writeCopy('1.2.0');  // 无人钉固，未过宽限期
      await writeCopy('1.3.0');  // 无人钉固，已过宽限期
      await writeCopy('9.9.9');  // current 版本

      listCogSeedTasks.mockResolvedValue([
        task('running', CONTENT_ID, '1.0.0'),
        task('recoverable', CONTENT_ID, '1.1.0'),
      ]);

      // 1.2.0 仍在宽限期内：把时钟推到「刚好未过」。1.3.0 则靠单独一轮验证。
      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 3 * DAY,
        graceMs: 7 * DAY,
        resolveCurrentVersion: currentIs('9.9.9'),
      });

      expect(report.aborted).toBe(false);
      expect(report.deleted).toEqual([]);
      expect(report.kept.map((k) => `${k.version}:${k.reason}`).sort()).toEqual([
        '1.0.0:pinned', '1.1.0:pinned', '1.2.0:within-grace', '1.3.0:within-grace', '9.9.9:current',
      ]);
      for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '9.9.9']) expect(exists(v)).toBe(true);
    });

    it('时钟推过宽限期后，只有「无人钉固且非 current」的被删', async () => {
      await writeCopy('1.0.0');
      await writeCopy('1.1.0');
      await writeCopy('1.3.0');
      await writeCopy('9.9.9');

      listCogSeedTasks.mockResolvedValue([
        task('running', CONTENT_ID, '1.0.0'),
        task('recoverable', CONTENT_ID, '1.1.0'),
      ]);

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 8 * DAY,
        graceMs: 7 * DAY,
        resolveCurrentVersion: currentIs('9.9.9'),
      });

      expect(report.aborted).toBe(false);
      expect(report.deleted).toEqual([{ contentId: CONTENT_ID, version: '1.3.0' }]);
      expect(exists('1.3.0')).toBe(false);
      // ⭐ 误删数 0：被钉固的与 current 的都还在。
      expect(exists('1.0.0')).toBe(true);
      expect(exists('1.1.0')).toBe(true);
      expect(exists('9.9.9')).toBe(true);
    });

    it('⭐ recoverable 钉固的副本永不被删——它不是终态', async () => {
      await writeCopy('1.1.0');
      listCogSeedTasks.mockResolvedValue([task('recoverable', CONTENT_ID, '1.1.0')]);

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 365 * DAY,
        resolveCurrentVersion: currentIs('9.9.9'),
      });

      expect(report.deleted).toEqual([]);
      expect(report.kept[0].reason).toBe('pinned');
      expect(exists('1.1.0')).toBe(true);
    });

    it('终态 Task 钉固的副本不再受保护（过宽限期后可删）', async () => {
      await writeCopy('1.0.0');
      listCogSeedTasks.mockResolvedValue([task('completed', CONTENT_ID, '1.0.0')]);

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 8 * DAY,
        resolveCurrentVersion: currentIs('9.9.9'),
      });

      expect(report.deleted).toEqual([{ contentId: CONTENT_ID, version: '1.0.0' }]);
    });
  });

  describe('⭐ 默认解析器走 installed-version（T023 接入后的端到端）', () => {
    it('current 由本地落盘事实判定：v3 保留为 current，旧 v1 过宽限期后被删', async () => {
      // 真实的「已安装 v3」磁盘事实：内容就位 + _install.json 这个 success marker。
      const installDir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'SKILL.md'), '---\nname: x\n---\n');
      fs.writeFileSync(path.join(installDir, '_install.json'), JSON.stringify({
        version: '3.0.0', published_at: 1, installed_at: Date.now(), content_sha: 'sha-3',
      }));

      await writeCopy('1.0.0');
      await writeCopy('3.0.0');

      // 不注入 resolveCurrentVersion —— 走默认的 currentInstalledVersion。
      const report = await gc.runVersionGc(UID, { now: Date.now() + 8 * DAY });

      expect(report.aborted).toBe(false);
      expect(report.deleted).toEqual([{ contentId: CONTENT_ID, version: '1.0.0' }]);
      expect(report.kept.find((k) => k.version === '3.0.0')?.reason).toBe('current');
      expect(exists('3.0.0')).toBe(true);
      expect(exists('1.0.0')).toBe(false);
    });

    it('内容未安装（判不出 current）→ 默认解析器返回 null，一个都不删', async () => {
      await writeCopy('1.0.0');

      const report = await gc.runVersionGc(UID, { now: Date.now() + 365 * DAY });

      expect(report.deleted).toEqual([]);
      expect(report.kept[0].reason).toBe('current-unknown');
    });

    it('落盘未完成（无 success marker）→ 同样判不出，不删', async () => {
      const installDir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'SKILL.md'), '---\nname: x\n---\n');
      await writeCopy('1.0.0');

      const report = await gc.runVersionGc(UID, { now: Date.now() + 365 * DAY });

      expect(report.deleted).toEqual([]);
      expect(report.kept[0].reason).toBe('current-unknown');
    });
  });

  describe('条件②：current 版本判不出即不删（FR-052 的保守侧）', () => {
    it('显式用 unknownCurrentVersion → 一个都不删，原因是 current-unknown', async () => {
      await writeCopy('1.0.0');
      await writeCopy('1.3.0');

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 365 * DAY,
        resolveCurrentVersion: gc.unknownCurrentVersion,
      });

      expect(report.aborted).toBe(false);
      expect(report.deleted).toEqual([]);
      expect(report.kept.every((k) => k.reason === 'current-unknown')).toBe(true);
    });

    it('unknownCurrentVersion 的确返回 null，而不是猜一个版本', async () => {
      await expect(gc.unknownCurrentVersion(UID, CONTENT_ID)).resolves.toBeNull();
    });

    it('解析器抛错 → 整轮放弃，删除数 0', async () => {
      await writeCopy('1.3.0');

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 365 * DAY,
        resolveCurrentVersion: async () => { throw new Error('installed-version unavailable'); },
      });

      expect(report.aborted).toBe(true);
      expect(report.deleted).toEqual([]);
      expect(exists('1.3.0')).toBe(true);
    });
  });

  describe('⭐ 任何异常本轮删除数为 0（FR-053）', () => {
    it('pin 扫描不可信 → 整轮放弃，一个都不删', async () => {
      await writeCopy('1.3.0');
      listCogSeedTasks.mockRejectedValue(new Error('CogSeed task disappeared during recovery'));

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 365 * DAY,
        resolveCurrentVersion: currentIs('9.9.9'),
      });

      expect(report.aborted).toBe(true);
      expect(report.deleted).toEqual([]);
      expect(report.reason).toContain('not trustworthy');
      // 扫不出来 ≠ 没人钉固：副本必须原封不动。
      expect(exists('1.3.0')).toBe(true);
    });

    it('计划阶段不可信时不会进入删除阶段', async () => {
      await writeCopy('1.3.0');
      listCogSeedTasks.mockRejectedValue(new Error('boom'));
      const rm = vi.spyOn(fs.promises, 'rm');

      await gc.runVersionGc(UID, { now: Date.now() + 365 * DAY, resolveCurrentVersion: currentIs('9.9.9') });

      expect(rm).not.toHaveBeenCalled();
      rm.mockRestore();
    });

    it('meta.json 读不到 → 无法证明已过宽限期，保留而非删除', async () => {
      await writeCopy('1.3.0');
      fs.writeFileSync(paths.userMarketplaceVersionMetaFile(UID, CONTENT_ID, '1.3.0'), '{ broken');

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 365 * DAY,
        resolveCurrentVersion: currentIs('9.9.9'),
      });

      expect(report.deleted).toEqual([]);
      expect(report.kept[0].reason).toBe('meta-unreadable');
      expect(exists('1.3.0')).toBe(true);
    });

    it('删除中途失败即停止后续删除，并如实上报', async () => {
      await writeCopy('1.3.0');
      await writeCopy('1.4.0');
      const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('EPERM'));

      const report = await gc.runVersionGc(UID, {
        now: Date.now() + 8 * DAY,
        resolveCurrentVersion: currentIs('9.9.9'),
      });

      expect(report.aborted).toBe(true);
      expect(report.deleted).toEqual([]);
      expect(report.reason).toContain('EPERM');
      expect(rm).toHaveBeenCalledTimes(1);
      rm.mockRestore();
    });

    it('回收不抛错：失败一律以 aborted 表达', async () => {
      listCogSeedTasks.mockRejectedValue(new Error('boom'));
      await expect(gc.runVersionGc(UID)).resolves.toBeTruthy();
    });
  });

  describe('重启后 pin 仍有效，无需额外恢复逻辑（FR-033）', () => {
    it('同一批磁盘状态重复跑两轮，判定完全一致', async () => {
      await writeCopy('1.0.0');
      await writeCopy('1.3.0');
      listCogSeedTasks.mockResolvedValue([task('running', CONTENT_ID, '1.0.0')]);

      const opts = { now: Date.now() + 8 * DAY, resolveCurrentVersion: currentIs('9.9.9') };
      const first = await gc.collectVersionGcPlan(UID, opts);
      // 「重启」= 不做任何恢复动作，重新扫一遍磁盘。
      const second = await gc.collectVersionGcPlan(UID, opts);

      expect(second).toEqual(first);
      expect(first.decisions.find((d) => d.version === '1.0.0')).toMatchObject({ keep: true, reason: 'pinned' });
      expect(first.decisions.find((d) => d.version === '1.3.0')).toMatchObject({ keep: false });
    });
  });

  describe('⭐ T098 触发点：启动期一次 + 卸载后一次，不挂检查周期', () => {
    const SRC = path.resolve(__dirname, '../../../../src');
    const readSrc = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

    it('启动期注册了一次回收，且延迟到检查之后（回收无时效性）', () => {
      const index = readSrc('main/index.ts');
      expect(index).toContain("registerDeferred(\n      'marketplace:version-gc'");
      expect(index).toContain('const MARKETPLACE_VERSION_GC_DELAY_MS = 5 * 60 * 1000;');
      expect(index).toContain('MARKETPLACE_VERSION_GC_DELAY_MS,');
    });

    it('⚠️ 回收**不挂在 6 小时检查周期上**（FR-052）', () => {
      const index = readSrc('main/index.ts');
      const interval = index.slice(
        index.indexOf("registerDeferred('marketplace:reconcile-interval'"),
      ).slice(0, 700);
      expect(interval).not.toContain('version-gc');
      expect(interval).not.toContain('runVersionGc');
      // 对账函数体内也不得触发回收——那正是「使用高峰」。
      const reconcileRun = index.slice(
        index.indexOf('async function runMarketplaceInstallReconcile'),
      ).slice(0, 2500);
      expect(reconcileRun).not.toContain('runVersionGc');
    });

    it('卸载后触发一次，且与卸载解耦（不 await、失败不影响卸载）', () => {
      const code = readSrc('main/features/marketplace.ts');
      expect(code).toContain('void runVersionGcAfterUninstall(uid);');
      const helper = code.slice(
        code.indexOf('async function runVersionGcAfterUninstall'),
      ).slice(0, 800);
      expect(helper).toContain('await gc.runVersionGc(uid)');
      expect(helper).toContain('catch (err)');
      // 不向回收传任何策略——三条件与 fail-safe 由 version-gc 自己决定。
      expect(helper).not.toContain('graceMs');
      expect(helper).not.toContain('resolveCurrentVersion');
    });

    it('触发点恰好两处，GC scope 未被扩大', () => {
      const walk = (dir: string, out: string[] = []): string[] => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, out);
          else if (e.name.endsWith('.ts')) out.push(full);
        }
        return out;
      };
      const callers = walk(SRC)
        .filter((f) => !f.endsWith('version-gc.ts'))
        .filter((f) => fs.readFileSync(f, 'utf8').includes('runVersionGc('))
        .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
        .sort();
      expect(callers).toEqual(['main/features/marketplace.ts', 'main/index.ts']);
    });
  });

  describe('结构约束：复用唯一一份扫描', () => {
    it('本模块不自建扫描，只从 pin-scan 取在用集合', async () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/marketplace/version-gc.ts'), 'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

      expect(src).toContain("from './pin-scan'");
      // 不得绕过 pin-scan 直接读 Task，也不得维护引用计数。
      expect(src).not.toContain('task-store');
      expect(src).not.toMatch(/refCount|refcount/i);
    });

    it('pin 扫描只被调用一次，不在循环里重复扫', async () => {
      await writeCopy('1.0.0');
      await writeCopy('1.1.0');
      await writeCopy('1.2.0');
      listCogSeedTasks.mockResolvedValue([]);

      await gc.collectVersionGcPlan(UID, { resolveCurrentVersion: currentIs('9.9.9') });

      expect(listCogSeedTasks).toHaveBeenCalledTimes(1);
    });
  });
});
