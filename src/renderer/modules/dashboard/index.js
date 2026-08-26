// ─── 智能体总览 2.0 · 骨架调度（index）───────────────────────────────────
// 职责：三标签切换 + tab 记忆 + 订阅纪律。纯逻辑在 tab-state.js（可静态
// 导入测试）；本文件只做 DOM 绑定与视图生命周期调度。boot.js 的 setView
// 没有 teardown 钩子——用 MutationObserver 观察 #panel-dashboard 的
// active class：失活 → 当前视图 unmount()（退订推送），再激活 → mount()。
// boot.js 兼容入口 window.renderDashboard() 不变。
(function () {
  'use strict';

  const T = window.DashboardTabState;
  let state = { current: '', last: '', panelActive: false };
  let _wired = false;
  let _observer = null;

  function paneFor(tab) { return document.getElementById(`dash-pane-${tab}`); }

  function viewFor(tab) {
    return window.DashboardViews && window.DashboardViews[tab];
  }

  function apply(next) {
    const prev = state;
    state = { current: next.current, last: next.last, panelActive: next.panelActive };
    if (next.unmountView && next.unmountView !== next.current) {
      const view = viewFor(next.unmountView);
      if (view && typeof view.unmount === 'function') {
        try { view.unmount(); } catch (_) { /* unmount 不许抛 */ }
      }
    }
    if (next.current && next.current !== prev.current) {
      document.querySelectorAll('#dash-tabs .dash-tab').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.dashTab === next.current);
      });
      T.TABS.forEach((name) => {
        const pane = paneFor(name);
        if (!pane) return;
        const active = name === next.current;
        pane.classList.toggle('is-active', active);
        pane.hidden = !active;
      });
    }
    if (next.mountView) {
      const view = viewFor(next.mountView);
      const pane = paneFor(next.mountView);
      if (view && pane && typeof view.mount === 'function') {
        Promise.resolve(view.mount(pane)).catch(() => undefined);
      }
    }
  }

  function isPanelActive() {
    const panel = document.getElementById('panel-dashboard');
    return !!(panel && panel.classList && panel.classList.contains('active'));
  }

  function activateTab(tab) {
    apply(T.nextTabState(state, { type: 'activate', tab }));
  }

  function setPanelActive(active) {
    apply(T.nextTabState(state, { type: 'panel', active }));
  }

  function wirePanelObserver() {
    const panel = document.getElementById('panel-dashboard');
    if (!panel || typeof MutationObserver !== 'function') {
      setPanelActive(true);
      return;
    }
    _observer = new MutationObserver(() => setPanelActive(isPanelActive()));
    _observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    setPanelActive(isPanelActive());
  }

  window.renderDashboard = function renderDashboard() {
    const host = document.getElementById('dash-tabs');
    if (!host) return;
    if (!_wired) {
      _wired = true;
      host.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-dash-tab]') : null;
        if (btn) activateTab(btn.dataset.dashTab);
      });
      const refreshBtn = document.getElementById('dash-refresh-btn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
          const view = viewFor(state.current);
          if (view && typeof view.refresh === 'function') {
            Promise.resolve(view.refresh(true)).catch(() => undefined);
          }
        });
      }
      window.addEventListener('i18n-change', () => {
        const view = viewFor(state.current);
        if (view && typeof view.onI18nChange === 'function') view.onI18nChange();
      });
      wirePanelObserver();
    }
    activateTab(state.last);
  };

  // 测试口：直接驱动标签与 panel 激活态（无真实 DOM 事件的环境）。
  window.DashboardViews = window.DashboardViews || {};
  window.DashboardViews._app = {
    activateTab,
    currentTab: () => state.current,
    panelActive: setPanelActive,
  };
}());
