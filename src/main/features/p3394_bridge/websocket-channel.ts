import { P3394InProcessChannel } from './in-process-channel';
import { buildP3394ChannelDescriptor } from './channel-adapter';

export interface P3394WebSocketChannelConfig { enabled: boolean; bind?: string; auth_token?: string }

export class P3394WebSocketChannel extends P3394InProcessChannel {
  override readonly descriptor = buildP3394ChannelDescriptor({
    id: 'org.p3394.channel.websocket',
    schemes: ['p3394+wss'],
    roles: ['listener', 'dialer'],
    bindings: ['umf-json'],
    capabilities: {
      streaming: 'bidirectional',
      durable_tasks: false,
      cancellation: true,
      artifacts: 'inline',
      multi_party_sessions: true,
      identity_proofs: ['bearer-token'],
    },
  });

  constructor(readonly config: P3394WebSocketChannelConfig) { super('websocket'); }

  override async listen() {
    if (!this.config.enabled) throw new Error('p3394_websocket_channel_disabled');
    if (!this.config.auth_token) throw new Error('p3394_websocket_auth_required');
  }
}
