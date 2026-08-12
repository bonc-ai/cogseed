(function touchpointSettingsModelModule(root) {
  'use strict';

  const STEP_ORDER = ['connection', 'authorization', 'resources', 'ready'];

  // 文案映射表：step+reason → i18n key（渲染层 t() 翻译）。
  // 术语黑名单测试（Task 6）断言这些 key 的译文不含 ou_/Card JSON/颗粒度/实例。
  const ISSUE_COPY = {
    'connection.not_configured': { titleKey: 'touchpoint_settings.issue.connection_not_configured.title', detailKey: 'touchpoint_settings.issue.connection_not_configured.detail', actionLabelKey: 'touchpoint_settings.action.connection.connect' },
    'connection.bot_error': { titleKey: 'touchpoint_settings.issue.bot_error.title', detailKey: 'touchpoint_settings.issue.bot_error.detail', actionLabelKey: 'touchpoint_settings.action.connection.connect' },
    'authorization.token_expired': { titleKey: 'touchpoint_settings.issue.token_expired.title', detailKey: 'touchpoint_settings.issue.token_expired.detail', actionLabelKey: 'touchpoint_settings.action.authorization.reauth' },
    'authorization.not_configured': { titleKey: 'touchpoint_settings.issue.authorization_not_configured.title', detailKey: 'touchpoint_settings.issue.authorization_not_configured.detail', actionLabelKey: 'touchpoint_settings.action.authorization.begin' },
    'delivery.sync_failed': { titleKey: 'touchpoint_settings.issue.sync_failed.title', detailKey: 'touchpoint_settings.issue.sync_failed.detail', actionLabelKey: 'touchpoint_settings.action.sync.retry' },
    'delivery.no_resources': { titleKey: 'touchpoint_settings.issue.no_resources.title', detailKey: 'touchpoint_settings.issue.no_resources.detail', actionLabelKey: 'touchpoint_settings.action.resources.discover' },
    'delivery.not_configured': { titleKey: 'touchpoint_settings.issue.delivery_not_configured.title', detailKey: 'touchpoint_settings.issue.delivery_not_configured.detail', actionLabelKey: 'touchpoint_settings.action.briefing.schedule' },
  };

  // ── 本地兜底推导（overall 缺失时，如旧数据/旧测试 fixture）──────────────
  function fallbackChain(dashboard, botConnected, authorized, hasResources, syncState) {
    const connection = !botConnected ? (dashboard.messaging && dashboard.messaging.instanceId ? 'broken' : 'missing') : 'ok';
    const authKind = dashboard.authorization && dashboard.authorization.kind;
    const authorization = !authorized
      ? (authKind === 'needs_reauth' || authKind === 'revoked' || authKind === 'error' ? 'broken' : 'missing')
      : 'ok';
    const delivery = !authorized || !hasResources
      ? 'missing'
      : (syncState === 'failed' || syncState === 'partial_failure' ? 'broken'
        : (syncState === 'ready' || syncState === 'awaiting_review' ? 'ok' : 'missing'));
    return { connection, authorization, delivery };
  }

  function fallbackOverall(dashboard, botConnected, authorized, hasResources, syncState) {
    const chain = fallbackChain(dashboard, botConnected, authorized, hasResources, syncState);
    const issues = [];
    if (chain.connection === 'missing') issues.push({ severity: 'warning', step: 'connection', reason: 'not_configured', actionId: 'connection.connect' });
    else if (chain.connection === 'broken') issues.push({ severity: 'error', step: 'connection', reason: 'bot_error', actionId: 'connection.connect' });
    if (chain.authorization === 'broken') issues.push({ severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' });
    else if (chain.authorization === 'missing' && chain.connection === 'ok') issues.push({ severity: 'warning', step: 'authorization', reason: 'not_configured', actionId: 'authorize.begin' });
    if (chain.delivery === 'broken') issues.push({ severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' });
    else if (chain.delivery === 'missing' && chain.authorization === 'ok') {
      const noResources = !hasResources;
      issues.push({ severity: 'warning', step: 'delivery', reason: noResources ? 'no_resources' : 'not_configured', actionId: noResources ? 'resources.discover' : 'briefing.schedule' });
    }
    const allOk = chain.connection === 'ok' && chain.authorization === 'ok' && chain.delivery === 'ok';
    const allMissing = chain.connection === 'missing' && chain.authorization === 'missing' && chain.delivery === 'missing';
    return { status: allOk ? 'ready' : allMissing ? 'off' : 'attention', chain, issues };
  }

  function buildIssueViewModel(issue) {
    const copy = ISSUE_COPY[`${issue.step}.${issue.reason}`] || {
      titleKey: 'touchpoint_settings.issue.generic.title',
      detailKey: 'touchpoint_settings.issue.generic.detail',
      actionLabelKey: issue.actionId ? `touchpoint_settings.action.${issue.actionId}` : '',
    };
    return { ...issue, ...copy };
  }

  function deriveTouchpointSettingsModel(dashboard, instances) {
    const data = dashboard || {};
    const messaging = data.messaging || {};
    const authorization = data.authorization || {};
    const resources = data.resources || {};
    const sync = data.sync || {};
    const briefing = data.briefing || {};
    const botConnected = messaging.botConnected === true && messaging.ownerConfigured === true;
    const authorizing = authorization.kind === 'authorizing';
    const authorized = authorization.kind === 'connected';
    const hasResources = Number(resources.selected || 0) > 0;
    const ready = botConnected && authorized && hasResources && ['ready', 'awaiting_review'].includes(sync.state);
    const currentStep = !botConnected ? 'connection' : !authorized ? 'authorization' : !hasResources ? 'resources' : 'ready';
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    const steps = STEP_ORDER.map((id, index) => ({
      id,
      state: ready || index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'waiting',
    }));
    // overall：后端优先（Task 2 注入）；缺失时本地兜底（旧数据/测试 fixture）
    const overall = data.overall || fallbackOverall(data, botConnected, authorized, hasResources, sync.state);
    const syncInProgress = ['discovering', 'syncing', 'extracting'].includes(sync.state);
    const chain = {
      connection: { state: overall.chain.connection, inProgress: false },
      authorization: { state: overall.chain.authorization, inProgress: authorizing },
      delivery: { state: overall.chain.delivery, inProgress: syncInProgress },
    };
    const destination = briefing.destination || null;
    return {
      status: overall.status,                       // ready | attention | off（替换旧三态）
      overallStatus: overall.status,
      chain,
      issues: (overall.issues || []).map(buildIssueViewModel),
      currentStep,
      steps,                                        // 保留（旧渲染过渡期仍引用；Task 4 移除渲染引用后删除）
      primaryAction: !botConnected
        ? 'connection.connect'
        : authorizing
          ? 'authorize.cancel'
          : !authorized
            ? 'authorization.begin'
            : !hasResources
              ? 'resources.discover'
              : sync.state !== 'ready' && sync.state !== 'awaiting_review'
                ? 'sync.start'
                : 'briefing.preview',
      botConnected,
      authorizing,
      authorized,
      hasResources,
      ready,
      showMetrics: authorized && (Number(resources.discovered || 0) > 0 || hasResources),
      canConfigureDelivery: ready,
      identityLabel: authorization.identityLabel || messaging.ownerLabel || messaging.ownerMaskedId || '',
      // 矛盾修复：authorized 时 label 缺失回退「已连接账号」，绝不显示「未授权」
      authorizedLabel: authorized ? (authorization.identityLabel || '已连接账号') : '未授权',
      instanceCount: Array.isArray(instances)
        ? instances.filter((instance) => instance && instance.platform === 'feishu_lark' && instance.enabled === true).length
        : 0,
      syncMessage: typeof sync.message === 'string' && sync.message ? sync.message : '',
      briefingConfigured: Boolean(destination && destination.configured),
      briefingSchedule: destination && destination.configured && destination.schedule
        ? { hour: destination.schedule.hour, minute: destination.schedule.minute }
        : null,
    };
  }

  const api = Object.freeze({ deriveTouchpointSettingsModel });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TouchpointSettingsModel = api;
}(typeof window !== 'undefined' ? window : null));
