import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import * as path from 'node:path';
import { killProcessTree } from './process-tree.js';

const DEFAULT_LINE_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_LINE_BYTES = 64 * 1024 * 1024;
const TERMINATION_GRACE_MS = 5000;
const FORCE_KILL_WAIT_MS = 5000;

export interface ManagedStdioProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxInputLineBytes?: number;
  maxOutputLineBytes?: number;
}

export interface ManagedStdioProcess {
  readonly pid: number | undefined;
  writeLine(line: string): Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  onExit(listener: (error: Error | null) => void): () => void;
  close(): Promise<void>;
}

function resolveLineLimit(value: number | undefined, optionName: string): number {
  const limit = value === undefined ? DEFAULT_LINE_BYTES : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONFIGURABLE_LINE_BYTES) {
    throw new Error(`${optionName} must be a positive safe integer no greater than ${MAX_CONFIGURABLE_LINE_BYTES}`);
  }
  return limit;
}

function spawnManagedProcess(opts: ManagedStdioProcessOptions): ChildProcessWithoutNullStreams {
  return spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

/**
 * Start a bounded line-oriented child process for non-chat integrations.
 * The helper deliberately has no dependency on feature, agent, or model code.
 */
export function startManagedStdioProcess(opts: ManagedStdioProcessOptions): ManagedStdioProcess {
  if (typeof opts.command !== 'string' || !opts.command || opts.command.includes('\0') || !path.isAbsolute(opts.command)) {
    throw new Error('managed process command must be an absolute path without null bytes');
  }
  if (typeof opts.cwd !== 'string' || !opts.cwd || opts.cwd.includes('\0') || !path.isAbsolute(opts.cwd)) {
    throw new Error('managed process cwd must be an absolute path without null bytes');
  }
  if (!Array.isArray(opts.args) || opts.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('managed process args must be strings without null bytes');
  }
  const maxInputLineBytes = resolveLineLimit(opts.maxInputLineBytes, 'maxInputLineBytes');
  const maxOutputLineBytes = resolveLineLimit(opts.maxOutputLineBytes, 'maxOutputLineBytes');
  const child = spawnManagedProcess(opts);
  child.stdin.on('error', () => { /* cancellation can close stdin before a pending write settles */ });
  let stdoutBuffer = '';
  let stdoutBufferBytes = 0;
  let acceptingIO = true;
  let exitNotified = false;
  let processClosed = false;
  let terminationRequested = false;
  let terminationTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let rejectClose: ((error: Error) => void) | null = null;
  let abortListener: (() => void) | undefined;
  const lineListeners = new Set<(line: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(error: Error | null) => void>();
  const pendingWrites = new Set<(error: Error) => void>();

  const rejectPendingWrites = (error: Error): void => {
    for (const rejectWrite of [...pendingWrites]) rejectWrite(error);
    pendingWrites.clear();
  };

  const notifyExit = (error: Error | null): void => {
    if (exitNotified) return;
    exitNotified = true;
    acceptingIO = false;
    if (opts.signal && abortListener) opts.signal.removeEventListener('abort', abortListener);
    const writeFailure = error || new Error('managed process exited before stdin write completed');
    rejectPendingWrites(writeFailure);
    for (const listener of [...exitListeners]) listener(error);
    lineListeners.clear();
    stderrListeners.clear();
    exitListeners.clear();
  };

  const settleClose = (error?: Error): void => {
    const resolve = resolveClose;
    const reject = rejectClose;
    resolveClose = null;
    rejectClose = null;
    if (error) reject?.(error);
    else resolve?.();
  };

  const markProcessClosed = (): void => {
    if (processClosed) return;
    processClosed = true;
    if (terminationTimer) clearTimeout(terminationTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    terminationTimer = null;
    forceKillTimer = null;
    settleClose();
  };

  const waitForProcessClose = (): Promise<void> => {
    if (!closePromise) {
      closePromise = new Promise<void>((resolve, reject) => {
        if (processClosed) {
          resolve();
          return;
        }
        resolveClose = resolve;
        rejectClose = reject;
      });
    }
    return closePromise;
  };

  const requestTermination = (): Promise<void> => {
    const completion = waitForProcessClose();
    if (processClosed || terminationRequested) return completion;
    terminationRequested = true;
    acceptingIO = false;
    stdoutBuffer = '';
    stdoutBufferBytes = 0;
    rejectPendingWrites(new Error('managed process is closing'));
    terminationTimer = setTimeout(() => {
      if (processClosed) return;
      killProcessTree(child, 'SIGKILL');
      forceKillTimer = setTimeout(() => {
        if (processClosed) return;
        const error = new Error('managed process did not exit after SIGKILL');
        notifyExit(error);
        settleClose(error);
      }, FORCE_KILL_WAIT_MS);
      forceKillTimer.unref?.();
    }, TERMINATION_GRACE_MS);
    terminationTimer.unref?.();
    try { child.stdin.end(); } catch { /* process may already be gone */ }
    killProcessTree(child, 'SIGTERM');
    return completion;
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (!acceptingIO) return;
    stdoutBuffer += chunk;
    stdoutBufferBytes += Buffer.byteLength(chunk, 'utf8');
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const rawLine = stdoutBuffer.slice(0, newline);
      const rawLineBytes = Buffer.byteLength(rawLine, 'utf8');
      const hasCarriageReturn = rawLine.endsWith('\r');
      const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
      const lineBytes = rawLineBytes - (hasCarriageReturn ? 1 : 0);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      stdoutBufferBytes -= rawLineBytes + 1;
      if (lineBytes > maxOutputLineBytes) {
        stdoutBuffer = '';
        stdoutBufferBytes = 0;
        const error = new Error(`managed process stdout line exceeds ${maxOutputLineBytes} bytes`);
        notifyExit(error);
        void requestTermination().catch(() => undefined);
        return;
      }
      for (const listener of [...lineListeners]) listener(line);
      newline = stdoutBuffer.indexOf('\n');
    }
    if (stdoutBufferBytes > maxOutputLineBytes) {
      stdoutBuffer = '';
      stdoutBufferBytes = 0;
      const error = new Error(`managed process stdout line exceeds ${maxOutputLineBytes} bytes`);
      notifyExit(error);
      void requestTermination().catch(() => undefined);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (!acceptingIO) return;
    for (const listener of [...stderrListeners]) listener(chunk);
  });
  child.once('error', (error) => {
    notifyExit(error);
    void requestTermination().catch(() => undefined);
  });
  child.once('close', (code, signal) => {
    if (!exitNotified && stdoutBuffer) {
      const hasCarriageReturn = stdoutBuffer.endsWith('\r');
      const line = hasCarriageReturn ? stdoutBuffer.slice(0, -1) : stdoutBuffer;
      const lineBytes = stdoutBufferBytes - (hasCarriageReturn ? 1 : 0);
      if (lineBytes > maxOutputLineBytes) {
        stdoutBuffer = '';
        stdoutBufferBytes = 0;
        notifyExit(new Error(`managed process stdout line exceeds ${maxOutputLineBytes} bytes`));
        markProcessClosed();
        return;
      }
      for (const listener of [...lineListeners]) listener(line);
      stdoutBuffer = '';
      stdoutBufferBytes = 0;
    }
    if (!exitNotified) {
      if (code === 0 || (code === null && signal === 'SIGTERM')) notifyExit(null);
      else notifyExit(new Error(`managed process exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`));
    }
    markProcessClosed();
  });
  if (opts.signal) {
    abortListener = () => { void requestTermination().catch(() => undefined); };
    if (opts.signal.aborted) abortListener();
    else opts.signal.addEventListener('abort', abortListener, { once: true });
  }

  const remove = <T>(set: Set<T>, item: T): (() => void) => () => { set.delete(item); };
  return {
    pid: child.pid,
    writeLine(line: string): Promise<void> {
      if (!acceptingIO) return Promise.reject(new Error('managed process is closed'));
      if (typeof line !== 'string' || !line || line.includes('\n') || line.includes('\r') || line.includes('\0')) {
        return Promise.reject(new Error('line must be a non-empty string without line breaks or null bytes'));
      }
      if (Buffer.byteLength(line, 'utf8') > maxInputLineBytes) {
        return Promise.reject(new Error(`managed process stdin line exceeds ${maxInputLineBytes} bytes`));
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error | null): void => {
          if (settled) return;
          settled = true;
          child.stdin.off('error', onError);
          pendingWrites.delete(rejectPending);
          if (error) reject(error);
          else resolve();
        };
        const onError = (error: Error): void => settle(error);
        const rejectPending = (error: Error): void => settle(error);
        pendingWrites.add(rejectPending);
        child.stdin.once('error', onError);
        child.stdin.write(`${line}\n`, 'utf8', (error?: Error | null) => settle(error));
      });
    },
    onLine(listener) { lineListeners.add(listener); return remove(lineListeners, listener); },
    onStderr(listener) { stderrListeners.add(listener); return remove(stderrListeners, listener); },
    onExit(listener) { exitListeners.add(listener); return remove(exitListeners, listener); },
    close(): Promise<void> {
      return requestTermination();
    },
  };
}
