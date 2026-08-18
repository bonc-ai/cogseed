/**
 * Path containment check for tool-layer sandboxing.
 *
 * File tools (read_file / search_files / grep_files) must refuse paths that
 * fall outside "what the current conversation can see": the active user
 * workspace + the current cid's attachment dir. This util does the pure
 * path math; callers assemble the allowed root list from their context.
 *
 * Why a separate util: layering. `util/` cannot import `features/` (see
 * CLAUDE.md §3), so the roots are passed in rather than looked up. Callers
 * in `features/` or `model/core-agent/` compute `[activeWorkspace,
 * attachmentDir(uid,cid)]` and pass the array to `isPathAllowed`.
 *
 * Symlink handling: canonicalization uses `fs.realpathSync` on both sides so
 * a symlink planted inside an allowed root cannot exfiltrate to /etc/passwd.
 * For prospective writes, the nearest existing ancestor is canonicalized and
 * the missing tail is rejoined. This is path identity/containment logic, not a
 * TOCTOU guarantee; file tools must still call `isPathAllowed` at execution.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function canonicalizePath(p: string): string {
  try { return fs.realpathSync(p); }
  catch {
    // Path doesn't exist — walk up until we hit an existing ancestor, realpath
    // that, then rejoin the missing tail. Needed because macOS tmpdir
    // (/var/folders/...) is itself a symlink to /private/var/..., so plain
    // path.resolve on a nonexistent candidate wouldn't match a realpath-ed
    // existing root.
    const resolved = path.resolve(p);
    let existing = resolved;
    const missing: string[] = [];
    while (existing && existing !== path.dirname(existing)) {
      try { existing = fs.realpathSync(existing); break; }
      catch {
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    return missing.length ? path.join(existing, ...missing) : existing;
  }
}

/** True when `real` is a canonical system/temp root directory: binding such a
 *  path as a conversation workspace is meaningless (it scans a pile of system
 *  temp files) and can leak them into the UI. Matches $TMPDIR (macOS realpath
 *  /private/var/folders/.../T), /tmp, /private/tmp, /var/tmp and the
 *  filesystem root. Deliberately exact-match only: a *subdirectory* of the
 *  temp root may be a real project the user works in, so it stays bindable.
 *  Callers pass the canonical (realpath-ed) candidate. */
export function isSystemTmpDir(real: string): boolean {
  if (!real) return true;
  if (real === path.parse(real).root) return true; // '/'
  const tmpRoots = new Set([
    path.resolve('/tmp'),
    path.resolve('/private/tmp'),
    path.resolve('/var/tmp'),
    '/private/var/tmp',
  ]);
  if (tmpRoots.has(real)) return true;
  try {
    const tmpReal = canonicalizePath(os.tmpdir());
    if (tmpReal && real === tmpReal) return true;
  } catch {
    // tmpdir resolution failed — conservative: don't block on it
  }
  return false;
}


/**
 * Detect whether the filesystem containing an existing path resolves names
 * case-sensitively. The probe only changes the case of an existing path
 * component and asks the filesystem to resolve it; it never creates files.
 */
export function isFileSystemCaseSensitive(existingPath: string): boolean {
  if (process.platform === 'win32') return false;
  let current = canonicalizePath(existingPath);
  while (current && current !== path.dirname(current)) {
    const parent = path.dirname(current);
    const base = path.basename(current);
    const letterIndex = [...base].findIndex((character) => /[A-Za-z]/.test(character));
    if (letterIndex >= 0) {
      const characters = [...base];
      const character = characters[letterIndex];
      characters[letterIndex] = character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase();
      const alternate = path.join(parent, characters.join(''));
      try {
        return canonicalizePath(alternate) !== canonicalizePath(current);
      } catch {
        return true;
      }
    }
    current = parent;
  }
  return process.platform !== 'darwin';
}

/**
 * Is `candidate` inside any of `allowedRoots`?
 *
 * Both sides are normalized via realpath to resist symlink escape. A path
 * equal to a root is considered inside (reading the root dir itself is
 * allowed by this function — callers may add a "must be a file" check on
 * top). Containment uses `startsWith(root + sep)` so `/foo/barbaz` is NOT
 * inside `/foo/bar`.
 *
 * Returns false for empty inputs, relative candidate paths, or empty
 * roots list.
 */
export function isPathAllowed(candidate: string, allowedRoots: readonly string[]): boolean {
  if (!candidate || !allowedRoots.length) return false;
  if (!path.isAbsolute(candidate)) return false;

  const realCand = canonicalizePath(candidate);
  for (const root of allowedRoots) {
    if (!root || !path.isAbsolute(root)) continue;
    const realRoot = canonicalizePath(root);
    if (realCand === realRoot) return true;
    if (realCand.startsWith(realRoot + path.sep)) return true;
  }
  return false;
}
