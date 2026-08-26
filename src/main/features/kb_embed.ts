/**
 * Singleton wrapper around `fastembed`'s FlagEmbedding. Initialized lazily on
 * the first `embed()` call — model load is ~1-2s (tokenizer + ONNX session).
 * Subsequent calls reuse the session.
 *
 * Embedder is global (not per-uid): the model is identical for every user,
 * just a shared inference engine. There's no per-uid state.
 *
 * A previous iteration spawned 2 `worker_threads` each holding its own
 * FlagEmbedding to get real parallelism. That crashed hard (SIGSEGV) during
 * vectorization — two `worker_threads` both racing onnxruntime-node's native
 * init (OpenMP threadpool + native allocators) is a known-unsafe pattern.
 * Reverted to single-session; parallelism lives on the cross-file pipeline
 * in `kb_indexer.ts` instead. If we want true embed parallelism in future,
 * use `child_process` (separate OS process per session) rather than threads.
 *
 * Testability: the whole module is mock-friendly via `vi.mock('../features/kb_embed')`.
 * Tests should mock to avoid the 95MB model load on every test run.
 */

import { Mutex } from 'async-mutex';

import { embeddingModelDir } from '../paths';
import { createLogger } from '../logger';
import { createEmbedBridge, type EmbedBridge } from './kb_embed_bridge';

const log = createLogger('kb_embed');

/**
 * Chunks per forward pass. Kept at 32 — previously tried 64 and hit a hard
 * onnxruntime-node crash (`SIGTRAP` inside `BFCArena::AllocateRawInternal`
 * during the transformer attention compute) because attention memory scales
 * `batch × seq²`: doubling the batch doubles the peak allocation, which
 * pushed it past what Electron's process could service. 32 is the known-
 * stable ceiling for bge-small-zh on desktop hardware.
 */
const EMBED_BATCH_SIZE = 32;

// ── 隔离子进程优先，进程内回退 ─────────────────────────────────────────
// ONNX 推理是同步原生计算，放主进程会成批占用事件循环。优先走独立子进程
// （bin/cogseed-embed-worker.cjs），worker 不可用（spawn 失败 / 握手超时 /
// 中途崩溃 / 请求超时）时自动回退到进程内推理——功能永不因 worker 缺失
// 而丢失，回退后本进程内只发生一次（_workerFailed 粘性标记）。
let _bridge: EmbedBridge | null = null;
let _workerFailed = false;
const _bridgeStartLock = new Mutex();

async function ensureBridge(): Promise<EmbedBridge | null> {
  if (_workerFailed) return null;
  if (_bridge) return _bridge;
  return _bridgeStartLock.runExclusive(async () => {
    if (_workerFailed) return null;
    if (_bridge) return _bridge;
    try {
      const bridge = createEmbedBridge();
      await bridge.ready;
      _bridge = bridge;
      log.info('embed worker ready');
      return bridge;
    } catch (err) {
      _workerFailed = true;
      log.warn('embed worker unavailable; falling back to in-process embedding', {
        error: (err as Error)?.message || String(err),
      });
      return null;
    }
  });
}

async function embedViaWorker(texts: string[]): Promise<number[][]> {
  const bridge = await ensureBridge();
  if (!bridge) throw new Error('embed worker unavailable');
  return bridge.embedTexts(texts);
}

function dropBridge(): void {
  if (!_bridge) return;
  try { _bridge.close(); } catch { /* already gone */ }
  _bridge = null;
}

// Loaded lazily so test code that mocks this module never touches fastembed.
// Use require() deliberately: fastembed's ESM entry imports `tar` as a default
// export, which breaks with tar@7. The CJS entry stays compatible.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embedder: any = null;
const _initLock = new Mutex();

async function initEmbedder(): Promise<void> {
  if (_embedder) return;
  await _initLock.runExclusive(async () => {
    if (_embedder) return;
    const started = Date.now();
    const { FlagEmbedding, EmbeddingModel } = require('fastembed') as typeof import('fastembed');
    _embedder = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallZH,
      cacheDir: embeddingModelDir(),
      // Model files come bundled with the installer (see resources/embedding-model);
      // any attempt to download is a bug — never silently spinner-download.
      showDownloadProgress: false,
    });
    log.info(`initialized in ${Date.now() - started}ms (model=bge-small-zh-v1.5, dim=512)`);
  });
}

async function embedInProcess(texts: string[]): Promise<number[][]> {
  await initEmbedder();
  const out: number[][] = [];
  const gen = _embedder.embed(texts, EMBED_BATCH_SIZE);
  for await (const batch of gen) {
    // Each yield: batch of TypedArray / number[] embeddings. Normalise to plain
    // number[] so downstream encoding to Float32Array is unambiguous.
    for (const v of batch) {
      out.push(Array.isArray(v) ? v : Array.from(v as ArrayLike<number>));
    }
    // 回退路径的批次间让出主循环（子进程路径不需要）：推理是同步原生
    // 计算，长文本回填时连续占用事件循环会让 IPC/UI 排队。每批之间让
    // 一次 macrotask 轮转；结果完全一致。
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (out.length !== texts.length) {
    throw new Error(`embed count mismatch: ${out.length} vectors vs ${texts.length} texts`);
  }
  return out;
}

/**
 * Produce a 512-dim unit-normalised embedding for each input text. Preserves
 * input order 1:1. Throws on empty input or model load failure.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  if (!_workerFailed) {
    try {
      return await embedViaWorker(texts);
    } catch (err) {
      // worker 中途失效（崩溃/请求超时）：本次请求进程内重试一次保证
      // 结果正确，之后粘性回退到进程内路径。
      _workerFailed = true;
      dropBridge();
      log.warn('embed worker failed mid-flight; retrying in-process', {
        error: (err as Error)?.message || String(err),
      });
    }
  }
  return embedInProcess(texts);
}

/** Embed a single query. Shortcut for `embedTexts([q])[0]`. */
export async function embedQuery(query: string): Promise<number[]> {
  const vs = await embedTexts([query]);
  return vs[0];
}

/** Close + release the ONNX session. Should be called on app shutdown. */
export function closeEmbedder(): void {
  dropBridge();
  if (!_embedder) return;
  try {
    // fastembed doesn't expose a release API; we just drop the reference and
    // let GC clean up the ONNX InferenceSession. onnxruntime-node has a known
    // mutex race on process-exit teardown — harmless but noisy.
    _embedder = null;
  } catch (err) {
    log.warn(`close: ${(err as Error).message}`);
  }
}
