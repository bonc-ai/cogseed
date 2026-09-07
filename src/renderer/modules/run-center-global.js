// Resident Run Center entry point. It only consumes the privacy-filtered task
// projection and deliberately stays independent from the full lazy bundle.
(function initCogSeedRunCenterGlobal(root) {
  'use strict';

  const model = root.CogSeedRunCenterModel;
  const state = {
    snapshot: null,
    loading: false,
    refreshing: false,
    stale: false,
    dataState: 'idle',
    error: '',
    open: false,
    bound: false,
    watch: null,
    refreshTimer: null,
    refreshInFlight: null,
    refreshQueued: false,
  };

  function label(key, fallback, vars) {
    try {
      const value = typeof root.t === 'function' ? root.t(key, vars) : key;
      return value && value !== key ? value : fallback;
    } catch (_) { return fallback; }
  }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function invoke(channel, payload) {
    if (!root.cogseed?.invoke) return Promise.reject(new Error(label('run_center.ipc_unavailable', 'Run Center is unavailable')));
    return root.cogseed.invoke(channel, payload || {}).then((result) => {
      if (result?.ok === false) throw new Error(result.error || label('run_center.load_failed', 'Could not load Run Center'));
      return result;
    });
  }
  function formatDate(value) {
    const date = new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return label('run_center.unknown_time', 'Unknown time');
    return new Intl.DateTimeFormat(typeof root.getLang === 'function' ? root.getLang() : undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }
  function icon(name) {
    return typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name) : '';
  }
  function sharedButton(options) {
    return typeof root.uiButton === 'function' ? root.uiButton(options) : '';
  }
  function sharedIconButton(options) {
    return typeof root.uiIconButton === 'function' ? root.uiIconButton(options) : '';
  }
  function sharedEmptyState(options) {
    return typeof root.uiEmptyState === 'function' ? root.uiEmptyState(options) : '';
  }
  function panel() { return document.getElementById('run-center-quick-panel'); }
  function ensureButton() {
    let trigger = document.getElementById('run-center-global-btn');
    if (trigger) return trigger;
    const host = document.getElementById('run-center-global-entry');
    if (!host) return null;
    host.innerHTML = sharedIconButton({
      label: label('run_center.global_title', '运行与协作'),
      icon: 'activity',
      className: 'run-center-global-btn',
      attrs: {
        id: 'run-center-global-btn',
        title: label('run_center.global_title', '运行与协作'),
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'aria-controls': 'run-center-quick-panel',
      },
    });
    trigger = host.querySelector?.('#run-center-global-btn') || document.getElementById('run-center-global-btn');
    if (!trigger) return null;
    const badge = document.createElement('span');
    badge.className = 'run-center-global-badge';
    badge.id = 'run-center-global-badge';
    badge.hidden = true;
    badge.setAttribute('aria-hidden', 'true');
    trigger.appendChild(badge);
    return trigger;
  }
  function button() { return document.getElementById('run-center-global-btn') || ensureButton(); }
  function syncButtonLabel(trigger) {
    const value = label('run_center.global_title', '运行与协作');
    if (trigger) trigger.title = value;
  }
  function taskTitle(task) {
    const key = String(task?.titleKey || '');
    const localized = key && typeof root.t === 'function' ? root.t(key) : '';
    return localized && localized !== key ? localized : String(task?.title || task?.taskId || label('run_center.untitled_task', 'Untitled task'));
  }
  function agentName(task) {
    const id = String(task?.agentId || '').trim();
    if (!id || id === 'commander') return label('run_center.commander', 'Commander');
    return id;
  }
  function runMeta(run) {
    const sequence = run?.sequence;
    if (sequence) {
      return label('run_center.run_sequence', `Run ${sequence.index}/${sequence.count}`, sequence);
    }
    const task = run?.aggregateTask || run?.representative || {};
    const id = String(task.executionId || task.groupId || task.coordinationId || task.taskId || '').trim();
    const compact = id.length > 8 ? id.slice(-8) : id;
    return compact ? `#${compact}` : label('run_center.run_sequence', 'Run');
  }
  function ensurePanel() {
    let target = panel();
    if (target) return target;
    target = document.createElement('div');
    target.id = 'run-center-quick-panel';
    target.className = 'run-center-quick-panel';
    target.hidden = true;
    target.setAttribute('role', 'dialog');
    target.setAttribute('aria-labelledby', 'run-center-quick-title');
    // Portal outside the sidebar/main overflow boundaries, while anchoring to
    // the sidebar trigger. Page navigation closes this non-modal popover.
    document.body.appendChild(target);
    return target;
  }
  function positionPanel() {
    const target = panel();
    const rect = button()?.getBoundingClientRect?.();
    if (!state.open || !target || !rect) return;
    const margin = 12;
    const width = Math.min(390, root.innerWidth - margin * 2);
    const top = Math.min(rect.bottom + 8, root.innerHeight - margin);
    target.style.left = `${Math.max(margin, Math.min(rect.left, root.innerWidth - width - margin))}px`;
    target.style.top = `${top}px`;
    target.style.maxHeight = `${Math.max(0, Math.min(680, root.innerHeight - top - margin))}px`;
  }
  function sectionHtml(kind, title, items, filter) {
    const rows = items.map((run) => {
      const task = run?.aggregateTask || run?.representative || {};
      const cid = String(task.conversationId || '');
      const itemTitle = taskTitle(task);
      const actionLabel = cid
        ? `${label('run_center.open_task', 'Open task')}: ${itemTitle}`
        : label('run_center.task_unavailable', 'Task details are unavailable');
      const action = sharedIconButton({
        label: actionLabel,
        icon: 'arrow-right',
        className: 'run-center-quick-item-action',
        attrs: {
          'data-run-center-global-task': true,
          'data-run-center-global-conversation-id': cid,
          'data-run-center-global-run-key': run.key,
        },
      });
      return `<article class="run-center-quick-item">
        <span class="run-center-quick-item-icon">${icon(kind === 'attention' ? 'warning' : kind === 'running' ? 'loader' : 'check')}</span>
        <span class="run-center-quick-item-copy"><strong>${esc(itemTitle)}</strong><span>${esc(runMeta(run))} · ${esc(agentName(task))}</span></span>
        <time datetime="${esc(task.updatedAt)}">${esc(formatDate(task.updatedAt))}</time>
        ${action}
      </article>`;
    }).join('');
    const empty = `<div class="run-center-quick-empty">${sharedEmptyState({
      kind: 'quiet',
      title: label(`run_center.global_empty_${kind}`, 'Nothing here yet'),
    })}</div>`;
    const viewAll = sharedButton({
      label: label('run_center.global_view_all', 'View all'),
      role: 'ghost',
      size: 'sm',
      className: 'run-center-quick-view-all',
      attrs: { 'data-run-center-global-view-all': filter },
    });
    return `<section class="run-center-quick-section is-${esc(kind)}"><header><h2>${esc(title)}</h2>${viewAll}</header>${rows || empty}</section>`;
  }
  function render() {
    const target = ensurePanel();
    const trigger = button();
    syncButtonLabel(trigger);
    trigger?.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    target.setAttribute('aria-busy', String(state.loading || state.refreshing));
    target.dataset.loadState = state.dataState;
    const snapshot = state.snapshot || { attention: [], running: [], recentCompleted: [], counts: {} };
    const counts = snapshot.counts || {};
    const badge = document.getElementById('run-center-global-badge');
    const attentionCount = Number(counts.attention || 0);
    const runningCount = Number(counts.running || 0);
    const countLabel = attentionCount
      ? label('run_center.global_attention_count', `${attentionCount} need attention`, { count: attentionCount })
      : runningCount ? label('run_center.global_running_count', `${runningCount} running`, { count: runningCount }) : '';
    trigger?.setAttribute('aria-label', [label('run_center.global_title', '运行与协作'), countLabel].filter(Boolean).join(' · '));
    if (badge) {
      badge.hidden = attentionCount === 0 && runningCount === 0;
      const count = attentionCount || runningCount;
      badge.textContent = count > 99 ? '99+' : String(count || '');
      badge.dataset.state = attentionCount ? 'attention' : runningCount ? 'running' : 'idle';
    }
    if (!state.open) { target.hidden = true; return; }
    // Refresh replaces safe rows. Preserve the focused action only if its
    // complete identity still exists; never transfer it to a different task.
    const focused = target.contains?.(document.activeElement) ? document.activeElement : null;
    const focusData = focused ? Object.entries(focused.dataset || {}) : [];
    target.hidden = false;
    const close = sharedIconButton({
      label: label('common.close', 'Close'),
      icon: 'x',
      className: 'run-center-global-close',
      attrs: { 'data-run-center-global-close': true },
    });
    const create = sharedButton({
      label: label('run_center.create_task', '新建任务'),
      role: 'secondary',
      size: 'sm',
      icon: 'plus',
      attrs: { 'data-run-center-global-create': true },
    });
    const viewAllTasks = sharedButton({
      label: label('run_center.global_view_all_tasks', '查看全部任务'),
      role: 'primary',
      size: 'sm',
      iconEnd: 'arrow-right',
      attrs: { 'data-run-center-global-view-all': 'all' },
    });
    const retry = state.error ? sharedButton({
      label: label('run_center.retry_load', 'Try again'),
      role: 'ghost',
      size: 'sm',
      icon: 'refresh',
      attrs: { 'data-run-center-global-retry': true },
    }) : '';
    const status = state.loading ? label('common.loading', 'Loading…')
      : state.refreshing ? label('run_center.refreshing', 'Refreshing…')
        : state.stale ? label('run_center.data_stale_short', 'Showing recent data')
          : label('run_center.global_subtitle', 'Task status at a glance');
    target.innerHTML = `<header class="run-center-quick-header"><div><strong id="run-center-quick-title">${esc(label('run_center.global_title', '运行与协作'))}</strong><span>${esc(status)}</span></div>${close}</header>
      ${state.error ? `<div class="run-center-quick-error${state.stale ? ' is-stale' : ''}" role="${state.stale ? 'status' : 'alert'}" aria-live="polite"><span>${esc(state.stale ? label('run_center.data_stale', `Showing the latest safe data. Refresh failed: ${state.error}`, { error: state.error }) : state.error)}</span>${retry}</div>` : ''}
      ${sectionHtml('attention', label('run_center.global_attention', '需处理'), snapshot.attention, 'attention')}
      ${sectionHtml('running', label('run_center.global_running', '正在运行'), snapshot.running, 'running')}
      ${sectionHtml('completed', label('run_center.global_recent_completed', '最近完成'), snapshot.recentCompleted, 'completed')}
      <footer class="run-center-quick-footer">${create}${viewAllTasks}</footer>`;
    if (typeof root.hydrateUiIcons === 'function') root.hydrateUiIcons(target);
    positionPanel();
    if (focused) {
      const replacement = focusData.length && Array.from(target.querySelectorAll('button')).find((candidate) =>
        focusData.every(([key, value]) => candidate.dataset[key] === value));
      (replacement || target.querySelector('[data-run-center-global-close]'))?.focus();
    }
  }
  function scheduleRefresh() {
    if (state.refreshTimer) root.clearTimeout(state.refreshTimer);
    state.refreshTimer = root.setTimeout(() => {
      state.refreshTimer = null;
      void refresh({ background: true });
    }, 150);
  }
  async function refresh(options = {}) {
    const background = options.background === true;
    if (state.refreshInFlight) {
      state.refreshQueued = true;
      return state.refreshInFlight;
    }
    state.refreshInFlight = (async () => {
      if (!background && !state.snapshot) {
        state.loading = true;
        state.dataState = 'loading';
        state.error = '';
        render();
      } else {
        state.refreshing = true;
        state.dataState = 'refreshing';
        render();
      }
      try {
        const projection = await invoke('cogseed.task.list');
        state.snapshot = model?.buildGlobalSnapshot(projection, { limit: 5 }) || { attention: [], running: [], recentCompleted: [], counts: {} };
        state.error = '';
        state.stale = false;
        state.dataState = Array.isArray(projection?.tasks) && projection.tasks.length ? 'ready' : 'empty';
      } catch (error) {
        state.error = error?.message || String(error);
        state.stale = !!state.snapshot;
        state.dataState = state.stale ? 'stale' : 'error';
      } finally {
        state.loading = false;
        state.refreshing = false;
        render();
      }
    })();
    try { return await state.refreshInFlight; }
    finally {
      state.refreshInFlight = null;
      if (state.refreshQueued) { state.refreshQueued = false; scheduleRefresh(); }
    }
  }
  function startWatch() {
    if (document.hidden || state.watch || !root.cogseed?.stream) return;
    const watch = root.cogseed.stream('cogseed.dashboard.watch', {}, (event) => {
      if (event?.type === 'change') scheduleRefresh();
    });
    state.watch = watch;
    watch.promise?.catch?.((error) => {
      if (state.watch !== watch) return;
      state.watch = null;
      if (error?.name !== 'AbortError') {
        state.error = error?.message || String(error);
        state.stale = !!state.snapshot;
        state.dataState = state.stale ? 'stale' : 'error';
        render();
      }
    });
  }
  function stopWatch() {
    state.watch?.cancel?.();
    state.watch = null;
    if (state.refreshTimer) root.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.refreshQueued = false;
  }
  function openTask(conversationId, returnContext) {
    const cid = String(conversationId || '').trim();
    if (!cid) {
      root.uiToast?.(label('run_center.task_unavailable', 'Task details are unavailable'), { variant: 'warning' });
      return false;
    }
    state.open = false;
    render();
    root.setView?.('conversation', cid, {
      entryPoint: 'run-center',
      openRunContext: 'proof',
      runCenterReturn: returnContext || {
        sourceView: 'tasks', taskScope: 'current', runMode: 'board', filters: {},
        selectedRunKey: '', selectedAttemptKey: '', scrollPositions: [], focusTarget: null,
      },
    });
    return true;
  }
  function openAll(filter = 'all') {
    state.open = false;
    render();
    root.setView?.('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { query: filter === 'all' ? {} : { filter } },
    });
  }
  function openCreate() {
    state.open = false;
    render();
    root.setView?.('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { openCreate: true },
    });
  }
  function bind() {
    if (state.bound) return;
    state.bound = true;
    const trigger = ensureButton();
    trigger?.addEventListener('click', (event) => {
      event.preventDefault();
      state.open = !state.open;
      render();
      if (state.open) {
        panel()?.querySelector?.('[data-run-center-global-close]')?.focus();
        startWatch(); void refresh({ background: true });
      }
    });
    document.addEventListener('click', (event) => {
      if (!state.open || event.target?.closest?.('#run-center-quick-panel, #run-center-global-btn')) return;
      state.open = false;
      render();
    });
    document.addEventListener('keydown', (event) => {
      if (state.open && event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        // This global popover can cover a task detail or settings surface.
        // Escape belongs to the top layer, not both it and the page below.
        event.preventDefault();
        event.stopImmediatePropagation();
        state.open = false; render(); trigger?.focus?.();
      }
    }, true);
    ensurePanel();
    ensurePanel().addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.runCenterGlobalClose !== undefined) { state.open = false; render(); trigger?.focus?.(); return; }
      if (target.dataset.runCenterGlobalRetry !== undefined) { void refresh({ background: true }); return; }
      if (target.dataset.runCenterGlobalCreate !== undefined) { openCreate(); return; }
      if (target.dataset.runCenterGlobalViewAll !== undefined) { openAll(target.dataset.runCenterGlobalViewAll); return; }
      if (target.dataset.runCenterGlobalTask !== undefined) {
        openTask(target.dataset.runCenterGlobalConversationId);
      }
    });
    document.getElementById('run-center-return-btn')?.addEventListener('click', (event) => {
      event.preventDefault();
      returnToRunCenter();
    });
    root.addEventListener('i18n-change', render);
    root.addEventListener('resize', positionPanel);
    const sidebar = document.querySelector('.sidebar');
    if (root.ResizeObserver && sidebar) new root.ResizeObserver(positionPanel).observe(sidebar);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopWatch();
      else { startWatch(); scheduleRefresh(); }
    });
    if (!document.hidden) { startWatch(); void refresh(); }
  }
  function open() {
    state.open = true;
    bind();
    startWatch();
    void refresh({ background: true });
    render();
    panel()?.querySelector?.('[data-run-center-global-close]')?.focus();
  }
  function close() {
    if (!state.open && panel()?.hidden !== false) return;
    state.open = false;
    render();
  }
  function returnToRunCenter() {
    const context = root.__runCenterReturnContext;
    if (!context) return false;
    root.__runCenterReturnContext = null;
    root.setView?.('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { restore: context },
    });
    return true;
  }
  function openRunCenterForTask(conversationId) {
    const cid = String(conversationId || '').trim();
    if (!cid) return false;
    root.setView?.('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { query: { conversationId: cid } },
    });
    return true;
  }
  root.openRunCenterGlobal = open;
  root.closeRunCenterGlobal = close;
  root.openRunCenterGlobalTask = openTask;
  root.openRunCenterForTask = openRunCenterForTask;
  root.returnToRunCenter = returnToRunCenter;
  root.stopRunCenterGlobalWatch = stopWatch;
  root.runCenterGlobalState = state;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})(window);
