// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * Typed admission failures for continuing delegated Agent work.
 *
 * Group Chat projects every actor turn into a CogSeed task so Run Center can
 * show what happened. Those projection tasks deliberately share the task store,
 * schema and status vocabulary with runtime-owned tasks, but they are executed
 * by the Group Chat bus itself: their `waiting_user` status means "this run is
 * blocked on the human", not "a continuation may resume this task". Resuming
 * one from the CogSeed Runtime is a contract violation.
 *
 * Both sides used to rely on matching the human-readable message text. A typed
 * error keeps the contract stable across refactors and lets the Group Chat bus
 * fall back to its own executor instead of fabricating a failed turn.
 */

/** Runtime refused to execute a task owned by the Group Chat executor. */
export class CogSeedGroupChatTaskAdmissionError extends Error {
  readonly code = 'cogseed_group_chat_task_not_admissible';
  readonly taskId?: string;

  constructor(taskId?: string) {
    super('Group Chat tasks cannot run in CogSeed Runtime');
    this.name = 'CogSeedGroupChatTaskAdmissionError';
    if (taskId) this.taskId = taskId;
  }
}

/**
 * A follow-up was aimed at the interactive (runtime-backed) continuation path
 * even though the latest task for that Agent is owned by Group Chat. The
 * caller must dispatch the message through the Group Chat bus instead.
 */
export class CogSeedFollowupNotRuntimeOwnedError extends Error {
  readonly code = 'cogseed_followup_not_runtime_owned';
  readonly reason: 'group-chat-owned';
  readonly taskId?: string;

  constructor(reason: 'group-chat-owned', taskId?: string) {
    super(`CogSeed follow-up is not runtime-owned: ${reason}${taskId ? ` (${taskId})` : ''}`);
    this.name = 'CogSeedFollowupNotRuntimeOwnedError';
    this.reason = reason;
    if (taskId) this.taskId = taskId;
  }
}

/** Whether `value` is the "dispatch this through Group Chat instead" signal. */
export function isCogSeedFollowupNotRuntimeOwnedError(
  value: unknown,
): value is CogSeedFollowupNotRuntimeOwnedError {
  if (value instanceof CogSeedFollowupNotRuntimeOwnedError) return true;
  // Duck-typed fallback: renderer/main pools and tests may load a separate
  // module instance, where `instanceof` cannot see this class identity.
  return typeof value === 'object'
    && value !== null
    && (value as { code?: unknown }).code === 'cogseed_followup_not_runtime_owned';
}

/** Whether `value` is the Runtime-side Group-Chat admission refusal. */
export function isCogSeedGroupChatTaskAdmissionError(
  value: unknown,
): value is CogSeedGroupChatTaskAdmissionError {
  if (value instanceof CogSeedGroupChatTaskAdmissionError) return true;
  return typeof value === 'object'
    && value !== null
    && (value as { code?: unknown }).code === 'cogseed_group_chat_task_not_admissible';
}
