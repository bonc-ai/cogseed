import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-eco.js'), 'utf8');

function fakeElement(dataset: Record<string, string> = {}) {
  const listeners: Record<string, () => void> = {};
  return {
    dataset,
    hidden: false,
    innerHTML: '',
    title: '',
    classList: { toggle: vi.fn() },
    setAttribute: vi.fn(),
    addEventListener: vi.fn((name: string, handler: () => void) => { listeners[name] = handler; }),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    _listeners: listeners,
  } as any;
}

describe('KB ecosystem navigation refresh', () => {
  it('reloads the knowledge workbench whenever the user returns from discovery', () => {
    const buttons = ['kb', 'notes', 'discover'].map((key) => fakeElement({ kbEco: key }));
    const elements: Record<string, any> = {
      'kb-view': fakeElement(),
      'kb-workbench': fakeElement(),
      'kb-notes': fakeElement(),
      'kb-discover': fakeElement(),
      'kb-eco-compact': fakeElement(),
    };
    elements['kb-view'].querySelectorAll = vi.fn((selector: string) => selector === '[data-kb-eco]' ? buttons : []);
    const renderKbWorkbench = vi.fn();
    const renderKbDiscover = vi.fn();
    const context: any = {
      window: {
        addEventListener: vi.fn(),
        uiIconHtml: vi.fn(() => ''),
        uiIconButton: vi.fn(({ label, icon, attrs }: any) => `<button id="${attrs.id}" aria-label="${label}">${icon}</button>`),
        uiBadge: vi.fn(({ label, className }: any) => `<span class="ui-badge ${className}">${label}</span>`),
        renderKbWorkbench,
        renderKbDiscover,
      },
      document: {
        getElementById: vi.fn((id: string) => elements[id] || null),
        querySelectorAll: vi.fn((selector: string) => selector === '[data-kb-eco]' ? buttons : []),
      },
      localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
      renderKbWorkbench,
      renderKbDiscover,
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'kb-eco.js' });

    context.window.renderKbEco();
    buttons.find((button) => button.dataset.kbEco === 'discover')._listeners.click();
    buttons.find((button) => button.dataset.kbEco === 'kb')._listeners.click();

    expect(renderKbDiscover).toHaveBeenCalledOnce();
    expect(renderKbWorkbench).toHaveBeenCalledOnce();
    expect(elements['kb-workbench'].hidden).toBe(false);
    expect(context.window.uiIconButton).toHaveBeenCalledWith(expect.objectContaining({ icon: 'panel-list' }));
    expect(context.window.uiBadge).toHaveBeenCalledWith(expect.objectContaining({ className: 'kb-eco-tab-soon' }));
    expect(source).not.toContain('class="ui-icon-button kb-eco-compact"');
    expect(elements['kb-eco-compact'].setAttribute).toHaveBeenCalledWith('aria-pressed', 'false');
  });
});

/**
 * 语言切换：这个外壳里住着 kb-notes 的 contenteditable 编辑器（草稿只在 DOM 里），
 * 所以重标签**只能改文本节点与属性**，重建 innerHTML 会把用户没保存的笔记弄丢。
 * 这里真的监听一次 i18n-change，验证标签跟着换语言、而且没碰 innerHTML。
 */
