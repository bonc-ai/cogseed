import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HubRefreshResult, HubSession } from '../../../../src/main/features/hub_account/types';

// Exercise production callers, real withHubSession, and encrypted persistence.
// Only the HTTP boundary and the shared client's remote refresh/logout are controlled.
const USER = 'raw-http-user';
const callers = ['contacts list', 'contacts operation', 'relay poll', 'relay send'] as const;
type Caller = typeof callers[number];
const sendInput = { to: 'cs_peer', conversationId: 'a2a-test', kind: 'question' as const,
  text: 'hello', requestId: 'stable-request-1' };
let tmp: string;
let h: Awaited<ReturnType<typeof setup>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function rotated(): HubRefreshResult {
  return { access_token: 'access-2', refresh_token: 'refresh-2',
    access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 7_200_000).toISOString() };
}

function response(status: number, code?: string, data?: unknown) {
  return new Response(JSON.stringify(code ? { ok: false, error: { code, message: code } }
    : { ok: true, data }), { status, headers: { 'content-type': 'application/json' } });
}

function dataFor(caller: Caller) {
  if (caller === 'contacts list') return { contacts: [{ accountId: 'cs_peer', name: 'Peer', online: true }] };
  if (caller === 'contacts operation') return { requestId: 'contact-request-1' };
  if (caller === 'relay poll') return { messages: [{ messageId: 'message-1', fromAccount: 'cs_peer',
    toAccount: 'cs_self', conversationId: sendInput.conversationId, kind: 'question', text: 'hello',
    createdAt: '2026-10-27T00:00:00.000Z' }] };
  return { messageId: 'message-1' };
}

function successFor(caller: Caller) {
  const data = dataFor(caller);
  if ('contacts' in data) return data.contacts;
  if ('messages' in data) return data.messages;
  return { ok: true, ...data };
}

function failureFor(caller: Caller, code: string) {
  return caller === 'contacts list' || caller === 'relay poll' ? null : { ok: false, code };
}

