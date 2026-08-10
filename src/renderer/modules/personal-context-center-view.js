// Personal Context Center DOM renderer. It receives normalized state and callbacks only.
(function () {
  'use strict';

  function tr(key, fallback) {
    try { if (typeof t === 'function') return t(key); } catch (_) { /* locale failure is rendered with fallback */ }
    return fallback;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, action, primary) {
    const node = el('button', primary ? 'btn btn-primary' : 'btn messaging-secondary-button', label);
    node.type = 'button';
    node.dataset.pcAction = action;
    return node;
  }

  function metric(label, value) {
    const node = el('div', 'pc-center-metric');
    node.append(el('strong', '', String(value)), el('span', '', label));
    return node;
  }

  function statusLabel(kind) {
    const labels = {
      ready_to_authorize: tr('personal_context_center.auth_ready', '等待授权'),
      authorizing: tr('personal_context_center.auth_authorizing', '授权中'),
      connected: tr('personal_context_center.auth_connected', '已连接真实飞书'),
      needs_reauth: tr('personal_context_center.auth_reauth', '授权已失效'),
      error: tr('personal_context_center.auth_error', '连接异常'),
      disconnected: tr('personal_context_center.auth_disconnected', '未连接'),
      revoked: tr('personal_context_center.auth_revoked', '已撤销'),
    };
    return labels[kind] || labels.disconnected;
  }

  function actionLabel(action) {
    const labels = {
      'mode.demo.start': tr('personal_context_center.demo_start', '体验完整流程'),
      'mode.real.select': tr('personal_context_center.real_mode', '返回真实连接'),
      'authorize.begin': tr('personal_context_center.connect', '连接我的飞书'),
      'authorize.cancel': tr('personal_context_center.cancel', '取消授权'),
      'authorize.revoke': tr('personal_context_center.revoke', '撤销授权'),
      'resources.discover': tr('personal_context_center.discover', '发现可用资源'),
      'sync.start': tr('personal_context_center.sync', '立即同步'),
      'review.open': tr('personal_context_center.review', '审核待确认信息'),
      'briefing.preview': tr('personal_context_center.preview', '预览今日简报'),
    };
    return labels[action] || action;
  }

  function renderResources(state) {
    const section = el('section', 'messaging-config-card pc-center-section');
    section.append(el('h3', '', tr('personal_context_center.resources_title', '允许读取的内容')));
    section.append(el('p', 'pc-center-section-copy', tr('personal_context_center.resources_desc', '只同步你明确选择的日历、文件夹、文档和知识库内容。')));
    const resources = Array.isArray(state.resources) ? state.resources : [];
    if (!resources.length) {
      section.append(el('div', 'settings-empty', tr('personal_context_center.resources_empty', '连接后点击“发现可用资源”。')));
      return section;
    }
    const list = el('div', 'pc-resource-list');
    for (const resource of resources) {
      const row = el('label', 'pc-resource-row');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.selectedIds && state.selectedIds.has(resource.resourceId);
      input.dataset.pcResourceId = resource.resourceId;
      const main = el('span', 'pc-resource-main');
      main.append(el('strong', '', resource.title || resource.resourceId));
      main.append(el('small', '', resource.resourceType || 'resource'));
      const status = resource.capability && resource.capability.canReadContent === false
        ? tr('personal_context_center.resource_unsupported', '仅引用，不读取正文')
        : tr('personal_context_center.resource_ready', '可读取和理解');
      row.append(input, main, el('span', 'pc-resource-status', status));
      list.append(row);
    }
    section.append(list);
    section.append(button(tr('personal_context_center.scope_save', '保存接入范围'), 'resources.save', true));
    return section;
  }

  function renderReview(state) {
    const section = el('section', 'messaging-config-card pc-center-section');
    section.append(el('h3', '', tr('personal_context_center.review_title', '它想记住什么')));
    const items = Array.isArray(state.reviewItems) ? state.reviewItems : [];
    if (!items.length) {
      section.append(el('p', 'pc-center-section-copy', tr('personal_context_center.review_empty', '同步后，系统提取的信息会在这里等待你确认。')));
      return section;
    }
    const list = el('div', 'pc-review-list');
    for (const item of items) {
      const card = el('article', 'pc-review-card');
      card.dataset.candidateId = item.candidateId;
      card.append(el('strong', '', item.summary));
      card.append(el('p', '', `${tr('personal_context_center.source', '来源')}：${(item.sourceRefs || []).join('、') || tr('personal_context_center.source_unknown', '未知来源')}`));
      const actions = el('div', 'pc-inline-actions');
      const approve = button(tr('personal_context_center.approve', '确认记住'), 'review.approve', true);
      approve.dataset.candidateId = item.candidateId;
      const reject = button(tr('personal_context_center.reject', '拒绝'), 'review.reject', false);
      reject.dataset.candidateId = item.candidateId;
      actions.append(approve, reject);
      card.append(actions);
      list.append(card);
    }
    section.append(list);
    return section;
  }

  function renderBriefing(state) {
    const section = el('section', 'messaging-config-card pc-center-section pc-briefing-card');
    section.append(el('h3', '', tr('personal_context_center.briefing_title', '今日简报')));
    const preview = state.preview;
    if (!preview) {
      section.append(el('p', 'pc-center-section-copy', tr('personal_context_center.briefing_empty', '先同步并确认信息，然后生成一份可追溯的简报。')));
      return section;
    }
    const pre = el('div', 'pc-briefing-preview');
    pre.textContent = preview.text || '';
    section.append(pre);
    if (preview.degraded) section.append(el('p', 'pc-center-warning', tr('personal_context_center.briefing_degraded', '部分数据暂不可用，简报已明确标记缺失来源。')));
    return section;
  }

  function render(state) {
    const root = el('div', 'pc-center');
    const dashboard = state.dashboard || {};
    const header = el('header', 'pc-center-header');
    const heading = el('div', 'pc-center-heading');
    heading.append(el('span', `pc-mode-badge is-${dashboard.mode === 'demo' ? 'demo' : 'real'}`, dashboard.mode === 'demo' ? tr('personal_context_center.demo_badge', '演示模式') : tr('personal_context_center.real_badge', '真实连接')));
    heading.append(el('h2', '', tr('personal_context_center.title', '个人伴侣数据中心')));
    heading.append(el('p', '', tr('personal_context_center.subtitle', '连接真实飞书，选择数据范围，确认它可以记住的信息，再生成和投递简报。')));
    header.append(heading);
    root.append(header);

    const auth = dashboard.authorization || {};
    const connection = el('section', 'messaging-config-card pc-connection-card');
    connection.append(el('div', `pc-connection-state is-${auth.kind || 'disconnected'}`, statusLabel(auth.kind)));
    if (dashboard.messaging && dashboard.messaging.diagnosticCode) {
      connection.append(el('p', 'pc-center-warning', tr('personal_context_center.admin_required', '尚未配置可用的飞书机器人应用。部署者完成配置后，普通用户只需要点击授权。')));
    }
    const actions = el('div', 'pc-inline-actions');
    for (const action of dashboard.actions || []) {
      if (action === 'review.open' || action === 'briefing.preview') continue;
      actions.append(button(actionLabel(action), action, action === 'authorize.begin' || action === 'sync.start'));
    }
    connection.append(actions);
    root.append(connection);

    const metrics = el('div', 'pc-center-metrics');
    metrics.append(
      metric(tr('personal_context_center.metric_selected', '已选择资源'), dashboard.resources ? dashboard.resources.selected : 0),
      metric(tr('personal_context_center.metric_ready', '已同步资源'), dashboard.resources ? dashboard.resources.ready : 0),
      metric(tr('personal_context_center.metric_pending', '待确认信息'), dashboard.review ? dashboard.review.pending : 0),
      metric(tr('personal_context_center.metric_failed', '异常资源'), dashboard.resources ? dashboard.resources.failed : 0),
    );
    root.append(metrics, renderResources(state), renderReview(state), renderBriefing(state));

    if (state.busy) root.setAttribute('aria-busy', 'true');
    if (state.notice) root.append(el('div', `messaging-notice is-${state.notice.kind || 'info'}`, state.notice.text));
    return root;
  }

  const api = Object.freeze({ render, renderResources, renderReview, renderBriefing });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PersonalContextCenterView = api;
})();
