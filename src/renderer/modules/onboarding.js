// ─── First-run onboarding (CogSeed three-step walkthrough) ──────────────────
//
// Ported from the static prototype (60秒用户旅程.html), rebuilt on top of the
// live CogSeed renderer. Three steps:
//   1. 认识 CogSeed        — product intro (static)
//   2. 导入会话 / 检测本地 agent — REAL detection via `localAgents.list`;
//                            session history reading is NOT wired to a real
//                            backend yet, so sessions show an honest
//                            "unavailable / failed" state — never fake data.
//   3. 隐形匹配工作空间      — 不再让用户手动选角色；根据会话建议的模板自动创建/
//                           复用工作空间并把导入会话绑定进去，无建议则落「临时空间」。
//
// Fires once per machine: `prefs.getOnboarding` gates the lift, the last step
// calls `prefs.setOnboarding {completed:true}`. `boot.js` invokes
// `csOnboarding.maybeStart()` after the last view is restored.
//
// Hard rule from the product owner: DO NOT fabricate sessions or cognitions.
// Anything not backed by a real read must render as failure/empty.

const _obLog = typeof createLogger === 'function' ? createLogger('onboarding') : { info() {}, warn() {}, error() {} };

const CS_AGENT_LABELS = {
  claude: 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  workbuddy: 'WorkBuddy',
};

// One neutral terminal glyph for every CLI — we don't ship per-agent brand
// marks in this build and a real logo set can land later.
const CS_TERMINAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>';

// How many sessions import concurrently. The backend gates all model work
// behind a 5-slot global semaphore, so we keep this modest to speed up a batch
// without saturating that pool (a single big session may itself fan out to a
// few chunk passes). Anything beyond the slots simply queues — never errors.
const CS_IMPORT_CONCURRENCY = 3;

// Run `task` over `items` with at most `limit` in flight. Best-effort: each
// task must swallow its own errors (these import tasks do), so one failure
// never rejects the batch. Resolves once every item has settled.
async function _csMapWithConcurrency(items, limit, task) {
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runWorker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, runWorker));
}

// Track total import count for the indicator
let _csTotalImportCount = 0;

function _csUpdateImportCount(delta) {
  _csTotalImportCount += delta;
  const indicator = document.getElementById('cs-import-count');
  if (indicator) {
    indicator.textContent = String(_csTotalImportCount);
    indicator.style.color = _csTotalImportCount > 0 ? '#C4612F' : '#8B8B8B';
  }

  // Show/hide the import button based on whether there are checked sessions
  const importBtn = document.getElementById('cs-do-import');
  if (importBtn) {
    const hasChecked = _csHasCheckedSessions();
    importBtn.style.display = hasChecked ? 'inline-flex' : 'none';
  }
}

// Check if any sessions are currently checked in the asset panel
function _csHasCheckedSessions() {
  const assetPanes = document.querySelector('#cs-agent-list .cs-asset-panes');
  if (!assetPanes) return false;
  const checked = assetPanes.querySelectorAll('input[type="checkbox"]:checked');
  return checked.length > 0;
}

// Update import button visibility based on checkbox state
function _csUpdateImportButtonVisibility() {
  const importBtn = document.getElementById('cs-do-import');
  if (importBtn) {
    const hasChecked = _csHasCheckedSessions();
    importBtn.style.display = hasChecked ? 'inline-flex' : 'none';
  }
}

// Handle the import button click - finds which agent is active and triggers its import
window._csDoImport = async function() {
  const activePanel = document.querySelector('#cs-agent-list .cs-asset-panel');
  if (!activePanel) return;

  const agentType = activePanel.dataset.agent;
  if (!agentType) return;

  // Find which asset tab is active (should be sessions)
  const activeTab = activePanel.querySelector('.cs-asset-tab.active');
  const activeAsset = activeTab ? activeTab.dataset.asset : 'sessions';

  if (activeAsset !== 'sessions') {
    _csToast(_csT('onboarding.toast.sessions_tab', '请切换到会话标签页进行导入'));
    return;
  }

  // Trigger the appropriate import function
  if (agentType === 'claude') {
    await _csImportClaudeSessions(agentType);
  } else if (agentType === 'codex') {
    await _csImportCodexSessions(agentType);
  } else if (agentType === 'workbuddy') {
    await _csImportWorkbuddySessions(agentType);
  }
};

function _csEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _csObBuilt = false;
let _csToastTimer = 0;
let _csActiveStep = 0;
let _csMatchingLead = { key: 'onboarding.matching.description', fallback: '会根据你选择的会话内容，自动为你准备好接下来要用的东西。', vars: undefined };
// 本轮导入的所有会话 ID（Claude + Codex），用于完成时批量绑定到角色工作空间。
let _csImportedConversationIds = [];
// 标记是否从"继续之前的工作"按钮进入（standalone模式）
let _csStandaloneMode = false;

