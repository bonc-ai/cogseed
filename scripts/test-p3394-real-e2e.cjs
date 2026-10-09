#!/usr/bin/env node
/**
 * 真实环境端到端验证（无 mock）：真实 gateway.cjs + 真实 claude CLI 模型 +
 * 正在运行的真实 CogSeed 应用 Bridge。
 *
 * 前置条件：
 *  1. CogSeed 正在运行（Bridge 监听 127.0.0.1:8444，token 从
 *     ~/.cogseed/runtime-variants/cogseed/p3394-bridge.json 读取）
 *  2. 本机已安装并登录 claude CLI（真实模型调用）
 *
 * 运行：node scripts/test-p3394-real-e2e.cjs
 * （需要真实环境，不随 npm test 执行）
 */
/**
 * P3394 真实环境端到端验证（无任何 mock）：
 *  1. 用真实 gateway.cjs 启动真实 claude 托管网关（真实 CLI 二进制）
 *  2. gateway hello 注册进【正在运行的真实 CogSeed 应用 Bridge】(127.0.0.1:8444)
 *  3. 外部节点向 gateway 发真实 UMF 信封 → 真实 claude 模型执行 → 回复回发
 *  4. 打印结构化证据（注册表、回复文本、回发路由）
 */
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveE2eBin, cogseedStateFilePath, readCogseedBridgeToken } = require('./p3394-e2e-common.cjs');

const COGSEED_ENDPOINT = 'http://127.0.0.1:8444';
const COGSEED_TOKEN = readCogseedBridgeToken();
const REGISTRY_FILE = cogseedStateFilePath('p3394-peers.json');
const GATEWAY_HOME = path.join(os.tmpdir(), 'p3394-real-e2e-' + Date.now());
const claudeBin = resolveE2eBin('claude', { envKey: 'COGSEED_E2E_CLAUDE_BIN', macDefault: '/opt/homebrew/bin/claude' });

if (process.argv.includes('--list-bin')) {
  console.log(claudeBin || '(not found)');
  process.exit(claudeBin ? 0 : 1);
}

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : '')); };

function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

function postJson(url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request(u, { method: 'POST', headers, timeout: 120000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(JSON.stringify(body));
  });
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await getJson(`http://127.0.0.1:${port}/p3394/health`);
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

async function main() {
  const gatewayScript = path.resolve(__dirname, '..', 'p3394-gateway', 'gateway.cjs');
  record('gateway.cjs 存在', fs.existsSync(gatewayScript), gatewayScript);
  record('真实 claude CLI 存在', !!claudeBin, claudeBin || '未找到，可通过 COGSEED_E2E_CLAUDE_BIN 指定');
  if (!claudeBin) {
    console.error('未找到 claude CLI。请安装并登录 claude，或设置 COGSEED_E2E_CLAUDE_BIN 为 claude 绝对路径。');
    process.exit(1);
  }

  const gatewayPort = await freePort();
  const replyPort = await freePort();

  const env = {
    ...process.env,
    P3394_GATEWAY_PORT: String(gatewayPort),
    P3394_GATEWAY_HOST: '127.0.0.1',
    P3394_ADVERTISE_ENDPOINT: `http://127.0.0.1:${gatewayPort}`,
    P3394_GATEWAY_HOME: GATEWAY_HOME,
    P3394_AGENT: 'claude',
    P3394_AGENT_ID: 'claude',
    P3394_AGENT_ALIAS: 'ClaudeCode-RealE2E',
    P3394_AGENT_CLI: claudeBin,
    COGSEED_ENDPOINT,
    COGSEED_TOKEN,
    P3394_HEARTBEAT_MS: '5000',
    P3394_AGENT_TIMEOUT_MS: '120000',
  };
  const gw = spawn(process.execPath, [gatewayScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let gwOut = '';
  gw.stdout.on('data', (c) => { gwOut += c; });
  gw.stderr.on('data', (c) => { gwOut += c; });

  // ── 2. 真实 health 探测（不依赖 registry 残留）──
  const healthy = await waitHealth(gatewayPort, 15000);
  record('真实 gateway 进程监听并响应 health', healthy, `127.0.0.1:${gatewayPort}`);
  if (!healthy) { console.error('gateway 日志:\n' + gwOut.slice(-2000)); gw.kill('SIGKILL'); process.exit(2); }

  // ── 3. 等 hello 注册写入真实应用 registry ──
  const deadline = Date.now() + 15000;
  let registered = false;
  while (Date.now() < deadline && !registered) {
    try {
      const peers = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      const claude = (peers.peers || []).find((p) => p.identity.agent_id === 'claude');
      if (claude && (claude.endpoints || []).some((e) => e.includes(String(gatewayPort)))) registered = true;
    } catch { /* registry not yet written */ }
    if (!registered) await new Promise((r) => setTimeout(r, 400));
  }
  record('真实 gateway hello 注册进真实应用 Bridge', registered, `claude@127.0.0.1:${gatewayPort}`);

  // ── 4. 真实外部节点 → gateway → 真实 claude 模型 → 回复回发 ──
  const replyListener = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const env2 = parsed.envelope || {};
        const replyText = (env2.payload?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
        global.replyReceived = { reply_to: env2.reply_to, task_id: env2.task_id, text: replyText };
      } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => replyListener.listen(replyPort, '127.0.0.1', r));

  const nonce = crypto.randomBytes(4).toString('hex');
  const envelope = {
    spec_version: 'p3394/1.0',
    message_id: 'msg-real-' + nonce,
    session_id: 'ses-real-' + nonce,
    task_id: 'tsk-real-' + nonce,
    kind: 'task',
    performative: 'request',
    role: 'requester',
    sender: { agent_id: 'real-external-node' },
    recipients: [{ agent_id: 'claude' }],
    payload: { parts: [{ type: 'text', text: 'Reply with exactly: P3394-REAL-E2E-OK' }] },
    extensions: { reply_endpoint: `http://127.0.0.1:${replyPort}`, reply_token: 'reply-token' },
    idempotency_key: 'idem-real-' + nonce,
  };
  const sendResult = await postJson(`http://127.0.0.1:${gatewayPort}/p3394/envelope`, { envelope });
  record('信封送达真实 gateway', sendResult.status === 200, 'HTTP ' + sendResult.status);

  const replyDeadline = Date.now() + 120000;
  while (Date.now() < replyDeadline && !global.replyReceived) await new Promise((r) => setTimeout(r, 500));
  const replyText = global.replyReceived?.text || '';
  record('真实 claude 模型回复经回发路由送达', !!global.replyReceived && replyText.includes('P3394-REAL-E2E-OK'), (global.replyReceived?.text || '(无回复)').slice(0, 120));
  record('回复携带原 message 关联 (reply_to)', global.replyReceived?.reply_to === envelope.message_id, `reply_to=${global.replyReceived?.reply_to}`);

  // ── 5. 清理 ──
  gw.kill('SIGTERM');
  replyListener.close();
  try { fs.rmSync(GATEWAY_HOME, { recursive: true, force: true }); } catch { /* best effort */ }

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 真实环境端到端结果 =====');
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) console.log('失败: ' + failed.map((f) => f.name).join(', '));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('E2E 脚本失败:', err); process.exit(2); });
