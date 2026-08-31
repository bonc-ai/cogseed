import {
  cogseedAgentRuntime,
  type CogSeedAgentRuntimeFacade,
  type CogSeedAgentRuntimeInput,
} from '../cogseed_runtime';
import type { RuntimeEventEnvelope } from '../cogseed_runtime/protocol';
import { genId12, nowIso, writeJson } from '../../storage';
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { fileEditLock } from '../../util/locks';
import {
  markCogSeedTaskRecoverable,
  retryCogSeedTask as retryStoredCogSeedTask,
  transitionCogSeedTask,
} from './lifecycle';
import {
  appendCogSeedTaskEventIfActive,
  createCogSeedTask,
  listCogSeedTasks,
  readCogSeedTask,
  updateCogSeedTask,
} from './task-store';
import { resolveRuntimeCapabilities } from './messaging-capability-policy';
import { buildDispatchedRuntimeAssetContext, buildRuntimeAssetContext } from './runtime-asset-context';
import { cogSeedRequestFingerprint } from './request-fingerprint';
import { readCogSeedSession } from './session-store';
import type { CogSeedTaskRecord } from './types';
import type { CogSeedGroupChatProjectionInput, CogSeedProjectionEvent } from './group-chat-projection';
import type { CogSeedLocalCliExecutionAdapter } from './local-cli-execution-adapter';
import type { CogSeedLocalCliConfig } from './types';
import {
  cogseedResultDeliveryStore,
  type CogSeedResultDeliveryStore,
  type CogSeedTerminalProjectionEvent,
} from './result-delivery-store';
import { acquireCogSeedResultDeliveryLease } from './result-delivery-lease';
import {
  reconcileCogSeedConversationResults,
  reconcileCogSeedExecutionResult,
} from './result-delivery-reconciler';
import { withCogSeedConversationAdmission } from './conversation-operation-guard';
import { resolveCogSeedSessionIdentity } from './actor-session-facade';
import { cogseedRecoveryStateFile } from './paths';
import { recoverCogSeedCollaborationSteps, recoverCogSeedTask, type CogSeedRecoveryReport } from './recovery';
import {
  createCogSeedRuntimeHealthWatchdog,
  type CogSeedExecutionProcessHealth,
  type CogSeedRuntimeHealthScanReport,
  type CogSeedRuntimeHealthWatchdogOptions,
} from './runtime-health-watchdog';

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
  /** Links a new execution to the task it replaces without mutating history. */
  retryOfTaskId?: string;
  /** Ability asset ids granted for this task. Persisted so a wake-gated
   *  dispatch restores the grant after user approval. */
  abilityAssetIds?: string[];
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
  retryCogSeedResultDelivery(userId: string, taskId: string): Promise<CogSeedTaskRecord>;
  cancelCogSeedTask(userId: string, taskId: string): Promise<CogSeedTaskRecord>;
  cancelConversationTasks(userId: string, conversationId: string): Promise<CogSeedTaskRecord[]>;
  cancelConversationTasksForDeletion(userId: string, conversationId: string): Promise<{
    cancelled: CogSeedTaskRecord[];
    settled: Promise<void>;
  }>;
  reconcileConversationResultDeliveries(userId: string, conversationId: string): Promise<void>;
  recoverOrphanedTasks(userId: string): Promise<CogSeedRecoveryReport>;
  scanRuntimeHealth(userId: string): Promise<CogSeedRuntimeHealthScanReport>;
  runtimeStatus(): Promise<CogSeedRuntimeStatus>;
  restartRuntime(): Promise<{ restarted: true }>;
  shutdown(): Promise<void>;
}

export interface CogSeedRuntimeControllerWatchdogOptions extends Partial<Pick<
  CogSeedRuntimeHealthWatchdogOptions,
  'intervalMs' | 'orphanGraceMs' | 'slowThresholdMs' | 'now' | 'setTimeoutFn' | 'clearTimeoutFn'
>> {
  autoStart?: boolean;
  probeProcess?: (userId: string, task: CogSeedTaskRecord) => CogSeedExecutionProcessHealth | Promise<CogSeedExecutionProcessHealth>;
}

export interface CogSeedRuntimeControllerOptions {
  runtime?: CogSeedAgentRuntimeFacade;
  cancelChildrenForParent?: (userId: string, parentTaskId: string) => Promise<void>;
  projectTaskEvent?: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>;
  localCliAdapter?: CogSeedLocalCliExecutionAdapter;
  resultDeliveryStore?: CogSeedResultDeliveryStore;
  runtimeHealthWatchdog?: false | CogSeedRuntimeControllerWatchdogOptions;
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

function cancellationOrder(tasks: CogSeedTaskRecord[]): CogSeedTaskRecord[] {
  const remaining = [...tasks];
  const ordered: CogSeedTaskRecord[] = [];
  while (remaining.length) {
    const leaves = remaining.filter((task) => !remaining.some((candidate) => (
      candidate.retryOfTaskId === task.taskId || candidate.parentTaskId === task.taskId
    )));
    if (!leaves.length) return [...ordered, ...remaining];
    const leafIds = new Set(leaves.map((task) => task.taskId));
    ordered.push(...leaves);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (leafIds.has(remaining[index].taskId)) remaining.splice(index, 1);
    }
  }
  return ordered;
}

function runtimeErrorCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  return code && code.length <= 120 && /^[A-Za-z0-9_.:-]+$/.test(code) ? code : 'runtime_failed';
}

class CogSeedTerminalResultRetentionError extends Error {
  constructor() {
    super('CogSeed terminal result could not be retained');
    this.name = 'CogSeedTerminalResultRetentionError';
  }
}

function withCogSeedTaskOperation<T>(
  userId: string,
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return fileEditLock(`cogseed-runtime-operation:${userId}:${taskId}`).runExclusive(operation);
}

function withCogSeedLaunchRecoveryOperation<T>(
  userId: string,
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return fileEditLock(`cogseed-runtime-launch-recovery:${userId}:${taskId}`).runExclusive(operation);
}

function withCogSeedUserLaunchRecoveryAdmission<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return fileEditLock(`cogseed-runtime-launch-recovery-user:${userId}`).runExclusive(operation);
}

async function resolveInputConversationId(
  userId: string,
  input: Pick<StartCogSeedTaskInput, 'conversationId' | 'sessionId'>,
): Promise<string | undefined> {
  if (input.conversationId) return input.conversationId;
  if (!input.sessionId) return undefined;
  const identity = resolveCogSeedSessionIdentity(input.sessionId);
  if (identity.conversationId) return identity.conversationId;
  return (await readCogSeedSession(userId, identity.canonicalSessionId))?.conversationId;
}

