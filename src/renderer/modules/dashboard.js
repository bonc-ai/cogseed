// ─── 智能体总览 Dashboard（第二期）───────────────────────────────────────
// 内置（戏服智能体，只读概览跳现有智能体页）/ 外接·本机（CLI+托管网关）/
// 外接·远端（P3394 remote nodes）三分区统一总览。数据一次往返：
// p3394.external.list + p3394.remote.list + agents.list。
// 懒加载入口：boot.js setView('dashboard') → _loadViewFeature('dashboard')。

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

  function statusDot(online) {
    return `<span class="dash-dot ${online ? 'dash-dot-on' : 'dash-dot-off'}"></span>`;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function rowHtml({ name, sub, online, actions }) {
    return `<div class="dash-row">
      <div class="dash-row-main">
        <div class="dash-row-name">${statusDot(online)}<span>${esc(name)}</span></div>
        ${sub ? `<div class="dash-row-sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="dash-row-actions">${actions || ''}</div>
    </div>`;
  }

  function renderBuiltin(data) {
    const box = el('dash-builtin-list');
    if (!box) return;
    const count = builtinCount(data.agents);
    box.innerHTML = rowHtml({
      name: t('dashboard.builtin_section', '内置智能体'),
      sub: t('dashboard.builtin_count', '{count} 位成员 · 由 CogSeed 本体扮演', { count }),
      online: true,
      actions: `<button class="dash-btn" data-dash-action="open-agents">${esc(t('dashboard.view_agents', '查看'))}</button>`,
    });
  }

  function renderLocal(data) {
    const box = el('dash-local-list');
    if (!box) return;
    const entries = (data.external.entries || []).filter((e) => e && e.available);
    const gateways = data.external.gateways || [];
    const bound = data.external.bound || {};
    if (!entries.length) {
      box.innerHTML = `<div class="dash-empty">${esc(t('dashboard.local_empty', '未检测到本机 CLI（Claude Code / Codex 等）'))}</div>`;
      return;
    }
    box.innerHTML = entries.map((entry) => {
      const gw = gateways.find((g) => g && g.cli === entry.type);
      const running = !!(gw && gw.running);
      const boundNames = (bound[entry.type] || []).join('、');
      return rowHtml({
        name: entry.displayName || entry.type,
        sub: [
          running ? t('dashboard.gateway_running', '网关运行中') : t('dashboard.gateway_offline', '网关未运行'),
          boundNames ? `${t('dashboard.bound_agents', '已绑定')}：${boundNames}` : '',
        ].filter(Boolean).join(' · '),
        online: running,
        actions: `<button class="dash-btn" data-dash-action="toggle-gateway" data-cli="${esc(entry.type)}" data-running="${running ? '1' : ''}">${running ? esc(t('dashboard.stop', '停止')) : esc(t('dashboard.start', '启动'))}</button>`,
      });
    }).join('');
  }

  function renderRemote(data) {
    const box = el('dash-remote-list');
    if (!box) return;
    const nodes = (data.remote.nodes) || [];
    if (!nodes.length) {
      box.innerHTML = `<div class="dash-empty">${esc(t('dashboard.remote_empty', '还没有远端节点 — 添加一台其它电脑上的智能体'))}</div>`;
      return;
    }
    const peers = data.external.peers || [];
    box.innerHTML = nodes.map((node) => {
      const peer = peers.find((p) => p && (p.agent_id === node.expected_identity || p.endpoint === node.endpoint));
      const online = !!(peer && peer.online);
      return rowHtml({
        name: node.label,
        sub: [
          node.endpoint,
          online ? t('dashboard.node_online', '在线') : t('dashboard.node_offline', '离线'),
        ].join(' · '),
        online,
        actions: `<button class="dash-btn" data-dash-action="test-node" data-id="${esc(node.id)}">${esc(t('dashboard.test', '测试'))}</button>
          <button class="dash-btn dash-btn-danger" data-dash-action="remove-node" data-id="${esc(node.id)}">${esc(t('dashboard.remove', '移除'))}</button>`,
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

  async function submitRemoteForm() {
    const label = el('dash-remote-label')?.value?.trim() || '';
    const endpoint = el('dash-remote-endpoint')?.value?.trim() || '';
    const token = el('dash-remote-token')?.value?.trim() || '';
    const identity = el('dash-remote-identity')?.value?.trim() || '';
    const status = el('dash-remote-status');
    const setStatus = (kind, text) => { if (status) { status.textContent = text; status.className = `dash-form-status ${kind}`; } };
    if (!endpoint || !token) {
      setStatus('err', t('dashboard.remote_form_missing', '地址与令牌必填'));
      return;
    }
    setStatus('pending', t('dashboard.remote_testing', '正在连接对端节点…'));
    try {
      const test = await window.cogseed.invoke('p3394.remote.test', {
        endpoint, token, expected_identity: identity || undefined,
      });
      if (!test || !test.ok) {
        setStatus('err', (test && test.error && test.error.message) || t('dashboard.remote_test_failed', '连接失败'));
        return;
      }
      const added = await window.cogseed.invoke('p3394.remote.add', {
        label, endpoint, token, expected_identity: identity || test.peer_agent_id,
      });
      if (!added || !added.ok) {
        setStatus('err', (added && added.error && added.error.message) || t('dashboard.remote_add_failed', '保存失败'));
        return;
      }
      setStatus('ok', t('dashboard.remote_added', '已添加（对端身份：{id}）', { id: test.peer_agent_id }));
      resetRemoteForm();
      refresh(false);
    } catch (err) {
      setStatus('err', (err && err.message) || String(err));
    }
  }

  // ── 事件代理 ──
  function onDashboardClick(event) {
    const button = event.target.closest('[data-dash-action]');
    if (!button) return;
    const action = button.dataset.dashAction;
    if (action === 'open-agents') {
      if (typeof window.setView === 'function') window.setView('agents');
      else if (typeof setView === 'function') setView('agents');
    } else if (action === 'add-local') {
      // 打开现有创建弹窗的外接 tab（agents.js 的 openAgentModal）
      if (typeof window.openAgentModal === 'function') window.openAgentModal({ initialTab: 'external' });
    } else if (action === 'toggle-gateway') {
      const cli = button.dataset.cli;
      const stop = button.dataset.running === '1';
      window.cogseed.invoke(stop ? 'p3394.external.stop' : 'p3394.external.start', { cli })
        .then(() => refresh(false))
        .catch((err) => _dashLog.warn?.('gateway toggle failed', { cli, error: err?.message }));
    } else if (action === 'test-node') {
      const node = (_lastData?.remote.nodes || []).find((n) => n.id === button.dataset.id);
      if (!node) return;
      button.disabled = true;
      window.cogseed.invoke('p3394.remote.test', { id: node.id }).then((res) => {
        window.alert?.(res && res.ok
          ? t('dashboard.test_ok', '连接正常（对端身份：{id}）', { id: res.peer_agent_id })
          : (res && res.error && res.error.message) || t('dashboard.test_failed', '连接失败'));
      }).finally(() => { button.disabled = false; refresh(false); });
    } else if (action === 'remove-node') {
      const id = button.dataset.id;
      if (!window.confirm?.(t('dashboard.remove_confirm', '确定移除这个远端节点吗？'))) return;
      window.cogseed.invoke('p3394.remote.remove', { id }).then(() => refresh(false));
    }
  }

  function renderDashboard() {
    const panel = el('panel-dashboard');
    if (!panel) return;
    if (!panel.dataset.wired) {
      panel.dataset.wired = '1';
      panel.addEventListener('click', onDashboardClick);
      const submit = el('dash-remote-submit');
      if (submit) submit.addEventListener('click', submitRemoteForm);
      const refreshBtn = el('dash-refresh-btn');
      if (refreshBtn) refreshBtn.addEventListener('click', () => refresh(true));
    }
    refresh(false);
  }

  window.renderDashboard = renderDashboard;
})();
