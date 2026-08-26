/**
 * Space-scoped files.
 *
 * Storage: `<uid>/cloud/spaces/<sid>/contexts/<relative/path>`.
 * These files belong to the space, not a single conversation, so every
 * conversation inside the space receives a lightweight file-list prompt and
 * file tools get read-only access to this directory.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Semaphore } from 'async-mutex';

import { spaceFilesDir } from '../paths';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { invalidateFileCache } from './file_indexer';
import { spaceExists } from './spaces';
import * as spaceLibraryIndexer from './project_library_indexer';
import { officeBufferToPreviewHtml, officePreviewKindForExt } from '../util/office-preview';
import {
  assertLocalImportTarget,
  copyLocalFileAtomic,
  inspectLocalImportSource,
  withLocalImportLock,
} from '../util/file-import';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';

const log = createLogger('space_files');

const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]);
const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const PDF_EXT = '.pdf';
const DOCX_EXTS: ReadonlySet<string> = new Set(['.docx', '.docm']);
const SPREADSHEET_EXTS: ReadonlySet<string> = new Set(['.xlsx', '.xlsm']);
const PRESENTATION_EXTS: ReadonlySet<string> = new Set(['.pptx', '.pptm']);
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_EXTS,
  PDF_EXT, ...DOCX_EXTS, ...SPREADSHEET_EXTS, ...PRESENTATION_EXTS,
  ...IMAGE_EXTS, ...VIDEO_EXTS,
]);
const IMAGE_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const MAX_BYTES_TEXT = 5 * 1024 * 1024;
const MAX_BYTES_DOCX = 20 * 1024 * 1024;
const MAX_BYTES_OFFICE = 50 * 1024 * 1024;
const MAX_BYTES_IMAGE = 20 * 1024 * 1024;
const MAX_BYTES_PDF = 100 * 1024 * 1024;
const MAX_BYTES_VIDEO = 200 * 1024 * 1024;
const MAX_FILENAME_LEN = 200;
/** 文件树「变更才扫」兜底窗口：指纹一致但缓存超过该时长仍重扫一次，
 *  覆盖指纹感知不到的深层外部改动（如 Finder 往深层子目录放文件）。 */
const SPACE_TREE_BACKSTOP_MS = 3 * 60_000;
/** 遍历深度上限：保护极端目录树（导入的历史项目等）不触发超深递归。 */
const SPACE_TREE_MAX_DEPTH = 24;

export type SpaceFileKind = 'text' | 'pdf' | 'docx' | 'spreadsheet' | 'presentation' | 'image' | 'video';

export interface SpaceFileInfo {
  name: string;
  relPath: string;
  type: 'file';
  path: string;
  bytes: number;
  kind: SpaceFileKind;
  mtime: number;
}

export interface SpaceDirInfo {
  name: string;
  relPath: string;
  type: 'dir';
  path: string;
  mtime: number;
  children: SpaceLibraryNode[];
}

export type SpaceLibraryNode = SpaceFileInfo | SpaceDirInfo;

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

function safeSpaceId(spaceId: unknown): string {
  if (typeof spaceId !== 'string' || !spaceId) throw new Error('spaceId required');
  if (spaceId.includes('/') || spaceId.includes('\\') || spaceId.includes('\x00') || spaceId === '.' || spaceId === '..') {
    throw new Error('invalid spaceId');
  }
  return spaceId;
}

function normaliseSpaceRelPath(input: unknown, kind: 'file' | 'dir', allowEmpty = false): string {
  if (typeof input !== 'string') throw new Error(kind === 'file' ? 'filename required' : 'folder required');
  const raw = input.trim().replace(/\\/g, '/');
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error(kind === 'file' ? 'invalid filename' : 'invalid folder');
  }
  if (raw.includes('\x00') || raw.startsWith('/') || path.isAbsolute(raw)) {
    throw new Error(kind === 'file' ? 'invalid filename' : 'invalid folder');
  }
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(kind === 'file' ? 'invalid filename' : 'invalid folder');
  }
  if (parts.some((part) => part.length > MAX_FILENAME_LEN)) {
    throw new Error(kind === 'file' ? 'filename too long' : 'folder name too long');
  }
  const rel = parts.join('/');
  if (kind === 'dir') return rel;
  const base = parts[parts.length - 1] || '';
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(t('errors.unsupported_file_ext', { ext: ext || t('errors.unsupported_file_no_ext') }));
  }
  return rel;
}

