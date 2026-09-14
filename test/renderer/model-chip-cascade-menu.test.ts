// Exec-config chip — provider → model → thinking-strength cascade (2026-09-14).
//
// 交互改造验收：卡片本身仍显示当前调用的模型名；展开后一级只列 provider；
// 悬停 provider 弹二级（该 provider 配置的模型）；悬停模型弹三级（该模型可
// 配置的思考强度）；点档位写入任务级 override 并整层收起。DOM 级用例（无
// jsdom 依赖，与 settings-custom-providers.test.ts 同款手写 DOM 假体）。
//
// 覆盖的失败路径：飞出层抢焦点导致外部点击误关、异步模型清单回来时飞出层
// 已换人/已收起、Escape 一次全关而不是逐级收。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 悬停开启 90ms / 收起 220ms（见 model-chip.js 的 _FLYOUT_*_DELAY）。
const afterOpen = () => sleep(140);
const afterClose = () => sleep(280);

/** 选择器匹配：支持 tag / #id / .class 及其组合（'.row.is-disabled'）。 */
function matchesSelector(el: FakeElement, selector: string): boolean {
  const id = selector.match(/#([^.#]+)/)?.[1];
  const classes = Array.from(selector.matchAll(/\.([^.#]+)/g), (m) => m[1]);
  const tag = selector.replace(/[#.][^.#]+/g, '').trim();
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (id && el.id !== id) return false;
  const own = el.className.split(/\s+/);
  return classes.every((name) => own.includes(name));
}

class FakeClassList {
  constructor(private readonly el: FakeElement) {}
  private names() { return this.el.className.split(/\s+/).filter(Boolean); }
  add(...names: string[]) { this.el.className = Array.from(new Set([...this.names(), ...names])).join(' '); }
  remove(...names: string[]) { this.el.className = this.names().filter((n) => !names.includes(n)).join(' '); }
  contains(name: string) { return this.names().includes(name); }
  toggle(name: string, force?: boolean) {
    const next = force === undefined ? !this.contains(name) : force;
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

class FakeElement {
  id = '';
  readonly tagName: string;
  dataset: Record<string, string> = {};
  // classList 以 className 为准（真实 DOM 里两者是同一份状态；分成两套会让
  // 直接赋 className 的渲染代码在断言里"看不见"自己的类）。
  classList = new FakeClassList(this);
  className = '';
  hidden = false;
  tabIndex = 0;
  title = '';
  textContent = '';
  type = '';
  style: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event?: any) => unknown>>();
  private readonly registry: Map<string, FakeElement>;
  private html = '';

  constructor(registry: Map<string, FakeElement>, id = '', tagName = 'div') {
    this.registry = registry;
    this.tagName = tagName.toUpperCase();
    if (id) this.setId(id);
  }

  private setId(id: string) { this.id = id; this.registry.set(id, this); }

  appendChild(child: FakeElement) {
    this.children.push(child);
    child.parentElement = this;
    if (child.id) this.registry.set(child.id, child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentElement = null;
    }
    if (this.id) this.registry.delete(this.id);
  }

  get isConnected() {
    let node: FakeElement | null = this;
    while (node) { if (node.tagName === 'BODY') return true; node = node.parentElement; }
    return false;
  }

  contains(node: FakeElement | null) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  closest(selector: string) {
    let node: FakeElement | null = this;
    while (node) { if (matchesSelector(node, selector)) return node; node = node.parentElement; }
    return null;
  }

  setAttribute(name: string, value: string) {
    if (name === 'id') this.setId(value);
    else if (name === 'class') this.className = value;
    else (this as any)[name] = value;
  }

  addEventListener(type: string, handler: (event?: any) => unknown) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (event?: any) => unknown) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((h) => h !== handler));
  }

  private async emit(type: string, extra: Record<string, unknown> = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...extra,
    };
    for (const handler of this.listeners.get(type) || []) await handler(event);
  }

  async dispatch(type: string, extra: Record<string, unknown> = {}) { await this.emit(type, extra); }
  async click() { await this.emit('click'); }
  async hover() { await this.emit('mouseenter'); }
  async unhover() { await this.emit('mouseleave'); }

  getBoundingClientRect() {
    return { top: 100, bottom: 124, left: 300, right: 460, width: 160, height: 24 };
  }

  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector: string) {
    const out: FakeElement[] = [];
    const visit = (el: FakeElement) => {
      if (matchesSelector(el, selector)) out.push(el);
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
    // 迷你 HTML 解析（含嵌套与文本）：行内是 <span class="main"><span
    // class="name">文本</span>…</span> 结构，扁平解析会把文本丢掉、把嵌套
    // 层级压平——回显类断言就查不到行名。
    const stack: FakeElement[] = [this];
    const token = /<\/?([a-z0-9-]+)\b([^>]*)>|([^<]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = token.exec(value))) {
      const raw = match[0];
      const text = match[3];
      if (text !== undefined) {
        const node = stack[stack.length - 1];
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
      const child = new FakeElement(this.registry, id, match[1]);
      child.className = className;
      stack[stack.length - 1].appendChild(child);
      if (!/\/>$/.test(raw)) stack.push(child);
    }
  }

  /** 序列化子树：appendChild 出来的行也要能在 innerHTML 断言里看到。 */
  outerHtml(): string {
    const tag = this.tagName.toLowerCase();
    const id = this.id ? ` id="${this.id}"` : '';
    const cls = this.className ? ` class="${this.className}"` : '';
    const inner = this.children.length
      ? this.children.map((child) => child.outerHtml()).join('')
      : this.textContent;
    return `<${tag}${id}${cls}>${inner}</${tag}>`;
  }

  get innerHTML() {
    return this.children.length ? this.children.map((child) => child.outerHtml()).join('') : this.html;
  }
}

function buildHarness(options: { override?: Record<string, unknown> } = {}) {
  const registry = new Map<string, FakeElement>();
  const body = new FakeElement(registry, '', 'body');
  body.setAttribute('id', '');

  const entries = [
    { provider: 'cp:cp-1', providerLabel: 'command', providerKind: 'custom', model: 'deepseek/deepseek-v4.1-flash', modelName: 'deepseek/deepseek-v4.1-flash' },
    { provider: 'anthropic', providerLabel: 'Anthropic', providerKind: 'builtin', model: 'claude-sonnet-4-5', modelName: 'Claude Sonnet 4.5' },
  ];
  const modelsByProvider: Record<string, Array<Record<string, unknown>>> = {
    'cp:cp-1': [
      { id: 'deepseek/deepseek-v4.1-flash', name: 'deepseek/deepseek-v4.1-flash', reasoning: true },
      { id: 'deepseek-v4.1-lite', name: 'deepseek-v4.1-lite', reasoning: false },
    ],
    anthropic: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true }],
  };
  const overrides: Array<Record<string, unknown> | null> = [];
  const invoke = vi.fn(async (channel: string, payload?: any) => {
    if (channel === 'auth.listEntries') return { ok: true, entries };
    if (channel === 'auth.listModels') return { ok: true, models: modelsByProvider[payload?.provider] || [] };
    if (channel === 'customProviders.list') {
      return {
        ok: true,
        providers: [{
          id: 'cp-1',
          models: [{ id: 'deepseek/deepseek-v4.1-flash', reasoningLevels: ['low', 'medium', 'high'] }],
        }],
      };
    }
    if (channel === 'prefs.getThinkingLevel') return { ok: true, level: 'auto' };
    return { ok: true };
  });

  const windowObj: any = {
    cogseed: { invoke },
    uiIconHtml: (name: string) => `<i data-icon="${name}"></i>`,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  windowObj.window = windowObj;

  const documentListeners = new Map<string, Array<(event?: any) => unknown>>();
  const documentObj: any = {
    body,
    getElementById: (id: string) => registry.get(id) || null,
    createElement: (tag: string) => new FakeElement(registry, '', tag),
    querySelector: (selector: string) => documentObj.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    addEventListener(type: string, handler: (event?: any) => unknown) {
      const list = documentListeners.get(type) || [];
      list.push(handler);
      documentListeners.set(type, list);
    },
    removeEventListener(type: string, handler: (event?: any) => unknown) {
      const list = documentListeners.get(type) || [];
      documentListeners.set(type, list.filter((h) => h !== handler));
    },
  };

  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    escapeHtml: (value: unknown) => String(value ?? ''),
    document: documentObj,
    window: windowObj,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    getChatRecipient: () => ({ kind: 'commander' }),
    getExecOverride: () => options.override || null,
    setExecOverride: (target: string, value: Record<string, unknown> | null) => { overrides.push(value); },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/model-chip.js'), 'utf8'), context, { filename: 'model-chip.js' });
  return { context, registry, body, invoke, overrides, entries, documentListeners };
}

async function openMenu(h: ReturnType<typeof buildHarness>) {
  const anchor = h.context.document.createElement('button');
  anchor.className = 'model-chip exec-config-chip';
  anchor.dataset.modelTarget = 'conversation';
  h.context.document.body.appendChild(anchor);
  h.context.__anchor = anchor;
  vm.runInContext('_modelChipEntries = __entries;', Object.assign(h.context, { __entries: h.entries }));
  h.context._toggleExecConfigMenu(anchor);
  return anchor;
}

describe('exec-config chip — provider → model → thinking-strength cascade', () => {
  it('keeps the card itself showing the invoked model name', async () => {
    const h = buildHarness();
    const anchor = await openMenu(h);
    expect(h.context._effectiveExecConfig('conversation').modelLabel).toBe('deepseek/deepseek-v4.1-flash');
    expect(h.context._effectiveExecConfig('conversation').provider).toBe('cp:cp-1');
    expect(anchor.title).toBe('exec_config.title');
  });

  it('lists providers (not models) at the first level, current one badged', async () => {
    const h = buildHarness();
    await openMenu(h);
    const menu = h.registry.get('model-chip-menu')!;
    const rows = menu.querySelectorAll('.model-chip-menu-item--provider');
    expect(rows.map((row) => row.querySelector('.model-chip-menu-name')!.textContent)).toEqual(['command', 'Anthropic']);
    expect(rows.map((row) => row.dataset.provider)).toEqual(['cp:cp-1', 'anthropic']);
    // 当前 provider 带「当前」徽标；副行保留该 provider 生效中的模型名。
    expect(rows[0].classList.contains('is-default')).toBe(true);
    expect(rows[0].querySelector('.model-chip-menu-sub')!.textContent).toBe('deepseek/deepseek-v4.1-flash');
    expect(menu.innerHTML).toContain('exec_config.section_provider');
    // 一级不再平铺模型行，思考强度也不再挂在一级。
    expect(menu.innerHTML).not.toContain('model-chip-menu-segmented');
  });

  it('opens the provider model list on hover, and the model thinking strengths on hover', async () => {
    const h = buildHarness();
    await openMenu(h);
    const menu = h.registry.get('model-chip-menu')!;
    const providerRow = menu.querySelectorAll('.model-chip-menu-item--provider')[0];
    await providerRow.hover();
    await afterOpen();

    const models = h.registry.get('model-chip-flyout-models');
    expect(models).toBeTruthy();
    // 飞出层贴在触发行的右侧（460 = 行的 right）。
    expect(Number(String(models!.style.left).replace('px', ''))).toBeGreaterThanOrEqual(460);
    const modelRows = models!.querySelectorAll('.model-chip-menu-item--provider');
    expect(modelRows.map((row) => row.querySelector('.model-chip-menu-name')!.textContent))
      .toEqual(['deepseek/deepseek-v4.1-flash', 'deepseek-v4.1-lite']);
    // 模型行带「已配置档位」标注（与模型配置页同源）。
    expect(models!.innerHTML).toContain('exec_config.model_levels_configured');

    await modelRows[0].hover();
    await afterOpen();
    const levels = h.registry.get('model-chip-flyout-levels');
    expect(levels).toBeTruthy();
    const levelRows = levels!.querySelectorAll('.model-chip-menu-item');
    expect(levelRows.map((row) => row.querySelector('.model-chip-menu-name')!.textContent))
      .toEqual(['model_effort.auto', 'model_effort.off', 'model_effort.low', 'model_effort.high']);
    // 不支持推理的模型只有自动/关闭可选（低/高置灰，无点击行为）。
    await modelRows[1].hover();
    await afterOpen();
    const liteLevels = h.registry.get('model-chip-flyout-levels')!;
    expect(liteLevels.querySelectorAll('.model-chip-menu-item.is-disabled')).toHaveLength(2);
  });

  it('writes the task override and collapses every level when a strength is picked', async () => {
    const h = buildHarness();
    await openMenu(h);
    const menu = h.registry.get('model-chip-menu')!;
    await menu.querySelectorAll('.model-chip-menu-item--provider')[0].hover();
    await afterOpen();
    const modelRows = h.registry.get('model-chip-flyout-models')!.querySelectorAll('.model-chip-menu-item--provider');
    await modelRows[0].hover();
    await afterOpen();

    const high = h.registry.get('model-chip-flyout-levels')!.querySelectorAll('.model-chip-menu-item')[3];
    await high.click();
    expect(h.overrides).toEqual([{ effort: 'high' }]);
    // 选完即整层收起：菜单与两级飞出层都不留悬浮残余。
    expect(h.registry.get('model-chip-menu')).toBeUndefined();
    expect(h.registry.get('model-chip-flyout-models')).toBeUndefined();
    expect(h.registry.get('model-chip-flyout-levels')).toBeUndefined();
  });

  it('switches the level-2 list instead of stacking flyouts when the pointer moves across providers', async () => {
    const h = buildHarness();
    await openMenu(h);
    const menu = h.registry.get('model-chip-menu')!;
    const providerRows = menu.querySelectorAll('.model-chip-menu-item--provider');
    await providerRows[0].hover();
    await afterOpen();
    await providerRows[1].hover();
    await afterOpen();
    const flyouts = h.body.querySelectorAll('.model-chip-flyout');
    expect(flyouts.filter((el) => el.dataset.flyout === 'models')).toHaveLength(1);
    expect(h.registry.get('model-chip-flyout-models')!.querySelector('.model-chip-menu-name')!.textContent)
      .not.toBe('deepseek/deepseek-v4.1-flash');
    // 换 provider 时上一级的模型飞出层必须已经被替换（没有第三级残留）。
    expect(h.registry.get('model-chip-flyout-levels')).toBeUndefined();
  });

  it('collapses the flyouts when the pointer leaves, and keeps the menu open', async () => {
    const h = buildHarness();
    await openMenu(h);
    const menu = h.registry.get('model-chip-menu')!;
    const providerRow = menu.querySelectorAll('.model-chip-menu-item--provider')[0];
    await providerRow.hover();
    await afterOpen();
    const modelRow = h.registry.get('model-chip-flyout-models')!.querySelectorAll('.model-chip-menu-item--provider')[0];
    await modelRow.hover();
    await afterOpen();
    expect(h.registry.get('model-chip-flyout-levels')).toBeTruthy();

    await modelRow.unhover();
    await afterClose();
    expect(h.registry.get('model-chip-flyout-levels')).toBeUndefined();
    expect(h.registry.get('model-chip-flyout-models')).toBeUndefined();
    // 一级菜单仍在——收起的是级联，不是整个入口。
    expect(h.registry.get('model-chip-menu')).toBeTruthy();
  });

  it('pins the flyout on click and collapses flyouts before the menu on Escape', async () => {
    const h = buildHarness();
    await openMenu(h);
    const menu = h.registry.get('model-chip-menu')!;
    const providerRow = menu.querySelectorAll('.model-chip-menu-item--provider')[0];
    // 触屏/键盘路径：点击即可打开二级（不依赖 hover），并钉住。
    await providerRow.click();
    await afterOpen();
    expect(h.registry.get('model-chip-flyout-models')).toBeTruthy();
    await afterClose();
    expect(h.registry.get('model-chip-flyout-models')).toBeTruthy();

    const pressEscape = async () => {
      for (const handler of h.documentListeners.get('keydown') || []) {
        await handler({ key: 'Escape', preventDefault() {} });
      }
    };
    // 级联两层：Escape 先收飞出层（菜单还在），再按一次才收菜单。
    await pressEscape();
    expect(h.registry.get('model-chip-flyout-models')).toBeUndefined();
    expect(h.registry.get('model-chip-menu')).toBeTruthy();
    await pressEscape();
    expect(h.registry.get('model-chip-menu')).toBeUndefined();
  });

  it('keeps the flyout alive while the pointer travels into it', async () => {
    const h = buildHarness();
    await openMenu(h);
    const menu = h.registry.get('model-chip-menu')!;
    const providerRow = menu.querySelectorAll('.model-chip-menu-item--provider')[0];
    await providerRow.hover();
    await afterOpen();
    const models = h.registry.get('model-chip-flyout-models')!;
    const modelRow = models.querySelectorAll('.model-chip-menu-item--provider')[0];
    await modelRow.hover();
    await afterOpen();
    // 指针从模型行移向三级飞出层：先离开行、再进入层（真实事件的顺序）。
    await modelRow.unhover();
    await models.dispatch('mouseenter');
    await afterClose();
    expect(h.registry.get('model-chip-flyout-levels')).toBeTruthy();
  });
});
