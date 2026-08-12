/**
 * Touchpoint IPC.
 *
 * This layer validates renderer payloads, injects userId, and delegates every
 * workflow to features/touchpoints. It does not touch ledger, adapters, or
 * messaging internals directly.
 */
import { safeId } from '../storage';
import * as testDelivery from '../features/touchpoints/test-delivery';

interface TouchpointContext {
  userId: string;
}

type Handler = (payload: Record<string, unknown>, ctx: TouchpointContext) => Promise<unknown> | unknown;

function optionalInstanceId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() && safeId(value.trim())) return value.trim();
  return undefined;
}

export const invokeHandlers: Record<string, Handler> = {
  'touchpoints.test_card_delivery': async (payload, ctx) => testDelivery.testApprovalCardDelivery(
    ctx.userId,
    optionalInstanceId(payload?.instanceId),
  ),
};
