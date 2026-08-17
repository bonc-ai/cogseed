// ─── Continue previous work · session import wizard ─────────────────────
//
// Standalone flow behind the "继续之前的工作" chip on the new-task page.
// Unlike onboarding's full walkthrough, this is a compact 4-step modal:
//   1. choose source agent  2. choose sessions  3. import  4. done
// Backend is shared with onboarding (`localAgents.list*Sessions` /
// `sessionImport.import*Session`); only the frontend shell is distinct.

const _cwLog = typeof createLogger === 'function'
  ? createLogger('continue-work')
  : { info() {}, warn() {}, error() {} };

const _CW_STEPS = [
  { id: 'source', n: 1, label: '选择来源' },
  { id: 'sessions', n: 2, label: '选择会话' },
  { id: 'import', n: 3, label: '准备接续' },
];

let _cw = null;

function _cwEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _cwIcon(name) {
  const paths = {
    close: '<path d="M12 4 4 12M4 4l8 8"/>',
    play: '<path d="M6 4v16l14-8z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    check: '<path d="m5 12 5 5 9-11"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3M20 4v7h-7"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    lock: '<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
    loading: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function _cwKeydown(e) {
  if (e.key === 'Escape' && _cw && _cw.backdrop && _cw.backdrop.isConnected) {
    _cwClose();
  }
}

function _cwClose() {
  if (!_cw) return;
  _cw.cancel = true;
  if (_cw.backdrop && _cw.backdrop.isConnected) _cw.backdrop.remove();
  document.removeEventListener('keydown', _cwKeydown);
  _cw = null;
}

function _cwOpenConversation(cid) {
  const target = String(cid || '');
  _cwClose();
  if (target && typeof setView === 'function') {
    setView('conversation', target);
  }
}

async function _cwRefreshConversationList() {
  try {
    if (typeof window._markConversationListLocallyChanged === 'function') {
      window._markConversationListLocallyChanged();
    }
    if (typeof loadConversations === 'function') {
      await loadConversations();
      await loadConversations();
    }
  } catch (err) {
    _cwLog.warn('failed to refresh conversations', err);
  }
}

function open() {
  if (_cw) _cwClose();

  const state = {
    step: 1,
    sources: [],
    selectedSources: new Set(),
    sessions: [],
    selected: new Set(),
    activeSourceTab: '',
    imported: [],
    failed: [],
    cognitions: 0,
    degradedCount: 0,
    busy: false,
    cancel: false,
    done: false,
    backdrop: null,
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'cw-backdrop';
  backdrop.innerHTML = `
    <div class="cw-modal" role="dialog" aria-modal="true">
      <div class="cw-head">
        <span class="cw-head-icon">${_cwIcon('clock')}</span>
        <div class="cw-head-copy">
          <div class="cw-kicker">继续之前的工作</div>
          <div class="cw-title">导入历史会话并接续</div>
          <div class="cw-subtitle">从你授权的会话中准备任务摘要与接续状态，不改动原 Agent 内容。</div>
        </div>
        <button type="button" class="cw-close" data-cw-close aria-label="关闭">${_cwIcon('close')}</button>
      </div>
      <div class="cw-steps" data-cw-steps></div>
      <div class="cw-body" data-cw-body></div>
      <div class="cw-foot" data-cw-foot></div>
    </div>`;
  document.body.appendChild(backdrop);
  state.backdrop = backdrop;
  _cw = state;

  backdrop.querySelectorAll('[data-cw-close]').forEach((el) => el.addEventListener('click', _cwClose));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) _cwClose();
  });
  document.addEventListener('keydown', _cwKeydown);

  _cwGo(1);
}

