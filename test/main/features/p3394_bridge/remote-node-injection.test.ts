import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { P3394PeerRegistry } from '../../../../src/main/features/p3394_bridge/registry';
import { addRemoteNode, removeRemoteNode } from '../../../../src/main/features/p3394_bridge/remote-nodes';
import {
  P3394_REMOTE_NODE_TRUST_POLICY,
  p3394LocalityForEndpoint,
  resolveP3394PeerByPolicy,
  syncP3394RemoteNodesToRegistry,
} from '../../../../src/main/features/p3394_bridge/remote-node-injection';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';

// remote-nodes 存储按 runtime variant 隔离，一次性 variant 防污染。
let previousVariant: string | undefined;
let variantName: string;
beforeEach(() => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  variantName = 'p3394-inject-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_RUNTIME_VARIANT = variantName;
});
afterEach(() => {
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true }); } catch { /* best effort */ }
});

function manifestOf(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (result.ok === false) throw new Error(result.error.message);
  return result.manifest;
}

describe('remote-nodes → PeerRegistry 注入（§7.2 跨机出站断点）', () => {
  it('injects enabled nodes with endpoints/dial_token/expected_identity and external locality', () => {
    addRemoteNode({ label: '老王的 Hermes', endpoint: 'https://192.0.2.20:8444', token: 'tok-remote-1', expected_identity: 'hermes-remote' });
    const registry = new P3394PeerRegistry();
    const result = syncP3394RemoteNodesToRegistry(registry);
    expect(result.registered).toEqual(['hermes-remote']);
    // 注入后可被 resolve 命中（p3394_send 的第一步）。
    const resolved = registry.resolve('hermes-remote');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.endpoints).toEqual(['https://192.0.2.20:8444']);
      expect(resolved.value.dial_token).toBe('tok-remote-1');
      expect(resolved.value.expected_identity).toBe('hermes-remote');
      expect(resolved.value.locality).toBe('external');
      expect(resolved.value.trust_policy).toBe(P3394_REMOTE_NODE_TRUST_POLICY);
    }
    // 能力查询（本地声明后）同样命中注入节点。
    const byCap = registry.findByCapability('hermes-remote');
    expect(byCap.ok).toBe(true);
  });

  it('skips nodes without expected_identity and disabled nodes; reconciles removal with revoke', () => {
    const noIdentity = addRemoteNode({ label: 'no-id', endpoint: 'http://192.0.2.31:8444', token: 't1' });
    const disabled = addRemoteNode({ label: 'off', endpoint: 'http://192.0.2.32:8444', token: 't2', expected_identity: 'off-peer' });
    expect(noIdentity.ok && disabled.ok).toBe(true);
    // 存储格式直改 enabled=false（update 无 enabled 入口）——只禁用 off-peer，
    // no-id 保持 enabled（验证"无 expected_identity 且 enabled"才计 skipped）。
    const storeFile = path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName, 'p3394-remote-nodes.json');
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { nodes: Record<string, { id: string; enabled: boolean }> };
    if (disabled.ok) stored.nodes[disabled.node.id].enabled = false;
    fs.writeFileSync(storeFile, JSON.stringify(stored));

    const registry = new P3394PeerRegistry();
    const result = syncP3394RemoteNodesToRegistry(registry);
    // 无 expected_identity（enabled）→ skipped；disabled（有 identity）→ 直接忽略。
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual(['http://192.0.2.31:8444']);
    expect(registry.resolve('off-peer').ok).toBe(false);

    // enabled + expected_identity 的节点：注入 → 移除 → revoke（对账）。
    const good = addRemoteNode({ label: 'good', endpoint: 'http://192.0.2.33:8444', token: 't3', expected_identity: 'good-peer' });
    expect(good.ok).toBe(true);
    const first = syncP3394RemoteNodesToRegistry(registry);
    expect(first.registered).toEqual(['good-peer']);
    if (good.ok) removeRemoteNode(good.node.id);
    const second = syncP3394RemoteNodesToRegistry(registry);
    expect(second.revoked).toEqual(['good-peer']);
    expect(registry.resolve('good-peer').ok).toBe(false);
  });

  it('updates an existing same-identity peer instead of duplicating (hello-registered first)', () => {
    const registry = new P3394PeerRegistry();
    // hello 先自注册了同名节点（带能力声明）。
    registry.register({
      identity: { agent_id: 'hermes-remote', display_name: 'Hermes' },
      manifest: manifestOf('hermes-remote'),
      endpoints: ['http://127.0.0.1:9000'],
      capabilities: ['handle_message'],
      locality: 'same_host',
      trust_policy: 'p3394-bearer',
    });
    addRemoteNode({ label: '远端 Hermes', endpoint: 'https://192.0.2.20:8444', token: 'tok-remote-2', expected_identity: 'hermes-remote' });
    const result = syncP3394RemoteNodesToRegistry(registry);
    expect(result.updated).toEqual(['hermes-remote']);
    expect(result.registered).toEqual([]);
    const peer = registry.resolve('hermes-remote');
    expect(peer.ok).toBe(true);
    if (peer.ok) {
      // 连接字段更新为 remote-node 端点，能力声明保留。
      expect(peer.value.endpoints).toEqual(['https://192.0.2.20:8444']);
      expect(peer.value.dial_token).toBe('tok-remote-2');
      expect(peer.value.locality).toBe('external');
      expect(peer.value.capabilities).toEqual(['handle_message']);
    }
    // hello 自注册的其他节点（trust_policy 非 remote-node 标记）不受对账 revoke 影响。
    registry.register({
      identity: { agent_id: 'local-cli', display_name: 'Local CLI' },
      manifest: manifestOf('local-cli'),
      endpoints: ['http://127.0.0.1:9001'],
      locality: 'same_host',
      trust_policy: 'p3394-bearer',
    });
    const after = syncP3394RemoteNodesToRegistry(registry);
    expect(after.revoked).not.toContain('local-cli');
    expect(registry.resolve('local-cli').ok).toBe(true);
  });

  it('locality: loopback endpoints map to same_host, cross-machine to external', () => {
    expect(p3394LocalityForEndpoint('http://127.0.0.1:8444')).toBe('same_host');
    expect(p3394LocalityForEndpoint('http://localhost:8444')).toBe('same_host');
    expect(p3394LocalityForEndpoint('https://192.0.2.20:8444')).toBe('external');
  });
});

