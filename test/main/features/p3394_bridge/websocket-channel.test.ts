/**
 * C-05：真实 WebSocket channel 验收——listener/dialer、Bearer 认证、
 * expected_identity 绑定、TLS（wss）、failover、统一速率/并发限制。
 *
 * 协议：envelope 走 WS 帧（`{"envelope": {...}}` → `{"ok":true,...}` /
 * `{"ok":false,"error":...}`）；HTTP 端点（manifest/health/objects）与
 * 认证/限制复用 P3394HttpChannel 实现。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { P3394WebSocketChannel } from '../../../../src/main/features/p3394_bridge/websocket-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';

let counter = 0;
const openChannels: P3394WebSocketChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 47_000 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(messageId: string, sessionId = 'ses-ws-1', taskId = 'tsk-ws-1') {
  return {
    spec_version: 'p3394/1.0',
    message_id: messageId,
    session_id: sessionId,
    task_id: taskId,
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'node-a' },
    recipients: [{ agent_id: 'node-b' }],
    payload: { parts: [{ type: 'text', text: 'ws round trip' }] },
    idempotency_key: 'idem-' + messageId,
  } as never;
}

function waitFor(probe: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (probe()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('waitFor timeout'));
      }
    }, 25);
  });
}

afterEach(async () => {
  for (const channel of openChannels.splice(0)) await channel.close().catch(() => {});
});

describe('P3394WebSocketChannel real transport (C-05)', () => {
  it('listener + dialer 双向闭环：B 发 task → A 收到并回发 → B 收到', async () => {
    const port = nextPort();
    const server = new P3394WebSocketChannel('ws-server', { listen: { host: '127.0.0.1', port }, authToken: 'ws-token' });
    server.setLocalManifest(manifest('node-b'));
    const received: string[] = [];
    server.subscribe((incoming) => { received.push(incoming.message_id); });
    await server.listen();
    openChannels.push(server);

    const client = new P3394WebSocketChannel('ws-client', {
      dial: { endpoints: [`ws://127.0.0.1:${port}`], bearerToken: 'ws-token', expected_identity: 'node-b' },
    });
    openChannels.push(client);
    await client.dial('node-b');
    const receipt = await client.send(envelope('msg-ws-1'));
    expect(receipt.accepted).toBe(true);
    await waitFor(() => received.includes('msg-ws-1'));
    expect(received).toEqual(['msg-ws-1']);

    // A 侧主动回发：dial socket 收到（双向流）。
    const replyTexts: string[] = [];
    const dialRaw = new WebSocket(`ws://127.0.0.1:${port}/p3394/ws`, { headers: { Authorization: 'Bearer ws-token' } });
    await new Promise<void>((resolve, reject) => {
      dialRaw.on('open', () => resolve());
      dialRaw.on('error', reject);
    });
    dialRaw.on('message', (data) => {
      try {
        const parsed = JSON.parse(String(data));
        if (parsed.message_id === 'msg-ws-reply') replyTexts.push(parsed.message_id);
      } catch { /* keepalive */ }
    });
    dialRaw.send(JSON.stringify({ envelope: {
      spec_version: 'p3394/1.0', message_id: 'msg-ws-reply', session_id: 'ses-ws-1', kind: 'message', performative: 'inform',
      sender: { agent_id: 'node-b' }, recipients: [{ agent_id: 'node-a' }],
      payload: { parts: [{ type: 'text', text: 'reply over ws' }] },
      idempotency_key: 'idem-ws-reply',
    } }));
    await waitFor(() => replyTexts.includes('msg-ws-reply'));
    dialRaw.close();
  });

  it('错误 token 握手被拒（401 语义 + 审计），合法 token 连接成功', async () => {
    const port = nextPort();
    const audit: Array<Record<string, unknown>> = [];
    const server = new P3394WebSocketChannel('ws-auth', {
      listen: { host: '127.0.0.1', port },
      authToken: 'correct',
      audit: (record) => { audit.push(record as unknown as Record<string, unknown>); },
    });
    server.setLocalManifest(manifest('node-b'));
    await server.listen();
    openChannels.push(server);

    // 错误 token：握手失败。
    await expect(new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/p3394/ws`, { headers: { Authorization: 'Bearer wrong' } });
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => resolve());
      ws.on('unexpected-response', () => resolve());
      setTimeout(() => resolve(), 2000);
    })).resolves.toBeUndefined();
    expect(audit.some((record) => record.event === 'http.auth.reject')).toBe(true);

    // 合法 token：dial 成功。
    const client = new P3394WebSocketChannel('ws-ok', { dial: { endpoints: [`ws://127.0.0.1:${port}`], bearerToken: 'correct', expected_identity: 'node-b' } });
    openChannels.push(client);
    await client.dial('node-b');
  });

  it('expected_identity 不匹配 fail-closed，匹配时绑定成功', async () => {
    const port = nextPort();
    const server = new P3394WebSocketChannel('ws-id', { listen: { host: '127.0.0.1', port }, authToken: 't' });
    server.setLocalManifest(manifest('real-node'));
    await server.listen();
    openChannels.push(server);

    const mismatched = new P3394WebSocketChannel('ws-id-bad', { dial: { endpoints: [`ws://127.0.0.1:${port}`], bearerToken: 't', expected_identity: 'other-node' } });
    openChannels.push(mismatched);
    const negotiation = await mismatched.negotiate();
    expect(negotiation.ok).toBe(false);
    if (!negotiation.ok) expect(negotiation.error.message).toBe('p3394_identity_mismatch');
    await expect(mismatched.send(envelope('msg-id-1'))).rejects.toThrow('p3394_websocket_not_connected');
    // 协商失败后 send 拒绝（S-03 门禁语义由 negotiate 失败 + 未连接覆盖）。

    const matched = new P3394WebSocketChannel('ws-id-ok', { dial: { endpoints: [`ws://127.0.0.1:${port}`], bearerToken: 't', expected_identity: 'real-node' } });
    openChannels.push(matched);
    const ok = await matched.negotiate();
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.peer_agent_id).toBe('real-node');
  });

  it('wss（TLS）round trip：自签证书 + Bearer 认证', async () => {
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-ws-tls-'));
    const key = path.join(certDir, 'key.pem');
    const cert = path.join(certDir, 'cert.pem');
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
      const port = nextPort();
      const server = new P3394WebSocketChannel('wss-server', {
        listen: { host: '127.0.0.1', port, tls: { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') } },
        authToken: 'tls-token',
      });
      server.setLocalManifest(manifest('node-b'));
      const received: string[] = [];
      server.subscribe((incoming) => { received.push(incoming.message_id); });
      await server.listen();
      openChannels.push(server);

      const client = new P3394WebSocketChannel('wss-client', {
        dial: { endpoints: [`wss://127.0.0.1:${port}`], bearerToken: 'tls-token', tls: { rejectUnauthorized: false }, expected_identity: 'node-b' },
      });
      openChannels.push(client);
      await client.dial('node-b');
      const receipt = await client.send(envelope('msg-wss-1'));
      expect(receipt.accepted).toBe(true);
      await waitFor(() => received.includes('msg-wss-1'));
    } finally {
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  it('failover：端点不可达时切换到可达端点并绑定其身份', async () => {
    const port = nextPort();
    const server = new P3394WebSocketChannel('ws-failover', { listen: { host: '127.0.0.1', port }, authToken: 't' });
    server.setLocalManifest(manifest('node-b'));
    const received: string[] = [];
    server.subscribe((incoming) => { received.push(incoming.message_id); });
    await server.listen();
    openChannels.push(server);

    const deadPort = nextPort();
    const client = new P3394WebSocketChannel('ws-failover-client', {
      dial: { endpoints: [`ws://127.0.0.1:${deadPort}`, `ws://127.0.0.1:${port}`], bearerToken: 't', expected_identity: 'node-b' },
    });
    openChannels.push(client);
    await client.dial('node-b');
    const receipt = await client.send(envelope('msg-failover-ws'));
    expect(receipt.accepted).toBe(true);
    await waitFor(() => received.includes('msg-failover-ws'));
  });

  it('统一速率限制：超限消息 rate_limited（S-06）', async () => {
    const port = nextPort();
    const server = new P3394WebSocketChannel('ws-rate', {
      listen: { host: '127.0.0.1', port },
      authToken: 't',
      maxInboundRequestsPerMinute: 2,
    });
    server.setLocalManifest(manifest('node-b'));
    await server.listen();
    openChannels.push(server);

    const client = new P3394WebSocketChannel('ws-rate-client', { dial: { endpoints: [`ws://127.0.0.1:${port}`], bearerToken: 't', expected_identity: 'node-b' } });
    openChannels.push(client);
    await client.dial('node-b');
    expect((await client.send(envelope('msg-rate-1'))).accepted).toBe(true);
    expect((await client.send(envelope('msg-rate-2'))).accepted).toBe(true);
    await expect(client.send(envelope('msg-rate-3'))).rejects.toThrow(/p3394_websocket_rejected:rate_limited/);
  });

  it('统一并发限制：连接数超限拒绝 upgrade（503 语义，S-06）', async () => {
    const port = nextPort();
    const server = new P3394WebSocketChannel('ws-conc', {
      listen: { host: '127.0.0.1', port },
      authToken: 't',
      maxConcurrentRequests: 1,
    });
    server.setLocalManifest(manifest('node-b'));
    await server.listen();
    openChannels.push(server);

    const first = new P3394WebSocketChannel('ws-conc-1', { dial: { endpoints: [`ws://127.0.0.1:${port}`], bearerToken: 't', expected_identity: 'node-b' } });
    openChannels.push(first);
    await first.dial('node-b');

    // 第二个连接：握手被拒（unexpected-response 503）。
    let rejected = false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/p3394/ws`, { headers: { Authorization: 'Bearer t' } });
      ws.on('open', () => { rejected = false; ws.close(); resolve(); });
      ws.on('unexpected-response', (_req, res) => { rejected = res.statusCode === 503; resolve(); });
      ws.on('error', () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    expect(rejected).toBe(true);
  });
});
