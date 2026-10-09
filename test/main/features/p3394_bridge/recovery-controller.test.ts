/**
 * P3394RecoveryController 测试：sweep 扫描 recoverable 任务、按游标续读、
 * 失败留 pending 且受 maxAttempts 封顶、终态任务不再恢复。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeExecutor,
  P3394BridgeKernel,
  P3394RecoveryController,
} from '../../../../src/main/features/p3394';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';

function manifest(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function bridgeWithPeers(): P3394BridgeKernel {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'peer-a', display_name: 'Peer' }, manifest: manifest('peer-a') });
  bridge.registry.register({ identity: { agent_id: 'local-agent', display_name: 'Local' }, manifest: manifest('local-agent') });
  return bridge;
}

/** 可编程 fake runtime：stream 从 afterSequence 续读并记录每次调用。 */
function fakeRuntime(events: Array<{ sequence: number; kind: string }>) {
  const streamCalls: number[] = [];
  return {
    streamCalls,
    adapter: {
      async openSession(_input: { session_id: string; agent_id: string }): Promise<P3394RuntimeSessionBinding> {
        return { session_id: 'sess', native_session_id: 'native', agent_id: 'local-agent' };
      },
      async deliver(): Promise<{ task_id: string }> {
        return { task_id: 'tsk' };
      },
      async *stream(taskId: string, afterSequence = 0): AsyncIterable<P3394RuntimeEvent> {
        streamCalls.push(afterSequence);
        void taskId;
        for (const event of events) {
          if (event.sequence > afterSequence) yield { ...event, task_id: 'tsk' };
        }
      },
      async resume(): Promise<void> {},
      async cancel(): Promise<void> {},
      async snapshot(): Promise<P3394RuntimeSnapshot> {
        return { session_id: 'sess', native_session_id: 'native', at: new Date().toISOString() };
      },
      async closeSession(): Promise<void> {},
    } satisfies P3394RuntimeAdapter,
  };
}

function fixture(
  runtime: P3394RuntimeAdapter,
  options: { onEventFail?: boolean } = {},
): { executor: P3394BridgeExecutor; delivered: number[] } {
  const delivered: number[] = [];
  const executor = new P3394BridgeExecutor({
    bridge: bridgeWithPeers(),
    runtime,
    onEvent: async (_sessionId, event) => {
      if (options.onEventFail) throw new Error('transport down');
      delivered.push(event.sequence);
    },
  });
  return { executor, delivered };
}

const EVENTS = [
  { sequence: 1, kind: 'started' },
  { sequence: 2, kind: 'delta' },
  { sequence: 3, kind: 'completed' },
];

describe('P3394RecoveryController (C-03/R-06/S-05)', () => {
  it('sweep 恢复 recoverable 任务并从游标续读事件流', async () => {
    const { streamCalls, adapter } = fakeRuntime(EVENTS);
    const { executor, delivered } = fixture(adapter);
    executor.sessions.open({ session_id: 'sess', goal: 'g', agent_id: 'local-agent' });
    executor.tasks.submit({ task_id: 'tsk', session_id: 'sess', message_id: 'm1' });
    executor.tasks.markRecoverable('tsk');

    const controller = new P3394RecoveryController(executor, { cursorFor: () => 1 });
    const result = await controller.sweep();

    expect(result).toEqual({ recovered: ['tsk'], pending: [] });
    expect(delivered).toEqual([2, 3]); // 游标 1：不重放 sequence 1
    expect(executor.tasks.require('tsk').state).toBe('completed');
    expect(streamCalls).toEqual([1]);
  });

  it('失败的任务留在 pending，且恢复尝试受 maxAttempts 封顶', async () => {
    const { streamCalls, adapter } = fakeRuntime(EVENTS);
    const { executor } = fixture(adapter, { onEventFail: true });
    executor.sessions.open({ session_id: 'sess', goal: 'g', agent_id: 'local-agent' });
    executor.tasks.submit({ task_id: 'tsk', session_id: 'sess', message_id: 'm1' });
    executor.tasks.markRecoverable('tsk');

    const attempts: string[] = [];
    const controller = new P3394RecoveryController(executor, {
      maxAttempts: 2,
      onAttempt: (taskId, ok, error) => attempts.push(`${taskId}:${ok}:${error ?? ''}`),
    });
    expect(await controller.sweep()).toEqual({ recovered: [], pending: ['tsk'] });
    expect(await controller.sweep()).toEqual({ recovered: [], pending: ['tsk'] });
    // 第三次：达到上限，不再调用 resumeForward。
    const third = await controller.sweep();
    expect(third).toEqual({ recovered: [], pending: ['tsk'] });
    expect(executor.tasks.require('tsk').state).toBe('recoverable');
    expect(streamCalls).toHaveLength(2);
    expect(attempts).toEqual(['tsk:false:transport down', 'tsk:false:transport down']);
  });

  it('终态任务不进入恢复', async () => {
    const { adapter } = fakeRuntime(EVENTS);
    const { executor } = fixture(adapter);
    executor.sessions.open({ session_id: 'sess', goal: 'g', agent_id: 'local-agent' });
    executor.tasks.submit({ task_id: 'tsk-done', session_id: 'sess', message_id: 'm1' });
    executor.tasks.settle('tsk-done', 'completed');
    const controller = new P3394RecoveryController(executor, {});
    expect(await controller.sweep()).toEqual({ recovered: [], pending: [] });
  });
});
