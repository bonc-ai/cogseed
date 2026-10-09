import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SkillSnapshotFile {
  path: string;
  content: string;
  contentHash: string;
}

export interface SkillTreeSnapshot {
  files: SkillSnapshotFile[];
  manifestHash: string;
}

const MAX_FILES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const IGNORED_NAMES = new Set([
  '.DS_Store', '__MACOSX', '__pycache__', '.git', 'node_modules',
  '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.uv-cache',
  '.tox', '.nox', '.nyc_output', 'htmlcov', 'dist', 'build', 'out', 'target',
  'coverage', '.cache', '.parcel-cache', '.next', '.nuxt', '.turbo', '.npm',
  '.pnpm-store', '.yarn', '.vite', '.svelte-kit', 'tmp', 'temp', '.tmp',
  'logs', 'log', '_install.json', '_cache.json', '_resource_manifest.json',
  '_marketplace.json', '_meta.json',
]);

function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeSkillSnapshotPath(value: string): string {
  const input = String(value || '').trim();
  const raw = input.replace(/\\/g, '/');
  if (
    !raw
    || raw.startsWith('/')
    || raw.startsWith('//')
    || path.posix.isAbsolute(raw)
    || path.win32.isAbsolute(input)
    || /^[A-Za-z]:/.test(raw)
  ) throw new Error('invalid skill snapshot path');
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('invalid skill snapshot path');
  }
  if (parts.some((part) => part.startsWith('.') || IGNORED_NAMES.has(part))) {
    throw new Error('ignored skill snapshot path');
  }
  return parts.join('/');
}

export function skillSnapshotContentHash(content: string): string {
  return hashText(content);
}

export function normalizeSkillSnapshotFiles(
  input: ReadonlyArray<{ path: string; content: string; contentHash?: string }>,
): SkillSnapshotFile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FILES) {
    throw new Error('invalid skill snapshot file count');
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = input.map((item) => {
    const rel = normalizeSkillSnapshotPath(item.path);
    if (seen.has(rel)) throw new Error(`duplicate skill snapshot path: ${rel}`);
    seen.add(rel);
    if (typeof item.content !== 'string' || item.content.includes('\0')) {
      throw new Error(`invalid skill snapshot content: ${rel}`);
    }
    const bytes = Buffer.byteLength(item.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`skill snapshot file too large: ${rel}`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('skill snapshot tree too large');
    const contentHash = hashText(item.content);
    if (item.contentHash !== undefined && item.contentHash !== contentHash) {
      throw new Error(`skill snapshot content hash mismatch: ${rel}`);
    }
    return { path: rel, content: item.content, contentHash };
  }).sort((a, b) => codepointCompare(a.path, b.path));
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('skill snapshot is missing SKILL.md');
  }
  return files;
}

export function skillSnapshotManifestHash(files: ReadonlyArray<SkillSnapshotFile>): string {
  const normalized = normalizeSkillSnapshotFiles(files);
  const hash = createHash('sha256');
  hash.update('cogseed-skill-snapshot-v2\0');
  for (const file of normalized) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.contentHash);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function snapshotSkillFiles(
  files: ReadonlyArray<{ path: string; content: string; contentHash?: string }>,
): SkillTreeSnapshot {
  const normalized = normalizeSkillSnapshotFiles(files);
  return { files: normalized, manifestHash: skillSnapshotManifestHash(normalized) };
}

function ignoredEntry(name: string): boolean {
  return name.startsWith('.')
    || IGNORED_NAMES.has(name)
    || /\.(pyc|pyo|log|tmp|temp|tsbuildinfo)$/.test(name)
    || name.includes('.bak-');
}

export async function captureSkillTree(skillDir: string): Promise<SkillTreeSnapshot> {
  const root = path.resolve(skillDir);
  const files: Array<{ path: string; content: string }> = [];
  const walk = async (dir: string, relBase = ''): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .sort((a, b) => codepointCompare(a.name, b.name));
    for (const entry of entries) {
      if (ignoredEntry(entry.name)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`skill snapshot symlink is not allowed: ${rel}`);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const buffer = await fs.readFile(abs);
        if (buffer.includes(0)) throw new Error(`binary skill snapshot file is not supported: ${rel}`);
        files.push({ path: rel, content: buffer.toString('utf8') });
      }
    }
  };
  await walk(root);
  return snapshotSkillFiles(files);
}

export async function materializeSkillTree(
  targetDir: string,
  files: ReadonlyArray<SkillSnapshotFile>,
): Promise<SkillTreeSnapshot> {
  const snapshot = snapshotSkillFiles(files);
  const root = path.resolve(targetDir);
  await fs.mkdir(root, { recursive: true });
  for (const file of snapshot.files) {
    const target = path.resolve(root, file.path);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('invalid skill materialization path');
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
  }
  return snapshot;
}
