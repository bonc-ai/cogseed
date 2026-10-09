/**
 * §15 Human Approval（敏感操作人工确认）：入站信封显式请求人工确认的
 * 挂起语义。纯函数 + 状态容器，executor 只做接线。
 *
 * 协议约定：
 * - 任务信封 payload.metadata.requires_approval === true → 执行前挂起
 *   （任务置 input-required），等待 performative='accept' 的控制帧批准
 *   或 'cancel' 终止；批准后以唯一幂等键重放原信封（metadata 标志清除）。
 * - 请求/批准/拒绝全程审计（不泄露 secret）。
 */

import type { P3394Envelope } from './envelope';

export const APPROVAL_REQUESTED_EVENT = 'approval.requested';
export const APPROVAL_GRANTED_EVENT = 'approval.granted';
export const APPROVAL_REJECTED_EVENT = 'approval.rejected';

/** 信封是否请求人工确认（§15 Sensitive Action）。 */
export function requiresHumanApproval(envelope: P3394Envelope): boolean {
  const metadata = envelope.payload && envelope.payload.metadata;
  return !!(metadata && (metadata as Record<string, unknown>).requires_approval === true);
}

/** 构造批准后的重放信封：清除审批标志，幂等键取唯一 message_id
 *  （原信封的 send 用原键，重放不冲突）。 */
export function buildApprovedReplay(envelope: P3394Envelope): P3394Envelope {
  const metadata = { ...(envelope.payload.metadata ?? {}), requires_approval: false };
  return { ...envelope, idempotency_key: envelope.message_id, payload: { ...envelope.payload, metadata } };
}

/** 挂起审批队列（task_id → 原始信封）。 */
export class P3394ApprovalQueue {
  private readonly pending = new Map<string, P3394Envelope>();

  park(taskId: string, envelope: P3394Envelope): void {
    this.pending.set(taskId, envelope);
  }

  /** 取出待批准信封（命中即出队；未命中返回 null）。 */
  take(taskId: string): P3394Envelope | null {
    const hit = this.pending.get(taskId);
    if (hit) this.pending.delete(taskId);
    return hit ?? null;
  }

  has(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  get size(): number {
    return this.pending.size;
  }
}
