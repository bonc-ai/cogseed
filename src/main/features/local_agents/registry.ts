/**
 * Registry of local CLI coding agents CogSeed can spawn.
 *
 * Discovery rules per CLI:
 *   1. COGSEED_<TYPE>_PATH env var, if set → use as-is (still validated).
 *   2. Else `whichBin(defaultBin)` scans PATH plus standard GUI-app
 *      fallback dirs (`~/.local/bin`, Homebrew locations, etc.).
 *   3. If found, run the CLI's documented version probe and `checkMinVersion`.
 *
 * Results are cached for 60s to keep the create/edit panel snappy
 * across re-renders. Pass `{ force: true }` to bypass the cache (used
 * by execute-time pre-flight check in runner.ts so a recently-deleted
 * binary doesn't slip through).
 *
 * `LocalCliType` is the canonical key everywhere (spec.runtime.cli,
 * IPC payloads, persist meta.json) — keep it in sync with backends/.
 */

import { createLogger } from '../../logger.js';
import { whichBin } from './which.js';
import { detectCliAuth } from './auth-state.js';
import { checkMinVersion, detectVersion, parseSemver, MIN_VERSIONS } from './version.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const log = createLogger('local-agents');

/** Canonical CLI type names. New backends add an entry here + in BIN_NAMES + ENV_KEYS. */
export const LOCAL_CLI_TYPES = ['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy', 'gemini', 'aider'] as const;

export type LocalCliType = (typeof LOCAL_CLI_TYPES)[number];

/** Default executable name on PATH for each CLI. */
const BIN_NAMES: Record<LocalCliType, string> = {
  claude: 'claude',
  codex: 'codex',
  openclaw: 'openclaw',
  opencode: 'opencode',
  hermes: 'hermes',
  // WorkBuddy (Tencent) ships the CLI as `codebuddy` inside the app bundle;
  // it is not placed on PATH, so discovery relies on localCliSearchDirs below.
  workbuddy: 'codebuddy',
  gemini: 'gemini',
  aider: 'aider',
};

/** Env var to override default binary path per CLI. */
const ENV_KEYS: Record<LocalCliType, string> = {
  claude: 'COGSEED_CLAUDE_PATH',
  codex: 'COGSEED_CODEX_PATH',
  openclaw: 'COGSEED_OPENCLAW_PATH',
  opencode: 'COGSEED_OPENCODE_PATH',
  hermes: 'COGSEED_HERMES_PATH',
  workbuddy: 'COGSEED_WORKBUDDY_PATH',
  gemini: 'COGSEED_GEMINI_PATH',
  aider: 'COGSEED_AIDER_PATH',
};

/** Documented version probes for each CLI, in compatibility order. */
const VERSION_PROBES: Record<LocalCliType, readonly (readonly string[])[]> = {
  claude: [['--version']],
  codex: [['--version']],
  openclaw: [['--version']],
  opencode: [['--version']],
  // Hermes documents both forms across releases. `version` (subcommand)
  // HANGS (no output, no exit) on some builds when spawned without a TTY —
  // observed on arm64 macOS where `hermes version` blocks until SIGKILL
  // while `hermes --version` returns in <100ms. `--version` MUST stay first
  // so the 5s detectVersion timeout is never hit during localAgents.list
  // (the workspace view waits on this probe on every cold load).
  hermes: [['--version'], ['version']],
  // codebuddy prints a bare semver on `--version` (verified 2.115.0).
  workbuddy: [['--version']],
  gemini: [['--version']],
  aider: [['--version']],
};

export function localCliSearchDirs(
  type: LocalCliType,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  const dirs: string[] = [];
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
    }
    if (type === 'workbuddy' && localAppData) {
      // WorkBuddy (Tencent) desktop is an Electron app; the bundled `codebuddy`
      // CLI lives under its unpacked asar (same layout as the macOS bundle).
      dirs.push(path.win32.join(localAppData, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin'));
    }
    return dirs;
  }
  if (home) {
    // macOS GUI apps do not source ~/.zprofile, but Codex standalone
    // installs its visible command here by default. npm's commonly
    // recommended user prefix is also absent from Finder-launched apps.
    dirs.push(pathApi.join(home, '.local', 'bin'));
    dirs.push(pathApi.join(home, '.npm-global', 'bin'));
    dirs.push(pathApi.join(home, 'bin'));
    dirs.push(pathApi.join(home, '.cargo', 'bin'));
    // Codex's official standalone installer puts the binary in ~/.codex/bin
    // by default. User-level installs must win over the /Applications
    // bundles scanned further down, so this sits in the shared home block.
    dirs.push(pathApi.join(home, '.codex', 'bin'));
    // Version-manager shims / per-version bin dirs. These live OUTSIDE the
    // PATH a Finder-launched app inherits, so without them every nvm/fnm/asdf
    // install shows up as "not found" on GUI launches. The `*` segment is
    // expanded by expandSearchDirs before whichBin runs.
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
    // WorkBuddy bundles its CLI (`codebuddy`) inside the app's unpacked
    // asar. GUI-launched apps never see it on PATH, so probe the bundle.
    // The fixed /Applications path is the standard install location; the
    // `*` patterns cover non-standard locations (other disks via symlink,
    // ~/Applications, renamed bundles) via expandSearchDirs.
    dirs.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin');
    dirs.push(pathApi.join(home, 'Applications', '*.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin'));
    dirs.push('/Applications/*.app/Contents/Resources/app.asar.unpacked/cli/bin');
  }
  return dirs;
}