function _cwGo(step) {
  if (!_cw) return;
  if (step === 1 || step === 2) _cw.cancel = false;
  _cw.step = step;
  _cwRenderSteps();
  _cwRenderBody();
  _cwRenderFoot();
}function _cwRenderSteps() {
  const host = _cw.backdrop.querySelector('[data-cw-steps]');
  if (!host) return;
  host.innerHTML = _CW_STEPS.map((s) => {
    const isActive = s.n === _cw.step;
    const isDone = s.n < _cw.step;
    const clickable = s.n === 1 || s.n === 2;
    return `
      <button type="button" class="cw-step${isActive ? ' is-active' : ''}${isDone ? ' is-done' : ''}"
        data-cw-goto="${s.n}"${clickable ? '' : ' disabled'}>
        <span class="cw-step-num">${isDone ? _cwIcon('check') : s.n}</span>
        <span class="cw-step-label">${_cwEsc(s.label)}</span>
      </button>`;
  }).join('');
  host.querySelectorAll('[data-cw-goto]').forEach((el) => {
    el.addEventListener('click', () => _cwGo(Number(el.dataset.cwGoto)));
  });
}

function _cwRenderBody() {
  const body = _cw.backdrop.querySelector('[data-cw-body]');
  if (!body) return;
  if (_cw.step === 1) {
    body.innerHTML = `
      <div class="cw-section-intro">
        <h3>从哪个 Agent 导入历史会话？</h3>
        <p>只读取本机可检测到的 Claude Code / Codex 会话，不会写入原 Agent。</p>
      </div>
      <div class="cw-source-grid" data-cw-sources>
        <div class="cw-loading">正在检测本机 Agent…</div>
      </div>`;
    void _cwLoadSources();
  } else if (_cw.step === 2) {
    body.innerHTML = `
      <div class="cw-section-intro">
        <h3>选择要接续的会话</h3>
        <p>每个会话会生成一份任务接续摘要；原会话保持不变。</p>
        <div class="cw-privacy-note">${_cwIcon('eye')}选择前只读取会话索引</div>
      </div>
      <div class="cw-source-tabs" data-cw-source-tabs></div>
      <div class="cw-session-toolbar">
        <div class="cw-search">${_cwIcon('search')}<input type="text" data-cw-search placeholder="搜索标题、项目或 Agent" /></div>
        <button type="button" class="cw-select-all" data-cw-select-all>全选当前结果</button>
        <span class="cw-session-count" data-cw-count></span>
      </div>
      <div class="cw-session-list" data-cw-session-list>
        <div class="cw-loading">正在读取会话…</div>
      </div>`;
    const searchInput = body.querySelector('[data-cw-search]');
    if (searchInput) {
      searchInput.addEventListener('input', () => _cwRenderSessionList());
    }
    const selectAll = body.querySelector('[data-cw-select-all]');
    if (selectAll) {
      selectAll.addEventListener('click', () => {
        const search = _cw.backdrop.querySelector('[data-cw-search]');
        const q = String(search && search.value || '').trim().toLowerCase();
        const tabSessions = _cw.activeSourceTab === 'all'
          ? _cw.sessions.filter((s) => _cw.selectedSources.has(s.source))
          : _cw.sessions.filter((s) => s.source === _cw.activeSourceTab);
        const visible = tabSessions.filter((s) => (
          !q || `${s.title} ${s.meta} ${s.source}`.toLowerCase().includes(q)
        ));
        const allSelected = visible.length > 0 && visible.every((s) => _cw.selected.has(s.id));
        for (const s of visible) {
          if (allSelected) _cw.selected.delete(s.id);
          else _cw.selected.add(s.id);
        }
        _cwRenderSessionList();
      });
    }
    void _cwLoadSessions();
  } else {
    body.innerHTML = `
      <div class="cw-section-intro">
        <h3>正在准备可接续任务</h3>
        <p>提炼目标、当前进展、已确认约束与下一步，不复制无关会话内容。</p>
        <div class="cw-privacy-note">${_cwIcon('lock')}原 Agent 内容不会被修改</div>
      </div>
      <div class="cw-progress-summary">
        <div class="cw-progress-count" data-cw-progress-count>0/0</div>
        <div class="cw-progress-track"><div class="cw-progress-bar" data-cw-progress></div></div>
      </div>
      <div class="cw-import-list" data-cw-import-list></div>`;
    void _cwRunImport();
  }
}

