import * as fs from 'node:fs';
import * as path from 'node:path';

interface DirectoryIdentity {
  absolute: string;
  device: number;
  inode: number;
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code || '')
    : '';
}

function fail(label: string, detail: string, cause?: unknown): Error {
  return new Error(`${label}: ${detail}`, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function inspectDirectory(absolute: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (cause) {
    throw fail(label, `cannot inspect ${absolute}`, cause);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fail(label, `symbolic links and non-directory entries are not allowed: ${absolute}`);
  }
  return stat;
}

function assertOwnedDirectory(stat: fs.Stats, absolute: string, label: string): void {
  if (process.platform === 'win32') return;
  const getuid = process.getuid;
  if (typeof getuid === 'function' && stat.uid !== getuid()) {
    throw fail(label, `directory is not owned by the current OS user: ${absolute}`);
  }
  try {
    fs.chmodSync(absolute, 0o700);
  } catch (cause) {
    throw fail(label, `cannot apply private permissions to ${absolute}`, cause);
  }
}

function sameIdentity(expected: DirectoryIdentity, actual: fs.Stats): boolean {
  return actual.dev === expected.device
    && actual.ino === expected.inode
    && actual.isDirectory()
    && !actual.isSymbolicLink();
}

function relativeDescendant(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

/**
 * Create an application-owned private directory without following symlinks
 * below the trusted data root. The complete chain is revalidated before the
 * path is returned so callers never rely on a cached safety decision.
 *
 * This protects against persistent path planting. As with other Node path
 * APIs, it is not a defence against an attacker who can mutate the same
 * directories as this OS user between this return and the caller's next I/O.
 */
export function ensurePrivateDirectoryWithin(
  trustedRoot: string,
  requestedDirectory: string,
  label: string,
): string {
  if (typeof label !== 'string' || !label.trim()) {
    throw new Error('private directory label is required');
  }
  if (typeof trustedRoot !== 'string' || typeof requestedDirectory !== 'string'
      || !path.isAbsolute(trustedRoot) || !path.isAbsolute(requestedDirectory)
      || trustedRoot.includes('\0') || requestedDirectory.includes('\0')) {
    throw fail(label, 'trusted root and requested directory must be absolute paths');
  }

  const lexicalRoot = path.resolve(trustedRoot);
  const lexicalTarget = path.resolve(requestedDirectory);
  const rootStat = inspectDirectory(lexicalRoot, label);
  assertOwnedDirectory(rootStat, lexicalRoot, label);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(lexicalRoot);
  } catch (cause) {
    throw fail(label, 'trusted data root cannot be resolved', cause);
  }
  const relative = relativeDescendant(lexicalRoot, lexicalTarget)
    ?? relativeDescendant(realRoot, lexicalTarget);
  if (relative === null) {
    throw fail(label, 'requested directory is outside the trusted data root');
  }

  const identities: DirectoryIdentity[] = [{
    absolute: realRoot,
    device: rootStat.dev,
    inode: rootStat.ino,
  }];
  let current = realRoot;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') {
      throw fail(label, 'requested directory contains an invalid path segment');
    }
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (cause) {
      if (errorCode(cause) !== 'ENOENT') {
        throw fail(label, `cannot inspect ${current}`, cause);
      }
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirCause) {
        if (errorCode(mkdirCause) !== 'EEXIST') {
          throw fail(label, `cannot create ${current}`, mkdirCause);
        }
      }
      stat = inspectDirectory(current, label);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw fail(label, `symbolic links and non-directory entries are not allowed: ${current}`);
    }
    assertOwnedDirectory(stat, current, label);
    const privateStat = inspectDirectory(current, label);
    identities.push({
      absolute: current,
      device: privateStat.dev,
      inode: privateStat.ino,
    });
  }

  for (const identity of identities) {
    const currentStat = inspectDirectory(identity.absolute, label);
    if (!sameIdentity(identity, currentStat)) {
      throw fail(label, `directory changed while it was being validated: ${identity.absolute}`);
    }
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(current);
  } catch (cause) {
    throw fail(label, 'private directory cannot be resolved', cause);
  }
  if (relativeDescendant(realRoot, realTarget) === null) {
    throw fail(label, 'private directory resolved outside the trusted data root');
  }
  return realTarget;
}
