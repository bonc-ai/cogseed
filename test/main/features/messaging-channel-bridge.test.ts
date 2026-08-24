import { describe, it, expect } from 'vitest';
import {
  channelBridgeAgentId, instanceIdFromChannelBridgeAgentId, deliverToChannelBridge,
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
