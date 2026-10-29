/**
 * 子进程信号退出护栏的回归（真机 2026-09-24 那批 Electron 崩溃报告的根因）。
 *
 * 报告证据（19 份同栈）：
 *   uv__signal_event → (JS 信号回调) → node::Environment::Exit → exit()
 *      → __cxa_finalize_ranges → std::terminate → abort()
 *   `Parent Process: Electron [82030]` = vitest worker（Electron-as-node）。
 * 链路：vitest 回收 worker → SIGTERM → Node 默认处理 process.exit() → C++ 静态
 * 析构（worker 已加载 onnxruntime/tokenizers）抛异常 → abort。
 *
 * 这里用真进程锁行为差异：终止信号到达后，装护栏的进程是 **SIGKILL**（无析构、
 * 无 crash report），不装的是 Node 默认的 SIGTERM 退出。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = process.cwd();
const GUARD = path.join(REPO, 'scripts/test-env/child-signal-guard.cjs');
const NODE = process.env.COGSEED_TEST_NODE || process.execPath;
const IS_WINDOWS = process.platform === 'win32';

function spawnThenSignal(opts: { guard: boolean; signal: NodeJS.Signals; delayMs?: number }) {
  const args = opts.guard ? ['--require', GUARD, '-e', 'setTimeout(() => {}, 10000);'] : ['-e', 'setTimeout(() => {}, 10000);'];
  // 关键：runner 已把护栏写进 NODE_OPTIONS，子进程会继承。基线用例必须显式清空，
  // 才代表"修复前"的行为（否则两条路径都被护栏变成 SIGKILL，对照失效）。
  const child = spawn(NODE, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    setTimeout(() => { try { child.kill(opts.signal); } catch { /* 已退出 */ } }, opts.delayMs ?? 150);
  });
}

// Windows 上这套行为断言不成立：那里没有 POSIX 信号投递，`child.kill(sig)` 走
// TerminateProcess 直接结束进程——子进程的 JS 信号回调**从不执行**（所以护栏
// 无从升级、更观察不到 SIGKILL），退出事件上报的是**请求的那个信号名**
// （`{ code: null, signal: 'SIGTERM' }`）。这条护栏只针对 POSIX 的
// `process.exit()` → C++ 静态析构路径，Windows 没有这条路径。护栏的接线（下面
// 那个 describe，读源码断言）照旧全平台约束。
describe.skipIf(IS_WINDOWS)('child signal guard — 终止信号不走带 C++ 析构的 exit 路径', () => {
  it('without the guard SIGTERM takes Node’s default exit path', async () => {
    const result = await spawnThenSignal({ guard: false, signal: 'SIGTERM' });
    expect(result.signal, JSON.stringify(result)).toBe('SIGTERM');
  }, 20_000);

  it('with the guard the process is killed immediately (no exit(), no finalizers)', async () => {
    const result = await spawnThenSignal({ guard: true, signal: 'SIGTERM' });
    // 关键差异：不是 SIGTERM（默认处理会 process.exit → 原生析构 → abort），
    // 而是不可捕获的 SIGKILL。
    expect(result.signal, JSON.stringify(result)).toBe('SIGKILL');
  }, 20_000);

  it('also covers SIGINT (Ctrl-C / pool interrupt)', async () => {
    const result = await spawnThenSignal({ guard: true, signal: 'SIGINT' });
    expect(result.signal, JSON.stringify(result)).toBe('SIGKILL');
  }, 20_000);

  it('never preempts another listener (vitest 自己的优雅退出必须仍然生效)', async () => {
    // 本护栏用 --require 早于 vitest 加载；如果它抢掉信号，Ctrl-C 会从"优雅收尾 +
    // 打印摘要"退化成硬杀。有人接管时它必须让位：让子进程自己收尾并以 0 退出。
    const script = `
      const fs = require('fs');
      process.on('SIGTERM', () => { fs.writeFileSync(process.env.MARKER_FILE, 'graceful'); process.exit(0); });
      setTimeout(() => {}, 10000);
    `;
    const marker = path.join(REPO, '.tmp-signal-guard-marker');
    try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }
    const child = spawn(NODE, ['--require', GUARD, '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', MARKER_FILE: marker },
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
      setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }, 150);
    });
    expect(result, JSON.stringify(result)).toEqual({ code: 0, signal: null });
    expect(fs.readFileSync(marker, 'utf8')).toBe('graceful');
    fs.rmSync(marker, { force: true });
  }, 20_000);

  it('can be switched off for coverage/interrupt debugging', async () => {
    const child = spawn(NODE, ['--require', GUARD, '-e', 'setTimeout(() => {}, 10000);'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', COGSEED_TEST_SIGNAL_GUARD: '0' },
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
      setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }, 150);
    });
    // 关掉之后回到 Node 默认语义（SIGTERM 直接终止），不再升级为 SIGKILL。
    expect(result.signal, JSON.stringify(result)).toBe('SIGTERM');
  }, 20_000);
});

describe('child signal guard — runner 接线', () => {
  const runner = fs.readFileSync(path.join(REPO, 'scripts/run-tests.mjs'), 'utf8');

  it('injects the guard for the vitest process and for every forked worker', () => {
    expect(runner).toMatch(/const signalGuard = resolve\(here, 'test-env', 'child-signal-guard\.cjs'\)/);
    // NODE_OPTIONS 让 worker 继承；主进程自身同样先加载。
    expect(runner).toMatch(/--require=\$\{signalGuard\}/);
    expect(runner).toMatch(/'--require', signalGuard, vitestBin/);
  });

  it('escalates to SIGKILL without stealing other listeners, and stays opt-outable', () => {
    const guard = fs.readFileSync(GUARD, 'utf8');
    expect(guard).toMatch(/process\.kill\(process\.pid, 'SIGKILL'\)/);
    expect(guard).toMatch(/for \(const signal of IMMEDIATE_SIGNALS\)/);
    // 让位给 vitest 自己的处理；绝不清空别人的监听。
    expect(guard).toMatch(/if \(process\.listenerCount\(signal\) > 1\) return;/);
    expect(guard).not.toMatch(/process\.removeAllListeners\(/);
    expect(guard).toContain("COGSEED_TEST_SIGNAL_GUARD !== '0'");
  });
});
