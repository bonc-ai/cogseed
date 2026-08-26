// ─── 智能体总览 2.0 · tab 状态机（纯函数，无 DOM）────────────────────────
// UMD 双模式：浏览器 classic script 挂 window.DashboardTabState；Node
// （vitest）走 module.exports 直接静态导入测试——不需要动态执行源码。
// 状态机职责：合法标签集、默认回退、记忆（last）、panel 激活转换时
// mount/unmount 的触发判定。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DashboardTabState = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TABS = ['overview', 'cost', 'collab'];

  function isValidTab(name) {
    return TABS.indexOf(String(name)) >= 0;
  }

  function initialTab(remembered) {
    return isValidTab(remembered) ? remembered : 'overview';
  }

  /**
   * Pure tab transition.
   * @param {object} state  { current, last, panelActive }
   * @param {object} action { type: 'activate'|'panel', tab?: string, active?: boolean }
   * @returns {object} { current, last, panelActive, mountView?: string, unmountView?: string }
   */
  function nextTabState(state, action) {
    const s = {
      current: state.current || '',
      last: state.last || state.current || '',
      panelActive: !!state.panelActive,
    };
    const out = { current: s.current, last: s.last, panelActive: s.panelActive };
    if (!action || typeof action !== 'object') return out;

    if (action.type === 'activate') {
      const tab = initialTab(action.tab);
      if (s.current && s.current !== tab && s.panelActive) out.unmountView = s.current;
      out.current = tab;
      out.last = tab;
      if (s.panelActive) out.mountView = tab;
      return out;
    }

    if (action.type === 'panel') {
      const active = !!action.active;
      out.panelActive = active;
      if (active === s.panelActive) return out;
      if (active) out.mountView = s.current;
      else out.unmountView = s.current;
      return out;
    }

    return out;
  }

  return { TABS, isValidTab, initialTab, nextTabState };
}));