function _cwRenderFoot() {
  const foot = _cw.backdrop.querySelector('[data-cw-foot]');
  if (!foot) return;

  let left = '';
  let center = '';
  let right = '';

  if (_cw.step === 1) {
    left = '<button type="button" class="cw-btn ghost" data-cw-action="close">取消</button>';
    center = `<span class="cw-selection-summary">已选择 <strong>${_cw.selectedSources.size}</strong> 个来源</span>`;
    const canNext = _cw.selectedSources.size > 0;
    right = `<button type="button" class="cw-btn primary" data-cw-action="next"${canNext ? '' : ' disabled'}>下一步</button>`;
  } else if (_cw.step === 2) {
    left = '<button type="button" class="cw-btn ghost" data-cw-action="source">返回</button>';
    center = `<span class="cw-selection-summary">已选 <strong>${_cw.selected.size}</strong> 个会话</span>`;
    right = `<button type="button" class="cw-btn primary" data-cw-action="import"${_cw.selected.size ? '' : ' disabled'}>开始准备${_cw.selected.size ? `（${_cw.selected.size}）` : ''}</button>`;
  } else {
    left = '';
    center = '';
    right = `<button type="button" class="cw-btn ghost" data-cw-action="close"${_cw.busy ? ' disabled' : ''}>${_cw.busy ? '导入中…' : '关闭'}</button>`;
  }

  foot.innerHTML = `<div class="cw-foot-left">${left}</div><div class="cw-foot-center">${center}</div><div class="cw-foot-right">${right}</div>`;
  foot.querySelectorAll('[data-cw-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.cwAction;
      if (action === 'close') _cwClose();
      else if (action === 'next') _cwGo(2);
      else if (action === 'source') _cwGo(1);
      else if (action === 'import') _cwGo(3);
    });
  });
}

/** Short label for a session source, used in lists and import rows. */
function _cwSourceLabel(source) {
  if (source === 'claude') return 'Claude Code';
  if (source === 'claude-desktop') return 'Claude 桌面版';
  if (source === 'codex') return 'Codex';
  if (source === 'workbuddy') return 'WorkBuddy';
  if (source === 'opencode') return 'OpenCode';
  return String(source || 'Agent');
}

