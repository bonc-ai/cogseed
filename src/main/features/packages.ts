/**
 * External packages — read-side accessor for the `<uid>/local/packages/`
 * domain (verbatim third-party repos; Python envs live under data/venv; see paths.ts and
 * docs/plans/open-ecosystem-architecture.md §A).
 *
 * Write-side lives in `bin/cogseed-pkg.cjs` (the bash-driven installer CLI,
 * standalone CJS like run-skill.cjs). The contract between the two is the
 * `_registry.json` schema below. Main-process code must treat the whole
 * packages tree as read-only: never normalize package contents, never
 * reconcile, never write the registry from here. The installer runs
 * out-of-process, so reads here are always fresh-from-disk (no cache) —
 * registry files are tiny and read at most once per chat turn.
 *
 * Registry schema (v1), `<uid>/local/packages/_registry.json`:
 * ```
 * {
 *   "version": 1,
 *   "packages": [{
 *     "name": "demo-cli",               // dir name under packages/
 *     "repo_url": "https://github.com/...",
 *     "commit": "<sha>",
 *     "kind": "skill" | "cli" | "both",
 *     "skill_roots": [".", "skills"],   // rel dirs whose children (or self) hold SKILL.md
 *     "bin_entries": [{"name": "demo-cli", "target": "bin/cli.js", "runtime": "node" | "python" | "sh" | "native"}],
 *     "deps_consent": true,             // D3: user approved dependency installs for this package
 *     "enabled": true,
 *     "installed_at": "<iso>", "updated_at": "<iso>"
 *   }]
 * }
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
  userPackagesDir,
  userPackageDir,
  userPackagesRegistryFile,
  userPackagesBinDir,
  PC_ROOT,
  WS_ROOT,
  VENV_ROOT,
  NODE_NPM_CACHE_DIR,
  NODE_NPM_PREFIX_DIR,
  NODE_NPM_GLOBAL_BIN_DIR,
} from '../paths';
import { createLogger } from '../logger';
import { companionSkillFileExists } from './package_skills';
import { bundledRuntimeEnv, bundledRuntimePathEntries } from '../util/bundled-runtime';
import { killProcessTree } from '../../core-agent/src/sandbox/executor';

const log = createLogger('packages');

export interface PackageBinEntry {
  name: string;
  target: string;
  runtime: 'node' | 'python' | 'sh' | 'native';
}

export interface PackageEntry {
  name: string;
  repo_url?: string;
  commit?: string;
  kind: 'skill' | 'cli' | 'both';
  skill_roots: string[];
  bin_entries: PackageBinEntry[];
  deps_consent?: boolean;
  enabled: boolean;
  installed_at?: string;
  updated_at?: string;
}

export interface PackagesRegistry {
  version: number;
  packages: PackageEntry[];
}

function emptyRegistry(): PackagesRegistry {
  return { version: 1, packages: [] };
}

/** A package name is a single safe path segment (it becomes a dir name). */
function isSafePackageName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

function sanitiseEntry(raw: unknown): PackageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!isSafePackageName(e.name)) return null;
  const kind = e.kind === 'skill' || e.kind === 'cli' || e.kind === 'both' ? e.kind : null;
  if (!kind) return null;
  const skillRoots = Array.isArray(e.skill_roots)
    ? e.skill_roots.filter((r): r is string =>
      typeof r === 'string' && !path.isAbsolute(r) && !r.split(/[\\/]/).includes('..'))
    : [];
  const binEntries: PackageBinEntry[] = [];
  if (Array.isArray(e.bin_entries)) {
    for (const b of e.bin_entries) {
      if (!b || typeof b !== 'object') continue;
      const { name, target, runtime } = b as Record<string, unknown>;
      if (!isSafePackageName(name)) continue;
      if (typeof target !== 'string' || path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) continue;
      if (runtime !== 'node' && runtime !== 'python' && runtime !== 'sh' && runtime !== 'native') continue;
      binEntries.push({ name, target, runtime });
    }
  }
  return {
    name: e.name,
    ...(typeof e.repo_url === 'string' ? { repo_url: e.repo_url } : {}),
    ...(typeof e.commit === 'string' ? { commit: e.commit } : {}),
    kind,
    skill_roots: skillRoots,
    bin_entries: binEntries,
    ...(typeof e.deps_consent === 'boolean' ? { deps_consent: e.deps_consent } : {}),
    enabled: e.enabled !== false,
    ...(typeof e.installed_at === 'string' ? { installed_at: e.installed_at } : {}),
    ...(typeof e.updated_at === 'string' ? { updated_at: e.updated_at } : {}),
  };
}

