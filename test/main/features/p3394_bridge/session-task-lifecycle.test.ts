import { describe, expect, it } from 'vitest';
import { P3394BridgeKstarCloseHook, P3394BridgeMessageStore, P3394BridgeSessionManager, P3394BridgeTaskManager } from '../../../../src/main/features/p3394';

describe('P3394 bridge session task lifecycle', () => {
  it('tracks sessions, multiple tasks, messages, and idempotent kstar close records', () => {
    const sessions = new P3394BridgeSessionManager(() => 'now');
    const tasks = new P3394BridgeTaskManager(() => 'now');
    const messages = new P3394BridgeMessageStore();
    const kstar = new P3394BridgeKstarCloseHook(() => 'now');
    const s = sessions.open({ session_id: 'session-1', goal: 'goal', agent_id: 'agent-a' });
    expect(s.state).toBe('negotiating');
    sessions.accept('session-1');
    messages.add({ spec_version: 'p3394/1.0', message_id: 'msg-1', session_id: 'session-1', kind: 'task', performative: 'request', sender: { agent_id: 'agent-a' }, recipients: [{ agent_id: 'agent-b' }], payload: { parts: [{ type: 'text', text: 'hi' }] }, idempotency_key: 'idem-1' } as any);
    tasks.submit({ task_id: 'task-1', session_id: 'session-1', message_id: 'msg-1' });
    tasks.submit({ task_id: 'task-2', session_id: 'session-1', message_id: 'msg-1' });
    sessions.attachTask('session-1', 'task-1'); sessions.attachTask('session-1', 'task-2');
    expect(sessions.require('session-1').task_ids).toEqual(['task-1', 'task-2']);
    expect(tasks.settle('task-1', 'completed').state).toBe('completed');
    const closed = sessions.close('session-1');
    expect(kstar.close(closed)).toEqual({ session_id: 'session-1', goal: 'goal', agent_id: 'agent-a', proposed_updates: [], created_at: 'now' });
    expect(kstar.close(closed)).toBe(kstar.list()[0]);
  });
});
