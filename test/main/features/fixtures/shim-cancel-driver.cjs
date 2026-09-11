// PR209 评审 M6 复核返工回归 · shim cancel 驱动器
//
// 用法：node shim-cancel-driver.cjs <scenario>
//   scenario = hit        —— cancel(task_id) 命中在跑任务，断言真 kill（failed 帧）
//   scenario = no-kill    —— cancel(别的 task_id) 不得误杀；再 cancel(正确 task_id) 才 kill
//   scenario = request-id —— cancel 帧带 request_id（无 task_id 调用方兼容）也能命中
//
// 直接驱动 sscli-shim.cjs（p3394-sscli/1.0 JSONL 协议），假 CLI 为同目录
// shim-sleep-cli.cjs（跨平台挂起 30s、SIGTERM 可终结）。结果以单行 JSON
// 打到 stdout：{ ok, killed, misfire, error }，退出码 0/1 供测试断言。
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHIM = path.join(__dirname, '..', '..', '..', '..', 'p3394-gateway', 'sscli-shim.cjs');
const SLEEP_CLI = path.join(__dirname, 'shim-sleep-cli.cjs');
const scenario = String(process.argv[2] || '');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cancel-driver-'));
const treePidFile = path.join(home, 'tree-pids.txt');
const treeScenario = scenario.startsWith('tree-');

const child = spawn(process.execPath, [SHIM, '--exec', process.execPath, '--args', SLEEP_CLI, '--home', home], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ...(treeScenario ? { SHIM_TREE_PID_FILE: treePidFile } : {}),
    ...(scenario === 'tree-timeout' ? { P3394_AGENT_TIMEOUT_MS: '500' } : {}),
  },
});

let lineBuf = '';
const frames = [];
child.stderr.on('data', (c) => { process.stderr.write(String(c)); }); // shim 崩溃可见
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  lineBuf += chunk;
  const lines = lineBuf.split('\n');
  lineBuf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try { frames.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
  }
});

function send(frame) { child.stdin.write(JSON.stringify(frame) + '\n'); }
function deliver(requestId, taskId) {
  send({ op: 'deliver', request_id: requestId, task_id: taskId, session_id: 's-cancel-driver', message: { payload: { parts: [{ type: 'text', text: 'hello' }] } } });
}
function waitFor(pred, what, timeoutMs) {
  const hit = () => frames.find(pred);
  const existing = hit();
  if (existing) return Promise.resolve(existing);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      const f = hit();
      if (f) return resolve(f);
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for ' + what + '; frames=' + JSON.stringify(frames.slice(-5))));
      setTimeout(poll, 50);
    })();
  });
}
async function waitSilence(pred, withinMs) {
  const before = frames.length;
  await new Promise((r) => setTimeout(r, withinMs));
  return !frames.slice(before).some(pred);
}
function readTreePids() {
  try {
    return fs.readFileSync(treePidFile, 'utf8').split(/\r?\n/).filter(Boolean).map(Number).filter((pid) => pid > 0);
  } catch { return []; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitTreeGone(timeoutMs = 8000) {
  const pids = readTreePids();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(pidAlive)) await new Promise((resolve) => setTimeout(resolve, 100));
  return { pids, gone: pids.length === 2 && pids.every((pid) => !pidAlive(pid)) };
}
function cleanupTree() {
  for (const pid of readTreePids()) {
    if (!pidAlive(pid)) continue;
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      spawnSync(path.win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}
function finish(result) {
  try { child.stdin.end(); } catch { /* already gone */ }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  cleanupTree();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    result = { ...result, ok: false, error: 'cleanup failed: ' + ((error && error.message) || String(error)) };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

(async () => {
  try {
    send({ op: 'hello', protocol: 'p3394-sscli/1.0', request_id: 'h1' });
    await waitFor((f) => f.ok === true && f.request_id === 'h1', 'hello ack', 10000);

    if (scenario === 'hit') {
      deliver('r1', 't-target');
      await waitFor((f) => f.event === 'progress' && f.request_id === 'r1', '启动 progress', 10000);
      send({ op: 'cancel', request_id: 'c1', task_id: 't-target' });
      await waitFor((f) => f.ok === true && f.request_id === 'c1' && f.killed === true, 'cancel ack', 10000);
      const failed = await waitFor((f) => f.event === 'failed' && f.request_id === 'r1', 'cancelled failed', 10000);
      const errText = String((failed && failed.error) || '');
      finish({ ok: !errText.includes('timeout'), killed: true, misfire: false, error: errText });
    } else if (scenario === 'no-kill') {
      deliver('r2', 't-real');
      await waitFor((f) => f.event === 'progress' && f.request_id === 'r2', '启动 progress', 10000);
      send({ op: 'cancel', request_id: 'c2-miss', task_id: 't-other' });
      await waitFor((f) => f.ok === true && f.request_id === 'c2-miss' && f.killed === false, 'miss cancel ack', 10000);
      const untouched = await waitSilence((f) => f.event === 'failed' || f.event === 'completed', 1500);
      if (!untouched) { finish({ ok: false, killed: false, misfire: true, error: 'cancel 未命中却杀掉了在跑任务' }); return; }
      send({ op: 'cancel', request_id: 'c2-hit', task_id: 't-real' });
      await waitFor((f) => f.ok === true && f.request_id === 'c2-hit' && f.killed === true, 'hit cancel ack', 10000);
      await waitFor((f) => f.event === 'failed' && f.request_id === 'r2', 'cancelled failed', 10000);
      finish({ ok: true, killed: true, misfire: false, error: '' });
    } else if (scenario === 'request-id') {
      deliver('r3', 't3');
      await waitFor((f) => f.event === 'progress' && f.request_id === 'r3', '启动 progress', 10000);
      send({ op: 'cancel', request_id: 'r3' });
      await waitFor((f) => f.event === 'failed' && f.request_id === 'r3', 'cancelled failed', 10000);
      finish({ ok: true, killed: true, misfire: false, error: '' });
    } else if (scenario === 'tree-cancel') {
      deliver('rt1', 'tt1');
      await waitFor(() => readTreePids().length === 2, 'CLI + descendant pids', 10000);
      send({ op: 'cancel', request_id: 'ct1', task_id: 'tt1' });
      await waitFor((f) => f.ok === true && f.request_id === 'ct1' && f.killed === true, 'tree cancel ack', 10000);
      const pids = readTreePids();
      const tree = { pids, gone: pids.length === 2 && pids.every((pid) => !pidAlive(pid)) };
      finish({ ok: tree.gone, killed: true, misfire: false, treeGone: tree.gone, pids: tree.pids, error: tree.gone ? '' : 'cancel left a descendant alive' });
    } else if (scenario === 'tree-timeout') {
      deliver('rt2', 'tt2');
      await waitFor(() => readTreePids().length === 2, 'CLI + descendant pids', 10000);
      await waitFor((f) => f.event === 'failed' && f.request_id === 'rt2' && String(f.error || '').includes('timeout'), 'tree timeout failed frame', 10000);
      const pids = readTreePids();
      const tree = { pids, gone: pids.length === 2 && pids.every((pid) => !pidAlive(pid)) };
      finish({ ok: tree.gone, killed: true, misfire: false, treeGone: tree.gone, pids: tree.pids, error: tree.gone ? '' : 'timeout left a descendant alive' });
    } else {
      finish({ ok: false, killed: false, misfire: false, error: 'unknown scenario: ' + scenario });
    }
  } catch (err) {
    finish({ ok: false, killed: false, misfire: false, error: String((err && err.message) || err) });
  }
})();