/**
 * Expand directories that contain a single `*` path segment by listing the
 * parent directory (e.g. `~/.nvm/versions/node/<ver>/bin` expands to every
 * installed node version's bin). Directories without `*` pass through
 * unchanged; unreadable parents are skipped. Results are cached for the same
 * TTL as `detectAll` so repeated per-CLI probes don't re-stat the filesystem.
 *
 * Only ONE wildcard segment is supported — enough for version-manager
 * layouts and `*.app` bundle scanning without turning this into a glob
 * engine.
 */
export async function expandSearchDirs(
  dirs: string[],
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): Promise<string[]> {
  const key = dirs.join('\u0000');
  if (expandCache && expandCache.key === key && Date.now() - expandCache.at < CACHE_TTL_MS) {
    return expandCache.dirs;
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
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
      entries = await fs.readdir(prefix);
    } catch {
      continue; // parent missing / unreadable → nothing to expand
    }
    for (const name of entries) {
      if (!re.test(name)) continue;
      const joined = tail ? pathApi.join(prefix, name, tail) : pathApi.join(prefix, name);
      if (tail) {
        // Only keep expansions whose tail actually exists — otherwise every
        // `*.app` bundle would emit the same codebuddy path for apps that
        // don't bundle it (noise + pointless stats downstream in whichBin).
        try {
          if (!(await fs.stat(joined)).isDirectory()) continue;
        } catch {
          continue;
        }
      }
      out.push(joined);
    }
  }
  expandCache = { key, at: Date.now(), dirs: out };
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let expandCache: { key: string; at: number; dirs: string[] } | null = null;

async function detectCodexPackageVersion(binPath: string): Promise<string | null> {
  let dir: string;
  try { dir = path.dirname(await fs.realpath(binPath)); }
  catch { dir = path.dirname(binPath); }

  for (let i = 0; i < 6; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (pkg?.name === '@openai/codex' && typeof pkg.version === 'string') {
        const sv = parseSemver(pkg.version);
        if (sv) return `${sv.major}.${sv.minor}.${sv.patch}`;
      }
    } catch {
      // Keep walking toward the npm package root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * npm-package version fallback for Claude Code. The native `claude --version`
 * probe can be SIGKILLed in GUI-launched / daemonized environments (observed
 * on arm64 macOS with claude-code 2.x), which would mark claude as
 * `version_unknown` and hide it from the onboarding picker despite a healthy
 * install. The npm wrapper package.json carries the real version, so read it
 * the same way codex does.
 */
async function detectClaudePackageVersion(binPath: string): Promise<string | null> {
  let dir: string;
  try { dir = path.dirname(await fs.realpath(binPath)); }
  catch { dir = path.dirname(binPath); }

  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (pkg?.name === '@anthropic-ai/claude-code' && typeof pkg.version === 'string') {
        const sv = parseSemver(pkg.version);
        if (sv) return `${sv.major}.${sv.minor}.${sv.patch}`;
      }
    } catch {
      // Keep walking toward the npm package root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseProjectVersionToml(raw: string): string | null {
  const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(raw);
  if (!m) return null;
  const sv = parseSemver(m[1]);
  return sv ? `${sv.major}.${sv.minor}.${sv.patch}` : null;
}

async function readHermesPyprojectVersion(root: string): Promise<string | null> {
  try {
    return parseProjectVersionToml(await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8'));
  } catch {
    return null;
  }
}

async function hermesInstallRoots(binPath: string): Promise<string[]> {
  const roots: string[] = [];
  const add = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const value = path.resolve(candidate);
    if (!roots.includes(value)) roots.push(value);
  };
  const addFromExecutable = (candidate: string) => {
    const parts = path.normalize(candidate).split(path.sep);
    const venvIndex = parts.lastIndexOf('venv');
    if (venvIndex > 0) add(parts.slice(0, venvIndex).join(path.sep) || path.sep);
  };

  addFromExecutable(binPath);
  try {
    addFromExecutable(await fs.realpath(binPath));
  } catch {
    // Symlink resolution is optional.
  }
  try {
    const launcher = await fs.readFile(binPath, 'utf8');
    const execPath = /exec\s+["']([^"']+\/venv\/bin\/hermes)["']/.exec(launcher)?.[1];
    if (execPath) addFromExecutable(execPath);
  } catch {
    // Native/binary launchers are fine; fall through to the default install root.
  }
  add(path.join(os.homedir(), '.hermes', 'hermes-agent'));
  return roots;
}

async function detectHermesInstallVersion(binPath: string): Promise<string | null> {
  for (const root of await hermesInstallRoots(binPath)) {
    const version = await readHermesPyprojectVersion(root);
    if (version) return version;
  }
  return null;
}

/** Detection result for a single CLI. */
export type LocalCliEntry = {
  type: LocalCliType;
  /** Absolute path to the binary, or null when unavailable. */
  path: string | null;
  /** Parsed `MAJOR.MINOR.PATCH` from the CLI's version probe, or null. */
  version: string | null;
  /** True only when path resolved AND version check passed. */
  available: boolean;
  /**
   * Populated when `available === false` to explain why:
   * "not_found" (no PATH match), "version_too_old" (below MIN_VERSIONS),
   * or "version_unknown" (binary exists but its version probe returned nothing).
   */
  error?: 'not_found' | 'version_too_old' | 'version_unknown';
  /** Human-readable detail when error is set; safe to show in UI. */
  errorDetail?: string;
  /** Credential state (official-account sign-in vs raw key) for available
   *  CLIs. File-based, read-only — never guesses. */
  auth?: { loggedIn: boolean; mode: 'oauth' | 'api' | 'unknown' };
};

/**
 * Detection cache TTL. CLI install/version state is effectively static within
 * a session — a 60s TTL made the workspace view re-probe every CLI binary on
 * any cold load (>1min since the last visit), which could stall the view for
 * seconds when a probe hangs (hermes without TTY, codex spawn errors). 5min
 * keeps the view snappy while still picking up new installs within a session.
 */
const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; entries: LocalCliEntry[] } | null = null;

/**
 * Detect all known CLIs (parallel). Returns one entry per type, including
 * unavailable ones — UI filters to `available === true` for the picker.
 */
export async function detectAll(opts: { force?: boolean } = {}): Promise<LocalCliEntry[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.entries;
  }
  const entries = await Promise.all(LOCAL_CLI_TYPES.map(t => detectOne(t)));
  cache = { at: Date.now(), entries };
  log.info('detected local CLIs', {
    available: entries.filter(e => e.available).map(e => e.type),
    missing: entries.filter(e => !e.available).map(e => e.type),
  });
  return entries;
}

