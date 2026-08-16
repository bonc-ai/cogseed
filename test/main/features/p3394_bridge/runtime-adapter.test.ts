import { describe, expect, it } from 'vitest';
import { P3394InMemoryRuntimeAdapter } from '../../../../src/main/features/p3394';

describe('P3394 runtime adapter contract', () => {
  it('opens sessions, delivers envelopes, streams events, snapshots, resumes, cancels and closes', async () => {
    const adapter = new P3394InMemoryRuntimeAdapter({ now: () => 'now' });
    await expect(adapter.openSession({ session_id: 'session-1', agent_id: 'agent-a' })).resolves.toEqual({ session_id: 'session-1', native_session_id: 'native-session-1', agent_id: 'agent-a' });
    await expect(adapter.resume('session-1')).resolves.toBeUndefined();
    const delivered = await adapter.deliver({ spec_version: 'p3394/1.0', message_id: 'msg-1', session_id: 'session-1', task_id: 'task-1', kind: 'task', performative: 'request', sender: { agent_id: 'agent-a' }, recipients: [{ agent_id: 'agent-b' }], payload: { parts: [{ type: 'text', text: 'hello' }] }, idempotency_key: 'idem-1' } as any);
    expect(delivered).toEqual({ task_id: 'task-1' });
    const events = [];
    for await (const event of adapter.stream('task-1')) events.push(event.kind);
    expect(events).toEqual(['started', 'completed']);
    expect(await adapter.snapshot('session-1')).toEqual({ session_id: 'session-1', native_session_id: 'native-session-1', at: 'now' });
    await adapter.cancel('task-1');
    const afterCancel = [];
    for await (const event of adapter.stream('task-1')) afterCancel.push(event.kind);
    expect(afterCancel).toEqual(['started', 'completed', 'cancelled']);
    await adapter.closeSession('session-1');
    await expect(adapter.resume('session-1')).rejects.toThrow(/session_not_found/);
  });
});
