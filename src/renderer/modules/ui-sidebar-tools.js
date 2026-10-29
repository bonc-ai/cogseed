// Shell-owned navigation controls (specs/008-shell-rail-layout, D13).
//
// Two placements, both real DOM children of a header row (never a floating
// overlay, so Electron drag regions cannot swallow them):
//   - uiSidebarTools(): [collapse][search] in the sidebar title row while the
//     sidebar is expanded (live ids #sidebar-search-btn / #sidebar-collapse-btn);
//   - uiShellHeaderTools(): [expand][search] in every page header's shell slot
//     (`[data-shell-header-slot]`). CSS shows the slot only when the sidebar is
//     collapsed or the module has none, and hides [expand] for the latter.
// Header-slot controls are repeated per page, so they carry no ids and are
// wired by delegation on `data-shell-action`.
(function initSidebarTools(root) {
  'use strict';

  function label(key, fallback) {
    const translated = typeof root.t === 'function' ? root.t(key) : key;
    return translated && translated !== key ? translated : fallback;
  }

  function i18nAttrs(key) {
    return { 'data-i18n-title': key, 'data-i18n-aria-label': key };
  }

  function searchButton(attrs) {
    return root.uiIconButton({
      icon: 'search',
      label: label('sidebar.search_title', '全局搜索 (Cmd/Ctrl+K)'),
      size: 'sm',
      attrs: { ...i18nAttrs('sidebar.search_title'), 'data-shell-action': 'search', ...attrs },
    });
  }

  function uiSidebarTools(options) {
    const value = options || {};
    const live = (id) => (value.live ? { id } : {});
    const collapse = root.uiIconButton({
      icon: 'panel',
      label: label('sidebar.collapse_title', '收起侧边栏'),
      size: 'sm',
      attrs: {
        ...live('sidebar-collapse-btn'),
        ...i18nAttrs('sidebar.collapse_title'),
        'data-shell-action': 'collapse-sidebar',
        'aria-expanded': 'true',
      },
    });
    return collapse + searchButton(live('sidebar-search-btn'));
  }

  function uiShellHeaderTools() {
    const expand = root.uiIconButton({
      icon: 'panel',
      label: label('sidebar.expand_title', '展开侧边栏'),
      size: 'sm',
      className: 'shell-header-expand',
      attrs: {
        ...i18nAttrs('sidebar.expand_title'),
        'data-shell-action': 'expand-sidebar',
        'aria-expanded': 'false',
      },
    });
    return expand + searchButton({});
  }

  /** The shell slot every page header starts with (see uiPageHeader). */
  function uiShellHeaderSlot() {
    return `<div class="ui-page-header__shell" data-shell-header-slot>${uiShellHeaderTools()}</div>`;
  }

  /** Fill static slots written directly in index.html. */
  function hydrateShellHeaderSlots(scope) {
    const host = scope || (typeof document !== 'undefined' ? document : null);
    if (!host || typeof host.querySelectorAll !== 'function') return;
    host.querySelectorAll('[data-shell-header-slot]').forEach((slot) => {
      if (slot.childElementCount) return;
      slot.innerHTML = uiShellHeaderTools();
      if (typeof root.hydrateUiIcons === 'function') root.hydrateUiIcons(slot);
    });
  }

  root.uiSidebarTools = uiSidebarTools;
  root.uiShellHeaderTools = uiShellHeaderTools;
  root.uiShellHeaderSlot = uiShellHeaderSlot;
  root.hydrateShellHeaderSlots = hydrateShellHeaderSlots;
  if (typeof document !== 'undefined') {
    const host = document.getElementById('app-shell-tools');
    if (host) {
      host.innerHTML = uiSidebarTools({ live: true });
      if (typeof root.hydrateUiIcons === 'function') root.hydrateUiIcons(host);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => hydrateShellHeaderSlots(document), { once: true });
    } else {
      hydrateShellHeaderSlots(document);
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { uiSidebarTools, uiShellHeaderTools, uiShellHeaderSlot, hydrateShellHeaderSlots };
  }
})(typeof window !== 'undefined' ? window : globalThis);
