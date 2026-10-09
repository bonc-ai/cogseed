import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InboundEnvelope,
  MessagingInstanceStatus,
} from '../../../src/main/features/messaging/types';

type Listener = (...args: unknown[]) => void;

interface MockWecomClientOptions {
  botId: string;
  secret: string;
  maxReconnectAttempts?: number;
  maxAuthFailureAttempts?: number;
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

interface SentMessage {
  chatId: string;
  body: {
    msgtype: 'markdown';
    markdown: { content: string };
  };
}

class MockWecomClient {
  static instances: MockWecomClient[] = [];

  readonly options: MockWecomClientOptions;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sentMessages: SentMessage[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  isConnected = false;
  private deliveryCounter = 0;

  constructor(options: MockWecomClientOptions) {
    this.options = options;
    MockWecomClient.instances.push(this);
  }

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) || new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args: unknown[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) this.listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
  }

  connect(): this {
    this.connectCalls += 1;
    this.isConnected = true;
    return this;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.isConnected = false;
  }

  async sendMessage(
    chatId: string,
    body: SentMessage['body'],
  ): Promise<{ headers: { req_id: string }; errcode: number }> {
    this.sentMessages.push({ chatId, body });
    this.deliveryCounter += 1;
    return {
      headers: { req_id: `send_${this.deliveryCounter}` },
      errcode: 0,
    };
  }
}

