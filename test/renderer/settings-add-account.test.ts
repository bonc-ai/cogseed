import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
}

class FakeElement {
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  className = '';
  hidden = false;
  private _innerHTML = '';
  value = '';
  textContent = '';
  onclick: null | ((event?: unknown) => unknown) = null;
  readonly appended: FakeElement[] = [];
  private readonly byClass = new Map<string, FakeElement>();
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();

  get innerHTML() { return this._innerHTML; }

  set innerHTML(value: string) {
    this._innerHTML = value || '';
    this.byClass.clear();
    const classRe = /class="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = classRe.exec(this._innerHTML))) {
      for (const cls of match[1].split(/\s+/).filter(Boolean)) {
        if (!this.byClass.has(cls)) this.byClass.set(cls, new FakeElement());
      }
    }
  }

  querySelector(selector: string) {
    if (selector.startsWith('.')) return this.byClass.get(selector.slice(1)) || null;
    return null;
  }

  appendChild(child: FakeElement) {
    this.appended.push(child);
    return child;
  }

  focus() { /* noop */ }

  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  async click() {
    if (this.onclick) await this.onclick({ currentTarget: this, target: this });
    for (const handler of this.listeners.get('click') || []) {
      await handler({ currentTarget: this, target: this });
    }
  }
}

function loadSettingsClickHarness() {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const indexHtml = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
  const elements = new Map<string, FakeElement>();
  for (const id of [
    'settings-picker-provider',
    'settings-picker-model',
    'settings-add-entry-btn',
    'settings-picker-status',
    'settings-custom-model-fields',
    'settings-custom-label-input',
    'settings-custom-base-url-input',
    'settings-custom-model-input',
    'settings-custom-api-key-input',
    'add-account-modal',
    'add-account-title',
    'add-account-body',
    'add-account-actions',
    'oauth-flow-modal',
    'oauth-flow-title',
    'oauth-flow-body',
    'oauth-flow-close-btn',
  ]) {
    elements.set(id, new FakeElement());
  }
  const invoke = vi.fn(async (channel: string, payload?: any) => {
    if (channel === 'auth.listModels') {
      return { ok: true, models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] };
    }
    if (channel === 'auth.startOAuth') {
      return { ok: false, error: 'stop after proving the dialog opened' };
    }
    if (channel === 'auth.addApiKey') return { ok: true, profileId: `${payload.provider}:work` };
    if (channel === 'auth.addEntry') return { ok: true, entryId: 'entry-custom' };
    return { ok: true };
  });

  const aiSelectMount = (element: FakeElement, config: Record<string, unknown> = {}) => {
    let value = typeof config.value === 'string' ? config.value : '';
    let options: Array<{ value: string }> = [];
    let changeHandler: (next: string) => unknown = () => undefined;
    return {
      setOptions(nextOptions: Array<{ value: string }>, next: { value?: string } = {}) {
        options = nextOptions || [];
        if (typeof next.value === 'string') value = next.value;
        if (value && !options.some((option) => option.value === value)) value = '';
        element.dataset.value = value;
      },
      getValue: () => value,
      setValue(next: string) {
        value = next || '';
        element.dataset.value = value;
      },
      onChange(handler: (next: string) => unknown) { changeHandler = handler; },
      emitChange(next: string) {
        value = next;
        element.dataset.value = value;
        return changeHandler(next);
      },
    };
  };

  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    _aiSelectMount: aiSelectMount,
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new FakeElement(),
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'settings.js' });
  vm.runInContext(`
    _settingsState.providers = [{
      id: 'openai-codex',
      label: 'OpenAI Codex',
      supportsApiKey: false,
      supportsOAuth: true
    }];
    _settingsState.modelsCache = {};
  `, context);
  return { context, elements, indexHtml, invoke };
}

describe('settings model authorization add account', () => {
  it('opens the OAuth dialog when OpenAI Codex and GPT-5.6 are selected', async () => {
    const { context, elements, indexHtml, invoke } = loadSettingsClickHarness();
    for (const id of [
      'settings-picker-provider',
      'settings-picker-model',
      'settings-add-entry-btn',
      'oauth-flow-modal',
      'oauth-flow-title',
      'oauth-flow-body',
      'oauth-flow-close-btn',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }

    await vm.runInContext('_settingsRenderPicker()', context);
    await vm.runInContext("_settingsState.pickerProviderSel.emitChange('openai-codex')", context);
    await vm.runInContext("_settingsState.pickerModelSel.emitChange('gpt-5.6-sol')", context);
    expect(vm.runInContext('_settingsState.pickerProviderSel.getValue()', context)).toBe('openai-codex');
    expect(vm.runInContext('_settingsState.pickerModelSel.getValue()', context)).toBe('gpt-5.6-sol');
    await elements.get('settings-add-entry-btn')!.click();

    expect(elements.get('oauth-flow-modal')!.classList.contains('open')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('auth.startOAuth', { provider: 'openai-codex' });
  });


  it('saves OpenAI-compatible entries with Base URL and manual model', async () => {
    const { context, elements, invoke } = loadSettingsClickHarness();
    await vm.runInContext(`
      _settingsState.providers = [{
        id: 'openai-compatible',
        label: 'OpenAI Compatible',
        supportsApiKey: true,
        supportsOAuth: false,
        manualModel: true
      }];
      _settingsState.modelsCache = {};
    `, context);

    await vm.runInContext('_settingsRenderPicker()', context);
    await vm.runInContext("_settingsState.pickerProviderSel.emitChange('openai-compatible')", context);
    expect(elements.get('settings-custom-model-fields')!.hidden).toBe(false);
    elements.get('settings-custom-label-input')!.value = 'work';
    elements.get('settings-custom-base-url-input')!.value = 'https://llm.example.test/v1';
    elements.get('settings-custom-model-input')!.value = 'custom-chat';
    elements.get('settings-custom-api-key-input')!.value = 'sk-custom-xxxxxxxx';
    await elements.get('settings-add-entry-btn')!.click();

    expect(invoke).toHaveBeenCalledWith('auth.addApiKey', {
      provider: 'openai-compatible',
      apiKey: 'sk-custom-xxxxxxxx',
      label: 'work',
      baseUrl: 'https://llm.example.test/v1',
    });
    expect(invoke).toHaveBeenCalledWith('auth.addEntry', {
      provider: 'openai-compatible',
      model: 'custom-chat',
      profileId: 'openai-compatible:work',
    });
  });

});
