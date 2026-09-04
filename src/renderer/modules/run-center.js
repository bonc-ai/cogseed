// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Task and event surfaces render only privacy-filtered CogSeed projections.
// Explicit Worktree management is the sole surface that receives managed paths.
(function initCogSeedRunCenter(rootWindow) {
  'use strict';

  const VIEW_DEFINITIONS = Object.freeze([
    ['overview', 'run_center.view_overview'],
    ['runs', 'run_center.view_board'],
    ['history', 'run_center.view_runs'],
    ['agents', 'run_center.view_agents'],
    ['collaboration', 'run_center.view_collaboration'],
  ]);

  // Keep deep links and callers from the pre-unification Run Center stable.
  // The visible tabs retain the legacy DOM identifiers used by existing deep
  // links and styles. The task/session vocabulary is accepted as a boundary
  // alias and never becomes renderer state.
  const VIEW_ALIASES = Object.freeze({
    overview: 'overview',
    runs: 'runs',
    history: 'history',
    agents: 'agents',
    collaboration: 'collaboration',
    tasks: 'runs',
    sessions: 'history',
    board: 'runs',
    execution: 'history',
  });

  function normalizeView(view) {
    return VIEW_ALIASES[String(view || '').trim()] || '';
  }

  const state = {
    view: 'overview',
    runMode: 'queue',
    detailTab: 'summary',
    filter: 'all',
    sourceFilter: 'all',
    runAgentFilter: 'all',
    runTimeFilter: 'all',
    search: '',
    showArchived: false,
    board: null,
    detail: null,
    selectedTaskId: '',
    selectedSessionId: '',
    selectedRunKey: '',
    selectedAttemptKey: '',
    attemptFocusKey: '',
    boardFocusRunKey: '',
    detailOpen: false,
    restoreDetailAfterCreate: false,
    loading: false,
    error: '',
    busyAction: '',
    bound: false,
    watch: null,
    refreshTimer: null,
    refreshInFlight: null,
    refreshQueued: false,
    agentRegistry: null,
    agentRegistryError: '',
    agentSearch: '',
    agentFilter: 'all',
    busyAgentGateway: '',
    agentGatewayError: '',
    agents: [],
    agentsLoaded: false,
    createMode: '',
    createTask: '',
    createAgentId: '',
    createWorktreeName: '',
    createBusy: false,
    createError: '',
    createAdvancedOpen: false,
    createAdvancedError: '',
    createReturnFocus: '',
    toolsOpen: false,
    busyCollaborationAction: '',
    diagnosticsOpen: false,
    diagnostics: null,
    diagnosticsLoading: false,
    diagnosticsError: '',
    diagnosticsRequestRevision: 0,
    worktreesOpen: false,
    worktrees: null,
    worktreesLoading: false,
    worktreesError: '',
    worktreesRequestRevision: 0,
    worktreesRequestOwner: '',
    worktreeBranch: '',
    worktreeBaseRef: 'HEAD',
    worktreeBusy: '',
    worktreeNotice: '',
    detailReturnFocus: '',
    actionNotice: '',
    actionError: '',
    overviewAnalysisOpen: true,
    selectionRevision: 0,
  };

  function panel() { return document.getElementById('run-center-root'); }
  function focusLater(selector) {
    if (!selector) return;
    rootWindow.setTimeout(() => panel()?.querySelector(selector)?.focus(), 0);
  }
  function focusDetailDrawer() { focusLater('[data-run-center-detail-tab], [data-run-center-detail-back]'); }
  function escapedAttributeValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function captureFocus() {
    const target = panel();
    const active = document.activeElement;
    if (!target || !active || (target.contains && !target.contains(active))) return null;
    const attribute = Array.from(active.attributes || [])
      .find((item) => item.name.startsWith('data-run-center-') || item.name.startsWith('data-dashboard-'));
    const selector = attribute
      ? `[${attribute.name}${attribute.value ? `="${escapedAttributeValue(attribute.value)}"` : ''}]`
      : active.id ? `[id="${escapedAttributeValue(active.id)}"]` : '';
    if (!selector) return null;
    const matches = target.querySelectorAll ? Array.from(target.querySelectorAll(selector)) : [];
    const attemptIndex = active.dataset?.runCenterAttemptIndex;
    const attempts = attemptIndex === undefined ? [] : buildAttemptModels(selectedRunModel());
    return {
      selector,
      index: Math.max(0, matches.indexOf(active)),
      attemptKey: attemptIndex === undefined ? ''
        : state.attemptFocusKey || state.selectedAttemptKey || attempts[Number(attemptIndex)]?.key || '',
      selectionStart: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
      selectionEnd: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null,
      selectionDirection: active.selectionDirection,
    };
  }
  function restoreFocus(snapshot, fallbackSelector = '') {
    if (!snapshot) return false;
    const target = panel();
    const attempts = snapshot.attemptKey ? buildAttemptModels(selectedRunModel()) : [];
    const attemptIndex = attempts.findIndex((attempt) => attempt.key === snapshot.attemptKey);
    const attemptSelector = attemptIndex >= 0 ? `[data-run-center-attempt-index=\"${attemptIndex}\"]` : '';
    const matches = target?.querySelectorAll ? Array.from(target.querySelectorAll(snapshot.selector)) : [];
    const next = (attemptSelector ? target?.querySelector(attemptSelector) : null)
      || matches[snapshot.index] || target?.querySelector(snapshot.selector)
      || (fallbackSelector ? target?.querySelector(fallbackSelector) : null);
    if (!next) return false;
    next.focus();
    if (snapshot.selectionStart != null && typeof next.setSelectionRange === 'function') {
      next.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection || 'none');
    }
    return true;
  }
  function captureScroll() {
    const target = panel();
    return ['.run-center-queue-scroll', '.dashboard-board-scroll', '.run-center-detail-content']
      .map((selector) => {
        const element = target?.querySelector?.(selector);
        return element ? { selector, top: Number(element.scrollTop || 0), left: Number(element.scrollLeft || 0) } : null;
      }).filter(Boolean);
  }
  function restoreScroll(snapshot) {
    for (const item of snapshot || []) {
      const element = panel()?.querySelector?.(item.selector);
      if (!element) continue;
      element.scrollTop = item.top;
      element.scrollLeft = item.left;
    }
  }
  function renderPreservingFocus(fallbackSelector = '') {
    const focusSnapshot = captureFocus();
    const scrollSnapshot = captureScroll();
    render();
    restoreScroll(scrollSnapshot);
    if (focusSnapshot) restoreFocus(focusSnapshot, fallbackSelector);
    else focusLater(fallbackSelector);
  }
  function focusableElements(container) {
    if (!container?.querySelectorAll) return [];
    return Array.from(container.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
      .filter((element) => typeof element.getClientRects !== 'function' || element.getClientRects().length > 0);
  }
  function trapFocus(event, selector) {
    if (event.key !== 'Tab') return false;
    const container = panel()?.querySelector(selector);
    const focusable = focusableElements(container);
    if (!container || !focusable.length) return false;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!active || !container.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return true;
    }
    return false;
  }
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
  function conversationCacheTitle(conversationId) {
    const id = String(conversationId || '');
    if (!id || typeof conversations === 'undefined' || !Array.isArray(conversations)) return '';
    const conversation = conversations.find((item) => item && item.conversation_id === id);
    return String(conversation?.title || '').trim();
  }
  function displayRun(run, context) {
    const board = rootWindow.CogSeedRunCenterBoard;
    if (!run || typeof board?.displayRun !== 'function') return null;
    return board.displayRun(run, {
      text,
      formatDate,
      agentName: agentDisplayName,
      conversationTitle: conversationCacheTitle,
      context,
    });
  }
  function displayRunTitle(run, fallbackTask) {
    return displayRun(run)?.title
      || localizedTitle(fallbackTask || runTask(run), text('run_center.task_kind_cogseed'));
  }
  function dynamicLabel(prefix, value, fallbackKey) {
    const key = `${prefix}${String(value || '').replace(/\./g, '_')}`;
    const label = text(key);
    return label && label !== key ? label : text(fallbackKey);
  }
  function stateView(key, detail) {
    return `<div class="run-center-empty">${esc(text(key))}${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
  }
  function retryStateHtml(message, retryAttribute) {
    return `<div class="run-center-retry-state" role="alert"><span>${esc(message)}</span><button type="button" class="btn btn-sm" ${retryAttribute}>${icon('refresh')}<span>${esc(text('run_center.retry_load'))}</span></button></div>`;
  }
  function selectedTask() {
    return (state.board?.tasks || []).find((task) => task.taskId === state.selectedTaskId) || null;
  }
  function selectedRunModel() {
    if (!state.board || !rootWindow.CogSeedRunCenterBoard) return null;
    const board = rootWindow.CogSeedRunCenterBoard;
    if (state.selectedRunKey && typeof board.buildRunModels === 'function') {
      const match = board.buildRunModels(state.board).find((run) => run.key === state.selectedRunKey);
      if (match) return match;
    }
    return typeof board.runForTask === 'function' ? board.runForTask(state.board, state.selectedTaskId) : null;
  }
  function safeTime(value) {
    const time = new Date(String(value || '')).getTime();
    return Number.isFinite(time) ? time : 0;
  }
  function attemptKeyForTask(task, fallbackIndex) {
    const executionId = String(task?.executionId || '').trim();
    const taskId = String(task?.taskId || '').trim();
    return executionId ? `execution:${executionId}` : `task:${taskId || fallbackIndex}`;
  }
  function attemptStateTask(members) {
    const priority = ['failed', 'recoverable', 'waiting_user', 'needs_review', 'blocked', 'running', 'queued', 'pending', 'completed', 'cancelled', 'skipped', 'created'];
    return priority.map((status) => members
      .filter((task) => task.status === status)
      .sort((left, right) => safeTime(right.updatedAt) - safeTime(left.updatedAt))[0])
      .find(Boolean) || members[0];
  }
  function attemptTargetTask(members, parentTaskIds) {
    return [...members].sort((left, right) => {
      const leftParent = parentTaskIds.has(left.taskId) || !left.parentTaskId;
      const rightParent = parentTaskIds.has(right.taskId) || !right.parentTaskId;
      return Number(rightParent) - Number(leftParent)
        || safeTime(right.updatedAt) - safeTime(left.updatedAt)
        || String(left.taskId || '').localeCompare(String(right.taskId || ''));
    })[0] || null;
  }
  function buildAttemptModels(run) {
    const members = Array.isArray(run?.members) && run.members.length
      ? run.members
      : (Array.isArray(run?.attempts) ? run.attempts.flatMap((attempt) => attempt.members || attempt.representative || []) : []);
    const parentTaskIds = new Set(members.map((task) => task.parentTaskId).filter(Boolean));
    const grouped = new Map();
    members.forEach((task, index) => {
      const key = attemptKeyForTask(task, index);
      const attemptMembers = grouped.get(key) || [];
      attemptMembers.push(task);
      grouped.set(key, attemptMembers);
    });
    return Array.from(grouped.entries()).map(([key, attemptMembers]) => {
      const orderedMembers = [...attemptMembers].sort((left, right) =>
        safeTime(right.updatedAt) - safeTime(left.updatedAt)
        || String(left.taskId || '').localeCompare(String(right.taskId || '')));
      const target = attemptTargetTask(orderedMembers, parentTaskIds);
      const stateTask = attemptStateTask(orderedMembers) || target;
      const createdTimes = orderedMembers.map((task) => safeTime(task.createdAt)).filter(Boolean);
      const updatedTimes = orderedMembers.map((task) => safeTime(task.updatedAt)).filter(Boolean);
      return {
        key,
        members: orderedMembers,
        representative: target,
        status: stateTask?.status || target?.status || 'created',
        createdAt: createdTimes.length ? new Date(Math.min(...createdTimes)).toISOString() : '',
        updatedAt: updatedTimes.length ? new Date(Math.max(...updatedTimes)).toISOString() : '',
      };
    }).sort((left, right) => safeTime(right.updatedAt) - safeTime(left.updatedAt)
      || safeTime(right.createdAt) - safeTime(left.createdAt)
      || left.key.localeCompare(right.key));
  }
  function reconcileAttemptSelection(run, preferredKey, preferredTaskId) {
    const attempts = buildAttemptModels(run);
    const selected = attempts.find((attempt) => attempt.key === preferredKey)
      || attempts.find((attempt) => attempt.members.some((task) => task.taskId === preferredTaskId))
      || attempts[0] || null;
    return { attempts, selected, index: selected ? attempts.indexOf(selected) : -1, task: selected?.representative || null };
  }
  function agentDisplayName(agentId) {
    if (!agentId) return '';
    const registryAgent = state.agentRegistry?.agents?.find((item) => item.agentId === agentId);
    if (registryAgent?.displayName) return registryAgent.displayName;
    const agent = state.agents.find((item) => item.agent_id === agentId);
    if (agent?.name) return agent.name;
    if (agentId === 'commander') return text('run_center.commander');
    return text('run_center.assigned_agent');
  }
  function createAgentCandidates() {
    if (Array.isArray(state.agentRegistry?.agents)) return state.agentRegistry.agents;
    return (Array.isArray(state.agents) ? state.agents : [])
      .map((agent) => ({
        agentId: String(agent?.agent_id || '').trim(),
        displayName: String(agent?.name || agent?.agent_id || '').trim(),
        dispatchable: agent?.enabled !== false,
      }))
      .filter((agent) => agent.agentId);
  }
  function taskDispatchableAgentCandidates() {
    return createAgentCandidates().filter((agent) => agent.dispatchable
      && (!Array.isArray(state.agentRegistry?.agents) || !!String(agent.definitionSource || '').trim()));
  }
  function taskAgentOptionLabel(agent) {
    const name = String(agent?.displayName || '').trim() || text('run_center.assigned_agent');
    const runtimeKind = String(agent?.runtimeKind || '').trim();
    if (runtimeKind.startsWith('p3394-gateway:')) return `${name} · ${text('run_center.agent_option_local_external')}`;
    if (agent?.sourceKind === 'local-cli' || runtimeKind.startsWith('cli:')) return `${name} · ${text('run_center.agent_option_local_cli')}`;
    return name;
  }
  function agentOptionsReady() {
    return Array.isArray(state.agentRegistry?.agents) || state.agentsLoaded;
  }
  function visibleBoardRuns() {
    if (!rootWindow.CogSeedRunCenterBoard || !state.board) return [];
    const board = rootWindow.CogSeedRunCenterBoard;
    if (typeof board.filterRuns === 'function' && typeof board.buildRunModels === 'function') {
      return board.filterRuns(board.buildRunModels(state.board), {
        search: state.search,
        filter: state.filter,
        includeArchived: state.showArchived,
        sourceFilter: state.sourceFilter,
        agentFilter: state.runAgentFilter,
        timeFilter: state.runTimeFilter,
        agentName: agentDisplayName,
      });
    }
    return board.filteredLogicalTasks(
      state.board, state.search, state.filter, state.showArchived, state.sourceFilter, agentDisplayName,
    ).map((task) => ({ key: board.logicalRunKey(task), representative: task, aggregateTask: task, members: [task], attempts: [] }));
  }
  function runTask(run) {
    return run?.aggregateTask || run?.representative || null;
  }
  function orderedVisibleRuns() {
    return [...visibleBoardRuns()].sort((left, right) => {
      const leftTask = runTask(left);
      const rightTask = runTask(right);
      return safeTime(rightTask?.updatedAt) - safeTime(leftTask?.updatedAt)
        || String(left.key || '').localeCompare(String(right.key || ''));
    });
  }
  function runSequenceByKey() {
    const board = rootWindow.CogSeedRunCenterBoard;
    const allRuns = state.board && typeof board?.buildRunModels === 'function'
      ? board.buildRunModels(state.board)
      : orderedVisibleRuns();
    if (typeof board?.buildRunSequence === 'function') return board.buildRunSequence(allRuns);
    const bySession = new Map();
    for (const run of allRuns) {
      const task = runTask(run);
      const sessionKey = String(task?.sessionId || run.key || '');
      const runs = bySession.get(sessionKey) || [];
      runs.push(run);
      bySession.set(sessionKey, runs);
    }
    const sequence = new Map();
    for (const runs of bySession.values()) {
      runs.sort((left, right) => {
        const leftTask = runTask(left);
        const rightTask = runTask(right);
        const leftCreated = (left.members || []).map((task) => safeTime(task.createdAt)).filter(Boolean);
        const rightCreated = (right.members || []).map((task) => safeTime(task.createdAt)).filter(Boolean);
        const leftStartedAt = leftCreated.length ? Math.min(...leftCreated) : safeTime(leftTask?.createdAt) || safeTime(leftTask?.updatedAt);
        const rightStartedAt = rightCreated.length ? Math.min(...rightCreated) : safeTime(rightTask?.createdAt) || safeTime(rightTask?.updatedAt);
        return leftStartedAt - rightStartedAt
          || String(left.key || '').localeCompare(String(right.key || ''));
      });
      runs.forEach((run, index) => sequence.set(run.key, { index: index + 1, count: runs.length }));
    }
    return sequence;
  }
  function invoke(channel, payload) {
    if (!rootWindow.cogseed?.invoke) return Promise.reject(new Error(text('run_center.ipc_unavailable')));
    return rootWindow.cogseed.invoke(channel, payload || {}).then((result) => {
      if (result?.ok === false) {
        const error = new Error(result.error || text('run_center.load_failed'));
        error.code = result.code;
        throw error;
      }
      return result;
    });
  }
  function icon(name, className) {
    return typeof rootWindow.uiIconHtml === 'function' ? rootWindow.uiIconHtml(name, className) : '';
  }
  function boardHtml() {
    if (!rootWindow.CogSeedRunCenterBoard) return stateView('run_center.loading');
    return rootWindow.CogSeedRunCenterBoard.render(state.board, {
      text, esc, icon, statusKey, statusClass: (value) => statusClass(value), formatDate, stateView,
      loading: state.loading, error: state.error, search: state.search, filter: state.filter,
      sourceFilter: state.sourceFilter, agentFilter: state.runAgentFilter,
      timeFilter: state.runTimeFilter, agentName: agentDisplayName,
      conversationTitle: conversationCacheTitle,
      selectedTaskId: state.selectedTaskId, selectedRunKey: state.selectedRunKey,
      focusedRunKey: state.boardFocusRunKey, showArchived: state.showArchived,
    });
  }
  function allRunModels() {
    const board = rootWindow.CogSeedRunCenterBoard;
    return state.board && typeof board?.buildRunModels === 'function' ? board.buildRunModels(state.board) : [];
  }
  function queueHtml() {
    const board = rootWindow.CogSeedRunCenterBoard;
    if (!board?.renderQueue) return stateView('run_center.loading');
    const runs = orderedVisibleRuns();
    const filtered = state.search.trim() || state.sourceFilter !== 'all' || state.filter !== 'all';
    return board.renderQueue(runs, {
      text, esc, icon, formatDate, stateView,
      loading: state.loading, error: state.error, filtered,
      allRuns: allRunModels(), selectedRunKey: state.selectedRunKey,
      focusedRunKey: state.boardFocusRunKey,
      agentName: agentDisplayName, conversationTitle: conversationCacheTitle,
    });
  }
  function formatDay(value) {
    const date = value instanceof Date ? value : new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return text('run_center.unknown_time');
    return new Intl.DateTimeFormat(typeof getLang === 'function' ? getLang() : undefined, { weekday: 'short' }).format(date);
  }
  function overviewHtml() {
    if (!rootWindow.CogSeedRunCenterOverview) return stateView('run_center.overview_loading');
    return rootWindow.CogSeedRunCenterOverview.render(state.board, state.agentRegistry?.agents || state.agents, {
      text, esc, icon, statusKey, formatDate, formatDay, stateView,
      loading: state.loading, error: state.error, agentName: agentDisplayName,
      conversationTitle: conversationCacheTitle,
      analysisOpen: state.overviewAnalysisOpen,
    });
  }
  function agentsHtml() {
    if (!rootWindow.CogSeedRunCenterAgents) return stateView('run_center.agents_loading');
    return rootWindow.CogSeedRunCenterAgents.render(state.agentRegistry, {
      text, esc, icon, formatDate, stateView, dynamicLabel,
      loading: state.loading, error: state.agentRegistryError,
      search: state.agentSearch, filter: state.agentFilter,
      busyGateway: state.busyAgentGateway, gatewayError: state.agentGatewayError,
    });
  }
  function timelineHtml(events, tasks) {
    if (!Array.isArray(events) || !events.length) return stateView('run_center.timeline_empty');
    const taskById = new Map((Array.isArray(tasks) ? tasks : []).map((task) => [task.taskId, task]));
    const groups = [];
    for (const event of events) {
      const time = formatDate(event.createdAt);
      const key = [time, event.type, event.toolName || '', event.errorCode || ''].join(':');
      const previous = groups.at(-1);
      const taskId = String(event.taskId || '');
      const previousTaskIds = new Set(previous?.events.map((item) => String(item.taskId || '')).filter(Boolean));
      if (taskId && previous?.key === key && !previousTaskIds.has(taskId)) previous.events.push(event);
      else groups.push({ key, time, event, events: [event] });
    }
    const failureIndex = groups.findIndex((group) => group.events.some((event) => event.errorCode
      || String(event.type || '').includes('failed')
      || String(event.type || '').includes('recoverable')));
    return `<div class="run-center-timeline-shell">
      ${failureIndex >= 0 ? `<div class="run-center-timeline-tools"><button type="button" class="btn btn-sm" data-run-center-timeline-jump>${icon('warning')}<span>${esc(text('run_center.timeline_jump_failure'))}</span></button></div>` : ''}
      <ol class="run-center-timeline is-compact">${groups.map((group, index) => {
      const event = group.event;
      const taskIds = Array.from(new Set(group.events.map((item) => item.taskId).filter(Boolean)));
      const task = taskById.get(taskIds[0] || event.taskId);
      const context = taskIds.length > 1
        ? text('run_center.timeline_related_tasks', { count: taskIds.length })
        : task ? localizedTitle(task, text('run_center.task_kind_cogseed')) : '';
      const failure = index === failureIndex;
      return `<li${failure ? ' class="is-failure" data-run-center-timeline-failure tabindex="-1"' : ''}>
      <time datetime="${esc(event.createdAt)}">${esc(group.time)}</time><div class="run-center-timeline-content"><span class="run-center-timeline-title">${esc(dynamicLabel('run_center.event_', event.type, 'run_center.event_unknown'))}${context ? `<small>${esc(context)}</small>` : ''}</span>
      ${event.toolName ? `<span class="run-center-timeline-meta"><code>${esc(event.toolName)}</code></span>` : ''}</div>
    </li>`; }).join('')}</ol></div>`;
  }
  function collaborationHtml() {
    if (state.error) return stateView('run_center.load_failed', state.error);
    const detail = state.detail?.collaboration;
    if (!detail) return stateView(state.loading || state.selectedRunKey ? 'run_center.loading_detail' : 'run_center.select_collaboration');
    const workflow = detail.workflow || {};
    const actors = Array.isArray(detail.actors) ? detail.actors : [];
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const activity = Array.isArray(detail.activity) ? detail.activity : [];
    const reviews = Array.isArray(detail.reviews) ? detail.reviews : [];
    const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts : [];
    const nativeWorkflow = detail.task?.executionKind !== 'group-chat';
    const busy = state.busyCollaborationAction;
    const actorNameById = new Map(actors.map((actor) => [actor.actorId, actor.displayName || agentDisplayName(actor.actorId)]));
    const hasCoordinationRecords = steps.length || reviews.length || conflicts.length || activity.length;
    const participantCount = Number(detail.task?.participantCount || detail.session?.participantCount || 0);
    const displayedParticipantCount = Math.max(participantCount, actors.length);
    const isMultiAgent = displayedParticipantCount >= 2 || hasCoordinationRecords;
    const actionButton = (action, targetId, label, danger = false) => `<button type="button" class="btn btn-sm${danger ? ' btn-danger' : ''}" data-run-center-collaboration-action="${action}" data-run-center-collaboration-target="${esc(targetId)}" ${busy ? 'disabled' : ''}>${esc(text(busy === `${action}:${targetId}` ? 'run_center.action_working' : label))}</button>`;
    if (!isMultiAgent) {
      const task = detail.task || selectedTask();
      const agent = agentDisplayName(task?.agentId) || text('run_center.commander');
      const delivery = dynamicLabel('run_center.delivery_', task?.resultDeliveryState, 'run_center.delivery_unknown');
      return `<section class="run-center-single-agent" aria-labelledby="run-center-single-agent-title">
        <header><span>${icon('user')}</span><div><h2 id="run-center-single-agent-title">${esc(text('run_center.single_agent_title'))}</h2><p>${esc(text('run_center.single_agent_detail'))}</p></div></header>
        <ol class="run-center-execution-path" aria-label="${esc(text('run_center.execution_path'))}">
          <li><span>${icon('clipboard-list')}</span><div><small>${esc(text('run_center.execution_path_task'))}</small><strong>${esc(text(statusKey(task?.status)))}</strong></div></li>
          <li><span>${icon('user')}</span><div><small>${esc(text('run_center.execution_path_agent'))}</small><strong>${esc(agent)}</strong></div></li>
          <li><span>${icon('send')}</span><div><small>${esc(text('run_center.execution_path_delivery'))}</small><strong>${esc(delivery)}</strong></div></li>
        </ol>
      </section>`;
    }
    return `<div class="run-center-collaboration">
      <div class="run-center-collaboration-summary" aria-label="${esc(text('run_center.collaboration_summary'))}">
        <span><b>${esc(displayedParticipantCount)}</b>${esc(text('run_center.summary_agents'))}</span><span><b>${esc(steps.length)}</b>${esc(text('run_center.summary_steps'))}</span><span><b>${esc(reviews.length)}</b>${esc(text('run_center.summary_gates'))}</span><span><b>${esc(conflicts.length)}</b>${esc(text('run_center.summary_conflicts'))}</span>
      </div>
      <section class="is-team"><h2>${esc(text('run_center.team'))}</h2>${actors.length ? `<ul class="run-center-actors">${actors.map((actor) => `<li><strong>${esc(actorNameById.get(actor.actorId))}</strong><span>${esc(text(`run_center.actor_${actor.role}`))}</span><span class="${statusClass(actor.status)}">${esc(text(statusKey(actor.status)))}</span></li>`).join('')}</ul>` : `<div class="run-center-compact-empty">${esc(text('run_center.agents_empty'))}</div>`}</section>
      ${steps.length ? `<section class="is-workflow"><h2>${esc(text('run_center.workflow'))}</h2><ol class="run-center-steps">${steps.map((step) => `<li><div><strong>${esc(localizedTitle(step, text('run_center.workflow_step')))}</strong><span class="${statusClass(step.status)}">${esc(text(statusKey(step.status)))}</span></div><small>${esc(text('run_center.attempt_count', { count: step.attemptCount || 0 }))}</small>${step.dependsOn?.length ? `<small>${esc(text('run_center.dependencies_count', { count: step.dependsOn.length }))}</small>` : ''}${nativeWorkflow && (step.status === 'failed' || step.status === 'skipped') ? `<div class="run-center-inline-actions">${actionButton('retry-step', step.stepId, 'run_center.retry_step')}</div>` : ''}${nativeWorkflow && ['pending', 'blocked', 'failed'].includes(step.status) ? `<div class="run-center-inline-actions">${actionButton('skip-step', step.stepId, 'run_center.skip_step', true)}</div>` : ''}</li>`).join('')}</ol></section>` : ''}
      ${reviews.length ? `<section class="is-controls"><h2>${esc(text('run_center.review_gates'))}</h2><ul class="run-center-control-list">${reviews.map((review) => { const open = review.status === 'needs_review' || review.status === 'failed'; return `<li><div><strong>${esc(text('run_center.review_gate'))}</strong><span class="${statusClass(review.status)}">${esc(text(statusKey(review.status)))}</span></div>${review.reviewDecision ? `<small>${esc(text('run_center.reviewed'))}: ${esc(dynamicLabel('run_center.review_decision_', review.reviewDecision, 'run_center.review_decision_unknown'))}</small>` : ''}${open ? `<div class="run-center-inline-actions">${actionButton('approve-gate', review.gateId, 'run_center.approve_gate')}${actionButton('reject-gate', review.gateId, 'run_center.reject_gate', true)}</div>` : ''}</li>`; }).join('')}</ul></section>` : ''}
      ${conflicts.length ? `<section class="is-controls"><h2>${esc(text('run_center.conflicts'))}</h2><ul class="run-center-control-list">${conflicts.map((conflict) => { const active = conflict.status !== 'resolved' && conflict.status !== 'dismissed'; return `<li><div><strong>${esc(dynamicLabel('run_center.conflict_type_', conflict.type, 'run_center.conflict'))}</strong><span class="${statusClass(conflict.status)}">${esc(dynamicLabel('run_center.conflict_status_', conflict.status, 'run_center.conflict_active'))}</span></div>${conflict.affectedStepIds?.length ? `<small>${esc(text('run_center.affected_steps_count', { count: conflict.affectedStepIds.length }))}</small>` : ''}${active ? `<div class="run-center-inline-actions">${actionButton('dismiss-conflict', conflict.conflictId, 'run_center.dismiss_conflict', true)}</div>` : ''}</li>`; }).join('')}</ul></section>` : ''}
      ${activity.length ? `<section class="is-activity"><h2>${esc(text('run_center.collaboration_activity'))}</h2><ol class="run-center-timeline">${activity.map((event) => `<li><time>${esc(formatDate(event.createdAt))}</time><div class="run-center-timeline-content"><span class="run-center-timeline-title">${esc(dynamicLabel('run_center.activity_', event.type, 'run_center.activity_unknown'))}${event.actorId && actorNameById.has(event.actorId) ? `<small>${esc(actorNameById.get(event.actorId))}</small>` : ''}</span></div></li>`).join('')}</ol></section>` : ''}
      ${hasCoordinationRecords ? '' : `<div class="run-center-collaboration-empty">${icon('check-circle')}<div><strong>${esc(text('run_center.collaboration_empty_title'))}</strong><span>${esc(text('run_center.collaboration_empty_detail'))}</span></div></div>`}
    </div>`;
  }
  function errorHelpKey(errorCode) {
    if (errorCode === 'model_preflight') return 'run_center.error_help_model_preflight';
    if (errorCode === 'provider_error') return 'run_center.error_help_provider_error';
    if (errorCode === 'group_chat_run_failed') return 'run_center.error_help_group_chat_run_failed';
    return 'run_center.error_help_default';
  }
  function attemptIsFailed(attempt) {
    return ['failed', 'recoverable', 'blocked'].includes(attempt?.status)
      || attempt?.members?.some((task) => !!task.errorCode);
  }
  function attemptIsRunning(attempt) {
    return ['created', 'queued', 'pending', 'running', 'waiting_user', 'needs_review'].includes(attempt?.status);
  }
  function attemptIsRecovered(attempts, index) {
    const attempt = attempts[index];
    const deliveryRecovered = attempt?.members?.some((task) => ['recovered', 'delivered_after_recovery'].includes(task.resultDeliveryState));
    return !!deliveryRecovered || attempt?.status === 'completed' && attempts.slice(index + 1).some(attemptIsFailed);
  }
  function failureCategory(errorCode) {
    if (!errorCode) return 'none';
    if (errorCode === 'model_preflight') return 'model';
    if (errorCode === 'provider_error') return 'provider';
    if (errorCode === 'group_chat_run_failed') return 'collaboration';
    return 'other';
  }
  function detailModel() {
    const collaboration = state.detail?.collaboration;
    const run = selectedRunModel();
    const selection = reconcileAttemptSelection(
      run || { members: [selectedTask()].filter(Boolean) },
      state.selectedAttemptKey,
      state.selectedTaskId,
    );
    const projectedTask = selection.task || selectedTask() || run?.representative;
    const task = collaboration?.task && collaboration.task.taskId === projectedTask?.taskId
      ? collaboration.task : projectedTask;
    const aggregateTask = run?.aggregateTask || task;
    const actions = collaboration?.task && collaboration.task.taskId === task?.taskId
      ? collaboration?.actions || task?.actions || {} : task?.actions || {};
    return { collaboration, run, selection, task, aggregateTask, actions };
  }
  function collaborationAvailable(collaboration, task) {
    const workflow = collaboration?.workflow || {};
    const participantCount = Math.max(
      Number(task?.participantCount || collaboration?.session?.participantCount || 0),
      Array.isArray(collaboration?.actors) ? collaboration.actors.length : 0,
    );
    return participantCount >= 2
      || ['steps', 'reviews', 'conflicts'].some((key) => Array.isArray(key === 'steps' ? workflow.steps : collaboration?.[key])
        && (key === 'steps' ? workflow.steps : collaboration[key]).length > 0);
  }
  function resultDestination(task) {
    if (!task?.conversationId || task.resultDeliveryState === 'not-applicable') {
      return text('run_center.destination_run_center');
    }
    const title = conversationCacheTitle(task.conversationId);
    return title ? text('run_center.destination_named_conversation', { title })
      : text('run_center.destination_conversation');
  }
  function actionEffectKey(action) {
    return `run_center.action_effect_${String(action || 'none').replace(/-/g, '_')}`;
  }
  function recommendedActionHtml(model, userState, hasCollaboration) {
    const { task, actions } = model;
    const busy = state.busyAction;
    const action = userState.action;
    if (action === 'configure-model') {
      return `<button type="button" class="btn btn-sm btn-primary" data-run-center-configure-model>${icon('settings')}<span>${esc(text(userState.actionKey))}</span></button>`;
    }
    if (action === 'open-task' && task?.conversationId) {
      return `<button type="button" class="btn btn-sm btn-primary" data-run-center-open="${esc(task.conversationId)}">${icon('message-square')}<span>${esc(text(userState.actionKey))}</span></button>`;
    }
    if (action === 'open-handling') {
      if (hasCollaboration) return `<button type="button" class="btn btn-sm btn-primary" data-run-center-detail-tab="collaboration">${icon('users')}<span>${esc(text(userState.actionKey))}</span></button>`;
      if (task?.conversationId) return `<button type="button" class="btn btn-sm btn-primary" data-run-center-open="${esc(task.conversationId)}">${icon('message-square')}<span>${esc(text(userState.actionKey))}</span></button>`;
    }
    // Same gate the queue applies, so the two surfaces cannot promise
    // different things about one card.
    const allowed = rootWindow.CogSeedRunCenterBoard?.recommendedActionAvailable?.(
      actions, userState, { conversationId: task?.conversationId, hasCollaboration },
    ) ?? false;
    if (allowed) {
      const iconName = action === 'resume' ? 'play-triangle' : 'refresh';
      return `<button type="button" class="btn btn-sm btn-primary" data-run-center-action="${esc(action)}" ${busy ? 'disabled' : ''}>${busy === action ? icon('loader', 'ui-icon is-spinning') : icon(iconName)}<span>${esc(text(busy === action ? 'run_center.action_working' : userState.actionKey))}</span></button>`;
    }
    return '';
  }
  function summaryTabHtml(model) {
    const { collaboration, run, task, aggregateTask, actions } = model;
    if (!task || !aggregateTask) return stateView('run_center.select_item');
    const workflow = collaboration?.workflow || {};
    const hasReview = Array.isArray(collaboration?.reviews) && collaboration.reviews.some((item) => !['approved', 'rejected'].includes(item.status));
    const hasConflict = Array.isArray(collaboration?.conflicts) && collaboration.conflicts.some((item) => !['resolved', 'dismissed'].includes(item.status));
    const userState = rootWindow.CogSeedRunCenterBoard?.userStateForTask?.({
      ...aggregateTask,
      resultDeliveryState: task.resultDeliveryState || aggregateTask.resultDeliveryState,
      errorCode: task.errorCode || aggregateTask.errorCode,
    }, { hasReview, hasConflict }) || { stateKey: statusKey(aggregateTask.status), reasonKey: '', action: '', actionKey: '' };
    const hasCollaboration = collaborationAvailable(collaboration, task);
    const destination = resultDestination(task);
    const worktree = task.worktreeName || text('run_center.current_workspace_short');
    const effect = text(actionEffectKey(userState.action), { worktree, destination });
    const primaryAction = recommendedActionHtml(model, userState, hasCollaboration);
    const impact = task.errorCode ? text(errorHelpKey(task.errorCode)) : text(userState.reasonKey);
    const progress = run?.progress;
    const completion = progress?.total ? Math.round((Number(progress.completed || 0) / Number(progress.total)) * 100) : 0;
    const secondary = [
      actions.abort ? `<button type="button" class="btn btn-sm btn-danger" data-run-center-action="abort" ${state.busyAction ? 'disabled' : ''}>${icon('stop')}<span>${esc(text('run_center.abort'))}</span></button>` : '',
      actions.archive ? `<button type="button" class="btn btn-sm" data-run-center-action="archive" ${state.busyAction ? 'disabled' : ''}>${state.busyAction === 'archive' ? icon('loader', 'ui-icon is-spinning') : icon('archive')}<span>${esc(text(state.busyAction === 'archive' ? 'run_center.action_working' : 'run_center.remove_from_list'))}</span></button>` : '',
      `<button type="button" class="btn btn-sm" data-run-center-reassign>${icon('refresh')}<span>${esc(text('run_center.run_with_agent'))}</span></button>`,
      task.conversationId && userState.action !== 'open-task' ? `<button type="button" class="btn btn-sm" data-run-center-open="${esc(task.conversationId)}">${icon('message-square')}<span>${esc(text('run_center.open_task'))}</span></button>` : '',
    ].filter(Boolean).join('');
    return `<div class="run-center-summary-flow">
      ${state.actionNotice ? `<div class="run-center-action-feedback is-success" role="status">${icon('check-circle')}<span>${esc(text(state.actionNotice))}</span></div>` : ''}
      ${state.actionError ? `<div class="run-center-action-feedback is-error" role="alert">${icon('warning')}<span>${esc(state.actionError)}</span></div>` : ''}
      <section class="run-center-summary-row is-event"><span class="run-center-summary-row-icon">${icon(userState.attention ? 'warning' : userState.kind === 'running' ? 'activity' : 'check-circle')}</span><div><small>${esc(text('run_center.summary_what_happened'))}</small><h3>${esc(text(userState.stateKey))}</h3><p>${esc(text(userState.reasonKey))}</p></div></section>
      <section class="run-center-summary-row"><span class="run-center-summary-row-icon">${icon('activity')}</span><div><small>${esc(text('run_center.summary_impact'))}</small><h3>${esc(userState.attention ? text('run_center.summary_attention_impact') : text('run_center.summary_no_blocking_impact'))}</h3><p>${esc(impact)}</p>${progress?.total ? `<div class="run-center-inspector-progress"><span><b>${esc(text('run_center.group_progress'))}</b><strong>${esc(progress.completed)}/${esc(progress.total)}</strong></span><div><i style="width:${completion}%"></i></div></div>` : ''}</div></section>
      <section class="run-center-summary-row is-action"><span class="run-center-summary-row-icon">${icon('play-triangle')}</span><div><small>${esc(text('run_center.summary_next_action'))}</small><h3>${esc(primaryAction ? text(userState.actionKey) : text('run_center.no_action_required'))}</h3><p>${esc(effect)}</p><div class="run-center-summary-actions">${primaryAction}${secondary}</div></div></section>
      <section class="run-center-summary-row"><span class="run-center-summary-row-icon">${icon('send')}</span><div><small>${esc(text('run_center.summary_destination'))}</small><h3>${esc(destination)}</h3><p>${esc(text('run_center.summary_destination_detail'))}</p></div></section>
      <dl class="run-center-summary-context"><div><dt>${esc(text('run_center.label_agent'))}</dt><dd>${esc(agentDisplayName(task.agentId) || text('run_center.commander'))}</dd></div><div><dt>${esc(text('run_center.label_execution_source'))}</dt><dd>${esc(text(`run_center.source_${task.sourceKind || 'cogseed'}`))}</dd></div><div><dt>${esc(text('run_center.label_worktree'))}</dt><dd>${esc(worktree)}</dd></div><div><dt>${esc(text('run_center.label_updated'))}</dt><dd>${esc(formatDate(task.updatedAt))}</dd></div>${workflow.phase ? `<div><dt>${esc(text('run_center.label_phase'))}</dt><dd>${esc(workflow.phase)}</dd></div>` : ''}</dl>
    </div>`;
  }
  function historyTabHtml(model) {
    const { collaboration, selection } = model;
    const attempts = selection.attempts;
    const selectedAttempt = selection.selected;
    const focusKey = attempts.some((attempt) => attempt.key === state.attemptFocusKey)
      ? state.attemptFocusKey : selectedAttempt?.key;
    const rows = attempts.map((attempt, index) => {
      const task = attempt.representative || attempt;
      const selected = attempt.key === selectedAttempt?.key;
      const ordinal = text('run_center.inspector_attempt_index', { count: attempts.length - index });
      const badges = [
        index === 0 ? ['latest', 'run_center.attempt_badge_latest'] : null,
        attemptIsRunning(attempt) ? ['running', 'run_center.attempt_badge_running'] : null,
        attemptIsFailed(attempt) ? ['failed', 'run_center.attempt_badge_failed'] : null,
        attemptIsRecovered(attempts, index) ? ['recovered', 'run_center.attempt_badge_recovered'] : null,
      ].filter(Boolean).map(([kind, key]) => `<span class="is-${kind}">${esc(text(key))}</span>`).join('');
      return `<li role="presentation"><button type="button" role="tab" aria-selected="${String(selected)}" class="run-center-attempt${selected ? ' is-selected' : ''}" data-run-center-attempt-index="${index}" tabindex="${attempt.key === focusKey ? '0' : '-1'}"><span class="run-center-attempt-main"><span class="run-center-attempt-index">${esc(ordinal)}</span><span class="${statusClass(attempt.status)}">${esc(text(statusKey(attempt.status)))}</span></span><span class="run-center-attempt-badges">${badges}</span><span class="run-center-attempt-meta"><time datetime="${esc(attempt.updatedAt)}">${esc(formatDate(attempt.updatedAt))}</time><small>${icon('terminal')}${esc(agentDisplayName(task.agentId) || text('run_center.commander'))}</small></span></button></li>`;
    }).join('');
    const timeline = Array.isArray(collaboration?.timeline) ? collaboration.timeline : [];
    const tasks = Array.isArray(collaboration?.tasks) ? collaboration.tasks : [];
    return `<div class="run-center-history">
      <section><header><div><h3>${esc(text('run_center.history_runs'))}</h3><p>${esc(text('run_center.history_runs_detail'))}</p></div><span>${esc(attempts.length)}</span></header>${attempts.length ? `<ol class="run-center-attempt-list" role="tablist" aria-label="${esc(text('run_center.inspector_attempts'))}">${rows}</ol>` : stateView('run_center.tasks_empty')}</section>
      <section><header><div><h3>${esc(text('run_center.timeline'))}</h3><p>${esc(text('run_center.history_timeline_detail'))}</p></div><span>${esc(timeline.length)}</span></header>${timelineHtml(timeline, tasks)}</section>
    </div>`;
  }
  function detailsHtml() {
    const model = detailModel();
    const { collaboration, run, task, aggregateTask, selection } = model;
    if (!aggregateTask) return stateView(state.loading ? 'run_center.loading_detail' : 'run_center.select_item');
    const hasCollaboration = collaborationAvailable(collaboration, task);
    const activeTab = state.detailTab === 'collaboration' && !hasCollaboration ? 'summary' : state.detailTab;
    const sequence = runSequenceByKey().get(run?.key);
    const sequenceLabel = text('run_center.run_sequence', sequence || { index: 1, count: selection.attempts.length || 1 });
    const tabs = [
      ['summary', 'run_center.detail_summary'],
      ['history', 'run_center.detail_history'],
      hasCollaboration ? ['collaboration', 'run_center.detail_collaboration'] : null,
    ].filter(Boolean);
    const content = !state.detail && state.selectedSessionId
      ? stateView('run_center.loading_detail')
      : activeTab === 'history' ? historyTabHtml(model)
        : activeTab === 'collaboration' ? collaborationHtml()
          : summaryTabHtml(model);
    return `<div class="run-center-run-detail" aria-live="polite" aria-busy="${String(!state.detail && !!state.selectedSessionId)}">
      <header class="run-center-run-detail-header"><button type="button" class="run-center-detail-back" data-run-center-detail-back aria-label="${esc(text('run_center.back_to_runs'))}">${icon('chevron-left')}</button><div><span class="${statusClass(aggregateTask.status)}">${esc(text(statusKey(aggregateTask.status)))}</span><h2>${esc(displayRunTitle(run, aggregateTask))}</h2><p>${esc(sequenceLabel)} · ${esc(agentDisplayName(task?.agentId) || text('run_center.commander'))} · ${esc(formatDate(aggregateTask.updatedAt))}</p></div><span class="run-center-detail-actions">${task?.conversationId ? `<button type="button" class="run-center-icon-btn" data-run-center-open="${esc(task.conversationId)}" title="${esc(text('run_center.open_task'))}" aria-label="${esc(text('run_center.open_task'))}">${icon('message-square')}</button>` : ''}${state.runMode === 'board' ? `<button type="button" class="run-center-icon-btn run-center-detail-close" data-run-center-detail-close title="${esc(text('common.close'))}" aria-label="${esc(text('common.close'))}">${icon('x')}</button>` : ''}</span></header>
      <div class="run-center-detail-tabs" role="tablist" aria-label="${esc(text('run_center.run_detail'))}">${tabs.map(([tab, key]) => `<button type="button" role="tab" aria-selected="${String(activeTab === tab)}" class="${activeTab === tab ? 'is-active' : ''}" data-run-center-detail-tab="${tab}">${esc(text(key))}</button>`).join('')}</div>
      <div class="run-center-detail-content" role="tabpanel">${content}</div>
    </div>`;
  }
  function createModalHtml() {
    if (!state.createMode) return '';
    const selected = selectedTask() || state.detail?.collaboration?.task;
    const agentDataReady = agentOptionsReady();
    const agents = taskDispatchableAgentCandidates()
      .filter((agent) => state.createMode !== 'reassign' || agent.agentId !== selected?.agentId);
    const options = agents.map((agent) => `<option value="${esc(agent.agentId)}"${agent.agentId === state.createAgentId ? ' selected' : ''}>${esc(taskAgentOptionLabel(agent))}</option>`).join('');
    const isReassign = state.createMode === 'reassign';
    const managedWorktrees = (Array.isArray(state.worktrees?.worktrees) ? state.worktrees.worktrees : [])
      .filter((item) => item.verifiable && !item.dirty);
    const worktreeOptions = managedWorktrees.map((item) => `<option value="${esc(item.name)}"${item.name === state.createWorktreeName ? ' selected' : ''}>${esc(item.branch || item.name)} · ${esc(item.name)}</option>`).join('');
    return `<div class="run-center-create-overlay" data-run-center-create-overlay>
      <section class="run-center-create-dialog" role="dialog" aria-modal="true" aria-labelledby="run-center-create-title" data-run-center-create-dialog>
        <header><div><h2 id="run-center-create-title">${esc(text(isReassign ? 'run_center.reassign_title' : 'run_center.create_title'))}</h2><p>${esc(text(isReassign ? 'run_center.reassign_subtitle' : 'run_center.create_subtitle'))}</p></div><button type="button" class="run-center-icon-btn" data-run-center-create-close aria-label="${esc(text('common.close'))}">${icon('x')}</button></header>
        <div class="run-center-create-body">
          ${isReassign ? `<div class="run-center-create-private">${icon('shield')}<span>${esc(text('run_center.reassign_private'))}</span></div>` : `<label><span>${esc(text('run_center.create_task_label'))}</span><textarea data-run-center-create-task rows="6" maxlength="64000" placeholder="${esc(text('run_center.create_task_placeholder'))}">${esc(state.createTask)}</textarea></label>`}
          ${isReassign ? `<label><span>${esc(text('run_center.create_agent_label'))}</span><select data-run-center-create-agent ${state.createBusy || !agentDataReady ? 'disabled' : ''}><option value="">${esc(text('run_center.choose_agent'))}</option>${options}</select></label>
            ${!agentDataReady ? `<small class="run-center-create-note">${esc(text('run_center.loading_agents'))}</small>` : ''}
            ${selected?.worktreeName ? `<div class="run-center-create-private">${icon('git-branch')}<span>${esc(text('run_center.reassign_worktree_inherited', { name: selected.worktreeName }))}</span></div>` : ''}` : `<button type="button" class="run-center-create-advanced-toggle" data-run-center-create-advanced aria-expanded="${String(state.createAdvancedOpen)}" aria-controls="run-center-create-advanced-panel"><span>${icon('settings')}<span><strong>${esc(text('run_center.advanced_options'))}</strong><small>${esc(text('run_center.advanced_defaults'))}</small></span></span>${icon(state.createAdvancedOpen ? 'chevron-up' : 'chevron-down')}</button>
            ${state.createAdvancedOpen ? `<div id="run-center-create-advanced-panel" class="run-center-create-advanced-panel">
              <label><span>${esc(text('run_center.create_agent_label'))}</span><select data-run-center-create-agent ${state.createBusy || !agentDataReady ? 'disabled' : ''}><option value="">${esc(text('run_center.default_agent'))}</option>${options}</select></label>
              ${!agentDataReady ? `<small class="run-center-create-note">${esc(text('run_center.create_agent_unavailable'))}</small>` : ''}
              <label><span>${esc(text('run_center.create_isolation_label'))}</span><select data-run-center-create-worktree ${state.createBusy || state.worktreesLoading ? 'disabled' : ''}><option value="">${esc(text('run_center.current_workspace'))}</option>${worktreeOptions}</select></label>
              ${state.worktreesLoading ? `<small class="run-center-create-note" role="status">${esc(text('run_center.worktrees_loading'))}</small>` : state.worktreesError ? `<div class="run-center-create-worktree-retry"><small class="run-center-create-note">${esc(text('run_center.create_worktree_unavailable'))}</small><button type="button" class="btn btn-sm" data-run-center-create-worktrees-retry>${icon('refresh')}<span>${esc(text('run_center.retry_load'))}</span></button></div>` : !managedWorktrees.length ? `<small class="run-center-create-note">${esc(text('run_center.create_worktree_empty'))}</small>` : `<small class="run-center-create-note">${esc(text('run_center.create_worktree_note'))}</small>`}
              ${state.createAdvancedError ? `<small class="run-center-create-note is-error" role="status">${esc(state.createAdvancedError)}</small>` : ''}
            </div>` : ''}`}
          ${state.createError ? `<div class="run-center-create-error" role="alert">${esc(state.createError)}</div>` : ''}
        </div>
        <footer><button type="button" class="btn btn-sm" data-run-center-create-close ${state.createBusy ? 'disabled' : ''}>${esc(text('common.cancel'))}</button><button type="button" class="btn btn-sm btn-primary" data-run-center-create-submit ${state.createBusy ? 'disabled' : ''}>${state.createBusy ? icon('loader', 'ui-icon is-spinning') : icon('play-triangle')}<span>${esc(text(state.createBusy ? 'run_center.creating' : isReassign ? 'run_center.reassign_submit' : 'run_center.create_submit'))}</span></button></footer>
      </section>
    </div>`;
  }
  function diagnosticsHtml() {
    if (!state.diagnosticsOpen) return '';
    const data = state.diagnostics;
    const metric = (label, value) => `<div><span>${esc(text(label))}</span><strong>${esc(value == null ? '—' : value)}</strong></div>`;
    const sources = data ? Object.entries(data.sourceCounts || {}).filter(([, count]) => count > 0) : [];
    const statuses = data ? Object.entries(data.statusCounts || {}).filter(([, count]) => count > 0) : [];
    return `<div class="run-center-create-overlay">
      <section class="run-center-create-dialog run-center-diagnostics-dialog" role="dialog" aria-modal="true" aria-labelledby="run-center-diagnostics-title" data-run-center-diagnostics-dialog>
        <header><div><h2 id="run-center-diagnostics-title">${esc(text('run_center.diagnostics_title'))}</h2><p>${esc(text('run_center.diagnostics_subtitle'))}</p></div><button type="button" class="run-center-icon-btn" data-run-center-diagnostics-close aria-label="${esc(text('common.close'))}">${icon('x')}</button></header>
        <div class="run-center-create-body">
          ${state.diagnosticsLoading ? stateView('run_center.diagnostics_loading') : state.diagnosticsError ? retryStateHtml(state.diagnosticsError, 'data-run-center-diagnostics-retry') : data ? `<div class="run-center-diagnostic-metrics">${metric('run_center.diagnostic_tasks', data.taskCount)}${metric('run_center.diagnostic_sessions', data.sessionCount)}${metric('run_center.diagnostic_active', data.activeTaskCount)}${metric('run_center.diagnostic_attention', data.attentionTaskCount)}</div>
          <section class="run-center-diagnostic-section"><h3>${esc(text('run_center.diagnostic_sources'))}</h3><div class="run-center-diagnostic-tags">${sources.map(([source, count]) => `<span>${esc(text(`run_center.source_${source}`))}<b>${esc(count)}</b></span>`).join('') || esc(text('run_center.none'))}</div></section>
          <section class="run-center-diagnostic-section"><h3>${esc(text('run_center.diagnostic_statuses'))}</h3><div class="run-center-diagnostic-tags">${statuses.map(([status, count]) => `<span>${esc(text(statusKey(status)))}<b>${esc(count)}</b></span>`).join('') || esc(text('run_center.none'))}</div></section>
          <section class="run-center-diagnostic-section"><h3>${esc(text('run_center.diagnostic_runtime'))}</h3><div class="run-center-diagnostic-runtime"><span>${esc(text('run_center.diagnostic_runtime_active', { count: data.runtime?.activeTaskCount || 0 }))}</span><span class="${data.runtime?.stateMatchesProjection ? 'is-ok' : 'is-warning'}">${esc(text(data.runtime?.stateMatchesProjection ? 'run_center.diagnostic_consistent' : 'run_center.diagnostic_inconsistent'))}</span></div></section>
          <section class="run-center-diagnostic-section"><h3>${esc(text('run_center.diagnostic_error_codes'))}</h3>${data.errorCodes?.length ? `<ul>${data.errorCodes.map((item) => `<li><code>${esc(item.code)}</code><b>${esc(item.count)}</b></li>`).join('')}</ul>` : `<p>${esc(text('run_center.diagnostic_no_errors'))}</p>`}</section>
          <div class="run-center-create-private">${icon('shield')}<span>${esc(text('run_center.diagnostics_privacy'))}</span></div>` : ''}
        </div>
        <footer><button type="button" class="btn btn-sm" data-run-center-diagnostics-close>${esc(text('common.close'))}</button><button type="button" class="btn btn-sm btn-primary" data-run-center-diagnostics-export ${!data || state.diagnosticsLoading ? 'disabled' : ''}>${icon('download')}<span>${esc(text('run_center.diagnostics_export'))}</span></button></footer>
      </section>
    </div>`;
  }
  function worktreeErrorMessage(error) {
    const code = String(error?.code || error?.message || '');
    const suffix = code.startsWith('E_WORKTREE_') ? code.slice('E_WORKTREE_'.length).toLocaleLowerCase() : '';
    if (suffix) {
      const key = `run_center.worktree_error_${suffix}`;
      const localized = text(key);
      if (localized && localized !== key) return localized;
    }
    return text('run_center.worktree_error_unknown');
  }
  function worktreesHtml() {
    if (!state.worktreesOpen) return '';
    const projection = state.worktrees;
    const items = Array.isArray(projection?.worktrees) ? projection.worktrees : [];
    const busy = state.worktreeBusy;
    const status = (item) => item.verifiable
      ? text(item.dirty ? 'run_center.worktree_dirty' : 'run_center.worktree_clean')
      : text('run_center.worktree_unverified');
    const list = items.length ? `<ul class="run-center-worktree-list">${items.map((item) => `<li>
      <div class="run-center-worktree-item-heading"><div>${icon('git-branch')}<strong>${esc(item.branch || item.name)}</strong></div><span class="${item.verifiable && !item.dirty ? 'is-clean' : 'is-blocked'}">${esc(status(item))}</span></div>
      <code>${esc(item.path)}</code><small>${esc(item.name)}${item.head ? ` · ${esc(String(item.head).slice(0, 12))}` : ''}</small>
      <div class="run-center-inline-actions"><button type="button" class="btn btn-sm btn-danger" data-run-center-worktree-remove data-worktree-path="${esc(item.path)}" data-worktree-branch="${esc(item.branch)}" ${busy || !item.verifiable || item.dirty ? 'disabled' : ''}>${busy === item.path ? icon('loader', 'ui-icon is-spinning') : icon('trash')}<span>${esc(text(busy === item.path ? 'run_center.worktree_removing' : 'run_center.worktree_remove'))}</span></button></div>
    </li>`).join('')}</ul>` : `<div class="run-center-worktree-empty">${esc(text('run_center.worktree_empty'))}</div>`;
    return `<div class="run-center-create-overlay">
      <section class="run-center-create-dialog run-center-worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="run-center-worktree-title" data-run-center-worktrees-dialog>
        <header><div><h2 id="run-center-worktree-title">${esc(text('run_center.worktrees_title'))}</h2><p>${esc(text('run_center.worktrees_subtitle'))}</p></div><button type="button" class="run-center-icon-btn" data-run-center-worktrees-close aria-label="${esc(text('common.close'))}">${icon('x')}</button></header>
        <div class="run-center-create-body">
          ${state.worktreesLoading && !projection ? stateView('run_center.worktrees_loading') : state.worktreesError && !projection ? retryStateHtml(state.worktreesError, 'data-run-center-worktrees-retry') : projection ? `${state.worktreesLoading ? `<small class="run-center-create-note" role="status">${esc(text('run_center.worktrees_loading'))}</small>` : ''}<section class="run-center-worktree-repository"><div><span>${esc(text('run_center.worktree_repository'))}</span><strong>${esc(projection.repository?.branch || text('run_center.worktree_detached'))}</strong></div><code>${esc(projection.repository?.path || '')}</code></section>
          <section class="run-center-worktree-create"><h3>${esc(text('run_center.worktree_create_title'))}</h3><div><label><span>${esc(text('run_center.worktree_branch'))}</span><input type="text" maxlength="200" data-run-center-worktree-branch value="${esc(state.worktreeBranch)}" placeholder="${esc(text('run_center.worktree_branch_placeholder'))}" ${busy ? 'disabled' : ''}></label><label><span>${esc(text('run_center.worktree_base'))}</span><input type="text" maxlength="300" data-run-center-worktree-base value="${esc(state.worktreeBaseRef)}" placeholder="HEAD" ${busy ? 'disabled' : ''}></label></div><button type="button" class="btn btn-sm btn-primary" data-run-center-worktree-create ${busy ? 'disabled' : ''}>${busy === 'create' ? icon('loader', 'ui-icon is-spinning') : icon('plus')}<span>${esc(text(busy === 'create' ? 'run_center.worktree_creating' : 'run_center.worktree_create'))}</span></button></section>
          <section class="run-center-worktree-managed"><h3>${esc(text('run_center.worktree_managed'))}</h3>${list}</section>
          ${state.worktreesError ? retryStateHtml(state.worktreesError, 'data-run-center-worktrees-retry') : ''}${state.worktreeNotice ? `<div class="run-center-worktree-success" role="status">${esc(state.worktreeNotice)}</div>` : ''}
          <div class="run-center-create-private">${icon('shield')}<span>${esc(text('run_center.worktree_safety'))}</span></div>` : ''}
        </div>
        <footer><button type="button" class="btn btn-sm" data-run-center-worktrees-close ${busy ? 'disabled' : ''}>${esc(text('common.close'))}</button></footer>
      </section>
    </div>`;
  }
  function collaborationSelectedHtml(run, sequence) {
    if (!run) return '';
    const detail = state.detail?.collaboration;
    const task = detail?.task || selectedTask() || runTask(run);
    if (!task) return '';
    const participantCount = Math.max(
      Number(task.participantCount || detail?.session?.participantCount || 0),
      Array.isArray(detail?.actors) ? detail.actors.length : 0,
    );
    const executor = participantCount >= 2
      ? text('run_center.participant_count', { count: participantCount })
      : agentDisplayName(task.agentId) || text('run_center.commander');
    const executorLabel = participantCount >= 2 ? text('run_center.label_participants') : text('run_center.label_agent');
    const delivery = dynamicLabel('run_center.delivery_', task.resultDeliveryState, 'run_center.delivery_unknown');
    const sequenceLabel = text('run_center.run_sequence', { index: sequence?.index || 1, count: sequence?.count || 1 });
    return `<section class="run-center-collaboration-selected" aria-labelledby="run-center-collaboration-selected-title">
      <header><div class="run-center-collaboration-selected-heading"><span>${esc(text('run_center.selected_run'))}${sequenceLabel ? ` · ${esc(sequenceLabel)}` : ''}</span><div><h2 id="run-center-collaboration-selected-title">${esc(displayRunTitle(run, task))}</h2><span class="${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span></div></div>
      <div class="run-center-collaboration-selected-actions">${task.conversationId ? `<button type="button" class="btn btn-sm btn-primary" data-run-center-open="${esc(task.conversationId)}">${icon('message-square')}<span>${esc(text('run_center.open_task'))}</span></button>` : ''}<button type="button" class="btn btn-sm" data-run-center-detail-open>${icon('panel-right')}<span>${esc(text('run_center.details'))}</span></button></div></header>
      <dl><div><dt>${esc(executorLabel)}</dt><dd>${esc(executor)}</dd></div><div><dt>${esc(text('run_center.label_updated'))}</dt><dd>${esc(formatDate(task.updatedAt))}</dd></div><div><dt>${esc(text('run_center.label_delivery'))}</dt><dd>${esc(delivery)}</dd></div></dl>
    </section>`;
  }
  function collaborationWorkspaceHtml() {
    const runs = orderedVisibleRuns();
    const filtered = state.search.trim() || state.sourceFilter !== 'all' || state.filter !== 'all'
      || state.runAgentFilter !== 'all' || state.runTimeFilter !== 'all' || state.showArchived;
    const sequences = runSequenceByKey();
    const selectedRun = runs.find((run) => run.key === state.selectedRunKey) || null;
    const selectedRunIndex = selectedRun ? runs.indexOf(selectedRun) : -1;
    const selectedTabId = selectedRunIndex >= 0 ? `run-center-collaboration-run-${selectedRunIndex}` : '';
    const rovingKey = selectedRun?.key || runs[0]?.key || '';
    const runButtons = runs.map((run, index) => {
      const task = runTask(run);
      if (!task) return '';
      const selected = run.key === selectedRun?.key;
      const sequence = sequences.get(run.key);
      const sequenceLabel = text('run_center.run_sequence', { index: sequence?.index || 1, count: sequence?.count || 1 });
      const participantCount = Number(task.participantCount || 0);
      const executor = participantCount >= 2
        ? text('run_center.participant_count', { count: participantCount })
        : agentDisplayName(task.agentId) || text('run_center.commander');
      return `<button type="button" id="run-center-collaboration-run-${index}" role="tab" class="run-center-collaboration-run${selected ? ' is-selected' : ''}" data-run-center-collaboration-run-key="${esc(run.key)}" data-run-center-collaboration-session="${esc(task.sessionId)}" data-run-center-collaboration-task="${esc(task.taskId)}" aria-controls="run-center-collaboration-detail" aria-selected="${selected ? 'true' : 'false'}" aria-current="${selected ? 'true' : 'false'}" tabindex="${run.key === rovingKey ? '0' : '-1'}">
        <span class="run-center-collaboration-run-heading"><strong>${esc(displayRunTitle(run, task))}</strong><span class="${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span></span>
        <span class="run-center-collaboration-run-meta">${sequenceLabel ? `<span>${esc(sequenceLabel)}</span>` : ''}<span>${esc(executor)}</span><time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time></span>
      </button>`;
    }).join('');
    const emptyMessage = state.error
      ? stateView('run_center.load_failed', state.error)
      : stateView(state.loading ? 'run_center.loading' : filtered ? 'run_center.no_matches' : 'run_center.empty');
    const listContent = runButtons || `<div class="run-center-collaboration-run-list-empty" role="status">${emptyMessage}</div>`;
    const detailBusy = state.loading || (!!selectedRun && !state.detail && !state.error);
    const detailContent = selectedRun
      ? `${collaborationSelectedHtml(selectedRun, sequences.get(selectedRun.key))}${collaborationHtml()}`
      : emptyMessage;
    return `<aside class="run-center-collaboration-runs" aria-labelledby="run-center-collaboration-runs-title"><header><h2 id="run-center-collaboration-runs-title">${esc(text('run_center.collaboration_runs'))}</h2><span>${esc(text('run_center.query_result_count', { count: runs.length }))}</span></header><div class="run-center-collaboration-run-list" role="tablist" aria-labelledby="run-center-collaboration-runs-title">${listContent}</div></aside>
      <main class="run-center-main${selectedRun ? '' : ' is-empty'}" id="run-center-collaboration-detail" role="tabpanel"${selectedTabId ? ` aria-labelledby="${selectedTabId}"` : ''} aria-live="polite" aria-busy="${String(detailBusy)}"><div class="run-center-collaboration-detail">${detailContent}</div></main>`;
  }
  function navigationHtml() {
    return `<div class="run-center-view-tabs" role="tablist" aria-orientation="horizontal" aria-label="${esc(text('run_center.title'))}">${VIEW_DEFINITIONS.map(([view, label]) => `<button type="button" id="run-center-tab-${view}" role="tab" aria-controls="run-center-panel-${view}" aria-selected="${String(state.view === view)}" tabindex="${state.view === view ? '0' : '-1'}" class="run-center-tab${state.view === view ? ' is-active' : ''}" data-run-center-view="${view}">${esc(text(label))}</button>`).join('')}</div>`;
  }
  function queryBarHtml(options = {}) {
    const includeModeSwitch = options.modeSwitch !== false;
    const count = visibleBoardRuns().length;
    const tasks = (state.board?.tasks || []);
    const agentIds = Array.from(new Set(tasks.map((task) => String(task.agentId || 'commander')))).sort((left, right) =>
      agentDisplayName(left).localeCompare(agentDisplayName(right)));
    return `<div class="run-center-query-bar">
      <label class="run-center-query-search">${icon('search')}<input type="search" value="${esc(state.search)}" data-run-center-search placeholder="${esc(text('run_center.search_placeholder'))}" aria-label="${esc(text('run_center.search_placeholder'))}"></label>
      <select class="run-center-source-filter" data-run-center-source-filter aria-label="${esc(text('run_center.source_filter'))}">${['all', 'cogseed', 'agent', 'local-cli', 'p3394-gateway', 'agent-conversation', 'group-chat'].map((source) => `<option value="${source}"${state.sourceFilter === source ? ' selected' : ''}>${esc(source === 'all' ? text('run_center.source_all') : text(`run_center.source_${source}`))}</option>`).join('')}</select>
      <select class="run-center-agent-filter" data-run-center-run-agent-filter aria-label="${esc(text('run_center.run_agent_filter'))}"><option value="all">${esc(text('run_center.run_agent_all'))}</option>${agentIds.map((agentId) => `<option value="${esc(agentId)}"${state.runAgentFilter === agentId ? ' selected' : ''}>${esc(agentId === 'commander' ? text('run_center.commander') : agentDisplayName(agentId))}</option>`).join('')}</select>
      <select class="run-center-time-filter" data-run-center-time-filter aria-label="${esc(text('run_center.time_filter'))}">${['all', 'today', '7d', '30d'].map((value) => `<option value="${value}"${state.runTimeFilter === value ? ' selected' : ''}>${esc(text(`run_center.time_${value}`))}</option>`).join('')}</select>
      <div class="run-center-filters" aria-label="${esc(text('run_center.status_filter'))}">${['all', 'pending', 'running', 'attention', 'completed'].map((filter) => `<button type="button" aria-pressed="${String(state.filter === filter)}" class="run-center-filter${state.filter === filter ? ' is-active' : ''}" data-run-center-filter="${filter}">${esc(text(`run_center.filter_${filter}`))}</button>`).join('')}</div>
      ${includeModeSwitch ? `<div class="run-center-mode-switch" role="group" aria-label="${esc(text('run_center.display_mode'))}">${[['queue', 'list', 'run_center.mode_queue'], ['board', 'layout-grid', 'run_center.mode_board']].map(([mode, iconName, key]) => `<button type="button" class="${state.runMode === mode ? 'is-active' : ''}" data-run-center-mode="${mode}" aria-pressed="${String(state.runMode === mode)}" title="${esc(text(key))}">${icon(iconName)}<span>${esc(text(key))}</span></button>`).join('')}</div>` : ''}
      <button type="button" class="run-center-archive-scope${state.showArchived ? ' is-active' : ''}" data-run-center-archive-scope aria-pressed="${String(state.showArchived)}" aria-label="${esc(text('run_center.include_archived'))}" title="${esc(text('run_center.include_archived'))}">${icon('archive')}<span>${esc(text('run_center.include_archived'))}</span></button>
      <span class="run-center-query-count" data-run-center-query-count role="status" aria-live="polite">${esc(text('run_center.query_result_count', { count }))}</span>
      ${state.search.trim() ? `<button type="button" class="run-center-query-clear" data-run-center-query-clear>${icon('x')}<span>${esc(text('run_center.clear_search'))}</span></button>` : ''}
    </div>`;
  }
  function render() {
    const target = panel();
    if (!target) return;
    rootWindow.CogSeedRunCenterOverview?.destroy?.();
    const viewHtml = state.view === 'overview' ? overviewHtml()
      : state.view === 'agents' ? agentsHtml()
        : state.view === 'collaboration' ? collaborationWorkspaceHtml() : '';
    const overview = state.view === 'overview';
    const standalone = overview || state.view === 'agents';
    const collaboration = state.view === 'collaboration';
    const runHistory = state.view === 'history';
    const filterable = ['runs', 'history', 'collaboration'].includes(state.view);
    const panelAttributes = `id="run-center-panel-${esc(state.view)}" role="tabpanel" aria-labelledby="run-center-tab-${esc(state.view)}"`;
    const inactivePanels = VIEW_DEFINITIONS.filter(([view]) => view !== state.view)
      .map(([view]) => `<div id="run-center-panel-${view}" role="tabpanel" aria-labelledby="run-center-tab-${view}" hidden></div>`).join('');
    // Keep `is-runs` as the shared structural class for both run-oriented tabs.
    const runLayoutClass = state.view === 'runs' || state.view === 'history'
      ? `is-runs${runHistory ? ' is-history' : ''}` : '';
    const layout = collaboration
      ? `<div class="run-center-layout is-collaboration" ${panelAttributes}>${viewHtml}</div>`
      : standalone
      ? `<div class="run-center-layout is-${esc(state.view)}" ${panelAttributes}><main class="run-center-main">${viewHtml}</main></div>`
      : `<div class="run-center-layout ${runLayoutClass} is-${esc(state.runMode)}-mode${state.detailOpen ? ' is-detail-open' : ''}" ${panelAttributes}>
          <aside class="run-center-run-list-pane${state.runMode === 'board' ? ' is-board' : ''}" aria-label="${esc(text(state.runMode === 'board' ? 'run_center.mode_board' : 'run_center.mode_queue'))}">${state.runMode === 'board' ? boardHtml() : queueHtml()}</aside>
          <main class="run-center-run-detail-pane">${detailsHtml()}</main>
        </div>`;
    const modalOpen = !!state.createMode || state.diagnosticsOpen || state.worktreesOpen;
    target.innerHTML = `<div class="run-center-shell"${modalOpen ? ' inert aria-hidden="true"' : ''}>
      <header class="run-center-header"><div><h1>${esc(text('run_center.title'))}</h1><p>${esc(text('run_center.subtitle'))}</p></div><div class="run-center-header-actions"><button type="button" class="btn btn-sm btn-primary" data-run-center-create-open title="${esc(text('run_center.create_task'))}" aria-label="${esc(text('run_center.create_task'))}">${icon('plus')}<span>${esc(text('run_center.create_task'))}</span></button><button type="button" class="run-center-icon-btn" data-run-center-refresh title="${esc(text('run_center.refresh'))}" aria-label="${esc(text('run_center.refresh'))}">${icon('refresh')}</button><div class="run-center-more-menu"><button type="button" class="run-center-icon-btn" data-run-center-tools-toggle title="${esc(text('run_center.more_tools'))}" aria-label="${esc(text('run_center.more_tools'))}" aria-haspopup="menu" aria-controls="run-center-tools-menu" aria-expanded="${String(state.toolsOpen)}">${icon('more-horizontal')}</button>${state.toolsOpen ? `<div id="run-center-tools-menu" role="menu" data-run-center-tools-menu><button type="button" role="menuitem" tabindex="0" data-run-center-worktrees-open>${icon('git-branch')}<span>${esc(text('run_center.worktrees'))}</span></button><button type="button" role="menuitem" tabindex="-1" data-run-center-diagnostics-open>${icon('activity')}<span>${esc(text('run_center.diagnostics'))}</span></button></div>` : ''}</div></div></header>
      <nav class="run-center-navigation">${navigationHtml()}</nav>
      ${filterable ? queryBarHtml({ modeSwitch: state.view === 'runs' }) : ''}
      ${layout}${inactivePanels}
    </div>${createModalHtml()}${diagnosticsHtml()}${worktreesHtml()}`;
    if (overview && state.overviewAnalysisOpen) rootWindow.CogSeedRunCenterOverview?.mount?.(target);
  }
  async function loadDiagnostics() {
    const revision = ++state.diagnosticsRequestRevision;
    state.diagnosticsLoading = true;
    state.diagnosticsError = '';
    renderPreservingFocus(state.diagnosticsOpen ? '[data-run-center-diagnostics-close]' : '');
    try {
      const diagnostics = await invoke('cogseed.dashboard.diagnostics');
      if (revision !== state.diagnosticsRequestRevision) return;
      state.diagnostics = diagnostics;
      state.diagnosticsError = '';
    } catch {
      if (revision !== state.diagnosticsRequestRevision) return;
      state.diagnosticsError = text('run_center.diagnostics_load_failed');
    }
    finally {
      if (revision === state.diagnosticsRequestRevision) {
        state.diagnosticsLoading = false;
        renderPreservingFocus(state.diagnosticsOpen ? '[data-run-center-diagnostics-close]' : '');
      }
    }
  }
  function openDiagnostics() {
    state.toolsOpen = false;
    state.diagnosticsOpen = true;
    loadDiagnostics();
    focusLater('[data-run-center-diagnostics-close]');
  }
  function closeDiagnostics() {
    state.diagnosticsRequestRevision += 1;
    state.diagnosticsLoading = false;
    state.diagnosticsOpen = false;
    render();
    focusLater('[data-run-center-tools-toggle]');
  }
  function exportDiagnostics() {
    if (!state.diagnostics) return;
    const payload = JSON.stringify({ format: 'cogseed-run-center-diagnostics', ...state.diagnostics }, null, 2);
    const url = URL.createObjectURL(new Blob([`${payload}\n`], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cogseed-run-center-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    rootWindow.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function worktreesRequestIsCurrent(revision, owner) {
    return revision === state.worktreesRequestRevision && owner === state.worktreesRequestOwner;
  }
  function invalidateWorktreesRequest(owner) {
    if (owner && state.worktreesRequestOwner && owner !== state.worktreesRequestOwner) return;
    state.worktreesRequestRevision += 1;
    state.worktreesRequestOwner = '';
    state.worktreesLoading = false;
  }
  async function loadWorktrees(owner) {
    const revision = ++state.worktreesRequestRevision;
    state.worktreesRequestOwner = owner;
    state.worktreesLoading = true;
    state.worktreesError = '';
    const fallbackSelector = owner === 'manager' && state.worktreesOpen
      ? '[data-run-center-worktrees-close]'
      : owner === 'create' && state.createMode ? '[data-run-center-create-task], [data-run-center-create-agent]' : '';
    renderPreservingFocus(fallbackSelector);
    try {
      const worktrees = await invoke('cogseed.worktree.list');
      if (!worktreesRequestIsCurrent(revision, owner)) return;
      state.worktrees = worktrees;
      state.worktreesError = '';
    } catch (error) {
      if (!worktreesRequestIsCurrent(revision, owner)) return;
      state.worktreesError = worktreeErrorMessage(error);
    }
    finally {
      if (worktreesRequestIsCurrent(revision, owner)) {
        state.worktreesLoading = false;
        renderPreservingFocus(fallbackSelector);
      }
    }
  }
  function openWorktrees() {
    state.toolsOpen = false;
    state.worktreesOpen = true;
    state.worktreesError = '';
    state.worktreeNotice = '';
    loadWorktrees('manager');
    focusLater('[data-run-center-worktrees-close]');
  }
  function closeWorktrees() {
    if (state.worktreeBusy) return;
    invalidateWorktreesRequest('manager');
    state.worktreesOpen = false;
    state.worktreesError = '';
    state.worktreeNotice = '';
    render();
    focusLater('[data-run-center-tools-toggle]');
  }
  async function createWorktree() {
    if (state.worktreeBusy) return;
    if (!state.worktreeBranch.trim()) {
      state.worktreesError = text('run_center.worktree_branch_required');
      render();
      return;
    }
    state.worktreeBusy = 'create';
    state.worktreesError = '';
    state.worktreeNotice = '';
    renderPreservingFocus('[data-run-center-worktrees-close]');
    try {
      await invoke('cogseed.worktree.create', { branch: state.worktreeBranch.trim(), baseRef: state.worktreeBaseRef.trim() || 'HEAD' });
      state.worktreeBranch = '';
      state.worktreeNotice = text('run_center.worktree_created');
      await loadWorktrees('manager');
    } catch (error) {
      state.worktreesError = worktreeErrorMessage(error);
    } finally {
      state.worktreeBusy = '';
      renderPreservingFocus(state.worktreesOpen ? '[data-run-center-worktrees-close]' : '');
    }
  }
  async function removeWorktree(worktreePath, branch) {
    if (state.worktreeBusy || !worktreePath || !branch) return;
    if (!rootWindow.confirm(text('run_center.worktree_remove_confirm', { branch }))) return;
    state.worktreeBusy = worktreePath;
    state.worktreesError = '';
    state.worktreeNotice = '';
    renderPreservingFocus('[data-run-center-worktrees-close]');
    try {
      await invoke('cogseed.worktree.remove', { path: worktreePath, expectedBranch: branch });
      state.worktreeNotice = text('run_center.worktree_removed');
      await loadWorktrees('manager');
    } catch (error) {
      state.worktreesError = worktreeErrorMessage(error);
    } finally {
      state.worktreeBusy = '';
      renderPreservingFocus(state.worktreesOpen ? '[data-run-center-worktrees-close]' : '');
    }
  }
  async function loadAgents() {
    if (state.agentsLoaded) return;
    try {
      const result = await invoke('agents.list', { summary: true });
      state.agents = Array.isArray(result?.agents) ? result.agents : [];
      state.agentsLoaded = true;
      try {
        const registry = await invoke('cogseed.agent.list');
        if (Array.isArray(registry?.agents)) {
          state.agentRegistry = registry;
          state.agentRegistryError = '';
        }
      } catch (error) {
        state.agentRegistryError = error?.message || String(error);
      }
    } catch (error) {
      state.agentsLoaded = true;
      state.createAdvancedError = error?.message || String(error);
    }
    renderPreservingFocus(state.createMode ? '[data-run-center-create-task], [data-run-center-create-agent]' : '');
  }
  function focusCreateControl() {
    focusLater('[data-run-center-create-task], [data-run-center-create-agent]');
  }
  function createFailureMessage(error) {
    const message = error?.message || String(error);
    if (message.includes('CogSeed Agent is unavailable')) return text('run_center.selected_agent_unavailable');
    if (message.includes('CogSeed Agent runtime is not executable')) return text('run_center.selected_agent_runtime_unavailable');
    return message;
  }
  function clearCreateErrorAfterEdit(focusSelector) {
    if (!state.createError) return;
    state.createError = '';
    renderPreservingFocus(focusSelector);
  }
  function toggleCreateAdvanced() {
    if (state.createMode !== 'create' || state.createBusy) return;
    state.createAdvancedOpen = !state.createAdvancedOpen;
    state.createAdvancedError = '';
    renderPreservingFocus('[data-run-center-create-advanced]');
    if (state.createAdvancedOpen) {
      loadAgents();
      loadWorktrees('create');
    }
  }
  function openCreate(mode) {
    const suspendingDetail = mode === 'reassign' && state.detailOpen;
    state.restoreDetailAfterCreate = suspendingDetail;
    if (suspendingDetail) state.detailOpen = false;
    state.createMode = mode;
    const returnFocus = mode === 'reassign' ? '[data-run-center-reassign]' : '[data-run-center-create-open]';
    state.createReturnFocus = returnFocus;
    state.createTask = '';
    state.createAgentId = '';
    state.createWorktreeName = '';
    state.createError = '';
    state.createAdvancedError = '';
    state.createAdvancedOpen = mode === 'reassign';
    render();
    focusCreateControl();
    if (mode === 'reassign') loadAgents();
  }
  function closeCreate() {
    if (state.createBusy) return;
    const returnFocus = state.createReturnFocus;
    const restoreDetail = state.restoreDetailAfterCreate;
    invalidateWorktreesRequest('create');
    state.createMode = '';
    state.createError = '';
    state.createAdvancedError = '';
    state.createAdvancedOpen = false;
    state.createReturnFocus = '';
    state.restoreDetailAfterCreate = false;
    state.detailOpen = restoreDetail;
    render();
    focusLater(restoreDetail ? '[data-run-center-reassign]' : returnFocus);
  }
  function setSelectedTask(sessionId, taskId, options) {
    state.selectionRevision += 1;
    state.selectedSessionId = String(sessionId || '');
    state.selectedTaskId = String(taskId || '');
    const board = rootWindow.CogSeedRunCenterBoard;
    const run = options?.runKey && typeof board?.buildRunModels === 'function'
      ? board.buildRunModels(state.board).find((item) => item.key === options.runKey)
      : board?.runForTask?.(state.board, state.selectedTaskId);
    state.selectedRunKey = run?.key || '';
    state.selectedAttemptKey = String(options?.attemptKey || '');
    if (!state.selectedTaskId) state.attemptFocusKey = '';
    if (run?.key) state.boardFocusRunKey = run.key;
    return state.selectionRevision;
  }
  function selectionIsCurrent(revision, sessionId, taskId) {
    return revision === state.selectionRevision
      && state.selectedSessionId === sessionId
      && state.selectedTaskId === taskId;
  }
  async function submitCreate() {
    if (state.createBusy) return;
    const isReassign = state.createMode === 'reassign';
    const source = state.detail?.collaboration?.task || selectedTask();
    if (!isReassign && !state.createTask.trim()) { state.createError = text('run_center.create_task_required'); render(); focusCreateControl(); return; }
    if (isReassign && !state.createAgentId) { state.createError = text('run_center.choose_agent_required'); render(); focusCreateControl(); return; }
    if (state.createAgentId && !taskDispatchableAgentCandidates().some((agent) => agent.agentId === state.createAgentId)) {
      state.createError = text('run_center.selected_agent_unavailable');
      render();
      focusLater('[data-run-center-create-agent]');
      return;
    }
    if (isReassign && !source) return;
    state.createBusy = true;
    state.createError = '';
    render();
    try {
      const requestId = `req-run-center-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const created = await invoke(isReassign ? 'cogseed.task.reassign' : 'cogseed.task.start', isReassign
        ? { taskId: source.taskId, requestId, agentId: state.createAgentId }
        : { requestId, task: state.createTask.trim(), ...(state.createAgentId ? { agentId: state.createAgentId } : {}), ...(state.createWorktreeName ? { worktreeName: state.createWorktreeName } : {}) });
      state.createMode = '';
      state.restoreDetailAfterCreate = false;
      state.view = 'runs';
      state.runMode = 'queue';
      state.detailTab = 'summary';
      state.detailOpen = true;
      state.actionNotice = isReassign ? 'run_center.reassign_success' : 'run_center.create_success';
      state.actionError = '';
      state.createReturnFocus = '[data-run-center-detail-tab="summary"]';
      await refresh({ background: true });
      if (created?.sessionId && created?.taskId) await select(created.sessionId, created.taskId, { focusDetail: true });
    } catch (error) {
      state.createError = createFailureMessage(error);
    } finally {
      state.createBusy = false;
      render();
      if (!state.createMode) {
        focusLater(state.createReturnFocus);
        state.createReturnFocus = '';
      } else focusCreateControl();
    }
  }
  async function select(sessionId, taskId, options) {
    let nextSessionId = String(sessionId || '');
    let nextTaskId = String(taskId || '');
    const board = rootWindow.CogSeedRunCenterBoard;
    const run = options?.runKey && typeof board?.buildRunModels === 'function'
      ? board.buildRunModels(state.board).find((item) => item.key === options.runKey)
      : board?.runForTask?.(state.board, nextTaskId);
    const attemptSelection = reconcileAttemptSelection(
      run,
      options?.attemptKey || '',
      nextTaskId,
    );
    const attempt = attemptSelection.selected;
    if (attempt?.representative) {
      nextSessionId = String(attempt.representative.sessionId || '');
      nextTaskId = String(attempt.representative.taskId || '');
    }
    const revision = setSelectedTask(nextSessionId, nextTaskId, {
      runKey: run?.key || '', attemptKey: attempt?.key || '',
    });
    if (options?.focusAttempt && attempt?.key) state.attemptFocusKey = attempt.key;
    state.detail = null;
    state.error = '';
    render();
    if (options?.focusDetail) focusDetailDrawer();
    if (options?.focusAttempt) focusAttemptByKey(attempt?.key);
    if (options?.focusCollaborationRun) focusCollaborationRunByKey(run?.key);
    else if (options?.scrollCollaborationRun) scrollCollaborationRunByKey(run?.key);
    if (!nextSessionId) return;
    try {
      const detail = await invoke('cogseed.session.read', { sessionId: nextSessionId, taskId: nextTaskId || undefined });
      if (!selectionIsCurrent(revision, nextSessionId, nextTaskId)) return;
      state.detail = detail;
    } catch (error) {
      if (!selectionIsCurrent(revision, nextSessionId, nextTaskId)) return;
      state.error = error?.message || String(error);
    }
    if (revision !== state.selectionRevision) return;
    if (options?.focusDetail && !state.detailOpen) return;
    const focusSnapshot = options?.preserveFocus ? captureFocus() : null;
    render();
    if (focusSnapshot) restoreFocus(focusSnapshot);
    if (options?.focusDetail) focusDetailDrawer();
    if (options?.focusAttempt) focusAttemptByKey(attempt?.key);
    if (options?.focusCollaborationRun) focusCollaborationRunByKey(run?.key);
    else if (options?.scrollCollaborationRun) scrollCollaborationRunByKey(run?.key);
  }
  function collaborationRunSelector(runKey) {
    return runKey ? `[data-run-center-collaboration-run-key="${escapedAttributeValue(runKey)}"]` : '';
  }
  function revealCollaborationRunByKey(runKey, shouldFocus) {
    const selector = collaborationRunSelector(runKey);
    if (!selector) return;
    rootWindow.setTimeout(() => {
      const items = Array.from(panel()?.querySelectorAll?.('[data-run-center-collaboration-run-key]') || []);
      const target = panel()?.querySelector(selector);
      if (shouldFocus) {
        items.forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
        target?.focus?.();
      }
      target?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
        behavior: !shouldFocus || rootWindow.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth',
      });
    }, 0);
  }
  function focusCollaborationRunByKey(runKey) { revealCollaborationRunByKey(runKey, true); }
  function scrollCollaborationRunByKey(runKey) { revealCollaborationRunByKey(runKey, false); }
  function focusAttemptByKey(attemptKey) {
    if (!attemptKey) return;
    const attempts = buildAttemptModels(selectedRunModel());
    const index = attempts.findIndex((attempt) => attempt.key === attemptKey);
    if (index < 0) return;
    state.attemptFocusKey = attemptKey;
    rootWindow.setTimeout(() => {
      const items = Array.from(panel()?.querySelectorAll?.('[data-run-center-attempt-index]') || []);
      const target = panel()?.querySelector(`[data-run-center-attempt-index=\"${index}\"]`);
      items.forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
      target?.focus?.();
      target?.scrollIntoView?.({
        block: 'nearest',
        behavior: rootWindow.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth',
      });
    }, 0);
  }
  function selectAttemptAt(index, focusAttempt) {
    const run = selectedRunModel();
    const attempts = buildAttemptModels(run);
    const attempt = attempts[index];
    const task = attempt?.representative;
    if (!run || !attempt || !task) return;
    state.attemptFocusKey = attempt.key;
    select(task.sessionId, task.taskId, { runKey: run.key, attemptKey: attempt.key, focusAttempt });
  }
  function activateView(view, focusTab) {
    const nextView = normalizeView(view);
    if (!nextView) return false;
    const previousView = state.view;
    if (nextView === 'collaboration') {
      state.view = 'collaboration';
    } else {
      state.view = nextView;
    }
    state.detailOpen = false;
    state.restoreDetailAfterCreate = false;
    state.detailReturnFocus = '';
    if (nextView === 'runs' && previousView !== 'runs') {
      state.runMode = 'queue';
      state.detailTab = 'summary';
    }
    if (nextView === 'history' && previousView !== 'history') {
      state.runMode = 'queue';
      state.detailTab = 'history';
    }
    if (nextView === 'collaboration' && previousView !== 'collaboration') {
      state.runMode = 'queue';
      state.detailTab = 'collaboration';
    }
    render();
    if (focusTab) panel()?.querySelector(`[data-run-center-view="${nextView}"]`)?.focus();
    return true;
  }
  function openDetails(returnFocus) {
    state.detailOpen = true;
    state.detailReturnFocus = returnFocus || '';
    render();
    focusDetailDrawer();
  }
  function closeDetails() {
    const returnFocus = state.detailReturnFocus || (state.runMode === 'board'
      ? '.dashboard-board-card.is-selected' : '.run-center-queue-item.is-selected');
    state.detailOpen = false;
    state.detailReturnFocus = '';
    render();
    focusLater(returnFocus);
  }
  function renderAfterFilterChange(selectFirst) {
    const visibleRuns = visibleBoardRuns();
    if (visibleRuns.some((run) => run.key === state.selectedRunKey)) {
      if (!visibleRuns.some((run) => run.key === state.boardFocusRunKey)) state.boardFocusRunKey = state.selectedRunKey;
      render();
      return;
    }
    setSelectedTask('', '');
    state.detail = null;
    state.boardFocusRunKey = visibleRuns[0]?.key || '';
    const firstRun = selectFirst ? visibleRuns[0] : null;
    const first = firstRun?.aggregateTask || firstRun?.representative;
    if (first) select(first.sessionId, first.taskId);
    else render();
  }
  async function refresh(options) {
    const background = options?.background === true;
    if (state.refreshInFlight) {
      if (background) state.refreshQueued = true;
      return state.refreshInFlight;
    }
    state.refreshInFlight = (async () => {
      if (!background) {
        state.loading = true;
        state.error = '';
        render();
      }
      try {
        const [board, registryResult] = await Promise.all([
          invoke('cogseed.task.list'),
          invoke('cogseed.agent.list')
            .then((value) => ({ value }))
            .catch((error) => ({ error })),
        ]);
        state.board = board;
        state.error = '';
        if (registryResult.value) {
          state.agentRegistry = registryResult.value;
          state.agentRegistryError = '';
        } else if (registryResult.error) {
          state.agentRegistryError = registryResult.error?.message || String(registryResult.error);
        }
        const visibleRuns = visibleBoardRuns();
        const run = visibleRuns.find((item) => item.key === state.selectedRunKey)
          || visibleRuns.find((item) => item.members?.some((member) => member.taskId === state.selectedTaskId))
          || visibleRuns[0];
        const retainedSelection = run?.key === state.selectedRunKey
          || run?.members?.some((member) => member.taskId === state.selectedTaskId);
        const preferredTaskId = retainedSelection ? state.selectedTaskId : runTask(run)?.taskId;
        const attemptSelection = reconcileAttemptSelection(
          run,
          retainedSelection ? state.selectedAttemptKey : '',
          preferredTaskId,
        );
        const attempt = attemptSelection.selected;
        const task = attempt?.representative || run?.aggregateTask || run?.representative;
        if (!task) {
          setSelectedTask('', '');
          state.detail = null;
        } else if (run.key !== state.selectedRunKey
          || attempt?.key !== state.selectedAttemptKey
          || task.taskId !== state.selectedTaskId
          || task.sessionId !== state.selectedSessionId
          || !selectedTask()) {
          if (background) {
            const nextSessionId = String(task.sessionId || '');
            const nextTaskId = String(task.taskId || '');
            const revision = setSelectedTask(nextSessionId, nextTaskId, {
              runKey: run.key, attemptKey: attempt?.key || '',
            });
            try {
              const detail = nextSessionId
                ? await invoke('cogseed.session.read', { sessionId: nextSessionId, taskId: nextTaskId || undefined })
                : null;
              if (selectionIsCurrent(revision, nextSessionId, nextTaskId)) {
                state.detail = detail;
              }
            } catch (error) {
              if (selectionIsCurrent(revision, nextSessionId, nextTaskId)) throw error;
            }
          } else await select(task.sessionId, task.taskId, {
            runKey: run.key, attemptKey: attempt?.key || '',
          });
        } else if (background && state.selectedSessionId) {
          const revision = state.selectionRevision;
          const selectedSessionId = state.selectedSessionId;
          const selectedTaskId = state.selectedTaskId;
          try {
            const detail = await invoke('cogseed.session.read', {
              sessionId: selectedSessionId,
              taskId: selectedTaskId || undefined,
            });
            if (selectionIsCurrent(revision, selectedSessionId, selectedTaskId)) state.detail = detail;
          } catch (error) {
            if (selectionIsCurrent(revision, selectedSessionId, selectedTaskId)) throw error;
          }
        }
      } catch (error) {
        state.error = error?.message || String(error);
      } finally {
        if (!background) state.loading = false;
        const focusSnapshot = background ? captureFocus() : null;
        const scrollSnapshot = background ? captureScroll() : null;
        render();
        if (background) {
          restoreScroll(scrollSnapshot);
          const fallbackSelector = state.view === 'runs' && state.selectedRunKey
            ? state.runMode === 'board'
              ? `[data-dashboard-board-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
              : `[data-run-center-queue-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
            : '';
          restoreFocus(focusSnapshot, fallbackSelector);
        }
      }
    })();
    try { return await state.refreshInFlight; }
    finally {
      state.refreshInFlight = null;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        scheduleRefresh();
      }
    }
  }
  function scheduleRefresh() {
    if (state.refreshTimer) rootWindow.clearTimeout(state.refreshTimer);
    state.refreshTimer = rootWindow.setTimeout(() => {
      state.refreshTimer = null;
      refresh({ background: true });
    }, 150);
  }
  function stopWatch() {
    if (state.watch?.cancel) state.watch.cancel();
    state.watch = null;
    if (state.refreshTimer) rootWindow.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.refreshQueued = false;
  }
  function startWatch() {
    if (state.watch || !rootWindow.cogseed?.stream) return;
    const watch = rootWindow.cogseed.stream('cogseed.dashboard.watch', {}, (event) => {
      if (event?.type === 'change') scheduleRefresh();
    });
    state.watch = watch;
    watch.promise.catch((error) => {
      if (state.watch !== watch) return;
      state.watch = null;
      if (error?.name !== 'AbortError') state.error = error?.message || String(error);
      render();
    });
  }
  async function action(action) {
    const task = state.detail?.collaboration?.task || selectedTask();
    if (!task) return;
    if (action === 'abort' && !rootWindow.confirm(text('run_center.abort_confirm'))) return;
    if (action === 'archive' && !rootWindow.confirm(text('run_center.archive_confirm'))) return;
    const visibleBefore = action === 'archive' ? orderedVisibleRuns() : [];
    const archivedIndex = visibleBefore.findIndex((run) => run.members?.some((member) => member.taskId === task.taskId));
    const adjacentRunKey = archivedIndex >= 0
      ? visibleBefore[archivedIndex + 1]?.key || visibleBefore[archivedIndex - 1]?.key || ''
      : '';
    const archiveScrollSnapshot = action === 'archive' ? captureScroll() : null;
    const previousRunKeys = new Set(allRunModels().map((run) => run.key));
    const sourceConversationId = task.conversationId;
    const sourceSessionId = task.sessionId;
    state.busyAction = action;
    state.actionNotice = '';
    state.actionError = '';
    renderPreservingFocus();
    try {
      const payload = { taskId: task.taskId, action };
      if (action === 'retry' || action === 'resume') payload.requestId = `req-run-center-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await invoke('cogseed.task.action', payload);
      if (action === 'archive') {
        state.detailOpen = false;
        state.detailReturnFocus = '';
      }
      await refresh({ background: true });
      if (action === 'archive') {
        const visibleRuns = orderedVisibleRuns();
        const targetRun = visibleRuns.find((run) => run.key === adjacentRunKey) || visibleRuns[0] || null;
        const targetTask = runTask(targetRun);
        state.actionNotice = '';
        if (targetRun && targetTask) await select(targetTask.sessionId, targetTask.taskId, { runKey: targetRun.key });
        else {
          setSelectedTask('', '');
          state.detail = null;
        }
        if (typeof rootWindow.uiToast === 'function') {
          rootWindow.uiToast(text('run_center.action_success_archive'), { variant: 'success' });
        }
        return;
      }
      const candidates = allRunModels().filter((run) => !previousRunKeys.has(run.key)).filter((run) => {
        const candidate = runTask(run);
        return candidate?.sessionId === sourceSessionId
          || !!sourceConversationId && candidate?.conversationId === sourceConversationId;
      }).sort((left, right) => safeTime(runTask(right)?.updatedAt) - safeTime(runTask(left)?.updatedAt));
      const targetRun = candidates[0]
        || allRunModels().find((run) => run.members?.some((member) => member.taskId === task.taskId))
        || selectedRunModel();
      const targetTask = runTask(targetRun);
      state.detailTab = 'summary';
      state.actionNotice = `run_center.action_success_${String(action).replace(/-/g, '_')}`;
      if (targetRun && targetTask) await select(targetTask.sessionId, targetTask.taskId, {
        runKey: targetRun.key,
      });
    } catch (error) {
      state.actionError = error?.message || String(error);
    } finally {
      state.busyAction = '';
      const fallbackSelector = action === 'archive' && state.selectedRunKey
        ? state.runMode === 'board'
          ? `[data-dashboard-board-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
          : `[data-run-center-queue-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
        : '[data-run-center-detail-tab="summary"]';
      renderPreservingFocus(fallbackSelector);
      if (archiveScrollSnapshot) restoreScroll(archiveScrollSnapshot);
    }
  }
  async function toggleAgentGateway(cli, nextEnabled) {
    const safeCli = String(cli || '').trim();
    if (!safeCli || state.busyAgentGateway) return;
    const runtime = state.agentRegistry?.runtimes?.find((item) => item.sourceKind === 'local-cli'
      && item.runtimeKind === safeCli && item.gatewayControllable === true);
    const hasActiveTask = state.agentRegistry?.agents?.some((item) => {
      const runtimeCli = String(item.runtimeKind || '').match(/^(?:cli|p3394-gateway):([a-z0-9_-]+)$/i)?.[1];
      return runtimeCli === safeCli && Number(item.stats?.active || 0) > 0;
    });
    if (!runtime || hasActiveTask) return;
    const actionName = nextEnabled ? 'start' : 'stop';
    state.busyAgentGateway = `${safeCli}:${actionName}`;
    state.agentGatewayError = '';
    render();
    try {
      await invoke(nextEnabled ? 'p3394.external.start' : 'p3394.external.stop', { cli: safeCli });
      state.agentRegistry = await invoke('cogseed.agent.list');
      state.agentRegistryError = '';
    } catch {
      state.agentGatewayError = safeCli;
    } finally {
      state.busyAgentGateway = '';
      render();
    }
  }
  async function collaborationAction(actionName, targetId) {
    const task = state.detail?.collaboration?.task || selectedTask();
    if (!task || !targetId || state.busyCollaborationAction) return;
    if (['skip-step', 'reject-gate', 'dismiss-conflict'].includes(actionName)
      && !rootWindow.confirm(text(`run_center.${actionName.replace(/-/g, '_')}_confirm`))) return;
    state.busyCollaborationAction = `${actionName}:${targetId}`;
    const actionSelection = {
      revision: state.selectionRevision,
      runKey: state.selectedRunKey,
      attemptKey: state.selectedAttemptKey,
      sessionId: state.selectedSessionId,
      taskId: state.selectedTaskId,
    };
    render();
    try {
      await invoke('cogseed.collaboration.action', { taskId: task.taskId, action: actionName, targetId });
      await refresh({ background: true });
      if (selectionIsCurrent(actionSelection.revision, actionSelection.sessionId, actionSelection.taskId)
        && state.selectedRunKey === actionSelection.runKey) {
        await select(actionSelection.sessionId, actionSelection.taskId, {
          runKey: actionSelection.runKey, attemptKey: actionSelection.attemptKey,
        });
      }
    } catch (error) {
      state.error = error?.message || String(error);
    } finally {
      state.busyCollaborationAction = '';
      renderPreservingFocus();
    }
  }
  function focusToolsMenuItem(position) {
    const items = Array.from(panel()?.querySelectorAll?.('[data-run-center-tools-menu] [role="menuitem"]') || []);
    if (!items.length) return;
    const index = position === 'last' ? items.length - 1
      : position === 'first' ? 0
        : Math.max(0, Math.min(items.length - 1, Number(position) || 0));
    items.forEach((item, itemIndex) => { item.tabIndex = itemIndex === index ? 0 : -1; });
    items[index].focus();
  }
  function openToolsMenu(position = 'first') {
    state.toolsOpen = true;
    render();
    rootWindow.setTimeout(() => focusToolsMenuItem(position), 0);
  }
  function closeToolsMenu(returnFocus = true) {
    if (!state.toolsOpen) return;
    state.toolsOpen = false;
    render();
    if (returnFocus) focusLater('[data-run-center-tools-toggle]');
  }
  function handleToolsMenuKeydown(event) {
    const opener = event.target?.closest?.('[data-run-center-tools-toggle]');
    const menuItem = event.target?.closest?.('[data-run-center-tools-menu] [role="menuitem"]');
    if (opener && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      openToolsMenu(event.key === 'ArrowUp' ? 'last' : 'first');
      return true;
    }
    if (!menuItem) return false;
    const items = Array.from(panel()?.querySelectorAll?.('[data-run-center-tools-menu] [role="menuitem"]') || []);
    const current = Math.max(0, items.indexOf(menuItem));
    if (event.key === 'Tab') {
      state.toolsOpen = false;
      rootWindow.setTimeout(() => render(), 0);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeToolsMenu(true);
      return true;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
    event.preventDefault();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    focusToolsMenuItem(next);
    return true;
  }
  function focusBoardCard(event) {
    const card = event.target?.closest?.('[data-dashboard-board-run-key]');
    if (!card || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    const column = card.closest?.('[data-dashboard-board-column]');
    const board = column?.closest?.('.dashboard-board-columns');
    if (!column || !board) return false;
    const columns = Array.from(board.querySelectorAll('[data-dashboard-board-column]'));
    const columnIndex = columns.indexOf(column);
    const cards = Array.from(column.querySelectorAll('[data-dashboard-board-run-key]'));
    const rowIndex = Math.max(0, cards.indexOf(card));
    let next = card;
    if (event.key === 'Home') next = cards[0] || card;
    else if (event.key === 'End') next = cards.at(-1) || card;
    else if (event.key === 'ArrowUp') next = cards[Math.max(0, rowIndex - 1)] || card;
    else if (event.key === 'ArrowDown') next = cards[Math.min(cards.length - 1, rowIndex + 1)] || card;
    else {
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      for (let index = columnIndex + step; index >= 0 && index < columns.length; index += step) {
        const adjacent = Array.from(columns[index].querySelectorAll('[data-dashboard-board-run-key]'));
        if (adjacent.length) {
          next = adjacent[Math.min(rowIndex, adjacent.length - 1)];
          break;
        }
      }
    }
    event.preventDefault();
    const allCards = Array.from(board.querySelectorAll('[data-dashboard-board-run-key]'));
    allCards.forEach((item) => { item.tabIndex = item === next ? 0 : -1; });
    state.boardFocusRunKey = next.dataset.dashboardBoardRunKey || '';
    next.focus();
    return true;
  }
  function focusQueueItem(event) {
    const item = event.target?.closest?.('[data-run-center-queue-run-key]');
    if (!item || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return false;
    const items = Array.from(panel()?.querySelectorAll?.('[data-run-center-queue-run-key]') || []);
    if (!items.length) return false;
    const current = Math.max(0, items.indexOf(item));
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? Math.min(items.length - 1, current + 1)
          : Math.max(0, current - 1);
    const next = items[nextIndex] || item;
    event.preventDefault();
    items.forEach((control) => { control.tabIndex = control === next ? 0 : -1; });
    state.boardFocusRunKey = next.dataset.runCenterQueueRunKey || '';
    next.focus?.();
    next.scrollIntoView?.({ block: 'nearest' });
    return true;
  }
  function handleAttemptKeydown(event) {
    const control = event.target?.closest?.('[data-run-center-attempt-index]');
    if (!control || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    const attempts = buildAttemptModels(selectedRunModel());
    if (!attempts.length) return false;
    const current = Math.max(0, Math.min(attempts.length - 1, Number(control.dataset.runCenterAttemptIndex) || 0));
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? attempts.length - 1
        : ['ArrowDown', 'ArrowRight'].includes(event.key) ? Math.min(attempts.length - 1, current + 1)
          : Math.max(0, current - 1);
    event.preventDefault();
    selectAttemptAt(next, true);
    return true;
  }
  function handleCollaborationRunKeydown(event) {
    const control = event.target?.closest?.('[data-run-center-collaboration-run-key]');
    if (!control || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    const list = control.closest?.('.run-center-collaboration-run-list');
    const items = Array.from(list?.querySelectorAll?.('[data-run-center-collaboration-run-key]') || []);
    if (!items.length) return false;
    const current = Math.max(0, items.indexOf(control));
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : ['ArrowDown', 'ArrowRight'].includes(event.key) ? Math.min(items.length - 1, current + 1)
          : Math.max(0, current - 1);
    const next = items[nextIndex] || control;
    event.preventDefault();
    if (next === control) {
      next.focus?.();
      return true;
    }
    select(next.dataset.runCenterCollaborationSession, next.dataset.runCenterCollaborationTask, {
      runKey: next.dataset.runCenterCollaborationRunKey,
      focusCollaborationRun: true,
    });
    return true;
  }
  function bind() {
    const target = panel();
    if (!target || state.bound) return;
    state.bound = true;
    target.addEventListener('click', (event) => {
      const backdrop = event.target?.closest?.('[data-run-center-detail-backdrop]');
      if (backdrop && event.target === backdrop) { closeDetails(); return; }
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.runCenterToolsToggle !== undefined) {
        if (state.toolsOpen) closeToolsMenu(false);
        else openToolsMenu('first');
        return;
      }
      if (button.dataset.runCenterRefresh !== undefined) { refresh(); return; }
      if (button.dataset.runCenterCreateOpen !== undefined) { openCreate('create'); return; }
      if (button.dataset.runCenterConfigureModel !== undefined) {
        rootWindow.setView?.('settings');
        rootWindow.activateSettingsTab?.('credentials');
        return;
      }
      if (button.dataset.runCenterCreateAdvanced !== undefined) { toggleCreateAdvanced(); return; }
      if (button.dataset.runCenterReassign !== undefined) { openCreate('reassign'); return; }
      if (button.dataset.runCenterCreateClose !== undefined) { closeCreate(); return; }
      if (button.dataset.runCenterCreateSubmit !== undefined) { submitCreate(); return; }
      if (button.dataset.runCenterCreateWorktreesRetry !== undefined) { loadWorktrees('create'); return; }
      if (button.dataset.runCenterDiagnosticsOpen !== undefined) { openDiagnostics(); return; }
      if (button.dataset.runCenterDiagnosticsRetry !== undefined) { loadDiagnostics(); return; }
      if (button.dataset.runCenterDiagnosticsClose !== undefined) { closeDiagnostics(); return; }
      if (button.dataset.runCenterDiagnosticsExport !== undefined) { exportDiagnostics(); return; }
      if (button.dataset.runCenterWorktreesOpen !== undefined) { openWorktrees(); return; }
      if (button.dataset.runCenterWorktreesRetry !== undefined) { loadWorktrees('manager'); return; }
      if (button.dataset.runCenterWorktreesClose !== undefined) { closeWorktrees(); return; }
      if (button.dataset.runCenterWorktreeCreate !== undefined) { createWorktree(); return; }
      if (button.dataset.runCenterWorktreeRemove !== undefined) { removeWorktree(button.dataset.worktreePath, button.dataset.worktreeBranch); return; }
      if (button.dataset.runCenterQueryClear !== undefined) {
        state.search = '';
        renderAfterFilterChange(false);
        focusLater('[data-run-center-search]');
        return;
      }
      if (button.dataset.runCenterMode) {
        state.runMode = button.dataset.runCenterMode === 'board' ? 'board' : 'queue';
        state.detailOpen = false;
        renderPreservingFocus(`[data-run-center-mode="${state.runMode}"]`);
        return;
      }
      if (button.dataset.runCenterArchiveScope !== undefined) {
        state.showArchived = !state.showArchived;
        renderAfterFilterChange(true);
        return;
      }
      if (button.dataset.runCenterTimelineJump !== undefined) {
        const failure = panel()?.querySelector('[data-run-center-timeline-failure]');
        failure?.scrollIntoView?.({ block: 'center', behavior: rootWindow.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
        failure?.focus?.();
        return;
      }
      if (button.dataset.runCenterOverviewFilter) {
        const filter = button.dataset.runCenterOverviewFilter;
        state.search = '';
        state.sourceFilter = 'all';
        state.runAgentFilter = 'all';
        state.runTimeFilter = 'all';
        state.view = 'runs';
        state.runMode = 'queue';
        state.detailTab = 'summary';
        if (filter === 'archived') {
          state.filter = 'all';
          state.showArchived = true;
          render();
          focusLater('[data-run-center-archive-scope]');
        } else {
          state.filter = filter;
          state.showArchived = false;
          renderAfterFilterChange(true);
        }
        return;
      }
      if (button.dataset.runCenterOverviewSource) { state.search = ''; state.sourceFilter = button.dataset.runCenterOverviewSource; state.filter = 'all'; state.runAgentFilter = 'all'; state.runTimeFilter = 'all'; state.showArchived = false; state.view = 'runs'; state.runMode = 'queue'; state.detailTab = 'summary'; renderAfterFilterChange(true); return; }
      if (button.dataset.runCenterOverviewAgent) { state.search = ''; state.filter = 'all'; state.sourceFilter = 'all'; state.runAgentFilter = button.dataset.runCenterOverviewAgent; state.runTimeFilter = 'all'; state.showArchived = false; state.view = 'runs'; state.runMode = 'queue'; state.detailTab = 'summary'; renderAfterFilterChange(true); return; }
      if (button.dataset.runCenterOverviewTask) {
        state.search = '';
        state.filter = 'all';
        state.sourceFilter = 'all';
        state.showArchived = false;
        state.runAgentFilter = 'all';
        state.runTimeFilter = 'all';
        state.view = 'runs';
        state.runMode = 'queue';
        state.detailTab = 'summary';
        state.detailOpen = true;
        state.detailReturnFocus = '.dashboard-board-card.is-selected';
        select(button.dataset.runCenterOverviewSession, button.dataset.runCenterOverviewTask, { focusDetail: true });
        return;
      }
      if (button.dataset.runCenterAgentTask) {
        const task = (state.board?.tasks || []).find((item) => item.taskId === button.dataset.runCenterAgentTask);
        if (task) {
          state.search = '';
          state.filter = 'all';
          state.sourceFilter = 'all';
          state.runAgentFilter = 'all';
          state.runTimeFilter = 'all';
          state.view = 'runs';
          state.runMode = 'queue';
          state.detailTab = 'summary';
          state.detailOpen = true;
          state.detailReturnFocus = '.dashboard-board-card.is-selected';
          select(task.sessionId, task.taskId, { focusDetail: true });
        }
        return;
      }
      if (button.dataset.runCenterAgentConversation) { rootWindow.setView?.('conversation', button.dataset.runCenterAgentConversation); return; }
      if (button.dataset.runCenterView) { activateView(button.dataset.runCenterView, true); return; }
      if (button.dataset.runCenterDetailTab) {
        state.detailTab = button.dataset.runCenterDetailTab;
        state.actionNotice = '';
        state.actionError = '';
        renderPreservingFocus(`[data-run-center-detail-tab="${state.detailTab}"]`);
        return;
      }
      if (button.dataset.runCenterDetailBack !== undefined) { closeDetails(); return; }
      if (button.dataset.runCenterQueueRunKey !== undefined) {
        state.detailOpen = true;
        state.detailTab = 'summary';
        state.detailReturnFocus = `[data-run-center-queue-run-key="${escapedAttributeValue(button.dataset.runCenterQueueRunKey)}"]`;
        select(button.dataset.runCenterQueueSession, button.dataset.runCenterQueueTask, {
          runKey: button.dataset.runCenterQueueRunKey, focusDetail: true,
        });
        return;
      }
      if (button.dataset.runCenterCollaborationRunKey !== undefined) {
        select(button.dataset.runCenterCollaborationSession, button.dataset.runCenterCollaborationTask, {
          runKey: button.dataset.runCenterCollaborationRunKey,
          focusCollaborationRun: true,
        });
        return;
      }
      if (button.dataset.runCenterDetailOpen !== undefined) {
        state.detailTab = 'summary';
        openDetails('[data-run-center-detail-open]');
        return;
      }
      if (button.dataset.runCenterDetailClose !== undefined) { closeDetails(); return; }
      if (button.dataset.runCenterAttemptIndex !== undefined) {
        selectAttemptAt(Number(button.dataset.runCenterAttemptIndex), true);
        return;
      }
      if (button.dataset.runCenterAgentFilter) { state.agentFilter = button.dataset.runCenterAgentFilter; render(); return; }
      if (button.dataset.runCenterFilter) { state.filter = button.dataset.runCenterFilter; renderAfterFilterChange(true); return; }
      if (button.dataset.dashboardArchiveToggle !== undefined) { state.showArchived = !state.showArchived; render(); return; }
      const taskId = button.dataset.runCenterTask || button.dataset.dashboardBoardTaskId;
      const sessionId = button.dataset.runCenterSession || button.dataset.dashboardBoardSessionId;
      if (sessionId) {
        if (button.dataset.dashboardBoardSessionId) {
          const runKey = button.dataset.dashboardBoardRunKey || '';
          const selected = runKey
            ? runKey === state.selectedRunKey
            : taskId === state.selectedTaskId && sessionId === state.selectedSessionId;
          if (state.detailOpen && selected) {
            closeDetails();
            return;
          }
          state.detailOpen = true;
          state.detailTab = 'summary';
          state.detailReturnFocus = '.dashboard-board-card.is-selected';
          select(sessionId, taskId, {
            focusDetail: true,
            runKey,
          });
        } else select(sessionId, taskId);
        return;
      }
      if (button.dataset.runCenterAction) { action(button.dataset.runCenterAction); return; }
      if (button.dataset.runCenterCollaborationAction) { collaborationAction(button.dataset.runCenterCollaborationAction, button.dataset.runCenterCollaborationTarget); return; }
      if (button.dataset.runCenterOpen) { rootWindow.setView?.('conversation', button.dataset.runCenterOpen); }
    });
    target.addEventListener('input', (event) => {
      if (event.target.matches('[data-run-center-search]')) {
        state.search = event.target.value || '';
        if (event.isComposing) return;
        const selectionStart = event.target.selectionStart;
        renderAfterFilterChange(false);
        const nextSearch = target.querySelector('[data-run-center-search]');
        nextSearch?.focus();
        if (Number.isInteger(selectionStart)) nextSearch?.setSelectionRange(selectionStart, selectionStart);
      }
      if (event.target.matches('[data-run-center-agent-search]')) {
        state.agentSearch = event.target.value || '';
        if (event.isComposing) return;
        const selectionStart = event.target.selectionStart;
        render();
        const nextSearch = target.querySelector('[data-run-center-agent-search]');
        nextSearch?.focus();
        if (Number.isInteger(selectionStart)) nextSearch?.setSelectionRange(selectionStart, selectionStart);
      }
      if (event.target.matches('[data-run-center-create-task]')) {
        state.createTask = event.target.value || '';
        clearCreateErrorAfterEdit('[data-run-center-create-task]');
      }
      if (event.target.matches('[data-run-center-worktree-branch]')) state.worktreeBranch = event.target.value || '';
      if (event.target.matches('[data-run-center-worktree-base]')) state.worktreeBaseRef = event.target.value || '';
    });
    target.addEventListener('change', (event) => {
      if (event.target.matches('[data-run-center-agent-gateway]')) {
        toggleAgentGateway(event.target.dataset.runCenterAgentGateway, event.target.checked === true);
        return;
      }
      if (event.target.matches('[data-run-center-create-agent]')) {
        state.createAgentId = event.target.value || '';
        clearCreateErrorAfterEdit('[data-run-center-create-agent]');
      }
      if (event.target.matches('[data-run-center-create-worktree]')) {
        state.createWorktreeName = event.target.value || '';
        clearCreateErrorAfterEdit('[data-run-center-create-worktree]');
      }
      if (event.target.matches('[data-run-center-source-filter]')) { state.sourceFilter = event.target.value || 'all'; renderAfterFilterChange(true); }
      if (event.target.matches('[data-run-center-run-agent-filter]')) { state.runAgentFilter = event.target.value || 'all'; renderAfterFilterChange(true); }
      if (event.target.matches('[data-run-center-time-filter]')) { state.runTimeFilter = event.target.value || 'all'; renderAfterFilterChange(true); }
    });
    target.addEventListener('toggle', (event) => {
      const analysis = event.target?.closest?.('.run-center-overview-analysis');
      if (!analysis || event.target !== analysis) return;
      state.overviewAnalysisOpen = analysis.open === true;
      if (state.overviewAnalysisOpen) rootWindow.CogSeedRunCenterOverview?.mount?.(target);
      else rootWindow.CogSeedRunCenterOverview?.destroy?.();
    }, true);
    document.addEventListener('click', (event) => {
      const clickedToolsMenu = event.composedPath?.().some((item) => item.classList?.contains('run-center-more-menu'));
      if (!state.toolsOpen || clickedToolsMenu) return;
      state.toolsOpen = false;
      render();
    });
    document.addEventListener('keydown', (event) => {
      if (!panel()?.closest('.panel')?.classList.contains('active')) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (handleToolsMenuKeydown(event)) return;
      if (state.createMode && event.key === 'Tab') { trapFocus(event, '[data-run-center-create-dialog]'); return; }
      if (state.worktreesOpen && event.key === 'Tab') { trapFocus(event, '[data-run-center-worktrees-dialog]'); return; }
      if (state.diagnosticsOpen && event.key === 'Tab') { trapFocus(event, '[data-run-center-diagnostics-dialog]'); return; }
      if (handleCollaborationRunKeydown(event)) return;
      if (handleAttemptKeydown(event)) return;
      if (focusQueueItem(event)) return;
      if (focusBoardCard(event)) return;
      const tab = event.target?.closest?.('[data-run-center-view]');
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const views = VIEW_DEFINITIONS.map(([view]) => view);
        const current = Math.max(0, views.indexOf(normalizeView(tab.dataset.runCenterView)));
        const nextIndex = event.key === 'Home' ? 0
          : event.key === 'End' ? views.length - 1
            : event.key === 'ArrowRight' ? (current + 1) % views.length
              : (current - 1 + views.length) % views.length;
        activateView(views[nextIndex], true);
        return;
      }
      if (event.key === 'Escape' && state.createMode) closeCreate();
      else if (event.key === 'Escape' && state.worktreesOpen) closeWorktrees();
      else if (event.key === 'Escape' && state.diagnosticsOpen) closeDiagnostics();
      else if (event.key === 'Escape' && state.toolsOpen) closeToolsMenu(true);
      else if (event.key === 'Escape' && state.detailOpen) closeDetails();
    });
    rootWindow.addEventListener('i18n-change', () => render());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopWatch();
      else if (panel()?.closest('.panel')?.classList.contains('active')) { startWatch(); scheduleRefresh(); }
    });
  }
  rootWindow.CogSeedRunCenterAttempts = Object.freeze({
    buildAttemptModels,
    reconcileAttemptSelection,
    failureCategory,
  });
  function applyRequestedView(view) {
    const nextView = normalizeView(view);
    if (!nextView) return false;
    state.view = nextView;
    state.detailOpen = false;
    state.detailReturnFocus = '';
    state.restoreDetailAfterCreate = false;
    if (nextView === 'runs') {
      state.runMode = String(view || '').trim() === 'board' ? 'board' : 'queue';
      state.detailTab = 'summary';
    } else if (nextView === 'history') {
      state.runMode = 'queue';
      state.detailTab = 'history';
    } else if (nextView === 'collaboration') {
      state.runMode = 'queue';
      state.detailTab = 'collaboration';
    }
    return true;
  }
  rootWindow.openRunCenterView = function openRunCenterView(view) {
    if (!applyRequestedView(view)) return;
    render();
  };
  rootWindow.renderRunCenter = function renderRunCenter(initialView) {
    bind();
    if (initialView) applyRequestedView(initialView);
    startWatch();
    refresh();
  };
  rootWindow.stopRunCenterWatch = stopWatch;
})(window);
