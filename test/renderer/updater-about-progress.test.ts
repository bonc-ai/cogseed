// Settings › 关于我们 更新区 —— 进度口径（2026-09-17 报障：更新时页面出现多个
// 进度条且进度不一致）。DOM 级用例，无 jsdom 依赖：与
// settings-custom-providers.test.ts 同款手写 DOM 假体，跑真实模块 + 真实中文
// 语言表，走「点按钮 / 收推送」的真实链路。
//
// 覆盖的失败路径：
//   1. macOS 打包版上 Squirrel 自动更新拿不到百分比，代码却补了一个 0% —— 与
//      v1 手动下载的进度条同屏出现，两个进度互相矛盾；
//   2. v1 手动下载的状态文案只在 100% 时更新 —— 进度条走到一半，文案还写着
//      「正在下载 0%」；
//   3. 自动更新接管期间仍然给出「下载更新」入口，用户能手动起第二条下载，
//      同一个更新于是有两个进度。
//   4. 明文 http 下载地址（自建/本地部署）被客户端按安全边界拒绝后，报错文案
//      复用了「更新下载地址无效」——把「不安全」说成「写错了」。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../..');
const zh = JSON.parse(
  readFileSync(resolve(root, 'src/renderer/locales/zh.json'), 'utf8'),
) as Record<string, string>;
const updaterSource = readFileSync(resolve(root, 'src/renderer/modules/updater.js'), 'utf8');
const uiButtonSource = readFileSync(resolve(root, 'src/renderer/modules/ui-button.js'), 'utf8');

const UPDATER_IDS = [
  'updater-status-row',
  'updater-status-text',
  'updater-actions-row',
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
  latest_version: '1.2.0',
  url: 'https://updates.example/CogSeed-mac-arm64.dmg',
  sha256: 'a'.repeat(64),
  size: 1024 * 1024,
};

/** 与 modules/i18n.js 的 t() 同语义：查表 → {var} 替换（缺值保留占位符）。 */
function tFor(key: string, vars?: Record<string, string>) {
  const raw = zh[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) => (vars[name] != null ? String(vars[name]) : match));
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

  /**
   * 动态渲染的共享控件（暂停 / 继续 / 取消）走 innerHTML。这里把渲染出来的 id
   * 注册进假 DOM，测试才能像真机一样按到那些按钮，而不是只比对字符串。
   * 同时模拟"重新赋值 innerHTML 会销毁旧节点"：旧节点的监听器一并丢弃，
   * 否则每渲染一次就多挂一层，点击时指数级放大（真机上不会，因为节点被替换了）。
   */
  get innerHTML() {
    return this._html;
  }

  set innerHTML(value: string) {
    this._html = String(value == null ? '' : value);
    for (const id of this._ownedIds) this.dom.resetElement(id);
    this._ownedIds = [...this._html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    this.dom.registerIds(this._ownedIds);
  }

  clearListeners() {
    this.listeners.clear();
  }

  /** 只服务一个用途：`updater.js` 用它在按钮里换文案（下载更新 ⇄ 重试）。 */
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
  autoStatus?: unknown;
  /** 主进程判定：确实有比当前版本新的更新。 */
  hasUpdate?: boolean;
  /** 主进程判定：已有校验通过、比当前版本新的安装包。 */
  installReady?: boolean;
  /** 主进程持有的下载运行时态（唯一权威）。 */
  download?: Record<string, unknown>;
  /** `updates.check` 的返回（默认"有新版本"）。 */
  check?: Record<string, unknown>;
} = {}) {
  const registry = new Map<string, FakeElement>();
  const staticIds = new Set(UPDATER_IDS);
  const dom: FakeDom = {
    registerIds(ids) {
      for (const id of ids) {
        if (!registry.has(id)) registry.set(id, new FakeElement(id, dom));
      }
    },
    // 只重置动态渲染出来的节点：静态按钮的监听器由模块在 init 时绑定一次。
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
  let resolveDownload: ((value: unknown) => void) | null = null;

  // 主进程状态是唯一权威：`updates.getState` 返回什么，页面就该渲染什么。
  const server = {
    current_version: '1.1.2',
    latest_info: LATEST_INFO as unknown,
    downloaded: null as unknown,
    has_update: options.hasUpdate !== false,
    install_ready: options.installReady === true,
    download: (options.download
      || { phase: 'idle', received: 0, total: 0, percent: 0 }) as Record<string, unknown>,
  };

  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'updates.getState') {
      return {
        ok: true,
        current_version: server.current_version,
        state: { latest_info: server.latest_info, downloaded: server.downloaded },
        has_update: server.has_update,
        install_ready: server.install_ready,
        download: { ...server.download },
      };
    }
    if (channel === 'updates.autoStatus') return { ok: true, status: options.autoStatus ?? null };
    if (channel === 'updates.check') {
      return options.check || {
        ok: true, checked: true, has_update: true, info: LATEST_INFO, current_version: '1.1.2',
      };
    }
    if (channel === 'updates.download') {
      return new Promise((done) => { resolveDownload = done; });
    }
    if (channel === 'updates.resumeDownload') {
      return new Promise((done) => { resolveDownload = done; });
    }
    if (channel === 'updates.pauseDownload') {
      return { ok: false, error: 'paused', paused: true, resumable: true };
    }
    if (channel === 'updates.cancelDownload') {
      return { ok: false, error: 'canceled', canceled: true };
    }
    if (channel === 'updates.autoInstall') return { ok: true, status: { state: 'downloaded', version: '1.2.0' } };
    return { ok: true };
  });

  const windowObj: any = {
    cogseed: {
      invoke,
      onPushEvent(channel: string, handler: (payload: any) => unknown) {
        pushHandlers.set(channel, handler);
      },
    },
    addEventListener: () => {},
  };
  windowObj.window = windowObj;

  const context: any = {
    createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    t: tFor,
    window: windowObj,
    document: {
      readyState: 'complete',
      getElementById: (id: string) => registry.get(id) || null,
      querySelector: (selector: string) => (selector === '.settings-about-rows' ? rowsContainer : null),
      addEventListener: () => {},
    },
  };
  vm.createContext(context);
  // 真机由 ui-button.js 提供共享按钮工厂；这里加载同一份生产实现，而不是在测试里
  // 复刻一份可能与它漂移的假工厂。
  vm.runInContext(uiButtonSource, context, { filename: 'ui-button.js' });
  context.uiButton = windowObj.uiButton;
  vm.runInContext(updaterSource, context, { filename: 'updater.js' });

  const el = (id: string) => registry.get(id) as FakeElement;
  const push = (channel: string, payload: unknown) => pushHandlers.get(channel)?.(payload);
  return {
    el,
    invoke,
    push,
    rows: rowsContainer,
    /** 模块挂在 window 上的权威快照重拉入口（settings.js 切页时也走它）。 */
    refresh: () => windowObj._updaterRefreshSettings() as Promise<void>,
    server,
    finishDownload: (result: unknown) => resolveDownload?.(result),
  };
}

