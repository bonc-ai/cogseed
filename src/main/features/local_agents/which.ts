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
 * drop bare names (MinGW, etc.). A bare name that is a Unix shebang
 * script (npm's `#!/bin/sh` shim) is NOT spawnable on Windows and is
 * skipped so the `.cmd` shim npm generates alongside it wins instead.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
  const extra = String(env.COGSEED_AGENT_SEARCH_ROOTS || '')
    .split(isWindows ? ';' : ':')
    .map(s => s.trim())
    .filter(Boolean);
  if (isWindows) {
    const localAppData = env.LOCALAPPDATA || (home ? path.win32.join(home, 'AppData', 'Local') : '');
    const appData = env.APPDATA || (home ? path.win32.join(home, 'AppData', 'Roaming') : '');
    if (localAppData) {
      roots.push(localAppData);
      roots.push(path.win32.join(localAppData, 'Programs'));
    }
    if (appData) {
      roots.push(appData);
      roots.push(path.win32.join(appData, 'npm'));
    }
    if (home) roots.push(path.win32.join(home, '.local', 'bin'));
    roots.push(...extra);
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
  roots.push(...extra);
  return [...new Set(roots)].filter(Boolean);
}

let recursiveCache: { at: number; key: string; value: string | null } | null = null;
const whereCache = new Map<string, { at: number; hits: string[] }>();
const whereInFlight = new Map<string, Promise<string[]>>();

/** Clear recursive discovery caches when callers request a forced rescan. */
export function invalidateRecursiveCache(): void {
  recursiveCache = null;
  whereCache.clear();
}

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
  opts: { env?: NodeJS.ProcessEnv; home?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!name) return null;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const timeoutMs = opts.timeoutMs ?? 2_500;
  const roots = recursiveSearchRoots(name, env, home);
  const key = `${process.platform}|${name}|${roots.join(';')}|${timeoutMs}`;
  if (recursiveCache && recursiveCache.key === key && Date.now() - recursiveCache.at < 5 * 60_000) {
    return recursiveCache.value;
  }

  const resolved = isWindows
    ? await findBinWindowsRecursive(name, roots, timeoutMs, env)
    : await findBinPosixRecursive(name, roots, timeoutMs);
  recursiveCache = { at: Date.now(), key, value: resolved };
  return resolved;
}

function cachedWhere(root: string, pattern: string, timeoutMs: number): Promise<string[]> {
  const key = `${root}\u0000${pattern}`;
  const hit = whereCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return Promise.resolve(hit.hits);
  const pending = whereInFlight.get(key);
  if (pending) return pending;
  const promise = new Promise<string[]>(resolve => {
    let settled = false;
    let stdout = '';
    const finish = (hits: string[]) => {
      if (settled) return;
      settled = true;
      whereCache.set(key, { at: Date.now(), hits });
      resolve(hits);
    };
    let child;
    try {
      child = spawn('where.exe', ['/R', root, pattern], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish([]);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish([]);
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); finish([]); });
    child.on('close', code => {
      clearTimeout(timer);
      finish(code === 0 ? stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []);
    });
  }).finally(() => { whereInFlight.delete(key); });
  whereInFlight.set(key, promise);
  return promise;
}

async function findBinWindowsRecursive(
  name: string,
  roots: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const allowedNames = new Set(winExtCandidates(env).map(ext => (name + ext).toLowerCase()));
  // `name.*` covers every PATHEXT variant in one query; retain the bare-name
  // query for extensionless shims. Avoid spawning one `where.exe` per suffix.
  const patterns = [name, name + '.*'];
  for (const root of roots) {
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const pattern of patterns) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      const hits = await cachedWhere(root, pattern, remainingMs);
      for (const line of hits) {
        if (!allowedNames.has(path.win32.basename(line).toLowerCase())) continue;
        try {
          if (fs.statSync(line).isFile()) return line;
        } catch {
          // stale or deleted hit
        }
      }
    }
  }
  return null;
}

async function findBinPosixRecursive(name: string, roots: string[], timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    if (depth > 4 || seen.has(dir) || Date.now() > deadline) return null;
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
function winExtCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
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
 * fs.stat's `mode` is synthesized) — except that a bare (extension-less)
 * Unix shebang script is not something `spawn` can run, so we skip it.
 */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    if (isWindows) {
      // npm generates a `<name>` bash shim (`#!/bin/sh`) alongside every
      // `<name>.cmd`/`<name>.ps1`. The bare shim is a Unix script Windows
      // cannot spawn; skip it so whichBin falls through to the real `.cmd`.
      if (path.extname(p) === '' && await isShebangScript(p)) return false;
      return true;
    }
    // 0o111 = any of user/group/other execute.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** True when the file starts with `#!` (a Unix shebang). Windows spawn
 *  cannot execute these directly. Reads at most two bytes; returns false
 *  on any read error rather than throwing. */
async function isShebangScript(p: string): Promise<boolean> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(p, 'r');
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead >= 2 && buf[0] === 0x23 /* # */ && buf[1] === 0x21 /* ! */;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => { /* ignore */ });
  }
}
