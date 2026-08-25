import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { P3394PeerRegistry } from '../../../../src/main/features/p3394_bridge/registry';
import { listExternalGateways, p3394ExternalGatewayIdFor, respawnManagedGateways, runtimeModeForCli, startExternalGateway, stopExternalGateway } from '../../../../src/main/features/p3394_bridge/external-gateways';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';
import * as fs from 'node:fs';

let previousVariant: string | undefined;
let variantName: string;

// 测试隔离：p3394StateFile 走 COGSEED_RUNTIME_VARIANT，必须用一次性 variant，
// 否则这些测试会把真实 cogseed variant 的 p3394-peers.json /
// p3394-external-gateways.json 清空重建（污染用户运行状态）。
beforeEach(() => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  variantName = 'p3394-gw-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_RUNTIME_VARIANT = variantName;
});
afterEach(() => {
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('P3394 external-agent gateway host', () => {
  it('maps every supported CLI to a gateway preset node id', () => {
    expect(p3394ExternalGatewayIdFor('claude')).toBe('claude');
    expect(p3394ExternalGatewayIdFor('codex')).toBe('codex');
    expect(p3394ExternalGatewayIdFor('hermes')).toBe('hermes');
    expect(p3394ExternalGatewayIdFor('openclaw')).toBe('openclaw');
    expect(p3394ExternalGatewayIdFor('workbuddy')).toBe('workbuddy');
    expect(p3394ExternalGatewayIdFor('nonsense')).toBeNull();
  });

  it('executes a task through the managed gateway and returns a real response', async () => {
    const token = 'ext-task-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    try { fs.rmSync(registryFile, { force: true }); } catch { /* test isolation */ }
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('ext-task-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    const replies: unknown[] = [];
    let replyResolve: ((value: unknown) => void) | null = null;
    const reply = new Promise<unknown>((resolve) => { replyResolve = resolve; });
    channel.subscribe((envelope) => {
      if (envelope.sender.agent_id === 'hermes' && envelope.performative === 'inform') {
        // 过程帧（progress/delta，kind=event）先于终态到达，不算回复——
        // 等待条件只认终态信封，否则会把冷启动提示误当回复/错误回信。
        if (envelope.kind === 'event') return;
        replies.push(envelope);
        replyResolve?.(envelope);
        return;
      }
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
      if (registry.resolve(senderId).ok === false) {
        registry.register({
          identity: { agent_id: senderId, display_name: senderId },
          manifest: { spec_version: 'p3394/1.0', identity: { agent_id: senderId, display_name: senderId }, runtime: { kind: 'in_process' }, capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false }, channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }], session: { scope: 'per-conversation', requires_session_id: true }, security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true }, conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true } } as never,
          ...(endpoints.length ? { endpoints } : {}),
        });
      }
    });
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    try {
      await stopExternalGateway('hermes');
      const started = await startExternalGateway({ cli: 'hermes', binPath: '/bin/echo', alias: '任务 Hermes', bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
      expect(started.ok, 'start failed: ' + (started.ok === false ? started.error : '')).toBe(true);
      if (!started.ok) throw new Error(started.error);
      const dialer = new P3394HttpChannel('ext-task-dialer', { dial: { endpoints: [`http://127.0.0.1:${started.value.port}`] } });
      await dialer.dial('hermes');
      await dialer.send({
        spec_version: 'p3394/1.0', message_id: 'msg-ext-task-1', session_id: 'ses-ext-task-1', task_id: 'tsk-ext-task-1', kind: 'task', performative: 'request',
        sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'hello external gateway' }] },
        extensions: { reply_endpoint: `http://127.0.0.1:${port}`, reply_token: token }, idempotency_key: 'idem-ext-task-1',
      } as never);
      const response = await Promise.race([reply, new Promise((_, reject) => setTimeout(() => reject(new Error('external gateway reply timeout')), 10_000))]) as { payload: { parts: Array<{ type?: string; text?: string }> }; task_id?: string };
      expect(replies).toHaveLength(1);
      expect(response.task_id).toBe('tsk-ext-task-1');
      expect(response.payload.parts[0].type).toBe('text');
      expect(response.payload.parts[0].text).toContain('hello external gateway');
      await dialer.close();
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
    }
  }, 60_000);

  it('starts a real managed gateway that self-registers into the bridge registry', async () => {
    // Fake CogSeed bridge：收 hello → 把节点写进注册表（与 app-wiring 同构）。
    const token = 'ext-test-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    try { fs.rmSync(registryFile, { force: true }); } catch { /* test isolation */ }
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
      await stopExternalGateway('hermes');
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

  it('V-03：真实 CLI 执行失败 → gateway 显式错误回信 → CogSeed 感知失败（不静默）', async () => {    const token = 'ext-fail-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    try { fs.rmSync(registryFile, { force: true }); } catch { /* test isolation */ }
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('ext-fail-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    const replies: unknown[] = [];
    let replyResolve: ((value: unknown) => void) | null = null;
    const reply = new Promise<unknown>((resolve) => { replyResolve = resolve; });
    channel.subscribe((envelope) => {
      if (envelope.sender.agent_id === 'hermes' && envelope.performative === 'inform') {
        // 过程帧（progress/delta，kind=event）先于终态到达，不算回复——
        // 等待条件只认终态信封，否则会把冷启动提示误当回复/错误回信。
        if (envelope.kind === 'event') return;
        replies.push(envelope);
        replyResolve?.(envelope);
        return;
      }
      // hello 自注册：与 app-wiring 同构，让 gateway 完成注册等待。
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
      if (registry.resolve(senderId).ok === false) {
        registry.register({
          identity: { agent_id: senderId, display_name: senderId },
          manifest: { spec_version: 'p3394/1.0', identity: { agent_id: senderId, display_name: senderId }, runtime: { kind: 'in_process' }, capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false }, channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }], session: { scope: 'per-conversation', requires_session_id: true }, security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true }, conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true } } as never,
          ...(endpoints.length ? { endpoints } : {}),
        });
      }
    });
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    try {
      await stopExternalGateway('hermes');
      // 可执行脚本以非零码（3）退出——真实 CLI 执行失败路径（macOS 无 /bin/false）。
      const failingCli = path.join(os.tmpdir(), 'p3394-fail-cli-' + Date.now() + '.sh');
      fs.writeFileSync(failingCli, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
      const started = await startExternalGateway({ cli: 'hermes', binPath: failingCli, alias: '失败 Hermes', bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      const dialer = new P3394HttpChannel('ext-fail-dialer', { dial: { endpoints: [`http://127.0.0.1:${started.value.port}`] } });
      await dialer.dial('hermes');
      await dialer.send({
        spec_version: 'p3394/1.0', message_id: 'msg-ext-fail-1', session_id: 'ses-ext-fail-1', task_id: 'tsk-ext-fail-1', kind: 'task', performative: 'request',
        sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'will fail' }] },
        extensions: { reply_endpoint: `http://127.0.0.1:${port}`, reply_token: token }, idempotency_key: 'idem-ext-fail-1',
      } as never);
      const response = await Promise.race([reply, new Promise((_, reject) => setTimeout(() => reject(new Error('external gateway error reply timeout')), 10_000))]) as { payload: { parts: Array<{ type?: string; text?: string }> }; task_id?: string };
      expect(replies).toHaveLength(1);
      // 失败显式回传：任务 id 回显 + 错误文本（agent exited 非零码），不静默吞掉。
      expect(response.task_id).toBe('tsk-ext-fail-1');
      const text = response.payload.parts[0].text ?? '';
      expect(text).toContain('p3394_gateway_error');
      expect(text).toMatch(/agent exited 3/);
      await dialer.close();
      try { fs.rmSync(failingCli, { force: true }); } catch { /* best effort */ }
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
    }
  }, 60_000);

  it('fails fast with p3394_gateway_script_missing when the gateway script is absent', async () => {
    const previousPcDir = process.env.COGSEED_PC_DIR;
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-no-gateway-'));
    process.env.COGSEED_PC_DIR = emptyDir;
    try {
      const started = await startExternalGateway({
        cli: 'hermes',
        bridgeInfo: { endpoint: 'http://127.0.0.1:1', token: 'x' },
      });
      expect(started.ok).toBe(false);
      if (started.ok === false) expect(started.error).toContain('p3394_gateway_script_missing');
    } finally {
      if (previousPcDir === undefined) delete process.env.COGSEED_PC_DIR;
      else process.env.COGSEED_PC_DIR = previousPcDir;
      try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 30_000);

  it('times out with p3394_gateway_registration_timeout when the gateway never registers', async () => {
    const previousPcDir = process.env.COGSEED_PC_DIR;
    // Point COGSEED_PC_DIR at the real repo root so the real gateway.cjs exists…
    const repoGateway = path.resolve(__dirname, '..', '..', '..', '..', 'p3394-gateway');
    if (fs.existsSync(path.join(repoGateway, 'gateway.cjs'))) process.env.COGSEED_PC_DIR = path.dirname(repoGateway);
    try {
      const started = await startExternalGateway({
        cli: 'hermes',
        binPath: '/bin/echo',
        // …but the bridge endpoint is unreachable, so the hello registration
        // can never complete and the 15s registration deadline fires.
        bridgeInfo: { endpoint: 'http://127.0.0.1:1', token: 'x' },
      });
      expect(started.ok).toBe(false);
      if (started.ok === false) expect(started.error).toContain('p3394_gateway_registration_timeout');
    } finally {
      if (previousPcDir === undefined) delete process.env.COGSEED_PC_DIR;
      else process.env.COGSEED_PC_DIR = previousPcDir;
    }
  }, 60_000);

  it('respawns managed gateways recorded in the state file (boot recovery)', async () => {
    // Fake CogSeed bridge：收 hello → 注册节点（与 app-wiring 同构）。
    const token = 'respawn-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    const gatewayStateFile = p3394StateFile('p3394-external-gateways.json');
    try { fs.rmSync(registryFile, { force: true }); fs.rmSync(gatewayStateFile, { force: true }); } catch { /* test isolation */ }
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('respawn-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    channel.subscribe((envelope) => {
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
      if (registry.resolve(senderId).ok === false) {
        registry.register({
          identity: { agent_id: senderId, display_name: senderId },
          manifest: { spec_version: 'p3394/1.0', identity: { agent_id: senderId, display_name: senderId }, runtime: { kind: 'in_process' }, capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false }, channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }], session: { scope: 'per-conversation', requires_session_id: true }, security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true }, conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true } } as never,
          ...(endpoints.length ? { endpoints } : {}),
        });
      }
    });
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    // 模拟上次运行遗留的托管网关记录（应用重启后 state 文件仍在）。
    // 先清掉任何旧托管状态，再写入模拟的"上次运行遗留记录"（顺序不能反：
    // stopExternalGateway 会重写 state 文件）。
    await stopExternalGateway('hermes');
    fs.mkdirSync(path.dirname(gatewayStateFile), { recursive: true });
    fs.writeFileSync(gatewayStateFile, JSON.stringify({
      schema_version: 1,
      gateways: [{ cli: 'hermes', agent_id: 'hermes', alias: '重启Hermes', bin: '/bin/echo', port: 59999, pid: 1, started_at: new Date().toISOString() }],
    }));
    try {
      const outcome = await respawnManagedGateways({ bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
      expect(outcome.restarted).toContain('hermes');
      expect(outcome.failed).toHaveLength(0);
      const listed = listExternalGateways().filter((g) => g.cli === 'hermes');
      expect(listed.length).toBe(1);
      expect(listed[0].running).toBe(true);
      expect(listed[0].alias).toBe('重启Hermes');
      // 幂等：再次 respawn 复用存活实例，不重复拉起。
      const second = await respawnManagedGateways({ bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
      expect(second.restarted).toContain('hermes');
      expect(listExternalGateways().filter((g) => g.cli === 'hermes')).toHaveLength(1);
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(gatewayStateFile, { force: true }); } catch { /* best effort */ }
    }
  }, 60_000);

  it('S-04: concurrent starts of the same CLI share one in-flight gateway (no double spawn)', async () => {
    const token = 'dedup-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    const gatewayStateFile = p3394StateFile('p3394-external-gateways.json');
    try { fs.rmSync(registryFile, { force: true }); fs.rmSync(gatewayStateFile, { force: true }); } catch { /* isolate */ }
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('dedup-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    let registrations = 0;
    channel.subscribe((envelope) => {
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
      if (registry.resolve(senderId).ok === false) {
        registrations += 1;
        registry.register({
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
      }
    });
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    const bridgeInfo = { endpoint: `http://127.0.0.1:${port}`, token };
    try {
      await stopExternalGateway('hermes');
      const [a, b] = await Promise.all([
        startExternalGateway({ cli: 'hermes', binPath: '/bin/echo', alias: '并发A', bridgeInfo }),
        startExternalGateway({ cli: 'hermes', binPath: '/bin/echo', alias: '并发B', bridgeInfo }),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      // 同 cli 只应有一个托管进程 + 一次 hello 注册。
      expect(listExternalGateways().filter((g) => g.cli === 'hermes')).toHaveLength(1);
      expect(registrations).toBe(1);
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(gatewayStateFile, { force: true }); } catch { /* best effort */ }
    }
  }, 60_000);
});

describe('G-35 任意智能体走 sscli（runtimeModeForCli）', () => {
  it('未知名自接 CLI → sscli（经通用垫片，不再限定预设名单）', () => {
    expect(runtimeModeForCli('my-custom-bot')).toBe('sscli');
    expect(runtimeModeForCli('')).toBe('sscli');
  });
  it('预设 CLI → sscli；codex → 专属后端（undefined）', () => {
    for (const cli of ['hermes', 'gemini', 'aider', 'openclaw', 'opencode', 'workbuddy']) {
      expect(runtimeModeForCli(cli)).toBe('sscli');
    }
    expect(runtimeModeForCli('codex')).toBeUndefined();
  });
  it('排除表 COGSEED_P3394_SSCLI_EXCLUDE 命中 → 回 oneshot', () => {
    const prev = process.env.COGSEED_P3394_SSCLI_EXCLUDE;
    process.env.COGSEED_P3394_SSCLI_EXCLUDE = 'weird-cli, another';
    try {
      expect(runtimeModeForCli('weird-cli')).toBeUndefined();
      expect(runtimeModeForCli('another')).toBeUndefined();
      expect(runtimeModeForCli('other')).toBe('sscli');
    } finally {
      if (prev === undefined) delete process.env.COGSEED_P3394_SSCLI_EXCLUDE;
      else process.env.COGSEED_P3394_SSCLI_EXCLUDE = prev;
    }
  });
});
