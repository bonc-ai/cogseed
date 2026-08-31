#!/usr/bin/env node
/**
 * diagnose-local-agents.mjs — 外部（本地 CLI）Agent 故障诊断脚本
 *
 * 用途
 * ----
 * 当用户反馈「外部 Agent 用不了」时，在本机（或用户机器上）运行本脚本，
 * 输出一份完整诊断报告，定位到底是哪一环断了：
 *
 *   1. 二进制找不到        → CLI 未安装 / 不在 PATH / 装在 GUI 应用看不到的位置
 *   2. 版本探测失败/过低   → 版本太老（低于 MIN_VERSIONS）或 --version 被挂起
 *   3. 缺少凭据配置        → 从未登录 / settings.json、auth.json 缺失或为空
 *   4. 配置指向本地代理    → baseUrl 指向 CC Switch 等本地代理，但代理没在运行
 *   5. 终端能跑、App 里不能 → PATH 只在 shell 配置文件里（GUI 启动不加载）
 *   6. App 里显示了本机没有的 Agent → 应用数据里的 agent.json 绑定了本机
 *      不存在的 CLI（例如从另一台机器同步过来的外部 Agent）
 *
 * 运行方式
 * ----
 *   node scripts/diagnose-local-agents.mjs            # 本机全量诊断
 *   node scripts/diagnose-local-agents.mjs --json     # 机器可读输出
 *   node scripts/diagnose-local-agents.mjs --only claude,codex
 *   node scripts/diagnose-local-agents.mjs --export-expected ./known-good.json
 *   node scripts/diagnose-local-agents.mjs --expected ./known-good.json
 *
 * 与 App 检测逻辑的对应关系（改 App 侧逻辑时请同步这里）：
 *   - 二进制查找     → src/main/features/local_agents/{registry,which}.ts
 *   - 版本探测       → src/main/features/local_agents/version.ts + spawn-command.ts
 *   - 凭据/配置读取  → src/main/features/local_agents/{auth-state,active_config}.ts
 *   - 端点可达性     → active_config.ts::probeModelEndpointReachable
 *
 * 安全：本脚本只读，绝不修改任何配置；输出中密钥/令牌一律脱敏
 * （只显示前 4 + 后 4 字符和长度）。--export-expected 导出的快照同样脱敏。
 *
 * 本脚本为纯 Node（无第三方依赖），复制到任何有 Node 的机器即可运行。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// 常量 —— 镜像 src/main/features/local_agents/registry.ts
// ─────────────────────────────────────────────────────────────────────────────

/** 规范 CLI 类型名。 */
export const CLI_TYPES = Object.freeze(['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy']);

/** 每种 CLI 的默认可执行文件名。 */
export const BIN_NAMES = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  openclaw: 'openclaw',
  opencode: 'opencode',
  hermes: 'hermes',
  // WorkBuddy 的 CLI 是 App 内置的 `codebuddy`，不在 PATH 上。
  workbuddy: 'codebuddy',
});

/** 覆盖二进制路径的环境变量。 */
export const ENV_KEYS = Object.freeze({
  claude: 'COGSEED_CLAUDE_PATH',
  codex: 'COGSEED_CODEX_PATH',
  openclaw: 'COGSEED_OPENCLAW_PATH',
  opencode: 'COGSEED_OPENCODE_PATH',
  hermes: 'COGSEED_HERMES_PATH',
  workbuddy: 'COGSEED_WORKBUDDY_PATH',
});

/** 每种 CLI 的版本探测命令（按兼容顺序）。 */
export const VERSION_PROBES = Object.freeze({
  claude: [['--version']],
  codex: [['--version']],
  openclaw: [['--version']],
  opencode: [['--version']],
  // hermes 的 `version` 子命令在无 TTY 时可能挂起，`--version` 必须排第一。
  hermes: [['--version'], ['version']],
  workbuddy: [['--version']],
});

/** 最低版本门槛（镜像 version.ts；缺省 = 无门槛）。 */
export const MIN_VERSIONS = Object.freeze({
  claude: '2.0.0',
  codex: '0.100.0',
});

/** 版本探测超时（与 App 一致）。 */
export const VERSION_PROBE_TIMEOUT_MS = 5000;
/** 本地代理 TCP 探测超时。 */
export const ENDPOINT_PROBE_TIMEOUT_MS = 800;

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：semver
// ─────────────────────────────────────────────────────────────────────────────

const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;

