(function mateWorkbenchModule() {
  'use strict';

  let projection = null;
  let busy = false;
  let bound = false;
  let loadError = '';

  function host() { return document.getElementById('mate-workbench'); }
  function text(key, fallback, vars) {
    return typeof t === 'function' ? t(key, vars) : fallback;
  }
  function escape(value) {
    const node = document.createElement('div');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  }
  function statusLabel(state) {
    return text(`mate_workbench.state.${state}`, state);
  }
  function severityClass(severity) { return `is-${severity}`; }

  function renderEmpty(title, detail) {
    return `<div class="mate-workbench-empty"><strong>${escape(title)}</strong><span>${escape(detail)}</span></div>`;
  }

  function renderAttention(items) {
    if (!items.length) return renderEmpty(text('mate_workbench.empty_attention', 'Mate 暂时没有需要提醒你的事情。'), text('mate_workbench.empty_attention_detail', '新的变化会出现在这里。'));
    return items.map((item) => `<article class="mate-workbench-card mate-workbench-attention ${severityClass(item.severity)}">
      <div class="mate-workbench-card-top"><span class="mate-workbench-eyebrow">${escape(text(`mate_workbench.attention.${item.kind}`, item.kind))}</span><span class="mate-workbench-severity">${escape(item.severity)}</span></div>
      <h3>${escape(item.title)}</h3><p>${escape(item.detail)}</p>
      ${item.action ? `<button class="btn btn-sm btn-primary" data-mw-action="${escape(item.action)}">${escape(text('mate_workbench.open', '处理'))}</button>` : ''}
    </article>`).join('');
  }

  function renderTimeline(items) {
    if (!items.length) return renderEmpty(text('mate_workbench.empty_timeline', '还没有安排中的触达。'), text('mate_workbench.empty_timeline_detail', 'Mate 会把重要的下一步放在这里。'));
    return items.map((item) => `<article class="mate-workbench-timeline-item">
      <div class="mate-workbench-timeline-dot"></div><div class="mate-workbench-timeline-body"><div class="mate-workbench-card-top"><strong>${escape(item.title)}</strong><span class="mate-workbench-status">${escape(statusLabel(item.state))}</span></div><p>${escape(new Date(item.scheduledAt).toLocaleString())} · ${escape(item.channel)}</p></div>
    </article>`).join('');
  }

  function renderDecisions(items) {
    if (!items.length) return renderEmpty(text('mate_workbench.empty_decisions', '没有待确认事项。'), text('mate_workbench.empty_decisions_detail', 'Mate 会先保留来源和证据，再请你决定。'));
    return items.map((item) => `<article class="mate-workbench-card mate-workbench-decision"><div class="mate-workbench-card-top"><span class="mate-workbench-eyebrow">${escape(text('mate_workbench.decision_label', '需要你决定'))}</span><span>${escape(item.confidence)}</span></div><h3>${escape(item.title)}</h3><p>${escape(item.detail)}</p><button class="btn btn-sm" data-mw-action="cognition.review">${escape(text('mate_workbench.review', '查看并确认'))}</button></article>`).join('');
  }

  function renderRunning(items) {
    if (!items.length) return renderEmpty(text('mate_workbench.empty_running', '目前没有正在执行的触点任务。'), text('mate_workbench.empty_running_detail', 'Agent 执行或消息投递开始后会显示进度。'));
    return items.map((item) => `<article class="mate-workbench-card mate-workbench-running"><div class="mate-workbench-card-top"><span class="mate-workbench-eyebrow">${escape(text('mate_workbench.running_label', '正在进行'))}</span><span>${escape(statusLabel(item.state))}</span></div><h3>${escape(item.title)}</h3><p>${escape(item.detail)}</p><div class="mate-workbench-progress"><span style="width:${Math.min(92, 18 + item.attempts * 18)}%"></span></div></article>`).join('');
  }

  function render() {
    const root = host();
    if (!root) return;
    if (busy && !projection) {
      root.innerHTML = `<div class="mate-workbench-loading"><span class="spinner"></span>${escape(text('mate_workbench.loading', 'Mate 正在整理今天的状态…'))}</div>`;
      return;
    }
    if (!projection) {
      root.innerHTML = renderEmpty(loadError || text('mate_workbench.no_projection', '还没有工作台状态。'), loadError ? text('mate_workbench.load_failed_detail', '检查桌面端连接后重试。') : text('mate_workbench.no_projection_detail', '刷新后重试。'));(text('mate_workbench.no_projection', '还没有工作台状态。'), text('mate_workbench.no_projection_detail', '刷新后重试。'));
      return;
    }
    const touchpoint = projection.touchpoints[0];
    root.innerHTML = `<div class="mate-workbench-header"><div><span class="mate-workbench-kicker">${escape(text('mate_workbench.kicker', 'MATE DESKTOP'))}</span><h1>${escape(text('mate_workbench.title', '今天，Mate 在替你留意什么'))}</h1><p>${escape(text('mate_workbench.subtitle', '桌面端是认知中心，飞书是你离开电脑后的移动触点。'))}</p></div><div class="mate-workbench-connection ${touchpoint.connected ? 'is-connected' : 'is-disconnected'}"><span class="mate-workbench-connection-dot"></span><span>${escape(touchpoint.connected ? text('mate_workbench.feishu_connected', '飞书已连接') : text('mate_workbench.feishu_disconnected', '飞书未连接'))}</span></div></div>
      <div class="mate-workbench-grid"><section class="mate-workbench-section mate-workbench-section-wide"><div class="mate-workbench-section-heading"><h2>${escape(text('mate_workbench.section.attention', 'Mate 注意到的事情'))}</h2><button class="btn btn-sm" data-mw-action="refresh">${escape(text('mate_workbench.refresh', '刷新'))}</button></div><div class="mate-workbench-attention-grid">${renderAttention(projection.sections.attention)}</div></section>
      <section class="mate-workbench-section"><div class="mate-workbench-section-heading"><h2>${escape(text('mate_workbench.section.timeline', '接下来'))}</h2></div><div class="mate-workbench-timeline">${renderTimeline(projection.sections.timeline)}</div></section>
      <section class="mate-workbench-section"><div class="mate-workbench-section-heading"><h2>${escape(text('mate_workbench.section.decisions', '需要你决定'))}</h2></div><div class="mate-workbench-list">${renderDecisions(projection.sections.decisions)}</div></section>
      <section class="mate-workbench-section mate-workbench-section-wide"><div class="mate-workbench-section-heading"><h2>${escape(text('mate_workbench.section.running', '正在进行'))}</h2></div><div class="mate-workbench-attention-grid">${renderRunning(projection.sections.running)}</div></section></div>`;
  }

  async function refresh() {
    busy = true; loadError = ''; render();
    try {
      const result = await invoke('desktop_workbench.get', {});
      if (!result || !result.projection) throw new Error(text('mate_workbench.load_failed', '无法读取 Mate 工作台状态。'));
      projection = result.projection;
    } catch (error) {
      projection = null;
      loadError = error && error.message ? error.message : text('mate_workbench.load_failed', '无法读取 Mate 工作台状态。');
    } finally {
      busy = false; render();
    }
  }

  function bind() {
    if (bound) return;
    const root = host();
    if (!root) return;
    bound = true;
    root.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('[data-mw-action]') : null;
      if (!button) return;
      const action = button.dataset.mwAction;
      if (action === 'refresh') void refresh();
      else if (action === 'cognition.review') window._setViewFromSidebar ? window._setViewFromSidebar('personal-ontology') : setView('personal-ontology');
      else if (action === 'cognition.sync') { invoke('personal_context.sync.start', {}).then(() => refresh()).catch((error) => { loadError = error.message || String(error); render(); }); }
      else if (action === 'briefing.preview' || action === 'touchpoint.feishu.connect' || action === 'cognition.authorize') {
        setView('settings');
        if (typeof activateSettingsTab === 'function') activateSettingsTab('messaging');
      }
    });
    window.addEventListener('i18n-change', render);
  }

  window.initMateWorkbench = async function initMateWorkbench() {
    bind();
    await refresh();
  };

  window.MateWorkbench = Object.freeze({ refresh, render });
}());
