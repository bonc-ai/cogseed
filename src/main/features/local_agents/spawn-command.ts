import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

export type ResolvedCliCommand = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Extra env vars the caller must merge into the child env (e.g. running a
   *  node-shebang script through Electron's own Node runtime). */
  envPatch?: Record<string, string>;
};

const WINDOWS_COMMAND_SCRIPT_RE = /\.(?:cmd|bat)$/i;
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expand candidate dirs containing a single `*` path segment by listing the
 * parent directory synchronously (nvm/fnm/asdf version trees, `*.app` bundles).
 * Dirs without `*` pass through unchanged; unreadable parents are skipped.
 * Mirrors registry.ts::expandSearchDirs, but synchronous so buildCliSpawnEnv
 * can stay a plain function (spawn envs must be ready synchronously).
 */
function expandStarSegments(
  dirs: string[],
  pathApi: typeof path.posix | typeof path.win32,
): string[] {
  const out: string[] = [];
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
    let entries: string[];
    try {
      entries = fs.readdirSync(prefix);
    } catch {
      continue; // parent missing / unreadable → nothing to expand
    }
    for (const name of entries) {
      if (!re.test(name)) continue;
      out.push(tail ? pathApi.join(prefix, name, tail) : pathApi.join(prefix, name));
    }
  }
  return out;
}

/**
 * Build the environment used for CLI version probes and real runs.
 * Finder-launched macOS apps inherit a minimal PATH, so an npm-installed
 * CLI may be discoverable by absolute path while its `#!/usr/bin/env node`
 * launcher still cannot find Node. Keep the user's existing order, then add
 * the same conventional install roots used by CLI discovery.
 */
export function buildCliSpawnEnv(
  binPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): NodeJS.ProcessEnv {
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
      // Node version managers (nvm / fnm / asdf): the CLI binary may be a
      // `#!/usr/bin/env node` script whose node lives only under these trees
      // (macOS GUI apps don't source shell profiles, so PATH is minimal).
      // Same coverage as localCliSearchDirs in registry.ts.
      candidates.push(pathApi.join(home, '.nvm', 'versions', 'node', '*', 'bin'));
      candidates.push(pathApi.join(home, '.local', 'share', 'fnm', 'node-versions', '*', 'installation', 'bin'));
      candidates.push(pathApi.join(home, '.asdf', 'installs', 'nodejs', '*', 'bin'));
      candidates.push(pathApi.join(home, '.asdf', 'shims'));
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

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const candidate of expandStarSegments(candidates, pathApi)) {
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

function escapeCmdCommand(value: string): string {
  return String(value).replace(CMD_META_RE, '^$1');
}

// Based on the quoting rules used by cross-spawn. A command script must run
// through cmd.exe on Windows; passing raw user/model arguments through a shell
// would make &, |, %, and friends executable shell syntax.
function escapeCmdArgument(value: string, doubleEscapeMetaChars: boolean): string {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_RE, '^$1');
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META_RE, '^$1');
  return escaped;
}

/**
 * True when the file starts with a `#!...node` shebang — i.e. running it
 * directly requires a Node runtime on PATH.
 */
export function isNodeShebangScript(binPath: string): boolean {
  try {
    const fd = fs.openSync(binPath, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return /^#!.*\bnode\b/.test(buf.toString('utf8', 0, n));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * True when a `node` executable can be resolved from the given PATH (the env
 * passed here is the post-buildCliSpawnEnv env, so version-manager bin dirs
 * already count). Synchronous — called while assembling a spawn env.
 */
export function hasNodeOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const rawPath = env.PATH || env.Path || '';
  const dirs = expandStarSegments(rawPath.split(delimiter).filter(Boolean), pathApi);
  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const dir of dirs) {
    for (const name of names) {
      try {
        if (fs.statSync(pathApi.join(dir, name)).isFile()) return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/**
 * Resolve one CLI launch without enabling Node's generic `shell:true` path.
 * Native executables are returned unchanged. Windows .cmd/.bat shims are
 * safely quoted and passed through ComSpec, which is required for npm-global
 * CLIs such as claude.cmd and codex.cmd.
 */
export function resolveCliCommand(
  binPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCliCommand {
  // Windows: npm / pnpm / yarn global installs drop a bare-name POSIX shim
  // (`claude`, `codex`, ... — `#!/bin/sh`) NEXT TO the real Windows entry
  // (`claude.cmd`, `codex.cmd`). whichBin tries the empty extension first,
  // so it can hand us the bare name, which CreateProcess cannot execute
  // (ENOENT → every --version probe fails → "version_unknown" → the CLI is
  // hidden from the UI even though it's installed). Prefer the .cmd/.bat
  // sibling when it exists; it flows through the ComSpec branch below.
  if (platform === 'win32' && !path.win32.extname(binPath)) {
    for (const alt of [binPath + '.cmd', binPath + '.bat']) {
      try {
        if (fs.statSync(alt).isFile()) { binPath = alt; break; }
      } catch {
        // keep looking
      }
    }
  }
  if (platform !== 'win32' || !WINDOWS_COMMAND_SCRIPT_RE.test(binPath)) {
    // Node-shebang scripts (e.g. WorkBuddy's bundled `codebuddy`) cannot run
    // when the machine has no `node` on PATH — macOS GUI apps inherit a
    // minimal PATH, and the user may have no Node installed at all. CogSeed
    // is itself an Electron app, so fall back to running the script with our
    // own Node runtime (ELECTRON_RUN_AS_NODE keeps Electron in headless
    // node mode); this keeps such CLIs usable without a system Node install.
    //
    // Windows additionally has NO kernel shebang support: CreateProcess
    // rejects extension-less script files outright (spawn ENOENT), so a
    // node-shebang CLI MUST be routed through a Node runtime there even
    // when `node` IS on PATH. The old gate (`!hasNodeOnPath(...) &&`) made
    // WorkBuddy's bundled `codebuddy` fail every version probe on win32
    // whenever a system node existed → "version_unknown" → UI reported
    // "未检测到 WorkBuddy CLI". Running ALL win32 shebang launches through
    // our own Electron runtime is also deterministic: immune to old or
    // missing system Node (codebuddy requires >= 18.20.8). On POSIX the
    // kernel resolves the shebang itself, so direct exec stays the fast
    // path when `node` is on PATH.
    if (isNodeShebangScript(binPath) && (platform === 'win32' || !hasNodeOnPath(env, platform))) {
      return {
        command: process.execPath,
        args: [binPath, ...args],
        envPatch: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
    return { command: binPath, args: args.slice() };
  }

  const normalized = path.win32.normalize(binPath);
  // npm-generated shims re-parse their `%*` payload once more. Cover both
  // project-local node_modules/.bin and the standard global npm directory.
  const doubleEscape = /(?:node_modules[\\/]\.bin|AppData[\\/]Roaming[\\/]npm)[\\/][^\\/]+\.cmd$/i
    .test(normalized);
  const shellCommand = [
    escapeCmdCommand(normalized),
    ...args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
  ].join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}
