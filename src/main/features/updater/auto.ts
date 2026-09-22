/**
 * Auto-update via electron's built-in autoUpdater (Squirrel.Mac on macOS).
 *
 * "点完自己装好"：应用启动后在后台静默检查 + 下载（autoDownload），
 * 下载完成后通知渲染层展示「重启并安装」，用户点击后 quitAndInstall()
 * 完成自动替换——无需再手动打开 DMG 拖拽。
 *
 * Feed：hub 服务的 Squirrel.Mac generic JSON（{url,name,notes,pub_date}），
 * 路径 {API_BASE}/updates/feed/mac-<arch>（当前只有 mac-arm64 提供 zip）。
 *
 * 约束：
 *  - 仅在打包后的 macOS 应用可用（electron autoUpdater 需要签名与安装副本；
 *    开发模式或不支持的平台状态为 disabled，回落到 v1 手动检查/下载流程）；
 *  - 与 v1 提醒通道（updates/latest + dmg）并存：老客户端走提醒，
 *    新版本走自动更新；两条通道由平台同一发布动作驱动；
 *  - `downloaded` 只在版本真的更新时才成立（isDownloadedVersionNewer）：feed 的
 *    204 闸门依赖调用方 UA 里的版本，解析不出来就会把当前版本再发一遍，
 *    客户端不能照着提示「重启并安装」。
 */

import { app, autoUpdater } from 'electron';

import { createLogger } from '../../logger';
import { compareVersions } from '../../util/app-version-compat';
import { requireCogSeedApiBase } from '../api_base';

const log = createLogger('updater-auto');

export type AutoUpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  // percent 只在平台真的上报下载进度时才有值（Windows 的 download-progress）；
  // macOS 的 Squirrel.Mac 没有该事件，此时 percent 缺省代表「进度未知」。
  | { state: 'downloading'; percent?: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export type AutoUpdateListener = (status: AutoUpdateStatus) => void;

export type AutoUpdateRuntime = Readonly<{
  isPackaged: boolean;
  platform: NodeJS.Platform;
}>;

let _status: AutoUpdateStatus = { state: 'idle' };
let _listener: AutoUpdateListener | null = null;
let _initialized = false;

function _setStatus(status: AutoUpdateStatus): void {
  _status = status;
  log.info('auto-update status', { state: status.state });
  if (_listener) {
    try {
      _listener(status);
    } catch (err) {
      log.warn('auto-update listener failed', { error: (err as Error)?.message });
    }
  }
}

export function getAutoUpdateStatus(): AutoUpdateStatus {
  return _status;
}

function _runtime(): AutoUpdateRuntime {
  return { isPackaged: app.isPackaged, platform: process.platform };
}

function _disabledStatus(runtime: AutoUpdateRuntime): AutoUpdateStatus | null {
  if (!runtime.isPackaged) return { state: 'disabled', reason: 'dev_mode' };
  if (runtime.platform !== 'darwin') {
    return { state: 'disabled', reason: 'unsupported_platform' };
  }
  return null;
}

function _feedUrl(): string {
  const base = requireCogSeedApiBase().replace(/\/+$/, '');
  return `${base}/updates/feed/mac-${process.arch}`;
}

/** 当前运行版本；pre-ready 或测试替身取不到时返回空串（判据随之失效，不误判）。 */
function _currentVersion(): string {
  try {
    const version = app?.getVersion?.();
    if (typeof version === 'string' && version.trim()) return version.trim();
  } catch { /* pre-ready */ }
  return '';
}

/**
 * 从 releaseName 里取出可比较的版本号。
 *
 * feed 的 `name` 就是发布版本（hub 侧 `projectMacFeed` 写的是 artifact.latestVersion），
 * 但这里不假设它一定是干净版本号：取不到 `x.y.z` 形状就返回空串，让调用方退回
 * 原行为，避免因为一个怪异字符串把正常更新挡掉。
 */
function _comparableVersion(value: unknown): string {
  const text = String(value ?? '').trim();
  const match = text.match(/^[vV]?(\d+(?:\.\d+){1,3})/);
  return match ? match[1] : '';
}

/**
 * 已下载的更新是否真的比当前版本新。
 *
 * 客户端装到最新版后仍然显示「重启并安装」的挡板：feed 只按 CFNetwork UA 里的版本
 * 做 204 闸门（hub 侧 `projectMacFeed` 解析不出调用方版本时无条件返回 feed），
 * 所以 Squirrel 完全可能把「已经装着的同一个版本」再下载一遍并回 update-downloaded。
 * 渲染层没有版本判据，只认 state==='downloaded' 就出按钮，于是最新版客户端上出现
 * 一个点了也没用的「重启并安装」。v1 手动通道一直有这条判据
 * （`compareVersions(info.latest_version, current) > 0`），这里补齐自动通道的同一判据。
 *
 * 任一版本号取不到时返回 true（保持原行为）：宁可在信息不足时照旧提示，也不因为
 * 一次解析失败把真实的更新藏起来。
 */
export function isDownloadedVersionNewer(downloadedVersion: unknown, currentVersion: unknown): boolean {
  const staged = _comparableVersion(downloadedVersion);
  const current = _comparableVersion(currentVersion);
  if (!staged || !current) return true;
  return compareVersions(staged, current) > 0;
}

function _wireEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    log.debug('checking-for-update');
    _setStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', () => {
    // macOS（Squirrel.Mac）发现更新后即自动下载；无 download-progress 事件，
    // 状态直接进入 downloading，直到 update-downloaded。故意不带 percent：
    // 「拿不到进度」不能用 0 冒充——设置页照 0 渲染出的是一条永远不动的
    // 进度文案，和真实下载进度互相矛盾。
    log.info('update available, downloading');
    _setStatus({ state: 'downloading' });
  });

  autoUpdater.on('update-not-available', () => {
    log.debug('update not available');
    _setStatus({ state: 'idle' });
  });

  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    const version = String(releaseName || '').trim();
    // 客户端已经在最新版上时不允许进入 downloaded：feed 的版本闸门依赖调用方
    // UA，解析不出来就会把同一个版本再发一遍，Squirrel 于是下载并回报
    // update-downloaded，渲染层据此显示一个点了也没用的「重启并安装」。
    const current = _currentVersion();
    if (!isDownloadedVersionNewer(version, current)) {
      log.warn('downloaded update is not newer than the running version; staying idle', {
        version,
        current,
      });
      _setStatus({ state: 'idle' });
      return;
    }
    log.info('update downloaded', { version });
    _setStatus({ state: 'downloaded', version });
  });

  autoUpdater.on('error', (err) => {
    log.warn('auto-update error', { error: String((err as Error)?.message || err) });
    // 自动更新失败不打扰用户（v1 提醒通道仍是兜底）；仅在状态里呈现，供设置页展示。
    _setStatus({ state: 'error', message: String((err as Error)?.message || err) });
  });
}

