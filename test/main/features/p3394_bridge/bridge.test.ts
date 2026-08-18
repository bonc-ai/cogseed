import { describe, expect, it } from 'vitest';
import type { Agent } from '../../../../src/main/features/agents';
import { buildP3394BridgeManifest, P3394BridgeKernel, runP3394BridgeDoctor } from '../../../../src/main/features/p3394';

function manifest(id: string) {
  const r = buildP3394BridgeManifest({ agent_id: id, name: id, description_zh: '', description_en: '', workflow: 'w', category: 'general' } as Agent);
  if (!r.ok) throw new Error(r.error.message);
  return r.manifest;
}

describe('P3394 bridge kernel and doctor', () => {
  it('validates, resolves peers, deduplicates sends, and audits order', () => {
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'agent-a', display_name: 'A' }, manifest: manifest('agent-a') });
    bridge.registry.register({ identity: { agent_id: 'agent-b', display_name: 'B' }, manifest: manifest('agent-b') });
    const envelope = { spec_version: 'p3394/1.0', message_id: 'msg-1', session_id: 'session-1', kind: 'task', performative: 'request', sender: { agent_id: 'agent-a' }, recipients: [{ agent_id: 'agent-b' }], payload: { parts: [{ type: 'text', text: 'hello' }] }, idempotency_key: 'idem-1' };
    expect(bridge.send(envelope, { epoch: 1 })).toMatchObject({ ok: true, receipt: { replay: false } });
    expect(bridge.send(envelope)).toMatchObject({ ok: true, receipt: { replay: true } });
    expect(bridge.audit.list().map((r) => r.event)).toContain('bridge.send');
  });

  it('fails closed when discovery does not authorize task delivery', () => {
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'sender', display_name: 'Sender' }, manifest: manifest('sender') });
    const base = manifest('target');
    const noHandle = { ...base, capability_profile: { ...base.capability_profile, capabilities: ['tool.call'] } };
    bridge.registry.register({ identity: { agent_id: 'target', display_name: 'Target' }, manifest: noHandle as never });
    const envelope = { spec_version: 'p3394/1.0', message_id: 'msg-auth-1', session_id: 'session-auth-1', kind: 'task', performative: 'request', sender: { agent_id: 'sender' }, recipients: [{ agent_id: 'target' }], payload: { parts: [{ type: 'text', text: 'hello' }] }, idempotency_key: 'idem-auth-1' };
    expect(bridge.send(envelope)).toMatchObject({ ok: false, error: { reason: 'capability_not_authorized' } });
    expect(bridge.audit.list()).toContainEqual(expect.objectContaining({ event: 'capability.authorize', status: 'rejected' }));

    const capability = new P3394BridgeKernel();
    capability.registry.register({ identity: { agent_id: 'sender', display_name: 'Sender' }, manifest: manifest('sender') });
    capability.registry.register({ identity: { agent_id: 'tool', display_name: 'Tool' }, node_kind: 'capability', capabilities: ['handle_message'], manifest: manifest('tool') });
    expect(capability.send({ ...envelope, message_id: 'msg-auth-2', idempotency_key: 'idem-auth-2', recipients: [{ agent_id: 'tool' }] })).toMatchObject({ ok: false, error: { reason: 'capability_not_authorized' } });

    const performative = new P3394BridgeKernel();
    performative.registry.register({ identity: { agent_id: 'sender', display_name: 'Sender' }, manifest: manifest('sender') });
    const noRequest = { ...manifest('target'), capability_profile: { ...manifest('target').capability_profile, supported_performatives: ['response'] } };
    performative.registry.register({ identity: { agent_id: 'target', display_name: 'Target' }, manifest: noRequest as never });
    expect(performative.send({ ...envelope, message_id: 'msg-auth-3', idempotency_key: 'idem-auth-3' })).toMatchObject({ ok: false, error: { reason: 'performative_not_authorized' } });
  });

  it('doctor reports manifest pass/fail without mutating data', () => {
    expect(runP3394BridgeDoctor({ manifest: manifest('agent-a') })).toMatchObject({ ok: true });
    const bad = runP3394BridgeDoctor({ manifest: { spec_version: 'bad' } });
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === 'manifest')).toMatchObject({ name: 'manifest', status: 'fail' });
  });
});
