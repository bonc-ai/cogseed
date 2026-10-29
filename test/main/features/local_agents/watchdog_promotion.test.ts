import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { armKillWatchdog } from '../../../../src/main/features/local_agents/backends/base';

/** Contract: a deadline is a decision point. When the caller accepts it as a
 *  promotion the child must survive (`promoted()` true, no signal); every other
 *  answer keeps today's kill path. */
function fakeChild(pid = 0) {
  return Object.assign(new EventEmitter(), { pid, kill: vi.fn(() => true) }) as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('local_agents/backends/base › armKillWatchdog promotion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the child alive and reports promoted when onDeadline accepts the deadline', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const child = fakeChild(2468);
    const onDeadline = vi.fn(() => true);

    const watchdog = armKillWatchdog(child, {
      timeoutMs: 30,
      onDeadline,
    });

    await vi.waitFor(() => expect(watchdog.promoted()).toBe(true), { timeout: 2_000 });
    expect(watchdog.fired()).toBe('wall');
    expect(onDeadline).toHaveBeenCalledTimes(1);
    expect(onDeadline.mock.calls[0][0]).toBe('wall');
    // The whole point: no signal reaches the child, so its work survives.
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    watchdog.disarm();
    // and it must stay alive: the poll stopped, nothing fires later
    await sleep(60);
    expect(killSpy).not.toHaveBeenCalled();
  });

  // 杀进程路径是平台形状的：POSIX 走 `killProcessTree` 的进程组信号
  // `process.kill(-pid)`；win32 没有进程组，带 pid 的 child 会让 helper 去 spawn
  // 真的 `taskkill.exe /pid <pid> /t /f`——拿 fixture pid 去跑就可能打到本机无关的
  // 活进程。所以 win32 用无 pid 的 fake child，走 helper 明确的 direct child-handle
  // fallback（`child.kill`），这也是本用例要守的「拒绝截止点 → 仍然发起 kill」；
  // taskkill 分支本身由 base.test.ts 注入 spawnFn 覆盖。
  it('kills as before when onDeadline declines', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const posix = process.platform !== 'win32';
    const child = fakeChild(posix ? 2469 : 0);

    const watchdog = armKillWatchdog(child, {
      timeoutMs: 30,
      onDeadline: () => false,
    });

    await vi.waitFor(() => expect(posix ? killSpy : child.kill).toHaveBeenCalled(), { timeout: 2_000 });
    if (posix) expect(killSpy).toHaveBeenCalledWith(-2469, 'SIGTERM');
    else expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(watchdog.promoted()).toBe(false);
    expect(watchdog.fired()).toBe('wall');
    watchdog.disarm();
  });

  it('kills as before when no onDeadline is supplied', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const posix = process.platform !== 'win32';
    const child = fakeChild(posix ? 2470 : 0);

    const watchdog = armKillWatchdog(child, { timeoutMs: 30 });

    await vi.waitFor(() => expect(posix ? killSpy : child.kill).toHaveBeenCalled(), { timeout: 2_000 });
    if (posix) expect(killSpy).toHaveBeenCalledWith(-2470, 'SIGTERM');
    else expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(watchdog.promoted()).toBe(false);
    watchdog.disarm();
  });

  it('reports the idle deadline (not wall) when the idle cap fires first', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const child = fakeChild(2471);
    const onDeadline = vi.fn(() => true);

    const watchdog = armKillWatchdog(child, {
      timeoutMs: 60_000,
      idleKillMs: 40,
      lastEventAt: () => 0,          // never any activity → idle cap wins
      onDeadline,
    });

    await vi.waitFor(() => expect(watchdog.promoted()).toBe(true), { timeout: 2_000 });
    expect(watchdog.fired()).toBe('idle');
    expect(onDeadline.mock.calls[0][0]).toBe('idle');
    expect(String(onDeadline.mock.calls[0][1])).toMatch(/^\d+$/);
    watchdog.disarm();
  });
});
