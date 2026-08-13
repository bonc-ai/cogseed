import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../..');
const indexHtml = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));
const style = readFileSync(resolve(root, 'src/renderer/style.css'), 'utf8');
const locales = ['en', 'zh', 'ja', 'pt'].map((lang) => [lang, JSON.parse(readFileSync(resolve(root, `src/renderer/locales/${lang}.json`), 'utf8'))] as const);

function modelAuthorizationKeys(locale: Record<string, unknown>): string[] {
  return Object.keys(locale).filter((key) => key.startsWith('settings.model_authorization.')).sort();
}

describe('unified model authorization settings surface', () => {
  it('declares one primary authorization surface and one wizard modal', () => {
    for (const id of [
      'settings-model-authorizations',
      'settings-model-authorization-add-btn',
      'settings-model-authorization-advanced-btn',
      'settings-model-authorization-list',
      'model-authorization-modal',
      'model-authorization-steps',
      'model-authorization-body',
      'model-authorization-status',
      'model-authorization-actions',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
  });

  it('removes old primary provider picker and standalone CC Switch entry controls', () => {
    expect(indexHtml).not.toContain('id="settings-picker-provider"');
    expect(indexHtml).not.toContain('id="settings-picker-model"');
    expect(indexHtml).not.toContain('id="settings-ccswitch-preview-btn"');
    expect(indexHtml).not.toContain('id="settings-add-entry-btn"');
  });

  it('replaces the legacy interface-type hint with a concise flow subtitle', () => {
    // The old two-line hint described the protocol-first flow (choose an
    // interface type, enter key and URL). The preset-first flow keeps a
    // single concise subtitle; the hint line must not resurface.
    expect(indexHtml).toContain('data-i18n="settings.model_authorization.subtitle"');
    expect(indexHtml).not.toContain('data-i18n="settings.model_authorization.api_key_flow_hint"');
  });

  it('labels advanced management as custom endpoint management and explains its scope', () => {
    expect(indexHtml).toContain('data-i18n="settings.model_authorization.advanced"');
    expect(indexHtml).toContain('id="settings-model-authorization-advanced-hint"');
    expect(indexHtml).toContain('data-i18n="settings.model_authorization.advanced_hint"');
  });

  it('keeps advanced custom provider management collapsed away from the primary flow', () => {
    expect(indexHtml).toContain('id="settings-model-authorization-advanced"');
    expect(indexHtml).toMatch(/id="settings-model-authorization-advanced"[^>]*hidden/);
    expect(indexHtml).toContain('id="settings-custom-provider-add-btn"');
    const primaryStart = indexHtml.indexOf('id="settings-model-authorizations"');
    const advancedStart = indexHtml.indexOf('id="settings-model-authorization-advanced"');
    const addProviderStart = indexHtml.indexOf('id="settings-custom-provider-add-btn"');
    expect(primaryStart).toBeGreaterThan(-1);
    expect(advancedStart).toBeGreaterThan(primaryStart);
    expect(addProviderStart).toBeGreaterThan(advancedStart);
  });

  it('adds scoped styles for authorization cards and wizard controls', () => {
    for (const selector of [
      '.model-authorization-card',
      '.model-authorization-steps',
      '.model-authorization-choice-grid',
      '.model-authorization-model-list',
      '.model-authorization-warning',
    ]) {
      expect(style).toContain(selector);
    }
  });

  it('keeps four locale files aligned for model authorization strings', () => {
    const [baseLang, baseLocale] = locales[0];
    const baseKeys = modelAuthorizationKeys(baseLocale);
    expect(baseKeys.length).toBeGreaterThan(20);
    for (const [lang, locale] of locales.slice(1)) {
      expect(modelAuthorizationKeys(locale), `${lang} differs from ${baseLang}`).toEqual(baseKeys);
    }
  });
});

class FakeClassList {
  private values = new Set<string>();
  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
  toggle(name: string, force?: boolean) { const next = force === undefined ? !this.values.has(name) : force; next ? this.values.add(name) : this.values.delete(name); return next; }
}

class FakeElement {
  id = '';
  className = '';
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  private html = '';
  private listeners = new Map<string, Array<(event: any) => unknown>>();
  constructor(private registry: Map<string, FakeElement>, id = '') { if (id) this.setId(id); }
  private setId(id: string) { this.id = id; this.registry.set(id, this); }
  set innerHTML(value: string) {
    this.html = String(value || '');
    const idRe = /<([a-z0-9-]+)\b([^>]*)\bid="([^"]+)"([^>]*)>/gi;
    let match: RegExpExecArray | null;
    while ((match = idRe.exec(this.html))) {
      const attrs = `${match[2]} ${match[4]}`;
      const child = new FakeElement(this.registry, match[3]);
      const classMatch = attrs.match(/class="([^"]+)"/);
      if (classMatch) child.className = classMatch[1];
      for (const dataMatch of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/gi)) {
        const key = dataMatch[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        child.dataset[key] = dataMatch[2];
      }
      if (/\bdisabled\b/.test(attrs)) child.disabled = true;
    }
  }
  get innerHTML() { return this.html; }
  addEventListener(type: string, handler: (event: any) => unknown) { const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list); }
  async dispatch(type: string, event: any = {}) { for (const handler of this.listeners.get(type) || []) await handler({ currentTarget: this, target: this, ...event }); }
  async click(event: any = {}) { await this.dispatch('click', event); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
}

