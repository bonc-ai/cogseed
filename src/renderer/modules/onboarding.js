// ─── First-run onboarding (CogSeed four-step walkthrough) ──────────────────
//
// Ported from the static prototype (60秒用户旅程.html), rebuilt on top of the
// live mate-agent renderer. Four steps:
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
  codex: 'Codex',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  hermes: 'Hermes',
};

// One neutral terminal glyph for every CLI — we don't ship per-agent brand
// marks in this build and a real logo set can land later.
const CS_TERMINAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>';

function _csEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _csObBuilt = false;
let _csRolePicked = null;
let _csToastTimer = 0;
// 本轮抽取写入候选池后拿到的 candidate_id 列表（按渲染顺序对应卡片）。
// 第 4 步完成时用它把「未勾选的」候选走 reject 从池里丢弃；勾选的原样留在
// 候选池当待确认候选，之后在 Recall 候选审核页人工确认入库。
let _csCandidateIds = [];

function _csToast(msg) {
  const t = document.getElementById('cs-ob-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_csToastTimer);
  _csToastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function _csObShellHtml() {
  return `
  <header class="cs-topbar">
    <div class="cs-brand">
      <span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="M12 13a4 4 0 0 1-4-4 6 6 0 0 1 8 0 4 4 0 0 1-4 4Z"/><path d="M9.5 16.5 12 13l2.5 3.5"/><path d="M12 17v4"/></svg></span>
      <b>COGSEED</b>
    </div>
    <div class="cs-title">首次启动 · 4 步开始</div>
    <div></div>
  </header>
  <div class="cs-main">
    <aside class="cs-rail">
      <h2>让认知先落地</h2>
      <p>完成必要设置后进入首页；以后可在设置中调整。</p>
      <div class="cs-steps">
        <button class="cs-step active" data-csstep="0"><span>1</span><span><strong>认识 CogSeed</strong><small>它不是又一个 Agent</small></span></button>
        <button class="cs-step" data-csstep="1"><span>2</span><span><strong>导入最近会话</strong><small>检测本地 Agent</small></span></button>
        <button class="cs-step" data-csstep="2"><span>3</span><span><strong>选择角色起点</strong><small>可选 · 可跳过</small></span></button>
        <button class="cs-step" data-csstep="3"><span>4</span><span><strong>确认候选认知</strong><small>预览并决定保留</small></span></button>
      </div>
      <div class="cs-privacy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>认知资产与模型 Key 都留在本机。导入 AI 团队的 Key 是你自己的凭证，仅在本机使用，不上传。</span></div>
    </aside>
    <main class="cs-content">

      <section class="cs-panel active" data-cspanel="0">
        <div class="cs-kicker">模型是大家的 · 认知是你的</div>
        <h1>认知，<br>是你唯一带得走的东西。</h1>
        <p class="cs-lead">CogSeed 不是另一个通用 Agent，也不替你写代码。它在你已有的 Agent 工作流之上，发现、确认并保管属于你的能力资产——换模型、换 Agent，认知都跟着你。</p>
        <div class="cs-facts">
          <div class="cs-fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="12" r="4"/></svg><strong>无需注册账号</strong><span>创建本机个人空间，不需要手机号、邮箱或企业身份。</span></div>
          <div class="cs-fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 13v5M12 9v9M17 5v13"/></svg><strong>认知留在本机</strong><span>项目、会话与认知资产不会因为启动应用而自动上传。</span></div>
          <div class="cs-fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><strong>Key 是你自己的</strong><span>可一键把已有 Agent 的模型 Key 导入 AI 团队，仅在本机使用；也可跳过，之后手动配置。</span></div>
        </div>
        <div class="cs-actions">
          <button class="cs-btn" data-csnext="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>继续 · 检测本地 Agent</button>
          <small>继续不代表同意上传任何内容。</small>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="1">
        <div class="cs-kicker">连接 AI 团队 · 导入会话 · 只读</div>
        <h1>先连上模型，再从你的旧对话继续</h1>
        <p class="cs-lead">第一步把你在其他 Agent 里已有的模型 Key 一键接入「AI 团队」——都是你自己的凭证，只留本机。连上之后，导入的旧会话就能用这些模型自动压缩、提炼，接着往下干。</p>

        <h3 style="margin:28px 0 12px;font-size:15px;font-weight:650">连接 AI 团队</h3>
        <div class="cs-list" id="cs-team-list">
          <div class="cs-state loading">正在检测可导入的模型服务…</div>
        </div>
        <div class="cs-mode"><span>这些 Key 来自你本机的 CC Switch 等配置，导入后仅在本机使用、不上传。OAuth 登录类（如订阅登录）无法迁移 Key，需你在设置里另行登录或粘贴。</span></div>

        <h3 style="margin:28px 0 12px;font-size:15px;font-weight:650">检测到的 Agent</h3>
        <div class="cs-list" id="cs-agent-list">
          <div class="cs-state loading">正在检测本机 Agent…</div>
        </div>
        <div class="cs-mode"><span>读取方式：只读导入，不写入任何 Agent，也不自动修改认知资产。认知从任何 Agent 来，带去任何 Agent。</span></div>

        <div class="cs-actions">
          <button class="cs-btn ghost" data-csnext="0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回</button>
          <button class="cs-btn ghost" id="cs-agent-refresh">重新检测 Agent</button>
          <button class="cs-btn" data-csnext="2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>下一步 · 选择角色</button>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="2">
        <div class="cs-kicker">可选 · 非阻断 · 可跳过</div>
        <h1>你主要在做哪类工作？</h1>
        <p class="cs-lead">角色模板只提供结构建议（本体结构、能力建议、Main Skill），<b>不会自动生成关于你的任何事实</b>。现在选择或跳过都可以，之后随时可更换、叠加。</p>
        <div class="cs-role-cards">
          <button class="cs-role-card" data-csrole="product">
            <span class="r-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="12" r="4"/></svg></span>
            <h3>产品负责人</h3>
            <p>适合持续维护 PRD、管理产品边界与交付验收的工作方式。</p>
            <span class="r-tags"><span class="r-tag">产品工作 Workspace</span><span class="r-tag">PRD 回写 Skill</span></span>
          </button>
          <button class="cs-role-card" data-csrole="researcher">
            <span class="r-ico amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z"/></svg></span>
            <h3>AI 研究员</h3>
            <p>适合复现论文、分析开源项目与沉淀研究方法。</p>
            <span class="r-tags"><span class="r-tag">AI 项目交付 Workspace</span><span class="r-tag">论文复现</span></span>
          </button>
        </div>
        <div class="cs-role-result" id="cs-role-result" style="max-width:560px">
          <h4>角色模板已应用 · 不自动生成个人事实</h4>
        </div>
        <div class="cs-actions">
          <button class="cs-btn ghost" data-csnext="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回</button>
          <button class="cs-btn ghost" id="cs-role-skip">跳过角色</button>
          <button class="cs-btn" data-csnext="3"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>下一步 · 确认候选认知</button>
        </div>
      </section>

      <section class="cs-panel" data-cspanel="3">
        <div class="cs-kicker">系统提出 · 用户决定</div>
        <h1>确认候选认知</h1>
        <p class="cs-lead">从你选中的会话中提取候选认知。每条认知都需要你手动确认后才会保存到认知资产中。</p>
        <div class="cs-cands" id="cs-cand-list">
          <div class="cs-state">点击下方「开始提取」按钮，从检测到的会话中分析并提取候选认知。</div>
        </div>
        <div class="cs-actions">
          <button class="cs-btn ghost" data-csnext="2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回</button>
          <button class="cs-btn ghost" id="cs-extract-start">开始提取</button>
          <button class="cs-btn" id="cs-ob-finish"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>完成 · 进入首页</button>
          <small>完成后不会自动写入任何正式资产。</small>
        </div>
      </section>

    </main>
  </div>`;
}

function _csGoStep(n) {
  const step = Math.max(0, Math.min(3, n));
  const shell = document.getElementById('cs-onboarding');
  if (!shell) return;
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
  if (step === 1) {
    _csLoadTeam(false);
    _csLoadAgents(false);
  }
}

// Renders the REAL detection result. For Claude Code, fetches real session
// history from ~/.claude/projects/. For other agents, shows honest "not yet
// implemented" state.
function _csRenderAgents(entries) {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;
  const list = Array.isArray(entries) ? entries : [];
  const available = list.filter((e) => e && e.available);

  if (!available.length) {
    box.innerHTML = '<div class="cs-state">未检测到任何已安装的 Agent 命令行工具（如 Claude Code、Codex）。安装后点「重新检测」即可。</div>';
    return;
  }

  const groupsHtml = [];
  for (const e of available) {
    const label = CS_AGENT_LABELS[e.type] || e.type;
    const ver = e.version ? `v${_csEsc(e.version)}` : '版本未知';
    const p = e.path ? `<span class="g-path" title="${_csEsc(e.path)}">${_csEsc(e.path)}</span>` : '';

    groupsHtml.push(`
      <div class="cs-group-head" data-group="${_csEsc(e.type)}">
        <span class="g-name">${CS_TERMINAL_SVG}${_csEsc(label)} · ${ver}</span>
        ${p}
        <span class="g-status">已检测到</span>
        <svg class="g-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="cs-sessions-container" data-agent="${_csEsc(e.type)}">
        <div class="cs-state loading">正在读取会话历史…</div>
      </div>`);
  }
  box.innerHTML = groupsHtml.join('');

  // Wire up collapse/expand
  box.querySelectorAll('.cs-group-head').forEach((head) => {
    head.addEventListener('click', () => {
      const group = head.dataset.group;
      const container = box.querySelector(`.cs-sessions-container[data-agent="${group}"]`);
      if (container) {
        const isCollapsed = head.classList.toggle('collapsed');
        container.classList.toggle('collapsed', isCollapsed);
      }
    });
  });

  // Fetch real sessions for each detected agent.
  for (const e of available) {
    if (e.type === 'claude') {
      void _csLoadClaudeSessions(e.type);
    } else {
      // Other agents: honest "not yet implemented" state.
      const container = box.querySelector(`.cs-sessions-container[data-agent="${e.type}"]`);
      if (container) {
        const label = CS_AGENT_LABELS[e.type] || e.type;
        container.innerHTML = `<div class="cs-state">会话历史的真实读取暂未接入，此 Agent 下暂无可导入的会话。接入后，这里会列出你在 ${_csEsc(label)} 里的真实历史会话供你选择。</div>`;
      }
    }
  }

  // Load ACP transcript sessions (from ~/.cogseed/acp-transcripts/)
  void _csLoadAcpSessions();
}

// ── Step 1a: connect AI team ────────────────────────────────────────────────
// Detect importable model providers (via CC Switch aggregation), let the user
// pick which to one-click connect into the "AI team" (custom providers), then
// sync the selected keys. Keys stay local; OAuth-only sources are surfaced as
// non-migratable rather than silently dropped.
async function _csLoadTeam(force) {
  const box = document.getElementById('cs-team-list');
  if (!box) return;
  if (force) box.innerHTML = '<div class="cs-state loading">正在检测可导入的模型服务…</div>';

  // Probe first so we can give an honest "no CC Switch found" state instead of
  // an empty list that looks like a bug.
  let probe = null;
  try {
    probe = await window.orkas.invoke('customProviders.ccswitch.probe');
  } catch (err) {
    _obLog.warn('ccswitch probe failed', { error: (err && err.message) || String(err) });
  }
  if (probe && probe.available === false) {
    box.innerHTML =
      '<div class="cs-state">未检测到可自动导入的模型 Key（没有找到 CC Switch 配置）。' +
      '你仍可继续导入会话——会话提炼会用你在设置里配置的模型；也可稍后在设置的「AI 团队」里手动添加模型。</div>';
    return;
  }

  try {
    const res = await window.orkas.invoke('customProviders.ccswitch.preview');
    if (!res || res.ok !== true) {
      const reason = (res && res.reason) || 'unknown';
      box.innerHTML = `<div class="cs-state">暂时无法读取可导入的模型服务（${_csEsc(reason)}）。可稍后在设置的「AI 团队」里手动添加。</div>`;
      return;
    }
    _csRenderTeam(res.items || [], res.unsupported || []);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('ccswitch preview failed', { error: msg });
    box.innerHTML = `<div class="cs-state err">读取可导入模型服务失败：${_csEsc(msg)}。可稍后在设置里手动添加。</div>`;
  }
}

function _csRenderTeam(items, unsupported) {
  const box = document.getElementById('cs-team-list');
  if (!box) return;

  if (!items.length && !unsupported.length) {
    box.innerHTML =
      '<div class="cs-state">没有可一键导入的模型服务。可在设置的「AI 团队」里手动添加模型后再回来导入会话。</div>';
    return;
  }

  // Importable rows: pre-checked when a real key is present; rows that need a
  // key are still selectable (they get imported as needs-key placeholders the
  // user finishes in settings) but flagged honestly.
  const rows = items.map((it) => {
    const proto = it.protocol ? `<span class="cs-team-tag">${_csEsc(it.protocol)}</span>` : '';
    const keyState = it.needsKey
      ? '<span class="cs-team-tag warn">需补充 Key</span>'
      : `<span class="cs-team-tag ok">Key ${_csEsc(it.apiKeyMasked || '••••')}</span>`;
    const base = it.baseUrl ? `<small>${_csEsc(it.baseUrl)}</small>` : '';
    return `
      <div class="cs-src" data-external-id="${_csEsc(it.externalId)}">
        <input type="checkbox" ${it.needsKey ? '' : 'checked'} />
        <div class="s-ico">${CS_TERMINAL_SVG}</div>
        <div>
          <strong>${_csEsc(it.name || it.externalId)}</strong>
          ${base}
          <div class="cs-team-tags">${proto}${keyState}</div>
        </div>
      </div>`;
  }).join('');

  // Honest surfacing of what can't be migrated (OAuth-only / official logins).
  const unsupportedHtml = unsupported.length
    ? `<div class="cs-state">${unsupported.length} 个来源无法迁移 Key（如订阅/OAuth 登录）：` +
      unsupported.map((u) => _csEsc(u.name || u.externalId)).join('、') +
      '。这类需要你在设置里另行登录，无法一键导入。</div>'
    : '';

  box.innerHTML = rows +
    unsupportedHtml +
    `<div class="cs-import-bar">
       <button type="button" class="cs-import-btn" id="cs-team-connect">连接所选到 AI 团队</button>
       <div class="cs-import-result" id="cs-team-result"></div>
     </div>`;

  box.querySelectorAll('.cs-src[data-external-id]').forEach((row) => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    row.classList.toggle('selected', checkbox.checked);
    row.addEventListener('click', (ev) => {
      if (ev.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      row.classList.toggle('selected', checkbox.checked);
    });
    checkbox.addEventListener('change', () => {
      row.classList.toggle('selected', checkbox.checked);
    });
  });

  const connectBtn = box.querySelector('#cs-team-connect');
  if (connectBtn) connectBtn.addEventListener('click', () => void _csConnectTeam(box));
}

// Sync the checked providers into custom providers ("AI 团队"). Honest result:
// added / updated counts, and a clear note when some rows still need a key.
async function _csConnectTeam(box) {
  const btn = box.querySelector('#cs-team-connect');
  const resultBox = box.querySelector('#cs-team-result');
  if (!resultBox) return;

  const externalIds = [];
  let needsKeySelected = 0;
  box.querySelectorAll('.cs-src[data-external-id] input[type="checkbox"]:checked').forEach((cb) => {
    const row = cb.closest('.cs-src');
    const id = row ? row.dataset.externalId : null;
    if (id) externalIds.push(id);
    if (row && row.querySelector('.cs-team-tag.warn')) needsKeySelected += 1;
  });

  if (!externalIds.length) {
    resultBox.innerHTML = '<div class="cs-state">请先勾选要连接的模型服务。</div>';
    return;
  }

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">正在连接 ${externalIds.length} 个模型服务…</div>`;

  try {
    const res = await window.orkas.invoke('customProviders.ccswitch.sync', { externalIds });
    if (!res || res.ok !== true) {
      const reason = (res && res.reason) || '未知原因';
      resultBox.innerHTML = `<div class="cs-state err">连接失败：${_csEsc(reason)}</div>`;
      if (btn) btn.disabled = false;
      return;
    }
    const added = res.added || 0;
    const updated = res.updated || 0;
    const summary =
      `<div class="cs-state">已连接到 AI 团队：新增 ${added} 个` +
      (updated ? `，更新 ${updated} 个` : '') +
      (needsKeySelected ? `。其中 ${needsKeySelected} 个尚缺 Key，已作为占位导入，请到设置的「AI 团队」补齐后即可使用` : '') +
      '。这些模型现在可用于会话导入时的自动压缩提炼，也可在群聊里直接调用。</div>';
    resultBox.innerHTML = summary;
    _csToast(`已连接 ${added + updated} 个模型服务到 AI 团队`);
    _obLog.info('team connect finished', { added, updated, needsKeySelected });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('team connect failed', { error: msg });
    resultBox.innerHTML = `<div class="cs-state err">连接失败：${_csEsc(msg)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _csLoadAgents(force) {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;
  box.innerHTML = '<div class="cs-state loading">正在检测本机 Agent…</div>';
  try {
    const res = await window.orkas.invoke('localAgents.list', { force: !!force });
    _csRenderAgents(res && res.entries);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('onboarding agent detection failed', { error: msg });
    box.innerHTML = `<div class="cs-state err">检测本地 Agent 失败：${_csEsc(msg)}。你仍可继续，稍后可在设置中重试。</div>`;
  }
}

async function _csLoadClaudeSessions(agentType) {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;
  const container = box.querySelector(`.cs-sessions-container[data-agent="${agentType}"]`);
  if (!container) return;

  try {
    const res = await window.orkas.invoke('localAgents.listClaudeSessions');
    const sessions = (res && res.sessions) || [];

    if (!sessions.length) {
      container.innerHTML = '<div class="cs-state">未找到 Claude Code 历史会话。如果你使用过 Claude Code，会话文件可能在 ~/.claude/projects/ 目录下。</div>';
      return;
    }

    // Render sessions with checkboxes.
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

    // Import action bar: materializes each selected session into a continuable
    // conversation (compressed summary seed) and routes extracted cognitions
    // into the Recall candidate pool. This is the real "导入会话" backend.
    container.innerHTML = sessionRows +
      `<div class="cs-import-bar">
         <button type="button" class="cs-import-btn" data-agent="${_csEsc(agentType)}">导入所选会话</button>
         <div class="cs-import-result" data-agent="${_csEsc(agentType)}"></div>
       </div>`;

    // Wire up checkbox interactions.
    container.querySelectorAll('.cs-src').forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      row.addEventListener('click', (ev) => {
        if (ev.target === checkbox) return; // Let native checkbox handle it.
        checkbox.checked = !checkbox.checked;
        row.classList.toggle('selected', checkbox.checked);
      });
      checkbox.addEventListener('change', () => {
        row.classList.toggle('selected', checkbox.checked);
      });
    });

    const importBtn = container.querySelector('.cs-import-btn');
    if (importBtn) {
      importBtn.addEventListener('click', () => void _csImportSelectedSessions(container));
    }

    _obLog.info('loaded Claude sessions', { count: sessions.length });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('failed to load Claude sessions', { error: msg });
    container.innerHTML = `<div class="cs-state err">读取 Claude Code 会话失败：${_csEsc(msg)}</div>`;
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

  if (btn) btn.disabled = true;
  resultBox.innerHTML = `<div class="cs-extract-progress">正在导入 ${selected.length} 个会话…</div>`;

  let okCount = 0;
  let degradedCount = 0;
  let failCount = 0;
  let cogTotal = 0;
  const lines = [];

  for (const item of selected) {
    try {
      const res = await window.orkas.invoke('sessionImport.importClaudeSession', {
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

  if (btn) btn.disabled = false;
  _obLog.info('session import finished', { okCount, degradedCount, failCount, cogTotal });
}

async function _csLoadAcpSessions() {
  const box = document.getElementById('cs-agent-list');
  if (!box) return;

  try {
    const res = await window.orkas.invoke('localAgents.listAcpSessions');
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

async function _csExtractCognitions() {
  const btn = document.getElementById('cs-extract-start');
  const candList = document.getElementById('cs-cand-list');
  if (!candList) return;
  if (btn) btn.disabled = true;

  candList.innerHTML = '<div class="cs-extract-progress">正在分析会话并提取候选认知…</div>';

  try {
    const agentBox = document.getElementById('cs-agent-list');
    const selectedSessions = [];
    if (agentBox) {
      agentBox.querySelectorAll('.cs-src input[type="checkbox"]:checked').forEach((cb) => {
        const row = cb.closest('.cs-src');
        const sessionId = row ? row.dataset.sessionId : null;
        if (sessionId) selectedSessions.push(sessionId);
      });
    }

    if (selectedSessions.length === 0) {
      candList.innerHTML = '<div class="cs-state">请先在第二步勾选要分析的会话。</div>';
      if (btn) btn.disabled = false;
      return;
    }

    const allCandidates = [];
    const errors = [];
    const diagnostics = [];
    for (const sessionId of selectedSessions) {
      try {
        const res = await window.orkas.invoke('cognition.extractFromSession', { sessionFilePath: sessionId });
        const candidates = (res && res.candidates) || [];
        allCandidates.push(...candidates);
        if (res && res.diagnostic) diagnostics.push(res.diagnostic);
      } catch (err) {
        const msg = (err && err.message) || String(err);
        _obLog.warn('extraction failed for session', { sessionId, error: msg });
        errors.push(msg);
      }
    }

    if (allCandidates.length === 0) {
      // Honest state: a real backend failure and a genuinely empty
      // result are different outcomes. Masking every failure as
      // "nothing found" is exactly the fake status the product owner
      // forbade — surface the real error so the user knows what broke.
      if (errors.length) {
        const uniq = [...new Set(errors)];
        candList.innerHTML =
          '<div class="cs-state err">提取失败：' + _csEsc(uniq.join('；')) +
          '<br><br>常见原因：本机未检测到可用的 CLI Agent、Agent 调用超时，或模型未按要求返回可解析的结果。修复后可点「开始提取」重试。</div>';
      } else {
        // Analysis succeeded but produced no cognitions. Surface the real
        // diagnostics so a genuinely-empty result is distinguishable from
        // "the CLI returned something we couldn't turn into candidates".
        const d = diagnostics.reduce((a, x) => ({
          messageCount: a.messageCount + (x.messageCount || 0),
          rawOutputChars: a.rawOutputChars + (x.rawOutputChars || 0),
          parsedRawCount: a.parsedRawCount + (x.parsedRawCount || 0),
          rawOutputPreview: a.rawOutputPreview || x.rawOutputPreview || '',
          transcriptPreview: a.transcriptPreview || x.transcriptPreview || '',
        }), { messageCount: 0, rawOutputChars: 0, parsedRawCount: 0, rawOutputPreview: '', transcriptPreview: '' });
        const preview = d.rawOutputPreview
          ? '<br>模型返回预览：<code style="font-family:var(--cs-mono);font-size:11px;word-break:break-all">' + _csEsc(d.rawOutputPreview) + '</code>'
          : '';
        const inputPreview = d.transcriptPreview
          ? '<br>送入模型的会话预览：<code style="font-family:var(--cs-mono);font-size:11px;word-break:break-all">' + _csEsc(d.transcriptPreview) + '</code>'
          : '';
        candList.innerHTML =
          '<div class="cs-state">已分析所选会话，但未发现明确的候选认知。' +
          '<br><br>诊断：解析出会话消息 ' + d.messageCount + ' 条，模型返回 ' + d.rawOutputChars +
          ' 字符，其中数组项 ' + d.parsedRawCount + ' 个（均未通过校验或为空）。' + inputPreview + preview + '</div>';
      }
      if (btn) btn.disabled = false;
      return;
    }

    // 抽取成功后，先把候选忠实写入候选池（不确认），拿回 candidate_ids。
    // 第 4 步完成时：勾选的原样留在候选池当待确认候选，之后在 Recall 候选
    // 审核页人工确认入库；未勾选的走 reject 从池里丢弃，不带进 App。
    // 写池失败是真失败，按诚实状态直接报错，不伪装成「已提取」。
    let candidateIds = [];
    try {
      const addRes = await window.orkas.invoke('personalOntology.candidates.addFromOnboarding', {
        candidates: allCandidates,
      });
      candidateIds = (addRes && addRes.candidate_ids) || [];
    } catch (err) {
      const msg = (err && err.message) || String(err);
      _obLog.warn('failed to add onboarding candidates to pool', { error: msg });
      candList.innerHTML =
        '<div class="cs-state err">候选写入待确认池失败：' + _csEsc(msg) +
        '<br><br>已成功从会话中提取到候选，但保存到候选池这一步出错，请重试「开始提取」。</div>';
      if (btn) btn.disabled = false;
      return;
    }

    _csRenderCandidates(allCandidates, candidateIds);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    _obLog.warn('cognition extraction failed', { error: msg });
    candList.innerHTML = `<div class="cs-state err">提取候选认知失败：${_csEsc(msg)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _csRenderCandidates(candidates, candidateIds) {
  const candList = document.getElementById('cs-cand-list');
  if (!candList) return;

  // 记住本轮写入池的 id（按渲染顺序对应），第 4 步完成时按勾选确认。
  _csCandidateIds = Array.isArray(candidateIds) ? candidateIds : [];

  const typeLabels = {
    personal: '个人偏好',
    rule: '工作规则',
    skill_method: '技能方法',
    template: '模板',
  };

  const rows = candidates.map((c, idx) => {
    const typeLabel = typeLabels[c.suggestedType] || c.suggestedType;
    const summary = c.summary ? `<b>${_csEsc(c.summary)}</b>` : `<b>候选认知 ${idx + 1}</b>`;
    const uncertainty = c.uncertainty ? `<div class="cs-meta">不确定性：${_csEsc(c.uncertainty)}</div>` : '';
    const cid = _csCandidateIds[idx] || '';
    return `
      <div class="cs-cand" data-cand-idx="${idx}" data-candidate-id="${_csEsc(cid)}">
        <input type="checkbox" />
        <div class="cs-cand-body">
          <div class="cs-cand-head">
            ${summary}
            <span class="cs-type">${_csEsc(typeLabel)}</span>
          </div>
          <div class="cs-meta">${_csEsc(c.judgment)}</div>
          ${uncertainty}
          <div class="cs-src-line">范围：${_csEsc(c.suggestedScope)}</div>
        </div>
      </div>`;
  }).join('');

  candList.innerHTML = rows;

  candList.querySelectorAll('.cs-cand').forEach((row) => {
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

function _csPickRole(role) {
  const shell = document.getElementById('cs-onboarding');
  if (!shell) return;
  shell.querySelectorAll('.cs-role-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.csrole === role);
  });
  _csRolePicked = role;
  const name = role === 'product' ? '产品负责人' : 'AI 研究员';
  const result = document.getElementById('cs-role-result');
  if (result) {
    result.querySelector('h4').textContent = `角色模板已应用：「${name}」 · 不自动生成个人事实`;
    result.classList.add('show');
  }
  _csToast(`已选择「${name}」角色模板，之后可更换或叠加`);
}

async function _csFinish() {
  const btn = document.getElementById('cs-ob-finish');
  if (btn) btn.disabled = true;

  // 第 4 步落地：勾选的候选原样留在候选池里，成为「待确认候选」，之后在
  // Recall 候选审核页人工确认入库；未勾选的从候选池里丢弃（reject），不带进
  // App。两种动作都不自动落记忆——落记忆只在候选审核页确认时才发生。
  // 全部候选此前已在抽取成功时写入了池（见 _csExtractCognitions 的
  // addFromOnboarding），这里只需丢弃未勾选的、保留勾选的。
  const allRows = Array.from(document.querySelectorAll('#cs-cand-list .cs-cand'));
  const rejectIds = [];
  for (const row of allRows) {
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb && cb.checked) continue; // 勾选的留在池里，什么都不做
    const candidateId = row.getAttribute('data-candidate-id') || '';
    if (candidateId) rejectIds.push(candidateId);
  }

  let rejectedCount = 0;
  if (rejectIds.length) {
    try {
      const res = await window.orkas.invoke('personalOntology.candidates.rejectBatch', {
        candidateIds: rejectIds,
        reason: 'onboarding: 用户未勾选，丢弃',
      });
      rejectedCount =
        res && typeof res.rejectedCount === 'number' ? res.rejectedCount : rejectIds.length;
      _obLog.info('onboarding unchecked candidates discarded', { rejected: rejectedCount });
    } catch (err) {
      // 丢弃失败——诚实告知，不静默略过。未丢弃的仍留在候选池，用户可在候选
      // 审核页自行处理，不阻断收尾。
      const msg = (err && err.message) || String(err);
      _obLog.warn('failed to discard onboarding candidates', { error: msg });
      _csToast('部分候选丢弃失败（仍留在候选池，可在 Recall 候选审核页处理）');
    }
  }

  const keptCount = allRows.length - rejectIds.length;
  if (keptCount > 0) {
    _csToast('已保留 ' + keptCount + ' 条候选，可在 Recall 候选审核页确认');
    _obLog.info('onboarding candidates kept as pending', { kept: keptCount });
  }

  try {
    await window.orkas.invoke('prefs.setOnboarding', { completed: true });
    _obLog.info('onboarding completed and persisted');
  } catch (err) {
    // Persisting the marker failed — surface it rather than silently
    // trapping the user in a loop that re-fires the walkthrough next boot.
    _obLog.warn('failed to persist onboarding completion', { error: (err && err.message) || String(err) });
    _csToast('保存完成状态失败，下次启动可能再次出现引导');
  }
  document.body.classList.remove('cs-onboarding-active');
  const shell = document.getElementById('cs-onboarding');
  if (shell) shell.style.display = 'none';
}

function _csBuild() {
  if (_csObBuilt) return;
  const shell = document.createElement('div');
  shell.id = 'cs-onboarding';
  shell.innerHTML = _csObShellHtml();
  document.body.appendChild(shell);

  const toast = document.createElement('div');
  toast.id = 'cs-ob-toast';
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

  shell.querySelector('#cs-agent-refresh')?.addEventListener('click', () => _csLoadAgents(true));

  shell.querySelectorAll('.cs-role-card').forEach((c) => {
    c.addEventListener('click', () => _csPickRole(c.dataset.csrole));
  });
  shell.querySelector('#cs-role-skip')?.addEventListener('click', () => {
    _csRolePicked = null;
    _csGoStep(3);
  });

  shell.querySelector('#cs-extract-start')?.addEventListener('click', () => { void _csExtractCognitions(); });

  shell.querySelector('#cs-ob-finish')?.addEventListener('click', () => { void _csFinish(); });

  _csObBuilt = true;
}

// Called by boot.js after the last view is restored. Fire-and-forget: it must
// never block first paint. Only lifts the overlay when the machine-local
// marker says the walkthrough has not been completed here yet.
async function maybeStartOnboarding() {
  try {
    const res = await window.orkas.invoke('prefs.getOnboarding');
    if (res && res.completed === true) return;
  } catch (err) {
    // If we can't read the marker, err on the side of NOT trapping the user
    // behind a walkthrough that might loop; log and skip.
    _obLog.warn('onboarding marker read failed — skipping walkthrough', { error: (err && err.message) || String(err) });
    return;
  }
  _csBuild();
  document.body.classList.add('cs-onboarding-active');
  _csGoStep(0);
  _obLog.info('onboarding walkthrough shown (first run on this machine)');
}

// Expose for boot.js. Kept on window so classic-script load order doesn't matter.
window.csOnboarding = { maybeStart: maybeStartOnboarding };
