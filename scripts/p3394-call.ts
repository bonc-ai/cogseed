#!/usr/bin/env tsx
/**
 * p3394:call — 直接唤起本地 P3394 智能体，无需 CogSeed 配置模型 API。
 *
 * 行为：把一条任务消息直接发给本机某 CLI 的 P3394 网关（Claude Code /
 * Codex / OpenCode / OpenClaw / Hermes / WorkBuddy），本地收回复并打印。
 * 本地 CLI 使用自己账号/API key 运行——完全不经过 CogSeed 的模型与
 * Commander，CogSeed 没配任何 API key 也能用。
 *
 * 网关来源（按优先级）：
 *   1. 已在跑（真实 CogSeed 的 p3394-peers.json 里的节点端点）→ 直接复用；
 *   2. 否则按"独立模式"就地起一个网关子进程（纯本地、不回 CogSeed），
 *      用自本地 reply server 收集回复；任务结束即退出。
 *
 * 用法：
 *   npm run p3394:call -- hermes "帮我总结今天的任务"
 *   npm run p3394:call -- --cli codex --message "……" [--timeout 120] [--json]
 *   P3394_GATEWAY_TOKEN=xxx（若目标网关配置了入站鉴权令牌）
 *
 * 退出码：0 成功（打印回复）；1 参数/环境错误；2 超时；3 CLI 执行失败。
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const VARIANT = process.env.COGSEED_RUNTIME_VARIANT || process.env.COGSEED_SOURCE_RUNTIME_VARIANT || 'cogseed';
const VARIANT_ROOT = path.join(os.homedir(), '.cogseed', 'runtime-variants', VARIANT);
// logger/paths 依赖 COGSEED_WORKSPACE_ROOT；脚本默认落在真实 variant。
process.env.COGSEED_WORKSPACE_ROOT = process.env.COGSEED_WORKSPACE_ROOT || VARIANT_ROOT;

const GATEWAY_SCRIPT = path.resolve(__dirname, '..', 'p3394-gateway', 'gateway.cjs');
const MAX_REPLY_BYTES = 32768;

interface P3394CallOptions {
  cli: string;
  message: string;
  timeoutMs: number;
  json: boolean;
  gatewayToken: string;
}

function parseArgs(argv: string[]): P3394CallOptions | null {
  let cli = '';
  let message = '';
  let timeoutMs = 120_000;
  let json = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cli' || a === '-c') { cli = argv[++i] || ''; continue; }
    if (a === '--message' || a === '-m') { message = argv[++i] || ''; continue; }
    if (a === '--timeout') { const n = Number(argv[++i]); if (Number.isFinite(n) && n > 0) timeoutMs = n * 1000; continue; }
    if (a === '--json') { json = true; continue; }
    if (a.startsWith('-')) return null;
    positional.push(a);
  }
  if (!cli && positional.length > 0) cli = positional.shift() || '';
  if (!message && positional.length > 0) message = positional.shift() || '';
  if (!cli || !message.trim()) return null;
  return { cli: cli.trim(), message: message.trim(), timeoutMs, json, gatewayToken: process.env.P3394_GATEWAY_TOKEN || '' };
}

function peersFile(): string { return path.join(VARIANT_ROOT, 'p3394-peers.json'); }
function endpointPort(endpoint: string): number {
  try { const p = Number(new URL(endpoint).port); return p > 0 ? p : 0; } catch { return 0; }
}

async function runningPeerEndpoint(cli: string): Promise<{ endpoint: string; port: number } | null> {
  try {
    const data = JSON.parse(fs.readFileSync(peersFile(), 'utf8')) as { peers?: Array<{ identity?: { agent_id?: string }; endpoints?: string[] }> };
    const peer = (data.peers || []).find((p) => p.identity?.agent_id === cli);
    const ep = peer?.endpoints?.[0];
    if (typeof ep === 'string' && ep) {
      const port = endpointPort(ep);
      if (port > 0) return { endpoint: ep, port };
    }
  } catch { /* absent */ }
  return null;
}

async function detectBin(cli: string): Promise<string | null> {
  try {
    const { detectOne } = await import('../src/main/features/local_agents/registry');
    const found = await detectOne(cli as never);
    return found?.path || null;
  } catch { return null; }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = netServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}
function netServer(): http.Server { return http.createServer(); }

