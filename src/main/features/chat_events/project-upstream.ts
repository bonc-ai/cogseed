// ─── 上游 StreamEvent → chat.* 结构化事件投影器 ────────────────────────────
//
// core-agent 的 event-mapper 早已产出结构化工具事件（stream:'tool' 的
// start/progress/end 带 id/name/arguments），但 agents.chat 出口只把它们
// 压成一行文本渲染。本投影器把老协议 StreamEvent（delta/progress/event/
// final/error/done）翻译成 chat_events 契约的结构化事件，渲染层
// chat-stream 组件群按 Item 卡片消费。
//
// 设计约束：
// - 纯函数 + 调用方持状态（无闭包）：agents.chat、skills.chat、
//   group_chat 等多条执行路径复用同一投影（M3.4 接入时零改动）。
// - 老协议不动：调用方继续 yield 原事件，投影事件作为增量叠加下发。
// - 未知上游形状一律跳过（返回 []），投影失败不影响老链路。

import type { StreamEvent } from '../../model/client';
import type {
  ChatItemEvent,
  ChatStreamEvent,
  ChatTurnCompleted,
  ChatTurnStarted,
} from './types';

export interface ChatEventProjectorState {
  turnId: string;
  cid: string;
  actorId: string;
  startedAt: string;
  /** 懒发 turn.started：首个产出事件前自动带上。 */
  startedSent: boolean;
  /** 终态去重：final 与 done 都可能到达，turn.completed 只发一次。 */
  completedSent: boolean;
  /** 本 Turn 的正文文本 item（首次 delta 时生成，final 时置完成）。 */
  textItemId: string | null;
  /** 自增序号，保证同 Turn 内 itemId 唯一且顺序稳定。 */
  seq: number;
  /** 工具 id → 首见（start）epoch ms：end 帧据此回填权威 timing.startedAtMs。
   *  progress 先于 start 到达等乱序场景以首见时间为准（不编造更早时刻）。 */
  toolStarts: Map<string, number>;
  /** 思考段聚合（子安 2026-09-08 基数修正）：一次连续思考 = 一条
   *  reasoning 条目（与一次工具调用等价），不逐 token 铸条——否则长思考
   *  洪泛挤占 process 300 上限，工具记录被顶掉（真机 19:50 事故）。
   *  openReasoningItemId 非空 = 有未截断的聚合段在攒；被工具/正文/
   *  终态截断时整段落盘。 */
  openReasoningText: string;
  openReasoningItemId: string | null;
}

export function createChatEventProjectorState(input: {
  turnId: string;
  cid: string;
  actorId: string;
}): ChatEventProjectorState {
  return {
    turnId: input.turnId,
    cid: input.cid,
    actorId: input.actorId,
    startedAt: new Date().toISOString(),
    startedSent: false,
    completedSent: false,
    textItemId: null,
    seq: 0,
    toolStarts: new Map(),
    openReasoningText: '',
    openReasoningItemId: null,
  };
}

function nextItemId(state: ChatEventProjectorState, prefix: string): string {
  state.seq += 1;
  return `${state.turnId}:${prefix}:${state.seq}`;
}

function ensureTurnStarted(state: ChatEventProjectorState, out: ChatStreamEvent[]): void {
  if (state.startedSent) return;
  state.startedSent = true;
  const started: ChatTurnStarted = {
    type: 'chat.turn.started',
    turnId: state.turnId,
    cid: state.cid,
    actorId: state.actorId,
    startedAt: state.startedAt,
  };
  out.unshift(started);
}

function textItem(
  state: ChatEventProjectorState,
  itemId: string,
  status: ChatItemEvent['status'],
  delta: string,
): ChatItemEvent {
  return {
    type: 'chat.item',
    turnId: state.turnId,
    itemId,
    kind: 'text',
    status,
    payload: { delta },
  };
}

