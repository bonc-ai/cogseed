/**
 * P3394 SA-MCP profile — Agent Runtime MCP surface consumer (SDK §10.1).
 *
 * Binds a local MCP-capable agent runtime (exposing the p3394.runtime.*
 * tools: describe/open_session/deliver/resume/cancel/close_session) as a
 * full P3394 RuntimeAdapter over stdio JSON-RPC. The MCP server must
 * listen on stdio with an instance token scoped to the local host.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type { P3394Envelope } from './envelope';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from './runtime-adapter';
import { killProcessTree, spawnCli } from '../local_agents/backends/base';

export interface P3394McpRuntimeOptions {
  /** Command + args that start the MCP runtime server (stdio). */
  command: string;
  args?: string[];
  /** Environment additions for the child (no secrets in argv). */
  env?: Record<string, string>;
  /** Working directory for the runtime process. Defaults to the app cwd. */
  cwd?: string;
  /** Optional bearer token passed as a header-like arg is FORBIDDEN; use
   *  the env or a token file reference instead (guide §11: no secrets in
   *  command-line arguments). */
  requestTimeoutMs?: number;
}

interface McpRpcResult { content?: Array<{ type: string; text?: string }> }

interface PendingMcpRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class P3394McpRuntimeAdapter implements P3394RuntimeAdapter {
  private readonly options: P3394McpRuntimeOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingMcpRequest>();
  private started = false;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: P3394McpRuntimeOptions) {
    this.options = options;
  }

  private async ensureStarted(): Promise<void> {
    if (this.closePromise) await this.closePromise;
    if (this.started && this.child) return;
    if (this.startPromise) return this.startPromise;

    const startPromise = this.startChild();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  private async startChild(): Promise<void> {
    const child = spawnCli(
      this.options.command,
      this.options.args ?? [],
      this.options.cwd ?? process.cwd(),
      this.options.env ? { ...process.env, ...this.options.env } : undefined,
    );
    this.child = child;
    child.stderr.pipe(process.stderr, { end: false });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } } | null = null;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'mcp_runtime_error'));
      else waiter.resolve(message.result);
    });
    child.once('error', (error) => {
      this.resetChild(child, error instanceof Error ? error : new Error(String(error)));
    });
    child.once('close', (code, signal) => {
      this.resetChild(
        child,
        new Error(`p3394_mcp_runtime_closed code=${code ?? ''} signal=${signal ?? ''}`.trim()),
      );
    });

    try {
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cogseed-p3394-bridge', version: '1.0.0' } });
      if (this.child !== child) throw new Error('p3394_mcp_runtime_not_running');
      this.started = true;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.child === child) await this.terminateChild(child, failure);
      throw failure;
    }
  }

  private rejectPending(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private resetChild(child: ChildProcessWithoutNullStreams, error: Error): boolean {
    if (this.child !== child) return false;
    this.child = null;
    this.started = false;
    this.rejectPending(error);
    return true;
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams, error: Error): Promise<void> {
    if (!this.resetChild(child, error)) return;
    child.stdin.end();
    await killProcessTree(child, 'SIGTERM');
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error('p3394_mcp_runtime_not_running'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('p3394_mcp_runtime_timeout'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureStarted();
    const result = await this.request('tools/call', { name, arguments: args }) as McpRpcResult;
    const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
    return text.trim();
  }

  private parseToolJson(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return { raw: text };
    }
  }

  async openSession(input: { session_id: string; agent_id: string }): Promise<P3394RuntimeSessionBinding> {
    const text = await this.callTool('p3394.runtime.open_session', { session_id: input.session_id, goal: '' });
    const parsed = this.parseToolJson(text);
    return {
      session_id: input.session_id,
      native_session_id: typeof parsed.native_session_id === 'string' ? parsed.native_session_id : 'mcp:' + input.session_id,
      agent_id: input.agent_id,
    };
  }

  async deliver(envelope: P3394Envelope): Promise<{ task_id: string }> {
    const text = await this.callTool('p3394.runtime.deliver', { session_id: envelope.session_id, message: envelope });
    const parsed = this.parseToolJson(text);
    return { task_id: typeof parsed.task_id === 'string' ? parsed.task_id : 'mcp-' + envelope.message_id };
  }

  async *stream(taskId: string): AsyncIterable<P3394RuntimeEvent> {
    const text = await this.callTool('p3394.runtime.task_result', { task_id: taskId });
    const parsed = this.parseToolJson(text);
    const state = typeof parsed.state === 'string' ? parsed.state : 'completed';
    const reply = typeof parsed.text === 'string' ? parsed.text : '';
    let sequence = 0;
    sequence += 1;
    yield { sequence, task_id: taskId, kind: 'started' };
    if (reply) {
      sequence += 1;
      yield { sequence, task_id: taskId, kind: 'delta', data: { text: reply } };
    }
    sequence += 1;
    yield { sequence, task_id: taskId, kind: state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : 'completed' };
  }

  async resume(sessionId: string): Promise<void> {
    await this.callTool('p3394.runtime.resume', { session_id: sessionId });
  }

  async cancel(taskId: string): Promise<void> {
    await this.callTool('p3394.runtime.cancel', { task_id: taskId });
  }

  async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
    const text = await this.callTool('p3394.runtime.snapshot', { session_id: sessionId });
    const parsed = this.parseToolJson(text);
    return {
      session_id: sessionId,
      native_session_id: typeof parsed.native_session_id === 'string' ? parsed.native_session_id : 'mcp:' + sessionId,
      at: new Date().toISOString(),
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.callTool('p3394.runtime.close_session', { session_id: sessionId });
  }

  /** Close only after the runtime process tree has released its resources. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.child && !this.startPromise) return;

    const closePromise = this.closeCurrent().finally(() => {
      if (this.closePromise === closePromise) this.closePromise = null;
    });
    this.closePromise = closePromise;
    return closePromise;
  }

  private async closeCurrent(): Promise<void> {
    const child = this.child;
    const startPromise = this.startPromise;
    if (child) await this.terminateChild(child, new Error('p3394_mcp_runtime_closed'));
    if (startPromise) await startPromise.catch(() => {});
  }
}
