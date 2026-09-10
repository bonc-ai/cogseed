// Board rendering is intentionally projection-only. Execution state changes
// remain centralized in the Run Center controller.
(function initCogSeedRunCenterBoard(root) {
  'use strict';

  const COLUMN_KEYS = ['pending', 'running', 'attention', 'completed'];
  // The resident model is loaded before this lazy bundle. Keep a single
  // implementation of run identity, aggregation, sequence and user state.
  const { logicalRunKey, safeTime, buildRunSequence, userStateForTask, buildRunModels } = root.CogSeedRunCenterModel;

  function matchesFilter(task, filter) {
    const column = displayColumnForTask(task);
    if (filter === 'pending') return column === 'pending';
    if (filter === 'running') return column === 'running';
    if (filter === 'attention') return column === 'attention';
    if (filter === 'completed') return column === 'completed';
    return column !== 'archived';
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

  function failureCategory(errorCode) {
    if (!errorCode) return 'none';
    if (errorCode === 'model_preflight') return 'model';
    if (errorCode === 'provider_error') return 'provider';
    if (errorCode === 'group_chat_run_failed') return 'collaboration';
    return 'other';
  }

  function shortRunId(run) {
    const task = run?.aggregateTask || run?.representative || {};
    const value = String(task.executionId || task.groupId || task.coordinationId || task.taskId || run?.key || '')
      .replace(/^(?:execution|group|coordination|task):/, '')
      .trim();
    if (!value) return '';
    return `#${value.length > 8 ? value.slice(-8) : value}`;
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

  function quickArchiveButton(task, options) {
    if (!task?.actions?.archive) return '';
    const { text } = options;
    const targetTaskId = task.interactionTaskId || task.taskId;
    const busy = !!options.busyAction;
    const working = busy && options.busyTaskId === targetTaskId;
    const label = text(working ? 'run_center.action_working' : 'run_center.remove_from_list');
    return root.uiIconButton?.({
      label,
      icon: working ? 'loader' : 'archive',
      disabled: busy,
      className: `run-center-quick-archive${working ? ' is-loading' : ''}`,
      attrs: { 'data-run-center-quick-archive': targetTaskId },
    }) || '';
  }

  function render(projection, options) {
    const { text, esc, icon, statusKey, statusClass, formatDate, stateView } = options;
    if (options.loading) return stateView('run_center.board_loading');
    if (options.error) return stateView('run_center.board_failed', options.error);
    const rawTasks = Array.isArray(projection && projection.tasks) ? projection.tasks : [];
    if (!rawTasks.length) return stateView('run_center.board_empty');

    const allRuns = Array.isArray(options.runModels) ? options.runModels : buildRunModels(projection);
    const conversationId = String(options.conversationId || '').trim();
    const matchesConversation = (run) => !conversationId
      || run.members.some((task) => String(task.conversationId || '') === conversationId);
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
    const runs = (Array.isArray(options.filteredRuns)
      ? [...options.filteredRuns]
      : filterRuns(allRuns, filterOptions).filter(matchesConversation)).sort(recentFirst);
    const archivedRuns = (Array.isArray(options.archivedRuns)
      ? [...options.archivedRuns]
      : filterRuns(allRuns, { ...filterOptions, filter: 'all', includeArchived: true })
        .filter(matchesConversation)
        .filter((run) => run.aggregateTask.column === 'archived'))
      .sort(recentFirst);
    const suppliedSelectedRunKey = String(options.selectedRunKey || '');
    const selectedRunKey = allRuns.some((run) => run.key === suppliedSelectedRunKey)
      ? suppliedSelectedRunKey
      : allRuns.find((run) => run.members.some((task) => task.taskId === options.selectedTaskId))?.key || '';
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
    const sequenceByKey = options.sequenceByKey instanceof Map
      ? options.sequenceByKey : buildRunSequence(allRuns);
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
      const interactionTaskId = task.interactionTaskId || task.taskId;
      const interactionSessionId = task.interactionSessionId || task.sessionId;
      return `<div class="dashboard-board-card-shell">
        <button type="button" class="dashboard-board-card${selected ? ' is-selected' : ''}" data-dashboard-board-run-key="${esc(run.key)}" data-dashboard-board-task-id="${esc(interactionTaskId)}" data-dashboard-board-session-id="${esc(interactionSessionId)}" tabindex="${run.key === rovingRunKey ? '0' : '-1'}">
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
        </button>
        ${quickArchiveButton(task, options)}
      </div>`;
    };
    const filteredColumn = COLUMN_KEYS.includes(options.filter) ? options.filter : '';
    const columns = COLUMN_KEYS.map((column) => {
      const items = runs.filter((run) => displayColumnForTask(run.aggregateTask) === column
        && (!filteredColumn || column === filteredColumn));
      if (filteredColumn && filteredColumn !== column) return '';
      return `<section class="dashboard-board-column${items.length ? '' : ' is-empty'}" data-dashboard-board-column="${column}">
        <header><span class="dashboard-board-column-dot is-${column}"></span><h2>${esc(text(`run_center.column_${column}`))}</h2><span>${items.length}</span></header>
        <div class="dashboard-board-column-list" data-run-center-scroll-key="board-column:${column}">${items.length ? items.map(card).join('') : `<div class="dashboard-board-column-empty">${esc(text('run_center.column_empty'))}</div>`}</div>
      </section>`;
    }).join('');
    const archived = allRuns.filter((run) => run.aggregateTask.column === 'archived');
    return `<div class="dashboard-board-scroll" data-run-center-scroll-key="board">
      <div class="dashboard-board-columns${runs.length ? ' has-items' : ''}">${columns}</div>
      ${archived.length ? `<section class="dashboard-board-archive">
        <div class="dashboard-board-archive-header"><button type="button" data-dashboard-archive-toggle aria-expanded="${String(options.showArchived)}">
          ${icon(options.showArchived ? 'chevron-down' : 'chevron-right')}
          <span>${esc(text('run_center.archive'))}</span><b>${archived.length}</b>
        </button>${root.uiButton?.({
          label: text(options.busyAction === 'purge-archived' ? 'run_center.action_working' : 'run_center.purge_archived'),
          role: 'danger',
          size: 'sm',
          icon: options.busyAction === 'purge-archived' ? 'loader' : 'trash-2',
          loading: options.busyAction === 'purge-archived',
          disabled: !!options.busyAction,
          className: 'run-center-purge-archived',
          attrs: { 'data-run-center-purge-archived': true },
        }) || ''}</div>
        ${options.showArchived ? `<div class="dashboard-board-archive-list">${archivedRuns.length ? archivedRuns.map(card).join('') : `<div class="dashboard-board-column-empty">${esc(text('run_center.no_matches'))}</div>`}</div>` : ''}
      </section>` : ''}
    </div>`;
  }

  // A recommended action is only worth showing when the projection actually
  // offers it. The queue and the run detail pane both gate on this; when they
  // drifted apart a restart-orphaned card recommended "Resume" in the list
  // while the detail pane rendered no button at all.
  function recommendedActionAvailable(actions, userState, context = {}) {
    const action = String(userState?.action || '');
    if (!action) return false;
    const set = actions || {};
    if (action === 'configure-model') return true;
    if (action === 'open-task') return !!context.conversationId;
    if (action === 'open-handling') return !!context.hasCollaboration || !!context.conversationId;
    if (action === 'start') return !!set.start;
    if (action === 'retry') return !!set.retry;
    if (action === 'resume') return !!set.resume;
    if (action === 'recover-result') return !!set.recoverResult;
    return false;
  }

  function queueGroups(runs, options = {}) {
    const groups = { attention: [], planned: [], active: [], completed: [] };
    for (const run of Array.isArray(runs) ? runs : []) {
      const task = run?.aggregateTask || run?.representative;
      if (!task) continue;
      const userState = userStateForTask(task, options.contextForRun?.(run) || {});
      if (userState.attention) groups.attention.push({ run, task, userState });
      else if (task.status === 'planned') groups.planned.push({ run, task, userState });
      else if (['pending', 'running'].includes(displayColumnForTask(task))) groups.active.push({ run, task, userState });
      else groups.completed.push({ run, task, userState });
    }
    const recentFirst = (left, right) => safeTime(right.task.updatedAt) - safeTime(left.task.updatedAt)
      || String(left.run.key || '').localeCompare(String(right.run.key || ''));
    groups.attention.sort((left, right) => left.userState.priority - right.userState.priority || recentFirst(left, right));
    groups.planned.sort(recentFirst);
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
    const sequenceByKey = options.sequenceByKey instanceof Map
      ? options.sequenceByKey : buildRunSequence(options.allRuns || runs);
    const groups = queueGroups(runs, options);
    const ordered = [...groups.attention, ...groups.planned, ...groups.active, ...groups.completed];
    const selectedKey = ordered.some((item) => item.run.key === options.selectedRunKey)
      ? options.selectedRunKey : ordered[0]?.run.key || '';
    const rovingKey = ordered.some((item) => item.run.key === options.focusedRunKey)
      ? options.focusedRunKey : selectedKey;
    const renderItem = ({ run, task, userState }) => {
      const display = displayRun(run, options, sequenceByKey.get(run.key));
      const sequenceLabel = text('run_center.run_sequence', display.sequence);
      const agent = display.agent || text('run_center.commander');
      const selected = run.key === selectedKey;
      const interactionTaskId = task.interactionTaskId || task.taskId;
      const interactionSessionId = task.interactionSessionId || task.sessionId;
      return `<div class="run-center-queue-item-shell" role="listitem">
        <button type="button" aria-current="${selected ? 'true' : 'false'}" class="run-center-queue-item${selected ? ' is-selected' : ''}${userState.attention ? ' is-attention' : ''}" data-run-center-queue-run-key="${esc(run.key)}" data-run-center-queue-session="${esc(interactionSessionId)}" data-run-center-queue-task="${esc(interactionTaskId)}" tabindex="${run.key === rovingKey ? '0' : '-1'}">
        <span class="run-center-queue-item-top"><span class="run-center-user-state is-${esc(userState.kind)}">${esc(text(userState.stateKey))}</span><time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time></span>
        <strong>${esc(display.title)}</strong>
        ${userState.attention ? `<span class="run-center-queue-reason">${esc(text(userState.reasonKey))}</span>` : ''}
        <span class="run-center-queue-meta"><span>${esc(sequenceLabel)}</span><span>${icon('terminal')}${esc(agent)}</span>${display.shortId ? `<span>${esc(display.shortId)}</span>` : ''}</span>
        ${userState.actionKey && recommendedActionAvailable(task.actions, userState, { conversationId: task.conversationId }) ? `<span class="run-center-queue-recommendation">${esc(text('run_center.recommended_action'))}<b>${esc(text(userState.actionKey))}</b>${icon('chevron-right')}</span>` : ''}
        </button>
        ${quickArchiveButton(task, options)}
      </div>`;
    };
    const sections = [
      ['attention', 'run_center.queue_attention', groups.attention],
      ['planned', 'run_center.queue_planned', groups.planned],
      ['active', 'run_center.queue_active', groups.active],
      ['completed', 'run_center.queue_completed', groups.completed],
    ].filter(([, , items]) => items.length).map(([kind, label, items]) => `<section class="run-center-queue-group is-${kind}">
      <header><h2>${esc(text(label))}</h2><span>${esc(items.length)}</span></header>
      <div class="run-center-queue-list" role="list" aria-label="${esc(text(label))}">${items.map(renderItem).join('')}</div>
    </section>`).join('');
    return `<div class="run-center-queue-scroll" data-run-center-scroll-key="queue">${sections}</div>`;
  }

  root.CogSeedRunCenterBoard = Object.freeze({
    COLUMN_KEYS, matchesFilter, buildRunModels, runForTask, filterRuns,
    shouldShowSessionTitle, uniqueCardMeta, logicalRunKey, buildRunSequence, shortRunId, userStateForTask,
    buildAttemptModels, reconcileAttemptSelection, failureCategory,
    displayColumnForTask, matchesTimeFilter, displayRun, queueGroups,
    recommendedActionAvailable, quickArchiveButton, renderQueue, render,
  });
})(window);
