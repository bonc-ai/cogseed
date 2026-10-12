// Settings › 关于我们 —— Windows「重启并安装」（v1 静默安装通道，Task 7）。
//
// 覆盖三类失败/边界：
//   1. 渲染层根本不知道平台与「已校验安装包」的关系：macOS 或已装好的版本上
//      出现静默安装入口，点了要么无事发生、要么把同一个包再装一次；
//   2. 主进程成功后几乎立刻退出（detached helper 接管），渲染层若等后续状态
//      推送才反馈，用户看到的是一个按下去没反应的按钮；
//   3. Task 5 的引导自检（boot guard）判定没有任何消费方：升级后连续两次启动
//      不稳定时，界面照旧提供「重启并安装」，用户被送进同一个升级循环。
//
// 纯函数部分走 CommonJS 桥接（AGENTS.md：纯渲染函数可以有守卫的 CJS 桥）；
// 其余用例与 updater-about-progress.test.ts 同款手写 DOM 假体，跑真实模块 +
// 真实语言表 + 真实 ui-button.js / ui-status.js，走「收推送 / 点按钮」的真实链路。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installActionFor, installPlatformFor, bootGuardNoticeFor } = require('../../src/renderer/modules/updater.js') as {
  installActionFor(input: {
    platform: string; state: string; downloadedVersion: string; currentVersion: string;
  }): { visible: boolean; label: string; enabled: boolean };
  installPlatformFor(nav: { userAgentData?: { platform?: string }; platform?: string; userAgent?: string } | null): string;
  bootGuardNoticeFor(
    bootGuard: Record<string, unknown> | null,
    install?: Record<string, unknown> | null,
  ): { key: string; vars: Record<string, string>; blocking: boolean; hidesInstallAction: boolean };
};

const root = resolve(__dirname, '../..');
const zh = JSON.parse(
  readFileSync(resolve(root, 'src/renderer/locales/zh.json'), 'utf8'),
) as Record<string, string>;
const en = JSON.parse(
  readFileSync(resolve(root, 'src/renderer/locales/en.json'), 'utf8'),
) as Record<string, string>;
const updaterSource = readFileSync(resolve(root, 'src/renderer/modules/updater.js'), 'utf8');
const uiButtonSource = readFileSync(resolve(root, 'src/renderer/modules/ui-button.js'), 'utf8');
const uiStatusSource = readFileSync(resolve(root, 'src/renderer/modules/ui-status.js'), 'utf8');

