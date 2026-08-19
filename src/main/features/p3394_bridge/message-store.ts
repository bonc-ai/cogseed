import type { P3394Envelope } from './envelope';
export class P3394BridgeMessageStore { private messages = new Map<string, P3394Envelope>(); add(e: P3394Envelope): void { if (this.messages.has(e.message_id)) throw new Error('p3394_duplicate_message'); this.messages.set(e.message_id, e); } get(id: string): P3394Envelope | undefined { return this.messages.get(id); } }
