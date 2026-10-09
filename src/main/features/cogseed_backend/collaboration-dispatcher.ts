import type { CollaborationDispatcher, CollaborationScope, DispatchReceipt, ExecutionSnapshot } from '../collaboration_control/ports';
import type { WorkflowRun, WorkflowStep } from '../collaboration_control/types';
import { readCogSeedTask } from './task-store';
import { readCogSeedCoordination } from './coordinator';
import type { CogSeedTaskRecord } from './types';
import type { StartCogSeedTaskInput } from './runtime-controller';

export interface CogSeedCollaborationDispatcherDeps {
  startTask(userId: string, input: StartCogSeedTaskInput): Promise<CogSeedTaskRecord>;
  cancelTask(userId: string, taskId: string): Promise<CogSeedTaskRecord>;
  readTask?: typeof readCogSeedTask;
}

export function createCogSeedCollaborationDispatcher(deps: CogSeedCollaborationDispatcherDeps): CollaborationDispatcher {
  const readTask = deps.readTask ?? readCogSeedTask;
  const cogseed = (scope: CollaborationScope) => { if (scope.domain !== 'cogseed') throw new Error('CogSeed dispatcher requires cogseed domain'); return scope; };
  return {
    async dispatchStep(scope, _run: WorkflowRun, step: WorkflowStep): Promise<DispatchReceipt> {
      cogseed(scope); const coordination = await readCogSeedCoordination(scope.ownerId, scope.scopeId); if (!coordination) throw new Error('CogSeed coordination not found');
      const parent = await readTask(scope.ownerId, coordination.parentTaskId); if (!parent) throw new Error('CogSeed coordination parent task not found');
      const requestId = step.resume_token?.startsWith('req-') ? step.resume_token : `req-${step.id}`;
      const child = await deps.startTask(scope.ownerId, {
        requestId,
        task: step.objective || step.title,
        ...(parent.profileId ? { profileId: parent.profileId } : {}),
        ...(parent.abilityAssetIds ? { abilityAssetIds: parent.abilityAssetIds } : {}),
        ...(parent.workingDir ? { workingDir: parent.workingDir } : {}),
        coordinationId: coordination.coordinationId,
        parentTaskId: parent.taskId,
        coordinationDepth: (parent.coordinationDepth ?? 0) + 1,
      });
      return { executionId: child.taskId, status: child.status === 'completed' ? 'completed' : child.status === 'failed' ? 'failed' : child.status === 'cancelled' ? 'cancelled' : 'running' };
    },
    async cancelStep(scope, step) { cogseed(scope); if (step.result_ref?.startsWith('cogseed-task-')) await deps.cancelTask(scope.ownerId, step.result_ref); },
    async readExecution(scope, step): Promise<ExecutionSnapshot | null> { cogseed(scope); if (!step.result_ref?.startsWith('cogseed-task-')) return null; const task = await readTask(scope.ownerId, step.result_ref); if (!task) return null; return { executionId: task.taskId, status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : task.status === 'queued' ? 'queued' : 'running' }; },
  };
}