describe('windows install action', () => {
  it('offers a restart-and-install action once a verified download exists', () => {
    const action = installActionFor({
      platform: 'win32', state: 'downloaded', downloadedVersion: '0.0.9', currentVersion: '0.0.5',
    });
    expect(action).toEqual({ visible: true, label: 'updates.action.restart_install', enabled: true });
  });

  it('hides the action when the downloaded build is already running', () => {
    const action = installActionFor({
      platform: 'win32', state: 'downloaded', downloadedVersion: '0.0.9', currentVersion: '0.0.9',
    });
    expect(action.visible).toBe(false);
  });

  it('does not offer silent install on macOS', () => {
    const action = installActionFor({
      platform: 'darwin', state: 'downloaded', downloadedVersion: '0.0.9', currentVersion: '0.0.5',
    });
    expect(action.visible).toBe(false);
  });

  it('normalizes the renderer platform strings to the action contract', () => {
    expect(installPlatformFor({ platform: 'Win32' })).toBe('win32');
    expect(installPlatformFor({ userAgentData: { platform: 'Windows' } })).toBe('win32');
    expect(installPlatformFor({ platform: 'MacIntel' })).toBe('darwin');
    expect(installPlatformFor({ userAgentData: { platform: 'macOS' } })).toBe('darwin');
    expect(installPlatformFor({ platform: 'Linux x86_64' })).toBe('linux');
    expect(installPlatformFor({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('win32');
    expect(installPlatformFor(null)).toBe('');
  });

  it('treats a missing boot-guard verdict as unknown, not healthy', () => {
    expect(bootGuardNoticeFor(null)).toMatchObject({ key: '', hidesInstallAction: false });
    expect(bootGuardNoticeFor(undefined)).toMatchObject({ key: '', hidesInstallAction: false });
    expect(bootGuardNoticeFor({ unstable: false, installMissed: false }))
      .toMatchObject({ key: '', hidesInstallAction: false });
  });

  it('pauses the install action on an unstable upgrade verdict', () => {
    const notice = bootGuardNoticeFor({ unstable: true, reason: 'unstable', fromVersion: '0.0.4', toVersion: '0.0.5' });
    expect(notice).toMatchObject({ key: 'updates.boot_guard.unstable', blocking: true, hidesInstallAction: true });
  });

  it('only informs when a previously started install did not take effect', () => {
    const notice = bootGuardNoticeFor({ unstable: false, installMissed: true, reason: 'install-missed' }, { version: '0.0.9', attempts: 1 });
    expect(notice).toMatchObject({
      key: 'updates.boot_guard.install_missed', vars: { version: '0.0.9' }, blocking: false, hidesInstallAction: false,
    });
    expect(bootGuardNoticeFor({ unstable: false, installMissed: true }, null))
      .toMatchObject({ key: 'updates.boot_guard.install_missed_unknown', hidesInstallAction: false });
  });

  it('localizes every new string in both shipped languages', () => {
    for (const key of [
      'updates.action.restart_install',
      'updates.boot_guard.unstable',
      'updates.boot_guard.install_missed',
      'updates.boot_guard.install_missed_unknown',
      'updates.install.in_progress',
      'updates.install.failed',
      'settings.updates.errors.install_no_download',
      'settings.updates.errors.install_attempts_exhausted',
      'settings.updates.errors.install_unsupported_platform',
      'settings.updates.errors.install_in_progress',
    ]) {
      expect(zh[key], `zh missing ${key}`).toBeTruthy();
      expect(en[key], `en missing ${key}`).toBeTruthy();
    }
  });
});

// ── real-page integration: Settings › 关于我们 更新区 ───────────────────────

const UPDATER_IDS = [
  'updater-status-row',
  'updater-status-text',
  'updater-actions-row',
  'updater-install-slot',
  'updater-notice-row',
  'updater-notice-text',
  'updater-progress-row',
  'updater-progress-bar',
  'updater-progress-text',
  'updater-progress-actions',
  'updater-auto-row',
  'updater-auto-text',
  'updater-auto-install-btn',
  'updater-check-btn',
  'updater-download-btn',
  'updater-open-btn',
  'updater-skip-btn',
  'updater-current-version',
  'updater-banner',
  'updater-banner-text',
  'updater-banner-view-btn',
  'updater-banner-later-btn',
];

const LATEST_INFO = {
  latest_version: '0.0.9',
  url: 'https://updates.example/CogSeed-win-x64.exe',
  sha256: 'a'.repeat(64),
  size: 1024 * 1024,
};

/** 与 modules/i18n.js 的 t() 同语义：查表 → {var} 替换（缺值保留占位符）。 */
function localeT(table: Record<string, string>, key: string, vars?: Record<string, string>) {
  const raw = table[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) => (vars[name] != null ? String(vars[name]) : match));
}

function tFor(key: string, vars?: Record<string, string>) {
  return localeT(zh, key, vars);
}

class FakeElement {
  readonly id: string;
  hidden = false;
  textContent = '';
  className = '';
  style: Record<string, string> = {};
  private _html = '';
  private _ownedIds: string[] = [];
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();
  private readonly dom: FakeDom;

  constructor(id = '', dom: FakeDom = { registerIds: () => {}, resetElement: () => {} }) {
    this.id = id;
    this.dom = dom;
  }

  get innerHTML() {
    return this._html;
  }

  /** 动态渲染的共享控件（重启并安装按钮 / 进度条）走 innerHTML。 */
  set innerHTML(value: string) {
    this._html = String(value == null ? '' : value);
    for (const id of this._ownedIds) this.dom.resetElement(id);
    this._ownedIds = [...this._html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    this.dom.registerIds(this._ownedIds);
  }

  clearListeners() {
    this.listeners.clear();
  }

  querySelector(selector: string) {
    if (selector !== '.ui-button__label') return null;
    const labelId = `${this.id}::label`;
    this.dom.registerIds([labelId]);
    return this.dom.get(labelId) || null;
  }

  setAttribute(name: string, value: string) {
    if (name === 'data-i18n') this.i18nKey = String(value);
  }

  getAttribute(name: string) {
    return name === 'data-i18n' ? this.i18nKey : null;
  }

  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  async click() {
    for (const handler of this.listeners.get('click') || []) {
      await handler({ currentTarget: this, target: this });
    }
  }

  /** 当前已绑定的处理函数快照：用于模拟同一帧内排队的第二次点击。 */
  handlers(type = 'click') {
    return [...(this.listeners.get(type) || [])];
  }

  private i18nKey: string | null = null;
}

interface FakeDom {
  registerIds(ids: string[]): void;
  resetElement(id: string): void;
  get(id: string): FakeElement | undefined;
}

function flush() {
  return new Promise((done) => setTimeout(done, 0));
}

function buildHarness(options: {
  /** 渲染层能拿到的平台串（navigator）。 */
  platform?: string;
  currentVersion?: string;
  hasUpdate?: boolean;
  /** 主进程判定：已有校验通过、比当前版本新的安装包。 */
  installReady?: boolean;
  /** 已下载记录的版本（主进程持久化状态）。 */
  downloadedVersion?: string;
  /** `updates.getState` 里保留的安装记录（主进程投影为 version/attempts）。 */
  install?: Record<string, unknown> | null;
  /** 引导自检判定；null = 尚未判定（未知，不是健康）。 */
  bootGuard?: Record<string, unknown> | null;
  /** `updates.install` 的返回。 */
  installResult?: Record<string, unknown>;
  /** 让 `updates.install` 直接 reject（而不是 resolve 成 {started:false}）。 */
  installRejects?: string;
} = {}) {
  const registry = new Map<string, FakeElement>();
  const staticIds = new Set(UPDATER_IDS);
  const dom: FakeDom = {
    registerIds(ids) {
      for (const id of ids) {
        if (!registry.has(id)) registry.set(id, new FakeElement(id, dom));
      }
    },
    resetElement(id) {
      if (staticIds.has(id)) return;
      registry.get(id)?.clearListeners();
    },
    get(id) {
      return registry.get(id);
    },
  };
  for (const id of UPDATER_IDS) registry.set(id, new FakeElement(id, dom));
  const rowsContainer = new FakeElement('settings-about-rows', dom);

  const pushHandlers = new Map<string, (payload: any) => unknown>();
  const windowListeners = new Map<string, () => void>();
  const alerts: string[] = [];

  const server = {
    current_version: options.currentVersion || '0.0.5',
    has_update: options.hasUpdate !== false,
    install_ready: options.installReady === true,
    downloaded: options.downloadedVersion
      ? { version: options.downloadedVersion, path: 'C:\\tmp\\CogSeed.exe', sha256: 'a'.repeat(64) }
      : null,
    install: options.install ?? null,
    boot_guard: options.bootGuard ?? null,
  };

  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'updates.getState') {
      return {
        ok: true,
        current_version: server.current_version,
        state: {
          latest_info: LATEST_INFO,
          downloaded: server.downloaded,
          install: server.install || undefined,
        },
        has_update: server.has_update,
        install_ready: server.install_ready,
        download: { phase: 'idle', received: 0, total: 0, percent: 0 },
        boot_guard: server.boot_guard,
      };
    }
    if (channel === 'updates.autoStatus') return { ok: true, status: { state: 'disabled' } };
    if (channel === 'updates.install') {
      if (options.installRejects) throw new Error(options.installRejects);
      return options.installResult || { started: true };
    }
    if (channel === 'updates.check') {
      return { ok: true, checked: true, has_update: true, info: LATEST_INFO, current_version: server.current_version };
    }
    return { ok: true };
  });

  const windowObj: any = {
    cogseed: {
      invoke,
      onPushEvent(channel: string, handler: (payload: any) => unknown) {
        pushHandlers.set(channel, handler);
      },
    },
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'i18n-change') windowListeners.set(type, handler);
    },
  };
  windowObj.window = windowObj;

  const context: any = {
    createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    t: tFor,
    window: windowObj,
    navigator: { platform: options.platform || 'Win32' },
    // 失败路径走共享 uiAlert 弹窗；这里只关心它被调用的文案。
    uiAlert: (message: string) => { alerts.push(String(message)); return Promise.resolve(); },
    document: {
      readyState: 'complete',
      getElementById: (id: string) => registry.get(id) || null,
      querySelector: (selector: string) => (selector === '.settings-about-rows' ? rowsContainer : null),
      addEventListener: () => {},
    },
  };
  vm.createContext(context);
  // 真机由共享组件提供工厂；这里加载同一份生产实现，而不是在测试里复刻假工厂。
  vm.runInContext(uiButtonSource, context, { filename: 'ui-button.js' });
  context.uiButton = windowObj.uiButton;
  vm.runInContext(uiStatusSource, context, { filename: 'ui-status.js' });
  context.uiProgressBar = windowObj.uiProgressBar;
  vm.runInContext(updaterSource, context, { filename: 'updater.js' });

  const el = (id: string) => registry.get(id) as FakeElement;
  return {
    el,
    invoke,
    alerts,
    server,
    refresh: () => windowObj._updaterRefreshSettings() as Promise<void>,
    /** 切语言并派发真机的 `i18n-change`：动态文案必须跟着重渲染。 */
    switchLang: (lang: 'zh' | 'en') => {
      context.t = lang === 'en'
        ? (key: string, vars?: Record<string, string>) => localeT(en, key, vars)
        : tFor;
      windowListeners.get('i18n-change')?.();
    },
  };
}

