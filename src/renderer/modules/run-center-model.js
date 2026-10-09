// Privacy-safe, dependency-free Run Center projection helpers shared by the
// resident global status surface and the on-demand full Run Center bundle.
(function initCogSeedRunCenterModel(root) {
  'use strict';

  const RUNNING_STATUS = new Set(['created', 'queued', 'pending', 'running']);
  const LOGICAL_ACTIVE_STATE_PRIORITY = ['attention', 'running', 'pending'];

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

  function userStateForTask(task, context = {}) {
    const status = String(task?.status || 'created');
    const delivery = String(task?.resultDeliveryState || '');
    if (task?.column === 'archived') return {
      kind: 'archived', attention: false, action: '', actionKey: '', priority: 20,
      stateKey: status === 'failed' ? 'run_center.user_state_failed' : 'run_center.user_state_finished',
      reasonKey: status === 'failed' ? 'run_center.user_reason_failed' : 'run_center.user_reason_finished',
    };
    if (status === 'planned') return {
      kind: 'planned', attention: false, action: 'start', actionKey: 'run_center.start_planned', priority: 9,
      stateKey: 'run_center.user_state_planned', reasonKey: 'run_center.user_reason_planned',
    };
    if (delivery === 'pending-recovery') return {
      kind: 'pending_recovery', attention: true, action: 'recover-result', actionKey: 'run_center.recover_result', priority: 4,
      stateKey: 'run_center.user_state_pending_recovery', reasonKey: 'run_center.user_reason_pending_recovery',
    };
    if (status === 'waiting_user') return {
      kind: 'waiting_user', attention: true, action: 'open-task', actionKey: 'run_center.open_task', priority: 0,
      stateKey: 'run_center.user_state_waiting_user', reasonKey: 'run_center.user_reason_waiting_user',
    };
    if (context.hasReview || context.hasConflict || ['needs_review', 'blocked'].includes(status)) return {
      kind: 'review', attention: true, action: 'open-handling', actionKey: 'run_center.open_handling', priority: 1,
      stateKey: 'run_center.user_state_review',
      reasonKey: context.hasConflict ? 'run_center.user_reason_conflict' : 'run_center.user_reason_review',
    };
    if (status === 'recoverable') return {
      kind: 'recoverable', attention: true, action: 'resume', actionKey: 'run_center.resume', priority: 2,
      stateKey: 'run_center.user_state_recoverable', reasonKey: 'run_center.user_reason_recoverable',
    };
    if (status === 'failed' || task?.column === 'attention') {
      const configureModel = ['model_preflight', 'provider_error'].includes(String(task?.errorCode || ''));
      return {
        kind: status === 'failed' ? 'failed' : 'review', attention: true,
        action: configureModel ? 'configure-model' : status === 'failed' ? 'retry' : 'open-handling',
        actionKey: configureModel ? 'run_center.configure_model' : status === 'failed' ? 'run_center.retry' : 'run_center.open_handling',
        priority: status === 'failed' ? 3 : 1,
        stateKey: status === 'failed' ? 'run_center.user_state_failed' : 'run_center.user_state_review',
        reasonKey: status === 'failed' ? 'run_center.user_reason_failed' : 'run_center.user_reason_review',
      };
    }
    if (task?.column === 'running' || RUNNING_STATUS.has(status)) return {
      kind: 'running', attention: false, action: '', actionKey: '', priority: 10,
      stateKey: status === 'running' ? 'run_center.user_state_running' : 'run_center.user_state_queued',
      reasonKey: status === 'running' ? 'run_center.user_reason_running' : 'run_center.user_reason_queued',
    };
    return {
      kind: 'completed', attention: false, action: '', actionKey: '', priority: 20,
      stateKey: status === 'completed' ? 'run_center.user_state_completed' : 'run_center.user_state_finished',
      reasonKey: status === 'completed' ? 'run_center.user_reason_completed' : 'run_center.user_reason_finished',
    };
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
    const prioritizedStateTask = stateColumns.map((column) => members
      .filter((task) => task.column === column)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0])
      .find(Boolean) || representative;
    const memberIds = new Set(members.map((task) => task.taskId));
    const hasHierarchy = members.some((task) => parentTaskIds.has(task.taskId))
      || members.some((task) => task.parentTaskId && memberIds.has(task.parentTaskId));
    const stateTask = hasHierarchy ? prioritizedStateTask : representative;
    const unarchivedMembers = members.filter((task) => task.column !== 'archived');
    const canArchive = unarchivedMembers.length > 0
      && unarchivedMembers.every((task) => task.actions?.archive === true);
    const archiveTaskIds = canArchive ? [
      ...unarchivedMembers.filter((task) => task.taskId !== representative.taskId).map((task) => task.taskId),
      ...unarchivedMembers.filter((task) => task.taskId === representative.taskId).map((task) => task.taskId),
    ] : [];
    return {
      representative,
      stateTask,
      archiveTaskIds,
      aggregateTask: {
        ...representative,
        column: stateTask.column,
        status: stateTask.status,
        updatedAt,
        interactionTaskId: stateTask.taskId,
        interactionSessionId: stateTask.sessionId,
        resultDeliveryState: stateTask.resultDeliveryState ?? representative.resultDeliveryState,
        errorCode: stateTask.errorCode,
        actions: { ...(stateTask.actions || representative.actions || {}), archive: canArchive },
      },
    };
  }

  function buildRunModels(projection) {
    const tasks = Array.isArray(projection?.tasks) ? projection.tasks : [];
    const groups = Array.isArray(projection?.groups) ? projection.groups : [];
    const parentTaskIds = new Set(groups.map((group) => group.parentTaskId).filter(Boolean));
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
      const { representative, stateTask, aggregateTask, archiveTaskIds } = aggregateMembers(members, parentTaskIds);
      const group = groupById.get(representative.groupId || representative.coordinationId);
      const progress = group && group.parentTaskId === representative.taskId ? group.progress || null : null;
      return { key, representative, stateTask, aggregateTask, archiveTaskIds, members: [...members], progress };
    });
  }

  function buildGlobalSnapshot(projection, options = {}) {
    const runs = buildRunModels(projection);
    const sequence = buildRunSequence(runs);
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 5;
    const recent = (items) => [...items].sort((left, right) => safeTime(right.aggregateTask?.updatedAt) - safeTime(left.aggregateTask?.updatedAt)
      || String(left.key).localeCompare(String(right.key))).slice(0, limit)
      .map((run) => ({ ...run, sequence: sequence.get(run.key) || { index: 1, count: 1 } }));
    const attention = runs.filter((run) => userStateForTask(run.aggregateTask).attention);
    const running = runs.filter((run) => userStateForTask(run.aggregateTask).kind === 'running');
    const completed = runs.filter((run) => userStateForTask(run.aggregateTask).kind === 'completed');
    return {
      counts: { attention: attention.length, running: running.length, recentCompleted: completed.length },
      attention: recent(attention),
      running: recent(running),
      recentCompleted: recent(completed),
    };
  }

  root.CogSeedRunCenterModel = Object.freeze({
    safeTime,
    logicalRunKey,
    buildRunSequence,
    userStateForTask,
    aggregateMembers,
    buildRunModels,
    buildGlobalSnapshot,
  });
})(window);
