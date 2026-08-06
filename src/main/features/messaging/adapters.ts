import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import * as lark from '@larksuiteoapi/node-sdk';
import * as wecom from '@wecom/aibot-node-sdk';
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import {
  buildMarkdownPostPayload,
  chunkMarkdownMessage,
  isMarkdown,
  stripMarkdownToPlainText,
} from './feishu-post';
import type {
  AdapterCallbacks,
  CardActionEnvelope,
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
  /** Real shape: the bot payload sits at the top level (not wrapped in `data`). */
  bot?: { open_id?: string; activate_status?: number; app_name?: string; avatar_url?: string; ip_white_list?: string[] };
  /** Kept for tolerance of gateway wrappers that still nest under `data`. */
  data?: { open_id?: string };
}

interface FeishuReactionResponse extends FeishuApiResponse {
  data?: { reaction_id?: string };
}

interface FeishuMessageSendResponse extends FeishuApiResponse {
  data?: { message_id?: string };
}

/** Processing indicator reaction (Feishu emoji name, mirrors Hermes). */
const FEISHU_REACTION_IN_PROGRESS = 'Typing';
/** Failure reaction added when an inbound message is rejected or its
 * dispatch fails (mirrors Hermes' FEISHU_REACTION_FAILURE). */
const FEISHU_REACTION_FAILURE = 'CrossMark';
const PROCESSING_REACTIONS_MAX = 1024;

/** Feishu API rejects an outbound `post` payload with this message text;
 * the adapter then degrades the chunk to plain text (mirrors Hermes). */
const FEISHU_POST_CONTENT_INVALID_RE = /content format of the post type is incorrect/i;
/** Reply target no longer exists (message recalled / chat gone). The adapter
 * falls back to a fresh message in the same chat (mirrors Hermes
 * _FEISHU_REPLY_FALLBACK_CODES). */
const FEISHU_REPLY_FALLBACK_CODES = new Set([230011, 231003]);

function parseFeishuBotOpenId(response: FeishuBotInfoResponse): string {
  const topLevel = response.bot?.open_id?.trim() || '';
  if (topLevel) return topLevel;
  return response.data?.open_id?.trim() || '';
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

/** Fallback text for media/forward/card messages. Every inbound Feishu
 * message degrades to a model-readable text envelope instead of being
 * dropped (mirrors Hermes' normalize_feishu_message chain). */
function feishuMessageToText(messageType: string, rawContent: string): string {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawContent || '{}');
    payload = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return rawContent.trim();
  }
  const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
  const firstText = (...keys: string[]): string => {
    for (const key of keys) {
      const value = str(payload[key]);
      if (value) return value;
    }
    return '';
  };
  switch (messageType) {
    case 'text':
      return firstText('text');
    case 'post': {
      // Rich text: pick the locale payload, then flatten content cells that
      // carry text/a tags into lines.
      const post = (typeof payload.zh_cn === 'object' && payload.zh_cn
        ? payload.zh_cn
        : typeof payload.en_us === 'object' && payload.en_us
          ? payload.en_us
          : payload) as Record<string, unknown>;
      const title = str(post.title);
      const lines: string[] = [];
      const content = post.content;
      if (Array.isArray(content)) {
        for (const row of content) {
          if (!Array.isArray(row)) continue;
          const parts: string[] = [];
          for (const cell of row) {
            if (!cell || typeof cell !== 'object') continue;
            const item = cell as Record<string, unknown>;
            if (item.tag === 'text' || item.tag === 'a') {
              const text = str(item.text);
              if (text) parts.push(text);
            }
          }
          const line = parts.join(' ').trim();
          if (line) lines.push(line);
        }
      }
      const body = lines.join('\n');
      if (title && body) return `${title}\n${body}`;
      return title || body || '[富文本消息]';
    }
    case 'image':
      return '[图片]';
    case 'file':
      return `[文件] ${firstText('file_name', 'file_key')}`.trim();
    case 'audio':
      return `[语音] ${firstText('file_name')}`.trim();
    case 'media':
      return `[视频] ${firstText('file_name')}`.trim();
    case 'sticker':
      return '[表情]';
    case 'share_chat':
      return `[分享了群聊] ${firstText('chat_name', 'name', 'title')}`.trim();
    case 'share_user':
      return `[分享了联系人] ${firstText('user_name', 'name')}`.trim();
    case 'merge_forward': {
      // Merged forward: title/summary plus the first few preview entries.
      const title = firstText('title', 'summary');
      const preview = payload.preview;
      const entries: string[] = [];
      if (Array.isArray(preview)) {
        for (const entry of preview) {
          const text = str(entry);
          if (text) entries.push(text);
          if (entries.length >= 8) break;
        }
      } else if (typeof preview === 'string' && preview.trim()) {
        entries.push(preview.trim());
      }
      const head = title ? [title] : ['[合并转发]'];
      return head.concat(entries).join('\n').trim();
    }
    case 'interactive':
      return '[卡片消息]';
    default:
      return `[${messageType} 消息]`;
  }
}

