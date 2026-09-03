/**
 * Persistent CLI runtime — shared contracts.
 *
 * Goal: keep one long-lived "chat window" per external CLI agent so
 * consecutive turns reuse the same process/server instead of paying
 * the ~50 s cold-start on every dispatch. The runner/bus contracts
 * stay untouched: `wrapPersistentBackend` produces an ordinary
 * `LocalBackend` whose `run()` is called once per dispatch — under
 * the hood the turn is delivered to a reused window.
 *
 * Layering (see persistent/manager.ts for the lifecycle rules):
 *
 *   runner.ts ──run(opts)──▶ wrapPersistentBackend(cli, oneShot)
 *                                │  COGSEED_PERSISTENT=0 or adapter
 *                                │  unsupported → oneShot.run(opts)
 *                                ▼
 *                          PersistentRuntimeManager
 *                                │ reuse-by-session-id, idle reclaim,
 *                                │ crash recovery, exit cleanup
 *                                ▼
 *                          PersistentAdapter (one per CLI — the only
 *                          per-CLI code): how to open a window and
 *                          how to translate its native events into
 *                          `LocalEvent`s.
 *
 * An adapter writes exactly two things:
 *   1. `acquire` — how this CLI opens (or restores) a resident window;
 *   2. the event translation inside the window's `send` — it must
 *      produce the SAME `LocalEvent` stream the one-shot backend
 *      emits, so runner parsing and the renderer rail stay identical.
 */

import type { LocalEvent } from '../backends/base.js';
import type { LocalCliType } from '../registry.js';

/** Terminal outcome of one delivered turn. The manager turns this
 *  into the terminal `done` LocalEvent; adapters never emit `done`
 *  themselves (single-owner rule — the one-shot backends own their
 *  `done`, here the manager owns it). */
export interface PersistentTurnResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  /** Final assistant text, when the CLI surfaced one. */
  output?: string;
  error?: string;
  /** CLI-reported conversation id (claude session_id / opencode
   *  session id). The manager re-keys the window on it so the NEXT
   *  dispatch (whose resumeSessionId comes from the sessions.ts
   *  binding fed by done.sessionId) finds this window again. */
  sessionId?: string;
  usage?: Record<string, number | string>;
}

/** Per-turn delivery options — a projection of BackendRunOptions;
 *  fields the current persistent adapters can't act on (bridge,
 *  executionContext, …) stay on the one-shot path. */
export interface PersistentSendOpts {
  prompt: string;
  cwd: string;
  model?: string;
  customArgs?: string[];
  thinkingLevel?: 'off' | 'low' | 'high';
  signal: AbortSignal;
  onEvent: (e: LocalEvent) => void;
  /** Activity clock (ms epoch of last non-idle event) shared with
   *  the runner's idle heartbeat — adapters touch it through their
   *  emitted events; the manager reads it for the idle watchdog. */
  lastEventAt?: () => number;
  /** Extra env the CLI process needs (provider credentials etc.).
   *  Only applied when the window is (re)spawned, not on reuse —
   *  per-turn env changes require a restart in practice. */
  providerEnv?: Record<string, string>;
}

/** Why the current turn is being cancelled (manager watchdog or
 *  user abort). Maps onto the terminal `done` status. */
export type PersistentCancelReason = 'user' | 'timeout' | 'idle';

/** One resident conversation window. Implementation owns the
 *  underlying process/server + event translation; the manager owns
 *  bookkeeping (reuse keying, idle reclaim, exit cleanup) and the
 *  terminal `done` event. */
export interface PersistentWindow {
  readonly cli: LocalCliType;
  /** Last CLI-reported conversation id. Undefined until the first
   *  turn reports one. Used for reuse matching and crash recovery. */
  readonly sessionId: string | undefined;
  /** Milliseconds since epoch of the last completed turn. Managed
   *  by the implementation (it knows when a turn truly ends); the
   *  manager's sweeper reads it for idle reclaim. */
  readonly lastActiveAt: number;
  /** Whether the underlying process/server still exists. A window
   *  that died is never reused — the manager drops it and recovers
   *  through acquire(resumeSessionId). */
  alive(): boolean;
  /** Deliver one turn: emit process/translation events through
   *  `opts.onEvent`, resolve with the terminal result. Must resolve
   *  (never hang) once `cancelTurn` fires. Concurrent sends on the
   *  same window are serialized by the manager. */
  send(opts: PersistentSendOpts): Promise<PersistentTurnResult>;
  /** Best-effort interruption of the in-flight turn (user abort /
   *  watchdog). Implementations resolve the pending send with the
   *  matching cancelled/timeout status. Safe to call when no turn
   *  is in flight. */
  cancelTurn(reason: PersistentCancelReason): void;
  /** Tear the window down (kill process / release server session).
   *  Idempotent. */
  stop(): Promise<void>;
}

/** Arguments for opening a window. `resumeSessionId` present =
 *  restore a known conversation (crash recovery, or the CLI's own
 *  persistent store outliving our process); absent = fresh window. */
export interface PersistentAcquireOpts {
  binPath: string;
  cwd: string;
  /** Model for NEW windows — session-level in most CLIs (applied at
   *  creation; existing windows keep their creation-time model). */
  model?: string;
  resumeSessionId?: string;
  /** Custom-provider env — servers spawned per provider fingerprint
   *  so a switch to different credentials never reuses a process
   *  launched with the old ones. */
  providerEnv?: Record<string, string>;
  /** Window-lifetime event sink (process-info on spawn, lifecycle
   *  logs). Turn-time events flow through send's onEvent instead. */
  onEvent: (e: LocalEvent) => void;
}

/** Per-CLI adapter — the ONLY per-CLI code in the persistent
 *  framework. Registered in persistent/index.ts. */
export interface PersistentAdapter {
  readonly cli: LocalCliType;
  /** Probing/probing-missed CLIs or unverified channels declare
   *  false — the wrapper transparently runs the one-shot backend. */
  readonly supported: boolean;
  /** Open (or restore) a window. Called by the manager on cache
   *  miss only — must be safe to call concurrently for different
   *  keys (the manager serializes per key through in-flight
   *  promises). */
  acquire(opts: PersistentAcquireOpts): Promise<PersistentWindow>;
}

/** Sentinel: the window's process died mid-turn. Distinguishes
 *  "retry through acquire(resumeSessionId)" from ordinary turn
 *  failures (which surface as status:'failed' results, not
 *  throws). */
export class WindowDiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowDiedError';
  }
}
