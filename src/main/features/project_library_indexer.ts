/**
 * Project-scoped Library vector index.
 *
 * Project Library source files live under `<uid>/cloud/projects/<sid>/contexts/`.
 * The derived vector store is machine-local under `<uid>/local/projects/<sid>/`
 * so project assets can sync independently from embeddings, mirroring the
 * global Library/KB design.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { spaceFilesDir, spaceLibraryVectorDbPath } from '../paths';
import { createLogger } from '../logger';
import { fileToChunks, type ChunkableKind } from '../util/file_to_chunks';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';
import {
  envTimeoutMs,
  OperationTimeoutError,
  operationErrorCode,
  withOperationTimeout,
} from '../util/operation-timeout';
import { describeLibraryImage } from './library_image_describer';

import * as vs from './vec_store';
import * as kbEmbed from './kb_embed';
import { spaceExists } from './spaces';

const log = createLogger('project_library_indexer');

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
const MAX_PATH_SEGMENT_LEN = 200;
const EXTRACT_TIMEOUT_MS = envTimeoutMs('COGSEED_LIBRARY_EXTRACT_TIMEOUT_MS', 5 * 60 * 1000);
const EMBED_TIMEOUT_MS = envTimeoutMs('COGSEED_LIBRARY_EMBED_TIMEOUT_MS', 5 * 60 * 1000);

type LibraryVectorizeBatch = Record<string, never>;
interface LibraryVectorizeSummary {
  result: string;
  file_count: number;
  succeeded_count: number;
  failed_count: number;
  timeout_count: number;
  recovered_count: number;
  retry_count: number;
  duration_ms: number;
  max_queue_wait_ms: number;
}

function createLibraryVectorizeBatch(_scope: 'space'): LibraryVectorizeBatch {
  return {};
}

function flushLibraryVectorizeBatch(_batch: LibraryVectorizeBatch): LibraryVectorizeSummary | null {
  return null;
}

function recordLibraryVectorizeOutcome(
  _batch: LibraryVectorizeBatch,
  _outcome: Record<string, string | number>,
): void {}

type SpaceLibraryKind = ChunkableKind;
export type SpaceLibraryEventType = 'pending' | 'processing' | 'ready' | 'failed' | 'deleted';

export interface SpaceLibraryStatusEvent {
  userId: string;
  spaceId: string;
  name: string;
  relPath: string;
  status: SpaceLibraryEventType;
  chunks?: number;
  error?: string;
  kind?: SpaceLibraryKind;
  stage?: 'queue' | 'extract' | 'embed' | 'persist' | 'reconcile';
  errorCode?: string;
  recovered?: boolean;
}

export interface SpaceLibraryReconcileResult {
  enqueuedUpsert: number;
  enqueuedDelete: number;
  unchanged: number;
  recoveredProcessing?: number;
  incomplete?: boolean;
}

interface Job {
  spaceId: string;
  name: string;
  op: 'upsert' | 'delete';
  force?: boolean;
  enqueuedAt: number;
  reason: 'mutation' | 'reconcile' | 'crash_recovery' | 'late_recovery' | 'manual';
  attempt: number;
}

interface Queue {
  jobs: Job[];
  running: boolean;
  scheduled: boolean;
  activeKeys: Map<string, number>;
  /** 待处理 job 的复合键（jobKey|op → Job），enqueue 去重 O(1)。
   *  与 jobs 数组同步维护；队列大时（整目录导入几千文件）原来的
   *  q.jobs.find/some 线性查找会退化到 O(n²)。 */
  pendingJobs: Map<string, Job>;
  /** 每个 name 的待处理 job 计数（任意 op），reconcile 的占用判断 O(1)。 */
  pendingNameCounts: Map<string, number>;
}

const _queues = new Map<string, Queue>();

/** reconcile 进行中的去重：并发 search / status 查询共享同一次扫描。 */
const _reconcileInFlight = new Map<string, Promise<SpaceLibraryReconcileResult>>();

export const spaceLibraryEvents = new EventEmitter();
spaceLibraryEvents.setMaxListeners(50);

function emit(ev: SpaceLibraryStatusEvent): void {
  spaceLibraryEvents.emit('status', ev);
}

