/**
 * 把一段文本导出到**用户本机文件夹**（不是知识库）。
 *
 * 谁在用：转写纠错面板的「另存到本地文件夹…」。库里的原文是复制进来的，用户要的是
 * 清理版落回他放原稿的那个文件夹（2026-09-23 真机反馈）。
 *
 * 两种落地方式（由 IPC 层决定，本模块只负责"安全地写"):
 *   - `exportTextToDirectory` —— 已知来源目录（见 `features/import_origins`）：**绝不覆盖**
 *     同名文件，冲突换 `-2`/`-3`（和"另存到知识库"同一套命名习惯）；
 *   - `exportTextToPath`      —— 用户在系统保存框里自己选了路径：允许覆盖（那是保存框的语义）。
 *
 * 为什么不复用 `contexts.writeContextFile`：那条链路把路径当**库内相对路径**解析
 * （`resolvePathForRoot` 会剥掉开头 `/`），传绝对路径会被当成库内的嵌套目录——
 * 正是这次故障里"文件跑到库内怪目录、本地原文件夹却没有"的成因。
 *
 * 安全口径：
 *   - 写入前过一遍 `sensitiveWritePathReasons`（写入敏感清单：`authorized_keys`、`/etc/cron*`、
 *     LaunchAgents…）。**刻意不用读侧清单**——读侧含 `^~/(Desktop|Downloads)`，而用户的稿子
 *     恰恰常放桌面，"主动导出到桌面"不该被当成敏感写入拦下；
 *   - 文件名一律取 basename 并净化分隔符/控制字符，杜绝越出目标目录；
 *   - 默认 `flag: 'wx'`：宁可多一个 `-2` 也不覆盖用户已有文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { sensitiveWritePathReasons } from './local_access_policy';

/** 单次导出上限：清理版是文本，20MB 足够覆盖 3 小时会议稿；超过判异常而不是硬写。 */
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

/** 同名候选最多试到这个序号，避免病态目录里死循环。 */
const MAX_NAME_ATTEMPTS = 1000;

/** 文件名长度上限（按 code point，够长且不会被 FS 拒绝）。 */
const MAX_FILENAME_CHARS = 120;

export interface LocalExportResult {
  ok: boolean;
  path?: string;
  error?: string;
  code?: string;
}

/**
 * 净化导出文件名：取 basename、去掉路径分隔符与控制字符、去掉开头的 `.`（隐藏文件），
 * 空名回退 `archive.txt`。
 */
export function sanitizeExportFileName(raw: unknown): string {
  const flattened = String(raw ?? '').replace(/\\/g, '/');
  let name = path.basename(flattened).trim();
  // 分隔符 / 控制字符 / Windows 保留字符：一律换 `-`，绝不能把 `..`、`a/b` 这类带出目录。
  name = name.replace(/[/:*?"<>|\u0000-\u001f]+/g, '-');
  name = name.replace(/^\.+/, '').trim();
  name = name.replace(/[.\s]+$/, '');
  if (!name) return 'archive.txt';
  if (name.length > MAX_FILENAME_CHARS) {
    const ext = path.extname(name);
    const stem = name.slice(0, Math.max(1, MAX_FILENAME_CHARS - ext.length));
    name = `${stem}${ext}`;
  }
  return name;
}

/** `a-清理版.txt` → `a-清理版-2.txt`（第 attempt 次冲突的候选名，attempt=0 即原名）。 */
export function candidateExportName(fileName: string, attempt: number): string {
  if (!attempt) return fileName;
  const ext = path.extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${stem}-${attempt + 1}${ext}`;
}

/** 目标目录里第一个不存在的候选路径（只做判断，不占位；真正写入靠 `wx` 兜底竞态）。 */
export function nextFreeExportPath(dir: string, fileName: string): string {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, candidateExportName(fileName, attempt));
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${Date.now()}-${fileName}`);
}

interface ContentGuard {
  ok: boolean;
  text: string;
  error?: string;
  code?: string;
}

function guardContent(content: unknown): ContentGuard {
  const text = typeof content === 'string' ? content : '';
  if (!text) return { ok: false, text: '', error: 'empty content', code: 'E_EXPORT_EMPTY' };
  if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_BYTES) {
    return {
      ok: false,
      text: '',
      error: `content exceeds ${Math.round(MAX_EXPORT_BYTES / 1024 / 1024)}MB limit`,
      code: 'E_EXPORT_TOO_LARGE',
    };
  }
  return { ok: true, text };
}

function guardTargetPath(absPath: string): LocalExportResult | null {
  const reasons = sensitiveWritePathReasons(absPath);
  if (reasons.length) {
    return { ok: false, error: 'sensitive path', code: 'E_EXPORT_SENSITIVE' };
  }
  return null;
}

/**
 * 写进指定目录（导出到"原文所在文件夹"走这条）：同名不覆盖，冲突落 `-2`/`-3`。
 * `wx` 保证"判断没占用、写入时已被占用"的竞态也不会覆盖别人。
 */
export function exportTextToDirectory(dir: string, fileName: string, content: string): LocalExportResult {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    return { ok: false, error: 'target directory must be absolute', code: 'E_EXPORT_DIR' };
  }
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: 'target directory not found', code: 'E_EXPORT_DIR' };
    }
  } catch {
    return { ok: false, error: 'target directory not readable', code: 'E_EXPORT_DIR' };
  }
  const guarded = guardContent(content);
  if (!guarded.ok) return { ok: false, error: guarded.error, code: guarded.code };
  const safeName = sanitizeExportFileName(fileName);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const target = path.join(dir, candidateExportName(safeName, attempt));
    const blocked = guardTargetPath(target);
    if (blocked) return blocked;
    try {
      fs.writeFileSync(target, guarded.text, { encoding: 'utf8', flag: 'wx' });
      return { ok: true, path: target };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') continue; // 同名：换 -2/-3 再来
      return { ok: false, error: (err as Error)?.message || String(err), code: 'E_EXPORT_WRITE' };
    }
  }
  return { ok: false, error: 'too many name collisions', code: 'E_EXPORT_WRITE' };
}

/**
 * 写进用户自己选的路径（系统保存框回来那条）：允许覆盖——那是保存框的语义，
 * 用户已经明确回答了"就用这个名字"。
 */
export function exportTextToPath(absPath: string, content: string): LocalExportResult {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
    return { ok: false, error: 'path must be absolute', code: 'E_EXPORT_PATH' };
  }
  const guarded = guardContent(content);
  if (!guarded.ok) return { ok: false, error: guarded.error, code: guarded.code };
  const blocked = guardTargetPath(absPath);
  if (blocked) return blocked;
  try {
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: 'target directory not found', code: 'E_EXPORT_DIR' };
    }
    fs.writeFileSync(absPath, guarded.text, 'utf8');
    return { ok: true, path: absPath };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || String(err), code: 'E_EXPORT_WRITE' };
  }
}
