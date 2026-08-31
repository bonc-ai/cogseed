// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// The overview derives aggregate signals exclusively from the privacy-filtered
// board projection. Raw prompts, tool arguments, outputs, and paths never enter
// this renderer module.
(function initCogSeedRunCenterOverview(root) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const SOURCE_ORDER = ['cogseed', 'agent', 'local-cli', 'p3394-gateway', 'agent-conversation', 'group-chat'];
  let chartInstance = null;
  let chartPayload = null;

  function validDate(value) {
    const date = new Date(String(value || ''));
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function localDayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function runDate(run, field, order) {
    const values = run.members.map((task) => String(task?.[field] || '')).filter(Boolean).sort();
    const value = order === 'first' ? values[0] : values.at(-1);
    return validDate(value || run.aggregateTask?.[field]);
  }

  function buildOverview(projection, agents, nowValue) {
    const board = root.CogSeedRunCenterBoard;
    const runs = board?.buildRunModels ? board.buildRunModels(projection) : [];
    const tasks = runs.map((run) => run.aggregateTask);
    const now = validDate(nowValue) || new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const userStateForTask = (task) => board?.userStateForTask?.(task) || { attention: task.column === 'attention' };
    const counts = {
      total: runs.length,
      sessions: new Set(tasks.map((task) => task.sessionId).filter(Boolean)).size,
      active: tasks.filter((task) => !userStateForTask(task).attention
        && (task.column === 'pending' || task.column === 'running')).length,
      attention: tasks.filter((task) => userStateForTask(task).attention).length,
      completed: tasks.filter((task) => task.status === 'completed').length,
    };
    const terminalCount = tasks.filter((task) => ['completed', 'failed', 'cancelled'].includes(task.status)).length;
    counts.successRate = terminalCount ? Math.round((counts.completed / terminalCount) * 100) : null;

    const statusCounts = ['pending', 'running', 'attention', 'completed', 'archived'].map((column) => ({
      column,
      count: tasks.filter((task) => (board?.displayColumnForTask?.(task) || task.column) === column).length,
    })).filter((item) => item.count > 0);

    const trend = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start.getTime() - ((6 - index) * DAY_MS));
      return { key: localDayKey(date), date, started: 0, completed: 0, attention: 0 };
    });
    const trendByKey = new Map(trend.map((item) => [item.key, item]));
    for (const run of runs) {
      const started = runDate(run, 'createdAt', 'first');
      const updated = runDate(run, 'updatedAt', 'last');
      const startedBucket = started ? trendByKey.get(localDayKey(started)) : null;
      const updatedBucket = updated ? trendByKey.get(localDayKey(updated)) : null;
      if (startedBucket) startedBucket.started += 1;
      if (updatedBucket && run.aggregateTask.column === 'completed') updatedBucket.completed += 1;
      if (updatedBucket && userStateForTask(run.aggregateTask).attention) updatedBucket.attention += 1;
    }

    const discoveredSources = new Set(tasks.map((task) => task.sourceKind || 'cogseed'));
    const sourceOrder = [...SOURCE_ORDER, ...[...discoveredSources].filter((source) => !SOURCE_ORDER.includes(source)).sort()];
    const sources = sourceOrder.map((source) => ({
      source,
      count: tasks.filter((task) => (task.sourceKind || 'cogseed') === source).length,
    })).filter((item) => item.count > 0);

    const installedAgents = (Array.isArray(agents) ? agents : [])
      .filter((agent) => agent.enabled !== false && agent.interaction_mode !== 'management_only');
    const agentNames = new Map(installedAgents.map((agent) => {
      const id = agent.agentId || agent.agent_id;
      return [id, agent.displayName || agent.name || id];
    }).filter(([id]) => id));
    const agentMap = new Map();
    for (const task of tasks) {
      const agentId = task.agentId || '';
      if (!agentId) continue;
      const current = agentMap.get(agentId) || {
        agentId,
        name: agentNames.get(agentId) || '',
        total: 0,
        active: 0,
        attention: 0,
        completed: 0,
        updatedAt: '',
      };
      current.total += 1;
      const displayColumn = board?.displayColumnForTask?.(task) || task.column;
      if (displayColumn === 'pending' || displayColumn === 'running') current.active += 1;
      if (displayColumn === 'attention') current.attention += 1;
      if (displayColumn === 'completed') current.completed += 1;
      if (String(task.updatedAt || '') > current.updatedAt) current.updatedAt = String(task.updatedAt || '');
      agentMap.set(agentId, current);
    }
    const agentLoad = Array.from(agentMap.values()).sort((left, right) =>
      right.active - left.active
      || right.attention - left.attention
      || right.total - left.total
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.name.localeCompare(right.name));

    const recentRuns = [...runs].sort((left, right) =>
      String(right.aggregateTask.updatedAt || '').localeCompare(String(left.aggregateTask.updatedAt || ''))
      || String(left.key || '').localeCompare(String(right.key || '')));
    const attentionRuns = recentRuns.filter((run) => userStateForTask(run.aggregateTask).attention);
    const activeRuns = recentRuns.filter((run) => !userStateForTask(run.aggregateTask).attention
      && ['pending', 'running'].includes(run.aggregateTask.column));
    const completedRuns = recentRuns.filter((run) => !userStateForTask(run.aggregateTask).attention
      && run.aggregateTask.column === 'completed');
    return {
      runs,
      counts,
      statusCounts,
      trend,
      sources,
      installedAgentCount: installedAgents.length,
      participatingAgentCount: agentLoad.length,
      agentLoad: agentLoad.slice(0, 6),
      attentionRuns: attentionRuns.slice(0, 5),
      activeRuns: activeRuns.slice(0, 5),
      completedRuns: completedRuns.slice(0, 5),
      attentionTasks: attentionRuns.slice(0, 5).map((run) => run.aggregateTask),
      recentTasks: recentRuns.slice(0, 6).map((run) => run.aggregateTask),
      updatedAt: projection?.updatedAt || '',
    };
  }

  function render(projection, agents, options) {
    const { text, esc, icon, statusKey, formatDate, formatDay, stateView } = options;
    if (options.loading) return stateView('run_center.overview_loading');
    if (options.error) return stateView('run_center.overview_failed', options.error);
    const model = buildOverview(projection, agents, options.now);
    if (!model.counts.total) return stateView('run_center.overview_empty');

    const maximumSource = Math.max(1, ...model.sources.map((item) => item.count));
    const successRate = model.counts.successRate == null ? text('run_center.overview_not_available') : `${model.counts.successRate}%`;
    const metric = (iconName, value, label, tone) => `<div class="run-center-overview-metric is-${tone}">
      <span class="run-center-overview-metric-icon">${icon(iconName)}</span><div><strong>${esc(value)}</strong><span>${esc(text(label))}</span></div>
    </div>`;
    const board = root.CogSeedRunCenterBoard;
    const sequences = board?.buildRunSequence?.(model.runs) || new Map();
    const taskButton = (run, kind) => {
      const task = run.aggregateTask;
      const display = board?.displayRun?.(run, options, sequences.get(run.key)) || {
        title: text('run_center.task_kind_cogseed'),
        sequence: { index: 1, count: 1 },
        userState: board?.userStateForTask?.(task) || { stateKey: statusKey(task.status), reasonKey: '' },
      };
      const sequence = text('run_center.run_sequence', display.sequence);
      return `<button type="button" class="run-center-overview-task is-${esc(kind)}" data-run-center-overview-task="${esc(task.taskId)}" data-run-center-overview-session="${esc(task.sessionId)}">
        <span class="run-center-user-state is-${esc(display.userState.kind || kind)}">${esc(text(display.userState.stateKey))}</span>
        <strong>${esc(display.title)}</strong>
        <time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time>
        <small>${sequence ? `${esc(sequence)} · ` : ''}${esc(display.agent || options.agentName(task.agentId) || text('run_center.commander'))}</small>
        ${kind === 'attention' && display.userState.reasonKey ? `<span class="run-center-overview-task-reason">${esc(text(display.userState.reasonKey))}</span>` : ''}
      </button>`;
    };
    const statusTotal = Math.max(1, model.statusCounts.reduce((sum, item) => sum + item.count, 0));
    const attentionState = model.counts.attention > 0
      ? ['warning', 'run_center.overview_health_attention', 'run_center.overview_health_attention_detail']
      : model.counts.active > 0
        ? ['active', 'run_center.overview_health_active', 'run_center.overview_health_active_detail']
        : ['stable', 'run_center.overview_health_stable', 'run_center.overview_health_stable_detail'];
    const legendItems = [
      ['started', 'run_center.overview_trend_started'],
      ['completed', 'run_center.overview_trend_completed'],
      ['attention', 'run_center.overview_trend_attention'],
    ];
    chartPayload = {
      labels: model.trend.map((item) => formatDay(item.date)),
      datasets: legendItems.map(([field, label]) => ({ field, label: text(label), data: model.trend.map((item) => item[field]) })),
    };
    const fallbackRows = model.trend.map((item) => `<tr><th scope="row">${esc(formatDay(item.date))}</th><td>${esc(item.started)}</td><td>${esc(item.completed)}</td><td>${esc(item.attention)}</td></tr>`).join('');

    return `<div class="run-center-overview">
      <section class="run-center-overview-health is-${attentionState[0]}">
        <span>${icon(attentionState[0] === 'warning' ? 'warning' : attentionState[0] === 'active' ? 'activity' : 'check-circle')}</span>
        <div><strong>${esc(text(attentionState[1]))}</strong><p>${esc(text(attentionState[2], { active: model.counts.active, attention: model.counts.attention }))}</p></div>
        ${model.updatedAt ? `<time>${esc(text('run_center.overview_updated', { time: formatDate(model.updatedAt) }))}</time>` : ''}
      </section>
      <div class="run-center-overview-now">
        <section class="run-center-overview-section is-priority run-center-overview-attention-queue">
          <header><div><h2>${esc(text('run_center.overview_attention'))}</h2><p>${esc(text('run_center.overview_attention_detail'))}</p></div>${model.counts.attention ? `<button type="button" class="run-center-overview-link" data-run-center-overview-filter="attention">${esc(text('run_center.overview_view_attention'))}<b>${esc(model.counts.attention)}</b></button>` : ''}</header>
          ${model.attentionRuns.length ? `<div class="run-center-overview-task-list">${model.attentionRuns.map((run) => taskButton(run, 'attention')).join('')}</div>` : `<p class="run-center-overview-good">${icon('check-circle')}${esc(text('run_center.overview_no_attention'))}</p>`}
        </section>
        <section class="run-center-overview-section is-active">
          <header><div><h2>${esc(text('run_center.overview_running'))}</h2><p>${esc(text('run_center.overview_running_detail'))}</p></div><span>${esc(model.counts.active)}</span></header>
          ${model.activeRuns.length ? `<div class="run-center-overview-task-list">${model.activeRuns.map((run) => taskButton(run, 'active')).join('')}</div>` : `<p class="run-center-overview-muted">${esc(text('run_center.overview_no_running'))}</p>`}
        </section>
        <section class="run-center-overview-section is-completed">
          <header><div><h2>${esc(text('run_center.overview_completed'))}</h2><p>${esc(text('run_center.overview_completed_detail'))}</p></div></header>
          ${model.completedRuns.length ? `<div class="run-center-overview-task-list">${model.completedRuns.map((run) => taskButton(run, 'completed')).join('')}</div>` : `<p class="run-center-overview-muted">${esc(text('run_center.overview_no_completed'))}</p>`}
        </section>
      </div>
      <details class="run-center-overview-analysis"${options.analysisOpen ? ' open' : ''}>
        <summary><span>${icon('activity')}<b>${esc(text('run_center.overview_analysis'))}</b><small>${esc(text('run_center.overview_analysis_detail'))}</small></span>${icon('chevron-down')}</summary>
        <div class="run-center-overview-analysis-body">
        <div class="run-center-overview-metrics">
          ${metric('panel-list', model.counts.total, 'run_center.overview_total_tasks', 'neutral')}
          ${metric('activity', model.counts.active, 'run_center.overview_active_tasks', 'active')}
          ${metric('warning', model.counts.attention, 'run_center.overview_attention_tasks', 'warning')}
          ${metric('check-circle', successRate, 'run_center.overview_success_rate', 'success')}
        </div>
        <div class="run-center-overview-grid is-analysis">
        <section class="run-center-overview-section is-wide run-center-overview-activity-panel">
          <header><div><h2>${esc(text('run_center.overview_activity'))}</h2><p>${esc(text('run_center.overview_activity_detail'))}</p></div><span>${esc(text('run_center.overview_seven_days'))}</span></header>
          <div class="run-center-overview-chart-frame"><canvas data-run-center-overview-chart role="img" aria-label="${esc(text('run_center.overview_chart_aria'))}"></canvas></div>
          <ul class="run-center-overview-chart-legend">${legendItems.map(([field, label]) => `<li class="is-${field}"><i></i><span>${esc(text(label))}</span></li>`).join('')}</ul>
          <details class="run-center-overview-chart-fallback" data-run-center-overview-chart-fallback><summary>${esc(text('run_center.overview_table_toggle'))}</summary><table><caption>${esc(text('run_center.overview_chart_aria'))}</caption><thead><tr><th scope="col">${esc(text('run_center.overview_trend_day'))}</th>${legendItems.map(([, label]) => `<th scope="col">${esc(text(label))}</th>`).join('')}</tr></thead><tbody>${fallbackRows}</tbody></table></details>
        </section>
        <section class="run-center-overview-section">
          <header><div><h2>${esc(text('run_center.overview_status_distribution'))}</h2><p>${esc(text('run_center.overview_status_detail'))}</p></div></header>
          <div class="run-center-overview-statuses">${model.statusCounts.map((item) => `<button type="button" class="is-${esc(item.column)}" data-run-center-overview-filter="${esc(item.column)}"><span><i class="is-${esc(item.column)}"></i>${esc(text(`run_center.column_${item.column}`))}</span><b>${esc(item.count)}</b><small><i style="width:${Math.round((item.count / statusTotal) * 100)}%"></i></small></button>`).join('')}</div>
        </section>
        <section class="run-center-overview-section">
          <header><div><h2>${esc(text('run_center.overview_sources'))}</h2><p>${esc(text('run_center.overview_sources_detail'))}</p></div></header>
          <div class="run-center-overview-sources">${model.sources.map((item) => `<button type="button" data-run-center-overview-source="${esc(item.source)}"><span>${esc(text(`run_center.source_${item.source}`))}</span><b>${esc(item.count)}</b><small><i style="width:${Math.round((item.count / maximumSource) * 100)}%"></i></small></button>`).join('')}</div>
        </section>
        <section class="run-center-overview-section is-wide">
          <header><div><h2>${esc(text('run_center.overview_agent_load'))}</h2><p>${esc(text('run_center.overview_agent_load_detail', { participating: model.participatingAgentCount, installed: model.installedAgentCount }))}</p></div></header>
          ${model.agentLoad.length ? `<div class="run-center-overview-agents">${model.agentLoad.map((agent) => { const name = agent.name || options.agentName(agent.agentId) || text('run_center.assigned_agent'); return `<button type="button" data-run-center-overview-agent="${esc(agent.agentId)}"><span class="run-center-overview-agent-mark">${esc(String(name).slice(0, 1).toLocaleUpperCase())}</span><strong>${esc(name)}</strong><span>${esc(text('run_center.overview_agent_active', { count: agent.active }))}</span><span class="${agent.attention ? 'is-warning' : ''}">${esc(text('run_center.overview_agent_attention', { count: agent.attention }))}</span><b>${esc(text('run_center.overview_agent_total', { count: agent.total }))}</b></button>`; }).join('')}</div>` : `<p class="run-center-overview-muted">${esc(text('run_center.overview_no_agent_activity'))}</p>`}
        </section>
        </div>
        </div>
      </details>
    </div>`;
  }

  function alphaColor(color, alpha) {
    const value = String(color || '').trim();
    const hex = value.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const number = Number.parseInt(hex[1], 16);
      return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
    }
    const rgb = value.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
    if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
    return value || 'transparent';
  }

  function destroy() {
    if (!chartInstance) return;
    try { chartInstance.destroy(); } catch { /* Detached canvases are safe to discard. */ }
    chartInstance = null;
  }

  function revealFallback(scope, canvas) {
    if (canvas) canvas.hidden = true;
    const fallback = scope?.querySelector?.('[data-run-center-overview-chart-fallback]');
    if (fallback) fallback.open = true;
  }

  function mount(container) {
    destroy();
    const scope = container || document;
    const canvas = scope?.querySelector?.('[data-run-center-overview-chart]');
    if (!canvas || !chartPayload || typeof root.Chart !== 'function') {
      revealFallback(scope, canvas);
      return null;
    }
    try {
      const styles = typeof root.getComputedStyle === 'function' ? root.getComputedStyle(canvas) : null;
      const color = (name, fallback) => styles?.getPropertyValue(name).trim() || fallback;
      const palette = {
        started: color('--rc-running', '#3976a8'),
        completed: color('--rc-complete', '#157f7a'),
        attention: color('--rc-attention', '#c24e43'),
      };
      const reducedMotion = root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('chart_context_unavailable');
      chartInstance = new root.Chart(context, {
        type: 'line',
        data: {
          labels: chartPayload.labels,
          datasets: chartPayload.datasets.map((dataset) => ({
            label: dataset.label,
            data: dataset.data,
            borderColor: palette[dataset.field],
            backgroundColor: alphaColor(palette[dataset.field], dataset.field === 'started' ? 0.16 : 0.08),
            borderWidth: dataset.field === 'started' ? 2 : 1.5,
            pointRadius: 2,
            pointHoverRadius: 4,
            fill: true,
            tension: 0.28,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: reducedMotion ? false : { duration: 260 },
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: color('--rc-muted', '#617168') } },
            y: { beginAtZero: true, ticks: { precision: 0, color: color('--rc-muted', '#617168') }, grid: { color: alphaColor(color('--rc-line', '#d9e2dd'), 0.55) } },
          },
        },
      });
      canvas.hidden = false;
      return chartInstance;
    } catch {
      destroy();
      revealFallback(scope, canvas);
      return null;
    }
  }

  root.CogSeedRunCenterOverview = Object.freeze({ buildOverview, render, mount, destroy });
})(window);
