import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 登录 shell PATH 探测：macOS GUI 启动不读 `~/.zprofile`/`~/.zshrc`，
 * `process.env.PATH` 只是最小集合——CLI 发现层因此找不到用户自己装的命令。
 * 这里锁住探测器的边界：解析正确、幂等缓存、失败即回落（永不抛）、Windows 跳过。
 */

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

const mod = await import('../../../src/main/util/login-shell-env');

beforeEach(() => {
  mod._setLoginShellPathDirsForTest(null);
  warn.mockClear();
});

describe('login-shell-env', () => {
  it('parses PATH out of an `env -0` dump', () => {
    const dump = 'HOME=/Users/x\0PATH=/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin\0SHELL=/bin/zsh\0';
    expect(mod._parseEnvDumpPathForTest(dump)).toEqual(['/opt/homebrew/bin', '/Users/x/.local/bin', '/usr/bin']);
    expect(mod._parseEnvDumpPathForTest('HOME=/Users/x\0')).toEqual([]);
  });

  it('caches the probe and only keeps dirs the minimal env did not have', async () => {
    // 剔除基线取的是**本进程**的 PATH（GUI 启动时那个最小集合）。测试必须自己钉住它，
    // 否则断言就跟着跑测机器走：Windows runner 的 PATH 里没有 /usr/bin（且用 `;` 分隔），
    // 于是 /usr/bin 会被当成"登录 shell 额外带来的目录"留下来。
    const savedPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    try {
      const run = vi.fn(async () => `PATH=/usr/bin:/Users/x/company-bin:/opt/homebrew/bin\0`);
      const first = await mod.primeLoginShellPathDirs(run, 'darwin', '/Users/x');
      expect(run).toHaveBeenCalledOnce();
      // 与最小环境重复的 /usr/bin 被剔除（它本来就在继承的 PATH 里）
      expect(first).toContain('/Users/x/company-bin');
      expect(first).not.toContain('/usr/bin');

      // 幂等：第二次直接读缓存，不再起进程
      const second = await mod.primeLoginShellPathDirs(run, 'darwin', '/Users/x');
      expect(second).toEqual(first);
      expect(run).toHaveBeenCalledOnce();
      expect(mod.loginShellPathDirs()).toEqual(first);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it('falls back to no extras (and never throws) when the probe fails', async () => {
    const run = vi.fn(async () => { throw new Error('shell exited 127'); });
    await expect(mod.primeLoginShellPathDirs(run, 'darwin', '/Users/x')).resolves.toEqual([]);
    expect(mod.loginShellPathDirs()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('login shell PATH probe failed');
    // 失败也已缓存：不会每次 spawn 都重试起进程
    expect(run).toHaveBeenCalledOnce();
  });

  it('skips probing on Windows entirely', async () => {
    const run = vi.fn(async () => 'PATH=/c/bin\0');
    await expect(mod.primeLoginShellPathDirs(run, 'win32', 'C:\\Users\\x')).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns an empty list before the probe has run', () => {
    expect(mod.loginShellPathDirs()).toEqual([]);
  });
});
