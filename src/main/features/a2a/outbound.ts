/**
 * A2A 发送侧（AC-04/09）——「我在会话里点名一个联系人」变成一次跨方提问。
 *
 * One contact relation may own multiple conversation instances. A single instance
 * is shared bidirectionally by both clients, while its marker independently tracks
 * inbound and outgoing directions.
 *
 * 与接待侧对称：本方问题和对方回答都以气泡落在对应的 A2A 会话实例里，而不是只出现
 * 在收件箱条上。发送成功后 marker 记录 `outgoing` 方向，不覆盖同一实例已有的 `inbound` 状态。
 *
 * 三条边界：
 * - 只能问联系人（关系权威在 Hub，本地缓存里没有就是没有）；
 * - 新实例 id 由**本方账号 + 对方账号 + request id**派生，本方账号 id 仍以 Hub 为唯一来源；
 * - 发送意图、marker 与稳定消息 id 先持久化，再以同一 request id relay；模糊失败可恢复且不重复记录。
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { safeId } from '../../storage';
import {
  admitOutboundA2AConversationAtomic,
  appendA2AConversationMessageAtomic,
  reserveA2AConversationId,
  updateConversationAtomic,
} from '../chats';
import { appendHistory, getCachedContact } from '../contacts/store';
import { hubSelfAccountId } from '../contacts/hub-client';
import { a2aConversationId, a2aConversationInstanceId, a2aPeerAssistantActorId } from './extensions';
export { a2aPeerAssistantActorId } from './extensions';
import {
  isOutboundMarker,
  parseA2AConversationMarker,
  transitionA2AConversation,
  type A2AConversationMarker,
} from './conversation-marker';
import { sendRelayMessageDetailed, type RelayMessage } from './relay-client';
import {
  beginA2AOutboundIntent,
  finishA2AOutboundIntent,
  legacyA2ARequestId,
  listRecoverableA2AOutboundIntents,
  markA2AOutboundPrepared,
  normalizeA2AQuestionText,
  outboundMessageId,
} from './outbound-intent';

const log = createLogger('a2a-outbound');

export interface SendQuestionResult {
  /** Relay delivery truth. An error may coexist with true when the relationship ended after delivery. */
  sent: boolean;
  conversationId?: string;
  error?: string;
}

export type A2AQuestionMode = 'new' | 'continue';

export interface SendQuestionInput {
  contactUserId: string;
  text: string;
  mode?: A2AQuestionMode;
  requestId?: string;
  conversationId?: string;
}

export interface OutboundDeps {
  isCurrent?: () => boolean;
  send?: (input: {
    to: string;
    conversationId: string;
    kind: RelayMessage['kind'];
    text: string;
    requestId: string;
  }) => Promise<{ messageId: string } | null>;
  /** 带错误码的发送（缺省用真实 relay）；给了它就不再用 `send`。 */
  sendDetailed?: (input: {
    to: string;
    conversationId: string;
    kind: RelayMessage['kind'];
    text: string;
    requestId: string;
  }) => Promise<{ ok: true; messageId: string } | { ok: false; code: string }>;
  selfAccountId?: () => Promise<string | null>;
  record?: (input: {
    userId: string;
    conversationId: string;
    actorId: string;
    actorName: string;
    text: string;
    messageId: string;
  }) => Promise<void>;
  newRequestId?: () => string;
  afterStage?: (stage: 'conversation' | 'message' | 'prepared' | 'relay') => Promise<void>;
}

export async function prepareA2AQuestion(
  userId: string,
  contactUserId: string,
  deps: Pick<OutboundDeps, 'selfAccountId' | 'newRequestId'> = {},
): Promise<{ prepared: true; requestId: string } | { prepared: false; error: string }> {
  const peerUserId = String(contactUserId || '').trim();
  if (!peerUserId || !(await getCachedContact(userId, peerUserId))) {
    return { prepared: false, error: 'not_contact' };
  }
  if (!(await (deps.selfAccountId ?? (() => hubSelfAccountId(userId)))())) {
    return { prepared: false, error: 'no_account' };
  }
  const requestId = String((deps.newRequestId ?? randomUUID)()).trim();
  return safeId(requestId)
    ? { prepared: true, requestId }
    : { prepared: false, error: 'invalid_request' };
}

