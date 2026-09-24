/**
 * Tencent Meeting connector detail view — real-page integration.
 *
 * The MCP与工具 tab used to stop at a card grid: a connected connector had nothing to say about
 * what to do next, and the connection flow itself (`local_cli`) produces its authorization URL on
 * this machine, so a failed browser launch left the user with no way forward. This file drives the
 * real `modules/connectors.js` (plus the real shared primitives from `icons.js` / `ui-button.js` /
 * `ui-card.js` / `ui-status.js` / `ui-empty.js`) against a minimal DOM and pins:
 *
 *   - grid ⇄ detail entry and exit, including focus return to the originating card action;
 *   - the three-step indicator's two states, derived from the live `connected` state;
 *   - `查看会议资料` staying visible, disabled, and explained;
 *   - the `cli_missing` branch not falling through to the generic "暂不支持" copy;
 *   - the CTA landing on the automation page with the meeting-digest template pre-filled;
 *   - `connectors:authorization-url` becoming a copyable fallback.
 *
 * The DOM is hand-rolled because this repository has no jsdom dependency and the renderer is
 * classic-script only: the existing convention (see `connectors-degraded-card.test.ts`) is a `vm`
 * context. This file needs *structural* queries because the detail view is assembled from generated
 * markup, so instead of stubbing selectors it parses the markup the module produces.
 */
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
    stack[stack.length - 1].children.push(node);
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
  'connectors-detail-view',
  'connectors-detail-topbar',
  'connectors-detail-body',
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
    'src/renderer/modules/ui-status.js',
    'src/renderer/modules/ui-empty.js',
  ]) {
    vm.runInContext(readModule(module), context, { filename: path.basename(module) });
  }
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

