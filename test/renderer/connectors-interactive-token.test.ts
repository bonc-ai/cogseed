// Interactive-token (Tencent Docs) connect dialog: real page and shared form/modal primitives.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { CONNECTOR_CATALOG } from '../../src/main/features/connectors/catalog';

const root = path.resolve(__dirname, '../..');

// ── Minimal DOM ──────────────────────────────────────────────────────────

type Node = FakeNode;

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

class FakeNode {
  tag: string;
  attrs: Record<string, string> = {};
  children: Array<Node | string> = [];
  parent: Node | null = null;
  style: Record<string, string> = {};
  listeners: Record<string, Array<(event?: any) => void>> = {};
  focused = false;
  value = '';
  type = '';
  offsetParent = {};
  disabled = false;
  hidden = false;
  tabIndex = 0;
  private _html = '';
  private _text = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  get classList() {
    const read = () => (this.attrs.class || '').split(/\s+/).filter(Boolean);
    const write = (values: string[]) => { this.attrs.class = values.join(' '); };
    return {
      contains: (name: string) => read().includes(name),
      add: (...names: string[]) => write([...new Set([...read(), ...names])]),
      remove: (...names: string[]) => write(read().filter((value) => !names.includes(value))),
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !read().includes(name) : force;
        write(on ? [...new Set([...read(), name])] : read().filter((value) => value !== name));
        return on;
      },
    };
  }

  get className(): string { return this.attrs.class || ''; }
  set className(value: string) { this.attrs.class = String(value); }

  /** `dataset` is a view over `data-*` attributes so `[data-id="…"]` selectors keep working. */
  get dataset(): Record<string, string> {
    const attrs = this.attrs;
    return new Proxy({} as Record<string, string>, {
      get: (_target, key) => attrs[`data-${String(key)}`],
      set: (_target, key, value) => { attrs[`data-${String(key)}`] = String(value); return true; },
      has: (_target, key) => `data-${String(key)}` in attrs,
      deleteProperty: (_target, key) => { delete attrs[`data-${String(key)}`]; return true; },
    });
  }

  setAttribute(name: string, value: unknown) { this.attrs[name] = String(value); }
  getAttribute(name: string) { return name in this.attrs ? this.attrs[name] : null; }
  hasAttribute(name: string) { return name in this.attrs; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  appendChild(child: Node) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }

  get innerHTML(): string { return this._html; }
  set innerHTML(value: string) {
    for (const child of this.children) if (typeof child !== 'string') child.parent = null;
    this.children = [];
    this._html = String(value);
    this._text = '';
    for (const node of parseNodes(this._html)) { node.parent = this; this.children.push(node); }
  }

  get textContent(): string {
    if (this._text) return this._text;
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(value: string) { this._text = String(value); this.children = []; this._html = ''; }

  querySelectorAll(selector: string): Node[] {
    if (selector.includes(',')) return [...new Set(selector.split(',').flatMap(s => this.querySelectorAll(s)))];
    selector = selector.replace(/:not\([^)]*\)/g, '');
    const parts = selector.trim().split(/\s+/).map(parseCompound);
    const out: Node[] = [];
    const walk = (node: Node, trail: Node[]) => {
      for (const child of node.children) {
        if (typeof child === 'string') continue;
        const chain = [...trail, child];
        if (matchesChain(chain, parts)) out.push(child);
        walk(child, chain);
      }
    };
    walk(this, []);
    return out;
  }

  querySelector(selector: string): Node | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector: string): Node | null {
    const parts = selector.trim().split(/\s+/).map(parseCompound);
    const chain: Node[] = [];
    let node: Node | null = this;
    while (node) { chain.unshift(node); node = node.parent; }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (matchesChain(chain.slice(0, i + 1), parts)) return chain[i];
    }
    return null;
  }

  addEventListener(type: string, handler: (event?: any) => void) {
    (this.listeners[type] ||= []).push(handler);
  }

  removeEventListener(type: string, handler: (event?: any) => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== handler);
  }

  /** Fires the click listeners the module attached, with a minimal event object. */
  click() {
    for (const handler of this.listeners.click || []) {
      handler({ stopPropagation: () => {}, preventDefault: () => {} });
    }
  }

  focus() { this.focused = true; }
  scrollIntoView() {}

  get isConnected(): boolean {
    let node: Node = this;
    while (node.parent) node = node.parent;
    return node.tag === '#document';
  }
}

