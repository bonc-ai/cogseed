import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import * as lark from '@larksuiteoapi/node-sdk';
import * as wecom from '@wecom/aibot-node-sdk';
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import type {
  AdapterCallbacks,
  FeishuTenantBrand,
  InboundEnvelope,
  JsonCompatibleValue,
  MessagingAdapter,
  MessagingCardAdapter,
  MessagingInstance,
  MessagingInstanceStatus,
  MessagingPlatform,
  MessagingSecret,
  MessagingSendContext,
} from './types';

const log = createLogger('messaging:adapters');
const sdkLogger = {
  // The SDK can include URLs, credentials, and event bodies in log arguments.
  // Drop them at the boundary instead of forwarding them to application logs.
  error: (..._args: unknown[]): void => {},
  warn: (..._args: unknown[]): void => {},
  info: (..._args: unknown[]): void => {},
  debug: (..._args: unknown[]): void => {},
  trace: (..._args: unknown[]): void => {},
};

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    from?: { id?: number; username?: string; first_name?: string; last_name?: string };
    chat?: { id?: number; type?: string; title?: string; username?: string };
    entities?: Array<{ type?: string; offset?: number; length?: number }>;
  };
}

interface TelegramResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

interface FeishuMessage {
  message_id?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  create_time?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  mentions?: Array<{
    key?: string;
    open_id?: string;
    id?: { open_id?: string } | string;
    id_type?: string;
  }>;
}

interface FeishuEventData {
  message?: FeishuMessage;
  sender?: {
    sender_type?: string;
    sender_id?: { open_id?: string; user_id?: string };
  };
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
}

interface FeishuBotInfoResponse extends FeishuApiResponse {
  data?: { open_id?: string };
}

interface WecomMessageFrame extends WsFrame<TextMessage> {}

function normalizeWecomEvent(
  instance: MessagingInstance,
  botId: string,
  frame: WecomMessageFrame,
): InboundEnvelope | null {
  if (frame.cmd !== 'aibot_msg_callback' || !frame.headers?.req_id) return null;
  const body = frame.body;
  if (!body || body.msgtype !== 'text' || body.aibotid !== botId) return null;
  const msgid = typeof body.msgid === 'string' ? body.msgid.trim() : '';
  const userId = typeof body.from?.userid === 'string' ? body.from.userid.trim() : '';
  const content = typeof body.text?.content === 'string' ? body.text.content.trim() : '';
  if (!msgid || !userId || !content) return null;
  if (body.chattype !== 'single' && body.chattype !== 'group') return null;
  const externalChatId = body.chattype === 'group'
    ? (typeof body.chatid === 'string' ? body.chatid.trim() : '')
    : userId;
  if (!externalChatId) return null;
  const rawCreateTime = Number(body.create_time);
  const createTime = Number.isFinite(rawCreateTime) && rawCreateTime > 0
    ? new Date(rawCreateTime * 1000)
    : new Date();
  // WeCom smart bots only receive group messages addressed to the bot. The
  // protocol has no mention field, so preserve that platform guarantee here
  // instead of guessing from user-controlled text.
  return {
    platform: 'wecom',
    instanceId: instance.id,
    externalMessageId: msgid,
    externalChatId,
    externalUserId: userId,
    text: content,
    isGroup: body.chattype === 'group',
    mentionPresent: body.chattype === 'group',
    receivedAt: Number.isNaN(createTime.getTime()) ? new Date().toISOString() : createTime.toISOString(),
  };
}

function feishuMentionOpenId(mention: NonNullable<FeishuMessage['mentions']>[number]): string {
  if (typeof mention.open_id === 'string') return mention.open_id.trim();
  if (mention.id && typeof mention.id === 'object' && typeof mention.id.open_id === 'string') {
    return mention.id.open_id.trim();
  }
  if (mention.id_type === 'open_id' && typeof mention.id === 'string') return mention.id.trim();
  return '';
}

