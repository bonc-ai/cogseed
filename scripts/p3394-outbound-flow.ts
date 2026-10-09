#!/usr/bin/env tsx
/**
 * P3394 主流程真机验证（CogSeed 先发 → 对端装包上线即注册 → 互相通信）。
 *
 * 场景复现：
 *  1. CogSeed 主动给一个尚未接入的节点发消息 → 出站失败并给出接入指引
 *     （"CogSeed 先发消息"的首触步骤）；
 *  2. 对端安装并启动 p3394-gateway（下面用真实 hermes CLI）→ 启动 hello
 *     信封向 CogSeed 自报 agent_id / alias / 本端地址 → CogSeed 自动注册；
 *  3. CogSeed 再次发送 → 网关把消息交给真实 hermes 模型 → 回信按 session
 *     匹配返回给调用方。
 *
 * 使用（在仓库根目录，需本机已装 hermes CLI）：
 *   npx tsx scripts/p3394-outbound-flow.ts
 *
 * 所有端口/工作区均为一次性临时值，不触碰运行中的 CogSeed 实例。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-outbound-verify-'));
process.env.COGSEED_WORKSPACE_ROOT = WORK;
// 独立运行时变体：桥接状态/令牌/会话全部落在一次性目录，不触碰任何真实实例。
process.env.COGSEED_RUNTIME_VARIANT = 'p3394-verify-' + fs.mkdtempSync(path.join(os.tmpdir(), 'v-')).split(path.sep).pop();
process.env.COGSEED_P3394_PORT = '18555';

const GATEWAY_PORT = 19055;
const PEER_ID = 'hermes-verify';
const PEER_ALIAS = 'Hermes 验证节点';
const COGSEED_ENDPOINT = 'http://127.0.0.1:18555';

function log(label: string, text: string): void {
  process.stdout.write('[' + label + '] ' + text.slice(0, 500) + '\n');
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error('ASSERT FAILED: ' + message);
}

async function waitFor(probe: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('timeout waiting for: ' + label);
}

async function main(): Promise<void> {
  const { activateUser } = await import('../src/main/features/users');
  activateUser('p3394-verify-user');

  const { maybeStartP3394Bridge, getP3394BridgeInfo, stopP3394Bridge } =
    await import('../src/main/features/p3394_bridge/app-wiring');
  const { runP3394HostTool } =
    await import('../src/main/features/cogseed_backend/p3394-host-adapter');

  const bridge = maybeStartP3394Bridge();
  assert(bridge, 'CogSeed bridge failed to start');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const info = getP3394BridgeInfo();
  assert(info, 'bridge info missing');
  log('bridge', 'up on ' + info.endpoint + ' (workspace: ' + WORK + ')');

  // ── 第 1 步：CogSeed 先发消息，对端尚未接入 ──
  const first = await runP3394HostTool(
    { peer: PEER_ID, message: '你好，请接入 P3394 后回我一句话。' },
    { userId: 'p3394-verify-user', sourceKey: 'verify-step-1' },
  );
  assert(
    first.isError && first.content.includes('E_P3394_SEND_FAILED'),
    'step 1 must fail with guidance, got: ' + first.content.slice(0, 200),
  );
  log('step1', 'CogSeed 先发 → 节点未接入，返回指引：' + first.content.slice(0, 180));

  // ── 第 2 步：对端装包启动（真实 hermes CLI），hello 自注册 ──
  const gateway = spawn('node', [path.join(__dirname, '..', 'p3394-gateway', 'gateway.cjs')], {
    env: {
      ...process.env,
      PATH: process.env.PATH + ':' + path.join(os.homedir(), '.local/bin'),
      P3394_GATEWAY_PORT: String(GATEWAY_PORT),
      P3394_AGENT: 'hermes',
      P3394_AGENT_ID: PEER_ID,
      P3394_AGENT_ALIAS: PEER_ALIAS,
      COGSEED_ENDPOINT,
      COGSEED_TOKEN: info.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gatewayLog = '';
  gateway.stdout.on('data', (chunk) => { gatewayLog += String(chunk); });
  gateway.stderr.on('data', (chunk) => { gatewayLog += String(chunk); });
  await waitFor(() => gatewayLog.includes('registered with CogSeed'), 15000, 'gateway hello registration');
  const registered = gatewayLog.match(/registered with CogSeed: (\d+)/);
  log('step2', '对端网关启动，hello 注册 ' + (registered ? registered[1] : '?'));

  // ── 第 3 步：CogSeed 再次发送，真实 hermes 回答 ──
  const second = await runP3394HostTool(
    { peer: PEER_ID, message: '请只回复一句话：你好，我是 Hermes。' },
    { userId: 'p3394-verify-user', sourceKey: 'verify-step-3' },
  );
  log('step3', 'CogSeed 重发 → 收到回复：' + second.content.slice(0, 300));
  assert(!second.isError && second.content.includes('"ok"'), 'step 3 must succeed, got: ' + second.content.slice(0, 300));

  // ── 第 4 步：多轮会话保持同一 Session ID（指南 §5.2 验收项） ──
  const third = await runP3394HostTool(
    { peer: PEER_ID, message: '第二句话：请再回复一句。' },
    { userId: 'p3394-verify-user', sourceKey: 'verify-step-4' },
  );
  assert(!third.isError, 'step 4 must succeed');
  const sessionsFile = path.join(os.homedir(), '.cogseed', 'runtime-variants', process.env.COGSEED_RUNTIME_VARIANT || '', 'p3394-sessions.json');
  const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  const bindings = Object.values(sessions.sessions as Record<string, string>);
  assert(bindings.length === 1, 'multi-turn collaboration must reuse ONE session per (scope, peer), got ' + bindings.length);
  log('step4', '多轮会话复用同一 Session：' + bindings[0]);

  // ── 第 5 步：§12 Outbox 状态机 + 失败记录 ──
  gateway.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const failed = await runP3394HostTool(
    { peer: PEER_ID, message: '网关已停，这次应该投递失败。' },
    { userId: 'p3394-verify-user', sourceKey: 'verify-step-5' },
  );
  assert(failed.isError, 'step 5 must fail (gateway down)');
  const outboxFile = path.join(os.homedir(), '.cogseed', 'runtime-variants', process.env.COGSEED_RUNTIME_VARIANT || '', 'p3394-outbox.jsonl');
  const outboxRaw = fs.readFileSync(outboxFile, 'utf8');
  const statuses = outboxRaw.split('\n').filter((line) => line.includes('"status"')).map((line) => (JSON.parse(line) as { status: string }).status);
  assert(statuses.includes('submitted') && statuses.includes('sent') && statuses.includes('completed') && statuses.includes('failed'), 'outbox must show submitted/sent/completed/failed lifecycle, got: ' + statuses.join(','));
  log('step5', 'Outbox 状态机落盘（submitted→sent→completed，失败标记 failed）：' + [...new Set(statuses)].join(' → '));

  await stopP3394Bridge();
  log('PASS', 'CogSeed 先发 → 对端注册 → 互通（多轮同 Session）→ Outbox 状态机：全流程通过');
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write('[FAIL] ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(1);
});
