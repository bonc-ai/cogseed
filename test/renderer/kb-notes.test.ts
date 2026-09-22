import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...n: string[]) => n.forEach((x) => values.add(x)),
    remove: (...n: string[]) => n.forEach((x) => values.delete(x)),
    contains: (n: string) => values.has(n),
    toggle: (n: string, f?: boolean) => { const a = f == null ? !values.has(n) : f; if (a) values.add(n); else values.delete(n); return a; },
  };
}
function fakeEl(id: string) {
  const listeners: Record<string, any> = {};
  const el: any = {
    id, innerHTML: '', hidden: false, value: '', textContent: '', dataset: {}, style: {},
    classList: fakeClassList(),
    addEventListener: vi.fn((n: string, fn: any) => { listeners[n] = fn; }),
    appendChild: vi.fn(), querySelector: vi.fn(() => null), querySelectorAll: vi.fn(() => []),
    focus: vi.fn(), scrollTop: 0, scrollHeight: 0, insertAdjacentHTML: vi.fn(), remove: vi.fn(),
    _listeners: listeners,
  };
  return el;
}

const TREE_WITH_NOTES = {
  tree: [
    { name: 'lib', path: 'lib', type: 'dir', children: [] },
    { name: 'notes', path: 'notes', type: 'dir', children: [
      { name: '周记.md', path: 'notes/周记.md', type: 'file', bytes: 10, mtime: 1 },
      { name: '复盘.md', path: 'notes/复盘.md', type: 'file', bytes: 8, mtime: 1 },
    ] },
  ],
};

function loadScript(tree = TREE_WITH_NOTES) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-notes.js'), 'utf8');
  const els: Record<string, any> = {};
  const created: any[] = [];
  const invokeCalls: Array<{ ch: string; payload: any }> = [];
  const documentMock: any = {
    getElementById: vi.fn((id: string) => { if (!els[id]) els[id] = fakeEl(id); return els[id]; }),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    createElement: vi.fn(() => { const el = fakeEl(''); created.push(el); return el; }),
    execCommand: vi.fn(),
    body: {},
  };
  const windowMock: any = {
    addEventListener: vi.fn(),
    uiToast: vi.fn(),
    uiConfirm: vi.fn(() => Promise.resolve(true)),
    uiPrompt: vi.fn(() => Promise.resolve('新笔记')),
    uiIconHtml: (name: string) => `<svg class="ui-icon is-${name}"></svg>`,
    uiButton: (o: any) => `<button type="button" class="btn ui-button ${o.className || ''}" id="${o.attrs?.id || ''}" title="${o.attrs?.title || ''}">${o.label}</button>`,
    uiIconButton: (o: any) => `<button type="button" class="ui-icon-button ${o.className || ''}" id="${o.attrs?.id || ''}" aria-label="${o.label}"></button>`,
    uiEmptyState: (options: any) => `<section class="ui-empty-state ui-empty-state--${String(options.kind || 'quiet')}"><h3>${String(options.title || '')}</h3></section>`,
    cogseed: {
      invoke: vi.fn(async (ch: string, payload: any) => {
        invokeCalls.push({ ch, payload });
        if (ch === 'contexts.tree') return tree;
        if (ch === 'contexts.read') {
          return { ok: true, content: payload.path === 'notes/周记.md' ? '# 周记\n内容' : '# 复盘\n内容' };
        }
        if (ch === 'contexts.mkdir') return { ok: true };
        if (ch === 'contexts.write') return { ok: true };
        if (ch === 'contexts.delete') return { ok: true };
        return {};
      }),
      stream: vi.fn(() => ({ promise: Promise.resolve() })),
    },
  };
  const context: any = {
    console, Promise, setTimeout, clearTimeout, performance,
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (v: unknown) => String(v ?? ''),
    uiToast: windowMock.uiToast, uiPrompt: windowMock.uiPrompt, uiConfirm: windowMock.uiConfirm,
    uiIconHtml: windowMock.uiIconHtml,
    document: documentMock, window: windowMock,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'kb-notes.js' });
  return { windowMock, els, invokeCalls, created };
}

