/**
 * R-01 集成测试：显式 session_id 优先恢复，Goal 不替代 Session ID。
 *
 * 指挥书 §4.2：同一 Companion 对话不能因为来自同一个 Channel、同一个用户
 * 线程或同一个 peer 就自动合并所有工作；Goal 用于创建/路由，不得覆盖显式
 * P3394 Session。executor 的会话选择 = envelope.session_id（复用/恢复/新建），
 * goal 只写入 payload metadata。
 */

import { describe, expect, it } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeExecutor,
  P3394BridgeKernel,
  P3394InMemoryRuntimeAdapter,
} from '../../../../src/main/features/p3394';

function manifest(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(sessionId: string, goal: string, taskId: string, messageId: string) {
  return {
    spec_version: 'p3394/1.0',
    message_id: messageId,
    session_id: sessionId,
    task_id: taskId,
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'peer-a' },
    recipients: [{ agent_id: 'local-agent' }],
    payload: { parts: [{ type: 'text', text: 'do it' }], metadata: { goal } },
    idempotency_key: 'idem-' + messageId,
  };
}

function harness(): P3394BridgeExecutor {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'peer-a', display_name: 'Peer' }, manifest: manifest('peer-a') });
  bridge.registry.register({ identity: { agent_id: 'local-agent', display_name: 'Local' }, manifest: manifest('local-agent') });
  return new P3394BridgeExecutor({ bridge, runtime: new P3394InMemoryRuntimeAdapter() });
}

describe('P3394 session routing (R-01: explicit session_id wins, goal never substitutes)', () => {
  it('同一 session_id 复用同一 Work Session，不同 Goal 不覆盖', async () => {
    const executor = harness();
    expect(executor.execute(envelope('sess-1', 'goal-alpha', 'tsk-1', 'msg-1')).ok).toBe(true);
    expect(executor.execute(envelope('sess-1', 'goal-beta', 'tsk-2', 'msg-2')).ok).toBe(true);
    await executor.awaitForward('tsk-1');
    await executor.awaitForward('tsk-2');

    const sessions = executor.sessions.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe('sess-1');
    // 显式 session 恢复优先：goal 不覆盖既有 Work Session 的目标。
    expect(sessions[0].goal).toBe('goal-alpha');
    expect(sessions[0].task_ids).toEqual(['tsk-1', 'tsk-2']);
    expect(sessions[0].participants).toContain('peer-a');
    expect(sessions[0].state).toBe('active');
  });

  it('不同 session_id 即使 Goal 相同也不合并为同一 Session', async () => {
    const executor = harness();
    expect(executor.execute(envelope('sess-a', 'same-goal', 'tsk-a', 'msg-a')).ok).toBe(true);
    expect(executor.execute(envelope('sess-b', 'same-goal', 'tsk-b', 'msg-b')).ok).toBe(true);
    await executor.awaitForward('tsk-a');
    await executor.awaitForward('tsk-b');

    const sessions = executor.sessions.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.session_id).sort()).toEqual(['sess-a', 'sess-b']);
    expect(sessions.every((session) => session.goal === 'same-goal')).toBe(true);
    expect(sessions.map((session) => session.task_ids).flat().sort()).toEqual(['tsk-a', 'tsk-b']);
  });

  it('重复信封按 idempotency 拒绝执行，不产生新 Session/Task', async () => {
    const executor = harness();
    expect(executor.execute(envelope('sess-dup', 'goal', 'tsk-dup', 'msg-dup')).ok).toBe(true);
    const replay = executor.execute(envelope('sess-dup', 'goal', 'tsk-dup', 'msg-dup'));
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.receipt.replay).toBe(true);
    await executor.awaitForward('tsk-dup');
    expect(executor.sessions.list()).toHaveLength(1);
    expect(executor.sessions.require('sess-dup').task_ids).toEqual(['tsk-dup']);
  });
});