function normalizeFeishuEvent(
  instance: MessagingInstance,
  payload: FeishuEventData,
  botOpenId = '',
): InboundEnvelope | null {
  const message = payload.message;
  const senderInfo = payload.sender;
  const sender = senderInfo?.sender_id;
  if (senderInfo?.sender_type && senderInfo.sender_type !== 'user') return null;
  if (!message?.message_id || !message.chat_id || !sender?.open_id || message.message_type !== 'text') return null;
  let text = message.content || '';
  try {
    const content = JSON.parse(text) as { text?: string };
    if (typeof content.text === 'string') text = content.text;
  } catch { /* malformed content is ignored */ }
  text = text.trim();
  if (!text) return null;
  const isGroup = message.chat_type === 'group';
  const normalizedBotOpenId = botOpenId.trim();
  const botMentionTokens = normalizedBotOpenId
    ? (message.mentions || [])
      .filter((mention) => feishuMentionOpenId(mention) === normalizedBotOpenId)
      .map((mention) => typeof mention.key === 'string' ? mention.key.trim() : '')
      .filter((token): token is string => !!token)
    : [];
  const rawCreateTime = Number(message.create_time);
  const createTime = Number.isFinite(rawCreateTime)
    ? new Date((rawCreateTime > 10_000_000_000 ? rawCreateTime : rawCreateTime * 1000))
    : new Date();
  return {
    platform: 'feishu_lark',
    instanceId: instance.id,
    externalMessageId: message.message_id,
    externalChatId: message.chat_id,
    externalUserId: sender.open_id,
    text,
    isGroup,
    mentionPresent: botMentionTokens.length > 0,
    ...(botMentionTokens.length ? { botMentionTokens } : {}),
    replyToMessageId: message.message_id,
    ...(message.thread_id?.trim() || message.root_id?.trim() ? { replyInThread: true } : {}),
    receivedAt: Number.isNaN(createTime.getTime()) ? new Date().toISOString() : createTime.toISOString(),
  };
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs = 20_000, lifecycleSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  const signals = [init.signal, lifecycleSignal].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
  const abort = (): void => controller.abort();
  try {
    for (const signal of signals) {
      if (signal.aborted) {
        abort();
        break;
      }
      signal.addEventListener('abort', abort, { once: true });
    }
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      throw new Error(`invalid JSON response (${response.status})`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener('abort', abort);
  }
}

function status(kind: MessagingInstanceStatus['kind'], message?: string): MessagingInstanceStatus {
  return {
    kind,
    checkedAt: new Date().toISOString(),
    ...(message ? { message: message.slice(0, 500) } : {}),
    ...(kind === 'connected' ? { connectedAt: new Date().toISOString() } : {}),
  };
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function mergeSignals(parent: AbortSignal, local: AbortController): AbortSignal {
  if (parent.aborted) local.abort(parent.reason);
  else parent.addEventListener('abort', () => local.abort(parent.reason), { once: true });
  return local.signal;
}

export class TelegramAdapter implements MessagingAdapter {
  readonly platform: MessagingPlatform = 'telegram';
  private readonly token: string;
  private readonly instance: MessagingInstance;
  private readonly localController = new AbortController();
  private offset = 0;
  private callbacks: AdapterCallbacks | null = null;

  constructor(instance: MessagingInstance, secret: MessagingSecret) {
    if (!secret.botToken) throw new Error('Telegram bot token missing');
    this.token = secret.botToken;
    this.instance = instance;
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async api<T>(
    method: string,
    body: Record<string, string | number | boolean | string[]> = {},
    timeoutMs = 20_000,
    lifecycleSignal?: AbortSignal,
  ): Promise<T> {
    const response = await fetchJson<TelegramResponse<T>>(this.apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs, lifecycleSignal);
    if (!response.ok || response.result === undefined) throw new Error(response.description || `Telegram ${method} failed`);
    return response.result;
  }

  private normalize(update: TelegramUpdate): InboundEnvelope | null {
    const message = update.message;
    const chat = message?.chat;
    const from = message?.from;
    const text = String(message?.text || message?.caption || '').trim();
    if (!message?.message_id || !chat?.id || !from?.id || !text) return null;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    const mentionPresent = (message.entities || []).some((entity) => entity.type === 'mention') || /@[A-Za-z0-9_]+/.test(text);
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username;
    return {
      platform: 'telegram',
      instanceId: this.instance.id,
      externalMessageId: String(update.update_id ?? message.message_id),
      externalChatId: String(chat.id),
      ...(chat.title || chat.username ? { externalChatTitle: chat.title || `@${chat.username}` } : {}),
      externalUserId: String(from.id),
      ...(name ? { externalUserName: name } : {}),
      text,
      isGroup,
      mentionPresent,
      receivedAt: new Date().toISOString(),
    };
  }

  async start(signal: AbortSignal, callbacks: AdapterCallbacks): Promise<void> {
    this.callbacks = callbacks;
    const merged = mergeSignals(signal, this.localController);
    try {
      await callbacks.onStatus(status('connecting'));
      await this.api<{ id: number; username?: string }>('getMe', {}, 20_000, merged);
      await callbacks.onStatus(status('connected'));
      while (!merged.aborted) {
        try {
          const updates = await this.api<TelegramUpdate[]>('getUpdates', {
            offset: this.offset,
            timeout: 30,
            allowed_updates: ['message'],
          }, 35_000, merged);
          for (const update of updates) {
            if (typeof update.update_id === 'number') this.offset = Math.max(this.offset, update.update_id + 1);
            const envelope = this.normalize(update);
            if (envelope) await callbacks.onInbound(envelope);
          }
        } catch (error) {
          if (merged.aborted) break;
          await callbacks.onStatus(status('error', (error as Error).message));
          await abortableWait(2_000, merged);
          if (!merged.aborted) await callbacks.onStatus(status('connecting'));
        }
      }
    } finally {
      this.callbacks = null;
      if (!merged.aborted) await callbacks.onStatus(status('disconnected'));
    }
  }

  async stop(): Promise<void> {
    this.localController.abort();
  }

  async checkHealth(): Promise<MessagingInstanceStatus> {
    try {
      await this.api<{ id: number }>('getMe');
      return status('connected');
    } catch (error) {
      return status('error', (error as Error).message);
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    lifecycleSignal?: AbortSignal,
    context?: import('./types').MessagingSendContext,
  ): Promise<{ deliveryId?: string }> {
    const replyToMessageId = typeof context?.replyToMessageId === 'string' ? context.replyToMessageId.trim() : '';
    const replyToMessageIdNumber = /^\d+$/.test(replyToMessageId) ? Number(replyToMessageId) : undefined;
    const result = await this.api<{ message_id?: number }>('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyToMessageIdNumber !== undefined ? {
        reply_to_message_id: replyToMessageIdNumber,
        allow_sending_without_reply: true,
      } : {}),
    }, 20_000, lifecycleSignal);
    return result.message_id === undefined ? {} : { deliveryId: String(result.message_id) };
  }
}

export class FeishuAdapter implements MessagingCardAdapter {
  readonly platform: MessagingPlatform = 'feishu_lark';
  private readonly instance: MessagingInstance;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly tenantBrand: FeishuTenantBrand;
  private readonly domain: lark.Domain;
  private readonly client: lark.Client;
  private readonly eventDispatcher: lark.EventDispatcher;
  private wsClient: lark.WSClient | null = null;
  private callbacks: AdapterCallbacks | null = null;
  private terminalError: Error | null = null;
  private wakeLifecycle: (() => void) | null = null;
  private botOpenId = '';
  private identityLookup: Promise<void> | null = null;

  constructor(instance: MessagingInstance, secret: MessagingSecret) {
    if (!secret.appId || !secret.appSecret) throw new Error('Feishu app credentials missing');
    this.instance = instance;
    this.appId = secret.appId;
    this.appSecret = secret.appSecret;
    this.tenantBrand = instance.feishuTenantBrand === 'lark' ? 'lark' : 'feishu';
    this.domain = this.tenantBrand === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: this.domain,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.error,
    });
    this.eventDispatcher = new lark.EventDispatcher({
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.error,
    }).register({
      'im.message.receive_v1': async (event: FeishuEventData) => {
        const envelope = this.normalize(event);
        if (!envelope || !this.callbacks) return {};
        // ACK the SDK event immediately. Agent dispatch can involve disk and
        // queue work and must not consume Feishu's short ACK deadline.
        void this.callbacks.onInbound(envelope).catch(() => {
          log.warn('Feishu inbound dispatch failed', { instanceId: this.instance.id });
        });
        return {};
      },
    });
  }

  private notifyStatus(next: MessagingInstanceStatus): void {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    void callbacks.onStatus(next).catch((error) => {
      log.warn('Feishu status callback failed', {
        instanceId: this.instance.id,
        error: logErrorSummary(error),
      });
    });
  }

  private markTerminalError(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    log.warn('Feishu persistent connection failed', {
      instanceId: this.instance.id,
      error: logErrorSummary(error),
    });
    this.notifyStatus(status('error', 'Feishu connection failed'));
    this.wakeLifecycle?.();
  }

  private async resolveBotIdentity(): Promise<void> {
    const response = await this.client.request<FeishuBotInfoResponse>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || 'Feishu bot identity request failed');
    }
    const openId = typeof response.data?.open_id === 'string' ? response.data.open_id.trim() : '';
    if (!openId) throw new Error('Feishu bot identity missing open id');
    this.botOpenId = openId;
  }

  private markReady(): void {
    if (this.identityLookup) return;
    this.identityLookup = this.resolveBotIdentity()
      .then(() => {
        if (!this.terminalError) this.notifyStatus(status('connected'));
      })
      .catch((error) => {
        this.markTerminalError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private createWsClient(): lark.WSClient {
    return new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      autoReconnect: true,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.error,
      handshakeTimeoutMs: 15_000,
      onReady: () => this.markReady(),
      onReconnecting: () => this.notifyStatus(status('connecting')),
      onReconnected: () => {
        if (this.botOpenId) this.notifyStatus(status('connected'));
        else this.markReady();
      },
      onError: (error) => this.markTerminalError(error),
    });
  }

  private waitForStopOrFailure(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done);
        if (this.wakeLifecycle === done) this.wakeLifecycle = null;
        resolve();
      };
      this.wakeLifecycle = done;
      if (signal.aborted || this.terminalError) done();
      else signal.addEventListener('abort', done, { once: true });
    });
  }

  private normalize(payload: FeishuEventData): InboundEnvelope | null {
    return normalizeFeishuEvent(this.instance, payload, this.botOpenId);
  }

  async start(signal: AbortSignal, callbacks: AdapterCallbacks): Promise<void> {
    if (signal.aborted) return;
    if (this.callbacks) throw new Error('Feishu adapter already started');
    this.callbacks = callbacks;
    this.terminalError = null;
    this.botOpenId = '';
    this.identityLookup = null;
    const wsClient = this.createWsClient();
    this.wsClient = wsClient;
    try {
      await callbacks.onStatus(status('connecting'));
      await wsClient.start({ eventDispatcher: this.eventDispatcher });
      if (signal.aborted) return;
      await this.waitForStopOrFailure(signal);
      if (this.terminalError) throw new Error('Feishu persistent connection failed');
    } finally {
      if (this.wsClient === wsClient) {
        wsClient.close({ force: true });
        this.wsClient = null;
      }
      this.callbacks = null;
      this.wakeLifecycle = null;
      this.identityLookup = null;
      if (!signal.aborted && !this.terminalError) await callbacks.onStatus(status('disconnected'));
    }
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wakeLifecycle?.();
  }

  async checkHealth(): Promise<MessagingInstanceStatus> {
    try {
      const response = await this.client.request<FeishuBotInfoResponse>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(response.msg || 'Feishu health check failed');
      }
      const openId = typeof response.data?.open_id === 'string' ? response.data.open_id.trim() : '';
      if (openId) this.botOpenId = openId;
      return status('connected');
    } catch (error) {
      log.warn('Feishu health check failed', {
        instanceId: this.instance.id,
        error: logErrorSummary(error),
      });
      return status('error', 'Feishu connection failed');
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    lifecycleSignal?: AbortSignal,
    context?: import('./types').MessagingSendContext,
  ): Promise<{ deliveryId?: string }> {
    if (lifecycleSignal?.aborted) throw new Error('Feishu delivery aborted');
    const content = JSON.stringify({ text });
    const replyToMessageId = typeof context?.replyToMessageId === 'string' ? context.replyToMessageId.trim() : '';
    const idempotencyKey = typeof context?.idempotencyKey === 'string' ? context.idempotencyKey.trim() : '';
    const response = replyToMessageId
      ? await this.client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'text',
          content,
          ...(context?.replyInThread ? { reply_in_thread: true } : {}),
          ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
        },
      })
      : await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content,
          ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
        },
      });
    if (response.code !== undefined && response.code !== 0) throw new Error(response.msg || 'Feishu send failed');
    if (lifecycleSignal?.aborted) throw new Error('Feishu delivery aborted');
    const messageId = response.data?.message_id;
    return typeof messageId === 'string' && messageId ? { deliveryId: messageId } : {};
  }

  async sendCard(
    chatId: string,
    card: Record<string, JsonCompatibleValue>,
    lifecycleSignal?: AbortSignal,
    context?: MessagingSendContext,
  ): Promise<{ deliveryId?: string }> {
    if (lifecycleSignal?.aborted) throw new Error('Feishu delivery aborted');
    const content = JSON.stringify(card);
    const replyToMessageId = typeof context?.replyToMessageId === 'string' ? context.replyToMessageId.trim() : '';
    const idempotencyKey = typeof context?.idempotencyKey === 'string' ? context.idempotencyKey.trim() : '';
    const response = replyToMessageId
      ? await this.client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'interactive',
          content,
          ...(context?.replyInThread ? { reply_in_thread: true } : {}),
          ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
        },
      })
      : await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content,
          ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
        },
      });
    if (response.code !== undefined && response.code !== 0) throw new Error(response.msg || 'Feishu card send failed');
    if (lifecycleSignal?.aborted) throw new Error('Feishu delivery aborted');
    const messageId = response.data?.message_id;
    return typeof messageId === 'string' && messageId ? { deliveryId: messageId } : {};
  }

  async updateCard(
    messageId: string,
    card: Record<string, JsonCompatibleValue>,
    lifecycleSignal?: AbortSignal,
  ): Promise<{ deliveryId?: string }> {
    if (lifecycleSignal?.aborted) throw new Error('Feishu card update aborted');
    const response = await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    if (response.code !== undefined && response.code !== 0) throw new Error(response.msg || 'Feishu card update failed');
    return { deliveryId: messageId };
  }
}