function _csToast(msg) {
  const t = document.getElementById('cs-ob-toast');
  if (!t) return;
  const m = t.querySelector('.t-msg');
  if (m) m.textContent = msg; else t.textContent = msg;
  t.classList.remove('busy'); // ordinary toast: hide the progress bar
  t.classList.add('show');
  clearTimeout(_csToastTimer);
  _csToastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// Sticky toast with an INDETERMINATE progress bar for a long atomic op we can't
// measure (e.g. a single-call session import). No auto-dismiss and no fake
// percentage — the animated bar just conveys "still working". Pair every call
// with _csToastDone() (or a plain _csToast) once the op resolves.
function _csToastBusy(msg) {
  const t = document.getElementById('cs-ob-toast');
  if (!t) return;
  const m = t.querySelector('.t-msg');
  if (m) m.textContent = msg;
  t.classList.add('busy', 'show');
  clearTimeout(_csToastTimer); // sticky: cancel any pending auto-hide
}

// Resolve a busy toast into a final message that auto-dismisses normally.
function _csToastDone(msg) {
  _csToast(msg); // clears .busy, restores the 2.4s auto-hide
}

function _csT(key, fallback, vars) {
  try {
    if (typeof t === 'function') {
      const localized = t(key, vars);
      if (localized && localized !== key) return localized;
    }
  } catch (_) { /* keep the Chinese source copy when i18n is unavailable */ }
  return String(fallback == null ? '' : fallback).replace(/\{(\w+)\}/g, (m, name) => (
    vars && vars[name] != null ? String(vars[name]) : m
  ));
}

function _csApplyI18n(root) {
  if (typeof applyDomI18n === 'function') applyDomI18n(root);
}

function _csSetMatchingLead(key, fallback, vars) {
  _csMatchingLead = { key, fallback, vars };
  const lead = document.getElementById('cs-matching-lead');
  if (lead) lead.textContent = _csT(key, fallback, vars);
}

function _csImportSummary(success, failed = 0, cognitions = 0) {
  const failedPart = failed
    ? _csT('onboarding.asset.failed_part', '，失败 {count} 个', { count: failed })
    : '';
  const cognitionPart = cognitions
    ? _csT('onboarding.asset.cognition_part', '，提取 {count} 条候选认知', { count: cognitions })
    : '';
  return _csT('onboarding.asset.imported_sessions', '导入完成：成功 {success} 个{failedPart}{cognitionPart}', {
    success,
    failedPart,
    cognitionPart,
  });
}

function _csRefreshDynamicI18n() {
  const shell = document.getElementById('cs-onboarding');
  if (!shell) return;
  _csApplyI18n(shell);
  const beginLabel = shell.querySelector('#first-begin span');
  if (beginLabel) beginLabel.textContent = _csT('onboarding.start.begin', '开始一次真实工作');
  const lead = document.getElementById('cs-matching-lead');
  if (lead) lead.textContent = _csT(_csMatchingLead.key, _csMatchingLead.fallback, _csMatchingLead.vars);
  if (_csActiveStep === 1) {
    void _csLoadTeam(false);
  } else if (_csActiveStep === 2) {
    const importView = document.getElementById('cs-import-view');
    if (importView && importView.style.display !== 'none') void _csLoadAgents(false);
    else void _csLoadRecommendation(true);
  }
}

function _csObShellHtml() {
  return `
  <div class="cs-ob-brand" aria-hidden="true"><img src="../resources/icons/logo.png" alt=""><b>CogSeed</b></div>
  <div class="cs-main-fullwidth">
    <main class="cs-content">

      <section class="cs-panel active" data-cspanel="0">
        <div class="first-run-shell">
          <section class="first-run-story">
            <div class="first-run-brand"><img src="../resources/icons/logo.png" alt=""><span data-i18n="onboarding.brand_tagline">CogSeed · 跨Agent的个人能力资产层</span></div>
            <h1><span data-i18n="onboarding.hero.title_a">先让一次真实工作</span><br><span data-i18n="onboarding.hero.title_b">被准确接上</span></h1>
            <p data-i18n="onboarding.hero.description">CogSeed不替代你正在使用的Agent。它把你确认过的能力和当前任务状态，带到新的Session或Agent，让工作不用从头解释。</p>
            <div class="first-run-promise">
              <div>
                <i>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>
                    <path d="M12 11h.01"/><path d="M16 11h.01"/><path d="M8 11h.01"/>
                  </svg>
                </i>
                <p><strong data-i18n="onboarding.promise.start_title">从真实任务开始</strong><span data-i18n="onboarding.promise.start_desc">不要求先创建Agent、选择角色或配置认知资产。</span></p>
              </div>
              <div>
                <i>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
                    <path d="m9 12 2 2 4-4"/>
                  </svg>
                </i>
                <p><strong data-i18n="onboarding.promise.permission_title">先授权，再读取</strong><span data-i18n="onboarding.promise.permission_desc">检测只看可用状态；Session内容必须由你逐项授权。</span></p>
              </div>
              <div>
                <i>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="6" cy="19" r="3"/>
                    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>
                    <circle cx="18" cy="5" r="3"/>
                  </svg>
                </i>
                <p><strong data-i18n="onboarding.promise.continuity_title">60秒看到接续</strong><span data-i18n="onboarding.promise.continuity_desc">计时从"带着这些继续"开始，不包含安装、登录和授权。</span></p>
              </div>
            </div>
            <div class="first-run-footnote" data-i18n="onboarding.hero.footnote">模型是大家的，认知是你的。</div>
          </section>

          <aside class="first-run-start">
            <div class="first-run-card" id="first-run-card">
              <div class="eyebrow" data-i18n="onboarding.start.eyebrow">Start with real work</div>
              <h2 data-i18n="onboarding.start.title">开始一次真实工作</h2>
              <p data-i18n="onboarding.start.description">CogSeed会先检查这台Mac上可用的Agent、最近任务和真实执行方式。此时不会读取任何Session正文。</p>
              <div class="first-run-consent">
                <label class="first-run-consent-check">
                  <input type="checkbox" id="first-consent" />
                  <span data-i18n="onboarding.legal_consent_prefix">我已阅读并同意</span>
                </label>
                <button type="button" class="first-run-legal-link" data-open-external-url="https://cogseed-open.bonc.com.cn/#view=privacy" data-i18n="onboarding.legal_privacy">隐私政策</button>
                <span class="first-run-consent-and" data-i18n="onboarding.legal_consent_and">和</span>
                <button type="button" class="first-run-legal-link" data-open-external-url="https://cogseed-open.bonc.com.cn/#view=terms" data-i18n="onboarding.legal_terms">用户协议</button>
              </div>
              <button class="btn primary first-run-primary" id="first-begin" data-csnext="1" disabled><svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg><span>开始一次真实工作</span></button>
              <div class="first-run-scan" id="first-run-scan">
                <div class="first-scan-row"><i><svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"></path><path d="M20.054 15.987H3.946"></path></svg></i><div><strong data-i18n="onboarding.scan.local_agent">本机Agent</strong><p id="first-agent-copy" data-i18n="onboarding.scan.checking">正在检查可用状态</p></div><span class="status" id="first-agent-status" data-i18n="onboarding.scan.detecting">检测中</span></div>
                <div class="first-scan-row"><i><svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg></i><div><strong data-i18n="onboarding.scan.recent_work">最近工作</strong><p id="first-history-copy" data-i18n="onboarding.scan.not_read">尚未读取任何内容</p></div><span class="status" id="first-history-status" data-i18n="onboarding.scan.not_read_short">未读取</span></div>
                <div class="first-scan-row"><i><svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"></path><path d="M15 6h1v4"></path><path d="m6.134 14.768.866-.5 2 3.464"></path><circle cx="16" cy="8" r="6"></circle></svg></i><div><strong data-i18n="onboarding.scan.execution">真实执行方式</strong><p id="first-execution-copy" data-i18n="onboarding.scan.execution_check">正在确认可用Agent或体验额度</p></div><span class="status" id="first-execution-status" data-i18n="onboarding.scan.detecting">检查中</span></div>
              </div>
              <div class="first-run-route" id="first-run-route"><strong id="first-route-title" data-i18n="onboarding.route.title">推荐：继续最近一项工作</strong><p id="first-route-copy" data-i18n="onboarding.route.description">下一步只确认授权范围；授权前不会读取Session内容。</p><button class="btn primary" id="first-route-primary"><svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg><span data-i18n="onboarding.continue">继续</span></button></div>
              <div class="first-run-trust"><svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="16" r="1"></circle><rect x="3" y="10" width="18" height="12" rx="2"></rect><path d="M7 10V7a5 5 0 0 1 10 0v3"></path></svg><span data-i18n="onboarding.trust">无需CogSeed账号即可开始。本地身份默认创建；登录Hub只用于额度、同步或社区能力。</span></div>
            </div>
          </aside>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="1">
        <div class="cs-auth-main">
          <div class="eyebrow" data-i18n="onboarding.connect.eyebrow">Permission first</div>
          <h1 data-i18n="onboarding.connect.title">连接你正在使用的Agent</h1>
          <p class="cs-auth-lead" data-i18n="onboarding.connect.description">授权后，CogSeed才能从你选择的Session中恢复当前目标、确认过的能力和任务状态。未授权时只显示Agent名称与可用状态。</p>

          <div class="cs-privacy-line">
            <svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
            <div><strong data-i18n="onboarding.connect.privacy_title">不会读取全部历史，也不会接收登录凭证。</strong><br><span data-i18n="onboarding.connect.privacy_desc">默认只读、仅本次、可随时撤销；正式资产仍由你拥有。</span></div>
          </div>

          <div class="cs-route-summary">
            <div class="cs-route-chip"><span data-i18n="onboarding.connect.identity">身份</span><strong data-i18n="onboarding.connect.identity_value">本地身份 · 免登录可开始</strong></div>
            <div class="cs-route-chip"><span data-i18n="onboarding.connect.execution">本次执行</span><strong data-i18n="onboarding.connect.execution_value">本机 Agent 账号</strong></div>
            <div class="cs-route-chip"><span data-i18n="onboarding.connect.quota">CogSeed体验额度</span><strong data-i18n="onboarding.connect.quota_value">不消耗</strong><div class="cs-quota-meter"><i></i></div></div>
          </div>

          <div class="cs-list" id="cs-team-list">
            <div class="cs-state loading" data-i18n="onboarding.connect.detecting">正在检测可连接的 Agent…</div>
          </div>

          <div class="cs-auth-actions">
            <small data-i18n="onboarding.connect.action_note">点击「执行」只会把该 Agent 接入本机，授权前不会读取任何 Session 内容。</small>
            <div class="cs-auth-btns">
              <button class="cs-btn ghost" data-csnext="0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span data-i18n="common.back">返回</span></button>
              <button class="cs-btn ghost" id="cs-team-refresh" data-i18n="onboarding.refresh">重新检测</button>
              <button class="cs-btn ghost" data-csnext="2" data-i18n="onboarding.connect.skip">跳过 · 稍后再连</button>
              <button class="cs-btn" data-csnext="2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg><span data-i18n="onboarding.connect.next">下一步 · 选择起点</span></button>
            </div>
          </div>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="2">

        <!-- 子视图 A：三选一分流（默认） -->
        <div class="cs-fork" id="cs-fork-view">
          <div class="eyebrow" data-i18n="onboarding.fork.eyebrow">Continue where you left off</div>
          <h1 data-i18n="onboarding.fork.title">先让一次真实工作被准确接上</h1>
          <p class="cs-fork-lead" data-i18n="onboarding.fork.description">不用先认识资产、本体或角色。选择一个最近任务，CogSeed 只带入当前任务所需的已确认能力和接续状态。</p>

          <div class="cs-fork-layout">
            <!-- 左：从哪里继续（三选一横条） -->
            <div class="cs-fork-main">
              <h4 class="cs-fork-subhead" data-i18n="onboarding.fork.choose_title">从哪里继续？</h4>
              <p class="cs-fork-subnote" data-i18n="onboarding.fork.choose_desc">推荐选择一项已有目标和产物的任务，最容易看出 CogSeed 与普通新对话的差异。</p>

              <div class="cs-fork-cards" id="cs-fork-cards">
                <!-- 卡片①（复杂项目）由 _csLoadRecommendation 动态填充 -->
                <button type="button" class="cs-fork-card" id="cs-fork-continue" data-fork="continue" disabled>
                  <span class="f-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg></span>
                  <span class="f-body">
                    <h3 id="cs-fork-continue-title" data-i18n="onboarding.fork.loading_project">正在读取你最近的项目…</h3>
                    <p id="cs-fork-continue-desc" class="f-desc" data-i18n="onboarding.fork.loading_project_desc">自动找出你投入最多、最近还在做的项目。</p>
                    <span class="f-meta" id="cs-fork-continue-meta"></span>
                  </span>
                  <span class="f-tag" data-i18n="onboarding.recommended">推荐</span>
                </button>

                <button type="button" class="cs-fork-card" data-fork="other">
                  <span class="f-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg></span>
                  <span class="f-body">
                    <h3 data-i18n="onboarding.fork.other_title">选择其他会话</h3>
                    <p class="f-desc" data-i18n="onboarding.fork.other_desc">按 Agent、空间和时间选择一个已授权来源。</p>
                  </span>
                  <span class="f-tag muted" data-i18n="onboarding.switch">更换</span>
                </button>

                <button type="button" class="cs-fork-card" data-fork="blank">
                  <span class="f-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
                  <span class="f-body">
                    <h3 data-i18n="onboarding.fork.blank_title">从空白任务开始</h3>
                    <p class="f-desc" data-i18n="onboarding.fork.blank_desc">可以直接使用，但本次不会验证已有任务的接续效果。</p>
                  </span>
                  <span class="f-tag muted" data-i18n="onboarding.skip">跳过</span>
                </button>
              </div>
            </div>

            <!-- 右：这次会用什么（真实数据，与左侧卡片①同源，由 _csLoadRecommendation 填充） -->
            <aside class="cs-fork-side" id="cs-fork-side">
              <h4 class="cs-fork-side-title" data-i18n="onboarding.fork.side_title">这次会用什么</h4>
              <p class="cs-fork-side-note" data-i18n="onboarding.fork.side_desc">以下来自这台 Mac 上的真实检测；授权前不会读取任何 Session 正文。</p>
              <div class="cs-fork-side-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
                <div><strong data-i18n="onboarding.fork.source_agent">来源 Agent</strong><span id="cs-side-source" data-i18n="onboarding.detecting">正在检测…</span></div>
              </div>
              <div class="cs-fork-side-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <div><strong data-i18n="onboarding.fork.source_project">来源项目</strong><span id="cs-side-project" data-i18n="onboarding.reading">正在读取…</span></div>
              </div>
              <div class="cs-fork-side-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
                <div><strong data-i18n="onboarding.fork.scale">对话规模</strong><span id="cs-side-scale" data-i18n="onboarding.reading">正在读取…</span></div>
              </div>
              <div class="cs-fork-side-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>
                <div><strong data-i18n="onboarding.fork.readonly_title">最小只读范围</strong><span data-i18n="onboarding.fork.readonly_desc">不复制完整会话，不读取其他空间，不接收 Agent 密码</span></div>
              </div>
            </aside>
          </div>

          <div class="cs-actions">
            <button class="cs-btn ghost" data-csnext="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span data-i18n="common.back">返回</span></button>
          </div>
        </div>

        <!-- 子视图 B：按 Agent 导入会话（点“选择其他会话”后显示，也用于确认推荐会话后的其他导入） -->
        <div class="cs-import-sub" id="cs-import-view" style="display:none">
          <div class="cs-kicker" data-i18n="onboarding.import.kicker">只读导入 · 不写回任何 Agent</div>
          <h1 data-i18n="onboarding.import.title">从你在其他 Agent 里的对话继续</h1>
          <p class="cs-lead" data-i18n="onboarding.import.description">点左侧 Agent，勾选想导入的会话，再点「导入所选会话」</p>

          <div class="cs-import-hint">
            <span><span data-i18n="onboarding.import.count_prefix">已导入</span> <span id="cs-import-count">0</span> <span data-i18n="onboarding.import.count_suffix">条会话</span></span>
            <button type="button" class="cs-btn-inline" id="cs-do-import" style="display:none" onclick="_csDoImport()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg>
              <span data-i18n="onboarding.import.selected_sessions">导入所选会话</span>
            </button>
          </div>

          <div class="cs-list" id="cs-agent-list">
            <div class="cs-state loading" data-i18n="onboarding.detecting_local">正在检测本机 Agent…</div>
          </div>

          <div class="cs-actions">
            <button class="cs-btn ghost" id="cs-import-back-fork"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span data-i18n="onboarding.import.back">返回起点选择</span></button>
            <button class="cs-btn ghost" id="cs-agent-refresh" data-i18n="onboarding.refresh_agent">重新检测 Agent</button>
            <button class="cs-btn cs-step2-next" data-csnext="3"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg><span data-i18n="onboarding.import.organize">开始整理</span></button>
            <button class="cs-btn cs-step2-finish" id="cs-step2-finish" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg><span data-i18n="onboarding.import.finish">完成导入</span></button>
          </div>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="3">
        <div class="cs-matching" id="cs-matching-view">
          <div class="cs-matching-spinner" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          </div>
          <div class="cs-kicker" id="cs-matching-kicker" data-i18n="onboarding.matching.kicker">正在为你整理</div>
          <h1 id="cs-matching-title" data-i18n="onboarding.matching.title">正在准备你接下来要用到的东西…</h1>
          <p class="cs-lead" id="cs-matching-lead" data-i18n="onboarding.matching.description">会根据你选择的会话内容，自动为你准备好接下来要用的东西。</p>
          <div class="cs-matching-detail" id="cs-matching-detail"></div>
        </div>
      </section>

    </main>
  </div>`;
}

function _csGoStep(n) {
  const step = Math.max(0, Math.min(3, n));
  _csActiveStep = step;
  const shell = document.getElementById('cs-onboarding');
  if (!shell) {
    return;
  }
  shell.querySelectorAll('.cs-panel').forEach((p) => {
    p.classList.toggle('active', Number(p.dataset.cspanel) === step);
  });
  shell.querySelector('.cs-content')?.scrollTo?.(0, 0);
  if (step === 1) _csLoadTeam(false);
  if (step === 2) _csShowForkView();
  if (step === 3) _csShowMatchingView();
}

function _csShowMatchingView() {
  const matching = document.getElementById('cs-matching-view');
  if (matching) matching.style.display = '';
  const lead = document.getElementById('cs-matching-lead');
  _csSetMatchingLead('onboarding.matching.description', '会根据你选择的会话内容，自动为你准备好接下来要用的东西。');
  _csRunInvisibleMatching();
}

// 隐形匹配：优先复用后端匹配到的「已有真实空间」；否则按场景建/复用工作空间
// 并把导入会话绑定进去；无建议落入「临时空间」。完成后直接进入主界面。
async function _csRunInvisibleMatching() {
  const lead = document.getElementById('cs-matching-lead');

  // 优先：后端匹配到的已有真实空间（用真实工作空间复用）。
  const suggestedSpace = (_csRecommendation && _csRecommendation.suggestedSpace) || null;
  if (suggestedSpace && suggestedSpace.spaceId) {
    _csSetMatchingLead('onboarding.matching.reuse_space', '正在把你的内容归入已有的工作空间…');
    try {
      await _csEnsureWorkspaceFromScenario(null, '', suggestedSpace.name || _csT('onboarding.temporary_space', '临时空间'), suggestedSpace.spaceId);
    } catch (wsErr) {
      _obLog.warn('workspace reuse failed during matching', { error: (wsErr && wsErr.message) || String(wsErr) });
    }
    _csMatchResult = {
      spaceName: suggestedSpace.name || _csT('onboarding.temporary_space', '临时空间'),
      scenarioId: '',
      matchedTemplateId: '',
      matchedName: suggestedSpace.name || '',
      reusedSpaceId: suggestedSpace.spaceId,
    };
    await _csFinish();
    return;
  }

  // 有建议场景（「继续项目」来自 recommendStartingPoint.suggestedTemplate，
  // 后端现在返回场景建议：scenarioId + 该场景建议主模板 templateId）。
  const suggestion = (_csRecommendation && _csRecommendation.suggestedTemplate)
    || null;
  const scenarioId = suggestion && suggestion.scenarioId;
  const primaryTemplateId = suggestion && suggestion.templateId;

  // 查场景定义（名字/图标/建议主副模板），用于建空间。
  let spaceName = _csT('onboarding.temporary_space', '临时空间');
  let matchedScenario = null;
  if (scenarioId) {
    try {
      const scRes = await window.cogseed.invoke('spaces.scenarios.list', {});
      const scenarios = (scRes && scRes.scenarios) || [];
      const sc = scenarios.find((s) => s && s.scenario_id === scenarioId);
      if (sc) {
        matchedScenario = sc;
        spaceName = _csT(`ws.scenario.${scenarioId}.name`, sc.name || scenarioId);
        _csSetMatchingLead('onboarding.matching.prepare_space', '正在根据你的会话内容整理接下来要用的东西…');
      }
    } catch (scErr) {
      _obLog.warn('scenario list failed during matching', { error: (scErr && scErr.message) || String(scErr) });
    }
  } else {
    _csSetMatchingLead('onboarding.matching.organize', '正在整理你的内容…');
  }

  try {
    await _csEnsureWorkspaceFromScenario(
      matchedScenario,
      primaryTemplateId,
      spaceName,
      undefined,
      matchedScenario ? `ws.scenario.${scenarioId}.name` : 'onboarding.temporary_space',
    );
  } catch (wsErr) {
    _obLog.warn('workspace ensure failed during matching', { error: (wsErr && wsErr.message) || String(wsErr) });
  }

  _csMatchResult = {
    spaceName,
    scenarioId,
    matchedTemplateId: primaryTemplateId,
    matchedName: matchedScenario && matchedScenario.name || '',
  };

  // 匹配完成 → 直接结束引导进入主界面，不展示确认页、不要求用户手动点击。
  await _csFinish();
}

let _csMatchResult = null;

// 创建/复用工作空间并把导入会话绑定进去（隐形匹配的核心落地）。
// 有场景：按场景名建空间（场景名 + 主/副模板 + 图标），复用同名空间。
// 无场景：复用/新建「临时空间」，会话同样绑定到其下项目。
async function _csEnsureWorkspaceFromScenario(scenario, primaryTemplateId, spaceName, explicitSpaceId, systemNameKey) {
  let spaceId = '';
  // 显式指定的空间（后端已匹配到的已有真实空间）——直接复用，不再按名查找/创建。
  if (explicitSpaceId) {
    spaceId = explicitSpaceId;
    _obLog.info('reusing matched existing workspace', { spaceId, name: spaceName });
  } else {
    try {
      // 场景空间以场景名为标识（与前端「工作空间」面板一致）。按名称匹配复用，
      // 避免误命中历史遗留的同 primary_template 角色空间（如旧「产品经理」）。
      const listRes = await window.cogseed.invoke('spaces.list', {});
      const spaces = (listRes && listRes.spaces) || [];
      const bySystemName = systemNameKey && spaces.find((s) => s && s.system_name_key === systemNameKey);
      const byName = bySystemName || spaces.find((s) => s && (s.name === spaceName || s.name === (scenario && scenario.name)));
      if (byName && byName.space_id) {
        spaceId = byName.space_id;
        _obLog.info('reusing existing workspace', { primaryTemplateId, spaceId, name: spaceName });
      } else if (primaryTemplateId) {
        // 名称不匹配时，按主角色模板复用已有真实空间（最近更新的优先），
        // 避免为同一模板反复新建同质空间。
        const byTemplate = spaces
          .filter((s) => s && s.primary_template_id === primaryTemplateId)
          .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        if (byTemplate[0] && byTemplate[0].space_id) {
          spaceId = byTemplate[0].space_id;
          _obLog.info('reusing existing workspace by template', { primaryTemplateId, spaceId, name: spaceName });
        }
      }
    } catch (listErr) {
      _obLog.warn('spaces.list failed before create', { error: (listErr && listErr.message) || String(listErr) });
    }

    if (!spaceId) {
      try {
        const createRes = await window.cogseed.invoke('spaces.create', {
          name: spaceName,
          ...(systemNameKey ? { system_name_key: systemNameKey } : {}),
          primary_template_id: primaryTemplateId || undefined,
          secondary_template_ids: (scenario && scenario.suggested_secondary_template_ids) || [],
          icon: (scenario && scenario.icon) || undefined,
        });
        if (createRes && createRes.space && createRes.space.space_id) {
          spaceId = createRes.space.space_id;
          _obLog.info('created workspace', { primaryTemplateId, spaceId, name: spaceName });
        }
      } catch (createErr) {
        _obLog.warn('spaces.create failed', { error: (createErr && createErr.message) || String(createErr) });
      }
    }
  }

  if (!spaceId) return;

  // 无导入会话（「从零开始」）：空间就绪即可，不建项目分组。
  if (_csImportedConversationIds.length === 0) {
    _obLog.info('workspace ready without imported sessions', { primaryTemplateId, spaceId });
    return;
  }

  // 空间化语义：导入会话直接绑定到空间（不再经手已废弃的项目层）。
  // 逐个 conversations.setSpace（cid → spaceId），无项目建/绑/批操作。
  let boundCount = 0;
  for (const cid of _csImportedConversationIds) {
    try {
      const setRes = await window.cogseed.invoke('conversations.setSpace', { cid, spaceId });
      if (setRes && setRes.conversation) {
        boundCount += 1;
        _obLog.info('bound imported session to workspace', { cid, spaceId });
      }
    } catch (setErr) {
      _obLog.warn('conversations.setSpace failed', { cid, spaceId, error: (setErr && setErr.message) || String(setErr) });
    }
  }

  // 刷新侧边栏空间分组，让匹配出的空间对用户可见（替代原 loadProjects 展开）。
  try {
    if (typeof window.invalidateSidebarSpaces === 'function') window.invalidateSidebarSpaces();
    if (typeof renderConversationList === 'function') await renderConversationList();
  } catch (revealErr) {
    _obLog.warn('failed to reveal workspace in sidebar', { spaceId, error: (revealErr && revealErr.message) || String(revealErr) });
  }

  if (boundCount > 0) {
    _obLog.info('bound imported sessions to workspace', { primaryTemplateId, spaceId, bound: boundCount, total: _csImportedConversationIds.length });
    _csToast(_csT('onboarding.toast.sessions_organized', '已将 {count} 个导入的会话整理好', { count: boundCount }));
  }
}

// ─── Step 2 fork view (从哪里开始) ─────────────────────────────────────────
// The recommended session + its suggested template, captured when the user
// picks card ①. Consumed by step 3 to pre-select the role template and by
// _csFinish (the session is imported the moment the user confirms card ①).
let _csRecommendation = null;      // full RecommendStartResult from backend
let _csForkChoice = null;          // 'continue' | 'other' | 'blank'

// Show the three-way fork (default sub-view of step 2); kick off the real
// recommendation load in the background so card ① fills in with the user's
// actual most-invested session.
function _csShowForkView() {
  const fork = document.getElementById('cs-fork-view');
  const imp = document.getElementById('cs-import-view');
  if (fork) fork.style.display = '';
  if (imp) imp.style.display = 'none';
  _csLoadRecommendation();
}

// Reveal the by-Agent import sub-view (card ② → current import UI).
function _csShowImportView() {
  const fork = document.getElementById('cs-fork-view');
  const imp = document.getElementById('cs-import-view');
  if (fork) fork.style.display = 'none';
  if (imp) imp.style.display = '';
  _csLoadAgents(false);
}

// Fill the right-hand "这次会用什么" panel from the SAME RecommendStartResult
// that paints card ①. Every value here is cheap to obtain (source label,
// decoded project path, line-count proxy, keyword-matched template) so it
// lands in the same tick as the left card — no extra IPC, no session-body read.
function _csFillForkSide(res) {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const top = res && res.top;

  if (!top) {
    // Honest empty state mirrors card ①: nothing readable on this machine.
    set('cs-side-source', _csT('onboarding.fork.no_sessions', '未检测到可读的历史会话'));
    set('cs-side-project', _csT('onboarding.fork.browse_or_blank', '可「选择其他会话」手动浏览，或从空白开始'));
    set('cs-side-scale', '—');
    return;
  }

  // 1) Source Agent — friendly label + honest per-source total when >1 candidate.
  const agentLabel = CS_AGENT_LABELS[top.source] || top.source;
  const total = Number(res.candidateCount) || 0;
  set('cs-side-source', total > 1 ? _csT('onboarding.fork.agent_session_count', '{agent} · 本机共 {count} 个可继续会话', { agent: agentLabel, count: total }) : agentLabel);

  // 2) Source project — the real decoded working dir (last segment), never invented.
  set('cs-side-project', _csProjectDisplayName(top.projectPath, top.firstMessage));

  // 3) Conversation scale — real line/turn proxy + coarse recency.
  const when = _csRelativeTime(top.timestamp);
  const scale = _csT('onboarding.fork.conversation_scale', '约 {count} 轮对话{when}', { count: top.contextLength, when: when ? ` · ${when}` : '' });
  set('cs-side-scale', scale);
}

// Load the REAL "where to begin" recommendation and paint card ①. Never
// blocks the fork view; on empty/failure the card degrades to an honest
// "no prior sessions" state that routes into the import sub-view instead.
async function _csLoadRecommendation(force = false) {
  const card = document.getElementById('cs-fork-continue');
  const titleEl = document.getElementById('cs-fork-continue-title');
  const descEl = document.getElementById('cs-fork-continue-desc');
  const metaEl = document.getElementById('cs-fork-continue-meta');
  if (!card || !titleEl) return;
  // Avoid re-fetching if we already have a recommendation this session, but
  // still (re)paint the right panel — the user may have toggled sub-views and
  // the fresh DOM would otherwise stay stuck on the "正在检测…" placeholders.
  if (_csRecommendation && !force) { _csFillForkSide(_csRecommendation); return; }

  try {
    const res = await window.cogseed.invoke('sessionImport.recommendStartingPoint');
    _csRecommendation = res || { top: null };

    const top = res && res.top;
    if (!top) {
      // Honest empty state: no readable prior sessions anywhere.
      titleEl.textContent = _csT('onboarding.fork.no_project', '还没有可继续的项目');
      if (descEl) descEl.textContent = _csT('onboarding.fork.no_project_desc', '没检测到本机可读的历史会话。你可以直接“选择其他会话”查看，或从空白开始。');
      if (metaEl) metaEl.textContent = '';
      card.classList.add('is-empty');
      card.removeAttribute('disabled');
      _csFillForkSide(res); // right panel mirrors the same empty state
      return;
    }

    // Fire-and-forget: warm the slow read+extract half in the background the
    // moment the card resolves, so a later "继续项目" click only pays for the
    // fast write half. Read-only, best-effort — never awaited, never blocks the
    // UI, and only claude/workbuddy have a slow extract worth prefetching.
    if ((top.source === 'claude' || top.source === 'workbuddy') && top.filePath) {
      window.cogseed
        .invoke('sessionImport.prefetchRecommended', { source: top.source, filePath: top.filePath })
        .catch(() => { /* best-effort; import falls back to inline extract */ });
    }

    // Real project name = last segment of the real project path, else a
    // trimmed first-message snippet. Never invented.
    const proj = _csProjectDisplayName(top.projectPath, top.firstMessage);
    titleEl.textContent = _csT('onboarding.fork.continue_project', '继续「{project}」', { project: proj });
    if (descEl) {
      const snippet = String(top.firstMessage || '').replace(/\s+/g, ' ').slice(0, 64);
      descEl.textContent = snippet
        ? _csT('onboarding.fork.recent_topic', '最近的话题：{snippet}', { snippet: `${snippet}${snippet.length >= 64 ? '…' : ''}` })
        : _csT('onboarding.fork.continue_extract', '继续这个项目，并顺带提取其中的四类资产。');
    }
    if (metaEl) {
      const agentLabel = CS_AGENT_LABELS[top.source] || top.source;
      const when = _csRelativeTime(top.timestamp);
      // contextLength is a real turn/message proxy — label it plainly.
      metaEl.textContent = _csT('onboarding.fork.meta', '{agent} · 约 {count} 轮对话 · {when}', { agent: agentLabel, count: top.contextLength, when });
    }
    // _csRecommendation carries the suggested scenario (may be null → 临时空间).
    card.classList.remove('is-empty');
    card.removeAttribute('disabled');
    _csFillForkSide(res); // right panel, same data, same tick as card ①
  } catch (err) {
    _obLog.warn('recommendStartingPoint failed', { error: (err && err.message) || String(err) });
    titleEl.textContent = _csT('onboarding.fork.recommendation_failed', '读取推荐失败');
    if (descEl) descEl.textContent = _csT('onboarding.fork.recommendation_failed_desc', '无法读取历史会话推荐，你可以“选择其他会话”手动浏览。');
    card.classList.add('is-empty');
    card.removeAttribute('disabled');
    // Degrade the right panel honestly too, instead of leaving "正在检测…".
    _csFillForkSide({ top: null });
    const srcEl = document.getElementById('cs-side-source');
    if (srcEl) srcEl.textContent = _csT('onboarding.fork.recommendation_failed', '读取推荐失败');
  }
}

// Last path segment as the human project name; fall back to a first-message
// snippet, then a neutral label. Pure formatting of REAL values.
function _csProjectDisplayName(projectPath, firstMessage) {
  const p = String(projectPath || '').replace(/[/\\]+$/, '');
  if (p) {
    const seg = p.split(/[/\\]/).filter(Boolean).pop();
    if (seg) return seg;
  }
  const snip = String(firstMessage || '').replace(/\s+/g, ' ').trim();
  if (snip) return snip.length > 24 ? `${snip.slice(0, 24)}…` : snip;
  return _csT('onboarding.recent_session', '最近的会话');
}

// Coarse relative time from an ISO string — real timestamp, friendly text.
function _csRelativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const day = 86400000;
  if (diff < 3600000) return _csT('onboarding.time.active_now', '刚刚活跃');
  if (diff < day) return _csT('onboarding.time.today', '今天');
  const days = Math.round(diff / day);
  if (days <= 1) return _csT('onboarding.time.yesterday', '昨天');
  if (days < 7) return _csT('onboarding.time.days_ago', '{count} 天前', { count: days });
  if (days < 30) return _csT('onboarding.time.weeks_ago', '{count} 周前', { count: Math.round(days / 7) });
  if (days < 365) return _csT('onboarding.time.months_ago', '{count} 个月前', { count: Math.round(days / 30) });
  return _csT('onboarding.time.years_ago', '{count} 年前', { count: Math.round(days / 365) });
}

