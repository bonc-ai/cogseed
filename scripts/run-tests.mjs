#!/usr/bin/env node
/**
 * Run Vitest with Electron's embedded Node runtime.
 *
 * The application loads native addons such as better-sqlite3 under Electron.
 * Running tests under the same runtime keeps one native ABI in node_modules and
 * avoids rebuilding the addon before and after every test run.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaultWorkerLimit } from './test-worker-args.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const electronBin = require_('electron');
const vitestBin = resolve(here, '..', 'node_modules', 'vitest', 'vitest.mjs');

const forwardedArgs = withDefaultWorkerLimit(process.argv.slice(2));

// `convert-source-map` crashes on malformed inline sourceMappingURL comments
// (tsx dist bundles are a known offender) and Vitest calls it without a
// try/catch while rendering error stacks — one bad file turns a green suite
// into an unhandled SyntaxError. The guard degrades those parses to "no
// sourcemap". It must load before Vitest's own imports, so it is injected
// twice: `--require` for the Vitest main process and NODE_OPTIONS so forked
// workers and helper node processes inherit it too. Loading twice is a no-op.
const sourcemapGuard = resolve(here, 'test-env', 'convert-source-map-guard.cjs');
// 信号退出护栏：vitest 回收 worker 时发 SIGTERM/SIGINT，Node 默认处理走
// `process.exit()` → C++ 静态析构（worker 里已加载 onnxruntime/tokenizers）抛异常
// → std::terminate → abort，每次全量跑留下十几份假「Electron 崩溃」报告。护栏把
// 已被要求终止的进程直接升级成 SIGKILL（无析构、无报告）。见该文件头注释。
const signalGuard = resolve(here, 'test-env', 'child-signal-guard.cjs');
const nodeOptions = [
  process.env.NODE_OPTIONS,
  `--require=${sourcemapGuard}`,
  `--require=${signalGuard}`,
].filter(Boolean).join(' ');

const child = spawn(electronBin, ['--require', sourcemapGuard, '--require', signalGuard, vitestBin, ...forwardedArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Test files that need to launch standalone JS helpers must not reuse
    // Electron's process.execPath: if they replace the child environment and
    // drop ELECTRON_RUN_AS_NODE, macOS launches another GUI app. Preserve the
    // outer npm/node executable as the explicit test-helper runtime.
    COGSEED_TEST_NODE: process.execPath,
    NODE_OPTIONS: nodeOptions,
  },
});

let forwardedSignal = null;
const signalHandlers = new Map();

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers.clear();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  const handler = () => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    if (!child.killed) child.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

child.once('error', (error) => {
  removeSignalHandlers();
  console.error(`[run-tests] failed to start Electron's Node runtime: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  removeSignalHandlers();
  const terminalSignal = forwardedSignal || signal;
  if (terminalSignal) {
    process.kill(process.pid, terminalSignal);
    return;
  }
  process.exit(code ?? 1);
});
