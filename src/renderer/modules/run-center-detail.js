// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Run detail rendering stays projection-only. State transitions and IPC remain
// owned by the Run Center controller.
(function initCogSeedRunCenterDetail(root) {
  'use strict';

  function createRenderer(options) {
    const {
      state, board, text, esc, icon, formatDate, statusKey, statusClass,
      localizedTitle, dynamicLabel, stateView, selectedTask, selectedRunModel,
      agentDisplayName, conversationTitle, displayRunTitle, runSequenceByKey,
    } = options;

    function button(options) {
      return root.uiButton(options);
    }

    function iconButton(options) {
      return root.uiIconButton(options);
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
        ${failureIndex >= 0 ? `<div class="run-center-timeline-tools">${button({
          label: text('run_center.timeline_jump_failure'),
          role: 'secondary',
          size: 'sm',
          icon: 'warning',
          attrs: { 'data-run-center-timeline-jump': true },
        })}</div>` : ''}
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

    function renderCollaboration() {
      if (state.detailError) return stateView('run_center.load_failed', state.detailError);
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
      const actionButton = (action, targetId, label, danger = false) => button({
        label: text(busy === `${action}:${targetId}` ? 'run_center.action_working' : label),
        role: danger ? 'danger' : 'secondary',
        size: 'sm',
        disabled: Boolean(busy),
        loading: busy === `${action}:${targetId}`,
        attrs: {
          'data-run-center-collaboration-action': action,
          'data-run-center-collaboration-target': targetId,
        },
      });
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
        ${state.actionError ? `<div class="run-center-action-feedback is-error" role="alert">${icon('warning')}<span>${esc(state.actionError)}</span></div>` : ''}
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

    function detailModel() {
      const collaboration = state.detail?.collaboration;
      const run = selectedRunModel();
      const selection = board.reconcileAttemptSelection(
        run || { members: [selectedTask()].filter(Boolean) },
        state.selectedAttemptKey,
        state.selectedTaskId,
      );
      const projectedTask = selection.task || selectedTask() || run?.representative;
      const task = collaboration?.task && collaboration.task.taskId === projectedTask?.taskId
        ? collaboration.task : projectedTask;
      const aggregateTask = run?.aggregateTask || task;
      const projectedActions = collaboration?.task && collaboration.task.taskId === task?.taskId
        ? collaboration?.actions || task?.actions || {} : task?.actions || {};
      const actions = {
        ...projectedActions,
        archive: run ? Array.isArray(run.archiveTaskIds) && run.archiveTaskIds.length > 0 : projectedActions.archive === true,
      };
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
      const title = conversationTitle(task.conversationId);
      return title ? text('run_center.destination_named_conversation', { title })
        : text('run_center.destination_conversation');
    }

    function recommendedActionHtml(model, userState, hasCollaboration) {
      const { task, actions } = model;
      const busy = state.busyAction;
      const action = userState.action;
      if (action === 'configure-model') {
        return button({
          label: text(userState.actionKey), role: 'primary', size: 'sm', icon: 'settings',
          attrs: { 'data-run-center-configure-model': true },
        });
      }
      if (action === 'open-task') {
        return button({
          label: text(userState.actionKey), role: 'primary', size: 'sm', icon: 'message-square',
          attrs: { 'data-run-center-open': task?.conversationId || '' },
        });
      }
      if (action === 'open-handling') {
        if (hasCollaboration) return button({
          label: text(userState.actionKey), role: 'primary', size: 'sm', icon: 'users',
          attrs: { 'data-run-center-detail-tab': 'collaboration' },
        });
        return button({
          label: text(userState.actionKey), role: 'primary', size: 'sm', icon: 'message-square',
          attrs: { 'data-run-center-open': task?.conversationId || '' },
        });
      }
      const allowed = board.recommendedActionAvailable(
        actions, userState, { conversationId: task?.conversationId, hasCollaboration },
      );
      if (!allowed) return '';
      const iconName = action === 'start' || action === 'resume' ? 'play-triangle' : 'refresh';
      return button({
        label: text(busy === action ? 'run_center.action_working' : userState.actionKey),
        role: 'primary',
        size: 'sm',
        icon: iconName,
        disabled: Boolean(busy),
        loading: busy === action,
        attrs: { 'data-run-center-action': action },
      });
    }

    function summaryTabHtml(model) {
      const { collaboration, run, task, aggregateTask, actions } = model;
      if (!task || !aggregateTask) return stateView('run_center.select_item');
      const workflow = collaboration?.workflow || {};
      const hasReview = Array.isArray(collaboration?.reviews) && collaboration.reviews.some((item) => !['approved', 'rejected'].includes(item.status));
      const hasConflict = Array.isArray(collaboration?.conflicts) && collaboration.conflicts.some((item) => !['resolved', 'dismissed'].includes(item.status));
      const userState = board.userStateForTask({
        ...aggregateTask,
        resultDeliveryState: task.resultDeliveryState || aggregateTask.resultDeliveryState,
        errorCode: task.errorCode || aggregateTask.errorCode,
      }, { hasReview, hasConflict });
      const hasCollaboration = collaborationAvailable(collaboration, task);
      const destination = resultDestination(task);
      const worktree = task.worktreeName || text('run_center.current_workspace_short');
      const effect = text(`run_center.action_effect_${String(userState.action || 'none').replace(/-/g, '_')}`, { worktree, destination });
      const primaryAction = recommendedActionHtml(model, userState, hasCollaboration);
      const impact = task.errorCode ? text(errorHelpKey(task.errorCode)) : text(userState.reasonKey);
      const progress = run?.progress;
      const isPlanned = aggregateTask.status === 'planned';
      const completion = progress?.total ? Math.round((Number(progress.completed || 0) / Number(progress.total)) * 100) : 0;
      const secondary = [
        actions.abort ? button({
          label: text('run_center.abort'), role: 'danger', size: 'sm', icon: 'stop',
          disabled: Boolean(state.busyAction), attrs: { 'data-run-center-action': 'abort' },
        }) : '',
        actions.archive ? button({
          label: text(state.busyAction === 'archive' ? 'run_center.action_working' : 'run_center.remove_from_list'),
          role: 'secondary', size: 'sm', icon: 'archive', disabled: Boolean(state.busyAction),
          loading: state.busyAction === 'archive', attrs: { 'data-run-center-action': 'archive' },
        }) : '',
        !isPlanned ? button({
          label: text('run_center.run_with_agent'), role: 'secondary', size: 'sm', icon: 'refresh',
          attrs: { 'data-run-center-reassign': true },
        }) : '',
        !isPlanned && userState.action !== 'open-task' ? button({
          label: text('run_center.open_task'), role: 'secondary', size: 'sm', icon: 'message-square',
          attrs: { 'data-run-center-open': task.conversationId || '' },
        }) : '',
      ].filter(Boolean).join('');
      return `<div class="run-center-summary-flow">
        ${state.actionNotice ? `<div class="run-center-action-feedback is-success" role="status">${icon('check-circle')}<span>${esc(text(state.actionNotice))}</span></div>` : ''}
        ${state.actionError ? `<div class="run-center-action-feedback is-error" role="alert">${icon('warning')}<span>${esc(state.actionError)}</span></div>` : ''}
        <section class="run-center-summary-row is-event"><span class="run-center-summary-row-icon">${icon(userState.attention ? 'warning' : userState.kind === 'running' ? 'activity' : 'check-circle')}</span><div><small>${esc(text('run_center.summary_what_happened'))}</small><h3>${esc(text(userState.stateKey))}</h3><p>${esc(text(userState.reasonKey))}</p></div></section>
        <section class="run-center-summary-row"><span class="run-center-summary-row-icon">${icon('activity')}</span><div><small>${esc(text('run_center.summary_impact'))}</small><h3>${esc(userState.attention ? text('run_center.summary_attention_impact') : text('run_center.summary_no_blocking_impact'))}</h3><p>${esc(impact)}</p>${progress?.total ? `<div class="run-center-inspector-progress"><span><b>${esc(text('run_center.group_progress'))}</b><strong>${esc(progress.completed)}/${esc(progress.total)}</strong></span><progress value="${completion}" max="100">${completion}%</progress></div>` : ''}</div></section>
        <section class="run-center-summary-row is-action"><span class="run-center-summary-row-icon">${icon('play-triangle')}</span><div><small>${esc(text('run_center.summary_next_action'))}</small><h3>${esc(primaryAction ? text(userState.actionKey) : text('run_center.no_action_required'))}</h3><p>${esc(effect)}</p><div class="run-center-summary-actions">${primaryAction}${secondary}</div></div></section>
        <section class="run-center-summary-row"><span class="run-center-summary-row-icon">${icon('send')}</span><div><small>${esc(text('run_center.summary_destination'))}</small><h3>${esc(destination)}</h3><p>${esc(text('run_center.summary_destination_detail'))}</p></div></section>
        <dl class="run-center-summary-context"><div><dt>${esc(text('run_center.label_agent'))}</dt><dd>${esc(agentDisplayName(task.agentId) || text('run_center.commander'))}</dd></div><div><dt>${esc(text('run_center.label_execution_source'))}</dt><dd>${esc(text(`run_center.source_${task.sourceKind || 'cogseed'}`))}</dd></div><div><dt>${esc(text('run_center.label_worktree'))}</dt><dd>${esc(worktree)}</dd></div><div><dt>${esc(text('run_center.label_updated'))}</dt><dd>${esc(formatDate(task.updatedAt))}</dd></div>${workflow.phase ? `<div><dt>${esc(text('run_center.label_phase'))}</dt><dd>${esc(workflow.phase)}</dd></div>` : ''}</dl>
      </div>`;
    }

    function historyTabHtml(model) {
      const { collaboration, selection } = model;
      const attempts = selection.attempts;
      const selectedAttempt = selection.selected;
      const selectedAttemptIndex = attempts.findIndex((attempt) => attempt.key === selectedAttempt?.key);
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
        return `<li role="presentation"><button type="button" id="run-center-attempt-tab-${index}" role="tab" aria-controls="run-center-attempt-panel" aria-selected="${String(selected)}" class="run-center-attempt${selected ? ' is-selected' : ''}" data-run-center-attempt-index="${index}" tabindex="${attempt.key === focusKey ? '0' : '-1'}"><span class="run-center-attempt-main"><span class="run-center-attempt-index">${esc(ordinal)}</span><span class="${statusClass(attempt.status)}">${esc(text(statusKey(attempt.status)))}</span></span><span class="run-center-attempt-badges">${badges}</span><span class="run-center-attempt-meta"><time datetime="${esc(attempt.updatedAt)}">${esc(formatDate(attempt.updatedAt))}</time><small>${icon('terminal')}${esc(agentDisplayName(task.agentId) || text('run_center.commander'))}</small></span></button></li>`;
      }).join('');
      const timeline = Array.isArray(collaboration?.timeline) ? collaboration.timeline : [];
      const tasks = Array.isArray(collaboration?.tasks) ? collaboration.tasks : [];
      return `<div class="run-center-history">
        <section><header><div><h3>${esc(text('run_center.history_runs'))}</h3><p>${esc(text('run_center.history_runs_detail'))}</p></div><span>${esc(attempts.length)}</span></header>${attempts.length ? `<ol class="run-center-attempt-list" role="tablist" aria-label="${esc(text('run_center.inspector_attempts'))}">${rows}</ol>` : stateView('run_center.tasks_empty')}</section>
        <section id="run-center-attempt-panel" role="tabpanel"${selectedAttemptIndex >= 0 ? ` aria-labelledby="run-center-attempt-tab-${selectedAttemptIndex}"` : ''}><header><div><h3>${esc(text('run_center.timeline'))}</h3><p>${esc(text('run_center.history_timeline_detail'))}</p></div><span>${esc(timeline.length)}</span></header>${timelineHtml(timeline, tasks)}</section>
      </div>`;
    }

    function renderDetails() {
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
      const content = state.detailError
        ? stateView('run_center.load_failed', state.detailError)
        : !state.detail && state.selectedSessionId
          ? stateView('run_center.loading_detail')
        : activeTab === 'history' ? historyTabHtml(model)
          : activeTab === 'collaboration' ? renderCollaboration()
            : summaryTabHtml(model);
      const back = iconButton({
        label: text('run_center.back_to_runs'),
        icon: 'chevron-left',
        className: 'run-center-detail-back',
        attrs: { 'data-run-center-detail-back': true },
      });
      const openTask = iconButton({
        label: text('run_center.open_task'),
        icon: 'message-square',
        className: 'run-center-icon-btn',
        attrs: { 'data-run-center-open': task?.conversationId || '' },
      });
      const close = state.runMode === 'board' ? iconButton({
        label: text('common.close'),
        icon: 'x',
        className: 'run-center-icon-btn run-center-detail-close',
        attrs: { 'data-run-center-detail-close': true },
      }) : '';
      return `<div class="run-center-run-detail" aria-live="polite" aria-busy="${String(!state.detail && !!state.selectedSessionId)}">
        <header class="run-center-run-detail-header">${back}<div><span class="${statusClass(aggregateTask.status)}">${esc(text(statusKey(aggregateTask.status)))}</span><h2>${esc(displayRunTitle(run, aggregateTask))}</h2><p>${esc(sequenceLabel)} · ${esc(agentDisplayName(task?.agentId) || text('run_center.commander'))} · ${esc(formatDate(aggregateTask.updatedAt))}</p></div><span class="run-center-detail-actions">${openTask}${close}</span></header>
        <div class="run-center-detail-tabs" role="tablist" aria-orientation="horizontal" aria-label="${esc(text('run_center.run_detail'))}">${tabs.map(([tab, key]) => `<button type="button" id="run-center-detail-tab-${tab}" role="tab" aria-controls="run-center-detail-panel" aria-selected="${String(activeTab === tab)}" tabindex="${activeTab === tab ? '0' : '-1'}" class="${activeTab === tab ? 'is-active' : ''}" data-run-center-detail-tab="${tab}">${esc(text(key))}</button>`).join('')}</div>
        <div class="run-center-detail-content" id="run-center-detail-panel" role="tabpanel" aria-labelledby="run-center-detail-tab-${activeTab}" data-run-center-scroll-key="detail">${content}</div>
      </div>`;
    }

    return Object.freeze({ renderCollaboration, renderDetails });
  }

  root.CogSeedRunCenterDetail = Object.freeze({ createRenderer });
})(window);
