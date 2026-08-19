import { afterEach, describe, expect, it, vi } from 'vitest';

// Shared logger mock so the warn-once behavior of identity lookups is
// observable (mirrors agents.test.ts, which swaps the real logger for fns).
const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => mockLogger,
}));

function feishuInstance() {
  return {
    id: 'feishu-bot-1',
    platform: 'feishu_lark' as const,
    displayName: 'Helper',
    enabled: true,
    workspace: { type: 'default' as const },
    policy: {
      replyMode: 'every_message' as const,
      allowUserIds: [],
      allowGroupIds: [],
      requireMentionInGroups: true,
    },
    status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  vi.doUnmock('@larksuiteoapi/node-sdk');
  vi.resetModules();
});

describe('Feishu official event adapter', () => {
  it('normalizes the flattened SDK event shape and rejects bot events', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const instance = feishuInstance();
    const event = _adapterTestHooks.normalizeFeishuEvent(instance, {
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: ' hello ' }),
        create_time: '1710000000000',
        mentions: [
          { key: '@_user_1', open_id: 'ou_bot' },
          { key: '@_alice', open_id: 'ou_alice' },
        ],
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    }, 'ou_bot');
    expect(event).toMatchObject({
      platform: 'feishu_lark',
      externalMessageId: 'om_1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
      botMentionTokens: ['@_user_1'],
    });
    expect(_adapterTestHooks.normalizeFeishuEvent(instance, {
      message: { message_id: 'om_2', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'bot' }) },
      sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } },
    })).toBeNull();
  });

  it('reports connected only after the SDK handshake and stops on its terminal error callback', async () => {
    interface WsOptions {
      onReady?: () => void;
      onError?: (error: Error) => void;
      onReconnecting?: () => void;
      onReconnected?: () => void;
      handshakeTimeoutMs?: number;
    }

    let wsOptions: WsOptions | undefined;
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const wsClient = {
      start: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create: vi.fn() } } },
    };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient(options: WsOptions) {
      wsOptions = options;
      return wsClient;
    });
    const Client = vi.fn(function Client() { return client; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const states: Array<{ kind: string; message?: string }> = [];
    const controller = new AbortController();
    const running = adapter.start(controller.signal, {
      onInbound: async () => {},
      onStatus: async (next) => { states.push(next); },
    });

    await vi.waitFor(() => expect(wsClient.start).toHaveBeenCalledTimes(1));
    expect(states.map((item) => item.kind)).toEqual(['connecting']);
    expect(wsOptions?.handshakeTimeoutMs).toBe(15_000);

    wsOptions?.onReady?.();
    await vi.waitFor(() => expect(states.map((item) => item.kind)).toEqual(['connecting', 'connected']));

    wsOptions?.onError?.(new Error('client_secret=app-secret'));
    await expect(running).rejects.toThrow('Feishu persistent connection failed');
    expect(states.at(-1)).toMatchObject({ kind: 'error', message: 'Feishu connection failed' });
    expect(wsClient.close).toHaveBeenCalledWith({ force: true });
  });

  it('sends and patches interactive cards through the official SDK', async () => {
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_card_1' } }));
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_card_2' } }));
    const patch = vi.fn(async () => ({ code: 0, data: {} }));
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create, reply, patch } } },
    };
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client: vi.fn(function Client() { return client; }),
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher: vi.fn(function EventDispatcher() { return dispatcher; }),
      LoggerLevel: { error: 'error' },
      WSClient: vi.fn(),
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Mate Agent' } },
      elements: [{ tag: 'markdown', content: 'hello' }],
    };
    const sent = await adapter.sendCard('oc_1', card);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: { receive_id_type: 'chat_id' },
      data: expect.objectContaining({
        receive_id: 'oc_1',
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    }));
    expect(sent).toEqual({ deliveryId: 'om_card_1' });

    const replied = await adapter.sendCard('oc_1', card, undefined, { replyToMessageId: 'om_0' });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: 'om_0' },
      data: expect.objectContaining({ msg_type: 'interactive' }),
    }));
    expect(replied).toEqual({ deliveryId: 'om_card_2' });

    const nextCard = { ...card, elements: [{ tag: 'markdown', content: 'hello world' }] };
    const updated = await adapter.updateCard('om_card_1', nextCard);
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: 'om_card_1' },
      data: { content: JSON.stringify(nextCard) },
    });
    expect(updated).toEqual({ deliveryId: 'om_card_1' });
  });

  it('sends markdown as a post payload and plain text as text', async () => {
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_post_1' } }));
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create, reply: vi.fn(), patch: vi.fn() } } },
    };
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client: vi.fn(function Client() { return client; }),
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher: vi.fn(function EventDispatcher() { return dispatcher; }),
      LoggerLevel: { error: 'error' },
      WSClient: vi.fn(),
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });

    const rich = await adapter.sendMessage('oc_1', '**加粗**和`code`');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ msg_type: 'post' }),
    }));
    const postPayload = JSON.parse((create.mock.calls[0][0] as { data: { content: string } }).data.content);
    expect(postPayload.zh_cn.content).toEqual([[{ tag: 'md', text: '**加粗**和`code`' }]]);
    expect(rich).toEqual({ deliveryId: 'om_post_1' });

    const plain = await adapter.sendMessage('oc_1', '就是纯文本');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        msg_type: 'text',
        content: JSON.stringify({ text: '就是纯文本' }),
      }),
    }));
    expect(plain).toEqual({ deliveryId: 'om_post_1' });
  });

  it('sends a proactive self message with receive_id_type open_id', async () => {
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_self_1' } }));
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create, reply: vi.fn(), patch: vi.fn() } } },
    };
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client: vi.fn(function Client() { return client; }),
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher: vi.fn(function EventDispatcher() { return dispatcher; }),
      LoggerLevel: { error: 'error' },
      WSClient: vi.fn(),
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });

    const sent = await adapter.sendMessage('ou_self_1', 'hello self', undefined, { recipientIdType: 'open_id' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: { receive_id_type: 'open_id' },
      data: expect.objectContaining({ receive_id: 'ou_self_1', msg_type: 'text' }),
    }));
    expect(sent).toEqual({ deliveryId: 'om_self_1' });
  });

  it('splits long replies into multiple messages with per-chunk uuids', async () => {
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_chunk' } }));
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create, reply: vi.fn(), patch: vi.fn() } } },
    };
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client: vi.fn(function Client() { return client; }),
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher: vi.fn(function EventDispatcher() { return dispatcher; }),
      LoggerLevel: { error: 'error' },
      WSClient: vi.fn(),
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });

    const long = Array.from({ length: 600 }, (_, i) => `第 ${i} 行内容，用于撑到分块阈值。`).join('\n');
    await adapter.sendMessage('oc_1', long, undefined, { idempotencyKey: 'key-1' });
    expect(create.mock.calls.length).toBeGreaterThan(1);
    const uuids = create.mock.calls.map((call) => (call[0] as { data: { uuid?: string } }).data.uuid);
    expect(uuids[0]).toBe('key-1#0');
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it('degrades a rejected post payload to plain text', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ code: 190001, msg: 'content format of the post type is incorrect' })
      .mockResolvedValue({ code: 0, data: { message_id: 'om_text_1' } });
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create, reply: vi.fn(), patch: vi.fn() } } },
    };
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client: vi.fn(function Client() { return client; }),
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher: vi.fn(function EventDispatcher() { return dispatcher; }),
      LoggerLevel: { error: 'error' },
      WSClient: vi.fn(),
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });

    const sent = await adapter.sendMessage('oc_1', '**加粗**内容');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ data: { msg_type: 'post' } });
    const fallback = create.mock.calls[1][0] as { data: { msg_type: string; content: string } };
    expect(fallback.data.msg_type).toBe('text');
    expect(JSON.parse(fallback.data.content)).toEqual({ text: '加粗内容' });
    expect(sent).toEqual({ deliveryId: 'om_text_1' });
  });

  it('falls back to a fresh message when the reply target no longer exists', async () => {
    const reply = vi.fn(async () => ({ code: 230011, msg: 'message not exist' }));
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_new_1' } }));
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create, reply, patch: vi.fn() } } },
    };
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client: vi.fn(function Client() { return client; }),
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher: vi.fn(function EventDispatcher() { return dispatcher; }),
      LoggerLevel: { error: 'error' },
      WSClient: vi.fn(),
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });

    const sent = await adapter.sendMessage('oc_1', '普通文本', undefined, { replyToMessageId: 'om_gone' });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: { receive_id_type: 'chat_id' },
      data: expect.objectContaining({ receive_id: 'oc_1' }),
    }));
    expect(sent).toEqual({ deliveryId: 'om_new_1' });
  });

  it('does not fall back to a fresh message inside a thread', async () => {
    const reply = vi.fn(async () => ({ code: 230011, msg: 'message not exist' }));
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_new_1' } }));
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create, reply, patch: vi.fn() } } },
    };
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client: vi.fn(function Client() { return client; }),
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher: vi.fn(function EventDispatcher() { return dispatcher; }),
      LoggerLevel: { error: 'error' },
      WSClient: vi.fn(),
    }));

    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });

    await expect(adapter.sendMessage('oc_1', '线程内', undefined, {
      replyToMessageId: 'om_gone',
      replyInThread: true,
    })).rejects.toThrow('message not exist');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('normalizes reaction events and rejects non-user operators', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const { normalizeFeishuReaction } = _adapterTestHooks;
    expect(normalizeFeishuReaction({
      message_id: 'om_9',
      user_id: { open_id: 'ou_1' },
      operator_type: 'user',
      reaction_type: { emoji_type: 'THUMBSUP' },
      create_time: '1710000000000',
    })).toEqual({
      messageId: 'om_9',
      operatorOpenId: 'ou_1',
      emoji: 'THUMBSUP',
      createTime: '2024-03-09T16:00:00.000Z',
    });
    expect(normalizeFeishuReaction({
      message_id: 'om_9',
      operator_id: 'ou_bot',
      operator_type: 'app',
      reaction_type: { emoji_type: 'Typing' },
    })).toBeNull();
    expect(normalizeFeishuReaction({ operator_type: 'user' })).toBeNull();
    expect(normalizeFeishuReaction({ message_id: 'om_9', user_id: { open_id: 'ou_1' }, operator_type: 'user' })).toBeNull();
  });

  it('synthesizes an inbound envelope only for reactions on our own messages', async () => {
    let handlers: Record<string, (event: unknown) => Promise<unknown>> = {};
    const dispatcher = {
      register: vi.fn((registered: Record<string, (event: unknown) => Promise<unknown>>) => {
        handlers = registered;
        return dispatcher;
      }),
    };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    const Client = vi.fn(function Client() { return {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create: vi.fn() } } },
    }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const onInbound = vi.fn(async () => ({ accepted: true, duplicate: false }));
    const delivery = {
      key: 'k',
      instanceId: 'feishu-bot-1',
      externalChatId: 'oc_1',
      sourceMessageId: 'src-1',
      textHash: 'h',
      status: 'sent' as const,
      attempts: 1,
      updatedAt: new Date().toISOString(),
      externalDeliveryId: 'om_9',
    };
    const resolveDelivery = vi.fn(async () => delivery);
    (adapter as unknown as { callbacks: unknown }).callbacks = { onInbound, resolveDelivery };

    const reaction = handlers['im.message.reaction.created_v1'];
    expect(reaction).toBeTypeOf('function');

    // app 操作者（bot 自己的处理中 reaction）→ 不查账本
    await reaction({ operator_type: 'app', message_id: 'om_9', reaction_type: { emoji_type: 'Typing' } });
    expect(resolveDelivery).not.toHaveBeenCalled();
    expect(onInbound).not.toHaveBeenCalled();

    // 不是我们发的消息 → 不合成
    resolveDelivery.mockResolvedValueOnce(null);
    await reaction({ operator_type: 'user', user_id: { open_id: 'ou_1' }, message_id: 'om_9', reaction_type: { emoji_type: 'THUMBSUP' }, create_time: '1710000000000' });
    expect(onInbound).not.toHaveBeenCalled();

    // 我们发过的消息 → 合成 synthetic envelope
    await reaction({ operator_type: 'user', user_id: { open_id: 'ou_1' }, message_id: 'om_9', reaction_type: { emoji_type: 'THUMBSUP' }, create_time: '1710000000000' });
    expect(onInbound).toHaveBeenCalledTimes(1);
    const envelope = onInbound.mock.calls[0][0];
    expect(envelope).toMatchObject({
      platform: 'feishu_lark',
      instanceId: 'feishu-bot-1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'reaction:added:THUMBSUP',
      isGroup: true,
      mentionPresent: true,
      synthetic: true,
    });
    expect(envelope.externalMessageId).toContain('om_9');
  });

  it('removes the processing reaction without a failure marker when the inbound is merged', async () => {
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const create = vi.fn(async () => ({ code: 0, data: { reaction_id: 'reaction-1' } }));
    const remove = vi.fn(async () => ({ code: 0 }));
    (adapter as unknown as { client: { im: { v1: { message_reaction: { create: typeof create; delete: typeof remove } } } } }).client.im.v1.messageReaction = { create, delete: remove };
    const onInbound = vi.fn(async () => ({ accepted: false, duplicate: true, reason: 'merged' }));
    (adapter as unknown as { callbacks: unknown }).callbacks = { onInbound, onStatus: vi.fn(async () => {}) };

    await (adapter as unknown as { handleInboundWithReaction(envelope: unknown): Promise<void> }).handleInboundWithReaction({
      platform: 'feishu_lark',
      instanceId: 'feishu-bot-1',
      externalMessageId: 'om_merged_1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'trailing chunk',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    });
    // Merged burst chunks are consumed, not failures: only the Typing
    // processing reaction is created, then removed, with no CrossMark.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: 'om_merged_1' },
      data: { reaction_type: { emoji_type: 'Typing' } },
    }));
    expect(remove).toHaveBeenCalledWith({ path: { message_id: 'om_merged_1', reaction_id: 'reaction-1' } });
  });

  it('treats @all mentions as a present mention in text and post messages', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const instance = feishuInstance();
    const textAll = _adapterTestHooks.normalizeFeishuEvent(instance, {
      message: {
        message_id: 'om_3',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_all 明天同步进度' }),
        create_time: '1710000000000',
        mentions: [{ key: '@_all', id_type: 'user_id', id: 'all' }],
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    }, 'ou_bot');
    expect(textAll).toMatchObject({ mentionPresent: true });
    const postAll = _adapterTestHooks.normalizeFeishuEvent(instance, {
      message: {
        message_id: 'om_4',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: { title: '', content: [[{ tag: 'text', text: '通知' }]] },
        }),
        create_time: '1710000000000',
        mentions: [{ key: '@_all', id_type: 'user_id', id: 'all' }],
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    }, 'ou_bot');
    expect(postAll).toMatchObject({ mentionPresent: true });
  });
});

