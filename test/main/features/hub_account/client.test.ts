import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubApiError, createHubClient, hubApiBase } from '../../../../src/main/features/hub_account/client';

vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({
  accountApiBase: () => 'https://server.test/api',
}));

const BASE = 'http://hub.test';

describe('hub account client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    delete process.env.COGSEED_HUB_API_BASE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COGSEED_HUB_API_BASE;
  });

  function mockFetchOnce(status: number, body: unknown) {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }

  it('derives the Hub base from the canonical account API helper', () => {
    expect(hubApiBase()).toBe('https://server.test');
  });

  it('honors the COGSEED_HUB_API_BASE override for local joint debugging', () => {
    process.env.COGSEED_HUB_API_BASE = 'http://localhost:3000';
    expect(hubApiBase()).toBe('http://localhost:3000');
  });

  it('strips a trailing /api from the override like the canonical helper', () => {
    process.env.COGSEED_HUB_API_BASE = 'http://localhost:3000/api';
    expect(hubApiBase()).toBe('http://localhost:3000');
  });

  it('login builds the provider query and returns authorize_url + state', async () => {
    mockFetchOnce(200, { ok: true, data: { authorize_url: 'https://github.com/...', state: 's1' } });
    const client = createHubClient(BASE);
    const res = await client.login('github', 'cogseed://account/callback');
    expect(res.state).toBe('s1');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/auth/login?');
    expect(url).toContain('provider=github');
    expect(url).toContain(encodeURIComponent('cogseed://account/callback'));
    expect(init.method).toBe('GET');
  });

  it('callback posts {code, state} and returns the session payload', async () => {
    mockFetchOnce(200, {
      ok: true,
      data: {
        is_new_account: true,
        account: { account_id: 'cogseed_acc_1', auth_provider: 'github', status: 'active', created_at: 't' },
        session: { session_id: 's', access_token: 'at', refresh_token: 'rt', access_expires_at: 'a', refresh_expires_at: 'r' },
      },
    });
    const client = createHubClient(BASE);
    const res = await client.callback('code1', 'state1');
    expect(res.is_new_account).toBe(true);
    expect(res.session.access_token).toBe('at');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/auth/callback');
    expect(init.method).toBe('POST');
    // Contract v1.3: body is exactly { code, state } — no device fields.
    expect(JSON.parse(String(init.body))).toEqual({ code: 'code1', state: 'state1' });
  });

  it('authenticated endpoints attach the Bearer header', async () => {
    mockFetchOnce(200, { ok: true, data: [] });
    const client = createHubClient(BASE);
    await client.listDevices('tok123');
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123');
  });

  it('surfaces the Hub error code for failed business calls', async () => {
    mockFetchOnce(409, {
      ok: false,
      error: { code: 'BINDING_ALREADY_EXISTS', message: '该本地身份已绑定到另一个 Hub 账号', details: { existing_account_id: 'x' } },
    });
    const client = createHubClient(BASE);
    const err = await client.bind('tok', { local_identity_id: '1', device_name: 'n', device_os: 'o' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubApiError);
    expect((err as HubApiError).code).toBe('BINDING_ALREADY_EXISTS');
    expect((err as HubApiError).status).toBe(409);
    expect((err as HubApiError).message).toContain('绑定');
    expect((err as HubApiError).details).toEqual({ existing_account_id: 'x' });
  });

  it('listDevices returns the full page envelope (data + total)', async () => {
    mockFetchOnce(200, {
      ok: true,
      data: [
        { device_id: 'd1', device_name: 'MacBook', device_os: 'macOS 15.0', is_current: true, first_seen_at: 'a', last_seen_at: 'b', active_sessions: 1, status: 'active' },
        { device_id: 'd2', device_name: 'ThinkPad', device_os: 'Windows 11', is_current: false, first_seen_at: 'c', last_seen_at: 'd', active_sessions: 0, status: 'active' },
      ],
      total: 2,
      page: 1,
      page_size: 20,
    });
    const client = createHubClient(BASE);
    const res = await client.listDevices('tok');
    expect(res.total).toBe(2);
    expect(res.data).toHaveLength(2);
    expect(res.data[0].device_id).toBe('d1');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/devices?page=1&page_size=20');
    expect(init.method).toBe('GET');
  });

  it('maps network failure to HUB_NETWORK_ERROR', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = createHubClient(BASE);
    const err = await client.healthz().catch((e: unknown) => e);
    // healthz swallows errors → returns false
    expect(err).toBe(false);
  });

  it('healthz returns false when the service is down', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = createHubClient(BASE);
    expect(await client.healthz()).toBe(false);
  });
});
