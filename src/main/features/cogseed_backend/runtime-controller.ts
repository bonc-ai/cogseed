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
import { createMateTask, readMateTask, updateMateTask } from './task-store';
import { resolveRuntimeCapabilities } from './messaging-capability-policy';
import type { MateTaskRecord } from './types';

const log = createLogger('mate-backend:runtime-controller');

export interface StartMateTaskInput {
  requestId: string;
  task: string;
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
  runtimeStatus(): Promise<MateRuntimeStatus>;
  restartRuntime(): Promise<{ restarted: true }>;
}

export interface MateRuntimeControllerOptions {
  runtime?: MateAgentRuntimeFacade;
  cancelChildrenForParent?: (userId: string, parentTaskId: string) => Promise<void>;
}

function asRuntimeInput(input: StartMateTaskInput & { runtimeSessionId?: string; capabilities?: string[] }): MateAgentRuntimeInput {
  return {
    task: input.task,
    request_id: input.requestId,
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

async function mapRuntimeEvent(userId: string, task: MateTaskRecord, event: RuntimeEventEnvelope): Promise<MateTaskRecord> {
  const latest = await readMateTask(userId, task.taskId);
  const runtimeRunId = typeof event.metadata?.runtime_run_id === 'string' ? event.metadata.runtime_run_id : undefined;
  if (runtimeRunId && latest && latest.runtimeRunId !== runtimeRunId) {
    await updateMateTask(userId, task.taskId, (current) => ({ ...current, runtimeRunId }));
  }
  if (latest && terminal(latest)) return latest;
  if (event.type === 'result' && event.status === 'completed') {
    return transitionMateTask(userId, task.taskId, 'completed', { outputChars: String(event.text || '').length });
  }
  if (event.type === 'error' && event.status === 'cancelled') {
    return transitionMateTask(userId, task.taskId, 'cancelled', {});
  }
  if (event.type === 'error' && event.status === 'failed') {
    return transitionMateTask(userId, task.taskId, 'failed', { errorCode: 'runtime_failed' });
  }
  if (event.type === 'event' && event.status === 'running') {
    const kernelEvent = event.metadata?.kernel_event;
    if (kernelEvent === 'tool_call') {
      await appendMateTaskEvent(userId, task.taskId, task.sessionId, 'tool.started', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
      });
    } else if (kernelEvent === 'tool_result') {
      await appendMateTaskEvent(userId, task.taskId, task.sessionId, 'tool.finished', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
        ...(typeof event.metadata?.isError === 'boolean' ? { isError: event.metadata.isError } : {}),
      });
    } else if (event.text) {
      await appendMateTaskEvent(userId, task.taskId, task.sessionId, 'model.delta', { text: event.text });
    }
  }
  return (await readMateTask(userId, task.taskId)) ?? task;
}

export function createMateRuntimeController(options: MateRuntimeControllerOptions = {}): MateRuntimeController {
  const runtime = options.runtime ?? mateAgentRuntime;
  const activeRuns = new Map<string, AbortController>();
  const runtimeWorkerId = 'mate-worker-' + genId12();
  const resumeClaims = new Set<string>();

  async function consumeRuntime(userId: string, task: MateTaskRecord, input: StartMateTaskInput & { runtimeSessionId?: string }, controller: AbortController): Promise<void> {
    let current = task;
    try {
      for await (const event of runtime.run(userId, asRuntimeInput(input), { signal: controller.signal })) {
        current = await mapRuntimeEvent(userId, current, event);
        if (terminal(current)) break;
      }
    } catch {
      const latest = await readMateTask(userId, task.taskId);
      if (latest && !terminal(latest)) {
        await markMateTaskRecoverable(userId, task.taskId, 'runtime_worker_error');
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
    if (task.status === 'queued') task = await transitionMateTask(userId, task.taskId, 'running');
    const controller = new AbortController();
    activeRuns.set(task.taskId, controller);
    setImmediate(() => { void consumeRuntime(userId, task, input, controller); });
    return task;
  }

  return {
    async startMateTask(userId, input) {
      const created = await createMateTask(userId, input);
      if (!created.created) return created.task;
      const capabilities = await resolveRuntimeCapabilities(userId, created.task.requestId, created.task.runtimeSessionId);
      return launchTask(userId, created.task, { ...input, capabilities });
    },

    async retryMateTask(userId, taskId, requestId) {
      const retried = await retryStoredMateTask(userId, taskId, requestId);
      if (retried.status !== 'created') return retried;
      const capabilities = await resolveRuntimeCapabilities(userId, retried.requestId, retried.runtimeSessionId);
      return launchTask(userId, retried, {
        requestId,
        task: retried.task,
        ...(retried.profileId ? { profileId: retried.profileId } : {}),
        capabilities,
      });
    },

    async resumeMateTask(userId, taskId, input) {
      const current = await readMateTask(userId, taskId);
      if (!current) throw new Error('Mate task not found');
      if (current.status === 'completed' || current.status === 'cancelled') return current;
      if (current.status !== 'recoverable') throw new Error('Mate task is not resumable');
      const continuation = input.continuation.trim();
      if (!continuation) throw new Error('Mate continuation is required');
      if (resumeClaims.has(taskId)) return current;
      resumeClaims.add(taskId);
      try {
        const reserved = await updateMateTask(userId, taskId, (task) => {
          if (task.status !== 'recoverable') throw new Error('Mate task is not resumable');
          if (task.lastResumeRequestId === input.requestId) return task;
          return { ...task, lastResumeRequestId: input.requestId };
        });
        return launchTask(userId, reserved, {
          requestId: input.requestId,
          task: continuation,
          runtimeSessionId: reserved.runtimeSessionId,
          ...(input.profileId || reserved.profileId ? { profileId: input.profileId || reserved.profileId } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.workingDir ? { workingDir: input.workingDir } : {}),
          capabilities: await resolveRuntimeCapabilities(userId, input.requestId, reserved.runtimeSessionId),
        });
      } catch (error) {
        resumeClaims.delete(taskId);
        throw error;
      }
    },

    async cancelMateTask(userId, taskId) {
      const task = await readMateTask(userId, taskId);
      if (!task) throw new Error('Mate task not found');
      if (terminal(task)) return task;
      const cancelled = await transitionMateTask(userId, taskId, 'cancelled', {});
      activeRuns.get(taskId)?.abort();
      try { await options.cancelChildrenForParent?.(userId, taskId); }
      catch (error) { log.warn('Mate child cancellation cleanup failed', { error: logErrorRef(error) }); }
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
