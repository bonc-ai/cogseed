/**
 * 真机修复总结 E-01 / E-03 的端到端验证：真 gateway 进程 + 假 codex app-server。
 *
 * 真机现象（2026-09-23，另一台 macOS）：
 *   E-01 `[p3394_gateway_error] {"detail":"The 'gpt-6-sol' model is not supported
 *        when using Codex with a ChatGPT account."}` —— config.toml 里的模型名写错
 *        一处，等 114 秒才回一段原始报文，用户无从知道有效名（复现 ≥3 次）。
 *   E-03 改完 config.toml 重试**仍报 E-01 原文**：网关 21:07 拉起的常驻
 *        app-server 内存里是旧配置，文件改动到不了它——真机上只能手工 kill 掉
 *        pid 33550 才生效。
 *
 * 这里把两件事都做成可重复的验收：假 app-server 每次启动写一行 pid + 读当时的
 * config.toml，回复里带上 `pid=` / `model=`，于是"配置有没有真的生效"变成可断言
 * 的事实（新 pid + 新 model），而不是靠人手 kill。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GATEWAY = path.join(process.cwd(), 'p3394-gateway', 'gateway.cjs');
const TOKEN = 'codex-reload-token';

let tmpDir: string;
const children: ChildProcess[] = [];
const servers: http.Server[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-codex-reload-'));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 假 codex app-server：真 gateway 会把它当成 `codex app-server --stdio` 拉起。 */
const FAKE_APP_SERVER = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const home = process.env.CODEX_HOME || path.join(process.env.HOME || '/tmp', '.codex');
fs.appendFileSync(path.join(home, 'app-server-starts.log'), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\\n');
const callLog = path.join(home, 'app-server-calls.log');
function currentModel() {
  try {
    const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const m = /^\\s*model\\s*=\\s*"([^"]+)"/m.exec(text);
    return m ? m[1] : '';
  } catch { return ''; }
}
const threads = new Map();
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let seq = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method) fs.appendFileSync(callLog, msg.method + '\\n');
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex' } }); return; }
  if (msg.method === 'initialized') return;
  // app-server 自己披露的清单：与 models_cache.json 可以不同（真机上就有
  // "缓存里有、账户实际不支持" 的模型）。
  if (msg.method === 'model/providers') {
    send({ jsonrpc: '2.0', id: msg.id, result: { providers: [{ id: 'chatgpt', models: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-luna' }] }] } });
    return;
  }
  if (msg.method === 'thread/start') {
    seq += 1;
    const threadId = 'thread-' + process.pid + '-' + seq;
    threads.set(threadId, (msg.params && msg.params.model) || currentModel());
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === 'thread/resume') {
    const threadId = (msg.params && msg.params.threadId) || ('resumed-' + process.pid);
    threads.set(threadId, currentModel());
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === 'turn/start') {
    const threadId = msg.params && msg.params.threadId;
    const model = threads.has(threadId) ? threads.get(threadId) : currentModel();
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    const delayMs = Number(process.env.FAKE_TURN_DELAY_MS || 0);
    const complete = () => {
      if (model === 'gpt-5.5') {
        // 真机 E-01 原文：模型层在**轮次内**才拒（清单里有、账户不给用）。
        send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { status: 'failed', error: { message: "The '" + model + "' model is not supported when using Codex with a ChatGPT account." } } } });
        return;
      }
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'FAKE_OK pid=' + process.pid + ' model=' + model }] } } });
    };
    if (delayMs > 0) setTimeout(complete, delayMs); else complete();
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`;

function writeFile(relative: string, content: string, mode?: number) {
  const target = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode) fs.chmodSync(target, mode);
  return target;
}

function codexHome(): string {
  const home = path.join(tmpDir, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else reject(new Error('no port'));
    });
  });
}

/** 假 CogSeed 端点：收网关回发的 reply 信封（postReply → /p3394/envelope）。 */
async function startFakeCogseed() {
  const replies: string[] = [];
  const waiters: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      try {
        const parsed = JSON.parse(body) as { envelope?: { role?: string; payload?: { parts?: Array<{ text?: string }> } } };
        const envelope = parsed.envelope;
        if (!envelope || envelope.role !== 'responder') return;
        const text = (envelope.payload?.parts ?? []).map((part) => part.text || '').join('');
        replies.push(text);
        for (const wake of waiters.splice(0)) wake();
      } catch { /* hello 等非回信体：忽略 */ }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    replies,
    async waitForReply(index: number, timeoutMs = 20_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (replies.length <= index) {
        if (Date.now() > deadline) throw new Error(`reply #${index} timeout; got ${JSON.stringify(replies)}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
      return replies[index];
    },
  };
}

