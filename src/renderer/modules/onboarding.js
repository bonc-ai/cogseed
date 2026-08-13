// ─── First-run onboarding (CogSeed four-step walkthrough) ──────────────────
//
// Ported from the static prototype (60秒用户旅程.html), rebuilt on top of the
// live CogSeed renderer. Four steps:
//   1. 认识 CogSeed        — product intro (static)
//   2. 导入会话 / 检测本地 agent — REAL detection via `localAgents.list`;
//                            session history reading is NOT wired to a real
//                            backend yet, so sessions show an honest
//                            "unavailable / failed" state — never fake data.
//   3. 选择角色起点         — optional role template (local pick)
//   4. 确认候选认知         — candidate cognition extraction is NOT wired to a
//                            real backend yet → honest empty state, no fakes.
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
    _csToast('请切换到会话标签页进行导入');
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
let _csRolePicked = null;
let _csToastTimer = 0;
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

function _csObShellHtml() {
  return `
  <header class="cs-topbar">
    <div class="cs-brand">
      <span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="M12 13a4 4 0 0 1-4-4 6 6 0 0 1 8 0 4 4 0 0 1-4 4Z"/><path d="M9.5 16.5 12 13l2.5 3.5"/><path d="M12 17v4"/></svg></span>
      <b>COGSEED</b>
    </div>
    <div class="cs-title">首次设置 · 约 1 分钟<span class="cs-step-now" id="cs-step-now"></span></div>
    <div></div>
  </header>
  <div class="cs-main">
    <aside class="cs-rail">
      <h2>把你的能力变成资产</h2>
      <p>设置完就能直接开工，以后随时可改。</p>
      <div class="cs-steps">
        <button class="cs-step active" data-csstep="0"><span>1</span><span><strong>认识 CogSeed</strong><small>你的认知，跟着你走</small></span></button>
        <button class="cs-step" data-csstep="1"><span>2</span><span><strong>连接 AI 工具</strong><small>已装的，一键接入</small></span></button>
        <button class="cs-step" data-csstep="2"><span>3</span><span><strong>选择起点</strong><small>继续项目 / 选会话 / 从空白开始</small></span></button>
        <button class="cs-step" data-csstep="3"><span>4</span><span><strong>选个角色（可选）</strong><small>随时能改</small></span></button>
      </div>
      <div class="cs-privacy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>你的认知、你的密钥，都只留在本机，不上传。</span></div>
    </aside>
    <main class="cs-content">

      <section class="cs-panel active" data-cspanel="0">
        <div class="cs-kicker">模型是大家的 · 认知是你的</div>
        <h1>换模型、换 Agent，你的经验不丢。</h1>
        <p class="cs-lead">你确认过的判断、规则和方法，会被 CogSeed 沉淀成你的认知资产——换哪个 AI，都接着用。</p>
        <div class="cs-facts">
          <div class="cs-fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="12" r="4"/></svg><strong>无需注册账号</strong><span>创建本机个人空间，不需要手机号、邮箱或企业身份。</span></div>
          <div class="cs-fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 13v5M12 9v9M17 5v13"/></svg><strong>数据只在本机</strong><span>项目和会话不会因为打开应用就被上传。</span></div>
          <div class="cs-fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><strong>密钥自己保管</strong><span>密钥由你保管，只在本机使用；跳过也行，之后随时配。</span></div>
        </div>
        <div class="cs-actions">
          <button class="cs-btn" data-csnext="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>继续 · 连接 AI 工具</button>
          <small>全程本机操作，不上传任何数据。</small>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="1">
        <div class="cs-kicker">接入你已有的 AI 工具 · 全部本机</div>
        <h1>把你已装的 AI 工具接进来</h1>
        <p class="cs-lead">检测到你本机已安装的 AI 工具，点「连接」就能用。已配密钥的直接可用；订阅登录的 Agent 本机就能执行任务，凭证只留在本机。</p>

        <div class="cs-list" id="cs-team-list">
          <div class="cs-state loading">正在检测可连接的 Agent…</div>
        </div>
        <div class="cs-mode"><span>无需粘贴密钥。订阅登录的 Agent 本机就能干活，接入不受影响。</span></div>

        <div class="cs-actions">
          <button class="cs-btn ghost" data-csnext="0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回</button>
          <button class="cs-btn ghost" id="cs-team-refresh">重新检测</button>
          <button class="cs-btn ghost" data-csnext="2">跳过 · 稍后再连</button>
          <button class="cs-btn" data-csnext="2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>下一步 · 选择起点</button>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="2">

        <!-- 子视图 A：三选一分流（默认） -->
        <div class="cs-fork" id="cs-fork-view">
          <div class="cs-kicker">从哪里开始？三个入口，都来自你本机的真实数据</div>
          <h1>选一个起点，剩下的交给我们</h1>
          <p class="cs-lead">三个入口选一个就行，随时可退出。<b>推荐来自你本机的真实数据，不会凭空生成。</b></p>

          <div class="cs-fork-cards" id="cs-fork-cards">
            <!-- 卡片①（复杂项目）由 _csLoadRecommendation 动态填充 -->
            <button type="button" class="cs-fork-card" id="cs-fork-continue" data-fork="continue" disabled>
              <span class="f-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
              <span class="f-tag">推荐 · 继续项目</span>
              <h3 id="cs-fork-continue-title">正在读取你最近的项目…</h3>
              <p id="cs-fork-continue-desc" class="f-desc">自动找出你投入最多、最近还在做的项目。</p>
              <span class="f-meta" id="cs-fork-continue-meta"></span>
            </button>

            <button type="button" class="cs-fork-card" data-fork="other">
              <span class="f-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18M3 12h18M3 17h18"/></svg></span>
              <span class="f-tag">自选 · 按 Agent 分类</span>
              <h3>选择其他会话</h3>
              <p class="f-desc">翻看各 AI 工具的历史记录，勾选想带进来的。</p>
              <span class="f-meta">进入会话导入页</span>
            </button>

            <button type="button" class="cs-fork-card" data-fork="blank">
              <span class="f-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></span>
              <span class="f-tag">全新 · 只挑角色</span>
              <h3>从零开始</h3>
              <p class="f-desc">不导入任何内容，直接挑一个角色模板起步。</p>
              <span class="f-meta">直接选择角色</span>
            </button>
          </div>

          <div class="cs-actions">
            <button class="cs-btn ghost" data-csnext="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回</button>
          </div>
        </div>

        <!-- 子视图 B：按 Agent 导入会话（点“选择其他会话”后显示，也用于确认推荐会话后的其他导入） -->
        <div class="cs-import-sub" id="cs-import-view" style="display:none">
          <div class="cs-kicker">只读导入 · 不写回任何 Agent</div>
          <h1>从你在其他 Agent 里的对话继续</h1>
          <p class="cs-lead">点左侧 Agent，勾选想导入的会话，再点「导入所选会话」</p>

          <div class="cs-import-hint">
            <span>已导入 <span id="cs-import-count">0</span> 条会话</span>
            <button type="button" class="cs-btn-inline" id="cs-do-import" style="display:none" onclick="_csDoImport()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg>
              导入所选会话
            </button>
          </div>

          <div class="cs-list" id="cs-agent-list">
            <div class="cs-state loading">正在检测本机 Agent…</div>
          </div>

          <div class="cs-actions">
            <button class="cs-btn ghost" id="cs-import-back-fork"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回起点选择</button>
            <button class="cs-btn ghost" id="cs-agent-refresh">重新检测 Agent</button>
            <button class="cs-btn cs-step2-next" data-csnext="3"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>下一步 · 选择角色</button>
            <button class="cs-btn cs-step2-finish" id="cs-step2-finish" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg>完成导入</button>
          </div>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="3">
        <div class="cs-kicker">可选 · 随时能改</div>
        <h1>你主要在做哪类工作？</h1>
        <p class="cs-lead">角色模板给你一套起步结构和常用技能，<b>不会自动生成任何关于你的信息</b>。选择后会创建一个工作空间，之后随时可换、可叠加。</p>
        <div class="cs-role-cards" id="cs-role-cards">
          <div class="cs-state loading">正在加载角色模板...</div>
        </div>
        <div class="cs-role-result" id="cs-role-result" style="max-width:560px">
          <h4>角色模板已应用 · 不会自动生成关于你的信息</h4>
        </div>
        <div class="cs-actions">
          <button class="cs-btn ghost" data-csnext="2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回</button>
          <button class="cs-btn ghost" id="cs-role-skip">先不选，直接开始</button>
          <button class="cs-btn" id="cs-ob-finish"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 13l4 4L19 7"/></svg>开始使用</button>
        </div>
      </section>

    </main>
  </div>`;
}

function _csGoStep(n) {
  console.log('[ONBOARDING DEBUG] _csGoStep called with n =', n);
  const step = Math.max(0, Math.min(3, n));
  const shell = document.getElementById('cs-onboarding');
  console.log('[ONBOARDING DEBUG] _csGoStep shell found:', !!shell);
  if (!shell) {
    console.error('[ONBOARDING DEBUG] _csGoStep: shell not found!');
    return;
  }
  console.log('[ONBOARDING DEBUG] Setting step to', step);
  shell.querySelectorAll('.cs-panel').forEach((p) => {
    p.classList.toggle('active', Number(p.dataset.cspanel) === step);
  });
  shell.querySelectorAll('.cs-step').forEach((b) => {
    const i = Number(b.dataset.csstep);
    b.classList.toggle('active', i === step);
    b.classList.toggle('done', i < step);
    b.disabled = i > step;
  });
  shell.querySelector('.cs-content')?.scrollTo?.(0, 0);
  // Top-bar step indicator ("第 n 步 / 共 4 步"), kept in sync with the rail.
  const stepNow = document.getElementById('cs-step-now');
  if (stepNow) stepNow.textContent = ` · 第 ${step + 1} 步 / 共 4 步`;
  console.log('[ONBOARDING DEBUG] _csGoStep: loading data for step', step);
  if (step === 1) _csLoadTeam(false);
  if (step === 2) _csShowForkView();
  if (step === 3) _csLoadRoleTemplates();
  console.log('[ONBOARDING DEBUG] _csGoStep complete');
}

