import type { P3394Envelope } from './envelope';
import type { P3394ChannelAdapter, P3394ChannelDeliveryReceipt } from './channel-adapter';
export class P3394OutboundClient { constructor(private channel: P3394ChannelAdapter) {} send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt> { return this.channel.send(envelope); } }
