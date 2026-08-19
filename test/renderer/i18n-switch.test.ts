import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/i18n.js'), 'utf8');
const continueWorkSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/continue-work.js'), 'utf8');
const onboardingSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/onboarding.js'), 'utf8');
const conversationSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const dialogsSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/dialogs.js'), 'utf8');
const settingsSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
const workspaceSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/workspace.js'), 'utf8');
const stateSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/state.js'), 'utf8');
const skillsBindingsSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf8');

function extractFunction(input: string, name: string) {
  const start = input.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function not found: ${name}`);
  const brace = input.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < input.length; index += 1) {
    if (input[index] === '{') depth += 1;
    if (input[index] === '}') depth -= 1;
    if (depth === 0) return input.slice(start, index + 1);
  }
  throw new Error(`unterminated function: ${name}`);
}

function localeTable(side: 'main' | 'renderer', language: 'zh' | 'en') {
  return JSON.parse(readFileSync(resolve(__dirname, `../../src/${side}/locales/${language}.json`), 'utf8')) as Record<string, string>;
}

function placeholders(value: string) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function createElement(attrs: Record<string, string> = {}) {
  return {
    textContent: '',
    attributes: { ...attrs } as Record<string, string>,
    getAttribute(name: string) { return this.attributes[name] ?? null; },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
  };
}

function loadI18n() {
  const text = createElement({ 'data-i18n': 'label' });
  const placeholder = createElement({ 'data-i18n-placeholder': 'placeholder' });
  const title = createElement({ 'data-i18n-title': 'title' });
  const aria = createElement({ 'data-i18n-aria-label': 'aria' });
  const document = {
    documentElement: { attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value; } },
    querySelectorAll(selector: string) {
      if (selector === '[data-i18n]') return [text];
      if (selector === '[data-i18n-placeholder]') return [placeholder];
      if (selector === '[data-i18n-title]') return [title];
      if (selector === '[data-i18n-aria-label]') return [aria];
      return [];
    },
  };
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const setUiLanguage = async (uiLanguage: string) => ({ ok: true, uiLanguage });
  const window = {
    __cogseedI18nBoot: null,
    cogseed: {
      getUiLanguage: async () => ({ ok: true, uiLanguage: 'zh' }),
      setUiLanguage,
      getLocales: async () => ({ ok: true, tables: {
        zh: { label: '中文', placeholder: '请输入', title: '标题', aria: '连接' },
        en: { label: 'English', placeholder: 'Type here', title: 'Title', aria: 'Connect' },
      } }),
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    CustomEvent: class CustomEvent { type: string; detail: unknown; constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; } },
  };
  const sandbox: Record<string, unknown> = {
    window,
    document,
    console,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    CustomEvent: window.CustomEvent,
    Promise,
    Set,
    Object,
    String,
  };
  vm.runInNewContext(`${source}\nthis.__i18n = { t, getLang, setLang, getSupportedLanguages, applyDomI18n };`, sandbox, { filename: 'i18n.js' });
  return { api: sandbox.__i18n as any, document, window, text, placeholder, title, aria };
}

function loadDialogs() {
  class FakeElement {
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    className = '';
    id = '';
    textContent = '';
    attributes: Record<string, string> = {};
    listeners = new Map<string, Array<() => void>>();

    get classList() {
      return {
        add: (...names: string[]) => {
          const values = new Set(this.className.split(/\s+/).filter(Boolean));
          names.forEach((name) => values.add(name));
          this.className = [...values].join(' ');
        },
        remove: (...names: string[]) => {
          const removed = new Set(names);
          this.className = this.className.split(/\s+/).filter((name) => name && !removed.has(name)).join(' ');
        },
      };
    }

    set innerHTML(value: string) {
      const match = value.match(/<div class="ui-toast-message">([^<]*)<\/div>/);
      if (!match) return;
      const message = new FakeElement();
      message.className = 'ui-toast-message';
      message.textContent = match[1];
      this.appendChild(message);
    }

    appendChild(child: FakeElement) {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }
    querySelector(selector: string): FakeElement | null {
      if (selector === '.ui-toast-message') {
        return this.children.find((child) => child.className.split(/\s+/).includes('ui-toast-message')) || null;
      }
      return null;
    }
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === '.ui-toast') {
        return this.children.filter((child) => child.className.split(/\s+/).includes('ui-toast'));
      }
      return [];
    }
    contains(target: FakeElement): boolean {
      return this === target || this.children.some((child) => child.contains(target));
    }
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    get childElementCount() { return this.children.length; }
  }

  const body = new FakeElement();
  const listeners = new Map<string, Array<() => void>>();
  let language: 'zh' | 'en' = 'zh';
  const tables = { zh: { notice: '中文通知' }, en: { notice: 'English notice' } };
  const window = {
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
  };
  const sandbox: Record<string, unknown> = {
    window,
    document: { body, createElement: () => new FakeElement() },
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: () => 1,
    escapeHtml: (value: unknown) => String(value),
    t: (key: 'notice') => tables[language][key] || key,
    Promise,
    String,
    Number,
    Math,
  };
  vm.runInNewContext(`${dialogsSource}\nthis.__dialogs = { uiToast };`, sandbox, { filename: 'dialogs.js' });
  return {
    api: sandbox.__dialogs as { uiToast: (message: string, options?: Record<string, unknown>) => unknown },
    body,
    setLanguage(next: 'zh' | 'en') { language = next; },
    dispatch(type: string) { for (const listener of listeners.get(type) || []) listener(); },
  };
}

describe('renderer UI language switching', () => {
  it('uses localized system Space names in both delete confirmations', () => {
    expect(conversationSource).toContain('const name = sp ? (_conversationSpaceDisplayName(sp) || sid) : sid;');
    expect(workspaceSource).toContain('const name = (sp && _spaceDisplayName(sp)) || sid;');
  });

  it('defaults to Chinese and exposes only Chinese and English', () => {
    const { api } = loadI18n();
    expect(api.getLang()).toBe('zh');
    expect(api.getSupportedLanguages().map((item: { code: string }) => item.code)).toEqual(['zh', 'en']);
  });

  it('persists through UI IPC and refreshes text and accessible attributes', async () => {
    const { api, document, window, text, placeholder, title, aria } = loadI18n();
    const events: unknown[] = [];
    window.addEventListener('i18n-change', (event) => events.push(event));

    await api.setLang('en');

    expect(api.getLang()).toBe('en');
    expect(text.textContent).toBe('English');
    expect(placeholder.attributes.placeholder).toBe('Type here');
    expect(title.attributes.title).toBe('Title');
    expect(aria.attributes['aria-label']).toBe('Connect');
    expect(document.documentElement.attributes.lang).toBe('en');
    expect(events).toHaveLength(1);
  });

  it('rejects hidden locale codes without changing the UI', async () => {
    const { api } = loadI18n();
    expect(await api.setLang('ja')).toBe('zh');
    expect(await api.setLang('pt')).toBe('zh');
  });
});

describe('Chinese and English locale catalogs', () => {
  for (const side of ['main', 'renderer'] as const) {
    it(`${side} keeps keys and placeholders in parity`, () => {
      const zh = localeTable(side, 'zh');
      const en = localeTable(side, 'en');
      expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
      for (const key of Object.keys(zh)) {
        expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
      }
    });

    it(`${side} English catalog has no Chinese UI text`, () => {
      const en = localeTable(side, 'en');
      const mixed = Object.entries(en).filter(([, value]) => /\p{Script=Han}/u.test(value));
      expect(mixed).toEqual([]);
    });
  }

  it('keeps the canonical product terminology in English', () => {
    const en = localeTable('renderer', 'en');
    const canonicalTerms: Record<string, string> = {
      'agent_modal.ext_cli_label': 'Agent',
      'agent_picker.tab_skills': 'Skills',
      'agent_picker.tab_connectors': 'Connectors',
      'sidebar.conversations': 'Tasks',
      'sidebar.spaces_section': 'Spaces',
      'sidebar.workspace': 'Workspace',
      'cognition.title': 'Cognition Assets',
      'connections.tab.sources': 'Library',
      'agent_picker.ref_artifact': 'Artifact',
      'cognition.candidate_receipt_title': 'Recall',
    };

    for (const [key, term] of Object.entries(canonicalTerms)) {
      expect(en[key], key).toContain(term);
    }
  });

  it('uses formal display names for every supported local Agent runtime', () => {
    const en = localeTable('renderer', 'en');
    const runtimeNames: Record<string, string> = {
      claude: 'Claude Code',
      codex: 'Codex',
      openclaw: 'OpenClaw',
      opencode: 'OpenCode',
      hermes: 'Hermes',
      workbuddy: 'WorkBuddy',
      gemini: 'Gemini CLI',
      aider: 'Aider',
    };

    for (const [runtime, displayName] of Object.entries(runtimeNames)) {
      expect(en[`agent_modal.runtime_cli_${runtime}`], runtime).toBe(displayName);
      expect(en[`agent.external_badge.${runtime}`], runtime).toBe(`External · ${displayName}`);
    }
  });
});

describe('dynamic language refresh', () => {
  it('translates only marked system space names and preserves user names', () => {
    const language = { value: 'en' as 'zh' | 'en' };
    const labels = {
      'onboarding.temporary_space': { zh: '临时空间', en: 'Temporary Space' },
      'ws.scenario.workplace.name': { zh: '职场', en: 'Workplace' },
    };
    const sandbox: Record<string, unknown> = {
      _t: (key: keyof typeof labels, fallback: string) => labels[key]?.[language.value] || fallback,
    };
    vm.runInNewContext(`${extractFunction(workspaceSource, '_spaceDisplayName')}\nthis.displayName = _spaceDisplayName;`, sandbox);
    const displayName = sandbox.displayName as (space: Record<string, unknown>) => string;

    expect(displayName({ name: '临时空间', system_name_key: 'onboarding.temporary_space' })).toBe('Temporary Space');
    expect(displayName({ name: '旧称' })).toBe('旧称');
    expect(displayName({ name: '临时空间', primary_template_id: 'student' })).toBe('临时空间');
    language.value = 'zh';
    expect(displayName({ name: 'Workplace', system_name_key: 'ws.scenario.workplace.name' })).toBe('职场');
  });

  it('retranslates active keyed notifications and removes stale unkeyed notifications', () => {
    const { api, body, setLanguage, dispatch } = loadDialogs();
    api.uiToast('中文通知', { i18nKey: 'notice' });
    api.uiToast('无法重译的通知');
    const [keyed, unkeyed] = body.children[0].querySelectorAll('.ui-toast');

    setLanguage('en');
    dispatch('i18n-change');

    expect(keyed.querySelector('.ui-toast-message')?.textContent).toBe('English notice');
    expect(unkeyed.className).toContain('is-leaving');
    expect(settingsSource).toContain("i18nKey: 'settings.cli_fallback.notice_no_api'");
    expect(settingsSource).toContain("i18nKey: 'settings.cli_fallback.saved_no_api'");
  });

  it('uses standard live i18n markers for the first-run legal consent', () => {
    for (const key of [
      'onboarding.legal_consent_prefix',
      'onboarding.legal_privacy',
      'onboarding.legal_consent_and',
      'onboarding.legal_terms',
    ]) {
      expect(onboardingSource).toContain(`data-i18n="${key}"`);
    }
    expect(onboardingSource).not.toContain('data-i18n-key=');
  });

  it('refreshes the time-of-day greeting when the UI language changes', () => {
    expect(conversationSource)
      .toContain("window.addEventListener('i18n-change', _refreshEmptyStateGreeting);");
  });

  it('localizes empty-data fallback labels instead of leaking Chinese into English UI', () => {
    const en = localeTable('renderer', 'en');
    expect(en['onboarding.agent.other']).toBe('Other Agent');
    expect(en['chat.conv_space_mark']).toBe('S');
    expect(en['ws.space_mark']).toBe('S');
    expect(en['ws.template_mark']).toBe('T');
    expect(en['ws.scene_mark']).toBe('S');
    expect(onboardingSource).toContain("_csT('onboarding.agent.other', '其他 Agent')");
    expect(conversationSource).toContain("t('chat.conv_space_mark')");
    expect(workspaceSource).toContain("_t('ws.space_mark', '空')");
    expect(stateSource).toContain("t('common.unknown_error')");
    expect(skillsBindingsSource).toContain("_cognitionText('cognition.asset_reason_pause_prompt'");
  });

  it('repaints Continue Work without repeating source/session reads or import work', () => {
    const calls: Array<[string, unknown?]> = [];
    const state = { backdrop: { isConnected: true }, done: false, step: 2, busy: false };
    const sandbox = {
      state,
      calls,
      _cwRenderHeader: () => calls.push(['header']),
      _cwRenderSteps: () => calls.push(['steps']),
      _cwRenderDone: () => calls.push(['done']),
      _cwRefreshImportLabels: () => calls.push(['import-labels']),
      _cwRenderFoot: () => calls.push(['foot']),
      _cwRenderBody: (options: unknown) => calls.push(['body', options]),
    };
    vm.runInNewContext(
      `let _cw = state; ${extractFunction(continueWorkSource, '_cwHandleI18nChange')}; _cwHandleI18nChange();`,
      sandbox,
    );

    expect(calls.map(([name]) => name)).toEqual(['header', 'steps', 'body', 'foot']);
    expect(calls.find(([name]) => name === 'body')?.[1]).toEqual({ reload: false });
    expect(calls).not.toContainEqual(['done']);
    expect(calls).not.toContainEqual(['import-labels']);
  });

  it('updates only import labels while Continue Work is busy', () => {
    const calls: string[] = [];
    const sandbox = {
      state: { backdrop: { isConnected: true }, done: false, step: 3, busy: true },
      _cwRenderHeader: () => calls.push('header'),
      _cwRenderSteps: () => calls.push('steps'),
      _cwRenderDone: () => calls.push('done'),
      _cwRefreshImportLabels: () => calls.push('import-labels'),
      _cwRenderFoot: () => calls.push('foot'),
      _cwRenderBody: () => calls.push('body'),
    };
    vm.runInNewContext(
      `let _cw = state; ${extractFunction(continueWorkSource, '_cwHandleI18nChange')}; _cwHandleI18nChange();`,
      sandbox,
    );

    expect(calls).toEqual(['header', 'steps', 'import-labels', 'foot']);
  });
});