async function openDetail(page: ReturnType<typeof loadConnectorsPage>) {
  await page.context.loadConnectors();
  const card = page.view('connectors-grid-connected').querySelector('.connector-card[data-id="tencent-meeting"]')
    || page.view('connectors-grid-available').querySelector('.connector-card[data-id="tencent-meeting"]');
  const button = card!.querySelector('[data-act="open-detail"]')!;
  button.click();
  return { card: card!, button };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('connector detail view — Tencent Meeting (registry CONN-PV-001)', () => {
  it('enters from the card action, leaves on the back button, and returns focus to the card', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    const { button } = await openDetail(page);

    expect(page.view('connectors-grid-view').style.display).toBe('none');
    expect(page.view('connectors-detail-view').style.display).toBe('');
    // Entry moves focus into the detail so the keyboard is never stranded on a hidden grid.
    const backControl = page.view('connectors-detail-topbar').querySelector('[data-connectors-detail-back]');
    expect(backControl?.focused).toBe(true);
    expect(button.focused).toBe(false);

    const body = page.view('connectors-detail-body');
    expect(body.textContent).toContain('腾讯会议');
    expect(body.textContent).toContain('连接账号，读取有权访问的会议转写。');

    page.view('connectors-detail-topbar').querySelector('[data-connectors-detail-back]')!.click();

    expect(page.view('connectors-grid-view').style.display).toBe('');
    expect(page.view('connectors-detail-view').style.display).toBe('none');
    expect(page.view('connectors-detail-body').innerHTML).toBe('');
    // The grid repaint rebuilds the card, so focus lands on the same control on the new node.
    const refreshed = page.view('connectors-grid-connected')
      .querySelector('.connector-card[data-id="tencent-meeting"]')
      ?.querySelector('[data-act="open-detail"]');
    expect(refreshed?.focused).toBe(true);
  });

  it('leaves on Escape (IME-safe) and ignores composition keydown', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);

    page.emitDocumentKeydown({ key: 'Escape', isComposing: true, keyCode: 0, target: null });
    page.emitDocumentKeydown({ key: 'Escape', isComposing: false, keyCode: 229, target: null });
    expect(page.view('connectors-detail-view').style.display).toBe('');

    page.emitDocumentKeydown({ key: 'Escape', isComposing: false, keyCode: 0, target: null });
    expect(page.view('connectors-detail-view').style.display).toBe('none');
    expect(page.view('connectors-grid-view').style.display).toBe('');
  });

  it('leaves Escape alone once the MCP pane is no longer the visible surface', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);

    // Switching the MCP sub-view to 插件 hides the pane; the selection survives, but Escape now
    // belongs to the surface that replaced it.
    page.view('connections-pane-mcp').hidden = true;
    page.emitDocumentKeydown({ key: 'Escape', isComposing: false, keyCode: 0, target: null });
    expect(page.view('connectors-detail-view').style.display).toBe('');

    page.view('connections-pane-mcp').hidden = false;
    page.emitDocumentKeydown({ key: 'Escape', isComposing: false, keyCode: 0, target: null });
    expect(page.view('connectors-detail-view').style.display).toBe('none');
  });

  it('keeps an open shared modal in charge of its own Escape', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);

    const overlay = new FakeNode('div');
    overlay.attrs.class = 'ui-modal-overlay';
    const inside = new FakeNode('button');
    overlay.appendChild(inside);
    page.emitDocumentKeydown({ key: 'Escape', isComposing: false, keyCode: 0, target: inside });

    expect(page.view('connectors-detail-view').style.display).toBe('');
  });

  it('renders the three-step indicator from live state, without a new persisted field', async () => {
    const disconnected = loadConnectorsPage({ instances: [] });
    await openDetail(disconnected);
    const before = disconnected.view('connectors-detail-body').querySelectorAll('.connectors-detail-step');
    expect(before).toHaveLength(3);
    expect(before[0].textContent).toContain('connectors.tencent.step.before');
    expect(before[0].textContent).toContain('connectors.tencent.step.done');
    expect(before[1].textContent).toContain('connectors.tencent.step.authorize');
    expect(before[2].textContent).toContain('connectors.tencent.step.connected');
    expect(before[1].getAttribute('aria-current')).toBe('step');
    expect(before.map((step) => step.className)).toEqual([
      'connectors-detail-step is-done',
      'connectors-detail-step is-current',
      'connectors-detail-step is-todo',
    ]);
    expect(disconnected.view('connectors-detail-body').querySelector('.connectors-detail-steps')!.getAttribute('aria-label'))
      .toBe('connectors.tencent.steps.aria');

    const connected = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(connected);
    const after = connected.view('connectors-detail-body').querySelectorAll('.connectors-detail-step');
    expect(after.map((step) => step.className)).toEqual([
      'connectors-detail-step is-done',
      'connectors-detail-step is-done',
      'connectors-detail-step is-current',
    ]);
    expect(after[2].getAttribute('aria-current')).toBe('step');
    expect(after[0].getAttribute('aria-current')).toBeNull();
  });

  it('shows the connected status card, the automation CTA and its note', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);
    const body = page.view('connectors-detail-body');

    expect(body.textContent).toContain('connectors.tencent.connected.title');
    expect(body.textContent).toContain('connectors.tencent.connected.desc');
    expect(body.textContent).toContain('connectors.tencent.connected.note');
    const cta = body.querySelector('[data-act="create-automation"]');
    expect(cta).not.toBeNull();
    expect(cta!.className).toContain('ui-button--primary');
    expect(body.textContent).toContain('connectors.tencent.status.title');
    expect(body.textContent).toContain('connectors.tencent.status.scope');
    expect(body.querySelector('.ui-status-pill')?.textContent).toContain('connectors.tencent.status.connected');
    // Both panels go through the shared card shell rather than page-local markup.
    expect(body.querySelectorAll('.ui-resource-card.connectors-detail-panel')).toHaveLength(2);
  });

  it('describes a degraded or errored connector honestly instead of as not connected yet', async () => {
    // Same invariant the degraded card enforces: an installed-but-unreachable connector must not
    // tell the user to do the thing they already did.
    const degraded = loadConnectorsPage({
      instances: [connectedInstance({
        status: {
          kind: 'degraded',
          message: 'refresh HTTP 503',
          at: Date.now(),
          last_verified_at: Date.now() - 60 * 60 * 1000,
        },
      })],
    });
    await openDetail(degraded);
    const body = degraded.view('connectors-detail-body');
    expect(body.textContent).toContain('connectors.status.unverified');
    expect(body.textContent).not.toContain('connectors.tencent.connected.title');
    expect(body.textContent).not.toContain('connectors.tencent.pending.title');
    expect(body.querySelector('[data-act="retry-degraded"]')).not.toBeNull();
    expect(body.querySelector('[data-act="create-automation"]')).toBeNull();
    expect(body.querySelector('.ui-status-pill--attention')).not.toBeNull();

    const errored = loadConnectorsPage({
      instances: [connectedInstance({
        status: { kind: 'error', message: 'spawn ENOENT', at: Date.now() },
      })],
    });
    await openDetail(errored);
    const erroredBody = errored.view('connectors-detail-body');
    expect(erroredBody.textContent).toContain('connectors.status.error');
    expect(erroredBody.textContent).not.toContain('connectors.tencent.pending.title');
    expect(erroredBody.querySelector('[data-act="disconnect"]')).not.toBeNull();
    expect(erroredBody.querySelector('.ui-status-pill--critical')).not.toBeNull();
  });

  it('renders 查看会议资料 as a disabled control with a visible reason', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);
    const body = page.view('connectors-detail-body');

    const link = body.querySelector('[data-act="view-materials"]');
    expect(link).not.toBeNull();
    expect(link!.hasAttribute('disabled')).toBe(true);
    expect(link!.getAttribute('aria-disabled')).toBe('true');
    expect(body.textContent).toContain('connectors.tencent.status.view_materials');
    expect(body.textContent).toContain('connectors.tencent.status.view_materials_soon');
    // Not hidden, and not a navigation control that could go nowhere.
    expect(page.invokedChannels).not.toContain('meeting.materials');
    expect(page.setView).not.toHaveBeenCalled();

    link!.click();
    expect(page.setView).not.toHaveBeenCalled();
    expect(page.invokedChannels.filter((channel) => channel !== 'connectors.catalog' && channel !== 'connectors.list'))
      .toEqual([]);
  });

  it('reports the missing local CLI instead of the generic unsupported message', async () => {
    const cliMissing = {
      ...TENCENT_ENTRY,
      availability: 'visible_disabled',
      disabled_reason: 'cli_missing',
    };
    const page = loadConnectorsPage({ catalog: [cliMissing], instances: [] });
    await page.context.loadConnectors();

    const card = page.view('connectors-grid-available')
      .querySelector('.connector-card[data-id="tencent-meeting"]')!;
    expect(card.querySelector('.connector-card-cli-missing')!.textContent)
      .toBe('connectors.toast.cli_missing');
    expect(card.innerHTML).not.toContain('connectors.toast.unsupported');

    await page.context._runConnect(cliMissing);
    expect(page.toasts.map((toast) => toast.message)).toEqual(['connectors.toast.cli_missing']);

    const { button } = await openDetail(page);
    expect(button).not.toBeNull();
    const body = page.view('connectors-detail-body');
    expect(body.textContent).toContain('connectors.tencent.cli_missing.title');
    expect(body.textContent).toContain('connectors.tencent.cli_missing.desc');
    expect(body.querySelector('[data-act="create-automation"]')).toBeNull();
    expect(body.querySelector('[data-act="connect"]')!.hasAttribute('disabled')).toBe(true);
  });

  it('still routes the remote-config unsupported case through the generic toast', async () => {
    const unsupported = {
      ...TENCENT_ENTRY,
      availability: 'visible_disabled',
      disabled_reason: 'unsupported',
    };
    const page = loadConnectorsPage({ catalog: [unsupported], instances: [] });
    await page.context.loadConnectors();
    await page.context._runConnect(unsupported);
    expect(page.toasts.map((toast) => toast.message)).toEqual(['connectors.toast.unsupported']);
  });

  it('sends 创建会议自动化 to the automation page with the meeting-digest template', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);

    page.view('connectors-detail-body').querySelector('[data-act="create-automation"]')!.click();
    await sleep();

    expect(page.setView).toHaveBeenCalledWith('auto');
    expect(page.loadRendererFeature).toHaveBeenCalledWith('auto');
    expect(page.applyAutoTemplate).toHaveBeenCalledWith('meeting_digest');
    // `_autoApplyTemplate` opens the dialog itself — calling both would open it twice.
    expect(page.openAutoTaskDialog).not.toHaveBeenCalled();
  });

  it('turns connectors:authorization-url into a copyable fallback', async () => {
    const page = loadConnectorsPage({ instances: [] });
    await openDetail(page);

    page.push('connectors:authorization-url', {
      catalog_id: 'tencent-meeting',
      url: 'https://meeting.tencent.com/auth?code=abc',
    });

    const body = page.view('connectors-detail-body');
    expect(body.textContent).toContain('connectors.tencent.auth_url.label');
    expect(body.textContent).toContain('https://meeting.tencent.com/auth?code=abc');

    body.querySelector('[data-act="copy-auth-url"]')!.click();
    await sleep();
    expect(page.clipboard.writeText).toHaveBeenCalledWith('https://meeting.tencent.com/auth?code=abc');
    expect(page.toasts.map((toast) => toast.message)).toContain('connectors.tencent.auth_url.copied');
  });

  it('opens the detail view for the authorization URL when only the grid is showing', async () => {
    const page = loadConnectorsPage({ instances: [] });
    await page.context.loadConnectors();

    page.push('connectors:authorization-url', {
      catalog_id: 'tencent-meeting',
      url: 'https://meeting.tencent.com/auth?code=grid',
    });

    expect(page.view('connectors-detail-view').style.display).toBe('');
    expect(page.view('connectors-detail-body').textContent)
      .toContain('https://meeting.tencent.com/auth?code=grid');
  });

  it('disconnects through connectors.remove only, and repaints the detail as not connected', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);

    page.view('connectors-detail-body').querySelector('[data-act="disconnect"]')!.click();
    await sleep();
    await sleep();

    expect(page.confirmations).toHaveLength(1);
    expect(page.invokedChannels).toContain('connectors.remove');
    // A disconnect is our instance being dropped — never a provider CLI logout.
    expect(page.invokedChannels.filter((channel) => /logout|signout|auth\./i.test(channel))).toEqual([]);
    expect(page.view('connectors-detail-view').style.display).toBe('');
    expect(page.view('connectors-detail-body').textContent)
      .toContain('connectors.tencent.pending.title');
  });

  it('discloses the connector help text through the shared alert, not a page-local overlay', async () => {
    const page = loadConnectorsPage({ instances: [connectedInstance()] });
    await openDetail(page);

    const help = page.view('connectors-detail-topbar').querySelector('[data-connectors-detail-help]')!;
    expect(help.getAttribute('aria-label')).toBe('connectors.tencent.help_label');
    expect(help.getAttribute('title')).toBe('connectors.tencent.help');
    expect(help.querySelector('svg')?.getAttribute('class')).toContain('is-info');

    help.click();
    expect(page.alerts).toEqual(['connectors.tencent.help']);
    expect(page.view('connectors-detail-view').querySelectorAll('.ui-modal-overlay')).toHaveLength(0);
  });

  it('adds no raw controls and no literal layer declarations with the detail view', () => {
    const source = readModule('src/renderer/modules/connectors.js');
    expect(source.match(/<(?:button|input|textarea|select)\b/gi)).toHaveLength(2);
    expect(source).not.toMatch(/z-index\s*:/i);
    expect(source).toContain('uiCard({');
    expect(source).toContain('uiStatusPill({');
    expect(source).toContain("uiIconHtml('check-circle'");
    // The detail view is registered as a proposal in the same change.
    expect(readModule('docs/renderer-structural-registry.md')).toContain('`CONN-PV-001`');
    expect(readModule('docs/renderer-structural-registry.md')).toContain('**Status**: `Proposed`');
  });

  it('relaxes the shared card width cap with enough specificity to survive stylesheet order', () => {
    // `ui-components.css` is linked after `style.css`, and `.ui-resource-card` caps width at
    // `--card-width-max` (400px). A single-class page rule would lose to it and render the status
    // panel as a narrow card, so the width relaxation has to stay page-scoped with a child
    // selector — the same shape `.connectors-grid > .connector-card` already uses.
    const css = readModule('src/renderer/style.css');
    expect(css).toMatch(/\.connectors-detail-column > \.connectors-detail-panel\s*{[^}]*max-width:\s*100%;/s);
    expect(readModule('src/renderer/index.html')).toMatch(/style\.css[\s\S]*ui-components\.css/);
  });

  it('does not restyle shared components or declare literal values from page CSS', () => {
    const css = readModule('src/renderer/style.css');
    const block = css.slice(
      css.indexOf('Connector detail view (registry CONN-PV-001)'),
      css.indexOf('Connect / configure modal'),
    );
    expect(block.length).toBeGreaterThan(0);
    // Comments name the shared shells on purpose; the selectors must not touch them.
    const selectors = block.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(selectors).not.toMatch(/\.ui-/);
    expect(selectors).not.toMatch(/z-index\s*:/);
    expect(selectors).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(selectors).not.toMatch(/font-size:\s*[\d.]+px/);
    expect(selectors).not.toMatch(/border-radius:\s*[\d.]+px/);
  });

  it('declares the meeting-digest template and exposes the pre-fill seam', () => {
    const auto = readModule('src/renderer/modules/auto.js');
    expect(auto).toContain("{ id: 'meeting_digest'");
    expect(auto).toContain('window.applyAutoTemplate = _autoApplyTemplate;');
    const templates = auto.slice(auto.indexOf('const _AUTO_TEMPLATES'), auto.indexOf('];', auto.indexOf('const _AUTO_TEMPLATES')));
    expect(templates.indexOf("'meeting_prep'")).toBeLessThan(templates.indexOf("'meeting_digest'"));
    // Assert the entry's *values*, not its whitespace: pinning the exact source line made the test
    // fail on a purely cosmetic column-alignment edit, which is a false alarm rather than a
    // regression. The post-meeting hour and the distinct icon are what the contract actually says.
    const digestLine = templates
      .split('\n')
      .find((line) => line.includes("id: 'meeting_digest'"));
    expect(digestLine, 'meeting_digest entry exists in _AUTO_TEMPLATES').toBeTruthy();
    expect(digestLine).toMatch(/icon:\s*'clipboard-list'/);
    expect(digestLine).toMatch(/schedule:\s*\{\s*type:\s*'daily',\s*hour:\s*19,\s*minute:\s*0\s*\}/);
    for (const lang of ['en', 'ja', 'pt', 'zh']) {
      const locale = JSON.parse(readModule(`src/renderer/locales/${lang}.json`));
      for (const suffix of ['name', 'desc', 'title', 'seed']) {
        expect(locale[`auto.tpl.meeting_digest.${suffix}`], `${lang} ${suffix}`).toBeTruthy();
      }
    }
  });
});
