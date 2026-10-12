/**
 * CogSeed — Electron main entry.
 *
 * Boot sequence:
 *   1. `bootstrap.cjs` resolves the install
 *      container (`~/.cogseed` on macOS/Linux; on Windows a drive recorded
 *      in `%LOCALAPPDATA%\CogSeed\install-pin.json`), runs the one-shot
 *      `PC/data` → `<container>/data` migration, and sets
 *      `COGSEED_WORKSPACE_ROOT` before tsx loads this module. Source variants
 *      use separate containers; packaged builds use the stable main path.
 *      See install-data-root.cjs for the pre-TypeScript boot contract.
 *   2. Pin CORE_AGENT_AUTH_DIR to <WS_ROOT>/config/ so core-agent's
 *      credential store lives under data/ (local-only, never synced).
 *      The env var name is core-agent's public API — kept as
 *      `AUTH_DIR` for stability even though the dir now also holds
 *      `user.json` and `web-search-cache.json`.
 *   3. Create BrowserWindow loading renderer/index.html.
 *   4. IPC handlers serve invoke + stream calls from the renderer.
 *
 * File location: `PC/src/main/index.ts`. `bootstrap.cjs`'s
 * `require('./src/main')` resolves here automatically via Node's
 * folder → index resolution rule. `__dirname` points at `PC/src/main/`;
 * cross-tree references to renderer / resources go through
 * `paths.SRC_ROOT` — never splice `__dirname` directly.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, net, protocol, session, shell, type MenuItemConstructorOptions, type NativeImage, type WebContents } from 'electron';
import { resolveRuntimeIdentity } from './brand';
import { desktopPlatform, osVersion } from './system_info';
import {
  hardenedWebPreferences,
  installDenyAllRemotePermissionGate,
  installExternalNavigationGuard,
  installMainRendererAudioPermissionGate,
  installWecomQuickCreatePopupGuard,
  isOfficialWecomQuickCreateUrl,
} from './util/window-security';
import { formatBuildIdentityLabel, resolveBuildIdentity } from './util/build-identity';
import { buildStaleMainReport } from './util/source-stamp';
import { resolveContainedProtocolFile } from './util/protocol-path';

const WINDOWS_TASK_BADGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPklEQVR4nGNgoAX4jwNQpJkoQ2CK3ru4YMV4DSGkGa8hxGrGacioAVQwgOJopEpCQjcEF8CrmZAhRGkmFQAAcdLnkJb3ml4AAAAASUVORK5CYII=';
const PACKAGED_LAUNCH_SMOKE_FILE = app.isPackaged
  ? String(process.env.COGSEED_PACKAGED_LAUNCH_SMOKE_FILE || '').trim()
  : '';
const IS_PACKAGED_LAUNCH_SMOKE = !!PACKAGED_LAUNCH_SMOKE_FILE;
const PACKAGED_STT_SMOKE_FILE = app.isPackaged && process.platform === 'win32'
  ? String(process.env.COGSEED_PACKAGED_STT_SMOKE_FILE || '').trim()
  : '';
const PACKAGED_STT_SMOKE_WAV = app.isPackaged && process.platform === 'win32'
  ? String(process.env.COGSEED_PACKAGED_STT_SMOKE_WAV || '').trim()
  : '';
if (!!PACKAGED_STT_SMOKE_FILE !== !!PACKAGED_STT_SMOKE_WAV) {
  throw new Error('packaged STT smoke requires both marker and WAV paths');
}
if (PACKAGED_LAUNCH_SMOKE_FILE && PACKAGED_STT_SMOKE_FILE) {
  throw new Error('packaged launch and STT smoke modes are mutually exclusive');
}
const IS_PACKAGED_STT_SMOKE = !!PACKAGED_STT_SMOKE_FILE;
const IS_PACKAGED_SMOKE = IS_PACKAGED_LAUNCH_SMOKE || IS_PACKAGED_STT_SMOKE;
if (IS_PACKAGED_STT_SMOKE) {
  if (!path.isAbsolute(PACKAGED_STT_SMOKE_WAV) || !fs.existsSync(PACKAGED_STT_SMOKE_WAV)) {
    throw new Error('packaged STT smoke WAV path must name an existing absolute file');
  }
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', PACKAGED_STT_SMOKE_WAV);
}
const MARKETPLACE_DEFAULTS_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
// ── Hub 内容检查节奏（specs/010 FR-034 `[FROZEN]`；PRD doc-v0.5 §7.3 第 212 行）──
// 契约原文：「启动后 60 秒、在线期间每 6 小时、用户打开目录页时……失败 30 分钟后重试一次，
// 再失败等下一周期。检查不打断用户，不弹阻断式窗口。」
// ⚠️ 基线实测为 12 小时且无周期定时器、无失败重试——**未满足该冻结要求**，此处改为契约值。
const MARKETPLACE_SERVER_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后首次检查的延迟。 */
const MARKETPLACE_STARTUP_CHECK_DELAY_MS = 60 * 1000;
/** 失败后**只**重试一次；再失败等下一周期。 */
const MARKETPLACE_CHECK_RETRY_DELAY_MS = 30 * 60 * 1000;
/**
 * 版本副本回收的启动期延迟。
 *
 * 刻意排在检查之后：`specs/010` FR-052 要求**不在检查周期或使用高峰内触发**，
 * 回收是纯磁盘清理，没有任何时效性。
 */
const MARKETPLACE_VERSION_GC_DELAY_MS = 5 * 60 * 1000;
const MARKETPLACE_DEFAULTS_RETRY_DELAYS_MS = [3_000, 3_000, 3_000] as const;

const RUNTIME_IDENTITY = resolveRuntimeIdentity(app.isPackaged);
app.setName(RUNTIME_IDENTITY.appName);
if (IS_PACKAGED_SMOKE) {
  const marker = PACKAGED_STT_SMOKE_FILE || PACKAGED_LAUNCH_SMOKE_FILE;
  app.setPath('userData', path.join(path.dirname(marker), 'user-data'));
} else if (!app.isPackaged) {
  const container = String(process.env.COGSEED_RUNTIME_CONTAINER || '').trim();
  if (!container) throw new Error('COGSEED_RUNTIME_CONTAINER was not initialized');
  app.setPath('userData', path.join(container, 'electron-user-data'));
}