/**
 * 初始化自动更新：打包后的 macOS 应用设置 feed 并静默检查；
 * 开发模式和不支持的平台返回 disabled。
 * 幂等：重复调用不会重复注册事件或触发多次检查。
 */
export function initAutoUpdate(
  listener?: AutoUpdateListener,
  runtime: AutoUpdateRuntime = _runtime(),
): AutoUpdateStatus {
  if (listener) _listener = listener;
  if (_initialized) return _status;
  _initialized = true;

  const disabled = _disabledStatus(runtime);
  if (disabled) {
    _setStatus(disabled);
    return _status;
  }

  try {
    _wireEvents();
    // macOS 上 Squirrel.Mac 始终自动下载；安装由用户点「重启并安装」触发
    // （autoInstallOnAppQuit 为 Windows 专用属性，macOS 不适用）。
    const url = _feedUrl();
    log.info('auto-update feed', { url });
    autoUpdater.setFeedURL({ url });
    // 启动即静默检查；失败仅记录状态，不打扰用户。
    autoUpdater.checkForUpdates();
  } catch (err) {
    log.warn('auto-update init failed', { error: (err as Error)?.message });
    _setStatus({ state: 'error', message: String((err as Error)?.message || err) });
  }
  return _status;
}

/** 设置页「立即检查」：手动触发一次检查（开发模式和不支持的平台为 no-op）。 */
export function checkAutoUpdate(runtime: AutoUpdateRuntime = _runtime()): AutoUpdateStatus {
  const disabled = _disabledStatus(runtime);
  if (disabled) {
    _setStatus(disabled);
    return _status;
  }
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    _setStatus({ state: 'error', message: String((err as Error)?.message || err) });
  }
  return _status;
}

/** 「重启并安装」：仅在 update-downloaded 之后调用。 */
export function installAutoUpdate(): AutoUpdateStatus {
  if (_status.state !== 'downloaded') {
    log.warn('installAutoUpdate called without downloaded update');
    return _status;
  }
  // 退出前让渲染层有机会展示（quitAndInstall 会关闭全部窗口并重启应用）。
  autoUpdater.quitAndInstall();
  return _status;
}