/** 解析字符串中第一个 MAJOR.MINOR.PATCH；失败返回 null。 */
export function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** 字典序比较。 */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** 低于最低版本时返回原因字符串，否则返回 null。 */
export function checkMinVersion(cli, detected) {
  const minRaw = MIN_VERSIONS[cli];
  if (!minRaw || !detected) return null;
  const min = parseSemver(minRaw);
  const got = parseSemver(detected);
  if (!min || !got) return null;
  if (compareSemver(got, min) < 0) {
    return `${cli} ${detected} 低于要求的最低版本 ${minRaw}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：脱敏
// ─────────────────────────────────────────────────────────────────────────────

/** 密钥脱敏：只保留前 4 + 后 4 字符和长度。 */
export function redactSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '(empty)';
  if (value.length <= 8) return `***(${value.length})`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (len ${value.length})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：搜索目录（镜像 registry.ts::localCliSearchDirs / expandSearchDirs）
// ─────────────────────────────────────────────────────────────────────────────

/** 每个 CLI 在 PATH 之外的候选安装目录。 */
export function localCliSearchDirs(type, platform = process.platform, env = process.env, home = os.homedir()) {
  const dirs = [];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || (home ? path.win32.join(home, 'AppData', 'Local') : '');
    const appData = env.APPDATA || (home ? path.win32.join(home, 'AppData', 'Roaming') : '');
    if (appData) dirs.push(path.win32.join(appData, 'npm'));
    if (localAppData) {
      dirs.push(path.win32.join(localAppData, 'Microsoft', 'WindowsApps'));
      dirs.push(path.win32.join(localAppData, 'pnpm'));
    }
    if (home) dirs.push(path.win32.join(home, '.local', 'bin'));
    if (env.VOLTA_HOME) dirs.push(path.win32.join(env.VOLTA_HOME, 'bin'));
    if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);
    if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
    if (type === 'codex' && localAppData) {
      dirs.push(path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
      // OpenAI Codex Windows App keeps the CLI under bin/<hash>/codex.exe,
      // outside PATH and npm; the `*` segment expands over version dirs.
      dirs.push(path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin', '*'));
    }
    if (type === 'workbuddy' && localAppData) {
      dirs.push(path.win32.join(localAppData, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin'));
      // Some installers use %LOCALAPPDATA%\WorkBuddy directly (no "Programs").
      dirs.push(path.win32.join(localAppData, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin'));
      // Layout variants (resources\<layer>\cli\bin and direct cli\bin).
      dirs.push(path.win32.join(localAppData, 'Programs', 'WorkBuddy', 'resources', '*', 'cli', 'bin'));
      dirs.push(path.win32.join(localAppData, 'WorkBuddy', 'resources', '*', 'cli', 'bin'));
      dirs.push(path.win32.join(localAppData, 'Programs', 'WorkBuddy', 'cli', 'bin'));
      dirs.push(path.win32.join(localAppData, 'WorkBuddy', 'cli', 'bin'));
    }
    return dirs;
  }
  if (home) {
    dirs.push(pathApi.join(home, '.local', 'bin'));
    dirs.push(pathApi.join(home, '.npm-global', 'bin'));
    dirs.push(pathApi.join(home, 'bin'));
    dirs.push(pathApi.join(home, '.cargo', 'bin'));
    dirs.push(pathApi.join(home, '.codex', 'bin'));
    dirs.push(pathApi.join(home, '.nvm', 'versions', 'node', '*', 'bin'));
    dirs.push(pathApi.join(home, '.local', 'share', 'fnm', 'node-versions', '*', 'installation', 'bin'));
    dirs.push(pathApi.join(home, '.asdf', 'installs', 'nodejs', '*', 'bin'));
    dirs.push(pathApi.join(home, '.asdf', 'shims'));
  }
  if (env.NPM_CONFIG_PREFIX) dirs.push(pathApi.join(env.NPM_CONFIG_PREFIX, 'bin'));
  if (env.VOLTA_HOME) dirs.push(pathApi.join(env.VOLTA_HOME, 'bin'));
  if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (type === 'codex' && platform === 'darwin') {
    dirs.push('/Applications/Codex.app/Contents/Resources');
    dirs.push('/Applications/ChatGPT.app/Contents/Resources');
  }
  if (type === 'workbuddy' && platform === 'darwin') {
    dirs.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin');
    dirs.push(pathApi.join(home, 'Applications', '*.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin'));
    dirs.push('/Applications/*.app/Contents/Resources/app.asar.unpacked/cli/bin');
  }
  return dirs;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 展开带一个 `*` 段（nvm 版本目录、*.app bundle）的目录列表。 */
export async function expandSearchDirs(dirs, platform = process.platform, home = os.homedir()) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  for (const dir of dirs) {
    const segs = String(dir || '').split(pathApi.sep);
    const starIdx = segs.findIndex((s) => s.includes('*'));
    if (starIdx === -1) {
      out.push(dir);
      continue;
    }
    const prefix = segs.slice(0, starIdx).join(pathApi.sep) || pathApi.sep;
    const pattern = segs[starIdx];
    const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i');
    const tail = segs.slice(starIdx + 1).join(pathApi.sep);
    let entries;
    try {
      entries = await fsp.readdir(prefix);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!re.test(name)) continue;
      const joined = tail ? pathApi.join(prefix, name, tail) : pathApi.join(prefix, name);
      if (tail) {
        try {
          if (!(await fsp.stat(joined)).isDirectory()) continue;
        } catch {
          continue;
        }
      }
      out.push(joined);
    }
  }
  return out;
}

/**
 * 跨平台可执行文件查找（镜像 which.ts）。
 * 返回第一个命中的绝对路径，或 null。extraDirs 在 PATH 之后追加。
 */
export async function whichBin(name, opts = {}) {
  const { extraDirs = [], platform = process.platform, env = process.env } = opts;
  if (!name) return null;
  const isWindows = platform === 'win32';
  if (path.isAbsolute(name) || name.includes(path.sep) || (isWindows && name.includes('/'))) {
    return (await isExecutableFile(name, platform)) ? path.resolve(name) : null;
  }
  const pathEnv = env.PATH ?? '';
  const dirs = uniqueDirs([
    ...pathEnv.split(path.delimiter).filter(Boolean),
    ...extraDirs,
  ], isWindows);
  if (dirs.length === 0) return null;
  const exts = isWindows ? winExtCandidates(env) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

/** 安装目录递归兜底（镜像 which.ts::findBinRecursively）。 */
function recursiveSearchRoots(name, platform, env, home) {
  const isWindows = platform === 'win32';
  const roots = [];
  const localAppData = env.LOCALAPPDATA || (isWindows ? path.win32.join(home, 'AppData', 'Local') : '');
  const appData = env.APPDATA || (isWindows ? path.win32.join(home, 'AppData', 'Roaming') : '');
  if (isWindows) {
    if (localAppData) {
      roots.push(localAppData);
      roots.push(path.win32.join(localAppData, 'Programs'));
      if (name === 'codex') {
        roots.push(path.win32.join(localAppData, 'OpenAI'));
        roots.push(path.win32.join(localAppData, 'Programs', 'OpenAI'));
      }
      if (name === 'codebuddy') {
        roots.push(path.win32.join(localAppData, 'WorkBuddy'));
        roots.push(path.win32.join(localAppData, 'Programs', 'WorkBuddy'));
      }
    }
    if (appData) {
      roots.push(appData);
      roots.push(path.win32.join(appData, 'npm'));
    }
    return [...new Set(roots.map((r) => r.toLowerCase()))].filter(Boolean);
  }
  if (home) {
    roots.push(path.posix.join(home, '.codex'));
    roots.push(path.posix.join(home, '.local'));
    roots.push(path.posix.join(home, '.hermes'));
    roots.push(path.posix.join(home, '.npm-global'));
    roots.push(path.posix.join(home, '.cargo'));
  }
  roots.push('/opt/homebrew', '/usr/local');
  return [...new Set(roots)].filter(Boolean);
}

export async function findBinRecursively(name, opts = {}) {
  const { platform = process.platform, env = process.env, home = os.homedir() } = opts;
  if (!name) return null;
  const roots = recursiveSearchRoots(name, platform, env, home);
  if (platform === 'win32') {
    const candidates = winExtCandidates(env).map((ext) => name + ext);
    for (const root of roots) {
      try { if (!fs.statSync(root).isDirectory()) continue; } catch { continue; }
      for (const candidate of candidates) {
        let result;
        try {
          result = spawnSync('where.exe', ['/R', root, candidate], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        } catch { continue; }
        if (result.status !== 0) continue;
        const line = String(result.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (line && fs.existsSync(line) && fs.statSync(line).isFile()) return line;
      }
    }
    return null;
  }
  const seen = new Set();
  const walk = async (dir, depth) => {
    if (depth > 4 || seen.has(dir)) return null;
    seen.add(dir);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const hit = await walk(full, depth + 1);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name === name && (await isExecutableFile(full, platform))) {
        return full;
      }
    }
    return null;
  };
  for (const root of roots) {
    const hit = await walk(root, 0);
    if (hit) return hit;
  }
  return null;
}

function uniqueDirs(dirs, isWindows) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const trimmed = String(dir || '').trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = isWindows ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function winExtCandidates(env = process.env) {
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = raw.split(';').map((s) => s.trim()).filter(Boolean);
  return ['', ...exts];
}

async function isExecutableFile(p, platform) {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 版本探测（镜像 version.ts + spawn-command.ts）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 CLI 子进程环境：原 PATH + bin 所在目录 + 常见安装根（镜像 spawn-command.ts）。 */
export function buildSpawnEnv(binPath, platform = process.platform, env = process.env, home = os.homedir()) {
  const out = { ...env };
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const rawPath = env.PATH || env.Path || '';
  const candidates = rawPath.split(delimiter).filter(Boolean);
  candidates.push(pathApi.dirname(binPath));
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || (home ? path.win32.join(home, 'AppData', 'Local') : '');
    const appData = env.APPDATA || (home ? path.win32.join(home, 'AppData', 'Roaming') : '');
    if (appData) candidates.push(path.win32.join(appData, 'npm'));
    if (localAppData) candidates.push(path.win32.join(localAppData, 'Programs', 'nodejs'));
    if (env.VOLTA_HOME) candidates.push(path.win32.join(env.VOLTA_HOME, 'bin'));
    if (env.PNPM_HOME) candidates.push(env.PNPM_HOME);
  } else {
    if (home) {
      candidates.push(pathApi.join(home, '.local', 'bin'));
      candidates.push(pathApi.join(home, '.npm-global', 'bin'));
      candidates.push(pathApi.join(home, 'bin'));
    }
    if (env.NPM_CONFIG_PREFIX) candidates.push(pathApi.join(env.NPM_CONFIG_PREFIX, 'bin'));
    if (env.VOLTA_HOME) candidates.push(pathApi.join(env.VOLTA_HOME, 'bin'));
    if (env.PNPM_HOME) candidates.push(env.PNPM_HOME);
    candidates.push(
      '/opt/homebrew/bin', '/opt/homebrew/sbin',
      '/usr/local/bin', '/usr/local/sbin',
      '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    );
  }
  const seen = new Set();
  const merged = [];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const key = platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  out.PATH = merged.join(delimiter);
  return out;
}

/** 杀掉子进程整棵进程树（镜像 backends/base.ts::killProcessTree 的语义）。 */
export function killProcessTree(pid, signal = 'SIGTERM', platform = process.platform) {
  if (!pid) return;
  if (platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.unref?.();
      return;
    } catch {
      /* fall through */
    }
    try { process.kill(pid, signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch (err) {
    if (err && err.code !== 'ESRCH') {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }
}

/** 读取 npm 包装包的 package.json 版本（镜像 registry.ts 的 codex/claude fallback）。 */
export async function detectPackageVersion(binPath, packageName, maxDepth) {
  let dir = (() => {
    try { return path.dirname(fs.realpathSync(binPath)); } catch { return path.dirname(binPath); }
  })();
  for (let i = 0; i < maxDepth; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
      if (pkg && pkg.name === packageName && typeof pkg.version === 'string') {
        const sv = parseSemver(pkg.version);
        if (sv) return `${sv.major}.${sv.minor}.${sv.patch}`;
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 读取 hermes 安装根的 pyproject.toml 版本（镜像 registry.ts）。 */
export async function detectHermesPyprojectVersion(binPath, home = os.homedir()) {
  const roots = [];
  const add = (candidate) => {
    if (!candidate) return;
    const value = path.resolve(candidate);
    if (!roots.includes(value)) roots.push(value);
  };
  const addFromExecutable = (candidate) => {
    const parts = path.normalize(candidate).split(path.sep);
    const venvIndex = parts.lastIndexOf('venv');
    if (venvIndex > 0) add(parts.slice(0, venvIndex).join(path.sep) || path.sep);
  };
  addFromExecutable(binPath);
  try { addFromExecutable(fs.realpathSync(binPath)); } catch { /* optional */ }
  try {
    const launcher = await fsp.readFile(binPath, 'utf8');
    const execPath = /exec\s+["']([^"']+\/venv\/bin\/hermes)["']/.exec(launcher)?.[1];
    if (execPath) addFromExecutable(execPath);
  } catch { /* native binary */ }
  add(path.join(home, '.hermes', 'hermes-agent'));
  for (const root of roots) {
    try {
      const raw = await fsp.readFile(path.join(root, 'pyproject.toml'), 'utf8');
      const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(raw);
      if (m) {
        const sv = parseSemver(m[1]);
        if (sv) return `${sv.major}.${sv.minor}.${sv.patch}`;
      }
    } catch {
      /* next root */
    }
  }
  return null;
}

/** 运行一次版本探测，返回解析后的版本字符串或 null（镜像 version.ts::detectVersion）。 */
export async function runVersionProbe(binPath, versionArgs = ['--version'], opts = {}) {
  const {
    timeoutMs = VERSION_PROBE_TIMEOUT_MS,
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
  } = opts;
  return new Promise((resolve) => {
    let settled = false;
    let outputBytes = 0;
    let timer = null;
    const maxOutputBytes = 64 * 1024;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(v);
    };
    let stdout = '';
    let stderr = '';

    let command = binPath;
    let args = [...versionArgs];
    let windowsVerbatimArguments = false;
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(binPath)) {
      command = env.ComSpec || env.COMSPEC || 'cmd.exe';
      args = ['/d', '/s', '/c', `"${binPath}" ${versionArgs.join(' ')}`];
      windowsVerbatimArguments = true;
    }

    let child;
    try {
      child = spawn(command, args, {
        env: buildSpawnEnv(binPath, platform, env, home),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments,
        detached: platform !== 'win32',
      });
    } catch {
      finish(null);
      return;
    }

    const capture = (target, chunk) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        killProcessTree(child.pid, 'SIGKILL', platform);
        finish(null);
        return;
      }
      if (target === 'stdout') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
    };
    child.stdout?.on('data', (c) => capture('stdout', c));
    child.stderr?.on('data', (c) => capture('stderr', c));

    timer = setTimeout(() => {
      killProcessTree(child.pid, 'SIGTERM', platform);
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      const text = `${stdout}\n${stderr}`.trim();
      if (!text) return finish(null);
      const sv = parseSemver(text);
      if (!sv) return finish(null);
      finish(`${sv.major}.${sv.minor}.${sv.patch}`);
    });
  });
}

/** 完整版本探测：npm 包版本优先 → 子进程探测 → hermes pyproject。 */
export async function probeCliVersion(type, binPath, opts = {}) {
  if (type === 'codex') {
    const v = await detectPackageVersion(binPath, '@openai/codex', 6);
    if (v) return v;
  } else if (type === 'claude') {
    const v = await detectPackageVersion(binPath, '@anthropic-ai/claude-code', 8);
    if (v) return v;
  }
  let version = null;
  for (const versionArgs of VERSION_PROBES[type] || [['--version']]) {
    version = await runVersionProbe(binPath, versionArgs, opts);
    if (version) break;
  }
  if (!version && type === 'hermes') {
    version = await detectHermesPyprojectVersion(binPath, opts.home || os.homedir());
  }
  return version;
}

// ─────────────────────────────────────────────────────────────────────────────
// 凭据 / 配置读取（镜像 auth-state.ts + active_config.ts，输出一律脱敏）
// ─────────────────────────────────────────────────────────────────────────────

/** 读取一个 JSON 文件，失败返回 null。 */
export function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** 解析 ~/.claude/settings.json 的凭据信息（脱敏）。 */
export function parseClaudeSettings(settings) {
  const out = {
    apiKeyPresent: false, apiKeyHint: null,
    baseUrl: '',
    envKeyPresent: false, envKeyNames: [],
  };
  if (!settings || typeof settings !== 'object') return out;
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  for (const key of ['apiKey', 'anthropicApiKey']) {
    if (typeof settings[key] === 'string' && settings[key].length > 0) {
      out.apiKeyPresent = true;
      out.apiKeyHint = redactSecret(settings[key]);
    }
  }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (typeof env[key] === 'string' && env[key].length > 0) {
      out.envKeyPresent = true;
      out.envKeyNames.push(key);
    }
  }
  out.baseUrl = settings.baseUrl || settings.anthropicBaseUrl || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL || '';
  return out;
}

/** 解析 ~/.codex/auth.json（OAuth 或 OPENAI_API_KEY 两种形状）。 */
export function parseCodexAuth(auth) {
  const out = { mode: null, keyPresent: false, keyHint: null };
  if (!auth || typeof auth !== 'object') return out;
  const token = auth.access_token || auth.token;
  if (typeof token === 'string' && token.length > 0) {
    out.mode = 'oauth';
    out.keyPresent = true;
    out.keyHint = redactSecret(token);
    return out;
  }
  if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0) {
    out.mode = 'api';
    out.keyPresent = true;
    out.keyHint = redactSecret(auth.OPENAI_API_KEY);
    return out;
  }
  return out;
}

/** 解析 ~/.local/share/opencode/auth.json（{ "<provider>": {type,key,baseURL} }）。 */
export function parseOpencodeAuth(auth) {
  const out = { mode: null, keyPresent: false, keyHint: null, baseUrl: '', providers: [] };
  if (!auth || typeof auth !== 'object') return out;
  for (const [provider, entry] of Object.entries(auth)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry;
    const key = typeof e.key === 'string' ? e.key : '';
    const baseURL = typeof e.baseURL === 'string' ? e.baseURL : '';
    const type = e.type === 'oauth' ? 'oauth' : 'api';
    out.providers.push(provider);
    if (key && !out.keyPresent) {
      out.mode = type;
      out.keyPresent = true;
      out.keyHint = redactSecret(key);
      out.baseUrl = baseURL;
    }
  }
  return out;
}

/** 汇总一个 CLI 的配置状态（脱敏）。claude/codex/opencode/workbuddy 有凭据文件。 */
export function inspectCliConfig(type, home = os.homedir()) {
  const res = {
    files: [],          // [{ label, path, exists, parseError? }]
    authMode: null,     // 'oauth' | 'api' | 'unknown' | null（无凭据文件）
    loggedIn: false,
    keyPresent: false,
    keyHint: null,
    baseUrl: '',
    notes: [],
  };
  const record = (label, filePath, parsed = null, parseError = null) => {
    const exists = fs.existsSync(filePath);
    res.files.push({ label, path: filePath, exists, parseError: parseError || null });
    return exists ? parsed : null;
  };

  if (type === 'claude') {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const credPath = path.join(home, '.claude', '.credentials.json');
    if (fs.existsSync(credPath)) {
      record('OAuth 凭据', credPath);
      const cred = readJsonSafe(credPath);
      const token = cred && (cred.authToken || cred.access_token || cred.token);
      if (typeof token === 'string' && token.length > 0) {
        res.authMode = 'oauth';
        res.loggedIn = true;
        res.keyPresent = true;
        res.keyHint = redactSecret(token);
      } else if (cred === null) {
        record('OAuth 凭据(解析失败)', credPath);
        res.notes.push('.credentials.json 存在但无法解析');
      }
    }
    if (fs.existsSync(settingsPath)) {
      const settings = readJsonSafe(settingsPath);
      if (settings === null) {
        record('settings.json(解析失败)', settingsPath);
        res.notes.push('settings.json 存在但不是合法 JSON');
      } else {
        const parsed = parseClaudeSettings(settings);
        record('settings.json', settingsPath);
        if (parsed.apiKeyPresent || parsed.envKeyPresent) {
          res.authMode = 'api';
          res.loggedIn = true;
          res.keyPresent = true;
          res.keyHint = parsed.apiKeyHint || `env:${parsed.envKeyNames.join(',')}`;
        }
        if (parsed.baseUrl) res.baseUrl = parsed.baseUrl;
      }
    }
  } else if (type === 'codex') {
    const authPath = path.join(home, '.codex', 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = readJsonSafe(authPath);
      if (auth === null) {
        record('auth.json(解析失败)', authPath);
        res.notes.push('auth.json 存在但不是合法 JSON');
      } else {
        const parsed = parseCodexAuth(auth);
        record('auth.json', authPath);
        res.authMode = parsed.mode;
        res.keyPresent = parsed.keyPresent;
        res.keyHint = parsed.keyHint;
        res.loggedIn = parsed.keyPresent;
      }
    }
    // config.toml 里 [model_providers.*] 的 base_url（可能是本地代理）
    const cfgPath = path.join(home, '.codex', 'config.toml');
    if (fs.existsSync(cfgPath)) {
      try {
        const toml = fs.readFileSync(cfgPath, 'utf8');
        const match = toml.match(/\[model_providers\.[^\]]+\][^\[]*base_url\s*=\s*"([^"]+)"/m);
        if (match && match[1]) res.baseUrl = match[1];
        record('config.toml', cfgPath);
      } catch (err) {
        record('config.toml(读取失败)', cfgPath, null, err.message);
      }
    }
  } else if (type === 'opencode') {
    const authPath = path.join(home, '.local', 'share', 'opencode', 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = readJsonSafe(authPath);
      if (auth === null) {
        record('auth.json(解析失败)', authPath);
        res.notes.push('auth.json 存在但不是合法 JSON');
      } else {
        const parsed = parseOpencodeAuth(auth);
        record('auth.json', authPath);
        res.authMode = parsed.mode;
        res.keyPresent = parsed.keyPresent;
        res.keyHint = parsed.keyHint;
        res.baseUrl = parsed.baseUrl || res.baseUrl;
        res.loggedIn = parsed.keyPresent;
        if (parsed.providers.length) res.notes.push(`provider: ${parsed.providers.join(', ')}`);
      }
    }
  } else if (type === 'workbuddy') {
    const sessPath = path.join(home, '.workbuddy', 'app', 'sessions.json');
    if (fs.existsSync(sessPath)) {
      const raw = readJsonSafe(sessPath);
      if (raw === null) {
        record('sessions.json(解析失败)', sessPath);
      } else {
        record('sessions.json', sessPath);
        const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
        const signedIn = sessions.some((s) => s && typeof s === 'object' && typeof s.userId === 'string' && s.userId.length > 0);
        res.authMode = signedIn ? 'oauth' : 'unknown';
        res.loggedIn = signedIn;
        res.keyPresent = signedIn;
        res.keyHint = signedIn ? '(WorkBuddy App 会话, userId 存在)' : null;
      }
    }
  } else {
    // openclaw / hermes 无本地凭据文件可读（openclaw 用自身 provider 配置；
    // hermes 登录态在 App 内管理）。只记录目录存在性作为参考。
    res.notes.push(type === 'hermes' ? 'Hermes 登录态由 App 管理，脚本不读取' : 'OpenClaw 使用自身 provider 配置，无独立凭据文件');
  }
  return res;
}

/** 本地端点 TCP 探测（镜像 active_config.ts::probeModelEndpointReachable）。
 *  返回 true（可达）/ false（不可达）/ null（无法判断）。 */
export function probeEndpointReachable(baseUrl, timeoutMs = ENDPOINT_PROBE_TIMEOUT_MS) {
  if (!baseUrl) return Promise.resolve(null);
  let u;
  try { u = new URL(baseUrl); } catch { return Promise.resolve(null); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.resolve(null);
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return Promise.resolve(null);
  // 只探测本地端点；远端端点不判断（可能只是慢/限流）。
  if (!/^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1)$/i.test(u.hostname)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host: u.hostname, port });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 环境检查
// ─────────────────────────────────────────────────────────────────────────────

const SHELL_PROFILE_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.zshenv'];

/** 从 shell 配置文件文本中提取 PATH 追加项和导出的环境变量名（不含值）。 */
export function parseShellProfile(text) {
  const out = { pathEntries: [], exportedKeys: [] };
  if (typeof text !== 'string') return out;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    // export PATH=... / export PATH="..."
    let m = /^export\s+PATH\s*=\s*"?([^"\n#]+)"?/.exec(trimmed);
    if (m) {
      for (const entry of m[1].split(':').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
        if (!out.pathEntries.includes(entry)) out.pathEntries.push(entry);
      }
      continue;
    }
    // export VAR=...（PATH 之外，只记变量名）
    m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    if (m) {
      const name = m[1];
      if (name !== 'PATH' && !out.exportedKeys.includes(name)) out.exportedKeys.push(name);
      continue;
    }
    // 行首 VAR=...（无 export，也常见）
    m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (m) {
      const name = m[1];
      if (name !== 'PATH' && !out.exportedKeys.includes(name)) out.exportedKeys.push(name);
    }
  }
  return out;
}

/** 读取本机 shell 配置文件并汇总「终端有、当前 PATH 没有」的目录。 */
export function inspectShellProfiles(home = os.homedir(), env = process.env) {
  const currentPath = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const currentPathSet = new Set(currentPath.map((p) => path.resolve(p)));
  const profiles = [];
  for (const file of SHELL_PROFILE_FILES) {
    const filePath = path.join(home, file);
    if (!fs.existsSync(filePath)) continue;
    let text = '';
    let parseError = null;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch (err) { parseError = err.message; }
    const parsed = parseShellProfile(text);
    const terminalOnly = parsed.pathEntries.filter((entry) => !currentPathSet.has(path.resolve(entry)));
    profiles.push({
      file: filePath,
      parseError,
      pathEntries: parsed.pathEntries,
      terminalOnlyPathEntries: terminalOnly,
      exportedKeys: parsed.exportedKeys,
    });
  }
  return profiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// 应用数据根目录（用于交叉检查「App 里显示的 Agent」）
// ─────────────────────────────────────────────────────────────────────────────

/** 候选数据根目录：带 users.json 才算有效。 */
export function candidateDataRoots(home = os.homedir(), env = process.env, platform = process.platform) {
  const candidates = [];
  if (env.COGSEED_WORKSPACE_ROOT) candidates.push(path.resolve(env.COGSEED_WORKSPACE_ROOT));
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    // Electron userData 的常见位置（产品名 CogSeed / CogSeed）
    for (const base of [appData, localAppData]) {
      candidates.push(path.join(base, 'CogSeed', 'data'));
      candidates.push(path.join(base, 'CogSeed', 'data'));
    }
  } else {
    candidates.push(path.join(home, '.cogseed', 'data'));
    candidates.push(path.join(home, '.cogseed', 'data'));
  }
  // 展开 runtime-variants/<variant>/data
  const variantRoots = [path.join(home, '.cogseed', 'runtime-variants'), path.join(home, '.cogseed', 'runtime-variants')];
  for (const root of variantRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      candidates.push(path.join(root, entry, 'data'));
    }
  }
  // 去重 + 只保留有 users.json 的
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = path.resolve(c);
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(path.join(key, 'users.json'))) out.push(key);
  }
  return out;
}

/** 读取一个数据根里的当前 uid。 */
export function readCurrentUid(dataRoot) {
  try {
    const users = JSON.parse(fs.readFileSync(path.join(dataRoot, 'users.json'), 'utf8'));
    return users && typeof users.current_user_id === 'string' ? users.current_user_id : null;
  } catch {
    return null;
  }
}

/** 扫描应用数据根里所有绑定了 CLI runtime 的 Agent。 */
export function scanCliBoundAgents(dataRoot, uid) {
  const agentsDir = path.join(dataRoot, uid, 'cloud', 'agents');
  let entries = [];
  try { entries = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const defPath = path.join(agentsDir, entry.name, 'agent.json');
    let def = null;
    try { def = JSON.parse(fs.readFileSync(defPath, 'utf8')); } catch { continue; }
    const runtime = def && def.runtime;
    if (runtime && runtime.kind === 'cli' && typeof runtime.cli === 'string') {
      out.push({
        agentId: entry.name,
        name: (def.name || entry.name),
        cli: runtime.cli,
        cliProviderId: typeof runtime.cli_provider_id === 'string' ? runtime.cli_provider_id : null,
      });
    }
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 单 CLI 诊断
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对单个 CLI 做完整诊断，返回结构化结果。
 * mirrors registry.detectOne + auth-state + active-config。
 */
export async function diagnoseCli(type, opts = {}) {
  const {
    home = os.homedir(),
    env = process.env,
    platform = process.platform,
    probeVersion: doProbeVersion = true,
  } = opts;

  const result = {
    type,
    binName: BIN_NAMES[type],
    envKey: ENV_KEYS[type],
    binary: { found: false, path: null, realPath: null, source: null },
    version: { value: null, minRequired: MIN_VERSIONS[type] || null, probeError: null },
    available: false,
    error: null,          // 'not_found' | 'version_too_old' | 'version_unknown'
    errorDetail: null,
    config: inspectCliConfig(type, home),
    endpoint: { baseUrl: '', isLocalProxy: false, reachable: null },
    verdict: 'ok',        // 'ok' | 'missing_binary' | 'version_unknown' | 'version_too_old' | 'no_auth' | 'proxy_down'
    notes: [],
  };

  // 1. 二进制查找：env 覆盖 → PATH → 标准安装目录
  const envPath = (env[ENV_KEYS[type]] || '').trim();
  const candidate = envPath && envPath.length > 0 ? envPath : BIN_NAMES[type];
  const extraDirs = envPath && envPath.length > 0 ? [] : await expandSearchDirs(localCliSearchDirs(type, platform, env, home), platform, home);
  let resolved = await whichBin(candidate, { extraDirs, platform, env });
  let usedRecursive = false;
  if (!resolved && !envPath && !candidate.includes('/') && !candidate.includes('\\')) {
    resolved = await findBinRecursively(candidate, { platform, env, home });
    usedRecursive = resolved !== null;
  }
  if (!resolved) {
    result.binary.source = envPath ? 'env' : 'path+search-dirs';
    result.error = 'not_found';
    result.errorDetail = envPath
      ? `${ENV_KEYS[type]}=${envPath} 不存在或不可执行`
      : `${BIN_NAMES[type]} 在 PATH、常见安装位置和递归安装根都找不到`;
    result.verdict = 'missing_binary';
    return result;
  }
  result.binary.found = true;
  result.binary.path = resolved;
  result.binary.source = envPath ? 'env' : (usedRecursive ? 'recursive-search' : 'path+search-dirs');
  try { result.binary.realPath = fs.realpathSync(resolved); } catch { result.binary.realPath = null; }

  // 2. 版本探测
  if (doProbeVersion) {
    const version = await probeCliVersion(type, resolved, { platform, env, home });
    result.version.value = version;
    if (!version) {
      const attempted = (VERSION_PROBES[type] || [['--version']])
        .map((args) => `\`${resolved} ${args.join(' ')}\``).join(', ');
      result.error = 'version_unknown';
      result.errorDetail = `${attempted} 无输出或无法解析版本`;
      result.verdict = 'version_unknown';
      return result;
    }
    const minErr = checkMinVersion(type, version);
    if (minErr) {
      result.error = 'version_too_old';
      result.errorDetail = minErr;
      result.verdict = 'version_too_old';
      return result;
    }
  }
  result.available = true;

  // 3. 凭据 + 端点（即使 available 也继续检查“能不能真的用”）
  result.config = inspectCliConfig(type, home);
  const cfg = result.config;
  if (cfg.baseUrl) {
    result.endpoint.baseUrl = cfg.baseUrl;
    result.endpoint.isLocalProxy = /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1)/i.test(cfg.baseUrl);
    if (result.endpoint.isLocalProxy) {
      result.endpoint.reachable = await probeEndpointReachable(cfg.baseUrl);
    }
  }
  const needsCredential = ['claude', 'codex', 'opencode', 'workbuddy'].includes(type);
  if (needsCredential && !cfg.loggedIn) {
    result.verdict = 'no_auth';
    result.notes.push(`${type} 未找到可用的登录凭据（从未登录过？）`);
  } else if (result.endpoint.isLocalProxy && result.endpoint.reachable === false) {
    result.verdict = 'proxy_down';
    result.notes.push(`配置指向本地代理 ${cfg.baseUrl}，但该端口当前无服务监听（代理没开？）`);
  } else if (result.endpoint.isLocalProxy && result.endpoint.reachable === true) {
    result.notes.push(`配置指向本地代理 ${cfg.baseUrl}，端口可达`);
  }
  return result;
}