/**
 * Hub 的拒收原因 → 界面文案键的后半段（`composer.a2a.send_failed_<reason>`）。
 *
 * 「对方关了接收提问」「已不是联系人」是服务端明确拒绝，必须原样说清楚；其余都归到
 * 一般失败，别把网络问题说成对方拒绝。
 */
export function relayFailureReason(code: string): string {
  const normalized = String(code || '').trim().toUpperCase();
  if (normalized === 'QUESTIONS_DISABLED') return 'questions_disabled';
  if (normalized === 'NOT_CONTACT') return 'not_contact';
  return 'delivery_failed';
}

/**
 * 把一条消息作为「已发生的对话」写进会话（不启动任何运行）。
 *
 * 用 bus 的 `internalControl` + 只发给本人：这是宿主替双方记录的事实，不是用户新提交，
 * 所以既不该触发助理，也不该被当成用户的下一次输入。
 */
async function recordConversationMessage(input: {
  userId: string;
  conversationId: string;
  actorId: string;
  actorName: string;
  text: string;
  messageId: string;
  withinConversationWrite?: boolean;
  isCurrent?: () => boolean;
}): Promise<void> {
  const bus = await import('../group_chat/bus');
  const state = await import('../group_chat/state');
  if (input.isCurrent && !input.isCurrent()) return;
  if (input.actorId !== 'user') {
    await state.addMember(input.userId, input.conversationId, {
      kind: 'agent',
      id: input.actorId,
      name: input.actorName,
    }, undefined, input.isCurrent).catch(() => false);
  }
  if (input.isCurrent && !input.isCurrent()) return;
  await bus.enqueue({
    uid: input.userId,
    cid: input.conversationId,
    fromActorId: input.actorId,
    text: input.text,
    forceTo: ['user'],
    internalControl: true,
    skipKstarRouting: true,
    skipConversationActivityBump: input.withinConversationWrite === true,
    messageId: input.messageId,
    isCurrent: input.isCurrent,
  } as never);
}

/** Ensure this instance exists and mark its outgoing direction without replacing inbound state. */
async function ensureInitiatorConversation(
  userId: string,
  input: { conversationId: string; peerUserId: string; peerName: string },
): Promise<A2AConversationMarker> {
  const admission = await admitOutboundA2AConversationAtomic(userId, {
    conversationId: input.conversationId,
    peerUserId: input.peerUserId,
    title: `与 ${input.peerName} 的对话`,
    decide: async (marker) => {
      // 同一个会话实例可能同时承载「对方来访」（inbound/state/workspace）和「我提问」
      // （outgoing）。只补方向位与名字，绝不覆盖来访状态。
      let next: A2AConversationMarker = marker
        ? { ...marker, outgoing: true, peer_name: input.peerName || marker.peer_name }
        : {
            outgoing: true,
            peer_user_id: input.peerUserId,
            peer_name: input.peerName,
            state: 'active',
            exchange_id: input.conversationId,
          };
      // 联系人删除可能已完成，而删除扫描发生在这个新会话创建之前。关系检查放在
      // 同一会话写队列里，确保此时只能写 active 或直接写终态 ended。
      if (!(await getCachedContact(userId, input.peerUserId))) {
        next = transitionA2AConversation(next, 'ended');
      }
      return next;
    },
  });
  if (!admission.accepted) throw new Error('a2a initiator conversation unavailable');
  return admission.marker;
}

