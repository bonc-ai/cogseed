// ─── 智能体总览 2.0 · 协作标签（俯瞰台）──────────────────────────────────
// 左栏协作会话史（conversations.list），右栏选中会话的接力序列
// （collab.timeline.query 解析既有群聊 jsonl——零新增存储）。
// 画结构不编意图：决策理由只在消息原文里；「派发 N 次」是事实计数，
// 执行率/计划卡片随批次⑤计划门补上（届时计划才是结构化数据）。
// dashboard:collab 推送驱动当前选中会话的实时刷新。
(function () {
  'use strict';
  const DS = () => window.DashboardShared;

  let _pane = null;
  let _convs = [];
  let _selectedCid = '';
  let _timeline = null;
  let _unsubs = [];

  async function loadConversations() {
    const res = await DS().invoke('conversations.list', { offset: 0 }).catch(() => null);
    if (res && res.ok !== false && Array.isArray(res.conversations)) {
      _convs = res.conversations.slice(0, 50);
    }
  }

  async function loadTimeline(cid) {
    if (!cid) { _timeline = null; return; }
    const res = await DS().invoke('collab.timeline.query', { cid }).catch(() => null);
    if (res && res.ok !== false && res.timeline) _timeline = res.timeline;
  }

  function actorBadge(actor) {
    const esc = DS().esc;
    const cls = actor === 'user' ? 'is-user' : (actor === 'commander' ? 'is-commander' : 'is-agent');
    return `<span class="dash-collab-actor ${cls}">${esc(actor)}</span>`;
  }

  function renderLeft() {
    const esc = DS().esc;
    const t = DS().t;
    if (!_convs.length) {
      return `<div class="dash-empty">${esc(t('dashboard.collab.empty'))}</div>`;
    }
    return _convs.map((c) => `
      <button type="button" class="dash-collab-item${_selectedCid === c.conversation_id ? ' is-selected' : ''}" data-collab-act="select" data-cid="${esc(c.conversation_id)}">
        <span class="dash-collab-title">${esc(c.title || c.conversation_id)}</span>
        <span class="dash-collab-sub">${esc(c.updated_at ? DS().fmtTimeAgo(Date.parse(c.updated_at)) : '')}</span>
      </button>`).join('');
  }

  function renderRight() {
    const esc = DS().esc;
    const t = DS().t;
    if (!_selectedCid) {
      return `<div class="dash-empty">${esc(t('dashboard.collab.pick'))}</div>`;
    }
    if (!_timeline) {
      return `<div class="dash-loading">${esc(t('dashboard.loading'))}</div>`;
    }
    const tl = _timeline;
    if (!tl.turns.length) {
      return `<div class="dash-empty">${esc(t('dashboard.collab.no_messages'))}</div>`;
    }
    const agentsNote = tl.agents.length
      ? `<div class="dash-collab-agents">${esc(t('dashboard.collab.agents_n', { n: tl.agents.length }))} · ${esc(t('dashboard.collab.dispatches_n', { n: tl.dispatchCount }))}</div>`
      : `<div class="dash-collab-agents">${esc(t('dashboard.collab.no_agents'))}</div>`;
    const turns = tl.turns.slice(-80).map((turn) => {
      const arrow = turn.to.length
        ? `<span class="dash-collab-arrow">→</span>${turn.to.map(actorBadge).join('')}`
        : '';
      const dispatchTag = turn.dispatch
        ? `<span class="dash-badge dash-badge-info">${esc(t('dashboard.collab.dispatch'))}</span>`
        : '';
      return `
        <div class="dash-collab-turn" data-collab-act="open" data-cid="${esc(tl.cid)}">
          ${actorBadge(turn.from)}${arrow}
          ${dispatchTag}
          <span class="dash-collab-text">${esc(turn.textHead)}</span>
          <span class="dash-collab-time">${esc(turn.ts.slice(11, 16))}</span>
        </div>`;
    }).join('');
    return `
      ${agentsNote}
      <div class="dash-collab-turns">${turns}</div>`;
  }

  function render() {
    if (!_pane) return;
    const esc = DS().esc;
    const t = DS().t;
    _pane.innerHTML = `
      <div class="dash-collab-layout">
        <div class="dash-collab-left">
          <div class="dash-section-head"><h3>${esc(t('dashboard.collab.sessions'))}</h3></div>
          <div class="dash-collab-list">${renderLeft()}</div>
        </div>
        <div class="dash-collab-right">
          <div class="dash-section-head"><h3>${esc(t('dashboard.collab.relay'))}</h3></div>
          ${renderRight()}
        </div>
      </div>`;
  }

  async function mount(pane) {
    _pane = pane;
    if (!_pane.dataset.collabWired) {
      _pane.dataset.collabWired = '1';
      _pane.addEventListener('click', (ev) => {
        const el = ev.target && ev.target.closest ? ev.target.closest('[data-collab-act]') : null;
        if (!el) return;
        const act = el.dataset.collabAct;
        if (act === 'select') {
          _selectedCid = el.dataset.cid || '';
          _timeline = null;
          render();
          void loadTimeline(_selectedCid).then(render).catch(() => undefined);
        } else if (act === 'open' && el.dataset.cid) {
          if (typeof window.setView === 'function') window.setView('conversation', el.dataset.cid);
        }
      });
    }
    render();
    await loadConversations().then(render).catch(() => undefined);
    // 推送驱动：该会话有新消息时刷新右栏（左栏列表低频，手动刷新兜底）
    _unsubs.push(DS().subscribe('dashboard:collab', (event) => {
      if (event && event.cid === _selectedCid) {
        void loadTimeline(_selectedCid).then(render).catch(() => undefined);
      }
    }));
  }

  function unmount() {
    _unsubs.forEach((off) => { try { off(); } catch (_) { /* noop */ } });
    _unsubs = [];
    _pane = null;
  }

  async function refresh() {
    await loadConversations();
    if (_selectedCid) await loadTimeline(_selectedCid);
    render();
  }

  function onI18nChange() { render(); }

  window.DashboardViews = window.DashboardViews || {};
  window.DashboardViews.collab = { mount, unmount, refresh, onI18nChange };
}());
