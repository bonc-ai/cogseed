/**
 * PersistentRuntimeManager — the shared lifecycle brain.
 *
 * Responsibilities (everything EXCEPT the per-CLI wiring, which
 * lives in adapters):
 *
 *   - lazy start: a window is only acquired on the first dispatch
 *     that needs it; nothing pre-spawns.
 *   - reuse: a dispatch with resumeSessionId R reuses the live
 *     window whose sessionId === R. A first turn (no resumeSessionId)
 *     ALWAYS opens a fresh window — two different agents in one
 *     conversation both dispatch without a binding on their first
 *     turn, and reusing one agent's window there would cross-wire
 *     their contexts. The cost is one extra short-lived window when
 *     an idle one could have been reused; correctness wins.
 *   - idle reclaim: a sweeper stops windows whose last turn ended
 *     more than COGSEED_PERSISTENT_IDLE_MS ago (default 10 min).
 *   - crash recovery: a window that dies mid-turn is dropped, the
 *     turn is retried ONCE on a freshly acquired window restored
 *     from the last known session id (resume demoted to a recovery
 *     mechanism); if that also fails the turn falls back to the
 *     one-shot backend so the dispatch still completes.
 *   - exit cleanup: shutdownAll() on process exit signals.
 *
 * Turn semantics: the manager owns the terminal `done` event and the
 * turn watchdogs (wall-clock + idle, mirroring armKillWatchdog),
 * adapters own translation events and must resolve send() once
 * cancelTurn() fires.
 */

import { createLogger } from '../../../logger.js';
import { logErrorRef, logErrorSummary } from '../../../util/log-redact.js';
import type { LocalBackend, BackendRunOptions } from '../backends/base.js';
import type {
  PersistentAdapter,
  PersistentWindow,
  PersistentSendOpts,
  PersistentTurnResult,
  PersistentCancelReason,
} from './types.js';

const log = createLogger('local-agents:persistent');

/** Master switch. Default ON; COGSEED_PERSISTENT=0 runs every CLI
 *  through the existing one-shot path (byte-for-byte behavior). */
export function persistentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.COGSEED_PERSISTENT ?? '1').trim() !== '0';
}

/** Idle reclaim window (ms). 0/negative disables reclaim. */
export function resolveIdleReclaimMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COGSEED_PERSISTENT_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

/** Sweeper cadence — coarse; only wakes to check timestamps. */
const SWEEP_INTERVAL_MS = 30 * 1000;
/** How long the watchdog keeps waiting for send() to resolve after
 *  cancelTurn before treating the window as dead. Adapters contract
 *  to resolve promptly; this is zombie insurance. */
const CANCEL_GRACE_MS = 15_000;

function windowKey(cli: string, cwd: string, sessionId: string): string {
  return `${cli}::${cwd}::${sessionId}`;
}

