// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// The Run Center renders only privacy-filtered CogSeed projections. Prompts,
// model payloads, tool arguments, file paths, and secrets never reach this UI.
(function initCogSeedRunCenter(rootWindow) {
  'use strict';

  const state = {
    view: 'board',
    filter: 'all',
    search: '',
    showArchived: false,
    board: null,
    sessions: [],
    detail: null,
    selectedTaskId: '',
    selectedSessionId: '',
    loading: false,
    error: '',
    busyAction: '',
    bound: false,
  };

  function panel() { return document.getElementById('run-center-root'); }
  function text(key, vars) { return typeof t === 'function' ? t(key, vars) : key; }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function formatDate(value) {
    const date = new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return text('run_center.unknown_time');
    return new Intl.DateTimeFormat(typeof getLang === 'function' ? getLang() : undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }
  function statusKey(status) { return `run_center.status_${String(status || 'created')}`; }
  function statusClass(status) { return `run-center-status is-${String(status || 'created').replace(/[^a-z_]/g, '')}`; }
  function localizedTitle(item, fallback) {
    const key = String(item?.titleKey || '');
    const label = key ? text(key) : '';
    return label && label !== key ? label : String(item?.title || fallback || '');
  }
  function dynamicLabel(prefix, value, fallbackKey) {
    const key = `${prefix}${String(value || '').replace(/\./g, '_')}`;
    const label = text(key);
    return label && label !== key ? label : text(fallbackKey);
  }
  function stateView(key, detail) {
    return `<div class="run-center-empty">${esc(text(key))}${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
  }
  function selectedTask() {
    return (state.board?.tasks || []).find((task) => task.taskId === state.selectedTaskId) || null;
  }
  function selectedSession() {
    return state.sessions.find((session) => session.sessionId === state.selectedSessionId) || null;
  }
  function invoke(channel, payload) {
    if (!rootWindow.cogseed?.invoke) return Promise.reject(new Error(text('run_center.ipc_unavailable')));
    return rootWindow.cogseed.invoke(channel, payload || {}).then((result) => {
      if (result?.ok === false) throw new Error(result.error || text('run_center.load_failed'));
      return result;
    });
  }
  function taskTree(tasks) {
    const byParent = new Map();
    for (const task of tasks || []) {
      const parent = task.parentTaskId || '';
      const children = byParent.get(parent) || [];
      children.push(task);
      byParent.set(parent, children);
    }
    const renderItems = (parentId) => (byParent.get(parentId) || []).map((task) => `<li>
      <button type="button" class="run-center-tree-task${task.taskId === state.selectedTaskId ? ' is-selected' : ''}" data-run-center-task="${esc(task.taskId)}" data-run-center-session="${esc(task.sessionId)}">
        <span class="${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span>
        <strong>${esc(localizedTitle(task, task.taskId))}</strong>
      </button>${byParent.has(task.taskId) ? `<ul>${renderItems(task.taskId)}</ul>` : ''}
    </li>`).join('');
    const roots = (tasks || []).filter((task) => !task.parentTaskId || !byParent.has(task.parentTaskId));
    if (!roots.length) return stateView('run_center.tasks_empty');
    const firstLevel = roots.map((task) => `<li>
      <button type="button" class="run-center-tree-task${task.taskId === state.selectedTaskId ? ' is-selected' : ''}" data-run-center-task="${esc(task.taskId)}" data-run-center-session="${esc(task.sessionId)}">
        <span class="${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span>
        <strong>${esc(localizedTitle(task, task.taskId))}</strong>
      </button>${byParent.has(task.taskId) ? `<ul>${renderItems(task.taskId)}</ul>` : ''}
    </li>`).join('');
    return `<ul class="run-center-task-tree">${firstLevel}</ul>`;
  }
  function boardHtml() {
    if (!rootWindow.CogSeedRunCenterBoard) return stateView('run_center.loading');
    return rootWindow.CogSeedRunCenterBoard.render(state.board, {
      text, esc, icon: () => '', statusKey, statusClass: (value) => statusClass(value), formatDate, stateView,
      loading: state.loading, error: state.error, search: state.search, filter: state.filter,
      selectedTaskId: state.selectedTaskId, showArchived: state.showArchived,
    });
  }
  function runsHtml() {
    if (state.error) return stateView('run_center.load_failed', state.error);
    const detail = state.detail?.collaboration;
    if (!detail) return stateView(state.loading ? 'run_center.loading_detail' : 'run_center.select_session');
    return `<div class="run-center-runs">
      <section><h2>${esc(text('run_center.tasks'))}</h2>${taskTree(detail.tasks)}</section>
      <section><h2>${esc(text('run_center.timeline'))}</h2>${timelineHtml(detail.timeline)}</section>
    </div>`;
  }
  function timelineHtml(events) {
    if (!Array.isArray(events) || !events.length) return stateView('run_center.timeline_empty');
    return `<ol class="run-center-timeline">${events.map((event) => `<li>
      <time>${esc(formatDate(event.createdAt))}</time><span>${esc(dynamicLabel('run_center.event_', event.type, 'run_center.event_unknown'))}</span>
      ${event.toolName ? `<small>${esc(event.toolName)}</small>` : ''}${event.errorCode ? `<small>${esc(event.errorCode)}</small>` : ''}
    </li>`).join('')}</ol>`;
  }
  function collaborationHtml() {
    if (state.error) return stateView('run_center.load_failed', state.error);
    const detail = state.detail?.collaboration;
    if (!detail) return stateView(state.loading ? 'run_center.loading_detail' : 'run_center.select_collaboration');
    const workflow = detail.workflow || {};
    const actors = Array.isArray(detail.actors) ? detail.actors : [];
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const activity = Array.isArray(detail.activity) ? detail.activity : [];
    return `<div class="run-center-collaboration">
      <section><h2>${esc(text('run_center.team'))}</h2>${actors.length ? `<ul class="run-center-actors">${actors.map((actor) => `<li><strong>${esc(actor.displayName || actor.actorId)}</strong><span>${esc(text(`run_center.actor_${actor.role}`))}</span><span class="${statusClass(actor.status)}">${esc(text(statusKey(actor.status)))}</span></li>`).join('')}</ul>` : stateView('run_center.agents_empty')}</section>
      <section><h2>${esc(text('run_center.workflow'))}</h2>${steps.length ? `<ol class="run-center-steps">${steps.map((step) => `<li><div><strong>${esc(localizedTitle(step, step.stepId))}</strong><span class="${statusClass(step.status)}">${esc(text(statusKey(step.status)))}</span></div><small>${esc(text('run_center.attempt_count', { count: step.attemptCount || 0 }))}${step.failureCode ? ` · ${esc(step.failureCode)}` : ''}</small>${step.dependsOn?.length ? `<small>${esc(text('run_center.depends_on'))}: ${esc(step.dependsOn.join(', '))}</small>` : ''}</li>`).join('')}</ol>` : stateView('run_center.workflow_empty')}</section>
      <section><h2>${esc(text('run_center.collaboration_activity'))}</h2>${activity.length ? `<ol class="run-center-timeline">${activity.map((event) => `<li><time>${esc(formatDate(event.createdAt))}</time><span>${esc(dynamicLabel('run_center.activity_', event.type, 'run_center.activity_unknown'))}</span></li>`).join('')}</ol>` : stateView('run_center.collaboration_activity_empty')}</section>
    </div>`;
  }
  function detailsHtml() {
    const task = state.detail?.collaboration?.task || selectedTask();
    const actions = state.detail?.collaboration?.actions || task?.actions || {};
    if (!task) return stateView('run_center.select_item');
    const busy = state.busyAction;
    const taskActions = [
      actions.retry ? ['retry', 'run_center.retry'] : null,
      actions.resume ? ['resume', 'run_center.resume'] : null,
      actions.abort ? ['abort', 'run_center.abort'] : null,
    ].filter(Boolean).map(([action, label]) => `<button type="button" class="btn btn-sm${action === 'abort' ? ' btn-danger' : ''}" data-run-center-action="${action}" ${busy ? 'disabled' : ''}>${esc(text(busy === action ? 'run_center.action_working' : label))}</button>`).join('');
    return `<div class="run-center-detail">
      <div class="run-center-detail-heading"><span class="${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span><h2>${esc(localizedTitle(task, task.taskId))}</h2></div>
      <dl><div><dt>${esc(text('run_center.label_task_id'))}</dt><dd>${esc(task.taskId)}</dd></div><div><dt>${esc(text('run_center.label_updated'))}</dt><dd>${esc(formatDate(task.updatedAt))}</dd></div>${task.agentId ? `<div><dt>${esc(text('run_center.label_agent'))}</dt><dd>${esc(task.agentId)}</dd></div>` : ''}${task.errorCode ? `<div><dt>${esc(text('run_center.label_error_code'))}</dt><dd>${esc(task.errorCode)}</dd></div>` : ''}${task.executionKind ? `<div><dt>${esc(text('run_center.label_execution'))}</dt><dd>${esc(task.executionKind)}</dd></div>` : ''}</dl>
      <div class="run-center-detail-actions">${taskActions}${task.conversationId ? `<button type="button" class="btn btn-sm" data-run-center-open="${esc(task.conversationId)}">${esc(text('run_center.open_task'))}</button>` : ''}</div>
    </div>`;
  }
  function sessionsHtml() {
    if (state.loading && !state.sessions.length) return stateView('run_center.loading');
    const query = state.search.trim().toLocaleLowerCase();
    const sessions = state.sessions.filter((session) => !query || [localizedTitle(session), session.sessionId, session.latestTaskId].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(query)));
    if (!sessions.length) return stateView(query ? 'run_center.no_matches' : 'run_center.empty');
    return `<div class="run-center-session-list">${sessions.map((session) => `<button type="button" class="run-center-session${session.sessionId === state.selectedSessionId ? ' is-selected' : ''}" data-run-center-session="${esc(session.sessionId)}" data-run-center-task="${esc(session.latestTaskId || '')}"><strong>${esc(localizedTitle(session, session.sessionId))}</strong><span class="${statusClass(session.latestStatus)}">${esc(text(statusKey(session.latestStatus)))}</span><time>${esc(formatDate(session.updatedAt))}</time></button>`).join('')}</div>`;
  }
  function render() {
    const target = panel();
    if (!target) return;
    const viewHtml = state.view === 'board' ? boardHtml() : state.view === 'runs' ? runsHtml() : collaborationHtml();
    target.innerHTML = `<div class="run-center-shell">
      <header class="run-center-header"><div><h1>${esc(text('run_center.title'))}</h1><p>${esc(text('run_center.subtitle'))}</p></div><button type="button" class="btn btn-sm" data-run-center-refresh>${esc(text('run_center.refresh'))}</button></header>
      <div class="run-center-tools"><div class="run-center-view-tabs" role="tablist">${[['board', 'run_center.view_board'], ['runs', 'run_center.view_runs'], ['collaboration', 'run_center.view_collaboration']].map(([view, label]) => `<button type="button" class="run-center-tab${state.view === view ? ' is-active' : ''}" data-run-center-view="${view}">${esc(text(label))}</button>`).join('')}</div><input type="search" value="${esc(state.search)}" data-run-center-search placeholder="${esc(text('run_center.search_placeholder'))}" aria-label="${esc(text('run_center.search_placeholder'))}"><div class="run-center-filters">${['all', 'running', 'attention', 'completed'].map((filter) => `<button type="button" class="run-center-filter${state.filter === filter ? ' is-active' : ''}" data-run-center-filter="${filter}">${esc(text(`run_center.filter_${filter}`))}</button>`).join('')}</div></div>
      <div class="run-center-layout"><aside class="run-center-sessions"><h2>${esc(text('run_center.sessions'))}</h2>${sessionsHtml()}</aside><main class="run-center-main">${viewHtml}</main><aside class="run-center-details">${detailsHtml()}</aside></div>
    </div>`;
  }
  async function select(sessionId, taskId) {
    state.selectedSessionId = String(sessionId || '');
    state.selectedTaskId = String(taskId || '');
    state.detail = null;
    state.error = '';
    render();
    if (!state.selectedSessionId) return;
    try {
      const detail = await invoke('cogseed.session.read', { sessionId: state.selectedSessionId, taskId: state.selectedTaskId || undefined });
      state.detail = detail;
      if (detail?.collaboration?.task?.taskId) state.selectedTaskId = detail.collaboration.task.taskId;
    } catch (error) {
      state.error = error?.message || String(error);
    }
    render();
  }
  async function refresh() {
    state.loading = true;
    state.error = '';
    render();
    try {
      const [board, sessionResult] = await Promise.all([invoke('cogseed.task.list'), invoke('cogseed.session.list')]);
      state.board = board;
      state.sessions = Array.isArray(sessionResult?.sessions) ? sessionResult.sessions : [];
      const task = selectedTask() || state.board?.tasks?.[0];
      if (task && (!state.selectedTaskId || !state.selectedSessionId)) await select(task.sessionId, task.taskId);
    } catch (error) {
      state.error = error?.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }
  async function action(action) {
    const task = selectedTask() || state.detail?.collaboration?.task;
    if (!task) return;
    if (action === 'abort' && !rootWindow.confirm(text('run_center.abort_confirm'))) return;
    state.busyAction = action;
    render();
    try {
      const payload = { taskId: task.taskId, action };
      if (action !== 'abort') payload.requestId = `req-run-center-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await invoke('cogseed.task.action', payload);
      await refresh();
      await select(task.sessionId, task.taskId);
    } catch (error) {
      state.error = error?.message || String(error);
    } finally {
      state.busyAction = '';
      render();
    }
  }
  function bind() {
    const target = panel();
    if (!target || state.bound) return;
    state.bound = true;
    target.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.runCenterRefresh !== undefined) { refresh(); return; }
      if (button.dataset.runCenterView) { state.view = button.dataset.runCenterView; render(); return; }
      if (button.dataset.runCenterFilter) { state.filter = button.dataset.runCenterFilter; render(); return; }
      if (button.dataset.dashboardArchiveToggle !== undefined) { state.showArchived = !state.showArchived; render(); return; }
      const taskId = button.dataset.runCenterTask || button.dataset.dashboardBoardTaskId;
      const sessionId = button.dataset.runCenterSession || button.dataset.dashboardBoardSessionId;
      if (sessionId) { select(sessionId, taskId); return; }
      if (button.dataset.runCenterAction) { action(button.dataset.runCenterAction); return; }
      if (button.dataset.runCenterOpen) { rootWindow.setView?.('conversation', button.dataset.runCenterOpen); }
    });
    target.addEventListener('input', (event) => {
      if (event.target.matches('[data-run-center-search]')) { state.search = event.target.value || ''; render(); }
    });
    rootWindow.addEventListener('i18n-change', () => render());
  }
  rootWindow.renderRunCenter = function renderRunCenter() { bind(); refresh(); };
})(window);