async function spawnGateway(opts: { codexHome: string; appServer: string; cogseedEndpoint: string; extraEnv?: Record<string, string> }) {
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      ...(opts.extraEnv || {}),
      P3394_GATEWAY_PORT: String(port),
      P3394_GATEWAY_HOST: '127.0.0.1',
      P3394_ADVERTISE_ENDPOINT: `http://127.0.0.1:${port}`,
      P3394_GATEWAY_TOKEN: TOKEN,
      P3394_GATEWAY_HOME: path.join(tmpDir, 'gateway-home'),
      COGSEED_ENDPOINT: opts.cogseedEndpoint,
      COGSEED_TOKEN: TOKEN,
      P3394_HEARTBEAT_MS: '0',
      P3394_AGENT: 'codex',
      P3394_AGENT_ID: 'codex',
      P3394_AGENT_ALIAS: 'Codex',
      P3394_CODEX_APP_SERVER: opts.appServer,
      CODEX_HOME: opts.codexHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { output += chunk; });
  // 就绪判据：/p3394/health 可答（网关已 listen）。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/p3394/health`);
      if (response.ok) break;
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { port, output: () => output };
}

/** 发一条 P3394 任务信封（真机链路里由 CogSeed 桥发出）。 */
async function sendTask(port: number, text: string, tag: string) {
  const body = JSON.stringify({
    envelope: {
      spec_version: 'p3394/1.0',
      message_id: `msg-${tag}`,
      session_id: 'session-e2e',
      idempotency_key: `idem-${tag}`,
      kind: 'message',
      performative: 'request',
      role: 'initiator',
      sender: { agent_id: 'cogseed' },
      recipients: [{ agent_id: 'codex' }],
      payload: { parts: [{ type: 'text', text }] },
    },
  });
  const response = await fetch(`http://127.0.0.1:${port}/p3394/envelope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body,
  });
  expect(response.ok, `envelope accepted (${response.status})`).toBe(true);
}

function readStarts(home: string): Array<{ pid: number }> {
  try {
    return fs.readFileSync(path.join(home, 'app-server-starts.log'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number });
  } catch { return []; }
}

function readCalls(home: string): string[] {
  try {
    return fs.readFileSync(path.join(home, 'app-server-calls.log'), 'utf8').split('\n').filter(Boolean);
  } catch { return []; }
}

const MODELS_CACHE = JSON.stringify({ models: [
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol' },
  { slug: 'gpt-5.6-terra' },
  { slug: 'gpt-5.6-luna' },
  { slug: 'gpt-5.5' },
  { slug: 'gpt-reserve', hidden: true },
] });

describe('codex app-server config reload end-to-end (E-03)', () => {
  it('picks up a config.toml model change by restarting the resident app-server', async () => {
    const home = codexHome();
    writeFile('codex-home/config.toml', 'model = "gpt-5.6-sol"\n');
    writeFile('codex-home/models_cache.json', MODELS_CACHE);
    const appServer = writeFile('fake-codex-app-server', FAKE_APP_SERVER, 0o755);
    const cogseed = await startFakeCogseed();
    const gateway = await spawnGateway({ codexHome: home, appServer, cogseedEndpoint: cogseed.endpoint });

    await sendTask(gateway.port, '第一轮', 'first');
    const first = await cogseed.waitForReply(0);
    expect(first, gateway.output()).toContain('FAKE_OK');
    expect(first).toContain('model=gpt-5.6-sol');
    const firstPid = /pid=(\d+)/.exec(first)?.[1];
    expect(firstPid).toBeTruthy();

    // 真机 F-01 的动作：改 config.toml（用户改模型/供应商）。mtime 必须变化。
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-luna"\n');
    expect(readStarts(home)).toHaveLength(1);

    await sendTask(gateway.port, '第二轮', 'second');
    const second = await cogseed.waitForReply(1);
    // 手工 kill 的那一步现在由网关自己做：新 app-server 读新配置，回复自报新模型。
    expect(second, gateway.output()).toContain('model=gpt-5.6-luna');
    const secondPid = /pid=(\d+)/.exec(second)?.[1];
    expect(secondPid).toBeTruthy();
    expect(secondPid).not.toBe(firstPid);
    expect(readStarts(home)).toHaveLength(2);
    // 会话连续性不受换进程影响：新进程按盘上 cli-session.json 走 thread/resume。
    expect(readCalls(home)).toContain('thread/resume');
  }, 60_000);

  it('waits for an in-flight turn before swapping the app-server', async () => {
    const home = codexHome();
    writeFile('codex-home/config.toml', 'model = "gpt-5.6-sol"\n');
    writeFile('codex-home/models_cache.json', MODELS_CACHE);
    const appServer = writeFile('fake-codex-app-server', FAKE_APP_SERVER, 0o755);
    const cogseed = await startFakeCogseed();
    const gateway = await spawnGateway({
      codexHome: home, appServer, cogseedEndpoint: cogseed.endpoint,
      // 让第一轮停在途：配置恰好在这一轮进行中被改。
      extraEnv: { FAKE_TURN_DELAY_MS: '1500' },
    });

    await sendTask(gateway.port, '在途轮次', 'inflight');
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-luna"\n');
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 用户正在等的回答先用旧配置跑完，绝不半路换进程（否则这一轮直接失败）。
    expect(readStarts(home), gateway.output()).toHaveLength(1);

    const first = await cogseed.waitForReply(0);
    expect(first).toContain('model=gpt-5.6-sol');
    await sendTask(gateway.port, '第二轮', 'after-inflight');
    const second = await cogseed.waitForReply(1);
    // 轮次结束后才换：第二轮已经用新配置。
    expect(second).toContain('model=gpt-5.6-luna');
    expect(readStarts(home)).toHaveLength(2);
  }, 60_000);
});

describe('codex unknown model diagnosis end-to-end (E-01)', () => {
  it('fails fast with the available models instead of spending a turn (config.toml typo)', async () => {
    const home = codexHome();
    writeFile('codex-home/config.toml', 'model = "gpt-6-sol"\n');
    writeFile('codex-home/models_cache.json', MODELS_CACHE);
    const appServer = writeFile('fake-codex-app-server', FAKE_APP_SERVER, 0o755);
    const cogseed = await startFakeCogseed();
    const gateway = await spawnGateway({ codexHome: home, appServer, cogseedEndpoint: cogseed.endpoint });

    await sendTask(gateway.port, '你好', 'typo');
    const reply = await cogseed.waitForReply(0);
    // 网关把它当**执行失败**回（MA-01 的错误信语义），且给出可照做的模型名。
    expect(reply).toContain('[p3394_gateway_error]');
    expect(reply).toContain('p3394_codex_model_unsupported: gpt-6-sol');
    expect(reply).toContain('gpt-5.6-sol');
    expect(reply).toContain('config.toml');
    // 关键：没有为一次注定失败的轮次花掉 thread/start（真机是等 114 秒后失败）。
    expect(readCalls(home)).not.toContain('thread/start');
  }, 60_000);

  it('turns an in-turn account rejection into the same actionable error', async () => {
    const home = codexHome();
    // gpt-5.5 在本机缓存里（快检放行），但 app-server/账户不支持 → 轮次内才被拒。
    writeFile('codex-home/config.toml', 'model = "gpt-5.5"\n');
    writeFile('codex-home/models_cache.json', MODELS_CACHE);
    const appServer = writeFile('fake-codex-app-server', FAKE_APP_SERVER, 0o755);
    const cogseed = await startFakeCogseed();
    const gateway = await spawnGateway({ codexHome: home, appServer, cogseedEndpoint: cogseed.endpoint });

    await sendTask(gateway.port, '你好', 'in-turn');
    const reply = await cogseed.waitForReply(0);
    expect(reply).toContain('[p3394_gateway_error]');
    expect(reply).toContain('p3394_codex_model_unsupported: gpt-5.5');
    expect(reply).toContain('gpt-5.6-luna');
    // 原始报文保留在尾部，便于排查（用户看到的是可用模型而不是原始 JSON-RPC）。
    expect(reply).toContain('is not supported when using Codex with a ChatGPT account');
  }, 60_000);
});
