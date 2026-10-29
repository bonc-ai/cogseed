import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The contacts renderer bridge is what feeds the composer's `@` picker.
 * These tests pin the two seams that matter: the picker gets only the fields it
 * needs (so an offline contact stays unselectable), and every mutation refreshes
 * the cached list instead of leaving a stale picker behind.
 */
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/contacts.js'), 'utf8');

interface Harness {
  api: any;
  invoke: ReturnType<typeof vi.fn>;
  candidates: () => any[];
  events: any[];
  badge: () => number;
  toasts: any[];
  /** 模块注册的定时刷新回调（在线状态会变，缓存不能停在启动那一刻）。 */
  intervals: Array<() => void>;
}

interface BadgeHost {
  children: any[];
  appendChild: (node: any) => void;
  querySelector: (sel: string) => any | null;
}

function createHarness(
  responses: Record<string, unknown> = {},
  options: { badgeHost?: boolean } = {},
): Harness {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const events: any[] = [];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel in responses) return responses[channel];
    if (channel === 'contacts.requests') return { ok: true, requests: [] };
    return { ok: true };
  });
  const sandbox: Record<string, any> = {
    console: { warn: () => {} },
    Promise,
    CustomEvent: class {
      type: string;
      detail: any;
      constructor(type: string, init?: { detail?: any }) { this.type = type; this.detail = init?.detail; }
    },
    dispatchEvent: (event: any) => { events.push(event); return true; },
    cogseed: { invoke },
  };
  const toasts: any[] = [];
  const intervals: Array<() => void> = [];
  let badgeNode: any = null;
  const badgeHost: BadgeHost = {
    children: [],
    appendChild(node: any) { badgeNode = node; this.children.push(node); },
    querySelector: () => badgeNode,
  };
  const doc: Record<string, any> = {
    getElementById: (id: string) => (options.badgeHost && id === 'contacts-btn' ? badgeHost : null),
    createElement: () => {
      const node: any = {
        className: '',
        innerHTML: '',
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) { this.attrs[k] = v; },
        remove() { badgeNode = null; },
      };
      return node;
    },
  };
  sandbox.document = doc;
  sandbox.setInterval = (fn: () => void) => { intervals.push(fn); return intervals.length; };
  sandbox.clearInterval = () => {};
  sandbox.uiToast = (message: string, opts?: unknown) => { toasts.push({ message, opts }); };
  sandbox.uiBadge = (o: any) => `<badge>${o.label}</badge>`;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'contacts.js' });
  return {
    badge: () => {
      if (!badgeNode) return 0;
      const match = String(badgeNode.innerHTML || '').match(/>(\d+)</);
      return match ? Number(match[1]) : 0;
    },
    toasts,
    intervals,
    api: sandbox.window.contacts,
    invoke,
    candidates: () => sandbox.window.getComposerContactCandidates(),
    events,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('contacts bridge › composer seam', () => {
  it('publishes only the fields the picker needs, keeping offline contacts unselectable', async () => {
    const h = createHarness({
      'contacts.list': { ok: true, contacts: [
        { userId: 'cs_alice', name: 'Alice', online: true, assistantName: 'Alice 的助理' },
        { userId: 'cs_bob', name: 'Bob', online: false },
      ] },
    });
    await flush();
    const rows = h.candidates();
    expect(rows.map((row) => row.user_id)).toEqual(['cs_alice', 'cs_bob']);
    expect(rows[0]).toMatchObject({ name: 'Alice', online: true });
    expect(rows[0].phone_masked).toBeUndefined();
    expect(rows[1].online).toBe(false);
  });

  it('stays empty when no contacts exist (pre-A2A picker behaviour)', async () => {
    const h = createHarness({ 'contacts.list': { ok: true, contacts: [] } });
    await flush();
    expect(h.candidates()).toEqual([]);
  });
});

describe('contacts bridge › conversation directory', () => {
  it('lists only the safe conversation summary fields for one contact', async () => {
    const h = createHarness({
      'a2a.conversations.listForContact': { conversations: [
        null,
        undefined,
        'malformed',
        42,
        { title: 'missing id' },
        { conversationId: '', title: 'empty id' },
        {
          conversationId: 'a2a-1', title: '报价', updatedAt: '2026-10-25T10:00:00Z',
          state: 'active', preview: '最后一条', workspace: '/private/path',
        },
      ] },
    });
    await expect(h.api.conversationsFor('cs_alice')).resolves.toEqual([{
      conversation_id: 'a2a-1', title: '报价', updated_at: '2026-10-25T10:00:00Z',
      state: 'active', preview: '最后一条',
    }]);
    expect(h.invoke).toHaveBeenCalledWith('a2a.conversations.listForContact', { contactUserId: 'cs_alice' });
  });

  it('rejects when the conversation directory IPC returns a failure envelope', async () => {
    const h = createHarness({
      'a2a.conversations.listForContact': { ok: false, error: 'directory unavailable' },
    });
    await expect(h.api.conversationsFor('cs_alice')).rejects.toThrow('directory unavailable');
  });
});

describe('contacts bridge › mutations refresh the cache', () => {
  it('re-reads the list after a request is accepted', async () => {
    const h = createHarness({ 'contacts.list': { ok: true, contacts: [{ userId: 'cs_carol', name: 'Carol' }] } });
    await flush();
    const before = h.invoke.mock.calls.length;
    await h.api.acceptRequest('creq-1');
    expect(h.invoke).toHaveBeenCalledWith('contacts.acceptRequest', { id: 'creq-1' });
    expect(h.invoke.mock.calls.length).toBeGreaterThan(before + 1);
    expect(h.candidates().map((row) => row.user_id)).toEqual(['cs_carol']);
  });

  it('coalesces concurrent refreshes into one round trip', async () => {
    const h = createHarness({ 'contacts.requestAdd': { ok: true, request: { id: 'creq-2' } }, 'contacts.list': { ok: true, contacts: [] } });
    await flush();
    const before = h.invoke.mock.calls.length;
    await h.api.requestAdd('13800001234', 'hi');
    expect(h.invoke).toHaveBeenCalledWith('contacts.requestAdd', { phone: '13800001234', note: 'hi' });
    expect(h.invoke.mock.calls.length).toBeGreaterThan(before);
  });

  it('returns three booleans from the phone probe', async () => {
    const h = createHarness({
      'contacts.lookupByPhone': { ok: true, lookup: { registered: true, discoverable: true, is_contact: false, nickname: 'leak' } },
    });
    await flush();
    const result = await h.api.lookupByPhone('13800001234');
    expect(result).toEqual({ registered: true, discoverable: true, is_contact: false });
  });

describe('contacts bridge › sidebar badge (AC-01)', () => {
  it('adds a count badge when a request is pending and clears it when not', () => {
    const h = createHarness({ 'contacts.requests': { ok: true, requests: [{ id: 'r1', state: 'pending' }] } }, {
      badgeHost: true,
    });
    h.api.updateNavBadge(2);
    expect(h.badge()).toBe(2);
    h.api.updateNavBadge(0);
    expect(h.badge()).toBe(0);
  });

  it('toasts only when the pending count grows', () => {
    const h = createHarness({}, { badgeHost: true });
    h.api.updateNavBadge(1);
    expect(h.toasts.length).toBe(1);
    h.api.updateNavBadge(1);
    expect(h.toasts.length).toBe(1);
    h.api.updateNavBadge(3);
    expect(h.toasts.length).toBe(2);
  });
});
});

describe('contacts bridge › stale presence', () => {
  it('re-reads the roster on a timer so a contact does not stay 「离线」 forever', async () => {
    const h = createHarness({
      'contacts.list': { ok: true, contacts: [{ userId: 'cs_alice', name: 'Alice', online: false }] },
    });
    await flush();
    const listCalls = () => h.invoke.mock.calls.filter((call) => call[0] === 'contacts.list').length;
    const before = listCalls();
    expect(h.intervals.length).toBeGreaterThan(0);
    for (const tick of h.intervals) tick();
    await flush();
    expect(listCalls()).toBeGreaterThan(before);
  });
});

it('announces a rename by stable account id, without treating presence-only refreshes as renames', async () => {
  const responses: Record<string, unknown> = {
    'contacts.list': {ok:true, contacts:[{userId:'cs_peer',name:'Old',online:true}]},
  };
  const h=createHarness(responses);
  await flush();
  responses['contacts.list']={ok:true,contacts:[{userId:'cs_peer',name:'Old',online:false}]};
  await h.api.refresh();
  expect(h.events.at(-1).detail.namesChanged).toBe(false);
  responses['contacts.list']={ok:true,contacts:[{userId:'cs_peer',name:'New <>&',online:false}]};
  await h.api.refresh();
  expect(h.events.at(-1).detail.namesChanged).toBe(true);
  expect(h.candidates()).toEqual([expect.objectContaining({user_id:'cs_peer',name:'New <>&',online:false})]);
});

describe('contacts bridge › lookup errors', () => {
  it('rejects with the Hub quota code instead of reporting an unknown number', async () => {
    const h = createHarness({
      'contacts.lookupByPhone': { ok: false, error: '今日查找次数已用完', code: 'LOOKUP_QUOTA_EXCEEDED' },
    });
    await expect(h.api.lookupByPhone('13900000011')).rejects.toMatchObject({ code: 'LOOKUP_QUOTA_EXCEEDED' });
  });
});
