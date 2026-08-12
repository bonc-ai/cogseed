// Personal Context Center controller and state-to-view projection.
(function () {
  'use strict';

  const state = {
    dashboard: null,
    resources: [],
    selectedIds: new Set(),
    reviewItems: [],
    preview: null,
    busy: false,
    notice: null,
    bound: false,
  };

  function authorizationKind(dashboard) {
    return dashboard && dashboard.authorization && typeof dashboard.authorization.kind === 'string'
      ? dashboard.authorization.kind
      : 'disconnected';
  }

  function primaryActionFor(dashboard) {
    if (dashboard && dashboard.mode === 'demo') return 'sync.start';
    const kind = authorizationKind(dashboard);
    if (kind === 'authorizing') return 'authorize.cancel';
    if (kind === 'connected') return 'resources.discover';
    return 'authorize.begin';
  }

  function viewModel(dashboard) {
    const source = dashboard && typeof dashboard === 'object' ? dashboard : {};
    const mode = source.mode === 'demo' ? 'demo' : 'real';
    const resources = source.resources && typeof source.resources === 'object' ? source.resources : {};
    const review = source.review && typeof source.review === 'object' ? source.review : {};
    const briefing = source.briefing && typeof source.briefing === 'object' ? source.briefing : {};
    return Object.freeze({
      mode,
      badge: mode === 'demo' ? '演示模式' : '真实连接',
      primaryAction: primaryActionFor(source),
      authorizationKind: authorizationKind(source),
      resourceCount: Number(resources.discovered || 0),
      selectedCount: Number(resources.selected || 0),
      pendingCount: Number(review.pending || 0),
      briefingReady: briefing.state === 'preview_ready' || briefing.state === 'delivered' || briefing.state === 'delivery_failed',
    });
  }

  function page() { return document.getElementById('personal-context-page'); }

  function invoke(channel, payload) {
    if (!window.orkas || typeof window.orkas.invoke !== 'function') return Promise.reject(new Error('IPC unavailable'));
    return window.orkas.invoke(channel, payload || {});
  }

  function render() {
    const host = page();
    if (!host || !window.PersonalContextCenterView) return;
    host.replaceChildren(window.PersonalContextCenterView.render(state));
  }

  async function refresh() {
    const result = await invoke('personal_context.dashboard.get', {});
    state.dashboard = result && result.dashboard ? result.dashboard : null;
    render();
  }

  async function withBusy(work) {
    if (state.busy) return;
    state.busy = true;
    state.notice = null;
    render();
    try { await work(); }
    catch (error) {
      state.notice = { kind: 'error', text: error && error.message ? error.message : String(error || '') };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function action(actionName, dataset) {
    await withBusy(async () => {
      if (actionName === 'mode.demo.start') {
        const result = await invoke('personal_context.mode.set', { mode: 'demo' });
        state.dashboard = result.dashboard;
        const discovered = await invoke('personal_context.resources.discover', {});
        state.resources = discovered.resources || [];
        state.selectedIds = new Set(state.resources.map((resource) => resource.resourceId));
        return;
      }
      if (actionName === 'mode.real.select') {
        const result = await invoke('personal_context.mode.set', { mode: 'real' });
        state.dashboard = result.dashboard;
        state.resources = [];
        state.selectedIds = new Set();
        state.reviewItems = [];
        state.preview = null;
        return;
      }
      const channelByAction = {
        'authorize.begin': 'personal_context.authorize.begin',
        'authorize.cancel': 'personal_context.authorize.cancel',
        'authorize.revoke': 'personal_context.authorize.revoke',
        'sync.start': 'personal_context.sync.start',
      };
      if (channelByAction[actionName]) {
        const result = await invoke(channelByAction[actionName], {});
        state.dashboard = result.dashboard;
        return;
      }
      if (actionName === 'resources.discover') {
        const result = await invoke('personal_context.resources.discover', {});
        state.dashboard = result.dashboard;
        state.resources = result.resources || [];
        state.selectedIds = new Set(state.resources.filter((resource) => resource.capability ? resource.capability.canGenerateCandidates !== false : true).map((resource) => resource.resourceId));
        return;
      }
      if (actionName === 'resources.save') {
        const resources = state.resources.filter((resource) => state.selectedIds.has(resource.resourceId));
        const result = await invoke('personal_context.resources.select', { resources });
        state.dashboard = result.dashboard;
        state.notice = { kind: 'info', text: typeof t === 'function' ? t('personal_context_center.scope_saved') : '接入范围已保存' };
        return;
      }
      if (actionName === 'review.open') {
        const result = await invoke('personal_context.review.list', {});
        state.dashboard = result.dashboard;
        state.reviewItems = result.items || [];
        return;
      }
      if (actionName === 'review.approve' || actionName === 'review.reject') {
        const result = await invoke(actionName === 'review.approve' ? 'personal_context.review.approve' : 'personal_context.review.reject', { candidateId: dataset.candidateId });
        state.dashboard = result.dashboard;
        const review = await invoke('personal_context.review.list', {});
        state.reviewItems = review.items || [];
        return;
      }
      if (actionName === 'briefing.preview') {
        const result = await invoke('personal_context.briefing.preview', {});
        state.dashboard = result.dashboard;
        state.preview = result.preview;
        return;
      }
      if (actionName === 'briefing.test_delivery') {
        const result = await invoke('personal_context.briefing.test_delivery', {});
        state.dashboard = result.dashboard;
        state.notice = result.result && result.result.ok
          ? { kind: 'info', text: typeof t === 'function' ? t('personal_context_center.briefing_delivery_ok') : '简报已投递' }
          : { kind: 'error', text: result.result && result.result.error ? result.result.error : '简报投递失败' };
        return;
      }
      if (actionName === 'briefing.schedule') {
        const result = await invoke('personal_context.briefing.schedule', { hour: 8, minute: 0 });
        state.dashboard = result.dashboard;
        state.notice = result.taskId
          ? { kind: 'info', text: typeof t === 'function' ? t('personal_context_center.briefing_schedule_ok') : '每日简报已设置' }
          : { kind: 'error', text: result.error || '每日简报设置失败' };
      }
    });
  }

  function bind() {
    if (state.bound) return;
    const host = page();
    if (!host) return;
    state.bound = true;
    host.addEventListener('change', (event) => {
      const target = event.target;
      const id = target && target.dataset ? target.dataset.pcResourceId : '';
      if (!id) return;
      if (target.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    });
    host.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('[data-pc-action]') : null;
      if (!target) return;
      void action(target.dataset.pcAction, target.dataset);
    });
    window.addEventListener('i18n-change', render);
  }

  window.initPersonalContextCenter = async function initPersonalContextCenter() {
    bind();
    await withBusy(refresh);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { viewModel, primaryActionFor };
  window.PersonalContextCenter = Object.freeze({ viewModel, primaryActionFor, refresh });
})();
