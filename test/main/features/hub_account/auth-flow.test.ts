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
  updateProfile: vi.fn(),
  bind: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  listConsents: vi.fn(),
  setConsent: vi.fn(),
  revokeConsent: vi.fn(),
  deleteAccount: vi.fn(),
  deletionImpact: vi.fn(),
  sendDeletionCode: vi.fn(),
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
import { loadHubSession, saveHubSession, clearHubSession } from '../../../../src/main/features/hub_account/tokens';
import { readHubAccountState } from '../../../../src/main/features/hub_account/state';

const SESSION = {
  session_id: 'sess_1',
  access_token: 'at1',
  refresh_token: 'rt1',
  access_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
};

const ROTATED = {
  access_token: 'at2',
  refresh_token: 'rt2',
  access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
};

async function loginForTest(code = 'code1', state = 'state_abc') {
  await authFlow.startLogin('88492103');
  return authFlow.completeLogin('88492103', code, state);
}

describe('hub account auth-flow', () => {
  beforeEach(() => {
    mocks.tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-test-'));
    vi.clearAllMocks();
    authFlow._resetHubAuthStateForTest();
    fakeClient.login.mockResolvedValue({ authorize_url: 'https://hub.example.com/login', state: 'state_abc' });
    fakeClient.callback.mockResolvedValue({
      is_new_account: true,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'web', status: 'active', created_at: 't' },
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
    expect(res.authorize_url).toContain('hub.example.com');
    expect(authFlow.currentLoginState('88492103')).toBe('state_abc');
  });

  it('openAuthorizeUrl opens the system browser', async () => {
    await authFlow.openAuthorizeUrl('https://hub.example.com/login');
    expect(mocks.shellOpenExternal).toHaveBeenCalledWith('https://hub.example.com/login');
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
    expect(state.installation_id).toBeTypeOf('string');
    expect(fakeClient.callback).toHaveBeenCalledWith(
      'code1',
      'state_abc',
      expect.objectContaining({
        installation_id: state.installation_id,
        device_name: expect.any(String),
        device_os: expect.any(String),
      }),
    );
  });

  it('completeLogin skips binding for an existing account', async () => {
    fakeClient.callback.mockResolvedValue({
      is_new_account: false,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'web', status: 'active', created_at: 't' },
      session: SESSION,
    });
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    expect(fakeClient.bind).not.toHaveBeenCalled();
  });

  it('does not report a successful login or restore binding after logout during bind', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fakeClient.bind.mockImplementationOnce(async () => {
      entered(); await gate;
      return { device: { device_id: 'late-device', device_name: 'late' }, bound_at: 'late' };
    });
    await authFlow.startLogin('88492103');
    const pending = authFlow.completeLogin('88492103', 'code1', 'state_abc');
    const result = pending.then(() => ({ code: 'unexpected_success' }), (error) => error);
    await started;
    await authFlow.logout('88492103');
    release();
    expect(await result).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(loadHubSession('88492103')).toBeNull();
    expect(readHubAccountState('88492103').bound).toBe(false);
  });

  // 回归：bind 是设备元数据，不是认证步骤。它一旦抛出就会让"已经保存 session"的
  // 登录被报告为失败（界面显示未登录，但本地其实已登录），且 pending state 不被清除。
  it('completeLogin succeeds even when binding the local identity fails', async () => {
    fakeClient.bind.mockRejectedValue(new Error('bind endpoint unreachable'));
    await authFlow.startLogin('88492103');

    const res = await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    expect(res.account_id).toBe('cogseed_acc_1');
    expect(res.is_new_account).toBe(true);

    // session 已落盘，登录视为成功
    expect(loadHubSession('88492103')?.access_token).toBe('at1');
    expect((await authFlow.getHubStatus('88492103')).signed_in).toBe(true);

    // 一次性 state 已消费，不应残留
    expect(authFlow.currentLoginState('88492103')).toBeNull();

    // 未绑定成功时不应谎报 bound
    expect(readHubAccountState('88492103').bound).not.toBe(true);
  });

  it('completeLogin clears the pending state after a successful login', async () => {
    await authFlow.startLogin('88492103');
    expect(authFlow.currentLoginState('88492103')).toBe('state_abc');
    await authFlow.completeLogin('88492103', 'code1', 'state_abc');
    expect(authFlow.currentLoginState('88492103')).toBeNull();
  });

  it('reuses the same installation_id across later logins', async () => {
    await loginForTest();
    const firstInstallationId = readHubAccountState('88492103').installation_id;
    expect(firstInstallationId).toBeTypeOf('string');

    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code2', 'state_abc');

    expect(fakeClient.callback).toHaveBeenNthCalledWith(
      2,
      'code2',
      'state_abc',
      expect.objectContaining({ installation_id: firstInstallationId }),
    );
    expect(readHubAccountState('88492103').installation_id).toBe(firstInstallationId);
  });

  it('refreshSession rotates the credentials', async () => {
    await loginForTest();
    const next = await authFlow.refreshSession('88492103');
    expect(next.access_token).toBe('at2');
    expect(fakeClient.refresh).toHaveBeenCalledWith('rt1');
    expect(loadHubSession('88492103')?.refresh_token).toBe('rt2');
  });

  it('refreshes before expiry only when the access token is close to expiring', async () => {
    await loginForTest();
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
      account: { account_id: 'cogseed_acc_1', auth_provider: 'web', status: 'active', created_at: 't' },
      session: expiring,
    });
    await authFlow.startLogin('88492103');
    await authFlow.completeLogin('88492103', 'code2', 'state_abc');
    await authFlow.ensureFreshSession('88492103');
    expect(fakeClient.refresh).toHaveBeenCalled();
  });

  it('retries an authenticated call once after an access-token 401', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await loginForTest();
    fakeClient.me
      .mockRejectedValueOnce(new HubApiError('AUTH_INVALID_TOKEN', 'access_token 已过期或无效', 401))
      .mockResolvedValueOnce({
        account: { account_id: 'cogseed_acc_1', auth_provider: 'web', status: 'active', created_at: 't', bound_local_identity: '88492103', community_profile: { display_name: null, is_contributor: false } },
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
    await loginForTest();
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
    await loginForTest();
    await authFlow.logout('88492103');
    expect(fakeClient.logout).toHaveBeenCalledWith('at1');
    expect(loadHubSession('88492103')).toBeNull();
    const state = readHubAccountState('88492103');
    expect(state.bound).toBe(false);
    expect(state.account_id).toBeUndefined();
  });

  it('logout still clears local credentials when the server is unreachable', async () => {
    await loginForTest();
    fakeClient.logout.mockRejectedValueOnce(new Error('network down'));
    await authFlow.logout('88492103');
    expect(loadHubSession('88492103')).toBeNull();
  });

  it('deleteHubAccount sends the reauth payload and clears the local Hub session (DEL-02/03)', async () => {
    await loginForTest();
    fakeClient.deleteAccount.mockResolvedValue({
      account_id: 'cogseed_acc_1',
      status: 'pending_deletion',
      requested_at: 't',
      reversal_deadline_at: 'deadline',
      revoked_sessions: 2,
      revoked_devices: 2,
      revoked_consents: 1,
      message: 'ok',
    });
    const result = await authFlow.deleteHubAccount('88492103', {
      confirmation: 'DELETE_MY_ACCOUNT',
      reauth_method: 'sms_code',
      code: '123456',
    });
    expect(result.status).toBe('pending_deletion');
    expect(fakeClient.deleteAccount).toHaveBeenCalledWith('at1', {
      confirmation: 'DELETE_MY_ACCOUNT',
      reauth_method: 'sms_code',
      code: '123456',
    });
    // DEL-03：申请成功即撤销全部 Session——本地清除 Hub 登录态与账号资料展示，
    // 呈现与普通退出登录相同的未登录状态；installation_id 保留以便日后复用设备行。
    expect(loadHubSession('88492103')).toBeNull();
    const state = readHubAccountState('88492103');
    expect(state.account_id).toBeUndefined();
    expect(state.bound).toBe(false);
    expect(state.installation_id).toBeTypeOf('string');
  });

  it('getDeletionImpact and sendDeletionCode go through the auth retry path', async () => {
    await loginForTest();
    fakeClient.deletionImpact.mockResolvedValue({ reversal_days: 30, items: [] });
    fakeClient.sendDeletionCode.mockResolvedValue({ phone_masked: '+86 138****8000', expires_in: 300, resend_after: 60, purpose: 'delete' });

    const impact = await authFlow.getDeletionImpact('88492103');
    expect(impact.reversal_days).toBe(30);
    expect(fakeClient.deletionImpact).toHaveBeenCalledWith('at1');

    const sent = await authFlow.sendDeletionCode('88492103');
    expect(sent.purpose).toBe('delete');
    expect(fakeClient.sendDeletionCode).toHaveBeenCalledWith('at1');
  });

  it('getHubStatus reports signed-out with reachable hub', async () => {
    const status = await authFlow.getHubStatus('88492103');
    expect(status.signed_in).toBe(false);
    expect(status.hub_reachable).toBe(true);
  });

  it('getHubStatus reports signed-in without exposing tokens', async () => {
    await loginForTest();
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

describe('hub account refresh herd suppression', () => {
  const UID = '88492103';
  const OTHER_UID = '11111111';

  beforeEach(() => {
    mocks.tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-herd-'));
    vi.clearAllMocks();
    authFlow._resetHubAuthStateForTest();
    fakeClient.login.mockResolvedValue({ authorize_url: 'https://hub.example.com/login', state: 'state_abc' });
    fakeClient.callback.mockResolvedValue({
      is_new_account: false,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'web', status: 'active', created_at: 't' },
      session: SESSION,
    });
    fakeClient.refresh.mockResolvedValue(ROTATED);
    fakeClient.logout.mockResolvedValue(undefined);
  });
  afterEach(() => {
    fs.rmSync(mocks.tmpConfigDir, { recursive: true, force: true });
  });

  it('collapses concurrent refreshes into a single network call', async () => {
    await loginForTest();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeClient.refresh.mockImplementation(async () => {
      await gate;
      return ROTATED;
    });

    // The settings page fires several authenticated IPC calls at once; each one
    // reaches the silent-refresh path with the same credentials.
    const first = authFlow.refreshSession(UID);
    const second = authFlow.refreshSession(UID);
    const third = authFlow.refreshSession(UID);
    release();

    const [a, b, c] = await Promise.all([first, second, third]);
    expect(fakeClient.refresh).toHaveBeenCalledTimes(1);
    expect([a.access_token, b.access_token, c.access_token]).toEqual(['at2', 'at2', 'at2']);
    expect(loadHubSession(UID)?.refresh_token).toBe('rt2');
  });

  it('stops hitting the network once the refresh token is revoked', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await loginForTest();
    fakeClient.refresh.mockRejectedValue(
      new HubApiError('AUTH_REFRESH_TOKEN_REVOKED', 'refresh_token 已撤销，请重新登录', 401),
    );

    await expect(authFlow.refreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REVOKED' });
    expect(fakeClient.refresh).toHaveBeenCalledTimes(1);

    // A revoked refresh token cannot come back: the near-expiry silent path must
    // surface the same terminal error without another round trip.
    saveHubSession(UID, { ...SESSION, access_expires_at: new Date(Date.now() + 1000).toISOString() });
    await expect(authFlow.ensureFreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REVOKED' });
    await expect(authFlow.ensureFreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REVOKED' });
    await expect(authFlow.refreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REVOKED' });
    expect(fakeClient.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying after a transient network failure', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await loginForTest();
    fakeClient.refresh.mockRejectedValueOnce(new HubApiError('HUB_NETWORK_ERROR', '无法连接 Hub 服务', 0));

    await expect(authFlow.refreshSession(UID)).rejects.toMatchObject({ code: 'HUB_NETWORK_ERROR' });

    fakeClient.refresh.mockResolvedValueOnce(ROTATED);
    const next = await authFlow.refreshSession(UID);
    expect(next.refresh_token).toBe('rt2');
    expect(fakeClient.refresh).toHaveBeenCalledTimes(2);
  });

  it('re-arms silent refresh after a fresh login', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await loginForTest();
    fakeClient.refresh.mockRejectedValue(
      new HubApiError('AUTH_REFRESH_TOKEN_REVOKED', 'refresh_token 已撤销，请重新登录', 401),
    );
    await expect(authFlow.refreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REVOKED' });

    // The user signs in again; a persisted session must clear the terminal marker.
    await authFlow.startLogin(UID);
    await authFlow.completeLogin(UID, 'code2', 'state_abc');

    fakeClient.refresh.mockResolvedValueOnce(ROTATED);
    const next = await authFlow.refreshSession(UID);
    expect(next.refresh_token).toBe('rt2');
  });

  it('clears the terminal marker on sign-out', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await loginForTest();
    fakeClient.refresh.mockRejectedValue(
      new HubApiError('AUTH_REFRESH_TOKEN_REVOKED', 'refresh_token 已撤销，请重新登录', 401),
    );
    await expect(authFlow.refreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REVOKED' });

    await authFlow.logout(UID);

    // Marker gone: the failure is now the local "no session" check, not the
    // stale terminal error.
    await expect(authFlow.refreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fakeClient.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the terminal marker scoped to the failing user', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    await loginForTest();
    fakeClient.refresh.mockRejectedValue(
      new HubApiError('AUTH_REFRESH_TOKEN_REVOKED', 'refresh_token 已撤销，请重新登录', 401),
    );
    await expect(authFlow.refreshSession(UID)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REVOKED' });

    // Stage the second identity only now: the mocked config dir is shared, so
    // writing it earlier would replace the first user's stored session.
    saveHubSession(OTHER_UID, SESSION);
    fakeClient.refresh.mockResolvedValueOnce(ROTATED);
    const other = await authFlow.refreshSession(OTHER_UID);
    expect(other.refresh_token).toBe('rt2');
    expect(fakeClient.refresh).toHaveBeenCalledTimes(2);
  });
});

// T6: completion belongs to the originating session generation.
describe('nickname lifecycle', () => {
  beforeEach(() => {
    mocks.tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nickname-session-'));
    vi.clearAllMocks();
    saveHubSession('88492103', SESSION);
  });
  afterEach(() => fs.rmSync(mocks.tmpConfigDir, {recursive:true, force:true}));
  it.each(['logout', 'replacement'])('rejects a late nickname response after %s', async change => {
    let finish!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(r => {entered = r;});
    fakeClient.updateProfile.mockImplementation(() => {entered(); return new Promise(r => {finish = r;});});
    const pending = authFlow.updateProfile('88492103', {display_name:'New'});
    await started;
    clearHubSession('88492103');
    if (change === 'replacement') saveHubSession('88492103', {...SESSION, session_id:'replacement'});
    finish({account:{account_id:'old', community_profile:{display_name:'New'}}});
    await expect(pending).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  });
  it('uses authenticated retry for PATCH and returns only the profile DTO', async () => {
    const {HubApiError} = await import('../../../../src/main/features/hub_account/client');
    fakeClient.updateProfile.mockRejectedValueOnce(new HubApiError('AUTH_INVALID_TOKEN','expired',401))
      .mockResolvedValueOnce({account:{account_id:'self', community_profile:{display_name:'New'}}});
    fakeClient.refresh.mockResolvedValue(ROTATED);
    const result = await authFlow.updateProfile('88492103', {display_name:'New'});
    expect(result.account.community_profile.display_name).toBe('New');
    expect(fakeClient.updateProfile.mock.calls.map(c => c[0])).toEqual(['at1','at2']);
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token/);
  });
});
