/**
 * P3394 Unix Socket channel (Phase 3).
 *
 * Real same-host listener/dialer over a Unix domain socket with:
 *
 * - length-prefixed JSON frames (4-byte big-endian length header) so messages
 *   never stick together;
 * - mandatory instance-token handshake: the first frame after connect must be
 *   an auth frame; the listener destroys the socket on mismatch (fail-closed);
 * - bounded frames (maxFrameBytes), bounded pending writes and concurrent
 *   connections so a runaway peer cannot exhaust memory;
 * - reconnect with backoff for the dial side;
 * - graceful shutdown that stops the server, closes sockets and removes the
 *   socket file.
 *
 * The channel speaks envelope frames: { t: 'envelope', envelope } and
 * { t: 'auth', token }. Unknown/oversized frames are rejected at the frame
 * layer before any envelope parsing.
 */

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createLogger } from '../../logger';
import type { P3394Envelope } from './envelope';
import { buildP3394ChannelDescriptor, type P3394ChannelAdapter, type P3394ChannelDeliveryReceipt, type P3394ChannelDescriptor, type P3394ChannelHealth } from './channel-adapter';
import { p3394CheckEnvelopeDigests } from './http-channel';

const log = createLogger('p3394-bridge:unix-socket-channel');

export interface P3394UnixSocketChannelOptions {
  /** Socket file path. Defaults to an os.tmpdir() path derived from the channel id. */
  socketPath?: string;
  /** Instance token required from dialers. If omitted a random token is generated. */
  token?: string;
  /** Maximum frame payload bytes (default 1 MiB). */
  maxFrameBytes?: number;
  /** Maximum accepted concurrent connections (default 16). */
  maxConnections?: number;
  /** Maximum buffered outbound frames per connection (default 64). */
  maxPendingFrames?: number;
  /** Reconnect base delay ms for the dialer (default 250). */
  reconnectBaseMs?: number;
  /** Clock for diagnostics. */
  now?: () => number;
}

export const P3394_UNIX_SOCKET_DEFAULTS = {
  maxFrameBytes: 1 * 1024 * 1024,
  maxConnections: 16,
  maxPendingFrames: 64,
  reconnectBaseMs: 250,
} as const;

const FRAME_HEADER_BYTES = 4;
const AUTH_FRAME = 'auth';
const ENVELOPE_FRAME = 'envelope';

type SocketFramePayload = { t: 'auth'; token: string } | { t: 'envelope'; envelope: P3394Envelope }

function writeFrame(socket: net.Socket, payload: SocketFramePayload, onFlushed?: (error?: Error) => void): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([header, body]), onFlushed);
}

