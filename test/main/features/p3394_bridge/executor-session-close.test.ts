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
    message_id: 'msg-ep-1',
    session_id: 'ses-ep-1',
    task_id: 'tsk-ep-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'review please' }], metadata: { goal: '审查合同' } },
    idempotency_key: 'idem-ep-1',
    ...overrides,
  } as P3394Envelope;
}

/** 假 runtime：deliver 后 stream 出 started → delta → completed。 */
function fakeRuntime(): P3394RuntimeAdapter {
  const taskId = 'tsk-ep-1';
  return {
    async openSession(_input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: 'ses-ep-1', native_session_id: 'native-1', agent_id: 'cogseed' };
    },
    async deliver(): Promise<{ task_id: string }> {
      return { task_id: taskId };
    },
    async *stream(): AsyncIterable<P3394RuntimeEvent> {
      yield { sequence: 1, task_id: taskId, kind: 'started', data: {} };
      yield { sequence: 2, task_id: taskId, kind: 'delta', data: { text: '发现 3 处风险条款' } };
      yield { sequence: 3, task_id: taskId, kind: 'completed', data: {} };
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(): Promise<P3394RuntimeSnapshot> {
      return { session_id: 'ses-ep-1', native_session_id: 'native-1', at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

describe('P3394 executor session close (KSTAR close hook)', () => {
  it('double closeSession runs the runtime close once and journals one KSTAR record', async () => {
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
    bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifest('hermes') });
    const runtimeCloses: string[] = [];
    const runtime: P3394RuntimeAdapter = {
      ...fakeRuntime(),
      async closeSession(sessionId): Promise<void> {
        runtimeCloses.push(sessionId);
      },
    };
    const executor = new P3394BridgeExecutor({ bridge, runtime });
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    const first = await executor.closeSession('ses-ep-1');
    const second = await executor.closeSession('ses-ep-1');
    expect(runtimeCloses).toEqual(['ses-ep-1']);
    expect(executor.kstar.list()).toHaveLength(1);
    expect(second).toBe(first);
    expect(executor.sessions.require('ses-ep-1').state).toBe('closed');
  });

  it('a failing runtime close records close_error without throwing', async () => {
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
    bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifest('hermes') });
    const runtime: P3394RuntimeAdapter = {
      ...fakeRuntime(),
      async closeSession(): Promise<void> {
        throw new Error('recall bridge down');
      },
    };
    const executor = new P3394BridgeExecutor({ bridge, runtime });
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    const record = await executor.closeSession('ses-ep-1');
    expect(record).toMatchObject({ session_id: 'ses-ep-1' });
    const updates = (record as { proposed_updates: Array<{ kind: string; message?: string }> }).proposed_updates;
    expect(updates).toEqual([{ kind: 'close_error', message: 'recall bridge down' }]);
    // close 失败不破坏会话终态与后续重复 close 的幂等返回。
    await executor.closeSession('ses-ep-1');
    expect(executor.kstar.list()).toHaveLength(1);
  });
});