// Card ① confirmed: import the recommended session for real (so its four
// asset types get extracted into the candidate pool), then advance to the
// role step where the suggested template is pre-selected.
async function _csForkContinue() {
  const top = _csRecommendation && _csRecommendation.top;
  _csForkChoice = 'continue';
  if (!top) {
    // Empty/failed recommendation → nowhere to continue; go browse instead.
    _csShowImportView();
    return;
  }
  // Sticky indeterminate bar while the (unmeasurable, single-call) import runs.
  // Copy names the REAL pipeline stages so the wait reads as progress, not a
  // hang — but the bar itself claims no percentage.
  _csToastBusy(_csT('onboarding.toast.import_organize', '正在导入并整理你的会话…'));
  try {
    const convId = await _csImportOneSession(top);
    if (convId) {
      _csToastDone(_csT('onboarding.toast.recommended_imported', '已导入推荐会话，正在整理'));
    } else {
      _csToastDone(_csT('onboarding.toast.session_processed', '会话已处理，正在整理'));
    }
  } catch (err) {
    _obLog.warn('fork continue import failed', { error: (err && err.message) || String(err) });
    _csToastDone(_csT('onboarding.toast.recommended_import_failed', '导入推荐会话失败'));
  }
  _csGoStep(3);
}

// Import a single ranked candidate through the right per-agent IPC. Returns
// the new conversationId (also pushed into _csImportedConversationIds so the
// role step binds it to the created workspace). Real pipeline, no stubs.
async function _csImportOneSession(cand) {
  let res = null;
  if (cand.source === 'claude') {
    res = await window.cogseed.invoke('sessionImport.importClaudeSession', { filePath: cand.filePath });
  } else if (cand.source === 'workbuddy') {
    res = await window.cogseed.invoke('sessionImport.importWorkbuddySession', { filePath: cand.filePath, projectPath: cand.projectPath });
  } else if (cand.source === 'codex') {
    res = await window.cogseed.invoke('sessionImport.importCodexSession', { filePath: cand.filePath });
  }
  // OpenCode intentionally omitted: it has no per-session transcript import,
  // so the backend never ranks it as a continuable `top` (see recommend-start.ts).
  const convId = res && (res.conversationId || (res.materialize && res.materialize.conversationId));
  if (convId && !_csImportedConversationIds.includes(convId)) {
    _csImportedConversationIds.push(convId);
  }
  return convId || '';
}

// Renders the REAL detection result, LEFT-RIGHT layout:
// Left: Agent list (Claude, Codex, etc.)
// Right: 4 asset types for the selected agent, each showing max 3 items with "show more" button
function _csRenderAgents(entries) {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;
  const list = Array.isArray(entries) ? entries : [];
  const available = list.filter((e) => e && e.available);

  if (!available.length) {
    box.innerHTML =
      `<div class="cs-state">${_csEsc(_csT('onboarding.agent.none_installed', '未检测到任何已安装的 Agent 命令行工具（如 Claude Code、Codex）。安装后点「重新检测」即可。'))}</div>` +
      '<div class="cs-import-bar">' +
      `<button type="button" class="cs-import-btn cs-demo-btn" id="cs-demo-start">${_csEsc(_csT('onboarding.agent.preview_demo', '预览演示（合成数据 · 不计入资产）'))}</button>` +
      '<div class="cs-import-result" id="cs-demo-result"></div>' +
      '</div>';
    const demoBtn = document.getElementById('cs-demo-start');
    if (demoBtn) demoBtn.addEventListener('click', () => void _csStartDemoMode());
    return;
  }

  // Store detected agents for later use
  window._csDetectedAgents = available;

// ── L4 cold-start: anonymous demo mode ────────────────────────────────────
// No agent, no material, or user just wants a preview: run the walkthrough
// with SYNTHETIC sample data. Hard rules from the P3394 spec (§4.3 L4):
//   - demo data NEVER becomes formal assets;
//   - demo runs never count as real Aha success;
//   - every demo row is explicitly labeled "演示数据".
// This mode is purely front-end simulation — no materialize/import/candidate
// IPC is ever called, so nothing can leak into real storage.
let _csDemoMode = false;

async function _csStartDemoMode() {
  _csDemoMode = true;
  const box = document.getElementById('cs-agent-list');
  if (!box) return;

  const demoSession = (idx, title, summary, kind) => `
    <div class="cs-src cs-collapsible-item" data-demo-idx="${idx}">
      <input type="checkbox" />
      <div class="s-ico">${CS_TERMINAL_SVG}</div>
      <div>
        <strong>${_csEsc(title)}</strong>
        <small>${_csEsc(summary)}</small>
      </div>
      <small style="color:var(--cs-bud);white-space:nowrap;font-weight:700">${_csEsc(_csT('onboarding.demo.label', '演示数据'))}</small>
    </div>`;

  const demoSessions = [
    demoSession(0, _csT('onboarding.demo.session_product', 'P3394 产品讨论（示例）'), _csT('onboarding.demo.session_product_desc', '产品边界与决策规则 · 含 2 条可复用判断'), 'rule'),
    demoSession(1, _csT('onboarding.demo.session_prd', 'PRD 结构整理（示例）'), _csT('onboarding.demo.session_prd_desc', '评审场景的 PRD 固定 9 段结构 · 含 1 条模板'), 'template'),
    demoSession(2, _csT('onboarding.demo.session_continuity', '项目接续记录（示例）'), _csT('onboarding.demo.session_continuity_desc', '跨 Agent 接续的验收方法 · 含 1 条技能方法'), 'skill'),
  ];

  box.innerHTML =
    `<div class="cs-state">${_csEsc(_csT('onboarding.demo.notice', '演示模式：以下是合成样例数据，仅用于预览产品流程。不会写入任何正式资产，不计入真实使用指标。'))}</div>` +
    demoSessions.join('') +
    `<div class="cs-import-bar">
       <button type="button" class="cs-import-btn" id="cs-demo-import">${_csEsc(_csT('onboarding.demo.import', '演示导入所选会话'))}</button>
       <div class="cs-import-result" id="cs-demo-import-result"></div>
     </div>`;

  box.querySelectorAll('.cs-src input[type="checkbox"]').forEach((cb) => {
    const row = cb.closest('.cs-src');
    cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
    row.addEventListener('click', (ev) => {
      if (ev.target === cb) return;
      cb.checked = !cb.checked;
      row.classList.toggle('selected', cb.checked);
    });
  });

  const btn = document.getElementById('cs-demo-import');
  const result = document.getElementById('cs-demo-import-result');
  if (btn) btn.addEventListener('click', async () => {
    const selected = box.querySelectorAll('.cs-src input[type="checkbox"]:checked').length;
    if (!selected) {
      if (result) result.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.demo.select_first', '请先勾选要演示的会话。'))}</div>`;
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = _csT('onboarding.demo.importing', '正在演示导入并提取候选…'); }
    if (result) result.innerHTML = `<div class="cs-state loading">${_csEsc(_csT('onboarding.demo.importing', '正在演示导入并提取候选…'))}</div>`;
    await new Promise((r) => setTimeout(r, 1200));
    if (result) {
      result.innerHTML = `<div class="cs-state" style="color:var(--cs-forest-deep)">${_csEsc(_csT('onboarding.demo.done', '✓ 演示完成：提取到 3 条候选认知（1 规则 / 1 模板 / 1 技能方法）。'))}<br><b>${_csEsc(_csT('onboarding.demo.done_note', '以上均为合成演示数据，不会写入你的资产，不计入任何真实指标。'))}</b></div>`;
    }
    if (btn) { btn.disabled = false; btn.textContent = _csT('onboarding.demo.import', '演示导入所选会话'); }
    _csDemoMode = true;
  });
}

  // Build LEFT-RIGHT layout
  const leftAgents = available.map((e, idx) => {
    const label = CS_AGENT_LABELS[e.type] || e.type;
    const ver = e.version ? `v${_csEsc(e.version)}` : '';
    const isFirst = idx === 0;
    return `
      <div class="cs-agent-item${isFirst ? ' active' : ''}" data-agent="${_csEsc(e.type)}" onclick="_csSelectAgent('${_csEsc(e.type)}')">
        <div class="ai-icon">${CS_TERMINAL_SVG}</div>
        <div class="ai-info">
          <div class="ai-name">${_csEsc(label)}</div>
          <div class="ai-version">${ver}</div>
        </div>
      </div>
    `;
  }).join('');

  const html = `
    <div class="cs-import-layout">
      <div class="cs-import-header">
        <span>${_csEsc(_csT('onboarding.agent.detected_count', '检测到 {count} 个 Agent，点击查看可导入内容', { count: available.length }))}</span>
      </div>
      <div class="cs-import-body">
        <div class="cs-agent-sidebar">
          ${leftAgents}
        </div>
        <div class="cs-asset-content">
          <div class="cs-asset-panel" data-agent="loading">
            <div class="cs-state loading">${_csEsc(_csT('onboarding.common.loading', '正在加载…'))}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  box.innerHTML = html;

  // Auto-expand first agent and load its assets
  if (available.length > 0) {
    const firstAgent = available[0];
    _csLoadAgentAssets(firstAgent.type);

    // Auto-select the first agent in sidebar
    setTimeout(() => {
      const firstItem = box.querySelector('.cs-agent-item');
      if (firstItem) {
        firstItem.classList.add('active');
      }
    }, 50);
  }
}

// Switch to a different agent in the left sidebar
window._csSelectAgent = function(agentType) {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;

  // Update active state in sidebar
  box.querySelectorAll('.cs-agent-item').forEach(item => {
    item.classList.toggle('active', item.dataset.agent === agentType);
  });

  // Load this agent's assets
  _csLoadAgentAssets(agentType);
};

// Expose import functions to global scope for onclick handlers
window._csImportClaudeSessions = _csImportClaudeSessions;
window._csImportCodexSessions = _csImportCodexSessions;
window._csImportWorkbuddySessions = _csImportWorkbuddySessions;
window._csImportCodexTasks = _csImportCodexTasks;
// Kept global so other flows can reuse the walkthrough's asset-panel loader.
window._csLoadAgents = _csLoadAgents;

// Load and render all 4 asset types for one agent
function _csLoadAgentAssets(agentType) {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;

  const contentArea = box.querySelector('.cs-asset-content');
  if (!contentArea) return;

  const label = CS_AGENT_LABELS[agentType] || agentType;

  // Build asset panel: left vertical tabs + right content pane.
  // The first tab (sessions) is active by default.
  const ag = _csEsc(agentType);
  // OpenCode has no scheduler — its `todo` table is an in-session checklist,
  // so its fourth tab is honestly labeled 待办 (todos), not 定时任务.
  const tasksTabTitle = agentType === 'opencode'
    ? _csT('onboarding.asset.tab_todos', '待办')
    : _csT('onboarding.asset.tab_tasks', '定时任务');
  contentArea.innerHTML = `
    <div class="cs-asset-panel" data-agent="${ag}">
      <div class="cs-asset-tabs">
        <button type="button" class="cs-asset-tab active" data-asset="sessions" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">💬</span>
          <span class="ash-title">${_csEsc(_csT('onboarding.asset.tab_sessions', '会话'))}</span>
          <span class="ash-count" id="cs-count-${ag}-sessions"></span>
        </button>
        <button type="button" class="cs-asset-tab" data-asset="skills" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">🔧</span>
          <span class="ash-title">${_csEsc(_csT('onboarding.asset.tab_skills', '技能'))}</span>
          <span class="ash-count" id="cs-count-${ag}-skills"></span>
        </button>
        <button type="button" class="cs-asset-tab" data-asset="memory" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">🧠</span>
          <span class="ash-title">${_csEsc(_csT('onboarding.asset.tab_memory', '记忆'))}</span>
          <span class="ash-count" id="cs-count-${ag}-memory"></span>
        </button>
        <button type="button" class="cs-asset-tab" data-asset="tasks" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">⏰</span>
          <span class="ash-title">${_csEsc(tasksTabTitle)}</span>
          <span class="ash-count" id="cs-count-${ag}-tasks"></span>
        </button>
      </div>
      <div class="cs-asset-panes">
        <div class="cs-asset-section-body active" data-agent="${ag}" data-asset="sessions">
          <div class="cs-state loading">${_csEsc(_csT('onboarding.asset.reading_sessions', '正在读取会话…'))}</div>
        </div>
        <div class="cs-asset-section-body" data-agent="${ag}" data-asset="skills">
          <div class="cs-state loading">${_csEsc(_csT('onboarding.asset.reading_skills', '正在读取技能…'))}</div>
        </div>
        <div class="cs-asset-section-body" data-agent="${ag}" data-asset="memory">
          <div class="cs-state loading">${_csEsc(_csT('onboarding.asset.reading_memory', '正在读取记忆…'))}</div>
        </div>
        <div class="cs-asset-section-body" data-agent="${ag}" data-asset="tasks">
          <div class="cs-state loading">${_csEsc(_csT('onboarding.asset.reading_tasks', '正在读取…'))}</div>
        </div>
      </div>
    </div>
  `;

  // Load data for this agent
  if (agentType === 'claude') {
    void _csLoadClaudeSessions(agentType);
    void _csLoadClaudeSkills(agentType);
    void _csLoadClaudeMemory(agentType);
    _csRenderNoTasks(agentType);
  } else if (agentType === 'codex') {
    void _csLoadCodexSessions(agentType);
    void _csLoadCodexSkills(agentType);
    void _csLoadCodexMemory(agentType);
    void _csLoadCodexTasks(agentType);
  } else if (agentType === 'opencode') {
    void _csLoadOpencodeSessions(agentType);
    _csFillAssetSection(agentType, 'skills', `<div class="cs-state">${_csEsc(_csT('onboarding.asset.not_connected', '{label} 的技能读取暂未接入。', { label }))}</div>`);
    void _csLoadOpencodeMemory(agentType);
    void _csLoadOpencodeTasks(agentType);
  } else if (agentType === 'workbuddy') {
    void _csLoadWorkbuddySessions(agentType);
    _csFillAssetSection(agentType, 'skills', `<div class="cs-state">${_csEsc(_csT('onboarding.asset.not_connected', '{label} 的技能读取暂未接入。', { label, asset: _csT('onboarding.asset.tab_skills', '技能') }))}</div>`);
    _csFillAssetSection(agentType, 'memory', `<div class="cs-state">${_csEsc(_csT('onboarding.asset.not_connected', '{label} 的记忆读取暂未接入。', { label, asset: _csT('onboarding.asset.tab_memory', '记忆') }))}</div>`);
    _csRenderNoTasks(agentType);
  } else {
    _csFillAssetSection(agentType, 'sessions', `<div class="cs-state">${_csEsc(_csT('onboarding.asset.not_connected', '{label} 的会话读取暂未接入。', { label, asset: _csT('onboarding.asset.tab_sessions', '会话') }))}</div>`);
    _csFillAssetSection(agentType, 'skills', `<div class="cs-state">${_csEsc(_csT('onboarding.asset.not_connected', '{label} 的技能读取暂未接入。', { label, asset: _csT('onboarding.asset.tab_skills', '技能') }))}</div>`);
    _csFillAssetSection(agentType, 'memory', `<div class="cs-state">${_csEsc(_csT('onboarding.asset.not_connected', '{label} 的记忆读取暂未接入。', { label, asset: _csT('onboarding.asset.tab_memory', '记忆') }))}</div>`);
    _csFillAssetSection(agentType, 'tasks', `<div class="cs-state">${_csEsc(_csT('onboarding.asset.not_connected', '{label} 的定时任务读取暂未接入。', { label, asset: _csT('onboarding.asset.tab_tasks', '定时任务') }))}</div>`);
  }
}

// Toggle asset section (collapse/expand the body)
// Select an asset tab: highlight the tab and show its matching pane, hiding
// the sibling panes. Tabs and panes are paired by data-agent + data-asset.
window._csSelectAssetTab = function(tab) {
  const agent = tab.dataset.agent;
  const asset = tab.dataset.asset;
  const panel = tab.closest('.cs-asset-panel');
  if (!panel) return;

  panel.querySelectorAll('.cs-asset-tab').forEach((t) => {
    t.classList.toggle('active', t === tab);
  });
  panel.querySelectorAll('.cs-asset-section-body').forEach((body) => {
    body.classList.toggle('active', body.dataset.asset === asset && body.dataset.agent === agent);
  });
};

// Toggle "show more" button for lists (sessions/skills)
window._csToggleShowMore = function(btn, total) {
  const container = btn.parentElement;
  if (!container) return;
  const items = container.querySelectorAll('.cs-collapsible-item');
  const allVisible = Array.from(items).every((el) => el.style.display !== 'none');
  items.forEach((el, idx) => {
    if (idx >= 3) el.style.display = allVisible ? 'none' : '';
  });
  btn.textContent = allVisible
    ? _csT('onboarding.asset.more', '+ 还有 {count} 个', { count: total - 3 })
    : _csT('onboarding.common.collapse', '收起');
};

// Update asset count badge
function _csUpdateAssetCount(agentType, asset, count) {
  const badge = document.getElementById(`cs-count-${agentType}-${asset}`);
  if (badge && count > 0) {
    badge.textContent = `(${count})`;
  }
}

// Fill one agent's asset section body in the right panel.
function _csFillAssetSection(agentType, asset, html) {
  const box = document.getElementById('cs-agent-list');
  if (!box) return null;
  const body = box.querySelector(`.cs-asset-section-body[data-agent="${agentType}"][data-asset="${asset}"]`);
  // Only rewrite the section body when caller passed HTML. The import handlers
  // call this with just (agentType, asset) to GET the container reference —
  // writing `undefined` there would wipe the checked session rows before we
  // read them, silently zeroing the selection and killing the import.
  if (body && html !== undefined) body.innerHTML = html;
  return body;
}

// ── Step 1a: connect AI team ────────────────────────────────────────────────
// Detect the user's local coding CLIs (Claude Code / Codex / OpenCode /
// WorkBuddy), let the user pick which to connect into the "AI team" as a real
// member, and — only when explicitly chosen — store the API the CLI is
// currently using (read from the CLI's own config; no CC Switch involved).
async function _csLoadTeam(force) {
  const box = document.getElementById('cs-team-list');
  if (!box) return;
  if (force) box.innerHTML = `<div class="cs-state loading">${_csEsc(_csT('onboarding.connect.detecting', '正在检测可连接的 Agent…'))}</div>`;

  // 只检测本机已安装的编码 CLI（Claude Code / Codex / OpenCode / WorkBuddy），
  // 不读取 CC Switch ——「连接并存储 API」的凭据来自 CLI 自身的配置文件。
  try {
    const localClis = await _csDetectCodingClis();
    if (localClis.size) {
      _csRenderTeam(localClis);
      return;
    }
    // 本机没有任何 Agent → 直接显示「未安装，不可连接」。
    box.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.agent.not_connectable', '未检测到本机已安装的 Agent（Claude Code / Codex / OpenCode / WorkBuddy），当前不可连接。安装并登录后点「重新检测」即可。'))}</div>`;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('agent detect failed', { error: msg });
    box.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.agent.detect_failed', '检测本机 Agent 失败：{reason}。可稍后在设置的「AI 团队」里手动添加。', { reason: msg }))}</div>`;
  }
}

