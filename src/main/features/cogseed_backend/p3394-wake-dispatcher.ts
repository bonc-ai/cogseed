import { createCollaborationEngine } from '../collaboration_control/engine';
import { createCogSeedCollaborationStore } from './collaboration-store-adapter';
import { createCogSeedCollaborationDispatcher } from './collaboration-dispatcher';
import { readCogSeedCoordination } from './coordinator';
import type { WakeDispatcher } from '../p3394/wake-dispatcher';
import type { AgentWakeRequest } from '../p3394/types';
import type { CogSeedLocalCliConfig } from './types';
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
export const cogseedWakeDispatcher: WakeDispatcher = {
  async dispatch(userId, request) {
    const runtime = (await import('./runtime-controller')).cogseedRuntimeController;

    // 先建记录再启网关（时序修复）后，外接 agent 的 runtime.kind 是
    // 'p3394-gateway'（cli 字段携带真实 CLI 类型）。它和 'cli' 一样必须落到
    // 本地 CLI 执行（真实 spawn 本机 claude / codebuddy 等），而不是被当成
    // cogseed-native 由内置模型代答——否则 @ 外接 agent 只得到模板欢迎语，
    // 真实智能体从未收到消息。
    const startDirectTask = async () => {
      const executionContext = await resolveCogSeedAgentExecutionContext(
        userId,
        request.agent_id,
        request.conversation_id,
      );
      const agentRuntime = executionContext.runtime;
      const localCli: CogSeedLocalCliConfig | undefined = agentRuntime.kind === 'cli'
        ? {
            cli: agentRuntime.cli,
            agentName: executionContext.agentName,
            ...(agentRuntime.model ? { model: agentRuntime.model } : {}),
            ...(agentRuntime.custom_args?.length ? { customArgs: agentRuntime.custom_args } : {}),
            ...(agentRuntime.cli_provider_id ? { cliProviderId: agentRuntime.cli_provider_id } : {}),
          }
        : agentRuntime.kind === 'p3394-gateway'
          ? {
              cli: agentRuntime.cli,
              agentName: executionContext.agentName,
              ...(agentRuntime.model ? { model: agentRuntime.model } : {}),
              ...(agentRuntime.custom_args?.length ? { customArgs: agentRuntime.custom_args } : {}),
              ...(agentRuntime.cli_provider_id ? { cliProviderId: agentRuntime.cli_provider_id } : {}),
              // 统一执行路径：外接智能体的 wake 与对话分派都走托管 gateway
              // （P3394 UMF），由 local-cli-execution-adapter 的 gateway 分支执行。
              viaP3394Gateway: true,
            }
          : undefined;
      // 网关预热：外接智能体（p3394-gateway）在任务真正 sendAndWait 之前就
      // 提前拉起托管 gateway 并开始注册（prewarmExternalGateway 幂等，已运行
      // 则复用）。这会把「spawn + hello 注册等待」前移到用户批准唤醒的时刻，
      // 避免等 runP3394GatewayTurn 的 recoverGateway 在首次 send 失败后才拉起
      // ——无模型直调外接智能体时感知更快。fire-and-forget，失败由后续
      // recoverGateway 兜底，不影响派发。
      if (localCli?.viaP3394Gateway && localCli.cli) {
        try {
          const { prewarmExternalGateway } = await import('../p3394_bridge/external-gateways');
          prewarmExternalGateway({
            cli: localCli.cli,
            ...(executionContext.agentName ? { alias: executionContext.agentName } : {}),
          });
        } catch { /* 预热失败不阻塞——发送时 recoverGateway 会兜底 */ }
      }
      const task = await runtime.startCogSeedTask(userId, {
        requestId: `req-wake-${request.id}`,
        task: taskText(request),
        sessionId: `gconv-${request.conversation_id}`,
        agentId: request.agent_id,
        conversationId: request.conversation_id,
        executionKind: localCli ? 'local-cli' : 'cogseed-native',
        ...(localCli ? { localCli } : {}),
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
    if (!request.workflow_step_id || !coordinationId?.startsWith('cogseed-coord-')) {
      await startDirectTask();
      return;
    }

    const coordination = await readCogSeedCoordination(userId, coordinationId);
    if (!coordination?.workflowRunId) {
      await startDirectTask();
      return;
    }
    const dispatcher = createCogSeedCollaborationDispatcher({
      startTask: (uid, input) => runtime.startCogSeedTask(uid, input),
      cancelTask: (uid, taskId) => runtime.cancelCogSeedTask(uid, taskId),
    });
    const engine = createCollaborationEngine({ store: createCogSeedCollaborationStore(), dispatcher });
    await engine.startStep({ ownerId: userId, domain: 'cogseed', scopeId: coordinationId }, coordination.workflowRunId, request.workflow_step_id);
  },
};
