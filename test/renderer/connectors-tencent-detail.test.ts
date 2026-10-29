/**
 * Connector usage popups: business transitions through the real connector page and shared
 * controls. uiModal's DOM lifecycle is stubbed here; its keyboard/focus behavior is exercised
 * with the production renderer, preload and IPC in connectors-electron.test.ts.
 */
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
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value: boolean) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  value = '';
  activeElement: Node | null = null;
  scrollTop = 0;
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

  contains(child: Node): boolean { return child === this || this.children.some(node => typeof node !== 'string' && node.contains(child)); }
  prepend(child: Node) { child.parent = this; this.children.unshift(child); }
  dispatchEvent(event: any) { for (const handler of this.listeners[event.type] || []) handler(event); }
  focus() { this.focused = true; let root: Node = this; while (root.parent) root = root.parent; root.activeElement = this; }
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

// ── Renderer harness ─────────────────────────────────────────────────────

const TENCENT_ENTRY = {
  id: 'tencent-meeting',
  display_name: '腾讯会议',
  description_zh: '连接账号，读取有权访问的会议转写。',
  description_en: 'Connect an account to read meeting transcripts you have access to.',
  auth_mode: 'local_cli',
  availability: 'enabled',
};

const GRID_IDS = [
  'connections-pane-mcp',
  'connectors-grid-view',
  'connectors-group-connected',
  'connectors-group-available',
  'connectors-grid-connected',
  'connectors-grid-available',
  'connectors-empty',
  'connectors-group-connected-count',
  'connectors-group-available-count',
  'new-chat-input',
];

