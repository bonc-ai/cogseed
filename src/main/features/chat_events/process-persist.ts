// ─── 过程持久化收集器（conv-core 收编 · 存储补差）─────────────────────────
//
// 消息 process 字段双写：调用方继续收集老格式条目（progress/event，兼容
// 既有历史重建与消息导出），本收集器在同一事件流上并行产出 chat_events
// 结构化条目：
//   {type:'chatItem', item} —— item 级过程（toolExecution 含权威 timing）
//   {type:'turn', turn}     —— 终态（含 durationMs 总耗时）
// 渲染层 chatStreamRenderPersisted 优先消费新格式（收束态可显示真实总耗时
// 与工具数），老消息无新格式条目时回退老路径（无计时不编造——原约定不变）。
//
// 复用 project-upstream 投影器：实时下发（ipc stream:'chat'）与持久化共用
// 同一套投影语义（单一事实源）；turnStartedMs 可传入上游已知的首帧时刻，
// 使 durationMs 为权威值而非收集器创建时刻的近似。

import {
  completeChatTurn,
  createChatEventProjectorState,
  projectUpstreamEvent,
} from './project-upstream';
import type { ChatStreamEvent, ChatTurnTerminalStatus } from './types';

export type PersistedChatEntry =
  | { type: 'chatItem'; item: ChatStreamEvent }
  | { type: 'turn'; turn: ChatStreamEvent };

export interface ProcessCollector {
  /** 喂入上游 StreamEvent（与实时投影同一形状）。幂等安全：finish 后忽略。 */
  feed(event: unknown): void;
  /** 终态定格（首调用生效）：产出 {type:'turn'} 条目（含 durationMs）。 */
  finish(status?: ChatTurnTerminalStatus, error?: string): void;
  /** 新格式条目（含 turn 终态条目）。持久化时与老格式条目拼接。 */
  readonly entries: readonly PersistedChatEntry[];
}

/** 与 MAX_PROCESS_ITEMS_PER_TURN 同量级的独立上限：防失控多工具循环刷屏。 */
const MAX_CHAT_ENTRIES = 200;

export function createProcessCollector(input: {
  cid: string;
  actorId: string;
  turnId: string;
  /** Turn 权威起始 epoch ms（如 runActorTurn 的 turnStartedAt）。缺省取当前。 */
  startedAtMs?: number;
}): ProcessCollector {
  const state = createChatEventProjectorState({
    turnId: input.turnId,
    cid: input.cid,
    actorId: input.actorId,
  });
  if (typeof input.startedAtMs === 'number' && Number.isFinite(input.startedAtMs)) {
    state.startedAt = new Date(input.startedAtMs).toISOString();
  }
  const entries: PersistedChatEntry[] = [];
  let finished = false;
  return {
    feed(event: unknown) {
      if (finished || entries.length >= MAX_CHAT_ENTRIES) return;
      try {
        for (const chatEvent of projectUpstreamEvent(state, event as never)) {
          if (entries.length >= MAX_CHAT_ENTRIES) break;
          entries.push({ type: 'chatItem', item: chatEvent });
        }
      } catch {
        // 投影失败不影响持久化老链路（与实时投影同一约定：未知形状跳过）。
      }
    },
    finish(status: ChatTurnTerminalStatus = 'completed', error?: string) {
      if (finished) return;
      finished = true;
      try {
        for (const turnEvent of completeChatTurn(state, status, error)) {
          // 持久化条目自洽：补权威 durationMs（实时链路不需要，历史徽章直读）。
          const started = Date.parse(state.startedAt);
          if (Number.isFinite(started)) {
            (turnEvent as { durationMs?: number }).durationMs = Math.max(0, Date.now() - started);
          }
          entries.push({ type: 'turn', turn: turnEvent });
        }
      } catch {
        // 同上：终态条目失败最多让历史缺总耗时，不拖垮消息落盘。
      }
    },
    get entries() {
      return entries;
    },
  };
}