// Register the KB file protocol BEFORE `app.whenReady()` — privileged
// schemes can't be added after. `kb-file://kb/<relpath>` serves a single
// file out of the current active user's `<uid>/cloud/contexts/`;
// `kb-file://space/<spaceId>/<relpath>` serves a space-library file from
// that space's contexts dir. Used by the renderer's PDF iframe (Chromium's
// built-in PDFium handles `.pdf` directly when served via a standard
// scheme). Other bytes types fall back to `shell.openPath`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kb-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // `chat-media://cid/<encCid>/<encName>` — serves image + video bytes for a
  // cid attachment. Sent attachments resolve under cloud/chat_attachments/;
  // composer-only draft cids resolve under local/chat_attachment_drafts/.
  // `stream:true`
  // only enables a streamed Response body — it does NOT make Chromium issue
  // byte-range requests on its own; the handler must advertise
  // `Accept-Ranges: bytes` and serve `206` itself (see `serveFileRange`).
  // Without that, `<video preload="metadata">` freezes a few seconds in
  // because Chromium can't resume past the cancelled metadata-probe fetch.
  {
    scheme: 'chat-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // `chat-app://cid/<encCid>/<encArtifactId>/<relpath>` serves chat artifacts;
  // `chat-app://saved/<encAppId>/<relpath>` serves user-kept "My Apps" bundles.
  // Both are embedded in sandboxed iframes.
  // `standard:true` gives the iframe a real origin (`chat-app://cid`) so it
  // can use `<script type="module">` / same-origin `fetch` of sibling files /
  // `localStorage`; `secure:true` lets the `file://` renderer frame it
  // without a mixed-content block (same as `kb-file://`). `stream:true` for
  // the Range-aware streamed body (see `serveFileRange`).
  {
    scheme: 'chat-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // `cogseed-plugin://<pkgName>/<relpath>` serves a plugin-provided UI
  // (manifest `ui.entry`) out of the installed package dir, embedded in a
  // sandboxed iframe. Same privilege reasoning as `chat-app://`: standard
  // origin for module scripts / same-origin fetch, secure so the file://
  // renderer can frame it, stream for Range-aware bodies. The reserved
  // relpath `__cogseed/plugin-bridge.js` is served from memory, not disk.
  {
    scheme: 'cogseed-plugin',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

import * as paths from './paths';
import { parseByteRange } from './util/http-range';
import {
  configureBootAdmission,
  noteBootUserActivity,
  registerDeferred,
  registerImmediate,
  runBootPhases,
} from './util/boot_init';
import { getBootDeviceProfile } from './util/boot-device-profile';
import * as updaterClient from './features/updater/client';
import { evaluateBootGuard, markBootHealthy } from './features/updater/boot_guard';
import * as updatesIpc from './ipc/updates';

// `CORE_AGENT_AUTH_DIR` is pinned per-uid by `features/users.activateUser()`
// (runs inside `runBootSelfCheck` below). `resolveAuthDir()` in core-agent
// re-reads the env on every call so switching at runtime is safe.

// Skill runner env vars (COGSEED_NODE / COGSEED_PC_DIR / ELECTRON_RUN_AS_NODE)
// are injected per-call into the bash-tool sandbox by
// `model/core-agent/client.ts::buildSkillSandboxEnv()`. Do NOT set them on
// `process.env` here: the sandbox strips parent env anyway, and
// `ELECTRON_RUN_AS_NODE` would leak to Electron's own GPU/Renderer/Utility
// helpers (crashing the app at boot: "GPU process isn't usable. Goodbye.").

import * as storage from './storage';
import { initLogger, createLogger } from './logger';
initLogger();
const log = createLogger('cogseed');
const marketplaceBootLog = createLogger('marketplace_boot');

// Replay any pin / migration warnings buffered by install-data-root
// (which runs before logger.ts can be imported) into the daily log.
import { flushEarlyDiagnostics } from './install-data-root.cjs';
{
  const installLog = createLogger('install-data-root');
  flushEarlyDiagnostics((m) => installLog.warn(m));
}

// Raise Anthropic / OpenAI SDK default timeouts before any feature (which may
// transitively pull in pi-ai) loads them. See sdk-timeout-patch.ts.
import { installSdkTimeoutPatch } from './model/core-agent/sdk-timeout-patch';
installSdkTimeoutPatch();

// Keep SSE as the preferred model transport, but do not let a provider-local
// response-header failfast preempt CogSeed' own turn-level abort/watchdog policy.
import { installSseHeaderTimeoutPatch } from './model/core-agent/sse-header-timeout-patch';
installSseHeaderTimeoutPatch();

// Provider-fetch diagnostics: dump the real undici cause chain for model
// endpoint failures.
import { installFetchDiag } from './model/core-agent/fetch-diag';
installFetchDiag();

import { setFetchImplementation } from './util/retry';
setFetchImplementation((input, init) => net.fetch(input as Parameters<typeof net.fetch>[0], init));

import { prompts } from './prompts/loader';
import * as ipc from './ipc';
import * as users from './features/users';
import { maybeStartP3394Bridge, stopP3394Bridge, type P3394AppBridgeHandle } from './features/p3394_bridge/app-wiring';

let p3394AppBridge: P3394AppBridgeHandle | null = null;
import * as skillsFeature from './features/skills';
import * as agentsFeature from './features/agents';
import * as contextsFeature from './features/contexts';
import * as chatsFeature from './features/chats';
import * as searchFeature from './features/search';
import * as projectFilesFeature from './features/project_files';
import * as appConfig from './features/config';
import { getRendererBootTables } from './i18n';
import * as reflectionOrchestrator from './features/reflection-orchestrator';
import * as autoTasks from './features/auto_tasks';
import * as systemSkills from './features/system_skills';
import * as builtinMarketplaceStartup from './features/builtin_marketplace_startup';
import * as builtinPackagesStartup from './features/builtin_packages_startup';
import type { BuiltinMarketplaceSeedResult } from './features/builtin_marketplace';
import * as chatAttachments from './features/chat_attachments';
import * as spacesFeature from './features/spaces';
import * as chatArtifacts from './features/chat_artifacts';
import * as clientConfigFeature from './features/client_config';
import * as connectorsFeature from './features/connectors';
import * as messagingFeature from './features/messaging';
import * as taskNotifications from './features/task_notifications';
import { shouldHideOnClose, startBackgroundRun, type BackgroundRun, type TrayMenuItemSpec } from './features/background_run';
import * as cogseedBackend from './features/cogseed_backend';
import { recoverRecallCaptures, startRecallCaptureOrchestrator } from './features/recall/capture-service';
import { startAutoCloseRecovery, startGroupKstarClosure } from './features/kstar/task-closure';
import { startGroupChatRecallTerminalProofs } from './features/group_chat/recall-terminal-proof';
import { startTaskAutoArchiveOrchestrator } from './features/kb_task_auto_archive';
import * as notificationPermissions from './features/notification_permissions';
import {
  consumeColdLaunchConnectorCallback,
  registerConnectorProtocol,
} from './features/connectors/protocol';
import * as windowState from './features/window_state';
// Server-backed account, multi-device sync, remote-control relay, and
// auto-update features are stripped in the open-source build. Connectors remain available
// through the open server bridge.

let windowsTaskBadgeIcon: ReturnType<typeof nativeImage.createFromDataURL> | null = null;
let mainRendererAudioPermissionObservation = { checkCount: 0, requestCount: 0 };
let mainRendererWebContents: WebContents | null = null;

/**
 * 主窗口引用。托盘/任务通知/activate/second-instance 都要"呼出主窗口本身"，
 * 不能靠 `getAllWindows()[0]`——弹窗（如 wecom quick-create 分区窗口）也在
 * 那个列表里，会被抓错。
 */
let mainWindow: BrowserWindow | null = null;

/**
 * 一旦进入任何退出流程就置位。`before-quit` 是托盘退出 / Cmd+Q /
 * `updates.install`（installer.ts 走 app.quit()）的共同上游；Windows 关机不走
 * `before-quit`，另由主窗口上的 `session-end` 监听兜底（`session-end` 是
 * BrowserWindow 事件，Electron 没有 `app.on('session-end')`）。
 * 因此它是唯一可靠的信号：有了它，close 处理器才不会把"退出"拦成"隐藏"，
 * 否则 app.quit() 会被中止，分离安装助手等不到父进程退出而超时。
 */
let isQuitting = false;
let backgroundRun: BackgroundRun | null = null;

function setTaskNotificationBadgeCount(count: number): void {
  const normalized = Math.max(0, Math.trunc(count));
  if (process.platform === 'win32') {
    if (normalized > 0 && !windowsTaskBadgeIcon) {
      windowsTaskBadgeIcon = nativeImage.createFromDataURL(WINDOWS_TASK_BADGE_DATA_URL);
    }
    const overlay = normalized > 0 ? windowsTaskBadgeIcon : null;
    const description = normalized > 0 ? `${normalized} unread task notification${normalized === 1 ? '' : 's'}` : '';
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setOverlayIcon(overlay, description);
    }
    return;
  }
  app.setBadgeCount(normalized);
}

/**
 * 呼出主窗口的唯一实现：优先用主窗口引用，只有它已销毁时才回退到
 * "第一个存活窗口 / 新建窗口"。返回被呼出的窗口，调用方常需要它继续发送数据。
 */
function showMainWindow(): BrowserWindow {
  const win = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow
    : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) || createWindow();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

/** `background_run` 的菜单项规格 → Electron 模板项。纯映射，便于单测。 */
function toTrayTemplate(items: TrayMenuItemSpec[]): MenuItemConstructorOptions[] {
  return items.map((item) => ({
    label: item.label,
    enabled: item.enabled,
    ...(item.click ? { click: item.click } : {}),
  }));
}

function createWindow(): BrowserWindow {
  // 幂等：已经有存活的主窗口就直接把它显示出来。second-instance 在 app ready
  // 之后、启动流程建窗之前（boot 自检 + 版本迁移期间）会经 showMainWindow()
  // 建出窗口 A，随后启动流程再调一次本函数——没有这段就会建出窗口 B 并覆盖
  // mainWindow，泄漏第二个渲染进程、第二个音频权限门和一个再也够不着的孤儿窗口。
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  const dev = !app.isPackaged || !!process.env.COGSEED_ONBOARDING_ALWAYS; // Force dev mode when testing onboarding
  const restored = windowState.restoreWindowState();
  // This is deliberately not a `persist:` partition. The official remote
  // creator gets a memory-only browser session, separate from the app UI.
  const wecomPopupPartition = `wecom-quick-create-${randomUUID()}`;
  installDenyAllRemotePermissionGate(session.fromPartition(wecomPopupPartition));
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...restored.bounds,
    title: '',
    // macOS: hiddenInset 标题栏——无原生标题栏（也就没有分割线），红绿灯
    // 悬浮在内容上，窗口拖拽区由渲染层 CSS（.is-macos 各视图顶部条）声明。
    // Windows 保持原生 frame。
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      // Keep the native controls centered in the shared 52px Renderer
      // titlebar, on the same axis as the shell navigation tools.
      trafficLightPosition: { x: 12, y: 19 },
    } : {}),
    // Windows Chromium can deny or throttle fake media capture in a fully
    // hidden background window. The STT verifier is a CI-only, short-lived
    // run, so keep that window active until it records its private marker.
    show: !IS_PACKAGED_SMOKE || IS_PACKAGED_STT_SMOKE,
    backgroundColor: '#ffffff',
    icon: path.join(paths.SRC_ROOT, 'resources', 'icons', 'icon.png'),
    webPreferences: hardenedWebPreferences({
      // preload sits next to index.ts in PC/src/main/ — just __dirname + 'preload.js'.
      preload: path.join(__dirname, 'preload.js'),
      devTools: dev,
      backgroundThrottling: !IS_PACKAGED_STT_SMOKE,
      additionalArguments: IS_PACKAGED_STT_SMOKE
        ? ['--cogseed-packaged-stt-smoke']
        : (IS_PACKAGED_LAUNCH_SMOKE ? ['--cogseed-packaged-launch-smoke'] : []),
      // Enables Chromium's built-in PDF viewer (PDFium) inside iframes.
      // Required for `<iframe src="kb-file:///.../report.pdf">` in the KB
      // viewer. Has no effect on other plugin types since Electron strips
      // the NPAPI / NaCl code path.
      plugins: true,
    }),
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Windows 关机/注销不会经过 `app.quit()`，所以 `before-quit` 不是唯一上游，
  // 这里单独兜底。两个事件都绑：`query-session-end` 是可取消的更早信号，
  // `session-end` 一旦触发就无法阻止、也不保证与 `close` 的先后顺序，谁先到
  // 都能把 isQuitting 置位，close 才不会在那之后被拦成隐藏。注意二者都是
  // BrowserWindow 的事件（`@platform win32`），Electron 没有 `app.on('session-end')`；
  // 主窗口就是被 close 拦截的那个窗口，因此挂在它上面覆盖相同范围。
  win.on('query-session-end', () => { isQuitting = true; });
  win.on('session-end', () => { isQuitting = true; });

  // 关闭按钮拦截：只剩"隐藏到托盘"这一种改写。最小化按钮本身不被改写（这里不
  // preventDefault、也不 hide），只是被当成"进入后台"观察——见下面 minimize/restore
  // 两个监听器。注意 `event.preventDefault()` 只阻止"关闭窗口"这个默认
  // 动作，不会阻止本窗口其它 `close` 监听器——下面 `watchWindowState` 注册的
  // 几何保存 `saveNow` 照常执行，所以"隐藏而非关闭"这条路径下窗口位置尺寸
  // 仍然持久化，不要为了它去跳过 hide。
  win.on('close', (event) => {
    if (!shouldHideOnClose({
      isQuitting,
      closeToTray: appConfig.getCloseToTrayEnabled(),
      // 托盘没建起来就不能藏窗口：藏了就再没有入口把它叫回来。
      // 这里在 close 时读取（而非建窗时），所以与托盘启动的先后顺序无关。
      trayAvailable: backgroundRun?.isAvailable() ?? false,
    })) return;
    event.preventDefault();
    try {
      win.hide();
      backgroundRun?.setForeground(false);
      backgroundRun?.notifyHidden();
    } catch {
      // 隐藏失败绝不能留下一个"已被 veto、还开着、又再也不会被显示"的窗口：
      // 直接销毁它，让这次关闭照常完成。
      win.destroy();
    }
  });

  // 托盘、任务栏、dock 或 showMainWindow() 把窗口叫回来时停表并作废计数：窗口可见时
  // 状态行没有意义，也没有必要每 5 s 读一次运行时状态。模块初始即前台，所以启动时这
  // 一次 show 是空操作。
  win.on('show', () => backgroundRun?.setForeground(true));
  // 最小化是最常见的"把应用放到一边"，它只发 `minimize` 不发 `hide`：不在这里切到后台
  // 状态，窗口就会一边显示"前台、不轮询"、一边真的不在前台，托盘计数从此冻结。
  win.on('minimize', () => backgroundRun?.setForeground(false));
  win.on('restore', () => backgroundRun?.setForeground(true));

  windowState.watchWindowState(win);
  if (restored.isMaximized) win.maximize();

  const rendererFile = path.join(paths.SRC_ROOT, 'renderer', 'index.html');
  mainRendererWebContents = win.webContents;
  mainRendererAudioPermissionObservation = installMainRendererAudioPermissionGate(
    session.defaultSession,
    win.webContents,
    pathToFileURL(rendererFile).toString(),
  );
  win.loadFile(rendererFile);

  // A completed main-window load is this app's "genuinely usable" signal: the
  // window is shown at creation and has no `ready-to-show` handler, and the
  // renderer only stops parsing here. The post-upgrade boot guard holds its
  // marker until this point, so a start that dies before the UI renders counts
  // as a failed upgrade attempt.
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      markMainWindowHealthy();
    } catch (err) {
      log.warn('boot health mark failed', { error: (err as Error)?.message });
    }
  });

  // Block HTML <title> from populating the native titlebar — we want a
  // frame-only look (drag works, but no label across the top).
  win.on('page-title-updated', (e) => e.preventDefault());

  // External links in chat bubbles / knowledge base / settings always open
  // in the system default browser:
  //   - `target="_blank"` / `window.open()`  → setWindowOpenHandler
  //   - `<a href>` clicks without a target   → will-navigate (otherwise
  //     Electron navigates the current window away and replaces the UI).
  // The guard opens only safe HTTP(S) targets and blocks every other
  // top-level navigation. Explicit mail/phone links use the validated IPC
  // path instead of weakening this final security boundary.
  installExternalNavigationGuard(
    win.webContents,
    (url) => shell.openExternal(url),
    (err) => log.warn('openExternal failed', { error: (err as Error)?.message || String(err) }),
    {
      allowWindowOpen: isOfficialWecomQuickCreateUrl,
      allowedWindowOpenOptions: {
        width: 520,
        height: 650,
        resizable: false,
        maximizable: false,
        minimizable: true,
        title: 'WeCom',
        webPreferences: hardenedWebPreferences({
          // Remote auth content deliberately gets an empty preload rather
          // than the renderer bridge used by the application window.
          preload: path.join(__dirname, 'wecom-popup-preload.js'),
          partition: wecomPopupPartition,
        }),
      },
    },
  );

  // An allowed popup is intentionally limited to the official quick-create
  // URL. It has no bridge API, cannot spawn further windows, and cannot turn
  // into an arbitrary in-app browser if the remote page redirects.
  win.webContents.on('did-create-window', (popup, details) => {
    if (!isOfficialWecomQuickCreateUrl(details.url)) {
      popup.close();
      return;
    }
    popup.setMenuBarVisibility(false);
    installWecomQuickCreatePopupGuard(popup.webContents);
  });

  // Hijack Cmd/Ctrl+R / F5 uniformly:
  //   - Packaged: refresh disabled (the App doesn't need reload).
  //   - Dev: force reloadIgnoringCache so that after editing
  //     renderer/*.css or *.js, Cmd+R picks up the new version directly —
  //     no need to hand-bump the `?v=` cache-busting suffix in renderer.
  //   - Cmd/Ctrl+Shift+R is NOT intercepted here: it's the renderer-side
  //     devtools "relaunch" chord (calls `app.relaunch()`), so we let it
  //     fall through to renderer keydown.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.shift) return;
    const k = (input.key || '').toLowerCase();
    const mod = input.meta || input.control;
    const isReload = (mod && k === 'r') || k === 'f5';
    if (!isReload) return;
    event.preventDefault();
    if (dev) win.webContents.reloadIgnoringCache();
  });

  return win;
}

