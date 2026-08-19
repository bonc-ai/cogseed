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
  // 右侧「运行上下文」顶部横向 tab 的当前选中项：runs / source / proof / assets。
  let _activeRunContextTab = 'runs';
  let _seq = 0;
  let _activitySeq = 0;
  let _fileSeq = 0;
  let _attachmentSeq = 0;
  let _cogseedProjectionSeq = 0;
  const _locallyDeletedPaths = new Set();
  let _loading = false;
  let _loadingSource = '';
  let _loadingSeq = 0;
  let _error = '';
  let _fileMenuScrollHost = null;
  // 接续准备依据归属的会话（showResumeEvidence 写入）；refresh 覆盖 snapshot
  // 时据此判断依据是否仍属于当前会话，避免跨会话残留。
  let _resumeEvidenceCid = '';
  // 「本次运行」默认只展示最近 10 条，展开后显示全部（运行证明真实全量保留）。
  let _carriedRunsExpanded = false;
  let _snapshot = {
    conversation: null,
    history: [],
    files: [],
    fileRoot: '',
    fileRootExists: false,
    // 接续准备依据（导入会话欢迎面板「查看依据」）：复述 / 准备携带明细 / 边界。
    // 由 showResumeEvidence 设置，carried tab 顶部渲染。
    resumeEvidence: null,
    filesTruncated: false,
    filesCount: 0,
    filesScanSkipped: false,
    syncEnabled: false,
    attachments: [],
    runtime: null,
    actors: [],
    collaboration: null,
    cogseed: { session: null, collaboration: null, sessions: [], loading: false, error: '' },
    wakeRequests: [],
    protocolEvents: [],
    protocolError: '',
    // 四类能力资产（关于我 / 规则与偏好 / 模板与范例 / 技能与方法）。
    assets: [],
    // 本会话相关的认知候选（recall.candidates.list 按 sourceRefs 过滤）：
    // 待确认的显示「确认入库/忽略」，已确认的归入「已沉淀资产」。
    candidates: [],
    // 导入会话的后台提炼状态（sessionImport.extractionStatus）：四类资产段的
    // 「正在提炼」提示与完成后自动刷新共用。
    extraction: null,
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
    const [historyData, filesData, attachmentData, syncEnabled, activity, wakeData, protocolData, executionsData, assetsData, extractionData, candidatesData] = await Promise.all([
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
      // 四类能力资产（cognition.assets.list）：跨会话的个人能力资产，右侧「四类资产」段展示。
      _invokeOrDefault('cognition.assets.list', { limit: 500 }, { ok: false }).then((data) => (
        data && data.ok && Array.isArray(data.assets) ? data.assets : []
      )).catch(() => []),
      // 导入会话的后台提炼状态：pending 时四类资产段显示「正在提炼」，
      // 完成后（sessionImport.events → extraction_done）由 conversation.js 触发刷新。
      _invokeOrDefault('sessionImport.extractionStatus', { cid }, { ok: false }).then((data) => (
        data && data.ok && data.status ? data.status : null
      )).catch(() => null),
      // 本会话相关的认知候选：候选带 sourceRefs（kind:'conversation', id:cid），
      // 导入提取与沉淀活动产出的候选都指向它们来源的会话。
      _invokeOrDefault('recall.candidates.list', {}, { ok: false }).then((data) => (
        data && data.ok && Array.isArray(data.candidates)
          ? data.candidates.filter((c) => c && Array.isArray(c.sourceRefs)
              && c.sourceRefs.some((ref) => ref && ref.kind === 'conversation' && ref.id === cid))
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
      assets: Array.isArray(assetsData) ? assetsData : [],
      extraction: extractionData || null,
      candidates: Array.isArray(candidatesData) ? candidatesData : [],
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

  function _setCogSeedProjectionState(next, seq) {
    if (seq !== _cogseedProjectionSeq || (_cid && next && next.sessionId && next.sessionId !== _cid)) return;
    const cogseed = next || { session: null, collaboration: null, sessions: [], loading: false, error: '' };
    _snapshot = {
      ..._snapshot,
      cogseed: {
        session: cogseed.session || null,
        collaboration: cogseed.collaboration || null,
        sessions: Array.isArray(cogseed.sessions) ? cogseed.sessions : _snapshot.cogseed.sessions,
        loading: !!cogseed.loading,
        error: cogseed.error ? String(cogseed.error) : '',
      },
      collaboration: cogseed.collaboration || _snapshot.collaboration,
    };
    _renderBody();
  }

  function _renderCogSeedProjectionError(message) {
    return `<div class="conversation-info-empty is-small is-error">${escapeHtml(_label('conversation_info.cogseed.load_failed', 'Could not load Mate overview: {reason}', { reason: message }))}</div>`;
  }

  function _renderCogSeedActions(task, actions) {
    if (!task) return '';
    const buttons = [];
    if (actions && actions.retry) buttons.push(`<button type="button" class="conversation-info-cogseed-action" data-cogseed-action="retry" data-cogseed-task-id="${escapeHtml(task.taskId)}" data-cogseed-request-id="${escapeHtml(task.requestId)}">${escapeHtml(_label('common.retry', 'Retry'))}</button>`);
    if (actions && actions.resume) buttons.push(`<button type="button" class="conversation-info-cogseed-action" data-cogseed-action="resume" data-cogseed-task-id="${escapeHtml(task.taskId)}" data-cogseed-request-id="${escapeHtml(task.requestId)}">${escapeHtml(_label('common.resume', 'Resume'))}</button>`);
    if (actions && actions.abort) buttons.push(`<button type="button" class="conversation-info-cogseed-action is-danger" data-cogseed-action="abort" data-cogseed-task-id="${escapeHtml(task.taskId)}">${escapeHtml(_label('common.abort', 'Abort'))}</button>`);
    return buttons.length ? `<div class="conversation-info-cogseed-actions">${buttons.join('')}</div>` : '';
  }

  function _renderCogSeedOverview() {
    const cogseed = _snapshot.cogseed || {};
    const session = cogseed.session || null;
    if (!session) {
      if (cogseed.loading) return `<div class="conversation-info-empty">${escapeHtml(_label('common.loading', 'Loading…'))}</div>`;
      if (cogseed.error) return _renderCogSeedProjectionError(cogseed.error);
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.cogseed.empty', 'No Mate collaboration snapshot yet.'))}</div>`;
    }
    const collaboration = session.collaboration || cogseed.collaboration || null;
    const task = collaboration && collaboration.task ? collaboration.task : null;
    const actors = collaboration && Array.isArray(collaboration.actors) ? collaboration.actors : [];
    const timeline = collaboration && Array.isArray(collaboration.timeline) ? collaboration.timeline : [];
    const workflow = collaboration && collaboration.workflow ? collaboration.workflow : { childTaskIds: [], steps: [] };
    const actionSummary = task && task.actions ? _renderCogSeedActions(task, task.actions) : '';
    const stepRows = Array.isArray(workflow.steps) && workflow.steps.length
      ? `<div class="conversation-info-cogseed-steps">${workflow.steps.map((step) => `<div class="conversation-info-cogseed-step"><div class="conversation-info-cogseed-step-title">${escapeHtml(step.title || step.stepId || '')}</div><div class="conversation-info-cogseed-step-meta">${escapeHtml(step.status || '')}${step.actorId ? ` · ${escapeHtml(step.actorId)}` : ''}${Array.isArray(step.dependsOn) && step.dependsOn.length ? ` · ${escapeHtml(step.dependsOn.join(', '))}` : ''}</div>${step.resultSummary ? `<div class="conversation-info-cogseed-step-summary">${escapeHtml(step.resultSummary)}</div>` : ''}</div>`).join('')}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.cogseed.no_steps', 'No workflow steps yet.'))}</div>`;
    const actorRows = actors.length
      ? `<div class="conversation-info-cogseed-actors">${actors.map((actor) => `<div class="conversation-info-cogseed-actor"><div class="conversation-info-cogseed-actor-role">${escapeHtml(actor.role || '')}</div><div class="conversation-info-cogseed-actor-meta">${escapeHtml(actor.actorId || '')}${actor.taskId ? ` · ${escapeHtml(actor.taskId)}` : ''}${actor.status ? ` · ${escapeHtml(actor.status)}` : ''}</div></div>`).join('')}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.cogseed.no_actors', 'No actors yet.'))}</div>`;
    const timelineRows = timeline.length
      ? `<div class="conversation-info-cogseed-timeline">${timeline.slice(-8).map((event) => `<div class="conversation-info-cogseed-timeline-item"><div class="conversation-info-cogseed-timeline-head">${escapeHtml(event.type || '')} · ${escapeHtml(event.createdAt || '')}</div><div class="conversation-info-cogseed-timeline-body">${escapeHtml(event.summary || '')}</div></div>`).join('')}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.cogseed.no_timeline', 'No recovery timeline yet.'))}</div>`;
    const childIds = Array.isArray(workflow.childTaskIds) && workflow.childTaskIds.length
      ? `<div class="conversation-info-cogseed-child-tree">${workflow.childTaskIds.map((id) => `<span class="conversation-info-cogseed-child-chip">${escapeHtml(id)}</span>`).join('')}</div>`
      : '';
    // 内容全空（无任务 / 无参与者 / 无工作流 / 无时间线）时不渲染空态卡，避免「暂无」堆积。
    if (!task && !actors.length && !timeline.length && !(workflow.steps && workflow.steps.length) && !childIds) {
      return '';
    }
    return `<section class="conversation-info-collaboration-section conversation-info-cogseed-overview">
      <div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.cogseed.section_title', 'Mate Collaboration Overview'))}</div>
      <div class="conversation-info-cogseed-meta">${escapeHtml(session.sessionId)} · ${escapeHtml(session.latestStatus || 'idle')} · ${escapeHtml(_label('conversation_info.cogseed.task_count', '{count} tasks', { count: session.taskCount || 0 }))}</div>
      <div class="conversation-info-cogseed-task-title">${escapeHtml(task && task.title ? task.title : _label('conversation_info.cogseed.no_task', 'No active task.'))}</div>
      ${actionSummary}
      ${childIds}
      <div class="conversation-info-cogseed-grid">
        <div class="conversation-info-cogseed-card"><div class="conversation-info-cogseed-card-title">${escapeHtml(_label('conversation_info.cogseed.actors', 'Actors'))}</div>${actorRows}</div>
        <div class="conversation-info-cogseed-card"><div class="conversation-info-cogseed-card-title">${escapeHtml(_label('conversation_info.cogseed.steps', 'Workflow'))}</div>${stepRows}</div>
        <div class="conversation-info-cogseed-card"><div class="conversation-info-cogseed-card-title">${escapeHtml(_label('conversation_info.cogseed.timeline', 'Recovery Timeline'))}</div>${timelineRows}</div>
      </div>
    </section>`;
  }

  async function _primeCogSeedProjection(cid, opts = {}) {
    if (!cid || !window.cogseedProjection || typeof window.cogseedProjection.session !== 'function') return null;
    const seq = ++_cogseedProjectionSeq;
    const entry = window.cogseedProjection.session(cid, {
      onUpdate: (value) => {
        if (seq !== _cogseedProjectionSeq || cid !== _cid) return;
        const next = value || null;
        _snapshot = {
          ..._snapshot,
          cogseed: {
            session: next,
            collaboration: next && next.collaboration ? next.collaboration : null,
            sessions: _snapshot.cogseed.sessions,
            loading: false,
            error: '',
          },
          collaboration: next && next.collaboration ? next.collaboration : _snapshot.collaboration,
        };
        _renderBody();
      },
    });
    if (entry && entry.snapshot) {
      _setCogSeedProjectionState({ session: entry.snapshot, collaboration: entry.snapshot && entry.snapshot.collaboration ? entry.snapshot.collaboration : null, sessions: _snapshot.cogseed.sessions, loading: true, error: '' }, seq);
    } else {
      _setCogSeedProjectionState({ session: null, collaboration: null, sessions: _snapshot.cogseed.sessions, loading: true, error: '' }, seq);
    }
    try {
      await entry.refresh;
    } catch (err) {
      if (seq !== _cogseedProjectionSeq || cid !== _cid) return null;
      _setCogSeedProjectionState({ session: null, collaboration: null, sessions: _snapshot.cogseed.sessions, loading: false, error: (err && err.message) || String(err) }, seq);
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
      _renderBody();
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

  /** 掩码来源名里的内部 session id（oc_/sess_/conv_ 长 id）——来源展示给
   *  用户看的是可读标题，内部 id 不直接暴露（隐私/安全）。仅掩码独立成段的
   *  内部 id token，保留可读前缀（如 "Lark · oc_xxx" → "Lark · oc_xxxx…"）。 */
  function _maskedSourceName(title) {
    const text = String(title || '');
    return text.replace(/(^|[^A-Za-z0-9])(oc_|sess_|conv_|gconv-|cid-)[A-Za-z0-9_-]{8,}/g, '$1$2' + _label('common.id_masked', '…'));
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
    const fileRoot = _snapshot.fileRoot || '';
    const workspaceFiles = Array.isArray(_snapshot.files) ? _snapshot.files : [];

    // 工作区文件（key → 条目），默认 isProduced=false。
    const workspaceByKey = new Map();
    for (const item of workspaceFiles) {
      const p = item && item.path ? String(item.path) : '';
      if (!p) continue;
      const key = _normalizePath(p);
      const relPath = item.relPath ? String(item.relPath) : _relPathUnder(fileRoot, p);
      workspaceByKey.set(key, {
        path: p,
        relPath,
        name: item.name || _baseName(p),
        kind: item.kind || _kindForName(item.name || p),
        time: item.mtime ? new Date(Number(item.mtime)).toISOString() : '',
        bytes: Number(item.bytes) || 0,
        source: 'workspace',
        isProduced: false,
      });
    }

    // 产物条目：历史 produced 记录全部保留（不去重），这样「产出」区块始终
    // 能看到本次生成了什么；若产物也落在工作区里，则给工作区条目标记
    // isProduced，让「工作区」区块里带「产出」标签（两边都展示）。
    const producedEntries = [];
    const hasAuthoritativeWorkspaceSnapshot = !!fileRoot && _snapshot.fileRootExists === true;
    for (const produced of _collectHistoryProducedFiles()) {
      const p = produced && produced.path ? String(produced.path) : '';
      if (!p) continue;
      const key = _normalizePath(p);
      const relPath = _relPathUnder(fileRoot, p);
      // 过期判定：工作区快照权威（未截断）且产物在工作区 root 下但快照里
      // 没有——说明被删除/改名了，不保留过期的历史记录。
      if (relPath && hasAuthoritativeWorkspaceSnapshot && !_snapshot.filesTruncated && !workspaceByKey.has(key)) {
        continue;
      }
      producedEntries.push({
        ...produced,
        relPath,
        name: _baseName(p),
        kind: _kindForName(_baseName(p)),
        source: 'produced',
      });
      const ws = workspaceByKey.get(key);
      if (ws) ws.isProduced = true;
    }

    return Array.from(workspaceByKey.values()).concat(producedEntries).sort((a, b) => {
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
      const producedTag = file.isProduced
        ? `<span class="conversation-info-file-produced-tag">${escapeHtml(_label('conversation_info.files_produced_tag', '产出'))}</span>`
        : '';
      return `
      <div class="conversation-info-file" role="button" tabindex="0" style="--depth:${depth}"
              data-file-path="${escapeHtml(file.path)}" draggable="true" title="${escapeHtml(file.path)}">
        <span class="conversation-info-file-icon">${_iconForName(file.name)}</span>
        <span class="conversation-info-file-name">${escapeHtml(file.name)}</span>
        ${producedTag}
        <button type="button" class="conversation-info-file-menu-btn" data-file-menu
                data-entry-kind="${escapeHtml(kind)}" data-entry-path="${escapeHtml(file.path)}" data-entry-name="${escapeHtml(file.name)}"
                title="${escapeHtml(moreTitle)}" aria-label="${escapeHtml(moreTitle)}">⋯</button>
      </div>
    `;
    }).join('');
    return dirHtml + fileHtml;
  }

  function _renderFiles() {
    // 复用 _collectVisibleFiles：产物与工作区分别保留——产物会同时出现在两个
    // 区块，工作区里的产物带「产出」标记。按 source 拆「产出 / 工作区」两个区块。
    // 区块框架始终存在——内容可以为空，但不能没有（Codex 风格）。
    const merged = _collectVisibleFiles();
    const produced = merged.filter((f) => f.source === 'produced');
    const workspace = merged.filter((f) => f.source === 'workspace');

    const producedHtml = produced.length
      ? `<div class="conversation-info-tree">${_renderTreeNode(_buildFileTree(produced), 0)}</div>`
      : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.files_no_produced', '暂无产出文件'))}</div>`;

    let workspaceHtml;
    if (_snapshot.filesScanSkipped) {
      workspaceHtml = `<div class="conversation-info-empty is-small">${escapeHtml(_label(
        'conversation_info.files_scan_skipped',
        'File listing is paused for this privacy-protected workspace. Files created or attached in chat still appear.'
      ))}</div>`;
    } else if (workspace.length) {
      workspaceHtml = `<div class="conversation-info-tree">${_renderTreeNode(_buildFileTree(workspace), 0)}</div>`;
    } else if (_snapshot.fileRootExists === false) {
      // 工作区目录被移动/删除（或从未创建）：区分「目录不存在」与「目录为空」，
      // 提供「重新选择工作区目录」引导（用户取消则保持现状，可再次点击）。
      workspaceHtml = `<div class="conversation-info-empty is-small">${escapeHtml(_label(
        'conversation_info.files_workspace_missing',
        '工作区目录已被移动或删除，文件列表暂不可用；对话中生成的产物仍可查看。'
      ))}</div>
      <button type="button" class="conversation-info-files-repick" data-files-repick-workspace>${escapeHtml(_label('conversation_info.files_workspace_repick', '重新选择工作区目录'))}</button>`;
    } else {
      workspaceHtml = `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.files_no_workspace', '暂无工作区文件'))}</div>`;
    }

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
      ? `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.files_truncated', 'Showing first {count} files', { count: _snapshot.filesCount || workspace.length }))}</div>`
      : '';

    const workspacePathHtml = _snapshot.fileRoot
      ? `<div class="ci-files-workspace-path" title="${escapeHtml(_snapshot.fileRoot)}">${_uiIcon('folder', 'ci-files-workspace-path-icon')}<span>${escapeHtml(_label('conversation_info.files_workspace_path_label', '当前工作区'))}：<code>${escapeHtml(_snapshot.fileRoot)}</code></span></div>`
      : '';

    return `<div class="ci-files">
      <section class="ci-files-section">
        <div class="ci-files-section-title">${_uiIcon('file-text', '')}${escapeHtml(_label('conversation_info.files_produced', '产出'))}</div>
        ${producedHtml}
      </section>
      <section class="ci-files-section">
        <div class="ci-files-section-title">${_uiIcon('folder-open', '')}${escapeHtml(_label('conversation_info.files_workspace', '工作区'))}</div>
        ${workspacePathHtml}
        ${workspaceHtml}
      </section>
      ${syncNotice}${trunc}
    </div>`;
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
    // no-op: tab 条已移除（9.1 五段折叠面板重构），保留函数避免外部调用报错
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
    if (id === 'commander') return _label('chat.agent_status.commander', 'Commander');
    if (actor.name) return String(actor.name);
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
    const cogseedState = _snapshot.cogseed || {};
    const collaboration = _snapshot.collaboration || null;
    const runtime = _snapshot.runtime || {};
    const attentionItems = _collectCollaborationAttentionItems();
    const hasAgentActivity = _deriveAgentActivityRows(_snapshot).length > 0;
    const hasAttention = attentionItems.length > 0;
    const hasTask = !!collaboration && !!collaboration.objective;

    // 完全无实质内容（无任务 / 无参与者 / 无待处理，且不在加载/报错中）：空态。
    if (!hasTask && !hasAgentActivity && !hasAttention && !cogseedState.loading && !cogseedState.error) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.collaboration.empty', 'No active collaboration yet.'))}</div>`;
    }

    const loadFailed = `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.collaboration.load_failed', 'Could not load collaboration overview'))}</div>`;
    const header = `<div class="conversation-info-collaboration-header"><div class="conversation-info-collaboration-heading">${escapeHtml(_label('conversation_info.collaboration.title', 'Collaboration'))}</div><div class="conversation-info-collaboration-subtitle">${escapeHtml(_label('conversation_info.collaboration.subtitle', 'How this conversation is progressing'))}</div></div>`;
    const cogseedHtml = (cogseedState.session || cogseedState.loading || cogseedState.error)
      ? _safeSection(() => _renderCogSeedOverview(), loadFailed)
      : '';
    const taskHtml = hasTask ? _safeSection(() => _renderCollaborationTaskOverview(collaboration, runtime), loadFailed) : '';
    const agentHtml = hasAgentActivity ? _safeSection(() => _renderCollaborationAgentActivitySection(), loadFailed) : '';
    const attentionHtml = hasAttention ? _safeSection(() => _renderCollaborationAttentionSection(attentionItems), loadFailed) : '';

    return `<div class="conversation-info-collaboration">${header}${cogseedHtml}${taskHtml}${agentHtml}${attentionHtml}</div>`;
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
    if (value === 'cogseed_core') return _label('conversation_info.protocol.role.cogseed_core', 'CogSeed Core');
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
    const core = events.filter((event) => _protocolEventData(event).role === 'cogseed_core').length;
    const external = events.filter((event) => _protocolEventData(event).role === 'external_expert').length;
    return `<div class="conversation-info-protocol-summary">
      <div class="conversation-info-protocol-stat is-primary"><span>${escapeHtml(_label('conversation_info.protocol.stat_total', 'Calls'))}</span><strong>${total}</strong></div>
      <div class="conversation-info-protocol-stat"><span>${escapeHtml(_protocolResultLabel('success'))}</span><strong>${success}</strong></div>
      <div class="conversation-info-protocol-stat ${error ? 'is-error' : ''}"><span>${escapeHtml(_protocolResultLabel('error'))}</span><strong>${error}</strong></div>
      <div class="conversation-info-protocol-stat"><span>${escapeHtml(_protocolRoleLabel('cogseed_core'))}</span><strong>${core}</strong></div>
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
    // 审批类权限模式：all_files_approval 等属于「常规」逐项审批，显示可读名
    // 而不是原文（测试断言：all_files_approval → 常规，不显示原文）。
    if (s === 'all_files_approval' || s === 'approval' || s === 'default') {
      return _label('conversation_info.carried.permission.default', '常规');
    }
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

  /** 执行方显示名：优先 agentId / cli；缺失时按执行类型给真实名称
   *  （core-agent 由 commander 驱动 → Commander；codex → Codex；local-agent
   *   → 本地智能体），而不是一律兜底成产品名。 */
  function _carriedExecutorLabel(execution) {
    const explicit = String(execution && (execution.agentId || execution.cli) || '');
    const kind = String(execution && execution.kind || '');
    if (explicit && explicit !== 'commander') return explicit;
    if (kind === 'core-agent' || explicit === 'commander') return _label('conversation_info.carried.executor_core', 'Commander');
    if (kind === 'codex') return _label('conversation_info.carried.executor_codex', 'Codex');
    if (kind === 'local-agent') return _label('conversation_info.carried.executor_local_agent', 'Local agent');
    return _label('conversation_info.carried.executor_unknown', 'CogSeed');
  }

  function _carriedRunHtml(execution) {
    const statusRaw = String(execution && execution.status || '');
    const status = _carriedStatusLabel(statusRaw);
    const agent = _carriedExecutorLabel(execution);
    const boundary = _carriedBoundaryLabel(execution && execution.boundary);
    const permission = _carriedPermissionLabel(execution && execution.permissionMode);
    const artifacts = Array.isArray(execution && execution.artifactIds) ? execution.artifactIds.length : 0;
    const time = _carriedTime(execution && execution.startedAt);
    const executionId = String(execution && execution.executionId || '');
    // 原型「真实状态」：运行中的执行明确提示"仍在运行，不伪装完成"。
    const truthNote = statusRaw === 'running'
      ? `<div class="conversation-info-carried-run-truth">${escapeHtml(_label('conversation_info.carried.truth_running', '任务仍在运行；不会用动画或预设文本冒充已完成。'))}</div>`
      : '';
    const receiptBtn = execution && execution.receiptId
      ? `<button type="button" class="conversation-info-carried-receipt-toggle" data-receipt-execution-id="${escapeHtml(executionId)}">${escapeHtml(_label('conversation_info.carried.receipt_view', '查看回执'))}</button>`
      : '';
    return `<div class="conversation-info-carried-run is-${escapeHtml(statusRaw) || 'unknown'}">
      <div class="conversation-info-carried-run-head">
        <span class="conversation-info-carried-run-agent">
          <span class="conversation-info-carried-run-avatar">${_uiIcon('code-block', '')}</span>
          <span class="conversation-info-carried-run-agent-name">${escapeHtml(agent)}</span>
        </span>
        <span class="conversation-info-carried-run-status is-${escapeHtml(statusRaw) || 'unknown'}">${escapeHtml(status)}</span>
      </div>
      <div class="conversation-info-carried-run-meta">
        ${permission ? `<span>${_uiIcon('shield-check', '')}${escapeHtml(_label('conversation_info.carried.permission_label', '权限'))} · ${escapeHtml(permission)}</span>` : ''}
        ${boundary ? `<span>${_uiIcon('git-branch', '')}${escapeHtml(boundary)}</span>` : ''}
        ${artifacts ? `<span>${_uiIcon('file-text', '')}${artifacts} ${escapeHtml(_label('conversation_info.carried.artifacts', '个产物'))}</span>` : ''}
        ${time ? `<span>${escapeHtml(time)}</span>` : ''}
      </div>
      ${truthNote}
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
    // 接续准备依据（导入会话接续欢迎面板的「查看依据」）：顶部区块，展示
    // 复述 / 准备携带明细（各自来源）/ 边界。由 showResumeEvidence 设置。
    const resumeEvidence = _snapshot.resumeEvidence;
    const resumeHtml = resumeEvidence
      ? `<section class="conversation-info-resume">
          <div class="conversation-info-carried-section-label">${_uiIcon('clipboard-list', 'conversation-info-carried-sec-icon')}${escapeHtml(_label('conversation_info.carried.resume_title', '接续准备'))}</div>
          ${resumeEvidence.restatement ? `<div class="conversation-info-resume-restatement">${escapeHtml(resumeEvidence.restatement)}</div>` : ''}
          ${_renderResumeCarry(resumeEvidence.carry)}
        </section>`
      : '';
    const events = Array.isArray(_snapshot.protocolEvents) ? _snapshot.protocolEvents : [];
    const executions = Array.isArray(_snapshot.executions) ? _snapshot.executions : [];
    const collab = _latestCollaborationRef(events);
    const title = _maskedSourceName(_currentConversationTitle());

    // 本次运行：真实执行记录，按开始时间倒序。默认只列最近 10 条，
    // 顶部汇总总数，超出部分一键展开（展开后全量展示，不删数据）。
    const sorted = executions.slice().sort((a, b) => {
      const at = a && a.startedAt ? String(a.startedAt) : '';
      const bt = b && b.startedAt ? String(b.startedAt) : '';
      return bt.localeCompare(at);
    });
    const RUNS_VISIBLE_LIMIT = 10;
    const totalRuns = sorted.length;
    const visibleRuns = _carriedRunsExpanded ? sorted : sorted.slice(0, RUNS_VISIBLE_LIMIT);
    const runsList = visibleRuns.length
      ? `<div class="conversation-info-carried-runs">${visibleRuns.map(_carriedRunHtml).join('')}</div>`
      : '';
    const runsSummary = totalRuns
      ? `<div class="conversation-info-carried-runs-summary">${escapeHtml(_label('conversation_info.carried.runs_total', '共 {count} 次运行', { count: totalRuns }))}</div>`
      : '';
    const runsToggle = totalRuns > RUNS_VISIBLE_LIMIT
      ? `<button type="button" class="conversation-info-carried-runs-toggle" data-carried-runs-toggle>${escapeHtml(_label(_carriedRunsExpanded ? 'conversation_info.carried.runs_collapse' : 'conversation_info.carried.runs_expand', _carriedRunsExpanded ? '收起' : '展开全部'))}</button>`
      : '';
    const runsHtml = totalRuns
      ? `${runsSummary}${runsList}${runsToggle}`
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
      ${resumeHtml}
      <div class="conversation-info-carried-header">
        <div class="conversation-info-carried-heading">${escapeHtml(_label('conversation_info.carried.title', '本次携带'))}</div>
      </div>
      <section class="conversation-info-carried-section"><div class="conversation-info-carried-section-label">${_uiIcon('play-triangle', 'conversation-info-carried-sec-icon')}${escapeHtml(_label('conversation_info.carried.runs', '本次运行'))}</div>${runsHtml}</section>
      <section class="conversation-info-carried-section"><div class="conversation-info-carried-section-label">${_uiIcon('panel-list', 'conversation-info-carried-sec-icon')}${escapeHtml(_label('conversation_info.carried.context', '本次 Context'))}</div>${contextHtml}</section>
      <section class="conversation-info-carried-section"><div class="conversation-info-carried-section-label">${_uiIcon('git-branch', 'conversation-info-carried-sec-icon')}${escapeHtml(_label('conversation_info.carried.boundary', '来源与边界'))}</div>${boundaryHtml}<div class="conversation-info-carried-permission">${_uiIcon('shield-check', 'conversation-info-carried-permission-icon')}<span>${escapeHtml(permissionNote)}</span></div></section>
    </div>`;
  }

  /** 接续准备「准备携带」明细：每类能力的数量 + 真实明细（资产/技能名 + 版本）
   *  + 来源。明细来自主进程 buildCarry 的 items 字段。 */
  function _renderResumeCarry(carry) {
    const items = Array.isArray(carry) ? carry : [];
    if (!items.length) return '';
    // kind → 图标（icons.js 集中图标，禁止硬编码 SVG / emoji）。
    const kindIcon = { personal: 'book-open', ability: 'brain-circuit', snapshot: 'database' };
    const kindKey = {
      personal: 'chat.welcome_carry_kind_personal',
      ability: 'chat.welcome_carry_kind_ability',
      snapshot: 'chat.welcome_carry_kind_snapshot',
    };
    const sourceKey = {
      confirmed_personal: ['conversation_info.resume.source_confirmed_personal', '已确认“关于我”资产 {count} 项'],
      space_template_skills: ['conversation_info.resume.source_space_template_skills', '空间模板内置 Skill {count} 项'],
      confirmed_ability: ['conversation_info.resume.source_confirmed_ability', '已确认“我的能力”资产 {count} 项'],
      snapshot_restored: ['conversation_info.resume.source_snapshot_restored', '目标、阶段、约束与下一步已恢复'],
    };
    const rows = items.map((c) => {
      const icon = kindIcon[c && c.kind] || 'list-ordered';
      const localizedSources = Array.isArray(c.sourceDetails) && c.sourceDetails.length
        ? c.sourceDetails.map((source) => {
            const entry = sourceKey[source && source.kind];
            return entry ? _label(entry[0], entry[1], { count: Number(source.count) || 0 }) : '';
          }).filter(Boolean)
        : (Array.isArray(c.sources) ? c.sources : []);
      const sources = localizedSources
        .map((s) => `<li>${escapeHtml(String(s))}</li>`).join('');
      const details = (Array.isArray(c.items) ? c.items : [])
        .map((it) => {
          const name = String((it && it.name) || '');
          if (!name) return '';
          const version = (it && it.version) ? ` <span class="conversation-info-resume-version">v${escapeHtml(String(it.version))}</span>` : '';
          return `<li class="conversation-info-resume-item">${escapeHtml(name)}${version}</li>`;
        }).join('');
      return `<div class="conversation-info-resume-carry-row">
        <div class="conversation-info-resume-carry-row-head">
          <span class="conversation-info-resume-carry-ico">${_uiIcon(icon, '')}</span>
          <b>${escapeHtml(kindKey[c.kind] ? _label(kindKey[c.kind], c.label || '') : (c.label || ''))}</b>
          <span class="conversation-info-resume-carry-count">${escapeHtml(_label('conversation_info.resume.item_count', '{count} 项', { count: Number(c.count) || 0 }))}</span>
        </div>
        ${details ? `<ul class="conversation-info-resume-carry-items">${details}</ul>` : ''}
        ${sources ? `<ul class="conversation-info-resume-carry-sources">${sources}</ul>` : ''}
      </div>`;
    }).join('');
    return `<div class="conversation-info-resume-carry">${rows}</div>`;
  }

  // 9.1 统一框架 · 右侧「运行上下文」单列五段折叠面板。
  // 替代旧的 tab 互斥模式：五段垂直排列，每段是 <details> 可折叠，
  // 聚焦段(默认段 ① )展开渲染全文，其余段折叠显示摘要。
  // 各段数据源已就绪，不新增 IPC。
  function _renderRunContext() {
    var executions = Array.isArray(_snapshot.executions) ? _snapshot.executions : [];
    var sorted = executions.slice().sort(function (a, b) {
      var at = a && a.startedAt ? String(a.startedAt) : '';
      var bt = b && b.startedAt ? String(b.startedAt) : '';
      return bt.localeCompare(at);
    });
    var totalRuns = sorted.length;
    var files = (typeof _collectVisibleFiles === 'function') ? _collectVisibleFiles() : [];
    var attachments = Array.isArray(_snapshot.attachments) ? _snapshot.attachments : [];
    var protocolEvents = Array.isArray(_snapshot.protocolEvents) ? _snapshot.protocolEvents : [];
    var latestRun = sorted[0] || null;
    var cogseedState = _snapshot.cogseed || {};
    var hasCollab = !!(_snapshot.collaboration || cogseedState.session || cogseedState.loading);

    // --- 段 1 本次运行：执行记录 + Context 引用 + 权限 ---
    var contextSummary = totalRuns
      ? _label('conversation_info.run_context.runs_count', '{count} 次执行', { count: totalRuns })
      : _label('conversation_info.carried.runs_empty', '本会话暂无执行记录。');
    var RUNS_VISIBLE_LIMIT = 10;
    var visibleRuns = _carriedRunsExpanded ? sorted : sorted.slice(0, RUNS_VISIBLE_LIMIT);
    var runsList = visibleRuns.length
      ? '<div class="conversation-info-carried-runs">' + visibleRuns.map(_carriedRunHtml).join('') + '</div>'
      : '';
    var runsCountLine = totalRuns
      ? '<div class="conversation-info-carried-runs-summary">' + escapeHtml(_label('conversation_info.carried.runs_total', '共 {count} 次运行', { count: totalRuns })) + '</div>'
      : '';
    var runsToggle = totalRuns > RUNS_VISIBLE_LIMIT
      ? '<button type="button" class="conversation-info-carried-runs-toggle" data-carried-runs-toggle>' + escapeHtml(_label(_carriedRunsExpanded ? 'conversation_info.carried.runs_collapse' : 'conversation_info.carried.runs_expand', _carriedRunsExpanded ? '收起' : '展开全部')) + '</button>'
      : '';
    var runsHtml = totalRuns
      ? runsCountLine + runsList + runsToggle
      : '<div class="conversation-info-empty is-small">' + escapeHtml(_label('conversation_info.carried.runs_empty', '本会话暂无执行记录。')) + '</div>';
    var collabRef = _latestCollaborationRef(protocolEvents);
    var contextIds = [];
    sorted.forEach(function (execution) {
      if (execution && execution.contextId && !contextIds.includes(execution.contextId)) {
        contextIds.push(String(execution.contextId));
      }
    });
    var contextRows = [];
    if (collabRef && collabRef.workflow_run_id) contextRows.push([_label('conversation_info.carried.run', '运行'), String(collabRef.workflow_run_id)]);
    if (collabRef && collabRef.step_id) contextRows.push([_label('conversation_info.carried.step', '步骤'), String(collabRef.step_id)]);
    if (contextIds.length) contextRows.push([_label('conversation_info.carried.context_id', 'Context ID'), contextIds.join(' · ')]);
    var contextRefHtml = contextRows.length
      ? '<dl class="conversation-info-carried-rows">' + contextRows.map(function (r) { return '<div><dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd></div>'; }).join('') + '</dl>'
      : '';
    var resumeEvidence = _snapshot.resumeEvidence;
    var resumeHtml = resumeEvidence
      ? '<section class="conversation-info-resume">' +
        (resumeEvidence.restatement ? '<div class="conversation-info-resume-restatement">' + escapeHtml(resumeEvidence.restatement) + '</div>' : '') +
        _renderResumeCarry(resumeEvidence.carry) +
        '</section>'
      : '';

    // --- 段 2 来源与产物 ---
    var sourceSummary = _label('conversation_info.run_context.source_count', '{files} 文件 · {attachments} 附件', { files: files.length, attachments: attachments.length });
    var sourceTitle = _maskedSourceName(_currentConversationTitle());

    // --- 权限（并入段 1 本次运行） ---
    var permissionSummary = latestRun && latestRun.permissionMode
      ? _carriedPermissionLabel(latestRun.permissionMode)
      : _label('conversation_info.carried.permission', '只读');
    var permissionRows = [];
    if (latestRun && (latestRun.agentId || latestRun.cli || latestRun.kind)) {
      permissionRows.push([_label('conversation_info.carried.executor', '执行方'), _carriedExecutorLabel(latestRun)]);
    }
    if (latestRun && latestRun.boundary) {
      permissionRows.push([_label('conversation_info.carried.boundary_label', '边界'), _carriedBoundaryLabel(latestRun.boundary)]);
    }
    if (latestRun && latestRun.permissionMode) {
      permissionRows.push([_label('conversation_info.carried.permission_label', '权限'), _carriedPermissionLabel(latestRun.permissionMode)]);
    }
    var permissionDetailHtml = permissionRows.length
      ? '<dl class="conversation-info-carried-rows">' + permissionRows.map(function (r) { return '<div><dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd></div>'; }).join('') + '</dl>'
      : '<div class="conversation-info-empty is-small">' + escapeHtml(_label('conversation_info.carried.permission', '只读 · 仅本次任务；外发、删除、扩权或正式资产变更会单独确认。')) + '</div>';
    var permissionNote = latestRun && latestRun.permissionMode
      ? _label('conversation_info.carried.permission_note', '本会话最近一次执行的权限模式：{mode}', { mode: _carriedPermissionLabel(latestRun.permissionMode) })
      : _label('conversation_info.carried.permission', '只读 · 仅本次任务；外发、删除、扩权或正式资产变更会单独确认。');

    // --- 段 3 运行与协作：运行证明 + 协作参与者 ---
    var proofSummary = _label('conversation_info.run_context.protocol_count', '{count} 个协议事件', { count: protocolEvents.length });

    var collabSummary = hasCollab
      ? _label('conversation_info.run_context.collab_active', '有协作进行中')
      : _label('conversation_info.run_context.collab_empty', '暂无协作');

    // --- 四类资产 tab：本会话的认知沉淀（提取中 / 待确认候选 / 已沉淀资产） ---
    // 注意：这里不展示全库资产计数——那是认知资产页「总览」的事。放在会话
    // 运行上下文里，用户只会被误导成"这个会话有这些资产"（实测确认过）。
    var assetsData = Array.isArray(_snapshot.assets) ? _snapshot.assets : [];
    var extraction = _snapshot.extraction || null;
    var extracting = !!(extraction && extraction.status === 'pending');
    var sessionCognitionHtml = _renderSessionCognitionHtml(_cid, _snapshot.candidates, assetsData, extracting);

    var runTab = _activeRunContextTab || 'runs';
    var tabBtn = function (key, label) {
      return '<button type="button" class="run-context-tab' + (runTab === key ? ' is-active' : '') + '" data-run-context-tab="' + key + '">' + escapeHtml(label) + '</button>';
    };
    var paneOpen = function (key) {
      return '<div class="run-context-pane"' + (runTab === key ? '' : ' hidden') + ' data-run-context-pane="' + key + '">';
    };

    return '<div class="run-context">' +
      '<div class="run-context-tabs" role="tablist">' +
        tabBtn('runs', _label('conversation_info.run_context.section_runs', '本次运行')) +
        tabBtn('source', _label('conversation_info.run_context.section_source', '来源与产物')) +
        tabBtn('proof', _label('conversation_info.run_context.section_proof', '运行与协作')) +
        tabBtn('assets', _label('conversation_info.run_context.section_assets', '四类资产')) +
      '</div>' +
      paneOpen('runs') +
        resumeHtml +
        runsHtml +
        contextRefHtml +
        permissionDetailHtml +
        '<div class="conversation-info-carried-permission">' + _uiIcon('shield-check', 'conversation-info-carried-permission-icon') + '<span>' + escapeHtml(permissionNote) + '</span></div>' +
      '</div>' +
      paneOpen('source') +
        '<dl class="conversation-info-carried-rows"><div><dt>' + escapeHtml(_label('conversation_info.carried.source', '来源')) + '</dt><dd>' + escapeHtml(sourceTitle) + '</dd></div></dl>' +
        _renderFiles() +
        _renderAttachments() +
      '</div>' +
      paneOpen('proof') +
        '<div class="run-context-subsection">' +
          '<div class="run-context-subsection-title">' + escapeHtml(_label('conversation_info.run_context.subsection_proof', '运行证明')) + '</div>' +
          _renderProtocolInspector() +
        '</div>' +
        '<div class="run-context-subsection">' +
          '<div class="run-context-subsection-title">' + escapeHtml(_label('conversation_info.run_context.subsection_collab', '协作参与者')) + '</div>' +
          _renderCollaborationOverview() +
        '</div>' +
      '</div>' +
      paneOpen('assets') +
        sessionCognitionHtml +
      '</div>' +
    '</div>';
  }

  // ── 四类资产 tab · 本会话认知沉淀 ─────────────────────────────────────
  // 回答用户「这个会话沉淀了什么认知」：提取中提示 → 待确认候选（确认入库 /
  // 忽略）→ 已沉淀资产。候选来自 recall 候选池（导入提取与沉淀活动共用），
  // 确认动作走与认知沉淀页相同的 promote 底层。
  var _COG_TYPE_LABELS = {
    personal: ['cognition.asset_category_personal', '关于我'],
    rule: ['cognition.asset_category_rule', '规则与偏好'],
    template: ['cognition.asset_category_template', '模板与范例'],
    skill_method: ['cognition.asset_category_skill_method', '技能与方法'],
  };

  function _cogTypeLabel(type) {
    var entry = _COG_TYPE_LABELS[type];
    return entry ? _label(entry[0], entry[1]) : String(type || '');
  }

  /** 待确认候选卡片：类型 + 判断 + 价值 + 规则边界 + 确认/忽略。 */
  function _candidateCardHtml(c) {
    var head = '<div class="run-context-cog-card" data-candidate-id="' + escapeHtml(c.id) + '">' +
      '<div class="run-context-cog-card-head">' +
        '<span class="run-context-cog-type is-' + escapeHtml(c.suggestedType) + '">' + escapeHtml(_cogTypeLabel(c.suggestedType)) + '</span>' +
        '<span class="run-context-cog-judgment">' + escapeHtml(c.judgment) + '</span>' +
      '</div>';
    var body = '';
    if (c.value) {
      body += '<div class="run-context-cog-value"><b>' + escapeHtml(_label('conversation_info.run_context.assets_value', '价值')) + '</b>' + escapeHtml(c.value) + '</div>';
    }
    if (c.suggestedType === 'rule') {
      var bounds = [];
      if (Array.isArray(c.applicableWhen) && c.applicableWhen.length) {
        bounds.push('<span class="run-context-cog-bound is-applicable">' + escapeHtml(_label('conversation_info.run_context.assets_applicable', '适用')) + '：' + escapeHtml(c.applicableWhen.join('、')) + '</span>');
      }
      if (Array.isArray(c.forbiddenWhen) && c.forbiddenWhen.length) {
        bounds.push('<span class="run-context-cog-bound is-forbidden">' + escapeHtml(_label('conversation_info.run_context.assets_forbidden', '不适用')) + '：' + escapeHtml(c.forbiddenWhen.join('、')) + '</span>');
      }
      if (bounds.length) body += '<div class="run-context-cog-bounds">' + bounds.join('') + '</div>';
    }
    var actions = '<div class="run-context-cog-actions">' +
      '<button type="button" class="btn btn-sm btn-primary" data-candidate-promote="' + escapeHtml(c.id) + '">' + escapeHtml(_label('conversation_info.run_context.assets_confirm', '确认入库')) + '</button>' +
      '<button type="button" class="btn btn-sm" data-candidate-ignore="' + escapeHtml(c.id) + '">' + escapeHtml(_label('conversation_info.run_context.assets_ignore', '忽略')) + '</button>' +
    '</div>';
    return head + body + actions + '</div>';
  }

  /** 已沉淀条目：confirmed 候选（有对应资产时显示资产标题）。 */
  function _settledCandidateHtml(c, assetsById) {
    var asset = c.promotedAssetId && assetsById[c.promotedAssetId];
    var title = asset ? (asset.title || asset.summary || c.judgment) : c.judgment;
    return '<div class="run-context-cog-settled" data-candidate-id="' + escapeHtml(c.id) + '">' +
      '<span class="run-context-cog-type is-' + escapeHtml(c.suggestedType) + '">' + escapeHtml(_cogTypeLabel(c.suggestedType)) + '</span>' +
      '<span class="run-context-cog-judgment">' + escapeHtml(title) + '</span>' +
      '<span class="run-context-cog-settled-badge">' + escapeHtml(_label('conversation_info.run_context.assets_settled', '已沉淀')) + '</span>' +
    '</div>';
  }

  /** 已沉淀条目：正式资产（relationRefs 指向本会话且未被候选区覆盖）。 */
  function _settledAssetHtml(a) {
    return '<div class="run-context-cog-settled" data-asset-id="' + escapeHtml(a.id) + '">' +
      '<span class="run-context-cog-type is-' + escapeHtml(a.category || a.type) + '">' + escapeHtml(_cogTypeLabel(a.category || a.type)) + '</span>' +
      '<span class="run-context-cog-judgment">' + escapeHtml(a.title || a.summary || '') + '</span>' +
      '<span class="run-context-cog-settled-badge">' + escapeHtml(_label('conversation_info.run_context.assets_settled', '已沉淀')) + '</span>' +
    '</div>';
  }

  /** 四类资产 tab · 本会话认知沉淀区（提取中 / 待确认 / 已沉淀 / 空态）。 */
  function _renderSessionCognitionHtml(cid, candidates, assets, extracting) {
    var pending = [];
    var confirmed = [];
    (Array.isArray(candidates) ? candidates : []).forEach(function (c) {
      if (c.status === 'pending_review' || c.status === 'deferred') pending.push(c);
      else if (c.status === 'confirmed') confirmed.push(c);
    });
    var assetsById = {};
    (Array.isArray(assets) ? assets : []).forEach(function (a) { if (a && a.id) assetsById[a.id] = a; });
    var confirmedById = {};
    confirmed.forEach(function (c) { confirmedById[c.id] = true; });
    // 本会话正式资产：relationRefs（字段是 type，不是 kind）指向本会话；
    // 其候选已在 confirmed 区显示则跳过。
    var extraAssets = (Array.isArray(assets) ? assets : []).filter(function (a) {
      var refs = Array.isArray(a.relationRefs) ? a.relationRefs : [];
      var linked = refs.some(function (r) { return r && r.type === 'conversation' && r.id === cid; });
      if (!linked) return false;
      var linkedCandidate = a.candidateRefs && a.candidateRefs[0];
      return !(linkedCandidate && confirmedById[linkedCandidate]);
    });

    // 四格计数框（本会话视角）：关于我 / 规则与偏好 / 模板与范例 / 技能与方法。
    // 始终显示——没确认或没沉淀出东西就是 0，确认入库后对应分类 +1，用户能
    // 直观看到数字变化。不做全库计数，那是认知资产页「总览」的事。
    var settledByType = { personal: 0, rule: 0, template: 0, skill_method: 0 };
    confirmed.forEach(function (c) {
      if (settledByType[c.suggestedType] != null) settledByType[c.suggestedType] += 1;
    });
    extraAssets.forEach(function (a) {
      var t = a.category || a.type;
      if (settledByType[t] != null) settledByType[t] += 1;
    });
    var assetCells = ['personal', 'rule', 'template', 'skill_method'].map(function (t) {
      return '<div class="run-context-asset"><span>' + escapeHtml(_cogTypeLabel(t)) + '</span><strong>' + escapeHtml(String(settledByType[t])) + '</strong></div>';
    }).join('');
    var assetStrip = '<div class="run-context-assets">' + assetCells + '</div>';

    var html = assetStrip;
    if (extracting) {
      html += '<div class="run-context-extracting"><span class="run-context-extracting-spinner"></span><span>' +
        escapeHtml(_label('conversation_info.run_context.assets_extracting', '正在后台提炼认知资产，完成后自动更新。')) + '</span></div>';
    }
    if (pending.length) {
      html += '<div class="run-context-cog-section-title">' + escapeHtml(_label('conversation_info.run_context.assets_candidates_title', '待确认候选')) +
        ' <em>' + escapeHtml(String(pending.length)) + '</em></div>';
      html += pending.map(_candidateCardHtml).join('');
    }
    if (confirmed.length || extraAssets.length) {
      html += '<div class="run-context-cog-section-title">' + escapeHtml(_label('conversation_info.run_context.assets_settled_title', '已沉淀资产')) + '</div>';
      html += confirmed.map(function (c) { return _settledCandidateHtml(c, assetsById); }).join('');
      html += extraAssets.map(_settledAssetHtml).join('');
    }
    // 空态只在「没有在提取且确实没有内容」时显示——提取中由转圈提示代替。
    if (!extracting && !pending.length && !confirmed.length && !extraAssets.length) {
      html += '<div class="conversation-info-empty is-small">' +
        escapeHtml(_label('conversation_info.run_context.assets_empty', '这个会话还没有沉淀认知。导入的会话会在后台自动提炼，提炼出的候选确认后沉淀为正式资产。')) + '</div>';
    }
    return html;
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
    body.innerHTML = _renderRunContext();
    // Hydrate any data-ui-icon placeholders that the renderers emitted.
    if (typeof window !== 'undefined' && typeof window.hydrateUiIcons === 'function') {
      window.hydrateUiIcons(body);
    }
  }

  function _syncChrome() {
    const panel = document.getElementById('conversation-info-panel');
    const toggle = document.getElementById('conversation-info-toggle');
    if (panel) panel.hidden = !_open;
    if (toggle) {
      toggle.classList.toggle('is-active', _open);
      toggle.setAttribute('aria-expanded', _open ? 'true' : 'false');
    }
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
      // 保留「查看依据」的接续准备依据（_load 返回里没有该字段，整体覆盖会
      // 把它清掉）；仅当依据仍属于当前会话时才保留，切换会话即丢弃。
      const keepResume = !!(_snapshot.resumeEvidence && _resumeEvidenceCid === target);
      _snapshot = {
        ...snapshot,
        cogseed: _snapshot.cogseed || { session: null, collaboration: null, sessions: [], loading: false, error: '' },
        resumeEvidence: keepResume ? _snapshot.resumeEvidence : null,
      };
      if (!keepResume) _resumeEvidenceCid = '';
      _error = '';
      void _primeCogSeedProjection(target, { render: silent }).catch(() => {});
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
      _renderBody();
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
      _renderBody();
    } catch (err) {
      _infoLog.warn('attachment refresh failed', { cid: target, error: err && err.message });
    }
  }

  /** 工作区目录缺失引导：系统目录选择器重选 → 固化为本会话 coding_project_dir
   *  → 刷新文件列表。用户取消（selectDirectory 返回 null）→ 保持现状。 */
  async function _repickWorkspaceDirectory() {
    if (!_cid) return;
    const invoke = window && window.cogseed && typeof window.cogseed.invoke === 'function'
      ? window.cogseed.invoke.bind(window.cogseed)
      : null;
    if (!invoke) return;
    try {
      const picked = await invoke('workspace.selectDirectory', {});
      const dir = picked && picked.path;
      if (!dir) return; // 用户取消
      await invoke('workspace.setCodingProjectDir', { cid: _cid, dir });
      await refreshFiles(_cid, { silent: true });
    } catch (err) {
      _infoLog.warn('workspace directory repick failed', { error: err && err.message });
    }
  }

  async function refreshFiles(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_fileSeq;
    const silent = !!opts.silent;
    if (silent && _loadingSource === 'files') {
      _clearLoading('files', seq, { clearAnyForSource: true });
      _renderBody();
    }
    if (!silent) {
      _error = '';
      _beginLoading('files', seq);
    }
    try {
      const partial = await _loadFileSnapshot(target);
      if (seq !== _fileSeq || target !== _cid) return;
      _snapshot = { ..._snapshot, ...partial };
      _error = '';
      _renderBody();
    } catch (err) {
      if (seq !== _fileSeq || target !== _cid) return;
      _infoLog.warn('file refresh failed', { cid: target, error: err && err.message });
      if (!silent) {
        _error = (err && err.message) || String(err);
        _renderBody();
      }
    } finally {
      if (seq === _fileSeq && target === _cid) {
        _clearLoading('files', seq, { clearAnyForSource: silent });
        _renderBody();
      }
    }
  }

  function bind(cid) {
    _cid = cid || null;
    _open = false;
    _resumeEvidenceCid = '';
    _carriedRunsExpanded = false;
    _snapshot = { conversation: null, history: [], files: [], fileRoot: '', fileRootExists: false, filesTruncated: false, filesCount: 0, filesScanSkipped: false, syncEnabled: false, attachments: [], runtime: null, actors: [], collaboration: null, cogseed: { session: null, collaboration: null, sessions: [], loading: false, error: '' }, wakeRequests: [], protocolEvents: [], protocolError: '' };
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
    if (body && body.dataset.bound !== '1') {
      body.dataset.bound = '1';
      body.addEventListener('click', (ev) => {
        const runContextTab = ev.target.closest('[data-run-context-tab]');
        if (runContextTab) {
          ev.preventDefault();
          ev.stopPropagation();
          _activeRunContextTab = runContextTab.dataset.runContextTab || 'runs';
          _renderBody();
          return;
        }
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
        // 工作区目录缺失：引导重新选择（系统目录选择器；取消则保持现状）。
        const workspaceRepick = ev.target.closest('[data-files-repick-workspace]');
        if (workspaceRepick) {
          ev.preventDefault();
          ev.stopPropagation();
          void _repickWorkspaceDirectory();
          return;
        }
        const protocolRefresh = ev.target.closest('[data-protocol-refresh]');
        if (protocolRefresh) {
          ev.preventDefault();
          ev.stopPropagation();
          void refresh(_cid);
          return;
        }
        // 「本次运行」展开/收起（默认显示最近 10 条，展开后全量展示）。
        const runsToggle = ev.target.closest('[data-carried-runs-toggle]');
        if (runsToggle) {
          ev.preventDefault();
          ev.stopPropagation();
          _carriedRunsExpanded = !_carriedRunsExpanded;
          _renderBody();
          return;
        }
        // 四类资产 tab · 候选操作：确认入库（promote，与认知沉淀页同一底层）。
        const candidatePromote = ev.target.closest('[data-candidate-promote]');
        if (candidatePromote) {
          ev.preventDefault();
          ev.stopPropagation();
          const candidateId = candidatePromote.dataset.candidatePromote || '';
          if (!candidateId) return;
          const invoke = window && window.cogseed && typeof window.cogseed.invoke === 'function'
            ? window.cogseed.invoke.bind(window.cogseed)
            : null;
          if (!invoke) return;
          candidatePromote.disabled = true;
          invoke('recall.candidates.promote', { candidateId, riskAcknowledged: true })
            .then((res) => {
              if (res && res.ok) {
                if (typeof uiToast === 'function') {
                  uiToast(_label('conversation_info.run_context.assets_confirmed_toast', '已确认入库，可在四类资产中查看'), { variant: 'success', timeoutMs: 4000 });
                }
                void refresh(_cid);
              } else {
                candidatePromote.disabled = false;
                if (typeof uiToast === 'function') {
                  uiToast(_label('conversation_info.run_context.assets_confirm_failed', '确认失败，请重试'), { variant: 'warning', timeoutMs: 5000 });
                }
              }
            })
            .catch(() => {
              candidatePromote.disabled = false;
              if (typeof uiToast === 'function') {
                uiToast(_label('conversation_info.run_context.assets_confirm_failed', '确认失败，请重试'), { variant: 'warning', timeoutMs: 5000 });
              }
            });
          return;
        }
        // 四类资产 tab · 候选操作：忽略。
        const candidateIgnore = ev.target.closest('[data-candidate-ignore]');
        if (candidateIgnore) {
          ev.preventDefault();
          ev.stopPropagation();
          const candidateId = candidateIgnore.dataset.candidateIgnore || '';
          if (!candidateId) return;
          const invoke = window && window.cogseed && typeof window.cogseed.invoke === 'function'
            ? window.cogseed.invoke.bind(window.cogseed)
            : null;
          if (!invoke) return;
          candidateIgnore.disabled = true;
          invoke('recall.candidates.ignore', { candidateId })
            .then((res) => {
              if (res && res.ok) {
                if (typeof uiToast === 'function') {
                  uiToast(_label('conversation_info.run_context.assets_ignored_toast', '已忽略该候选'), { variant: 'info', timeoutMs: 4000 });
                }
                void refresh(_cid);
              } else {
                candidateIgnore.disabled = false;
              }
            })
            .catch(() => { candidateIgnore.disabled = false; });
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
        const cogseedAction = ev.target.closest('[data-cogseed-action]');
        if (cogseedAction && _snapshot.cogseed && _snapshot.cogseed.session) {
          ev.preventDefault();
          ev.stopPropagation();
          const action = cogseedAction.dataset.cogseedAction;
          const taskId = cogseedAction.dataset.cogseedTaskId || '';
          const requestId = cogseedAction.dataset.cogseedRequestId || '';
          if (action === 'abort' && taskId) {
            void window.cogseed.invoke('cogseed_agent.task.abort', { taskId }).then(() => refresh(_cid));
          } else if (action === 'retry' && taskId && requestId) {
            void window.cogseed.invoke('cogseed_agent.task.retry', { taskId, requestId }).then(() => refresh(_cid));
          } else if (action === 'resume' && taskId && requestId) {
            void window.cogseed.invoke('cogseed_agent.task.resume', { taskId, requestId, continuation: (_snapshot.cogseed.session && _snapshot.cogseed.session.collaboration && _snapshot.cogseed.session.collaboration.task && _snapshot.cogseed.session.collaboration.task.title) || 'Resume task.' }).then(() => refresh(_cid));
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
          ev.dataTransfer.setData('application/x-cogseed-file', JSON.stringify({ path, name }));
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
    _setOpen(true);
    _syncChrome();
    _renderBody();
  }
  /** 展示导入会话接续准备的依据（「查看依据」）：立即切到 carried tab 并渲染
   *  依据（resumeEvidence 已就绪，不依赖网络），随后静默刷新执行记录等数据；
   *  刷新结果合并时保留 resumeEvidence（见 refresh），依据不会消失。 */
  function showResumeEvidence(data, cid) {
    if (cid) _cid = cid;
    _resumeEvidenceCid = cid || _cid || '';
    _snapshot = { ..._snapshot, resumeEvidence: data || null };
    _open = true;
    _resetLoading(); // 依据已就绪，先渲染，避免旧 loading 状态遮挡
    _syncChrome();
    _renderBody();
    void refresh(_cid, { silent: true }).catch(() => {});
  }

  // 右栏实时刷新执行记录（原型「运行与证明」rail 的真实状态）：由
  // conversation.js 在执行事件时调用。仅 carried tab 激活且 cid 匹配时生效，
  // 带 2s 节流与状态签名去抖，避免 process 事件洪峰导致右栏抖动。
  let _executionsSig = '';
  let _executionsRefreshAt = 0;
  async function refreshExecutions(cid) {
    if (!cid || cid !== _cid) return;
    const now = Date.now();
    if (now - _executionsRefreshAt < 2000) return;
    _executionsRefreshAt = now;
    try {
      const res = await window.cogseed.invoke('p3394.execution.list', {});
      const list = (res && Array.isArray(res.executions))
        ? res.executions.filter((item) => item && item.conversationId === cid)
        : [];
      const sig = list.map((e) => `${e.executionId || ''}:${e.status || ''}`).join('|');
      if (sig === _executionsSig) return;
      _executionsSig = sig;
      _snapshot = { ..._snapshot, executions: list };
      const body = document.getElementById('conversation-info-body');
      if (body) {
        body.innerHTML = _renderRunContext();
        if (typeof window.hydrateUiIcons === 'function') window.hydrateUiIcons(body);
      }
    } catch (_) { /* 刷新失败保持现状 */ }
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
    showResumeEvidence,
    refreshExecutions,
    openFileMenu,
  };
})();

window.ConversationInfo = ConversationInfo;
