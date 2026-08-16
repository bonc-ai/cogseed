import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  P3394HttpChannel,
  p3394CheckEnvelopeDigests,
} from '../../../../src/main/features/p3394_bridge/http-channel';
import {
  buildP3394BridgeManifest,
} from '../../../../src/main/features/p3394_bridge/manifest';
import {
  p3394ExternalDescriptorFromManifest,
  validateP3394ExternalAdapterDescriptor,
} from '../../../../src/main/features/p3394_bridge/external-adapters';

let counter = 0;
const openServers: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 43_100 + counter;
}

function endpointFor(port: number): string {
  return 'http://127.0.0.1:' + port;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-http-' + counter,
    session_id: 'ses-http-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'remote-agent' },
    recipients: [{ agent_id: 'cogseed-agent' }],
    payload: { parts: [{ type: 'text', text: 'hello over http' }] },
    idempotency_key: 'idem-http-' + counter,
    ...overrides,
  } as never;
}

async function waitFor(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close().catch(() => {});
});

describe('P3394HttpChannel real network transport', () => {
  it('negotiates and delivers an envelope across a real HTTP round trip', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('server', { listen: { port }, authToken: 'tok' });
    server.setLocalManifest(manifest('cogseed-agent'));
    openServers.push(server);
    await server.listen();

    const received: string[] = [];
    server.subscribe((e) => received.push(e.message_id));

    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(port)], bearerToken: 'tok' },
    });
    openServers.push(client);
    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(true);
    if (negotiation.ok) expect(negotiation.peer_agent_id).toBe('cogseed-agent');
    await client.send(envelope({ message_id: 'msg-http-roundtrip' }));
    await waitFor(() => received.includes('msg-http-roundtrip'));
    expect(received).toContain('msg-http-roundtrip');
  });

  it('fails closed when the dial token is wrong (401 on manifest)', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('server', { listen: { port }, authToken: 'secret' });
    server.setLocalManifest(manifest('cogseed-agent'));
    openServers.push(server);
    await server.listen();

    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(port)], bearerToken: 'wrong' },
    });
    openServers.push(client);
    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(false);
    if (!negotiation.ok) expect(negotiation.error.reason).toBe('negotiation_failed');
  });

  it('fails explicitly when the peer rejects an envelope (no silent degradation)', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('server', { listen: { port }, authToken: 'tok' });
    server.setLocalManifest(manifest('cogseed-agent'));
    openServers.push(server);
    await server.listen();

    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(port)], bearerToken: 'tok' },
    });
    openServers.push(client);
    await client.negotiate();
    // A digest-mismatched envelope is rejected by the peer with 422; the
    // sender must see the failure, not a fake success.
    const badDigest = '0'.repeat(64);
    await expect(client.send(envelope({
      payload: { parts: [{ type: 'resource', uri: 'p3394-object:sha256:abc', digest: badDigest }] },
    }) as never)).rejects.toThrow(/send_http_422/);
  });

  it('fails over endpoints while keeping the agent identity', async () => {
    // First endpoint is down, second is the real server.
    const deadPort = nextPort();
    const livePort = nextPort();
    const server = new P3394HttpChannel('server', { listen: { port: livePort }, authToken: 'tok' });
    server.setLocalManifest(manifest('stable-agent'));
    openServers.push(server);
    await server.listen();

    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(deadPort), endpointFor(livePort)], bearerToken: 'tok' },
    });
    openServers.push(client);
    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(true);
    if (negotiation.ok) expect(negotiation.peer_agent_id).toBe('stable-agent');
  });

  it('rejects endpoint failover that changes the agent identity', async () => {
    const portA = nextPort();
    const portB = nextPort();
    const serverA = new P3394HttpChannel('serverA', { listen: { port: portA }, authToken: 'tok' });
    serverA.setLocalManifest(manifest('agent-alpha'));
    openServers.push(serverA);
    await serverA.listen();
    const serverB = new P3394HttpChannel('serverB', { listen: { port: portB }, authToken: 'tok' });
    serverB.setLocalManifest(manifest('agent-beta'));
    openServers.push(serverB);
    await serverB.listen();

    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(portA), endpointFor(portB)], bearerToken: 'tok' },
    });
    openServers.push(client);
    const first = await client.negotiate();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.peer_agent_id).toBe('agent-alpha');

    // Primary endpoint goes down; the backup answers with a different
    // identity — the failover must be rejected, keeping agent identity stable.
    await serverA.close();
    const second = await client.negotiate();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toBe('identity_changed_across_endpoints');
  });

  it('rejects an oversized envelope body with 413', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('server', { listen: { port }, authToken: 'tok', maxBodyBytes: 256 });
    openServers.push(server);
    await server.listen();

    const big = { envelope: { spec_version: 'p3394/1.0', message_id: 'm', session_id: 's', kind: 'message', performative: 'request', sender: { agent_id: 'a' }, recipients: [{ agent_id: 'b' }], payload: { parts: [{ type: 'text', text: 'x'.repeat(500) }] }, idempotency_key: 'k' } };
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/p3394/envelope', method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.end(JSON.stringify(big));
    });
    expect(status).toBe(413);
  });

  it('rejects a missing spec_version before dispatch (422)', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('server', { listen: { port }, authToken: 'tok' });
    openServers.push(server);
    await server.listen();

    const payload = { envelope: {
      message_id: 'msg-missing-version', session_id: 's', kind: 'message', performative: 'request',
      sender: { agent_id: 'a' }, recipients: [{ agent_id: 'b' }],
      payload: { parts: [{ type: 'text', text: 'missing version' }] }, idempotency_key: 'k-missing-version',
    } };
    const response = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/p3394/envelope', method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.end(JSON.stringify(payload));
    });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: 'missing_spec_version' });
  });

  it('rejects a digest mismatch before dispatch (422)', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('server', { listen: { port }, authToken: 'tok' });
    openServers.push(server);
    const received: string[] = [];
    server.subscribe((e) => received.push(e.message_id));
    await server.listen();

    const badDigest = '0'.repeat(64);
    const payload = { envelope: {
      spec_version: 'p3394/1.0', message_id: 'msg-digest', session_id: 's', kind: 'message', performative: 'request',
      sender: { agent_id: 'a' }, recipients: [{ agent_id: 'b' }],
      payload: { parts: [{ type: 'resource', uri: 'p3394-object:sha256:abc', digest: badDigest }] },
      idempotency_key: 'k-digest',
    } };
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/p3394/envelope', method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.end(JSON.stringify(payload));
    });
    expect(status).toBe(422);
    expect(received).toEqual([]);
  });
});