async function resolveConversationId(
  userId: string,
  selfAccountId: string,
  peerUserId: string,
  input: SendQuestionInput,
): Promise<string | null> {
  if (input.mode === 'new') {
    const requestId = String(input.requestId || '').trim();
    if (!safeId(requestId)) return null;
    const cid = a2aConversationInstanceId(selfAccountId, peerUserId, requestId);
    const reservation = await reserveA2AConversationId(userId, cid);
    if (reservation.state === 'missing') return cid;
    const marker = reservation.marker;
    return marker && isOutboundMarker(marker)
      && marker.peer_user_id === peerUserId && marker.state !== 'ended'
      ? cid
      : null;
  }
  if (input.mode === 'continue') {
    const cid = String(input.conversationId || '').trim();
    if (!safeId(cid)) return null;
    const reservation = await reserveA2AConversationId(userId, cid);
    const marker = reservation.state === 'live' ? reservation.marker : null;
    return marker && marker.peer_user_id === peerUserId && marker.state !== 'ended' ? cid : null;
  }
  if (input.mode !== undefined) return null;
  // Legacy callers that omit an explicit mode retain the deterministic account-pair
  // conversation ID. New UI calls always provide new or continue explicitly.
  const cid = a2aConversationId(selfAccountId, peerUserId);
  const reservation = await reserveA2AConversationId(userId, cid);
  if (reservation.state === 'missing') return cid;
  const marker = reservation.marker;
  return marker && marker.peer_user_id === peerUserId && marker.state !== 'ended' ? cid : null;
}

