import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
/** 私仓维护的渲染层结构登记表；开源快照不导出 `docs/`。 */
const STRUCTURAL_REGISTRY = path.resolve(__dirname, '../../docs/renderer-structural-registry.md');

function loadStatusHint() {
  const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');
  const calls: Array<{ key: string; vars?: Record<string, unknown> }> = [];
  const windowObject: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowObject,
    createLogger: () => ({ warn() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      calls.push({ key, vars });
      return key;
    },
  });
  vm.runInContext(source, context, { filename: 'local-agents.js' });
  return {
    hint: windowObject.getLocalCliUnavailableHint as (entry: Record<string, unknown> | undefined) => string,
    externalTypes: windowObject.getExternalDefaultCliTypes as () => string[],
    calls,
  };
}

function deferredPanel() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Real create-dialog open/close, discovery, card rendering and delegated card /
// rescan handlers run together. The DOM adapter supplies only their host nodes;
// provider dropdown internals are unrelated to discovering local Agent cards.
function loadExternalSelector() {
  class Element {
    hidden = false;
    value = '';
    disabled = false;
    innerHTML = '';
    textContent = '';
    className = '';
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    classes = new Set<string>();
    listeners = new Map<string, Array<(event: any) => void>>();
    classList = {
      add: (name: string) => { this.classes.add(name); },
      remove: (name: string) => { this.classes.delete(name); },
      toggle: (name: string, force = !this.classes.has(name)) => {
        if (force) this.classes.add(name);
        else this.classes.delete(name);
        return force;
      },
    };
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    hasAttribute(name: string) { return this.attributes.has(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    focus() {}
    addEventListener(type: string, fn: (event: any) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
    }
    dispatch(type: string, event: any) {
      for (const fn of this.listeners.get(type) || []) fn(event);
    }
    querySelector(selector: string): Element | null {
      if (this === modal && selector === '[role="dialog"]') return dialog;
      if (this === dialog && selector === '#agent-modal-tabs .is-active') {
        return tabs.find((tab) => tab.classes.has('is-active')) || null;
      }
      if (this === elements.get('agent-modal-ext-provider-select') && selector === '.ai-select-trigger') return providerTrigger;
      return null;
    }
    querySelectorAll(selector: string): Element[] {
      if (this === elements.get('agent-modal-tabs') && selector === '[data-agent-tab]') return tabs;
      if (this === elements.get('agent-ext-fields') && selector === 'input, textarea') {
        return [get('agent-ext-name-input'), get('agent-ext-desc-input')];
      }
      return [];
    }
  }

  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const modal = get('agent-modal');
  modal.hidden = true;
  const dialog = new Element();
  const providerTrigger = new Element();
  const tabs = ['create', 'external'].map((name) => {
    const tab = new Element();
    tab.dataset.agentTab = name;
    return tab;
  });
  const panels = ['create', 'external'].map((name) => {
    const panel = new Element();
    panel.dataset.agentPanel = name;
    return panel;
  });
  const discoveries: ReturnType<typeof deferredPanel>[] = [];
  const scans: Promise<unknown>[] = [];
  const invoke = vi.fn((channel: string) => {
    if (channel === 'p3394.external.list') {
      const request = deferredPanel();
      discoveries.push(request);
      return request.promise;
    }
    if (channel === 'customProviders.list') return Promise.resolve({ ok: true, providers: [] });
    throw new Error(`Unexpected IPC: ${channel}`);
  });
  const context: any = {
    Date, setTimeout, clearTimeout,
    requestAnimationFrame: (fn: () => void) => fn(),
    createLogger: () => ({ warn() {}, error() {}, info() {} }),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? '').replace(/"/g, '&quot;'),
    getLang: () => 'en',
    pickDesc: (entry: any) => entry.description_en || '',
    uiButton: () => '<button data-ext-rescan>Rescan</button>',
    // Provider selection must not block the real External tab's onChange.
    _aiSelectMount: () => ({ setValue() {}, setOptions() {}, getValue: () => '' }),
    addEventListener() {},
    document: {
      body: new Element(),
      activeElement: get('create-agent-btn'),
      contains: () => true,
      getElementById: get,
      querySelectorAll: (selector: string) => {
        if (selector === '#agent-modal-tabs [data-agent-tab]') return tabs;
        if (selector === '#agent-modal [data-agent-panel]') return panels;
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
    },
    cogseed: { invoke },
  };
  context.window = context;
  vm.createContext(context);
  for (const module of ['ui-modal.js', 'local-agents.js', 'agents.js']) {
    vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules', module), 'utf8'), context, { filename: module });
  }
  // Observe completion without replacing the production mount behavior.
  const mount = context.mountExternalCliSelect;
  context.mountExternalCliSelect = (...args: unknown[]) => {
    const scan = mount(...args);
    scans.push(scan);
    return scan;
  };
  return {
    modal, discoveries, invoke,
    cards: get('agent-ext-pick'),
    open: () => context.openAgentModal({ initialTab: 'external' }),
    // Both Cancel and the close button call this production handler.
    cancel: () => context.closeAgentModal(),
    async settle() {
      // Advance the production scan indicator's 300 ms minimum, then await
      // actual mount completion rather than guessing at microtask counts.
      await vi.advanceTimersByTimeAsync(300);
      await Promise.all(scans);
    },
    rescan: () => get('agent-ext-rescan').dispatch('click', {
      preventDefault() {},
      target: { closest: (selector: string) => selector === '[data-ext-rescan]' ? {} : null },
    }),
    select: (type: string) => {
      get('agent-ext-pick').dispatch('click', {
        target: { closest: (selector: string) => selector === '[data-ext-cli]' ? { dataset: { extCli: type } } : null },
      });
      return context.getExternalCliValue();
    },
  };
}

const healthyExternalPanel = {
  ok: true,
  entries: [
    { type: 'codex', available: true, version: '0.140.0' },
    { type: 'claude', available: true, version: '2.1.0' },
  ],
  gateways: [], bound: {}, peers: [],
};

describe('external selector cancel and discovery recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('renders selectable healthy CLI cards after cancel and reopen during a deferred scan', async () => {
    const h = loadExternalSelector();
    h.open();
    expect(h.cards.innerHTML).toContain('agent_modal.ext_cli_scanning');
    h.cancel();
    expect(h.modal.hidden).toBe(true);
    h.open();
    expect(h.modal.hidden).toBe(false);
    // Current discovery contract deduplicates the still-running scan.
    expect(h.discoveries).toHaveLength(1);
    h.discoveries[0].resolve(healthyExternalPanel);
    await h.settle();

    expect(h.modal.style.display).toBe('flex');
    expect(h.cards.innerHTML).toContain('data-ext-cli="codex"');
    expect(h.cards.innerHTML).toContain('data-ext-cli="claude"');
    expect(h.cards.innerHTML).not.toContain('aria-disabled="true"');
    expect(h.select('codex')).toBe('codex');
    expect(h.cards.innerHTML).toMatch(/aria-checked="true"[^>]*data-ext-cli="codex"/);
    h.cancel();
  });

  it.each(['rejected IPC', 'error response'] as const)('retries discovery on reopen after %s', async (failure) => {
    const h = loadExternalSelector();
    h.open();
    if (failure === 'rejected IPC') h.discoveries[0].reject(new Error('discovery unavailable'));
    else h.discoveries[0].resolve({ ok: false, error: 'discovery unavailable' });
    await h.settle();
    expect(h.cards.innerHTML).toContain('agent_modal.ext_cli_missing_label');
    h.cancel();
    h.open();
    expect(h.discoveries).toHaveLength(2);
    expect(h.invoke).toHaveBeenLastCalledWith('p3394.external.list', { force: true });
    h.discoveries[1].resolve(healthyExternalPanel);
    await h.settle();

    expect(h.cards.innerHTML).toContain('data-ext-cli="codex"');
    expect(h.cards.innerHTML).not.toContain('agent_modal.ext_cli_missing_label');
    expect(h.select('claude')).toBe('claude');
    expect(h.cards.innerHTML).toMatch(/aria-checked="true"[^>]*data-ext-cli="claude"/);
    h.cancel();
  });

  it('recovers selectable CLI cards through Rescan after an empty discovery', async () => {
    const h = loadExternalSelector();
    h.open();
    h.discoveries[0].resolve({ ok: true, entries: [], gateways: [], bound: {}, peers: [] });
    await h.settle();
    expect(h.cards.innerHTML).toContain('agent_modal.ext_cli_missing_label');
    h.rescan();
    expect(h.discoveries).toHaveLength(2);
    expect(h.cards.innerHTML).toContain('agent_modal.ext_cli_scanning');
    h.discoveries[1].resolve(healthyExternalPanel);
    await h.settle();

    expect(h.modal.hidden).toBe(false);
    expect(h.cards.innerHTML).toContain('data-ext-cli="codex"');
    expect(h.select('codex')).toBe('codex');
    expect(h.cards.innerHTML).toMatch(/aria-checked="true"[^>]*data-ext-cli="codex"/);
    h.cancel();
  });
});

