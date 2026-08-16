// Connections panel — 一级入口「连接」.
//
// Classic script. The panel embeds the original panels into their tabs:
//   - Agent tab      ← #panel-agents（AI 团队）
//   - MCP与工具 tab  ← connectors 网格（connectors.js 按原 ID 渲染）
//   - 数据源 tab     ← #panel-contexts（资料库）
//   - 触点 tab       ← messaging/touchpoint（自设置迁入）
//   - 模型与额度 tab ← 入口卡（暂保留，跳转设置 Model Providers）
// Tab switching + per-tab lazy priming + entry-card wiring live here.

function _connectionsEl(id) {
  return document.getElementById(id);
}

function initConnections() {
  const tabs = document.querySelectorAll('.connections-tab');
  if (!tabs.length) return;

  if (!_connectionsBound) {
    _connectionsBound = true;
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
  const lastTab = _connectionsLastTab || document.querySelector('.connections-tab.is-active')?.dataset.connectionsTab || tabs[0].dataset.connectionsTab;
  activateConnectionsTab(lastTab);
}

let _connectionsBound = false;
let _connectionsLastTab = '';
let _connectionsMcpPrimed = false;
let _connectionsSkillsPrimed = false;

function _connectionsOpenTarget(target) {
  // Agent / 数据源 / 触点 已内嵌；仅模型与额度保留入口卡。
  if (target === 'models' && typeof setView === 'function') {
    setView('settings');
    if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
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

  // Agent / 数据源 tab 内嵌了 AI 团队与资料库：切到该 tab 时按需加载。
  if (target === 'agents' && typeof loadAgents === 'function') {
    // boot 只加载了 summary 列表（无描述）。这里始终走一次完整加载以升级缓存，
    // 避免「介绍未填写」。_agentsCacheIsSummary 由 loadAgents 内部维护。
    Promise.resolve(loadAgents(false)).catch(() => {});
  }
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

  // 触点 tab 内嵌了飞书/消息平台：首次进入时初始化（依赖 settings bundle 已加载）。
  if (target === 'touchpoints') {
    const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof loader === 'function') {
      Promise.resolve(loader('settings'))
        .then(() => {
          if (typeof window.initTouchpointSettings === 'function') return window.initTouchpointSettings();
          return undefined;
        })
        .catch(() => {});
    }
  }
}

window.initConnections = initConnections;
window.activateConnectionsTab = activateConnectionsTab;
