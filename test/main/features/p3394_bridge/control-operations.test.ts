/**
 * S-07：P3394 控制操作的人工确认与授权边界测试。
 *
 * 跨节点 cancel 必须：(1) 通过内核身份/能力准入（未注册 sender 拒绝）；
 * (2) 不创建 Session；(3) 写审计（谁取消了什么任务）。
 */

import { describe, expect, it, vi } from 'vitest';
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

function harness() {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'peer-a', display_name: 'Peer' }, manifest: manifest('peer-a') });
  bridge.registry.register({ identity: { agent_id: 'local-agent', display_name: 'Local' }, manifest: manifest('local-agent') });
  const runtime = new P3394InMemoryRuntimeAdapter();
  const cancelSpy = vi.spyOn(runtime, 'cancel');
  const executor = new P3394BridgeExecutor({ bridge, runtime });
  return { executor, cancelSpy, bridge };
}

function cancelEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-cancel-1',
    session_id: 'ses-cancel-1',
    task_id: 'tsk-cancel-1',
    kind: 'control',
    performative: 'cancel',
    sender: { agent_id: 'peer-a' },
    recipients: [{ agent_id: 'local-agent' }],
    payload: { parts: [{ type: 'control', data: { task_id: 'tsk-cancel-1' } }] },
    idempotency_key: 'idem-cancel-1',
    ...overrides,
  };
}

describe('P3394 control operations (S-07)', () => {
  it('authenticated cross-node cancel runs, audits, and opens no session', async () => {
    const { executor, cancelSpy, bridge } = harness();
    const result = executor.execute(cancelEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.executed).toBe(false);
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith('tsk-cancel-1'));
    expect(executor.sessions.list()).toHaveLength(0);
    const audit = bridge.audit.list().find((record) => record.event === 'control.cancel');
    expect(audit).toMatchObject({
      actor_id: 'peer-a',
      status: 'accepted',
      metadata: { task_id: 'tsk-cancel-1', session_id: 'ses-cancel-1' },
    });
  });

  it('unregistered senders cannot cancel (kernel admission fail-closed)', async () => {
    const { executor, cancelSpy } = harness();
    const result = executor.execute(cancelEnvelope({ sender: { agent_id: 'stranger' }, message_id: 'msg-cancel-2', idempotency_key: 'idem-cancel-2' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'peer_not_found' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
