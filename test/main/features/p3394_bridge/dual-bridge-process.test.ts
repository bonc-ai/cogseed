/**
 * C-06：两个独立进程、各自拥有 Kernel/Agent Home/Session Authority/
 * Runtime Adapter 的完整 Bridge 双向闭环验收。
 *
 * 父进程（本测试）作为 Node A：完整 Kernel + 独立 Agent Home + HTTP
 * listener/dialer；子进程（fixtures/bridge-node-child.ts，经 tsx 启动）
 * 作为 Node B：完整 Kernel + 独立 Agent Home + Executor + §11 自动回发。
 *
 * 流程：A 向 B 发送 task（携带 reply_endpoint/reply_token）→ B 独立
 * 执行并产出 episode → B 自动回发 response 到 A → A 校验闭环证据。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeKernel,
  P3394HttpChannel,
} from '../../../../src/main/features/p3394';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const children: ChildProcess[] = [];
const openChannels: P3394HttpChannel[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-dual-bridge-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const channel of openChannels.splice(0)) await channel.close().catch(() => {});
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
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

describe('P3394 dual full-bridge process acceptance (C-06)', () => {
  it('两个独立进程的完整 Bridge 节点完成 CogSeed→CogSeed 任务闭环', async () => {
    const childPort = await freePort();
    const parentPort = await freePort();
    const childHome = path.join(tmpDir, 'child-agent-home');
    const resultFile = path.join(tmpDir, 'child-result.json');
    const fixture = path.join(process.cwd(), 'test', 'main', 'features', 'p3394_bridge', 'fixtures', 'bridge-node-child.ts');
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

    // Node B：独立进程启动完整桥节点。
    const child = spawn(process.execPath, [tsxCli, fixture], {
      env: {
        ...process.env,
        P3394_CHILD_PORT: String(childPort),
        P3394_CHILD_TOKEN: 'child-token',
        P3394_CHILD_AGENT_HOME: childHome,
        P3394_CHILD_RESULT: resultFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let childErr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { childErr += chunk; });
    let ready = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (chunk.includes('CHILD_READY')) ready = true; });
    await waitFor(() => ready || child.exitCode !== null, 15_000);
    expect(ready, 'child stderr: ' + childErr).toBe(true);

    // Node A：本进程完整桥节点（独立 Agent Home + HTTP listener/dialer）。
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'parent-node', display_name: 'ParentNode' }, manifest: manifestOf('parent-node') });
    bridge.registry.register({
      identity: { agent_id: 'child-node', display_name: 'ChildNode' },
      manifest: manifestOf('child-node'),
      endpoints: [`http://127.0.0.1:${childPort}`],
    });

    const parentChannel = new P3394HttpChannel('parent-http', {
      listen: { host: '127.0.0.1', port: parentPort },
      authToken: 'parent-token',
    });
    parentChannel.setLocalManifest(manifestOf('parent-node'));
    const replies: Array<Record<string, unknown>> = [];
    parentChannel.subscribe((envelope) => { replies.push(envelope as unknown as Record<string, unknown>); });
    await parentChannel.listen();
    openChannels.push(parentChannel);

    const dialer = new P3394HttpChannel('parent-dial', {
      dial: { endpoints: [`http://127.0.0.1:${childPort}`], bearerToken: 'child-token', expected_identity: 'child-node' },
    });
    openChannels.push(dialer);
    await dialer.dial('child-node');

    const messageId = 'msg-dual-1';
    const taskId = 'tsk-dual-1';
    await dialer.send({
      spec_version: 'p3394/1.0',
      message_id: messageId,
      session_id: 'ses-dual-1',
      task_id: taskId,
      kind: 'task',
      performative: 'request',
      sender: { agent_id: 'parent-node' },
      recipients: [{ agent_id: 'child-node' }],
      payload: { parts: [{ type: 'text', text: 'dual bridge task' }] },
      extensions: { reply_endpoint: `http://127.0.0.1:${parentPort}`, reply_token: 'parent-token' },
      idempotency_key: 'idem-dual-1',
    } as never);

    // B 自动回发 + 终态证据。
    await waitFor(() => replies.length >= 1);
    await waitFor(() => fs.existsSync(resultFile));
    const reply = replies[0];
    expect(reply.reply_to).toBe(messageId);
    expect((reply.sender as { agent_id?: string }).agent_id).toBe('child-node');
    expect(reply.session_id).toBe('ses-dual-1');

    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { status: string; session_id: string; task_id: string; agent_id: string };
    expect(result).toMatchObject({ status: 'completed', session_id: 'ses-dual-1', task_id: taskId, agent_id: 'child-node' });

    // Node B 的 Agent Home 独立存在：会话状态落盘在自己的 home。
    const sessionFiles = fs.readdirSync(path.join(childHome, 'sessions'));
    expect(sessionFiles.length).toBeGreaterThanOrEqual(1);

    const exitCode = await waitExit(child, 8000);
    expect(exitCode, 'child stderr: ' + childErr).toBe(0);
  }, 40_000);
});