function readModule(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function loadConnectorsPage(options: {
  catalog?: any[];
  instances?: any[];
  invoke?: (channel: string, payload: any) => Promise<any>;
} = {}) {
  const documentRoot = new FakeNode('#document');
  const byId = new Map<string, Node>();
  const documentListeners: Record<string, Array<(event: any) => void>> = {};
  const storage = new Map<string, string>();

  const register = (id: string) => {
    const element = new FakeNode('div');
    element.attrs.id = id;
    byId.set(id, element);
    documentRoot.appendChild(element);
    return element;
  };
  for (const id of GRID_IDS) register(id);

  const document = {
    readyState: 'complete',
    body: documentRoot,
    get activeElement() { return documentRoot.activeElement; },
    documentElement: documentRoot,
    createElement: (tag: string) => new FakeNode(tag),
    getElementById: (id: string) => byId.get(id) || null,
    querySelector: (selector: string) => documentRoot.querySelector(selector),
    querySelectorAll: (selector: string) => documentRoot.querySelectorAll(selector),
    addEventListener: (type: string, handler: (event: any) => void) => {
      (documentListeners[type] ||= []).push(handler);
    },
    removeEventListener: () => {},
    __emitDocument: (type: string, event: any) => {
      const enriched = { stopPropagation: () => {}, preventDefault: () => {}, ...event };
      for (const handler of documentListeners[type] || []) handler(enriched);
    },
  };

  const catalog = options.catalog ?? [TENCENT_ENTRY];
  const instances = [...(options.instances ?? [])];
  const invokedChannels: string[] = [];
  const invoke = options.invoke ?? (async (channel: string, payload: any) => {
    if (channel === 'connectors.catalog') return { ok: true, catalog };
    if (channel === 'connectors.list') return { ok: true, instances };
    // Mirror the main side: disconnect drops the instance, it does not touch the provider CLI.
    if (channel === 'connectors.set_enabled') { const inst = instances.find(row => row.id === payload.id); if (inst) inst.enabled = payload.enabled; return { ok: true }; }
    if (channel === 'connectors.remove') {
      const index = instances.findIndex((item) => item && item.id === payload.id);
      if (index < 0) return { ok: true, removed: false };
      instances.splice(index, 1);
      return { ok: true, removed: true };
    }
    return { ok: true };
  });
  const wrappedInvoke = async (channel: string, payload: any) => {
    invokedChannels.push(channel);
    return invoke(channel, payload);
  };

  const pushHandlers = new Map<string, (payload: any) => void>();
  const alerts: string[] = [];
  const toasts: Array<{ message: string; variant?: string }> = [];
  const confirmations: Array<Record<string, unknown>> = [];
  const confirmAnswer = { value: true };
  const clipboard = { writeText: vi.fn(async () => {}) };
  const setView = vi.fn();
  const applyAutoTemplate = vi.fn();
  const openAutoTaskDialog = vi.fn();
  const loadRendererFeature = vi.fn(async () => undefined);

  const windowListeners: Record<string, Array<(event: any) => void>> = {};
  const context: any = {
    console,
    performance: { now: () => 100 },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    currentUserId: 'u-tencent',
    currentView: 'connections',
    // `window` IS the global object here so the shared primitives (which publish onto `window`)
    // are reachable as the bare identifiers this classic script calls them by.
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      key: (index: number) => Array.from(storage.keys())[index] || null,
      get length() { return storage.size; },
    },
    navigator: { clipboard },
    createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        key,
      );
    },
    getLang: () => 'zh',
    pickDesc: (entry: any, lang: string) => {
      if (!entry) return '';
      return String(lang).startsWith('zh')
        ? (entry.description_zh || entry.description_en || '')
        : (entry.description_en || entry.description_zh || '');
    },
    setChatConnector: vi.fn(),
    formatChatUseLabel: ({ name }: { name: string }) => name,
    sanitizeSvgIconHtml: (svg: unknown) => (typeof svg === 'string' ? svg : ''),
    uiAlert: (message: string) => { alerts.push(String(message)); },
    uiToast: (message: string, opts?: { variant?: string }) => { toasts.push({ message: String(message), variant: opts?.variant }); },
    uiConfirmDanger: async (dialog: Record<string, unknown>) => { confirmations.push(dialog); return confirmAnswer.value; },
    setView,
    loadRendererFeature,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, handler: (event: any) => void) => {
      (windowListeners[type] ||= []).push(handler);
    },
    removeEventListener: () => {},
    cogseed: {
      invoke: wrappedInvoke,
      onPushEvent: (channel: string, handler: (payload: any) => void) => { pushHandlers.set(channel, handler); },
    },
  };
  context.window = context;
  context.globalThis = context;
  context.window.applyAutoTemplate = applyAutoTemplate;
  context.window.openAutoTaskDialog = openAutoTaskDialog;

  vm.createContext(context);
  // Real primitives, in the same order index.html loads them.
  for (const module of [
    'src/renderer/modules/icons.js',
    'src/renderer/modules/ui-button.js',
    'src/renderer/modules/ui-card.js',
    'src/renderer/modules/ui-form.js',
    'src/renderer/modules/ui-modal.js',
    'src/renderer/modules/ui-structure.js',
    'src/renderer/modules/ui-status.js',
    'src/renderer/modules/ui-empty.js',
  ]) {
    vm.runInContext(readModule(module), context, { filename: path.basename(module) });
  }
  context.uiModal = ({ title, bodyHtml }: any) => {
    const overlay = new FakeNode('div');
    overlay.className = 'ui-modal-overlay';
    overlay.innerHTML = `<section class="ui-modal"><header class="ui-modal__header"><h2 class="ui-modal__title">${title}</h2>${context.uiIconButton({ label: 'Close', icon: 'x', attrs: { 'data-ui-modal-close': 'true' } })}</header><div class="ui-modal__body">${bodyHtml}</div></section>`;
    documentRoot.appendChild(overlay);
    const dialog = overlay.querySelector('.ui-modal')!;
    let settle!: (value: any) => void;
    const promise = new Promise(resolve => { settle = resolve; });
    const close = () => { overlay.remove(); settle({ reason: 'close' }); };
    dialog.querySelector('[data-ui-modal-close]')!.addEventListener('click', close);
    return Object.assign(promise, { overlay, dialog, close });
  };
  vm.runInContext(readModule('src/renderer/modules/connectors.js'), context, { filename: 'connectors.js' });

  return {
    context,
    alerts,
    toasts,
    confirmations,
    confirmAnswer,
    clipboard,
    setView,
    applyAutoTemplate,
    openAutoTaskDialog,
    loadRendererFeature,
    invokedChannels,
    document,
    byId,
    view: (id: string) => byId.get(id)!,
    popup: () => documentRoot.querySelector('.connector-popup')!,
    push: (channel: string, payload: any) => pushHandlers.get(channel)?.(payload),
    emitDocumentKeydown: (event: Record<string, unknown>) => {
      document.__emitDocument('keydown', event);
    },
  };
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 0));

function connectedInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tencent-meeting',
    display_name: '腾讯会议',
    status: { kind: 'connected', since: Date.now() },
    enabled: true,
    oauth_grant: { account_label: '' },
    ...overrides,
  };
}

async function openPopup(page: ReturnType<typeof loadConnectorsPage>, id = 'tencent-meeting') {
  await page.context.loadConnectors();
  const card = page.view('connectors-grid-connected').querySelector(`.connector-card[data-id="${id}"]`)
    || page.view('connectors-grid-available').querySelector(`.connector-card[data-id="${id}"]`);
  const button = card!.querySelector('[data-act="open-popup"]')!;
  button.click();
  return { card: card!, button };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('connected connector cards — unified live status', () => {
  it('leads available cards with enterprise integrations while preserving name order and connected grouping', async () => {
    const featuredIds = ['email-163', 'email-qq', 'email-enterprise', 'tencent-survey', 'tencent-meeting',
      'tencent-docs', 'feishu', 'dingtalk', 'wecom', 'wps'];
    const catalog = CONNECTOR_CATALOG.filter(entry => [...featuredIds, 'github', 'airtable', 'tencent-meeting'].includes(entry.id));
    const byName = (a: any, b: any) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base', numeric: true });
    const page = loadConnectorsPage({ catalog: [...catalog].reverse() });
    await page.context.loadConnectors();
    const cardIds = (grid: string) => page.view(grid).querySelectorAll('.connector-card').map(card => card.dataset.id);
    expect(cardIds('connectors-grid-available')).toEqual([
      ...catalog.filter(entry => featuredIds.includes(entry.id)).sort(byName).map(entry => entry.id),
      ...catalog.filter(entry => !featuredIds.includes(entry.id)).sort(byName).map(entry => entry.id),
    ]);

    const connectedPage = loadConnectorsPage({
      catalog,
      instances: ['github', 'feishu', 'tencent-docs'].map(id => connectedInstance({ id })),
    });
    await connectedPage.context.loadConnectors();
    expect(connectedPage.view('connectors-grid-connected').querySelectorAll('.connector-card').map(card => card.dataset.id))
      .toEqual(catalog.filter(entry => ['github', 'feishu', 'tencent-docs'].includes(entry.id)).sort(byName).map(entry => entry.id));
    const availableIds = connectedPage.view('connectors-grid-available').querySelectorAll('.connector-card').map(card => card.dataset.id);
    expect(availableIds).not.toContain('feishu');
    expect(availableIds).not.toContain('tencent-docs');
    expect(availableIds.slice(-1)).toEqual(['airtable']);
  });

  it('shows live status, Use and a popup entry for all ten enterprise cards', async () => {
    const ids = ['email-163', 'email-enterprise', 'email-qq', 'tencent-meeting', 'tencent-survey',
      'tencent-docs', 'feishu', 'dingtalk', 'wecom', 'wps'];
    const catalog = CONNECTOR_CATALOG.filter(entry => ids.includes(entry.id));
    const page = loadConnectorsPage({
      catalog,
      instances: catalog.map(entry => connectedInstance({
        id: entry.id,
        display_name: entry.display_name,
        email_settings: entry.auth_mode === 'credentials' ? { address: `${entry.id}@example.com` } : undefined,
      })),
    });
    await page.context.loadConnectors();
    const cards = page.view('connectors-grid-connected').querySelectorAll('.connector-card');
    expect(cards).toHaveLength(ids.length);
    for (const card of cards) {
      const account = catalog.find(entry => entry.id === card.dataset.id)?.auth_mode === 'credentials'
        ? ` · ${card.dataset.id}@example.com` : '';
      expect(card.querySelector('.connector-card-account')?.textContent).toBe(`connectors.group.connected${account}`);
      expect(card.querySelector('.ui-status-dot--success .ui-status-dot__mark')).not.toBeNull();
      const entry = catalog.find(entry => entry.id === card.dataset.id)!;
      if (entry.icon_name?.startsWith('connector-')) {
        const image = card.querySelector('.connector-card-icon img');
        expect(image?.getAttribute('src')).toMatch(/\.\.\/resources\/icons\/connectors\//);
      } else expect(card.querySelector('.connector-card-icon svg')).not.toBeNull();
      expect(card.querySelector('[data-act="use-connector"]')).not.toBeNull();
      expect(card.querySelector('[data-act="open-popup"]')).not.toBeNull();
    }
    const meeting = cards.find(card => card.dataset.id === 'tencent-meeting')!;
    expect(meeting.querySelector('.connector-card-account')?.textContent).toBe('connectors.group.connected');
    meeting.querySelector('[data-act="use-connector"]')!.click();
    expect(page.setView).toHaveBeenCalledWith('new-chat');
    expect(page.context.setChatConnector).toHaveBeenCalledWith('new-chat', 'tencent-meeting', '腾讯会议');
    expect(page.view('connectors-grid-view').style.display).not.toBe('none');
  });

  it('shows a supplied OAuth account after the status and treats a blank account as absent', async () => {
    for (const account of ['meeting@example.com', '   ']) {
      const page = loadConnectorsPage({ instances: [connectedInstance({ oauth_grant: { account_label: account } })] });
      await page.context.loadConnectors();
      const line = page.document.querySelector('.connector-card-account')!;
      const text = account.trim() ? 'connectors.group.connected · meeting@example.com' : 'connectors.group.connected';
      expect(line.textContent).toBe(text);
      expect(line.getAttribute('title')).toBe(text);
    }
  });

  it.each(['degraded', 'error', 'disconnected'])('does not show a green account line for %s even with a cached account label', async kind => {
    const page = loadConnectorsPage({ instances: [connectedInstance({
      status: { kind, message: kind === 'disconnected' ? '' : 'unavailable' },
      oauth_grant: { account_label: 'cached@example.com' },
    })] });
    await page.context.loadConnectors();
    const card = page.document.querySelector('.connector-card[data-id="tencent-meeting"]')!;
    expect(card.querySelector('.connector-card-account')).toBeNull();
    expect(card.querySelector('[data-act="use-connector"]')).toBeNull();
    expect(card.querySelector('[data-act="open-popup"]')).not.toBeNull();
  });
});

describe('Tencent Meeting usage popup (CONN-PV-003)', () => {
  it('keeps the grid visible, restores focus on close, and can reopen from the card', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openPopup(page);
    expect(page.view('connectors-grid-view').style.display).toBe('');
    expect(page.popup().textContent).toContain('腾讯会议');
    expect(page.popup().textContent).toContain(TENCENT_ENTRY.description_zh);
    expect(page.invokedChannels).not.toContain('connectors.start_oauth');
    await page.context.loadConnectors(); // card rerender while the popup is open
    page.popup().querySelector('[data-ui-modal-close]')!.click();
    await sleep();
    expect(page.popup()).toBeNull();
    const button = page.document.querySelector('[data-act="open-popup"]')!;
    expect(button.focused).toBe(true);
    button.click();
    expect(page.popup()).not.toBeNull();
  });

  it.each(['query', 'summary', 'schedule'])('prefills %s and selects the connector without sending', async key => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openPopup(page);
    page.popup().querySelector(`[data-example="${key}"]`)!.click();
    expect(page.popup()).toBeNull();
    expect(page.view('new-chat-input').value).toBe('connectors.tencent.examples.' + key);
    expect(page.context.setChatConnector).toHaveBeenCalledWith('new-chat', 'tencent-meeting', '腾讯会议');
    expect(page.setView).toHaveBeenCalledWith('new-chat');
    expect(page.invokedChannels.some(channel => /send|chat|dispatch/.test(channel))).toBe(false);
  });

  it('starts a blank conversation from the primary action', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    page.view('new-chat-input').value = 'previous text';
    await openPopup(page);
    page.popup().querySelector('[data-act="use-connector"]')!.click();
    expect(page.view('new-chat-input').value).toBe('');
    expect(page.popup()).toBeNull();
  });

  it('toggles enable without disconnecting and updates the examples and primary action', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openPopup(page);
    page.popup().querySelector('[data-act="toggle-enabled"]')!.click();
    await sleep();
    expect(page.invokedChannels).toContain('connectors.set_enabled');
    expect(page.invokedChannels).not.toContain('connectors.remove');
    expect(page.popup().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(page.popup().querySelector('[data-act="use-connector"]')!.disabled).toBe(true);
    expect(page.popup().querySelector('[data-act="example"]')!.disabled).toBe(true);
    expect(page.popup().textContent).toContain('connectors.popup.disabled');
    page.popup().querySelector('[data-act="toggle-enabled"]')!.click();
    await sleep();
    expect(page.popup().querySelector('[data-act="example"]')!.disabled).toBe(false);
  });

  it('previews examples when disconnected and only connects on an explicit action', async () => {
    const page = loadConnectorsPage();
    await openPopup(page);
    expect(page.popup().querySelectorAll('[data-act="example"]')).toHaveLength(3);
    expect(page.popup().querySelector('[data-act="example"]')!.disabled).toBe(true);
    expect(page.popup().querySelector('[role="switch"]')).toBeNull();
    expect(page.invokedChannels).not.toContain('connectors.start_oauth');
    page.popup().querySelector('[data-act="connect"]')!.click();
    await sleep();
    expect(page.invokedChannels).toContain('connectors.start_oauth');
  });

  it('keeps the connection enabled after a toggle failure and reports it without a nested dialog', async () => {
    const instance = connectedInstance();
    const page = loadConnectorsPage({ invoke: async channel => {
      if (channel === 'connectors.catalog') return { ok: true, catalog: [TENCENT_ENTRY] };
      if (channel === 'connectors.list') return { ok: true, instances: [instance] };
      return { ok: false, error: 'offline' };
    } });
    await openPopup(page);
    page.popup().querySelector('[data-act="toggle-enabled"]')!.click();
    await sleep();
    expect(page.popup().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    expect(page.popup().querySelector('[data-act="example"]')!.disabled).toBe(false);
    expect(page.toasts).toContainEqual({ message: 'offline', variant: 'error' });
    expect(page.alerts).toEqual([]);
  });

  it('shows only supplied account metadata and keeps it as text', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance({ oauth_grant: { account_label: '<fake@example.com>' } })] });
    await openPopup(page);
    expect(page.popup().querySelector('.connector-popup-status')!.textContent).toContain('&lt;fake@example.com&gt;');
    expect(page.popup().querySelector('fake')).toBeNull();
  });

  it.each(['degraded', 'error'])('shows a recovery action for %s without enabling examples', async kind => {
    const page = loadConnectorsPage({ instances: [connectedInstance({ status: { kind, message: 'offline' } })] });
    await openPopup(page);
    expect(page.popup().textContent).toContain('offline');
    expect(page.popup().querySelector('[data-act="example"]')!.disabled).toBe(true);
    expect(page.popup().querySelector(kind === 'degraded' ? '[data-act="retry-degraded"]' : '[data-act="connect"]')).not.toBeNull();
  });

  it('keeps CLI setup collapsed, with install recovery available', async () => {
    const entry = { ...TENCENT_ENTRY, availability: 'visible_disabled', disabled_reason: 'cli_missing', runtime_installable: true,
      setup: { install_command: 'install cli', steps_zh: ['install'], steps_en: ['install'] } };
    const page = loadConnectorsPage({ catalog: [entry] });
    await openPopup(page);
    expect(page.popup().querySelector('.ui-accordion__item')!.hasAttribute('open')).toBe(false);
    expect(page.popup().textContent).toContain('connectors.runtime.install_connect');
    expect(page.popup().querySelector('[data-act="connect"]')!.disabled).toBe(false);
  });

  it('opens authorization recovery in the popup, copies its URL and cancels the attempt', async () => {
    const page = loadConnectorsPage();
    await page.context.loadConnectors();
    page.push('connectors:authorization-url', { catalog_id: 'tencent-meeting', url: 'https://meeting.tencent.com/auth?code=abc' });
    expect(page.popup().textContent).toContain('connectors.popup.authorizing.title');
    page.popup().querySelector('[data-act="copy-auth-url"]')!.click();
    await sleep();
    expect(page.clipboard.writeText).toHaveBeenCalledWith('https://meeting.tencent.com/auth?code=abc');
    page.popup().querySelector('[data-act="cancel-authorization"]')!.click();
    await sleep();
    expect(page.invokedChannels).toContain('connectors.cancel_oauth');
    page.push('connectors:oauth-result', { catalog_id: 'tencent-meeting', attempt_id: 'attempt-1', result: 'failure', code: 'user_cancelled' });
    expect(page.popup().querySelector('[data-act="copy-auth-url"]')).toBeNull();
    expect(page.popup().querySelector('[data-act="connect"]')).not.toBeNull();
  });

  it.each([true, false])('confirms disconnect and reopens with the resulting state (confirm=%s)', async answer => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    page.confirmAnswer.value = answer;
    await openPopup(page);
    page.popup().querySelector('[data-act="more"]')!.click();
    expect(page.popup().querySelector('[data-ui-modal-popover]')!.hidden).toBe(false);
    page.popup().querySelector('[data-act="disconnect"]')!.click();
    await sleep();
    expect(page.confirmations).toHaveLength(1);
    expect(page.invokedChannels.includes('connectors.remove')).toBe(answer);
    expect(page.popup().querySelector(answer ? '[data-act="connect"]' : '[data-act="use-connector"]')).not.toBeNull();
  });
});