describe('P3394 envelope digest integrity', () => {
  it('accepts a matching sha256 digest for a uri part', () => {
    const uri = 'p3394-object:sha256:known-value';
    const digest = require('node:crypto').createHash('sha256').update(uri).digest('hex');
    expect(p3394CheckEnvelopeDigests({
      payload: { parts: [{ type: 'resource', uri, digest }] },
    })).toEqual({ ok: true });
  });

  it('rejects a malformed digest', () => {
    expect(p3394CheckEnvelopeDigests({
      payload: { parts: [{ type: 'resource', uri: 'x', digest: 'not-a-hash' }] },
    })).toEqual({ ok: false, error: 'invalid_digest_at_0' });
  });

  it('rejects a mismatched digest', () => {
    expect(p3394CheckEnvelopeDigests({
      payload: { parts: [{ type: 'resource', uri: 'p3394-object:sha256:a', digest: '1'.repeat(64) }] },
    })).toEqual({ ok: false, error: 'digest_mismatch_at_0' });
  });
});

describe('P3394 external adapter profiles', () => {
  it('classifies a handle_message peer as an agent', () => {
    const descriptor = p3394ExternalDescriptorFromManifest(manifest('peer-agent'), { endpoint: 'http://x', authorized: true });
    expect(descriptor.kind).toBe('agent');
  });

  it('classifies a non-agent manifest as a capability node', () => {
    const capabilityManifest = { ...manifest('peer-cap'), capability_profile: { ...manifest('peer-cap').capability_profile, capabilities: ['tool.call'] } };
    const descriptor = p3394ExternalDescriptorFromManifest(capabilityManifest, { endpoint: 'http://x', authorized: true });
    expect(descriptor.kind).toBe('capability');
  });

  it('refuses autonomous-agent claims on non-agent nodes', () => {
    const fake = {
      id: 'model', kind: 'model-runtime' as const, endpoint: 'http://model', authorized: true,
      capabilities: ['autonomous-agent', 'model.complete'],
    };
    const result = validateP3394ExternalAdapterDescriptor(fake);
    expect(result.ok).toBe(false);
  });

  it('strips autonomous-agent claims from a non-agent manifest', () => {
    const profile = { ...manifest('m').capability_profile, capabilities: ['model.complete', 'autonomous-agent'] };
    const descriptor = p3394ExternalDescriptorFromManifest({ ...manifest('m'), capability_profile: profile }, { endpoint: 'http://m', authorized: true });
    expect(descriptor.kind).toBe('capability');
    expect(descriptor.capabilities).not.toContain('autonomous-agent');
  });
});
