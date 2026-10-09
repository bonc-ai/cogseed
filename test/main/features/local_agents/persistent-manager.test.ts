import { describe, it, expect, beforeEach } from 'vitest';
import type { BackendRunOptions, LocalBackend, LocalEvent } from '../../../../src/main/features/local_agents/backends/base.js';
import type { LocalCliType } from '../../../../src/main/features/local_agents/registry.js';
import {
  PersistentRuntimeManager,
  persistentEnabled,
  resolveIdleReclaimMs,
} from '../../../../src/main/features/local_agents/persistent/manager.js';
import {
  WindowDiedError,
  type PersistentAdapter,
  type PersistentCancelReason,
  type PersistentWindow,
  type PersistentSendOpts,
  type PersistentTurnResult,
} from '../../../../src/main/features/local_agents/persistent/types.js';

// ── fakes ────────────────────────────────────────────────────────────────

/** Global sid sequence so revived windows report fresh ids the same
 *  way real CLIs do (claude forks a new sid on --resume, opencode
 *  keeps its own; both diverge from the pre-crash value). */
let globalSidSeq = 0;

class FakeWindow implements PersistentWindow {
  readonly cli: LocalCliType = 'claude';
  sessionId: string | undefined;
  lastActiveAt = Date.now();
  private aliveFlag = true;
  stopped = false;
  readonly sendCalls: string[] = [];
  readonly cancelReasons: PersistentCancelReason[] = [];
  /** per-send behavior, consumed in order; last entry repeats. */
  script: Array<'ok' | 'die' | 'fail' | 'hang'> = ['ok'];
  /** concurrency probe: max simultaneous in-flight sends. */
  maxConcurrent = 0;
  private inFlight = 0;
  private hangResolvers: Array<(r: PersistentTurnResult) => void> = [];

  alive(): boolean { return this.aliveFlag; }

  async send(opts: PersistentSendOpts): Promise<PersistentTurnResult> {
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    const behavior = this.script[Math.min(this.sendCalls.length, this.script.length - 1)];
    this.sendCalls.push(opts.prompt);
    try {
      if (behavior === 'die') {
        this.aliveFlag = false;
        throw new WindowDiedError('process exited unexpectedly');
      }
      if (behavior === 'fail') {
        return { status: 'failed', error: 'turn failed' };
      }
      if (behavior === 'hang') {
        return new Promise<PersistentTurnResult>(resolve => { this.hangResolvers.push(resolve); });
      }
      globalSidSeq += 1;
      this.sessionId = `sid-${globalSidSeq}`;
      this.lastActiveAt = Date.now();
      opts.onEvent({ type: 'text-delta', text: 'hi' });
      return { status: 'completed', output: `ok:${opts.prompt}`, sessionId: this.sessionId, usage: { input: 1 } };
    } finally {
      this.inFlight -= 1;
    }
  }

  cancelTurn(reason: PersistentCancelReason): void {
    this.cancelReasons.push(reason);
    for (const resolve of this.hangResolvers.splice(0)) {
      resolve({ status: reason === 'user' ? 'cancelled' : 'timeout' });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.aliveFlag = false;
  }
}

class FakeAdapter implements PersistentAdapter {
  readonly cli: LocalCliType = 'claude';
  supported = true;
  acquireCalls = 0;
  /** resumeSessionId each acquire received, in order. */
  readonly acquireResumeArgs: Array<string | undefined> = [];
  readonly windows: FakeWindow[] = [];
  /** per-acquire script, consumed in order; last entry repeats. */
  acquireScript: Array<Array<'ok' | 'die' | 'fail' | 'hang'>> = [];

