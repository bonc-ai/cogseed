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

describe('channel bridge file delivery (T2a, 2026-08-25 真机修复)', () => {
  // 真实链路形态：p3394_send → filesToResourceParts 产生 data:…;base64
  // 内联（小文件）或 p3394-object:sha256 引用（大文件）——不是本地绝对
  // 路径。首版误把过滤写成"只认绝对路径"，真机文件被静默丢弃，本组
  // 用例按真实形态构造防回归。
  function b64(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
  }
  function sha256hex(text: string): string {
    return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  }
  function envelopeWithFiles(text: string, parts: Array<Record<string, unknown>>): P3394Envelope {
    return {
      ...envelope(text),
      payload: { parts: [{ type: 'text', text }, ...parts] },
    };
  }

  it('data:URI 内联 part → 物化后逐个投递，回执带文件数', async () => {
    const sentText: any[] = [];
    const sentFiles: any[] = [];
    const content = 'P3394 渠道文件投递验证';
    const result = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelopeWithFiles('产物已生成', [
        { type: 'resource', uri: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${b64(content)}`, media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'report.docx', digest: sha256hex(content) },
        { type: 'image', uri: `data:image/png;base64,${b64('png-bytes')}`, media_type: 'image/png' },
      ]),
      async (_uid, input) => { sentText.push(input); },
      async () => ({ recipientId: 'ou_boss' }),
      { sendFile: async (_uid, input) => { sentFiles.push(input); } },
    );
    expect(result.ok).toBe(true);
    expect(sentText).toHaveLength(1);
    expect(sentFiles).toHaveLength(2);
    expect(sentFiles[0]).toMatchObject({ instanceId: 'inst-1', recipientId: 'ou_boss', name: 'report.docx', sourceKey: 'p3394:msg_bridge_1:file:0' });
    expect(sentFiles[0].path).toContain('p3394-channel-');
    expect(require('node:fs').readFileSync(sentFiles[0].path, 'utf8')).toBe(content);
    if (!result.ok) return;
    expect(result.receipt.payload.parts[0].text).toContain('(2 file(s))');
  });

  it('digest 不符的 data:URI → 丢弃该文件（不投递不报错）', async () => {
    const sentFiles: any[] = [];
    const result = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelopeWithFiles('篡改检测', [
        { type: 'resource', uri: `data:text/plain;base64,${b64('content')}`, media_type: 'text/plain', digest: sha256hex('other-content') },
      ]),
      async () => {},
      async () => ({ recipientId: 'ou_boss' }),
      { sendFile: async (_uid, input) => { sentFiles.push(input); } },
    );
    expect(result.ok).toBe(true);
    expect(sentFiles).toHaveLength(0);
  });

  it('裸本地绝对路径 uri → 拒绝物化（不可信输入防任意路径读取）', async () => {
    const sentFiles: any[] = [];
    const result = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelopeWithFiles('路径注入尝试', [
        { type: 'resource', uri: '/etc/passwd', name: 'evil' },
      ]),
      async () => {},
      async () => ({ recipientId: 'ou_boss' }),
      { sendFile: async (_uid, input) => { sentFiles.push(input); } },
    );
    expect(result.ok).toBe(true);
    expect(sentFiles).toHaveLength(0);
  });

  it('穿越型文件名 → 清洗为 basename 安全字符', async () => {
    const sentFiles: any[] = [];
    const content = 'x';
    const result = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelopeWithFiles('名字清洗', [
        { type: 'resource', uri: `data:text/plain;base64,${b64(content)}`, media_type: 'text/plain', name: '../../etc/cron.d/evil.sh', digest: sha256hex(content) },
      ]),
      async () => {},
      async () => ({ recipientId: 'ou_boss' }),
      { sendFile: async (_uid, input) => { sentFiles.push(input); } },
    );
    expect(result.ok).toBe(true);
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles[0].name).not.toContain('/');
    expect(sentFiles[0].name).not.toContain('..');
  });

  it('文件数超过上限 5 → 只投递前 5 个；未提供 sendFile → 兼容忽略', async () => {
    const sentFiles: any[] = [];
    const r1 = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelopeWithFiles('批量', Array.from({ length: 8 }, (_, i) => ({ type: 'resource', uri: `data:text/plain;base64,${b64('f' + i)}` }))),
      async () => {},
      async () => ({ recipientId: 'ou_boss' }),
      { sendFile: async (_uid, input) => { sentFiles.push(input); } },
    );
    expect(r1.ok).toBe(true);
    expect(sentFiles).toHaveLength(5);
    const sentText: any[] = [];
    const r2 = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelopeWithFiles('无文件通道', [{ type: 'resource', uri: `data:text/plain;base64,${b64('x')}` }]),
      async (_uid, input) => { sentText.push(input); },
      async () => ({ recipientId: 'ou_boss' }),
    );
    expect(r2.ok).toBe(true);
    expect(sentText).toHaveLength(1);
    if (!r2.ok) return;
    expect(r2.receipt.payload.parts[0].text).toBe('channel bridge delivered');
  });

  it('文件投递失败 → 整体按失败上报（文本已送达不回滚）', async () => {
    const result = await deliverToChannelBridge(
      'u1',
      'channel-inst-1',
      envelopeWithFiles('带失败文件', [{ type: 'resource', uri: `data:text/plain;base64,${b64('gone')}` }]),
      async () => {},
      async () => ({ recipientId: 'ou_boss' }),
      { sendFile: async () => { throw new Error('upload rejected'); } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('p3394_channel_bridge_file_failed');
  });
});

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

