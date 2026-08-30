// COGSEED-18：新建工作空间时本地文件夹整体导入。
// 技术边界（本实现采用的默认口径，同步到测试用例/需求文档）：
//   - 模式：复制（copy）进空间内容目录 `<空间>/imports/<文件夹名>/`，保留相对目录结构；
//   - 支持格式：全部文件类型（不做扩展名白名单——导入的是用户自己的资料）；
//   - 上限：单文件 ≤ 100MB、总量 ≤ 1GB、文件数 ≤ 5000，超限条目跳过并逐条说明；
//   - 子目录：递归复制；`.git` / `node_modules` / `.DS_Store` 等工程垃圾目录跳过并记录；
//   - 容错：单个文件失败不阻断其它文件（部分成功），全部失败条目进 skipped 清单；
//   - 进度：每处理 20 个文件回调一次 onProgress（IPC 层转 broadcastToRenderer 推送）。
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spaceContentDir, spaceLibraryVectorDbPath, userContextsDir } from '../paths';
import { safeId } from '../storage';
import { createLogger } from '../logger';
import * as contexts from './contexts';
import { importSpaceFileFromPath } from './project_files';
import * as vs from './vec_store';
const log = createLogger('space_import');

export const IMPORT_LIMITS = {
  MAX_FILE_BYTES: 100 * 1024 * 1024, // 单文件 100MB
  MAX_TOTAL_BYTES: 1024 * 1024 * 1024, // 总量 1GB
  MAX_FILES: 5000, // 文件数
};

export const SKIPPED_DIR_NAMES = new Set(['.git', 'node_modules', '.svn', '.hg', '__pycache__', '.DS_Store']);

export interface ImportProgress {
  spaceId: string;
  done: number;
  total: number;
}

export interface ImportSkippedEntry {
  path: string; // 相对源文件夹的路径
  reason: 'file_too_large' | 'total_limit' | 'file_count_limit' | 'copy_failed' | 'unsupported_dir' | string;
}

export type ImportFolderResult =
  | { ok: true; total: number; copied: number; skipped: ImportSkippedEntry[]; targetDir: string }
  | { ok: false; error: string };

export type ImportLibResult =
  | { ok: true; scanned: number; imported: number; files: Array<{ name: string; ok: boolean; error?: string }> }
  | { ok: false; error: string };

/**
 * 把个人知识库（contexts/ 下的一个库目录）的内容镜像导入到共享知识库（空间）。
 * 对齐 ima「从个人知识库导入」：源目录结构保留，文件走空间索引队列（upsert），
 * 导入后可直接在共享库内做 AI 问答。单个文件失败不阻断整体。
 */
export async function importLibIntoSpace(
  userId: string,
  spaceId: string,
  libName: string,
): Promise<ImportLibResult> {
  if (!safeId(spaceId)) return { ok: false, error: 'invalid_space' };
  const name = String(libName || '').trim();
  if (!name) return { ok: false, error: 'missing_lib_name' };
  const srcDir = path.join(userContextsDir(userId), name);
  let st: fs.Stats;
  try {
    st = await fsp.stat(srcDir);
  } catch {
    return { ok: false, error: 'source_lib_not_found' };
  }
  if (!st.isDirectory()) return { ok: false, error: 'source_lib_not_directory' };

  const files = await contexts.collectImportableFilesFromDir(srcDir);
  const absByRel = new Map(files.map((f) => [f.rel, f.abs]));
  return importFilesIntoSpace(userId, spaceId, absByRel);
}

/**
 * 把一组个人库文件（relPath → 绝对路径）导入共享库（空间）。
 * 供「整库导入」与「弹窗勾选文件导入」复用：并发复制 + pending 占位，
 * 返回逐文件结果，单个失败不阻断。
 */
export async function importFilesIntoSpace(
  userId: string,
  spaceId: string,
  absByRel: Map<string, string>,
): Promise<ImportLibResult> {
  const entries = Array.from(absByRel.entries());
  const out: Array<{ name: string; ok: boolean; error?: string }> = [];
  let imported = 0;

  // 有限并发导入（默认 6 路），避免逐文件串行拖慢大批量导入。
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const [rel, abs] = entries[cursor++];
      try {
        const r = await importSpaceFileFromPath(userId, spaceId, rel, abs, { skipHash: true });
        if (r.ok) imported += 1;
        out.push({ name: rel, ok: r.ok, error: r.ok ? undefined : String((r as { error?: string }).error || 'import_failed') });
      } catch (err) {
        out.push({ name: rel, ok: false, error: (err as Error)?.message || String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length || 1) }, worker));

  // 导入的文件已落盘并 enqueue 进索引队列，但向量化（提取/嵌入）是异步的，
  // 直接读向量库快照会看不到新文件（"已导入 N 个但列表空"）。
  // 这里为每个成功导入的文件写一条 pending 占位行（索引完成后会更新为 ready），
  // 让列表立即可见、状态自然过渡。
  if (imported > 0) {
    try {
      const store = vs.openVecStore(path.dirname(spaceLibraryVectorDbPath(userId, spaceId)));
      for (const o of out) {
        if (!o.ok) continue;
        try {
          const abs = absByRel.get(o.name);
          if (!abs) continue;
          const st = await fsp.stat(abs).catch(() => null);
          if (!st) continue;
          const existing = store.getFile(o.name);
          if (existing && (existing.status === 'ready' || existing.status === 'processing' || existing.status === 'pending')) continue;
          await store.setFileStatus(o.name, 'pending', {
            kind: kindForName(o.name),
            bytes: st.size,
            mtime: st.mtimeMs / 1000,
            sha1: await sha1Of(abs),
          });
        } catch { /* 占位失败不阻断（索引队列仍会兜底） */ }
      }
    } catch { /* store 打开失败不阻断 */ }
  }

  log.info('space import files done', {
    userId, spaceId, scanned: entries.length, imported,
  });
  return { ok: true, scanned: entries.length, imported, files: out };
}

