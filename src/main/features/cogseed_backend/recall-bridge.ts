import * as cogseedExecutionRecords from './cogseed-execution-store';
import { readCogSeedTaskEvents } from './event-store';
import { assertCogSeedTaskId, assertCogSeedUserId } from './paths';
import { readCogSeedTask } from './task-store';
import type { CogSeedTaskRecord } from './types';
import { listContextProjections } from '../recall/context-projection';
import { handleRecallTaskTerminal } from '../recall/terminal-proof';

export interface CogSeedRecallRunFact {
  executionId: string;
  taskId: string;
  sessionId: string;
  runtimeSessionId: string;
  status: 'completed' | 'failed' | 'cancelled';
}

function cogseedExecutionId(taskId: string): string {
  return `cogseed-exec-${taskId.slice('cogseed-task-'.length)}`;
}

function terminalStatus(status: CogSeedTaskRecord['status']): CogSeedRecallRunFact['status'] | null {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return null;
}

async function readExistingFact(userId: string, task: CogSeedTaskRecord, executionId: string): Promise<CogSeedRecallRunFact | null> {
  try {
    const existing = await cogseedExecutionRecords.read(userId, executionId);
    if (!terminalStatus(existing.status)) return null;
    return {
      executionId: existing.executionId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      runtimeSessionId: task.runtimeSessionId,
      status: existing.status as CogSeedRecallRunFact['status'],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) return null;
    throw error;
  }
}

async function recordConfirmedProjectionTransferProof(
  userId: string,
  task: CogSeedTaskRecord,
  executionId: string,
  status: CogSeedRecallRunFact['status'],
): Promise<void> {
  const taskRunIds = new Set([
    task.taskId,
    executionId,
    task.runtimeSessionId,
    task.runtimeRunId,
  ].filter((value): value is string => Boolean(value)));
  const projection = (await listContextProjections(userId, { status: 'confirmed', includeExpired: false, limit: 100 }))
    .find((item) => taskRunIds.has(item.taskRunId));
  if (!projection) return;
  await handleRecallTaskTerminal({
    run_id: task.taskId,
    user_id: userId,
    conversation_id: task.sessionId,
    status,
    projection_id: projection.id,
    logical_run_id: projection.taskRunId,
    execution_id: executionId,
    started_at_ms: Date.parse(task.createdAt) || Date.now(),
    finished_at_ms: Date.parse(task.terminalAt || task.updatedAt) || Date.now(),
  });
}

export async function recordCogSeedTaskRunForRecall(userId: string, taskId: string): Promise<CogSeedRecallRunFact> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const task = await readCogSeedTask(userId, taskId);
  if (!task) throw new Error('CogSeed task not found');
  const status = terminalStatus(task.status);
  if (!status) throw new Error('CogSeed task is not terminal for Recall recording');
  const executionId = task.executionId || cogseedExecutionId(task.taskId);

  const existing = await readExistingFact(userId, task, executionId);
  if (existing) {
    await recordConfirmedProjectionTransferProof(userId, task, executionId, existing.status);
    return existing;
  }

  const cogseedEvents = await readCogSeedTaskEvents(userId, task.taskId, 0, 500);
  const facts = {
    eventCount: cogseedEvents.length,
    toolStartedCount: cogseedEvents.filter((event) => event.type === 'tool.started').length,
    toolFinishedCount: cogseedEvents.filter((event) => event.type === 'tool.finished').length,
    modelDeltaCount: cogseedEvents.filter((event) => event.type === 'model.delta').length,
  };

  await cogseedExecutionRecords.create(userId, {
    executionId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    runtimeSessionId: task.runtimeSessionId,
    ownerId: userId,
    kind: 'cogseed-agent',
    status: 'queued',
    boundary: 'real',
    permissionMode: 'cogseed-runtime',
    ...facts,
  });
  await cogseedExecutionRecords.appendEvent(userId, executionId, 'queued', { sessionId: task.sessionId });
  await cogseedExecutionRecords.appendEvent(userId, executionId, 'started', { sessionId: task.sessionId });
  await cogseedExecutionRecords.appendEvent(userId, executionId, 'cogseed.task', {
    taskId: task.taskId,
    sessionId: task.sessionId,
    runtimeSessionId: task.runtimeSessionId,
    requestId: task.requestId,
    status: task.status,
    ...facts,
  });
  await cogseedExecutionRecords.appendEvent(userId, executionId, 'terminal', { status });
  await cogseedExecutionRecords.complete(userId, executionId, status, facts);
  await recordConfirmedProjectionTransferProof(userId, task, executionId, status);

  return { executionId, taskId: task.taskId, sessionId: task.sessionId, runtimeSessionId: task.runtimeSessionId, status };
}
