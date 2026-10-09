// SPDX-FileCopyrightText: 2025 AI Agent Board Contributors
// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import type { CogSeedTaskRecord } from './types';

export interface CogSeedBoardGroupProgress {
  total: number;
  completed: number;
  failed: number;
  active: number;
  attention: number;
}

/** Adapted from AI Agent Board's group status counter for CogSeed task states. */
export function computeCogSeedBoardGroupProgress(tasks: readonly CogSeedTaskRecord[]): CogSeedBoardGroupProgress {
  const progress: CogSeedBoardGroupProgress = {
    total: tasks.length,
    completed: 0,
    failed: 0,
    active: 0,
    attention: 0,
  };
  for (const task of tasks) {
    if (task.status === 'completed') progress.completed += 1;
    else if (task.status === 'failed' || task.status === 'cancelled') progress.failed += 1;
    else if (task.status === 'waiting_user' || task.status === 'recoverable') progress.attention += 1;
    else progress.active += 1;
  }
  return progress;
}
