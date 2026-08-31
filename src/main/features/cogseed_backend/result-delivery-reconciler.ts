// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { finalizeCogSeedTaskFromRetainedResult } from './lifecycle';
import {
  acquireCogSeedResultDeliveryLease,
  type CogSeedResultDeliveryLease,
} from './result-delivery-lease';
import {
  cogseedResultDeliveryStore,
  type CogSeedPendingResultFile,
  type CogSeedReadablePendingResultDelivery,
  type CogSeedResultDeliveryStore,
} from './result-delivery-store';
import { readCogSeedSession } from './session-store';
import { readCogSeedTask, updateCogSeedTask } from './task-store';
import type { CogSeedGroupChatProjectionInput } from './group-chat-projection';
import type { CogSeedTaskRecord } from './types';

const log = createLogger('cogseed-backend:result-delivery-reconciler');

export type CogSeedResultReconcileStatus = 'delivered' | 'pending' | 'quarantined' | 'lease-busy' | 'cleaned';

export interface CogSeedResultReconcileOutcome {
  status: CogSeedResultReconcileStatus;
  task?: CogSeedTaskRecord;
  reason?: string;
}

export interface CogSeedResultDeliveryReconcilerOptions {
  store?: CogSeedResultDeliveryStore;
  projectTaskEvent?: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>;
  allowInactiveExecutionRecovery?: boolean;
  isExecutionActive?: (taskId: string) => boolean;
  leaseWaitMs?: number;
  /** Wall-clock budget for the group-chat projection step (default 1000ms).
   * Live delivery keeps it tight (interactive latency); boot-time recovery
   * passes a larger budget — the projection can exceed 1s under first-boot
   * and CI-suite load, and a false "pending" there stalls retained results
   * until the next boot. */
  projectionTimeoutMs?: number;
}

function terminalStatus(retained: CogSeedReadablePendingResultDelivery): 'completed' | 'failed' {
  return retained.event.type === 'task.completed' ? 'completed' : 'failed';
}

function terminalPayload(retained: CogSeedReadablePendingResultDelivery): { outputChars?: number; errorCode?: string } {
  const status = terminalStatus(retained);
  if (status === 'completed') {
    const text = typeof retained.event.payload.text === 'string' ? retained.event.payload.text : '';
    return { outputChars: text.length };
  }
  const code = typeof retained.event.payload.code === 'string' ? retained.event.payload.code : undefined;
  return code ? { errorCode: code } : {};
}

function exactTaskBinding(task: CogSeedTaskRecord, retained: CogSeedReadablePendingResultDelivery): boolean {
  return task.executionKind !== 'group-chat'
    && task.taskId === retained.taskId
    && task.executionId === retained.executionId
    && task.conversationId === retained.conversationId
    && task.agentId === retained.agentId
    && task.sessionId === retained.sessionId;
}

function terminalConflict(task: CogSeedTaskRecord, retained: CogSeedReadablePendingResultDelivery): boolean {
  const expected = terminalStatus(retained);
  return task.status === 'cancelled'
    || (task.status === 'completed' && expected !== 'completed')
    || (task.status === 'failed' && expected !== 'failed');
}

async function defaultProjectTaskEvent(input: CogSeedGroupChatProjectionInput): Promise<unknown> {
  const { cogseedGroupChatProjection } = await import('./group-chat-projection');
  return cogseedGroupChatProjection.project(input);
}

