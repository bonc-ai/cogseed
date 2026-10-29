import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerPromotedRun,
  settlePromotedRun,
  listPromotedRuns,
  getPromotedRun,
  killAllPromotedRuns,
  registerPromotedRunByPid,
  __resetPromotedRunsForTest,
} from '../../../../src/main/features/local_agents/background_run_registry';

function handle(runId: string, over: Partial<Parameters<typeof registerPromotedRun>[0]> = {}) {
  return {
    runId,
    uid: 'user-a',
    cli: 'claude',
    pid: 4242,
    stop: vi.fn(),
    ...over,
  };
}

/** Contract: a promoted run outlives its turn, so this registry is the only
 *  thing that can still stop it (quit / user stop) and the only guard against
 *  one run id owning two live children. */
describe('local_agents › promoted run registry', () => {
  beforeEach(() => {
    __resetPromotedRunsForTest();
  });

  it('registers, lists and settles a promoted run', () => {
    registerPromotedRun(handle('run-1'));
    expect(listPromotedRuns().map((h) => h.runId)).toEqual(['run-1']);
    expect(getPromotedRun('run-1')?.pid).toBe(4242);

    settlePromotedRun('run-1');
    expect(getPromotedRun('run-1')).toBeNull();
    // settling an unknown id is not an error
    expect(() => settlePromotedRun('nope')).not.toThrow();
  });

  it('stops every live run on killAll and forgets them', () => {
    const a = handle('run-a');
    const b = handle('run-b');
    registerPromotedRun(a);
    registerPromotedRun(b);

    expect(killAllPromotedRuns('app-quit')).toBe(2);
    expect(a.stop).toHaveBeenCalledWith('app-quit');
    expect(b.stop).toHaveBeenCalledWith('app-quit');
    expect(listPromotedRuns()).toEqual([]);
    // idempotent: nothing left to stop
    expect(killAllPromotedRuns('app-quit')).toBe(0);
  });

  it('never lets one run id own two live children', () => {
    const first = handle('run-dup');
    const second = handle('run-dup', { pid: 9999 });
    registerPromotedRun(first);
    registerPromotedRun(second);

    expect(first.stop).toHaveBeenCalledWith('replaced');
    expect(getPromotedRun('run-dup')?.pid).toBe(9999);
    expect(listPromotedRuns()).toHaveLength(1);
  });

  it('keeps going when one stop throws', () => {
    const bad = handle('run-bad', { stop: vi.fn(() => { throw new Error('kill failed'); }) });
    const good = handle('run-good');
    registerPromotedRun(bad);
    registerPromotedRun(good);

    expect(killAllPromotedRuns('user-stop')).toBe(2);
    expect(good.stop).toHaveBeenCalledWith('user-stop');
    expect(listPromotedRuns()).toEqual([]);
  });
});

/** A promoted run whose child belongs to ANOTHER process (the p3394 gateway):
 *  the registry cannot hold the child object, so `stop` must work by pid through
 *  the same process-tree killer. */
describe('local_agents › promoted run registry (pid-owned runs)', () => {
  afterEach(() => {
    __resetPromotedRunsForTest();
    vi.restoreAllMocks();
  });

  it('records the pid of a run it does not own', () => {
    registerPromotedRunByPid({ runId: 'gw-1', uid: 'user-a', cli: 'codex', pid: 4321 });
    const handle = getPromotedRun('gw-1');
    expect(handle?.pid).toBe(4321);
    expect(handle?.cli).toBe('codex');
  });

  it('stops a pid-owned run through the process-tree killer, and survives a dead pid', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    registerPromotedRunByPid({ runId: 'gw-2', uid: 'user-a', cli: 'claude', pid: 4322 });

    expect(killAllPromotedRuns('user-stop')).toBe(1);
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalled(), { timeout: 2_000 });
    expect(listPromotedRuns()).toEqual([]);

    // A pid that is already gone must not throw or wedge the sweep.
    killSpy.mockImplementation((() => { throw new Error('ESRCH'); }) as never);
    registerPromotedRunByPid({ runId: 'gw-3', uid: 'user-a', cli: 'claude', pid: 4323 });
    expect(() => killAllPromotedRuns('app-quit')).not.toThrow();
    expect(listPromotedRuns()).toEqual([]);
  });
});
