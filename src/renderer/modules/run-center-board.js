// Board rendering is intentionally projection-only. Execution state changes
// remain centralized in the Run Center controller.
(function initCogSeedRunCenterBoard(root) {
  'use strict';

  const COLUMN_KEYS = ['pending', 'running', 'attention', 'completed'];
  // Which base column represents a Run's lifecycle when its members disagree.
  // A different question from the state ranking below — this one picks a member,
  // that one ranks what the user sees — so it keeps its own, single table.
  const LOGICAL_ACTIVE_STATE_PRIORITY = ['attention', 'running', 'pending'];

  /**
   * The one ranking of user-facing run states. Everything that needs to order
   * or compare them reads this: the attention queue's sort, the card's
   * `priority`, and any future consumer. Per-consumer copies are what let the
   * queue sort a retained result last while the card ranked it first.
   *
   * `pending_recovery` outranks `failed`: the result is already retrievable, so
   * acting on it costs nothing, while re-running a failure costs a model call.
   */
  const RUN_STATE_PRIORITY = Object.freeze({
    waiting_user: 0,
    review: 1,
    recoverable: 2,
    pending_recovery: 3,
    failed: 4,
    running: 10,
    completed: 20,
    archived: 20,
  });

  /**
   * The one ranking of raw execution statuses, used where a *task* has to be
   * picked out of a set rather than a user state ranked — currently the attempt
   * representative. Only real `CogSeedTaskStatus` values appear: the previous
   * list also ranked `needs_review`, `blocked`, `pending` and `skipped`, none of
   * which a task can ever hold.
   */
  const EXECUTION_STATE_PRIORITY = Object.freeze({
    failed: 0,
    recoverable: 1,
    waiting_user: 2,
    running: 3,
    queued: 4,
    created: 5,
    completed: 6,
    cancelled: 7,
  });

  // Which failure classes send the user to model setup rather than a retry.
  // These are Main's `failureCategory` values, not producer error codes: the
  // code space is open and every renderer copy of it went stale as soon as a
  // producer added one — that is how an auth failure ended up recommending a
  // retry that could never succeed.
  const MODEL_CONFIGURATION_CATEGORIES = new Set(['model_unavailable', 'provider_error']);

  function requiresModelConfiguration(task) {
    return MODEL_CONFIGURATION_CATEGORIES.has(String(task?.failureCategory || ''));
  }

  /**
   * The lifecycle bucket Main published. `column` is that same value under its
   * old name during the compatibility window — one value, two names, so this is
   * alias resolution rather than a second source. Delete the fallback when the
   * `column` alias is dropped from the projection.
   */
  function baseColumnOf(task) {
    return String(task?.baseColumn || task?.column || 'pending');
  }

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
      // Archival is domain truth and is decided before any presentation
      // derivation, so an attention state can never pull an archived run back
      // into the default list.
      if (baseColumnOf(task) === 'archived' && !includeArchived) return false;
      if (baseColumnOf(task) !== 'archived' && !matchesFilter(task, filter)) return false;
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

  function runState(kind, fields) {
    return {
      kind,
      attention: fields.attention === true,
      // Every state names its own facts. A state that is true about two
      // dimensions at once lists both rather than collapsing them.
      stateKeys: fields.stateKeys,
      stateKey: fields.stateKeys[0],
      reasonKey: fields.reasonKey,
      // Ordered preferences, not permissions. `recommendedAction` intersects
      // them with the action set Main published; the renderer can never offer
      // something Main did not allow.
      actionCandidates: fields.actionCandidates || [],
      action: fields.actionCandidates?.[0]?.action || '',
      actionKey: fields.actionCandidates?.[0]?.actionKey || '',
      priority: RUN_STATE_PRIORITY[kind],
      execution: fields.execution,
      delivery: fields.delivery,
    };
  }

  function userStateForTask(task, context = {}) {
    const status = String(task?.status || 'created');
    const resultDeliveryState = String(task?.resultDeliveryState || '');
    // Two independent facts, kept independent. A crash-recovered run is both
    // failed and holding a retrievable result; forcing a choice between them
    // loses whichever one is not chosen.
    const execution = { kind: status, stateKey: status === 'failed' ? 'run_center.user_state_failed' : '' };
    const delivery = { kind: resultDeliveryState || 'not-applicable' };
    const awaitingRecovery = resultDeliveryState === 'pending-recovery';
    const recoverAction = { action: 'recover-result', actionKey: 'run_center.recover_result' };
    const retryAction = requiresModelConfiguration(task)
      ? { action: 'configure-model', actionKey: 'run_center.configure_model' }
      : { action: 'retry', actionKey: 'run_center.retry' };

    if (baseColumnOf(task) === 'archived') {
      return runState('archived', {
        attention: false, execution, delivery,
        stateKeys: [status === 'failed' ? 'run_center.user_state_failed' : 'run_center.user_state_finished'],
        reasonKey: status === 'failed' ? 'run_center.user_reason_failed' : 'run_center.user_reason_finished',
      });
    }
    if (awaitingRecovery) {
      // A retained result is worth taking back before anything else is tried:
      // it costs nothing, while a retry re-runs the model. When the run also
      // failed, both facts are shown and retry stays available behind it.
      const alsoFailed = status === 'failed';
      return runState('pending_recovery', {
        attention: true, execution, delivery,
        stateKeys: alsoFailed
          ? ['run_center.user_state_failed', 'run_center.user_state_pending_recovery']
          : ['run_center.user_state_pending_recovery'],
        reasonKey: alsoFailed
          ? 'run_center.user_reason_failed_pending_recovery'
          : 'run_center.user_reason_pending_recovery',
        actionCandidates: alsoFailed ? [recoverAction, retryAction] : [recoverAction],
      });
    }
    if (status === 'waiting_user') {
      return runState('waiting_user', {
        attention: true, execution, delivery,
        stateKeys: ['run_center.user_state_waiting_user'],
        reasonKey: 'run_center.user_reason_waiting_user',
        actionCandidates: [{ action: 'open-task', actionKey: 'run_center.open_task' }],
      });
    }
    // Review and conflict are collaboration facts, and they reach this resolver
    // only where a collaboration snapshot was read. No task status expresses
    // them, so there is nothing to test on `status` here.
    if (context.hasReview || context.hasConflict) {
      return runState('review', {
        attention: true, execution, delivery,
        stateKeys: ['run_center.user_state_review'],
        reasonKey: context.hasConflict ? 'run_center.user_reason_conflict' : 'run_center.user_reason_review',
        actionCandidates: [{ action: 'open-handling', actionKey: 'run_center.open_handling' }],
      });
    }
    if (status === 'recoverable') {
      return runState('recoverable', {
        attention: true, execution, delivery,
        stateKeys: ['run_center.user_state_recoverable'],
        reasonKey: 'run_center.user_reason_recoverable',
        actionCandidates: [{ action: 'resume', actionKey: 'run_center.resume' }],
      });
    }
    if (status === 'failed') {
      return runState('failed', {
        attention: true, execution, delivery,
        stateKeys: ['run_center.user_state_failed'],
        reasonKey: 'run_center.user_reason_failed',
        actionCandidates: [retryAction],
      });
    }
    if (baseColumnOf(task) === 'running' || ['created', 'queued', 'running'].includes(status)) {
      return runState('running', {
        attention: false, execution, delivery,
        stateKeys: [status === 'running' ? 'run_center.user_state_running' : 'run_center.user_state_queued'],
        reasonKey: status === 'running' ? 'run_center.user_reason_running' : 'run_center.user_reason_queued',
      });
    }
    return runState('completed', {
      attention: false, execution, delivery,
      stateKeys: [status === 'completed' ? 'run_center.user_state_completed' : 'run_center.user_state_finished'],
      reasonKey: status === 'completed' ? 'run_center.user_reason_completed' : 'run_center.user_reason_finished',
    });
  }

  /**
   * The column a person sees. A thin projection of the run state resolved in
   * `userStateForTask`: anything needing attention is shown there, everything
   * else keeps its lifecycle bucket. It owns no state rules of its own.
   */
  function displayColumnForTask(task, context = {}) {
    return userStateForTask(task, context).attention ? 'attention' : baseColumnOf(task);
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
      ...(baseColumnOf(representative) === 'archived' ? ['archived', 'completed'] : ['completed', 'archived'])];
    const stateTask = stateColumns.map((column) => members
      .filter((task) => baseColumnOf(task) === column)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0])
      .find(Boolean) || representative;
    return {
      representative,
      // The aggregate carries the lifecycle column under both names, from one
      // read, so it behaves exactly like a projected task for every consumer.
      aggregateTask: {
        ...representative,
        baseColumn: baseColumnOf(stateTask),
        column: baseColumnOf(stateTask),
        status: stateTask.status,
        updatedAt,
      },
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
      .filter((run) => baseColumnOf(run.aggregateTask) === 'archived')
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
    const archived = allRuns.filter((run) => baseColumnOf(run.aggregateTask) === 'archived');
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
    if (action === 'retry') return !!set.retry;
    if (action === 'resume') return !!set.resume;
    if (action === 'recover-result') return !!set.recoverResult;
    return false;
  }

  /**
   * Picks the first preference Main actually permits. This is the whole of the
   * renderer's authority over actions: it orders candidates, `taskActions` in
   * Main decides which of them exist at all.
   */
  function recommendedAction(actions, userState, context = {}) {
    const candidates = Array.isArray(userState?.actionCandidates) && userState.actionCandidates.length
      ? userState.actionCandidates
      : [{ action: userState?.action || '', actionKey: userState?.actionKey || '' }];
    return candidates.find((candidate) => recommendedActionAvailable(actions, candidate, context)) || null;
  }

  /** The permitted candidates after the primary, in preference order. */
  function secondaryActions(actions, userState, context = {}) {
    const primary = recommendedAction(actions, userState, context);
    if (!primary) return [];
    return (userState?.actionCandidates || [])
      .filter((candidate) => candidate.action !== primary.action)
      .filter((candidate) => recommendedActionAvailable(actions, candidate, context));
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
        <span class="run-center-queue-item-top"><span class="run-center-user-state is-${esc(userState.kind)}">${esc((userState.stateKeys || [userState.stateKey]).map((key) => text(key)).join(' · '))}</span><time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time></span>
        <strong>${esc(display.title)}</strong>
        ${userState.attention ? `<span class="run-center-queue-reason">${esc(text(userState.reasonKey))}</span>` : ''}
        <span class="run-center-queue-meta"><span>${esc(sequenceLabel)}</span><span>${icon('terminal')}${esc(agent)}</span>${display.shortId ? `<span>${esc(display.shortId)}</span>` : ''}</span>
        ${(() => {
          const recommended = recommendedAction(task.actions, userState, { conversationId: task.conversationId });
          return recommended ? `<span class="run-center-queue-recommendation">${esc(text('run_center.recommended_action'))}<b>${esc(text(recommended.actionKey))}</b>${icon('chevron-right')}</span>` : '';
        })()}
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
    displayColumnForTask, baseColumnOf, matchesTimeFilter, displayRun, buildDisplayRuns, queueGroups,
    recommendedActionAvailable, recommendedAction, secondaryActions,
    requiresModelConfiguration, RUN_STATE_PRIORITY, EXECUTION_STATE_PRIORITY,
    renderQueue, render,
  });
})(window);
