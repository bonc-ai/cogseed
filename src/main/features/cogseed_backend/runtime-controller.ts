import {
  cogseedAgentRuntime,
  type CogSeedAgentRuntimeFacade,
  type CogSeedAgentRuntimeInput,
} from '../cogseed_runtime';
import type { RuntimeEventEnvelope } from '../cogseed_runtime/protocol';
import { genId12 } from '../../storage';
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { appendCogSeedTaskEvent } from './event-store';
import { markCogSeedTaskRecoverable, retryCogSeedTask as retryStoredCogSeedTask, transitionCogSeedTask } from './lifecycle';
import { createCogSeedTask, listCogSeedTasks, readCogSeedTask, updateCogSeedTask } from './task-store';
import { resolveRuntimeCapabilities } from './messaging-capability-policy';
import { buildRuntimeAssetContext } from './runtime-asset-context';
import { readCogSeedSession } from './session-store';
import type { CogSeedTaskRecord } from './types';
import type { CogSeedGroupChatProjectionInput, CogSeedProjectionEvent } from './group-chat-projection';
import type { CogSeedLocalCliExecutionAdapter } from './local-cli-execution-adapter';
import type { CogSeedLocalCliConfig } from './types';

const log = createLogger('cogseed-backend:runtime-controller');

export interface StartCogSeedTaskInput {
  requestId: string;
  task: string;
  /** Product Agent identity passed to Runtime tools; never use this as a model profile id. */
  agentId?: string;
  conversationId?: string;
  executionKind?: 'cogseed-native' | 'local-cli';
  allowedSkillIds?: string[];
  skillVersionPins?: import('./types').CogSeedTaskSkillVersionPin[];
  localCli?: CogSeedLocalCliConfig;
  sessionId?: string;
  profileId?: string;
  context?: unknown[];
  attachments?: unknown[];
  workingDir?: string;
  coordinationId?: string;
  parentTaskId?: string;
  coordinationDepth?: number;
  /** Trusted host capabilities derived from the persisted task/session (e.g.
   * `messaging.proactive`). Set by the controller from
   * `resolveRuntimeCapabilities`; never accepted from external callers. */
  capabilities?: string[];
}

export interface ResumeCogSeedTaskInput {
  requestId: string;
  continuation: string;
  profileId?: string;
  context?: unknown[];
  attachments?: unknown[];
  workingDir?: string;
  coordinationId?: string;
  parentTaskId?: string;
  coordinationDepth?: number;
}

export interface CogSeedRuntimeStatus {
  backend: 'cogseed';
  activeTaskCount: number;
  activeTaskIds: string[];
}

export interface CogSeedRuntimeController {
  startCogSeedTask(userId: string, input: StartCogSeedTaskInput): Promise<CogSeedTaskRecord>;
  retryCogSeedTask(userId: string, taskId: string, requestId: string): Promise<CogSeedTaskRecord>;
  resumeCogSeedTask(userId: string, taskId: string, input: ResumeCogSeedTaskInput): Promise<CogSeedTaskRecord>;
  cancelCogSeedTask(userId: string, taskId: string): Promise<CogSeedTaskRecord>;
  cancelConversationTasks(userId: string, conversationId: string): Promise<CogSeedTaskRecord[]>;
  runtimeStatus(): Promise<CogSeedRuntimeStatus>;
  restartRuntime(): Promise<{ restarted: true }>;
}

export interface CogSeedRuntimeControllerOptions {
  runtime?: CogSeedAgentRuntimeFacade;
  cancelChildrenForParent?: (userId: string, parentTaskId: string) => Promise<void>;
  projectTaskEvent?: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>;
  localCliAdapter?: CogSeedLocalCliExecutionAdapter;
}

function asRuntimeInput(input: StartCogSeedTaskInput & { runtimeSessionId?: string; capabilities?: string[] }): CogSeedAgentRuntimeInput {
  return {
    task: input.task,
    request_id: input.requestId,
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    ...(input.executionKind ? { execution_kind: input.executionKind } : {}),
    ...(input.allowedSkillIds !== undefined ? { allowed_skill_ids: input.allowedSkillIds } : {}),
    ...(input.skillVersionPins !== undefined ? { skill_version_pins: input.skillVersionPins } : {}),
    ...(input.runtimeSessionId ? { runtime_session_id: input.runtimeSessionId } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.profileId ? { model_profile: input.profileId } : {}),
    ...(input.workingDir ? { working_dir: input.workingDir } : {}),
    ...(input.capabilities?.length ? { capabilities: input.capabilities } : {}),
  };
}