const wecomSdkLogger = {
  // SDK diagnostics may stringify complete frames. Keep the adapter silent so
  // message bodies and credentials never reach application logs.
  error: (_message: string, ..._args: unknown[]): void => {},
  warn: (_message: string, ..._args: unknown[]): void => {},
  info: (_message: string, ..._args: unknown[]): void => {},
  debug: (_message: string, ..._args: unknown[]): void => {},
};

function boundedWecomText(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + nextBytes > maxBytes) break;
    result += character;
    bytes += nextBytes;
  }
  return result;
}

export class WecomAdapter implements MessagingAdapter {
  readonly platform: MessagingPlatform = 'wecom';
  private readonly instance: MessagingInstance;
  private readonly botId: string;
  private readonly client: wecom.WSClient;
  private callbacks: AdapterCallbacks | null = null;
  private authenticated = false;
  private stopping = false;
  private terminalError: Error | null = null;
  private wakeLifecycle: (() => void) | null = null;

  private readonly onConnected = (): void => {
    if (!this.stopping) void this.callbacks?.onStatus(status('connecting'));
  };

  private readonly onAuthenticated = (): void => {
    if (this.stopping) return;
    this.authenticated = true;
    void this.callbacks?.onStatus(status('connected'));
  };

  private readonly onReconnecting = (): void => {
    if (this.stopping) return;
    this.authenticated = false;
    void this.callbacks?.onStatus(status('connecting'));
  };