// Friendly agent label for a local CLI type. Reuses the shared CS_AGENT_LABELS
// map defined at the top of the module.
function _csAgentLabel(appType) {
  return CS_AGENT_LABELS[appType] || appType || _csT('onboarding.agent.other', '其他 Agent');
}

// Per-appType local coding-CLI availability, filled by _csRenderTeam and read
// by _csConnectTeam. When an appType maps to a detected local CLI (Claude /
// Codex / OpenCode / WorkBuddy), "connect" creates a CLI-backed agent so it
// shows up as a real member of the AI team.
let _csCliByAgent = {};

// appType (local CLI type) → coding-CLI runtime name. Everything here is a
// CLI the team can drive as an agent; no CC Switch involved.
function _csCodingCliForAppType(appType) {
  if (appType === 'claude' || appType === 'claude-desktop') return 'claude';
  if (appType === 'codex') return 'codex';
  if (appType === 'opencode') return 'opencode';
  if (appType === 'workbuddy') return 'workbuddy';
  return '';
}

// No-whitespace agent name for a coding CLI (the create form rejects spaces via
// _NAME_TOKEN_RE), so "Claude Code" can't be a name — use the compact brand.
function _csAgentNameForCli(cli) {
  if (cli === 'claude') return 'Claude';
  if (cli === 'codex') return 'Codex';
  if (cli === 'opencode') return 'OpenCode';
  if (cli === 'workbuddy') return 'WorkBuddy';
  return cli;
}

// Detect local coding CLIs once per connect pass. Returns a Map cli-name →
// { loggedIn, mode, endpoint? } from the real localAgents.list probe
// (file-based auth state, never guessed) + a best-effort model-endpoint probe
// so the UI can flag CLIs that route through a local proxy (e.g. CC Switch).
async function _csDetectCodingClis() {
  const found = new Map();
  try {
    const [res, epRes] = await Promise.all([
      window.cogseed.invoke('localAgents.list', { force: false }),
      window.cogseed.invoke('localAgents.cliEndpointInfo').catch(() => null),
    ]);
    const endpoints = (epRes && epRes.ok && epRes.endpoints) || {};
    const entries = (res && res.entries) || [];
    entries.forEach((e) => {
      if (!e) return;
      const cli = _csCodingCliForAppType(e.type);
      if (!cli) return;
      const ep = endpoints[cli];
      // 保留不可用 agent（available:false），引导里显示对应不可用原因；
      // 不再静默过滤，用户能一眼看到「为什么连不上」。
      found.set(cli, {
        available: !!e.available,
        error: e.error || '',
        errorDetail: e.errorDetail || '',
        loggedIn: !!(e.auth && e.auth.loggedIn),
        mode: (e.auth && e.auth.mode) || 'unknown',
        ...(ep ? { endpoint: ep } : {}),
      });
    });
  } catch (err) {
    _obLog.warn('team CLI detect failed', { error: (err && err.message) || String(err) });
  }
  return found;
}

// Create a CLI-backed team agent for `cli` if one doesn't already exist.
// Idempotent: skips when any agent already runs this CLI runtime (the user may
// have made one by hand, or we ran earlier). Returns 'created' | 'exists' |
// 'error'. Never throws — team connect must survive a create failure.
async function _csEnsureCliAgent(cli, existingAgents) {
  try {
    const already = (existingAgents || []).some((a) => {
      const rt = a && a.runtime;
      return rt && rt.kind === 'cli' && rt.cli === cli;
    });
    if (already) return 'exists';
    const res = await window.cogseed.invoke('agents.create', {
      name: _csAgentNameForCli(cli),
      description: _csT('cli_fallback.agent_description', '本机 {name} 命令行，作为 AI 团队成员执行任务', {
        name: _csAgentNameForCli(cli),
      }),
      icon: 'code',
      color: 'sage',
      runtime: { kind: 'p3394-gateway', cli },
      category: 'general',
    });
    if (res && res.agent) {
      _obLog.info('team CLI agent created', { cli, agentId: res.agent.agent_id });
      // 收口后统一经托管网关接入：创建即拉起网关（失败不影响记录，后续
      // 派发自愈会再拉）。镜像 agents.js _saveExternalAgent 的启动路径。
      try {
        await window.cogseed.invoke('p3394.external.start', { cli });
      } catch (gwErr) {
        _obLog.warn('team CLI gateway start deferred to self-heal', { cli, error: (gwErr && gwErr.message) || String(gwErr) });
      }
      return 'created';
    }
    _obLog.warn('team CLI agent create returned no agent', { cli });
    return 'error';
  } catch (err) {
    _obLog.warn('team CLI agent create failed', { cli, error: (err && err.message) || String(err) });
    return 'error';
  }
}

// Render one card PER detected local coding CLI (Claude Code, Codex,
// OpenCode, WorkBuddy) — no CC Switch, no provider/key details. Each agent
// shows a status line and a single "connect" button with the two choices
// (只连接 / 连接并存储 API).
function _csRenderTeam(localClis) {
  const box = document.getElementById('cs-team-list');
  if (!box) return;

  const clis = localClis instanceof Map ? localClis : (localClis instanceof Set ? new Map([...localClis].map((c) => [c, { loggedIn: false, mode: 'unknown' }])) : new Map());

  if (!clis.size) {
    box.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.agent.team_empty', '未检测到本机已安装的 Agent（Claude Code / Codex / OpenCode / WorkBuddy），当前不可连接。'))}</div>`;
    return;
  }

  _csCliByAgent = {};
  // Stable, friendly ordering: WorkBuddy first, then known agents, then others.
  const order = ['workbuddy', 'claude', 'codex', 'opencode'];
  const appTypes = Array.from(clis.keys()).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const rows = appTypes.map((appType) => {
    const info = clis.get(appType);
    const label = _csAgentLabel(appType);
    // Honest sign-in state from the real credential files.
    const cliAuth = info && info.loggedIn
      ? (info.mode === 'api' ? _csT('onboarding.agent.api_login', 'API 登录') : (info.mode === 'oauth' ? _csT('onboarding.agent.official_login', '官方账号登录') : _csT('onboarding.agent.logged_in', '已登录')))
      : '';
    const available = !!(info && info.available);
    // 可用：直接显示「可连接 + 执行」；不可用：把「可连接」换成对应原因。
    const status = available
      ? `<span class="status green">${_csEsc(_csT('onboarding.agent.connectable', '可连接'))}</span>`
      : `<span class="status red">${_csEsc(_csUnavailableReason(label, info))}</span>`;
    const hints = [];
    if (!available) {
      hints.push(_csT('onboarding.agent.install_refresh', '请安装或更新后重新检测'));
    } else if (cliAuth) {
      hints.push(_csT('onboarding.agent.connected_auth_hint', '执行 Agent → AI 团队（{auth}，无需 Key 即可派发任务）', { auth: cliAuth }));
    } else {
      hints.push(_csT('onboarding.agent.connected_hint', '执行 Agent → AI 团队（可派发任务）'));
    }
    // 「连接并存储 API」下拉已移除：可用 agent 直接连接。登录态/代理提示保留。
    const ep = info && info.endpoint;
    const isOAuthLogin = !!(ep && ep.configAvailable && ep.authMode === 'oauth');
    const noReadableCred = !!(ep && !ep.configAvailable);
    if (available) {
      if (isOAuthLogin) {
        hints.push(_csT('onboarding.agent.oauth_hint', '官方账号登录，CLI 使用账号能力'));
      } else if (noReadableCred) {
        hints.push(_csT('onboarding.agent.credentials_hint', '未检测到可读取的 API 凭据，请先在 CLI 中登录或配置 API'));
      }
      // Honest local-proxy hint: this CLI routes model calls through a local
      // proxy (e.g. CC Switch). It still connects — but the proxy must be
      // running when the agent is woken.
      if (ep && ep.isLocalProxy) {
        hints.push(_csT('onboarding.agent.proxy_hint', '模型走本地代理连接，使用时需保持代理运行'));
      }
    }
    const hintHtml = `<small>${_csEsc(hints.join(' · '))}</small>`;
    // 可用 → 执行按钮；不可用 → 无执行动作。
    const action = available
      ? `<div class="cs-team-actions">
        <button type="button" class="cs-team-connect cs-btn" data-app-type="${_csEsc(appType)}">${_csEsc(_csT('onboarding.agent.run', '执行'))}</button>
      </div>`
      : '';

    _csCliByAgent[appType] = _csCodingCliForAppType(appType);
    return `
      <div class="cs-src cs-team-row" data-app-type="${_csEsc(appType)}">
        <div class="s-ico">${CS_TERMINAL_SVG}</div>
        <div>
          <strong>${_csEsc(label)}</strong>
          ${hintHtml}
        </div>
        <div class="cs-team-right">${status}${action}</div>
      </div>`;
  }).join('');

  box.innerHTML = rows;

  box.querySelectorAll('.cs-team-connect').forEach((btn) => {
    btn.addEventListener('click', () => {
      const appType = btn.dataset.appType;
      void _csConnectTeam(box, appType);
    });
  });
}

/** 不可用 agent 的用户可读原因（对应 registry detectOne 的 error 类型）。 */
function _csUnavailableReason(label, info) {
  const error = String((info && info.error) || '');
  if (error === 'not_found') return _csT('onboarding.agent.not_found', '未检测到 {label}（未安装）', { label });
  if (error === 'version_too_old') return _csT('onboarding.agent.version_old', '{label} 版本过低，请升级后重试', { label });
  if (error === 'version_unknown') return _csT('onboarding.agent.version_unknown', '无法识别 {label} 版本', { label });
  return _csT('onboarding.agent.unavailable', '{label} 当前不可用', { label });
}

// Connect ONE local coding CLI into the AI team: add it as a real team member,
// and — only when the user chose 「连接并存储 API」 — store the API the CLI is
// currently using (read from the CLI's own config file; no CC Switch involved).
async function _csConnectTeam(box, appType, shouldStoreApi = false) {
  const row = box.querySelector(`.cs-team-row[data-app-type="${appType}"]`);
  const btn = row ? row.querySelector('.cs-team-connect') : null;
  const cli = _csCliByAgent[appType] || '';
  const label = _csAgentLabel(appType);

  if (!cli) {
    _csToast(_csT('onboarding.agent.connect_unavailable', '「{label}」暂无可连接的本地 Agent', { label }));
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = _csT('onboarding.agent.connecting', '连接中…'); }

  try {
    // 1) Add the local coding CLI as a real team member. Best-effort: a create
    //    failure is reported but does not undo the rest. Load existing agents
    //    once so we don't duplicate.
    let cliResult = '';
    let existing = [];
    try {
      const listRes = await window.cogseed.invoke('agents.list', {});
      existing = (listRes && listRes.agents) || [];
    } catch (err) {
      _obLog.warn('team connect: agents.list failed', { error: (err && err.message) || String(err) });
    }
    cliResult = await _csEnsureCliAgent(cli, existing);

    // 1b) Make this CLI the commander's no-API fallback preference — but only
    // when the user has not already picked one (first connected agent wins;
    // a manual choice in settings always overrides). This is what makes the
    // walkthrough promise real: "指挥官默认调用你连接的第一个 Agent 降级".
    if (cliResult === 'created' || cliResult === 'exists') {
      try {
        const fb = await window.cogseed.invoke('prefs.getCliFallback');
        if (!fb || !fb.cli) {
          const saved = await window.cogseed.invoke('prefs.setCliFallback', { cli });
          _obLog.info('team connect: set cli fallback preference', { cli, saved: saved && saved.cli });
        }
      } catch (err) {
        _obLog.warn('team connect: set cli fallback failed', { cli, error: (err && err.message) || String(err) });
      }
    }

    // 2) If user selected "connect and store", store the currently-in-use API.
    let storedApi = false;
    let storedProviderId = '';
    if (shouldStoreApi && cli) {
      try {
        const storeRes = await window.cogseed.invoke('customProviders.storeActiveCliConfig', { cli });
        if (storeRes && storeRes.ok) {
          storedApi = true;
          storedProviderId = storeRes.providerId || '';
          _obLog.info('active CLI config stored', { cli, providerId: storedProviderId });
        } else {
          _obLog.warn('active CLI config store failed', { cli, error: storeRes?.error || 'unknown' });
        }
      } catch (err) {
        _obLog.warn('active CLI config store error', { cli, error: (err && err.message) || String(err) });
      }
    }

    // 3) Bind the stored provider to the CLI agent's runtime so future spawns
    //    inject OPENAI_BASE_URL/API_KEY (or ANTHROPIC_*) via provider_env and
    //    bypass the CLI's own config — including a CC Switch local proxy. This
    //    is what makes 唤醒 agent 不依赖 CC Switch: the agent carries its own
    //    endpoint + credential.
    if (storedApi && storedProviderId) {
      try {
        const listRes = await window.cogseed.invoke('agents.list', {});
        const row = ((listRes && listRes.agents) || []).find(
          (a) => a && a.runtime && a.runtime.kind === 'p3394-gateway' && a.runtime.cli === cli,
        );
        if (row && row.agent_id) {
          const upd = await window.cogseed.invoke('agents.update', {
            agent_id: row.agent_id,
            updates: { runtime: { kind: 'p3394-gateway', cli, cli_provider_id: `cp:${storedProviderId}` } },
          });
          if (upd && upd.agent) {
            _obLog.info('cli provider bound to agent', { cli, agentId: row.agent_id, providerId: storedProviderId });
          } else {
            _obLog.warn('cli provider bind returned no agent', { cli, agentId: row.agent_id });
          }
        }
      } catch (err) {
        _obLog.warn('cli provider bind failed', { cli, error: (err && err.message) || String(err) });
      }
    }

    // Reflect the connected state on the row itself; keep it non-technical.
    if (row) {
      const statusEl = row.querySelector('.g-status');
      if (statusEl) { statusEl.textContent = _csT('onboarding.agent.connected', '已连接'); statusEl.classList.remove('off'); }
      if (btn) { btn.textContent = _csT('onboarding.agent.connected', '已连接'); btn.disabled = true; btn.classList.add('done'); }
    }

    // Honest, combined summary of what actually happened.
    const parts = [];
    if (cliResult === 'created') parts.push(_csT('onboarding.agent.created_member', '新增 1 位 CLI 成员'));
    else if (cliResult === 'exists') parts.push(_csT('onboarding.agent.existing_member', 'CLI 成员已在团队'));
    if (storedApi) parts.push(_csT('onboarding.agent.api_stored', '已存储当前正在使用的 API'));
    if (cliResult === 'error') {
      _csToast(_csT('onboarding.agent.team_error', '连接「{label}」失败，可稍后在「AI 团队」里手动新建', { label }));
    } else {
      _csToast(parts.length
        ? _csT('onboarding.agent.team_summary', '已把「{label}」连接到 AI 团队（{details}）', { label, details: parts.join('，') })
        : _csT('onboarding.agent.connected_summary', '已连接「{label}」', { label }));
    }
    _obLog.info('team connect finished', { appType, cli, cliResult, storedApi });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('team connect failed', { appType, error: msg });
    _csToast(_csT('onboarding.agent.connect_failed', '连接「{label}」失败：{reason}', { label, reason: msg }));
    if (btn) { btn.disabled = false; btn.textContent = _csT('onboarding.agent.run', '执行'); }
  }
}

