// Connections panel — 一级入口「连接」.
//
// Classic script. The panel embeds the original panels into their tabs:
//   - Agent tab      ← #panel-agents（AI 团队）
//   - MCP与工具 tab  ← connectors 网格（connectors.js 按原 ID 渲染）
//   - 数据源 tab     ← #panel-contexts（资料库）
//   - 触点 tab       ← messaging/touchpoint（自设置迁入）
//   - 模型与额度 tab ← 入口卡（连接页内承载，不回跳设置页）
// Tab switching + per-tab lazy priming + entry-card wiring live here.

function _connectionsEl(id) {
  return document.getElementById(id);
}

// 一级页面 header：统一由 uiPageHeader() 渲染（页面骨架规格 PH-01..PH-06）。
// 连接页是六个 tab 的容器，页级没有单一主操作（操作落在各 tab 内），故只渲染
// 语义 h1 标题，不设操作（PH-05：无操作页面保持同一标题骨架）。
function _renderConnectionsPageHeader() {
  const root = _connectionsEl('connections-page-header');
  if (!root || typeof uiPageHeader !== 'function') return;
  root.innerHTML = uiPageHeader({ title: typeof t === 'function' ? t('sidebar.connections') : '连接' });
}

function initConnections() {
  const tabs = document.querySelectorAll('.connections-tab');
  if (!tabs.length) return;

  if (!_connectionsBound) {
    _connectionsBound = true;
    window.addEventListener('i18n-change', _renderConnectionsPageHeader);
    tabs.forEach((btn) => {
      btn.addEventListener('click', () => activateConnectionsTab(btn.dataset.connectionsTab));
    });

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
  activateConnectionsTab(lastTab);
}

let _connectionsBound = false;
let _connectionsLastTab = '';
let _connectionsMcpPrimed = false;
let _connectionsSkillsPrimed = false;

function _connectionsOpenTarget(target) {
  if (target === 'touchpoints') {
    activateConnectionsTab('touchpoints');
    return;
  }
  if (target === 'models') {
    activateConnectionsTab('models');
  }
}

function activateConnectionsTab(name) {
  const tabs = Array.from(document.querySelectorAll('.connections-tab'));
  if (!tabs.length) return;
  const existing = tabs.find((btn) => btn.dataset.connectionsTab === name);
  const target = existing ? name : tabs[0].dataset.connectionsTab;
  _connectionsLastTab = target;
  const panes = document.querySelectorAll('.connections-tab-pane');

  tabs.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.connectionsTab === target);
  });
  panes.forEach((pane) => {
    pane.hidden = pane.dataset.connectionsPane !== target;
  });

  // The MCP pane hosts the connectors grid; prime it on first reveal so the
  // grid is populated before the user lands on it.
  if (target === 'mcp') {
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

  // 插件 tab 承载插件中心（外部包管理 + 插件自带工作台）。plugins.js 属于
  // `plugins` 懒加载包；进入 tab 才加载，避免拖慢聊天首屏。
  if (target === 'plugins') {
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

}

window.initConnections = initConnections;
window.activateConnectionsTab = activateConnectionsTab;
