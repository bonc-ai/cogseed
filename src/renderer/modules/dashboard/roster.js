// ─── 智能体总览 2.0 · 名册（roster）──────────────────────────────────────
// 四分区：内置（只读）/ 外接·本机（CLI 网关 + 绑定的 agent 卡片，模型可改）/
// 外接·远端（节点管理）/ 通讯渠道（跳连接中心管理）。
// 卡片默认极简（名+状态徽章+累计调用），展开才出现详情与操作——态势页
// 要「扫一眼得全局」（设计 2.2）。分区折叠记忆为内存态。
// 事件绑定在每次重建的 section 节点上（innerHTML 重建后随节点回收，
// 不与视图生命周期纠缠）。
(function () {
  'use strict';
  const DS = () => window.DashboardShared;

  const _collapsed = {};   // 分区折叠记忆（内存，不跨启动）

  function esc(v) { return DS().esc(v); }
  function t(key, vars) { return DS().t(key, vars); }

  function sectionHtml(id, title, bodyHtml, extraHead) {
    const collapsed = _collapsed[id] ? ' is-collapsed' : '';
    return `<div class="dash-section">
      <div class="dash-section-head">
        <button type="button" class="dash-section-toggle${collapsed}" data-roster-act="toggle-section" data-section="${id}">
          <h3>${esc(title)}</h3>
        </button>
        ${extraHead || ''}
      </div>
      <div class="dash-roster-body${collapsed}" data-section-body="${id}">${bodyHtml}</div>
    </div>`;
  }

  function emptyHtml(key) {
    return `<div class="dash-empty">${esc(t(key))}</div>`;
  }

  function healthByAgent(snapshot) {
    const map = {};
    ((snapshot && snapshot.health) || []).forEach((h) => { map[h.agentId] = h; });
    return map;
  }

  function callsBadge(agentKey, healthMap) {
    const h = healthMap[agentKey];
    if (!h) return '';    // 无记录不冒充 0（诚实五条）
    return `<span class="dash-roster-calls">${esc(t('dashboard.roster.calls', { n: h.attempts }))}</span>`;
  }

  // ── 内置（只读名片）────────────────────────────────────────────────────
  function builtinHtml(snapshot) {
    const agents = ((snapshot && snapshot.roster && snapshot.roster.agents) || [])
      .filter((a) => a && (!a.runtime || a.runtime.kind === 'in_process'));
    if (!agents.length) return emptyHtml('dashboard.builtin_empty');
    return agents.map((a) => `
      <div class="dash-roster-card">
        <span class="dash-roster-name">${esc(a.name || a.agent_id)}</span>
        <span class="dash-badge dash-badge-info">${esc(t('dashboard.roster.builtin_badge'))}</span>
        <span class="dash-roster-spacer"></span>
        ${callsBadge(a.agent_id, healthByAgent(snapshot))}
      </div>`).join('');
  }

  // ── 外接·本机：网关行 + 绑定 agent 卡片（模型可改）───────────────────
  function localHtml(snapshot) {
    const roster = (snapshot && snapshot.roster) || {};
    const external = roster.external || {};
    const entries = (external.entries || []).filter((e) => e && e.available);
    const gateways = external.gateways || [];
    const bound = external.bound || {};
    const agents = (roster.agents || []).filter((a) => a && a.runtime && a.runtime.kind !== 'in_process');

    if (!entries.length && !agents.length) {
      return emptyHtml('dashboard.local_empty');
    }
    const rows = entries.map((entry) => {
      const gw = gateways.find((g) => g && g.cli === entry.type);
      const running = !!(gw && gw.running);
      const boundNames = (bound[entry.type] || []).join('、');
      return `
      <div class="dash-roster-card">
        <span class="dash-roster-name">${esc(entry.displayName || entry.type)}</span>
        <span class="dash-badge dash-badge-${running ? 'on' : 'off'}">${esc(t(running ? 'dashboard.gateway_running' : 'dashboard.gateway_offline'))}</span>
        ${boundNames ? `<span class="dash-roster-sub">${esc(t('dashboard.bound_agents'))}：${esc(boundNames)}</span>` : ''}
        <span class="dash-roster-spacer"></span>
        <button type="button" class="btn btn-sm" data-roster-act="toggle-gateway" data-cli="${esc(entry.type)}" data-running="${running ? '1' : ''}">${esc(t(running ? 'dashboard.stop' : 'dashboard.start'))}</button>
      </div>`;
    }).join('');

    const agentCards = agents.map((a) => `
      <details class="dash-roster-agent">
        <summary>
          <span class="dash-roster-name">${esc(a.name || a.agent_id)}</span>
          <span class="dash-badge dash-badge-${a.enabled === false ? 'off' : 'on'}">${esc(t(a.enabled === false ? 'dashboard.node_disabled' : 'dashboard.gateway_running'))}</span>
          <span class="dash-roster-spacer"></span>
          ${callsBadge(a.agent_id, healthByAgent(snapshot))}
        </summary>
        <div class="dash-roster-agent-detail">
          <label class="dash-model-row">
            <span>${esc(t('dashboard.roster.model'))}</span>
            <input type="text" list="dash-model-list-${esc(a.runtime.cli || 'x')}" data-roster-model="${esc(a.agent_id)}" value="${esc(a.runtime.model || '')}" placeholder="${esc(t('dashboard.roster.model_default'))}">
          </label>
          <button type="button" class="btn btn-sm btn-primary" data-roster-act="save-model" data-agent="${esc(a.agent_id)}" data-kind="${esc(a.runtime.kind)}" data-cli="${esc(a.runtime.cli || '')}">${esc(t('dashboard.roster.save_model'))}</button>
          <button type="button" class="btn btn-sm" data-roster-act="toggle-agent" data-agent="${esc(a.agent_id)}" data-enabled="${a.enabled === false ? '0' : '1'}">${esc(t(a.enabled === false ? 'dashboard.enable_node' : 'dashboard.disable_node'))}</button>
          <button type="button" class="btn btn-sm" data-roster-act="open-config">${esc(t('dashboard.roster.config'))}</button>
        </div>
      </details>`).join('');

    return rows + (agentCards ? `<div class="dash-roster-agents">${agentCards}</div>` : '');
  }

  // ── 外接·远端：节点行（测试/停启用/删除/编辑 + 添加表单）──────────────
  function remoteHtml(snapshot) {
    const roster = (snapshot && snapshot.roster) || {};
    const nodes = roster.remote || [];
    const peers = (roster.external && roster.external.peers) || [];
    const rows = nodes.map((node) => {
      const peer = peers.find((p) => p && (p.agent_id === node.expected_identity || p.endpoint === node.endpoint));
      const online = !!(peer && peer.online);
      const disabled = !!(peer && peer.disabled);
      const statusKey = disabled ? 'dashboard.node_disabled' : (online ? 'dashboard.node_online' : 'dashboard.node_offline');
      return `
      <div class="dash-roster-card">
        <span class="dash-roster-name">${esc(node.label || node.endpoint)}</span>
        <span class="dash-badge dash-badge-${disabled || !online ? 'off' : 'on'}">${esc(t(statusKey))}</span>
        <span class="dash-roster-sub dash-mono">${esc(node.endpoint || '')}</span>
        <span class="dash-roster-spacer"></span>
        ${peer ? `<button type="button" class="btn btn-sm" data-roster-act="toggle-node" data-agent-id="${esc(node.expected_identity || '')}" data-disabled="${disabled ? '1' : ''}">${esc(t(disabled ? 'dashboard.enable_node' : 'dashboard.disable_node'))}</button>` : ''}
        <button type="button" class="btn btn-sm" data-roster-act="test-node" data-id="${esc(node.id)}">${esc(t('dashboard.test'))}</button>
        <button type="button" class="btn btn-sm btn-danger" data-roster-act="remove-node" data-id="${esc(node.id)}">${esc(t('dashboard.remove'))}</button>
      </div>`;
    }).join('');

    return (rows || emptyHtml('dashboard.remote_empty')) + `
      <details class="dash-remote-form">
        <summary><span>${esc(t('dashboard.add_remote'))}</span></summary>
        <form class="dash-form" data-roster-form="add-remote">
          <label><span>${esc(t('dashboard.form_label'))}</span><input type="text" name="label" autocomplete="off" required></label>
          <label><span>${esc(t('dashboard.form_endpoint'))}</span><input type="text" name="endpoint" autocomplete="off" spellcheck="false" required></label>
          <label><span>${esc(t('dashboard.form_token'))}</span><input type="password" name="token" autocomplete="off"></label>
          <label><span>${esc(t('dashboard.form_identity'))}</span><input type="text" name="expected_identity" autocomplete="off" spellcheck="false"></label>
          <div class="dash-form-actions">
            <button type="submit" class="btn btn-sm btn-primary">${esc(t('dashboard.form_submit'))}</button>
          </div>
          <div class="dash-form-status" role="status"></div>
        </form>
      </details>`;
  }

  // ── 通讯渠道：实例行（管理跳连接中心触点）──────────────────────────────
  function channelsHtml(snapshot) {
    const instances = (snapshot && snapshot.roster && snapshot.roster.instances) || [];
    const peers = (snapshot && snapshot.roster && snapshot.roster.external && snapshot.roster.external.peers) || [];
    const bridgePeers = peers.filter((p) => p && p.node_kind === 'channel_bridge');
    if (!instances.length) return emptyHtml('dashboard.channels_empty');
    return instances.map((instance) => {
      const connected = instance.status && instance.status.kind === 'connected';
      const bridged = bridgePeers.some((p) => p.agent_id === `channel-${instance.id}`);
      const statusKey = !instance.enabled ? 'dashboard.channel_disabled'
        : (connected ? 'dashboard.channel_connected' : 'dashboard.channel_offline');
      return `
      <div class="dash-roster-card">
        <span class="dash-roster-name">${esc(instance.displayName || instance.platform)}</span>
        <span class="dash-badge dash-badge-${!instance.enabled || !connected ? 'off' : 'on'}">${esc(t(statusKey))}</span>
        ${bridged ? `<span class="dash-roster-sub">${esc(t('dashboard.channel_bridged'))}</span>` : ''}
        <span class="dash-roster-spacer"></span>
        <button type="button" class="btn btn-sm" data-roster-act="manage-channel">${esc(t('dashboard.channel_manage'))}</button>
      </div>`;
    }).join('');
  }

  function renderRoster(el, snapshot) {
    if (!el) return;
    el.innerHTML = ''
      + sectionHtml('builtin', t('dashboard.builtin_section'), builtinHtml(snapshot))
      + sectionHtml('local', t('dashboard.local_section'), localHtml(snapshot),
        `<button type="button" class="btn btn-sm" data-roster-act="add-local">${esc(t('dashboard.add_local'))}</button>`)
      + sectionHtml('remote', t('dashboard.remote_section'), remoteHtml(snapshot))
      + sectionHtml('channels', t('dashboard.channels_section'), channelsHtml(snapshot));

    // 模型候选清单（datalist）：有目录的 CLI 给下拉候选，没有的自由输入。
    // 先为每个 CLI 建空 datalist 节点（input 的 list 属性已引用其 id），
    // 再异步拉目录填充；清单为空或不可得时 datalist 保持空 = 纯文本输入。
    const cliTypes = new Set();
    el.querySelectorAll('[data-roster-model]').forEach((input) => {
      const listId = input.getAttribute('list') || '';
      if (listId) cliTypes.add(listId.replace('dash-model-list-', ''));
    });
    cliTypes.forEach((cli) => {
      const datalist = document.createElement('datalist');
      datalist.id = `dash-model-list-${cli}`;
      el.appendChild(datalist);
      DS().invoke('localAgents.listModels', { type: cli })
        .then((res) => {
          if (!res || !res.ok || !Array.isArray(res.models)) return;
          datalist.innerHTML = res.models
            .map((m) => `<option value="${esc(typeof m === 'string' ? m : (m && m.id) || '')}"></option>`)
            .join('');
        })
        .catch(() => undefined);
    });
  }

  function refreshOverview() {
    const view = window.DashboardViews && window.DashboardViews.overview;
    if (view && typeof view.refresh === 'function') {
      Promise.resolve(view.refresh()).catch(() => undefined);
    }
  }

  function bindEvents(el) {
    el.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-roster-act]') : null;
      if (!btn) return;
      const act = btn.dataset.rosterAct;
      if (act === 'toggle-section') {
        const id = btn.dataset.section;
        _collapsed[id] = !_collapsed[id];
        btn.classList.toggle('is-collapsed', _collapsed[id]);
        const body = el.querySelector(`[data-section-body="${id}"]`);
        if (body) body.classList.toggle('is-collapsed', _collapsed[id]);
        return;
      }
      if (act === 'toggle-gateway') {
        const running = btn.dataset.running === '1';
        DS().invoke(running ? 'p3394.external.stop' : 'p3394.external.start', { cli: btn.dataset.cli })
          .then(refreshOverview).catch(() => undefined);
        return;
      }
      if (act === 'toggle-node') {
        DS().invoke('p3394.peers.toggle', { agentId: btn.dataset.agentId, disabled: btn.dataset.disabled !== '1' })
          .then(refreshOverview).catch(() => undefined);
        return;
      }
      if (act === 'test-node') {
        DS().invoke('p3394.remote.test', { id: btn.dataset.id })
          .then(refreshOverview).catch(() => undefined);
        return;
      }
      if (act === 'remove-node') {
        const go = () => DS().invoke('p3394.remote.remove', { id: btn.dataset.id })
          .then(refreshOverview).catch(() => undefined);
        if (typeof window.uiConfirm === 'function') window.uiConfirm(t('dashboard.remove_confirm'), go);
        else go();
        return;
      }
      if (act === 'add-local') {
        if (typeof window.openAgentModal === 'function') window.openAgentModal({ initialTab: 'external' });
        return;
      }
      if (act === 'open-config') {
        if (typeof window.setView === 'function') window.setView('agents');
        return;
      }
      if (act === 'manage-channel') {
        if (typeof window.setView === 'function') {
          window.setView('connections');
          const tab = document.querySelector('[data-connections-tab="touchpoints"]');
          if (tab) tab.click();
        }
        return;
      }
      if (act === 'toggle-agent') {
        DS().invoke('agents.setEnabled', { agent_id: btn.dataset.agent, enabled: btn.dataset.enabled !== '1' })
          .then(refreshOverview).catch(() => undefined);
        return;
      }
      if (act === 'save-model') {
        const input = el.querySelector(`[data-roster-model="${btn.dataset.agent}"]`);
        const model = input ? String(input.value || '').trim() : '';
        DS().invoke('agents.update', {
          agent_id: btn.dataset.agent,
          updates: { runtime: { kind: btn.dataset.kind, cli: btn.dataset.cli, ...(model ? { model } : {}) } },
        }).then(refreshOverview).catch(() => undefined);
      }
    });

    el.addEventListener('submit', (ev) => {
      const form = ev.target && ev.target.closest ? ev.target.closest('[data-roster-form]') : null;
      if (!form) return;
      ev.preventDefault();
      const data = new FormData(form);
      const status = form.querySelector('.dash-form-status');
      const show = (msg) => { if (status) status.textContent = msg; };
      DS().invoke('p3394.remote.test', {
        label: String(data.get('label') || ''),
        endpoint: String(data.get('endpoint') || ''),
        token: String(data.get('token') || ''),
        expected_identity: String(data.get('expected_identity') || ''),
      }).then((res) => {
        if (!res || !res.ok) { show(t('dashboard.remote_test_failed')); return null; }
        return DS().invoke('p3394.remote.add', {
          label: String(data.get('label') || ''),
          endpoint: String(data.get('endpoint') || ''),
          token: String(data.get('token') || ''),
          expected_identity: String(data.get('expected_identity') || ''),
          id: res.id,
        }).then(() => { show(t('dashboard.remote_added')); refreshOverview(); });
      }).catch(() => show(t('dashboard.remote_test_failed')));
    });
  }

  window.DashboardRoster = { renderRoster, bindEvents };
}());