/** 独立模式：不经 CogSeed 直接起目标 CLI 的网关子进程（纯本地）。 */
async function startStandaloneGateway(cli: string): Promise<{ port: number; child: ChildProcess } | { error: string }> {
  if (!fs.existsSync(GATEWAY_SCRIPT)) return { error: 'gateway script missing: ' + GATEWAY_SCRIPT };
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-call-'));
  const bin = (await detectBin(cli)) || undefined;
  const env = {
    ...process.env as Record<string, string>,
    COGSEED_ENDPOINT: 'http://127.0.0.1:1', // 独立模式不回 CogSeed；回发走脚本 reply server
    P3394_AGENT: cli,
    P3394_AGENT_ID: cli,
    P3394_AGENT_ALIAS: cli,
    P3394_GATEWAY_PORT: String(port),
    P3394_GATEWAY_HOST: '127.0.0.1',
    P3394_GATEWAY_HOME: home,
    P3394_ADVERTISE_ENDPOINT: 'http://127.0.0.1:' + port,
    P3394_HEARTBEAT_MS: '0',
    ...(bin ? { P3394_AGENT_CLI: bin } : {}),
  };
  const child = spawn(process.execPath, [GATEWAY_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // 等健康检查
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { error: 'gateway exited early (exit ' + child.exitCode + ')' };
    }
    const healthy = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/p3394/health', timeout: 800 }, (res) => {
        res.resume(); resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (healthy) { child.removeAllListeners(); return { port, child }; }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill('SIGTERM');
  return { error: 'gateway health timeout on port ' + port };
}

function postTask(port: number, cli: string, message: string, token: string, replyPort: number): Promise<void> {
  const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const envelope = {
    spec_version: 'p3394/1.0',
    message_id: 'msg-call-' + nonce,
    session_id: 'ses-call-' + nonce,
    task_id: 'tsk-call-' + nonce,
    kind: 'task',
    performative: 'request',
    role: 'requester',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: cli }],
    payload: { parts: [{ type: 'text', text: message.slice(0, 20000) }] },
    extensions: { reply_endpoint: 'http://127.0.0.1:' + replyPort, reply_token: 'none' },
    idempotency_key: 'idem-call-' + nonce,
  };
  const body = JSON.stringify({ envelope });
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, path: '/p3394/envelope', method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode === 401) reject(new Error('目标网关需要鉴权令牌（401）。请设置 P3394_GATEWAY_TOKEN。'));
        else if (res.statusCode !== 200) reject(new Error('gateway accepted failed: HTTP ' + res.statusCode + ' ' + d.slice(0, 200)));
        else resolve();
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function collectReply(port: number, timeoutMs: number): Promise<{ text: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const env = JSON.parse(body).envelope;
          const text = (env.payload?.parts || []).map((p: { text?: string }) => p.text || '').join('').trim().slice(0, MAX_REPLY_BYTES);
          res.writeHead(200); res.end('{}');
          server.close();
          resolve({ text: text || '(空回复)', sessionId: String(env.session_id || '') });
        } catch (e) {
          res.writeHead(200); res.end('{}');
          reject(new Error('reply parse failed: ' + (e as Error).message));
        }
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    setTimeout(() => { server.close(); reject(new Error('timeout waiting for reply')); }, timeoutMs);
  });
}

function portHealthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/p3394/health', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error('用法：p3394:call <cli> "<消息>" | --cli <cli> --message "<消息>" [--timeout 秒] [--json]');
    return 1;
  }
  const replyPort = await freePort();

  // 1) 优先复用已在跑的网关（真实 CogSeed peers；仅用于定位端点，不经 CogSeed 模型）。
  //    stale 节点（进程已死但 peers 残留）用 health 探测剔除。
  const running = await runningPeerEndpoint(opts.cli);
  let port = (running && await portHealthy(running.port)) ? running.port : 0;

  // 2) 没有可用网关 → 独立模式就地起一个（彻底脱离 CogSeed 应用）。
  let standalone: { child: ChildProcess } | null = null;
  if (!port) {
    const started = await startStandaloneGateway(opts.cli);
    if ('error' in started) {
      console.error('无法唤起 ' + opts.cli + '：' + started.error + '。请先在 CogSeed 接入该 Agent（外接 tab）或确认 CLI 已安装。');
      return 1;
    }
    port = started.port;
    standalone = { child: started.child };
  }

  try {
    await postTask(port, opts.cli, opts.message, opts.gatewayToken, replyPort);
    const reply = await collectReply(replyPort, opts.timeoutMs);
    if (opts.json) console.log(JSON.stringify({ ok: true, cli: opts.cli, reply: reply.text, session_id: reply.sessionId }));
    else console.log(reply.text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('timeout waiting')) {
      console.error('[p3394:call] 超时：' + opts.cli + ' 在 ' + Math.round(opts.timeoutMs / 1000) + 's 内未回复。');
      return 2;
    }
    console.error('[p3394:call] 调用失败：' + message);
    return 3;
  } finally {
    if (standalone) { try { standalone.child.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('[p3394:call] 未预期错误：', error && (error.stack || error.message || String(error)));
  process.exit(3);
});
