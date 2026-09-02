import { nowIso, writeJson } from '../../storage';
import { isCogSeedTaskActiveStatus, markCogSeedTaskRecoverable } from './lifecycle';
import { assertCogSeedUserId, cogseedRecoveryStateFile } from './paths';
import { listCogSeedTasks, readCogSeedTask } from './task-store';
import type { CogSeedGroupChatProjectionInput } from './group-chat-projection';
import type { CogSeedTaskRecord } from './types';

export interface CogSeedRecoveryReport {
  recoveredCount: number;
  workflowStepsReconciled?: number;
  dispatchedCount: 0;
  taskIds: string[];
}

export interface CogSeedRecoveryOptions {
  projectTaskEvent?: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>;
  /** Tasks known to still have a live executor in this main-process instance. */
  activeTaskIds?: Iterable<string>;
  /** Optional ownership/liveness probe for callers with a richer runtime view. */
  isTaskActive?: (task: CogSeedTaskRecord) => boolean | Promise<boolean>;
}

const inFlightRecoveries = new Map<string, Promise<CogSeedRecoveryReport>>();

function isRecoveryCandidate(task: CogSeedTaskRecord): boolean {
  return isCogSeedTaskActiveStatus(task.status);
}

export interface RecoverCogSeedTaskOptions {
  errorCode: string;
  projectTaskEvent?: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>;
  canRecover?: (task: CogSeedTaskRecord) => boolean | Promise<boolean>;
}

/** Re-read and transition one candidate through the canonical lifecycle path.
 * A concurrent completion, cancellation, retry, or prior recovery wins
 * benignly and returns null. */
export async function recoverCogSeedTask(
  userId: string,
  taskId: string,
  options: RecoverCogSeedTaskOptions,
): Promise<CogSeedTaskRecord | null> {
  const current = await readCogSeedTask(userId, taskId);
  if (!current || !isRecoveryCandidate(current)) return null;
  if (options.canRecover && !await options.canRecover(current)) return null;
  let updated: CogSeedTaskRecord;
  try {
    updated = await markCogSeedTaskRecoverable(userId, taskId, options.errorCode);
  } catch (error) {
    const latest = await readCogSeedTask(userId, taskId);
    if (!latest || !isRecoveryCandidate(latest)) return null;
    throw error;
  }
  if (updated.status !== 'recoverable') return null;
  if (updated.conversationId && updated.agentId && options.projectTaskEvent) {
    try {
      await options.projectTaskEvent({
        userId,
        conversationId: updated.conversationId,
        agentId: updated.agentId,
        taskId: updated.taskId,
        sessionId: updated.sessionId,
        event: {
          eventId: `cogseed-event-recovery-${updated.taskId}`,
          type: 'task.recoverable',
          payload: { errorCode: options.errorCode },
        },
      });
    } catch {
      // Recovery state is authoritative; display projection remains best-effort.
    }
  }
  return updated;
}

async function runCogSeedTaskRecovery(
  userId: string,
  options: CogSeedRecoveryOptions,
): Promise<CogSeedRecoveryReport> {
  const tasks = await listCogSeedTasks(userId);
  const candidates = tasks.filter(isRecoveryCandidate);
  const activeTaskIds = new Set(options.activeTaskIds ?? []);
  const projectTaskEvent = options.projectTaskEvent ?? (async (input: CogSeedGroupChatProjectionInput) => {
    const { cogseedGroupChatProjection } = await import('./group-chat-projection');
    return cogseedGroupChatProjection.project(input);
  });
  const taskIds: string[] = [];
  for (const task of candidates) {
    if (activeTaskIds.has(task.taskId) || await options.isTaskActive?.(task)) continue;
    const updated = await recoverCogSeedTask(userId, task.taskId, {
      errorCode: 'worker_restart',
      projectTaskEvent,
    });
    if (!updated) continue;
    taskIds.push(updated.taskId);
  }
  const collaborationRecovery = await recoverCogSeedCollaborationSteps(userId);
  await writeJson(cogseedRecoveryStateFile(userId), { schemaVersion: 1, ownerId: userId, recoveredAt: nowIso(), recoveredTaskIds: taskIds });
  return { recoveredCount: taskIds.length, workflowStepsReconciled: collaborationRecovery.reconciledCount, dispatchedCount: 0, taskIds };
}

export function recoverCogSeedTasks(
  userId: string,
  options: CogSeedRecoveryOptions = {},
): Promise<CogSeedRecoveryReport> {
  assertCogSeedUserId(userId);
  const inFlight = inFlightRecoveries.get(userId);
  if (inFlight) return inFlight;
  const recovery = runCogSeedTaskRecovery(userId, options);
  inFlightRecoveries.set(userId, recovery);
  const clear = () => {
    if (inFlightRecoveries.get(userId) === recovery) inFlightRecoveries.delete(userId);
  };
  void recovery.then(clear, clear);
  return recovery;
}

export async function recoverCogSeedCollaborationSteps(userId: string): Promise<{ reconciledCount: number; coordinationIds: string[] }> {
  const fs = await import('node:fs/promises');
  const { cogseedAgentCoordinationsDir } = await import('../../paths');
  const { readCogSeedCoordination } = await import('./coordinator');
  const { createCogSeedCollaborationStore } = await import('./collaboration-store-adapter');
  const { createCollaborationEngine } = await import('../collaboration_control/engine');
  const { createCogSeedCollaborationDispatcher } = await import('./collaboration-dispatcher');
  const { cogseedRuntimeController } = await import('./runtime-controller');
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(cogseedAgentCoordinationsDir(userId), { withFileTypes: true }); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { reconciledCount: 0, coordinationIds: [] }; throw error; }
  const dispatcher = createCogSeedCollaborationDispatcher({ startTask: (uid, input) => cogseedRuntimeController.startCogSeedTask(uid, input), cancelTask: (uid, taskId) => cogseedRuntimeController.cancelCogSeedTask(uid, taskId) });
  const engine = createCollaborationEngine({ store: createCogSeedCollaborationStore(), dispatcher });
  let reconciledCount = 0; const coordinationIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('cogseed-coord-') || !entry.name.endsWith('.json')) continue;
    const coordinationId = entry.name.slice(0, -5); const record = await readCogSeedCoordination(userId, coordinationId); if (!record?.workflowRunId) continue;
    const scope = { ownerId: userId, domain: 'cogseed' as const, scopeId: coordinationId }; const run = await createCogSeedCollaborationStore().readRun(scope, record.workflowRunId); if (!run) continue;
    let touched = false;
    for (const step of run.steps.filter((item) => item.status === 'running' && item.result_ref?.startsWith('cogseed-task-'))) {
      const task = await (await import('./task-store')).readCogSeedTask(userId, step.result_ref!); if (!task) continue;
      if (task.status === 'completed') { await engine.completeStep(scope, run.id, step.id, { status: 'completed', resultRef: task.taskId, resultSummary: 'Recovered completed CogSeed task.' }); touched = true; }
      else if (task.status === 'failed') { await engine.completeStep(scope, run.id, step.id, { status: 'failed', resultRef: task.taskId, resultSummary: task.errorCode || 'Recovered failed CogSeed task.' }); touched = true; }
      else if (task.status === 'cancelled') { await engine.completeStep(scope, run.id, step.id, { status: 'skipped', resultRef: task.taskId, resultSummary: 'Recovered cancelled CogSeed task.' }); touched = true; }
    }
    if (touched) { reconciledCount += 1; coordinationIds.push(coordinationId); }
  }
  return { reconciledCount, coordinationIds };
}
