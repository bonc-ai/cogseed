import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/** Minimal DOM stand-in: enough for `_renderCatalogCard`'s createElement → innerHTML → querySelector
 *  path, and for asserting the rendered text. Mirrors the harness in connectors-render-cache.test.ts. */
function makeElement(tag: string): any {
  const el: any = {
    tagName: tag,
    className: '',
    classList: {
      add: (...names: string[]) => { el.className = [el.className, ...names].filter(Boolean).join(' '); },
    },
    dataset: {},
    style: {},
    children: [] as any[],
    _html: '',
    textContent: '',
    title: '',
    get innerHTML() { return el._html; },
    set innerHTML(v: string) { el._html = v; },
    appendChild: (c: any) => { el.children.push(c); return c; },
    addEventListener: () => {},
    setAttribute: () => {},
    closest: () => null,
    // The card looks up `.connector-card-unverified` / `-error` / `-account` / `-name` / `-desc`.
    // Hand back a stub per selector and remember it so the test can read what was written.
    querySelector: (sel: string) => {
      if (!el._q) el._q = new Map<string, any>();
      if (!el._q.has(sel)) el._q.set(sel, { textContent: '', title: '' });
      return el._q.get(sel);
    },
    querySelectorAll: () => [],
  };
  return el;
}

function loadConnectorsRenderer(
  invoke: (channel: string, payload: any) => Promise<any> = async () => ({ ok: true }),
) {
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/connectors.js'),
    'utf8',
  );
  const storage = new Map<string, string>();
  const alerts: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const errors: Array<[string, Record<string, unknown>]> = [];
  const pushHandlers = new Map<string, (payload: any) => void>();
  const monitor = {
    click: () => {},
    event: (name: string, data: Record<string, unknown>) => { events.push([name, data]); },
    error: (name: string, data: Record<string, unknown>) => { errors.push([name, data]); },
  };
  const context: any = {
    console,
    URL,
    setTimeout,
    setView: vi.fn(),
    setChatRecipient: vi.fn(),
    setChatConnector: vi.fn(),
    uiIconHtml: () => '<span></span>',
    performance: { now: () => 100 },
    currentUserId: 'u-degraded',
    currentView: 'connectors',
    globalThis: { currentUserId: 'u-degraded' },
    createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      key: (index: number) => Array.from(storage.keys())[index] || null,
      get length() { return storage.size; },
    },
    document: {
      createElement: (tag: string) => makeElement(tag),
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1200,
      innerHeight: 800,
      Monitor: monitor,
      cogseed: {
        invoke,
        onPushEvent: (channel: string, handler: (payload: any) => void) => { pushHandlers.set(channel, handler); },
      },
    },
    Monitor: monitor,
    uiAlert: (message: string) => { alerts.push(message); },
    // Echo the key so assertions can match on it without depending on locale copy.
    t: (key: string, params?: Record<string, unknown>) =>
      (params && 'n' in params ? `${key}:${params.n}` : key),
    getLang: () => 'zh',
    pickDesc: (entry: any) => entry?.description_zh || entry?.description_en || '',
    formatChatUseLabel: ({ name }: { name: string }) => name,
    sanitizeSvgIconHtml: () => '',
    escapeHtml: (value: unknown) => String(value ?? ''),
  };
  context.window.window = context.window;
  context.window.globalThis = context.globalThis;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-status.js'), 'utf8'), context);
  context.uiStatusDot = context.window.uiStatusDot;
  vm.runInContext(code, context, { filename: 'connectors.js' });
  // `_connectorsState` is a top-level `let`, so it is NOT a property of the context object (only
  // function declarations are). Reach it by running code inside the context instead.
  context.__setInstances = (list: unknown[]) => {
    context.__pending = list;
    vm.runInContext('_connectorsState.instances = __pending;', context);
  };
  context.__alerts = alerts;
  context.__events = events;
  context.__errors = errors;
  context.__emitPush = (channel: string, payload: any) => pushHandlers.get(channel)?.(payload);
  return context;
}


const ENTRY = { id: 'tencent-survey', display_name: '腾讯问卷', icon_name: 'clipboard-list', auth_mode: 'provider_device', transport_template: { kind: 'streamable-http' } };
describe('Tencent Survey existing-card integration', () => {
 it('shows progress, cancel and copy link during authorization and clears all on timeout', async () => {
  const ctx = loadConnectorsRenderer(async () => ({ ok: true, started: true, attempt_id: 'survey-attempt' }));
  await ctx._runConnect(ENTRY);
  ctx.__emitPush('connectors:authorization-url', { catalog_id: ENTRY.id, url: 'https://wj.qq.com/oauth/authorize?code=test&nonce=1234' });
  let card = ctx._renderCatalogCard(ENTRY, null);
  expect(card.innerHTML).toContain('cancel-survey-auth'); expect(card.innerHTML).toContain('copy-auth-url');
  expect(card.innerHTML).not.toContain('use-connector');
  ctx.__emitPush('connectors:oauth-result', { catalog_id: ENTRY.id, attempt_id: 'survey-attempt', result: 'failure', code: 'flow_timeout' });
  card = ctx._renderCatalogCard(ENTRY, null);
  expect(card.innerHTML).not.toContain('cancel-survey-auth'); expect(card.innerHTML).not.toContain('copy-auth-url');
  expect(ctx.__alerts).toContain('connectors.survey.expired');
 });
 it('rejects non-provider auth URLs and never claims a team name that was not returned', async () => {
  const ctx = loadConnectorsRenderer(async () => ({ ok: true, started: true, attempt_id: 'a' }));
  await ctx._runConnect(ENTRY);
  ctx.__emitPush('connectors:authorization-url', { catalog_id: ENTRY.id, url: 'https://evil.test/oauth/authorize' });
  expect(ctx._renderCatalogCard(ENTRY, null).innerHTML).not.toContain('copy-auth-url');
  ctx.__emitPush('connectors:oauth-result', { catalog_id: ENTRY.id, attempt_id: 'a', result: 'success' });
  const inst = { id: ENTRY.id, status: { kind: 'connected' }, tools_cache: [], enabled: true };
  const card = ctx._renderCatalogCard(ENTRY, inst);
  expect(card.innerHTML).toContain('use-connector');
  ctx._useConnector(ENTRY, inst);
  expect(ctx.setView).toHaveBeenCalledWith('new-chat');
  expect(ctx.setChatConnector).toHaveBeenCalledWith('new-chat', 'tencent-survey', '腾讯问卷');
  expect(card.innerHTML).toContain('connectors.group.connected');
  expect(card.innerHTML).not.toContain('connectors.survey.team_scope');
  expect(ctx._renderCatalogCard(ENTRY, { ...inst, status: { kind: 'error', message: 'survey_reauthorize' } }).innerHTML).not.toContain('use-connector');
 });
});
