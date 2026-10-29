'use strict';
/**
 * Minimal `electron` stand-in for CogSeed's TypeScript-loading child processes
 * (`bin/cogseed-embed-worker.cjs`, `bin/cogseed-runtime-worker.cjs`).
 *
 * Why this exists: those children are spawned with `ELECTRON_RUN_AS_NODE=1`,
 * and `electron` is a devDependency that is NOT shipped in the packaged app.
 * The worker entry points pull in host-side modules that use only a tiny slice
 * of Electron (`app.getVersion()`, `app.isPackaged`, `shell.openExternal`), but
 * a top-level `import { app } from 'electron'` fails to *resolve* in the child,
 * so the process died at startup with `Cannot find module 'electron'`.
 *
 * The two worker scripts alias the bare `electron` specifier to this file
 * before loading their TypeScript entry. `bin/**` is unpacked in packaged
 * builds, so the alias target is always on real disk.
 *
 * Design rules:
 *   - Never throw. A child must not die because a host-only surface was
 *     merely touched while a module graph was loading.
 *   - Stay inert. These children own no windows, menus, or app lifecycle;
 *     every side-effecting API is a no-op.
 *   - Be honest where a value is observable: `isPackaged` is false and the
 *     version comes from the environment, so guarded call sites take their
 *     documented non-Electron fallback path.
 *   - `ipcRenderer` is deliberately ABSENT: `electron-log`'s preload branches
 *     on `if (electron.ipcRenderer)` to detect a preload context. Exposing a
 *     stand-in flips that branch on, and the module then reaches for
 *     preload-only globals (`__electronLog`). Keeping it undefined preserves
 *     the inert path that existed when `require('electron')` simply threw.
 */

const noop = () => {};
const asyncNoop = async () => {};

class EmitterLike {
  on() { return this; }
  once() { return this; }
  off() { return this; }
  removeListener() { return this; }
  removeAllListeners() { return this; }
  addListener() { return this; }
  emit() { return false; }
}

const app = Object.assign(new EmitterLike(), {
  isPackaged: false,
  getVersion: () => process.env.COGSEED_APP_VERSION || '',
  getName: () => process.env.COGSEED_APP_NAME || 'CogSeed',
  getAppPath: () => '',
  getPath: () => '',
  setPath: noop,
  getLocale: () => process.env.LANG || 'en',
  getSystemLocale: () => process.env.LANG || 'en',
  whenReady: asyncNoop,
  isReady: () => false,
  quit: noop,
  exit: noop,
  relaunch: noop,
  requestSingleInstanceLock: () => false,
  releaseSingleInstanceLock: noop,
  setAppUserModelId: noop,
  setName: noop,
  commandLine: { appendSwitch: noop, appendArgument: noop },
});

const ipcMain = new EmitterLike();
ipcMain.handle = noop;
ipcMain.handleOnce = noop;
ipcMain.removeHandler = noop;

module.exports = {
  app,
  shell: {
    openExternal: asyncNoop,
    openPath: async () => '',
    showItemInFolder: noop,
    trashItem: asyncNoop,
    beep: noop,
  },
  ipcMain,
  powerMonitor: new EmitterLike(),
  nativeTheme: Object.assign(new EmitterLike(), { shouldUseDarkColors: false }),
  session: { defaultSession: { setPermissionRequestHandler: noop } },
  protocol: { handle: noop, registerSchemesAsPrivileged: noop, unhandle: noop },
  dialog: { showOpenDialog: asyncNoop, showSaveDialog: asyncNoop, showMessageBox: asyncNoop },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  net: { fetch: async () => { throw new Error('electron.net unavailable in child process'); } },
  clipboard: { readText: () => '', writeText: noop },
  Menu: { buildFromTemplate: () => null, setApplicationMenu: noop },
  Notification: class { static isSupported() { return false; } show() {} close() {} },
  BrowserWindow: class {
    static getAllWindows() { return []; }
    static getFocusedWindow() { return null; }
    static fromWebContents() { return null; }
  },
  WebContentsView: class {},
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 0, height: 0 }, workAreaSize: { width: 0, height: 0 } }),
    getAllDisplays: () => [],
  },
  webContents: { getAllWebContents: () => [] },
  utilityProcess: { fork: () => { throw new Error('electron.utilityProcess unavailable in child process'); } },
};
