import { nowIso } from '../../storage';
import { appendMateTaskEvent } from './event-store';
import { assertMateTaskId, assertMateUserId } from './paths';
import { createMateTask, readMateTask, updateMateTask } from './task-store';
import type { MateTaskRecord, MateTaskStatus } from './types';

const TRANSITIONS: Readonly<Record<MateTaskStatus, readonly MateTaskStatus[]>> = {
  created: ['queued', 'cancelled', 'recoverable'],
  queued: ['running', 'cancelled', 'recoverable'],
  running: ['waiting_user', 'completed', 'failed', 'cancelled', 'recoverable'],
  waiting_user: ['queued', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
  recoverable: ['queued'],
};

function eventType(status: MateTaskStatus): 'task.queued' | 'task.started' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.recoverable' {
  if (status === 'queued') return 'task.queued';
  if (status === 'running') return 'task.started';
  if (status === 'completed') return 'task.completed';
  if (status === 'cancelled') return 'task.cancelled';
  if (status === 'recoverable') return 'task.recoverable';
  return 'task.failed';
}

function isTerminal(status: MateTaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export async function transitionMateTask(
  userId: string,
  taskId: string,
  nextStatus: MateTaskStatus,
  payload: Record<string, unknown> = {},
): Promise<MateTaskRecord> {
  assertMateUserId(userId);
  assertMateTaskId(taskId);
  const current = await readMateTask(userId, taskId);
  if (!current) throw new Error('CogSeed task not found');
  if (current.status === nextStatus) return current;
  if (isTerminal(current.status) || !TRANSITIONS[current.status].includes(nextStatus)) {
    throw new Error(`invalid CogSeed task transition ${current.status} -> ${nextStatus}`);
  }
  const updated = await updateMateTask(userId, taskId, (task) => ({
    ...task,
    status: nextStatus,
    updatedAt: nowIso(),
    ...(isTerminal(nextStatus) ? { terminalAt: nowIso() } : {}),
  }));
  await appendMateTaskEvent(userId, taskId, updated.sessionId, eventType(nextStatus), payload);
  return updated;
}

export async function markMateTaskRecoverable(userId: string, taskId: string, errorCode: string): Promise<MateTaskRecord> {
  return transitionMateTask(userId, taskId, 'recoverable', { errorCode });
}

export async function retryMateTask(userId: string, taskId: string, requestId: string): Promise<MateTaskRecord> {
  const previous = await readMateTask(userId, taskId);
  if (!previous) throw new Error('CogSeed task not found');
  if (previous.status !== 'recoverable' && previous.status !== 'failed') {
    throw new Error('CogSeed task is not retryable');
  }
  return (await createMateTask(userId, {
    requestId,
    task: previous.task,
    sessionId: previous.sessionId,
    ...(previous.conversationId ? { conversationId: previous.conversationId } : {}),
    ...(previous.agentId ? { agentId: previous.agentId } : {}),
    ...(previous.executionKind ? { executionKind: previous.executionKind } : {}),
    ...(previous.allowedSkillIds !== undefined ? { allowedSkillIds: previous.allowedSkillIds } : {}),
    ...(previous.localCli ? { localCli: previous.localCli } : {}),
    ...(previous.profileId ? { profileId: previous.profileId } : {}),
    retryOfTaskId: previous.taskId,
    ...(previous.coordinationId ? { coordinationId: previous.coordinationId } : {}),
    ...(previous.parentTaskId ? { parentTaskId: previous.parentTaskId } : {}),
    ...(previous.coordinationDepth !== undefined ? { coordinationDepth: previous.coordinationDepth } : {}),
  })).task;
}