describe('KB notes panel (S4)', () => {
  it('uses shared modal, input, and button primitives for note dialogs', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-notes.js'), 'utf8').replace(/\r\n/g, '\n');
    const picker = source.slice(source.indexOf('async function _addToLib'), source.indexOf('async function _copyNoteToLib'));
    const linkDialog = source.slice(source.indexOf('function _openLinkDialog'), source.indexOf('function _closeLinkDialog'));

    expect(source).toContain("window.uiModalController({ overlay, dialog, initialFocus, fallbackFocus, onClose: cleanup })");
    expect(picker).toContain("overlay.className = 'ui-modal-overlay kb-lib-picker-overlay'");
    expect(picker).toContain('class="ui-modal ui-modal--sm kb-lib-picker"');
    expect(picker).toContain('class="ui-modal__header"');
    expect(picker).toContain('class="ui-modal__body kb-lib-picker-body"');
    // 断言钉在 i18n 键上（不是中文原文）：文案会随语言变，键不会
    expect(picker).toContain("_uiIconButton({ label: _t('kb.notes.pick_library_close'), icon: 'x'");
    expect(linkDialog).toContain("overlay.className = 'ui-modal-overlay kb-link-dlg-overlay'");
    expect(linkDialog).toContain('class="ui-modal ui-modal--sm kb-link-dlg"');
    expect(linkDialog).toContain('class="ui-modal__header"');
    expect(linkDialog).toContain('class="ui-modal__body kb-link-dlg-body"');
    expect(linkDialog).toContain('class="ui-modal__footer kb-link-actions"');
    expect(linkDialog).toContain("_uiInput({ id: 'kb-link-text'");
    expect(linkDialog).toContain("_uiButton({ label: _t('kb.notes.confirm'), role: 'primary'");
    expect(linkDialog).not.toMatch(/<input\b/);
  });

  it('renders the notes list from the contexts notes/ dir', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbNotes();
    await vi.waitFor(() => {
      expect(els['kb-notes-items'].appendChild).toHaveBeenCalled();
    });
    // 列表项来自 notes/ 目录（周记/复盘 两个文件）
    expect(els['kb-notes-items'].appendChild).toHaveBeenCalledTimes(2);
  });

  it('renders the shared quiet empty state when there are no notes', async () => {
    const { windowMock, els } = loadScript([]);
    windowMock.renderKbNotes();
    await vi.waitFor(() => {
      expect(els['kb-notes-items'].innerHTML).toContain('ui-empty-state--quiet');
    });
    expect(els['kb-notes-items'].innerHTML).toContain('暂无笔记，点击 ＋ 新建');
  });

  it('creates a new note: ensures notes/ dir then writes the file', async () => {
    const { windowMock, els, invokeCalls } = loadScript();
    windowMock.renderKbNotes();
    await vi.waitFor(() => {
      expect(els['kb-notes-items'].appendChild).toHaveBeenCalled();
    });
    els['kb-notes-new']._listeners.click();
    await vi.waitFor(() => {
      expect(invokeCalls.some((c) => c.ch === 'contexts.write' && c.payload.path === 'notes/新笔记.md')).toBe(true);
    });
    // notes 目录已存在 → 不应重复 mkdir
    expect(invokeCalls.some((c) => c.ch === 'contexts.mkdir')).toBe(false);
  });

  it('opens a note and reads its content', async () => {
    const { windowMock, els, invokeCalls, created } = loadScript();
    windowMock.renderKbNotes();
    await vi.waitFor(() => {
      expect(els['kb-notes-items'].appendChild).toHaveBeenCalled();
    });
    // 第一个列表项（周记）触发 open：直接调用其 click 监听器
    const items = els['kb-notes-items'].appendChild.mock.calls.map((c: any[]) => c[0]);
    const weekly = items.find((el: any) => el.innerHTML.includes('周记') && el._listeners?.click);
    expect(weekly).toBeDefined();
    weekly._listeners.click();
    await vi.waitFor(() => {
      expect(els['kb-notes-edit'].innerHTML).toContain('周记');
    });
    expect(invokeCalls.some((c) => c.ch === 'contexts.read' && c.payload.path === 'notes/周记.md')).toBe(true);
  });
});

/**
 * 语言切换（i18n-change）。
 *
 * 笔记外壳有两个约束把"重新渲染"这条路堵死了：
 *   1. `renderKbNotes()` 有 `_state.rendered` 守卫，只渲染一次；
 *   2. 编辑器是 contenteditable —— 用户草稿只活在 DOM 里。
 * 所以语言切换必须走**定点重标签**：只改文本节点与属性，绝不重建 innerHTML。
 * 这里真的渲染一次外壳、dispatch i18n-change，并用 innerHTML 写入计数器守住第 2 条。
 */