function terminal(task: CogSeedTaskRecord): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

/**
 * Resolve the conversation binding for a CogSeed task, preferring the explicit
 * input field and falling back to the persisted CogSeed session record. Returns
 * undefined when neither source carries a conversation — in that case the
 * runtime task runs without recall asset injection (soft degradation).
 */
async function resolveConversationIdForTask(
  userId: string,
  task: CogSeedTaskRecord,
  input: StartCogSeedTaskInput,
): Promise<string | undefined> {
  if (input.conversationId) return input.conversationId;
  try {
    const session = await readCogSeedSession(userId, task.sessionId);
    return session?.conversationId || undefined;
  } catch {
    return undefined;
  }
}

async function linkKstarTask(userId: string, conversationId: string | undefined, cogseedTaskId: string): Promise<void> {
  if (!conversationId) return;
  try {
    const lifecycle = await (await import('../kstar/lifecycle-adapter')).readKstarTaskLifecycle(userId, conversationId);
    const task = lifecycle.task;
    if (!task || task.conversationId !== conversationId) return;
    const kstar = await import('../kstar/requirement-store');
    if (task.cogseedTaskId !== cogseedTaskId) {
      await kstar.replaceKstarTask(userId, { ...task, cogseedTaskId, updatedAt: new Date().toISOString() });
    }
    await updateCogSeedTask(userId, cogseedTaskId, (current) => ({
      ...current,
      kstarTaskId: task.id,
      ...(lifecycle.requirement?.id ? { kstarRequirementId: lifecycle.requirement.id } : {}),
      ...(lifecycle.projection?.id ? { kstarProjectionId: lifecycle.projection.id } : {}),
      ...(lifecycle.requirement?.forecastId ? { kstarForecastId: lifecycle.requirement.forecastId } : {}),
      updatedAt: new Date().toISOString(),
    }));
  } catch (error) {
    log.warn('KSTAR/CogSeed task bridge degraded', { taskId: cogseedTaskId, error: logErrorRef(error) });
  }
}

async function projectTaskEventBestEffort(
  userId: string,
  task: CogSeedTaskRecord,
  event: CogSeedProjectionEvent,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
): Promise<void> {
  if (!task.conversationId || !task.agentId) return;
  try {
    await projectTaskEvent({
      userId,
      conversationId: task.conversationId,
      agentId: task.agentId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      event,
    });
  } catch (error) {
    log.warn('CogSeed Runtime event projection failed', { error: logErrorRef(error) });
  }
}

