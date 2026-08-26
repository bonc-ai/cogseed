// Board rendering is intentionally projection-only. Execution state changes
// remain centralized in the Run Center controller.
(function initCogSeedRunCenterBoard(root) {
  'use strict';

  const COLUMN_KEYS = ['pending', 'running', 'attention', 'completed'];

  function matchesFilter(task, filter) {
    if (filter === 'running') return task.column === 'running';
    if (filter === 'attention') return task.column === 'attention';
    if (filter === 'completed') return task.column === 'completed';
    return task.column !== 'archived';
  }

  function filteredTasks(projection, search, filter, includeArchived = false) {
    const query = String(search || '').trim().toLocaleLowerCase();
    return (Array.isArray(projection && projection.tasks) ? projection.tasks : []).filter((task) => {
      if (task.column === 'archived' && !includeArchived) return false;
      if (task.column !== 'archived' && !matchesFilter(task, filter)) return false;
      if (!query) return true;
      return [task.title, task.taskId, task.sessionTitle, task.sessionId, task.agentId, task.coordinationId, task.groupId]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
  }

  function render(projection, options) {
    const { text, esc, icon, statusKey, statusClass, formatDate, stateView } = options;
    if (options.loading) return stateView('run_center.board_loading');
    if (options.error) return stateView('run_center.board_failed', options.error);
    const allTasks = Array.isArray(projection && projection.tasks) ? projection.tasks : [];
    if (!allTasks.length) return stateView('run_center.board_empty');

    const tasks = filteredTasks(projection, options.search, options.filter);
    const groupById = new Map((Array.isArray(projection.groups) ? projection.groups : [])
      .map((group) => [group.groupId || group.coordinationId, group]));
    const localizedTitle = (item, fallback, keyField = 'titleKey') => {
      const key = String(item?.[keyField] || '');
      const label = key ? text(key) : '';
      return label && label !== key ? label : String(item?.title || fallback || '');
    };
    const card = (task) => {
      const group = task.groupId && groupById.get(task.groupId);
      const showProgress = group && group.parentTaskId === task.taskId;
      const progress = showProgress ? group.progress : null;
      const completePercent = progress && progress.total
        ? Math.round((progress.completed / progress.total) * 100)
        : 0;
      return `<button type="button" class="dashboard-board-card${task.taskId === options.selectedTaskId ? ' is-selected' : ''}" data-dashboard-board-task-id="${esc(task.taskId)}" data-dashboard-board-session-id="${esc(task.sessionId)}">
        <span class="dashboard-board-card-head">
          <span class="dashboard-status ${statusClass(task.status)}">${esc(text(statusKey(task.status)))}</span>
          <time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time>
        </span>
        <strong>${esc(localizedTitle(task, task.taskId))}</strong>
        <span class="dashboard-board-card-meta">
          ${task.agentId ? `<span>${icon('terminal')}${esc(task.agentId)}</span>` : ''}
          <span>${icon('panel-list')}${esc(localizedTitle({ title: task.sessionTitle, titleKey: task.sessionTitleKey }, task.sessionId))}</span>
        </span>
          ${progress ? `<span class="dashboard-board-group">
          <span><b>${esc(text('run_center.group_progress'))}</b><span>${progress.completed}/${progress.total}</span></span>
          <span class="dashboard-board-progress"><i style="width:${completePercent}%"></i></span>
          ${(progress.failed || progress.attention) ? `<small>${esc(text('run_center.group_attention', { count: progress.failed + progress.attention }))}</small>` : ''}
        </span>` : ''}
      </button>`;
    };
    const visible = new Set(tasks.map((task) => task.taskId));
    const columns = COLUMN_KEYS.map((column) => {
      const items = allTasks.filter((task) => task.column === column && visible.has(task.taskId));
      return `<section class="dashboard-board-column" data-dashboard-board-column="${column}">
        <header><span class="dashboard-board-column-dot is-${column}"></span><h2>${esc(text(`run_center.column_${column}`))}</h2><span>${items.length}</span></header>
        <div class="dashboard-board-column-list">${items.length ? items.map(card).join('') : `<div class="dashboard-board-column-empty">${esc(text('run_center.column_empty'))}</div>`}</div>
      </section>`;
    }).join('');
    const archived = allTasks.filter((task) => task.column === 'archived');
    const archivedTasks = filteredTasks(projection, options.search, 'all', true).filter((task) => task.column === 'archived');
    return `<div class="dashboard-board-scroll">
      <div class="dashboard-board-columns">${columns}</div>
      ${archived.length ? `<section class="dashboard-board-archive">
        <button type="button" data-dashboard-archive-toggle aria-expanded="${String(options.showArchived)}">
          ${icon(options.showArchived ? 'chevron-down' : 'chevron-right')}
          <span>${esc(text('run_center.archive'))}</span><b>${archived.length}</b>
        </button>
        ${options.showArchived ? `<div class="dashboard-board-archive-list">${archivedTasks.length ? archivedTasks.map(card).join('') : `<div class="dashboard-board-column-empty">${esc(text('run_center.no_matches'))}</div>`}</div>` : ''}
      </section>` : ''}
    </div>`;
  }

  root.CogSeedRunCenterBoard = Object.freeze({ COLUMN_KEYS, matchesFilter, filteredTasks, render });
})(window);
