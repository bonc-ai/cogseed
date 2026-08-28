// ─── Boot ─────────────────────────────────────────────────────────────────
const _bootLog = createLogger('boot');
async function initAuth() {
  bootApp().catch((err) => {
    console.error('[BOOT FATAL] bootApp failed:', err);
    _bootLog.error('bootApp failed', { error: (err && err.message) || String(err), stack: err && err.stack });
  });
}

// ─── Boot performance guardrails ────────────────────────────────────────────
//
// `bootApp` is the critical path from window open → "user sees last
// conversation". Three structural rules + a runtime check keep it honest:
//
//   R1. THREE STAGES ONLY. Do not add a fourth serial `await` between
//       `initI18n` and `_restoreLastView`. Any new boot-time work MUST
//       land in Stage A (independent prep), Stage B (chat first-paint
//       prereqs), or the deferred Stage C tail (non-critical warmup).
//   R2. STAGE A / STAGE B ITEMS MUST BE FIRE-AND-RETURN. No new module
//       inside the Promise.all may emit a fire-and-forget `await` inside
//       another `await` of the same Promise.all — that defeats parallelism.
//   R3. NON-CRITICAL WORK GOES IN STAGE C. If a task does not contribute
//       to the user seeing the last conversation (subscriptions, tab-only
//       data, banners, warmup caches), defer it.
//
// `_bootStage` wraps each stage with a timer; a stage exceeding
// `_BOOT_STAGE_WARN_MS` or a total boot exceeding `_BOOT_TOTAL_WARN_MS`
// emits `log.warn` with the breakdown. That single warn line is the
// regression alarm — any future commit that re-introduces a serial await
// will show up in the next boot's log.
const _BOOT_STAGE_WARN_MS = 1500;
const _BOOT_TOTAL_WARN_MS = 3000;
const _SIDEBAR_NAV_BOOT_WARM_MS = 3500;
let _sidebarNavWarmUntil = 0;
const _sidebarNavTimers = new Map();
const _sidebarNavTokens = new Map();

// One coarse timestamp per second is enough for background admission. No
// event details leave the renderer; main only learns that interaction happened.
let _lastBootActivityReportAt = 0;
function _reportBootUserActivity() {
  const now = Date.now();
  if (now - _lastBootActivityReportAt < 1000) return;
  _lastBootActivityReportAt = now;
  try { window.cogseed?.reportUserActivity?.(); } catch (_) {}
}
for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(eventName, _reportBootUserActivity, { capture: true, passive: true });
}

function _deferSidebarNavWork(key, fn, delayMs = 0) {
  const token = (_sidebarNavTokens.get(key) || 0) + 1;
  _sidebarNavTokens.set(key, token);
  const prev = _sidebarNavTimers.get(key);
  if (prev) clearTimeout(prev);

  const arm = () => {
    if (_sidebarNavTokens.get(key) !== token) return;
    const timer = setTimeout(() => {
      if (_sidebarNavTokens.get(key) !== token) return;
      _sidebarNavTimers.delete(key);
      _sidebarNavTokens.delete(key);
      try {
        fn();
      } catch (err) {
        _bootLog.warn('sidebar nav work failed', {
          key,
          error: (err && err.message) || String(err),
        });
      }
    }, Math.max(0, delayMs || 0));
    _sidebarNavTimers.set(key, timer);
  };

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(arm);
  else arm();
}

async function _bootStage(name, fn) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = Math.round(performance.now() - t0);
    if (ms > _BOOT_STAGE_WARN_MS) {
      _bootLog.warn(`boot stage slow: ${name} ${ms}ms (threshold ${_BOOT_STAGE_WARN_MS}ms)`);
    } else {
      _bootLog.info(`boot stage: ${name} ${ms}ms`);
    }
  }
}

