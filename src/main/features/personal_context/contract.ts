/**
 * 个人上下文连接器契约（设计稿：docs/superpowers/specs/2026-08-10-feishu-companion-context-design.md §5.1）
 *
 * 连接器只产标准资源，不懂场景；场景只信本体，不直接摸 provider。
 * 本文件为纯类型与纯函数：不读写业务数据、不 import features/model。
 */

// ── 状态机 ────────────────────────────────────────────────────────────────
// 对齐 messaging 实例状态机（disconnected/connecting/connected/error），
// 不引入平行语义；disabled 由上层启用开关表达，连接器自身不持有。
export const CONNECTOR_STATUS_KINDS = ['disconnected', 'connecting', 'connected', 'error'] as const;
export type ConnectorStatusKind = (typeof CONNECTOR_STATUS_KINDS)[number];

export interface ConnectorStatus {
  kind: ConnectorStatusKind;
  checkedAt: string;
  /** 失败原因（面向 UI 展示，不含令牌等敏感内容） */
  error?: string;
}

export interface ConnectorContext {
  uid: string;
  providerId: string;
}

// ── 标准资源 ──────────────────────────────────────────────────────────────
export const RESOURCE_TYPES = ['calendar', 'calendar_event', 'document', 'file', 'folder', 'chat', 'contact'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const ACCESS_LABELS = ['personal', 'shared', 'public'] as const;
export type AccessLabel = (typeof ACCESS_LABELS)[number];

export const RETENTION_POLICIES = ['source-linked', 'fixed'] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

export const RESOURCE_CONTENT_STATUSES = ['not_loaded', 'loaded', 'failed', 'unsupported'] as const;
export type ResourceContentStatus = (typeof RESOURCE_CONTENT_STATUSES)[number];

export const RESOURCE_SOURCE_VALIDITIES = ['active', 'invalidated', 'deleted'] as const;
export type ResourceSourceValidity = (typeof RESOURCE_SOURCE_VALIDITIES)[number];

export interface ResourceCapability {
  canList: boolean;
  canReadMetadata: boolean;
  canReadContent: boolean;
  canSyncIncrementally: boolean;
  canGenerateCandidates: boolean;
  unsupportedReason?: string;
}

/**
 * 来源事实引用（非语义事实）：本体只存治理后的语义事实，这里只存引用与版本。
 * resourceId 是幂等键：`<provider>:<tenant>:<type>:<stableId>`，同键同版本重复写入必须幂等。
 */
export interface ExternalResource {
  resourceId: string;
  resourceType: ResourceType;
  /** 版本/事件 ID，用于幂等比较；同 resourceId 下变化则视为内容更新 */
  sourceVersion?: string;
  title: string;
  /** `feishu:union_id:ou_xxx` 形式的所有者引用（union_id 前缀 ou_） */
  ownerRef?: string;
  /** 父容器（文件夹/日历组），可为资源自身 id 或外部引用 */
  containerRef?: string;
  sourceUrl?: string;
  observedAt: string;
  contentHash?: string;
  accessLabel: AccessLabel;
  retentionPolicy: RetentionPolicy;
  /** 是否已读全文（按需读取标记，避免大文件全文入库） */
  bodyLoaded?: boolean;
  /** 能力字段对旧 registry 记录可选；新发现资源必须写入。 */
  capability?: ResourceCapability;
  contentStatus?: ResourceContentStatus;
  sourceValidity?: ResourceSourceValidity;
}

// ── 同步游标 ──────────────────────────────────────────────────────────────
/** 事件去重窗口大小：飞书事件视为至少一次投递，窗口内 eventId 重复即跳过 */
export const EVENT_IDEMPOTENCY_WINDOW = 200;

/**
 * 同步水位：watermarks[resourceType] = 该类型已同步到的服务端 updated_at；
 * eventIdempotency 为最近已处理事件 id 窗口（幂等去重）。
 * 游标只允许显式推进/回退（CAS），同步失败绝不落水位。
 */
export interface SyncCursor {
  watermarks: Record<string, string>;
  eventIdempotency: string[];
  updatedAt: string;
}

export interface SyncResult {
  providerId: string;
  added: number;
  updated: number;
  unchanged: number;
  /** 本次已处理的事件 id（并入 eventIdempotency 窗口） */
  processedEventIds: string[];
  /** 本次同步后应落盘的下一个游标；调用方显式 advance 后才生效 */
  nextCursor: SyncCursor;
  at: string;
}

// ── 连接器契约 ────────────────────────────────────────────────────────────
export interface ConnectorProvider {
  readonly id: string;
  readonly kind: 'oauth';
  /** 授权状态与健康检查 */
  status(ctx: ConnectorContext): Promise<ConnectorStatus>;
  /** 发现可接入的资源类型与候选资源（不读全文） */
  discoverResources(ctx: ConnectorContext): Promise<ExternalResource[]>;
  /** 用户选择后的增量同步；返回新资源与变更 */
  sync(ctx: ConnectorContext, cursor?: SyncCursor): Promise<SyncResult>;
  /** 撤销授权：停同步、标记失效、可选级联清理 */
  revoke(ctx: ConnectorContext): Promise<void>;
}

// ── 幂等键工具 ────────────────────────────────────────────────────────────
export const RESOURCE_KEY_SEPARATOR = ':';

/**
 * 构造幂等键：`feishu:tenant-1:calendar:cal_xxx`。
 * 段内不允许出现分隔符，稳定 id 必须非空（防御来自服务端的脏数据）。
 */
export function buildResourceKey(provider: string, tenant: string, type: string, stableId: string): string {
  if (!provider || !tenant || !type || !stableId) {
    throw new Error(`buildResourceKey: empty segment (provider=${provider}, tenant=${tenant}, type=${type}, stableId=${stableId})`);
  }
  const parts = [provider, tenant, type, stableId];
  for (const part of parts) {
    if (part.includes(RESOURCE_KEY_SEPARATOR) || part.includes('\n') || part.includes('\r')) {
      throw new Error(`buildResourceKey: illegal character in segment '${part.slice(0, 32)}'`);
    }
  }
  return parts.join(RESOURCE_KEY_SEPARATOR);
}

export interface ParsedResourceKey {
  provider: string;
  tenant: string;
  type: string;
  stableId: string;
}

/**
 * 解析幂等键；格式不符或段缺失返回 null（不抛错，注册表对脏数据宽容）。
 * 与 buildResourceKey 严格对称：恰好 4 段；provider/tenant/type 段缺一不可，
 * 稳定 id 段含分隔符视为脏数据返回 null。
 */
export function parseResourceKey(resourceId: string): ParsedResourceKey | null {
  if (typeof resourceId !== 'string') return null;
  const parts = resourceId.split(RESOURCE_KEY_SEPARATOR);
  if (parts.length !== 4) return null;
  const [provider, tenant, type, stableId] = parts;
  if (!provider || !tenant || !type || !stableId) return null;
  return { provider, tenant, type, stableId };
}