function openConversationFromTaskNotification(
  conversationId: string,
  status: import('./features/group_chat/bus').TaskTerminalStatus,
): void {
  if (!storage.safeId(conversationId)) {
    log.warn('task notification carried invalid conversation id');
    return;
  }

  const win = showMainWindow();

  const send = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('conversations:open-from-notification', {
      conversation_id: conversationId,
      terminal_status: status,
    });
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function registerIpc(): void {
  ipc.register();

  ipcMain.handle('cogseed.ping', () => {
    return { ok: true, pong: 'pong', ts: storage.nowIso() };
  });

  if (IS_PACKAGED_LAUNCH_SMOKE) {
    let recorded = false;
    ipcMain.handle('cogseed.packagedLaunchSmokeReady', (event, payload) => {
      if (recorded) return { ok: true };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const readyState = String(payload?.rendererReadyState || '');
      if (!owner || owner.isDestroyed()) throw new Error('launch smoke sender is not an active BrowserWindow');
      if (payload?.preloadLoaded !== true || payload?.ping !== 'pong') {
        throw new Error('launch smoke preload/IPC proof is incomplete');
      }
      if (readyState !== 'interactive' && readyState !== 'complete') {
        throw new Error(`launch smoke renderer is not ready: ${readyState || '(missing)'}`);
      }
      const appAsar = path.join(process.resourcesPath, 'app.asar');
      // Electron's patched `fs` exposes an ASAR as a virtual directory, so
      // stat().isFile() is false even for a healthy physical archive. Prove
      // the archive is present and that this running main module was actually
      // resolved from inside it.
      const mainLoadedFromAsar = __dirname.split(path.sep).includes('app.asar');
      if (!fs.existsSync(appAsar) || !mainLoadedFromAsar) {
        throw new Error(`launch smoke main process was not loaded from app.asar: ${appAsar}`);
      }
      const record = {
        status: 'ready',
        appIsPackaged: app.isPackaged,
        appAsar: true,
        preloadLoaded: true,
        rendererLoaded: true,
        ipcPing: 'pong',
        rendererReadyState: readyState,
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        readyAt: new Date().toISOString(),
      };
      const marker = path.resolve(PACKAGED_LAUNCH_SMOKE_FILE);
      const temp = `${marker}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, marker);
      recorded = true;
      setImmediate(() => app.quit());
      return { ok: true };
    });
  }

  if (IS_PACKAGED_STT_SMOKE) {
    let recorded = false;
    ipcMain.handle('cogseed.packagedSttSmokeReady', (event, payload) => {
      if (recorded) return { ok: true };
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed() || event.sender !== mainRendererWebContents) {
        throw new Error('STT smoke sender is not the active main renderer');
      }
      const isNonNegativeInteger = (value: unknown): value is number => (
        typeof value === 'number' && Number.isInteger(value) && value >= 0
      );
      const isNonNegativeNumber = (value: unknown): value is number => (
        typeof value === 'number' && Number.isFinite(value) && value >= 0
      );
      const numericPayloadValid = isNonNegativeInteger(payload?.sampleCount)
        && isNonNegativeInteger(payload?.nonZeroSampleCount)
        && isNonNegativeNumber(payload?.rms)
        && isNonNegativeInteger(payload?.pushAcknowledgements)
        && isNonNegativeInteger(payload?.finalTextLength)
        && isNonNegativeInteger(payload?.failureCount);
      const safeInteger = (value: unknown): number => (isNonNegativeInteger(value) ? value : 0);
      const safeNumber = (value: unknown): number => (isNonNegativeNumber(value) ? value : 0);
      const safeFailureStage = (value: unknown): string => (
        typeof value === 'string' && /^[a-z_]+$/.test(value) ? value : 'invalid'
      );
      const record = {
        schemaErrorCode: numericPayloadValid ? 0 : 1,
        appIsPackaged: app.isPackaged,
        permissionCheckCount: mainRendererAudioPermissionObservation.checkCount,
        permissionRequestCount: mainRendererAudioPermissionObservation.requestCount,
        audioTrackLive: payload?.audioTrackLive === true,
        sampleCount: safeInteger(payload?.sampleCount),
        nonZeroSampleCount: safeInteger(payload?.nonZeroSampleCount),
        rms: safeNumber(payload?.rms),
        pushAcknowledgements: safeInteger(payload?.pushAcknowledgements),
        sessionCreated: payload?.sessionCreated === true,
        stopAcknowledged: payload?.stopAcknowledged === true,
        finalEventObserved: payload?.finalEventObserved === true,
        finalTextLength: safeInteger(payload?.finalTextLength),
        failureCount: safeInteger(payload?.failureCount),
        failureStage: safeFailureStage(payload?.failureStage),
      };
      const marker = path.resolve(PACKAGED_STT_SMOKE_FILE);
      const temp = `${marker}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, marker);
      recorded = true;
      setImmediate(() => app.quit());
      return { ok: true };
    });
  }

  ipcMain.handle('cogseed.env', () => {
    const systemVersion = osVersion();
    const platform = desktopPlatform();
    const buildIdentity = resolveBuildIdentity({
      env: process.env,
      packagedInfoPath: path.join(app.getAppPath(), '.build', 'build-info.json'),
    });
    const version = app.getVersion();
    // dev 半更新检测：bootstrap.cjs 用 tsx 在进程启动时加载 src/main/**/*.ts，
    // 而渲染层的 .js 每次刷新窗口都会重读磁盘。若磁盘上的 main 源码比本进程启动
    // 还新，就说明"界面已是新代码、主进程还是旧代码"——此时新参数会被旧主进程
    // 静默忽略（真机事故：kb.mindmap 的 doc 参数被忽略 → 整库脑图冒充本文档脑图）。
    // 详见 util/source-stamp.ts。
    const staleMain = buildStaleMainReport({ pcRoot: paths.PC_ROOT, isPackaged: app.isPackaged });
    return {
      ok: true,
      isDev: !app.isPackaged,
      isPackaged: app.isPackaged,
      version,
      versionLabel: formatBuildIdentityLabel(version, buildIdentity),
      buildChannel: buildIdentity.channel,
      buildCommit: buildIdentity.commit,
      buildDirty: buildIdentity.dirty,
      buildTime: buildIdentity.builtAt,
      ...staleMain,
      platform,
      osVersion: systemVersion,
      arch: process.arch,
    };
  });

  if (!app.isPackaged) {
    // The relaunch button shells out to run.sh / run.cmd instead of using
    // `app.relaunch()` so we can reuse `scripts/ensure-deps.cjs` for
    // dependency self-healing — otherwise pulling new code + relaunching
    // crashes immediately due to missing packages. The worktree-locked
    // launcher owns runtime selection and bundle preparation; here we only
    // detach-spawn it and exit so the instance lock can be released.
    ipcMain.handle('cogseed.relaunch', () => {
      const isWin = process.platform === 'win32';
      const script = path.join(paths.PC_ROOT, isWin ? 'run.cmd' : 'run.sh');
      const [cmd, args] = isWin
        ? ['cmd.exe', ['/d', '/s', '/c', `"${script}"`]] as const
        : ['bash',    [script]]                            as const;
      const relaunchEnv = { ...process.env };
      // bootstrap.cjs derives the data root from a clean process environment.
      // Do not pass the current instance's resolved paths back into the
      // launcher, otherwise the new process would either be rejected as an
      // inherited-root launch or attach to the old runtime's data.
      delete relaunchEnv.COGSEED_WORKSPACE_ROOT;
      delete relaunchEnv.COGSEED_RUNTIME_CONTAINER;
      delete relaunchEnv.CORE_AGENT_AUTH_DIR;
      const child = spawn(cmd, args, {
        cwd: paths.PC_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: relaunchEnv,
      });
      child.unref();
      log.info('relaunch via shell script', { script });
      // `app.exit(0)` 绕过 `before-quit`，托盘不会被销毁；Windows 会因此留下一个
      // 幽灵通知区图标，直到用户把鼠标划过去。先手动拆掉再退出。
      backgroundRun?.stop();
      app.exit(0);
      return { ok: true };
    });
  }

  // Synchronous boot bundle for the product UI i18n. Renderer's preload calls this via
  // `ipcRenderer.sendSync` BEFORE any DOM scripts run, so the renderer can
  // populate _currentLang + _tables synchronously at module load — first
  // paint shows the user's preferred interface language with no English flash. Using
  // sendSync (and not the async `config.getLanguage` IPC) is the whole point:
  // an async round-trip schedules a microtask, paint slips through. Only
  // the active UI language + fallback cross this synchronous boundary;
  // other locale tables load asynchronously if the user switches language.
  const handleBootI18n = (event) => {
    try {
      const lang = appConfig.getUiLanguage();
      event.returnValue = { ok: true, lang, tables: getRendererBootTables(lang) };
    } catch (err) {
      log.warn('bootI18n failed', { error: (err as Error)?.message });
      event.returnValue = { ok: false };
    }
  };
  ipcMain.on('cogseed:bootI18n', handleBootI18n);

  // Renderer reports throttled keyboard/pointer/wheel activity. Background
  // boot work uses this only as an admission hint; no interaction payload is
  // collected or persisted.
  ipcMain.on('cogseed.userActivity', () => noteBootUserActivity());

  ipcMain.handle('cogseed.diagnostics', async () => {
    const sample = {
      nowIso: storage.nowIso(),
      uid: storage.genUserId(),
      cid: storage.genConversationId(),
      safeIdValid: storage.safeId('abc-123_XYZ'),
      safeIdInvalid: storage.safeId('../etc/passwd'),
    };
    const tplNormal = prompts.load('chat_commander', {
      contexts_dir: 'X',
      builtin_agents_dir: 'X', custom_agents_dir: 'X',
      builtin_skills_dir: 'X', custom_skills_dir: 'X',
      agents_index: '', plan_state: '',
      os: 'X', working_dir: 'X', shell_hint: '', local_exec_state: 'X',
      output_format_hint: 'X',
      project_files_block: '',
    });
    const tplLen = tplNormal.length;
    const skills = await skillsFeature.listSkills();
    const agentsList = await agentsFeature.listAgents();
    const contextEntries = await contextsFeature.getContextIndexEntries();
    return {
      ok: true,
      env: {
        appRoot: paths.APP_ROOT,
        pcRoot: paths.PC_ROOT,
        wsRoot: paths.WS_ROOT,
        usersFile: paths.USERS_FILE,
      },
      storage: sample,
      prompts: {
        chatNormalBytes: tplLen,
        hasOrganize: prompts.exists('contexts_organize'),
      },
      skills: {
        total: skills.length,
        marketplace: skills.filter((s) => s.source === 'marketplace').length,
        custom: skills.filter((s) => s.source === 'custom').length,
        ids: skills.map((s) => `${s.source}:${s.id}`),
      },
      agents: {
        total: agentsList.length,
        ids: agentsList.map((a) => a.agent_id),
      },
      contexts: {
        total: contextEntries.length,
        entries: contextEntries.slice(0, 20),
      },
    };
  });
}

