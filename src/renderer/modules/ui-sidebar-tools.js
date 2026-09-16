// Shell-owned navigation controls. Keeping these controls outside the sidebar
// prevents Electron drag regions from swallowing the collapsed recovery entry.
(function initSidebarTools(root) {
  'use strict';

  function label(key, fallback) {
    const translated = typeof root.t === 'function' ? root.t(key) : key;
    return translated && translated !== key ? translated : fallback;
  }

  function uiSidebarTools(options) {
    const value = options || {};
    const collapsed = value.collapsed === true;
    const collapseKey = collapsed ? 'sidebar.expand_title' : 'sidebar.collapse_title';
    const attrs = (id, key) => ({
      ...(value.live ? { id } : {}),
      'data-i18n-title': key,
      'data-i18n-aria-label': key,
    });
    const search = collapsed ? '' : root.uiIconButton({
      icon: 'search',
      label: label('sidebar.search_title', '全局搜索 (Cmd/Ctrl+K)'),
      variant: 'quiet',
      size: 'sm',
      attrs: attrs('sidebar-search-btn', 'sidebar.search_title'),
    });
    const runCenter = collapsed || !value.includeRunCenter
      ? ''
      : '<div class="run-center-global-entry" id="run-center-global-entry"></div>';
    const collapse = root.uiIconButton({
      icon: 'panel',
      label: label(collapseKey, collapsed ? '展开侧边栏' : '收起侧边栏'),
      variant: 'quiet',
      size: 'sm',
      attrs: {
        ...attrs('sidebar-collapse-btn', collapseKey),
        'aria-expanded': String(!collapsed),
      },
    });
    return search + runCenter + collapse;
  }

  root.uiSidebarTools = uiSidebarTools;
  if (typeof document !== 'undefined') {
    const host = document.getElementById('app-shell-tools');
    if (host) {
      host.innerHTML = uiSidebarTools({ live: true, includeRunCenter: true });
      if (typeof root.hydrateUiIcons === 'function') root.hydrateUiIcons(host);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiSidebarTools };
})(typeof window !== 'undefined' ? window : globalThis);