async function _cwLoadSources() {
  const grid = _cw.backdrop.querySelector('[data-cw-sources]');
  if (!grid) return;
  try {
    const res = await window.orkas.invoke('localAgents.list');
    const entries = Array.isArray(res && res.entries) ? res.entries : [];
    // 显示所有已连接/可用的 CLI Agent（Claude Code / Codex / OpenCode /
    // WorkBuddy 等）——用户连接的 agent 都应在此展示。
    const available = entries.filter((e) => e && e.available);

    // Claude Desktop is not a CLI, so it never appears in `localAgents.list`.
    // Probe it separately and offer it as a source only when it has sessions,
    // keeping a permission error distinct from "none found".
    _cw.desktopDenied = false;
    try {
      const dres = await window.orkas.invoke('localAgents.listClaudeDesktopSessions');
      if (dres && dres.error === 'permission_denied') _cw.desktopDenied = true;
      else if (dres && Array.isArray(dres.sessions) && dres.sessions.length) {
        available.push({ type: 'claude-desktop', count: dres.sessions.length });
      }
    } catch (err) {
      _cwLog.warn('failed to probe claude desktop sessions', err);
    }

    _cw.sources = available;

    if (!available.length) {
      const denied = _cw.desktopDenied;
      grid.innerHTML = `
        <div class="cw-empty">
          <div class="cw-empty-icon">${_cwIcon('folder')}</div>
          <div>${denied
            ? '无法访问 Claude 数据目录，请检查软件权限。'
            : '未在本机找到 Claude Code / Codex / Claude 桌面版会话数据。'}</div>
          <button type="button" class="cw-btn ghost" data-cw-retry>重新检测</button>
        </div>`;
      grid.querySelector('[data-cw-retry]')?.addEventListener('click', () => {
        grid.innerHTML = '<div class="cw-loading">正在检测本机 Agent…</div>';
        void _cwLoadSources();
      });
      _cwRenderFoot();
      return;
    }

    // 来源缩写圆标（原型语言：CX / CC / WB / OC / CD / +）
    const SOURCE_MARK = { codex: 'CX', claude: 'CC', workbuddy: 'WB', opencode: 'OC', 'claude-desktop': 'CD' };
    const sourceCard = (a) => {
      const mark = SOURCE_MARK[a.type] || '+';
      const version = a.version ? `v${_cwEsc(a.version)}` : '';
      const meta = a.type === 'claude-desktop'
        ? (a.count ? `${a.count} 个会话` : '仅发现索引')
        : (version || '已检测');
      const selected = _cw.selectedSources.has(a.type);
      const foot = a.type === 'claude-desktop'
        ? (a.count ? `<span class="cw-status-dot"></span>${a.count} 个可选会话` : `<span class="cw-status-dot is-off"></span>当前不可用`)
        : '<span class="cw-status-dot"></span>可选会话';
      return `
        <article class="cw-source-card${selected ? ' is-selected' : ''}${a.available === false ? ' is-disabled' : ''}" data-cw-source="${_cwEsc(a.type)}">
          <span class="cw-source-check">${_cwIcon('check')}</span>
          <div class="cw-source-main">
            <span class="cw-agent-mark">${mark}</span>
            <div><h4>${_cwEsc(_cwSourceLabel(a.type))}</h4><div class="cw-source-meta">${meta}</div></div>
          </div>
          <div class="cw-source-foot">${foot}</div>
        </article>`;
    };

    // 默认全选所有已连接的 Agent，用户可手动取消。
    if (!_cw.selectedSources.size) {
      available.forEach((a) => _cw.selectedSources.add(a.type));
    }
    _cw.activeSourceTab = _cw.activeSourceTab || _cw.sources[0]?.type || '';

    grid.innerHTML = available.map(sourceCard).join('');
    grid.querySelectorAll('[data-cw-source]').forEach((el) => {
      el.addEventListener('click', () => {
        const type = el.dataset.cwSource;
        if (_cw.selectedSources.has(type)) _cw.selectedSources.delete(type);
        else _cw.selectedSources.add(type);
        grid.querySelectorAll('[data-cw-source]').forEach((x) => (
          x.classList.toggle('is-selected', _cw.selectedSources.has(x.dataset.cwSource))
        ));
        _cwRenderFoot();
      });
    });
  } catch (err) {
    _cwLog.warn('failed to detect sources', err);
    grid.innerHTML = `<div class="cw-empty">检测 Agent 失败，请稍后重试。</div>`;
  }
  _cwRenderFoot();
}

