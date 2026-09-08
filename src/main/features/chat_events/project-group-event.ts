// ─── GroupEvent（group_chat 总线）→ chat.* 结构化事件投影 ──────────────────
//
// 主会话链路：worker 运行时经总线广播 GroupEvent（process/message/…），
// ipc/index.ts 的 conversations.sendStream 转发层订阅后下发。本投影器在
// 转发处把 GroupEvent 叠加翻译成 chat_events 契约事件：
// - process.data 即模型层 StreamEvent（delta/progress/event），复用
//   project-upstream 的逐事件投影；
// - message(turn_end=true) 是该 actor 回合的官方收尾，据此补终态；
// - state_changed / agent_run_result / artifact_created 不投影（渲染层
//   各有既有处理，chat.* 只覆盖「一条消息的生命周期」语义）。
//
// 一次用户发送可能触发多 actor/多 turn（commander 派发），按
// (actor, turn_id) 维护独立投影器状态。

import type { GroupEvent } from '../group_chat/bus';
import type { ChatStreamEvent, ChatTurnCompleted } from './types';
import {
  completeChatTurn,
  createChatEventProjectorState,
  projectUpstreamEvent,
  type ChatEventProjectorState,
} from './project-upstream';

/** 调用方持有（一次 sendStream 一个实例）。 */
export class GroupEventChatProjector {
  readonly #states = new Map<string, ChatEventProjectorState>();
  readonly #turnIds = new Map<string, string>();

  #stateFor(actor: string, turnIdHint: string | undefined, cid: string): ChatEventProjectorState {
    // process 事件未必都带 turn_id：无 hint 时优先路由到该 actor 最近一次
    // 已知 Turn（含带 hint 的真实 Turn）——否则 hint 有无混杂会把同一回合
    // 裂成「真 Turn + ~latest 幻影 Turn」两个状态，各自懒发 turn.started，
    // 渲染层随之出现多枚徽章且幻影永不终态（真机踩坑：单回合 7 枚徽章）。
    if (!turnIdHint) {
      const latest = this.#turnIds.get(actor);
      if (latest) {
        const existing = this.#states.get(`${actor}:${latest}`);
        if (existing) return existing;
      }
    }
    const key = turnIdHint ? `${actor}:${turnIdHint}` : `${actor}:~latest`;
    let state = this.#states.get(key);
    if (!state) {
      state = createChatEventProjectorState({
        turnId: turnIdHint || `turn-${actor}-${this.#states.size + 1}`,
        cid,
        actorId: actor,
      });
      this.#states.set(key, state);
    }
    this.#turnIds.set(actor, state.turnId);
    return state;
  }

  project(ev: GroupEvent): ChatStreamEvent[] {
    if (ev.type === 'process') {
      const streamEvent = ev.data as { type?: unknown } | undefined;
      if (!streamEvent || typeof streamEvent.type !== 'string') return [];
      const state = this.#stateFor(ev.actor, ev.turn_id, ev.cid);
      // 同 actor 无 turn_id 的兜底 Turn 记录，供 message 收尾时定位。
      if (ev.turn_id) this.#turnIds.set(ev.actor, state.turnId);
      return projectUpstreamEvent(state, streamEvent as never);
    }
    if (ev.type === 'message' && ev.turn_end) {
      const turnKey = ev.turn_id ? `${ev.msg.from}:${ev.turn_id}` : null;
      const state = (turnKey && this.#states.get(turnKey))
        || this.#states.get(`${ev.msg.from}:~latest`);
      if (!state) return [];
      const out: ChatTurnCompleted[] = completeChatTurn(state, 'completed');
      return out;
    }
    return [];
  }
}
