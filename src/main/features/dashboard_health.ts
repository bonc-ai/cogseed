/**
 * Agent health rules for the dashboard overview (设计 2.3 健康防线).
 *
 * Deliberately transparent — the rule itself is displayed to the user, so it
 * must be explainable in one sentence:
 *   样本 < 5 → observing（观察中，不评判）
 *   连续失败 ≥ 3 或 近 10 次成功率 < 50% → alert
 *   其余 → healthy
 *
 * Input is the task ledger (CogSeedTaskRecord terminal statuses) — one data
 * source, no second store. Pure functions only; no IO.
 */

import type { CogSeedTaskRecord } from './cogseed_backend/types';

export const nonTerminalStatuses = new Set(['created', 'queued', 'running', 'waiting_user', 'recoverable']);

export function isTerminalTask(task: CogSeedTaskRecord): boolean {
  return !nonTerminalStatuses.has(task.status);
}

export interface AgentHealth {
  agentId: string;
  /** Terminal-task count for this agent. */
  attempts: number;
  consecutiveFailures: number;
  /** Success rate over the most recent 10 terminal tasks (0–1). */
  recent10SuccessRate: number;
  state: 'healthy' | 'alert' | 'observing';
  /** Newest failure, kept for the alert drill-down (查看该会话/临时停用). */
  lastFailure?: {
    taskId: string;
    conversationId?: string;
    errorCode?: string;
    updatedAt: string;
  };
}

const MIN_SAMPLES = 5;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const RECENT_WINDOW = 10;
const RECENT_RATE_FLOOR = 0.5;

export function agentHealthFromTasks(tasks: CogSeedTaskRecord[]): AgentHealth[] {
  const byAgent = new Map<string, CogSeedTaskRecord[]>();
  for (const t of tasks) {
    if (!isTerminalTask(t)) continue;
    const key = t.agentId || '(direct)';
    const list = byAgent.get(key) || [];
    list.push(t);
    byAgent.set(key, list);
  }
  const out: AgentHealth[] = [];
  for (const [agentId, list] of byAgent) {
    // Newest first — recency rules read from the top.
    list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const recent = list.slice(0, RECENT_WINDOW);
    const successes = recent.filter((t) => t.status === 'completed').length;
    const rate = recent.length > 0 ? successes / recent.length : 0;
    let consecutiveFailures = 0;
    for (const t of list) {
      if (t.status === 'failed') consecutiveFailures += 1;
      else break;
    }
    const latestFailure = list.find((t) => t.status === 'failed');
    const state: AgentHealth['state'] = list.length < MIN_SAMPLES
      ? 'observing'
      : (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD || (recent.length >= MIN_SAMPLES && rate < RECENT_RATE_FLOOR))
        ? 'alert'
        : 'healthy';
    out.push({
      agentId,
      attempts: list.length,
      consecutiveFailures,
      recent10SuccessRate: rate,
      state,
      ...(latestFailure ? {
        lastFailure: {
          taskId: latestFailure.taskId,
          ...(latestFailure.conversationId ? { conversationId: latestFailure.conversationId } : {}),
          ...(latestFailure.errorCode ? { errorCode: latestFailure.errorCode } : {}),
          updatedAt: latestFailure.updatedAt,
        },
      } : {}),
    });
  }
  // Alert first, then observing, then healthy — consumers (sidebar dot,
  // roster sort) want the worst actor on top without re-deriving it.
  const rank = { alert: 0, observing: 1, healthy: 2 } as const;
  out.sort((a, b) => rank[a.state] - rank[b.state] || b.attempts - a.attempts);
  return out;
}