async function _cwLoadSessions() {
  const list = _cw.backdrop.querySelector('[data-cw-session-list]');
  if (!list) return;
  list.innerHTML = '<div class="cw-loading">正在读取会话…</div>';

  const wanted = [..._cw.selectedSources];
  const sessions = [];
  _cw.denied = false;
  for (const type of wanted) {
    try {
      if (type === 'claude-desktop') {
        const res = await window.orkas.invoke('localAgents.listClaudeDesktopSessions');
        if (res && res.error === 'permission_denied') {
          _cw.denied = true;
          continue;
        }
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `claude-desktop::${s.sessionId}`,
            source: 'claude-desktop',
            sessionId: s.sessionId,
            title: s.title || '未命名会话',
            meta: s.projectPath || s.model || '',
            time: s.createdAt || '',
            initialMessage: s.initialMessage || '',
          });
        }
      } else if (type === 'claude') {
        const res = await window.orkas.invoke('localAgents.listClaudeSessions');
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `claude::${s.filePath}`,
            source: 'claude',
            filePath: s.filePath,
            title: s.firstMessage || '未命名会话',
            meta: s.projectPath || '',
            time: s.timestamp || '',
          });
        }
      } else if (type === 'codex') {
        const res = await window.orkas.invoke('sessionImport.listCodexSessions');
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `codex::${s.filePath}`,
            source: 'codex',
            filePath: s.filePath,
            title: s.title || '未命名会话',
            meta: s.cwd || '',
            time: s.createdAt || '',
          });
        }
      } else if (type === 'workbuddy') {
        const res = await window.orkas.invoke('sessionImport.listWorkbuddySessions');
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `workbuddy::${s.filePath}`,
            source: 'workbuddy',
            filePath: s.filePath,
            title: s.firstMessage || '未命名会话',
            meta: s.projectPath || '',
            time: s.timestamp || '',
          });
        }
      } else if (type === 'opencode') {
        const res = await window.orkas.invoke('sessionImport.listOpencodeSessions');
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `opencode::${s.id}`,
            source: 'opencode',
            sessionId: s.id,
            title: s.title || '未命名会话',
            meta: s.model && s.model.modelID ? s.model.modelID : (s.projectId || ''),
            time: s.timeCreated ? new Date(s.timeCreated).toISOString() : '',
          });
        }
      }
    } catch (err) {
      _cwLog.warn(`failed to list ${type} sessions`, err);
    }
  }

  _cw.sessions = sessions;
  // 会话不默认全选：保持用户之前的选择，未选过的保持未选。
  _cw.selected = new Set(sessions.map((s) => s.id).filter((id) => _cw.selected.has(id)));
  if (!_cw.activeSourceTab || !_cw.selectedSources.has(_cw.activeSourceTab)) {
    _cw.activeSourceTab = wanted[0] || '';
  }
  _cwRenderSourceTabs();
  _cwRenderSessionList();
}

/** 第二步：按已选 Agent 渲染会话 tab 栏（含「全部」）。 */
function _cwRenderSourceTabs() {
  const host = _cw.backdrop.querySelector('[data-cw-source-tabs]');
  if (!host) return;
  const types = [..._cw.selectedSources];
  if (!types.length) {
    host.innerHTML = '';
    return;
  }
  const tabHtml = (type, label) => `
    <button type="button" class="cw-source-tab${type === _cw.activeSourceTab ? ' is-active' : ''}"
      data-cw-source-tab="${_cwEsc(type)}">
      ${_cwEsc(label)}
      <span class="cw-source-tab-count" data-cw-tab-count="${_cwEsc(type)}"></span>
    </button>`;
  host.innerHTML = tabHtml('all', '全部') + types.map((type) => tabHtml(type, _cwSourceLabel(type))).join('');
  host.querySelectorAll('[data-cw-source-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      _cw.activeSourceTab = el.dataset.cwSourceTab;
      _cwRenderSourceTabs();
      _cwRenderSessionList();
    });
  });
  // 每个 tab 显示对应会话数（「全部」= 所有已选来源）。
  const countFor = (type) => type === 'all'
    ? _cw.sessions.filter((s) => _cw.selectedSources.has(s.source)).length
    : _cw.sessions.filter((s) => s.source === type).length;
  host.querySelectorAll('[data-cw-tab-count]').forEach((el) => {
    el.textContent = countFor(el.dataset.cwTabCount);
  });
}

