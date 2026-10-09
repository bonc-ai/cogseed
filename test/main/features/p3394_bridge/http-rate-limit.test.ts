/**
 * http-channel 统一入站速率限制集成测试（S-06）。
 * 直接走真实 HTTP 往返：限流窗内 429 + retry_after_ms，health 探活豁免，
 * 窗口推进后恢复。
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';

let counter = 0;
const openServers: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 45_100 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope() {
  counter += 1;
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-rate-' + counter,
    session_id: 'ses-rate-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'remote-agent' },
    recipients: [{ agent_id: 'cogseed-agent' }],
    payload: { parts: [{ type: 'text', text: 'hello under rate limit' }] },
    idempotency_key: 'idem-rate-' + counter,
  };
}

function request(port: number, path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
        Authorization: 'Bearer tok',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    if (payload === undefined) req.end();
    else req.end(payload);
  });
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close().catch(() => {});
});

describe('P3394HttpChannel inbound rate limiting (S-06)', () => {
  it('limits inbound requests per minute, keeps health exempt, and recovers after the window', async () => {
    let nowMs = 1_000_000;
    const port = nextPort();
    const server = new P3394HttpChannel('rate-server', {
      listen: { port },
      authToken: 'tok',
      maxInboundRequestsPerMinute: 3,
      now: () => nowMs,
    });
    server.setLocalManifest(manifest('cogseed-agent'));
    openServers.push(server);
    await server.listen();

    // health 探活豁免：连续 5 次仍 200。
    for (let i = 0; i < 5; i += 1) {
      const health = await request(port, '/p3394/health', 'GET');
      expect(health.status).toBe(200);
    }
    // 窗内 3 次正常投递。
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(port, '/p3394/envelope', 'POST', { envelope: envelope() });
      expect(ok.status).toBe(200);
    }
    // 第 4 次超限：429 + 机器可读 retry_after_ms。
    const limited = await request(port, '/p3394/envelope', 'POST', { envelope: envelope() });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(typeof limited.body.retry_after_ms).toBe('number');

    // 窗口推进后恢复。
    nowMs += 60_000;
    const recovered = await request(port, '/p3394/envelope', 'POST', { envelope: envelope() });
    expect(recovered.status).toBe(200);
  });

  it('zero rate limit disables limiting (backward compatible)', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('rate-off-server', {
      listen: { port },
      authToken: 'tok',
      maxInboundRequestsPerMinute: 0,
    });
    server.setLocalManifest(manifest('cogseed-agent'));
    openServers.push(server);
    await server.listen();
    for (let i = 0; i < 8; i += 1) {
      const res = await request(port, '/p3394/envelope', 'POST', { envelope: envelope() });
      expect(res.status).toBe(200);
    }
  });
});
