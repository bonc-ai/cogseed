// ─── 智能体总览 2.0 · 协作标签（俯瞰台）──────────────────────────────────
// 视图协议同 overview。左栏会话史 + 右栏接力图（T16-T17 随任务填充，
// 骨架期诚实占位）。
(function () {
  'use strict';
  const DS = () => window.DashboardShared;

  let _pane = null;

  async function mount(pane) {
    _pane = pane;
    render();
  }

  function unmount() { _pane = null; }

  async function refresh() { render(); }

  function onI18nChange() { render(); }

  function render() {
    if (!_pane) return;
    _pane.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.coming_soon'))}</div>`;
  }

  window.DashboardViews = window.DashboardViews || {};
  window.DashboardViews.collab = { mount, unmount, refresh, onI18nChange };
}());