export class PersistentRuntimeManager {
  private readonly windows = new Map<string, PersistentWindow>();
  /** Per-key acquire dedup — concurrent dispatches for the same key
   *  (e.g. two turns racing on a cold cwd) must not double-spawn. */
  private readonly inflight = new Map<string, Promise<PersistentWindow>>();
  /** Windows with an in-flight turn — exempt from idle reclaim. */
  private readonly busy = new Set<PersistentWindow>();
  private freshSeq = 0;
  private sweeper: NodeJS.Timeout | null = null;
  private shutDown = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly sweepIntervalMs = SWEEP_INTERVAL_MS,
  ) {}

  /** Live window count — test/diagnostics hook. */
  get size(): number {
    return this.windows.size;
  }

  /** Entry point used by the backend wrapper. */
  async run(opts: BackendRunOptions, adapter: PersistentAdapter, fallback: LocalBackend): Promise<void> {
    if (!persistentEnabled(this.env) || !adapter.supported || this.shutDown) {
      return fallback.run(opts);
    }
    const startedAt = Date.now();
    const sid = opts.resumeSessionId;
    const key = sid
      ? windowKey(adapter.cli, opts.cwd, sid)
      : windowKey(adapter.cli, opts.cwd, `@fresh-${++this.freshSeq}`);

    // Reuse: only an ALIVE window whose sessionId matches the
    // binding qualifies. Stale/dead hits are dropped eagerly.
    const cached = sid ? this.windows.get(key) : undefined;
    if (cached) {
      if (cached.alive() && cached.sessionId === sid) {
        opts.onEvent({
          type: 'log',
          level: 'debug',
          message: `persistent window reused (cli=${adapter.cli})`,
          source: 'persistent',
        });
        return this.deliverTurn(cached, key, opts, adapter, fallback, startedAt);
      }
      this.windows.delete(key);
    }

    const win = await this.acquireWindow(key, adapter, opts);
    return this.deliverTurn(win, key, opts, adapter, fallback, startedAt);
  }

  /** Acquire with per-key dedup; on failure the placeholder is
   *  removed so a later dispatch can retry. */
  private async acquireWindow(
    key: string,
    adapter: PersistentAdapter,
    opts: BackendRunOptions,
  ): Promise<PersistentWindow> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = adapter
      .acquire({
        binPath: opts.binPath,
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
        ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
        ...(opts.providerEnv ? { providerEnv: opts.providerEnv } : {}),
        onEvent: opts.onEvent,
      })
      .then(win => {
        this.windows.set(key, win);
        this.armSweeper();
        return win;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  /** Deliver one turn with watchdogs, serialization, and crash
   *  recovery. Always resolves after emitting exactly one terminal
   *  `done` — or after the fallback backend emitted its own. */
  private async deliverTurn(
    win: PersistentWindow,
    key: string,
    opts: BackendRunOptions,
    adapter: PersistentAdapter,
    fallback: LocalBackend,
    startedAt: number,
  ): Promise<void> {
    this.busy.add(win);
    try {
      let result: PersistentTurnResult;
      try {
        result = await this.sendWithWatchdogs(win, opts);
      } catch (err) {
        // Window died (or acquire-send failed hard). Drop it and try
        // ONE recovery pass: re-acquire restored from the last known
        // session id, re-deliver the same prompt. Re-executing a
        // partially-run turn may repeat tool side effects — the same
        // tradeoff the one-shot resume path already makes.
        const deadSid = win.sessionId ?? opts.resumeSessionId;
        log.warn('persistent window died mid-turn — recovering', {
          cli: adapter.cli,
          error: logErrorSummary(err),
          ...(deadSid ? { resume: true } : {}),
        });
        this.dropWindow(key, win);
        const recoveryKey = deadSid ? windowKey(adapter.cli, opts.cwd, deadSid) : key;
        let revived: PersistentWindow | null = null;
        try {
          revived = await this.acquireWindow(
            recoveryKey,
            adapter,
            { ...opts, ...(deadSid ? { resumeSessionId: deadSid } : {}) },
          );
          result = await this.sendWithWatchdogs(revived, opts);
          this.rekey(adapter.cli, opts.cwd, revived, result, recoveryKey);
        } catch (retryErr) {
          // Recovery failed — drop the unusable revived window so no
          // zombie entry lingers, then run the turn through the
          // one-shot backend (which emits its own done) so the
          // dispatch still completes.
          log.warn('persistent recovery failed — falling back to one-shot', {
            cli: adapter.cli,
            error: logErrorSummary(retryErr),
          });
          if (revived) this.dropWindow(recoveryKey, revived);
          await fallback.run(opts);
          return;
        }
      }
      this.rekey(adapter.cli, opts.cwd, win, result, key);
      opts.onEvent({
        type: 'done',
        status: result.status,
        durationMs: Date.now() - startedAt,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      });
    } finally {
      this.busy.delete(win);
    }
  }

  /** Serialize sends per window (a resident process handles one
   *  turn at a time) and arm the turn watchdogs. */
  private sendQueue = new WeakMap<PersistentWindow, Promise<unknown>>();

  private sendWithWatchdogs(win: PersistentWindow, opts: BackendRunOptions): Promise<PersistentTurnResult> {
    const prev = this.sendQueue.get(win) ?? Promise.resolve();
    const task = prev.catch(() => undefined).then(() => this.sendTurn(win, opts));
    this.sendQueue.set(win, task);
    return task;
  }

  private async sendTurn(win: PersistentWindow, opts: BackendRunOptions): Promise<PersistentTurnResult> {
    const sendOpts: PersistentSendOpts = {
      prompt: opts.prompt,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.customArgs && opts.customArgs.length ? { customArgs: opts.customArgs } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
      signal: opts.signal,
      onEvent: opts.onEvent,
      ...(opts.lastEventAt ? { lastEventAt: opts.lastEventAt } : {}),
      ...(opts.providerEnv ? { providerEnv: opts.providerEnv } : {}),
    };

    // Watchdogs mirror armKillWatchdog's two limits, but instead of
    // killing we ask the window to cancel the turn; adapters map the
    // reason onto the terminal result status. The grace timer is
    // zombie insurance for adapters that never resolve.
    const minLimit = opts.idleKillMs && opts.idleKillMs > 0 && opts.lastEventAt
      ? Math.min(opts.timeoutMs, opts.idleKillMs)
      : opts.timeoutMs;
    const tickMs = Math.max(25, Math.min(5_000, Math.floor(minLimit / 4)));
    const startedAt = Date.now();
    let fired: 'wall' | 'idle' | null = null;
    let firedIdleMs = 0;
    let graceTimer: NodeJS.Timeout | null = null;

    const p = win.send(sendOpts);
    const reasonOf = (): PersistentCancelReason =>
      fired === 'wall' ? 'timeout' : fired === 'idle' ? 'idle' : 'user';
    const ticker = setInterval(() => {
      const now = Date.now();
      if (now - startedAt >= opts.timeoutMs) fired = 'wall';
      else if (opts.idleKillMs && opts.idleKillMs > 0 && opts.lastEventAt) {
        const idleFor = now - opts.lastEventAt();
        if (idleFor >= opts.idleKillMs) { fired = 'idle'; firedIdleMs = idleFor; }
      }
      if (fired) {
        clearInterval(ticker);
        win.cancelTurn(reasonOf());
        // Adapter contract: resolve promptly after cancelTurn. If it
        // doesn't, reject so the recovery path takes over.
        graceTimer = setTimeout(() => {
          const err = new Error(
            fired === 'idle'
              ? `persistent window unresponsive after idle cancel (idle ${firedIdleMs}ms)`
              : 'persistent window unresponsive after wall-clock cancel',
          );
          (p as Promise<PersistentTurnResult>).catch(() => undefined);
          rejectPending(err);
        }, CANCEL_GRACE_MS);
        if (typeof graceTimer.unref === 'function') graceTimer.unref();
      }
    }, tickMs);
    if (typeof ticker.unref === 'function') ticker.unref();

    let rejectPending: (e: Error) => void = () => undefined;
    const guarded = new Promise<PersistentTurnResult>((resolve, reject) => {
      rejectPending = reject;
      p.then(resolve, reject);
    });

    const onAbort = () => {
      fired = null; // user abort outranks watchdog reasons
      win.cancelTurn('user');
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await guarded;
    } finally {
      clearInterval(ticker);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Move the window's map entry to the CLI-reported session id so
   *  the next dispatch (resumeSessionId from the sessions.ts
   *  binding) finds it. First turns start on a @fresh- key and get
   *  re-keyed here. */
  private rekey(
    cli: string,
    cwd: string,
    win: PersistentWindow,
    result: PersistentTurnResult,
    oldKey: string,
  ): void {
    if (!result.sessionId) return;
    const nextKey = windowKey(cli, cwd, result.sessionId);
    if (nextKey === oldKey) return;
    if (this.windows.get(oldKey) === win) this.windows.delete(oldKey);
    this.windows.set(nextKey, win);
  }

  private dropWindow(key: string, win: PersistentWindow): void {
    if (this.windows.get(key) === win) this.windows.delete(key);
    for (const [k, w] of this.windows) {
      if (w === win) this.windows.delete(k);
    }
    void win.stop().catch(() => undefined);
  }

  private armSweeper(): void {
    if (this.sweeper || this.shutDown) return;
    const idleMs = resolveIdleReclaimMs(this.env);
    if (idleMs <= 0) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, win] of this.windows) {
        if (this.busy.has(win)) continue;
        if (now - win.lastActiveAt >= idleMs || !win.alive()) {
          if (!win.alive()) {
            this.windows.delete(key);
            continue;
          }
          log.info('persistent window idle-reclaimed', { cli: win.cli });
          this.windows.delete(key);
          void win.stop().catch(() => undefined);
        }
      }
      if (this.windows.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, this.sweepIntervalMs);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  /** Stop every window and disable the manager. Used on app exit
   *  and by tests. */
  shutdownAll(): void {
    this.shutDown = true;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const win of this.windows.values()) {
      void win.stop().catch(err => {
        log.warn('persistent window stop failed', { cli: win.cli, error: logErrorRef(err) });
      });
    }
    this.windows.clear();
  }

  /** Test hook — inspect the live key set. */
  _keysForTest(): string[] {
    return [...this.windows.keys()];
  }
}

/** Process-wide singleton. Registered lazily so importing the
 *  module never installs exit handlers in isolation (tests construct
 *  their own instances instead). */
let defaultManager: PersistentRuntimeManager | null = null;

export function getPersistentRuntimeManager(): PersistentRuntimeManager {
  if (!defaultManager) {
    defaultManager = new PersistentRuntimeManager();
    const hooks: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    const cleanup = () => defaultManager?.shutdownAll();
    process.once('exit', cleanup);
    for (const sig of hooks) {
      process.once(sig, () => {
        cleanup();
        // Re-raise the default behavior after our stop pass so the
        // process still terminates normally.
        process.kill(process.pid, sig);
      });
    }
  }
  return defaultManager;
}
