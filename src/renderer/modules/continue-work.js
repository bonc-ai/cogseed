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
  { id: 'import', n: 3, label: '导入' },
  { id: 'done', n: 4, label: '完成' },
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
    source: '',
    sessions: [],
    selected: new Set(),
    imported: [],
    failed: [],
    cognitions: 0,
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
          <div class="cw-title">导入历史会话并续接</div>
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
}

function _cwRenderSteps() {
  const host = _cw.backdrop.querySelector('[data-cw-steps]');
  if (!host) return;
  host.innerHTML = _CW_STEPS.map((s) => {
    const isActive = s.n === _cw.step;
    const isDone = s.n < _cw.step || (_cw.done && s.n === 4);
    const clickable = s.n === 1 || s.n === 2 || (s.n === 4 && _cw.done);
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
        <h3>勾选要继续的会话</h3>
        <p>导入后会生成新的可继续对话，重复导入同一会话不会产生副本。</p>
      </div>
      <div class="cw-session-toolbar">
        <div class="cw-search">${_cwIcon('search')}<input type="text" data-cw-search placeholder="搜索标题、路径或来源" /></div>
        <button type="button" class="cw-select-all" data-cw-select-all>全选</button>
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
        const visible = _cw.sessions.filter((s) => (
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
  } else if (_cw.step === 3) {
    body.innerHTML = `
      <div class="cw-import-head">
        <h3>正在导入</h3>
        <p>每个会话会被提炼成一段可续接的简报，导入完成后会自动刷新左侧列表。</p>
      </div>
      <div class="cw-progress-track"><div class="cw-progress-bar" data-cw-progress></div></div>
      <div class="cw-import-list" data-cw-import-list></div>`;
    void _cwRunImport();
  } else {
    _cwRenderDone();
  }
}

function _cwRenderFoot() {
  const foot = _cw.backdrop.querySelector('[data-cw-foot]');
  if (!foot) return;

  let left = '';
  let right = '';

  if (_cw.step === 1) {
    left = '<button type="button" class="cw-btn ghost" data-cw-action="close">取消</button>';
    const canNext = _cw.source === 'all' || _cw.sources.some((s) => s.type === _cw.source);
    right = `<button type="button" class="cw-btn primary" data-cw-action="next"${canNext ? '' : ' disabled'}>下一步</button>`;
  } else if (_cw.step === 2) {
    left = '<button type="button" class="cw-btn ghost" data-cw-action="source">返回</button>';
    right = `<button type="button" class="cw-btn primary" data-cw-action="import"${_cw.selected.size ? '' : ' disabled'}>开始导入${_cw.selected.size ? ` (${_cw.selected.size})` : ''}</button>`;
  } else if (_cw.step === 3) {
    left = '';
    right = `<button type="button" class="cw-btn ghost" data-cw-action="close"${_cw.busy ? ' disabled' : ''}>关闭</button>`;
  } else {
    const okCount = _cw.imported.length;
    left = '<button type="button" class="cw-btn ghost" data-cw-action="sessions">再导入更多</button>';
    right = `
      <button type="button" class="cw-btn ghost" data-cw-action="close">完成</button>
      ${okCount ? '<button type="button" class="cw-btn primary" data-cw-action="open-latest">打开最近导入的会话</button>' : ''}`;
  }

  foot.innerHTML = `<div class="cw-foot-left">${left}</div><div class="cw-foot-right">${right}</div>`;
  foot.querySelectorAll('[data-cw-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.cwAction;
      if (action === 'close') _cwClose();
      else if (action === 'next') _cwGo(2);
      else if (action === 'source') _cwGo(1);
      else if (action === 'import') _cwGo(3);
      else if (action === 'sessions') _cwGo(2);
      else if (action === 'open-latest') {
        const latest = _cw.imported[_cw.imported.length - 1];
        _cwOpenConversation(latest && latest.cid);
      }
    });
  });
}

/** Short label for a session source, used in lists and import rows. */
function _cwSourceLabel(source) {
  if (source === 'claude') return 'Claude Code';
  if (source === 'claude-desktop') return 'Claude 桌面版';
  return 'Codex';
}