describe('kb-notes 语言切换', () => {
  function hookEl(kind: 'text' | 'title' | 'label', key: string) {
    const el: any = { textContent: '', title: '', attrs: {} as Record<string, string>, dataset: {} };
    if (kind === 'text') el.dataset.notesText = key;
    if (kind === 'title') el.dataset.notesTitle = key;
    if (kind === 'label') el.dataset.notesLabel = key;
    el.setAttribute = (n: string, v: string) => { el.attrs[n] = v; };
    el.querySelector = () => null;
    return el;
  }

  function loadNotesI18n() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-notes.js'), 'utf8');
    const texts = [hookEl('text', 'kb.notes.title'), hookEl('text', 'kb.notes.insert_link')];
    const titles = [hookEl('title', 'kb.notes.bold')];
    const labels = [hookEl('label', 'kb.notes.save')];
    let html = '';
    let innerWrites = 0;
    const host: any = {
      hidden: false,
      querySelector: () => null,
      querySelectorAll: (sel: string) => {
        if (sel === '[data-notes-text]') return texts;
        if (sel === '[data-notes-title]') return titles;
        if (sel === '[data-notes-label]') return labels;
        return [];
      },
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener: () => {},
      appendChild: () => {},
    };
    Object.defineProperty(host, 'innerHTML', {
      get: () => html,
      set: (v: string) => { innerWrites += 1; html = v; },
    });
    const handlers: Record<string, Array<() => void>> = {};
    const dict: Record<string, string> = {
      'kb.notes.title': '笔记',
      'kb.notes.insert_link': '链接',
      'kb.notes.bold': '加粗',
      'kb.notes.save': '保存',
    };
    const windowMock: any = {
      addEventListener: (name: string, fn: () => void) => { (handlers[name] = handlers[name] || []).push(fn); },
      t: (key: string) => dict[key] || '',
      uiIconHtml: (name: string) => `<svg class="ui-icon is-${name}"></svg>`,
      uiIconButton: () => '<button class="ui-icon-button"></button>',
      uiButton: () => '<button class="ui-button"><span class="ui-button__label"></span></button>',
      uiInput: () => '<input class="ui-input" />',
      uiEmptyState: () => '<section class="ui-empty-state"></section>',
      uiModalController: () => ({ close() {} }),
      uiToast: vi.fn(),
      uiPrompt: vi.fn(async () => null),
      uiConfirm: vi.fn(async () => true),
      cogseed: { invoke: vi.fn(async () => ({ tree: [] })) },
    };
    const context: any = {
      console, setTimeout, clearTimeout,
      document: {
        getElementById: (id: string) => (id === 'kb-notes' ? host : null),
        createElement: () => hookEl('text', 'x'),
        addEventListener: () => {}, removeEventListener: () => {},
        body: {},
      },
      window: windowMock,
      localStorage: { getItem: () => null, setItem: () => {} },
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'kb-notes.js' });
    windowMock.renderKbNotes();
    return {
      texts, titles, labels, dict, host,
      innerWrites: () => innerWrites,
      fire: () => (handlers['i18n-change'] || []).forEach((fn) => fn()),
      listenerCount: () => (handlers['i18n-change'] || []).length,
    };
  }

  it('i18n-change 后外壳文案换到新语言；且绝不重建 innerHTML', () => {
    const env = loadNotesI18n();
    // 首渲染就套用了当前语言（渲染与重标签共用一处文案来源）
    expect(env.texts[0].textContent).toBe('笔记');
    expect(env.labels[0].attrs['aria-label']).toBe('保存');
    expect(env.listenerCount()).toBe(1);

    const writesAfterRender = env.innerWrites();
    const htmlAfterRender = env.host.innerHTML;
    env.dict['kb.notes.title'] = 'Notes';
    env.dict['kb.notes.insert_link'] = 'Link';
    env.dict['kb.notes.bold'] = 'Bold';
    env.dict['kb.notes.save'] = 'Save';
    env.fire();

    expect(env.texts[0].textContent).toBe('Notes');
    expect(env.texts[1].textContent).toBe('Link');
    expect(env.titles[0].title).toBe('Bold');
    expect(env.labels[0].attrs['aria-label']).toBe('Save');
    // 重建 innerHTML = 编辑器里的草稿没了：重标签期间一次都不许写
    expect(env.innerWrites()).toBe(writesAfterRender);
    expect(env.host.innerHTML).toBe(htmlAfterRender);   // 外壳 HTML 原样保留（草稿还在里面）
  });

  it('文案只有一个来源：表里的键全部被用到，且 4 份 locale 都定义齐', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-notes.js'), 'utf8');
    const table = source.slice(source.indexOf('const NOTES_TEXT = {'), source.indexOf('\n  };', source.indexOf('const NOTES_TEXT = {')));
    const keys = [...table.matchAll(/'([a-z0-9_.]+)': '/g)].map((m) => m[1]).filter((k) => k.startsWith('kb.notes.'));
    expect(keys.length).toBeGreaterThan(80);
    // 没有"死键"：每个键都必须真的被引用（hook 或 _t 调用），否则表会腐烂
    const dead = keys.filter((k) => !new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]`).test(source.replace(/const NOTES_TEXT[\s\S]*?\n  \};/, '')));
    expect(dead).toEqual([]);
    // 4 份 locale 键集一致，且与表一致
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      const dict = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8'));
      const missing = keys.filter((k) => !dict[k]);
      expect(missing, `${lang} 缺 ${missing.length} 个键`).toEqual([]);
    }
    // zh 的值必须与表里的中文回退逐字相同（否则缺键回退与正常取值会给出两种文案）
    const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'));
    const drift = [...table.matchAll(/'([a-z0-9_.]+)': '((?:[^'\\]|\\.)*)',/g)]
      .filter(([, key, value]) => zh[key] !== value.replace(/\\\\/g, '\\'))
      .map(([, key]) => key);
    expect(drift).toEqual([]);
  });
});
