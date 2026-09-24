// MA-09（验收报告 P1）：托管网关恢复必须用**发现到的绝对路径**，不能回退裸命令。
//
// 真机现象：通过 P3394 调用 WorkBuddy 报 `[p3394_gateway_error] spawn workbuddy
// ENOENT workbuddy`。WorkBuddy 的 CLI 是应用内置的 codebuddy（不在 PATH 中，映射见
// local_agents/registry 的 BIN_NAMES），而旧记录里 `bin` 等于 `cli`（当初启动时
// 没发现到绝对路径）时，恢复路径会丢掉路径信息、让网关按裸标识 spawn —— 在 GUI
// 启动的 app 里必然 ENOENT，也不能静默降级成部分执行。
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const detectOneMock = vi.hoisted(() => ({ impl: async (_cli: string) => null as null | { type: string; path?: string } }));
vi.mock('../../../../src/main/features/local_agents/registry', () => ({
  detectOne: (cli: string) => detectOneMock.impl(cli),
}));

import { listExternalGateways, respawnManagedGateways, stopExternalGateway } from '../../../../src/main/features/p3394_bridge/external-gateways';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { P3394PeerRegistry } from '../../../../src/main/features/p3394_bridge/registry';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';

const CODEBUDDY = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';

let previousVariant: string | undefined;
let variantName: string;

beforeEach(() => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  variantName = 'p3394-respawn-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_RUNTIME_VARIANT = variantName;
});
afterEach(() => {
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true }); } catch { /* best effort */ }
});

async function startFakeBridge() {
  const token = 'respawn-cli-token';
  const registryFile = p3394StateFile('p3394-peers.json');
  const gatewayStateFile = p3394StateFile('p3394-external-gateways.json');
  try { fs.rmSync(registryFile, { force: true }); fs.rmSync(gatewayStateFile, { force: true }); } catch { /* isolation */ }
  const registry = new P3394PeerRegistry({ filePath: registryFile });
  const channel = new P3394HttpChannel('respawn-cli-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
  await channel.listen();
  channel.subscribe((envelope) => {
    const senderId = envelope.sender.agent_id;
    const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
    if (registry.resolve(senderId).ok === false) {
      registry.register({
        identity: { agent_id: senderId, display_name: senderId },
        manifest: {
          spec_version: 'p3394/1.0',
          identity: { agent_id: senderId, display_name: senderId },
          runtime: { kind: 'in_process' },
          capability_profile: {
            agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'],
            supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false,
          },
          channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }],
          session: { scope: 'per-conversation', requires_session_id: true },
          security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true },
          conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true },
        } as never,
        ...(endpoints.length ? { endpoints } : {}),
      });
    }
  });
  const port = ((channel as unknown as { server: http.Server }).server.address() as { port: number }).port;
  return {
    bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token },
    close: async () => {
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); fs.rmSync(gatewayStateFile, { force: true }); } catch { /* best effort */ }
    },
  };
}

function writeLegacyRecord(cli: string, bin: string, alias: string) {
  const gatewayStateFile = p3394StateFile('p3394-external-gateways.json');
  fs.mkdirSync(path.dirname(gatewayStateFile), { recursive: true });
  fs.writeFileSync(gatewayStateFile, JSON.stringify({
    schema_version: 1,
    gateways: [{ cli, agent_id: cli, alias, bin, port: 59999, pid: 1, started_at: new Date().toISOString() }],
  }));
}

describe('managed gateway respawn CLI path resolution (MA-09)', () => {
  it('rediscovers the absolute CLI path when the stored record only has the bare identifier', async () => {
    const bridge = await startFakeBridge();
    detectOneMock.impl = async () => ({ type: 'workbuddy', path: CODEBUDDY });
    try {
      writeLegacyRecord('workbuddy', 'workbuddy', 'WorkBuddy');
      const outcome = await respawnManagedGateways({ bridgeInfo: bridge.bridgeInfo });
      expect(outcome.failed).toEqual([]);
      expect(outcome.restarted).toContain('workbuddy');
      const record = listExternalGateways().find((g) => g.cli === 'workbuddy');
      // 记录里的 bin 必须是发现到的绝对路径（网关按 P3394_AGENT_CLI 使用它）。
      expect(record?.bin).toBe(CODEBUDDY);
    } finally {
      await stopExternalGateway('workbuddy');
      await bridge.close();
    }
  }, 60_000);

  it('fails explicitly instead of spawning the bare command when the CLI cannot be discovered', async () => {
    const bridge = await startFakeBridge();
    detectOneMock.impl = async () => null;
    try {
      writeLegacyRecord('workbuddy', 'workbuddy', 'WorkBuddy');
      const outcome = await respawnManagedGateways({ bridgeInfo: bridge.bridgeInfo });
      expect(outcome.restarted).toEqual([]);
      expect(outcome.failed).toEqual([{ cli: 'workbuddy', error: 'p3394_cli_not_found' }]);
      // 没有在跑任何 workbuddy 网关：绝不裸 spawn。
      expect(listExternalGateways().some((g) => g.cli === 'workbuddy' && g.running)).toBe(false);
    } finally {
      await bridge.close();
    }
  }, 60_000);

  it('keeps using a stored absolute path without re-discovery', async () => {
    const bridge = await startFakeBridge();
    let detectCalls = 0;
    detectOneMock.impl = async () => { detectCalls += 1; return { type: 'hermes', path: '/should/not/be/used' }; };
    try {
      writeLegacyRecord('hermes', '/opt/hermes/bin/hermes', 'Hermes');
      const outcome = await respawnManagedGateways({ bridgeInfo: bridge.bridgeInfo });
      expect(outcome.restarted).toContain('hermes');
      expect(detectCalls).toBe(0);
      expect(listExternalGateways().find((g) => g.cli === 'hermes')?.bin).toBe('/opt/hermes/bin/hermes');
    } finally {
      await stopExternalGateway('hermes');
      await bridge.close();
    }
  }, 60_000);
});
