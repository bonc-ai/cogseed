/**
 * P3394 OpenAI-compatible Model Runtime adapter (guide §2.7/§12).
 *
 * A model API is a MODEL endpoint, never an autonomous Agent: this adapter
 * projects it as a reduced capability call. The P3394 session stays with
 * the local bridge (mapping report: session_semantics 'local-bridge');
 * text parts map to chat messages, the completion maps back to a UMF
 * reply envelope delivered to subscribers.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { buildP3394ChannelDescriptor, type P3394ChannelAdapter, type P3394ChannelDeliveryReceipt, type P3394ChannelDescriptor, type P3394ChannelHealth, type P3394ChannelListener } from './channel-adapter';
import type { P3394Envelope } from './envelope';
import { buildP3394MappingReport, validateP3394MappingReport, type P3394MappingReport } from './reduced-profiles';

export interface P3394ModelRuntimeOptions {
  /** OpenAI-compatible endpoint, e.g. openai+http://127.0.0.1:8000/v1
   *  or a plain http(s) base URL (the adapter appends /chat/completions). */
  endpoint: string;
  model: string;
  bearerToken?: string;
  /** Optional system prompt prepended to the mapped messages. */
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export class P3394ModelRuntimeAdapter implements P3394ChannelAdapter {
  readonly channel_id: string;
  readonly descriptor: P3394ChannelDescriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.openai_model',
    schemes: ['p3394+openai', 'openai+http', 'openai+https'],
    roles: ['dialer'],
    bindings: ['umf-json', 'openai-chat-completions'],
    capabilities: {
      streaming: 'none',
      durable_tasks: false,
      cancellation: false,
      artifacts: 'none',
      multi_party_sessions: false,
      identity_proofs: ['bearer-token'],
    },
  });
  /** Published mapping for this reduced binding (guide §12). */
  readonly mappingReport: P3394MappingReport;
  private readonly options: P3394ModelRuntimeOptions;
  private readonly listeners = new Set<P3394ChannelListener>();
  private closed = false;

  constructor(channel_id: string, options: P3394ModelRuntimeOptions) {
    this.channel_id = channel_id;
    this.options = options;
    const report = buildP3394MappingReport('openai-model');
    const validated = validateP3394MappingReport(report);
    if (validated.ok === false) throw new Error('p3394_model_mapping_invalid');
    this.mappingReport = report;
  }

  async listen(): Promise<void> { /* dialer-only reduced binding */ }

  async dial(_peerId = ''): Promise<void> {
    if (this.closed) throw new Error('p3394_channel_closed');
    // A model endpoint has no agent card; reachability is validated on send.
  }

  private completionUrl(): string {
    const raw = this.options.endpoint.replace(/^p3394\+openai:/, '').replace(/^openai\+(http|https):/, '$1:');
    return raw.replace(/\/$/, '') + '/chat/completions';
  }

  /** Maps a UMF envelope to a chat-completions request and converts the
   *  completion back into a UMF reply envelope for subscribers. */
  async send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> {
    if (this.closed) throw new Error('p3394_channel_closed');
    const messages: ChatMessage[] = [];
    if (this.options.systemPrompt) messages.push({ role: 'system', content: this.options.systemPrompt });
    for (const part of envelope.payload.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        messages.push({ role: 'user', content: part.text });
      } else if (part.uri && part.uri.startsWith('data:')) {
        // Reduced profile: binary parts are not sent to the model; the
        // mapping report declares payload.parts synthesized to messages[].
        messages.push({ role: 'user', content: '[attachment ' + (part.name || 'resource') + ' omitted in model binding]' });
      }
    }
    if (messages.length === 0) throw new Error('p3394_model_no_text_input');
    const body = {
      model: this.options.model,
      messages,
      ...(this.options.maxTokens ? { max_tokens: this.options.maxTokens } : {}),
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
    };
    const completion = await this.request(body);
    const replyText = typeof completion === 'string' ? completion : '';
    const reply: P3394Envelope = {
      spec_version: 'p3394/1.0',
      message_id: 'msg-model-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      kind: 'message',
      performative: 'inform',
      role: 'responder',
      sender: { agent_id: 'model-runtime' },
      recipients: [{ agent_id: envelope.sender.agent_id }],
      payload: { parts: [{ type: 'text', text: replyText || '(empty model response)' }] },
      reply_to: envelope.message_id,
      idempotency_key: 'model-reply:' + envelope.idempotency_key,
    };
    for (const listener of [...this.listeners]) listener(reply);
    return { channel_id: this.channel_id, message_id: envelope.message_id, accepted: true };
  }

  private request(body: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try { url = new URL(this.completionUrl()); } catch (error) { reject(error); return; }
      const isTls = url.protocol === 'https:';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.options.bearerToken) headers.Authorization = 'Bearer ' + this.options.bearerToken;
      const request = (isTls ? https : http).request(
        { hostname: url.hostname, port: url.port ? Number(url.port) : (isTls ? 443 : 80), path: url.pathname, method: 'POST', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) { reject(new Error('p3394_model_http_' + res.statusCode)); return; }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { choices?: Array<{ message?: { content?: string } }> }
              resolve(parsed.choices?.[0]?.message?.content ?? '');
            } catch (error) { reject(error); }
          });
        },
      );
      request.setTimeout(this.options.timeoutMs ?? 60_000, () => request.destroy(new Error('p3394_model_timeout')));
      request.on('error', reject);
      request.end(JSON.stringify(body), 'utf8');
    });
  }

  async health(): Promise<P3394ChannelHealth> {
    return { ok: !this.closed, scheme: this.descriptor.schemes[0] ?? 'openai+http', listener_active: false, dialer_connected: !this.closed };
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