describe('external-agent unavailable status copy', () => {
  it('keeps registry failure reasons distinct', () => {
    const { hint, calls } = loadStatusHint();

    expect(hint({ error: 'not_found' })).toBe('agent.cli_not_found');
    expect(hint({ error: 'version_unknown' })).toBe('agent.cli_version_unknown');
    expect(hint({ error: 'version_too_old', version: '0.9.0' })).toBe('agent.cli_version_too_old');
    expect(calls.at(-1)).toEqual({
      key: 'agent.cli_version_too_old',
      vars: { version: '0.9.0' },
    });
  });

  it('exposes the stable external-agent product contract (six CLIs, incl. opencode)', () => {
    const { externalTypes } = loadStatusHint();
    expect(externalTypes()).toEqual(['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy']);
  });

  it('ships the three recovery messages in every renderer locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'));
      expect(table['agent.cli_not_found']).toBeTruthy();
      expect(table['agent.cli_version_unknown']).toBeTruthy();
      expect(table['agent.cli_version_too_old']).toContain('{version}');
      expect(table['agent_modal.ext_cli_scanning']).toBeTruthy();
      // 已接入标记（同 CLI 允许多实例，只打标不禁用；2026-10-20 改为卡片副标题）
      expect(table['agent_modal.ext_card_bound']).toContain('{n}');
    }
  });

  it('loads the bound-CLI marker with the external panel data', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');
    expect(source).toContain('bound:');
    expect(source).toContain('res.bound');
    expect(source).toMatch(/agent_modal\.ext_card_bound/);
  });

  it('keeps the external-agent radio cards on one complete keyboard path', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');

    expect(source).toContain('role="radio"');
    expect(source).toContain('aria-label="${escapeHtml(ariaLabel)}"');
    expect(source).toContain("card.type === focusableType ? '0' : '-1'");
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(source).toContain(`'${key}'`);
    }
    expect(source).toContain("if (e.key === 'Enter' || e.key === ' ')");
    expect(source).toContain('cardElement(card.type)?.focus()');
  });

  // `docs/` 是私仓文档目录，不随开源快照导出（`scripts/opensource/policy.json`
  // 的 `privatePaths` 里就有 `docs/`）。登记表是私仓的决策日志，文件不在时跳过
  // 这条登记检查；渲染层源码的键盘路径断言在上面，公仓照常运行。
  it.skipIf(!fs.existsSync(STRUCTURAL_REGISTRY))('registers the page-local radio cards in the structural registry', () => {
    const registry = fs.readFileSync(STRUCTURAL_REGISTRY, 'utf8');
    expect(registry).toContain('`local-agents.js`');
    expect(registry).toContain('roving tabindex');
  });
});