async function _csLoadAgents(force) {
  // Re-detection exits demo mode: real agents beat synthetic preview data.
  _csDemoMode = false;
  const box = document.getElementById('cs-agent-list');
  if (!box) return;
  box.innerHTML = `<div class="cs-state loading">${_csEsc(_csT('onboarding.agent.detecting', '正在检测本机 Agent…'))}</div>`;
  try {
    const res = await window.cogseed.invoke('localAgents.list', { force: !!force });
    _csRenderAgents(res && res.entries);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('onboarding agent detection failed', { error: msg });
    box.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.agent.detect_failed', '检测本地 Agent 失败：{reason}。你仍可继续，稍后可在设置中重试。', { reason: msg }))}</div>`;
  }
}

async function _csLoadClaudeSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', `<div class="cs-state loading">${_csEsc(_csT('onboarding.asset.scanning_sessions', '正在扫描 {label} 会话…', { label: _csAgentLabel(agentType) }))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('localAgents.listClaudeSessions');
    const recentSessions = (res && res.sessions) || [];

    console.log('[ONBOARDING] Claude sessions - total count:', recentSessions.length);
    console.log('[ONBOARDING] Claude sessions - first 3:', recentSessions.slice(0, 3));

    if (!recentSessions.length) {
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.import.no_history_path', '未找到 {label} 历史会话。如果你使用过 {label}，会话文件可能在 {path} 目录下。', { label: 'Claude Code', path: '~/.claude/projects/' }))}</div>`;
      _csUpdateAssetCount(agentType, 'sessions', 0);
      return;
    }

    _csUpdateAssetCount(agentType, 'sessions', recentSessions.length);

    // Render sessions with checkboxes. Show all sessions (no collapse), scrollable container.
    const sessionRows = recentSessions.map((s, idx) => {
      const time = s.timestamp ? new Date(s.timestamp).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : '';
      const projectLabel = s.projectPath ? `<small>${_csEsc(s.projectPath)}</small>` : '';
      return `
        <div class="cs-src" data-session-id="${_csEsc(s.sessionId)}" data-session-path="${_csEsc(s.filePath)}" data-session-title="${_csEsc(s.firstMessage || '')}">
          <input type="checkbox" />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(s.firstMessage)}</strong>
            ${projectLabel}
          </div>
          <small style="color:var(--cs-muted);white-space:nowrap;">${_csEsc(time)}</small>
        </div>`;
    }).join('');

    // Import action bar (no toggle button, all sessions visible in scrollable container)
    container.innerHTML = `<div class="cs-session-scroll">${sessionRows}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportClaudeSessions('${_csEsc(agentType)}')">${_csEsc(_csT('onboarding.asset.import_sessions', '导入所选会话（最多 3 条）'))}</button>
         <div class="cs-import-result" id="cs-import-result-${_csEsc(agentType)}-sessions"></div>
       </div>`;

    // Wire up checkbox interactions
    container.querySelectorAll('.cs-src').forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      row.addEventListener('click', (ev) => {
        if (ev.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
      checkbox.addEventListener('change', () => {
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
    });

  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to list Claude sessions', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.import.read_failed', '读取 {label} 会话失败：{reason}', { label: 'Claude Code', reason: msg }))}</div>`;
  }
}

// ── Codex sessions: scan ~/.codex/sessions and import selected ──
async function _csLoadCodexSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', `<div class="cs-state loading">${_csEsc(_csT('onboarding.asset.scanning_sessions', '正在扫描 {label} 会话…', { label: 'Codex' }))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listCodexSessions');
    const recentSessions = (res && res.sessions) || [];

    console.log('[ONBOARDING] Codex sessions - total count:', recentSessions.length);
    console.log('[ONBOARDING] Codex sessions - first 3:', recentSessions.slice(0, 3));

    if (!recentSessions.length) {
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.import.no_history_path', '未找到 {label} 历史会话。如果你使用过 {label}，会话文件应在 {path} 目录下。', { label: 'Codex', path: '~/.codex/sessions/' }))}</div>`;
      _csUpdateAssetCount(agentType, 'sessions', 0);
      return;
    }

    _csUpdateAssetCount(agentType, 'sessions', recentSessions.length);

    // Render sessions with checkboxes. Show all sessions (no collapse), scrollable container.
    const sessionRows = recentSessions.map((s, idx) => {
      const time = s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : '';
      const cwdLabel = s.cwd ? `<small>${_csEsc(s.cwd)}</small>` : '';
      return `
        <div class="cs-src" data-session-id="${_csEsc(s.filePath)}">
          <input type="checkbox" />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(s.title)}</strong>
            ${cwdLabel}
          </div>
          <small style="color:var(--cs-muted);white-space:nowrap;">${_csEsc(time)}</small>
        </div>`;
    }).join('');

    // Import action bar (no toggle button, all sessions visible in scrollable container)
    container.innerHTML = `<div class="cs-session-scroll">${sessionRows}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportCodexSessions('${_csEsc(agentType)}')">${_csEsc(_csT('onboarding.asset.import_sessions', '导入所选会话（最多 3 条）'))}</button>
         <div class="cs-import-result" id="cs-import-result-${_csEsc(agentType)}-sessions"></div>
       </div>`;

    // Wire up checkbox interactions
    container.querySelectorAll('.cs-src').forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox) return;
      row.addEventListener('click', (ev) => {
        if (ev.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
      checkbox.addEventListener('change', () => {
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
    });

    _obLog.info('loaded Codex sessions', { count: recentSessions.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load Codex sessions', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.import.read_failed', '读取 {label} 会话失败：{reason}', { label: 'Codex', reason: msg }))}</div>`;
  }
}

// ── OpenCode sessions: scan ~/.local/share/opencode/opencode.db ──
async function _csLoadOpencodeSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', `<div class="cs-state loading">${_csEsc(_csT('onboarding.asset.scanning_sessions', '正在扫描 {label} 会话…', { label: 'OpenCode' }))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listOpencodeSessions');

    if (!res.ok) {
      const errorMsg = res.error === 'not_installed'
        ? _csT('onboarding.import.database_missing', '未找到 OpenCode 数据库（~/.local/share/opencode/opencode.db 不存在）')
        : res.error === 'bad_schema'
        ? _csT('onboarding.import.database_schema', 'OpenCode 数据库结构不兼容，可能版本不匹配')
        : _csT('onboarding.import.database_failed', '读取 OpenCode 数据库失败：{reason}', { reason: res.error });
      container.innerHTML = `<div class="cs-state">${errorMsg}</div>`;
      _csUpdateAssetCount(agentType, 'sessions', 0);
      return;
    }

    const sessions = res.sessions || [];
    console.log('[ONBOARDING] OpenCode sessions - total count:', sessions.length);

    if (!sessions.length) {
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.import.no_history', '未找到 {label} 历史会话。', { label: 'OpenCode' }))}</div>`;
      _csUpdateAssetCount(agentType, 'sessions', 0);
      return;
    }

    _csUpdateAssetCount(agentType, 'sessions', sessions.length);

    // Render sessions with checkboxes
    const sessionRows = sessions.map((s) => {
      const time = s.timeUpdated ? new Date(s.timeUpdated).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : '';
      const modelLabel = s.model ? `${s.model.providerID}/${s.model.modelID}` : '';
      const msgCount = s.messageCount > 0
        ? _csT('onboarding.import.session_count', '{count} 条消息', { count: s.messageCount })
        : _csT('onboarding.import.no_messages', '无消息');
      return `
        <div class="cs-src" data-session-id="${_csEsc(s.id)}">
          <input type="checkbox" />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(s.title)}</strong>
            <small>${_csEsc(msgCount)} · ${_csEsc(modelLabel)}</small>
          </div>
          <small style="color:var(--cs-muted);white-space:nowrap;">${_csEsc(time)}</small>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="cs-session-scroll">${sessionRows}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportOpencodeSessions('${_csEsc(agentType)}')">${_csEsc(_csT('onboarding.asset.import_sessions', '导入所选会话（最多 3 条）'))}</button>
         <div class="cs-import-result" id="cs-import-result-${_csEsc(agentType)}-sessions"></div>
       </div>`;

    // Wire up checkbox interactions
    container.querySelectorAll('.cs-src').forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox) return;
      row.addEventListener('click', (ev) => {
        if (ev.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
      checkbox.addEventListener('change', () => {
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
    });

    _obLog.info('loaded OpenCode sessions', { count: sessions.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load OpenCode sessions', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.import.read_failed', '读取 {label} 会话失败：{reason}', { label: 'OpenCode', reason: msg }))}</div>`;
  }
}

// Import selected OpenCode sessions (stub for now - will implement later)
window._csImportOpencodeSessions = async function(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions');
  if (!container) return;
  const rows = [...container.querySelectorAll('.cs-src[data-session-id]')];
  const selected = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);
  const result = document.getElementById(`cs-import-result-${agentType}-sessions`);

  if (!selected.length) {
    if (result) result.textContent = _csT('onboarding.asset.select_sessions', '请先勾选要导入的会话');
    return;
  }
  if (selected.length > 3) {
    if (result) result.textContent = _csT('onboarding.asset.max_sessions', '一次最多只能导入 3 条会话，请减少勾选数量');
    return;
  }

  if (result) result.textContent = _csT('onboarding.import.todo_developing', 'OpenCode 会话导入功能开发中…');
  _obLog.info('OpenCode session import requested', { count: selected.length });
};

// Import the user-selected Claude Code sessions into real conversations.
// Honest results: per-session ok/fail shown in the import result bar; the
// count of extracted cognitions is reported when the model produced them.
async function _csImportClaudeSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions');
  if (!container) return;
  const rows = [...container.querySelectorAll('.cs-src[data-session-id]')];
  const selected = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);
  const bar = container.querySelector('.cs-import-bar');
  const btn = bar ? bar.querySelector('.cs-import-btn') : null;
  const result = bar ? bar.querySelector('.cs-import-result') : null;
  if (!selected.length) {
    if (result) result.textContent = _csT('onboarding.asset.select_sessions', '请先勾选要导入的会话');
    return;
  }
  // Enforce 3-session limit.
  if (selected.length > 3) {
    if (result) result.textContent = _csT('onboarding.asset.max_sessions', '一次最多只能导入 3 条会话，请减少勾选数量');
    return;
  }
  if (btn) { btn.disabled = true; }
  // Each session runs one or more model turns to distill cognitions, each
  // gated by the backend's 5-slot global semaphore. Import several sessions
  // CONCURRENTLY instead of one-at-a-time so a multi-session batch finishes in
  // roughly batch/CS_IMPORT_CONCURRENCY the wall time. Progress is a live
  // completed-counter (order of completion is non-deterministic under
  // concurrency, so "n/total done" is the honest framing).
  const total = selected.length;
  let ok = 0, failed = 0, cognitions = 0, done = 0;
  const paint = () => {
    if (btn) btn.textContent = _csT('onboarding.asset.importing_button', '导入中… {done}/{total}', { done, total });
    if (result) result.textContent = _csT('onboarding.asset.importing_sessions', '正在导入并提炼认知（{done}/{total} 完成）· 大会话需要一点时间，请稍候…', { done, total });
  };
  paint();
  selected.forEach((r) => r.classList.add('importing'));
  await _csMapWithConcurrency(selected, CS_IMPORT_CONCURRENCY, async (row) => {
    const filePath = row.dataset.sessionPath;
    try {
      const res = await window.cogseed.invoke('sessionImport.importClaudeSession', { filePath });
      // Success = conversation was materialized, even if cognition extraction degraded
      if (res && res.conversationId) {
        ok++;
        _csImportedConversationIds.push(res.conversationId);
        _obLog.info('session imported successfully', {
          conversationId: res.conversationId,
          totalImported: _csImportedConversationIds.length,
          allIds: _csImportedConversationIds
        });
        if (res.cognitions) {
          cognitions += (res.cognitions.personal || 0) + (res.cognitions.rule || 0) + (res.cognitions.template || 0);
        }
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = false;
        row.classList.remove('importing');
        row.classList.add('done');
      } else {
        failed++;
        row.classList.remove('importing');
      }
    } catch (err) {
      failed++;
      row.classList.remove('importing');
      _obLog.warn('import claude session failed', { filePath, error: (err && err.message) || String(err) });
    } finally {
      done++;
      paint();
    }
  });
  if (btn) { btn.disabled = false; btn.textContent = _csT('onboarding.asset.import_sessions', '导入所选会话（最多 3 条）'); }
  if (result) {
    result.textContent = _csImportSummary(ok, failed, cognitions);
  }
  // Trigger conversation list refresh so imported sessions appear in sidebar
  if (ok > 0) {
    _csUpdateImportCount(ok);
    await _csRefreshConversationList();
    // 导入成功后重新分析会话内容并推荐模板
    try {
      const rec = await window.cogseed.invoke('sessionImport.recommendStartingPoint');
      if (rec && rec.suggestedTemplate) {
        _csRecommendation = rec;
        _obLog.info('scenario recommended after import', { scenarioId: rec.suggestedTemplate.scenarioId });
      }
    } catch (err) {
      _obLog.warn('failed to recommend template after import', { error: (err && err.message) || String(err) });
    }
  }
  _obLog.info('claude sessions import finished', { ok, failed, cognitions });
}

// ── WorkBuddy (Tencent) sessions: scan ~/.workbuddy/projects and import ──
// Mirrors the Claude flow. WorkBuddy runs the SAME extract → materialize →
// route pipeline, so imported WorkBuddy sessions become owned cognitive
// assets (candidate cognitions) exactly like Claude sessions do.
async function _csLoadWorkbuddySessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', `<div class="cs-state loading">${_csEsc(_csT('onboarding.asset.scanning_sessions', '正在扫描 {label} 会话…', { label: 'WorkBuddy' }))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listWorkbuddySessions');
    const recentSessions = (res && res.sessions) || [];

    if (!recentSessions.length) {
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.import.no_history_path', '未找到 {label} 历史会话。如果你使用过 {label}，会话文件应在 {path} 目录下。', { label: 'WorkBuddy', path: '~/.workbuddy/projects/' }))}</div>`;
      _csUpdateAssetCount(agentType, 'sessions', 0);
      return;
    }

    _csUpdateAssetCount(agentType, 'sessions', recentSessions.length);

    const sessionRows = recentSessions.map((s) => {
      const time = s.timestamp ? new Date(s.timestamp).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : '';
      const projectLabel = s.projectPath ? `<small>${_csEsc(s.projectPath)}</small>` : '';
      return `
        <div class="cs-src" data-session-id="${_csEsc(s.sessionId)}" data-session-path="${_csEsc(s.filePath)}" data-session-project="${_csEsc(s.projectPath || '')}" data-session-title="${_csEsc(s.firstMessage || '')}">
          <input type="checkbox" />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(s.firstMessage)}</strong>
            ${projectLabel}
          </div>
          <small style="color:var(--cs-muted);white-space:nowrap;">${_csEsc(time)}</small>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="cs-session-scroll">${sessionRows}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportWorkbuddySessions('${_csEsc(agentType)}')">${_csEsc(_csT('onboarding.asset.import_sessions', '导入所选会话（最多 3 条）'))}</button>
         <div class="cs-import-result" id="cs-import-result-${_csEsc(agentType)}-sessions"></div>
       </div>`;

    container.querySelectorAll('.cs-src').forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      row.addEventListener('click', (ev) => {
        if (ev.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
      checkbox.addEventListener('change', () => {
        row.classList.toggle('selected', checkbox.checked);
        _csUpdateImportButtonVisibility();
      });
    });

  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to list WorkBuddy sessions', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.import.read_failed', '读取 {label} 会话失败：{reason}', { label: 'WorkBuddy', reason: msg }))}</div>`;
  }
}

// Import the user-selected WorkBuddy sessions into real conversations,
// running the full cognition-extraction pipeline (same as Claude). Unlike the
// Claude handler, we pass the real filePath (data-session-path) and the
// picker-supplied projectPath, since WorkBuddy jsonl carries no per-line cwd.
async function _csImportWorkbuddySessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions');
  if (!container) return;
  const rows = [...container.querySelectorAll('.cs-src[data-session-id]')];
  const selected = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);
  const bar = container.querySelector('.cs-import-bar');
  const btn = bar ? bar.querySelector('.cs-import-btn') : null;
  const result = bar ? bar.querySelector('.cs-import-result') : null;
  if (!selected.length) {
    if (result) result.textContent = _csT('onboarding.asset.select_sessions', '请先勾选要导入的会话');
    return;
  }
  if (selected.length > 3) {
    if (result) result.textContent = _csT('onboarding.asset.max_sessions', '一次最多只能导入 3 条会话，请减少勾选数量');
    return;
  }
  if (btn) { btn.disabled = true; }
  const total = selected.length;
  let ok = 0, failed = 0, cognitions = 0, done = 0;
  const paint = () => {
    if (btn) btn.textContent = _csT('onboarding.asset.importing_button', '导入中… {done}/{total}', { done, total });
    if (result) result.textContent = _csT('onboarding.asset.importing_sessions', '正在导入并提炼认知（{done}/{total} 完成）· 大会话需要一点时间，请稍候…', { done, total });
  };
  paint();
  selected.forEach((r) => r.classList.add('importing'));
  await _csMapWithConcurrency(selected, CS_IMPORT_CONCURRENCY, async (row) => {
    const filePath = row.dataset.sessionPath;
    const projectPath = row.dataset.sessionProject || undefined;
    try {
      const res = await window.cogseed.invoke('sessionImport.importWorkbuddySession', { filePath, projectPath });
      if (res && res.conversationId) {
        ok++;
        _csImportedConversationIds.push(res.conversationId);
        if (res.cognitions) {
          cognitions += (res.cognitions.personal || 0) + (res.cognitions.rule || 0) + (res.cognitions.template || 0);
        }
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = false;
        row.classList.remove('importing');
        row.classList.add('done');
      } else {
        failed++;
        row.classList.remove('importing');
      }
    } catch (err) {
      failed++;
      row.classList.remove('importing');
      _obLog.warn('import workbuddy session failed', { filePath, error: (err && err.message) || String(err) });
    } finally {
      done++;
      paint();
    }
  });
  if (btn) { btn.disabled = false; btn.textContent = _csT('onboarding.asset.import_sessions', '导入所选会话（最多 3 条）'); }
  if (result) {
    result.textContent = _csImportSummary(ok, failed, cognitions);
  }
  if (ok > 0) {
    _csUpdateImportCount(ok);
    await _csRefreshConversationList();
  }
  _obLog.info('workbuddy sessions import finished', { ok, failed, cognitions });
}

// Refresh the sidebar conversation list after imported sessions land.
// A single loadConversations() can be swallowed by the renderer's in-flight
// merging when an import loop bumped the local generation mid-flight — drain
// the in-flight request first, then issue a fresh one so the imported
// conversations actually appear.
async function _csRefreshConversationList() {
  try {
    if (typeof window._markConversationListLocallyChanged === 'function') {
      window._markConversationListLocallyChanged();
    }
    if (typeof loadConversations === 'function') {
      await loadConversations();
      await loadConversations();
    }
  } catch (err) {
    _obLog.warn('failed to reload conversations', err);
  }
}

// Import the user-selected Codex sessions into real conversations.
// Simpler than Claude: no cognition extraction, just materialize the conversation.
async function _csImportCodexSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions');
  if (!container) return;
  const rows = [...container.querySelectorAll('.cs-src[data-session-id]')];
  const selected = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);
  const bar = container.querySelector('.cs-import-bar');
  const btn = bar ? bar.querySelector('.cs-import-btn') : null;
  const result = bar ? bar.querySelector('.cs-import-result') : null;
  if (!selected.length) {
    if (result) result.textContent = _csT('onboarding.asset.select_sessions', '请先勾选要导入的会话');
    return;
  }
  // Enforce 3-session limit.
  if (selected.length > 3) {
    if (result) result.textContent = _csT('onboarding.asset.max_sessions', '一次最多只能导入 3 条会话，请减少勾选数量');
    return;
  }
  if (btn) { btn.disabled = true; }
  const total = selected.length;
  let ok = 0, failed = 0, done = 0;
  const paint = () => {
    if (btn) btn.textContent = _csT('onboarding.asset.importing_button', '导入中… {done}/{total}', { done, total });
    if (result) result.textContent = _csT('onboarding.asset.importing_plain', '正在导入（{done}/{total} 完成），请稍候…', { done, total });
  };
  paint();
  selected.forEach((r) => r.classList.add('importing'));
  await _csMapWithConcurrency(selected, CS_IMPORT_CONCURRENCY, async (row) => {
    const filePath = row.dataset.sessionId;
    const title = row.querySelector('strong')?.textContent || '';
    try {
      const res = await window.cogseed.invoke('sessionImport.importCodexSession', {
        filePath,
        titleHint: title,
      });
      // Success = conversation was materialized
      if (res && res.conversationId) {
        ok++;
        _csImportedConversationIds.push(res.conversationId);
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = false;
        row.classList.remove('importing');
        row.classList.add('done');
      } else {
        failed++;
        row.classList.remove('importing');
      }
    } catch (err) {
      failed++;
      row.classList.remove('importing');
      _obLog.warn('import codex session failed', { filePath, error: (err && err.message) || String(err) });
    } finally {
      done++;
      paint();
    }
  });
  if (btn) { btn.disabled = false; btn.textContent = _csT('onboarding.asset.import_sessions', '导入所选会话（最多 3 条）'); }
  if (result) {
    result.textContent = _csImportSummary(ok, failed);
  }
  // Trigger conversation list refresh so imported sessions appear in sidebar
  if (ok > 0) {
    _csUpdateImportCount(ok);
    await _csRefreshConversationList();
    // 导入成功后重新分析会话内容并推荐模板
    try {
      const rec = await window.cogseed.invoke('sessionImport.recommendStartingPoint');
      if (rec && rec.suggestedTemplate) {
        _csRecommendation = rec;
        _obLog.info('scenario recommended after import', { scenarioId: rec.suggestedTemplate.scenarioId });
      }
    } catch (err) {
      _obLog.warn('failed to recommend template after import', { error: (err && err.message) || String(err) });
    }
  }
  _obLog.info('codex sessions import finished', { ok, failed });
}

// ── Skills: scan ~/.claude/skills and import selected into the skill library ──
async function _csLoadClaudeSkills(agentType) {
  console.log('[CLAUDE SKILLS] _csLoadClaudeSkills called for agentType:', agentType);
  const container = _csFillAssetSection(agentType, 'skills', `<div class="cs-state loading">${_csEsc(_csT('onboarding.asset.scanning_skills', '正在扫描 {label} 技能…', { label: 'Claude Code' }))}</div>`);
  if (!container) {
    console.log('[CLAUDE SKILLS] No container found, aborting');
    return;
  }

  try {
    console.log('[CLAUDE SKILLS] Invoking sessionImport.listClaudeSkills...');
    const res = await window.cogseed.invoke('sessionImport.listClaudeSkills');
    console.log('[CLAUDE SKILLS] IPC result:', res);
    const skills = (res && res.skills) || [];
    console.log('[CLAUDE SKILLS] Parsed skills array:', skills.length, 'items');

    if (!skills.length) {
      console.log('[CLAUDE SKILLS] No skills found, showing empty state');
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.no_skills_path', '未在本机找到 {label} 技能（{path} 为空或不存在）。', { label: 'Claude Code', path: '~/.claude/skills' }))}</div>`;
      return;
    }
    console.log('[CLAUDE SKILLS] Rendering', skills.length, 'skills');

    const rows = skills.map((s, idx) => {
      const desc = s.description ? `<small>${_csEsc(s.description)}</small>` : '';
      const hidden = idx >= 3 ? ' style="display:none"' : '';
      return `
        <div class="cs-src cs-collapsible-item"${hidden} data-skill-dir="${_csEsc(s.dirName)}">
          <input type="checkbox" checked />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(s.name)}</strong>
            ${desc}
          </div>
        </div>`;
    }).join('');

    const toggleBtn = skills.length > 3
      ? `<button type="button" class="cs-toggle-more" data-target="skills-${_csEsc(agentType)}">${_csEsc(_csT('onboarding.asset.show_all', '显示全部 {count} 个技能', { count: skills.length }))}</button>`
      : '';

    container.innerHTML = rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-skill-import-btn" data-agent="${_csEsc(agentType)}">${_csEsc(_csT('onboarding.asset.import_skills', '导入所选技能'))}</button>
         <div class="cs-import-result cs-skill-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    // Wire up show-more toggle.
    const moreBtn = container.querySelector('.cs-toggle-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        const items = container.querySelectorAll('.cs-collapsible-item');
        const allVisible = Array.from(items).every((el) => el.style.display !== 'none');
        items.forEach((el, idx) => {
          if (idx >= 3) el.style.display = allVisible ? 'none' : '';
        });
        moreBtn.textContent = allVisible
          ? _csT('onboarding.asset.show_all', '显示全部 {count} 个技能', { count: skills.length })
          : _csT('onboarding.common.collapse', '收起');
      });
    }

    container.querySelectorAll('.cs-src[data-skill-dir]').forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      row.classList.toggle('selected', checkbox.checked);
      row.addEventListener('click', (ev) => {
        if (ev.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        row.classList.toggle('selected', checkbox.checked);
      });
      checkbox.addEventListener('change', () => row.classList.toggle('selected', checkbox.checked));
    });

    const btn = container.querySelector('.cs-skill-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportSelectedSkills(container));

    // Update count badge
    const badge = document.getElementById(`cs-count-${agentType}-skills`);
    if (badge) badge.textContent = `(${skills.length})`;

    console.log('[CLAUDE SKILLS] Successfully rendered all skills');
    _obLog.info('loaded Claude skills', { count: skills.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    console.error('[CLAUDE SKILLS] Error loading skills:', err);
    _obLog.warn('failed to load Claude skills', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.common.scan_failed', '扫描失败：{reason}', { reason: msg }))}</div>`;
  }
}

async function _csImportSelectedSkills(container) {
  const btn = container.querySelector('.cs-skill-import-btn');
  const resultBox = container.querySelector('.cs-skill-result');
  if (!resultBox) return;

  const dirNames = [];
  container.querySelectorAll('.cs-src[data-skill-dir] input[type="checkbox"]:checked').forEach((cb) => {
    const row = cb.closest('.cs-src');
    if (row && row.dataset.skillDir) dirNames.push(row.dataset.skillDir);
  });

  if (!dirNames.length) {
    resultBox.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.select_skills', '请先勾选要导入的技能。'))}</div>`;
    return;
  }

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">${_csEsc(_csT('onboarding.asset.importing_skills', '正在导入 {count} 个技能…', { count: dirNames.length }))}</div>`;

  // Determine which agent type this is (Claude or Codex) based on the button's data-agent attribute
  const agentType = btn.dataset.agent;
  const ipcMethod = agentType === 'codex' ? 'sessionImport.importCodexSkills' : 'sessionImport.importClaudeSkills';

  try {
    const res = await window.cogseed.invoke(ipcMethod, { dirNames });
    const okCount = (res && res.okCount) || 0;
    const failCount = (res && res.failCount) || 0;
    const imported = (res && res.imported) || [];
    const lines = imported.map((r) => {
      if (r.ok) return `✓ ${_csEsc(r.name)}：${_csEsc(_csT('onboarding.asset.imported', '已导入'))}`;
      if (r.reason === 'already_exists') return `• ${_csEsc(r.name)}：${_csEsc(_csT('onboarding.asset.already_exists', '已存在，跳过'))}`;
      return `✗ ${_csEsc(r.name)}：${_csEsc(_csT('onboarding.asset.import_failed_reason', '导入失败（{reason}）', { reason: r.reason || _csT('onboarding.common.unknown', '未知原因') }))}`;
    });
    const summary =
      `<div class="cs-state">${_csEsc(_csT('onboarding.asset.skills_done', '技能导入完成：成功 {success} 个{failedPart}。导入的技能已进入你的技能库。', {
        success: okCount,
        failedPart: failCount ? _csT('onboarding.asset.failed_part', '，失败 {count} 个', { count: failCount }) : '',
      }))}</div>`;
    resultBox.innerHTML = summary + `<div class="cs-import-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
    _obLog.info('skill import finished', { agentType, okCount, failCount });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('skill import failed', { agentType, error: msg });
    resultBox.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.asset.import_error', '导入技能失败：{reason}', { reason: msg }))}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Codex Skills ────────────────────────────────────────────────────────────
async function _csLoadCodexSkills(agentType) {
  console.log('[CODEX SKILLS] _csLoadCodexSkills called for agentType:', agentType);
  const container = _csFillAssetSection(agentType, 'skills', `<div class="cs-state loading">${_csEsc(_csT('onboarding.asset.scanning_skills', '正在扫描 {label} 技能…', { label: 'Codex' }))}</div>`);
  if (!container) {
    console.log('[CODEX SKILLS] No container found, aborting');
    return;
  }

  try {
    console.log('[CODEX SKILLS] Invoking sessionImport.listCodexSkills...');
    const res = await window.cogseed.invoke('sessionImport.listCodexSkills');
    console.log('[CODEX SKILLS] IPC result:', res);
    const skills = (res && res.skills) || [];
    console.log('[CODEX SKILLS] Parsed skills array:', skills.length, 'items');

    if (!skills.length) {
      console.log('[CODEX SKILLS] No skills found, showing empty state');
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.no_skills_path', '未在本机找到 {label} 技能（{path} 为空或不存在）。', { label: 'Codex', path: '~/.codex/skills/.system' }))}</div>`;
      return;
    }
    console.log('[CODEX SKILLS] Rendering', skills.length, 'skills');

    const rows = skills.map((s, idx) => {
      const desc = s.description ? `<small>${_csEsc(s.description)}</small>` : '';
      const hidden = idx >= 3 ? ' style="display:none"' : '';
      return `
        <div class="cs-src cs-collapsible-item"${hidden} data-skill-dir="${_csEsc(s.dirName)}">
          <input type="checkbox" checked />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(s.name)}</strong>
            ${desc}
          </div>
        </div>`;
    }).join('');

    const toggleBtn = skills.length > 3
      ? `<button type="button" class="cs-toggle-more" data-target="skills-${_csEsc(agentType)}">${_csEsc(_csT('onboarding.asset.show_all', '显示全部 {count} 个技能', { count: skills.length }))}</button>`
      : '';

    container.innerHTML = rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-skill-import-btn" data-agent="${_csEsc(agentType)}">${_csEsc(_csT('onboarding.asset.import_skills', '导入所选技能'))}</button>
         <div class="cs-import-result cs-skill-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    // Wire up show-more toggle.
    const moreBtn = container.querySelector('.cs-toggle-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        const items = container.querySelectorAll('.cs-collapsible-item');
        const allVisible = Array.from(items).every((el) => el.style.display !== 'none');
        items.forEach((el, idx) => {
          if (idx >= 3) el.style.display = allVisible ? 'none' : '';
        });
        moreBtn.textContent = allVisible
          ? _csT('onboarding.asset.show_all', '显示全部 {count} 个技能', { count: skills.length })
          : _csT('onboarding.common.collapse', '收起');
      });
    }

    container.querySelectorAll('.cs-src[data-skill-dir]').forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      row.classList.toggle('selected', checkbox.checked);
      row.addEventListener('click', (ev) => {
        if (ev.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        row.classList.toggle('selected', checkbox.checked);
      });
      checkbox.addEventListener('change', () => row.classList.toggle('selected', checkbox.checked));
    });

    const btn = container.querySelector('.cs-skill-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportSelectedSkills(container));

    // Update count badge
    const badge = document.getElementById(`cs-count-${agentType}-skills`);
    if (badge) badge.textContent = `(${skills.length})`;

    console.log('[CODEX SKILLS] Successfully rendered all skills');
    _obLog.info('loaded Codex skills', { count: skills.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    console.error('[CODEX SKILLS] Error loading skills:', err);
    _obLog.warn('failed to load Codex skills', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.common.scan_failed', '扫描失败：{reason}', { reason: msg }))}</div>`;
  }
}

// ── Memory: Claude Code keeps memory in FOUR places under ~/.claude. We
//    preview each source separately (instructions / rules / auto / history),
//    let the user pick which to import, and route everything into the shared
//    knowledge tier. Absent sources show an honest empty state, not a hidden gap.
function _csMemoryReason(reason) {
  const key = {
    not_found: 'onboarding.memory.reason_not_found',
    unreadable: 'onboarding.memory.reason_unreadable',
    too_large: 'onboarding.memory.reason_too_large',
    empty: 'onboarding.memory.reason_empty',
  }[reason];
  return key ? _csT(key, '不可用') : _csT('onboarding.agent.unavailable', '当前不可用');
}

async function _csLoadClaudeMemory(agentType) {
  const container = _csFillAssetSection(agentType, 'memory', `<div class="cs-state loading">${_csEsc(_csT('onboarding.asset.reading_memory', '正在读取记忆…'))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.readClaudeMemories');
    const sources = (res && res.sources) || [];
    const total = (res && res.totalEntries) || 0;

    if (!sources.length) {
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.memory.no_sources', '未检测到 Claude Code 记忆文件。记忆来自 Claude Code 使用中自动生成的 CLAUDE.md、MEMORY.md、项目 memory 等文件——先用 Claude Code 工作一段时间，或手动在 ~/.claude/ 下创建这些文件后，这里会出现可导入的记忆。'))}</div>`;
      return;
    }

    // One block per source: checkbox + label + count + sample. Present sources
    // are checked by default; absent ones show the honest reason and disable.
    const blocks = sources.map((s) => {
      const present = !!s.present;
      const reason = !present ? _csMemoryReason(s.reason) : '';
      const detail = s.detail ? `（${_csEsc(s.detail)}）` : '';
      const sample = present && (s.sample || []).length
        ? `<div class="cs-import-lines">${(s.sample || []).map((x) => `<div>${_csEsc(x)}</div>`).join('')}${s.entryCount > (s.sample || []).length ? '<div>…</div>' : ''}</div>`
        : '';
      const meta = present
        ? _csT('onboarding.memory.entry_count', '{count} 条{detail}', { count: s.entryCount, detail })
        : `<span class="cs-mem-absent">${_csEsc(reason)}</span>`;
      return `<div class="cs-mem-source ${present ? '' : 'absent'}">
          <label class="cs-mem-src-head">
            <input type="checkbox" class="cs-mem-src" data-key="${_csEsc(s.key)}" ${present ? 'checked' : 'disabled'}>
            <span class="cs-mem-src-label">${_csEsc(s.label)}</span>
            <span class="cs-mem-src-meta">${meta}</span>
          </label>
          ${sample}
        </div>`;
    }).join('');

    const canImport = total > 0;
    container.innerHTML =
      `<div class="cs-state">${_csEsc(_csT('onboarding.memory.summary', 'Claude Code 的记忆分布在七个来源，共检测到 {count} 条可导入条目。选择要导入的来源，导入后进入共享知识库，供各 Agent 使用。', { count: total }))}</div>` +
      `<div class="cs-mem-sources">${blocks}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-mem-import-btn" data-agent="${_csEsc(agentType)}" ${canImport ? '' : 'disabled'}>${_csEsc(_csT('onboarding.memory.import', '导入所选记忆'))}</button>
         <div class="cs-import-result cs-mem-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    const btn = container.querySelector('.cs-mem-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportClaudeMemory(container));

    _obLog.info('previewed Claude memory sources', { total, sources: sources.map((s) => `${s.key}:${s.entryCount}`) });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to read Claude memory sources', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.memory.read_failed', '读取记忆失败：{reason}', { reason: msg }))}</div>`;
  }
}

async function _csImportClaudeMemory(container) {
  const btn = container.querySelector('.cs-mem-import-btn');
  const resultBox = container.querySelector('.cs-mem-result');
  if (!resultBox) return;

  const sourceKeys = Array.from(container.querySelectorAll('.cs-mem-src:checked'))
    .map((el) => el.getAttribute('data-key'))
    .filter(Boolean);
  if (!sourceKeys.length) {
    resultBox.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.select_memory', '请至少勾选一个记忆来源。'))}</div>`;
    return;
  }

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">${_csEsc(_csT('onboarding.asset.importing_memory', '正在导入记忆…'))}</div>`;

  try {
    const res = await window.cogseed.invoke('sessionImport.importClaudeMemories', { sourceKeys });
    if (!res || !res.ok) {
      const reason = (res && res.reason) || _csT('onboarding.common.unknown', '未知原因');
      resultBox.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.memory.import_failed', '导入记忆失败：{reason}', { reason }))}</div>`;
      if (btn) btn.disabled = false;
      return;
    }
    const added = res.added || 0;
    const skipped = res.skipped || 0;
    const rejected = res.rejected || 0;
    resultBox.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.memory.import_done', '记忆导入完成：新增 {added} 条{skippedPart}{rejectedPart}。已进入共享知识库。', {
      added,
      skippedPart: skipped ? _csT('onboarding.memory.skipped_part', '，已存在跳过 {count} 条', { count: skipped }) : '',
      rejectedPart: rejected ? _csT('onboarding.memory.rejected_part', '，被安全校验拦截 {count} 条', { count: rejected }) : '',
    }))}</div>`;
    _csToast(_csT('onboarding.memory.toast', '已导入 {count} 条记忆到知识库', { count: added }));
    _obLog.info('memory import finished', { added, skipped, rejected, perSource: res.perSource });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('memory import failed', { error: msg });
    resultBox.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.memory.import_failed', '导入记忆失败：{reason}', { reason: msg }))}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Codex memory: read config.toml preferences and import into shared memory ──
async function _csLoadCodexMemory(agentType) {
  const container = _csFillAssetSection(agentType, 'memory', `<div class="cs-state loading">${_csEsc(_csT('onboarding.memory.reading_config', '正在读取 {label} 配置…', { label: 'Codex' }))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.readCodexMemory');
    const present = res && res.present;
    const entries = (res && res.entries) || [];

    if (!present || !entries.length) {
      const reason = res.reason === 'not_found'
        ? _csT('onboarding.memory.config_missing', '未找到 config.toml')
        : _csT('onboarding.memory.config_empty', '配置文件为空');
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.memory.codex_empty', 'Codex 配置记忆（~/.codex/config.toml）{reason}。', { reason }))}</div>`;
      return;
    }

    const sample = entries.slice(0, 5).map((e) => `<div>${_csEsc(e)}</div>`).join('');
    const more = entries.length > 5 ? '<div>…</div>' : '';

    container.innerHTML =
      `<div class="cs-state">${_csEsc(_csT('onboarding.memory.codex_summary', '从 Codex config.toml 检测到 {count} 条配置偏好。导入后进入共享知识库。', { count: entries.length }))}</div>` +
      `<div class="cs-import-lines">${sample}${more}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-codex-mem-import-btn" data-agent="${_csEsc(agentType)}">${_csEsc(_csT('onboarding.memory.import_config', '导入 Codex 配置'))}</button>
         <div class="cs-import-result cs-codex-mem-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    const btn = container.querySelector('.cs-codex-mem-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportCodexMemory(container));

    _obLog.info('previewed Codex memory', { count: entries.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to read Codex memory', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.memory.read_config_failed', '读取 Codex 配置失败：{reason}', { reason: msg }))}</div>`;
  }
}

async function _csImportCodexMemory(container) {
  const btn = container.querySelector('.cs-codex-mem-import-btn');
  const resultBox = container.querySelector('.cs-codex-mem-result');
  if (!resultBox) return;

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">${_csEsc(_csT('onboarding.memory.importing_config', '正在导入 Codex 配置…'))}</div>`;

  try {
    const res = await window.cogseed.invoke('sessionImport.importCodexMemory');
    if (!res || !res.ok) {
      const reason = (res && res.reason) || _csT('onboarding.common.unknown', '未知原因');
      resultBox.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.memory.import_failed_short', '导入失败：{reason}', { reason }))}</div>`;
      if (btn) btn.disabled = false;
      return;
    }
    const added = res.added || 0;
    const skipped = res.skipped || 0;
    const rejected = res.rejected || 0;
    resultBox.innerHTML = `<div style="color:var(--cs-forest-deep);font-size:12px;margin-top:8px;">${_csEsc(_csT('onboarding.memory.config_done', '✓ 成功导入 {added} 条配置偏好{skippedPart}{rejectedPart}', {
      added,
      skippedPart: skipped ? _csT('onboarding.memory.config_skipped', '，跳过 {count} 条已存在', { count: skipped }) : '',
      rejectedPart: rejected ? _csT('onboarding.memory.config_rejected', '，拒绝 {count} 条无效条目', { count: rejected }) : '',
    }))}</div>`;
    _obLog.info('imported Codex memory', { added, skipped, rejected });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to import Codex memory', { error: msg });
    resultBox.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.memory.import_failed_short', '导入失败：{reason}', { reason: msg }))}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Scheduled tasks: Claude Code has no native on-disk scheduled-task store. ──
// We show an honest "no native source" state rather than misreading its
// per-session TODO files (~/.claude/tasks/) as scheduled tasks.
function _csRenderNoTasks(agentType) {
  _csFillAssetSection(agentType, 'tasks',
    `<div class="cs-state">${_csEsc(_csT('onboarding.tasks.no_native', 'Claude Code 没有原生的定时任务存储，暂无可导入的定时任务。你可以在本应用的「定时任务」模块里直接新建。'))}</div>`);
}

// ── OpenCode memory: config preferences from opencode.json/.jsonc ─────────
async function _csLoadOpencodeMemory(agentType) {
  const container = _csFillAssetSection(agentType, 'memory', `<div class="cs-state loading">${_csEsc(_csT('onboarding.memory.reading_config', '正在读取 {label} 配置…', { label: 'OpenCode' }))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.readOpencodeMemory');
    const present = res && res.present;
    const entries = (res && res.entries) || [];

    if (!present || !entries.length) {
      const reasonText = res && res.reason === 'not_found'
        ? _csT('onboarding.memory.opencode_missing', '未找到 opencode.json / opencode.jsonc 配置文件')
        : _csT('onboarding.memory.opencode_empty', '配置文件为空（没有可导入的模型/指令偏好）');
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.memory.opencode_empty_state', 'OpenCode 配置记忆（~/.config/opencode/opencode.json）{reason}。配置了模型提供商或全局指令后，这里会出现可导入的偏好。', { reason: reasonText }))}</div>`;
      return;
    }

    const sample = entries.slice(0, 5).map((e) => `<div>${_csEsc(e)}</div>`).join('');
    const more = entries.length > 5 ? '<div>…</div>' : '';

    container.innerHTML =
      `<div class="cs-state">${_csEsc(_csT('onboarding.memory.opencode_summary', '从 OpenCode 配置检测到 {count} 条偏好。导入后进入共享知识库。', { count: entries.length }))}</div>` +
      `<div class="cs-import-lines">${sample}${more}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-codex-mem-import-btn" data-agent="${_csEsc(agentType)}">${_csEsc(_csT('onboarding.memory.import_opencode', '导入 OpenCode 配置'))}</button>
         <div class="cs-import-result cs-codex-mem-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    const btn = container.querySelector('.cs-codex-mem-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportCodexMemory(container));

    _obLog.info('previewed OpenCode memory', { count: entries.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to read OpenCode memory', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.memory.read_config_failed', '读取 OpenCode 配置失败：{reason}', { reason: msg }))}</div>`;
  }
}

// OpenCode has no scheduled-task feature (its `todo` table is an in-session
// task checklist). We surface the REAL todos and import them as one-time
// tasks — honestly labeled, never a fabricated cadence.
async function _csLoadOpencodeTasks(agentType) {
  const container = _csFillAssetSection(agentType, 'tasks', `<div class="cs-state loading">${_csEsc(_csT('onboarding.tasks.reading_opencode', '正在读取 OpenCode 任务清单…'))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listOpencodeTodos');
    const todos = (res && res.todos) || [];

    if (!todos.length) {
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.tasks.opencode_empty', 'OpenCode 没有定时任务功能；其会话内任务清单（todo）也是空的。'))}</div>`;
      return;
    }

    const statusLabel = (s) => (s === 'completed'
      ? _csT('onboarding.tasks.status_completed', '已完成')
      : (s === 'in_progress' ? _csT('onboarding.tasks.status_in_progress', '进行中') : _csEsc(s || _csT('onboarding.asset.tab_todos', '待办'))));
    const rows = todos.map((t, idx) => {
      const hidden = idx >= 3 ? ' style="display:none"' : '';
      const src = t.sessionTitle ? `<small>${_csEsc(_csT('onboarding.tasks.from_session', '来自会话：{title}', { title: t.sessionTitle }))}</small>` : '';
      return `
        <div class="cs-src cs-collapsible-item"${hidden} data-todo-id="${_csEsc(t.id)}">
          <input type="checkbox" />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(t.content)}</strong>
            ${src}
          </div>
            <small style="color:var(--cs-muted);white-space:nowrap;">${_csEsc(statusLabel(t.status))}</small>
        </div>`;
    }).join('');

    const toggleBtn = todos.length > 3
      ? `<button type="button" class="cs-toggle-more">${_csEsc(_csT('onboarding.tasks.show_all', '显示全部 {count} 条任务', { count: todos.length }))}</button>`
      : '';

    container.innerHTML =
      `<div class="cs-state">${_csEsc(_csT('onboarding.tasks.opencode_summary', '检测到 {count} 条 OpenCode 任务清单（todo，无定时调度）。勾选后导入为一次性任务，执行时间默认为 1 小时后，可在「任务」模块调整。', { count: todos.length }))}</div>` +
      rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportOpencodeTodos('${_csEsc(agentType)}')">${_csEsc(_csT('onboarding.asset.import_tasks', '导入所选任务'))}</button>
         <div class="cs-import-result"></div>
       </div>`;

    container.querySelectorAll('.cs-src input[type="checkbox"]').forEach((cb) => {
      const row = cb.closest('.cs-src');
      cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
      row.addEventListener('click', (ev) => {
        if (ev.target === cb) return;
        cb.checked = !cb.checked;
        row.classList.toggle('selected', cb.checked);
      });
    });

    const moreBtn = container.querySelector('.cs-toggle-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        const items = container.querySelectorAll('.cs-collapsible-item');
        const allVisible = Array.from(items).every((el) => el.style.display !== 'none');
        items.forEach((el, idx) => { if (idx >= 3) el.style.display = allVisible ? 'none' : ''; });
        moreBtn.textContent = allVisible
          ? _csT('onboarding.tasks.show_all', '显示全部 {count} 条任务', { count: todos.length })
          : _csT('onboarding.common.collapse', '收起');
      });
    }

    const badge = document.getElementById(`cs-count-${agentType}-tasks`);
    if (badge) badge.textContent = `(${todos.length})`;

    _obLog.info('loaded OpenCode todos', { count: todos.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load OpenCode todos', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.tasks.read_failed', '读取 OpenCode 任务清单失败：{reason}', { reason: msg }))}</div>`;
  }
}

// Import the user-selected OpenCode todos as one-time tasks.
async function _csImportOpencodeTodos(agentType) {
  const container = _csFillAssetSection(agentType, 'tasks');
  if (!container) return;
  const rows = [...container.querySelectorAll('.cs-src[data-todo-id]')];
  const selected = rows
    .filter((r) => r.querySelector('input[type="checkbox"]')?.checked)
    .map((r) => r.dataset.todoId)
    .filter(Boolean);
  const bar = container.querySelector('.cs-import-bar');
  const btn = bar ? bar.querySelector('.cs-import-btn') : null;
  const resultBox = bar ? bar.querySelector('.cs-import-result') : null;
  if (!selected.length) {
    if (resultBox) resultBox.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.select_tasks', '请先勾选要导入的任务。'))}</div>`;
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = _csT('onboarding.tasks.importing', '导入中…'); }
  if (resultBox) resultBox.innerHTML = `<div class="cs-state loading">${_csEsc(_csT('onboarding.tasks.importing_selected', '正在导入所选任务…'))}</div>`;
  try {
    const res = await window.cogseed.invoke('sessionImport.importOpencodeTodos', { todoIds: selected });
    const r = res || {};
    const parts = [_csT('onboarding.tasks.success_count', '成功 {count} 条', { count: r.imported || 0 })];
    if (r.skipped) parts.push(_csT('onboarding.tasks.skipped_count', '跳过 {count} 条', { count: r.skipped }));
    if (r.failed) parts.push(_csT('onboarding.tasks.failed_count', '失败 {count} 条', { count: r.failed }));
    resultBox.innerHTML =
      `<div class="cs-state">${_csEsc(_csT('onboarding.tasks.opencode_done', '导入完成：{details}。已作为一次性任务加入「任务」模块（默认 1 小时后执行，可调整）。', { details: parts.join('，') }))}</div>`;
    selected.forEach((id) => {
      const row = container.querySelector(`.cs-src[data-todo-id="${id}"]`);
      if (row) { row.classList.add('done'); const cb = row.querySelector('input[type="checkbox"]'); if (cb) cb.checked = false; }
    });
    _obLog.info('opencode todos import finished', { selected: selected.length, result: r });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('opencode todos import failed', { error: msg });
    if (resultBox) resultBox.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.tasks.import_failed', '导入任务失败：{reason}', { reason: msg }))}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = _csT('onboarding.asset.import_tasks', '导入所选任务'); }
  }
}

// Format an epoch-ms timestamp as a short local datetime, or a dash when null.
function _csFmtTaskTime(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
  try {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return '—'; }
}

// Turn a subset of iCal RRULE into a human-readable Chinese cadence. Falls back
// to the raw rule for shapes we don't specially handle.
function _csFmtRRule(rrule) {
  if (!rrule) return '';
  const parts = {};
  rrule.split(';').forEach((seg) => {
    const [k, v] = seg.split('=');
    if (k && v) parts[k.trim().toUpperCase()] = v.trim();
  });
  const freq = parts.FREQ;
  const interval = parseInt(parts.INTERVAL || '1', 10) || 1;
  const freqLabel = {
    HOURLY: _csT('onboarding.tasks.freq.hour', '小时'),
    DAILY: _csT('onboarding.tasks.freq.day', '天'),
    WEEKLY: _csT('onboarding.tasks.freq.week', '周'),
    MONTHLY: _csT('onboarding.tasks.freq.month', '月'),
    MINUTELY: _csT('onboarding.tasks.freq.minute', '分钟'),
  }[freq];
  if (!freqLabel) return rrule;
  return _csT('onboarding.tasks.every', interval > 1 ? '每 {interval} {unit}' : '每{unit}', { interval, unit: freqLabel });
}

// ── Codex scheduled tasks: read from ~/.codex/sqlite/codex-dev.db automations.
async function _csLoadCodexTasks(agentType) {
  const container = _csFillAssetSection(agentType, 'tasks', `<div class="cs-state loading">${_csEsc(_csT('onboarding.tasks.reading_codex', '正在读取 Codex 定时任务…'))}</div>`);
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listCodexTasks');
    const tasks = (res && res.tasks) || [];

    if (!tasks.length) {
      container.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.tasks.codex_empty', '暂无本地定时任务。ChatGPT 的定时任务保存在云端账号里，本应用只读取本地数据、不接入云端账号，因此这里只显示通过 codex 命令行在本机创建的自动化任务。'))}</div>`;
      return;
    }

    const rows = tasks.map((t, idx) => {
      const hidden = idx >= 3 ? ' style="display:none"' : '';
      const cadence = _csFmtRRule(t.rrule);
      const statusLabel = t.status === 'ACTIVE'
        ? _csT('onboarding.tasks.status_active', '启用')
        : (t.status === 'PAUSED' ? _csT('onboarding.tasks.status_paused', '暂停') : _csEsc(t.status || ''));
      const meta = [
        cadence ? `⏱ ${_csEsc(cadence)}` : '',
        _csT('onboarding.tasks.status_line', '状态：{status}', { status: statusLabel }),
        t.nextRunAt ? _csT('onboarding.tasks.next_run', '下次：{time}', { time: _csFmtTaskTime(t.nextRunAt) }) : '',
      ].filter(Boolean).join(' · ');
      const promptLine = t.prompt ? `<small>${_csEsc(t.prompt)}</small>` : '';
      return `
        <div class="cs-src cs-collapsible-item"${hidden} data-task-id="${_csEsc(t.id)}">
          <input type="checkbox" />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(t.name)}</strong>
            <small>${meta}</small>
            ${promptLine}
          </div>
        </div>`;
    }).join('');

    const toggleBtn = tasks.length > 3
      ? `<button type="button" class="cs-toggle-more">${_csEsc(_csT('onboarding.tasks.show_all', '显示全部 {count} 条任务', { count: tasks.length }))}</button>`
      : '';

    container.innerHTML =
      `<div class="cs-state">${_csEsc(_csT('onboarding.tasks.codex_summary', '检测到 {count} 个 Codex 定时任务，勾选后导入到本应用的任务中心。', { count: tasks.length }))}</div>` +
      rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportCodexTasks('${_csEsc(agentType)}')">${_csEsc(_csT('onboarding.asset.import_tasks', '导入所选任务'))}</button>
         <div class="cs-import-result"></div>
       </div>`;

    // Wire up checkbox interactions
    container.querySelectorAll('.cs-src input[type="checkbox"]').forEach((cb) => {
      const row = cb.closest('.cs-src');
      cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
      row.addEventListener('click', (ev) => {
        if (ev.target === cb) return;
        cb.checked = !cb.checked;
        row.classList.toggle('selected', cb.checked);
      });
    });

    const moreBtn = container.querySelector('.cs-toggle-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        const items = container.querySelectorAll('.cs-collapsible-item');
        const allVisible = Array.from(items).every((el) => el.style.display !== 'none');
        items.forEach((el, idx) => {
          if (idx >= 3) el.style.display = allVisible ? 'none' : '';
        });
        moreBtn.textContent = allVisible
          ? _csT('onboarding.tasks.show_all', '显示全部 {count} 条任务', { count: tasks.length })
          : _csT('onboarding.common.collapse', '收起');
      });
    }

    const badge = document.getElementById(`cs-count-${agentType}-tasks`);
    if (badge) badge.textContent = `(${tasks.length})`;

    _obLog.info('loaded Codex tasks', { count: tasks.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load Codex tasks', { error: msg });
    container.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.tasks.read_failed_codex', '读取 Codex 定时任务失败：{reason}', { reason: msg }))}</div>`;
  }
}