function safeSpaceId(spaceId: string): string {
  if (typeof spaceId !== 'string' || !spaceId) throw new Error('spaceId required');
  if (spaceId.includes('/') || spaceId.includes('\\') || spaceId.includes('\x00') || spaceId === '.' || spaceId === '..') {
    throw new Error('invalid spaceId');
  }
  return spaceId;
}

function safeFileName(name: string): string {
  if (typeof name !== 'string') throw new Error('filename required');
  const s = name.trim().replace(/\\/g, '/');
  if (!s || s === '.' || s === '..') throw new Error('invalid filename');
  if (s.includes('\x00') || s.startsWith('/') || path.isAbsolute(s)) {
    throw new Error('invalid filename');
  }
  const parts = s.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || part.length > MAX_PATH_SEGMENT_LEN)) {
    throw new Error('invalid filename');
  }
  return parts.join('/');
}

function resolveSpaceFilePath(uid: string, spaceId: string, relPath: string): string {
  const root = path.resolve(spaceFilesDir(uid, spaceId));
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
  return abs;
}

function kindFor(name: string): SpaceLibraryKind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.docm') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet';
  if (ext === '.pptx' || ext === '.pptm') return 'presentation';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

function storeFor(uid: string, spaceId: string): vs.VecStore {
  const sid = safeSpaceId(spaceId);
  return vs.openVecStore(path.dirname(spaceLibraryVectorDbPath(uid, sid)));
}

function queueFor(uid: string): Queue {
  let q = _queues.get(uid);
  if (!q) {
    q = { jobs: [], running: false, scheduled: false, activeKeys: new Map(), pendingJobs: new Map(), pendingNameCounts: new Map() };
    _queues.set(uid, q);
  }
  return q;
}

function pendingJobKey(spaceId: string, name: string, op: Job['op']): string {
  return `${jobKey(spaceId, name)}|${op}`;
}

function addPendingJob(q: Queue, job: Job): void {
  q.pendingJobs.set(pendingJobKey(job.spaceId, job.name, job.op), job);
  q.pendingNameCounts.set(jobKey(job.spaceId, job.name), (q.pendingNameCounts.get(jobKey(job.spaceId, job.name)) || 0) + 1);
}

function removePendingJob(q: Queue, job: Job): void {
  q.pendingJobs.delete(pendingJobKey(job.spaceId, job.name, job.op));
  const key = jobKey(job.spaceId, job.name);
  const count = q.pendingNameCounts.get(key) || 0;
  if (count <= 1) q.pendingNameCounts.delete(key);
  else q.pendingNameCounts.set(key, count - 1);
}

function retainActiveKey(q: Queue, key: string): void {
  q.activeKeys.set(key, (q.activeKeys.get(key) || 0) + 1);
}

function releaseActiveKey(q: Queue, key: string): void {
  const count = q.activeKeys.get(key) || 0;
  if (count <= 1) q.activeKeys.delete(key);
  else q.activeKeys.set(key, count - 1);
}

export function enqueue(
  uid: string,
  spaceId: string,
  name: string,
  op: 'upsert' | 'delete' = 'upsert',
  opts: { force?: boolean; reason?: Job['reason']; attempt?: number } = {},
): void {
  let sid: string;
  let safeName: string;
  try {
    sid = safeSpaceId(spaceId);
    safeName = safeFileName(name);
  } catch { return; }
  if (op === 'upsert' && !kindFor(safeName)) return;
  const q = queueFor(uid);
  const duplicate = q.pendingJobs.get(pendingJobKey(sid, safeName, op));
  if (duplicate) {
    if (opts.force) duplicate.force = true;
    return;
  }
  const job: Job = {
    spaceId: sid,
    name: safeName,
    op,
    force: opts.force === true,
    enqueuedAt: Date.now(),
    reason: opts.reason || (opts.force ? 'manual' : 'mutation'),
    attempt: Math.max(1, Math.round(opts.attempt || 1)),
  };
  q.jobs.push(job);
  addPendingJob(q, job);
  if (op === 'upsert') {
    const kind = kindFor(safeName);
    if (kind) emit({ userId: uid, spaceId: sid, name: safeName, relPath: safeName, status: 'pending', kind });
  }
  scheduleRunQueue(uid);
}

