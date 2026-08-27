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
 *  - 仅在打包后的应用可用（electron autoUpdater 需要签名与安装副本；
 *    开发模式下状态为 disabled，回落到 v1 手动检查/下载流程）；
 *  - 与 v1 提醒通道（updates/latest + dmg）并存：老客户端走提醒，
 *    新版本走自动更新；两条通道由平台同一发布动作驱动。
 */

import { app, autoUpdater } from 'electron';

import { createLogger } from '../../logger';
import { requireCogSeedApiBase } from '../api_base';

const log = createLogger('updater-auto');

export type AutoUpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export type AutoUpdateListener = (status: AutoUpdateStatus) => void;

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

function _feedUrl(): string {
  const base = requireCogSeedApiBase().replace(/\/+$/, '');
  return `${base}/updates/feed/mac-${process.arch}`;
}

function _wireEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    log.debug('checking-for-update');
    _setStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', () => {
    // macOS（Squirrel.Mac）发现更新后即自动下载；无 download-progress 事件，
    // 状态直接进入 downloading，直到 update-downloaded。
    log.info('update available, downloading');
    _setStatus({ state: 'downloading', percent: 0 });
  });

  autoUpdater.on('update-not-available', () => {
    log.debug('update not available');
    _setStatus({ state: 'idle' });
  });

  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    const version = String(releaseName || '').trim();
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
 * 初始化自动更新：打包应用内设置 feed 并静默检查；开发模式返回 disabled。
 * 幂等：重复调用不会重复注册事件或触发多次检查。
 */
export function initAutoUpdate(listener?: AutoUpdateListener): AutoUpdateStatus {
  if (listener) _listener = listener;
  if (_initialized) return _status;
  _initialized = true;

  if (!app.isPackaged) {
    _setStatus({ state: 'disabled', reason: 'dev_mode' });
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

/** 设置页「立即检查」：手动触发一次检查（开发模式为 no-op）。 */
export function checkAutoUpdate(): AutoUpdateStatus {
  if (!app.isPackaged) {
    _setStatus({ state: 'disabled', reason: 'dev_mode' });
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
