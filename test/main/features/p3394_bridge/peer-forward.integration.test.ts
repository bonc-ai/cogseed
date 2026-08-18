/**
 * P3394 peer-forward 真实集成测试（无 mock）：
 *
 *  - 真实 CogSeed Bridge（maybeStartP3394Bridge：真实 HTTP channel +
 *    真实持久化 registry + 真实 outbound hub + executor）
 *  - 两个真实 gateway.cjs 子进程（node-a / node-b），各自包装一个
 *    真实可执行 CLI 脚本（确定性输出）
 *  - 真实全链路：A 的 /p3394/call → 构造 forward_to 信封 → 真实 HTTP 发到
 *    Bridge → peer-forward 校验/转发 → 真实 HTTP 到 B 的 gateway → B 真实
 *    spawn CLI → 回复信封回发到 Bridge → outbound matcher → relay 回发到 A
 *    → A 的 replyWaiters 命中 → /p3394/call 返回 B 的回复文本
 *
 * 除 CLI 换成确定性脚本（真实 claude 模型调用见 scripts/test-p3394-real-e2e.cjs），
 * 其余全部为真实进程、真实 HTTP、真实注册表文件。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GATEWAY_SCRIPT = path.join(REPO_ROOT, 'p3394-gateway', 'gateway.cjs');
const VARIANT = 'p3394-fwd-int-' + Math.random().toString(36).slice(2, 8);
const BRIDGE_PORT = 18000 + Math.floor(Math.random() * 1000);
const BRIDGE_TOKEN = 'fwd-int-token';

let bridgeHandle: { close: () => Promise<void> } | null = null;
const children: ChildProcess[] = [];
let tmpDir = '';
let portA = 0;
let portB = 0;
let cliA = '';
let cliB = '';
let previousVariant: string | undefined;
let previousWorkspaceRoot: string | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
}

function getJson(url: string, timeoutMs = 3000): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

function postJson(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(JSON.stringify(body));
  });
}

async function waitHealth(port: number): Promise<boolean> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if ((await getJson(`http://127.0.0.1:${port}/p3394/health`)).status === 200) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function startGateway(port: number, agent: string, cli: string): ChildProcess {
  const env = {
    ...process.env,
    P3394_GATEWAY_PORT: String(port),
    P3394_GATEWAY_HOST: '127.0.0.1',
    P3394_ADVERTISE_ENDPOINT: `http://127.0.0.1:${port}`,
    P3394_GATEWAY_HOME: path.join(tmpDir, 'gw-' + agent),
    P3394_AGENT: agent,
    P3394_AGENT_ID: agent,
    P3394_AGENT_ALIAS: agent,
    P3394_AGENT_CLI: cli,
    P3394_AGENT_CLI_ARGS: '{message}',
    COGSEED_ENDPOINT: `http://127.0.0.1:${BRIDGE_PORT}`,
    COGSEED_TOKEN: BRIDGE_TOKEN,
    P3394_HEARTBEAT_MS: '5000',
    P3394_AGENT_TIMEOUT_MS: '30000',
  };
  const child = spawn(process.execPath, [GATEWAY_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', () => { /* keep pipe drained */ });
  child.stderr?.on('data', () => { /* keep pipe drained */ });
  children.push(child);
  return child;
}

beforeAll(async () => {
  previousVariant = process.env.ORKAS_RUNTIME_VARIANT;
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_RUNTIME_VARIANT = VARIANT;
  // paths.ts 要求：index.ts 启动时设置；测试环境需显式给出隔离工作区。
  process.env.ORKAS_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-fwd-ws-'));
  process.env.COGSEED_P3394_PORT = String(BRIDGE_PORT);
  process.env.COGSEED_P3394_TOKEN = BRIDGE_TOKEN;
  // 非 conversation 模式：走 mate-task runtime（测试确定性）。
  process.env.COGSEED_P3394_CONVERSATION = '0';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-fwd-int-'));
  // paths.ts / buildBridge 要求：激活一个真实用户（创建目录骨架）。
  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser('u-fwd-int-' + Math.random().toString(36).slice(2, 10));

  // 真实可执行 CLI 脚本（确定性输出）。
  cliA = path.join(tmpDir, 'cli-a.sh');
  cliB = path.join(tmpDir, 'cli-b.sh');
  fs.writeFileSync(cliA, '#!/bin/sh\necho "A-CLI received: $*"\n', { mode: 0o755 });
  fs.writeFileSync(cliB, '#!/bin/sh\necho "B-CLI received: $*"\n', { mode: 0o755 });

  // 真实 Bridge（async：监听失败换端口重试后返回 handle）。
  const { maybeStartP3394Bridge } = await import('../../../../src/main/features/p3394_bridge/app-wiring');
  bridgeHandle = await maybeStartP3394Bridge();

  [portA, portB] = [await freePort(), await freePort()];
  startGateway(portA, 'node-a', cliA);
  startGateway(portB, 'node-b', cliB);
});

afterAll(async () => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  await bridgeHandle?.close().catch(() => {});
  if (previousVariant === undefined) delete process.env.ORKAS_RUNTIME_VARIANT;
  else process.env.ORKAS_RUNTIME_VARIANT = previousVariant;
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  delete process.env.COGSEED_P3394_PORT;
  delete process.env.COGSEED_P3394_TOKEN;
  delete process.env.COGSEED_P3394_CONVERSATION;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', VARIANT), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('P3394 peer-forward real integration (no mocks)', () => {
  it('node A calls node B through the real bridge: /p3394/call → forward → execute → relay', async () => {
    expect(bridgeHandle).not.toBeNull();
    // 两个真实 gateway 进程健康。
    expect(await waitHealth(portA)).toBe(true);
    expect(await waitHealth(portB)).toBe(true);

    // 等两个节点 hello 注册进真实 registry 文件。
    const registryFile = path.join(os.homedir(), '.cogseed', 'runtime-variants', VARIANT, 'p3394-peers.json');
    const deadline = Date.now() + 15000;
    let bothRegistered = false;
    while (Date.now() < deadline && !bothRegistered) {
      try {
        const peers = JSON.parse(fs.readFileSync(registryFile, 'utf8')).peers ?? [];
        const a = peers.find((p: { identity: { agent_id: string } }) => p.identity.agent_id === 'node-a');
        const b = peers.find((p: { identity: { agent_id: string } }) => p.identity.agent_id === 'node-b');
        bothRegistered = !!a && !!b;
      } catch { /* not yet */ }
      if (!bothRegistered) await new Promise((r) => setTimeout(r, 400));
    }
    expect(bothRegistered).toBe(true);

    // 真实 /p3394/call：A 的 gateway 本地路由 → forward_to → Bridge 转发 → B 执行 → 回复回发。
    const call = await postJson(`http://127.0.0.1:${portA}/p3394/call`, { peer: 'node-b', message: 'hello from A' });
    expect(call.status).toBe(200);
    const parsed = JSON.parse(call.body) as { ok: boolean; peer?: string; reply?: string; error?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.peer).toBe('node-b');
    // B 的真实 CLI 脚本被真实 spawn 并回复。
    expect(parsed.reply).toContain('B-CLI received:');
  }, 60_000);
});