function scheduleRunQueue(uid: string): void {
  const q = queueFor(uid);
  if (q.running || q.scheduled) return;
  q.scheduled = true;
  setImmediate(() => {
    q.scheduled = false;
    void runQueue(uid);
  });
}

async function runQueue(uid: string): Promise<void> {
  const q = queueFor(uid);
  if (q.running) return;
  q.running = true;
  const batch = createLibraryVectorizeBatch('space');
  try {
    while (q.jobs.length) {
      const job = q.jobs.shift()!;
      removePendingJob(q, job);
      const key = jobKey(job.spaceId, job.name);
      retainActiveKey(q, key);
      try {
        if (job.op === 'delete') await processDelete(uid, job.spaceId, job.name);
        else await processUpsert(uid, job, batch);
      } catch (err) {
        log.warn('project library job failed unexpectedly', {
          user_id: maskId(uid),
          space_id: maskId(job.spaceId),
          path: logPathRef(job.name),
          error: logErrorSummary(err),
        });
        await failUnexpectedJob(uid, job, err, batch);
      } finally {
        releaseActiveKey(q, key);
      }
    }
  } finally {
    q.running = false;
    const summary = flushLibraryVectorizeBatch(batch);
    if (summary) {
      log.info('project library vectorization batch complete', {
        user_id: maskId(uid),
        result: summary.result,
        files: summary.file_count,
        succeeded: summary.succeeded_count,
        failed: summary.failed_count,
        timeouts: summary.timeout_count,
        recovered: summary.recovered_count,
        retries: summary.retry_count,
        duration_ms: summary.duration_ms,
        max_queue_wait_ms: summary.max_queue_wait_ms,
      });
    }
  }
}

function jobKey(spaceId: string, name: string): string {
  return `${spaceId}\x00${name}`;
}

async function processDelete(uid: string, spaceId: string, name: string): Promise<void> {
  await storeFor(uid, spaceId).deleteFile(name);
  emit({ userId: uid, spaceId, name, relPath: name, status: 'deleted' });
}

