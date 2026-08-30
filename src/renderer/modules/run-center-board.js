// Board rendering is intentionally projection-only. Execution state changes
// remain centralized in the Run Center controller.
(function initCogSeedRunCenterBoard(root) {
  'use strict';

  const COLUMN_KEYS = ['pending', 'running', 'attention', 'completed'];
  const LOGICAL_ACTIVE_STATE_PRIORITY = ['attention', 'running', 'pending'];
  const ATTENTION_STATE_PRIORITY = Object.freeze({
    waiting_user: 0,
    review: 1,
    recoverable: 2,
    failed: 3,
    pending_recovery: 4,
  });

  function matchesFilter(task, filter) {
    const column = displayColumnForTask(task);
    if (filter === 'pending') return column === 'pending';
    if (filter === 'running') return column === 'running';
    if (filter === 'attention') return column === 'attention';
    if (filter === 'completed') return column === 'completed';
    return column !== 'archived';
  }

  function filteredTasks(projection, search, filter, includeArchived = false, sourceFilter = 'all', agentName) {
    const query = String(search || '').trim().toLocaleLowerCase();
    return (Array.isArray(projection && projection.tasks) ? projection.tasks : []).filter((task) => {
      if (task.column === 'archived' && !includeArchived) return false;
      if (task.column !== 'archived' && !matchesFilter(task, filter)) return false;
      if (sourceFilter !== 'all' && task.sourceKind !== sourceFilter) return false;
      if (!query) return true;
      return [task.title, task.taskId, task.sessionTitle, task.sessionId, task.agentId, task.worktreeName,
        typeof agentName === 'function' ? agentName(task.agentId) : '', task.coordinationId, task.groupId]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
  }

  function shouldShowSessionTitle(taskTitle, sessionTitle) {
    const task = String(taskTitle || '').trim().toLocaleLowerCase();
    const session = String(sessionTitle || '').trim().toLocaleLowerCase();
    return !!session && session !== task;
  }

  function uniqueCardMeta(taskTitle, candidates) {
    const seen = new Set([String(taskTitle || '').trim().toLocaleLowerCase()].filter(Boolean));
    return candidates.filter((candidate) => {
      const key = String(candidate.value || '').trim().toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function logicalRunKey(task) {
    const identifiers = [
      ['group', task?.groupId],
      ['coordination', task?.coordinationId],
      ['execution', task?.executionId],
      ['session', task?.sessionId],
      ['conversation', task?.conversationId],
      ['task', task?.taskId],
    ];
    const identifier = identifiers.find(([, value]) => String(value || '').trim());
    return identifier ? `${identifier[0]}:${String(identifier[1])}` : '';
  }

  function safeTime(value) {
    const time = new Date(String(value || '')).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function runStartedAt(run) {
    const memberTimes = (Array.isArray(run?.members) ? run.members : [])
      .map((task) => safeTime(task?.createdAt))
      .filter(Boolean);
    if (memberTimes.length) return Math.min(...memberTimes);
    return safeTime(run?.aggregateTask?.createdAt) || safeTime(run?.representative?.createdAt)
      || safeTime(run?.aggregateTask?.updatedAt) || safeTime(run?.representative?.updatedAt);
  }

  function buildRunSequence(runs) {
    const bySession = new Map();
    for (const run of Array.isArray(runs) ? runs : []) {
      const task = run?.aggregateTask || run?.representative;
      const sessionKey = String(task?.sessionId || run?.key || '');
      const sessionRuns = bySession.get(sessionKey) || [];
      sessionRuns.push(run);
      bySession.set(sessionKey, sessionRuns);
    }
    const sequence = new Map();
    for (const sessionRuns of bySession.values()) {
      sessionRuns.sort((left, right) => runStartedAt(left) - runStartedAt(right)
        || String(left?.key || '').localeCompare(String(right?.key || '')));
      sessionRuns.forEach((run, index) => sequence.set(run.key, { index: index + 1, count: sessionRuns.length }));
    }
    return sequence;
  }

  function shortRunId(run) {
    const task = run?.aggregateTask || run?.representative || {};
    const value = String(task.executionId || task.groupId || task.coordinationId || task.taskId || run?.key || '')
      .replace(/^(?:execution|group|coordination|task):/, '')
      .trim();
    if (!value) return '';
    return `#${value.length > 8 ? value.slice(-8) : value}`;
  }

  function userStateForTask(task, context = {}) {
    const status = String(task?.status || 'created');
    const resultDeliveryState = String(task?.resultDeliveryState || '');
    if (resultDeliveryState === 'pending-recovery') {
      return {
        kind: 'pending_recovery', attention: true,
        stateKey: 'run_center.user_state_pending_recovery',
        reasonKey: 'run_center.user_reason_pending_recovery',
        action: 'recover-result', actionKey: 'run_center.recover_result', priority: ATTENTION_STATE_PRIORITY.pending_recovery,
      };
    }
    if (status === 'waiting_user') {
      return {
        kind: 'waiting_user', attention: true,
        stateKey: 'run_center.user_state_waiting_user',
        reasonKey: 'run_center.user_reason_waiting_user',
        action: 'open-task', actionKey: 'run_center.open_task', priority: ATTENTION_STATE_PRIORITY.waiting_user,
      };
    }
    if (context.hasReview || context.hasConflict || ['needs_review', 'blocked'].includes(status)) {
      return {
        kind: 'review', attention: true,
        stateKey: 'run_center.user_state_review',
        reasonKey: context.hasConflict ? 'run_center.user_reason_conflict' : 'run_center.user_reason_review',
        action: 'open-handling', actionKey: 'run_center.open_handling', priority: ATTENTION_STATE_PRIORITY.review,
      };
    }
    if (status === 'recoverable') {
      return {
        kind: 'recoverable', attention: true,
        stateKey: 'run_center.user_state_recoverable',
        reasonKey: 'run_center.user_reason_recoverable',
        action: 'resume', actionKey: 'run_center.resume', priority: ATTENTION_STATE_PRIORITY.recoverable,
      };
    }
    if (status === 'failed') {
      return {
        kind: 'failed', attention: true,
        stateKey: 'run_center.user_state_failed',
        reasonKey: 'run_center.user_reason_failed',
        action: 'retry', actionKey: 'run_center.retry', priority: ATTENTION_STATE_PRIORITY.failed,
      };
    }
    if (task?.column === 'running' || ['created', 'queued', 'pending', 'running'].includes(status)) {
      return {
        kind: 'running', attention: false,
        stateKey: status === 'running' ? 'run_center.user_state_running' : 'run_center.user_state_queued',
        reasonKey: status === 'running' ? 'run_center.user_reason_running' : 'run_center.user_reason_queued',
        action: '', actionKey: '', priority: 10,
      };
    }
    return {
      kind: 'completed', attention: false,
      stateKey: status === 'completed' ? 'run_center.user_state_completed' : 'run_center.user_state_finished',
      reasonKey: status === 'completed' ? 'run_center.user_reason_completed' : 'run_center.user_reason_finished',
      action: '', actionKey: '', priority: 20,
    };
  }

  function displayColumnForTask(task, context = {}) {
    return userStateForTask(task, context).attention ? 'attention' : String(task?.column || 'pending');
  }

  function matchesTimeFilter(task, timeFilter, nowValue) {
    if (!timeFilter || timeFilter === 'all') return true;
    const updatedAt = safeTime(task?.updatedAt);
    if (!updatedAt) return false;
    const now = safeTime(nowValue) || Date.now();
    const windowMs = timeFilter === 'today' ? 24 * 60 * 60 * 1000
      : timeFilter === '7d' ? 7 * 24 * 60 * 60 * 1000
        : timeFilter === '30d' ? 30 * 24 * 60 * 60 * 1000
          : 0;
    return !windowMs || updatedAt >= now - windowMs;
  }

  function safeTaskType(task, options) {
    const titleKey = String(task?.titleKey || '');
    if (titleKey) {
      const label = options.text(titleKey);
      if (label && label !== titleKey) return label;
    }
    const sourceKey = `run_center.task_kind_${String(task?.sourceKind || 'cogseed').replace(/-/g, '_')}`;
    const sourceLabel = options.text(sourceKey);
    if (sourceLabel && sourceLabel !== sourceKey) return sourceLabel;
    return options.text('run_center.task_kind_cogseed');
  }

  function displayRun(run, options, sequence) {
    const task = run?.aggregateTask || run?.representative || {};
    const conversationTitle = typeof options.conversationTitle === 'function'
      ? String(options.conversationTitle(task.conversationId) || '').trim()
      : '';
    const taskType = safeTaskType(task, options);
    const agent = task.agentId && typeof options.agentName === 'function'
      ? String(options.agentName(task.agentId) || '').trim()
      : '';
    const time = typeof options.formatDate === 'function' ? options.formatDate(task.updatedAt) : '';
    const compactId = shortRunId(run);
    const fallbackTitle = [taskType, agent, time, compactId].filter(Boolean).join(' · ');
    return {
      run,
      task,
      title: conversationTitle || fallbackTitle || taskType,
      titleSource: conversationTitle ? 'conversation' : 'fallback',
      taskType,
      agent,
      shortId: compactId,
      sequence: sequence || { index: 1, count: 1 },
      userState: userStateForTask(task, options.context || {}),
    };
  }

  function buildDisplayRuns(runs, options) {
    const sequenceByKey = buildRunSequence(runs);
    return (Array.isArray(runs) ? runs : []).map((run) => displayRun(run, options, sequenceByKey.get(run.key)));
  }

  function orderedMembers(members, parentTaskIds = new Set()) {
    return [...members].sort((left, right) => {
      const parentPreference = Number(parentTaskIds.has(right.taskId)) - Number(parentTaskIds.has(left.taskId));
      if (parentPreference) return parentPreference;
      const updated = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
      return updated || String(left.taskId || '').localeCompare(String(right.taskId || ''));
    });
  }

  function aggregateMembers(members, parentTaskIds = new Set()) {
    const representative = orderedMembers(members, parentTaskIds)[0];
    const updatedAt = members.reduce((latest, task) => {
      const candidate = String(task.updatedAt || '');
      return candidate > latest ? candidate : latest;
    }, '');
    const stateColumns = [...LOGICAL_ACTIVE_STATE_PRIORITY,
      ...(representative.column === 'archived' ? ['archived', 'completed'] : ['completed', 'archived'])];
    const stateTask = stateColumns.map((column) => members
      .filter((task) => task.column === column)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0])
      .find(Boolean) || representative;
    return {
      representative,
      aggregateTask: { ...representative, column: stateTask.column, status: stateTask.status, updatedAt },
    };
  }

  function buildRunModels(projection) {
    const tasks = Array.isArray(projection?.tasks) ? projection.tasks : [];
    const groups = Array.isArray(projection?.groups) ? projection.groups : [];
    const parentTaskIds = new Set(groups
      .map((group) => group.parentTaskId)
      .filter(Boolean));
    const groupById = new Map(groups.flatMap((group) => [
      [group.groupId, group], [group.coordinationId, group],
    ].filter(([id]) => id)));
    const runs = new Map();
    tasks.forEach((task, index) => {
      const key = logicalRunKey(task) || `unidentified:${index}`;
      const members = runs.get(key) || [];
      members.push(task);
      runs.set(key, members);
    });
    return Array.from(runs.entries()).map(([key, members]) => {
      const { representative, aggregateTask } = aggregateMembers(members, parentTaskIds);
      const group = groupById.get(representative.groupId || representative.coordinationId);
      const progress = group && group.parentTaskId === representative.taskId ? group.progress || null : null;
      return { key, representative, aggregateTask, members: [...members], progress };
    });
  }

  function runForTask(projection, taskId) {
    const targetId = String(taskId || '');
    if (!targetId) return null;
    return buildRunModels(projection).find((run) => run.members.some((task) => task.taskId === targetId)) || null;
  }

  function memberMatchesQuery(member, query, agentName) {
    return [member.title, member.taskId, member.sessionTitle, member.sessionId, member.agentId, member.worktreeName,
      typeof agentName === 'function' ? agentName(member.agentId) : '', member.coordinationId, member.groupId,
      member.executionId, member.conversationId]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  }

  function filterRuns(runs, search, filter, includeArchived = false, sourceFilter = 'all', agentName) {
    const options = search && typeof search === 'object'
      ? search
      : { search, filter, includeArchived, sourceFilter, agentName };
    const query = String(options.search || '').trim().toLocaleLowerCase();
    const requestedFilter = options.filter || 'all';
    const includeArchivedRuns = options.includeArchived === true;
    const requestedSource = options.sourceFilter || 'all';
    const requestedAgent = options.agentFilter || 'all';
    const requestedTime = options.timeFilter || 'all';
    return (Array.isArray(runs) ? runs : []).filter((run) => {
      const task = run.aggregateTask;
      if (!task) return false;
      const displayColumn = displayColumnForTask(task);
      if (displayColumn === 'archived' && !includeArchivedRuns) return false;
      if (displayColumn !== 'archived' && !matchesFilter(task, requestedFilter)) return false;
      if (requestedSource !== 'all' && task.sourceKind !== requestedSource) return false;
      if (requestedAgent !== 'all' && String(task.agentId || 'commander') !== requestedAgent) return false;
      if (!matchesTimeFilter(task, requestedTime, options.now)) return false;
      return !query || run.members.some((member) => memberMatchesQuery(member, query, options.agentName));
    });
  }

  function logicalTasks(projection) {
    return buildRunModels(projection).map((run) => run.aggregateTask);
  }

  function filteredLogicalTasks(projection, search, filter, includeArchived = false, sourceFilter = 'all', agentName) {
    return filterRuns(buildRunModels(projection), search, filter, includeArchived, sourceFilter, agentName)
      .map((run) => run.aggregateTask);
  }

  function taskForSession(projection, sessionId, search, filter, sourceFilter = 'all', agentName) {
    return filterRuns(buildRunModels(projection), search, filter, false, sourceFilter, agentName)
      .filter((run) => run.members.some((task) => task.sessionId === sessionId))
      .sort((left, right) => String(right.aggregateTask.updatedAt || '').localeCompare(String(left.aggregateTask.updatedAt || '')))[0]
      ?.aggregateTask || null;
  }

  function render(projection, options) {
    const { text, esc, icon, statusKey, statusClass, formatDate, stateView } = options;
    if (options.loading) return stateView('run_center.board_loading');
    if (options.error) return stateView('run_center.board_failed', options.error);
    const rawTasks = Array.isArray(projection && projection.tasks) ? projection.tasks : [];
    if (!rawTasks.length) return stateView('run_center.board_empty');

    const allRuns = buildRunModels(projection);
    const filterOptions = {
      search: options.search,
      filter: options.filter,
      includeArchived: false,
      sourceFilter: options.sourceFilter,
      agentFilter: options.agentFilter,
      timeFilter: options.timeFilter,
      agentName: options.agentName,
      now: options.now,
    };
    const recentFirst = (left, right) => safeTime(right.aggregateTask?.updatedAt) - safeTime(left.aggregateTask?.updatedAt)
      || String(left.key || '').localeCompare(String(right.key || ''));
    const runs = filterRuns(allRuns, filterOptions).sort(recentFirst);
    const archivedRuns = filterRuns(allRuns, { ...filterOptions, filter: 'all', includeArchived: true })
      .filter((run) => run.aggregateTask.column === 'archived')
      .sort(recentFirst);
    const suppliedSelectedRunKey = String(options.selectedRunKey || '');
    const selectedRunKey = allRuns.some((run) => run.key === suppliedSelectedRunKey)
      ? suppliedSelectedRunKey
      : runForTask(projection, options.selectedTaskId)?.key || '';
    const visibleRuns = [...runs, ...(options.showArchived ? archivedRuns : [])];
    const requestedFocusKey = String(options.focusedRunKey || '');
    const rovingRunKey = visibleRuns.some((run) => run.key === requestedFocusKey)
      ? requestedFocusKey
      : visibleRuns.some((run) => run.key === selectedRunKey)
        ? selectedRunKey
        : visibleRuns[0]?.key || '';
    const localizedTitle = (item, fallback, keyField = 'titleKey') => {
      const key = String(item?.[keyField] || '');
      const label = key ? text(key) : '';
      return label && label !== key ? label : String(item?.title || fallback || '');
    };
    const sequenceByKey = buildRunSequence(allRuns);
    const card = (run) => {
      const task = run.aggregateTask;
      const display = displayRun(run, options, sequenceByKey.get(run.key));
      const progress = run.progress;
      const completePercent = progress && progress.total
        ? Math.round((progress.completed / progress.total) * 100)
        : 0;
      const agentLabel = task.agentId && typeof options.agentName === 'function'
        ? options.agentName(task.agentId)
        : task.agentId;
      const taskTitle = display.title;
      const sessionTitle = task.sessionTitle || task.sessionTitleKey
        ? localizedTitle({ title: task.sessionTitle, titleKey: task.sessionTitleKey }, '')
        : '';
      const genericSessionTitles = new Set([
        text('run_center.conversation_mode_standard'),
        text('run_center.conversation_mode_agent'),
        text('run_center.conversation_mode_group'),
        text('run_center.conversation_mode_legacy'),
      ].map((value) => String(value || '').trim().toLocaleLowerCase()).filter(Boolean));
      const usefulSessionTitle = shouldShowSessionTitle(taskTitle, sessionTitle)
        && !genericSessionTitles.has(String(sessionTitle || '').trim().toLocaleLowerCase());
      const cardMeta = uniqueCardMeta(taskTitle, [
        { icon: 'terminal', value: display.titleSource === 'conversation' ? agentLabel : '' },
        { icon: 'git-branch', value: task.worktreeName },
        { icon: 'git-branch', value: agentLabel ? '' : text(`run_center.source_${task.sourceKind || 'cogseed'}`) },
        { icon: 'panel-list', value: usefulSessionTitle ? sessionTitle : '' },
        { icon: 'refresh', value: text('run_center.run_sequence', display.sequence) },
      ]);
      const selected = run.key === selectedRunKey;
      return `<button type="button" class="dashboard-board-card${selected ? ' is-selected' : ''}" data-dashboard-board-run-key="${esc(run.key)}" data-dashboard-board-task-id="${esc(task.taskId)}" data-dashboard-board-session-id="${esc(task.sessionId)}" tabindex="${run.key === rovingRunKey ? '0' : '-1'}">
        <span class="dashboard-board-card-head">
          <span class="dashboard-status ${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span>
          <time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time>
        </span>
        <strong>${esc(taskTitle)}</strong>
        ${cardMeta.length ? `<span class="dashboard-board-card-meta">${cardMeta.map((item) => `<span>${icon(item.icon)}${esc(item.value)}</span>`).join('')}</span>` : ''}
          ${progress ? `<span class="dashboard-board-group">
          <span><b>${esc(text('run_center.group_progress'))}</b><span>${progress.completed}/${progress.total}</span></span>
          <span class="dashboard-board-progress"><i style="width:${completePercent}%"></i></span>
          ${(progress.failed || progress.attention) ? `<small>${esc(text('run_center.group_attention', { count: progress.failed + progress.attention }))}</small>` : ''}
        </span>` : ''}
      </button>`;
    };
    const columns = COLUMN_KEYS.map((column) => {
      const filteredColumn = COLUMN_KEYS.includes(options.filter) ? options.filter : '';
      const items = runs.filter((run) => displayColumnForTask(run.aggregateTask) === column
        && (!filteredColumn || column === filteredColumn));
      return `<section class="dashboard-board-column${items.length ? '' : ' is-empty'}" data-dashboard-board-column="${column}">
        <header><span class="dashboard-board-column-dot is-${column}"></span><h2>${esc(text(`run_center.column_${column}`))}</h2><span>${items.length}</span></header>
        <div class="dashboard-board-column-list">${items.length ? items.map(card).join('') : `<div class="dashboard-board-column-empty">${esc(text('run_center.column_empty'))}</div>`}</div>
      </section>`;
    }).join('');
    const archived = allRuns.filter((run) => run.aggregateTask.column === 'archived');
    return `<div class="dashboard-board-scroll">
      <div class="dashboard-board-columns${runs.length ? ' has-items' : ''}">${columns}</div>
      ${archived.length ? `<section class="dashboard-board-archive">
        <button type="button" data-dashboard-archive-toggle aria-expanded="${String(options.showArchived)}">
          ${icon(options.showArchived ? 'chevron-down' : 'chevron-right')}
          <span>${esc(text('run_center.archive'))}</span><b>${archived.length}</b>
        </button>
        ${options.showArchived ? `<div class="dashboard-board-archive-list">${archivedRuns.length ? archivedRuns.map(card).join('') : `<div class="dashboard-board-column-empty">${esc(text('run_center.no_matches'))}</div>`}</div>` : ''}
      </section>` : ''}
    </div>`;
  }

  function queueGroups(runs, options = {}) {
    const groups = { attention: [], active: [], completed: [] };
    for (const run of Array.isArray(runs) ? runs : []) {
      const task = run?.aggregateTask || run?.representative;
      if (!task) continue;
      const userState = userStateForTask(task, options.contextForRun?.(run) || {});
      if (userState.attention) groups.attention.push({ run, task, userState });
      else if (['pending', 'running'].includes(displayColumnForTask(task))) groups.active.push({ run, task, userState });
      else groups.completed.push({ run, task, userState });
    }
    const recentFirst = (left, right) => safeTime(right.task.updatedAt) - safeTime(left.task.updatedAt)
      || String(left.run.key || '').localeCompare(String(right.run.key || ''));
    groups.attention.sort((left, right) => left.userState.priority - right.userState.priority || recentFirst(left, right));
    groups.active.sort((left, right) => Number(displayColumnForTask(right.task) === 'running')
      - Number(displayColumnForTask(left.task) === 'running') || recentFirst(left, right));
    groups.completed.sort(recentFirst);
    return groups;
  }

  function renderQueue(runs, options) {
    const { text, esc, icon, formatDate, stateView } = options;
    if (options.loading && !runs?.length) return stateView('run_center.loading');
    if (options.error) return stateView('run_center.load_failed', options.error);
    if (!Array.isArray(runs) || !runs.length) return stateView(options.filtered ? 'run_center.no_matches' : 'run_center.empty');
    const sequenceByKey = buildRunSequence(options.allRuns || runs);
    const groups = queueGroups(runs, options);
    const ordered = [...groups.attention, ...groups.active, ...groups.completed];
    const selectedKey = ordered.some((item) => item.run.key === options.selectedRunKey)
      ? options.selectedRunKey : ordered[0]?.run.key || '';
    const rovingKey = ordered.some((item) => item.run.key === options.focusedRunKey)
      ? options.focusedRunKey : selectedKey;
    const renderItem = ({ run, task, userState }) => {
      const display = displayRun(run, options, sequenceByKey.get(run.key));
      const sequenceLabel = text('run_center.run_sequence', display.sequence);
      const agent = display.agent || text('run_center.commander');
      const selected = run.key === selectedKey;
      return `<button type="button" role="option" aria-selected="${String(selected)}" class="run-center-queue-item${selected ? ' is-selected' : ''}${userState.attention ? ' is-attention' : ''}" data-run-center-queue-run-key="${esc(run.key)}" data-run-center-queue-session="${esc(task.sessionId)}" data-run-center-queue-task="${esc(task.taskId)}" tabindex="${run.key === rovingKey ? '0' : '-1'}">
        <span class="run-center-queue-item-top"><span class="run-center-user-state is-${esc(userState.kind)}">${esc(text(userState.stateKey))}</span><time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time></span>
        <strong>${esc(display.title)}</strong>
        ${userState.attention ? `<span class="run-center-queue-reason">${esc(text(userState.reasonKey))}</span>` : ''}
        <span class="run-center-queue-meta"><span>${esc(sequenceLabel)}</span><span>${icon('terminal')}${esc(agent)}</span>${display.shortId ? `<span>${esc(display.shortId)}</span>` : ''}</span>
        ${userState.actionKey ? `<span class="run-center-queue-recommendation">${esc(text('run_center.recommended_action'))}<b>${esc(text(userState.actionKey))}</b>${icon('chevron-right')}</span>` : ''}
      </button>`;
    };
    const sections = [
      ['attention', 'run_center.queue_attention', groups.attention],
      ['active', 'run_center.queue_active', groups.active],
      ['completed', 'run_center.queue_completed', groups.completed],
    ].filter(([, , items]) => items.length).map(([kind, label, items]) => `<section class="run-center-queue-group is-${kind}">
      <header><h2>${esc(text(label))}</h2><span>${esc(items.length)}</span></header>
      <div class="run-center-queue-list" role="listbox" aria-label="${esc(text(label))}">${items.map(renderItem).join('')}</div>
    </section>`).join('');
    return `<div class="run-center-queue-scroll">${sections}</div>`;
  }

  root.CogSeedRunCenterBoard = Object.freeze({
    COLUMN_KEYS, matchesFilter, filteredTasks, buildRunModels, runForTask, filterRuns,
    filteredLogicalTasks, taskForSession, shouldShowSessionTitle, uniqueCardMeta,
    logicalRunKey, logicalTasks, buildRunSequence, shortRunId, userStateForTask,
    displayColumnForTask, matchesTimeFilter, displayRun, buildDisplayRuns, queueGroups,
    renderQueue, render,
  });
})(window);
