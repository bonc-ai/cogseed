/**
 * Timestamps, ID generation, and JSON/JSONL IO helpers.
 *
 * 1:1 port of `biz/storage.py`, with one upgrade:
 *   - writeJson() is atomic (tmp + rename). Python version wasn't.
 *
 * No business logic — safe to require from any module.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Mutex, type MutexInterface } from 'async-mutex';

// ── Timestamps / IDs ─────────────────────────────────────────────────────

/** Local-time ISO8601 down to seconds, no TZ suffix (matches Python `now_iso`). */
export function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 8-digit numeric user id. */
export function genUserId(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += Math.floor(Math.random() * 10);
  return out;
}

/** 12-hex-char id (agents + conversations). */
export function genId12(): string {
  return crypto.randomBytes(6).toString('hex');
}

export const genAgentId = genId12;
export const genConversationId = genId12;

/**
 * Path-traversal / shell-injection guard for URL-supplied IDs.
 * Only alphanumeric plus `-` and `_` pass.
 */
export function safeId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

// ── JSON / JSONL IO ──────────────────────────────────────────────────────

/** Read JSON, defaulting to {}. Strict callers tolerate only a missing file. */
export async function readJson<T = Record<string, any>>(filePath: string, options: { strict?: boolean } = {}): Promise<T> {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch (error) {
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {} as T;
  }
}

/** Synchronous variant — used in startup paths before the event loop is hot. */
export function readJsonSync<T = Record<string, any>>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return {} as T;
  }
}

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800];
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function atomicTmpPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

function isRetryableRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RENAME_RETRY_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

