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
        mentions: [{ key: '@_user_1' }],
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    });
    expect(event).toMatchObject({
      platform: 'feishu_lark',
      externalMessageId: 'om_1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_1',
      text: 'hello',
      isGroup: true,
      mentionPresent: true,
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
      request: vi.fn(),
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
});