const NEW_POPUP_PROVIDERS = [
  ['email-163', 'email'], ['email-enterprise', 'email'], ['email-qq', 'email'],
  ['wps', 'wps'], ['wecom', 'wecom'], ['tencent-docs', 'tencent_docs'],
  ['tencent-survey', 'survey'], ['dingtalk', 'dingtalk'], ['feishu', 'feishu'],
];

describe('enterprise connector usage popups', () => {
  it.each(NEW_POPUP_PROVIDERS)('previews %s while disconnected without starting authorization', async (id, profile) => {
    const entry = CONNECTOR_CATALOG.find(row => row.id === id)!;
    const page = loadConnectorsPage({ catalog: [entry] });
    await openPopup(page, id);
    expect(page.popup().querySelectorAll('[data-act="example"]')).toHaveLength(3);
    expect(page.popup().querySelector('[data-act="example"]')!.textContent).toContain('connectors.popup.' + profile + '.examples.query');
    expect(page.popup().querySelector('[data-act="example"]')!.disabled).toBe(true);
    expect(page.popup().querySelector('[data-act="connect"]')!.textContent).toContain('connectors.action.connect');
    expect(page.popup().querySelector('[data-act="use-connector"]')).toBeNull();
    expect(page.popup().textContent).not.toContain('connectors.tencent.connected.note');
    expect(page.invokedChannels.filter(channel => channel === 'connectors.start_oauth' || channel === 'connectors.prepare_runtime')).toEqual([]);
    if (entry.auth_mode === 'credentials') expect(page.popup().querySelector('.ui-modal__title')!.textContent).toBe('connectors.email.' + id);
    page.popup().querySelector('[data-ui-modal-close]')!.click();
    await sleep();
    expect(page.popup()).toBeNull();
  });

  it.each(NEW_POPUP_PROVIDERS)('uses %s with its own example and connection', async (id, profile) => {
    const entry = CONNECTOR_CATALOG.find(row => row.id === id)!;
    const page = loadConnectorsPage({ catalog: [entry], instances: [connectedInstance({ id, email_settings: { address: 'someone@example.com' } })] });
    await openPopup(page, id);
    expect(page.popup().querySelector('.connector-popup-status')!.textContent).toContain('someone@example.com');
    page.popup().querySelector('[data-example="query"]')!.click();
    expect(page.popup()).toBeNull();
    expect(page.view('new-chat-input').value).toBe('connectors.popup.' + profile + '.examples.query');
    expect(page.context.setChatConnector.mock.calls[0][1]).toBe(id);
    expect(page.invokedChannels).not.toContain('connectors.start_oauth');
  });

  it.each(['feishu', 'dingtalk', 'wecom'])('offers installation from the disconnected %s popup', async id => {
    const entry = { ...CONNECTOR_CATALOG.find(row => row.id === id)!, availability: 'visible_disabled', disabled_reason: 'cli_missing', runtime_installable: true };
    const page = loadConnectorsPage({ catalog: [entry] });
    await openPopup(page, id);
    const connect = page.popup().querySelector('[data-act="connect"]')!;
    expect(connect.textContent).toContain('connectors.runtime.install_connect');
    expect(connect.disabled).toBe(false);
    connect.click();
    await sleep();
    expect(page.invokedChannels).toContain('connectors.prepare_runtime');
    expect(page.invokedChannels).not.toContain('connectors.start_oauth');
  });

  it('keeps browser authorization visible after acceptance, even without a URL event', async () => {
    const entry = CONNECTOR_CATALOG.find(row => row.id === 'wps')!;
    const page = loadConnectorsPage({ invoke: async channel => {
      if (channel === 'connectors.catalog') return { ok: true, catalog: [entry] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      if (channel === 'connectors.start_oauth') return { ok: true, started: true, attempt_id: 'wps-auth' };
      return { ok: true };
    } });
    await openPopup(page, entry.id);
    page.popup().querySelector('[data-act="connect"]')!.click();
    await sleep();
    expect(page.popup().textContent).toContain('connectors.popup.authorizing.title');
    expect(page.popup().querySelector('[data-act="cancel-authorization"]')).not.toBeNull();
    expect(page.popup().querySelector('[data-act="connect"]')).toBeNull();
    page.push('connectors:oauth-result', { catalog_id: entry.id, attempt_id: 'wps-auth', result: 'failure', code: 'user_cancelled' });
    await sleep();
    expect(page.popup().querySelector('[data-act="cancel-authorization"]')).toBeNull();
    expect(page.popup().querySelector('[data-act="connect"]')).not.toBeNull();
  });

  it.each(['email-163', 'email-qq', 'tencent-docs'])('hands %s connection off to one credential modal and returns on cancel', async id => {
    const entry = CONNECTOR_CATALOG.find(row => row.id === id)!;
    const page = loadConnectorsPage({ catalog: [entry] });
    await openPopup(page, id);
    page.popup().querySelector('[data-act="connect"]')!.click();
    await sleep();
    expect(page.popup()).toBeNull();
    expect(page.document.querySelectorAll('.ui-modal')).toHaveLength(1);
    const modal = page.document.querySelector('.ui-modal')!;
    expect(modal.querySelector(id === 'tencent-docs' ? '#connector-token' : '#email-password')!.getAttribute('type')).toBe('password');
    modal.querySelector('[data-ui-modal-close]')!.click();
    await sleep();
    expect(page.document.querySelectorAll('.ui-modal')).toHaveLength(1);
    expect(page.popup().querySelector('[data-act="connect"]')).not.toBeNull();
    expect(page.invokedChannels).not.toContain('connectors.connect_email');
    expect(page.invokedChannels).not.toContain('connectors.connect_interactive_token');
  });
});

describe('managed connector preparation on the real connectors page', () => {
  function missing(id: string) {
    return { ...CONNECTOR_CATALOG.find(e => e.id === id)!, availability: 'visible_disabled', disabled_reason: 'cli_missing', runtime_installable: true };
  }

  it.each(['feishu', 'dingtalk', 'wecom'])('prepares %s with progress before starting authorization', async (id) => {
    const entry = missing(id);
    let ready = false;
    let finish!: (result: unknown) => void;
    const preparation = new Promise(resolve => { finish = resolve; });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.catalog') return { ok: true, catalog: [ready ? { ...entry, availability: 'enabled', disabled_reason: undefined, runtime_installable: undefined } : entry] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      if (channel === 'connectors.prepare_runtime') return preparation;
      if (channel === 'connectors.start_oauth') return { ok: true, started: true, attempt_id: 'auth-1' };
      return { ok: true };
    });
    const page = loadConnectorsPage({ invoke });
    await page.context.loadConnectors();
    const grid = () => page.view('connectors-grid-available');
    expect(grid().textContent).toContain('connectors.runtime.install_connect');
    expect(grid().textContent).not.toContain('connectors.tencent.runtime_unavailable');
    const connecting = page.context._runConnect(entry);
    await page.context._runConnect(entry);
    expect(invoke.mock.calls.filter(([c]) => c === 'connectors.prepare_runtime')).toHaveLength(1);
    expect(invoke.mock.calls.some(([c]) => c === 'connectors.start_oauth')).toBe(false);
    const cancel = grid().querySelector('[data-act="cancel-runtime"]')!;
    cancel.focus();
    page.push('connectors:runtime-progress', { user_id: 'u-tencent', catalog_id: id, phase: 'downloading', percent: 42 });
    expect(grid().textContent).toContain('42%');
    expect(grid().querySelector('[data-act="cancel-runtime"]')).toBe(cancel);
    expect(cancel.focused).toBe(true);
    ready = true;
    finish({ ok: true, ready: true });
    await connecting;
    expect(invoke.mock.calls.filter(([c]) => c === 'connectors.start_oauth')).toHaveLength(1);
  });

  it.each(['connector_runtime_integrity_failed', 'connector_runtime_cancelled', 'connector_runtime_download_failed'])('does not authorize after %s and exposes a retry', async (code) => {
    const entry = missing('wecom');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.catalog') return { ok: true, catalog: [entry] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      if (channel === 'connectors.prepare_runtime') return { ok: false, code };
      return { ok: true };
    });
    const page = loadConnectorsPage({ invoke });
    await page.context.loadConnectors();
    await page.context._runConnect(entry);
    expect(invoke.mock.calls.some(([c]) => c === 'connectors.start_oauth')).toBe(false);
    expect(page.view('connectors-grid-available').textContent).toContain('connectors.runtime.retry');
    await page.context._runConnect(entry);
    expect(invoke.mock.calls.filter(([c]) => c === 'connectors.prepare_runtime')).toHaveLength(2);
  });

  it('does not continue authorization under an account selected during the download', async () => {
    const entry = missing('feishu');
    let finish!: (result: unknown) => void;
    const preparation = new Promise(resolve => { finish = resolve; });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'connectors.catalog') return { ok: true, catalog: [entry] };
      if (channel === 'connectors.list') return { ok: true, instances: [] };
      if (channel === 'connectors.prepare_runtime') return preparation;
      return { ok: true };
    });
    const page = loadConnectorsPage({ invoke });
    await page.context.loadConnectors();
    const connecting = page.context._runConnect(entry);
    page.context.currentUserId = 'another-user';
    finish({ ok: true, ready: true });
    await connecting;
    expect(invoke.mock.calls.some(([c]) => c === 'connectors.start_oauth')).toBe(false);
  });
});
