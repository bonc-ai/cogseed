/**
 * Dashboard IPC (智能体总览 2.0).
 *
 * This layer validates renderer payloads, injects userId, and delegates to the
 * feature layer (usage ledger, runtime stats, group chat). It owns no business
 * logic itself — same contract as touchpoints.ts.
 */
import * as usageLedger from '../features/usage_ledger';
import type { UsageDimension } from '../features/usage_ledger';

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
};
