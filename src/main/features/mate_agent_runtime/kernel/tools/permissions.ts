import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPathAllowed } from '../../../../util/path-sandbox';

const RUNTIME_TRANSCRIPT_PATH_PATTERN = /(?:^|[\/])(?:cloud[\/](?:projects[\/][^\/]+[\/])?(?:chats|sessions)|local[\/](?:mate_runtime[\/])?sessions)[\/].*\.jsonl$/i;

function realOrResolve(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function normalizeForCheck(candidate: string): string {
  return realOrResolve(candidate).replace(/\\/g, '/');
}

export function isRuntimeTranscriptPath(candidate: string): boolean {
  return RUNTIME_TRANSCRIPT_PATH_PATTERN.test(normalizeForCheck(candidate));
}

export function normalizeRuntimeRoots(roots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (typeof root !== 'string' || !root || !path.isAbsolute(root)) continue;
    const normalized = realOrResolve(root);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function normalizeRuntimePath(candidate: string, allowedRoots: readonly string[]): string {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw Object.assign(new Error('runtime file path must be an absolute path'), { code: 'E_RUNTIME_PATH_DENIED' });
  }
  if (!path.isAbsolute(candidate)) {
    throw Object.assign(new Error('runtime file path must be an absolute path'), { code: 'E_RUNTIME_PATH_DENIED' });
  }

  const resolved = realOrResolve(candidate);
  const roots = normalizeRuntimeRoots(allowedRoots);
  if (!roots.length || !isPathAllowed(resolved, roots)) {
    throw Object.assign(new Error('runtime file path is outside the allowed roots'), { code: 'E_RUNTIME_PATH_DENIED' });
  }
  if (isRuntimeTranscriptPath(resolved)) {
    throw Object.assign(new Error('runtime file path points to a transcript file'), { code: 'E_RUNTIME_TRANSCRIPT_PATH' });
  }
  return resolved;
}

export function ensureRuntimeAllowedRoots(allowedRoots: readonly string[]): string[] {
  const roots = normalizeRuntimeRoots(allowedRoots);
  if (!roots.length) {
    throw Object.assign(new Error('no explicit runtime roots were provided'), { code: 'E_RUNTIME_NO_ROOTS' });
  }
  return roots;
}
