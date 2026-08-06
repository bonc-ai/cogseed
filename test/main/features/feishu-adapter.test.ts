import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
