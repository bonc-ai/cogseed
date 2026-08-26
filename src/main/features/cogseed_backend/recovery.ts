import { nowIso, writeJson, PROCESS_STARTED_AT } from '../../storage';
import { isCogSeedInterruptibleStatus, markCogSeedTaskRecoverable, transitionCogSeedTask } from './lifecycle';
import { assertCogSeedUserId, cogseedRecoveryStateFile } from './paths';
import { listCogSeedTasks } from './task-store';
import type { CogSeedGroupChatProjectionInput } from './group-chat-projection';

export interface CogSeedRecoveryReport {
  recoveredCount: number;
  workflowStepsReconciled?: number;
  dispatchedCount: 0;
  taskIds: string[];
  /** Group Chat tasks failed out as interrupted by a restart (RC-P0-04). */
  groupChatFailedCount?: number;
}

/**
 * Error code stamped on Group Chat tasks that an app restart interrupted.
 * Deliberately distinct from `worker_restart`, which non-group-chat tasks get:
 * that one means "the worker died and the task can be resumed", which Group
 * Chat cannot honour.
 */
export const COGSEED_APP_RESTART_ERROR_CODE = 'app_restart';

export async function recoverCogSeedTasks(
  userId: string,
  options: {
    projectTaskEvent?: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>;
    /**
     * Process-start boundary. Only tasks last touched strictly before this are
     * treated as orphans. Overridable so tests can stage "a previous process
     * left this behind" without sleeping.
     */
    processStartedAt?: string;
  } = {},
): Promise<CogSeedRecoveryReport> {
  assertCogSeedUserId(userId);
  const processStartedAt = options.processStartedAt ?? PROCESS_STARTED_AT;
  const tasks = await listCogSeedTasks(userId);
  // Statuses come from the real state machine (lifecycle.ts), not a hand-written
  // list, so adding a status cannot silently leave a class of zombie behind.
  //
  // The timestamp guard is what makes this a *reconciliation* rather than a
  // wrecking ball. This sweep is deferred ~36s into boot and further delayed
  // while the user is active, so by the time it runs the user may well have
  // started a fresh conversation run. Without the guard that live task looks
  // exactly like an orphan, gets failed, and can never be corrected —
  // `failed → completed` is not a legal transition, so the bridge's terminal
  // projection would fail and the finished run would read `failed` forever.
  //
  // `updatedAt`, not `createdAt`: a task carried over from a previous process
  // but legitimately picked up again by this one has moved on and is live.
  // Strict `<`, not `<=`: `nowIso()` has second precision, and a task written
  // in the very same second as process start must be treated as live. Missing
  // an orphan costs one more startup to clean up; failing a live run is
  // irreversible.
  const interrupted = tasks.filter((task) => (
    isCogSeedInterruptibleStatus(task.status) && task.updatedAt < processStartedAt
  ));

  // Group Chat gets a different verdict from everything else, and the reason is
  // upstream capability, not preference. `group_chat/index.ts` heals an orphaned
  // run by setting the conversation to `idle` — it abandons the run and has no
  // resume path at all. Marking its shadow task `recoverable` would advertise a
  // recovery that nothing can perform, and `taskActions()` gives such a task
  // zero actions, so it becomes an un-actionable card that never goes away.
  // `failed` + `app_restart` is terminal and honest: the run died, and the
  // user's real recourse is the conversation itself (RC-P0-04 / RC-P0-05).
  const groupChatInterrupted = interrupted.filter((task) => task.executionKind === 'group-chat');
  // Already-`recoverable` non-group-chat tasks are excluded from the candidate
  // set rather than relying on `transitionCogSeedTask`'s same-status early
  // return. The transition being a no-op hid a real accounting bug: every
  // startup re-counted them as newly recovered and re-fired their display
  // projection. Since this sweep now runs on every launch, that repeated
  // forever.
  const recoverable = interrupted.filter((task) => (
    task.executionKind !== 'group-chat' && task.status !== 'recoverable'
  ));
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
  // Parent run tasks and actor-turn child tasks are both created through
  // `advanceToRunning` and both only terminate via `finishTask`, so both strand.
  // They are treated identically here — no parent/child special-casing.
  let groupChatFailedCount = 0;
  for (const task of groupChatInterrupted) {
    try {
      await transitionCogSeedTask(userId, task.taskId, 'failed', {
        source: 'app-restart-recovery',
        errorCode: COGSEED_APP_RESTART_ERROR_CODE,
      });
      groupChatFailedCount += 1;
    } catch {
      // One unreconcilable task must not abort the sweep for the rest. The next
      // startup will retry it; `failed` is terminal so this is idempotent.
    }
  }

  const taskIds = [...recoverable, ...groupChatInterrupted].map((task) => task.taskId);
  const collaborationRecovery = await recoverCogSeedCollaborationSteps(userId);
  await writeJson(cogseedRecoveryStateFile(userId), { schemaVersion: 1, ownerId: userId, recoveredAt: nowIso(), recoveredTaskIds: taskIds });
  return {
    recoveredCount: recoverable.length,
    workflowStepsReconciled: collaborationRecovery.reconciledCount,
    dispatchedCount: 0,
    taskIds,
    groupChatFailedCount,
  };
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
