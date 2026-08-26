// ─── 智能体总览 2.0 · 成本标签（双层账本）────────────────────────────────
// 视图协议同 overview。人话层（钱）默认、技术层（token 明细）展开——
// 钱只在用户自填单价后出现（T12-T14 随任务填充，骨架期诚实占位）。
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
  window.DashboardViews.cost = { mount, unmount, refresh, onI18nChange };
}());