// Import the user-selected Codex scheduled tasks into the in-app task center.
// Unmappable recurrences are reported per-task by the backend — never coerced.
async function _csImportCodexTasks(agentType) {
  const container = _csFillAssetSection(agentType, 'tasks');
  if (!container) return;
  const rows = [...container.querySelectorAll('.cs-src[data-task-id]')];
  const selected = rows
    .filter((r) => r.querySelector('input[type="checkbox"]')?.checked)
    .map((r) => r.dataset.taskId)
    .filter(Boolean);
  const bar = container.querySelector('.cs-import-bar');
  const btn = bar ? bar.querySelector('.cs-import-btn') : null;
  const resultBox = bar ? bar.querySelector('.cs-import-result') : null;
  if (!selected.length) {
    if (resultBox) resultBox.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.select_tasks', '请先勾选要导入的任务。'))}</div>`;
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = _csT('onboarding.tasks.importing', '导入中…'); }
  if (resultBox) resultBox.innerHTML = `<div class="cs-state loading">${_csEsc(_csT('onboarding.tasks.importing_selected', '正在导入所选任务…'))}</div>`;
  try {
    const res = await window.cogseed.invoke('sessionImport.importCodexTasks', { taskIds: selected });
    const r = res || {};
    const parts = [_csT('onboarding.tasks.success_count_items', '成功 {count} 个', { count: r.imported || 0 })];
    if (r.skipped) parts.push(_csT('onboarding.tasks.skipped_count_items', '跳过 {count} 个', { count: r.skipped }));
    if (r.unsupported) parts.push(_csT('onboarding.tasks.unsupported_count', '不支持 {count} 个', { count: r.unsupported }));
    if (r.failed) parts.push(_csT('onboarding.tasks.failed_count_items', '失败 {count} 个', { count: r.failed }));
    const reasons = (r.items || [])
      .filter((i) => i.status !== 'imported' && i.reason)
      .map((i) => `${_csEsc(i.name)}：${_csEsc(i.reason)}`)
      .join('；');
    resultBox.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.tasks.codex_done', '导入完成：{details}。{reasons}已导入的任务可在「任务」模块中查看与管理。', { details: parts.join('，'), reasons: reasons ? `${reasons}<br>` : '' }))}</div>`;
    selected.forEach((id) => {
      const row = container.querySelector(`.cs-src[data-task-id="${id}"]`);
      if (row) { row.classList.add('done'); row.querySelector('input[type="checkbox"]').checked = false; }
    });
    _obLog.info('codex tasks import finished', { selected: selected.length, result: r });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('codex tasks import failed', { error: msg });
    if (resultBox) resultBox.innerHTML = `<div class="cs-state err">${_csEsc(_csT('onboarding.tasks.import_failed_scheduled', '导入定时任务失败：{reason}', { reason: msg }))}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = _csT('onboarding.asset.import_tasks', '导入所选任务'); }
  }
}

// Import each selected Claude session through the real pipeline:
// read → compress → materialize (shows up in the sidebar) → route cognitions
// into the Recall candidate pool. Honest per-session status; a degraded
// extraction still imports the conversation, just with no cognitions.
async function _csImportSelectedSessions(container) {
  const btn = container.querySelector('.cs-import-btn');
  const resultBox = container.querySelector('.cs-import-result');
  if (!resultBox) return;

  const selected = [];
  container.querySelectorAll('.cs-src input[type="checkbox"]:checked').forEach((cb) => {
    const row = cb.closest('.cs-src');
    const filePath = row ? row.dataset.sessionId : null;
    const title = row ? (row.querySelector('strong')?.textContent || '') : '';
    if (filePath) selected.push({ filePath, title });
  });

  if (!selected.length) {
    resultBox.innerHTML = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.select_sessions', '请先勾选要导入的会话。'))}</div>`;
    return;
  }

  // Limit: maximum 3 sessions per import
  if (selected.length > 3) {
    resultBox.innerHTML = `<div class="cs-state error">${_csEsc(_csT('onboarding.asset.max_sessions', '一次最多只能导入 3 个会话，请取消勾选多余的会话。'))}</div>`;
    return;
  }

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">${_csEsc(_csT('onboarding.asset.importing_count', '正在导入 {count} 个会话…', { count: selected.length }))}</div>`;

  let okCount = 0;
  let degradedCount = 0;
  let failCount = 0;
  let cogTotal = 0;
  const lines = [];

  for (const item of selected) {
    try {
      const res = await window.cogseed.invoke('sessionImport.importClaudeSession', {
        filePath: item.filePath,
        titleHint: item.title,
      });
      if (res && res.conversationId) {
        const c = res.cognitions || { personal: 0, rule: 0, template: 0 };
        const cog = (c.personal || 0) + (c.rule || 0) + (c.template || 0);
        cogTotal += cog;
        if (res.degraded) {
          degradedCount += 1;
          lines.push(`⚠ ${_csEsc(_csT('onboarding.asset.session_degraded', '{title}：已导入（未能自动提炼，按原始开头保留）', { title: item.title || _csT('onboarding.asset.tab_sessions', '会话') }))}`);
        } else {
          okCount += 1;
          lines.push(`✓ ${_csEsc(_csT('onboarding.asset.session_imported', '{title}：已提炼并导入{cognitionPart}', { title: item.title || _csT('onboarding.asset.tab_sessions', '会话'), cognitionPart: cog ? _csT('onboarding.asset.cognition_part', '，提取候选认知 {count} 条', { count: cog }) : '' }))}`);
        }
      } else {
        failCount += 1;
        lines.push(`✗ ${_csEsc(_csT('onboarding.asset.session_failed', '{title}：导入失败（{reason}）', { title: item.title || _csT('onboarding.asset.tab_sessions', '会话'), reason: (res && res.reason) || _csT('onboarding.common.unknown', '未知原因') }))}`);
      }
    } catch (err) {
      failCount += 1;
      const msg = (err && err.message) || String(err);
      lines.push(`✗ ${_csEsc(_csT('onboarding.asset.session_failed_reason', '{title}：{reason}', { title: item.title || _csT('onboarding.asset.tab_sessions', '会话'), reason: msg }))}`);
    }
  }

  const summary = `<div class="cs-state">${_csEsc(_csT('onboarding.asset.session_summary', '导入完成：成功 {success} 个{degradedPart}{failedPart}{cognitionPart}。导入的会话已出现在左侧会话列表，点进去即可继续对话。', {
    success: okCount,
    degradedPart: degradedCount ? _csT('onboarding.asset.degraded_part', '，未提炼 {count} 个', { count: degradedCount }) : '',
    failedPart: failCount ? _csT('onboarding.asset.failed_part', '，失败 {count} 个', { count: failCount }) : '',
    cognitionPart: cogTotal ? _csT('onboarding.asset.cognition_review_part', '；共提取候选认知 {count} 条，可在「回忆/候选审核」中确认', { count: cogTotal }) : '',
  }))}</div>`;
  resultBox.innerHTML = summary + `<div class="cs-import-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;

  // Trigger conversation list refresh so imported sessions appear in sidebar
  if (okCount > 0) {
    if (window._markConversationListLocallyChanged) {
      window._markConversationListLocallyChanged();
    }
    if (typeof loadConversations === 'function') {
      loadConversations().catch((err) => _obLog.warn('failed to reload conversations', err));
    }
  }

  if (btn) btn.disabled = false;
  _obLog.info('session import finished', { okCount, degradedCount, failCount, cogTotal });
}

async function _csLoadAcpSessions() {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;

  try {
    const res = await window.cogseed.invoke('localAgents.listAcpSessions');
    if (!res || !res.ok) return;

    const { agentTypes, sessionsByType } = res;
    if (!agentTypes || agentTypes.length === 0) return;

    // For each agent type, add a group section
    for (const agentType of agentTypes) {
      const sessions = sessionsByType[agentType] || [];
      if (sessions.length === 0) continue;

      const agentLabel = agentType === 'hermes' ? 'Hermes (ACP recording)'
        : agentType === 'claude-desktop' ? 'Claude Desktop (ACP recording)'
        : `${agentType} (ACP recording)`;

      const groupHtml = `
        <div class="cs-group-head" data-group="acp-${_csEsc(agentType)}" style="margin-top:16px">
          <span class="g-name">${CS_TERMINAL_SVG}${_csEsc(agentLabel)}</span>
          <span class="g-status">${_csEsc(_csT('onboarding.import.acp_status', '从录制文件读取'))}</span>
          <svg class="g-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="cs-sessions-container" data-agent="acp-${_csEsc(agentType)}"></div>`;

      box.insertAdjacentHTML('beforeend', groupHtml);

      // Wire up collapse/expand for this group
      const head = box.querySelector(`.cs-group-head[data-group="acp-${agentType}"]`);
      if (head) {
        head.addEventListener('click', () => {
          const container = box.querySelector(`.cs-sessions-container[data-agent="acp-${agentType}"]`);
          if (container) {
            const isCollapsed = head.classList.toggle('collapsed');
            container.classList.toggle('collapsed', isCollapsed);
          }
        });
      }

      const container = box.querySelector(`.cs-sessions-container[data-agent="acp-${agentType}"]`);
      if (!container) continue;

      // Render sessions
      const sessionRows = sessions.map((s) => {
        const time = s.timestamp ? new Date(s.timestamp).toLocaleString('zh-CN', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : '';
        const projectLabel = s.projectPath ? `<small>${_csEsc(s.projectPath)}</small>` : '';
        return `
          <div class="cs-src" data-session-id="${_csEsc(s.filePath)}">
            <input type="checkbox" />
            <div class="s-ico">${CS_TERMINAL_SVG}</div>
            <div>
              <strong>${_csEsc(s.firstMessage)}</strong>
              ${projectLabel}
            </div>
            <small style="color:var(--cs-muted);white-space:nowrap;">${_csEsc(time)}</small>
          </div>`;
      }).join('');

      container.innerHTML = sessionRows;

      // Wire up checkbox interactions
      container.querySelectorAll('.cs-src').forEach((row) => {
        const checkbox = row.querySelector('input[type="checkbox"]');
        row.addEventListener('click', (ev) => {
          if (ev.target === checkbox) return;
          checkbox.checked = !checkbox.checked;
          row.classList.toggle('selected', checkbox.checked);
        });
        checkbox.addEventListener('change', () => {
          row.classList.toggle('selected', checkbox.checked);
        });
      });
    }

    _obLog.info('loaded ACP sessions', { agentTypes, totalSessions: Object.values(sessionsByType).flat().length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load ACP sessions', { error: msg });
    // Non-blocking: if ACP sessions fail to load, we still show Claude Code sessions
  }
}

async function _csFinish() {
  _obLog.info('_csFinish called', {
    importedCount: _csImportedConversationIds.length,
    importedIds: _csImportedConversationIds,
    matchResult: _csMatchResult,
  });

  // 候选认知已在导入时后台提取并存入候选池，留待用户首次打开导入会话时由
  // agent 主动呈现和确认，此处不再处理候选认知的 UI 确认和 reject/keep 逻辑。
  // 工作空间已在隐形匹配阶段（_csRunInvisibleMatching → _csEnsureWorkspaceFromScenario）
  // 创建/复用并把导入会话绑定进去。

  try {
    await window.cogseed.invoke('prefs.setOnboarding', { completed: true });
    _obLog.info('onboarding completed and persisted');
  } catch (err) {
    // Persisting the marker failed — surface it rather than silently
    // trapping the user in a loop that re-fires the walkthrough next boot.
    _obLog.warn('failed to persist onboarding completion', { error: (err && err.message) || String(err) });
    _csToast(_csT('onboarding.finish.save_failed', '保存完成状态失败，下次启动可能再次出现引导'));
  }
  document.body.classList.remove('cs-onboarding-active');
  const shell = document.getElementById('cs-onboarding');
  // Remove the shell entirely (not just hide it): the import modal reuses the
  // shared `#cs-agent-list` container id, and a hidden shell would shadow it
  // for getElementById. `_csObBuilt` resets so a re-triggered walkthrough
  // rebuilds fresh.
  if (shell) {
    shell.remove();
    _csObBuilt = false;
  }

  // Imported sessions were materialized while the onboarding overlay hid the
  // main UI. Refresh the sidebar list now so they show up immediately (and,
  // when a role workspace was chosen, re-render the projects section that
  // hosts the bound conversations).
  await _csRefreshConversationList();

  // 有导入会话（推荐/选择其他会话路线）→ 默认进入第一个导入会话的对话页，
  // 用户直接看到接续模板并继续对话。从零开始无导入 → 留在首页。
  const firstImported = _csImportedConversationIds.length ? _csImportedConversationIds[0] : '';
  if (firstImported && typeof setView === 'function') {
    _obLog.info('opening first imported conversation after onboarding', { conversationId: firstImported });
    // 会话列表已刷新，切到对话视图（打开时会触发 needs_welcome → 接续模板）。
    setView('conversation', firstImported);
    // 真实页面引导（悬窗 tour）：第一步指向欢迎消息的「带着这些继续」。
    // 步骤 1 完成后按任务长度决定是否继续「认知资产」引导；「左下角注册」
    // 步骤在注册入口融合后追加。
    if (typeof window.interactiveTour !== 'undefined' && typeof window.interactiveTour.start === 'function') {
      setTimeout(() => {
        // start 是 async（先查 per-account 完成标记再决定是否弹出），同步 try/catch
        // 捕不到异步 reject，改用 .catch 兜底。
        const p = window.interactiveTour.start();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            _obLog.warn('interactive tour start failed', { error: (err && err.message) || String(err) });
          });
        }
      }, 600);
    }
  }
}