interface FeishuCardActionEvent {
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  operator?: { open_id?: string; user_id?: string; name?: string };
  action?: { tag?: string; value?: Record<string, unknown> };
}

function normalizeFeishuCardAction(
  instance: MessagingInstance,
  event: FeishuCardActionEvent,
): CardActionEnvelope | null {
  const messageId = event.context?.open_message_id?.trim() || event.open_message_id?.trim() || '';
  const chatId = event.context?.open_chat_id?.trim() || event.open_chat_id?.trim() || '';
  const operatorOpenId = event.operator?.open_id?.trim() || '';
  if (!messageId || !chatId || !operatorOpenId) return null;
  const value = event.action?.value && typeof event.action.value === 'object' ? event.action.value : {};
  const action = typeof value.action === 'string' && value.action.trim()
    ? value.action.trim()
    : (event.action?.tag?.trim() || 'unknown');
  // Buttons only carry JSON-serializable primitives; anything else is dropped.
  const payload: Record<string, JsonCompatibleValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'action') continue;
    if (entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      payload[key] = entry as JsonCompatibleValue;
    }
  }
  return {
    platform: 'feishu_lark',
    instanceId: instance.id,
    externalMessageId: messageId,
    externalChatId: chatId,
    externalUserId: operatorOpenId,
    action,
    payload,
    receivedAt: new Date().toISOString(),
  };
}

/** Dedup cache for card clicks keyed by message + operator + action. */
const CARD_ACTION_DEDUP_MAX = 2048;

