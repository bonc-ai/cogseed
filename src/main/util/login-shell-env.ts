/**
 * 登录 shell 的 PATH（一次性探测 + 记忆化）。
 *
 * 为什么需要：macOS 上从 Dock/Finder 启动的 GUI 应用**不会**读 `~/.zprofile`
 * / `~/.zshrc`，`process.env.PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 这类最小集合。
 * 于是 CLI 发现层只能靠硬编码的常见目录（nvm/asdf/homebrew…）碰运气——用户自己在
 * 配置里加的目录（私有 bin、公司内网工具、其它版本管理器）全都找不到。
 * 这里的做法与做法参照的上游一致：启动时用**登录 shell** 跑一次 `env -0`，
 * 把真实的 PATH 取回来缓存；`buildCliSpawnEnv` 只读缓存（同步、不阻塞 spawn）。
 *
 * 边界：
 *   - 只在 macOS/Linux 探测；Windows 没有 login shell 概念，直接返回空（那边由
 *     `%APPDATA%\npm`、`%LOCALAPPDATA%\Programs\nodejs` 等约定目录覆盖）。
 *   - 有界：2.5s 超时 + 全部 try/catch。失败/超时都只缓存空结果，绝不抛出。
 *   - 只取 PATH，不采集其它环境变量（避免把用户的密钥类变量带进子进程决策）。
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';

import { createLogger } from '../logger';

const log = createLogger('login-shell-env');

const PROBE_TIMEOUT_MS = 2_500;

/** 未探测 = null；探测过（哪怕结果是空）= 数组。空数组也要记住，避免每次 spawn 重试。 */
let cached: string[] | null = null;

/** `env -0` 的输出（NUL 分隔的 KEY=VALUE），只取 PATH。 */
export function _parseEnvDumpPathForTest(dump: string): string[] {
  for (const entry of dump.split('\0')) {
    if (!entry.startsWith('PATH=')) continue;
    return entry
      .slice('PATH='.length)
      .split(':')
      .map((dir) => dir.trim())
      .filter(Boolean);
  }
  return [];
}

/** 缓存读取（`buildCliSpawnEnv` 用；未探测过返回空数组）。 */
export function loginShellPathDirs(): string[] {
  return cached ? cached.slice() : [];
}

/** 测试用：直接设定缓存（null = 回到未探测状态）。 */
export function _setLoginShellPathDirsForTest(dirs: string[] | null): void {
  cached = dirs === null ? null : dirs.slice();
}

function loginShell(): string {
  const shell = (process.env.SHELL || '').trim();
  if (shell) return shell;
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

function runEnvDump(shell: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ['-ilc', 'env -0'],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))),
    );
  });
}

/**
 * 探测一次并缓存。幂等：已探测过直接返回缓存（不重复起进程）。
 * 永不抛出——失败即"没有额外目录"，回落到硬编码约定目录。
 */
export async function primeLoginShellPathDirs(
  run: (shell: string) => Promise<string> = runEnvDump,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): Promise<string[]> {
  if (cached) return cached.slice();
  if (platform === 'win32') {
    cached = [];
    return [];
  }
  try {
    const dirs = _parseEnvDumpPathForTest(await run(loginShell()));
    // 去掉与最小环境重复的项，只保留"登录 shell 额外带来的"目录。
    const minimal = new Set((process.env.PATH || '').split(':').filter(Boolean));
    cached = dirs.filter((dir) => !minimal.has(dir));
    log.info(`login shell PATH probed: ${cached.length} extra dirs`);
  } catch (err) {
    cached = [];
    log.warn(`login shell PATH probe failed (falling back to conventional dirs): ${(err as Error).message}`);
  }
  // home 目前不参与解析，但保留参数以便将来按 home 过滤无关目录时无需改签名。
  void home;
  return cached.slice();
}
