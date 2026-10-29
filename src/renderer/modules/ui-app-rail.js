// Shared application rail (specs/008-shell-rail-layout). Icon-only top-level
// module entries with tooltips; every entry is a uiIconButton so the rail adds
// no raw controls. The entry ids are the historical sidebar ids, so existing
// click wiring (state.js) and deep-link callers keep working.
(function initAppRail(root) {
  'use strict';

  const RAIL_ITEMS = [
    { module: 'task', id: 'task-nav-btn', icon: 'message-square', labelKey: 'rail.task', fallback: '任务', badgeId: 'commander-running-chip' },
    { module: 'workspace', id: 'workspace-btn', icon: 'folder', labelKey: 'sidebar.workspace', fallback: '空间中心' },
    { module: 'kb', id: 'kb-btn', icon: 'book-open', labelKey: 'sidebar.kb', fallback: '知识库' },
    { module: 'recall', id: 'recall-btn', icon: 'git-branch', labelKey: 'sidebar.recall', fallback: '认知资产' },
    { module: 'auto', id: 'auto-btn', icon: 'clock', labelKey: 'sidebar.auto', fallback: '自动化' },
    { module: 'connections', id: 'connectors-btn', icon: 'plug', labelKey: 'sidebar.connections', fallback: '智能体 / 技能 / 连接' },
    { module: 'run-center', id: 'run-center-btn', icon: 'activity', labelKey: 'sidebar.run_center', fallback: '运行与协作', badgeId: 'run-center-global-badge' },
  ];

  function label(key, fallback) {
    const translated = typeof root.t === 'function' ? root.t(key) : key;
    return translated && translated !== key ? translated : fallback;
  }

  function uiAppRail(options) {
    const value = options || {};
    const items = Array.isArray(value.items) ? value.items : RAIL_ITEMS;
    const active = String(value.activeModule || '');
    const rows = items.map((item) => {
      const isActive = item.module === active;
      const button = root.uiIconButton({
        icon: item.icon,
        label: label(item.labelKey, item.fallback),
        title: false,
        className: `app-rail-btn${isActive ? ' is-active' : ''}`,
        attrs: {
          ...(value.live ? { id: item.id } : {}),
          'data-rail-module': item.module,
          'data-ui-tooltip': true,
          'data-i18n-aria-label': item.labelKey,
          ...(isActive ? { 'aria-current': 'page' } : {}),
        },
      });
      const badge = item.badgeId
        ? `<span class="app-rail-badge"${value.live ? ` id="${item.badgeId}"` : ''} aria-hidden="true" hidden></span>`
        : '';
      return `<li class="app-rail-item">${button}${badge}</li>`;
    }).join('');
    return `<ul class="app-rail-list" role="list">${rows}</ul>`;
  }

  root.uiAppRail = uiAppRail;
  root.APP_RAIL_ITEMS = RAIL_ITEMS;
  if (typeof document !== 'undefined') {
    const host = document.getElementById('app-rail-items');
    if (host) {
      host.innerHTML = uiAppRail({ live: true });
      if (typeof root.hydrateUiIcons === 'function') root.hydrateUiIcons(host);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiAppRail, RAIL_ITEMS };
})(typeof window !== 'undefined' ? window : globalThis);
