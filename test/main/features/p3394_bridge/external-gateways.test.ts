import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { P3394PeerRegistry } from '../../../../src/main/features/p3394_bridge/registry';
import { listExternalGateways, p3394ExternalGatewayIdFor, respawnManagedGateways, runtimeModeForCli, startExternalGateway, stopAllExternalGateways, stopExternalGateway } from '../../../../src/main/features/p3394_bridge/external-gateways';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';
import * as fs from 'node:fs';

// 「声明即生效」端到端（见文末用例）：mock agents 模块让 listAgents 返回
// 带参数模板声明的 agent。aider 预设有 modelArgs 无 effortArgs——声明的
// effort_args 注入后 /models 应披露 effort_controllable: true（三跳全证：
// agent 声明 → spawn env → 网关协商披露）。
const listAgentsMock = vi.fn(async () => [
  { agent_id: 'decl-test', name: '声明通道测试', runtime: { kind: 'p3394-gateway', cli: 'aider', effort_args: '--thinking {effort}' } },
]);
vi.mock('../../../../src/main/features/agents', () => ({ listAgents: (...args: unknown[]) => listAgentsMock(...args) }));

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

function writeNodeCli(name: string, body: string): string {
  const file = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

describe('P3394 external-agent gateway host', () => {
  it('maps every supported CLI to a gateway preset node id', () => {
    expect(p3394ExternalGatewayIdFor('claude')).toBe('claude');
    expect(p3394ExternalGatewayIdFor('codex')).toBe('codex');
    expect(p3394ExternalGatewayIdFor('hermes')).toBe('hermes');
    expect(p3394ExternalGatewayIdFor('openclaw')).toBe('openclaw');
    expect(p3394ExternalGatewayIdFor('workbuddy')).toBe('workbuddy');
    expect(p3394ExternalGatewayIdFor('nonsense')).toBeNull();
  });

  it('requests graceful shutdown for connected gateways and directly terminates recovered processes', async () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'features', 'p3394_bridge', 'external-gateways.ts'), 'utf8');
    const declaration = /export async function stopAllExternalGateways\(\): Promise<void> \{[\s\S]*?^}/m.exec(source)?.[0];
    if (!declaration) throw new Error('stopAllExternalGateways not found');
    const runnable = declaration.replace(/^export /, '').replace(': Promise<void>', '');
    const records = [
      { cli: 'hermes', pid: 101, running: true },
      { cli: 'claude', pid: 202, running: true },
      { cli: 'recovered', pid: 303, running: true },
      { cli: 'offline', pid: 404, running: false },
    ];
    const hermesChild = { connected: true };
    const claudeChild = { connected: true };
    const watched = new Map<string, object>([
      ['hermes', hermesChild],
      ['claude', claudeChild],
      ['offline', {}],
    ]);
    const detached: string[] = [];
    const gracefulResolvers: Array<(closed: boolean) => void> = [];
    const requestGatewayShutdown = vi.fn(() => new Promise<boolean>((resolve) => { gracefulResolvers.push(resolve); }));
    const killResolvers: Array<() => void> = [];
    const killProcessTree = vi.fn(() => new Promise<void>((resolve) => { killResolvers.push(resolve); }));
    const stopAll = vm.runInNewContext(`(${runnable})`, {
      listExternalGateways: () => records,
      detachWatch: (cli: string) => { detached.push(cli); watched.delete(cli); },
      requestGatewayShutdown,
      killProcessTree,
      watched,
      process,
      Promise,
    }) as () => Promise<void>;

    const completion = stopAll();
    expect(completion && typeof completion.then).toBe('function');
    expect(requestGatewayShutdown).toHaveBeenCalledTimes(2);
    expect(requestGatewayShutdown).toHaveBeenNthCalledWith(1, hermesChild);
    expect(requestGatewayShutdown).toHaveBeenNthCalledWith(2, claudeChild);
    // No watched ChildProcess exists after app recovery, so this PID must
    // enter the established cross-platform tree-kill path without IPC grace.
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(detached).toEqual(['hermes', 'claude', 'recovered']);
    expect(watched.has('offline')).toBe(true);

    let settled = false;
    void completion.then(() => { settled = true; });
    gracefulResolvers[0](true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(watched.has('offline')).toBe(true);

    gracefulResolvers[1](false);
    await Promise.resolve();
    expect(killProcessTree).toHaveBeenCalledTimes(2);
    killResolvers[0]();
    await Promise.resolve();
    expect(settled).toBe(false);
    killResolvers[1]();
    await completion;
    expect(watched.size).toBe(0);
  });

  it('delivers p3394-shutdown over IPC to a managed gateway before using signal fallback', async () => {
    const previousPcDir = process.env.COGSEED_PC_DIR;
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-ipc-gateway-'));
    const fixtureDir = path.join(fixtureRoot, 'p3394-gateway');
    const fixtureScript = path.join(fixtureDir, 'gateway.cjs');
    const gatewayHome = path.join(path.dirname(p3394StateFile('p3394-external-gateways.json')), 'external-gateways', 'hermes');
    const ipcMarker = path.join(gatewayHome, 'ipc-shutdown.json');
    const signalMarker = path.join(gatewayHome, 'signal-shutdown.txt');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(fixtureScript, [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const path = require('node:path');",
      "const home = process.env.P3394_GATEWAY_HOME;",
      "const runtimeRoot = path.resolve(home, '..', '..');",
      "const endpoint = process.env.P3394_ADVERTISE_ENDPOINT;",
      "fs.mkdirSync(home, { recursive: true });",
      "fs.writeFileSync(path.join(runtimeRoot, 'p3394-peers.json'), JSON.stringify({ schemaVersion: 1, peers: [{ identity: { agent_id: process.env.P3394_AGENT_ID, display_name: 'fixture' }, aliases: [], manifest: {}, endpoints: [endpoint], updated_at: new Date().toISOString() }] }));",
      "const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });",
      "server.listen(Number(process.env.P3394_GATEWAY_PORT), process.env.P3394_GATEWAY_HOST);",
      "process.once('message', (message) => { fs.writeFileSync(path.join(home, 'ipc-shutdown.json'), JSON.stringify(message)); server.close(() => process.exit(0)); });",
      "process.once('SIGTERM', () => { fs.writeFileSync(path.join(home, 'signal-shutdown.txt'), 'SIGTERM'); process.exit(0); });",
      '',
    ].join('\n'));

    try {
      await stopExternalGateway('hermes');
      process.env.COGSEED_PC_DIR = fixtureRoot;
      const started = await startExternalGateway({
        cli: 'hermes',
        binPath: '/bin/echo',
        bridgeInfo: { endpoint: 'http://127.0.0.1:1', token: 'fixture' },
      });
      expect(started.ok, 'fixture gateway failed to start: ' + (started.ok === false ? started.error : '')).toBe(true);

      await stopExternalGateway('hermes');

      expect(JSON.parse(fs.readFileSync(ipcMarker, 'utf8'))).toEqual({ type: 'p3394-shutdown' });
      expect(fs.existsSync(signalMarker)).toBe(false);
    } finally {
      await stopExternalGateway('hermes').catch(() => {});
      if (previousPcDir === undefined) delete process.env.COGSEED_PC_DIR;
      else process.env.COGSEED_PC_DIR = previousPcDir;
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('awaits P3394 bridge and gateway shutdown before the Electron quit resumes', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/app\.once\('before-quit',[\s\S]{0,400}?void stopP3394Bridge/);
    expect(source).not.toMatch(/app\.once\('before-quit',[\s\S]{0,500}?void import\('\.\/features\/p3394_bridge\/external-gateways'\)/);

    const handlerStart = source.indexOf("app.on('before-quit', async (e) =>", source.indexOf('let shutdownFlushed = false'));
    const handlerEnd = source.indexOf("\n  });", handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    const waitAt = handler.indexOf('await Promise.allSettled([');
    const bridgeAt = handler.indexOf('stopP3394Bridge()');
    const gatewaysAt = handler.indexOf('stopAllExternalGateways()');
    const flushedAt = handler.indexOf('shutdownFlushed = true');
    const quitAt = handler.indexOf('app.quit()');
    expect(waitAt).toBeGreaterThan(-1);
    expect(bridgeAt).toBeGreaterThan(waitAt);
    expect(gatewaysAt).toBeGreaterThan(waitAt);
    expect(flushedAt).toBeGreaterThan(gatewaysAt);
    expect(quitAt).toBeGreaterThan(flushedAt);
  });

  it('guards before-quit cleanup with a promise assigned before cleanup can reenter', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
    const stateStart = source.indexOf('let shutdownFlushed = false');
    const handlerStart = source.indexOf("app.on('before-quit', async (e) =>", stateStart);
    const handlerEnd = source.indexOf('\n  });', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(source.slice(stateStart, handlerStart)).toContain('let shutdownPromise');
    const completedGuardAt = handler.indexOf('if (shutdownFlushed) return');
    const preventAt = handler.indexOf('e.preventDefault()');
    const inFlightGuardAt = handler.indexOf('if (shutdownPromise)');
    const assignAt = handler.indexOf('shutdownPromise = Promise.resolve().then(async () =>');
    const cleanupAt = handler.indexOf('searchFeature.flushAll()');
    const awaitAt = handler.lastIndexOf('await shutdownPromise');
    expect(completedGuardAt).toBeGreaterThan(-1);
    expect(preventAt).toBeGreaterThan(completedGuardAt);
    expect(inFlightGuardAt).toBeGreaterThan(preventAt);
    expect(assignAt).toBeGreaterThan(inFlightGuardAt);
    expect(cleanupAt).toBeGreaterThan(assignAt);
    expect(awaitAt).toBeGreaterThan(cleanupAt);
  });

  it.runIf(process.platform === 'win32')('waits for every managed gateway process tree before stopAll resolves', async () => {
    const stateFile = p3394StateFile('p3394-external-gateways.json');
    const pidFile = path.join(os.tmpdir(), `p3394-stop-all-pids-${process.pid}-${Date.now()}.txt`);
    const fixture = writeNodeCli('p3394-stop-all-tree', [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.env.P3394_TREE_PID_FILE, process.pid + '\\n' + child.pid + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const root = spawn(process.execPath, [fixture], {
      env: { ...process.env, P3394_TREE_PID_FILE: pidFile },
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        schema_version: 1,
        gateways: [{ cli: 'hermes', agent_id: 'hermes', bin: fixture, port: 1, pid: root.pid, started_at: new Date().toISOString() }],
      }));

      await stopAllExternalGateways();

      const survivors = pids.filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      expect(survivors).toEqual([]);
    } finally {
      if (root.pid) spawnSync('taskkill.exe', ['/pid', String(root.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      fs.rmSync(fixture, { force: true });
      fs.rmSync(pidFile, { force: true });
      fs.rmSync(stateFile, { force: true });
    }
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
    const echoCli = writeNodeCli('p3394-echo-cli', "process.stdout.write(process.argv.slice(2).join(' '));");
    try {
      await stopExternalGateway('hermes');
      const started = await startExternalGateway({ cli: 'hermes', binPath: echoCli, alias: '任务 Hermes', bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
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
      expect(fs.existsSync(path.join(path.dirname(registryFile), 'external-gateways', 'hermes.log'))).toBe(false);
      await dialer.close();
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(echoCli, { force: true }); } catch { /* best effort */ }
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

  it('runs WorkBuddy through its Windows .cmd sibling with multiline prompts and oneshot model discovery', async () => {
    if (process.platform !== 'win32') return;
    const token = 'ext-windows-shim-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-windows-shim-'));
    const shimDir = path.join(shimRoot, 'node_modules', '.bin');
    fs.mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, 'agent shim');
    const cliScript = path.join(shimDir, 'fake-agent.cjs');
    const previousArgs = process.env.P3394_AGENT_CLI_ARGS;
    const previousExclude = process.env.COGSEED_P3394_SSCLI_EXCLUDE;
    const prompt = '第一行\r\n第二行 & "quoted" %value% !bang!\n第三行 | < > ^ (group)';
    fs.writeFileSync(cliScript, [
      "const args = process.argv.slice(2);",
      "if (args.includes('--help')) process.stdout.write('  --model <model> Currently supported: (wb-fast, wb-smart)\\n');",
      "else if (args.includes('--input-format')) process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'wb-smart' }) + '\\n');",
      "else process.stdout.write(args.join(' '));",
      '',
    ].join('\n'));
    // npm on Windows leaves a POSIX shim beside the executable .cmd entry.
    fs.writeFileSync(shim, '#!/bin/sh\n');
    fs.writeFileSync(`${shim}.cmd`, '@echo off\r\nnode "%~dp0fake-agent.cjs" %*\r\n');
    process.env.P3394_AGENT_CLI_ARGS = '-p {message}';
    try { fs.rmSync(registryFile, { force: true }); } catch { /* isolate */ }
    const channel = new P3394HttpChannel('ext-windows-shim-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    let replyResolve: ((value: unknown) => void) | null = null;
    channel.subscribe((envelope) => {
      if (envelope.sender.agent_id === 'workbuddy' && envelope.performative === 'inform') {
        if (envelope.kind === 'event') return;
        replyResolve?.(envelope);
        return;
      }
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
      const diskRegistry = new P3394PeerRegistry({ filePath: registryFile });
      if (diskRegistry.resolve(senderId).ok === false) {
        diskRegistry.register({
          identity: { agent_id: senderId, display_name: senderId },
          manifest: { spec_version: 'p3394/1.0', identity: { agent_id: senderId, display_name: senderId }, runtime: { kind: 'in_process' }, capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false }, channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }], session: { scope: 'per-conversation', requires_session_id: true }, security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true }, conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true } } as never,
          ...(endpoints.length ? { endpoints } : {}),
        });
      }
    });
    const port = ((channel as unknown as { server: import('node:http').Server }).server.address() as { port: number }).port;
    try {
      for (const mode of ['sscli', 'oneshot'] as const) {
        process.env.COGSEED_P3394_SSCLI_EXCLUDE = mode === 'oneshot' ? 'workbuddy' : '';
        await stopExternalGateway('workbuddy');
        try { fs.rmSync(registryFile, { force: true }); } catch { /* isolate restart */ }
        const reply = new Promise<unknown>((resolve) => { replyResolve = resolve; });
        const started = await startExternalGateway({ cli: 'workbuddy', binPath: shim, bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error(started.error);
        const dialer = new P3394HttpChannel(`ext-windows-shim-dialer-${mode}`, { dial: { endpoints: [`http://127.0.0.1:${started.value.port}`] } });
        try {
          const modelsResponse = await fetch(`http://127.0.0.1:${started.value.port}/p3394/models`);
          const models = await modelsResponse.json() as { status?: string; models?: Array<{ id?: string }>; error?: string };
          if (mode === 'oneshot') {
            expect(models.status, `${mode}: ${models.error || 'model probe unavailable'}`).toBe('ready');
            expect(models.models?.map((model) => model.id), mode).toContain('wb-smart');
          }
          await dialer.dial('workbuddy');
          await dialer.send({
            spec_version: 'p3394/1.0', message_id: `msg-windows-shim-${mode}`, session_id: `ses-windows-shim-${mode}`, task_id: `tsk-windows-shim-${mode}`, kind: 'task', performative: 'request',
            sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'workbuddy' }], payload: { parts: [{ type: 'text', text: prompt }] },
            extensions: { reply_endpoint: `http://127.0.0.1:${port}`, reply_token: token }, idempotency_key: `idem-windows-shim-${mode}`,
          } as never);
          const response = await Promise.race([reply, new Promise((_, reject) => setTimeout(() => reject(new Error(`windows shim ${mode} reply timeout`)), 10_000))]) as { payload: { parts: Array<{ text?: string }> } };
          expect(response.payload.parts[0].text, mode).toContain(prompt);
        } finally {
          replyResolve = null;
          await dialer.close();
          await stopExternalGateway('workbuddy');
        }
      }
    } finally {
      await stopExternalGateway('workbuddy');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(shimRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      if (previousArgs === undefined) delete process.env.P3394_AGENT_CLI_ARGS;
      else process.env.P3394_AGENT_CLI_ARGS = previousArgs;
      if (previousExclude === undefined) delete process.env.COGSEED_P3394_SSCLI_EXCLUDE;
      else process.env.COGSEED_P3394_SSCLI_EXCLUDE = previousExclude;
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
    const failingCli = writeNodeCli('p3394-fail-cli', 'process.exit(3);');
    try {
      await stopExternalGateway('hermes');
      // 跨平台 Node CLI 以非零码（3）退出，验证真实执行失败回信路径。
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
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(failingCli, { force: true }); } catch { /* best effort */ }
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

  it('injects per-agent template declarations into the gateway env (declare-then-controllable)', async () => {
    // 三跳全证：agent 声明（listAgentsMock）→ spawn env（P3394_AGENT_EFFORT_ARGS）
    // → 网关协商披露（/models effort_controllable）。aider 预设有 modelArgs、
    // 无 effortArgs——无声明时 effort_controllable 应为 false，有声明为 true。
    const token = 'decl-test-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    try { fs.rmSync(registryFile, { force: true }); } catch { /* test isolation */ }
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('decl-test-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    // 与其他用例同构：收 hello → 写注册表（startExternalGateway 等 stateFile
    // 出现该节点才算起动完成）。
    channel.subscribe((envelope) => {
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
      // 每轮从磁盘重建：同 variant 内 bare→declared 重启会重置注册表文件，
      // 内存实例的旧记录会挡住新 endpoint 的注册。
      const diskRegistry = new P3394PeerRegistry({ filePath: registryFile });
      if (diskRegistry.resolve(senderId).ok === false) {
        diskRegistry.register({
          identity: { agent_id: senderId, display_name: senderId },
          manifest: { spec_version: 'p3394/1.0', identity: { agent_id: senderId, display_name: senderId }, runtime: { kind: 'in_process' }, capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false }, channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }], session: { scope: 'per-conversation', requires_session_id: true }, security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true }, conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true } } as never,
          ...(endpoints.length ? { endpoints } : {}),
        });
      }
    });
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    const fetchModels = async (port2: number) => {
      const res = await fetch(`http://127.0.0.1:${port2}/p3394/models`);
      return res.json() as Promise<{ model_controllable?: boolean; effort_controllable?: boolean }>;
    };
    try {
      // 对照组：无声明（mock 返回空）→ effort 不可控。
      listAgentsMock.mockResolvedValueOnce([]);
      const bare = await startExternalGateway({ cli: 'aider', binPath: '/bin/echo', bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
      expect(bare.ok, 'bare start failed: ' + (bare.ok === false ? bare.error : '')).toBe(true);
      if (!bare.ok) throw new Error(bare.error);
      const bareCaps = await fetchModels(bare.value.port);
      expect(bareCaps.model_controllable).toBe(true);   // aider 预设自带 --model
      expect(bareCaps.effort_controllable).toBe(false); // 预设无 effort 通道
      await stopExternalGateway('aider');
      // 重置注册表：bare 组的旧 aider 记录（旧 endpoint）会让 subscribe
      // 回调跳过新注册 → declared 的新 endpoint 永远等不到。同 variant
      // 内重启必须先清（生产路径 stopExternalGateway 不动 peers 注册表）。
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }

      // 实验组：带声明（文件顶部默认 mock）→ 强度可控。
      const declared = await startExternalGateway({ cli: 'aider', binPath: '/bin/echo', bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
      expect(declared.ok, 'declared start failed: ' + (declared.ok === false ? declared.error : '')).toBe(true);
      if (!declared.ok) throw new Error(declared.error);
      const declaredCaps = await fetchModels(declared.value.port);
      expect(declaredCaps.effort_controllable).toBe(true);
    } finally {
      await stopExternalGateway('aider');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
    }
  }, 60_000);

  it('discloses effort_controllable for proprietary effort channels (claude/codex)', async () => {
    // claude（MAX_THINKING_TOKENS）/ codex（model_reasoning_effort）的强度走
    // 专有通道而非 effortArgs 模板——披露必须算上 effortChannel，否则刷新后
    // 协商 false 压过兜底表、UI 置灰（Command+R 后强度消失的回归）。
    const token = 'channel-test-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    try { fs.rmSync(registryFile, { force: true }); } catch { /* test isolation */ }
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('channel-test-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    channel.subscribe((envelope) => {
      const senderId = envelope.sender.agent_id;
      const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
      const diskRegistry = new P3394PeerRegistry({ filePath: registryFile });
      if (diskRegistry.resolve(senderId).ok === false) {
        diskRegistry.register({
          identity: { agent_id: senderId, display_name: senderId },
          manifest: { spec_version: 'p3394/1.0', identity: { agent_id: senderId, display_name: senderId }, runtime: { kind: 'in_process' }, capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false }, channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }], session: { scope: 'per-conversation', requires_session_id: true }, security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true }, conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true } } as never,
          ...(endpoints.length ? { endpoints } : {}),
        });
      }
    });
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    listAgentsMock.mockResolvedValueOnce([]);
    try {
      const started = await startExternalGateway({ cli: 'claude', binPath: '/bin/echo', bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token } });
      expect(started.ok, 'claude start failed: ' + (started.ok === false ? started.error : '')).toBe(true);
      if (!started.ok) throw new Error(started.error);
      const res = await fetch(`http://127.0.0.1:${started.value.port}/p3394/models`);
      const caps = await res.json() as { effort_controllable?: boolean; model_controllable?: boolean };
      expect(caps.model_controllable).toBe(true);
      expect(caps.effort_controllable).toBe(true);  // 专有通道 effortChannel
      void registry;
    } finally {
      await stopExternalGateway('claude');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
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
