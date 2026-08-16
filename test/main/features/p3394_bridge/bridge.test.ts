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

  it('doctor reports manifest pass/fail without mutating data', () => {
    expect(runP3394BridgeDoctor({ manifest: manifest('agent-a') })).toMatchObject({ ok: true });
    const bad = runP3394BridgeDoctor({ manifest: { spec_version: 'bad' } });
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === 'manifest')).toMatchObject({ name: 'manifest', status: 'fail' });
  });
});