/** 并行诊断所有 CLI（或 --only 指定子集）。 */
export async function diagnoseAllCli(opts = {}) {
  const types = opts.types || CLI_TYPES;
  const results = await Promise.all(types.map((t) => diagnoseCli(t, opts)));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 期望配置快照（--export-expected / --expected）
// ─────────────────────────────────────────────────────────────────────────────

/** 把诊断结果归一化成可比较、可导出的快照（脱敏）。 */
export function buildExpectedSnapshot(results) {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    clis: {},
  };
  for (const r of results) {
    snapshot.clis[r.type] = {
      binaryFound: r.binary.found,
      version: r.version.value,
      available: r.available,
      error: r.error,
      authMode: r.config.authMode,
      loggedIn: r.config.loggedIn,
      keyPresent: r.config.keyPresent,
      baseUrl: r.config.baseUrl,
      isLocalProxy: r.endpoint.isLocalProxy,
      configFiles: r.config.files.map((f) => ({ label: f.label, exists: f.exists })),
      notes: r.notes,
    };
  }
  return snapshot;
}

/** 对比当前状态与期望快照，返回差异列表。 */
export function compareExpected(snapshot, results) {
  const diffs = [];
  if (!snapshot || typeof snapshot.clis !== 'object') {
    return [{ cli: '*', kind: 'snapshot', message: '期望快照无法解析' }];
  }
  for (const r of results) {
    const expect = snapshot.clis[r.type];
    if (!expect) continue;
    if (expect.binaryFound !== r.binary.found) {
      diffs.push({
        cli: r.type, kind: 'binary',
        message: r.binary.found
          ? `期望: 未安装, 实际: 已安装 (${r.binary.path})`
          : '期望: 已安装, 实际: 未找到',
      });
    }
    if (expect.version && expect.version !== r.version.value) {
      diffs.push({
        cli: r.type, kind: 'version',
        message: `版本不同: 期望 ${expect.version}, 实际 ${r.version.value || '(探测失败)'}`,
      });
    }
    if (expect.authMode !== r.config.authMode) {
      diffs.push({
        cli: r.type, kind: 'auth',
        message: `登录方式不同: 期望 ${expect.authMode || '(无)'}, 实际 ${r.config.authMode || '(无)'}`,
      });
    }
    if (expect.keyPresent !== r.config.keyPresent) {
      diffs.push({
        cli: r.type, kind: 'key',
        message: expect.keyPresent ? '期望有凭据, 实际没有' : '期望无凭据, 实际有',
      });
    }
    if (expect.baseUrl !== r.config.baseUrl) {
      diffs.push({
        cli: r.type, kind: 'endpoint',
        message: `模型端点不同: 期望 ${expect.baseUrl || '(默认)'}, 实际 ${r.config.baseUrl || '(默认)'}`,
      });
    }
  }
  return diffs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告渲染
// ─────────────────────────────────────────────────────────────────────────────

function iconFor(verdict) {
  return verdict === 'ok' ? 'PASS' : (verdict === 'missing_binary' ? 'FAIL' : 'WARN');
}

function verdictHint(verdict, type) {
  switch (verdict) {
    case 'missing_binary':
      return `未检测到 ${type}（${BIN_NAMES[type]}）——App 不会把它列为可用 Agent；请安装对应 CLI 并确认 PATH`;
    case 'version_unknown':
      return `${type} 存在但版本探测失败——在终端跑 \`${BIN_NAMES[type]} --version\` 验证；App 会把它标为不可用`;
    case 'version_too_old':
      return `${type} 版本过低，需要 >= ${MIN_VERSIONS[type]}，升级后即可使用`;
    case 'no_auth':
      return `${type} 已安装但未登录/无 API Key 配置——运行时会被 CLI 要求登录，先完成登录`;
    case 'proxy_down':
      return `${type} 配置了本地代理但代理未运行——启动代理（如 CC Switch）或改回直连`;
    default:
      return '';
  }
}

/** 渲染人类可读报告。 */
export function renderReport(report) {
  const lines = [];
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  外部 Agent（本地 CLI）环境诊断报告');
  lines.push(`  时间: ${report.generatedAt}   平台: ${report.platform} ${report.arch}   Node: ${report.node}`);
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');

  lines.push(`【机器信息】`);
  lines.push(`  HOME: ${report.home}`);
  lines.push(`  PATH 条目数: ${report.env.pathEntries.length}`);
  if (report.env.nodeOnPath === false) lines.push('  [WARN] `node` 不在当前 PATH 中——多数 CLI 是 Node 脚本，App 启动的 CLI 可能找不到 Node');
  lines.push('');

  lines.push('【Shell 配置文件】(GUI 启动的 App 不会加载这些文件)');
  if (report.env.shellProfiles.length === 0) {
    lines.push('  (未发现 shell 配置文件)');
  }
  for (const p of report.env.shellProfiles) {
    lines.push(`  ${p.file}${p.parseError ? ` (解析失败: ${p.parseError})` : ''}`);
    for (const entry of p.terminalOnlyPathEntries) {
      lines.push(`    [WARN] 终端独有 PATH: ${entry} —— 终端里能跑、App 里找不到二进制时检查这里`);
    }
    if (p.exportedKeys.length) {
      lines.push(`    导出变量(仅名称, 不显示值): ${p.exportedKeys.join(', ')}`);
    }
  }
  lines.push('');

  lines.push('【CLI Agent 检测】(与 App 的 localAgents.list 一致)');
  for (const r of report.clis) {
    const icon = iconFor(r.verdict);
    lines.push(`  ${icon}  ${r.type}  (${r.binName})`);
    lines.push(`      binary: ${r.binary.found ? `${r.binary.path}${r.binary.realPath && r.binary.realPath !== r.binary.path ? ` -> ${r.binary.realPath}` : ''} (${r.binary.source})` : '未找到'}`);
    if (r.binary.found) {
      if (report.probeVersion === false) {
        lines.push(`      version: (已跳过版本探测 --no-version-probe)`);
      } else {
        lines.push(`      version: ${r.version.value || '(探测失败)'}${r.version.minRequired ? ` (要求 >= ${r.version.minRequired})` : ''}`);
      }
    }
    if (r.error) lines.push(`      状态: ${r.error}${r.errorDetail ? ` — ${r.errorDetail}` : ''}`);
    for (const f of r.config.files) {
      lines.push(`      config: ${f.label}: ${f.exists ? '存在' : '不存在'}${f.parseError ? ` (解析失败: ${f.parseError})` : ''}`);
    }
    if (r.config.keyPresent) {
      lines.push(`      凭据: ${r.config.authMode || 'unknown'} ${r.config.keyHint ? `(${r.config.keyHint})` : ''}`);
    } else if (['claude', 'codex', 'opencode', 'workbuddy'].includes(r.type)) {
      lines.push(`      凭据: 未找到`);
    }
    if (r.endpoint.baseUrl) {
      lines.push(`      端点: ${r.endpoint.baseUrl}${r.endpoint.isLocalProxy ? ` (本地代理, TCP 探测: ${r.endpoint.reachable === null ? '未探测' : (r.endpoint.reachable ? '可达' : '不可达')})` : ''}`);
    }
    for (const note of r.config.notes) lines.push(`      note: ${note}`);
    for (const note of r.notes) lines.push(`      note: ${note}`);
    const hint = verdictHint(r.verdict, r.type);
    if (hint) lines.push(`      → ${hint}`);
    lines.push('');
  }

  if (report.expected) {
    lines.push('【与期望配置对比】');
    if (report.expected.diffs.length === 0) {
      lines.push('  本机配置与期望快照一致 ✓');
    } else {
      for (const d of report.expected.diffs) {
        lines.push(`  [DIFF] ${d.cli} ${d.kind}: ${d.message}`);
      }
    }
    lines.push('');
  }

  lines.push('【App 内的外部 Agent 交叉检查】(agent.json 绑定 CLI 的 Agent)');
  if (report.agents.length === 0) {
    lines.push('  (未在应用数据中找到绑定 CLI 的外部 Agent，或未找到应用数据目录)');
  } else {
    for (const a of report.agents) {
      lines.push(`  [${a.statusIcon}] Agent "${a.name}" (id: ${a.agentId}, cli: ${a.cli})`);
      if (a.dataRoot) lines.push(`      data root: ${a.dataRoot}`);
      if (a.statusText) lines.push(`      ${a.statusText}`);
    }
  }
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

/** 交叉检查 App 数据里的外部 Agent。跨数据根去重（按 agentId + cli）。 */
export async function crossCheckAgents(cliResults, dataRoots) {
  const byCli = new Map(cliResults.map((r) => [r.type, r]));
  const out = [];
  const seen = new Set();
  for (const dataRoot of dataRoots) {
    const uid = readCurrentUid(dataRoot);
    if (!uid) continue;
    for (const agent of scanCliBoundAgents(dataRoot, uid)) {
      const key = `${agent.agentId}:${agent.cli}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = { ...agent, dataRoot, statusIcon: 'OK', statusText: null };
      const entry = byCli.get(agent.cli);
      if (!entry) {
        row.statusIcon = 'FAIL';
        row.statusText = `runtime.cli=${agent.cli} 不是已知的 CLI 类型`;
      } else if (!entry.binary.found) {
        row.statusIcon = 'FAIL';
        row.statusText = `本机未找到 ${agent.cli}（${BIN_NAMES[agent.cli]}）——这就是「App 里显示、但本机根本没有」的原因。同步来的 Agent 只在创建它的机器上可用。`;
      } else if (!entry.available) {
        row.statusIcon = 'WARN';
        row.statusText = `${agent.cli} 已安装但不可用: ${entry.errorDetail || entry.error}`;
      } else if (entry.verdict === 'no_auth') {
        row.statusIcon = 'WARN';
        row.statusText = `${agent.cli} 已安装但未登录/无凭据——派发时会被 CLI 拒绝`;
      } else if (entry.verdict === 'proxy_down') {
        row.statusIcon = 'WARN';
        row.statusText = `${agent.cli} 配置的本地代理未运行`;
      }
      out.push(row);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI 入口
// ─────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    json: false,
    only: null,
    probeVersion: true,
    expected: null,
    exportExpected: null,
    home: os.homedir(),
    dataRoot: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--no-version-probe') { opts.probeVersion = false; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--only') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--only 需要一个逗号分隔的值，如 --only claude,codex');
      opts.only = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg.startsWith('--only=')) {
      opts.only = arg.slice('--only='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      continue;
    }
    if (arg === '--expected') {
      const value = argv[i + 1];
      if (!value) throw new Error('--expected 需要一个文件路径');
      opts.expected = value;
      i += 1;
      continue;
    }
    if (arg === '--export-expected') {
      const value = argv[i + 1];
      if (!value) throw new Error('--export-expected 需要一个文件路径');
      opts.exportExpected = value;
      i += 1;
      continue;
    }
    if (arg === '--home') {
      const value = argv[i + 1];
      if (!value) throw new Error('--home 需要一个目录路径');
      opts.home = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg === '--data-root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--data-root 需要一个目录路径');
      opts.dataRoot = path.resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  if (opts.only) {
    const unknown = opts.only.filter((t) => !CLI_TYPES.includes(t));
    if (unknown.length) throw new Error(`未知 CLI 类型: ${unknown.join(', ')}（可用: ${CLI_TYPES.join(', ')}）`);
  }
  return opts;
}

export function printHelp() {
  return `用法: node scripts/diagnose-local-agents.mjs [选项]

检测本机外部（本地 CLI）Agent 无法使用的原因，输出诊断报告。

选项:
  --json                  以 JSON 输出（机器可读）
  --only <a,b,c>          只检测指定 CLI（claude,codex,openclaw,opencode,hermes,workbuddy）
  --no-version-probe      跳过版本探测子进程（快速模式；会漏报 version_too_old/unknown）
  --expected <file>       与已知良好配置快照对比（用 --export-expected 生成）
  --export-expected <file> 把本机配置状态导出为脱敏快照
  --home <dir>            指定要检查的 HOME（排查其他用户/机器时用）
  --data-root <dir>       指定应用数据根目录（默认自动查找 ~/.cogseed 等）
  --help, -h              显示帮助

示例:
  node scripts/diagnose-local-agents.mjs
  node scripts/diagnose-local-agents.mjs --json
  node scripts/diagnose-local-agents.mjs --export-expected ./known-good.json
  node scripts/diagnose-local-agents.mjs --expected ./known-good.json`;
}

/** 主流程。 */
export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${printHelp()}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${printHelp()}\n`);
    return 0;
  }

  const env = process.env;
  const home = opts.home;
  const types = opts.only || CLI_TYPES;

  const clis = await diagnoseAllCli({ types, home, env, probeVersion: opts.probeVersion });

  // 环境信息
  const envInfo = {
    pathEntries: (env.PATH || '').split(path.delimiter).filter(Boolean),
    nodeOnPath: !!(await whichBin('node', { platform: process.platform, env })),
    shellProfiles: inspectShellProfiles(home, env),
  };

  // 应用数据 + 交叉检查
  const dataRoots = opts.dataRoot
    ? (fs.existsSync(path.join(opts.dataRoot, 'users.json')) ? [opts.dataRoot] : [])
    : candidateDataRoots(home, env, process.platform);
  let agents = [];
  if (dataRoots.length) {
    agents = await crossCheckAgents(clis, dataRoots);
  }

  // 期望配置对比
  let expected = null;
  if (opts.expected) {
    let snapshot = null;
    try {
      snapshot = JSON.parse(fs.readFileSync(opts.expected, 'utf8'));
    } catch (err) {
      process.stderr.write(`无法读取期望快照 ${opts.expected}: ${err.message}\n`);
      return 2;
    }
    const diffs = compareExpected(snapshot, clis);
    expected = { file: opts.expected, diffs };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    home,
    probeVersion: opts.probeVersion,
    env: envInfo,
    clis,
    agents,
    expected,
  };

  if (opts.exportExpected) {
    try {
      fs.writeFileSync(opts.exportExpected, JSON.stringify(buildExpectedSnapshot(clis), null, 2) + '\n', 'utf8');
      if (!opts.json) {
        process.stdout.write(`已导出期望配置快照 → ${opts.exportExpected}\n`);
      }
    } catch (err) {
      process.stderr.write(`无法写入 ${opts.exportExpected}: ${err.message}\n`);
      return 2;
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(report) + '\n');
  }

  // 退出码：0 = 全部可用；1 = 存在不可用/告警项
  const anyFail = clis.some((c) => c.verdict === 'missing_binary' || c.verdict === 'version_too_old' || c.verdict === 'version_unknown');
  return anyFail ? 1 : 0;
}

// 直接运行（而非被 import）时执行
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`诊断失败: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  });
}
