/**
 * Inbound A2A planning — what to do with a message that arrived for this account.
 *
 * This is the receiving side of the exchange, expressed as a decision instead of a
 * side effect: given the envelope's `a2a` extension and what this account already
 * has, it answers "does this need the receiver's confirmation?", "which marker
 * should the conversation carry?" and "may this message be answered at all?".
 *
 * The rules it enforces come straight from the product decisions:
 * - a message for another account is not ours (D-15);
 * - the **first** question needs the receiver's confirmation (D-04), so it opens a
 *   `waiting` marker and no run starts yet;
 * - once a reception is active, further questions need no re-confirmation (D-11);
 * - an `answer`/`correction` with no open reception is a message from nowhere —
 *   rejecting it is what stops a peer from speaking into a closed exchange (R-10).
 */

import type { A2AExtension } from './extensions';
import { isInboundMarker, type A2AConversationMarker } from './conversation-marker';

export type A2AInboundRejection =
  | 'not_for_me'
  | 'not_cross'
  | 'no_open_reception'
  | 'wrong_direction';

export interface A2AInboundQuestionPlan {
  kind: 'open' | 'continue';
  marker: A2AConversationMarker;
  /** Whether the receiver must confirm before the assistant answers (D-04). */
  needsConfirmation: boolean;
}

export type A2AInboundPlan = A2AInboundQuestionPlan | { rejected: A2AInboundRejection };

export interface A2AInboundInput {
  extension: A2AExtension;
  /** The account this client is running as. */
  localUserId: string;
  /** The account the envelope claims to come from. */
  peerUserId: string;
  /** The marker currently on the conversation, if one exists. */
  existingMarker?: A2AConversationMarker | null;
}

/**
 * Plan the inbound handling of one A2A message.
 *
 * Questions are the only inbound kind that can open an exchange; replies from the
 * peer's assistant are not part of the receiving side's vocabulary (the receiver
 * never asks the peer's assistant directly — D-24), which is why they are rejected
 * here rather than silently dropped later.
 */
export function planInboundA2A(input: A2AInboundInput): A2AInboundPlan {
  const { extension, localUserId, peerUserId, existingMarker } = input;

  if (extension.visibility !== 'cross') return { rejected: 'not_cross' };
  if (!extension.recipient_user || extension.recipient_user !== localUserId) return { rejected: 'not_for_me' };
  if (!peerUserId || peerUserId === localUserId) return { rejected: 'not_for_me' };

  if (extension.kind !== 'question') return { rejected: 'wrong_direction' };

  // An existing marker must belong to the same peer; a question from someone else
  // is a new exchange, not a continuation.
  const samePeer = existingMarker && existingMarker.peer_user_id === peerUserId;
  if (existingMarker && !samePeer) return { rejected: 'wrong_direction' };

  const workspace = samePeer ? existingMarker?.workspace : undefined;

  // 只有「本人已经接受过来访」才免确认；我单向问过对方（outgoing）不算。
  if (samePeer && isInboundMarker(existingMarker) && existingMarker?.state === 'active') {
    return {
      kind: 'continue',
      needsConfirmation: false,
      marker: { ...existingMarker, state: 'active' },
    };
  }

  return {
    kind: 'open',
    // 首次来访：等待接收方本人确认（D-04），助手此时还不会回答。
    needsConfirmation: true,
    marker: {
      ...(existingMarker || {}),
      inbound: true,
      peer_user_id: peerUserId,
      state: 'waiting',
      ...(extension.assistant_agent_id ? { assistant_agent_id: extension.assistant_agent_id } : {}),
      ...(workspace ? { workspace } : {}),
      ...(extension.conversation_id ? { exchange_id: extension.conversation_id } : {}),
    },
  };
}

/**
 * A reply the receiver may send back: only after a consultation was answered inside
 * an active reception (R-11/R-10). Kept separate from the plan above because it is
 * about the outbound direction of the same exchange.
 */
export function canReplyToPeer(
  marker: A2AConversationMarker | null | undefined,
  hasOutboundText: boolean,
): boolean {
  if (!marker || !isInboundMarker(marker) || marker.state !== 'active') return false;
  return hasOutboundText;
}
