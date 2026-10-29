/**
 * 关系结束时的交换收尾（AC-10）。
 *
 * 删除联系人是「这段关系结束」的唯一动作，但它落在联系人存储里，交换状态在会话的
 * marker 上——两处必须一起动。少了这一步，会话会继续显示「A2A 来访」并被当成活跃
 * 交换：对端虽然已经发不出新问题（Hub 会拒），本机却还留着一个可以继续接待的会话。
 *
 * 只处理「还能结束」的状态：已结束的会话跳过（幂等），非法转移跳过（状态机说了算）。
 */

import { createLogger } from '../../logger';
import { canTransitionA2AState, transitionA2AConversation } from './conversation-marker';

const log = createLogger('a2a-exchange-lifecycle');

/** 把这个联系人在本机的全部 A2A 会话收尾；返回结束了几条。 */
export async function endExchangesWithPeer(userId: string, peerUserId: string, isCurrent?: () => boolean): Promise<number> {
  const peer = String(peerUserId || '').trim();
  if (!peer) return 0;
  const { updateA2AMarkersIncludingDeletedAtomic } = await import('../chats');
  const ended = await updateA2AMarkersIncludingDeletedAtomic(userId, (marker) => {
    if (marker.peer_user_id !== peer || marker.state === 'ended') return null;
    if (!canTransitionA2AState(marker.state, 'ended')) return null;
    return transitionA2AConversation(marker, 'ended');
  }, isCurrent);
  if (ended) log.info('exchanges ended with a removed contact', { ended });
  return ended;
}

/** Reconcile every still-live A2A peer against the Hub-authoritative roster. */
export async function reconcileExchangesWithContacts(
  userId: string,
  contactPeerUserIds: readonly string[],
  isCurrent?: () => boolean,
): Promise<number> {
  const contacts = new Set(contactPeerUserIds.map((value) => String(value || '').trim()).filter(Boolean));
  const { updateA2AMarkersIncludingDeletedAtomic } = await import('../chats');
  try {
    const ended = await updateA2AMarkersIncludingDeletedAtomic(userId, (marker) => {
      if (marker.state === 'ended' || contacts.has(marker.peer_user_id)) return null;
      if (!canTransitionA2AState(marker.state, 'ended')) return null;
      return transitionA2AConversation(marker, 'ended');
    }, isCurrent);
    if (ended) log.info('exchanges reconciled with contacts', { ended });
    return ended;
  } catch (error) {
    log.warn('reconciling exchanges failed', {
      contactCount: contacts.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
