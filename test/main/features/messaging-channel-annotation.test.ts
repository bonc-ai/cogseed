/**
 * 消息渠道会话注记（channel-annotation）——侧栏渠道分组的数据核心。
 *
 * 覆盖（纯函数，无 IO）：
 *   - 持久化 channel_platform 优先，binding join 兜底补标（存量会话）
 *   - channel_name 派生：实例 displayName 实时值 → 内置渠道名映射 → platform 原值
 *   - 非渠道会话原样透传（同引用，不复制）
 *   - 实例缺失/未知平台不产生注记；binding 指向已删实例时兜底映射仍可用
 */

import { describe, it, expect } from 'vitest';
import {
  annotateChannelConversations,
  CHANNEL_DISPLAY_NAMES,
  type ChannelBindingRef,
  type ChannelInstanceRef,
} from '../../../src/main/features/messaging/channel-annotation';

const instances: ChannelInstanceRef[] = [
  { id: 'inst_feishu', platform: 'feishu_lark', displayName: '飞书' },
  { id: 'inst_wechat', platform: 'wechat_personal', displayName: '我的微信' },
];
const bindings: ChannelBindingRef[] = [
  { cid: 'c1', instanceId: 'inst_feishu' },
  { cid: 'c2', instanceId: 'inst_wechat' },
];

describe('messaging/channel-annotation — annotateChannelConversations', () => {
  it('binding join 补标存量会话并注入实时显示名', () => {
    const [feishu, wechat] = annotateChannelConversations(
      [{ conversation_id: 'c1' }, { conversation_id: 'c2' }],
      bindings,
      instances,
    );
    expect(feishu).toMatchObject({ conversation_id: 'c1', channel_platform: 'feishu_lark', channel_name: '飞书' });
    expect(wechat).toMatchObject({ conversation_id: 'c2', channel_platform: 'wechat_personal', channel_name: '我的微信' });
  });

  it('持久化 channel_platform 优先于 binding；channel_name 仍取实时名', () => {
    const [conv] = annotateChannelConversations(
      [{ conversation_id: 'cx', channel_platform: 'feishu_lark' }],
      [],
      instances,
    );
    expect(conv).toMatchObject({ channel_platform: 'feishu_lark', channel_name: '飞书' });
  });

  it('非渠道会话原样透传（引用不变、不加字段）', () => {
    const plain = { conversation_id: 'plain', title: 'x' };
    const [out] = annotateChannelConversations([plain], bindings, instances);
    expect(out).toBe(plain);
    expect(out.channel_platform).toBeUndefined();
  });

  it('实例被删后兜底到内置渠道名映射', () => {
    const [conv] = annotateChannelConversations(
      [{ conversation_id: 'c1' }],
      [{ cid: 'c1', instanceId: 'inst_gone' }],
      [],
    );
    // binding 指向不存在的实例：平台无从解析 → 不注记
    expect(conv.channel_platform).toBeUndefined();
    const [persisted] = annotateChannelConversations(
      [{ conversation_id: 'c1', channel_platform: 'wechat_personal' }],
      [],
      [],
    );
    expect(persisted.channel_name).toBe(CHANNEL_DISPLAY_NAMES.wechat_personal);
  });

  it('未知平台值不透传（防脏数据）', () => {
    const [conv] = annotateChannelConversations(
      [{ conversation_id: 'c1', channel_platform: 'sms_magic' }],
      [{ cid: 'c1', instanceId: 'inst_feishu' }],
      instances,
    );
    // 未知持久化值被忽略，但 binding join 仍给出合法平台
    expect(conv).toMatchObject({ channel_platform: 'feishu_lark' });
  });

  it('同会话多条 binding 时以最后一条为准（模拟换绑）', () => {
    const [conv] = annotateChannelConversations(
      [{ conversation_id: 'c1' }],
      [
        { cid: 'c1', instanceId: 'inst_feishu' },
        { cid: 'c1', instanceId: 'inst_wechat' },
      ],
      instances,
    );
    expect(conv.channel_platform).toBe('wechat_personal');
  });
});
