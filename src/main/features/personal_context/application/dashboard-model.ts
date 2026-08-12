/**
 * 语义聚合层：把组件级 dashboard（messaging/authorization/resources/sync/briefing）
 * 聚合成用户语义的整体状态（overall）。
 *
 * 设计稿：docs/superpowers/specs/2026-08-12-touchpoint-dashboard-redesign-design.md §5.2
 * 纯函数：输入 PersonalContextDashboard，输出 DashboardOverall；不读写业务数据。
 */
import type { ChainState, DashboardIssue, DashboardOverall, PersonalContextDashboard } from './types';

/**
 * 连接环节：ok ⇔ 有已启用实例且归属已配置（botConnected 语义）；
 * broken = 实例 error 态；missing = 其余（未配置/connecting/disconnected——
 * connecting 是瞬态，渲染层读 statusKind 特判"处理中"，不产生待办）。
 */
function chainConnection(dashboard: PersonalContextDashboard): ChainState {
  const { messaging } = dashboard;
  if (messaging.botConnected === true && messaging.ownerConfigured === true) return 'ok';
  if (messaging.statusKind === 'error') return 'broken';
  return 'missing'; // 含 connecting/disconnected：渲染层以 inProgress 表达"处理中"
}

/**
 * 授权环节：ok = connected；broken = needs_reauth/revoked/error；
 * missing = 其余（disconnected/ready_to_authorize/authorizing——authorizing 由
 * 渲染层读组件字段特判"授权中"，不产生待办）。
 */
function chainAuthorization(dashboard: PersonalContextDashboard): ChainState {
  const kind = dashboard.authorization.kind;
  if (kind === 'connected') return 'ok';
  if (kind === 'needs_reauth' || kind === 'revoked' || kind === 'error') return 'broken';
  return 'missing';
}

/**
 * 投递环节：前置（连接+授权）未就绪或未选资源 → missing；
 * 同步失败 → broken；ready/awaiting_review → ok；其余（进行中）→ missing（渲染层特判）。
 */
function chainDelivery(dashboard: PersonalContextDashboard): ChainState {
  const { authorization, resources, sync } = dashboard;
  if (authorization.kind !== 'connected') return 'missing';
  if (resources.selected === 0) return 'missing';
  if (sync.state === 'failed' || sync.state === 'partial_failure') return 'broken';
  if (sync.state === 'ready' || sync.state === 'awaiting_review') return 'ok';
  return 'missing';
}

export function deriveOverall(dashboard: PersonalContextDashboard): DashboardOverall {
  const chain = {
    connection: chainConnection(dashboard),
    authorization: chainAuthorization(dashboard),
    delivery: chainDelivery(dashboard),
  };
  const issues: DashboardIssue[] = [];
  if (chain.connection === 'missing' && dashboard.messaging.statusKind !== 'connecting') {
    issues.push({ severity: 'warning', step: 'connection', reason: 'not_configured', actionId: 'connection.connect' });
  } else if (chain.connection === 'broken') {
    issues.push({ severity: 'error', step: 'connection', reason: 'bot_error', actionId: 'connection.connect' });
  }
  if (chain.authorization === 'broken') {
    issues.push({ severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' });
  } else if (chain.authorization === 'missing' && chain.connection === 'ok') {
    issues.push({ severity: 'warning', step: 'authorization', reason: 'not_configured', actionId: 'authorization.begin' });
  }
  if (chain.delivery === 'broken') {
    issues.push({ severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' });
  } else if (chain.delivery === 'missing' && chain.authorization === 'ok') {
    const noResources = dashboard.resources.selected === 0;
    issues.push({
      severity: 'warning',
      step: 'delivery',
      reason: noResources ? 'no_resources' : 'not_configured',
      actionId: noResources ? 'resources.discover' : 'briefing.schedule',
    });
  }
  const allOk = chain.connection === 'ok' && chain.authorization === 'ok' && chain.delivery === 'ok';
  const allMissing = chain.connection === 'missing' && chain.authorization === 'missing' && chain.delivery === 'missing';
  return { status: allOk ? 'ready' : allMissing ? 'off' : 'attention', chain, issues };
}
