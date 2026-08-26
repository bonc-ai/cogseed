import { nowIso } from '../../storage';
import { appendCogSeedTaskEvent } from './event-store';
import { assertCogSeedTaskId, assertCogSeedUserId } from './paths';
import { createCogSeedTask, readCogSeedTask, updateCogSeedTask } from './task-store';
import type { CogSeedTaskRecord, CogSeedTaskStatus } from './types';

const TRANSITIONS: Readonly<Record<CogSeedTaskStatus, readonly CogSeedTaskStatus[]>> = {
  // `created`/`queued` → `failed` exists because a task can die before it ever
  // runs: the process hosting it disappears. Startup reconciliation (RC-P0-04)
  // is the concrete case — a Group Chat run interrupted by an app restart is
  // dead whether or not it had reached `running`, and the only honest terminal
  // state for it is `failed`. Without these edges `transitionCogSeedTask` throws
  // and such tasks stay non-terminal forever.
  created: ['queued', 'cancelled', 'recoverable', 'failed'],
  queued: ['running', 'cancelled', 'recoverable', 'failed'],
  running: ['waiting_user', 'completed', 'failed', 'cancelled', 'recoverable'],
  // Intentionally NOT extended to `failed`: `waiting_user` means "waiting on a
  // human", which survives a restart — the conversation is still there and the
  // user can still answer. Treating it as a crash would destroy real state.
  waiting_user: ['queued', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
  // `recoverable` → `failed` closes the loop for a task we have since decided
  // cannot actually be recovered. Group Chat offers no run resume, so a
  // `recoverable` group-chat task is a promise nothing can keep (RC-P0-05).
  recoverable: ['queued', 'failed'],
};

function eventType(status: CogSeedTaskStatus): 'task.queued' | 'task.started' | 'task.waiting_user' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.recoverable' {
  if (status === 'queued') return 'task.queued';
  if (status === 'running') return 'task.started';
  if (status === 'waiting_user') return 'task.waiting_user';
  if (status === 'completed') return 'task.completed';
  if (status === 'cancelled') return 'task.cancelled';
  if (status === 'recoverable') return 'task.recoverable';
  return 'task.failed';
}

function isTerminal(status: CogSeedTaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * Statuses that mean "execution was in flight" — the ones an app restart
 * definitively kills.
 *
 * Derived from the transition table rather than written out by hand, so it
 * cannot drift if a status is added: a status belongs here when it is not
 * terminal and is not `waiting_user` (which waits on a human, not a process)
 * and is not `failed` (already terminal for our purposes — retryable, but not
 * in flight). Exported for startup reconciliation (RC-P0-04).
 */
export const COGSEED_INTERRUPTIBLE_STATUSES: readonly CogSeedTaskStatus[] =
  (Object.keys(TRANSITIONS) as CogSeedTaskStatus[]).filter((status) => (
    !isTerminal(status) && status !== 'waiting_user' && status !== 'failed'
  ));

export function isCogSeedInterruptibleStatus(status: CogSeedTaskStatus): boolean {
  return COGSEED_INTERRUPTIBLE_STATUSES.includes(status);
}

function safeErrorCode(value: unknown): string | undefined {
  const code = typeof value === 'string' ? value.trim() : '';
  return code && code.length <= 120 && /^[A-Za-z0-9_.:-]+$/.test(code) ? code : undefined;
}

export async function transitionCogSeedTask(
  userId: string,
  taskId: string,
  nextStatus: CogSeedTaskStatus,
  payload: Record<string, unknown> = {},
): Promise<CogSeedTaskRecord> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const current = await readCogSeedTask(userId, taskId);
  if (!current) throw new Error('CogSeed task not found');
  if (current.status === nextStatus) return current;
  if (isTerminal(current.status) || !TRANSITIONS[current.status].includes(nextStatus)) {
    throw new Error(`invalid CogSeed task transition ${current.status} -> ${nextStatus}`);
  }
  const errorCode = safeErrorCode(payload.errorCode);
  const updated = await updateCogSeedTask(userId, taskId, (task) => {
    const next: CogSeedTaskRecord = {
      ...task,
      status: nextStatus,
      updatedAt: nowIso(),
      ...(isTerminal(nextStatus) ? { terminalAt: nowIso() } : {}),
    };
    delete next.errorCode;
    if (errorCode && (nextStatus === 'failed' || nextStatus === 'recoverable')) next.errorCode = errorCode;
    return next;
  });
  await appendCogSeedTaskEvent(userId, taskId, updated.sessionId, eventType(nextStatus), payload);
  return updated;
}

export async function markCogSeedTaskRecoverable(userId: string, taskId: string, errorCode: string): Promise<CogSeedTaskRecord> {
  return transitionCogSeedTask(userId, taskId, 'recoverable', { errorCode });
}

export async function retryCogSeedTask(userId: string, taskId: string, requestId: string): Promise<CogSeedTaskRecord> {
  const previous = await readCogSeedTask(userId, taskId);
  if (!previous) throw new Error('CogSeed task not found');
  if (previous.executionKind === 'group-chat') throw new Error('Group Chat tasks must be retried through Group Chat');
  if (previous.status !== 'recoverable' && previous.status !== 'failed') {
    throw new Error('CogSeed task is not retryable');
  }
  return (await createCogSeedTask(userId, {
    requestId,
    task: previous.task,
    sessionId: previous.sessionId,
    ...(previous.conversationId ? { conversationId: previous.conversationId } : {}),
    ...(previous.agentId ? { agentId: previous.agentId } : {}),
    ...(previous.executionKind ? { executionKind: previous.executionKind } : {}),
    ...(previous.allowedSkillIds !== undefined ? { allowedSkillIds: previous.allowedSkillIds } : {}),
    ...(previous.skillVersionPins !== undefined ? { skillVersionPins: previous.skillVersionPins } : {}),
    ...(previous.skillVersionPinStatus ? { skillVersionPinStatus: previous.skillVersionPinStatus } : {}),
    preserveSkillVersionPins: true,
    ...(previous.localCli ? { localCli: previous.localCli } : {}),
    ...(previous.profileId ? { profileId: previous.profileId } : {}),
    ...(previous.abilityAssetIds ? { abilityAssetIds: previous.abilityAssetIds } : {}),
    ...(previous.workingDir ? { workingDir: previous.workingDir } : {}),
    retryOfTaskId: previous.taskId,
    ...(previous.coordinationId ? { coordinationId: previous.coordinationId } : {}),
    ...(previous.parentTaskId ? { parentTaskId: previous.parentTaskId } : {}),
    ...(previous.coordinationDepth !== undefined ? { coordinationDepth: previous.coordinationDepth } : {}),
  })).task;
}