async function renameWithRetryUsing(
  tmp: string,
  filePath: string,
  renameFn: (oldPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFn(tmp, filePath);
      return;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function renameWithRetry(tmp: string, filePath: string, isCurrent?: () => boolean): Promise<void> {
  return renameWithRetryUsing(tmp, filePath, async (source, target) => {
    assertWriteCurrent(isCurrent);
    await fsp.rename(source, target);
  });
}

function renameWithRetrySyncUsing(
  tmp: string,
  filePath: string,
  renameFn: (oldPath: string, newPath: string) => void,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameFn(tmp, filePath);
      return;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function renameWithRetrySync(tmp: string, filePath: string): void {
  return renameWithRetrySyncUsing(tmp, filePath, fs.renameSync);
}

export const __storageTestHooks = {
  renameWithRetryUsing,
  renameWithRetrySyncUsing,
};

/**
 * Atomically write JSON with UTF-8 and 2-space indent.
 * Writes to a same-directory temp file then renames over the target to
 * prevent torn reads.
 */
export async function writeJson(filePath: string, data: unknown, isCurrent?: () => boolean): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  assertWriteCurrent(isCurrent);
  const tmp = atomicTmpPath(filePath);
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    assertWriteCurrent(isCurrent);
    await renameWithRetry(tmp, filePath, isCurrent);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function writeJsonSync(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    renameWithRetrySync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

/**
 * Atomic text write (tmp + rename). Same guarantee as writeJson but for
 * arbitrary file content — used by places that write user-edited text
 * (e.g. SKILL.md, custom skill files) where a torn write would lose the
 * definition entirely.
 */
export function writeTextAtomicSync(filePath: string, text: string | Buffer, encoding: BufferEncoding = 'utf8'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = atomicTmpPath(filePath);
  if (typeof text === 'string') fs.writeFileSync(tmp, text, { encoding });
  else fs.writeFileSync(tmp, text);
  try {
    renameWithRetrySync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

/** Append one JSON record as a single line. */
export async function appendJsonl(filePath: string, record: unknown, isCurrent?: () => boolean): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  assertWriteCurrent(isCurrent);
  await fsp.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
}

// ── Atomic append + msgIndex ─────────────────────────────────────────────
// Per-file Mutex + cached line count so the caller can get a correct
// monotonic index for the just-appended record without a race. First touch
// cold-reads the file once; subsequent appends are O(1).

const _lineLocks = new Map<string, MutexInterface>();
const _lineCounts = new Map<string, number>();

function _getLineLock(filePath: string): MutexInterface {
  let m = _lineLocks.get(filePath);
  if (!m) { m = new Mutex(); _lineLocks.set(filePath, m); }
  return m;
}

/** Run a JSONL read/rewrite under the same per-file lock as appendJsonlAtomic.
 *  Use for destructive redaction that must not race a concurrent append. */
export async function withJsonlLineLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return _getLineLock(filePath).runExclusive(fn);
}

async function _loadLineCount(filePath: string): Promise<number> {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    let n = 0;
    for (const line of text.split('\n')) if (line.trim()) n++;
    return n;
  } catch { return 0; }
}

export interface AtomicAppendResult<T = unknown> {
  record: T;
  msgIndex: number;
}

/** Options for {@link appendJsonlAtomic}. */
export interface AtomicAppendOptions {
  isCurrent?: () => boolean;
  /**
   * 防拼接（recall 版本流等只追加 JSONL 启用）：文件存在、非空且
   * 末字节不是换行（云同步冲突/崩溃截断出的撕裂半行）时，先补一个换行把
   * 撕裂行隔离成独立坏行再正常追加。不修复的话 appendFile 会把新记录直接
   * 拼进坏行——坏行吞掉下一条合法记录（撕裂前的字节全部保留，读侧逐行
   * 降级跳过）。默认关闭：行锁内多一次 stat+末字节读，只有需要该保证的
   * 调用方付费。
   */
  repairTornTail?: boolean;
}

/**
 * Append one JSON record and return its zero-based line index atomically.
 *
 * Two concurrent callers on the same file see serialized msgIndex values —
 * no "count after append" race. Used by chat/skill/agent message writers so
 * the search indexer can be told the exact position without re-scanning.
 */
export async function appendJsonlAtomic<T>(
  filePath: string,
  record: T,
  options: AtomicAppendOptions = {},
): Promise<AtomicAppendResult<T>> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const lock = _getLineLock(filePath);
  return lock.runExclusive(async () => {
    assertWriteCurrent(options.isCurrent);
    if (options.repairTornTail) {
      let size = 0;
      let lastByte = 0x0a;
      try {
        const stat = await fsp.stat(filePath);
        size = stat.size;
        if (size > 0) {
          const handle = await fsp.open(filePath, 'r');
          try {
            const tail = Buffer.alloc(1);
            await handle.read(tail, 0, 1, size - 1);
            lastByte = tail[0];
          } finally {
            await handle.close();
          }
        }
      } catch {
        // stat/open 失败按「无既有文件」处理：下面的 appendFile 自会建目录建文件。
      }
      if (size > 0 && lastByte !== 0x0a) {
        assertWriteCurrent(options.isCurrent);
        await fsp.appendFile(filePath, '\n', 'utf8');
        // 补的是换行不是内容行，行数缓存语义（非空行计数）不变。
      }
    }
    let count = _lineCounts.get(filePath);
    if (count === undefined) {
      count = await _loadLineCount(filePath);
      _lineCounts.set(filePath, count);
    }
    assertWriteCurrent(options.isCurrent);
    await fsp.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
    _lineCounts.set(filePath, count + 1);
    return { record, msgIndex: count };
  });
}

/** Append a stable-id JSONL record once under the canonical line lock. */
export async function appendJsonlByIdIdempotent<T extends { id: string }>(
  filePath: string,
  record: T,
  matches?: (current: T, incoming: T) => boolean,
  isCurrent?: () => boolean,
): Promise<{ inserted: boolean; record: T; msgIndex: number }> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  return _getLineLock(filePath).runExclusive(async () => {
    assertWriteCurrent(isCurrent);
    let text = '';
    try { text = await fsp.readFile(filePath, 'utf8'); } catch { /* new stream */ }
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let current: T | undefined;
      try { current = JSON.parse(line) as T; }
      catch { /* malformed historical line does not hide a valid append */ }
      if (current?.id === record.id) {
        if (matches && !matches(current, record)) throw new Error('stable message id conflict');
        return { inserted: false, record: current, msgIndex: count };
      }
      count += 1;
    }
    assertWriteCurrent(isCurrent);
    await fsp.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
    _lineCounts.set(filePath, count + 1);
    return { inserted: true, record, msgIndex: count };
  });
}