function safeFileName(name: unknown): string {
  return normaliseSpaceRelPath(name, 'file');
}

function safeDirPath(name: unknown, allowEmpty = false): string {
  return normaliseSpaceRelPath(name, 'dir', allowEmpty);
}

function relPathFor(root: string, absPath: string): string {
  return path.relative(path.resolve(root), path.resolve(absPath)).split(path.sep).join('/');
}

function resolveUnder(root: string, relPath: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, relPath);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
  return abs;
}

function kindOfName(name: string): SpaceFileKind {
  const ext = path.extname(name).toLowerCase();
  if (ext === PDF_EXT) return 'pdf';
  if (DOCX_EXTS.has(ext)) return 'docx';
  if (SPREADSHEET_EXTS.has(ext)) return 'spreadsheet';
  if (PRESENTATION_EXTS.has(ext)) return 'presentation';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'text';
}

function maxBytesFor(name: string): number {
  const ext = path.extname(name).toLowerCase();
  if (ext === PDF_EXT) return MAX_BYTES_PDF;
  if (DOCX_EXTS.has(ext)) return MAX_BYTES_DOCX;
  if (SPREADSHEET_EXTS.has(ext) || PRESENTATION_EXTS.has(ext)) return MAX_BYTES_OFFICE;
  if (IMAGE_EXTS.has(ext)) return MAX_BYTES_IMAGE;
  if (VIDEO_EXTS.has(ext)) return MAX_BYTES_VIDEO;
  return MAX_BYTES_TEXT;
}

function uniqueTarget(dir: string, name: string): string {
  const original = path.join(dir, name);
  if (!fs.existsSync(original)) return original;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? stamp : `${stamp}-${i}`;
    const target = path.join(dir, `${stem}-${suffix}${ext}`);
    if (!fs.existsSync(target)) return target;
  }
  return path.join(dir, `${stem}-${stamp}-${Date.now()}${ext}`);
}