// ── Post-upgrade boot guard ──────────────────────────────────────────────
// The uid the guard judged during this app start, or null before it ran. The
// uid is read at use time and only remembered to keep the guard once-per-start
// and to mark the *judged* uid healthy (AGENTS.md: never cache a uid-derived
// path at module load).
let bootGuardUid: string | null = null;

/**
 * Run the post-upgrade boot guard once for the active uid.
 *
 * Safe to call from both the immediate boot batch and the main window's
 * `did-finish-load` hook: the first caller wins, so the marker is always seeded
 * before the healthy mark can clear it and attempts are never double-counted.
 */
function runBootGuardOnce(): void {
  let uid: string;
  try {
    uid = users.getActiveUserId();
  } catch {
    // No active user (failed or not-yet-finished activation): nothing to judge.
    return;
  }
  if (bootGuardUid === uid) return;
  bootGuardUid = uid;
  const verdict = evaluateBootGuard(uid, { currentVersion: app.getVersion() });
  if (verdict.installMissed) {
    // The record is deliberately retained (see boot_guard.ts): the installer may still
    // be running, and the retained record is what seeds from_version once it applies.
    log.warn('pending install did not take effect', {
      reason: verdict.reason,
      from: verdict.fromVersion,
      running: app.getVersion(),
    });
  } else if (verdict.unstable) {
    log.warn('upgrade considered unstable; auto-update must not re-install it', {
      from: verdict.fromVersion,
      to: verdict.toVersion,
    });
  }
}

/**
 * Mark the judged upgrade healthy from the main window's first completed load.
 *
 * Runs the guard first (in the same synchronous tick) so this can never clear a
 * marker the guard has not yet seeded; a window that reached this point is the
 * evidence that the upgrade really works.
 */
function markMainWindowHealthy(): void {
  runBootGuardOnce();
  if (!bootGuardUid) return;
  // The running version decides whether this healthy window verified the pending
  // install: on a premature relaunch it did not, and the record (with its
  // attempts) must survive (see boot_guard.ts::markBootHealthy).
  markBootHealthy(bootGuardUid, { currentVersion: app.getVersion() });
}

async function runBootSelfCheck(): Promise<void> {
  const diag = {
    appRoot: paths.APP_ROOT,
    wsRoot: paths.WS_ROOT,
    promptChatNormal: prompts.exists('chat_commander'),
    promptOrganize: prompts.exists('contexts_organize'),
  };
  log.info('boot self-check', diag);

  // Stage 1: activate the primary user — mkdirs `<uid>/{cloud,local}/*` and
  // pins `CORE_AGENT_AUTH_DIR` to `<uid>/local/config/`. Must run before any
  // feature touches user-scoped paths (every feature goes through
  // `getActiveUserId()`).
  try {
    // Source runtimes keep their development profile separate from the
    // packaged account pointer. This must be selected before reading
    // users.json so a runtime rename can restore its legacy dev profile.
    users.setUseDevCurrentUserId(!app.isPackaged);
    const rec = users.initActiveUser();
    log.info('active user', { user_id: rec.user_id });
  } catch (err) {
    log.error('failed to activate user', { error: (err as Error).message });
    throw err;
  }

  // Stage 1b: resolve the Commander/Agent response language from
  // `<uid>/cloud/config/preferences.json`, falling back to `app.getLocale()`
  // on first boot. UI language is initialized independently below.
  try {
    const lang = appConfig.initLanguageFromApp();
    const uiLang = appConfig.initUiLanguage();
    log.info('language preferences resolved', { lang, uiLang });
  } catch (err) { log.warn('i18n init failed', { error: (err as Error).message }); }

  // Stage 2: this is a pre-window correctness barrier, not background boot
  // maintenance. A fresh main process owns no live CogSeed executors, so
  // reconcile persisted work before the first window can present it as live.
  try {
    const { recoverCogSeedTasksAtBoot } = await import('./features/cogseed_backend/boot-recovery');
    const recovered = await recoverCogSeedTasksAtBoot(users.getActiveUserId());
    if (recovered.recoveredCount || recovered.workflowStepsReconciled
      || recovered.retainedResultsRecovered || recovered.retainedResultsPending) {
      log.info('CogSeed cold-start recovery complete', {
        recovered_tasks: recovered.recoveredCount,
        reconciled_workflows: recovered.workflowStepsReconciled || 0,
        retained_results_recovered: recovered.retainedResultsRecovered,
        retained_results_pending: recovered.retainedResultsPending,
      });
    }
  } catch (err) {
    log.error('CogSeed cold-start recovery failed', { error: (err as Error).message });
    throw err;
  }

  // Stage 3: clear stale processing=true conversations from a previous crash.
  try { await chatsFeature.sweepStaleProcessing(users.getActiveUserId()); }
  catch (err) { log.warn('chats sweep failed', { error: (err as Error).message }); }

}

async function runBootMaintenanceSweeps(): Promise<void> {
  // Full cross-user/unindexed recovery stays out of the pre-window self-check.
  try { await chatsFeature.sweepStaleProcessing(); }
  catch (err) { log.warn('full chats sweep failed', { error: (err as Error).message }); }

  // file_cache orphan sweep — stat-based maintenance, not needed before the
  // first BrowserWindow exists.
  try {
    const uid = users.getActiveUserId();
    if (uid) {
      const mod = await import('./features/file_indexer');
      const { deleted } = await mod.pruneOrphans(uid);
      if (deleted) log.info('file_cache pruned', { deleted });
    }
  } catch (err) { log.warn('file_cache sweep failed', { error: (err as Error).message }); }

  // Workspace empty-subdir sweep — clean up legacy per-conv slug dirs that
  // were materialised by bash's defensive mkdir on a turn that produced
  // nothing. Deferred boot is still safe: no in-flight bash process exists
  // this early in the app lifetime. Top-level scan only.
  try {
    const uid = users.getActiveUserId();
    if (uid) {
      const userWs = await import('./features/user_workspace');
      userWs.sweepEmptyConvDirs(uid);
    }
  } catch (err) { log.warn('workspace empty-dir sweep failed', { error: (err as Error).message }); }
}

let marketplaceReconcileStatusSubscribed = false;
let marketplaceReconcileInFlight: Promise<void> | null = null;
let marketplaceReconcileInFlightKey = '';
const marketplaceDefaultsRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 已安排的「失败后 30 分钟重试」定时器。同一时间最多一个，避免失败叠加成重试风暴。 */
let marketplaceCheckRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 安排一次失败重试（FR-034）。
 *
 * **只重试一次**：重试自身产生的失败不再安排新的重试，等下一个 6 小时周期。
 */
function scheduleMarketplaceCheckRetry(reason: string): void {
  if (reason === 'retry') return;
  if (marketplaceCheckRetryTimer) return;
  marketplaceCheckRetryTimer = setTimeout(() => {
    marketplaceCheckRetryTimer = null;
    runMarketplaceInstallReconcile('retry').catch(() => {
      // 重试失败只记在该函数内部的日志里；不再安排下一次。
    });
  }, MARKETPLACE_CHECK_RETRY_DELAY_MS);
  marketplaceCheckRetryTimer.unref?.();
}
const marketplaceDefaultsRetryAttempts = new Map<string, number>();

function subscribeMarketplaceReconcileStatus(m: typeof import('./features/marketplace_reconcile')): void {
  // 目录页打开时的检查触发点（FR-034）：编排在本文件，IPC 够不到，故在此注册进接缝。
  // 与状态订阅同一时机注册——两者都只需要「reconcile 模块已装载」这一个前提。
  m.setInstallReconcileRunner((reason) => runMarketplaceInstallReconcile(reason));
  if (marketplaceReconcileStatusSubscribed) return;
  marketplaceReconcileStatusSubscribed = true;
  m.subscribeReconcileStatus((status) => {
    ipc.broadcastToRenderer('marketplace:reconcile-status', status);
  });
}

function broadcastBuiltinMarketplaceSeedChanged(result: BuiltinMarketplaceSeedResult): void {
  const pulledAgents = Math.max(0, Number(result.seeded_agents || 0) + Number(result.manifest_agents || 0));
  const pulledSkills = Math.max(0, Number(result.seeded_skills || 0) + Number(result.manifest_skills || 0));
  const pulled = pulledAgents + pulledSkills;
  if (!pulled) return;
  const base = {
    phase: 'default_seed' as const,
    total: pulled,
    total_agents: pulledAgents,
    total_skills: pulledSkills,
    pulled_agents: pulledAgents,
    pulled_skills: pulledSkills,
    failed: [] as string[],
  };
  ipc.broadcastToRenderer('marketplace:reconcile-status', {
    ...base,
    state: 'running',
    pulled: 0,
    updated_at: Date.now(),
  });
  ipc.broadcastToRenderer('marketplace:reconcile-status', {
    ...base,
    state: 'done',
    pulled,
    updated_at: Date.now(),
  });
}

async function seedBuiltinMarketplaceForCurrentUser(
  reason: string,
  shouldContinue?: () => boolean,
): Promise<void> {
  await builtinMarketplaceStartup.seedBuiltinMarketplaceForActiveUser({
    reason,
    shouldContinue,
    onChanged: broadcastBuiltinMarketplaceSeedChanged,
  });
}

async function seedBuiltinPackagesForCurrentUser(
  reason: string,
  shouldContinue?: () => boolean,
): Promise<void> {
  await builtinPackagesStartup.seedBuiltinPackagesForActiveUser({ reason, shouldContinue });
}

function marketplaceBootContextStillActive(uid: string): boolean {
  if (!uid || users.isAnonymousLocalId(uid)) return false;
  try { return users.getActiveUserId() === uid; }
  catch { return false; }
}

