import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function stopHarness() {
  const response = deferred<any>();
  const apiFetch = vi.fn(() => response.promise);
  const toast = vi.fn();
  const sent = vi.fn(async (_content: string, extra: any) => ({
    accepted: true, cid: 'c1', submit_request_id: extra.submit_request_id,
  }));
  const context: any = {
    console, Map, Set, Date, JSON, URLSearchParams, AbortController, TextDecoder,
    performance, setTimeout: () => 1, clearTimeout() {},
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {}, ConversationRuntime: {} },
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    t: (key: string) => key, apiFetch, uiToast: toast,
  };
  const pollCallbacks = new Map<number, () => Promise<void>>();
  let nextTimer = 0;
  context.setInterval = (fn: () => Promise<void>) => {
    pollCallbacks.set(++nextTimer, fn);
    return nextTimer;
  };
  context.clearInterval = (id: number) => pollCallbacks.delete(id);
  vm.createContext(context);
  for (const file of ['state.js', 'conversation.js', 'queue-draft.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', file), 'utf8'), context);
  }
  context.realUpdateConvSendUI = context._updateConvSendUI;
  context.realStartPolling = context.startPolling;
  context.realStopPolling = context.stopPolling;
  Object.assign(context, {
    _cleanupSlowSwitchForCid() {}, _stopRuntimeActorRecovery() {},
    _stopGroupEventObserver() {}, _clearBackgroundGroupEvents() {},
    _refreshTaskSurfacesAfterAbort() {}, _scheduleHistoryReconcileAfterStream() {},
    _updateConvSidebarBadge() {}, _updateConvSendUI() {}, _ensureConvCreateAgentInline() {}, startPolling: vi.fn(), stopPolling() {},
    _settleDanglingActorPlaceholders() {}, _scheduleBackendRunRediscovery() {},
    renderMessageQueue() {}, applyRecipientPrefix: (text: string) => text,
    sendInCurrentConversation: sent,
    loadConversationHistory: vi.fn(),
  });
  vm.runInContext(`
    currentCid = 'c1';
    pendingConvs.set('c1', { loadingEl: null, controller: null, aborted: false });
    setGroupConversationBusy('c1', true);
    messageQueues.set('c1', [{id: 'q1', content: 'next task', direct: true,
      extra: {recipient_agent_id: 'agent-a', submit_request_id: 'request-q1'}}]);
  `, context);
  return { context, response, apiFetch, sent, toast, pollCallbacks,
    run: (code: string) => vm.runInContext(code, context),
    acknowledge: () => response.resolve({ ok: true, json: async () => ({ ok: true }) }),
  };
}

