import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../..');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
  toggle(name: string, force?: boolean) {
    const next = force === undefined ? !this.values.has(name) : force;
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  id = '';
  readonly tagName: string;
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  className = '';
  hidden = false;
  value = '';
  textContent = '';
  disabled = false;
  type = '';
  placeholder = '';
  title = '';
  onclick: null | ((event?: unknown) => unknown) = null;
  parentElement: FakeElement | null = null;
  draggable = false;
  style: Record<string, string> = {};
  private html = '';
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();
  private readonly registry: Map<string, FakeElement>;

  constructor(registry: Map<string, FakeElement>, id = '', tagName = 'div') {
    this.registry = registry;
    this.tagName = tagName.toUpperCase();
    if (id) this.setId(id);
  }

  private setId(id: string) {
    this.id = id;
    this.registry.set(id, this);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    child.parentElement = this;
    if (child.id) this.registry.set(child.id, child);
    return child;
  }

  prepend(child: FakeElement) {
    this.children.unshift(child);
    child.parentElement = this;
    if (child.id) this.registry.set(child.id, child);
    return child;
  }

  remove() {
    for (const candidate of this.registry.values()) {
      const index = candidate.children.indexOf(this);
      if (index >= 0) candidate.children.splice(index, 1);
    }
    this.parentElement = null;
    if (this.id) this.registry.delete(this.id);
  }

  setAttribute(name: string, value: string) {
    if (name === 'id') this.setId(value);
    else (this as any)[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }

  removeAttribute(name: string) {
    delete (this as any)[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
  }

  getAttribute(name: string) {
    return (this as any)[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] ?? null;
  }

  focus() {}

  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    const next = this.listeners.get(type) || [];
    next.push(handler);
    this.listeners.set(type, next);
  }

  async click() {
    if (this.disabled) return;
    if (this.onclick) await this.onclick({ currentTarget: this, target: this });
    for (const handler of this.listeners.get('click') || []) {
      await handler({ currentTarget: this, target: this });
    }
    // 最小化的 DOM label 激活模型：点击结束后，如果点击目标在 <label> 内且不是该
    // label 的可标记控件（及其后代），浏览器会把这次点击转发给那个控件一次。这样
    // “标题文字点击”既能暴露目标自身多绑的 handler，也不会漏掉转发本身。
    const label = this.closest('label');
    if (!label) return;
    const control = label.querySelector('button') || label.querySelector('input');
    if (!control || control === this) return;
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (node === control) return;
    }
    await control.click();
  }

  async dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.listeners.get(type) || []) {
      await handler({ currentTarget: this, target: this, ...event });
    }
  }

  listenerCount(type: string) {
    return (this.listeners.get(type) || []).length;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string) {
    const out: FakeElement[] = [];
    const byName = selector.match(/^([a-z0-9-]+)\[name="([^"]+)"\]$/);
    const visit = (el: FakeElement) => {
      if (selector.startsWith('#') && el.id === selector.slice(1)) out.push(el);
      if (selector.startsWith('.') && el.className.split(/\s+/).includes(selector.slice(1))) out.push(el);
      if (byName && el.tagName.toLowerCase() === byName[1] && el.getAttribute('name') === byName[2]) out.push(el);
      if (!selector.startsWith('#') && !selector.startsWith('.') && !selector.startsWith('[')
        && el.tagName.toLowerCase() === selector.toLowerCase()) out.push(el);
      for (const child of el.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return out;
  }

  set innerHTML(value: string) {
    this.html = value;
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.textContent = '';
    const stack: Array<FakeElement | null> = [this];
    const currentParent = (): FakeElement => {
      for (let i = stack.length - 1; i >= 0; i--) {
        const frame = stack[i];
        if (frame) return frame;
      }
      return this;
    };
    const token = /<\/?([a-z0-9-]+)\b([^>]*)>|([^<]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = token.exec(value))) {
      const raw = match[0];
      const text = match[3];
      if (text !== undefined) {
        const node = currentParent();
        const trimmed = text.trim();
        if (trimmed) node.textContent += trimmed;
        continue;
      }
      if (raw.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs = match[2] || '';
      const id = attrs.match(/\bid="([^"]+)"/)?.[1] || '';
      const className = attrs.match(/\bclass="([^"]+)"/)?.[1] || '';
      const nameAttr = attrs.match(/\bname="([^"]+)"/)?.[1] || '';
      const child = new FakeElement(this.registry, id, match[1]);
      const hasIdentity = Boolean(id || className || nameAttr);
      child.className = className;
      child.type = attrs.match(/\btype="([^"]+)"/)?.[1] || '';
      child.value = attrs.match(/\bvalue="([^"]*)"/)?.[1] || '';
      child.placeholder = attrs.match(/\bplaceholder="([^"]*)"/)?.[1] || '';
      child.title = attrs.match(/\btitle="([^"]*)"/)?.[1] || '';
      child.disabled = /\bdisabled(?:\s|>|$)/i.test(attrs);
      const ariaLabel = attrs.match(/\baria-label="([^"]*)"/)?.[1];
      if (ariaLabel) child.setAttribute('aria-label', ariaLabel);
      if (/(?:^|\s)checked(?:\s|$)/.test(attrs)) (child as any).checked = true;
      if (/(?:^|\s)disabled(?:\s|$)/.test(attrs)) child.disabled = true;
      if (match[1].toLowerCase() === 'textarea') {
        const close = value.indexOf('</textarea>', token.lastIndex);
        if (close >= 0) {
          child.value = value.slice(token.lastIndex, close)
            .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        }
      }
      for (const attrMatch of attrs.matchAll(/([a-z0-9-]+)="([^"]*)"/gi)) {
        const key = attrMatch[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
        if ((child as any)[key] === undefined || (child as any)[key] === '') {
          if (key !== 'class') (child as any)[key] = attrMatch[2];
        }
      }
      for (const dataMatch of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/gi)) {
        child.dataset[dataMatch[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = dataMatch[2];
      }
      const selfClosing = /\/>$/.test(raw);
      if (hasIdentity) child && currentParent().appendChild(child);
      if (!selfClosing) stack.push(hasIdentity ? child : null);
    }
  }

  get innerHTML() {
    return this.html;
  }

  getBoundingClientRect() {
    return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
  }

  closest(selector: string) {
    const matches = (el: FakeElement): boolean => {
      if (selector.startsWith('.')) return el.className.split(/\s+/).includes(selector.slice(1));
      if (selector.startsWith('#')) return el.id === selector.slice(1);
      return el.tagName.toLowerCase() === selector.toLowerCase();
    };
    let node: FakeElement | null = this;
    while (node) {
      if (matches(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  get isConnected() {
    return this.parentElement !== null;
  }
}

interface HarnessOptions {
  /** Stored preference value served by prefs.getCloseToTray. */
  closeToTray?: boolean;
  /** prefs.getCloseToTray rejects (transport failure). */
  readFails?: boolean;
  /** prefs.getCloseToTray resolves with { ok: false }. */
  readRejects?: boolean;
  /** prefs.setCloseToTray resolves with { ok: false, error } (handler throw). */
  failWrite?: boolean;
  /** prefs.setCloseToTray rejects (transport failure). */
  rejectWrite?: boolean;
}

function buildHarness(options: HarnessOptions = {}) {
  const registry = new Map<string, FakeElement>();
  const ids = [
    'settings-close-to-tray-toggle',
    'settings-metacognition-toggle',
    'settings-metacognition-status',
    'settings-custom-provider-list',
    'settings-custom-provider-add-btn',
    'settings-custom-providers-status',
    'settings-ccswitch-status',
    'settings-ccswitch-preview-btn',
    'settings-custom-provider-modal',
    'settings-custom-provider-modal-title',
    'settings-custom-provider-modal-body',
    'settings-custom-provider-modal-actions',
    'settings-custom-provider-modal-status',
    'settings-custom-provider-modal-head-actions',
    'settings-custom-provider-name',
    'settings-custom-provider-protocol',
    'settings-custom-provider-base-url',
    'settings-custom-provider-api-key',
    'settings-custom-provider-models',
    'settings-custom-provider-model-list',
    'settings-custom-provider-add-model',
    'settings-custom-provider-detail-model-list',
    'settings-picker-provider',
    'settings-picker-model',
    'settings-add-entry-btn',
    'settings-picker-status',
    'settings-custom-model-fields',
    'settings-entries',
    'settings-ccswitch-preview-modal',
    'settings-ccswitch-preview-modal-title',
    'settings-ccswitch-preview-modal-body',
    'settings-ccswitch-preview-modal-actions',
    'settings-ccswitch-preview-modal-status',
    'settings-ccswitch-preview-sync-btn',
  ];
  for (const id of ids) registry.set(id, new FakeElement(registry, id));

  let closeToTrayEnabled = options.closeToTray !== false;
  let language = 'en';

  const invoke = vi.fn(async (channel: string, payload?: any) => {
    if (channel === 'prefs.getCloseToTray') {
      if (options.readFails) throw new Error('ipc read failed');
      if (options.readRejects) return { ok: false, error: 'read_failed' };
      return { ok: true, enabled: closeToTrayEnabled };
    }
    if (channel === 'prefs.setCloseToTray') {
      if (options.rejectWrite) throw new Error('ipc transport failed');
      if (options.failWrite) return { ok: false, error: 'write_failed' };
      closeToTrayEnabled = !!payload?.enabled;
      return { ok: true, enabled: closeToTrayEnabled };
    }
    if (channel === 'prefs.getMetacognition') return { ok: true, enabled: true, envForcedOff: false };
    if (channel === 'customProviders.list') return { ok: true, providers: [] };
    return { ok: true };
  });

  const warn = vi.fn();
  const windowListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const windowObj: any = {
    cogseed: { invoke },
    uiIconHtml: (name: string) => `<i data-icon="${name}"></i>`,
    addEventListener(type: string, handler: (...args: any[]) => unknown) {
      const list = windowListeners.get(type) || [];
      list.push(handler);
      windowListeners.set(type, list);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of windowListeners.get(event.type) || []) handler(event);
    },
  };
  windowObj.window = windowObj;

  const documentListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const documentObj: any = {
    getElementById(id: string) { return registry.get(id) || null; },
    createElement: (tagName: string) => new FakeElement(registry, '', tagName),
    querySelectorAll: () => [],
    addEventListener(type: string, handler: (...args: any[]) => unknown) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
    removeEventListener(type: string, handler: (...args: any[]) => unknown) {
      const handlers = documentListeners.get(type) || [];
      documentListeners.set(type, handlers.filter((candidate) => candidate !== handler));
    },
  };

  const aiSelectMount = vi.fn((element: FakeElement | null, config: Record<string, unknown> = {}) => {
    let value = typeof config.value === 'string' ? config.value : '';
    let options: Array<{ value: string; label?: string }> = [];
    let changeHandler: (next: string) => unknown = () => undefined;
    return {
      state: { get options() { return options; } },
      setOptions(nextOptions: Array<{ value: string; label?: string }>, next: { value?: string } = {}) {
        options = nextOptions || [];
        if (typeof next.value === 'string') value = next.value;
        if (value && !options.some((option) => option.value === value)) value = '';
        if (element) element.dataset.value = value;
      },
      getValue: () => value,
      setValue(next: string) { value = next || ''; if (element) element.dataset.value = value; },
      onChange(handler: (next: string) => unknown) { changeHandler = handler; },
      emitChange(next: string) { value = next; if (element) element.dataset.value = value; return changeHandler(next); },
    };
  });

  const t = vi.fn((key: string, vars?: Record<string, string>) => {
    const value = `${language}:${key}`;
    return vars ? `${value} ${JSON.stringify(vars)}` : value;
  });

  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn, error: vi.fn() }),
    t,
    escapeHtml: (value: unknown) => String(value ?? ''),
    document: documentObj,
    window: windowObj,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    uiConfirm: vi.fn(async () => true),
    uiAlert: vi.fn(async () => undefined),
    _aiSelectMount: aiSelectMount,
  };
  windowObj.uiField = (options: any) => {
    const control = options?.control || {};
    const placeholder = control.placeholder == null ? '' : ` placeholder="${String(control.placeholder)}"`;
    return '<div class="ui-field"><span class="ui-field__label">' + String(options?.label || '') + '</span>'
      + `<input id="${String(options?.id || '')}" class="form-input ui-input" value="${control.value == null ? '' : String(control.value)}"${placeholder} />`
      + '</div>';
  };
  windowObj.showContextMenu = vi.fn();
  windowObj.uiButton = (options: any) => `<button type="button" class="btn ui-button ${String(options?.className || '')}" data-label="${String(options?.label || '')}"><span class="ui-button__label">${String(options?.label || '')}</span></button>`;
  windowObj.uiIconButton = (options: any) => `<button type="button" class="ui-icon-button" data-label="${String(options?.label || '')}"></button>`;
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/ui-button.js'), 'utf8'), context, { filename: 'ui-button.js' });
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/ui-form.js'), 'utf8'), context, { filename: 'ui-form.js' });
  context.uiButton = windowObj.uiButton;
  context.uiIconButton = windowObj.uiIconButton;
  context.uiInput = windowObj.uiInput;
  context.uiCheckbox = windowObj.uiCheckbox;
  context.uiSwitch = windowObj.uiSwitch;
  context.uiTextarea = windowObj.uiTextarea;
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8'), context, { filename: 'settings.js' });
  return {
    context,
    registry,
    invoke,
    warn,
    windowObj,
    setLang: (next: string) => { language = next; },
    storedPreference: () => closeToTrayEnabled,
  };
}