describe('settings about pane update progress', () => {
  it('follows the live download percentage in the status line (manual flow)', async () => {
    const h = buildHarness({ autoStatus: { state: 'disabled' } });
    await flush();

    await h.el('updater-download-btn').click();
    await flush();
    expect(h.el('updater-progress-row').hidden).toBe(false);
    expect(h.el('updater-status-text').textContent).toBe(tFor('settings.updates.downloading', { percent: '0' }));

    h.push('updates:progress', { received: 512, total: 1024, percent: 50 });
    await flush();
    // 进度条和文案必须同源：旧实现只在 100% 时写文案，50% 的进度条旁边一直
    // 挂着「正在下载 0%」。
    expect(h.el('updater-progress-bar').style.width).toBe('50%');
    // 主进程给出总长度之后，文案同时带上下载量——同一份数据，不另算一个百分比。
    expect(h.el('updater-status-text').textContent).toBe(tFor('settings.updates.downloading_bytes', {
      percent: '50',
      received: '512 B',
      total: '1.0 KB',
    }));
  });

  it('tells an insecure download URL apart from a malformed one', async () => {
    // 客户端在下载环节强制 https（features/updater/client.ts 的 insecure_url），
    // 自建或本地 http 服务会撞上它。文案复用时用户会去查一个其实没写错的地址。
    expect(tFor('settings.updates.errors.insecure_url'))
      .not.toBe(tFor('settings.updates.errors.bad_url'));
    const h = buildHarness({ autoStatus: { state: 'disabled' } });
    await flush();

    await h.el('updater-download-btn').click();
    await flush();
    h.finishDownload({ ok: false, error: 'insecure_url' });
    await flush();
    expect(h.el('updater-status-text').textContent).toBe(
      tFor('settings.updates.error', { message: tFor('settings.updates.errors.insecure_url') }),
    );

    // 真正解析不出来的地址仍走「地址无效」。
    await h.el('updater-download-btn').click();
    await flush();
    h.finishDownload({ ok: false, error: 'bad_url' });
    await flush();
    expect(h.el('updater-status-text').textContent).toBe(
      tFor('settings.updates.error', { message: tFor('settings.updates.errors.bad_url') }),
    );
  });

  it('never invents a percentage the platform cannot report (macOS auto-update)', async () => {
    // Squirrel.Mac 只有 update-available / update-downloaded，没有
    // download-progress：主进程此时的 downloading 状态不带 percent。
    const h = buildHarness({ autoStatus: { state: 'downloading' } });
    await flush();

    expect(h.el('updater-auto-row').hidden).toBe(false);
    expect(h.el('updater-auto-text').textContent).toBe(zh['settings.updates.auto.downloading_indeterminate']);
    expect(h.el('updater-auto-text').textContent).not.toContain('%');

    // 平台真的上报进度时才渲染百分数（Windows 的 download-progress 路径）。
    h.push('updates:auto', { state: 'downloading', percent: 42 });
    await flush();
    expect(h.el('updater-auto-text').textContent).toBe(tFor('settings.updates.auto.downloading', { percent: '42' }));
  });

  it('keeps exactly one progress surface when the auto updater takes over mid-download', async () => {
    const h = buildHarness({ autoStatus: { state: 'disabled' } });
    await flush();
    await h.el('updater-download-btn').click();
    await flush();
    h.push('updates:progress', { received: 512, total: 1024, percent: 50 });
    await flush();
    expect(h.el('updater-progress-row').hidden).toBe(false);
    expect(h.el('updater-status-row').hidden).toBe(false);

    // 自动更新通道接手（macOS 打包版的真实路径）：v1 的进度声明整体退场。
    h.push('updates:auto', { state: 'downloading' });
    await flush();
    expect(h.el('updater-progress-row').hidden).toBe(true);
    expect(h.el('updater-status-row').hidden).toBe(true);
    expect(h.el('updater-actions-row').hidden).toBe(true);
    expect(h.el('updater-auto-text').textContent).toBe(zh['settings.updates.auto.downloading_indeterminate']);

    // 迟到的 v1 进度推送也不能把第二个进度条拉回页面。
    h.push('updates:progress', { received: 900, total: 1024, percent: 88 });
    await flush();
    expect(h.el('updater-progress-row').hidden).toBe(true);
    expect(h.el('updater-status-row').hidden).toBe(true);

    // 下载收尾同样不抢自动更新行的位置。
    h.finishDownload({ ok: true, version: '1.2.0', size: 1024, path: '/tmp/x.dmg', sha256: 'a'.repeat(64) });
    await flush();
    expect(h.el('updater-progress-row').hidden).toBe(true);
    expect(h.el('updater-actions-row').hidden).toBe(true);
  });

  it('hands the pane back to the manual flow when auto-update fails or settles', async () => {
    const h = buildHarness({ autoStatus: { state: 'downloading' } });
    await flush();
    expect(h.el('updater-actions-row').hidden).toBe(true);

    // 自动更新失败不能把用户关在死路上：v1 手动下载仍是兜底通道。
    h.push('updates:auto', { state: 'error', message: 'feed unreachable' });
    await flush();
    expect(h.el('updater-actions-row').hidden).toBe(false);
    expect(h.el('updater-download-btn').hidden).toBe(false);
    expect(h.el('updater-auto-text').className).toContain('settings-updater-status-error');
  });

  it('shows the restart-to-install action only once the update is staged', async () => {
    const h = buildHarness({ autoStatus: { state: 'downloaded', version: '1.2.0' } });
    await flush();

    expect(h.el('updater-auto-install-btn').hidden).toBe(false);
    expect(h.el('updater-auto-text').textContent).toBe(tFor('settings.updates.auto.downloaded', { version: '1.2.0' }));
    expect(h.el('updater-actions-row').hidden).toBe(true);

    await h.el('updater-auto-install-btn').click();
    await flush();
    expect(h.invoke).toHaveBeenCalledWith('updates.autoInstall', {});
  });

  it('leaves the manual flow untouched in dev mode where auto-update is disabled', async () => {
    const h = buildHarness({ autoStatus: { state: 'disabled', reason: 'dev_mode' } });
    await flush();

    expect(h.el('updater-auto-row').hidden).toBe(true);
    expect(h.el('updater-actions-row').hidden).toBe(false);
    expect(h.el('updater-download-btn').hidden).toBe(false);
  });
});

