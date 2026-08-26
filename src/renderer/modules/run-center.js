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
    // Set when an action's convergence window expired without the runtime
    // confirming it (RC-P1-03). Never used to fake a status — only to tell the
    // user the snapshot on screen may not reflect their action yet.
    unconfirmedAction: '',
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
  // Absolute timestamps all look alike on a wall of cards ("Aug 26 09:41"
  // six times over). Relative time is what actually separates this run from
  // the one before it at a glance (RC-P0-13 / DECISION-01).
  function formatRelative(value) {
    const ts = new Date(String(value || '')).getTime();
    if (!Number.isFinite(ts)) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return text('dashboard.ago_seconds', { n: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return text('dashboard.ago_minutes', { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return text('dashboard.ago_hours', { n: hr });
    return text('dashboard.ago_days', { n: Math.floor(hr / 24) });
  }
  // Card identity (RC-P0-13). Deliberately built only from projection fields
  // that survived the privacy review — ordinals, ids, timestamps. No prompt,
  // objective, step result or first message ever reaches this string
  // (DECISION-01 rejected candidate C for that reason).
  function identityParts(task) {
    if (!task) return [];
    const run = task.runOrdinal ? text('run_center.identity_run', { n: task.runOrdinal }) : '';
    const turn = task.turnOrdinal ? text('run_center.identity_turn', { n: task.turnOrdinal }) : '';
    const conversation = task.conversationShortId || '';
    const agent = task.agentId || '';
    // Relative time qualifies an identity but cannot be one on its own: the
    // card already carries a timestamp, so a projection with no ordinals (a
    // legacy record, or a single-task reply with no session context) would
    // otherwise render a second copy of it and call that identity.
    if (!run && !turn && !conversation && !agent) return [];
    return [run, turn, formatRelative(task.createdAt || task.updatedAt), conversation, agent].filter(Boolean);
  }
  function identityLabel(task) { return identityParts(task).join(' \u00b7 '); }
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
    const items = Array.isArray(tasks) ? tasks : [];
    const byParent = new Map();
    for (const task of items) {
      const parent = task.parentTaskId || '';
      const children = byParent.get(parent) || [];
      children.push(task);
      byParent.set(parent, children);
    }
    // A task is a root when its parent is not in this projection — which is
    // what the old `byParent.has(task.parentTaskId)` test failed to express:
    // `byParent`'s keys are registered by the *children*, so that lookup was
    // true for every task that had a parent at all. A turn whose parent run
    // had aged out therefore matched neither branch and vanished from the
    // tree entirely, while still showing on the board (RC-P2-20).
    const present = new Set(items.map((task) => task.taskId));
    const isRoot = (task) => !task.parentTaskId || !present.has(task.parentTaskId);

    const item = (task, seen, flat) => {
      // Cyclic `parentTaskId` links cannot arise from normal writes, but the
      // store is plain JSON on disk and the backend guards the same hazard
      // (`cogSeedTaskIdentity`, `applyCogSeedTaskWindow`). Recursing without a
      // guard would hang the renderer rather than degrade.
      if (seen.has(task.taskId)) return '';
      const nested = new Set(seen).add(task.taskId);
      const children = flat ? [] : (byParent.get(task.taskId) || []);
      const orphan = !!task.parentTaskId && !present.has(task.parentTaskId);
      return `<li>
      <button type="button" class="run-center-tree-task${task.taskId === state.selectedTaskId ? ' is-selected' : ''}" data-run-center-task="${esc(task.taskId)}" data-run-center-session="${esc(task.sessionId)}">
        <span class="${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span>
        <strong>${esc(localizedTitle(task, task.taskId))}</strong>
        ${identityLabel(task) ? `<small data-run-center-identity="${esc(task.taskId)}">${esc(identityLabel(task))}</small>` : ''}
        ${orphan ? `<small class="run-center-tree-orphan" data-run-center-orphan="${esc(task.parentTaskId)}">${esc(text('run_center.parent_run_unavailable'))}</small>` : ''}
      </button>${children.length ? `<ul>${children.map((child) => item(child, nested, flat)).join('')}</ul>` : ''}
    </li>`;
    };

    // Nothing that exists may disappear: if every task claims a present parent
    // (only reachable through a cycle), fall back to rendering them flat
    // rather than showing an empty state over real data.
    const roots = items.filter(isRoot);
    if (!items.length) return stateView('run_center.tasks_empty');
    // Degenerate hierarchy (only reachable through a cycle): there is no tree
    // to show, so list every task once at top level rather than blanking the
    // view or printing each of them twice.
    const [top, flat] = roots.length ? [roots, false] : [items, true];
    return `<ul class="run-center-task-tree">${top.map((task) => item(task, new Set(), flat)).join('')}</ul>`;
  }
  function boardHtml() {
    if (!rootWindow.CogSeedRunCenterBoard) return stateView('run_center.loading');
    return rootWindow.CogSeedRunCenterBoard.render(state.board, {
      text, esc, icon: () => '', statusKey, statusClass: (value) => statusClass(value), formatDate, stateView, identityLabel,
      // Only show the board's loading placeholder on the very first load. Once
      // there are cards to show, a refresh must leave them on screen rather
      // than replacing the whole board with a spinner (RC-P0-01; and a hard
      // requirement for the RC-P0-02 poll, which would otherwise strobe).
      loading: state.loading && !state.board, error: state.error, search: state.search, filter: state.filter,
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
      <time>${esc(formatDate(event.createdAt))}</time><span>${esc(dynamicLabel('run_center.event_', event.type, 'run_center.event_unknown'))}</span>${event.isError ? `<span class="run-center-event-error" data-run-center-event-error="${esc(event.errorCode || '')}">${esc(text('run_center.event_failed'))}</span>` : ''}
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
    // RC-P1-18: `reviews` / `conflicts` were computed by the backend and never
    // rendered. Both are structured (ids, enum states, timestamps) — a review
    // gate awaiting a decision, or an unresolved conflict, is exactly the kind
    // of "needs a human" signal the collaboration view exists to surface.
    const reviews = Array.isArray(detail.reviews) ? detail.reviews : [];
    const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts : [];
    return `<div class="run-center-collaboration">
      <section><h2>${esc(text('run_center.team'))}</h2>${actors.length ? `<ul class="run-center-actors">${actors.map((actor) => `<li><strong>${esc(actor.displayName || actor.actorId)}</strong><span>${esc(text(`run_center.actor_${actor.role}`))}</span><span class="${statusClass(actor.status)}">${esc(text(statusKey(actor.status)))}</span></li>`).join('')}</ul>` : stateView('run_center.agents_empty')}</section>
      <section><h2>${esc(text('run_center.workflow'))}</h2>${steps.length ? `<ol class="run-center-steps">${steps.map((step) => `<li><div><strong>${esc(localizedTitle(step, step.stepId))}</strong><span class="${statusClass(step.status)}">${esc(text(statusKey(step.status)))}</span></div><small>${esc(text('run_center.attempt_count', { count: step.attemptCount || 0 }))}${step.failureCode ? ` · ${esc(step.failureCode)}` : ''}</small>${step.dependsOn?.length ? `<small>${esc(text('run_center.depends_on'))}: ${esc(step.dependsOn.join(', '))}</small>` : ''}</li>`).join('')}</ol>` : stateView('run_center.workflow_empty')}</section>
      <section data-run-center-reviews="${reviews.length}"><h2>${esc(text('run_center.reviews'))}</h2>${reviews.length ? `<ul class="run-center-reviews">${reviews.map((review) => `<li data-run-center-review="${esc(review.gateId)}">
        <div><strong>${esc(text(review.nameKey || 'run_center.review_gate'))}</strong><span class="${statusClass(review.status)}">${esc(dynamicLabel('run_center.review_status_', review.status, 'run_center.review_status_unknown'))}</span></div>
        <small>${esc(text('run_center.label_step'))}: ${esc(review.stepId)}${review.reviewDecision ? ` · ${esc(dynamicLabel('run_center.review_decision_', review.reviewDecision, 'run_center.review_status_unknown'))}` : ''}${review.reviewedBy ? ` · ${esc(review.reviewedBy)}` : ''}</small>
        <time datetime="${esc(review.reviewedAt || review.createdAt)}">${esc(formatDate(review.reviewedAt || review.createdAt))}</time>
      </li>`).join('')}</ul>` : stateView('run_center.reviews_empty')}</section>
      <section data-run-center-conflicts="${conflicts.length}"><h2>${esc(text('run_center.conflicts'))}</h2>${conflicts.length ? `<ul class="run-center-conflicts">${conflicts.map((conflict) => `<li data-run-center-conflict="${esc(conflict.conflictId)}">
        <div><strong>${esc(dynamicLabel('run_center.conflict_type_', conflict.type, 'run_center.conflict_type_unknown'))}</strong><span class="${statusClass(conflict.status)}">${esc(dynamicLabel('run_center.conflict_status_', conflict.status, 'run_center.review_status_unknown'))}</span></div>
        ${conflict.affectedStepIds?.length ? `<small>${esc(text('run_center.affected_steps', { count: conflict.affectedStepIds.length }))}: ${esc(conflict.affectedStepIds.join(', '))}</small>` : ''}
        <time datetime="${esc(conflict.updatedAt || conflict.createdAt)}">${esc(formatDate(conflict.updatedAt || conflict.createdAt))}</time>
      </li>`).join('')}</ul>` : stateView('run_center.conflicts_empty')}</section>
      <section><h2>${esc(text('run_center.collaboration_activity'))}</h2>${activity.length ? `<ol class="run-center-timeline">${activity.map((event) => `<li><time>${esc(formatDate(event.createdAt))}</time><span>${esc(dynamicLabel('run_center.activity_', event.type, 'run_center.activity_unknown'))}</span></li>`).join('')}</ol>` : stateView('run_center.collaboration_activity_empty')}</section>
    </div>`;
  }
  // RC-P1-18: `recovery` was computed and never rendered. After Phase 2 a
  // group-chat task never reaches `recoverable` (it lands on failed +
  // app_restart), so this speaks for CogSeed-native tasks — where `resume` is
  // a real action and the user deserves to know the session has work waiting
  // for it. Structured only: a boolean, task ids, a timestamp.
  function recoveryNote() {
    const recovery = state.detail?.collaboration?.recovery;
    const taskIds = Array.isArray(recovery?.taskIds) ? recovery.taskIds : [];
    if (!recovery?.recoverable || !taskIds.length) return '';
    const when = recovery.lastEventAt ? formatDate(recovery.lastEventAt) : '';
    return `<p class="run-center-note" data-run-center-recovery="${esc(taskIds.length)}">${esc(text('run_center.recovery_available', { count: taskIds.length }))}${when ? ` <small>${esc(when)}</small>` : ''}</p>`;
  }
  function detailsHtml() {
    const task = state.detail?.collaboration?.task || selectedTask();
    const actions = state.detail?.collaboration?.actions || task?.actions || {};
    if (!task) return stateView('run_center.select_item');
    const busy = state.busyAction;
    // `waiting_user` is the one state where the exit *is* the action: the run
    // paused for the user, and the only place they can answer is the
    // conversation. There is deliberately no new backend action here — the
    // Run Center cannot resume a run, and pretending otherwise is the mistake
    // RC-P0-05 exists to avoid (RC-P1-08).
    const waitingForUser = task.status === 'waiting_user' && !!task.conversationId;
    const taskActions = [
      actions.retry ? ['retry', 'run_center.retry'] : null,
      actions.resume ? ['resume', 'run_center.resume'] : null,
      actions.abort ? ['abort', 'run_center.abort'] : null,
    ].filter(Boolean).map(([action, label]) => `<button type="button" class="btn btn-sm${action === 'abort' ? ' btn-danger' : ''}" data-run-center-action="${action}" ${busy ? 'disabled' : ''}>${esc(text(busy === action ? 'run_center.action_working' : label))}</button>`).join('');
    return `<div class="run-center-detail">
      <div class="run-center-detail-heading"><span class="${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span><h2>${esc(localizedTitle(task, task.taskId))}</h2></div>
      <dl><div><dt>${esc(text('run_center.label_task_id'))}</dt><dd>${esc(task.taskId)}</dd></div><div><dt>${esc(text('run_center.label_updated'))}</dt><dd>${esc(formatDate(task.updatedAt))}</dd></div>${task.agentId ? `<div><dt>${esc(text('run_center.label_agent'))}</dt><dd>${esc(task.agentId)}</dd></div>` : ''}${task.errorCode ? `<div><dt>${esc(text('run_center.label_error_code'))}</dt><dd>${esc(task.errorCode)}</dd></div>` : ''}${task.retryOfTaskId ? `<div><dt>${esc(text('run_center.label_retry_of'))}</dt><dd data-run-center-retry-of="${esc(task.retryOfTaskId)}">${esc(task.retryOfTaskId)}</dd></div>` : ''}${task.executionKind ? `<div><dt>${esc(text('run_center.label_execution'))}</dt><dd>${esc(task.executionKind)}</dd></div>` : ''}${identityLabel(task) ? `<div><dt>${esc(text('run_center.label_identity'))}</dt><dd data-run-center-identity="${esc(task.taskId)}">${esc(identityLabel(task))}</dd></div>` : ''}</dl>
      <div class="run-center-detail-actions">${taskActions}${task.conversationId ? `<button type="button" class="btn btn-sm${waitingForUser ? ' btn-primary' : ''}" data-run-center-open="${esc(task.conversationId)}"${waitingForUser ? ' data-run-center-open-primary' : ''}>${esc(text('run_center.open_task'))}</button>` : ''}</div>
      ${task.conversationUnavailable ? `<p class="run-center-note" data-run-center-conversation-unavailable>${esc(text('run_center.conversation_unavailable'))}</p>` : ''}
      ${waitingForUser ? `<p class="run-center-note" data-run-center-waiting-user>${esc(text('run_center.waiting_user_hint'))}</p>` : ''}
      ${recoveryNote()}
      ${state.unconfirmedAction ? `<p class="run-center-unconfirmed" data-run-center-unconfirmed="${esc(state.unconfirmedAction)}">${esc(text('run_center.action_unconfirmed'))}</p>` : ''}
      ${task.executionKind === 'group-chat' && task.status === 'failed' && !actions.retry ? `<p class="run-center-note" data-run-center-retry-unavailable="${esc(task.errorCode || '')}">${esc(text('run_center.retry_unavailable_group_chat'))}</p>` : ''}
    </div>`;
  }
  function sessionsHtml() {
    if (state.loading && !state.sessions.length) return stateView('run_center.loading');
    const query = state.search.trim().toLocaleLowerCase();
    const sessions = state.sessions.filter((session) => !query || [localizedTitle(session), session.sessionId, session.latestTaskId].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(query)));
    if (!sessions.length) return stateView(query ? 'run_center.no_matches' : 'run_center.empty');
    // RC-P1-18: `taskCount` / `activeTaskCount` / `hasRecovery` were computed
    // and never shown. In a list where every row is titled "Group Chat run",
    // "3 tasks · 1 active" is the cheapest real distinguisher there is, and it
    // is a plain count — no user text (DECISION-01 stays intact).
    const sessionMeta = (session) => {
      const total = Number(session.taskCount) || 0;
      const active = Number(session.activeTaskCount) || 0;
      if (!total) return '';
      const parts = [text('run_center.session_task_count', { count: total })];
      if (active > 0) parts.push(text('run_center.session_active_count', { count: active }));
      return parts.join(' \u00b7 ');
    };
    return `<div class="run-center-session-list">${sessions.map((session) => `<button type="button" class="run-center-session${session.sessionId === state.selectedSessionId ? ' is-selected' : ''}" data-run-center-session="${esc(session.sessionId)}" data-run-center-task="${esc(session.latestTaskId || '')}"><strong>${esc(localizedTitle(session, session.sessionId))}</strong><span class="${statusClass(session.latestStatus)}">${esc(text(statusKey(session.latestStatus)))}</span>${sessionMeta(session) ? `<small data-run-center-session-meta="${esc(session.sessionId)}">${esc(sessionMeta(session))}</small>` : ''}${session.hasRecovery ? `<small class="run-center-session-recovery" data-run-center-session-recovery="${esc(session.sessionId)}">${esc(text('run_center.session_has_recovery'))}</small>` : ''}<time>${esc(formatDate(session.updatedAt))}</time></button>`).join('')}</div>`;
  }
  function render() {
    const target = panel();
    if (!target) return;
    const viewHtml = state.view === 'board' ? boardHtml() : state.view === 'runs' ? runsHtml() : collaborationHtml();
    // The column filters only mean anything on the board — `runs` and
    // `collaboration` render the selected session's detail and ignore
    // `state.filter` entirely. Leaving them live implied a scope they never
    // had, so clicking one appeared to do nothing (RC-P2-11).
    const boardScoped = state.view === 'board';
    target.innerHTML = `<div class="run-center-shell">
      <header class="run-center-header"><div><h1>${esc(text('run_center.title'))}</h1><p>${esc(text('run_center.subtitle'))}</p></div><button type="button" class="btn btn-sm" data-run-center-refresh>${esc(text('run_center.refresh'))}</button></header>
      <div class="run-center-tools"><div class="run-center-view-tabs" role="tablist">${[['board', 'run_center.view_board'], ['runs', 'run_center.view_runs'], ['collaboration', 'run_center.view_collaboration']].map(([view, label]) => `<button type="button" class="run-center-tab${state.view === view ? ' is-active' : ''}" data-run-center-view="${view}">${esc(text(label))}</button>`).join('')}</div><input type="search" value="${esc(state.search)}" data-run-center-search placeholder="${esc(text('run_center.search_placeholder'))}" aria-label="${esc(text('run_center.search_placeholder'))}"><div class="run-center-filters"${boardScoped ? '' : ' hidden'} aria-hidden="${boardScoped ? 'false' : 'true'}">${['all', 'running', 'attention', 'completed'].map((filter) => `<button type="button" class="run-center-filter${state.filter === filter ? ' is-active' : ''}" data-run-center-filter="${filter}"${boardScoped ? '' : ' disabled aria-disabled="true"'}>${esc(text(`run_center.filter_${filter}`))}</button>`).join('')}</div></div>
      <div class="run-center-layout"><aside class="run-center-sessions"><h2>${esc(text('run_center.sessions'))}</h2>${sessionsHtml()}</aside><main class="run-center-main">${viewHtml}</main><aside class="run-center-details">${detailsHtml()}</aside></div>
    </div>`;
  }
  function boardTasks() {
    return Array.isArray(state.board?.tasks) ? state.board.tasks : [];
  }
  function clearSelection() {
    state.selectedSessionId = '';
    state.selectedTaskId = '';
    state.detail = null;
  }
  // Re-reads the detail pane (detail + timeline + collaboration) for whatever
  // is currently selected.
  //
  // `preserveDetail` separates the two callers. A user-initiated selection
  // change wants the old pane gone at once — it describes a different task. A
  // refresh of the *same* selection must leave the current content on screen
  // while the read is in flight; blanking it makes every refresh strobe, which
  // gets much worse once RC-P0-02 turns refresh into a 5s poll.
  async function loadDetail({ preserveDetail = false } = {}) {
    if (!state.selectedSessionId) {
      state.detail = null;
      render();
      return;
    }
    if (!preserveDetail) state.detail = null;
    state.error = '';
    render();
    const sessionId = state.selectedSessionId;
    const taskId = state.selectedTaskId;
    try {
      const detail = await invoke('cogseed.session.read', { sessionId, taskId: taskId || undefined });
      // A newer selection was made while this read was in flight; that request
      // owns the state now.
      if (sessionId !== state.selectedSessionId || taskId !== state.selectedTaskId) return;
      if (detail && !detail.session && !detail.collaboration) {
        // sessionProjection() answers {session:null, collaboration:null} once the
        // session (or its conversation) is gone. Show the empty state instead of
        // pinning the UI to a snapshot that no longer exists.
        clearSelection();
      } else {
        state.detail = detail;
        if (detail?.collaboration?.task?.taskId) state.selectedTaskId = detail.collaboration.task.taskId;
      }
    } catch (error) {
      state.error = error?.message || String(error);
    }
    render();
  }
  async function select(sessionId, taskId) {
    state.selectedSessionId = String(sessionId || '');
    state.selectedTaskId = String(taskId || '');
    await loadDetail();
  }
  async function refresh() {
    state.loading = true;
    state.error = '';
    render();
    try {
      const [board, sessionResult] = await Promise.all([invoke('cogseed.task.list'), invoke('cogseed.session.list')]);
      state.board = board;
      state.sessions = Array.isArray(sessionResult?.sessions) ? sessionResult.sessions : [];
      // The board projection carries every dashboard-visible task, so a selected
      // id missing from it no longer exists: fall back to the first card instead
      // of letting session.read reject with "collaboration task not found".
      const tasks = boardTasks();
      const selected = state.selectedTaskId ? tasks.find((task) => task.taskId === state.selectedTaskId) : null;
      const sessionAlive = !!state.selectedSessionId
        && state.sessions.some((session) => session.sessionId === state.selectedSessionId);
      const keepSessionOnly = !state.selectedTaskId && sessionAlive;
      let preserveDetail = true;
      if (selected) {
        state.selectedSessionId = String(selected.sessionId || state.selectedSessionId);
      } else if (!keepSessionOnly) {
        const fallback = tasks[0] || null;
        state.selectedSessionId = fallback ? String(fallback.sessionId || '') : '';
        state.selectedTaskId = fallback ? String(fallback.taskId || '') : '';
        preserveDetail = false;
      }
      await loadDetail({ preserveDetail });
    } catch (error) {
      state.error = error?.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }
  // --- RC-P1-03: action convergence window ----------------------------------
  //
  // `cogseed.task.action` returns a snapshot taken before the runtime has
  // actually settled — the terminal transition happens on bus.ts's asynchronous
  // `trackBackgroundWrite` branch. So aborting used to leave the card sitting in
  // the running column until the user refreshed again by hand.
  //
  // The fix is to keep re-reading until the runtime agrees, and explicitly NOT
  // to write an optimistic status into `state`. This view is a projection of
  // runtime truth; forging a status here would make it lie precisely when the
  // action silently failed — the case the user most needs to see.
  //
  // Attempts are counted rather than wall-clock timed, so the bound is
  // deterministic and does not depend on how long each re-read takes.
  const CONFIRM_CADENCE_MS = 1000;
  const CONFIRM_MAX_ATTEMPTS = 10; // ≈10s at the cadence above
  const ABORT_SETTLED = new Set(['cancelled', 'failed', 'completed']);

  function boardTaskById(taskId) {
    return (state.board?.tasks || []).find((task) => task.taskId === taskId) || null;
  }
  function actionSettled(action, originTaskId) {
    if (action === 'abort') {
      const task = boardTaskById(originTaskId);
      return !!task && ABORT_SETTLED.has(task.status);
    }
    if (action === 'retry') {
      // Retry's terminal condition is the *new* task showing up with a link
      // back to this one — the relation RC-P1-09 established. Without it the
      // only available condition would be a timeout, i.e. no condition at all.
      return (state.board?.tasks || []).some((task) => task.retryOfTaskId === originTaskId);
    }
    return true;
  }
  function delay(ms) {
    return new Promise((resolve) => { rootWindow.setTimeout(resolve, ms); });
  }
  async function awaitActionSettled(action, originTaskId) {
    for (let attempt = 0; attempt < CONFIRM_MAX_ATTEMPTS; attempt += 1) {
      if (actionSettled(action, originTaskId)) return true;
      await delay(CONFIRM_CADENCE_MS);
      await refresh();
    }
    return actionSettled(action, originTaskId);
  }

  async function action(action) {
    const task = selectedTask() || state.detail?.collaboration?.task;
    if (!task) return;
    if (action === 'abort' && !rootWindow.confirm(text('run_center.abort_confirm'))) return;
    state.busyAction = action;
    state.unconfirmedAction = '';
    render();
    try {
      const payload = { taskId: task.taskId, action };
      if (action !== 'abort') payload.requestId = `req-run-center-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await invoke('cogseed.task.action', payload);
      // refresh() re-reads the selected detail itself; a second select() here
      // would only duplicate the session.read round-trip.
      await refresh();
      // On timeout we keep the last real snapshot and say so, rather than
      // pretending the action landed.
      if (!await awaitActionSettled(action, task.taskId)) state.unconfirmedAction = action;
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
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  // --- RC-P0-02: visible-period polling -------------------------------------
  //
  // The Run Center is a static snapshot: there is no push channel for CogSeed
  // task changes (the preload's PUSH_EVENT_PREFIXES has no `cogseed:` prefix,
  // and `cogseed.task.events` is a one-shot paged read, not a subscription — do
  // not reach for it here). Until an Event Plane exists, a bounded poll is what
  // caps staleness at ~5s instead of "until the user clicks Refresh".
  //
  // This is deliberately cheap to switch off later: `refresh()` is the single
  // entry point, so a future push handler is a one-line
  // `onPushEvent('cogseed:task-changed', () => refresh())` and this block goes.
  const POLL_INTERVAL_MS = 5000;
  let pollTimer = null;

  function panelActive() {
    const panel = document.getElementById('panel-run-center');
    return !!panel && panel.classList.contains('active');
  }
  function stopPolling() {
    if (pollTimer === null) return;
    rootWindow.clearInterval(pollTimer);
    pollTimer = null;
  }
  function startPolling() {
    // Re-entering the view calls renderRunCenter() again; without this guard
    // each visit would stack another interval onto the same module instance.
    if (pollTimer !== null) return;
    pollTimer = rootWindow.setInterval(() => {
      // Leaving the view only drops the panel's `active` class — there is no
      // teardown hook to hang off — so the tick retires its own timer.
      if (!panelActive()) { stopPolling(); return; }
      // Never poll on top of an in-flight refresh or a pending user action:
      // `state.loading` covers the whole board+detail cycle, and `busyAction`
      // means an abort/retry is still settling.
      if (document.hidden || state.loading || state.busyAction) return;
      refresh();
    }, POLL_INTERVAL_MS);
  }
  function onVisibilityChange() {
    if (document.hidden) { stopPolling(); return; }
    if (!panelActive()) return;
    startPolling();
    // Coming back to a tab that was hidden for a while, the snapshot on screen
    // is as stale as the time away — catch up now rather than after one tick.
    if (!state.loading && !state.busyAction) refresh();
  }

  rootWindow.renderRunCenter = function renderRunCenter() { bind(); startPolling(); refresh(); };
})(window);