const VERIFIED = {
  platform: 'Win32',
  installReady: true,
  downloadedVersion: '0.0.9',
  installResult: { started: true },
} as const;

describe('settings about pane windows restart-and-install', () => {
  it('renders the shared restart-and-install control once the download is verified', async () => {
    const h = buildHarness(VERIFIED);
    await flush();

    const slot = h.el('updater-install-slot');
    expect(slot.innerHTML).toContain('updater-install-btn');
    expect(slot.innerHTML).toContain(tFor('updates.action.restart_install'));
    // 共享按钮契约：不能是页面自拼的裸控件。
    expect(slot.innerHTML).toContain('ui-button--primary');

    await h.el('updater-install-btn').click();
    await flush();
    expect(h.invoke).toHaveBeenCalledWith('updates.install', {});
  });

  it('does not offer the action without a verified newer download', async () => {
    const upToDate = buildHarness({ ...VERIFIED, downloadedVersion: '0.0.5' });
    await flush();
    expect(upToDate.el('updater-install-slot').innerHTML).toBe('');

    const notDownloaded = buildHarness({ platform: 'Win32', installReady: false });
    await flush();
    expect(notDownloaded.el('updater-install-slot').innerHTML).toBe('');
  });

  it('does not offer silent install on macOS', async () => {
    const h = buildHarness({ ...VERIFIED, platform: 'MacIntel' });
    await flush();
    expect(h.el('updater-install-slot').innerHTML).toBe('');
  });

  it('hides the legacy open-installer entry once the Windows silent action is offered', async () => {
    const h = buildHarness(VERIFIED);
    await flush();

    // 同一个包、同一个入口位置：旧入口和新入口同时出现，用户会分不清按哪个。
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');
    expect(h.el('updater-open-btn').hidden).toBe(true);
  });

  it('keeps the open-installer entry on macOS', async () => {
    const h = buildHarness({ ...VERIFIED, platform: 'MacIntel' });
    await flush();

    // macOS 没有静默通道，打开 dmg 仍是唯一入口。
    expect(h.el('updater-install-slot').innerHTML).toBe('');
    expect(h.el('updater-open-btn').hidden).toBe(false);
  });

  it('brings the open-installer entry back when the silent action is blocked', async () => {
    const h = buildHarness({
      ...VERIFIED,
      bootGuard: { unstable: true, reason: 'unstable', fromVersion: '0.0.4', toVersion: '0.0.5' },
    });
    await flush();

    // 静默入口被引导自检收起时，手动打开安装包是用户唯一的出路。
    expect(h.el('updater-install-slot').innerHTML).toBe('');
    expect(h.el('updater-open-btn').hidden).toBe(false);
  });

  it('keeps an optimistic installing state after the main process takes over', async () => {
    // 成功路径上主进程几乎立刻退出：等不到后续状态推送，界面必须自己给出
    // 「正在重启并安装」而不是停在按下去没反应的按钮上。
    const h = buildHarness(VERIFIED);
    await flush();

    await h.el('updater-install-btn').click();
    await flush();

    const slot = h.el('updater-install-slot');
    expect(slot.innerHTML).toContain('role="progressbar"');
    expect(slot.innerHTML).not.toContain('updater-install-btn');
    expect(h.el('updater-notice-row').hidden).toBe(false);
    expect(h.el('updater-notice-text').textContent).toBe(tFor('updates.install.in_progress'));
  });

  it('alerts with the main-process error and re-enables the action on failure', async () => {
    const h = buildHarness({
      ...VERIFIED,
      installResult: { started: false, error: 'no verified download to install' },
    });
    await flush();
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');

    await h.el('updater-install-btn').click();
    await flush();

    expect(h.alerts).toEqual([
      tFor('updates.install.failed', { message: zh['settings.updates.errors.install_no_download'] }),
    ]);
    // 失败后动作必须回到可用状态，否则用户没有第二次机会。
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');
    expect(h.el('updater-install-slot').innerHTML).not.toContain('role="progressbar"');
  });

  it('surfaces an exhausted install hand-off without stranding the user', async () => {
    const h = buildHarness({
      ...VERIFIED,
      installResult: { started: false, error: 'install attempts exhausted' },
    });
    await flush();

    await h.el('updater-install-btn').click();
    await flush();

    expect(h.alerts).toEqual([
      tFor('updates.install.failed', { message: zh['settings.updates.errors.install_attempts_exhausted'] }),
    ]);
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');
  });

  // 主进程的稳定错误串渲染层必须认识，否则中文界面会收到英文原话。
  const INSTALL_ERROR_KEYS: Array<[string, string]> = [
    ['no verified download to install', 'settings.updates.errors.install_no_download'],
    ['install attempts exhausted', 'settings.updates.errors.install_attempts_exhausted'],
    ['unsupported platform', 'settings.updates.errors.install_unsupported_platform'],
    // installer.ts 的抛错带模块前缀，必须收敛到同一个 key。
    ['installDownloadedUpdate: unsupported platform', 'settings.updates.errors.install_unsupported_platform'],
    ['install already in progress', 'settings.updates.errors.install_in_progress'],
  ];

  it('localizes every stable install hand-off error in both languages', async () => {
    for (const [raw, key] of INSTALL_ERROR_KEYS) {
      const h = buildHarness({ ...VERIFIED, installResult: { started: false, error: raw } });
      await flush();

      await h.el('updater-install-btn').click();
      await flush();
      expect(h.alerts, raw).toEqual([localeT(zh, 'updates.install.failed', { message: zh[key] })]);
      expect(h.alerts[0], raw).not.toContain(raw);

      h.switchLang('en');
      await h.el('updater-install-btn').click();
      await flush();
      expect(h.alerts, raw).toEqual([
        localeT(zh, 'updates.install.failed', { message: zh[key] }),
        localeT(en, 'updates.install.failed', { message: en[key] }),
      ]);
      expect(h.alerts[1], raw).not.toContain(raw);
    }
  });

  it('wraps installer-reported text verbatim when no stable code matches', async () => {
    // 安装器原话（checksum mismatch / spawn failed: …）没有稳定错误码，必须原样带出，
    // 而不是被吞成一句泛化的「安装失败」。
    const raw = 'installDownloadedUpdate: installer checksum mismatch';
    const h = buildHarness({ ...VERIFIED, installResult: { started: false, error: raw } });
    await flush();

    await h.el('updater-install-btn').click();
    await flush();

    expect(h.alerts).toEqual([tFor('updates.install.failed', { message: raw })]);
  });

  it('recovers the action when the install hand-off itself rejects', async () => {
    // invoke 直接抛错（不是 resolve 成 {started:false}）：同样不能把界面留在
    // 「正在重启并安装」上。
    const h = buildHarness({ ...VERIFIED, installRejects: 'bridge closed' });
    await flush();
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');

    await h.el('updater-install-btn').click();
    await flush();

    expect(h.alerts).toEqual([tFor('updates.install.failed', { message: 'bridge closed' })]);
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');
    expect(h.el('updater-install-slot').innerHTML).not.toContain('role="progressbar"');
    expect(h.el('updater-notice-row').hidden).toBe(true);
  });

  it('ignores a second click while the install hand-off is in flight', async () => {
    // 双击守卫：真机上第二次点击可能在第一次 invoke resolve 之前到达。
    const h = buildHarness(VERIFIED);
    await flush();

    const click = h.el('updater-install-btn').handlers()[0];
    expect(typeof click).toBe('function');
    click();
    click();
    await flush();

    expect(h.invoke.mock.calls.filter((call) => call[0] === 'updates.install')).toHaveLength(1);
    expect(h.el('updater-install-slot').innerHTML).toContain('role="progressbar"');
    expect(h.alerts).toEqual([]);
  });

  it('pauses the action and explains an unstable upgrade', async () => {
    const h = buildHarness({
      ...VERIFIED,
      bootGuard: { unstable: true, installMissed: false, reason: 'unstable', fromVersion: '0.0.4', toVersion: '0.0.5' },
    });
    await flush();

    // Task 5 的安全网必须有消费方：不稳定的升级不能再给同一个入口。
    expect(h.el('updater-install-slot').innerHTML).toBe('');
    expect(h.el('updater-notice-row').hidden).toBe(false);
    expect(h.el('updater-notice-text').textContent).toBe(zh['updates.boot_guard.unstable']);
    expect(h.el('updater-notice-text').className).toContain('settings-updater-status-error');
  });

  it('only informs when a previously started install did not take effect', async () => {
    const h = buildHarness({
      ...VERIFIED,
      install: { version: '0.0.9', attempts: 1 },
      bootGuard: { unstable: false, installMissed: true, reason: 'install-missed' },
    });
    await flush();

    // 保留中的安装记录可能只是「交接还在飞行中」：不能收掉入口，用户可以重试。
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');
    expect(h.el('updater-notice-text').textContent)
      .toBe(tFor('updates.boot_guard.install_missed', { version: '0.0.9' }));
    expect(h.el('updater-notice-text').className).not.toContain('settings-updater-status-error');
  });

  it('shows nothing extra when the guard has not judged this uid', async () => {
    const h = buildHarness(VERIFIED);
    await flush();

    expect(h.el('updater-notice-row').hidden).toBe(true);
    expect(h.el('updater-notice-text').textContent).toBe('');
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');
  });

  it('drops the action when the guard verdict arrives on a later refresh', async () => {
    const h = buildHarness(VERIFIED);
    await flush();
    expect(h.el('updater-install-slot').innerHTML).toContain('updater-install-btn');

    h.server.boot_guard = { unstable: true, reason: 'unstable', fromVersion: '0.0.4', toVersion: '0.0.5' };
    await h.refresh();

    expect(h.el('updater-install-slot').innerHTML).toBe('');
    expect(h.el('updater-notice-text').textContent).toBe(zh['updates.boot_guard.unstable']);
  });

  it('re-renders the action and the notice on a language switch', async () => {
    const h = buildHarness({
      ...VERIFIED,
      install: { version: '0.0.9', attempts: 1 },
      bootGuard: { unstable: false, installMissed: true, reason: 'install-missed' },
    });
    await flush();
    expect(h.el('updater-install-slot').innerHTML).toContain(zh['updates.action.restart_install']);
    expect(h.el('updater-notice-text').textContent)
      .toBe(localeT(zh, 'updates.boot_guard.install_missed', { version: '0.0.9' }));

    h.switchLang('en');

    // 动态文案必须跟着 i18n-change 重渲染，而不是留在上一个语言。
    expect(h.el('updater-install-slot').innerHTML).toContain(en['updates.action.restart_install']);
    expect(h.el('updater-notice-text').textContent)
      .toBe(localeT(en, 'updates.boot_guard.install_missed', { version: '0.0.9' }));
  });
});
