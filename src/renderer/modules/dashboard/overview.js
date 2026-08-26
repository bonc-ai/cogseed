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
    // 计划门待审：后台任务其实在等用户拍板——置顶显示，不能让人忘掉
    const wakes = (_snapshot && _snapshot.pendingWakes) || [];

    if (!tasks.length && !wakes.length) {
      el.innerHTML = `
        <div class="dash-activity-empty">
          <span>${esc(t('dashboard.activity.empty'))}</span>
          <button type="button" class="btn btn-sm" data-dash-act="start-chat">${esc(t('dashboard.activity.start_chat'))}</button>
        </div>`;
      return;
    }

    const wakeRows = wakes.map((w) => `
      <div class="dash-activity-row is-waiting">
        <span class="dash-activity-who">${esc(w.agentName || w.agentId || t('dashboard.collab.dispatch'))}</span>
        <span class="dash-badge dash-badge-waiting">${esc(t('dashboard.activity.waiting'))}</span>
        <span class="dash-activity-head">${esc(w.objectiveHead || '')}</span>
        <span class="dash-activity-time">—</span>
        <span class="dash-activity-actions">
          <button type="button" class="btn btn-sm btn-primary" data-dash-act="open" data-cid="${esc(w.conversationId)}">${esc(t('dashboard.activity.go_decide'))}</button>
        </span>
      </div>`).join('');

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
      <div class="dash-activity-list">${wakeRows}${rows}</div>`;
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

  // ── T10 侧边栏红点：有活跃告警才亮（常亮=噪音）──────────────────────
  function updateAlertDot() {
    const btn = document.getElementById('dashboard-btn');
    if (!btn) return;
    const alerts = ((_snapshot && _snapshot.health) || []).filter((h) => h.state === 'alert');
    btn.classList.toggle('has-dot', alerts.length > 0);
    btn.classList.toggle('is-red', alerts.length > 0);
  }

  // ── T10 空态三步起步卡：全空时替换整个总览，把最空的时候变成最有用的时候 ──
  function isEmptyState() {
    if (!_snapshot) return false;
    const roster = _snapshot.roster || {};
    const externalAgents = (roster.agents || []).filter((a) => a && a.runtime && a.runtime.kind !== 'in_process');
    const hasRoster = ((roster.external && roster.external.entries) || []).length > 0
      || externalAgents.length > 0
      || (roster.remote || []).length > 0
      || (roster.instances || []).length > 0;
    return !hasRoster && ((_snapshot.runningTasks || []).length === 0) && ((_snapshot.health || []).length === 0);
  }

  function renderOnboarding(el) {
    const esc = DS().esc;
    const t = DS().t;
    const done = (key) => {
      try { return localStorage.getItem(`dash-onboarding-${key}`) === 'done'; } catch (_) { return false; }
    };
    const step = (n, key, title, desc, actLabel, act) => `
      <div class="dash-onboard-step${done(key) ? ' is-done' : ''}">
        <span class="dash-onboard-no">${done(key) ? '✓' : n}</span>
        <div class="dash-onboard-text">
          <div class="dash-onboard-title">${esc(title)}</div>
          <div class="dash-onboard-desc">${esc(desc)}</div>
        </div>
        ${done(key) ? '' : `<button type="button" class="btn btn-sm btn-primary" data-dash-act="${act}">${esc(actLabel)}</button>`}
      </div>`;
    el.innerHTML = `
      <div class="dash-onboard">
        <div class="dash-onboard-head">${esc(t('dashboard.onboard.title'))}</div>
        ${step(1, 'model', t('dashboard.onboard.model'), t('dashboard.onboard.model_desc'), t('dashboard.onboard.model_btn'), 'ob-model')}
        ${step(2, 'first', t('dashboard.onboard.first'), t('dashboard.onboard.first_desc'), t('dashboard.onboard.first_btn'), 'ob-first')}
        ${step(3, 'agent', t('dashboard.onboard.agent'), t('dashboard.onboard.agent_desc'), t('dashboard.onboard.agent_btn'), 'ob-agent')}
      </div>`;
  }

  // ── T9 健康防线：常态一行小字，出异常才浮现告警条 ────────────────────
  function renderHealth(el) {
    if (!el) return;
    const esc = DS().esc;
    const t = DS().t;
    const health = (_snapshot && _snapshot.health) || [];
    const alerts = health.filter((h) => h.state === 'alert');
    const observing = health.filter((h) => h.state === 'observing');

    if (!alerts.length) {
      const bits = [`<span class="dash-health-ok">✓ ${esc(t('dashboard.health.all_good'))}</span>`];
      if (observing.length) {
        bits.push(`<span class="dash-health-observing">${esc(t('dashboard.health.observing_n', { n: observing.length }))}</span>`);
      }
      bits.push(`<span class="dash-health-rule">${esc(t('dashboard.health.rule'))}</span>`);
      el.innerHTML = `<div class="dash-health-bar is-quiet">${bits.join('')}</div>`;
      return;
    }

    const rows = alerts.map((h) => {
      const reason = h.consecutiveFailures >= 3
        ? t('dashboard.health.rule_consecutive', { n: h.consecutiveFailures })
        : t('dashboard.health.rule_rate', { rate: Math.round(h.recent10SuccessRate * 100) });
      const failure = h.lastFailure
        ? `<span class="dash-health-failure">${esc(t('dashboard.health.last_failure'))}：${esc(h.lastFailure.errorCode || h.lastFailure.taskId)} · ${esc(DS().fmtTimeAgo(Date.parse(h.lastFailure.updatedAt)))}</span>`
        : '';
      const actions = [
        h.lastFailure && h.lastFailure.conversationId
          ? `<button type="button" class="btn btn-sm" data-dash-act="open" data-cid="${esc(h.lastFailure.conversationId)}">${esc(t('dashboard.health.view_failure'))}</button>`
          : '',
        `<button type="button" class="btn btn-sm" data-dash-act="disable-agent" data-agent="${esc(h.agentId)}">${esc(t('dashboard.health.disable_agent'))}</button>`,
      ].join('');
      return `
        <div class="dash-health-alert">
          <span class="dash-health-agent">${esc(h.agentId)}</span>
          <span class="dash-health-reason">${esc(reason)}</span>
          ${failure}
          <span class="dash-roster-spacer"></span>
          <span class="dash-health-actions">${actions}</span>
        </div>`;
    }).join('');

    el.innerHTML = `<div class="dash-health-bar is-alert">
      <div class="dash-health-title">${esc(t('dashboard.health.alert_title'))}</div>
      ${rows}
    </div>`;
  }

  function render() {
    if (!_pane) return;
    if (!_snapshot) {
      _pane.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.loading'))}</div>`;
      return;
    }
    updateAlertDot();
    if (isEmptyState()) {
      _pane.innerHTML = '';
      renderOnboarding(_pane);
      return;
    }
    _pane.innerHTML = `
      <div class="dash-section" id="dash-ov-activity"></div>
      <div class="dash-section" id="dash-ov-roster"></div>
      <div class="dash-section" id="dash-ov-health"></div>`;
    // 分段错误隔离（设计 1.2）：一段渲染崩溃只显示该段的错误占位，
    // 不拖垮整页——此前名册抛错把健康区也带成空白。
    const section = (sel, label, fn) => {
      const node = _pane.querySelector(sel);
      if (!node) return;
      try {
        fn(node);
      } catch (_) {
        node.innerHTML = `<div class="dash-empty">${DS().esc(DS().t('dashboard.section_error'))}</div>`;
        void label;
      }
    };
    section('#dash-ov-activity', 'activity', renderActivity);
    section('#dash-ov-roster', 'roster', renderRoster);
    section('#dash-ov-health', 'health', renderHealth);
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
    if (act === 'ob-model') {
      try { localStorage.setItem('dash-onboarding-model', 'done'); } catch (_) { /* noop */ }
      if (typeof window.setView === 'function') window.setView('settings');
      return;
    }
    if (act === 'ob-first') {
      try { localStorage.setItem('dash-onboarding-first', 'done'); } catch (_) { /* noop */ }
      if (typeof window.setView === 'function') window.setView('new-chat');
      return;
    }
    if (act === 'ob-agent') {
      try { localStorage.setItem('dash-onboarding-agent', 'done'); } catch (_) { /* noop */ }
      if (typeof window.setView === 'function') window.setView('agents');
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
      return;
    }
    if (act === 'disable-agent' && btn.dataset.agent) {
      // 临时停用：禁用的 peer 不可被 @ 派发但保留注册——防止继续往坏 agent 派活
      DS().invoke('p3394.peers.toggle', { agentId: btn.dataset.agent, disabled: true })
        .then(() => refresh())
        .catch(() => undefined);
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
