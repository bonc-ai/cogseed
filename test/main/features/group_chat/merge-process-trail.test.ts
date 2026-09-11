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

  it('预算内保持原序：reasoning 维持与工具的交错位置（2026-09-11 回归）', () => {
    // 真机事故：落盘组装无条件按"非 reasoning 在前"拼接，整轮思考被推到
    // 过程区末尾，历史重放里中途思考不可见。预算内必须保持条目原序。
    const seq = mergeProcessTrail([], [toolItem(0), reasoningItem(0), toolItem(1), turnEntry()]);
    const kinds = seq.map((e) => {
      const item = (e as { item?: { kind?: string } }).item;
      return item?.kind || (e as { type?: string }).type;
    });
    expect(kinds).toEqual(['toolExecution', 'reasoning', 'toolExecution', 'turn']);
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

// ── 2026-09-11 二次事故（19:38 消息）回归：超额路径重排把整轮思考推到末尾 ──
//
// 真机数据（conv 180a07715650 / msg 75b8766fc839）：老格式 155 条（含 33 段
// 思考 progress，与 reasoning 重复存储），chat_events 164 条（131 非 reasoning
// + 33 reasoning，到达序与工具交错）。旧代码 budget=145 触发超额分支 → 按
// "非 reasoning 在前" 重排 + reasoning.slice(0,14) → 落盘 300 条里思考全在
// 末尾且只剩前 14 段。修复后：丢 19 条重复老格式思考腾预算 → 136+164=300
// 恰好落回预算内，33 段思考全量保留且维持交错。

function startedItem(): PersistedChatEntry {
  return {
    type: 'chatItem',
    item: { type: 'chat.turn.started', turnId: 't', cid: 'c', actorId: 'a', startedAt: '2026-09-11T19:34:38Z' },
  } as unknown as PersistedChatEntry;
}

function textItem(seq: number): PersistedChatEntry {
  return {
    type: 'chatItem',
    item: { type: 'chat.item', turnId: 't', itemId: `t:text:${seq}`, kind: 'text', status: 'completed', payload: { delta: `中间段 ${seq}` } },
  } as unknown as PersistedChatEntry;
}

function usageItem(): PersistedChatEntry {
  return {
    type: 'chatItem',
    item: { type: 'chat.item', turnId: 't', itemId: 't:usage:1', kind: 'usage', status: 'completed', payload: { inputTokens: 1 } },
  } as unknown as PersistedChatEntry;
}

/** 老格式思考 progress（_thinking 内存态标记，落盘会带上）。 */
function thinkingLegacy(seq: number) {
  return { type: 'progress', text: `思考 ${seq}`, _thinking: true };
}

function plainLegacy(seq: number) {
  return { type: 'progress', text: `阶段 ${seq}` };
}

function eventLegacy(seq: number) {
  return { type: 'event', event: { stream: 'tool', data: { id: `call_${seq}` } } };
}

/** 老格式 155 条（真机计数：100 工具事件 + 33 思考 + 20 其它 + usage + runtime）。 */
function realLegacyItems() {
  return [
    ...Array.from({ length: 100 }, (_, i) => eventLegacy(i)),
    ...Array.from({ length: 33 }, (_, i) => thinkingLegacy(i)),
    ...Array.from({ length: 20 }, (_, i) => plainLegacy(i)),
    { type: 'event', event: { stream: 'usage', data: { inputTokens: 1 } } },
    { type: 'event', event: { stream: 'runtime', data: { durationMs: 1 } } },
  ];
}

/** 新条目 164 条（真机计数：131 非 reasoning + 33 reasoning，交错到达）。 */
function realChatEntries(): PersistedChatEntry[] {
  const entries: PersistedChatEntry[] = [startedItem()];
  for (let i = 0; i < 29; i += 1) {
    entries.push(reasoningItem(i));
    entries.push(toolItem(i * 3));
    entries.push(toolItem(i * 3 + 1));
    entries.push(toolItem(i * 3 + 2));
    entries.push(textItem(i));
  }
  for (let i = 29; i < 33; i += 1) {
    entries.push(reasoningItem(i));
    entries.push(toolItem(87 + (i - 29)));
  }
  for (let i = 91; i < 100; i += 1) entries.push(toolItem(i));
  entries.push(usageItem());
  return entries;
}

describe('mergeProcessTrail 真机 19:38 形状（2026-09-11 二次事故）', () => {
  it('重复思考换预算后：33 段 reasoning 全保留且维持交错位置', () => {
    const processItems = realLegacyItems();
    const entries = realChatEntries();
    const reasoningCount = entries.filter(
      (e) => e.type === 'chatItem' && (e.item as { kind?: string }).kind === 'reasoning',
    ).length;
    expect(processItems).toHaveLength(155);
    expect(entries).toHaveLength(164);
    expect(reasoningCount).toBe(33); // 33 reasoning + 131 非 reasoning

    const merged = mergeProcessTrail(processItems as never, entries);
    expect(merged.length).toBeLessThanOrEqual(MAX);
    expect(merged.length).toBe(300); // 155+164=319 超 19 → 丢 19 条重复思考后恰好 300

    const kinds = merged.map((e) => {
      const item = (e as { item?: { kind?: string } }).item;
      return item?.kind || (e as { type?: string }).type;
    });
    const reasonIdx = kinds.map((k, i) => (k === 'reasoning' ? i : -1)).filter((i) => i >= 0);
    const toolIdx = kinds.map((k, i) => (k === 'toolExecution' ? i : -1)).filter((i) => i >= 0);
    // 33 段一段不丢（旧代码只剩 14 段），且不再堆在末尾。
    expect(reasonIdx).toHaveLength(33);
    expect(reasonIdx.some((r) => r > toolIdx[0] && r < toolIdx[toolIdx.length - 1])).toBe(true);
    // 思考顺序 = 到达序（reason:0 在第一段思考之前，reason:32 在最后一段之后）。
    const firstReason = kinds.indexOf('reasoning');
    const lastReason = kinds.lastIndexOf('reasoning');
    const firstItemId = (merged[firstReason] as { item?: { itemId?: string } }).item?.itemId;
    const lastItemId = (merged[lastReason] as { item?: { itemId?: string } }).item?.itemId;
    expect(firstItemId).toBe('t:reason:0');
    expect(lastItemId).toBe('t:reason:32');
    // 只丢重复的老格式思考（33 条里丢 19 条，留 14 条作老路径兜底），
    // 工具/usage/runtime 老格式事件一条不少。
    const keptLegacyThinking = merged.filter((e) => (e as { _thinking?: boolean })._thinking === true).length;
    expect(keptLegacyThinking).toBe(14);
    expect(merged.filter((e) => (e as { type?: string }).type === 'event')).toHaveLength(102);
  });

  it('收集器没产出 reasoning 时不丢老格式思考（那是唯一来源）', () => {
    const processItems = [
      ...Array.from({ length: 33 }, (_, i) => thinkingLegacy(i)),
      ...Array.from({ length: 257 }, (_, i) => plainLegacy(i)),
    ];
    const merged = mergeProcessTrail(processItems as never, [toolItem(0), turnEntry()]);
    expect(merged.length).toBeLessThanOrEqual(MAX);
    const keptThinking = merged.filter((e) => (e as { _thinking?: boolean })._thinking === true).length;
    expect(keptThinking).toBe(33);
  });

  it('老格式自身打满上限时新条目全弃（既有回退语义不变）', () => {
    const processItems = Array.from({ length: MAX }, (_, i) => plainLegacy(i));
    const merged = mergeProcessTrail(processItems as never, [toolItem(0), turnEntry()]);
    expect(merged).toHaveLength(MAX);
    expect(merged.some((e) => (e as { type?: string }).type === 'chatItem')).toBe(false);
  });

  it('重复思考不足以腾预算时：仍按原序保留（丢谁不丢序）', () => {
    const processItems = [
      ...Array.from({ length: 260 }, (_, i) => plainLegacy(i)),
      ...Array.from({ length: 20 }, (_, i) => thinkingLegacy(i)),
    ];
    // 含 reasoning 才触发「老格式思考=重复」的丢弃；工具与思考交错到达。
    const entries: PersistedChatEntry[] = [];
    for (let i = 0; i < 100; i += 1) {
      entries.push(toolItem(i));
      if (i >= 50 && i % 10 === 0) entries.push(reasoningItem(i));
    }
    const merged = mergeProcessTrail(processItems as never, entries);
    expect(merged.length).toBeLessThanOrEqual(MAX);
    // 20 条重复思考全丢（280→260），仍需 100 条 → 保留最早 40 条工具，共 300。
    expect(merged.length).toBe(300);
    const keptLegacy = merged.filter((e) => (e as { type?: string }).type === 'progress');
    expect(keptLegacy).toHaveLength(260);
    const keptTools = merged
      .filter((e) => (e as { item?: { kind?: string } }).item?.kind === 'toolExecution')
      .map((e) => (e as { item?: { itemId?: string } }).item?.itemId);
    expect(keptTools).toHaveLength(40);
    expect(keptTools[0]).toBe('t:tool:0');
    expect(keptTools[keptTools.length - 1]).toBe('t:tool:39');
    // 保留项相对顺序 = 原序：工具段仍排在老格式之后、且按序号递增。
    const firstToolPos = merged.findIndex((e) => (e as { item?: { kind?: string } }).item?.kind === 'toolExecution');
    expect(firstToolPos).toBe(260);
  });

  it('超额取舍后仍保持交错：reasoning 保留项不回堆到末尾', () => {
    // 工具少、思考多 → 工具占额后剩余额度给 reasoning；输出按到达序，
    // 保留的 reasoning 与工具维持交错（旧代码会把它们全部推到末尾）。
    const entries: PersistedChatEntry[] = [];
    for (let i = 0; i < 50; i += 1) {
      entries.push(toolItem(i));
      for (let j = 0; j < 6; j += 1) entries.push(reasoningItem(i * 6 + j));
    }
    const merged = mergeProcessTrail([], entries);
    expect(merged.length).toBe(MAX);
    const kinds = merged.map((e) => (e as { item?: { kind?: string } }).item?.kind || (e as { type?: string }).type);
    const reasonIdx = kinds.map((k, i) => (k === 'reasoning' ? i : -1)).filter((i) => i >= 0);
    const toolIdx = kinds.map((k, i) => (k === 'toolExecution' ? i : -1)).filter((i) => i >= 0);
    expect(toolIdx).toHaveLength(50);
    expect(reasonIdx).toHaveLength(250);
    expect(reasonIdx.some((r) => r > toolIdx[0] && r < toolIdx[toolIdx.length - 1])).toBe(true);
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
