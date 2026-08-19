/**
 * C-04：HTTP listener 认证失败审计——401 路径写 http.auth.reject 审计，
 * 成功路径不产生审计记录；health 探活豁免。
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';

let counter = 0;
const openServers: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 46_100 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function request(port: number, path: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close().catch(() => {});
});

describe('P3394HttpChannel auth failure audit (C-04)', () => {
  it('audits 401 auth failures with path and stays silent on success', async () => {
    const port = nextPort();
    const audit = vi.fn();
    const server = new P3394HttpChannel('audit-server', {
      listen: { port },
      authToken: 'tok',
      audit,
    });
    server.setLocalManifest(manifest('cogseed-agent'));
    openServers.push(server);
    await server.listen();

    // 错误 token：401 + 审计。
    expect(await request(port, '/p3394/manifest', 'wrong')).toBe(401);
    expect(await request(port, '/p3394/objects/' + 'a'.repeat(64))).toBe(401);
    // 正确 token：200，无新增审计。
    expect(await request(port, '/p3394/manifest', 'tok')).toBe(200);
    // health 探活豁免：无 token 也 200，且不审计。
    expect(await request(port, '/p3394/health')).toBe(200);

    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0][0]).toMatchObject({ event: 'http.auth.reject', status: 'rejected', metadata: { path: '/p3394/manifest' } });
    expect(audit.mock.calls[1][0]).toMatchObject({ event: 'http.auth.reject', status: 'rejected' });
  });
});
