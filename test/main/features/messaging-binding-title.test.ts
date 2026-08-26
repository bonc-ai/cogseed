/**
 * Messaging 绑定会话标题 —— 私聊不泄漏外部账号 ID。
 *
 * 覆盖（纯函数，无 IO）：
 *   - 私聊：有发送者名 → “实例 · 名字”；无名 → “实例 · 私聊”（兜底词条），
 *     任何情况标题都不含 oc_/ou_ 原始 ID
 *   - 群聊：群名 + 发送者保持原格式；无群名时退化为 chat id（现状保留）
 *   - 标题超长截断到 120 字符
 */

import { describe, it, expect } from 'vitest';
import { conversationTitleForEnvelope } from '../../../src/main/features/messaging/bindings';
import { t } from '../../../src/main/i18n';
import type { InboundEnvelope, MessagingInstance } from '../../../src/main/features/messaging/types';

const instance = { id: 'inst_1', displayName: '飞书' } as MessagingInstance;

function envelope(partial: Partial<InboundEnvelope>): InboundEnvelope {
  return {
    platform: 'feishu_lark',
    instanceId: 'inst_1',
    externalMessageId: 'om_1',
    externalChatId: 'oc_f04e8e2c23943665ab151e30a3237b51',
    externalUserId: 'ou_2e921d0f3cc121794da5cb9048fa7f34',
    text: 'hi',
    isGroup: false,
    mentionPresent: false,
    receivedAt: '2026-08-26T00:00:00Z',
    ...partial,
  };
}

describe('messaging/bindings — conversationTitleForEnvelope', () => {
  it('私聊：enrich 到发送者名时标题用名字', () => {
    const title = conversationTitleForEnvelope(instance, envelope({ externalUserName: '牛保康' }));
    expect(title).toBe('飞书 · 牛保康');
    expect(title).not.toContain('oc_');
    expect(title).not.toContain('ou_');
  });

  it('私聊：拿不到名字时退化为兜底文案，不暴露原始 ID', () => {
    const title = conversationTitleForEnvelope(instance, envelope({}));
    expect(title).toBe(`飞书 · ${t('messaging.direct_chat')}`);
    expect(title).not.toContain('oc_');
    expect(title).not.toContain('ou_');
  });

  it('私聊：externalChatTitle 优先于发送者名', () => {
    const title = conversationTitleForEnvelope(instance, envelope({
      externalChatTitle: '置顶会话',
      externalUserName: '牛保康',
    }));
    expect(title).toBe('飞书 · 置顶会话');
  });

  it('群聊：群名 + 发送者名的既有格式保持不变', () => {
    const title = conversationTitleForEnvelope(instance, envelope({
      isGroup: true,
      externalChatTitle: '项目讨论群',
      externalUserName: '李四',
    }));
    expect(title).toBe('飞书 · 项目讨论群 · 李四');
  });

  it('群聊：无群名时保留 chat id 兜底（现状）', () => {
    const title = conversationTitleForEnvelope(instance, envelope({
      isGroup: true,
      externalUserName: '李四',
    }));
    expect(title).toBe(`飞书 · oc_f04e8e2c23943665ab151e30a3237b51 · 李四`);
  });

  it('标题超长时截断到 120 字符', () => {
    const title = conversationTitleForEnvelope(instance, envelope({
      externalUserName: '名'.repeat(300),
    }));
    expect(title.length).toBeLessThanOrEqual(120);
  });
});