  async acquire(opts: { binPath: string; cwd: string; resumeSessionId?: string; onEvent: (e: LocalEvent) => void }): Promise<PersistentWindow> {
    this.acquireCalls += 1;
    this.acquireResumeArgs.push(opts.resumeSessionId);
    const w = new FakeWindow();
    w.script = this.acquireScript[Math.min(this.acquireCalls - 1, this.acquireScript.length - 1)] ?? ['ok'];
    if (opts.resumeSessionId) w.sessionId = opts.resumeSessionId;
    this.windows.push(w);
    opts.onEvent({ type: 'process-info', pid: 100 + this.acquireCalls, cwd: opts.cwd, cmd: opts.binPath, args: [] });
    return w;
  }
}

function makeFallback(runs: string[]): LocalBackend {
  return {
    async run(opts: BackendRunOptions): Promise<void> {
      runs.push(opts.prompt);
      opts.onEvent({ type: 'done', status: 'completed', output: `fallback:${opts.prompt}` });
    },
  };
}

function makeOpts(events: LocalEvent[], over: Partial<BackendRunOptions> = {}): BackendRunOptions {
  return {
    binPath: '/bin/claude',
    prompt: 'p1',
    cwd: '/w',
    signal: new AbortController().signal,
    onEvent: e => events.push(e),
    timeoutMs: 5_000,
    ...over,
  };
}

function doneEvents(events: LocalEvent[]): LocalEvent[] {
  return events.filter(e => e.type === 'done');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── env switches ─────────────────────────────────────────────────────────

describe('persistent env switches', () => {
  it('defaults to enabled; COGSEED_PERSISTENT=0 disables', () => {
    expect(persistentEnabled({})).toBe(true);
    expect(persistentEnabled({ COGSEED_PERSISTENT: '1' })).toBe(true);
    expect(persistentEnabled({ COGSEED_PERSISTENT: '0' })).toBe(false);
    expect(persistentEnabled({ COGSEED_PERSISTENT: ' 0 ' })).toBe(false);
  });

  it('idle reclaim defaults to 10min; env overrides; <=0 not forced', () => {
    expect(resolveIdleReclaimMs({})).toBe(10 * 60 * 1000);
    expect(resolveIdleReclaimMs({ COGSEED_PERSISTENT_IDLE_MS: '1234' })).toBe(1234);
    expect(resolveIdleReclaimMs({ COGSEED_PERSISTENT_IDLE_MS: 'abc' })).toBe(10 * 60 * 1000);
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────

describe('PersistentRuntimeManager lifecycle', () => {
  let events: LocalEvent[];
  let adapter: FakeAdapter;
  let fallbackRuns: string[];
  let fallback: LocalBackend;
  let mgr: PersistentRuntimeManager;

  beforeEach(() => {
    globalSidSeq = 0;
    events = [];
    adapter = new FakeAdapter();
    fallbackRuns = [];
    fallback = makeFallback(fallbackRuns);
    mgr = new PersistentRuntimeManager({}, 10);
  });

  it('lazily starts: nothing acquired until the first dispatch', async () => {
    expect(mgr.size).toBe(0);
    expect(adapter.acquireCalls).toBe(0);
  });

  it('reuses the live window across turns with the same resumeSessionId', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);
    expect(adapter.acquireCalls).toBe(1);
    const firstDone = doneEvents(events)[0] as any;
    expect(firstDone.status).toBe('completed');
    expect(firstDone.sessionId).toBe('sid-1');

    events.length = 0;
    await mgr.run(makeOpts(events, { resumeSessionId: 'sid-1', prompt: 'p2' }), adapter, fallback);
    expect(adapter.acquireCalls).toBe(1);                 // no second spawn
    expect(adapter.windows[0].sendCalls).toEqual(['p1', 'p2']);
    const reusedLog = events.find(e => e.type === 'log' && String((e as any).message).includes('reused'));
    expect(reusedLog).toBeTruthy();                        // reuse is log-provable
    expect(doneEvents(events)).toHaveLength(1);
    expect(fallbackRuns).toEqual([]);
  });

  it('opens a fresh window for a first turn (no resumeSessionId) even when one is live', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);                    // agent A first turn
    await mgr.run(makeOpts(events, { prompt: 'pB' }), adapter, fallback);  // agent B first turn
    expect(adapter.acquireCalls).toBe(2);
    expect(adapter.windows).toHaveLength(2);
    expect(adapter.windows[0].sendCalls).toEqual(['p1']);
    expect(adapter.windows[1].sendCalls).toEqual(['pB']);
  });

  it('re-keys the window onto the CLI-reported session id', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);
    expect(mgr._keysForTest()).toContain('claude::/w::sid-1');
    expect(mgr._keysForTest().some(k => k.includes('@fresh'))).toBe(false);
  });

  it('emits exactly one terminal done per dispatch with sessionId/usage', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);
    const dones = doneEvents(events);
    expect(dones).toHaveLength(1);
    expect((dones[0] as any).sessionId).toBe('sid-1');
    expect((dones[0] as any).usage).toEqual({ input: 1 });
    expect((dones[0] as any).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('forwards turn status failures through done without recovery', async () => {
    adapter.acquireScript = [['fail']];
    await mgr.run(makeOpts(events), adapter, fallback);
    const done = doneEvents(events)[0] as any;
    expect(done.status).toBe('failed');
    expect(done.error).toBe('turn failed');
    expect(fallbackRuns).toEqual([]);   // ordinary failures are NOT fallback-worthy
  });

  it('recovers a dead window by re-acquiring once, then falls back if that fails', async () => {
    // Both the first and the revived window die mid-turn → fallback runs the turn.
    adapter.acquireScript = [['die'], ['die']];
    await mgr.run(makeOpts(events), adapter, fallback);
    expect(adapter.acquireCalls).toBe(2);
    expect(fallbackRuns).toEqual(['p1']);
    expect(mgr.size).toBe(0);
  });

  it('recovers a dead window successfully on the retry', async () => {
    adapter.acquireScript = [['die'], ['ok']];
    await mgr.run(makeOpts(events), adapter, fallback);
    expect(adapter.acquireCalls).toBe(2);
    expect(fallbackRuns).toEqual([]);
    const done = doneEvents(events)[0] as any;
    expect(done.status).toBe('completed');
    expect(done.sessionId).toBe('sid-1');   // revived window reports fresh sid; manager re-keys
  });

  it('restores from the last known session id when reviving', async () => {
    // First turn OK (sid-1). Second turn the reused window dies — revival
    // must pass resumeSessionId=sid-1 into acquire.
    adapter.acquireScript = [['ok'], ['ok']];
    await mgr.run(makeOpts(events), adapter, fallback);
    adapter.windows[0].script = ['ok', 'die'];   // reused window dies on turn 2
    await mgr.run(makeOpts(events, { resumeSessionId: 'sid-1', prompt: 'p2' }), adapter, fallback);
    expect(adapter.acquireCalls).toBe(2);
    // the recovery acquire got the resume handle
    expect(adapter.acquireResumeArgs[1]).toBe('sid-1');
    const done = doneEvents(events)[1] as any;
    expect(done.status).toBe('completed');
    expect(done.sessionId).toBe('sid-2');
  });

  it('serializes concurrent sends on the same window', async () => {
    adapter.acquireScript = [['ok']];
    await mgr.run(makeOpts(events), adapter, fallback);  // establishes sid-1
    await Promise.all([
      mgr.run(makeOpts(events, { resumeSessionId: 'sid-1', prompt: 'a' }), adapter, fallback),
      mgr.run(makeOpts(events, { resumeSessionId: 'sid-1', prompt: 'b' }), adapter, fallback),
    ]);
    expect(adapter.acquireCalls).toBe(1);
    expect(adapter.windows[0].maxConcurrent).toBe(1);
    expect(adapter.windows[0].sendCalls.slice(1).sort()).toEqual(['a', 'b']);
  });

  it('idle-reclaims idle windows but never a busy one', async () => {
    const m = new PersistentRuntimeManager({ COGSEED_PERSISTENT_IDLE_MS: '30' }, 5);
    await m.run(makeOpts(events), adapter, fallback);
    const win = adapter.windows[0];
    expect(win.stopped).toBe(false);
    await sleep(80);
    expect(win.stopped).toBe(true);
    expect(m.size).toBe(0);

    // Busy windows are exempt: a hanging turn keeps the window alive.
    events.length = 0;
    adapter.acquireScript = [['ok'], ['hang']];
    const hanging = m.run(
      makeOpts(events, { resumeSessionId: 'sid-1', prompt: 'p2', timeoutMs: 60_000 }),
      adapter, fallback,
    );
    await sleep(80);
    expect(m.size).toBe(1);          // still there — in-flight turn
    adapter.windows[1].cancelTurn('user');
    await hanging;
    await sleep(80);
    expect(m.size).toBe(0);          // reclaimed after the turn ended
    m.shutdownAll();
  });

  it('wall-clock watchdog cancels the turn with status timeout', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);
    adapter.windows[0].script = ['ok', 'hang'];   // reused window hangs on turn 2
    events.length = 0;
    await mgr.run(
      makeOpts(events, { resumeSessionId: 'sid-1', prompt: 'p2', timeoutMs: 60 }),
      adapter, fallback,
    );
    const done = doneEvents(events)[0] as any;
    expect(done.status).toBe('timeout');
    expect(adapter.windows[0].cancelReasons).toContain('timeout');
  });