function _cwRenderSessionList() {
  const list = _cw.backdrop.querySelector('[data-cw-session-list]');
  const search = _cw.backdrop.querySelector('[data-cw-search]');
  const countEl = _cw.backdrop.querySelector('[data-cw-count]');
  if (!list) return;

  const q = String(search && search.value || '').trim().toLowerCase();
  // 「全部」tab 显示所有已选来源的会话；否则只显示当前 Agent tab。
  const tabSessions = _cw.activeSourceTab === 'all'
    ? _cw.sessions.filter((s) => _cw.selectedSources.has(s.source))
    : _cw.sessions.filter((s) => s.source === _cw.activeSourceTab);
  const visible = tabSessions.filter((s) => (
    !q || `${s.title} ${s.meta} ${s.source}`.toLowerCase().includes(q)
  ));

  if (countEl) countEl.textContent = `已选 ${_cw.selected.size} / ${_cw.sessions.length}`;
  if (search) {
    const allVisibleSelected = visible.length > 0 && visible.every((s) => _cw.selected.has(s.id));
    const selectAll = _cw.backdrop.querySelector('[data-cw-select-all]');
    if (selectAll) selectAll.textContent = allVisibleSelected ? '取消全选' : '全选当前结果';
  }

  if (!tabSessions.length) {
    list.innerHTML = _cw.denied
      ? '<div class="cw-empty">无法访问 Claude 数据目录，请检查软件权限。</div>'
      : '<div class="cw-empty">所选 Agent 没有可导入的历史会话。</div>';
    _cwRenderFoot();
    return;
  }
  if (!visible.length) {
    list.innerHTML = '<div class="cw-empty">没有匹配的会话。</div>';
    _cwRenderFoot();
    return;
  }

  const rowHtml = (s) => {
    const selected = _cw.selected.has(s.id);
    const time = s.time ? new Date(s.time).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '';
    return `
      <div class="cw-session-row${selected ? ' is-selected' : ''}" data-cw-session="${_cwEsc(s.id)}">
        <span class="cw-check">${_cwIcon('check')}</span>
        <div class="cw-session-body">
          <div class="cw-session-title">${_cwEsc(s.title)}</div>
          <div class="cw-session-meta">${_cwEsc(s.meta || '')}</div>
        </div>
        <span class="cw-source-pill">${_cwEsc(_cwSourceLabel(s.source))}</span>
        <span class="cw-session-time">${time}</span>
      </div>`;
  };

  // 按天分组（今天 / 昨天 / 更早）。
  const groups = [];
  const now = new Date();
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const todayKey = dayKey(now);
  const yKey = dayKey(new Date(now.getTime() - 86400000));
  const buckets = { today: [], yesterday: [], earlier: [] };
  for (const s of visible) {
    const d = s.time ? new Date(s.time) : null;
    const key = d && !Number.isNaN(d.getTime()) ? dayKey(d) : '';
    if (key === todayKey) buckets.today.push(s);
    else if (key === yKey) buckets.yesterday.push(s);
    else buckets.earlier.push(s);
  }
  if (buckets.today.length) groups.push(['今天', buckets.today]);
  if (buckets.yesterday.length) groups.push(['昨天', buckets.yesterday]);
  if (buckets.earlier.length) groups.push(['更早', buckets.earlier]);
  if (!groups.length) groups.push(['会话', visible]);

  list.innerHTML = groups.map(([label, items]) => `
    <section class="cw-session-group">
      <div class="cw-group-label">${_cwEsc(label)}</div>
      <div class="cw-session-list-inner">${items.map(rowHtml).join('')}</div>
    </section>`).join('');

  list.querySelectorAll('[data-cw-session]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.cwSession;
      if (_cw.selected.has(id)) _cw.selected.delete(id);
      else _cw.selected.add(id);
      _cwRenderSessionList();
    });
  });
  _cwRenderFoot();
}

function _cwRowHtml(item, cls, status) {
  return `
    <div class="cw-import-row ${cls}" data-cw-import-row>
      <span class="cw-import-state">${_cwIcon(cls === 'is-running' ? 'loading' : (cls === 'is-ok' || cls === 'is-exists' ? 'check' : 'clock'))}</span>
      <div class="cw-import-copy"><b>${_cwEsc(item.title)}</b><small>${_cwEsc(_cwSourceLabel(item.source))} · ${_cwEsc(item.meta || '')}</small></div>
      <span class="cw-state-label">${status}</span>
    </div>`;
}

