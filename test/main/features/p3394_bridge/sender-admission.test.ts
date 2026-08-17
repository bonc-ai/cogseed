/**
 * M-08/M-09/S-03：发送方准入——capability / model_runtime 节点不得发起
 * 自主 task/message（node_kind 来自注册表真实记录，而非信封自述）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeKernel,
} from '../../../../src/main/features/p3394';

function manifest(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-sender-1',
    session_id: 'ses-sender-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'model-node' },
    recipients: [{ agent_id: 'agent-node' }],
    payload: { parts: [{ type: 'text', text: 'do it' }] },
    idempotency_key: 'idem-sender-1',
    ...overrides,
  };
}

function harness() {
  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'agent-node', display_name: 'Agent' }, manifest: manifest('agent-node') });
  return bridge;
}

describe('P3394 kernel sender admission (M-08/M-09/S-03)', () => {
  it('model_runtime nodes cannot initiate tasks', () => {
    const bridge = harness();
    bridge.registry.register({
      identity: { agent_id: 'model-node', display_name: 'Model' },
      manifest: manifest('model-node'),
      node_kind: 'model_runtime',
    });
    const result = bridge.send(envelope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'sender_not_authorized', field: 'sender' });
    const audit = bridge.audit.list().find((record) => record.event === 'sender.authorize');
    expect(audit?.status).toBe('rejected');
  });

  it('capability nodes cannot initiate messages', () => {
    const bridge = harness();
    bridge.registry.register({
      identity: { agent_id: 'model-node', display_name: 'Cap' },
      manifest: manifest('model-node'),
      node_kind: 'capability',
    });
    const result = bridge.send(envelope({ kind: 'message' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'sender_not_authorized' });
  });

  it('agent nodes initiate freely; control frames are unaffected', () => {
    const bridge = harness();
    bridge.registry.register({ identity: { agent_id: 'model-node', display_name: 'Agent' }, manifest: manifest('model-node') });
    expect(bridge.send(envelope()).ok).toBe(true);
    const cancel = bridge.send(envelope({ kind: 'control', performative: 'cancel', task_id: 'tsk-1', payload: { parts: [{ type: 'control', data: { task_id: 'tsk-1' } }] } }));
    expect(cancel.ok).toBe(true);
  });

  it('disabled senders are rejected at resolution (peer_disabled)', () => {
    const bridge = harness();
    const registration = bridge.registry.register({
      identity: { agent_id: 'model-node', display_name: 'Agent' },
      manifest: manifest('model-node'),
      node_kind: 'agent',
    });
    expect(registration.ok).toBe(true);
    bridge.registry.disable('model-node');
    const result = bridge.send(envelope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'peer_disabled' });
  });
});
