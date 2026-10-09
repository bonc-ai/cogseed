import type { P3394Envelope } from './envelope';
import { P3394BridgeKernel, type P3394BridgeSendResult } from './bridge';
export class P3394InboundServer { constructor(private bridge: P3394BridgeKernel) {} receive(envelope: P3394Envelope): P3394BridgeSendResult { return this.bridge.send(envelope); } }