function normalizeFeishuEvent(
  instance: MessagingInstance,
  payload: FeishuEventData,
  botOpenId = '',
): InboundEnvelope | null {
  const message = payload.message;
  const senderInfo = payload.sender;
  const sender = senderInfo?.sender_id;
  if (senderInfo?.sender_type && senderInfo.sender_type !== 'user') return null;
  if (!message?.message_id || !message.chat_id || !sender?.open_id) return null;
  const messageType = typeof message.message_type === 'string' ? message.message_type.trim().toLowerCase() : '';
  const text = feishuMessageToText(messageType, message.content || '').trim();
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
  /** inbound message id → reaction id of the active processing indicator */
  private processingReactions = new Map<string, string>();
  /** card click dedup: message + operator + action identity */
  private cardActionDedup = new Set<string>();

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
        void this.handleInboundWithReaction(envelope);
        return {};
      },
      'card.action.trigger': async (event: FeishuCardActionEvent) => {
        if (!this.callbacks?.onCardAction) return {};
        const envelope = normalizeFeishuCardAction(this.instance, event);
        if (!envelope) return {};
        const dedupKey = `${envelope.externalMessageId}\u0000${envelope.externalUserId}\u0000${envelope.action}\u0000${JSON.stringify(envelope.payload)}`;
        if (this.cardActionDedup.has(dedupKey)) return {};
        if (this.cardActionDedup.size >= CARD_ACTION_DEDUP_MAX) this.cardActionDedup.clear();
        this.cardActionDedup.add(dedupKey);
        void this.callbacks.onCardAction(envelope).catch((error) => {
          log.warn('Feishu card action dispatch failed', {
            instanceId: this.instance.id,
            error: logErrorSummary(error),
          });
        });
        return {};
      },
    });
  }

  /** Processing indicator around inbound dispatch: add a reaction before the
   * agent runs, remove it when the message is rejected/duplicated or when the
   * reply for it is delivered. Rejection or dispatch failure adds a failure
   * reaction instead. Reaction support is permission-gated on the Feishu
   * side, so every failure here stays silent. */
  private async handleInboundWithReaction(envelope: InboundEnvelope): Promise<void> {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const messageId = envelope.externalMessageId;
    await this.addProcessingReaction(messageId);
    try {
      const result = await callbacks.onInbound(envelope);
      if (!result.accepted) {
        await this.removeProcessingReaction(messageId);
        await this.addFailureReaction(messageId);
      }
    } catch (error) {
      log.warn('Feishu inbound dispatch failed', {
        instanceId: this.instance.id,
        error: logErrorSummary(error),
      });
      await this.removeProcessingReaction(messageId);
      await this.addFailureReaction(messageId);
    }
  }

  private async addFailureReaction(messageId: string): Promise<void> {
    if (!messageId) return;
    try {
      await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: FEISHU_REACTION_FAILURE } },
      });
    } catch { /* optional capability; never fail the message flow */ }
  }

  private async addProcessingReaction(messageId: string): Promise<void> {
    if (!messageId || this.processingReactions.has(messageId)) return;
    if (this.processingReactions.size >= PROCESSING_REACTIONS_MAX) return;
    try {
      const response = await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: FEISHU_REACTION_IN_PROGRESS } },
      }) as unknown as FeishuReactionResponse;
      if (response.code !== undefined && response.code !== 0) return;
      const reactionId = response.data?.reaction_id;
      if (typeof reactionId === 'string' && reactionId) {
        this.processingReactions.set(messageId, reactionId);
      }
    } catch { /* optional capability; never fail the message flow */ }
  }

  private async removeProcessingReaction(messageId: string): Promise<void> {
    const reactionId = this.processingReactions.get(messageId);
    if (!reactionId) return;
    this.processingReactions.delete(messageId);
    try {
      await this.client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch { /* best effort; a stale reaction is harmless */ }
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
    const openId = parseFeishuBotOpenId(response);
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
    this.processingReactions.clear();
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
      const openId = parseFeishuBotOpenId(response);
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
    const replyToMessageId = typeof context?.replyToMessageId === 'string' ? context.replyToMessageId.trim() : '';
    const idempotencyKey = typeof context?.idempotencyKey === 'string' ? context.idempotencyKey.trim() : '';
    // Markdown detection is locked at the whole-message level so every chunk
    // of a split reply consistently uses `post` (mirrors Hermes #26841); a
    // plain-prose chunk that lost its formatting markers would otherwise be
    // sent as `text` with literal `**bold**` visible to the user.
    const preferPost = isMarkdown(text);
    const chunks = chunkMarkdownMessage(text.trim());
    let deliveryId: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      if (lifecycleSignal?.aborted) throw new Error('Feishu delivery aborted');
      const chunk = chunks[index];
      // Per-chunk uuid derived from the delivery idempotency key: a ledger
      // retry re-sends the same chunk uuids, which Feishu deduplicates.
      const chunkUuid = idempotencyKey ? `${idempotencyKey}#${index}` : undefined;
      const content = preferPost ? buildMarkdownPostPayload(chunk) : JSON.stringify({ text: chunk });
      try {
        const response = await this.sendFeishuMessage(
          chatId, preferPost ? 'post' : 'text', content,
          replyToMessageId, context, chunkUuid, lifecycleSignal,
        );
        const messageId = response.data?.message_id;
        if (typeof messageId === 'string' && messageId) deliveryId = messageId;
      } catch (error) {
        if (!preferPost || !FEISHU_POST_CONTENT_INVALID_RE.test((error as Error).message || String(error))) throw error;
        log.warn('Feishu post payload rejected, falling back to plain text', {
          instanceId: this.instance.id,
        });
        const plainContent = JSON.stringify({ text: stripMarkdownToPlainText(chunk) });
        const response = await this.sendFeishuMessage(
          chatId, 'text', plainContent,
          replyToMessageId, context, chunkUuid, lifecycleSignal,
        );
        const messageId = response.data?.message_id;
        if (typeof messageId === 'string' && messageId) deliveryId = messageId;
      }
    }
    if (replyToMessageId) void this.removeProcessingReaction(replyToMessageId);
    return deliveryId ? { deliveryId } : {};
  }

  /** One Feishu message send (reply or fresh), with reply-target fallback:
   * when the reply fails because the target was recalled or the chat changed
   * (230011/231003), a fresh message is created in the same chat instead.
   * Replies inside a thread never fall back, to avoid spawning a new topic
   * (mirrors Hermes `_feishu_send_with_retry`). */
  private async sendFeishuMessage(
    chatId: string,
    msgType: string,
    content: string,
    replyToMessageId: string,
    context: MessagingSendContext | undefined,
    uuid: string | undefined,
    lifecycleSignal?: AbortSignal,
  ): Promise<FeishuMessageSendResponse> {
    if (lifecycleSignal?.aborted) throw new Error('Feishu delivery aborted');
    const sendOnce = async (replyTo: string | undefined): Promise<FeishuMessageSendResponse> => {
      const response = replyTo
        ? await this.client.im.v1.message.reply({
          path: { message_id: replyTo },
          data: {
            msg_type: msgType,
            content,
            ...(context?.replyInThread ? { reply_in_thread: true } : {}),
            ...(uuid ? { uuid } : {}),
          },
        })
        : await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: msgType,
            content,
            ...(uuid ? { uuid } : {}),
          },
        });
      return response as unknown as FeishuMessageSendResponse;
    };

    let response = await sendOnce(replyToMessageId || undefined);
    const responseCode = typeof response.code === 'number' ? response.code : 0;
    if (replyToMessageId && !context?.replyInThread && responseCode !== 0 && FEISHU_REPLY_FALLBACK_CODES.has(responseCode)) {
      log.info('Feishu reply target unavailable, sending a fresh message', {
        instanceId: this.instance.id,
      });
      response = await sendOnce(undefined);
    }
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || 'Feishu send failed');
    }
    return response;
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
    if (replyToMessageId) void this.removeProcessingReaction(replyToMessageId);
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

  /** Interactive approval card (mirrors Hermes' send_exec_approval). The
   * buttons carry { action, wake_id } in their value so card.action.trigger
   * events route back through manager.ingestCardAction into the wake gate. */
  async sendApprovalCard(
    chatId: string,
    approval: {
      wakeId: string;
      title: string;
      description: string;
      allowSession?: boolean;
      allowPermanent?: boolean;
      replyToMessageId?: string;
    },
    lifecycleSignal?: AbortSignal,
  ): Promise<{ deliveryId?: string }> {
    if (lifecycleSignal?.aborted) throw new Error('Feishu approval card aborted');
    const button = (label: string, action: string, type = 'default'): Record<string, JsonCompatibleValue> => ({
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type,
      value: { action, wake_id: approval.wakeId },
    });
    const actions: Record<string, JsonCompatibleValue>[] = [
      button('✅ 允许一次', 'approve', 'primary'),
    ];
    if (approval.allowSession !== false) actions.push(button('✅ 本次会话', 'approve_session'));
    if (approval.allowPermanent !== false) actions.push(button('✅ 总是允许', 'approve_always'));
    actions.push(button('❌ 拒绝', 'deny', 'danger'));
    const card: Record<string, JsonCompatibleValue> = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: approval.title.slice(0, 120), tag: 'plain_text' },
        template: 'orange',
      },
      elements: [
        { tag: 'markdown', content: approval.description.slice(0, 1500) },
        { tag: 'action', actions },
      ],
    };
    const content = JSON.stringify(card);
    const replyToMessageId = approval.replyToMessageId?.trim() || '';
    const response = replyToMessageId
      ? await this.client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: 'interactive', content },
      })
      : await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      });
    if (response.code !== undefined && response.code !== 0) throw new Error(response.msg || 'Feishu approval card send failed');
    const messageId = response.data?.message_id;
    return typeof messageId === 'string' && messageId ? { deliveryId: messageId } : {};
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

export const _adapterTestHooks = { fetchJson, status, normalizeFeishuEvent, normalizeWecomEvent, boundedWecomText, parseFeishuBotOpenId, feishuMessageToText, normalizeFeishuCardAction };
