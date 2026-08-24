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
    const [externalRes, remoteRes, agentsRes] = await Promise.all([
      window.cogseed.invoke('p3394.external.list', { force: force === true }),
      window.cogseed.invoke('p3394.remote.list', {}),
      window.cogseed.invoke('agents.list', {}).catch(() => null),
    ]);
    return {
      external: externalRes || { entries: [], gateways: [], bound: {}, peers: [] },
      remote: remoteRes || { nodes: [] },
      agents: (agentsRes && agentsRes.agents) || [],
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

  function rowHtml({ name, badgeHtml, sub, subMono, actions }) {
    return `<div class="dash-row">
      <div class="dash-row-main">
        <div class="dash-row-name">${esc(name)}${badgeHtml || ''}</div>
        ${sub ? `<div class="dash-row-sub${subMono ? ' dash-mono' : ''}">${esc(sub)}</div>` : ''}
      </div>
      <div class="dash-row-actions">${actions || ''}</div>
    </div>`;
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
      return rowHtml({
        name: entry.displayName || entry.type,
        badgeHtml: badge(running ? 'on' : 'off', t(running ? 'dashboard.gateway_running' : 'dashboard.gateway_offline')),
        sub: boundNames ? `${t('dashboard.bound_agents')}：${boundNames}` : '',
        actions: `<button type="button" class="btn btn-sm" data-dash-action="toggle-gateway" data-cli="${esc(entry.type)}" data-running="${running ? '1' : ''}">${running ? esc(t('dashboard.stop')) : esc(t('dashboard.start'))}</button>`,
      });
    }).join('');
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
      return rowHtml({
        name: node.label,
        badgeHtml: badge(online ? 'on' : 'off', t(online ? 'dashboard.node_online' : 'dashboard.node_offline')),
        sub: node.endpoint,
        subMono: true,
        actions: `<button type="button" class="btn btn-sm" data-dash-action="test-node" data-id="${esc(node.id)}">${esc(t('dashboard.test'))}</button>
          <button type="button" class="btn btn-sm btn-danger" data-dash-action="remove-node" data-id="${esc(node.id)}">${esc(t('dashboard.remove'))}</button>`,
      });
    }).join('');
  }

  function render(data) {
    _lastData = data;
    renderBuiltin(data);
    renderLocal(data);
    renderRemote(data);
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

  // ── 事件代理 ──
  function onDashboardClick(event) {
    const button = event.target.closest('[data-dash-action]');
    if (!button) return;
    const action = button.dataset.dashAction;
    if (action === 'open-agents') {
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
    } else if (action === 'remove-node') {
      const id = button.dataset.id;
      const doRemove = () => window.cogseed.invoke('p3394.remote.remove', { id }).then(() => refresh(false));
      if (typeof uiConfirm === 'function') {
        uiConfirm({ message: t('dashboard.remove_confirm') }).then((ok) => { if (ok) doRemove(); });
      } else {
        doRemove();
      }
    }
  }

  function renderDashboard() {
    const panel = el('panel-dashboard');
    if (!panel) return;
    if (!panel.dataset.wired) {
      panel.dataset.wired = '1';
      panel.addEventListener('click', onDashboardClick);
      const form = el('dash-remote-form');
      if (form) form.addEventListener('submit', submitRemoteForm);
      const refreshBtn = el('dash-refresh-btn');
      if (refreshBtn) refreshBtn.addEventListener('click', () => refresh(true));
      // 切换语言时重渲染 JS 生成的行（HTML 部分由 applyDomI18n 处理）
      window.addEventListener('i18n-change', () => { if (_lastData) render(_lastData); });
    }
    refresh(false);
  }

  window.renderDashboard = renderDashboard;
})();
