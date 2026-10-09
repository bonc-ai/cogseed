// Connections panel — 一级入口「连接」.
//
// Classic script. The panel embeds the original panels into their tabs:
//   - Agent tab      ← #panel-agents（AI 团队）
//   - MCP与工具 tab  ← connectors 网格 + 插件中心
//   - Skills tab     ← #panel-skills（技能库）
//   - 数据源 tab     ← #panel-contexts（资料库）
//   - 触点 tab       ← messaging/touchpoint（自设置迁入）
// 模型与额度保留在设置，不再重复占用能力页一级 tab。
// Tab switching + per-tab lazy priming + entry-card wiring live here.

function _connectionsEl(id) {
  return document.getElementById(id);
}

// 一级页面 header：统一由 uiPageHeader() 渲染（页面骨架规格 PH-01..PH-06）。
// 能力页是五个 tab 的容器，页级没有单一主操作（操作落在各 tab 内），故只渲染
// 语义 h1 标题，不设操作（PH-05：无操作页面保持同一标题骨架）。
function _renderConnectionsPageHeader() {
  const root = _connectionsEl('connections-page-header');
  if (!root || typeof uiPageHeader !== 'function') return;
  root.innerHTML = uiPageHeader({ title: _connectionsText('sidebar.connections', '智能体 / 技能 / 连接') });
}