async function bootApp() {
  _bootLog.info('app boot');
  const _bootT0 = performance.now();
  _sidebarNavWarmUntil = Math.max(_sidebarNavWarmUntil, _bootT0 + _SIDEBAR_NAV_BOOT_WARM_MS);
  _migrateLegacyLocalStorageKeys();
  // i18n must be ready before any other UI module renders labels.
  await _bootStage('initI18n', initI18n);

  // First-run walkthrough FIRST: check the machine-local onboarding marker
  // right after i18n, BEFORE Stage A/B. The walkthrough is a full-screen
  // overlay — the user should land on it immediately, never on a half-loaded
  // main UI that swaps to the walkthrough seconds later. It is fire-and-
  // forget so it never blocks first paint; Stage A/B keep warming the main
  // UI underneath the overlay. `maybeStart` is idempotent (skips when the
  // marker says completed), so the original post-Stage-B call below stays
  // as a safety net for edge cases where the early check raced boot.
  if (window.csOnboarding && typeof window.csOnboarding.maybeStart === 'function') {
    Promise.resolve(window.csOnboarding.maybeStart()).catch((err) => {
      _bootLog.warn('onboarding maybeStart (early) failed', { error: (err && err.message) || String(err) });
    });
  }

  // ── Stage A (parallel, no inter-dependencies) ──────────────────────
  // All four are independent IPC calls. Three downstream constraints,
  // all honored by staging:
  //   - `_stampSettingsVersion` stamps body.is-dev BEFORE Stage B's
  //     `loadAgents` / later `loadSkills` read `false`.
  //   - `initAvatarCatalog` must finish BEFORE `loadAgents` so cards
  //     render with their icon SVGs instead of a fallback frame.
  //   - `initUser` → `initUserWorkspace` stays sequential (workspace
  //     paths key off the activated uid).
  // `refreshModelGuard` is the no-model banner — non-critical, deferred
  // to Stage C with the other warmup-only work.
  await _bootStage('stageA', () => Promise.all([
    _stampSettingsVersion(),
    (async () => { await initUser(); await initUserWorkspace(); if (typeof initModelChip === 'function') initModelChip(); })(),
    initAvatarCatalog(),
  ]));

  // ── Stage B (parallel, depends on Stage A) ─────────────────────────
  // Both feed the first chat view: the sidebar list (loadConversations)
  // and a lightweight @-mention / actor-label cache. The full Agent specs
  // (workflows, profiles, memory and skill references) load only on the
  // Agents tab.
  await _bootStage('stageB', () => Promise.all([
    loadConversations({ startup: true }),
    loadAgents(false, { summary: true }),
  ]));

  // User now sees the last conversation. _ensureCommanderAvatarLoaded is
  // fire-and-forget but kicked off NOW (not in Stage C) so the first
  // chat render finds the commander avatar warm; one cheap IPC, worth
  // it to avoid a default-avatar flash on the first frame.
  _restoreLastView();
  // ── 工作空间 tab 冷启动预热 ─────────────────────────────────────────────
  // workspace.js 原本是点击 tab 时才注入的懒加载脚本（3000 行/172KB），
  // 每次打开软件后第一次点「工作空间」都要现场取代码 + 解析，产生可感知
  // 延迟。这里改成打开软件时就把脚本注入好（只加载、不渲染），首次点击
  // 只剩数据 IPC，跟同会话第二次点击一样快。
  // requestIdleCallback 等主线程空闲再装，不挤占首帧；4s 兜底保证必装。
  {
    const _warmWorkspaceFeature = () => {
      const loader = typeof loadRendererFeature === 'function'
        ? loadRendererFeature
        : window.loadRendererFeature;
      if (typeof loader !== 'function') return;
      Promise.resolve(loader('workspace'))
        .then(() => {
          // 数据同样预热：在隐藏面板里先渲染一遍（不可见），首次点击只剩
          // 极短刷新；本机 CLI 探测也提前完成，新建空间弹窗的基础 Agent
          // 不再后补。用户已手动进入工作空间/面包屑已请求打开指定空间时跳过，
          // 避免与点击路径的 renderWorkspace 并发互相覆盖。
          if (currentView !== 'workspace' && currentView !== 'spaces'
            && !window.__cogseedPendingOpenSpace
            && typeof window.renderWorkspace === 'function') {
            Promise.resolve(window.renderWorkspace()).catch(() => {});
          }
        })
        .catch((err) => {
          _bootLog.warn('workspace warmup load failed', { error: (err && err.message) || String(err) });
        });
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(_warmWorkspaceFeature, { timeout: 4000 });
    } else {
      setTimeout(_warmWorkspaceFeature, 500);
    }
  }
  // First-run walkthrough: fire-and-forget so it never blocks first paint.
  // It reads the machine-local onboarding marker and only lifts the overlay
  // on a device that hasn't completed it yet. Runs after the last view is
  // restored so the app is fully painted underneath the overlay.
  if (window.csOnboarding && typeof window.csOnboarding.maybeStart === 'function') {
    Promise.resolve(window.csOnboarding.maybeStart()).catch((err) => {
      _bootLog.warn('onboarding maybeStart failed', { error: (err && err.message) || String(err) });
    });
  }

  // Interactive tour is started by onboarding.js after completion
  // (removed duplicate auto-start to avoid "tour already running" conflict)
  if (typeof _consumePendingTaskNotificationConversation === 'function') {
    _consumePendingTaskNotificationConversation();
  }
  if (typeof _ensureCommanderAvatarLoaded === 'function') _ensureCommanderAvatarLoaded();
  // Inline `delete_file` confirm-card subscription is attached here (NOT in
  // Stage C) so a tool call fired within the first 2.5 s of boot still has
  // a receiver. The listener is cheap (one IPC subscribe); deferring it
  // would risk the main-side `delete_file` tool sitting on a 5-minute
  // timeout because no renderer was listening yet.
  if (typeof startDeleteFileConfirmSubscription === 'function') {
    startDeleteFileConfirmSubscription();
  }

  const _bootTotalMs = Math.round(performance.now() - _bootT0);
  if (_bootTotalMs > _BOOT_TOTAL_WARN_MS) {
    _bootLog.warn(`boot total slow: ${_bootTotalMs}ms (threshold ${_BOOT_TOTAL_WARN_MS}ms) — likely a new serial await landed in bootApp; see boot stage timings above`);
  } else {
    _bootLog.info(`boot total: ${_bootTotalMs}ms`);
  }
  _sidebarNavWarmUntil = Math.max(_sidebarNavWarmUntil, performance.now() + _SIDEBAR_NAV_BOOT_WARM_MS);

  // ── Stage C (deferred ~2.5 s, no impact on first paint) ────────────
  // These do not block first-frame interactivity:
  //   - refreshModelGuard: no-model banner can appear a tick later.
  //   - subscriptions: passive event sinks, not on the critical path.
  // Skill data deliberately does NOT prefetch here. The Skills tab already
  // loads it on entry; pulling the full catalog at +2.5 s competes with the
  // user's first interactions on low-end devices for no chat-path benefit.
  setTimeout(() => {
    try { refreshModelGuard(); } catch (_) { /* non-fatal */ }
    if (typeof startAutoEventsSubscription === 'function') {
      startAutoEventsSubscription();
    }
  }, 2500);
}

