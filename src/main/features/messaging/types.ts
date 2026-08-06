export const MESSAGING_PLATFORMS = ['telegram', 'feishu_lark', 'wecom'] as const;
export type MessagingPlatform = (typeof MESSAGING_PLATFORMS)[number];

export const FEISHU_TENANT_BRANDS = ['feishu', 'lark'] as const;
export type FeishuTenantBrand = (typeof FEISHU_TENANT_BRANDS)[number];

// The official long-connection SDK silently declines malformed ids. Validate
// them at configuration time so an enabled instance cannot wait forever.
export const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;

// WeCom assigns bot identifiers and secrets; unlike Feishu app IDs they do
// not have a stable documented prefix. Keep validation structural and leave
// authentication/authorization to the official WebSocket service.
export const WECOM_BOT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const WECOM_BOT_SECRET_PATTERN = /^[^\u0000-\u0020\u007f]{8,512}$/;

export function isValidFeishuAppId(value: string): boolean {
  return FEISHU_APP_ID_PATTERN.test(value);
}

export function isValidWecomBotId(value: string): boolean {
  return WECOM_BOT_ID_PATTERN.test(value);
}

export function isValidWecomBotSecret(value: string): boolean {
  return WECOM_BOT_SECRET_PATTERN.test(value);
}

