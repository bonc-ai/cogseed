import { describe, expect, it } from 'vitest';
import { P3394BridgeKernel } from '../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor } from '../../../../src/main/features/p3394_bridge/executor';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

function manifest(id: string) {
  const r = buildP3394BridgeManifest({ agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general' } as never);
  if (!r.ok) throw new Error(r.error.message);
  return r.manifest;
}

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-ap-1',
    session_id: 'ses-ap-1',
    task_id: 'tsk-ap-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'sensitive op' }] },
    idempotency_key: 'idem-ap-1',
    ...overrides,
  } as P3394Envelope;
}

function countingRuntime(delivered: string[]): P3394RuntimeAdapter {
  return {
    async openSession(_input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: 'ses-ap-1', native_session_id: 'native-1', agent_id: 'cogseed' };
    },
    async deliver(e): Promise<{ task_id: string }> { delivered.push(e.message_id); return { task_id: e.task_id || 'tsk-ap-1' }; },
    async *stream(taskId: string): AsyncIterable<P3394RuntimeEvent> {
      yield { sequence: 1, task_id: taskId, kind: 'started' };
      yield { sequence: 2, task_id: taskId, kind: 'completed', data: { text: 'done' } };
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(): Promise<P3394RuntimeSnapshot> {
      return { session_id: 'ses-ap-1', native_session_id: 'native-1', at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

function setup(delivered: string[]) {
  const b = new P3394BridgeKernel();
  b.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
  b.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifest('hermes') });
  const executor = new P3394BridgeExecutor({ bridge: b, runtime: countingRuntime(delivered) });
  return { b, executor };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('P3394 §15 human approval gate (B3)', () => {
  it('parks a requires_approval envelope without executing; audit records the request', async () => {
    const delivered: string[] = [];
    const { b, executor } = setup(delivered);
    const result = executor.execute(envelope({
      payload: { parts: [{ type: 'text', text: 'wipe prod data' }], metadata: { requires_approval: true } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.executed).toBe(false);
    expect(result.task_id).toBe('tsk-ap-1');
    await drain();
    expect(delivered).toEqual([]); // 未执行：runtime 从未收到 deliver
    const events = b.audit.list().map((e) => e.event);
    expect(events).toContain('approval.requested');
  });

  it('accept control frame replays and completes the approved task', async () => {
    const delivered: string[] = [];
    const { b, executor } = setup(delivered);
    executor.execute(envelope({
      payload: { parts: [{ type: 'text', text: 'wipe prod data' }], metadata: { requires_approval: true } },
    }));
    await drain();
    const accepted = executor.execute(envelope({
      message_id: 'msg-ap-accept',
      kind: 'control',
      performative: 'accept',
      task_id: 'tsk-ap-1',
      idempotency_key: 'idem-ap-accept',
      payload: { parts: [{ type: 'text', text: 'approved' }] },
    }));
    expect(accepted.ok).toBe(true);
    await drain();
    expect(delivered).toHaveLength(1); // 批准后恰好执行一次
    const events = b.audit.list().map((e) => e.event);
    expect(events).toContain('approval.granted');
  });

  it('cancel while parked settles cancelled and never executes', async () => {
    const delivered: string[] = [];
    const { b, executor } = setup(delivered);
    executor.execute(envelope({
      payload: { parts: [{ type: 'text', text: 'wipe prod data' }], metadata: { requires_approval: true } },
    }));
    await drain();
    executor.execute(envelope({
      message_id: 'msg-ap-cancel',
      kind: 'control',
      performative: 'cancel',
      task_id: 'tsk-ap-1',
      idempotency_key: 'idem-ap-cancel',
      payload: { parts: [{ type: 'text', text: 'rejected' }] },
    }));
    await drain();
    expect(delivered).toEqual([]);
    const events = b.audit.list().map((e) => e.event);
    expect(events).toContain('approval.rejected');
  });

  it('envelopes without the flag execute immediately (no behavior change)', async () => {
    const delivered: string[] = [];
    const { executor } = setup(delivered);
    const result = executor.execute(envelope({}));
    expect(result.ok).toBe(true);
    await drain();
    expect(delivered).toHaveLength(1);
  });
});
