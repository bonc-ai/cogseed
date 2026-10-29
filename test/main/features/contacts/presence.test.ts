import { describe, expect, it, vi } from 'vitest';

/** 心跳按当前身份运行（T2.2）：这里用一个固定本地用户，注入替身忽略它。 */
const USER = 'u1';

/**
 * 在线心跳（D-3/FR-25）：服务端按心跳 + 120 秒窗口判定在线，客户端只负责定时报到。
 * 没心跳时所有人都离线，而离线联系人在 @ 面板里不可选（AC-03）——所以这条不是装饰。
 */
describe('a2a presence heartbeat', () => {
  it('does nothing when the hub is not configured', async () => {
    const { startPresenceHeartbeat, resetPresenceHeartbeatForTest } = await import('../../../../src/main/features/contacts/presence');
    resetPresenceHeartbeatForTest();
    const ping = vi.fn(async () => {});
    const setIntervalFn = vi.fn(() => 1);
    const stop = startPresenceHeartbeat(USER, { ping, configured: () => false, setIntervalFn });

    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    stop();
  });

  it('pings immediately and then on the interval', async () => {
    const { startPresenceHeartbeat, resetPresenceHeartbeatForTest } = await import('../../../../src/main/features/contacts/presence');
    resetPresenceHeartbeatForTest();
    const ping = vi.fn(async () => {});
    let tick: (() => void) | null = null;
    const stop = startPresenceHeartbeat(USER, {
      ping,
      configured: () => true,
      intervalMs: 60_000,
      setIntervalFn: (handler) => { tick = handler; return 7; },
    });
    await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(1));
    expect(tick).toBeTypeOf('function');
    if (tick) (tick as () => void)();
    await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(2));
    stop();
  });

  it('swallows a failing ping instead of taking the boot path down', async () => {
    const { pingPresenceOnce } = await import('../../../../src/main/features/contacts/presence');
    const ok = await pingPresenceOnce(USER, {
      configured: () => true,
      ping: async () => { throw new Error('hub down'); },
    });
    expect(ok).toBe(false);
  });
});

describe('consent state › absent means not granted', () => {
  it('reads only an explicit grant as on', async () => {
    const { consentState } = await import('../../../../src/main/features/contacts/hub-client');
    // Hub 侧缺记录＝没开过（默认关），客户端读出同一个结论，别把「没开过」说成「没关过」。
    expect(consentState({}, 'contacts.discoverable')).toBe(false);
    expect(consentState(null, 'contacts.discoverable')).toBe(false);
    expect(consentState({ 'contacts.discoverable': false }, 'contacts.discoverable')).toBe(false);
    expect(consentState({ 'contacts.discoverable': true }, 'contacts.discoverable')).toBe(true);
  });
});
