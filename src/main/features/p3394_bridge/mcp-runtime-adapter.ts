/**
 * P3394 SA-MCP profile — Agent Runtime MCP surface consumer (SDK §10.1).
 *
 * Binds a local MCP-capable agent runtime (exposing the p3394.runtime.*
 * tools: describe/open_session/deliver/resume/cancel/close_session) as a
 * full P3394 RuntimeAdapter over stdio JSON-RPC. The MCP server must
 * listen on stdio with an instance token scoped to the local host.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type { P3394Envelope } from './envelope';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from './runtime-adapter';

export interface P3394McpRuntimeOptions {
  /** Command + args that start the MCP runtime server (stdio). */
  command: string;
  args?: string[];
  /** Environment additions for the child (no secrets in argv). */
  env?: Record<string, string>;
  /** Optional bearer token passed as a header-like arg is FORBIDDEN; use
   *  the env or a token file reference instead (guide §11: no secrets in
   *  command-line arguments). */
  requestTimeoutMs?: number;
}

interface McpRpcResult { content?: Array<{ type: string; text?: string }> }

export class P3394McpRuntimeAdapter implements P3394RuntimeAdapter {
  private readonly options: P3394McpRuntimeOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private started = false;

  constructor(options: P3394McpRuntimeOptions) {
    this.options = options;
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.child = spawn(this.options.command, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      ...(this.options.env ? { env: { ...process.env, ...this.options.env } } : {}),
    });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } } | null = null;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'mcp_runtime_error'));
      else waiter.resolve(message.result);
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cogseed-p3394-bridge', version: '1.0.0' } });
    this.started = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error('p3394_mcp_runtime_not_running'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('p3394_mcp_runtime_timeout'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
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

  /** Best-effort child shutdown. */
  async close(): Promise<void> {
    if (this.child) {
      this.child.stdin.end();
      this.child.kill('SIGTERM');
      this.child = null;
      this.started = false;
    }
  }
}
