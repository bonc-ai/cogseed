// ─── 智能体总览 2.0 · 总览标签（全局活动台）──────────────────────────────
// 视图协议：mount(pane) / unmount() / refresh(force) / onI18nChange()。
// 内容分三段：实时活动区（T7）、名册卡片（T8）、健康防线（T9）、空态
// 三步起步卡（T10）。本文件先落骨架与数据拉取，分段渲染随任务填充。
(function () {
  'use strict';
  const DS = () => window.DashboardShared;

  let _pane = null;
  let _snapshot = null;
  let _unsubs = [];
  let _timer = null;

  async function fetchSnapshot(force) {
    void force;
    const res = await DS().invoke('dashboard.overview.snapshot', {});
    if (res && res.ok) _snapshot = res;
    return _snapshot;
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
    window.DashboardOverview.renderActivity(_pane.querySelector('#dash-ov-activity'), _snapshot);
    window.DashboardOverview.renderRoster(_pane.querySelector('#dash-ov-roster'), _snapshot);
    window.DashboardOverview.renderHealth(_pane.querySelector('#dash-ov-health'), _snapshot);
  }

  async function mount(pane) {
    _pane = pane;
    render();
    if (!_snapshot) await fetchSnapshot().then(render).catch(() => render());
    _unsubs.push(DS().subscribe('dashboard:activity', () => {
      // 任务终局推送 → 静默重拉快照（低频任务级事件，不需要局部 diff）
      fetchSnapshot().then(render).catch(() => undefined);
    }));
  }

  function unmount() {
    _unsubs.forEach((off) => { try { off(); } catch (_) { /* noop */ } });
    _unsubs = [];
    if (_timer) { clearInterval(_timer); _timer = null; }
    _pane = null;
  }

  async function refresh() {
    await fetchSnapshot(true).then(render).catch(() => undefined);
  }

  function onI18nChange() { render(); }

  window.DashboardOverview = {
    mount, unmount, refresh, onI18nChange,
    // 分段渲染器由后续任务（T7 实时区 / T8 名册 / T9 健康）替换为真实实现；
    // 骨架期先给出诚实占位（明示「即将上线」，不冒充数据）。
    renderActivity(el) {
      if (el) el.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.coming_soon'))}</div>`;
    },
    renderRoster(el) {
      if (el) el.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.coming_soon'))}</div>`;
    },
    renderHealth(el) {
      if (el) el.innerHTML = `<div class="dash-loading">${DS().esc(DS().t('dashboard.coming_soon'))}</div>`;
    },
  };

  window.DashboardViews = window.DashboardViews || {};
  window.DashboardViews.overview = window.DashboardOverview;
}());