function _connectionsText(key, fallback) {
  if (typeof t !== 'function') return fallback;
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function _syncConnectionsTabState(buttons, activeButton) {
  buttons.forEach((button) => {
    const active = button === activeButton;
    button.classList.toggle('is-active', active);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
}

function _connectionsHandleTabKey(event, buttons, current, activate) {
  if (event.isComposing || event.keyCode === 229) return false;
  const enabled = buttons.filter((button) => !button.disabled && !button.hidden && button.getAttribute('aria-disabled') !== 'true');
  const currentIndex = enabled.indexOf(current);
  if (currentIndex < 0 || !enabled.length) return false;

  let nextIndex = -1;
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % enabled.length;
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = enabled.length - 1;
  else return false;

  event.preventDefault();
  const next = enabled[nextIndex];
  next.focus({ preventScroll: true });
  if (typeof next.scrollIntoView === 'function') {
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  activate(next);
  return true;
}

function _bindConnectionsTablist(host, selector, activate) {
  if (!host || host.dataset.connectionsKeyboardBound === '1') return;
  host.dataset.connectionsKeyboardBound = '1';
  host.addEventListener('keydown', (event) => {
    const current = event.target && typeof event.target.closest === 'function'
      ? event.target.closest(selector)
      : null;
    if (!current || !host.contains(current)) return;
    _connectionsHandleTabKey(event, Array.from(host.querySelectorAll(selector)), current, activate);
  });
}

function _renderConnectionsToolsSwitcher() {
  const host = _connectionsEl('connections-tools-switcher');
  if (!host || typeof uiSegmentedControl !== 'function') return;
  const items = [
    { key: 'mcp', label: _connectionsText('connections.tools.mcp', 'MCP 连接器') },
    { key: 'plugins', label: _connectionsText('connections.tab.plugins', '插件') },
  ];
  host.innerHTML = uiSegmentedControl({
    ariaLabel: _connectionsText('connections.tab.mcp', 'MCP与工具'),
    role: 'tablist',
    value: _connectionsToolsLastView,
    className: 'connections-tools-segments',
    items: items.map((item) => ({
      label: item.label,
      value: item.key,
      attrs: { 'data-connections-tools-tab': item.key },
    })),
  });
  const buttons = Array.from(host.querySelectorAll('[data-connections-tools-tab]'));
  buttons.forEach((button) => {
    button.addEventListener('click', () => activateConnectionsToolsView(button.dataset.connectionsToolsTab));
  });
  _syncConnectionsTabState(buttons, buttons.find((button) => button.dataset.connectionsToolsTab === _connectionsToolsLastView));
  _bindConnectionsTablist(host, '[data-connections-tools-tab]', (button) => activateConnectionsToolsView(button.dataset.connectionsToolsTab));
}

function initConnections() {
  const tabs = document.querySelectorAll('.connections-tab');
  if (!tabs.length) return;

  if (!_connectionsBound) {
    _connectionsBound = true;
    window.addEventListener('i18n-change', () => {
      _renderConnectionsPageHeader();
      _renderConnectionsToolsSwitcher();
    });
    tabs.forEach((btn) => {
      btn.addEventListener('click', () => activateConnectionsTab(btn.dataset.connectionsTab));
    });
    _bindConnectionsTablist(document.querySelector('.connections-tabs'), '.connections-tab', (button) => activateConnectionsTab(button.dataset.connectionsTab));

    // Entry cards inside the pane body.
    document.querySelectorAll('[data-connections-subentry]').forEach((card) => {
      if (card.dataset.wired === '1') return;
      card.dataset.wired = '1';
      card.addEventListener('click', () => _connectionsOpenTarget(card.dataset.connectionsSubentry));
    });
  }

  // Restore the last-visible tab across view re-entries (preserves the user's
  // position while inside the panel; defaults to the first tab on first open).
  const requestedTab = window.__connectionsPendingTab || '';
  window.__connectionsPendingTab = '';
  const lastTab = requestedTab || _connectionsLastTab || document.querySelector('.connections-tab.is-active')?.dataset.connectionsTab || tabs[0].dataset.connectionsTab;
  _renderConnectionsPageHeader();
  _renderConnectionsToolsSwitcher();
  activateConnectionsTab(lastTab);
}

let _connectionsBound = false;
let _connectionsLastTab = '';
let _connectionsMcpPrimed = false;
let _connectionsSkillsPrimed = false;
let _connectionsToolsLastView = 'mcp';

function _connectionsOpenTarget(target) {
  if (target === 'touchpoints') {
    activateConnectionsTab('touchpoints');
    return;
  }
  if (target === 'models' && typeof setView === 'function') {
    _connectionsOpenConfiguration('models');
  }
}

function _connectionsOpenConfiguration(anchor) {
  if (typeof setView === 'function') {
    setView('settings', undefined, { settingsTab: 'configuration', settingsAnchor: anchor });
  }
  if (typeof window.activateSettingsTab === 'function') {
    window.activateSettingsTab('configuration', { anchor });
  }
}

function _primeConnectionsMcp() {
  if (typeof loadConnectors === 'function' && !_connectionsMcpPrimed) {
    _connectionsMcpPrimed = true;
    Promise.resolve(loadConnectors())
      .then(() => {
        if (typeof verifyConnectors === 'function') return verifyConnectors();
        return undefined;
      })
      .catch((err) => {
        if (typeof createLogger === 'function') {
          createLogger('connections').warn('connectors load failed', {
            error: (err && err.message) || String(err),
          });
        }
      });
  } else if (typeof _renderConnectorsGrid === 'function') {
    _renderConnectorsGrid();
  }
}

function _primeConnectionsPlugins() {
  const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
  Promise.resolve(typeof loader === 'function' ? loader('plugins') : undefined)
    .then(() => {
      if (typeof window.renderPlugins === 'function') window.renderPlugins();
    })
    .catch((err) => {
      if (typeof createLogger === 'function') {
        createLogger('connections').warn('plugins load failed', {
          error: (err && err.message) || String(err),
        });
      }
    });
}

function activateConnectionsToolsView(name) {
  const target = name === 'plugins' ? 'plugins' : 'mcp';
  _connectionsToolsLastView = target;
  document.querySelectorAll('[data-connections-tools-view]').forEach((view) => {
    view.hidden = view.dataset.connectionsToolsView !== target;
  });
  const buttons = Array.from(document.querySelectorAll('[data-connections-tools-tab]'));
  _syncConnectionsTabState(buttons, buttons.find((button) => button.dataset.connectionsToolsTab === target));
  if (target === 'plugins') _primeConnectionsPlugins();
  else _primeConnectionsMcp();
}

function activateConnectionsTab(name) {
  const tabs = Array.from(document.querySelectorAll('.connections-tab'));
  if (!tabs.length) return;
  if (name === 'models') {
    _connectionsOpenTarget('models');
    return;
  }
  if (name === 'plugins') {
    _connectionsToolsLastView = 'plugins';
    name = 'mcp';
  }
  const existing = tabs.find((btn) => btn.dataset.connectionsTab === name);
  const target = existing ? name : tabs[0].dataset.connectionsTab;
  _connectionsLastTab = target;
  const panes = document.querySelectorAll('.connections-tab-pane');

  _syncConnectionsTabState(tabs, tabs.find((btn) => btn.dataset.connectionsTab === target));
  panes.forEach((pane) => {
    pane.hidden = pane.dataset.connectionsPane !== target;
  });

  // The MCP pane hosts both connectors and plugins behind a secondary switch.
  if (target === 'mcp') {
    activateConnectionsToolsView(_connectionsToolsLastView);
  }

  // 技能 tab 承载技能市场与外部 Skill 库（可用资源，不是个人认知资产）。
  // 技能库的渲染函数在 skills.js，属于 `skills` 懒加载包。
  if (target === 'skills') {
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    Promise.resolve(typeof loader === 'function' ? loader('skills') : undefined)
      .then(() => {
        if (typeof _skillsCache !== 'undefined' && _skillsCache && typeof renderSkillsList === 'function') {
          renderSkillsList(_skillsCache);
        }
        if (typeof loadSkills === 'function') return loadSkills(!_connectionsSkillsPrimed);
        return undefined;
      })
      .then(() => { _connectionsSkillsPrimed = true; })
      .catch((err) => {
        if (typeof createLogger === 'function') {
          createLogger('connections').warn('skills load failed', {
            error: (err && err.message) || String(err),
          });
        }
      });
  }

  // Agent tab 内嵌了 AI 团队：进入时加载完整列表，升级 boot 的摘要缓存。
  if (target === 'agents' && typeof loadAgents === 'function') {
    Promise.resolve(loadAgents(false)).catch(() => {});
  }

  // 触点 tab 内嵌原设置触点工作台；需要 settings bundle 里的
  // messaging/touchpoint modules，但不再跳转到 Settings › Configuration。
  if (target === 'touchpoints') {
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    Promise.resolve(typeof loader === 'function' ? loader('settings') : undefined)
      .then(() => {
        if (typeof window.initTouchpointSettings === 'function') return window.initTouchpointSettings();
        if (typeof initTouchpointSettings === 'function') return initTouchpointSettings();
        return undefined;
      })
      .catch((err) => {
        if (typeof createLogger === 'function') {
          createLogger('connections').warn('touchpoints load failed', {
            error: (err && err.message) || String(err),
          });
        }
      });
  }
  // 数据源 tab 内嵌资料库。
  if (target === 'sources') {
    // 资料库（contexts）是懒加载模块：从「连接」视图进入时 boot 只初始化
    // tab 壳，不会加载 contexts.js。这里先加载模块再渲染，否则面板永远
    // 停留在 index.html 的静态空态（loadContexts 为 undefined 直接跳过）。
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof loader === 'function') {
      Promise.resolve(loader('contexts'))
        .then(() => {
          if (typeof loadContexts === 'function') return loadContexts();
          return undefined;
        })
        .catch(() => {});
    } else if (typeof loadContexts === 'function') {
      Promise.resolve(loadContexts()).catch(() => {});
    }
  }

  // IM 直接留在能力页，通过原设置懒加载包复用同一套授权与消息管理实现。
  if (target === 'touchpoints') {
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    Promise.resolve(typeof loader === 'function' ? loader('settings') : undefined)
      .then(() => {
        if (typeof window.initTouchpointSettings === 'function') return window.initTouchpointSettings();
        return undefined;
      })
      .catch((err) => {
        if (typeof createLogger === 'function') {
          createLogger('connections').warn('IM settings load failed', {
            error: (err && err.message) || String(err),
          });
        }
      });
  }

}

window.initConnections = initConnections;
window.activateConnectionsTab = activateConnectionsTab;
window.activateConnectionsToolsView = activateConnectionsToolsView;
