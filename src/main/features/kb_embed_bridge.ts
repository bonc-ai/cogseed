/**
 * Embed 子进程桥接 —— 把向量化请求转发给隔离的 ONNX 推理进程。
 *
 * 与 cogseed_runtime/worker-process 同款 spawn 模式：
 *   spawn(process.execPath, [bin/cogseed-embed-worker.cjs], ELECTRON_RUN_AS_NODE)
 * 协议见 bin/cogseed-embed-worker.cjs / kb_embed_worker_entry.ts。
 *
 * 桥接只负责进程生命周期与请求多路复用；失败时由调用方（kb_embed.ts）
 * 回退到进程内推理，保证功能永不因 worker 不可用而丢失。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { PC_ROOT, embeddingModelDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('kb_embed_bridge');

export interface EmbedBridgeChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
}

export interface EmbedBridge {
  /** 子进程就绪（模型加载完成）。reject 表示不可用，调用方应回退。 */
  ready: Promise<void>;
  embedTexts(texts: string[]): Promise<number[][]>;
  close(): void;
}

/** 握手超时：模型加载 1-2s，留足余量。 */
const READY_TIMEOUT_MS = 20_000;
/** 单请求超时：批量回填可能较长；超时视为 worker 卡死，杀进程并失败。 */
const REQUEST_TIMEOUT_MS = 10 * 60_000;

function defaultSpawnWorker(): EmbedBridgeChild {
  const pcDir = PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
  const script = path.join(pcDir, 'bin', 'cogseed-embed-worker.cjs');
  return spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      COGSEED_PC_DIR: pcDir,
      COGSEED_EMBED_MODEL_DIR: embeddingModelDir(),
    },
  }) as ChildProcessWithoutNullStreams;
}

interface PendingRequest {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function createEmbedBridge(options: { spawnWorker?: () => EmbedBridgeChild } = {}): EmbedBridge {
  const spawnWorker = options.spawnWorker || defaultSpawnWorker;
  let child: EmbedBridgeChild | null = null;
  let seq = 0;
  let closed = false;
  let failed = false;
  const pending = new Map<number, PendingRequest>();

  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const fail = (err: Error): void => {
    if (failed) return;
    failed = true;
    readyReject(err);
    for (const p of Array.from(pending.values())) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  const handleLine = (line: string): void => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      readyResolve();
      return;
    }
    if (msg.type === 'fatal') {
      fail(new Error(`embed worker fatal: ${String(msg.error || 'unknown')}`));
      return;
    }
    const id = Number(msg.id);
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (msg.type === 'vectors' && Array.isArray(msg.vectors)) {
      p.resolve(msg.vectors as number[][]);
    } else if (msg.type === 'pong') {
      p.resolve([]);
    } else {
      p.reject(new Error(String(msg.error || `unexpected embed worker response: ${String(msg.type)}`)));
    }
  };

  const readyTimer = setTimeout(() => {
    fail(new Error('embed worker handshake timeout'));
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }, READY_TIMEOUT_MS);
  void ready.then(
    () => clearTimeout(readyTimer),
    () => clearTimeout(readyTimer),
  );

  try {
    child = spawnWorker();
    child.on('exit', (code) => {
      if (!closed) fail(new Error(`embed worker exited (code ${String(code)})`));
    });
    child.on('error', (err) => fail(err as Error));
    createInterface({ input: child.stdout }).on('line', handleLine);
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = String(chunk).trim();
        if (text) log.warn('embed worker stderr', { text: text.slice(0, 500) });
      });
    }
  } catch (err) {
    fail(err as Error);
    child = null;
  }

  function embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) return Promise.resolve([]);
    if (!child || failed) return Promise.reject(new Error('embed worker unavailable'));
    const id = ++seq;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error('embed worker request timeout');
        try { child?.kill(); } catch { /* already gone */ }
        fail(err);
        reject(err);
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ type: 'embed', id, texts })}\n`);
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(readyTimer);
    fail(new Error('embed worker closed'));
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child = null;
    }
  }

  return { ready, embedTexts, close };
}
