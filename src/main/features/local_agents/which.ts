/**
 * Cross-platform binary lookup. Mirrors `exec.LookPath` semantics.
 *
 * Why we don't use the `which` npm package: keeps the dep allow-list
 * tight, and the logic is short. Single source of truth so registry.ts
 * doesn't carry path-search code.
 *
 * POSIX: scan `process.env.PATH` (split by ':'), plus optional
 * caller-provided directories, stat `<dir>/<name>`, accept if it's a
 * regular file with any executable bit set.
 *
 * Windows: scan PATH (split by ';'), multiply each candidate by
 * `process.env.PATHEXT` (e.g. `.COM;.EXE;.BAT;.CMD`); first stat hit
 * wins. The empty extension is also tried first because some installs
 * drop bare names (PowerShell shims, MinGW, etc.).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const isWindows = process.platform === 'win32';

/** Scan PATH and return the first absolute path matching `name`, or null. */
export async function whichBin(name: string, opts: { extraDirs?: string[] } = {}): Promise<string | null> {
  if (!name) return null;

  // Absolute or relative path with separator → caller already resolved.
  if (path.isAbsolute(name) || name.includes(path.sep) || (isWindows && name.includes('/'))) {
    return (await isExecutableFile(name)) ? path.resolve(name) : null;
  }

  const pathEnv = process.env.PATH ?? '';
  const dirs = uniqueDirs([
    ...pathEnv.split(path.delimiter).filter(Boolean),
    ...(opts.extraDirs ?? []),
  ]);
  if (dirs.length === 0) return null;

  const exts = isWindows ? winExtCandidates() : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function recursiveSearchRoots(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  const roots: string[] = [];
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
    return [...new Set(roots.map(r => r.toLowerCase()))].filter(Boolean);
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

let recursiveCache: { at: number; key: string; value: string | null } | null = null;

/**
 * Installer-layout fallback: when PATH and the standard candidate dirs miss,
 * recursively search per-agent install roots. Replaces hard-coded dir
 * whack-a-mole (Windows-app hash dirs, WorkBuddy variants, …).
 *
 * Windows uses `where.exe /R`; POSIX uses a bounded recursive walk.
 * Results are cached 5 minutes, matching registry's detect cache.
 */
export async function findBinRecursively(
  name: string,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<string | null> {
  if (!name) return null;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const roots = recursiveSearchRoots(name, env, home);
  const key = `${process.platform}|${name}|${roots.join(';')}`;
  if (recursiveCache && recursiveCache.key === key && Date.now() - recursiveCache.at < 5 * 60_000) {
    return recursiveCache.value;
  }

  const resolved = isWindows
    ? findBinWindowsRecursive(name, roots)
    : await findBinPosixRecursive(name, roots);
  recursiveCache = { at: Date.now(), key, value: resolved };
  return resolved;
}

function findBinWindowsRecursive(name: string, roots: string[]): string | null {
  const candidates = winExtCandidates().map(ext => name + ext);
  for (const root of roots) {
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      let result;
      try {
        result = spawnSync('where.exe', ['/R', root, candidate], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
        });
      } catch {
        continue;
      }
      if (result.status !== 0) continue;
      const line = String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (line && fs.existsSync(line) && fs.statSync(line).isFile()) return line;
    }
  }
  return null;
}

async function findBinPosixRecursive(name: string, roots: string[]): Promise<string | null> {
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    if (depth > 4 || seen.has(dir)) return null;
    seen.add(dir);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return null; }
    for (const entry of entries) {
      const full = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const hit = await walk(full, depth + 1);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name === name && (await isExecutableFilePosix(full))) {
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

async function isExecutableFilePosix(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function uniqueDirs(dirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
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

/**
 * Returns the candidate extensions to try on Windows, with the empty
 * extension first so an exact-name hit (rare but possible) short-circuits.
 */
function winExtCandidates(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  // Always try the bare name first.
  return ['', ...exts];
}

/**
 * stat-and-check; resolves to false on any error (ENOENT, EACCES, etc.)
 * so callers don't need to wrap.
 *
 * On POSIX we additionally require the executable bit; on Windows the
 * extension match is enough (NTFS doesn't carry a unix-style x bit and
 * fs.stat's `mode` is synthesized).
 */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    if (isWindows) return true;
    // 0o111 = any of user/group/other execute.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
