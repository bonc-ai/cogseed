import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { P3394PeerRegistry } from '../../../../src/main/features/p3394_bridge/registry';
import { listExternalGateways, p3394ExternalGatewayIdFor, startExternalGateway, stopExternalGateway } from '../../../../src/main/features/p3394_bridge/external-gateways';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';
import * as fs from 'node:fs';

describe('P3394 external-agent gateway host', () => {
  it('maps every supported CLI to a gateway preset node id', () => {
    expect(p3394ExternalGatewayIdFor('claude')).toBe('claude');
    expect(p3394ExternalGatewayIdFor('codex')).toBe('codex');
    expect(p3394ExternalGatewayIdFor('hermes')).toBe('hermes');
    expect(p3394ExternalGatewayIdFor('openclaw')).toBe('openclaw');
    expect(p3394ExternalGatewayIdFor('workbuddy')).toBe('workbuddy');
    expect(p3394ExternalGatewayIdFor('nonsense')).toBeNull();
  });

  it('starts a real managed gateway that self-registers into the bridge registry', async () => {
    // Fake CogSeed bridge：收 hello → 把节点写进注册表（与 app-wiring 同构）。
    const token = 'ext-test-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('ext-test-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    channel.subscribe((envelope) => {
      try {
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions && Array.isArray(envelope.extensions.endpoints) ? envelope.extensions.endpoints : []).filter((v): v is string => typeof v === 'string');
      const existing = registry.resolve(senderId);
      if (existing.ok === false) {
        const reg = registry.register({
          identity: { agent_id: senderId, display_name: senderId },
          manifest: {
            spec_version: 'p3394/1.0',
            identity: { agent_id: senderId, display_name: senderId },
            runtime: { kind: 'in_process' },
            capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false },
            channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }],
            session: { scope: 'per-conversation', requires_session_id: true },
            security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true },
            conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true },
          } as never,
          ...(endpoints.length ? { endpoints } : {}),
        });
        if (reg.ok === false) throw new Error('test registry register failed: ' + JSON.stringify(reg.error));
      }
      } catch (e) { throw e; }
    });
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    try {
      const started = await startExternalGateway({
        cli: 'hermes',
        binPath: '/bin/echo',
        alias: '测试 Hermes',
        bridgeInfo: { endpoint: 'http://127.0.0.1:' + port, token },
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      expect(started.value.agent_id).toBe('hermes');
      expect(started.value.running).toBe(true);
      expect(started.value.port).toBeGreaterThan(0);
      // 注册表已写入节点 + endpoint
      const resolved = registry.resolve('hermes');
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.value.endpoints?.length).toBeGreaterThan(0);
      // 列表 + 停止
      const listed = listExternalGateways().filter((g) => g.cli === 'hermes');
      expect(listed.length).toBe(1);
      expect(listed[0].alias).toBe('测试 Hermes');
      await stopExternalGateway('hermes');
      expect(listExternalGateways().filter((g) => g.cli === 'hermes')).toHaveLength(0);
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
    }
  }, 60_000);
});
