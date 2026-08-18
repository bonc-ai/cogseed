/**
 * S-03：token→peer identity 绑定——HTTP 通道配置 expected_identity 后，
 * 协商必须验证远端身份；身份不符时即使 token 有效也 fail-closed：
 * negotiate 失败（p3394_identity_mismatch）且 send 拒绝发送
 * （p3394_identity_not_negotiated），不做"裸发第一个端点"的退化。
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';

let counter = 0;
const openServers: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 46_300 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(messageId: string) {
  return {
    spec_version: 'p3394/1.0',
    message_id: messageId,
    session_id: 'ses-identity-1',
    task_id: 'tsk-identity-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'client-agent' },
    recipients: [{ agent_id: 'real-agent' }],
    payload: { parts: [{ type: 'text', text: 'identity binding' }] },
    idempotency_key: 'idem-' + messageId,
  } as never;
}

async function startListener(agentId: string, token: string): Promise<{ port: number; received: string[]; server: P3394HttpChannel }> {
  const port = nextPort();
  const received: string[] = [];
  const server = new P3394HttpChannel(agentId + '-server', { listen: { host: '127.0.0.1', port }, authToken: token });
  server.setLocalManifest(manifest(agentId));
  server.subscribe((incoming) => { received.push(incoming.message_id); });
  openServers.push(server);
  await server.listen();
  return { port, received, server };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close().catch(() => {});
});

describe('P3394HttpChannel token→peer identity binding (S-03)', () => {
  it('expected_identity 不匹配时 negotiate 失败（p3394_identity_mismatch），即使 token 有效', async () => {
    const { port } = await startListener('real-agent', 'tok');
    const client = new P3394HttpChannel('id-client', {
      dial: { endpoints: [`http://127.0.0.1:${port}`], bearerToken: 'tok', expected_identity: 'other-agent' },
    });
    openServers.push(client);
    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(false);
    if (!negotiation.ok) {
      expect(negotiation.error.reason).toBe('negotiation_failed');
      expect(negotiation.error.message).toBe('p3394_identity_mismatch');
    }
  });

  it('协商失败后 send 拒绝发送（p3394_identity_not_negotiated），不退化裸发', async () => {
    const { port, received } = await startListener('real-agent', 'tok');
    const client = new P3394HttpChannel('id-client', {
      dial: { endpoints: [`http://127.0.0.1:${port}`], bearerToken: 'tok', expected_identity: 'other-agent' },
    });
    openServers.push(client);
    await client.negotiate();
    await expect(client.send(envelope('msg-identity-1'))).rejects.toThrow('p3394_identity_not_negotiated');
    // 信封没有泄漏到身份不符的端点。
    expect(received).toHaveLength(0);
  });

  it('对照：expected_identity 匹配时协商成功并正常送达', async () => {
    const { port, received } = await startListener('real-agent', 'tok');
    const client = new P3394HttpChannel('id-client', {
      dial: { endpoints: [`http://127.0.0.1:${port}`], bearerToken: 'tok', expected_identity: 'real-agent' },
    });
    openServers.push(client);
    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(true);
    if (negotiation.ok) expect(negotiation.peer_agent_id).toBe('real-agent');
    await client.send(envelope('msg-identity-ok'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toContain('msg-identity-ok');
  });

  it('failover：端点不可达时切换到可达端点并绑定其身份，不静默降级', async () => {
    const b = await startListener('agent-b', 'tok');
    // 第一个端点无监听（连接拒绝），failover 到 agent-b。
    const deadPort = nextPort();
    const client = new P3394HttpChannel('id-client', {
      dial: { endpoints: [`http://127.0.0.1:${deadPort}`, `http://127.0.0.1:${b.port}`], bearerToken: 'tok' },
    });
    openServers.push(client);
    const negotiation = await client.negotiate();
    expect(negotiation.ok).toBe(true);
    if (negotiation.ok) expect(negotiation.peer_agent_id).toBe('agent-b');
    // 信封发给已绑定的可达端点，不会发往死端点。
    await client.send(envelope('msg-failover-1'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.received).toContain('msg-failover-1');
  });
});

// 保持 http 导入被使用（requestFor 传输层引用），避免未使用告警。
void http;
