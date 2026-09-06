/**
 * §17.4 Endpoint Failover 不改 Identity（独立最小桩服务实现，不依赖
 * http-channel.test.ts 的内部）：
 *  - dial 拿到的 manifest agent_id 与 expected_identity 不符 → 拒绝
 *    （negotiation_failed / p3394_identity_mismatch）；
 *  - endpoint 切换（failover）后同一 agent 身份变化 → 拒绝
 *    （identity_changed_across_endpoints）；
 *  - 身份验证失败绝不静默发送：协商未过 → send 抛
 *    p3394_identity_not_negotiated，对端零接收。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

// 独立端口区间（避开 http-channel.test.ts 的 43100+），避免并行端口冲突。
let counter = 0;
const openServers: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 45_900 + counter;
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

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-failover-' + counter,
    session_id: 'ses-failover-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'local-agent' },
    recipients: [{ agent_id: 'remote-agent' }],
    payload: { parts: [{ type: 'text', text: 'hello failover' }] },
    idempotency_key: 'idem-failover-' + counter,
    ...overrides,
  } as P3394Envelope;
}

/** 起一台最小桩服务：显式端口，返回 channel 与收到的 message_id 列表。 */
async function startStubServer(agentId: string, port: number): Promise<{ channel: P3394HttpChannel; received: string[] }> {
  const channel = new P3394HttpChannel('server-' + agentId, { listen: { port }, authToken: 'tok' });
  channel.setLocalManifest(manifest(agentId));
  const received: string[] = [];
  channel.subscribe((incoming) => { received.push(incoming.message_id); });
  await channel.listen();
  openServers.push(channel);
  return { channel, received };
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

describe('P3394 http endpoint failover keeps agent identity (§17.4)', () => {
  it('rejects dial when the remote manifest identity does not match expected_identity', async () => {
    const port = nextPort();
    const { received } = await startStubServer('agent-imposter', port);
    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(port)], bearerToken: 'tok', expected_identity: 'agent-trusted' },
    });
    openServers.push(client);

    // 注册表声明 expected_identity=agent-trusted，对端 manifest 自报
    // agent-imposter → 协商明确失败，不静默接受。
    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(false);
    if (!negotiation.ok) {
      expect(negotiation.error.reason).toBe('negotiation_failed');
      expect(negotiation.error.message).toContain('identity_mismatch');
    }

    // 身份验证失败绝不静默发送：send 必须抛错，对端零接收。
    await expect(client.send(envelope())).rejects.toThrow('p3394_identity_not_negotiated');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toEqual([]);
  });

  it('rejects endpoint failover that changes the agent identity', async () => {
    const portA = nextPort();
    const portB = nextPort();
    const alpha = await startStubServer('agent-alpha', portA);
    const beta = await startStubServer('agent-beta', portB);

    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(portA), endpointFor(portB)], bearerToken: 'tok' },
    });
    openServers.push(client);

    // 第一次协商：主端点 A 应答 agent-alpha。
    const first = await client.negotiate();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.peer_agent_id).toBe('agent-alpha');

    // 主端点下线；备用端点 B 自报 agent-beta —— 同一 agent 的端点集合
    // 不允许换身份，failover 必须被拒绝。
    await alpha.channel.close();
    const second = await client.negotiate();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toBe('identity_changed_across_endpoints');

    // 拒绝 failover 后绝不向新身份静默发送。
    await expect(client.send(envelope())).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(beta.received).toEqual([]);
  });

  it('still delivers after a failover that keeps the same identity', async () => {
    // 对照组：端点切换但身份不变 → 正常 failover，投递成功。
    const deadPort = nextPort();
    const livePort = nextPort();
    const { received } = await startStubServer('agent-stable', livePort);

    const client = new P3394HttpChannel('client', {
      dial: { endpoints: [endpointFor(deadPort), endpointFor(livePort)], bearerToken: 'tok', expected_identity: 'agent-stable' },
    });
    openServers.push(client);

    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(true);
    if (negotiation.ok) expect(negotiation.peer_agent_id).toBe('agent-stable');

    const message = envelope({ message_id: 'msg-failover-ok', idempotency_key: 'idem-failover-ok' });
    await client.send(message);
    await waitFor(() => received.includes('msg-failover-ok'));
    expect(received).toContain('msg-failover-ok');
  });
});
