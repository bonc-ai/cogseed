/**
 * V-04：Hermes（对端 gateway）主动发起任务 → CogSeed 执行 → 自动回发结果
 * → gateway 打印并退出的反向闭环验收。
 *
 * 本进程作为 CogSeed 完整桥节点（Kernel + Executor + runtime + HTTP
 * listener + §11 自动回发）；对端是独立进程运行的 p3394-gateway
 * （P3394_SEND_TASK 一次性任务模式）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeExecutor,
  P3394BridgeKernel,
  P3394HttpChannel,
} from '../../../../src/main/features/p3394';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const children: ChildProcess[] = [];
const openChannels: P3394HttpChannel[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-reverse-loop-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const channel of openChannels.splice(0)) await channel.close().catch(() => {});
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('no port'));
      }
    });
  });
}

function waitFor(probe: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (probe()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('waitFor timeout'));
      }
    }, 25);
  });
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // 进程可能在任何等待之前就已退出：先看 exitCode，再挂监听。
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error('child exit timeout')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

function manifestOf(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

describe('P3394 Hermes → CogSeed → Hermes 反向闭环 (V-04)', () => {
  it('对端 gateway 主动发起任务并收到 CogSeed 自动回发结果', async () => {
    const parentPort = await freePort();
    const gatewayPort = await freePort();
    const resultFile = path.join(tmpDir, 'cogseed-result.json');

    // CogSeed 节点（本进程）：执行入站任务，终态落盘证据，§11 自动回发。
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifestOf('cogseed') });
    bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifestOf('hermes') });
    let currentTaskId = '';
    const runtime: P3394RuntimeAdapter = {
      async openSession(input): Promise<P3394RuntimeSessionBinding> {
        return { session_id: input.session_id, native_session_id: 'native-' + input.session_id, agent_id: input.agent_id };
      },
      async deliver(envelope): Promise<{ task_id: string }> {
        currentTaskId = envelope.task_id || 'task-' + envelope.message_id;
        return { task_id: currentTaskId };
      },
      async *stream(): AsyncIterable<P3394RuntimeEvent> {
        yield { sequence: 1, task_id: currentTaskId, kind: 'started', data: {} };
        yield { sequence: 2, task_id: currentTaskId, kind: 'delta', data: { text: 'cogseed answer' } };
        yield { sequence: 3, task_id: currentTaskId, kind: 'completed', data: {} };
      },
      async resume(): Promise<void> {},
      async cancel(): Promise<void> {},
      async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
        return { session_id: sessionId, native_session_id: 'native-' + sessionId, at: new Date().toISOString() };
      },
      async closeSession(): Promise<void> {},
    };
    const executor = new P3394BridgeExecutor({
      bridge,
      runtime,
      recordEpisode: (episode) => {
        fs.writeFileSync(resultFile, JSON.stringify({ status: episode.status, session_id: episode.session_id, task_id: episode.task_id }));
      },
    });
    const channel = new P3394HttpChannel('cogseed-http', {
      listen: { host: '127.0.0.1', port: parentPort },
      authToken: 'parent-token',
    });
    channel.setLocalManifest(manifestOf('cogseed'));
    channel.subscribe((envelope) => { executor.execute(envelope); });
    await channel.listen();
    openChannels.push(channel);

    // 对端：p3394-gateway 独立进程，P3394_SEND_TASK 一次性任务模式。
    const gateway = spawn(process.execPath, [path.join(process.cwd(), 'p3394-gateway', 'gateway.cjs')], {
      env: {
        ...process.env,
        P3394_GATEWAY_PORT: String(gatewayPort),
        P3394_GATEWAY_TOKEN: 'gateway-token',
        P3394_ADVERTISE_ENDPOINT: `http://127.0.0.1:${gatewayPort}`,
        P3394_GATEWAY_HOME: path.join(tmpDir, 'gateway-home'),
        COGSEED_ENDPOINT: `http://127.0.0.1:${parentPort}`,
        COGSEED_TOKEN: 'parent-token',
        P3394_SEND_TASK: 'reverse task from hermes',
        P3394_HEARTBEAT_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(gateway);
    let stdout = '';
    let stderr = '';
    gateway.stdout.setEncoding('utf8');
    gateway.stdout.on('data', (chunk: string) => { stdout += chunk; });
    gateway.stderr.setEncoding('utf8');
    gateway.stderr.on('data', (chunk: string) => { stderr += chunk; });

    await waitFor(() => fs.existsSync(resultFile), 15_000);
    const exitCode = await waitExit(gateway, 15_000);
    expect(exitCode, 'gateway stderr: ' + stderr + '\nstdout: ' + stdout).toBe(0);
    expect(stdout).toContain('cogseed answer');

    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { status: string; task_id: string };
    expect(result.status).toBe('completed');
    expect(result.task_id).toMatch(/^tsk-/);
  }, 40_000);

  it('断线恢复：首次发送失败（CogSeed 未起）→ 重试成功 → 闭环完成（V-04 断线重试）', async () => {
    const parentPort = await freePort();
    const gatewayPort = await freePort();
    const resultFile = path.join(tmpDir, 'cogseed-result-retry.json');

    // 先启动 gateway（此时 CogSeed 端点未监听 → 首次发送 ECONNREFUSED）。
    const gateway = spawn(process.execPath, [path.join(process.cwd(), 'p3394-gateway', 'gateway.cjs')], {
      env: {
        ...process.env,
        P3394_GATEWAY_PORT: String(gatewayPort),
        P3394_GATEWAY_TOKEN: 'gateway-token',
        P3394_ADVERTISE_ENDPOINT: `http://127.0.0.1:${gatewayPort}`,
        P3394_GATEWAY_HOME: path.join(tmpDir, 'gateway-home-retry'),
        COGSEED_ENDPOINT: `http://127.0.0.1:${parentPort}`,
        COGSEED_TOKEN: 'parent-token',
        P3394_SEND_TASK: 'reverse task after outage',
        P3394_SEND_TASK_RETRIES: '3',
        P3394_SEND_TASK_TIMEOUT_MS: '25000',
        P3394_HEARTBEAT_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(gateway);
    let stdout = '';
    let stderr = '';
    gateway.stdout.setEncoding('utf8');
    gateway.stdout.on('data', (chunk: string) => { stdout += chunk; });
    gateway.stderr.setEncoding('utf8');
    gateway.stderr.on('data', (chunk: string) => { stderr += chunk; });

    // gateway 已启动（首次发送必然失败）；此刻才起 CogSeed 监听器。
    await new Promise((resolve) => setTimeout(resolve, 700));
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifestOf('cogseed') });
    bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifestOf('hermes') });
    let currentTaskId = '';
    const runtime: P3394RuntimeAdapter = {
      async openSession(input): Promise<P3394RuntimeSessionBinding> {
        return { session_id: input.session_id, native_session_id: 'native-' + input.session_id, agent_id: input.agent_id };
      },
      async deliver(envelope): Promise<{ task_id: string }> {
        currentTaskId = envelope.task_id || 'task-' + envelope.message_id;
        return { task_id: currentTaskId };
      },
      async *stream(): AsyncIterable<P3394RuntimeEvent> {
        yield { sequence: 1, task_id: currentTaskId, kind: 'started', data: {} };
        yield { sequence: 2, task_id: currentTaskId, kind: 'delta', data: { text: 'cogseed answer after retry' } };
        yield { sequence: 3, task_id: currentTaskId, kind: 'completed', data: {} };
      },
      async resume(): Promise<void> {},
      async cancel(): Promise<void> {},
      async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
        return { session_id: sessionId, native_session_id: 'native-' + sessionId, at: new Date().toISOString() };
      },
      async closeSession(): Promise<void> {},
    };
    const executor = new P3394BridgeExecutor({
      bridge,
      runtime,
      recordEpisode: (episode) => {
        fs.writeFileSync(resultFile, JSON.stringify({ status: episode.status, session_id: episode.session_id, task_id: episode.task_id }));
      },
    });
    const channel = new P3394HttpChannel('cogseed-http', {
      listen: { host: '127.0.0.1', port: parentPort },
      authToken: 'parent-token',
    });
    channel.setLocalManifest(manifestOf('cogseed'));
    channel.subscribe((envelope) => { executor.execute(envelope); });
    await channel.listen();
    openChannels.push(channel);

    // gateway 重试（1.2s 退避）后送达 → 自动回发 → gateway 打印并退出 0。
    await waitFor(() => fs.existsSync(resultFile), 15_000);
    const exitCode = await waitExit(gateway, 15_000);
    expect(exitCode, 'gateway stderr: ' + stderr + '\nstdout: ' + stdout).toBe(0);
    expect(stdout).toContain('cogseed answer after retry');
    expect(stderr).toContain('retrying');
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { status: string };
    expect(result.status).toBe('completed');
  }, 40_000);
});
