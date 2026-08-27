/**
 * Auto-update (Squirrel.Mac) module: state machine, feed URL, event wiring,
 * and the quitAndInstall gate. Electron is mocked; the module under test is
 * re-imported per case to reset its module-level singletons.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  const handlers: Record<string, Handler> = {};
  return {
    app: {
      isPackaged: false,
    },
    autoUpdater: {
      on: vi.fn((event: string, cb: Handler) => { handlers[event] = cb; }),
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
      emit: (event: string, ...args: unknown[]) => {
        const cb = handlers[event];
        if (cb) cb(...args);
      },
    },
  };
});

vi.mock('electron', () => ({ app: electronMock.app, autoUpdater: electronMock.autoUpdater }));

const API_BASE = 'https://api.example.com';

async function freshAuto(): Promise<typeof import('../../../../src/main/features/updater/auto')> {
  vi.resetModules();
  process.env.COGSEED_API_BASE_URL = API_BASE;
  return import('../../../../src/main/features/updater/auto');
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.app.isPackaged = false;
});

describe('自动更新模块（Squirrel.Mac）', () => {
  it('开发模式：init/check 均返回 disabled，不访问 feed', async () => {
    electronMock.app.isPackaged = false;
    const auto = await freshAuto();
    const statuses: Array<{ state: string }> = [];
    const status = auto.initAutoUpdate((s) => statuses.push(s));
    expect(status.state).toBe('disabled');
    expect(auto.checkAutoUpdate().state).toBe('disabled');
    expect(electronMock.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(electronMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(statuses.some((s) => s.state === 'disabled')).toBe(true);
  });

  it('打包模式：init 设置 feed URL（mac-arm64）并静默检查', async () => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();
    const status = auto.initAutoUpdate();
    expect(status.state).toBe('idle');
    expect(electronMock.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      url: `${API_BASE}/updates/feed/mac-${process.arch}`,
    });
    expect(electronMock.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('事件流：available→downloading，downloaded→携带版本，listener 收到完整状态序列', async () => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();
    const statuses: Array<{ state: string; version?: string; percent?: number }> = [];
    auto.initAutoUpdate((s) => statuses.push(s));

    electronMock.autoUpdater.emit('checking-for-update');
    electronMock.autoUpdater.emit('update-available');
    electronMock.autoUpdater.emit('update-downloaded', {}, 'release notes', '0.1.4');

    expect(statuses.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloaded']);
    expect(auto.getAutoUpdateStatus()).toMatchObject({ state: 'downloaded', version: '0.1.4' });
  });

  it('下载完成前调用 install 不触发 quitAndInstall；下载完成后触发', async () => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();
    auto.initAutoUpdate();

    auto.installAutoUpdate();
    expect(electronMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    electronMock.autoUpdater.emit('update-available');
    electronMock.autoUpdater.emit('update-downloaded', {}, '', '');
    auto.installAutoUpdate();
    expect(electronMock.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('错误事件进入 error 状态并携带消息，不抛出', async () => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();
    const statuses: Array<{ state: string; message?: string }> = [];
    auto.initAutoUpdate((s) => statuses.push(s));

    electronMock.autoUpdater.emit('error', new Error('feed unreachable'));
    expect(auto.getAutoUpdateStatus()).toMatchObject({ state: 'error', message: 'feed unreachable' });
  });

  it('无更新事件回到 idle 状态', async () => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();
    auto.initAutoUpdate();

    electronMock.autoUpdater.emit('checking-for-update');
    electronMock.autoUpdater.emit('update-not-available');
    expect(auto.getAutoUpdateStatus().state).toBe('idle');
  });
});
