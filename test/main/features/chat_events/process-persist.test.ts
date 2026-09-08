// ─── process-persist 收集器测试 ────────────────────────────────────────────
//
// 存储补差的核心不变量：
// 1. 同一 StreamEvent 流上产出 chatItem 条目：toolExecution 三相位带权威
//    timing（startedAtMs 首见时刻；end 补 completedAtMs）；
// 2. finish 产出唯一 turn 终态条目（durationMs>0），重复 finish 幂等；
// 3. finish 后 feed 忽略；投影失败（垃圾形状）不抛错不影响老链路；
// 4. 上限保护：超过 MAX 条目后停收（防失控多工具循环刷爆消息 process）。

import { describe, expect, it } from 'vitest';
import { createProcessCollector } from '../../../../src/main/features/chat_events/process-persist';

function toolEvent(phase: string, id: string, extra: Record<string, unknown> = {}) {
  return { type: 'event', event: { stream: 'tool', data: { phase, id, name: 'bash', ...extra } } };
}

describe('process-persist collector', () => {
  it('tool 三相位产出含权威 timing 的 chatItem；end 补 completedAtMs', () => {
    const c = createProcessCollector({ cid: 'c1', actorId: 'a1', turnId: 't1' });
    c.feed(toolEvent('start', 'tool-1', { arguments: { command: 'npm test' } }));
    c.feed(toolEvent('end', 'tool-1', { output: 'ok' }));
    c.finish('completed');
    const items = c.entries.filter((e) => e.type === 'chatItem' && e.item.type === 'chat.item');
    const toolItems = items.filter(
      (e) => e.type === 'chatItem' && e.item.type === 'chat.item' && 'payload' in e.item && (e.item as { kind?: string }).kind === undefined,
    );
    // 至少包含：turn.started（懒发）+ 两个 toolExecution item + turn 终态。
    expect(c.entries.length).toBeGreaterThanOrEqual(4);
    const startEntry = c.entries.find((e) => e.type === 'chatItem' && e.item.type === 'chat.turn.started');
    expect(startEntry).toBeTruthy();
    const toolRows = c.entries.filter(
      (e) => e.type === 'chatItem' && e.item.type === 'chat.item' && (e.item as unknown as { kind: string }).kind === 'toolExecution',
    ) as Array<{ type: 'chatItem'; item: { kind: string; status: string; payload: { timing?: { startedAtMs: number; completedAtMs?: number } } } }>;
    expect(toolRows).toHaveLength(2);
    expect(toolRows[0].item.status).toBe('inProgress');
    expect(toolRows[0].item.payload.timing?.startedAtMs).toBeGreaterThan(0);
    expect(toolRows[0].item.payload.timing?.completedAtMs).toBeUndefined();
    expect(toolRows[1].item.status).toBe('completed');
    expect(toolRows[1].item.payload.timing?.completedAtMs).toBeGreaterThanOrEqual(toolRows[1].item.payload.timing!.startedAtMs);
    void toolItems;
    const turn = c.entries.find((e) => e.type === 'turn');
    expect(turn).toBeTruthy();
    expect((turn as { turn: { durationMs?: number } }).turn.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('finish 幂等：重复调用只产出一条 turn 条目；finish 后 feed 忽略', () => {
    const c = createProcessCollector({ cid: 'c1', actorId: 'a1', turnId: 't2' });
    c.feed(toolEvent('start', 'x', {}));
    c.finish('completed');
    const countAfterFirst = c.entries.length;
    c.finish('failed');
    c.feed(toolEvent('start', 'y', {}));
    expect(c.entries.length).toBe(countAfterFirst);
    expect(c.entries.filter((e) => e.type === 'turn')).toHaveLength(1);
  });

  it('垃圾事件不抛错（未知形状跳过，与实时投影同一约定）', () => {
    const c = createProcessCollector({ cid: 'c1', actorId: 'a1', turnId: 't3' });
    expect(() => {
      c.feed(null);
      c.feed(undefined);
      c.feed({ type: 'mystery' });
      c.feed({ type: 'event', event: { stream: 'tool', data: 'not-an-object' } });
    }).not.toThrow();
    c.finish('completed');
    // 垃圾不产出 item；turn.started 懒发仍存在（首条合法事件前 finish）。
    const items = c.entries.filter((e) => e.type === 'chatItem');
    expect(items).toHaveLength(0);
  });

  it('上限保护：超量后停收新条目', () => {
    const c = createProcessCollector({ cid: 'c1', actorId: 'a1', turnId: 't4' });
    for (let i = 0; i < 260; i++) {
      c.feed(toolEvent('start', 'tool-' + i, {}));
    }
    expect(c.entries.length).toBeLessThanOrEqual(201); // 200 上限 + 终态余量
  });
});
