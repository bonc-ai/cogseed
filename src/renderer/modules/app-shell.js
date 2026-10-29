// Application shell state (specs/008-shell-rail-layout): maps a view to its
// top-level module, highlights the rail entry, and shows that module's
// sidebar host. Modules without a sidebar (workspace / auto)
// let the main content take the full width.
(function initAppShell(root) {
  'use strict';

  const MODULE_BY_VIEW = {
    'new-chat': 'task',
    conversation: 'task',
    workspace: 'workspace',
    spaces: 'workspace',
    kb: 'kb',
    recall: 'recall',
    auto: 'auto',
    connections: 'connections',
    connectors: 'connections',
    agents: 'connections',
    contexts: 'connections',
    skills: 'connections',
    marketplace: 'connections',
    'run-center': 'run-center',
    settings: 'settings',
  };
  const SIDEBAR_MODULES = new Set(['task', 'kb', 'recall', 'connections', 'run-center', 'settings']);

  function moduleForView(view) {
    return MODULE_BY_VIEW[String(view || '')] || 'other';
  }

  function hasSidebar(module) {
    return SIDEBAR_MODULES.has(module);
  }

  function sidebarHost(module) {
    if (typeof document === 'undefined') return null;
    return document.querySelector(`.sidebar-module[data-sidebar-for="${module}"]`);
  }

  function setShellView(view) {
    if (typeof document === 'undefined' || !document.body) return;
    const module = moduleForView(view);
    const body = document.body;
    body.dataset.shellModule = module;
    body.classList.toggle('shell-no-sidebar', !hasSidebar(module));
    document.querySelectorAll('.sidebar-module').forEach((host) => {
      host.hidden = host.dataset.sidebarFor !== module;
    });
    document.querySelectorAll('.app-rail-btn').forEach((button) => {
      const active = button.dataset.railModule === module;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (typeof root.syncSidebarShellState === 'function') root.syncSidebarShellState();
  }

  root.AppShell = { moduleForView, hasSidebar, sidebarHost, setShellView };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AppShell;
})(typeof window !== 'undefined' ? window : globalThis);
