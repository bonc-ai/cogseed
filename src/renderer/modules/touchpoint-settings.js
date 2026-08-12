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

  // ── 触点页四区块渲染（链路状态图 / 待办卡 / 简报 / 高级设置手风琴）──────
  function renderChainView(view) {
    const order = [
      ['connection', view.chain.connection],
      ['authorization', view.chain.authorization],
      ['delivery', view.chain.delivery],
    ];
    return `<section class="touchpoint-chain">${order.map(([step, node]) => `
      <div class="touchpoint-chain-node is-${escape(node.state)}${node.inProgress ? ' is-progress' : ''}">
        <span class="touchpoint-chain-dot"></span>
        <div class="touchpoint-chain-label"><strong>${escape(tr(`touchpoint_settings.chain.${step}.${node.inProgress ? 'ok' : node.state}`, ''))}</strong>${node.inProgress ? `<small>${escape(tr('touchpoint_settings.chain.in_progress', ''))}</small>` : ''}</div>
      </div>`).join('<span class="touchpoint-chain-arrow">→</span>')}</section>`;
  }

  function renderIssueCards(view) {
    if (!view.issues || view.issues.length === 0) return '';
    return `<section class="touchpoint-issues">${view.issues.map((issue) => `
      <article class="touchpoint-issue-card is-${escape(issue.severity)}">
        <span class="touchpoint-issue-glyph">${iconMarkup(issue.severity === 'error' ? 'x-circle' : 'clock', 'touchpoint-issue-icon')}</span>
        <div class="touchpoint-issue-body">
          <h3>${escape(tr(issue.titleKey, issue.titleKey))}</h3>
          <p>${escape(tr(issue.detailKey, issue.detailKey))}</p>
        </div>
        ${issue.actionId ? `<button class="btn btn-primary touchpoint-issue-action" data-touchpoint-action="${escape(issue.actionId)}" ${state.busy ? 'disabled' : ''}>${escape(tr(issue.actionLabelKey, issue.actionLabelKey))}</button>` : ''}
      </article>`).join('')}</section>`;
  }

  function renderAdvancedSettings(view) {
    return `<section class="touchpoint-advanced">
      <details class="touchpoint-accordion">
        <summary><span>${escape(tr('touchpoint_settings.advanced.title', '高级设置'))}</span><small>${escape(tr('touchpoint_settings.advanced.detail', ''))}</small></summary>
        <div class="touchpoint-advanced-body">
          <div class="touchpoint-advanced-row"><span>${escape(tr('touchpoint_settings.advanced.account', '你的飞书账号'))}</span><strong>${escape(view.authorizedLabel)}</strong></div>
          <div class="touchpoint-advanced-row"><span>${escape(tr('touchpoint_settings.advanced.style', '消息样式'))}</span><button class="btn touchpoint-secondary" data-touchpoint-action="advanced.response">${escape(tr('touchpoint_settings.advanced.style_edit', '修改'))}</button></div>
          <div class="touchpoint-advanced-row"><span>${escape(tr('touchpoint_settings.advanced.workspace', '工作区范围'))}</span><button class="btn touchpoint-secondary" data-touchpoint-action="advanced.workspace">${escape(tr('touchpoint_settings.advanced.workspace_edit', '修改'))}</button></div>
          <div class="touchpoint-advanced-actions">
            <button class="btn touchpoint-secondary" data-touchpoint-action="authorization.revoke">${escape(tr('touchpoint_settings.advanced.stop_reading', '停止读取数据'))}</button>
            <button class="btn btn-danger" data-touchpoint-action="disconnect">${escape(tr('touchpoint_settings.disconnect.title', '断开连接'))}</button>
          </div>
        </div>
      </details>
    </section>`;
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
    host.innerHTML = `<div class="touchpoint-settings"><header class="touchpoint-hero"><div><h1>${escape(tr('touchpoint_settings.title', '飞书移动触点'))}</h1><p>${escape(tr('touchpoint_settings.subtitle', ''))}</p></div><div class="touchpoint-hero-actions"><span class="touchpoint-status is-${escape(view.overallStatus)}"><span></span>${escape(tr(`touchpoint_settings.status.${view.overallStatus}`, view.overallStatus))}</span><button class="btn touchpoint-icon-button" data-touchpoint-action="refresh" aria-label="${escape(tr('touchpoint_settings.refresh', '刷新'))}">${iconMarkup('refresh', 'touchpoint-refresh-icon')}</button></div></header>${renderChainView(view)}${renderIssueCards(view)}${view.ready ? renderDelivery(view) : ''}${renderAdvancedSettings(view)}${renderSetupGuideCard()}${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(state.notice.text)}</div>` : ''}</div>`;
    hydrate(host);
  }

  async function invoke(channel, payload) {
    if (!window.orkas || typeof window.orkas.invoke !== 'function') throw new Error(tr('touchpoint_settings.ipc_unavailable', '桌面端连接不可用。'));
    const result = await window.orkas.invoke(channel, payload || {});
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
        else if (action === 'authorization.reauth') {
          // 重新授权 = 重新走授权流程（凭据未变，回调地址若已配置过不再拦截）
          await invoke('personal_context.authorize.begin', { instanceId: state.dashboard?.messaging?.instanceId || undefined });
        } else if (action === 'advanced.response' || action === 'advanced.workspace') {
          await showConnections({ startFeishuQr: false });
        } else if (action === 'disconnect') {
          const confirmed = typeof window.confirm === 'function'
            && window.confirm(tr('touchpoint_settings.disconnect.confirm', '确定要断开飞书连接吗？'));
          if (!confirmed) return;
          // 先撤数据授权，再删实例（revoke 依赖凭据，实例删除后凭据不可用）
          await invoke('personal_context.authorize.revoke', {}).catch(() => undefined);
          const instanceId = state.dashboard?.messaging?.instanceId;
          if (instanceId) {
            const result = await invoke('messaging.delete', { instanceId });
            if (result && result.deleted === false) throw new Error(result.error || '断开连接失败');
          }
          state.notice = { kind: 'success', text: tr('touchpoint_settings.disconnect.done', '已断开飞书连接。') };
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

  // 动作分发表：model 产出的 actionId 必须在此注册（Task 6 全量映射测试强制）。
  const ACTION_HANDLERS = Object.freeze({
    refresh: 'refresh',
    'connections.back': 'connections.back',
    'connection.manage': 'connection.manage',
    'connection.connect': 'connection.connect',
    'authorization.begin': 'authorization.begin',
    'authorization.reauth': 'authorization.reauth',
    'authorization.cancel': 'authorization.cancel',
    'authorization.revoke': 'authorization.revoke',
    'resources.discover': 'resources.discover',
    'resources.save': 'resources.save',
    'sync.start': 'sync.start',
    'briefing.preview': 'briefing.preview',
    'briefing.test': 'briefing.test',
    'briefing.schedule': 'briefing.schedule',
    'briefing.unschedule': 'briefing.unschedule',
    'setup_guide.copy': 'setup_guide.copy',
    'setup_guide.open': 'setup_guide.open',
    'setup_guide.done': 'setup_guide.done',
    'advanced.response': 'advanced.response',
    'advanced.workspace': 'advanced.workspace',
    'disconnect': 'disconnect',
    'review.open': 'review.open',
  });

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
    if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
      window.orkas.onPushEvent('messaging:instance-status', () => { void refresh(); });
      // OAuth 完成/取消/撤销后主动刷新，避免用户扫完码页面还停在旧状态
      window.orkas.onPushEvent('personal-context:authorization', () => { void refresh(); });
    }
  }

  window.initTouchpointSettings = async function initTouchpointSettings() {
    bind();
    await refresh();
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { ACTION_HANDLERS };
}());