async function mapRuntimeEvent(
  userId: string,
  task: CogSeedTaskRecord,
  event: RuntimeEventEnvelope,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
): Promise<CogSeedTaskRecord> {
  const latest = await readCogSeedTask(userId, task.taskId);
  const runtimeRunId = typeof event.metadata?.runtime_run_id === 'string' ? event.metadata.runtime_run_id : undefined;
  if (runtimeRunId && latest && latest.runtimeRunId !== runtimeRunId) {
    await updateCogSeedTask(userId, task.taskId, (current) => ({ ...current, runtimeRunId }));
  }
  if (latest && terminal(latest)) return latest;
  if (event.type === 'result' && event.status === 'completed') {
    const completed = await transitionCogSeedTask(userId, task.taskId, 'completed', { outputChars: String(event.text || '').length });
    await projectTaskEventBestEffort(userId, completed, {
      eventId: `cogseed-event-terminal-${task.taskId}`,
      type: 'task.completed',
      payload: { text: String(event.text || '') },
    }, projectTaskEvent);
    return completed;
  }
  if (event.type === 'error' && event.status === 'cancelled') {
    const cancelled = await transitionCogSeedTask(userId, task.taskId, 'cancelled', {});
    await projectTaskEventBestEffort(userId, cancelled, {
      eventId: `cogseed-event-terminal-${task.taskId}`,
      type: 'task.cancelled',
      payload: {},
    }, projectTaskEvent);
    return cancelled;
  }
  if (event.type === 'error' && event.status === 'failed') {
    const failed = await transitionCogSeedTask(userId, task.taskId, 'failed', { errorCode: 'runtime_failed' });
    await projectTaskEventBestEffort(userId, failed, {
      eventId: `cogseed-event-terminal-${task.taskId}`,
      type: 'task.failed',
      payload: {},
    }, projectTaskEvent);
    return failed;
  }
  if (event.type === 'event' && event.status === 'running') {
    const kernelEvent = event.metadata?.kernel_event;
    if (kernelEvent === 'tool_call') {
      const stored = await appendCogSeedTaskEvent(userId, task.taskId, task.sessionId, 'tool.started', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
      });
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (kernelEvent === 'tool_result') {
      const stored = await appendCogSeedTaskEvent(userId, task.taskId, task.sessionId, 'tool.finished', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
        ...(typeof event.metadata?.isError === 'boolean' ? { isError: event.metadata.isError } : {}),
      });
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (kernelEvent === 'artifact') {
      const artifact: Record<string, unknown> = {};
      for (const key of ['uri', 'digest', 'name', 'media_type'] as const) {
        if (typeof event.metadata?.[key] === 'string') artifact[key] = event.metadata[key];
      }
      const stored = await appendCogSeedTaskEvent(userId, task.taskId, task.sessionId, 'artifact', artifact);
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (event.text) {
      const stored = await appendCogSeedTaskEvent(userId, task.taskId, task.sessionId, 'model.delta', { text: event.text });
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    }
  }
  return (await readCogSeedTask(userId, task.taskId)) ?? task;
}

export function createCogSeedRuntimeController(options: CogSeedRuntimeControllerOptions = {}): CogSeedRuntimeController {
  const runtime = options.runtime ?? cogseedAgentRuntime;
  const activeRuns = new Map<string, AbortController>();
  const runtimeWorkerId = 'cogseed-worker-' + genId12();
  const resumeClaims = new Set<string>();
  const projectTaskEvent = options.projectTaskEvent ?? (async (input) => {
    const { cogseedGroupChatProjection } = await import('./group-chat-projection');
    return cogseedGroupChatProjection.project(input);
  });
  let defaultLocalCliAdapter: CogSeedLocalCliExecutionAdapter | null = null;
  const localCliAdapter = async (): Promise<CogSeedLocalCliExecutionAdapter> => {
    if (options.localCliAdapter) return options.localCliAdapter;
    if (!defaultLocalCliAdapter) {
      defaultLocalCliAdapter = (await import('./local-cli-execution-adapter')).cogseedLocalCliExecutionAdapter;
    }
    return defaultLocalCliAdapter;
  };

  async function consumeRuntime(userId: string, task: CogSeedTaskRecord, input: StartCogSeedTaskInput & { runtimeSessionId?: string }, controller: AbortController): Promise<void> {
    let current = task;
    try {
      const stream = task.executionKind === 'local-cli'
        ? (await localCliAdapter()).run({
            userId,
            conversationId: task.conversationId!,
            agentId: task.agentId!,
            agentName: task.localCli?.agentName,
            requestId: input.requestId,
            taskId: task.taskId,
            sessionId: task.sessionId,
            runtimeSessionId: task.runtimeSessionId,
            task: input.task,
            context: input.context,
            attachments: input.attachments,
            workingDir: input.workingDir,
            localCli: task.localCli!,
          }, { signal: controller.signal })
        : runtime.run(userId, asRuntimeInput(input), { signal: controller.signal });
      for await (const event of stream) {
        current = await mapRuntimeEvent(userId, current, event, projectTaskEvent);
        if (terminal(current)) break;
      }
    } catch {
      const latest = await readCogSeedTask(userId, task.taskId);
      if (latest && !terminal(latest)) {
        const recoverable = await markCogSeedTaskRecoverable(userId, task.taskId, 'runtime_worker_error');
        await projectTaskEventBestEffort(userId, recoverable, {
          eventId: `cogseed-event-recoverable-${task.taskId}`,
          type: 'task.recoverable',
          payload: {},
        }, projectTaskEvent);
      }
    } finally {
      activeRuns.delete(task.taskId);
      resumeClaims.delete(task.taskId);
    }
  }

  async function launchTask(userId: string, initial: CogSeedTaskRecord, input: StartCogSeedTaskInput & { runtimeSessionId?: string }): Promise<CogSeedTaskRecord> {
    let task = initial;
    if (!task.runtimeWorkerId) task = await updateCogSeedTask(userId, task.taskId, (current) => ({ ...current, runtimeWorkerId }));
    if (task.status === 'created' || task.status === 'recoverable') {
      task = await transitionCogSeedTask(userId, task.taskId, 'queued');
    }
    if (task.status === 'queued') {
      task = await transitionCogSeedTask(userId, task.taskId, 'running');
      await projectTaskEventBestEffort(userId, task, {
        eventId: `cogseed-event-started-${task.taskId}`,
        type: 'task.started',
        payload: {},
      }, projectTaskEvent);
    }
    const controller = new AbortController();
    activeRuns.set(task.taskId, controller);
    setImmediate(() => { void consumeRuntime(userId, task, input, controller); });
    return task;
  }

  async function cancelTask(userId: string, taskId: string): Promise<CogSeedTaskRecord> {
    const task = await readCogSeedTask(userId, taskId);
    if (!task) throw new Error('CogSeed task not found');
    if (terminal(task)) return task;
    const cancelled = await transitionCogSeedTask(userId, taskId, 'cancelled', {});
    await projectTaskEventBestEffort(userId, cancelled, {
      eventId: `cogseed-event-terminal-${taskId}`,
      type: 'task.cancelled',
      payload: {},
    }, projectTaskEvent);
    activeRuns.get(taskId)?.abort();
    try { await options.cancelChildrenForParent?.(userId, taskId); }
    catch (error) { log.warn('CogSeed child cancellation cleanup failed', { error: logErrorRef(error) }); }
    return cancelled;
  }

  return {
    async startCogSeedTask(userId, input) {
      const created = await createCogSeedTask(userId, input);
      if (!created.created) return created.task;
      const conversationId = await resolveConversationIdForTask(userId, created.task, input);
      await linkKstarTask(userId, conversationId, created.task.taskId);
      const capabilities = await resolveRuntimeCapabilities(userId, created.task.requestId, created.task.runtimeSessionId);
      const launchInput: StartCogSeedTaskInput & { runtimeSessionId?: string } = { ...input, capabilities };
      if (conversationId) {
        const assetContext = await buildRuntimeAssetContext(userId, conversationId);
        if (assetContext.length) {
          launchInput.context = [...(input.context ?? []), ...assetContext];
        }
      }
      return launchTask(userId, created.task, launchInput);
    },

    async retryCogSeedTask(userId, taskId, requestId) {
      const retried = await retryStoredCogSeedTask(userId, taskId, requestId);
      if (retried.status !== 'created') return retried;
      const capabilities = await resolveRuntimeCapabilities(userId, retried.requestId, retried.runtimeSessionId);
      const retryInput: StartCogSeedTaskInput & { runtimeSessionId?: string } = {
        requestId,
        task: retried.task,
        ...(retried.agentId ? { agentId: retried.agentId } : {}),
        ...(retried.conversationId ? { conversationId: retried.conversationId } : {}),
        ...(retried.executionKind ? { executionKind: retried.executionKind } : {}),
        ...(retried.allowedSkillIds !== undefined ? { allowedSkillIds: retried.allowedSkillIds } : {}),
        ...(retried.skillVersionPins !== undefined ? { skillVersionPins: retried.skillVersionPins } : {}),
        ...(retried.localCli ? { localCli: retried.localCli } : {}),
        ...(retried.profileId ? { profileId: retried.profileId } : {}),
        capabilities,
      };
      // 重试和首次执行必须拿到同一批已确认资产。漏了这一段，同一个任务第一次
      // 带认知资产、重试后反而没有——用户会以为资产失效了。start/resume 都注入。
      const retryConversationId = await resolveConversationIdForTask(userId, retried, retryInput);
      if (retryConversationId) {
        const assetContext = await buildRuntimeAssetContext(userId, retryConversationId);
        if (assetContext.length) {
          retryInput.context = [...(retryInput.context ?? []), ...assetContext];
        }
      }
      return launchTask(userId, retried, retryInput);
    },

    async resumeCogSeedTask(userId, taskId, input) {
      const current = await readCogSeedTask(userId, taskId);
      if (!current) throw new Error('CogSeed task not found');
      if (current.status === 'completed' || current.status === 'cancelled') return current;
      if (current.status !== 'recoverable') throw new Error('CogSeed task is not resumable');
      const continuation = input.continuation.trim();
      if (!continuation) throw new Error('CogSeed continuation is required');
      if (resumeClaims.has(taskId)) return current;
      resumeClaims.add(taskId);
      try {
        const reserved = await updateCogSeedTask(userId, taskId, (task) => {
          if (task.status !== 'recoverable') throw new Error('CogSeed task is not resumable');
          if (task.lastResumeRequestId === input.requestId) return task;
          return { ...task, lastResumeRequestId: input.requestId };
        });
        const resumeInput: StartCogSeedTaskInput & { runtimeSessionId?: string } = {
          requestId: input.requestId,
          task: continuation,
          runtimeSessionId: reserved.runtimeSessionId,
          ...(reserved.agentId ? { agentId: reserved.agentId } : {}),
          ...(reserved.conversationId ? { conversationId: reserved.conversationId } : {}),
          ...(reserved.executionKind ? { executionKind: reserved.executionKind } : {}),
          ...(reserved.allowedSkillIds !== undefined ? { allowedSkillIds: reserved.allowedSkillIds } : {}),
          ...(reserved.skillVersionPins !== undefined ? { skillVersionPins: reserved.skillVersionPins } : {}),
          ...(reserved.localCli ? { localCli: reserved.localCli } : {}),
          ...(input.profileId || reserved.profileId ? { profileId: input.profileId || reserved.profileId } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.workingDir ? { workingDir: input.workingDir } : {}),
          capabilities: await resolveRuntimeCapabilities(userId, input.requestId, reserved.runtimeSessionId),
        };
        const conversationId = await resolveConversationIdForTask(userId, reserved, resumeInput);
        if (conversationId) {
          const assetContext = await buildRuntimeAssetContext(userId, conversationId);
          if (assetContext.length) {
            resumeInput.context = [...(resumeInput.context ?? []), ...assetContext];
          }
        }
        return launchTask(userId, reserved, resumeInput);
      } catch (error) {
        resumeClaims.delete(taskId);
        throw error;
      }
    },

    async cancelCogSeedTask(userId, taskId) {
      return cancelTask(userId, taskId);
    },

    async cancelConversationTasks(userId, conversationId) {
      const active = (await listCogSeedTasks(userId)).filter((task) => (
        task.conversationId === conversationId && !terminal(task)
      ));
      const cancelled: CogSeedTaskRecord[] = [];
      for (const task of active) cancelled.push(await cancelTask(userId, task.taskId));
      return cancelled;
    },

    async runtimeStatus() {
      return { backend: 'cogseed', activeTaskCount: activeRuns.size, activeTaskIds: Array.from(activeRuns.keys()) };
    },

    async restartRuntime() {
      for (const signal of activeRuns.values()) signal.abort();
      await runtime.shutdown();
      return { restarted: true as const };
    },
  };
}


export const cogseedRuntimeController: CogSeedRuntimeController = (() => {
  let controller: CogSeedRuntimeController;
  controller = createCogSeedRuntimeController({
    cancelChildrenForParent: async (userId, parentTaskId) => {
      const { createCogSeedCoordinator } = await import('./coordinator');
      const coordinator = createCogSeedCoordinator({
        startTask: (uid, input) => controller.startCogSeedTask(uid, input),
        cancelTask: (uid, taskId) => controller.cancelCogSeedTask(uid, taskId),
      });
      await coordinator.cancelChildrenForParent(userId, parentTaskId);
    },
  });
  return controller;
})();