/** Read + sanitise the packages registry. Missing / corrupt → empty. */
export function readPackagesRegistry(uid: string): PackagesRegistry {
  const p = userPackagesRegistryFile(uid);
  try {
    if (!fs.existsSync(p)) return emptyRegistry();
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.packages)) return emptyRegistry();
    const packages = (parsed.packages as unknown[]).map(sanitiseEntry).filter((e): e is PackageEntry => !!e);
    return { version: 1, packages };
  } catch (err) {
    log.warn(`registry read failed, treating as empty: ${(err as Error).message}`);
    return emptyRegistry();
  }
}

/**
 * Absolute SkillLoader roots contributed by enabled packages. A
 * `skill_roots` entry of `"."` means the package dir itself is the skill
 * dir (top-level SKILL.md) — the loader root is then the packages dir, so
 * the loader's `<root>/<id>/SKILL.md` shape resolves with id = package
 * name. Other entries (e.g. `"skills"`) map to `<pkg>/<rel>` roots whose
 * children are skill dirs. De-duplicated, existing dirs only.
 */
export function packageSkillRoots(uid: string, opts: { includeDisabled?: boolean } = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const packagesRoot = userPackagesDir(uid);
  for (const pkg of readPackagesRegistry(uid).packages) {
    if (!opts.includeDisabled && !pkg.enabled) continue;
    for (const rel of pkg.skill_roots) {
      const abs = rel === '.' ? packagesRoot : path.join(userPackageDir(uid, pkg.name), rel);
      const resolved = path.resolve(abs);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        if (fs.statSync(resolved).isDirectory()) out.push(resolved);
      } catch { /* not materialized yet */ }
    }
  }
  return out;
}

export function enabledPackageSkillRoots(uid: string): string[] {
  return packageSkillRoots(uid);
}

/**
 * One-line environment summary for the commander's `### Environment`
 * runtime block: which external-package CLIs are callable in bash. Kept
 * to installed facts the model cannot discover otherwise — runtime
 * version probing (node/python) is deliberately out (spawn cost per
 * prompt build for information `bash --version` can fetch on demand).
 *
 * Packages that have an auto-authored companion usage skill are skipped:
 * the skill (inlined into `## Available skills`) already documents those
 * binaries, so re-listing the bare names here would be duplicate prompt
 * weight and churn the cache prefix twice.
 */
// Stated without version numbers on purpose: versions live in the runtime
// manifest, and embedding them here would churn the prompt cache prefix on
// every runtime bump. The model gets exact versions from `node --version`
// etc. on demand. This line exists so the model uses the bundled runtimes
// instead of trying to install them (the failure mode behind long brew/curl
// thrash loops); it does NOT discourage using bash + code for long-tail work.
const BUILTIN_RUNTIME_LINE =
  'Built-in runtimes, always available in `bash` (no install needed): `node`, `npm`, `npx`, `python`, `uv`. '
  + 'Use them directly; never install or upgrade these runtimes via brew/apt/curl. '
  + 'If a library requires a newer runtime version than the built-in one, report that instead of installing a runtime.';