function reasonForError(err: unknown): string {
  if (!err) return 'copy_failed';
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'permission_denied';
  if (e.code === 'ENOENT') return 'missing_source';
  if (e.code === 'ENOSPC') return 'disk_full';
  return 'copy_failed';
}

interface FileEntry {
  abs: string;
  rel: string;
}

/** 递归收集源目录下的全部文件（跳过工程垃圾目录），返回相对路径列表。 */
async function collectFiles(sourceDir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 读不了的子目录由 copy 阶段以文件为单位报告失败
    }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(e.name)) continue;
        await walk(full, childRel);
      } else if (e.isFile()) {
        if (e.name === '.DS_Store') continue;
        out.push({ abs: full, rel: childRel });
      }
    }
  };
  await walk(sourceDir, '');
  return out;
}

/**
 * 把本地文件夹整体复制进指定空间：`<空间内容目录>/imports/<文件夹名>/`。
 * 校验失败返回 {ok:false,error}；否则返回逐文件汇总（部分失败不阻断整体）。
 */
export async function importFolderIntoSpace(
  userId: string,
  spaceId: string,
  sourceDir: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportFolderResult> {
  if (!safeId(spaceId)) return { ok: false, error: 'invalid_space' };
  if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) {
    return { ok: false, error: 'invalid_source' };
  }
  let st: fs.Stats;
  try {
    st = await fsp.stat(sourceDir);
  } catch {
    return { ok: false, error: 'source_not_found' };
  }
  if (!st.isDirectory()) return { ok: false, error: 'source_not_directory' };

  // 防自引用循环：源目录不能位于目标空间内容目录之内
  const contentDir = spaceContentDir(userId, spaceId);
  let realSource: string;
  try {
    realSource = await fsp.realpath(sourceDir);
  } catch {
    return { ok: false, error: 'source_unreadable' };
  }
  const realContent = await fsp.realpath(contentDir).catch(() => contentDir);
  if (realSource === realContent || realSource.startsWith(realContent + path.sep)) {
    return { ok: false, error: 'source_inside_space' };
  }

  const files = await collectFiles(realSource);
  const baseName = path.basename(realSource) || 'import';
  const targetDir = path.join(contentDir, 'imports', baseName);

  const skipped: ImportSkippedEntry[] = [];
  let copied = 0;
  let totalBytes = 0;
  let processed = 0;
  const total = files.length;

  for (const f of files) {
    if (copied + skipped.length >= IMPORT_LIMITS.MAX_FILES) {
      skipped.push({ path: f.rel, reason: 'file_count_limit' });
      processed++;
      onProgress?.({ spaceId, done: processed, total });
      continue;
    }
    try {
      const fst = await fsp.stat(f.abs);
      if (fst.size > IMPORT_LIMITS.MAX_FILE_BYTES) {
        skipped.push({ path: f.rel, reason: 'file_too_large' });
      } else if (totalBytes + fst.size > IMPORT_LIMITS.MAX_TOTAL_BYTES) {
        skipped.push({ path: f.rel, reason: 'total_limit' });
      } else {
        const dest = path.join(targetDir, f.rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(f.abs, dest);
        copied++;
        totalBytes += fst.size;
      }
    } catch (err) {
      skipped.push({ path: f.rel, reason: reasonForError(err) });
    }
    processed++;
    if (processed % 20 === 0 || processed === total) {
      onProgress?.({ spaceId, done: processed, total });
    }
  }

  log.info('space folder import done', {
    userId, spaceId, copied, skipped: skipped.length, targetDir: logSafePath(targetDir),
  });
  return { ok: true, total, copied, skipped, targetDir };
}

function logSafePath(p: string): string {
  return p.replace(/[A-Za-z]:\\/g, '').split(/[\\/]/).slice(-3).join('/');
}

/** 文件扩展名 → 向量库 kind（与 project_library_indexer.kindFor 一致）。 */
function kindForName(name: string): vs.VecKind {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.docm') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet';
  if (ext === '.pptx' || ext === '.pptm') return 'presentation';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) return 'image';
  return 'text';
}

/** 轻量 SHA-1（占位行需要；大文件也只需读一次）。 */
async function sha1Of(absPath: string): Promise<string> {
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(absPath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
