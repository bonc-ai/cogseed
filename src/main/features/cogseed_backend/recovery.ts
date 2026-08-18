import { nowIso, writeJson } from '../../storage';
import { markCogSeedTaskRecoverable } from './lifecycle';
import { assertCogSeedUserId, cogseedRecoveryStateFile } from './paths';
import { listCogSeedTasks } from './task-store';
import type { CogSeedGroupChatProjectionInput } from './group-chat-projection';

export interface CogSeedRecoveryReport {
  recoveredCount: number;
  workflowStepsReconciled?: number;
  dispatchedCount: 0;
  taskIds: string[];
}

export async function recoverCogSeedTasks(
  userId: string,
  options: { projectTaskEvent?: (input: CogSeedGroupChatProjectionInput) => Promise<unknown> } = {},
): Promise<CogSeedRecoveryReport> {
  assertCogSeedUserId(userId);
  const tasks = await listCogSeedTasks(userId);
  const recoverable = tasks.filter((task) => task.status === 'created' || task.status === 'queued' || task.status === 'running');
  const projectTaskEvent = options.projectTaskEvent ?? (async (input: CogSeedGroupChatProjectionInput) => {
    const { cogseedGroupChatProjection } = await import('./group-chat-projection');
    return cogseedGroupChatProjection.project(input);
  });
  for (const task of recoverable) {
    const updated = await markCogSeedTaskRecoverable(userId, task.taskId, 'worker_restart');
    if (updated.conversationId && updated.agentId) {
      try {
        await projectTaskEvent({
          userId,
          conversationId: updated.conversationId,
          agentId: updated.agentId,
          taskId: updated.taskId,
          sessionId: updated.sessionId,
          event: {
            eventId: `cogseed-event-recovery-${updated.taskId}`,
            type: 'task.recoverable',
            payload: { errorCode: 'worker_restart' },
          },
        });
      } catch {
        // Recovery state is authoritative; display projection remains best-effort.
      }
    }
  }
  const taskIds = recoverable.map((task) => task.taskId);
  const collaborationRecovery = await recoverCogSeedCollaborationSteps(userId);
  await writeJson(cogseedRecoveryStateFile(userId), { schemaVersion: 1, ownerId: userId, recoveredAt: nowIso(), recoveredTaskIds: taskIds });
  return { recoveredCount: recoverable.length, workflowStepsReconciled: collaborationRecovery.reconciledCount, dispatchedCount: 0, taskIds };
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
