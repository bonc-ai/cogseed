import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  listRemoteNodes, addRemoteNode, removeRemoteNode, testRemoteNode,
} from '../../../../src/main/features/p3394_bridge/remote-nodes';

// 状态文件按 runtime variant 隔离，用临时 variant 防止污染真实配置
const VARIANT = `test-remote-nodes-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
process.env.COGSEED_RUNTIME_VARIANT = VARIANT;

function cleanupState(): void {
  const dir = path.join(os.homedir(), '.cogseed', 'runtime-variants', VARIANT);
  fs.rmSync(dir, { recursive: true, force: true });
}
afterAll(cleanupState);

describe('p3394 remote nodes store', () => {
  it('list 空 → add → 返回打码视图 → 重复端点拒绝 → remove', () => {
    expect(listRemoteNodes().nodes).toEqual([]);
    const added = addRemoteNode({ label: '老王的 Hermes', endpoint: '192.168.1.20:8444', token: 'tok-abcdef1234' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    // 无 scheme 自动补 http://，token 打码
    expect(added.node.endpoint).toBe('http://192.168.1.20:8444');
    expect(added.node.tokenPreview).not.toContain('abcdef');
    expect(listRemoteNodes().nodes).toHaveLength(1);
    // 同端点重复
    const dup = addRemoteNode({ label: 'dup', endpoint: 'http://192.168.1.20:8444', token: 'x' });
    expect(dup).toMatchObject({ ok: false, error: { reason: 'duplicate_endpoint' } });
    // 非法输入
    expect(addRemoteNode({ endpoint: 'not a url', token: 'x' })).toMatchObject({ ok: false, error: { reason: 'invalid_endpoint' } });
    expect(addRemoteNode({ endpoint: 'http://a', token: '' })).toMatchObject({ ok: false, error: { reason: 'invalid_token' } });
    // 删除
    expect(removeRemoteNode(added.node.id).ok).toBe(true);
    expect(removeRemoteNode(added.node.id)).toMatchObject({ ok: false, error: { reason: 'not_found' } });
    expect(listRemoteNodes().nodes).toHaveLength(0);
    // 移除返回被删节点的期望身份：IPC 层据此撤销花名册注册（联动）
    const withIdentity = addRemoteNode({ label: 'n2', endpoint: 'http://10.0.0.2:8444', token: 'tok2', expected_identity: 'peer-2' });
    expect(withIdentity.ok).toBe(true);
    if (withIdentity.ok) {
      expect(removeRemoteNode(withIdentity.node.id)).toMatchObject({ ok: true, expected_identity: 'peer-2' });
    }
  });
});

describe('p3394 remote node connectivity test', () => {
  let unreachablePort = 1;
  let authServer: http.Server;
  let manifestServer: http.Server;
  let authPort = 0;
  let manifestPort = 0;

  beforeAll(async () => {
    authServer = http.createServer((_req, res) => { res.statusCode = 401; res.end('{}'); });
    manifestServer = http.createServer((req, res) => {
      if (req.url?.includes('/p3394/manifest')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, manifest: { identity: { agent_id: 'hermes-remote-1' } } }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
    await Promise.all([
      new Promise<void>((r) => authServer.listen(0, '127.0.0.1', r)),
      new Promise<void>((r) => manifestServer.listen(0, '127.0.0.1', r)),
    ]);
    authPort = (authServer.address() as { port: number }).port;
    manifestPort = (manifestServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    await Promise.all([authServer, manifestServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it('地址不通 → unreachable', async () => {
    const r = await testRemoteNode({ endpoint: `http://127.0.0.1:${unreachablePort}`, token: 't' });
    expect(r).toMatchObject({ ok: false, error: { reason: 'unreachable' } });
  });
  it('令牌不对（401）→ auth', async () => {
    const r = await testRemoteNode({ endpoint: `http://127.0.0.1:${authPort}`, token: 'bad' });
    expect(r).toMatchObject({ ok: false, error: { reason: 'auth' } });
  });
  it('manifest 正常但身份不符 → identity_mismatch', async () => {
    const r = await testRemoteNode({
      endpoint: `http://127.0.0.1:${manifestPort}`, token: 't', expected_identity: 'someone-else',
    });
    expect(r).toMatchObject({ ok: false, error: { reason: 'identity_mismatch' } });
  });
  it('manifest 且身份匹配 → ok 并带回对端 agent_id', async () => {
    const r = await testRemoteNode({
      endpoint: `http://127.0.0.1:${manifestPort}`, token: 't', expected_identity: 'hermes-remote-1',
    });
    expect(r).toMatchObject({ ok: true, peer_agent_id: 'hermes-remote-1' });
  });
});
