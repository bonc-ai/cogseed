import type { KstarTaskStatus, KstarReviewState } from './types';
import type { KstarRequirementStatus, KstarTaskPhase } from './requirement-types';

export type KstarLifecycleKind = 'task' | 'requirement' | 'episode' | 'review';
type LifecycleStatus = KstarTaskPhase | KstarRequirementStatus | KstarTaskStatus | KstarReviewState;

const TRANSITIONS: Record<KstarLifecycleKind, Readonly<Record<string, readonly string[]>>> = {
  task: {
    // Task aggregation may close a completed legacy/open task directly.
    // Keep this terminal shortcut compatible with persisted pre-state-machine records.
    open: ['closing', 'closed', 'abandoned'],
    closing: ['closing', 'closed', 'abandoned'],
    closed: ['closed'],
    abandoned: ['abandoned'],
  },
  requirement: {
    open: ['waiting_review', 'closed', 'abandoned'],
    waiting_review: ['waiting_review', 'closed', 'abandoned'],
    closed: ['closed'],
    abandoned: ['abandoned'],
  },
  episode: {
    waiting_input: ['waiting_input', 'completed', 'failed', 'cancelled', 'timed_out'],
    completed: ['completed'],
    failed: ['failed'],
    cancelled: ['cancelled'],
    timed_out: ['timed_out'],
  },
  review: {
    inferred: ['inferred', 'needs_confirmation', 'confirmed'],
    needs_confirmation: ['needs_confirmation', 'confirmed'],
    confirmed: ['confirmed'],
    unknown: ['unknown', 'inferred', 'needs_confirmation'],
  },
};

export class KstarInvalidTransitionError extends Error {
  readonly code = 'kstar_invalid_transition';

  constructor(
    readonly kind: KstarLifecycleKind,
    readonly from: string,
    readonly to: string,
  ) {
    super(`invalid KSTAR ${kind} transition: ${from} -> ${to}`);
    this.name = 'KstarInvalidTransitionError';
  }
}

/** Fail closed at every persisted lifecycle write. Same-state writes are
 * explicitly idempotent so replayed terminal events do not create a new path. */
export function assertKstarTransition(
  kind: KstarLifecycleKind,
  from: LifecycleStatus,
  to: LifecycleStatus,
): void {
  const allowed = TRANSITIONS[kind][from];
  if (!allowed?.includes(to)) throw new KstarInvalidTransitionError(kind, from, to);
}

export function canKstarTransition(
  kind: KstarLifecycleKind,
  from: LifecycleStatus,
  to: LifecycleStatus,
): boolean {
  try {
    assertKstarTransition(kind, from, to);
    return true;
  } catch {
    return false;
  }
}