async function processUpsert(
  uid: string,
  job: Job,
  batch: LibraryVectorizeBatch,
): Promise<void> {
  const { spaceId, name } = job;
  const force = job.force === true;
  const startedAt = Date.now();
  const kind = kindFor(name);
  if (!kind) return;

  const store = storeFor(uid, spaceId);
  const abs = resolveSpaceFilePath(uid, spaceId, name);
  let stat: fs.Stats;
  try { stat = await fsp.stat(abs); }
  catch {
    await store.deleteFile(name);
    emit({ userId: uid, spaceId, name, relPath: name, status: 'deleted', kind });
    return;
  }
  if (!stat.isFile()) {
    await store.deleteFile(name);
    emit({ userId: uid, spaceId, name, relPath: name, status: 'deleted', kind });
    return;
  }

  const buf = await fsp.readFile(abs);
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const existing = store.getFile(name);
  if (!force && existing && existing.sha1 === sha1 && existing.status === 'ready') {
    emit({ userId: uid, spaceId, name, relPath: name, status: 'ready', kind, chunks: existing.chunks });
    return;
  }

  const isEmpty = stat.size === 0 || (kind === 'text' && buf.toString('utf8').trim() === '');
  if (isEmpty) {
    await store.upsertFile({
      id: name,
      kind,
      bytes: stat.size,
      mtime: stat.mtimeMs / 1000,
      sha1,
      chunks: [],
    });
    emit({ userId: uid, spaceId, name, relPath: name, status: 'ready', kind, chunks: 0, stage: 'persist' });
    recordVectorizeResult(batch, job, startedAt, {
      result: 'success', stage: 'persist', chunks: 0,
    });
    log.debug('skipped empty project library file', {
      user_id: maskId(uid),
      space_id: maskId(spaceId),
      path: logPathRef(name),
      kind,
    });
    return;
  }

  await store.setFileStatus(name, 'processing', {
    kind,
    bytes: stat.size,
    mtime: stat.mtimeMs / 1000,
    sha1,
  });
  emit({ userId: uid, spaceId, name, relPath: name, status: 'processing', kind, stage: 'extract' });

  let currentStage: 'extract' | 'embed' | 'persist' = 'extract';
  try {
    const extractOperation = fileToChunks({
      kind,
      buf,
      imageTitle: name,
      ...(kind === 'image' ? { imageDescriber: (b: Buffer) => describeImage(uid, name, b) } : {}),
    });
    const chunks = await withOperationTimeout(extractOperation, {
      timeoutMs: EXTRACT_TIMEOUT_MS,
      code: 'E_LIBRARY_EXTRACT_TIMEOUT',
      stage: 'extract',
      onLateSettlement: (late) => scheduleLateRecovery(uid, job, sha1, late, 'extract'),
    });
    if (!chunks.length) throw Object.assign(new Error('fileToChunks returned zero chunks'), { stage: 'extract' });

    currentStage = 'embed';
    emit({ userId: uid, spaceId, name, relPath: name, status: 'processing', kind, stage: 'embed' });
    const embedOperation = kbEmbed.embedTexts(chunks.map((chunk) => chunk.content));
    const vectors = await withOperationTimeout(embedOperation, {
      timeoutMs: EMBED_TIMEOUT_MS,
      code: 'E_LIBRARY_EMBED_TIMEOUT',
      stage: 'embed',
      onLateSettlement: (late) => scheduleLateRecovery(uid, job, sha1, late, 'embed'),
    });
    currentStage = 'persist';
    await store.upsertFile({
      id: name,
      kind,
      bytes: stat.size,
      mtime: stat.mtimeMs / 1000,
      sha1,
      chunks: chunks.map((chunk, index) => ({
        title: chunk.title,
        content: chunk.content,
        embedding: vectors[index],
      })),
    });
    emit({ userId: uid, spaceId, name, relPath: name, status: 'ready', kind, chunks: chunks.length, stage: 'persist' });
    recordVectorizeResult(batch, job, startedAt, {
      result: 'success', stage: 'persist', chunks: chunks.length,
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    const stage = err instanceof OperationTimeoutError
      ? (err.stage as 'extract' | 'embed')
      : currentStage;
    const errorCode = operationErrorCode(
      err,
      stage === 'extract'
        ? 'E_LIBRARY_EXTRACT_FAILED'
        : stage === 'embed'
          ? 'E_LIBRARY_EMBED_FAILED'
          : 'E_LIBRARY_PERSIST_FAILED',
    );
    await store.setFileStatus(name, 'failed', { error: msg });
    emit({ userId: uid, spaceId, name, relPath: name, status: 'failed', kind, error: msg, stage, errorCode });
    recordVectorizeResult(batch, job, startedAt, {
      result: 'failure', stage, errorCode,
    });
    log.warn('project library vectorization failed', {
      user_id: maskId(uid),
      space_id: maskId(spaceId),
      path: logPathRef(name),
      kind,
      stage,
      error_code: errorCode,
      error: logErrorSummary(err),
      duration_ms: Date.now() - startedAt,
      queue_wait_ms: startedAt - job.enqueuedAt,
      attempt: job.attempt,
    });
  }
}

function recordVectorizeResult(
  batch: LibraryVectorizeBatch,
  job: Job,
  startedAt: number,
  terminal: {
    result: 'success' | 'failure';
    stage: 'extract' | 'embed' | 'persist';
    chunks?: number;
    errorCode?: string;
  },
): void {
  recordLibraryVectorizeOutcome(batch, {
    result: terminal.result,
    stage: terminal.stage,
    reason: job.reason,
    chunks: terminal.chunks || 0,
    durationMs: Math.max(0, Date.now() - startedAt),
    queueWaitMs: Math.max(0, startedAt - job.enqueuedAt),
    errorCode: terminal.errorCode || '',
    attempt: job.attempt,
  });
}

function scheduleLateRecovery<T>(
  uid: string,
  job: Job,
  expectedSha1: string,
  late: Promise<T>,
  stage: 'extract' | 'embed',
): void {
  const queue = queueFor(uid);
  const key = jobKey(job.spaceId, job.name);
  retainActiveKey(queue, key);
  void late.then(() => {
    if (job.attempt >= 2) return;
    const row = storeFor(uid, job.spaceId).getFile(job.name);
    if (!row || row.status !== 'failed' || row.sha1 !== expectedSha1) return;
    log.info('timed-out project library operation settled; scheduling one recovery attempt', {
      user_id: maskId(uid),
      space_id: maskId(job.spaceId),
      path: logPathRef(job.name),
      stage,
      attempt: job.attempt + 1,
    });
    enqueue(uid, job.spaceId, job.name, 'upsert', {
      reason: 'late_recovery',
      attempt: job.attempt + 1,
    });
  }).catch((err) => {
    log.info('timed-out project library operation eventually failed', {
      user_id: maskId(uid),
      space_id: maskId(job.spaceId),
      path: logPathRef(job.name),
      stage,
      error: logErrorSummary(err),
    });
  }).finally(() => {
    releaseActiveKey(queue, key);
  });
}

async function failUnexpectedJob(
  uid: string,
  job: Job,
  err: unknown,
  batch: LibraryVectorizeBatch,
): Promise<void> {
  if (job.op !== 'upsert') return;
  const store = storeFor(uid, job.spaceId);
  const row = store.getFile(job.name);
  const kind = kindFor(job.name) || row?.kind;
  const msg = (err as Error)?.message || String(err);
  const errorCode = operationErrorCode(err, 'E_LIBRARY_JOB_FAILED');
  try { await store.setFileStatus(job.name, 'failed', { error: msg }); }
  catch { /* primary log already records the storage failure */ }
  emit({
    userId: uid,
    spaceId: job.spaceId,
    name: job.name,
    relPath: job.name,
    status: 'failed',
    error: msg,
    ...(kind ? { kind } : {}),
    stage: 'queue',
    errorCode,
  });
  if (kind) {
    recordVectorizeResult(batch, job, Date.now(), {
      result: 'failure', stage: 'persist', errorCode,
    });
  }
}

async function describeImage(userId: string, sourceName: string, raw: Buffer): Promise<string> {
  return describeLibraryImage(userId, sourceName, raw, { sessionPrefix: 'extract-img-space' });
}

export async function reconcile(uid: string, spaceId: string): Promise<SpaceLibraryReconcileResult> {
  const sid = safeSpaceId(spaceId);
  const key = `${uid}:${sid}`;
  const existing = _reconcileInFlight.get(key);
  if (existing) return existing;
  const run = reconcileImpl(uid, sid).then(
    (result) => {
      if (_reconcileInFlight.get(key) === run) _reconcileInFlight.delete(key);
      return result;
    },
    (err) => {
      if (_reconcileInFlight.get(key) === run) _reconcileInFlight.delete(key);
      throw err;
    },
  );
  _reconcileInFlight.set(key, run);
  return run;
}

async function reconcileImpl(uid: string, spaceId: string): Promise<SpaceLibraryReconcileResult> {
  const startedAt = Date.now();
  const sid = safeSpaceId(spaceId);
  if (!await spaceExists(uid, sid)) return { enqueuedUpsert: 0, enqueuedDelete: 0, unchanged: 0 };

  const root = spaceFilesDir(uid, sid);
  const store = storeFor(uid, sid);
  const indexedRows = store.listFiles();
  const indexedByPath = new Map(indexedRows.map((row) => [row.rel_path, row]));
  const scan = await scanSpaceFiles(root, indexedByPath);
  const onDisk = scan.files;
  let enqueuedUpsert = 0;
  let enqueuedDelete = 0;
  let unchanged = 0;
  let recoveredProcessing = 0;
  const queue = queueFor(uid);

  for (const [name, meta] of onDisk) {
    const existing = indexedByPath.get(name);
    const key = jobKey(sid, name);
    const ownedByQueue = queue.activeKeys.has(key)
      || queue.pendingNameCounts.has(key);
    const orphanedProcessing = existing?.status === 'processing'
      && !ownedByQueue;
    if (
      !existing
      || existing.sha1 !== meta.sha1
      || (!ownedByQueue && (existing.status === 'failed' || existing.status === 'pending'))
      || orphanedProcessing
    ) {
      if (orphanedProcessing && existing) {
        recoveredProcessing += 1;
        await store.setFileStatus(name, 'pending', { error: null });
        log.warn('recovered orphaned processing project library row', {
          user_id: maskId(uid),
          space_id: maskId(sid),
          path: logPathRef(name),
          stale_ms: Math.max(0, Date.now() - existing.updated_at * 1000),
        });
      }
      enqueue(uid, sid, name, 'upsert', {
        reason: orphanedProcessing ? 'crash_recovery' : 'reconcile',
      });
      enqueuedUpsert += 1;
    } else {
      unchanged += 1;
    }
  }

  if (scan.complete) {
    for (const row of indexedRows) {
      if (!onDisk.has(row.rel_path)) {
        enqueue(uid, sid, row.rel_path, 'delete');
        enqueuedDelete += 1;
      }
    }
  } else {
    log.warn('project library reconcile snapshot incomplete; skipped destructive deletes', {
      user_id: maskId(uid),
      space_id: maskId(sid),
      discovered: onDisk.size,
      duration_ms: Date.now() - startedAt,
    });
  }

  if (enqueuedUpsert || enqueuedDelete) {
    log.info('project library reconcile queued work', {
      user_id: maskId(uid),
      space_id: maskId(sid),
      upsert: enqueuedUpsert,
      delete: enqueuedDelete,
      unchanged,
      recovered_processing: recoveredProcessing,
      duration_ms: Date.now() - startedAt,
    });
  }
  return {
    enqueuedUpsert,
    enqueuedDelete,
    unchanged,
    recoveredProcessing,
    ...(!scan.complete ? { incomplete: true } : {}),
  };
}

async function scanSpaceFiles(
  root: string,
  indexedByPath: ReadonlyMap<string, vs.VecFileRow>,
): Promise<{
  files: Map<string, { sha1: string; bytes: number; mtime: number }>;
  complete: boolean;
}> {
  const out = new Map<string, { sha1: string; bytes: number; mtime: number }>();
  const stack = [root];
  let complete = true;
  while (stack.length) {
    const dir = stack.pop()!;
    let items: fs.Dirent[];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      continue;
    }
    for (const entry of items) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!kindFor(rel)) continue;
      try {
        const stat = await fsp.stat(abs);
        const mtime = stat.mtimeMs / 1000;
        const existing = indexedByPath.get(rel);
        if (
          existing?.sha1
          && existing.bytes === stat.size
          && Math.abs(existing.mtime - mtime) < 0.001
        ) {
          out.set(rel, { sha1: existing.sha1, bytes: stat.size, mtime });
          continue;
        }
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(abs);
        for await (const chunk of stream) hash.update(chunk as Buffer);
        out.set(rel, { sha1: hash.digest('hex'), bytes: stat.size, mtime });
      } catch (err) {
        // A disappearing file is a valid absence. Permission and transient I/O
        // failures make the snapshot unsafe for delete decisions.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      }
    }
  }
  return { files: out, complete };
}

