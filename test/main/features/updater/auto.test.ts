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
      // 真实进程里 app.getVersion() 一定有值；测试替身同样给一个，否则
      // 「已下载版本是否更新」这条判据在用例里永远走不到。
      getVersion: vi.fn(() => '0.1.0'),
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
const packagedMac = { isPackaged: true, platform: 'darwin' as NodeJS.Platform };
const packagedWindows = { isPackaged: true, platform: 'win32' as NodeJS.Platform };
const packagedLinux = { isPackaged: true, platform: 'linux' as NodeJS.Platform };

async function freshAuto(): Promise<typeof import('../../../../src/main/features/updater/auto')> {
  vi.resetModules();
  process.env.COGSEED_API_BASE_URL = API_BASE;
  return import('../../../../src/main/features/updater/auto');
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.app.isPackaged = false;
  electronMock.app.getVersion.mockReturnValue('0.1.0');
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
    const status = auto.initAutoUpdate(undefined, packagedMac);
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
    auto.initAutoUpdate((s) => statuses.push(s), packagedMac);

    electronMock.autoUpdater.emit('checking-for-update');
    electronMock.autoUpdater.emit('update-available');
    electronMock.autoUpdater.emit('update-downloaded', {}, 'release notes', '0.1.4');

    expect(statuses.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloaded']);
    expect(auto.getAutoUpdateStatus()).toMatchObject({ state: 'downloaded', version: '0.1.4' });
  });

  it('下载完成前调用 install 不触发 quitAndInstall；下载完成后触发', async () => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();
    auto.initAutoUpdate(undefined, packagedMac);

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
    auto.initAutoUpdate((s) => statuses.push(s), packagedMac);

    electronMock.autoUpdater.emit('error', new Error('feed unreachable'));
    expect(auto.getAutoUpdateStatus()).toMatchObject({ state: 'error', message: 'feed unreachable' });
  });

  it('无更新事件回到 idle 状态', async () => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();
    auto.initAutoUpdate(undefined, packagedMac);

    electronMock.autoUpdater.emit('checking-for-update');
    electronMock.autoUpdater.emit('update-not-available');
    expect(auto.getAutoUpdateStatus().state).toBe('idle');
  });

  describe('已是最新版本时不出现「重启并安装」', () => {
    // 报障（2026-09-20）：客户端已经装到最新版，设置页仍然显示「重启并安装」。
    // feed 的 204 闸门只看调用方 UA 里的版本，解析不出来就把当前版本再发一遍，
    // Squirrel 于是下载并回报 update-downloaded——客户端必须自己按版本判据兜住。
    it.each([
      ['同版本', '1.2.0', false],
      ['更低版本', '1.1.0', false],
      ['带 v 前缀的同版本', 'v1.2.0', false],
      ['预发布同版本', '1.2.0-beta.1', false],
      ['更高版本', '1.2.1', true],
      ['四段版本更高', '1.2.0.1', true],
      ['取不到版本号（信息不足，保持原行为）', '', true],
      ['不是版本号形状（信息不足，保持原行为）', 'CogSeed-1.2.0-mac-arm64', true],
    ])('%s：releaseName=%s → 视为更新=%s', async (_name, releaseName, newer) => {
      const auto = await freshAuto();
      expect(auto.isDownloadedVersionNewer(releaseName, '1.2.0')).toBe(newer);
    });

    it('Squirrel 把当前版本再报一次时停在 idle，不给出安装入口', async () => {
      electronMock.app.isPackaged = true;
      electronMock.app.getVersion.mockReturnValue('1.2.0');
      const auto = await freshAuto();
      const statuses: Array<{ state: string }> = [];
      auto.initAutoUpdate((s) => statuses.push(s), packagedMac);

      electronMock.autoUpdater.emit('update-available');
      electronMock.autoUpdater.emit('update-downloaded', {}, 'notes', '1.2.0');

      expect(auto.getAutoUpdateStatus().state).toBe('idle');
      expect(statuses.map((s) => s.state)).not.toContain('downloaded');
      // 渲染层只在 downloaded 时出「重启并安装」，且 install 只认 downloaded：
      // 状态没到位，按钮点不到、装了也 reinstall 不了。
      auto.installAutoUpdate();
      expect(electronMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('Squirrel 把更低版本报成 downloaded 时同样停在 idle', async () => {
      electronMock.app.isPackaged = true;
      electronMock.app.getVersion.mockReturnValue('1.2.0');
      const auto = await freshAuto();
      auto.initAutoUpdate(undefined, packagedMac);

      electronMock.autoUpdater.emit('update-downloaded', {}, '', '1.1.9');
      expect(auto.getAutoUpdateStatus()).toEqual({ state: 'idle' });
    });

    it('更新的版本照旧进入 downloaded 并可安装（回归保护）', async () => {
      electronMock.app.isPackaged = true;
      electronMock.app.getVersion.mockReturnValue('1.2.0');
      const auto = await freshAuto();
      auto.initAutoUpdate(undefined, packagedMac);

      electronMock.autoUpdater.emit('update-downloaded', {}, '', 'v1.3.0');
      expect(auto.getAutoUpdateStatus()).toEqual({ state: 'downloaded', version: 'v1.3.0' });

      auto.installAutoUpdate();
      expect(electronMock.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['Windows', packagedWindows],
    ['Linux', packagedLinux],
  ])('打包后的 %s：自动更新禁用且不访问 Squirrel', async (_name, runtime) => {
    electronMock.app.isPackaged = true;
    const auto = await freshAuto();

    expect(auto.initAutoUpdate(undefined, runtime)).toEqual({
      state: 'disabled',
      reason: 'unsupported_platform',
    });
    expect(auto.checkAutoUpdate(runtime)).toEqual({
      state: 'disabled',
      reason: 'unsupported_platform',
    });
    expect(electronMock.autoUpdater.on).not.toHaveBeenCalled();
    expect(electronMock.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(electronMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(electronMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
