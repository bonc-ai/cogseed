// Resident Run Center status (specs/008-shell-rail-layout). It only consumes
// the privacy-filtered task projection, stays independent from the full lazy
// bundle, and surfaces "needs attention / running" as a count badge on the
// rail's Run Center entry. The former quick popover was retired: the rail
// entry opens the Run Center page itself.
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
  function invoke(channel, payload) {
    if (!root.cogseed?.invoke) return Promise.reject(new Error(label('run_center.ipc_unavailable', 'Run Center is unavailable')));
    return root.cogseed.invoke(channel, payload || {}).then((result) => {
      if (result?.ok === false) throw new Error(result.error || label('run_center.load_failed', 'Could not load Run Center'));
      return result;
    });
  }
  function render() {
    const counts = state.snapshot?.counts || {};
    const attentionCount = Number(counts.attention || 0);
    const runningCount = Number(counts.running || 0);
    const countLabel = attentionCount
      ? label('run_center.global_attention_count', `${attentionCount} need attention`, { count: attentionCount })
      : runningCount ? label('run_center.global_running_count', `${runningCount} running`, { count: runningCount }) : '';
    const trigger = document.getElementById('run-center-btn');
    trigger?.setAttribute('aria-label', [label('sidebar.run_center', '运行与协作'), countLabel].filter(Boolean).join(' · '));
    trigger?.setAttribute('aria-busy', String(state.loading || state.refreshing));
    if (trigger?.dataset) trigger.dataset.loadState = state.dataState;
    const badge = document.getElementById('run-center-global-badge');
    if (!badge) return;
    const count = attentionCount || runningCount;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : String(count || '');
    badge.dataset.state = attentionCount ? 'attention' : runningCount ? 'running' : 'idle';
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
      } else {
        state.refreshing = true;
        state.dataState = 'refreshing';
      }
      render();
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
  function bind() {
    if (state.bound) return;
    state.bound = true;
    document.getElementById('run-center-return-btn')?.addEventListener('click', (event) => {
      event.preventDefault();
      returnToRunCenter();
    });
    root.addEventListener('i18n-change', render);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopWatch();
      else { startWatch(); scheduleRefresh(); }
    });
    if (!document.hidden) { startWatch(); void refresh(); }
  }
  root.openRunCenterForTask = openRunCenterForTask;
  root.returnToRunCenter = returnToRunCenter;
  root.stopRunCenterGlobalWatch = stopWatch;
  root.runCenterGlobalState = state;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})(window);
