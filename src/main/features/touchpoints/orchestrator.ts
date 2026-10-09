import { TouchpointContractError } from './errors';
import {
  getTouchpointIntent,
  reserveTouchpointIntent,
  transitionTouchpointIntent,
} from './ledger';
import { planTouchpointEvent } from './planner';
import type {
  TouchpointChannelAdapter,
  TouchpointDomainEvent,
  TouchpointIntent,
  TouchpointPolicyConfig,
} from './types';

export interface OrchestrateTouchpointOptions {
  policy: TouchpointPolicyConfig;
  now?: Date;
}

export type OrchestrateTouchpointResult =
  | { status: 'planned'; intent: TouchpointIntent }
  | { status: 'duplicate'; intent: TouchpointIntent }
  | { status: 'suppressed'; reason: 'touchpoint_disabled'; intent: TouchpointIntent };

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  return 'Touchpoint delivery failed.';
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { retryable?: boolean }).retryable === true);
}

export async function orchestrateTouchpointEvent(
  userId: string,
  event: TouchpointDomainEvent,
  options: OrchestrateTouchpointOptions,
): Promise<OrchestrateTouchpointResult> {
  const now = options.now ?? new Date();
  const planned = planTouchpointEvent(userId, event, options.policy, now);
  const reservation = await reserveTouchpointIntent(userId, planned.intent);
  if (!reservation.created) return { status: 'duplicate', intent: reservation.intent };
  if (planned.policyDecision.decision === 'suppress') {
    const suppressed = await transitionTouchpointIntent(userId, planned.intent.intentId, ['planned'], { status: 'suppressed' });
    return { status: 'suppressed', reason: 'touchpoint_disabled', intent: suppressed };
  }
  return { status: 'planned', intent: reservation.intent };
}

export async function dispatchTouchpointIntent(
  userId: string,
  intentId: string,
  adapter: TouchpointChannelAdapter,
  now = new Date(),
): Promise<TouchpointIntent> {
  const intent = await getTouchpointIntent(userId, intentId);
  if (!intent) throw new TouchpointContractError('intent_not_found', 'Touchpoint intent was not found.', 'intentId');
  if (intent.channel !== adapter.channel) {
    throw new TouchpointContractError('channel_mismatch', 'Touchpoint adapter does not match the intent channel.', 'channel');
  }
  if (!['planned', 'retry_pending'].includes(intent.status)) {
    throw new TouchpointContractError('intent_not_dispatchable', `Touchpoint intent is ${intent.status}.`, 'status');
  }
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(nowTimestamp)) {
    throw new TouchpointContractError('invalid_timestamp', 'Touchpoint dispatch time is invalid.', 'now');
  }
  if (nowTimestamp > Date.parse(intent.expiresAt)) {
    return transitionTouchpointIntent(userId, intent.intentId, [intent.status], { status: 'expired' });
  }
  const notBefore = intent.status === 'retry_pending' && intent.nextAttemptAt
    ? Math.max(Date.parse(intent.availableFrom), Date.parse(intent.nextAttemptAt))
    : Date.parse(intent.availableFrom);
  if (nowTimestamp < notBefore) {
    throw new TouchpointContractError('intent_not_available', 'Touchpoint intent is not available for delivery yet.', 'availableFrom');
  }

  const ready = intent.status === 'planned'
    ? await transitionTouchpointIntent(userId, intent.intentId, ['planned'], { status: 'ready' })
    : intent;
  const sending = await transitionTouchpointIntent(userId, ready.intentId, [ready.status], { status: 'sending' });
  try {
    const result = await adapter.send(userId, sending);
    const externalDeliveryId = typeof result.externalDeliveryId === 'string' ? result.externalDeliveryId.trim() : '';
    if (!externalDeliveryId || externalDeliveryId.length > 512 || /[\u0000-\u001f\u007f]/.test(externalDeliveryId)) {
      throw new Error('Touchpoint adapter returned an invalid external delivery id.');
    }
    return transitionTouchpointIntent(userId, sending.intentId, ['sending'], {
      status: 'sent',
      externalDeliveryId,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    if (isRetryable(error)) {
      const retryDelayMs = Math.min(15 * 60_000, 60_000 * (2 ** Math.max(0, sending.attempts - 1)));
      return transitionTouchpointIntent(userId, sending.intentId, ['sending'], {
        status: 'retry_pending',
        error: message,
        nextAttemptAt: new Date(nowTimestamp + retryDelayMs).toISOString(),
      });
    }
    return transitionTouchpointIntent(userId, sending.intentId, ['sending'], {
      status: 'failed',
      error: message,
    });
  }
}
