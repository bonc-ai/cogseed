import { describe, it, expect } from 'vitest';
import {
  channelBridgeAgentId, instanceIdFromChannelBridgeAgentId, deliverToChannelBridge,
  resetChannelBridgeRateLimitsForTests,
} from '../../../src/main/features/messaging/channel-bridge';
import type { P3394Envelope } from '../../../src/main/features/p3394_bridge/envelope';

function envelope(text: string): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg_bridge_1',
    session_id: 'chat_bridge_1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'cogseed:u1' },
    recipients: [{ agent_id: 'channel-inst-1' }],
    payload: { parts: [{ type: 'text', text }] },
    idempotency_key: 'inst-1:m-1',
  };
}

describe('channel bridge node ids', () => {
  it('agent_id 与 instanceId 互为可逆', () => {
    expect(channelBridgeAgentId('inst-9')).toBe('channel-inst-9');
    expect(instanceIdFromChannelBridgeAgentId('channel-inst-9')).toBe('inst-9');
    expect(instanceIdFromChannelBridgeAgentId('hermes')).toBeNull();
  });
});

describe('channel bridge delivery (phase 3)', () => {
  it('p3394_send 到渠道节点 → 经渠道主动发给 owner → 回执信封', async () => {
    const sent: any[] = [];
    const result = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelope('报告完成，请查收'),
      async (_uid, input) => { sent.push(input); },
      async () => ({ recipientId: 'ou_boss' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      instanceId: 'inst-1',
      recipientId: 'ou_boss',
      text: '报告完成，请查收',
      sourceKey: 'p3394:msg_bridge_1',
    });
    expect(result.receipt.kind).toBe('event');
    expect(result.receipt.performative).toBe('inform');
    expect(result.receipt.sender.agent_id).toBe('channel-inst-1');
  });

  it('owner 未绑定 → 明确报错，不投递', async () => {
    const sent: any[] = [];
    const result = await deliverToChannelBridge(
      'u1', 'channel-inst-1', envelope('hi'),
      async (_uid, input) => { sent.push(input); },
      async () => null,
    );
    expect(result).toMatchObject({ ok: false, error: 'p3394_channel_bridge_no_owner' });
    expect(sent).toHaveLength(0);
  });

  it('空文本 / 非渠道节点 id → 拒绝', async () => {
    const r1 = await deliverToChannelBridge('u1', 'hermes', envelope('x'), async () => {}, async () => ({ recipientId: 'r' }));
    expect(r1).toMatchObject({ ok: false, error: 'p3394_not_a_channel_bridge' });
    const r2 = await deliverToChannelBridge('u1', 'channel-inst-1', envelope('   '), async () => {}, async () => ({ recipientId: 'r' }));
    expect(r2).toMatchObject({ ok: false, error: 'p3394_channel_bridge_empty_text' });
  });

  it('渠道投递异常 → 错误上抛为字符串', async () => {
    const result = await deliverToChannelBridge(
      'u1', 'channel-inst-1', envelope('boom'),
      async () => { throw new Error('feishu down'); },
      async () => ({ recipientId: 'ou_boss' }),
    );
    expect(result).toMatchObject({ ok: false, error: 'feishu down' });
  });
});

describe('channel bridge guardrails (rate limit + sender allowlist)', () => {
  it('未配置白名单 → 保持放行（现状回归）', async () => {
    resetChannelBridgeRateLimitsForTests();
    const sent: any[] = [];
    const result = await deliverToChannelBridge(
      'u1', 'channel-inst-1', envelope('hi'),
      async (_uid, input) => { sent.push(input); },
      async () => ({ recipientId: 'ou_boss' }),
    );
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('配置白名单 → 名单外 sender 拒绝，名单内放行', async () => {
    resetChannelBridgeRateLimitsForTests();
    const sent: any[] = [];
    const deliver = (senderId: string) => deliverToChannelBridge(
      'u1', 'channel-inst-1', { ...envelope('hi'), sender: { agent_id: senderId } },
      async (_uid, input) => { sent.push(input); },
      async () => ({ recipientId: 'ou_boss' }),
      { allowedSenders: ['agent-reporter', 'cogseed:u1'] },
    );
    const denied = await deliver('agent-spammer');
    expect(denied).toMatchObject({ ok: false, error: 'p3394_channel_bridge_sender_not_allowed' });
    const allowed = await deliver('agent-reporter');
    expect(allowed.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('同一 sender 每分钟超过上限 → 限流拒绝；不同 sender 独立计数', async () => {
    resetChannelBridgeRateLimitsForTests();
    const sent: any[] = [];
    const deliver = (senderId: string) => deliverToChannelBridge(
      'u1', 'channel-inst-1', { ...envelope('hi'), sender: { agent_id: senderId } },
      async (_uid, input) => { sent.push(input); },
      async () => ({ recipientId: 'ou_boss' }),
    );
    // 默认 per-sender 上限 10 条/分钟：前 10 条放行
    for (let i = 0; i < 10; i++) {
      const r = await deliver('agent-chatty');
      expect(r.ok).toBe(true);
    }
    const limited = await deliver('agent-chatty');
    expect(limited).toMatchObject({ ok: false, error: 'p3394_channel_bridge_rate_limited' });
    // 其他 sender 不受影响
    const other = await deliver('agent-quiet');
    expect(other.ok).toBe(true);
    expect(sent).toHaveLength(11);
  });

  it('实例级总上限 30 条/分钟 → 跨 sender 合计超限拒绝', async () => {
    resetChannelBridgeRateLimitsForTests();
    const sent: any[] = [];
    const deliver = (senderId: string) => deliverToChannelBridge(
      'u1', 'channel-inst-1', { ...envelope('hi'), sender: { agent_id: senderId } },
      async (_uid, input) => { sent.push(input); },
      async () => ({ recipientId: 'ou_boss' }),
    );
    // 3 个 sender 各 10 条 = 30 条，全部放行
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 10; i++) {
        const r = await deliver(`agent-${s}`);
        expect(r.ok).toBe(true);
      }
    }
    // 第 31 条（第 4 个 sender 的第一条）触发实例级上限
    const capped = await deliver('agent-fourth');
    expect(capped).toMatchObject({ ok: false, error: 'p3394_channel_bridge_rate_limited' });
    expect(sent).toHaveLength(30);
  });
});