describe('Feishu sender enrichment', () => {
  it('fills user name and chat title once, then serves from cache', async () => {
    const userGet = vi.fn(async () => ({ code: 0, data: { user: { name: 'Alice' } } }));
    const chatGet = vi.fn(async () => ({ code: 0, data: { chat: { name: '项目群' } } }));
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      contact: { v3: { user: { get: userGet } } },
      im: { v1: { chat: { get: chatGet }, message: { create: vi.fn() } } },
    };
    const Client = vi.fn(function Client() { return client; });
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const base = {
      platform: 'feishu_lark' as const,
      instanceId: 'bot-1',
      externalMessageId: 'm-1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    };
    const first = await (adapter as unknown as { enrichSenderInfo(envelope: unknown): Promise<unknown> }).enrichSenderInfo(base);
    expect(first).toMatchObject({ externalUserName: 'Alice', externalChatTitle: '项目群' });
    expect(userGet).toHaveBeenCalledTimes(1);
    expect(chatGet).toHaveBeenCalledTimes(1);
    const second = await (adapter as unknown as { enrichSenderInfo(envelope: unknown): Promise<unknown> }).enrichSenderInfo(base);
    expect(userGet).toHaveBeenCalledTimes(1);
    expect(chatGet).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ externalUserName: 'Alice', externalChatTitle: '项目群' });
  });

  it('degrades silently when identity lookups fail', async () => {
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      contact: { v3: { user: { get: vi.fn(async () => { throw new Error('no permission'); }) } } },
      im: { v1: { chat: { get: vi.fn(async () => { throw new Error('no permission'); }) }, message: { create: vi.fn() } } },
    };
    const Client = vi.fn(function Client() { return client; });
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const base = {
      platform: 'feishu_lark' as const,
      instanceId: 'bot-1',
      externalMessageId: 'm-1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    };
    const result = await (adapter as unknown as { enrichSenderInfo(envelope: unknown): Promise<unknown> }).enrichSenderInfo(base);
    expect(result).toMatchObject(base);
  });

  it('warns once per failing identity key, not per lookup', async () => {
    const userGet = vi.fn(async () => { throw new Error('no permission'); });
    const chatGet = vi.fn(async () => { throw new Error('no permission'); });
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      contact: { v3: { user: { get: userGet } } },
      im: { v1: { chat: { get: chatGet }, message: { create: vi.fn() } } },
    };
    const Client = vi.fn(function Client() { return client; });
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    const base = {
      platform: 'feishu_lark' as const,
      instanceId: 'bot-1',
      externalMessageId: 'm-1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    };
    const castAdapter = adapter as unknown as { enrichSenderInfo(envelope: unknown): Promise<unknown> };
    mockLogger.warn.mockClear();
    // Failures are never cached, so the second call hits the API again — but
    // the warn-once set keeps the log at exactly one record per key.
    await castAdapter.enrichSenderInfo(base);
    await castAdapter.enrichSenderInfo(base);
    expect(userGet).toHaveBeenCalledTimes(2);
    expect(chatGet).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Feishu user name lookup failed',
      expect.objectContaining({ instanceId: 'feishu-bot-1' }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Feishu chat title lookup failed',
      expect.objectContaining({ instanceId: 'feishu-bot-1' }),
    );
  });
});

