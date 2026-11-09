import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HubRequest } from '../../../../src/main/features/contacts/hub-client';

const USER = 'request-sync-user';
let tmp: string;
let previousRoot: string | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function request(requestId: string, overrides: Partial<HubRequest> = {}): HubRequest {
  return {
    requestId, direction: 'in', peerAccountId: `cs_${requestId}`,
    phoneMasked: '138****1234', note: '', state: 'pending',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

async function signIn(account = 'cs_self') {
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(USER, {
    session_id: `session-${account}`, access_token: 'offline-fixture', refresh_token: 'fixture',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 7200_000).toISOString(),
  });
  writeHubAccountState(USER, { account_id: account });
}

async function harness(seed = true) {
  await signIn();
  let rows: HubRequest[] = [];
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    expect(url).toContain('/api/v1/a2a/contacts/requests');
    return { ok: true, json: async (): Promise<unknown> => ({ ok: true, data: { requests: rows } }) };
  });
  vi.stubGlobal('fetch', fetch);
  const store = await import('../../../../src/main/features/contacts/store');
  const file = store.__paths.requests(USER);
  if (seed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, requests: [] }));
  }
  const arrived = vi.fn();
  store.onContactRequestArrived(arrived);
  return { store, file, fetch, arrived, setRows: (value: HubRequest[]) => { rows = value; } };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-requests-sync-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Hub request arrivals from the persisted mirror', () => {
  it('does not call an outgoing local request an arrival', async () => {
    const h = await harness();
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    await h.store.requestAdd(USER, { phone: '13800001234' });
    expect(h.arrived).not.toHaveBeenCalled();
  });

  it('delivers a new incoming pending request through the native notification subscription', async () => {
    const h = await harness();
    const { startContactNotifications } = await import('../../../../src/main/features/contacts/notifications');
    const show = vi.fn();
    const createNotification = vi.fn(() => ({ onClick: vi.fn(), show }));
    const stop = startContactNotifications({ runtime: {
      getActiveUserId: () => USER, isEnabled: () => true, hasFocusedWindow: () => false,
      isSupported: () => true, createNotification, openContacts: vi.fn(),
    } });
    h.setRows([request('new')]);
    await h.store.listRequests(USER);
    expect(h.arrived).toHaveBeenCalledExactlyOnceWith(USER, expect.objectContaining({ id: 'new', phoneMasked: '138****1234' }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: '138****1234 想加你为联系人' }));
    expect(show).toHaveBeenCalledTimes(1);
    stop();
  });

  it('deduplicates repeat syncs and duplicate rows, including after a module restart', async () => {
    const h = await harness();
    h.setRows([request('new'), request('new')]);
    await h.store.listRequests(USER);
    await h.store.listRequests(USER);
    expect(h.arrived).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/contacts/store');
    const arrived = vi.fn();
    restarted.onContactRequestArrived(arrived);
    await restarted.listRequests(USER);
    expect(arrived).not.toHaveBeenCalled();
  });

  it('uses the first successful sync as a silent baseline, then announces subsequent arrivals', async () => {
    const h = await harness(false);
    h.setRows([request('old')]);
    await h.store.listRequests(USER);
    expect(h.arrived).not.toHaveBeenCalled();
    h.setRows([request('old'), request('new')]);
    await h.store.listRequests(USER);
    expect(h.arrived.mock.calls.map(([, row]) => row.id)).toEqual(['new']);
  });

  it('does not replay known requests, outgoing requests, final states or elapsed pending requests', async () => {
    const h = await harness();
    fs.writeFileSync(h.file, JSON.stringify({ version: 1, requests: [
      { id: 'known', direction: 'in', state: 'pending', createdAt: new Date().toISOString() },
      { id: 'already-final', direction: 'in', state: 'expired', createdAt: new Date().toISOString() },
    ] }));
    h.setRows([
      request('known'), request('already-final'), request('outgoing', { direction: 'out' }),
      request('accepted', { state: 'accepted' }), request('rejected', { state: 'rejected' }),
      request('expired', { state: 'expired' }), request('elapsed', { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      request('new'),
    ]);
    const result = await h.store.listRequests(USER);
    expect(result).toHaveLength(8);
    expect(h.arrived.mock.calls.map(([, row]) => row.id)).toEqual(['new']);
  });

  it('announces exactly once when syncs overlap', async () => {
    const h = await harness();
    h.setRows([request('new')]);
    const entered = deferred();
    const release = deferred();
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementationOnce(async (url) => {
      entered.resolve();
      await release.promise;
      return fetch(url);
    });
    const first = h.store.listRequests(USER);
    await entered.promise;
    const second = h.store.listRequests(USER);
    release.resolve();
    await Promise.all([first, second]);
    expect(h.arrived).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(h.file, 'utf8')).requests.map((row: any) => row.id)).toEqual(['new']);
  });

  it.each(['hub_add', 'local_add', 'local_accept', 'local_reject'] as const)(
    'keeps the arrival mirror when %s overlaps a sync', async (mutation) => {
      const entered = deferred();
      const release = deferred();
      let paused = false;
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        // Keep real files and storage's atomic-commit logic, but settle file IO
        // in microtasks so one event-loop turn deterministically drains any
        // unlocked sync while the mutation's temporary write is suspended.
        return {
          ...actual,
          readFile: async (...args: Parameters<typeof actual.readFile>) => Reflect.apply(fs.readFileSync, fs, args),
          mkdir: async (...args: Parameters<typeof actual.mkdir>) => Reflect.apply(fs.mkdirSync, fs, args),
          rename: async (...args: Parameters<typeof actual.rename>) => Reflect.apply(fs.renameSync, fs, args),
          writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            Reflect.apply(fs.writeFileSync, fs, args);
            if (!paused && String(args[0]).includes('contact-requests.json.') && String(args[0]).endsWith('.tmp')) {
              paused = true;
              entered.resolve();
              await release.promise;
            }
          },
        };
      });
      const h = await harness();
      // No peer id: local accept exercises the request mutation without
      // introducing an unrelated contact-reconciliation workflow.
      const target = { id: 'target', direction: 'in', state: 'pending', createdAt: new Date().toISOString() };
      fs.writeFileSync(h.file, JSON.stringify({ version: 1, requests: [target] }));
      const fetch = h.fetch.getMockImplementation()!;
      h.fetch.mockImplementation(async (url, init) => {
        if (init?.method === 'POST') {
          if (mutation !== 'hub_add') throw new Error('offline mutation fixture');
          return { ok: true, json: async () => ({ ok: true, data: { requestId: 'outgoing' } }) };
        }
        return fetch(url, init);
      });
      h.setRows([request('target', { peerAccountId: '' }), request('new')]);
      const pendingMutation = mutation.endsWith('add')
        ? h.store.requestAdd(USER, { phone: '13900005678' })
        : mutation === 'local_accept'
          ? h.store.acceptRequest(USER, 'target')
          : h.store.rejectRequest(USER, 'target');
      await entered.promise;
      const sync = h.store.listRequests(USER);
      try {
        await new Promise<void>((done) => setImmediate(done));
      } finally {
        release.resolve();
      }
      await Promise.all([pendingMutation, sync]);
      const mirrored = JSON.parse(fs.readFileSync(h.file, 'utf8')).requests;
      await h.store.listRequests(USER);
      expect(h.arrived.mock.calls.map(([, row]) => row.id)).toEqual(['new']);
      expect(mirrored.map((row: any) => row.id)).toContain('new');
    },
  );

  it('retains lazy expiry and makes no arrival event when offline', async () => {
    const h = await harness();
    fs.writeFileSync(h.file, JSON.stringify({ version: 1, requests: [
      { id: 'expired-local', direction: 'in', state: 'pending', createdAt: '2026-01-01', expiresAt: '2026-01-01' },
    ] }));
    h.fetch.mockRejectedValue(new Error('offline fixture'));
    expect(await h.store.listRequests(USER)).toEqual([expect.objectContaining({ id: 'expired-local', state: 'expired' })]);
    expect(h.arrived).not.toHaveBeenCalled();
  });

  it.each(['logout', 'account_change'])('discards a response whose identity changed during fetch: %s', async (change) => {
    const h = await harness();
    const entered = deferred();
    const release = deferred();
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementationOnce(async (url) => {
      entered.resolve(); await release.promise; return fetch(url);
    });
    h.setRows([request('stale')]);
    const pending = h.store.listRequests(USER);
    await entered.promise;
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    if (change === 'account_change') await signIn('cs_new');
    const before = fs.readFileSync(h.file, 'utf8');
    release.resolve();
    await pending;
    expect(fs.readFileSync(h.file, 'utf8')).toBe(before);
    expect(h.arrived).not.toHaveBeenCalled();
  });

  it.each(['logout', 'account_change'])('cannot commit or notify after identity changes during the tmp write: %s', async (change) => {
    const entered = deferred();
    const release = deferred();
    let paused = false;
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
        await actual.writeFile(...args);
        if (!paused && String(args[0]).includes('contact-requests.json.') && String(args[0]).endsWith('.tmp')) {
          paused = true; entered.resolve(); await release.promise;
        }
      } };
    });
    const h = await harness();
    h.setRows([request('stale')]);
    const pending = h.store.listRequests(USER);
    await entered.promise;
    (await import('../../../../src/main/features/hub_account/tokens')).clearHubSession(USER);
    if (change === 'account_change') await signIn('cs_new');
    const before = fs.readFileSync(h.file, 'utf8');
    release.resolve();
    await pending;
    expect(fs.readFileSync(h.file, 'utf8')).toBe(before);
    expect(h.arrived).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.dirname(h.file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
