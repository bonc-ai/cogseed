export type P3394ReplayCheck = { ok: true; epoch: number } | { ok: false; error: { reason: 'replay_detected' | 'invalid_epoch'; field: string; message: string; epoch: number } };

export class P3394ReplayProtector {
  private watermarks = new Map<string, number>();
  admit(sender_id: string, epoch: number): P3394ReplayCheck {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return { ok: false, error: { reason: 'invalid_epoch', field: 'epoch', message: 'Epoch must be a non-negative safe integer.', epoch: this.watermarks.get(sender_id) ?? -1 } };
    const current = this.watermarks.get(sender_id) ?? -1;
    if (epoch <= current) return { ok: false, error: { reason: 'replay_detected', field: 'epoch', message: `Epoch ${epoch} <= watermark ${current}.`, epoch: current } };
    this.watermarks.set(sender_id, epoch);
    return { ok: true, epoch };
  }
}