function _csBuild() {
  if (_csObBuilt) {
    return;
  }
  const shell = document.createElement('div');
  shell.id = 'cs-onboarding';
  shell.innerHTML = _csObShellHtml();
  document.body.appendChild(shell);
  _csApplyI18n(shell);
  window.addEventListener('i18n-change', () => {
    if (shell.isConnected) _csRefreshDynamicI18n();
  });

  const toast = document.createElement('div');
  toast.id = 'cs-ob-toast';
  // Message row + an (initially hidden) indeterminate progress bar. The bar is
  // only shown for long-running atomic ops (session import) where we can't
  // report a real percentage — it signals "working, duration unknown" honestly
  // rather than faking a 0→90% climb.
  toast.innerHTML = '<span class="t-msg"></span><span class="t-bar"><i></i></span>';
  document.body.appendChild(toast);

  // Inline next/back navigation (`data-csnext` buttons).
  shell.querySelectorAll('[data-csnext]').forEach((b) => {
    b.addEventListener('click', () => _csGoStep(Number(b.dataset.csnext)));
  });

  // 首次引导第一步（“我已经使用过CogSeed”跳过入口已移除：新用户默认未使用过）。

  // 第一步页脚：隐私政策 / 用户协议 → 官网（系统浏览器打开，官网更新即同步）。
  // 文案由标准 data-i18n 刷新；这里仅绑定外链动作。
  shell.querySelectorAll('.first-run-legal-link').forEach((link) => {
    link.addEventListener('click', () => {
      const url = link.dataset.openExternalUrl || '';
      if (!url) return;
      if (window.cogseed && typeof window.cogseed.invoke === 'function') {
        window.cogseed.invoke('auth.openExternal', { url }).catch(() => {});
      } else if (url.startsWith('http')) {
        window.open(url, '_blank');
      }
    });
  });

  // 第一步同意勾选：隐私政策 / 用户协议需勾选后才能进入下一步。
  const consentBox = shell.querySelector('#first-consent');
  const firstBegin = shell.querySelector('#first-begin');
  if (consentBox && firstBegin) {
    const beginLabel = firstBegin.querySelector('span');
    if (beginLabel) beginLabel.textContent = _csT('onboarding.start.begin', '开始一次真实工作');
    const syncConsent = () => {
      firstBegin.disabled = !consentBox.checked;
    };
    consentBox.addEventListener('change', syncConsent);
    syncConsent();
  }

  shell.querySelector('#cs-team-refresh')?.addEventListener('click', () => _csLoadTeam(true));
  shell.querySelector('#cs-agent-refresh')?.addEventListener('click', () => _csLoadAgents(true));

  // Step 2 fork cards: ① continue recommended project, ② browse other
  // sessions (reveals the by-Agent import UI), ③ start blank — all three end
  // in the invisible workspace matching step (no manual role selection).
  shell.querySelector('#cs-fork-cards')?.addEventListener('click', (e) => {
    const card = e.target.closest('.cs-fork-card');
    if (!card || card.hasAttribute('disabled')) return;
    const choice = card.dataset.fork;
    _csForkChoice = choice;
    if (choice === 'continue') {
      void _csForkContinue();
    } else if (choice === 'other') {
      _csShowImportView();
    } else if (choice === 'blank') {
      // No import; matching creates a fresh/临时 workspace with no sessions.
      _csRecommendation = null;
      _csGoStep(3);
    }
  });
  // Return from the import sub-view back to the fork cards.
  shell.querySelector('#cs-import-back-fork')?.addEventListener('click', () => _csShowForkView());

  // Standalone mode: close import flow after importing sessions
  shell.querySelector('#cs-step2-finish')?.addEventListener('click', () => {
    _obLog.info('standalone import flow finished');
    document.body.classList.remove('cs-onboarding-active');
    if (shell) shell.style.display = 'none';
    // Reset standalone mode
    _csStandaloneMode = false;
    // Refresh sidebar to show imported sessions
    void _csRefreshConversationList();
    _csToast(_csT('onboarding.finish.done', '导入完成'));
  });

  _csObBuilt = true;
}

