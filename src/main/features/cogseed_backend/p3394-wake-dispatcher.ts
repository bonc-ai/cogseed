import { createCollaborationEngine } from '../collaboration_control/engine';
import { createMateCollaborationStore } from './collaboration-store-adapter';
import { createMateCollaborationDispatcher } from './collaboration-dispatcher';
import { mateRuntimeController } from './runtime-controller';
import { readMateCoordination } from './coordinator';
import type { WakeDispatcher } from '../p3394/wake-dispatcher';

export const mateWakeDispatcher: WakeDispatcher = {
  async dispatch(userId, request) {
    const coordinationId = request.execution_scope_id || request.conversation_id;
    const coordination = await readMateCoordination(userId, coordinationId); if (!coordination?.workflowRunId || !request.workflow_step_id) throw new Error('Mate wake request is not bound to a workflow step');
    const dispatcher = createMateCollaborationDispatcher({ startTask: (uid, input) => mateRuntimeController.startMateTask(uid, input), cancelTask: (uid, taskId) => mateRuntimeController.cancelMateTask(uid, taskId) });
    const engine = createCollaborationEngine({ store: createMateCollaborationStore(), dispatcher });
    await engine.startStep({ ownerId: userId, domain: 'mate', scopeId: coordinationId }, coordination.workflowRunId, request.workflow_step_id);
  },
};
