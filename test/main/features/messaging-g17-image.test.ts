/**
 * G-17 入站图片投影链 + Q2 飞书 Channel Adapter 合约 + Q3 open_id→Peer 映射。
 *
 * 覆盖：
 * - ledger normalizeInbound 白名单保留 imageKeys（上限 9、去重、去杂项）
 * - manager 派发：图片入站构造 p3394_envelope（parts.image 引用式 uri）、
 *   台账完成记录携带 imageKeys；纯文本入站不带信封（零回归）
 * - feishu channel descriptor 三要素 + owner 缺失降级
 * - channel-peer-map 幂等/别名稳定/查询
 *
 * mock/setup 模式沿用 messaging.test.ts（doMock adapters/group_chat +
 * 动态 import manager）与 team-projection.test.ts（variant 目录隔离）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessagingAdapter, MessagingInstanceInternal } from '../../../src/main/features/messaging/types';

let tmpDir = '';
let previousRoot: string | undefined;
let testVariant = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-messaging-g17-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  // channel-peer-map.json 落在 per-variant 状态目录：每次运行唯一变体，
  // 杜绝写进真实 ~/.cogseed/runtime-variants/cogseed。
  testVariant = 'g17-test-' + Math.random().toString(36).slice(2, 10);
  process.env.COGSEED_RUNTIME_VARIANT = testVariant;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  delete process.env.COGSEED_RUNTIME_VARIANT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try {
    fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', testVariant), { recursive: true, force: true });
  } catch { /* best effort */ }
});