function clearMarketplaceDefaultsRetry(runKey: string): void {
  const timer = marketplaceDefaultsRetryTimers.get(runKey);
  if (timer) clearTimeout(timer);
  marketplaceDefaultsRetryTimers.delete(runKey);
  marketplaceDefaultsRetryAttempts.delete(runKey);
}

function scheduleMarketplaceDefaultsRetry(runKey: string, uid: string, error: string): void {
  if (marketplaceDefaultsRetryTimers.has(runKey)) return;
  const attempt = marketplaceDefaultsRetryAttempts.get(runKey) || 0;
  const delayMs = MARKETPLACE_DEFAULTS_RETRY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    marketplaceBootLog.warn('marketplace default installs retry exhausted', { error });
    marketplaceDefaultsRetryAttempts.delete(runKey);
    return;
  }
  marketplaceDefaultsRetryAttempts.set(runKey, attempt + 1);
  const timer = setTimeout(() => {
    marketplaceDefaultsRetryTimers.delete(runKey);
    if (!marketplaceBootContextStillActive(uid)) {
      marketplaceDefaultsRetryAttempts.delete(runKey);
      return;
    }
    runMarketplaceInstallReconcile('marketplace-defaults-retry').catch((err) => {
      marketplaceBootLog.warn('marketplace default installs retry failed', {
        error: (err as Error).message,
      });
    });
  }, delayMs);
  timer.unref?.();
  marketplaceDefaultsRetryTimers.set(runKey, timer);
  marketplaceBootLog.info('scheduled marketplace default installs retry', {
    attempt: attempt + 1,
    delay_ms: delayMs,
    error,
  });
}

async function runMarketplaceInstallReconcile(reason: string): Promise<void> {
  const uid = users.getActiveUserId();
  if (!marketplaceBootContextStillActive(uid)) {
    marketplaceBootLog.info('skip marketplace reconcile: local user unavailable', { reason });
    return;
  }

  const runKey = uid;
  if (marketplaceReconcileInFlight && marketplaceReconcileInFlightKey === runKey) {
    await marketplaceReconcileInFlight;
    return;
  }

  const shouldContinue = (): boolean => marketplaceBootContextStillActive(uid);
  marketplaceReconcileInFlightKey = runKey;
  marketplaceReconcileInFlight = (async () => {
    let defaultSeedStatusActive = false;
    let marketplaceReconcileModule: typeof import('./features/marketplace_reconcile') | null = null;
    const clearDefaultSeedStatus = (): void => {
      if (marketplaceReconcileModule && defaultSeedStatusActive) {
        marketplaceReconcileModule.setDefaultInstallSeedStatus(false);
        defaultSeedStatusActive = false;
      }
    };

    try {
      const [mp, m] = await Promise.all([
        import('./features/marketplace'),
        import('./features/marketplace_reconcile'),
      ]);
      marketplaceReconcileModule = m;
      subscribeMarketplaceReconcileStatus(m);

      await seedBuiltinMarketplaceForCurrentUser(reason, shouldContinue);

      if (await mp.hasKnownDefaultInstallWork(uid)) {
        m.setDefaultInstallSeedStatus(true);
        defaultSeedStatusActive = true;
      }

      if (!shouldContinue()) {
        clearDefaultSeedStatus();
        return;
      }

      const forceMarketplaceNetwork = reason === 'marketplace-defaults-retry';
      const seeded = await mp.ensureDefaultInstalls(uid, {
        shouldContinue,
        minIntervalMs: forceMarketplaceNetwork ? 0 : MARKETPLACE_DEFAULTS_REFRESH_INTERVAL_MS,
        force: forceMarketplaceNetwork,
      });
      if (seeded.failed) {
        clearDefaultSeedStatus();
        scheduleMarketplaceDefaultsRetry(runKey, uid, seeded.error || 'unknown error');
      } else {
        clearMarketplaceDefaultsRetry(runKey);
      }
      if ((seeded.seeded_agents || seeded.seeded_skills) && !defaultSeedStatusActive) {
        m.setDefaultInstallSeedStatus(true);
        defaultSeedStatusActive = true;
      }

      if (!shouldContinue()) {
        clearDefaultSeedStatus();
        return;
      }

      await m.checkServerUpdatesForInstalls(uid, {
        shouldContinue,
        minIntervalMs: MARKETPLACE_SERVER_CHECK_INTERVAL_MS,
      });
      const result = await m.reconcileInstalls(uid, { shouldContinue });
      if (
        result.pulled_agents || result.pulled_skills
        || result.pruned_agents || result.pruned_skills
        || result.restored_agents || result.restored_skills
        || result.patched_agents || result.patched_skills
      ) {
        marketplaceBootLog.info('marketplace install reconcile completed', { reason, ...result });
      }
    } catch (err) {
      clearDefaultSeedStatus();
      marketplaceBootLog.warn('marketplace install reconcile failed', {
        reason,
        error: (err as Error).message,
      });
      // 失败 30 分钟后重试**一次**；重试本身再失败就等下一周期，不再叠加。
      // 不弹窗、不打断用户——失败只体现在日志与下一次检查。
      scheduleMarketplaceCheckRetry(reason);
    }
  })().finally(() => {
    if (marketplaceReconcileInFlightKey === runKey) {
      marketplaceReconcileInFlight = null;
      marketplaceReconcileInFlightKey = '';
    }
  });
  await marketplaceReconcileInFlight;
}

// `kb-file://<relpath>` — maps a KB-relative path to the active user's
// `<uid>/cloud/contexts/<relpath>` on disk and returns the bytes with an
// explicit Content-Type. Used by the renderer's PDF viewer iframe.
//
// Path extraction is string-based rather than via `new URL()`: Node's
// WHATWG URL parser and Chromium's request normalizer treat non-built-in
// schemes differently, and the resulting `pathname` values can diverge in
// subtle ways (leading slashes, host vs path split). Slicing after the
// scheme and stripping a variable number of slashes is the robust form.
const _KB_FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  // `.html/.htm` 必须在表里：缺了会回落到 `application/octet-stream`，
  // 浏览器把它当下载 → iframe 空白（"HTML 渲染不出排版"的根因）。
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.css': 'text/css; charset=utf-8',
  // 音视频：`<audio>/<video>` 需要正确的 MIME 才会播放（否则只显示加载失败）
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

/**
 * Stream a file on disk back through a `protocol.handle` callback with HTTP
 * Range support — shared by `kb-file://` and `chat-media://`.
 *
 * Why this exists: a `protocol.handle` reply that returns `200` + a
 * `Content-Length` but no `Accept-Ranges` makes Chromium treat the resource
 * as non-seekable. For `<video preload="metadata">` that is fatal — Chromium's
 * metadata probe fetches only the head of the file and then *cancels* its
 * request; when playback later runs past that prefetched head buffer it has no
 * way to resume (the resource is "not range-capable" and the original request
 * is gone), so the `<video>` freezes a few seconds in with no error in the UI.
 * Advertising `Accept-Ranges: bytes` + honouring `206` requests is the fix; it
 * also makes seeking work and lets PDFium fetch only the pages it shows.
 *
 * Also switches the body from `fs.readFileSync` — the old handlers buffered the
 * whole file into memory, so a 200 MB video spiked RSS by 200 MB — to a lazy
 * `fs.createReadStream`.
 *
 * `totalSize` is the caller's already-statted byte length, so we don't `stat`
 * the file a second time.
 */
function serveFileRange(
  request: Request,
  absPath: string,
  contentType: string,
  totalSize: number,
): Response {
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
  };
  const range = parseByteRange(request.headers.get('Range'), totalSize);

  if (range === 'unsatisfiable') {
    return new Response('requested range not satisfiable', {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${totalSize}` },
    });
  }

  const nodeStream = range
    ? fs.createReadStream(absPath, { start: range.start, end: range.end })
    : fs.createReadStream(absPath);
  nodeStream.on('error', (err) => {
    log.warn('media stream error', { absPath, error: (err as Error).message });
  });
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  if (range) {
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
        'Content-Length': String(range.end - range.start + 1),
      },
    });
  }
  return new Response(body, {
    headers: { ...baseHeaders, 'Content-Length': String(totalSize) },
  });
}

function registerKbFileProtocol(): void {
  protocol.handle('kb-file', async (request) => {
    const reqUrl = request.url;
    try {
      // Two route shapes, dispatched by URL host:
      //   kb-file://kb/<relpath>              — personal contexts file
      //   kb-file://space/<spaceId>/<relpath> — space-library file
      // The `kb` / `space` hosts are fixed fake hosts (see renderer
      // `_encodeKbFileUrl`). Tolerate older / unusual normalisations
      // (`kb-file://<seg>/...`, `kb-file:///…`) by extracting the pathname
      // via `new URL`; standard-scheme URLs parse cleanly once a host is
      // present.
      const uid = users.getActiveUserId();
      let root: string;
      let resolveUrl = reqUrl;
      let u: URL;
      try { u = new URL(reqUrl); }
      catch { return new Response('bad request', { status: 400 }); }
      if (u.host.toLowerCase() === 'space') {
        // spaceId is the first pathname segment; the remaining segments are
        // the file's relative path inside the space contexts dir.
        const segs = decodeURIComponent(u.pathname || '').replace(/^\/+/, '').split('/');
        const spaceId = segs.shift() || '';
        if (!spaceId || !storage.safeId(spaceId)) {
          log.warn('kb-file/space: bad spaceId', { reqUrl });
          return new Response('bad request', { status: 400 });
        }
        if (!segs.length) {
          log.warn('kb-file/space: missing relpath', { reqUrl });
          return new Response('bad request', { status: 400 });
        }
        if (!(await spacesFeature.spaceExists(uid, spaceId))) {
          log.warn('kb-file/space: no such space', { reqUrl, spaceId });
          return new Response('not found', { status: 404 });
        }
        root = path.resolve(paths.spaceContextsDir(uid, spaceId));
        // Rebuild a clean `kb-file://kb/<rel>` so resolveContainedProtocolFile
        // only sees the file-relative path (spaceId is consumed above).
        resolveUrl = 'kb-file://kb/' + segs.map(encodeURIComponent).join('/');
      } else {
        root = path.resolve(paths.userContextsDir(uid));
      }
      const resolved = resolveContainedProtocolFile(resolveUrl, 'kb-file', root);
      if (resolved.ok === false) {
        log.warn('kb-file: rejected', { reqUrl, code: resolved.error });
        return new Response(resolved.error.replace('_', ' '), { status: resolved.status });
      }
      const { absPath: abs, stat: st } = resolved;
      log.info('kb-file: serving', { reqUrl, abs, bytes: st.size });
      const ext = path.extname(abs).toLowerCase();
      const contentType = _KB_FILE_MIME[ext] || 'application/octet-stream';
      return serveFileRange(request, abs, contentType, st.size);
    } catch (err) {
      log.warn('kb-file serve failed', { reqUrl, error: (err as Error).message });
      return new Response('error', { status: 500 });
    }
  });
}

