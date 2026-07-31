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
    'model-authorization-modal', 'model-authorization-close-btn', 'model-authorization-steps',
    'model-authorization-body', 'model-authorization-status', 'model-authorization-actions',
  ]) registry.set(id, new FakeElement(registry, id));
  registry.get('settings-model-authorization-advanced')!.hidden = true;
  const windowListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  let discoverResolvers: Array<(value: any) => void> = [];
  const invoke = vi.fn((channel: string, payload?: any) => {
    if (channel === 'modelAuthorizations.list') return Promise.resolve({ ok: true, authorizations: [] });
    if (channel === 'auth.listProviders') return Promise.resolve({ ok: true, providers: [
      { id: 'openai-codex', label: 'OpenAI Codex', supportsOAuth: true, supportsApiKey: false },
      { id: 'openai-compatible', label: 'OpenAI Compatible', supportsOAuth: false, supportsApiKey: true, manualModel: true },
      { id: 'anthropic', label: 'Anthropic', supportsOAuth: false, supportsApiKey: true },
    ] });
    if (channel === 'auth.startOAuth') return Promise.resolve({ ok: true, kind: 'done', profileId: `${payload.provider}:profile` });
    if (channel === 'customProviders.ccswitch.preview') return Promise.resolve({ ok: true, rows: [
      { externalId: 'cc-1', name: 'Claude Desktop', protocol: 'anthropic', maskedKey: 'sk-***', declaredModels: ['claude-3-5-sonnet'] },
      { externalId: 'cc-raw', name: 'Bad', protocol: 'openai', apiKey: 'sk-raw-secret', maskedKey: 'sk-***' },
    ] });
    if (channel === 'modelAuthorizations.prepareCcSwitch') return Promise.resolve({ ok: true, draftId: 'draft-cc-1', externalId: payload.externalId, declaredModels: ['claude-3-5-sonnet'], maskedKey: 'sk-***' });
    if (channel === 'modelAuthorizations.discover') return new Promise((resolve) => discoverResolvers.push(resolve));
    if (channel === 'modelAuthorizations.testDraft') return Promise.resolve({ ok: true });
    if (channel === 'modelAuthorizations.complete') return Promise.resolve({ ok: true, authorizationId: 'auth-1' });
    return Promise.resolve({ ok: true });
  });
  const windowObj: any = {
    orkas: { invoke },
    addEventListener(type: string, handler: (...args: any[]) => unknown) { const list = windowListeners.get(type) || []; list.push(handler); windowListeners.set(type, list); },
  };
  const context: any = {
    window: windowObj,
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
  return { context, registry, invoke, discoverResolvers, windowListeners };
}

describe('model authorization interactive wizard', () => {
  it('opens at auth type selection, expands advanced management, and ignores IME enter handlers', async () => {
    const { context, registry } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    expect(registry.get('model-authorization-modal')!.classList.contains('open')).toBe(true);
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('choose-oauth');
    await registry.get('settings-model-authorization-advanced-btn')!.click();
    expect(registry.get('settings-model-authorization-advanced')!.hidden).toBe(false);
    await registry.get('model-authorization-body')!.dispatch('keydown', { key: 'Enter', isComposing: true, keyCode: 229, preventDefault: vi.fn() });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('choose-oauth');
  });

  it('OAuth uses OAuth-capable providers and proceeds to discovery instead of creating an entry', async () => {
    const { context, registry, invoke, discoverResolvers } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-oauth' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('openai-codex');
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('openai-compatible');
    const oauthRun = registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-provider', providerId: 'openai-codex', providerKind: 'builtin' } } });
    await flushAsync();
    expect(invoke).toHaveBeenCalledWith('auth.startOAuth', { provider: 'openai-codex' });
    expect(invoke).not.toHaveBeenCalledWith('auth.addEntry', expect.anything());
    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.discover', expect.objectContaining({ kind: 'oauth', profileId: 'openai-codex:profile' }));
    discoverResolvers.shift()!({ ok: true, token: 'discovery-1', models: [{ id: 'gpt-5.6-sol' }] });
    await oauthRun;
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('gpt-5.6-sol');
  });

  it('validates manual API key fields and discards late discovery after source changes', async () => {
    const { context, registry, invoke, discoverResolvers } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-api-key' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-manual' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-provider', providerId: 'openai-compatible', providerKind: 'builtin' } } });
    await registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'continue-credentials' } } });
    expect(registry.get('model-authorization-status')!.textContent).toContain('error_required');
    registry.get('model-authorization-api-key')!.value = 'sk-live-secret';
    registry.get('model-authorization-base-url')!.value = 'https://relay.example/v1';
    const first = registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'continue-credentials' } } });
    await Promise.resolve();
    expect(JSON.stringify(registry.get('model-authorization-body')!.innerHTML)).not.toContain('sk-live-secret');
    expect(invoke).toHaveBeenCalledWith('modelAuthorizations.discover', expect.objectContaining({ kind: 'builtin', apiKey: 'sk-live-secret' }));
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-api-key' } } });
    discoverResolvers.shift()!({ ok: true, token: 'discovery-1', models: [{ id: 'stale-model' }] });
    await first;
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('stale-model');
  });

  it('prepares CC Switch rows with sanitized payload, preselects declared models, and completes once', async () => {
    const { context, registry, invoke, discoverResolvers } = loadInteractiveHarness();
    await context.window.initModelAuthorizationSettings();
    await registry.get('settings-model-authorization-add-btn')!.click();
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-api-key' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-ccswitch' } } });
    expect(registry.get('model-authorization-body')!.innerHTML).toContain('sk-***');
    expect(registry.get('model-authorization-body')!.innerHTML).not.toContain('sk-raw-secret');
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
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-api-key' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'source-manual' } } });
    await registry.get('model-authorization-body')!.dispatch('click', { target: { dataset: { modelAuthAction: 'choose-provider', providerId: 'anthropic', providerKind: 'builtin' } } });
    registry.get('model-authorization-api-key')!.value = 'sk-ant-secret';
    const run = registry.get('model-authorization-actions')!.dispatch('click', { target: { dataset: { modelAuthAction: 'continue-credentials' } } });
    await Promise.resolve();
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
});
