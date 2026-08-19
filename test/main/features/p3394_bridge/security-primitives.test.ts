import { describe, expect, it } from 'vitest';
import { P3394AuditJournal, P3394IdempotencyStore, P3394ReplayProtector } from '../../../../src/main/features/p3394';

describe('P3394 bridge security primitives', () => {
  it('deduplicates idempotency keys per sender', () => {
    const store = new P3394IdempotencyStore<{ taskId: string }>();
    expect(store.record('agent-a', 'idem-1', { taskId: 'task-1' }).replay).toBe(false);
    expect(store.record('agent-a', 'idem-1', { taskId: 'task-2' })).toMatchObject({ replay: true, receipt: { result: { taskId: 'task-1' } } });
    expect(store.record('agent-b', 'idem-1', { taskId: 'task-3' }).replay).toBe(false);
  });

  it('rejects replayed or invalid epochs', () => {
    const replay = new P3394ReplayProtector();
    expect(replay.admit('agent-a', 1)).toEqual({ ok: true, epoch: 1 });
    expect(replay.admit('agent-a', 1)).toMatchObject({ ok: false, error: { reason: 'replay_detected' } });
    expect(replay.admit('agent-a', -1)).toMatchObject({ ok: false, error: { reason: 'invalid_epoch' } });
  });

  it('redacts secrets from audit metadata', () => {
    const journal = new P3394AuditJournal();
    journal.append({ event: 'send', actor_id: 'agent-a', status: 'accepted', metadata: { token: 'raw', nested: { api_key: 'secret', ok: true } } });
    expect(journal.list()[0].metadata).toEqual({ token: '***REDACTED***', nested: { api_key: '***REDACTED***', ok: true } });
  });
});