export class P3394UnixSocketChannel implements P3394ChannelAdapter {
  readonly channel_id: string;
  readonly descriptor: P3394ChannelDescriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.unix_socket',
    schemes: ['p3394+unix'],
    roles: ['listener', 'dialer'],
    bindings: ['umf-json'],
    capabilities: {
      streaming: 'bidirectional',
      durable_tasks: false,
      cancellation: true,
      artifacts: 'inline',
      multi_party_sessions: true,
      identity_proofs: ['instance-token'],
    },
  });
  private readonly options: P3394UnixSocketChannelOptions;
  private readonly token: string;
  private readonly socketPath: string;
  private server: net.Server | null = null;
  private readonly listeners = new Set<(envelope: P3394Envelope) => void>();
  private readonly sockets = new Set<net.Socket>();
  private client: net.Socket | null = null;
  private clientPendingFrames = 0;
  /** Frames accepted locally but not flushed to the current socket. */
  private readonly clientUnacked = new Map<string, P3394Envelope>();
  private clientAuthSent = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private listening = false;

  constructor(channel_id = 'unix-socket', options: P3394UnixSocketChannelOptions = {}) {
    this.channel_id = channel_id;
    this.options = options;
    this.token = options.token ?? `p3394-token-${Math.random().toString(36).slice(2)}mssuect9`;
    this.socketPath = options.socketPath
      ?? path.join(os.tmpdir(), `p3394-${channel_id.replace(/[^a-zA-Z0-9-]/g, '-')}-${process.pid}.sock`);
  }

  private frameLimit(): number {
    return this.options.maxFrameBytes ?? P3394_UNIX_SOCKET_DEFAULTS.maxFrameBytes;
  }

  /** Starts the listener (idempotent). */
  async listen(): Promise<void> {
    if (this.listening) return;
    const maxConnections = this.options.maxConnections ?? P3394_UNIX_SOCKET_DEFAULTS.maxConnections;
    const server = net.createServer((socket) => {
      if (this.sockets.size >= maxConnections) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      let authenticated = false;
      const onEnd = () => {
        this.sockets.delete(socket);
        socket.destroy();
      };
      socket.on('error', () => this.sockets.delete(socket));
      socket.on('close', onEnd);
      this.attachFrameReader(socket, (payload) => {
        if (!authenticated) {
          if (payload.t !== AUTH_FRAME || payload.token !== this.token) {
            // fail-closed: refuse the peer without revealing anything.
            socket.destroy();
            this.sockets.delete(socket);
            return;
          }
          authenticated = true;
          return;
        }
        if (payload.t === ENVELOPE_FRAME) {
          // Envelope digest integrity is enforced before dispatch (fail closed).
          if (p3394CheckEnvelopeDigests(payload.envelope).ok === false) {
            socket.destroy();
            this.sockets.delete(socket);
            return;
          }
          for (const listener of [...this.listeners]) listener(payload.envelope);
        }
      });
    });
    server.on('error', (error) => {
      log.warn('P3394 unix socket listener error', { path: this.socketPath, error: error.message });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.listening = true;
  }

  /** Connects the dialer with reconnect/backoff. */
  async dial(_peerId = ''): Promise<void> {
    if (this.client && !this.client.destroyed) return;
    this.stopping = false;
    this.clientAuthSent = false;
    await this.connectOnce();
  }

  private async connectOnce(): Promise<void> {
    if (this.stopping) return;
    const client = net.createConnection(this.socketPath);
    this.client = client;
    this.clientPendingFrames = 0;
    let authed = false;
    client.on('connect', () => {
      this.reconnectAttempts = 0;
      writeFrame(client, { t: AUTH_FRAME, token: this.token });
      this.clientAuthSent = true;
      authed = true;
      for (const envelope of this.clientUnacked.values()) this.writeEnvelope(client, envelope);
    });
    client.on('error', () => {
      if (this.client === client) this.client = null;
      this.scheduleReconnect();
    });
    client.on('close', () => {
      if (this.client === client) this.client = null;
      this.scheduleReconnect();
    });
    this.attachFrameReader(client, (payload) => {
      if (payload.t === ENVELOPE_FRAME) {
        for (const listener of [...this.listeners]) listener(payload.envelope);
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const base = this.options.reconnectBaseMs ?? P3394_UNIX_SOCKET_DEFAULTS.reconnectBaseMs;
    const delay = Math.min(base * 2 ** this.reconnectAttempts, 5000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) {
        void this.connectOnce().catch(() => this.scheduleReconnect());
      }
    }, delay);
  }

  private attachFrameReader(
    socket: net.Socket,
    onPayload: (payload: SocketFramePayload) => void,
  ): void {
    let buffer = Buffer.alloc(0);
    let expected: number | null = null;
    let pendingBody = Buffer.alloc(0);
    const limit = this.frameLimit();
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (expected === null) {
          if (buffer.length < FRAME_HEADER_BYTES) return;
          const size = buffer.readUInt32BE(0);
          if (size === 0 || size > limit) {
            socket.destroy();
            return;
          }
          expected = size;
          pendingBody = Buffer.alloc(0);
        }
        if (buffer.length < FRAME_HEADER_BYTES + expected) return;
        pendingBody = buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + expected);
        buffer = buffer.subarray(FRAME_HEADER_BYTES + expected);
        expected = null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(pendingBody.toString('utf8'));
        } catch {
          socket.destroy();
          return;
        }
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as { t?: unknown }).t !== 'string') {
          socket.destroy();
          return;
        }
        onPayload(parsed as SocketFramePayload);
      }
    });
  }

  private writeEnvelope(client: net.Socket, envelope: P3394Envelope): void {
    this.clientPendingFrames += 1;
    writeFrame(client, { t: ENVELOPE_FRAME, envelope }, (error) => {
      this.clientPendingFrames = Math.max(0, this.clientPendingFrames - 1);
      // 只有确认写出成功才从未确认缓存移除；写失败（断线/销毁）保留，
      // 由重连逻辑按原 message_id 重发，避免 flush 失败即丢语义消息。
      if (!error) this.clientUnacked.delete(envelope.message_id);
    });
  }

  /** Sends an envelope to the dialed peer (auto-connect on first send). */
  async send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> {
    if (this.stopping) throw new Error('p3394_channel_closed');
    if (!this.client || this.client.destroyed) {
      await this.dial();
    }
    const client = this.client;
    if (!client || !client.writable) throw new Error('p3394_channel_not_connected');
    const maxPending = this.options.maxPendingFrames ?? P3394_UNIX_SOCKET_DEFAULTS.maxPendingFrames;
    if (this.clientPendingFrames >= maxPending) throw new Error('p3394_channel_backpressure');
    this.clientUnacked.set(envelope.message_id, envelope);
    this.writeEnvelope(client, envelope);
    return { channel_id: this.channel_id, message_id: envelope.message_id, accepted: true };
  }

  async health(): Promise<P3394ChannelHealth> {
    return {
      ok: !this.stopping,
      scheme: 'p3394+unix',
      listener_active: this.listening,
      dialer_connected: !!this.client && !this.client.destroyed,
    };
  }

  subscribe(listener: (envelope: P3394Envelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops the listener and dialer, closes sockets and removes the socket file. */
  async close(): Promise<void> {
    this.stopping = true;
    this.clientPendingFrames = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.listeners.clear();
    const client = this.client;
    this.client = null;
    if (client && !client.destroyed) client.destroy();
    const server = this.server;
    this.server = null;
    this.listening = false;
    if (server) {
      await new Promise<void>((resolve) => {
        for (const socket of [...this.sockets]) socket.destroy();
        this.sockets.clear();
        server.close(() => resolve());
        // Never hang shutdown on a half-open connection.
        setTimeout(resolve, 500).unref();
      });
    }
    // A dialer may share this path with the peer's listener. Only the owner
    // of the listening server may remove the socket file during shutdown.
    if (server) await fs.promises.rm(this.socketPath, { force: true }).catch(() => {});
  }
}
