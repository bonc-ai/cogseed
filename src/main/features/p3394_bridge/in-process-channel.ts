import type { P3394Envelope } from './envelope';
import { buildP3394ChannelDescriptor, type P3394ChannelAdapter, type P3394ChannelDeliveryReceipt, type P3394ChannelDescriptor, type P3394ChannelHealth } from './channel-adapter';

export class P3394InProcessChannel implements P3394ChannelAdapter {
  private listeners = new Set<(e: P3394Envelope) => void>();
  private closed = false;
  readonly descriptor: P3394ChannelDescriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.in_process',
    schemes: ['p3394+inprocess'],
    roles: ['listener', 'dialer'],
    bindings: ['umf-json'],
    capabilities: {
      streaming: 'bidirectional',
      durable_tasks: false,
      cancellation: true,
      artifacts: 'inline',
      multi_party_sessions: true,
      identity_proofs: ['in-process-trust'],
    },
  });

  constructor(readonly channel_id = 'in-process') {}

  async listen() {}
  async dial() {}
  async health(): Promise<P3394ChannelHealth> {
    return { ok: !this.closed, scheme: 'p3394+inprocess', listener_active: !this.closed, dialer_connected: !this.closed };
  }

  async send(e: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> {
    if (this.closed) throw new Error('p3394_channel_closed');
    for (const l of [...this.listeners]) l(e);
    return { channel_id: this.channel_id, message_id: e.message_id, accepted: true };
  }

  subscribe(l: (e: P3394Envelope) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async close() {
    this.closed = true;
    this.listeners.clear();
  }
}