// ─── Step 2 fork view (从哪里开始) ─────────────────────────────────────────
// The recommended session + its suggested template, captured when the user
// picks card ①. Consumed by step 3 to pre-select the role template and by
// _csFinish (the session is imported the moment the user confirms card ①).
let _csRecommendation = null;      // full RecommendStartResult from backend
let _csForkChoice = null;          // 'continue' | 'other' | 'blank'
let _csSuggestedTemplateId = null; // template id to pre-select in step 3

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

// Load the REAL "where to begin" recommendation and paint card ①. Never
// blocks the fork view; on empty/failure the card degrades to an honest
// "no prior sessions" state that routes into the import sub-view instead.
async function _csLoadRecommendation() {
  const card = document.getElementById('cs-fork-continue');
  const titleEl = document.getElementById('cs-fork-continue-title');
  const descEl = document.getElementById('cs-fork-continue-desc');
  const metaEl = document.getElementById('cs-fork-continue-meta');
  if (!card || !titleEl) return;
  // Avoid re-fetching if we already have a recommendation this session.
  if (_csRecommendation) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.recommendStartingPoint');
    _csRecommendation = res || { top: null };

    const top = res && res.top;
    if (!top) {
      // Honest empty state: no readable prior sessions anywhere.
      titleEl.textContent = '还没有可继续的项目';
      if (descEl) descEl.textContent = '没检测到本机可读的历史会话。你可以直接“选择其他会话”查看，或从空白开始。';
      if (metaEl) metaEl.textContent = '';
      card.classList.add('is-empty');
      card.removeAttribute('disabled');
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
    titleEl.textContent = `继续「${proj}」`;
    if (descEl) {
      const snippet = String(top.firstMessage || '').replace(/\s+/g, ' ').slice(0, 64);
      descEl.textContent = snippet ? `最近的话题：${snippet}${snippet.length >= 64 ? '…' : ''}` : '继续这个项目，并顺带提取其中的四类资产。';
    }
    if (metaEl) {
      const agentLabel = CS_AGENT_LABELS[top.source] || top.source;
      const when = _csRelativeTime(top.timestamp);
      // contextLength is a real turn/message proxy — label it plainly.
      metaEl.textContent = `${agentLabel} · 约 ${top.contextLength} 轮对话 · ${when}`;
    }
    // Stash the suggested template (may be null → step 3 stays unselected).
    _csSuggestedTemplateId = res.suggestedTemplate ? res.suggestedTemplate.templateId : null;
    card.classList.remove('is-empty');
    card.removeAttribute('disabled');
  } catch (err) {
    _obLog.warn('recommendStartingPoint failed', { error: (err && err.message) || String(err) });
    titleEl.textContent = '读取推荐失败';
    if (descEl) descEl.textContent = '无法读取历史会话推荐，你可以“选择其他会话”手动浏览。';
    card.classList.add('is-empty');
    card.removeAttribute('disabled');
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
  return '最近的会话';
}

// Coarse relative time from an ISO string — real timestamp, friendly text.
function _csRelativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const day = 86400000;
  if (diff < 3600000) return '刚刚活跃';
  if (diff < day) return '今天';
  const days = Math.round(diff / day);
  if (days <= 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.round(days / 7)} 周前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${Math.round(days / 365)} 年前`;
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
  _csToastBusy('正在导入并整理你的会话…');
  try {
    const convId = await _csImportOneSession(top);
    if (convId) {
      _csToastDone('已导入推荐会话，正在为你匹配角色');
    } else {
      _csToastDone('会话已处理，正在为你匹配角色');
    }
  } catch (err) {
    _obLog.warn('fork continue import failed', { error: (err && err.message) || String(err) });
    _csToastDone('导入推荐会话失败，你仍可选择角色');
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
      '<div class="cs-state">未检测到任何已安装的 Agent 命令行工具（如 Claude Code、Codex）。安装后点「重新检测」即可。</div>' +
      '<div class="cs-import-bar">' +
      '<button type="button" class="cs-import-btn cs-demo-btn" id="cs-demo-start">预览演示（合成数据 · 不计入资产）</button>' +
      '<div class="cs-import-result" id="cs-demo-result"></div>' +
      '</div>';
    const demoBtn = document.getElementById('cs-demo-start');
    if (demoBtn) demoBtn.addEventListener('click', () => void _csStartDemoMode(agentType));
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

async function _csStartDemoMode(agentType) {
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
      <small style="color:var(--cs-bud);white-space:nowrap;font-weight:700">演示数据</small>
    </div>`;

  const demoSessions = [
    demoSession(0, 'P3394 产品讨论（示例）', '产品边界与决策规则 · 含 2 条可复用判断', 'rule'),
    demoSession(1, 'PRD 结构整理（示例）', '评审场景的 PRD 固定 9 段结构 · 含 1 条模板', 'template'),
    demoSession(2, '项目接续记录（示例）', '跨 Agent 接续的验收方法 · 含 1 条技能方法', 'skill'),
  ];

  box.innerHTML =
    '<div class="cs-state">演示模式：以下是<strong>合成样例数据</strong>，仅用于预览产品流程。' +
    '不会写入任何正式资产，不计入真实使用指标。</div>' +
    demoSessions.join('') +
    `<div class="cs-import-bar">
       <button type="button" class="cs-import-btn" id="cs-demo-import">演示导入所选会话</button>
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
      if (result) result.innerHTML = '<div class="cs-state">请先勾选要演示的会话。</div>';
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '演示导入中…'; }
    if (result) result.innerHTML = '<div class="cs-state loading">正在演示导入并提取候选…</div>';
    await new Promise((r) => setTimeout(r, 1200));
    if (result) {
      result.innerHTML =
        '<div class="cs-state" style="color:var(--cs-forest-deep)">✓ 演示完成：提取到 3 条候选认知（1 规则 / 1 模板 / 1 技能方法）。' +
        '<br><b>以上均为合成演示数据，不会写入你的资产，不计入任何真实指标。</b></div>';
    }
    if (btn) { btn.disabled = false; btn.textContent = '演示导入所选会话'; }
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
        <span>检测到 ${available.length} 个 Agent，点击查看可导入内容</span>
      </div>
      <div class="cs-import-body">
        <div class="cs-agent-sidebar">
          ${leftAgents}
        </div>
        <div class="cs-asset-content">
          <div class="cs-asset-panel" data-agent="loading">
            <div class="cs-state loading">正在加载...</div>
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
  const tasksTabTitle = agentType === 'opencode' ? '待办' : '定时任务';
  contentArea.innerHTML = `
    <div class="cs-asset-panel" data-agent="${ag}">
      <div class="cs-asset-tabs">
        <button type="button" class="cs-asset-tab active" data-asset="sessions" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">💬</span>
          <span class="ash-title">会话</span>
          <span class="ash-count" id="cs-count-${ag}-sessions"></span>
        </button>
        <button type="button" class="cs-asset-tab" data-asset="skills" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">🔧</span>
          <span class="ash-title">技能</span>
          <span class="ash-count" id="cs-count-${ag}-skills"></span>
        </button>
        <button type="button" class="cs-asset-tab" data-asset="memory" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">🧠</span>
          <span class="ash-title">记忆</span>
          <span class="ash-count" id="cs-count-${ag}-memory"></span>
        </button>
        <button type="button" class="cs-asset-tab" data-asset="tasks" data-agent="${ag}" onclick="_csSelectAssetTab(this)">
          <span class="ash-icon">⏰</span>
          <span class="ash-title">${tasksTabTitle}</span>
          <span class="ash-count" id="cs-count-${ag}-tasks"></span>
        </button>
      </div>
      <div class="cs-asset-panes">
        <div class="cs-asset-section-body active" data-agent="${ag}" data-asset="sessions">
          <div class="cs-state loading">正在读取会话...</div>
        </div>
        <div class="cs-asset-section-body" data-agent="${ag}" data-asset="skills">
          <div class="cs-state loading">正在读取技能...</div>
        </div>
        <div class="cs-asset-section-body" data-agent="${ag}" data-asset="memory">
          <div class="cs-state loading">正在读取记忆...</div>
        </div>
        <div class="cs-asset-section-body" data-agent="${ag}" data-asset="tasks">
          <div class="cs-state loading">正在读取...</div>
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
    _csFillAssetSection(agentType, 'skills', `<div class="cs-state">${_csEsc(label)} 的技能读取暂未接入。</div>`);
    void _csLoadOpencodeMemory(agentType);
    void _csLoadOpencodeTasks(agentType);
  } else if (agentType === 'workbuddy') {
    void _csLoadWorkbuddySessions(agentType);
    _csFillAssetSection(agentType, 'skills', `<div class="cs-state">${_csEsc(label)} 的技能读取暂未接入。</div>`);
    _csFillAssetSection(agentType, 'memory', `<div class="cs-state">${_csEsc(label)} 的记忆读取暂未接入。</div>`);
    _csRenderNoTasks(agentType);
  } else {
    _csFillAssetSection(agentType, 'sessions', `<div class="cs-state">${_csEsc(label)} 的会话读取暂未接入。</div>`);
    _csFillAssetSection(agentType, 'skills', `<div class="cs-state">${_csEsc(label)} 的技能读取暂未接入。</div>`);
    _csFillAssetSection(agentType, 'memory', `<div class="cs-state">${_csEsc(label)} 的记忆读取暂未接入。</div>`);
    _csFillAssetSection(agentType, 'tasks', `<div class="cs-state">${_csEsc(label)} 的定时任务读取暂未接入。</div>`);
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
  btn.textContent = allVisible ? `+ 还有 ${total - 3} 个` : '收起';
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
// Detect importable model providers (via CC Switch aggregation), let the user
// pick which to one-click connect into the "AI team" (custom providers), then
// sync the selected keys. Keys stay local; OAuth-only sources are surfaced as
// non-migratable rather than silently dropped.
async function _csLoadTeam(force) {
  const box = document.getElementById('cs-team-list');
  if (!box) return;
  if (force) box.innerHTML = '<div class="cs-state loading">正在检测可连接的 Agent…</div>';

  // Probe first so we can give an honest "no CC Switch found" state instead of
  // an empty list that looks like a bug.
  let probe = null;
  try {
    probe = await window.cogseed.invoke('customProviders.ccswitch.probe');
  } catch (err) {
    _obLog.warn('ccswitch probe failed', { error: (err && err.message) || String(err) });
  }
  if (probe && probe.available === false) {
    box.innerHTML =
      '<div class="cs-state">未检测到可一键连接的 Agent。' +
      '你仍可继续——之后可在设置的「AI 团队」里手动添加模型，导入会话时也会用你已配置的模型。</div>';
    return;
  }

  try {
    // CC Switch model preview and local CLI detection are independent sources —
    // fetch both in parallel. CC Switch gives model providers to sync; local
    // detection gives coding CLIs (Claude/Codex) we can add as team agents.
    // The team should show a CLI even when CC Switch has no card for it.
    const [res, localClis] = await Promise.all([
      window.cogseed.invoke('customProviders.ccswitch.preview'),
      _csDetectCodingClis(),
    ]);
    if (!res || res.ok !== true) {
      const reason = (res && res.reason) || 'unknown';
      // CC Switch unavailable is fine if we still detected a local CLI — render
      // the CLI-only team rather than an error state.
      if (localClis.size) {
        _csRenderTeam([], [], localClis);
        return;
      }
      box.innerHTML = `<div class="cs-state">暂时无法读取可连接的 Agent（${_csEsc(reason)}）。可稍后在设置的「AI 团队」里手动添加。</div>`;
      return;
    }
    _csRenderTeam(res.items || [], res.unsupported || [], localClis);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('ccswitch preview failed', { error: msg });
    box.innerHTML = `<div class="cs-state err">检测可连接的 Agent 失败：${_csEsc(msg)}。可稍后在设置里手动添加。</div>`;
  }
}

// Friendly agent label from a CC Switch appType (externalId prefix). Reuses
// the shared CS_AGENT_LABELS map defined at the top of the module.
function _csAgentLabel(appType) {
  return CS_AGENT_LABELS[appType] || appType || '其他 Agent';
}

// Render the importable model services GROUPED BY AGENT (Claude Code, Codex …).
// Each agent is its own group with its own "connect" button, so the user
// connects an agent's models as a unit rather than picking from a flat list.
// Per-agent connectable externalIds, filled by _csRenderTeam and consumed by
// _csConnectTeam. Keeps the CC Switch key/provider details out of the DOM —
// the user only sees "this agent can connect", not the underlying keys.
let _csTeamByAgent = {};

// Per-appType local coding-CLI availability, filled by _csRenderTeam and read
// by _csConnectTeam. When an appType maps to a detected local CLI (Claude /
// Codex), "connect" also creates a CLI-backed agent so it shows up as a real
// member of the AI team — not just a synced model provider.
let _csCliByAgent = {};

// appType (CC Switch prefix / local CLI type) → coding-CLI runtime name.
// Only claude & codex are coding CLIs the team can drive as agents; other
// appTypes stay model-provider-only (CC Switch sync path).
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
// { loggedIn, mode } from the real localAgents.list probe (file-based auth
// state, never guessed).
async function _csDetectCodingClis() {
  const found = new Map();
  try {
    const res = await window.cogseed.invoke('localAgents.list', { force: false });
    const entries = (res && res.entries) || [];
    entries.forEach((e) => {
      if (!e || !e.available) return;
      const cli = _csCodingCliForAppType(e.type);
      if (cli) {
        found.set(cli, {
          loggedIn: !!(e.auth && e.auth.loggedIn),
          mode: (e.auth && e.auth.mode) || 'unknown',
        });
      }
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
      description: cli === 'claude'
        ? '本机 Claude Code 命令行，作为 AI 团队成员执行编码任务'
        : (cli === 'codex'
          ? '本机 Codex 命令行，作为 AI 团队成员执行编码任务'
          : `本机 ${_csAgentNameForCli(cli)} 命令行，作为 AI 团队成员执行任务`),
      icon: 'code',
      color: 'sage',
      runtime: { kind: 'cli', cli },
      category: 'general',
    });
    if (res && res.agent) {
      _obLog.info('team CLI agent created', { cli, agentId: res.agent.agent_id });
      return 'created';
    }
    _obLog.warn('team CLI agent create returned no agent', { cli });
    return 'error';
  } catch (err) {
    _obLog.warn('team CLI agent create failed', { cli, error: (err && err.message) || String(err) });
    return 'error';
  }
}

// Render one card PER AGENT (Claude Code, Codex …) — no key details, no
// provider list, no checkboxes. Each agent shows a status line and a single
// "connect" button that syncs all of that agent's importable providers.
function _csRenderTeam(items, unsupported, localClis) {
  const box = document.getElementById('cs-team-list');
  if (!box) return;

  const clis = localClis instanceof Map ? localClis : (localClis instanceof Set ? new Map([...localClis].map((c) => [c, { loggedIn: false, mode: 'unknown' }])) : new Map());

  if (!items.length && !unsupported.length && !clis.size) {
    box.innerHTML =
      '<div class="cs-state">未检测到可一键连接的 Agent。可在设置的「AI 团队」里手动添加模型后再回来。</div>';
    return;
  }

  // Bucket both importable and unsupported rows by their originating agent.
  const groups = new Map(); // appType → { ids: [], needsKey: n, unsupportedReasons: [], hasCli: bool }
  const bucket = (appType) => {
    if (!groups.has(appType)) groups.set(appType, { ids: [], needsKey: 0, unsupportedReasons: [], hasCli: false, cliAuth: '' });
    return groups.get(appType);
  };
  items.forEach((it) => {
    const g = bucket(it.appType || 'other');
    g.ids.push(it.externalId);
    if (it.needsKey) g.needsKey += 1;
  });
  unsupported.forEach((u) => { bucket(u.appType || 'other').unsupportedReasons.push(u.reason || 'unknown'); });

  // Fold detected local coding CLIs into the same buckets. A CLI maps to a
  // canonical appType so it either enriches an existing CC Switch card or
  // stands up its own card when CC Switch had nothing for it.
  const cliAppType = { claude: 'claude', codex: 'codex' };
  clis.forEach((info, cli) => {
    const appType = cliAppType[cli] || cli;
    const g = bucket(appType);
    g.hasCli = true;
    // Honest sign-in state from the real credential files.
    if (info && info.loggedIn) {
      g.cliAuth = info.mode === 'api' ? 'API 登录' : (info.mode === 'oauth' ? '官方账号登录' : '已登录');
    } else {
      g.cliAuth = '';
    }
  });

  // Stash ids + CLI presence for the connect handler; DOM never carries key material.
  _csTeamByAgent = {};
  _csCliByAgent = {};
  groups.forEach((g, appType) => {
    _csTeamByAgent[appType] = g.ids.slice();
    if (g.hasCli) _csCliByAgent[appType] = _csCodingCliForAppType(appType);
  });

  // Stable, friendly ordering: known agents first, then any others.
  const order = ['claude', 'claude-desktop', 'codex', 'gemini'];
  const appTypes = Array.from(groups.keys()).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const rows = appTypes.map((appType) => {
    const g = groups.get(appType);
    const label = _csAgentLabel(appType);

    // Claude Desktop is a read-only session source, NOT an executable team
    // runtime: it is not a local CLI agent (absent from LOCAL_CLI_TYPES) and
    // can never be dispatched tasks. Presenting it as 可连接/已连接 here would
    // falsely imply it joins the AI team as a working member. Show it as
    // unsupported instead — its sessions remain importable via 「继续项目」.
    if (appType === 'claude-desktop') {
      return `
      <div class="cs-src cs-team-row" data-app-type="${_csEsc(appType)}">
        <div class="s-ico">${CS_TERMINAL_SVG}</div>
        <div>
          <strong>${_csEsc(label)}</strong>
          <small>桌面版无法作为团队成员执行任务，可在「继续项目」里导入其会话</small>
        </div>
        <div class="cs-team-right"><span class="g-status off">不支持桌面版</span></div>
      </div>`;
    }

    // Connectable if there are models to sync OR a local CLI to add as an agent.
    const connectable = g.ids.length > 0 || g.hasCli;

    // Status line: connectable count, plus honest hints for needs-key /
    // non-migratable credentials — without exposing any key values.
    const reasonLabels = {
      official: '官方订阅登录',
      unsupported_protocol: '暂不支持该 Agent 类型',
      missing_api_key: '缺少 API Key',
      invalid_config: '配置无法解析',
    };
    const unReasonCounts = {};
    (g.unsupportedReasons || []).forEach((r) => { unReasonCounts[r] = (unReasonCounts[r] || 0) + 1; });
    const unsupportedCount = (g.unsupportedReasons || []).length;

    let status;
    if (connectable) {
      status = `<span class="g-status">可连接</span>`;
    } else if (unsupportedCount) {
      // Honest reason per CC Switch's own classification — never guess "官方".
      const onlyOfficial = unReasonCounts.official === unsupportedCount;
      status = onlyOfficial
        ? `<span class="g-status off">官方登录 · 需配置 Key 直连</span>`
        : `<span class="g-status off">暂不支持直连</span>`;
    } else {
      status = `<span class="g-status off">暂不可连接</span>`;
    }

    const hints = [];
    if (g.ids.length > 0) hints.push(`模型 ${g.ids.length} 项 → 模型供应商（提取/对话用）`);
    if (g.hasCli) {
      hints.push(g.cliAuth
        ? `执行 Agent → AI 团队（${g.cliAuth}，无需 Key 即可派发任务）`
        : '执行 Agent → AI 团队（可派发任务）');
    }
    if (g.needsKey) hints.push('部分模型直连需 API Key（平台规则），可稍后在设置里补充');
    Object.keys(unReasonCounts).forEach((r) => {
      const n = unReasonCounts[r];
      const label = reasonLabels[r] || '暂不支持';
      hints.push(`${n} 项为${label}${r === 'unsupported_protocol' ? ' · 可稍后在设置里手动添加' : (r === 'missing_api_key' ? ' · 该 Agent 自身的 Key 可稍后补充' : '')}`);
    });
    const hintHtml = hints.length ? `<small>${_csEsc(hints.join(' · '))}</small>` : '';

    const action = connectable
      ? `<button type="button" class="cs-team-connect cs-btn" data-app-type="${_csEsc(appType)}">连接</button>`
      : '';

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
    btn.addEventListener('click', () => void _csConnectTeam(box, btn.dataset.appType));
  });
}

// Connect ONE agent's models into custom providers ("AI 团队"): sync all of
// that agent's importable externalIds at once. Honest result — added/updated
// counts, and a note when some still need a key.
async function _csConnectTeam(box, appType) {
  const row = box.querySelector(`.cs-team-row[data-app-type="${appType}"]`);
  const btn = row ? row.querySelector('.cs-team-connect') : null;
  const externalIds = (_csTeamByAgent[appType] || []).slice();
  const cli = _csCliByAgent[appType] || '';
  const label = _csAgentLabel(appType);

  if (!externalIds.length && !cli) {
    _csToast(`「${label}」暂无可一键连接的模型`);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '连接中…'; }

  try {
    // 1) Sync CC Switch model providers (if any) into "AI 团队".
    let added = 0;
    let updated = 0;
    if (externalIds.length) {
      const res = await window.cogseed.invoke('customProviders.ccswitch.sync', { externalIds });
      if (!res || res.ok !== true) {
        const reason = (res && res.reason) || '未知原因';
        _csToast(`连接「${label}」失败：${reason}`);
        if (btn) { btn.disabled = false; btn.textContent = '连接'; }
        return;
      }
      added = res.added || 0;
      updated = res.updated || 0;
    }

    // 2) If this agent has a local coding CLI, add it as a real team member.
    // Best-effort: a create failure is reported but does not undo the model
    // sync above. Load existing agents once so we don't duplicate.
    let cliResult = '';
    if (cli) {
      let existing = [];
      try {
        const listRes = await window.cogseed.invoke('agents.list', {});
        existing = (listRes && listRes.agents) || [];
      } catch (err) {
        _obLog.warn('team connect: agents.list failed', { error: (err && err.message) || String(err) });
      }
      cliResult = await _csEnsureCliAgent(cli, existing);
    }

    // Reflect the connected state on the row itself; keep it non-technical.
    if (row) {
      const statusEl = row.querySelector('.g-status');
      if (statusEl) { statusEl.textContent = '已连接'; statusEl.classList.remove('off'); }
      if (btn) { btn.textContent = '已连接'; btn.disabled = true; btn.classList.add('done'); }
    }

    // Honest, combined summary of what actually happened.
    const parts = [];
    const models = added + updated;
    if (models) parts.push(`${models} 个模型`);
    if (cliResult === 'created') parts.push('新增 1 位 CLI 成员');
    else if (cliResult === 'exists') parts.push('CLI 成员已在团队');
    if (cliResult === 'error') {
      _csToast(`「${label}」模型已连接，但加入 CLI 成员失败，可稍后在「AI 团队」里手动新建`);
    } else {
      _csToast(parts.length ? `已把「${label}」连接到 AI 团队（${parts.join('，')}）` : `已连接「${label}」`);
    }
    _obLog.info('team connect finished', { appType, added, updated, cli, cliResult });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('team connect failed', { appType, error: msg });
    _csToast(`连接「${label}」失败：${msg}`);
    if (btn) { btn.disabled = false; btn.textContent = '连接'; }
  }
}

async function _csLoadAgents(force) {
  // Re-detection exits demo mode: real agents beat synthetic preview data.
  _csDemoMode = false;
  const box = document.getElementById('cs-agent-list');
  if (!box) return;
  box.innerHTML = '<div class="cs-state loading">正在检测本机 Agent…</div>';
  try {
    const res = await window.cogseed.invoke('localAgents.list', { force: !!force });
    _csRenderAgents(res && res.entries);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('onboarding agent detection failed', { error: msg });
    box.innerHTML = `<div class="cs-state err">检测本地 Agent 失败：${_csEsc(msg)}。你仍可继续，稍后可在设置中重试。</div>`;
  }
}

async function _csLoadClaudeSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', '<div class="cs-state loading">正在扫描 Claude Code 会话…</div>');
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('localAgents.listClaudeSessions');
    const recentSessions = (res && res.sessions) || [];

    console.log('[ONBOARDING] Claude sessions - total count:', recentSessions.length);
    console.log('[ONBOARDING] Claude sessions - first 3:', recentSessions.slice(0, 3));

    if (!recentSessions.length) {
      container.innerHTML = '<div class="cs-state">未找到 Claude Code 历史会话。如果你使用过 Claude Code，会话文件可能在 ~/.claude/projects/ 目录下。</div>';
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
         <button type="button" class="cs-import-btn" onclick="_csImportClaudeSessions('${_csEsc(agentType)}')">导入所选会话（最多 3 条）</button>
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
    container.innerHTML = `<div class="cs-state err">读取 Claude Code 会话失败：${_csEsc(msg)}</div>`;
  }
}

