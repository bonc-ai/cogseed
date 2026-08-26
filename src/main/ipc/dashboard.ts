/**
 * Dashboard IPC (智能体总览 2.0).
 *
 * This layer validates renderer payloads, injects userId, and delegates to the
 * feature layer (usage ledger, runtime stats, group chat). It owns no business
 * logic itself — same contract as touchpoints.ts.
 */
import * as usageLedger from '../features/usage_ledger';
import type { UsageDimension } from '../features/usage_ledger';
import { agentHealthFromTasks, nonTerminalStatuses } from '../features/dashboard_health';
import { listCogSeedTasks } from '../features/cogseed_backend/task-store';
import { listExternalGateways } from '../features/p3394_bridge/external-gateways';
import { detectAll } from '../features/local_agents/registry.js';
import { listRemoteNodes } from '../features/p3394_bridge/remote-nodes';
import { listP3394Peers } from '../features/p3394_bridge/app-wiring';
import { listAgents } from '../features/agents';
import { listInstances } from '../features/messaging/manager';

interface DashboardContext {
  userId: string;
}

type Handler = (payload: Record<string, unknown>, ctx: DashboardContext) => Promise<unknown> | unknown;

function usageDimension(value: unknown): UsageDimension {
  if (value === 'day' || value === 'agent' || value === 'conversation') return value;
  throw new Error('invalid usage dimension');
}

function epochMs(value: unknown, fallback: () => number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback();
}

export const invokeHandlers: Record<string, Handler> = {
  'dashboard.cost.query': async (payload, ctx) => {
    const dimension = usageDimension(payload?.dimension);
    const now = Date.now();
    const from = epochMs(payload?.from, () => now - 7 * 24 * 3600 * 1000);
    const to = epochMs(payload?.to, () => now);
    return {
      aggregate: await usageLedger.aggregateUsage(ctx.userId, { dimension, from, to }),
    };
  },

  // One round-trip for the overview home: health (from the task ledger),
  // in-flight tasks, and the roster (external CLI / remote nodes / agents /
  // channel instances). The renderer keeps its per-source detail calls for
  // interactions; this snapshot is the page's first paint.
  'dashboard.overview.snapshot': async (_payload, ctx) => {
    const [tasks, entries, gateways, remote, agents, instances] = await Promise.all([
      listCogSeedTasks(ctx.userId),
      detectAll().catch(() => []),
      Promise.resolve(listExternalGateways()).catch(() => []),
      Promise.resolve(listRemoteNodes()).catch(() => []),
      listAgents().catch(() => []),
      listInstances(ctx.userId).catch(() => []),
    ]);
    // Same roster assembly as p3394.external.list: bound-agent markers from
    // agent runtimes + the P3394 peer registry (online/disabled state).
    let bound: Record<string, string[]> = {};
    try {
      bound = {};
      for (const agent of agents) {
        const rt = agent.runtime as { kind?: string; cli?: string } | undefined;
        if (rt && rt.kind === 'p3394-gateway' && rt.cli) {
          (bound[rt.cli] ??= []).push(agent.name || rt.cli);
        }
      }
    } catch { /* best effort */ }
    const peers = listP3394Peers();
    const running = tasks
      .filter((t) => nonTerminalStatuses.has(t.status))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((t) => ({
        taskId: t.taskId,
        status: t.status,
        ...(t.conversationId ? { conversationId: t.conversationId } : {}),
        ...(t.agentId ? { agentId: t.agentId } : {}),
        ...(t.task ? { taskHead: String(t.task).slice(0, 80) } : {}),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    return {
      health: agentHealthFromTasks(tasks),
      runningTasks: running,
      roster: {
        external: { entries, gateways, bound, peers },
        remote,
        agents,
        instances,
      },
    };
  },
};
