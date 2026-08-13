import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fakeClient = vi.hoisted(() => ({
  login: vi.fn(),
  callback: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  bind: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  listConsents: vi.fn(),
  setConsent: vi.fn(),
  revokeConsent: vi.fn(),
  deleteAccount: vi.fn(),
  healthz: vi.fn(),
  readyz: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  getActiveUserId: vi.fn(() => '88492103'),
  shellOpenExternal: vi.fn(async () => undefined),
  tmpConfigDir: '',
}));

vi.mock('electron', () => ({ shell: { openExternal: mocks.shellOpenExternal } }));
vi.mock('../../../../src/main/features/users', () => ({ getActiveUserId: mocks.getActiveUserId }));
vi.mock('../../../../src/main/paths', () => ({
  userLocalConfigDir: () => mocks.tmpConfigDir,
}));
vi.mock('../../../../src/main/features/hub_account/client', () => ({
  HubApiError: class HubApiError extends Error {
    code: string;
    status: number;
    details?: Record<string, unknown>;
    constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
      super(message);
      this.name = 'HubApiError';
      this.code = code;
      this.status = status;
      this.details = details;
    }
  },
  hubClient: () => fakeClient,
  createHubClient: () => fakeClient,
  hubApiBase: () => 'http://hub.test',
}));

import * as authFlow from '../../../../src/main/features/hub_account/auth-flow';
import { loadHubSession, clearHubSession } from '../../../../src/main/features/hub_account/tokens';
import { readHubAccountState } from '../../../../src/main/features/hub_account/state';

const SESSION = {
  session_id: 'sess_1',
  access_token: 'at1',
  refresh_token: 'rt1',
  access_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
};