function wecomInstance() {
  return {
    id: 'wecom-bot-1',
    platform: 'wecom' as const,
    displayName: 'WeCom helper',
    enabled: true,
    workspace: { type: 'default' as const },
    policy: {
      replyMode: 'every_message' as const,
      allowUserIds: [],
      allowGroupIds: [],
      requireMentionInGroups: true,
    },
    status: { kind: 'connecting' as const, checkedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function textFrame(overrides: Record<string, unknown> = {}) {
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'callback-1' },
    body: {
      msgid: 'message-1',
      aibotid: 'bot_123',
      chattype: 'single' as const,
      from: { userid: 'user-1' },
      create_time: 1_710_000_000,
      msgtype: 'text' as const,
      text: { content: ' hello ' },
      ...overrides,
    },
  };
}

describe('WeCom official WebSocket adapter', () => {
  beforeEach(() => {
    MockWecomClient.instances = [];
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@wecom/aibot-node-sdk');
    vi.resetModules();
  });

  it('normalizes single/group text frames, gates sending on auth, and redacts credentials', async () => {
    vi.doMock('@wecom/aibot-node-sdk', () => ({ WSClient: MockWecomClient }));
    const { WecomAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new WecomAdapter(wecomInstance(), {
      wecomBotId: 'bot_123',
      wecomBotSecret: 'super-secret-value',
    });
    const client = MockWecomClient.instances[0];
    if (!client) throw new Error('mock client was not constructed');

    const statuses: MessagingInstanceStatus[] = [];
    const inbound: InboundEnvelope[] = [];
    const controller = new AbortController();
    const running = adapter.start(controller.signal, {
      onInbound: async (envelope) => { inbound.push(envelope); },
      onStatus: async (next) => { statuses.push(next); },
    });

    await vi.waitFor(() => expect(client.connectCalls).toBe(1));
    expect(client.options).toMatchObject({
      botId: 'bot_123',
      secret: 'super-secret-value',
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
    });
    expect(client.options.logger?.debug('ignored')).toBeUndefined();
    await expect(adapter.sendMessage('user-1', 'before auth')).rejects.toThrow('not authenticated');

    client.emit('connected');
    client.emit('authenticated');
    await vi.waitFor(() => expect(statuses.map((item) => item.kind)).toContain('connected'));

    client.emit('message.text', textFrame());
    client.emit('message.text', textFrame({
      msgid: 'message-2',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'user-2' },
      text: { content: ' group message ' },
    }));
    client.emit('message.text', textFrame({
      msgid: 'ignored-bot-id',
      aibotid: 'other-bot',
    }));
    client.emit('message.text', textFrame({
      msgid: 'ignored-group-without-id',
      chattype: 'group',
      chatid: undefined,
    }));

    await vi.waitFor(() => expect(inbound).toHaveLength(2));
    expect(inbound[0]).toMatchObject({
      platform: 'wecom',
      instanceId: 'wecom-bot-1',
      externalMessageId: 'message-1',
      externalChatId: 'user-1',
      externalUserId: 'user-1',
      text: 'hello',
      isGroup: false,
      mentionPresent: false,
    });
    expect(inbound[1]).toMatchObject({
      externalMessageId: 'message-2',
      externalChatId: 'group-1',
      externalUserId: 'user-2',
      text: 'group message',
      isGroup: true,
      mentionPresent: true,
    });
    expect(JSON.stringify(inbound)).not.toContain('super-secret-value');

    await expect(adapter.sendMessage('group-1', 'reply')).resolves.toEqual({ deliveryId: 'send_1' });
    expect(client.sentMessages).toEqual([{
      chatId: 'group-1',
      body: { msgtype: 'markdown', markdown: { content: 'reply' } },
    }]);

    controller.abort();
    await running;
    expect(client.disconnectCalls).toBeGreaterThan(0);
    expect(JSON.stringify(statuses)).not.toContain('super-secret-value');
  });

  it('stops on terminal authentication failure and removes stale listeners', async () => {
    vi.doMock('@wecom/aibot-node-sdk', () => ({ WSClient: MockWecomClient }));
    const { WecomAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new WecomAdapter(wecomInstance(), {
      wecomBotId: 'bot_123',
      wecomBotSecret: 'super-secret-value',
    });
    const client = MockWecomClient.instances[0];
    if (!client) throw new Error('mock client was not constructed');
    const statuses: MessagingInstanceStatus[] = [];
    const inbound: InboundEnvelope[] = [];
    const running = adapter.start(new AbortController().signal, {
      onInbound: async (envelope) => { inbound.push(envelope); },
      onStatus: async (next) => { statuses.push(next); },
    });

    await vi.waitFor(() => expect(client.connectCalls).toBe(1));
    const terminal = Object.assign(new Error('secret must not be logged'), {
      code: 'WS_AUTH_FAILURE_EXHAUSTED',
    });
    client.emit('error', terminal);
    await expect(running).rejects.toThrow('WeCom authentication failed');
    expect(statuses.at(-1)).toMatchObject({ kind: 'error', message: 'WeCom authentication failed' });
    expect(client.disconnectCalls).toBeGreaterThan(0);

    client.emit('message.text', textFrame({ msgid: 'stale-after-stop' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inbound).toHaveLength(0);
    expect(JSON.stringify(statuses)).not.toContain('secret must not be logged');
  });

  it('reports an active connection health state without disrupting its WebSocket', async () => {
    vi.doMock('@wecom/aibot-node-sdk', () => ({ WSClient: MockWecomClient }));
    const { WecomAdapter } = await import('../../../src/main/features/messaging/adapters');
    const adapter = new WecomAdapter(wecomInstance(), {
      wecomBotId: 'bot_123',
      wecomBotSecret: 'super-secret-value',
    });
    const client = MockWecomClient.instances[0];
    if (!client) throw new Error('mock client was not constructed');
    const controller = new AbortController();
    const running = adapter.start(controller.signal, {
      onInbound: async () => {},
      onStatus: async () => {},
    });

    await vi.waitFor(() => expect(client.connectCalls).toBe(1));
    const before = { connectCalls: client.connectCalls, disconnectCalls: client.disconnectCalls };
    await expect(adapter.checkHealth()).resolves.toMatchObject({ kind: 'connecting' });
    expect(client.connectCalls).toBe(before.connectCalls);
    expect(client.disconnectCalls).toBe(before.disconnectCalls);

    client.emit('authenticated');
    await expect(adapter.checkHealth()).resolves.toMatchObject({ kind: 'connected' });
    expect(client.connectCalls).toBe(before.connectCalls);
    expect(client.disconnectCalls).toBe(before.disconnectCalls);

    controller.abort();
    await running;
  });
});
