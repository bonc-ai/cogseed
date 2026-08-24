import { createHash } from 'node:crypto';
import type { InboundEnvelope } from './types';
import { inboundKey } from './ledger';
import {
  P3394_ENVELOPE_VERSION,
  type P3394Envelope,
  type P3394PayloadPart,
} from '../p3394_bridge/envelope';

/** 确定性短 id：同一 (instanceId, 外部 id) 永远得到同一值，天然幂等、可对账。 */
function deriveId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`;
}

/**
 * 渠道入站信封 → P3394 信封的纯函数投影（设计第一期「翻译官模式」）。
 * 纯函数：不碰网络、不碰进程状态；调用方负责 try/catch 降级。
 */
export function projectInboundToP3394(uid: string, envelope: InboundEnvelope): P3394Envelope {
  const parts: P3394PayloadPart[] = [{ type: 'text', text: envelope.text }];
  return {
    spec_version: P3394_ENVELOPE_VERSION,
    message_id: deriveId('msg', envelope.instanceId, envelope.externalMessageId),
    session_id: deriveId('chat', envelope.instanceId, envelope.externalChatId),
    kind: 'message',
    performative: 'request',
    role: 'requester',
    sender: {
      agent_id: envelope.externalUserId,
      ...(envelope.externalUserName ? { alias: envelope.externalUserName } : {}),
      channel_instance_id: envelope.instanceId,
    },
    recipients: [{ agent_id: `cogseed:${uid}` }],
    payload: {
      parts,
      metadata: {
        platform: envelope.platform,
        is_group: envelope.isGroup,
        mention_present: envelope.mentionPresent,
        ...(envelope.externalChatTitle ? { external_chat_title: envelope.externalChatTitle } : {}),
        ...(envelope.botMentionTokens?.length ? { bot_mention_tokens: envelope.botMentionTokens } : {}),
        ...(envelope.replyToMessageId ? { reply_to_message_id: envelope.replyToMessageId } : {}),
        ...(envelope.threadId ? { thread_id: envelope.threadId } : {}),
        ...(envelope.replyInThread !== undefined ? { reply_in_thread: envelope.replyInThread } : {}),
        ...(envelope.synthetic !== undefined ? { synthetic: envelope.synthetic } : {}),
      },
    },
    extensions: {
      channel: {
        platform: envelope.platform,
        instance_id: envelope.instanceId,
        external_chat_id: envelope.externalChatId,
        ...(envelope.externalTenantId ? { external_tenant_id: envelope.externalTenantId } : {}),
        ...(envelope.externalUnionId ? { external_union_id: envelope.externalUnionId } : {}),
        ...(envelope.contextTokenRef ? { context_token_ref: envelope.contextTokenRef } : {}),
      },
    },
    idempotency_key: inboundKey(envelope.instanceId, envelope.externalMessageId),
  };
}
