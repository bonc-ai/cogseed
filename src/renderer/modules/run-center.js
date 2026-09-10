// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Task and event surfaces render only privacy-filtered CogSeed projections.
// Managed Worktree paths are never rendered here; administration lives in Settings.
(function initCogSeedRunCenter(rootWindow) {
  'use strict';

  const board = rootWindow.CogSeedRunCenterBoard;
  const { buildAttemptModels, reconcileAttemptSelection } = board;

  const VIEW_DEFINITIONS = Object.freeze([
    ['tasks', 'run_center.view_tasks'],
    ['agents', 'run_center.view_agents'],
    ['collaboration', 'run_center.view_collaboration'],
  ]);

  // Keep deep links and callers from the pre-unification Run Center stable.
  // The visible tabs retain the legacy DOM identifiers used by existing deep
  // links and styles. The task/session vocabulary is accepted as a boundary
  // alias and never becomes renderer state.
  const VIEW_ALIASES = Object.freeze({
    overview: 'runs',
    runs: 'runs',
    history: 'history',
    agents: 'agents',
    collaboration: 'collaboration',
    tasks: 'runs',
    sessions: 'history',
    board: 'runs',
    execution: 'history',
  });

  const DEFAULT_RUN_QUERY = Object.freeze({
    search: '',
    filter: 'all',
    sourceFilter: 'all',
    runAgentFilter: 'all',
    runTimeFilter: 'all',
    showArchived: false,
    conversationId: '',
  });
  const RUN_MODE_STORAGE_KEY = 'cogseed.run-center.run-mode.v1';

  function readPreferredRunMode() {
    try { return rootWindow.localStorage?.getItem(RUN_MODE_STORAGE_KEY) === 'queue' ? 'queue' : 'board'; }
    catch { return 'board'; }
  }
  function writePreferredRunMode(mode) {
    try { rootWindow.localStorage?.setItem(RUN_MODE_STORAGE_KEY, mode); }
    catch { /* A blocked machine-local preference must not break Run Center. */ }
  }
  let preferredRunMode = readPreferredRunMode();

  function normalizeView(view) {
    return VIEW_ALIASES[String(view || '').trim()] || '';
  }

  const state = {
    view: 'runs',
    runMode: preferredRunMode,
    detailTab: 'summary',
    filter: 'all',
    sourceFilter: 'all',
    runAgentFilter: 'all',
    runTimeFilter: 'all',
    search: '',
    showArchived: false,
    conversationIdFilter: '',
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
    refreshing: false,
    stale: false,
    staleError: '',
    dataState: 'idle',
    error: '',
    detailError: '',
    busyAction: '',
    busyTaskId: '',
    bound: false,
    watch: null,
    refreshTimer: null,
    refreshInFlight: null,
    refreshQueued: false,
    agentRegistry: null,
    agentRegistryError: '',
    agentRegistryRequestRevision: 0,
    agentSearch: '',
    agentFilter: 'all',
    agents: [],
    agentsLoaded: false,
    agentsLoading: false,
    spaces: [],
    spacesLoading: false,
    spacesError: '',
    spacesNotice: '',
    spacesRequestRevision: 0,
    createMode: '',
    createTask: '',
    createSpaceId: '',
    createAgentId: '',
    createWorktreeName: '',
    createBusy: false,
    createBusyMode: '',
    createError: '',
    createAdvancedError: '',
    createReturnFocus: '',
    toolsOpen: false,
    busyCollaborationAction: '',
    worktrees: null,
    worktreesLoading: false,
    worktreesError: '',
    worktreesRequestRevision: 0,
    worktreesRequestOwner: '',
    detailReturnFocus: '',
    actionNotice: '',
    actionError: '',
    selectionRevision: 0,
    pendingRestoreContext: null,
  };
  let derivedProjection = null;
  let derivedRuns = [];
  let derivedSequence = new Map();
  let renderTransaction = 0;
  let filteredRunTransaction = -1;
  let filteredRunProjection = null;
  let filteredRunSignature = '';
  let filteredRunAgentRegistry = null;
  let filteredRunAgents = null;
  let filteredActiveRuns = [];
  let filteredArchivedRuns = [];
  let filteredVisibleRuns = [];

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
  function captureReturnContext() {
    return {
      sourceView: state.view === 'agents' ? 'agents' : state.view === 'collaboration' ? 'collaboration' : 'tasks',
      taskScope: state.view === 'history' ? 'history' : 'current',
      runMode: state.runMode,
      filters: {
        search: state.search,
        filter: state.filter,
        sourceFilter: state.sourceFilter,
        runAgentFilter: state.runAgentFilter,
        runTimeFilter: state.runTimeFilter,
        showArchived: state.showArchived,
      },
      selectedRunKey: state.selectedRunKey,
      selectedAttemptKey: state.selectedAttemptKey,
      selectedTaskId: state.selectedTaskId,
      selectedSessionId: state.selectedSessionId,
      conversationIdFilter: state.conversationIdFilter,
      scrollPositions: captureScroll(),
      focusTarget: captureFocus(),
    };
  }
  function openConversationFromRunCenter(conversationId) {
    const cid = String(conversationId || '').trim();
    if (!cid) {
      if (typeof rootWindow.uiToast === 'function') rootWindow.uiToast(text('run_center.task_unavailable'), { variant: 'warning' });
      return false;
    }
    rootWindow.setView?.('conversation', cid, {
      entryPoint: 'run-center',
      openRunContext: 'proof',
      runCenterReturn: captureReturnContext(),
    });
    return true;
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
  const RUN_SELECTION_DETAIL_SCROLL_KEYS = Object.freeze(['detail', 'collaboration-detail']);
  function scrollContainers() {
    const target = panel();
    return target?.querySelectorAll
      ? Array.from(target.querySelectorAll('[data-run-center-scroll-key]')) : [];
  }
  function captureScroll(excludedKeys = []) {
    const excluded = new Set(excludedKeys);
    return scrollContainers().map((element) => ({
      key: String(element.dataset?.runCenterScrollKey || ''),
      top: Number(element.scrollTop || 0),
      left: Number(element.scrollLeft || 0),
    })).filter((item) => item.key && !excluded.has(item.key));
  }
  function restoreScroll(snapshot) {
    const elements = new Map(scrollContainers().map((element) => [
      String(element.dataset?.runCenterScrollKey || ''), element,
    ]));
    for (const item of snapshot || []) {
      const element = elements.get(item.key);
      if (!element) continue;
      element.scrollTop = item.top;
      element.scrollLeft = item.left;
    }
  }
  function renderPreservingFocus(fallbackSelector = '') {
    const focusSnapshot = captureFocus();
    render();
    if (focusSnapshot) restoreFocus(focusSnapshot, fallbackSelector);
    else focusLater(fallbackSelector);
  }
  function renderForRunSelection() {
    render({ excludeScrollKeys: RUN_SELECTION_DETAIL_SCROLL_KEYS });
  }
  function showRenderedDialog(target) {
    const dialog = target.querySelector?.('[data-run-center-create-dialog]');
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
  }
  function text(key, vars) { return typeof t === 'function' ? t(key, vars) : key; }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sharedButton(options) {
    return typeof rootWindow.uiButton === 'function' ? rootWindow.uiButton(options) : '';
  }
  function sharedEmptyState(options) {
    return typeof rootWindow.uiEmptyState === 'function' ? rootWindow.uiEmptyState(options) : '';
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
    if (!run) return null;
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
    const content = sharedEmptyState({
      kind: detail ? 'explained' : 'quiet',
      title: text(key),
      hint: detail || '',
      icon: detail ? 'warning' : '',
    });
    return content
      ? `<div class="run-center-empty"${detail ? ' role="alert"' : ' role="status"'}>${content}</div>`
      : `<div class="run-center-empty"${detail ? ' role="alert"' : ' role="status"'}>${esc(text(key))}${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
  }
  function selectedTask() {
    return (state.board?.tasks || []).find((task) => task.taskId === state.selectedTaskId) || null;
  }
  function derivedRunData() {
    if (derivedProjection !== state.board) {
      derivedProjection = state.board;
      derivedRuns = state.board ? board.buildRunModels(state.board) : [];
      derivedSequence = board.buildRunSequence(derivedRuns);
    }
    return { runs: derivedRuns, sequence: derivedSequence };
  }
  function runForSelection(runKey, taskId) {
    const runs = allRunModels();
    const run = runKey ? runs.find((item) => item.key === runKey) : null;
    return run || runs.find((item) => item.members.some((task) => task.taskId === taskId)) || null;
  }
  function selectedRunModel() {
    if (!state.board) return null;
    return runForSelection(state.selectedRunKey, state.selectedTaskId);
  }
  function safeTime(value) {
    const time = new Date(String(value || '')).getTime();
    return Number.isFinite(time) ? time : 0;
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
    const signature = JSON.stringify([
      state.search, state.filter, state.showArchived, state.sourceFilter,
      state.runAgentFilter, state.runTimeFilter, state.conversationIdFilter,
    ]);
    if (filteredRunTransaction === renderTransaction
      && filteredRunProjection === state.board
      && filteredRunSignature === signature
      && filteredRunAgentRegistry === state.agentRegistry
      && filteredRunAgents === state.agents) return filteredVisibleRuns;
    if (!state.board) {
      filteredRunTransaction = renderTransaction;
      filteredRunProjection = state.board;
      filteredRunSignature = signature;
      filteredRunAgentRegistry = state.agentRegistry;
      filteredRunAgents = state.agents;
      filteredActiveRuns = [];
      filteredArchivedRuns = [];
      filteredVisibleRuns = [];
      return filteredVisibleRuns;
    }
    const filterOptions = {
      search: state.search,
      filter: state.filter,
      sourceFilter: state.sourceFilter,
      agentFilter: state.runAgentFilter,
      timeFilter: state.runTimeFilter,
      agentName: agentDisplayName,
    };
    const conversationId = String(state.conversationIdFilter || '').trim();
    const matchesConversation = (run) => !conversationId
      || run.members?.some((task) => String(task.conversationId || '') === conversationId);
    // Evaluate text/time/source filters once, then partition without changing
    // archived-run semantics or the ordering used by board and queue.
    const matchingRuns = board.filterRuns(allRunModels(), { ...filterOptions, includeArchived: true })
      .filter(matchesConversation);
    filteredActiveRuns = matchingRuns.filter((run) => run.aggregateTask?.column !== 'archived');
    filteredArchivedRuns = matchingRuns.filter((run) => run.aggregateTask?.column === 'archived');
    filteredVisibleRuns = [...filteredActiveRuns, ...(state.showArchived ? filteredArchivedRuns : [])];
    filteredRunTransaction = renderTransaction;
    filteredRunProjection = state.board;
    filteredRunSignature = signature;
    filteredRunAgentRegistry = state.agentRegistry;
    filteredRunAgents = state.agents;
    return filteredVisibleRuns;
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
    return derivedRunData().sequence;
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
    const derived = derivedRunData();
    visibleBoardRuns();
    return board.render(state.board, {
      text, esc, icon, statusKey, statusClass: (value) => statusClass(value), formatDate, stateView,
      loading: state.loading, error: state.error, search: state.search, filter: state.filter,
      sourceFilter: state.sourceFilter, agentFilter: state.runAgentFilter,
      timeFilter: state.runTimeFilter, agentName: agentDisplayName,
      conversationTitle: conversationCacheTitle,
      conversationId: state.conversationIdFilter,
      selectedTaskId: state.selectedTaskId, selectedRunKey: state.selectedRunKey,
      focusedRunKey: state.boardFocusRunKey, showArchived: state.showArchived,
      busyAction: state.busyAction, busyTaskId: state.busyTaskId,
      runModels: derived.runs, sequenceByKey: derived.sequence,
      filteredRuns: filteredActiveRuns, archivedRuns: filteredArchivedRuns,
    });
  }
  function allRunModels() {
    return derivedRunData().runs;
  }
  function queueHtml() {
    const runs = orderedVisibleRuns();
    const filtered = state.search.trim() || state.sourceFilter !== 'all' || state.filter !== 'all'
      || state.runAgentFilter !== 'all' || state.runTimeFilter !== 'all' || state.showArchived;
    return board.renderQueue(runs, {
      text, esc, icon, formatDate, stateView,
      loading: state.loading, error: state.error, filtered,
      allRuns: allRunModels(), selectedRunKey: state.selectedRunKey,
      sequenceByKey: runSequenceByKey(),
      focusedRunKey: state.boardFocusRunKey,
      agentName: agentDisplayName, conversationTitle: conversationCacheTitle,
      busyAction: state.busyAction, busyTaskId: state.busyTaskId,
    });
  }
  function agentsHtml() {
    return rootWindow.CogSeedRunCenterAgents.render(state.agentRegistry, {
      text, esc, icon, formatDate, stateView, dynamicLabel,
      loading: state.loading, error: state.agentRegistryError,
      search: state.agentSearch, filter: state.agentFilter,
    });
  }
  const detailView = rootWindow.CogSeedRunCenterDetail.createRenderer({
    state, board, text, esc, icon, formatDate, statusKey, statusClass,
    localizedTitle, dynamicLabel, stateView, selectedTask, selectedRunModel,
    agentDisplayName, conversationTitle: conversationCacheTitle, displayRunTitle, runSequenceByKey,
  });
  function createSpaceDisplayName(space) {
    if (typeof localizedSpaceName === 'function') return localizedSpaceName(space, text);
    return String(space?.name || space?.space_id || '');
  }
  function sortedCreateSpaces() {
    const locale = typeof getLang === 'function' && getLang() === 'en' ? 'en' : 'zh';
    return [...(Array.isArray(state.spaces) ? state.spaces : [])]
      .filter((space) => space && typeof space.space_id === 'string' && space.space_id)
      .sort((left, right) => String(right.last_conversation_at || right.updated_at || '')
        .localeCompare(String(left.last_conversation_at || left.updated_at || ''))
        || createSpaceDisplayName(left).localeCompare(createSpaceDisplayName(right), locale)
        || left.space_id.localeCompare(right.space_id));
  }
  function createModalHtml(advancedOpen) {
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
    const spaceOptions = sortedCreateSpaces().map((space) => `<option value="${esc(space.space_id)}"${space.space_id === state.createSpaceId ? ' selected' : ''}>${esc(createSpaceDisplayName(space))}</option>`).join('');
    const customSpaceSelected = !!state.createSpaceId;
    return `<dialog class="run-center-create-dialog" aria-labelledby="run-center-create-title" data-run-center-create-dialog data-run-center-scroll-key="create-dialog">
        <header><div><h2 id="run-center-create-title">${esc(text(isReassign ? 'run_center.reassign_title' : 'run_center.create_title'))}</h2><p>${esc(text(isReassign ? 'run_center.reassign_subtitle' : 'run_center.create_subtitle'))}</p></div><button type="button" class="run-center-icon-btn" data-run-center-create-close aria-label="${esc(text('common.close'))}">${icon('x')}</button></header>
        <div class="run-center-create-body">
          ${isReassign ? `<div class="run-center-create-private">${icon('shield')}<span>${esc(text('run_center.reassign_private'))}</span></div>` : `<label><span>${esc(text('run_center.create_task_label'))}</span><textarea data-run-center-create-task rows="6" maxlength="64000" placeholder="${esc(text('run_center.create_task_placeholder'))}">${esc(state.createTask)}</textarea></label>`}
          ${isReassign ? `<label><span>${esc(text('run_center.create_agent_label'))}</span><select data-run-center-create-agent ${state.createBusy || !agentDataReady ? 'disabled' : ''}><option value="">${esc(text('run_center.choose_agent'))}</option>${options}</select></label>
            ${!agentDataReady ? `<small class="run-center-create-note">${esc(text('run_center.loading_agents'))}</small>` : ''}
            ${selected?.worktreeName ? `<div class="run-center-create-private">${icon('git-branch')}<span>${esc(text('run_center.reassign_worktree_inherited', { name: selected.worktreeName }))}</span></div>` : ''}` : `<label><span>${esc(text('run_center.create_space_label'))}</span><select data-run-center-create-space ${state.createBusy || state.spacesLoading || !!state.spacesError ? 'disabled' : ''}><option value="">${esc(text('workspace.default_space'))}</option>${spaceOptions}</select></label>
            ${state.spacesLoading ? `<small class="run-center-create-note" role="status">${esc(text('run_center.create_space_loading'))}</small>` : state.spacesError ? `<div class="run-center-create-space-status"><small class="run-center-create-note is-error" role="status">${esc(state.spacesError)}</small><button type="button" class="btn btn-sm" data-run-center-create-spaces-retry>${icon('refresh')}<span>${esc(text('run_center.retry_load'))}</span></button></div>` : state.spacesNotice ? `<small class="run-center-create-note" role="status">${esc(state.spacesNotice)}</small>` : `<small class="run-center-create-note">${esc(text('run_center.create_space_note'))}</small>`}
            <details class="run-center-create-advanced" data-run-center-create-advanced${advancedOpen ? ' open' : ''}><summary class="run-center-create-advanced-toggle" data-run-center-create-advanced-summary><span>${icon('settings')}<span><strong>${esc(text('run_center.advanced_options'))}</strong><small>${esc(text('run_center.advanced_defaults'))}</small></span></span>${icon('chevron-down', 'run-center-create-advanced-chevron')}</summary><div class="run-center-create-advanced-panel">
              <label><span>${esc(text('run_center.create_agent_label'))}</span><select data-run-center-create-agent ${state.createBusy || !agentDataReady ? 'disabled' : ''}><option value="">${esc(text('run_center.default_agent'))}</option>${options}</select></label>
              ${!agentDataReady ? `<small class="run-center-create-note">${esc(text('run_center.create_agent_unavailable'))}</small>` : ''}
              <label><span>${esc(text('run_center.create_isolation_label'))}</span><select data-run-center-create-worktree ${state.createBusy || state.worktreesLoading || customSpaceSelected ? 'disabled' : ''}><option value="">${esc(text('run_center.current_workspace'))}</option>${customSpaceSelected ? '' : worktreeOptions}</select></label>
              ${customSpaceSelected ? `<small class="run-center-create-note">${esc(text('run_center.create_space_isolation_unavailable'))}</small>` : state.worktreesLoading ? `<small class="run-center-create-note" role="status">${esc(text('run_center.worktrees_loading'))}</small>` : state.worktreesError ? `<div class="run-center-create-worktree-retry"><small class="run-center-create-note">${esc(text('run_center.create_worktree_unavailable'))}</small><button type="button" class="btn btn-sm" data-run-center-create-worktrees-retry>${icon('refresh')}<span>${esc(text('run_center.retry_load'))}</span></button></div>` : !managedWorktrees.length ? `<small class="run-center-create-note">${esc(text('run_center.create_worktree_empty'))}</small>` : `<small class="run-center-create-note">${esc(text('run_center.create_worktree_note'))}</small>`}
              ${state.createAdvancedError ? `<div class="run-center-create-worktree-retry"><small class="run-center-create-note is-error" role="status">${esc(state.createAdvancedError)}</small><button type="button" class="btn btn-sm" data-run-center-create-agents-retry>${icon('refresh')}<span>${esc(text('run_center.retry_load'))}</span></button></div>` : ''}
            </div></details>`}
          ${state.createError ? `<div class="run-center-create-error" role="alert">${esc(state.createError)}</div>` : ''}
        </div>
        <footer class="run-center-create-footer"><button type="button" class="btn btn-sm" data-run-center-create-close ${state.createBusy ? 'disabled' : ''}>${esc(text('common.cancel'))}</button>${isReassign ? '' : `<button type="button" class="btn btn-sm" data-run-center-create-save ${state.createBusy ? 'disabled' : ''}>${state.createBusyMode === 'save' ? icon('loader', 'ui-icon is-spinning') : icon('archive')}<span>${esc(text(state.createBusyMode === 'save' ? 'run_center.saving_planned' : 'run_center.save_planned'))}</span></button>`}<button type="button" class="btn btn-sm btn-primary" data-run-center-create-submit ${state.createBusy ? 'disabled' : ''}>${state.createBusyMode === 'start' || isReassign && state.createBusy ? icon('loader', 'ui-icon is-spinning') : icon('play-triangle')}<span>${esc(text(state.createBusyMode === 'start' || isReassign && state.createBusy ? 'run_center.creating' : isReassign ? 'run_center.reassign_submit' : 'run_center.create_submit'))}</span></button></footer>
      </dialog>`;
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
      <div class="run-center-collaboration-selected-actions"><button type="button" class="btn btn-sm btn-primary" data-run-center-open="${esc(task.conversationId || '')}">${icon('message-square')}<span>${esc(text('run_center.open_task'))}</span></button><button type="button" class="btn btn-sm" data-run-center-detail-open>${icon('panel-right')}<span>${esc(text('run_center.details'))}</span></button></div></header>
      <dl><div><dt>${esc(executorLabel)}</dt><dd>${esc(executor)}</dd></div><div><dt>${esc(text('run_center.label_updated'))}</dt><dd>${esc(formatDate(task.updatedAt))}</dd></div><div><dt>${esc(text('run_center.label_delivery'))}</dt><dd>${esc(delivery)}</dd></div></dl>
    </section>`;
  }
  function runHasCollaborationSignal(run) {
    const task = runTask(run);
    return !!(task && (Number(task.participantCount || 0) >= 2
      || task.executionKind === 'group-chat'
      || task.conversationMode === 'group'));
  }
  function collaborationWorkspaceHtml() {
    const runs = orderedVisibleRuns().filter(runHasCollaborationSignal);
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
      : stateView(state.loading ? 'run_center.loading' : filtered ? 'run_center.no_matches' : 'run_center.collaboration_empty');
    const listContent = runButtons || `<div class="run-center-collaboration-run-list-empty" role="status">${emptyMessage}</div>`;
    const detailBusy = state.loading || (!!selectedRun && !state.detail && !state.detailError);
    const detailContent = selectedRun
      ? `${collaborationSelectedHtml(selectedRun, sequences.get(selectedRun.key))}${detailView.renderCollaboration()}`
      : emptyMessage;
    return `<aside class="run-center-collaboration-runs" aria-labelledby="run-center-collaboration-runs-title"><header><h2 id="run-center-collaboration-runs-title">${esc(text('run_center.collaboration_runs'))}</h2><span>${esc(text('run_center.query_result_count', { count: runs.length }))}</span></header><div class="run-center-collaboration-run-list" role="tablist" aria-labelledby="run-center-collaboration-runs-title" data-run-center-scroll-key="collaboration-runs">${listContent}</div></aside>
      <main class="run-center-main${selectedRun ? '' : ' is-empty'}" id="run-center-collaboration-detail" role="tabpanel"${selectedTabId ? ` aria-labelledby="${selectedTabId}"` : ''} aria-live="polite" aria-busy="${String(detailBusy)}" data-run-center-scroll-key="collaboration-detail"><div class="run-center-collaboration-detail">${detailContent}</div></main>`;
  }
  function navigationHtml() {
    const activeView = state.view === 'runs' || state.view === 'history' ? 'tasks' : state.view;
    return `<div class="run-center-view-tabs" role="tablist" aria-orientation="horizontal" aria-label="${esc(text('run_center.title'))}" data-run-center-scroll-key="view-tabs">${VIEW_DEFINITIONS.map(([view, label]) => `<button type="button" id="run-center-tab-${view}" role="tab" aria-controls="run-center-panel-${view}" aria-selected="${String(activeView === view)}" tabindex="${activeView === view ? '0' : '-1'}" class="run-center-tab${activeView === view ? ' is-active' : ''}" data-run-center-view="${view}">${esc(text(label))}</button>`).join('')}</div>`;
  }
  function taskScopeHtml() {
    if (state.view !== 'runs' && state.view !== 'history') return '';
    const scope = state.view === 'history' ? 'history' : 'current';
    return `<div class="run-center-task-scopes" role="tablist" aria-orientation="horizontal" aria-label="${esc(text('run_center.task_scope'))}">${[['current', 'run_center.scope_current'], ['history', 'run_center.scope_history']].map(([value, key]) => `<button type="button" id="run-center-task-scope-${value}" role="tab" class="${scope === value ? 'is-active' : ''}" data-run-center-task-scope="${value}" aria-controls="run-center-panel-tasks" aria-selected="${String(scope === value)}" tabindex="${scope === value ? '0' : '-1'}">${esc(text(key))}</button>`).join('')}</div>`;
  }
  function taskSummaryHtml() {
    if (state.view !== 'runs' || !state.board) return '';
    const runs = allRunModels();
    const count = (column) => runs.filter((run) => board.displayColumnForTask(run.aggregateTask) === column).length;
    return `<div class="run-center-task-summary" aria-label="${esc(text('run_center.current_summary'))}">${[['attention', 'run_center.global_attention'], ['running', 'run_center.global_running'], ['completed', 'run_center.global_recent_completed']].map(([filter, key]) => `<button type="button" class="is-${filter}" data-run-center-summary-filter="${filter}"><span>${esc(text(key))}</span><strong>${esc(count(filter))}</strong></button>`).join('')}</div>`;
  }
  function queryBarHtml(options = {}) {
    const includeModeSwitch = options.modeSwitch !== false;
    const count = visibleBoardRuns().length;
    const filtersActive = !!(state.search.trim() || state.filter !== 'all' || state.sourceFilter !== 'all'
      || state.runAgentFilter !== 'all' || state.runTimeFilter !== 'all' || state.showArchived
      || state.conversationIdFilter);
    const tasks = (state.board?.tasks || []);
    const archivedCount = Math.max(0, Number(state.board?.counts?.archived)
      || tasks.filter((task) => task.column === 'archived').length);
    const purgeBusy = state.busyAction === 'purge-archived';
    const agentIds = Array.from(new Set(tasks.map((task) => String(task.agentId || 'commander')))).sort((left, right) =>
      agentDisplayName(left).localeCompare(agentDisplayName(right)));
    const statusFilters = ['all', 'pending', 'running', 'attention', 'completed'];
    return `<div class="run-center-query-bar">
      <label class="run-center-query-search">${icon('search')}<input type="search" value="${esc(state.search)}" data-run-center-search placeholder="${esc(text('run_center.search_placeholder'))}" aria-label="${esc(text('run_center.search_placeholder'))}"></label>
      <select class="run-center-source-filter" data-run-center-source-filter aria-label="${esc(text('run_center.source_filter'))}">${['all', 'cogseed', 'agent', 'local-cli', 'p3394-gateway', 'agent-conversation', 'group-chat'].map((source) => `<option value="${source}"${state.sourceFilter === source ? ' selected' : ''}>${esc(source === 'all' ? text('run_center.source_all') : text(`run_center.source_${source}`))}</option>`).join('')}</select>
      <select class="run-center-agent-filter" data-run-center-run-agent-filter aria-label="${esc(text('run_center.run_agent_filter'))}"><option value="all">${esc(text('run_center.run_agent_all'))}</option>${agentIds.map((agentId) => `<option value="${esc(agentId)}"${state.runAgentFilter === agentId ? ' selected' : ''}>${esc(agentId === 'commander' ? text('run_center.commander') : agentDisplayName(agentId))}</option>`).join('')}</select>
      <select class="run-center-time-filter" data-run-center-time-filter aria-label="${esc(text('run_center.time_filter'))}">${['all', 'today', '7d', '30d'].map((value) => `<option value="${value}"${state.runTimeFilter === value ? ' selected' : ''}>${esc(text(`run_center.time_${value}`))}</option>`).join('')}</select>
      <div class="run-center-filters" aria-label="${esc(text('run_center.status_filter'))}" data-run-center-scroll-key="status-filters">${statusFilters.map((filter) => `<button type="button" aria-pressed="${String(state.filter === filter)}" class="run-center-filter${state.filter === filter ? ' is-active' : ''}" data-run-center-filter="${filter}">${esc(text(`run_center.filter_${filter}`))}</button>`).join('')}</div>
      ${includeModeSwitch ? `<div class="run-center-mode-switch" role="group" aria-label="${esc(text('run_center.display_mode'))}">${[['queue', 'list', 'run_center.mode_queue'], ['board', 'layout-grid', 'run_center.mode_board']].map(([mode, iconName, key]) => `<button type="button" class="${state.runMode === mode ? 'is-active' : ''}" data-run-center-mode="${mode}" aria-pressed="${String(state.runMode === mode)}" title="${esc(text(key))}">${icon(iconName)}<span>${esc(text(key))}</span></button>`).join('')}</div>` : ''}
      <div class="run-center-archive-actions"><button type="button" class="run-center-archive-scope${state.showArchived ? ' is-active' : ''}" data-run-center-archive-scope aria-pressed="${String(state.showArchived)}" aria-label="${esc(text('run_center.include_archived'))}" title="${esc(text('run_center.include_archived'))}">${icon('archive')}<span>${esc(text('run_center.include_archived'))}</span></button>${archivedCount > 0 ? `<button type="button" class="run-center-purge-archived" data-run-center-purge-archived aria-label="${esc(text('run_center.purge_archived'))}" title="${esc(text('run_center.purge_archived'))}" ${state.busyAction ? 'disabled' : ''}>${purgeBusy ? icon('loader', 'ui-icon is-spinning') : icon('trash-2')}<span>${esc(text('run_center.purge_archived'))}</span></button>` : ''}</div>
      <span class="run-center-query-count" data-run-center-query-count role="status" aria-live="polite">${esc(text('run_center.query_result_count', { count }))}</span>
      ${filtersActive ? sharedButton({
        label: text('run_center.clear_filters'),
        role: 'ghost',
        size: 'sm',
        icon: 'x',
        className: 'run-center-query-clear',
        attrs: { 'data-run-center-query-clear': true },
      }) : ''}
    </div>`;
  }
  function refreshStatusHtml() {
    const hidden = !state.refreshing && !state.stale;
    const message = state.refreshing
      ? text('run_center.refreshing')
      : state.stale ? text('run_center.data_stale', { error: state.staleError }) : '';
    const retry = state.stale ? sharedButton({
      label: text('run_center.retry_load'),
      role: 'secondary',
      size: 'sm',
      icon: 'refresh',
      attrs: { 'data-run-center-stale-retry': true },
    }) : '';
    return `<div class="run-center-refresh-status${state.stale ? ' is-stale' : ''}" data-run-center-refresh-status role="status" aria-live="polite"${hidden ? ' hidden' : ''}><span>${esc(message)}</span>${retry}</div>`;
  }
  function syncRefreshPresentation() {
    const target = panel();
    target?.querySelector?.('.run-center-shell')?.setAttribute?.('aria-busy', String(state.loading || state.refreshing));
    const current = target?.querySelector?.('[data-run-center-refresh-status]');
    if (!current) return;
    const temporary = document.createElement?.('div');
    if (!temporary) return;
    temporary.innerHTML = refreshStatusHtml();
    const next = temporary.firstElementChild;
    if (next && typeof current.replaceWith === 'function') current.replaceWith(next);
  }
  function render(options = {}) {
    const target = panel();
    if (!target) return;
    renderTransaction += 1;
    const createAdvancedOpen = target.querySelector?.('[data-run-center-create-advanced]')?.open === true;
    const scrollSnapshot = options.resetScroll ? null
      : Array.isArray(options.scrollSnapshot) ? options.scrollSnapshot
        : captureScroll(options.excludeScrollKeys);
    const viewHtml = state.view === 'agents' ? agentsHtml()
        : state.view === 'collaboration' ? collaborationWorkspaceHtml() : '';
    const standalone = state.view === 'agents';
    const collaboration = state.view === 'collaboration';
    const runHistory = state.view === 'history';
    const filterable = ['runs', 'history', 'collaboration'].includes(state.view);
    const activeNavView = state.view === 'runs' || state.view === 'history' ? 'tasks' : state.view;
    const scopeLabel = activeNavView === 'tasks'
      ? ` run-center-task-scope-${state.view === 'history' ? 'history' : 'current'}` : '';
    const panelAttributes = `id="run-center-panel-${esc(activeNavView)}" role="tabpanel" aria-labelledby="run-center-tab-${esc(activeNavView)}${scopeLabel}"`;
    const inactivePanels = VIEW_DEFINITIONS.filter(([view]) => view !== activeNavView)
      .map(([view]) => `<div id="run-center-panel-${view}" role="tabpanel" aria-labelledby="run-center-tab-${view}" hidden></div>`).join('');
    // Keep `is-runs` as the shared structural class for both run-oriented tabs.
    const runLayoutClass = state.view === 'runs' || state.view === 'history'
      ? `is-runs${runHistory ? ' is-history' : ''}` : '';
    const layout = collaboration
      ? `<div class="run-center-layout is-collaboration" ${panelAttributes} data-run-center-scroll-key="layout:collaboration">${viewHtml}</div>`
      : standalone
      ? `<div class="run-center-layout is-${esc(state.view)}" ${panelAttributes} data-run-center-scroll-key="layout:${esc(state.view)}"><main class="run-center-main" data-run-center-scroll-key="main:${esc(state.view)}">${viewHtml}</main></div>`
      : `<div class="run-center-layout ${runLayoutClass} is-${esc(state.runMode)}-mode${state.detailOpen ? ' is-detail-open' : ''}" ${panelAttributes} data-run-center-scroll-key="layout:${esc(state.view)}:${esc(state.runMode)}">
          <aside class="run-center-run-list-pane${state.runMode === 'board' ? ' is-board' : ''}" aria-label="${esc(text(state.runMode === 'board' ? 'run_center.mode_board' : 'run_center.mode_queue'))}">${state.runMode === 'board' ? boardHtml() : queueHtml()}</aside>
          <main class="run-center-run-detail-pane">${detailView.renderDetails()}</main>
        </div>`;
    target.innerHTML = `<div class="run-center-shell" data-run-center-scroll-key="shell" data-run-center-state="${esc(state.dataState)}" aria-busy="${String(state.loading || state.refreshing)}">
      <header class="run-center-header is-compact"><h1 class="ui-visually-hidden">${esc(text('run_center.title'))}</h1><nav class="run-center-navigation">${navigationHtml()}${taskScopeHtml()}</nav><div class="run-center-header-actions"><button type="button" class="btn btn-sm btn-primary" data-run-center-create-open title="${esc(text('run_center.create_task'))}" aria-label="${esc(text('run_center.create_task'))}">${icon('plus')}<span>${esc(text('run_center.create_task'))}</span></button><button type="button" class="run-center-icon-btn" data-run-center-refresh title="${esc(text('run_center.refresh'))}" aria-label="${esc(text('run_center.refresh'))}">${icon('refresh')}</button><div class="run-center-more-menu"><button type="button" class="run-center-icon-btn" data-run-center-tools-toggle title="${esc(text('run_center.more_tools'))}" aria-label="${esc(text('run_center.more_tools'))}" aria-haspopup="menu" aria-controls="run-center-tools-menu" aria-expanded="${String(state.toolsOpen)}">${icon('more-horizontal')}</button>${state.toolsOpen ? `<div id="run-center-tools-menu" role="menu" data-run-center-tools-menu><button type="button" role="menuitem" tabindex="0" data-run-center-settings-anchor="worktrees">${icon('git-branch')}<span>${esc(text('run_center.worktrees'))}</span></button><button type="button" role="menuitem" tabindex="-1" data-run-center-settings-anchor="diagnostics">${icon('activity')}<span>${esc(text('run_center.diagnostics'))}</span></button></div>` : ''}</div></div></header>
      ${refreshStatusHtml()}
      ${taskSummaryHtml()}
      ${filterable ? queryBarHtml({ modeSwitch: state.view === 'runs' || state.view === 'history' }) : ''}
      ${layout}${inactivePanels}
    </div>${createModalHtml(createAdvancedOpen)}`;
    showRenderedDialog(target);
    let restoredPendingContext = false;
    if (state.pendingRestoreContext && state.board && !state.loading) {
      const restore = state.pendingRestoreContext;
      state.pendingRestoreContext = null;
      restoredPendingContext = true;
      restoreScroll(restore.scrollPositions || []);
      rootWindow.setTimeout(() => restoreFocus(restore.focusTarget, state.selectedRunKey
        ? state.runMode === 'board'
          ? `[data-dashboard-board-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
          : `[data-run-center-queue-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
        : ''), 0);
    }
    if (!restoredPendingContext) restoreScroll(scrollSnapshot);
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
    if (owner === 'create' && state.createSpaceId) {
      invalidateWorktreesRequest('create');
      state.createWorktreeName = '';
      state.worktreesError = '';
      renderPreservingFocus('[data-run-center-create-space], [data-run-center-create-task]');
      return;
    }
    const revision = ++state.worktreesRequestRevision;
    state.worktreesRequestOwner = owner;
    state.worktreesLoading = true;
    state.worktreesError = '';
    const fallbackSelector = owner === 'create' && state.createMode
      ? '[data-run-center-create-task], [data-run-center-create-agent]' : '';
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
  async function loadAgents() {
    if (state.agentsLoaded || state.agentsLoading) return;
    state.agentsLoading = true;
    state.createAdvancedError = '';
    renderPreservingFocus(state.createMode ? '[data-run-center-create-task], [data-run-center-create-agent]' : '');
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
      state.agentsLoaded = false;
      state.createAdvancedError = error?.message || String(error);
    } finally {
      state.agentsLoading = false;
    }
    renderPreservingFocus(state.createMode ? '[data-run-center-create-task], [data-run-center-create-agent]' : '');
  }
  function invalidateSpacesRequest() {
    state.spacesRequestRevision += 1;
    state.spacesLoading = false;
  }
  function ensureCreateWorktreesLoaded() {
    const advancedOpen = panel()?.querySelector?.('[data-run-center-create-advanced]')?.open === true;
    if (advancedOpen && !state.createSpaceId && state.worktreesRequestOwner !== 'create') {
      loadWorktrees('create');
    }
  }
  async function loadSpaces() {
    if (state.createMode !== 'create') return;
    const revision = ++state.spacesRequestRevision;
    state.spacesLoading = true;
    state.spacesError = '';
    state.spacesNotice = '';
    renderPreservingFocus('[data-run-center-create-task], [data-run-center-create-space]');
    try {
      const result = await invoke('spaces.list', {});
      if (revision !== state.spacesRequestRevision || state.createMode !== 'create') return;
      state.spaces = Array.isArray(result?.spaces) ? result.spaces : [];
      if (state.createSpaceId && !state.spaces.some((space) => space?.space_id === state.createSpaceId)) {
        state.createSpaceId = '';
        state.createWorktreeName = '';
        state.spacesNotice = text('run_center.create_space_reset');
      }
    } catch (_error) {
      if (revision !== state.spacesRequestRevision || state.createMode !== 'create') return;
      state.spaces = [];
      state.createSpaceId = '';
      state.createWorktreeName = '';
      state.spacesError = text('run_center.create_space_unavailable');
    } finally {
      if (revision === state.spacesRequestRevision && state.createMode === 'create') {
        state.spacesLoading = false;
        renderPreservingFocus('[data-run-center-create-task], [data-run-center-create-space]');
        ensureCreateWorktreesLoaded();
      }
    }
  }
  function focusCreateControl() {
    focusLater('[data-run-center-create-task], [data-run-center-create-agent]');
  }
  function createFailureMessage(error) {
    const message = error?.message || String(error);
    if (message.includes('E_RUN_CENTER_SPACE_UNAVAILABLE') || message.includes('E_RUN_CENTER_SPACE_MISMATCH')
      || message.includes('E_RUN_CENTER_SPACE_WORKSPACE_MISMATCH')) {
      return text('run_center.create_space_stale');
    }
    if (message.includes('E_RUN_CENTER_SPACE_WORKTREE_CONFLICT')) {
      return text('run_center.create_space_isolation_unavailable');
    }
    if (message.includes('CogSeed Agent is unavailable')) return text('run_center.selected_agent_unavailable');
    if (message.includes('CogSeed Agent runtime is not executable')) return text('run_center.selected_agent_runtime_unavailable');
    return message;
  }
  function clearCreateErrorAfterEdit(focusSelector) {
    if (!state.createError) return;
    state.createError = '';
    renderPreservingFocus(focusSelector);
  }
  function resetCreateForm(mode = '', returnFocus = '') {
    Object.assign(state, {
      createMode: mode,
      createTask: '',
      createSpaceId: mode === 'create' ? String(rootWindow.getNewChatSpaceId?.() || '') : '',
      createAgentId: '',
      createWorktreeName: '',
      createError: '',
      createAdvancedError: '',
      createReturnFocus: returnFocus,
      spacesError: '',
      spacesNotice: '',
    });
  }
  function openCreate(mode) {
    const suspendingDetail = mode === 'reassign' && state.detailOpen;
    state.restoreDetailAfterCreate = suspendingDetail;
    if (suspendingDetail) state.detailOpen = false;
    const returnFocus = mode === 'reassign' ? '[data-run-center-reassign]' : '[data-run-center-create-open]';
    resetCreateForm(mode, returnFocus);
    render();
    focusCreateControl();
    if (mode === 'reassign') loadAgents();
    else loadSpaces();
  }
  function closeCreate() {
    if (state.createBusy) return;
    const returnFocus = state.createReturnFocus;
    const restoreDetail = state.restoreDetailAfterCreate;
    invalidateSpacesRequest();
    invalidateWorktreesRequest('create');
    resetCreateForm();
    state.restoreDetailAfterCreate = false;
    state.detailOpen = restoreDetail;
    render();
    if (restoreDetail && state.selectedSessionId && !state.detail) refreshSelectedDetail();
    focusLater(restoreDetail ? '[data-run-center-reassign]' : returnFocus);
  }
  function setSelectedTask(sessionId, taskId, options) {
    state.selectionRevision += 1;
    state.selectedSessionId = String(sessionId || '');
    state.selectedTaskId = String(taskId || '');
    const run = runForSelection(options?.runKey, state.selectedTaskId);
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
  function refreshSelectedDetail() {
    const sessionId = String(state.selectedSessionId || '');
    const taskId = String(state.selectedTaskId || '');
    const revision = state.selectionRevision;
    if (!sessionId) return;
    void invoke('cogseed.session.read', { sessionId, taskId: taskId || undefined })
      .then((detail) => {
        if (!selectionIsCurrent(revision, sessionId, taskId)) return;
        state.detail = detail;
        state.detailError = '';
        const focusSnapshot = captureFocus();
        const scrollSnapshot = captureScroll();
        render({ scrollSnapshot });
        if (focusSnapshot) restoreFocus(focusSnapshot);
      })
      .catch((error) => {
        if (!selectionIsCurrent(revision, sessionId, taskId)) return;
        state.detailError = error?.message || String(error);
        const focusSnapshot = captureFocus();
        const scrollSnapshot = captureScroll();
        render({ scrollSnapshot });
        if (focusSnapshot) restoreFocus(focusSnapshot);
      });
  }
  async function submitCreate(mode = 'start') {
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
    state.createBusyMode = isReassign ? 'start' : mode;
    state.createError = '';
    render();
    try {
      const requestId = `req-run-center-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const channel = isReassign ? 'cogseed.task.reassign'
        : mode === 'save' ? 'cogseed.task.create' : 'cogseed.task.start';
      const created = await invoke(channel, isReassign
        ? { taskId: source.taskId, requestId, agentId: state.createAgentId }
        : { requestId, task: state.createTask.trim(), ...(state.createSpaceId ? { spaceId: state.createSpaceId } : {}), ...(state.createAgentId ? { agentId: state.createAgentId } : {}), ...(!state.createSpaceId && state.createWorktreeName ? { worktreeName: state.createWorktreeName } : {}) });
      state.createMode = '';
      state.restoreDetailAfterCreate = false;
      state.view = 'runs';
      state.detailTab = 'summary';
      state.detailOpen = true;
      state.actionNotice = isReassign ? 'run_center.reassign_success'
        : mode === 'save' ? 'run_center.save_planned_success' : 'run_center.create_success';
      state.actionError = '';
      state.createReturnFocus = '[data-run-center-detail-tab="summary"]';
      await refresh({ background: true });
      if (created?.sessionId && created?.taskId) await select(created.sessionId, created.taskId, { focusDetail: true });
    } catch (error) {
      state.createError = createFailureMessage(error);
    } finally {
      state.createBusy = false;
      state.createBusyMode = '';
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
    const run = runForSelection(options?.runKey, nextTaskId);
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
    state.detailError = '';
    renderForRunSelection();
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
      state.detailError = error?.message || String(error);
    }
    if (revision !== state.selectionRevision) return;
    if (options?.focusDetail && !state.detailOpen) return;
    const focusSnapshot = options?.preserveFocus ? captureFocus() : null;
    renderForRunSelection();
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
  function setViewState(view, forceMode = false) {
    const nextView = normalizeView(view);
    if (!nextView) return null;
    const previousView = state.view;
    state.view = nextView;
    state.restoreDetailAfterCreate = false;
    if (forceMode || previousView !== nextView) {
      state.detailOpen = false;
      state.detailReturnFocus = '';
      if (nextView === 'runs') {
        const requestedView = String(view || '').trim();
        state.runMode = forceMode && requestedView === 'board'
          ? 'board'
          : preferredRunMode;
        state.detailTab = 'summary';
      } else if (nextView === 'history') {
        state.runMode = 'queue';
        state.detailTab = 'history';
      } else if (nextView === 'collaboration') {
        state.runMode = 'queue';
        state.detailTab = 'collaboration';
      }
    }
    return { nextView, previousView };
  }
  function activateView(view, focusTab) {
    const transition = setViewState(view);
    if (!transition) return false;
    const { nextView, previousView } = transition;
    render({ resetScroll: previousView !== nextView });
    if (focusTab) panel()?.querySelector(`[data-run-center-view="${nextView === 'runs' || nextView === 'history' ? 'tasks' : nextView}"]`)?.focus();
    return true;
  }
  function enterRunQueue(query = {}) {
    Object.assign(state, DEFAULT_RUN_QUERY, query, {
      view: 'runs', runMode: 'queue', detailTab: 'summary',
    });
    state.conversationIdFilter = String(query.conversationId || '');
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
      state.refreshQueued = true;
      return state.refreshInFlight;
    }
    const refreshScrollSnapshot = captureScroll();
    const refreshView = state.view;
    const refreshRunMode = state.runMode;
    const refreshSelectionRevision = state.selectionRevision;
    const hadExplicitSelection = !!state.selectedRunKey || !!state.selectedTaskId;
    const hadProjection = !!state.board;
    state.refreshInFlight = (async () => {
      if (!background && !hadProjection) {
        state.loading = true;
        state.dataState = 'loading';
        state.error = '';
        render({ scrollSnapshot: refreshScrollSnapshot });
      } else {
        state.refreshing = true;
        state.dataState = 'refreshing';
        state.error = '';
        syncRefreshPresentation();
      }
      try {
        const registryRevision = (state.agentRegistryRequestRevision || 0) + 1;
        state.agentRegistryRequestRevision = registryRevision;
        const registryPromise = invoke('cogseed.agent.list')
          .then((value) => {
            if (registryRevision !== state.agentRegistryRequestRevision) return;
            state.agentRegistry = value;
            state.agentRegistryError = '';
            renderPreservingFocus();
          })
          .catch((error) => {
            if (registryRevision !== state.agentRegistryRequestRevision) return;
            state.agentRegistryError = error?.message || String(error);
            renderPreservingFocus();
          });
        const board = await invoke('cogseed.task.list');
        state.board = board;
        state.error = '';
        state.stale = false;
        state.staleError = '';
        state.dataState = Array.isArray(board?.tasks) && board.tasks.length ? 'ready' : 'empty';
        if (!background && !hadProjection) {
          state.loading = false;
          render({ scrollSnapshot: refreshScrollSnapshot });
        }
        const visibleRuns = visibleBoardRuns();
        const selectionChangedDuringRefresh = state.selectionRevision !== refreshSelectionRevision;
        const run = visibleRuns.find((item) => item.key === state.selectedRunKey)
          || visibleRuns.find((item) => item.members?.some((member) => member.taskId === state.selectedTaskId))
          || (!hadExplicitSelection && !selectionChangedDuringRefresh ? visibleRuns[0] : null);
        const retainedSelection = run?.key === state.selectedRunKey
          || run?.members?.some((member) => member.taskId === state.selectedTaskId);
        const selectedAttemptMissing = !!(retainedSelection && state.selectedAttemptKey)
          && !buildAttemptModels(run).some((attempt) => attempt.key === state.selectedAttemptKey);
        const preferredTaskId = retainedSelection ? state.selectedTaskId : runTask(run)?.taskId;
        const attemptSelection = reconcileAttemptSelection(
          run,
          retainedSelection ? state.selectedAttemptKey : '',
          preferredTaskId,
        );
        const attempt = attemptSelection.selected;
        const task = attempt?.representative || run?.aggregateTask || run?.representative;
        const mayAdjustSelection = !background || !selectionChangedDuringRefresh;
        if (background && selectionChangedDuringRefresh && run?.key && state.selectedTaskId
          && task?.taskId === state.selectedTaskId && !state.selectedRunKey) {
          state.selectedRunKey = run.key;
          state.boardFocusRunKey = run.key;
        }
        if (mayAdjustSelection && (selectedAttemptMissing || !task)) {
          setSelectedTask('', '');
          state.detail = null;
          state.detailOpen = false;
        } else if (mayAdjustSelection && run && (run.key !== state.selectedRunKey
          || attempt?.key !== state.selectedAttemptKey
          || task.taskId !== state.selectedTaskId
          || task.sessionId !== state.selectedSessionId
          || !selectedTask())) {
          if (background) {
            const nextSessionId = String(task.sessionId || '');
            const nextTaskId = String(task.taskId || '');
            setSelectedTask(nextSessionId, nextTaskId, {
              runKey: run.key, attemptKey: attempt?.key || '',
            });
            state.detail = null;
            state.detailError = '';
            renderForRunSelection();
            refreshSelectedDetail();
          } else select(task.sessionId, task.taskId, {
            runKey: run.key, attemptKey: attempt?.key || '',
          });
        } else if (background && state.selectedSessionId) {
          refreshSelectedDetail();
        }
        void registryPromise;
      } catch (error) {
        const message = error?.message || String(error);
        if (state.board) {
          state.stale = true;
          state.staleError = message;
          state.dataState = 'stale';
          state.error = '';
        } else {
          state.error = message;
          state.stale = false;
          state.staleError = '';
          state.dataState = 'error';
        }
      } finally {
        state.loading = false;
        state.refreshing = false;
        const preserveInteraction = background || hadProjection;
        const focusSnapshot = preserveInteraction ? captureFocus() : null;
        const sameWorkspace = state.view === refreshView && state.runMode === refreshRunMode;
        const currentScrollSnapshot = captureScroll();
        const finalScrollSnapshot = state.selectionRevision === refreshSelectionRevision
          ? currentScrollSnapshot
          : currentScrollSnapshot.filter((item) => !RUN_SELECTION_DETAIL_SCROLL_KEYS.includes(item.key));
        render(sameWorkspace ? { scrollSnapshot: finalScrollSnapshot } : {});
        if (preserveInteraction) {
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
      if (error?.name !== 'AbortError') {
        const message = error?.message || String(error);
        if (state.board) {
          state.stale = true;
          state.staleError = message;
          state.dataState = 'stale';
          state.error = '';
        } else {
          state.error = message;
          state.dataState = 'error';
        }
      }
      render();
    });
  }
  async function action(action, targetTaskId = '') {
    if (state.busyAction) return;
    const explicitTaskId = String(targetTaskId || '').trim();
    const task = explicitTaskId
      ? (state.board?.tasks || []).find((item) => item.taskId === explicitTaskId)
      : state.detail?.collaboration?.task || selectedTask();
    if (!task) return;
    if (action === 'abort' && !rootWindow.confirm(text('run_center.abort_confirm'))) return;
    const archivedRun = action === 'archive'
      ? allRunModels().find((run) => run.members?.some((member) => member.taskId === task.taskId))
      : null;
    const archiveTaskIds = action === 'archive'
      ? archivedRun
        ? Array.isArray(archivedRun.archiveTaskIds) ? [...archivedRun.archiveTaskIds] : []
        : task.actions?.archive ? [task.taskId] : []
      : [];
    if (action === 'archive' && !archiveTaskIds.length) return;
    const archivingSelectedRun = !!archivedRun && archivedRun.key === state.selectedRunKey;
    const archiveScrollSnapshot = action === 'archive' ? captureScroll() : null;
    const previousRunKeys = new Set(allRunModels().map((run) => run.key));
    const sourceConversationId = task.conversationId;
    const sourceSessionId = task.sessionId;
    state.busyAction = action;
    state.busyTaskId = task.taskId;
    state.actionNotice = '';
    state.actionError = '';
    renderPreservingFocus();
    try {
      if (action === 'archive') {
        // Children are archived before the representative so a failed batch
        // always leaves the logical run visible with a recoverable action.
        for (const taskId of archiveTaskIds) {
          await invoke('cogseed.task.action', { taskId, action });
        }
      } else {
        const payload = { taskId: task.taskId, action };
        if (action === 'start' || action === 'retry' || action === 'resume') payload.requestId = `req-run-center-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        await invoke('cogseed.task.action', payload);
      }
      if (action === 'archive' && archivingSelectedRun) {
        state.detailOpen = false;
        state.detailReturnFocus = '';
      }
      await refresh({ background: true });
      if (action === 'archive') {
        state.actionNotice = '';
        // The refresh owns invalid-selection cleanup. Avoid changing a newer
        // user selection when this archive request settles late.
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
      if (action === 'archive') await refresh({ background: true }).catch(() => undefined);
      state.actionError = error?.message || String(error);
      if (explicitTaskId && typeof rootWindow.uiToast === 'function') {
        rootWindow.uiToast(state.actionError, { variant: 'error' });
      }
    } finally {
      state.busyAction = '';
      state.busyTaskId = '';
      const fallbackSelector = action === 'archive' && (state.view === 'runs' || state.view === 'history')
        ? `[data-run-center-view="tasks"]`
        : action === 'archive' && state.selectedRunKey
          ? state.runMode === 'board'
            ? `[data-dashboard-board-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
            : `[data-run-center-queue-run-key="${escapedAttributeValue(state.selectedRunKey)}"]`
          : '[data-run-center-detail-tab="summary"]';
      renderPreservingFocus(fallbackSelector);
      if (archiveScrollSnapshot) restoreScroll(archiveScrollSnapshot);
    }
  }
  async function purgeArchived() {
    if (state.busyAction) return;
    state.busyAction = 'purge-archived';
    state.busyTaskId = '';
    renderPreservingFocus('[data-run-center-purge-archived]');
    try {
      const report = await invoke('cogseed.task.archived.purge');
      await refresh({ background: true });
      const purged = Array.isArray(report?.purgedTaskIds) ? report.purgedTaskIds.length : 0;
      const retained = Array.isArray(report?.retainedTaskIds) ? report.retainedTaskIds.length : 0;
      const failed = Array.isArray(report?.failedTaskIds) ? report.failedTaskIds.length : 0;
      if (typeof rootWindow.uiToast === 'function') {
        rootWindow.uiToast(text(retained + failed > 0
          ? 'run_center.purge_archived_partial'
          : 'run_center.purge_archived_success', { count: purged, remaining: retained + failed }), {
          variant: retained + failed > 0 ? 'warning' : 'success',
        });
      }
    } catch (error) {
      if (typeof rootWindow.uiToast === 'function') {
        rootWindow.uiToast(text('run_center.purge_archived_failed', {
          reason: error?.message || String(error),
        }), { variant: 'error' });
      }
    } finally {
      state.busyAction = '';
      renderPreservingFocus('[data-run-center-archive-scope]');
    }
  }
  function collaborationTargetExists(targetId) {
    const detail = state.detail?.collaboration;
    if (!detail || !targetId) return false;
    const workflow = detail.workflow || {};
    return [
      ...(Array.isArray(workflow.steps) ? workflow.steps.map((item) => item.stepId) : []),
      ...(Array.isArray(detail.reviews) ? detail.reviews.map((item) => item.gateId) : []),
      ...(Array.isArray(detail.conflicts) ? detail.conflicts.map((item) => item.conflictId) : []),
    ].includes(targetId);
  }
  function collaborationActionIsCurrent(snapshot, requireTarget = false) {
    const task = state.detail?.collaboration?.task || selectedTask();
    return snapshot.revision === state.selectionRevision
      && snapshot.runKey === state.selectedRunKey
      && snapshot.taskId === task?.taskId
      && (!requireTarget || collaborationTargetExists(snapshot.targetId));
  }
  async function collaborationAction(actionName, targetId) {
    const task = state.detail?.collaboration?.task || selectedTask();
    if (!task || !targetId || state.busyCollaborationAction || !collaborationTargetExists(targetId)) return;
    if (['skip-step', 'reject-gate', 'dismiss-conflict'].includes(actionName)
      && !rootWindow.confirm(text(`run_center.${actionName.replace(/-/g, '_')}_confirm`))) return;
    state.busyCollaborationAction = `${actionName}:${targetId}`;
    state.actionError = '';
    const actionSelection = {
      revision: state.selectionRevision,
      runKey: state.selectedRunKey,
      attemptKey: state.selectedAttemptKey,
      sessionId: state.selectedSessionId,
      taskId: task.taskId,
      targetId,
    };
    if (!collaborationActionIsCurrent(actionSelection, true)) {
      state.busyCollaborationAction = '';
      return;
    }
    render();
    try {
      await invoke('cogseed.collaboration.action', { taskId: task.taskId, action: actionName, targetId });
      await refresh({ background: true });
      if (collaborationActionIsCurrent(actionSelection)) {
        await select(actionSelection.sessionId, actionSelection.taskId, {
          runKey: actionSelection.runKey, attemptKey: actionSelection.attemptKey,
        });
      }
    } catch (error) {
      if (collaborationActionIsCurrent(actionSelection)) {
        state.actionError = error?.message || String(error);
      }
    } finally {
      if (state.busyCollaborationAction === `${actionName}:${targetId}`) {
        state.busyCollaborationAction = '';
        renderPreservingFocus();
      }
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
  function adjacentTab(items, control, key) {
    const current = Math.max(0, items.indexOf(control));
    if (key === 'Home') return items[0] || control;
    if (key === 'End') return items.at(-1) || control;
    const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    return items[(current + step + items.length) % items.length] || control;
  }
  function handleTaskScopeKeydown(event) {
    const control = event.target?.closest?.('[data-run-center-task-scope]');
    if (!control || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    const items = Array.from(panel()?.querySelectorAll?.('[data-run-center-task-scope]') || []);
    if (!items.length) return false;
    const next = adjacentTab(items, control, event.key);
    const scope = next.dataset.runCenterTaskScope === 'history' ? 'history' : 'current';
    event.preventDefault();
    activateView(scope === 'history' ? 'history' : 'tasks', false);
    panel()?.querySelector?.(`[data-run-center-task-scope="${scope}"]`)?.focus?.();
    return true;
  }
  function handleDetailTabKeydown(event) {
    const control = event.target?.closest?.('[data-run-center-detail-tab]');
    if (!control || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    const items = Array.from(panel()?.querySelectorAll?.('.run-center-detail-tabs [data-run-center-detail-tab]') || []);
    if (!items.length) return false;
    const next = adjacentTab(items, control, event.key);
    const tab = next.dataset.runCenterDetailTab || 'summary';
    event.preventDefault();
    state.detailTab = tab;
    state.actionNotice = '';
    state.actionError = '';
    const selector = `[data-run-center-detail-tab="${escapedAttributeValue(tab)}"]`;
    renderPreservingFocus(selector);
    panel()?.querySelector?.(selector)?.focus?.();
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
  function updateSearch(event, stateKey, selector, rerender) {
    state[stateKey] = event.target.value || '';
    if (event.isComposing) return;
    const { selectionStart, selectionEnd, selectionDirection } = event.target;
    rerender();
    const nextSearch = panel()?.querySelector(selector);
    nextSearch?.focus();
    if (Number.isInteger(selectionStart) && typeof nextSearch?.setSelectionRange === 'function') {
      nextSearch.setSelectionRange(
        selectionStart,
        Number.isInteger(selectionEnd) ? selectionEnd : selectionStart,
        selectionDirection || 'none',
      );
    }
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
        rootWindow.setView?.('settings', undefined, { settingsTab: 'configuration', settingsAnchor: 'models' });
        rootWindow.activateSettingsTab?.('configuration', { anchor: 'models' });
        return;
      }
      if (button.dataset.runCenterAgentSettings !== undefined) {
        rootWindow.setView?.('settings', undefined, { settingsTab: 'configuration', settingsAnchor: 'agents' });
        rootWindow.activateSettingsTab?.('configuration', { anchor: 'agents' });
        return;
      }
      if (button.dataset.runCenterSettingsAnchor) {
        const anchor = button.dataset.runCenterSettingsAnchor;
        state.toolsOpen = false;
        rootWindow.setView?.('settings', undefined, { settingsTab: 'configuration', settingsAnchor: anchor });
        rootWindow.activateSettingsTab?.('configuration', { anchor });
        return;
      }
      if (button.dataset.runCenterReassign !== undefined) { openCreate('reassign'); return; }
      if (button.dataset.runCenterCreateClose !== undefined) { closeCreate(); return; }
      if (button.dataset.runCenterCreateSave !== undefined) { submitCreate('save'); return; }
      if (button.dataset.runCenterCreateSubmit !== undefined) { submitCreate(); return; }
      if (button.dataset.runCenterCreateSpacesRetry !== undefined) { loadSpaces(); return; }
      if (button.dataset.runCenterCreateAgentsRetry !== undefined) { loadAgents(); return; }
      if (button.dataset.runCenterCreateWorktreesRetry !== undefined) { loadWorktrees('create'); return; }
      if (button.dataset.runCenterStaleRetry !== undefined) { refresh({ background: true }); return; }
      if (button.dataset.runCenterQueryClear !== undefined) {
        state.search = '';
        state.filter = 'all';
        state.sourceFilter = 'all';
        state.runAgentFilter = 'all';
        state.runTimeFilter = 'all';
        state.showArchived = false;
        state.conversationIdFilter = '';
        renderAfterFilterChange(true);
        focusLater('[data-run-center-search]');
        return;
      }
      if (button.dataset.runCenterMode) {
        state.runMode = button.dataset.runCenterMode === 'board' ? 'board' : 'queue';
        if (state.view === 'runs') {
          preferredRunMode = state.runMode;
          writePreferredRunMode(preferredRunMode);
        }
        state.detailOpen = false;
        renderPreservingFocus(`[data-run-center-mode="${state.runMode}"]`);
        return;
      }
      if (button.dataset.runCenterTaskScope) {
        const next = button.dataset.runCenterTaskScope === 'history' ? 'history' : 'tasks';
        activateView(next, false);
        panel()?.querySelector(`[data-run-center-task-scope="${button.dataset.runCenterTaskScope}"]`)?.focus();
        return;
      }
      if (button.dataset.runCenterArchiveScope !== undefined) {
        state.showArchived = !state.showArchived;
        renderAfterFilterChange(true);
        return;
      }
      if (button.dataset.runCenterPurgeArchived !== undefined) {
        purgeArchived();
        return;
      }
      if (button.dataset.runCenterTimelineJump !== undefined) {
        const failure = panel()?.querySelector('[data-run-center-timeline-failure]');
        failure?.scrollIntoView?.({ block: 'center', behavior: rootWindow.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
        failure?.focus?.();
        return;
      }
      if (button.dataset.runCenterQuickArchive) {
        action('archive', button.dataset.runCenterQuickArchive);
        return;
      }
      if (button.dataset.runCenterSummaryFilter) {
        enterRunQueue({ filter: button.dataset.runCenterSummaryFilter });
        renderAfterFilterChange(true);
        return;
      }
      if (button.dataset.runCenterAgentTask) {
        const task = (state.board?.tasks || []).find((item) => item.taskId === button.dataset.runCenterAgentTask);
        openConversationFromRunCenter(task?.conversationId);
        return;
      }
      if (button.dataset.runCenterAgentConversation !== undefined) { openConversationFromRunCenter(button.dataset.runCenterAgentConversation); return; }
      if (button.dataset.runCenterView) {
        const requestedView = normalizeView(button.dataset.runCenterView);
        if (requestedView === state.view) {
          panel()?.querySelector(`[data-run-center-view="${requestedView === 'runs' || requestedView === 'history' ? 'tasks' : requestedView}"]`)?.focus();
        } else activateView(button.dataset.runCenterView, true);
        return;
      }
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
      if (button.dataset.runCenterOpen !== undefined) { openConversationFromRunCenter(button.dataset.runCenterOpen); }
    });
    target.addEventListener('input', (event) => {
      if (event.target.matches('[data-run-center-search]')) {
        updateSearch(event, 'search', '[data-run-center-search]', () => renderAfterFilterChange(false));
      }
      if (event.target.matches('[data-run-center-agent-search]')) {
        updateSearch(event, 'agentSearch', '[data-run-center-agent-search]', render);
      }
      if (event.target.matches('[data-run-center-create-task]')) {
        state.createTask = event.target.value || '';
        clearCreateErrorAfterEdit('[data-run-center-create-task]');
      }
    });
    target.addEventListener('change', (event) => {
      if (event.target.matches('[data-run-center-create-agent]')) {
        state.createAgentId = event.target.value || '';
        clearCreateErrorAfterEdit('[data-run-center-create-agent]');
      }
      if (event.target.matches('[data-run-center-create-space]')) {
        const nextSpaceId = event.target.value || '';
        if (nextSpaceId !== state.createSpaceId) {
          state.createSpaceId = nextSpaceId;
          state.createWorktreeName = '';
          state.spacesNotice = '';
          if (nextSpaceId) invalidateWorktreesRequest('create');
          if (state.createError) state.createError = '';
          renderPreservingFocus('[data-run-center-create-space]');
          ensureCreateWorktreesLoaded();
        }
      }
      if (event.target.matches('[data-run-center-create-worktree]')) {
        state.createWorktreeName = state.createSpaceId ? '' : event.target.value || '';
        clearCreateErrorAfterEdit('[data-run-center-create-worktree]');
      }
      if (event.target.matches('[data-run-center-source-filter]')) { state.sourceFilter = event.target.value || 'all'; renderAfterFilterChange(true); }
      if (event.target.matches('[data-run-center-run-agent-filter]')) { state.runAgentFilter = event.target.value || 'all'; renderAfterFilterChange(true); }
      if (event.target.matches('[data-run-center-time-filter]')) { state.runTimeFilter = event.target.value || 'all'; renderAfterFilterChange(true); }
    });
    target.addEventListener('toggle', (event) => {
      if (event.target?.dataset?.runCenterCreateAdvanced !== undefined) {
        if (event.target.open && state.createMode === 'create' && !state.createBusy) {
          state.createAdvancedError = '';
          loadAgents();
          ensureCreateWorktreesLoaded();
        }
        return;
      }
    }, true);
    target.addEventListener('cancel', (event) => {
      const dataset = event.target?.dataset || {};
      const nativeDialog = dataset.runCenterCreateDialog !== undefined;
      if (!nativeDialog) return;
      event.preventDefault();
      closeCreate();
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
      if (handleTaskScopeKeydown(event)) return;
      if (handleDetailTabKeydown(event)) return;
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
      if (event.key === 'Escape' && state.createMode) return;
      if (event.key === 'Escape' && state.toolsOpen) closeToolsMenu(true);
      else if (event.key === 'Escape' && state.detailOpen) closeDetails();
    });
    rootWindow.addEventListener('i18n-change', () => render());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopWatch();
      else if (panel()?.closest('.panel')?.classList.contains('active')) { startWatch(); scheduleRefresh(); }
    });
  }
  function applyRequestedView(view) {
    return !!setViewState(view, true);
  }
  function restoreContext(context) {
    if (!context || typeof context !== 'object') return;
    const sourceView = context.sourceView === 'agents' ? 'agents' : context.sourceView === 'collaboration' ? 'collaboration' : 'tasks';
    const scope = context.taskScope === 'history' ? 'history' : 'current';
    state.view = sourceView === 'tasks' ? (scope === 'history' ? 'history' : 'runs') : sourceView;
    state.runMode = context.runMode === 'board' ? 'board' : 'queue';
    const filters = context.filters || {};
    state.search = String(filters.search || '');
    state.filter = String(filters.filter || 'all');
    state.sourceFilter = String(filters.sourceFilter || 'all');
    state.runAgentFilter = String(filters.runAgentFilter || 'all');
    state.runTimeFilter = String(filters.runTimeFilter || 'all');
    state.showArchived = filters.showArchived === true;
    state.selectedRunKey = String(context.selectedRunKey || '');
    state.selectedAttemptKey = String(context.selectedAttemptKey || '');
    state.selectedTaskId = String(context.selectedTaskId || '');
    state.selectedSessionId = String(context.selectedSessionId || '');
    state.conversationIdFilter = String(context.conversationIdFilter || '');
    state.detailTab = state.view === 'history' ? 'history' : state.view === 'collaboration' ? 'collaboration' : 'summary';
    state.detailOpen = !!state.selectedRunKey;
    state.pendingRestoreContext = {
      ...context,
      scrollPositions: Array.isArray(context.scrollPositions) ? context.scrollPositions : [],
    };
  }
  rootWindow.openRunCenterView = function openRunCenterView(view) {
    if (!applyRequestedView(view)) return;
    render({ resetScroll: true });
  };
  rootWindow.renderRunCenter = function renderRunCenter(initialView, options = {}) {
    bind();
    if (options.restore) restoreContext(options.restore);
    else if (initialView) applyRequestedView(initialView);
    else if (state.view === 'runs') state.runMode = preferredRunMode;
    if (options.query) {
      Object.assign(state, DEFAULT_RUN_QUERY, options.query);
      state.conversationIdFilter = String(options.query.conversationId || '');
    }
    startWatch();
    refresh().then(() => {
      if (options.openCreate && state.createMode === '') openCreate('create');
    });
  };
  rootWindow.openRunCenterTaskConversation = openConversationFromRunCenter;
  rootWindow.captureRunCenterReturnContext = captureReturnContext;
  rootWindow.stopRunCenterWatch = stopWatch;
})(window);
