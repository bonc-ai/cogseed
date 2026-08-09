import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';


const source = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.js'), 'utf8');

type Listener = (event: unknown, payload?: unknown) => void;
type WindowListener = (event: Record<string, unknown>) => void;

interface FakeElement {
  id: string;
  hidden: boolean;
  disabled: boolean;
  style: { display: string };
  classList: {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
  };
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  hasAttribute: (name: string) => boolean;
  closest: (selector: string) => FakeElement | null;
}

function fakeElement(id: string, options: {
  attributes?: Record<string, string>;
  classes?: string[];
  hidden?: boolean;
  display?: string;
  closest?: (selector: string) => FakeElement | null;
} = {}): FakeElement {
  const attributes = new Map(Object.entries(options.attributes || {}));
  const classes = new Set(options.classes || []);
  const element: FakeElement = {
    id,
    hidden: options.hidden === true,
    disabled: false,
    style: { display: options.display || '' },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    hasAttribute: (name) => attributes.has(name),
    closest: (selector) => options.closest?.(selector) || null,
  };
  return element;
}

function loadPreload(bootResponse: unknown = null) {
  const exposed: Record<string, unknown> = {};
  const listeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<WindowListener>>();
  const mutationCallbacks: Array<() => void> = [];
  const panel = fakeElement('panel-agents', { classes: ['active'] });
  const detail = fakeElement('agents-detail-view');
  const host = fakeElement('agent-management-surface', { hidden: true });
  const elements = new Map<string, FakeElement>([
    [panel.id, panel],
    [detail.id, detail],
    [host.id, host],
  ]);
  const ipcRenderer = {
    sendSync: vi.fn(() => bootResponse),
    invoke: vi.fn(async (_channel: string, payload?: unknown) => ({ ok: true, payload })),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: Listener) => {
      const set = listeners.get(channel) || new Set<Listener>();
      set.add(listener);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
  const contextBridge = {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed[key] = value;
    }),
  };
  class FakeMutationObserver {
    constructor(callback: () => void) {
      mutationCallbacks.push(callback);
    }

    observe() {}

    disconnect() {}
  }
  const window = {
    addEventListener: vi.fn((type: string, listener: WindowListener) => {
      const set = windowListeners.get(type) || new Set<WindowListener>();
      set.add(listener);
      windowListeners.set(type, set);
    }),
  };
  const document = {
    readyState: 'complete',
    getElementById: (id: string) => elements.get(id) || null,
  };
  const sandbox = {
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`unexpected require: ${id}`);
      return { contextBridge, ipcRenderer, webUtils: undefined };
    },
    process: { argv: [] as string[] },
    window,
    document,
    MutationObserver: FakeMutationObserver,
    console,
    Date,
    Error,
    Promise,
    Object,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: 'preload.js' });
  const api = exposed.orkas as {
    invoke: (channel: string, payload?: unknown) => Promise<unknown>;
    stream: (channel: string, payload: unknown, onEvent?: (event: unknown) => void) => {
      promise: Promise<void>;
      cancel: () => void;
    };
    onPushEvent: (channel: string, handler: (payload: unknown) => void) => () => void;
    log: (record: unknown) => void;
    expenseWorkbench: {
      prepareOpen: (agentId: string, gesture: string) => Promise<Record<string, unknown>>;
      open: (agentId: string) => Promise<Record<string, unknown>>;
      status: () => Promise<Record<string, unknown>>;
      approveApplication: (
        applicationId: string,
        approvalRole: string,
        decision: string,
        expectedArtifactHash: string,
        comment: string,
      ) => Promise<Record<string, unknown>>;
      close: () => Promise<Record<string, unknown>>;
    };
  };
  const emit = (channel: string, payload?: unknown) => {
    for (const listener of [...(listeners.get(channel) || [])]) listener({}, payload);
  };
  const dispatchWindow = (type: string, event: Record<string, unknown>) => {
    for (const listener of [...(windowListeners.get(type) || [])]) listener(event);
  };
  const triggerMutations = () => {
    for (const callback of mutationCallbacks) callback();
  };
  return {
    api,
    emit,
    exposed,
    ipcRenderer,
    contextBridge,
    listeners,
    dispatchWindow,
    triggerMutations,
    elements: { panel, detail, host },
  };
}

