/**
 * P3394 托管网关崩溃守护（watchdog）真实集成测试（无 mock）：
 *
 *  真实 bridge（P3394HttpChannel + 真实持久化 registry）+ 真实 gateway.cjs
 *  子进程 + 真实可执行 CLI。SIGKILL 掉 gateway 子进程后，watchdog 应自动
 *  重启（复用上次的 bin/alias/bridge），重启后的节点真实健康。
 *
 *  放在独立文件：external-gateways.test.ts 由并行会话维护，避免编辑冲突。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { P3394PeerRegistry } from '../../../../src/main/features/p3394_bridge/registry';
import { listExternalGateways, startExternalGateway, stopExternalGateway } from '../../../../src/main/features/p3394_bridge/external-gateways';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';

// 独立 runtime variant：本测试会真实 spawn/kill gateway 子进程，必须与
// 其他共享 p3394 state 文件（external-gateways.test.ts 等）的测试隔离。
let previousVariant: string | undefined;
let previousWs: string | undefined;
let variant = '';
beforeAll(() => {
  variant = 'p3394-wd-' + Math.random().toString(36).slice(2, 8);
  previousVariant = process.env.ORKAS_RUNTIME_VARIANT;
  previousWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_RUNTIME_VARIANT = variant;
  process.env.ORKAS_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-wd-ws-'));
});
afterAll(() => {
  if (previousVariant === undefined) delete process.env.ORKAS_RUNTIME_VARIANT;
  else process.env.ORKAS_RUNTIME_VARIANT = previousVariant;
  if (previousWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWs;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variant), { recursive: true, force: true }); } catch { /* best effort */ }
});

function makeRegistryAutoRegister(registry: P3394PeerRegistry) {
  return (envelope: { sender: { agent_id: string }; extensions?: Record<string, unknown> }) => {
    const senderId = envelope.sender.agent_id;
    const endpoints = (envelope.extensions?.endpoints ?? []).filter((v): v is string => typeof v === 'string');
    // 与 app-wiring 一致：已注册节点也刷新端点（hello 每次带最新地址）。
    // 网关重启换端口后，旧记录必须并入新端点，否则 startExternalGateway
    // 的注册等待（读磁盘 registry）会因找不到新端点而超时。
    registry.register({
      identity: { agent_id: senderId, display_name: senderId },
      manifest: { spec_version: 'p3394/1.0', identity: { agent_id: senderId, display_name: senderId }, runtime: { kind: 'in_process' }, capability_profile: { agent_id: senderId, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request'], supports_streaming: false, supports_artifacts: false }, channels: [{ id: 'x', kind: 'local', direction: 'inbound-outbound' }], session: { scope: 'per-conversation', requires_session_id: true }, security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true }, conformance: { level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true } } as never,
      ...(endpoints.length ? { endpoints } : {}),
    });
  };
}

describe('P3394 managed gateway watchdog (real processes)', () => {
  it('auto-restarts a managed gateway after the child process crashes', async () => {
    const token = 'ext-watchdog-token';
    const registryFile = p3394StateFile('p3394-peers.json');
    try { fs.rmSync(registryFile, { force: true }); } catch { /* test isolation */ }
    const registry = new P3394PeerRegistry({ filePath: registryFile });
    const channel = new P3394HttpChannel('ext-watchdog-bridge', { listen: { host: '127.0.0.1', port: 0 }, authToken: token });
    await channel.listen();
    channel.subscribe(makeRegistryAutoRegister(registry));
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    try {
      await stopExternalGateway('hermes');
      const started = await startExternalGateway({
        cli: 'hermes', binPath: '/bin/echo', alias: 'Watchdog Hermes', bridgeInfo: { endpoint: `http://127.0.0.1:${port}`, token },
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      const firstPid = started.value.pid;
      // 模拟崩溃：SIGKILL 真实 gateway 子进程。
      expect(() => process.kill(firstPid, 'SIGKILL')).not.toThrow();

      // 等 watchdog 自动重启（默认退避 5s + 启动/注册/hello）。
      const deadline = Date.now() + 25_000;
      let restartedPid: number | null = null;
      while (Date.now() < deadline && restartedPid === null) {
        const alive = listExternalGateways().filter((g) => g.cli === 'hermes' && g.running);
        if (alive.length && alive[0].pid !== firstPid) restartedPid = alive[0].pid;
        else await new Promise((r) => setTimeout(r, 500));
      }
      expect(restartedPid).not.toBeNull();
      expect(restartedPid).not.toBe(firstPid);
      // 重启后的真实节点健康。
      const listed = listExternalGateways().find((g) => g.cli === 'hermes');
      expect(listed?.running).toBe(true);
      const health = await new Promise<string>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${listed?.port}/p3394/health`, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
      });
      expect(health).toContain('"ok":true');
    } finally {
      await stopExternalGateway('hermes');
      await channel.close();
      try { fs.rmSync(registryFile, { force: true }); } catch { /* best effort */ }
    }
  }, 45_000);
});
