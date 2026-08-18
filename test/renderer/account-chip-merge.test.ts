// account-chip.js（左下角融合入口）的交互行为测试：
// hover 延迟展开 / 无缝衔接不闪断 / 钉住语义 / 设置项路由 / 降级形态。
// 与 renderer 一样是经典脚本，用 node:vm + 轻量 DOM fake 执行真实源码。
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

const OPEN_MS = 150;
const CLOSE_MS = 220;
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeClassList {
  private classes = new Set<string>();
  constructor(initial: string[] = []) { initial.forEach((c) => this.classes.add(c)); }
  add(name: string) { this.classes.add(name); }
  remove(name: string) { this.classes.delete(name); }
  contains(name: string) { return this.classes.has(name); }
  toggle(name: string, force?: boolean) {
    const enabled = force === undefined ? !this.classes.has(name) : force;
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
    return enabled;
  }
}

class FakeElement {
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  hidden = false;
  attrs: Record<string, string> = {};
  protected listeners = new Map<string, Array<(event?: any) => void>>();
  protected _html = '';

  set innerHTML(html: string) { this._html = html; }
  get innerHTML() { return this._html; }

  addEventListener(type: string, handler: (event?: any) => void) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: Record<string, any> = {}) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) handler({ ...event, type });
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  querySelector(_sel: string) { return null; }
  querySelectorAll(_sel: string) { return []; }
  click() { this.dispatch('click', { currentTarget: this, target: this }); }
  contains(node: unknown) { return node === this; }
  focus() {}
}

/** 菜单元素：从 innerHTML 里解析 data-chip-action 按钮，供绑定与点击。 */
class FakeMenuElement extends FakeElement {
  private actions = new Map<string, FakeElement>();

  override set innerHTML(html: string) {
    this._html = html;
    this.actions.clear();
    const re = /data-chip-action="([\w-]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const el = new FakeElement();
      el.dataset.chipAction = m[1];
      this.actions.set(m[1], el);
    }
  }
  override get innerHTML() { return this._html; }

  override querySelectorAll(sel: string) {
    if (sel === '[data-chip-action]') return [...this.actions.values()];
    return [];
  }
  override querySelector(sel: string) {
    const m = sel.match(/^\[data-chip-action="([\w-]+)"\]$/);
    return m ? (this.actions.get(m[1]) || null) : null;
  }
}

/** 入口容器：innerHTML 重建时同步重建 chip / menu 子元素。 */
class FakeRootElement extends FakeElement {
  chip: FakeElement | null = null;
  menu: FakeMenuElement | null = null;

  override set innerHTML(html: string) {
    this._html = html;
    if (html.includes('id="hub-account-chip"')) this.chip = new FakeElement();
    if (html.includes('id="hub-account-chip-menu"')) {
      this.menu = new FakeMenuElement();
      // 真实 DOM 里 hidden 属性使菜单初始不可见。
      this.menu.hidden = /id="hub-account-chip-menu"[^>]*\bhidden\b/.test(html);
    }
  }
  override get innerHTML() { return this._html; }

  override querySelector(sel: string) {
    if (sel === '#hub-account-chip') return this.chip;
    if (sel === '#hub-account-chip-menu') return this.menu;
    return null;
  }
}

