/**
 * Task status buckets shared by every read path that has to answer "is this
 * task executing?".
 *
 * Three buckets, deliberately:
 *   - active:     a run/worker currently owns the task.
 *   - attention:  the task cannot proceed without the human (waiting for input,
 *                 recoverable after a worker restart, failed).
 *   - terminal:   finished.
 *
 * `waiting_user` used to sit in the active bucket. A task whose turn had already
 * ended therefore kept the sidebar badge claiming "1 在执行" (2026-10-12: turn
 * finished 17:17:23 with turn_end=1, task stayed waiting_user, badge kept saying
 * executing). "Waiting for the user" is not "running", and `recoverable` — which
 * is neither active nor terminal — must be reported as needing attention rather
 * than as progress.
 *
 * Keep this list in sync with `CogSeedTaskStatus`; the contract test pins that
 * every status lands in at least one bucket and that active ∩ terminal = ∅.
 */
import type { CogSeedTaskStatus } from './types';

export const COGSEED_ACTIVE_TASK_STATUSES: readonly CogSeedTaskStatus[] = ['created', 'queued', 'running'];
export const COGSEED_ATTENTION_TASK_STATUSES: readonly CogSeedTaskStatus[] = [
  'planned',
  'waiting_user',
  'recoverable',
  'failed',
];
export const COGSEED_TERMINAL_TASK_STATUSES: readonly CogSeedTaskStatus[] = ['completed', 'failed', 'cancelled'];
