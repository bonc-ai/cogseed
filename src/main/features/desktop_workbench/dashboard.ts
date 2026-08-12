import { safeId } from '../../storage';
import type { PersonalContextDashboard } from '../personal_context/application/types';
import type { ReviewItemView } from '../personal_context/application';
import type { TouchpointIntent } from '../touchpoints/types';
import type {
  DesktopWorkbenchProjection,
  DesktopWorkbenchProjectionInput,
  WorkbenchAttentionItem,
  WorkbenchDecisionItem,
  WorkbenchRunningItem,
  WorkbenchTimelineItem,
} from './types';

function assertUserId(userId: string): void {
  if (!safeId(userId)) throw new Error('invalid desktop workbench user id');
}

function buildAttention(dashboard: PersonalContextDashboard, reviewItems: ReviewItemView[]): WorkbenchAttentionItem[] {
  const attention: WorkbenchAttentionItem[] = [];
  if (!dashboard.messaging.botConnected || !dashboard.messaging.instanceId) {
    attention.push({
      id: 'attention-feishu-connection',
      kind: 'feishu_not_connected',
      severity: 'critical',
      title: '连接飞书，让 Mate 可以在你离开电脑后联系你',
      detail: dashboard.messaging.diagnosticCode || '尚未建立真实的飞书消息连接。',
      action: 'touchpoint.feishu.connect',
    });
  }
  if (dashboard.authorization.kind !== 'connected') {
    attention.push({
      id: 'attention-resource-authorization',
      kind: 'resource_authorization_required',
      severity: dashboard.authorization.kind === 'error' ? 'critical' : 'warning',
      title: '授权 Mate 读取你的日历和资料',
      detail: dashboard.authorization.lastErrorCode || '默认只读，资源范围由你选择并可随时撤销。',
      action: 'cognition.authorize',
    });
  }
  if (dashboard.sync.failed > 0 || dashboard.sync.state === 'partial_failure' || dashboard.sync.state === 'failed') {
    attention.push({
      id: 'attention-sync',
      kind: 'sync_partial',
      severity: dashboard.sync.state === 'failed' ? 'critical' : 'warning',
      title: '资料同步需要处理',
      detail: dashboard.sync.message || `已处理 ${dashboard.sync.processed} 项，${dashboard.sync.failed} 项失败。`,
      action: 'cognition.sync',
    });
  }
  if (reviewItems.length > 0) {
    attention.push({
      id: 'attention-review',
      kind: 'review_pending',
      severity: 'warning',
      title: `${reviewItems.length} 条认知需要你确认`,
      detail: 'Mate 会显示每条事实的来源和证据，不会自动写入长期认知。',
      action: 'cognition.review',
    });
  }
  if (dashboard.messaging.botConnected && dashboard.briefing.state === 'preview_ready') {
    attention.push({
      id: 'attention-briefing',
      kind: 'briefing_ready',
      severity: 'info',
      title: '今日简报已经准备好',
      detail: dashboard.briefing.destination?.configured ? '可以在桌面端预览，也可以投递到飞书。' : '先连接一个真实的飞书触点再投递。',
      action: 'briefing.preview',
    });
  }
  return attention;
}

function buildTimeline(intents: TouchpointIntent[]): WorkbenchTimelineItem[] {
  return intents
    .filter((intent) => ['planned', 'ready', 'sending', 'sent', 'retry_pending'].includes(intent.status))
    .map((intent) => ({
      id: intent.intentId,
      title: intent.content.title,
      channel: intent.channel,
      state: intent.status as WorkbenchTimelineItem['state'],
      scheduledAt: intent.availableFrom,
      expiresAt: intent.expiresAt,
      priority: intent.priority,
    }))
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
}

function buildDecisions(items: ReviewItemView[]): WorkbenchDecisionItem[] {
  return items.map((item) => ({
    id: item.candidateId,
    kind: 'ontology_confirmation',
    title: item.summary,
    detail: item.sourceRefs.length ? `来源：${item.sourceRefs.join('、')}` : '暂无来源信息',
    confidence: item.confidence,
    sourceRefs: [...item.sourceRefs],
  }));
}

function buildRunning(intents: TouchpointIntent[]): WorkbenchRunningItem[] {
  return intents
    .filter((intent) => intent.status === 'sending' || intent.status === 'retry_pending')
    .map((intent) => ({
      id: intent.intentId,
      state: intent.status as WorkbenchRunningItem['state'],
      title: intent.content.title,
      detail: intent.content.body || 'Mate 正在处理触点投递。',
      attempts: intent.attempts,
      channel: 'feishu',
    }));
}

export function buildDesktopWorkbenchProjection(
  userId: string,
  input: DesktopWorkbenchProjectionInput,
): DesktopWorkbenchProjection {
  assertUserId(userId);
  if (!input || !input.dashboard || !Array.isArray(input.reviewItems) || !Array.isArray(input.intents)) {
    throw new Error('invalid desktop workbench projection input');
  }
  const generatedAt = new Date(Date.parse(input.generatedAt));
  if (!Number.isFinite(generatedAt.getTime())) throw new Error('invalid desktop workbench generatedAt');
  const dashboard = input.dashboard;
  return {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    mode: dashboard.mode,
    sections: {
      attention: buildAttention(dashboard, input.reviewItems),
      timeline: buildTimeline(input.intents),
      decisions: buildDecisions(input.reviewItems),
      running: buildRunning(input.intents),
    },
    touchpoints: [{
      channel: 'feishu',
      connected: dashboard.messaging.botConnected,
      ownerBound: dashboard.messaging.ownerConfigured,
      realMode: dashboard.mode === 'real',
      instanceId: dashboard.messaging.instanceId,
      ...(dashboard.messaging.diagnosticCode ? { lastError: dashboard.messaging.diagnosticCode } : {}),
    }],
  };
}
