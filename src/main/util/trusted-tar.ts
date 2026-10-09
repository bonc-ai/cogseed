import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extract, list, type ReadEntry } from 'tar';

const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 1_024;
const MAX_ARCHIVE_DEPTH = 64;
const MAX_META_ENTRY_BYTES = 1024 * 1024;
const MAX_DECOMPRESSION_RATIO = 100;

type TrustedTarEntryKind = 'directory' | 'file' | 'symlink';

export interface TrustedTarEntry {
  readonly path: string;
  readonly kind: TrustedTarEntryKind;
  readonly bytes: number;
  readonly sha256?: string;
  readonly linkPath?: string;
  readonly executable: boolean;
}

export interface TrustedTarTree {
  readonly entries: readonly TrustedTarEntry[];
}

function error(message: string): Error {
  return new Error(`Unsafe trusted runtime archive: ${message}`);
}

function canonicalArchivePath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0') || rawPath.includes('\\') || path.posix.isAbsolute(rawPath)) {
    throw error(`invalid entry path ${JSON.stringify(rawPath)}`);
  }
  if (Buffer.byteLength(rawPath, 'utf8') > MAX_ARCHIVE_PATH_BYTES || rawPath !== rawPath.normalize('NFC')) {
    throw error(`non-portable entry path ${JSON.stringify(rawPath)}`);
  }
  const withoutTrailingSlashes = rawPath.replace(/\/+$/u, '');
  const segments = withoutTrailingSlashes.split('/');
  if (!withoutTrailingSlashes || segments.length > MAX_ARCHIVE_DEPTH
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw error(`invalid entry path ${JSON.stringify(rawPath)}`);
  }
  const normalized = path.posix.normalize(withoutTrailingSlashes);
  if (normalized !== withoutTrailingSlashes || normalized === '..' || normalized.startsWith('../')) {
    throw error(`escaping entry path ${JSON.stringify(rawPath)}`);
  }
  return normalized;
}