/**
 * Detect a single CLI. Skips the cache by design — callers that need
 * cache should go through detectAll.
 */
export async function detectOne(type: LocalCliType): Promise<LocalCliEntry> {
  const envPath = process.env[ENV_KEYS[type]]?.trim();
  const candidate = envPath && envPath.length > 0 ? envPath : BIN_NAMES[type];
  const resolved = await whichBin(candidate, {
    extraDirs: envPath ? [] : await expandSearchDirs(localCliSearchDirs(type)),
  });
  if (!resolved) {
    return {
      type, path: null, version: null, available: false,
      error: 'not_found',
      errorDetail: envPath
        ? `${ENV_KEYS[type]}=${envPath} not found on PATH or filesystem`
        : `${BIN_NAMES[type]} not found on PATH or standard CLI install locations`,
    };
  }
  // The npm @openai/codex wrapper can hang on `--version` in GUI-launched
  // environments. Prefer its package.json version when available; fall back to
  // the normal subprocess probe for standalone/non-npm installs. Claude Code
  // gets the same treatment: its native `--version` can be SIGKILLed under
  // GUI launch, so prefer the npm wrapper package.json version first.
  const versionProbes = VERSION_PROBES[type];
  let version = type === 'codex'
    ? await detectCodexPackageVersion(resolved)
    : type === 'claude'
      ? await detectClaudePackageVersion(resolved)
      : null;
  for (const versionArgs of versionProbes) {
    if (version) break;
    // Short per-probe timeout: a healthy CLI answers --version in <100ms;
    // 2s covers slow cold starts without letting a hung binary (hermes
    // without TTY, GUI-launched codex) stall the workspace view. Zero-output
    // timeouts are retried once inside detectVersion (spawn starvation under
    // load), keeping the worst case at ~4s per probe — still under the 5s
    // budget that motivated this limit.
    version = await detectVersion(resolved, 2_000, versionArgs);
  }
  if (!version && type === 'hermes') {
    version = await detectHermesInstallVersion(resolved);
  }
  if (!version) {
    const attempted = versionProbes
      .map(args => `\`${resolved} ${args.join(' ')}\``)
      .join(', ');
    return {
      type, path: resolved, version: null, available: false,
      error: 'version_unknown',
      errorDetail: type === 'codex'
        ? `${attempted} produced no parsable output — Codex installed standalone (non-npm) can hang on \`--version\` when launched from a GUI app. Verify with \`codex --version\` in a terminal, install via \`npm install -g @openai/codex\`, or upgrade to >= ${MIN_VERSIONS.codex}.`
        : `${attempted} produced no parsable output`,
    };
  }
  const minErr = checkMinVersion(type, version);
  if (minErr) {
    return {
      type, path: resolved, version, available: false,
      error: 'version_too_old',
      errorDetail: minErr,
    };
  }
  return { type, path: resolved, version, available: true, auth: detectCliAuth(type) };
}

/** Clear the cache; mainly for tests and the IPC `force: true` path. */
export function invalidateCache(): void {
  cache = null;
  expandCache = null;
}