async function ensureSpaceFilesDir(userId: string, spaceId: string): Promise<string> {
  const sid = safeSpaceId(spaceId);
  if (!await spaceExists(userId, sid)) throw new Error('not_found');
  const dir = spaceFilesDir(userId, sid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _notifyDirty(userId: string, spaceId: string): void {
  invalidateSpaceFileTree(userId, spaceId);
}

function _notifyDeleted(spaceId: string, relPath: string): void {
  void spaceId;
  void relPath;
}

function infoFor(absPath: string, root?: string): SpaceFileInfo | null {
  let st: fs.Stats;
  try { st = fs.statSync(absPath); }
  catch { return null; }
  if (!st.isFile()) return null;
  const name = path.basename(absPath);
  const relPath = root ? relPathFor(root, absPath) : name;
  return {
    name,
    relPath,
    type: 'file',
    path: absPath,
    bytes: st.size,
    kind: kindOfName(name),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function sortDirents(items: fs.Dirent[]): fs.Dirent[] {
  return items.slice().sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { numeric: true });
  });
}

// Project trees can contain hundreds of files. User-facing list/tree IPC must
// never run a recursive synchronous stat walk on Electron's main event loop.
// Limit individual filesystem operations globally while allowing independent
// branches to make progress.
const _spaceTreeIo = new Semaphore(8);

async function _treeReadDir(absDir: string): Promise<fs.Dirent[]> {
  try {
    return await _spaceTreeIo.runExclusive(() => fsp.readdir(absDir, { withFileTypes: true }));
  } catch {
    return [];
  }
}

async function _treeStat(absPath: string): Promise<fs.Stats | null> {
  try { return await _spaceTreeIo.runExclusive(() => fsp.stat(absPath)); }
  catch { return null; }
}

async function walkSpaceTreeAsync(absDir: string, root: string, depth = 0): Promise<SpaceLibraryNode[]> {
  if (depth > SPACE_TREE_MAX_DEPTH) return [];
  const items = sortDirents(await _treeReadDir(absDir));
  const nodes = await Promise.all(items.map(async (entry): Promise<SpaceLibraryNode | null> => {
    if (entry.name.startsWith('.')) return null;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      // 与产物兜底遍历同口径：依赖/缓存目录不进空间文件树（导入整包项目时
      // 这些目录能把树撑到几万节点，且用户从不浏览）。
      if (entry.name === 'node_modules' || entry.name === '__pycache__') return null;
      const [children, st] = await Promise.all([
        walkSpaceTreeAsync(abs, root, depth + 1),
        _treeStat(abs),
      ]);
      if (!st?.isDirectory()) return null;
      return {
        name: entry.name,
        relPath: relPathFor(root, abs),
        type: 'dir',
        path: abs,
        mtime: Math.floor(st.mtimeMs / 1000),
        children,
      };
    }
    if (!entry.isFile()) return null;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return null;
    const st = await _treeStat(abs);
    if (!st?.isFile()) return null;
    return {
      name: entry.name,
      relPath: relPathFor(root, abs),
      type: 'file',
      path: abs,
      bytes: st.size,
      kind: kindOfName(entry.name),
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  }));
  return nodes.filter((node): node is SpaceLibraryNode => node !== null);
}

function flattenFiles(nodes: SpaceLibraryNode[]): SpaceFileInfo[] {
  const out: SpaceFileInfo[] = [];
  for (const node of nodes) {
    if (node.type === 'file') out.push(node);
    else out.push(...flattenFiles(node.children || []));
  }
  return out;
}

async function filesUnderEntry(absPath: string, root: string): Promise<SpaceFileInfo[]> {
  const st = await _treeStat(absPath);
  if (!st) return [];
  if (st.isFile()) {
    const info = infoFor(absPath, root);
    return info ? [info] : [];
  }
  if (st.isDirectory()) return flattenFiles(await walkSpaceTreeAsync(absPath, root));
  return [];
}

interface SpaceTreeCacheEntry {
  generation: number;
  /** 空间文件根目录指纹（mtime:size）——外部直接改动根目录内容时立即失效。 */
  stamp: string;
  expiresAt: number;
  tree: SpaceLibraryNode[];
}

const _spaceTreeCache = new Map<string, SpaceTreeCacheEntry>();
const _spaceTreeInFlight = new Map<string, Promise<SpaceLibraryNode[]>>();
const _spaceTreeGeneration = new Map<string, number>();

function _spaceTreeKey(userId: string, spaceId: string): string {
  return `${userId}\x00${spaceId}`;
}

/** Invalidate one project's derived tree after a supported write, or every
 * tree for a user after a project-domain sync pull. The TTL is a correctness
 * fallback for direct filesystem edits that bypass both paths. */
export function invalidateSpaceFileTree(userId: string, spaceId?: string): void {
  const prefix = `${userId}\x00`;
  const keys = spaceId
    ? [_spaceTreeKey(userId, spaceId)]
    : Array.from(new Set([
      ..._spaceTreeCache.keys(),
      ..._spaceTreeInFlight.keys(),
      ..._spaceTreeGeneration.keys(),
    ])).filter((key) => key.startsWith(prefix));
  for (const key of keys) {
    _spaceTreeCache.delete(key);
    _spaceTreeInFlight.delete(key);
    _spaceTreeGeneration.set(key, (_spaceTreeGeneration.get(key) || 0) + 1);
  }
  // 持久化表同源失效（fire-and-forget；表是派生缓存，失败无害）
  void import('./workspace_meta').then((m) => {
    if (spaceId) return m.dropEntry(userId, 'fileTrees', spaceId);
    return m.dropSection(userId, 'fileTrees');
  }).catch(() => { /* best-effort */ });
}

async function _spaceFilesRootStamp(dir: string): Promise<string> {
  try {
    const st = await _treeStat(dir);
    return st ? `${st.mtimeMs}:${st.size}` : 'missing';
  } catch {
    return 'missing';
  }
}

export async function listSpaceFileTree(userId: string, spaceId: string): Promise<SpaceLibraryNode[]> {
  const startedAt = Date.now();
  let dir: string;
  let sid: string;
  try {
    sid = safeSpaceId(spaceId);
    if (!await spaceExists(userId, sid)) return [];
    dir = spaceFilesDir(userId, sid);
  } catch { return []; }
  const key = _spaceTreeKey(userId, sid);
  const generation = _spaceTreeGeneration.get(key) || 0;
  const cached = _spaceTreeCache.get(key);
  if (cached && cached.generation === generation) {
    // 「变更才扫」：根目录指纹一致且未过兜底窗口 → 直接返回缓存。
    const stamp = await _spaceFilesRootStamp(dir);
    if (cached.stamp === stamp && cached.expiresAt > Date.now()) {
      // 性能埋点：缓存命中路径（诊断用，仅计数/时长）。
      log.info('listSpaceFileTree cache hit', { nodes: cached.tree.length, ms: Date.now() - startedAt });
      return cached.tree;
    }
  }
  // 持久化元数据表：重启后冷启动直接查表（根目录指纹验证），不再全量递归。
  const meta = await import('./workspace_meta');
  const tableStamp = await _spaceFilesRootStamp(dir);
  const tableEntry = await meta.getEntry<SpaceLibraryNode[]>(userId, 'fileTrees', sid);
  if (tableEntry && tableEntry.stamp === tableStamp) {
    _spaceTreeCache.set(key, {
      generation,
      stamp: tableStamp,
      expiresAt: Date.now() + SPACE_TREE_BACKSTOP_MS,
      tree: tableEntry.data,
    });
    log.info('listSpaceFileTree table hit', { nodes: tableEntry.data.length, ms: Date.now() - startedAt });
    return tableEntry.data;
  }
  const existing = _spaceTreeInFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    const tree = await walkSpaceTreeAsync(dir, dir);
    if ((_spaceTreeGeneration.get(key) || 0) === generation) {
      const stamp = await _spaceFilesRootStamp(dir);
      _spaceTreeCache.set(key, {
        generation,
        stamp,
        expiresAt: Date.now() + SPACE_TREE_BACKSTOP_MS,
        tree,
      });
    }
    try {
      await meta.putEntry(userId, 'fileTrees', sid, await _spaceFilesRootStamp(dir), tree);
    } catch { /* 表写入失败不阻断 */ }
    log.info('listSpaceFileTree scanned', { nodes: tree.length, ms: Date.now() - startedAt });
    return tree;
  })();
  _spaceTreeInFlight.set(key, run);
  try { return await run; }
  finally {
    if (_spaceTreeInFlight.get(key) === run) _spaceTreeInFlight.delete(key);
  }
}

