import {
  normalizeP3394AgentMessage,
  type NormalizeP3394AgentMessageInput,
  type P3394NormalizeResult,
  type P3394LiteMessage,
  type P3394AgentError,
} from './protocol';
import { p3394EpochStreamKey } from './epoch-store';
import { createLogger } from '../../logger';

const log = createLogger('p3394.controller');

// 会话解析结果:由外部 session-store 提供,把 sessionId 映射到真实 kind/region。
export interface SessionResolution { sessionId: string; kind: string; region: string; valid: boolean; }
export interface SessionSource { resolve(sessionId: string): Promise<SessionResolution>; }

// epoch 水位存储(EpochStore 兼容形状):防重复投递。
// admit 原子判定重放 + 推进水位(max(水位,incomingEpoch)),消除 TOCTOU。current/nextEpoch 保留供其它调用点。
export interface EpochStoreLike {
  current(uid: string, sessionId: string): Promise<number>;
  nextEpoch(uid: string, sessionId: string): Promise<number>;
  admit(uid: string, sessionId: string, incomingEpoch?: number): Promise<{ replay: boolean; epoch: number }>;
}

// context 快照用于校验消息声明的协作 context 是否属于当前 workflow。
export interface ContextSourceSnapshot { context_id: string; status: string; }
export interface ContextSource { snapshot(uid: string, cid: string): Promise<ContextSourceSnapshot | null>; }

export interface AdmitInput extends NormalizeP3394AgentMessageInput {
  uid: string;
  sessionId: string;
  incomingEpoch?: number;
}

interface ControllerDeps { sessionSource: SessionSource; epochStore: EpochStoreLike; contextSource: ContextSource; }

/**
 * P3394Controller —— 外包无状态内核 normalizeP3394AgentMessage,叠加有状态裁决:
 *   1. session 解析(带 kind/region,IO 失败降级放行,标 session_resolved:false)
 *   2. epoch 水位(重放拦截 + 单调递增,IO 失败降级 epoch=0)
 *   3. context 归属裁决(context 越界拒绝,读取失败降级放行)
 * 不改内核逻辑:capability/speechAct/executable/委托 四道校验仍由内核完成。
 */
export class P3394Controller {
  constructor(private deps: ControllerDeps) {}

  async admitMessage(input: AdmitInput): Promise<P3394NormalizeResult> {
    const base = normalizeP3394AgentMessage(input);
    if (!base.ok) return base;
    const message = base.message;

    // session 解析:成功写真实 kind/region/valid;IO 失败降级放行只标 resolved:false。
    try {
      const res = await this.deps.sessionSource.resolve(input.sessionId);
      (message.metadata as any).session_kind = res.kind;
      (message.metadata as any).session_region = res.region;
      (message.metadata as any).session_resolved = res.valid;
    } catch (e) {
      (message.metadata as any).session_resolved = false;
      log.warn('p3394 session resolve failed, degraded pass', { uid: input.uid, sessionId: input.sessionId, error: (e as Error).message });
    }

    // epoch 水位:原子判定重放 + 推进(见过的最大 epoch);IO 失败降级 epoch=0。
    try {
      const streamId = p3394EpochStreamKey(input.sender, input.sessionId);
      const res = await this.deps.epochStore.admit(input.uid, streamId, input.incomingEpoch);
      if (res.replay) {
        return makeControllerError(input, 'replay_detected', `epoch ${input.incomingEpoch} <= watermark ${res.epoch}`);
      }
      message.metadata.session_epoch = res.epoch;
    } catch (e) {
      message.metadata.session_epoch = 0;
      (message.metadata as any).epoch_degraded = true;
      log.warn('p3394 epoch watermark failed, degraded epoch=0', { uid: input.uid, sessionId: input.sessionId, error: (e as Error).message });
    }

    const ctx = await this.assessContext(input, message);
    if (ctx) return ctx;

    return { ok: true, message };
  }

  // 基于 contextSource 做 context 作用域裁决,可返回 context_scope_violation。
  protected async assessContext(input: AdmitInput, message: P3394LiteMessage): Promise<P3394NormalizeResult | null> {
    const claimed = message.metadata.collaboration?.context_id;
    if (!claimed) return null;
    let snap: ContextSourceSnapshot | null;
    try {
      snap = await this.deps.contextSource.snapshot(input.uid, input.conversationId);
    } catch (err) {
      log.warn('p3394 context snapshot read failed, skipping context scope check', { uid: input.uid, cid: input.conversationId, error: (err as Error).message });
      return null;
    }
    if (!snap) return null;
    if (snap.context_id !== claimed) {
      return makeControllerError(input, 'context_scope_violation', `context ${claimed} not in workflow ${snap.context_id}`);
    }
    return null;
  }
}

export function makeControllerError(input: AdmitInput, reason: 'replay_detected' | 'context_scope_violation', detail: string): P3394NormalizeResult {
  const messageId = `p3394-${input.conversationId}-${input.turnId}`;
  const error: P3394AgentError = {
    message_id: `${messageId}-error`,
    sender: input.agent.agent_id,
    recipient: input.sender,
    message_type: 'agent.error',
    correlation_id: input.conversationId,
    canonical_session_id: input.conversationId,
    timestamp: new Date().toISOString(),
    content_type: 'application/json',
    body: { reason_code: reason, detail, original_message_id: messageId },
  };
  return { ok: false, error };
}
