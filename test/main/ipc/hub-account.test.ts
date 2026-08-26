import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: false,
  getHubStatus: vi.fn(async () => ({
    signed_in: false,
    account_id: null,
    auth_provider: null,
    bound: false,
    device_id: null,
    account_status: null,
    hub_reachable: false,
    access_expires_at: null,
    release_enabled: false,
    disabled_reason: 'release_gate',
  })),
  startLogin: vi.fn(),
  openAuthorizeUrl: vi.fn(),
  logout: vi.fn(),
  getAccountMe: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  listConsents: vi.fn(),
  setConsent: vi.fn(),
  revokeConsent: vi.fn(),
  deleteHubAccount: vi.fn(),
  getDeletionImpact: vi.fn(),
  sendDeletionCode: vi.fn(),
}));

vi.mock('../../../src/main/features/hub_account', () => ({
  HubApiError: class HubApiError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  },
  getHubStatus: mocks.getHubStatus,
  startLogin: mocks.startLogin,
  openAuthorizeUrl: mocks.openAuthorizeUrl,
  logout: mocks.logout,
  getAccountMe: mocks.getAccountMe,
  listDevices: mocks.listDevices,
  revokeDevice: mocks.revokeDevice,
  listConsents: mocks.listConsents,
  setConsent: mocks.setConsent,
  revokeConsent: mocks.revokeConsent,
  deleteHubAccount: mocks.deleteHubAccount,
  getDeletionImpact: mocks.getDeletionImpact,
  sendDeletionCode: mocks.sendDeletionCode,
}));

vi.mock('../../../src/main/features/hub_account/gate', () => ({
  assertHubAccountReleaseEnabled: () => {
    if (!mocks.enabled) {
      const error = new Error('Hub 账号能力尚未通过发布 Gate') as Error & { code: string; status: number };
      error.code = 'HUB_RELEASE_GATE_CLOSED';
      error.status = 503;
      throw error;
    }
  },
  // status 端点在关闭 Gate 时仍须可读（渲染端据此展示关闭提示而非登录卡）。
  isHubAccountReleaseEnabled: () => mocks.enabled,
}));

import { invokeHandlers } from '../../../src/main/ipc/hub-account';

describe('Hub account IPC release gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = false;
  });

  it('keeps renderer-safe status readable while the release Gate is closed', async () => {
    const result = await invokeHandlers['hub-account.status']({}, { userId: 'u1' });
    expect(result.status.release_enabled).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token|Bearer/);
  });

  it('never leaks tokens through status even when signed in', async () => {
    mocks.enabled = true;
    mocks.getHubStatus.mockResolvedValueOnce({
      signed_in: true,
      account_id: 'cogseed_acc_1',
      auth_provider: 'web',
      bound: true,
      device_id: 'dev_1',
      account_status: 'active',
      hub_reachable: true,
      access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      release_enabled: true,
      disabled_reason: null,
    });
    const result = await invokeHandlers['hub-account.status']({}, { userId: 'u1' });
    expect(result.status.signed_in).toBe(true);
    const serialized = JSON.stringify(result);
    // Only the expiry timestamp is exposed — never the credentials themselves.
    expect(serialized).not.toMatch(/access_token|refresh_token|"at1"|"rt1"|Bearer\s+[A-Za-z0-9]/);
  });

  it.each([
    ['hub-account.start_login', {}],
    ['hub-account.me', {}],
    ['hub-account.devices', {}],
    ['hub-account.revoke_device', { device_id: 'd1' }],
    ['hub-account.consents', {}],
    ['hub-account.set_consent', { scope: 'cloud.sync' }],
    ['hub-account.revoke_consent', { scope: 'cloud.sync' }],
    ['hub-account.deletion_impact', {}],
    ['hub-account.deletion_send_code', {}],
    ['hub-account.delete_account', { confirmation: 'DELETE_MY_ACCOUNT', reauth_method: 'sms_code', code: '123456' }],
  ] as const)('blocks %s before calling feature code', async (channel, payload) => {
    await expect(invokeHandlers[channel](payload, { userId: 'u1' })).rejects.toMatchObject({ code: 'HUB_RELEASE_GATE_CLOSED' });
    expect(mocks.startLogin).not.toHaveBeenCalled();
    expect(mocks.getAccountMe).not.toHaveBeenCalled();
  });

  it('validates the delete_account payload before touching the feature layer', async () => {
    mocks.enabled = true;
    // 缺少重新认证方式 → 参数校验失败，不调用业务层。
    await expect(invokeHandlers['hub-account.delete_account']({ confirmation: 'DELETE_MY_ACCOUNT' }, { userId: 'u1' })).rejects.toThrow('invalid reauth_method');
    expect(mocks.deleteHubAccount).not.toHaveBeenCalled();

    // 确认短语不符 → 拒绝。
    await expect(
      invokeHandlers['hub-account.delete_account']({ confirmation: 'nope', reauth_method: 'password', password: 'p' }, { userId: 'u1' }),
    ).rejects.toThrow('invalid confirmation');
    expect(mocks.deleteHubAccount).not.toHaveBeenCalled();

    // 短信验证码方式缺 code → 拒绝。
    await expect(
      invokeHandlers['hub-account.delete_account']({ confirmation: 'DELETE_MY_ACCOUNT', reauth_method: 'sms_code' }, { userId: 'u1' }),
    ).rejects.toThrow('invalid code');
    expect(mocks.deleteHubAccount).not.toHaveBeenCalled();
  });

  it('forwards the reauth payload to the feature layer and broadcasts the state change', async () => {
    mocks.enabled = true;
    mocks.deleteHubAccount.mockResolvedValueOnce({
      account_id: 'cogseed_acc_1',
      status: 'pending_deletion',
      requested_at: 't',
      reversal_deadline_at: 'deadline',
      revoked_sessions: 1,
      revoked_devices: 1,
      revoked_consents: 0,
      message: 'ok',
    });
    const result = await invokeHandlers['hub-account.delete_account'](
      { confirmation: 'DELETE_MY_ACCOUNT', reauth_method: 'password', password: 'secret' },
      { userId: 'u1' },
    );
    expect(mocks.deleteHubAccount).toHaveBeenCalledWith('u1', {
      confirmation: 'DELETE_MY_ACCOUNT',
      reauth_method: 'password',
      password: 'secret',
    });
    expect(result.deletion.status).toBe('pending_deletion');
  });

  it('lets logout through even while the release Gate is closed (user right to sign out)', async () => {
    // hub-account.logout 故意不设 release gate：gate 关闭时拦截 logout 会把
    // 已登录用户困住（无法退出、也无法再登录）——本地清理是用户正当权利。
    mocks.logout.mockResolvedValueOnce(undefined);
    const result = await invokeHandlers['hub-account.logout']({}, { userId: 'u1' });
    expect(result).toEqual({ signed_out: true });
    expect(mocks.logout).toHaveBeenCalledWith('u1');
  });
});
