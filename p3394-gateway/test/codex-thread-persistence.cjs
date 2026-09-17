#!/usr/bin/env node
/**
 * CodexAppServerRuntime 会话持久化回归测试（2026-09-11 修复）：
 * 网关重启（threads 内存清空）后，同一 P3394 会话必须 thread/resume 续接
 * 原 thread，而不是 thread/start 换新原生会话。
 *
 * 三个断言：
 *  1. 首次 deliver（无盘绑定）→ thread/start，成功后 cli-session.json 落盘；
 *  2. 新实例（模拟网关重启）→ thread/resume 用盘上 id，不再 thread/start；
 *  3. resume 被拒（rollout 已删等）→ 清盘回退 thread/start，并写回新 id。
 *
 * 运行：node test/codex-thread-persistence.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'gateway.cjs'), 'utf8');

// 从 gateway.cjs 提取依赖函数与类源码（与 smoke.cjs 的 vm 提取法同风格）。
function extract(name, kind = 'function') {
  const marker = kind === 'class' ? `class ${name} ` : `function ${name}(`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('extract failed: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { return src.slice(start, j + 1); } }
  }
  throw new Error('unbalanced: ' + name);
}

const GATEWAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-codex-persist-'));
const sandbox = {
  fs, path,
  console: { warn() {}, error() {}, log() {} },
  process: { env: { P3394_GATEWAY_HOME: GATEWAY_HOME } },
  setTimeout: () => 0, clearTimeout() {},
};
// readCliSession/writeCliSession/clearCliSession/sessionDir 引用模块级
// GATEWAY_HOME 常量——把提取的函数与该常量一起求值进同一沙箱。
vm.runInNewContext(
  `const GATEWAY_HOME = ${JSON.stringify(GATEWAY_HOME)};`
  + `const AGENT_ID = 'codex';`
  + extract('sessionDir')
  + extract('cliSessionFile')
  + extract('readCliSession')
  + extract('writeCliSession')
  + extract('clearCliSession')
  + extract('CodexAppServerRuntime', 'class')
  + `
    globalThis.__factory = {
      sessionDir, readCliSession, writeCliSession, clearCliSession,
      makeRuntime: () => {
        const r = new CodexAppServerRuntime();
        r.start = async () => {}; // 不 spawn 真进程
        return r;
      },
    };
  `,
  sandbox,
);
const { makeRuntime, sessionDir, readCliSession } = sandbox.__factory;

// _request stub：记录调用序列，按 script 返回结果。
function stubRequests(runtime, script) {
  const calls = [];
  runtime._request = async (method, params) => {
    calls.push({ method, params });
    const step = script.find((s) => s.method === method && !s.used) || script.find((s) => s.method === method);
    if (!step) throw new Error('unexpected method: ' + method);
    if (step.reject) throw new Error(step.reject);
    return typeof step.result === 'function' ? step.result(params) : step.result;
  };
  return calls;
}
// deliver 的 promise 由 pending 的 turn 完成结算——stub 手动 resolve。
function settleTurn(runtime) {
  for (const [, entry] of runtime.pending) entry.resolve({});
}

(async () => {
  const SESSION = 'ses-regression-1';
  let failed = 0;
  const check = (name, cond, detail) => {
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ← ' + String(detail)));
    if (!cond) failed++;
  };

  // ── 1. 首次 deliver：thread/start + 落盘 ──
  {
    const rt = makeRuntime();
    const calls = stubRequests(rt, [
      { method: 'thread/start', result: { thread: { id: 'thread-AAA' } } },
      { method: 'turn/start', result: {} },
    ]);
    const p = rt.deliver(SESSION, 'msg-1', 'hello', {}, () => {}, () => {});
    settleTurn(rt); await p.catch(() => {});
    check('首次 deliver 走 thread/start', calls.some((c) => c.method === 'thread/start'));
    const saved = readCliSession(SESSION);
    check('threadId 落盘 cli-session.json', !!saved && saved.sessionId === 'thread-AAA', JSON.stringify(saved));
  }

  // ── 2. 网关重启（新实例）：thread/resume 续接，不再 start ──
  {
    const rt = makeRuntime(); // 内存 threads 为空 = 重启后
    const calls = stubRequests(rt, [
      { method: 'thread/resume', result: { thread: { id: 'thread-AAA' } } },
      { method: 'turn/start', result: {} },
    ]);
    const p = rt.deliver(SESSION, 'msg-2', 'again', {}, () => {}, () => {});
    settleTurn(rt); await p.catch(() => {});
    const resume = calls.find((c) => c.method === 'thread/resume');
    check('重启后走 thread/resume', !!resume);
    check('resume 用盘上的原 threadId', resume && resume.params.threadId === 'thread-AAA', JSON.stringify(resume && resume.params));
    check('未再 thread/start', !calls.some((c) => c.method === 'thread/start'));
    check('turn 用续接的 threadId', calls.find((c) => c.method === 'turn/start' && c.params.threadId === 'thread-AAA') != null);
  }

  // ── 3. resume 被拒：清盘回退 start，写回新 id ──
  {
    const rt = makeRuntime();
    const calls = stubRequests(rt, [
      { method: 'thread/resume', reject: 'no rollout found for thread id thread-AAA' },
      { method: 'thread/start', result: { thread: { id: 'thread-BBB' } } },
      { method: 'turn/start', result: {} },
    ]);
    const p = rt.deliver(SESSION, 'msg-3', 'third', {}, () => {}, () => {});
    settleTurn(rt); await p.catch(() => {});
    check('resume 被拒后回退 thread/start', calls.some((c) => c.method === 'thread/start'));
    const saved = readCliSession(SESSION);
    check('盘上更新为新 threadId', !!saved && saved.sessionId === 'thread-BBB', JSON.stringify(saved));
  }

  console.log(failed ? `\nFAIL: ${failed} 项断言未过` : '\nPASS: codex thread 持久化回归全过');
  fs.rmSync(GATEWAY_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
