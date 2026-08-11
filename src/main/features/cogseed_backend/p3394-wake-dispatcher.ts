import { createCollaborationEngine } from '../collaboration_control/engine';
import { createMateCollaborationStore } from './collaboration-store-adapter';
import { createMateCollaborationDispatcher } from './collaboration-dispatcher';
import { readMateCoordination } from './coordinator';
import type { WakeDispatcher } from '../p3394/wake-dispatcher';
import type { AgentWakeRequest } from '../p3394/types';

function taskText(request: AgentWakeRequest): string {
  return request.dispatch_payload.model_text?.trim() || request.dispatch_payload.text;
}

/**
 * The only P3394 wake dispatcher. Group Chat is an entry/event surface; both
 * direct and workflow-bound wakes enter the CogSeed backend here.
 */
export const mateWakeDispatcher: WakeDispatcher = {
  async dispatch(userId, request) {
    const runtime = (await import('./runtime-controller')).mateRuntimeController;

    if (!request.workflow_step_id) {
      const task = await runtime.startMateTask(userId, {
        requestId: `req-wake-${request.id}`,
        task: taskText(request),
        sessionId: `gconv-${request.conversation_id}`,
        profileId: request.agent_id,
        ...(request.dispatch_payload.attachments?.length ? { attachments: request.dispatch_payload.attachments } : {}),
      });
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new Error(`CogSeed wake task ${task.status}`);
      }
      return;
    }

    const coordinationId = request.execution_scope_id || request.conversation_id;
    const coordination = await readMateCoordination(userId, coordinationId);
    if (!coordination?.workflowRunId) throw new Error('CogSeed wake request is not bound to a workflow');
    const dispatcher = createMateCollaborationDispatcher({
      startTask: (uid, input) => runtime.startMateTask(uid, input),
      cancelTask: (uid, taskId) => runtime.cancelMateTask(uid, taskId),
    });
    const engine = createCollaborationEngine({ store: createMateCollaborationStore(), dispatcher });
    await engine.startStep({ ownerId: userId, domain: 'mate', scopeId: coordinationId }, coordination.workflowRunId, request.workflow_step_id);
  },
};