async function setup() {
  const tokens = await import('../../../../src/main/features/hub_account/tokens');
  const state = await import('../../../../src/main/features/hub_account/state');
  const client = await import('../../../../src/main/features/hub_account/client');
  const auth = await import('../../../../src/main/features/hub_account/auth-flow');
  const contacts = await import('../../../../src/main/features/contacts/hub-client');
  const relay = await import('../../../../src/main/features/a2a/relay-client');
  const shared = client.hubClient();
  const refresh = vi.spyOn(shared, 'refresh').mockImplementation(async () => rotated());
  vi.spyOn(shared, 'logout').mockResolvedValue({ message: 'ok' });
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const seed = (overrides: Partial<HubSession> = {}, accountId = 'cs_self') => {
    tokens.saveHubSession(USER, { session_id: 'session-1', access_token: 'access-1', refresh_token: 'refresh-1',
      access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 7_200_000).toISOString(), ...overrides });
    state.writeHubAccountState(USER, { account_id: accountId });
  };
  seed();
  const persisted = JSON.stringify(state.readHubAccountState(USER));
  expect(state.readHubAccountState(USER).session_enc).toBeTruthy();
  expect(persisted).not.toContain('access-1');
  expect(persisted).not.toContain('refresh-1');
  const call = (caller: Caller, isCurrent?: () => boolean) => {
    if (caller === 'contacts list') return contacts.hubListContacts(USER, { isCurrent });
    if (caller === 'contacts operation') return contacts.hubSendRequestDetailed(USER, '12345678901', 'hello');
    if (caller === 'relay poll') return relay.pollRelayMessages(USER, 'cursor-1', { isCurrent });
    return relay.sendRelayMessageDetailed(USER, sendInput);
  };
  return { tokens, state, auth, contacts, refresh, fetch, seed, call };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-http-refresh-'));
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', tmp);
  vi.stubEnv('COGSEED_HUB_API_BASE', 'https://hub.example.test');
  vi.resetModules();
  h = await setup();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.each(callers)('%s real HTTP auth integration', (caller) => {
  it('refreshes AUTH_INVALID_TOKEN once and repeats the same request with the rotated token', async () => {
    const generation = h.tokens.hubSessionGeneration(USER);
    h.fetch.mockResolvedValueOnce(response(401, 'AUTH_INVALID_TOKEN'))
      .mockResolvedValueOnce(response(200, undefined, dataFor(caller)));

    expect(await h.call(caller)).toEqual(successFor(caller));
    expect(h.refresh.mock.calls).toEqual([['refresh-1']]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const [[url1, first], [url2, second]] = h.fetch.mock.calls;
    expect(url2).toBe(url1);
    expect(first?.headers).toMatchObject({ authorization: 'Bearer access-1' });
    expect(second?.headers).toEqual({ ...first?.headers, authorization: 'Bearer access-2' });
    expect(second?.method).toBe(first?.method);
    expect(second?.body).toBe(first?.body);
    if (caller === 'relay send') {
      expect(second?.headers).toMatchObject({ 'idempotency-key': sendInput.requestId });
      expect(JSON.parse(String(second?.body))).toEqual(sendInput);
    }
    expect(h.tokens.loadHubSession(USER)).toMatchObject({ access_token: 'access-2', refresh_token: 'refresh-2' });
    expect(h.tokens.hubSessionGeneration(USER)).toBe(generation);
  });

  it('stops at auth failure after a second HTTP401', async () => {
    h.fetch.mockImplementation(async () => response(401, 'AUTH_INVALID_TOKEN'));
    expect(await h.call(caller)).toEqual(failureFor(caller, 'HUB_AUTH_REQUIRED'));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not refresh other real Hub HTTP401 codes or an unparseable HTTP401', async () => {
    for (const code of ['AUTH_SESSION_EXPIRED', 'AUTH_SESSION_REVOKED', 'AUTH_DEVICE_REVOKED',
      'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_DELETION', 'ACCOUNT_DELETED', 'AUTH_MISSING_TOKEN', undefined]) {
      h.fetch.mockResolvedValueOnce(code ? response(401, code) : new Response('unauthorized', { status: 401 }));
      expect(await h.call(caller), code ?? 'non-JSON 401').toEqual(failureFor(caller, 'HUB_AUTH_REQUIRED'));
    }
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(8);
  });

  it.each(['NOT_CONTACT', 'QUESTIONS_DISABLED', 'AUTH_INVALID_TOKEN'])('preserves business HTTP403 %s without refresh', async (code) => {
    h.fetch.mockResolvedValueOnce(response(403, code));
    expect(await h.call(caller)).toEqual(failureFor(caller, code));
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([new TypeError('network down'), new DOMException('timeout', 'AbortError')])('keeps network/timeout retryable without refresh: %s', async (error) => {
    h.fetch.mockRejectedValueOnce(error);
    expect(await h.call(caller)).toEqual(failureFor(caller, 'HUB_UNREACHABLE'));
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['logout', 'new login'])('does not retry or resurrect credentials after %s during refresh', async (change) => {
    const started = deferred<'refresh'>();
    const gate = deferred<HubRefreshResult>();
    h.refresh.mockImplementation(() => { started.resolve('refresh'); return gate.promise; });
    h.fetch.mockImplementation(async () => response(401, 'AUTH_INVALID_TOKEN'));
    const pending = h.call(caller);
    expect(await Promise.race([started.promise, pending.then(() => 'settled')])).toBe('refresh');
    await h.auth.logout(USER);
    if (change === 'new login') h.seed({ session_id: 'session-2', access_token: 'new-login-access' }, 'cs_new');
    gate.resolve(rotated());
    expect(await pending).toEqual(failureFor(caller, 'HUB_NOT_CONFIGURED'));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    if (change === 'logout') expect(h.tokens.loadHubSession(USER)).toBeNull();
    else expect(h.tokens.loadHubSession(USER)).toMatchObject({ session_id: 'session-2', access_token: 'new-login-access' });
  });

  it('drops a late retry success after logout and re-login', async () => {
    const started = deferred<'retry'>();
    const gate = deferred<Response>();
    h.fetch.mockResolvedValueOnce(response(401, 'AUTH_INVALID_TOKEN')).mockImplementationOnce(() => {
      started.resolve('retry');
      return gate.promise;
    });
    const pending = h.call(caller);
    expect(await Promise.race([started.promise, pending.then(() => 'settled')])).toBe('retry');
    await h.auth.logout(USER);
    h.seed({ session_id: 'session-2', access_token: 'new-login-access' }, 'cs_new');
    gate.resolve(response(200, undefined, dataFor(caller)));
    expect(await pending).toEqual(failureFor(caller, 'HUB_NOT_CONFIGURED'));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.tokens.loadHubSession(USER)?.access_token).toBe('new-login-access');
  });
});

it.each(['contacts list', 'relay poll'] as const)('%s rechecks the active-scope guard after refresh before retry', async (caller) => {
  let active = true;
  h.fetch.mockResolvedValueOnce(response(401, 'AUTH_INVALID_TOKEN'));
  h.refresh.mockImplementation(async () => { active = false; return rotated(); });
  expect(await h.call(caller, () => active)).toBeNull();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('keeps the serialized relay envelope when caller-owned input changes during refresh', async () => {
  const relay = await import('../../../../src/main/features/a2a/relay-client');
  const input = { ...sendInput, kind: 'question' as 'question' | 'answer' };
  h.refresh.mockImplementation(async () => { input.kind = 'answer'; return rotated(); });
  h.fetch.mockResolvedValueOnce(response(401, 'AUTH_INVALID_TOKEN'))
    .mockResolvedValueOnce(response(200, undefined, { messageId: 'message-1' }));
  expect(await relay.sendRelayMessageDetailed(USER, input)).toEqual({ ok: true, messageId: 'message-1' });
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  const [[, first], [, second]] = h.fetch.mock.calls;
  expect(JSON.parse(String(first?.body))).toEqual(sendInput);
  expect(second?.body).toBe(first?.body);
  expect(second?.headers).toEqual({ ...first?.headers, authorization: 'Bearer access-2' });
});

it('cannot fill roster or self-account caches when logout interrupts a shared HTTP401 refresh', async () => {
  const store = await import('../../../../src/main/features/contacts/store');
  const started = deferred<'refresh'>();
  const gate = deferred<HubRefreshResult>();
  h.refresh.mockImplementation(() => { started.resolve('refresh'); return gate.promise; });
  h.fetch.mockImplementation(async () => response(401, 'AUTH_INVALID_TOKEN'));
  const pending = Promise.all([store.refreshContactsFromHub(USER), h.contacts.hubSelfAccountId(USER)]);
  expect(await Promise.race([started.promise, pending.then(() => 'settled')])).toBe('refresh');
  await h.auth.logout(USER);
  gate.resolve(rotated());
  expect(await pending).toEqual([false, null]);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.tokens.loadHubSession(USER)).toBeNull();
  expect(await store.getCachedContact(USER, 'cs_peer')).toBeNull();
  h.seed({ session_id: 'session-2' }, 'cs_new');
  h.fetch.mockResolvedValueOnce(response(200, undefined, { account: { account_id: 'cs_new' } }));
  expect(await h.contacts.hubSelfAccountId(USER)).toBe('cs_new');
  expect(h.fetch).toHaveBeenCalledTimes(3);
});