export function buildEnvSummaryLine(uid: string): string {
  try {
    const names: string[] = [];
    for (const pkg of readPackagesRegistry(uid).packages) {
      if (!pkg.enabled) continue;
      if (companionSkillFileExists(uid, pkg.name)) continue;
      for (const b of pkg.bin_entries) names.push(b.name);
    }
    if (!names.length) return `${BUILTIN_RUNTIME_LINE}\nNo external package CLIs installed.`;
    names.sort((a, b) => a.localeCompare(b));
    return `${BUILTIN_RUNTIME_LINE}\nInstalled package CLIs (callable directly in \`bash\`): ${names.map((n) => `\`${n}\``).join(', ')}.`;
  } catch {
    return `${BUILTIN_RUNTIME_LINE}\nNo external package CLIs installed.`;
  }
}

/**
 * Run an cogseed-pkg.cjs subcommand from the main process (UI-initiated
 * enable/disable/update/remove). The CLI is the SINGLE writer of
 * `_registry.json` (CLAUDE.md invariant) — the UI must never edit the
 * registry directly, so management actions funnel through here. Install is
 * intentionally NOT exposed to the UI: it needs the clone + dependency
 * consent flow, which stays on the commander/CLI path.
 */
const PKG_MANAGE_COMMANDS = new Set(['enable', 'disable', 'update', 'remove']);

export interface PackageActionResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

interface PackageProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

const PACKAGE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const PACKAGE_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function runPackageProcessForTest(
  bin: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<PackageProcessResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        env: options.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: '', error: (err as Error).message });
      return;
    }

    const timeoutMs = Math.max(1, options.timeoutMs ?? PACKAGE_COMMAND_TIMEOUT_MS);
    const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? PACKAGE_COMMAND_MAX_OUTPUT_BYTES);
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: PackageProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(result);
    };
    const terminate = () => {
      try { killProcessTree(child, 'SIGKILL'); } catch { /* already gone */ }
    };
    const capture = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        terminate();
        finish({
          code: -1,
          stdout,
          stderr,
          error: `package command output exceeded ${maxOutputBytes} bytes`,
        });
        return;
      }
      if (target === 'stdout') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
    };

    timer = setTimeout(() => {
      terminate();
      finish({
        code: -1,
        stdout,
        stderr,
        error: `package command timed out after ${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
      });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => capture('stderr', chunk));
    child.on('error', (err) => finish({ code: -1, stdout, stderr, error: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

export function buildPackageCommandEnv(uid: string, pcDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...bundledRuntimeEnv(),
    ELECTRON_RUN_AS_NODE: '1',
    COGSEED_UID: uid,
    COGSEED_PC_DIR: pcDir,
    COGSEED_WORKSPACE_ROOT: WS_ROOT,
    COGSEED_VENV_ROOT: VENV_ROOT,
    NPM_CONFIG_CACHE: NODE_NPM_CACHE_DIR,
    NPM_CONFIG_PREFIX: NODE_NPM_PREFIX_DIR,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  const pathEntries = bundledRuntimePathEntries();
  try {
    if (fs.statSync(NODE_NPM_GLOBAL_BIN_DIR).isDirectory()) {
      pathEntries.push(NODE_NPM_GLOBAL_BIN_DIR);
    }
  } catch { /* npm global shims are created on demand */ }
  if (pathEntries.length) {
    const existingPath = env.PATH || env.Path || '';
    env.PATH = [pathEntries.join(path.delimiter), existingPath].filter(Boolean).join(path.delimiter);
  }
  return env;
}

/**
 * UI-initiated install. Unlike enable/disable/update/remove, install needs a
 * human confirmation of the exact command before it runs: the renderer shows
 * the source + name in a confirm modal first, then calls `packages.install`.
 * Deps consent stays OFF (the D3 dependency-consent flow remains on the
 * commander/CLI path); a package that needs npm/pip deps must be installed
 * (or consented) from the CLI.
 */
export interface PackageInstallInput {
  source: string;
  name: string;
}

export function validatePackageInstallInput(raw: unknown): { ok: boolean; source?: string; name?: string; error?: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid input' };
  const input = raw as Record<string, unknown>;
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!source || source.length > 2000 || /[\u0000-\u001f\u007f]/.test(source)) {
    return { ok: false, error: 'invalid source' };
  }
  if (source.startsWith('-') || source.startsWith('--')) return { ok: false, error: 'invalid source' };
  let looksLocal = false;
  try { looksLocal = fs.existsSync(source) && fs.statSync(source).isDirectory(); } catch { looksLocal = false; }
  let looksUrl = false;
  try {
    const u = new URL(source);
    looksUrl = u.protocol === 'https:' || u.protocol === 'http:';
  } catch { /* not a URL */ }
  if (!looksLocal && !looksUrl) {
    return { ok: false, error: 'source must be an existing local directory or an http(s) URL' };
  }
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    return { ok: false, error: 'invalid package name' };
  }
  return { ok: true, source, name };
}

export function runPackageInstall(uid: string, raw: unknown): Promise<PackageActionResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const validated = validatePackageInstallInput(raw);
    const finish = (result: PackageActionResult) => {
      const fields = {
        command: 'install',
        package_name: validated.name || '',
        result: result.ok ? 'success' : 'failure',
        duration_ms: Date.now() - startedAt,
        ...(result.error ? { error_message: result.error } : {}),
      };
      if (result.ok) log.info('package install result', fields);
      else log.warn('package install result', fields);
      resolve(result);
    };
    if (!validated.ok) {
      log.warn('package install rejected', { reason: validated.error, duration_ms: Date.now() - startedAt });
      resolve({ ok: false, stdout: '', error: validated.error });
      return;
    }
    log.info('package install start', { package_name: validated.name });
    let pcDir = PC_ROOT;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { app } = require('electron') as typeof import('electron');
      if (app && app.isPackaged) pcDir = PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
    } catch { /* not in electron (tests) */ }
    const node = process.env.COGSEED_TEST_NODE || process.execPath;
    const script = path.join(pcDir, 'bin', 'cogseed-pkg.cjs');
    // No --consent-deps: dependency install stays on the commander/CLI path.
    void runPackageProcessForTest(node, [script, 'install', validated.source, '--name', validated.name], {
      env: buildPackageCommandEnv(uid, pcDir),
    }).then((result) => {
      if (result.error) {
        finish({ ok: false, stdout: result.stdout, error: result.error });
        return;
      }
      if (result.code === 0) { finish({ ok: true, stdout: result.stdout }); return; }
      let error = result.stderr.trim();
      try { const j = JSON.parse(error.slice(error.indexOf('{'))); if (j && j.error) error = j.error; } catch { /* keep raw */ }
      finish({ ok: false, stdout: result.stdout, error: error || `cogseed-pkg exited ${result.code}` });
    });
  });
}

