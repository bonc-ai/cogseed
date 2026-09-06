import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  listRemoteNodes, addRemoteNode, removeRemoteNode, testRemoteNode,
  listRemoteNodesInternal, updateRemoteNode,
} from '../../../../src/main/features/p3394_bridge/remote-nodes';

// 状态文件按 runtime variant 隔离，用临时 variant 防止污染真实配置
const VARIANT = `test-remote-nodes-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
process.env.COGSEED_RUNTIME_VARIANT = VARIANT;

function stateFile(): string {
  return path.join(os.homedir(), '.cogseed', 'runtime-variants', VARIANT, 'p3394-remote-nodes.json');
}

function cleanupState(): void {
  const dir = path.join(os.homedir(), '.cogseed', 'runtime-variants', VARIANT);
  fs.rmSync(dir, { recursive: true, force: true });
}
afterAll(cleanupState);

describe('p3394 remote nodes store', () => {
  it('list 空 → add → 返回打码视图 → 重复端点拒绝 → remove', () => {
    expect(listRemoteNodes().nodes).toEqual([]);
    const added = addRemoteNode({ label: '老王的 Hermes', endpoint: '192.0.2.20:8444', token: 'tok-abcdef1234' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    // 无 scheme 自动补 http://，token 打码
    expect(added.node.endpoint).toBe('http://192.0.2.20:8444');
    expect(added.node.tokenPreview).not.toContain('abcdef');
    expect(listRemoteNodes().nodes).toHaveLength(1);
    // 同端点重复
    const dup = addRemoteNode({ label: 'dup', endpoint: 'http://192.0.2.20:8444', token: 'x' });
    expect(dup).toMatchObject({ ok: false, error: { reason: 'duplicate_endpoint' } });
    // 非法输入
    expect(addRemoteNode({ endpoint: 'not a url', token: 'x' })).toMatchObject({ ok: false, error: { reason: 'invalid_endpoint' } });
    expect(addRemoteNode({ endpoint: 'http://a', token: '' })).toMatchObject({ ok: false, error: { reason: 'invalid_token' } });
    // 删除
    expect(removeRemoteNode(added.node.id).ok).toBe(true);
    expect(removeRemoteNode(added.node.id)).toMatchObject({ ok: false, error: { reason: 'not_found' } });
    expect(listRemoteNodes().nodes).toHaveLength(0);
    // 移除返回被删节点的期望身份：IPC 层据此撤销花名册注册（联动）
    const withIdentity = addRemoteNode({ label: 'n2', endpoint: 'http://192.0.2.2:8444', token: 'tok2', expected_identity: 'peer-2' });
    expect(withIdentity.ok).toBe(true);
    if (withIdentity.ok) {
      expect(removeRemoteNode(withIdentity.node.id)).toMatchObject({ ok: true, expected_identity: 'peer-2' });
    }
  });

  it('状态文件以 0600 落盘（明文 token 不泄给同机其他用户）', () => {
    const added = addRemoteNode({ label: 'secret-holder', endpoint: 'http://192.0.2.30:8444', token: 'tok-secret-1234' });
    expect(added.ok).toBe(true);
    expect(fs.existsSync(stateFile())).toBe(true);
    const mode = fs.statSync(stateFile()).mode & 0o777;
    expect(mode).toBe(0o600);
    // 文件内容不含 .tmp 半成品（原子写）。
    expect(fs.existsSync(stateFile() + '.tmp')).toBe(false);
    if (added.ok) removeRemoteNode(added.node.id);
  });

  it('tls 材料：add 带路径 → 内部明文读取可见 → update 可清除', () => {
    const added = addRemoteNode({
      label: 'tls-node',
      endpoint: 'https://192.0.2.40:8444',
      token: 'tok-tls',
      expected_identity: 'peer-tls',
      tls: { ca: '/etc/p3394/ca.pem', cert: '/etc/p3394/client.pem', key: '/etc/p3394/client.key' },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const internal = listRemoteNodesInternal().find((node) => node.id === added.node.id);
    expect(internal?.tls).toEqual({ ca: '/etc/p3394/ca.pem', cert: '/etc/p3394/client.pem', key: '/etc/p3394/client.key' });
    // 渲染视图不回显 tls 材料。
    expect(listRemoteNodes().nodes.find((node) => node.id === added.node.id && 'tls' in node)).toBeUndefined();
    // 未传 tls 的 update 保留；传空对象清除。
    updateRemoteNode(added.node.id, { label: 'tls-node-2' });
    expect(listRemoteNodesInternal().find((node) => node.id === added.node.id)?.tls).toBeDefined();
    updateRemoteNode(added.node.id, { tls: {} });
    expect(listRemoteNodesInternal().find((node) => node.id === added.node.id)?.tls).toBeUndefined();
    removeRemoteNode(added.node.id);
  });

  it('update: 改 label/身份不动 token；改 endpoint 去重校验', async () => {
    const a = addRemoteNode({ label: '节点A', endpoint: 'http://192.0.2.9:8444', token: 'tok-a', expected_identity: 'peer-a' });
    const b = addRemoteNode({ label: '节点B', endpoint: 'http://192.0.2.8:8444', token: 'tok-b', expected_identity: 'peer-b' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // 改 label：其余不动（token 保留——视图层只能看到打码）
    const renamed = updateRemoteNode(a.node.id, { label: '新名字' });
    expect(renamed).toMatchObject({ ok: true });
    if (renamed.ok) expect(renamed.node.label).toBe('新名字');
    const afterRename = listRemoteNodes().nodes.find((n) => n.id === a.node.id);
    expect(afterRename?.tokenPreview).toBe(a.node.tokenPreview);
    // 改 endpoint 撞已有节点 → duplicate_endpoint 拒绝
    const dup = updateRemoteNode(a.node.id, { endpoint: 'http://192.0.2.8:8444' });
    expect(dup).toMatchObject({ ok: false, error: { reason: 'duplicate_endpoint' } });
    // 改 endpoint + 换 token：成功且 token 更新
    const moved = updateRemoteNode(a.node.id, { endpoint: 'http://192.0.2.7:8444', token: 'tok-new' });
    expect(moved).toMatchObject({ ok: true });
    const afterMove = listRemoteNodes().nodes.find((n) => n.id === a.node.id);
    expect(afterMove?.endpoint).toBe('http://192.0.2.7:8444');
    expect(afterMove?.tokenPreview).not.toBe(a.node.tokenPreview);
    // 不存在的 id
    expect(updateRemoteNode('nope', { label: 'x' })).toMatchObject({ ok: false, error: { reason: 'not_found' } });
    removeRemoteNode(a.node.id); removeRemoteNode(b.node.id);
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
