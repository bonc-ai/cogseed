import { nowIso, writeJson } from '../../storage';
import { markMateTaskRecoverable } from './lifecycle';
import { assertMateUserId, mateRecoveryStateFile } from './paths';
import { listMateTasks } from './task-store';
import type { MateGroupChatProjectionInput } from './group-chat-projection';

export interface MateRecoveryReport {
  recoveredCount: number;
  workflowStepsReconciled?: number;
  dispatchedCount: 0;
  taskIds: string[];
}

export async function recoverMateTasks(
  userId: string,
  options: { projectTaskEvent?: (input: MateGroupChatProjectionInput) => Promise<unknown> } = {},
): Promise<MateRecoveryReport> {
  assertMateUserId(userId);
  const tasks = await listMateTasks(userId);
  const recoverable = tasks.filter((task) => task.status === 'created' || task.status === 'queued' || task.status === 'running');
  const projectTaskEvent = options.projectTaskEvent ?? (async (input: MateGroupChatProjectionInput) => {
    const { mateGroupChatProjection } = await import('./group-chat-projection');
    return mateGroupChatProjection.project(input);
  });
  for (const task of recoverable) {
    const updated = await markMateTaskRecoverable(userId, task.taskId, 'worker_restart');
    if (updated.conversationId && updated.agentId) {
      try {
        await projectTaskEvent({
          userId,
          conversationId: updated.conversationId,
          agentId: updated.agentId,
          taskId: updated.taskId,
          sessionId: updated.sessionId,
          event: {
            eventId: `mate-event-recovery-${updated.taskId}`,
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
  const collaborationRecovery = await recoverMateCollaborationSteps(userId);
  await writeJson(mateRecoveryStateFile(userId), { schemaVersion: 1, ownerId: userId, recoveredAt: nowIso(), recoveredTaskIds: taskIds });
  return { recoveredCount: recoverable.length, workflowStepsReconciled: collaborationRecovery.reconciledCount, dispatchedCount: 0, taskIds };
}

export async function recoverMateCollaborationSteps(userId: string): Promise<{ reconciledCount: number; coordinationIds: string[] }> {
  const fs = await import('node:fs/promises');
  const { mateAgentCoordinationsDir } = await import('../../paths');
  const { readMateCoordination } = await import('./coordinator');
  const { createMateCollaborationStore } = await import('./collaboration-store-adapter');
  const { createCollaborationEngine } = await import('../collaboration_control/engine');
  const { createMateCollaborationDispatcher } = await import('./collaboration-dispatcher');
  const { mateRuntimeController } = await import('./runtime-controller');
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(mateAgentCoordinationsDir(userId), { withFileTypes: true }); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { reconciledCount: 0, coordinationIds: [] }; throw error; }
  const dispatcher = createMateCollaborationDispatcher({ startTask: (uid, input) => mateRuntimeController.startMateTask(uid, input), cancelTask: (uid, taskId) => mateRuntimeController.cancelMateTask(uid, taskId) });
  const engine = createCollaborationEngine({ store: createMateCollaborationStore(), dispatcher });
  let reconciledCount = 0; const coordinationIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('mate-coord-') || !entry.name.endsWith('.json')) continue;
    const coordinationId = entry.name.slice(0, -5); const record = await readMateCoordination(userId, coordinationId); if (!record?.workflowRunId) continue;
    const scope = { ownerId: userId, domain: 'mate' as const, scopeId: coordinationId }; const run = await createMateCollaborationStore().readRun(scope, record.workflowRunId); if (!run) continue;
    let touched = false;
    for (const step of run.steps.filter((item) => item.status === 'running' && item.result_ref?.startsWith('mate-task-'))) {
      const task = await (await import('./task-store')).readMateTask(userId, step.result_ref!); if (!task) continue;
      if (task.status === 'completed') { await engine.completeStep(scope, run.id, step.id, { status: 'completed', resultRef: task.taskId, resultSummary: 'Recovered completed CogSeed task.' }); touched = true; }
      else if (task.status === 'failed') { await engine.completeStep(scope, run.id, step.id, { status: 'failed', resultRef: task.taskId, resultSummary: task.errorCode || 'Recovered failed CogSeed task.' }); touched = true; }
      else if (task.status === 'cancelled') { await engine.completeStep(scope, run.id, step.id, { status: 'skipped', resultRef: task.taskId, resultSummary: 'Recovered cancelled CogSeed task.' }); touched = true; }
    }
    if (touched) { reconciledCount += 1; coordinationIds.push(coordinationId); }
  }
  return { reconciledCount, coordinationIds };
}
