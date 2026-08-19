#!/usr/bin/env node
/**
 * 真实 codex 端到端验证（无 mock）：真实 gateway.cjs + 真实 codex CLI
 * (ChatGPT.app app-server / exec) + 真实应用 Bridge。
 * 前置：CogSeed 运行中（8444）+ ChatGPT.app 已装 codex。
 */
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const COGSEED_ENDPOINT = 'http://127.0.0.1:8444';
const COGSEED_TOKEN = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', 'cogseed', 'p3394-bridge.json'), 'utf8')).token;
const CODEKEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const GATEWAY_SCRIPT = path.resolve(__dirname, '..', 'p3394-gateway', 'gateway.cjs');

function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function getJson(url, t = 3000) { return new Promise((res) => { const r = http.get(url, { timeout: t }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ s: x.statusCode, d })); }); r.on('error', () => res({ s: 0, d: '' })); r.on('timeout', () => { r.destroy(); res({ s: 0, d: '' }); }); }); }
function postJson(url, body, token) { return new Promise((resolve, reject) => { const u = new URL(url); const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token; const r = http.request(u, { method: 'POST', headers: h, timeout: 120000 }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => resolve({ s: x.statusCode, d })); }); r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end(JSON.stringify(body)); }); }

async function main() {
  const gwPort = await freePort();
  const replyPort = await freePort();
  const results = [];
  const mark = (n, ok, d) => { results.push(ok); console.log((ok ? '✓ ' : '✗ ') + n + (d ? ' — ' + d : '')); };
  mark('codex 二进制存在', fs.existsSync(CODEKEX), CODEKEX);

  const env = { ...process.env,
    P3394_GATEWAY_PORT: String(gwPort), P3394_GATEWAY_HOST: '127.0.0.1',
    P3394_ADVERTISE_ENDPOINT: `http://127.0.0.1:${gwPort}`,
    P3394_GATEWAY_HOME: path.join(os.tmpdir(), 'p3394-codex-e2e-' + Date.now()),
    P3394_AGENT: 'codex', P3394_AGENT_ID: 'codex', P3394_AGENT_ALIAS: 'Codex-RealE2E',
    P3394_AGENT_CLI: CODEKEX,
    COGSEED_ENDPOINT, COGSEED_TOKEN,
    P3394_HEARTBEAT_MS: '5000', P3394_AGENT_TIMEOUT_MS: '180000',
    // app-server 是托管的 codex 常驻运行时；加长 heartbeat 防超时
  };
  const gw = spawn(process.execPath, [GATEWAY_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let gwOut = '';
  gw.stdout.on('data', (c) => gwOut += c);
  gw.stderr.on('data', (c) => gwOut += c);

  const deadline = Date.now() + 20000;
  let healthy = false;
  while (Date.now() < deadline) {
    const r = await getJson(`http://127.0.0.1:${gwPort}/p3394/health`);
    if (r.s === 200) { healthy = true; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  mark('真实 gateway 健康', healthy, `127.0.0.1:${gwPort}`);

  const replyListener = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try { const e = JSON.parse(body).envelope || {}; global.reply = ((e.payload || {}).parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(''); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise((r) => replyListener.listen(replyPort, '127.0.0.1', r));

  const nonce = crypto.randomBytes(4).toString('hex');
  const envelope = { spec_version: 'p3394/1.0', message_id: 'msg-codex-' + nonce, session_id: 'ses-codex-' + nonce, task_id: 'tsk-codex-' + nonce, kind: 'task', performative: 'request', role: 'requester', sender: { agent_id: 'real-external-node' }, recipients: [{ agent_id: 'codex' }], payload: { parts: [{ type: 'text', text: 'Reply with exactly: P3394-CODEX-E2E-OK' }] }, extensions: { reply_endpoint: `http://127.0.0.1:${replyPort}`, reply_token: 'rt' }, idempotency_key: 'idem-codex-' + nonce };
  const sent = await postJson(`http://127.0.0.1:${gwPort}/p3394/envelope`, { envelope });
  mark('信封送达真实 codex gateway', sent.s === 200, 'HTTP ' + sent.s);
  const rd = Date.now() + 180000;
  while (Date.now() < rd && !global.reply) await new Promise((r) => setTimeout(r, 1000));
  mark('真实 codex 模型回复送达', !!global.reply && global.reply.includes('P3394-CODEX-E2E-OK'), (global.reply || '(无回复)').slice(0, 120));

  gw.kill('SIGTERM'); replyListener.close();
  console.log('\n===== codex 真实端到端 =====\n通过 ' + results.filter(Boolean).length + '/' + results.length);
  if (gwOut.includes('p3394_gateway_error') || gwOut) console.log('(gateway 日志尾部) ' + gwOut.split('\n').filter(Boolean).slice(-3).join(' | '));
  process.exit(results.every(Boolean) ? 0 : 1);
}
main().catch((e) => { console.error('codex e2e 失败:', e.message); process.exit(2); });