const EXPENSE_AGENT_ID = 'c045605cb916';
const OPEN_TICKET = `ewopen_${'a'.repeat(43)}`;
const PAGE_INSTANCE = `ewpage_${'b'.repeat(43)}`;
const HOST_CAPABILITY = `ewcap_${'c'.repeat(43)}`;

function dispatchManageClick(
  preload: ReturnType<typeof loadPreload>,
  options: { agentId?: string; trusted?: boolean } = {},
): void {
  const button = fakeElement('agent-manage-btn', {
    attributes: {
      'data-expense-agent-id': options.agentId || EXPENSE_AGENT_ID,
      'aria-hidden': 'false',
    },
  });
  preload.dispatchWindow('click', {
    isTrusted: options.trusted !== false,
    button: 0,
    composedPath: () => [button],
    target: button,
  });
}

function mockExpenseHost(preload: ReturnType<typeof loadPreload>): void {
  preload.ipcRenderer.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'orkas.expenseWorkbenchHost.prepareOpen') {
      return {
        ok: true,
        open_ticket: OPEN_TICKET,
        page_instance: PAGE_INSTANCE,
        expires_at: '2026-08-04T00:00:15.000Z',
      };
    }
    if (channel === 'orkas.expenseWorkbenchHost.open') {
      return {
        ok: true,
        host_capability: HOST_CAPABILITY,
        management_surface: 'expense_workbench',
        expires_at: '2026-08-04T00:10:00.000Z',
      };
    }
    return { ok: true };
  });
}

async function authorizeExpenseWorkbench(preload: ReturnType<typeof loadPreload>) {
  mockExpenseHost(preload);
  dispatchManageClick(preload);
  const prepared = await preload.api.expenseWorkbench.prepareOpen(EXPENSE_AGENT_ID, 'agent_detail');
  preload.elements.host.hidden = false;
  const opened = await preload.api.expenseWorkbench.open(EXPENSE_AGENT_ID);
  return { prepared, opened };
}


