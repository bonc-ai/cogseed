/**
 * embed worker 子进程卫生：崩溃报告的根因回归。
 *
 * 真机形态（2026-09-24 一天九份 Electron .ips）：
 *   CheckImmediate → TriggerUncaughtException → Environment::Exit → exit()
 *   → __cxa_finalize_ranges → std::terminate → abort()
 * 即「一个异步回调里抛了未捕获异常，进程退出时原生模块（onnxruntime）析构再抛」。
 * 来源是 embed worker：模型初始化要数秒，期间父进程 kill 掉它/关闭读端，此后
 * 写 ready/fatal 拿到 EPIPE —— 旧入口是 `void main()`，没人接住这个 rejection。
 *
 * 这里锁两件事：
 *   1) 护栏语义（注入式单测）：父进程消失=正常谢幕 exit 0；真错误仍 exit 1 但
 *      只留一行可诊断信息，不走 Node 默认的未捕获异常路径。
 *   2) 真进程对照：同一个「父进程先掐断读端，子进程再写」场景，没有护栏的脚本
 *      以非零退出（真机上因 ORT 已加载进一步 abort），装了护栏的以 0 退出。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { installEmbedWorkerGuards, runEmbedWorkerMain } from '../../../src/main/features/kb_embed_worker_guards';

const REPO = process.cwd();
const GUARDS_MODULE = path.join(REPO, 'src/main/features/kb_embed_worker_guards.ts');
// vitest 本身跑在 Electron 二进制里（ELECTRON_RUN_AS_NODE=1）。帮助脚本必须用
// 外层 node（run-tests.mjs 已经导出 COGSEED_TEST_NODE），否则 macOS 会再起一个
// GUI 应用——这正是另一个崩溃报告的来源。
const NODE = process.env.COGSEED_TEST_NODE || process.execPath;

/** 用注入的事件源/exit 观察护栏行为。 */
function harness() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const stdoutHandlers = new Map<string, (arg?: unknown) => void>();
  const stdinHandlers = new Map<string, (arg?: unknown) => void>();
  const exits: number[] = [];
  const reports: string[] = [];
  const kills: string[] = [];
  const target = {
    on(event: string, listener: (arg?: unknown) => void) { handlers.set(event, listener); return target; },
    stdout: { on(event: string, listener: (arg?: unknown) => void) { stdoutHandlers.set(event, listener); return target.stdout; } },
    stdin: { on(event: string, listener: (arg?: unknown) => void) { stdinHandlers.set(event, listener); return target.stdin; } },
  };
  installEmbedWorkerGuards({
    processLike: target,
    exit: (code) => exits.push(code),
    report: (message) => reports.push(message),
    killImmediately: () => kills.push('kill'),
  });
  return { handlers, stdoutHandlers, stdinHandlers, exits, reports, kills };
}