describe('§16-13 capability routing policy gate', () => {
  function registryWith(remoteOnlyCapability: string): P3394PeerRegistry {
    const registry = new P3394PeerRegistry();
    registry.register({
      identity: { agent_id: 'local-worker', display_name: 'Local Worker' },
      manifest: manifestOf('local-worker'),
      endpoints: ['http://127.0.0.1:9100'],
      capabilities: ['handle_message'],
      locality: 'same_host',
    });
    registry.register({
      identity: { agent_id: 'cloud-worker', display_name: 'Cloud Worker' },
      manifest: manifestOf('cloud-worker'),
      endpoints: ['https://192.0.2.20:8444'],
      capabilities: [remoteOnlyCapability],
      locality: 'external',
    });
    return registry;
  }

  it('default (closed): a capability only available remotely errors explicitly — no silent outbound call', () => {
    const registry = registryWith('code-review');
    // 直接 agent_id / 别名解析不受影响。
    expect(resolveP3394PeerByPolicy(registry, 'cloud-worker')).toMatchObject({ ok: true, agent_id: 'cloud-worker' });
    // 本地能力照常命中。
    expect(resolveP3394PeerByPolicy(registry, 'handle_message')).toMatchObject({ ok: true, agent_id: 'local-worker' });
    // 远端独有能力：明确报错，不静默外呼（§16-13 反模式）。
    expect(resolveP3394PeerByPolicy(registry, 'code-review')).toEqual({ ok: false, error: 'p3394_capability_not_available_locally' });
    // 完全不存在：原有错误码。
    expect(resolveP3394PeerByPolicy(registry, 'no-such-capability')).toEqual({ ok: false, error: 'p3394_peer_not_registered' });
  });

  it('open (COGSEED_P3394_ALLOW_REMOTE_CAPABILITY=1): remote peers become eligible', () => {
    const registry = registryWith('code-review');
    expect(resolveP3394PeerByPolicy(registry, 'code-review', { allowRemoteCapability: true }))
      .toMatchObject({ ok: true, agent_id: 'cloud-worker' });
    // 本地能力仍优先（preferLocal 排序语义保留在 registry 层，此处直查）。
    expect(resolveP3394PeerByPolicy(registry, 'handle_message', { allowRemoteCapability: true }))
      .toMatchObject({ ok: true, agent_id: 'local-worker' });
  });

  it('locality-undeclared legacy peers count as local (backward compatible)', () => {
    const registry = new P3394PeerRegistry();
    registry.register({
      identity: { agent_id: 'legacy-peer', display_name: 'Legacy' },
      manifest: manifestOf('legacy-peer'),
      endpoints: ['http://127.0.0.1:9101'],
      capabilities: ['legacy-cap'],
      // locality 未声明（老记录）。
    });
    expect(resolveP3394PeerByPolicy(registry, 'legacy-cap')).toMatchObject({ ok: true, agent_id: 'legacy-peer' });
  });
});

describe('GET /p3394/peers discovery endpoint over an injected registry', () => {
  it('exposes injected peers through the read-only endpoint with bearer auth', async () => {
    addRemoteNode({ label: '老王的 Hermes', endpoint: 'https://192.0.2.20:8444', token: 'tok-disc', expected_identity: 'hermes-remote' });
    const registry = new P3394PeerRegistry();
    syncP3394RemoteNodesToRegistry(registry);

    const server = new P3394HttpChannel('discovery', {
      listen: { port: 0 },
      authToken: 'disc-token',
      peersSummary: () => registry.list().map((peer) => ({
        agent_id: peer.identity.agent_id,
        node_kind: peer.node_kind ?? 'agent',
        online: false,
        capabilities: [...(peer.capabilities ?? [])],
      })),
    });
    await server.listen();
    // port:0 绑定 → 从内部 listener 拿实际端口（测试专用访问）。
    const address = (server as unknown as { server: http.Server }).server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const fetchPeers = (token: string | null) => new Promise<{ status: number; body: string }>((resolve) => {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      const req = http.request({ host: '127.0.0.1', port, path: '/p3394/peers', method: 'GET', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.end();
    });

    expect((await fetchPeers(null)).status).toBe(401);
    const ok = await fetchPeers('disc-token');
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as { ok: boolean; peers: Array<{ agent_id: string; capabilities: string[] }> };
    expect(body.ok).toBe(true);
    expect(body.peers.some((peer) => peer.agent_id === 'hermes-remote')).toBe(true);
    await server.close();
  });
});
