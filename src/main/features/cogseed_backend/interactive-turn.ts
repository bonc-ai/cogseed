import type { CogSeedRuntimeController } from './runtime-controller';
import {
  buildCogSeedAgentRuntimeContext,
  resolveCogSeedAgentExecutionContext,
  type CogSeedAgentExecutionContext,
} from './agent-execution-context';
import { getOrCreateCogSeedAgentSession } from './session-store';
import { isRuntimeOwnedCogSeedTask, readLatestCogSeedTaskForAgent } from './task-store';
import {
  CogSeedFollowupNotRuntimeOwnedError,
  isCogSeedGroupChatTaskAdmissionError,
} from './followup-errors';
import { assertCogSeedAgentId, assertCogSeedConversationId, assertCogSeedRequestId, assertCogSeedUserId } from './paths';
import type { CogSeedTaskRecord } from './types';

const MAX_VISIBLE_CONTEXT_CHARS = 12_000;

export interface StartCogSeedInteractiveFollowupInput {
  conversationId: string;
  agentId: string;
  requestId: string;
  task: string;
  visibleContext?: string;
  groupChatRunId?: string;
  attachments?: unknown[];
  workingDir?: string;
}

export interface StartCogSeedInteractiveFollowupDeps {
  runtimeController?: Pick<CogSeedRuntimeController, 'startCogSeedTask'> & Partial<Pick<CogSeedRuntimeController, 'resumeCogSeedTask'>>;
  resolveExecutionContext?: (
    userId: string,
    agentId: string,
    conversationId: string,
  ) => Promise<CogSeedAgentExecutionContext>;
}

export async function startCogSeedInteractiveFollowup(
  userId: string,
  input: StartCogSeedInteractiveFollowupInput,
  deps: StartCogSeedInteractiveFollowupDeps = {},
): Promise<CogSeedTaskRecord> {
  assertCogSeedUserId(userId);
  const conversationId = assertCogSeedConversationId(input.conversationId);
  const agentId = assertCogSeedAgentId(input.agentId);
  const requestId = assertCogSeedRequestId(input.requestId);
  const task = String(input.task || '').trim();
  if (!task) throw new Error('CogSeed follow-up task is required');
  const session = await getOrCreateCogSeedAgentSession(userId, conversationId, agentId);
  const parent = await readLatestCogSeedTaskForAgent(userId, conversationId, agentId);
  // Owner principle: the executor that produced the asking turn continues it.
  // A Group Chat projection task shares the task schema but is executed by the
  // Group Chat bus; resuming it from the Runtime would be refused downstream
  // and turn a valid answer into a failed turn. Signal the caller to dispatch
  // through Group Chat instead (the bus falls back to its normal path).
  if (parent && !isRuntimeOwnedCogSeedTask(parent)) {
    throw new CogSeedFollowupNotRuntimeOwnedError('group-chat-owned', parent.taskId);
  }
  const resolveContext = deps.resolveExecutionContext ?? resolveCogSeedAgentExecutionContext;
  const executionContext = await resolveContext(userId, agentId, conversationId);
  const workingDir = input.workingDir || parent?.workingDir
    || await (await import('../group_chat/conv_workspace')).getConversationWorkspacePath(userId, conversationId);
  const context: unknown[] = [...buildCogSeedAgentRuntimeContext(executionContext)];
  const visibleContext = String(input.visibleContext || '').trim();
  if (visibleContext) {
    context.push({
      type: 'text',
      label: 'Visible Group Chat context',
      content: visibleContext.slice(0, MAX_VISIBLE_CONTEXT_CHARS),
    });
  }
  const controller = deps.runtimeController ?? (await import('./runtime-controller')).cogseedRuntimeController;
  if (parent && ['waiting_user', 'recoverable'].includes(parent.status) && controller.resumeCogSeedTask) {
    try {
      return await controller.resumeCogSeedTask(userId, parent.taskId, {
        requestId, continuation: task, context,
        ...(input.groupChatRunId ? { groupChatRunId: input.groupChatRunId } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        workingDir,
      });
    } catch (error) {
      // Defence in depth: the pre-check above covers today's data shape; a
      // concurrent task transition could still surface the Runtime refusal.
      // Translate it into the same "let Group Chat own this" signal instead of
      // failing the user's answer.
      if (isCogSeedGroupChatTaskAdmissionError(error)) {
        throw new CogSeedFollowupNotRuntimeOwnedError('group-chat-owned', parent.taskId);
      }
      throw error;
    }
  }
  // 执行后端判定与 wake-dispatcher 对齐：runtime.kind 归一后外接智能体一律
  // 'p3394-gateway'（legacy 'cli' 兼容）——只认 'cli' 会把网关型智能体误判
  // 成 cogseed-native 由内置模型代答（CLI 从未被调用：模型/强度控制全部
  // 无效，回复口径也与真实 CLI 不符）。
  const rt = executionContext.runtime as {
    kind?: string; cli?: string; model?: string;
    custom_args?: string[]; cli_provider_id?: string;
  };
  const isLocalCli = rt.kind === 'cli' || rt.kind === 'p3394-gateway';
  return controller.startCogSeedTask(userId, {
    requestId,
    task,
    conversationId,
    agentId,
    sessionId: session.sessionId,
    ...(input.groupChatRunId ? { groupChatRunId: input.groupChatRunId } : {}),
    ...(parent ? { parentTaskId: parent.taskId } : {}),
    executionKind: isLocalCli ? 'local-cli' : 'cogseed-native',
    ...(isLocalCli ? {
      localCli: {
        cli: rt.cli,
        agentName: executionContext.agentName,
        ...(rt.model ? { model: rt.model } : {}),
        ...(rt.custom_args?.length ? { customArgs: rt.custom_args } : {}),
        ...(rt.cli_provider_id ? { cliProviderId: rt.cli_provider_id } : {}),
        // 网关型外接智能体：与 wake/对话派发同一条托管 gateway 执行路径。
        ...(rt.kind === 'p3394-gateway' ? { viaP3394Gateway: true } : {}),
      },
    } : {}),
    ...(executionContext.skillList !== undefined ? { allowedSkillIds: executionContext.skillList } : {}),
    context,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    workingDir,
  });
}