describe('embed worker guards — 父进程消失即正常谢幕', () => {
  it('treats a broken stdout pipe as "peer is gone" and terminates without exit()', () => {
    const h = harness();
    h.stdoutHandlers.get('error')?.({ code: 'EPIPE' });
    expect(h.kills).toEqual(['kill']);
    expect(h.exits).toEqual([]);      // 不走带 C++ 析构的 exit 路径（真机 abort 就在那条路上）
    expect(h.reports).toEqual([]);
    // 同类：流已销毁 / 写后已结束。
    h.stdoutHandlers.get('error')?.({ code: 'ERR_STREAM_DESTROYED' });
    h.stdoutHandlers.get('error')?.({ code: 'ERR_STREAM_WRITE_AFTER_END' });
    expect(h.kills).toEqual(['kill', 'kill', 'kill']);
  });

  it('still fails loudly on a real stdout error', () => {
    const h = harness();
    h.stdoutHandlers.get('error')?.(new Error('EACCES: permission denied'));
    expect(h.exits).toEqual([1]);
    expect(h.reports[0]).toContain('stdout error');
    expect(h.reports[0]).toContain('EACCES');
  });

  it('terminates immediately when stdin closes (parent gone) or on SIGTERM/SIGINT', () => {
    const h = harness();
    h.stdinHandlers.get('end')?.();
    expect(h.kills).toEqual(['kill']);
    h.handlers.get('SIGTERM')?.();
    h.handlers.get('SIGINT')?.();
    // 真机栈：SIGTERM → Node 默认 process.exit() → 原生析构 → abort。这里必须
    // 绕过 exit 路径（SIGKILL），而不是优雅 exit(0)。
    expect(h.kills).toEqual(['kill', 'kill', 'kill']);
    expect(h.exits).toEqual([]);
  });

  it('never lets an uncaught exception / unhandled rejection take the default abort path', () => {
    const h = harness();
    h.handlers.get('uncaughtException')?.(new Error('boom'));
    h.handlers.get('unhandledRejection')?.(new Error('rejected'));
    expect(h.exits).toEqual([1, 1]);
    expect(h.reports).toEqual([
      'uncaught exception: Error: boom',
      'unhandled rejection: Error: rejected',
    ]);
  });

  it('wraps main() so its rejection is diagnosable instead of unhandled', async () => {
    const exits: number[] = [];
    const reports: string[] = [];
    await runEmbedWorkerMain(async () => { throw new Error('init exploded'); }, {
      exit: (code) => exits.push(code),
      report: (message) => reports.push(message),
    });
    expect(exits).toEqual([1]);
    expect(reports).toEqual(['worker main failed: Error: init exploded']);
  });

  it('does not touch a healthy main()', async () => {
    const exits: number[] = [];
    await runEmbedWorkerMain(async () => {}, { exit: (code) => exits.push(code) });
    expect(exits).toEqual([]);
  });
});

function childScript(body: string, opts: { guards: boolean } = { guards: false }): string {
  const prelude = opts.guards
    ? `require(require.resolve('tsx/cjs', { paths: [process.cwd()] }));
const { installEmbedWorkerGuards } = require(${JSON.stringify(GUARDS_MODULE)});
installEmbedWorkerGuards();`
    : '';
  return `${prelude}\n${body}`;
}

function runChild(script: string) {
  const child = spawn(NODE, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

// 说明（已实测证伪的一条假设，留档免得再走一遍）：`process.stdout` 的 EPIPE
// **不会**杀掉 Node 子进程（装了/不装护栏都一样 exit 0）——所以「EPIPE 触发
// 未捕获异常」不能解释真机上那批 abort 报告，护栏的价值在下面这条**真实**路径：
// 未处理的 rejection 会让 Node 以未捕获异常退出（真机上进程已加载 onnxruntime，
// 该退出路径进一步 abort）；装了护栏则是可诊断的一行 + exit 1。
const UNHANDLED_REJECTION = 'Promise.reject(new Error("boom-unhandled")); setTimeout(() => {}, 4000);';

describe('embed worker guards — 真进程对照（未处理的 rejection）', () => {
  it('without guards it dies with the default noisy uncaught dump', async () => {
    const result = await runChild(childScript(UNHANDLED_REJECTION, { guards: false }));
    expect(result.code, JSON.stringify(result)).not.toBe(0);
    expect(result.stderr).toMatch(/UnhandledPromiseRejection|unhandled rejection|boom-unhandled/);
  }, 20_000);

  it('with guards it is a diagnosable single line and a clean exit 1', async () => {
    const result = await runChild(childScript(UNHANDLED_REJECTION, { guards: true }));
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('unhandled rejection: Error: boom-unhandled');
  }, 20_000);
});

describe('embed worker entry wiring', () => {
  const entry = fs.readFileSync(path.join(REPO, 'src/main/features/kb_embed_worker_entry.ts'), 'utf8');

  it('installs the guards before main() and wraps main instead of voiding it', () => {
    expect(entry).toMatch(/installEmbedWorkerGuards\(\);\s*void runEmbedWorkerMain\(main\);/);
    // 旧写法（`void main();`）正是没人接住 rejection 的地方。
    expect(entry).not.toMatch(/^void main\(\);/m);
  });
});
