// Email form integration: real page and shared form/modal primitives.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

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

function page(invoke: any, id = 'email-qq', settings?: any) {
  const body = new FakeNode('#document');
  const listeners: Record<string, Function[]> = {};
  const docListeners: Record<string, Function[]> = {};
  const document = { body, activeElement: null, createElement: (tag: string) => new FakeNode(tag),
    getElementById: () => null, contains: () => true,
    addEventListener: (k: string, f: Function) => (docListeners[k] ||= []).push(f),
    removeEventListener: (k: string, f: Function) => { docListeners[k] = (docListeners[k] || []).filter(x => x !== f); },
  };
  const translations = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
  const ctx: any = { document, console, setTimeout, clearTimeout, performance, currentView: 'test',
    t: (k: string) => translations[k] || k, requestAnimationFrame: (f: Function) => f(),
    createLogger: () => ({ warn() {}, error() {} }),
    addEventListener: (k: string, f: Function) => (listeners[k] ||= []).push(f),
    removeEventListener: (k: string, f: Function) => { listeners[k] = (listeners[k] || []).filter(x => x !== f); },
    cogseed: { invoke }, uiToast: vi.fn(),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of ['icons', 'ui-button', 'ui-status', 'ui-form', 'ui-modal', 'connectors']) vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/modules', file + '.js'), 'utf8'), ctx);
  // Isolate the already-tested select widget runtime; keep real shared field/modal rendering.
  ctx.hydrateUiFormSelects = (scope: any, callbacks: any) => {
    const host = scope.querySelector('#email-security');
    const trigger = new FakeNode('button'); trigger.className = 'ai-select-trigger'; host.appendChild(trigger);
    ctx.selectSecurity = callbacks['email-security'];
  };
  const entry = { id, auth_mode: 'credentials' };
  if (settings) vm.runInContext('_connectorsState.instances = ' + JSON.stringify([{ id, email_settings: settings }]), ctx);
  const modal = ctx._openEmailConnectDialog(entry);
  const get = (id: string) => modal.dialog.querySelector('#' + id);
  const submit = () => modal.dialog.querySelector('form').listeners.submit[0]({ preventDefault() {} });
  const feedback = () => modal.dialog.querySelector('[data-email-feedback]').textContent;
  return { ctx, modal, get, submit, feedback, translations, listeners, docListeners };
}
describe('email connector real page form', () => {
  it.each([
    ['email-qq', 'QQ 邮箱客户端授权码说明', 'https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/authorizationCode'],
    ['email-163', '网易邮箱客户端授权码说明', 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b'],
  ])('shows provider-specific authorization steps and an official guide for %s', (id, label, url) => {
    const invoke = vi.fn();
    const h = page(invoke, id);
    const hint = h.modal.dialog.querySelector('[data-email-hint]');
    expect(hint.textContent).toContain('开启 IMAP/SMTP 服务');
    expect(hint.textContent).toContain('生成并保存客户端授权码');
    expect(hint.textContent).toContain('使用授权码而非邮箱登录密码');
    expect(hint.textContent).not.toContain('{guide}');
    const link = hint.querySelector('a');
    expect(link.textContent).toBe(label);
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(invoke).not.toHaveBeenCalled();

    h.get('email-address').value = 'user@example.com';
    h.get('email-password').value = 'secret';
    Object.assign(h.translations, JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/en.json'), 'utf8')));
    for (const f of h.listeners['i18n-change']) f();
    const translatedHint = h.modal.dialog.querySelector('[data-email-hint]');
    expect(translatedHint.textContent).toContain('instead of your mailbox login password');
    expect(translatedHint.textContent).not.toContain('{guide}');
    expect(translatedHint.querySelector('a').getAttribute('href')).toBe(url);
    expect(translatedHint.querySelector('a').textContent).toContain('app authorization code guide');
    expect(h.get('email-address').value).toBe('user@example.com');
    expect(h.get('email-password').value).toBe('secret');
    h.modal.close(null, 'test');
  });

  it.each(['email-qq', 'email-163', 'email-enterprise'])('uses native footer submission and compact feedback for %s', id => {
    const h = page(vi.fn(), id);
    const button = h.modal.dialog.querySelector('[data-email-submit]');
    expect(h.modal.dialog.classList.contains('ui-form-modal')).toBe(true);
    expect(h.modal.dialog.classList.contains('ui-modal--md')).toBe(true);
    expect(button.closest('.ui-modal__footer')).not.toBeNull();
    expect(button.getAttribute('form')).toBe(h.modal.dialog.querySelector('form').getAttribute('id'));
    expect(button.type).toBe('submit');
    expect(h.modal.dialog.querySelector('.ui-form__actions')).toBeNull();
    expect(h.modal.dialog.querySelector('[data-email-feedback]').hidden).toBe(true);
    h.modal.close(null, 'test');
  });

  it('collects generic enterprise settings and preserves them across locale changes and failed auth', async () => {
    const invoke = vi.fn(async () => ({ ok: true, instance: { status: { kind: 'error', message: 'email_auth_failed' } } }));
    const h = page(invoke, 'email-enterprise');
    expect(h.get('email-host')).not.toBeNull();
    expect(h.modal.dialog.querySelector('[data-email-hint]').querySelector('a')).toBeNull();
    expect(h.get('email-host').value).toBe('');
    expect(h.get('email-port').value).toBe('993');
    h.ctx.selectSecurity('starttls'); expect(h.get('email-port').value).toBe('143');
    h.ctx.selectSecurity('tls');
    h.get('email-host').value = 'imap.acme.test'; h.get('email-port').value = '1993';
    h.get('email-username').value = 'staff'; h.get('email-address').value = 'p@acme.test';
    for (const f of h.listeners['i18n-change']) f();
    expect(h.get('email-host').value).toBe('imap.acme.test');
    h.get('email-password').value = 'secret';
    await h.submit();
    expect(invoke).toHaveBeenCalledWith('connectors.connect_email', { catalog_id: 'email-enterprise', address: 'p@acme.test', password: 'secret', settings: { host: 'imap.acme.test', port: 1993, security: 'tls', username: 'staff' } });
    expect(h.get('email-host').disabled).toBe(false);
    expect(h.get('email-password').value).toBe('');
    h.modal.close(null, 'test');
  });
  it('prefills the installed enterprise endpoint and a visual mask without exposing its password', () => {
    const h = page(vi.fn(), 'email-enterprise', { address: 'p@acme.test', host: 'mail.acme.test', port: 143, security: 'starttls', username: 'staff', has_saved_password: true });
    expect(h.get('email-host')?.value).toBe('mail.acme.test');
    expect(h.get('email-port').value).toBe('143');
    expect(h.get('email-address').value).toBe('p@acme.test');
    expect(h.get('email-password').value).toBe('');
    expect(h.get('email-password').getAttribute('placeholder')).toBe('••••••••');
    h.modal.close(null, 'test');
  });
  it.each(['email-qq', 'email-163', 'email-enterprise'])('shows saved credentials for %s and reuses them without submitting a mask', async id => {
    const invoke = vi.fn(async () => ({ ok: true, instance: { status: { kind: 'connected' } } }));
    const address = id === 'email-163' ? 'user@163.com' : 'user@qq.com';
    const h = page(invoke, id, { address, host: 'imap.company.test', port: 993, security: 'tls', username: address, has_saved_password: true });
    expect(h.get('email-password').value).toBe('');
    expect(h.get('email-password').getAttribute('placeholder')).toBe('••••••••');
    expect(h.get('email-password').hasAttribute('required')).toBe(false);
    expect(h.modal.dialog.querySelector('#email-password-hint').textContent).toContain('留空保留原值');
    for (const f of h.listeners['i18n-change']) f();
    expect(h.get('email-password').getAttribute('placeholder')).toBe('••••••••');
    await h.submit();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connectors.refresh', { id });
    await h.modal;
  });
  it('accepts a replacement and requires reentry after failed verification', async () => {
    const invoke = vi.fn(async () => ({ ok: true, instance: { status: { kind: 'error', message: 'email_auth_failed' } } }));
    const h = page(invoke, 'email-163', { address: 'user@163.com', has_saved_password: true });
    h.get('email-password').value = 'new-fixture-secret';
    await h.submit();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connectors.connect_email', { catalog_id: 'email-163', address: 'user@163.com', password: 'new-fixture-secret' });
    expect(h.get('email-password').value).toBe('');
    expect(h.get('email-password').getAttribute('placeholder')).toBe('');
    expect(h.get('email-password').hasAttribute('required')).toBe(true);
    await h.submit();
    expect(invoke).toHaveBeenCalledTimes(1);
    h.modal.close(null, 'test');
  });
  it.each(['email-address', 'email-host', 'email-port', 'email-username', 'email-security'])('requires a new credential after changing enterprise %s', async field => {
    const invoke = vi.fn();
    const h = page(invoke, 'email-enterprise', { address: 'user@company.test', host: 'imap.company.test', port: 993, security: 'tls', username: 'staff', has_saved_password: true });
    if (field === 'email-security') h.ctx.selectSecurity('starttls');
    else {
      h.get(field).value = field === 'email-port' ? '1993' : 'different';
      for (const listener of h.get(field).listeners.input) listener();
    }
    expect(h.get('email-password').getAttribute('placeholder')).toBe('');
    expect(h.get('email-password').hasAttribute('required')).toBe(true);
    await h.submit();
    expect(invoke).not.toHaveBeenCalled();
    h.modal.close(null, 'test');
  });
  it('closes the encryption picker before dismissing the modal on Escape', async () => {
    const h = page(vi.fn(), 'email-enterprise');
    const host = h.get('email-security'); host.classList.add('ai-select', 'open');
    const trigger = host.querySelector('.ai-select-trigger')!;
    trigger.addEventListener('click', () => host.classList.remove('open'));
    const escape = { key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    for (const f of [...h.docListeners.keydown]) f(escape);
    expect(h.modal.overlay.isConnected).toBe(true);
    expect(host.classList.contains('open')).toBe(false);
    expect(trigger.focused).toBe(true);
    for (const f of [...h.docListeners.keydown]) f(escape);
    await h.modal; expect(h.modal.overlay.isConnected).toBe(false);
  });

  it('uses masked shared fields, disables duplicate submission, clears credentials on success', async () => {
    let resolve: any; const invoke = vi.fn(() => new Promise(r => { resolve = r; }));
    const h = page(invoke);
    expect(h.get('email-password').getAttribute('type')).toBe('password');
    expect(h.get('email-address').getAttribute('type')).toBe('email');
    expect(h.modal.dialog.querySelector('[data-email-submit]').type).toBe('submit');
    h.get('email-address').value = 'user@qq.com'; h.get('email-password').value = 'secret';
    const pending = h.submit(); await h.submit();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connectors.connect_email', { catalog_id: 'email-qq', address: 'user@qq.com', password: 'secret' });
    expect(h.get('email-password').disabled).toBe(true);
    expect(h.modal.dialog.querySelector('[data-email-submit]').textContent).toContain('正在验证');
    expect(h.feedback()).toBe('');
    resolve({ ok: true, instance: { status: { kind: 'connected' } } }); await pending; await h.modal;
    expect(h.get('email-password').value).toBe(''); expect(h.ctx.uiToast).toHaveBeenCalled();
  });
  it('keeps authentication failures editable, clears secrets and reports safe localized errors', async () => {
    const h = page(vi.fn(async () => ({ ok: true, instance: { status: { kind: 'error', message: 'email_auth_failed' } } })));
    h.get('email-address').value = 'user@qq.com'; h.get('email-password').value = 'secret';
    await h.submit();
    expect(h.feedback()).toContain('邮箱拒绝登录'); expect(h.get('email-password').value).toBe('');
    expect(h.get('email-password').disabled).toBe(false); expect(h.get('email-address').value).toBe('user@qq.com');
    h.modal.close(null, 'test');
  });
  it('rerenders translated text without losing input and honors IME-safe Escape cleanup', async () => {
    const h = page(vi.fn()); h.get('email-address').value = 'u@qq.com'; h.get('email-password').value = 'secret';
    h.translations['connectors.email.address'] = 'Email address';
    for (const f of h.listeners['i18n-change']) f();
    expect(h.modal.dialog.querySelector('.ui-modal__body').innerHTML).toContain('Email address');
    expect(h.get('email-address').value).toBe('u@qq.com');
    for (const f of [...h.docListeners.keydown]) f({ key: 'Escape', isComposing: true });
    expect(h.modal.overlay.isConnected).toBe(true);
    for (const f of [...h.docListeners.keydown]) f({ key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await h.modal; expect(h.get('email-password').value).toBe('');
    expect(h.listeners['i18n-change']).toHaveLength(1); // only the permanent page listener remains
  });
});
