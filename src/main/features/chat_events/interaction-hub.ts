// ─── 通用双向交互枢纽（conv-core M2） ──────────────────────────────────────
//
// 把 bridge-permissions / launch-confirm 两处各自为政的「请求-等待-超时
// 拒绝」审批骨架泛化为统一 InteractionHub：审批（approval）与提问
// （question）都走这里。语义（对照 bridge.js 先例与 spec.md 契约）：
//   - 超时按 deny/放弃处理，绝不悬停；
//   - 晚到回复幂等吞掉（交互已关闭后再回复无害）；
//   - Turn 取消时连带关闭其未决交互（reason=turnCancelled）；
//   - 下发经注入的 broadcast 回调（由 ipc 层接到当前活跃的会话流，
//     事件形状=chat.interaction.requested / chat.interaction.closed）。
//
// 本模块不持久化「always allow」——记忆策略归各调用方（如
// bridge-permissions 的机器私有存储），hub 只管一次交互的生命周期。

import * as crypto from 'node:crypto';

import { createLogger } from '../../logger';

const log = createLogger('chat-interaction');

export const DEFAULT_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

export interface InteractionRequestInput {
  uid: string;
  cid: string;
  turnId: string;
  kind: 'approval' | 'question';
  /** approval：危险动作描述；question：问题文本。 */
  prompt: string;
  detail?: string;
  timeoutMs?: number;
  /** approval 专用：动作类别（bash/文件写入/外部服务），UI 图标用。 */
  approvalCategory?: 'bash' | 'fileWrite' | 'externalService';
}

export interface InteractionResolved {
  interactionId: string;
  reason: 'answered' | 'timeout' | 'turnCancelled';
  /** approval 场景的决策；timeout/turnCancelled 时为 deny。 */
  decision?: 'allow' | 'allowAlways' | 'deny';
  /** question 场景的用户回复；非 answered 时为空。 */
  answer?: string;
}

interface PendingEntry {
  input: InteractionRequestInput;
  resolve: (value: InteractionResolved) => void;
  timer: NodeJS.Timeout;
}

/** broadcast 由 ipc 层注入：把事件塞进该 (uid,cid) 的活跃会话流。 */
export type InteractionBroadcast = (uid: string, event: unknown) => void;

const _pending = new Map<string, PendingEntry>();
let _broadcast: InteractionBroadcast | null = null;

export function _setBroadcastForTest(fn: InteractionBroadcast | null): void {
  _broadcast = fn;
}

export function setInteractionBroadcast(fn: InteractionBroadcast | null): void {
  _broadcast = fn;
}

function requestEvent(interactionId: string, input: InteractionRequestInput) {
  return {
    type: 'chat.interaction.requested' as const,
    turnId: input.turnId,
    interactionId,
    kind: input.kind,
    prompt: input.prompt,
    /** 路由用：ipc 层据此把事件送进对应会话的活跃流。 */
    cid: input.cid,
    ...(input.detail ? { detail: input.detail } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS,
    ...(input.kind === 'approval' && input.approvalCategory
      ? { approvalCategory: input.approvalCategory }
      : {}),
  };
}

function closedEvent(interactionId: string, reason: InteractionResolved['reason'], cid: string) {
  return {
    type: 'chat.interaction.closed' as const,
    interactionId,
    reason,
    /** 路由用，与 requested 对称。 */
    cid,
  };
}

/**
 * 发起一次交互并等待结果。永不 reject——超时/取消都走 resolve（值里
 * 带 reason），调用方只需一条路径处理。
 */
export function requestInteraction(input: InteractionRequestInput): Promise<InteractionResolved> {
  const interactionId = crypto.randomBytes(8).toString('hex');
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;

  return new Promise<InteractionResolved>((resolve) => {
    const finish = (value: InteractionResolved) => {
      const entry = _pending.get(interactionId);
      if (entry) {
        _pending.delete(interactionId);
        clearTimeout(entry.timer);
      }
      try {
        _broadcast?.(input.uid, closedEvent(interactionId, value.reason, input.cid));
      } catch (err) {
        log.warn('interaction closed-event broadcast failed', { error: String(err) });
      }
      resolve(value);
    };

    const timer = setTimeout(() => {
      log.warn('chat interaction timed out → deny', {
        kind: input.kind,
        turn: input.turnId,
      });
      finish({ interactionId, reason: 'timeout', ...(input.kind === 'approval' ? { decision: 'deny' as const } : {}) });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    _pending.set(interactionId, { input, resolve: finish, timer });
    try {
      _broadcast?.(input.uid, requestEvent(interactionId, input));
    } catch (err) {
      log.warn('interaction request broadcast failed', { error: String(err) });
      // 推送失败不等超时：立即拒绝，让调用方拿到快速反馈。
      finish({ interactionId, reason: 'timeout', ...(input.kind === 'approval' ? { decision: 'deny' as const } : {}) });
    }
  });
}

/** 渲染层回复（IPC chat.interaction.reply）。晚到/未知 id 返回 false。 */
export function respondInteraction(
  interactionId: string,
  payload: { decision?: unknown; answer?: unknown },
): boolean {
  const entry = _pending.get(interactionId);
  if (!entry) return false;

  if (entry.input.kind === 'approval') {
    const decision = payload.decision === 'allowAlways' ? 'allowAlways'
      : payload.decision === 'allow' ? 'allow'
      : 'deny';
    entry.resolve({ interactionId, reason: 'answered', decision });
    return true;
  }
  // question：任意文本均可（空串=跳过回答）。
  const answer = typeof payload.answer === 'string' ? payload.answer : '';
  entry.resolve({ interactionId, reason: 'answered', answer });
  return true;
}

/** Turn 取消连带：关闭该 Turn 的全部未决交互（避免悬空等待占住 worker）。 */
export function cancelInteractionsForTurn(turnId: string): number {
  let closed = 0;
  for (const [id, entry] of _pending) {
    if (entry.input.turnId !== turnId) continue;
    entry.resolve({
      interactionId: id,
      reason: 'turnCancelled',
      ...(entry.input.kind === 'approval' ? { decision: 'deny' as const } : {}),
    });
    closed += 1;
  }
  return closed;
}

/** 测试与诊断用：当前未决数。 */
export function pendingInteractionCount(): number {
  return _pending.size;
}
