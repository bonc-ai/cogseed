import * as mateExecutionRecords from './mate-execution-store';
import { readMateTaskEvents } from './event-store';
import { assertMateTaskId, assertMateUserId } from './paths';
import { readMateTask } from './task-store';
import type { MateTaskRecord } from './types';
import { listContextProjections } from '../recall/context-projection';
import { handleRecallTaskTerminal } from '../recall/terminal-proof';

export interface MateRecallRunFact {
  executionId: string;
  taskId: string;
  sessionId: string;
  runtimeSessionId: string;
  status: 'completed' | 'failed' | 'cancelled';
}

function mateExecutionId(taskId: string): string {
  return `mate-exec-${taskId.slice('mate-task-'.length)}`;
}

function terminalStatus(status: MateTaskRecord['status']): MateRecallRunFact['status'] | null {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return null;
}

async function readExistingFact(userId: string, task: MateTaskRecord, executionId: string): Promise<MateRecallRunFact | null> {
  try {
    const existing = await mateExecutionRecords.read(userId, executionId);
    if (!terminalStatus(existing.status)) return null;
    return {
      executionId: existing.executionId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      runtimeSessionId: task.runtimeSessionId,
      status: existing.status as MateRecallRunFact['status'],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) return null;
    throw error;
  }
}

async function recordConfirmedProjectionTransferProof(
  userId: string,
  task: MateTaskRecord,
  executionId: string,
  status: MateRecallRunFact['status'],
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

export async function recordMateTaskRunForRecall(userId: string, taskId: string): Promise<MateRecallRunFact> {
  assertMateUserId(userId);
  assertMateTaskId(taskId);
  const task = await readMateTask(userId, taskId);
  if (!task) throw new Error('CogSeed task not found');
  const status = terminalStatus(task.status);
  if (!status) throw new Error('CogSeed task is not terminal for Recall recording');
  const executionId = task.executionId || mateExecutionId(task.taskId);

  const existing = await readExistingFact(userId, task, executionId);
  if (existing) {
    await recordConfirmedProjectionTransferProof(userId, task, executionId, existing.status);
    return existing;
  }

  const mateEvents = await readMateTaskEvents(userId, task.taskId, 0, 500);
  const facts = {
    eventCount: mateEvents.length,
    toolStartedCount: mateEvents.filter((event) => event.type === 'tool.started').length,
    toolFinishedCount: mateEvents.filter((event) => event.type === 'tool.finished').length,
    modelDeltaCount: mateEvents.filter((event) => event.type === 'model.delta').length,
  };

  await mateExecutionRecords.create(userId, {
    executionId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    runtimeSessionId: task.runtimeSessionId,
    ownerId: userId,
    kind: 'mate-agent',
    status: 'queued',
    boundary: 'real',
    permissionMode: 'cogseed-runtime',
    ...facts,
  });
  await mateExecutionRecords.appendEvent(userId, executionId, 'queued', { sessionId: task.sessionId });
  await mateExecutionRecords.appendEvent(userId, executionId, 'started', { sessionId: task.sessionId });
  await mateExecutionRecords.appendEvent(userId, executionId, 'mate.task', {
    taskId: task.taskId,
    sessionId: task.sessionId,
    runtimeSessionId: task.runtimeSessionId,
    requestId: task.requestId,
    status: task.status,
    ...facts,
  });
  await mateExecutionRecords.appendEvent(userId, executionId, 'terminal', { status });
  await mateExecutionRecords.complete(userId, executionId, status, facts);
  await recordConfirmedProjectionTransferProof(userId, task, executionId, status);

  return { executionId, taskId: task.taskId, sessionId: task.sessionId, runtimeSessionId: task.runtimeSessionId, status };
}