/** Host-provided lifecycle ceiling, evaluated after storage waits. */
function assertWriteCurrent(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) throw new Error('write lifecycle changed');
}

/**
 * Drop cached line count for a file (call after the file is removed or
 * renamed, so the next appendJsonlAtomic recounts instead of reusing stale).
 */
export function invalidateLineCount(filePath: string): void {
  _lineCounts.delete(filePath);
  _lineLocks.delete(filePath);
}

/** Result of a locked whole-stream removal: whether the file existed. */
export interface RemoveJsonlStreamResult {
  existed: boolean;
}

/**
 * Remove a whole JSONL stream under the same file lock as appendJsonlAtomic
 * purge 删整流必须与在途 append 互斥——裸 fs.rm 会在
 * 行锁排队中的 append 落地前把文件删掉，让那条 append 用 appendFile 重建流
 * 文件（purged 资产的版本快照复活）。锁内删除后同步清掉行数缓存，下一次
 * append 重新计数而不是复用已删文件的 stale 计数。文件不存在视为已达成
 * 目标（清除要可重入），返回 existed=false 供调用方区分是否真的删过。
 */
export async function removeJsonlStream(
  filePath: string,
): Promise<RemoveJsonlStreamResult> {
  const lock = _getLineLock(filePath);
  let existed = true;
  await lock.runExclusive(async () => {
    try {
      await fsp.rm(filePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        existed = false;
        return;
      }
      throw error;
    }
    // 只清行数缓存、保留锁登记：锁表条目常驻与本仓其他文件锁同口径，
    // 删锁反而会让排队中的等待者与新调用者分持两把锁失去互斥。
    _lineCounts.delete(filePath);
  });
  return { existed };
}

/**
 * Atomic read-modify-write of a single JSONL line.
 *
 * Reads every line under the same line-lock that `appendJsonlAtomic` uses,
 * calls `mutate(record)` on the line at `msgIndex` (receives the parsed
 * record, returns the replacement record OR null to abort), and writes the
 * file back in one shot. Because both operations share the lock, no
 * interleaving append can clobber the edit.
 *
 * Returns `{ ok: true, record }` on success (record = the written replacement),
 * or `{ ok: false, error }` if the index is out of range or mutate aborted.
 */
export type RewriteJsonlResult<T> =
  | { ok: true; record: T }
  | { ok: false; error: string };

