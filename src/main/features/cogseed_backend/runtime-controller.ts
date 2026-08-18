import {
  mateAgentRuntime,
  type MateAgentRuntimeFacade,
  type MateAgentRuntimeInput,
} from '../cogseed_runtime';
import type { RuntimeEventEnvelope } from '../cogseed_runtime/protocol';
import { genId12 } from '../../storage';
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { appendMateTaskEvent } from './event-store';
import { markMateTaskRecoverable, retryMateTask as retryStoredMateTask, transitionMateTask } from './lifecycle';
import { createMateTask, listMateTasks, readMateTask, updateMateTask } from './task-store';
import { resolveRuntimeCapabilities } from './messaging-capability-policy';
import { buildRuntimeAssetContext } from './runtime-asset-context';
import { readMateSession } from './session-store';
import type { MateTaskRecord } from './types';
import type { MateGroupChatProjectionInput, MateProjectionEvent } from './group-chat-projection';
import type { MateLocalCliExecutionAdapter } from './local-cli-execution-adapter';
import type { MateLocalCliConfig } from './types';

const log = createLogger('cogseed-backend:runtime-controller');

export interface StartMateTaskInput {
  requestId: string;
  task: string;
  /** Product Agent identity passed to Runtime tools; never use this as a model profile id. */
  agentId?: string;
  conversationId?: string;
  executionKind?: 'cogseed-native' | 'local-cli';
  allowedSkillIds?: string[];
  skillVersionPins?: import('./types').MateTaskSkillVersionPin[];
  localCli?: MateLocalCliConfig;
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

export interface ResumeMateTaskInput {
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

export interface MateRuntimeStatus {
  backend: 'mate';
  activeTaskCount: number;
  activeTaskIds: string[];
}

export interface MateRuntimeController {
  startMateTask(userId: string, input: StartMateTaskInput): Promise<MateTaskRecord>;
  retryMateTask(userId: string, taskId: string, requestId: string): Promise<MateTaskRecord>;
  resumeMateTask(userId: string, taskId: string, input: ResumeMateTaskInput): Promise<MateTaskRecord>;
  cancelMateTask(userId: string, taskId: string): Promise<MateTaskRecord>;
  cancelConversationTasks(userId: string, conversationId: string): Promise<MateTaskRecord[]>;
  runtimeStatus(): Promise<MateRuntimeStatus>;
  restartRuntime(): Promise<{ restarted: true }>;
}

export interface MateRuntimeControllerOptions {
  runtime?: MateAgentRuntimeFacade;
  cancelChildrenForParent?: (userId: string, parentTaskId: string) => Promise<void>;
  projectTaskEvent?: (input: MateGroupChatProjectionInput) => Promise<unknown>;
  localCliAdapter?: MateLocalCliExecutionAdapter;
}

function asRuntimeInput(input: StartMateTaskInput & { runtimeSessionId?: string; capabilities?: string[] }): MateAgentRuntimeInput {
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

function terminal(task: MateTaskRecord): boolean {
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
  task: MateTaskRecord,
  input: StartMateTaskInput,
): Promise<string | undefined> {
  if (input.conversationId) return input.conversationId;
  try {
    const session = await readMateSession(userId, task.sessionId);
    return session?.conversationId || undefined;
  } catch {
    return undefined;
  }
}

async function projectTaskEventBestEffort(
  userId: string,
  task: MateTaskRecord,
  event: MateProjectionEvent,
  projectTaskEvent: (input: MateGroupChatProjectionInput) => Promise<unknown>,
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
  task: MateTaskRecord,
  event: RuntimeEventEnvelope,
  projectTaskEvent: (input: MateGroupChatProjectionInput) => Promise<unknown>,
): Promise<MateTaskRecord> {
  const latest = await readMateTask(userId, task.taskId);
  const runtimeRunId = typeof event.metadata?.runtime_run_id === 'string' ? event.metadata.runtime_run_id : undefined;
  if (runtimeRunId && latest && latest.runtimeRunId !== runtimeRunId) {
    await updateMateTask(userId, task.taskId, (current) => ({ ...current, runtimeRunId }));
  }
  if (latest && terminal(latest)) return latest;
  if (event.type === 'result' && event.status === 'completed') {
    const completed = await transitionMateTask(userId, task.taskId, 'completed', { outputChars: String(event.text || '').length });
    await projectTaskEventBestEffort(userId, completed, {
      eventId: `mate-event-terminal-${task.taskId}`,
      type: 'task.completed',
      payload: { text: String(event.text || '') },
    }, projectTaskEvent);
    return completed;
  }
  if (event.type === 'error' && event.status === 'cancelled') {
    const cancelled = await transitionMateTask(userId, task.taskId, 'cancelled', {});
    await projectTaskEventBestEffort(userId, cancelled, {
      eventId: `mate-event-terminal-${task.taskId}`,
      type: 'task.cancelled',
      payload: {},
    }, projectTaskEvent);
    return cancelled;
  }
  if (event.type === 'error' && event.status === 'failed') {
    const failed = await transitionMateTask(userId, task.taskId, 'failed', { errorCode: 'runtime_failed' });
    await projectTaskEventBestEffort(userId, failed, {
      eventId: `mate-event-terminal-${task.taskId}`,
      type: 'task.failed',
      payload: {},
    }, projectTaskEvent);
    return failed;
  }
  if (event.type === 'event' && event.status === 'running') {
    const kernelEvent = event.metadata?.kernel_event;
    if (kernelEvent === 'tool_call') {
      const stored = await appendMateTaskEvent(userId, task.taskId, task.sessionId, 'tool.started', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
      });
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (kernelEvent === 'tool_result') {
      const stored = await appendMateTaskEvent(userId, task.taskId, task.sessionId, 'tool.finished', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
        ...(typeof event.metadata?.isError === 'boolean' ? { isError: event.metadata.isError } : {}),
      });
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (kernelEvent === 'artifact') {
      const artifact: Record<string, unknown> = {};
      for (const key of ['uri', 'digest', 'name', 'media_type'] as const) {
        if (typeof event.metadata?.[key] === 'string') artifact[key] = event.metadata[key];
      }
      const stored = await appendMateTaskEvent(userId, task.taskId, task.sessionId, 'artifact', artifact);
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (event.text) {
      const stored = await appendMateTaskEvent(userId, task.taskId, task.sessionId, 'model.delta', { text: event.text });
      await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    }
  }
  return (await readMateTask(userId, task.taskId)) ?? task;
}

export function createMateRuntimeController(options: MateRuntimeControllerOptions = {}): MateRuntimeController {
  const runtime = options.runtime ?? mateAgentRuntime;
  const activeRuns = new Map<string, AbortController>();
  const runtimeWorkerId = 'mate-worker-' + genId12();
  const resumeClaims = new Set<string>();
  const projectTaskEvent = options.projectTaskEvent ?? (async (input) => {
    const { mateGroupChatProjection } = await import('./group-chat-projection');
    return mateGroupChatProjection.project(input);
  });
  let defaultLocalCliAdapter: MateLocalCliExecutionAdapter | null = null;
  const localCliAdapter = async (): Promise<MateLocalCliExecutionAdapter> => {
    if (options.localCliAdapter) return options.localCliAdapter;
    if (!defaultLocalCliAdapter) {
      defaultLocalCliAdapter = (await import('./local-cli-execution-adapter')).mateLocalCliExecutionAdapter;
    }
    return defaultLocalCliAdapter;
  };

  async function consumeRuntime(userId: string, task: MateTaskRecord, input: StartMateTaskInput & { runtimeSessionId?: string }, controller: AbortController): Promise<void> {
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
      const latest = await readMateTask(userId, task.taskId);
      if (latest && !terminal(latest)) {
        const recoverable = await markMateTaskRecoverable(userId, task.taskId, 'runtime_worker_error');
        await projectTaskEventBestEffort(userId, recoverable, {
          eventId: `mate-event-recoverable-${task.taskId}`,
          type: 'task.recoverable',
          payload: {},
        }, projectTaskEvent);
      }
    } finally {
      activeRuns.delete(task.taskId);
      resumeClaims.delete(task.taskId);
    }
  }

  async function launchTask(userId: string, initial: MateTaskRecord, input: StartMateTaskInput & { runtimeSessionId?: string }): Promise<MateTaskRecord> {
    let task = initial;
    if (!task.runtimeWorkerId) task = await updateMateTask(userId, task.taskId, (current) => ({ ...current, runtimeWorkerId }));
    if (task.status === 'created' || task.status === 'recoverable') {
      task = await transitionMateTask(userId, task.taskId, 'queued');
    }
    if (task.status === 'queued') {
      task = await transitionMateTask(userId, task.taskId, 'running');
      await projectTaskEventBestEffort(userId, task, {
        eventId: `mate-event-started-${task.taskId}`,
        type: 'task.started',
        payload: {},
      }, projectTaskEvent);
    }
    const controller = new AbortController();
    activeRuns.set(task.taskId, controller);
    setImmediate(() => { void consumeRuntime(userId, task, input, controller); });
    return task;
  }

  async function cancelTask(userId: string, taskId: string): Promise<MateTaskRecord> {
    const task = await readMateTask(userId, taskId);
    if (!task) throw new Error('CogSeed task not found');
    if (terminal(task)) return task;
    const cancelled = await transitionMateTask(userId, taskId, 'cancelled', {});
    await projectTaskEventBestEffort(userId, cancelled, {
      eventId: `mate-event-terminal-${taskId}`,
      type: 'task.cancelled',
      payload: {},
    }, projectTaskEvent);
    activeRuns.get(taskId)?.abort();
    try { await options.cancelChildrenForParent?.(userId, taskId); }
    catch (error) { log.warn('CogSeed child cancellation cleanup failed', { error: logErrorRef(error) }); }
    return cancelled;
  }

  return {
    async startMateTask(userId, input) {
      const created = await createMateTask(userId, input);
      if (!created.created) return created.task;
      const capabilities = await resolveRuntimeCapabilities(userId, created.task.requestId, created.task.runtimeSessionId);
      const launchInput: StartMateTaskInput & { runtimeSessionId?: string } = { ...input, capabilities };
      const conversationId = await resolveConversationIdForTask(userId, created.task, input);
      if (conversationId) {
        const assetContext = await buildRuntimeAssetContext(userId, conversationId);
        if (assetContext.length) {
          launchInput.context = [...(input.context ?? []), ...assetContext];
        }
      }
      return launchTask(userId, created.task, launchInput);
    },

    async retryMateTask(userId, taskId, requestId) {
      const retried = await retryStoredMateTask(userId, taskId, requestId);
      if (retried.status !== 'created') return retried;
      const capabilities = await resolveRuntimeCapabilities(userId, retried.requestId, retried.runtimeSessionId);
      const retryInput: StartMateTaskInput & { runtimeSessionId?: string } = {
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

    async resumeMateTask(userId, taskId, input) {
      const current = await readMateTask(userId, taskId);
      if (!current) throw new Error('CogSeed task not found');
      if (current.status === 'completed' || current.status === 'cancelled') return current;
      if (current.status !== 'recoverable') throw new Error('CogSeed task is not resumable');
      const continuation = input.continuation.trim();
      if (!continuation) throw new Error('CogSeed continuation is required');
      if (resumeClaims.has(taskId)) return current;
      resumeClaims.add(taskId);
      try {
        const reserved = await updateMateTask(userId, taskId, (task) => {
          if (task.status !== 'recoverable') throw new Error('CogSeed task is not resumable');
          if (task.lastResumeRequestId === input.requestId) return task;
          return { ...task, lastResumeRequestId: input.requestId };
        });
        const resumeInput: StartMateTaskInput & { runtimeSessionId?: string } = {
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

    async cancelMateTask(userId, taskId) {
      return cancelTask(userId, taskId);
    },

    async cancelConversationTasks(userId, conversationId) {
      const active = (await listMateTasks(userId)).filter((task) => (
        task.conversationId === conversationId && !terminal(task)
      ));
      const cancelled: MateTaskRecord[] = [];
      for (const task of active) cancelled.push(await cancelTask(userId, task.taskId));
      return cancelled;
    },

    async runtimeStatus() {
      return { backend: 'mate', activeTaskCount: activeRuns.size, activeTaskIds: Array.from(activeRuns.keys()) };
    },

    async restartRuntime() {
      for (const signal of activeRuns.values()) signal.abort();
      await runtime.shutdown();
      return { restarted: true as const };
    },
  };
}


export const mateRuntimeController: MateRuntimeController = (() => {
  let controller: MateRuntimeController;
  controller = createMateRuntimeController({
    cancelChildrenForParent: async (userId, parentTaskId) => {
      const { createMateCoordinator } = await import('./coordinator');
      const coordinator = createMateCoordinator({
        startTask: (uid, input) => controller.startMateTask(uid, input),
        cancelTask: (uid, taskId) => controller.cancelMateTask(uid, taskId),
      });
      await coordinator.cancelChildrenForParent(userId, parentTaskId);
    },
  });
  return controller;
})();