function feishuInstance(overrides: Partial<MessagingInstanceInternal> = {}): MessagingInstanceInternal {
  return {
    id: 'inst-g17',
    platform: 'feishu_lark',
    displayName: 'G17 Feishu',
    enabled: true,
    responseMode: 'text',
    workspace: { type: 'all' },
    policy: { replyMode: 'every_message', allowUserIds: [], allowGroupIds: [], requireMentionInGroups: true },
    status: { kind: 'disconnected', checkedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Q2：飞书 Channel Adapter descriptor 合约 ─────────────────────────

describe('feishu channel descriptor (Q2)', () => {
  it('builds a descriptor with roles/capabilities/identity_proofs from the owner open id', async () => {
    const { buildFeishuChannelDescriptor } = await import('../../../src/main/features/p3394_bridge/feishu-channel-adapter');
    const descriptor = buildFeishuChannelDescriptor(feishuInstance({ ownerExternalUserId: 'ou_owner123456' }));
    expect(descriptor.id).toBe('org.cogseed.channel.feishu_lark');
    expect(descriptor.roles).toEqual(['listener', 'dialer']);
    expect(descriptor.capabilities.identity_proofs).toEqual(['feishu-open_id:ou_owner123456']);
    // 语义保守声明：引用式 artifacts、无协议级流式/任务/取消。
    expect(descriptor.capabilities.artifacts).toBe('referenced');
    expect(descriptor.capabilities.streaming).toBe('none');
    expect(descriptor.capabilities.durable_tasks).toBe(false);
    expect(descriptor.capabilities.cancellation).toBe(false);
    expect(descriptor.capabilities.multi_party_sessions).toBe(false);
    expect(descriptor.schemes).toContain('feishu-image');
    expect(descriptor.bindings).toEqual(['feishu-lark:instance:inst-g17']);
  });

  it('yields empty identity_proofs (no throw) when the owner is missing', async () => {
    const { buildFeishuChannelDescriptor } = await import('../../../src/main/features/p3394_bridge/feishu-channel-adapter');
    const descriptor = buildFeishuChannelDescriptor(feishuInstance());
    expect(descriptor.capabilities.identity_proofs).toEqual([]);
  });

  it('registers the descriptor alongside the channel bridge node and removes it on unregister', async () => {
    const register = vi.fn(() => ({ ok: true }));
    const revoke = vi.fn();
    vi.doMock('../../../src/main/features/p3394_bridge/app-wiring', () => ({
      getP3394PeerRegistry: () => ({ register, revoke }),
    }));
    try {
      const bridge = await import('../../../src/main/features/messaging/channel-bridge');
      const result = bridge.registerChannelBridgeNode(feishuInstance({ ownerExternalUserId: 'ou_owner123456' }));
      expect(result.ok).toBe(true);
      expect(register).toHaveBeenCalledTimes(1);
      // 节点注册能力与 descriptor 合约共用同一来源常量。
      expect(register.mock.calls[0][0]).toMatchObject({
        capabilities: ['messaging.relay', 'messaging.proactive'],
        node_kind: 'channel_bridge',
      });
      expect(bridge.getChannelDescriptor('inst-g17')?.capabilities.identity_proofs)
        .toEqual(['feishu-open_id:ou_owner123456']);
      expect(bridge.listFeishuChannelDescriptors()).toHaveLength(1);
      bridge.unregisterChannelBridgeNode('inst-g17');
      expect(bridge.getChannelDescriptor('inst-g17')).toBeUndefined();
      expect(bridge.listFeishuChannelDescriptors()).toHaveLength(0);
      expect(revoke).toHaveBeenCalledWith('channel-inst-g17');
    } finally {
      vi.doUnmock('../../../src/main/features/p3394_bridge/app-wiring');
      vi.resetModules();
    }
  });
});

// ── Q3：open_id→Peer 映射 ────────────────────────────────────────────

describe('channel peer map (Q3)', () => {
  it('ensures a peer idempotently with a stable readable alias', async () => {
    const map = await import('../../../src/main/features/p3394_bridge/channel-peer-map');
    const first = map.ensureChannelPeer('feishu_lark', 'inst-g17', 'ou_abcdefgh12345678', '牛保康');
    expect(first.peerAlias).toBe('user-fs-12345678');
    expect(first.externalUserName).toBe('牛保康');
    const again = map.ensureChannelPeer('feishu_lark', 'inst-g17', 'ou_abcdefgh12345678', '牛保康');
    expect(again).toEqual(first);
    expect(map.lookupChannelPeer('feishu_lark', 'inst-g17', 'ou_abcdefgh12345678')).toMatchObject({
      peerAlias: 'user-fs-12345678',
    });
    expect(map.lookupChannelPeer('feishu_lark', 'inst-g17', 'ou_unknown')).toBeNull();
    expect(map.listChannelPeers()).toHaveLength(1);
  });

  it('updates the display name but never rotates the alias', async () => {
    const map = await import('../../../src/main/features/p3394_bridge/channel-peer-map');
    const first = map.ensureChannelPeer('feishu_lark', 'inst-g17', 'ou_abcdefgh12345678');
    expect(first.externalUserName).toBeUndefined();
    const renamed = map.ensureChannelPeer('feishu_lark', 'inst-g17', 'ou_abcdefgh12345678', '子安');
    expect(renamed.peerAlias).toBe(first.peerAlias);
    expect(renamed.externalUserName).toBe('子安');
  });

  it('aliases are pure and platform-scoped', async () => {
    const { channelPeerAlias } = await import('../../../src/main/features/p3394_bridge/channel-peer-map');
    expect(channelPeerAlias('feishu_lark', 'ou_abcdefgh12345678')).toBe('user-fs-12345678');
    expect(channelPeerAlias('telegram', '123456789')).toBe('user-tg-23456789');
    // 短 id 不足 8 位时取全部，不报错。
    expect(channelPeerAlias('wecom', 'ab')).toBe('user-wc-ab');
  });
});

// ── G-17：台账 normalize 白名单 ──────────────────────────────────────

describe('inbound ledger image keys (G-17)', () => {
  it('normalizeInbound keeps imageKeys through the whitelist', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const data = ledger._ledgerTestHooks.normalizeInbound({
      version: 1,
      entries: {
        'inst-g17:om_1': {
          key: 'inst-g17:om_1',
          status: 'accepted',
          updatedAt: '2026-09-06T00:00:00.000Z',
          receivedAt: '2026-09-06T00:00:00.000Z',
          imageKeys: ['img_v2_abc'],
          // 白名单外的未知字段必须被丢弃。
          injected: 'dropped',
        },
      },
    });
    expect(data.entries['inst-g17:om_1']?.imageKeys).toEqual(['img_v2_abc']);
    expect((data.entries['inst-g17:om_1'] as Record<string, unknown>).injected).toBeUndefined();
  });

  it('normalizeInboundImageKeys dedupes, drops junk, and caps at 9', async () => {
    const { normalizeInboundImageKeys } = await import('../../../src/main/features/messaging/ledger');
    const keys = Array.from({ length: 12 }, (_, i) => `img_${i}`);
    expect(normalizeInboundImageKeys(keys)).toHaveLength(9);
    expect(normalizeInboundImageKeys(['img_1', 'img_1', '', '  ', 42, 'img_2'])).toEqual(['img_1', 'img_2']);
    expect(normalizeInboundImageKeys([])).toBeUndefined();
    expect(normalizeInboundImageKeys(undefined)).toBeUndefined();
    expect(normalizeInboundImageKeys(['', 'no-good'])).toEqual(['no-good']);
  });
});

// ── G-17：manager 派发投影链 ─────────────────────────────────────────

describe('G-17 inbound image projection dispatch', () => {
  function fakeFeishuAdapter(downloadImage?: (fileKey: string) => Promise<Buffer>): MessagingAdapter {
    const base: MessagingAdapter = {
      platform: 'feishu_lark',
      async start(signal, callbacks) {
        await callbacks.onStatus({ kind: 'connected', checkedAt: new Date().toISOString() });
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async stop() {},
      async checkHealth() {
        return { kind: 'connected', checkedAt: new Date().toISOString() };
      },
      async sendMessage() {
        return { deliveryId: 'remote-1' };
      },
    };
    return downloadImage ? { ...base, downloadMessageImage: (_mid: string, fk: string) => downloadImage(fk) } : base;
  }

  async function setupFlow(adapterOverride?: MessagingAdapter) {
    const groupSend = vi.fn(async () => ({ ok: true, msg: { id: 'm-1' } }));
    const subscribe = vi.fn(() => () => {});
    const adapter = adapterOverride ?? fakeFeishuAdapter();
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe }));
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const created = await registry.createInstance('user-1', {
      platform: 'feishu_lark',
      displayName: 'Test Feishu',
      policy: { allowUserIds: ['ou_abcdefgh12345678'] },
      secret: { appId: 'cli_0123456789abcdef', appSecret: 'g17-test-secret-value' },
    });
    await manager.setEnabled('user-1', created.id, true);
    await vi.waitFor(async () => {
      const instances = await manager.listInstances('user-1');
      expect(instances[0]?.status.kind).toBe('connected');
    });
    return { groupSend, manager, ledger, instanceId: created.id };
  }

  afterEach(() => {
    vi.doUnmock('../../../src/main/features/messaging/adapters');
    vi.doUnmock('../../../src/main/features/group_chat');
    vi.doUnmock('../../../src/main/features/group_chat/bus');
  });

  it('dispatches an image inbound with a p3394 envelope carrying parts.image reference uris', async () => {
    const { groupSend, manager, ledger, instanceId } = await setupFlow();
    const inbound = await manager.ingestInbound('user-1', {
      platform: 'feishu_lark',
      instanceId,
      externalMessageId: 'om_image_1',
      externalChatId: 'ou_abcdefgh12345678',
      externalUserId: 'ou_abcdefgh12345678',
      text: '[图片]',
      isGroup: false,
      mentionPresent: false,
      imageKeys: ['img_v2_abc123'],
      receivedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));
    expect(inbound.accepted).toBe(true);

    const dispatch = groupSend.mock.calls[0][0] as {
      userId: string;
      cid: string;
      text: string;
      p3394_envelope?: {
        message_id: string;
        session_id: string;
        sender: { agent_id: string; channel_instance_id?: string };
        payload: { parts: Array<{ type: string; text?: string; uri?: string; name?: string }>; metadata: Record<string, unknown> };
      };
    };
    expect(dispatch.userId).toBe('user-1');
    expect(dispatch.text).toBe('[图片]');
    expect(dispatch.p3394_envelope).toBeTruthy();
    expect(dispatch.p3394_envelope?.message_id).toBe(`inbound:${instanceId}:om_image_1`);
    expect(dispatch.p3394_envelope?.session_id).toBe(inbound.cid);
    expect(dispatch.p3394_envelope?.sender).toEqual({
      agent_id: 'user-fs-12345678',
      channel_instance_id: instanceId,
    });
    const parts = dispatch.p3394_envelope?.payload.parts || [];
    expect(parts[0]).toEqual({ type: 'text', text: '[图片]' });
    expect(parts[1]).toEqual({ type: 'image', uri: 'feishu-image:img_v2_abc123', name: 'img_v2_abc123' });
    expect(dispatch.p3394_envelope?.payload.metadata).toMatchObject({
      platform: 'feishu_lark',
      instance_id: instanceId,
      external_message_id: 'om_image_1',
    });

    // 台账可查 imageKey：渠道事件 → 台账 → 派发信封一条线。
    const entry = await ledger.readInbound('user-1', ledger.inboundKey(instanceId, 'om_image_1'));
    expect(entry?.status).toBe('accepted');
    expect(entry?.imageKeys).toEqual(['img_v2_abc123']);

    // Q3 接线：入站即记录 open_id→Peer 映射（variant 目录隔离）。
    const peerMap = await import('../../../src/main/features/p3394_bridge/channel-peer-map');
    expect(peerMap.lookupChannelPeer('feishu_lark', instanceId, 'ou_abcdefgh12345678')).toMatchObject({
      peerAlias: 'user-fs-12345678',
    });

    await manager.stopForUser('user-1');
  });

  it('downloads image bytes and dispatches with imported attachments (G-17 byte path)', async () => {
    // PNG magic + padding：downloadImage 返回字节，manager 导入会话附件目录
    // 并把附件名放进派发 attachments（视觉多模态链与桌面端发图同路）。
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]);
    const downloadImage = vi.fn(async () => pngBytes);
    const { groupSend, manager, instanceId } = await setupFlow(fakeFeishuAdapter(downloadImage));
    const inbound = await manager.ingestInbound('user-1', {
      platform: 'feishu_lark',
      instanceId,
      externalMessageId: 'om_image_bytes_1',
      externalChatId: 'ou_abcdefgh12345678',
      externalUserId: 'ou_abcdefgh12345678',
      text: '[图片]',
      isGroup: false,
      mentionPresent: false,
      imageKeys: ['img_v2_bytes'],
      receivedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));
    expect(inbound.accepted).toBe(true);
    expect(downloadImage).toHaveBeenCalledWith('img_v2_bytes');

    const dispatch = groupSend.mock.calls[0][0] as { attachments?: string[] };
    expect(dispatch.attachments).toEqual(['feishu-img_v2_bytes.png']);
    // 附件真实导入会话目录（COGSEED_WORKSPACE_ROOT 已隔离到 tmpDir）。
    const { listAttachments } = await import('../../../src/main/features/chat_attachments');
    const stored = listAttachments('user-1', String(inbound.cid)).find((a) => a.name === 'feishu-img_v2_bytes.png');
    expect(stored).toBeTruthy();
    expect(stored?.kind === 'image' || stored?.mime?.startsWith('image/')).toBe(true);

    await manager.stopForUser('user-1');
  });

  it('keeps dispatch working (no attachments) when image download fails', async () => {
    const downloadImage = vi.fn(async () => {
      throw new Error('feishu api down');
    });
    const { groupSend, manager, instanceId } = await setupFlow(fakeFeishuAdapter(downloadImage));
    const inbound = await manager.ingestInbound('user-1', {
      platform: 'feishu_lark',
      instanceId,
      externalMessageId: 'om_image_fail_1',
      externalChatId: 'ou_abcdefgh12345678',
      externalUserId: 'ou_abcdefgh12345678',
      text: '[图片]',
      isGroup: false,
      mentionPresent: false,
      imageKeys: ['img_v2_fail'],
      receivedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));
    expect(inbound.accepted).toBe(true);
    const dispatch = groupSend.mock.calls[0][0] as { attachments?: string[]; text: string };
    // 下载失败不阻塞：占位文本照常派发、不携带 attachments。
    expect(dispatch.text).toBe('[图片]');
    expect(dispatch.attachments).toBeUndefined();

    await manager.stopForUser('user-1');
  });

  it('omits the p3394 envelope entirely for text-only inbound (zero regression)', async () => {
    const { groupSend, manager, ledger, instanceId } = await setupFlow();
    const inbound = await manager.ingestInbound('user-1', {
      platform: 'feishu_lark',
      instanceId,
      externalMessageId: 'om_text_1',
      externalChatId: 'ou_abcdefgh12345678',
      externalUserId: 'ou_abcdefgh12345678',
      text: '纯文本消息',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));
    expect(inbound.accepted).toBe(true);
    const dispatch = groupSend.mock.calls[0][0] as Record<string, unknown>;
    expect(dispatch.p3394_envelope).toBeUndefined();
    expect(dispatch.text).toBe('纯文本消息');
    const entry = await ledger.readInbound('user-1', ledger.inboundKey(instanceId, 'om_text_1'));
    expect(entry?.imageKeys).toBeUndefined();
    await manager.stopForUser('user-1');
  });
});