export function runPackageCommand(uid: string, command: string, name: string): Promise<PackageActionResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const safeCommand = typeof command === 'string' ? command : typeof command;
    let settled = false;
    const finish = (result: PackageActionResult) => {
      if (settled) return;
      settled = true;
      const fields = {
        command: safeCommand,
        package_name: name,
        result: result.ok ? 'success' : 'failure',
        duration_ms: Date.now() - startedAt,
        ...(result.error ? { error_message: result.error } : {}),
      };
      if (result.ok) log.info('package action result', fields);
      else log.warn('package action result', fields);
      resolve(result);
    };
    if (!PKG_MANAGE_COMMANDS.has(command)) {
      log.warn('package action rejected', {
        command: safeCommand,
        reason: 'unsupported_command',
        duration_ms: Date.now() - startedAt,
      });
      resolve({ ok: false, stdout: '', error: `unsupported command: ${command}` });
      return;
    }
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      log.warn('package action rejected', {
        command: safeCommand,
        reason: 'invalid_package_name',
        duration_ms: Date.now() - startedAt,
      });
      resolve({ ok: false, stdout: '', error: 'invalid package name' });
      return;
    }
    log.info('package action start', { command, package_name: name });
    // app may be undefined under vitest — same asar.unpacked handling as
    // client.ts::buildSkillSandboxEnv.
    let pcDir = PC_ROOT;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { app } = require('electron') as typeof import('electron');
      if (app && app.isPackaged) pcDir = PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
    } catch { /* not in electron (tests) */ }
    // Vitest itself runs under Electron-as-Node for native ABI parity, but
    // standalone JS helpers should use the outer Node executable so tests do
    // not create extra CogSeed-named Electron processes.
    const node = process.env.COGSEED_TEST_NODE || process.execPath;
    const script = path.join(pcDir, 'bin', 'cogseed-pkg.cjs');
    void runPackageProcessForTest(node, [script, command, name], {
      env: buildPackageCommandEnv(uid, pcDir),
    }).then((result) => {
      if (result.error) {
        finish({ ok: false, stdout: result.stdout, error: result.error });
        return;
      }
      if (result.code === 0) { finish({ ok: true, stdout: result.stdout }); return; }
      let error = result.stderr.trim();
      try { const j = JSON.parse(error.slice(error.indexOf('{'))); if (j && j.error) error = j.error; } catch { /* keep raw */ }
      finish({ ok: false, stdout: result.stdout, error: error || `cogseed-pkg exited ${result.code}` });
    });
  });
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ── Plugin manifest (whitelisted UI-facing subset) ───────────────────────

