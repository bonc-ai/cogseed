import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ enabled: true }));

vi.mock('../../../../src/main/features/hub_account/gate', () => ({
  assertHubAccountReleaseEnabled: () => {
    if (!mocks.enabled) {
      const error = new Error('closed') as Error & { code: string };
      error.code = 'HUB_RELEASE_GATE_CLOSED';
      throw error;
    }
  },
}));

import { _test, handleAccountCallbackUrl } from '../../../../src/main/features/hub_account';

describe('Hub account deep-link parsing', () => {
  it('accepts only the canonical callback route', () => {
    expect(_test.accountCallbackUrl('cogseed://account/callback?code=a&state=b')).toBeTruthy();
    expect(_test.accountCallbackUrl('https://account/callback?code=a&state=b')).toBeNull();
    expect(_test.accountCallbackUrl('cogseed://ACCOUNT/callback/?code=a&state=b')).toBeTruthy();
    expect(_test.accountCallbackUrl('cogseed://account/other?code=a&state=b')).toBeNull();
  });

  it('rejects duplicate, empty, or oversized security parameters', () => {
    expect(_test.parseAccountCallback('cogseed://account/callback?code=a&code=b&state=c')).toEqual({ ok: false, error: 'duplicate_code' });
    expect(_test.parseAccountCallback('cogseed://account/callback?code=a&state=b&state=c')).toEqual({ ok: false, error: 'duplicate_state' });
    expect(_test.parseAccountCallback('cogseed://account/callback?code=&state=b')).toEqual({ ok: false, error: 'missing_code' });
    expect(_test.parseAccountCallback(`cogseed://account/callback?code=${'a'.repeat(4097)}&state=b`)).toEqual({ ok: false, error: 'invalid_code' });
  });

  it('does not consume authorization parameters while the release Gate is closed', async () => {
    mocks.enabled = false;
    await expect(handleAccountCallbackUrl('cogseed://account/callback?code=secret-code&state=secret-state'))
      .resolves.toEqual({ ok: false, error: 'HUB_RELEASE_GATE_CLOSED' });
  });
});

// ---------------------------------------------------------------------------
// 「换个 CogSeed 账号登录」深链（specs/004-oauth-account-rebind，契约 §2/§3）
//
// 🔴 存在的理由：插件授权页由课程平台渲染于系统浏览器，而登录入口是桌面端的
//    IPC（`hub-account.start_login`）——浏览器里的页面调不到它。深链是唯一能把
//    "用户想换账号"这一意图交给客户端的通道。
// ---------------------------------------------------------------------------

describe('换账号深链 cogseed://account/switch', () => {
  it('🔴 只认规范形状；带任何参数一律拒绝（契约要求不携带参数）', () => {
    // 规范形状
    expect(_test.accountSwitchRequested('cogseed://account/switch')).toBeTruthy();
    expect(_test.accountSwitchRequested('cogseed://ACCOUNT/switch/')).toBeTruthy();
    // 带参数 → 拒绝：它只该是"意图信号"，不能变成可构造的入口
    expect(_test.accountSwitchRequested('cogseed://account/switch?account_id=x')).toBeNull();
    expect(_test.accountSwitchRequested('cogseed://account/switch?hub_token=x')).toBeNull();
    // 非本深链
    expect(_test.accountSwitchRequested('cogseed://account/callback?code=a&state=b')).toBeNull();
    expect(_test.accountSwitchRequested('cogseed://account/other')).toBeNull();
    expect(_test.accountSwitchRequested('https://account/switch')).toBeNull();
    expect(_test.accountSwitchRequested('cogseed://plugin/authorize/callback?code=a')).toBeNull();
  });

  it('🔴 与登录回调是两个不同的形状，不得互相误吞', () => {
    // callback 需要 code+state；switch 不带参数 —— 两者不能互相匹配
    expect(_test.accountCallbackUrl('cogseed://account/switch')).toBeNull();
    expect(_test.accountSwitchRequested('cogseed://account/callback?code=a&state=b')).toBeNull();
  });
});