  private readonly onDisconnected = (): void => {
    if (this.stopping) return;
    this.authenticated = false;
    // The official SDK emits reconnecting for ordinary network loss. Wait for
    // that event before declaring the runtime disconnected.
  };

  private readonly onError = (error: Error): void => {
    if (this.stopping) return;
    const errorWithCode = error as unknown as { code?: unknown };
    const code = typeof errorWithCode.code === 'string'
      ? errorWithCode.code
      : '';
    if (code === 'WS_AUTH_FAILURE_EXHAUSTED' || code === 'WS_RECONNECT_EXHAUSTED') {
      this.terminalError = new Error(code === 'WS_AUTH_FAILURE_EXHAUSTED'
        ? 'WeCom authentication failed'
        : 'WeCom connection retries exhausted');
      this.authenticated = false;
      void this.callbacks?.onStatus(status('error', this.terminalError.message));
      this.wakeLifecycle?.();
      return;
    }
    void this.callbacks?.onStatus(status('error', 'WeCom connection error'));
  };

  private readonly onDisconnectedEvent = (): void => {
    if (this.stopping) return;
    this.authenticated = false;
    void this.callbacks?.onStatus(status('disconnected'));
    this.wakeLifecycle?.();
  };

  private readonly onTextMessage = (frame: WecomMessageFrame): void => {
    if (this.stopping || !this.callbacks) return;
    const envelope = normalizeWecomEvent(this.instance, this.botId, frame);
    if (!envelope) return;
    void this.callbacks.onInbound(envelope).catch((error) => {
      log.warn('WeCom inbound dispatch failed', {
        instanceId: this.instance.id,
        error: logErrorSummary(error),
      });
    });
  };

