import type { ResourceContentStatus } from '../contract';
import type {
  AuthorizationKind,
  BriefingState,
  DashboardAction,
  DashboardMode,
  PersonalContextDashboard,
} from './types';

export interface MessagingDependencyInstance {
  id: string;
  platform: string;
  enabled: boolean;
  ownerConfigured: boolean;
  ownerLabel?: string;
  ownerMaskedId?: string;
  statusKind: string;
  feishuTenantBrand?: 'feishu' | 'lark';
}

export interface AuthorizationDependencyStatus {
  kind: AuthorizationKind;
  needsReauth: boolean;
  authorizing: boolean;
  error?: string;
  identityLabel?: string;
}

export interface RegistryDependencyEntry {
  selected: boolean;
  valid: boolean;
  contentStatus?: ResourceContentStatus;
}

export interface CandidateDependencyItem {
  candidateId: string;
}

export interface BriefingDependencySummary {
  state: BriefingState;
  pendingCandidateCount: number;
  /** 已配置的每日简报任务（去重/状态展示用）；无则 undefined */
  briefingTask?: { id: string; hour: number; minute: number; enabled: boolean };
}

export interface PersonalContextApplicationDependencies {
  listMessagingInstances(userId: string): Promise<MessagingDependencyInstance[]>;
  getAuthorizationStatus(userId: string): Promise<AuthorizationDependencyStatus>;
  listRegistryEntries(userId: string): Promise<RegistryDependencyEntry[]>;
  listCandidates(userId: string): Promise<CandidateDependencyItem[]>;
  buildBriefingPreview(userId: string): Promise<BriefingDependencySummary>;
}

export interface PersonalContextApplicationService {
  getDashboard(userId: string): Promise<PersonalContextDashboard>;
  setMode(userId: string, mode: DashboardMode): Promise<PersonalContextDashboard>;
}

const modeByUser = new Map<string, DashboardMode>();

function validateUserId(userId: string): string {
  const normalized = String(userId || '').trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized.includes('\0')) {
    throw new Error('invalid personal context user id');
  }
  return normalized;
}

function demoDashboard(): PersonalContextDashboard {
  return {
    mode: 'demo',
    messaging: { instanceId: 'demo-feishu', botConnected: true, ownerConfigured: true, ownerLabel: '演示用户' },
    authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '演示用户' },
    resources: { discovered: 4, selected: 3, ready: 3, failed: 0, unsupported: 0 },
    sync: { state: 'ready', lastRunAt: '2026-08-10T08:00:00.000Z', nextRunAt: null, processed: 4, failed: 0 },
    review: { pending: 2, confirmed: 2, rejected: 0, sourceInvalidated: 0 },
    briefing: { state: 'preview_ready', destination: null, lastDelivery: null, pendingCandidateCount: 2 },
    actions: ['mode.real.select', 'sync.start', 'review.open', 'briefing.preview'],
  };
}

function actionsFor(input: Readonly<{
  mode: DashboardMode;
  authorization: AuthorizationDependencyStatus;
  botConnected: boolean;
  selected: number;
  pending: number;
  briefingState: BriefingState;
}>): DashboardAction[] {
  const actions: DashboardAction[] = [];
  if (input.mode === 'demo') return ['mode.real.select', 'sync.start', 'review.open', 'briefing.preview'];
  if (!input.botConnected) return ['mode.demo.start'];
  if (input.authorization.authorizing) actions.push('authorize.cancel');
  else if (input.authorization.kind === 'connected') actions.push(input.selected > 0 ? 'sync.start' : 'resources.discover');
  else actions.push('authorize.begin');
  if (input.authorization.kind === 'connected') actions.push('authorize.revoke');
  if (input.pending > 0) actions.push('review.open');
  if (input.briefingState !== 'not_configured') actions.push('briefing.preview');
  return actions;
}

