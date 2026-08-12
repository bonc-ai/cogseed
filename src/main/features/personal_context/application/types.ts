import type {
  ResourceCapability,
  ResourceContentStatus,
  ResourceSourceValidity,
  ResourceType,
} from '../contract';

export type DashboardMode = 'real' | 'demo';
export type AuthorizationKind = 'disconnected' | 'ready_to_authorize' | 'authorizing' | 'connected' | 'needs_reauth' | 'revoked' | 'error';
export type SyncState = 'idle' | 'discovering' | 'syncing' | 'extracting' | 'awaiting_review' | 'ready' | 'partial_failure' | 'failed';
export type BriefingState = 'not_configured' | 'preview_ready' | 'sending' | 'delivered' | 'delivery_failed' | 'paused';

export type DashboardAction =
  | 'mode.demo.start'
  | 'mode.real.select'
  | 'connection.connect'          // 新增：触点页待办卡「连接机器人」
  | 'authorize.begin'
  | 'authorization.begin'  // 新增：触点页待办卡「授权日历和资料」（前端 runAction 分支名，与 authorize.begin 流程同义）
  | 'authorize.cancel'
  | 'authorize.revoke'
  | 'authorization.reauth'        // 新增：待办卡「重新授权」（前端映射到 authorize.begin 流程）
  | 'resources.discover'
  | 'resources.select'
  | 'sync.start'
  | 'sync.retry'
  | 'review.open'
  | 'briefing.preview'
  | 'briefing.test_delivery'
  | 'briefing.schedule'
  | 'briefing.pause';

export interface MessagingConnectionSummary {
  instanceId: string | null;
  botConnected: boolean;
  ownerConfigured: boolean;
  ownerLabel?: string;
  ownerMaskedId?: string;
  diagnosticCode?: string;
}

export interface AuthorizationSummary {
  kind: AuthorizationKind;
  providerId: 'feishu';
  identityLabel?: string;
  grantedScopes?: string[];
  missingScopes?: string[];
  lastErrorCode?: string;
}

export interface ResourceSummary {
  discovered: number;
  selected: number;
  ready: number;
  failed: number;
  unsupported: number;
}

export interface SyncSummary {
  state: SyncState;
  lastRunAt: string | null;
  nextRunAt: string | null;
  processed: number;
  failed: number;
  message?: string;
}

export interface ReviewSummary {
  pending: number;
  confirmed: number;
  rejected: number;
  sourceInvalidated: number;
}

export interface BriefingDestinationSummary {
  instanceId: string;
  ownerLabel?: string;
  configured: boolean;
  /** 已配置的每日简报时间（来自 auto task 的 daily schedule） */
  schedule?: { hour: number; minute: number };
}

export interface DeliverySummary {
  status: 'sent' | 'deduplicated' | 'owner_missing' | 'not_connected' | 'failed';
  deliveredAt?: string;
  retryable: boolean;
  message?: string;
}

export interface BriefingSummary {
  state: BriefingState;
  destination: BriefingDestinationSummary | null;
  lastDelivery: DeliverySummary | null;
  pendingCandidateCount: number;
}

// ── 语义聚合层（overall）─────────────────────────────
export type ChainState = 'ok' | 'missing' | 'broken';
export type OverallStatus = 'ready' | 'attention' | 'off';
export type IssueReason = 'not_configured' | 'token_expired' | 'sync_failed' | 'no_resources' | 'bot_error';

export interface DashboardIssue {
  severity: 'error' | 'warning';
  step: 'connection' | 'authorization' | 'delivery';
  reason: IssueReason;
  actionId: DashboardAction | null;
}

export interface DashboardOverall {
  status: OverallStatus;
  chain: { connection: ChainState; authorization: ChainState; delivery: ChainState };
  issues: DashboardIssue[];
}

export interface PersonalContextDashboard {
  mode: DashboardMode;
  messaging: MessagingConnectionSummary;
  authorization: AuthorizationSummary;
  resources: ResourceSummary;
  sync: SyncSummary;
  review: ReviewSummary;
  briefing: BriefingSummary;
  actions: DashboardAction[];
  overall: DashboardOverall;   // 新增：语义聚合层
}

export interface SerializedPersonalContextError {
  stage: string;
  code: string;
  messageKey: string;
  recoverable: boolean;
  retryAction?: DashboardAction;
  causeMessage?: string;
}

export interface ResourceViewModel {
  resourceId: string;
  resourceType: ResourceType;
  title: string;
  sourceVersion?: string;
  capability?: ResourceCapability;
  contentStatus?: ResourceContentStatus;
  sourceValidity?: ResourceSourceValidity;
}

export function getPrimaryDashboardAction(input: Pick<PersonalContextDashboard, 'mode' | 'authorization'>): DashboardAction {
  if (input.mode === 'demo') return 'sync.start';
  switch (input.authorization.kind) {
    case 'authorizing': return 'authorize.cancel';
    case 'connected': return 'resources.discover';
    case 'ready_to_authorize':
    case 'needs_reauth':
    case 'disconnected':
    case 'revoked':
    case 'error':
      return 'authorize.begin';
  }
}

export { serializePersonalContextError } from './errors';
