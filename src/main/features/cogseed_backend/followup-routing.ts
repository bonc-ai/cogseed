// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * Decide whether a user message addressed to exactly one formal Agent should
 * continue that Agent through the CogSeed Runtime ("interactive backend"
 * follow-up) or go through the Group Chat executor.
 *
 * Owner principle (matching the run-wide interruption model used by agent
 * runtimes elsewhere): whoever executed the turn that is being continued must
 * be the one that continues it. A Group Chat projection task is produced by
 * the Group Chat bus, so its `waiting_user` status is display state, not a
 * resumable runtime pause.
 *
 * The regression this encodes: the follow-up branch used to consult only
 * "does a prior task exist?", so every formal Agent that had spoken in a
 * conversation was routed into the Runtime. After the Agent emitted an input
 * form, its projection task was `waiting_user`, and the Runtime refused to
 * resume a Group Chat task -> a generic failure bubble and a lost answer.
 */

export interface CogSeedFollowupRoutingInput {
  /** A task exists for this Agent in this conversation. */
  hasPriorTask: boolean;
  /** The latest such task is owned by the CogSeed Runtime (not Group Chat). */
  priorIsRuntimeOwned: boolean;
  /** The Agent currently holds the conversation floor (no explicit mention). */
  implicitFloor: boolean;
}

/**
 * @returns true only when the Runtime can own the continuation.
 */
export function shouldUseRuntimeFollowup(input: CogSeedFollowupRoutingInput): boolean {
  if (input.hasPriorTask) return input.priorIsRuntimeOwned;
  // First follow-up for an implicit-floor Agent that has no task yet keeps the
  // legacy Runtime path (e.g. a purged CLI/gateway task). The first contact of
  // an Agent still passes the wake gate before this point.
  return input.implicitFloor;
}
