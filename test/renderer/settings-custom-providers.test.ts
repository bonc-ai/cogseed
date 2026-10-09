import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../..');
const customProviderLocaleFiles = ['en', 'zh', 'ja', 'pt'].map((language) => ({
  language,
  locale: JSON.parse(readFileSync(resolve(root, `src/renderer/locales/${language}.json`), 'utf8')) as Record<string, string>,
}));

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
    // 属性选择器 input[name="x"]——保存链读取 checkbox 靠它（2026-09-14）。
    const byName = selector.match(/^([a-z0-9-]+)\[name="([^"]+)"\]$/);
    const visit = (el: FakeElement) => {
      if (selector.startsWith('#') && el.id === selector.slice(1)) out.push(el);
      if (selector.startsWith('.') && el.className.split(/\s+/).includes(selector.slice(1))) out.push(el);
      if (byName && el.tagName.toLowerCase() === byName[1] && el.getAttribute('name') === byName[2]) out.push(el);
      // 标签选择器（'input' 等）——复现保存链需要按标签找 checkbox。
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
    // 栈式解析（2026-09-14）：扁平解析会把嵌套层级压平——字段容器里的
    // 输入框会变成容器的兄弟节点，`input.closest('.field')` 这类包含关系
    // 断言在 harness 里永远为 null。这里按开/闭标签维护父子栈。
    // 帧栈：每个开标签都压一帧（纯结构标签的帧 el=null），闭标签按帧弹出——
    // 只压"进树节点"会让无 id/class 的标签把栈带偏，嵌套关系随之错位。
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
      // 带 name 的控件（chips checkbox 等）也进树——只有 id/class 的旧过滤
      // 会把它们整个丢掉，query 不到（2026-09-14 保存失效排查）。
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
      // 浏览器行为对齐（2026-09-14 回显回归）：裸 checked 属性要反映成 .checked
      // 属性，textarea 的初始值来自元素文本而不是 value 属性。缺这两条，harness
      // 永远看不到「已保存的高级配置真的渲染进了表单」，回显缺陷测不出来。
      if (/(?:^|\s)checked(?:\s|$)/.test(attrs)) child.checked = true;
      // 同理：裸 disabled 属性（"已存在"的行）要反映成 .disabled，否则
      // "不可勾选/不参与全选"的断言看不到真实状态。
      if (/(?:^|\s)disabled(?:\s|$)/.test(attrs)) child.disabled = true;
      if (match[1].toLowerCase() === 'textarea') {
        const close = value.indexOf('</textarea>', token.lastIndex);
        if (close >= 0) {
          child.value = value.slice(token.lastIndex, close)
            .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        }
      }
      // 全属性按对象属性填充：本类 getAttribute 读 (this)[name]，而非 attrs
      // 字典——checkbox 的 name/value 属性因此可查。不覆盖上面已显式赋值的
      // 字段（className/value 等）。
      for (const attrMatch of attrs.matchAll(/([a-z0-9-]+)="([^"]*)"/gi)) {
        const key = attrMatch[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
        if ((child as any)[key] === undefined || (child as any)[key] === '') {
          if (key !== 'class') (child as any)[key] = attrMatch[2];
        }
      }
      for (const dataMatch of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/gi)) {
        child.dataset[dataMatch[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = dataMatch[2];
      }
      // 只有带 id/class/name 的节点进树（保持旧过滤：纯结构标签不进树），
      // 但每个开标签都要占一帧，闭标签才能把栈弹回正确层级。
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

  // 字段容器用 closest() 找就地错误行（真实 DOM 有；harness 需等价实现）。
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

  // 面板渲染有"元素已被移除就不再写 DOM"的守卫（避免异步回来写进已关闭的弹窗）；
  // harness 需要如实建模"挂在父节点上 = 仍在文档里"。
  get isConnected() {
    return this.parentElement !== null;
  }
}

function buildHarness() {
  const registry = new Map<string, FakeElement>();
  const ids = [
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

  const invoke = vi.fn(async (channel: string, payload?: any) => {
    if (channel === 'customProviders.list') {
      return {
        ok: true,
        providers: [{
          id: 'cp-1',
          name: 'Relay',
          protocol: 'openai',
          baseUrl: 'https://relay.example/v1',
          apiKeyMasked: 'sk-***',
          enabled: true,
          models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
          source: 'manual',
        }],
      };
    }
    if (channel === 'customProviders.add') return { ok: true, provider: { id: 'cp-2' } };
    if (channel === 'customProviders.update') return { ok: true, provider: { id: payload?.id || 'cp-1' } };
    if (channel === 'customProviders.remove') return { ok: true };
    if (channel === 'customProviders.setEnabled') return { ok: true, enabled: payload?.enabled };
    if (channel === 'customProviders.fetchModels') {
      return {
        ok: true,
        models: [
          {
            id: 'relay-a',
            contextWindow: 200000,
            maxTokens: 64000,
            input: ['text', 'image', 'video'],
            capabilities: ['structured_output'],
            reasoning: true,
            vision: true,
          },
          // 服务只声明了能力、没有模态：能力仍必须落库（此前能力被绑在
          // "声明了输入类型"上，这种模型的能力会被静默丢掉）。
          { id: 'relay-b', capabilities: ['native_web_search'] },
          // 已在本地：禁用、不参与全选，也不导入。
          { id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 },
        ],
      };
    }
    if (channel === 'customProviders.model.add') return { ok: true, model: payload?.model };
    if (channel === 'customProviders.model.update') return { ok: true, model: payload?.model };
    if (channel === 'customProviders.model.remove') return { ok: true, removed: true };
    if (channel === 'customProviders.model.test') return { ok: true, durationMs: 42 };
    if (channel === 'customProviders.ccswitch.probe') return { ok: true, ready: true, hasData: true };
    if (channel === 'customProviders.ccswitch.preview') {
      return {
        ok: true,
        items: [
          { externalId: 'cc-1', name: 'Claude Desktop', protocol: 'anthropic', apiKeyMasked: 'sk-***', needsKey: false, models: ['claude-sonnet-4-5'] },
          { externalId: 'cc-2', name: 'Codex', protocol: 'openai', apiKeyMasked: '', needsKey: true, models: ['gpt-5.6-codex'] },
        ],
        unsupported: [],
      };
    }
    if (channel === 'customProviders.ccswitch.sync') return { ok: true, syncedIds: payload?.externalIds || [] };
    if (channel === 'modelOverrides.list') {
      return {
        ok: true,
        provider: payload?.provider,
        caps: { contextWindow: 16777216, maxTokens: 1048576 },
        models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', preset: { contextWindow: 1000000, maxTokens: 384000 }, effective: { contextWindow: 1000000, maxTokens: 384000 }, overridden: false }],
      };
    }
    if (channel === 'modelOverrides.set') return { ok: true, override: { contextWindow: payload?.contextWindow, maxTokens: payload?.maxTokens } };
    if (channel === 'modelOverrides.clear') return { ok: true, cleared: true };
    return { ok: true };
  });

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

  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string, vars?: Record<string, string>) => vars ? `${key} ${JSON.stringify(vars)}` : key,
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
  // 共享表单/按钮工厂的真实实现由 ui-form.js / ui-button.js 提供（经典脚本）；
  // VM 里只装最小等价桩：字段要带出可寻址的输入，按钮要带出可点标签。
  windowObj.uiField = (options: any) => {
    const control = options?.control || {};
    const hint = options?.hint ? `<p class="ui-field__hint">${String(options.hint)}</p>` : '';
    const placeholder = control.placeholder == null ? '' : ` placeholder="${String(control.placeholder)}"`;
    // 真实 ui-form.js 每张字段都带"必填/选填"标记（除非 showRequirement: false）
    // ——桩同形，卡片"不逐条标注"的断言才看得见真实产物。
    const requirement = options?.showRequirement === false
      ? ''
      : `<span class="ui-field__requirement">${options?.required ? '必填' : '选填'}</span>`;
    return '<div class="ui-field"><span class="ui-field__label">' + String(options?.label || '') + '</span>'
      + requirement
      + `<input id="${String(options?.id || '')}" class="form-input ui-input" value="${control.value == null ? '' : String(control.value)}"${placeholder} />`
      + hint + '</div>';
  };
  windowObj.showContextMenu = vi.fn();
  // ui-button.js 真实产物带 .ui-button__label 标签（拉取列表的全选按钮靠它换
  // 文案），桩必须同形，否则"标签随状态切换"在 harness 里永远测不到。
  windowObj.uiButton = (options: any) => `<button type="button" class="btn ui-button ${String(options?.className || '')}" data-label="${String(options?.label || '')}"><span class="ui-button__label">${String(options?.label || '')}</span></button>`;
  windowObj.uiIconButton = (options: any) => `<button type="button" class="ui-icon-button" data-label="${String(options?.label || '')}"></button>`;
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/ui-button.js'), 'utf8'), context, { filename: 'ui-button.js' });
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/ui-form.js'), 'utf8'), context, { filename: 'ui-form.js' });
  context.uiButton = windowObj.uiButton;
  context.uiIconButton = windowObj.uiIconButton;
  context.uiInput = windowObj.uiInput;
  context.uiCheckbox = windowObj.uiCheckbox;
  context.uiTextarea = windowObj.uiTextarea;
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8'), context, { filename: 'settings.js' });
  return { context, registry, invoke, windowObj, documentListeners, aiSelectMount };
}

describe('settings model providers surface', () => {
  it('replaces the visible authorization copy with Model Providers and exposes the custom provider + CC Switch controls', () => {
    const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
    const source = readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8');

    expect(indexHtml).toContain('data-settings-tab="configuration"');
    expect(indexHtml).toContain('data-i18n="settings.tab.configuration"');
    expect(indexHtml).not.toContain('Model Authorization');
    // The standalone custom-provider list was folded into the provider
    // picker's two action rows; the dialogs remain reachable.
    expect(indexHtml).not.toContain('id="settings-custom-provider-list"');
    expect(source).toContain('_PICKER_ACTION_CUSTOM_PROVIDERS');
    expect(source).toContain('_PICKER_ACTION_CCSWITCH_IMPORT');
    expect(indexHtml).toContain('id="settings-custom-provider-modal"');
    expect(indexHtml).toContain('id="settings-ccswitch-preview-modal"');
    expect(source).toContain("customProviders.list");
    expect(source).toContain("customProviders.add");
    expect(source).toContain("customProviders.update");
    expect(source).toContain("customProviders.remove");
    expect(source).toContain("customProviders.ccswitch.probe");
    expect(source).toContain("customProviders.ccswitch.preview");
    expect(source).toContain("customProviders.ccswitch.sync");
  });

  it('declares the multi-model provider editor and detail actions from the approved reference', () => {
    const source = readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8');
    for (const token of [
      'settings.custom_providers.add_subtitle',
      'settings.custom_providers.api_format',
      'settings-custom-provider-model-list',
      'settings-custom-provider-add-model',
      'customProviders.setEnabled',
      'customProviders.model.add',
      'customProviders.model.update',
      'customProviders.model.remove',
      'customProviders.model.test',
      'const _CUSTOM_PROVIDER_MAX_CONTEXT_WINDOW = 16777216',
      'const _CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS = 1048576',
    ]) expect(source).toContain(token);
  });

  it('keeps the custom-provider workflow localized and responsive', () => {
    const requiredKeys = [
      'settings.custom_providers.add_subtitle',
      'settings.custom_providers.api_format',
      'settings.custom_providers.api_format_anthropic',
      'settings.custom_providers.api_format_openai',
      'settings.custom_providers.api_format_gemini',
      'settings.custom_providers.model_id',
      'settings.custom_providers.context_window',
      'settings.custom_providers.max_tokens',
      'settings.custom_providers.test_model',
      'settings.custom_providers.enable',
      'settings.custom_providers.disable',
      'settings.custom_providers.error_duplicate_model',
      'settings.picker.error_provider_disabled',
      // 拉取列表头部的全选动作（2026-09-14）：四语缺一就会退回代码里的中文兜底。
      'settings.custom_providers.select_all',
      'settings.custom_providers.deselect_all',
      'settings.custom_providers.fetch_models_import',
    ];
    for (const { language, locale } of customProviderLocaleFiles) {
      for (const key of requiredKeys) expect(locale[key], `${language}: ${key}`).toBeTruthy();
    }
    const style = readFileSync(resolve(root, 'src/renderer/style.css'), 'utf8');
    for (const selector of [
      '.settings-custom-provider-model-draft',
      '.settings-custom-provider-detail-model-row',
      '.settings-custom-provider-secret-input',
      '@media (max-width: 720px)',
      '.settings-custom-provider-model-draft-remove',
      '.settings-custom-provider-detail-header-actions > .icon-btn',
      '.settings-custom-provider-detail-model-list',
    ]) expect(style).toContain(selector);
  });

  it('renders the unified model form with the designed field set (2026-09-13)', () => {
    const source = readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8');
    for (const token of [
      'settings-model-form-smart',
      'settings-model-form-input-chips',
      'settings-model-form-capability-chips',
      'settings-model-form-levels',
      'settings-model-form-level-add',
      'settings-custom-provider-model-params',
      'settings.custom_providers.smart_config',
      'settings.custom_providers.input_types',
      'settings.custom_providers.model_capabilities',
      'settings.custom_providers.reasoning_levels',
      'settings.custom_providers.reasoning_params_map',
      'settings.custom_providers.reset_form',
      'customProviders.fetchModels',
    ]) expect(source).toContain(token);
    const uiComponents = readFileSync(resolve(root, 'src/renderer/ui-components.css'), 'utf8');
    for (const selector of [
      '.settings-model-form__smart',
      '.settings-check-chip',
      '.settings-level-row',
      '.settings-model-form__advanced',
    ]) expect(uiComponents).toContain(selector);
    // 新表单文案四语齐备（缺任一语会退回代码里的中文兜底）。
    const requiredKeys = [
      'settings.custom_providers.smart_config',
      'settings.custom_providers.smart_config_hint',
      'settings.custom_providers.smart_config_applied',
      'settings.custom_providers.advanced_config',
      'settings.custom_providers.input_types',
      'settings.custom_providers.input_type_text',
      'settings.custom_providers.input_type_image',
      'settings.custom_providers.input_type_video',
      'settings.custom_providers.input_type_pdf',
      'settings.custom_providers.model_capabilities',
      'settings.custom_providers.capability_structured_output',
      'settings.custom_providers.capability_native_web_search',
      'settings.custom_providers.capability_system_message',
      'settings.custom_providers.reasoning_levels',
      'settings.custom_providers.reasoning_levels_hint',
      'settings.custom_providers.reasoning_params_map',
      'settings.custom_providers.reasoning_params_map_hint',
      'settings.custom_providers.reset_form',
      'settings.custom_providers.error_reasoning_map',
    ];
    for (const { language, locale } of customProviderLocaleFiles) {
      for (const key of requiredKeys) expect(locale[key], `${language}: ${key}`).toBeTruthy();
    }
  });

  it('refreshes the custom-provider list and CC Switch probe with the expected IPC channels', async () => {
    const { context, registry, invoke } = buildHarness();

    await vm.runInContext('_settingsRefreshCustomProviders()', context);
    await vm.runInContext('_settingsRefreshCcswitchStatus()', context);
    await vm.runInContext('_settingsRenderCustomProviders()', context);

    expect(invoke).toHaveBeenCalledWith('customProviders.list');
    expect(invoke).toHaveBeenCalledWith('customProviders.ccswitch.probe');
    expect(registry.get('settings-custom-provider-list')!.children.length).toBeGreaterThan(0);
    expect(registry.get('settings-custom-provider-list')!.children[0].children[0].children[0].textContent).toContain('Relay');
  });

  it('opens the add/edit dialog, keeps existing keys masked, and syncs the selected CC Switch rows', async () => {
    const { context, registry, invoke } = buildHarness();

    await vm.runInContext('_settingsRenderCustomProviders()', context);
    await vm.runInContext("_settingsOpenCustomProviderModal({ id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1', models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }], apiKeyMasked: 'sk-***' })", context);
    registry.get('settings-custom-provider-name')!.value = 'Relay v2';
    registry.get('settings-custom-provider-protocol')!.value = 'openai';
    registry.get('settings-custom-provider-base-url')!.value = 'https://relay.example/v2';
    registry.get('settings-custom-provider-api-key')!.value = 'sk-new-secret';
    registry.get('settings-custom-provider-modal-actions')!.children[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await vm.runInContext('_settingsOpenCcswitchPreviewDialog()', context);
    const previewList = registry.get('settings-ccswitch-preview-modal-body')!;
    const previewRows = previewList.querySelectorAll('.settings-ccswitch-row');
    expect(previewRows.length).toBe(2);
    // needsKey rows carry the warning badge; keyed rows do not.
    expect(previewRows[0].querySelector('.settings-ccswitch-row-warn')).toBeNull();
    expect(previewRows[1].querySelector('.settings-ccswitch-row-warn')).toBeTruthy();

    // Two-step flow: open the first provider's model detail, check one model,
    // then import.
    previewRows[0].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const modelRows = previewList.querySelectorAll('.settings-ccswitch-model-row');
    expect(modelRows.length).toBeGreaterThan(0);
    const check = modelRows[0].querySelector('.settings-ccswitch-model-check')!;
    check.checked = true;
    await check.dispatch('change');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const syncBtn = registry.get('settings-ccswitch-preview-sync-btn')!;
    expect(syncBtn.disabled).toBe(false);
    expect(vm.runInContext('_settingsState.ccswitchPreviewSelectedModels', context)).toEqual(['claude-sonnet-4-5']);
    syncBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).toHaveBeenCalledWith('customProviders.update', expect.objectContaining({ id: 'cp-1' }));
    expect(invoke).toHaveBeenCalledWith('customProviders.ccswitch.preview');
    expect(invoke).toHaveBeenCalledWith('customProviders.ccswitch.sync', expect.objectContaining({ externalIds: ['cc-1'] }));
  });

  it('creates one provider with multiple structured models', async () => {
    const { context, registry, invoke, aiSelectMount } = buildHarness();

    vm.runInContext('_settingsOpenCustomProviderModal()', context);
    registry.get('settings-custom-provider-name')!.value = 'DeepSeek';
    // Protocol is an ai-select now; drive it through the mounted API.
    aiSelectMount.mock.results.at(-1)?.value.setValue('openai');
    registry.get('settings-custom-provider-base-url')!.value = 'https://api.deepseek.com/v1';
    registry.get('settings-custom-provider-api-key')!.value = 'sk-secret';

    const modelList = registry.get('settings-custom-provider-model-list')!;
    // Minimal editor: one model-name input per row; context window and max
    // output fall back to the provider defaults (131072 / 8192).
    const first = modelList.children[0];
    first.querySelector('.settings-custom-provider-model-id')!.value = 'deepseek-v4-flash';
    expect(first.querySelector('.settings-custom-provider-model-context')).toBeNull();
    expect(first.querySelector('.settings-custom-provider-model-output')).toBeNull();
    registry.get('settings-custom-provider-add-model')!.click();
    const second = modelList.children[1];
    second.querySelector('.settings-custom-provider-model-id')!.value = 'deepseek-v4-pro';

    registry.get('settings-custom-provider-modal-actions')!.children[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).toHaveBeenCalledWith('customProviders.add', expect.objectContaining({
      name: 'DeepSeek',
      protocol: 'openai',
      models: [
        // 默认口径 2026-09-13（十进制 1M / 384K）：目录认识的模型由后端
        // 归一解析窗口/输出，草稿只送 id。
        { id: 'deepseek-v4-flash', contextWindow: 1000000, maxTokens: 384000 },
        { id: 'deepseek-v4-pro', contextWindow: 1000000, maxTokens: 384000 },
      ],
    }));
  });

  it('renders provider details without exposing a raw key and routes every detail action through IPC', async () => {
    const { context, registry, invoke } = buildHarness();
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKey: 'must-never-render', apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };

    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    const rendered = registry.get('settings-custom-provider-modal-body')!.innerHTML;
    expect(rendered).toContain('sk-***');
    expect(rendered).not.toContain('must-never-render');

    await vm.runInContext('_settingsSetCustomProviderEnabled(__provider, false)', context);
    await vm.runInContext("_settingsTestCustomProviderModel(__provider, __provider.models[0])", context);
    await vm.runInContext("_settingsSaveCustomProviderModel(__provider, 'gpt-4.1-mini', { id: 'gpt-4.1', contextWindow: 200000, maxTokens: 12000 })", context);
    await vm.runInContext("_settingsRemoveCustomProviderModel(__provider, 'gpt-4.1')", context);

    expect(invoke).toHaveBeenCalledWith('customProviders.setEnabled', { id: 'cp-1', enabled: false });
    expect(invoke).toHaveBeenCalledWith('customProviders.model.test', { providerId: 'cp-1', modelId: 'gpt-4.1-mini' });
    expect(invoke).toHaveBeenCalledWith('customProviders.model.update', expect.objectContaining({ providerId: 'cp-1', modelId: 'gpt-4.1-mini' }));
    expect(invoke).toHaveBeenCalledWith('customProviders.model.remove', { providerId: 'cp-1', modelId: 'gpt-4.1' });
  });

  it('keeps compact model actions icon-only and registers one modal Escape handler', () => {
    const { context, registry, documentListeners } = buildHarness();
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    context.__provider = provider;

    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    const detailList = registry.get('settings-custom-provider-detail-model-list')!;
    const rowChildren = detailList.children[0].children[1].children;
    // 行内动作仍是三个图标钮（测试/编辑/删除），行尾另有每模型开关（label 容器，
    // 不是按钮）——两类控件分开数，避免把开关也当成图标钮。
    const actionButtons = rowChildren.filter((child: any) => child.className.includes('icon-btn'));
    expect(actionButtons).toHaveLength(3);
    expect(rowChildren.filter((child: any) => child.className.includes('settings-custom-provider-model-toggle')))
      .toHaveLength(1);
    for (const button of actionButtons) {
      expect(button.innerHTML).not.toContain('<span>');
      expect(button.title).toBeTruthy();
    }

    vm.runInContext('_settingsOpenCustomProviderModal(__provider)', context);
    vm.runInContext('_settingsOpenCustomProviderModelEditor(__provider, __provider.models[0])', context);
    expect(documentListeners.get('keydown')).toHaveLength(1);
  });

  it('persists advanced fields when saving from the model editor (2026-09-14 保存失效排查)', async () => {
    const { context, registry, invoke } = buildHarness();
    const g = context as any;
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    g._settingsOpenCustomProviderModal(provider);
    g._settingsOpenCustomProviderModelEditor(provider, provider.models[0]);

    const body = registry.get('settings-custom-provider-modal-body')!;
    // 修改高级配置：勾「图片」、勾一个能力、加推理等级、填参数映射。
    const inputs = Array.from(body.querySelectorAll('input')) as any[];
    const imageBox = inputs.find((el) => el.getAttribute('name') === 'settings-model-form-input'
      && el.getAttribute('value') === 'image');
    imageBox.checked = true;
    const capabilityBox = inputs.find((el) => el.getAttribute('name') === 'settings-model-form-capability'
      && el.getAttribute('value') === 'structured_output');
    capabilityBox.checked = true;
    body.querySelector('#settings-model-form-level-add').click();
    const levelInput = body.querySelector('.settings-level-row__input') as any;
    levelInput.value = 'high';
    body.querySelector('#settings-custom-provider-model-params').value = '{"high": {"reasoning_effort": "high"}}';

    // 「重置表单」后重新修改（2026-09-14 保存失效的复现路径：重置曾丢失
    // 事件绑定，"+"加不了等级 → 保存等级为空 → 库里保持旧值）。
    const actions = registry.get('settings-custom-provider-modal-actions')!;
    actions.children[0].click(); // 重置
    const resetImage = Array.from(body.querySelectorAll('input[name="settings-model-form-input"]')).find((el: any) => el.getAttribute('value') === 'image') as any;
    resetImage.checked = true;
    const resetCap = Array.from(body.querySelectorAll('input[name="settings-model-form-capability"]')).find((el: any) => el.getAttribute('value') === 'structured_output') as any;
    resetCap.checked = true;
    body.querySelector('#settings-model-form-level-add').click();
    (body.querySelector('.settings-level-row__input') as any).value = 'high';
    body.querySelector('#settings-custom-provider-model-params').value = '{"high": {"reasoning_effort": "high"}}';

    // 点保存（actions：重置 / 取消 / 保存）。
    const save = actions.children[actions.children.length - 1];
    save.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = invoke.mock.calls.find(([channel]: any[]) => channel === 'customProviders.model.update');
    expect(call).toBeTruthy();
    expect(call![1].model).toMatchObject({
      id: 'gpt-4.1-mini',
      contextWindow: 131072,
      maxTokens: 8192,
      input: ['text', 'image'],
      capabilities: ['structured_output'],
      reasoningLevels: ['high'],
      reasoningParamsMap: { high: { reasoning_effort: 'high' } },
    });
  });

  // 2026-09-14 回显失效根因回归：模型行投影曾把 input/vision/capabilities/
  // reasoningLevels/reasoningParamsMap 压掉，详情行 ✏️ 拿残模型开表单 →
  // 高级配置永远显示"没配过"，原样保存再把 input 覆盖成 ["text"]。
  const ADVANCED_MODEL = {
    id: 'deepseek/deepseek-v4.1-flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    vision: true,
    input: ['text', 'image', 'video', 'pdf'],
    capabilities: ['structured_output'],
    reasoningLevels: ['low', 'medium', 'high'],
    reasoningParamsMap: { high: { reasoning_effort: 'high' } },
  };
  const advancedProvider = () => ({
    id: 'cp-1', name: 'command', protocol: 'openai', baseUrl: 'https://api.example/v1',
    enabled: true, apiKeyMasked: 'sk-***',
    models: [JSON.parse(JSON.stringify(ADVANCED_MODEL))],
  });

  it('projects stored provider models losslessly so the editor can read the advanced config', () => {
    const { context } = buildHarness();
    context.__provider = advancedProvider();
    const projected = vm.runInContext('_settingsCustomProviderModels(__provider)', context);
    expect(projected).toEqual([ADVANCED_MODEL]);
  });

  it('reopens the model editor from the detail row with the stored advanced config (2026-09-14 回显失效根因)', async () => {
    const { context, registry, invoke } = buildHarness();
    const provider = advancedProvider();
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);

    // 详情行动作：测试 / 编辑 / 删除 —— 走真实入口（✏️），不直接喂原始模型。
    const editButton = registry.get('settings-custom-provider-detail-model-list')!.children[0].children[1].children[1];
    await editButton.click();

    const body = registry.get('settings-custom-provider-modal-body')!;
    for (const value of ['text', 'image', 'video', 'pdf']) {
      expect(body.innerHTML).toContain(`name="settings-model-form-input" value="${value}" checked`);
    }
    expect(body.innerHTML).toContain('name="settings-model-form-capability" value="structured_output" checked');
    expect(Array.from(body.querySelectorAll('.settings-level-row__input'), (el: any) => el.value)).toEqual(['low', 'medium', 'high']);
    expect(JSON.parse((body.querySelector('#settings-custom-provider-model-params') as any).value))
      .toEqual({ high: { reasoning_effort: 'high' } });

    // 打开即可原样保存：表单读回来的就是盘上那份配置（未改任何字段）。
    expect(vm.runInContext('_settingsReadModelForm(document.getElementById("settings-custom-provider-modal-body"))', context)).toEqual({
      id: 'deepseek/deepseek-v4.1-flash',
      contextWindow: 1000000,
      maxTokens: 384000,
      smart: true,
      inputTypes: ['text', 'image', 'video', 'pdf'],
      capabilities: ['structured_output'],
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningParamsMap: '{\n  "high": {\n    "reasoning_effort": "high"\n  }\n}',
    });

    const actions = registry.get('settings-custom-provider-modal-actions')!;
    actions.children[actions.children.length - 1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = invoke.mock.calls.find(([channel]: any[]) => channel === 'customProviders.model.update');
    expect(call).toBeTruthy();
    expect(call![1].model).toEqual({
      id: 'deepseek/deepseek-v4.1-flash',
      contextWindow: 1000000,
      maxTokens: 384000,
      input: ['text', 'image', 'video', 'pdf'],
      capabilities: ['structured_output'],
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningParamsMap: { high: { reasoning_effort: 'high' } },
    });
  });

  it('sends explicit empty advanced fields when the user clears them, so clearing can persist', async () => {
    const { context, registry, invoke } = buildHarness();
    const provider = advancedProvider();
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    await registry.get('settings-custom-provider-detail-model-list')!.children[0].children[1].children[1].click();

    const body = registry.get('settings-custom-provider-modal-body')!;
    // 清空高级配置：取消图片/视频/PDF、取消能力、删掉全部推理等级、清空参数映射。
    for (const el of body.querySelectorAll('input[name="settings-model-form-input"]')) {
      if ((el as any).value !== 'text') (el as any).checked = false;
    }
    for (const el of body.querySelectorAll('input[name="settings-model-form-capability"]')) (el as any).checked = false;
    for (const removeButton of body.querySelectorAll('.settings-level-row__remove')) await (removeButton as any).click();
    (body.querySelector('#settings-custom-provider-model-params') as any).value = '';

    const actions = registry.get('settings-custom-provider-modal-actions')!;
    actions.children[actions.children.length - 1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = invoke.mock.calls.find(([channel]: any[]) => channel === 'customProviders.model.update');
    expect(call).toBeTruthy();
    // 空数组/空对象必须显式出现在载荷里：后端"未提供=保留旧值"，
    // 字段缺失就永远清不掉（清空与保存不生效是同一类表象）。
    expect(call![1].model).toEqual({
      id: 'deepseek/deepseek-v4.1-flash',
      contextWindow: 1000000,
      maxTokens: 384000,
      input: ['text'],
      capabilities: [],
      reasoningLevels: [],
      reasoningParamsMap: {},
    });
  });

  it('keeps in-progress advanced edits when an i18n redraw rebuilds the model form', async () => {
    const { context, registry, windowObj } = buildHarness();
    const provider = advancedProvider();
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    await registry.get('settings-custom-provider-detail-model-list')!.children[0].children[1].children[1].click();

    const body = registry.get('settings-custom-provider-modal-body')!;
    const chip = (name: string, value: string) => Array.from(body.querySelectorAll(`input[name="${name}"]`))
      .find((el: any) => el.value === value) as any;
    // 用户正在编辑：取消视频、补一个能力、加一级、改参数映射。
    chip('settings-model-form-input', 'video').checked = false;
    chip('settings-model-form-capability', 'system_message').checked = true;
    (body.querySelector('#settings-model-form-level-add') as any).click();
    const levelInputs = body.querySelectorAll('.settings-level-row__input');
    (levelInputs[levelInputs.length - 1] as any).value = 'xhigh';
    (body.querySelector('#settings-custom-provider-model-params') as any).value = '{"xhigh": {"reasoning_effort": "high"}}';

    windowObj.dispatchEvent({ type: 'i18n-change' });

    expect(chip('settings-model-form-input', 'image').checked).toBe(true);
    expect(chip('settings-model-form-input', 'video').checked).toBe(false);
    expect(chip('settings-model-form-capability', 'structured_output').checked).toBe(true);
    expect(chip('settings-model-form-capability', 'system_message').checked).toBe(true);
    expect(Array.from(body.querySelectorAll('.settings-level-row__input'), (el: any) => el.value))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
    expect((body.querySelector('#settings-custom-provider-model-params') as any).value)
      .toBe('{"xhigh": {"reasoning_effort": "high"}}');
    expect((body.querySelector('#settings-custom-provider-model-edit-id') as any).value).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('gates smart-fill to first-time manual model entry only (2026-09-13 触发收敛)', async () => {
    const { context, registry, invoke } = buildHarness();
    const g = context as any;
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    g._settingsOpenCustomProviderModal(provider);
    const body = registry.get('settings-custom-provider-modal-body')!;
    const fetchCalls = () => invoke.mock.calls.filter(([channel]: any[]) => channel === 'customProviders.fetchModels');

    // 编辑已有模型：开关与「已按…智能填充」提示的载体整块不渲染，blur 不拉远端清单。
    g._settingsOpenCustomProviderModelEditor(provider, provider.models[0]);
    expect(body.innerHTML).not.toContain('settings-model-form__smart');
    expect(body.querySelector('#settings-model-form-smart')).toBeNull();
    const editIdInput = body.querySelector('#settings-custom-provider-model-edit-id') as any;
    editIdInput.value = 'gpt-4.1-mini';
    await editIdInput.dispatch('blur');
    expect(fetchCalls()).toHaveLength(0);

    // 一键/预填路径（options.draft）：同样不渲染、不触发。
    g._settingsOpenCustomProviderModelEditor(provider, null, { draft: { id: 'relay-x', contextWindow: 200000, maxTokens: 32000 } });
    expect(body.innerHTML).not.toContain('settings-model-form__smart');
    expect(body.querySelector('#settings-model-form-smart')).toBeNull();

    // 首次手动新增：开关在、默认开，blur 触发远端清单拉取（便利功能保留）。
    g._settingsOpenCustomProviderModelEditor(provider);
    expect(body.innerHTML).toContain('settings-model-form__smart');
    const smartToggle = body.querySelector('#settings-model-form-smart') as any;
    expect(smartToggle).toBeTruthy();
    // 渲染即默认开（harness 不解析无值裸属性，用 HTML 串锁定 checked）。
    expect(body.innerHTML).toContain('id="settings-model-form-smart" type="checkbox" checked');
    // FakeElement 不把 checked 属性反映为 .checked 属性（浏览器行为），显式置真。
    smartToggle.checked = true;
    const addIdInput = body.querySelector('#settings-custom-provider-model-edit-id') as any;
    addIdInput.value = 'gpt-4.1-mini';
    await addIdInput.dispatch('blur');
    expect(fetchCalls()).toHaveLength(1);
  });

  it('拉取模型列表：头部「全选/取消全选」一次切换可选行，导入计数同步（2026-09-14）', async () => {
    const { context, registry } = buildHarness();
    const g = context as any;
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    g._settingsOpenCustomProviderModal(provider);
    await g._settingsOpenCustomProviderFetchModels(provider);

    const head = registry.get('settings-custom-provider-modal-head-actions')!;
    const toggle = head.querySelector('.settings-custom-provider-select-all') as any;
    expect(toggle).toBeTruthy();
    const label = () => toggle.querySelector('.ui-button__label').textContent;
    const list = registry.get('settings-custom-provider-fetch-list')!;
    const boxes = list.querySelectorAll('.settings-custom-provider-fetch-box') as any[];
    const actions = registry.get('settings-custom-provider-modal-actions')!;
    const importButton = actions.children[1] as any;
    // 第三行已在本地：不勾选、禁用（harness 对缺失的 checked 属性给 undefined，
    // 浏览器给 false——统一按"是否真的选中"比）。
    expect(boxes.map((box) => box.checked === true)).toEqual([true, true, false]);
    expect(boxes[2].disabled).toBe(true);
    // 渲染时默认全部可选行都勾上 → 按钮此刻的动作是"取消全选"。
    expect(label()).toBe('settings.custom_providers.deselect_all');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(importButton.textContent).toContain('"count":2');
    expect(importButton.disabled).toBe(false);

    // 手动取消一个：计数与按钮动作立刻跟上（此前计数只在渲染时算一次，
    // 取消勾选后数字会与选项对不上）。
    boxes[1].checked = false;
    await boxes[1].dispatch('change');
    expect(importButton.textContent).toContain('"count":1');
    expect(label()).toBe('settings.custom_providers.select_all');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // 全选：两行都选中（已存在的行不参与），标签切到「取消全选」。
    await toggle.click();
    expect(boxes.map((box) => box.checked === true)).toEqual([true, true, false]);
    expect(label()).toBe('settings.custom_providers.deselect_all');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(importButton.textContent).toContain('"count":2');

    // 再点一次：全部取消，导入按钮禁用，标签回到「全选」。
    await toggle.click();
    expect(boxes.map((box) => box.checked === true)).toEqual([false, false, false]);
    expect(label()).toBe('settings.custom_providers.select_all');
    expect(importButton.textContent).toContain('"count":0');
    expect(importButton.disabled).toBe(true);
  });

  it('导入进行中勾选变化不得重新启用导入按钮（并发防重，2026-09-14 复查）', async () => {
    const { context, registry, invoke } = buildHarness();
    const g = context as any;
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    // model.add 挂起成手动放行的 promise，把"导入在途"钉住在可控的时间点。
    const addResolvers: Array<() => void> = [];
    invoke.mockImplementation(async (channel: string, payload?: any) => {
      if (channel === 'customProviders.list') return { ok: true, providers: [provider] };
      if (channel === 'customProviders.fetchModels') {
        return {
          ok: true,
          models: [
            { id: 'relay-a', contextWindow: 200000, maxTokens: 64000 },
            { id: 'relay-b', contextWindow: 131072, maxTokens: 8192 },
            { id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 },
          ],
        };
      }
      if (channel === 'customProviders.model.add') {
        return new Promise((resolve) => { addResolvers.push(() => resolve({ ok: true, model: payload?.model })); });
      }
      return { ok: true };
    });
    g._settingsOpenCustomProviderModal(provider);
    await g._settingsOpenCustomProviderFetchModels(provider);
    const importButton = registry.get('settings-custom-provider-modal-actions')!.children[1] as any;
    const boxes = registry.get('settings-custom-provider-fetch-list')!.querySelectorAll('.settings-custom-provider-fetch-box') as any[];
    expect(importButton.disabled).toBe(false);

    const clickPromise = importButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 导入在途：按钮禁用。
    expect(importButton.disabled).toBe(true);
    // 竞态：导入期间取消勾选一行（picked 仍为 1）——没有 importing 锁时
    // syncSelection 会把按钮重新启用，用户即可点出第二轮导入。
    boxes[1].checked = false;
    await boxes[1].dispatch('change');
    expect(importButton.disabled).toBe(true);

    // 放行两笔在途写入（第二笔在第一笔放行后才进入），导入按进入循环前的快照完成。
    addResolvers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(addResolvers.length).toBe(2);
    addResolvers[1]!();
    await clickPromise;
    const adds = invoke.mock.calls.filter(([channel]: any[]) => channel === 'customProviders.model.add');
    expect(adds).toHaveLength(2);
  });

  it('拉取模型列表：导入把服务声明的模态与能力一起落库（2026-09-14）', async () => {
    const { context, registry, invoke } = buildHarness();
    const g = context as any;
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    g._settingsOpenCustomProviderModal(provider);
    await g._settingsOpenCustomProviderFetchModels(provider);
    const importButton = registry.get('settings-custom-provider-modal-actions')!.children[1] as any;
    await importButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const added = invoke.mock.calls
      .filter(([channel]: any[]) => channel === 'customProviders.model.add')
      .map(([, payload]: any[]) => payload.model);
    expect(added).toEqual([
      {
        id: 'relay-a',
        contextWindow: 200000,
        maxTokens: 64000,
        input: ['text', 'image', 'video'],
        capabilities: ['structured_output'],
      },
      // 没有模态声明时不写 input（"未知"不能写成"不支持图片"，否则挡掉目录兜底），
      // 但能力照样落库。
      { id: 'relay-b', contextWindow: 1000000, maxTokens: 384000, capabilities: ['native_web_search'] },
    ]);
  });

  it('prevents duplicate model tests and renders the backend duration field', async () => {
    const { context, registry, invoke } = buildHarness();
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    const testButton = registry.get('settings-custom-provider-detail-model-list')!.children[0].children[1].children[0];

    testButton.click();
    testButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke.mock.calls.filter(([channel]) => channel === 'customProviders.model.test')).toHaveLength(1);
    expect(registry.get('settings-custom-provider-modal-status')!.textContent).toContain('42 ms');
  });

  it('destroys the custom-provider modal contents and secret when it closes', () => {
    const { context, registry } = buildHarness();

    vm.runInContext('_settingsOpenCustomProviderModal()', context);
    const secret = registry.get('settings-custom-provider-api-key')!;
    secret.value = 'sk-ephemeral-secret';
    vm.runInContext("_settingsCloseModal(document.getElementById('settings-custom-provider-modal'))", context);

    expect(secret.value).toBe('');
    expect(registry.get('settings-custom-provider-modal-body')!.innerHTML).toBe('');
    expect(registry.get('settings-custom-provider-modal-actions')!.innerHTML).toBe('');
    expect(registry.get('settings-custom-provider-modal-status')!.textContent).toBe('');
  });

  it('does not reopen provider details when an async action finishes after the modal closed', async () => {
    const { context, registry, invoke } = buildHarness();
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    let resolveEnabled: (value: unknown) => void = () => undefined;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'customProviders.setEnabled') return new Promise((resolve) => { resolveEnabled = resolve; });
      if (channel === 'customProviders.list') return Promise.resolve({ ok: true, providers: [{ ...provider, enabled: false }] });
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      if (channel === 'auth.listEntries') return Promise.resolve({ ok: true, entries: [] });
      return Promise.resolve({ ok: true });
    });
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);

    const pending = vm.runInContext('_settingsSetCustomProviderEnabled(__provider, false)', context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    vm.runInContext("_settingsCloseModal(document.getElementById('settings-custom-provider-modal'))", context);
    resolveEnabled({ ok: true, enabled: false });
    await pending;

    expect(registry.get('settings-custom-provider-modal')!.classList.contains('open')).toBe(false);
    expect(registry.get('settings-custom-provider-modal-body')!.innerHTML).toBe('');
  });

  it('keeps a newly selected provider model list when an older request resolves last', async () => {
    const { context } = buildHarness();
    let resolveA: (value: unknown) => void = () => undefined;
    context.__providers = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];
    const setOptions = vi.fn();
    context.__pickerModelSel = { setOptions };
    context.__pickerProviderSel = { getValue: () => 'provider-b' };
    vm.runInContext(`
      _settingsState.providers = __providers;
      _settingsState.pickerModelSel = __pickerModelSel;
      _settingsState.pickerProviderSel = __pickerProviderSel;
    `, context);
    context.window.cogseed.invoke = vi.fn((channel: string, payload: { provider?: string }) => {
      if (channel !== 'auth.listModels') return Promise.resolve({ ok: true });
      if (payload.provider === 'provider-a') return new Promise((resolve) => { resolveA = resolve; });
      return Promise.resolve({ ok: true, models: [{ id: 'model-b', name: 'Model B' }] });
    });

    const older = vm.runInContext("_settingsPopulatePickerModel('provider-a', '')", context);
    const newer = vm.runInContext("_settingsPopulatePickerModel('provider-b', '')", context);
    await newer;
    resolveA({ ok: true, models: [{ id: 'model-a', name: 'Model A' }] });
    await older;

    const lastOptions = setOptions.mock.calls.at(-1)?.[0];
    expect(lastOptions).toEqual([{ value: 'model-b', label: 'Model B' }]);
  });

  it('filters disabled custom providers from the main picker and rejects stale selections', async () => {
    const { context, registry, invoke } = buildHarness();
    context.__providers = [
      { id: 'anthropic', label: 'Anthropic', providerKind: 'builtin', supportsApiKey: true },
      {
        id: 'cp:cp-disabled', label: 'Disabled Relay', providerKind: 'custom', enabled: false,
        profiles: [{ profileId: 'cp:cp-disabled' }],
      },
    ];
    vm.runInContext('_settingsState.providers = __providers', context);

    await vm.runInContext('_settingsRenderPicker()', context);
    const renderedOptions = Array.from(vm.runInContext('_settingsState.pickerProviderSel.state.options', context), (option: any) => option.value);
    // Disabled custom provider is filtered out; the two action rows remain.
    expect(renderedOptions).not.toContain('cp:cp-disabled');
    expect(renderedOptions).toContain('anthropic');
    expect(renderedOptions).toContain('__picker-action-custom-providers__');
    expect(renderedOptions).toContain('__picker-action-ccswitch-import__');

    context.__disabledProviderSel = { getValue: () => 'cp:cp-disabled' };
    context.__disabledModelSel = { getValue: () => 'disabled-model' };
    vm.runInContext(`
      _settingsState.pickerProviderSel = __disabledProviderSel;
      _settingsState.pickerModelSel = __disabledModelSel;
    `, context);
    await vm.runInContext('_settingsClickAddEntry()', context);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'auth.addEntry')).toHaveLength(0);
    expect(registry.get('settings-picker-status')!.textContent).toBe('settings.picker.error_provider_disabled');
  });

  it('keeps every model draft row to a single model-name input', () => {
    const { context, registry } = buildHarness();

    vm.runInContext('_settingsOpenCustomProviderModal()', context);
    const row = registry.get('settings-custom-provider-model-list')!.children[0];

    expect(row.querySelector('.settings-custom-provider-model-id')).toBeTruthy();
    expect(row.querySelector('.settings-custom-provider-model-context')).toBeNull();
    expect(row.querySelector('.settings-custom-provider-model-output')).toBeNull();
    expect(row.querySelector('.settings-custom-provider-model-draft-remove')).toBeTruthy();
  });

  it('redraws an open detail modal on language change but preserves an editing form', () => {
    const { context, registry, windowObj } = buildHarness();
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    const firstClose = registry.get('settings-custom-provider-modal-actions')!.children[0];
    windowObj.dispatchEvent({ type: 'i18n-change' });
    const translatedClose = registry.get('settings-custom-provider-modal-actions')!.children[0];
    expect(translatedClose).not.toBe(firstClose);

    vm.runInContext('_settingsOpenCustomProviderModal(__provider)', context);
    registry.get('settings-custom-provider-name')!.value = 'Unsaved name';
    registry.get('settings-custom-provider-api-key')!.value = 'sk-unsaved';
    windowObj.dispatchEvent({ type: 'i18n-change' });
    expect(registry.get('settings-custom-provider-name')!.value).toBe('Unsaved name');
    expect(registry.get('settings-custom-provider-api-key')!.value).toBe('sk-unsaved');
  });

  it('opens custom-provider management from an unavailable priority entry', async () => {
    const { context, registry } = buildHarness();
    context.__customProviders = [{
      id: 'cp-disabled', name: 'Disabled Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: false, apiKeyMasked: 'sk-***',
      models: [{ id: 'retired-model', contextWindow: 131072, maxTokens: 8192 }],
    }];
    context.__entries = [{
      entryId: 'entry-disabled', provider: 'cp:cp-disabled', providerLabel: 'Disabled Relay',
      providerKind: 'custom', model: 'retired-model', modelName: 'Retired model', modelAvailable: false,
      profileId: 'cp:cp-disabled', profileLabel: 'Disabled Relay', profileType: 'api_key', profileMasked: 'sk-***',
    }];
    vm.runInContext(`
      _settingsState.customProviders = __customProviders;
      _settingsState.entries = __entries;
    `, context);

    vm.runInContext('_settingsRenderEntries()', context);
    const row = registry.get('settings-entries')!.children[0];
    const actions = row.children.at(-1)!;
    const manageButton = actions.children.find((button) => button.title === 'settings.custom_providers.manage');
    expect(manageButton).toBeTruthy();
    await manageButton!.click();
    expect(registry.get('settings-custom-provider-modal')!.classList.contains('open')).toBe(true);
    // 详情卡标题改用中性文案（名称在卡片头部的「图标 + 名称」里，避免重复）
    expect(registry.get('settings-custom-provider-modal-title')!.textContent).toBe('settings.custom_providers.detail_title');
  });

  it('gives built-in preset rows a settings entry and writes a local window/output override', async () => {
    const { context, registry, invoke } = buildHarness();
    context.__entries = [{
      entryId: 'e-ds', provider: 'deepseek', providerLabel: 'DeepSeek', providerKind: 'builtin',
      model: 'deepseek-flash', modelName: 'DeepSeek Flash',
      profileId: 'deepseek:dp', profileLabel: 'dp', profileType: 'api_key',
    }];
    vm.runInContext('_settingsState.entries = __entries; _settingsRenderEntries();', context);

    // 内置行此前没有齿轮（预设不可见不可改）：现在必须有，且指向预设详情。
    const entryRow = registry.get('settings-entries')!.children[0];
    const presetGear = entryRow.querySelectorAll('.icon-btn')
      .find((button) => button.className.includes('settings-entry-preset-manage'));
    expect(presetGear).toBeTruthy();

    await presetGear!.click();
    expect(invoke).toHaveBeenCalledWith('modelOverrides.list', { provider: 'deepseek' });
    const list = registry.get('settings-preset-list')!;
    expect(list.children).toHaveLength(1);
    const presetRow = list.children[0];
    expect(presetRow.querySelector('.settings-preset-row-id')!.textContent).toBe('deepseek-flash');
    expect(presetRow.querySelector('.settings-preset-value')!.textContent)
      .toContain('settings.preset.column_preset');
    expect(presetRow.classList.contains('is-overridden')).toBe(false);

    // 行内覆盖：打开编辑器（字段带出当前生效值）→ 改窗口 → 保存
    const row = list.children[0];
    const overrideButton = row.querySelectorAll('.btn')[0];
    await overrideButton.click();
    const editor = row.querySelector('.settings-preset-editor');
    expect(editor).toBeTruthy();
    const inputs = editor!.querySelectorAll('.ui-input');
    expect(inputs.map((input) => input.value)).toEqual(['1000000', '384000']);

    inputs[0].value = '512000';
    inputs[1].value = '';
    const saveButton = editor!.querySelector('.settings-preset-save');
    expect(saveButton).toBeTruthy();
    await saveButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = invoke.mock.calls.find(([channel]) => channel === 'modelOverrides.set');
    expect(call).toBeTruthy();
    expect(call![1]).toEqual({ provider: 'deepseek', model: 'deepseek-flash', contextWindow: 512000, maxTokens: null });
    // 保存后刷新条目状态（列表/上下文分母跟着变）
    expect(invoke.mock.calls.filter(([channel]) => channel === 'auth.listEntries').length).toBeGreaterThan(0);
  });

  it('refuses an out-of-range or inverted override before hitting IPC', async () => {
    const { context, registry, invoke } = buildHarness();
    context.__entries = [{
      entryId: 'e-ds', provider: 'deepseek', providerLabel: 'DeepSeek', providerKind: 'builtin',
      model: 'deepseek-flash', modelName: 'DeepSeek Flash', profileId: 'deepseek:dp', profileLabel: 'dp', profileType: 'api_key',
    }];
    vm.runInContext('_settingsState.entries = __entries; _settingsRenderEntries();', context);
    await registry.get('settings-entries')!.children[0].querySelectorAll('.icon-btn')
      .find((button) => button.className.includes('settings-entry-preset-manage'))!.click();
    const row = registry.get('settings-preset-list')!.children[0];
    await row.querySelectorAll('.btn')[0].click();
    const editor = row.querySelector('.settings-preset-editor')!;
    const inputs = editor.querySelectorAll('.ui-input');
    const saveButton = () => editor.querySelector('.settings-preset-save')!;

    inputs[0].value = '0';
    await saveButton().click();
    expect(invoke.mock.calls.some(([channel]) => channel === 'modelOverrides.set')).toBe(false);

    inputs[0].value = '1000000';
    inputs[1].value = '2000000';   // 超过最大输出上限
    await saveButton().click();
    expect(invoke.mock.calls.some(([channel]) => channel === 'modelOverrides.set')).toBe(false);

    inputs[0].value = '256000';
    inputs[1].value = '384000';    // 输出 > 窗口
    await saveButton().click();
    expect(invoke.mock.calls.some(([channel]) => channel === 'modelOverrides.set')).toBe(false);
    expect(editor.querySelector('.settings-preset-editor-error')!.textContent).toBe('settings.preset.error_order');
  });

  it('edits provider fields in place (B2 即时提交): blur commits the changed field only', async () => {
    const { context, registry, invoke } = buildHarness();
    context.__provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***', models: [{ id: 'gpt-4.1-mini', contextWindow: 1000000, maxTokens: 384000 }],
    };
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);

    const baseUrl = registry.get('settings-custom-provider-detail-base-url')!;
    expect(baseUrl.value).toBe('https://relay.example/v1');
    // 非法 URL：就地报错，不发 IPC
    baseUrl.value = 'ftp://nope';
    await baseUrl.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke.mock.calls.some(([channel]) => channel === 'customProviders.update')).toBe(false);
    expect(baseUrl.closest('.settings-custom-provider-field')!.querySelector('.settings-custom-provider-field-msg')!.textContent)
      .toBe('settings.custom_providers.error_base_url');
    // 合法新值：提交时只带变更字段（部分更新）
    baseUrl.value = 'https://relay2.example/v1';
    await baseUrl.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = invoke.mock.calls.find(([channel]) => channel === 'customProviders.update');
    expect(call![1]).toEqual({ id: 'cp-1', baseUrl: 'https://relay2.example/v1' });
  });

  it('供应商详情卡不逐条标注必填/选填，必填语义仍在控件上（2026-09-14）', () => {
    const { context, registry } = buildHarness();
    context.__provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 1000000, maxTokens: 384000 }],
    };
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);

    const body = registry.get('settings-custom-provider-modal-body')!;
    // 四个字段都是必填（API Key 是"留空即不修改"），逐条标注是噪音 → 一个字都不渲染。
    expect(body.innerHTML).not.toContain('ui-field__requirement');
    expect(body.innerHTML).not.toContain('选填');
    expect(body.innerHTML).not.toContain('必填');
    // 去掉的只是标注，字段本身一个都不少。
    for (const id of [
      'settings-custom-provider-detail-name',
      'settings-custom-provider-detail-base-url',
      'settings-custom-provider-detail-protocol',
      'settings-custom-provider-detail-api-key',
    ]) {
      expect(body.querySelector('#' + id), id).toBeTruthy();
    }
  });

  it('新建供应商：必填项为空就不让保存（不发 IPC，就地报错，2026-09-14）', async () => {
    const { context, registry, invoke } = buildHarness();
    const g = context as any;
    g._settingsOpenCustomProviderModal();

    const body = registry.get('settings-custom-provider-modal-body')!;
    const status = registry.get('settings-custom-provider-modal-status')!;
    const saveBtn = registry.get('settings-custom-provider-modal-actions')!.children[1] as any;
    const addCalls = () => invoke.mock.calls.filter(([channel]: any[]) => channel === 'customProviders.add');

    // 空表单 → 卡在名称
    await saveBtn.click();
    expect(addCalls()).toHaveLength(0);
    expect(status.textContent).toBe('settings.custom_providers.error_name');

    // 有名称、没有合法 Base URL → 卡在地址
    (body.querySelector('#settings-custom-provider-name') as any).value = 'Relay';
    await saveBtn.click();
    expect(addCalls()).toHaveLength(0);
    expect(status.textContent).toBe('settings.custom_providers.error_base_url');

    // 名称 + 合法地址、没有 API Key（新建时必填）→ 卡在 key
    (body.querySelector('#settings-custom-provider-base-url') as any).value = 'https://relay.example/v1';
    await saveBtn.click();
    expect(addCalls()).toHaveLength(0);
    expect(status.textContent).toBe('settings.custom_providers.error_api_key');
  });

  it('renders compact model badges and a per-model switch that confirms before disabling a bound model', async () => {
    const { context, registry, invoke } = buildHarness();
    context.__provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{
        id: 'gpt-4.1-mini', contextWindow: 1000000, maxTokens: 384000,
        input: ['text', 'image'], reasoningLevels: ['low', 'high'],
      }],
    };
    context.__entries = [{ entryId: 'e-1', provider: 'cp:cp-1', model: 'gpt-4.1-mini', profileId: 'cp:cp-1' }];
    vm.runInContext('_settingsState.entries = __entries; _settingsOpenCustomProviderDetails(__provider)', context);

    const row = registry.get('settings-custom-provider-detail-model-list')!.children[0];
    expect(Array.from(row.querySelectorAll('.settings-custom-provider-model-badge'), (el: any) => el.textContent))
      .toEqual(['1M', '384K', 'settings.custom_providers.badge_vision', 'settings.custom_providers.badge_reasoning']);

    const toggleLabel = row.querySelector('.settings-custom-provider-model-toggle')!;
    const toggle = toggleLabel.children[0] as any;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    await toggle.dispatch('change');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 有绑定条目 → 先确认（把副作用讲在动手之前）
    expect(context.uiConfirm).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('customProviders.model.setEnabled', {
      providerId: 'cp-1', modelId: 'gpt-4.1-mini', enabled: false,
    });
  });

  it('rolls the model switch back and reports when the toggle write fails', async () => {
    const { context, registry, invoke } = buildHarness();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'customProviders.model.setEnabled') return { ok: false, error: 'boom' };
      if (channel === 'customProviders.list') return { ok: true, providers: [] };
      return { ok: true };
    });
    context.__provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***', models: [{ id: 'gpt-4.1-mini', contextWindow: 1000000, maxTokens: 384000 }],
    };
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    const row = registry.get('settings-custom-provider-detail-model-list')!.children[0];
    const toggle = row.querySelector('.settings-custom-provider-model-toggle')!.children[0] as any;
    toggle.checked = false;
    await toggle.dispatch('change');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 失败回滚到原状态 + 弹窗状态行报错
    expect(toggle.checked).toBe(true);
    expect(registry.get('settings-custom-provider-modal-status')!.textContent).toBe('boom');
  });

  it('reloads includeUnavailable entries after reordering instead of trusting the filtered response', async () => {
    const { context, registry, invoke } = buildHarness();
    const entry = (id: string, model: string) => ({
      entryId: id, provider: 'anthropic', providerLabel: 'Anthropic', model, modelName: model,
      modelAvailable: true, profileId: 'profile-1', profileLabel: 'Primary', profileType: 'api_key',
    });
    const first = entry('entry-1', 'model-1');
    const second = entry('entry-2', 'model-2');
    context.__entries = [first, second];
    context.__providers = [{ id: 'anthropic', label: 'Anthropic', providerKind: 'builtin' }];
    vm.runInContext(`
      _settingsState.entries = __entries;
      _settingsState.providers = __providers;
    `, context);
    invoke.mockImplementation((channel: string, payload?: unknown) => {
      if (channel === 'auth.reorderEntries') return Promise.resolve({ ok: true, entries: [first] });
      if (channel === 'auth.listEntries') return Promise.resolve({ ok: true, entries: [second, first] });
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: context.__providers });
      if (channel === 'auth.listModels') return Promise.resolve({ ok: true, models: [] });
      if (channel === 'customProviders.list') return Promise.resolve({ ok: true, providers: [] });
      return Promise.resolve({ ok: true });
    });

    vm.runInContext('_settingsRenderEntries()', context);
    const [firstRow, secondRow] = registry.get('settings-entries')!.children;
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    await secondRow.dispatch('dragstart', { dataTransfer });
    await firstRow.dispatch('drop', { dataTransfer, clientY: 0, preventDefault: vi.fn() });

    expect(invoke).toHaveBeenCalledWith('auth.listEntries', { includeUnavailable: true });
    expect(Array.from(vm.runInContext('_settingsState.entries', context), (item: any) => item.entryId)).toEqual(['entry-2', 'entry-1']);
  });

  it('sets and restores the concrete action button busy state', async () => {
    const { context, registry, invoke } = buildHarness();
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    let resolveTest: (value: unknown) => void = () => undefined;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'customProviders.model.test') return new Promise((resolve) => { resolveTest = resolve; });
      return Promise.resolve({ ok: true });
    });
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderDetails(__provider)', context);
    const testButton = registry.get('settings-custom-provider-detail-model-list')!.children[0].children[1].children[0];

    const pending = testButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(testButton.disabled).toBe(true);
    expect(testButton.classList.contains('is-busy')).toBe(true);
    resolveTest({ ok: true, durationMs: 42 });
    await pending;
    expect(testButton.disabled).toBe(false);
    expect(testButton.classList.contains('is-busy')).toBe(false);
  });

  it('keeps the replacement save button disabled when i18n redraws a pending form', async () => {
    const { context, registry, invoke, windowObj } = buildHarness();
    const provider = {
      id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1',
      enabled: true, apiKeyMasked: 'sk-***',
      models: [{ id: 'gpt-4.1-mini', contextWindow: 131072, maxTokens: 8192 }],
    };
    let resolveUpdate: (value: unknown) => void = () => undefined;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'customProviders.update') return new Promise((resolve) => { resolveUpdate = resolve; });
      return Promise.resolve({ ok: true });
    });
    context.__provider = provider;
    vm.runInContext('_settingsOpenCustomProviderModal(__provider)', context);
    const firstSave = registry.get('settings-custom-provider-modal-actions')!.children[1];

    const pending = firstSave.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    windowObj.dispatchEvent({ type: 'i18n-change' });
    const replacementSave = registry.get('settings-custom-provider-modal-actions')!.children[1];

    expect(replacementSave).not.toBe(firstSave);
    expect(replacementSave.disabled).toBe(true);
    resolveUpdate({ ok: true });
    await pending;
    expect(invoke.mock.calls.filter(([channel]) => channel === 'customProviders.update')).toHaveLength(1);
  });

  it('does not let an older provider save unlock a newer provider form', async () => {
    const { context, registry, invoke } = buildHarness();
    const providerA = {
      id: 'cp-a', name: 'Relay A', protocol: 'openai', baseUrl: 'https://a.example/v1',
      enabled: true, apiKeyMasked: 'sk-***', models: [{ id: 'model-a', contextWindow: 131072, maxTokens: 8192 }],
    };
    const providerB = {
      id: 'cp-b', name: 'Relay B', protocol: 'openai', baseUrl: 'https://b.example/v1',
      enabled: true, apiKeyMasked: 'sk-***', models: [{ id: 'model-b', contextWindow: 131072, maxTokens: 8192 }],
    };
    const pendingUpdates = new Map<string, (value: unknown) => void>();
    invoke.mockImplementation((channel: string, payload?: { id?: string }) => {
      if (channel === 'customProviders.update') {
        return new Promise((resolve) => pendingUpdates.set(String(payload?.id), resolve));
      }
      return Promise.resolve({ ok: true });
    });
    context.__providerA = providerA;
    context.__providerB = providerB;

    vm.runInContext('_settingsOpenCustomProviderModal(__providerA)', context);
    const saveA = registry.get('settings-custom-provider-modal-actions')!.children[1];
    const requestA = saveA.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    vm.runInContext('_settingsOpenCustomProviderModal(__providerB)', context);
    const saveB = registry.get('settings-custom-provider-modal-actions')!.children[1];
    const requestB = saveB.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveB.disabled).toBe(true);

    pendingUpdates.get('cp-a')!({ ok: false, error: 'A failed' });
    await requestA;
    expect(saveB.disabled).toBe(true);

    pendingUpdates.get('cp-b')!({ ok: false, error: 'B failed' });
    await requestB;
    expect(saveB.disabled).toBe(false);
  });
});
