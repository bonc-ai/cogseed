import { describe, it, expect } from 'vitest';
import { projectInboundToP3394 } from '../../../src/main/features/messaging/p3394-projection';
import { validateP3394Envelope } from '../../../src/main/features/p3394_bridge/envelope';
import { inboundKey } from '../../../src/main/features/messaging/ledger';
import type { InboundEnvelope } from '../../../src/main/features/messaging/types';

const UID = 'u-test';

function baseInbound(overrides: Partial<InboundEnvelope>): InboundEnvelope {
  return {
    platform: 'feishu_lark',
    instanceId: 'inst-feishu-1',
    externalMessageId: 'om_1001',
    externalChatId: 'oc_2001',
    externalUserId: 'ou_alice',
    externalUserName: 'Alice',
    text: '帮我总结文档',
    isGroup: false,
    mentionPresent: false,
    receivedAt: '2026-08-24T10:00:00.000Z',
    ...overrides,
  } as InboundEnvelope;
}

describe('projectInboundToP3394', () => {
  it('飞书入站投影为合法 P3394 信封', () => {
    const out = projectInboundToP3394(UID, baseInbound({}));
    const check = validateP3394Envelope(out);
    expect(check.ok).toBe(true);
    expect(out.kind).toBe('message');
    expect(out.performative).toBe('request');
    expect(out.sender.agent_id).toBe('ou_alice');
    expect(out.sender.channel_instance_id).toBe('inst-feishu-1');
    expect(out.sender.alias).toBe('Alice');
    expect(out.payload.parts[0]).toEqual({ type: 'text', text: '帮我总结文档' });
  });

  it('四渠道各投影一次均合法', () => {
    for (const platform of ['telegram', 'feishu_lark', 'wecom', 'wechat_personal'] as const) {
      const out = projectInboundToP3394(UID, baseInbound({ platform, instanceId: `inst-${platform}` }));
      const check = validateP3394Envelope(out);
      expect(check.ok, `platform=${platform}: ${check.ok ? '' : JSON.stringify(check.error)}`).toBe(true);
      expect(out.payload.metadata?.platform).toBe(platform);
    }
  });

  it('确定性：同一入站两次投影 message_id / session_id / idempotency_key 不变', () => {
    const a = projectInboundToP3394(UID, baseInbound({}));
    const b = projectInboundToP3394(UID, baseInbound({}));
    expect(a.message_id).toBe(b.message_id);
    expect(a.session_id).toBe(b.session_id);
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });

  it('idempotency_key 与 ledger.inboundKey 同源（单一编号体系）', () => {
    const env = baseInbound({});
    const out = projectInboundToP3394(UID, env);
    expect(out.idempotency_key).toBe(inboundKey(env.instanceId, env.externalMessageId));
  });

  it('渠道溯源进 extensions.channel；线程/回复信息进 metadata', () => {
    const out = projectInboundToP3394(UID, baseInbound({
      replyToMessageId: 'om_0999',
      threadId: 't_1',
      isGroup: true,
      mentionPresent: true,
    }));
    expect((out.extensions as Record<string, any>).channel.external_chat_id).toBe('oc_2001');
    expect((out.extensions as Record<string, any>).channel.platform).toBe('feishu_lark');
    expect(out.payload.metadata?.reply_to_message_id).toBe('om_0999');
    expect(out.payload.metadata?.thread_id).toBe('t_1');
    expect(out.payload.metadata?.is_group).toBe(true);
    expect(out.payload.metadata?.mention_present).toBe(true);
  });

  it('收件人是宿主 Commander 身份，带 uid', () => {
    const out = projectInboundToP3394(UID, baseInbound({}));
    expect(out.recipients).toEqual([{ agent_id: `cogseed:${UID}` }]);
  });
});
