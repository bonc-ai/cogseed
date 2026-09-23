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

    // A Wake decision can arrive long after the original dispatch was staged.
    // Re-read the durable collaboration ledger before resolving execution
    // context, prewarming a gateway, or starting any task. Stop/removal must
    // remain sticky across process restarts; explicit retry is the only path
    // allowed to put the actor back into pending.
    const runIdForLedger = request.dispatch_payload.run_id;
    if (runIdForLedger) {
      const { readRun, recordRunDispatch } = await import('../group_chat/run_store');
      const run = await readRun(userId, request.conversation_id, runIdForLedger);
      if (!run) throw new Error(`collaboration run unavailable: ${runIdForLedger}`);
      const actor = run?.actors.find((entry) => entry.agent_id === request.agent_id);
      // 没有 actor 行 ≠ 已停止：Commander 对一个「快照里没有成员/点名」的 run
      // 发起 dispatch 时（例如用户手打 @名字，那只是正文），这条 Wake 是第一
      // 次批准，actor 行本来就还不存在。recordRunDispatch 才是耐久准入的
      // chokepoint，并且它自己会补建 actor 行、也会拒绝 stopped/removed。
      // 因此这里只拦「已存在且非 pending 的行」与「run 不是 running」，
      // 否则一次合法批准会永远无法通过。
      // 两种情况分开报：run 自己不是 running，和「这个 actor 已经是终态」
      // 是完全不同的处置（前者重试，后者只能拒绝/换人）。混成一句 “stopped”
      // 会把排查带偏——真机上就出现过 run 仍然 running、actor 已 failed 的
      // 场景被报成 “collaboration run stopped”。
      if (run.status !== 'running') {
        throw new Error(`collaboration run ${run.status}: ${runIdForLedger}`);
      }
      if (actor && actor.terminal !== 'pending') {
        throw new Error(
          `collaboration run actor already terminal (${actor.terminal}): ${runIdForLedger}`,
        );
      }
      const dispatchTurnId = `turn-wake-${request.id}`;
      const recorded = await recordRunDispatch(
        userId,
        request.conversation_id,
        runIdForLedger,
        request.agent_id,
        dispatchTurnId,
      );
      const recordedActor = recorded?.actors.find((entry) => entry.agent_id === request.agent_id);
      if (recorded?.status !== 'running'
        || recordedActor?.terminal !== 'pending'
        || !recordedActor.dispatched.includes(dispatchTurnId)) {
        throw new Error(`collaboration dispatch persistence failed: ${runIdForLedger}`);
      }
    }

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
      const workingDir = localCli
        ? await (await import('./local-cli-execution-adapter')).resolveCogSeedLocalCliWorkingDir({
            userId,
            conversationId: request.conversation_id,
            agentId: request.agent_id,
          })
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
        ...(request.dispatch_payload.run_id
          ? { groupChatRunId: request.dispatch_payload.run_id }
          : {}),
        ...(localCli ? { localCli } : {}),
        ...(executionContext.skillList !== undefined ? { allowedSkillIds: executionContext.skillList } : {}),
        // Restore ability assets granted before the wake approval (commander
        // dispatch). This supplements the confession snapshot path already
        // persisted on the request.
        ...(request.dispatch_payload.asset_ids?.length
          ? { abilityAssetIds: request.dispatch_payload.asset_ids }
          : {}),
        ...(workingDir ? { workingDir } : {}),
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