describe('conversation stop acknowledgement', () => {
  it('keeps a recovered conversation pending and its queue durable until host stop acknowledges', async () => {
    const h = stopHarness();
    const stopping = h.context.abortConvStream('c1');
    try {
      expect(h.context.isConvPending('c1')).toBe(true);
      await h.context._dispatchNextQueued('c1');
      expect(h.sent).not.toHaveBeenCalled();
      expect(h.run("messageQueues.get('c1').length")).toBe(1);
      expect(h.context.isConvPending('other')).toBe(false);
    } finally { h.acknowledge(); await stopping; }
    expect(h.context.isConvPending('c1')).toBe(false);
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('does not drain after local stream completion before the backend cancellation completes', async () => {
    const h = stopHarness();
    const localAbort = vi.fn();
    h.context.localAbort = localAbort;
    h.run("pendingConvs.get('c1').controller = { abort: localAbort }");
    const stopping = h.context.abortConvStream('c1');
    try {
      expect(localAbort).toHaveBeenCalledTimes(1);
      h.context._finishStreamingMsg('c1');
      await Promise.resolve();
      expect(h.context.isConvPending('c1')).toBe(true);
      expect(h.sent).not.toHaveBeenCalled();
    } finally { h.acknowledge(); await stopping; }
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated stop requests for one conversation', async () => {
    const h = stopHarness();
    const first = h.context.abortConvStream('c1');
    const second = h.context.abortConvStream('c1');
    try {
      expect(first).toBe(second);
      await Promise.resolve();
      expect(h.apiFetch).toHaveBeenCalledTimes(1);
    } finally { h.acknowledge(); await Promise.all([first, second]); }
  });

  it('keeps a rejected stop retryable and reports failure instead of releasing queued work', async () => {
    const h = stopHarness();
    const stopping = h.context.abortConvStream('c1');
    h.response.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: 'cancel failed' }) });
    await stopping;
    await Promise.resolve();
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.context.isConvPending('c1')).toBe(true);
    expect(h.sent).not.toHaveBeenCalled();
    expect(h.context.startPolling).toHaveBeenCalledWith('c1');
    h.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    await h.context.abortConvStream('c1');
    expect(h.context.isConvPending('c1')).toBe(false);
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('does not heal a rejected stop into idle while its backend status is unconfirmed', async () => {
    const h = stopHarness();
    const stopping = h.context.abortConvStream('c1');
    h.response.resolve({ ok: false, json: async () => ({ ok: false }) });
    await stopping;
    h.context._healStaleGroupBusy('c1');
    await Promise.resolve();
    expect(h.context.isConvPending('c1')).toBe(true);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it.each(['stream', 'reply'])('keeps failed-stop recovery alive when a resumed %s finishes before authoritative idle', async (completion) => {
    const h = stopHarness();
    h.context.startPolling = h.context.realStartPolling;
    h.context.stopPolling = h.context.realStopPolling;
    const stopping = h.context.abortConvStream('c1');
    h.response.resolve({ ok: false, json: async () => ({ ok: false }) });
    await stopping;
    expect(h.pollCallbacks.size).toBe(1);
    // Reopening a running conversation reconstructs its observer; its final
    // event clears the ordinary busy bit before observation-stream cleanup.
    h.run("pendingConvs.set('c1', {controller: {}, loadingEl: null}); setGroupConversationBusy('c1', false)");
    if (completion === 'stream') h.context._finishStreamingMsg('c1');
    else h.context._resolveConvReply('c1', 'finished', false);
    await Promise.resolve();
    expect(h.pollCallbacks.size).toBe(1);
    expect(h.context.isConvPending('c1')).toBe(true);
    expect(h.sent).not.toHaveBeenCalled();
    h.context.loadConversationHistory.mockClear();
    // A persisted reply without an explicit processing=false is not a stop
    // receipt. It must not shut down the sole remaining recovery observer.
    h.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true,
      history: [{ id: 'result', from: 'agent-a', text: 'finished' }], conversation: {},
    }) });
    await [...h.pollCallbacks.values()][0]();
    expect(h.pollCallbacks.size).toBe(1);
    expect(h.context.loadConversationHistory).not.toHaveBeenCalled();
    expect(h.context.isConvPending('c1')).toBe(true);
    h.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true,
      history: [], conversation: { processing: false },
    }) });
    await [...h.pollCallbacks.values()][0]();
    expect(h.pollCallbacks.size).toBe(0);
    expect(h.context.isConvPending('c1')).toBe(false);
    await h.context._dispatchNextQueued('c1');
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('does not carry a stopping button lock into another running conversation', async () => {
    const h = stopHarness();
    const classes = new Set<string>();
    const button = { dataset: {} as Record<string, string>, disabled: false, title: '', classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name),
      toggle: (name: string, value: boolean) => value ? classes.add(name) : classes.delete(name),
    } };
    h.context.document.getElementById = (id: string) => id === 'chat-send-btn' ? button : null;
    const stopping = h.context.abortConvStream('c1');
    try {
      h.context.realUpdateConvSendUI('c1');
      expect(button.disabled).toBe(true);
      h.run("currentCid = 'c2'; pendingConvs.set('c2', {aborted: false})");
      h.context.realUpdateConvSendUI('c2');
      expect(button.disabled).toBe(false);
      expect(classes.has('streaming')).toBe(true);
      expect(button.title).toBe('chat.stop_reply');
    } finally { h.acknowledge(); await stopping; }
  });

  it.each([true, false, undefined, null, 0, 'false'])('releases a failed-stop guard only from explicit host idle (processing=%s)', async (processing) => {
    const h = stopHarness();
    h.context.startPolling = h.context.realStartPolling;
    const stopping = h.context.abortConvStream('c1');
    h.response.resolve({ ok: false, json: async () => ({ ok: false }) });
    await stopping;
    expect(h.context.isConvPending('c1')).toBe(true);
    h.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true,
      history: [], conversation: { processing },
    }) });
    const tick = [...h.pollCallbacks.values()][0];
    expect(tick).toBeTypeOf('function');
    await tick();
    expect(h.context.isConvPending('c1')).toBe(processing !== false);
    expect(h.context.loadConversationHistory).toHaveBeenCalledTimes(processing === false ? 1 : 0);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('restores the stop action after a cancellation failure arrives while its conversation is hidden', async () => {
    const h = stopHarness();
    const classes = new Set<string>();
    const button = { dataset: {} as Record<string, string>, disabled: false, title: '', classList: {
      contains: (name: string) => classes.has(name), add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, value: boolean) => value ? classes.add(name) : classes.delete(name),
    } };
    h.context.document.getElementById = (id: string) => id === 'chat-send-btn' ? button : null;
    const stopping = h.context.abortConvStream('c1');
    h.context.realUpdateConvSendUI('c1');
    h.run("currentCid = null");
    h.response.resolve({ ok: false, json: async () => ({ ok: false }) });
    await stopping;
    h.run("currentCid = 'c1'");
    h.context.realUpdateConvSendUI('c1');
    expect(h.context.isConvPending('c1')).toBe(true);
    expect(button.disabled).toBe(false);
    expect(classes.has('streaming')).toBe(true);
  });
});
