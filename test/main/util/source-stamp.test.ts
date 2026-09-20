/**
 * source-stamp —— dev 半更新检测（"主进程加载的代码早于磁盘"）。
 *
 * 真机事故回归面：主进程 09:26 启动、渲染层 10:09 才启动，中间 main 源码被改过，
 * 于是界面把新参数 `doc` 发给旧主进程 → 旧主进程静默忽略 → 整库脑图冒充"本文档脑图"。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computeSourceStamp,
  isMainSourceStale,
  processStartedAtMs,
  resolveMainSourceStamp,
  buildStaleMainReport,
} from '../../../src/main/util/source-stamp';

let root: string;

function write(rel: string, body = 'x', mtimeMs?: number): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  if (mtimeMs != null) fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
  return abs;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-stamp-'));
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('computeSourceStamp', () => {
  it('取源码文件里最新的 mtime，并统计文件数', () => {
    write('src/main/a.ts', 'a', 1_700_000_000_000);
    write('src/main/nested/b.cjs', 'b', 1_700_000_500_000);
    const stamp = computeSourceStamp([path.join(root, 'src', 'main')]);
    expect(stamp).not.toBeNull();
    expect(stamp!.files).toBe(2);
    expect(stamp!.maxMtimeMs).toBe(1_700_000_500_000);
  });

  it('忽略非源码与 node_modules/dist（避免噪声把"过期"判错）', () => {
    write('src/main/a.ts', 'a', 1_700_000_000_000);
    write('src/main/readme.md', 'md', 1_800_000_000_000);
    write('src/main/node_modules/dep/index.js', 'js', 1_900_000_000_000);
    write('src/main/dist/bundle.js', 'js', 1_900_000_000_000);
    const stamp = computeSourceStamp([path.join(root, 'src', 'main')]);
    expect(stamp!.files).toBe(1);
    expect(stamp!.maxMtimeMs).toBe(1_700_000_000_000);
  });

  it('单个文件路径也认（bootstrap.cjs 这类根文件）', () => {
    const boot = write('bootstrap.cjs', 'x', 1_700_000_123_000);
    const stamp = computeSourceStamp([boot]);
    expect(stamp).toEqual({ files: 1, maxMtimeMs: 1_700_000_123_000 });
  });

  it('扫不到源码 → null（打包版必须据此关闭检测，不能误报）', () => {
    fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
    expect(computeSourceStamp([path.join(root, 'empty')])).toBeNull();
    expect(computeSourceStamp([path.join(root, 'not-exist')])).toBeNull();
    expect(computeSourceStamp([null, undefined])).toBeNull();
  });
});

describe('isMainSourceStale', () => {
  const started = 1_700_000_000_000;

  it('磁盘源码晚于进程启动 → 过期（这就是真机那次的形态）', () => {
    expect(isMainSourceStale({ files: 800, maxMtimeMs: started + 55 * 60_000 }, started)).toBe(true);
  });

  it('源码早于或等于启动时刻 → 不过期', () => {
    expect(isMainSourceStale({ files: 800, maxMtimeMs: started - 1000 }, started)).toBe(false);
    expect(isMainSourceStale({ files: 800, maxMtimeMs: started }, started)).toBe(false);
  });

  it('容差内的抖动不算过期（mtime 粒度 / 启动瞬间的写入）', () => {
    expect(isMainSourceStale({ files: 800, maxMtimeMs: started + 1500 }, started)).toBe(false);
    expect(isMainSourceStale({ files: 800, maxMtimeMs: started + 2500 }, started)).toBe(true);
  });

  it('stamp 不可用或启动时刻非法 → 一律不过期（宁可漏报不可误报）', () => {
    expect(isMainSourceStale(null, started)).toBe(false);
    expect(isMainSourceStale({ files: 1, maxMtimeMs: started + 60_000 }, 0)).toBe(false);
    expect(isMainSourceStale({ files: 1, maxMtimeMs: started + 60_000 }, Number.NaN)).toBe(false);
  });
});

describe('processStartedAtMs', () => {
  it('用 now - uptime 还原进程启动时刻', () => {
    expect(processStartedAtMs(1_700_000_100_000, 100)).toBe(1_700_000_000_000);
    expect(processStartedAtMs(1_700_000_100_000, 0)).toBe(1_700_000_100_000);
  });
});

describe('resolveMainSourceStamp（真实仓库）', () => {
  it('能扫到本仓库的 src/main 源码', () => {
    const pcRoot = path.resolve(__dirname, '..', '..', '..');
    const stamp = resolveMainSourceStamp(pcRoot);
    expect(stamp).not.toBeNull();
    expect(stamp!.files).toBeGreaterThan(100);
    expect(stamp!.maxMtimeMs).toBeGreaterThan(1_600_000_000_000);
  });
});

describe('buildStaleMainReport（cogseed.env 载荷）', () => {
  const pcRoot = path.resolve(__dirname, '..', '..', '..');

  /**
   * 真机事故复现：主进程 2026-09-16 09:26:26 启动，main 源码在那之后被改过
   * （kb_mindmap.ts 10:21、kb_summary.ts 10:21）。当时的检测器必须判为「过期」，
   * 否则用户就只会拿到一张错的脑图而不明所以。
   */
  it('用真机启动时刻（09:26:26）跑 → 判为过期（这次事故会被拦下）', () => {
    const report = buildStaleMainReport({
      pcRoot,
      isPackaged: false,
      startedAtMs: Date.parse('2026-09-16T09:26:26+08:00'),
    });
    expect(report.mainSourceFiles).toBeGreaterThan(100);
    expect(report.mainSourceChangedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.mainSourceStale).toBe(true);
  });

  it('刚启动（启动时刻晚于全部源码改动）→ 不报', () => {
    const report = buildStaleMainReport({
      pcRoot,
      isPackaged: false,
      startedAtMs: Date.now() + 60_000,
    });
    expect(report.mainSourceStale).toBe(false);
    expect(report.mainSourceFiles).toBeGreaterThan(100);
  });

  it('打包版 → 一律不适用且不报警（生产不能出现这种横幅）', () => {
    const report = buildStaleMainReport({
      pcRoot,
      isPackaged: true,
      startedAtMs: Date.parse('2020-01-01T00:00:00Z'),
    });
    expect(report).toEqual({
      processStartedAtMs: Date.parse('2020-01-01T00:00:00Z'),
      mainSourceFiles: null,
      mainSourceChangedAt: null,
      mainSourceStale: false,
    });
  });

  it('未传启动时刻时按 now - uptime 自行推算', () => {
    const report = buildStaleMainReport({ pcRoot, isPackaged: false, now: 1_700_000_100_000, uptimeSec: 100 });
    expect(report.processStartedAtMs).toBe(1_700_000_000_000);
  });
});
