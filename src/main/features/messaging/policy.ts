import type { InboundEnvelope, MessagingInstance, MessagingPolicy } from './types';

export interface PolicyDecision {
  allowed: boolean;
  reason?: 'user_not_allowed' | 'group_not_allowed' | 'mention_required' | 'commands_only' | 'empty_message';
}

function isExplicitlyAllowed(allowlist: readonly string[], value: string): boolean {
  return allowlist.includes(value);
}

/**
 * A tenant-scoped union id is the durable Feishu identity when the platform
 * provides both values. It is deliberately encoded as one exact allowlist
 * item, so a union id from another tenant can never match accidentally.
 */
export function tenantUnionIdentity(tenantId: string | undefined, unionId: string | undefined): string | null {
  const tenant = typeof tenantId === 'string' ? tenantId.trim() : '';
  const union = typeof unionId === 'string' ? unionId.trim() : '';
  if (!tenant || !union || tenant.length > 512 || union.length > 512) return null;
  return `tenant:${encodeURIComponent(tenant)}:union:${encodeURIComponent(union)}`;
}

export function inboundIdentityCandidates(envelope: InboundEnvelope): string[] {
  const candidates = new Set<string>();
  const tenantUnion = tenantUnionIdentity(envelope.externalTenantId, envelope.externalUnionId);
  if (tenantUnion) candidates.add(tenantUnion);
  const fallback = envelope.externalUserId.trim();
  if (fallback) candidates.add(fallback);
  return [...candidates];
}

function isInboundUserAllowed(allowlist: readonly string[], envelope: InboundEnvelope): boolean {
  return inboundIdentityCandidates(envelope).some((candidate) => isExplicitlyAllowed(allowlist, candidate));
}

export function evaluateInboundPolicy(instance: MessagingInstance, envelope: InboundEnvelope): PolicyDecision {
  const policy: MessagingPolicy = instance.policy;
  if (!envelope.text.trim()) return { allowed: false, reason: 'empty_message' };
  if (!isInboundUserAllowed(policy.allowUserIds, envelope)) {
    return { allowed: false, reason: 'user_not_allowed' };
  }
  if (envelope.isGroup && !isExplicitlyAllowed(policy.allowGroupIds, envelope.externalChatId)) {
    return { allowed: false, reason: 'group_not_allowed' };
  }
  if (envelope.isGroup && policy.requireMentionInGroups && !envelope.mentionPresent) {
    return { allowed: false, reason: 'mention_required' };
  }
  if (policy.replyMode === 'mentions_only' && !envelope.mentionPresent) {
    return { allowed: false, reason: 'mention_required' };
  }
  const commandText = stripBotMention(envelope.text, envelope.botMentionTokens);
  if (policy.replyMode === 'commands_only' && !/^\s*[!/]/.test(commandText)) {
    return { allowed: false, reason: 'commands_only' };
  }
  return { allowed: true };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBotMentionTokens(tokens: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const token of tokens) {
    const value = token.trim();
    if (value.length < 2 || value.length > 512 || !value.startsWith('@') || /\s/.test(value)) continue;
    normalized.add(value);
  }
  return [...normalized].sort((left, right) => right.length - left.length);
}

export function stripBotMention(text: string, botMentionTokens: readonly string[] = []): string {
  const tokens = normalizeBotMentionTokens(botMentionTokens);
  if (!tokens.length) return text;
  const tokenPattern = tokens.map(escapeRegExp).join('|');
  const stripped = text.replace(
    new RegExp(`(^|[^A-Za-z0-9_./-])(?:${tokenPattern})(?![A-Za-z0-9_./-])`, 'g'),
    '$1',
  );
  return stripped === text ? text : stripped.replace(/\s{2,}/g, ' ').trim();
}
