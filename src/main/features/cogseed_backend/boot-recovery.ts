// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { recoverCogSeedTasks, type CogSeedRecoveryReport } from './recovery';
import { reconcileCogSeedPendingResult } from './result-delivery-reconciler';
import { cogseedResultDeliveryStore } from './result-delivery-store';
import {
  ensureCogSeedTaskCreationArtifacts,
  ensureCogSeedTaskLifecycleArtifact,
  listCogSeedTasks,
} from './task-store';

const log = createLogger('cogseed-backend:boot-recovery');

export interface CogSeedBootRecoveryReport extends CogSeedRecoveryReport {
  retainedResultsRecovered: number;
  retainedResultsPending: number;
  retainedResultsQuarantined: number;
}

/**
 * Reconcile work left by the previous main-process instance before the first
 * BrowserWindow is created. Each Outbox entry is an independent recovery unit:
 * malformed data, binding conflicts, and quarantine failures never abort the
 * remaining entries.
 */
export async function recoverCogSeedTasksAtBoot(userId: string): Promise<CogSeedBootRecoveryReport> {
  const tasks = await listCogSeedTasks(userId);
  for (const task of tasks) {
    await ensureCogSeedTaskCreationArtifacts(userId, task);
  }

  let retainedResultsRecovered = 0;
  let retainedResultsPending = 0;
  let retainedResultsQuarantined = 0;
  const pendingFiles = await cogseedResultDeliveryStore.listPendingFiles(userId);
  for (const pendingFile of pendingFiles) {
    try {
      const outcome = await reconcileCogSeedPendingResult(userId, pendingFile, {
        allowInactiveExecutionRecovery: true,
        isExecutionActive: () => false,
        // Boot-time recovery has no interactive latency to protect: give the
        // group-chat projection a generous budget (default is 1s, which CI and
        // first-boot cold starts can exceed → false "pending" until next boot).
        projectionTimeoutMs: 5_000,
      });
      if (outcome.status === 'delivered' || outcome.status === 'cleaned') retainedResultsRecovered += 1;
      else if (outcome.status === 'quarantined') retainedResultsQuarantined += 1;
      else if (outcome.status === 'pending' || outcome.status === 'lease-busy') retainedResultsPending += 1;
    } catch (error) {
      retainedResultsPending += 1;
      log.warn('CogSeed boot retained-result recovery isolated one failure', {
        error: logErrorRef(error),
      });
    }
  }

  for (const task of await listCogSeedTasks(userId)) {
    await ensureCogSeedTaskLifecycleArtifact(userId, task.taskId);
  }
  const taskRecovery = await recoverCogSeedTasks(userId, { activeTaskIds: [] });
  log.info('CogSeed retained-result boot recovery completed', {
    recovered: retainedResultsRecovered,
    pending: retainedResultsPending,
    quarantined: retainedResultsQuarantined,
  });
  return {
    ...taskRecovery,
    retainedResultsRecovered,
    retainedResultsPending,
    retainedResultsQuarantined,
  };
}
