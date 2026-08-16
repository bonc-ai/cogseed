/**
 * Inbound replay watermark（M-04/S-05）：envelope.extensions.epoch 进入内核
 * replay protector；无 epoch 的 peer 保持 idempotency-only 语义，畸形 epoch
 * 被忽略而不是打断 admission。
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

function envelope(messageId: string, epoch?: unknown) {
  return {
    spec_version: 'p3394/1.0',
    message_id: messageId,
    session_id: 'ses-epoch',
    task_id: 'tsk-' + messageId,
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'peer-a' },
    recipients: [{ agent_id: 'local-agent' }],
    payload: { parts: [{ type: 'text', text: 'do it' }] },
    idempotency_key: 'idem-' + messageId,
    ...(epoch === undefined ? {} : { extensions: { epoch } }),
  };
}

function harness(): P3394BridgeExecutor {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'peer-a', display_name: 'Peer' }, manifest: manifest('peer-a') });
  bridge.registry.register({ identity: { agent_id: 'local-agent', display_name: 'Local' }, manifest: manifest('local-agent') });
  return new P3394BridgeExecutor({ bridge, runtime: new P3394InMemoryRuntimeAdapter() });
}

describe('P3394 executor inbound replay epoch (M-04/S-05)', () => {
  it('a repeated epoch from the same sender is rejected before execution', async () => {
    const executor = harness();
    const first = executor.execute(envelope('msg-e1', 1));
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.executed).toBe(true);
      await executor.awaitForward(first.task_id as string);
    }
    const replayed = executor.execute(envelope('msg-e1', 1));
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error).toMatchObject({ reason: 'replay_detected' });
    // 拒绝发生在 runtime 之前：不产生新任务。
    expect(executor.sessions.require('ses-epoch').task_ids).toEqual(['tsk-msg-e1']);
  });

  it('a higher epoch advances the watermark; an older one is rejected', async () => {
    const executor = harness();
    expect(executor.execute(envelope('msg-e2', 1)).ok).toBe(true);
    await executor.awaitForward('tsk-msg-e2');
    expect(executor.execute(envelope('msg-e3', 2)).ok).toBe(true);
    await executor.awaitForward('tsk-msg-e3');
    const older = executor.execute(envelope('msg-e4', 1));
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.error).toMatchObject({ reason: 'replay_detected' });
  });

  it('malformed epochs are ignored without crashing admission', async () => {
    const executor = harness();
    for (const bad of ['x', -1, 1.5]) {
      const result = executor.execute(envelope('msg-bad-' + String(bad), bad));
      expect(result.ok).toBe(true);
      if (result.ok) await executor.awaitForward(result.task_id as string);
    }
  });

  it('peers without an epoch keep idempotency-only semantics', async () => {
    const executor = harness();
    const first = executor.execute(envelope('msg-e5'));
    expect(first.ok).toBe(true);
    if (first.ok) await executor.awaitForward(first.task_id as string);
    const duplicate = executor.execute(envelope('msg-e5'));
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) {
      expect(duplicate.receipt.replay).toBe(true);
      expect(duplicate.executed).toBe(false);
    }
  });
});
