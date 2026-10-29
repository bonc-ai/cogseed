/** The same complete-contract interaction for conversational creation/editing.
 * This grants one reviewed operation, never an always-allow permission. */
import { t } from '../../i18n';
import { cancelInteractionsForTurn, requestInteraction } from '../chat_events/interaction-hub';

/** Cancellation is trusted execution context, never part of a model contract. */
export function assertCognitionManagementActive(host: { signal?: AbortSignal }): void {
  host.signal?.throwIfAborted();
}
export async function confirmCognitionManagement(host: { userId: string; cid?: string; turnId?: string; signal?: AbortSignal },
  detail: string, titleKey = 'cognition.edit.confirm_title'): Promise<string | undefined> {
  if (!host.cid || !host.turnId || host.signal?.aborted) return undefined;
  const cancel = () => cancelInteractionsForTurn(host.turnId!, { uid: host.userId, cid: host.cid! });
  host.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await requestInteraction({ uid: host.userId, cid: host.cid, turnId: host.turnId,
      kind: 'approval', allowAlways: false, prompt: t(titleKey), detail });
    return !host.signal?.aborted && result.reason === 'answered' && result.decision === 'allow' ? result.interactionId : undefined;
  } finally {
    host.signal?.removeEventListener('abort', cancel);
  }
}
