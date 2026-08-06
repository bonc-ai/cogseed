import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const HOST_SRC = path.resolve(__dirname, '../../src/renderer/modules/chat-side-host.js');
const INDEX_HTML = path.resolve(__dirname, '../../src/renderer/index.html');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pure = require('../../src/renderer/modules/chat-side-host.js');

class FakeClassList {
  classes = new Set<string>();
  add(c: string) { this.classes.add(c); }
  remove(c: string) { this.classes.delete(c); }
  contains(c: string) { return this.classes.has(c); }
  toggle(c: string, force?: boolean) {
    const next = force === undefined ? !this.classes.has(c) : force;
    if (next) this.classes.add(c); else this.classes.delete(c);
    return next;
  }
}

class FakeEl {
  id: string;
  hidden = false;
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  attrs: Record<string, string> = {};
  focused = false;
  tagName = 'DIV';
  children: FakeEl[] = [];
  private handlers: Record<string, Array<() => void>> = {};
  constructor(id: string) { this.id = id; }
  addEventListener(type: string, fn: () => void) {
    (this.handlers[type] ||= []).push(fn);
  }
  click() { for (const fn of this.handlers.click || []) fn(); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  focus() { this.focused = true; }
  contains(el: unknown) { return this.children.includes(el as FakeEl); }
}

/** Minimal document holding just the ids the host and aside pane touch. */
function makeDom() {
  const ids = [
    'chat-side-host', 'chat-side-tabs', 'chat-side-tab-browser', 'chat-side-tab-aside',
    'chat-side-wide', 'chat-side-close',
    'chat-aside-panel', 'chat-side-browser', 'chat-aside-input',
  ];
  const els = new Map<string, FakeEl>();
  for (const id of ids) els.set(id, new FakeEl(id));
  // Ships closed, with no tab offered until a pane has content.
  els.get('chat-side-host')!.hidden = true;
  els.get('chat-side-tab-aside')!.hidden = true;
  els.get('chat-side-tab-browser')!.hidden = true;
  const docHandlers: Record<string, Array<(e: any) => void>> = {};
  const winHandlers: Record<string, Array<(e: any) => void>> = {};
  return {
    els,
    document: {
      getElementById: (id: string) => els.get(id) || null,
      addEventListener: (type: string, fn: (e: any) => void) => {
        (docHandlers[type] ||= []).push(fn);
      },
      activeElement: null as any,
    },
    docHandlers,
    winHandlers,
  };
}

function loadHost() {
  const dom = makeDom();
  const sandbox: any = { document: dom.document, window: {}, console };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type: string, fn: (e: any) => void) => {
    (dom.winHandlers[type] ||= []).push(fn);
  };
  sandbox.applyDomI18n = () => { dom.els.get('chat-side-host')!.dataset.i18nApplied = '1'; };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(HOST_SRC, 'utf8'), sandbox);
  const fire = (map: Record<string, Array<(e: any) => void>>, type: string, ev: any) => {
    for (const fn of map[type] || []) fn(ev);
  };
  return {
    ...dom,
    api: sandbox,
    pressKey: (key: string) => fire(dom.docHandlers, 'keydown', { key }),
    changeLang: () => fire(dom.winHandlers, 'i18n-change', {}),
  };
}

describe('side host — pure helpers', () => {
  it('lists only panes that have content', () => {
    expect(pure.computeVisibleSideTabs({ browser: false, aside: true })).toEqual(['aside']);
    expect(pure.computeVisibleSideTabs({ browser: true, aside: true }).sort())
      .toEqual(['aside', 'browser']);
  });

  it('shows no tabs when nothing has content', () => {
    // An empty strip is what lets the host stay hidden until something opens.
    expect(pure.computeVisibleSideTabs({ browser: false, aside: false })).toEqual([]);
    expect(pure.computeVisibleSideTabs({})).toEqual([]);
  });

  it('falls back to a sibling pane when one closes', () => {
    expect(pure.nextSidePaneAfterClose('aside', ['aside', 'browser'])).toBe('browser');
  });

  it('reports nothing left so the host can close', () => {
    expect(pure.nextSidePaneAfterClose('aside', ['aside'])).toBeNull();
    expect(pure.nextSidePaneAfterClose('aside', [])).toBeNull();
  });
});

