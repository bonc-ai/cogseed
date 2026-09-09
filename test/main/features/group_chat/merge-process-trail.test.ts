import { describe, expect, it } from 'vitest';
import { mergeProcessTrail, _modelSupportsThinkingByDefault } from '../../../../src/main/features/group_chat/bus';
import type { PersistedChatEntry } from '../../../../src/main/features/chat_events/process-persist';

/** PR209 评审 M7：mergeProcessTrail 两组 slice 各自取同额度导致合并总长
 *  可超 MAX_PROCESS_ITEMS_PER_TURN(300)——修复后预算共享，总长恒 ≤300。 */

const MAX = 300;

function reasoningItem(seq: number): PersistedChatEntry {
  return {
    type: 'chatItem',
    item: {
      type: 'chat.item',
      turnId: 't',
      itemId: `t:reason:${seq}`,
      kind: 'reasoning',
      status: 'completed',
      payload: { text: `reasoning ${seq}` },
    },
  } as unknown as PersistedChatEntry;
}

function toolItem(seq: number): PersistedChatEntry {
  return {
    type: 'chatItem',
    item: {
      type: 'chat.item',
      turnId: 't',
      itemId: `t:tool:${seq}`,
      kind: 'toolExecution',
      status: 'completed',
      payload: { toolName: 'bash', timing: { startedAtMs: 1, completedAtMs: 2 } },
    },
  } as unknown as PersistedChatEntry;
}

function turnEntry(): PersistedChatEntry {
  return {
    type: 'turn',
    item: { type: 'chat.turn.completed', turnId: 't', status: 'completed', endedAt: '2026-09-09T00:00:00Z' },
  } as unknown as PersistedChatEntry;
}

describe('mergeProcessTrail 饱和（PR209 评审 M7）', () => {
  it('非 reasoning 与 reasoning 竞争时共享剩余预算，总长不超 300', () => {
    // 场景（评审实例）：老格式已占 100，新增 120 工具 + 200 思考 + 1 终态。
    const processItems = Array.from({ length: 100 }, (_, i) => ({ type: 'progress', text: `old ${i}` }));
    const entries = [
      ...Array.from({ length: 120 }, (_, i) => toolItem(i)),
      ...Array.from({ length: 200 }, (_, i) => reasoningItem(i)),
      turnEntry(),
    ];
    const merged = mergeProcessTrail(processItems as never, entries);
    expect(merged.length).toBeLessThanOrEqual(MAX);
    // 修复前：两组各 slice(179) → 100+179+179+1 = 459 突破上限。
    expect(merged.length).toBe(MAX);
  });

  it('预算内全保留；超限时终态保底 1 条', () => {
    const few = mergeProcessTrail([], [toolItem(0), reasoningItem(0), turnEntry()]);
    expect(few).toHaveLength(3);

    const flood = mergeProcessTrail(
      [],
      [...Array.from({ length: 350 }, (_, i) => toolItem(i)), turnEntry()],
    );
    expect(flood.length).toBeLessThanOrEqual(MAX);
    const last = flood[flood.length - 1] as { type: string };
    expect(last.type).toBe('turn'); // 终态最优先保全
  });
});

describe('_modelSupportsThinkingByDefault 收紧（PR209 评审 M8）', () => {
  const queueItem = (model?: string) => ({ execConfig: { model } }) as never;

  it('无显式模型名返回 false（不再盲发 low）', () => {
    // 修复前恒 true：未显式指定模型的回合（可能非推理端点）也被注入 low。
    expect(_modelSupportsThinkingByDefault(queueItem(undefined))).toBe(false);
    expect(_modelSupportsThinkingByDefault(queueItem(''))).toBe(false);
    expect(_modelSupportsThinkingByDefault(queueItem('   '))).toBe(false);
    expect(_modelSupportsThinkingByDefault({} as never)).toBe(false);
  });

  it('显式 reasoning 模型仍识别为 true，非 reasoning 模型为 false', () => {
    expect(_modelSupportsThinkingByDefault(queueItem('deepseek-v4'))).toBe(true);
    expect(_modelSupportsThinkingByDefault(queueItem('o3-mini'))).toBe(true);
    expect(_modelSupportsThinkingByDefault(queueItem('grok-4'))).toBe(true);
    expect(_modelSupportsThinkingByDefault(queueItem('QwQ-32B'))).toBe(true);
    expect(_modelSupportsThinkingByDefault(queueItem('gpt-4o'))).toBe(false);
    expect(_modelSupportsThinkingByDefault(queueItem('claude-sonnet-4'))).toBe(false);
  });
});