describe('hub account auth-flow', () => {
  beforeEach(() => {
    mocks.tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-test-'));
    vi.clearAllMocks();
    fakeClient.login.mockResolvedValue({ authorize_url: 'https://github.com/oauth', state: 'state_abc' });
    fakeClient.callback.mockResolvedValue({
      is_new_account: true,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'github', status: 'active', created_at: 't' },
      session: SESSION,
    });
    fakeClient.bind.mockResolvedValue({
      binding_id: 'bind_1',
      account_id: 'cogseed_acc_1',
      local_identity_id: '88492103',
      device: { device_id: 'dev_1', device_name: 'MacBook', is_current: true },
      status: 'active',
      bound_at: 't',
    });
    fakeClient.refresh.mockResolvedValue({
      access_token: 'at2',
      refresh_token: 'rt2',
      access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    fakeClient.healthz.mockResolvedValue(true);
  });
  afterEach(() => {
    fs.rmSync(mocks.tmpConfigDir, { recursive: true, force: true });
  });

  it('startLogin stores the pending state and returns the authorize URL', async () => {
    const res = await authFlow.startLogin('88492103');
    expect(res.authorize_url).toContain('github');
    expect(authFlow.currentLoginState('88492103')).toBe('state_abc');
  });

  it('openAuthorizeUrl opens the system browser', async () => {
    await authFlow.openAuthorizeUrl('https://github.com/oauth');
    expect(mocks.shellOpenExternal).toHaveBeenCalledWith('https://github.com/oauth');
  });

  it('completeLogin rejects a mismatched state', async () => {
    await authFlow.startLogin('88492103');
    await expect(authFlow.completeLogin('88492103', 'code1', 'wrong_state')).rejects.toMatchObject({
      code: 'AUTH_INVALID_STATE',
    });
    expect(fakeClient.callback).not.toHaveBeenCalled();
  });

  it('completeLogin stores the session and binds the local identity for a new account', async () => {
    await authFlow.startLogin('88492103');
    const res = await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    expect(res.is_new_account).toBe(true);
    expect(res.account_id).toBe('cogseed_acc_1');

    const session = loadHubSession('88492103');
    expect(session?.access_token).toBe('at1');

    // bind was called with the local identity + device metadata
    expect(fakeClient.bind).toHaveBeenCalledWith(
      'at1',
      expect.objectContaining({ local_identity_id: '88492103', device_name: expect.any(String), device_os: expect.any(String) }),
    );

    const state = readHubAccountState('88492103');
    expect(state.bound).toBe(true);
    expect(state.device_id).toBe('dev_1');
    expect(state.account_id).toBe('cogseed_acc_1');
  });

  it('completeLogin skips binding for an existing account', async () => {
    fakeClient.callback.mockResolvedValue({
      is_new_account: false,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'github', status: 'active', created_at: 't' },
      session: SESSION,
    });
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    expect(fakeClient.bind).not.toHaveBeenCalled();
  });

  it('refreshSession rotates the credentials', async () => {
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    const next = await authFlow.refreshSession('88492103');
    expect(next.access_token).toBe('at2');
    expect(fakeClient.refresh).toHaveBeenCalledWith('rt1');
    expect(loadHubSession('88492103')?.refresh_token).toBe('rt2');
  });

  it('refreshes before expiry only when the access token is close to expiring', async () => {
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    // fresh session → no refresh
    await authFlow.ensureFreshSession('88492103');
    expect(fakeClient.refresh).not.toHaveBeenCalled();

    // near-expiry session → refresh
    const expiring = {
      ...SESSION,
      access_expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    };
    fakeClient.callback.mockResolvedValue({
      is_new_account: false,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'github', status: 'active', created_at: 't' },
      session: expiring,
    });
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code2', 'state_abc');
    await authFlow.ensureFreshSession('88492103');
    expect(fakeClient.refresh).toHaveBeenCalled();
  });

  it('retries an authenticated call once after an access-token 401', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    fakeClient.me
      .mockRejectedValueOnce(new HubApiError('AUTH_INVALID_TOKEN', 'access_token 已过期或无效', 401))
      .mockResolvedValueOnce({
        account: { account_id: 'cogseed_acc_1', auth_provider: 'github', status: 'active', created_at: 't', bound_local_identity: '88492103', community_profile: { display_name: null, is_contributor: false } },
        stats: { active_device_count: 1, consent_count: 0 },
      });
    const me = await authFlow.getAccountMe('88492103');
    expect(me.stats.active_device_count).toBe(1);
    expect(fakeClient.refresh).toHaveBeenCalledWith('rt1');
    // second attempt used the rotated token
    expect(fakeClient.me).toHaveBeenCalledTimes(2);
    expect(fakeClient.me.mock.calls[1][0]).toBe('at2');
  });

  it('listDevices surfaces the device list through the auth retry path', async () => {
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    fakeClient.listDevices.mockResolvedValue({
      data: [{ device_id: 'dev_1', device_name: 'MacBook', device_os: 'macOS 15.0', is_current: true, first_seen_at: 'a', last_seen_at: 'b', active_sessions: 1, status: 'active' }],
      total: 1,
    });
    const devices = await authFlow.listDevices('88492103');
    expect(devices).toHaveLength(1);
    expect(devices[0].device_id).toBe('dev_1');
    expect(fakeClient.listDevices).toHaveBeenCalled();
  });

  it('logout revokes server-side and clears local credentials while preserving state file semantics', async () => {
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    await authFlow.logout('88492103');
    expect(fakeClient.logout).toHaveBeenCalledWith('at1');
    expect(loadHubSession('88492103')).toBeNull();
    const state = readHubAccountState('88492103');
    expect(state.bound).toBe(false);
    expect(state.account_id).toBeUndefined();
  });

  it('logout still clears local credentials when the server is unreachable', async () => {
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    fakeClient.logout.mockRejectedValueOnce(new Error('network down'));
    await authFlow.logout('88492103');
    expect(loadHubSession('88492103')).toBeNull();
  });

  it('getHubStatus reports signed-out with reachable hub', async () => {
    const status = await authFlow.getHubStatus('88492103');
    expect(status.signed_in).toBe(false);
    expect(status.hub_reachable).toBe(true);
  });

  it('getHubStatus reports signed-in without exposing tokens', async () => {
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    const status = await authFlow.getHubStatus('88492103');
    expect(status.signed_in).toBe(true);
    expect(status.account_id).toBe('cogseed_acc_1');
    expect(JSON.stringify(status)).not.toContain('at1');
    expect(JSON.stringify(status)).not.toContain('rt1');
  });

  it('getHubStatus reflects hub unreachability', async () => {
    fakeClient.healthz.mockResolvedValue(false);
    const status = await authFlow.getHubStatus('88492103');
    expect(status.hub_reachable).toBe(false);
  });

  it('cleanup helper clears the session', () => {
    clearHubSession('88492103');
    expect(loadHubSession('88492103')).toBeNull();
  });
});
