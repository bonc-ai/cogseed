import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 正常会话传输接缝（T2.2）。
 *
 * 钉住四件事：没有会话时**不调用** Hub（不会回落到环境 Token）；有效会话直接
 * 用它的 access token；access token 被拒时刷新后重试一次；网络失败与鉴权终止
 * 必须区分——前者可重试，后者要求重新登录。
 */
const USER = 'u1';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-transport-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function saveSession(overrides: Record<string, unknown> = {}) {
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const now = Date.now();
  saveHubSession(USER, {
    session_id: 'session-1',
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    access_expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  } as any);
}

function fakeClient(refresh: (token: string) => Promise<any>) {
  return { refresh } as any;
}

describe('hub transport › normal session only', () => {
  it('rechecks identity after the roster cache read before committing a snapshot', async () => {
    await saveSession();
    const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
    writeHubAccountState(USER, { account_id: 'cs_bob' });
    const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    const storage = await import('../../../../src/main/storage');
    const actualRead = storage.readJson;
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(storage, 'readJson').mockImplementation(async (file, options) => {
      const value = await actualRead(file, options);
      if (file.endsWith('contacts.json')) { entered(); await gate; }
      return value;
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true,
      data: { contacts: [{ accountId: 'cs_alice', name: 'Alice' }] } }) })));
    const { refreshContactsFromHub, getCachedContact } = await import('../../../../src/main/features/contacts/store');
    const pending = refreshContactsFromHub(USER);
    await reading;
    clearHubSession(USER);
    await saveSession({ session_id: 'session-2' });
    writeHubAccountState(USER, { account_id: 'cs_other' });
    release();
    expect(await pending).toBe(false);
    expect(await getCachedContact(USER, 'cs_alice')).toBeNull();
  });
  it('discards late successful requests after logout and immediate re-login', async () => {
    await saveSession();
    const { withHubSession } = await import('../../../../src/main/features/hub_account/transport');
    const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    let release!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = withHubSession(USER, async () => {
      entered();
      return new Promise<string>((resolve) => { release = resolve; });
    });
    await started;
    clearHubSession(USER);
    await saveSession();
    release('old-success');
    expect(await pending).toEqual({ ok: false, reason: 'no_session' });
  });

  it('does not let late refresh resurrect logout while remote logout is still pending', async () => {
    await saveSession();
    const { refreshSession, logout } = await import('../../../../src/main/features/hub_account/auth-flow');
    const { loadHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    let release!: (value: any) => void;
    let finishLogout!: () => void;
    const client = {
      refresh: () => new Promise((resolve) => { release = resolve; }),
      logout: () => new Promise<void>((resolve) => { finishLogout = resolve; }),
    } as any;
    const pending = refreshSession(USER, client);
    const result = pending.then(() => ({ code: 'unexpected_success' }), (error) => error);
    const signingOut = logout(USER, client);
    const immediate = loadHubSession(USER);
    release({ access_token: 'late', refresh_token: 'late', access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
    finishLogout();
    await signingOut;
    expect(immediate).toBeNull();
    expect(await result).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(loadHubSession(USER)).toBeNull();
  });

  it('does not repopulate contacts or the self-account cache from late authenticated responses', async () => {
    await saveSession();
    const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
    const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    writeHubAccountState(USER, { account_id: 'cs_bob' });
    const { refreshContactsFromHub, getCachedContact } = await import('../../../../src/main/features/contacts/store');
    const { hubSelfAccountId } = await import('../../../../src/main/features/contacts/hub-client');
    const releases: Array<() => void> = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      await new Promise<void>((resolve) => { releases.push(resolve); if (releases.length === 2) entered(); });
      return { ok: true, json: async () => ({ ok: true, data: url.endsWith('/me')
        ? { account: { account_id: 'cs_bob' } } : { contacts: [{ accountId: 'cs_alice', name: 'Alice' }] } }) };
    }));
    const roster = refreshContactsFromHub(USER);
    const self = hubSelfAccountId(USER);
    await started;
    clearHubSession(USER);
    await saveSession({ session_id: 'session-2' });
    writeHubAccountState(USER, { account_id: 'cs_other' });
    releases.forEach((release) => release());
    expect(await roster).toBe(false);
    expect(await self).toBeNull();
    expect(await getCachedContact(USER, 'cs_alice')).toBeNull();
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { account: { account_id: 'cs_other' } } }) }));
    vi.stubGlobal('fetch', fetch);
    expect(await hubSelfAccountId(USER)).toBe('cs_other');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports no session and never calls Hub when signed out', async () => {
    const { withHubSession, hasHubSession } = await import('../../../../src/main/features/hub_account/transport');
    const fn = vi.fn(async () => 'called');

    const result = await withHubSession(USER, fn);

    expect(hasHubSession(USER)).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'no_session' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('uses the stored access token and the resolved Hub base URL', async () => {
    await saveSession();
    const { withHubSession, hasHubSession } = await import('../../../../src/main/features/hub_account/transport');

    const result = await withHubSession(USER, async (context) => context);

    expect(hasHubSession(USER)).toBe(true);
    expect(result).toMatchObject({ ok: true, value: { token: 'access-1' } });
    expect((result as any).value.baseUrl).toMatch(/^https?:\/\//);
  });

  it('refreshes an access token that is about to expire', async () => {
    await saveSession({ access_expires_at: new Date(Date.now() - 1000).toISOString() });
    const { withHubSession } = await import('../../../../src/main/features/hub_account/transport');
    const refresh = vi.fn(async () => ({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      access_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const result = await withHubSession(USER, async (context) => context.token, fakeClient(refresh));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, value: 'access-2' });
  });

  it('retries once with a fresh token when the call reports an invalid access token', async () => {
    await saveSession();
    const { withHubSession } = await import('../../../../src/main/features/hub_account/transport');
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    const refresh = vi.fn(async () => ({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      access_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    const seen: string[] = [];
    const fn = vi.fn(async (context: { token: string }) => {
      seen.push(context.token);
      if (seen.length === 1) throw new HubApiError('AUTH_INVALID_TOKEN', 'expired', 401);
      return context.token;
    });

    const result = await withHubSession(USER, fn, fakeClient(refresh));

    expect(seen).toEqual(['access-1', 'access-2']);
    expect(result).toEqual({ ok: true, value: 'access-2' });
  });

  it('separates a revoked session from an unreachable Hub', async () => {
    await saveSession({ access_expires_at: new Date(Date.now() - 1000).toISOString() });
    const { withHubSession } = await import('../../../../src/main/features/hub_account/transport');
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');

    const revoked = await withHubSession(
      USER,
      async () => 'never',
      fakeClient(async () => { throw new HubApiError('AUTH_REFRESH_REVOKED', 'revoked', 401); }),
    );
    expect(revoked).toEqual({ ok: false, reason: 'auth' });

    const offline = await withHubSession(
      USER,
      async () => 'never',
      fakeClient(async () => { throw new HubApiError('HUB_NETWORK_ERROR', 'offline', 0); }),
    );
    // A network failure must stay retryable and must not look like being signed out.
    expect(offline).toEqual({ ok: false, reason: 'network' });
  });

  it('ignores the development environment token entirely', async () => {
    process.env.COGSEED_A2A_HUB_URL = 'http://127.0.0.1:9';
    process.env.COGSEED_A2A_HUB_TOKEN = 'dev-token';
    try {
      const { withHubSession } = await import('../../../../src/main/features/hub_account/transport');
      const fn = vi.fn(async () => 'called');

      const result = await withHubSession(USER, fn);

      expect(result).toEqual({ ok: false, reason: 'no_session' });
      expect(fn).not.toHaveBeenCalled();
    } finally {
      delete process.env.COGSEED_A2A_HUB_URL;
      delete process.env.COGSEED_A2A_HUB_TOKEN;
    }
  });
});
