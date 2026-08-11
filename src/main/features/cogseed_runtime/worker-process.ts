import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { PC_ROOT, WS_ROOT } from '../../paths';
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import {
  MATE_AGENT_RUNTIME_PROTOCOL_VERSION,
  isRuntimeTerminalEvent,
  type RuntimeEventEnvelope,
  type RuntimeHostToolCall,
  type RuntimeHostToolResult,
  type RuntimeHelloResponse,
  type RuntimeRunRequest,
} from './protocol';

const log = createLogger('cogseed-runtime:worker-process');

export interface RuntimeWorkerChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off?(event: string, listener: (...args: any[]) => void): this;
}

export interface RuntimeWorkerService {
  run(request: RuntimeRunRequest, opts?: { signal?: AbortSignal | null }): AsyncGenerator<RuntimeEventEnvelope, void, unknown>;
  shutdown(): Promise<void>;
}

export interface RuntimeHostToolHandlerContext {
  request: RuntimeRunRequest;
  signal: AbortSignal;
}

export type RuntimeHostToolHandler = (
  call: RuntimeHostToolCall,
  context: RuntimeHostToolHandlerContext,
) => Promise<{ content: string; isError?: boolean }>;

export interface RuntimeWorkerServiceOptions {
  spawnWorker?: () => RuntimeWorkerChild;
  handshakeTimeoutMs?: number;
  hostToolHandler?: RuntimeHostToolHandler;
  onRunSettled?: (request: RuntimeRunRequest) => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
}


interface PendingRun {
  request: RuntimeRunRequest;
  queue: RuntimeEventEnvelope[];
  waiters: Array<() => void>;
  done: boolean;
  error: Error | null;
  hostAbort: AbortController;
}

function defaultSpawnWorker(): RuntimeWorkerChild {
  const pcDir = PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
  const script = path.join(pcDir, 'bin', 'cogseed-runtime-worker.cjs');
  return spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ORKAS_PC_DIR: pcDir,
      ORKAS_WORKSPACE_ROOT: WS_ROOT,
    },
  });
}

function writeJsonl(child: RuntimeWorkerChild, value: unknown): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

