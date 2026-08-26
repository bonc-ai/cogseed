import { describe, it, expect } from 'vitest';

import {
  dashboardCollabFromGroupEvent,
  dashboardActivityFromTaskTerminal,
  dashboardActivityFromGroupEvent,
} from '../../../src/main/features/dashboard_events';
import type { GroupEvent } from '../../../src/main/features/group_chat/bus';
import type { TaskTerminalEvent } from '../../../src/main/features/group_chat/bus';

// Dashboard 事件外漏 —— bus 全局钩子 → broadcastToRenderer 的映射层。
// 只测纯映射：GroupEvent(message) → collab 载荷（接力图增量）；
// TaskTerminalEvent → activity 载荷（任务终局）。非消息级 GroupEvent
// 不外漏（对话流自己有按会话订阅，这里只做跨会话俯瞰所需的最小面）。

function messageEvent(over: Partial<Record<string, unknown>> = {}): GroupEvent {
  return {
    type: 'message',
    cid: 'c1',
    msg: {
      id: 'm1',
      ts: '2026-08-26T10:00:00.000Z',
      from: 'commander',
      to: ['researcher'],
      text: '请调研 X',
      ...over,
    },
  } as unknown as GroupEvent;
}

describe('dashboard collab mapping', () => {
  it('maps a message GroupEvent to a slim collab payload', () => {
    const out = dashboardCollabFromGroupEvent(messageEvent({ turn_id: 't1', dispatch: true }));
    expect(out).toEqual({
      kind: 'message',
      cid: 'c1',
      from: 'commander',
      to: ['researcher'],
      turnId: 't1',
      dispatch: true,
      ts: '2026-08-26T10:00:00.000Z',
      messageId: 'm1',
      textHead: '请调研 X',
    });
  });

  it('truncates text to 80 chars to keep payloads small', () => {
    const long = 'x'.repeat(300);
    const out = dashboardCollabFromGroupEvent(messageEvent({ text: long }));
    expect(out?.textHead).toHaveLength(80);
  });

  it('returns null for non-message GroupEvents', () => {
    expect(dashboardCollabFromGroupEvent({ type: 'process', cid: 'c1', actor: 'a', data: {} } as GroupEvent)).toBeNull();
    expect(dashboardCollabFromGroupEvent({ type: 'state_changed', cid: 'c1' } as unknown as GroupEvent)).toBeNull();
    expect(dashboardCollabFromGroupEvent({ type: 'member_joined', cid: 'c1' } as unknown as GroupEvent)).toBeNull();
  });

  it('maps a task terminal event to an activity payload unchanged', () => {
    const terminal: TaskTerminalEvent = {
      run_id: 'r1',
      user_id: 'u1',
      conversation_id: 'c1',
      status: 'completed',
      started_at_ms: 1,
      finished_at_ms: 2,
    };
    expect(dashboardActivityFromTaskTerminal(terminal)).toEqual({
      kind: 'task_terminal',
      ...terminal,
    });
  });

  it('fans wake requests out to the activity channel for cross-view visibility', () => {
    const out = dashboardActivityFromGroupEvent({
      type: 'wake_request',
      cid: 'c1',
      request: { id: 'w1', agent_id: 'researcher', source: 'plan_step', objective: '调研 X', status: 'pending' },
    } as unknown as GroupEvent);
    expect(out).toEqual({ kind: 'wake_request', cid: 'c1', agentId: 'researcher', status: 'pending' });
  });

  it('keeps other group events out of the activity channel', () => {
    expect(dashboardActivityFromGroupEvent(messageEvent() as GroupEvent)).toBeNull();
  });
});
