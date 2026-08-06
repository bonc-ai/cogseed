import type { InboundEnvelope, MessagingInstance, MessagingPolicy } from './types';

export interface PolicyDecision {
  allowed: boolean;
  reason?: 'user_not_allowed' | 'group_not_allowed' | 'mention_required' | 'commands_only' | 'empty_message';
}

function includesValue(values: string[], value: string): boolean {
  return values.length === 0 || values.includes(value);
}

export function evaluateInboundPolicy(instance: MessagingInstance, envelope: InboundEnvelope): PolicyDecision {
  const policy: MessagingPolicy = instance.policy;
  if (!envelope.text.trim()) return { allowed: false, reason: 'empty_message' };
  if (!includesValue(policy.allowUserIds, envelope.externalUserId)) {
    return { allowed: false, reason: 'user_not_allowed' };
  }
  if (envelope.isGroup && !includesValue(policy.allowGroupIds, envelope.externalChatId)) {
    return { allowed: false, reason: 'group_not_allowed' };
  }
  if (envelope.isGroup && policy.requireMentionInGroups && !envelope.mentionPresent) {
    return { allowed: false, reason: 'mention_required' };
  }
  if (policy.replyMode === 'mentions_only' && !envelope.mentionPresent) {
    return { allowed: false, reason: 'mention_required' };
  }
  if (policy.replyMode === 'commands_only' && !/^\s*[!/]/.test(envelope.text)) {
    return { allowed: false, reason: 'commands_only' };
  }
  return { allowed: true };
}

export function stripBotMention(text: string): string {
  return text.replace(/(^|\s)@[A-Za-z0-9_./-]+/g, '$1').replace(/\s{2,}/g, ' ').trim();
}
