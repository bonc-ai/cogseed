import { createCollaborationEngine } from '../collaboration_control/engine';
import { createMateCollaborationStore } from './collaboration-store-adapter';
import { createMateCollaborationDispatcher } from './collaboration-dispatcher';
import { readMateCoordination } from './coordinator';
import type { WakeDispatcher } from '../p3394/wake-dispatcher';
import type { AgentWakeRequest } from '../p3394/types';
import {
  buildCogSeedAgentRuntimeContext,
  resolveCogSeedAgentExecutionContext,
} from './agent-execution-context';

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

    const startDirectTask = async () => {
      const executionContext = await resolveCogSeedAgentExecutionContext(
        userId,
        request.agent_id,
        request.conversation_id,
      );
      const task = await runtime.startMateTask(userId, {
        requestId: `req-wake-${request.id}`,
        task: taskText(request),
        sessionId: `gconv-${request.conversation_id}`,
        agentId: request.agent_id,
        conversationId: request.conversation_id,
        executionKind: executionContext.runtime.kind === 'cli' ? 'local-cli' : 'cogseed-native',
        ...(executionContext.runtime.kind === 'cli' ? {
          localCli: {
            cli: executionContext.runtime.cli,
            agentName: executionContext.agentName,
            ...(executionContext.runtime.model ? { model: executionContext.runtime.model } : {}),
            ...(executionContext.runtime.custom_args?.length ? { customArgs: executionContext.runtime.custom_args } : {}),
            ...(executionContext.runtime.cli_provider_id ? { cliProviderId: executionContext.runtime.cli_provider_id } : {}),
          },
        } : {}),
        ...(executionContext.skillList !== undefined ? { allowedSkillIds: executionContext.skillList } : {}),
        context: buildCogSeedAgentRuntimeContext(executionContext),
        ...(request.dispatch_payload.attachments?.length ? { attachments: request.dispatch_payload.attachments } : {}),
      });
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new Error(`CogSeed wake task ${task.status}`);
      }
    };

    // Legacy Group Chat handoffs may carry a workflow_step_id while their
    // scope is still a conversation id. Only a real CogSeed coordination can
    // enter the workflow dispatcher; otherwise preserve the interactive
    // handoff by starting a direct CogSeed task.
    const coordinationId = request.execution_scope_id;
    if (!request.workflow_step_id || !coordinationId?.startsWith('mate-coord-')) {
      await startDirectTask();
      return;
    }

    const coordination = await readMateCoordination(userId, coordinationId);
    if (!coordination?.workflowRunId) {
      await startDirectTask();
      return;
    }
    const dispatcher = createMateCollaborationDispatcher({
      startTask: (uid, input) => runtime.startMateTask(uid, input),
      cancelTask: (uid, taskId) => runtime.cancelMateTask(uid, taskId),
    });
    const engine = createCollaborationEngine({ store: createMateCollaborationStore(), dispatcher });
    await engine.startStep({ ownerId: userId, domain: 'mate', scopeId: coordinationId }, coordination.workflowRunId, request.workflow_step_id);
  },
};
