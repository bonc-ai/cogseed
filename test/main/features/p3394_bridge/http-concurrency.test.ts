/**
 * S-06：HTTP listener 统一入站并发限制——超限 503 channel_busy 不排队，
 * 请求完成后计数释放，后续请求恢复 200。
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';

let counter = 0;
const openServers: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 48_100 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelopeBody() {
  return JSON.stringify({
    envelope: {
      spec_version: 'p3394/1.0',
      message_id: 'msg-conc-' + counter,
      session_id: 'ses-conc-1',
      kind: 'message',
      performative: 'request',
      sender: { agent_id: 'remote-agent' },
      recipients: [{ agent_id: 'cogseed-agent' }],
      payload: { parts: [{ type: 'text', text: 'hello' }] },
      idempotency_key: 'idem-conc-' + counter,
    },
  });
}

function startRequest(port: number, body: string, deferBody = false): { req: http.ClientRequest; done: Promise<number> } {
  const req = http.request({
    host: '127.0.0.1', port, path: '/p3394/envelope', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer tok' },
  });
  const done = new Promise<number>((resolve, reject) => {
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
  if (!deferBody) req.end(body);
  return { req, done };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close().catch(() => {});
});

describe('P3394HttpChannel inbound concurrency limit (S-06)', () => {
  it('超限立即 503 channel_busy，完成后恢复', async () => {
    const port = nextPort();
    const server = new P3394HttpChannel('conc-server', {
      listen: { port },
      authToken: 'tok',
      maxConcurrentRequests: 1,
    });
    server.setLocalManifest(manifest('cogseed-agent'));
    openServers.push(server);
    await server.listen();

    // 请求 1：只写一半 body，挂起在途。
    const body = envelopeBody();
    const first = startRequest(port, body, true);
    first.req.write(body.slice(0, Math.floor(body.length / 2)));

    // 请求 2：并发已满 → 503。
    const second = startRequest(port, envelopeBody());
    expect(await second.done).toBe(503);

    // 完成请求 1 → 200。
    first.req.end(body.slice(Math.floor(body.length / 2)));
    expect(await first.done).toBe(200);

    // 计数释放后，新请求恢复 200。
    const third = startRequest(port, envelopeBody());
    expect(await third.done).toBe(200);
  });
});
