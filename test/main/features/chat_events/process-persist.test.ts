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

  it('stream:cli（本地 CLI/网关 LocalEvent）tool-event 双相位投影为 toolExecution 含 timing', () => {
    const c = createProcessCollector({ cid: 'c1', actorId: 'cli-agent', turnId: 't5' });
    c.feed({ type: 'event', event: { stream: 'cli', data: { type: 'tool-event', tool: 'codex-shell', callId: 'call-9', phase: 'use', input: { command: 'npm run build' } } } });
    c.feed({ type: 'event', event: { stream: 'cli', data: { type: 'tool-event', tool: 'codex-shell', callId: 'call-9', phase: 'result', output: 'built ok' } } });
    c.finish('completed');
    const rows = c.entries.filter(
      (e) => e.type === 'chatItem' && e.item.type === 'chat.item' && (e.item as unknown as { kind: string }).kind === 'toolExecution',
    ) as Array<{ type: 'chatItem'; item: { itemId: string; status: string; payload: { toolName: string; argsSummary?: string; output?: string; timing?: { startedAtMs: number; completedAtMs?: number } } } }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].item.itemId).toContain('cli-call-9');
    expect(rows[0].item.status).toBe('inProgress');
    expect(rows[0].item.payload.toolName).toBe('codex-shell');
    expect(rows[0].item.payload.argsSummary).toContain('npm run build');
    expect(rows[0].item.payload.timing?.completedAtMs).toBeUndefined();
    expect(rows[1].item.status).toBe('completed');
    expect(rows[1].item.payload.output).toBe('built ok');
    expect(rows[1].item.payload.timing?.completedAtMs).toBeGreaterThanOrEqual(rows[1].item.payload.timing!.startedAtMs);
  });

  it('上限保护：超量后停收新条目', () => {
    const c = createProcessCollector({ cid: 'c1', actorId: 'a1', turnId: 't4' });
    for (let i = 0; i < 260; i++) {
      c.feed(toolEvent('start', 'tool-' + i, {}));
    }
    expect(c.entries.length).toBeLessThanOrEqual(201); // 200 上限 + 终态余量
  });

  it('思考实时 inProgress 不落盘（重放只消费 completed 整段）', () => {
    // 投影器 progress 分支逐段外发 inProgress reasoning（实时流式，
    // 2026-09-09）——收集器必须过滤该形状：落盘会刷爆条目上限并与截断
    // 冲刷的 completed 整段重复。
    const c = createProcessCollector({ cid: 'c1', actorId: 'a1', turnId: 't6' });
    c.feed({ type: 'progress', text: '正在' });
    c.feed({ type: 'progress', text: '读取文件…' });
    c.feed({ type: 'progress', text: '继续分析…' });
    const inProgress = c.entries.filter(
      (e) => e.type === 'chatItem' && (e.item as { kind?: string; status?: string }).kind === 'reasoning',
    );
    expect(inProgress).toHaveLength(0);
    // 截断冲刷（工具事件）后 completed 整段落盘一次。
    c.feed(toolEvent('start', 'tool-z', {}));
    const completed = c.entries.filter(
      (e) => e.type === 'chatItem' && (e.item as { kind?: string; status?: string }).kind === 'reasoning',
    );
    expect(completed).toHaveLength(1);
    expect((completed[0].item as { status?: string }).status).toBe('completed');
    expect((completed[0].item as { payload?: { text?: string } }).payload?.text).toBe('正在读取文件…继续分析…');
  });

  it('多轮思考-工具交错：completed reasoning 按截断点顺序落盘（2026-09-11 复查）', () => {
    // 真机现象复查：一轮 33 步的落盘里 13 条 completed reasoning 全部堆在
    // usage 之后（过程区最末尾），中途的思考在时间线上不可见。本用例验证
    // 投影+收集在"思考→工具→思考→工具"交错输入下是否保持顺序。
    const c = createProcessCollector({ cid: 'c1', actorId: 'a1', turnId: 't7' });
    c.feed({ type: 'progress', text: '思考一' });
    c.feed(toolEvent('start', 'tool-1', {}));
    c.feed(toolEvent('end', 'tool-1', {}));
    c.feed({ type: 'progress', text: '思考二' });
    c.feed(toolEvent('start', 'tool-2', {}));
    c.feed(toolEvent('end', 'tool-2', {}));
    c.finish('completed');
    const kinds = c.entries.map((e) => (
      e.type === 'chatItem'
        ? String((e.item as { kind?: string; type?: string }).kind || (e.item as { type?: string }).type)
        : e.type
    ));
    const reasonIdx = kinds.map((k, i) => (k === 'reasoning' ? i : -1)).filter((i) => i >= 0);
    const toolIdx = kinds.map((k, i) => (k === 'toolExecution' ? i : -1)).filter((i) => i >= 0);
    expect(reasonIdx).toHaveLength(2);
    // 第一条思考在第一条工具之前；第二条思考在第一条工具之后（交错保持）。
    expect(reasonIdx[0]).toBeLessThan(toolIdx[0]);
    expect(reasonIdx[1]).toBeGreaterThan(toolIdx[0]);
  });
});