// ── G-17：飞书二进制响应多形态兼容 ───────────────────────────────────

describe('G-17 feishu binary response shapes', () => {
  it('extracts bytes from stream / Buffer / base64 / wrapped shapes', async () => {
    const { Readable } = await import('node:stream');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16, 7)]);
    const cases: Array<[string, unknown]> = [
      ['sdk file wrapper {getReadableStream,writeFile,headers}', { getReadableStream: () => Readable.from([png]), writeFile: async () => {}, headers: {} }],
      ['stream', Readable.from([png])],
      ['buffer', png],
      ['base64', png.toString('base64')],
      ['axios {data:buffer}', { data: png }],
      ['axios {data:stream}', { data: Readable.from([png]) }],
      ['double-wrapped {data:{data:buffer}}', { data: { data: png } }],
      ['double-wrapped {data:{data:stream}}', { data: { data: Readable.from([png]) } }],
    ];
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    for (const [label, shape] of cases) {
      const adapter = Object.create(FeishuAdapter.prototype) as FeishuAdapter;
      (adapter as unknown as { client: unknown }).client = {
        im: { v1: { messageResource: { get: async () => shape } } },
      };
      const bytes = await adapter.downloadMessageImage('om_test123', 'img_v2_shape');
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(label).toBeTruthy();
    }
  });

  it('rejects empty and unusable shapes with a diagnosable message', async () => {
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = Object.create(FeishuAdapter.prototype) as FeishuAdapter;
    (adapter as unknown as { client: unknown }).client = {
      im: { v1: { messageResource: { get: async () => ({ code: 0, msg: 'ok' }) } } },
    };
    await expect(adapter.downloadMessageImage('om_test123', 'img_v2_empty'))
      .rejects.toThrow(/no bytes in response \(shape:/);
  });
});
