// ─── Conversation info side panel ───────────────────────────────────────
// Right-side companion panel for the active conversation. It summarizes the
// workspace files and attachments. The file tab reads the live conversation
// workspace first, then merges chip-tracked produced files from history so
// the panel stays aligned with disk even when tools create files through
// bash / CLI flows.

const ConversationInfo = (() => {
  const _infoLog = (typeof createLogger === 'function')
    ? createLogger('conversation-info')
    : { warn: () => {}, info: () => {}, error: () => {} };

  let _cid = null;
  let _open = false;
  let _activeTab = 'files';
  let _seq = 0;
  let _activitySeq = 0;
  let _fileSeq = 0;
  let _attachmentSeq = 0;
  let _mateProjectionSeq = 0;
  const _locallyDeletedPaths = new Set();
  let _loading = false;
  let _loadingSource = '';
  let _loadingSeq = 0;
  let _error = '';
  let _fileMenuScrollHost = null;
  let _snapshot = {
    conversation: null,
    history: [],
    files: [],
    fileRoot: '',
    fileRootExists: false,
    filesTruncated: false,
    filesCount: 0,
    filesScanSkipped: false,
    syncEnabled: false,
    attachments: [],
    runtime: null,
    actors: [],
    collaboration: null,
    mate: { session: null, collaboration: null, sessions: [], loading: false, error: '' },
    wakeRequests: [],
    protocolEvents: [],
    protocolError: '',
  };
  const _protocolFilters = { agent: '', role: '', result: '' };
  const _CI_TEXT_EXTS = new Set([
    'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log',
    'html', 'htm', 'xml', 'toml', 'ini', 'conf',
    'py', 'pyi', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'sh', 'bash', 'zsh', 'ps1', 'cmd', 'bat', 'rb', 'go', 'rs', 'java', 'kt',
    'c', 'cpp', 'cc', 'h', 'hpp', 'css', 'scss', 'less',
    'sql', 'graphql', 'gql',
  ]);
  const _CI_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
  const _CI_VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
  const _CI_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac']);
  const _CI_OFFICE_WORD_EXTS = new Set(['docx', 'docm']);
  const _CI_OFFICE_SHEET_EXTS = new Set(['xlsx', 'xlsm']);
  const _CI_OFFICE_PRESENTATION_EXTS = new Set(['pptx', 'pptm']);

  function _label(key, fallback, vars) {
    const formatFallback = () => {
      const raw = String(fallback || '');
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (match, name) => (
        vars[name] != null ? String(vars[name]) : match
      ));
    };
    try {
      const v = typeof t === 'function' ? t(key, vars || undefined) : key;
      return v && v !== key ? v : formatFallback();
    } catch (_) {
      return formatFallback();
    }
  }

  function _compactText(text, max = 82) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function _baseName(p) {
    const parts = String(p || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p || '');
  }

  function _extForName(name) {
    const base = _baseName(name);
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
  }

  function _dirName(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const idx = s.lastIndexOf('/');
    return idx >= 0 ? s.slice(0, idx) : '';
  }

  function _splitPath(p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
  }

  function _normalizePath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function _pathIsSameOrInside(parent, target) {
    const p = _normalizePath(parent).replace(/\/+$/, '');
    const t = _normalizePath(target);
    return !!p && (t === p || t.startsWith(p + '/'));
  }

  function _isLocallyDeletedPath(p) {
    const target = _normalizePath(p);
    for (const deleted of _locallyDeletedPaths) {
      if (_pathIsSameOrInside(deleted, target)) return true;
    }
    return false;
  }

  function _relPathUnder(root, target) {
    const r = _normalizePath(root).replace(/\/+$/, '');
    const t = _normalizePath(target);
    if (!r || !t) return '';
    if (t === r) return '';
    const prefix = r + '/';
    return t.startsWith(prefix) ? t.slice(prefix.length) : '';
  }

  function _samePrefix(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function _commonDirSegments(paths) {
    const dirs = paths.map((p) => _splitPath(_dirName(p)));
    if (!dirs.length) return [];
    let common = dirs[0].slice();
    for (let i = 1; i < dirs.length; i++) {
      const next = dirs[i];
      let j = 0;
      while (j < common.length && j < next.length && common[j] === next[j]) j++;
      common = common.slice(0, j);
    }
    return common;
  }

  // One-time warn when the shared icons helpers (`window.fileKindIconHtml` /
  // `window.uiIconHtml`, defined by `modules/icons.js`) are missing — typical
  // cause is an `index.html` script-list refactor that put `icons.js` after a
  // consumer. Without this warn the panel just paints rows without icons,
  // silently degrading; logging once lets DevTools surface the broken load
  // order on the first render attempt. The flag is per-module-lifetime to
  // avoid spamming on every refresh.
  let _warnedIconsMissing = false;
  function _warnIconsHelperMissingOnce(helperName) {
    if (_warnedIconsMissing) return;
    _warnedIconsMissing = true;
    _infoLog.warn(`icons.js helper missing: ${helperName} — check index.html <script> load order`);
  }

  function _iconForName(name, kind) {
    if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') return window.fileKindIconHtml(name, kind);
    _warnIconsHelperMissingOnce('fileKindIconHtml');
    return '';
  }

  function _uiIcon(name, className) {
    if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, className);
    }
    _warnIconsHelperMissingOnce('uiIconHtml');
    return '';
  }

  function _kindForName(name) {
    const ext = _extForName(name);
    if (_CI_IMAGE_EXTS.has(ext)) return 'image';
    if (_CI_VIDEO_EXTS.has(ext)) return 'video';
    if (_CI_AUDIO_EXTS.has(ext)) return 'audio';
    if (ext === 'pdf') return 'pdf';
    if (_CI_OFFICE_WORD_EXTS.has(ext)) return 'docx';
    if (_CI_OFFICE_SHEET_EXTS.has(ext)) return 'spreadsheet';
    if (_CI_OFFICE_PRESENTATION_EXTS.has(ext)) return 'presentation';
    if (['doc', 'xls', 'ppt'].includes(ext)) return 'legacy_office';
    if (_CI_TEXT_EXTS.has(ext)) return 'text';
    return 'unsupported';
  }

  function _fileOperationPolicy() {
    return typeof window !== 'undefined' ? window.FileOperationPolicy : null;
  }

  function _canAddEntryToLibrary(name, projectScoped = false) {
    const policy = _fileOperationPolicy();
    return !!(policy && policy.canAddToLibrary(name, { projectScoped }));
  }

  function _canAddEntryToChat(name) {
    const policy = _fileOperationPolicy();
    return !!(policy && policy.canAddToChat(name));
  }

  function _canShareEntry(name) {
    const policy = _fileOperationPolicy();
    return !!(policy && policy.canShare(name));
  }

  function _isProjectConversation(cid) {
    const target = String(cid || '');
    const snapshotConversation = _snapshot.conversation;
    if (snapshotConversation
      && (!target || target === _cid || snapshotConversation.conversation_id === target)
      && snapshotConversation.project_id) return true;
    if (typeof conversations === 'undefined' || !Array.isArray(conversations)) return false;
    const conversation = conversations.find((item) => item && item.conversation_id === target);
    return !!(conversation && conversation.project_id);
  }

  function _formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  async function _fetchJson(url) {
    const res = await apiFetch(url);
    const data = await res.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || 'load failed');
    return data;
  }

  async function _invokeOrDefault(channel, payload, fallback) {
    const invoke = window && window.cogseed && typeof window.cogseed.invoke === 'function'
      ? window.cogseed.invoke.bind(window.cogseed)
      : null;
    if (!invoke) return fallback;
    try {
      const result = await invoke(channel, payload);
      return result || fallback;
    } catch (_) {
      return fallback;
    }
  }

  async function _load(cid) {
    const enc = encodeURIComponent(cid);
    const [historyData, filesData, attachmentData, syncEnabled, activity, wakeData, protocolData, executionsData] = await Promise.all([
      _fetchJson(typeof _historyRequestUrl === 'function'
        ? _historyRequestUrl(cid)
        : `/api/conversations/${enc}/history?limit=10`),
      _fetchJson(`/api/conversations/${enc}/files`).catch((err) => {
        _infoLog.warn('file list load failed', { cid, error: err && err.message });
        return { items: [], root: '', rootExists: false, truncated: false, count: 0, scanSkipped: false };
      }),
      _fetchJson(`/api/conversations/${enc}/attachments`).catch((err) => {
        _infoLog.warn('attachment load failed', { cid, error: err && err.message });
        return { items: [] };
      }),
      _loadSyncEnabled(),
      _loadAgentActivitySnapshot(cid),
      _fetchJson(`/api/conversations/${enc}/wake-requests`).catch(() => ({ requests: [] })),
      _fetchJson(`/api/conversations/${enc}/protocol-events`).catch((err) => ({ events: [], error: (err && err.message) || String(err) })),
      // 9.1 右侧「本次携带」：真实执行记录（状态 / 权限 / 边界 / 回执关联）。
      // IPC 已存在；加载失败或环境无 IPC 时静默降级为空列表。
      _invokeOrDefault('p3394.execution.list', {}, { ok: false }).then((data) => (
        data && Array.isArray(data.executions)
          ? data.executions.filter((item) => item && item.conversationId === cid)
          : []
      )).catch(() => []),
    ]);
    return {
      conversation: historyData.conversation || null,
      history: Array.isArray(historyData.history) ? historyData.history : [],
      files: Array.isArray(filesData.items) ? filesData.items : [],
      fileRoot: typeof filesData.root === 'string' ? filesData.root : '',
      fileRootExists: filesData.rootExists === true,
      filesTruncated: filesData.truncated === true,
      filesCount: Number(filesData.count) || 0,
      filesScanSkipped: filesData.scanSkipped === true,
      syncEnabled: syncEnabled === true,
      attachments: Array.isArray(attachmentData.items) ? attachmentData.items : [],
      runtime: activity.runtime || null,
      actors: Array.isArray(activity.actors) ? activity.actors : [],
      collaboration: activity.runtime && activity.runtime.collaboration ? activity.runtime.collaboration : null,
      wakeRequests: Array.isArray(wakeData.requests) ? wakeData.requests : [],
      protocolEvents: Array.isArray(protocolData.events) ? protocolData.events : (Array.isArray(protocolData.protocol_events) ? protocolData.protocol_events : []),
      protocolError: protocolData.error ? String(protocolData.error) : '',
      executions: Array.isArray(executionsData) ? executionsData : [],
    };
  }

  async function _loadAgentActivitySnapshot(cid) {
    if (!cid) return { actors: [], runtime: {} };
    const membersUrl = typeof _membersRequestUrl === 'function'
      ? _membersRequestUrl(cid)
      : `/api/conversations/${encodeURIComponent(cid)}/members`;
    const [membersRes, runtimeRes] = await Promise.all([
      _fetchJson(membersUrl).catch(() => null),
      _fetchJson(`/api/conversations/${encodeURIComponent(cid)}/runtime`).catch(() => null),
    ]);
    return {
      actors: membersRes && Array.isArray(membersRes.actors) ? membersRes.actors : [],
      runtime: runtimeRes || {},
    };
  }

  function _setMateProjectionState(next, seq) {
    if (seq !== _mateProjectionSeq || (_cid && next && next.sessionId && next.sessionId !== _cid)) return;
    const mate = next || { session: null, collaboration: null, sessions: [], loading: false, error: '' };
    _snapshot = {
      ..._snapshot,
      mate: {
        session: mate.session || null,
        collaboration: mate.collaboration || null,
        sessions: Array.isArray(mate.sessions) ? mate.sessions : _snapshot.mate.sessions,
        loading: !!mate.loading,
        error: mate.error ? String(mate.error) : '',
      },
      collaboration: mate.collaboration || _snapshot.collaboration,
    };
    if (_activeTab === 'collaboration') _renderBody();
  }

  function _renderMateProjectionError(message) {
    return `<div class="conversation-info-empty is-small is-error">${escapeHtml(_label('conversation_info.mate.load_failed', 'Could not load Mate overview: {reason}', { reason: message }))}</div>`;
  }

  function _renderMateActions(task, actions) {
    if (!task) return '';
    const buttons = [];
    if (actions && actions.retry) buttons.push(`<button type="button" class="conversation-info-mate-action" data-mate-action="retry" data-mate-task-id="${escapeHtml(task.taskId)}" data-mate-request-id="${escapeHtml(task.requestId)}">${escapeHtml(_label('common.retry', 'Retry'))}</button>`);
    if (actions && actions.resume) buttons.push(`<button type="button" class="conversation-info-mate-action" data-mate-action="resume" data-mate-task-id="${escapeHtml(task.taskId)}" data-mate-request-id="${escapeHtml(task.requestId)}">${escapeHtml(_label('common.resume', 'Resume'))}</button>`);
    if (actions && actions.abort) buttons.push(`<button type="button" class="conversation-info-mate-action is-danger" data-mate-action="abort" data-mate-task-id="${escapeHtml(task.taskId)}">${escapeHtml(_label('common.abort', 'Abort'))}</button>`);
    return buttons.length ? `<div class="conversation-info-mate-actions">${buttons.join('')}</div>` : '';
  }

  function _renderMateOverview() {
    const mate = _snapshot.mate || {};
    const session = mate.session || null;
    if (!session) {
      if (mate.loading) return `<div class="conversation-info-empty">${escapeHtml(_label('common.loading', 'Loading…'))}</div>`;
      if (mate.error) return _renderMateProjectionError(mate.error);
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.mate.empty', 'No Mate collaboration snapshot yet.'))}</div>`;
    }
    const collaboration = session.collaboration || mate.collaboration || null;
    const task = collaboration && collaboration.task ? collaboration.task : null;
    const actors = collaboration && Array.isArray(collaboration.actors) ? collaboration.actors : [];
    const timeline = collaboration && Array.isArray(collaboration.timeline) ? collaboration.timeline : [];
    const workflow = collaboration && collaboration.workflow ? collaboration.workflow : { childTaskIds: [], steps: [] };
    const actionSummary = task && task.actions ? _renderMateActions(task, task.actions) : '';
    const stepRows = Array.isArray(workflow.steps) && workflow.steps.length
      ? `<div class="conversation-info-mate-steps">${workflow.steps.map((step) => `<div class="conversation-info-mate-step"><div class="conversation-info-mate-step-title">${escapeHtml(step.title || step.stepId || '')}</div><div class="conversation-info-mate-step-meta">${escapeHtml(step.status || '')}${step.actorId ? ` · ${escapeHtml(step.actorId)}` : ''}${Array.isArray(step.dependsOn) && step.dependsOn.length ? ` · ${escapeHtml(step.dependsOn.join(', '))}` : ''}</div>${step.resultSummary ? `<div class="conversation-info-mate-step-summary">${escapeHtml(step.resultSummary)}</div>` : ''}</div>`).join('')}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.mate.no_steps', 'No workflow steps yet.'))}</div>`;
    const actorRows = actors.length
      ? `<div class="conversation-info-mate-actors">${actors.map((actor) => `<div class="conversation-info-mate-actor"><div class="conversation-info-mate-actor-role">${escapeHtml(actor.role || '')}</div><div class="conversation-info-mate-actor-meta">${escapeHtml(actor.actorId || '')}${actor.taskId ? ` · ${escapeHtml(actor.taskId)}` : ''}${actor.status ? ` · ${escapeHtml(actor.status)}` : ''}</div></div>`).join('')}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.mate.no_actors', 'No actors yet.'))}</div>`;
    const timelineRows = timeline.length
      ? `<div class="conversation-info-mate-timeline">${timeline.slice(-8).map((event) => `<div class="conversation-info-mate-timeline-item"><div class="conversation-info-mate-timeline-head">${escapeHtml(event.type || '')} · ${escapeHtml(event.createdAt || '')}</div><div class="conversation-info-mate-timeline-body">${escapeHtml(event.summary || '')}</div></div>`).join('')}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.mate.no_timeline', 'No recovery timeline yet.'))}</div>`;
    const childIds = Array.isArray(workflow.childTaskIds) && workflow.childTaskIds.length
      ? `<div class="conversation-info-mate-child-tree">${workflow.childTaskIds.map((id) => `<span class="conversation-info-mate-child-chip">${escapeHtml(id)}</span>`).join('')}</div>`
      : '';
    return `<section class="conversation-info-collaboration-section conversation-info-mate-overview">
      <div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.mate.section_title', 'Mate Collaboration Overview'))}</div>
      <div class="conversation-info-mate-meta">${escapeHtml(session.sessionId)} · ${escapeHtml(session.latestStatus || 'idle')} · ${escapeHtml(_label('conversation_info.mate.task_count', '{count} tasks', { count: session.taskCount || 0 }))}</div>
      <div class="conversation-info-mate-task-title">${escapeHtml(task && task.title ? task.title : _label('conversation_info.mate.no_task', 'No active task.'))}</div>
      ${actionSummary}
      ${childIds}
      <div class="conversation-info-mate-grid">
        <div class="conversation-info-mate-card"><div class="conversation-info-mate-card-title">${escapeHtml(_label('conversation_info.mate.actors', 'Actors'))}</div>${actorRows}</div>
        <div class="conversation-info-mate-card"><div class="conversation-info-mate-card-title">${escapeHtml(_label('conversation_info.mate.steps', 'Workflow'))}</div>${stepRows}</div>
        <div class="conversation-info-mate-card"><div class="conversation-info-mate-card-title">${escapeHtml(_label('conversation_info.mate.timeline', 'Recovery Timeline'))}</div>${timelineRows}</div>
      </div>
    </section>`;
  }

  async function _primeMateProjection(cid, opts = {}) {
    if (!cid || !window.mateAgentProjection || typeof window.mateAgentProjection.session !== 'function') return null;
    const seq = ++_mateProjectionSeq;
    const entry = window.mateAgentProjection.session(cid, {
      onUpdate: (value) => {
        if (seq !== _mateProjectionSeq || cid !== _cid) return;
        const next = value || null;
        _snapshot = {
          ..._snapshot,
          mate: {
            session: next,
            collaboration: next && next.collaboration ? next.collaboration : null,
            sessions: _snapshot.mate.sessions,
            loading: false,
            error: '',
          },
          collaboration: next && next.collaboration ? next.collaboration : _snapshot.collaboration,
        };
        if (_activeTab === 'collaboration' || opts.render === true) _renderBody();
      },
    });
    if (entry && entry.snapshot) {
      _setMateProjectionState({ session: entry.snapshot, collaboration: entry.snapshot && entry.snapshot.collaboration ? entry.snapshot.collaboration : null, sessions: _snapshot.mate.sessions, loading: true, error: '' }, seq);
    } else {
      _setMateProjectionState({ session: null, collaboration: null, sessions: _snapshot.mate.sessions, loading: true, error: '' }, seq);
    }
    try {
      await entry.refresh;
    } catch (err) {
      if (seq !== _mateProjectionSeq || cid !== _cid) return null;
      _setMateProjectionState({ session: null, collaboration: null, sessions: _snapshot.mate.sessions, loading: false, error: (err && err.message) || String(err) }, seq);
    }
    return entry;
  }

  async function refreshAgentActivity(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_activitySeq;
    try {
      const activity = await _loadAgentActivitySnapshot(target);
      if (seq !== _activitySeq || target !== _cid) return;
      _snapshot = {
        ..._snapshot,
        actors: Array.isArray(activity.actors) ? activity.actors : [],
        runtime: activity.runtime || {},
        collaboration: activity.runtime && activity.runtime.collaboration
          ? activity.runtime.collaboration
          : _snapshot.collaboration,
      };
      if (_activeTab === "collaboration" || opts.render === true) _renderBody();
    } catch (err) {
      _infoLog.warn("agent activity refresh failed", { cid: target, error: err && err.message });
    }
  }

  async function _loadFileSnapshot(cid) {
    const enc = encodeURIComponent(cid);
    const filesData = await _fetchJson(`/api/conversations/${enc}/files`).catch((err) => {
      _infoLog.warn('file list load failed', { cid, error: err && err.message });
      return { items: [], root: '', rootExists: false, truncated: false, count: 0, scanSkipped: false };
    });
    // A file-only refresh used to fetch the complete history again just to
    // preserve the existing snapshot. The original panel load already owns
    // that history; generated files are authoritative in the workspace scan.
    // Leave history/conversation/syncEnabled untouched in the caller's merge.
    return {
      files: Array.isArray(filesData.items) ? filesData.items : [],
      fileRoot: typeof filesData.root === 'string' ? filesData.root : '',
      fileRootExists: filesData.rootExists === true,
      filesTruncated: filesData.truncated === true,
      filesCount: Number(filesData.count) || 0,
      filesScanSkipped: filesData.scanSkipped === true,
    };
  }

  async function _loadSyncEnabled() {
    return false;
  }

  function _normalizeAttachmentItems(items) {
    return (Array.isArray(items) ? items : [])
      .filter((item) => item && item.status !== 'error')
      .map((item) => ({
        name: String(item.name || ''),
        displayName: item.displayName ? String(item.displayName) : '',
        kind: item.kind || _kindForName(item.name || item.displayName || ''),
        bytes: Number(item.bytes) || 0,
        mtime: item.mtime,
        status: item.status || '',
      }))
      .filter((item) => item.name);
  }

  function _currentConversationTitle() {
    const c = _snapshot.conversation
      || (Array.isArray(conversations) ? conversations.find((x) => x && x.conversation_id === _cid) : null);
    return c && c.title ? c.title : _label('chat.new_conv_title', 'New conversation');
  }

  function _collectHistoryProducedFiles() {
    const byPath = new Map();
    for (const m of _snapshot.history || []) {
      const ts = m && (m.ts || m.time || '');
      const produced = Array.isArray(m && m.produced) ? m.produced : [];
      for (const p of produced) {
        if (!p) continue;
        const abs = String(p);
        if (_isLocallyDeletedPath(abs)) continue;
        byPath.set(abs, { path: abs, time: ts });
      }
    }
    return Array.from(byPath.values()).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  }

  function _collectVisibleFiles() {
    const byPath = new Map();
    const fileRoot = _snapshot.fileRoot || '';
    const workspaceFiles = Array.isArray(_snapshot.files) ? _snapshot.files : [];
    for (const item of workspaceFiles) {
      const p = item && item.path ? String(item.path) : '';
      if (!p) continue;
      const key = _normalizePath(p);
      const relPath = item.relPath ? String(item.relPath) : _relPathUnder(fileRoot, p);
      byPath.set(key, {
        path: p,
        relPath,
        name: item.name || _baseName(p),
        kind: item.kind || _kindForName(item.name || p),
        time: item.mtime ? new Date(Number(item.mtime)).toISOString() : '',
        bytes: Number(item.bytes) || 0,
        source: 'workspace',
      });
    }

    const hasAuthoritativeWorkspaceSnapshot = !!fileRoot && _snapshot.fileRootExists === true;
    for (const produced of _collectHistoryProducedFiles()) {
      const p = produced && produced.path ? String(produced.path) : '';
      if (!p) continue;
      const key = _normalizePath(p);
      if (byPath.has(key)) continue;
      const relPath = _relPathUnder(fileRoot, p);
      if (relPath && hasAuthoritativeWorkspaceSnapshot && !_snapshot.filesTruncated) {
        // The workspace snapshot is authoritative for files under its root.
        // If a produced file was deleted or renamed, don't keep showing the
        // stale history record.
        continue;
      }
      byPath.set(key, {
        ...produced,
        relPath,
        name: _baseName(p),
        kind: _kindForName(_baseName(p)),
        source: 'produced',
      });
    }

    return Array.from(byPath.values()).sort((a, b) => {
      const ar = a.relPath || a.path || '';
      const br = b.relPath || b.path || '';
      return String(ar).localeCompare(String(br));
    });
  }

  function _buildFileTree(files) {
    const root = { dirs: new Map(), files: [], path: '' };
    const hasRelPaths = files.some((f) => f && f.relPath);
    const common = hasRelPaths ? [] : _commonDirSegments(files.map((f) => f.path));
    for (const file of files) {
      const treePath = hasRelPaths ? (file.relPath || _baseName(file.path)) : file.path;
      const all = _splitPath(treePath);
      const rel = _samePrefix(common, all) ? all.slice(common.length) : all;
      const parts = rel.length ? rel : [_baseName(file.path)];
      const fullParts = _splitPath(file.path);
      const baseOffset = Math.max(0, fullParts.length - parts.length);
      let node = root;
      for (let i = 0; i < parts.slice(0, -1).length; i++) {
        const part = parts[i];
        const dirPath = _pathFromSegmentsLike(file.path, fullParts.slice(0, baseOffset + i + 1));
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], path: dirPath });
        else if (!node.dirs.get(part).path && dirPath) node.dirs.get(part).path = dirPath;
        node = node.dirs.get(part);
      }
      node.files.push({ ...file, name: parts[parts.length - 1] || _baseName(file.path) });
    }
    return root;
  }

  function _pathFromSegmentsLike(sourcePath, segments) {
    const source = _normalizePath(sourcePath);
    const prefix = source.startsWith('/') ? '/' : '';
    return prefix + (segments || []).join('/');
  }

  function _renderTreeNode(node, depth) {
    const dirs = Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    const moreTitle = _label('common.more', 'More');
    const dirHtml = dirs.map(([name, child]) => {
      const dirPath = child && child.path ? String(child.path) : '';
      return `
      <details class="conversation-info-dir" style="--depth:${depth}">
        <summary class="conversation-info-dir-summary" title="${escapeHtml(dirPath || name)}">
          <span class="conversation-info-dir-folder-icon conversation-info-dir-folder-closed">${_uiIcon('folder', 'ui-icon conversation-info-dir-svg-icon')}</span>
          <span class="conversation-info-dir-folder-icon conversation-info-dir-folder-open">${_uiIcon('folder-open', 'ui-icon conversation-info-dir-svg-icon')}</span>
          <span class="conversation-info-dir-name">${escapeHtml(name)}</span>
          ${dirPath ? `<button type="button" class="conversation-info-file-menu-btn" data-file-menu
                  data-entry-kind="dir" data-entry-path="${escapeHtml(dirPath)}" data-entry-name="${escapeHtml(name)}"
                  title="${escapeHtml(moreTitle)}" aria-label="${escapeHtml(moreTitle)}">⋯</button>` : ''}
        </summary>
        ${_renderTreeNode(child, depth + 1)}
      </details>
    `;
    }).join('');
    const fileHtml = files.map((file) => {
      const kind = file.kind || _kindForName(file.name || file.path);
      return `
      <div class="conversation-info-file" role="button" tabindex="0" style="--depth:${depth}"
              data-file-path="${escapeHtml(file.path)}" draggable="true" title="${escapeHtml(file.path)}">
        <span class="conversation-info-file-icon">${_iconForName(file.name)}</span>
        <span class="conversation-info-file-name">${escapeHtml(file.name)}</span>
        <button type="button" class="conversation-info-file-menu-btn" data-file-menu
                data-entry-kind="${escapeHtml(kind)}" data-entry-path="${escapeHtml(file.path)}" data-entry-name="${escapeHtml(file.name)}"
                title="${escapeHtml(moreTitle)}" aria-label="${escapeHtml(moreTitle)}">⋯</button>
      </div>
    `;
    }).join('');
    return dirHtml + fileHtml;
  }

  function _renderFiles() {
    const files = _collectVisibleFiles();
    if (!files.length) {
      if (_snapshot.filesScanSkipped) {
        return `<div class="conversation-info-empty">${escapeHtml(_label(
          'conversation_info.files_scan_skipped',
          'File listing is paused for this privacy-protected workspace. Files created or attached in chat still appear.'
        ))}</div>`;
      }
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_files', 'No files yet'))}</div>`;
    }
    const tree = _buildFileTree(files);
    const syncNotice = _snapshot.syncEnabled
      ? `<div class="ci-files-sync-note">
          <span class="ci-files-sync-note-icon">${_uiIcon('info', 'ui-icon ci-files-sync-note-svg')}</span>
          <span>${escapeHtml(_label(
            'conversation_info.files_sync_note',
            'Cloud sync does not include these files. Add supported files to Library if you want them synced.'
          ))}</span>
        </div>`
      : '';
    const trunc = _snapshot.filesTruncated
      ? `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.files_truncated', 'Showing first {count} files', { count: _snapshot.filesCount || files.length }))}</div>`
      : '';
    return `<div class="ci-files">${syncNotice}${trunc}<div class="conversation-info-tree">${_renderTreeNode(tree, 0)}</div></div>`;
  }

  function _collectConversationAttachments() {
    const byName = new Map();
    for (const m of _snapshot.history || []) {
      const ts = m && (m.ts || m.time || '');
      const attachments = Array.isArray(m && m.attachments) ? m.attachments : [];
      for (const name of attachments) {
        if (typeof name !== 'string' || !name) continue;
        if (!byName.has(name)) {
          byName.set(name, { name, kind: _kindForName(name), bytes: 0, time: ts, pending: false });
        }
      }
    }
    for (const item of _snapshot.attachments || []) {
      const name = String(item && item.name || '');
      if (!name) continue;
      byName.set(name, {
        name,
        displayName: item.displayName ? String(item.displayName) : '',
        kind: item.kind || _kindForName(name),
        bytes: Number(item.bytes) || 0,
        time: item.mtime ? new Date(Number(item.mtime) * 1000).toISOString() : '',
        pending: true,
      });
    }
    return Array.from(byName.values()).sort((a, b) => {
      const at = new Date(a.time || 0).getTime();
      const bt = new Date(b.time || 0).getTime();
      if (bt !== at) return bt - at;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function _ciThumbForKind(kind, name) {
    const n = String(name || '').toLowerCase();
    if (kind === 'image' || /\.(png|jpe?g|gif|webp|svg)$/i.test(n)) return { cls: 'is-image', label: 'IMG' };
    if (kind === 'pdf' || /\.pdf$/i.test(n)) return { cls: '', label: 'PDF' };
    if (/\.(docx?|docm)$/i.test(n)) return { cls: 'is-doc', label: 'DOC' };
    if (/\.(xlsx?|xlsm)$/i.test(n)) return { cls: 'is-doc', label: 'XLS' };
    if (/\.(pptx?|pptm)$/i.test(n)) return { cls: 'is-doc', label: 'PPT' };
    if (/\.(md|markdown|txt|csv|tsv|json|yaml|yml|log)$/i.test(n)) return { cls: 'is-doc', label: (n.split('.').pop() || 'TXT').slice(0, 4).toUpperCase() };
    return { cls: 'is-doc', label: 'FILE' };
  }

  function _renderAttachments() {
    const items = _collectConversationAttachments();
    if (!items.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_attachments', 'No attachments'))}</div>`;
    }
    const rows = items.map((item) => {
      const name = String(item.name || '');
      const label = String(item.displayName || item.name || '');
      const size = _formatBytes(item.bytes);
      const time = item.time ? new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const meta = [size, time].filter(Boolean).join(' · ');
      const thumb = _ciThumbForKind(item.kind, label);
      return `
        <button type="button" class="ci-attach-row" data-attachment-name="${escapeHtml(name)}" title="${escapeHtml(label)}">
          <span class="ci-attach-row-thumb ${thumb.cls}">${escapeHtml(thumb.label)}</span>
          <div class="ci-attach-row-main">
            <span class="ci-attach-row-name">${escapeHtml(label)}</span>
            ${meta ? `<span class="ci-attach-row-meta">${escapeHtml(meta)}</span>` : ''}
          </div>
        </button>
      `;
    }).join('');
    return `<div class="ci-attach"><div class="ci-attach-list">${rows}</div></div>`;
  }

  // Tab count chips — filled from the same _snapshot as the body renderers.
  // Tasks count is `done/total`; files / attachments mirror visible rows.
  function _refreshTabCounts() {
    const filesEl = document.getElementById('conversation-info-tab-count-files');
    if (filesEl) {
      const count = _collectVisibleFiles().length;
      filesEl.textContent = count > 0 ? String(count) : '';
    }
    const attachEl = document.getElementById('conversation-info-tab-count-attachments');
    if (attachEl) {
      const count = _collectConversationAttachments().length;
      attachEl.textContent = count > 0 ? String(count) : '';
    }
    const collaborationEl = document.getElementById('conversation-info-tab-count-collaboration');
    if (collaborationEl) {
      const count = _snapshot.collaboration ? 1 : 0;
      collaborationEl.textContent = count > 0 ? String(count) : '';
    }
    const protocolEl = document.getElementById('conversation-info-tab-count-protocol');
    if (protocolEl) {
      const count = Array.isArray(_snapshot.protocolEvents) ? _snapshot.protocolEvents.length : 0;
      protocolEl.textContent = count > 0 ? String(count) : '';
    }
  }

  function _safeSection(renderFn, fallbackHtml) {
    try {
      return renderFn();
    } catch (err) {
      _infoLog.warn('collaboration section render failed', { error: err && err.message });
      return fallbackHtml;
    }
  }

  function _agentActivityActorName(actor) {
    if (!actor) return '';
    const id = String(actor.id || '');
    if (actor.name) return String(actor.name);
    if (id === 'commander') return _label('chat.agent_status.commander', 'Commander');
    return id || _label('chat.from_agent_unknown', 'Agent');
  }

  function _agentActivityNormaliseActiveTurns(raw) {
    if (typeof _normaliseActiveTurns === 'function') return _normaliseActiveTurns(raw);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((t) => ({ actor: String(t && (t.actor || t.actor_id) || ''), turn_id: String(t && (t.turn_id || t.turnId) || '') }))
      .filter((t) => t.actor && t.turn_id);
  }

  function _deriveAgentActivityRows(snapshot) {
    const runtime = snapshot && snapshot.runtime ? snapshot.runtime : {};
    const inFlight = Array.isArray(runtime.in_flight) ? runtime.in_flight.filter(Boolean).map(String) : [];
    const activeTurns = _agentActivityNormaliseActiveTurns(runtime.active_turns);
    const running = new Set(inFlight);
    for (const turn of activeTurns) running.add(String(turn.actor || ''));
    const activeRecipient = typeof runtime.active_recipient === 'string' ? runtime.active_recipient : '';
    const byId = new Map();
    const actors = Array.isArray(snapshot && snapshot.actors) ? snapshot.actors : [];
    for (const actor of actors) {
      if (actor && actor.id && (actor.kind === 'commander' || actor.kind === 'agent')) {
        byId.set(String(actor.id), actor);
      }
    }
    for (const actorId of running) {
      if (!byId.has(actorId)) byId.set(actorId, { kind: actorId === 'commander' ? 'commander' : 'agent', id: actorId, name: actorId });
    }
    if (activeRecipient && !byId.has(activeRecipient)) {
      byId.set(activeRecipient, { kind: activeRecipient === 'commander' ? 'commander' : 'agent', id: activeRecipient, name: activeRecipient });
    }
    const history = Array.isArray(snapshot && snapshot.history) ? snapshot.history : [];
    const rows = Array.from(byId.values()).map((actor) => {
      const id = String(actor.id || '');
      let state = 'joined';
      if (running.has(id)) state = 'running';
      else if (activeRecipient && activeRecipient === id) state = 'current_recipient';
      const activeTurn = activeTurns.find((turn) => String(turn.actor || '') === id);
      const lastMessage = [...history].reverse().find((msg) => msg && String(msg.from || '') === id) || null;
      const lastDispatch = [...history].reverse().find((msg) => msg && Array.isArray(msg.to) && msg.to.map(String).includes(id)) || null;
      const p3394Event = Array.isArray(lastMessage && lastMessage.process)
        ? lastMessage.process.find((item) => item && item.event && item.event.stream === 'p3394' && item.event.data)
        : null;
      const p3394Data = p3394Event && p3394Event.event && p3394Event.event.data ? p3394Event.event.data : null;
      if (state === 'joined' && p3394Data && (p3394Data.error || p3394Data.detail)) state = 'failed';
      return {
        id,
        kind: actor.kind === 'commander' ? 'commander' : 'agent',
        name: _agentActivityActorName(actor),
        state,
        turnId: activeTurn && activeTurn.turn_id ? String(activeTurn.turn_id) : '',
        activeRecipient: activeRecipient === id,
        lastMessage,
        lastDispatch,
        p3394Data,
      };
    });
    const order = { running: 0, current_recipient: 1, joined: 2, failed: 3, completed: 4 };
    return rows.sort((a, b) => {
      const orderDiff = (order[a.state] ?? 99) - (order[b.state] ?? 99);
      if (orderDiff) return orderDiff;
      if (a.id === 'commander') return -1;
      if (b.id === 'commander') return 1;
      return a.name.localeCompare(b.name);
    });
  }

  function _renderAgentActivitySummary(rows, runtime) {
    const running = rows.filter((row) => row.state === 'running').length;
    const processing = runtime && runtime.processing
      ? _label('conversation_info.agent_activity.processing_active', 'Processing')
      : _label('conversation_info.agent_activity.processing_idle', 'Idle');
    return `<div class="conversation-info-agent-activity-summary">
      <div class="conversation-info-agent-activity-stat is-primary"><span>${escapeHtml(_label('conversation_info.agent_activity.summary_agents', 'Agents'))}</span><strong>${rows.length}</strong><small>${escapeHtml(_label('conversation_info.agent_activity.summary_scope', 'In this conversation'))}</small></div>
      <div class="conversation-info-agent-activity-stat"><span>${escapeHtml(_label('conversation_info.agent_activity.summary_running', 'Running'))}</span><strong>${running}</strong></div>
      <div class="conversation-info-agent-activity-stat ${runtime && runtime.processing ? 'is-processing' : 'is-idle'}"><span>${escapeHtml(_label('conversation_info.agent_activity.summary_processing', 'Processing'))}</span><strong>${escapeHtml(processing)}</strong></div>
    </div>`;
  }

  function _renderAgentActivityRows(rows) {
    const fallbackLabels = {
      running: 'Running',
      current_recipient: 'Current recipient',
      joined: 'Joined',
      failed: 'Failed',
      completed: 'Completed',
    };
    return rows.map((row) => {
      const meta = [
        row.kind === 'commander' ? _label('chat.agent_status.kind.commander', 'Commander') : _label('chat.agent_status.kind.agent', 'Agent'),
        row.turnId ? _label('chat.agent_status.turn_id', 'turn {id}', { id: row.turnId }) : '',
        row.activeRecipient ? _label('chat.agent_status.floor', 'receives next message') : '',
      ].filter(Boolean).join(' · ');
      const activitySummary = row.lastMessage && (row.lastMessage.text || row.lastMessage.model_text)
        ? _compactText(String(row.lastMessage.text || row.lastMessage.model_text), 100)
        : row.state === 'running'
          ? _label('conversation_info.agent_activity.activity_running', 'Working on the current task')
          : row.activeRecipient
            ? _label('conversation_info.agent_activity.activity_recipient', 'Ready to receive the next message')
            : _label('conversation_info.agent_activity.activity_joined', 'Available in this conversation');
      const activityDetail = `<div class="conversation-info-agent-activity-detail-block is-summary"><div class="conversation-info-agent-activity-detail-title">${escapeHtml(_label('conversation_info.agent_activity.activity_summary', 'Activity Summary'))}</div><div>${escapeHtml(activitySummary)}</div></div>`;
      const technicalRows = row.p3394Data ? [
        row.p3394Data.runtime_kind ? `<div><strong>runtime</strong>: ${escapeHtml(String(row.p3394Data.runtime_kind))}</div>` : '',
        row.p3394Data.relationship ? `<div><strong>relationship</strong>: ${escapeHtml(String(row.p3394Data.relationship))}</div>` : '',
        row.p3394Data.speech_act ? `<div><strong>speech_act</strong>: ${escapeHtml(String(row.p3394Data.speech_act))}</div>` : '',
        row.p3394Data.session_role ? `<div><strong>session_role</strong>: ${escapeHtml(String(row.p3394Data.session_role))}</div>` : '',
        row.p3394Data.correlation_id ? `<div><strong>correlation_id</strong>: ${escapeHtml(String(row.p3394Data.correlation_id))}</div>` : '',
        row.p3394Data.message_type ? `<div><strong>message_type</strong>: ${escapeHtml(String(row.p3394Data.message_type))}</div>` : '',
        row.p3394Data.error ? `<div><strong>error</strong>: ${escapeHtml(String(row.p3394Data.error))}</div>` : '',
        row.p3394Data.detail ? `<div><strong>detail</strong>: ${escapeHtml(String(row.p3394Data.detail))}</div>` : '',
      ].filter(Boolean).join('') : '';
      const dispatchContext = row.lastDispatch ? `<div class="conversation-info-agent-activity-detail-block"><div class="conversation-info-agent-activity-detail-title">${escapeHtml(_label('conversation_info.agent_activity.dispatch_context', 'Dispatch Context'))}</div><div>${escapeHtml(_compactText(String(row.lastDispatch.text || row.lastDispatch.model_text || ''), 120))}</div><div><strong>source</strong>: ${escapeHtml(String(row.lastDispatch.from || ''))}</div><div><strong>attachments</strong>: ${escapeHtml(String(Array.isArray(row.lastDispatch.attachments) ? row.lastDispatch.attachments.length : 0))}</div></div>` : '';
      const traceItems = [
        row.lastDispatch ? 'task received' : '',
        row.turnId ? `execution started (${row.turnId})` : '',
        row.state === 'running' ? 'currently running' : '',
        row.lastMessage && row.state !== 'failed' ? 'produced a result' : '',
        row.p3394Data && row.p3394Data.error ? `failed: ${String(row.p3394Data.error)}` : '',
      ].filter(Boolean);
      const processingTrace = traceItems.length ? `<div class="conversation-info-agent-activity-detail-block"><div class="conversation-info-agent-activity-detail-title">${escapeHtml(_label('conversation_info.agent_activity.processing_trace', 'Processing Trace'))}</div>${traceItems.map((item) => `<div>${escapeHtml(item)}</div>`).join('')}</div>` : '';
      const technicalDetail = technicalRows ? `<div class="conversation-info-agent-activity-detail-block"><div class="conversation-info-agent-activity-detail-title">${escapeHtml(_label('conversation_info.agent_activity.technical_detail', 'Technical Detail'))}</div>${technicalRows}</div>` : '';
      return `<details class="conversation-info-agent-activity-row is-${escapeHtml(row.state)}" data-agent-activity-id="${escapeHtml(row.id)}">
        <summary>
          <div class="conversation-info-agent-activity-row-main">
            <div class="conversation-info-agent-activity-name">${escapeHtml(row.name)}</div>
            <div class="conversation-info-agent-activity-meta">${escapeHtml(meta)}</div>
            <div class="conversation-info-agent-activity-summary-line">${escapeHtml(activitySummary)}</div>
          </div>
          <span class="conversation-info-agent-activity-pill is-${escapeHtml(row.state)}">${escapeHtml(_label(`conversation_info.agent_activity.state.${row.state}`, fallbackLabels[row.state] || row.state))}</span>
        </summary>
        <div class="conversation-info-agent-activity-detail">${activityDetail}${dispatchContext}${processingTrace}${technicalDetail}</div>
      </details>`;
    }).join('');
  }

  function _renderAgentActivity() {
    const rows = _deriveAgentActivityRows(_snapshot);
    if (!rows.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.agent_activity.empty', 'No agents have joined this conversation yet.'))}</div>`;
    }
    return `<div class="conversation-info-agent-activity"><div class="conversation-info-agent-activity-toolbar"><div><div class="conversation-info-agent-activity-heading">${escapeHtml(_label('conversation_info.agent_activity.title', 'Agent Activity'))}</div><div class="conversation-info-agent-activity-subtitle">${escapeHtml(_label('conversation_info.agent_activity.subtitle', 'What agents are doing in this conversation'))}</div></div><button type="button" class="conversation-info-agent-activity-refresh" data-agent-activity-refresh title="${escapeHtml(_label('common.refresh', 'Refresh'))}" aria-label="${escapeHtml(_label('common.refresh', 'Refresh'))}">${_uiIcon('refresh-cw', 'conversation-info-agent-activity-refresh-icon')}</button></div><div class="conversation-info-agent-activity-layout"><div class="conversation-info-agent-activity-rail">${_renderAgentActivitySummary(rows, _snapshot.runtime || {})}</div><div class="conversation-info-agent-activity-list">${_renderAgentActivityRows(rows)}</div></div></div>`;
  }

  function _renderCollaborationTaskOverview(collaboration, runtime) {
    const status = collaboration && collaboration.status ? String(collaboration.status) : (runtime && runtime.processing ? 'running' : 'idle');
    const phase = collaboration && collaboration.phase ? String(collaboration.phase) : '';
    const objective = collaboration && collaboration.objective ? String(collaboration.objective) : _label('conversation_info.collaboration.empty', 'No active collaboration yet.');
    const stepCount = Array.isArray(collaboration && collaboration.steps) ? collaboration.steps.length : 0;
    const fallbackStatus = status === 'running' ? 'Running' : status === 'blocked' ? 'Blocked' : status === 'failed' ? 'Failed' : status === 'completed' ? 'Completed' : status === 'idle' ? 'Idle' : status;
    const stepLabel = stepCount
      ? _label('conversation_info.collaboration.step_count', '{count} steps', { count: stepCount })
      : '';
    const lifecycleStatus = runtime && runtime.kstarLifecycle && runtime.kstarLifecycle.status ? String(runtime.kstarLifecycle.status) : '';
    const hasKstarPreload = lifecycleStatus === 'preload_preview' || lifecycleStatus === 'authorized';
    return `<section class="conversation-info-collaboration-section conversation-info-collaboration-task-overview"><div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.collaboration.section_task_overview', 'Task Overview'))}</div><div class="conversation-info-collaboration-objective">${escapeHtml(objective)}</div><div class="conversation-info-collaboration-meta">${escapeHtml(_label(`conversation_info.collaboration.status.${status}`, fallbackStatus))}${phase ? ` · ${escapeHtml(phase)}` : ''}${stepLabel ? ` · ${escapeHtml(stepLabel)}` : ''}${hasKstarPreload ? ` · ${escapeHtml(_label('conversation_info.collaboration.task_preview_label', 'Preloaded, not active yet'))}` : ''}</div></section>`;
  }

  function _renderCollaborationAgentActivitySection() {
    const rows = _deriveAgentActivityRows(_snapshot);
    const body = rows.length
      ? `<div class="conversation-info-collaboration-agent-activity-body">${_renderAgentActivitySummary(rows, _snapshot.runtime || {})}${_renderAgentActivityRows(rows)}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.agent_activity.empty', 'No agents have joined this conversation yet.'))}</div>`;
    return `<section class="conversation-info-collaboration-section"><div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.collaboration.section_agent_activity', 'Agent Activity'))}</div>${body}</section>`;
  }

  function _collectCollaborationAttentionItems() {
    const items = [];
    for (const request of Array.isArray(_snapshot.wakeRequests) ? _snapshot.wakeRequests : []) {
      if (request && request.status === 'pending') {
        const agent = String(request.agent_name || request.agent_id || _label('chat.from_agent_unknown', 'Agent'));
        items.push({
          kind: 'wake',
          label: _label('conversation_info.collaboration.attention.wake', '{agent} needs wake approval', { agent }),
          target: {
            type: 'message',
            ref: String(request.id || ''),
            messageId: String(request.source_message_id || ''),
          },
        });
      }
    }
    const collaboration = _snapshot.collaboration || {};
    const conflictStatus = (status) => {
      const normalized = String(status || 'detected');
      const supported = ['detected', 'gathering_evidence', 'under_review', 'awaiting_user'];
      return supported.includes(normalized) ? normalized : 'detected';
    };
    for (const conflict of Array.isArray(collaboration.active_conflicts) ? collaboration.active_conflicts : []) {
      if (!conflict || !conflict.id) continue;
      const status = conflictStatus(conflict.status);
      const proposalCount = Array.isArray(conflict.proposal_ids) ? conflict.proposal_ids.length : 0;
      const affectedStepCount = Array.isArray(conflict.affected_step_ids) ? conflict.affected_step_ids.length : 0;
      items.push({
        kind: 'conflict',
        label: _label('conversation_info.collaboration.attention.conflict', 'Different views: {key}', { key: String(conflict.conflict_key || '') }),
        meta: _label('conversation_info.collaboration.attention.conflict_meta', '{proposals} proposals · {steps} affected steps · {status}', {
          proposals: proposalCount,
          steps: affectedStepCount,
          status: _label(`conversation_info.collaboration.conflict_status.${status}`, status),
        }),
        target: { type: 'chat', ref: String(conflict.id) },
      });
    }
    return items;
  }

  function _renderCollaborationAttentionSection(items) {
    const rows = Array.isArray(items) ? items : [];
    const body = rows.length
      ? rows.map((item) => `<div class="conversation-info-collaboration-attention-item" data-attention-kind="${escapeHtml(item.kind)}" data-open-in-chat="${escapeHtml(item.target.ref)}" data-open-in-chat-message-id="${escapeHtml(item.target.messageId || '')}"><div class="conversation-info-collaboration-attention-label">${escapeHtml(item.label)}</div>${item.meta ? `<div class="conversation-info-collaboration-attention-meta">${escapeHtml(item.meta)}</div>` : ''}<button type="button" class="conversation-info-collaboration-open-in-chat">${escapeHtml(_label('conversation_info.collaboration.open_in_chat', 'Open in chat'))}</button></div>`).join('')
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.collaboration.attention_none', 'Nothing needs attention right now.'))}</div>`;
    return `<section class="conversation-info-collaboration-section"><div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.collaboration.section_attention', 'Attention Needed'))}</div><div class="conversation-info-collaboration-attention-list">${body}</div></section>`;
  }

  function _renderCollaborationOverview() {
    const mateState = _snapshot.mate || {};
    if (!_snapshot.collaboration && !mateState.session && !mateState.loading && !mateState.error && !_deriveAgentActivityRows(_snapshot).length && !_collectCollaborationAttentionItems().length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.collaboration.empty', 'No active collaboration yet.'))}</div>`;
    }
    const collaboration = _snapshot.collaboration || null;
    const runtime = _snapshot.runtime || {};
    const attentionItems = _collectCollaborationAttentionItems();
    const mateHtml = (mateState.session || mateState.loading || mateState.error)
      ? _safeSection(() => _renderMateOverview(), `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.collaboration.load_failed', 'Could not load collaboration overview'))}</div>`)
      : '';
    return `<div class="conversation-info-collaboration"><div class="conversation-info-collaboration-header"><div class="conversation-info-collaboration-heading">${escapeHtml(_label('conversation_info.collaboration.title', 'Collaboration'))}</div><div class="conversation-info-collaboration-subtitle">${escapeHtml(_label('conversation_info.collaboration.subtitle', 'How this conversation is progressing'))}</div></div>${mateHtml}${_safeSection(() => _renderCollaborationTaskOverview(collaboration, runtime), `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.collaboration.load_failed', 'Could not load collaboration overview'))}</div>`)}${_safeSection(() => _renderCollaborationAgentActivitySection(), `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.collaboration.load_failed', 'Could not load collaboration overview'))}</div>`)}${_safeSection(() => _renderCollaborationAttentionSection(attentionItems), `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.collaboration.load_failed', 'Could not load collaboration overview'))}</div>`)}</div>`;
  }

  function _protocolEventData(event) {
    return event && event.data && typeof event.data === 'object' ? event.data : {};
  }

  function _protocolResult(event) {
    const data = _protocolEventData(event);
    if (data.ok === false || data.error || data.detail) return 'error';
    return 'success';
  }

  function _protocolRoleLabel(role) {
    const value = String(role || '');
    if (value === 'orkas_core') return _label('conversation_info.protocol.role.orkas_core', 'Orkas Core');
    if (value === 'external_expert') return _label('conversation_info.protocol.role.external_expert', 'External Expert');
    return value || _label('conversation_info.protocol.unknown', 'Unknown');
  }

  function _protocolResultLabel(result) {
    return result === 'error'
      ? _label('conversation_info.protocol.result.error', 'Error')
      : _label('conversation_info.protocol.result.success', 'Success');
  }

  function _protocolFilteredEvents() {
    const events = Array.isArray(_snapshot.protocolEvents) ? _snapshot.protocolEvents : [];
    return events.filter((event) => {
      const data = _protocolEventData(event);
      const agent = String(event && event.agent_id || '');
      const role = String(data.role || '');
      const result = _protocolResult(event);
      if (_protocolFilters.agent && _protocolFilters.agent !== agent) return false;
      if (_protocolFilters.role && _protocolFilters.role !== role) return false;
      if (_protocolFilters.result && _protocolFilters.result !== result) return false;
      return true;
    });
  }

  function _protocolFilterSelect(name, options, current) {
    return `<label class="conversation-info-protocol-filter"><span>${escapeHtml(_label(`conversation_info.protocol.filter.${name}`, name))}</span><select data-protocol-filter="${escapeHtml(name)}">${options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === current ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></label>`;
  }

  function _renderProtocolFilters(events) {
    const agents = Array.from(new Set(events.map((event) => String(event && event.agent_id || '')).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const roles = Array.from(new Set(events.map((event) => String(_protocolEventData(event).role || '')).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const agentOptions = [{ value: '', label: _label('conversation_info.protocol.filter_all_agents', 'All agents') }]
      .concat(agents.map((agent) => ({ value: agent, label: agent })));
    const roleOptions = [{ value: '', label: _label('conversation_info.protocol.filter_all_roles', 'All roles') }]
      .concat(roles.map((role) => ({ value: role, label: _protocolRoleLabel(role) })));
    const resultOptions = [
      { value: '', label: _label('conversation_info.protocol.filter_all_results', 'All results') },
      { value: 'success', label: _protocolResultLabel('success') },
      { value: 'error', label: _protocolResultLabel('error') },
    ];
    return `<div class="conversation-info-protocol-filters">${_protocolFilterSelect('agent', agentOptions, _protocolFilters.agent)}${_protocolFilterSelect('role', roleOptions, _protocolFilters.role)}${_protocolFilterSelect('result', resultOptions, _protocolFilters.result)}</div>`;
  }

  function _renderProtocolSummary(events) {
    const total = events.length;
    const success = events.filter((event) => _protocolResult(event) === 'success').length;
    const error = total - success;
    const core = events.filter((event) => _protocolEventData(event).role === 'orkas_core').length;
    const external = events.filter((event) => _protocolEventData(event).role === 'external_expert').length;
    return `<div class="conversation-info-protocol-summary">
      <div class="conversation-info-protocol-stat is-primary"><span>${escapeHtml(_label('conversation_info.protocol.stat_total', 'Calls'))}</span><strong>${total}</strong></div>
      <div class="conversation-info-protocol-stat"><span>${escapeHtml(_protocolResultLabel('success'))}</span><strong>${success}</strong></div>
      <div class="conversation-info-protocol-stat ${error ? 'is-error' : ''}"><span>${escapeHtml(_protocolResultLabel('error'))}</span><strong>${error}</strong></div>
      <div class="conversation-info-protocol-stat"><span>${escapeHtml(_protocolRoleLabel('orkas_core'))}</span><strong>${core}</strong></div>
      <div class="conversation-info-protocol-stat"><span>${escapeHtml(_protocolRoleLabel('external_expert'))}</span><strong>${external}</strong></div>
    </div>`;
  }

  function _protocolDetailRows(event) {
    const data = _protocolEventData(event);
    const rows = [
      ['message_type', data.message_type],
      ['correlation_id', data.correlation_id],
      ['canonical_session_id', data.canonical_session_id],
      ['session_role', data.session_role],
      ['uses_mate_skills', typeof data.uses_mate_skills === 'boolean' ? String(data.uses_mate_skills) : data.uses_mate_skills],
      ['relationship', data.relationship],
      ['speech_act', data.speech_act],
      ['runtime_kind', data.runtime_kind],
      ['error', data.error],
      ['detail', data.detail],
      ['workflow_run_id', data.collaboration && data.collaboration.workflow_run_id],
      ['context_id', data.collaboration && data.collaboration.context_id],
      ['context_revision', data.collaboration && data.collaboration.context_revision],
      ['step_id', data.collaboration && data.collaboration.step_id],
      ['conflict_ids', data.collaboration && Array.isArray(data.collaboration.conflict_ids) ? data.collaboration.conflict_ids.join(', ') : data.collaboration && data.collaboration.conflict_ids],
    ];
    return rows
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
      .map(([key, value]) => `<div><strong>${escapeHtml(key)}</strong>: ${escapeHtml(String(value))}</div>`)
      .join('');
  }

  function _renderProtocolEvents(events) {
    return events.map((event) => {
      const data = _protocolEventData(event);
      const result = _protocolResult(event);
      const agent = String(event && event.agent_id || _label('chat.from_agent_unknown', 'Agent'));
      const role = String(data.role || '');
      const runtime = String(data.runtime_kind || '');
      const meta = [
        _protocolRoleLabel(role),
        runtime,
        data.relationship ? String(data.relationship) : '',
        data.speech_act ? String(data.speech_act) : '',
      ].filter(Boolean).join(' · ');
      const detailRows = _protocolDetailRows(event);
      return `<details class="conversation-info-protocol-row is-${escapeHtml(result)}">
        <summary>
          <div class="conversation-info-protocol-row-main">
            <div class="conversation-info-protocol-agent">${escapeHtml(agent)}</div>
            <div class="conversation-info-protocol-meta">${escapeHtml(meta)}</div>
          </div>
          <span class="conversation-info-protocol-pill is-${escapeHtml(result)}">${escapeHtml(_protocolResultLabel(result))}</span>
        </summary>
        <div class="conversation-info-protocol-detail">${detailRows}</div>
      </details>`;
    }).join('');
  }

  function _renderProtocolInspector() {
    const events = Array.isArray(_snapshot.protocolEvents) ? _snapshot.protocolEvents : [];
    const header = `<div class="conversation-info-protocol-header"><div><div class="conversation-info-protocol-heading">${escapeHtml(_label('conversation_info.protocol.title', 'Protocol Inspector'))}</div><div class="conversation-info-protocol-subtitle">${escapeHtml(_label('conversation_info.protocol.subtitle', 'P3394 agent protocol events in this conversation'))}</div></div><button type="button" class="conversation-info-agent-activity-refresh" data-protocol-refresh title="${escapeHtml(_label('common.refresh', 'Refresh'))}" aria-label="${escapeHtml(_label('common.refresh', 'Refresh'))}">${_uiIcon('refresh-cw', 'conversation-info-agent-activity-refresh-icon')}</button></div>`;
    if (_snapshot.protocolError) {
      const message = _label('conversation_info.protocol.load_failed', 'Could not load protocol events: {reason}', { reason: _snapshot.protocolError });
      return `<div class="conversation-info-protocol">${header}<div class="conversation-info-empty is-small is-error">${escapeHtml(message)}</div></div>`;
    }
    if (!events.length) {
      return `<div class="conversation-info-protocol">${header}<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.protocol.empty', 'No P3394 protocol events yet.'))}</div></div>`;
    }
    const filtered = _protocolFilteredEvents();
    const list = filtered.length
      ? `<div class="conversation-info-protocol-list">${_renderProtocolEvents(filtered)}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.protocol.empty_filtered', 'No protocol events match the current filters.'))}</div>`;
    return `<div class="conversation-info-protocol">${header}${_renderProtocolSummary(events)}${_renderProtocolFilters(events)}${list}</div>`;
  }

  // 9.1 会话区域统一框架 · 右侧「本次携带」：
  // 本次运行（真实执行记录）、运行证明（ContextReuseReceipt）、
  // 本次 Context 引用、来源与边界。数据全部来自既有 IPC
  // （p3394.execution.list / p3394.contextReuseReceipt.read）与 snapshot；
  // 无执行记录时如实显示空态，不造数据、不显示技术噪声。
  function _latestCollaborationRef(events) {
    if (!Array.isArray(events)) return null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const data = _protocolEventData(events[i]);
      const collab = data && data.collaboration && typeof data.collaboration === 'object'
        ? data.collaboration
        : null;
      if (collab) return collab;
    }
    return null;
  }

  function _carriedStatusLabel(status) {
    const key = {
      running: 'conversation_info.carried.status.running',
      completed: 'conversation_info.carried.status.completed',
      failed: 'conversation_info.carried.status.failed',
      cancelled: 'conversation_info.carried.status.cancelled',
      timed_out: 'conversation_info.carried.status.timed_out',
      queued: 'conversation_info.carried.status.queued',
    }[String(status || '')];
    const fallback = {
      running: '运行中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      timed_out: '超时',
      queued: '排队',
    }[String(status || '')] || String(status || '');
    return key ? _label(key, fallback) : fallback;
  }

  function _carriedBoundaryLabel(boundary) {
    if (boundary === 'real') return _label('conversation_info.carried.boundary.real', '真实');
    if (boundary === 'degraded') return _label('conversation_info.carried.boundary.degraded', '降级');
    if (boundary === 'test-double') return _label('conversation_info.carried.boundary.test_double', '测试替身');
    return String(boundary || '');
  }

  function _carriedPermissionLabel(mode) {
    const s = String(mode || '').toLowerCase();
    if (s === 'read-only' || s === 'readonly') return _label('conversation_info.carried.permission.read_only', '只读');
    if (s === 'read_write' || s === 'readwrite') return _label('conversation_info.carried.permission.read_write', '可写');
    if (s === 'ask') return _label('conversation_info.carried.permission.ask', '逐次询问');
    return String(mode || '');
  }

  function _carriedTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function _carriedRunHtml(execution) {
    const statusRaw = String(execution && execution.status || '');
    const status = _carriedStatusLabel(statusRaw);
    const agent = String(execution && (execution.agentId || execution.cli)
      || _label('conversation_info.carried.executor_unknown', 'CogSeed'));
    const boundary = _carriedBoundaryLabel(execution && execution.boundary);
    const permission = _carriedPermissionLabel(execution && execution.permissionMode);
    const artifacts = Array.isArray(execution && execution.artifactIds) ? execution.artifactIds.length : 0;
    const time = _carriedTime(execution && execution.startedAt);
    const executionId = String(execution && execution.executionId || '');
    const receiptBtn = execution && execution.receiptId
      ? `<button type="button" class="conversation-info-carried-receipt-toggle" data-receipt-execution-id="${escapeHtml(executionId)}">${escapeHtml(_label('conversation_info.carried.receipt_view', '查看回执'))}</button>`
      : '';
    return `<div class="conversation-info-carried-run is-${escapeHtml(statusRaw) || 'unknown'}">
      <div class="conversation-info-carried-run-head">
        <span class="conversation-info-carried-run-agent">${escapeHtml(agent)}</span>
        <span class="conversation-info-carried-run-status is-${escapeHtml(statusRaw) || 'unknown'}">${escapeHtml(status)}</span>
      </div>
      <div class="conversation-info-carried-run-meta">
        ${permission ? `<span>${escapeHtml(_label('conversation_info.carried.permission_label', '权限'))} · ${escapeHtml(permission)}</span>` : ''}
        ${boundary ? `<span>${escapeHtml(boundary)}</span>` : ''}
        ${artifacts ? `<span>${artifacts} ${escapeHtml(_label('conversation_info.carried.artifacts', '个产物'))}</span>` : ''}
        ${time ? `<span>${escapeHtml(time)}</span>` : ''}
      </div>
      <div class="conversation-info-carried-run-receipt" data-receipt-container="${escapeHtml(executionId)}" hidden></div>
      ${receiptBtn}
    </div>`;
  }

  function _renderReceiptDetailHtml(receipt) {
    const rows = [];
    if (receipt && receipt.sourceSessionId) rows.push([_label('conversation_info.carried.receipt_source', '来源'), String(receipt.sourceSessionId)]);
    if (receipt && receipt.targetSessionId) rows.push([_label('conversation_info.carried.receipt_target', '目标'), String(receipt.targetSessionId)]);
    if (Array.isArray(receipt && receipt.reusedRefs) && receipt.reusedRefs.length) {
      rows.push([_label('conversation_info.carried.receipt_reused', '复用引用'), receipt.reusedRefs.join(' · ')]);
    }
    if (Array.isArray(receipt && receipt.omittedRefs) && receipt.omittedRefs.length) {
      rows.push([_label('conversation_info.carried.receipt_omitted', '未复用'), receipt.omittedRefs.join(' · ')]);
    }
    if (receipt && receipt.permissionMode) rows.push([_label('conversation_info.carried.receipt_permission', '权限'), _carriedPermissionLabel(receipt.permissionMode)]);
    if (receipt && receipt.boundary) rows.push([_label('conversation_info.carried.receipt_boundary', '边界'), _carriedBoundaryLabel(receipt.boundary)]);
    if (receipt && receipt.status) rows.push([_label('conversation_info.carried.receipt_status', '状态'), String(receipt.status)]);
    if (!rows.length) return `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.carried.receipt_empty', '回执内容为空。'))}</div>`;
    return `<dl class="conversation-info-carried-rows">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
  }

  function _renderCarried() {
    const events = Array.isArray(_snapshot.protocolEvents) ? _snapshot.protocolEvents : [];
    const executions = Array.isArray(_snapshot.executions) ? _snapshot.executions : [];
    const collab = _latestCollaborationRef(events);
    const title = _currentConversationTitle();

    // 本次运行：真实执行记录，按开始时间倒序。
    const sorted = executions.slice().sort((a, b) => {
      const at = a && a.startedAt ? String(a.startedAt) : '';
      const bt = b && b.startedAt ? String(b.startedAt) : '';
      return bt.localeCompare(at);
    });
    const runsHtml = sorted.length
      ? `<div class="conversation-info-carried-runs">${sorted.map(_carriedRunHtml).join('')}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.carried.runs_empty', '本会话暂无执行记录。'))}</div>`;

    // 本次 Context：执行记录携带的 contextId + 协议协作引用（workflow / step）。
    const contextIds = [];
    sorted.forEach((execution) => {
      if (execution && execution.contextId && !contextIds.includes(execution.contextId)) {
        contextIds.push(String(execution.contextId));
      }
    });
    const contextRows = [];
    if (collab && collab.workflow_run_id) contextRows.push([_label('conversation_info.carried.run', '运行'), String(collab.workflow_run_id)]);
    if (collab && collab.step_id) contextRows.push([_label('conversation_info.carried.step', '步骤'), String(collab.step_id)]);
    if (contextIds.length) contextRows.push([_label('conversation_info.carried.context_id', 'Context ID'), contextIds.join(' · ')]);
    const contextHtml = contextRows.length
      ? `<dl class="conversation-info-carried-rows">${contextRows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.carried.context_empty', '本会话暂无 Context 投影记录；接续不会凭空生成正式资产。'))}</div>`;

    // 来源与边界：会话来源 + 最近一次执行的执行方 / 边界 / 真实权限模式。
    const latestRun = sorted[0] || null;
    const boundaryRows = [[_label('conversation_info.carried.source', '来源'), title]];
    if (latestRun && (latestRun.agentId || latestRun.cli)) {
      boundaryRows.push([_label('conversation_info.carried.executor', '执行方'), String(latestRun.agentId || latestRun.cli)]);
    }
    if (latestRun && latestRun.boundary) {
      boundaryRows.push([_label('conversation_info.carried.boundary_label', '边界'), _carriedBoundaryLabel(latestRun.boundary)]);
    }
    const boundaryHtml = `<dl class="conversation-info-carried-rows">${boundaryRows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
    const permissionNote = latestRun && latestRun.permissionMode
      ? _label('conversation_info.carried.permission_note', '本会话最近一次执行的权限模式：{mode}', { mode: _carriedPermissionLabel(latestRun.permissionMode) })
      : _label('conversation_info.carried.permission', '只读 · 仅本次任务；外发、删除、扩权或正式资产变更会单独确认。');

    return `<div class="conversation-info-carried">
      <div class="conversation-info-carried-header">
        <div class="conversation-info-carried-heading">${escapeHtml(_label('conversation_info.carried.title', '本次携带'))}</div>
        <div class="conversation-info-carried-subtitle">${escapeHtml(_label('conversation_info.carried.subtitle', '本次最小 Context、来源边界与运行证明'))}</div>
      </div>
      <section class="conversation-info-carried-section"><div class="conversation-info-carried-section-label">${escapeHtml(_label('conversation_info.carried.runs', '本次运行'))}</div>${runsHtml}</section>
      <section class="conversation-info-carried-section"><div class="conversation-info-carried-section-label">${escapeHtml(_label('conversation_info.carried.context', '本次 Context'))}</div>${contextHtml}</section>
      <section class="conversation-info-carried-section"><div class="conversation-info-carried-section-label">${escapeHtml(_label('conversation_info.carried.boundary', '来源与边界'))}</div>${boundaryHtml}<div class="conversation-info-carried-permission">${_uiIcon('shield-check', 'conversation-info-carried-permission-icon')}<span>${escapeHtml(permissionNote)}</span></div></section>
    </div>`;
  }

  function _renderBody() {
    _closeFileMenu();
    const body = document.getElementById('conversation-info-body');
    if (!body) return;
    if (!_cid) {
      body.innerHTML = `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.no_conversation', 'Open a conversation to see details'))}</div>`;
      _refreshTabCounts();
      return;
    }
    if (_loading) {
      body.innerHTML = `<div class="conversation-info-empty">${escapeHtml(_label('common.loading', 'Loading…'))}</div>`;
      _refreshTabCounts();
      return;
    }
    if (_error) {
      body.innerHTML = `<div class="conversation-info-empty is-error">${escapeHtml(_label('conversation_info.load_failed', 'Could not load conversation info', { reason: _error }))}</div>`;
      _refreshTabCounts();
      return;
    }
    if (_activeTab === 'attachments') body.innerHTML = _renderAttachments();
    else if (_activeTab === 'collaboration') body.innerHTML = _renderCollaborationOverview();
    else if (_activeTab === 'protocol') body.innerHTML = _renderProtocolInspector();
    else if (_activeTab === 'carried') body.innerHTML = _renderCarried();
    else body.innerHTML = _renderFiles();
    // Hydrate any data-ui-icon placeholders that the renderers emitted.
    if (typeof window !== 'undefined' && typeof window.hydrateUiIcons === 'function') {
      window.hydrateUiIcons(body);
    }
    _refreshTabCounts();
  }

  function _syncChrome() {
    const panel = document.getElementById('conversation-info-panel');
    const toggle = document.getElementById('conversation-info-toggle');
    if (panel) panel.hidden = !_open;
    if (toggle) {
      toggle.classList.toggle('is-active', _open);
      toggle.setAttribute('aria-expanded', _open ? 'true' : 'false');
    }
    document.querySelectorAll('.conversation-info-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.infoTab === _activeTab);
    });
  }

  function _beginLoading(source, seq) {
    _loading = true;
    _loadingSource = source || '';
    _loadingSeq = seq || 0;
    _renderBody();
  }

  function _clearLoading(source, seq, opts = {}) {
    if (!_loading || _loadingSource !== source) return false;
    if (opts.clearAnyForSource === true || _loadingSeq === seq) {
      _loading = false;
      _loadingSource = '';
      _loadingSeq = 0;
      return true;
    }
    return false;
  }

  function _resetLoading() {
    _loading = false;
    _loadingSource = '';
    _loadingSeq = 0;
  }

  function _setOpen(next) {
    _open = !!next;
    _syncChrome();
    if (_open) refresh(_cid);
  }

  async function refresh(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_seq;
    const silent = !!opts.silent;
    if (silent && _loadingSource === 'full') {
      _clearLoading('full', seq, { clearAnyForSource: true });
      _renderBody();
    }
    if (!silent) {
      _error = '';
      _beginLoading('full', seq);
    }
    try {
      const snapshot = await _load(target);
      if (seq !== _seq || target !== _cid) return;
      _snapshot = { ...snapshot, mate: _snapshot.mate || { session: null, collaboration: null, sessions: [], loading: false, error: '' } };
      _error = '';
      void _primeMateProjection(target, { render: silent }).catch(() => {});
    } catch (err) {
      if (seq !== _seq || target !== _cid) return;
      _error = (err && err.message) || String(err);
    } finally {
      if (seq === _seq && target === _cid) {
        _clearLoading('full', seq, { clearAnyForSource: silent });
        _renderBody();
      }
    }
  }

  async function refreshAttachments(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const items = Array.isArray(opts.items) ? _normalizeAttachmentItems(opts.items) : null;
    if (items) {
      _snapshot = { ..._snapshot, attachments: items };
      if (_activeTab === 'attachments') _renderBody();
      return;
    }

    const seq = ++_attachmentSeq;
    try {
      const data = await _fetchJson(`/api/conversations/${encodeURIComponent(target)}/attachments`);
      if (seq !== _attachmentSeq || target !== _cid) return;
      _snapshot = {
        ..._snapshot,
        attachments: Array.isArray(data.items) ? data.items : [],
      };
      if (_activeTab === 'attachments') _renderBody();
    } catch (err) {
      _infoLog.warn('attachment refresh failed', { cid: target, error: err && err.message });
    }
  }

  async function refreshFiles(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_fileSeq;
    const silent = !!opts.silent;
    if (silent && _loadingSource === 'files') {
      _clearLoading('files', seq, { clearAnyForSource: true });
      if (_activeTab === 'files') _renderBody();
    }
    if (!silent && _activeTab === 'files') {
      _error = '';
      _beginLoading('files', seq);
    }
    try {
      const partial = await _loadFileSnapshot(target);
      if (seq !== _fileSeq || target !== _cid) return;
      _snapshot = { ..._snapshot, ...partial };
      _error = '';
      if (_activeTab === 'files') _renderBody();
    } catch (err) {
      if (seq !== _fileSeq || target !== _cid) return;
      _infoLog.warn('file refresh failed', { cid: target, error: err && err.message });
      if (!silent) {
        _error = (err && err.message) || String(err);
        if (_activeTab === 'files') _renderBody();
      }
    } finally {
      if (seq === _fileSeq && target === _cid) {
        _clearLoading('files', seq, { clearAnyForSource: silent });
        if (_activeTab === 'files') _renderBody();
      }
    }
  }

  function bind(cid) {
    _cid = cid || null;
    _open = false;
    _snapshot = { conversation: null, history: [], files: [], fileRoot: '', fileRootExists: false, filesTruncated: false, filesCount: 0, filesScanSkipped: false, syncEnabled: false, attachments: [], runtime: null, actors: [], collaboration: null, mate: { session: null, collaboration: null, sessions: [], loading: false, error: '' }, wakeRequests: [], protocolEvents: [], protocolError: '' };
    _protocolFilters.agent = '';
    _protocolFilters.role = '';
    _protocolFilters.result = '';
    _error = '';
    _resetLoading();
    _seq++;
    _activitySeq++;
    _fileSeq++;
    _attachmentSeq++;
    _syncChrome();
    _renderBody();
    if (_open && _cid) refresh(_cid);
  }

  function unbind() {
    bind(null);
  }

  function _openFile(absPath) {
    if (!absPath) return;
    const name = _baseName(absPath);
    const opts = _cid ? { cid: _cid } : undefined;
    // Prefer the side pane for renderable kinds; `openSideBrowser` returning
    // false is the signal that this kind belongs to the fullscreen viewer.
    if (typeof openSideBrowser === 'function' && openSideBrowser(absPath, name, opts || {})) return;
    if (typeof openChatFileViewer !== 'function') return;
    openChatFileViewer(absPath, name, opts);
  }

  function _attachmentEntriesForPath(absPath, kind) {
    if (kind !== 'dir') {
      return [{ path: absPath, name: _baseName(absPath) }];
    }
    return _collectVisibleFiles()
      .filter((file) => file && file.path && _pathIsSameOrInside(absPath, file.path))
      .map((file) => ({ path: file.path, name: _baseName(file.path) }));
  }

  async function _fallbackImportAttachments(entries, cidOverride) {
    const targetCid = cidOverride || _cid;
    if (!targetCid) return;
    const rejected = [];
    const imported = [];
    for (const entry of entries) {
      try {
        const res = await apiFetch(`/api/conversations/${encodeURIComponent(targetCid)}/attachments/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: entry.path, name: entry.name }),
        });
        const data = await res.json();
        if (!data || !data.ok) {
          rejected.push(_label('chat.attach_upload_fail', '{name} ({reason})', {
            name: entry.name,
            reason: (data && data.error) || _label('chat.attach_upload_generic_fail', 'Upload failed'),
          }));
          continue;
        }
        if (data.info) imported.push(data.info);
      } catch (err) {
        rejected.push(_label('chat.attach_upload_fail', '{name} ({reason})', {
          name: entry.name,
          reason: String(err && err.message || err),
        }));
      }
    }
    if (imported.length) await refreshAttachments(targetCid);
    if (rejected.length) {
      await uiAlert(_label('chat.attach_rejected_prefix', 'The following files could not be uploaded:\n\n{list}', {
        list: rejected.join('\n'),
      }));
    }
  }

  function _fileActionPayload(absPath, cidOverride) {
    const payload = { path: absPath };
    const targetCid = cidOverride || _cid;
    if (targetCid) payload.cid = targetCid;
    return payload;
  }

  function _ensureFileMenu() {
    let menu = document.getElementById('conversation-info-file-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'conversation-info-file-menu';
      menu.className = 'ctx-row-menu conversation-info-file-menu';
      menu.style.display = 'none';
      document.body.appendChild(menu);
    }
    return menu;
  }

  function _positionFileMenu(menuEl, anchorEl) {
    menuEl.style.display = 'block';
    menuEl.style.left = '-9999px';
    menuEl.style.top = '-9999px';
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    let left = rect.right - menuRect.width;
    if (left < margin) left = margin;
    if (left + menuRect.width > window.innerWidth - margin) {
      left = window.innerWidth - menuRect.width - margin;
    }
    const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
    const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  }

  function _closeFileMenu() {
    const menu = document.getElementById('conversation-info-file-menu');
    if (!menu || !menu.style) return;
    menu.style.display = 'none';
    if (menu.dataset) {
      delete menu.dataset.filePath;
      delete menu.dataset.fileName;
    }
    document.querySelectorAll('.conversation-info-file.is-menu-open, .conversation-info-dir-summary.is-menu-open, .chat-msg-produced-item.is-menu-open')
      .forEach((row) => row.classList && row.classList.remove && row.classList.remove('is-menu-open'));
    if (document.removeEventListener) {
      document.removeEventListener('mousedown', _onFileMenuOutside, true);
      document.removeEventListener('keydown', _onFileMenuKeyDown, true);
    }
    if (window.removeEventListener) window.removeEventListener('resize', _closeFileMenu);
    if (_fileMenuScrollHost && _fileMenuScrollHost.removeEventListener) {
      _fileMenuScrollHost.removeEventListener('scroll', _closeFileMenu);
    }
    _fileMenuScrollHost = null;
  }

  function _onFileMenuOutside(ev) {
    const menu = document.getElementById('conversation-info-file-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(ev.target)) return;
    if (ev.target && ev.target.closest && ev.target.closest('.conversation-info-file-menu-btn, .chat-msg-produced-menu-btn')) return;
    _closeFileMenu();
  }

  function _onFileMenuKeyDown(ev) {
    if (ev.key === 'Escape') _closeFileMenu();
  }

  async function _openFileMenu(anchorBtn, absPath, displayName, kind, options = {}) {
    if (!anchorBtn || !absPath) return;
    const menu = _ensureFileMenu();
    const sameFile = menu.dataset.filePath === absPath && menu.style.display !== 'none';
    if (sameFile) { _closeFileMenu(); return; }
    _closeFileMenu();

    const name = displayName || _baseName(absPath);
    const entryKind = kind === 'dir' ? 'dir' : 'file';
    const targetCid = options.cid || _cid;
    const projectScoped = _isProjectConversation(targetCid);
    const revealLabel = _label('conversation_info.file_reveal_action', 'Show in folder');
    const addLabel = _label('conversation_info.file_add_to_chat_action', 'Add to chat');
    const addLibraryLabel = _label('conversation_info.file_add_to_library_action', 'Add to Library');
    const deleteLabel = _label('common.delete', 'Delete');
    const allowedActions = Array.isArray(options.allowedActions)
      ? new Set(options.allowedActions.map((action) => String(action)))
      : null;
    const actionAllowed = (action) => !allowedActions || allowedActions.has(action);
    const revealItem = actionAllowed('reveal')
      ? `<div class="ctx-row-menu-item" data-action="reveal">${escapeHtml(revealLabel)}</div>`
      : '';
    const addItem = actionAllowed('add-to-chat') && entryKind === 'file' && _canAddEntryToChat(name || absPath)
      ? `<div class="ctx-row-menu-item" data-action="add-to-chat">${escapeHtml(addLabel)}</div>`
      : '';
    const addLibraryItem = actionAllowed('add-to-library') && entryKind === 'file' && _canAddEntryToLibrary(name || absPath, projectScoped)
      ? `<div class="ctx-row-menu-item" data-action="add-to-library">${escapeHtml(addLibraryLabel)}</div>`
      : '';
    const deleteItem = actionAllowed('delete')
      ? `<div class="ctx-row-menu-item is-danger" data-action="delete">${escapeHtml(deleteLabel)}</div>`
      : '';
    menu.innerHTML = `
      ${revealItem}
      ${addLibraryItem}
      ${addItem}
      ${deleteItem}
    `;
    menu.dataset.filePath = absPath;
    menu.dataset.fileName = name;
    menu.dataset.entryKind = entryKind;
    const row = anchorBtn.closest('.conversation-info-file, .conversation-info-dir-summary, .chat-msg-produced-item');
    if (row) row.classList.add('is-menu-open');
    _positionFileMenu(menu, anchorBtn);
    _fileMenuScrollHost = anchorBtn.closest('.chat-msg-produced');
    if (_fileMenuScrollHost && _fileMenuScrollHost.addEventListener) {
      _fileMenuScrollHost.addEventListener('scroll', _closeFileMenu, { passive: true });
    }

    menu.querySelectorAll('.ctx-row-menu-item').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = item.dataset.action || '';
        _closeFileMenu();
        await _runFileMenuAction(action, absPath, name, entryKind, {
          cid: targetCid,
          onDeleted: typeof options.onDeleted === 'function' ? options.onDeleted : null,
        });
      });
    });
    document.addEventListener('mousedown', _onFileMenuOutside, true);
    document.addEventListener('keydown', _onFileMenuKeyDown, true);
    window.addEventListener('resize', _closeFileMenu);
  }

  async function _revealEntry(absPath, cidOverride) {
    try {
      const res = await window.cogseed.invoke('workspace.revealPath', _fileActionPayload(absPath, cidOverride));
      if (!res || !res.ok) {
        await uiAlert(_label('conversation_info.file_reveal_failed', 'Could not show in folder: {reason}', {
          reason: (res && res.error) || 'failed',
        }));
      }
    } catch (err) {
      await uiAlert(_label('conversation_info.file_reveal_failed', 'Could not show in folder: {reason}', {
        reason: String(err && err.message || err),
      }));
    }
  }

  async function _addEntryToChat(absPath, kind, cidOverride) {
    const targetCid = cidOverride || _cid;
    if (!targetCid) return;
    const entries = _attachmentEntriesForPath(absPath, kind);
    if (!entries.length) {
      await uiAlert(_label('conversation_info.dir_add_empty', 'No files in this folder can be added'));
      return;
    }
    if (typeof window.addChatAttachmentsFromPaths === 'function') {
      await window.addChatAttachmentsFromPaths(targetCid, entries);
      return;
    }
    await _fallbackImportAttachments(entries, targetCid);
  }

  async function _addEntryToLibrary(absPath, cidOverride) {
    if (!_canAddEntryToLibrary(absPath)) return;
    try {
      const res = await window.cogseed.invoke('library.importProduced', _fileActionPayload(absPath, cidOverride));
      if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
      if (res.scope === 'global' && typeof currentView !== 'undefined' && currentView === 'contexts' && typeof loadContexts === 'function') {
        loadContexts();
      }
    } catch (err) {
      await uiAlert(_label('conversation_info.file_add_to_library_failed', 'Add to Library failed: {reason}', {
        reason: String(err && err.message || err),
      }));
    }
  }

  async function _deleteEntry(absPath, displayName, kind, options = {}) {
    const name = displayName || _baseName(absPath);
    const isDir = kind === 'dir';
    const confirmTitle = isDir
      ? _label('conversation_info.dir_delete_confirm_title', 'Delete folder')
      : _label('conversation_info.file_delete_confirm_title', 'Delete file');
    const confirmMessage = isDir
      ? _label('conversation_info.dir_delete_confirm_msg', 'Delete folder "{name}" and everything inside it?', { name })
      : _label('conversation_info.file_delete_confirm_msg', 'Delete "{name}"?', { name });
    const dangerLabel = _label('common.delete', 'Delete');
    const ok = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({ title: confirmTitle, message: confirmMessage, dangerLabel })
      : await uiConfirm(confirmMessage);
    if (!ok) return;

    try {
      const res = await window.cogseed.invoke('workspace.deletePath', _fileActionPayload(absPath, options.cid));
      if (!res || !res.ok) {
        await uiAlert(_label(isDir ? 'conversation_info.dir_delete_failed' : 'conversation_info.file_delete_failed', 'Could not delete: {reason}', {
          reason: (res && res.error) || 'failed',
        }));
        return;
      }
      const deletedPath = _normalizePath(res.path || absPath);
      _locallyDeletedPaths.add(deletedPath);
      _snapshot = {
        ..._snapshot,
        files: (_snapshot.files || []).filter((item) => !_pathIsSameOrInside(deletedPath, item && item.path)),
      };
      _renderBody();
      if (_cid) refresh(_cid, { silent: true });
      if (typeof options.onDeleted === 'function') options.onDeleted(deletedPath);
    } catch (err) {
      await uiAlert(_label(isDir ? 'conversation_info.dir_delete_failed' : 'conversation_info.file_delete_failed', 'Could not delete: {reason}', {
        reason: String(err && err.message || err),
      }));
    }
  }

  async function _runFileMenuAction(action, absPath, displayName, kind, options = {}) {
    if (action === 'reveal') return _revealEntry(absPath, options.cid);
    if (action === 'add-to-library') return _addEntryToLibrary(absPath, options.cid);
    if (action === 'add-to-chat') return _addEntryToChat(absPath, kind, options.cid);
    if (action === 'delete') return _deleteEntry(absPath, displayName, kind, options);
  }

  async function _openAttachment(name) {
    if (!_cid || !name || typeof openChatFileViewer !== 'function') return;
    try {
      const res = await window.cogseed.invoke('attachments.absPath', { cid: _cid, name });
      if (!res || !res.ok || !res.path) {
        _infoLog.warn('attachment preview resolve failed', { cid: _cid, name, error: res && res.error });
        const message = _label('chat.file_missing_toast', 'The file no longer exists.', { name });
        if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
        else if (typeof uiAlert === 'function') await uiAlert(message);
        return;
      }
      openChatFileViewer(res.path, name, { cid: _cid });
    } catch (err) {
      _infoLog.warn('attachment preview threw', { cid: _cid, name, error: String(err && err.message || err) });
      const message = _label('chat.file_missing_toast', 'The file no longer exists.', { name });
      if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
      else if (typeof uiAlert === 'function') await uiAlert(message);
    }
  }

  function _bindDom() {
    const toggle = document.getElementById('conversation-info-toggle');
    const close = document.getElementById('conversation-info-close');
    const body = document.getElementById('conversation-info-body');
    if (toggle && toggle.dataset.bound !== '1') {
      toggle.dataset.bound = '1';
      toggle.addEventListener('click', () => _setOpen(!_open));
    }
    if (close && close.dataset.bound !== '1') {
      close.dataset.bound = '1';
      close.addEventListener('click', () => _setOpen(false));
    }
    document.querySelectorAll('.conversation-info-tab').forEach((tab) => {
      if (tab.dataset.bound === '1') return;
      tab.dataset.bound = '1';
      tab.addEventListener('click', () => {
        _activeTab = tab.dataset.infoTab || 'files';
        _syncChrome();
        _renderBody();
      });
    });
    if (body && body.dataset.bound !== '1') {
      body.dataset.bound = '1';
      body.addEventListener('click', (ev) => {
        const openInChat = ev.target.closest('.conversation-info-collaboration-open-in-chat');
        if (openInChat) {
          ev.preventDefault();
          ev.stopPropagation();
          const item = openInChat.closest('[data-attention-kind][data-open-in-chat]');
          if (item && typeof window.focusConversationAttention === 'function') {
            window.focusConversationAttention(
              item.dataset.attentionKind || '',
              item.dataset.openInChat || '',
              item.dataset.openInChatMessageId || '',
            );
          }
          _setOpen(false);
          return;
        }
        const activityRefresh = ev.target.closest('[data-agent-activity-refresh]');
        if (activityRefresh) {
          ev.preventDefault();
          ev.stopPropagation();
          void refresh(_cid);
          return;
        }
        const protocolRefresh = ev.target.closest('[data-protocol-refresh]');
        if (protocolRefresh) {
          ev.preventDefault();
          ev.stopPropagation();
          void refresh(_cid);
          return;
        }
        // 9.1 右侧「本次携带」：点击「查看回执」→ 读取该执行的
        // ContextReuseReceipt（IPC 已存在）并展开明细。
        const receiptToggle = ev.target.closest('[data-receipt-execution-id]');
        if (receiptToggle) {
          ev.preventDefault();
          ev.stopPropagation();
          const executionId = receiptToggle.dataset.receiptExecutionId || '';
          const runEl = receiptToggle.closest('.conversation-info-carried-run');
          const container = runEl && runEl.querySelector('[data-receipt-container]');
          if (!executionId || !container) return;
          if (container.dataset.loaded === '1') {
            container.hidden = !container.hidden;
            return;
          }
          receiptToggle.disabled = true;
          const invoke = window && window.cogseed && typeof window.cogseed.invoke === 'function'
            ? window.cogseed.invoke.bind(window.cogseed)
            : null;
          if (!invoke) return;
          invoke('p3394.contextReuseReceipt.read', { executionId })
            .then((res) => {
              const receipt = res && res.receipt ? res.receipt : null;
              if (!receipt) return;
              container.innerHTML = _renderReceiptDetailHtml(receipt);
              container.dataset.loaded = '1';
              container.hidden = false;
              receiptToggle.textContent = _label('conversation_info.carried.receipt_hide', '收起回执');
            })
            .catch((err) => {
              _infoLog.warn('carried receipt read failed', { executionId, error: err && err.message });
              container.innerHTML = `<div class="conversation-info-empty is-small is-error">${escapeHtml(_label('conversation_info.carried.receipt_failed', '回执读取失败。'))}</div>`;
              container.hidden = false;
              receiptToggle.disabled = false;
            });
          return;
        }
        const mateAction = ev.target.closest('[data-mate-action]');
        if (mateAction && _snapshot.mate && _snapshot.mate.session) {
          ev.preventDefault();
          ev.stopPropagation();
          const action = mateAction.dataset.mateAction;
          const taskId = mateAction.dataset.mateTaskId || '';
          const requestId = mateAction.dataset.mateRequestId || '';
          if (action === 'abort' && taskId) {
            void window.cogseed.invoke('mate_agent.task.abort', { taskId }).then(() => refresh(_cid));
          } else if (action === 'retry' && taskId && requestId) {
            void window.cogseed.invoke('mate_agent.task.retry', { taskId, requestId }).then(() => refresh(_cid));
          } else if (action === 'resume' && taskId && requestId) {
            void window.cogseed.invoke('mate_agent.task.resume', { taskId, requestId, continuation: (_snapshot.mate.session && _snapshot.mate.session.collaboration && _snapshot.mate.session.collaboration.task && _snapshot.mate.session.collaboration.task.title) || 'Resume task.' }).then(() => refresh(_cid));
          }
          return;
        }
        const ciAttach = ev.target.closest('.ci-attach-row[data-attachment-name]');
        if (ciAttach) {
          ev.preventDefault();
          _openAttachment(ciAttach.dataset.attachmentName || '');
          return;
        }
        const menuBtn = ev.target.closest('.conversation-info-file-menu-btn[data-entry-path]');
        if (menuBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          _openFileMenu(
            menuBtn,
            menuBtn.dataset.entryPath || '',
            menuBtn.dataset.entryName || '',
            menuBtn.dataset.entryKind || 'file',
          );
          return;
        }
        const file = ev.target.closest('.conversation-info-file[data-file-path]');
        if (file) {
          ev.preventDefault();
          _openFile(file.dataset.filePath || '');
          return;
        }
        const attachment = ev.target.closest('.conversation-info-attachment[data-attachment-name]');
        if (attachment) {
          ev.preventDefault();
          _openAttachment(attachment.dataset.attachmentName || '');
        }
      });
      body.addEventListener('keydown', (ev) => {
        const file = ev.target.closest('.conversation-info-file[data-file-path]');
        if (!file || ev.target.closest('.conversation-info-file-menu-btn')) return;
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        _openFile(file.dataset.filePath || '');
      });
      body.addEventListener('change', (ev) => {
        const select = ev.target && ev.target.closest ? ev.target.closest('[data-protocol-filter]') : null;
        if (!select) return;
        const name = select.dataset.protocolFilter || '';
        if (!Object.prototype.hasOwnProperty.call(_protocolFilters, name)) return;
        _protocolFilters[name] = String(select.value || '');
        _renderBody();
      });
      body.addEventListener('dragstart', (ev) => {
        const file = ev.target.closest('.conversation-info-file[data-file-path]');
        if (!file || !ev.dataTransfer) return;
        const path = file.dataset.filePath || '';
        if (!path) return;
        const name = (file.querySelector('.conversation-info-file-name')?.textContent || _baseName(path)).trim();
        try {
          ev.dataTransfer.effectAllowed = 'copy';
          ev.dataTransfer.setData('application/x-orkas-file', JSON.stringify({ path, name }));
          ev.dataTransfer.setData('text/plain', path);
        } catch (_) { /* best-effort */ }
      });
      body.addEventListener('scroll', _closeFileMenu);
    }
    _syncChrome();
    _renderBody();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bindDom, { once: true });
  } else {
    _bindDom();
  }
  window.addEventListener('i18n-change', () => {
    _syncChrome();
    _renderBody();
  });

  // External callers (chat header "详情" button, i18n-change listeners) read
  // open/close/toggle via this surface. Keeping the imperative variant +
  // `openAndSetTab(tab)` shorthand instead of exposing _setOpen +
  // _setActiveTab separately keeps the contract narrow.
  function open()  { _setOpen(true); }
  function close() { _setOpen(false); }
  function toggle() { _setOpen(!_open); }
  function openAgentActivity(cid) {
    if (cid) _cid = cid;
    openAndSetTab('collaboration');
  }
  function openCollaboration(cid) {
    if (cid) _cid = cid;
    openAndSetTab('collaboration');
  }
  function openProtocol(cid) {
    if (cid) _cid = cid;
    openAndSetTab('protocol');
  }
  function setProtocolFilters(filters) {
    if (!filters || typeof filters !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(filters, 'agent')) _protocolFilters.agent = String(filters.agent || '');
    if (Object.prototype.hasOwnProperty.call(filters, 'role')) _protocolFilters.role = String(filters.role || '');
    if (Object.prototype.hasOwnProperty.call(filters, 'result')) _protocolFilters.result = String(filters.result || '');
    _renderBody();
  }
  function openAndSetTab(tab) {
    _activeTab = tab || 'files';
    _setOpen(true);
    _syncChrome();
    _renderBody();
  }
  function openFileMenu(anchorBtn, absPath, displayName, options = {}) {
    return _openFileMenu(anchorBtn, absPath, displayName, 'file', options);
  }

  return {
    bind,
    unbind,
    refresh,
    refreshAgentActivity,
    refreshFiles,
    refreshAttachments,
    open,
    close,
    toggle,
    openAgentActivity,
    openCollaboration,
    openProtocol,
    openAndSetTab,
    setProtocolFilters,
    openFileMenu,
  };
})();

window.ConversationInfo = ConversationInfo;