// 2026-09-21 报障（三件）：
//   1. 下载时没有暂停入口；
//   2. 再点一次「下载更新」进度条就消失（此后进度推送全被丢弃）；
//   3. 没检查到新版本时，「下载更新 / 打开安装包」仍然出现。
describe('settings about pane update actions follow main', () => {
  it('offers neither download nor open when the check found no newer version', async () => {
    // 主进程说"没有值得提供的更新"（没有更新，或已装好，或用户已跳过）。
    const h = buildHarness({ autoStatus: { state: 'disabled' }, hasUpdate: false });
    await flush();

    expect(h.el('updater-actions-row').hidden).toBe(true);
    expect(h.el('updater-download-btn').hidden).toBe(true);
    expect(h.el('updater-open-btn').hidden).toBe(true);
    // 四行全隐时整块更新行容器也要收起，否则卡片里留一条空带 + 分隔线。
    expect(h.rows.hidden).toBe(true);
  });

  it('drops the stale offer when a manual check reports up to date', async () => {
    // 旧实现：检查完"已是最新"只改文案，不清 info、不重渲染按钮 —— 于是
    // 「已是最新版本（1.1.2）」下面还挂着「下载更新 / 打开安装包」。
    const h = buildHarness({
      autoStatus: { state: 'disabled' },
      check: { ok: true, checked: true, has_update: false, current_version: '1.2.0' },
    });
    await flush();
    expect(h.el('updater-download-btn').hidden).toBe(false);

    await h.el('updater-check-btn').click();
    await flush();

    expect(h.el('updater-status-text').textContent).toBe(tFor('settings.updates.up_to_date', { version: '1.2.0' }));
    expect(h.el('updater-download-btn').hidden).toBe(true);
    expect(h.el('updater-open-btn').hidden).toBe(true);
    expect(h.el('updater-actions-row').hidden).toBe(true);
  });

  it('explains and self-corrects when a stale download button is clicked', async () => {
    // 界面还以为有更新、主进程其实已经没有了（例如另一个窗口刚跳过这个版本）。
    // 这种点击绝不能是"什么都不发生"：要么给出说明，要么让界面自己纠正。
    const h = buildHarness({ autoStatus: { state: 'disabled' } });
    await flush();
    expect(h.el('updater-download-btn').hidden).toBe(false);

    h.server.has_update = false;
    h.server.latest_info = null;
    await h.el('updater-download-btn').click();
    await flush();
    h.finishDownload({ ok: false, error: 'no_update_info' });
    await flush();

    expect(h.el('updater-status-text').textContent).toBe(
      tFor('settings.updates.error', { message: tFor('settings.updates.errors.no_update_info') }),
    );
    // 主进程说没有更新信息 → 按钮退场、进度面不留残影。
    expect(h.el('updater-download-btn').hidden).toBe(true);
    expect(h.el('updater-progress-row').hidden).toBe(true);
  });

  it('collapses the rows container when a refresh clears the last visible row', async () => {
    // 顺序陷阱：_applyState 先渲染、后清空旧状态文案。若收起判定只在那次渲染里
    // 做过一次，四行都隐藏之后容器仍留在页面上——卡片里就是一条空带（padding +
    // 上边框），真机上表现为"更新组下面多出一条空白"。
    const h = buildHarness({ autoStatus: { state: 'disabled' } });
    await flush();
    expect(h.rows.hidden).toBe(false);
    expect(h.el('updater-status-row').hidden).toBe(false);

    h.server.has_update = false;
    h.server.latest_info = null;
    await h.refresh();

    expect(h.el('updater-status-row').hidden).toBe(true);
    expect(h.el('updater-actions-row').hidden).toBe(true);
    expect(h.rows.hidden).toBe(true);
  });

  it('keeps the progress surface when a second download request is rejected', async () => {
    const h = buildHarness({ autoStatus: { state: 'disabled' } });
    await flush();

    await h.el('updater-download-btn').click();
    // 主进程进入下载态（权威状态 + 它报告的总长度）。
    h.server.download = { phase: 'downloading', received: 512, total: 1024, percent: 50 };
    h.push('updates:download', h.server.download);
    h.push('updates:progress', { received: 512, total: 1024, percent: 50 });
    await flush();
    expect(h.el('updater-progress-bar').style.width).toBe('50%');

    // 第二次请求被主进程按 already_downloading 挡下：这不是失败，主进程还在下载。
    h.finishDownload({ ok: false, error: 'already_downloading' });
    await flush();

    expect(h.el('updater-progress-row').hidden).toBe(false);
    expect(h.el('updater-progress-bar').style.width).toBe('50%');
    // 旧实现把本地 downloading 置成 false，此后的进度推送全被 return 掉：
    // 进度条永久停在原地，而下载其实还在跑。
    h.push('updates:progress', { received: 900, total: 1024, percent: 88 });
    await flush();
    expect(h.el('updater-progress-bar').style.width).toBe('88%');
    expect(h.el('updater-status-text').textContent).toBe(tFor('settings.updates.downloading_bytes', {
      percent: '88',
      received: '900 B',
      total: '1.0 KB',
    }));
  });

  it('exposes pause while downloading and keeps the bar when paused', async () => {
    const h = buildHarness({
      autoStatus: { state: 'disabled' },
      download: { phase: 'downloading', received: 512, total: 1024, percent: 50 },
    });
    await flush();

    // 传输进行中：动作行退场，控制权交给进度行，进度面保留。
    expect(h.el('updater-progress-row').hidden).toBe(false);
    expect(h.el('updater-progress-bar').style.width).toBe('50%');
    expect(h.el('updater-actions-row').hidden).toBe(true);
    expect(h.el('updater-progress-actions').innerHTML).toContain('updater-pause-btn');
    expect(h.el('updater-progress-actions').innerHTML).toContain(tFor('settings.updates.pause'));
    expect(h.el('updater-pause-btn')).toBeDefined();

    await h.el('updater-pause-btn').click();
    await flush();
    expect(h.invoke).toHaveBeenCalledWith('updates.pauseDownload', {});

    // 主进程进入暂停态：进度条留着（冻结），按钮换成「继续下载」。
    h.server.download = { phase: 'paused', received: 512, total: 1024, percent: 50 };
    h.push('updates:download', h.server.download);
    await flush();

    expect(h.el('updater-progress-row').hidden).toBe(false);
    expect(h.el('updater-progress-bar').style.width).toBe('50%');
    expect(h.el('updater-progress-bar').className).toContain('is-paused');
    expect(h.el('updater-status-text').textContent).toBe(tFor('settings.updates.paused', {
      percent: '50',
      received: '512 B',
      total: '1.0 KB',
    }));
    expect(h.el('updater-progress-actions').innerHTML).toContain('updater-resume-btn');
    expect(h.el('updater-progress-actions').innerHTML).toContain('updater-cancel-btn');
    expect(h.el('updater-progress-actions').innerHTML).not.toContain('updater-pause-btn');
  });

  it('resumes from the paused bytes instead of restarting the download', async () => {
    const h = buildHarness({
      autoStatus: { state: 'disabled' },
      download: { phase: 'paused', received: 512, total: 1024, percent: 50 },
    });
    await flush();

    await h.el('updater-resume-btn').click();
    await flush();
    expect(h.invoke).toHaveBeenCalledWith('updates.resumeDownload', {});
    // 继续期间进度面不能消失（同一个下载只允许一个进度面）。
    expect(h.el('updater-progress-row').hidden).toBe(false);
    h.push('updates:progress', { received: 768, total: 1024, percent: 75 });
    await flush();
    expect(h.el('updater-progress-bar').style.width).toBe('75%');
  });

  it('offers continue instead of a fresh download after an interrupted transfer', async () => {
    const h = buildHarness({
      autoStatus: { state: 'disabled' },
      download: {
        phase: 'failed', received: 512, total: 1024, percent: 50, resumable: true, error: 'socket hang up',
      },
    });
    await flush();

    // 半包还在：给「继续下载」，而不是让用户重下整个包。
    expect(h.el('updater-progress-row').hidden).toBe(false);
    expect(h.el('updater-status-text').textContent).toBe(
      tFor('settings.updates.interrupted', { received: '512 B' }),
    );
    expect(h.el('updater-progress-actions').innerHTML).toContain('updater-resume-btn');
  });

  it('falls back to retry copy when a failed transfer has nothing to resume', async () => {
    const h = buildHarness({
      autoStatus: { state: 'disabled' },
      download: { phase: 'failed', received: 0, total: 0, percent: 0, resumable: false, error: 'verify_failed' },
    });
    await flush();

    expect(h.el('updater-progress-row').hidden).toBe(true);
    expect(h.el('updater-download-btn').hidden).toBe(false);
    // 没有半包可续时，「下载更新」的语义就是重试。
    expect(h.el('updater-download-btn::label').textContent).toBe(tFor('settings.updates.retry'));
    expect(h.el('updater-status-text').textContent).toBe(
      tFor('settings.updates.error', { message: tFor('settings.updates.errors.verify_failed') }),
    );
  });
});