export async function search(
  uid: string,
  spaceId: string,
  queryVec: number[] | Float32Array,
  opts: vs.VecSearchOpts = {},
): Promise<vs.VecSearchHit[]> {
  // 搜索不再等待全量 reconcile：应用内写入已走 enqueue 即时入队，向量库
  // 即为最新；外部直接改动的文件由后台 reconcile 收敛——本次调用顺手
  // 触发（in-flight 合并），下一次搜索可见。避免每次检索都被目录遍历 +
  // sha1 流式哈希挡在关键路径上。
  void reconcile(uid, spaceId).catch(() => { /* 后台收敛失败不阻断搜索 */ });
  return storeFor(uid, spaceId).search(queryVec, opts);
}

export function getFileByPath(uid: string, spaceId: string, relPath: string): vs.VecFileRow | null {
  return storeFor(uid, spaceId).getFile(relPath);
}

export function listFiles(uid: string, spaceId: string): vs.VecFileRow[] {
  return storeFor(uid, spaceId).listFiles();
}

export function readFileChunks(uid: string, spaceId: string, relPath: string): Array<{ chunk_idx: number; title: string | null; content: string }> {
  return storeFor(uid, spaceId).readFileChunks(relPath);
}

export function statusSummary(uid: string, spaceId: string): { total: number; ready: number; processing: number; pending: number; failed: number } {
  return storeFor(uid, spaceId).statusSummary();
}

export async function drain(uid: string): Promise<void> {
  const q = queueFor(uid);
  while (q.scheduled || q.running || q.jobs.length) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function _resetQueuesForTests(): void {
  _queues.clear();
  _reconcileInFlight.clear();
  spaceLibraryEvents.removeAllListeners();
  spaceLibraryEvents.setMaxListeners(50);
}
