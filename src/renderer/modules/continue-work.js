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
  { id: 'source', n: 1, key: 'continue_work.step.source', fallback: '选择来源' },
  { id: 'sessions', n: 2, key: 'continue_work.step.sessions', fallback: '选择会话' },
  { id: 'import', n: 3, key: 'continue_work.step.import', fallback: '准备接续' },
];

let _cw = null;

function _cwEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _cwT(key, fallback, vars) {
  try {
    const value = typeof t === 'function' ? t(key, vars) : key;
    if (value && value !== key) return value;
  } catch (_) {}
  const raw = String(fallback == null ? key : fallback);
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) => (
    vars[name] != null ? String(vars[name]) : match
  ));
}

function _cwLocale() {
  return typeof getLang === 'function' && getLang() === 'en' ? 'en-US' : 'zh-CN';
}

function _cwStatusText(item) {
  if (!item) return '';
  if (item.status === 'waiting') return _cwT('continue_work.status.waiting', '等待中');
  if (item.status === 'running') return _cwT('continue_work.status.distilling', '正在提炼');
  if (item.status === 'exists') return _cwT('continue_work.status.ready_existing', '已准备 · 已存在');
  if (item.status === 'pending-extract') return _cwT('continue_work.status.ready_distilling', '已准备 · 提炼中');
  if (item.status === 'degraded') {
    return _cwT('continue_work.status.ready_not_distilled_reason', '已准备 · 未提炼：{reason}', {
      reason: _cwDegradedReason(item.degradedReasonRaw),
    });
  }
  if (item.status === 'ok') {
    return item.truncated
      ? _cwT('continue_work.status.ready_truncated', '已准备 · 对话过长已截断')
      : _cwT('continue_work.status.ready', '已准备');
  }
  if (item.status === 'fail') return _cwT('continue_work.status.failed', '失败');
  return '';
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
    sourcesStatus: 'idle',
    sessionsStatus: 'idle',
    searchQuery: '',
    importItems: [],
    backdrop: null,
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'cw-backdrop';
  backdrop.innerHTML = `
    <div class="cw-modal" role="dialog" aria-modal="true">
      <div class="cw-head">
        <span class="cw-head-icon">${_cwIcon('clock')}</span>
        <div class="cw-head-copy">
          <div class="cw-kicker" data-cw-i18n="kicker">${_cwEsc(_cwT('continue_work.kicker', '继续之前的工作'))}</div>
          <div class="cw-title" data-cw-i18n="title">${_cwEsc(_cwT('continue_work.title', '导入历史会话并接续'))}</div>
          <div class="cw-subtitle" data-cw-i18n="subtitle">${_cwEsc(_cwT('continue_work.subtitle', '从你授权的会话中准备任务摘要与接续状态，不改动原 Agent 内容。'))}</div>
        </div>
        <button type="button" class="cw-close" data-cw-close aria-label="${_cwEsc(_cwT('common.close', '关闭'))}">${_cwIcon('close')}</button>
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

  _cwRenderHeader();
  _cwGo(1);
}

function _cwRenderHeader() {
  if (!_cw || !_cw.backdrop) return;
  const values = {
    kicker: _cwT('continue_work.kicker', '继续之前的工作'),
    title: _cwT('continue_work.title', '导入历史会话并接续'),
    subtitle: _cwT('continue_work.subtitle', '从你授权的会话中准备任务摘要与接续状态，不改动原 Agent 内容。'),
  };
  _cw.backdrop.querySelectorAll('[data-cw-i18n]').forEach((el) => {
    const value = values[el.dataset.cwI18n];
    if (value != null) el.textContent = value;
  });
  const close = _cw.backdrop.querySelector('[data-cw-close]');
  if (close) close.setAttribute('aria-label', _cwT('common.close', '关闭'));
}

function _cwGo(step) {
  if (!_cw) return;
  if (step === 1 || step === 2) _cw.cancel = false;
  _cw.step = step;
  _cwRenderSteps();
  _cwRenderBody();
  _cwRenderFoot();
}

function _cwRenderSteps() {
  const host = _cw.backdrop.querySelector('[data-cw-steps]');
  if (!host) return;
  host.innerHTML = _CW_STEPS.map((s) => {
    const isActive = s.n === _cw.step;
    const isDone = s.n < _cw.step;
    const clickable = !_cw.busy && !_cw.done && (s.n === 1 || s.n === 2);
    return `
      <button type="button" class="cw-step${isActive ? ' is-active' : ''}${isDone ? ' is-done' : ''}"
        data-cw-goto="${s.n}"${clickable ? '' : ' disabled'}>
        <span class="cw-step-num">${isDone ? _cwIcon('check') : s.n}</span>
        <span class="cw-step-label">${_cwEsc(_cwT(s.key, s.fallback))}</span>
      </button>`;
  }).join('');
  host.querySelectorAll('[data-cw-goto]').forEach((el) => {
    el.addEventListener('click', () => _cwGo(Number(el.dataset.cwGoto)));
  });
}

function _cwRenderBody(options = {}) {
  const reload = options.reload !== false;
  const body = _cw.backdrop.querySelector('[data-cw-body]');
  if (!body) return;
  if (_cw.step === 1) {
    body.innerHTML = `
      <div class="cw-section-intro">
        <h3>${_cwEsc(_cwT('continue_work.source.title', '从哪个 Agent 导入历史会话？'))}</h3>
        <p>${_cwEsc(_cwT('continue_work.source.subtitle', '只读取本机可检测到的历史会话，不会写入原 Agent。'))}</p>
      </div>
      <div class="cw-source-grid" data-cw-sources>
        <div class="cw-loading">${_cwEsc(_cwT('continue_work.source.detecting', '正在检测本机 Agent…'))}</div>
      </div>`;
    if (reload || _cw.sourcesStatus === 'idle') void _cwLoadSources();
    else _cwRenderSourceGrid();
  } else if (_cw.step === 2) {
    const previousSearch = _cw.backdrop.querySelector('[data-cw-search]');
    if (previousSearch) _cw.searchQuery = previousSearch.value;
    body.innerHTML = `
      <div class="cw-section-intro">
        <div class="cw-section-intro-head">
          <h3>${_cwEsc(_cwT('continue_work.sessions.title', '选择要接续的会话'))}</h3>
          <div class="cw-privacy-note">${_cwIcon('eye')}${_cwEsc(_cwT('continue_work.sessions.index_only', '选择前只读取会话索引'))}</div>
        </div>
        <p>${_cwEsc(_cwT('continue_work.sessions.subtitle', '每个会话会生成一份任务接续摘要；原会话保持不变。'))}</p>
      </div>
      <div class="cw-source-tabs" data-cw-source-tabs></div>
      <div class="cw-session-toolbar">
        <div class="cw-search">${_cwIcon('search')}<input type="text" data-cw-search placeholder="${_cwEsc(_cwT('continue_work.sessions.search', '搜索标题、项目或 Agent'))}" /></div>
        <button type="button" class="cw-select-all" data-cw-select-all>${_cwEsc(_cwT('continue_work.sessions.select_all', '全选当前结果'))}</button>
        <span class="cw-session-count" data-cw-count></span>
      </div>
      <div class="cw-session-list" data-cw-session-list>
        <div class="cw-loading">${_cwEsc(_cwT('continue_work.sessions.loading', '正在读取会话…'))}</div>
      </div>`;
    const searchInput = body.querySelector('[data-cw-search]');
    if (searchInput) {
      searchInput.value = _cw.searchQuery || '';
      searchInput.addEventListener('input', () => {
        _cw.searchQuery = searchInput.value;
        _cwRenderSessionList();
      });
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
    if (reload || _cw.sessionsStatus === 'idle') void _cwLoadSessions();
    else if (_cw.sessionsStatus === 'ready') {
      _cwRenderSourceTabs();
      _cwRenderSessionList();
    }
  } else {
    body.innerHTML = `
      <div class="cw-section-intro">
        <h3 data-cw-import-title>${_cwEsc(_cwT('continue_work.import.title', '正在准备可接续任务'))}</h3>
        <p data-cw-import-subtitle>${_cwEsc(_cwT('continue_work.import.subtitle', '提炼目标、当前进展、已确认约束与下一步，不复制无关会话内容。'))}</p>
        <div class="cw-privacy-note" data-cw-import-privacy>${_cwIcon('lock')}${_cwEsc(_cwT('continue_work.privacy.original_unchanged', '原 Agent 内容不会被修改'))}</div>
      </div>
      <div class="cw-progress-summary">
        <div class="cw-progress-count" data-cw-progress-count>0/0</div>
        <div class="cw-progress-track"><div class="cw-progress-bar" data-cw-progress></div></div>
      </div>
      <div class="cw-import-list" data-cw-import-list></div>`;
    if (reload) void _cwRunImport();
  }
}

function _cwRenderFoot() {
  const foot = _cw.backdrop.querySelector('[data-cw-foot]');
  if (!foot) return;

  let left = '';
  let center = '';
  let right = '';

  if (_cw.step === 1) {
    left = `<button type="button" class="cw-btn ghost" data-cw-action="close">${_cwEsc(_cwT('common.cancel', '取消'))}</button>`;
    center = `<span class="cw-selection-summary">${_cwEsc(_cwT('continue_work.source.selected_count', '已选择 {count} 个来源', { count: _cw.selectedSources.size }))}</span>`;
    const canNext = _cw.selectedSources.size > 0;
    right = `<button type="button" class="cw-btn primary" data-cw-action="next"${canNext ? '' : ' disabled'}>${_cwEsc(_cwT('continue_work.next', '下一步'))}</button>`;
  } else if (_cw.step === 2) {
    left = `<button type="button" class="cw-btn ghost" data-cw-action="source">${_cwEsc(_cwT('common.back', '返回'))}</button>`;
    center = `<span class="cw-selection-summary">${_cwEsc(_cwT('continue_work.sessions.selected_count', '已选 {count} 个会话', { count: _cw.selected.size }))}</span>`;
    const startLabel = _cw.selected.size
      ? _cwT('continue_work.import.start_count', '开始准备（{count}）', { count: _cw.selected.size })
      : _cwT('continue_work.import.start', '开始准备');
    right = `<button type="button" class="cw-btn primary" data-cw-action="import"${_cw.selected.size ? '' : ' disabled'}>${_cwEsc(startLabel)}</button>`;
  } else {
    left = '';
    center = '';
    right = `<button type="button" class="cw-btn ghost" data-cw-action="close"${_cw.busy ? ' disabled' : ''}>${_cwEsc(_cw.busy ? _cwT('continue_work.import.running', '导入中…') : _cwT('common.close', '关闭'))}</button>`;
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
  if (source === 'claude-desktop') return 'Claude Desktop';
  if (source === 'codex') return 'Codex';
  if (source === 'workbuddy') return 'WorkBuddy';
  if (source === 'opencode') return 'OpenCode';
  return String(source || 'Agent');
}

/** 把后端 degraded reason 转成用户可读的原因，展示「未提炼」的具体原因。 */
function _cwDegradedReason(reason) {
  const r = String(reason || '').trim();
  if (!r) return _cwT('continue_work.degraded.model_failed', '模型提炼失败');
  const map = {
    model_unavailable: ['continue_work.degraded.model_unavailable', '未配置可用的模型，或模型调用不可用'],
    model_failed: ['continue_work.degraded.model_failed', '模型调用失败'],
    empty_transcript: ['continue_work.degraded.empty_transcript', '会话内容为空，无法提炼'],
    unparseable_json: ['continue_work.degraded.unparseable_json', '模型返回内容无法解析'],
    all_passes_failed: ['continue_work.degraded.all_passes_failed', '模型提炼失败'],
    no_model: ['continue_work.degraded.no_model', '未配置可用的模型'],
  };
  return map[r] ? _cwT(map[r][0], map[r][1]) : (r.length > 60 ? `${r.slice(0, 60)}…` : r);
}

function _cwRenderSourceGrid() {
  if (!_cw) return;
  const grid = _cw.backdrop.querySelector('[data-cw-sources]');
  if (!grid) return;
  if (_cw.sourcesStatus === 'loading' || _cw.sourcesStatus === 'idle') {
    grid.innerHTML = `<div class="cw-loading">${_cwEsc(_cwT('continue_work.source.detecting', '正在检测本机 Agent…'))}</div>`;
    return;
  }
  if (_cw.sourcesStatus === 'error') {
    grid.innerHTML = `<div class="cw-empty">${_cwEsc(_cwT('continue_work.source.detect_failed', '检测 Agent 失败，请稍后重试。'))}</div>`;
    return;
  }

  const available = _cw.sources || [];
  if (!available.length) {
    const message = _cw.desktopDenied
      ? _cwT('continue_work.source.permission_denied', '无法访问 Claude 数据目录，请检查软件权限。')
      : _cwT('continue_work.source.none_found', '未在本机找到可导入的历史会话数据。');
    grid.innerHTML = `
      <div class="cw-empty">
        <div class="cw-empty-icon">${_cwIcon('folder')}</div>
        <div>${_cwEsc(message)}</div>
        <button type="button" class="cw-btn ghost" data-cw-retry>${_cwEsc(_cwT('continue_work.source.retry', '重新检测'))}</button>
      </div>`;
    grid.querySelector('[data-cw-retry]')?.addEventListener('click', () => void _cwLoadSources());
    return;
  }

  const sourceMark = { codex: 'CX', claude: 'CC', workbuddy: 'WB', opencode: 'OC', 'claude-desktop': 'CD' };
  const sourceCard = (source) => {
    const mark = sourceMark[source.type] || '+';
    const version = source.version ? `v${source.version}` : '';
    const meta = source.type === 'claude-desktop'
      ? (source.count
        ? _cwT('continue_work.source.session_count', '{count} 个会话', { count: source.count })
        : _cwT('continue_work.source.index_only', '仅发现索引'))
      : (version || _cwT('continue_work.source.detected', '已检测'));
    const selected = _cw.selectedSources.has(source.type);
    const availability = source.type === 'claude-desktop' && !source.count
      ? `<span class="cw-status-dot is-off"></span>${_cwEsc(_cwT('continue_work.source.unavailable', '当前不可用'))}`
      : `<span class="cw-status-dot"></span>${_cwEsc(source.count
        ? _cwT('continue_work.source.available_session_count', '{count} 个可选会话', { count: source.count })
        : _cwT('continue_work.source.sessions_available', '可选会话'))}`;
    return `
      <article class="cw-source-card${selected ? ' is-selected' : ''}${source.available === false ? ' is-disabled' : ''}" data-cw-source="${_cwEsc(source.type)}">
        <span class="cw-source-check">${_cwIcon('check')}</span>
        <div class="cw-source-main">
          <span class="cw-agent-mark">${mark}</span>
          <div><h4>${_cwEsc(_cwSourceLabel(source.type))}</h4><div class="cw-source-meta">${_cwEsc(meta)}</div></div>
        </div>
        <div class="cw-source-foot">${availability}</div>
      </article>`;
  };

  grid.innerHTML = available.map(sourceCard).join('');
  grid.querySelectorAll('[data-cw-source]').forEach((el) => {
    el.addEventListener('click', () => {
      const type = el.dataset.cwSource;
      if (_cw.selectedSources.has(type)) _cw.selectedSources.delete(type);
      else _cw.selectedSources.add(type);
      grid.querySelectorAll('[data-cw-source]').forEach((card) => (
        card.classList.toggle('is-selected', _cw.selectedSources.has(card.dataset.cwSource))
      ));
      _cw.sessionsStatus = 'idle';
      _cwRenderFoot();
    });
  });
}

async function _cwLoadSources() {
  if (!_cw) return;
  const state = _cw;
  state.sourcesStatus = 'loading';
  _cwRenderSourceGrid();
  try {
    const res = await window.cogseed.invoke('localAgents.list');
    if (_cw !== state) return;
    const entries = Array.isArray(res && res.entries) ? res.entries : [];
    // 显示所有已连接/可用的 CLI Agent（Claude Code / Codex / OpenCode /
    // WorkBuddy 等）——用户连接的 agent 都应在此展示。
    const available = entries.filter((e) => e && e.available);

    // Claude Desktop is not a CLI, so it never appears in `localAgents.list`.
    // Probe it separately and offer it as a source only when it has sessions,
    // keeping a permission error distinct from "none found".
    state.desktopDenied = false;
    try {
      const dres = await window.cogseed.invoke('localAgents.listClaudeDesktopSessions');
      if (_cw !== state) return;
      if (dres && dres.error === 'permission_denied') state.desktopDenied = true;
      else if (dres && Array.isArray(dres.sessions) && dres.sessions.length) {
        available.push({ type: 'claude-desktop', count: dres.sessions.length });
      }
    } catch (err) {
      _cwLog.warn('failed to probe claude desktop sessions', err);
    }

    state.sources = available;
    state.sourcesStatus = 'ready';
    if (!state.selectedSources.size) {
      available.forEach((source) => state.selectedSources.add(source.type));
    }
    state.activeSourceTab = state.activeSourceTab || state.sources[0]?.type || '';
  } catch (err) {
    _cwLog.warn('failed to detect sources', err);
    if (_cw !== state) return;
    state.sourcesStatus = 'error';
  }
  _cwRenderSourceGrid();
  _cwRenderFoot();
}

async function _cwLoadSessions() {
  if (!_cw) return;
  const state = _cw;
  const list = _cw.backdrop.querySelector('[data-cw-session-list]');
  if (!list) return;
  state.sessionsStatus = 'loading';
  list.innerHTML = `<div class="cw-loading">${_cwEsc(_cwT('continue_work.sessions.loading', '正在读取会话…'))}</div>`;

  const wanted = [...state.selectedSources];
  const sessions = [];
  state.denied = false;
  for (const type of wanted) {
    try {
      if (type === 'claude-desktop') {
        const res = await window.cogseed.invoke('localAgents.listClaudeDesktopSessions');
        if (_cw !== state) return;
        if (res && res.error === 'permission_denied') {
          state.denied = true;
          continue;
        }
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `claude-desktop::${s.sessionId}`,
            source: 'claude-desktop',
            sessionId: s.sessionId,
            title: s.title || '',
            meta: s.projectPath || s.model || '',
            time: s.createdAt || '',
            initialMessage: s.initialMessage || '',
          });
        }
      } else if (type === 'claude') {
        const res = await window.cogseed.invoke('localAgents.listClaudeSessions');
        if (_cw !== state) return;
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `claude::${s.filePath}`,
            source: 'claude',
            filePath: s.filePath,
            title: s.firstMessage || '',
            meta: s.projectPath || '',
            time: s.timestamp || '',
          });
        }
      } else if (type === 'codex') {
        const res = await window.cogseed.invoke('sessionImport.listCodexSessions');
        if (_cw !== state) return;
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `codex::${s.filePath}`,
            source: 'codex',
            filePath: s.filePath,
            title: s.title || '',
            meta: s.cwd || '',
            time: s.createdAt || '',
          });
        }
      } else if (type === 'workbuddy') {
        const res = await window.cogseed.invoke('sessionImport.listWorkbuddySessions');
        if (_cw !== state) return;
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `workbuddy::${s.filePath}`,
            source: 'workbuddy',
            filePath: s.filePath,
            title: s.firstMessage || '',
            meta: s.projectPath || '',
            time: s.timestamp || '',
          });
        }
      } else if (type === 'opencode') {
        const res = await window.cogseed.invoke('sessionImport.listOpencodeSessions');
        if (_cw !== state) return;
        for (const s of (res && res.sessions) || []) {
          sessions.push({
            id: `opencode::${s.id}`,
            source: 'opencode',
            sessionId: s.id,
            title: s.title || '',
            // 有项目 → 显示真实项目目录；global（无项目）→ 回退模型名。
            meta: s.projectPath || (s.model && s.model.modelID) || s.projectId || '',
            time: s.timeCreated ? new Date(s.timeCreated).toISOString() : '',
          });
        }
      }
    } catch (err) {
      _cwLog.warn(`failed to list ${type} sessions`, err);
    }
  }

  if (_cw !== state) return;
  state.sessions = sessions;
  state.sessionsStatus = 'ready';
  // 会话不默认全选：保持用户之前的选择，未选过的保持未选。
  state.selected = new Set(sessions.map((s) => s.id).filter((id) => state.selected.has(id)));
  if (!state.activeSourceTab || !state.selectedSources.has(state.activeSourceTab)) {
    state.activeSourceTab = wanted[0] || '';
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
  host.innerHTML = tabHtml('all', _cwT('continue_work.sessions.all', '全部'))
    + types.map((type) => tabHtml(type, _cwSourceLabel(type))).join('');
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

  if (countEl) {
    countEl.textContent = _cwT('continue_work.sessions.selection_summary', '已选 {selected} / {total}', {
      selected: _cw.selected.size,
      total: _cw.sessions.length,
    });
  }
  if (search) {
    const allVisibleSelected = visible.length > 0 && visible.every((s) => _cw.selected.has(s.id));
    const selectAll = _cw.backdrop.querySelector('[data-cw-select-all]');
    if (selectAll) {
      selectAll.textContent = allVisibleSelected
        ? _cwT('continue_work.sessions.clear_all', '取消全选')
        : _cwT('continue_work.sessions.select_all', '全选当前结果');
    }
  }

  if (!tabSessions.length) {
    list.innerHTML = _cw.denied
      ? `<div class="cw-empty">${_cwEsc(_cwT('continue_work.source.permission_denied', '无法访问 Claude 数据目录，请检查软件权限。'))}</div>`
      : `<div class="cw-empty">${_cwEsc(_cwT('continue_work.sessions.none_for_source', '所选 Agent 没有可导入的历史会话。'))}</div>`;
    _cwRenderFoot();
    return;
  }
  if (!visible.length) {
    list.innerHTML = `<div class="cw-empty">${_cwEsc(_cwT('continue_work.sessions.no_matches', '没有匹配的会话。'))}</div>`;
    _cwRenderFoot();
    return;
  }

  const rowHtml = (s) => {
    const selected = _cw.selected.has(s.id);
    const time = s.time ? new Date(s.time).toLocaleString(_cwLocale(), {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '';
    return `
      <div class="cw-session-row${selected ? ' is-selected' : ''}" data-cw-session="${_cwEsc(s.id)}">
        <span class="cw-check">${_cwIcon('check')}</span>
        <div class="cw-session-body">
          <div class="cw-session-title">${_cwEsc(s.title || _cwT('continue_work.sessions.untitled', '未命名会话'))}</div>
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
  if (buckets.today.length) groups.push([_cwT('continue_work.sessions.today', '今天'), buckets.today]);
  if (buckets.yesterday.length) groups.push([_cwT('continue_work.sessions.yesterday', '昨天'), buckets.yesterday]);
  if (buckets.earlier.length) groups.push([_cwT('continue_work.sessions.earlier', '更早'), buckets.earlier]);
  if (!groups.length) groups.push([_cwT('continue_work.sessions.group', '会话'), visible]);

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
  const busy = cls === 'is-running' || cls === 'is-pending';
  return `
    <div class="cw-import-row ${cls}" data-cw-import-row>
      <span class="cw-import-state">${_cwIcon(busy ? 'loading' : (cls === 'is-ok' || cls === 'is-exists' ? 'check' : 'clock'))}</span>
      <div class="cw-import-copy"><b>${_cwEsc(item.title || _cwT('continue_work.sessions.untitled', '未命名会话'))}</b><small>${_cwEsc(_cwSourceLabel(item.source))} · ${_cwEsc(item.meta || '')}</small></div>
      <span class="cw-state-label">${_cwEsc(status)}</span>
    </div>`;
}

