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
  innerHTML = '';
  textContent = '';
  hidden = false;
  value = '';
  placeholder = '';
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();

  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  async click() {
    for (const handler of this.listeners.get('click') || []) await handler({ currentTarget: this, target: this });
  }
}

function loadHarness() {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const indexHtml = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
  const ids = [
    'settings-commander-backend-select',
    'settings-commander-hermes-model-row',
    'settings-commander-hermes-model',
    'settings-commander-backend-save',
    'settings-commander-backend-detect',
    'settings-commander-backend-status',
    'settings-commander-backend-detail',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === 'settings.setCommanderBackend') return { ok: true, settings: (payload as any).settings };
    if (channel === 'settings.detectCommanderBackends') {
      return { ok: true, hermes: { available: true, path: '/bin/hermes', version: '1.2.3' } };
    }
    return { ok: true };
  });
  const aiSelectMount = (element: FakeElement, config: Record<string, unknown> = {}) => {
    let value = typeof config.value === 'string' ? config.value : '';
    let changeHandler: (next: string) => unknown = () => undefined;
    return {
      setOptions(_options: Array<{ value: string }>, next: { value?: string } = {}) {
        if (typeof next.value === 'string') value = next.value;
        element.dataset.value = value;
      },
      getValue: () => value,
      setValue(next: string) { value = next || ''; element.dataset.value = value; },
      onChange(handler: (next: string) => unknown) { changeHandler = handler; },
      emitChange(next: string) { value = next; element.dataset.value = value; return changeHandler(next); },
    };
  };
  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string, vars?: Record<string, unknown>) => {
      if (!vars) return key;
      return key.replace(/$/, ` ${JSON.stringify(vars)}`);
    },
    escapeHtml: (value: unknown) => String(value ?? ''),
    _aiSelectMount: aiSelectMount,
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    window: { addEventListener: vi.fn(), orkas: { invoke } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'settings.js' });
  return { context, elements, indexHtml, invoke };
}

describe('settings commander backend', () => {
  it('renders the commander backend settings controls', () => {
    const { indexHtml } = loadHarness();
    expect(indexHtml).toContain('id="settings-commander-backend-select"');
    expect(indexHtml).toContain('id="settings-commander-hermes-model"');
    expect(indexHtml).toContain('id="settings-commander-backend-save"');
  });

  it('saves Hermes backend selection without secrets', async () => {
    const { context, elements, invoke } = loadHarness();
    vm.runInContext(`
      _settingsState.commanderBackendView = {
        settings: { backend: 'orkas-core-agent', authEntryId: null, localCli: null },
        cloudConfigured: true,
        hermes: { available: true, path: '/bin/hermes', version: '1.2.3' }
      };
      _settingsRenderCommanderBackend();
      _settingsState.commanderBackendSel.emitChange('hermes-cli');
    `, context);
    elements.get('settings-commander-hermes-model')!.value = 'hermes-fast';
    await elements.get('settings-commander-backend-save')!.click();
    expect(invoke).toHaveBeenCalledWith('settings.setCommanderBackend', {
      settings: {
        backend: 'hermes-cli',
        authEntryId: null,
        localCli: { type: 'hermes', model: 'hermes-fast', useCliDefaultModel: false },
      },
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/apiKey|secret|token/i);
  });
});