  it('user abort cancels the turn with status cancelled', async () => {
    const ac = new AbortController();
    adapter.acquireScript = [['hang']];
    const p = mgr.run(makeOpts(events, { signal: ac.signal, timeoutMs: 60_000 }), adapter, fallback);
    await sleep(20);
    ac.abort();
    await p;
    const done = doneEvents(events)[0] as any;
    expect(done.status).toBe('cancelled');
    expect(adapter.windows[0].cancelReasons).toContain('user');
  });

  it('idle watchdog cancels a silent turn', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);
    adapter.windows[0].script = ['ok', 'hang'];   // reused window goes silent on turn 2
    events.length = 0;
    const lastEventAt = Date.now();
    await mgr.run(
      makeOpts(events, {
        resumeSessionId: 'sid-1', prompt: 'p2', timeoutMs: 60_000,
        idleKillMs: 50, lastEventAt: () => lastEventAt,
      }),
      adapter, fallback,
    );
    const done = doneEvents(events)[0] as any;
    expect(done.status).toBe('timeout');
    expect(adapter.windows[0].cancelReasons).toContain('idle');
  });

  it('drops a dead window instead of reusing it', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);
    const win = adapter.windows[0];
    (win as any).stopped = false;
    // simulate process death between turns
    await win.stop();
    events.length = 0;
    await mgr.run(makeOpts(events, { resumeSessionId: 'sid-1', prompt: 'p2' }), adapter, fallback);
    expect(adapter.acquireCalls).toBe(2);  // dead hit dropped, fresh acquire
  });

  it('COGSEED_PERSISTENT=0 routes everything to the one-shot backend', async () => {
    const m = new PersistentRuntimeManager({ COGSEED_PERSISTENT: '0' }, 10);
    await m.run(makeOpts(events), adapter, fallback);
    expect(adapter.acquireCalls).toBe(0);
    expect(fallbackRuns).toEqual(['p1']);
  });

  it('an unsupported adapter runs the one-shot backend', async () => {
    adapter.supported = false;
    await mgr.run(makeOpts(events), adapter, fallback);
    expect(adapter.acquireCalls).toBe(0);
    expect(fallbackRuns).toEqual(['p1']);
  });

  it('shutdownAll stops every window and disables the manager', async () => {
    await mgr.run(makeOpts(events), adapter, fallback);
    expect(mgr.size).toBe(1);
    mgr.shutdownAll();
    expect(adapter.windows[0].stopped).toBe(true);
    expect(mgr.size).toBe(0);
    // Post-shutdown dispatches go straight to the fallback.
    await mgr.run(makeOpts(events, { resumeSessionId: 'sid-1' }), adapter, fallback);
    expect(adapter.acquireCalls).toBe(1);
    expect(fallbackRuns).toEqual(['p1']);
  });
});
