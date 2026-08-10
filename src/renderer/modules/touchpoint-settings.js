(function touchpointSettingsModule() {
  'use strict';

  const state = {
    dashboard: null,
    instances: [],
    resources: [],
    selectedIds: new Set(),
    preview: null,
    busy: false,
    notice: null,
    bound: false,
    advancedLoaded: false,
  };

  function tr(key, fallback, vars) {
    try { return typeof t === 'function' ? t(key, vars) : fallback; } catch (_) { return fallback; }
  }
  function root() { return document.getElementById('touchpoint-settings-page'); }
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
    if (!state.resources.length) return '';
    return `<section class="touchpoint-resource-panel"><div class="touchpoint-section-heading"><div><h3>${escape(tr('touchpoint_settings.resources.title', '选择允许读取的内容'))}</h3><p>${escape(tr('touchpoint_settings.resources.subtitle', '未勾选的资源不会同步，也不会进入 Mate 的认知。'))}</p></div><button class="btn btn-primary" data-touchpoint-action="resources.save">${escape(tr('touchpoint_settings.resources.save', '保存范围'))}</button></div><div class="touchpoint-resource-list">${state.resources.map((resource) => `<label class="touchpoint-resource-row"><input type="checkbox" data-touchpoint-resource="${escape(resource.resourceId)}" ${state.selectedIds.has(resource.resourceId) ? 'checked' : ''}><span class="touchpoint-resource-type">${escape(resource.resourceType)}</span><span><strong>${escape(resource.title)}</strong><small>${escape(resource.accessLabel || '')}</small></span></label>`).join('')}</div></section>`;
  }

  function renderDelivery(view) {
    return `<section class="touchpoint-delivery"><div class="touchpoint-section-heading"><div><h3>${escape(tr('touchpoint_settings.delivery.title', '离开电脑后，Mate 如何联系你'))}</h3><p>${escape(tr('touchpoint_settings.delivery.subtitle', '移动触点只承担简报、重要提醒、审批和结果回报。'))}</p></div></div><div class="touchpoint-delivery-grid"><article><span>${iconMarkup('sun', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.briefing', '今日简报'))}</strong><p>${escape(tr('touchpoint_settings.delivery.briefing_detail', '每天汇总日程、截止风险和建议。'))}</p></div></article><article><span>${iconMarkup('bell', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.reminders', '重要提醒'))}</strong><p>${escape(tr('touchpoint_settings.delivery.reminders_detail', '只在冲突、截止或状态变化时打扰。'))}</p></div></article><article><span>${iconMarkup('check-circle', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.approvals', '确认与审批'))}</strong><p>${escape(tr('touchpoint_settings.delivery.approvals_detail', '事实确认和 Agent 审批同步回桌面端。'))}</p></div></article></div>${view.canConfigureDelivery ? `<div class="touchpoint-inline-actions"><button class="btn touchpoint-secondary" data-touchpoint-action="briefing.preview">${escape(tr('touchpoint_settings.delivery.preview', '预览今日简报'))}</button><button class="btn btn-primary" data-touchpoint-action="briefing.test">${escape(tr('touchpoint_settings.delivery.test', '发送测试消息'))}</button><button class="btn touchpoint-secondary" data-touchpoint-action="briefing.schedule">${escape(tr('touchpoint_settings.delivery.schedule', '设置每日 08:00'))}</button></div>` : `<div class="touchpoint-locked-note">${iconMarkup('lock', 'touchpoint-lock-icon')}<span>${escape(tr('touchpoint_settings.delivery.locked', '完成连接、授权和资源同步后即可配置。'))}</span></div>`}${state.preview ? `<div class="touchpoint-preview"><pre>${escape(state.preview.text || '')}</pre></div>` : ''}</section>`;
  }

  function render() {
    const host = root();
    if (!host) return;
    if (!state.dashboard) {
      host.innerHTML = `<div class="touchpoint-loading"><span class="spinner"></span>${escape(tr('touchpoint_settings.loading', '正在检查真实连接…'))}</div>`;
      return;
    }
    const view = model();
    const dashboard = state.dashboard;
    host.innerHTML = `<div class="touchpoint-settings"><header class="touchpoint-hero"><div><h1>${escape(tr('touchpoint_settings.title', '飞书移动触点'))}</h1><p>${escape(tr('touchpoint_settings.subtitle', '桌面端负责完整工作，飞书负责你离开电脑后的提醒、确认和结果回报。'))}</p></div><div class="touchpoint-hero-actions"><span class="touchpoint-status is-${view.status}"><span></span>${escape(statusText(view.status))}</span><button class="btn touchpoint-icon-button" data-touchpoint-action="refresh" aria-label="${escape(tr('touchpoint_settings.refresh', '刷新'))}">${iconMarkup('refresh', 'touchpoint-refresh-icon')}</button></div></header>${renderSteps(view)}<section class="touchpoint-next"><div><span>${escape(tr('touchpoint_settings.next_label', '当前下一步'))}</span><h2>${escape(primaryText(view.primaryAction))}</h2><p>${escape(tr(`touchpoint_settings.next_detail.${view.primaryAction}`, ''))}</p></div><button class="btn btn-primary" data-touchpoint-action="${escape(view.primaryAction)}" ${state.busy ? 'disabled' : ''}>${escape(primaryText(view.primaryAction))}</button></section><div class="touchpoint-overview">${renderConnectionCard(view)}${renderAccessCard(view)}</div>${renderResourcePicker()}${renderDelivery(view)}<section class="touchpoint-governance"><div>${iconMarkup('shield', 'touchpoint-governance-icon')}</div><div><strong>${escape(tr('touchpoint_settings.governance.title', '你始终掌握控制权'))}</strong><p>${escape(tr('touchpoint_settings.governance.detail', '默认只读；授权范围可查看、可撤销；所有外部写入和发送都需要明确确认。'))}</p></div></section>${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(state.notice.text)}</div>` : ''}</div>`;
    hydrate(host);
  }

  async function invoke(channel, payload) {
    if (!window.orkas || typeof window.orkas.invoke !== 'function') throw new Error(tr('touchpoint_settings.ipc_unavailable', '桌面端连接不可用。'));
    return window.orkas.invoke(channel, payload || {});
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
      state.notice = null;
    } catch (error) {
      state.notice = { kind: 'error', text: error && error.message ? error.message : String(error) };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function runAction(action) {
    if (state.busy) return;
    if (action === 'refresh') return refresh();
    if (action === 'connection.manage') {
      const details = document.getElementById('touchpoint-advanced');
      if (details) details.open = true;
      if (!state.advancedLoaded && window.initMessagingSettings) {
        state.advancedLoaded = true;
        await window.initMessagingSettings();
      }
      return;
    }
    if (action === 'review.open') { setView('personal-ontology'); return; }
    state.busy = true; render();
    try {
      if (action === 'authorization.begin') await invoke('personal_context.authorize.begin', { instanceId: state.dashboard?.messaging?.instanceId || undefined });
      else if (action === 'authorization.revoke') await invoke('personal_context.authorize.revoke', {});
      else if (action === 'resources.discover') {
        const result = await invoke('personal_context.resources.discover', {});
        state.resources = result.resources || [];
        state.selectedIds = new Set(state.resources.map((resource) => resource.resourceId));
      } else if (action === 'resources.save') {
        const resources = state.resources.filter((resource) => state.selectedIds.has(resource.resourceId));
        await invoke('personal_context.resources.select', { resources });
      } else if (action === 'sync.start') await invoke('personal_context.sync.start', {});
      else if (action === 'briefing.preview') {
        const result = await invoke('personal_context.briefing.preview', {});
        state.preview = result.preview || null;
      } else if (action === 'briefing.test') {
        const result = await invoke('personal_context.briefing.test_delivery', {});
        if (!result.result?.ok) throw new Error(result.result?.error || tr('touchpoint_settings.delivery.failed', '测试消息发送失败。'));
        state.notice = { kind: 'success', text: tr('touchpoint_settings.delivery.sent', '测试消息已发送到飞书。') };
      } else if (action === 'briefing.schedule') {
        const result = await invoke('personal_context.briefing.schedule', { hour: 8, minute: 0 });
        if (!result.taskId) throw new Error(result.error || tr('touchpoint_settings.delivery.schedule_failed', '简报设置失败。'));
        state.notice = { kind: 'success', text: tr('touchpoint_settings.delivery.scheduled', '每日简报已设置。') };
      }
      const dashboardResult = await invoke('personal_context.dashboard.get', {});
      state.dashboard = dashboardResult.dashboard;
    } catch (error) {
      state.notice = { kind: 'error', text: error && error.message ? error.message : String(error) };
    } finally {
      state.busy = false; render();
    }
  }

  function bind() {
    if (state.bound) return;
    const host = root();
    if (!host) return;
    state.bound = true;
    host.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('[data-touchpoint-action]') : null;
      if (button) void runAction(button.dataset.touchpointAction);
    });
    host.addEventListener('change', (event) => {
      const input = event.target;
      const id = input && input.dataset ? input.dataset.touchpointResource : '';
      if (!id) return;
      if (input.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    });
    window.addEventListener('i18n-change', render);
  }

  window.initTouchpointSettings = async function initTouchpointSettings() {
    bind();
    await refresh();
  };
}());