describe('side host — tab behaviour', () => {
  it('ships closed with no tabs visible', () => {
    const { els, api } = loadHost();
    expect(els.get('chat-side-host')!.hidden).toBe(true);
    expect(api.isSideHostOpen()).toBe(false);
    expect(api.activeSidePane()).toBeNull();
  });

  it('opens the host and reveals the tab on activate', () => {
    const { els, api } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.setSideTabAvailable('aside', true);
    api.activateSidePane('aside');

    expect(els.get('chat-side-host')!.hidden).toBe(false);
    expect(els.get('chat-side-tab-aside')!.hidden).toBe(false);
    expect(els.get('chat-aside-panel')!.hidden).toBe(false);
    expect(api.activeSidePane()).toBe('aside');
  });

  it('shows exactly one pane at a time', () => {
    const { els, api } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.registerSidePane('browser', { paneElId: 'chat-side-browser' });
    api.setSideTabAvailable('aside', true);
    api.setSideTabAvailable('browser', true);

    api.activateSidePane('browser');
    expect(els.get('chat-side-browser')!.hidden).toBe(false);
    expect(els.get('chat-aside-panel')!.hidden).toBe(true);

    api.activateSidePane('aside');
    expect(els.get('chat-aside-panel')!.hidden).toBe(false);
    expect(els.get('chat-side-browser')!.hidden).toBe(true);
  });

  it('marks the active tab for assistive tech', () => {
    const { els, api } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.registerSidePane('browser', { paneElId: 'chat-side-browser' });
    api.activateSidePane('aside');

    expect(els.get('chat-side-tab-aside')!.attrs['aria-selected']).toBe('true');
    expect(els.get('chat-side-tab-browser')!.attrs['aria-selected']).toBe('false');
    expect(els.get('chat-side-tab-aside')!.classList.contains('is-active')).toBe(true);
  });

  it('switches to the sibling when the active pane becomes unavailable', () => {
    const { api } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.registerSidePane('browser', { paneElId: 'chat-side-browser' });
    api.setSideTabAvailable('aside', true);
    api.setSideTabAvailable('browser', true);
    api.activateSidePane('aside');

    api.setSideTabAvailable('aside', false);

    expect(api.activeSidePane()).toBe('browser');
    expect(api.isSideHostOpen()).toBe(true);
  });

  it('closes the host when the last pane becomes unavailable', () => {
    const { api } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.setSideTabAvailable('aside', true);
    api.activateSidePane('aside');

    api.setSideTabAvailable('aside', false);

    expect(api.isSideHostOpen()).toBe(false);
    expect(api.activeSidePane()).toBeNull();
  });

  it('runs a pane release hook when the column closes', () => {
    // An in-flight aside stream must not keep writing into a hidden pane.
    const released = vi.fn();
    const { api } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel', onClose: released });
    api.setSideTabAvailable('aside', true);
    api.activateSidePane('aside');

    api.closeSideHost();

    expect(released).toHaveBeenCalledTimes(1);
    expect(api.isSideHostOpen()).toBe(false);
  });

  it('focuses the pane through its activate hook', () => {
    const { els, api } = loadHost();
    api.registerSidePane('aside', {
      paneElId: 'chat-aside-panel',
      onActivate: () => els.get('chat-aside-input')!.focus(),
    });
    api.activateSidePane('aside');
    expect(els.get('chat-aside-input')!.focused).toBe(true);
  });

  it('keeps switching panes when one hook throws', () => {
    const { api } = loadHost();
    api.registerSidePane('aside', {
      paneElId: 'chat-aside-panel',
      onActivate: () => { throw new Error('pane hook exploded'); },
    });
    api.registerSidePane('browser', { paneElId: 'chat-side-browser' });

    expect(() => api.activateSidePane('aside')).not.toThrow();
    expect(api.activeSidePane()).toBe('aside');
    api.activateSidePane('browser');
    expect(api.activeSidePane()).toBe('browser');
  });

  it('ignores an unregistered pane id', () => {
    const { api } = loadHost();
    expect(() => api.activateSidePane('nope')).not.toThrow();
    expect(api.isSideHostOpen()).toBe(false);
  });

  it('toggles wide mode', () => {
    const { els, api } = loadHost();
    api.bindSideHost();
    els.get('chat-side-wide')!.click();
    expect(els.get('chat-side-host')!.classList.contains('is-wide')).toBe(true);
    els.get('chat-side-wide')!.click();
    expect(els.get('chat-side-host')!.classList.contains('is-wide')).toBe(false);
  });

  it('closes the column from the tab strip', () => {
    const { els, api } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.setSideTabAvailable('aside', true);
    api.activateSidePane('aside');
    api.bindSideHost();

    els.get('chat-side-close')!.click();

    expect(api.isSideHostOpen()).toBe(false);
  });

  it('closes on Escape', () => {
    const { api, pressKey } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.setSideTabAvailable('aside', true);
    api.activateSidePane('aside');
    api.bindSideHost();

    pressKey('Escape');

    expect(api.isSideHostOpen()).toBe(false);
  });

  it('ignores Escape while a field inside has focus', () => {
    // Escape must cancel IME composition in the aside textarea before it gets
    // a chance to collapse the column.
    const { els, api, pressKey } = loadHost();
    const host = els.get('chat-side-host')!;
    const input = els.get('chat-aside-input')!;
    input.tagName = 'TEXTAREA';
    host.children.push(input);
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.setSideTabAvailable('aside', true);
    api.activateSidePane('aside');
    api.bindSideHost();
    (api.document as any).activeElement = input;

    pressKey('Escape');

    expect(api.isSideHostOpen()).toBe(true);
  });

  it('ignores Escape when already closed', () => {
    const { api, pressKey } = loadHost();
    api.bindSideHost();
    expect(() => pressKey('Escape')).not.toThrow();
    expect(api.isSideHostOpen()).toBe(false);
  });

  it('ignores other keys', () => {
    const { api, pressKey } = loadHost();
    api.registerSidePane('aside', { paneElId: 'chat-aside-panel' });
    api.activateSidePane('aside');
    api.bindSideHost();
    pressKey('Enter');
    expect(api.isSideHostOpen()).toBe(true);
  });

  it('re-renders tab labels on language change', () => {
    const { els, api, changeLang } = loadHost();
    api.bindSideHost();
    delete els.get('chat-side-host')!.dataset.i18nApplied;

    changeLang();

    expect(els.get('chat-side-host')!.dataset.i18nApplied).toBe('1');
  });

  it('binds each control only once across repeated binds', () => {
    const { els, api } = loadHost();
    api.bindSideHost();
    api.bindSideHost();
    els.get('chat-side-wide')!.click();
    // A double-bound toggle would flip twice and land back on false.
    expect(els.get('chat-side-host')!.classList.contains('is-wide')).toBe(true);
  });
});

