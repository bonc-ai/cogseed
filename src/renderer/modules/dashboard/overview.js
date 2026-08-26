// ─── 智能体总览 2.0 · 总览标签（全局活动台）──────────────────────────────
// 视图协议：mount(pane) / unmount() / refresh(force) / onI18nChange()。
// 三段：实时活动区（T7，本文件）、名册卡片（T8）、健康防线（T9）。
// 活动区定位：多会话全局监视——单任务的过程展示归对话流，这里只回答
// 「现在都有谁在忙、忙什么、卡没卡、等没等我」。
(function () {
  'use strict';
  const DS = () => window.DashboardShared;

  const STUCK_AFTER_MS = 120_000;   // 120 秒无更新 → 疑似卡住（设计 2.1）
  const TICK_MS = 30_000;           // 相对时间与卡死标记的刷新周期

  let _pane = null;
  let _snapshot = null;
  let _unsubs = [];
  let _timer = null;

  function statusLabel(status) {
    return DS().t(`dashboard.status.${status}`);
  }

  function isStuck(task) {
    return task.status === 'running'
      && (Date.now() - Date.parse(task.updatedAt)) > STUCK_AFTER_MS;
  }

  // ── T7 实时活动区 ─────────────────────────────────────────────────────
  function renderActivity(el) {
    if (!el) return;
    const esc = DS().esc;
    const t = DS().t;
    const tasks = (_snapshot && _snapshot.runningTasks) || [];

    if (!tasks.length) {
      el.innerHTML = `
        <div class="dash-activity-empty">
          <span>${esc(t('dashboard.activity.empty'))}</span>
          <button type="button" class="btn btn-sm" data-dash-act="start-chat">${esc(t('dashboard.activity.start_chat'))}</button>
        </div>`;
      return;
    }

    const rows = tasks.map((task) => {
      const waiting = task.status === 'waiting_user';
      const stuck = isStuck(task);
      const cls = waiting ? 'is-waiting' : (stuck ? 'is-stuck' : '');
      const badge = waiting
        ? `<span class="dash-badge dash-badge-waiting">${esc(t('dashboard.activity.waiting'))}</span>`
        : stuck
          ? `<span class="dash-badge dash-badge-stuck">${esc(t('dashboard.activity.stuck'))}</span>`
          : `<span class="dash-badge dash-badge-run">${esc(statusLabel(task.status))}</span>`;
      const who = esc(task.agentId || task.taskHead || task.taskId);
      const head = task.taskHead ? `<span class="dash-activity-head">${esc(task.taskHead)}</span>` : '';
      const actions = [
        task.conversationId
          ? `<button type="button" class="btn btn-sm" data-dash-act="open" data-cid="${esc(task.conversationId)}">${esc(t('dashboard.activity.view_conversation'))}</button>`
          : '',
        `<button type="button" class="btn btn-sm" data-dash-act="cancel" data-task="${esc(task.taskId)}">${esc(t('dashboard.activity.cancel'))}</button>`,
      ].join('');
      return `
        <div class="dash-activity-row ${cls}" data-cid="${esc(task.conversationId || '')}">
          <span class="dash-activity-who">${who}</span>
          ${badge}
          ${head}
          <span class="dash-activity-time">${esc(DS().fmtTimeAgo(Date.parse(task.updatedAt)))}</span>
          <span class="dash-activity-actions">${actions}</span>
        </div>`;
    }).join('');

    el.innerHTML = `<div class="dash-section-head"><h3>${esc(t('dashboard.activity.title'))}</h3></div>
      <div class="dash-activity-list">${rows}</div>`;
  }

  // ── T8 名册：委托 roster.js（四分区卡片 + 展开操作）──────────────────
  function renderRoster(el) {
    if (!el) return;
    const roster = window.DashboardRoster;
    if (!roster || typeof roster.renderRoster !== 'function') {
      el.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.loading'))}</div>`;
      return;
    }
    roster.renderRoster(el, _snapshot);
    roster.bindEvents(el);
  }

  function renderHealth(el) {
    if (el) el.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.coming_soon'))}</div>`;
  }

  function render() {
    if (!_pane) return;
    if (!_snapshot) {
      _pane.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.loading'))}</div>`;
      return;
    }
    _pane.innerHTML = `
      <div class="dash-section" id="dash-ov-activity"></div>
      <div class="dash-section" id="dash-ov-roster"></div>
      <div class="dash-section" id="dash-ov-health"></div>`;
    renderActivity(_pane.querySelector('#dash-ov-activity'));
    renderRoster(_pane.querySelector('#dash-ov-roster'));
    renderHealth(_pane.querySelector('#dash-ov-health'));
  }

  async function fetchSnapshot(force) {
    void force;
    const res = await DS().invoke('dashboard.overview.snapshot', {});
    if (res && res.ok) _snapshot = res;
    return _snapshot;
  }

  async function refresh() {
    await fetchSnapshot(true).then(render).catch(() => undefined);
  }

  function onActivityPush() {
    // 任务级终局事件（低频）→ 静默重拉快照即可，无需局部 diff
    fetchSnapshot().then(render).catch(() => undefined);
  }

  function onPaneClick(ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-dash-act]') : null;
    if (!btn) return;
    const act = btn.dataset.dashAct;
    if (act === 'start-chat') {
      if (typeof window.setView === 'function') window.setView('new-chat');
      return;
    }
    if (act === 'open' && btn.dataset.cid) {
      if (typeof window.setView === 'function') window.setView('conversation', btn.dataset.cid);
      return;
    }
    if (act === 'cancel' && btn.dataset.task) {
      const go = () => DS().invoke('cogseed.task.cancel', { taskId: btn.dataset.task })
        .then(() => refresh())
        .catch(() => undefined);
      if (typeof window.uiConfirm === 'function') {
        window.uiConfirm(DS().t('dashboard.activity.cancel_confirm'), go);
      } else {
        go();
      }
    }
  }

  async function mount(pane) {
    _pane = pane;
    if (!_pane.dataset.dashWired) {
      _pane.dataset.dashWired = '1';
      _pane.addEventListener('click', onPaneClick);
    }
    render();
    if (!_snapshot) await fetchSnapshot().then(render).catch(() => render());
    _unsubs.push(DS().subscribe('dashboard:activity', onActivityPush));
    // 相对时间与「疑似卡住」黄标需要周期性重估
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => {
      if (_pane && _snapshot) render();
    }, TICK_MS);
  }

  function unmount() {
    _unsubs.forEach((off) => { try { off(); } catch (_) { /* noop */ } });
    _unsubs = [];
    if (_timer) { clearInterval(_timer); _timer = null; }
    _pane = null;
  }

  function onI18nChange() { render(); }

  window.DashboardOverview = { renderActivity, renderRoster, renderHealth };
  window.DashboardViews = window.DashboardViews || {};
  window.DashboardViews.overview = { mount, unmount, refresh, onI18nChange };
}());
