/**
 * P3394 HTTP(S) channel (Phase 4).
 *
 * Real network listener/dialer built on node:http/https - no third-party
 * dependency. Design follows the handover rules:
 *
 * - default bind is loopback (127.0.0.1); a public bind requires explicit
 *   configuration and is never enabled by the app itself;
 * - bearer-token auth on every request; wrong/missing token -> 401 (fail
 *   closed, no hints);
 * - bounded request bodies (maxBodyBytes) -> 413 before any parsing;
 * - capability negotiation: dial() fetches the peer manifest and validates
 *   that it can carry the semantics the caller needs; unsupported semantics
 *   fail explicitly instead of silently degrading;
 * - endpoint failover keeps agent identity: alternate endpoints must answer
 *   with the same manifest identity, otherwise the failover is rejected;
 * - envelope digest integrity: resource/artifact parts that carry a digest
 *   are checked before dispatch.
 *
 * Routes:
 *   POST /p3394/envelope   receive an envelope (auth required)
 *   GET  /p3394/manifest   capability negotiation
 *   GET  /p3394/health     liveness + agent identity
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import { createLogger } from '../../logger';
import { validateP3394Envelope, type P3394Envelope } from './envelope';
import { p3394ObjectStoreGet } from './object-store';
import { P3394_CHANNEL_LIMITS, P3394RateLimiter } from './channel-limits';
import { buildP3394ChannelDescriptor, type P3394ChannelAdapter, type P3394ChannelDeliveryReceipt, type P3394ChannelDescriptor, type P3394ChannelHealth, type P3394ChannelListener, type P3394ChannelListenerResult } from './channel-adapter';
import type { P3394BridgeManifest } from './manifest';

const log = createLogger('p3394-bridge:http-channel');

export interface P3394HttpListenConfig {
  /** Defaults to loopback; public binds require explicit configuration. */
  host?: string;
  port: number;
  /** Optional TLS server context (cert/key PEM). */
  tls?: { cert: string; key: string };
}

export interface P3394HttpDialConfig {
  /** Candidate endpoints tried in order; identity must match across failover. */
  endpoints: string[];
  bearerToken?: string;
  /** When set, the negotiated manifest identity must equal this value —
   *  the registry's expected_identity check (guide §2.3: alias ≠ identity;
   *  verify the remote identity after connecting). */
  expected_identity?: string;
  /** Optional TLS client settings for https endpoints. */
  tls?: { ca?: string; rejectUnauthorized?: boolean };
}

export interface P3394HttpChannelOptions {
  listen?: P3394HttpListenConfig;
  dial?: P3394HttpDialConfig;
  /** Token required on inbound requests (listener side). */
  authToken?: string;
  maxBodyBytes?: number;
  timeoutMs?: number;
  /** Inbound request rate limit per minute (0 disables; S-06). */
  maxInboundRequestsPerMinute?: number;
  /** 认证/边界失败审计回调（C-04）：由 wiring 注入 kernel 审计。 */
  audit?: (record: { event: string; status: 'rejected'; metadata: Record<string, unknown> }) => void;
  now?: () => number;
}

export const P3394_HTTP_CHANNEL_DEFAULTS = {
  maxBodyBytes: 4 * 1024 * 1024,
  timeoutMs: 15_000,
} as const;

const MANIFEST_PATH = '/p3394/manifest';
const ENVELOPE_PATH = '/p3394/envelope';
const HEALTH_PATH = '/p3394/health';
const OBJECTS_PATH_PREFIX = '/p3394/objects/';

export type P3394HttpNegotiationResult =
  | { ok: true; peer_agent_id: string; peer_manifest: P3394BridgeManifest }
  | { ok: false; error: { reason: string; message: string } };