export function createRuntimeWorkerService(options: RuntimeWorkerServiceOptions = {}): RuntimeWorkerService {
  const spawnWorker = options.spawnWorker || defaultSpawnWorker;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  let child: RuntimeWorkerChild | null = null;
  let handshake: Promise<void> | null = null;
  const pending = new Map<string, PendingRun>();
  let helloWaiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];

  function wake(run: PendingRun): void {
    for (const waiter of run.waiters.splice(0)) waiter();
  }

  function rejectAll(error: Error): void {
    for (const waiter of helloWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const run of pending.values()) {
      run.error = error;
      run.done = true;
      wake(run);
    }
    pending.clear();
  }

  function handleMessage(parsed: any): void {
    if (parsed.type === 'hello') {
      const waiters = helloWaiters.splice(0);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        if (parsed.protocol_version !== MATE_AGENT_RUNTIME_PROTOCOL_VERSION) {
          waiter.reject(new Error(`Mate Agent Runtime protocol version mismatch: ${parsed.protocol_version}`));
        } else {
          waiter.resolve();
        }
      }
      return;
    }
    if (!parsed.request_id || !pending.has(parsed.request_id)) return;
    const run = pending.get(parsed.request_id)!;
    if (parsed.type === 'host_tool_call') {
      const call = parsed as RuntimeHostToolCall;
      const target = child;
      if (!target) return;
      void (async () => {
        let result: { content: string; isError?: boolean };
        try {
          result = options.hostToolHandler
            ? await options.hostToolHandler(call, { request: run.request, signal: run.hostAbort.signal })
            : { content: '[E_RUNTIME_HOST_TOOL_DISABLED] Mate host tools are unavailable', isError: true };
        } catch (error) {
          result = { content: error instanceof Error ? error.message : String(error), isError: true };
        }
        const response: RuntimeHostToolResult = {
          type: 'host_tool_result', request_id: call.request_id, runtime_session_id: call.runtime_session_id,
          call_id: call.call_id, content: result.content, ...(result.isError ? { is_error: true } : {}),
        };
        if (child === target && !target.killed) writeJsonl(target, response);
      })();
      return;
    }
    run.queue.push(parsed as RuntimeEventEnvelope);
    if (isRuntimeTerminalEvent(parsed as RuntimeEventEnvelope)) {
      run.done = true;
      pending.delete(parsed.request_id);
    }
    wake(run);
  }

  function attach(next: RuntimeWorkerChild): void {
    child = next;
    const rl = createInterface({ input: next.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try { handleMessage(JSON.parse(line)); }
      catch (err) { log.warn('invalid runtime worker json', { error: logErrorRef(err) }); }
    });
    next.stderr.on?.('data', (chunk: Buffer) => {
      const text = String(chunk || '').trim();
      if (text) log.warn('runtime worker stderr', { text: text.slice(0, 500) });
    });
    next.once('exit', (code: number | null, signal: string | null) => {
      const error = new Error(`Mate Agent Runtime worker exited code=${code ?? ''} signal=${signal ?? ''}`.trim());
      if (child === next) child = null;
      handshake = null;
      rejectAll(error);
    });
  }

  async function ensureWorker(): Promise<void> {
    if (child && handshake) return handshake;
    const next = spawnWorker();
    attach(next);
    handshake = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mate Agent Runtime worker handshake timed out')), handshakeTimeoutMs);
      helloWaiters.push({ resolve, reject, timer });
      writeJsonl(next, { type: 'hello', protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION });
    });
    try { await handshake; }
    catch (err) {
      try { next.kill(); } catch {}
      if (child === next) child = null;
      handshake = null;
      throw err;
    }
  }

  async function* run(request: RuntimeRunRequest, opts: { signal?: AbortSignal | null } = {}): AsyncGenerator<RuntimeEventEnvelope, void, unknown> {
    await ensureWorker();
    if (!child) throw new Error('Mate Agent Runtime worker unavailable');
    if (opts.signal?.aborted) {
      yield {
        type: 'error',
        request_id: request.request_id,
        runtime_session_id: request.runtime_session_id,
        status: 'cancelled',
        error: 'cancelled',
      };
      return;
    }
    const pendingRun: PendingRun = { request, queue: [], waiters: [], done: false, error: null, hostAbort: new AbortController() };
    pending.set(request.request_id, pendingRun);
    const onAbort = () => {
      if (!child || pendingRun.done) return;
      pendingRun.hostAbort.abort();
      writeJsonl(child, { type: 'cancel', protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION, request_id: request.request_id });
    };
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    writeJsonl(child, request);
    try {
      while (!pendingRun.done || pendingRun.queue.length) {
        if (pendingRun.queue.length) {
          yield pendingRun.queue.shift()!;
          continue;
        }
        if (pendingRun.error) throw pendingRun.error;
        await new Promise<void>((resolve) => pendingRun.waiters.push(resolve));
      }
      if (pendingRun.error) throw pendingRun.error;
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort as any);
      pendingRun.hostAbort.abort();
      pending.delete(request.request_id);
      try { await options.onRunSettled?.(request); }
      catch (error) { log.warn('runtime run cleanup failed', { error: logErrorRef(error) }); }
    }
  }

  async function shutdown(): Promise<void> {
    const target = child;
    if (!target) return;
    try { writeJsonl(target, { type: 'shutdown' }); } catch {}
    try { target.kill(); } catch {}
    child = null;
    handshake = null;
    try { await options.onShutdown?.(); }
    catch (error) { log.warn('runtime shutdown cleanup failed', { error: logErrorRef(error) }); }
  }

  return { run, shutdown };
}

export const defaultRuntimeWorkerService = createRuntimeWorkerService({
  hostToolHandler: async (call, context) => {
    const { mateHostToolRouter } = await import('../cogseed_backend/host-tool-router');
    return mateHostToolRouter.handle(call, context);
  },
  onRunSettled: async (request) => {
    const { mateBrowserManager } = await import('../cogseed_backend/browser-manager');
    await mateBrowserManager.dispose(request.user_id, request.runtime_session_id);
  },
  onShutdown: async () => {
    const { mateBrowserManager } = await import('../cogseed_backend/browser-manager');
    await mateBrowserManager.disposeAll();
  },
});
