import { createHash } from 'crypto';

/**
 * Deterministic envelope signature for touchpoint card actions.
 *
 * The card is authored and the click is received by the same application, so
 * the signature is a tamper-evident digest rather than a keyed MAC: both ends
 * can recompute it from the intent, and the receipt contract
 * (`validateTouchpointActionEnvelope`) only requires a well-formed value.
 * The operator identity check on the click side lives in the messaging
 * instance policy (`allowUserIds`), not here.
 */
export function signTouchpointAction(
  intentId: string,
  userId: string,
  action: string,
  occurredAt: string,
): string {
  return createHash('sha256')
    .update(`${intentId}|${userId}|${action}|${occurredAt}`, 'utf8')
    .digest('hex');
}
