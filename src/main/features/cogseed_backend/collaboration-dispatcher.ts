import type { CollaborationDispatcher, CollaborationScope, DispatchReceipt, ExecutionSnapshot } from '../collaboration_control/ports';
import type { WorkflowRun, WorkflowStep } from '../collaboration_control/types';
import { readMateTask } from './task-store';
import { readMateCoordination } from './coordinator';
import type { MateTaskRecord } from './types';
import type { StartMateTaskInput } from './runtime-controller';

export interface MateCollaborationDispatcherDeps {
  startTask(userId: string, input: StartMateTaskInput): Promise<MateTaskRecord>;
  cancelTask(userId: string, taskId: string): Promise<MateTaskRecord>;
  readTask?: typeof readMateTask;
}

export function createMateCollaborationDispatcher(deps: MateCollaborationDispatcherDeps): CollaborationDispatcher {
  const readTask = deps.readTask ?? readMateTask;
  const mate = (scope: CollaborationScope) => { if (scope.domain !== 'mate') throw new Error('CogSeed dispatcher requires mate domain'); return scope; };
  return {
    async dispatchStep(scope, _run: WorkflowRun, step: WorkflowStep): Promise<DispatchReceipt> {
      mate(scope); const coordination = await readMateCoordination(scope.ownerId, scope.scopeId); if (!coordination) throw new Error('CogSeed coordination not found');
      const parent = await readTask(scope.ownerId, coordination.parentTaskId); if (!parent) throw new Error('CogSeed coordination parent task not found');
      const requestId = step.resume_token?.startsWith('req-') ? step.resume_token : `req-${step.id}`;
      const child = await deps.startTask(scope.ownerId, { requestId, task: step.objective || step.title, ...(parent.profileId ? { profileId: parent.profileId } : {}), coordinationId: coordination.coordinationId, parentTaskId: parent.taskId, coordinationDepth: (parent.coordinationDepth ?? 0) + 1 });
      return { executionId: child.taskId, status: child.status === 'completed' ? 'completed' : child.status === 'failed' ? 'failed' : child.status === 'cancelled' ? 'cancelled' : 'running' };
    },
    async cancelStep(scope, step) { mate(scope); if (step.result_ref?.startsWith('mate-task-')) await deps.cancelTask(scope.ownerId, step.result_ref); },
    async readExecution(scope, step): Promise<ExecutionSnapshot | null> { mate(scope); if (!step.result_ref?.startsWith('mate-task-')) return null; const task = await readTask(scope.ownerId, step.result_ref); if (!task) return null; return { executionId: task.taskId, status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : task.status === 'queued' ? 'queued' : 'running' }; },
  };
}
