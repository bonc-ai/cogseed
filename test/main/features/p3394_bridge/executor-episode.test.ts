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

describe('P3394 executor KSTAR episode sink', () => {
  it('records a completed episode with goal, actions and result', async () => {
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
    bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifest('hermes') });
    const episodes: Array<Record<string, unknown>> = [];
    const executor = new P3394BridgeExecutor({
      bridge,
      runtime: fakeRuntime(),
      recordEpisode: (episode) => { episodes.push(episode as unknown as Record<string, unknown>); },
    });
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);

    expect(episodes).toHaveLength(1);
    const episode = episodes[0];
    expect(episode.session_id).toBe('ses-ep-1');
    expect(episode.task_id).toBe('tsk-ep-1');
    expect(episode.status).toBe('completed');
    expect(episode.goal).toBe('审查合同');
    expect(episode.agent_id).toBe('cogseed');
    expect(episode.result).toContain('发现 3 处风险条款');
    const actions = episode.actions as Array<{ kind: string }>;
    expect(actions.map((action) => action.kind)).toContain('delta');
    expect(actions.map((action) => action.kind)).toContain('completed');
  });

  it('records a failed episode when the runtime throws', async () => {
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
    bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifest('hermes') });
    const failing: P3394RuntimeAdapter = {
      ...fakeRuntime(),
      async deliver(): Promise<{ task_id: string }> {
        throw new Error('runtime exploded');
      },
    };
    const episodes: Array<Record<string, unknown>> = [];
    const executor = new P3394BridgeExecutor({
      bridge,
      runtime: failing,
      recordEpisode: (episode) => { episodes.push(episode as unknown as Record<string, unknown>); },
    });
    const result = executor.execute(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].status).toBe('failed');
    const actions = episodes[0].actions as Array<{ kind: string; error?: string }>;
    expect(actions.some((action) => action.error === 'runtime exploded')).toBe(true);
  });
});
