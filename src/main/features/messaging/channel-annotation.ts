/**
 * Channel annotation for conversation lists — 纯函数层。
 *
 * 渠道会话（飞书/微信等绑定创建）在侧栏按渠道分组展示。分组依据：
 *  - 首选会话自身的持久化字段 `channel_platform`（bindings 创建时写入）；
 *  - 兜底：会话缺字段时经 messaging binding（cid → instanceId → instance）
 *    动态补标（存量会话、字段引入前创建的会话），不回写磁盘；
 *  - 显示名 `channel_name` 是列表响应的派生字段（不落盘）：实例
 *    displayName 的实时值，拿不到时退化为内置渠道名映射。
 */

import type { MessagingPlatform } from './types';

/** Fallback display names when no live instance supplies one (deleted
 *  instance, cross-device sync of a channel conversation, etc.). */
export const CHANNEL_DISPLAY_NAMES: Record<MessagingPlatform, string> = {
  feishu_lark: '飞书',
  wechat_personal: '微信',
  wecom: '企业微信',
  telegram: 'Telegram',
};

export interface ChannelBindingRef {
  cid: string;
  instanceId: string;
}

export interface ChannelInstanceRef {
  id: string;
  platform: MessagingPlatform;
  displayName?: string;
}

export interface ChannelAnnotatable {
  conversation_id: string;
  channel_platform?: string;
}

function isKnownPlatform(value: string): value is MessagingPlatform {
  return value === 'feishu_lark' || value === 'wechat_personal' || value === 'wecom' || value === 'telegram';
}

/**
 * Returns a new array with `channel_platform` back-filled (binding join, no
 * disk write) and `channel_name` injected on every channel conversation.
 * Non-channel conversations pass through unchanged (same object reference).
 */
export function annotateChannelConversations<T extends ChannelAnnotatable>(
  conversations: readonly T[],
  bindings: readonly ChannelBindingRef[],
  instances: readonly ChannelInstanceRef[],
): T[] {
  const platformByInstance = new Map<string, MessagingPlatform>();
  // First live display name per platform (used for `channel_name`; multiple
  // instances of one platform share the sidebar group).
  const liveNameByPlatform = new Map<MessagingPlatform, string>();
  for (const instance of instances) {
    if (!instance?.id || !isKnownPlatform(instance.platform)) continue;
    platformByInstance.set(instance.id, instance.platform);
    const name = typeof instance.displayName === 'string' && instance.displayName.trim()
      ? instance.displayName.trim()
      : '';
    if (name && !liveNameByPlatform.has(instance.platform)) {
      liveNameByPlatform.set(instance.platform, name);
    }
  }
  // Last binding wins — mirrors resolveOrCreateBinding replacing stale keys.
  const channelByCid = new Map<string, MessagingPlatform>();
  for (const binding of bindings) {
    if (!binding?.cid || !binding?.instanceId) continue;
    const platform = platformByInstance.get(binding.instanceId);
    if (platform) channelByCid.set(binding.cid, platform);
  }
  return conversations.map((conversation) => {
    if (!conversation?.conversation_id) return conversation;
    const persisted = typeof conversation.channel_platform === 'string' && isKnownPlatform(conversation.channel_platform)
      ? conversation.channel_platform
      : '';
    const platform = persisted || channelByCid.get(conversation.conversation_id) || '';
    if (!platform) return conversation;
    const channelName = liveNameByPlatform.get(platform) || CHANNEL_DISPLAY_NAMES[platform];
    return {
      ...conversation,
      channel_platform: platform,
      channel_name: channelName,
    };
  });
}