type Harness = ReturnType<typeof buildHarness>;

async function mountSwitch(harness: Harness) {
  await harness.context._settingsRefreshCloseToTray();
  harness.context._settingsRenderCloseToTray();
  return harness.registry.get('settings-close-to-tray-switch')!;
}

function setWriteCalls(harness: Harness) {
  return harness.invoke.mock.calls.filter(([channel]) => channel === 'prefs.setCloseToTray');
}

describe('settings › close to tray switch', () => {
  it('reflects the stored preference on render', async () => {
    const off = buildHarness({ closeToTray: false });
    const toggle = await mountSwitch(off);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.className).not.toContain('is-on');

    const on = buildHarness({ closeToTray: true });
    const enabled = await mountSwitch(on);
    expect(enabled.getAttribute('aria-checked')).toBe('true');
    expect(enabled.className).toContain('is-on');
  });

  it('defaults to on when the read fails', async () => {
    const rejected = buildHarness({ readFails: true });
    await mountSwitch(rejected);
    expect(rejected.registry.get('settings-close-to-tray-switch')!.getAttribute('aria-checked')).toBe('true');

    const notOk = buildHarness({ readRejects: true });
    await mountSwitch(notOk);
    expect(notOk.registry.get('settings-close-to-tray-switch')!.getAttribute('aria-checked')).toBe('true');
  });

  it('writes the new value through IPC when clicked', async () => {
    const on = buildHarness({ closeToTray: true });
    const toggle = await mountSwitch(on);
    await toggle.click();
    expect(on.invoke).toHaveBeenCalledWith('prefs.setCloseToTray', { enabled: false });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(on.storedPreference()).toBe(false);

    const off = buildHarness({ closeToTray: false });
    const offToggle = await mountSwitch(off);
    await offToggle.click();
    expect(off.invoke).toHaveBeenCalledWith('prefs.setCloseToTray', { enabled: true });
    expect(offToggle.getAttribute('aria-checked')).toBe('true');
    expect(off.storedPreference()).toBe(true);
  });

  it('rolls the switch back when the write is rejected', async () => {
    const harness = buildHarness({ closeToTray: true, failWrite: true });
    const toggle = await mountSwitch(harness);
    await toggle.click();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.className).toContain('is-on');
    expect(harness.storedPreference()).toBe(true);
    expect(harness.warn).toHaveBeenCalledWith('setCloseToTray rejected', expect.objectContaining({ ok: false }));
  });

  it('rolls the switch back when the transport rejects', async () => {
    const harness = buildHarness({ closeToTray: false, rejectWrite: true });
    const toggle = await mountSwitch(harness);
    await toggle.click();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.className).not.toContain('is-on');
    expect(harness.warn).toHaveBeenCalledWith('setCloseToTray failed', expect.any(Error));
  });

  it('starts a single write when clicked twice while a failing write is in flight', async () => {
    // 探针：存储值 ON，两次连击都在途且两次写入都失败。没有在途守卫时，第二次
    // 点击会把第一次的乐观值当 previous，回滚后开关停在 false，而存储值仍是 true。
    const harness = buildHarness({ closeToTray: true, failWrite: true });
    const toggle = await mountSwitch(harness);
    const first = toggle.click();
    const second = toggle.click();
    await Promise.all([first, second]);
    expect(setWriteCalls(harness)).toHaveLength(1);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.className).toContain('is-on');
    expect(harness.storedPreference()).toBe(true);
    // 写入结束后开关必须恢复可用，否则用户再也切不动它。
    expect(toggle.disabled).toBe(false);
  });

  it('toggles exactly once when the caption inside the toggle label is clicked', async () => {
    // index.html 用 <label class="settings-toggle"> 包住开关（与相邻两个开关一致，
    // 才能吃到 .settings-row > label.settings-toggle 的 flex/cursor 规则）。label 是
    // 可标记元素的容器，点标题文字会激活里面的 <button>；这里验证它只激活一次。
    const html = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
    expect(html).toMatch(/<div class="settings-row">\s*<label class="settings-toggle">\s*<span id="settings-close-to-tray-toggle"><\/span>/);

    const harness = buildHarness({ closeToTray: true });
    const wrapper = new FakeElement(harness.registry, '', 'label');
    wrapper.className = 'settings-toggle';
    const host = harness.registry.get('settings-close-to-tray-toggle')!;
    wrapper.appendChild(host);
    const caption = new FakeElement(harness.registry, '', 'span');
    caption.textContent = 'en:settings.close_to_tray.toggle';
    wrapper.appendChild(caption);

    const toggle = await mountSwitch(harness);
    await caption.click();

    expect(setWriteCalls(harness)).toHaveLength(1);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(harness.storedPreference()).toBe(false);
  });

  it('re-renders the JS-derived accessible name on i18n-change without remounting', async () => {
    const harness = buildHarness({ closeToTray: true });
    const toggle = await mountSwitch(harness);
    expect(toggle.getAttribute('aria-label')).toBe('en:settings.close_to_tray.toggle');

    harness.setLang('zh');
    harness.windowObj.dispatchEvent({ type: 'i18n-change' });
    await settle();

    expect(toggle.getAttribute('aria-label')).toBe('zh:settings.close_to_tray.toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    // 重渲染不能重复挂载或重复绑定（否则一次点击写两次）。
    expect(harness.registry.get('settings-close-to-tray-toggle')!.children).toHaveLength(1);
    expect(toggle.listenerCount('click')).toBe(1);
  });

  it('is registered into the settings load and the i18n-change pass', () => {
    const source = readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8');
    expect(source).toContain("_settingsSafeCall('settings close-to-tray refresh', _settingsRefreshCloseToTray)");
    expect(source).toContain("_settingsSafeCall('settings close-to-tray render', _settingsRenderCloseToTray)");
    // 只在监听器体内出现才算数：宽松的 toContain 在调用只出现在 loadSettings 时
    // 也会通过，证明不了 i18n 路径接了线。
    const listenerStart = source.indexOf("window.addEventListener('i18n-change'");
    const listenerEnd = source.indexOf('\n});', listenerStart);
    expect(listenerStart).toBeGreaterThanOrEqual(0);
    expect(listenerEnd).toBeGreaterThan(listenerStart);
    const listenerBody = source.slice(listenerStart, listenerEnd);
    expect(listenerBody).toContain('_settingsRenderCloseToTray();');
  });

  it('uses the shared switch seam instead of a raw checkbox', () => {
    const html = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
    expect(html).toContain('id="settings-close-to-tray-toggle"');
    expect(html).not.toMatch(/<input[^>]+settings-close-to-tray/);
    const source = readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8');
    expect(source).toMatch(/uiSwitch\(\{[\s\S]{0,200}settings-close-to-tray-switch/);
  });

  it('declares the visible copy in both renderer locales', () => {
    const keys = [
      'settings.close_to_tray.title',
      'settings.close_to_tray.sub',
      'settings.close_to_tray.toggle',
    ];
    for (const language of ['zh', 'en'] as const) {
      const locale = JSON.parse(readFileSync(resolve(root, `src/renderer/locales/${language}.json`), 'utf8')) as Record<string, string>;
      for (const key of keys) expect(locale[key], `${language}: ${key}`).toBeTruthy();
    }
    const en = JSON.parse(readFileSync(resolve(root, 'src/renderer/locales/en.json'), 'utf8')) as Record<string, string>;
    for (const key of keys) expect(en[key], `en Han text: ${key}`).not.toMatch(/\p{Script=Han}/u);
    const html = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
    for (const key of keys) expect(html).toContain(`data-i18n="${key}"`);
  });
});