type Compound = { tag: string; classes: string[]; id: string; attrs: Array<[string, string | null]> };

function parseCompound(source: string): Compound {
  const compound: Compound = { tag: '', classes: [], id: '', attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    if (match[1]) compound.tag = match[1];
    else if (match[2]) compound.classes.push(match[2]);
    else if (match[3]) compound.id = match[3];
    else if (match[4]) compound.attrs.push([match[4], match[5] === undefined ? null : match[5]]);
  }
  return compound;
}

function matchesCompound(node: Node, compound: Compound): boolean {
  if (compound.tag && node.tag !== compound.tag) return false;
  if (compound.id && node.attrs.id !== compound.id) return false;
  const classes = (node.attrs.class || '').split(/\s+/).filter(Boolean);
  if (compound.classes.some((name) => !classes.includes(name))) return false;
  return compound.attrs.every(([key, value]) => (value === null ? key in node.attrs : node.attrs[key] === value));
}

/** Descendant matching (`A B`) over a root→node chain. */
function matchesChain(chain: Node[], parts: Compound[]): boolean {
  if (!matchesCompound(chain[chain.length - 1], parts[parts.length - 1])) return false;
  let index = parts.length - 2;
  for (let i = chain.length - 2; i >= 0 && index >= 0; i -= 1) {
    if (matchesCompound(chain[i], parts[index])) index -= 1;
  }
  return index < 0;
}

function parseAttrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*"([^"]*)")?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) out[match[1]] = match[2] === undefined ? '' : match[2];
  return out;
}

/** Attribute values are HTML-escaped by every writer in this module, so `<`, `>` and `"` cannot
 *  appear inside them and a simple tag scan is sufficient. */
