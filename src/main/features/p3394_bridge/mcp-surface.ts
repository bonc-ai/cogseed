/**
 * P3394 SA-MCP profile — Bridge MCP surface (SDK design §10, guide §9.3).
 *
 * A local MCP server (stdio JSON-RPC 2.0) that projects the P3394 bridge
 * outbound operations for MCP hosts (third-party agents, Claude-style
 * desktops, user-built agents):
 *
 *  - p3394.peer.discover  → registry snapshot (id/name/capabilities/online)
 *  - p3394.peer.send      → UMF send + wait for the peer's reply
 *  - p3394.task.get       → task state lookup
 *  - p3394.task.cancel    → cancel a running task
 *  - p3394.resource.get   → content-addressed object fetch
 *
 * The companion Agent Runtime MCP surface (p3394.runtime.*) is consumed by
 * P3394McpRuntimeAdapter, so an MCP-capable local runtime can be bound as a
 * full RuntimeAdapter without embedding.
 */

import * as readline from 'node:readline';

export interface P3394McpPeerSummary {
  agent_id: string;
  display_name: string;
  capabilities: string[];
  online: boolean;
}

export interface P3394McpSendResult {
  status: 'ok' | 'error';
  peer: string;
  reply?: string;
  error?: string;
}

export interface P3394McpBridgeDeps {
  listPeers: () => P3394McpPeerSummary[];
  sendToPeer: (peer: string, message: string, opts?: { session_id?: string; goal?: string }) => Promise<P3394McpSendResult>;
  getTask?: (taskId: string) => { task_id: string; state: string } | null;
  cancelTask?: (taskId: string) => Promise<void>;
  getResource?: (digest: string) => Buffer | null;
  /** Writable stream for responses (tests inject; defaults to stdout). */
  output?: NodeJS.WritableStream;
  /** Readable stream for requests (tests inject; defaults to stdin). */
  input?: NodeJS.ReadableStream;
}

interface McpTool { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }

const MCP_PROTOCOL_VERSION = '2024-11-05';

export class P3394McpBridgeServer {
  private readonly deps: P3394McpBridgeDeps;
  private started = false;

  constructor(deps: P3394McpBridgeDeps) {
    this.deps = deps;
  }

  private tools(): McpTool[] {
    return [
      {
        name: 'p3394.peer.discover',
        description: 'List the P3394 peers registered in the local bridge: agent id, display name, capabilities and online status.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'p3394.peer.send',
        description: 'Send a P3394 message to a registered peer Agent and wait for its reply. peer: agent id or alias. message: the task text. goal: optional collaboration goal (same goal reuses the session).',
        inputSchema: {
          type: 'object',
          properties: {
            peer: { type: 'string' },
            message: { type: 'string' },
            session_id: { type: 'string' },
            goal: { type: 'string' },
          },
          required: ['peer', 'message'],
        },
      },
      {
        name: 'p3394.task.get',
        description: 'Return the state of a P3394 task by task id.',
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
      {
        name: 'p3394.task.cancel',
        description: 'Cancel a running P3394 task by task id.',
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
      {
        name: 'p3394.resource.get',
        description: 'Fetch a content-addressed P3394 object by sha256 digest (hex) and return it base64-encoded.',
        inputSchema: { type: 'object', properties: { digest: { type: 'string' } }, required: ['digest'] },
      },
    ];
  }

  /** Starts the stdio JSON-RPC loop (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const input = this.deps.input ?? process.stdin;
    const output = this.deps.output ?? process.stdout;
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      void this.handleLine(line, output);
    });
  }

  /** Handles one JSON-RPC request line (exposed for tests/embedding). */
  async handleLine(line: string, output: NodeJS.WritableStream): Promise<void> {
    let message: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> } | null = null;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || message.jsonrpc !== '2.0') return;
    // Notifications (no id) get no response.
    if (message.id === undefined) return;
    try {
      const result = await this.dispatch(message.method ?? '', message.params ?? {});
      this.write(output, { jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      this.write(output, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cogseed-p3394-bridge', version: '1.0.0' },
        };
      case 'tools/list':
        return { tools: this.tools() };
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
        return await this.callTool(name, args);
      }
      case 'ping':
        return {};
      default:
        throw new Error('method_not_found: ' + method);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    switch (name) {
      case 'p3394.peer.discover':
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', peers: this.deps.listPeers() }) }] };
      case 'p3394.peer.send': {
        const peer = typeof args.peer === 'string' ? args.peer.trim() : '';
        const message = typeof args.message === 'string' ? args.message.trim() : '';
        if (!peer || !message) return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'peer and message are required' }) }], isError: true };
        const result = await this.deps.sendToPeer(peer, message, {
          ...(typeof args.session_id === 'string' && args.session_id ? { session_id: args.session_id } : {}),
          ...(typeof args.goal === 'string' && args.goal ? { goal: args.goal } : {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.status === 'error' ? { isError: true } : {}) };
      }
      case 'p3394.task.get': {
        const taskId = typeof args.task_id === 'string' ? args.task_id : '';
        if (!this.deps.getTask) throw new Error('p3394_task_get_unavailable');
        const task = this.deps.getTask(taskId);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', task }) }] };
      }
      case 'p3394.task.cancel': {
        const taskId = typeof args.task_id === 'string' ? args.task_id : '';
        if (!this.deps.cancelTask) throw new Error('p3394_task_cancel_unavailable');
        await this.deps.cancelTask(taskId);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', cancelled: taskId }) }] };
      }
      case 'p3394.resource.get': {
        const digest = typeof args.digest === 'string' ? args.digest : '';
        if (!this.deps.getResource) throw new Error('p3394_resource_get_unavailable');
        const content = this.deps.getResource(digest);
        if (!content) return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'object_not_found' }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', digest, base64: content.toString('base64') }) }] };
      }
      default:
        throw new Error('tool_not_found: ' + name);
    }
  }

  private write(output: NodeJS.WritableStream, message: unknown): void {
    output.write(JSON.stringify(message) + '\n');
  }
}
