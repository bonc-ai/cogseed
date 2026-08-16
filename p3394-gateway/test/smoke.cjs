#!/usr/bin/env node
/**
 * p3394-gateway smoke test — 自测：假 CogSeed 服务 + 假 Agent CLI，
 * 验证 manifest / 收件 / 转发模型 / 回发 / 幂等 / 鉴权 / 会话连续性 /
 * Artifact 传递 / cancel 控制帧 / SSCLI 模式 / 启动注册。
 * 运行：node test/smoke.cjs
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-gw-test-'));
const GATEWAY_PORT = 19001;
const COGSEED_PORT = 19002;
const GATEWAY_TOKEN = 'gw-test-token';
const COGSEED_TOKEN = 'cogseed-test-token';

// ── 假 Agent CLI（oneshot）：echo 收到的 prompt、计数、可选睡眠、可选回写 out 工件 ──
const fakeCli = path.join(tmp, 'fake-agent.cjs');
fs.writeFileSync(fakeCli, [
  "'use strict';",
  "const fs = require('fs');",
  "const countFile = process.env.FAKE_CLI_COUNT_FILE;",
  "let n = 0; try { n = Number(fs.readFileSync(countFile, 'utf8')); } catch {}",
  "n += 1;",
  "fs.writeFileSync(countFile, String(n));",
  "const msg = process.argv.includes('{message}') ? 'unresolved' : (process.argv[2] || '');",
  "const finish = () => { process.stdout.write('FAKE-REPLY: ' + msg); process.exit(0); };",
  "if (process.env.FAKE_CLI_WRITE_OUT === '1') {",
  "  const m = msg.match(/(\\S*workspace\\/in\\/\\S+)/);",
  "  if (m) { const outDir = require('path').dirname(m[1]).replace(/in$/, 'out'); try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(require('path').join(outDir, 'result.txt'), 'OUT-ARTIFACT-' + n); } catch {} }",
  "}",
  "if (msg.includes('SLEEP-5000')) { setTimeout(finish, 5000); } else { finish(); }",
].join('\n'));
const countFile = path.join(tmp, 'cli-count.txt');

// ── 假 CogSeed 服务：记录收到的回复 envelope ──
const received = [];
const cogseedServer = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/p3394/envelope') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { received.push(JSON.parse(body).envelope); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message_id: 'ok' }));
    });
    return;
  }
  if (req.url && req.url.startsWith('/p3394/manifest')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, manifest: { spec_version: 'p3394/1.0', identity: { agent_id: 'cogseed', display_name: 'cogseed' }, capability_profile: { supported_performatives: ['request', 'inform'] } } }));
    return;
  }
  res.writeHead(404);
  res.end();
});

function request(port, method, pathName, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

async function main() {
  await new Promise((resolve) => cogseedServer.listen(COGSEED_PORT, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    P3394_GATEWAY_PORT: String(GATEWAY_PORT),
    P3394_GATEWAY_TOKEN: GATEWAY_TOKEN,
    P3394_GATEWAY_HOME: path.join(tmp, 'home'),
    COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT,
    COGSEED_TOKEN,
    P3394_AGENT_CLI: 'node',
    P3394_AGENT_CLI_ARGS: fakeCli + ' {message}',
    FAKE_CLI_COUNT_FILE: countFile,
    FAKE_CLI_WRITE_OUT: '1',
    P3394_HEARTBEAT_MS: '300',
  };
  const gateway = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let gatewayLog = '';
  gateway.stdout.on('data', (c) => { gatewayLog += c; });
  gateway.stderr.on('data', (c) => { gatewayLog += c; });
  await sleep(900);

  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); else console.log('  ✓ ' + name); };

  console.log('p3394-gateway smoke:');

  // health + manifest
  const health = await request(GATEWAY_PORT, 'GET', '/p3394/health');
  check('health 200', health.status === 200);
  const manifest = await request(GATEWAY_PORT, 'GET', '/p3394/manifest');
  check('manifest 200 且 identity=hermes', manifest.status === 200 && manifest.body.includes('hermes'));

  // 启动即注册
  check('启动 hello 注册（自报 endpoint + 能力）', received.some((e) => e.kind === 'control' && e.sender.agent_id === 'hermes' && Array.isArray(e.extensions && e.extensions.endpoints) && e.extensions.endpoints[0] === 'http://127.0.0.1:' + GATEWAY_PORT && Array.isArray(e.extensions.capabilities)));

  // 鉴权
  const noAuth = await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: {} }, 'wrong');
  check('错误 token → 401', noAuth.status === 401);

  // ECS 心跳：网关周期性向 CogSeed 报活（control + inform，刷新 last_seen）
  await sleep(900);
  check('ECS 心跳：定期 heartbeat 信封', received.some((e) => e.kind === 'control' && e.performative === 'inform' && e.sender.agent_id === 'hermes' && e.payload && e.payload.metadata && e.payload.metadata.heartbeat === true));

  // 收件 → 转发模型 → 回发
  const env1 = { message_id: 'm1', session_id: 's1', task_id: 't1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'hello' }] }, idempotency_key: 'idem1' };
  const post1 = await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: env1 }, GATEWAY_TOKEN);
  check('收件 200', post1.status === 200);
  await sleep(1200);
  check('回复回发到 CogSeed（session 匹配）', received.some((e) => e.session_id === 's1' && e.sender.agent_id === 'hermes'));
  check('回复内容来自 Agent 模型', received.some((e) => (e.payload.parts[0].text || '').includes('FAKE-REPLY: hello')));
  check('回复 recipient 为原 sender', received.some((e) => e.recipients[0].agent_id === 'cogseed'));

  // 会话连续性：同一 session 的第二条消息带上历史 transcript
  const env2 = { message_id: 'm5', session_id: 's1', task_id: 't5', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'second turn' }] }, idempotency_key: 'idem5' };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: env2 }, GATEWAY_TOKEN);
  await sleep(1200);
  check('同 session 多轮携带会话历史', received.some((e) => e.session_id === 's1' && (e.payload.parts[0].text || '').includes('FAKE-REPLY:') && (e.payload.parts[0].text || '').includes('[会话历史]')));

  // Artifact 入站：resource part 落盘到会话工作区并把路径告诉 Agent
  const artContent = 'ARTIFACT-BODY';
  const artEnv = { message_id: 'm6', session_id: 's6', task_id: 't6', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [
    { type: 'text', text: 'read the attachment' },
    { type: 'resource', uri: 'data:text/plain;base64,' + Buffer.from(artContent).toString('base64'), media_type: 'text/plain', name: 'input.txt', digest: sha256(artContent) },
  ] }, idempotency_key: 'idem6' };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: artEnv }, GATEWAY_TOKEN);
  await sleep(1200);
  check('入站工件落盘并提示路径', received.some((e) => e.session_id === 's6' && (e.payload.parts[0].text || '').includes('input.txt') && (e.payload.parts[0].text || '').includes('workspace/in')));

  // Artifact 出站：Agent 运行期间写入 workspace/out/ 的文件随回复回传（digest 校验）
  const outArtifact = received.find((e) => e.session_id === 's6' && e.payload.parts.some((p) => p.type === 'resource'));
  const outPart = outArtifact && outArtifact.payload.parts.find((p) => p.type === 'resource');
  const expectedDigest = sha256('OUT-ARTIFACT-' + 3);
  check('回复携带 out/ 工件（resource part + 正确 digest）', !!outPart && outPart.name === 'result.txt' && String(outPart.digest).toLowerCase().replace(/^sha256:/, '') === expectedDigest);

  // cancel 控制帧：长任务被终止，只回取消回执
  const cancelEnv = { message_id: 'm7', session_id: 's7', task_id: 'tsk-cancel-1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'SLEEP-5000 long task' }] }, idempotency_key: 'idem7' };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: cancelEnv }, GATEWAY_TOKEN);
  await sleep(500);
  const cancelCtl = { message_id: 'm8', session_id: 's7', task_id: 'tsk-cancel-1', kind: 'control', performative: 'cancel', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'cancel' }] }, idempotency_key: 'idem8' };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: cancelCtl }, GATEWAY_TOKEN);
  await sleep(800);
  check('cancel 控制帧 → 取消回执', received.some((e) => e.session_id === 's7' && (e.payload.parts[0].text || '') === '[已取消]'));
  check('被取消任务不再补发错误回信', !received.some((e) => e.session_id === 's7' && (e.payload.parts[0].text || '').includes('p3394_gateway_error')));

  // 幂等
  const beforeCount = Number(fs.readFileSync(countFile, 'utf8'));
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: env1 }, GATEWAY_TOKEN);
  await sleep(800);
  const afterCount = Number(fs.readFileSync(countFile, 'utf8'));
  check('幂等：重复 key 不重跑模型', afterCount === beforeCount);

  // 空消息
  const empty = await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: { message_id: 'm2', session_id: 's2', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: '   ' }] }, idempotency_key: 'idem2' } }, GATEWAY_TOKEN);
  check('空消息仍收件 200', empty.status === 200);

  // extensions 回发路由
  const altReceived = [];
  const altServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { altReceived.push(JSON.parse(body).envelope); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message_id: 'ok' }));
    });
  });
  const ALT_PORT = COGSEED_PORT + 10;
  await new Promise((resolve) => altServer.listen(ALT_PORT, '127.0.0.1', resolve));
  const altEnv = { message_id: 'm4', session_id: 's4', task_id: 't4', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'alt route' }] }, idempotency_key: 'idem4', extensions: { reply_endpoint: 'http://127.0.0.1:' + ALT_PORT, reply_token: COGSEED_TOKEN } };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: altEnv }, GATEWAY_TOKEN);
  for (let i = 0; i < 30 && !altReceived.length; i += 1) await sleep(100);
  check('extensions 回发路由：回复发往 reply_endpoint（零配置回发）', altReceived.some((e) => e.session_id === 's4'));
  altServer.close();

  // 缺字段
  const bad = await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: { message_id: 'm3' } }, GATEWAY_TOKEN);
  check('缺字段 → 422', bad.status === 422);

  // ── 预设解析 ──
  const presetEnv = { ...process.env, P3394_AGENT: 'claude', P3394_GATEWAY_PORT: String(GATEWAY_PORT + 10), P3394_GATEWAY_HOME: path.join(tmp, 'preset-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT };
  const presetProbe = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: presetEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let presetLog = '';
  presetProbe.stdout.on('data', (c) => { presetLog += c; });
  presetProbe.stderr.on('data', (c) => { presetLog += c; });
  for (let i = 0; i < 40 && !presetLog.includes('preset:'); i += 1) await sleep(100);
  check('预设 claude → CLI 模板生效', presetLog.includes('preset: claude') && presetLog.includes('claude -p {message}'));
  presetProbe.kill('SIGTERM');

  const unknownProbe = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: { ...process.env, P3394_AGENT: 'unknown-agent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let unknownLog = '';
  unknownProbe.stderr.on('data', (c) => { unknownLog += c; });
  await new Promise((resolve) => unknownProbe.on('exit', resolve));
  check('未知预设 → 报错退出（列出可用预设）', unknownLog.includes('未知 P3394_AGENT') && unknownLog.includes('hermes, claude'));

  // ── SSCLI 模式：常驻 CLI + JSONL 协议 ──
  const sscliLog = path.join(tmp, 'sscli-ops.jsonl');
  const SSCLI_PORT = GATEWAY_PORT + 30;
  const sscliEnv = { ...process.env, P3394_GATEWAY_PORT: String(SSCLI_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'sscli-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT_MODE: 'sscli', P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: path.join(__dirname, 'fake-sscli-agent.cjs'), SSCLI_LOG_FILE: sscliLog };
  const sscliGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: sscliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let sscliGwLog = '';
  sscliGw.stdout.on('data', (c) => { sscliGwLog += c; });
  sscliGw.stderr.on('data', (c) => { sscliGwLog += c; });
  await sleep(900);
  const sscliEnv1 = { message_id: 'sm1', session_id: 'ss1', task_id: 'st1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'sscli hello' }] }, idempotency_key: 'sscli-idem1' };
  await request(SSCLI_PORT, 'POST', '/p3394/envelope', { envelope: sscliEnv1 }, GATEWAY_TOKEN);
  for (let i = 0; i < 50 && !received.some((e) => e.session_id === 'ss1'); i += 1) await sleep(100);
  check('SSCLI 模式：deliver → delta → completed → 回复', received.some((e) => e.session_id === 'ss1' && (e.payload.parts[0].text || '').includes('SSCLI-REPLY: sscli hello')));
  const sscliEnv2 = { message_id: 'sm2', session_id: 'ss1', task_id: 'st2', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'second' }] }, idempotency_key: 'sscli-idem2' };
  await request(SSCLI_PORT, 'POST', '/p3394/envelope', { envelope: sscliEnv2 }, GATEWAY_TOKEN);
  await sleep(800);
  let sscliOps = [];
  try { sscliOps = fs.readFileSync(sscliLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch {}
  check('SSCLI 协议：hello/open_session/deliver 已交换', sscliOps.some((o) => o.op === 'hello') && sscliOps.some((o) => o.op === 'open_session') && sscliOps.some((o) => o.op === 'deliver'));
  check('SSCLI 会话复用：open_session 只发一次', sscliOps.filter((o) => o.op === 'open_session').length === 1);
  sscliGw.kill('SIGTERM');

  gateway.kill('SIGTERM');
  cogseedServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) {
    console.error('FAILED: ' + failures.join(', '));
    console.error(gatewayLog);
    console.error(sscliGwLog);
    process.exit(1);
  }
  console.log('ALL PASS');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