describe('Feishu inbound dispatch resilience', () => {
  it('a never-settling identity lookup cannot block the message from business dispatch', async () => {
    // lark SDK 默认 axios 客户端不设请求超时：身份查询一旦挂起（网络卡死/
    // 半开连接）就永不返回。入站路径必须对前置身份查询设 deadline——到点
    // 退化为 id-only envelope 继续进入 onInbound 业务调度。
    const never = new Promise(() => {});
    const userGet = vi.fn(() => never);
    const chatGet = vi.fn(() => never);
    const client = {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      contact: { v3: { user: { get: userGet } } },
      im: {
        v1: {
          chat: { get: chatGet },
          message: { create: vi.fn() },
          messageReaction: {
            create: vi.fn(async () => ({ code: 0, data: { reaction_id: 'reaction-1' } })),
            delete: vi.fn(async () => ({ code: 0 })),
          },
        },
      },
    };
    const Client = vi.fn(function Client() { return client; });
    const dispatcher = { register: vi.fn(function register() { return dispatcher; }) };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new FeishuAdapter(feishuInstance(), {
      appId: 'cli_1234567890abcdef',
      appSecret: 'app-secret',
    });
    // 测试把 deadline 压到 20ms，避免用例真实等待 5s。
    (adapter as unknown as { preDispatchDeadlineMs: number }).preDispatchDeadlineMs = 20;
    const onInbound = vi.fn(async () => ({ accepted: true, duplicate: false }));
    (adapter as unknown as { callbacks: unknown }).callbacks = { onInbound, onStatus: vi.fn(async () => {}) };
    const base = {
      platform: 'feishu_lark' as const,
      instanceId: 'feishu-bot-1',
      externalMessageId: 'om_stuck_1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    };
    await (adapter as unknown as { handleInboundWithReaction(envelope: unknown): Promise<void> }).handleInboundWithReaction(base);
    // 身份查询仍在挂起，但消息已进入业务调度：onInbound 必然被调用，且
    // envelope 保持 id-only（名字/群名未填充也不阻塞）。
    expect(onInbound).toHaveBeenCalledTimes(1);
    const dispatched = onInbound.mock.calls[0][0];
    expect(dispatched).toMatchObject(base);
    expect(dispatched.externalUserName).toBeUndefined();
    expect(dispatched.externalChatTitle).toBeUndefined();
    expect(userGet).toHaveBeenCalledTimes(1);
    // 顺序身份查询：user 查询先挂起，整体被 deadline 截断，chat 查询不会轮到。
    expect(chatGet).not.toHaveBeenCalled();
  });
});