/**
 * Markup guard. The stage-1 risk is that moving the already-shipped ask-aside
 * pane into the host silently breaks it, so assert against real index.html
 * rather than the fake DOM above.
 */
describe('side host — index.html markup', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  it('keeps every element the shipped ask-aside pane queries', () => {
    for (const id of ['chat-aside-panel', 'chat-aside-body', 'chat-aside-about',
      'chat-aside-form', 'chat-aside-input', 'chat-aside-send', 'chat-aside-clear']) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });

  it('nests both panes inside the host', () => {
    const hostStart = html.indexOf('id="chat-side-host"');
    const hostEnd = html.indexOf('</aside>', hostStart);
    const inside = html.slice(hostStart, hostEnd);
    expect(inside).toContain('id="chat-aside-panel"');
    expect(inside).toContain('id="chat-side-browser"');
  });

  it('ships the host and both tabs hidden', () => {
    expect(html).toMatch(/id="chat-side-host"[^>]*hidden/);
    expect(html).toMatch(/id="chat-side-tab-browser"[\s\S]{0,160}?hidden/);
    expect(html).toMatch(/id="chat-side-tab-aside"[\s\S]{0,160}?hidden/);
  });

  it('loads the host script before the panes that register with it', () => {
    const host = html.indexOf('modules/chat-side-host.js');
    const aside = html.indexOf('modules/chat-aside.js');
    expect(host).toBeGreaterThan(-1);
    expect(aside).toBeGreaterThan(host);
  });

  it('gives the browser pane no address bar', () => {
    // Local-file preview only: an address bar would imply reaching the open web.
    const start = html.indexOf('id="chat-side-browser"');
    const end = html.indexOf('</aside>', start);
    const pane = html.slice(start, end);
    expect(pane).not.toMatch(/<input/);
  });
});
