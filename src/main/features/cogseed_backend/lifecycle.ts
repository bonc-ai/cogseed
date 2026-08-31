import { nowIso } from '../../storage';
import { assertCogSeedTaskId, assertCogSeedUserId } from './paths';
import {
  createCogSeedTask,
  ensureCogSeedTaskLifecycleArtifact,
  readCogSeedTask,
  updateCogSeedTask,
  updateCogSeedTaskWithEvent,
} from './task-store';
import type { CogSeedTaskRecord, CogSeedTaskStatus } from './types';

const TRANSITIONS: Readonly<Record<CogSeedTaskStatus, readonly CogSeedTaskStatus[]>> = {
  created: ['queued', 'cancelled', 'recoverable'],
  queued: ['running', 'cancelled', 'recoverable'],
  running: ['waiting_user', 'completed', 'failed', 'cancelled', 'recoverable'],
  waiting_user: ['queued', 'cancelled', 'recoverable'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
  recoverable: ['queued', 'cancelled'],
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

export function isCogSeedTaskActiveStatus(status: CogSeedTaskStatus): boolean {
  return status === 'created' || status === 'queued' || status === 'running' || status === 'waiting_user';
}

export async function archiveCogSeedTask(userId: string, taskId: string): Promise<CogSeedTaskRecord> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  return updateCogSeedTaskWithEvent(userId, taskId, (task) => {
    if (task.archivedAt) return task;
    if (task.status !== 'failed') throw new Error('Only failed CogSeed tasks can be archived');
    if (task.resultDeliveryState === 'pending' || task.resultDeliveryState === 'pending-recovery') {
      throw new Error('CogSeed task result must be recovered before archiving');
    }
    const archivedAt = nowIso();
    return { ...task, archivedAt, updatedAt: archivedAt };
  }, { type: 'task.archived', payload: {} });
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
  const errorCode = safeErrorCode(payload.errorCode);
  return updateCogSeedTaskWithEvent(userId, taskId, (task) => {
    if (task.status === nextStatus) return task;
    if (isTerminal(task.status) || !TRANSITIONS[task.status].includes(nextStatus)) {
      throw new Error(`invalid CogSeed task transition ${task.status} -> ${nextStatus}`);
    }
    const next: CogSeedTaskRecord = {
      ...task,
      status: nextStatus,
      updatedAt: nowIso(),
      ...(isTerminal(nextStatus) ? { terminalAt: nowIso() } : {}),
    };
    delete next.errorCode;
    if (errorCode && (nextStatus === 'failed' || nextStatus === 'recoverable')) next.errorCode = errorCode;
    return next;
  }, { type: eventType(nextStatus), payload });
}

export async function markCogSeedTaskRecoverable(userId: string, taskId: string, errorCode: string): Promise<CogSeedTaskRecord> {
  return transitionCogSeedTask(userId, taskId, 'recoverable', { errorCode });
}

/** Apply a terminal result that was durably retained before a process exit.
 * The retained record is proof that execution finished, so recovery must not
 * fabricate queued/running transitions merely to satisfy the live state
 * machine. The caller validates the retained execution binding first. */
export async function finalizeCogSeedTaskFromRetainedResult(
  userId: string,
  taskId: string,
  nextStatus: 'completed' | 'failed',
  payload: { outputChars?: number; errorCode?: string } = {},
): Promise<CogSeedTaskRecord> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const errorCode = safeErrorCode(payload.errorCode);
  const eventPayload = nextStatus === 'completed'
    ? { outputChars: Math.max(0, Math.floor(Number(payload.outputChars) || 0)) }
    : { ...(errorCode ? { errorCode } : {}) };
  const current = await readCogSeedTask(userId, taskId);
  if (!current) throw new Error('CogSeed task not found');
  if (current.status === nextStatus) {
    const updated = current.resultDeliveryState === 'pending-recovery' || current.resultDeliveryState === 'delivered'
      ? current
      : await updateCogSeedTask(userId, taskId, (task) => ({
        ...task,
        resultDeliveryState: 'pending-recovery',
        updatedAt: nowIso(),
      }));
    await ensureCogSeedTaskLifecycleArtifact(userId, taskId, eventPayload);
    return updated;
  }
  if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
    throw new Error(`conflicting CogSeed retained result for ${current.status} task`);
  }
  return updateCogSeedTaskWithEvent(userId, taskId, (task) => {
    if (task.status === nextStatus) return task;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`conflicting CogSeed retained result for ${task.status} task`);
    }
    const timestamp = nowIso();
    const next: CogSeedTaskRecord = {
      ...task,
      status: nextStatus,
      resultDeliveryState: 'pending-recovery',
      updatedAt: timestamp,
      terminalAt: timestamp,
    };
    delete next.errorCode;
    if (nextStatus === 'failed' && errorCode) next.errorCode = errorCode;
    return next;
  }, { type: nextStatus === 'completed' ? 'task.completed' : 'task.failed', payload: eventPayload });
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
