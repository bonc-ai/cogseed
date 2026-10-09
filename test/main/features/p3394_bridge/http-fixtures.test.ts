/**
 * 运行 HTTP channel fixture 目录（Conformance Matrix V-02）：每条 fixture
 * 在真实 listener 上按声明配置执行，断言状态码 + 机器可读错误码；拒绝
 * 错误码集合的覆盖由 HTTP_CHANNEL_ERROR_CODES 穷尽断言保证。
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import {
  HTTP_CHANNEL_ERROR_CODES,
  HTTP_CHANNEL_FIXTURES,
  type P3394HttpChannelFixtureRequest,
} from './fixtures/http-channel-fixtures';

let counter = 0;
const openServers: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 47_100 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function send(port: number, request: P3394HttpChannelFixtureRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (request.token !== undefined) headers.Authorization = 'Bearer ' + request.token;
    const body = request.rawBody !== undefined
      ? request.rawBody
      : request.method === 'POST' ? JSON.stringify({ envelope: request.envelope }) : undefined;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: request.path,
      method: request.method,
      headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (body === undefined) req.end();
    else req.end(body);
  });
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close().catch(() => {});
});

describe('P3394 HTTP channel fixtures (Conformance Matrix V-02)', () => {
  it.each(HTTP_CHANNEL_FIXTURES.map((fixture) => [fixture.id, fixture.name, fixture] as const))(
    '%s: %s',
    async (_id, _name, fixture) => {
      const port = nextPort();
      const server = new P3394HttpChannel('fixture-http', {
        listen: { port },
        authToken: 'tok',
        ...(fixture.channelOptions ?? {}),
      });
      server.setLocalManifest(manifest('cogseed-agent'));
      openServers.push(server);
      await server.listen();

      for (let i = 0; i < (fixture.warmups ?? 0); i += 1) {
        await send(port, fixture.request);
      }
      const result = await send(port, fixture.request);
      expect(result.status).toBe(fixture.expected.status);
      if (fixture.expected.error) {
        expect(result.body.error).toBe(fixture.expected.error);
      }
    },
  );

  it('覆盖 HTTP_CHANNEL_ERROR_CODES 中的每个拒绝错误码', () => {
    const covered = new Set<string>();
    for (const fixture of HTTP_CHANNEL_FIXTURES) {
      if (fixture.expected.error) covered.add(fixture.expected.error);
    }
    for (const code of HTTP_CHANNEL_ERROR_CODES) {
      expect(covered.has(code), `no fixture for error code ${code}`).toBe(true);
    }
  });

  it('每条 fixture 标注已知矩阵 ID 且 id 唯一', () => {
    const known = new Set(['M-01', 'M-02', 'M-05', 'C-04', 'S-03', 'S-06']);
    const ids = HTTP_CHANNEL_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of HTTP_CHANNEL_FIXTURES) {
      expect(fixture.matrix.length).toBeGreaterThan(0);
      for (const tag of fixture.matrix) expect(known.has(tag), `${fixture.id} tags ${tag}`).toBe(true);
    }
  });
});