  constructor(instance: MessagingInstance, secret: MessagingSecret) {
    if (!secret.wecomBotId || !secret.wecomBotSecret) throw new Error('WeCom bot credentials missing');
    this.instance = instance;
    this.botId = secret.wecomBotId;
    this.client = new wecom.WSClient({
      botId: secret.wecomBotId,
      secret: secret.wecomBotSecret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
      logger: wecomSdkLogger,
    });
    this.client.on('connected', this.onConnected);
    this.client.on('authenticated', this.onAuthenticated);
    this.client.on('reconnecting', this.onReconnecting);
    this.client.on('disconnected', this.onDisconnected);
    this.client.on('error', this.onError);
    this.client.on('event.disconnected_event', this.onDisconnectedEvent);
    this.client.on('message.text', this.onTextMessage);
  }

  private waitForStopOrFailure(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done);
        if (this.wakeLifecycle === done) this.wakeLifecycle = null;
        resolve();
      };
      this.wakeLifecycle = done;
      if (signal.aborted || this.terminalError) done();
      else signal.addEventListener('abort', done, { once: true });
    });
  }

  private removeListeners(): void {
    this.client.off('connected', this.onConnected);
    this.client.off('authenticated', this.onAuthenticated);
    this.client.off('reconnecting', this.onReconnecting);
    this.client.off('disconnected', this.onDisconnected);
    this.client.off('error', this.onError);
    this.client.off('event.disconnected_event', this.onDisconnectedEvent);
    this.client.off('message.text', this.onTextMessage);
  }

  async start(signal: AbortSignal, callbacks: AdapterCallbacks): Promise<void> {
    if (signal.aborted) return;
    if (this.callbacks) throw new Error('WeCom adapter already started');
    this.callbacks = callbacks;
    this.stopping = false;
    this.authenticated = false;
    this.terminalError = null;
    const abort = (): void => {
      this.stopping = true;
      this.client.disconnect();
      this.wakeLifecycle?.();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await callbacks.onStatus(status('connecting'));
      try {
        this.client.connect();
      } catch (error) {
        this.terminalError = new Error('WeCom connection unavailable');
        log.warn('WeCom connection start failed', {
          instanceId: this.instance.id,
          error: logErrorSummary(error),
        });
        await callbacks.onStatus(status('error', this.terminalError.message));
        throw this.terminalError;
      }
      await this.waitForStopOrFailure(signal);
      if (this.terminalError && !signal.aborted) throw this.terminalError;
    } finally {
      signal.removeEventListener('abort', abort);
      this.stopping = true;
      this.authenticated = false;
      this.client.disconnect();
      this.wakeLifecycle = null;
      this.removeListeners();
      const currentCallbacks = this.callbacks;
      this.callbacks = null;
      if (!signal.aborted && !this.terminalError && currentCallbacks) {
        await currentCallbacks.onStatus(status('disconnected'));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.authenticated = false;
    this.client.disconnect();
    this.wakeLifecycle?.();
  }

  async checkHealth(): Promise<MessagingInstanceStatus> {
    // A running adapter already owns this client. Reconnecting or disconnecting
    // it for an on-demand health check can tear down an otherwise recoverable
    // long-lived session, so report its live state without mutating it.
    if (this.callbacks) {
      if (this.terminalError) return status('error', this.terminalError.message);
      if (this.authenticated && this.client.isConnected) return status('connected');
      return status(this.client.isConnected ? 'connecting' : 'disconnected');
    }
    const timeoutMs = 15_000;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: MessagingInstanceStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.client.off('authenticated', onAuth);
        this.client.off('error', onError);
        this.client.off('disconnected', onDisconnected);
        this.client.disconnect();
        resolve(result);
      };
      const onAuth = (): void => {
        this.authenticated = true;
        finish(status('connected'));
      };
      const onError = (): void => finish(status('error', 'WeCom connection error'));
      const onDisconnected = (): void => finish(status('error', 'WeCom connection unavailable'));
      const timer = setTimeout(() => finish(status('error', 'WeCom health check timed out')), timeoutMs);
      this.client.once('authenticated', onAuth);
      this.client.once('error', onError);
      this.client.once('disconnected', onDisconnected);
      try {
        this.client.connect();
      } catch (error) {
        finish(status('error', 'WeCom connection unavailable'));
      }
    });
  }

  async sendMessage(chatId: string, text: string, lifecycleSignal?: AbortSignal): Promise<{ deliveryId?: string }> {
    if (lifecycleSignal?.aborted || !this.authenticated || !this.client.isConnected) {
      throw new Error('WeCom connection is not authenticated');
    }
    const content = boundedWecomText(text, 20_480);
    if (!content) throw new Error('WeCom message is empty');
    let receipt: WsFrame;
    try {
      receipt = await this.client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content },
      });
    } catch (error) {
      log.warn('WeCom message delivery failed', {
        instanceId: this.instance.id,
        error: logErrorSummary(error),
      });
      throw new Error('WeCom message delivery failed');
    }
    if (receipt.errcode !== undefined && receipt.errcode !== 0) {
      throw new Error('WeCom message delivery failed');
    }
    const deliveryId = receipt.headers?.req_id;
    return typeof deliveryId === 'string' && deliveryId ? { deliveryId } : {};
  }
}

export function createAdapter(instance: MessagingInstance, secret: MessagingSecret): MessagingAdapter {
  if (instance.platform === 'telegram') return new TelegramAdapter(instance, secret);
  if (instance.platform === 'wecom') return new WecomAdapter(instance, secret);
  return new FeishuAdapter(instance, secret);
}

export const _adapterTestHooks = { fetchJson, status, normalizeFeishuEvent, normalizeWecomEvent, boundedWecomText };
