import { createHash } from 'node:crypto';
import {
  beginDelivery,
  deliveryKey,
  finishDelivery,
  getDelivery,
  listRecoverableDeliveries,
  markDeliveryLocalPrepared,
  textHash,
} from '../messaging/ledger';

const A2A_RELAY_INSTANCE_ID = 'a2a-relay';
export const A2A_QUESTION_MAX_LENGTH = 4_000;

export function normalizeA2AQuestionText(value: unknown): string | null {
  const text = String(value || '').trim();
  return text && text.length <= A2A_QUESTION_MAX_LENGTH ? text : null;
}

export function legacyA2ARequestId(input: {
  conversationId: string;
  peerUserId: string;
  text: string;
}): string {
  const digest = createHash('sha256')
    .update([input.conversationId, input.peerUserId, input.text].join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `legacy-${digest}`;
}

export function outboundMessageId(requestId: string): string {
  const digest = createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 20);
  return `a2a-out-${digest}`;
}

export async function beginA2AOutboundIntent(userId: string, input: {
  requestId: string;
  conversationId: string;
  peerUserId: string;
  text: string;
}) {
  const key = deliveryKey(A2A_RELAY_INSTANCE_ID, input.requestId);
  const payloadHash = textHash(input.text);
  const begun = await beginDelivery(userId, {
    key,
    instanceId: A2A_RELAY_INSTANCE_ID,
    recipientId: input.peerUserId,
    recipientIdType: 'chat_id',
    externalChatId: input.conversationId,
    sourceMessageId: input.requestId,
    textHash: payloadHash,
    text: input.text,
    idempotencyKey: input.requestId,
  });
  if (begun.entry.externalChatId !== input.conversationId
    || begun.entry.recipientId !== input.peerUserId
    || begun.entry.sourceMessageId !== input.requestId
    || begun.entry.textHash !== payloadHash) {
    throw new Error('outbound request id is already bound to another delivery');
  }
  return { key, ...begun };
}

export const readA2AOutboundIntent = getDelivery;
export async function listRecoverableA2AOutboundIntents(userId: string) {
  return listRecoverableDeliveries(userId, A2A_RELAY_INSTANCE_ID);
}
export const markA2AOutboundPrepared = markDeliveryLocalPrepared;
export const finishA2AOutboundIntent = finishDelivery;