// ── Codex sessions: scan ~/.codex/sessions and import selected ──
async function _csLoadCodexSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', '<div class="cs-state loading">正在扫描 Codex 会话…</div>');
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listCodexSessions');
    const recentSessions = (res && res.sessions) || [];

    console.log('[ONBOARDING] Codex sessions - total count:', recentSessions.length);
    console.log('[ONBOARDING] Codex sessions - first 3:', recentSessions.slice(0, 3));

    if (!recentSessions.length) {
      container.innerHTML = '<div class="cs-state">未找到 Codex 历史会话。如果你使用过 Codex，会话文件应在 ~/.codex/sessions/ 目录下。</div>';
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
         <button type="button" class="cs-import-btn" onclick="_csImportCodexSessions('${_csEsc(agentType)}')">导入所选会话（最多 3 条）</button>
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
    container.innerHTML = `<div class="cs-state err">读取 Codex 会话失败：${_csEsc(msg)}</div>`;
  }
}

// ── OpenCode sessions: scan ~/.local/share/opencode/opencode.db ──
async function _csLoadOpencodeSessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', '<div class="cs-state loading">正在扫描 OpenCode 会话…</div>');
  if (!container) return;

  try {
    const res = await window.orkas.invoke('sessionImport.listOpencodeSessions');

    if (!res.ok) {
      const errorMsg = res.error === 'not_installed'
        ? '未找到 OpenCode 数据库（~/.local/share/opencode/opencode.db 不存在）'
        : res.error === 'bad_schema'
        ? 'OpenCode 数据库结构不兼容，可能版本不匹配'
        : `读取 OpenCode 数据库失败：${res.error}`;
      container.innerHTML = `<div class="cs-state">${errorMsg}</div>`;
      _csUpdateAssetCount(agentType, 'sessions', 0);
      return;
    }

    const sessions = res.sessions || [];
    console.log('[ONBOARDING] OpenCode sessions - total count:', sessions.length);

    if (!sessions.length) {
      container.innerHTML = '<div class="cs-state">未找到 OpenCode 历史会话。</div>';
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
      const msgCount = s.messageCount > 0 ? `${s.messageCount} 条消息` : '无消息';
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
         <button type="button" class="cs-import-btn" onclick="_csImportOpencodeSessions('${_csEsc(agentType)}')">导入所选会话（最多 3 条）</button>
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
    container.innerHTML = `<div class="cs-state err">读取 OpenCode 会话失败：${_csEsc(msg)}</div>`;
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
    if (result) result.textContent = '请先勾选要导入的会话';
    return;
  }
  if (selected.length > 3) {
    if (result) result.textContent = '一次最多只能导入 3 条会话，请减少勾选数量';
    return;
  }

  if (result) result.textContent = 'OpenCode 会话导入功能开发中…';
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
    if (result) result.textContent = '请先勾选要导入的会话';
    return;
  }
  // Enforce 3-session limit.
  if (selected.length > 3) {
    if (result) result.textContent = '一次最多只能导入 3 条会话，请减少勾选数量';
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
    if (btn) btn.textContent = `导入中… ${done}/${total}`;
    if (result) result.textContent = `正在导入并提炼认知（${done}/${total} 完成）· 大会话需要一点时间，请稍候…`;
  };
  paint();
  selected.forEach((r) => r.classList.add('importing'));
  await _csMapWithConcurrency(selected, CS_IMPORT_CONCURRENCY, async (row) => {
    const filePath = row.dataset.sessionId;
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
  if (btn) { btn.disabled = false; btn.textContent = '导入所选会话（最多 3 条）'; }
  if (result) {
    result.textContent = `导入完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}${cognitions ? `，提取 ${cognitions} 条候选认知` : ''}`;
  }
  // Trigger conversation list refresh so imported sessions appear in sidebar
  if (ok > 0) {
    _csUpdateImportCount(ok);
    await _csRefreshConversationList();
  }
  _obLog.info('claude sessions import finished', { ok, failed, cognitions });
}

// ── WorkBuddy (Tencent) sessions: scan ~/.workbuddy/projects and import ──
// Mirrors the Claude flow. WorkBuddy runs the SAME extract → materialize →
// route pipeline, so imported WorkBuddy sessions become owned cognitive
// assets (candidate cognitions) exactly like Claude sessions do.
async function _csLoadWorkbuddySessions(agentType) {
  const container = _csFillAssetSection(agentType, 'sessions', '<div class="cs-state loading">正在扫描 WorkBuddy 会话…</div>');
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listWorkbuddySessions');
    const recentSessions = (res && res.sessions) || [];

    if (!recentSessions.length) {
      container.innerHTML = '<div class="cs-state">未找到 WorkBuddy 历史会话。如果你使用过 WorkBuddy，会话文件应在 ~/.workbuddy/projects/ 目录下。</div>';
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
         <button type="button" class="cs-import-btn" onclick="_csImportWorkbuddySessions('${_csEsc(agentType)}')">导入所选会话（最多 3 条）</button>
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
    container.innerHTML = `<div class="cs-state err">读取 WorkBuddy 会话失败：${_csEsc(msg)}</div>`;
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
    if (result) result.textContent = '请先勾选要导入的会话';
    return;
  }
  if (selected.length > 3) {
    if (result) result.textContent = '一次最多只能导入 3 条会话，请减少勾选数量';
    return;
  }
  if (btn) { btn.disabled = true; }
  const total = selected.length;
  let ok = 0, failed = 0, cognitions = 0, done = 0;
  const paint = () => {
    if (btn) btn.textContent = `导入中… ${done}/${total}`;
    if (result) result.textContent = `正在导入并提炼认知（${done}/${total} 完成）· 大会话需要一点时间，请稍候…`;
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
  if (btn) { btn.disabled = false; btn.textContent = '导入所选会话（最多 3 条）'; }
  if (result) {
    result.textContent = `导入完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}${cognitions ? `，提取 ${cognitions} 条候选认知` : ''}`;
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
    if (result) result.textContent = '请先勾选要导入的会话';
    return;
  }
  // Enforce 3-session limit.
  if (selected.length > 3) {
    if (result) result.textContent = '一次最多只能导入 3 条会话，请减少勾选数量';
    return;
  }
  if (btn) { btn.disabled = true; }
  const total = selected.length;
  let ok = 0, failed = 0, done = 0;
  const paint = () => {
    if (btn) btn.textContent = `导入中… ${done}/${total}`;
    if (result) result.textContent = `正在导入（${done}/${total} 完成），请稍候…`;
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
  if (btn) { btn.disabled = false; btn.textContent = '导入所选会话（最多 3 条）'; }
  if (result) {
    result.textContent = `导入完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}`;
  }
  // Trigger conversation list refresh so imported sessions appear in sidebar
  if (ok > 0) {
    _csUpdateImportCount(ok);
    await _csRefreshConversationList();
  }
  _obLog.info('codex sessions import finished', { ok, failed });
}

// ── Skills: scan ~/.claude/skills and import selected into the skill library ──
async function _csLoadClaudeSkills(agentType) {
  console.log('[CLAUDE SKILLS] _csLoadClaudeSkills called for agentType:', agentType);
  const container = _csFillAssetSection(agentType, 'skills', '<div class="cs-state loading">正在扫描本机技能…</div>');
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
      container.innerHTML = '<div class="cs-state">未在本机找到 Claude Code 技能（~/.claude/skills 为空或不存在）。</div>';
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
      ? `<button type="button" class="cs-toggle-more" data-target="skills-${_csEsc(agentType)}">显示全部 ${skills.length} 个技能</button>`
      : '';

    container.innerHTML = rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-skill-import-btn" data-agent="${_csEsc(agentType)}">导入所选技能</button>
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
        moreBtn.textContent = allVisible ? `显示全部 ${skills.length} 个技能` : '收起';
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
    container.innerHTML = `<div class="cs-state err">扫描本机技能失败：${_csEsc(msg)}</div>`;
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
    resultBox.innerHTML = '<div class="cs-state">请先勾选要导入的技能。</div>';
    return;
  }

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">正在导入 ${dirNames.length} 个技能…</div>`;

  // Determine which agent type this is (Claude or Codex) based on the button's data-agent attribute
  const agentType = btn.dataset.agent;
  const ipcMethod = agentType === 'codex' ? 'sessionImport.importCodexSkills' : 'sessionImport.importClaudeSkills';

  try {
    const res = await window.cogseed.invoke(ipcMethod, { dirNames });
    const okCount = (res && res.okCount) || 0;
    const failCount = (res && res.failCount) || 0;
    const imported = (res && res.imported) || [];
    const lines = imported.map((r) => {
      if (r.ok) return `✓ ${_csEsc(r.name)}：已导入`;
      if (r.reason === 'already_exists') return `• ${_csEsc(r.name)}：已存在，跳过`;
      return `✗ ${_csEsc(r.name)}：导入失败（${_csEsc(r.reason || '未知原因')}）`;
    });
    const summary =
      `<div class="cs-state">技能导入完成：成功 ${okCount} 个` +
      (failCount ? `，失败 ${failCount} 个` : '') +
      '。导入的技能已进入你的技能库。</div>';
    resultBox.innerHTML = summary + `<div class="cs-import-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
    _obLog.info('skill import finished', { agentType, okCount, failCount });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('skill import failed', { agentType, error: msg });
    resultBox.innerHTML = `<div class="cs-state err">导入技能失败：${_csEsc(msg)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Codex Skills ────────────────────────────────────────────────────────────
async function _csLoadCodexSkills(agentType) {
  console.log('[CODEX SKILLS] _csLoadCodexSkills called for agentType:', agentType);
  const container = _csFillAssetSection(agentType, 'skills', '<div class="cs-state loading">正在扫描 Codex 技能…</div>');
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
      container.innerHTML = '<div class="cs-state">未在本机找到 Codex 技能（~/.codex/skills/.system 为空或不存在）。</div>';
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
      ? `<button type="button" class="cs-toggle-more" data-target="skills-${_csEsc(agentType)}">显示全部 ${skills.length} 个技能</button>`
      : '';

    container.innerHTML = rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-skill-import-btn" data-agent="${_csEsc(agentType)}">导入所选技能</button>
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
        moreBtn.textContent = allVisible ? `显示全部 ${skills.length} 个技能` : '收起';
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
    container.innerHTML = `<div class="cs-state err">扫描 Codex 技能失败：${_csEsc(msg)}</div>`;
  }
}

// ── Memory: Claude Code keeps memory in FOUR places under ~/.claude. We
//    preview each source separately (instructions / rules / auto / history),
//    let the user pick which to import, and route everything into the shared
//    knowledge tier. Absent sources show an honest empty state, not a hidden gap.
const _CS_MEM_REASONS = {
  not_found: '未找到',
  unreadable: '无法读取',
  too_large: '文件过大，已跳过',
  empty: '存在但没有可导入条目',
};

async function _csLoadClaudeMemory(agentType) {
  const container = _csFillAssetSection(agentType, 'memory', '<div class="cs-state loading">正在读取记忆…</div>');
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.readClaudeMemories');
    const sources = (res && res.sources) || [];
    const total = (res && res.totalEntries) || 0;

    if (!sources.length) {
      container.innerHTML =
        '<div class="cs-state">未检测到 Claude Code 记忆文件。记忆来自 Claude Code 使用中自动生成的 CLAUDE.md、MEMORY.md、项目 memory 等文件——先用 Claude Code 工作一段时间，或手动在 ~/.claude/ 下创建这些文件后，这里会出现可导入的记忆。</div>';
      return;
    }

    // One block per source: checkbox + label + count + sample. Present sources
    // are checked by default; absent ones show the honest reason and disable.
    const blocks = sources.map((s) => {
      const present = !!s.present;
      const reason = !present ? (_CS_MEM_REASONS[s.reason] || '不可用') : '';
      const detail = s.detail ? `（${_csEsc(s.detail)}）` : '';
      const sample = present && (s.sample || []).length
        ? `<div class="cs-import-lines">${(s.sample || []).map((x) => `<div>${_csEsc(x)}</div>`).join('')}${s.entryCount > (s.sample || []).length ? '<div>…</div>' : ''}</div>`
        : '';
      const meta = present
        ? `${s.entryCount} 条${detail}`
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
      `<div class="cs-state">Claude Code 的记忆分布在七个来源，共检测到 ${total} 条可导入条目。选择要导入的来源，导入后进入共享知识库，供各 Agent 使用。</div>` +
      `<div class="cs-mem-sources">${blocks}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-mem-import-btn" data-agent="${_csEsc(agentType)}" ${canImport ? '' : 'disabled'}>导入所选记忆</button>
         <div class="cs-import-result cs-mem-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    const btn = container.querySelector('.cs-mem-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportClaudeMemory(container));

    _obLog.info('previewed Claude memory sources', { total, sources: sources.map((s) => `${s.key}:${s.entryCount}`) });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to read Claude memory sources', { error: msg });
    container.innerHTML = `<div class="cs-state err">读取记忆失败：${_csEsc(msg)}</div>`;
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
    resultBox.innerHTML = '<div class="cs-state">请至少勾选一个记忆来源。</div>';
    return;
  }

  if (btn) btn.disabled = true;
  resultBox.innerHTML = '<div class="cs-extract-progress">正在导入记忆…</div>';

  try {
    const res = await window.cogseed.invoke('sessionImport.importClaudeMemories', { sourceKeys });
    if (!res || !res.ok) {
      const reason = (res && res.reason) || '未知原因';
      resultBox.innerHTML = `<div class="cs-state err">导入记忆失败：${_csEsc(reason)}</div>`;
      if (btn) btn.disabled = false;
      return;
    }
    const added = res.added || 0;
    const skipped = res.skipped || 0;
    const rejected = res.rejected || 0;
    resultBox.innerHTML =
      `<div class="cs-state">记忆导入完成：新增 ${added} 条` +
      (skipped ? `，已存在跳过 ${skipped} 条` : '') +
      (rejected ? `，被安全校验拦截 ${rejected} 条` : '') +
      '。已进入共享知识库。</div>';
    _csToast(`已导入 ${added} 条记忆到知识库`);
    _obLog.info('memory import finished', { added, skipped, rejected, perSource: res.perSource });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('memory import failed', { error: msg });
    resultBox.innerHTML = `<div class="cs-state err">导入记忆失败：${_csEsc(msg)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Codex memory: read config.toml preferences and import into shared memory ──
async function _csLoadCodexMemory(agentType) {
  const container = _csFillAssetSection(agentType, 'memory', '<div class="cs-state loading">正在读取 Codex 配置…</div>');
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.readCodexMemory');
    const present = res && res.present;
    const entries = (res && res.entries) || [];

    if (!present || !entries.length) {
      const reason = res.reason === 'not_found' ? '未找到 config.toml' : '配置文件为空';
      container.innerHTML = `<div class="cs-state">Codex 配置记忆（~/.codex/config.toml）${reason}。</div>`;
      return;
    }

    const sample = entries.slice(0, 5).map((e) => `<div>${_csEsc(e)}</div>`).join('');
    const more = entries.length > 5 ? '<div>…</div>' : '';

    container.innerHTML =
      `<div class="cs-state">从 Codex config.toml 检测到 ${entries.length} 条配置偏好。导入后进入共享知识库。</div>` +
      `<div class="cs-import-lines">${sample}${more}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-codex-mem-import-btn" data-agent="${_csEsc(agentType)}">导入 Codex 配置</button>
         <div class="cs-import-result cs-codex-mem-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    const btn = container.querySelector('.cs-codex-mem-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportCodexMemory(container));

    _obLog.info('previewed Codex memory', { count: entries.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to read Codex memory', { error: msg });
    container.innerHTML = `<div class="cs-state err">读取 Codex 配置失败：${_csEsc(msg)}</div>`;
  }
}

async function _csImportCodexMemory(container) {
  const btn = container.querySelector('.cs-codex-mem-import-btn');
  const resultBox = container.querySelector('.cs-codex-mem-result');
  if (!resultBox) return;

  if (btn) btn.disabled = true;
  resultBox.innerHTML = '<div class="cs-extract-progress">正在导入 Codex 配置…</div>';

  try {
    const res = await window.cogseed.invoke('sessionImport.importCodexMemory');
    if (!res || !res.ok) {
      const reason = (res && res.reason) || '未知原因';
      resultBox.innerHTML = `<div class="cs-state err">导入失败：${_csEsc(reason)}</div>`;
      if (btn) btn.disabled = false;
      return;
    }
    const added = res.added || 0;
    const skipped = res.skipped || 0;
    const rejected = res.rejected || 0;
    resultBox.innerHTML =
      `<div style="color:var(--cs-forest-deep);font-size:12px;margin-top:8px;">` +
      `✓ 成功导入 ${added} 条配置偏好` +
      (skipped ? `，跳过 ${skipped} 条已存在` : '') +
      (rejected ? `，拒绝 ${rejected} 条无效条目` : '') +
      `</div>`;
    _obLog.info('imported Codex memory', { added, skipped, rejected });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to import Codex memory', { error: msg });
    resultBox.innerHTML = `<div class="cs-state err">导入失败：${_csEsc(msg)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Scheduled tasks: Claude Code has no native on-disk scheduled-task store. ──
// We show an honest "no native source" state rather than misreading its
// per-session TODO files (~/.claude/tasks/) as scheduled tasks.
function _csRenderNoTasks(agentType) {
  _csFillAssetSection(agentType, 'tasks',
    '<div class="cs-state">Claude Code 没有原生的定时任务存储，暂无可导入的定时任务。你可以在本应用的「定时任务」模块里直接新建。</div>');
}

// ── OpenCode memory: config preferences from opencode.json/.jsonc ─────────
async function _csLoadOpencodeMemory(agentType) {
  const container = _csFillAssetSection(agentType, 'memory', '<div class="cs-state loading">正在读取 OpenCode 配置…</div>');
  if (!container) return;

  try {
    const res = await window.orkas.invoke('sessionImport.readOpencodeMemory');
    const present = res && res.present;
    const entries = (res && res.entries) || [];

    if (!present || !entries.length) {
      const reasonText = res && res.reason === 'not_found'
        ? '未找到 opencode.json / opencode.jsonc 配置文件'
        : '配置文件为空（没有可导入的模型/指令偏好）';
      container.innerHTML =
        `<div class="cs-state">OpenCode 配置记忆（~/.config/opencode/opencode.json）${reasonText}。` +
        `配置了模型提供商或全局指令后，这里会出现可导入的偏好。</div>`;
      return;
    }

    const sample = entries.slice(0, 5).map((e) => `<div>${_csEsc(e)}</div>`).join('');
    const more = entries.length > 5 ? '<div>…</div>' : '';

    container.innerHTML =
      `<div class="cs-state">从 OpenCode 配置检测到 ${entries.length} 条偏好。导入后进入共享知识库。</div>` +
      `<div class="cs-import-lines">${sample}${more}</div>` +
      `<div class="cs-import-bar">
         <button type="button" class="cs-codex-mem-import-btn" data-agent="${_csEsc(agentType)}">导入 OpenCode 配置</button>
         <div class="cs-import-result cs-codex-mem-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    const btn = container.querySelector('.cs-codex-mem-import-btn');
    if (btn) btn.addEventListener('click', () => void _csImportCodexMemory(container));

    _obLog.info('previewed OpenCode memory', { count: entries.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to read OpenCode memory', { error: msg });
    container.innerHTML = `<div class="cs-state err">读取 OpenCode 配置失败：${_csEsc(msg)}</div>`;
  }
}

// OpenCode has no scheduled-task feature (its `todo` table is an in-session
// task checklist). We surface the REAL todos and import them as one-time
// tasks — honestly labeled, never a fabricated cadence.
async function _csLoadOpencodeTasks(agentType) {
  const container = _csFillAssetSection(agentType, 'tasks', '<div class="cs-state loading">正在读取 OpenCode 任务清单…</div>');
  if (!container) return;

  try {
    const res = await window.orkas.invoke('sessionImport.listOpencodeTodos');
    const todos = (res && res.todos) || [];

    if (!todos.length) {
      container.innerHTML =
        '<div class="cs-state">OpenCode 没有定时任务功能；其会话内任务清单（todo）也是空的。</div>';
      return;
    }

    const statusZh = (s) => (s === 'completed' ? '已完成' : (s === 'in_progress' ? '进行中' : _csEsc(s || '待办')));
    const rows = todos.map((t, idx) => {
      const hidden = idx >= 3 ? ' style="display:none"' : '';
      const src = t.sessionTitle ? `<small>来自会话：${_csEsc(t.sessionTitle)}</small>` : '';
      return `
        <div class="cs-src cs-collapsible-item"${hidden} data-todo-id="${_csEsc(t.id)}">
          <input type="checkbox" />
          <div class="s-ico">${CS_TERMINAL_SVG}</div>
          <div>
            <strong>${_csEsc(t.content)}</strong>
            ${src}
          </div>
          <small style="color:var(--cs-muted);white-space:nowrap;">${statusZh(t.status)}</small>
        </div>`;
    }).join('');

    const toggleBtn = todos.length > 3
      ? `<button type="button" class="cs-toggle-more">显示全部 ${todos.length} 条任务</button>`
      : '';

    container.innerHTML =
      `<div class="cs-state">检测到 ${todos.length} 条 OpenCode 任务清单（todo，无定时调度）。勾选后导入为一次性任务，执行时间默认为 1 小时后，可在「任务」模块调整。</div>` +
      rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportOpencodeTodos('${_csEsc(agentType)}')">导入所选任务</button>
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
        moreBtn.textContent = allVisible ? `显示全部 ${todos.length} 条任务` : '收起';
      });
    }

    const badge = document.getElementById(`cs-count-${agentType}-tasks`);
    if (badge) badge.textContent = `(${todos.length})`;

    _obLog.info('loaded OpenCode todos', { count: todos.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load OpenCode todos', { error: msg });
    container.innerHTML = `<div class="cs-state err">读取 OpenCode 任务清单失败：${_csEsc(msg)}</div>`;
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
    if (resultBox) resultBox.innerHTML = '<div class="cs-state">请先勾选要导入的任务。</div>';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
  if (resultBox) resultBox.innerHTML = '<div class="cs-state loading">正在导入所选任务…</div>';
  try {
    const res = await window.orkas.invoke('sessionImport.importOpencodeTodos', { todoIds: selected });
    const r = res || {};
    const parts = [`成功 ${r.imported || 0} 条`];
    if (r.skipped) parts.push(`跳过 ${r.skipped} 条`);
    if (r.failed) parts.push(`失败 ${r.failed} 条`);
    resultBox.innerHTML =
      `<div class="cs-state">导入完成：${parts.join('，')}。已作为一次性任务加入「任务」模块（默认 1 小时后执行，可调整）。</div>`;
    selected.forEach((id) => {
      const row = container.querySelector(`.cs-src[data-todo-id="${id}"]`);
      if (row) { row.classList.add('done'); const cb = row.querySelector('input[type="checkbox"]'); if (cb) cb.checked = false; }
    });
    _obLog.info('opencode todos import finished', { selected: selected.length, result: r });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('opencode todos import failed', { error: msg });
    if (resultBox) resultBox.innerHTML = `<div class="cs-state err">导入任务失败：${_csEsc(msg)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '导入所选任务'; }
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
  const freqZh = { HOURLY: '小时', DAILY: '天', WEEKLY: '周', MONTHLY: '月', MINUTELY: '分钟' }[freq];
  if (!freqZh) return rrule;
  return interval > 1 ? `每 ${interval} ${freqZh}` : `每${freqZh}`;
}

// ── Codex scheduled tasks: read from ~/.codex/sqlite/codex-dev.db automations.
async function _csLoadCodexTasks(agentType) {
  const container = _csFillAssetSection(agentType, 'tasks', '<div class="cs-state loading">正在读取 Codex 定时任务…</div>');
  if (!container) return;

  try {
    const res = await window.cogseed.invoke('sessionImport.listCodexTasks');
    const tasks = (res && res.tasks) || [];

    if (!tasks.length) {
      container.innerHTML =
        '<div class="cs-state">暂无本地定时任务。ChatGPT 的定时任务保存在云端账号里，本应用只读取本地数据、不接入云端账号，因此这里只显示通过 codex 命令行在本机创建的自动化任务。</div>';
      return;
    }

    const rows = tasks.map((t, idx) => {
      const hidden = idx >= 3 ? ' style="display:none"' : '';
      const cadence = _csFmtRRule(t.rrule);
      const statusZh = t.status === 'ACTIVE' ? '启用' : (t.status === 'PAUSED' ? '暂停' : _csEsc(t.status || ''));
      const meta = [
        cadence ? `⏱ ${_csEsc(cadence)}` : '',
        `状态：${statusZh}`,
        t.nextRunAt ? `下次：${_csFmtTaskTime(t.nextRunAt)}` : '',
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
      ? `<button type="button" class="cs-toggle-more">显示全部 ${tasks.length} 个任务</button>`
      : '';

    container.innerHTML =
      `<div class="cs-state">检测到 ${tasks.length} 个 Codex 定时任务，勾选后导入到本应用的任务中心。</div>` +
      rows + toggleBtn +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" onclick="_csImportCodexTasks('${_csEsc(agentType)}')">导入所选任务</button>
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
        moreBtn.textContent = allVisible ? `显示全部 ${tasks.length} 个任务` : '收起';
      });
    }

    const badge = document.getElementById(`cs-count-${agentType}-tasks`);
    if (badge) badge.textContent = `(${tasks.length})`;

    _obLog.info('loaded Codex tasks', { count: tasks.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load Codex tasks', { error: msg });
    container.innerHTML = `<div class="cs-state err">读取 Codex 定时任务失败：${_csEsc(msg)}</div>`;
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
    if (resultBox) resultBox.innerHTML = '<div class="cs-state">请先勾选要导入的任务。</div>';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
  if (resultBox) resultBox.innerHTML = '<div class="cs-state loading">正在导入所选任务…</div>';
  try {
    const res = await window.cogseed.invoke('sessionImport.importCodexTasks', { taskIds: selected });
    const r = res || {};
    const parts = [`成功 ${r.imported || 0} 个`];
    if (r.skipped) parts.push(`跳过 ${r.skipped} 个`);
    if (r.unsupported) parts.push(`不支持 ${r.unsupported} 个`);
    if (r.failed) parts.push(`失败 ${r.failed} 个`);
    const reasons = (r.items || [])
      .filter((i) => i.status !== 'imported' && i.reason)
      .map((i) => `${_csEsc(i.name)}：${_csEsc(i.reason)}`)
      .join('；');
    resultBox.innerHTML = `<div class="cs-state">导入完成：${parts.join('，')}。${reasons ? `<br>${reasons}` : ''}已导入的任务可在「任务」模块中查看与管理。</div>`;
    selected.forEach((id) => {
      const row = container.querySelector(`.cs-src[data-task-id="${id}"]`);
      if (row) { row.classList.add('done'); row.querySelector('input[type="checkbox"]').checked = false; }
    });
    _obLog.info('codex tasks import finished', { selected: selected.length, result: r });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('codex tasks import failed', { error: msg });
    if (resultBox) resultBox.innerHTML = `<div class="cs-state err">导入定时任务失败：${_csEsc(msg)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '导入所选任务'; }
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
    resultBox.innerHTML = '<div class="cs-state">请先勾选要导入的会话。</div>';
    return;
  }

  // Limit: maximum 3 sessions per import
  if (selected.length > 3) {
    resultBox.innerHTML = '<div class="cs-state error">一次最多只能导入 3 个会话，请取消勾选多余的会话。</div>';
    return;
  }

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">正在导入 ${selected.length} 个会话…</div>`;

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
          lines.push(`⚠ ${_csEsc(item.title || '会话')}：已导入（未能自动提炼，按原始开头保留）`);
        } else {
          okCount += 1;
          lines.push(`✓ ${_csEsc(item.title || '会话')}：已提炼并导入${cog ? `，提取候选认知 ${cog} 条` : ''}`);
        }
      } else {
        failCount += 1;
        lines.push(`✗ ${_csEsc(item.title || '会话')}：导入失败（${_csEsc((res && res.reason) || '未知原因')}）`);
      }
    } catch (err) {
      failCount += 1;
      const msg = (err && err.message) || String(err);
      lines.push(`✗ ${_csEsc(item.title || '会话')}：${_csEsc(msg)}`);
    }
  }

  const summary =
    `<div class="cs-state">导入完成：成功 ${okCount} 个` +
    (degradedCount ? `，未提炼 ${degradedCount} 个` : '') +
    (failCount ? `，失败 ${failCount} 个` : '') +
    (cogTotal ? `；共提取候选认知 ${cogTotal} 条，可在「回忆/候选审核」中确认` : '') +
    `。导入的会话已出现在左侧会话列表，点进去即可继续对话。</div>`;
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

      const agentLabel = agentType === 'hermes' ? 'Hermes (ACP 录制)'
        : agentType === 'claude-desktop' ? 'Claude Desktop (ACP 录制)'
        : `${agentType} (ACP 录制)`;

      const groupHtml = `
        <div class="cs-group-head" data-group="acp-${_csEsc(agentType)}" style="margin-top:16px">
          <span class="g-name">${CS_TERMINAL_SVG}${_csEsc(agentLabel)}</span>
          <span class="g-status">从录制文件读取</span>
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

// Load role templates from backend (张浩的角色模板系统)
async function _csLoadRoleTemplates() {
  const box = document.getElementById('cs-role-cards');
  if (!box) return;

  box.innerHTML = '<div class="cs-state loading">正在加载角色模板...</div>';

  try {
    const res = await window.cogseed.invoke('spaces.templates.list');
    if (!res || !res.templates || !Array.isArray(res.templates)) {
      box.innerHTML = '<div class="cs-state">角色模板加载失败</div>';
      return;
    }

    const templates = res.templates;
    if (templates.length === 0) {
      box.innerHTML = '<div class="cs-state">没有可用的角色模板</div>';
      return;
    }

    // 按优先级筛选主要角色（产品、工程、研究、学习方向）
    const priority = ['product_manager', 'software_engineer', 'scholar', 'student', 'fde', 'project_manager', 'technical_writer', 'recruiter'];
    const prioritySet = new Set(priority);
    const priorityTemplates = templates.filter(t => prioritySet.has(t.template_id));
    const otherTemplates = templates.filter(t => !prioritySet.has(t.template_id));

    // 优先级排序
    priorityTemplates.sort((a, b) => priority.indexOf(a.template_id) - priority.indexOf(b.template_id));

    // 全部展示：优先角色在前，其余模板（空白空间等）跟在后面
    const display = [...priorityTemplates, ...otherTemplates];

    // 图标映射
    const icons = {
      'product_manager': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      'software_engineer': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>',
      'scholar': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z"/></svg>',
      'student': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>',
      'fde': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      'project_manager': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M3 9h18M3 15h18"/></svg>',
      'technical_writer': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
      'recruiter': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    };

    const html = display.map(t => {
      const icon = icons[t.template_id] || icons['product_manager'];
      const bundleInfo = [];
      if (t.bundle) {
        const skillCount = (t.bundle.skill_ids || []).length;
        const agentCount = (t.bundle.agent_ids || []).length;
        if (skillCount > 0) bundleInfo.push(`${skillCount} 个技能`);
        if (agentCount > 0) bundleInfo.push(`${agentCount} 个智能体`);
      }
      const tags = bundleInfo.length > 0
        ? `<span class="r-tags">${bundleInfo.map(info => `<span class="r-tag">${_csEsc(info)}</span>`).join('')}</span>`
        : '';

      // 描述截断：模板原文可能很长，只展示一句核心说明，避免把
      // 底部「完成设置」按钮挤出首屏。
      const desc = String(t.description || '').trim();
      const shortDesc = desc.length > 56 ? `${desc.slice(0, 56)}…` : desc;

      return `
        <button class="cs-role-card" data-template-id="${_csEsc(t.template_id)}">
          <span class="r-ico">${icon}</span>
          <h3>${_csEsc(t.name)}</h3>
          <p>${_csEsc(shortDesc)}</p>
          ${tags}
        </button>
      `;
    }).join('');

    // 全部角色放在一个可滑动区域里（滚动浏览），底部操作按钮
    // （跳过 / 完成设置）固定可见，不被卡片数量挤下去。
    box.innerHTML = `<div class="cs-role-scroll">${html}</div>`;
    const scrollBox = box.querySelector('.cs-role-scroll');
    if (scrollBox && scrollBox.scrollHeight > scrollBox.clientHeight) {
      scrollBox.classList.add('has-overflow');
    }

    // If the user came in via card ① (继续项目) and the backend matched a
    // template from that session's REAL content, pre-select it and mark the
    // card so the origin of the suggestion is transparent. The user can still
    // pick another card or skip — this only sets a default.
    if (_csSuggestedTemplateId) {
      const suggested = box.querySelector(`.cs-role-card[data-template-id="${_csSuggestedTemplateId}"]`);
      if (suggested) {
        suggested.classList.add('is-suggested');
        // Move it to the front so the recommendation is the first thing seen.
        const scroll = box.querySelector('.cs-role-scroll');
        if (scroll && scroll.firstChild) scroll.insertBefore(suggested, scroll.firstChild);
        _csPickRole(_csSuggestedTemplateId);
        const kw = _csRecommendation && _csRecommendation.suggestedTemplate
          ? (_csRecommendation.suggestedTemplate.matchedKeywords || []).slice(0, 4).join('、')
          : '';
        _csToast(kw ? `根据你会话里的「${kw}」推荐了这个角色，可自行更换` : '已为你推荐一个角色，可自行更换');
      }
    }
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load role templates', { error: msg });
    box.innerHTML = '<div class="cs-state">角色模板加载失败</div>';
  }
}

function _csPickRole(templateId) {
  const shell = document.getElementById('cs-onboarding');
  if (!shell) return;
  shell.querySelectorAll('.cs-role-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.templateId === templateId);
  });
  _csRolePicked = templateId;

  // 获取选中模板的名称
  const selectedCard = shell.querySelector(`.cs-role-card[data-template-id="${templateId}"]`);
  const name = selectedCard ? selectedCard.querySelector('h3').textContent : templateId;

  const result = document.getElementById('cs-role-result');
  if (result) {
    result.querySelector('h4').textContent = `角色模板已应用：「${name}」 · 不会自动生成关于你的信息`;
    result.classList.add('show');
  }
  _csToast(`已选择「${name}」角色模板，之后随时能换`);
}

async function _csFinish() {
  const btn = document.getElementById('cs-ob-finish');
  if (btn) btn.disabled = true;

  _obLog.info('_csFinish called', {
    rolePicked: _csRolePicked,
    importedCount: _csImportedConversationIds.length,
    importedIds: _csImportedConversationIds
  });

  // 候选认知已在导入时后台提取并存入候选池，留待用户首次打开导入会话时由
  // agent 主动呈现和确认，此处不再处理候选认知的 UI 确认和 reject/keep 逻辑。

  // 如果用户选择了角色模板，创建工作空间并应用模板。当有导入的会话时再把它们
  // 绑定到该工作空间；选项③「从空白任务开始」会选角色但不导入任何会话，此时
  // 只创建工作空间以「快速带入角色能力」，不创建空的「导入的会话」项目分组。
  if (_csRolePicked) {
    // 获取模板信息
    const shell = document.getElementById('cs-onboarding');
    const selectedCard = shell ? shell.querySelector(`.cs-role-card[data-template-id="${_csRolePicked}"]`) : null;
    const spaceName = selectedCard ? selectedCard.querySelector('h3').textContent : _csRolePicked;

    try {
      // Reuse an existing space for this template instead of stacking up empty
      // duplicates. Re-running onboarding (or picking the same role twice)
      // should land in the SAME workspace, not create "学生"/"学生"/"学生".
      let spaceId = '';
      try {
        const listRes = await window.cogseed.invoke('spaces.list', {});
        const existing = (listRes && listRes.spaces || []).find((s) => s && s.template_id === _csRolePicked);
        if (existing && existing.space_id) {
          spaceId = existing.space_id;
          _obLog.info('reusing existing role workspace', { templateId: _csRolePicked, spaceId });
        }
      } catch (listErr) {
        _obLog.warn('spaces.list failed before create', { error: (listErr && listErr.message) || String(listErr) });
      }

      // Only create when no space for this template exists yet.
      if (!spaceId) {
        const createRes = await window.cogseed.invoke('spaces.create', {
          name: spaceName,
          template_id: _csRolePicked,
        });
        if (createRes && createRes.space && createRes.space.space_id) {
          spaceId = createRes.space.space_id;
          _obLog.info('created role workspace', { templateId: _csRolePicked, spaceId, name: spaceName });
        }
      }

      if (spaceId && _csImportedConversationIds.length === 0) {
        // 选项③「从空白任务开始」：只创建/复用角色工作空间，不导入会话。
        // 告诉用户角色能力已就绪，跳过项目分组与会话绑定。
        _obLog.info('blank-start path: role workspace ready without imported sessions', {
          templateId: _csRolePicked,
          spaceId,
        });
        _csToast(`已就绪「${spaceName}」角色工作空间，可直接开始新任务`);
      } else if (spaceId) {

        // Reuse an existing project already bound to this space, so re-running
        // onboarding doesn't stack duplicate "导入的会话" folders under the same
        // role. Only create a new one when the space has no project yet. The
        // project is named after the role template so the sidebar shows it as
        // the role's workspace, not a generic "导入的会话" bucket.
        let projectId = '';
        try {
          const projList = await window.cogseed.invoke('projects.list', {});
          const bound = (projList && projList.projects || []).find((p) => p && p.space_id === spaceId);
          if (bound && bound.project_id) {
            projectId = bound.project_id;
            _obLog.info('reusing existing project under role workspace', { spaceId, projectId });
          }
        } catch (projListErr) {
          _obLog.warn('projects.list failed before create', { error: (projListErr && projListErr.message) || String(projListErr) });
        }

        if (!projectId) {
          // Project name is the neutral purpose "导入的会话", NOT the role name:
          // the role/space name is already shown by the sidebar space-group
          // header above it. Naming the project after the role too would read as
          // a redundant "产品经理 > 产品经理". So: space = 产品经理, project = 导入的会话.
          const projectRes = await window.cogseed.invoke('projects.create', { name: '导入的会话' });
          if (projectRes && projectRes.project && projectRes.project.project_id) {
            projectId = projectRes.project.project_id;
            // 把项目挂到工作空间下（项目创建接口本身不接收 spaceId）。
            try {
              await window.cogseed.invoke('projects.bindSpace', { projectId, spaceId });
            } catch (bindErr) {
              _obLog.warn('failed to bind role project to workspace', {
                projectId,
                spaceId,
                error: (bindErr && bindErr.message) || String(bindErr),
              });
            }
          }
        }

        if (projectId) {

          // 批量更新所有导入的会话，绑定到这个项目
          const updateRes = await window.cogseed.invoke('conversations.batchUpdateProject', {
            conversationIds: _csImportedConversationIds,
            projectId: projectId,
          });

          if (updateRes && updateRes.ok) {
            _obLog.info('bound imported sessions to role workspace project', {
              templateId: _csRolePicked,
              spaceId,
              projectId,
              updated: updateRes.updated,
              total: _csImportedConversationIds.length,
            });
            _csToast(`已将 ${updateRes.updated} 个导入的会话归入「${spaceName}」角色分组`);
          }

          // 新项目不在 boot 时的项目缓存里，且默认未展开；先刷新项目缓存并
          // 展开/加载该项目，否则导入的会话既不在普通会话列表、也不显示在
          // 项目区（看起来就像导入后丢失了）。
          try {
            if (typeof _projectsExpanded === 'object' && _projectsExpanded) {
              _projectsExpanded[projectId] = true;
            }
            if (typeof _saveProjectsExpanded === 'function') _saveProjectsExpanded();
            if (typeof loadProjects === 'function') await loadProjects(true);
            if (typeof loadConversationProject === 'function') await loadConversationProject(projectId);
          } catch (revealErr) {
            _obLog.warn('failed to reveal imported-session project in sidebar', {
              projectId,
              error: (revealErr && revealErr.message) || String(revealErr),
            });
          }
        } else {
          // 工作空间创建成功，但项目创建失败 - 导入的会话保留在未分组状态
          _obLog.info('workspace created but project creation failed, imported sessions remain ungrouped', {
            spaceId,
            conversationCount: _csImportedConversationIds.length,
          });
          _csToast(`已创建「${spaceName}」工作空间，导入的会话已添加到普通对话列表`);
        }
      }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      _obLog.warn('failed to create role workspace or bind sessions', { error: msg });
      _csToast('创建角色工作空间失败，导入的会话已添加到普通对话列表');
    }
  }

  try {
    await window.cogseed.invoke('prefs.setOnboarding', { completed: true });
    _obLog.info('onboarding completed and persisted');
  } catch (err) {
    // Persisting the marker failed — surface it rather than silently
    // trapping the user in a loop that re-fires the walkthrough next boot.
    _obLog.warn('failed to persist onboarding completion', { error: (err && err.message) || String(err) });
    _csToast('保存完成状态失败，下次启动可能再次出现引导');
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

  // After onboarding completes, start the interactive tour
  // (for now, triggers on every launch; later will be gated per account)
  if (typeof window.interactiveTour !== 'undefined' && window.interactiveTour.start) {
    _obLog.info('starting interactive tour after onboarding');
    // Small delay to let the conversation list render
    setTimeout(() => {
      window.interactiveTour.start();
    }, 500);
  }
}

function _csBuild() {
  console.log('[ONBOARDING DEBUG] _csBuild called, _csObBuilt =', _csObBuilt);
  if (_csObBuilt) {
    console.log('[ONBOARDING DEBUG] Already built, returning early');
    return;
  }
  console.log('[ONBOARDING DEBUG] Building onboarding shell');
  const shell = document.createElement('div');
  shell.id = 'cs-onboarding';
  console.log('[ONBOARDING DEBUG] Shell element created:', shell);
  shell.innerHTML = _csObShellHtml();
  console.log('[ONBOARDING DEBUG] Shell innerHTML set, length:', shell.innerHTML.length);
  console.log('[ONBOARDING DEBUG] Appending shell to body');
  document.body.appendChild(shell);
  console.log('[ONBOARDING DEBUG] Shell appended. Checking if in DOM...');
  console.log('[ONBOARDING DEBUG] getElementById result:', document.getElementById('cs-onboarding'));

  const toast = document.createElement('div');
  toast.id = 'cs-ob-toast';
  // Message row + an (initially hidden) indeterminate progress bar. The bar is
  // only shown for long-running atomic ops (session import) where we can't
  // report a real percentage — it signals "working, duration unknown" honestly
  // rather than faking a 0→90% climb.
  toast.innerHTML = '<span class="t-msg"></span><span class="t-bar"><i></i></span>';
  document.body.appendChild(toast);

  // Step navigation (rail buttons + inline next/back buttons).
  shell.querySelectorAll('.cs-step').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.csstep);
      const cur = Number(shell.querySelector('.cs-step.active')?.dataset.csstep || 0);
      if (i >= 0 && i <= cur + 1) _csGoStep(i);
    });
  });
  shell.querySelectorAll('[data-csnext]').forEach((b) => {
    b.addEventListener('click', () => _csGoStep(Number(b.dataset.csnext)));
  });

  shell.querySelector('#cs-team-refresh')?.addEventListener('click', () => _csLoadTeam(true));
  shell.querySelector('#cs-agent-refresh')?.addEventListener('click', () => _csLoadAgents(true));

  // Step 2 fork cards: ① continue recommended project, ② browse other
  // sessions (reveals the by-Agent import UI), ③ start blank → straight to
  // role selection with no import.
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
      // No import; the role step will have nothing pre-selected.
      _csSuggestedTemplateId = null;
      _csGoStep(3);
    }
  });
  // Return from the import sub-view back to the fork cards.
  shell.querySelector('#cs-import-back-fork')?.addEventListener('click', () => _csShowForkView());

  // 使用事件委托处理角色卡片点击（因为卡片是动态加载的）
  shell.querySelector('#cs-role-cards')?.addEventListener('click', (e) => {
    const card = e.target.closest('.cs-role-card');
    if (card && card.dataset.templateId) {
      _csPickRole(card.dataset.templateId);
    }
  });
  shell.querySelector('#cs-role-skip')?.addEventListener('click', () => {
    _csRolePicked = null;
    void _csFinish();
  });

  shell.querySelector('#cs-ob-finish')?.addEventListener('click', () => { void _csFinish(); });

  // Standalone mode: close import flow after importing sessions
  shell.querySelector('#cs-step2-finish')?.addEventListener('click', () => {
    _obLog.info('standalone import flow finished');
    document.body.classList.remove('cs-onboarding-active');
    if (shell) shell.style.display = 'none';
    // Reset standalone mode
    _csStandaloneMode = false;
    // Refresh sidebar to show imported sessions
    void _csRefreshConversationList();
    _csToast('导入完成');
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
  console.log('[ONBOARDING DEBUG] maybeStartOnboarding called');
  _obLog.info('maybeStartOnboarding called');

  try {
    const res = await window.cogseed.invoke('prefs.getOnboarding');
    console.log('[ONBOARDING DEBUG] prefs.getOnboarding result:', res);
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
