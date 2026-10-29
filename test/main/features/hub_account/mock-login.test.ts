import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 本机 mock 登录（dev-only）。
 *
 * Hub 的 `provider=mock` 只在 development 下签发，但它签发的是**真实会话**，
 * 所以这条路径能支撑「本机双客户端冒烟」。它必须被两道闸门挡住：显式环境开关
 * 与非 release 通道；任何一道不满足都要明确拒绝，绝不静默降级成别的登录方式。
 */
const USER = 'u1';
let tmp: string;
let previousRoot: string | undefined;
let previousFlag: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mock-login-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  previousFlag = process.env.COGSEED_HUB_MOCK_LOGIN;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  if (previousFlag === undefined) delete process.env.COGSEED_HUB_MOCK_LOGIN;
  else process.env.COGSEED_HUB_MOCK_LOGIN = previousFlag;
  delete process.env.COGSEED_BUILD_CHANNEL;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeClient() {
  const now = Date.now();
  return {
    login: vi.fn(async () => ({ authorize_url: 'mock://authorize', state: 'state-1', mock_code: 'mock_abc' })),
    callback: vi.fn(async () => ({
      is_new_account: false,
      account: { account_id: 'cs_test', auth_provider: 'sms', status: 'active' },
      session: {
        session_id: 'session-1',
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        access_expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        refresh_expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    })),
  } as any;
}

describe('hub mock login › development only', () => {
  it('refuses without the explicit environment switch', async () => {
    const { startMockLogin } = await import('../../../../src/main/features/hub_account/auth-flow');
    const client = fakeClient();

    await expect(startMockLogin(USER, client)).rejects.toMatchObject({ code: 'AUTH_MOCK_DISABLED' });
    expect(client.login).not.toHaveBeenCalled();
  });

  it('refuses on a release channel even when the switch is set', async () => {
    process.env.COGSEED_HUB_MOCK_LOGIN = '1';
    process.env.COGSEED_BUILD_CHANNEL = 'release';
    const { startMockLogin, isMockLoginAllowed } = await import('../../../../src/main/features/hub_account/auth-flow');
    const client = fakeClient();

    expect(isMockLoginAllowed()).toBe(false);
    await expect(startMockLogin(USER, client)).rejects.toMatchObject({ code: 'AUTH_MOCK_DISABLED' });
    expect(client.login).not.toHaveBeenCalled();
  });

  it('completes a real session through the mock code', async () => {
    process.env.COGSEED_HUB_MOCK_LOGIN = '1';
    delete process.env.COGSEED_BUILD_CHANNEL;
    const { startMockLogin } = await import('../../../../src/main/features/hub_account/auth-flow');
    const { loadHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    const client = fakeClient();

    const result = await startMockLogin(USER, client);

    expect(client.login).toHaveBeenCalledWith('mock', expect.stringContaining('account/callback'));
    expect(client.callback).toHaveBeenCalledWith('mock_abc', 'state-1', expect.any(Object));
    expect(result).toEqual({ account_id: 'cs_test', is_new_account: false });
    // 会话真的落盘了：后续 relay/contacts 走的就是这条正常会话。
    expect(loadHubSession(USER)?.access_token).toBe('access-1');
  });
});
