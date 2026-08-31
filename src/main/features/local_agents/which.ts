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

import * as fs from 'node:fs/promises';
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
 * fs.stat's `mode` is synthesized) — except that a bare (extension-less)
 * Unix shebang script is not something `spawn` can run, so we skip it.
 */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
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
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(p, 'r');
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead >= 2 && buf[0] === 0x23 /* # */ && buf[1] === 0x21 /* ! */;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => { /* ignore */ });
  }
}
