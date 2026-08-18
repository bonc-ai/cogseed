import { nowIso } from '../../storage';
import { appendCogSeedTaskEvent } from './event-store';
import { assertCogSeedTaskId, assertCogSeedUserId } from './paths';
import { createCogSeedTask, readCogSeedTask, updateCogSeedTask } from './task-store';
import type { CogSeedTaskRecord, CogSeedTaskStatus } from './types';

const TRANSITIONS: Readonly<Record<CogSeedTaskStatus, readonly CogSeedTaskStatus[]>> = {
  created: ['queued', 'cancelled', 'recoverable'],
  queued: ['running', 'cancelled', 'recoverable'],
  running: ['waiting_user', 'completed', 'failed', 'cancelled', 'recoverable'],
  waiting_user: ['queued', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
  recoverable: ['queued'],
};

function eventType(status: CogSeedTaskStatus): 'task.queued' | 'task.started' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.recoverable' {
  if (status === 'queued') return 'task.queued';
  if (status === 'running') return 'task.started';
  if (status === 'completed') return 'task.completed';
  if (status === 'cancelled') return 'task.cancelled';
  if (status === 'recoverable') return 'task.recoverable';
  return 'task.failed';
}

function isTerminal(status: CogSeedTaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
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
  const updated = await updateCogSeedTask(userId, taskId, (task) => ({
    ...task,
    status: nextStatus,
    updatedAt: nowIso(),
    ...(isTerminal(nextStatus) ? { terminalAt: nowIso() } : {}),
  }));
  await appendCogSeedTaskEvent(userId, taskId, updated.sessionId, eventType(nextStatus), payload);
  return updated;
}

export async function markCogSeedTaskRecoverable(userId: string, taskId: string, errorCode: string): Promise<CogSeedTaskRecord> {
  return transitionCogSeedTask(userId, taskId, 'recoverable', { errorCode });
}

export async function retryCogSeedTask(userId: string, taskId: string, requestId: string): Promise<CogSeedTaskRecord> {
  const previous = await readCogSeedTask(userId, taskId);
  if (!previous) throw new Error('CogSeed task not found');
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
    retryOfTaskId: previous.taskId,
    ...(previous.coordinationId ? { coordinationId: previous.coordinationId } : {}),
    ...(previous.parentTaskId ? { parentTaskId: previous.parentTaskId } : {}),
    ...(previous.coordinationDepth !== undefined ? { coordinationDepth: previous.coordinationDepth } : {}),
  })).task;
}