export interface PackageManifestUi {
  manifest_version?: string;
  kind?: string;
  name?: { zh?: string; en?: string };
  description?: { zh?: string; en?: string };
  version?: string;
  audience_roles?: string[];
  license?: { model?: string; unit?: string };
  ui?: { entry?: string; commands?: string[] };
}

function sanitiseManifest(raw: unknown): PackageManifestUi | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const out: PackageManifestUi = {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);
  const manifestVersion = str(m.manifest_version);
  if (manifestVersion) out.manifest_version = manifestVersion;
  const kind = str(m.kind);
  if (kind) out.kind = kind;
  const name = m.name;
  if (name && typeof name === 'object') {
    const n = name as Record<string, unknown>;
    const zh = str(n.zh); const en = str(n.en);
    if (zh || en) out.name = { ...(zh ? { zh } : {}), ...(en ? { en } : {}) };
  } else if (str(name)) {
    out.name = { en: str(name) };
  }
  const description = m.description;
  if (description && typeof description === 'object') {
    const d = description as Record<string, unknown>;
    const zh = typeof d.zh === 'string' ? d.zh.trim().slice(0, 500) : '';
    const en = typeof d.en === 'string' ? d.en.trim().slice(0, 500) : '';
    if (zh || en) out.description = { ...(zh ? { zh } : {}), ...(en ? { en } : {}) };
  }
  const version = str(m.version);
  if (version) out.version = version;
  if (Array.isArray(m.audience_roles)) {
    const roles = m.audience_roles.filter((r): r is string => typeof r === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r)).slice(0, 8);
    if (roles.length) out.audience_roles = roles;
  }
  const license = m.license;
  if (license && typeof license === 'object') {
    const l = license as Record<string, unknown>;
    const model = str(l.model); const unit = str(l.unit);
    if (model || unit) out.license = { ...(model ? { model } : {}), ...(unit ? { unit } : {}) };
  }
  const ui = m.ui;
  if (ui && typeof ui === 'object') {
    const u = ui as Record<string, unknown>;
    const entry = typeof u.entry === 'string' ? u.entry.trim() : '';
    const commands = Array.isArray(u.commands)
      ? u.commands.filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c)).slice(0, 64)
      : [];
    if (entry || commands.length) out.ui = { ...(entry ? { entry } : {}), ...(commands.length ? { commands } : {}) };
  }
  return out;
}

/** Read a package's `manifest.json` (whitelisted fields only; never the
 *  package.json used by the installer registry). Missing/corrupt → null. */
export function readPackageManifest(uid: string, name: string): PackageManifestUi | null {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) return null;
  try {
    const file = path.join(userPackageDir(uid, name), 'manifest.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitiseManifest(parsed);
  } catch {
    return null;
  }
}

/** Skill ids (directory names) a package contributes through its own
 *  skill_roots. Order follows the roots declaration. */
export function listPackageSkills(uid: string, pkg: PackageEntry): string[] {
  const pkgDir = userPackageDir(uid, pkg.name);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rel of pkg.skill_roots) {
    if (rel === '.') {
      if (isFile(path.join(pkgDir, 'SKILL.md')) && !seen.has(pkg.name)) {
        seen.add(pkg.name);
        out.push(pkg.name);
      }
      continue;
    }
    const root = path.join(pkgDir, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      if (!isFile(path.join(root, entry.name, 'SKILL.md'))) continue;
      seen.add(entry.name);
      out.push(entry.name);
    }
  }
  return out;
}