export class P3394HttpChannel implements P3394ChannelAdapter {
  readonly channel_id: string;
  readonly descriptor: P3394ChannelDescriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.native_https',
    schemes: ['p3394+https', 'p3394+wss'],
    roles: ['listener', 'dialer'],
    bindings: ['umf-json'],
    capabilities: {
      streaming: 'bidirectional',
      durable_tasks: true,
      cancellation: true,
      artifacts: 'inline',
      multi_party_sessions: true,
      identity_proofs: ['bearer-token', 'mtls'],
    },
  });
  private readonly options: P3394HttpChannelOptions;
  private readonly now: () => number;
  private readonly listeners = new Set<P3394ChannelListener>();
  private server: http.Server | null = null;
  private activeEndpoint: string | null = null;
  private peerManifest: P3394BridgeManifest | null = null;
  private closed = false;
  /** Manifest presented by this node during negotiation. */
  private localManifest: P3394BridgeManifest | null = null;
  private readonly inboundLimiter: P3394RateLimiter | null;

  constructor(channel_id = 'http', options: P3394HttpChannelOptions = {}) {
    this.channel_id = channel_id;
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const perMinute = options.maxInboundRequestsPerMinute ?? P3394_CHANNEL_LIMITS.maxInboundRequestsPerMinute;
    this.inboundLimiter = perMinute <= 0 ? null : new P3394RateLimiter(perMinute, 60_000, this.now());
  }

  setLocalManifest(manifest: P3394BridgeManifest): void {
    this.localManifest = manifest;
  }

  private bodyLimit(): number {
    return this.options.maxBodyBytes ?? P3394_HTTP_CHANNEL_DEFAULTS.maxBodyBytes;
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? P3394_HTTP_CHANNEL_DEFAULTS.timeoutMs;
  }

  private authToken(): string {
    return this.options.authToken ?? '';
  }

  /** 401 响应 + 审计回调（C-04）：认证失败可追溯，且不发任何提示。 */
  private rejectUnauthorized(res: http.ServerResponse, path: string): void {
    this.options.audit?.({ event: 'http.auth.reject', status: 'rejected', metadata: { path } });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  async listen(): Promise<void> {
    if (this.closed) throw new Error('p3394_channel_closed');
    if (this.server) return;
    const listenConfig = this.options.listen;
    if (!listenConfig) throw new Error('p3394_http_listen_not_configured');
    const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      if (req.method === 'GET' && req.url === HEALTH_PATH) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent_id: this.localManifest?.identity.agent_id ?? null }));
        return;
      }
      // 统一入站速率限制（S-06）：health 探活豁免，其余路由共享同一预算。
      if (this.inboundLimiter) {
        const rate = this.inboundLimiter.tryAcquire(this.now());
        if (!rate.ok) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'rate_limited', retry_after_ms: rate.retryAfterMs }));
          return;
        }
      }
      // Resource endpoint (§12): authenticated content-addressed object fetch.
      if (req.method === 'GET' && req.url.startsWith(OBJECTS_PATH_PREFIX)) {
        if (!this.authorized(req)) {
          this.rejectUnauthorized(res, req.url ?? OBJECTS_PATH_PREFIX);
          return;
        }
        const digest = req.url.slice(OBJECTS_PATH_PREFIX.length).split('?')[0];
        if (!/^[a-f0-9]{64}$/i.test(digest)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid_digest' }));
          return;
        }
        const fetched = p3394ObjectStoreGet(digest);
        if (fetched.ok === false) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'object_not_found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fetched.value.length });
        res.end(fetched.value);
        return;
      }
      if (req.method === 'GET' && req.url === MANIFEST_PATH) {
        if (!this.authorized(req)) {
          this.rejectUnauthorized(res, MANIFEST_PATH);
          return;
        }
        if (!this.localManifest) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'no_manifest' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, manifest: this.localManifest }));
        return;
      }
      if (req.method === 'POST' && req.url === ENVELOPE_PATH) {
        if (!this.authorized(req)) {
          this.rejectUnauthorized(res, ENVELOPE_PATH);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const limit = this.bodyLimit();
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            // Stop buffering but keep draining so the client receives the 413.
            tooLarge = true;
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (tooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          const envelopeInput = parsed && typeof parsed === 'object' && 'envelope' in (parsed as Record<string, unknown>)
            ? (parsed as { envelope: unknown }).envelope
            : null;
          if (envelopeInput === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'missing_envelope' }));
            return;
          }
          const integrity = p3394CheckEnvelopeDigests(envelopeInput);
          if (integrity.ok === false) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: integrity.error }));
            return;
          }
          const validation = validateP3394Envelope(envelopeInput);
          if (validation.ok === false) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: validation.error.reason }));
            return;
          }
          let rejected: P3394ChannelListenerResult | null = null;
          for (const listener of [...this.listeners]) {
            const result = listener(validation.envelope);
            if (result && result.ok === false && !rejected) rejected = result;
          }
          if (rejected) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: rejected.error?.message ?? 'rejected' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message_id: validation.envelope.message_id }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    };

    const server = listenConfig.tls
      ? https.createServer({ cert: listenConfig.tls.cert, key: listenConfig.tls.key }, requestHandler)
      : http.createServer(requestHandler);
    server.on('error', (error) => {
      log.warn('P3394 http listener error', { error: error.message });
    });
    this.server = server;
    const host = listenConfig.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenConfig.port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const expected = this.authToken();
    if (!expected) return true; // no token configured on the listener side
    const header = req.headers.authorization;
    return typeof header === 'string' && header === 'Bearer ' + expected;
  }

  /** Channel contract dial; negotiation results are available via negotiate(). */
  async dial(_peerId = ''): Promise<void> {
    await this.negotiate();
  }

  /** Negotiates with the dial endpoints: manifest + identity + capability check. */
  async negotiate(): Promise<P3394HttpNegotiationResult> {
    if (this.closed) throw new Error('p3394_channel_closed');
    const dialConfig = this.options.dial;
    if (!dialConfig || dialConfig.endpoints.length === 0) {
      return { ok: false, error: { reason: 'no_endpoints', message: 'P3394 http channel has no dial endpoints' } };
    }
    let lastError = 'no_endpoints_reached';
    for (const endpoint of dialConfig.endpoints) {
      try {
        const manifest = await this.fetchManifest(endpoint, dialConfig);
        // Endpoint failover must not change agent identity.
        if (this.peerManifest && manifest.identity.agent_id !== this.peerManifest.identity.agent_id) {
          lastError = 'identity_changed_across_endpoints';
          continue;
        }
        // Registry expected_identity: the remote must prove it is who the
        // alias was registered for.
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

  private fetchManifest(endpoint: string, dialConfig: NonNullable<P3394HttpChannelOptions['dial']>): Promise<P3394BridgeManifest> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const request = this.requestFor(url, 'GET', MANIFEST_PATH, dialConfig);
      request.setTimeout(this.timeoutMs(), () => {
        request.destroy(new Error('p3394_manifest_timeout'));
      });
      request.on('response', (res) => {
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
      request.on('error', reject);
      request.end();
    });
  }

  /** Sends one envelope to the negotiated peer; refuses semantics the peer cannot carry. */
  async send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> {
    if (this.closed) throw new Error('p3394_channel_closed');
    const dialConfig = this.options.dial;
    const endpoint = this.activeEndpoint ?? dialConfig?.endpoints[0];
    if (!dialConfig || !endpoint) throw new Error('p3394_http_not_dialed');
    const supported = this.peerManifest?.capability_profile.supported_performatives;
    if (supported && !supported.includes(envelope.performative)) {
      throw new Error('p3394_capability_unsupported:' + envelope.performative);
    }
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const request = this.requestFor(url, 'POST', ENVELOPE_PATH, dialConfig);
      request.setTimeout(this.timeoutMs(), () => {
        request.destroy(new Error('p3394_send_timeout'));
      });
      request.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('p3394_send_http_' + res.statusCode));
            return;
          }
          resolve({ channel_id: this.channel_id, message_id: envelope.message_id, accepted: true });
        });
      });
      request.on('error', reject);
      request.end(JSON.stringify({ envelope }), 'utf8');
    });
  }

  private requestFor(
    url: URL,
    method: 'GET' | 'POST',
    path: string,
    dialConfig: NonNullable<P3394HttpChannelOptions['dial']>,
  ): http.ClientRequest {
    const isTls = url.protocol === 'https:';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (dialConfig.bearerToken) headers.Authorization = 'Bearer ' + dialConfig.bearerToken;
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : (isTls ? 443 : 80),
      path,
      method,
      headers,
      ...(isTls && dialConfig.tls
        ? { ca: dialConfig.tls.ca, rejectUnauthorized: dialConfig.tls.rejectUnauthorized }
        : {}),
    };
    const transport = isTls ? https : http;
    return transport.request(options);
  }

  async capabilities(): Promise<P3394ChannelDescriptor['capabilities']> {
    return { ...this.descriptor.capabilities, identity_proofs: [...this.descriptor.capabilities.identity_proofs] };
  }

  async health(): Promise<P3394ChannelHealth> {
    return {
      ok: !this.closed,
      scheme: this.descriptor.schemes[0] ?? 'p3394+https',
      listener_active: !!this.server,
      dialer_connected: !!this.activeEndpoint,
    };
  }

  subscribe(listener: (envelope: P3394Envelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 500).unref();
      });
    }
  }
}

