#!/usr/bin/env node
/**
 * p3394-gateway smoke test — 自测：假 CogSeed 服务 + 假 Agent CLI，
 * 验证 manifest / 收件 / 转发模型 / 回发 / 幂等 / 鉴权 / 会话连续性 /
 * Artifact 传递 / cancel 控制帧 / 并发 / oneshot 增量输出 / SSCLI 模式 / 启动注册。
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
// 假 CogSeed 按 COGSEED_TOKEN 校验 Bearer，所有网关实例（含各子网关）的
// `{ ...process.env, ... }` env 都必须自带配置 token，否则回发被 401。
process.env.COGSEED_TOKEN = COGSEED_TOKEN;

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
  "const finish = () => { process.stdout.write('FAKE-REPLY: ' + msg + ' CWD:' + process.cwd()); process.exit(0); };",
  "if (process.env.FAKE_CLI_WRITE_OUT === '1') {",
  "  const m = msg.match(/(\\S*workspace\\/in\\/\\S+)/);",
  "  if (m) { const outDir = require('path').dirname(m[1]).replace(/in$/, 'out'); try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(require('path').join(outDir, 'result.txt'), 'OUT-ARTIFACT-' + n); } catch {} }",
  "}",
  "const sleepMs = (msg.match(/SLEEP-(\\d+)/) || [])[1];",
  "if (sleepMs) { setTimeout(finish, Number(sleepMs)); } else { finish(); }",
].join('\n'));
const countFile = path.join(tmp, 'cli-count.txt');

// ── 假 CogSeed 服务：按 COGSEED_TOKEN 校验 Bearer（模拟真实桥的入站鉴权），
// 记录收到的回复 envelope。恶意 reply_endpoint/reply_token 用例因此能验证
// 网关的"端点+token 成对回退"：声明不可信时帧必须带配置 token 才到达这里。 ──
const received = [];
const cogseedServer = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/p3394/envelope') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ' + COGSEED_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
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

  // 统一后端选择：默认（未声明 sscli）→ oneshot 万能兜底。
  check('后端选择：默认 preset 走 oneshot 兜底', gatewayLog.includes('runtime: oneshot'));

  // 鉴权
  const noAuth = await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: {} }, 'wrong');
  check('错误 token → 401', noAuth.status === 401);

  // 心跳：网关周期性向 CogSeed 报活（control + inform，刷新 last_seen）
  await sleep(900);
  check('心跳：定期 heartbeat 信封', received.some((e) => e.kind === 'control' && e.performative === 'inform' && e.sender.agent_id === 'hermes' && e.payload && e.payload.metadata && e.payload.metadata.heartbeat === true));

  // 收件 → 转发模型 → 回发
  const requestedCwd = path.join(tmp, 'requested-cwd');
  fs.mkdirSync(requestedCwd, { recursive: true });
  const requestedRealCwd = fs.realpathSync(requestedCwd);
  const env1 = { message_id: 'm1', session_id: 's1', task_id: 't1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'hello' }] }, idempotency_key: 'idem1', extensions: { working_dir: requestedCwd, reply_endpoint: 'http://127.0.0.1:' + COGSEED_PORT, reply_token: COGSEED_TOKEN } };
  const post1 = await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: env1 }, GATEWAY_TOKEN);
  check('收件 200', post1.status === 200);
  await sleep(1200);
  check('回复回发到 CogSeed（session 匹配）', received.some((e) => e.session_id === 's1' && e.sender.agent_id === 'hermes'));
  check('回复内容来自 Agent 模型', received.some((e) => (e.payload.parts[0].text || '').includes('FAKE-REPLY: hello')));
  check('extensions.working_dir 作为 CLI cwd 生效', received.some((e) => (e.payload.parts[0].text || '').includes('CWD:' + requestedRealCwd)));
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

  // oneshot 并发：上了长任务后，新的一条快速消息不应被串行队列阻塞——
  // 每条消息 spawn 独立 CLI 进程，应立刻并行执行。
  const concLong = { message_id: 'mc1', session_id: 's-conc-long', task_id: 'tc1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'SLEEP-3000 conc-along' }] }, idempotency_key: 'idemc1' };
  const concQuick = { message_id: 'mc2', session_id: 's-conc-quick', task_id: 'tc2', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'conc-quick' }] }, idempotency_key: 'idemc2' };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: concLong }, GATEWAY_TOKEN);
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: concQuick }, GATEWAY_TOKEN);
  await sleep(700);
  const quickRepliedEarly = received.some((e) => e.session_id === 's-conc-quick' && (e.payload.parts[0].text || '').includes('FAKE-REPLY: conc-quick'));
  const longStillRunning = !received.some((e) => e.session_id === 's-conc-long' && (e.payload.parts[0].text || '').includes('FAKE-REPLY:'));
  check('oneshot 并发：长任务未结束时快速消息已回（不排队）', quickRepliedEarly && longStillRunning);
  await sleep(3000);
  check('长任务随后正常回发', received.some((e) => e.session_id === 's-conc-long' && (e.payload.parts[0].text || '').includes('FAKE-REPLY:') && (e.payload.parts[0].text || '').includes('SLEEP-3000')));

  // oneshot 增量输出：CLI 运行中逐段输出的可见内容实时以 stream delta 帧回发，
  // 不必等工具+回复全部跑完。用分段输出的假 CLI：任务 ~620ms 才结束，但
  // PART-A/PART-B 应在此之前就以 delta 帧到达 CogSeed。
  const streamAgent = path.join(tmp, 'fake-stream-agent.cjs');
  fs.writeFileSync(streamAgent, [
    "'use strict';",
    "setTimeout(() => { process.stdout.write('PART-A'); }, 60);",
    "setTimeout(() => { process.stdout.write('\\nPART-B'); }, 320);",
    "setTimeout(() => { process.stdout.write('\\nFAKE-STREAM-REPLY'); process.exit(0); }, 620);",
  ].join('\n'));
  const STREAM_PORT = GATEWAY_PORT + 40;
  const streamEnv = { ...process.env, P3394_GATEWAY_PORT: String(STREAM_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'stream-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: streamAgent, P3394_HEARTBEAT_MS: '0' };
  const streamGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: streamEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(900);
  // 恶意 reply_endpoint（SSRF/数据外泄回归测试）：对端可控的 reply_endpoint
  // 若被流式回发路径信任，delta 帧会 POST 到攻击者地址（evil.invalid 无法
  // 解析 → 帧丢失），只有回退到受信 COGSEED_ENDPOINT 时下方 delta 断言才成立。
  // 终态回复本就走 postReply 校验，因此必须用 delta 帧本身做判别。
  const streamMsg = { message_id: 'stm1', session_id: 's-stream', task_id: 'stk1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'stream me' }] }, idempotency_key: 'idem-stream1', extensions: { reply_endpoint: 'http://evil.invalid:9999', reply_token: 'attacker-token' } };
  await request(STREAM_PORT, 'POST', '/p3394/envelope', { envelope: streamMsg }, GATEWAY_TOKEN);
  // 轮询到首条 delta 帧即停：PART-A（~60ms 写入，80ms 合并器冲刷）远早于
  // FAKE-STREAM-REPLY（~620ms），因此能证明"运行中已实时回发、非等全部完成"。
  for (let i = 0; i < 20 && !received.some((e) => e.kind === 'event' && e.session_id === 's-stream'); i += 1) await sleep(50);
  check('oneshot 增量输出：运行中已实时回发 delta 帧（非等全部完成）', received.some((e) => e.kind === 'event' && e.session_id === 's-stream' && e.payload && e.payload.metadata && e.payload.metadata.stream_event === 'delta'));
  await sleep(900);
  check('oneshot 增量输出：delta 帧包含逐段可见输出', received.some((e) => e.kind === 'event' && e.session_id === 's-stream' && (e.payload.parts[0].text || '').includes('PART-A')));
  check('oneshot 增量输出：终态回复仍正常回发', received.some((e) => e.session_id === 's-stream' && (e.payload.parts[0].text || '').includes('FAKE-STREAM-REPLY')));
  streamGw.kill('SIGTERM');

  // 流式回发通道有界性：对端"连接建立但不响应"（半开/事件循环卡死）时，
  // 单帧 POST 超时 + finish 整体截止必须让终态回复仍能及时发出——否则
  // handleEnvelope 卡在 await stream.finish()，对端永远等不到回复。
  // silent server 只吞流式 event 帧（不响应，模拟挂起），正常回 200 给终态。
  const silentGot = [];
  const silentServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let envelope = null;
      try { envelope = JSON.parse(body).envelope; } catch { /* fallthrough */ }
      if (envelope) silentGot.push(envelope);
      if (envelope && envelope.kind === 'event') return; // 流式帧：故意不响应
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const SILENT_PORT = COGSEED_PORT + 70;
  await new Promise((resolve) => silentServer.listen(SILENT_PORT, '127.0.0.1', resolve));
  const SILENT_GW_PORT = GATEWAY_PORT + 60;
  const silentGwEnv = { ...process.env, P3394_GATEWAY_PORT: String(SILENT_GW_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'silent-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: streamAgent, P3394_HEARTBEAT_MS: '0', P3394_STREAM_POST_TIMEOUT_MS: '300', P3394_STREAM_FINISH_DEADLINE_MS: '800' };
  const silentGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: silentGwEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(900);
  // reply_endpoint 指向 silent 端口（回环 → 受信），流式帧全被吞掉且无响应。
  const silentMsg = { message_id: 'sim1', session_id: 's-silent', task_id: 'sitk1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'stream to silent peer' }] }, idempotency_key: 'idem-silent1', extensions: { reply_endpoint: 'http://127.0.0.1:' + SILENT_PORT } };
  await request(SILENT_GW_PORT, 'POST', '/p3394/envelope', { envelope: silentMsg }, GATEWAY_TOKEN);
  let silentReplied = false;
  for (let i = 0; i < 40 && !silentReplied; i += 1) {
    await sleep(100);
    silentReplied = silentGot.some((e) => e.kind === 'message' && e.session_id === 's-silent' && (e.payload.parts[0].text || '').includes('FAKE-STREAM-REPLY'));
  }
  const silentEventCount = silentGot.filter((e) => e.kind === 'event' && e.session_id === 's-silent').length;
  check('流式通道挂起不阻塞终态：对端不响应时终态回复仍按时回发', silentReplied);
  check('流式通道有界：挂起帧不无限重发（event 帧数量有限）', silentEventCount > 0 && silentEventCount <= 6);
  silentGw.kill('SIGTERM');
  silentServer.close();

  // sscli 流式 delta 总量上限：失控的常驻 CLI 无限刷 delta 时，帧流必须被
  // STREAM_TOTAL_CAP_CHARS 截断而不是无限 POST（oneshot 侧另有 256KB 双保险）。
  const floodAgent = path.join(tmp, 'fake-flood-agent.cjs');
  fs.writeFileSync(floodAgent, [
    "'use strict';",
    "const readline = require('readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (raw) => {",
    "  let op; try { op = JSON.parse(raw); } catch { return; }",
    "  if (op.op === 'hello') process.stdout.write(JSON.stringify({ ok: true, protocol: 'p3394-sscli/1.0', runtime: 'fake-flood', request_id: op.request_id }) + '\\n');",
    "  else if (op.op === 'open_session') process.stdout.write(JSON.stringify({ ok: true, request_id: op.request_id }) + '\\n');",
    "  else if (op.op === 'deliver') {",
    "    for (let i = 0; i < 600; i += 1) process.stdout.write(JSON.stringify({ event: 'delta', request_id: op.request_id, text: 'F'.repeat(1000) }) + '\\n');",
    "    process.stdout.write(JSON.stringify({ event: 'completed', request_id: op.request_id }) + '\\n');",
    "  } else process.stdout.write(JSON.stringify({ ok: true, request_id: op.request_id }) + '\\n');",
    "});",
  ].join('\n'));
  const FLOOD_PORT = GATEWAY_PORT + 70;
  const floodEnv = { ...process.env, P3394_GATEWAY_PORT: String(FLOOD_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'flood-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT_MODE: 'sscli', P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: floodAgent, P3394_HEARTBEAT_MS: '0' };
  const floodGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: floodEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(900);
  const floodMsg = { message_id: 'fl1', session_id: 's-flood', task_id: 'fltk1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'flood me' }] }, idempotency_key: 'idem-flood1' };
  await request(FLOOD_PORT, 'POST', '/p3394/envelope', { envelope: floodMsg }, GATEWAY_TOKEN);
  let floodDone = false;
  for (let i = 0; i < 60 && !floodDone; i += 1) {
    await sleep(100);
    floodDone = received.some((e) => e.session_id === 's-flood' && (e.payload.parts[0].text || '').includes('[输出过长已截断]'));
  }
  const floodDeltas = received.filter((e) => e.kind === 'event' && e.session_id === 's-flood' && e.payload && e.payload.metadata && e.payload.metadata.stream_event === 'delta');
  const floodChars = floodDeltas.reduce((sum, e) => sum + (e.payload.parts[0].text || '').length, 0);
  check('sscli delta 总量上限：刷屏帧流被截断（转发量远小于 CLI 输出 600KB）', floodDone && floodChars < 600 * 1000 && floodChars <= 512 * 1024 + 16 * 1024);
  floodGw.kill('SIGTERM');

  // openclaw 特殊处理：CLI 无中间分片、正文只能等末尾 JSON 信封一次性落地——
  // 其 stderr 的 [skills]/[tools] 过程日志逐行回发为 stream progress 帧（process
  // rail 可见工具调用），但最终 JSON 信封不转发、也不产生任何正文 delta 帧。
  const ocAgent = path.join(tmp, 'fake-openclaw-agent.cjs');
  fs.writeFileSync(ocAgent, [
    "'use strict';",
    "setTimeout(() => { process.stderr.write('[skills] loading skill\\n'); }, 50);",
    "setTimeout(() => { process.stderr.write('{\"partial\":\"should-not-stream\"}\\n'); }, 120);",
    "setTimeout(() => { process.stdout.write(JSON.stringify({ payloads: [{ text: 'OC-REPLY-ONE-SHOT' }], meta: {} })); process.exit(0); }, 250);",
  ].join('\n'));
  const OC_PORT = GATEWAY_PORT + 50;
  const ocEnv = { ...process.env, P3394_GATEWAY_PORT: String(OC_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'oc-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT: 'openclaw', P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: ocAgent + ' {message}', P3394_HEARTBEAT_MS: '0' };
  const ocGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: ocEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(900);
  const ocMsg = { message_id: 'ocm1', session_id: 's-oc', task_id: 'oct1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'openclaw' }], payload: { parts: [{ type: 'text', text: 'hi' }] }, idempotency_key: 'idem-oc1' };
  await request(OC_PORT, 'POST', '/p3394/envelope', { envelope: ocMsg }, GATEWAY_TOKEN);
  await sleep(1000);
  const ocEvents = received.filter((e) => e.kind === 'event' && e.session_id === 's-oc');
  check('openclaw 过程日志以 progress 帧回发（process rail 可见工具调用）', ocEvents.some((e) => e.payload && e.payload.metadata && e.payload.metadata.stream_event === 'progress' && (e.payload.parts[0].text || '').includes('[skills] loading skill')));
  check('openclaw 过程日志不含最终 JSON 信封', !ocEvents.some((e) => (e.payload.parts[0].text || '').includes('should-not-stream')));
  check('openclaw 一次性回发：不产生 stream delta 帧', !ocEvents.some((e) => e.payload && e.payload.metadata && e.payload.metadata.stream_event === 'delta'));
  check('openclaw 一次性回发：终态回复正常', received.some((e) => e.session_id === 's-oc' && (e.payload.parts[0].text || '').includes('OC-REPLY-ONE-SHOT')));
  ocGw.kill('SIGTERM');

  // cancel 控制帧：长任务被终止，只回取消回执
  const cancelEnv = { message_id: 'm7', session_id: 's7', task_id: 'tsk-cancel-1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'SLEEP-5000 long task' }] }, idempotency_key: 'idem7' };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: cancelEnv }, GATEWAY_TOKEN);
  await sleep(500);
  const cancelCtl = { message_id: 'm8', session_id: 's7', task_id: 'tsk-cancel-1', kind: 'control', performative: 'cancel', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'cancel' }] }, idempotency_key: 'idem8' };
  await request(GATEWAY_PORT, 'POST', '/p3394/envelope', { envelope: cancelCtl }, GATEWAY_TOKEN);
  await sleep(800);
  check('cancel 控制帧 → 取消回执', received.some((e) => e.session_id === 's7' && (e.payload.parts[0].text || '') === '[已取消]'));
  check('被取消任务不再补发错误回信', !received.some((e) => e.session_id === 's7' && (e.payload.parts[0].text || '').includes('p3394_gateway_error')));

  // cancel 必须真正终止运行中的 oneshot CLI 子进程（统一 deliver 接口回归：
  // 子进程曾按 message_id 注册、cancel 按 task_id 查找，真实取消落空导致
  // 进程跑完才退）。用写 PID 的假 CLI 验证进程在取消后被回收。
  const cancelPidFile = path.join(tmp, 'cancel-pid.txt');
  const pidCli = path.join(tmp, 'fake-pid-agent.cjs');
  fs.writeFileSync(pidCli, [
    "'use strict';",
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.FAKE_CLI_PID_FILE, String(process.pid));",
    "const msg = process.argv[2] || '';",
    "const sleepMs = (msg.match(/SLEEP-(\\d+)/) || [])[1];",
    "setTimeout(() => { process.stdout.write('FAKE-REPLY: ' + msg); process.exit(0); }, Number(sleepMs || 100));",
  ].join('\n'));
  const PID_GW_PORT = GATEWAY_PORT + 80;
  const pidGwEnv = { ...process.env, P3394_GATEWAY_PORT: String(PID_GW_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'pid-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: pidCli + ' {message}', FAKE_CLI_PID_FILE: cancelPidFile, P3394_HEARTBEAT_MS: '0' };
  const pidGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: pidGwEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(900);
  const pidTask = { message_id: 'pm1', session_id: 's-pid', task_id: 'tsk-pid-1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'SLEEP-8000 long' }] }, idempotency_key: 'idem-pid1' };
  await request(PID_GW_PORT, 'POST', '/p3394/envelope', { envelope: pidTask }, GATEWAY_TOKEN);
  // 等假 CLI 写入 pid（它启动即写，随后进入 8s 睡眠）。
  let childPid = 0;
  for (let i = 0; i < 30 && !childPid; i += 1) {
    await sleep(100);
    try { const raw = fs.readFileSync(cancelPidFile, 'utf8'.trim()); const n = Number(raw); if (n > 0) childPid = n; } catch {}
  }
  const pidCtl = { message_id: 'pc1', session_id: 's-pid', task_id: 'tsk-pid-1', kind: 'control', performative: 'cancel', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }], payload: { parts: [{ type: 'text', text: 'cancel' }] }, idempotency_key: 'idem-pid-ctl' };
  await request(PID_GW_PORT, 'POST', '/p3394/envelope', { envelope: pidCtl }, GATEWAY_TOKEN);
  // 取消后短时间内进程应已被回收：kill(pid, 0) 报 ESRCH（或进程已退出）。
  let pidGone = false;
  for (let i = 0; i < 20 && !pidGone; i += 1) {
    await sleep(100);
    try { process.kill(childPid, 0); } catch { pidGone = true; }
  }
  check('cancel 真正终止子进程：取消后 CLI pid 已被回收', childPid > 0 && pidGone);
  // 8s 睡眠任务被取消后不应在窗口期回发终态回复。
  check('cancel 后 8s 长任务不再回发终态', !received.some((e) => e.session_id === 's-pid' && (e.payload.parts[0].text || '').includes('FAKE-REPLY: SLEEP-8000')));
  pidGw.kill('SIGTERM');

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

  // 任意名字可接入：未知名不再报错——身份=名字、CLI=同名命令、参数={message}。
  const unknownEnv = { ...process.env, P3394_AGENT: 'unknown-agent', P3394_GATEWAY_PORT: String(GATEWAY_PORT + 20), P3394_GATEWAY_HOME: path.join(tmp, 'unknown-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT };
  const unknownProbe = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: unknownEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let unknownLog = '';
  unknownProbe.stdout.on('data', (c) => { unknownLog += c; });
  unknownProbe.stderr.on('data', (c) => { unknownLog += c; });
  for (let i = 0; i < 40 && !unknownLog.includes('preset:'); i += 1) await sleep(100);
  check('任意名字可启动：身份=名字、CLI=同名命令、参数={message}', unknownLog.includes('preset: unknown-agent') && unknownLog.includes('CLI: unknown-agent {message}'));
  unknownProbe.kill('SIGTERM');

  // ── SSCLI 模式：常驻 CLI + JSONL 协议 ──
  const sscliLog = path.join(tmp, 'sscli-ops.jsonl');
  const SSCLI_PORT = GATEWAY_PORT + 30;
  const sscliEnv = { ...process.env, P3394_GATEWAY_PORT: String(SSCLI_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'sscli-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT_MODE: 'sscli', P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: path.join(__dirname, 'fake-sscli-agent.cjs'), SSCLI_LOG_FILE: sscliLog };
  const sscliGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: sscliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let sscliGwLog = '';
  sscliGw.stdout.on('data', (c) => { sscliGwLog += c; });
  sscliGw.stderr.on('data', (c) => { sscliGwLog += c; });
  await sleep(900);
  // 后端选择：声明 P3394_AGENT_MODE=sscli → sscli 主导（常驻 JSONL 协议）。
  check('后端选择：声明 sscli → 走 sscli 主导', sscliGwLog.includes('runtime: sscli'));
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

  // ── Stream-json 包装器（sscli 主导）：模拟 claude -p --output-format
  // stream-json 事件流 → 逐 token delta 实时回发 + 终态回复不重复。 ──
  const streamJsonAgent = path.join(tmp, 'fake-stream-json-agent.cjs');
  fs.writeFileSync(streamJsonAgent, [
    "'use strict';",
    "const fs = require('fs');",
    "if (process.env.FAKE_STREAMJSON_LOG) fs.appendFileSync(process.env.FAKE_STREAMJSON_LOG, JSON.stringify(process.argv) + '\\n');",
    "process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'HELLO '}}}) + '\\n');",
    "setTimeout(() => { process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'STREAM'}}}) + '\\n'); }, 200);",
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'HELLO STREAM'}]}}) + '\\n');",
    "  process.stdout.write(JSON.stringify({type:'result',subtype:'success'}) + '\\n');",
    "}, 400);",
  ].join('\n'));
  const STREAM_JSON_PORT = GATEWAY_PORT + 50;
  const streamJsonLog = path.join(tmp, 'stream-json-argv.log');
  // 本用例验证"每轮 spawn"的 stream-json 包装器语义（跨轮 transcript 回放）：
  // 常驻双工模式（默认开）是另一条路径，单独用例覆盖。显式回退。
  const streamJsonEnv = { ...process.env, P3394_GATEWAY_PORT: String(STREAM_JSON_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'stream-json-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT: 'claude', P3394_AGENT_MODE: 'sscli', P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: streamJsonAgent + ' {message}', P3394_HEARTBEAT_MS: '0', COGSEED_P3394_CLAUDE_PERSISTENT: '0', FAKE_STREAMJSON_LOG: streamJsonLog };
  const streamJsonGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: streamJsonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let streamJsonGwLog = '';
  streamJsonGw.stdout.on('data', (c) => { streamJsonGwLog += c; });
  streamJsonGw.stderr.on('data', (c) => { streamJsonGwLog += c; });
  await sleep(900);
  check('后端选择：claude + sscli → stream-json 流式包装器', streamJsonGwLog.includes('runtime: stream-json'));
  const sjMsg = { message_id: 'sj1', session_id: 's-stream-json', task_id: 'sjtk1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'claude' }], payload: { parts: [{ type: 'text', text: 'stream me' }] }, idempotency_key: 'idem-streamjson1' };
  await request(STREAM_JSON_PORT, 'POST', '/p3394/envelope', { envelope: sjMsg }, GATEWAY_TOKEN);
  // 分时断言 1：假 CLI 终态在 ~400ms 才出，第一段 delta 应在此之前就作为
  // stream delta 帧到达 CogSeed —— 证明真·运行中实时流式，非等全部完成。
  await sleep(300);
  const earlyDeltas = received.filter((e) => e.kind === 'event' && e.session_id === 's-stream-json' && e.payload && e.payload.metadata && e.payload.metadata.stream_event === 'delta').map((e) => (e.payload.parts[0].text || '')).join('');
  const terminalNotYet = !received.some((e) => e.session_id === 's-stream-json' && e.kind === 'message');
  check('stream-json：终态前已实时回发 delta 帧', earlyDeltas.includes('HELLO ') && terminalNotYet);
  // 分时断言 2：收尾后终态回复 = 累积文本且不重复（assistant 帧不去重追加）。
  await sleep(700);
  const sjReplies = received.filter((e) => e.session_id === 's-stream-json' && e.kind === 'message');
  check('stream-json：终态回复 = 累积文本且不重复', sjReplies.some((e) => (e.payload.parts[0].text || '').trim() === 'HELLO STREAM'));

  // 分时断言 3：跨轮上下文——同一 session 第二条消息应回放 [会话历史]（与
  // oneshot 同构，否则 claude -p 每轮失忆）。argv 记在 FAKE_STREAMJSON_LOG。
  const sjMsg2 = { message_id: 'sj2', session_id: 's-stream-json', task_id: 'sjtk2', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'claude' }], payload: { parts: [{ type: 'text', text: 'follow up' }] }, idempotency_key: 'idem-streamjson2' };
  await request(STREAM_JSON_PORT, 'POST', '/p3394/envelope', { envelope: sjMsg2 }, GATEWAY_TOKEN);
  await sleep(900);
  let sjArgvs = [];
  try { sjArgvs = fs.readFileSync(streamJsonLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const sjHist = sjArgvs.slice(-1)[0] || [];
  check('stream-json：第二轮回放 [会话历史] 且含首条消息', JSON.stringify(sjHist).includes('[会话历史]') && JSON.stringify(sjHist).includes('stream me'));
  check('stream-json：第二轮终态回复仍正常', received.filter((e) => e.session_id === 's-stream-json' && e.kind === 'message').length >= 2);
  streamJsonGw.kill('SIGTERM');

  // ── claude stream-json 常驻模式（默认开）：一个进程处理多轮，stdin 收
  // user 消息、stdout 推事件，进程内自动延续上下文。fake CLI 读 stdin：
  // 每收到一行 user 消息输出一轮 delta+assistant+result；把 spawn 次数与
  // pid 记到日志/文件，断言第二轮复用进程、不再带 [会话历史] 前缀。 ──
  const persistentAgent = path.join(tmp, 'fake-persistent-agent.cjs');
  const persistentPidFile = path.join(tmp, 'persistent-pid.txt');
  const persistentLog = path.join(tmp, 'persistent-argv.log');
  fs.writeFileSync(persistentAgent, [
    "'use strict';",
    "const fs = require('fs');",
    "fs.appendFileSync(process.env.FAKE_PERSISTENT_PID, String(process.pid) + '\\n');",
    "fs.appendFileSync(process.env.FAKE_PERSISTENT_LOG, JSON.stringify(process.argv) + '\\n');",
    "process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'fake-ses'}) + '\\n');",
    "const readline = require('readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "let round = 0;",
    "rl.on('line', (line) => {",
    "  let msg;",
    "  try { msg = JSON.parse(line); } catch { return; }",
    "  if (!msg || msg.type !== 'user') return;",
    "  round += 1;",
    "  const text = String(msg.message && msg.message.content && msg.message.content[0] && msg.message.content[0].text || '');",
    "  process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'PERSISTENT-' + round + ':'}}}) + '\\n');",
    "  if (round === 3) return; // 第三轮挂起（模拟长任务），等 cancel 终止进程",
    "  setTimeout(() => {",
    "    process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:text.slice(0, 40)}}}) + '\\n');",
    "    process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'PERSISTENT-' + round + ':' + text.slice(0, 40)}]}}) + '\\n');",
    "    process.stdout.write(JSON.stringify({type:'result',is_error:false,session_id:'fake-ses',stop_reason:'end_turn'}) + '\\n');",
    "  }, 150);",
    "});",
  ].join('\n'));
  const PERSISTENT_PORT = GATEWAY_PORT + 70;
  const persistentEnv = { ...process.env, P3394_GATEWAY_PORT: String(PERSISTENT_PORT), P3394_GATEWAY_HOME: path.join(tmp, 'persistent-home'), COGSEED_ENDPOINT: 'http://127.0.0.1:' + COGSEED_PORT, P3394_AGENT: 'claude', P3394_AGENT_MODE: 'sscli', P3394_AGENT_CLI: 'node', P3394_AGENT_CLI_ARGS: persistentAgent, P3394_HEARTBEAT_MS: '0', FAKE_PERSISTENT_PID: persistentPidFile, FAKE_PERSISTENT_LOG: persistentLog };
  const persistentGw = spawn('node', [path.join(__dirname, '..', 'gateway.cjs')], { env: persistentEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let persistentGwLog = '';
  persistentGw.stdout.on('data', (c) => { persistentGwLog += c; });
  persistentGw.stderr.on('data', (c) => { persistentGwLog += c; });
  await sleep(900);
  check('claude 常驻：默认启用（runtime: claude-persistent）', persistentGwLog.includes('runtime: claude-persistent'));
  const psMsg = { message_id: 'ps1', session_id: 's-persistent', task_id: 'pstk1', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'claude' }], payload: { parts: [{ type: 'text', text: 'first round' }] }, idempotency_key: 'idem-ps1' };
  await request(PERSISTENT_PORT, 'POST', '/p3394/envelope', { envelope: psMsg }, GATEWAY_TOKEN);
  for (let i = 0; i < 50 && !received.some((e) => e.session_id === 's-persistent' && e.kind === 'message'); i += 1) await sleep(100);
  const psDeltas = received.filter((e) => e.kind === 'event' && e.session_id === 's-persistent' && e.payload && e.payload.metadata && e.payload.metadata.stream_event === 'delta').map((e) => (e.payload.parts[0].text || '')).join('');
  check('claude 常驻：第一轮 delta 实时回发', psDeltas.includes('PERSISTENT-1'));
  check('claude 常驻：第一轮终态 = 累积文本', received.some((e) => e.session_id === 's-persistent' && e.kind === 'message' && (e.payload.parts[0].text || '').includes('PERSISTENT-1:first round')));
  // 第二轮：进程必须复用（pid 只记一次、argv 只记一次），且不带 [会话历史]
  // 前缀（进程内上下文自动延续）。
  const psMsg2 = { message_id: 'ps2', session_id: 's-persistent', task_id: 'pstk2', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'claude' }], payload: { parts: [{ type: 'text', text: 'follow up' }] }, idempotency_key: 'idem-ps2' };
  await request(PERSISTENT_PORT, 'POST', '/p3394/envelope', { envelope: psMsg2 }, GATEWAY_TOKEN);
  for (let i = 0; i < 50 && received.filter((e) => e.session_id === 's-persistent' && e.kind === 'message').length < 2; i += 1) await sleep(100);
  let psPids = [];
  let psArgvs = [];
  try { psPids = fs.readFileSync(persistentPidFile, 'utf8').split('\n').filter(Boolean); } catch {}
  try { psArgvs = fs.readFileSync(persistentLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  check('claude 常驻：多轮复用同一进程（只 spawn 一次）', psPids.length === 1 && psArgvs.length === 1);
  check('claude 常驻：第二轮不带 [会话历史] 前缀', !JSON.stringify(psArgvs[0] || []).includes('[会话历史]'));
  check('claude 常驻：第二轮终态仍正常', received.some((e) => e.session_id === 's-persistent' && e.kind === 'message' && (e.payload.parts[0].text || '').includes('PERSISTENT-2:follow up')));
  // 取消：常驻进程必须被终止（pid 回收），且会话被丢弃。
  const psMsg3 = { message_id: 'ps3', session_id: 's-persistent', task_id: 'pstk3', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'claude' }], payload: { parts: [{ type: 'text', text: 'long task' }] }, idempotency_key: 'idem-ps3' };
  await request(PERSISTENT_PORT, 'POST', '/p3394/envelope', { envelope: psMsg3 }, GATEWAY_TOKEN);
  await sleep(400);
  const psCtl = { message_id: 'ps4', session_id: 's-persistent', task_id: 'pstk3', kind: 'control', performative: 'cancel', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'claude' }], payload: { parts: [{ type: 'text', text: 'cancel' }] }, idempotency_key: 'idem-ps-ctl' };
  await request(PERSISTENT_PORT, 'POST', '/p3394/envelope', { envelope: psCtl }, GATEWAY_TOKEN);
  await sleep(400);
  check('claude 常驻：取消回执', received.some((e) => e.session_id === 's-persistent' && (e.payload.parts[0].text || '') === '[已取消]'));
  let psPidGone = true;
  const lastPid = Number(psPids[0] || 0);
  if (lastPid > 0) {
    try { process.kill(lastPid, 0); psPidGone = false; } catch { /* ESRCH → 已回收 */ }
  }
  check('claude 常驻：取消终止常驻进程（pid 已回收）', lastPid > 0 && psPidGone);
  // 取消后队列必须不卡死：被取消轮次的 deliver promise 若不被 reject，串行
  // 队列会被挂起任务永久阻塞（回归：cancel 曾只置 turn=null 不 reject）。
  const psMsg4 = { message_id: 'ps5', session_id: 's-persistent', task_id: 'pstk4', kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'claude' }], payload: { parts: [{ type: 'text', text: 'after cancel' }] }, idempotency_key: 'idem-ps4' };
  await request(PERSISTENT_PORT, 'POST', '/p3394/envelope', { envelope: psMsg4 }, GATEWAY_TOKEN);
  for (let i = 0; i < 50 && !received.some((e) => e.session_id === 's-persistent' && e.kind === 'message' && (e.payload.parts[0].text || '').includes('after cancel')); i += 1) await sleep(100);
  check('claude 常驻：取消后队列不卡死（新消息正常回复）', received.some((e) => e.session_id === 's-persistent' && e.kind === 'message' && (e.payload.parts[0].text || '').includes('PERSISTENT-1:after cancel')));
  persistentGw.kill('SIGTERM');

  gateway.kill('SIGTERM');
  cogseedServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) {
    console.error('FAILED: ' + failures.join(', '));
    console.error(gatewayLog);
    console.error(sscliGwLog);
    console.error('=== streamJsonGwLog ===');
    console.error(streamJsonGwLog);
    console.error('=== persistentGwLog ===');
    console.error(persistentGwLog);
    try { console.error('=== psPids: ' + fs.readFileSync(persistentPidFile, 'utf8')); } catch {}
    try { console.error('=== psArgvs: ' + fs.readFileSync(persistentLog, 'utf8')); } catch {}
    process.exit(1);
  }
  console.log('ALL PASS');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
