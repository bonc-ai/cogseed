export interface P3394IdempotencyReceipt<T = unknown> { sender_id: string; key: string; result: T; created_at: string }
export type P3394IdempotencyResult<T> = { replay: false; receipt: P3394IdempotencyReceipt<T> } | { replay: true; receipt: P3394IdempotencyReceipt<T> };

export class P3394IdempotencyStore<T = unknown> {
  private receipts = new Map<string, P3394IdempotencyReceipt<T>>();
  private compound(sender: string, key: string): string { return `${sender}\u0000${key}`; }
  record(sender_id: string, key: string, result: T, now = new Date().toISOString()): P3394IdempotencyResult<T> {
    const existing = this.receipts.get(this.compound(sender_id, key));
    if (existing) return { replay: true, receipt: existing };
    const receipt = { sender_id, key, result, created_at: now };
    this.receipts.set(this.compound(sender_id, key), receipt);
    return { replay: false, receipt };
  }
}