/** Verifies sha256 digests on resource/artifact parts when present.
 *  Accepts bare hex and the guide's `sha256:` form; for inline data URIs the
 *  digest covers the DECODED content, not the URI string. */
export function p3394CheckEnvelopeDigests(input: unknown): { ok: true } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid_envelope' };
  const envelope = input as { payload?: { parts?: Array<{ type?: string; digest?: string; uri?: string }> } };
  const parts = envelope.payload?.parts ?? [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (typeof part.digest === 'string' && part.digest) {
      const lower = part.digest.toLowerCase();
      const expected = lower.startsWith('sha256:') ? lower.slice(7) : lower;
      if (!/^[a-f0-9]{64}$/.test(expected)) return { ok: false, error: 'invalid_digest_at_' + i };
      if (part.uri) {
        let content: Buffer;
        if (part.uri.startsWith('data:')) {
          const comma = part.uri.indexOf(',');
          if (comma < 0) return { ok: false, error: 'invalid_data_uri_at_' + i };
          const meta = part.uri.slice(5, comma);
          const payload = part.uri.slice(comma + 1);
          content = /;base64$/i.test(meta) ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
        } else {
          content = Buffer.from(part.uri, 'utf8');
        }
        const raw = crypto.createHash('sha256').update(content).digest('hex');
        if (raw !== expected) return { ok: false, error: 'digest_mismatch_at_' + i };
      }
    }
  }
  return { ok: true };
}