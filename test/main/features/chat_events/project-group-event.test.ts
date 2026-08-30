// ─── project-group-event 单元测试 ───────────────────────────────────────────
//
// 验证总线 GroupEvent → chat.* 投影：
// 1. process（data=StreamEvent）按 (actor,turn_id) 隔离投影；
// 2. message(turn_end) 补该回合终态且去重；
// 3. turn_id 缺失时的兜底（同 actor 最近活跃 Turn）；
// 4. 不相关事件（state_changed 等）不投影。

import { describe, expect, it } from 'vitest';

import { GroupEventChatProjector } from '../../../../src/main/features/chat_events/project-group-event';

function processEvent(actor: string, turnId: string | undefined, data: Record<string, unknown>): any {
  return { type: 'process', cid: 'c-1', actor, turn_id: turnId, data };
}

describe('GroupEventChatProjector', () => {
  it('process 投影 chat.* 且多 actor 互不串扰', () => {
    const projector = new GroupEventChatProjector();
    const a = projector.project(processEvent('commander', 'T1', { type: 'delta', text: '调度中' }));
    const b = projector.project(processEvent('agent-writer', 'T2', { type: 'delta', text: '写作中' }));

    expect(a.some((e) => e.type === 'chat.turn.started' && e.actorId === 'commander')).toBe(true);
    expect(b.some((e) => e.type === 'chat.item' && e.kind === 'text')).toBe(true);
    // 各自 turnId 独立。
    const aTurn = a.find((e) => e.type === 'chat.turn.started') as { turnId: string };
    const bText = b.find((e) => e.type === 'chat.item') as { turnId: string };
    expect(aTurn.turnId).not.toBe(bText.turnId);
  });

  it('message(turn_end) 补终态且去重', () => {
    const projector = new GroupEventChatProjector();
    projector.project(processEvent('commander', 'T1', { type: 'delta', text: 'hi' }));
    const endMsg: any = {
      type: 'message', cid: 'c-1', turn_end: true, turn_id: 'T1',
      msg: { from: 'commander', text: 'done' },
    };
    const first = projector.project(endMsg);
    expect(first.filter((e) => e.type === 'chat.turn.completed')).toHaveLength(1);

    const second = projector.project(endMsg);
    expect(second).toEqual([]);
  });

  it('process 无 turn_id 时落到同 actor 兜底 Turn，message 收尾能找到', () => {
    const projector = new GroupEventChatProjector();
    projector.project(processEvent('agent-x', undefined, { type: 'delta', text: 'a' }));
    // 同 actor 第二条也无 turn_id：应聚合到同一兜底 Turn。
    const second = projector.project(processEvent('agent-x', undefined, { type: 'delta', text: 'b' }));
    expect(second.some((e) => e.type === 'chat.turn.started')).toBe(false);

    const endMsg: any = {
      type: 'message', cid: 'c-1', turn_end: true, turn_id: 'T9',
      msg: { from: 'agent-x', text: 'ok' },
    };
    const out = projector.project(endMsg);
    expect(out.some((e) => e.type === 'chat.turn.completed')).toBe(true);
  });

  it('state_changed / agent_run_result / 非 turn_end message 不投影', () => {
    const projector = new GroupEventChatProjector();
    expect(projector.project({ type: 'state_changed', cid: 'c-1', state: {} as never })).toEqual([]);
    expect(projector.project({ type: 'agent_run_result', cid: 'c-1', actor: 'a', actor_type: 'agent', data: {} })).toEqual([]);
    expect(projector.project({
      type: 'message', cid: 'c-1',
      msg: { from: 'a', text: 'mid-turn side effect' },
    } as never)).toEqual([]);
  });

  it('process.data 形状未知时不投影（宽容跳过）', () => {
    const projector = new GroupEventChatProjector();
    expect(projector.project(processEvent('a', 'T1', {}))).toEqual([]);
    expect(projector.project(processEvent('a', 'T1', { type: 42 }))).toEqual([]);
  });
});