// Called by boot.js (early, right after i18n, AND as a safety net after the
// last view is restored). Fire-and-forget: it must never block first paint.
// Only lifts the overlay when the machine-local marker says the walkthrough
// has not been completed here yet.
let _csStarted = false;

async function maybeStartOnboarding() {
  // boot.js may call this twice (early + post-restore safety net). The second
  // call must never reset the user's current step back to step 0 — once the
  // walkthrough is up, it stays where the user left it.
  if (_csStarted) {
    _obLog.info('onboarding already started, skipping re-entry');
    return;
  }
  _obLog.info('maybeStartOnboarding called');

  try {
    const res = await window.cogseed.invoke('prefs.getOnboarding');
    if (res && res.completed === true) {
      _obLog.info('onboarding already completed, skipping');
      return;
    }
  } catch (err) {
    // If we can't read the marker, err on the side of NOT trapping the user
    // behind a walkthrough that might loop; log and skip.
    _obLog.warn('onboarding marker read failed — skipping walkthrough', { error: (err && err.message) || String(err) });
    return;
  }
  _csStarted = true;
  _csBuild();
  document.body.classList.add('cs-onboarding-active');
  _csGoStep(0);
  _obLog.info('onboarding walkthrough started');
}

// Expose for boot.js. Kept on window so classic-script load order doesn't matter.
window.csOnboarding = {
  maybeStart: maybeStartOnboarding,
};
