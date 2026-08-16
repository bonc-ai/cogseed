/**
 * P3394 IPC channel (Phase 3).
 *
 * Real Electron IPC port for the bridge, running on the main-process side:
 *
 * - listen(): registers the port as an inbound target; renderer frames are
 *   delivered through handleInbound().
 * - handleInbound(): validates the envelope and **overrides the sender with
 *   the local agent identity** — a renderer may initiate an operation but may
 *   never declare an Agent identity or capability (identity iron rule).
 * - send(): pushes an envelope to renderers through an injected transport
 *   (broadcastToRenderer in production; fake in tests).
 *
 * The port is a plain P3394ChannelAdapter so the bridge kernel can treat it
 * like any other channel; wiring into src/main/ipc/index.ts happens at
 * composition time.
 */

import { createLogger } from '../../logger';
import { validateP3394Envelope, type P3394Envelope } from './envelope';
import { buildP3394ChannelDescriptor, type P3394ChannelAdapter, type P3394ChannelDeliveryReceipt, type P3394ChannelDescriptor } from './channel-adapter';

const log = createLogger('p3394-bridge:ipc-channel');

export interface P3394IpcChannelOptions {
  /** Resolves the local (trusted) agent identity; defaults to 'cogseed-agent'. */
  resolveLocalAgentId?: () => string;
  /** Push transport to renderers; defaults to no-op. */
  sendToRenderer?: (payload: { message_id: string; envelope: P3394Envelope }) => void;
  now?: () => string;
}

export type P3394IpcInboundResult =
  | { ok: true; envelope: P3394Envelope }
  | { ok: false; error: { reason: string; field?: string; message: string } };

export class P3394IpcChannel implements P3394ChannelAdapter {
  readonly channel_id: string;
  readonly descriptor: P3394ChannelDescriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.ipc',
    schemes: ['p3394+ipc'],
    roles: ['listener', 'dialer'],
    bindings: ['umf-json'],
    capabilities: {
      streaming: 'bidirectional',
      durable_tasks: false,
      cancellation: true,
      artifacts: 'inline',
      multi_party_sessions: true,
      identity_proofs: ['electron-ipc-trust'],
    },
  });
  private readonly resolveLocalAgentId: () => string;
  private readonly sendToRenderer: (payload: { message_id: string; envelope: P3394Envelope }) => void;
  private readonly now: () => string;
  private readonly listeners = new Set<(envelope: P3394Envelope) => void>();
  private closed = false;

  constructor(channel_id = 'ipc', options: P3394IpcChannelOptions = {}) {
    this.channel_id = channel_id;
    this.resolveLocalAgentId = options.resolveLocalAgentId ?? (() => 'cogseed-agent');
    this.sendToRenderer = options.sendToRenderer ?? (() => {});
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Marks the port active. No-op beyond state; real wiring lives in handleInbound. */
  async listen(): Promise<void> {
    if (this.closed) throw new Error('p3394_channel_closed');
  }

  async dial(_peerId = ''): Promise<void> {
    if (this.closed) throw new Error('p3394_channel_closed');
  }

  /**
   * Renderer-inbound entry point. Validates the envelope and rewrites the
   * sender to the local agent identity so untrusted renderers can never claim
   * a foreign or arbitrary identity.
   */
  handleInbound(envelopeInput: unknown): P3394IpcInboundResult {
    if (this.closed) return { ok: false, error: { reason: 'channel_closed', message: 'P3394 IPC channel is closed' } };
    const validation = validateP3394Envelope(envelopeInput);
    if (validation.ok === false) {
      return { ok: false, error: { reason: validation.error.reason, field: validation.error.field, message: validation.error.message } };
    }
    const localAgentId = this.resolveLocalAgentId();
    const envelope: P3394Envelope = {
      ...validation.envelope,
      sender: { agent_id: localAgentId },
    };
    for (const listener of [...this.listeners]) listener(envelope);
    return { ok: true, envelope };
  }

  /** Pushes an envelope to renderers (main → renderer direction). */
  async send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> {
    if (this.closed) throw new Error('p3394_channel_closed');
    this.sendToRenderer({ message_id: envelope.message_id, envelope });
    return { channel_id: this.channel_id, message_id: envelope.message_id, accepted: true };
  }

  subscribe(listener: (envelope: P3394Envelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }
}