export async function rewriteJsonlLine<T extends object>(
  filePath: string, msgIndex: number,
  mutate: (current: T) => T | null,
): Promise<RewriteJsonlResult<T>> {
  const lock = _getLineLock(filePath);
  return lock.runExclusive<RewriteJsonlResult<T>>(async () => {
    let text: string;
    try { text = await fsp.readFile(filePath, 'utf8'); }
    catch (err) { return { ok: false, error: `read failed: ${(err as Error).message}` }; }

    const lines = text.split('\n');
    // Preserve the trailing-newline convention: split on \n always leaves an
    // empty last element for files that end with \n; we rejoin with \n + ''.
    const hasTrailing = lines.length > 0 && lines[lines.length - 1] === '';
    const body = hasTrailing ? lines.slice(0, -1) : lines;

    if (msgIndex < 0 || msgIndex >= body.length) {
      return { ok: false, error: `index out of range (${msgIndex}/${body.length})` };
    }

    let current: T;
    try { current = JSON.parse(body[msgIndex]) as T; }
    catch (err) { return { ok: false, error: `line ${msgIndex} not JSON: ${(err as Error).message}` }; }

    const next = mutate(current);
    if (next === null) return { ok: false, error: 'mutate aborted' };

    body[msgIndex] = JSON.stringify(next);
    const out = body.join('\n') + '\n';
    // Write to tmp + rename — rewrite is a "full file" op; we can't use
    // append here. Line count stays the same.
    const tmp = atomicTmpPath(filePath);
    await fsp.writeFile(tmp, out, 'utf8');
    try {
      await renameWithRetry(tmp, filePath);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return { ok: true, record: next };
  });
}

/** Result of an atomic JSONL record-set rewrite. The replacement keeps the
 * original physical record count, so callers that persist JSONL line indexes
 * retain stable locators after changing several records in one operation. */
export type RewriteJsonlRecordsResult<T> =
  | { ok: true; records: T[] }
  | { ok: false; error: string };

/**
 * Atomically rewrite every non-empty JSONL record under the same file lock as
 * appendJsonlAtomic. The mutator must return the same number of records: this
 * helper is for revisions/tombstones, not compaction, and preserves stable
 * line-based references used by conversation history.
 */
export async function rewriteJsonlRecords<T extends object>(
  filePath: string,
  mutate: (records: readonly T[]) => T[] | null,
): Promise<RewriteJsonlRecordsResult<T>> {
  const lock = _getLineLock(filePath);
  return lock.runExclusive<RewriteJsonlRecordsResult<T>>(async () => {
    let text: string;
    try { text = await fsp.readFile(filePath, 'utf8'); }
    catch (err) { return { ok: false, error: `read failed: ${(err as Error).message}` }; }

    const lines = text.split('\n');
    const hasTrailing = lines.length > 0 && lines[lines.length - 1] === '';
    const body = hasTrailing ? lines.slice(0, -1) : lines;
    const records: T[] = [];
    for (let index = 0; index < body.length; index += 1) {
      if (!body[index].trim()) return { ok: false, error: `line ${index} is empty` };
      try { records.push(JSON.parse(body[index]) as T); }
      catch (err) { return { ok: false, error: `line ${index} not JSON: ${(err as Error).message}` }; }
    }

    const next = mutate(records);
    if (next === null) return { ok: false, error: 'mutate aborted' };
    if (!Array.isArray(next) || next.length !== records.length) {
      return { ok: false, error: 'mutate changed record count' };
    }

    const out = next.map((record) => JSON.stringify(record)).join('\n') + (hasTrailing ? '\n' : '');
    const tmp = atomicTmpPath(filePath);
    await fsp.writeFile(tmp, out, 'utf8');
    try {
      await renameWithRetry(tmp, filePath);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    _lineCounts.set(filePath, records.length);
    return { ok: true, records: next };
  });
}

/** Result of an atomic JSONL record removal (physical compaction): how many
 *  records were kept and removed. Failures (unreadable stream, malformed
 *  lines) throw instead of returning an error branch. */
export interface RemoveJsonlRecordsResult {
  kept: number;
  removed: number;
  /** dropMalformedLines 模式下被丢弃的坏行数（无法解析、按"随清除移除"处理）。 */
  droppedMalformed?: number;
}

/**
 * Atomically remove records from a JSONL stream under the same file lock as
 * appendJsonlAtomic. Unlike rewriteJsonlRecords this is allowed to shrink the
 * stream: it is the physical-deletion primitive (e.g. removing an ability
 * asset version for real), so line-based locators are NOT preserved. Kept
 * records are re-serialized in order; removing everything deletes the file.
 *
 * 坏行默认仍抛错（破坏性重写不能静默丢弃无法解析的未知字节）。仅当调用方
 * 显式传 dropMalformedLines（purge 级联清理：目标是移除，坏档不许把清除
 * 永久卡死）时，无法解析的行按"随清除移除"处理并计入 droppedMalformed。
 */
export async function removeJsonlRecords<T extends object>(
  filePath: string,
  keep: (record: T) => boolean,
  options?: { dropMalformedLines?: boolean },
): Promise<RemoveJsonlRecordsResult> {
  const dropMalformed = options?.dropMalformedLines === true;
  const lock = _getLineLock(filePath);
  return lock.runExclusive<RemoveJsonlRecordsResult>(async () => {
    let text: string;
    try { text = await fsp.readFile(filePath, 'utf8'); }
    catch (err) { throw new Error(`read failed: ${(err as Error).message}`); }

    const lines = text.split('\n');
    const hasTrailing = lines.length > 0 && lines[lines.length - 1] === '';
    const body = hasTrailing ? lines.slice(0, -1) : lines;
    const kept: T[] = [];
    let droppedMalformed = 0;
    for (let index = 0; index < body.length; index += 1) {
      if (!body[index].trim()) {
        if (dropMalformed) { droppedMalformed += 1; continue; }
        throw new Error(`line ${index} is empty`);
      }
      let record: T;
      try { record = JSON.parse(body[index]) as T; }
      catch (err) {
        if (dropMalformed) { droppedMalformed += 1; continue; }
        throw new Error(`line ${index} not JSON: ${(err as Error).message}`);
      }
      if (keep(record)) kept.push(record);
    }
    const removed = body.length - kept.length;
    const malformed = droppedMalformed;
    if (kept.length === 0) {
      try {
        await fsp.rm(filePath);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      _lineCounts.set(filePath, 0);
      return { kept: 0, removed, ...(malformed ? { droppedMalformed: malformed } : {}) };
    }
    const out = kept.map((record) => JSON.stringify(record)).join('\n') + '\n';
    const tmp = atomicTmpPath(filePath);
    await fsp.writeFile(tmp, out, 'utf8');
    try {
      await renameWithRetry(tmp, filePath);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    _lineCounts.set(filePath, kept.length);
    return { kept: kept.length, removed, ...(malformed ? { droppedMalformed: malformed } : {}) };
  });
}

const JSONL_TAIL_CHUNK_BYTES = 64 * 1024;

function _parseJsonlRecord<T>(line: string): T | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as T; } catch { return undefined; }
}

function _appendJsonlRecord<T>(out: T[], line: string): void {
  const record = _parseJsonlRecord<T>(line);
  if (record !== undefined) out.push(record);
}

export interface JsonlPage<T> {
  records: T[];
  /** Byte offset at which an older page ends; null means the file start. */
  nextCursor: number | null;
}

export interface JsonlWindow<T> {
  records: T[];
  /** Byte offset immediately before this window; compatible with readJsonlPage. */
  previousCursor: number | null;
}

/**
 * Return one newest-first-selected JSONL page in chronological order.
 *
 * `before` is an exclusive byte cursor emitted by a previous call. It keeps
 * pagination on the file tail: loading an older page never rereads or parses
 * the newer records already mounted in the conversation view.
 */
export async function readJsonlPage<T = Record<string, any>>(
  filePath: string,
  limit = 200,
  before?: number | null,
  options?: { strict?: boolean },
): Promise<JsonlPage<T>> {
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (error) {
    if (options?.strict) throw error;
    return { records: [], nextCursor: null };
  }

  try {
    const size = (await handle.stat()).size;
    const requestedEnd = before === null || before === undefined ? Number.NaN : Number(before);
    let position = Number.isSafeInteger(requestedEnd)
      ? Math.max(0, Math.min(requestedEnd, size))
      : size;
    let carry = Buffer.alloc(0);
    const newestFirst: T[] = [];
    let oldestRecordStart = -1;

    while (position > 0 && newestFirst.length < wanted) {
      const bytes = Math.min(JSONL_TAIL_CHUNK_BYTES, position);
      position -= bytes;
      const block = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(block, 0, bytes, position);
      const joined = carry.length
        ? Buffer.concat([block.subarray(0, bytesRead), carry])
        : block.subarray(0, bytesRead);

      let end = joined.length;
      for (let i = joined.length - 1; i >= 0 && newestFirst.length < wanted; i -= 1) {
        if (joined[i] !== 0x0a) continue; // '\n'
        const line = joined.subarray(i + 1, end).toString('utf8');
        const record = _parseJsonlRecord<T>(line);
        if (options?.strict && record === undefined && line.trim()) throw new Error('invalid JSONL record');
        if (record !== undefined) {
          newestFirst.push(record);
          oldestRecordStart = position + i + 1;
        }
        end = i;
      }
      carry = joined.subarray(0, end);
    }

    if (newestFirst.length < wanted && carry.length) {
      const line = carry.toString('utf8');
      const record = _parseJsonlRecord<T>(line);
      if (options?.strict && record === undefined && line.trim()) throw new Error('invalid JSONL record');
      if (record !== undefined) {
        newestFirst.push(record);
        oldestRecordStart = 0;
      }
    }

    return {
      records: newestFirst.reverse(),
      nextCursor: oldestRecordStart > 0 ? oldestRecordStart : null,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read a bounded chronological window by parsed-record index.
 *
 * This is the direct-window companion to tail pagination: search already owns a
 * stable JSONL record index, so opening a hit can stream forward once to that
 * window instead of fetching every intervening tail page through IPC. The
 * returned byte cursor lets the existing older-page reader continue upward.
 */
export async function readJsonlWindow<T = Record<string, any>>(
  filePath: string,
  startIndex: number,
  limit = 10,
): Promise<JsonlWindow<T>> {
  const first = Math.max(0, Math.floor(Number(startIndex) || 0));
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return { records: [], previousCursor: null };
  }

  try {
    const size = (await handle.stat()).size;
    const records: T[] = [];
    let recordIndex = 0;
    let position = 0;
    let carry = Buffer.alloc(0);
    let firstRecordStart = -1;
    let done = false;

    const consumeLine = (line: Buffer, recordStart: number): boolean => {
      const record = _parseJsonlRecord<T>(line.toString('utf8'));
      if (record === undefined) return false;
      if (recordIndex >= first && records.length < wanted) {
        if (firstRecordStart < 0) firstRecordStart = recordStart;
        records.push(record);
      }
      recordIndex += 1;
      return records.length >= wanted;
    };

    while (position < size && !done) {
      const bytes = Math.min(JSONL_TAIL_CHUNK_BYTES, size - position);
      const block = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(block, 0, bytes, position);
      if (bytesRead <= 0) break;
      const joined = carry.length
        ? Buffer.concat([carry, block.subarray(0, bytesRead)])
        : block.subarray(0, bytesRead);
      const joinedStart = position - carry.length;
      let lineStart = 0;
      for (let i = 0; i < joined.length; i += 1) {
        if (joined[i] !== 0x0a) continue;
        done = consumeLine(joined.subarray(lineStart, i), joinedStart + lineStart);
        lineStart = i + 1;
        if (done) break;
      }
      position += bytesRead;
      if (!done) carry = joined.subarray(lineStart);
    }
    if (!done && carry.length) consumeLine(carry, position - carry.length);

    return {
      records,
      previousCursor: firstRecordStart > 0 ? firstRecordStart : null,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read a JSONL file, returning the last `limit` valid records.
 *
 * History consumers normally need only a bounded tail. Reading from the end
 * keeps a years-long conversation log from being fully loaded, split and
 * parsed merely to display its newest messages. Each candidate line is
 * decoded only after its complete byte range has been assembled, so UTF-8
 * characters that straddle a disk-read boundary remain intact.
 *
 * Non-positive limits retain the historical full-file behavior. Malformed
 * lines are silently skipped, matching the previous Python-compatible read.
 */
export async function readJsonl<T = Record<string, any>>(filePath: string, limit = 200): Promise<T[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    let text: string;
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of text.split('\n')) _appendJsonlRecord(out, line);
    return out.slice(-limit);
  }

  return (await readJsonlPage<T>(filePath, limit)).records;
}