// `chat-media://cid/<encCid>/<encName>` — streams a single attachment file for
// the renderer's `<img>` / `<video>` tags. Sent attachments resolve under
// cloud/chat_attachments/; composer-only draft cids resolve under local drafts.
// The two-segment path (fixed host +
// cid + name) sidesteps URL-parser divergence the way `kb-file` does.
//
// All the safety work (name + cid validation, path-traversal guard, file
// existence + regular-file check, extension whitelist) lives inside
// `chat_attachments.resolveAttachmentAbsPath` so the same guard rails get
// unit-tested without spinning up Electron.
// Turn a URL pathname (always leading-slash, URL-encoded) into a real abs
// path on the running OS. On Windows pathnames like `/C:/Users/x/a.png`
// must have the leading `/` stripped to get the real drive-letter path.
// On Unix the pathname IS the abs path.
function _pathnameToAbsPath(pathname: string): string {
  const decoded = decodeURIComponent(pathname || '');
  if (process.platform === 'win32') {
    // Match `/X:/...` or `/X:\...` — strip the synthetic leading slash.
    if (/^\/[A-Za-z]:[\\/]/.test(decoded)) return decoded.slice(1);
  }
  return decoded;
}

// Map resolveLocalMediaPath / resolveAttachmentAbsPath error codes → HTTP.
function _statusFor(code: string | undefined): number {
  if (code === 'bad_input') return 400;
  if (code === 'forbidden') return 403;
  if (code === 'too_large') return 413;
  return 404;
}

function registerChatMediaProtocol(): void {
  protocol.handle('chat-media', async (request) => {
    const reqUrl = request.url;
    try {
      // Two route shapes, dispatched by URL host:
      //   chat-media://cid/<encCid>/<encName>      — per-conversation attachment
      //   chat-media://local/<abs-path-no-leading-slash>  — any local media file
      let u: URL;
      try { u = new URL(reqUrl); }
      catch {
        log.warn('chat-media: unparseable URL', { reqUrl });
        return new Response('bad request', { status: 400 });
      }
      const host = u.host.toLowerCase();

      if (host === 'cid') {
        const segs = decodeURIComponent(u.pathname || '')
          .replace(/^\/+/, '')
          .split('/');
        const cid = segs[0] || '';
        const name = segs.slice(1).join('/');
        if (!cid || !name) {
          log.warn('chat-media/cid: bad URL', { reqUrl });
          return new Response('bad request', { status: 400 });
        }
        const uid = users.getActiveUserId();
        const resolved = chatAttachments.resolveAttachmentAbsPath(uid, cid, name);
        if (!resolved.ok) {
          const code = (resolved as { code?: string }).code;
          log.warn('chat-media/cid: reject', { reqUrl, code, error: (resolved as { error?: string }).error });
          return new Response(String((resolved as { error?: string }).error || code || 'error'), { status: _statusFor(code) });
        }
        const st = fs.statSync(resolved.absPath);
        log.info('chat-media/cid: serving', { abs: resolved.absPath, kind: resolved.kind, bytes: st.size });
        return serveFileRange(request, resolved.absPath, chatAttachments.mediaMimeFor(name), st.size);
      }

      if (host === 'local') {
        // pathname starts with `/`; on Windows the drive-letter prefix needs
        // that leading slash stripped. `_pathnameToAbsPath` handles both.
        // Try media (image/video) first; fall through to preview (pdf/html)
        // on bad-ext only — every other failure (not_found / too_large) is
        // terminal, so we don't mask a real error by re-checking under a
        // different bucket.
        const abs = _pathnameToAbsPath(u.pathname || '');
        let resolved: ReturnType<typeof chatAttachments.resolveLocalMediaPath>
          | ReturnType<typeof chatAttachments.resolveLocalPreviewPath>
          = chatAttachments.resolveLocalMediaPath(abs);
        if (!resolved.ok && (resolved as { code?: string }).code === 'bad_input') {
          // Only retry under preview when the media resolver rejected on extension;
          // path validation errors ('path must be absolute' / 'path required') re-raise.
          const previewTry = chatAttachments.resolveLocalPreviewPath(abs);
          if (previewTry.ok) resolved = previewTry;
        }
        if (!resolved.ok) {
          // Same `(x as {field?: T}).field` access pattern as the cid branch above —
          // tsc's narrow on `if (!resolved.ok)` doesn't always propagate to the
          // error-branch fields here, so go through the type-assertion escape hatch.
          const err = resolved as { code?: string; error?: string };
          log.warn('chat-media/local: reject', { reqUrl, code: err.code, error: err.error });
          return new Response(String(err.error || ''), { status: _statusFor(err.code) });
        }
        const st = fs.statSync(resolved.absPath);
        log.info('chat-media/local: serving', { abs: resolved.absPath, kind: resolved.kind, bytes: st.size });
        return serveFileRange(request, resolved.absPath, chatAttachments.mediaMimeFor(resolved.absPath), st.size);
      }

      log.warn('chat-media: unknown host', { reqUrl, host });
      return new Response('bad request', { status: 400 });
    } catch (err) {
      log.warn('chat-media serve failed', { reqUrl, error: (err as Error).message });
      return new Response('error', { status: 500 });
    }
  });
}

