/** Paths the isolated Runtime must never read or write directly. Host tools are
 * the only supported access path to cognition, recall, memory and config.
 *
 * This guard is defense in depth for file tools; shell and skill execution are
 * additionally wrapped by the OS sandbox. It intentionally does not import the
 * recall feature module because the worker boundary forbids recall imports. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  userCloudConfigDir,
  userCloudRoot,
  userCognitionDir,
  userMemoryDir,
} from '../../../../paths';
import { isPathAllowed } from '../../../../util/path-sandbox';

export type RuntimeProtectedAccess = 'read' | 'write';

function canonicalForGuard(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

export function runtimeProtectedRoots(userId: string): string[] {
  return [
    userCognitionDir(userId),
    path.join(userCloudRoot(userId), 'recall'),
    userMemoryDir(userId),
    userCloudConfigDir(userId),
  ].map(canonicalForGuard);
}

export function isRuntimeProtectedPath(
  userId: string,
  candidate: string,
  _access: RuntimeProtectedAccess = 'read',
): boolean {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const target = canonicalForGuard(candidate);
  return isPathAllowed(target, runtimeProtectedRoots(userId));
}

export function assertRuntimePathAllowed(
  userId: string,
  candidate: string,
  access: RuntimeProtectedAccess = 'read',
): void {
  if (isRuntimeProtectedPath(userId, candidate, access)) {
    throw Object.assign(
      new Error('runtime path points to CogSeed private cognition data'),
      { code: 'E_RUNTIME_COGNITION_PATH' },
    );
  }
}

/** Last-resort textual guard for platforms without an OS sandbox (Windows).
 *  It is intentionally conservative about the private store directory names. */
export function containsProtectedPathHint(userId: string, text: string): boolean {
  const normalized = String(text || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) return false;
  for (const root of runtimeProtectedRoots(userId)) {
    if (normalized.includes(root.replace(/\\/g, '/').toLowerCase())) return true;
  }
  return /(?:^|[\/\s"'=])cognition(?:[\/\s"'\\]|$)/i.test(normalized)
    || /(?:^|[\/\s"'=])recall(?:[\/\s"'\\]|$)/i.test(normalized)
    || /cognition-store\.json/i.test(normalized);
}