async function buildRealDashboard(userId: string, deps: PersonalContextApplicationDependencies): Promise<PersonalContextDashboard> {
  const instances = await deps.listMessagingInstances(userId);
  const feishuCandidates = instances.filter((instance) => instance.platform === 'feishu_lark' && instance.enabled);
  // 与 manager.pickFeishuInstance 保持一致的选实例优先级：飞书品牌 > 已连接 > 第一个，
  // 避免同时配了飞书+Lark 时授权/投递落到错误的应用上。
  const feishu = feishuCandidates.find((instance) => instance.feishuTenantBrand === 'feishu')
    ?? feishuCandidates.find((instance) => instance.statusKind === 'connected')
    ?? feishuCandidates[0]
    ?? null;
  const botConnected = feishu?.statusKind === 'connected';
  const authorization = await deps.getAuthorizationStatus(userId);
  const registry = await deps.listRegistryEntries(userId);
  const candidates = await deps.listCandidates(userId);
  const briefing = await deps.buildBriefingPreview(userId);
  const ready = registry.filter((entry) => entry.valid && entry.selected && entry.contentStatus !== 'unsupported' && entry.contentStatus !== 'failed').length;
  const failed = registry.filter((entry) => !entry.valid || entry.contentStatus === 'failed').length;
  const unsupported = registry.filter((entry) => entry.contentStatus === 'unsupported').length;
  const dashboard: PersonalContextDashboard = {
    mode: 'real',
    messaging: {
      instanceId: feishu?.id || null,
      botConnected,
      ownerConfigured: Boolean(feishu?.ownerConfigured),
      ...(feishu?.ownerLabel ? { ownerLabel: feishu.ownerLabel } : {}),
      ...(feishu?.ownerMaskedId ? { ownerMaskedId: feishu.ownerMaskedId } : {}),
      ...(!feishu ? { diagnosticCode: 'feishu_bot_not_configured' } : {}),
    },
    authorization: {
      kind: authorization.kind,
      providerId: 'feishu',
      ...(authorization.identityLabel ? { identityLabel: authorization.identityLabel } : {}),
      ...(authorization.error ? { lastErrorCode: authorization.error } : {}),
    },
    resources: {
      discovered: registry.length,
      selected: registry.filter((entry) => entry.selected).length,
      ready,
      failed,
      unsupported,
    },
    sync: {
      state: registry.length > 0 && failed === 0 ? 'ready' : 'idle',
      lastRunAt: null,
      nextRunAt: null,
      processed: registry.length,
      failed,
      // 失败详情透出给设置页，避免用户卡在"同步"按钮上看不到原因。
      ...(failed > 0 ? { message: `有 ${failed} 个资源同步失败，下次同步将自动重试` } : {}),
    },
    review: { pending: candidates.length, confirmed: 0, rejected: 0, sourceInvalidated: failed },
    briefing: {
      state: briefing.state,
      destination: briefing.briefingTask && briefing.briefingTask.enabled
        ? {
            instanceId: feishu?.id || 'unknown',
            ...(feishu?.ownerLabel ? { ownerLabel: feishu.ownerLabel } : {}),
            configured: true,
            schedule: { hour: briefing.briefingTask.hour, minute: briefing.briefingTask.minute },
          }
        : null,
      lastDelivery: null,
      pendingCandidateCount: briefing.pendingCandidateCount,
    },
    actions: [],
  };
  dashboard.actions = actionsFor({
    mode: 'real',
    authorization,
    botConnected,
    selected: dashboard.resources.selected,
    pending: dashboard.review.pending,
    briefingState: briefing.state,
  });
  return dashboard;
}

export function createPersonalContextApplicationService(
  deps: PersonalContextApplicationDependencies,
): PersonalContextApplicationService {
  return {
    async getDashboard(userId: string): Promise<PersonalContextDashboard> {
      const normalizedUserId = validateUserId(userId);
      return modeByUser.get(normalizedUserId) === 'demo' ? demoDashboard() : buildRealDashboard(normalizedUserId, deps);
    },
    async setMode(userId: string, mode: DashboardMode): Promise<PersonalContextDashboard> {
      const normalizedUserId = validateUserId(userId);
      if (mode !== 'real' && mode !== 'demo') throw new Error('invalid personal context mode');
      if (mode === 'demo') modeByUser.set(normalizedUserId, mode);
      else modeByUser.delete(normalizedUserId);
      return mode === 'demo' ? demoDashboard() : buildRealDashboard(normalizedUserId, deps);
    },
  };
}

export function resetPersonalContextApplicationModeForTest(): void {
  modeByUser.clear();
}