async function projectBounded(
  input: CogSeedGroupChatProjectionInput,
  projectTaskEvent: (input: CogSeedGroupChatProjectionInput) => Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      projectTaskEvent(input).then((value) => value === 'dropped' ? false : true, () => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function quarantineAndRemove(
  userId: string,
  pendingFile: CogSeedPendingResultFile,
  reason: string,
  store: CogSeedResultDeliveryStore,
  lease?: CogSeedResultDeliveryLease,
): Promise<void> {
  await lease?.assertOwned();
  await store.quarantine(userId, pendingFile.fileName, reason);
  // Deliberately separate operations: after a crash in this window, the next
  // retry observes the immutable archive and only repeats pending removal.
  await lease?.assertOwned();
  await store.removePendingFile(userId, pendingFile.fileName);
}

async function settleNotApplicable(
  userId: string,
  retained: CogSeedReadablePendingResultDelivery,
): Promise<CogSeedTaskRecord> {
  const finalized = await finalizeCogSeedTaskFromRetainedResult(
    userId,
    retained.taskId,
    terminalStatus(retained),
    terminalPayload(retained),
  );
  return updateCogSeedTask(userId, finalized.taskId, (current) => {
    if (!exactTaskBinding(current, retained)) throw new Error('CogSeed task binding changed during result reconciliation');
    return { ...current, resultDeliveryState: 'not-applicable' };
  });
}

async function quarantineBoundResult(
  userId: string,
  pendingFile: CogSeedPendingResultFile,
  retained: CogSeedReadablePendingResultDelivery,
  reason: string,
  store: CogSeedResultDeliveryStore,
  mutateTask: boolean,
  lease: CogSeedResultDeliveryLease,
): Promise<CogSeedResultReconcileOutcome> {
  await lease.assertOwned();
  await store.quarantine(userId, pendingFile.fileName, reason);
  await lease.assertOwned();
  const task = mutateTask ? await settleNotApplicable(userId, retained) : undefined;
  await lease.assertOwned();
  await store.removePendingFile(userId, pendingFile.fileName);
  return { status: 'quarantined', ...(task ? { task } : {}), reason };
}

export async function reconcileCogSeedPendingResult(
  userId: string,
  pendingFile: CogSeedPendingResultFile,
  options: CogSeedResultDeliveryReconcilerOptions = {},
): Promise<CogSeedResultReconcileOutcome> {
  const store = options.store ?? cogseedResultDeliveryStore;
  if (!pendingFile.executionId) {
    await quarantineAndRemove(userId, pendingFile, 'malformed-filename', store);
    return { status: 'quarantined', reason: 'malformed-filename' };
  }

  const lease = await acquireCogSeedResultDeliveryLease(userId, pendingFile.executionId, {
    waitMs: options.leaseWaitMs,
  });
  if (!lease) return { status: 'lease-busy' };
  try {
    let retained: CogSeedReadablePendingResultDelivery | null;
    try {
      retained = await store.read(userId, pendingFile.executionId);
    } catch {
      await quarantineAndRemove(userId, pendingFile, 'malformed-record', store, lease);
      return { status: 'quarantined', reason: 'malformed-record' };
    }
    if (!retained) return { status: 'cleaned' };

    const task = await readCogSeedTask(userId, retained.taskId);
    if (!task) {
      await quarantineAndRemove(userId, pendingFile, 'task-missing', store, lease);
      return { status: 'quarantined', reason: 'task-missing' };
    }
    if (!exactTaskBinding(task, retained)) {
      await quarantineAndRemove(userId, pendingFile, 'task-binding-mismatch', store, lease);
      return { status: 'quarantined', task, reason: 'task-binding-mismatch' };
    }
    if (task.resultDeliveryState === 'delivered') {
      await lease.assertOwned();
      await store.remove(userId, retained.executionId);
      return { status: 'cleaned', task };
    }
    if (task.resultDeliveryState === 'not-applicable') {
      await quarantineAndRemove(userId, pendingFile, 'delivery-not-applicable', store, lease);
      return { status: 'quarantined', task, reason: 'delivery-not-applicable' };
    }
    if (terminalConflict(task, retained)) {
      await quarantineAndRemove(userId, pendingFile, 'task-terminal-conflict', store, lease);
      return { status: 'quarantined', task, reason: 'task-terminal-conflict' };
    }
    if (retained.schemaVersion === 1) {
      return await quarantineBoundResult(
        userId, pendingFile, retained, 'legacy-generation-unverified', store, true, lease,
      );
    }

    const session = await readCogSeedSession(userId, retained.sessionId);
    if (!session) {
      return await quarantineBoundResult(userId, pendingFile, retained, 'session-missing', store, true, lease);
    }
    if (session.conversationId !== retained.conversationId || session.agentId !== retained.agentId) {
      await quarantineAndRemove(userId, pendingFile, 'session-binding-mismatch', store, lease);
      return { status: 'quarantined', task, reason: 'session-binding-mismatch' };
    }
    if (session.lifecycleState !== 'active') {
      return await quarantineBoundResult(userId, pendingFile, retained, 'session-inactive', store, true, lease);
    }

    const chats = await import('../chats');
    const destination = await chats.readCogSeedConversationDeliveryBinding(userId, retained.conversationId);
    if (destination.state === 'missing') {
      return await quarantineBoundResult(userId, pendingFile, retained, 'conversation-missing', store, true, lease);
    }
    if (destination.state === 'deleted') {
      return await quarantineBoundResult(userId, pendingFile, retained, 'conversation-deleted', store, true, lease);
    }
    if (!destination.generation || destination.generation !== retained.destinationGeneration) {
      return await quarantineBoundResult(
        userId, pendingFile, retained, 'conversation-generation-mismatch', store, true, lease,
      );
    }

    const canFinalize = task.status === 'recoverable'
      || task.status === 'completed'
      || task.status === 'failed'
      || (options.allowInactiveExecutionRecovery === true && !options.isExecutionActive?.(task.taskId));
    if (!canFinalize) return { status: 'pending', task, reason: 'execution-active' };

    await lease.assertOwned();
    const awaitingDelivery = await finalizeCogSeedTaskFromRetainedResult(
      userId,
      task.taskId,
      terminalStatus(retained),
      terminalPayload(retained),
    );
    await lease.assertOwned();
    const projected = await projectBounded({
      userId,
      conversationId: retained.conversationId,
      agentId: retained.agentId,
      taskId: retained.taskId,
      executionId: retained.executionId,
      sessionId: retained.sessionId,
      event: retained.event,
    }, options.projectTaskEvent ?? defaultProjectTaskEvent, options.projectionTimeoutMs ?? 1_000);
    if (!projected) return { status: 'pending', task: awaitingDelivery, reason: 'projection-failed' };

    await lease.assertOwned();
    const delivered = await updateCogSeedTask(userId, task.taskId, (current) => {
      if (!exactTaskBinding(current, retained)) throw new Error('CogSeed task binding changed during result delivery');
      return { ...current, resultDeliveryState: 'delivered' };
    });
    try {
      await lease.assertOwned();
      await store.remove(userId, retained.executionId);
    } catch (error) {
      log.warn('CogSeed delivered-result cleanup failed', { error: logErrorRef(error) });
    }
    return { status: 'delivered', task: delivered };
  } finally {
    await lease.release();
  }
}

export async function reconcileCogSeedExecutionResult(
  userId: string,
  executionId: string,
  options: CogSeedResultDeliveryReconcilerOptions = {},
): Promise<CogSeedResultReconcileOutcome> {
  return reconcileCogSeedPendingResult(userId, {
    executionId,
    fileName: `${executionId}.json`,
  }, options);
}

export async function reconcileCogSeedConversationResults(
  userId: string,
  conversationId: string,
  options: CogSeedResultDeliveryReconcilerOptions = {},
): Promise<CogSeedResultReconcileOutcome[]> {
  const store = options.store ?? cogseedResultDeliveryStore;
  const outcomes: CogSeedResultReconcileOutcome[] = [];
  for (const pendingFile of await store.listPendingFiles(userId)) {
    if (!pendingFile.executionId) continue;
    let retained: CogSeedReadablePendingResultDelivery | null = null;
    try { retained = await store.read(userId, pendingFile.executionId); } catch { /* reconciler quarantines it */ }
    if (retained && retained.conversationId !== conversationId) continue;
    try {
      outcomes.push(await reconcileCogSeedPendingResult(userId, pendingFile, options));
    } catch (error) {
      log.warn('CogSeed conversation result reconciliation failed', { error: logErrorRef(error) });
      outcomes.push({ status: 'pending', reason: 'reconcile-failed' });
    }
  }
  return outcomes;
}
