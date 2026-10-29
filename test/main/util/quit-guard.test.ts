import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  QUIT_PHASE_TIMEOUT_MS,
  QUIT_WATCHDOG_MS,
  createQuitWatchdog,
  installQuitSignalHandlers,
  withDeadline,
} from '../../../src/main/util/quit-guard';

const makeLog = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('withDeadline', () => {
  it('returns the work value and records the elapsed time', async () => {
    const log = makeLog();
    await expect(withDeadline('flush', 50, async () => 'ok', log)).resolves.toBe('ok');
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('quit phase finished', expect.objectContaining({ label: 'flush' }));
  });

  it('swallows a rejecting phase instead of aborting the quit', async () => {
    const log = makeLog();
    await expect(
      withDeadline('flush', 50, async () => { throw new Error('disk full'); }, log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'quit phase failed',
      expect.objectContaining({ label: 'flush', timedOut: false, error: 'disk full' }),
    );
  });

  it('gives up on a phase that never settles and keeps going', async () => {
    const log = makeLog();
    const started = Date.now();
    await expect(
      withDeadline('bridge', 20, () => new Promise<void>(() => {}), log),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(log.warn).toHaveBeenCalledWith(
      'quit phase failed',
      expect.objectContaining({ label: 'bridge', timedOut: true }),
    );
  });
});

describe('createQuitWatchdog', () => {
  it('forces the exit once the grace period elapses', () => {
    const log = makeLog();
    const forceExit = vi.fn();
    const scheduled: Array<() => void> = [];
    const watchdog = createQuitWatchdog({
      cancel: () => {},
      forceExit,
      log,
      ms: 123,
      schedule: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    watchdog.arm();
    watchdog.arm(); // 幂等：重复 arm 不重复排程
    expect(scheduled).toHaveLength(1);
    expect(forceExit).not.toHaveBeenCalled();

    scheduled[0]();
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(watchdog.fired()).toBe(true);
    expect(log.error).toHaveBeenCalledWith('quit watchdog fired; forcing exit', { ms: 123 });
  });

  it('does nothing after clear', () => {
    const forceExit = vi.fn();
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const watchdog = createQuitWatchdog({
      cancel: (timer) => { timers.delete(timer as unknown as number); },
      forceExit,
      log: makeLog(),
      ms: 10,
      schedule: (callback) => {
        const id = nextId++;
        timers.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
    });

    watchdog.arm();
    watchdog.clear();
    expect(timers.size).toBe(0);
    expect(forceExit).not.toHaveBeenCalled();
  });
});

describe('installQuitSignalHandlers', () => {
  it('turns the first signal into one quit request and logs later ones', () => {
    const log = makeLog();
    const onSignal = vi.fn();
    const fakeProcess = new EventEmitter();
    const uninstall = installQuitSignalHandlers({
      log,
      onSignal,
      processLike: fakeProcess as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      signals: ['SIGTERM', 'SIGINT'],
    });

    fakeProcess.emit('SIGTERM');
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith('SIGTERM');
    expect(log.info).toHaveBeenCalledWith('termination signal received', { signal: 'SIGTERM' });

    fakeProcess.emit('SIGINT');
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('termination signal received while quitting', { signal: 'SIGINT' });

    expect(fakeProcess.listenerCount('SIGTERM')).toBe(1);
    uninstall();
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(0);
    expect(fakeProcess.listenerCount('SIGINT')).toBe(0);
  });

  it('ignores a second installation on the same process object', () => {
    const fakeProcess = new EventEmitter();
    const first = vi.fn();
    const second = vi.fn();
    installQuitSignalHandlers({
      log: makeLog(),
      onSignal: first,
      processLike: fakeProcess as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      signals: ['SIGTERM'],
    });
    installQuitSignalHandlers({
      log: makeLog(),
      onSignal: second,
      processLike: fakeProcess as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      signals: ['SIGTERM'],
    });

    fakeProcess.emit('SIGTERM');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('quit budgets', () => {
  it('keeps the serial phase budgets under the hard watchdog', () => {
    // 三个阶段串行：索引 flush → (桥 || 网关)。并行的那两段只按一段算。
    expect(QUIT_PHASE_TIMEOUT_MS * 2).toBeLessThan(QUIT_WATCHDOG_MS);
    // restart-cogseed.sh 等 10 s 后强杀；watchdog 必须留出余量。
    expect(QUIT_WATCHDOG_MS).toBeLessThan(10_000);
  });
});