describe('KB ecosystem language switch', () => {
  function tab(key: string, label: string, withBadge = false) {
    const labelNode = { textContent: label };
    const badgeNode = withBadge ? { textContent: '待开发' } : null;
    return {
      dataset: { kbEco: key },
      title: label,
      innerHTML: '',
      attrs: {} as Record<string, string>,
      addEventListener: vi.fn(),
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      querySelector: vi.fn((selector: string) => (
        selector === '.kb-eco-tab-label' ? labelNode : (selector === '.kb-eco-tab-soon' ? badgeNode : null)
      )),
      _labelNode: labelNode,
      _badgeNode: badgeNode,
    } as any;
  }

  function loadEco(dict: Record<string, string>) {
    const tabs = [tab('kb', '知识库'), tab('notes', '笔记'), tab('discover', '发现', true)];
    const compact = {
      title: '', attrs: {} as Record<string, string>,
      addEventListener: vi.fn(),
      setAttribute(n: string, v: string) { this.attrs[n] = v; },
    };
    // innerHTML 写入计数器：重标签期间只要写一次 innerHTML（= 重建外壳），
    // kb-notes 编辑器里没保存的草稿就没了 —— 这正是本测试要挡住的做法。
    let html = '';
    let innerWrites = 0;
    const view: any = {
      hidden: false, querySelector: vi.fn(() => null), querySelectorAll: vi.fn(() => tabs),
      classList: { toggle: vi.fn() },
    };
    Object.defineProperty(view, 'innerHTML', {
      get: () => html,
      set: (value: string) => { innerWrites += 1; html = value; },
    });
    const handlers: Record<string, Array<() => void>> = {};
    const elements: Record<string, any> = { 'kb-view': view, 'kb-eco-compact': compact };
    const context: any = {
      window: {
        addEventListener: (name: string, fn: () => void) => { (handlers[name] = handlers[name] || []).push(fn); },
        t: (key: string) => dict[key] || '',
        uiIconHtml: vi.fn(() => ''),
        uiIconButton: vi.fn(() => '<button id="kb-eco-compact"></button>'),
        uiBadge: vi.fn(({ label, className }: any) => `<span class="ui-badge ${className}">${label}</span>`),
      },
      document: {
        getElementById: vi.fn((id: string) => elements[id] || null),
        querySelectorAll: vi.fn((selector: string) => {
          if (selector === '.kb-eco') return [view];
          if (selector === '[data-kb-eco]') return tabs;
          return [];
        }),
      },
      localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'kb-eco.js' });
    return {
      context, tabs, compact, handlers, innerWrites: () => innerWrites,
      fire: () => (handlers['i18n-change'] || []).forEach((fn) => fn()),
    };
  }

  it('i18n-change 后导航标签、徽标与紧凑按钮换到新语言；且绝不重建 innerHTML', () => {
    const dict: Record<string, string> = {
      'kb.eco.nav_kb': '知识库', 'kb.eco.nav_notes': '笔记', 'kb.eco.nav_discover': '发现',
      'kb.eco.hide_labels': '仅显示图标', 'kb.eco.coming_soon': '待开发',
    };
    const env = loadEco(dict);
    env.context.window.renderKbEco();
    expect(env.handlers['i18n-change']?.length).toBe(1);

    dict['kb.eco.nav_kb'] = 'Knowledge Base';
    dict['kb.eco.nav_notes'] = 'Notes';
    dict['kb.eco.nav_discover'] = 'Discover';
    dict['kb.eco.coming_soon'] = 'Coming soon';
    dict['kb.eco.hide_labels'] = 'Show icons only';
    const byKey = (k: string) => env.tabs.find((t) => t.dataset.kbEco === k);
    const writesAfterRender = env.innerWrites();
    const labelNodeBefore = byKey('kb')._labelNode;
    env.fire();

    expect(byKey('kb').title).toBe('Knowledge Base');
    expect(byKey('kb').attrs['aria-label']).toBe('Knowledge Base');
    expect(byKey('kb')._labelNode.textContent).toBe('Knowledge Base');
    expect(byKey('discover')._labelNode.textContent).toBe('Discover');
    expect(byKey('discover')._badgeNode.textContent).toBe('Coming soon');
    expect(env.compact.title).toBe('Show icons only');
    // 重建 innerHTML = 丢掉 kb-notes 编辑器里的草稿：重标签期间一次都不许写
    expect(env.innerWrites()).toBe(writesAfterRender);
    // 文本节点必须还是原来那个（在原地改文字），不是被新节点替换
    expect(byKey('kb')._labelNode).toBe(labelNodeBefore);
    expect(env.tabs.every((t) => t.innerHTML === '')).toBe(true);
  });

  it('导航文案走 locale 键（labelKey），不在渲染时硬编码中文', () => {
    const dict: Record<string, string> = {};
    const env = loadEco(dict);
    env.context.window.renderKbEco();
    // 缺键时退回中文 label（开发者本机没加载 locale 也不会露 key 原文）
    expect(source).toContain("labelKey: 'kb.eco.nav_kb'");
    expect(source).toContain("labelKey: 'kb.eco.nav_notes'");
    expect(source).toContain("labelKey: 'kb.eco.nav_discover'");
    expect(source).toContain("_tr('kb.eco.module_reserved'");
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      const raw = fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8');
      for (const key of ['kb.eco.nav_kb', 'kb.eco.nav_notes', 'kb.eco.nav_discover', 'kb.eco.module_reserved']) {
        expect(raw, `${lang} 缺 ${key}`).toContain(`"${key}"`);
      }
    }
  });
});
