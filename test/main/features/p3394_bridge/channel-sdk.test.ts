import { describe, expect, it } from 'vitest';
import { P3394ChannelRegistry, buildP3394ChannelDescriptor, missingP3394ChannelCapabilities } from '../../../../src/main/features/p3394_bridge/channel-adapter';
import { P3394InProcessChannel } from '../../../../src/main/features/p3394_bridge/in-process-channel';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';

function fakeAdapter(id: string, schemes: string[]) {
  return {
    descriptor: buildP3394ChannelDescriptor({
      id,
      schemes,
      roles: ['dialer'] as const,
      bindings: ['umf-json'],
      capabilities: { streaming: 'none' as const, durable_tasks: false, cancellation: false, artifacts: 'none' as const, multi_party_sessions: false, identity_proofs: [] },
    }),
    async listen() {},
    async dial() {},
    async send() { return { channel_id: id, message_id: 'm', accepted: true }; },
    subscribe() { return () => {}; },
    async close() {},
  };
}

describe('P3394 channel adapter SDK (SDK design §5.2-§5.4)', () => {
  it('declares built-in adapters with descriptors (schemes, roles, bindings, capabilities)', () => {
    const http = new P3394HttpChannel('http-test');
    expect(http.descriptor.id).toBe('org.p3394.channel.native_https');
    expect(http.descriptor.schemes).toEqual(['p3394+https', 'p3394+wss']);
    expect(http.descriptor.roles).toEqual(['listener', 'dialer']);
    expect(http.descriptor.bindings).toEqual(['umf-json']);
    expect(http.descriptor.capabilities.durable_tasks).toBe(true);
    expect(http.descriptor.capabilities.artifacts).toBe('inline');
    expect(http.descriptor.capabilities.identity_proofs).toContain('bearer-token');

    const ipc = new P3394InProcessChannel();
    expect(ipc.descriptor.schemes).toEqual(['p3394+inprocess']);
  });

  it('resolves adapters by URI scheme and rejects duplicate scheme claims', () => {
    const registry = new P3394ChannelRegistry();
    const a = fakeAdapter('org.example.one', ['p3394+https', 'p3394+wss']);
    const b = fakeAdapter('org.example.two', ['p3394+wss']);
    expect(registry.register(a)).toEqual({ ok: true });
    expect(registry.resolveByScheme('p3394+https')).toBe(a);
    const conflict = registry.register(b);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error('expected scheme conflict');
    expect(conflict.error.reason).toBe('scheme_conflict');
    expect(registry.resolveByScheme('p3394+ipc')).toBeNull();
  });

  it('refuses startup semantics the adapter cannot carry', () => {
    const minimal = fakeAdapter('org.example.min', ['p3394+min']).descriptor;
    expect(missingP3394ChannelCapabilities(minimal, { durable_tasks: true })).toEqual(['durable_tasks']);
    expect(missingP3394ChannelCapabilities(minimal, { streaming: 'bidirectional' })).toEqual(['streaming:bidirectional']);
    expect(missingP3394ChannelCapabilities(minimal, { artifacts: 'referenced' })).toEqual(['artifacts:referenced']);
    expect(missingP3394ChannelCapabilities(minimal, { identity_proofs: ['mtls'] })).toEqual(['identity_proof:mtls']);
    expect(missingP3394ChannelCapabilities(minimal, { cancellation: false })).toEqual([]);
    const http = new P3394HttpChannel('http-test').descriptor;
    expect(missingP3394ChannelCapabilities(http, { durable_tasks: true, cancellation: true })).toEqual([]);
  });

  it('reports channel health', async () => {
    const ipc = new P3394InProcessChannel();
    const health = await ipc.health?.();
    expect(health).toMatchObject({ ok: true, scheme: 'p3394+inprocess' });
    await ipc.close();
    expect((await ipc.health?.())?.ok).toBe(false);
  });
});