function _cwRefreshImportLabels() {
  if (!_cw || !_cw.backdrop) return;
  const title = _cw.backdrop.querySelector('[data-cw-import-title]');
  const subtitle = _cw.backdrop.querySelector('[data-cw-import-subtitle]');
  const privacy = _cw.backdrop.querySelector('[data-cw-import-privacy]');
  if (title) title.textContent = _cwT('continue_work.import.title', '正在准备可接续任务');
  if (subtitle) subtitle.textContent = _cwT('continue_work.import.subtitle', '提炼目标、当前进展、已确认约束与下一步，不复制无关会话内容。');
  if (privacy) privacy.innerHTML = `${_cwIcon('lock')}${_cwEsc(_cwT('continue_work.privacy.original_unchanged', '原 Agent 内容不会被修改'))}`;
  const rows = _cw.backdrop.querySelectorAll('[data-cw-import-row] .cw-state-label');
  rows.forEach((label, index) => {
    const item = _cw.importItems[index];
    if (item) label.textContent = _cwStatusText(item);
  });
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
  _cw.pendingExtractCount = 0;
  _cw.importItems = items;
  _cwRenderFoot();
  _cwRenderSteps();

  items.forEach((item) => { item.status = 'waiting'; });
  list.innerHTML = items.map((item) => _cwRowHtml(item, 'is-waiting', _cwStatusText(item))).join('');

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
      row.outerHTML = _cwRowHtml(item, 'is-running', _cwStatusText(item));
      row = list.querySelectorAll('[data-cw-import-row]')[i];
    }

    try {
      let res;
      if (item.source === 'claude') {
        res = await window.cogseed.invoke('sessionImport.importClaudeSession', { filePath: item.filePath });
      } else if (item.source === 'claude-desktop') {
        res = await window.cogseed.invoke('sessionImport.importClaudeDesktopSession', {
          sessionId: item.sessionId,
        });
      } else if (item.source === 'workbuddy') {
        res = await window.cogseed.invoke('sessionImport.importWorkbuddySession', {
          filePath: item.filePath,
          titleHint: item.title,
        });
      } else if (item.source === 'opencode') {
        res = await window.cogseed.invoke('sessionImport.importOpencodeSession', {
          sessionId: item.sessionId,
          titleHint: item.title,
        });
      } else {
        res = await window.cogseed.invoke('sessionImport.importCodexSession', {
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
            row.outerHTML = _cwRowHtml(item, 'is-exists', _cwStatusText(item));
            row = list.querySelectorAll('[data-cw-import-row]')[i];
          }
          doneCount += 1;
          updateProgress();
          continue;
        }
        _cw.imported.push(item);
        if (item.source === 'claude' && res.cognitions) {
          _cw.cognitions += (res.cognitions.personal || 0) + (res.cognitions.rule || 0) + (res.cognitions.template || 0) + (res.cognitions.skill_method || 0);
        }
        // B+ 快速导入：会话已立即落盘，提炼在后台进行——行直接标记
        // 「已准备 · 提炼中」，不阻塞后续导入与完成面板。
        if (res.extractionPending) {
          item.status = 'pending-extract';
          item.pendingExtract = true;
          _cw.pendingExtractCount += 1;
          if (row) {
            row.outerHTML = _cwRowHtml(item, 'is-pending', _cwStatusText(item));
            row = list.querySelectorAll('[data-cw-import-row]')[i];
          }
        } else
        // `degraded` means the distillation model call did not run (no usable
        // model provider configured, or the call failed), so the conversation
        // was seeded with the raw opening instead of a distilled brief and no
        // cognitions were extracted. Surface that honestly rather than calling
        // it "已完成", which previously masked a silent no-op.
        if (res.degraded) {
          item.status = 'degraded';
          item.degraded = true;
          item.degradedReasonRaw = res.reason;
          _cw.degradedCount += 1;
          if (row) {
            row.outerHTML = _cwRowHtml(item, 'is-degraded', _cwStatusText(item));
            row = list.querySelectorAll('[data-cw-import-row]')[i];
          }
        } else {
          item.status = 'ok';
          item.truncated = !!res.truncated;
          if (row) {
            row.outerHTML = _cwRowHtml(item, 'is-ok', _cwStatusText(item));
            row = list.querySelectorAll('[data-cw-import-row]')[i];
          }
        }
      } else {
        item.status = 'fail';
        _cw.failed.push(item);
        if (row) {
          row.outerHTML = _cwRowHtml(item, 'is-fail', _cwStatusText(item));
          row = list.querySelectorAll('[data-cw-import-row]')[i];
        }
      }
    } catch (err) {
      item.status = 'fail';
      _cw.failed.push(item);
      if (row) {
        row.outerHTML = _cwRowHtml(item, 'is-fail', _cwStatusText(item));
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
  if (!_cw || _cw.cancel) return;
  _cwRenderSteps();
  _cwRenderDone();
}

function _cwRenderDone() {
  if (!_cw || !_cw.done) return;
  const body = _cw.backdrop.querySelector('[data-cw-body]');
  if (body) {
    const okCount = _cw.imported.length;
    const newCount = _cw.imported.filter((it) => !it.existing).length;
    const existsCount = okCount - newCount;
    const summaryParts = [];
    if (newCount) summaryParts.push(_cwT('continue_work.done.new_count', '新生成 {count} 份', { count: newCount }));
    if (existsCount) summaryParts.push(_cwT('continue_work.done.existing_count', '已存在 {count} 份', { count: existsCount }));
    if (_cw.degradedCount) summaryParts.push(_cwT('continue_work.done.not_distilled_count', '未提炼 {count} 份', { count: _cw.degradedCount }));
    if (_cw.pendingExtractCount) summaryParts.push(_cwT('continue_work.done.distilling_count', '提炼中 {count} 份', { count: _cw.pendingExtractCount }));
    const summary = summaryParts.length
      ? summaryParts.join(' · ')
      : _cwT('continue_work.done.generated_count', '已生成 {count} 份可接续任务', { count: okCount });
    const pendingNote = _cw.pendingExtractCount
      ? _cwT('continue_work.done.pending_note', '提炼在后台进行，完成后会话内会自动更新携带明细。')
      : '';
    body.innerHTML = `
      <div class="cw-section-intro">
        <h3>${_cwEsc(_cwT('continue_work.done.title', '接续任务已准备好'))}</h3>
        <p>${_cwEsc(_cwT('continue_work.import.subtitle', '提炼目标、当前进展、已确认约束与下一步，不复制无关会话内容。'))}</p>
        <div class="cw-privacy-note">${_cwIcon('lock')}${_cwEsc(_cwT('continue_work.privacy.original_unchanged', '原 Agent 内容不会被修改'))}</div>
      </div>
      <div class="cw-success-panel show">${_cwIcon('check-circle')}<div><h4>${_cwEsc(summary)}</h4><p>${_cwEsc(_cwT('continue_work.done.open_hint', '打开后先查看任务摘要与准备带入的内容，再决定是否在新会话或目标 Agent 中继续。'))}${pendingNote ? ` ${_cwEsc(pendingNote)}` : ''}</p></div></div>
      ${_cw.imported.length ? `<div class="cw-done-list">${_cw.imported.map((item) => `
        <div class="cw-done-row${item.degraded ? ' is-degraded' : ''}">
          <span class="cw-done-title">${_cwEsc(item.title || _cwT('continue_work.sessions.untitled', '未命名会话'))}</span>
          ${item.existing ? `<span class="cw-done-tag is-exists">${_cwEsc(_cwT('continue_work.done.existing', '已存在'))}</span>` : ''}
          ${item.pendingExtract ? `<span class="cw-done-tag is-pending">${_cwEsc(_cwT('continue_work.done.distilling', '提炼中'))}</span>` : ''}
          ${item.degraded ? `<span class="cw-done-tag" title="${_cwEsc(_cwDegradedReason(item.degradedReasonRaw))}">${_cwEsc(_cwT('continue_work.status.not_distilled', '未提炼'))}</span>` : ''}
          ${item.degraded ? `<small class="cw-done-reason">${_cwEsc(_cwDegradedReason(item.degradedReasonRaw))}</small>` : ''}
          <button type="button" class="cw-btn small" data-cw-open-cid="${_cwEsc(item.cid)}">${_cwEsc(_cwT('common.open', '打开'))}</button>
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
    foot.innerHTML = `<div class="cw-foot-left"><span class="cw-selection-summary">${_cwEsc(_cwT('continue_work.done.no_auto_start', '准备完成，不会自动启动外部 Agent'))}</span></div><div class="cw-foot-right"><button type="button" class="cw-btn primary" data-cw-action="done">${_cwEsc(_cwT('continue_work.done.action', '完成'))}</button></div>`;
    foot.querySelector('[data-cw-action="done"]').addEventListener('click', () => {
      const latest = _cw.imported.length ? _cw.imported[_cw.imported.length - 1] : null;
      const cid = latest && latest.cid;
      _cwClose();
      if (cid) _cwOpenConversation(cid);
    });
  }
}

function _cwHandleI18nChange() {
  if (!_cw || !_cw.backdrop || !_cw.backdrop.isConnected) return;
  _cwRenderHeader();
  _cwRenderSteps();
  if (_cw.done) {
    _cwRenderDone();
    return;
  }
  if (_cw.step === 3 && _cw.busy) {
    _cwRefreshImportLabels();
    _cwRenderFoot();
    return;
  }
  _cwRenderBody({ reload: false });
  _cwRenderFoot();
}

window.addEventListener('i18n-change', _cwHandleI18nChange);

window.continueWork = { open };