function loadInteractiveHarness() {
  const registry = new Map<string, FakeElement>();
  for (const id of [
    'settings-model-authorization-add-btn', 'settings-model-authorization-advanced-btn',
    'settings-model-authorization-advanced', 'settings-model-authorization-list',
    'settings-model-authorization-status',
    'model-authorization-modal', 'model-authorization-close-btn', 'model-authorization-steps',
    'model-authorization-body', 'model-authorization-status', 'model-authorization-actions',
  ]) registry.set(id, new FakeElement(registry, id));
  registry.get('settings-model-authorization-advanced')!.hidden = true;
  const windowListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  let discoverResolvers: Array<(value: any) => void> = [];
  const invoke = vi.fn((channel: string, payload?: any) => {
    if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [] });
    if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [
      { id: 'openai-codex', label: 'OpenAI Codex', providerKind: 'builtin', supportsOAuth: true, supportsApiKey: false },
      { id: 'openai-compatible', label: 'OpenAI Compatible', providerKind: 'builtin', supportsOAuth: false, supportsApiKey: true, manualModel: true },
      { id: 'anthropic', label: 'Anthropic', providerKind: 'builtin', supportsOAuth: false, supportsApiKey: true },
      {
        id: 'cp:custom-relay', label: 'Custom Relay', providerKind: 'custom',
        supportsOAuth: false, supportsApiKey: true, manualModel: false,
        profiles: [{ profileId: 'cp:custom-relay' }],
      },
    ] });
    if (channel === 'auth.startOAuth') return Promise.resolve({ ok: true, kind: 'done', profileId: `${payload.provider}:profile` });
    if (channel === 'customProviders.ccswitch.preview') return Promise.resolve({ ok: true, items: [
      { externalId: 'cc-1', name: 'Claude Desktop', protocol: 'anthropic', apiKeyMasked: 'sk-***', models: ['claude-3-5-sonnet'], needsKey: false },
    ], unsupported: [
      { externalId: 'cc-needs-key', name: 'Needs key', reason: 'missing_api_key' },
      { externalId: 'hermes:1', name: 'DeepSeek', reason: 'unsupported_protocol' },
    ] });
    if (channel === 'modelAuthorizations.prepareCcSwitch') return Promise.resolve({ ok: true, draft: { draftId: 'draft-cc-1', externalId: payload.externalId, declaredModels: ['claude-3-5-sonnet'], maskedKey: 'sk-***' } });
    if (channel === 'modelAuthorizations.discover') return new Promise((resolve) => discoverResolvers.push(resolve));
    if (channel === 'modelAuthorizations.testDraft') return Promise.resolve({ ok: true });
    if (channel === 'modelAuthorizations.complete') return Promise.resolve({ ok: true, authorizationId: 'auth-1' });
    return Promise.resolve({ ok: true });
  });
  const windowObj: any = {
    cogseed: { invoke },
    addEventListener(type: string, handler: (...args: any[]) => unknown) { const list = windowListeners.get(type) || []; list.push(handler); windowListeners.set(type, list); },
  };
  const refreshModelGuard = vi.fn(async () => true);
  const context: any = {
    window: windowObj,
    refreshModelGuard,
    document: {
      getElementById: (id: string) => registry.get(id) || null,
      addEventListener: vi.fn(),
    },
    t: (key: string, vars?: any) => vars && typeof vars.count !== 'undefined' ? `${key}:${vars.count}` : key,
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"]/g, ''),
    uiConfirm: vi.fn(async () => true),
    setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(root, 'src/renderer/modules/model-authorization.js'), 'utf8'), context, { filename: 'model-authorization.js' });
  return { context, registry, invoke, discoverResolvers, windowListeners, refreshModelGuard };
}

