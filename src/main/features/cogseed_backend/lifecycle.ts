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