// Stamps body.is-dev so renderer modules can branch on dev mode synchronously
// via `document.body.classList.contains('is-dev')`. Used by skills / agents
// grids to expose builtin ⋯ menu (edit / delete) and the "promote to builtin"
// item on custom cards.
async function _stampSettingsVersion() {
  if (!window.cogseed || typeof window.cogseed.env !== 'function') return;
  try {
    const env = await window.cogseed.env();
    if (env && env.isDev) document.body.classList.add('is-dev');
  } catch (_) { /* ignore — non-critical */ }
}

// One-shot rename of legacy brand-prefixed localStorage keys
// (`cogseed_*` / `cogseed.*`). Rationale lives in
// plans/decouple-session-id-from-brand.md: avoid breaking another wave
// of user view state / drafts the next time the brand is renamed. After
// stamping, subsequent boots are no-ops. Placed at the very start of
// boot so no other module reads a stale key first.
function _migrateLegacyLocalStorageKeys() {
  try {
    if (localStorage.getItem('_ls_brand_migration_v1')) return;
    const fixedMap = {
      'cogseed_last_view':           'last_view',
      'cogseed_search_history':      'search_history',
      'cogseed.chat.recipientByCid': 'chat.recipientByCid',
      'cogseed.kb-picker.last-dir':  'kb-picker.last-dir',
    };
    for (const [oldK, newK] of Object.entries(fixedMap)) {
      const v = localStorage.getItem(oldK);
      if (v != null && localStorage.getItem(newK) == null) {
        localStorage.setItem(newK, v);
      }
      localStorage.removeItem(oldK);
    }
    const toRename = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('cogseed_queue_') || k.startsWith('cogseed_draft_'))) {
        toRename.push(k);
      }
    }
    for (const k of toRename) {
      const newK = k.replace(/^cogseed_/, '');
      const v = localStorage.getItem(k);
      if (v != null && localStorage.getItem(newK) == null) {
        localStorage.setItem(newK, v);
      }
      localStorage.removeItem(k);
    }
    localStorage.setItem('_ls_brand_migration_v1', '1');
  } catch (_) {
    /* localStorage unavailable / quota — skip; no-op next boot */
  }
}