async function assertLocalCliConversationExists(userId: string, conversationId: string): Promise<void> {
  const { getConversation } = await import('../chats');
  if (!await getConversation(userId, conversationId)) {
    throw new Error('CogSeed local CLI conversation is unavailable');
  }
}

async function withTaskConversationAdmission<T>(
  userId: string,
  conversationId: string | undefined,
  executionKind: StartCogSeedTaskInput['executionKind'] | 'group-chat' | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!conversationId) {
    if (executionKind === 'local-cli') throw new Error('CogSeed local CLI task requires a conversation');
    return operation();
  }
  return withCogSeedConversationAdmission(userId, conversationId, async () => {
    if (executionKind === 'local-cli') await assertLocalCliConversationExists(userId, conversationId);
    return operation();
  });
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

async function buildTaskExecutionContext(
  userId: string,
  task: CogSeedTaskRecord,
  input: StartCogSeedTaskInput,
  conversationId?: string,
): Promise<unknown[] | undefined> {
  const context = [...(input.context ?? [])];
  if (task.abilityAssetIds?.length) {
    context.push(...await buildDispatchedRuntimeAssetContext(userId, task.abilityAssetIds, {
      ...(task.agentId ? { agentId: task.agentId } : {}),
      taskText: input.task,
      purpose: input.task,
    }));
  }
  if (conversationId) {
    const assetContext = await buildRuntimeAssetContext(userId, conversationId, task.taskId);
    if (assetContext.length) context.push(...assetContext);
  }
  return context.length ? context : undefined;
}

async function projectTaskEventBestEffort(
  userId: string,
  task: CogSeedTaskRecord,
  event: CogSeedProjectionEvent,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
): Promise<'not-applicable' | 'projected' | 'failed'> {
  if (!task.conversationId || !task.agentId) return 'not-applicable';
  try {
    const result = await projectTaskEvent({
      userId,
      conversationId: task.conversationId,
      agentId: task.agentId,
      taskId: task.taskId,
      ...(task.executionId ? { executionId: task.executionId } : {}),
      sessionId: task.sessionId,
      event,
    });
    if (result === 'dropped') return 'failed';
    return 'projected';
  } catch (error) {
    log.warn('CogSeed Runtime event projection failed', { error: logErrorRef(error) });
    return 'failed';
  }
}