describe('preload bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes a validated synchronous i18n bundle and rejects incomplete boot data', () => {
    const valid = loadPreload({ ok: true, lang: 'zh-CN', tables: { 'zh-CN': { hello: '你好' } } });
    expect(valid.exposed.__orkasI18nBoot).toEqual({
      lang: 'zh-CN', tables: { 'zh-CN': { hello: '你好' } },
    });

    const invalid = loadPreload({ ok: true, lang: 'en', tables: { 'zh-CN': {} } });
    expect(invalid.exposed.__orkasI18nBoot).toBeNull();
  });

  it('routes invokes through one envelope', async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.invoke('feature.read');
    await api.invoke('feature.write', { enabled: true, purge: true });

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, 'orkas.invoke', {
      channel: 'feature.read', payload: {},
    });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, 'orkas.invoke', {
      channel: 'feature.write', payload: { enabled: true, purge: true },
    });
  });

  it('rejects direct expense management preparation and opening without a trusted click', async () => {
    const { api, ipcRenderer } = loadPreload();

    await expect(api.expenseWorkbench.prepareOpen(EXPENSE_AGENT_ID, 'agent_detail'))
      .rejects.toThrow('trusted user action');
    await expect(api.expenseWorkbench.open(EXPENSE_AGENT_ID))
      .rejects.toThrow('authorization is missing');
    expect(ipcRenderer.invoke.mock.calls.some(([channel]) => (
      channel === 'orkas.expenseWorkbenchHost.prepareOpen'
      || channel === 'orkas.expenseWorkbenchHost.open'
    ))).toBe(false);
  });

  it('does not treat a synthetic management-button click as authorization', async () => {
    const preload = loadPreload();
    dispatchManageClick(preload, { trusted: false });

    await expect(preload.api.expenseWorkbench.prepareOpen(EXPENSE_AGENT_ID, 'agent_detail'))
      .rejects.toThrow('trusted user action');
    expect(preload.ipcRenderer.invoke).not.toHaveBeenCalledWith(
      'orkas.expenseWorkbenchHost.prepareOpen',
      expect.anything(),
    );
  });

  it('accepts one trusted Agent-card Use click for the matching Agent only', async () => {
    const preload = loadPreload();
    mockExpenseHost(preload);
    const card = fakeElement('', { attributes: { 'data-id': EXPENSE_AGENT_ID } });
    const useButton = fakeElement('', {
      attributes: { 'data-agent-use': '' },
      closest: (selector) => selector === '.agent-card[data-id]' ? card : null,
    });
    preload.dispatchWindow('click', {
      isTrusted: true,
      button: 0,
      composedPath: () => [useButton],
      target: useButton,
    });

    await expect(preload.api.expenseWorkbench.prepareOpen(EXPENSE_AGENT_ID, 'agent_card'))
      .resolves.toMatchObject({ ok: true });
    await expect(preload.api.expenseWorkbench.prepareOpen(EXPENSE_AGENT_ID, 'agent_card'))
      .rejects.toThrow('trusted user action');
  });

  it('binds one trusted click to one Agent and keeps all host secrets private', async () => {
    const preload = loadPreload();
    const { prepared, opened } = await authorizeExpenseWorkbench(preload);

    expect(JSON.stringify({ prepared, opened })).not.toContain(OPEN_TICKET);
    expect(JSON.stringify({ prepared, opened })).not.toContain(PAGE_INSTANCE);
    expect(JSON.stringify({ prepared, opened })).not.toContain(HOST_CAPABILITY);
    await expect(preload.api.expenseWorkbench.prepareOpen(EXPENSE_AGENT_ID, 'agent_detail'))
      .rejects.toThrow('trusted user action');
    await expect(preload.api.expenseWorkbench.open(EXPENSE_AGENT_ID))
      .rejects.toThrow('authorization is missing');

    const status = await preload.api.expenseWorkbench.status();
    expect(JSON.stringify(status)).not.toContain(HOST_CAPABILITY);
    const statusCall = preload.ipcRenderer.invoke.mock.calls.find(([channel, request]) => (
      channel === 'orkas.invoke'
      && (request as { channel?: string }).channel === 'expenseWorkbench.status'
    ));
    expect(statusCall?.[1]).toEqual({
      channel: 'expenseWorkbench.status',
      payload: {
        host_capability: HOST_CAPABILITY,
        page_instance: PAGE_INSTANCE,
        request_nonce: expect.stringMatching(/^ewreq_[A-Za-z0-9_-]{8,96}$/),
        operation_scope: 'status',
      },
    });
  });

  it('binds personnel approval fields to the active expense capability envelope', async () => {
    const preload = loadPreload();
    await authorizeExpenseWorkbench(preload);
    const artifactHash = 'b'.repeat(64);

    await preload.api.expenseWorkbench.approveApplication(
      'APP-1',
      'manager',
      'approve',
      artifactHash,
      'checked',
    );

    const approvalCall = preload.ipcRenderer.invoke.mock.calls.find(([channel, request]) => (
      channel === 'orkas.invoke'
      && (request as { channel?: string }).channel === 'expenseWorkbench.approveApplication'
    ));
    expect(approvalCall?.[1]).toEqual({
      channel: 'expenseWorkbench.approveApplication',
      payload: {
        host_capability: HOST_CAPABILITY,
        page_instance: PAGE_INSTANCE,
        request_nonce: expect.stringMatching(/^ewreq_[A-Za-z0-9_-]{8,96}$/),
        operation_scope: `approve:APP-1:manager:approve:${artifactHash}`,
        application_id: 'APP-1',
        approval_role: 'manager',
        decision: 'approve',
        expected_artifact_hash: artifactHash,
        comment: 'checked',
      },
    });
  });

  it('rejects a trusted click when page code asks to prepare a different Agent', async () => {
    const preload = loadPreload();
    mockExpenseHost(preload);
    dispatchManageClick(preload);

    await expect(preload.api.expenseWorkbench.prepareOpen('ordinary-agent', 'agent_detail'))
      .rejects.toThrow('trusted user action');
    expect(preload.ipcRenderer.invoke).not.toHaveBeenCalledWith(
      'orkas.expenseWorkbenchHost.prepareOpen',
      expect.anything(),
    );
  });

  it('revokes expense authority when the SPA management surface is hidden', async () => {
    const preload = loadPreload();
    await authorizeExpenseWorkbench(preload);

    preload.elements.host.hidden = true;
    preload.triggerMutations();
    await vi.waitFor(() => {
      const closeCall = preload.ipcRenderer.invoke.mock.calls.find(([channel, request]) => (
        channel === 'orkas.invoke'
        && (request as { channel?: string }).channel === 'expenseWorkbench.close'
      ));
      expect(closeCall?.[1]).toEqual({
        channel: 'expenseWorkbench.close',
        payload: {
          host_capability: HOST_CAPABILITY,
          page_instance: PAGE_INSTANCE,
          request_nonce: expect.stringMatching(/^ewreq_[A-Za-z0-9_-]{8,96}$/),
          operation_scope: 'close',
        },
      });
    });
    expect(() => preload.api.expenseWorkbench.status()).toThrow('not active');
  });

  it('enforces the push-event allow-list and removes the exact listener', () => {
    const { api, emit, ipcRenderer } = loadPreload();
    const handler = vi.fn();

    expect(() => api.onPushEvent('account:session-secret', handler)).toThrow(/not allowed/);
    const unsubscribe = api.onPushEvent('marketplace:changed', handler);
    emit('marketplace:changed', { id: 'a' });
    unsubscribe();
    emit('marketplace:changed', { id: 'b' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ id: 'a' });
    const registered = ipcRenderer.on.mock.calls.find(([channel]) => channel === 'marketplace:changed')?.[1];
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('marketplace:changed', registered);
  });

  it('delivers stream events, resolves on done, and cleans the listener', async () => {
    const { api, emit, ipcRenderer, listeners } = loadPreload();
    const onEvent = vi.fn();
    const stream = api.stream('chat.send', { cid: 'c' }, onEvent);
    const start = ipcRenderer.send.mock.calls[0];
    const request = start[1] as { requestId: string };
    const eventChannel = `stream:${request.requestId}`;

    expect(start[0]).toBe('orkas.streamStart');
    emit(eventChannel, { type: 'delta', text: 'hello' });
    emit(eventChannel, null);
    emit(eventChannel, { type: 'done' });
    await expect(stream.promise).resolves.toBeUndefined();

    expect(onEvent).toHaveBeenCalledWith({ type: 'delta', text: 'hello' });
    expect(listeners.get(eventChannel)?.size || 0).toBe(0);
  });

  it('cancels main work and rejects when an event callback throws', async () => {
    const { api, emit, ipcRenderer, listeners } = loadPreload();
    const stream = api.stream('chat.send', {}, () => { throw new Error('renderer failed'); });
    const request = ipcRenderer.send.mock.calls[0][1] as { requestId: string };
    const eventChannel = `stream:${request.requestId}`;
    const rejected = expect(stream.promise).rejects.toThrow('renderer failed');

    emit(eventChannel, { type: 'delta' });

    await rejected;
    expect(ipcRenderer.send).toHaveBeenCalledWith('orkas.streamCancel', request.requestId);
    expect(listeners.get(eventChannel)?.size || 0).toBe(0);
  });

  it('marks explicit cancellation as AbortError after main confirms done', async () => {
    const { api, emit, ipcRenderer } = loadPreload();
    const stream = api.stream('chat.send', {}, vi.fn());
    const request = ipcRenderer.send.mock.calls[0][1] as { requestId: string };
    const rejected = expect(stream.promise).rejects.toMatchObject({
      name: 'AbortError', message: 'stream cancelled',
    });

    stream.cancel();
    stream.cancel();
    emit(`stream:${request.requestId}`, { type: 'done' });

    await rejected;
    expect(ipcRenderer.send.mock.calls.filter(([channel]) => channel === 'orkas.streamCancel')).toHaveLength(1);
  });

  it('keeps renderer logging failures from escaping to UI code', async () => {
    const { api, ipcRenderer } = loadPreload();
    ipcRenderer.invoke.mockRejectedValueOnce(new Error('main unavailable'));
    expect(() => api.log({ level: 'info' })).not.toThrow();
    await Promise.resolve();

    ipcRenderer.invoke.mockImplementationOnce(() => { throw new Error('bridge unavailable'); });
    expect(() => api.log({ level: 'info' })).not.toThrow();
  });
});