// Persist the current view across reloads (localStorage keyed by user).
const _LAST_VIEW_KEY = 'last_view';

function _saveLastView(view, cid) {
  try {
    localStorage.setItem(_LAST_VIEW_KEY, JSON.stringify({ view, cid: cid || null }));
  } catch (_) {}
}

function _loadViewFeature(feature, view, run) {
  const loader = typeof loadRendererFeature === 'function'
    ? loadRendererFeature
    : window.loadRendererFeature;
  if (typeof loader !== 'function') {
    run();
    return;
  }
  _clearLazyFeatureError(view);
  Promise.resolve(loader(feature))
    .then(() => {
      _clearLazyFeatureError(view);
      if (currentView === view) run();
    })
    .catch((err) => {
      _bootLog.warn('lazy renderer feature load failed', {
        feature,
        error: (err && err.message) || String(err),
      });
      _showLazyFeatureError(feature, view, err, run);
    });
}

function _lazyFeaturePanel(view) {
  const panelId = view === 'memory' ? 'panel-memory'
    : view === 'skills' ? 'panel-connections'
    : view === 'recall' ? 'panel-recall'
    : view === 'spaces' || view === 'workspace' ? 'panel-workspace'
    : view === 'kb' ? 'panel-kb'
    : view === 'contexts' ? 'panel-contexts'
    : view === 'settings' ? 'panel-settings'
    : view === 'auto' ? 'panel-auto'
    : view === 'marketplace' ? 'panel-marketplace'
    : view === 'devtools' ? 'panel-devtools'
    : null;
  return panelId ? document.getElementById(panelId) : null;
}

function _clearLazyFeatureError(view) {
  _lazyFeaturePanel(view)?.querySelector(':scope > .lazy-feature-error')?.remove();
}

function _showLazyFeatureError(feature, view, err, run) {
  const panel = _lazyFeaturePanel(view);
  if (!panel) return;
  _clearLazyFeatureError(view);
  const banner = document.createElement('div');
  banner.className = 'lazy-feature-error';
  banner.dataset.feature = feature;
  const reason = (err && err.message) || String(err || '');
  banner.dataset.errorReason = reason;
  banner.innerHTML = `<span data-lazy-feature-error-message>${escapeHtml(t('chat.load_failed', { msg: reason }))}</span>
    <button type="button" class="btn btn-sm">${escapeHtml(t('chat.retry_btn'))}</button>`;
  banner.querySelector('button')?.addEventListener('click', () => {
    _clearLazyFeatureError(view);
    if (currentView === view) _loadViewFeature(feature, view, run);
  });
  panel.prepend(banner);
}

window.addEventListener('i18n-change', () => {
  document.querySelectorAll('.lazy-feature-error').forEach((banner) => {
    const message = banner.querySelector('[data-lazy-feature-error-message]');
    const retry = banner.querySelector('button');
    if (message) message.textContent = t('chat.load_failed', { msg: banner.dataset.errorReason || '' });
    if (retry) retry.textContent = t('chat.retry_btn');
  });
});