function resolvedArchiveLink(entryPath: string, rawLinkPath: string): string {
  if (!rawLinkPath || rawLinkPath.includes('\0') || rawLinkPath.includes('\\')
      || path.posix.isAbsolute(rawLinkPath) || rawLinkPath !== rawLinkPath.normalize('NFC')
      || Buffer.byteLength(rawLinkPath, 'utf8') > MAX_ARCHIVE_PATH_BYTES
      || /[\u0000-\u001f\u007f]/u.test(rawLinkPath)) {
    throw error(`invalid symlink target for ${entryPath}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), rawLinkPath));
  if (!resolved || resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw error(`symlink escapes extraction root: ${entryPath} -> ${rawLinkPath}`);
  }
  return resolved;
}

function entryKind(entry: ReadEntry): TrustedTarEntryKind {
  if (entry.type === 'Directory') return 'directory';
  if (entry.type === 'File' || entry.type === 'OldFile') return 'file';
  if (entry.type === 'SymbolicLink') return 'symlink';
  throw error(`unsupported entry type ${entry.type} for ${entry.path}`);
}

function expectedDirectories(entries: readonly TrustedTarEntry[]): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'directory') directories.add(entry.path);
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return directories;
}

function assertNoSymlinkCyclesOrMissingTargets(entries: readonly TrustedTarEntry[]): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const directories = expectedDirectories(entries);
  for (const entry of entries) {
    if (entry.kind !== 'symlink' || !entry.linkPath) continue;
    const visited = new Set<string>([entry.path]);
    let target = resolvedArchiveLink(entry.path, entry.linkPath);
    while (true) {
      if (visited.has(target)) throw error(`symlink cycle at ${entry.path}`);
      visited.add(target);
      const targetEntry = byPath.get(target);
      if (!targetEntry) {
        if (!directories.has(target)) throw error(`dangling symlink ${entry.path} -> ${entry.linkPath}`);
        break;
      }
      if (targetEntry.kind !== 'symlink' || !targetEntry.linkPath) break;
      target = resolvedArchiveLink(targetEntry.path, targetEntry.linkPath);
    }
  }

  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') {
      const parentEntry = byPath.get(parent);
      if (parentEntry && parentEntry.kind !== 'directory') {
        throw error(`entry traverses non-directory archive entry: ${entry.path}`);
      }
      parent = path.posix.dirname(parent);
    }
  }
}

function inspectTarGzip(archive: string): TrustedTarTree {
  const entries: TrustedTarEntry[] = [];
  const exactPaths = new Set<string>();
  const portablePaths = new Map<string, string>();
  let totalBytes = 0;

  list({
    file: archive,
    sync: true,
    strict: true,
    gzip: true,
    maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
    maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    onReadEntry(readEntry) {
      if (readEntry.invalid || readEntry.unsupported) {
        throw error(`invalid entry ${readEntry.path}`);
      }
      const archivePath = canonicalArchivePath(readEntry.path);
      const kind = entryKind(readEntry);
      if (exactPaths.has(archivePath)) throw error(`duplicate entry path ${archivePath}`);
      exactPaths.add(archivePath);
      const portableKey = archivePath.toLocaleLowerCase('en-US');
      const collision = portablePaths.get(portableKey);
      if (collision && collision !== archivePath) {
        throw error(`case-colliding entry paths ${collision} and ${archivePath}`);
      }
      portablePaths.set(portableKey, archivePath);
      if (entries.length >= MAX_ARCHIVE_ENTRIES) throw error('entry count limit exceeded');
      if (!Number.isSafeInteger(readEntry.size) || readEntry.size < 0
          || readEntry.size > MAX_ARCHIVE_FILE_BYTES
          || (kind !== 'file' && readEntry.size !== 0)) {
        throw error(`invalid entry size for ${archivePath}`);
      }
      totalBytes += readEntry.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
        throw error('expanded byte limit exceeded');
      }

      const mutable: {
        path: string;
        kind: TrustedTarEntryKind;
        bytes: number;
        sha256?: string;
        linkPath?: string;
        executable: boolean;
      } = {
        path: archivePath,
        kind,
        bytes: readEntry.size,
        executable: kind === 'file' && ((readEntry.mode || 0) & 0o111) !== 0,
      };
      if (kind === 'symlink') {
        mutable.linkPath = readEntry.linkpath;
        resolvedArchiveLink(archivePath, readEntry.linkpath || '');
      } else if (kind === 'file') {
        const hash = crypto.createHash('sha256');
        let bytesRead = 0;
        readEntry.on('data', (chunk: Buffer) => {
          bytesRead += chunk.length;
          hash.update(chunk);
        });
        readEntry.on('end', () => {
          if (bytesRead !== readEntry.size) throw error(`truncated entry ${archivePath}`);
          mutable.sha256 = hash.digest('hex');
        });
      }
      entries.push(mutable);
    },
  });

  if (!entries.length) throw error('archive is empty');
  for (const entry of entries) {
    if (entry.kind === 'file' && !entry.sha256) throw error(`entry digest unavailable for ${entry.path}`);
  }
  assertNoSymlinkCyclesOrMissingTargets(entries);
  return Object.freeze({ entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))) });
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function assertTrustedTarTree(
  destination: string,
  tree: TrustedTarTree,
  options: Readonly<{ verifyContent?: boolean }> = {},
): void {
  const rootStat = fs.lstatSync(destination);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw error('extraction root is not a direct directory');
  const realRoot = fs.realpathSync(destination);
  const expectedEntries = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const directories = expectedDirectories(tree.entries);
  const seen = new Set<string>();

  const visit = (directory: string): void => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, dirent.name);
      const relative = path.relative(destination, absolute).split(path.sep).join('/');
      const expected = expectedEntries.get(relative);
      seen.add(relative);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        if (!expected || expected.kind !== 'symlink' || fs.readlinkSync(absolute) !== expected.linkPath) {
          throw error(`unexpected symlink ${relative}`);
        }
        let realTarget: string;
        try { realTarget = fs.realpathSync(absolute); }
        catch (cause) { throw new Error(`Unsafe trusted runtime archive: broken symlink ${relative}`, { cause }); }
        if (!isInside(realTarget, realRoot)) throw error(`extracted symlink escapes root: ${relative}`);
      } else if (stat.isDirectory()) {
        if (expected?.kind !== 'directory' && !directories.has(relative)) {
          throw error(`unexpected directory ${relative}`);
        }
        visit(absolute);
      } else if (stat.isFile()) {
        if (!expected || expected.kind !== 'file' || stat.size !== expected.bytes) {
          throw error(`unexpected or modified file ${relative}`);
        }
        if (options.verifyContent) {
          const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
          if (digest !== expected.sha256) throw error(`file digest mismatch ${relative}`);
        }
      } else {
        throw error(`special filesystem entry ${relative}`);
      }
    }
  };
  visit(destination);

  const expectedPaths = new Set([...expectedEntries.keys(), ...directories]);
  if (seen.size !== expectedPaths.size || [...expectedPaths].some((entryPath) => !seen.has(entryPath))) {
    throw error('extracted tree is incomplete');
  }
}

export function extractTrustedTarGzip(archive: string, destination: string): TrustedTarTree {
  const destinationStat = fs.lstatSync(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()
      || fs.readdirSync(destination).length !== 0) {
    throw error('destination must be an empty direct directory');
  }
  const tree = inspectTarGzip(archive);
  const expectedEntries = new Map(tree.entries.map((entry) => [entry.path, entry]));

  extract({
    file: archive,
    cwd: destination,
    sync: true,
    strict: true,
    gzip: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    unlink: true,
    processUmask: 0o077,
    maxDepth: MAX_ARCHIVE_DEPTH,
    maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
    maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    filter(rawPath, rawEntry) {
      const readEntry = rawEntry as ReadEntry;
      const archivePath = canonicalArchivePath(rawPath);
      const expected = expectedEntries.get(archivePath);
      const kind = entryKind(readEntry);
      if (!expected || expected.kind !== kind || expected.bytes !== readEntry.size
          || (kind === 'symlink' && expected.linkPath !== readEntry.linkpath)) {
        throw error(`archive changed between inspection and extraction: ${archivePath}`);
      }
      readEntry.mode = kind === 'directory' ? 0o700 : expected.executable ? 0o700 : 0o600;
      return true;
    },
  });
  assertTrustedTarTree(destination, tree, { verifyContent: true });
  return tree;
}
