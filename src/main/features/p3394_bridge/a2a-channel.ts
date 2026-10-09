/**
 * P3394 A2A channel adapter (SDK design §13/§19, guide §12).
 *
 * Binds a remote Agent2Agent agent as a P3394 peer over A2A JSON-RPC:
 *
 *  - dial() fetches the A2A Agent Card and pins the remote identity;
 *  - send() maps one UMF envelope to message/send, polls tasks/get while
 *    the task is working, and converts the A2A result back into a UMF
 *    reply envelope delivered through the channel's subscribers;
 *  - the binding publishes a MappingReport (guide §12/§13): preserved,
 *    synthesized and dropped fields are declared, never implicit.
 */

import * as http from 'node:http';
import { buildP3394ChannelDescriptor, type P3394ChannelAdapter, type P3394ChannelDeliveryReceipt, type P3394ChannelDescriptor, type P3394ChannelHealth, type P3394ChannelListener } from './channel-adapter';
import type { P3394Envelope } from './envelope';
import { buildP3394MappingReport, validateP3394MappingReport, type P3394MappingReport } from './reduced-profiles';

export interface P3394A2AChannelOptions {
  /** A2A agent endpoint (agent-card root or explicit card URL). */
  endpoint: string;
  /** Optional bearer token for the A2A endpoint. */
  bearerToken?: string;
  /** Maximum wait for a working task (poll interval 500ms). */
  taskTimeoutMs?: number;
  now?: () => string;
}

export const P3394_A2A_DEFAULTS = {
  taskTimeoutMs: 60_000,
  pollIntervalMs: 500,
} as const;

interface A2AAgentCard { name?: string; url?: string; capabilities?: unknown; protocolVersion?: string; description?: string; defaultInputModes?: string[]; defaultOutputModes?: string[] }
interface A2APart { kind?: string; text?: string; file?: { name?: string; mimeType?: string; bytes?: string } }
interface A2AMessage { messageId?: string; role?: string; parts?: A2APart[]; metadata?: Record<string, unknown> }
interface A2ATaskStatus { state?: string; message?: A2AMessage }
interface A2ATask { id?: string; contextId?: string; status?: A2ATaskStatus; artifacts?: unknown[] }

function jsonRpc(endpoint: string, method: string, params: unknown, bearerToken: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(endpoint); } catch (error) { reject(error); return; }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bearerToken) headers.Authorization = 'Bearer ' + bearerToken;
    const request = http.request(
      { hostname: url.hostname, port: url.port ? Number(url.port) : 80, path: url.pathname || '/', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error('p3394_a2a_http_' + res.statusCode)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('p3394_a2a_timeout')));
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8');
  });
}

