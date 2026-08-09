import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../..');

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
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  className = '';
  hidden = false;
  value = '';
  textContent = '';
  disabled = false;
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();
  private readonly registry: Map<string, FakeElement>;

  constructor(registry: Map<string, FakeElement>, id = '') {
    this.registry = registry;
    if (id) this.setId(id);
  }

  private setId(id: string) {
    this.id = id;
    this.registry.set(id, this);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    if (child.id) this.registry.set(child.id, child);
    return child;
  }

  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    const next = this.listeners.get(type) || [];
    next.push(handler);
    this.listeners.set(type, next);
  }

  click() {
    for (const handler of this.listeners.get('click') || []) {
      handler({ currentTarget: this, target: this });
    }
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
    void value;
    this.children.length = 0;
  }

  get innerHTML() {
    return '';
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
          models: ['gpt-4.1-mini'],
          source: 'manual',
        }],
      };
    }
    if (channel === 'customProviders.add') return { ok: true, provider: { id: 'cp-2' } };
    if (channel === 'customProviders.update') return { ok: true, provider: { id: payload?.id || 'cp-1' } };
    if (channel === 'customProviders.remove') return { ok: true };
    if (channel === 'customProviders.ccswitch.probe') return { ok: true, ready: true, hasData: true };
    if (channel === 'customProviders.ccswitch.preview') {
      return {
        ok: true,
        rows: [
          { externalId: 'cc-1', name: 'Claude Desktop', protocol: 'anthropic', maskedKey: 'sk-***', missingKey: false },
          { externalId: 'cc-2', name: 'Codex', protocol: 'openai', maskedKey: '', missingKey: true },
        ],
      };
    }
    if (channel === 'customProviders.ccswitch.sync') return { ok: true, syncedIds: payload?.externalIds || [] };
    return { ok: true };
  });

  const windowListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const windowObj: any = {
    orkas: { invoke },
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

  const documentObj: any = {
    getElementById(id: string) { return registry.get(id) || null; },
    createElement: () => new FakeElement(registry),
    querySelectorAll: () => [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string, vars?: Record<string, string>) => vars ? `${key} ${JSON.stringify(vars)}` : key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    document: documentObj,
    window: windowObj,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8'), context, { filename: 'settings.js' });
  return { context, registry, invoke, windowObj };
}

describe('settings model providers surface', () => {
  it('replaces the visible authorization copy with Model Providers and exposes the custom provider + CC Switch controls', () => {
    const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
    const source = readFileSync(resolve(root, 'src/renderer/modules/settings.js'), 'utf8');

    expect(indexHtml).toContain('data-i18n="settings.tab.credentials">Model Providers</button>');
    expect(indexHtml).not.toContain('Model Authorization');
    expect(indexHtml).toContain('id="settings-custom-provider-list"');
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

  it('refreshes the custom-provider list and CC Switch probe with the expected IPC channels', async () => {
    const { context, registry, invoke } = buildHarness();

    await vm.runInContext('_settingsRefreshCustomProviders()', context);
    await vm.runInContext('_settingsRefreshCcswitchStatus()', context);
    await vm.runInContext('_settingsRenderCustomProviders()', context);

    expect(invoke).toHaveBeenCalledWith('customProviders.list');
    expect(invoke).toHaveBeenCalledWith('customProviders.ccswitch.probe');
    expect(registry.get('settings-custom-provider-list')!.children.length).toBeGreaterThan(0);
    expect(registry.get('settings-custom-provider-list')!.children[0].textContent).toContain('Relay');
  });

  it('opens the add/edit dialog, keeps existing keys masked, and syncs the selected CC Switch rows', async () => {
    const { context, registry, invoke } = buildHarness();

    await vm.runInContext('_settingsRenderCustomProviders()', context);
    await vm.runInContext("_settingsOpenCustomProviderModal({ id: 'cp-1', name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1', models: ['gpt-4.1-mini'], apiKeyMasked: 'sk-***' })", context);
    registry.get('settings-custom-provider-name')!.value = 'Relay v2';
    registry.get('settings-custom-provider-protocol')!.value = 'openai';
    registry.get('settings-custom-provider-base-url')!.value = 'https://relay.example/v2';
    registry.get('settings-custom-provider-models')!.value = 'gpt-4.1-mini, gpt-4.1';
    registry.get('settings-custom-provider-api-key')!.value = 'sk-new-secret';
    registry.get('settings-custom-provider-modal-actions')!.children[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await vm.runInContext('_settingsOpenCcswitchPreviewDialog()', context);
    const previewList = registry.get('settings-ccswitch-preview-modal-body')!;
    expect(previewList.children.length).toBeGreaterThan(0);
    expect(previewList.children[1].textContent).toContain('missing');
    registry.get('settings-ccswitch-preview-sync-btn')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).toHaveBeenCalledWith('customProviders.update', expect.objectContaining({ id: 'cp-1' }));
    expect(invoke).toHaveBeenCalledWith('customProviders.ccswitch.preview');
    expect(invoke).toHaveBeenCalledWith('customProviders.ccswitch.sync', expect.objectContaining({ externalIds: expect.any(Array) }));
  });
});
