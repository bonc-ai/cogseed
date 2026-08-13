import type { MateRuntimeController } from './runtime-controller';
import {
  buildCogSeedAgentRuntimeContext,
  resolveCogSeedAgentExecutionContext,
  type CogSeedAgentExecutionContext,
} from './agent-execution-context';
import { getOrCreateMateAgentSession } from './session-store';
import { readLatestMateTaskForAgent } from './task-store';
import { assertMateAgentId, assertMateConversationId, assertMateRequestId, assertMateUserId } from './paths';
import type { MateTaskRecord } from './types';

const MAX_VISIBLE_CONTEXT_CHARS = 12_000;

export interface StartMateInteractiveFollowupInput {
  conversationId: string;
  agentId: string;
  requestId: string;
  task: string;
  visibleContext?: string;
  attachments?: unknown[];
  workingDir?: string;
}

export interface StartMateInteractiveFollowupDeps {
  runtimeController?: Pick<MateRuntimeController, 'startMateTask'>;
  resolveExecutionContext?: (
    userId: string,
    agentId: string,
    conversationId: string,
  ) => Promise<CogSeedAgentExecutionContext>;
}

export async function startMateInteractiveFollowup(
  userId: string,
  input: StartMateInteractiveFollowupInput,
  deps: StartMateInteractiveFollowupDeps = {},
): Promise<MateTaskRecord> {
  assertMateUserId(userId);
  const conversationId = assertMateConversationId(input.conversationId);
  const agentId = assertMateAgentId(input.agentId);
  const requestId = assertMateRequestId(input.requestId);
  const task = String(input.task || '').trim();
  if (!task) throw new Error('CogSeed follow-up task is required');
  const session = await getOrCreateMateAgentSession(userId, conversationId, agentId);
  const parent = await readLatestMateTaskForAgent(userId, conversationId, agentId);
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
  const controller = deps.runtimeController ?? (await import('./runtime-controller')).mateRuntimeController;
  return controller.startMateTask(userId, {
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