async function enterManualBuiltinModels(harness: ReturnType<typeof loadInteractiveHarness>) {
  const { context, registry, discoverResolvers } = harness;
  await context.window.initModelAuthorizationSettings();
  await registry.get('settings-model-authorization-add-btn')!.click();
  await registry.get('model-authorization-body')!.dispatch('click', {
    target: { dataset: { modelAuthAction: 'source-manual' } },
  });
  await registry.get('model-authorization-body')!.dispatch('click', {
    target: { dataset: { modelAuthAction: 'choose-provider-preset', providerId: 'anthropic' } },
  });
  registry.get('model-authorization-api-key')!.value = 'sk-private-test-value';
  const pending = registry.get('model-authorization-actions')!.dispatch('click', {
    target: { dataset: { modelAuthAction: 'continue-credentials' } },
  });
  await flushAsync();
  discoverResolvers.shift()!({ ok: true, models: [{ id: 'claude-test' }] });
  await pending;
  return registry.get('model-authorization-body')!;
}

describe('model authorization interactive wizard', () => {
  it('renders a localized model-selection warning for an unbound authorization', async () => {
    const { context, registry, invoke } = loadInteractiveHarness();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'modelAuthorizations.list') {
        return Promise.resolve({ ok: true, authorizations: [
          {
            authorizationId: 'profile:deepseek:default',
            label: 'default',
            authType: 'api_key',
            source: 'manual',
            unbound: true,
            warningCode: 'unbound_authorization',
            models: [],
          },
          {
            authorizationId: 'profile:deepseek:active',
            label: 'active',
            authType: 'api_key',
            source: 'manual',
            unbound: false,
            models: [{ entryId: 'entry-1', model: 'deepseek-v4-flash', default: true }],
          },
        ] });
      }
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      return Promise.resolve({ ok: true });
    });

    await context.window.initModelAuthorizationSettings();

    const cards = registry.get('settings-model-authorization-list')!.innerHTML;
    expect(cards).toContain('settings.model_authorization.unbound_title');
    expect(cards).not.toContain('unbound_authorization');
    expect(cards).toContain('deepseek-v4-flash');
  });

  it('keeps an authorization card when removal is not confirmed', async () => {
    const { context, registry, invoke } = loadInteractiveHarness();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [{
        authorizationId: 'profile:deepseek:broken', label: 'broken', authType: 'api_key', source: 'manual', unbound: true, models: [],
      }] });
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      return Promise.resolve({ ok: true });
    });
    context.uiConfirm.mockResolvedValue(false);

    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-list')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'remove-authorization', authorizationId: 'profile:deepseek:broken' } },
    });

    expect(context.uiConfirm).toHaveBeenCalledWith('settings.model_authorization.confirm_remove_authorization');
    expect(invoke).not.toHaveBeenCalledWith('modelAuthorizations.remove', expect.anything());
    expect(registry.get('settings-model-authorization-list')!.innerHTML).toContain('broken');
  });

  it('removes a confirmed authorization and refreshes model settings', async () => {
    const { context, registry, invoke, refreshModelGuard } = loadInteractiveHarness();
    let listed = true;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: listed ? [{
        authorizationId: 'profile:deepseek:broken', label: 'broken', authType: 'api_key', source: 'manual', unbound: true, models: [],
      }] : [] });
      if (channel === 'modelAuthorizations.remove') {
        listed = false;
        return Promise.resolve({ ok: true, removed: true });
      }
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      return Promise.resolve({ ok: true });
    });

    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-list')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'remove-authorization', authorizationId: 'profile:deepseek:broken' } },
    });

    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.remove', { authorizationId: 'profile:deepseek:broken' });
    expect(registry.get('settings-model-authorization-list')!.innerHTML).toContain('settings.entries.empty');
    expect(refreshModelGuard).toHaveBeenCalledOnce();
  });

  it('reports a failed authorization removal without clearing the card', async () => {
    const { context, registry, invoke, refreshModelGuard } = loadInteractiveHarness();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [{
        authorizationId: 'profile:deepseek:broken', label: 'broken', authType: 'api_key', source: 'manual', unbound: true, models: [],
      }] });
      if (channel === 'modelAuthorizations.remove') return Promise.resolve({ ok: false, error: 'removal failed' });
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      return Promise.resolve({ ok: true });
    });

    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-list')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'remove-authorization', authorizationId: 'profile:deepseek:broken' } },
    });

    expect(registry.get('settings-model-authorization-status')!.textContent).toBe('removal failed');
    expect(registry.get('settings-model-authorization-list')!.innerHTML).toContain('broken');
    expect(refreshModelGuard).not.toHaveBeenCalled();
  });

  it('opens at API key source selection without an OAuth account route, expands advanced management, and ignores IME enter handlers', async () => {
    const { context, registry } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    expect(registry.get('model-authorization-modal')!.classList.contains('open')).toBe(true);
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('choose-oauth');
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('source-manual');
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('source-ccswitch');
    await registry.get('settings-model-authorization-advanced-btn')!.click();
    expect(registry.get('settings-model-authorization-advanced')!.hidden).toBe(false);
    await registry.get('model-authorization-body')!.dispatch('keydown', { key: 'Enter', isComposing: true, keyCode: 229, preventDefault: vi.fn() });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('source-manual');
  });

  it('keeps saved custom providers out of builtin presets while preserving the custom endpoint entry', async () => {
    const { context, registry } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-manual' } },
    });

    const bodyHtml = registry.get('model-authorization-body')!.innerHTML;
    expect(bodyHtml).not.toContain('data-provider-id="cp:custom-relay"');
    expect(bodyHtml).not.toContain('Custom Relay');
    expect(bodyHtml).toContain('choose-custom-endpoint');
  });

  it('renders an empty builtin catalog without hiding the custom endpoint entry', async () => {
    const { context, registry, invoke } = loadInteractiveHarness();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [] });
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      return Promise.resolve({ ok: true });
    });

    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-manual' } },
    });

    const bodyHtml = registry.get('model-authorization-body')!.innerHTML;
    expect(bodyHtml).toContain('choose-custom-endpoint');
    expect(bodyHtml).toContain('settings.model_authorization.providers_empty');
  });

  it('recovers when provider loading rejects and keeps retry plus custom endpoint available', async () => {
    const { context, registry, invoke } = loadInteractiveHarness();
    invoke.mockRejectedValueOnce(new Error('provider loader secret detail'));

    await expect(context.window.initModelAuthorizationSettings()).resolves.toBeUndefined();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-manual' } },
    });

    const bodyHtml = registry.get('model-authorization-body')!.innerHTML;
    expect(bodyHtml).toContain('retry-providers');
    expect(bodyHtml).toContain('choose-custom-endpoint');
    expect(bodyHtml).toContain('settings.model_authorization.providers_load_failed');
    expect(bodyHtml).not.toContain('provider loader secret detail');
  });

  it('recovers when CC Switch preview or preparation rejects', async () => {
    const previewHarness = loadInteractiveHarness();
    await previewHarness.context.window.initModelAuthorizationSettings();
    await previewHarness.registry.get('settings-model-authorization-add-btn')!.click();
    previewHarness.invoke.mockRejectedValueOnce(new Error('preview failure'));
    await expect(previewHarness.registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-ccswitch' } },
    })).resolves.toBeUndefined();
    expect(previewHarness.registry.get('model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.ccswitch_load_failed');
    expect(previewHarness.registry.get('model-authorization-body')!.innerHTML).toContain('ccswitch_preview_empty');

    const prepareHarness = loadInteractiveHarness();
    await prepareHarness.context.window.initModelAuthorizationSettings();
    await prepareHarness.registry.get('settings-model-authorization-add-btn')!.click();
    await prepareHarness.registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-ccswitch' } },
    });
    prepareHarness.invoke.mockRejectedValueOnce(new Error('prepare failure'));
    await expect(prepareHarness.registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'select-ccswitch', externalId: 'cc-1' } },
    })).resolves.toBeUndefined();
    expect(prepareHarness.registry.get('model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.ccswitch_load_failed');
    expect(prepareHarness.registry.get('model-authorization-body')!.innerHTML).toContain('cc-1');
  });

  it('requires CC Switch reselection when the draft expires during discovery', async () => {
    const { context, registry, invoke } = loadInteractiveHarness();
    invoke.mockImplementation((channel: string, payload?: any) => {
      if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [] });
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      if (channel === 'customProviders.ccswitch.preview') return Promise.resolve({ ok: true, items: [{
        externalId: 'cc-1', name: 'CC entry', protocol: 'anthropic', apiKeyMasked: 'sk-***', models: ['a'],
      }] });
      if (channel === 'modelAuthorizations.prepareCcSwitch') return Promise.resolve({
        ok: true, draft: { draftId: 'expired-draft', externalId: payload.externalId, maskedKey: 'sk-***' },
      });
      if (channel === 'modelAuthorizations.discover') return Promise.resolve({ ok: false, errorCode: 'draft_expired' });
      return Promise.resolve({ ok: true });
    });

    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-ccswitch' } },
    });
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'select-ccswitch', externalId: 'cc-1' } },
    });

    expect(registry.get('model-authorization-body')!.innerHTML).toContain('cc-1');
    expect(registry.get('model-authorization-actions')!.innerHTML).toContain('model-auth-action="back"');
    expect(registry.get('model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.ccswitch_draft_expired');
  });

  it('requires CC Switch reselection when the draft expires between test and completion', async () => {
    const { context, registry, invoke, discoverResolvers } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-ccswitch' } },
    });
    const selecting = registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'select-ccswitch', externalId: 'cc-1' } },
    });
    await flushAsync();
    discoverResolvers.shift()!({ ok: true, models: [{ id: 'claude-test' }], declaredModels: ['claude-test'] });
    await selecting;
    invoke.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, errorCode: 'draft_not_found' });

    await registry.get('model-authorization-actions')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'complete' } },
    });

    expect(registry.get('model-authorization-modal')!.classList.contains('open')).toBe(true);
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('cc-1');
    expect(registry.get('model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.ccswitch_draft_expired');
  });

  it('restores credentials when discovery rejects without rendering the API key', async () => {
    const { context, registry, invoke } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'source-manual' } },
    });
    await registry.get('model-authorization-body')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'choose-provider-preset', providerId: 'anthropic' } },
    });
    registry.get('model-authorization-api-key')!.value = 'sk-never-render-this';
    invoke.mockRejectedValueOnce(new Error('discover failure'));

    await expect(registry.get('model-authorization-actions')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'continue-credentials' } },
    })).resolves.toBeUndefined();

    expect(registry.get('model-authorization-body')!.innerHTML).toContain('model-authorization-api-key');
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('sk-never-render-this');
    expect(registry.get('model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.error_discovery_failed');
  });

  it('recovers busy state when draft testing or completion rejects', async () => {
    const testHarness = loadInteractiveHarness();
    const testBody = await enterManualBuiltinModels(testHarness);
    await testBody.dispatch('click', {
      target: { dataset: { modelAuthAction: 'toggle-model', modelId: 'claude-test', checked: 'true' } },
    });
    testHarness.invoke.mockRejectedValueOnce(new Error('test failure'));
    await expect(testHarness.registry.get('model-authorization-actions')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'complete' } },
    })).resolves.toBeUndefined();
    expect(testHarness.registry.get('model-authorization-modal')!.classList.contains('open')).toBe(true);
    expect(testHarness.registry.get('model-authorization-actions')!.innerHTML).not.toContain('complete" disabled');
    expect(testHarness.registry.get('model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.error_test_failed');

    const completeHarness = loadInteractiveHarness();
    const completeBody = await enterManualBuiltinModels(completeHarness);
    await completeBody.dispatch('click', {
      target: { dataset: { modelAuthAction: 'toggle-model', modelId: 'claude-test', checked: 'true' } },
    });
    completeHarness.invoke.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('save failure'));
    await expect(completeHarness.registry.get('model-authorization-actions')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'complete' } },
    })).resolves.toBeUndefined();
    expect(completeHarness.registry.get('model-authorization-modal')!.classList.contains('open')).toBe(true);
    expect(completeHarness.registry.get('model-authorization-actions')!.innerHTML).not.toContain('complete" disabled');
    expect(completeHarness.registry.get('model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.complete_failed');
  });

  it('preserves authorization cards when list refresh or removal rejects', async () => {
    const { context, registry, invoke, refreshModelGuard } = loadInteractiveHarness();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [] });
      if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [{
        authorizationId: 'profile:deepseek:kept', label: 'kept', authType: 'api_key', source: 'manual', models: [],
      }] });
      return Promise.resolve({ ok: true });
    });
    await context.window.initModelAuthorizationSettings();

    invoke.mockRejectedValueOnce(new Error('list failure'));
    await expect(context.window.refreshModelAuthorizationSettings()).resolves.toBeUndefined();
    expect(registry.get('settings-model-authorization-list')!.innerHTML).toContain('kept');
    expect(registry.get('settings-model-authorization-status')!.textContent)
      .toBe('settings.model_authorization.authorization_list_failed');

    invoke.mockRejectedValueOnce(new Error('remove failure'));
    await expect(registry.get('settings-model-authorization-list')!.dispatch('click', {
      target: { dataset: { modelAuthAction: 'remove-authorization', authorizationId: 'profile:deepseek:kept' } },
    })).resolves.toBeUndefined();
    expect(registry.get('settings-model-authorization-list')!.innerHTML).toContain('kept');
    expect(refreshModelGuard).not.toHaveBeenCalled();
  });

  it('validates manual API key fields and discards late discovery after source changes', async () => {
    const { context, registry, invoke, discoverResolvers } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-manual' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('choose-provider-preset');
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('choose-custom-endpoint');
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('choose-protocol');
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-provider-preset', providerId: 'anthropic' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('model-authorization-base-url');
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'continue-credentials' } } });
    expect(registry.get('model-authorization-status')!.textContent).toContain('error_required');
    registry.get('model-authorization-api-key')!.value = 'sk-live-secret';
    const first = registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'continue-credentials' } } });
    await Promise.resolve();
    expect(JSON.stringify(registry.get('model-authorization-body')!.innerHTML)).not.toContain('sk-live-secret');
    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.discover', expect.objectContaining({ kind: 'builtin', providerId: 'anthropic' }));
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-ccswitch' } } });
    discoverResolvers.shift()!({ ok: true, token: 'discovery-1', models: [{ id: 'stale-model' }] });
    await first;
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('stale-model');
  });

  it('prepares CC Switch rows with sanitized payload, preselects declared models, and completes once', async () => {
    const { context, registry, invoke, discoverResolvers } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-ccswitch' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('sk-***');
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('sk-raw-secret');
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('ready-to-import');
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('needs-api-key');
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('unsupported');
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('Needs key');
    const run = registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'select-ccswitch', externalId: 'cc-1' } } });
    await flushAsync();
    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.prepareCcSwitch', { externalId: 'cc-1' });
    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.discover', expect.objectContaining({ kind: 'ccswitch_draft', draftId: 'draft-cc-1' }));
    discoverResolvers.shift()!({ ok: true, token: 'discovery-1', declaredModels: ['claude-3-5-sonnet'], models: [{ id: 'claude-3-5-sonnet' }, { id: 'claude-3-opus' }] });
    await run;
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('claude-3-5-sonnet');
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'toggle-model', modelId: 'claude-3-opus', checked: 'true' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'default-model', modelId: 'claude-3-opus' } } });
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'complete' } } });
    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.testDraft', expect.objectContaining({ model: 'claude-3-opus' }));
    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.complete', expect.objectContaining({ selectedModels: ['claude-3-5-sonnet', 'claude-3-opus'], defaultModel: 'claude-3-opus' }));
    expect(invoke.mock.calls.filter((call) => call[0] === 'modelAuthorizations.complete')).toHaveLength(1);
    expect(context.refreshModelGuard).toHaveBeenCalled();
  });

  it('preserves failed completion drafts for retry and refreshes rendered cards on success', async () => {
    const { context, registry, invoke, discoverResolvers } = loadInteractiveHarness();
    let completeAttempts = 0;
    invoke.mockImplementation((channel: string, payload?: any) => {
      if (channel === 'modelAuthorizations.complete') {
        completeAttempts += 1;
        if (completeAttempts === 1) return Promise.resolve({ ok: false, error: 'save failed' });
      }
      if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [{ authorizationId: 'auth-1', label: 'Work', authType: 'api_key', source: 'manual', models: [{ entryId: 'entry-1', model: 'gpt-5.6-sol', default: true }] }] });
      if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [{ id: 'anthropic', label: 'Anthropic', supportsApiKey: true }] });
      if (channel === 'modelAuthorizations.discover') return new Promise((resolve) => discoverResolvers.push(resolve));
      if (channel === 'modelAuthorizations.testDraft') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    });
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-manual' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-protocol', protocol: 'anthropic' } } });
    registry.get('model-authorization-api-key')!.value = 'sk-ant-secret';
    registry.get('model-authorization-base-url')!.value = 'https://anthropic.example/v1';
    const run = registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'continue-credentials' } } });
    await flushAsync();
    discoverResolvers.shift()!({ ok: true, token: 'discovery-1', models: [{ id: 'claude-3-5-sonnet' }] });
    await run;
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'toggle-model', modelId: 'claude-3-5-sonnet', checked: 'true' } } });
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'complete' } } });
    expect(registry.get('model-authorization-status')!.textContent).toBe('save failed');
    expect(registry.get('model-authorization-modal')!.classList.contains('open')).toBe(true);
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'complete' } } });
    expect(registry.get('model-authorization-modal')!.classList.contains('open')).toBe(false);
    expect(registry.get('settings-model-authorization-list')!.innerHTML).toContain('gpt-5.6-sol');
  });

  it('walks back through wizard steps and cancels from the action bar', async () => {
    const { context, registry } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    // api_key_source: back returns to auth_type.
    expect(registry.get('model-authorization-actions')!.innerHTML).toContain('model-auth-action="back"');
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'back' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('choose-api-key');
    // auth_type: no back available, cancel closes the modal.
    expect(registry.get('model-authorization-actions')!.innerHTML).toContain('model-auth-action="cancel"');
    expect(registry.get('model-authorization-actions')!.innerHTML).not.toContain('model-auth-action="back"');
    // Re-enter the flow and back out of the provider preset step.
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-api-key' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-manual' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('choose-provider-preset');
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'back' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('source-manual');
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'cancel' } } });
    expect(registry.get('model-authorization-modal')!.classList.contains('open')).toBe(false);
  });
});
