/**
 * P3394 WebSocket channel（C-05）：真实 WS listener/dialer。
 *
 * 在 HTTP(S) server 上挂 WebSocketServer：HTTP 端点（manifest/health/
 * objects）与认证/速率/并发限制复用 P3394HttpChannel 的既有实现；
 * envelope 消息走 WebSocket 帧（`{"envelope": {...}}`，响应
 * `{"ok":true,"message_id":...}` / `{"ok":false,"error":...}`）。
 *
 * 安全与一致性（对齐 http-channel，C-04/S-03/S-06）：
 *  - 握手层 Bearer 认证（401 审计）；速率/并发超限拒绝（429/503 语义）；
 *  - dial 先 HTTP 拉 manifest 校验 expected_identity（token→peer identity
 *    绑定）与 capability，身份不符 fail-closed 不发任何信封；
 *  - endpoint failover 保持身份一致，首个成功端点即用；
 *  - 消息体上限（maxPayload）与统一速率原语（P3394RateLimiter）。
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { P3394HttpChannel, p3394CheckEnvelopeDigests } from './http-channel';
import { validateP3394Envelope, type P3394Envelope } from './envelope';
import { P3394RateLimiter, P3394_CHANNEL_LIMITS } from './channel-limits';
import { buildP3394ChannelDescriptor, type P3394ChannelAdapter, type P3394ChannelDeliveryReceipt, type P3394ChannelDescriptor, type P3394ChannelHealth, type P3394ChannelListener } from './channel-adapter';
import type { P3394BridgeManifest } from './manifest';

export interface P3394WebSocketListenConfig {
  host?: string;
  port: number;
  tls?: { key: string; cert: string };
}

export interface P3394WebSocketDialConfig {
  endpoints: string[];
  bearerToken?: string;
  expected_identity?: string;
  tls?: { ca?: string; rejectUnauthorized?: boolean };
}

export interface P3394WebSocketChannelOptions {
  listen?: P3394WebSocketListenConfig;
  dial?: P3394WebSocketDialConfig;
  /** Token required on inbound connections (listener side). */
  authToken?: string;
  /** Max inbound message bytes (WS frame payload; S-06). */
  maxMessageBytes?: number;
  timeoutMs?: number;
  /** Inbound message rate limit per minute (0 disables; S-06). */
  maxInboundRequestsPerMinute?: number;
  /** 同时活跃的入站连接上限（0 disables；超出拒绝 upgrade，S-06）。 */
  maxConcurrentRequests?: number;
  /** 认证/边界失败审计回调（C-04）。 */
  audit?: (record: { event: string; status: 'rejected'; metadata: Record<string, unknown> }) => void;
  now?: () => number;
}

const WS_PATH = '/p3394/ws';

export const P3394_WS_CHANNEL_DEFAULTS = {
  maxMessageBytes: 4 * 1024 * 1024,
  timeoutMs: 15_000,
  maxConcurrentRequests: 16,
} as const;

export type P3394WebSocketNegotiationResult =
  | { ok: true; peer_agent_id: string; peer_manifest: P3394BridgeManifest }
  | { ok: false; error: { reason: string; message: string } };

