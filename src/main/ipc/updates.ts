/**
 * IPC handlers for the in-app update reminder feature.
 *
 * Logical channels exposed to the renderer:
 *   - `updates.check`     → run an update check. `{ manual: true }` (settings
 *                           page) bypasses the once-per-day reminder throttle
 *                           and always reports the truth; boot-time checks use
 *                           `{ manual: false }` and decide surfacing via the
 *                           returned `reminded` flag.
 *   - `updates.getState`  → current machine-private updater state.
 *   - `updates.dismiss`   → stop automatic reminders for a version.
 *   - `updates.download`  → download + verify the latest installer; progress
 *                           is pushed to this window on `updates:progress`.
 *   - `updates.open`      → open the verified installer in the OS.
 *
 * Push events (preload allow-list `updates:`): `updates:available`,
 * `updates:progress`. Renderer-side status for manual checks comes back
 * synchronously through the invoke result.
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
    return { state: readUpdaterState(ctx.userId), current_version: updater.currentAppVersion() };
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
