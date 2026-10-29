import { describe, expect, it, vi } from 'vitest';

/**
 * 身份生命周期收尾（T2.3）。
 *
 * 退出登录不只是清会话：由旧身份派生的内存状态也必须撤销，否则退出后仍有路径
 * 用旧身份动作——缓存的本方账号 id、在线心跳、排队中的接待提示。
 */
describe('hub session lifecycle › identity teardown', () => {
  it('cancels queued nudges, stops the heartbeat and drops the self-account cache on sign-out', async () => {
    const { onSignedOut } = await import('../../../../src/main/features/hub_account/session-lifecycle');
    const cancelNudges = vi.fn(() => 2);
    const stopPresence = vi.fn();
    const resetSelfAccount = vi.fn();

    const result = await onSignedOut('u1', { cancelNudges, stopPresence, resetSelfAccount });

    expect(cancelNudges).toHaveBeenCalledWith('u1');
    expect(stopPresence).toHaveBeenCalledTimes(1);
    expect(resetSelfAccount).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cancelledNudges: 2 });
  });

  it('keeps going when one teardown step fails', async () => {
    const { onSignedOut } = await import('../../../../src/main/features/hub_account/session-lifecycle');
    const stopPresence = vi.fn();
    const resetSelfAccount = vi.fn();

    const result = await onSignedOut('u1', {
      cancelNudges: () => { throw new Error('nudge registry broken'); },
      stopPresence,
      resetSelfAccount,
    });

    // A failing step must not leave the other identity state alive.
    expect(result.cancelledNudges).toBe(0);
    expect(stopPresence).toHaveBeenCalledTimes(1);
    expect(resetSelfAccount).toHaveBeenCalledTimes(1);
  });

  it('starts the heartbeat for the new identity on sign-in', async () => {
    const { onSignedIn } = await import('../../../../src/main/features/hub_account/session-lifecycle');
    const startPresence = vi.fn();
    const stopPresence = vi.fn();

    await onSignedIn('u2', { startPresence, stopPresence });

    expect(startPresence).toHaveBeenCalledWith('u2');
  });

  it('does nothing without an identity', async () => {
    const { onSignedIn, onSignedOut } = await import('../../../../src/main/features/hub_account/session-lifecycle');
    const cancelNudges = vi.fn(() => 0);
    const stopPresence = vi.fn();
    const startPresence = vi.fn();

    await onSignedIn('', { startPresence });
    expect(startPresence).not.toHaveBeenCalled();

    await onSignedOut('', { cancelNudges, stopPresence });
    expect(cancelNudges).toHaveBeenCalledWith('');
    expect(stopPresence).toHaveBeenCalledTimes(1);
  });
});

describe('hub session lifecycle › nudge cancellation is per identity', () => {
  it('cancels only the signing-out identity\'s timers', async () => {
    const nudges = await import('../../../../src/main/features/a2a/reception-nudge');
    const cleared: unknown[] = [];
    const deps = {
      send: async () => ({ messageId: 'm1' }),
      setTimeoutFn: () => 7,
      clearTimeoutFn: (timer: unknown) => { cleared.push(timer); },
    };
    nudges.resetReceptionNudges();
    nudges.scheduleReceptionNudge('u1', 'a2a-0123456789abcdef0001', 'cs_a', deps);
    nudges.scheduleReceptionNudge('u1', 'a2a-0123456789abcdef0002', 'cs_a', deps);
    nudges.scheduleReceptionNudge('u2', 'a2a-0123456789abcdef0003', 'cs_b', deps);

    const cancelled = nudges.cancelReceptionNudgesForUser('u1', deps);

    // Both of u1's timers are released; u2's stays queued.
    expect(cancelled).toBe(2);
    expect(cleared).toHaveLength(2);
    expect(nudges.cancelReceptionNudgesForUser('u2', deps)).toBe(1);
    expect(nudges.cancelReceptionNudgesForUser('u1', deps)).toBe(0);
  });
});