export async function listSpaceFiles(userId: string, spaceId: string): Promise<SpaceFileInfo[]> {
  return flattenFiles(await listSpaceFileTree(userId, spaceId));
}

export async function uploadSpaceFile(
  userId: string,
  spaceId: string,
  name: string,
  raw: Buffer | Uint8Array | null | undefined,
): Promise<Result<{ info: SpaceFileInfo }>> {
  let safeName: string;
  let sid: string;
  let dir: string;
  try {
    safeName = safeFileName(name);
    sid = safeSpaceId(spaceId);
    dir = await ensureSpaceFilesDir(userId, sid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
  const cap = maxBytesFor(safeName);
  if (buf.length > cap) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(cap / 1024 / 1024) }) };
  }
  if (TEXT_EXTS.has(path.extname(safeName).toLowerCase())) {
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').length !== buf.length) {
      return { ok: false, error: t('errors.not_utf8') };
    }
  }

  const parent = path.dirname(safeName);
  const targetDir = parent === '.' ? dir : resolveUnder(dir, parent);
  try { fs.mkdirSync(targetDir, { recursive: true }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const target = uniqueTarget(targetDir, path.basename(safeName));
  try { fs.writeFileSync(target, buf); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  const info = infoFor(target, dir);
  if (!info) return { ok: false, error: 'write failed' };
  spaceLibraryIndexer.enqueue(userId, sid, info.relPath, 'upsert');
  _notifyDirty(userId, sid);
  log.info(`upload user=${userId} sid=${sid} name=${info.relPath} kind=${info.kind} bytes=${info.bytes}`);
  return { ok: true, info };
}

/** Import a user-selected local file via async filesystem copy, not base64 IPC. */
export async function importSpaceFileFromPath(
  userId: string,
  spaceId: string,
  name: string,
  sourceAbs: string,
): Promise<Result<{ info: SpaceFileInfo }>> {
  const startedAt = Date.now();
  let safeName: string;
  let sid: string;
  let dir: string;
  try {
    safeName = safeFileName(name);
    sid = safeSpaceId(spaceId);
    dir = await ensureSpaceFilesDir(userId, sid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  try {
    const source = await inspectLocalImportSource(sourceAbs, maxBytesFor(safeName));
    if (TEXT_EXTS.has(path.extname(safeName).toLowerCase())) {
      // Text caps are small; validate UTF-8 without bringing large Office/PDF
      // payloads back into the main-process heap.
      const text = await fsp.readFile(sourceAbs, 'utf8');
      if (Buffer.byteLength(text, 'utf8') !== source.bytes) {
        return { ok: false, error: t('errors.not_utf8') };
      }
    }
    const info = await withLocalImportLock(`space:${userId}:${sid}`, async () => {
      const parent = path.dirname(safeName);
      const targetDir = parent === '.' ? dir : resolveUnder(dir, parent);
      const target = uniqueTarget(targetDir, path.basename(safeName));
      await assertLocalImportTarget(dir, target);
      await fsp.mkdir(targetDir, { recursive: true });
      await copyLocalFileAtomic(source.absPath, target, source);
      const imported = infoFor(target, dir);
      if (!imported) throw Object.assign(new Error('write failed'), { code: 'E_IMPORT_PUBLISH' });
      spaceLibraryIndexer.enqueue(userId, sid, imported.relPath, 'upsert');
      _notifyDirty(userId, sid);
      return imported;
    });
    log.info('imported local project library file', {
      user_id: maskId(userId),
      space_id: maskId(sid),
      path: logPathRef(info.relPath),
      kind: info.kind,
      bytes: info.bytes,
      duration_ms: Date.now() - startedAt,
    });
    return { ok: true, info };
  } catch (err) {
    log.warn('local project library file import failed', {
      user_id: maskId(userId),
      space_id: maskId(sid),
      path: logPathRef(safeName),
      duration_ms: Date.now() - startedAt,
      error: logErrorSummary(err),
    });
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

export async function createSpaceDir(
  userId: string,
  spaceId: string,
  relPath: string,
): Promise<Result<{ path: string }>> {
  let safePath: string;
  let sid: string;
  let root: string;
  try {
    safePath = safeDirPath(relPath);
    sid = safeSpaceId(spaceId);
    root = await ensureSpaceFilesDir(userId, sid);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  let abs: string;
  try { abs = resolveUnder(root, safePath); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (fs.existsSync(abs)) {
    try {
      if (fs.statSync(abs).isDirectory()) return { ok: true, path: safePath };
      return { ok: false, error: 'target_exists' };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  }
  try { fs.mkdirSync(abs, { recursive: false }); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  _notifyDirty(userId, sid);
  return { ok: true, path: safePath };
}

export async function deleteSpaceFile(userId: string, spaceId: string, name: string): Promise<Result> {
  let safeName: string;
  let sid: string;
  try {
    safeName = safeFileName(name);
    sid = safeSpaceId(spaceId);
    if (!await spaceExists(userId, sid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const dir = spaceFilesDir(userId, sid);
  let abs: string;
  try { abs = resolveUnder(dir, safeName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
  try {
    if (!fs.statSync(abs).isFile()) return { ok: false, error: 'not_found' };
  } catch { return { ok: false, error: 'not_found' }; }
  try { fs.unlinkSync(abs); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  spaceLibraryIndexer.enqueue(userId, sid, safeName, 'delete');
  _notifyDeleted(sid, safeName);
  try { invalidateFileCache(userId, abs); }
  catch (err) { log.warn(`invalidate cache ${abs}: ${(err as Error).message}`); }
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
  _notifyDirty(userId, sid);
  return { ok: true };
}

export async function deleteSpaceEntry(userId: string, spaceId: string, name: string): Promise<Result> {
  let safeName: string;
  let sid: string;
  try {
    safeName = safeDirPath(name);
    sid = safeSpaceId(spaceId);
    if (!await spaceExists(userId, sid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const root = path.resolve(spaceFilesDir(userId, sid));
  let abs: string;
  try { abs = resolveUnder(root, safeName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile() && !st.isDirectory()) return { ok: false, error: 'not_found' };

  const files = await filesUnderEntry(abs, root);
  try {
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: false });
    else fs.unlinkSync(abs);
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  for (const file of files) {
    spaceLibraryIndexer.enqueue(userId, sid, file.relPath, 'delete');
    _notifyDeleted(sid, file.relPath);
    try { invalidateFileCache(userId, file.path); }
    catch (err) { log.warn(`invalidate cache ${file.path}: ${(err as Error).message}`); }
  }
  _notifyDirty(userId, sid);
  return { ok: true };
}

export async function createSpaceTextFile(
  userId: string,
  spaceId: string,
  name: string,
): Promise<Result<{ info: SpaceFileInfo }>> {
  let safeName: string;
  try {
    safeName = safeFileName(name);
    if (!TEXT_EXTS.has(path.extname(safeName).toLowerCase())) {
      return { ok: false, error: 'not a text file' };
    }
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  return uploadSpaceFile(userId, spaceId, safeName, Buffer.from('', 'utf8'));
}

export async function resolveSpaceFileAbsPath(
  userId: string,
  spaceId: string,
  name: string,
): Promise<Result<{ absPath: string; kind: SpaceFileKind }>> {
  let safeName: string;
  let sid: string;
  try {
    safeName = safeFileName(name);
    sid = safeSpaceId(spaceId);
    if (!await spaceExists(userId, sid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  const root = path.resolve(spaceFilesDir(userId, sid));
  let abs: string;
  try { abs = resolveUnder(root, safeName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile()) return { ok: false, error: 'not_found' };
  return { ok: true, absPath: abs, kind: kindOfName(safeName) };
}

/** Resolve a project Library file or folder for internal transfer workflows. */
export async function resolveSpaceEntryAbsPath(
  userId: string,
  spaceId: string,
  name: string,
): Promise<Result<{ absPath: string; type: 'file' | 'dir' }>> {
  let safeName: string;
  let sid: string;
  try {
    safeName = safeDirPath(name);
    sid = safeSpaceId(spaceId);
    if (!await spaceExists(userId, sid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  const root = path.resolve(spaceFilesDir(userId, sid));
  let absPath: string;
  try { absPath = resolveUnder(root, safeName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  let st: fs.Stats;
  try { st = fs.lstatSync(absPath); }
  catch { return { ok: false, error: 'not_found' }; }
  if (st.isSymbolicLink()) return { ok: false, error: 'symlink_not_supported' };
  if (st.isFile()) return { ok: true, absPath, type: 'file' };
  if (st.isDirectory()) return { ok: true, absPath, type: 'dir' };
  return { ok: false, error: 'not_found' };
}

function validateSpaceCopySource(sourceAbs: string): Result<{ fileCount: number; bytes: number }> {
  const stack = [sourceAbs];
  let fileCount = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    let st: fs.Stats;
    try { st = fs.lstatSync(current); }
    catch { return { ok: false, error: 'not_found' }; }
    if (st.isSymbolicLink()) return { ok: false, error: 'symlink_not_supported' };
    if (st.isDirectory()) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch { return { ok: false, error: 'read_failed' }; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) return { ok: false, error: 'unsupported_destination' };
        stack.push(path.join(current, entry.name));
      }
      continue;
    }
    if (!st.isFile()) return { ok: false, error: 'unsupported_destination' };
    const ext = path.extname(current).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || st.size > maxBytesFor(current)) {
      return { ok: false, error: 'unsupported_destination' };
    }
    fileCount += 1;
    bytes += st.size;
  }
  return { ok: true, fileCount, bytes };
}

/** Copy a trusted internal entry into a project Library and refresh the
 * project tree/index state. Existing targets are never overwritten. */
export async function copySpaceEntryFromPath(
  userId: string,
  spaceId: string,
  sourceAbs: string,
  targetName: string,
): Promise<Result<{ name: string; fileCount: number; bytes: number }>> {
  let sid: string;
  let root: string;
  let sourceStat: fs.Stats;
  try {
    sid = safeSpaceId(spaceId);
    root = await ensureSpaceFilesDir(userId, sid);
    sourceStat = fs.lstatSync(sourceAbs);
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) {
    return { ok: false, error: 'unsupported_destination' };
  }

  let safeTarget: string;
  try { safeTarget = sourceStat.isDirectory() ? safeDirPath(targetName) : safeFileName(targetName); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const targetAbs = resolveUnder(root, safeTarget);
  if (fs.existsSync(targetAbs)) return { ok: false, error: 'target_exists' };
  try {
    if (!fs.statSync(path.dirname(targetAbs)).isDirectory()) return { ok: false, error: 'not_found' };
  } catch { return { ok: false, error: 'not_found' }; }
  const checked = validateSpaceCopySource(sourceAbs);
  if (checked.ok === false) return { ok: false, error: checked.error };

  try {
    fs.cpSync(sourceAbs, targetAbs, {
      recursive: sourceStat.isDirectory(),
      errorOnExist: true,
      force: false,
      dereference: false,
    });
  } catch (err) {
    try { fs.rmSync(targetAbs, { recursive: true, force: true }); } catch { /* best-effort rollback */ }
    return { ok: false, error: (err as Error).message };
  }

  const copiedFiles = await filesUnderEntry(targetAbs, root);
  for (const file of copiedFiles) {
    spaceLibraryIndexer.enqueue(userId, sid, file.relPath, 'upsert');
    try { invalidateFileCache(userId, file.path); } catch { /* new path; best effort */ }
  }
  _notifyDirty(userId, sid);
  return { ok: true, name: safeTarget, fileCount: checked.fileCount, bytes: checked.bytes };
}

export async function readSpaceTextFile(
  userId: string,
  spaceId: string,
  name: string,
): Promise<Result<{ content: string; name: string }>> {
  const r = await resolveSpaceFileAbsPath(userId, spaceId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'text') return { ok: false, error: 'binary file cannot be read as text' };
  let st: fs.Stats;
  try { st = fs.statSync(r.absPath); }
  catch { return { ok: false, error: 'not_found' }; }
  if (st.size > MAX_BYTES_TEXT) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(MAX_BYTES_TEXT / 1024 / 1024) }) };
  }
  try {
    let content = fs.readFileSync(r.absPath, 'utf8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return { ok: true, content, name };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}

export async function updateSpaceTextFile(
  userId: string,
  spaceId: string,
  name: string,
  content: string,
): Promise<Result<{ name: string }>> {
  const r = await resolveSpaceFileAbsPath(userId, spaceId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'text') return { ok: false, error: 'binary file cannot be edited as text' };
  const body = typeof content === 'string' ? content : '';
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BYTES_TEXT) {
    return { ok: false, error: t('errors.file_too_large_mb', { mb: Math.round(MAX_BYTES_TEXT / 1024 / 1024) }) };
  }
  try { fs.writeFileSync(r.absPath, body, 'utf8'); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  try { invalidateFileCache(userId, r.absPath); }
  catch (err) { log.warn(`invalidate cache ${r.absPath}: ${(err as Error).message}`); }
  spaceLibraryIndexer.enqueue(userId, spaceId, name, 'upsert');
  _notifyDirty(userId, spaceId);
  return { ok: true, name };
}

export async function renameSpaceFile(
  userId: string,
  spaceId: string,
  oldName: string,
  nextName: string,
): Promise<Result<{ oldName: string; name: string; type: 'file' | 'dir'; info?: SpaceFileInfo }>> {
  let safeOld: string;
  let sid: string;
  try {
    safeOld = safeDirPath(oldName);
    sid = safeSpaceId(spaceId);
    if (!await spaceExists(userId, sid)) return { ok: false, error: 'not_found' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  const root = path.resolve(spaceFilesDir(userId, sid));
  let src: string;
  try { src = resolveUnder(root, safeOld); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  let st: fs.Stats;
  try { st = fs.statSync(src); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile() && !st.isDirectory()) return { ok: false, error: 'not_found' };

  const type: 'file' | 'dir' = st.isDirectory() ? 'dir' : 'file';
  let safeNext: string;
  try {
    safeNext = type === 'dir' ? safeDirPath(nextName) : safeFileName(nextName);
  } catch (err) { return { ok: false, error: (err as Error).message }; }
  if (safeOld === safeNext) {
    if (type === 'dir') return { ok: true, oldName: safeOld, name: safeNext, type };
    const current = infoFor(src, root);
    return current ? { ok: true, oldName: safeOld, name: safeNext, type, info: current } : { ok: false, error: 'not_found' };
  }
  if (type === 'dir' && safeNext.startsWith(`${safeOld}/`)) return { ok: false, error: 'forbidden' };

  let dst: string;
  try { dst = resolveUnder(root, safeNext); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (fs.existsSync(dst)) return { ok: false, error: 'target_exists' };
  if (!fs.existsSync(path.dirname(dst))) return { ok: false, error: 'not_found' };
  const movedFiles = await filesUnderEntry(src, root);
  try { fs.renameSync(src, dst); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  for (const file of movedFiles) {
    const nextRel = type === 'dir'
      ? `${safeNext}${file.relPath.slice(safeOld.length)}`
      : safeNext;
    const nextAbs = resolveUnder(root, nextRel);
    try { invalidateFileCache(userId, file.path); invalidateFileCache(userId, nextAbs); }
    catch (err) { log.warn(`invalidate cache rename ${file.relPath}: ${(err as Error).message}`); }
    spaceLibraryIndexer.enqueue(userId, sid, file.relPath, 'delete');
    spaceLibraryIndexer.enqueue(userId, sid, nextRel, 'upsert');
    _notifyDeleted(sid, file.relPath);
  }
  _notifyDirty(userId, sid);
  if (type === 'dir') return { ok: true, oldName: safeOld, name: safeNext, type };
  const info = infoFor(dst, root);
  if (!info) return { ok: false, error: 'rename failed' };
  return { ok: true, oldName: safeOld, name: info.relPath, type, info };
}

export async function readSpaceImage(
  userId: string,
  spaceId: string,
  name: string,
): Promise<Result<{ base64: string; mediaType: string; bytes: number }>> {
  const r = await resolveSpaceFileAbsPath(userId, spaceId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'image') return { ok: false, error: 'not an image' };
  const mediaType = IMAGE_MEDIA_TYPE[path.extname(r.absPath).toLowerCase()];
  if (!mediaType) return { ok: false, error: 'not an image' };
  try {
    const buf = fs.readFileSync(r.absPath);
    return { ok: true, base64: buf.toString('base64'), mediaType, bytes: buf.length };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}

export async function readSpaceDocxHtml(
  userId: string,
  spaceId: string,
  name: string,
): Promise<Result<{ html: string }>> {
  const r = await resolveSpaceFileAbsPath(userId, spaceId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  if (r.kind !== 'docx') return { ok: false, error: 'not a docx file' };
  try {
    const { docxBufferToHtml } = await import('../util/extract-docx');
    const buf = fs.readFileSync(r.absPath);
    const html = await docxBufferToHtml(buf);
    return { ok: true, html };
  } catch (err) {
    log.warn(`project docx→html ${spaceId}/${name}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export async function readSpaceOfficeHtml(
  userId: string,
  spaceId: string,
  name: string,
): Promise<Result<{ html: string; kind: 'word' | 'spreadsheet' | 'presentation'; previewHeight?: number }>> {
  const r = await resolveSpaceFileAbsPath(userId, spaceId, name);
  if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'not_found' };
  const kind = officePreviewKindForExt(path.extname(r.absPath).toLowerCase());
  if (!kind) return { ok: false, error: 'not a supported office file' };
  try {
    const buf = fs.readFileSync(r.absPath);
    const preview = await officeBufferToPreviewHtml(kind, path.basename(r.absPath), buf);
    return { ok: true, ...preview };
  } catch (err) {
    log.warn(`project office→html ${spaceId}/${name}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export async function getSpaceFilesRoot(userId: string, spaceId: string): Promise<string | null> {
  try {
    const sid = safeSpaceId(spaceId);
    if (!await spaceExists(userId, sid)) return null;
    return spaceFilesDir(userId, sid);
  } catch { return null; }
}

export async function isSpaceFilePath(userId: string, spaceId: string, absPath: string): Promise<boolean> {
  const root = await getSpaceFilesRoot(userId, spaceId);
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
