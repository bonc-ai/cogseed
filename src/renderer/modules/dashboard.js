// ─── 智能体总览 Dashboard（第二期）───────────────────────────────────────
// 内置（戏服智能体，只读概览跳现有智能体页）/ 外接·本机（CLI+托管网关）/
// 外接·远端（P3394 remote nodes）三分区统一总览。数据一次往返：
// p3394.external.list + p3394.remote.list + agents.list。
// 懒加载入口：boot.js setView('dashboard') → _loadViewFeature('dashboard')。
// i18n：本模块所有文案走 t(key[, vars]) — 注意 t() 第二参是模板变量字典，
// 不是默认文案；键缺失时 t() 回显键名本身。切换语言由 i18n-change 重渲染。

(function () {
  'use strict';

  const _dashLog = (window.__cogseedLogger?.for?.('dashboard')) || console;

  function el(id) { return document.getElementById(id); }

  let _lastData = null;

  async function fetchDashboardData(force) {
    const [externalRes, remoteRes, agentsRes, channelsRes, wakeRes] = await Promise.all([
      window.cogseed.invoke('p3394.external.list', { force: force === true }),
      window.cogseed.invoke('p3394.remote.list', {}),
      window.cogseed.invoke('agents.list', {}).catch(() => null),
      window.cogseed.invoke('messaging.list', {}).catch(() => null),
      // 控制中心（T3）：跨会话待审批聚合（cid 缺省 = 全量）。
      window.cogseed.invoke('p3394.listWakeRequests', {}).catch(() => null),
    ]);
    return {
      external: externalRes || { entries: [], gateways: [], bound: {}, peers: [] },
      remote: remoteRes || { nodes: [] },
      agents: (agentsRes && agentsRes.agents) || [],
      channels: (channelsRes && channelsRes.instances) || [],
      wake: (wakeRes && wakeRes.requests) || [],
    };
  }

  function builtinCount(agents) {
    return (agents || []).filter((a) => {
      const rt = a && a.runtime;
      return !rt || rt.kind === 'in_process';
    }).length;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 胶囊状态徽章（dash-badge-on/off/info），替代裸圆点。
  function badge(kind, text) {
    return `<span class="dash-badge dash-badge-${esc(kind)}">${esc(text)}</span>`;
  }

  // 相对时间（最近心跳展示）：xx 秒/分钟/小时前，超过 1 天给绝对日期。
  function formatRelative(iso) {
    if (!iso) return '';
    const ts = new Date(iso).getTime();
    if (!Number.isFinite(ts)) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return t('dashboard.ago_seconds', { n: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return t('dashboard.ago_minutes', { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return t('dashboard.ago_hours', { n: hr });
    const day = Math.floor(hr / 24);
    if (day < 7) return t('dashboard.ago_days', { n: day });
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 详情键值网格（行展开块）。
  function detailGrid(pairs) {
    const rows = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `<div class="dash-detail-item"><span class="dash-detail-key">${esc(k)}</span><span class="dash-detail-val">${esc(v)}</span></div>`).join('');
    return rows ? `<div class="dash-row-detail"><div class="dash-detail-grid">${rows}</div></div>` : '';
  }

  function rowHtml({ name, badgeHtml, sub, subMono, actions, detail, open }) {
    return `<div class="dash-row-wrap${detail ? ' has-detail' : ''}${open ? ' is-open' : ''}">
      <div class="dash-row" ${detail ? 'data-dash-action="toggle-detail" role="button" tabindex="0" aria-expanded="false"' : ''}>
        <div class="dash-row-main">
          <div class="dash-row-name">${esc(name)}${badgeHtml || ''}</div>
          ${sub ? `<div class="dash-row-sub${subMono ? ' dash-mono' : ''}">${esc(sub)}</div>` : ''}
        </div>
        <div class="dash-row-actions">${actions || ''}</div>
      </div>
      ${detail || ''}
    </div>`;
  }

  // ── 控制中心（T3）：跨会话待审批聚合 ──
  // wake 请求 pending 列表（"需要你确认的操作"）：批准即恢复派发执行、
  // 拒绝即终止。会话内的审批卡（conversation.js）原行为不变，这里只是
  // 把散在各会话里的待办聚合到总览顶部，一处看完一处处理。
  function renderControl(data) {
    const box = el('dash-control-list');
    if (!box) return;
    const pending = (data.wake || []).filter((r) => r && r.status === 'pending');
    if (!pending.length) {
      box.innerHTML = `<div class="dash-empty">${esc(t('dashboard.control_empty'))}</div>`;
      return;
    }
    box.innerHTML = pending.map((r) => rowHtml({
      name: r.agent_name || r.agent_id,
      badgeHtml: badge('info', t('p3394.wake.status.pending')),
      sub: String(r.objective || '').slice(0, 160),
      actions: `<button type="button" class="btn btn-primary btn-sm" data-dash-action="wake-decide" data-request-id="${esc(r.id)}" data-cid="${esc(r.conversation_id || '')}" data-decision="approve">${esc(t('p3394.wake.approve'))}</button>
        <button type="button" class="btn btn-sm" data-dash-action="wake-decide" data-request-id="${esc(r.id)}" data-cid="${esc(r.conversation_id || '')}" data-decision="reject">${esc(t('p3394.wake.reject'))}</button>`,
      detail: detailGrid([
        [t('dashboard.control_source'), r.source || ''],
        [t('dashboard.control_conversation'), r.conversation_id || ''],
        [t('dashboard.last_seen'), formatRelative(r.created_at)],
      ]),
    })).join('');
  }

  function renderBuiltin(data) {
    const box = el('dash-builtin-list');
    if (!box) return;
    const count = builtinCount(data.agents);
    box.innerHTML = rowHtml({
      name: t('dashboard.builtin_row'),
      badgeHtml: badge('info', t('dashboard.builtin_members', { count })),
      sub: t('dashboard.builtin_desc'),
      actions: `<button type="button" class="btn btn-sm" data-dash-action="open-agents">${esc(t('dashboard.view_agents'))}</button>`,
    });
  }

  function renderLocal(data) {
    const box = el('dash-local-list');
    if (!box) return;
    const entries = (data.external.entries || []).filter((e) => e && e.available);
    const gateways = data.external.gateways || [];
    const bound = data.external.bound || {};
    if (!entries.length) {
      box.innerHTML = `<div class="dash-empty">${esc(t('dashboard.local_empty'))}</div>`;
      return;
    }
    box.innerHTML = entries.map((entry) => {
      const gw = gateways.find((g) => g && g.cli === entry.type);
      const running = !!(gw && gw.running);
      const boundNames = (bound[entry.type] || []).join('、');
      const peer = (data.external.peers || []).find((p) => p && p.locality === 'same_host'
        && (p.endpoints || []).some((ep) => String(ep).includes(String(entry.type))));
      const lastSeen = peer ? formatRelative(peer.last_seen_at) : '';
      return rowHtml({
        name: entry.displayName || entry.type,
        badgeHtml: badge(running ? 'on' : 'off', t(running ? 'dashboard.gateway_running' : 'dashboard.gateway_offline')),
        sub: [
          boundNames ? `${t('dashboard.bound_agents')}：${boundNames}` : '',
          lastSeen ? `${t('dashboard.last_seen')}：${lastSeen}` : '',
        ].filter(Boolean).join(' · '),
        detail: detailGrid([
          [t('dashboard.detail_cli'), entry.type],
          [t('dashboard.detail_bound_agents'), boundNames],
          [t('dashboard.detail_last_seen'), lastSeen],
          [t('dashboard.detail_locality'), t('dashboard.locality_same_host')],
        ]),
        actions: `<button type="button" class="btn btn-sm" data-dash-action="toggle-gateway" data-cli="${esc(entry.type)}" data-running="${running ? '1' : ''}">${running ? esc(t('dashboard.stop')) : esc(t('dashboard.start'))}</button>`,
      });
    }).join('');
  }

  // 编辑远端节点（G-15）：行详情展开内嵌编辑表单；未填 token 保留原值。
  function editFormHtml(node) {
    return `<form class="dash-form dash-edit-form" data-dash-edit-id="${esc(node.id)}">
      <label><span data-i18n="dashboard.form_label">名称</span><input type="text" name="label" value="${esc(node.label || '')}" autocomplete="off"></label>
      <label><span data-i18n="dashboard.form_endpoint">地址</span><input type="text" name="endpoint" value="${esc(node.endpoint || '')}" autocomplete="off" spellcheck="false"></label>
      <label><span data-i18n="dashboard.form_token_keep">令牌（留空保留原值）</span><input type="password" name="token" autocomplete="off" placeholder="${esc(node.tokenPreview || '••••')}"></label>
      <label><span data-i18n="dashboard.form_identity">期望身份（可选）</span><input type="text" name="expected_identity" value="${esc(node.expected_identity || '')}" autocomplete="off" spellcheck="false"></label>
      <div class="dash-form-actions">
        <button type="button" class="btn btn-sm" data-dash-action="cancel-edit">${esc(t('dashboard.cancel_edit'))}</button>
        <button type="submit" class="btn btn-sm btn-primary">${esc(t('dashboard.save_edit'))}</button>
      </div>
      <div class="dash-form-status" role="status"></div>
    </form>`;
  }

  function renderRemote(data) {
    const box = el('dash-remote-list');
    if (!box) return;
    const nodes = (data.remote.nodes) || [];
    if (!nodes.length) {
      box.innerHTML = `<div class="dash-empty">${esc(t('dashboard.remote_empty'))}</div>`;
      return;
    }
    const peers = data.external.peers || [];
    box.innerHTML = nodes.map((node) => {
      const peer = peers.find((p) => p && (p.agent_id === node.expected_identity || p.endpoint === node.endpoint));
      const online = !!(peer && peer.online);
      const disabled = !!(peer && peer.disabled);
      const lastSeen = peer ? formatRelative(peer.last_seen_at) : '';
      return rowHtml({
        name: node.label,
        badgeHtml: badge(disabled ? 'off' : online ? 'on' : 'off', t(disabled ? 'dashboard.node_disabled' : online ? 'dashboard.node_online' : 'dashboard.node_offline')),
        sub: [
          node.endpoint,
          lastSeen ? `${t('dashboard.last_seen')}：${lastSeen}` : '',
        ].filter(Boolean).join(' · '),
        subMono: false,
        detail: detailGrid([
          [t('dashboard.form_endpoint'), node.endpoint],
          [t('dashboard.detail_identity'), node.expected_identity || '—'],
          [t('dashboard.detail_last_seen'), lastSeen],
          [t('dashboard.detail_locality'), t('dashboard.locality_external')],
        ]) + `<div class="dash-detail-edit"><button type="button" class="btn btn-sm" data-dash-action="edit-node" data-id="${esc(node.id)}">${esc(t('dashboard.edit_node'))}</button></div>`,
        actions: `${peer ? `<button type="button" class="btn btn-sm" data-dash-action="toggle-node" data-agent-id="${esc(node.expected_identity || '')}" data-disabled="${disabled ? '1' : ''}">${esc(t(disabled ? 'dashboard.enable_node' : 'dashboard.disable_node'))}</button>` : ''}
          <button type="button" class="btn btn-sm" data-dash-action="test-node" data-id="${esc(node.id)}">${esc(t('dashboard.test'))}</button>
          <button type="button" class="btn btn-sm btn-danger" data-dash-action="remove-node" data-id="${esc(node.id)}">${esc(t('dashboard.remove'))}</button>`,
      });
    }).join('');
  }

  // 渠道即节点（第三期）：运行中的 messaging 渠道实例也注册为 P3394
  // 花名册节点，在总览里可见（设计三期验收："出现在花名册与 Dashboard"）。
  function renderChannels(data) {
    const box = el('dash-channel-list');
    if (!box) return;
    const instances = data.channels || [];
    const enabled = instances.filter((i) => i && i.enabled);
    if (!instances.length) {
      box.innerHTML = `<div class="dash-empty">${esc(t('dashboard.channels_empty'))}</div>`;
      return;
    }
    const bridgePeers = (data.external.peers || []).filter((p) => p && p.node_kind === 'channel_bridge');
    box.innerHTML = instances.map((instance) => {
      const connected = instance.status && instance.status.kind === 'connected';
      const bridgeAgentId = `channel-${instance.id}`;
      const bridged = bridgePeers.some((p) => p.agent_id === bridgeAgentId);
      const statusKey = !instance.enabled ? 'dashboard.channel_disabled'
        : connected ? 'dashboard.channel_connected' : 'dashboard.channel_offline';
      const badgeKind = !instance.enabled || !connected ? 'off' : 'on';
      return rowHtml({
        name: instance.displayName || instance.platform,
        badgeHtml: badge(badgeKind, t(statusKey)),
        sub: [
          instance.platform,
          bridged ? t('dashboard.channel_bridged') : '',
        ].filter(Boolean).join(' · '),
        detail: detailGrid([
          [t('dashboard.detail_platform'), instance.platform],
          [t('dashboard.detail_instance_id'), instance.id],
          [t('dashboard.detail_status'), instance.status && instance.status.kind],
          [t('dashboard.detail_p3394_node'), bridged ? bridgeAgentId : '—'],
        ]),
        actions: `<button type="button" class="btn btn-sm" data-dash-action="manage-channel">${esc(t('dashboard.channel_manage'))}</button>`,
      });
    }).join('');
    if (enabled.length) {
      // 供 Dashboard 数据消费说明：启用中的实例同时是渠道桥节点候选
      box.dataset.bridgedCount = String(bridgePeers.length);
    }
  }

  function render(data) {
    _lastData = data;
    renderControl(data);
    renderBuiltin(data);
    renderLocal(data);
    renderRemote(data);
    renderChannels(data);
  }

  async function refresh(force) {
    try {
      const data = await fetchDashboardData(force);
      render(data);
    } catch (err) {
      _dashLog.warn?.('dashboard refresh failed', { error: (err && err.message) || String(err) });
    }
  }

  // ── 远端添加表单 ──
  function resetRemoteForm() {
    ['dash-remote-label', 'dash-remote-endpoint', 'dash-remote-token', 'dash-remote-identity'].forEach((id) => {
      const input = el(id);
      if (input) input.value = '';
    });
    const status = el('dash-remote-status');
    if (status) { status.textContent = ''; status.className = 'dash-form-status'; }
  }

  async function submitRemoteForm(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const label = el('dash-remote-label')?.value?.trim() || '';
    const endpoint = el('dash-remote-endpoint')?.value?.trim() || '';
    const token = el('dash-remote-token')?.value?.trim() || '';
    const identity = el('dash-remote-identity')?.value?.trim() || '';
    const status = el('dash-remote-status');
    const submitBtn = el('dash-remote-submit');
    const setStatus = (kind, text) => { if (status) { status.textContent = text; status.className = `dash-form-status ${kind}`; } };
    if (!endpoint || !token) {
      setStatus('err', t('dashboard.remote_form_missing'));
      return;
    }
    setStatus('pending', t('dashboard.remote_testing'));
    if (submitBtn) submitBtn.disabled = true;
    try {
      const test = await window.cogseed.invoke('p3394.remote.test', {
        endpoint, token, expected_identity: identity || undefined,
      });
      if (!test || !test.ok) {
        setStatus('err', (test && test.error && test.error.message) || t('dashboard.remote_test_failed'));
        return;
      }
      const added = await window.cogseed.invoke('p3394.remote.add', {
        label, endpoint, token, expected_identity: identity || test.peer_agent_id,
      });
      if (!added || !added.ok) {
        setStatus('err', (added && added.error && added.error.message) || t('dashboard.remote_add_failed'));
        return;
      }
      setStatus('ok', t('dashboard.remote_added', { id: test.peer_agent_id }));
      if (typeof uiToast === 'function') uiToast(t('dashboard.remote_added', { id: test.peer_agent_id }));
      resetRemoteForm();
      const formWrapper = el('dash-remote-form');
      if (formWrapper) formWrapper.open = false;
      refresh(false);
    } catch (err) {
      setStatus('err', (err && err.message) || String(err));
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  // 编辑远端节点提交（G-15）：token 留空保留原值；改 endpoint 后提示重测。
  async function submitEditNodeForm(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const form = event.target;
    if (!form || !form.matches('.dash-edit-form')) return;
    const id = form.dataset.dashEditId;
    const node = (_lastData?.remote.nodes || []).find((n) => n.id === id);
    if (!node) return;
    const status = form.querySelector('.dash-form-status');
    const setStatus = (kind, text) => { if (status) { status.textContent = text; status.className = `dash-form-status ${kind}`; } };
    const val = (name) => form.querySelector(`[name="${name}"]`)?.value?.trim() || '';
    const payload = { id };
    if (val('label') && val('label') !== node.label) payload.label = val('label');
    if (val('endpoint') && val('endpoint') !== node.endpoint) payload.endpoint = val('endpoint');
    if (val('token')) payload.token = val('token');
    if (val('expected_identity') !== (node.expected_identity || '')) payload.expected_identity = val('expected_identity');
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await window.cogseed.invoke('p3394.remote.update', payload);
      if (!res || !res.ok) {
        setStatus('err', (res && res.error && res.error.message) || t('dashboard.edit_failed'));
        return;
      }
      setStatus('ok', t('dashboard.edit_saved'));
      if (typeof uiToast === 'function') uiToast(t('dashboard.edit_saved'));
      await new Promise((r) => setTimeout(r, 600));
      await refresh(false);
    } catch (err) {
      setStatus('err', (err && err.message) || String(err));
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  // ── 事件代理 ──
  function onDashboardClick(event) {
    const button = event.target.closest('[data-dash-action]');
    if (!button) return;
    const action = button.dataset.dashAction;
    if (action === 'toggle-detail') {
      const wrap = button.closest('.dash-row-wrap');
      if (wrap) wrap.classList.toggle('is-open');
    } else if (action === 'edit-node') {
      // 展开行并在详情尾部挂编辑表单（只挂一个；重复点击不重复挂）
      const wrap = button.closest('.dash-row-wrap');
      const node = (_lastData?.remote.nodes || []).find((n) => n.id === button.dataset.id);
      if (!wrap || !node) return;
      wrap.classList.add('is-open');
      const detailEl = wrap.querySelector('.dash-row-detail');
      if (detailEl && !detailEl.querySelector('.dash-edit-form')) {
        const holder = document.createElement('div');
        holder.innerHTML = editFormHtml(node);
        detailEl.appendChild(holder.firstChild);
      }
    } else if (action === 'cancel-edit') {
      const form = button.closest('.dash-edit-form');
      if (form) form.remove();
    } else if (action === 'manage-channel') {
      // 渠道实例管理在「连接 → 触点」面板：跳过去并切到触点 tab。
      if (typeof window.setView === 'function') window.setView('connections');
      const tab = document.querySelector('[data-connections-tab="touchpoints"]');
      if (tab) tab.click();
    } else if (action === 'open-agents') {
      if (typeof window.setView === 'function') window.setView('agents');
    } else if (action === 'add-local') {
      // 打开现有创建弹窗的外接 tab（agents.js 的 openAgentModal）
      if (typeof window.openAgentModal === 'function') window.openAgentModal({ initialTab: 'external' });
    } else if (action === 'toggle-gateway') {
      const cli = button.dataset.cli;
      const stop = button.dataset.running === '1';
      button.disabled = true;
      window.cogseed.invoke(stop ? 'p3394.external.stop' : 'p3394.external.start', { cli })
        .catch((err) => {
          _dashLog.warn?.('gateway toggle failed', { cli, error: err?.message });
          if (typeof uiToast === 'function') uiToast((err && err.message) || t('dashboard.gateway_toggle_failed'));
        })
        .finally(() => refresh(false));
    } else if (action === 'test-node') {
      const node = (_lastData?.remote.nodes || []).find((n) => n.id === button.dataset.id);
      if (!node) return;
      button.disabled = true;
      button.classList.add('is-loading');
      window.cogseed.invoke('p3394.remote.test', { id: node.id }).then((res) => {
        const msg = res && res.ok
          ? t('dashboard.test_ok', { id: res.peer_agent_id })
          : ((res && res.error && res.error.message) || t('dashboard.test_failed'));
        if (typeof uiToast === 'function') uiToast(msg);
      }).finally(() => {
        button.disabled = false;
        button.classList.remove('is-loading');
        refresh(false);
      });
    } else if (action === 'toggle-node') {
      // 节点停用/启用（花名册维度，不删配置）：停用后不再被派发。
      const agentId = button.dataset.agentId;
      const nextDisabled = button.dataset.disabled !== '1';
      if (!agentId) return;
      button.disabled = true;
      window.cogseed.invoke('p3394.peers.toggle', { agentId, disabled: nextDisabled })
        .then((res) => {
          if (!res || !res.ok) {
            if (typeof uiToast === 'function') uiToast((res && res.error) || t('dashboard.node_toggle_failed'));
          }
        })
        .catch((err) => {
          if (typeof uiToast === 'function') uiToast((err && err.message) || t('dashboard.node_toggle_failed'));
        })
        .finally(() => refresh(false));
    } else if (action === 'remove-node') {
      const id = button.dataset.id;
      const doRemove = () => window.cogseed.invoke('p3394.remote.remove', { id }).then(() => refresh(false));
      if (typeof uiConfirm === 'function') {
        uiConfirm({ message: t('dashboard.remove_confirm') }).then((ok) => { if (ok) doRemove(); });
      } else {
        doRemove();
      }
    } else if (action === 'wake-decide') {
      // 控制中心（T3）：跨会话 wake 审批——批准恢复派发、拒绝终止。
      const requestId = button.dataset.requestId;
      const cid = button.dataset.cid;
      const decision = button.dataset.decision;
      if (!requestId || !cid || !decision) return;
      if (decision === 'reject' && typeof uiConfirm === 'function') {
        uiConfirm({ message: t('dashboard.control_reject_confirm') }).then((ok) => { if (ok) doWakeDecide(); });
      } else {
        doWakeDecide();
      }
      function doWakeDecide() {
        button.disabled = true;
        window.cogseed.invoke('p3394.decideWakeRequest', { cid, requestId, decision })
          .then((res) => {
            if (!res || !res.ok) {
              if (typeof uiToast === 'function') uiToast((res && res.error && res.error.message) || t('p3394.wake.failed'));
              button.disabled = false;
              return;
            }
            if (typeof uiToast === 'function') uiToast(t(decision === 'approve' ? 'dashboard.control_decided_approve' : 'dashboard.control_decided_reject'));
            refresh(false);
          })
          .catch((err) => {
            if (typeof uiToast === 'function') uiToast((err && err.message) || t('p3394.wake.failed'));
            button.disabled = false;
          });
      }
    }
  }

  function renderDashboard() {
    const panel = el('panel-dashboard');
    if (!panel) return;
    if (!panel.dataset.wired) {
      panel.dataset.wired = '1';
      panel.addEventListener('click', onDashboardClick);
      // 行展开的键盘可达性：role=button 的行按 Enter/Space 等价点击。
      panel.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest?.('[data-dash-action="toggle-detail"]');
        if (row && row === event.target) {
          event.preventDefault();
          row.click();
        }
      });
      const form = el('dash-remote-form');
      if (form) form.addEventListener('submit', submitRemoteForm);
      // 编辑表单是动态插入的，submit 委托到面板层
      panel.addEventListener('submit', (event) => {
        if (event.target && event.target.matches && event.target.matches('.dash-edit-form')) {
          void submitEditNodeForm(event);
        }
      });
      const refreshBtn = el('dash-refresh-btn');
      if (refreshBtn) refreshBtn.addEventListener('click', () => refresh(true));
      // 切换语言时重渲染 JS 生成的行（HTML 部分由 applyDomI18n 处理）
      window.addEventListener('i18n-change', () => { if (_lastData) render(_lastData); });
    }
    refresh(false);
  }

  window.renderDashboard = renderDashboard;
})();
