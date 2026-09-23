/**
 * IPC handlers for the in-app update reminder feature.
 *
 * Logical channels exposed to the renderer:
 *   - `updates.check`     → run an update check. `{ manual: true }` (settings
 *                           page) bypasses the once-per-day reminder throttle
 *                           and always reports the truth; boot-time checks use
 *                           `{ manual: false }` and decide surfacing via the
 *                           returned `reminded` flag.
 *   - `updates.getState`  → current machine-private updater state, plus the
 *                           main-computed `has_update` / `install_ready` flags
 *                           and the authoritative `download` runtime state.
 *   - `updates.dismiss`   → stop automatic reminders for a version.
 *   - `updates.download`  → download + verify the latest installer; progress
 *                           is pushed to this window on `updates:progress`.
 *   - `updates.pauseDownload` / `updates.resumeDownload` / `updates.cancelDownload`
 *                         → stop the transfer keeping the bytes on disk, continue
 *                           it with a Range request, or discard it.
 *   - `updates.open`      → open the verified installer in the OS.
 *
 * Push events (preload allow-list `updates:`): `updates:available`,
 * `updates:progress`, `updates:download` (phase changes), `updates:auto`.
 * Renderer-side status for manual checks comes back synchronously through the
 * invoke result.
 *
 * Phase changes are PUSHED rather than inferred by the renderer: a pane that
 * tracks "am I downloading?" locally desynchronises from main the moment a
 * second request is rejected with `already_downloading`, and then silently drops
 * every later progress push (2026-09-21 report).
 */

import * as updater from '../features/updater/client';
import * as updaterAuto from '../features/updater/auto';
import { readUpdaterState } from '../features/updater/state';

/** Throttle progress pushes to the renderer (download chunks are frequent). */
const PROGRESS_PUSH_INTERVAL_MS = 200;

/**
 * 自动更新状态推送到渲染层（设置页「自动更新」行）。
 * 初始化在 app ready 之后进行（auto.ts 内部要求 app.isPackaged 才启用）。
 */
export function initAutoUpdateBridge(send: (channel: string, payload: unknown) => void): void {
  updaterAuto.initAutoUpdate((status) => {
    try {
      send('updates:auto', status);
    } catch { /* window gone */ }
  });
}

/**
 * 下载阶段变化推送到渲染层（`updates:download`）。渲染层不再自己记录「是否正在
 * 下载」，否则本地状态与主进程一脱节，重复点击就会把进度面永久拆掉。
 */
export function initDownloadStateBridge(send: (channel: string, payload: unknown) => void): void {
  updater.setDownloadStateListener((state) => {
    try {
      send('updates:download', state);
    } catch { /* window gone */ }
  });
}

let _lastProgressPushAt = 0;

export const invokeHandlers = {
  'updates.check': async (
    payload: { manual?: unknown } = {},
    ctx: { userId: string },
  ) => {
    const manual = payload && payload.manual === true;
    return updater.checkForUpdates(ctx.userId, { manual });
  },

  'updates.getState': async (_payload: unknown, ctx: { userId: string }) => {
    // Reconcile first: a persisted `latest_info` from an earlier session must not
    // keep the download/open buttons on screen for a version we already run.
    await updater.reconcileStaleState(ctx.userId);
    const state = readUpdaterState(ctx.userId);
    const current = updater.currentAppVersion();
    return {
      state,
      current_version: current,
      has_update: updater.isUpdateOffered(state, current),
      install_ready: updater.isInstallReady(state, current),
      download: await updater.getDownloadState(ctx.userId),
    };
  },

  'updates.dismiss': async (
    payload: { version?: unknown },
    ctx: { userId: string },
  ) => {
    const version = payload && typeof payload.version === 'string' ? payload.version.trim() : '';
    if (!version) throw new Error('version required');
    updater.dismissVersion(ctx.userId, version);
    return { ok: true, dismissed_version: version };
  },

  'updates.download': async (
    _payload: unknown,
    ctx: { userId: string; sender: { send(channel: string, payload: unknown): void } },
  ) => {
    const result = await updater.downloadUpdate(ctx.userId, {
      onProgress: (progress) => {
        const now = Date.now();
        if (now - _lastProgressPushAt < PROGRESS_PUSH_INTERVAL_MS && progress.percent < 100) return;
        _lastProgressPushAt = now;
        ctx.sender.send('updates:progress', progress);
      },
    });
    if (result.ok) {
      ctx.sender.send('updates:progress', { received: result.size, total: result.size, percent: 100 });
    }
    // Final authority after the invoke settles: the renderer adopts this instead
    // of deciding for itself whether the transfer ended badly.
    ctx.sender.send('updates:download', await updater.getDownloadState(ctx.userId));
    return result;
  },

  'updates.pauseDownload': async (
    _payload: unknown,
    ctx: { userId: string; sender: { send(channel: string, payload: unknown): void } },
  ) => {
    const result = await updater.pauseDownload(ctx.userId);
    ctx.sender.send('updates:download', await updater.getDownloadState(ctx.userId));
    return result;
  },

  'updates.resumeDownload': async (
    _payload: unknown,
    ctx: { userId: string; sender: { send(channel: string, payload: unknown): void } },
  ) => {
    const result = await updater.resumeDownload(ctx.userId, {
      onProgress: (progress) => {
        const now = Date.now();
        if (now - _lastProgressPushAt < PROGRESS_PUSH_INTERVAL_MS && progress.percent < 100) return;
        _lastProgressPushAt = now;
        ctx.sender.send('updates:progress', progress);
      },
    });
    if (result.ok) {
      ctx.sender.send('updates:progress', { received: result.size, total: result.size, percent: 100 });
    }
    ctx.sender.send('updates:download', await updater.getDownloadState(ctx.userId));
    return result;
  },

  'updates.cancelDownload': async (
    _payload: unknown,
    ctx: { userId: string; sender: { send(channel: string, payload: unknown): void } },
  ) => {
    const result = await updater.cancelDownload(ctx.userId);
    ctx.sender.send('updates:download', await updater.getDownloadState(ctx.userId));
    return result;
  },

  'updates.open': async (_payload: unknown, ctx: { userId: string }) => {
    return updater.openDownloaded(ctx.userId);
  },

  // ── 自动更新（Squirrel.Mac）：状态查询 / 手动检查 / 重启并安装 ──
  'updates.autoStatus': async () => {
    return { status: updaterAuto.getAutoUpdateStatus() };
  },

  'updates.autoCheck': async () => {
    return { status: updaterAuto.checkAutoUpdate() };
  },

  'updates.autoInstall': async () => {
    return { status: updaterAuto.installAutoUpdate() };
  },
};
