import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import type { TouchpointActionKind, TouchpointActionRecord } from './types';

/**
 * Business handlers for consumed touchpoint actions.
 *
 * The receipt loop records the action in the ledger and swaps the card to
 * its terminal state; the *effect* of the action (reschedule a briefing,
 * update a task, …) belongs to the owning business feature. Features register
 * handlers here at boot; the messaging manager notifies them after a fresh
 * (non-duplicate) consumption. Handlers never fail the receipt: errors are
 * logged and isolated per handler.
 */

export type TouchpointActionHandler = (userId: string, record: TouchpointActionRecord) => Promise<void> | void;

const handlers = new Map<TouchpointActionKind, Set<TouchpointActionHandler>>();

const log = createLogger('touchpoints:actions');

/** Idempotent: the same handler reference for one action registers once. */
export function registerTouchpointActionHandler(
  action: TouchpointActionKind,
  handler: TouchpointActionHandler,
): void {
  let slot = handlers.get(action);
  if (!slot) {
    slot = new Set();
    handlers.set(action, slot);
  }
  slot.add(handler);
}

export function hasTouchpointActionHandlers(action: TouchpointActionKind): boolean {
  return (handlers.get(action)?.size ?? 0) > 0;
}

/** Notify every handler registered for the consumed action. Errors are
 * isolated: one failing handler never blocks the others, and the receipt
 * outcome is unaffected (callers treat this as fire-and-forget). */
export async function notifyTouchpointActionHandlers(
  userId: string,
  record: TouchpointActionRecord,
): Promise<void> {
  const slot = handlers.get(record.action);
  if (!slot || slot.size === 0) return;
  for (const handler of slot) {
    try {
      await handler(userId, record);
    } catch (error) {
      log.warn('touchpoint action handler failed', {
        userId,
        action: record.action,
        intentId: record.intentId,
        error: logErrorSummary(error),
      });
    }
  }
}
