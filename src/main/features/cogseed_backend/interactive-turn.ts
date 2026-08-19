import type { CogSeedRuntimeController } from './runtime-controller';
import {
  buildCogSeedAgentRuntimeContext,
  resolveCogSeedAgentExecutionContext,
  type CogSeedAgentExecutionContext,
} from './agent-execution-context';
import { getOrCreateCogSeedAgentSession } from './session-store';
import { readLatestCogSeedTaskForAgent } from './task-store';
import { assertCogSeedAgentId, assertCogSeedConversationId, assertCogSeedRequestId, assertCogSeedUserId } from './paths';
import type { CogSeedTaskRecord } from './types';

const MAX_VISIBLE_CONTEXT_CHARS = 12_000;

export interface StartCogSeedInteractiveFollowupInput {
  conversationId: string;
  agentId: string;
  requestId: string;
  task: string;
  visibleContext?: string;
  attachments?: unknown[];
  workingDir?: string;
}

export interface StartCogSeedInteractiveFollowupDeps {
  runtimeController?: Pick<CogSeedRuntimeController, 'startCogSeedTask'>;
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
  const resolveContext = deps.resolveExecutionContext ?? resolveCogSeedAgentExecutionContext;
  const executionContext = await resolveContext(userId, agentId, conversationId);
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
  return controller.startCogSeedTask(userId, {
    requestId,
    task,
    conversationId,
    agentId,
    sessionId: session.sessionId,
    ...(parent ? { parentTaskId: parent.taskId } : {}),
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
    context,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.workingDir ? { workingDir: input.workingDir } : {}),
  });
}
