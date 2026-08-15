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
    const visit = (el: FakeElement) => {
      if (selector.startsWith('#') && el.id === selector.slice(1)) out.push(el);
      if (selector.startsWith('.') && el.className.split(/\s+/).includes(selector.slice(1))) out.push(el);
      for (const child of el.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return out;
  }

  set innerHTML(value: string) {
    this.html = value;
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    const tagPattern = /<([a-z0-9-]+)\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(value))) {
      const attrs = match[2];
      const id = attrs.match(/\bid="([^"]+)"/)?.[1] || '';
      const className = attrs.match(/\bclass="([^"]+)"/)?.[1] || '';
      if (!id && !className) continue;
      const child = new FakeElement(this.registry, id, match[1]);
      child.className = className;
      child.type = attrs.match(/\btype="([^"]+)"/)?.[1] || '';
      child.value = attrs.match(/\bvalue="([^"]*)"/)?.[1] || '';
      child.placeholder = attrs.match(/\bplaceholder="([^"]*)"/)?.[1] || '';
      for (const dataMatch of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/gi)) {
        child.dataset[dataMatch[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = dataMatch[2];
      }
      this.appendChild(child);
    }
  }

  get innerHTML() {
    return this.html;
  }

  getBoundingClientRect() {
    return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
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
    'settings-custom-provider-name',
    'settings-custom-provider-protocol',
    'settings-custom-provider-base-url',
    'settings-custom-provider-api-key',
    'settings-custom-provider-models',
    'settings-custom-provider-model-list',
    'settings-custom-provider-add-model',
    'settings-custom-provider-detail-actions',
    'settings-custom-provider-detail-add-model',
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
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8'), context, { filename: 'settings.js' });
  return { context, registry, invoke, windowObj, documentListeners, aiSelectMount };
}

describe('settings model providers surface', () => {
  it('replaces the visible authorization copy with Model Providers and exposes the custom provider + CC Switch controls', () => {
    const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
    const source = readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8');

    expect(indexHtml).toContain('data-i18n="settings.tab.credentials">Model Providers</button>');
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
    ]) expect(style).toContain(selector);
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
        { id: 'deepseek-v4-flash', contextWindow: 131072, maxTokens: 8192 },
        { id: 'deepseek-v4-pro', contextWindow: 131072, maxTokens: 8192 },
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
    const actionButtons = detailList.children[0].children[1].children;
    expect(actionButtons).toHaveLength(3);
    for (const button of actionButtons) {
      expect(button.innerHTML).not.toContain('<span>');
      expect(button.title).toBeTruthy();
    }

    vm.runInContext('_settingsOpenCustomProviderModal(__provider)', context);
    vm.runInContext('_settingsOpenCustomProviderModelEditor(__provider, __provider.models[0])', context);
    expect(documentListeners.get('keydown')).toHaveLength(1);
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
    expect(registry.get('settings-custom-provider-modal-title')!.textContent).toBe('Disabled Relay');
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