function normalizeGithubRepoKey(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s
    .replace(/^git\+/i, '')
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

let _ossProjectNameByRepo: Map<string, string> | null = null;
function ossProjectNameByRepo(): Map<string, string> {
  if (_ossProjectNameByRepo) return _ossProjectNameByRepo;
  const out = new Map<string, string>();
  try {
    const file = path.join(__dirname, '..', 'data', 'oss-projects.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects?: unknown[] };
    for (const raw of Array.isArray(parsed.projects) ? parsed.projects : []) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const key = normalizeGithubRepoKey(row.repo);
      const name = String(row.name || '').trim();
      if (key && name) out.set(key, name);
    }
  } catch (err) {
    log.warn(`oss project catalog read failed for package display names: ${(err as Error).message}`);
  }
  _ossProjectNameByRepo = out;
  return out;
}

function packageJsonDisplayName(uid: string, pkg: PackageEntry): string {
  try {
    const file = path.join(userPackageDir(uid, pkg.name), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name.trim() : '';
  } catch {
    return '';
  }
}

function packageDisplayName(uid: string, pkg: PackageEntry): string {
  const repoName = ossProjectNameByRepo().get(normalizeGithubRepoKey(pkg.repo_url || ''));
  return repoName || packageJsonDisplayName(uid, pkg) || pkg.name;
}

function countPackageSkills(uid: string, pkg: PackageEntry): number {
  return listPackageSkills(uid, pkg).length;
}

/** Package rows for the management UI. */
export interface PackageUiRow {
  name: string;
  display_name?: string;
  kind: 'skill' | 'cli' | 'both';
  enabled: boolean;
  repo_url?: string;
  commit?: string;
  skill_count: number;
  bin_names: string[];
  updated_at?: string;
  manifest?: PackageManifestUi;
  has_ui?: boolean;
}

export function listPackagesForUi(uid: string): PackageUiRow[] {
  return readPackagesRegistry(uid).packages.map((p) => {
    const manifest = readPackageManifest(uid, p.name);
    const hasUi = !!(manifest?.ui && typeof manifest.ui.entry === 'string' && manifest.ui.entry);
    return {
      name: p.name,
      display_name: packageDisplayName(uid, p),
      kind: p.kind,
      enabled: p.enabled !== false,
      ...(p.repo_url ? { repo_url: p.repo_url } : {}),
      ...(p.commit ? { commit: p.commit.slice(0, 12) } : {}),
      skill_count: countPackageSkills(uid, p),
      bin_names: p.bin_entries.map((b) => b.name),
      ...(p.updated_at ? { updated_at: p.updated_at } : {}),
      ...(manifest ? { manifest } : {}),
      ...(hasUi ? { has_ui: true } : {}),
    };
  });
}

/** The shim dir to prepend to the bash tool PATH, or null when no enabled
 *  package ships CLI entries (avoid PATH noise for skill-only installs). */
export function packagesBinDirIfActive(uid: string): string | null {
  const reg = readPackagesRegistry(uid);
  const hasCli = reg.packages.some((p) => p.enabled && p.bin_entries.length > 0);
  if (!hasCli) return null;
  const dir = userPackagesBinDir(uid);
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

const PACKAGE_BIN_REL_DIRS = ['npm/bin', 'bin'];

function hasExecutableFile(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    try {
      const st = fs.statSync(abs);
      if (process.platform === 'win32') return true;
      if ((st.mode & 0o111) !== 0) return true;
    } catch { /* ignore broken symlinks */ }
  }
  return false;
}

/** Directories contributed by enabled external packages that should be
 * prepended to the bash / interactive-CLI PATH for this user. `.bin` is the
 * normal shim location; package-local bin dirs are a compatibility fallback
 * for repos that ship their own executable bundle but no generated shim. */
export function packagePathEntriesIfActive(uid: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | null | undefined) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    try {
      if (!fs.statSync(resolved).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(resolved);
    out.push(resolved);
  };

  add(packagesBinDirIfActive(uid));

  for (const pkg of readPackagesRegistry(uid).packages) {
    if (!pkg.enabled) continue;
    const pkgRoot = userPackageDir(uid, pkg.name);
    for (const rel of PACKAGE_BIN_REL_DIRS) {
      const dir = path.join(pkgRoot, rel);
      if (hasExecutableFile(dir)) add(dir);
    }
  }

  return out;
}