async function _cwLoadSources() {
  const grid = _cw.backdrop.querySelector('[data-cw-sources]');
  if (!grid) return;
  try {
    const res = await window.orkas.invoke('localAgents.list');
    const entries = Array.isArray(res && res.entries) ? res.entries : [];
    const available = entries.filter((e) => e && e.available && (e.type === 'claude' || e.type === 'codex'));

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

    const sourceCard = (a) => {
      const version = a.version ? `v${_cwEsc(a.version)}` : '';
      const meta = a.type === 'claude-desktop' ? `${a.count} 个会话` : (version || '本机检测到');
      return `
        <button type="button" class="cw-source-card${_cw.source === a.type ? ' is-active' : ''}" data-cw-source="${_cwEsc(a.type)}">
          <span class="cw-source-icon">${_cwIcon('play')}</span>
          <span class="cw-source-name">${_cwEsc(_cwSourceLabel(a.type))}</span>
          <span class="cw-source-meta">${meta}</span>
        </button>`;
    };

    const allCard = available.length > 1
      ? `
        <button type="button" class="cw-source-card is-all${_cw.source === 'all' ? ' is-active' : ''}" data-cw-source="all">
          <span class="cw-source-icon">${_cwIcon('check')}</span>
          <span class="cw-source-name">全部来源</span>
          <span class="cw-source-meta">包含 ${available.length} 个 Agent</span>
        </button>`
      : '';

    const divider = available.length > 1
      ? `<div class="cw-source-divider"><span>或按来源单独选择</span></div>`
      : '';

    grid.innerHTML = allCard + divider + available.map(sourceCard).join('');
    grid.querySelectorAll('[data-cw-source]').forEach((el) => {
      el.addEventListener('click', () => {
        _cw.source = el.dataset.cwSource;
        _cw.selected = new Set();
        grid.querySelectorAll('[data-cw-source]').forEach((x) => x.classList.toggle('is-active', x === el));
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

  const wanted = _cw.source === 'all'
    ? _cw.sources.map((s) => s.type)
    : [_cw.source];
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
      } else {
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
      }
    } catch (err) {
      _cwLog.warn(`failed to list ${type} sessions`, err);
    }
  }

  _cw.sessions = sessions;
  _cw.selected = new Set(sessions.map((s) => s.id).filter((id) => _cw.selected.has(id)));
  _cwRenderSessionList();
}

function _cwRenderSessionList() {
  const list = _cw.backdrop.querySelector('[data-cw-session-list]');
  const search = _cw.backdrop.querySelector('[data-cw-search]');
  const countEl = _cw.backdrop.querySelector('[data-cw-count]');
  if (!list) return;

  const q = String(search && search.value || '').trim().toLowerCase();
  const visible = _cw.sessions.filter((s) => (
    !q || `${s.title} ${s.meta} ${s.source}`.toLowerCase().includes(q)
  ));

  if (countEl) countEl.textContent = `已选 ${_cw.selected.size} / ${_cw.sessions.length}`;
  if (search) {
    const allVisibleSelected = visible.length > 0 && visible.every((s) => _cw.selected.has(s.id));
    const selectAll = _cw.backdrop.querySelector('[data-cw-select-all]');
    if (selectAll) selectAll.textContent = allVisibleSelected ? '取消全选' : '全选';
  }

  if (!_cw.sessions.length) {
    list.innerHTML = _cw.denied
      ? '<div class="cw-empty">无法访问 Claude 数据目录，请检查软件权限。</div>'
      : '<div class="cw-empty">所选来源没有可导入的历史会话。</div>';
    _cwRenderFoot();
    return;
  }
  if (!visible.length) {
    list.innerHTML = '<div class="cw-empty">没有匹配的会话。</div>';
    _cwRenderFoot();
    return;
  }

  list.innerHTML = visible.map((s) => {
    const selected = _cw.selected.has(s.id);
    const time = s.time ? new Date(s.time).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '';
    return `
      <div class="cw-session-row${selected ? ' is-selected' : ''}" data-cw-session="${_cwEsc(s.id)}">
        <span class="cw-check">${_cwIcon('check')}</span>
        <span class="cw-session-source">${_cwEsc(_cwSourceLabel(s.source))}</span>
        <span class="cw-session-body">
          <span class="cw-session-title">${_cwEsc(s.title)}</span>
          <span class="cw-session-meta">${_cwEsc(s.meta || '')}${time ? ` · ${_cwEsc(time)}` : ''}</span>
        </span>
      </div>`;
  }).join('');

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
      <span class="cw-import-source">${_cwEsc(_cwSourceLabel(item.source))}</span>
      <span class="cw-import-title">${_cwEsc(item.title)}</span>
      <span class="cw-import-status">${status}</span>
    </div>`;
}

async function _cwRunImport() {
  if (!_cw) return;
  const items = _cw.sessions.filter((s) => _cw.selected.has(s.id));
  const list = _cw.backdrop.querySelector('[data-cw-import-list]');
  const progress = _cw.backdrop.querySelector('[data-cw-progress]');
  if (!list) return;

  _cw.busy = true;
  _cw.imported = [];
  _cw.failed = [];
  _cw.cognitions = 0;
  _cwRenderFoot();

  items.forEach((item) => { item.status = 'waiting'; });
  list.innerHTML = items.map((item) => _cwRowHtml(item, 'is-waiting', '等待中')).join('');

  let doneCount = 0;
  const updateProgress = () => {
    if (!progress) return;
    const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0;
    progress.style.width = `${pct}%`;
  };

  for (let i = 0; i < items.length; i += 1) {
    if (!_cw || _cw.cancel) break;
    const item = items[i];
    let row = list.querySelectorAll('[data-cw-import-row]')[i];
    item.status = 'running';
    if (row) {
      row.outerHTML = _cwRowHtml(item, 'is-running', '导入中');
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
      } else {
        res = await window.orkas.invoke('sessionImport.importCodexSession', {
          filePath: item.filePath,
          titleHint: item.title,
        });
      }
      if (res && res.conversationId) {
        item.status = 'ok';
        item.cid = res.conversationId;
        _cw.imported.push(item);
        if (item.source === 'claude' && res.cognitions) {
          _cw.cognitions += (res.cognitions.personal || 0) + (res.cognitions.rule || 0) + (res.cognitions.template || 0);
        }
        if (row) {
          row.outerHTML = _cwRowHtml(item, 'is-ok', res.truncated ? '已完成 · 对话过长，已截断' : '已完成');
          row = list.querySelectorAll('[data-cw-import-row]')[i];
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
  _cwGo(4);
}

function _cwRenderDone() {
  const body = _cw.backdrop.querySelector('[data-cw-body]');
  if (!body) return;
  const okCount = _cw.imported.length;
  const failCount = _cw.failed.length;
  const meta = `成功 ${okCount}${failCount ? ` · 失败 ${failCount}` : ''}${_cw.cognitions ? ` · 提取 ${_cw.cognitions} 条候选认知` : ''}`;
  const listHtml = okCount
    ? `<div class="cw-done-list">${_cw.imported.map((item) => `
        <div class="cw-done-row">
          <span class="cw-done-title">${_cwEsc(item.title)}</span>
          <button type="button" class="cw-btn small" data-cw-open-cid="${_cwEsc(item.cid)}">打开</button>
        </div>`).join('')}</div>`
    : '<div class="cw-empty">没有成功导入的会话，可以返回重新选择。</div>';

  body.innerHTML = `
    <div class="cw-done-summary">
      <div class="cw-done-icon">${okCount ? _cwIcon('check') : _cwIcon('clock')}</div>
      <div class="cw-done-title">${okCount ? `已导入 ${okCount} 个会话` : '导入未完成'}</div>
      <div class="cw-done-meta">${_cwEsc(meta)}</div>
    </div>
    ${listHtml}`;

  body.querySelectorAll('[data-cw-open-cid]').forEach((el) => {
    el.addEventListener('click', () => _cwOpenConversation(el.dataset.cwOpenCid));
  });
  _cwRenderFoot();
}

window.continueWork = { open };
