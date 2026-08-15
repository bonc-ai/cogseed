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
  getInstallationId: vi.fn(() => 'install-1'),
  shellOpenExternal: vi.fn(async () => undefined),
  tmpConfigDir: '',
  releaseEnabled: true,
}));

vi.mock('electron', () => ({ shell: { openExternal: mocks.shellOpenExternal } }));
vi.mock('../../../../src/main/features/users', () => ({ getActiveUserId: mocks.getActiveUserId }));
vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({
  tokenStore: { getDeviceId: mocks.getInstallationId },
}));
vi.mock('../../../../src/main/features/hub_account/gate', () => ({
  isHubAccountReleaseEnabled: () => mocks.releaseEnabled,
}));
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
    authFlow._clearPendingLoginForTest();
    mocks.releaseEnabled = true;
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

  it('completeLogin rejects a callback when no login is in flight (forged deep link)', async () => {
    // No startLogin: a forged cogseed://account/callback must be dropped locally.
    await expect(authFlow.completeLogin('88492103', 'code1', 'state_abc')).rejects.toMatchObject({
      code: 'AUTH_NO_PENDING_LOGIN',
    });
    expect(fakeClient.callback).not.toHaveBeenCalled();
    expect(loadHubSession('88492103')).toBeNull();
    expect(readHubAccountState('88492103').bound).toBe(false);
  });

  it('completeLogin rejects a callback after a prior login already completed (stale state)', async () => {
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    // Replaying the same code+state after completion: pending state is gone,
    // so the second callback must be rejected instead of silently re-binding.
    await expect(authFlow.completeLogin('88492103', 'code1', 'state_abc')).rejects.toMatchObject({
      code: 'AUTH_NO_PENDING_LOGIN',
    });
    expect(fakeClient.callback).toHaveBeenCalledTimes(1);
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

  it('completeLogin does NOT re-bind for an existing account (contract v1.3)', async () => {
    fakeClient.callback.mockResolvedValue({
      is_new_account: false,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'github', status: 'active', created_at: 't' },
      session: SESSION,
    });
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    // Returning users already have a binding; the desktop must not re-bind.
    expect(fakeClient.bind).not.toHaveBeenCalled();
    expect(loadHubSession('88492103')?.access_token).toBe('at1');
    // Without a fresh bind, binding metadata stays as-is (unbound here).
    expect(readHubAccountState('88492103').bound).toBe(false);
  });

  it('clears the just-issued Hub credentials when mandatory binding fails', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    fakeClient.bind.mockRejectedValueOnce(new HubApiError('BINDING_ALREADY_EXISTS', 'conflict', 409));
    await authFlow.startLogin('88492103');
    await expect(authFlow.completeLogin('88492103', 'code1', 'state_abc')).rejects.toMatchObject({ code: 'BINDING_ALREADY_EXISTS' });
    expect(fakeClient.logout).toHaveBeenCalledWith('at1');
    expect(loadHubSession('88492103')).toBeNull();
    expect(readHubAccountState('88492103').bound).toBe(false);
  });

  it('refreshSession rotates the credentials', async () => {
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    const next = await authFlow.refreshSession('88492103');
    expect(next.access_token).toBe('at2');
    expect(fakeClient.refresh).toHaveBeenCalledWith('rt1');
    expect(loadHubSession('88492103')?.refresh_token).toBe('rt2');
  });

  type RefreshResult = {
    access_token: string;
    refresh_token: string;
    access_expires_at: string;
    refresh_expires_at: string;
  };

  it('shares a single in-flight refresh across concurrent callers', async () => {
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    let resolveRefresh!: (value: RefreshResult) => void;
    fakeClient.refresh.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    const first = authFlow.refreshSession('88492103');
    const second = authFlow.refreshSession('88492103');
    resolveRefresh({
      access_token: 'at2',
      refresh_token: 'rt2',
      access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    const [r1, r2] = await Promise.all([first, second]);
    expect(fakeClient.refresh).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
    expect(r1.access_token).toBe('at2');
    expect(loadHubSession('88492103')?.refresh_token).toBe('rt2');
  });

  it('allows a new refresh after an in-flight refresh fails', async () => {
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    fakeClient.refresh.mockRejectedValueOnce(new Error('network down'));
    await expect(authFlow.refreshSession('88492103')).rejects.toThrow('network down');
    const next = await authFlow.refreshSession('88492103');
    expect(fakeClient.refresh).toHaveBeenCalledTimes(2);
    expect(next.access_token).toBe('at2');
  });

  it('logout drains an in-flight refresh so a late write-back cannot restore credentials', async () => {
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    let resolveRefresh!: (value: RefreshResult) => void;
    fakeClient.refresh.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    const refreshing = authFlow.refreshSession('88492103');
    const loggingOut = authFlow.logout('88492103');
    resolveRefresh({
      access_token: 'at2',
      refresh_token: 'rt2',
      access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    await Promise.all([refreshing, loggingOut]);
    expect(loadHubSession('88492103')).toBeNull();
    expect(fakeClient.logout).toHaveBeenCalledWith('at2');
  });

  it('refreshes before expiry only when the access token is close to expiring', async () => {
    await authFlow.startLogin('88492103');
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
    await authFlow.startLogin('88492103');
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

  it.each([
    ['AUTH_SESSION_REVOKED', 'active'],
    ['AUTH_DEVICE_REVOKED', 'active'],
    ['ACCOUNT_SUSPENDED', 'suspended'],
    ['ACCOUNT_PENDING_DELETION', 'pending_deletion'],
    ['ACCOUNT_DELETED', 'deleted'],
  ])('clears stale credentials for authoritative terminal error %s', async (code, status) => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    fakeClient.me.mockRejectedValueOnce(new HubApiError(code, 'terminal', code.startsWith('ACCOUNT_') ? 403 : 401));
    await expect(authFlow.getAccountMe('88492103')).rejects.toMatchObject({ code });
    expect(loadHubSession('88492103')).toBeNull();
    expect(readHubAccountState('88492103').account_status).toBe(status);
  });

  it('listDevices surfaces the device list through the auth retry path', async () => {
    await authFlow.startLogin('88492103');
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

  it('deleteHubAccount clears Hub credentials immediately and preserves pending-deletion status', async () => {
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    fakeClient.deleteAccount.mockResolvedValue({
      account_id: 'cogseed_acc_1',
      status: 'pending_deletion',
      deletion_scheduled_at: 'later',
    });
    await authFlow.deleteHubAccount('88492103', 'DELETE_MY_ACCOUNT');
    expect(loadHubSession('88492103')).toBeNull();
    expect(readHubAccountState('88492103')).toMatchObject({ bound: false, account_status: 'pending_deletion' });
  });

  it('logout revokes server-side and clears local credentials while preserving state file semantics', async () => {
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    await authFlow.logout('88492103');
    expect(fakeClient.logout).toHaveBeenCalledWith('at1');
    expect(loadHubSession('88492103')).toBeNull();
    const state = readHubAccountState('88492103');
    expect(state.bound).toBe(false);
    expect(state.account_id).toBeUndefined();
  });

  it('logout still clears local credentials when the server is unreachable', async () => {
    await authFlow.startLogin('88492103');
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

  it('getHubStatus does not probe the network while the release Gate is closed', async () => {
    mocks.releaseEnabled = false;
    const status = await authFlow.getHubStatus('88492103');
    expect(status.release_enabled).toBe(false);
    expect(status.disabled_reason).toBe('release_gate');
    expect(status.hub_reachable).toBe(false);
    expect(fakeClient.healthz).not.toHaveBeenCalled();
  });

  it('getHubStatus reports signed-in without exposing tokens', async () => {
    await authFlow.startLogin('88492103');
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