function _restoreLastView() {
  // Restart policy: only `conversation` view is remembered across launches.
  // Every other tab (agents / skills / contexts / connectors / apps / settings
  // / project detail / marketplace / devtools) intentionally falls back to
  // the commander (new-chat) — the user always lands on a known starting
  // point and doesn't accidentally resume a settings / inventory tab they
  // wandered into before quitting.
  let saved = null;
  try {
    const raw = localStorage.getItem(_LAST_VIEW_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (_) {}

  const view = saved?.view;
  const cid = saved?.cid;

  if (view === 'conversation' && cid && conversations.some(c => c.conversation_id === cid)) {
    setView('conversation', cid);
    return;
  }
  setView('new-chat');
}

async function initUser() {
  try {
    const res = await apiFetch('/api/user/init');
    const data = await res.json();
    if (data.ok && data.user_id) {
      currentUserId = data.user_id;
      _bootLog.info('user init', { user_id: currentUserId });
      // Bind the telemetry identity as soon as we have a user_id;
      // Monitor handles dedupe + queueing internally, so no need to
      // check whether umami has finished initializing.
          }
  } catch (e) {
    _bootLog.error('init user failed', { error: (e && e.message) || String(e) });
      }
}

// ─── View routing ───

function setView(view, cid, opts = {}) {
  const openPersonalOntology = view === 'personal-ontology';
  if (openPersonalOntology) view = 'recall';
  if (view === 'evolution') view = 'skills';
  if (currentView !== view || (view === 'conversation' && currentCid !== cid)) {
    _bootLog.info('view change', { view, cid: cid || undefined });
  }
  currentView = view;
  if (view !== 'agents' && typeof closeExpenseWorkbench === 'function') {
    closeExpenseWorkbench();
  }
  _saveLastView(view, cid);
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const panelId = view === 'new-chat' ? 'panel-new-chat'
                : view === 'auto' ? 'panel-auto'
                : view === 'agents' || view === 'contexts' ? 'panel-connections'
                : view === 'skills' ? 'panel-connections'
                : view === 'personal-ontology' ? 'panel-recall'
                : view === 'recall' ? 'panel-recall'
                : view === 'connections' || view === 'connectors' ? 'panel-connections'
                : view === 'spaces' || view === 'workspace' ? 'panel-workspace'
                : view === 'kb' ? 'panel-kb'
                : view === 'settings' ? 'panel-settings'
                : view === 'dashboard' ? 'panel-dashboard'
                : view === 'memory' ? 'panel-memory'
                : view === 'devtools' ? 'panel-devtools'
                : view === 'marketplace' ? 'panel-marketplace'
                : 'panel-conversation';
  document.getElementById(panelId).classList.add('active');

  document.getElementById('new-chat-btn').classList.toggle('active', view === 'new-chat');
  document.getElementById('auto-btn')?.classList.toggle('active', view === 'auto');
  document.getElementById('kb-btn')?.classList.toggle('active', view === 'kb');
  document.getElementById('recall-btn')?.classList.toggle('active', view === 'recall' || view === 'personal-ontology');
  document.getElementById('connectors-btn')?.classList.toggle('active', view === 'connections' || view === 'connectors' || view === 'agents' || view === 'contexts' || view === 'skills');
  document.getElementById('workspace-btn')?.classList.toggle('active', view === 'workspace');
  document.getElementById('dashboard-btn')?.classList.toggle('active', view === 'dashboard');
  // 设置视图高亮同步到左下角融合面板的「设置」项（account-chip.js）。
  if (typeof window.setChipSettingsActive === 'function') {
    window.setChipSettingsActive(view === 'settings');
  }
  document.getElementById('devtools-btn')?.classList.toggle('active', view === 'devtools');
  document.querySelectorAll('.conv-item').forEach(it => {
    it.classList.toggle('active', view === 'conversation' && it.dataset.cid === cid);
  });

  // Memory lives in the Settings feature bundle. Reached only from Settings,
  // so loading it here keeps its 32 KB parser/evaluator cost off chat first paint.
  if (view === 'memory') {
    _loadViewFeature('settings', 'memory', () => {
      if (typeof renderMemoryPage === 'function') renderMemoryPage();
    });
  }
  // 智能体总览（第二期 Dashboard）：模块懒加载，进视图才拉数据。
  if (view === 'dashboard') {
    _loadViewFeature('dashboard', 'dashboard', () => {
      if (typeof renderDashboard === 'function') renderDashboard();
    });
  }
  if (view === 'conversation' && cid) {
    currentCid = cid;
    if (typeof onEnterConversationView === 'function') onEnterConversationView();
    // If this conversation has an in-flight stream and its bubble is still
    // attached to #chat-history (sidebar tab toggle didn't wipe it), skip
    // the reload — wiping would orphan the bubble while the active stream
    // closure keeps writing into the detached node, leaving the "thinking…" indicator stuck.
    const pendingState = pendingConvs.get(cid);
    const streamBubbleAlive = !!pendingState?.loadingEl?.isConnected;

    if (opts.skipLoad) {
      // Fresh conversation — caller will drive appends. Clear any stale content.
      const container = document.getElementById('chat-history');
      container.innerHTML = '';
      if (typeof _replayBufferedGroupEvents === 'function') _replayBufferedGroupEvents(cid);
    } else if (!streamBubbleAlive) {
      loadConversationHistory(cid, opts.historyTarget ? { searchTarget: opts.historyTarget } : undefined);
    } else if (opts.historyTarget && typeof _revealConversationHistorySearchTarget === 'function') {
      _revealConversationHistorySearchTarget(cid, opts.historyTarget);
    }
    // If this conversation is still pending a response, re-attach loading indicator
    if (isConvPending(cid) && !opts.skipLoad && !streamBubbleAlive) {
      const state = pendingConvs.get(cid);
      // Will be (re)appended after history loads — handled in loadConversationHistory
      if (state) state.needsIndicator = true;
    }
    // Restore input draft + queue panel for this conversation
    if (!opts.skipLoad) _restoreDraft(cid);
    renderMessageQueue(cid);
    // Attachment chips: bind the "+" button once, redraw chip area for the
    // current cid, and resync with the server in case the previous visit
    // left files on disk without their dataUrl.
    if (typeof _initChatAttachInput === 'function') _initChatAttachInput();
    if (typeof _chatAttachRenderChips === 'function') _chatAttachRenderChips();
    if (!opts.skipLoad && typeof _chatAttachRefreshFromServer === 'function') {
      _chatAttachRefreshFromServer(cid);
    }
    // If we returned to a conversation with queued items and nothing is
    // streaming, kick off the next one automatically.
    if (!isConvPending(cid) && (messageQueues.get(cid) || []).length) {
      // Fire-and-forget: _dispatchNextQueued is async (ontology_group token
      // expansion needs an IPC round-trip); this call site never awaited it.
      Promise.resolve(_dispatchNextQueued(cid)).catch(() => {});
    }
    _updateConvSendUI(cid);
    setTimeout(() => document.getElementById('chat-input')?.focus(), 50);
  } else if (view === 'new-chat') {
    // Leaving conversation view: hide any queue panel remnants.
    renderMessageQueue(null);
    currentCid = null;
    // Reset the new-chat ephemeral recipient back to commander every time
    // the landing page is entered — the user explicitly asked for a clean
    // slate here, so prior in-session picks don't leak forward.
    if (typeof onEnterNewChatView === 'function') onEnterNewChatView();
    // Draft attachment chips (commander tab's local `main_chat/` pool): re-paint
    // from the in-memory Map immediately, and re-sync with disk in case a prior
    // session left files on disk without a dataUrl.
    if (typeof _chatAttachRenderChips === 'function') _chatAttachRenderChips(DRAFT_CID);
    if (typeof _chatAttachRefreshFromServer === 'function') _chatAttachRefreshFromServer(DRAFT_CID);
    if (typeof _renderQuotePreview === 'function') _renderQuotePreview(DRAFT_CID);
    setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
  } else if (view === 'agents') {
    currentCid = null;
    _deferSidebarNavWork('agents-tab-load', () => {
      // AI 团队已内嵌进「连接」：深链先切到 Agent tab。
      if (typeof initConnections === 'function') initConnections();
      else if (typeof window.initConnections === 'function') window.initConnections();
      if (typeof activateConnectionsTab === 'function') activateConnectionsTab('agents');
      _loadViewFeature('agents', 'agents', () => {
        if (typeof _agentsCache !== 'undefined' && _agentsCache && !_agentsCacheIsSummary) renderAgentsList(_agentsCache);
        // Boot owns a summary-only list. Upgrade it once when the grid first needs
        // descriptions/counts; subsequent visits reuse the full renderer cache.
        const needsFullListing = !(typeof _agentsCache !== 'undefined' && _agentsCache && !_agentsCacheIsSummary);
        if (needsFullListing) {
          _deferSidebarNavWork('agents-tab-refresh', () => {
            if (currentView !== 'agents') return;
            Promise.resolve(loadAgents(false))
              .then(() => {
                if (currentView === 'agents' && typeof refreshSelectedAgentDetail === 'function') {
                  return refreshSelectedAgentDetail();
                }
                return null;
              })
              .catch((e) => _bootLog.warn('agents refresh on tab entry failed', { error: (e && e.message) || String(e) }));
          }, 0);
        }
      });
    });
  } else if (view === 'skills') {
    currentCid = null;
    _deferSidebarNavWork('skills-tab-refresh', () => {
      _loadViewFeature('skills', 'skills', () => {
        // 技能库已移到连接页「技能」tab（技能市场/外部库属于可用资源，不是
        // 个人认知资产）。深链先切过去，再渲染技能网格。
        if (typeof activateConnectionsTab === 'function') activateConnectionsTab('skills');
        if (typeof _skillsCache !== 'undefined' && _skillsCache) renderSkillsList(_skillsCache);
        const forceRefresh = !!(typeof _skillsCache !== 'undefined' && _skillsCache);
        Promise.resolve(loadSkills(forceRefresh))
          .then(() => {
            if (currentView === 'skills' && typeof refreshSelectedSkillDetail === 'function') {
              return refreshSelectedSkillDetail();
            }
            return null;
          })
          .catch((e) => _bootLog.warn('skills refresh on tab entry failed', { error: (e && e.message) || String(e) }));
      });
    });
  } else if (view === 'recall') {
    currentCid = null;
    _deferSidebarNavWork('recall-tab-refresh', () => {
      _loadViewFeature('recall', 'recall', () => {
        if (typeof initSkillsCognitionConsole === 'function') initSkillsCognitionConsole();
        // 深链 setView('personal-ontology') 在 setView 顶部被归一化为 recall；
        // 「关于我」已不是独立 tab，而是「我的资产」里的 personal 分类：切到
        // 该页并选中该分类，个人本体就在页内展开。
        if (openPersonalOntology && typeof switchSkillsCognitionPage === 'function') {
          if (typeof _skillsCognitionState !== 'undefined' && _skillsCognitionState) {
            _skillsCognitionState.assetCategoryFilter = 'personal';
            // 个人本体通过「查看关于我」入口单独进入（ontology subview）。
            _skillsCognitionState.assetSubview = 'ontology';
          }
          switchSkillsCognitionPage('assets');
        }
        if (typeof loadSkillsCognitionSnapshot === 'function') {
          Promise.resolve(loadSkillsCognitionSnapshot())
            .catch((e) => _bootLog.warn('Recall refresh on tab entry failed', { error: (e && e.message) || String(e) }));
        }
      });
    });
  } else if (view === 'connections' || view === 'connectors') {
    currentCid = null;
    _deferSidebarNavWork('connections-tab-load', () => {
      // The connections panel is eager-bundled with connectors.js; just make
      // sure tab chrome + entry cards are initialized, then open the MCP pane
      // when arriving via the legacy 'connectors' view.
      if (currentView !== 'connections' && currentView !== 'connectors') return;
      if (typeof initConnections === 'function') initConnections();
      else if (typeof window.initConnections === 'function') window.initConnections();
      if (view === 'connectors' && typeof activateConnectionsTab === 'function') {
        activateConnectionsTab('mcp');
      }
    });
  } else if (view === 'contexts') {
    currentCid = null;
    _deferSidebarNavWork('contexts-tab-load', () => {
      // 资料库已内嵌进「连接」：深链先切到数据源 tab。
      if (typeof initConnections === 'function') initConnections();
      else if (typeof window.initConnections === 'function') window.initConnections();
      if (typeof activateConnectionsTab === 'function') activateConnectionsTab('sources');
      _loadViewFeature('contexts', 'contexts', () => {
        if (typeof loadContexts === 'function') loadContexts();
      });
    });
  } else if (view === 'auto') {
    currentCid = null;
    // Force-refresh on every tab visit: a scheduled fire or remote sync pull
    // may have updated the list while the user was elsewhere.
    _deferSidebarNavWork('auto-tab-load', () => {
      _loadViewFeature('auto', 'auto', () => {
        if (typeof loadAutoList === 'function') loadAutoList(true);
      });
    });
  } else if (view === 'spaces' || view === 'workspace') {
    currentCid = null;
    _deferSidebarNavWork('workspace-tab-load', () => {
      _loadViewFeature('workspace', 'workspace', () => {
        if (typeof renderWorkspace === 'function') renderWorkspace();
      });
    });
  } else if (view === 'kb') {
    currentCid = null;
    _deferSidebarNavWork('kb-tab-load', () => {
      _loadViewFeature('kb', 'kb', () => {
        if (typeof renderKbEco === 'function') renderKbEco();
        if (typeof renderKbWorkbench === 'function') renderKbWorkbench();
      });
    });
  } else if (view === 'settings') {
    currentCid = null;
    _deferSidebarNavWork('settings-tab-load', () => {
      _loadViewFeature('settings', 'settings', () => {
        if (typeof loadSettings === 'function') {
          Promise.resolve(loadSettings())
            .catch((e) => _bootLog.warn('settings page load failed', { error: (e && e.message) || String(e) }));
        }
      });
    });
  } else {
    currentCid = null;
  }
}

// Expose setView to window for interactive tour
window.setView = setView;