/** 参数对象摘成一行人读摘要；截断防撑 UI。 */
function summarizeArgs(args: unknown): string | undefined {
  if (args == null) return undefined;
  let text: string;
  if (typeof args === 'string') {
    text = args;
  } else {
    try {
      text = JSON.stringify(args);
    } catch {
      text = String(args);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** usage 载荷的键名在上游（result.meta.usage）随 provider 而异，宽松取。 */
function usagePayloadFrom(data: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = Number(data[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return undefined;
  };
  const cacheRead = pick('cache_read_tokens', 'cacheReadTokens', 'cacheRead', 'prompt_cache_hit_tokens', 'cached_tokens');
  const cacheWrite = pick('cache_write_tokens', 'cacheWriteTokens', 'cacheWrite', 'cache_creation_input_tokens', 'prompt_cache_miss_tokens');
  return {
    ...(pick('input_tokens', 'inputTokens', 'input', 'prompt_tokens') !== undefined
      ? { inputTokens: pick('input_tokens', 'inputTokens', 'input', 'prompt_tokens') }
      : {}),
    ...(pick('output_tokens', 'outputTokens', 'output', 'completion_tokens') !== undefined
      ? { outputTokens: pick('output_tokens', 'outputTokens', 'output', 'completion_tokens') }
      : {}),
    // 缓存字段（2026-09-08 补）：此前只映射 input/output，面板用量行缓存读
    // 恒 0——与页脚 meta（走 messageMetrics 全字段）口径不一致。宽松覆盖
    // pi-ai 驼峰 / DeepSeek 下划线 / Anthropic 命名。
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** 投影器入事件：线上 StreamEvent 加持久化专用合成事件（实时链路永不产生）。 */
export type ProjectableUpstreamEvent = StreamEvent | { type: 'text-segment'; text: string };

/**
 * 把一条上游事件投影为零或多条 chat.* 事件（顺序即下发顺序）。
 * 状态原地更新（itemId 分配 / startedSent / textItemId）。
 */
export function projectUpstreamEvent(
  state: ChatEventProjectorState,
  event: ProjectableUpstreamEvent,
): ChatStreamEvent[] {
  const out: ChatStreamEvent[] = [];
  const etype = event.type;

  // 思考段冲刷（基数修正）：任何非 progress 事件到达 = 当前思考段被
  // 截断（工具开始/正文输出/终态），聚合段整段落盘为一条 completed
  // reasoning——一次连续思考在轨迹里只占一条，与一次工具调用等价。
  const flushOpenReasoning = () => {
    if (state.openReasoningItemId && state.openReasoningText) {
      out.push({
        type: 'chat.item',
        turnId: state.turnId,
        itemId: state.openReasoningItemId,
        kind: 'reasoning',
        status: 'completed',
        payload: { text: state.openReasoningText },
      });
    }
    state.openReasoningText = '';
    state.openReasoningItemId = null;
  };
  if (etype !== 'progress') flushOpenReasoning();

  if (etype === 'delta' && typeof event.text === 'string' && event.text) {
    if (!state.textItemId) state.textItemId = nextItemId(state, 'text');
    out.push(textItem(state, state.textItemId, 'inProgress', event.text));
  } else if (etype === 'text-segment' && event.text) {
    // 持久化专用合成事件（bus LLM 主路径 flushTextSegmentForPersist）：
    // 中间正文段（被后续工具/思考 item 截断的段落）以 completed 终态整段
    // 落盘。实时链路永不产生此形状；最终段不落盘（=消息正文），渲染层
    // 重放只渲染 completed 文本段，与正文不重复。
    out.push(textItem(state, nextItemId(state, 'text'), 'completed', event.text));
  } else if (etype === 'progress' && typeof event.text === 'string' && event.text) {
    // 聚合到当前思考段（连续 progress 续写同一 itemId；分段到达的思考
    // 流与老一次性叙述同路径）。落盘由截断点统一冲刷（工具/正文/终态）。
    if (!state.openReasoningItemId) {
      state.openReasoningItemId = nextItemId(state, 'reason');
      // 开新段即首产出——turn.started 必须此刻发出（真机复现：失败回合
      // 仅一条 progress 后接 error，攒段不产出会让 started 缺发，终态
      // 判定弃权，回合记录丢失）。
      ensureTurnStarted(state, out);
    }
    state.openReasoningText += event.text;
  } else if (etype === 'event' && event.event) {
    const inner = event.event as { stream?: unknown; data?: unknown };
    if (inner.stream === 'tool' && inner.data && typeof inner.data === 'object') {
      const data = inner.data as Record<string, unknown>;
      const toolId = typeof data.id === 'string' ? data.id : '';
      const toolName = typeof data.name === 'string' ? data.name : 'tool';
      const phase = data.phase;
      if (phase === 'start') {
        // 上游工具 id 直接复用为 itemId：同工具的 progress/end 覆盖同一卡片。
        const itemId = `${state.turnId}:tool:${toolId || nextItemId(state, 'tool')}`;
        if (toolId) state.toolStarts.set(toolId, Date.now());
        const payload: { toolName: string; argsSummary?: string; timing: { startedAtMs: number } } = {
          toolName,
          timing: { startedAtMs: toolId ? state.toolStarts.get(toolId)! : Date.now() },
        };
        const argsSummary = summarizeArgs(data.arguments);
        if (argsSummary) payload.argsSummary = argsSummary;
        out.push({
          type: 'chat.item',
          turnId: state.turnId,
          itemId,
          kind: 'toolExecution',
          status: 'inProgress',
          payload,
        });
      } else if (phase === 'progress') {
        const itemId = `${state.turnId}:tool:${toolId}`;
        if (toolId && !state.toolStarts.has(toolId)) state.toolStarts.set(toolId, Date.now());
        const payload: { toolName: string; output?: string; timing: { startedAtMs: number } } = {
          toolName,
          timing: { startedAtMs: toolId ? state.toolStarts.get(toolId)! : Date.now() },
        };
        if (typeof data.message === 'string' && data.message) payload.output = data.message;
        out.push({
          type: 'chat.item',
          turnId: state.turnId,
          itemId,
          kind: 'toolExecution',
          status: 'inProgress',
          payload,
        });
      } else if (phase === 'end') {
        const itemId = `${state.turnId}:tool:${toolId}`;
        const failed = data.isError === true;
        if (toolId && !state.toolStarts.has(toolId)) state.toolStarts.set(toolId, Date.now());
        const startedAtMs = toolId ? state.toolStarts.get(toolId)! : Date.now();
        const payload: { toolName: string; output?: string; error?: string; timing: { startedAtMs: number; completedAtMs: number } } = {
          toolName,
          timing: { startedAtMs, completedAtMs: Math.max(Date.now(), startedAtMs) },
        };
        const output = typeof data.output === 'string'
          ? data.output
          : typeof data.result_preview === 'string' ? data.result_preview : undefined;
        if (output) payload.output = output.length > 4000 ? `${output.slice(0, 3997)}…` : output;
        if (failed) payload.error = typeof data.errorCode === 'string' ? data.errorCode : 'tool_error';
        if (toolId) state.toolStarts.delete(toolId);
        out.push({
          type: 'chat.item',
          turnId: state.turnId,
          itemId,
          kind: 'toolExecution',
          status: failed ? 'failed' : 'completed',
          payload,
        });
      }
    } else if (inner.stream === 'cli' && inner.data && typeof inner.data === 'object') {
      // 本地 CLI / P3394 网关 LocalEvent（runner.ts 出口，bus forwardProcess
      // 透传为 {stream:'cli', data}）。阶段 3 投影：只补 tool-event 双相位 →
      // toolExecution 三态（timing 与 tool 通道同源规则）；thinking/text-delta
      // 已分别以 progress/delta 形状同轮到达，走各自既有分支，此处不重复。
      // file-change 只带 paths 无 diff 正文，不满足 fileChange 载荷契约，跳过。
      const data = inner.data as Record<string, unknown>;
      if (data.type === 'tool-event') {
        const toolName = typeof data.tool === 'string' && data.tool ? data.tool : 'tool';
        const callId = typeof data.callId === 'string' && data.callId ? data.callId : '';
        const key = 'cli-' + (callId || toolName);
        if (data.phase === 'use') {
          const itemId = `${state.turnId}:tool:${key}${callId ? '' : '-' + nextItemId(state, 'tool')}`;
          if (!state.toolStarts.has(key)) state.toolStarts.set(key, Date.now());
          const payload: { toolName: string; argsSummary?: string; timing: { startedAtMs: number } } = {
            toolName,
            timing: { startedAtMs: state.toolStarts.get(key)! },
          };
          const argsSummary = summarizeArgs(data.input);
          if (argsSummary) payload.argsSummary = argsSummary;
          out.push({
            type: 'chat.item',
            turnId: state.turnId,
            itemId,
            kind: 'toolExecution',
            status: 'inProgress',
            payload,
          });
        } else if (data.phase === 'result') {
          const itemId = `${state.turnId}:tool:${key}`;
          if (!state.toolStarts.has(key)) state.toolStarts.set(key, Date.now());
          const startedAtMs = state.toolStarts.get(key)!;
          const failed = data.isError === true;
          const payload: { toolName: string; output?: string; error?: string; timing: { startedAtMs: number; completedAtMs: number } } = {
            toolName,
            timing: { startedAtMs, completedAtMs: Math.max(Date.now(), startedAtMs) },
          };
          const output = typeof data.output === 'string'
            ? data.output
            : typeof data.outputPath === 'string' ? data.outputPath : undefined;
          if (output) payload.output = output.length > 4000 ? output.slice(0, 3997) + '…' : output;
          if (failed) payload.error = 'tool_error';
          state.toolStarts.delete(key);
          out.push({
            type: 'chat.item',
            turnId: state.turnId,
            itemId,
            kind: 'toolExecution',
            status: failed ? 'failed' : 'completed',
            payload,
          });
        }
      }
    } else if (inner.stream === 'usage' && inner.data && typeof inner.data === 'object') {
      const usage = usagePayloadFrom(inner.data as Record<string, unknown>);
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
        out.push({
          type: 'chat.item',
          turnId: state.turnId,
          itemId: nextItemId(state, 'usage'),
          kind: 'usage',
          status: 'completed',
          payload: usage,
        });
      }
    } else if ((inner.stream === 'compaction' || inner.stream === 'context')
      && inner.data && typeof inner.data === 'object') {
      // 上下文压缩/组装阶段提示 → reasoning 卡（矩阵 #10 的数据源）。
      const data = inner.data as Record<string, unknown>;
      const phase = typeof data.phase === 'string' ? data.phase : String(inner.stream);
      out.push({
        type: 'chat.item',
        turnId: state.turnId,
        itemId: nextItemId(state, 'reason'),
        kind: 'reasoning',
        status: 'completed',
        payload: { text: `[context] ${phase}` },
      });
    }
  } else if (etype === 'final') {
    if (state.textItemId) {
      out.push(textItem(state, state.textItemId, 'completed', ''));
    }
    out.push(turnCompleted(state, 'completed'));
  } else if (etype === 'error') {
    const done: ChatTurnCompleted = turnCompleted(state, 'failed');
    done.error = event.text || 'unknown error';
    out.push(done);
  } else if (etype === 'done') {
    // final 正常路径已发过 completed；done 兜底 aborted / final 缺失。
    // 仅在本 Turn 已有产出（started 已发）时收尾——空流不制造孤儿 Turn。
    if (state.startedSent && !state.completedSent) {
      out.push(turnCompleted(state, event.aborted ? 'cancelled' : 'completed'));
    }
  }

  if (out.length) ensureTurnStarted(state, out);
  return out;
}

function turnCompleted(state: ChatEventProjectorState, status: ChatTurnCompleted['status']): ChatTurnCompleted {
  state.completedSent = true;
  return {
    type: 'chat.turn.completed',
    turnId: state.turnId,
    status,
    endedAt: new Date().toISOString(),
  };
}

/** 外部收尾入口：GroupEvent 层的 message(turn_end) 到达时给该 Turn 补终态
 * （去重：已发过终态的 Turn 返回空）。 */
export function completeChatTurn(
  state: ChatEventProjectorState,
  status: ChatTurnCompleted['status'],
  error?: string,
): ChatTurnCompleted[] {
  if (state.completedSent) return [];
  const event = turnCompleted(state, status);
  if (error && status === 'failed') event.error = error;
  if (!state.startedSent) return [];
  return [event];
}
