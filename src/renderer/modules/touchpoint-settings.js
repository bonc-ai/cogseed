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
  };

  function tr(key, fallback, vars) {
    try { return typeof t === 'function' ? t(key, vars) : fallback; } catch (_) { return fallback; }
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
    return `<section class="touchpoint-delivery"><div class="touchpoint-section-heading"><div><h3>${escape(tr('touchpoint_settings.delivery.title', '离开电脑后，Mate 如何联系你'))}</h3><p>${escape(tr('touchpoint_settings.delivery.subtitle', '移动触点只承担简报、重要提醒、审批和结果回报。'))}</p></div></div><div class="touchpoint-delivery-grid"><article><span>${iconMarkup('sun', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.briefing', '今日简报'))}</strong><p>${escape(tr('touchpoint_settings.delivery.briefing_detail', '每天汇总日程、截止风险和建议。'))}</p></div></article><article><span>${iconMarkup('bell', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.reminders', '重要提醒'))}</strong><p>${escape(tr('touchpoint_settings.delivery.reminders_detail', '只在冲突、截止或状态变化时打扰。'))}</p></div></article><article><span>${iconMarkup('check-circle', 'touchpoint-delivery-icon')}</span><div><strong>${escape(tr('touchpoint_settings.delivery.approvals', '确认与审批'))}</strong><p>${escape(tr('touchpoint_settings.delivery.approvals_detail', '事实确认和 Agent 审批同步回桌面端。'))}</p></div></article></div>${view.canConfigureDelivery ? `<div class="touchpoint-inline-actions"><button class="btn touchpoint-secondary" data-touchpoint-action="briefing.preview">${escape(tr('touchpoint_settings.delivery.preview', '预览今日简报'))}</button><button class="btn btn-primary" data-touchpoint-action="briefing.test">${escape(tr('touchpoint_settings.delivery.test', '发送测试消息'))}</button></div><div class="touchpoint-briefing-row"><label class="touchpoint-briefing-time">${escape(tr('touchpoint_settings.delivery.time_label', '每日投递时间'))}<input type="time" value="${escape(briefingTime)}" data-touchpoint-briefing-time></label><button class="btn btn-primary" data-touchpoint-action="briefing.schedule">${escape(scheduleLabel)}</button>${view.briefingConfigured ? `<button class="btn touchpoint-secondary" data-touchpoint-action="briefing.unschedule">${escape(tr('touchpoint_settings.delivery.unschedule', '取消每日简报'))}</button>` : ''}</div>${briefingStatus ? `<div class="touchpoint-briefing-status">${escape(briefingStatus)}</div>` : ''}` : `<div class="touchpoint-locked-note">${iconMarkup('lock', 'touchpoint-lock-icon')}<span>${escape(tr('touchpoint_settings.delivery.locked', '完成连接、授权和资源同步后即可配置。'))}</span></div>`}${state.preview ? `<div class="touchpoint-preview"><pre>${escape(state.preview.text || '')}</pre></div>` : ''}</section>`;
  }

  function render() {
    const host = root();
    if (!host) return;
    if (!state.dashboard) {
      // 首次加载/刷新失败：错误提示要可见，不能只剩转圈
      host.innerHTML = `<div class="touchpoint-loading"><span class="spinner"></span>${escape(tr('touchpoint_settings.loading', '正在检查真实连接…'))}</div>${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(state.notice.text)}</div>` : ''}`;
      return;
    }
    const view = model();
    const dashboard = state.dashboard;
    host.innerHTML = `<div class="touchpoint-settings"><header class="touchpoint-hero"><div><h1>${escape(tr('touchpoint_settings.title', '飞书移动触点'))}</h1><p>${escape(tr('touchpoint_settings.subtitle', '桌面端负责完整工作，飞书负责你离开电脑后的提醒、确认和结果回报。'))}</p></div><div class="touchpoint-hero-actions"><span class="touchpoint-status is-${view.status}"><span></span>${escape(statusText(view.status))}</span><button class="btn touchpoint-secondary touchpoint-manage-button" data-touchpoint-action="connection.manage">${escape(tr('touchpoint_settings.connection.manage', '连接管理'))}</button><button class="btn touchpoint-icon-button" data-touchpoint-action="refresh" aria-label="${escape(tr('touchpoint_settings.refresh', '刷新'))}">${iconMarkup('refresh', 'touchpoint-refresh-icon')}</button></div></header>${renderSteps(view)}<section class="touchpoint-next"><div><span>${escape(tr('touchpoint_settings.next_label', '当前下一步'))}</span><h2>${escape(primaryText(view.primaryAction))}</h2><p>${escape(tr(`touchpoint_settings.next_detail.${view.primaryAction}`, ''))}</p></div><button class="btn btn-primary" data-touchpoint-action="${escape(view.primaryAction)}" ${state.busy ? 'disabled' : ''}>${escape(primaryText(view.primaryAction))}</button></section>${view.syncMessage ? `<div class="messaging-notice is-error">${escape(view.syncMessage)}</div>` : ''}<div class="touchpoint-overview">${renderConnectionCard(view)}${renderAccessCard(view)}</div>${renderSetupGuideCard()}${renderResourcePicker()}${renderDelivery(view)}<section class="touchpoint-governance"><div>${iconMarkup('shield', 'touchpoint-governance-icon')}</div><div><strong>${escape(tr('touchpoint_settings.governance.title', '你始终掌握控制权'))}</strong><p>${escape(tr('touchpoint_settings.governance.detail', '默认只读；授权范围可查看、可撤销；所有外部写入和发送都需要明确确认。'))}</p></div></section>${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(state.notice.text)}</div>` : ''}</div>`;
    hydrate(host);
  }

  async function invoke(channel, payload) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') throw new Error(tr('touchpoint_settings.ipc_unavailable', '桌面端连接不可用。'));
    const result = await window.cogseed.invoke(channel, payload || {});
    // IPC 约定：失败返回 { ok: false, error }（不 reject）。不检查会导致
    // 上层把 undefined 当成功数据，页面误判为 loading/卡死。
    if (result && result.ok === false) {
      throw new Error(typeof result.error === 'string' && result.error ? result.error : `调用失败：${channel}`);
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
    if (overview) overview.hidden = view !== 'overview';
    if (connections) connections.hidden = view !== 'connections';
    if (connections && view === 'connections') hydrate(connections);
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
    state.notice = { kind: 'success', text: tr('touchpoint_settings.setup_guide.confirmed', '已记录。现在可以发起授权了。') };
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
          state.notice = { kind: 'success', text: tr('touchpoint_settings.resources.saved', '读取范围已保存。') };
        } else if (action === 'sync.start') await invoke('personal_context.sync.start', {});
        else if (action === 'briefing.preview') {
          const result = await invoke('personal_context.briefing.preview', {});
          state.preview = result.preview || null;
        } else if (action === 'briefing.test') {
          const result = await invoke('personal_context.briefing.test_delivery', {});
          if (!result.result?.ok) throw new Error(result.result?.error || tr('touchpoint_settings.delivery.failed', '测试消息发送失败。'));
          state.notice = { kind: 'success', text: tr('touchpoint_settings.delivery.sent', '测试消息已发送到飞书。') };
        } else if (action === 'briefing.schedule') {
          const match = /^(\d{2}):(\d{2})$/.exec(state.briefingTime || '');
          if (!match) throw new Error(tr('touchpoint_settings.delivery.time_invalid', '简报时间格式不正确。'));
          const result = await invoke('personal_context.briefing.schedule', { hour: Number(match[1]), minute: Number(match[2]) });
          if (!result.taskId) throw new Error(result.error || tr('touchpoint_settings.delivery.schedule_failed', '简报设置失败。'));
          state.notice = { kind: 'success', text: tr('touchpoint_settings.delivery.scheduled', '每日简报已设置。') };
        } else if (action === 'briefing.unschedule') {
          const result = await invoke('personal_context.briefing.unschedule', {});
          if (!result.removed && result.error) throw new Error(result.error);
          state.notice = { kind: 'success', text: tr('touchpoint_settings.delivery.unscheduled', '每日简报已取消。') };
        } else if (action === 'setup_guide.copy') {
          const guide = state.setupGuide;
          if (guide && guide.redirectUri && typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(guide.redirectUri).catch(() => {});
            state.notice = { kind: 'success', text: tr('touchpoint_settings.setup_guide.copied', '已复制 ✓') };
          }
        } else if (action === 'setup_guide.open') {
          const guide = state.setupGuide;
          if (guide && guide.appId) {
            await invoke('auth.openExternal', { url: `https://open.feishu.cn/app/${guide.appId}/safe` });
          }
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
      state.notice = { kind: 'error', text: `触点界面异常：${message}` };
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