export const REPLY_MODES = ['every_message', 'mentions_only', 'commands_only'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

/** The Feishu connector renders the only supported rich response mode as an
 * incrementally updated interactive card. Other transports remain text-only. */
export const RESPONSE_MODES = ['text', 'streaming_card'] as const;
export type MessagingResponseMode = (typeof RESPONSE_MODES)[number];

export const INSTANCE_STATUS_KINDS = ['disabled', 'disconnected', 'connecting', 'connected', 'error'] as const;
export type InstanceStatusKind = (typeof INSTANCE_STATUS_KINDS)[number];

export interface WorkspaceScope {
  /**
   * `all` is the explicit UI choice for every workspace. It intentionally
   * routes to a normal, project-free conversation rather than granting a
   * connector access to arbitrary project paths. `default` is retained for
   * existing persisted configuration and has the same project-free routing.
   */
  type: 'default' | 'all' | 'project';
  projectId?: string;
}

export interface MessagingPolicy {
  replyMode: ReplyMode;
  allowUserIds: string[];
  allowGroupIds: string[];
  requireMentionInGroups: boolean;
}

export interface MessagingInstanceStatus {
  kind: InstanceStatusKind;
  message?: string;
  checkedAt: string;
  connectedAt?: string;
}

export interface MessagingInstance {
  id: string;
  platform: MessagingPlatform;
  feishuTenantBrand?: FeishuTenantBrand;
  displayName: string;
  enabled: boolean;
  responseMode: MessagingResponseMode;
  workspace: WorkspaceScope;
  policy: MessagingPolicy;
  status: MessagingInstanceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingSecret {
  botToken?: string;
  appId?: string;
  appSecret?: string;
  tenantAccessToken?: string;
  wecomBotId?: string;
  wecomBotSecret?: string;
}

export interface MessagingInstanceDisk extends MessagingInstance {
  secretsEnc?: string;
}

export interface MessagingConfigFile {
  version: 1;
  instances: Record<string, MessagingInstanceDisk>;
}

export interface MessagingBinding {
  key: string;
  instanceId: string;
  /**
   * Legacy bindings were keyed only by chat and are never reused for group
   * traffic. New group bindings include the external sender so distinct
   * people in one group cannot share a Mate Agent conversation.
   */
  conversationScope: 'direct' | 'group_sender' | 'legacy';
  externalChatId: string;
  externalUserId?: string;
  externalChatTitle?: string;
  cid: string;
  projectId?: string;
  /** Latest inbound platform context for the isolated conversation. */
  replyToMessageId?: string;
  threadId?: string;
  replyInThread?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingBindingsFile {
  version: 1;
  bindings: Record<string, MessagingBinding>;
}

export interface InboundEnvelope {
  platform: MessagingPlatform;
  instanceId: string;
  externalMessageId: string;
  externalChatId: string;
  externalChatTitle?: string;
  externalUserId: string;
  /**
   * Feishu may eventually provide a tenant plus union id. Policy prefers the
   * pair when present and falls back to the stable platform user id (today,
   * Feishu open_id) for compatibility with already-authorized users.
   */
  externalTenantId?: string;
  externalUnionId?: string;
  externalUserName?: string;
  text: string;
  isGroup: boolean;
  mentionPresent: boolean;
  /** Exact serialized mention placeholders for this bot. They let policy
   * remove only the bot address and preserve @mentions to other people. */
  botMentionTokens?: string[];
  /** The external message this response should address, when the platform
   * supports native replies. This is deliberately separate from the chat id:
   * two concurrent messages in one chat must never share a reply target. */
  replyToMessageId?: string;
  threadId?: string;
  /** Preserve a platform thread/topic when replying to the inbound message. */
  replyInThread?: boolean;
  receivedAt: string;
}

export interface InboundLedgerEntry {
  key: string;
  status: 'pending' | 'accepted' | 'rejected' | 'duplicate' | 'failed';
  cid?: string;
  /** Internal group-chat message id created for this inbound event. */
  internalMessageId?: string;
  replyToMessageId?: string;
  threadId?: string;
  replyInThread?: boolean;
  reason?: string;
  receivedAt: string;
  updatedAt: string;
}

export interface MessagingInboundLedgerFile {
  version: 1;
  entries: Record<string, InboundLedgerEntry>;
}

export interface DeliveryLedgerEntry {
  key: string;
  instanceId: string;
  externalChatId: string;
  sourceMessageId: string;
  textHash: string;
  /** Outbound text is kept in the machine-private ledger so a process restart
   * can recover a failed send without reading mutable conversation history. */
  text?: string;
  replyToMessageId?: string;
  threadId?: string;
  replyInThread?: boolean;
  /** Feishu uses this as the API uuid; keeping it stable makes timeout retries
   * idempotent. Other adapters may ignore it. */
  idempotencyKey?: string;
  // A cancelled delivery is terminal: it was intentionally suppressed because
  // its runtime was disabled, unbound, or deleted. It must never be retried
  // after the instance is later enabled again.
  status: 'pending' | 'retry_pending' | 'sent' | 'failed' | 'cancelled';
  externalDeliveryId?: string;
  error?: string;
  attempts: number;
  nextAttemptAt?: string;
  updatedAt: string;
}

export interface MessagingDeliveryLedgerFile {
  version: 1;
  entries: Record<string, DeliveryLedgerEntry>;
}

export interface AdapterCallbacks {
  /** Inbound envelope dispatch. The result tells the adapter whether the
   * message was accepted, so it can remove transient UI state (e.g. a
   * processing reaction) when the message is rejected or duplicated. */
  onInbound: (envelope: InboundEnvelope) => Promise<MessagingInboundResult>;
  onStatus: (status: MessagingInstanceStatus) => Promise<void>;
  /** Card button clicks (Feishu interactive cards). Optional: adapters that
   * never send interactive cards leave it unset. */
  onCardAction?: (action: CardActionEnvelope) => Promise<MessagingInboundResult>;
}

/** A button click on an interactive card (e.g. an approval card). The
 * scanning operator acts as the user; `action` and `payload` come from the
 * button's `value` so the sending card controls its own semantics. */
export interface CardActionEnvelope {
  platform: MessagingPlatform;
  instanceId: string;
  /** The message the card lives on; also the dedup key. */
  externalMessageId: string;
  externalChatId: string;
  externalUserId: string;
  action: string;
  payload: Record<string, JsonCompatibleValue>;
  receivedAt: string;
}

export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  start(signal: AbortSignal, callbacks: AdapterCallbacks): Promise<void>;
  stop(): Promise<void>;
  checkHealth(): Promise<MessagingInstanceStatus>;
  sendMessage(
    chatId: string,
    text: string,
    signal?: AbortSignal,
    context?: MessagingSendContext,
  ): Promise<{ deliveryId?: string }>;
}

export interface MessagingCardAdapter extends MessagingAdapter {
  sendCard(
    chatId: string,
    card: Record<string, JsonCompatibleValue>,
    signal?: AbortSignal,
    context?: MessagingSendContext,
  ): Promise<{ deliveryId?: string }>;
  updateCard(
    messageId: string,
    card: Record<string, JsonCompatibleValue>,
    signal?: AbortSignal,
  ): Promise<{ deliveryId?: string }>;
}

export type JsonCompatibleValue = string | number | boolean | null | JsonCompatibleValue[] | { [key: string]: JsonCompatibleValue };

export interface MessagingSendContext {
  replyToMessageId?: string;
  threadId?: string;
  replyInThread?: boolean;
  idempotencyKey?: string;
}

export interface MessagingAdapterFactory {
  create(instance: MessagingInstance, secret: MessagingSecret, callbacks: AdapterCallbacks): MessagingAdapter;
}

export interface MessagingPlatformCatalogEntry {
  platform: MessagingPlatform | 'wechat_personal';
  displayName: string;
  description: string;
  available: boolean;
  twoWay: boolean;
}

export interface MessagingInstanceClient extends MessagingInstance {
  hasCredentials: boolean;
}

export interface MessagingInboundResult {
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
  cid?: string;
}
