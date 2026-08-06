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

export const INSTANCE_STATUS_KINDS = ['disabled', 'disconnected', 'connecting', 'connected', 'error'] as const;
export type InstanceStatusKind = (typeof INSTANCE_STATUS_KINDS)[number];

export interface WorkspaceScope {
  type: 'default' | 'project';
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
  externalChatId: string;
  externalChatTitle?: string;
  cid: string;
  projectId?: string;
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
  externalUserName?: string;
  text: string;
  isGroup: boolean;
  mentionPresent: boolean;
  receivedAt: string;
}

export interface InboundLedgerEntry {
  key: string;
  status: 'pending' | 'accepted' | 'rejected' | 'duplicate' | 'failed';
  cid?: string;
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
  // A cancelled delivery is terminal: it was intentionally suppressed because
  // its runtime was disabled, unbound, or deleted. It must never be retried
  // after the instance is later enabled again.
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  externalDeliveryId?: string;
  error?: string;
  attempts: number;
  updatedAt: string;
}

export interface MessagingDeliveryLedgerFile {
  version: 1;
  entries: Record<string, DeliveryLedgerEntry>;
}

export interface AdapterCallbacks {
  onInbound: (envelope: InboundEnvelope) => Promise<void>;
  onStatus: (status: MessagingInstanceStatus) => Promise<void>;
}

export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  start(signal: AbortSignal, callbacks: AdapterCallbacks): Promise<void>;
  stop(): Promise<void>;
  checkHealth(): Promise<MessagingInstanceStatus>;
  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<{ deliveryId?: string }>;
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