async function projectTaskEventBounded(
  userId: string,
  task: CogSeedTaskRecord,
  event: CogSeedProjectionEvent,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
): Promise<'not-applicable' | 'projected' | 'failed' | 'timed-out'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), 1_000);
    timer.unref?.();
  });
  let outcome: 'not-applicable' | 'projected' | 'failed' | 'timed-out';
  try {
    outcome = await Promise.race([
      projectTaskEventBestEffort(userId, task, event, projectTaskEvent),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (outcome === 'timed-out') log.warn('CogSeed Runtime event projection timed out');
  return outcome;
}

function projectTaskEventDetached(
  userId: string,
  task: CogSeedTaskRecord,
  event: CogSeedProjectionEvent,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
): void {
  void projectTaskEventBounded(userId, task, event, projectTaskEvent).catch((error) => {
    log.warn('CogSeed Runtime detached projection failed', { error: logErrorRef(error) });
  });
}

function hasTerminalDeliveryBinding(task: CogSeedTaskRecord): task is CogSeedTaskRecord & {
  executionId: string;
  conversationId: string;
  agentId: string;
} {
  return task.executionKind !== 'group-chat' && !!task.executionId && !!task.conversationId && !!task.agentId;
}

async function finishRuntimeTask(
  userId: string,
  task: CogSeedTaskRecord,
  nextStatus: 'completed' | 'failed',
  transitionPayload: Record<string, unknown>,
  event: CogSeedTerminalProjectionEvent,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
  resultDeliveryStore: CogSeedResultDeliveryStore,
  isCurrentRun: () => boolean,
): Promise<CogSeedTaskRecord> {
  const outcome = await withCogSeedTaskOperation(userId, task.taskId, async () => {
    const latest = await readCogSeedTask(userId, task.taskId);
    if (!latest) throw new Error('CogSeed task not found');
    if (!isCurrentRun() || latest.status === 'recoverable') return { task: latest, won: false as const };
    if (terminal(latest)) return { task: latest, won: false as const };
    let deliveryLease: Awaited<ReturnType<typeof acquireCogSeedResultDeliveryLease>> = null;
    try {
      if (hasTerminalDeliveryBinding(latest)) {
        deliveryLease = await acquireCogSeedResultDeliveryLease(userId, latest.executionId, { waitMs: 1_000 });
        if (!deliveryLease) throw new CogSeedTerminalResultRetentionError();
        try {
          const chats = await import('../chats');
          const destinationGeneration = await chats.ensureCogSeedConversationDeliveryGeneration(
            userId,
            latest.conversationId,
          ) ?? `cogseed-generation-unavailable-${latest.executionId.slice('cogseed-exec-'.length)}`;
          await resultDeliveryStore.save(userId, {
            taskId: latest.taskId,
            executionId: latest.executionId,
            conversationId: latest.conversationId,
            agentId: latest.agentId,
            sessionId: latest.sessionId,
            destinationGeneration,
            event,
          });
        } catch (error) {
          log.warn('CogSeed terminal result retention failed', { error: logErrorRef(error) });
          throw new CogSeedTerminalResultRetentionError();
        }
      }
      const terminalTask = await transitionCogSeedTask(userId, latest.taskId, nextStatus, transitionPayload);
      return { task: terminalTask, won: true as const };
    } finally {
      await deliveryLease?.release();
    }
  });
  if (!outcome.won || !hasTerminalDeliveryBinding(outcome.task)) return outcome.task;
  const reconciled = await reconcileCogSeedExecutionResult(userId, outcome.task.executionId, {
    store: resultDeliveryStore,
    projectTaskEvent,
  });
  return reconciled.task ?? outcome.task;
}

async function mapRuntimeEvent(
  userId: string,
  task: CogSeedTaskRecord,
  event: RuntimeEventEnvelope,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
  resultDeliveryStore: CogSeedResultDeliveryStore,
  signal: AbortSignal,
  isCurrentRun: () => boolean,
): Promise<CogSeedTaskRecord> {
  const latest = await readCogSeedTask(userId, task.taskId);
  if (!isCurrentRun() || latest?.status === 'recoverable') return latest ?? task;
  if (latest && terminal(latest)) return latest;
  const runtimeRunId = typeof event.metadata?.runtime_run_id === 'string' ? event.metadata.runtime_run_id : undefined;
  if (runtimeRunId && latest && latest.runtimeRunId !== runtimeRunId) {
    await updateCogSeedTask(userId, task.taskId, (current) => (
      terminal(current) ? current : { ...current, runtimeRunId }
    ));
  }
  if (event.type === 'result' && event.status === 'completed') {
    const terminalEvent: CogSeedTerminalProjectionEvent = {
      eventId: `cogseed-event-terminal-${task.taskId}`,
      type: 'task.completed',
      payload: { text: String(event.text || '') },
    };
    return finishRuntimeTask(
      userId,
      latest ?? task,
      'completed',
      { outputChars: String(event.text || '').length },
      terminalEvent,
      projectTaskEvent,
      resultDeliveryStore,
      isCurrentRun,
    );
  }
  if (event.type === 'error' && event.status === 'cancelled') {
    if (signal.aborted && signal.reason === 'runtime_restart') {
      const recoverable = await markCogSeedTaskRecoverable(userId, task.taskId, 'runtime_restart');
      await projectTaskEventBestEffort(userId, recoverable, {
        eventId: `cogseed-event-recoverable-${task.taskId}`,
        type: 'task.recoverable',
        payload: { errorCode: 'runtime_restart' },
      }, projectTaskEvent);
      return recoverable;
    }
    const cancelled = await transitionCogSeedTask(userId, task.taskId, 'cancelled', {});
    await projectTaskEventBestEffort(userId, cancelled, {
      eventId: `cogseed-event-terminal-${task.taskId}`,
      type: 'task.cancelled',
      payload: {},
    }, projectTaskEvent);
    return cancelled;
  }
  if (event.type === 'error' && event.status === 'failed') {
    const failureCode = runtimeErrorCode(event.metadata?.code);
    // Carry the executor's failure detail (gateway/CLI error text, failure
    // code) into the projected event — without it every failure collapses
    // into the generic retry notice and the root cause is unrecoverable
    // from the conversation history alone.
    const failureDetail = String(event.error || '').trim();
    const terminalEvent: CogSeedTerminalProjectionEvent = {
      eventId: `cogseed-event-terminal-${task.taskId}`,
      type: 'task.failed',
      payload: {
        ...(failureDetail ? { error: failureDetail.slice(0, 2000) } : {}),
        ...(failureCode ? { code: failureCode } : {}),
      },
    };
    return finishRuntimeTask(
      userId,
      latest ?? task,
      'failed',
      { errorCode: failureCode },
      terminalEvent,
      projectTaskEvent,
      resultDeliveryStore,
      isCurrentRun,
    );
  }
  if (event.type === 'event' && event.status === 'running') {
    const kernelEvent = event.metadata?.kernel_event;
    if (kernelEvent === 'tool_call') {
      const stored = await appendCogSeedTaskEventIfActive(userId, task.taskId, 'tool.started', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
      });
      if (stored) await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (kernelEvent === 'tool_result') {
      const toolError = typeof event.metadata?.error === 'string' ? event.metadata.error.trim() : '';
      const stored = await appendCogSeedTaskEventIfActive(userId, task.taskId, 'tool.finished', {
        ...(typeof event.metadata?.name === 'string' ? { name: event.metadata.name } : {}),
        ...(typeof event.metadata?.isError === 'boolean' ? { isError: event.metadata.isError } : {}),
        ...(event.metadata?.isError === true && toolError ? { error: toolError.slice(0, 2000) } : {}),
      });
      if (stored) await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (kernelEvent === 'artifact') {
      const artifact: Record<string, unknown> = {};
      for (const key of ['uri', 'digest', 'name', 'media_type'] as const) {
        if (typeof event.metadata?.[key] === 'string') artifact[key] = event.metadata[key];
      }
      const stored = await appendCogSeedTaskEventIfActive(userId, task.taskId, 'artifact', artifact);
      if (stored) await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    } else if (event.text) {
      const stored = await appendCogSeedTaskEventIfActive(userId, task.taskId, 'model.delta', { text: event.text });
      if (stored) await projectTaskEventBestEffort(userId, task, stored, projectTaskEvent);
    }
  }
  return (await readCogSeedTask(userId, task.taskId)) ?? task;
}

export function createCogSeedRuntimeController(options: CogSeedRuntimeControllerOptions = {}): CogSeedRuntimeController {
  const runtime = options.runtime ?? cogseedAgentRuntime;
  const activeRuns = new Map<string, AbortController>();
  const activeRunPromises = new Map<string, Promise<void>>();
  const launchClaims = new Map<string, Promise<CogSeedTaskRecord>>();
  const sourceOperationClaims = new Map<string, {
    kind: 'replacement' | 'resume';
    requestId: string;
    requestFingerprint: string;
    promise: Promise<CogSeedTaskRecord>;
  }>();
  const resultDeliveryClaims = new Map<string, Promise<CogSeedTaskRecord>>();
  const cancellationClaims = new Map<string, Promise<CogSeedTaskRecord>>();
  const orphanRecoveryClaims = new Map<string, Promise<CogSeedRecoveryReport>>();
  let runtimeRestart: Promise<void> | null = null;
  let runtimeShutdown: Promise<void> | null = null;
  const runtimeWorkerId = 'cogseed-worker-' + genId12();
  const projectTaskEvent = options.projectTaskEvent ?? (async (input) => {
    const { cogseedGroupChatProjection } = await import('./group-chat-projection');
    return cogseedGroupChatProjection.project(input);
  });
  const resultDeliveryStore = options.resultDeliveryStore ?? cogseedResultDeliveryStore;
  let defaultLocalCliAdapter: CogSeedLocalCliExecutionAdapter | null = null;
  const localCliAdapter = async (): Promise<CogSeedLocalCliExecutionAdapter> => {
    if (options.localCliAdapter) return options.localCliAdapter;
    if (!defaultLocalCliAdapter) {
      defaultLocalCliAdapter = (await import('./local-cli-execution-adapter')).cogseedLocalCliExecutionAdapter;
    }
    return defaultLocalCliAdapter;
  };
  const watchdogOptions = options.runtimeHealthWatchdog === false
    ? null
    : options.runtimeHealthWatchdog ?? {};

  async function probeTaskProcess(
    userId: string,
    task: CogSeedTaskRecord,
  ): Promise<CogSeedExecutionProcessHealth> {
    if (watchdogOptions?.probeProcess) return watchdogOptions.probeProcess(userId, task);
    if (launchClaims.has(task.taskId)) return 'unknown';
    if (task.executionKind === 'local-cli') {
      const adapter = await localCliAdapter();
      return adapter.probeProcess
        ? adapter.probeProcess({ taskId: task.taskId, executionId: task.executionId })
        : 'unknown';
    }
    if (task.executionKind === 'group-chat') return 'unknown';
    // Native runs share one worker process, so PID liveness is not a per-task
    // signal. The controller's run registry is the authoritative execution
    // handle: no matching handle means this task cannot receive another event.
    return activeRuns.has(task.taskId) ? 'unknown' : 'invalid';
  }

  async function recoverWatchdogTask(userId: string, candidate: CogSeedTaskRecord): Promise<boolean> {
    return withCogSeedLaunchRecoveryOperation(userId, candidate.taskId, async () => {
      if (launchClaims.has(candidate.taskId)) return false;
      const current = await readCogSeedTask(userId, candidate.taskId);
      if (!current) return false;
      const processHealth = await probeTaskProcess(userId, current);
      if (processHealth !== 'missing' && processHealth !== 'invalid') return false;

      const owner = activeRuns.get(candidate.taskId);
      if (owner) {
        owner.abort('runtime_watchdog_process_lost');
        if (activeRuns.get(candidate.taskId) === owner) activeRuns.delete(candidate.taskId);
      }
      // A confirmed-dead executor must not leave retry/resume waiting forever
      // on a consumer promise whose transport will never settle. Late consumer
      // work is fenced by the ownership checks in consumeRuntime.
      activeRunPromises.delete(candidate.taskId);
      const recovered = await recoverCogSeedTask(userId, candidate.taskId, {
        errorCode: 'runtime_watchdog_orphaned',
        projectTaskEvent,
        canRecover: () => !launchClaims.has(candidate.taskId) && !activeRuns.has(candidate.taskId),
      });
      return !!recovered;
    });
  }

  const runtimeHealthWatchdog = watchdogOptions
    ? createCogSeedRuntimeHealthWatchdog({
        listTasks: listCogSeedTasks,
        controllerOwnsTask: (_userId, task) => launchClaims.has(task.taskId) || activeRuns.has(task.taskId),
        probeProcess: probeTaskProcess,
        recoverTask: recoverWatchdogTask,
        ...(watchdogOptions.intervalMs !== undefined ? { intervalMs: watchdogOptions.intervalMs } : {}),
        ...(watchdogOptions.orphanGraceMs !== undefined ? { orphanGraceMs: watchdogOptions.orphanGraceMs } : {}),
        ...(watchdogOptions.slowThresholdMs !== undefined ? { slowThresholdMs: watchdogOptions.slowThresholdMs } : {}),
        ...(watchdogOptions.now ? { now: watchdogOptions.now } : {}),
        ...(watchdogOptions.setTimeoutFn ? { setTimeoutFn: watchdogOptions.setTimeoutFn } : {}),
        ...(watchdogOptions.clearTimeoutFn ? { clearTimeoutFn: watchdogOptions.clearTimeoutFn } : {}),
      })
    : null;
  if (watchdogOptions?.autoStart) runtimeHealthWatchdog?.start();

  function watchUser(userId: string): void {
    runtimeHealthWatchdog?.watchUser(userId);
  }

  async function consumeRuntime(userId: string, task: CogSeedTaskRecord, input: StartCogSeedTaskInput & { runtimeSessionId?: string }, controller: AbortController): Promise<void> {
    let current = task;
    try {
      if (task.executionKind === 'local-cli' && !task.conversationId) {
        throw new Error('CogSeed local CLI task requires a conversation');
      }
      if (task.executionKind === 'local-cli') {
        await withTaskConversationAdmission(
          userId,
          task.conversationId,
          task.executionKind,
          async () => undefined,
        );
      }
      const stream = task.executionKind === 'local-cli'
        ? (await localCliAdapter()).run({
            userId,
            conversationId: task.conversationId || task.sessionId,
            agentId: task.agentId!,
            agentName: task.localCli?.agentName,
            requestId: input.requestId,
            taskId: task.taskId,
            executionId: task.executionId,
            sessionId: task.sessionId,
            runtimeSessionId: task.runtimeSessionId,
            task: input.task,
            context: input.context,
            attachments: input.attachments,
            workingDir: input.workingDir,
            abilityAssetIds: task.abilityAssetIds,
            localCli: task.localCli!,
          }, { signal: controller.signal })
        : runtime.run(userId, asRuntimeInput(input), { signal: controller.signal });
      for await (const event of stream) {
        current = await mapRuntimeEvent(
          userId,
          current,
          event,
          projectTaskEvent,
          resultDeliveryStore,
          controller.signal,
          () => activeRuns.get(task.taskId) === controller,
        );
        if (terminal(current) || current.status === 'recoverable') break;
      }
      const latest = await readCogSeedTask(userId, task.taskId);
      if (activeRuns.get(task.taskId) === controller
        && latest && !terminal(latest) && latest.status !== 'recoverable') {
        const errorCode = controller.signal.aborted && controller.signal.reason === 'runtime_restart'
          ? 'runtime_restart'
          : 'runtime_stream_ended';
        const recoverable = await markCogSeedTaskRecoverable(userId, task.taskId, errorCode);
        await projectTaskEventBestEffort(userId, recoverable, {
          eventId: `cogseed-event-recoverable-${task.taskId}`,
          type: 'task.recoverable',
          payload: { errorCode },
        }, projectTaskEvent);
      }
    } catch (error) {
      const latest = await readCogSeedTask(userId, task.taskId);
      if (activeRuns.get(task.taskId) === controller
        && latest && !terminal(latest) && latest.status !== 'recoverable') {
        const errorCode = controller.signal.aborted && controller.signal.reason === 'runtime_restart'
          ? 'runtime_restart'
          : error instanceof CogSeedTerminalResultRetentionError
            ? 'result_retention_failed'
            : 'runtime_worker_error';
        try {
          const recoverable = await markCogSeedTaskRecoverable(userId, task.taskId, errorCode);
          await projectTaskEventBestEffort(userId, recoverable, {
            eventId: `cogseed-event-recoverable-${task.taskId}`,
            type: 'task.recoverable',
            payload: { errorCode },
          }, projectTaskEvent);
        } catch (recoveryError) {
          log.warn('CogSeed Runtime recovery transition failed', { error: logErrorRef(recoveryError) });
        }
      }
    } finally {
      if (activeRuns.get(task.taskId) === controller) activeRuns.delete(task.taskId);
    }
  }

  async function performLaunchTask(userId: string, initial: CogSeedTaskRecord, input: StartCogSeedTaskInput & { runtimeSessionId?: string }): Promise<CogSeedTaskRecord> {
    while (runtimeRestart) await runtimeRestart;
    const admission = await withCogSeedLaunchRecoveryOperation(userId, initial.taskId, async () => {
      const persisted = await readCogSeedTask(userId, initial.taskId);
      if (!persisted) throw new Error('CogSeed task not found');
      if (activeRuns.has(initial.taskId)) return { task: persisted };
      if (persisted.status !== initial.status) return { task: persisted };
      let task = persisted;
      if (!task.runtimeWorkerId) task = await updateCogSeedTask(userId, task.taskId, (current) => ({ ...current, runtimeWorkerId }));
      if (task.status === 'created' || task.status === 'recoverable') {
        task = await transitionCogSeedTask(userId, task.taskId, 'queued');
      }
      if (task.status !== 'queued') return { task };
      task = await transitionCogSeedTask(userId, task.taskId, 'running');
      const controller = new AbortController();
      activeRuns.set(task.taskId, controller);
      return { task, controller };
    });
    const { task, controller } = admission;
    if (controller) {
      await projectTaskEventBounded(userId, task, {
        eventId: `cogseed-event-started-${task.taskId}`,
        type: 'task.started',
        payload: {},
      }, projectTaskEvent);
      const latest = await readCogSeedTask(userId, task.taskId);
      if (!latest) throw new Error('CogSeed task not found');
      if (latest.status !== 'running' || controller.signal.aborted) {
        if (latest.status === 'running' && controller.signal.aborted) {
          const recoverable = await markCogSeedTaskRecoverable(userId, task.taskId, 'runtime_launch_aborted');
          if (activeRuns.get(task.taskId) === controller) activeRuns.delete(task.taskId);
          return recoverable;
        }
        if (activeRuns.get(task.taskId) === controller) activeRuns.delete(task.taskId);
        return latest;
      }
      const runPromise = new Promise<void>((resolve) => {
        setImmediate(() => {
          void consumeRuntime(userId, latest, input, controller)
            .catch((error) => log.error('CogSeed Runtime consumer failed', { error: logErrorRef(error) }))
            .then(resolve);
        });
      });
      activeRunPromises.set(task.taskId, runPromise);
      const clearRun = () => {
        if (activeRunPromises.get(task.taskId) === runPromise) activeRunPromises.delete(task.taskId);
      };
      void runPromise.then(clearRun, clearRun);
      return latest;
    }
    return task;
  }

  function launchTask(userId: string, initial: CogSeedTaskRecord, input: StartCogSeedTaskInput & { runtimeSessionId?: string }): Promise<CogSeedTaskRecord> {
    const existing = launchClaims.get(initial.taskId);
    if (existing) return existing;
    const launch = Promise.resolve().then(() => performLaunchTask(userId, initial, input));
    launchClaims.set(initial.taskId, launch);
    const clearLaunch = () => {
      if (launchClaims.get(initial.taskId) === launch) launchClaims.delete(initial.taskId);
    };
    void launch.then(clearLaunch, clearLaunch);
    return launch;
  }

  async function cancelTask(
    userId: string,
    taskId: string,
    cancellationOptions: { ignoreReplacement?: boolean } = {},
  ): Promise<CogSeedTaskRecord> {
    const current = await readCogSeedTask(userId, taskId);
    if (current?.executionId && terminal(current)
      && (current.resultDeliveryState === 'pending' || current.resultDeliveryState === 'pending-recovery')) {
      const delivery = resultDeliveryClaims.get(`${userId}:${current.executionId}`);
      if (delivery) return delivery;
    }
    const claimKey = `${userId}:${taskId}`;
    const inFlight = cancellationClaims.get(claimKey);
    if (inFlight) return inFlight;
    // Register the single-flight before aborting: AbortSignal listeners run
    // synchronously and may re-enter cancellation for the same task.
    const cancellation = Promise.resolve().then(async () => {
      activeRuns.get(taskId)?.abort('user_cancelled');
      const outcome = await withCogSeedTaskOperation(userId, taskId, async () => {
        const task = await readCogSeedTask(userId, taskId);
        if (!task) throw new Error('CogSeed task not found');
        if (terminal(task)) return { task, cancelled: false as const };
        if (!cancellationOptions.ignoreReplacement) {
          const replacement = (await listCogSeedTasks(userId)).find((candidate) => (
            candidate.retryOfTaskId === taskId && candidate.status !== 'cancelled'
          ));
          if (replacement) throw new Error('CogSeed task replacement already started');
        }
        try {
          return {
            task: await transitionCogSeedTask(userId, taskId, 'cancelled', {}),
            cancelled: true as const,
          };
        } catch (error) {
          const latest = await readCogSeedTask(userId, taskId);
          if (!latest || !terminal(latest)) throw error;
          return { task: latest, cancelled: false as const };
        }
      });
      activeRuns.get(taskId)?.abort('user_cancelled');
      if (!outcome.cancelled) return outcome.task;
      projectTaskEventDetached(userId, outcome.task, {
        eventId: `cogseed-event-terminal-${taskId}`,
        type: 'task.cancelled',
        payload: {},
      }, projectTaskEvent);
      try { await options.cancelChildrenForParent?.(userId, taskId); }
      catch (error) { log.warn('CogSeed child cancellation cleanup failed', { error: logErrorRef(error) }); }
      return outcome.task;
    });
    cancellationClaims.set(claimKey, cancellation);
    const clear = () => {
      if (cancellationClaims.get(claimKey) === cancellation) cancellationClaims.delete(claimKey);
    };
    void cancellation.then(clear, clear);
    return cancellation;
  }

  async function cancelConversationTasksForDeletion(
    userId: string,
    conversationId: string,
    ignoreReplacement = false,
  ): Promise<{ cancelled: CogSeedTaskRecord[]; settled: Promise<void> }> {
    const active = (await listCogSeedTasks(userId)).filter((task) => (
      task.conversationId === conversationId && !terminal(task)
    ));
    const settling = active
      .map((task) => activeRunPromises.get(task.taskId))
      .filter((run): run is Promise<void> => !!run);
    const cancelled: CogSeedTaskRecord[] = [];
    // A source cannot be cancelled while a live replacement exists. Cancel
    // leaves/replacements first, then walk back toward their source/parent.
    // Each cancelTask acquires and releases its own Task lock; this loop never
    // nests one Task operation lock inside another.
    for (const task of cancellationOrder(active)) {
      cancelled.push(await cancelTask(userId, task.taskId, { ignoreReplacement }));
    }
    return {
      cancelled,
      settled: Promise.allSettled(settling).then(() => undefined),
    };
  }

  function reserveSourceOperation(
    userId: string,
    sourceTaskId: string,
    kind: 'replacement' | 'resume',
    requestId: string,
    requestFingerprint: string,
    operation: () => Promise<CogSeedTaskRecord>,
  ): Promise<CogSeedTaskRecord> {
    const key = `${userId}:${sourceTaskId}`;
    const inFlight = sourceOperationClaims.get(key);
    if (inFlight) {
      if (inFlight.requestId === requestId && inFlight.requestFingerprint === requestFingerprint) {
        return inFlight.promise;
      }
      if (inFlight.requestId === requestId) {
        return Promise.reject(new Error('CogSeed request ID payload conflict'));
      }
      return Promise.reject(new Error('CogSeed source task operation is already in progress'));
    }

    // Defer the operation by one microtask so the reservation is observable
    // before source reads or Conversation resolution can yield to a competitor.
    const reserved = Promise.resolve().then(operation);
    sourceOperationClaims.set(key, { kind, requestId, requestFingerprint, promise: reserved });
    const clear = () => {
      if (sourceOperationClaims.get(key)?.promise === reserved) sourceOperationClaims.delete(key);
    };
    void reserved.then(clear, clear);
    return reserved;
  }

  function performReplacementOperation(
    userId: string,
    sourceTaskId: string,
    requestId: string,
    operation: () => Promise<CogSeedTaskRecord>,
  ): Promise<CogSeedTaskRecord> {
    return withCogSeedTaskOperation(userId, sourceTaskId, async () => {
      const source = await readCogSeedTask(userId, sourceTaskId);
      if (!source) throw new Error('CogSeed task not found');
      if (source.status === 'completed' || source.status === 'cancelled') {
        throw new Error('CogSeed source task is not replaceable');
      }
      const prior = (await listCogSeedTasks(userId)).find((candidate) => (
        candidate.retryOfTaskId === sourceTaskId
        && candidate.requestId !== requestId
        && candidate.status !== 'cancelled'
      ));
      if (prior) throw new Error('CogSeed task already has a replacement');
      return operation();
    });
  }

  async function performStartTaskUnlocked(userId: string, input: StartCogSeedTaskInput): Promise<CogSeedTaskRecord> {
    const created = await createCogSeedTask(userId, input);
    if (!created.created && (created.task.status !== 'created' || created.task.runtimeWorkerId)) return created.task;
    const capabilities = await resolveRuntimeCapabilities(userId, created.task.requestId, created.task.runtimeSessionId);
    const launchInput: StartCogSeedTaskInput & { runtimeSessionId?: string } = {
      ...input,
      ...(created.task.abilityAssetIds ? { abilityAssetIds: created.task.abilityAssetIds } : {}),
      ...(created.task.workingDir ? { workingDir: created.task.workingDir } : {}),
      capabilities,
    };
    const conversationId = await resolveConversationIdForTask(userId, created.task, input);
    launchInput.context = await buildTaskExecutionContext(userId, created.task, launchInput, conversationId);
    return launchTask(userId, created.task, launchInput);
  }

  function performStartTask(userId: string, input: StartCogSeedTaskInput): Promise<CogSeedTaskRecord> {
    return withCogSeedUserLaunchRecoveryAdmission(userId, () => performStartTaskUnlocked(userId, input));
  }

  async function startTask(userId: string, input: StartCogSeedTaskInput): Promise<CogSeedTaskRecord> {
    const conversationId = await resolveInputConversationId(userId, input);
    return withTaskConversationAdmission(
      userId,
      conversationId,
      input.executionKind,
      () => performStartTask(userId, input),
    );
  }

  async function retryTaskUnlocked(userId: string, taskId: string, requestId: string): Promise<CogSeedTaskRecord> {
    const operation = async (): Promise<CogSeedTaskRecord> => {
      const retried = await retryStoredCogSeedTask(userId, taskId, requestId);
      if (retried.executionKind === 'group-chat') throw new Error('Group Chat tasks cannot run in CogSeed Runtime');
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
        ...(retried.abilityAssetIds ? { abilityAssetIds: retried.abilityAssetIds } : {}),
        ...(retried.workingDir ? { workingDir: retried.workingDir } : {}),
        capabilities,
      };
      const retryConversationId = await resolveConversationIdForTask(userId, retried, retryInput);
      retryInput.context = await buildTaskExecutionContext(userId, retried, retryInput, retryConversationId);
      return launchTask(userId, retried, retryInput);
    };
    return operation();
  }

  function retryTask(userId: string, taskId: string, requestId: string): Promise<CogSeedTaskRecord> {
    return withCogSeedUserLaunchRecoveryAdmission(
      userId,
      () => retryTaskUnlocked(userId, taskId, requestId),
    );
  }

  function recoverResultDelivery(
    userId: string,
    initial: CogSeedTaskRecord,
    allowInactiveExecutionRecovery = false,
  ): Promise<CogSeedTaskRecord> {
    if (!initial.executionId) return Promise.reject(new Error('CogSeed task result is not recoverable'));
    const claimKey = `${userId}:${initial.executionId}`;
    const inFlight = resultDeliveryClaims.get(claimKey);
    if (inFlight) return inFlight;
    const recovery = Promise.resolve().then(() => withCogSeedTaskOperation(
      userId,
      initial.taskId,
      async (): Promise<CogSeedTaskRecord> => {
        const task = await readCogSeedTask(userId, initial.taskId);
        if (!task) throw new Error('CogSeed task not found');
        if (task.resultDeliveryState === 'delivered') {
          if (!terminal(task)) throw new Error('CogSeed delivered result has no terminal task');
          try { await resultDeliveryStore.remove(userId, task.executionId!); }
          catch (error) { log.warn('CogSeed delivered-result cleanup failed', { error: logErrorRef(error) }); }
          return task;
        }
        if (task.resultDeliveryState === 'not-applicable' && terminal(task)) return task;
        if ((task.resultDeliveryState !== 'pending-recovery' && task.resultDeliveryState !== 'pending')
          || !task.executionId || !task.conversationId || !task.agentId || task.executionKind === 'group-chat') {
          throw new Error('CogSeed task result is not recoverable');
        }
        if (!terminal(task) && task.status !== 'recoverable'
          && (!allowInactiveExecutionRecovery || activeRuns.has(task.taskId))) {
          throw new Error('CogSeed task result cannot be delivered before execution is recoverable');
        }
        return task;
      },
    )).then(async (task) => {
      if (task.resultDeliveryState === 'delivered' || task.resultDeliveryState === 'not-applicable') return task;
      let outcome = await reconcileCogSeedExecutionResult(userId, task.executionId!, {
        store: resultDeliveryStore,
        projectTaskEvent,
        allowInactiveExecutionRecovery,
        isExecutionActive: (taskId) => activeRuns.has(taskId),
        leaseWaitMs: 1_000,
      });
      if (outcome.status === 'pending' && outcome.reason === 'execution-active') {
        // 预检（任务操作锁内）与 reconcile 的内部重读之间存在 TOCTOU 窗口：
        // 负载下任务状态可能恰好被并发结算推进到中间态，reconcile 因此误判
        // execution-active。这里重读一次任务，若已是终态/recoverable 则重试
        // 一次 reconcile，而不是把可恢复的瞬态当作硬失败抛给调用方。
        const current = await readCogSeedTask(userId, task.taskId);
        if (current && (terminal(current) || current.status === 'recoverable')) {
          outcome = await reconcileCogSeedExecutionResult(userId, task.executionId!, {
            store: resultDeliveryStore,
            projectTaskEvent,
            allowInactiveExecutionRecovery,
            isExecutionActive: (taskId) => activeRuns.has(taskId),
            leaseWaitMs: 1_000,
          });
        }
      }
      if (outcome.task && (outcome.status === 'delivered' || outcome.status === 'cleaned'
        || outcome.status === 'quarantined')) return outcome.task;
      if (outcome.status === 'lease-busy') throw new Error('CogSeed result delivery is already in progress');
      throw new Error(outcome.reason === 'projection-failed'
        ? 'CogSeed result writeback failed'
        : 'CogSeed pending result is unavailable');
    });
    resultDeliveryClaims.set(claimKey, recovery);
    const clearRecovery = () => {
      if (resultDeliveryClaims.get(claimKey) === recovery) resultDeliveryClaims.delete(claimKey);
    };
    void recovery.then(clearRecovery, clearRecovery);
    return recovery;
  }

  async function settleReplacementSource(
    userId: string,
    taskId: string,
  ): Promise<{ task: CogSeedTaskRecord; recoveredResult: boolean }> {
    const initial = await readCogSeedTask(userId, taskId);
    if (!initial) throw new Error('CogSeed task not found');
    const priorRun = activeRunPromises.get(taskId);
    if (priorRun) await priorRun;
    const settled = await readCogSeedTask(userId, taskId);
    if (!settled) throw new Error('CogSeed task not found');
    if (settled.executionId && await resultDeliveryStore.read(userId, settled.executionId)) {
      return {
        task: await recoverResultDelivery(userId, settled, true),
        recoveredResult: true,
      };
    }
    return { task: settled, recoveredResult: false };
  }

  return {
    async startCogSeedTask(userId, input) {
      watchUser(userId);
      if (!input.retryOfTaskId) return startTask(userId, input);
      const requestFingerprint = cogSeedRequestFingerprint('create', input);
      return reserveSourceOperation(
        userId,
        input.retryOfTaskId,
        'replacement',
        input.requestId,
        requestFingerprint,
        async () => {
          const source = await settleReplacementSource(userId, input.retryOfTaskId!);
          if (source.recoveredResult) return source.task;
          const conversationId = await resolveInputConversationId(userId, input);
          return withTaskConversationAdmission(
            userId,
            conversationId,
            input.executionKind,
            () => performReplacementOperation(
              userId,
              input.retryOfTaskId!,
              input.requestId,
              () => performStartTask(userId, input),
            ),
          );
        },
      );
    },

    async retryCogSeedTask(userId, taskId, requestId) {
      watchUser(userId);
      const requestFingerprint = cogSeedRequestFingerprint('retry', { taskId });
      return reserveSourceOperation(
        userId,
        taskId,
        'replacement',
        requestId,
        requestFingerprint,
        async () => {
          const source = await settleReplacementSource(userId, taskId);
          if (source.recoveredResult) return source.task;
          return withTaskConversationAdmission(
            userId,
            source.task.conversationId,
            source.task.executionKind,
            () => performReplacementOperation(
              userId,
              taskId,
              requestId,
              () => retryTask(userId, taskId, requestId),
            ),
          );
        },
      );
    },

    async resumeCogSeedTask(userId, taskId, input) {
      watchUser(userId);
      const continuation = input.continuation.trim();
      if (!continuation) throw new Error('CogSeed continuation is required');
      const requestFingerprint = cogSeedRequestFingerprint('resume', {
        taskId,
        continuation,
        profileId: input.profileId,
        context: input.context,
        attachments: input.attachments,
        workingDir: input.workingDir,
        coordinationId: input.coordinationId,
        parentTaskId: input.parentTaskId,
        coordinationDepth: input.coordinationDepth,
      });
      return reserveSourceOperation(
        userId,
        taskId,
        'resume',
        input.requestId,
        requestFingerprint,
        async () => {
          const current = await readCogSeedTask(userId, taskId);
          if (!current) throw new Error('CogSeed task not found');
          if (current.executionKind === 'group-chat') throw new Error('Group Chat tasks cannot run in CogSeed Runtime');
          if (current.lastResumeRequestId === input.requestId
            && current.lastResumeRequestFingerprint
            && current.lastResumeRequestFingerprint !== requestFingerprint) {
            throw new Error('CogSeed request ID payload conflict');
          }
          if (current.lastResumeRequestId === input.requestId && current.status !== 'recoverable') return current;
          if (current.status === 'completed' || current.status === 'cancelled') return current;
          if (current.status !== 'recoverable') throw new Error('CogSeed task is not resumable');

          // A live executor may have been externally marked recoverable while
          // it is still winding down. Never wait for that executor while
          // holding the Conversation or Task operation lock: its late terminal
          // callback needs the Task lock in order to settle.
          const priorRun = activeRunPromises.get(taskId);
          if (priorRun) await priorRun;
          const settled = await readCogSeedTask(userId, taskId);
          if (!settled) throw new Error('CogSeed task not found');
          if (settled.lastResumeRequestId === input.requestId
            && settled.lastResumeRequestFingerprint
            && settled.lastResumeRequestFingerprint !== requestFingerprint) {
            throw new Error('CogSeed request ID payload conflict');
          }
          if (settled.lastResumeRequestId === input.requestId && settled.status !== 'recoverable') return settled;
          if (settled.status === 'completed' || settled.status === 'cancelled') return settled;
          if (settled.executionId && await resultDeliveryStore.read(userId, settled.executionId)) {
            return recoverResultDelivery(userId, settled, true);
          }
          const performResume = async (): Promise<CogSeedTaskRecord> => {
            const latest = await readCogSeedTask(userId, taskId);
            if (!latest) throw new Error('CogSeed task not found');
            if (latest.lastResumeRequestId === input.requestId
              && latest.lastResumeRequestFingerprint
              && latest.lastResumeRequestFingerprint !== requestFingerprint) {
              throw new Error('CogSeed request ID payload conflict');
            }
            if (latest.lastResumeRequestId === input.requestId && latest.status !== 'recoverable') return latest;
            if (latest.status === 'completed' || latest.status === 'cancelled') return latest;
            if (latest.status !== 'recoverable') throw new Error('CogSeed task is not resumable');
            const replacement = (await listCogSeedTasks(userId)).find((candidate) => (
              candidate.retryOfTaskId === taskId && candidate.status !== 'cancelled'
            ));
            if (replacement) throw new Error('CogSeed task already has a replacement');
            const reserved = await updateCogSeedTask(userId, taskId, (task) => {
              if (task.status !== 'recoverable') throw new Error('CogSeed task is not resumable');
              if (task.lastResumeRequestId === input.requestId) {
                if (task.lastResumeRequestFingerprint && task.lastResumeRequestFingerprint !== requestFingerprint) {
                  throw new Error('CogSeed request ID payload conflict');
                }
                return task;
              }
              return { ...task, lastResumeRequestId: input.requestId, lastResumeRequestFingerprint: requestFingerprint };
            });
            if (reserved.executionKind === 'group-chat') throw new Error('Group Chat tasks cannot run in CogSeed Runtime');
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
              ...(reserved.abilityAssetIds ? { abilityAssetIds: reserved.abilityAssetIds } : {}),
              ...(input.profileId || reserved.profileId ? { profileId: input.profileId || reserved.profileId } : {}),
              ...(input.context ? { context: input.context } : {}),
              ...(input.attachments ? { attachments: input.attachments } : {}),
              ...(input.workingDir || reserved.workingDir ? { workingDir: input.workingDir || reserved.workingDir } : {}),
              capabilities: await resolveRuntimeCapabilities(userId, input.requestId, reserved.runtimeSessionId),
            };
            const conversationId = await resolveConversationIdForTask(userId, reserved, resumeInput);
            resumeInput.context = await buildTaskExecutionContext(userId, reserved, resumeInput, conversationId);
            return launchTask(userId, reserved, resumeInput);
          };
          return withTaskConversationAdmission(
            userId,
            settled.conversationId,
            settled.executionKind,
            () => withCogSeedTaskOperation(userId, taskId, performResume),
          );
        },
      );
    },

    async retryCogSeedResultDelivery(userId, taskId) {
      watchUser(userId);
      const initial = await readCogSeedTask(userId, taskId);
      if (!initial) throw new Error('CogSeed task not found');
      return recoverResultDelivery(userId, initial);
    },

    async cancelCogSeedTask(userId, taskId) {
      watchUser(userId);
      return cancelTask(userId, taskId);
    },

    async cancelConversationTasks(userId, conversationId) {
      watchUser(userId);
      const cancellation = await cancelConversationTasksForDeletion(userId, conversationId, true);
      await cancellation.settled;
      return cancellation.cancelled;
    },

    async cancelConversationTasksForDeletion(userId, conversationId) {
      watchUser(userId);
      return cancelConversationTasksForDeletion(userId, conversationId, true);
    },

    async reconcileConversationResultDeliveries(userId, conversationId) {
      watchUser(userId);
      await reconcileCogSeedConversationResults(userId, conversationId, {
        store: resultDeliveryStore,
        projectTaskEvent,
        allowInactiveExecutionRecovery: true,
        isExecutionActive: (taskId) => activeRuns.has(taskId),
      });
    },

    async recoverOrphanedTasks(userId) {
      watchUser(userId);
      const inFlight = orphanRecoveryClaims.get(userId);
      if (inFlight) return inFlight;
      const recovery = (async (): Promise<CogSeedRecoveryReport> => {
        const recovered = await withCogSeedUserLaunchRecoveryAdmission(userId, async () => {
          const candidates = await listCogSeedTasks(userId);
          const records: CogSeedTaskRecord[] = [];
          for (const candidate of candidates) {
            const updated = await withCogSeedLaunchRecoveryOperation(userId, candidate.taskId, async () => {
              if (launchClaims.has(candidate.taskId) || activeRuns.has(candidate.taskId)) return null;
              const current = await readCogSeedTask(userId, candidate.taskId);
              if (!current || (current.status !== 'created' && current.status !== 'queued'
                && current.status !== 'running' && current.status !== 'waiting_user')) return null;
              let recoverable: CogSeedTaskRecord;
              try {
                recoverable = await markCogSeedTaskRecoverable(userId, current.taskId, 'worker_restart');
              } catch (error) {
                const latest = await readCogSeedTask(userId, current.taskId);
                if (latest && terminal(latest)) return null;
                throw error;
              }
              await projectTaskEventBounded(userId, recoverable, {
                eventId: `cogseed-event-recovery-${recoverable.taskId}`,
                type: 'task.recoverable',
                payload: { errorCode: 'worker_restart' },
              }, projectTaskEvent);
              return recoverable;
            });
            if (updated) records.push(updated);
          }
          return records;
        });
        const collaborationRecovery = await recoverCogSeedCollaborationSteps(userId);
        const taskIds = recovered.map((task) => task.taskId);
        await writeJson(cogseedRecoveryStateFile(userId), {
          schemaVersion: 1,
          ownerId: userId,
          recoveredAt: nowIso(),
          recoveredTaskIds: taskIds,
        });
        return {
          recoveredCount: taskIds.length,
          workflowStepsReconciled: collaborationRecovery.reconciledCount,
          dispatchedCount: 0,
          taskIds,
        };
      })();
      orphanRecoveryClaims.set(userId, recovery);
      const clearRecovery = () => {
        if (orphanRecoveryClaims.get(userId) === recovery) orphanRecoveryClaims.delete(userId);
      };
      void recovery.then(clearRecovery, clearRecovery);
      return recovery;
    },

    async scanRuntimeHealth(userId) {
      watchUser(userId);
      runtimeHealthWatchdog?.start();
      return runtimeHealthWatchdog?.scanNow() ?? {
        scannedCount: 0,
        recoveredCount: 0,
        failedCount: 0,
        states: { active: 0, 'slow-but-alive': 0, stale: 0, orphaned: 0 },
      };
    },

    async runtimeStatus() {
      return { backend: 'cogseed', activeTaskCount: activeRuns.size, activeTaskIds: Array.from(activeRuns.keys()) };
    },

    async restartRuntime() {
      if (runtimeRestart) {
        await runtimeRestart;
        return { restarted: true as const };
      }
      let releaseRestart!: () => void;
      runtimeRestart = new Promise<void>((resolve) => { releaseRestart = resolve; });
      try {
        const launching = [...launchClaims.values()];
        for (const signal of activeRuns.values()) signal.abort('runtime_restart');
        await Promise.allSettled(launching);
        for (const signal of activeRuns.values()) signal.abort('runtime_restart');
        await runtime.shutdown();
        await Promise.allSettled([...activeRunPromises.values()]);
      } finally {
        const restart = runtimeRestart;
        runtimeRestart = null;
        releaseRestart();
        await restart;
      }
      return { restarted: true as const };
    },

    shutdown() {
      if (runtimeShutdown) return runtimeShutdown;
      runtimeShutdown = (async () => {
        await runtimeHealthWatchdog?.shutdown();
        const launching = [...launchClaims.values()];
        for (const signal of activeRuns.values()) signal.abort('runtime_shutdown');
        await Promise.allSettled(launching);
        for (const signal of activeRuns.values()) signal.abort('runtime_shutdown');
        await runtime.shutdown();
        await Promise.allSettled([...activeRunPromises.values()]);
      })();
      return runtimeShutdown;
    },
  };
}


export const cogseedRuntimeController: CogSeedRuntimeController = (() => {
  let controller: CogSeedRuntimeController;
  controller = createCogSeedRuntimeController({
    runtimeHealthWatchdog: { autoStart: true },
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