export class P3394A2AChannel implements P3394ChannelAdapter {
  readonly channel_id: string;
  readonly descriptor: P3394ChannelDescriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.a2a',
    schemes: ['p3394+a2a'],
    roles: ['dialer'],
    bindings: ['umf-json', 'a2a-jsonrpc'],
    capabilities: {
      streaming: 'none',
      durable_tasks: true,
      cancellation: true,
      artifacts: 'referenced',
      multi_party_sessions: false,
      identity_proofs: ['a2a-agent-card'],
    },
  });
  /** Published mapping for this binding (guide §12/§13). */
  readonly mappingReport: P3394MappingReport;
  private readonly options: P3394A2AChannelOptions;
  private readonly listeners = new Set<P3394ChannelListener>();
  private card: A2AAgentCard | null = null;
  private closed = false;

  constructor(channel_id: string, options: P3394A2AChannelOptions) {
    this.channel_id = channel_id;
    this.options = options;
    const report = buildP3394MappingReport('a2a');
    const validated = validateP3394MappingReport(report);
    if (validated.ok === false) throw new Error('p3394_a2a_mapping_invalid');
    this.mappingReport = report;
  }

  async listen(): Promise<void> {
    // A2A is a dialer-only binding: the local node is reachable through
    // its own native P3394 listener.
  }

  /** Fetches the Agent Card and pins the remote identity. */
  async dial(_peerId = ''): Promise<void> {
    if (this.closed) throw new Error('p3394_channel_closed');
    const card = await this.fetchCard();
    if (!card) throw new Error('p3394_a2a_card_unavailable');
    this.card = card;
  }

  private fetchCard(): Promise<A2AAgentCard | null> {
    return new Promise((resolve) => {
      let url: URL;
      try { url = new URL(this.options.endpoint); } catch { resolve(null); return; }
      // Agent Card conventions: explicit path, else /.well-known/agent.json,
      // falling back to the root when the well-known path 404s.
      const explicit = url.pathname && url.pathname !== '/' ? url.pathname : null;
      const wellKnown = explicit ? null : '/.well-known/agent.json';
      const first = explicit ?? wellKnown ?? '/';
      const fallback = explicit ? null : '/';
      let settled = false;
      const tryPath = (pathname: string, done: (card: A2AAgentCard | null) => void): void => {
        const headers: Record<string, string> = {};
        if (this.options.bearerToken) headers.Authorization = 'Bearer ' + this.options.bearerToken;
        const request = http.request(
          { hostname: url.hostname, port: url.port ? Number(url.port) : 80, path: pathname, method: 'GET', headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              if (res.statusCode !== 200) { done(null); return; }
              try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(null); }
            });
          },
        );
        request.setTimeout(10_000, () => { request.destroy(); done(null); });
        request.on('error', () => done(null));
        request.end();
      };
      const finish = (card: A2AAgentCard | null): void => {
        if (settled) return;
        if (card || !fallback || first === fallback) { settled = true; resolve(card); return; }
        tryPath(fallback, (second) => { settled = true; resolve(second); });
      };
      tryPath(first, finish);
    });
  }

  /** Maps a UMF envelope to A2A message/send and converts the A2A result
   *  back into a UMF reply delivered to subscribers. */
  async send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> {
    if (this.closed) throw new Error('p3394_channel_closed');
    const timeoutMs = this.options.taskTimeoutMs ?? P3394_A2A_DEFAULTS.taskTimeoutMs;
    const parts: A2APart[] = [];
    for (const part of envelope.payload.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push({ kind: 'text', text: part.text });
      } else if (part.uri && part.uri.startsWith('data:')) {
        const comma = part.uri.indexOf(',');
        if (comma > 0) {
          const meta = part.uri.slice(5, comma);
          const isB64 = /;base64$/i.test(meta);
          parts.push({ kind: 'file', file: { name: part.name || 'resource', mimeType: part.media_type || 'application/octet-stream', bytes: isB64 ? part.uri.slice(comma + 1) : Buffer.from(decodeURIComponent(part.uri.slice(comma + 1)), 'utf8').toString('base64') } });
        }
      }
    }
    const params = {
      message: {
        messageId: envelope.message_id,
        role: 'user',
        parts,
        ...(envelope.payload.metadata ? { metadata: envelope.payload.metadata } : {}),
      },
      contextId: envelope.session_id,
      ...(envelope.task_id ? { taskId: envelope.task_id } : {}),
    };
    const response = await jsonRpc(this.options.endpoint, 'message/send', params, this.options.bearerToken ?? '', timeoutMs) as { result?: A2ATask; error?: unknown };
    if (!response || !response.result) {
      throw new Error('p3394_a2a_rpc_error: ' + JSON.stringify(response?.error ?? 'no result').slice(0, 120));
    }
    let task: A2ATask = response.result;
    const deadline = Date.now() + timeoutMs;
    while (task.status?.state === 'working' || task.status?.state === 'input-required' || task.status?.state === 'submitted') {
      if (Date.now() > deadline) throw new Error('p3394_a2a_task_timeout');
      await new Promise((resolve) => setTimeout(resolve, P3394_A2A_DEFAULTS.pollIntervalMs));
      const polled = await jsonRpc(this.options.endpoint, 'tasks/get', { id: task.id }, this.options.bearerToken ?? '', timeoutMs) as { result?: A2ATask };
      if (!polled || !polled.result) throw new Error('p3394_a2a_tasks_get_failed');
      task = polled.result;
    }
    // A2A result → UMF reply envelope → channel subscribers (inbound flow).
    const replyText = (task.status?.message?.parts ?? [])
      .filter((part) => part.kind === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
      .trim();
    const state = task.status?.state ?? 'unknown';
    const reply: P3394Envelope = {
      spec_version: 'p3394/1.0',
      message_id: 'msg-a2a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      session_id: envelope.session_id,
      task_id: task.id || envelope.task_id,
      kind: state === 'failed' || state === 'canceled' ? 'error' : 'message',
      performative: state === 'failed' || state === 'canceled' ? 'error' : 'inform',
      role: 'responder',
      sender: { agent_id: 'a2a-peer', alias: this.card?.name },
      recipients: [{ agent_id: envelope.sender.agent_id }],
      payload: { parts: [{ type: 'text', text: replyText || '(empty a2a reply)' }] },
      reply_to: envelope.message_id,
      idempotency_key: 'a2a-reply:' + envelope.idempotency_key,
    };
    for (const listener of [...this.listeners]) listener(reply);
    return { channel_id: this.channel_id, message_id: envelope.message_id, accepted: true };
  }

  async capabilities(): Promise<P3394ChannelDescriptor['capabilities']> {
    return { ...this.descriptor.capabilities, identity_proofs: [...this.descriptor.capabilities.identity_proofs] };
  }

  async health(): Promise<P3394ChannelHealth> {
    return { ok: !this.closed, scheme: 'p3394+a2a', listener_active: false, dialer_connected: !!this.card };
  }

  subscribe(listener: P3394ChannelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }
}