// `chat-app://cid/<encCid>/<encArtifactId>/<relpath...>` streams LLM-generated
// chat artifacts; `chat-app://saved/<encAppId>/<relpath...>` streams saved
// "My Apps" bundles. Both are read-only and every disk request is filtered
// through a feature resolver (safe ids / safe relpath / traversal guard /
// served-extension allowlist / regular-file check). The reserved virtual
// relpath `__cogseed/bridge.js` is served from the in-memory `BRIDGE_JS`
// constant, not from disk. Fixed hosts sidestep URL-parser divergence the same
// way `chat-media://cid/...` does. `Access-Control-Allow-Origin: *` is set
// defensively — `chat-app://` URLs are only issuable from inside this app.
function _withArtifactCors(resp: Response): Response {
  // Re-wrap so we can add the header without mutating the shared
  // `serveFileRange` helper (kb-file / chat-media must not change). The body
  // stream is passed through untouched — Chromium consumes it once.
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

function registerChatAppProtocol(): void {
  protocol.handle('chat-app', async (request) => {
    const reqUrl = request.url;
    try {
      let u: URL;
      try { u = new URL(reqUrl); }
      catch {
        log.warn('chat-app: unparseable URL', { reqUrl });
        return new Response('bad request', { status: 400 });
      }
      const host = u.host.toLowerCase();
      // pathname is `/<encCid>/<encArtifactId>/<relpath...>` (always leading
      // slash, URL-encoded). Decode the whole thing then split — decoding
      // first then splitting on `/` is wrong if a relpath segment contained
      // an encoded slash, but artifact file paths never do (safeRelPath
      // rejects `\0` / `\`, and an encoded `/` would just be a path
      // separator anyway); decode per-segment to be precise.
      const rawSegs = (u.pathname || '').replace(/^\/+/, '').split('/');
      const cid = rawSegs[0] ? decodeURIComponent(rawSegs[0]) : '';
      const artifactId = rawSegs[1] ? decodeURIComponent(rawSegs[1]) : '';
      const relPath = rawSegs.slice(2).map((s) => (s ? decodeURIComponent(s) : '')).join('/');

      if (host !== 'cid') {
        log.warn('chat-app: unknown host', { reqUrl, host: u.host });
        return new Response('bad request', { status: 400 });
      }
      if (!cid || !artifactId) {
        log.warn('chat-app: bad URL (need cid + artifactId)', { reqUrl });
        return new Response('bad request', { status: 400 });
      }

      // Reserved virtual path: the runtime bridge script (not on disk).
      if (relPath === chatArtifacts.BRIDGE_RELPATH) {
        return _withArtifactCors(new Response(chatArtifacts.BRIDGE_JS, {
          headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=60' },
        }));
      }

      const uid = users.getActiveUserId();
      const resolved = chatArtifacts.resolveArtifactFilePath(uid, cid, artifactId, relPath);
      if (!resolved.ok) {
        // Cast in the error branch — `strictNullChecks: false` keeps the
        // whole union here (same workaround as the chat-media handler above).
        const code = (resolved as { code?: string }).code;
        const errMsg = (resolved as { error?: string }).error;
        log.warn('chat-app: reject', { reqUrl, code, error: errMsg });
        return new Response(String(errMsg || code || 'error'), { status: _statusFor(code) });
      }
      const st = fs.statSync(resolved.absPath);
      log.info('chat-app: serving', { abs: resolved.absPath, mime: resolved.mime, bytes: st.size });
      return _withArtifactCors(serveFileRange(request, resolved.absPath, resolved.mime, st.size));
    } catch (err) {
      log.warn('chat-app serve failed', { reqUrl, error: (err as Error).message });
      return new Response('error', { status: 500 });
    }
  });
}

// `cogseed-plugin://<pkgName>/<relpath>` serves a plugin-provided UI out of
// the installed package dir (manifest `ui.entry`). Read-only; every request
// is filtered through `resolvePluginUiFile` (safe name / safe relpath /
// traversal + symlink guard / served-extension allowlist / regular-file
// check). The reserved virtual relpath `__cogseed/plugin-bridge.js` is
// served from the in-memory PLUGIN_BRIDGE_JS constant. The URL host is the
// package name (safe charset), sidestepping URL-parser divergence the same
// way `chat-app://cid/...` does. `Access-Control-Allow-Origin: *` is set
// No `Access-Control-Allow-Origin` is set here on purpose: the plugin page
// only needs same-origin fetches (its own assets under its own
// `cogseed-plugin://<pkg>` origin), and a wildcard CORS would let any other
// origin inside the app (other plugins' UIs, artifact pages) read this
// plugin's UI assets cross-origin. Least privilege: cross-origin reads stay
// blocked by default.
function registerPluginProtocol(): void {
  protocol.handle('cogseed-plugin', async (request) => {
    const reqUrl = request.url;
    try {
      let u: URL;
      try { u = new URL(reqUrl); }
      catch {
        log.warn('cogseed-plugin: unparseable URL', { reqUrl });
        return new Response('bad request', { status: 400 });
      }
      const name = u.host.toLowerCase();
      const relPath = (u.pathname || '').replace(/^\/+/, '')
        .split('/').map((s) => (s ? decodeURIComponent(s) : '')).join('/');
      if (!name || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        log.warn('cogseed-plugin: unknown host', { reqUrl, host: u.host });
        return new Response('bad request', { status: 400 });
      }
      if (!relPath) {
        log.warn('cogseed-plugin: bad URL (empty path)', { reqUrl });
        return new Response('bad request', { status: 400 });
      }
      const uid = users.getActiveUserId();
      const ui = await import('./features/plugin_ui');
      // Reserved virtual path: the runtime bridge script (not on disk).
      if (relPath === ui.PLUGIN_BRIDGE_RELPATH) {
        return new Response(ui.PLUGIN_BRIDGE_JS, {
          headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=60' },
        });
      }
      const resolved = ui.resolvePluginUiFile(uid, name, relPath);
      if (!resolved.ok) {
        const code = (resolved as { code?: string }).code;
        const errMsg = (resolved as { error?: string }).error;
        log.warn('cogseed-plugin: reject', { reqUrl, code, error: errMsg });
        return new Response(String(errMsg || code || 'error'), { status: _statusFor(code) });
      }
      const st = fs.statSync(resolved.absPath!);
      log.info('cogseed-plugin: serving', { abs: resolved.absPath, mime: resolved.mime, bytes: st.size });
      return serveFileRange(request, resolved.absPath!, resolved.mime!, st.size);
    } catch (err) {
      log.warn('cogseed-plugin serve failed', { reqUrl, error: (err as Error).message });
      return new Response('error', { status: 500 });
    }
  });
}

// Single-instance lock prevents double-launch from duplicating the backend.
const gotLock = IS_PACKAGED_SMOKE || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Account login is stripped, but connector OAuth still returns through the OS protocol. Keep
  // this connector-only receiver outside the removed account protocol module.
  registerConnectorProtocol({ owner: RUNTIME_IDENTITY.protocolOwner });
  // 后台驻留时双击桌面图标：呼出已存在的实例。`features/connectors/protocol.ts:114`
  // 已有一个 second-instance 监听，但它用 `getAllWindows()` 取窗口（可能抓到
  // wecom 分区弹窗）、没有窗口时直接返回；这里统一走 `showMainWindow()`。
  app.on('second-instance', () => {
    // `app.isReady()` 不是完整的护栏：ready 之后、启动流程末尾调 createWindow()
    // 之前还隔着 boot 自检和版本迁移。提前 `if (!isReady) return` 只是因为
    // ready 之前一个窗口都没有，此时让 showMainWindow() 回退到 createWindow()
    // 会抛 "Cannot create BrowserWindow before app is ready" 并终结主进程
    // （双击图标时第二次启动很容易落在这一段）。ready 之后的那段空窗由
    // createWindow() 的幂等性兜住：showMainWindow() 建出的窗口就是启动流程
    // 随后会复用的同一个，不会出现第二个主窗口。
    if (!app.isReady()) return;
    showMainWindow();
  });
  void app.whenReady().then(async () => {
    await runBootSelfCheck();

    // 版本迁移：检测版本变化，自动清理旧数据
    try {
      const { runVersionMigration } = await import('./features/version_migration');
      const migrationResult = await runVersionMigration();
      if (migrationResult.migrated) {
        log.info('version migration completed', migrationResult);
      }
    } catch (err) {
      log.warn('version migration failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // Source-run macOS uses Electron.app's own Info.plist, so set the dock
    // icon at runtime. Packaged builds still pick up the configured icns.
    if (process.platform === 'darwin' && app.dock) {
      const iconPath = path.join(paths.SRC_ROOT, 'resources', 'icons', 'icon.png');
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    }
    if (process.platform === 'win32') {
      app.setAppUserModelId(RUNTIME_IDENTITY.appId);
    }
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }
    registerKbFileProtocol();
    registerChatMediaProtocol();
    registerChatAppProtocol();
    registerPluginProtocol();
    registerIpc();
    const stopTaskNotifications = taskNotifications.startTaskNotifications({
      getActiveUserId: () => users.getActiveUserId(),
      isEnabled: () => appConfig.getTaskNotificationsEnabled(),
      hasFocusedWindow: () => BrowserWindow.getAllWindows().some((win) => (
        !win.isDestroyed() && win.isFocused()
      )),
      isSupported: () => Notification.isSupported(),
      setBadgeCount: setTaskNotificationBadgeCount,
      onDidFocus: (listener) => {
        const onFocus = () => listener();
        app.on('browser-window-focus', onFocus);
        return () => { app.off('browser-window-focus', onFocus); };
      },
      createNotification: (options) => {
        const notification = new Notification(options);
        notification.on('show', () => notificationPermissions.markSystemNotificationDelivered());
        notification.on('failed', (_event, error) => {
          notificationPermissions.markSystemNotificationFailed();
          log.warn('native task notification rejected by OS', { error: error || 'unknown' });
        });
        return {
          onClick: (listener) => { notification.on('click', listener); },
          show: () => { notification.show(); },
        };
      },
      openConversation: openConversationFromTaskNotification,
    });
    app.once('before-quit', stopTaskNotifications);
    // 托盘只在 macOS/Windows 上启动：只有这两个平台有可用的呼出入口（Windows 的
    // `right-click`、macOS 的 contextMenu；`popUpContextMenu` 本身也是 darwin/win32
    // 限定）。Linux 上偏好默认是开的、`isAvailable()` 会返回 true，close 就会把
    // 窗口藏到一个没有可用菜单的托盘后面——正是 shouldHideOnClose 要防的不可达状态。
    // 其余平台保持 backgroundRun 为 null，close 处理器继续走今天的路径
    // （trayAvailable=false → 不拦截）。无头 window station 的打包冒烟同理跳过。
    if (!IS_PACKAGED_SMOKE && (process.platform === 'darwin' || process.platform === 'win32')) {
      backgroundRun = startBackgroundRun({
        platform: process.platform,
        host: {
          createIcon: () => {
            // macOS 用彩色 png 缩到 16pt（不做 template image：彩色图设成
            // template 会渲染成一整块黑）。Windows 直接用多尺寸 ico。
            const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
            const image = nativeImage.createFromPath(path.join(paths.SRC_ROOT, 'resources', 'icons', file));
            if (image.isEmpty()) return null;
            return process.platform === 'win32' ? image : image.resize({ width: 16, height: 16 });
          },
          createTray: (icon) => new Tray(icon as NativeImage),
          // 托盘可能已经被销毁（stop()、托盘菜单退出、系统回收 explorer 之后），
          // 再碰原生对象会抛；主进程没有 unhandledRejection 兜底，所以这几个
          // 写入型调用在 isDestroyed() 时直接 no-op。
          setToolTip: (tray, text) => {
            const native = tray as Tray;
            if (native.isDestroyed()) return;
            native.setToolTip(text);
          },
          setMenu: (tray, items) => {
            const native = tray as Tray;
            if (native.isDestroyed()) return;
            native.setContextMenu(Menu.buildFromTemplate(toTrayTemplate(items)));
          },
          popUpMenu: (tray, items) => {
            const native = tray as Tray;
            if (native.isDestroyed()) return;
            native.popUpContextMenu(Menu.buildFromTemplate(toTrayTemplate(items)));
          },
          onLeftClick: (tray, listener) => { (tray as Tray).on('click', listener); },
          onRightClick: (tray, listener) => { (tray as Tray).on('right-click', listener); },
          displayBalloon: (tray, title, content) => {
            const native = tray as Tray;
            if (native.isDestroyed()) return;
            native.displayBalloon({ title, content });
          },
          destroy: (tray) => { (tray as Tray).destroy(); },
          startStatusRefresh: (flush, intervalMs) => {
            const timer = setInterval(flush, intervalMs);
            timer.unref?.();
            return () => clearInterval(timer);
          },
        },
        showMainWindow,
        requestQuit: () => app.quit(),
        getActiveTaskCount: async () => {
          const uid = users.getActiveUserId();
          if (!uid) return null;
          // 不做本地 catch：让它 reject，由模块的 refresh() 统一处理——那条路径只在
          // "正常 → 失败"翻转时告警一次。在这里吞掉并返回 null 会让去重失效，持续
          // 失败就变成每 5 s 刷一行日志。
          const status = await cogseedBackend.cogseedIpcService.runtimeStatus(uid);
          return typeof status?.activeTaskCount === 'number' ? status.activeTaskCount : null;
        },
      });
    }
    const stopRecallCapture = startRecallCaptureOrchestrator();
    app.once('before-quit', stopRecallCapture);
    const stopGroupKstarClosure = startGroupKstarClosure();
    app.once('before-quit', stopGroupKstarClosure);
    const stopAutoCloseRecovery = startAutoCloseRecovery();
    app.once('before-quit', stopAutoCloseRecovery);
    const stopGroupChatRecallTerminalProofs = startGroupChatRecallTerminalProofs();
    app.once('before-quit', stopGroupChatRecallTerminalProofs);
    const stopTaskAutoArchive = startTaskAutoArchiveOrchestrator();
    app.once('before-quit', stopTaskAutoArchive);
    clientConfigFeature.clientConfig.subscribeAll((keys) => {
      ipc.broadcastToRenderer('client-config:changed', { keys });
    });
    const BOOT_BACKGROUND_DEFER_MS = 6_000;
    const bootDevice = getBootDeviceProfile();
    const BOOT_HEAVY_DISK_DELAY_MS = bootDevice.heavyDiskOffsetMs;
    const BOOT_POST_STARTUP_DELAY_MS = bootDevice.postStartupOffsetMs;
    const CLIENT_CONFIG_STARTUP_DELAY_MS = 8_000;
    const CONNECTORS_BOOTSTRAP_DELAY_MS = bootDevice.connectorBootstrapDelayMs;
    log.info('boot device profile', {
      tier: bootDevice.tier,
      logical_cpus: bootDevice.logicalCpus,
      total_memory_gib: Math.round((bootDevice.totalMemoryBytes / (1024 ** 3)) * 10) / 10,
      heavy_disk_delay_ms: BOOT_HEAVY_DISK_DELAY_MS,
      post_startup_delay_ms: BOOT_POST_STARTUP_DELAY_MS,
    });
    clientConfigFeature.start({
      startupDelayMs: CLIENT_CONFIG_STARTUP_DELAY_MS,
      forceStartupRefresh: false,
    });
    const connectorsTimer = setTimeout(() => {
      connectorsFeature.bootstrap(users.getActiveUserId()).catch(() => {
        /* errors logged inside the feature; never block app startup */
      });
    }, CONNECTORS_BOOTSTRAP_DELAY_MS);
    connectorsTimer.unref?.();
    if (!IS_PACKAGED_SMOKE) {
      updatesIpc.initAutoUpdateBridge((channel, payload) => {
        ipc.broadcastToRenderer(channel, payload);
      });
      // Manual download phase changes (downloading / paused / failed / idle) —
      // the settings pane renders these instead of tracking its own flag.
      updatesIpc.initDownloadStateBridge((channel, payload) => {
        ipc.broadcastToRenderer(channel, payload);
      });
    }
    registerDeferred('messaging:start', () => messagingFeature.startForUser(users.getActiveUserId()), 'serial', CONNECTORS_BOOTSTRAP_DELAY_MS, {
      resourceClass: 'network',
      preferIdle: true,
      maxSliceMs: 20_000,
    });
    // In-app update check. Silent by design: failures are logged and swallowed
    // inside the feature; a surfaced reminder is broadcast to the renderer.
    // Skipped in the packaged launch smoke so the smoke run never touches the
    // network.
    if (!IS_PACKAGED_SMOKE) {
      registerDeferred('updater:check', async () => {
        const result = await updaterClient.checkForUpdates(users.getActiveUserId(), { manual: false });
        if (result.reminded && result.info) {
          ipc.broadcastToRenderer('updates:available', {
            info: result.info,
            current_version: result.current_version,
          });
        }
      }, 'parallel', 0, {
        resourceClass: 'network',
        preferIdle: true,
        maxSliceMs: 30_000,
      });
    }
    // Post-upgrade boot guard. Registered as the first immediate task and fully
    // synchronous, so the crash-loop marker is seeded (and a bad upgrade judged)
    // before the renderer can finish loading and clear it as healthy. The verdict
    // is retained in memory for the updates IPC layer to report.
    registerImmediate('updater:boot-guard', runBootGuardOnce);
    // P3394 bridge (opt-in): starts a loopback HTTP channel bound to the real
    // runtime controller when COGSEED_P3394_PORT is set; no-op otherwise.
    registerImmediate('p3394:bridge', () => {
      void maybeStartP3394Bridge().then((handle) => { p3394AppBridge = handle; });
    }, 'serial');
    // 模型窗口/输出的用户本地覆盖：把存储层解析器装进模型层（runner 只问
    // "这个 (provider, model) 被覆盖了吗"，不自己读用户数据）。
    registerImmediate('model-overrides:resolver', async () => {
      const { installModelOverrideResolver } = await import('./features/model_overrides');
      installModelOverrideResolver();
    }, 'serial');
    registerImmediate('skills:version-recovery', async () => {
      const { recoverSkillVersionMutations } = await import('./features/skills/version-mutation-service');
      const result = await recoverSkillVersionMutations(users.getActiveUserId());
      if (result.finalized || result.restored || result.removed) {
        log.info('skill version mutation recovery complete', result);
      }
    }, 'serial');
    createWindow();
    await consumeColdLaunchConnectorCallback();

    // Boot tasks declared via util/boot_init.ts. Two phases × two modes:
    //
    //   registerImmediate(name, fn[, 'serial'])  → runs now, parallel by default
    //   registerDeferred(name, fn[, 'serial'])   → runs after BOOT_BACKGROUND_DEFER_MS
    //
    // The runner swallows per-task errors (logged at warn) so one bad
    // module can't keep the rest of boot from progressing. Slow tasks
    // (>1.5s) emit a warn so regressions show up in the boot log.
    //
    // Replaces the pre-existing `setImmediate(...)` / `setTimeout(...)` /
    // `import().then()` / async-IIFE soup that had grown around here.

    configureBootAdmission({
      isRuntimeBusy: () => {
        try {
          // CJS require intentionally shares bus.ts's global Symbol-backed
          // runtime map with the normal send path.
          const bus = require('./features/group_chat/bus') as typeof import('./features/group_chat/bus');
          return bus.hasActiveWork(users.getActiveUserId());
        } catch {
          return false;
        }
      },
    });

    const idleDisk = {
      resourceClass: 'disk' as const,
      preferIdle: true,
      maxSliceMs: 15_000,
    };
    const idleProcess = {
      resourceClass: 'process' as const,
      preferIdle: true,
      maxSliceMs: 20_000,
    };
    // Small schedulers/cache reads may share the first deferred cohort. Disk
    // walkers below are serial barriers so low-end devices do not receive a
    // simultaneous search + KB + marketplace + system-skill I/O burst.
    registerDeferred('marketplace:prime-cache', async () => {
      // Primes the in-memory category cache from disk/fallback only; the lazy
      // path in features/marketplace_biz.ts refreshes from Server when needed.
      const m = await import('./features/marketplace_biz');
      await m.primeCategoryCache({ localOnly: true });
    });
    // 启动后 60 秒首次检查；随后在线期间每 6 小时一次。两者都不打断用户，
    // 失败只记日志并在 30 分钟后重试一次（见 `runMarketplaceInstallReconcile`）。
    registerDeferred(
      'marketplace:reconcile',
      () => runMarketplaceInstallReconcile('startup'),
      'parallel',
      MARKETPLACE_STARTUP_CHECK_DELAY_MS,
    );
    // 保守回收：启动期一次。**不挂在 6 小时检查周期上**——回收无时效性，
    // 且三条删除条件任一不满足即不删、任何异常本轮删 0（FR-052 / FR-053）。
    registerDeferred(
      'marketplace:version-gc',
      async () => {
        const gc = await import('./features/marketplace/version-gc');
        const uid = users.getActiveUserId();
        const report = await gc.runVersionGc(uid);
        if (report.deleted.length || report.aborted) {
          marketplaceBootLog.info('hub version copy gc finished', {
            deleted: report.deleted.length, kept: report.kept.length, aborted: report.aborted,
          });
        }
      },
      'parallel',
      MARKETPLACE_VERSION_GC_DELAY_MS,
    );
    registerDeferred('marketplace:reconcile-interval', () => {
      const timer = setInterval(() => {
        runMarketplaceInstallReconcile('interval').catch(() => {
          // `runMarketplaceInstallReconcile` 自己记录并安排重试；这里不再重复处理。
        });
      }, MARKETPLACE_SERVER_CHECK_INTERVAL_MS);
      timer.unref?.();
    });

    // Heal cc-switch providers synced before the auto-bind fix: bind the first
    // declared model of each synced provider to an entry so chat dispatch can
    // actually use it (pickChatEntry walks entries only). Cheap and idempotent.
    registerDeferred('auth:ccswitch-bind-entries', async () => {
      const uid = users.getActiveUserId();
      // CC Switch providers are user-controlled: never auto-bind them back on
      // boot. Doing so resurrects deleted model entries and defeats the
      // no-model → CLI fallback. The user enables CC Switch providers
      // explicitly in settings; entries are bound at that point.
      void uid;
    });

    // recall:correct-seed-maturity 已随出身收敛退役（2026-09-20）：一次性
    // 历史归档修正早已空转，出身单值化后判据不复存在（见 asset-service 注释）。
    // 2026-08-15 UI 优化：旧 KStar 线资产带英文技术标题（'Reusable experience
    // lesson (requirement-level)' 等），迁移为中文可读。幂等，修完空转。
    registerDeferred('recall:migrate-legacy-titles', async () => {
      const { migrateLegacyUserFacingTitles } = await import('./features/recall/asset-service');
      await migrateLegacyUserFacingTitles(users.getActiveUserId());
    }, 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);
    // A 轨道（2026-09-13 scope 枚举化）：存量自由文本 scope（"用户全局画像"）
    // 归一为受控词表——否则自动投影永远 scope_mismatch，确认资产在正式通道
    // 失效。幂等；迁移会同步刷新仍存活 committed 投影的版本快照（2026-09-14
    // 补——此前"跳过被引用资产"的说法与实现相反，committed 校验器的版本
    // 强校验会让注入整体失败）。
    registerDeferred('recall:migrate-legacy-scopes', async () => {
      const { migrateLegacyFreeTextScopes } = await import('./features/recall/asset-service');
      await migrateLegacyFreeTextScopes(users.getActiveUserId());
    }, 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);
    // 旧 USER.md / MEMORY.md 是用户数据，不在启动时自动归属迁移。用户须先
    // 在记忆内容页查看来源和原文、逐条选择并确认；preview 是只读，只有确认
    // 后才备份、尝试写入资产，并仅清理已成功入库且源文件未变化的条目。
    registerDeferred('boot:maintenance-sweeps', () => runBootMaintenanceSweeps(), 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);
    registerDeferred('search:reconcile', (signal) => searchFeature.reconcileActive(signal), 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);
    registerDeferred('kb:reconcile', async (signal) => {
      // Picks up files dropped into contexts/ via Finder while the app was
      // off + any divergence from a just-synced vector.db. UI gets live
      // updates through the `kb.events` stream as files transition status.
      const { reconcile } = await import('./features/kb_indexer');
      await reconcile(users.getActiveUserId(), signal);
    }, 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);
    registerDeferred(
      'system-skills:reconcile',
      () => systemSkills.reconcileAllForActiveUserWithRetry({ retries: 2, reason: 'startup' }),
      'serial',
      BOOT_HEAVY_DISK_DELAY_MS,
      idleProcess,
    );

    // Maintenance that can scan hundreds of sessions or invoke model-backed
    // reflection starts after the measured 30-second startup window. The two
    // tasks share a serial cohort so their disk walks cannot overlap.
    registerDeferred('chats:index-repair', async (signal) => {
      await chatsFeature.repairConversationIndex(users.getActiveUserId(), signal);
    }, 'serial', BOOT_POST_STARTUP_DELAY_MS, idleDisk);
    registerDeferred('sessions:gc', async (signal) => {
      const mod = await import('./features/sessions_sweep');
      await mod.sweepSessions(users.getActiveUserId(), signal);
    }, 'serial', BOOT_POST_STARTUP_DELAY_MS, idleDisk);
    registerDeferred('reflection:loop', () => {
      reflectionOrchestrator.startReflectionLoop(users.getActiveUserId());
    }, 'serial', BOOT_POST_STARTUP_DELAY_MS);
    registerDeferred('builtin-marketplace:seed', () => seedBuiltinMarketplaceForCurrentUser('startup'));
    registerDeferred('builtin-packages:seed', () => seedBuiltinPackagesForCurrentUser('startup'));
    registerDeferred('auto-tasks:scheduler', () => autoTasks.startScheduler());
    registerDeferred('recall:capture-recovery', async () => {
      const uid = users.getActiveUserId();
      if (uid) await recoverRecallCaptures(uid);
    }, 'parallel', BOOT_HEAVY_DISK_DELAY_MS, { resourceClass: 'disk', preferIdle: true });
    registerDeferred('recall:validation-recovery', async () => {
      const uid = users.getActiveUserId();
      if (!uid) return;
      const { recoverValidationApplications } = await import('./features/recall/validation-service');
      await recoverValidationApplications(uid);
    }, 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);
    // 保留期到期清理（specs/008 T005）：启动后跑一轮，此后低频自续期。
    // 「到期自动彻底删除」的级联清理链见 features/recall/asset-retention-service。
    registerDeferred('recall:retention-sweep', async () => {
      const uid = users.getActiveUserId();
      if (!uid) return;
      const { startAbilityAssetRetentionLoop } = await import('./features/recall/asset-retention-service');
      startAbilityAssetRetentionLoop(uid);
    }, 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);
    // 后台巡检（specs/008 US-405）：低频自续期，**只报不改**；开关关掉后不再自动跑。
    registerDeferred('recall:asset-inspection', async () => {
      const uid = users.getActiveUserId();
      if (!uid) return;
      const { startAssetInspectionLoop } = await import('./features/recall/asset-inspection-service');
      startAssetInspectionLoop(uid);
    }, 'serial', BOOT_HEAVY_DISK_DELAY_MS, idleDisk);



    // Drive the immediate batch + schedule the deferred one.
    void runBootPhases(BOOT_BACKGROUND_DEFER_MS);

    app.on('activate', () => {
      // 隐藏到托盘的窗口也算"存在"，旧实现只在 0 窗口时建窗，于是点 dock 图标没反应。
      showMainWindow();
    });
  }).catch((err) => {
    log.error('application startup failed', { error: (err as Error).message });
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Flush pending search-index writes + close KB vector DBs before exit.
  let shutdownFlushed = false;
  let shutdownPromise: Promise<void> | null = null;
  app.on('before-quit', async (e) => {
    // 必须在两个早退分支之前置位：App 退出流程一启动，close 就不得再被拦成隐藏。
    isQuitting = true;
    // 退出流程一开始就把托盘收掉：quit 已在路上，留一个"看起来还活着"的托盘点既没有意义，
    // 也会在 Windows 留下残影（`stop()` 幂等，重复调用无害）。
    backgroundRun?.stop();
    backgroundRun = null;
    if (shutdownFlushed) return;
    e.preventDefault();
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.resolve().then(async () => {
      try { await searchFeature.flushAll(); }
      catch (err) { createLogger('search').warn('final flush failed', { error: (err as Error).message }); }
      try {
        const kb = await import('./features/kb_vector');
        kb.closeAllKb();
      } catch (err) { createLogger('kb_vector').warn('close failed', { error: (err as Error).message }); }
      // Keep Electron alive until the bridge and every managed external gateway
      // process tree have completed their graceful shutdown.
      await Promise.allSettled([
        stopP3394Bridge(),
        import('./features/p3394_bridge/external-gateways').then((m) => m.stopAllExternalGateways()),
      ]);
      shutdownFlushed = true;
      app.quit();
    });
    await shutdownPromise;
  });
}