function loadAccountChip(statusFixture: Record<string, unknown> | null, invokeImpl?: Function) {
  const elements = new Map<string, FakeElement>();
  const rootEl = new FakeRootElement();
  rootEl.hidden = true; // index.html 初始 hidden
  elements.set('hub-account-chip-root', rootEl);
  elements.set('panel-settings', new FakeElement(['panel', 'active']));
  elements.set('conversation-list', new FakeElement());

  const documentListeners = new Map<string, Array<(event?: any) => void>>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id)!;
    },
    addEventListener(type: string, handler: (event?: any) => void) {
      const list = documentListeners.get(type) || [];
      list.push(handler);
      documentListeners.set(type, list);
    },
    dispatch(type: string, event: Record<string, any> = {}) {
      const handlers = documentListeners.get(type) || [];
      for (const handler of handlers) handler({ ...event, type });
    },
    querySelectorAll() { return []; },
  };

  const setView = vi.fn();
  const activateSettingsTab = vi.fn();
  const invoke = vi.fn(
    invokeImpl ||
      (async (channel: string) => {
        if (channel === 'hub-account.status') return { ok: true, status: statusFixture };
        if (channel === 'hub-account.me') {
          return { ok: true, me: { account: { community_profile: { display_name: 'Niu' } } } };
        }
        return { ok: true };
      }),
  );

  const windowObj: any = {
    addEventListener: () => undefined,
    cogseed: { invoke, onPushEvent: () => undefined },
    setView,
    activateSettingsTab,
    confirm: () => true,
    alert: () => undefined,
  };
  windowObj.window = windowObj;

  const context: any = {
    window: windowObj,
    document,
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, length: 0, key: () => null },
    performance: { now: () => 0 },
    requestAnimationFrame: (handler: () => void) => { handler(); return 1; },
    setTimeout,
    clearTimeout,
    createLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
    t: (key: string) => key,
  };

  vm.createContext(context);
  const source = fs.readFileSync(path.join(root, 'src/renderer/modules/account-chip.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'account-chip.js' });

  return { context, document, elements, rootEl, setView, activateSettingsTab, invoke };
}

const SIGNED_IN = {
  signed_in: true,
  account_id: 'cogseed_acc_abc123456789',
  bound: true,
  hub_reachable: true,
};

describe('account-chip merged footer entry', () => {
  it('opens the merged panel on hover after the delay and closes it on leave', async () => {
    const { rootEl } = loadAccountChip(SIGNED_IN);
    await settle(50); // 启动 status 刷新完成

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    expect(rootEl.menu!.hidden).toBe(false);
    expect(rootEl.menu!.innerHTML).toContain('hub.chip.menu.settings');
    expect(rootEl.menu!.innerHTML).toContain('hub.account.sign_out');
    expect(rootEl.chip!.getAttribute('aria-expanded')).toBe('true');

    rootEl.dispatch('mouseleave');
    await settle(CLOSE_MS + 60);
    expect(rootEl.menu!.hidden).toBe(true);
    expect(rootEl.chip!.getAttribute('aria-expanded')).toBe('false');
  });

  it('pins on click so the panel survives hover-out; a second click unpins and closes', async () => {
    const { rootEl } = loadAccountChip(SIGNED_IN);
    await settle(50);

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    rootEl.chip!.click();
    expect(rootEl.classList.contains('is-pinned')).toBe(true);

    rootEl.dispatch('mouseleave');
    await settle(CLOSE_MS + 60);
    expect(rootEl.menu!.hidden).toBe(false); // 钉住：离开仍展开

    rootEl.chip!.click();
    expect(rootEl.classList.contains('is-pinned')).toBe(false);
    await settle(CLOSE_MS + 60);
    expect(rootEl.menu!.hidden).toBe(true);
  });

  it('routes the merged settings item to window.setView("settings")', async () => {
    const { rootEl, setView, activateSettingsTab } = loadAccountChip(SIGNED_IN);
    await settle(50);

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    const item = rootEl.menu!.querySelector('[data-chip-action="settings"]')!;
    item.click();

    expect(setView).toHaveBeenCalledWith('settings');
    expect(activateSettingsTab).not.toHaveBeenCalled();
    expect(rootEl.menu!.hidden).toBe(true);
  });

  it('syncs the settings active highlight without rebuilding the panel', async () => {
    const { context, rootEl } = loadAccountChip(SIGNED_IN);
    await settle(50);

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    context.window.setChipSettingsActive(true);
    const item = rootEl.menu!.querySelector('[data-chip-action="settings"]')!;
    expect(item.classList.contains('is-active')).toBe(true);

    context.window.setChipSettingsActive(false);
    expect(item.classList.contains('is-active')).toBe(false);
  });

  it('renders the degraded settings-only entry when the hub is unreachable while signed out', async () => {
    const { rootEl } = loadAccountChip({ signed_in: false, account_id: '', bound: false, hub_reachable: false });
    await settle(50);

    expect(rootEl.hidden).toBe(false);
    expect(rootEl.innerHTML).toContain('hub.chip.degraded_name');
    expect(rootEl.innerHTML).not.toContain('hub.chip.sign_in');

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    expect(rootEl.menu!.hidden).toBe(false);
    expect(rootEl.menu!.innerHTML).toContain('hub.chip.menu.hub_unavailable');
    expect(rootEl.menu!.innerHTML).toContain('hub.chip.menu.settings');
    expect(rootEl.menu!.innerHTML).not.toContain('hub.account.sign_out');
  });

  it('keeps the settings entry alive when status is unavailable (invoke fails)', async () => {
    const { rootEl, invoke } = loadAccountChip(null, async (channel: string) => {
      if (channel === 'hub-account.status') return { ok: false, error: 'down' };
      return { ok: true };
    });
    await settle(50);

    expect(invoke).toHaveBeenCalledWith('hub-account.status', {});
    expect(rootEl.hidden).toBe(false);
    expect(rootEl.innerHTML).toContain('hub.chip.degraded_name');

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    expect(rootEl.menu!.innerHTML).toContain('hub.chip.menu.settings');
  });

  it('closes and unpins on an outside click', async () => {
    const { rootEl, document } = loadAccountChip(SIGNED_IN);
    await settle(50);

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    rootEl.chip!.click(); // 钉住
    expect(rootEl.classList.contains('is-pinned')).toBe(true);

    document.dispatch('click', { target: new FakeElement() });
    expect(rootEl.classList.contains('is-pinned')).toBe(false);
    expect(rootEl.menu!.hidden).toBe(true);
  });

  it('opens the panel on hover when signed out; click pins instead of logging in', async () => {
    const { rootEl, invoke } = loadAccountChip({ signed_in: false, account_id: '', bound: false, hub_reachable: true });
    await settle(50);

    // 未登录态 hover 同样展开，面板含设置项与登录头卡。
    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    expect(rootEl.menu!.hidden).toBe(false);
    expect(rootEl.menu!.innerHTML).toContain('hub.chip.menu.settings');
    expect(rootEl.menu!.innerHTML).toContain('hub.chip.sign_in');

    // 单击状态栏 = 钉住，不再直接触发登录。
    rootEl.chip!.click();
    expect(rootEl.classList.contains('is-pinned')).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('hub-account.start_login', {});

    // 登录动作在面板头卡内。
    const head = rootEl.menu!.querySelector('[data-chip-action="sign-in"]')!;
    head.click();
    expect(invoke).toHaveBeenCalledWith('hub-account.start_login', {});
  });

  it('does not open the panel while signing in', async () => {
    const { rootEl } = loadAccountChip({ signed_in: false, account_id: '', bound: false, hub_reachable: true });
    await settle(50);

    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    const head = rootEl.menu!.querySelector('[data-chip-action="sign-in"]')!;
    head.click(); // 进入 signing-in，面板被重建隐藏
    await settle(20);
    expect(rootEl.menu!.hidden).toBe(true);

    rootEl.dispatch('mouseleave');
    rootEl.dispatch('mouseenter');
    await settle(OPEN_MS + 60);
    expect(rootEl.menu!.hidden).toBe(true); // 登录中 hover 不展开
  });
});