export class P3394WebSocketChannel implements P3394ChannelAdapter {
  readonly channel_id: string;
  readonly descriptor: P3394ChannelDescriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.websocket',
    schemes: ['p3394+wss', 'p3394+ws'],
    roles: ['listener', 'dialer'],
    bindings: ['umf-json'],
    capabilities: {
      streaming: 'bidirectional',
      durable_tasks: true,
      cancellation: true,
      artifacts: 'inline',
      multi_party_sessions: true,
      identity_proofs: ['bearer-token'],
    },
  });
  private readonly options: P3394WebSocketChannelOptions;
  private readonly now: () => number;
  private readonly listeners = new Set<P3394ChannelListener>();
  private readonly httpChannel: P3394HttpChannel;
  private wss: WebSocketServer | null = null;
  private activeSockets = new Set<WebSocket>();
  private activeEndpoint: string | null = null;
  private peerManifest: P3394BridgeManifest | null = null;
  private dialSocket: WebSocket | null = null;
  private localManifest: P3394BridgeManifest | null = null;
  private closed = false;
  private readonly inboundLimiter: P3394RateLimiter | null;

  constructor(channel_id = 'websocket', options: P3394WebSocketChannelOptions = {}) {
    this.channel_id = channel_id;
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const perMinute = options.maxInboundRequestsPerMinute ?? P3394_CHANNEL_LIMITS.maxInboundRequestsPerMinute;
    this.inboundLimiter = perMinute <= 0 ? null : new P3394RateLimiter(perMinute, 60_000, this.now());
    // HTTP 端点（manifest/health/objects）与认证/限制复用既有实现。
    this.httpChannel = new P3394HttpChannel(channel_id + '-http', {
      listen: options.listen ? { host: options.listen.host, port: options.listen.port, ...(options.listen.tls ? { tls: options.listen.tls } : {}) } : undefined,
      authToken: options.authToken,
      maxBodyBytes: options.maxMessageBytes,
      timeoutMs: options.timeoutMs,
      maxInboundRequestsPerMinute: perMinute,
      maxConcurrentRequests: options.maxConcurrentRequests ?? P3394_WS_CHANNEL_DEFAULTS.maxConcurrentRequests,
      audit: options.audit,
      now: options.now,
    });
  }

  setLocalManifest(manifest: P3394BridgeManifest): void {
    this.localManifest = manifest;
    this.httpChannel.setLocalManifest(manifest);
  }

  private authToken(): string {
    return this.options.authToken ?? '';
  }

  private maxMessageBytes(): number {
    return this.options.maxMessageBytes ?? P3394_WS_CHANNEL_DEFAULTS.maxMessageBytes;
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? P3394_WS_CHANNEL_DEFAULTS.timeoutMs;
  }

  private maxConcurrentRequests(): number {
    return this.options.maxConcurrentRequests ?? P3394_WS_CHANNEL_DEFAULTS.maxConcurrentRequests;
  }

  private authorized(req: http.IncomingMessage): boolean {
    const token = this.authToken();
    if (!token) return true;
    const header = req.headers.authorization;
    return typeof header === 'string' && header === 'Bearer ' + token;
  }

  private auditReject(event: string, metadata: Record<string, unknown>): void {
    this.options.audit?.({ event, status: 'rejected', metadata });
  }

  async listen(): Promise<void> {
    if (this.closed) throw new Error('p3394_channel_closed');
    if (this.wss) return;
    if (!this.options.listen) throw new Error('p3394_websocket_listen_not_configured');
    await this.httpChannel.listen();
    const server = (this.httpChannel as unknown as { server: http.Server }).server;
    // noServer：由本类手动处理 upgrade（认证/并发门禁后 handleUpgrade），
    // 避免 WebSocketServer({ server }) 自带的 upgrade 监听重复处理同一 socket。
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.maxMessageBytes() });
    this.wss = wss;

    // 握手层 Bearer 认证 + 并发上限：失败 401/503 关闭，不进 WS 层。
    server.on('upgrade', (req, socket, head) => {
      if (!this.authorized(req)) {
        this.auditReject('http.auth.reject', { path: WS_PATH });
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const maxConcurrent = this.maxConcurrentRequests();
      if (maxConcurrent > 0 && this.activeSockets.size >= maxConcurrent) {
        this.auditReject('channel_busy', { path: WS_PATH });
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws) => {
      this.activeSockets.add(ws);
      ws.on('message', (data) => { void this.handleMessage(ws, data); });
      ws.on('close', () => { this.activeSockets.delete(ws); });
      ws.on('error', () => { this.activeSockets.delete(ws); });
    });
  }

  private async handleMessage(ws: WebSocket, data: unknown): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      this.reply(ws, { ok: false, error: 'invalid_json' });
      return;
    }
    const envelopeInput = parsed && typeof parsed === 'object' && 'envelope' in (parsed as Record<string, unknown>)
      ? (parsed as { envelope: unknown }).envelope
      : null;
    // 速率限制响应携带 message_id，客户端可按请求关联拒绝原因。
    const probeMessageId = envelopeInput && typeof envelopeInput === 'object'
      ? (envelopeInput as { message_id?: unknown }).message_id
      : undefined;
    // 统一入站速率限制（S-06）：消息级共享预算（解析后、完整校验前）。
    if (this.inboundLimiter) {
      const rate = this.inboundLimiter.tryAcquire(this.now());
      if (!rate.ok) {
        this.auditReject('rate_limited', { path: WS_PATH });
        this.reply(ws, { ok: false, error: 'rate_limited', retry_after_ms: rate.retryAfterMs, message_id: probeMessageId });
        return;
      }
    }
    if (envelopeInput === null) {
      this.reply(ws, { ok: false, error: 'missing_envelope' });
      return;
    }
    const integrity = p3394CheckEnvelopeDigests(envelopeInput);
    if (integrity.ok === false) {
      this.reply(ws, { ok: false, error: integrity.error, message_id: probeMessageId });
      return;
    }
    const validation = validateP3394Envelope(envelopeInput);
    if (validation.ok === false) {
      this.reply(ws, { ok: false, error: validation.error.reason, message_id: probeMessageId });
      return;
    }
    let rejected: { message: string } | null = null;
    for (const listener of [...this.listeners]) {
      const result = listener(validation.envelope);
      if (result && result.ok === false && !rejected) rejected = result.error ?? null;
    }
    if (rejected) {
      this.reply(ws, { ok: false, error: rejected.message ?? 'rejected', message_id: probeMessageId });
      return;
    }
    this.reply(ws, { ok: true, message_id: validation.envelope.message_id });
  }

  private reply(ws: WebSocket, body: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(body));
  }

  /** Channel contract dial; negotiation results are available via negotiate(). */
  async dial(_peerId = ''): Promise<void> {
    const negotiation = await this.negotiate();
    if (negotiation.ok === false) throw new Error(negotiation.error.message);
    await this.openDialSocket(negotiation.peer_agent_id);
  }

  /** Negotiates with the dial endpoints: manifest + identity + capability check. */
  async negotiate(): Promise<P3394WebSocketNegotiationResult> {
    if (this.closed) throw new Error('p3394_channel_closed');
    const dialConfig = this.options.dial;
    if (!dialConfig || dialConfig.endpoints.length === 0) {
      return { ok: false, error: { reason: 'no_endpoints', message: 'P3394 websocket channel has no dial endpoints' } };
    }
    let lastError = 'no_endpoints_reached';
    for (const endpoint of dialConfig.endpoints) {
      try {
        const manifest = await this.fetchManifest(endpoint, dialConfig);
        if (this.peerManifest && manifest.identity.agent_id !== this.peerManifest.identity.agent_id) {
          lastError = 'identity_changed_across_endpoints';
          continue;
        }
        if (dialConfig.expected_identity && manifest.identity.agent_id !== dialConfig.expected_identity) {
          lastError = 'p3394_identity_mismatch';
          continue;
        }
        this.peerManifest = manifest;
        this.activeEndpoint = endpoint;
        return { ok: true, peer_agent_id: manifest.identity.agent_id, peer_manifest: manifest };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { ok: false, error: { reason: 'negotiation_failed', message: lastError } };
  }

  private fetchManifest(endpoint: string, dialConfig: P3394WebSocketDialConfig): Promise<P3394BridgeManifest> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try { url = new URL(endpoint); } catch (error) { reject(error); return; }
      const isTls = url.protocol === 'wss:' || url.protocol === 'https:';
      const transport = isTls ? https : http;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (dialConfig.bearerToken) headers.Authorization = 'Bearer ' + dialConfig.bearerToken;
      const request = transport.request({
        hostname: url.hostname,
        port: url.port ? Number(url.port) : (isTls ? 443 : 80),
        path: '/p3394/manifest',
        method: 'GET',
        headers,
        ...(isTls && dialConfig.tls ? { ca: dialConfig.tls.ca, rejectUnauthorized: dialConfig.tls.rejectUnauthorized } : {}),
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('p3394_manifest_http_' + res.statusCode));
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || body.ok !== true || !body.manifest) {
              reject(new Error('p3394_manifest_missing'));
              return;
            }
            resolve(body.manifest as P3394BridgeManifest);
          } catch {
            reject(new Error('p3394_manifest_invalid_json'));
          }
        });
      });
      request.setTimeout(this.timeoutMs(), () => {
        request.destroy(new Error('p3394_manifest_timeout'));
      });
      request.on('error', reject);
      request.end();
    });
  }

  private openDialSocket(peerAgentId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const endpoint = this.activeEndpoint;
      if (!endpoint) { reject(new Error('p3394_websocket_not_negotiated')); return; }
      const url = new URL(endpoint);
      const isTls = url.protocol === 'wss:' || url.protocol === 'https:';
      const wsUrl = (isTls ? 'wss://' : 'ws://') + url.host + WS_PATH;
      const dialConfig = this.options.dial!;
      const headers: Record<string, string> = {};
      if (dialConfig.bearerToken) headers.Authorization = 'Bearer ' + dialConfig.bearerToken;
      const socket = new WebSocket(wsUrl, {
        headers,
        ...(isTls && dialConfig.tls ? { ca: dialConfig.tls.ca, rejectUnauthorized: dialConfig.tls.rejectUnauthorized } : {}),
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('p3394_websocket_connect_timeout'));
      }, this.timeoutMs());
      socket.on('open', () => {
        clearTimeout(timer);
        this.dialSocket = socket;
        socket.on('close', () => { if (this.dialSocket === socket) this.dialSocket = null; });
        socket.on('error', () => { if (this.dialSocket === socket) this.dialSocket = null; });
        void peerAgentId;
        resolve();
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('p3394_websocket_connect_failed'));
      });
    });
  }

  /** Sends one envelope over the active dial socket; refuses semantics the peer cannot carry. */
  async send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> {
    if (this.closed) throw new Error('p3394_channel_closed');
    const socket = this.dialSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('p3394_websocket_not_connected');
    // S-03：配置 expected_identity 的通道必须协商成功，身份不符不得发送。
    if (this.options.dial?.expected_identity && !this.peerManifest) {
      throw new Error('p3394_identity_not_negotiated');
    }
    const supported = this.peerManifest?.capability_profile.supported_performatives;
    if (supported && !supported.includes(envelope.performative)) {
      throw new Error('p3394_capability_unsupported:' + envelope.performative);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        reject(new Error('p3394_websocket_send_timeout'));
      }, this.timeoutMs());
      const onMessage = (data: unknown): void => {
        let parsed: { ok?: boolean; message_id?: string; error?: string };
        try { parsed = JSON.parse(String(data)); } catch { return; }
        if (parsed.message_id !== envelope.message_id) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        if (parsed.ok === true) {
          resolve({ channel_id: this.channel_id, message_id: envelope.message_id, accepted: true });
        } else {
          reject(new Error('p3394_websocket_rejected:' + (parsed.error ?? 'unknown')));
        }
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ envelope }));
    });
  }

  async capabilities(): Promise<P3394ChannelDescriptor['capabilities']> {
    return { ...this.descriptor.capabilities };
  }

  async health(): Promise<P3394ChannelHealth> {
    return {
      ok: !this.closed,
      scheme: this.activeEndpoint ? 'p3394+wss' : 'p3394+wss',
      listener_active: this.wss !== null,
      dialer_connected: this.dialSocket !== null && this.dialSocket.readyState === WebSocket.OPEN,
    };
  }

  subscribe(listener: P3394ChannelListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.dialSocket) {
      try { this.dialSocket.close(); } catch { /* already gone */ }
      this.dialSocket = null;
    }
    for (const socket of [...this.activeSockets]) {
      try { socket.close(); } catch { /* already gone */ }
    }
    this.activeSockets.clear();
    if (this.wss) {
      try { this.wss.close(); } catch { /* already gone */ }
      this.wss = null;
    }
    await this.httpChannel.close();
  }
}
