#!/usr/bin/env node
/**
 * dev 主进程守护 —— `npm run dev`
 *
 * 解决什么：`bootstrap.cjs` 用 tsx 在**进程启动那一刻**加载 `src/main/**\/*.ts`，
 * 而渲染层是普通 `.js`、每次刷新窗口都会重读磁盘。只刷新窗口不重启进程，就会出现
 * "界面是新代码、主进程是旧代码"的半更新：新参数被旧主进程静默忽略（真机事故：
 * kb.mindmap 的 `doc` 参数被忽略 → 整库脑图冒充"本文档脑图"，见 util/source-stamp.ts）。
 *
 * 本脚本盯 `src/main`（+ bootstrap.cjs）：有改动就把 Electron 子进程重启，
 * 让"忘记重启"这件事不存在。渲染层改动不需要重启主进程——打印提示让你 ⌘R 刷新即可
 * （渲染层刷新会重读磁盘，本来就是新的）。
 *
 * 用法：
 *   npm run dev
 *   npm run dev -- --remote-debugging-port=9334   # 额外参数直接透传给 Electron
 *
 * 数据根：源运行时由 package.json 的 `cogseedSourceRuntimeVariant` 锁定（=cogseed），
 * 本脚本不传 `--cogseed-runtime-variant`，因此选中的数据根与 `npm start` / run.sh
 * 完全一致（`~/.cogseed/runtime-variants/cogseed`），不会看到"空库"。
 *
 * 说明：本脚本直接把 `node_modules/electron` 的二进制当子进程跑（而不是走
 * run.sh），这样重启时可以精确 kill 这一棵子进程树；run.sh 的依赖自愈逻辑
 * 仍由 `npm start` / 应用内「立即重启」通道保留。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PC_ROOT = path.resolve(__dirname, '..');
const DEBOUNCE_MS = 400;

function log(msg) {
  process.stdout.write(`[dev-watch] ${msg}\n`);
}

let electronBin;
try {
  electronBin = require('electron'); // 该包导出二进制绝对路径
} catch {
  log('找不到 electron 依赖，请先在仓库根目录执行 npm install');
  process.exit(1);
}
if (typeof electronBin !== 'string') {
  log('electron 依赖未返回二进制路径，请检查 node_modules/electron');
  process.exit(1);
}

/** 参与判定的目录：主进程源码改动 ⇒ 必须重启进程。 */
const MAIN_WATCH_DIRS = ['src/main'];
/** 只需刷新窗口的目录（打印提示，不重启）。 */
const RENDERER_WATCH_DIRS = ['src/renderer'];
const MAIN_WATCH_FILES = ['bootstrap.cjs'];

let child = null;
let restarting = false;
let timer = null;
let pendingReason = '';
let shuttingDown = false;

function startApp() {
  const passthrough = process.argv.slice(2);
  log(`启动 electron . ${passthrough.join(' ')}`.trim());
  child = spawn(electronBin, ['.', ...passthrough], {
    cwd: PC_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (restarting || shuttingDown) return;
    // 用户自己退出了应用（⌘Q）→ 守护进程一起收工，不留后台孤儿
    log(`应用已退出（code=${code} signal=${signal}），守护进程随之退出`);
    process.exit(typeof code === 'number' ? code : 0);
  });
}

function scheduleRestart(reason) {
  pendingReason = reason;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (!child || shuttingDown) return;
    restarting = true;
    const pid = child.pid;
    log(`检测到 ${pendingReason} 改动 → 重启主进程（pid ${pid}）`);
    const done = () => {
      restarting = false;
      child = null;
      if (shuttingDown) return;
      startApp();
    };
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch { done(); }
    // 兜底：3s 内没退出就强杀，避免守护进程卡死
    setTimeout(() => {
      if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, 3000);
  }, DEBOUNCE_MS);
}

/** fs.watch 的 recursive 在 macOS / Windows 可用；Linux 需轮询，故这里给出明确提示。 */
function watchDirs(dirs, onEvent) {
  for (const rel of dirs) {
    const abs = path.join(PC_ROOT, rel);
    try {
      if (!fs.existsSync(abs)) continue;
      fs.watch(abs, { recursive: true }, () => onEvent(rel));
    } catch (err) {
      log(`无法监听 ${rel}（${err && err.message ? err.message : err}）；Linux 请改用文件数较少的子目录或手动重启`);
    }
  }
}

startApp();

watchDirs(MAIN_WATCH_DIRS, (rel) => scheduleRestart(rel));
for (const rel of MAIN_WATCH_FILES) {
  try {
    const abs = path.join(PC_ROOT, rel);
    if (fs.existsSync(abs)) fs.watch(abs, () => scheduleRestart(rel));
  } catch { /* 忽略：单个文件监听失败不影响主目录监听 */ }
}
watchDirs(RENDERER_WATCH_DIRS, (rel) => {
  if (timer || restarting) return; // 正在重启主进程时不必再提示
  log(`${rel} 有改动：渲染层刷新窗口即可生效（⌘R / Ctrl+R），无需重启主进程`);
});

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('收到退出信号，关闭应用…');
  if (child) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
