import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fakeClient = vi.hoisted(() => ({
  login: vi.fn(),
  callback: vi.fn(),
  bind: vi.fn(),
  healthz: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  getActiveUserId: vi.fn(() => '88492103'),
  shellOpenExternal: vi.fn(async () => undefined),
  broadcastHubLoginOutcome: vi.fn(),
  tmpConfigDir: '',
}));

vi.mock('electron', () => ({ shell: { openExternal: mocks.shellOpenExternal } }));
vi.mock('../../../../src/main/features/users', () => ({ getActiveUserId: mocks.getActiveUserId }));
// 发布 Gate 默认关闭（GitHub 登录已撤除）；本文件测试的是 deep link 结果广播，
// 与 Gate 无关，因此直接放行。
vi.mock('../../../../src/main/features/hub_account/gate', () => ({
  assertHubAccountReleaseEnabled: () => undefined,
}));
vi.mock('../../../../src/main/paths', () => ({
  userLocalConfigDir: () => mocks.tmpConfigDir,
  WS_ROOT: mocks.tmpConfigDir,
}));

vi.mock('../../../../src/main/features/hub_account/account-events', () => ({
  broadcastHubLoginOutcome: (...args: unknown[]) => mocks.broadcastHubLoginOutcome(...args),
}));

vi.mock('../../../../src/main/features/hub_account/client', () => ({
  HubApiError: class HubApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = 'HubApiError';
      this.code = code;
      this.status = status;
    }
  },
  hubClient: () => fakeClient,
  createHubClient: () => fakeClient,
  hubApiBase: () => 'http://hub.test',
}));

import { handleAccountCallbackUrl } from '../../../../src/main/features/hub_account';
import * as authFlow from '../../../../src/main/features/hub_account/auth-flow';

const SESSION = {
  session_id: 'sess_1',
  access_token: 'at1',
  refresh_token: 'rt1',
  access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
};

const CALLBACK = 'cogseed://account/callback?code=code1&state=state_abc';
const SRC = path.join(__dirname, '../../../../src/main');

// deep link 登录完成后渲染进程不 await 任何东西，只能靠推送事件刷新界面。
// 缺少这个广播时账号面板会一直停在未登录状态：focus 处理器既有竞态
// （主进程先 focus 窗口，再 await completeLogin），又要求账号面板当时可见。
describe('hub account deep-link 登录结果广播', () => {
  beforeEach(() => {
    mocks.tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-events-'));
    vi.clearAllMocks();
    fakeClient.login.mockResolvedValue({ authorize_url: 'https://cogseed-open.bonc.com.cn/login', state: 'state_abc' });
    fakeClient.callback.mockResolvedValue({
      is_new_account: false,
      account: { account_id: 'cogseed_acc_1', auth_provider: 'web', status: 'active', created_at: 't' },
      session: SESSION,
    });
  });

  it('登录成功时广播 success 结果', async () => {
    await authFlow.startLogin('88492103');
    const res = await handleAccountCallbackUrl(CALLBACK);

    expect(res.ok).toBe(true);
    expect(mocks.broadcastHubLoginOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', account_id: 'cogseed_acc_1', is_new_account: false }),
    );
  });

  it('后端 callback 失败时广播 failure 与错误码', async () => {
    const { HubApiError } = await import('../../../../src/main/features/hub_account/client');
    fakeClient.callback.mockRejectedValue(new HubApiError('AUTH_CODE_EXCHANGE_FAILED', '无法连接 GitHub', 502));
    await authFlow.startLogin('88492103');

    const res = await handleAccountCallbackUrl(CALLBACK);

    expect(res.ok).toBe(false);
    expect(mocks.broadcastHubLoginOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'failure', code: 'AUTH_CODE_EXCHANGE_FAILED' }),
    );
  });

  it('缺少 code / state 时也广播 failure（否则界面无从得知）', async () => {
    await handleAccountCallbackUrl('cogseed://account/callback?state=state_abc');
    expect(mocks.broadcastHubLoginOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'failure', code: 'missing_code' }),
    );

    mocks.broadcastHubLoginOutcome.mockClear();
    await handleAccountCallbackUrl('cogseed://account/callback?code=code1');
    expect(mocks.broadcastHubLoginOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'failure', code: 'missing_state' }),
    );
  });

  it('非账号 deep link 不产生广播', async () => {
    const res = await handleAccountCallbackUrl('cogseed://connectors/oauth/callback?code=x');
    expect(res.ok).toBe(false);
    expect(mocks.broadcastHubLoginOutcome).not.toHaveBeenCalled();
  });
});

// 通道名分散在三处：主进程广播、preload 白名单前缀、渲染端订阅。
// 任一处改动而其余不同步，都会让登录后界面静默地不刷新，且没有报错。
describe('登录结果通道名三处一致', () => {
  const CHANNEL = 'hub-account:login-result';

  it('主进程用该通道广播', () => {
    const src = fs.readFileSync(path.join(SRC, 'features/hub_account/account-events.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('preload 的 push-event 白名单放行该前缀', () => {
    const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
    const line = preload.split('\n').find((l) => l.includes('PUSH_EVENT_PREFIXES ='));
    expect(line).toBeTruthy();
    expect(line).toContain("'hub-account:'");
  });

  it('渲染端订阅同一通道', () => {
    const renderer = fs.readFileSync(path.join(SRC, '../renderer/modules/hub-account.js'), 'utf8');
    expect(renderer).toContain(`onPushEvent('${CHANNEL}'`);
  });
});