function parseNodes(html: string): Node[] {
  const fragment = new FakeNode('#fragment');
  const stack: Node[] = [fragment];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const text = html.slice(last, match.index);
    if (text.trim()) stack[stack.length - 1].children.push(text);
    last = re.lastIndex;
    if (match[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const node = new FakeNode(match[2]);
    Object.assign(node.attrs, parseAttrs(match[3]));
    stack[stack.length - 1].appendChild(node);
    if (match[4] !== '/' && !VOID_TAGS.has(match[2])) stack.push(node);
  }
  const rest = html.slice(last);
  if (rest.trim()) stack[stack.length - 1].children.push(rest);
  return fragment.children.filter((child): child is Node => typeof child !== 'string');
}

function page(invoke: any, lang: 'zh' | 'en' = 'zh') {
  const body = new FakeNode('#document');
  const listeners: Record<string, Function[]> = {};
  const docListeners: Record<string, Function[]> = {};
  const document = { body, activeElement: null, createElement: (tag: string) => new FakeNode(tag),
    getElementById: () => null, contains: () => true,
    addEventListener: (k: string, f: Function) => (docListeners[k] ||= []).push(f),
    removeEventListener: (k: string, f: Function) => { docListeners[k] = (docListeners[k] || []).filter(x => x !== f); },
  };
  const translations = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'));
  const ctx: any = { document, console, setTimeout, clearTimeout, performance, currentView: 'test',
    getLang: () => lang,
    t: (k: string, p?: Record<string, string>) => String(translations[k] || k).replace(/\{(\w+)\}/g, (_m, n) => p?.[n] ?? ''),
    requestAnimationFrame: (f: Function) => f(),
    createLogger: () => ({ warn() {}, error() {} }),
    addEventListener: (k: string, f: Function) => (listeners[k] ||= []).push(f),
    removeEventListener: (k: string, f: Function) => { listeners[k] = (listeners[k] || []).filter(x => x !== f); },
    cogseed: { invoke }, uiToast: vi.fn(), uiAlert: vi.fn(),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of ['icons', 'ui-button', 'ui-status', 'ui-form', 'ui-modal', 'connectors']) vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/modules', file + '.js'), 'utf8'), ctx);
  const entry = CONNECTOR_CATALOG.find((e) => e.id === 'tencent-docs');
  const modal = ctx._runInteractiveTokenConnect(entry);
  const token = () => modal.dialog.querySelector('#connector-token');
  const submit = () => modal.dialog.querySelector('form').listeners.submit[0]({ preventDefault() {} });
  const feedback = () => modal.dialog.querySelector('[data-token-feedback]').textContent;
  return { ctx, modal, token, submit, feedback, listeners };
}

describe('Tencent Docs token dialog', () => {
  it('stays in the app: shows the steps, and does not open the browser until asked', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const h = page(invoke);
    const text = h.modal.dialog.querySelector('.ui-modal__body').textContent;
    expect(h.modal.dialog.querySelector('.ui-modal__title').textContent).toBe('连接腾讯文档');
    expect(h.modal.dialog.querySelectorAll('li')).toHaveLength(3);
    expect(text).toContain('第三段');
    expect(text).not.toContain('OpenClaw');
    expect(invoke).not.toHaveBeenCalled();
    const connect = h.modal.dialog.querySelector('[data-token-submit]');
    expect(h.modal.dialog.classList.contains('ui-modal--md')).toBe(true);
    expect(connect.closest('.ui-modal__footer')).not.toBeNull();
    expect(connect.getAttribute('form')).toBe(h.modal.dialog.querySelector('form').getAttribute('id'));
    expect(h.modal.dialog.querySelector('.ui-form__actions')).toBeNull();
    expect(h.modal.dialog.querySelector('[data-token-feedback]').hasAttribute('hidden')).toBe(true);

    h.modal.dialog.querySelector('[data-token-open]').listeners.click[0]();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('auth.openExternal', { url: 'https://docs.qq.com/open/auth/mcp.html' });
    h.modal.close(null, 'test');
  });

  it('masks the token, blocks duplicate submits, and clears it on success', async () => {
    let resolve: any;
    const invoke = vi.fn(() => new Promise((r) => { resolve = r; }));
    const h = page(invoke);
    expect(h.token().getAttribute('type')).toBe('password');
    expect(h.modal.dialog.querySelector('[data-token-submit]').type).toBe('submit');
    h.token().value = ' tok-abc ';
    const pending = h.submit(); await h.submit();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connectors.connect_interactive_token', { catalog_id: 'tencent-docs', credential: 'tok-abc' });
    expect(h.token().disabled).toBe(true);
    expect(h.modal.dialog.querySelector('[data-token-submit]').disabled).toBe(true);
    resolve({ ok: true, status: { kind: 'connected' } });
    await pending; await h.modal;
    expect(h.token().value).toBe('');
    expect(h.ctx.uiToast).toHaveBeenCalled();
  });

  it('ignores an empty paste without calling main', async () => {
    const invoke = vi.fn();
    const h = page(invoke);
    h.token().value = '   ';
    await h.submit();
    expect(invoke).not.toHaveBeenCalled();
    h.modal.close(null, 'test');
  });

  it('keeps the dialog open and explains a rejected token inline so the paste can be fixed', async () => {
    const invoke = vi.fn(async () => ({ ok: true, status: { kind: 'error', message: 'HTTP 401 Unauthorized' } }));
    const h = page(invoke);
    h.token().value = 'wrong-block';
    await h.submit();
    expect(h.feedback()).not.toBe('');
    expect(h.modal.dialog.querySelector('[data-token-feedback]').hidden).toBe(false);
    const message = h.feedback();
    for (const f of h.listeners['i18n-change']) f();
    expect(h.feedback()).toBe(message);
    expect(h.modal.overlay.isConnected).toBe(true);
    expect(h.token().disabled).toBe(false);
    expect(h.token().value).toBe('wrong-block');
    expect(h.ctx.uiAlert).not.toHaveBeenCalled();
    h.modal.close(null, 'test');
  });

  it('re-renders in the new language without losing the pasted token', async () => {
    const h = page(vi.fn(), 'zh');
    h.token().value = 'keep-me';
    for (const f of h.listeners['i18n-change']) f();
    expect(h.token().value).toBe('keep-me');
    expect(h.modal.dialog.querySelector('[data-token-submit]').type).toBe('submit');
    h.modal.close(null, 'test');
    await h.modal;
    expect(h.listeners['i18n-change']).toHaveLength(1); // only the permanent page listener remains
  });
});