async function dispatchA2AOutboundIntent(
  userId: string,
  input: {
    peerUserId: string;
    peerName: string;
    conversationId: string;
    text: string;
    requestId: string;
    intent: Awaited<ReturnType<typeof beginA2AOutboundIntent>>;
  },
  deps: OutboundDeps,
): Promise<SendQuestionResult> {
  const { peerUserId, peerName, conversationId, text, requestId, intent } = input;
  const messageId = outboundMessageId(requestId);
  let marker: A2AConversationMarker;
  try {
    marker = await ensureInitiatorConversation(userId, { conversationId, peerUserId, peerName });
    await deps.afterStage?.('conversation');
    if (marker.state === 'ended') {
      await finishA2AOutboundIntent(userId, intent.key, { status: 'cancelled', error: 'contact not found' });
      return { sent: false, conversationId, error: 'not_contact' };
    }
    if (!intent.entry.localPreparedAt) {
      const persisted = await appendA2AConversationMessageAtomic(userId, {
        conversationId,
        peerUserId,
        peerName,
        messageId,
        actorId: 'user',
        text,
      });
      if (!persisted.accepted) throw new Error('a2a conversation is no longer writable');
      if (persisted.inserted) await deps.record?.({
        userId, conversationId, actorId: 'user', actorName: 'user', text, messageId,
      });
      await deps.afterStage?.('message');
      await markA2AOutboundPrepared(userId, intent.key);
      await deps.afterStage?.('prepared');
      await appendHistory(userId, {
        contactUserId: peerUserId,
        direction: 'out',
        summary: text.slice(0, 200),
        at: new Date().toISOString(),
      }).catch((error) => {
        log.warn('outbound contact history append failed', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    const reservation = await reserveA2AConversationId(userId, conversationId).catch(() => null);
    const contact = await getCachedContact(userId, peerUserId).catch(() => null);
    if (reservation?.marker?.state === 'ended' || !contact) {
      await finishA2AOutboundIntent(userId, intent.key, {
        status: 'cancelled',
        error: 'contact not found',
      }).catch(() => null);
      return { sent: false, conversationId, error: 'not_contact' };
    }
    await finishA2AOutboundIntent(userId, intent.key, {
      status: 'retry_pending',
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
    log.warn('outbound question local preparation failed', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, conversationId, error: 'local_persistence_failed' };
  }

  if (!(await getCachedContact(userId, peerUserId))) {
    const { endExchangesWithPeer } = await import('./end-exchange');
    await endExchangesWithPeer(userId, peerUserId);
    await finishA2AOutboundIntent(userId, intent.key, { status: 'cancelled', error: 'contact not found' });
    return { sent: false, conversationId, error: 'not_contact' };
  }

  let failure: string | null = null;
  let relayMessageId = '';
  if (deps.send) {
    const sent = await deps.send({ to: peerUserId, conversationId, kind: 'question', text, requestId }).catch(() => null);
    if (!sent) failure = 'delivery_failed';
    else relayMessageId = sent.messageId;
  } else {
    const sendDetailed = deps.sendDetailed ?? ((input: Parameters<typeof sendRelayMessageDetailed>[1]) => sendRelayMessageDetailed(userId, input));
    const sent = await sendDetailed({ to: peerUserId, conversationId, kind: 'question', text, requestId }).catch(
      () => ({ ok: false as const, code: 'HUB_UNREACHABLE' }),
    );
    if (sent.ok === false) failure = relayFailureReason(sent.code);
    else relayMessageId = sent.messageId;
  }
  if (failure) {
    await finishA2AOutboundIntent(userId, intent.key, { status: 'retry_pending', error: failure }).catch(() => null);
    return { sent: false, conversationId, error: failure };
  }
  try {
    await deps.afterStage?.('relay');
  } catch (error) {
    log.warn('outbound relay acknowledgement interrupted', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: true, conversationId, error: 'local_persistence_failed' };
  }
  try {
    await finishA2AOutboundIntent(userId, intent.key, {
      status: 'sent',
      ...(relayMessageId ? { externalDeliveryId: relayMessageId } : {}),
    });
  } catch (error) {
    log.warn('outbound relay acknowledgement persistence failed', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: true, conversationId, error: 'local_persistence_failed' };
  }
  if (!(await getCachedContact(userId, peerUserId))) {
    const { endExchangesWithPeer } = await import('./end-exchange');
    await endExchangesWithPeer(userId, peerUserId);
    return { sent: true, conversationId, error: 'not_contact' };
  }
  return { sent: true, conversationId };
}

/**
 * 问一个联系人一个问题。
 *
 * 返回 `error` 而不是抛错：界面要把原因（不是联系人 / 送不出去）显示成提示，而不是
 * 让一个 rejection 冒到未处理的地方。
 */
export async function sendA2AQuestion(
  userId: string,
  input: SendQuestionInput,
  deps: OutboundDeps = {},
): Promise<SendQuestionResult> {
  const peerUserId = String(input.contactUserId || '').trim();
  const text = normalizeA2AQuestionText(input.text);
  if (!peerUserId || !text) return { sent: false, error: 'invalid_question' };

  const contact = await getCachedContact(userId, peerUserId);
  if (!contact) return { sent: false, error: 'not_contact' };

  const selfAccountId = await (deps.selfAccountId ?? (() => hubSelfAccountId(userId)))();
  if (!selfAccountId) {
    // 没有账号身份就派生不出交换 id，对方也就回不到这条会话上。
    return { sent: false, error: 'no_account' };
  }
  const conversationId = await resolveConversationId(userId, selfAccountId, peerUserId, input);
  if (!conversationId) {
    return {
      sent: false,
      error: input.mode !== undefined ? 'invalid_conversation' : 'invalid_exchange',
    };
  }
  if (!safeId(conversationId)) return { sent: false, error: 'invalid_exchange' };

  const peerName = String(contact.name || '').trim() || peerUserId;
  const explicitRequestId = String(input.requestId || '').trim();
  const requestId = safeId(explicitRequestId)
    ? explicitRequestId
    : legacyA2ARequestId({ conversationId, peerUserId, text });
  let intent;
  try {
    intent = await beginA2AOutboundIntent(userId, { requestId, conversationId, peerUserId, text });
  } catch (error) {
    log.warn('outbound intent persistence failed', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, conversationId, error: 'local_persistence_failed' };
  }
  if (intent.duplicate) {
    if (intent.entry.status === 'sent') return { sent: true, conversationId };
    return { sent: false, conversationId, error: 'delivery_in_progress' };
  }

  return dispatchA2AOutboundIntent(userId, {
    peerUserId,
    peerName,
    conversationId,
    text,
    requestId,
    intent,
  }, deps);
}

export async function recoverA2AOutboundIntents(
  userId: string,
  deps: OutboundDeps = {},
): Promise<{ recovered: number; pending: number; cancelled: number }> {
  let recovered = 0;
  let pending = 0;
  let cancelled = 0;
  for (const entry of await listRecoverableA2AOutboundIntents(userId)) {
    const peerUserId = entry.recipientId;
    const conversationId = String(entry.externalChatId || '');
    const requestId = entry.sourceMessageId;
    const text = normalizeA2AQuestionText(entry.text);
    const contact = await getCachedContact(userId, peerUserId);
    if (!contact || !safeId(conversationId) || !safeId(requestId) || !text) {
      await finishA2AOutboundIntent(userId, entry.key, {
        status: 'cancelled',
        error: contact ? 'invalid recoverable a2a intent' : 'contact not found',
      });
      cancelled += 1;
      continue;
    }
    let intent;
    try {
      intent = await beginA2AOutboundIntent(userId, { requestId, conversationId, peerUserId, text });
    } catch (error) {
      log.warn('outbound intent recovery reservation failed', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      pending += 1;
      continue;
    }
    if (intent.duplicate) continue;
    const result = await dispatchA2AOutboundIntent(userId, {
      peerUserId,
      peerName: String(contact.name || '').trim() || peerUserId,
      conversationId,
      text,
      requestId,
      intent,
    }, deps);
    if (result.sent) recovered += 1;
    else if (result.error === 'not_contact') cancelled += 1;
    else pending += 1;
  }
  return { recovered, pending, cancelled };
}

/**
 * 对方的回答落到带 `outgoing` 方向的本方会话实例里（由 relay 泵调用）。
 *
 * 只在 marker 证明本方曾在该实例提问时落库；没有 marker 或只有 `inbound` 的实例
 * 收到答案都不应把陌生内容塞进用户的对话。
 */
export async function appendIncomingAnswer(
  userId: string,
  message: RelayMessage,
  deps: OutboundDeps = {},
): Promise<boolean> {
  const conversationId = String(message.conversationId || '').trim();
  if (!conversationId || !safeId(conversationId)) return false;
  let accepted = false;
  try {
    await updateConversationAtomic(userId, conversationId, async (current) => {
      if (deps.isCurrent && !deps.isCurrent()) return null;
      const marker = parseA2AConversationMarker(current.a2a);
      // `outgoing` proves this side initiated the exchange. Recheck it and
      // contact authority at the serialized persistence point.
      if (!marker || !isOutboundMarker(marker) || marker.state === 'ended'
        || marker.peer_user_id !== message.fromAccount
        || !(await getCachedContact(userId, message.fromAccount))) return null;
      if (deps.isCurrent && !deps.isCurrent()) return null;
      const peerName = String(message.fromName || marker.peer_name || message.fromAccount).trim();
      const actorId = a2aPeerAssistantActorId(message.fromAccount);
      const recordInput = {
        userId,
        conversationId,
        actorId,
        actorName: t('a2a.source_assistant', { name: peerName }),
        text: String(message.text || '').trim().slice(0, 16_000),
        messageId: message.messageId,
      };
      if (deps.record) await deps.record(recordInput);
      else await recordConversationMessage({ ...recordInput, withinConversationWrite: true, isCurrent: deps.isCurrent });
      if (deps.isCurrent && !deps.isCurrent()) return null;
      await appendHistory(userId, {
        contactUserId: message.fromAccount,
        direction: 'in',
        summary: String(message.text || '').trim().slice(0, 200),
        at: message.createdAt || new Date().toISOString(),
      }, deps.isCurrent);
      if (deps.isCurrent && !deps.isCurrent()) return null;
      accepted = true;
      return { agent_ids: Array.from(new Set([...(current.agent_ids || []), actorId])) };
    }, undefined, deps.isCurrent);
    return accepted;
  } catch (error) {
    log.warn('incoming answer recorded locally failed', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
