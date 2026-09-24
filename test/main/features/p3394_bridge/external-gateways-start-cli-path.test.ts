// E-02（真机修复总结）：首次启动托管网关必须用**发现到的绝对路径**，不能把预设
// id 当命令名裸 spawn。
//
// 真机现象（修复总结-codex-workbuddy通道）：外接 WorkBuddy 后每轮都失败，报
// `[p3394_gateway_error] spawn workbuddy ENOENT workbuddy`。
//
// 代码根因不在恢复路径（MA-09 已修）而在**首次启动**：doStartExternalGateway 的
// env/记录回退是 `input.binPath || mapping.id`，而 mapping.id 是节点标识（'workbuddy'）
// 而非命令名 —— WorkBuddy 的 CLI 是应用内置的 codebuddy（不在 PATH，映射见
// local_agents/registry 的 BIN_NAMES）。渲染层三个入口（onboarding「外接」、
// run-center-settings 启动按钮、agents 创建向导未发现路径时）都不传 binPath，
// 于是网关**注册成功**、每轮才 ENOENT —— 失败点被推迟到用户发消息之后，且原因
// 不可执行。启动时先发现绝对路径；发现不到就明确失败，绝不裸 spawn。
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const detectOneMock = vi.hoisted(() => ({ impl: async (_cli: string) => null as null | { type: string; path?: string | null } }));
vi.mock('../../../../src/main/features/local_agents/registry', () => ({
  detectOne: (cli: string) => detectOneMock.impl(cli),
}));

import { listExternalGateways, startExternalGateway, stopExternalGateway } from '../../../../src/main/features/p3394_bridge/external-gateways';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { P3394PeerRegistry } from '../../../../src/main/features/p3394_bridge/registry';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';

const CODEBUDDY = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';

let previousVariant: string | undefined;
let variantName: string;

beforeEach(() => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  variantName = 'p3394-start-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_RUNTIME_VARIANT = variantName;
});
afterEach(() => {
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true }); } catch { /* best effort */ }
});

async function startFakeBridge() {
  const token = 'start-cli-token';
  const registryFile = p3394StateFile('p3394-peers.json');
  const gatewayStateFile = p3394StateFile('p3394-external-gateways.json');
  try { fs.rmSync(registryFile, { force: true }); fs.rmSync(gatewayStateFile, { force: true }); } catch { /* isolation */ }
  const registry = new P3394PeerRegistry({ filePath: registryFile });
  const channel = new P3394HttpChannel('start-cli-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
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

describe('first-start gateway CLI path resolution (E-02)', () => {
  it('discovers the absolute CLI path when the caller passes no binPath', async () => {
    const bridge = await startFakeBridge();
    const asked: string[] = [];
    detectOneMock.impl = async (cli: string) => { asked.push(cli); return { type: 'workbuddy', path: CODEBUDDY }; };
    try {
      // 渲染层「外接」/run-center 启动按钮的真实调用形态：只有 cli。
      const result = await startExternalGateway({ cli: 'workbuddy', bridgeInfo: bridge.bridgeInfo });
      expect(result.ok).toBe(true);
      expect(asked).toContain('workbuddy');
      // 记录里的 bin 必须是发现到的绝对路径：它同时是 P3394_AGENT_CLI 的来源，
      // 裸 'workbuddy' 会让网关每轮 spawn ENOENT。
      const record = listExternalGateways().find((g) => g.cli === 'workbuddy');
      expect(record?.bin).toBe(CODEBUDDY);
    } finally {
      await stopExternalGateway('workbuddy');
      await bridge.close();
    }
  }, 60_000);

  it('fails explicitly instead of registering a gateway that cannot spawn its CLI', async () => {
    const bridge = await startFakeBridge();
    detectOneMock.impl = async () => null;
    try {
      const result = await startExternalGateway({ cli: 'workbuddy', bridgeInfo: bridge.bridgeInfo });
      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error : '').toBe('p3394_cli_not_found: workbuddy');
      // 绝不裸 spawn：没有留下「注册成功但每轮 ENOENT」的半成品网关。
      expect(listExternalGateways().some((g) => g.cli === 'workbuddy' && g.running)).toBe(false);
    } finally {
      await bridge.close();
    }
  }, 60_000);

  it('uses an explicit binPath without re-discovery', async () => {
    const bridge = await startFakeBridge();
    let detectCalls = 0;
    detectOneMock.impl = async () => { detectCalls += 1; return { type: 'hermes', path: '/should/not/be/used' }; };
    try {
      const result = await startExternalGateway({ cli: 'hermes', binPath: '/opt/hermes/bin/hermes', bridgeInfo: bridge.bridgeInfo });
      expect(result.ok).toBe(true);
      expect(detectCalls).toBe(0);
      expect(listExternalGateways().find((g) => g.cli === 'hermes')?.bin).toBe('/opt/hermes/bin/hermes');
    } finally {
      await stopExternalGateway('hermes');
      await bridge.close();
    }
  }, 60_000);
});