async function _cwRunImport() {
  if (!_cw) return;
  const items = _cw.sessions.filter((s) => _cw.selected.has(s.id));
  const list = _cw.backdrop.querySelector('[data-cw-import-list]');
  const progress = _cw.backdrop.querySelector('[data-cw-progress]');
  const progressCount = _cw.backdrop.querySelector('[data-cw-progress-count]');
  if (!list) return;

  _cw.busy = true;
  _cw.imported = [];
  _cw.failed = [];
  _cw.cognitions = 0;
  _cw.degradedCount = 0;
  _cwRenderFoot();

  items.forEach((item) => { item.status = 'waiting'; });
  list.innerHTML = items.map((item) => _cwRowHtml(item, 'is-waiting', '等待中')).join('');

  let doneCount = 0;
  const updateProgress = () => {
    if (progress) progress.style.width = `${items.length ? Math.round((doneCount / items.length) * 100) : 0}%`;
    if (progressCount) progressCount.textContent = `${doneCount}/${items.length}`;
  };
  updateProgress();

  for (let i = 0; i < items.length; i += 1) {
    if (!_cw || _cw.cancel) break;
    const item = items[i];
    let row = list.querySelectorAll('[data-cw-import-row]')[i];
    item.status = 'running';
    if (row) {
      row.outerHTML = _cwRowHtml(item, 'is-running', '正在提炼');
      row = list.querySelectorAll('[data-cw-import-row]')[i];
    }

    try {
      let res;
      if (item.source === 'claude') {
        res = await window.orkas.invoke('sessionImport.importClaudeSession', { filePath: item.filePath });
      } else if (item.source === 'claude-desktop') {
        res = await window.orkas.invoke('sessionImport.importClaudeDesktopSession', {
          sessionId: item.sessionId,
        });
      } else if (item.source === 'workbuddy') {
        res = await window.orkas.invoke('sessionImport.importWorkbuddySession', {
          filePath: item.filePath,
          titleHint: item.title,
        });
      } else if (item.source === 'opencode') {
        res = await window.orkas.invoke('sessionImport.importOpencodeSession', {
          sessionId: item.sessionId,
          titleHint: item.title,
        });
      } else {
        res = await window.orkas.invoke('sessionImport.importCodexSession', {
          filePath: item.filePath,
          titleHint: item.title,
        });
      }
      if (res && res.conversationId) {
        item.cid = res.conversationId;
        // 已导入过的会话：后端跳过重新提炼，标记为已存在，但仍计入本次
        // 结果列表（成功面板展示），避免「导入了却显示 0 份」的误导。
        if (res.alreadyImported) {
          item.status = 'exists';
          item.existing = true;
          _cw.imported.push(item);
          if (row) {
            row.outerHTML = _cwRowHtml(item, 'is-exists', '已准备 · 已存在');
            row = list.querySelectorAll('[data-cw-import-row]')[i];
          }
          doneCount += 1;
          updateProgress();
          continue;
        }
        _cw.imported.push(item);
        if (item.source === 'claude' && res.cognitions) {
          _cw.cognitions += (res.cognitions.personal || 0) + (res.cognitions.rule || 0) + (res.cognitions.template || 0);
        }
        // `degraded` means the distillation model call did not run (no usable
        // model provider configured, or the call failed), so the conversation
        // was seeded with the raw opening instead of a distilled brief and no
        // cognitions were extracted. Surface that honestly rather than calling
        // it "已完成", which previously masked a silent no-op.
        if (res.degraded) {
          item.status = 'degraded';
          item.degraded = true;
          _cw.degradedCount += 1;
          if (row) {
            row.outerHTML = _cwRowHtml(item, 'is-degraded', '已准备 · 未提炼');
            row = list.querySelectorAll('[data-cw-import-row]')[i];
          }
        } else {
          item.status = 'ok';
          if (row) {
            row.outerHTML = _cwRowHtml(item, 'is-ok', res.truncated ? '已准备 · 对话过长已截断' : '已准备');
            row = list.querySelectorAll('[data-cw-import-row]')[i];
          }
        }
      } else {
        item.status = 'fail';
        _cw.failed.push(item);
        if (row) {
          row.outerHTML = _cwRowHtml(item, 'is-fail', '失败');
          row = list.querySelectorAll('[data-cw-import-row]')[i];
        }
      }
    } catch (err) {
      item.status = 'fail';
      _cw.failed.push(item);
      if (row) {
        row.outerHTML = _cwRowHtml(item, 'is-fail', '失败');
        row = list.querySelectorAll('[data-cw-import-row]')[i];
      }
    }
    doneCount += 1;
    updateProgress();
  }

  if (!_cw || _cw.cancel) return;
  _cw.busy = false;
  _cw.done = true;
  await _cwRefreshConversationList();
  // 完成：显示 success 面板 + 「完成」按钮（不自动关闭），点击后打开最近导入的会话。
  const body = _cw.backdrop.querySelector('[data-cw-body]');
  if (body) {
    const okCount = _cw.imported.length;
    const newCount = _cw.imported.filter((it) => !it.existing).length;
    const existsCount = okCount - newCount;
    const summaryParts = [];
    if (newCount) summaryParts.push(`新生成 ${newCount} 份`);
    if (existsCount) summaryParts.push(`已存在 ${existsCount} 份`);
    if (_cw.degradedCount) summaryParts.push(`未提炼 ${_cw.degradedCount} 份`);
    body.innerHTML = `
      <div class="cw-section-intro">
        <h3>接续任务已准备好</h3>
        <p>提炼目标、当前进展、已确认约束与下一步，不复制无关会话内容。</p>
        <div class="cw-privacy-note">${_cwIcon('lock')}原 Agent 内容不会被修改</div>
      </div>
      <div class="cw-success-panel show">${_cwIcon('check-circle')}<div><h4>${summaryParts.length ? summaryParts.join(' · ') : `已生成 ${okCount} 份可接续任务`}</h4><p>打开后先查看任务摘要与准备带入的内容，再决定是否在新会话或目标 Agent 中继续。</p></div></div>
      ${_cw.imported.length ? `<div class="cw-done-list">${_cw.imported.map((item) => `
        <div class="cw-done-row${item.degraded ? ' is-degraded' : ''}">
          <span class="cw-done-title">${_cwEsc(item.title)}</span>
          ${item.existing ? '<span class="cw-done-tag is-exists">已存在</span>' : ''}
          ${item.degraded ? '<span class="cw-done-tag">未提炼</span>' : ''}
          <button type="button" class="cw-btn small" data-cw-open-cid="${_cwEsc(item.cid)}">打开</button>
        </div>`).join('')}</div>` : ''}`;
    body.querySelectorAll('[data-cw-open-cid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.cwOpenCid;
        if (!cid) return;
        _cwClose();
        _cwOpenConversation(cid);
      });
    });
  }
  const foot = _cw.backdrop.querySelector('[data-cw-foot]');
  if (foot) {
    foot.innerHTML = `<div class="cw-foot-left"><span class="cw-selection-summary">准备完成，不会自动启动外部 Agent</span></div><div class="cw-foot-right"><button type="button" class="cw-btn primary" data-cw-action="done">完成</button></div>`;
    foot.querySelector('[data-cw-action="done"]').addEventListener('click', () => {
      const latest = _cw.imported.length ? _cw.imported[_cw.imported.length - 1] : null;
      const cid = latest && latest.cid;
      _cwClose();
      if (cid) _cwOpenConversation(cid);
    });
  }
}

window.continueWork = { open };
