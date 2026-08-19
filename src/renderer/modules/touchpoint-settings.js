(function touchpointSettingsModule() {
  'use strict';

  const state = {
    dashboard: null,
    instances: [],
    // null = 尚未 discover（禁止 save，防止提交空数组清空已有资源范围）；
    // [] = discover 返回了空列表（允许 save，即"全部取消勾选"的合法结果）。
    resources: null,
    selectedIds: new Set(),
    preview: null,
    busy: false,
    notice: null,
    bound: false,
    advancedLoaded: false,
    view: 'overview',
    briefingTime: '08:00',
    // 授权前引导：用户未确认过回调地址配置时，授权入口先展示引导卡
    setupGuide: null,
    touchpointConfig: null,
    touchpointScene: 'task_approval',
    touchpointDrafts: Object.create(null),
  };

  function tr(key, fallback, vars) {
    try { return typeof t === 'function' ? t(key, vars) : fallback; } catch (_) { return fallback; }
  }
  function noticeText(notice) {
    if (!notice) return '';
    return notice.key ? tr(notice.key, notice.fallback || '', notice.vars) : String(notice.text || '');
  }
  function root() { return document.getElementById('touchpoint-settings-page'); }
  function shell() { return document.querySelector('.touchpoint-settings-shell'); }
  function overviewView() { return document.getElementById('touchpoint-overview-view'); }
  function connectionsView() { return document.getElementById('touchpoint-connections-view'); }
  function escape(value) {
    const node = document.createElement('div');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  }
  function iconMarkup(name, className) {
    return `<span data-ui-icon="${escape(name)}" data-ui-icon-class="${escape(className || 'ui-icon')}"></span>`;
  }
  function hydrate(container) {
    if (typeof window.hydrateUiIcons === 'function') window.hydrateUiIcons(container);
  }
  function model() {
    return window.TouchpointSettingsModel.deriveTouchpointSettingsModel(state.dashboard, state.instances);
  }
  function statusText(value) { return tr(`touchpoint_settings.status.${value}`, value); }
  function stepText(value) { return tr(`touchpoint_settings.step.${value}`, value); }
  function primaryText(action) { return tr(`touchpoint_settings.action.${action}`, action); }

  function renderSteps(view) {
    return `<div class="touchpoint-stepper">${view.steps.map((step, index) => `<div class="touchpoint-step is-${step.state}"><span class="touchpoint-step-index">${step.state === 'complete' ? iconMarkup('check', 'touchpoint-step-check') : index + 1}</span><div><strong>${escape(stepText(step.id))}</strong><span>${escape(tr(`touchpoint_settings.step_detail.${step.id}`, ''))}</span></div></div>${index < view.steps.length - 1 ? '<span class="touchpoint-step-line"></span>' : ''}`).join('')}</div>`;
  }

  function renderConnectionCard(view) {
    const dashboard = state.dashboard || {};
    const messaging = dashboard.messaging || {};
    return `<article class="touchpoint-card"><div class="touchpoint-card-heading"><div class="touchpoint-card-icon is-feishu">${iconMarkup('message-square', 'touchpoint-card-glyph')}</div><div><h3>${escape(tr('touchpoint_settings.connection.title', '飞书连接与身份'))}</h3><p>${escape(view.botConnected ? tr('touchpoint_settings.connection.connected_detail', '机器人和本人身份均已连接。') : tr('touchpoint_settings.connection.empty_detail', '连接一个真实机器人，并绑定你的飞书身份。'))}</p></div></div><dl class="touchpoint-facts"><div><dt>${escape(tr('touchpoint_settings.connection.bot', '机器人'))}</dt><dd>${escape(view.botConnected ? tr('touchpoint_settings.connected', '已连接') : tr('touchpoint_settings.not_connected', '未连接'))}</dd></div><div><dt>${escape(tr('touchpoint_settings.connection.identity', '接收身份'))}</dt><dd>${escape(view.identityLabel || tr('touchpoint_settings.not_bound', '未绑定'))}</dd></div><div><dt>${escape(tr('touchpoint_settings.connection.instances', '实例'))}</dt><dd>${view.instanceCount}</dd></div></dl><button class="btn touchpoint-secondary" data-touchpoint-action="connection.manage">${escape(tr('touchpoint_settings.connection.manage', '管理连接'))}</button></article>`;
  }

  function renderAccessCard(view) {
    const dashboard = state.dashboard || {};
    const auth = dashboard.authorization || {};
    const resources = dashboard.resources || {};
    return `<article class="touchpoint-card"><div class="touchpoint-card-heading"><div class="touchpoint-card-icon">${iconMarkup('shield', 'touchpoint-card-glyph')}</div><div><h3>${escape(tr('touchpoint_settings.access.title', '数据访问范围'))}</h3><p>${escape(view.authorized ? tr('touchpoint_settings.access.connected_detail', '只读取你明确选择的日历和资料。') : tr('touchpoint_settings.access.empty_detail', '授权与消息连接分开管理，默认只读。'))}</p></div></div><dl class="touchpoint-facts"><div><dt>${escape(tr('touchpoint_settings.access.account', '授权账号'))}</dt><dd>${escape(auth.identityLabel || tr('touchpoint_settings.not_authorized', '未授权'))}</dd></div><div><dt>${escape(tr('touchpoint_settings.access.selected', '已选资源'))}</dt><dd>${Number(resources.selected || 0)}</dd></div><div><dt>${escape(tr('touchpoint_settings.access.synced', '已同步'))}</dt><dd>${Number(resources.ready || 0)}</dd></div></dl>${view.authorized ? `<button class="btn touchpoint-secondary" data-touchpoint-action="authorization.revoke">${escape(tr('touchpoint_settings.access.revoke', '撤销授权'))}</button>` : `<button class="btn touchpoint-secondary" data-touchpoint-action="authorization.begin" ${!view.botConnected ? 'disabled' : ''}>${escape(tr('touchpoint_settings.access.authorize', '授权日历和资料'))}</button>`}</article>`;
  }

  function renderResourcePicker() {
    if (!state.resources || !state.resources.length) return '';
    return `<section class="touchpoint-resource-panel"><div class="touchpoint-section-heading"><div><h3>${escape(tr('touchpoint_settings.resources.title', '选择允许读取的内容'))}</h3><p>${escape(tr('touchpoint_settings.resources.subtitle', '未勾选的资源不会同步，也不会进入 Mate 的认知。'))}</p></div><button class="btn btn-primary" data-touchpoint-action="resources.save">${escape(tr('touchpoint_settings.resources.save', '保存范围'))}</button></div><div class="touchpoint-resource-list">${state.resources.map((resource) => `<label class="touchpoint-resource-row"><input type="checkbox" data-touchpoint-resource="${escape(resource.resourceId)}" ${state.selectedIds.has(resource.resourceId) ? 'checked' : ''}><span class="touchpoint-resource-type">${escape(resource.resourceType)}</span><span><strong>${escape(resource.title)}</strong><small>${escape(resource.accessLabel || '')}</small></span></label>`).join('')}</div></section>`;
  }

  function renderDelivery(view) {
    const briefingTime = state.briefingTime || '08:00';
    const scheduleLabel = view.briefingConfigured
      ? tr('touchpoint_settings.delivery.reschedule', '更新简报时间')
      : tr('touchpoint_settings.delivery.schedule', '设置每日简报');
    const briefingStatus = view.briefingConfigured && view.briefingSchedule
      ? `${tr('touchpoint_settings.delivery.configured', '每日简报已设置：')}${String(view.briefingSchedule.hour).padStart(2, '0')}:${String(view.briefingSchedule.minute).padStart(2, '0')}`
      : '';
    return `<section class="touchpoint-delivery"><div class="touchpoint-section-heading"><div><h3>${escape(tr('touchpoint_settings.delivery.title', '离开电脑后，Mate 如何联系你'))}</h3><p>${escape(tr('touchpoint_settings.delivery.subtitle', '移动触点只承担简报、重要提醒、审批和结果回报。'))}</p></div></div><div class="touchpoint-delivery-grid"><article><span>${iconMarkup('sun', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.briefing', '今日简报'))}</strong><p>${escape(tr('touchpoint_settings.delivery.briefing_detail', '每天汇总日程、截止风险和建议。'))}</p></div></article><article><span>${iconMarkup('bell', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.reminders', '重要提醒'))}</strong><p>${escape(tr('touchpoint_settings.delivery.reminders_detail', '只在冲突、截止或状态变化时打扰。'))}</p></div></article><article><span>${iconMarkup('check-circle', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.approvals', '确认与审批'))}</strong><p>${escape(tr('touchpoint_settings.delivery.approvals_detail', '事实确认和 Agent 审批同步回桌面端。'))}</p></div></article></div>${view.canConfigureDelivery ? `<div class="touchpoint-inline-actions"><button class="btn touchpoint-secondary" data-touchpoint-action="briefing.preview">${escape(tr('touchpoint_settings.delivery.preview', '预览今日简报'))}</button><button class="btn btn-primary" data-touchpoint-action="briefing.test">${escape(tr('touchpoint_settings.delivery.test', '发送测试消息'))}</button><button class="btn touchpoint-secondary" data-touchpoint-action="approval_cards.manage">${iconMarkup('settings', 'touchpoint-button-icon')}${escape(tr('touchpoint_settings.approval_cards.manage', '审批卡片管理'))}</button></div><div class="touchpoint-briefing-row"><label class="touchpoint-briefing-time">${escape(tr('touchpoint_settings.delivery.time_label', '每日投递时间'))}<input type="time" value="${escape(briefingTime)}" data-touchpoint-briefing-time></label><button class="btn btn-primary" data-touchpoint-action="briefing.schedule">${escape(scheduleLabel)}</button>${view.briefingConfigured ? `<button class="btn touchpoint-secondary" data-touchpoint-action="briefing.unschedule">${escape(tr('touchpoint_settings.delivery.unschedule', '取消每日简报'))}</button>` : ''}</div>${briefingStatus ? `<div class="touchpoint-briefing-status">${escape(briefingStatus)}</div>` : ''}` : `<div class="touchpoint-locked-note">${iconMarkup('lock', 'touchpoint-lock-icon')}<span>${escape(tr('touchpoint_settings.delivery.locked', '完成连接、授权和资源同步后即可配置。'))}</span></div>`}${state.preview ? `<div class="touchpoint-preview"><pre>${escape(state.preview.text || '')}</pre></div>` : ''}</section>`;
  }

  function touchpointTemplate() {
    const config = state.touchpointConfig;
    return config && config.templates && config.templates[state.touchpointScene]
      ? config.templates[state.touchpointScene]
      : { title: '', body: '', buttons: {} };
  }

  function currentTouchpointDraft() {
    const template = touchpointTemplate();
    return state.touchpointDrafts[state.touchpointScene] || {
      title: template.title || '',
      body: template.body || '',
      approve: template.buttons?.approve || '',
      reject: template.buttons?.reject || '',
    };
  }

  function previewTemplateText(value) {
    const examples = {
      actor: tr('touchpoint_settings.template.preview.actor', 'Mate'),
      summary: tr('touchpoint_settings.template.preview.summary', '任务已准备完成，需要你确认是否继续执行。'),
      task_title: tr('touchpoint_settings.template.preview.task_title', '确认项目交付方案'),
      impact: tr('touchpoint_settings.template.preview.impact', '确认后将继续执行并同步结果。'),
    };
    return String(value || '').replace(/{{\s*(actor|summary|task_title|impact)\s*}}/g, (_, key) => examples[key] || '');
  }

  function renderTouchpointTemplatePreview(draft) {
    const title = previewTemplateText(draft.title) || tr('touchpoint_settings.template.preview.empty_title', '卡片标题会显示在这里');
    const body = previewTemplateText(draft.body) || tr('touchpoint_settings.template.preview.empty_body', '填写正文后，可在这里查看卡片的大致效果。');
    const approve = draft.approve || tr('touchpoint_settings.template.preview.approve', '同意');
    const reject = draft.reject || tr('touchpoint_settings.template.preview.reject', '拒绝');
    return `<aside class="touchpoint-template-preview" data-touchpoint-template-preview><div class="touchpoint-template-preview-label">${iconMarkup('eye', 'touchpoint-preview-icon')}${escape(tr('touchpoint_settings.template.preview.title', '卡片预览'))}</div><div class="touchpoint-template-card"><span class="touchpoint-template-card-badge">${escape(tr(`touchpoint_settings.template.scene.${state.touchpointScene}`, state.touchpointScene))}</span><h3 data-touchpoint-preview-title>${escape(title)}</h3><p data-touchpoint-preview-body>${escape(body).replace(/\n/g, '<br>')}</p><div class="touchpoint-template-card-note">${escape(tr('touchpoint_settings.template.preview.note', '审批人可在飞书中补充意见'))}</div><div class="touchpoint-template-card-actions"><button type="button" tabindex="-1">${escape(reject)}</button><button type="button" tabindex="-1" class="is-primary">${escape(approve)}</button></div></div></aside>`;
  }

  function renderTouchpointConfig() {
    const config = state.touchpointConfig;
    if (!config) return `<div class="touchpoint-loading"><span class="spinner"></span>${escape(tr('touchpoint_settings.template.loading', '正在加载审批卡片设置…'))}</div>`;
    const draft = currentTouchpointDraft();
    const instances = (config.instances || []).filter((item) => item.platform === 'feishu_lark');
    const option = (value, emptyLabel) => `<option value="">${escape(emptyLabel)}</option>${instances.map((item) => `<option value="${escape(item.id)}" ${item.id === value ? 'selected' : ''}>${escape(item.displayName)}${item.feishuTenantBrand ? ` (${escape(item.feishuTenantBrand)})` : ''}</option>`).join('')}`;
    const scenes = ['task_approval', 'ontology_confirmation', 'daily_briefing'];
    return `<div class="touchpoint-approval-layout"><main class="touchpoint-template-editor"><div class="touchpoint-scene-tabs" role="tablist" aria-label="${escape(tr('touchpoint_settings.template.scene', '场景'))}">${scenes.map((scene) => `<button type="button" role="tab" aria-selected="${scene === state.touchpointScene}" class="touchpoint-scene-tab${scene === state.touchpointScene ? ' is-active' : ''}" data-touchpoint-scene="${scene}">${escape(tr(`touchpoint_settings.template.scene.${scene}`, scene))}</button>`).join('')}</div><div class="touchpoint-template-fields"><label><span>${escape(tr('touchpoint_settings.template.title_field', '标题'))}</span><input data-touchpoint-config-title value="${escape(draft.title)}" placeholder="${escape(tr('touchpoint_settings.template.title_placeholder', '例如：{{actor}} 请求你确认任务'))}"></label><label><span>${escape(tr('touchpoint_settings.template.body_field', '正文'))}</span><textarea data-touchpoint-config-body placeholder="${escape(tr('touchpoint_settings.template.body_placeholder', '说明需要审批的内容，以及批准后的影响。'))}">${escape(draft.body)}</textarea></label><div class="touchpoint-template-button-fields"><label><span>${escape(tr('touchpoint_settings.template.approve_label', '批准按钮'))}</span><input data-touchpoint-config-button="approve" value="${escape(draft.approve)}"></label><label><span>${escape(tr('touchpoint_settings.template.reject_label', '拒绝按钮'))}</span><input data-touchpoint-config-button="reject" value="${escape(draft.reject)}"></label></div></div><details class="touchpoint-template-variables"><summary>${escape(tr('touchpoint_settings.template.variables_summary', '插入动态信息'))}<small>${escape(tr('touchpoint_settings.template.variables_detail', '卡片发送时会自动替换'))}</small></summary><div class="touchpoint-template-variable-list"><code>{{actor}}</code><code>{{summary}}</code><code>{{task_title}}</code><code>{{impact}}</code></div></details><details class="touchpoint-template-advanced"><summary>${iconMarkup('settings', 'touchpoint-advanced-icon')}<span>${escape(tr('touchpoint_settings.template.advanced', '高级设置'))}<small>${escape(tr('touchpoint_settings.template.advanced_detail', '指定由哪个飞书机器人发送'))}</small></span></summary><div class="touchpoint-template-routing"><label>${escape(tr('touchpoint_settings.template.scene_override', '当前场景单独指定'))}<select data-touchpoint-config-route>${option((config.routes || {})[state.touchpointScene], tr('touchpoint_settings.template.follow_default', '跟随默认发送机器人'))}</select></label><p>${escape(tr('touchpoint_settings.template.routing_help', '通常无需修改。只有配置了多个机器人时，才需要为当前场景单独指定。'))}</p></div></details></main>${renderTouchpointTemplatePreview(draft)}</div>`;
  }

  function renderApprovalCardManager() {
    return `<div class="touchpoint-approval-manager"><header class="touchpoint-manager-header"><button type="button" class="btn touchpoint-icon-button" data-touchpoint-action="approval_cards.back" aria-label="${escape(tr('touchpoint_settings.approval_cards.back', '返回触达设置'))}">${iconMarkup('chevron-left', 'touchpoint-back-icon')}</button><div><h1>${escape(tr('touchpoint_settings.approval_cards.title', '审批卡片管理'))}</h1><p>${escape(tr('touchpoint_settings.approval_cards.subtitle', '选择使用场景，修改卡片内容，然后保存或发送测试卡片。'))}</p></div><div class="touchpoint-manager-actions"><button class="btn touchpoint-secondary" data-touchpoint-action="touchpoint.test" ${state.busy ? 'disabled' : ''}>${iconMarkup('send', 'touchpoint-button-icon')}${escape(tr('touchpoint_settings.approval_cards.test', '发送测试卡片'))}</button><button class="btn btn-primary" data-touchpoint-action="touchpoint.config.save" ${state.busy ? 'disabled' : ''}>${escape(tr('touchpoint_settings.template.save', '保存模板'))}</button></div></header>${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(noticeText(state.notice))}</div>` : ''}${renderTouchpointConfig()}<section class="touchpoint-template-help"><div>${iconMarkup('check-circle', 'touchpoint-governance-icon')}</div><div><strong>${escape(tr('touchpoint_settings.approval_cards.help_title', '只需要关注卡片文案'))}</strong><p>${escape(tr('touchpoint_settings.approval_cards.help_detail', '审批结果、按钮动作和安全校验由系统处理；机器人选择仅在多机器人场景下需要调整。'))}</p></div></section></div>`;
  }

  function render() {
    const host = root();
    if (!host) return;
    if (!state.dashboard) {
      // 首次加载/刷新失败：错误提示要可见，不能只剩转圈
      host.innerHTML = `<div class="touchpoint-loading"><span class="spinner"></span>${escape(tr('touchpoint_settings.loading', '正在检查真实连接…'))}</div>${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(noticeText(state.notice))}</div>` : ''}`;
      return;
    }
    if (state.view === 'approvalCards') {
      host.innerHTML = renderApprovalCardManager();
      hydrate(host);
      return;
    }
    const view = model();
    const dashboard = state.dashboard;
    host.innerHTML = `<div class="touchpoint-settings"><header class="touchpoint-hero"><div><h1>${escape(tr('touchpoint_settings.title', '飞书移动触点'))}</h1><p>${escape(tr('touchpoint_settings.subtitle', '桌面端负责完整工作，飞书负责你离开电脑后的提醒、确认和结果回报。'))}</p></div><div class="touchpoint-hero-actions"><span class="touchpoint-status is-${view.status}"><span></span>${escape(statusText(view.status))}</span><button class="btn touchpoint-secondary touchpoint-manage-button" data-touchpoint-action="connection.manage">${escape(tr('touchpoint_settings.connection.manage', '连接管理'))}</button><button class="btn touchpoint-icon-button" data-touchpoint-action="refresh" aria-label="${escape(tr('touchpoint_settings.refresh', '刷新'))}">${iconMarkup('refresh', 'touchpoint-refresh-icon')}</button></div></header>${renderSteps(view)}<section class="touchpoint-next"><div><span>${escape(tr('touchpoint_settings.next_label', '当前下一步'))}</span><h2>${escape(primaryText(view.primaryAction))}</h2><p>${escape(tr(`touchpoint_settings.next_detail.${view.primaryAction}`, ''))}</p></div><button class="btn btn-primary" data-touchpoint-action="${escape(view.primaryAction)}" ${state.busy ? 'disabled' : ''}>${escape(primaryText(view.primaryAction))}</button></section>${view.syncMessage ? `<div class="messaging-notice is-error">${escape(view.syncMessage)}</div>` : ''}<div class="touchpoint-overview">${renderConnectionCard(view)}${renderAccessCard(view)}</div>${renderSetupGuideCard()}${renderResourcePicker()}${renderDelivery(view)}<section class="touchpoint-governance"><div>${iconMarkup('shield', 'touchpoint-governance-icon')}</div><div><strong>${escape(tr('touchpoint_settings.governance.title', '你始终掌握控制权'))}</strong><p>${escape(tr('touchpoint_settings.governance.detail', '默认只读；授权范围可查看、可撤销；所有外部写入和发送都需要明确确认。'))}</p></div></section>${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(noticeText(state.notice))}</div>` : ''}</div>`;
    hydrate(host);
  }

  async function invoke(channel, payload) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') throw new Error(tr('touchpoint_settings.ipc_unavailable', '桌面端连接不可用。'));
    const result = await window.cogseed.invoke(channel, payload || {});
    // IPC 约定：失败返回 { ok: false, error }（不 reject）。不检查会导致
    // 上层把 undefined 当成功数据，页面误判为 loading/卡死。
    if (result && result.ok === false) {
      throw new Error(typeof result.error === 'string' && result.error
        ? result.error
        : tr('touchpoint_settings.invoke_failed', '调用失败：{channel}', { channel }));
    }
    return result;
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    try {
      const [dashboardResult, messagingResult] = await Promise.all([
        invoke('personal_context.dashboard.get', {}),
        invoke('messaging.list', {}),
      ]);
      state.dashboard = dashboardResult.dashboard;
      state.instances = Array.isArray(messagingResult.instances) ? messagingResult.instances : [];
      const configResult = await invoke('touchpoints.config.get', {});
      state.touchpointConfig = { ...(configResult.config || {}), instances: configResult.instances || state.instances };
      // 已配置简报时同步时间输入框，避免与真实配置脱节
      const destination = state.dashboard && state.dashboard.briefing ? state.dashboard.briefing.destination : null;
      if (destination && destination.configured && destination.schedule) {
        state.briefingTime = `${String(destination.schedule.hour).padStart(2, '0')}:${String(destination.schedule.minute).padStart(2, '0')}`;
      }
      state.notice = null;
    } catch (error) {
      // 刷新失败时保留旧 dashboard（若有），避免页面退化为无按钮的 loading 态
      state.notice = { kind: 'error', text: error && error.message ? error.message : String(error) };
    } finally {
      state.busy = false;
      render();
    }
  }

  function setTouchpointView(view) {
    state.view = view;
    const host = shell();
    const overview = overviewView();
    const connections = connectionsView();
    if (host) host.classList.toggle('is-connections-view', view === 'connections');
    if (overview) overview.hidden = view === 'connections';
    if (connections) connections.hidden = view !== 'connections';
    if (connections && view === 'connections') hydrate(connections);
    if (view !== 'connections') render();
  }

  function showOverview() {
    setTouchpointView('overview');
  }

  async function showConnections(options) {
    const opts = options || {};
    setTouchpointView('connections');
    try {
      if (!state.advancedLoaded && typeof window.initMessagingSettings === 'function') {
        await window.initMessagingSettings();
        state.advancedLoaded = true;
      }
      if (opts.startFeishuQr && typeof window.openFeishuConnection === 'function') {
        await window.openFeishuConnection();
        await refresh();
      }
    } catch (error) {
      state.notice = { kind: 'error', text: error && error.message ? error.message : String(error) };
      setTouchpointView('overview');
      render();
    }
  }

  async function fetchSetupGuide() {
    try {
      const result = await invoke('personal_context.setup_guide', { instanceId: state.dashboard?.messaging?.instanceId || undefined });
      return result && result.guide ? result.guide : null;
    } catch (_) {
      return null;
    }
  }

  async function confirmSetupGuideDone() {
    try {
      await invoke('personal_context.setup_guide.confirm', {});
    } catch (_) { /* best effort */ }
    state.setupGuide = null;
    state.notice = { kind: 'success', key: 'touchpoint_settings.setup_guide.confirmed', fallback: '已记录。现在可以发起授权了。' };
    render();
  }

  function renderSetupGuideCard() {
    if (!state.setupGuide) return '';
    const guide = state.setupGuide;
    const consoleUrl = `https://open.feishu.cn/app/${escape(guide.appId || '')}/safe`;
    return `<section class="touchpoint-setup-guide"><div class="touchpoint-section-heading"><div><h3>${escape(tr('touchpoint_settings.setup_guide.title', '还差最后一步：配置回调地址'))}</h3><p>${escape(tr('touchpoint_settings.setup_guide.desc', '飞书要求回调地址与应用后台配置完全一致，不配置则授权时会报错（一次性设置，约 30 秒）：'))}</p></div></div><div class="touchpoint-setup-guide-url"><code>${escape(guide.redirectUri || '')}</code><button class="btn touchpoint-secondary" data-touchpoint-action="setup_guide.copy">${escape(tr('touchpoint_settings.setup_guide.copy', '复制地址'))}</button></div><p class="touchpoint-setup-guide-steps">${escape(tr('touchpoint_settings.setup_guide.steps', '在打开的「安全设置 → 重定向 URL」中粘贴上面的地址 → 点「添加」→ 点「发布」即可。'))}</p><div class="touchpoint-inline-actions"><button class="btn touchpoint-secondary" data-touchpoint-action="setup_guide.open">${escape(tr('touchpoint_settings.setup_guide.open_console', '打开开发者后台'))}</button><button class="btn btn-primary" data-touchpoint-action="setup_guide.done">${escape(tr('touchpoint_settings.setup_guide.done', '我已配置好'))}</button></div></section>`;
  }

  async function runAction(action) {
    if (state.busy) return;
    if (action === 'refresh') return refresh();
    if (action === 'connections.back') { showOverview(); return; }
    if (action === 'approval_cards.back') { state.touchpointDrafts = Object.create(null); showOverview(); return; }
    if (action === 'approval_cards.manage') { state.notice = null; state.touchpointDrafts = Object.create(null); setTouchpointView('approvalCards'); return; }
    if (action === 'connection.manage') { await showConnections(); return; }
    if (action === 'connection.connect') { await showConnections({ startFeishuQr: true }); return; }
    if (action === 'setup_guide.done') { await confirmSetupGuideDone(); return; }
    if (action === 'review.open') { setView('personal-ontology'); return; }
    {
      state.busy = true; render();
      try {
        if (action === 'authorization.begin') {
          // 未确认过回调地址配置时，先拦截并展示引导（飞书不允许程序化
          // 修改重定向 URL，不配置则授权页必报 20029 且用户会被晾在错误页）。
          const guide = await fetchSetupGuide();
          if (guide && guide.credentialReady && !guide.redirectConfigured) {
            state.setupGuide = { appId: guide.appId, redirectUri: guide.redirectUri };
            throw new Error('setup_guide_pending');
          }
          await invoke('personal_context.authorize.begin', { instanceId: state.dashboard?.messaging?.instanceId || undefined });
        }
        else if (action === 'authorization.cancel') await invoke('personal_context.authorize.cancel', {});
        else if (action === 'authorization.revoke') await invoke('personal_context.authorize.revoke', {});
        else if (action === 'resources.discover') {
          const result = await invoke('personal_context.resources.discover', {});
          state.resources = result.resources || [];
          state.selectedIds = new Set(state.resources.map((resource) => resource.resourceId));
        } else if (action === 'resources.save') {
          // state.resources 为 null 表示尚未 discover（如页面刷新后 state 重置）：
          // 禁止直接 save，否则会提交空数组，静默清空用户已有的接入范围。
          if (state.resources === null) throw new Error(tr('touchpoint_settings.resources.discover_first', '请先发现资源，再保存范围。'));
          const resources = state.resources.filter((resource) => state.selectedIds.has(resource.resourceId));
          await invoke('personal_context.resources.select', { resources });
          state.notice = { kind: 'success', key: 'touchpoint_settings.resources.saved', fallback: '读取范围已保存。' };
        } else if (action === 'sync.start') await invoke('personal_context.sync.start', {});
        else if (action === 'briefing.preview') {
          const result = await invoke('personal_context.briefing.preview', {});
          state.preview = result.preview || null;
        } else if (action === 'briefing.test') {
          const result = await invoke('personal_context.briefing.test_delivery', { instanceId: state.touchpointConfig?.routes?.daily_briefing || state.touchpointConfig?.defaultInstanceId || undefined });
          if (!result.result?.ok) throw new Error(result.result?.error || tr('touchpoint_settings.delivery.failed', '测试消息发送失败。'));
          state.notice = { kind: 'success', key: 'touchpoint_settings.delivery.sent', fallback: '测试消息已发送到飞书。' };
        } else if (action === 'touchpoint.test') {
          if (state.view === 'approvalCards') await saveTouchpointConfig();
          const result = await invoke('touchpoints.test_card_delivery', { instanceId: state.touchpointConfig?.routes?.task_approval || state.touchpointConfig?.defaultInstanceId || undefined });
          if (!result.ok) throw new Error(result.error || tr('touchpoint_settings.delivery.test_approval_failed', '测试审批卡片发送失败。'));
          state.notice = { kind: 'success', key: 'touchpoint_settings.delivery.test_approval_sent', fallback: '测试审批卡片已发送到飞书，请在飞书中填写意见并点击按钮。' };
        } else if (action === 'briefing.schedule') {
          const match = /^(\d{2}):(\d{2})$/.exec(state.briefingTime || '');
          if (!match) throw new Error(tr('touchpoint_settings.delivery.time_invalid', '简报时间格式不正确。'));
          const result = await invoke('personal_context.briefing.schedule', { instanceId: state.touchpointConfig?.routes?.daily_briefing || state.touchpointConfig?.defaultInstanceId || undefined, hour: Number(match[1]), minute: Number(match[2]) });
          if (!result.taskId) throw new Error(result.error || tr('touchpoint_settings.delivery.schedule_failed', '简报设置失败。'));
          state.notice = { kind: 'success', key: 'touchpoint_settings.delivery.scheduled', fallback: '每日简报已设置。' };
        } else if (action === 'briefing.unschedule') {
          const result = await invoke('personal_context.briefing.unschedule', {});
          if (!result.removed && result.error) throw new Error(result.error);
          state.notice = { kind: 'success', key: 'touchpoint_settings.delivery.unscheduled', fallback: '每日简报已取消。' };
        } else if (action === 'setup_guide.copy') {
          const guide = state.setupGuide;
          if (guide && guide.redirectUri && typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(guide.redirectUri).catch(() => {});
            state.notice = { kind: 'success', key: 'touchpoint_settings.setup_guide.copied', fallback: '已复制 ✓' };
          }
        } else if (action === 'setup_guide.open') {
          const guide = state.setupGuide;
          if (guide && guide.appId) {
            await invoke('auth.openExternal', { url: `https://open.feishu.cn/app/${guide.appId}/safe` });
          }
        } else if (action === 'touchpoint.config.save') {
          await saveTouchpointConfig();
          state.notice = { kind: 'success', key: 'touchpoint_settings.template.saved', fallback: '触达模板和实例路由已保存。' };
        }
        const dashboardResult = await invoke('personal_context.dashboard.get', {});
        state.dashboard = dashboardResult.dashboard;
      } catch (error) {
        if (error && error.message === 'setup_guide_pending') {
          // 授权前拦截：不显示错误，引导卡已在 render 中展示
          state.notice = null;
        } else {
          // 失败保留旧 dashboard：报错可见，页面不退化回 loading
          state.notice = { kind: 'error', text: error && error.message ? error.message : String(error) };
        }
      } finally {
        state.busy = false; render();
      }
    }
  }

  async function saveTouchpointConfig() {
    const host = root();
    const scene = state.touchpointScene;
    const draft = currentTouchpointDraft();
    const templates = { ...(state.touchpointConfig?.templates || {}), [scene]: { title: draft.title, body: draft.body, buttons: { approve: draft.approve, reject: draft.reject } } };
    const routeInput = host.querySelector('[data-touchpoint-config-route]');
    const routes = { ...(state.touchpointConfig?.routes || {}), [scene]: routeInput ? routeInput.value || null : (state.touchpointConfig?.routes || {})[scene] || null };
    const saved = await invoke('touchpoints.config.save', { config: { version: 1, defaultInstanceId: state.touchpointConfig?.defaultInstanceId || null, templates, routes } });
    state.touchpointConfig = { ...(saved.config || {}), instances: state.instances };
    delete state.touchpointDrafts[state.touchpointScene];
  }

  function bind() {
    if (state.bound) return;
    const host = root();
    if (!host) return;
    // 事件委托挂到 shell：返回按钮在连接管理视图里，不在概览 root 内。
    const actionHost = shell() || host;
    state.bound = true;
    // 全局错误兜底：任何未捕获异常都显示在页面上并恢复 busy，
    // 避免"点按钮后无声卡死"。
    const onFatal = (error) => {
      const message = error && error.message ? error.message : String(error);
      state.busy = false;
      state.notice = {
        kind: 'error',
        key: 'touchpoint_settings.render_failed',
        fallback: '触点界面异常：{message}',
        vars: { message },
      };
      render();
    };
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('error', (event) => { onFatal(event && event.error ? event.error : new Error(event && event.message ? event.message : 'unknown render error')); });
      window.addEventListener('unhandledrejection', (event) => { onFatal(event && event.reason ? event.reason : new Error('unknown rejection')); });
    }
    actionHost.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('[data-touchpoint-action]') : null;
      if (button) void runAction(button.dataset.touchpointAction);
    });
    host.addEventListener('change', (event) => {
      const input = event.target;
      if (input && input.dataset && input.dataset.touchpointBriefingTime) {
        state.briefingTime = input.value || '08:00';
        return;
      }
      const id = input && input.dataset ? input.dataset.touchpointResource : '';
      if (!id) return;
      if (input.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    });
    host.addEventListener('click', (event) => {
      const sceneButton = event.target && event.target.closest ? event.target.closest('[data-touchpoint-scene]') : null;
      if (!sceneButton) return;
      state.touchpointScene = sceneButton.dataset.touchpointScene || 'task_approval';
      delete state.touchpointDrafts[state.touchpointScene];
      render();
    });
    host.addEventListener('input', (event) => {
      const input = event.target;
      if (!input || !input.dataset) return;
      const draft = currentTouchpointDraft();
      if (input.dataset.touchpointConfigTitle !== undefined) draft.title = input.value || '';
      else if (input.dataset.touchpointConfigBody !== undefined) draft.body = input.value || '';
      else if (input.dataset.touchpointConfigButton === 'approve') draft.approve = input.value || '';
      else if (input.dataset.touchpointConfigButton === 'reject') draft.reject = input.value || '';
      else return;
      state.touchpointDrafts[state.touchpointScene] = draft;
      const preview = host.querySelector('[data-touchpoint-template-preview]');
      if (preview) {
        const replacement = document.createElement('div');
        replacement.innerHTML = renderTouchpointTemplatePreview(draft);
        preview.replaceWith(replacement.firstElementChild);
        hydrate(host);
      }
    });
    window.addEventListener('i18n-change', render);
    if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
      window.cogseed.onPushEvent('messaging:instance-status', () => { void refresh(); });
      // OAuth 完成/取消/撤销后主动刷新，避免用户扫完码页面还停在旧状态
      window.cogseed.onPushEvent('personal-context:authorization', () => { void refresh(); });
    }
  }

  window.initTouchpointSettings = async function initTouchpointSettings() {
    bind();
    await refresh();
  };
}());
