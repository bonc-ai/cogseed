/**
 * Embed 子进程入口（隔离的 ONNX 推理进程）。
 *
 * 背景：fastembed/onnxruntime 的推理是同步原生计算，跑在主进程里会成批
 * 占用事件循环（大库回填/建索引期间界面卡顿）。worker_threads 方案曾
 * SIGSEGV（两个线程同时初始化 onnxruntime 的原生资源），按规范改用
 * 独立子进程隔离（AGENTS.md：child-process isolation）。
 *
 * 协议（stdin/stdout JSONL）：
 *   → {"type":"ping","id":n}
 *   ← {"type":"pong","id":n}
 *   → {"type":"embed","id":n,"texts":["..."]}
 *   ← {"type":"vectors","id":n,"vectors":[[...]]}
 *   ← {"type":"error","id":n,"error":"..."}
 * 启动完成后输出 {"type":"ready"}；模型初始化失败输出 {"type":"fatal",...} 并退出。
 * 请求严格串行处理（单一 ONNX session 不允许并发推理）。
 *
 * 模型目录由父进程经 COGSEED_EMBED_MODEL_DIR 传入；本入口不 import 任何
 * 应用模块（paths/logger 等），保持子进程依赖面最小。
 */

import { createInterface } from 'node:readline';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null;

const EMBED_BATCH_SIZE = 32;

function respond(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function initEmbedder(): Promise<void> {
  if (embedder) return;
  const modelDir = process.env.COGSEED_EMBED_MODEL_DIR || '';
  // 与主进程 kb_embed.ts 同口径：用 CJS 入口 require（fastembed 的 ESM
  // 入口在 tar@7 下会坏）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { FlagEmbedding, EmbeddingModel } = require('fastembed') as typeof import('fastembed');
  embedder = await FlagEmbedding.init({
    model: EmbeddingModel.BGESmallZH,
    cacheDir: modelDir,
    showDownloadProgress: false,
  });
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  await initEmbedder();
  const out: number[][] = [];
  const gen = embedder.embed(texts, EMBED_BATCH_SIZE);
  for await (const batch of gen) {
    for (const v of batch) {
      out.push(Array.isArray(v) ? v : Array.from(v as ArrayLike<number>));
    }
  }
  if (out.length !== texts.length) {
    throw new Error(`embed count mismatch: ${out.length} vectors vs ${texts.length} texts`);
  }
  return out;
}

// 请求严格串行：readline 的 async handler 不会被等待，必须自己接链，
// 否则并发推理会打到同一个 ONNX session 上（正是当年线程方案崩溃的形态）。
let chain: Promise<void> = Promise.resolve();

async function handleLine(line: string): Promise<void> {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    respond({ type: 'error', id: null, error: 'invalid json' });
    return;
  }
  if (!req || typeof req !== 'object') return;
  if (req.type === 'ping') {
    respond({ type: 'pong', id: req.id ?? null });
    return;
  }
  if (req.type !== 'embed') {
    respond({ type: 'error', id: req.id ?? null, error: `unknown request type: ${String(req.type)}` });
    return;
  }
  const texts = Array.isArray(req.texts) ? req.texts.filter((t: unknown) => typeof t === 'string') : [];
  try {
    const vectors = await embedTexts(texts);
    respond({ type: 'vectors', id: req.id ?? null, vectors });
  } catch (err) {
    respond({ type: 'error', id: req.id ?? null, error: (err as Error)?.message || String(err) });
  }
}

async function main(): Promise<void> {
  try {
    await initEmbedder();
    respond({ type: 'ready' });
  } catch (err) {
    respond({ type: 'fatal', error: (err as Error)?.message || String(err) });
    process.exitCode = 1;
    return;
  }
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    chain = chain
      .then(() => handleLine(line))
      .catch((err) => {
        respond({ type: 'error', id: null, error: (err as Error)?.message || String(err) });
      });
  });
}

void main();
