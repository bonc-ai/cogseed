// ─── 知识库工作台（三栏骨架：库树 / 文件列表 / 右区占位）— classic script ───
// 计划书 v1.3 S1：库树 = contexts.tree 顶层目录（个人库，＋ 创建 = contexts.mkdir）；
// 文件列表 = ContextNode（文件夹可下钻 + 面包屑）+ kb 状态（kb.status 快照 +
// kb.events 流实时更新索引 chips）；右区 AI 解析/问答 = S2/S3 上线（占位）。
(function () {
  const _log = typeof createLogger === 'function' ? createLogger('kb-workbench') : console;

  const _state = {
    tree: [],
    kbStatus: new Map(), // relPath -> { status, chunks, kind, error }
    libs: [],
    currentLib: '',
    dirStack: [], // 相对库根的目录路径段（'' = 库根）
    filter: '',
    sort: 'updated', // updated | size | type | name（对齐 ima 排序维度）
    rendered: false,
    streamHandle: null,
    loading: false,
    summaryLib: '',
    summary: null,
    summaryCache: {}, // key(库名或 space:xxx) → 已解析的 summary（切回已解析库时立即显示，不重新触发 LLM）
    lastMind: null, // 最近生成的脑图根节点（预览/编辑用）
    mmCollapsed: new Set(), // 已折叠的一级分支节点 idx
    mmMode: 'mind', // 布局模式 mind=双向放射 | org=组织结构图(单向)
    mmFocus: null, // 聚焦的一级分支 idx（其他分支淡化）
    mmBg: 'dots', // 背景 dots=点阵 | plain=纯白 | none=无
    mmSearchHits: new Set(), // 脑内搜索命中节点 idx
    mmViewMode: 'graph', // graph=图形 | outline=大纲
    treeGroups: new Set(), // 已折叠的库树组名（个人知识库/共享知识库）
    expanded: new Set(), // 已展开的文件夹相对路径（内联展开/折叠）
    spaces: [],
    spaceId: null,
    spaceName: '',
    spaceFiles: [],
    filePerms: {}, // 共享库文件成员权限（会话内：path → view_export|view_only|hidden）
    pendingRename: {}, // 共享库文件重命名待索引合并：oldPath → newPath（防刷新快照"消失"）
    pendingDelete: new Set(), // 共享库文件删除待索引合并
    sideCollapsed: false, // 知识库列表面板收起
    treeFilter: '', // 库树搜索关键词（过滤个人库+共享库）
    qaAttachments: [], // 本次提问挂载的附件 [{name, path, size}]（最多 5 个）
    qaHistory: [], // 当前会话消息 [{role, content}]（多轮上下文）
    qaSessions: [], // 会话列表 [{id, title, msgs, ts}]（持久化 localStorage）
    qaSessionId: null, // 当前会话 id
  };

  const _TYPE_LABEL = { pdf: 'PDF', excel: 'EXCEL', ppt: 'PPT', img: '图片', word: 'WORD', txt: 'TXT' };

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 统一图标：优先 icons.js 的 uiIconHtml（仓库规范），缺的名走内联 SVG。
  function _icon(name, cls) {
    if (typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, cls || 'kb-ico');
    }
    return `<svg class="${cls || 'kb-ico'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>`;
  }

  const _SVGS = {
    sort: '<path d="M8 6h13M8 12h9M8 18h5M3 6h.01M3 12h.01M3 18h.01"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    send: '<path d="M3.6 4.4 20.6 12 3.6 19.6l2.4-7.6z"/><path d="M6 12h14.6"/>',
    plus: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 8v8M8 12h8"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
    more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
    share: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    chip: '<rect x="5" y="7" width="14" height="10" rx="2.5"/><path d="M9 7V4.5M15 7V4.5M9 19.5V17M15 19.5V17M10.5 12h3"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'panel-collapse': '<rect x="4" y="5" width="6" height="14" rx="1.5"/><rect x="14" y="5" width="6" height="14" rx="1.5"/>',
    'popout': '<path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'history': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    'close': '<path d="M18 6 6 18M6 6l12 12"/>',
    'paperclip': '<path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48"/>',
    'tools': '<path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14.5 12l-2.5-2.5z"/>',
    'more-h': '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  };
  function _svg(name) {
    return `<svg class="kb-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_SVGS[name] || ''}</svg>`;
  }

  function _extClass(name) {
    const ext = String(name).split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (['xlsx', 'xlsm', 'xls', 'csv', 'tsv'].includes(ext)) return 'excel';
    if (['pptx', 'pptm', 'ppt'].includes(ext)) return 'ppt';
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) return 'img';
    if (['docx', 'doc', 'md', 'markdown', 'txt', 'log'].includes(ext)) return 'word';
    return 'txt';
  }

  function _extLabel(name) {
    const ext = String(name).split('.').pop().toLowerCase();
    if (ext === 'pdf') return _TYPE_LABEL.pdf;
    if (['xlsx', 'xlsm', 'xls', 'csv', 'tsv'].includes(ext)) return _TYPE_LABEL.excel;
    if (['pptx', 'pptm', 'ppt'].includes(ext)) return _TYPE_LABEL.ppt;
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) return _TYPE_LABEL.img;
    if (['docx', 'doc'].includes(ext)) return _TYPE_LABEL.word;
    return _TYPE_LABEL.txt;
  }

  function _findLibNode(name) {
    return _state.tree.find((n) => n.type === 'dir' && n.name === name) || null;
  }

  // 沿 dirStack 下钻到当前目录节点（dirStack 为空 = 库根）
  function _currentDirNode() {
    const lib = _findLibNode(_state.currentLib);
    if (!lib) return null;
    let node = lib;
    for (const seg of _state.dirStack) {
      const next = (node.children || []).find((n) => n.type === 'dir' && n.name === seg);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  function _relPath(name) {
    const base = _state.currentLib;
    const dirs = _state.dirStack.length ? `${_state.dirStack.join('/')}/` : '';
    return `${base}/${dirs}${name}`;
  }

  function _statusChip(relPath) {
    const st = _state.kbStatus.get(relPath);
    if (!st) return '<span class="kb-file-status is-none">未索引</span>';
    if (st.status === 'ready') return `<span class="kb-file-status is-ready" title="chunks: ${st.chunks ?? 0}">✓ 已索引</span>`;
    if (st.status === 'processing') return '<span class="kb-file-status is-run">索引中…</span>';
    if (st.status === 'pending') return '<span class="kb-file-status is-run">排队中</span>';
    if (st.status === 'failed') return '<span class="kb-file-status is-failed" title="' + _esc(st.error || '') + '">失败</span>';
    return '<span class="kb-file-status is-none">未索引</span>';
  }

  // ── 数据加载 ──
  async function _loadAll() {
    if (_state.loading) return;
    _state.loading = true;
    try {
      const [treeRes, kbRes, spacesRes] = await Promise.all([
        window.cogseed.invoke('contexts.tree'),
        window.cogseed.invoke('kb.status').catch(() => null),
        window.cogseed.invoke('spaces.list').catch(() => null),
      ]);
      _state.tree = (treeRes && Array.isArray(treeRes.tree)) ? treeRes.tree : [];
      _state.libs = _state.tree.filter((n) => n.type === 'dir');
      _state.spaces = (spacesRes && Array.isArray(spacesRes.spaces)) ? spacesRes.spaces : [];
      _state.kbStatus = new Map();
      const files = (kbRes && Array.isArray(kbRes.files)) ? kbRes.files : [];
      for (const f of files) {
        if (!f || !f.path) continue;
        _state.kbStatus.set(f.path, { status: f.status, chunks: f.chunks, kind: f.kind, error: f.error });
      }
      if (!_state.libs.some((l) => l.name === _state.currentLib)) {
        _state.currentLib = _state.libs.length ? _state.libs[0].name : '';
        _state.dirStack = [];
      }
      _renderTree();
      _renderFiles();
      _renderRight();
      _ensureKbStream();
    } catch (err) {
      _log.error('kb load failed', err);
    } finally {
      _state.loading = false;
    }
  }

  // ── 库树 ──
  function _renderTree() {
    const tree = document.getElementById('kb-wb-tree');
    if (!tree) return;
    const groups = [
      { key: '个人知识库', label: '个人知识库', plus: true, btnId: 'kb-new-lib', btnTitle: '创建个人知识库', html: _state.libs.filter((l) => !_state.treeFilter || l.name.toLowerCase().includes(_state.treeFilter)).map((l) =>
        `<div class="kb-tree-item${l.name === _state.currentLib && !_state.spaceId ? ' active' : ''}" data-kb-lib="${_esc(l.name)}">
          ${_icon('folder', 'kb-tree-ico')}<span class="kb-tree-name">${_esc(l.name)}</span></div>`
      ).join('') || '<div class="kb-tree-empty">暂无知识库，点击 ＋ 创建</div>' },
      { key: '共享知识库', label: '共享知识库', plus: true, btnId: 'kb-new-shared-space', btnTitle: '创建共享知识库', html: _state.spaces.filter((sp) => !_state.treeFilter || (sp.name || sp.space_id).toLowerCase().includes(_state.treeFilter)).map((sp) =>
        `<div class="kb-tree-item${sp.space_id === _state.spaceId ? ' active' : ''}" data-kb-space="${_esc(sp.space_id)}">
          ${_icon('folder', 'kb-tree-ico kb-tree-ico-space')}<span class="kb-tree-name">${_esc(sp.name || sp.space_id)}</span><span class="kb-badge-share" title="共享知识库">${_icon('users', 'kb-share-ico')}</span></div>`
      ).join('') || '<div class="kb-tree-placeholder">' + (_state.treeFilter ? '无匹配知识库' : '暂无共享空间') + '</div>' },
    ];
    const groupHtml = groups.map((g) => {
      const open = !_state.treeGroups.has(g.key);
      return `<div class="kb-tree-group">
        <div class="kb-tree-group-label" data-kb-group="${_esc(g.key)}" title="${open ? '收起' : '展开'}">
          <span class="kb-tree-caret">${open ? '▼' : '▶'}</span><span class="kb-tree-group-name">${_esc(g.label)}</span>
          ${g.plus ? `<button type="button" class="kb-tree-plus" id="${_esc(g.btnId || 'kb-new-lib')}" title="${_esc(g.btnTitle || '创建')}">＋</button>` : ''}
        </div>
        ${open ? `<div class="kb-tree-items">${g.html}</div>` : ''}
      </div>`;
    }).join('');
    tree.innerHTML = groupHtml;
    tree.querySelectorAll('[data-kb-group]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.kb-tree-plus')) return;
        const key = el.dataset.kbGroup;
        if (_state.treeGroups.has(key)) _state.treeGroups.delete(key);
        else _state.treeGroups.add(key);
        _renderTree();
      });
    });
    tree.querySelectorAll('[data-kb-lib]').forEach((el) => {
      el.addEventListener('click', () => _selectLib(el.dataset.kbLib));
      // 个人库行：右键 → 重命名 / 删除
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        _kbRowMenu(el.dataset.kbLib, true, e.clientX, e.clientY);
      });
    });
    tree.querySelectorAll('[data-kb-space]').forEach((el) => {
      el.addEventListener('click', () => _selectSpace(el.dataset.kbSpace));
      // 共享库行：右键 → 重命名 / 删除
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        _kbSpaceMenu(el.dataset.kbSpace, e.clientX, e.clientY);
      });
    });
    tree.querySelector('#kb-new-lib')?.addEventListener('click', (e) => { e.stopPropagation(); _createLib(); });
    tree.querySelector('#kb-new-shared-space')?.addEventListener('click', (e) => { e.stopPropagation(); _createSharedSpace(); });
  }

  // 共享知识库（空间库）：spaces.files.status 只读浏览 + 问答/解析走 space 模式。
  function _selectSpace(spaceId) {
    if (_state.spaceId === spaceId) return;
    _state.spaceId = spaceId;
    const sp = _state.spaces.find((x) => x.space_id === spaceId);
    _state.spaceName = (sp && sp.name) || spaceId;
    _state.spaceFiles = [];
    _state.dirStack = [];
    _resetAnalysisCard();
    // 若该库已解析过（缓存命中），立即恢复显示，不重新触发 LLM
    const key = `space:${spaceId}`;
    if (_state.summaryCache[key]) {
      _state.summaryLib = key;
      _state.summary = _state.summaryCache[key];
      _renderAnalysis(_state.summaryCache[key]);
    } else {
      _state.summaryLib = '';
      _state.summary = null;
    }
    _renderTree();
    _renderFiles();
    _renderRight();
    _clearQa();
    _loadSpaceFiles(spaceId);
  }

  async function _loadSpaceFiles(spaceId) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    try {
      const res = await window.cogseed.invoke('spaces.files.status', { spaceId });
      if (_state.spaceId !== spaceId) return; // 已切换
      let files = (res && Array.isArray(res.files)) ? res.files : [];
      // 合并 pending 乐观操作（索引队列 delete/upsert 异步，快照可能短暂缺失）：
      // 1) 重命名：快照中的旧名映射到新名；upsert 未完成（快照缺新名）用本地乐观项兜底，文件不消失
      const pr = _state.pendingRename || {};
      if (Object.keys(pr).length) {
        files = files.map((f) => {
          const key = f.path || f.name;
          return pr[key] ? { ...f, name: pr[key], path: pr[key] } : f;
        });
        for (const newP of Object.values(pr)) {
          if (!files.some((f) => (f.path || f.name) === newP)) {
            const local = _state.spaceFiles.find((f) => (f.path || f.name) === newP);
            if (local) files.push(local);
          }
        }
        const done = Object.entries(pr).every(([oldP, newP]) =>
          files.some((f) => (f.path || f.name) === newP) && !files.some((f) => (f.path || f.name) === oldP));
        if (done) _state.pendingRename = {};
      }
      // 2) 删除：快照残留的待删项移除
      if (_state.pendingDelete && _state.pendingDelete.size) {
        const before = files.length;
        files = files.filter((f) => !_state.pendingDelete.has(f.path || f.name));
        if (files.length < before) _state.pendingDelete.clear();
      }
      _state.spaceFiles = files;
      _renderFiles();
      _renderRight();
    } catch (err) {
      _log.warn('load space files failed', err);
    }
  }

  function _selectLib(name) {
    if (_state.currentLib === name && !_state.spaceId) return;
    _state.currentLib = name;
    _state.spaceId = null;
    _state.spaceFiles = [];
    _state.dirStack = [];
    _resetAnalysisCard();
    // 若该库已解析过（缓存命中），立即恢复显示，不重新触发 LLM
    if (_state.summaryCache[name]) {
      _state.summaryLib = name;
      _state.summary = _state.summaryCache[name];
      _renderAnalysis(_state.summaryCache[name]);
    } else {
      _state.summaryLib = '';
      _state.summary = null;
    }
    _renderTree();
    _renderFiles();
    _renderRight();
    _clearQa();
  }

  async function _createLib() {
    let name = null;
    try {
      name = typeof uiPrompt === 'function' ? await uiPrompt('新建个人知识库名称：') : window.prompt('新建个人知识库名称：');
    } catch (_) { /* cancelled */ }
    if (!name || !name.trim()) return;
    const clean = name.trim().replace(/[\/\\]/g, '-');
    try {
      await window.cogseed.invoke('contexts.mkdir', { path: clean });
      await _loadAll();
      _selectLib(clean);
    } catch (err) {
      _log.warn('create lib failed', err);
      if (typeof uiToast === 'function') uiToast('创建失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // ── 创建共享知识库（对标 ima：名称*/封面/描述/加入方式/成员权限/推荐问题）──
  let _kbShareDialog = null;
  let _kbShareCover = ''; // 封面 base64（'' = 默认）

  function _createSharedSpace() {
    _kbShareCloseDialog();
    const overlay = document.createElement('div');
    overlay.className = 'kb-share-dlg-overlay';
    overlay.innerHTML = `
      <div class="kb-share-dlg">
        <button type="button" class="kb-share-dlg-close" title="关闭">✕</button>
        <h3 class="kb-share-dlg-title">创建共享知识库</h3>
        <div class="kb-share-form">
          <div class="kb-share-field">
            <label class="kb-share-label">名称 <span class="kb-share-required">*</span></label>
            <input type="text" class="kb-share-input" id="kb-share-name" placeholder="请输入知识库名称" autocomplete="off" spellcheck="false" />
          </div>
          <div class="kb-share-field">
            <label class="kb-share-label">封面</label>
            <div class="kb-share-cover">
              <div class="kb-share-cover-preview" id="kb-share-cover-preview"><span class="kb-share-cover-default">📁</span></div>
              <button type="button" class="kb-share-cover-edit" id="kb-share-cover-edit" title="上传 / 更换知识库封面">✎</button>
              <input type="file" id="kb-share-cover-file" accept="image/*" hidden />
            </div>
          </div>
          <div class="kb-share-field">
            <label class="kb-share-label">描述</label>
            <textarea class="kb-share-input" id="kb-share-desc" rows="3" placeholder="为你的共享知识库填写描述"></textarea>
          </div>
          <div class="kb-share-field">
            <label class="kb-share-label">加入方式</label>
            <div class="kb-share-select-wrap">
              <select class="kb-share-select" id="kb-share-join">
                <option value="direct">直接加入</option>
                <option value="apply">申请加入（管理员批准）</option>
                <option value="invite">仅邀请加入</option>
              </select>
            </div>
          </div>
          <div class="kb-share-field">
            <label class="kb-share-label">成员权限</label>
            <div class="kb-share-perm" id="kb-share-perm">
              <button type="button" class="kb-share-perm-trigger" id="kb-share-perm-trigger">
                <span class="kb-share-perm-label" id="kb-share-perm-label">内容可查看和导出</span><span class="kb-share-caret">▾</span>
              </button>
              <div class="kb-share-perm-menu" id="kb-share-perm-menu" hidden>
                <div class="kb-share-perm-item is-selected" data-perm="view_export">✓ 内容可查看和导出</div>
                <div class="kb-share-perm-item" data-perm="view_only">内容可查看但不可导出</div>
                <div class="kb-share-perm-item" data-perm="hidden">内容不可查看</div>
              </div>
            </div>
          </div>
          <div class="kb-share-field">
            <label class="kb-share-label">设置推荐问题</label>
            <textarea class="kb-share-input" id="kb-share-questions" rows="2" placeholder="为你的知识库预设推荐问题（每行一个）"></textarea>
          </div>
        </div>
        <div class="kb-share-dlg-actions">
          <button type="button" class="kb-share-btn kb-share-btn-ghost" id="kb-share-cancel">取消</button>
          <button type="button" class="kb-share-btn kb-share-btn-primary" id="kb-share-ok" disabled>确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    _kbShareDialog = overlay;
    _kbShareCover = '';

    const nameInput = overlay.querySelector('#kb-share-name');
    const okBtn = overlay.querySelector('#kb-share-ok');
    const syncOk = () => { okBtn.disabled = !String(nameInput.value || '').trim(); };
    nameInput.addEventListener('input', syncOk);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !okBtn.disabled) _kbShareSubmit();
    });

    // 封面上传
    const coverFile = overlay.querySelector('#kb-share-cover-file');
    overlay.querySelector('#kb-share-cover-edit').addEventListener('click', (e) => { e.stopPropagation(); coverFile.click(); });
    coverFile.addEventListener('change', () => {
      const f = coverFile.files && coverFile.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) {
        if (typeof uiToast === 'function') uiToast('封面图片过大，请选择 3MB 以内的图片', { variant: 'warning' });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        _kbShareCover = String(reader.result || '');
        const preview = overlay.querySelector('#kb-share-cover-preview');
        preview.innerHTML = `<img src="${_esc(_kbShareCover)}" alt="cover" />`;
        preview.classList.add('has-img');
      };
      reader.readAsDataURL(f);
    });

    // 成员权限下拉
    const permMenu = overlay.querySelector('#kb-share-perm-menu');
    overlay.querySelector('#kb-share-perm-trigger').addEventListener('click', (e) => {
      e.stopPropagation();
      permMenu.hidden = !permMenu.hidden;
    });
    permMenu.querySelectorAll('.kb-share-perm-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        permMenu.querySelectorAll('.kb-share-perm-item').forEach((x) => x.classList.remove('is-selected'));
        item.classList.add('is-selected');
        overlay.querySelector('#kb-share-perm-label').textContent = item.textContent.replace(/^\s*✓\s*/, '');
        permMenu.hidden = true;
      });
    });

    overlay.querySelector('#kb-share-cancel').addEventListener('click', _kbShareCloseDialog);
    overlay.querySelector('.kb-share-dlg-close').addEventListener('click', _kbShareCloseDialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _kbShareCloseDialog(); });
    overlay.addEventListener('click', (e) => {
      if (!e.target.closest('#kb-share-perm')) permMenu.hidden = true;
    });
    okBtn.addEventListener('click', _kbShareSubmit);
    setTimeout(() => nameInput.focus(), 50);
  }

  async function _kbShareSubmit() {
    const overlay = _kbShareDialog;
    if (!overlay) return;
    const name = String(overlay.querySelector('#kb-share-name').value || '').trim();
    if (!name) return;
    const desc = String(overlay.querySelector('#kb-share-desc').value || '').trim();
    const joinMode = overlay.querySelector('#kb-share-join').value;
    const permItem = overlay.querySelector('.kb-share-perm-item.is-selected');
    const memberPermission = permItem ? permItem.dataset.perm : 'view_export';
    const questions = String(overlay.querySelector('#kb-share-questions').value || '')
      .split(/\n+/).map((q) => q.trim()).filter(Boolean).slice(0, 10);
    const okBtn = overlay.querySelector('#kb-share-ok');
    okBtn.disabled = true;
    okBtn.textContent = '创建中…';
    try {
      const res = await window.cogseed.invoke('spaces.create', {
        name,
        shared: true,
        join_mode: joinMode,
        member_permission: memberPermission,
        description: desc || undefined,
        cover: _kbShareCover || undefined,
        recommended_questions: questions.length ? questions : undefined,
      });
      if (res && res.ok === false) throw new Error(res.error || 'create failed');
      _kbShareCloseDialog();
      if (typeof uiToast === 'function') uiToast('共享知识库已创建', { variant: 'success', timeoutMs: 2000 });
      await _loadAll();
      if (res && res.space && res.space.space_id) _selectSpace(res.space.space_id);
    } catch (err) {
      _log.warn('create shared space failed', err);
      okBtn.disabled = false;
      okBtn.textContent = '确定';
      const raw = String((err && err.message) || err || '');
      if (typeof uiToast === 'function') uiToast(`创建失败：${_kbSpaceErrText(raw)}`, { variant: 'error', timeoutMs: 3000 });
    }
  }

  // 共享库创建/重命名错误码 → 友好中文（name_dup 等英文码对用户不可读）
  function _kbSpaceErrText(raw) {
    if (!raw) return '未知错误';
    const m = String(raw);
    if (m.includes('name_dup') || m.includes('duplicate')) return '名称已存在，请换一个名称';
    if (m.includes('name_empty')) return '名称不能为空';
    if (m.includes('too_long')) return '名称或描述过长';
    if (m.includes('invalid_space_type')) return '空间类型无效';
    if (m.includes('not_found')) return '目标不存在';
    if (m.includes('invalid')) return '参数无效';
    if (m.includes('network') || m.includes('timed out')) return '网络超时，请重试';
    return m;
  }

  function _kbShareCloseDialog() {
    if (_kbShareDialog) {
      _kbShareDialog.remove();
      _kbShareDialog = null;
    }
  }

  // 空态：居中插图 + 大号主按钮（保留库头部骨架，不一片白板）
  // 空库（左侧无库）→ 创建知识库；库内无内容 → 「添加内容」打开与工具栏一致的导入菜单
  function _emptyStateHtml(kind) {
    const createBtn = kind === 'lib'
      ? '<button type="button" class="kb-empty-btn" id="kb-empty-create">＋ 创建知识库</button>'
      : '<button type="button" class="kb-empty-btn" id="kb-empty-add">＋ 添加内容</button>';
    return `<div class="kb-empty">
      <div class="kb-empty-illus">${_icon('book-open', 'kb-empty-ico')}</div>
      <div class="kb-empty-title">${kind === 'lib' ? '还没有知识库' : '知识库什么也没有，去这里添加'}</div>
      <div class="kb-empty-sub">${kind === 'lib' ? '创建一个知识库，或导入资料开始使用' : '支持文件、文件夹、网页、笔记等多种方式导入'}</div>
      <div class="kb-empty-actions">${createBtn}</div>
    </div>`;
  }

  // 空态按钮绑定：空库 → 创建；库内空 → 「添加内容」打开导入菜单（与工具栏同一入口）
  function _bindEmptyActions() {
    const create = document.getElementById('kb-empty-create');
    if (create) create.addEventListener('click', _createLib);
    const add = document.getElementById('kb-empty-add');
    if (add) add.addEventListener('click', (e) => {
      e.stopPropagation(); // 阻止冒泡到 document 的全局菜单关闭，否则菜单刚打开就被关闭
      const b = document.getElementById('kb-wb-import');
      if (b) b.click();
    });
  }

  // 共享库（空间）上传文件：spaces.files.pickAndUpload
  async function _importSpaceFiles() {
    if (!_state.spaceId) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    try {
      const res = await window.cogseed.invoke('spaces.files.pickAndUpload', { spaceId: _state.spaceId, targetDir: '' });
      if (res && res.ok === false) {
        if (typeof uiToast === 'function') uiToast('上传失败：' + _esc(res.error || 'unknown'), { variant: 'error' });
        return;
      }
      if (typeof uiToast === 'function') uiToast('已上传，开始索引…', { variant: 'success', timeoutMs: 1500 });
      _loadSpaceFiles(_state.spaceId);
    } catch (err) {
      _log.warn('space upload failed', err);
      if (typeof uiToast === 'function') uiToast('上传取消或失败', { variant: 'warning' });
    }
  }

  // 共享库（空间）上传文件夹：spaces.files.pickAndUploadDir（镜像目录结构导入）
  async function _importSpaceDir() {
    if (!_state.spaceId) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    try {
      const res = await window.cogseed.invoke('spaces.files.pickAndUploadDir', { spaceId: _state.spaceId, targetDir: '' });
      if (!res) return;
      if (res.canceled) return;
      const imported = Number(res.imported) || 0;
      const scanned = Number(res.scanned) || 0;
      if (typeof uiToast === 'function') {
        uiToast(imported ? `已导入 ${imported} 个文件（扫描 ${scanned}）` : '所选文件夹没有可导入的文件', {
          variant: imported ? 'success' : 'warning', timeoutMs: 2500,
        });
      }
      _loadSpaceFiles(_state.spaceId);
    } catch (err) {
      _log.warn('space import dir failed', err);
      if (typeof uiToast === 'function') uiToast('导入文件夹失败', { variant: 'error' });
    }
  }

  // ── 导入内容弹窗（共享库 ← 个人知识库文件多选，对标 ima 导入对话框）──
  let _dlgLib = '';          // 当前个人库名
  let _dlgDir = '';          // 当前目录（相对库根的路径段，'' = 库根）
  let _dlgHistory = []; // 目录历史（进入的子目录路径）
  let _dlgHistIdx = -1;      // 历史游标
  let _dlgSelected = new Set(); // 选中的文件 relPath（含库前缀，如 班级建设资料/a.pdf）
  let _dlgFilter = '';

  function _importDlgNode(libName, dirSegs) {
    const lib = _state.tree.find((n) => n.type === 'dir' && n.name === libName);
    if (!lib) return null;
    let node = lib;
    for (const seg of dirSegs) {
      const next = (node.children || []).find((n) => n.type === 'dir' && n.name === seg);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  function _importDlgRelPath(libName, dirSegs, name) {
    return [libName, ...dirSegs, name].filter(Boolean).join('/');
  }

  function _renderImportDlgList() {
    const overlay = document.querySelector('.kb-import-dlg-overlay');
    if (!overlay) return;
    const node = _importDlgNode(_dlgLib, _dlgDir.split('/').filter(Boolean));
    const q = _dlgFilter.trim().toLowerCase();
    // 子目录 + 文件（文件多选）
    const dirs = (node && node.children ? node.children : [])
      .filter((n) => n.type === 'dir')
      .filter((n) => !q || n.name.toLowerCase().includes(q));
    const files = (node && node.children ? node.children : [])
      .filter((n) => n.type === 'file')
      .filter((n) => !q || n.name.toLowerCase().includes(q));
    let html = '';
    for (const d of dirs) {
      html += `<div class="kb-import-dlg-row is-dir" data-import-dir="${_esc(d.name)}">
        ${_icon('folder', 'kb-import-dlg-ico')}
        <span class="kb-import-dlg-name">${_esc(d.name)}</span>
        <span class="kb-import-dlg-meta">文件夹</span>
      </div>`;
    }
    for (const f of files) {
      const rel = _importDlgRelPath(_dlgLib, _dlgDir.split('/').filter(Boolean), f.name);
      const checked = _dlgSelected.has(rel) ? ' checked' : '';
      html += `<div class="kb-import-dlg-row${checked}" data-import-file="${_esc(rel)}">
        <input type="checkbox" class="kb-import-dlg-check" data-import-check="${_esc(rel)}" ${checked ? 'checked' : ''} />
        <span class="kb-import-dlg-icon is-${_extClass(f.name)}">${_extLabel(f.name)}</span>
        <span class="kb-import-dlg-name" title="${_esc(f.name)}">${_esc(f.name)}</span>
        <span class="kb-import-dlg-meta">${_esc(_extLabel(f.name))}</span>
      </div>`;
    }
    if (!dirs.length && !files.length) {
      html = '<div class="kb-import-dlg-empty">' + (q ? '无匹配文件' : '此目录为空') + '</div>';
    }
    overlay.querySelector('.kb-import-dlg-files').innerHTML = html;
    // 路径栏
    const pathEl = overlay.querySelector('.kb-import-dlg-path');
    const segs = _dlgDir.split('/').filter(Boolean);
    pathEl.textContent = [_dlgLib, ...segs].join(' / ');
    _syncImportDlgFooter(overlay);
  }

  function _syncImportDlgFooter(overlay) {
    const countEl = overlay.querySelector('.kb-import-dlg-count');
    const okBtn = overlay.querySelector('.kb-import-dlg-ok');
    if (countEl) countEl.textContent = `已选中 ${_dlgSelected.size} 个文件`;
    if (okBtn) okBtn.disabled = _dlgSelected.size === 0;
  }

  function _bindImportDlgEvents(overlay) {
    overlay.querySelector('.kb-import-dlg-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.kb-import-dlg-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    // 返回 / 前进
    overlay.querySelector('.kb-import-dlg-back')?.addEventListener('click', () => {
      if (_dlgHistIdx <= 0) return;
      _dlgHistIdx -= 1;
      const cur = _dlgHistory[_dlgHistIdx];
      const parts = String(cur || '').split('/');
      _dlgLib = parts[0] || '';
      _dlgDir = parts.slice(1).join('/');
      _renderImportDlgList();
      _syncImportDlgNav(overlay);
    });
    overlay.querySelector('.kb-import-dlg-forward')?.addEventListener('click', () => {
      if (_dlgHistIdx >= _dlgHistory.length - 1) return;
      _dlgHistIdx += 1;
      const cur = _dlgHistory[_dlgHistIdx];
      const parts = String(cur || '').split('/');
      _dlgLib = parts[0] || '';
      _dlgDir = parts.slice(1).join('/');
      _renderImportDlgList();
      _syncImportDlgNav(overlay);
    });
    // 搜索
    const searchInput = overlay.querySelector('.kb-import-dlg-search input');
    searchInput?.addEventListener('input', (e) => {
      _dlgFilter = String(e.target.value || '').trim();
      _renderImportDlgList();
    });
    // 左侧树：切换知识库
    overlay.querySelectorAll('[data-import-lib]').forEach((el) => {
      el.addEventListener('click', () => {
        const name = el.dataset.importLib;
        _pushImportDlgHistory(`${name}`);
        _renderImportDlgList();
        overlay.querySelectorAll('[data-import-lib]').forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
        _syncImportDlgNav(overlay);
      });
    });
    // 右侧：子目录进入 / 文件勾选
    overlay.querySelector('.kb-import-dlg-files')?.addEventListener('click', (e) => {
      const dirEl = e.target.closest('[data-import-dir]');
      if (dirEl) {
        const segs = _dlgDir.split('/').filter(Boolean);
        segs.push(dirEl.dataset.importDir);
        _pushImportDlgHistory(`${_dlgLib}/${segs.join('/')}`);
        _dlgDir = segs.join('/');
        _renderImportDlgList();
        _syncImportDlgNav(overlay);
        return;
      }
      const checkEl = e.target.closest('[data-import-check]');
      if (checkEl) {
        const rel = checkEl.dataset.importCheck;
        if (_dlgSelected.has(rel)) _dlgSelected.delete(rel);
        else _dlgSelected.add(rel);
        // 只更新当前行选中态与底部统计，不重渲染整个列表（避免连续勾选时 DOM 重建丢事件）
        const row = checkEl.closest('.kb-import-dlg-row');
        if (row) row.classList.toggle('checked', _dlgSelected.has(rel));
        _syncImportDlgFooter(overlay);
        return;
      }
      const rowEl = e.target.closest('[data-import-file]');
      if (rowEl) {
        const rel = rowEl.dataset.importFile;
        if (_dlgSelected.has(rel)) _dlgSelected.delete(rel);
        else _dlgSelected.add(rel);
        rowEl.classList.toggle('checked', _dlgSelected.has(rel));
        const cb = rowEl.querySelector('[data-import-check]');
        if (cb) cb.checked = _dlgSelected.has(rel);
        _syncImportDlgFooter(overlay);
      }
    });
    // 导入
    overlay.querySelector('.kb-import-dlg-ok')?.addEventListener('click', async () => {
      if (!_dlgSelected.size) return;
      const files = Array.from(_dlgSelected);
      const okBtn = overlay.querySelector('.kb-import-dlg-ok');
      okBtn.disabled = true;
      okBtn.textContent = '导入中…';
      try {
        const res = await window.cogseed.invoke('spaces.files.importFromLibFiles', { spaceId: _state.spaceId, paths: files });
        if (!res || res.ok === false) {
          if (typeof uiToast === 'function') uiToast('导入失败：' + ((res && res.error) || 'unknown'), { variant: 'error' });
          return;
        }
        if (typeof uiToast === 'function') {
          uiToast(`已导入 ${Number(res.imported) || 0} 个文件`, { variant: 'success', timeoutMs: 2500 });
        }
        overlay.remove();
        _loadSpaceFiles(_state.spaceId);
      } catch (err) {
        _log.warn('import dlg files failed', err);
        if (typeof uiToast === 'function') uiToast('导入失败', { variant: 'error' });
        okBtn.disabled = false;
        okBtn.textContent = '导入';
      }
    });
  }

  function _pushImportDlgHistory(loc) {
    // 剪掉游标之后的旧前进记录
    _dlgHistory = _dlgHistory.slice(0, _dlgHistIdx + 1);
    _dlgHistory.push(loc);
    _dlgHistIdx = _dlgHistory.length - 1;
    _syncImportDlgNav(document.querySelector('.kb-import-dlg-overlay'));
  }

  function _syncImportDlgNav(overlay) {
    if (!overlay) return;
    const back = overlay.querySelector('.kb-import-dlg-back');
    const fwd = overlay.querySelector('.kb-import-dlg-forward');
    if (back) back.disabled = _dlgHistIdx <= 0;
    if (fwd) fwd.disabled = _dlgHistIdx >= _dlgHistory.length - 1;
  }

  // 共享库（空间）导入个人知识库：打开「导入内容」多选弹窗（对标 ima）
  async function _importSpaceFromLib() {
    if (!_state.spaceId) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    // 确保个人库树已加载
    if (!_state.libs.length) {
      if (typeof uiToast === 'function') uiToast('没有可导入的个人知识库', { variant: 'warning' });
      return;
    }
    _dlgLib = _state.libs[0].name;
    _dlgDir = '';
    _dlgHistory = [_dlgLib];
    _dlgHistIdx = 0;
    _dlgSelected = new Set();
    _dlgFilter = '';
    const libItems = _state.libs.map((l, i) =>
      `<div class="kb-import-dlg-lib${i === 0 ? ' active' : ''}" data-import-lib="${_esc(l.name)}">
        ${_icon('folder', 'kb-import-dlg-ico')}<span class="kb-import-dlg-name">${_esc(l.name)}</span>
      </div>`).join('') || '<div class="kb-import-dlg-empty">暂无个人知识库</div>';
    const overlay = document.createElement('div');
    overlay.className = 'kb-import-dlg-overlay';
    overlay.innerHTML = `
      <div class="kb-import-dlg">
        <div class="kb-import-dlg-head">
          <div class="kb-import-dlg-title"><span class="kb-import-dlg-title-ico">${_svg('upload')}</span>导入内容</div>
          <div class="kb-import-dlg-search">
            <span class="kb-import-dlg-search-ico">${_svg('search')}</span>
            <input type="text" placeholder="搜索" autocomplete="off" spellcheck="false" />
          </div>
          <button type="button" class="kb-import-dlg-close" title="关闭">✕</button>
        </div>
        <div class="kb-import-dlg-nav">
          <button type="button" class="kb-import-dlg-back" title="返回">←</button>
          <button type="button" class="kb-import-dlg-forward" title="前进">→</button>
          <span class="kb-import-dlg-path"></span>
        </div>
        <div class="kb-import-dlg-body">
          <div class="kb-import-dlg-tree">
            <div class="kb-import-dlg-group">个人知识库</div>
            <div class="kb-import-dlg-libs">${libItems}</div>
          </div>
          <div class="kb-import-dlg-files"></div>
        </div>
        <div class="kb-import-dlg-foot">
          <span class="kb-import-dlg-count">已选中 0 个文件</span>
          <div class="kb-import-dlg-actions">
            <button type="button" class="kb-import-dlg-cancel">取消</button>
            <button type="button" class="kb-import-dlg-ok" disabled>导入</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    _bindImportDlgEvents(overlay);
    _renderImportDlgList();
    _syncImportDlgNav(overlay);
  }

  // 导入菜单「新建文件夹」：个人库 contexts.mkdir / 空间 spaces.files.mkdir
  async function _kbNewFolder() {
    const name = typeof uiPrompt === 'function' ? await uiPrompt('新建文件夹名称：', '') : window.prompt('新建文件夹名称：', '');
    if (!name || !name.trim()) return;
    const clean = String(name).trim().replace(/[\\/:*?"<>|]/g, '_');
    try {
      if (_state.spaceId) {
        const res = await window.cogseed.invoke('spaces.files.mkdir', { spaceId: _state.spaceId, path: clean });
        if (res && res.ok === false) throw new Error(res.error || 'mkdir failed');
      } else {
        const target = `${_state.currentLib || ''}/${clean}`;
        const res = await window.cogseed.invoke('contexts.mkdir', { path: target });
        if (res && res.ok === false) throw new Error(res.error || 'mkdir failed');
        _state.expanded.add(_state.currentLib || '');
      }
      if (typeof uiToast === 'function') uiToast('文件夹已创建', { variant: 'success', timeoutMs: 1500 });
      _loadAll();
    } catch (err) {
      _log.warn('new folder failed', err);
      if (typeof uiToast === 'function') uiToast('创建失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // 导入菜单「新建笔记」：在库内创建一篇 Markdown 笔记
  async function _kbNewNote() {
    const title = typeof uiPrompt === 'function' ? await uiPrompt('笔记标题：', '') : window.prompt('笔记标题：', '');
    const name = (title && title.trim()) ? String(title).trim() : `笔记-${Date.now()}`;
    const fileName = `${name.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    const content = `# ${name}\n\n`;
    try {
      if (_state.spaceId) {
        const res = await window.cogseed.invoke('spaces.files.createText', { spaceId: _state.spaceId, name: fileName });
        if (res && res.ok === false) throw new Error(res.error || 'create failed');
      } else {
        const path = `${_state.currentLib || ''}/${fileName}`;
        const res = await window.cogseed.invoke('contexts.write', { path, content });
        if (res && res.ok === false) throw new Error(res.error || 'create failed');
      }
      if (typeof uiToast === 'function') uiToast(`笔记「${fileName}」已创建`, { variant: 'success', timeoutMs: 2000 });
      _loadAll();
    } catch (err) {
      _log.warn('new note failed', err);
      if (typeof uiToast === 'function') uiToast('创建笔记失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // 导入菜单「网页链接」：抓取网页 → 存为 Markdown 到当前库
  async function _kbImportWebUrl() {
    const url = typeof uiPrompt === 'function' ? await uiPrompt('输入网页链接（http/https）：', 'https://') : window.prompt('输入网页链接：', 'https://');
    if (!url || !url.trim()) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    if (typeof uiToast === 'function') uiToast('正在抓取网页内容…', { variant: 'info' });
    try {
      const res = await window.cogseed.invoke('kb.importWebUrl', {
        dir: _state.spaceId ? null : (_state.currentLib || null),
        spaceId: _state.spaceId || null,
        url: String(url).trim(),
      });
      if (!res || res.ok === false) {
        if (typeof uiToast === 'function') uiToast('导入失败：' + ((res && res.error) || 'unknown'), { variant: 'error' });
        return;
      }
      if (typeof uiToast === 'function') uiToast(`已导入网页：${res.fileName || ''}`, { variant: 'success', timeoutMs: 2500 });
      if (_state.spaceId) _loadSpaceFiles(_state.spaceId); else _loadAll();
    } catch (err) {
      _log.warn('web import failed', err);
      if (typeof uiToast === 'function') uiToast('导入失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // 导入菜单「个人知识库」：把其他个人库的内容复制进当前库
  async function _kbMigrateLib() {
    if (!_state.currentLib) {
      if (typeof uiToast === 'function') uiToast('请先选择目标知识库', { variant: 'warning' });
      return;
    }
    const sources = (_state.libs || []).map((l) => l.name).filter((n) => n !== _state.currentLib);
    if (!sources.length) {
      if (typeof uiToast === 'function') uiToast('没有其他可迁移的个人知识库', { variant: 'warning' });
      return;
    }
    const prompt = typeof uiPrompt === 'function' ? uiPrompt : (m, d) => Promise.resolve(window.prompt(m, d));
    const src = await prompt(`从哪个个人知识库迁移内容到「${_state.currentLib}」？\n可选：${sources.join('、')}`, '');
    if (!src || !src.trim()) return;
    const clean = String(src).trim();
    if (!sources.includes(clean)) {
      if (typeof uiToast === 'function') uiToast('源知识库不存在', { variant: 'warning' });
      return;
    }
    try {
      const res = await window.cogseed.invoke('kb.migrateLib', { from: clean, to: _state.currentLib });
      if (!res || res.ok === false) {
        if (typeof uiToast === 'function') uiToast('迁移失败：' + ((res && res.error) || 'unknown'), { variant: 'error' });
        return;
      }
      if (typeof uiToast === 'function') uiToast(`已从「${clean}」迁移到「${_state.currentLib}」，正在重新索引…`, { variant: 'success', timeoutMs: 2500 });
      await _loadAll();
      window.cogseed.invoke('kb.reconcile', {}).catch(() => {});
    } catch (err) {
      _log.warn('migrate lib failed', err);
      if (typeof uiToast === 'function') uiToast('迁移失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // ── 文件列表 ──
  // 文件夹内联展开/折叠：递归渲染，点击文件夹行或箭头在**原位**展开/收起
  // 子目录，不跳转、不触碰右侧问答区。
  function _renderFiles() {
    const list = document.getElementById('kb-wb-files');
    if (!list) return;
    if (_state.spaceId) {
      _renderSpaceFiles(list);
      return;
    }
    const lib = _findLibNode(_state.currentLib);
    const q = _state.filter.trim().toLowerCase();
    const parts = [];
    if (lib) _renderNodeRows(parts, lib.children || [], 0, lib.path || _state.currentLib, q);
    // 底部：没有更多内容了（对齐 ima 列表结束提示）
    const endTip = parts.length ? '<div class="kb-files-end">没有更多内容了</div>' : '';
    if (!parts.length && q) {
      // 搜索无结果：显示"无匹配"占位，不显示空库引导（避免误导为新库）
      list.innerHTML = '<div class="kb-empty"><div class="kb-empty-title">无匹配文档</div><div class="kb-empty-sub">换个关键词试试，支持按文件名搜索库内所有文件（含文件夹中的文件）</div></div>';
    } else {
      list.innerHTML = (parts.join('') + endTip) || _emptyStateHtml('file');
      if (!parts.length) _bindEmptyActions();
    }

    list.querySelectorAll('[data-kb-dir]').forEach((el) => {
      el.addEventListener('click', () => _toggleDir(el.dataset.kbDir));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        _kbRowMenu(el.dataset.kbDir, true, e.clientX, e.clientY);
      });
    });
    list.querySelectorAll('[data-kb-file]').forEach((el) => {
      el.addEventListener('click', () => _openFile(el.dataset.kbFile));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        _kbRowMenu(el.dataset.kbFile, false, e.clientX, e.clientY);
      });
      const moreBtn = el.querySelector('.kb-mini-btn[title="更多"]');
      if (moreBtn) moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _kbRowMenu(el.dataset.kbFile, false, e.clientX, e.clientY);
      });
    });
    _renderCount(lib ? _countFiles(lib) : 0);
    _renderRight();
  }

  // 文件排序（对齐 ima：更新时间/大小/类型/名称）
  function _sortFiles(list) {
    const s = _state.sort;
    const arr = list.slice();
    if (s === 'updated') arr.sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
    else if (s === 'size') arr.sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0));
    else if (s === 'type') arr.sort((a, b) => _extLabel(a.name).localeCompare(_extLabel(b.name)) || String(a.name).localeCompare(String(b.name)));
    else arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return arr;
  }

  // 日期（mtime 秒 → M/D）
  function _fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms) * 1000);
    if (isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // 搜索模式下文件行显示所在目录（相对当前库，根目录显示「库根」）
  function _relDirLabel(parentPath) {
    const cur = String(_state.currentLib || '');
    const base = cur ? new RegExp('^' + _escReg(cur) + '(?:/|$)') : null;
    const rel = base ? String(parentPath || '').replace(base, '').replace(/\/+$/, '') : String(parentPath || '');
    return rel ? `📁 ${rel}` : '库根';
  }

  function _escReg(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function _renderNodeRows(parts, children, level, parentPath, q) {
    const pad = 16 + level * 20;
    // 搜索模式：无视展开状态递归全树，匹配的目录/文件都展示（文件标注所在目录）
    if (q) {
      const dirs = (children || [])
        .filter((n) => n.type === 'dir' && n.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = _sortFiles((children || [])
        .filter((n) => n.type === 'file' && n.name.toLowerCase().includes(q)));
      for (const d of dirs) {
        const path = `${parentPath}/${d.name}`;
        parts.push(`<div class="kb-file-row is-dir" data-kb-dir="${_esc(path)}" style="padding-left:${pad}px">
          ${_icon('chevron-right', 'kb-mini-ico kb-dir-caret')}
          ${_icon('folder-open', 'kb-file-icon-svg is-dir')}
          <span class="kb-file-name">${_esc(d.name)}</span>
          <span class="kb-file-meta">${_countFiles(d)} 项</span>
          <span class="kb-file-actions"><button type="button" class="kb-mini-btn" data-kb-dir-toggle="${_esc(path)}" title="展开">${_icon('chevron-right', 'kb-mini-ico')}</button></span>
        </div>`);
      }
      for (const f of files) {
        const rel = `${parentPath}/${f.name}`;
        parts.push(`<div class="kb-file-row" data-kb-file="${_esc(rel)}" style="padding-left:${pad}px">
          <span class="kb-file-icon is-${_extClass(f.name)}">${_extLabel(f.name)}</span>
          <span class="kb-file-name">${_esc(f.name)}</span>
          <span class="kb-file-meta">${_esc(_relDirLabel(parentPath))}</span>
          <span class="kb-file-date">${_fmtDate(f.mtime)}</span>
          ${_statusChip(rel)}
          <span class="kb-file-actions"><button type="button" class="kb-mini-btn" title="生成思维导图（S3）">${_icon('sparkles', 'kb-mini-ico')}</button><button type="button" class="kb-mini-btn" title="更多">${_icon('more-horizontal', 'kb-mini-ico')}</button></span>
        </div>`);
      }
      for (const d of (children || []).filter((n) => n.type === 'dir')) {
        _renderNodeRows(parts, d.children || [], level + 1, `${parentPath}/${d.name}`, q);
      }
      return;
    }
    const dirs = (children || [])
      .filter((n) => n.type === 'dir')
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = _sortFiles((children || [])
      .filter((n) => n.type === 'file'));
    for (const d of dirs) {
      const path = `${parentPath}/${d.name}`;
      const open = _state.expanded.has(path);
      const caret = open
        ? _icon('chevron-down', 'kb-mini-ico kb-dir-caret')
        : _icon('chevron-right', 'kb-mini-ico kb-dir-caret');
      parts.push(`<div class="kb-file-row is-dir" data-kb-dir="${_esc(path)}" style="padding-left:${pad}px">
        ${caret}
        ${_icon('folder-open', 'kb-file-icon-svg is-dir')}
        <span class="kb-file-name">${_esc(d.name)}</span>
        <span class="kb-file-meta">${_countFiles(d)} 项</span>
        <span class="kb-file-actions"><button type="button" class="kb-mini-btn" data-kb-dir-toggle="${_esc(path)}" title="${open ? '折叠' : '展开'}">${_icon(open ? 'chevron-down' : 'chevron-right', 'kb-mini-ico')}</button></span>
      </div>`);
      if (open) _renderNodeRows(parts, d.children || [], level + 1, path, q);
    }
    for (const f of files) {
      const rel = `${parentPath}/${f.name}`;
      parts.push(`<div class="kb-file-row" data-kb-file="${_esc(rel)}" style="padding-left:${pad}px">
        <span class="kb-file-icon is-${_extClass(f.name)}">${_extLabel(f.name)}</span>
        <span class="kb-file-name">${_esc(f.name)}</span>
        <span class="kb-file-meta">${_esc(_extLabel(f.name))}</span>
        <span class="kb-file-date">${_fmtDate(f.mtime)}</span>
        ${_statusChip(rel)}
        <span class="kb-file-actions"><button type="button" class="kb-mini-btn" title="生成思维导图（S3）">${_icon('sparkles', 'kb-mini-ico')}</button><button type="button" class="kb-mini-btn" title="更多">${_icon('more-horizontal', 'kb-mini-ico')}</button></span>
      </div>`);
    }
  }

  function _toggleDir(path) {
    if (_state.expanded.has(path)) _state.expanded.delete(path);
    else _state.expanded.add(path);
    _renderFiles();
  }

  function _renderSpaceFiles(list) {
    const q = _state.filter.trim().toLowerCase();
    const files = _sortFiles(_state.spaceFiles
      .filter((f) => !q || (f.name || f.path || '').toLowerCase().includes(q)));
    let html = '';
    for (const f of files) {
      const status = f.status || 'pending';
      const chip = status === 'ready'
        ? `<span class="kb-file-status is-ready" title="chunks: ${f.chunks ?? 0}">✓ 已索引</span>`
        : status === 'processing' ? '<span class="kb-file-status is-run">索引中…</span>'
          : status === 'failed' ? '<span class="kb-file-status is-failed" title="' + _esc(f.error || '') + '">失败</span>'
            : '<span class="kb-file-status is-run">排队中</span>';
      html += `<div class="kb-file-row" data-kb-space-file="${_esc(f.path || f.name)}">
        <span class="kb-file-icon is-${_extClass(f.name || f.path)}">${_extLabel(f.name || f.path)}</span>
        <span class="kb-file-name">${_esc(f.name || f.path)}</span>
        <span class="kb-file-meta">${_esc(_extLabel(f.name || f.path))}</span>
        <span class="kb-file-date">${_fmtDate(f.mtime)}</span>
        ${chip}
        <span class="kb-file-actions"><button type="button" class="kb-mini-btn" title="生成思维导图（S3）">${_icon('sparkles', 'kb-mini-ico')}</button><button type="button" class="kb-mini-btn" title="更多">${_icon('more-horizontal', 'kb-mini-ico')}</button></span>
      </div>`;
    }
    // 底部：没有更多内容了（对齐 ima 列表结束提示）
    if (files.length) html += '<div class="kb-files-end">没有更多内容了</div>';
    if (!html && q) {
      // 搜索无结果：不显示空库引导
      list.innerHTML = '<div class="kb-empty"><div class="kb-empty-title">无匹配文档</div><div class="kb-empty-sub">换个关键词试试，支持按文件名搜索库内所有文件（含文件夹中的文件）</div></div>';
      _renderCount(0);
      _renderRight();
      return;
    }
    if (!html) html = _emptyStateHtml('file');
    list.innerHTML = html;
    _bindEmptyActions();
    list.querySelectorAll('[data-kb-space-file]').forEach((el) => {
      el.addEventListener('click', () => {
        if (typeof uiToast === 'function') uiToast('空间库原文查看：后续版本支持', { variant: 'info' });
      });
      // 共享库文件右键：置顶/编辑标签/重命名/成员权限▸/移动到/复制到/删除（对齐 ima）
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        _kbSpaceFileMenu(el.dataset.kbSpaceFile, e.clientX, e.clientY);
      });
      // 「…」按钮 = 与右键同一菜单（保持入口一致）
      const moreBtn = el.querySelector('.kb-mini-btn[title="更多"]');
      if (moreBtn) {
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const b = el.getBoundingClientRect();
          _kbSpaceFileMenu(el.dataset.kbSpaceFile, b.x + b.width - 40, b.y + 20);
        });
      }
    });
    const crumb = document.getElementById('kb-wb-crumb');
    if (crumb) crumb.hidden = true;
    const count = document.getElementById('kb-wb-count');
    if (count) count.textContent = String(files.length);
    _renderRight();
  }

  function _countFiles(node) {
    let n = 0;
    const walk = (x) => {
      for (const c of (x.children || [])) {
        if (c.type === 'file') n += 1;
        else walk(c);
      }
    };
    walk(node);
    return n;
  }

  function _pushDir(name) {
    _state.dirStack.push(name);
    _renderFiles();
  }

  function _popDir() {
    _state.dirStack.pop();
    _renderFiles();
  }

  function _renderCrumb() {
    const crumb = document.getElementById('kb-wb-crumb');
    if (!crumb) return;
    if (!_state.dirStack.length) {
      crumb.hidden = true;
      return;
    }
    crumb.hidden = false;
    const parts = [`<span class="kb-crumb-link" data-kb-crumb="root">${_esc(_state.currentLib)}</span>`];
    _state.dirStack.forEach((seg, i) => {
      parts.push('<span class="kb-crumb-sep">/</span>');
      if (i === _state.dirStack.length - 1) parts.push(`<span class="kb-crumb-cur">${_esc(seg)}</span>`);
      else parts.push(`<span class="kb-crumb-link" data-kb-crumb="${i}">${_esc(seg)}</span>`);
    });
    crumb.innerHTML = parts.join('');
    crumb.querySelectorAll('[data-kb-crumb]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = el.dataset.kbCrumb === 'root' ? -1 : Number(el.dataset.kbCrumb);
        _state.dirStack = idx >= 0 ? _state.dirStack.slice(0, idx + 1) : [];
        _renderFiles();
      });
    });
  }

  function _renderCount(n) {
    const el = document.getElementById('kb-wb-count');
    if (el) el.textContent = String(n);
  }

  function _openFile(relPath) {
    // S2 接入 anchor-resolver 原文查看器；S1 先提示。
    if (typeof uiToast === 'function') uiToast('原文查看器：S2 上线（anchor-resolver 已就绪）', { variant: 'info' });
    _log.info('open file', relPath);
  }

  // 问答区提示：无消息时显示「基于某库提问」引导
  function _maybeShowQaHint() {
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    const hasMsg = !!box.querySelector('.kb-qa-msg');
    const hint = box.querySelector('.kb-qa-hint');
    if (!hasMsg && !hint) {
      const h = document.createElement('div');
      h.className = 'kb-qa-hint';
      h.innerHTML = `<div class="kb-qa-hint-ico">${_svg('sparkles')}</div>
        <div class="kb-qa-hint-title">基于知识库问答</div>
        <div class="kb-qa-hint-sub">提问后回答只引用库内资料并标注锚点</div>`;
      box.appendChild(h);
    } else if (hasMsg && hint) {
      hint.remove();
    }
  }

  // 仅移除空状态占位（不创建）——发问后调用，避免测试/环境副作用
  function _removeQaHint() {
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    const hint = box.querySelector('.kb-qa-hint');
    if (hint) hint.remove();
  }

  // 渲染本次提问挂载的附件卡片（输入框上方，最多 5 个）
  function _renderQaAttachments() {
    const strip = document.getElementById('kb-qa-attach-strip');
    if (!strip) return;
    const atts = _state.qaAttachments || [];
    if (!atts.length) { strip.hidden = true; strip.innerHTML = ''; return; }
    strip.hidden = false;
    strip.innerHTML = atts.map((a, i) => {
      const ext = String(a.name || '').split('.').pop().toUpperCase();
      const size = a.size >= 1024 ? `${(a.size / 1024).toFixed(1)}KB` : `${a.size || 0}B`;
      return `<div class="kb-qa-attach-chip">
        <span class="kb-qa-attach-ico is-${String(ext).toLowerCase()}">${_esc(ext)}</span>
        <span class="kb-qa-attach-name" title="${_esc(a.name)}">${_esc(a.name)}</span>
        <span class="kb-qa-attach-meta">${_esc(ext)} ${_esc(size)}</span>
        <button type="button" class="kb-qa-attach-rm" data-attach-idx="${i}" title="移除附件">✕</button>
      </div>`;
    }).join('');
    strip.querySelectorAll('[data-attach-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.attachIdx);
        _state.qaAttachments.splice(idx, 1);
        _renderQaAttachments();
      });
    });
  }

  function _clearQa() {
    const box = document.getElementById('kb-qa-messages');
    if (box) box.innerHTML = '';
    _maybeShowQaHint();
  }

  // ── 右区（S2：基于知识库问答；AI 解析卡 S3 填充）──
  function _renderRight() {
    const body = document.getElementById('kb-wb-right');
    // 手动解析按钮：每次渲染右区恢复可点击（生成中由 _loadSummary 禁用）
    const analyzeBtn = document.getElementById('kb-analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.disabled = false;
      if (!analyzeBtn.dataset.bound) {
        analyzeBtn.dataset.bound = '1';
        analyzeBtn.addEventListener('click', () => _loadSummary());
      }
    }
    const isSpace = !!_state.spaceId;
    const dispName = isSpace ? _state.spaceName : (_state.currentLib || '知识库');
    const nameEl = document.getElementById('kb-wb-lib-name');
    if (nameEl) nameEl.textContent = dispName;
    const cover = document.getElementById('kb-wb-lib-cover');
    if (cover) cover.style.background = isSpace
      ? 'linear-gradient(135deg, #BFF0DD, #7FDCB8)'
      : 'linear-gradient(135deg, #D9F2E7, #A9E4C8)';
    const tagEl = document.getElementById('kb-wb-lib-tag');
    if (tagEl) tagEl.textContent = isSpace ? '共享知识库' : '个人知识库';
    // 创建者（单用户客户端 = 本人）+ 描述（共享库有 description，否则占位提示）
    const ownerEl = document.getElementById('kb-wb-owner-name');
    if (ownerEl) ownerEl.textContent = '我';
    const avatarEl = document.getElementById('kb-wb-owner-avatar');
    if (avatarEl) avatarEl.textContent = (dispName || '我').trim().charAt(0);
    const descEl = document.getElementById('kb-wb-lib-desc');
    if (descEl) {
      const sp = isSpace ? _state.spaces.find((x) => x.space_id === _state.spaceId) : null;
      const desc = sp && sp.description ? String(sp.description) : '';
      descEl.textContent = desc || '快来填写描述吧~';
      descEl.classList.toggle('is-empty', !desc);
    }
    const membersEl = document.getElementById('kb-wb-members');
    if (membersEl) {
      // 成员入口仅共享知识库显示（个人知识库单用户，无成员概念）
      membersEl.style.display = isSpace ? '' : 'none';
      if (isSpace) {
        membersEl.textContent = '1 加入';
        if (!membersEl.dataset.bound) {
          membersEl.dataset.bound = '1';
          membersEl.style.cursor = 'pointer';
          membersEl.addEventListener('click', () => _kbMembersDialog());
        }
      }
    }
    const rightLib = document.getElementById('kb-wb-right-lib');
    if (rightLib) rightLib.textContent = dispName;
    if (!body) return;
    // 右区结构（解析卡 + 消息区）已在 renderKbWorkbench 首次构建时写入 DOM，
    // 这里只更新头部信息，绝不触碰 body 内容 —— 问答消息不可能被覆盖。
    const sub = document.getElementById('kb-wb-analysis-sub');
    if (sub) {
      const count = isSpace ? _state.spaceFiles.length : (_findLibNode(_state.currentLib) ? _countFiles(_findLibNode(_state.currentLib)) : 0);
      sub.textContent = `当前库：${_esc(dispName)} · ${count} 个内容`;
    }
    _maybeShowQaHint();
  }

  // ── AI 解析（S3：kb.summary → 逐文档要点 + 一句话总结 + 脑图骨架）──
  // 切换库/空间时把解析卡重置为「未解析」态：脑图/测验入口保持可见（禁用），
  // 避免用户误以为功能消失；点击「✨ 生成 AI 解析」后启用。
  function _resetAnalysisCard() {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    card.innerHTML = `
      <div class="kb-wb-right-card-title">
        <span><span class="kb-wb-ai-chip"></span>AI 解析本知识库</span>
        <span class="kb-wb-card-actions">
          <button type="button" class="kb-wb-a-btn is-primary" id="kb-wb-gen-mm" disabled title="请先点击「✨ 生成 AI 解析」">🧠 生成脑图</button>
          <button type="button" class="kb-wb-a-btn" id="kb-wb-gen-quiz" disabled title="请先点击「✨ 生成 AI 解析」">📝 生成测验</button>
        </span>
      </div>
      <div class="kb-wb-right-card-sub" id="kb-wb-analysis-sub">当前库：—</div>
      <div class="kb-wb-right-placeholder"><button type="button" class="kb-wb-a-btn" id="kb-analyze-btn">✨ 生成 AI 解析</button></div>`;
    // 重新绑定手动解析按钮（原按钮随 innerHTML 替换销毁）
    const analyzeBtn = card.querySelector('#kb-analyze-btn');
    if (analyzeBtn) analyzeBtn.addEventListener('click', () => _loadSummary());
  }

  function _loadSummary() {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    const lib = _state.currentLib || '';
    const key = _state.spaceId ? `space:${_state.spaceId}` : lib;
    const reqKey = key; // 捕获发起时的库，回调时校验是否仍处于该库
    // 手动触发：打开/切库不再自动跑 LLM（避免后台推理占满 CPU）
    const btn = document.getElementById('kb-analyze-btn');
    if (btn) btn.disabled = true; // 生成中禁用
    if (_state.summaryLib === key) {
      if (btn) btn.disabled = false;
      return; // 同一库已解析过（缓存命中）
    }
    _state.summaryLib = key;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      card.innerHTML = '<div class="kb-wb-right-card-title"><span class="kb-wb-ai-chip"></span>AI 解析本知识库</div><div class="kb-wb-right-placeholder">解析服务不可用</div>';
      return;
    }
    const holder = card.querySelector('.kb-wb-right-placeholder');
    if (holder) {
      const isSpace = !!_state.spaceId;
      const count = isSpace ? _state.spaceFiles.length
        : (_findLibNode(_state.currentLib) ? _countFiles(_findLibNode(_state.currentLib)) : 0);
      holder.textContent = isSpace ? '正在解析…' : `正在解析… 共 ${count} 个文件`;
    }
    window.cogseed.invoke('kb.summary', {
      dir: _state.spaceId ? null : (lib || null),
      spaceId: _state.spaceId || null,
    })
      .then((res) => {
        const b2 = document.getElementById('kb-analyze-btn');
        if (b2) b2.disabled = false;
        if (!res) return;
        // 竞态校验：若解析期间用户切换了库，丢弃旧结果（缓存仍保留，切回时可恢复）
        const curKey = _state.spaceId ? `space:${_state.spaceId}` : (_state.currentLib || '');
        if (curKey !== reqKey) return;
        _state.summaryCache[reqKey] = res;
        _state.summaryLib = reqKey;
        _state.summary = res;
        _renderAnalysis(res);
      })
      .catch(() => {
        const b2 = document.getElementById('kb-analyze-btn');
        if (b2) b2.disabled = false;
        const h = card.querySelector('.kb-wb-right-placeholder');
        if (h) h.textContent = '解析失败，请点击「✨ 生成 AI 解析」重试。';
      });
  }

  // AI 解析卡：操作组（展开/生成脑图/生成测验）归卡片标题行右侧；
  // 一句话总结 = 只读文本（左绿条，无输入框感）；降级态按钮置灰不可用。
  function _renderAnalysis(summary) {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    const docs = Array.isArray(summary.docs) ? summary.docs : [];
    const oneLiner = String(summary.oneLiner || '');
    const mm = summary.mindmap || {};
    const hasMm = !!(mm.root && Array.isArray(mm.kids) && mm.kids.length);
    const ok = summary.source !== 'degraded' || docs.some((d) => d.text);
    const srcTag = summary.source === 'cached' ? ' <span class="kb-wb-card-src">(缓存)</span>'
      : summary.source === 'degraded' ? ' <span class="kb-wb-card-src">(降级)</span>' : '';

    const actions = `<span class="kb-wb-card-actions">
      <button type="button" class="kb-wb-a-btn is-primary" id="kb-wb-gen-mm"${ok && hasMm ? '' : ' disabled'}>🧠 生成脑图</button>
      <button type="button" class="kb-wb-a-btn" id="kb-wb-gen-quiz"${ok ? '' : ' disabled'}>📝 生成测验</button>
      <button type="button" class="kb-wb-analysis-toggle" id="kb-wb-analysis-toggle">展开 ▾</button>
    </span>`;

    let html = `<div class="kb-wb-right-card-title">
      <span><span class="kb-wb-ai-chip"></span>AI 解析本知识库${srcTag}<span class="kb-wb-card-src">（${docs.length} 个文档）</span></span>
      ${actions}
    </div>`;

    if (ok) {
      if (oneLiner) {
        html += `<div class="kb-wb-one-liner"><span class="kb-wb-one-liner-tag">💡 一句话总结</span><span class="kb-wb-one-liner-text">${_esc(oneLiner)}</span></div>`;
      }
      html += `<div class="kb-wb-analysis-body" id="kb-wb-analysis-body" hidden>`;
      for (const d of docs) {
        html += `<div class="kb-wb-doc">
          <div class="kb-wb-doc-head">
            <span class="kb-wb-doc-name">${_esc(d.name)}</span>
            <button type="button" class="kb-qa-chip" data-kb-anchor="${_esc(d.file)}">${_esc(d.file)}#chunk 1 ↗</button>
          </div>`;
        if (d.text) html += `<div class="kb-wb-doc-text">${_esc(d.text)}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
    } else {
      const degNote = document.getElementById('kb-qa-degraded-note');
      if (degNote) degNote.hidden = false;
      html += `<div class="kb-wb-right-placeholder">${_esc(oneLiner || 'AI 解析失败，已降级为文件清单。')}</div>`;
      if (docs.length) {
        html += `<div class="kb-wb-doc-list">${docs.map((d) =>
          `<div class="kb-wb-doc-row"><span class="kb-wb-doc-name">${_esc(d.name)}</span></div>`).join('')}</div>`;
      }
    }
    card.innerHTML = html;
    const degNote = document.getElementById('kb-qa-degraded-note');
    if (degNote && ok) degNote.hidden = true;

    const mmBtn = card.querySelector('#kb-wb-gen-mm');
    if (mmBtn && !mmBtn.disabled) mmBtn.addEventListener('click', () => _genMindmap());
    const quizBtn = card.querySelector('#kb-wb-gen-quiz');
    if (quizBtn && !quizBtn.disabled) quizBtn.addEventListener('click', () => _renderQuiz(summary));
    card.querySelector('#kb-wb-analysis-toggle')?.addEventListener('click', () => {
      const body = card.querySelector('#kb-wb-analysis-body');
      const btn = card.querySelector('#kb-wb-analysis-toggle');
      if (!body || !btn) return;
      const open = body.hidden;
      body.hidden = !open;
      btn.textContent = open ? '收起 ▴' : '展开 ▾';
    });
    card.querySelectorAll('[data-kb-anchor]').forEach((el) => {
      el.addEventListener('click', () => _openAnchor({ source: 'library', scope: 'global', path: el.dataset.kbAnchor, chunkIdx: 1 }));
    });
    _state.summary = summary;
    // 同步写入按库缓存（切回时立即恢复，不重新触发 LLM）
    const cacheKey = _state.spaceId ? `space:${_state.spaceId}` : (_state.currentLib || '');
    if (cacheKey) _state.summaryCache[cacheKey] = summary;
    // 后台预热脑图缓存：解析成功且库有脑图结构时，预生成一次，用户点「生成脑图」秒开
    if (ok && hasMm) {
      const key = _state.spaceId ? `space:${_state.spaceId}` : (_state.currentLib || '');
      if (_mmPreheatedKey !== key) {
        _mmPreheatedKey = key;
        setTimeout(() => {
          if (window.cogseed && typeof window.cogseed.invoke === 'function') {
            window.cogseed.invoke('kb.mindmap', {
              dir: _state.spaceId ? null : (_state.currentLib || null),
              spaceId: _state.spaceId || null,
            }).catch(() => { /* 预热失败无妨：点击生成时再调用 */ });
          }
        }, 3000);
      }
    }
  }

  // 生成脑图 → 作为产物追加到**对话消息区**（kb-qa-messages），
  // 与问答流同区可见、可滚动，不藏在解析卡的折叠区。
  // 生成脑图 → 调本地 kb.mindmap（多级层级 JSON）→ 对话区渲染精致树形脑图
  function _genMindmap() {
    if (_mmGenerating) return; // 生成中防重复
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    _mmGenerating = true;
    const ai = document.createElement('div');
    ai.className = 'kb-qa-msg is-ai';
    const body = document.createElement('div');
    body.className = 'kb-qa-msg-body kb-mm-msg';
    body.innerHTML = '<div class="kb-mm-msg-head">🧠 脑图预览</div>'
      + '<div class="kb-wb-mm-canvas" id="kb-wb-mm-canvas">'
      + '<div class="kb-mm-loading">正在生成多级脑图（本地模型推理中，约 30–60 秒）…</div></div>';
    ai.appendChild(body);
    box.appendChild(ai);
    const canvas = body.querySelector('.kb-wb-mm-canvas');
    if (!canvas || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      _mmGenerating = false;
      return;
    }
    window.cogseed.invoke('kb.mindmap', {
      dir: _state.spaceId ? null : (_state.currentLib || null),
      spaceId: _state.spaceId || null,
    })
      .then((res) => {
        _mmGenerating = false;
        if (!res || !res.root) throw new Error('empty mindmap');
        _state.lastMind = res.root;
        _state.mmCollapsed.clear();
        _state.mmFocus = null;
        _state.mmSearchHits = new Set();
        canvas.innerHTML = _mmTreeSvg(res.root, _state.mmCollapsed, _mmRenderOpts());
        _bindMindCanvas(canvas);
      })
      .catch(() => {
        _mmGenerating = false;
        canvas.innerHTML = '<div class="kb-mm-fail">脑图生成失败，请稍后重试</div>';
      });
    box.scrollTop = box.scrollHeight;
  }

  // 对话回答 → 脑图：基于本条回答文本生成（复用 kb.mindmap 的 text 参数）
  function _genMindmapFromText(text, btn) {
    if (!text || !text.trim()) {
      if (typeof uiToast === 'function') uiToast('回答内容为空，无法生成脑图', { variant: 'warning' });
      return;
    }
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const anchor = btn && btn.parentElement ? btn.parentElement : null;
    // 防止重复生成：按钮下方已有预览则不再叠加
    if (anchor && anchor.querySelector('.kb-wb-mm-canvas')) {
      if (typeof uiToast === 'function') uiToast('已生成，点击脑图可打开预览', { variant: 'info' });
      return;
    }
    btn.disabled = true;
    const holder = document.createElement('div');
    holder.className = 'kb-mm-msg';
    holder.innerHTML = '<div class="kb-wb-mm-canvas">'
      + '<div class="kb-mm-loading">正在生成脑图（本地模型推理中，约 10–30 秒）…</div></div>';
    if (anchor) anchor.appendChild(holder);
    const canvas = holder.querySelector('.kb-wb-mm-canvas');
    window.cogseed.invoke('kb.mindmap', { dir: null, spaceId: null, text })
      .then((res) => {
        btn.disabled = false;
        if (!res || !res.root) throw new Error('empty mindmap');
        _state.lastMind = res.root;
        _state.mmCollapsed.clear();
        _state.mmFocus = null;
        _state.mmSearchHits = new Set();
        canvas.innerHTML = _mmTreeSvg(res.root, _state.mmCollapsed, _mmRenderOpts());
        _bindMindCanvas(canvas);
      })
      .catch(() => {
        btn.disabled = false;
        canvas.innerHTML = '<div class="kb-mm-fail">脑图生成失败，请稍后重试</div>';
      });
  }

  // 对话区脑图 = 缩略预览：点击 → 唤起弹窗（完整阅读/折叠/编辑/导出都在弹窗内）
  function _bindMindCanvas(canvas) {
    canvas.addEventListener('click', () => _openMindPreview());
  }

  // 折叠 / 展开一级分支（数据驱动重渲染）
  function _mmToggleFold(idx) {
    if (_state.mmCollapsed.has(idx)) _state.mmCollapsed.delete(idx);
    else _state.mmCollapsed.add(idx);
    _rerenderMindmaps();
  }

  // 弹窗内容渲染：图形（svg）/ 大纲（文本）双视图
  function _renderOverlay() {
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    const root = _state.lastMind;
    if (!wrap || !root) return;
    if (_state.mmViewMode === 'outline') {
      wrap.classList.add('is-outline');
      wrap.innerHTML = _mmOutlineHtml(root);
      _bindOutlineRows();
      return;
    }
    wrap.classList.remove('is-outline');
    wrap.innerHTML = _mmTreeSvg(root, _state.mmCollapsed, _mmRenderOpts());
    _bindPreviewNodes();
  }

  function _rerenderMindmaps() {
    const root = _state.lastMind;
    if (!root) return;
    document.querySelectorAll('.kb-mm-msg .kb-wb-mm-canvas').forEach((c) => {
      c.innerHTML = _mmTreeSvg(root, _state.mmCollapsed, _mmRenderOpts());
    });
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    if (wrap && !document.getElementById('kb-mm-overlay').hidden) {
      _renderOverlay();
    }
  }

  function _mmLabelAt(root, idx) {
    let cur = 0;
    const walk = (n) => {
      if (cur === idx) return n.label;
      cur++;
      for (const c of n.children || []) { const r = walk(c); if (r !== undefined) return r; }
      return undefined;
    };
    return walk(root) || '';
  }

  function _mmSetLabelAt(root, idx, label) {
    let cur = 0;
    const walk = (n) => {
      if (cur === idx) { n.label = label; return true; }
      cur++;
      for (const c of n.children || []) if (walk(c)) return true;
      return false;
    };
    walk(root);
  }

  // ── 脑图放大预览（滚轮缩放 / 拖拽平移 / 双击重命名）──
  let _mmZoom = 1, _mmPanX = 0, _mmPanY = 0, _mmPanning = false, _mmPanStart = null;
  let _mmGenerating = false; // 生成中防重复点击
  let _mmPreheatedKey = '';  // 已后台预热脑图缓存的库 key
  const _mmUndoStack = [];   // 重命名撤销栈 [{idx, old}]，上限 20

  function _openMindPreview() {
    const root = _state.lastMind;
    const overlay = document.getElementById('kb-mm-overlay');
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    if (!root || !overlay || !wrap) return;
    if (!overlay.hidden) return; // 已打开则不重置
    // 打开弹窗时隐藏对话区缩略脑图卡，避免"两个悬浮窗"叠加（关闭时恢复）
    document.querySelectorAll('.kb-qa-mm-action .kb-mm-msg').forEach((el) => { el.style.display = 'none'; });
    // 应用用户记忆的窗口尺寸/位置，绑定拖拽调整/标题拖拽/保存状态
    _mmApplyWindowRect();
    _mmBindResize();
    _mmBindTitleDrag();
    _mmUpdateSaveState();
    _renderOverlay();
    overlay.hidden = false;
    const titleInput = document.getElementById('kb-mm-title-input');
    if (titleInput) titleInput.value = _state.spaceId ? _state.spaceName : (_state.currentLib || '知识库');
    _mmUpdateSaveState();
    if (_state.mmViewMode === 'graph') {
      const svgEl = wrap.querySelector('svg');
      if (svgEl && svgEl.viewBox && svgEl.viewBox.baseVal) {
        svgEl.style.width = svgEl.viewBox.baseVal.width + 'px';
        svgEl.style.height = svgEl.viewBox.baseVal.height + 'px';
      }
      _mmFitToStage();
    }
    _mmUpdateToolbarState();
  }

  // 打开弹窗时隐藏对话区缩略脑图卡，避免"两个悬浮窗"叠加（关闭时恢复）
  function _mmRestoreThumbs() {
    document.querySelectorAll('.kb-qa-mm-action .kb-mm-msg').forEach((el) => { el.style.display = ''; });
  }

  // 窗口尺寸记忆（localStorage，无环境静默降级）：默认 78vw×80vh，用户可拖右下角调整
  const _MM_SIZE_KEY = 'cogseed.kb-mm.size';
  function _mmApplyWindowSize() {
    const dlg = document.getElementById('kb-mm-dlg');
    if (!dlg) return;
    let w = 0, h = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(_MM_SIZE_KEY) || 'null');
      if (saved && saved.w && saved.h) { w = Number(saved.w); h = Number(saved.h); }
    } catch { /* 无 localStorage 或损坏 */ }
    if (!w || !h) {
      w = Math.round(window.innerWidth * 0.78);
      h = Math.round(window.innerHeight * 0.8);
    }
    w = Math.max(560, Math.min(w, window.innerWidth - 40));
    h = Math.max(400, Math.min(h, window.innerHeight - 40));
    dlg.style.width = w + 'px';
    dlg.style.height = h + 'px';
  }
  function _mmSaveWindowSize() {
    try {
      const dlg = document.getElementById('kb-mm-dlg');
      if (!dlg) return;
      const r = dlg.getBoundingClientRect();
      localStorage.setItem(_MM_SIZE_KEY, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
    } catch { /* 无 localStorage */ }
  }
  function _mmBindResize() {
    const dlg = document.getElementById('kb-mm-dlg');
    const handle = document.getElementById('kb-mm-resize');
    if (!dlg || !handle) return;
    // 防重复绑定
    if (handle.dataset.bound) return;
    handle.dataset.bound = '1';
    let startX = 0, startY = 0, startW = 0, startH = 0;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX; startY = e.clientY;
      startW = dlg.offsetWidth; startH = dlg.offsetHeight;
      document.body.classList.add('kb-wb-resizing');
      const onMove = (ev) => {
        const w = Math.max(560, Math.min(startW + (ev.clientX - startX), window.innerWidth - 40));
        const h = Math.max(400, Math.min(startH + (ev.clientY - startY), window.innerHeight - 40));
        dlg.style.width = w + 'px';
        dlg.style.height = h + 'px';
        _mmFitToStage();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('kb-wb-resizing');
        _mmSaveWindowSize();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  // ── 悬浮窗增强：标题/保存状态/预览编辑模式/点阵/更多/独立窗口/拖拽移动/ESC ──
  let _mmDirty = false; // 是否有未保存修改
  let _mmPreviewMode = false; // false=编辑模式（全工具栏），true=预览模式（精简）
  function _mmUpdateSaveState() {
    const el = document.getElementById('kb-mm-save-state');
    if (!el) return;
    if (_mmDirty) {
      el.textContent = '● 未保存';
      el.className = 'kb-mm-save-state is-dirty';
    } else {
      el.textContent = '✓ 已保存';
      el.className = 'kb-mm-save-state is-saved';
    }
  }
  function _mmMarkDirty() { _mmDirty = true; _mmUpdateSaveState(); }
  function _mmMarkSaved() { _mmDirty = false; _mmUpdateSaveState(); }
  function _mmToggleMode() {
    _mmPreviewMode = !_mmPreviewMode;
    const dlg = document.getElementById('kb-mm-dlg');
    const btn = document.getElementById('kb-mm-mode-btn');
    if (dlg) dlg.classList.toggle('is-preview', _mmPreviewMode);
    if (btn) btn.textContent = _mmPreviewMode ? '✎ 编辑' : '👁 预览';
    const undo = document.getElementById('kb-mm-undo');
    const refresh = document.getElementById('kb-mm-refresh');
    if (undo) undo.hidden = _mmPreviewMode;
    if (refresh) refresh.hidden = _mmPreviewMode;
    const hint = document.getElementById('kb-mm-overlay-stage-hint');
    if (hint) hint.hidden = _mmPreviewMode;
  }
  function _mmToggleDots() {
    _state.mmBg = _state.mmBg === 'dots' ? 'none' : 'dots';
    _mmUpdateToolbarState();
    _rerenderMindmaps();
  }
  function _buildMoreMenu() {
    const menu = document.getElementById('kb-mm-more-menu');
    if (!menu || menu.dataset.built) return;
    menu.dataset.built = '1';
    const items = [
      { k: 'fit', label: '适应画布', fn: () => _mmFitToStage() },
      { k: 'center', label: '居中根节点', fn: () => _mmCenterNode(0) },
      { k: 'copy', label: '复制 SVG', fn: () => _mmCopySvg() },
    ];
    menu.innerHTML = items.map((it) => `<div class="kb-mm-more-item" data-more="${it.k}">${it.label}</div>`).join('');
    menu.querySelectorAll('[data-more]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const it = items.find((x) => x.k === el.dataset.more);
        if (it) it.fn();
        menu.hidden = true;
      });
    });
  }
  async function _mmPopout() {
    const root = _state.lastMind;
    if (!root || typeof window.cogseed?.invoke !== 'function') {
      if (typeof uiToast === 'function') uiToast('暂无可弹出的脑图', { variant: 'warning' });
      return;
    }
    try {
      const svg = _mmTreeSvg(root, new Set(), _mmRenderOpts());
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>脑图</title><style>body{margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}</style></head><body>${svg}</body></html>`;
      const res = await window.cogseed.invoke('kb.mindmap.popout', { html });
      if (res && res.ok === false && typeof uiToast === 'function') uiToast('独立窗口暂不可用', { variant: 'info' });
    } catch (err) {
      _log.warn('mindmap popout failed', err);
      if (typeof uiToast === 'function') uiToast('独立窗口暂不可用', { variant: 'info' });
    }
  }
  function _mmBindTitleDrag() {
    const bar = document.getElementById('kb-mm-titlebar');
    const dlg = document.getElementById('kb-mm-dlg');
    if (!bar || !dlg || bar.dataset.dragBound) return;
    bar.dataset.dragBound = '1';
    let sx = 0, sy = 0, ox = 0, oy = 0;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('input,button')) return;
      sx = e.clientX; sy = e.clientY;
      const r = dlg.getBoundingClientRect();
      ox = r.left; oy = r.top;
      const onMove = (ev) => {
        dlg.style.left = Math.max(0, Math.min(window.innerWidth - dlg.offsetWidth, ox + (ev.clientX - sx))) + 'px';
        dlg.style.top = Math.max(0, Math.min(window.innerHeight - dlg.offsetHeight, oy + (ev.clientY - sy))) + 'px';
        dlg.style.margin = '0';
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        _mmSaveWindowRect();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }
  const _MM_RECT_KEY = 'cogseed.kb-mm.rect';
  function _mmApplyWindowRect() {
    const dlg = document.getElementById('kb-mm-dlg');
    if (!dlg) return;
    try {
      const saved = JSON.parse(localStorage.getItem(_MM_RECT_KEY) || 'null');
      if (saved && saved.w && saved.h) {
        dlg.style.width = Math.max(560, Math.min(saved.w, window.innerWidth - 40)) + 'px';
        dlg.style.height = Math.max(400, Math.min(saved.h, window.innerHeight - 40)) + 'px';
      }
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        dlg.style.left = Math.max(0, Math.min(saved.x, window.innerWidth - 200)) + 'px';
        dlg.style.top = Math.max(0, Math.min(saved.y, window.innerHeight - 100)) + 'px';
        dlg.style.margin = '0';
      }
    } catch { /* ignore */ }
  }
  function _mmSaveWindowRect() {
    try {
      const dlg = document.getElementById('kb-mm-dlg');
      if (!dlg) return;
      const r = dlg.getBoundingClientRect();
      localStorage.setItem(_MM_RECT_KEY, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }));
    } catch { /* ignore */ }
  }

  // 当前库的存档 key（与主进程 mindKey 对齐）
  function _mmCurrentKey() {
    return _state.spaceId ? `space:${_state.spaceId}` : `dir:${_state.currentLib || 'global'}`;
  }

  // 💾 保存：把当前脑图存入用户数据目录，下次打开本库可直接读取
  function _mmSaveMindmap() {
    const root = _state.lastMind;
    if (!root || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      if (typeof uiToast === 'function') uiToast('暂无可保存的脑图', { variant: 'warning' });
      return;
    }
    const key = _mmCurrentKey();
    window.cogseed.invoke('kb.mindmap.save', { key, root })
      .then((r) => {
        if (r && r.ok) {
          _mmMarkSaved();
          if (typeof uiToast === 'function') uiToast('脑图已保存到知识库（下次打开可直接读取）', { variant: 'success' });
        } else if (typeof uiToast === 'function') {
          uiToast('保存失败', { variant: 'warning' });
        }
      })
      .catch(() => { if (typeof uiToast === 'function') uiToast('保存失败', { variant: 'warning' }); });
  }

  // ⟳ 刷新：强制重新生成当前库脑图（不走缓存）
  function _mmRefreshMindmap() {
    if (_mmGenerating) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    _mmGenerating = true;
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    if (wrap) wrap.innerHTML = '<div class="kb-mm-fail" style="color:var(--kb-muted,#6E8578)">正在重新生成脑图（本地模型推理中，约 30–60 秒）…</div>';
    window.cogseed.invoke('kb.mindmap', {
      dir: _state.spaceId ? null : (_state.currentLib || null),
      spaceId: _state.spaceId || null,
      force: true,
    })
      .then((res) => {
        _mmGenerating = false;
        if (!res || !res.root) throw new Error('empty mindmap');
        _state.lastMind = res.root;
        _state.mmCollapsed.clear();
        _state.mmFocus = null;
        _state.mmSearchHits = new Set();
        _rerenderMindmaps();
        _mmFitToStage();
        if (typeof uiToast === 'function') uiToast('脑图已重新生成', { variant: 'success' });
      })
      .catch(() => {
        _mmGenerating = false;
        _rerenderMindmaps();
        if (typeof uiToast === 'function') uiToast('重新生成失败，请稍后重试', { variant: 'warning' });
      });
  }

  // 📂 存档：列出已保存脑图，点击载入预览
  function _mmFillOpenMenu() {
    const menu = document.getElementById('kb-mm-open-menu');
    if (!menu) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      menu.innerHTML = '<div class="kb-mm-open-item is-empty">存档服务不可用</div>';
      return;
    }
    window.cogseed.invoke('kb.mindmap.list').then((r) => {
      const items = (r && Array.isArray(r.items) ? r.items : []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      if (!items.length) {
        menu.innerHTML = '<div class="kb-mm-open-item is-empty">还没有保存的脑图</div>';
        return;
      }
      menu.innerHTML = items.map((m) => {
        const d = new Date(m.savedAt || Date.now());
        const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const pretty = m.key.startsWith('space:') ? `共享空间 ${m.key.slice(6)}` : `个人库 ${m.key.slice(4)}`;
        return `<div class="kb-mm-open-item" data-key="${_esc(m.key)}"><span class="kb-mm-open-item-name">${_esc(pretty)}</span><span class="kb-mm-open-item-time">${time}</span></div>`;
      }).join('');
      menu.querySelectorAll('.kb-mm-open-item[data-key]').forEach((el) => {
        el.addEventListener('click', () => {
          menu.hidden = true;
          _mmLoadMindmap(el.dataset.key);
        });
      });
    }).catch(() => {
      menu.innerHTML = '<div class="kb-mm-open-item is-empty">读取存档失败</div>';
    });
  }

  function _mmLoadMindmap(key) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    window.cogseed.invoke('kb.mindmap.load', { key })
      .then((r) => {
        if (!r || !r.ok || !r.root) {
          if (typeof uiToast === 'function') uiToast('存档不存在或已损坏', { variant: 'warning' });
          return;
        }
        _state.lastMind = r.root;
        const titleEl = document.getElementById('kb-mm-title-input');
        const overlay = document.getElementById('kb-mm-overlay');
        if (titleEl && overlay) {
          overlay.hidden = false;
          titleEl.textContent = `🧠 脑图预览 - ${key.startsWith('space:') ? `共享空间 ${key.slice(6)}` : `个人库 ${key.slice(4)}`}（已保存）`;
        }
        _rerenderMindmaps();
        _mmFitToStage();
        if (typeof uiToast === 'function') uiToast('已载入保存的脑图', { variant: 'success' });
      })
      .catch(() => { if (typeof uiToast === 'function') uiToast('载入失败', { variant: 'warning' }); });
  }

  // 预览层内：一级分支点击折叠/展开；双击节点重命名
  function _bindPreviewNodes() {
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    const root = _state.lastMind;
    if (!wrap || !root) return;
    wrap.querySelectorAll('.kb-mm-node').forEach((el) => {
      const depth = Number(el.dataset.depth || 0);
      const hasKids = Number(el.dataset.children || 0) > 0;
      const idx = Number(el.dataset.mmIdx);
      if (depth === 1) {
        // 一级分支：徽章(−/+)点击=折叠；节点主体点击=聚焦/取消聚焦该分支
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.target && e.target.closest && e.target.closest('.kb-mm-fold-badge')) {
            _mmToggleFold(idx);
            return;
          }
          if (_state.mmFocus === idx) _state.mmFocus = null;
          else _state.mmFocus = idx;
          _rerenderMindmaps();
          _mmUpdateToolbarState();
        });
        el.style.cursor = 'pointer';
      } else if (_state.mmFocus !== null) {
        // 聚焦态下点击其他节点 = 取消聚焦
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          _state.mmFocus = null;
          _rerenderMindmaps();
          _mmUpdateToolbarState();
        });
        el.style.cursor = 'pointer';
      }
      // 点击有来源的节点 → 跳转知识库原文片段
      if (el.dataset.source) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          _mmOpenSource(el.dataset.source, idx);
        });
        el.style.cursor = 'pointer';
      }
      el.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        let next = null;
        try {
          next = typeof uiPrompt === 'function'
            ? await uiPrompt('重命名节点：', _mmLabelAt(root, idx))
            : window.prompt('重命名节点：', _mmLabelAt(root, idx));
        } catch (_) { return; }
        if (!next || !next.trim()) return;
        _mmUndoStack.push({ idx, old: _mmLabelAt(root, idx) });
        if (_mmUndoStack.length > 20) _mmUndoStack.shift();
        _mmSetLabelAt(root, idx, next.trim());
        _mmMarkDirty();
        _rerenderMindmaps();
        if (_state.mmViewMode === 'graph') _mmFitToStage();
      });
    });
  }

  // 大纲视图行：点击 → 切回图形并定位该节点
  function _bindOutlineRows() {
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.kb-mm-outline-row').forEach((row) => {
      const idx = Number(row.dataset.mmIdx);
      if (Number.isNaN(idx)) return;
      row.addEventListener('click', () => {
        _state.mmViewMode = 'graph';
        _mmUpdateToolbarState();
        _renderOverlay();
        _mmFitToStage();
        _mmCenterNode(idx);
      });
    });
  }

  // 定位到指定节点（画布居中，自动放大到至少 100%）
  function _mmCenterNode(idx) {
    const svg = document.querySelector('#kb-mm-overlay-wrap svg');
    const stage = document.getElementById('kb-mm-overlay-stage');
    const el = svg ? svg.querySelector(`[data-mm-idx="${idx}"]`) : null;
    if (!svg || !stage || !el) return;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const svgW = vb ? vb.width : 1200;
    const svgH = vb ? vb.height : 800;
    let bbox;
    try { bbox = el.getBBox(); } catch (_) { return; }
    if (!bbox || !bbox.width) return;
    const sx = bbox.x + bbox.width / 2;
    const sy = bbox.y + bbox.height / 2;
    _mmZoom = Math.max(_mmZoom, Math.min(1.4, Math.max(1, Math.min((stage.clientWidth || 800) / (bbox.width + 120), (stage.clientHeight || 600) / (bbox.height + 90)))));
    _mmPanX = -(sx - svgW / 2) * _mmZoom;
    _mmPanY = -(sy - svgH / 2) * _mmZoom;
    _applyMmTransform();
  }

  // ── 大纲视图（图形/文本双视图切换）──
  function _mmOutlineLines(root) {
    const lines = [];
    let idx = 0;
    const walk = (n, depth) => {
      const cur = idx++;
      lines.push({ label: String(n?.label || ''), source: n?.source || '', depth, idx: cur, childCount: (n?.children || []).length });
      if (depth === 1 && _state.mmCollapsed.has(cur)) return; // 折叠的一级分支不展开
      for (const c of (n?.children || [])) walk(c, depth + 1);
    };
    walk(root, 0);
    return lines;
  }

  function _mmOutlineHtml(root) {
    const lines = _mmOutlineLines(root).map((ln) => {
      const hit = _state.mmSearchHits && _state.mmSearchHits.has(ln.idx) ? ' kb-mm-outline-row--hit' : '';
      const src = ln.source ? ` <span class="kb-mm-outline-src">📄 ${_esc(ln.source)}</span>` : '';
      const icon = ln.depth === 0 ? '🧠' : ln.depth === 1 ? '▸' : '·';
      return `<div class="kb-mm-outline-row${hit}" data-mm-idx="${ln.idx}" style="padding-left:${16 + ln.depth * 22}px">${ln.depth === 0 ? '' : `<span class="kb-mm-outline-dot"></span>`}<span class="kb-mm-outline-label">${icon} ${_esc(ln.label)}</span>${src}</div>`;
    }).join('');
    return `<div class="kb-mm-outline">${lines || '<div class="kb-mm-outline-empty">（空脑图）</div>'}</div>`;
  }

  function _mmOutlineMd(root) {
    const lines = _mmOutlineLines(root).map((ln) => {
      const prefix = ln.depth === 0 ? '# ' : '  '.repeat(ln.depth - 1) + '- ';
      const src = ln.source ? ` （来源：${ln.source}）` : '';
      return prefix + ln.label + src;
    });
    return `# 脑图大纲\n\n${lines.join('\n')}\n`;
  }

  function _mmExportMd() {
    const root = _state.lastMind;
    if (!root) return;
    const md = _mmOutlineMd(root);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mindmap-大纲-${Date.now()}.md`; a.click();
    URL.revokeObjectURL(url);
    if (typeof uiToast === 'function') uiToast('已导出 Markdown 大纲', { variant: 'success' });
  }

  function _mmPdfHtml() {
    const svg = _mmCurrentSvg();
    if (!svg) return '';
    const titleEl = document.getElementById('kb-mm-title-input');
    const title = titleEl ? titleEl.textContent.replace(/^🧠\s*/, '') : '知识库脑图';
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif}h1{font-size:15px;padding:14px 18px 6px;color:#14281E;border-bottom:1px solid #E5EDE8}svg{width:100%;height:auto}</style></head><body><h1>${_esc(title)}</h1>${new XMLSerializer().serializeToString(clone)}</body></html>`;
  }

  function _mmExportPdf() {
    if (!_mmNeedGraph()) return;
    const html = _mmPdfHtml();
    if (!html || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      if (typeof uiToast === 'function') uiToast('PDF 导出暂不可用', { variant: 'warning' });
      return;
    }
    window.cogseed.invoke('kb.mindmap.exportPdf', { html })
      .then((r) => {
        if (r && r.ok) { if (typeof uiToast === 'function') uiToast('PDF 已导出', { variant: 'success' }); }
        else if (r && r.canceled) { /* 用户取消 */ }
        else if (typeof uiToast === 'function') uiToast('PDF 导出失败', { variant: 'warning' });
      })
      .catch(() => { if (typeof uiToast === 'function') uiToast('PDF 导出失败', { variant: 'warning' }); });
  }

  // 全部展开 / 全部收拢（一级分支）
  function _mmBranchIdxList() {
    const root = _state.lastMind;
    const idxs = [];
    if (!root) return idxs;
    let idx = 0;
    const walk = (n, depth) => {
      const cur = idx++;
      if (depth === 1 && (n.children || []).length) idxs.push(cur);
      for (const c of (n.children || [])) walk(c, depth + 1);
    };
    walk(root, 0);
    return idxs;
  }
  function _mmExpandAll() {
    if (!_state.lastMind) {
      if (typeof uiToast === 'function') uiToast('请先生成脑图', { variant: 'info' });
      return;
    }
    _state.mmCollapsed.clear();
    _rerenderMindmaps();
  }
  function _mmCollapseAll() {
    const idxs = _mmBranchIdxList();
    if (!idxs.length) {
      if (typeof uiToast === 'function') uiToast('当前脑图没有可折叠的分支', { variant: 'info' });
      return;
    }
    // 若已全部折叠则先展开以便用户看到反馈（避免"点了没反应"）
    if (_state.mmCollapsed.size >= idxs.length) _state.mmCollapsed.clear();
    for (const i of idxs) _state.mmCollapsed.add(i);
    _rerenderMindmaps();
  }

  // 布局切换：思维导图（双向放射）↔ 组织结构图（单向）
  function _mmToggleLayout() {
    _state.mmMode = _state.mmMode === 'org' ? 'mind' : 'org';
    _mmUpdateToolbarState();
    if (_state.mmViewMode === 'graph') {
      _renderOverlay();
      _mmFitToStage();
    }
  }

  // 聚焦：进入聚焦态后点一级分支聚焦；再点取消
  function _mmToggleFocus() {
    _state.mmFocus = null;
    _rerenderMindmaps();
    _mmUpdateToolbarState();
  }

  // 背景循环：点阵 → 纯白 → 无
  function _mmCycleBg() {
    _state.mmBg = _state.mmBg === 'dots' ? 'plain' : _state.mmBg === 'plain' ? 'none' : 'dots';
    _mmUpdateToolbarState();
    _rerenderMindmaps();
  }

  // 大纲视图切换
  function _mmToggleOutline() {
    _state.mmViewMode = _state.mmViewMode === 'outline' ? 'graph' : 'outline';
    _mmUpdateToolbarState();
    _renderOverlay();
    if (_state.mmViewMode === 'graph') _mmFitToStage();
    else {
      const stage = document.getElementById('kb-mm-overlay-stage');
      const hint = stage ? stage.querySelector('.kb-mm-overlay-stage-hint') : null;
      if (hint) hint.textContent = '点击行可跳转到对应节点 · 折叠的一级分支不展开';
    }
  }

  // 脑内搜索：匹配节点高亮 + 定位第一个命中
  function _mmSearch(q) {
    const root = _state.lastMind;
    q = String(q || '').trim();
    const hits = new Set();
    if (q && root) {
      let idx = 0;
      const walk = (n) => {
        const cur = idx++;
        if (String(n?.label || '').toLowerCase().includes(q.toLowerCase())) hits.add(cur);
        for (const c of (n?.children || [])) walk(c);
      };
      walk(root);
    }
    _state.mmSearchHits = hits;
    _rerenderMindmaps();
    if (q && hits.size) {
      if (_state.mmViewMode === 'outline') {
        const first = wrapFirstHit();
        _state.mmViewMode = 'graph';
        _mmUpdateToolbarState();
        _renderOverlay();
        _mmFitToStage();
        _mmCenterNode(first);
      } else {
        _mmCenterNode([...hits][0]);
      }
      if (typeof uiToast === 'function') uiToast(`匹配 ${hits.size} 个节点`, { variant: 'info' });
    }
    function wrapFirstHit() { return [...hits][0]; }
  }

  // 溯源：点击带来源的节点 → 跳转知识库原文片段
  function _mmOpenSource(source, idx) {
    const name = String(source || '');
    if (!name) return;
    if (typeof window.__openAnchorViewer === 'function') {
      const candidates = [];
      for (const f of (_state.spaceFiles || [])) if (f && f.path) candidates.push(String(f.path));
      const walk = (n) => {
        if (n && n.path) candidates.push(String(n.path));
        for (const c of (n && n.children) || []) walk(c);
      };
      walk({ children: _state.tree });
      const hit = candidates.find((p) => p.toLowerCase().endsWith(name.toLowerCase()));
      if (hit) {
        window.__openAnchorViewer({
          source: _state.spaceId ? 'space' : 'library',
          scope: _state.spaceId || 'global',
          path: hit,
          chunkIdx: 0,
        });
        return;
      }
    }
    if (typeof uiToast === 'function') uiToast(`未在知识库中找到来源文档：${name}`, { variant: 'warning' });
  }

  // 工具栏状态同步（布局/聚焦/背景/大纲按钮）
  function _mmUpdateToolbarState() {
    const focusBtn = document.getElementById('kb-mm-focus-btn');
    if (focusBtn) {
      const on = _state.mmFocus !== null;
      focusBtn.classList.toggle('is-active', on);
      focusBtn.title = on ? '点击一级分支切换聚焦分支 · 点此取消聚焦' : '聚焦分支：点击一级分支只看该分支';
      focusBtn.textContent = on ? '◎ 聚焦中' : '◎ 聚焦';
    }
    const layoutBtn = document.getElementById('kb-mm-layout-btn');
    if (layoutBtn) layoutBtn.textContent = _state.mmMode === 'org' ? '📐 组织结构' : '📐 思维导图';
    const bgBtn = document.getElementById('kb-mm-bg-btn');
    if (bgBtn) {
      const names = { dots: '点阵', plain: '纯白', none: '无' };
      bgBtn.textContent = `▦ ${names[_state.mmBg] || ''}`;
      bgBtn.title = '背景切换（点阵/纯白/无）';
    }
    const outlineBtn = document.getElementById('kb-mm-outline-btn');
    if (outlineBtn) outlineBtn.classList.toggle('is-active', _state.mmViewMode === 'outline');
    const hint = document.querySelector('#kb-mm-overlay-stage .kb-mm-overlay-stage-hint');
    if (hint) {
      hint.textContent = _state.mmViewMode === 'outline'
        ? '点击行可跳转到对应节点 · 折叠的一级分支不展开'
        : '滚轮缩放 · 拖拽平移 · 一级分支点击聚焦 · −/+ 折叠 · 双击重命名';
    }
  }

  // 打开/点击「适应」时：按弹窗视口自动缩放，脑图填满大部分画布（不再过小）
  function _mmFitToStage() {
    const stage = document.getElementById('kb-mm-overlay-stage');
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    const svg = wrap ? wrap.querySelector('svg') : null;
    if (!stage || !svg) return;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const svgW = vb ? vb.width : (svg.style.width ? parseFloat(svg.style.width) : 1200);
    const svgH = vb ? vb.height : (svg.style.height ? parseFloat(svg.style.height) : 800);
    const stW = stage.clientWidth || 800;
    const stH = stage.clientHeight || 600;
    const scale = Math.min(stW / svgW, stH / svgH) * 0.92;
    _mmZoom = Math.max(0.15, Math.min(2.5, scale));
    _mmPanX = 0; _mmPanY = 0;
    _applyMmTransform();
  }

  function _applyMmTransform() {
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    if (wrap) wrap.style.transform = `scale(${_mmZoom}) translate(${_mmPanX}px, ${_mmPanY}px)`;
    const label = document.getElementById('kb-mm-zoom-label');
    if (label) label.textContent = Math.round(_mmZoom * 100) + '%';
  }

  // ── 脑图导出（SVG / PNG / PDF / Markdown / 剪贴板）──
  function _mmCurrentSvg() {
    return document.querySelector('#kb-mm-overlay-wrap svg');
  }
  function _mmNeedGraph() {
    if (_state.mmViewMode === 'outline') {
      if (typeof uiToast === 'function') uiToast('请先切回图形视图再导出图片', { variant: 'info' });
      return false;
    }
    return true;
  }
  function _mmExportSvg() {
    if (!_mmNeedGraph()) return;
    const svg = _mmCurrentSvg();
    if (!svg) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mindmap-${Date.now()}.svg`; a.click();
    URL.revokeObjectURL(url);
  }
  function _mmExportPng() {
    if (!_mmNeedGraph()) return;
    const svg = _mmCurrentSvg();
    if (!svg) return;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const w = vb ? vb.width : 1200;
    const h = vb ? vb.height : 800;
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png'); a.download = `mindmap-${Date.now()}.png`; a.click();
    };
    img.src = dataUrl;
  }
  function _mmCopySvg() {
    if (!_mmNeedGraph()) return;
    const svg = _mmCurrentSvg();
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    if (navigator.clipboard && navigator.clipboard.write) {
      navigator.clipboard.write([new ClipboardItem({ 'image/svg+xml': new Blob([xml], { type: 'image/svg+xml' }) })])
        .then(() => { if (typeof uiToast === 'function') uiToast('已复制脑图 SVG', { variant: 'success' }); })
        .catch(() => { if (typeof uiToast === 'function') uiToast('复制失败（剪贴板不支持 SVG）', { variant: 'warning' }); });
    } else if (typeof uiToast === 'function') {
      uiToast('当前环境不支持剪贴板复制', { variant: 'warning' });
    }
  }

  // ── 多级水平树脑图（双向放射/组织结构图双布局、分支成套色系、字号层级、换行、聚焦/搜索/背景）──
  // 成套色系：每分支一套 deep/mid/light，逐级降饱和；一级分支前 3 色 = 绿/蓝/品红
  const KB_MM_PALETTES = [
    { deep: '#0E9F6E', mid: '#5EBC9A', light: '#D8F0E5' }, // 绿
    { deep: '#2563EB', mid: '#6E9AF2', light: '#DDE7FC' }, // 蓝
    { deep: '#D946EF', mid: '#E684F6', light: '#F8DCFC' }, // 品红
    { deep: '#D97706', mid: '#E9A95F', light: '#FAE6CC' }, // 橙
    { deep: '#0D9488', mid: '#5FC5BC', light: '#D6F1EE' }, // 青
  ];
  const KB_MM_ROOT = '#0E9F6E';

  // 字号层级：根 > 一级 > 二级 > 三级（叶子最小）
  function _mmFontSize(depth) {
    if (depth === 0) return 15;
    if (depth === 1) return 13;
    if (depth === 2) return 12;
    return 11;
  }

  // 长文本自动换行：控制节点最大宽度（避免超长横条），按语义断行优先
  function _mmDims(label, size) {
    const maxW = 150;
    const charW = size * 1.02;
    const perLine = Math.max(5, Math.floor((maxW - 22) / charW));
    const text = String(label || '');
    // 优先按中英文标点断行，其次按字符数
    const lines = [];
    let rest = text;
    while (rest.length > perLine) {
      let cut = rest.slice(0, perLine);
      const m = cut.match(/.*[，。；、,.!?；：\s]/);
      if (m && m[0].length >= perLine * 0.5) cut = m[0];
      lines.push(cut);
      rest = rest.slice(cut.length);
    }
    if (rest) lines.push(rest);
    const w = Math.min(maxW, Math.max(66, lines[0].length * charW + 26));
    const h = 34 + (lines.length - 1) * 15;
    return { lines, w, h };
  }

  function _mmPalette(branch) {
    return branch === undefined || branch === null ? KB_MM_PALETTES[0] : KB_MM_PALETTES[branch % KB_MM_PALETTES.length];
  }

  // 渲染选项（模式/聚焦/搜索命中/背景）统一取自 state
  function _mmRenderOpts() {
    return { mode: _state.mmMode || 'mind', focus: _state.mmFocus, highlight: _state.mmSearchHits, bg: _state.mmBg || 'dots' };
  }

  // 布局：mind=双向放射（一级分支左右分摊，左右各自延展）；org=组织结构图（单向向右）
  function _mmTreeSvg(root, collapsed, opts) {
    collapsed = collapsed || new Set();
    opts = opts || {};
    const mode = opts.mode === 'org' ? 'org' : 'mind';
    const focus = opts.focus === undefined || opts.focus === null ? null : Number(opts.focus);
    const highlight = opts.highlight instanceof Set ? opts.highlight : new Set();
    const bg = opts.bg || 'dots';
    const ROOT_X = mode === 'org' ? 96 : 640;
    // 间距：同级节点拉大留白，子分支与父节点留足间隔，避免视觉拥挤
    const XGAP = mode === 'org' ? 320 : 300;
    const TOP = 40, BOT = 500;

    const list = []; // {label, depth, x, y, kids:[], idx, branch, dir, childCount, w, h, lines}
    const weight = (n) => (n && n.children && n.children.length ? n.children.reduce((a, c) => a + weight(c), 0) : 1);
    const layout = (n, depth, top, bot, branch, dir) => {
      const node = { label: String(n?.label || ''), source: n?.source || '', depth, kids: [], idx: list.length, branch, dir, childCount: (n?.children || []).length };
      list.push(node);
      node.x = ROOT_X + dir * depth * XGAP;
      node.y = (top + bot) / 2;
      const kids = n.children || [];
      if (depth === 0) {
        // 一级分支：mind 模式左右分摊（按权重折半），org 模式全部向右
        let acc = top;
        let accRight = top;
        let bi = 0;
        const totalW = kids.reduce((a, c) => a + weight(c), 0) || 1;
        let leftW = 0;
        for (const k of kids) {
          leftW += weight(k);
          if (mode === 'mind' && leftW <= totalW / 2) {
            const span = (BOT - TOP) * (weight(k) / totalW);
            node.kids.push(layout(k, depth + 1, acc, acc + span, bi, -1));
            acc += span;
          } else {
            const span = (BOT - TOP) * (weight(k) / totalW);
            node.kids.push(layout(k, depth + 1, accRight, accRight + span, bi, 1));
            accRight += span;
          }
          bi++;
        }
        return node;
      }
      if (!kids.length) return node;
      const total = kids.reduce((a, c) => a + weight(c), 0) || 1;
      let acc = top;
      for (const k of kids) {
        const span = (bot - top) * (weight(k) / total);
        node.kids.push(layout(k, depth + 1, acc, acc + span, branch, dir));
        acc += span;
      }
      return node;
    };
    const rootNode = layout(root, 0, TOP, BOT, 0, 1);

    // 折叠的一级分支：子树隐藏
    const hidden = new Set();
    for (const kid of rootNode.kids) {
      if (collapsed.has(kid.idx)) {
        const walkHide = (n) => { for (const c of n.kids) { hidden.add(c.idx); walkHide(c); } };
        walkHide(kid);
      }
    }

    // 节点尺寸（换行）预计算
    for (const n of list) {
      const d = _mmDims(n.label, _mmFontSize(n.depth));
      n.w = d.w; n.h = d.h; n.lines = d.lines;
    }

    // 画布范围（双向时 viewBox 从最左边界起，四周留白）
    // 基于**完整树**的布局坐标计算，折叠只隐藏节点、不改变画布大小
    // （避免收拢/展开时脑图尺寸跳动）
    const minX = Math.min(...list.map((n) => n.x - n.w / 2)) - 60;
    const maxX = Math.max(...list.map((n) => n.x + n.w / 2)) + 160;
    const maxY = Math.max(BOT, ...list.map((n) => n.y + n.h / 2)) + 30;
    const svgW = Math.max(400, maxX - minX);
    const svgH = Math.max(480, maxY);
    const showFolded = hidden.size > 0;

    // 连线：颜色=分支成套色系；粗细/透明度随层级递减
    const edges = [];
    const walkE = (n) => { for (const c of n.kids) { if (!hidden.has(c.idx)) edges.push([n, c]); walkE(c); } };
    walkE(rootNode);
    const edgeSvg = edges.map(([a, b]) => {
      const pal = _mmPalette(b.branch);
      const ax = a.x + a.dir * (a.w / 2 + 2);
      const bx = b.x - b.dir * (b.w / 2 + 2);
      const mx = (ax + bx) / 2;
      const width = a.depth === 0 ? 2.6 : a.depth === 1 ? 2.1 : 1.6;
      const op = a.depth === 0 ? 0.6 : a.depth === 1 ? 0.45 : 0.28;
      return `<path d="M ${ax} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${bx} ${b.y}" fill="none" stroke="${pal.deep}" stroke-width="${width}" stroke-opacity="${op}"/>`;
    }).join('');

    // 节点：成套色系（一级深色实心 / 二级浅底深框 / 三级白底中框）、字号层级、换行、聚焦淡化、搜索高亮、来源标记
    const nodeSvg = list.map((n) => {
      if (hidden.has(n.idx)) return '';
      const p = (() => {
        if (n.depth === 0) return { fill: '#0B7A52', stroke: '#065F46', text: '#fff', size: 16, sw: 2.4 }; // 中心根节点高亮加深
        const pal = _mmPalette(n.branch);
        if (n.depth === 1) return { fill: pal.deep, stroke: pal.deep, text: '#fff', size: 13, sw: 1.6 };
        if (n.depth === 2) return { fill: pal.light, stroke: pal.deep, text: '#14281E', size: 12, sw: 1.3 };
        return { fill: '#FFFFFF', stroke: pal.mid, text: '#3E5A4C', size: 11, sw: 1.2 };
      })();
      const w = n.w, h = n.h;
      const x = n.x - w / 2;
      const y = n.y - h / 2;
      const folded = n.depth === 1 && collapsed.has(n.idx);
      const badgeX = n.x + n.dir * (w / 2 + 9);
      // 徽章统一加 kb-mm-fold-badge class：折叠态是 +N（点击展开），展开态是 −（点击折叠）
      const foldBadge = folded
        ? `<circle class="kb-mm-fold-badge" cx="${badgeX}" cy="${n.y}" r="8" fill="#fff" stroke="${p.stroke}"/><text class="kb-mm-fold-badge" x="${badgeX}" y="${n.y + 4}" text-anchor="middle" font-size="10" fill="${p.stroke}">+${n.childCount}</text>`
        : (n.childCount > 0 && n.depth >= 1 ? `<circle class="kb-mm-fold-badge" cx="${badgeX}" cy="${n.y}" r="8" fill="#fff" stroke="#B7D3C3"/><text class="kb-mm-fold-badge" x="${badgeX}" y="${n.y + 4}" text-anchor="middle" font-size="10" fill="#3E5A4C">−</text>` : '');
      const dim = focus !== null && n.depth >= 1 && n.branch !== focus;
      const hit = highlight.has(n.idx);
      const hitRing = hit
        ? `<rect x="${x - 5}" y="${y - 5}" width="${w + 10}" height="${h + 10}" rx="${(h + 10) / 2}" fill="none" stroke="#F59E0B" stroke-width="2" stroke-dasharray="5 3"/>`
        : '';
      const srcMark = n.source
        ? `<text x="${n.x + w / 2 - 9}" y="${n.y - h / 2 + 11}" font-size="9.5" fill="#6E8578">📄</text>`
        : '';
      const textLines = n.lines.map((ln, i) =>
        `<tspan x="${n.x}" dy="${i === 0 ? 5 : 15}" font-size="${p.size}">${_esc(ln)}</tspan>`).join('');
      const extra = (folded ? ' kb-mm-node--folded' : '') + (dim ? ' kb-mm-node--dim' : '') + (hit ? ' kb-mm-node--hit' : '');
      return `<g class="kb-mm-node${extra}" data-depth="${n.depth}" data-mm-idx="${n.idx}" data-branch="${n.branch ?? -1}" data-dir="${n.dir}" data-folded="${folded ? '1' : '0'}" data-children="${n.childCount}"${n.source ? ` data-source="${_esc(n.source)}"` : ''}${dim ? ' opacity="0.13"' : ''}>
        ${hitRing}
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${p.sw}"/>
        <text x="${n.x}" y="${n.y}" text-anchor="middle" font-weight="${n.depth <= 1 ? 600 : 500}" fill="${p.text}">${textLines}</text>
        ${srcMark}
        ${foldBadge}
        ${n.source ? `<title>${_esc(n.source)}</title>` : ''}
      </g>`;
    }).join('');

    // 背景：点阵 / 纯白 / 无（深色画布）
    const bgSvg = bg === 'none'
      ? ''
      : bg === 'plain'
        ? `<rect x="${minX}" y="0" width="${svgW}" height="${svgH}" fill="#FFFFFF"/>`
        : `<defs><pattern id="kb-mm-dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="rgba(20,40,30,0.07)"/></pattern></defs><rect x="${minX}" y="0" width="${svgW}" height="${svgH}" fill="url(#kb-mm-dots)"/>`;
    return `<svg class="kb-mm-svg" viewBox="${minX} 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">${bgSvg}${edgeSvg}${nodeSvg}</svg>`;
  }

  // ── 问答流 ──
  // 会话持久化 key（localStorage，无环境静默降级）
  const _QA_SESSIONS_KEY = 'cogseed.kb.qa-sessions';
  function _qaLoadSessions() {
    try { _state.qaSessions = JSON.parse(localStorage.getItem(_QA_SESSIONS_KEY) || '[]'); }
    catch { _state.qaSessions = []; }
    if (!Array.isArray(_state.qaSessions)) _state.qaSessions = [];
  }
  function _qaPersist() {
    try { localStorage.setItem(_QA_SESSIONS_KEY, JSON.stringify(_state.qaSessions.slice(0, 30))); }
    catch { /* 无 localStorage */ }
  }
  // 当前会话不存在则创建（首次提问时）；保存消息到会话
  function _qaSaveCurrentSession(firstQuestion) {
    const now = Date.now();
    if (!_state.qaSessionId) {
      _state.qaSessionId = 's' + now;
      const msgs = _state.qaHistory.map((m) => ({ ...m }));
      _state.qaSessions.unshift({ id: _state.qaSessionId, title: String(firstQuestion || '新对话').slice(0, 30), msgs, ts: now });
      _qaPersist();
      return;
    }
    const s = _state.qaSessions.find((x) => x.id === _state.qaSessionId);
    if (s) {
      s.msgs = _state.qaHistory.map((m) => ({ ...m }));
      if (!s.title && firstQuestion) s.title = String(firstQuestion).slice(0, 30);
      s.ts = now;
      _qaPersist();
    }
  }
  // 新建对话：清空当前消息与上下文，创建新会话
  function _qaNewSession() {
    _state.qaSessionId = null;
    _state.qaHistory = [];
    _clearQa();
    if (typeof uiToast === 'function') uiToast('已新建对话', { variant: 'info' });
  }
  // 载入历史会话：恢复消息区 + 上下文
  function _qaLoadSession(id) {
    const s = _state.qaSessions.find((x) => x.id === id);
    if (!s) return;
    _state.qaSessionId = id;
    _state.qaHistory = (s.msgs || []).map((m) => ({ role: m.role, content: m.content }));
    _clearQa();
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    for (const m of _state.qaHistory) {
      const el = document.createElement('div');
      el.className = m.role === 'user' ? 'kb-qa-msg is-user' : 'kb-qa-msg is-ai';
      el.innerHTML = `<div class="kb-qa-msg-body">${_esc(m.content)}</div>`;
      box.appendChild(el);
    }
    _maybeShowQaHint();
  }
  // 历史面板：会话列表（新建/切换/删除）
  function _qaOpenHistory() {
    _qaLoadSessions();
    let panel = document.getElementById('kb-qa-history-panel');
    if (panel) { panel.remove(); panel = null; }
    panel = document.createElement('div');
    panel.className = 'kb-qa-history-panel';
    panel.id = 'kb-qa-history-panel';
    panel.innerHTML = `
      <div class="kb-qa-history-head">
        <span>会话历史</span>
        <button type="button" class="kb-qa-history-close" title="关闭">✕</button>
      </div>
      <div class="kb-qa-history-new" id="kb-qa-history-new">＋ 新建对话</div>
      <div class="kb-qa-history-list">${_state.qaSessions.length
        ? _state.qaSessions.map((s) => `<div class="kb-qa-history-item${s.id === _state.qaSessionId ? ' is-active' : ''}" data-hist-id="${_esc(s.id)}">
            <span class="kb-qa-history-title">${_esc(s.title || '新对话')}</span>
            <span class="kb-qa-history-meta">${s.msgs ? s.msgs.length : 0} 条 · ${_qaFmtTime(s.ts)}</span>
            <button type="button" class="kb-qa-history-del" data-hist-del="${_esc(s.id)}" title="删除会话">🗑</button>
          </div>`).join('')
        : '<div class="kb-qa-history-empty">暂无历史对话</div>'}
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.kb-qa-history-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#kb-qa-history-new').addEventListener('click', () => { panel.remove(); _qaNewSession(); });
    panel.querySelectorAll('[data-hist-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-hist-del]')) return;
        _qaLoadSession(el.dataset.histId);
        panel.remove();
      });
    });
    panel.querySelectorAll('[data-hist-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.histDel;
        _state.qaSessions = _state.qaSessions.filter((x) => x.id !== id);
        if (_state.qaSessionId === id) { _state.qaSessionId = null; _state.qaHistory = []; _clearQa(); }
        _qaPersist();
        _qaOpenHistory(); // 刷新列表
      });
    });
  }
  function _qaFmtTime(ts) {
    const d = new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function _ask(question) {
    const q = String(question || '').trim();
    if (!q) return;
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    _maybeShowQaHint();
    // 多轮上下文：用户问题入 history（供模型参考，回答入 history 在 final）
    _state.qaHistory.push({ role: 'user', content: q });
    if (_state.qaHistory.length > 20) _state.qaHistory.splice(0, _state.qaHistory.length - 20);
    _qaSaveCurrentSession(q); // 提问即创建/保存会话骨架（final 时更新回答）

    const user = document.createElement('div');
    user.className = 'kb-qa-msg is-user';
    user.innerHTML = `<div class="kb-qa-msg-body">${_esc(q)}</div>
      <div class="kb-qa-msg-more">
        <button type="button" class="kb-qa-more-btn" title="更多">${_svg('more-h')}</button>
        <div class="kb-qa-msg-menu" hidden>
          <div class="kb-qa-msg-menu-item" data-qa-act="rename">📝 重命名</div>
          <div class="kb-qa-msg-menu-item is-danger" data-qa-act="delete">🗑 删除</div>
        </div>
      </div>`;
    box.appendChild(user);
    // 用户气泡：⋯ 菜单（重命名/删除）
    const moreBtn = user.querySelector('.kb-qa-more-btn');
    const menu = user.querySelector('.kb-qa-msg-menu');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.kb-qa-msg-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
      menu.hidden = !menu.hidden;
    });
    menu.querySelectorAll('[data-qa-act]').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.hidden = true;
        const act = item.dataset.qaAct;
        const body = user.querySelector('.kb-qa-msg-body');
        if (act === 'delete') {
          // 删除当前问答对：用户气泡 + 紧随的 AI 气泡
          user.remove();
          let nxt = user.nextElementSibling;
          while (nxt && nxt.classList.contains('kb-qa-msg')) { const cur = nxt; nxt = nxt.nextElementSibling; cur.remove(); }
          _maybeShowQaHint();
        } else if (act === 'rename') {
          let next = null;
          try { next = typeof uiPrompt === 'function' ? await uiPrompt('重命名问题：', body.textContent) : window.prompt('重命名问题：', body.textContent); }
          catch (_) { return; }
          if (next && next.trim()) body.textContent = next.trim();
        }
      });
    });
    // 点击别处关闭菜单
    user.querySelector('.kb-qa-msg-body').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = true; });

    const ai = document.createElement('div');
    ai.className = 'kb-qa-msg is-ai is-typing';
    ai.innerHTML = '<div class="kb-qa-msg-body kb-qa-stream"></div>';
    box.appendChild(ai);
    const streamBody = ai.querySelector('.kb-qa-stream');
    box.scrollTop = box.scrollHeight;
    _removeQaHint(); // 有消息后移除空状态占位（不创建）

    if (!window.cogseed || typeof window.cogseed.stream !== 'function') {
      ai.classList.remove('is-typing');
      streamBody.textContent = '问答服务不可用';
      return;
    }
    let text = '';
    try {
      // 先捕获附件路径，再清空（顺序关键：否则 attachPaths 恒为空）
      const attachPaths = (_state.qaAttachments || []).map((a) => a.path);
      if (_state.qaAttachments && _state.qaAttachments.length) {
        _state.qaAttachments = [];
        _renderQaAttachments();
      }
      const handle = window.cogseed.stream('kbqa.askStream', { question: q, space_id: _state.spaceId || null, k: 8, attach_paths: attachPaths, history: _state.qaHistory.slice(0, -1) }, (ev) => {
        if (!ev) return;
        if (ev.type === 'delta' && ev.text) {
          text += ev.text;
          streamBody.textContent = text;
          box.scrollTop = box.scrollHeight;
        } else if (ev.type === 'final') {
          ai.classList.remove('is-typing');
          text = ev.text || text;
          streamBody.textContent = text;
          // 多轮上下文：回答入 history + 持久化当前会话
          _state.qaHistory.push({ role: 'assistant', content: text });
          _qaSaveCurrentSession(q);
          const evidence = Array.isArray(ev.evidence) ? ev.evidence : [];
          if (evidence.length) {
            // 引用折叠（方案1）：默认只显示「引用(N)」按钮，点击展开全部锚点
            const refs = document.createElement('div');
            refs.className = 'kb-qa-refs';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'kb-qa-refs-toggle';
            toggle.textContent = `引用(${evidence.length}) ▾`;
            toggle.setAttribute('aria-expanded', 'false');
            const list = document.createElement('div');
            list.className = 'kb-qa-refs-list';
            list.hidden = true;
            for (const r of evidence) {
              const chip = document.createElement('button');
              chip.type = 'button';
              chip.className = 'kb-qa-chip';
              chip.textContent = `${r.path}#chunk ${r.chunkIdx} ↗`;
              chip.title = '跳转到原文';
              chip.addEventListener('click', () => _openAnchor(r));
              list.appendChild(chip);
            }
            toggle.addEventListener('click', () => {
              list.hidden = !list.hidden;
              toggle.textContent = list.hidden ? `引用(${evidence.length}) ▾` : `引用(${evidence.length}) ▴`;
              toggle.setAttribute('aria-expanded', String(!list.hidden));
            });
            refs.appendChild(toggle);
            refs.appendChild(list);
            streamBody.appendChild(refs);
          }
          // 每条 AI 回答末尾附「生成脑图」按钮：基于本条回答文本生成（不是整库）
          const mmRow = document.createElement('div');
          mmRow.className = 'kb-qa-mm-action';
          const mmBtn = document.createElement('button');
          mmBtn.type = 'button';
          mmBtn.className = 'kb-qa-mm-btn';
          mmBtn.innerHTML = '🧠 生成脑图';
          mmBtn.title = '基于本条回答内容生成脑图';
          const answerText = text;
          mmBtn.addEventListener('click', () => _genMindmapFromText(answerText, mmBtn));
          mmRow.appendChild(mmBtn);
          streamBody.appendChild(mmRow);
          box.scrollTop = box.scrollHeight;
        } else if (ev.type === 'error') {
          ai.classList.remove('is-typing');
          streamBody.textContent = '出错了：' + (ev.text || 'unknown');
        }
      });
      if (handle && handle.promise) handle.promise.catch(() => { /* ignore */ });
    } catch (err) {
      ai.classList.remove('is-typing');
      streamBody.textContent = '出错了：' + ((err && err.message) || String(err));
    }
  }

  function _openAnchor(ref) {
    if (typeof window.__openAnchorViewer === 'function') {
      window.__openAnchorViewer({
        source: ref.source || 'library',
        scope: ref.scope || 'global',
        path: ref.path,
        chunkIdx: ref.chunkIdx,
      });
      return;
    }
    if (typeof uiToast === 'function') uiToast('原文查看器未就绪（anchored-source-view 未加载）', { variant: 'warning' });
  }

  // ── kb 状态实时流 ──
  function _ensureKbStream() {
    if (_state.streamHandle) return;
    if (!window.cogseed || typeof window.cogseed.stream !== 'function') return;
    try {
      _state.streamHandle = window.cogseed.stream('kb.events', {}, (ev) => {
        const inner = ev && ev.event;
        if (!inner || !inner.relPath) return;
        if (inner.status === 'deleted') _state.kbStatus.delete(inner.relPath);
        else _state.kbStatus.set(inner.relPath, { status: inner.status, chunks: inner.chunks, kind: inner.kind, error: inner.error });
        _renderFiles();
      });
      _state.streamHandle.promise.catch(() => { /* ignore */ });
    } catch (err) {
      _log.warn('subscribe kb.events failed', err);
    }
  }

  // ── DOM 构建（幂等）──
  function renderKbWorkbench() {
    const host = document.getElementById('kb-workbench');
    if (!host) return;
    if (_state.rendered) {
      _loadAll();
      return;
    }
    _state.rendered = true;
    host.innerHTML = `
      <div class="kb-wb">
        <button type="button" class="kb-wb-side-expand" id="kb-wb-side-expand" title="展开知识库列表" hidden>${_svg('chevron-right')}</button>
        <aside class="kb-wb-side">
          <div class="kb-wb-side-head">
            <h2>知识库列表</h2>
            <div class="kb-wb-side-actions">
              <button type="button" class="kb-wb-icon-btn" id="kb-wb-side-collapse" title="收起 / 展开知识库面板">${_svg('panel-collapse')}</button>
              <button type="button" class="kb-wb-icon-btn" id="kb-wb-side-search-btn" title="搜索知识库">${_svg('search')}</button>
            </div>
          </div>
          <div class="kb-wb-side-search" id="kb-wb-side-search" hidden>
            <span class="kb-wb-side-search-ico">${_svg('search')}</span>
            <input type="text" id="kb-wb-side-search-input" placeholder="搜索知识库…" autocomplete="off" spellcheck="false" />
          </div>
          <div class="kb-wb-tree" id="kb-wb-tree"></div>
        </aside>
        <div class="kb-wb-divider" data-wb-divider="1" title="拖动调整宽度"></div>
        <section class="kb-wb-mid">
          <div class="kb-wb-mid-head">
            <div class="kb-wb-lib-head">
              <div class="kb-wb-lib-cover" id="kb-wb-lib-cover"><svg class="kb-wb-cover-svg" viewBox="0 0 24 24" fill="rgba(255,255,255,.96)" stroke="rgba(255,255,255,.96)" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h4.2l1.8 2.2h7a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg></div>
              <div class="kb-wb-lib-meta">
                <div class="kb-wb-lib-name" id="kb-wb-lib-name">知识库</div>
                <div class="kb-wb-lib-owner" id="kb-wb-lib-owner"><span class="kb-wb-owner-avatar" id="kb-wb-owner-avatar">我</span><span class="kb-wb-owner-name" id="kb-wb-owner-name">我</span></div>
                <div class="kb-wb-lib-desc" id="kb-wb-lib-desc">快来填写描述吧~</div>
                <div class="kb-wb-lib-sub">
                  <span class="kb-wb-tag" id="kb-wb-lib-tag">个人知识库</span>
                  <span class="kb-wb-members" id="kb-wb-members">1 加入</span>
                </div>
              </div>
              <div class="kb-wb-lib-actions">
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-share" title="分享知识库">${_svg('share')}</button>
                <div class="kb-wb-more">
                  <button type="button" class="kb-wb-icon-btn" id="kb-wb-more-btn" title="更多">${_svg('more')}</button>
                  <div class="kb-wb-more-menu" id="kb-wb-more-menu" hidden>
                    <div class="kb-wb-more-item" data-more="refresh">刷新</div>
                    <div class="kb-wb-more-item" data-more="rename">重命名</div>
                    <div class="kb-wb-more-item is-danger" data-more="delete">删除到回收站</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="kb-wb-mid-sub">
              <div class="kb-wb-content-title">内容(<span id="kb-wb-count">0</span>)</div>
              <input id="kb-wb-search-input" placeholder="搜索文档…" autocomplete="off">
              <div class="kb-wb-tools">
                <div class="kb-wb-sort">
                  <button type="button" class="kb-wb-icon-btn" id="kb-wb-sort" title="排序">${_svg('sort')}</button>
                  <div class="kb-wb-sort-menu" id="kb-wb-sort-menu" hidden>
                    <div class="kb-wb-sort-item is-selected" data-sort="updated">✓ 更新时间</div>
                    <div class="kb-wb-sort-item" data-sort="size">大小</div>
                    <div class="kb-wb-sort-item" data-sort="type">类型</div>
                    <div class="kb-wb-sort-item" data-sort="name">名称</div>
                  </div>
                </div>
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-refresh" title="重置排序并刷新">${_svg('refresh')}</button>
                <div class="kb-wb-import-wrap">
                  <button type="button" class="kb-wb-icon-btn" id="kb-wb-import" title="导入内容">${_svg('upload')}</button>
                  <div class="kb-wb-import-menu" id="kb-wb-import-menu" hidden>
                    <div class="kb-wb-import-item" data-imp="file">📄 本地文件</div>
                    <div class="kb-wb-import-item" data-imp="dir">📁 本地文件夹</div>
                    <div class="kb-wb-import-item" data-imp="kblib">📚 个人知识库</div>
                    <div class="kb-wb-import-item" data-imp="url">🔗 网页链接</div>
                    <div class="kb-wb-import-has-sub">
                      <div class="kb-wb-import-item" data-imp="note">🗒 笔记 <span class="kb-import-caret">▸</span></div>
                      <div class="kb-wb-import-sub" id="kb-wb-import-note-sub" hidden>
                        <div class="kb-wb-import-item" data-imp="note-new">✏️ 新建笔记</div>
                        <div class="kb-wb-import-item" data-imp="note-import">📥 导入笔记</div>
                      </div>
                    </div>
                    <div class="kb-wb-import-item" data-imp="audio">🎙 录音纪要</div>
                    <div class="kb-wb-import-item" data-imp="folder">🗂 新建文件夹</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="kb-wb-crumb" id="kb-wb-crumb" hidden></div>
          </div>
          <div class="kb-wb-files" id="kb-wb-files"></div>
        </section>
        <div class="kb-wb-divider" data-wb-divider="2" title="拖动调整宽度"></div>
        <section class="kb-wb-right">
          <div class="kb-wb-right-head"><span class="kb-wb-chip">📚 <span id="kb-wb-right-lib">—</span></span><span class="kb-wb-local"><span class="kb-wb-dot"></span>本地推理 · 资料不上云</span></div>
          <div class="kb-wb-right-body" id="kb-wb-right">
            <div class="kb-wb-right-card" id="kb-wb-analysis-card">
              <div class="kb-wb-right-card-title">
                <span><span class="kb-wb-ai-chip"></span>AI 解析本知识库</span>
                <span class="kb-wb-card-actions">
                  <button type="button" class="kb-wb-a-btn is-primary" id="kb-wb-gen-mm" disabled title="请先点击「✨ 生成 AI 解析」">🧠 生成脑图</button>
                  <button type="button" class="kb-wb-a-btn" id="kb-wb-gen-quiz" disabled title="请先点击「✨ 生成 AI 解析」">📝 生成测验</button>
                </span>
              </div>
              <div class="kb-wb-right-card-sub" id="kb-wb-analysis-sub">当前库：—</div>
              <div class="kb-wb-right-placeholder"><button type="button" class="kb-wb-a-btn" id="kb-analyze-btn">✨ 生成 AI 解析</button></div>
            </div>
            <div class="kb-qa-session">
              <div class="kb-qa-session-head">
                <span class="kb-qa-session-date" id="kb-qa-session-date"></span>
                <div class="kb-qa-session-actions">
                  <button type="button" class="kb-qa-session-btn" id="kb-qa-popout" title="新建对话">${_svg('plus')}</button>
                  <button type="button" class="kb-qa-session-btn" id="kb-qa-history" title="会话历史">${_svg('history')}</button>
                  <button type="button" class="kb-qa-session-btn" id="kb-qa-clear" title="清空当前对话">${_svg('close')}</button>
                </div>
              </div>
              <div class="kb-qa-messages" id="kb-qa-messages"></div>
            </div>
          </div>
          <div class="kb-wb-right-input">
            <div class="kb-qa-degraded-note" id="kb-qa-degraded-note" hidden>当前解析降级，问答能力受限</div>
            <div class="kb-qa-attach-strip" id="kb-qa-attach-strip" hidden></div>
            <div class="kb-qa-box">
              <select class="kb-qa-model" id="kb-qa-model" title="问答模型（真实配置）"></select>
              <span class="kb-qa-divider"></span>
              <textarea class="kb-qa-input" id="kb-qa-input" rows="1" placeholder="基于知识库提问"></textarea>
              <div class="kb-qa-icon-wrap" id="kb-qa-attach-wrap">
                <button type="button" class="kb-qa-icon-btn" id="kb-qa-attach" title="上传附件">${_svg('paperclip')}</button>
                <div class="kb-qa-attach-tip" id="kb-qa-attach-tip" hidden>
                  <div class="kb-qa-attach-tip-title">支持上传附件</div>
                  <div class="kb-qa-attach-tip-item">• 文件数量：最多支持 5 个</div>
                  <div class="kb-qa-attach-tip-item">• 文件类型：pdf、doc、docx、ppt、pptx、xls、xlsx、csv、jpg、jpeg、png、webp、md、txt、xmind、mp3、m4a、wav、aac、html、epub</div>
                  <div class="kb-qa-attach-tip-item">• 文本类附件会作为本次提问的补充上下文</div>
                </div>
              </div>
              <button type="button" class="kb-qa-icon-btn" id="kb-qa-tools" title="更多工具">${_svg('tools')}</button>
              <button type="button" class="kb-qa-send" id="kb-qa-send" title="发送" disabled>${_svg('send')}</button>
            </div>
            <div class="kb-qa-note">内容由 AI 生成仅供参考 · 引用均已核验锚点</div>
          </div>
        </section>
      </div>
      <div class="kb-mm-overlay" id="kb-mm-overlay" hidden>
        <div class="kb-mm-dlg" id="kb-mm-dlg">
        <div class="kb-mm-titlebar" id="kb-mm-titlebar">
          <span class="kb-mm-titlebar-ico">🧠</span>
          <input class="kb-mm-title-input" id="kb-mm-title-input" value="脑图预览" title="双击修改标题" spellcheck="false" />
          <span class="kb-mm-save-state" id="kb-mm-save-state"></span>
          <div class="kb-mm-titlebar-actions">
            <button type="button" id="kb-mm-mode-btn" title="切换预览/编辑模式">👁 预览</button>
            <button type="button" id="kb-mm-popout-btn" title="弹出独立窗口">⧉ 独立窗口</button>
            <button type="button" class="kb-mm-overlay-close" id="kb-mm-overlay-close" title="关闭（Esc）">✕</button>
          </div>
        </div>
        <div class="kb-mm-overlay-toolbar">
          <div class="kb-mm-tb-group">
            <button type="button" id="kb-mm-undo" title="撤销">↩ 撤销</button>
            <button type="button" id="kb-mm-refresh" title="重新生成脑图">⟳ 刷新</button>
          </div>
          <div class="kb-mm-tb-group">
            <button type="button" id="kb-mm-save" title="保存到知识库">💾 保存</button>
            <div class="kb-mm-open">
              <button type="button" id="kb-mm-open-btn" title="打开已保存的脑图">📂 存档 ▾</button>
              <div class="kb-mm-open-menu" id="kb-mm-open-menu" hidden></div>
            </div>
            <div class="kb-mm-export">
              <button type="button" id="kb-mm-export-btn" title="导出">📥 导出 ▾</button>
              <div class="kb-mm-export-menu" id="kb-mm-export-menu" hidden>
                <div class="kb-mm-export-item" data-export="png">🖼 下载 PNG 图片</div>
                <div class="kb-mm-export-item" data-export="svg">📐 下载 SVG 矢量图</div>
                <div class="kb-mm-export-item" data-export="pdf">📄 下载 PDF 文档</div>
                <div class="kb-mm-export-item" data-export="md">📝 导出 Markdown 大纲</div>
                <div class="kb-mm-export-item" data-export="copy">📋 复制到剪贴板</div>
              </div>
            </div>
          </div>
          <div class="kb-mm-tb-group kb-mm-tb-view">
            <div class="kb-mm-layout">
              <button type="button" id="kb-mm-layout-btn" title="切换布局">📐 布局</button>
              <div class="kb-mm-layout-menu" id="kb-mm-layout-menu" hidden>
                <div class="kb-mm-layout-item" data-mode="mind">🧠 思维导图（双向放射）</div>
                <div class="kb-mm-layout-item" data-mode="org">🏢 组织结构图（单向）</div>
              </div>
            </div>
            <button type="button" id="kb-mm-expand-all" title="全部展开">⤢ 展开</button>
            <button type="button" id="kb-mm-collapse-all" title="全部收拢">⤡ 收拢</button>
            <button type="button" id="kb-mm-focus-btn" title="聚焦分支">◎ 聚焦</button>
            <button type="button" id="kb-mm-outline-btn" title="大纲视图切换">☰ 大纲</button>
            <button type="button" id="kb-mm-bg-btn" title="背景切换">▦ 背景</button>
            <button type="button" id="kb-mm-dots-btn" title="点阵开关">▤ 点阵</button>
          </div>
          <div class="kb-mm-tb-group kb-mm-tb-more">
            <input type="search" class="kb-mm-search" id="kb-mm-search" placeholder="搜索节点…" />
            <div class="kb-mm-overlay-zoom">
              <button type="button" id="kb-mm-zoom-out" title="缩小">−</button>
              <span id="kb-mm-zoom-label">100%</span>
              <button type="button" id="kb-mm-zoom-in" title="放大">＋</button>
              <button type="button" id="kb-mm-reset" title="适应画布">适应</button>
            </div>
            <div class="kb-mm-more">
              <button type="button" id="kb-mm-more-btn" title="更多">⋯</button>
              <div class="kb-mm-more-menu" id="kb-mm-more-menu" hidden></div>
            </div>
          </div>
        </div>
        <div class="kb-mm-overlay-stage" id="kb-mm-overlay-stage">
          <div class="kb-mm-overlay-wrap" id="kb-mm-overlay-wrap"></div>
          <div class="kb-mm-overlay-stage-hint">滚轮缩放｜拖拽平移｜点击聚焦｜−/+折叠｜双击重命名</div>
        </div>
        <div class="kb-mm-resize" id="kb-mm-resize" title="拖动调整窗口大小"></div>
        </div>
      </div>`;
    // 右列强制 flex column（JS 兜底：个别环境下样式表规则未应用时保证输入栏贴底）
    const _kbRightEl = document.getElementById('kb-wb-right');
    if (_kbRightEl) {
      _kbRightEl.style.display = 'flex';
      _kbRightEl.style.flexDirection = 'column';
    }
    document.getElementById('kb-wb-lib-name').textContent = _state.currentLib || '知识库';
    document.getElementById('kb-wb-right-lib').textContent = _state.currentLib || '—';
    // 知识库列表搜索：点击放大镜展开输入框，实时过滤全部库（个人+共享）
    const sideSearch = document.getElementById('kb-wb-side-search');
    const sideSearchInput = document.getElementById('kb-wb-side-search-input');
    document.getElementById('kb-wb-side-search-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!sideSearch) return;
      sideSearch.hidden = !sideSearch.hidden;
      if (!sideSearch.hidden) {
        sideSearchInput?.focus();
      } else {
        _state.treeFilter = '';
        if (sideSearchInput) sideSearchInput.value = '';
        _renderTree();
      }
    });
    sideSearchInput?.addEventListener('input', (e) => {
      _state.treeFilter = String(e.target.value || '').trim().toLowerCase();
      _renderTree();
    });
    sideSearchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        _state.treeFilter = '';
        sideSearchInput.value = '';
        _renderTree();
        if (sideSearch) sideSearch.hidden = true;
      }
    });
    // 侧边栏折叠：收起整个知识库列表面板，给内容区更多空间
    const collapseBtn = document.getElementById('kb-wb-side-collapse');
    const expandBtn = document.getElementById('kb-wb-side-expand');
    const applySideCollapsed = () => {
      const wb = document.querySelector('.kb-wb');
      if (wb) wb.classList.toggle('side-collapsed', _state.sideCollapsed);
      if (collapseBtn) collapseBtn.hidden = _state.sideCollapsed;
      if (expandBtn) expandBtn.hidden = !_state.sideCollapsed;
    };
    collapseBtn?.addEventListener('click', () => {
      _state.sideCollapsed = true;
      applySideCollapsed();
    });
    expandBtn?.addEventListener('click', () => {
      _state.sideCollapsed = false;
      applySideCollapsed();
    });
    applySideCollapsed();
    // 分隔条拖拽：aside/mid、mid/right 之间左右调整列宽（对标 ima）
    // 宽度持久化到 localStorage（环境无 localStorage 时静默降级）
    let dividerDrag = null;
    const _dividerLoad = () => {
      try {
        const c1 = Number(localStorage.getItem('kb-wb-c1'));
        const c2 = Number(localStorage.getItem('kb-wb-c2'));
        const wb = document.querySelector('.kb-wb');
        if (!wb) return;
        if (c1 >= 140 && c1 <= 420) wb.style.setProperty('--kb-c1', `${c1}px`);
        if (c2 >= 240 && c2 <= 620) wb.style.setProperty('--kb-c2', `${c2}px`);
      } catch { /* no-op */ }
    };
    const _dividerClamp = (idx, w) => (idx === 1 ? Math.min(420, Math.max(140, w)) : Math.min(620, Math.max(240, w)));
    const _dividerSave = () => {
      try {
        const wb = document.querySelector('.kb-wb');
        if (!wb) return;
        localStorage.setItem('kb-wb-c1', wb.style.getPropertyValue('--kb-c1') || '236');
        localStorage.setItem('kb-wb-c2', wb.style.getPropertyValue('--kb-c2') || '372');
      } catch { /* no-op */ }
    };
    _dividerLoad();
    document.querySelectorAll('.kb-wb-divider').forEach((div) => {
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(div.dataset.wbDivider) || 1;
        const wb = document.querySelector('.kb-wb');
        if (!wb) return;
        if (_state.sideCollapsed && idx === 1) return; // 折叠态第 1 条不可拖
        const startX = e.clientX;
        const startC1 = parseFloat(wb.style.getPropertyValue('--kb-c1')) || 236;
        const startC2 = parseFloat(wb.style.getPropertyValue('--kb-c2')) || 372;
        const dividerIndex = idx; // 1=aside/mid，2=mid/right
        dividerDrag = { dividerIndex, startX, startC1, startC2 };
        document.body.classList.add('kb-wb-resizing');
        div.classList.add('is-dragging');
      });
    });
    document.addEventListener('mousemove', (e) => {
      if (!dividerDrag) return;
      const wb = document.querySelector('.kb-wb');
      if (!wb) return;
      const dx = e.clientX - dividerDrag.startX;
      if (dividerDrag.dividerIndex === 1) {
        const w = _dividerClamp(1, dividerDrag.startC1 + dx);
        wb.style.setProperty('--kb-c1', `${w}px`);
      } else {
        const w = _dividerClamp(2, dividerDrag.startC2 + dx);
        wb.style.setProperty('--kb-c2', `${w}px`);
      }
    });
    document.addEventListener('mouseup', () => {
      if (!dividerDrag) return;
      dividerDrag = null;
      document.body.classList.remove('kb-wb-resizing');
      document.querySelectorAll('.kb-wb-divider').forEach((x) => x.classList.remove('is-dragging'));
      _dividerSave();
    });
    document.getElementById('kb-wb-search-input')?.addEventListener('input', (e) => {
      _state.filter = e.target.value;
      _renderFiles();
    });
    // 排序下拉（对齐 ima：更新时间/大小/类型/名称）
    const sortMenu = document.getElementById('kb-wb-sort-menu');
    document.getElementById('kb-wb-sort')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sortMenu) sortMenu.hidden = !sortMenu.hidden;
    });
    document.querySelectorAll('.kb-wb-sort-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        _state.sort = item.dataset.sort;
        document.querySelectorAll('.kb-wb-sort-item').forEach((x) => x.classList.remove('is-selected'));
        item.classList.add('is-selected');
        if (sortMenu) sortMenu.hidden = true;
        _renderFiles();
        const label = { updated: '更新时间', size: '大小', type: '类型', name: '名称' }[_state.sort] || _state.sort;
        if (typeof uiToast === 'function') uiToast(`排序：${label}`, { variant: 'info' });
      });
    });
    // 分享 + 更多菜单
    document.getElementById('kb-wb-share')?.addEventListener('click', () => {
      if (typeof uiToast === 'function') uiToast('分享功能开发中（即将支持链接/邀请）', { variant: 'info' });
    });
    const moreMenu = document.getElementById('kb-wb-more-menu');
    document.getElementById('kb-wb-more-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (moreMenu) moreMenu.hidden = !moreMenu.hidden;
    });
    document.querySelectorAll('.kb-wb-more-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (moreMenu) moreMenu.hidden = true;
        const act = item.dataset.more;
        if (act === 'refresh') { _loadAll(); if (typeof uiToast === 'function') uiToast('已刷新', { variant: 'info' }); }
        else if (act === 'rename') {
          if (_state.spaceId) _kbRenameSpace(_state.spaceId);
          else if (_state.currentLib) _kbRename(_state.currentLib, true);
        }
        else if (act === 'delete') {
          if (_state.spaceId) _kbDeleteSpace(_state.spaceId);
          else if (_state.currentLib) _kbDelete(_state.currentLib);
        }
        else if (typeof uiToast === 'function') uiToast('该操作暂不可用', { variant: 'info' });
      });
    });
    // 重置按钮：恢复默认排序（更新时间）+ 刷新数据 + 提示（对齐 ima 重置语义）
    document.getElementById('kb-wb-refresh')?.addEventListener('click', () => {
      _state.sort = 'updated';
      document.querySelectorAll('.kb-wb-sort-item').forEach((x) => x.classList.remove('is-selected'));
      const def = document.querySelector('.kb-wb-sort-item[data-sort="updated"]');
      if (def) def.classList.add('is-selected');
      _loadAll();
      if (typeof uiToast === 'function') uiToast('已重置排序（更新时间）并刷新', { variant: 'info', timeoutMs: 2000 });
    });
    // 导入按钮 → 多级导入菜单（对齐 ima：本地文件/文件夹/网页/笔记/新建文件夹等）
    const importMenu = document.getElementById('kb-wb-import-menu');
    const importNoteSub = document.getElementById('kb-wb-import-note-sub');
    document.getElementById('kb-wb-import')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (importMenu) importMenu.hidden = !importMenu.hidden;
    });
    document.querySelectorAll('.kb-wb-import-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = item.dataset.imp;
        if (!act || act === 'note') return;
        if (importMenu) importMenu.hidden = true;
        const isSpace = !!_state.spaceId;
        if (act === 'file') { if (isSpace) _importSpaceFiles(); else _importFiles(); }
        else if (act === 'dir') { if (isSpace) _importSpaceDir(); else _importDir(); }
        else if (act === 'url') _kbImportWebUrl();
        else if (act === 'kblib') { if (isSpace) _importSpaceFromLib(); else _kbMigrateLib(); }
        else if (act === 'note-new') _kbNewNote();
        else if (act === 'note-import') { if (isSpace) _importSpaceFiles(); else _importFiles(); }
        else if (act === 'folder') _kbNewFolder();
        else if (typeof uiToast === 'function') uiToast('该导入渠道即将上线', { variant: 'info' });
      });
    });
    // 笔记 → 二级子菜单（悬浮展开 + 点击 toggle，向右弹出）
    const noteWrap = importMenu ? importMenu.querySelector('.kb-wb-import-has-sub') : null;
    if (noteWrap && importNoteSub) {
      noteWrap.addEventListener('mouseenter', () => { importNoteSub.hidden = false; });
      noteWrap.addEventListener('mouseleave', () => { importNoteSub.hidden = true; });
      const noteToggle = noteWrap.querySelector('[data-imp="note"]');
      if (noteToggle) {
        noteToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          importNoteSub.hidden = !importNoteSub.hidden;
        });
      }
      importNoteSub.querySelectorAll('.kb-wb-import-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = item.dataset.imp;
          if (importMenu) importMenu.hidden = true;
          if (act === 'note-new') _kbNewNote();
          else if (act === 'note-import') { if (_state.spaceId) _importSpaceFiles(); else _importFiles(); }
        });
      });
    }
    document.getElementById('kb-qa-send')?.addEventListener('click', () => _submitQa());
    document.getElementById('kb-qa-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _submitQa();
      }
    });
    // 会话头：日期 / 新建对话 / 历史 / 关闭
    const _qaDate = document.getElementById('kb-qa-session-date');
    if (_qaDate) {
      const d = new Date();
      _qaDate.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }
    document.getElementById('kb-qa-popout')?.addEventListener('click', () => {
      _qaNewSession(); // 独立窗口按钮 = 新建会话（保留历史，开启新上下文）
    });
    document.getElementById('kb-qa-history')?.addEventListener('click', () => {
      _qaOpenHistory();
    });
    // 关闭会话：清空当前对话内容（保留历史）
    document.getElementById('kb-qa-clear')?.addEventListener('click', () => {
      _clearQa();
      if (typeof uiToast === 'function') uiToast('会话已清空', { variant: 'info' });
    });
    // 载入历史会话列表（初始化）
    _qaLoadSessions();
    // 附件：选择本地文件挂载到本次提问（最多 5 个，发送时作为补充上下文）
    const attachWrap = document.getElementById('kb-qa-attach-wrap');
    const attachTip = document.getElementById('kb-qa-attach-tip');
    attachWrap?.addEventListener('mouseenter', () => { if (attachTip) attachTip.hidden = false; });
    attachWrap?.addEventListener('mouseleave', () => { if (attachTip) attachTip.hidden = true; });
    document.getElementById('kb-qa-attach')?.addEventListener('click', async () => {
      if (_state.qaAttachments.length >= 5) {
        if (typeof uiToast === 'function') uiToast('最多支持 5 个附件', { variant: 'warning' });
        return;
      }
      if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
      try {
        const res = await window.cogseed.invoke('kbqa.attachPick', {});
        const files = (res && Array.isArray(res.files)) ? res.files : [];
        for (const f of files) {
          if (_state.qaAttachments.length >= 5) break;
          if (!_state.qaAttachments.some((a) => a.path === f.path)) {
            _state.qaAttachments.push({ name: f.name, path: f.path, size: Number(f.size) || 0 });
          }
        }
        _renderQaAttachments();
      } catch (err) {
        _log.warn('attach pick failed', err);
        if (typeof uiToast === 'function') uiToast('选择附件失败', { variant: 'error' });
      }
    });
    // 更多工具：占位菜单
    document.getElementById('kb-qa-tools')?.addEventListener('click', () => {
      if (typeof uiToast === 'function') uiToast('更多工具：即将上线', { variant: 'info' });
    });
    // 脑图预览层事件：缩放 / 平移 / 关闭
    document.getElementById('kb-mm-export-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = document.getElementById('kb-mm-export-menu');
      if (m) m.hidden = !m.hidden;
    });
    document.querySelectorAll('[data-export]').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.export;
      if (k === 'png') _mmExportPng();
      else if (k === 'svg') _mmExportSvg();
      else if (k === 'pdf') _mmExportPdf();
      else if (k === 'md') _mmExportMd();
      else if (k === 'copy') _mmCopySvg();
      const m = document.getElementById('kb-mm-export-menu');
      if (m) m.hidden = true;
    }));
    document.addEventListener('click', () => {
      const m = document.getElementById('kb-mm-export-menu');
      if (m) m.hidden = true;
      const om = document.getElementById('kb-mm-open-menu');
      if (om) om.hidden = true;
      const lm = document.getElementById('kb-mm-layout-menu');
      if (lm) lm.hidden = true;
      const sm = document.getElementById('kb-wb-sort-menu');
      if (sm) sm.hidden = true;
      const mm = document.getElementById('kb-wb-more-menu');
      if (mm) mm.hidden = true;
      const im = document.getElementById('kb-wb-import-menu');
      if (im) im.hidden = true;
    });
    document.getElementById('kb-mm-overlay-close')?.addEventListener('click', () => {
      document.getElementById('kb-mm-overlay').hidden = true;
      _mmRestoreThumbs();
    });
    document.getElementById('kb-mm-zoom-in')?.addEventListener('click', () => { _mmZoom = Math.min(4, _mmZoom * 1.25); _applyMmTransform(); });
    document.getElementById('kb-mm-zoom-out')?.addEventListener('click', () => { _mmZoom = Math.max(0.2, _mmZoom / 1.25); _applyMmTransform(); });
    document.getElementById('kb-mm-reset')?.addEventListener('click', () => _mmFitToStage());
    document.getElementById('kb-mm-layout-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = document.getElementById('kb-mm-layout-menu');
      if (!m) return;
      m.hidden = !m.hidden;
    });
    document.querySelectorAll('.kb-mm-layout-item').forEach((el) => el.addEventListener('click', () => {
      const mode = el.dataset.mode;
      if (mode === 'org' || mode === 'mind') {
        _state.mmMode = mode;
        _mmUpdateToolbarState();
        if (_state.mmViewMode === 'graph') { _renderOverlay(); _mmFitToStage(); }
      }
      const m = document.getElementById('kb-mm-layout-menu');
      if (m) m.hidden = true;
    }));
    document.getElementById('kb-mm-expand-all')?.addEventListener('click', _mmExpandAll);
    document.getElementById('kb-mm-collapse-all')?.addEventListener('click', _mmCollapseAll);
    document.getElementById('kb-mm-focus-btn')?.addEventListener('click', _mmToggleFocus);
    document.getElementById('kb-mm-outline-btn')?.addEventListener('click', _mmToggleOutline);
    document.getElementById('kb-mm-bg-btn')?.addEventListener('click', _mmCycleBg);
    // 悬浮窗增强绑定：模式切换 / 点阵开关 / 更多菜单 / 独立窗口 / 标题双击 / ESC 关闭
    document.getElementById('kb-mm-mode-btn')?.addEventListener('click', _mmToggleMode);
    document.getElementById('kb-mm-dots-btn')?.addEventListener('click', _mmToggleDots);
    document.getElementById('kb-mm-more-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = document.getElementById('kb-mm-more-menu');
      if (!m) return;
      _buildMoreMenu();
      m.hidden = !m.hidden;
    });
    document.getElementById('kb-mm-popout-btn')?.addEventListener('click', _mmPopout);
    const titleInput = document.getElementById('kb-mm-title-input');
    titleInput?.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      titleInput.focus();
      titleInput.select();
    });
    titleInput?.addEventListener('change', () => {
      const t = String(titleInput.value || '').trim();
      if (t) titleInput.value = t;
      else titleInput.value = _state.spaceId ? _state.spaceName : (_state.currentLib || '脑图');
      _mmMarkDirty();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const ov = document.getElementById('kb-mm-overlay');
        if (ov && !ov.hidden) ov.hidden = true;
        const d = document.querySelector('.kb-import-dlg-overlay');
        if (d) d.remove();
      }
    });
    const mmSearchInput = document.getElementById('kb-mm-search');
    let mmSearchTimer = null;
    mmSearchInput?.addEventListener('input', () => {
      clearTimeout(mmSearchTimer);
      mmSearchTimer = setTimeout(() => _mmSearch(mmSearchInput.value), 220);
    });
    document.getElementById('kb-mm-undo')?.addEventListener('click', () => {
      const root = _state.lastMind;
      const step = _mmUndoStack.pop();
      if (!root || !step) {
        if (typeof uiToast === 'function') uiToast('没有可撤销的重命名', { variant: 'info' });
        return;
      }
      _mmSetLabelAt(root, step.idx, step.old);
      _rerenderMindmaps();
      _mmFitToStage();
      if (typeof uiToast === 'function') uiToast('已撤销重命名', { variant: 'info' });
    });
    document.getElementById('kb-mm-refresh')?.addEventListener('click', _mmRefreshMindmap);
    document.getElementById('kb-mm-save')?.addEventListener('click', _mmSaveMindmap);
    document.getElementById('kb-mm-open-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = document.getElementById('kb-mm-open-menu');
      if (!m) return;
      m.hidden = !m.hidden;
      if (!m.hidden) _mmFillOpenMenu();
    });
    const mmStage = document.getElementById('kb-mm-overlay-stage');
    mmStage?.addEventListener('wheel', (e) => {
      e.preventDefault();
      _mmZoom = Math.max(0.2, Math.min(4, _mmZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      _applyMmTransform();
    }, { passive: false });
    mmStage?.addEventListener('mousedown', (e) => {
      _mmPanning = true;
      _mmPanStart = { x: e.clientX - _mmPanX, y: e.clientY - _mmPanY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!_mmPanning || !_mmPanStart) return;
      _mmPanX = e.clientX - _mmPanStart.x;
      _mmPanY = e.clientY - _mmPanStart.y;
      _applyMmTransform();
    });
    window.addEventListener('mouseup', () => { _mmPanning = false; _mmPanStart = null; });
    document.getElementById('kb-qa-input')?.addEventListener('input', _syncSendState);
    document.getElementById('kb-qa-input')?.addEventListener('keyup', _syncSendState);
    _syncSendState();
    _loadModelOptions();
    _loadAll();
  }

  // 模型下拉：真实配置（auth.listEntries），截断显示 + hover 全名
  function _loadModelOptions() {
    const sel = document.getElementById('kb-qa-model');
    if (!sel) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      sel.innerHTML = '<option>默认模型</option>';
      return;
    }
    window.cogseed.invoke('auth.listEntries', { includeUnavailable: true })
      .then((res) => {
        const entries = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
        if (!entries.length) {
          sel.innerHTML = '<option>未配置模型（请到设置配置）</option>';
          return;
        }
        sel.innerHTML = entries.map((e, i) => {
          const label = `${e.provider || ''} · ${e.modelName || e.model || ''}`;
          return `<option value="${i}" title="${_esc(label)}">${_esc(label)}</option>`;
        }).join('');
        const first = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
        if (first) sel.title = first.title || first.textContent;
        sel.addEventListener('change', () => {
          const opt = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
          if (opt) sel.title = opt.title || opt.textContent;
        });
      })
      .catch(() => {
        sel.innerHTML = '<option>默认模型</option>';
      });
  }

  // 无输入时发送按钮置灰；有内容恢复可用
  function _syncSendState() {
    const input = document.getElementById('kb-qa-input');
    const send = document.getElementById('kb-qa-send');
    if (!input || !send) return;
    send.disabled = !input.value.trim();
  }

  function _submitQa() {
    const input = document.getElementById('kb-qa-input');
    if (!input) return;
    const q = input.value;
    if (!q || !q.trim()) return;
    input.value = '';
    _syncSendState();
    _ask(q);
  }

  // 导入整个文件夹：目录选择器 → 递归收集白名单文件 → 镜像目录结构导入。
  async function _importDir() {
    if (!_state.currentLib) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const dirNode = _currentDirNode();
    const targetDir = dirNode ? dirNode.path : _state.currentLib;
    try {
      const res = await window.cogseed.invoke('contexts.pickAndUploadDir', { targetDir });
      if (!res) return;
      if (res.canceled) return;
      const imported = Number(res.imported) || 0;
      const scanned = Number(res.scanned) || 0;
      if (typeof uiToast === 'function') {
        uiToast(imported ? `已导入 ${imported} 个文件（扫描 ${scanned}）` : '所选文件夹没有可导入的文件', {
          variant: imported ? 'success' : 'warning', timeoutMs: 2500,
        });
      }
      _loadAll();
    } catch (err) {
      _log.warn('import dir failed', err);
      if (typeof uiToast === 'function') uiToast('导入文件夹失败', { variant: 'error' });
    }
  }

  async function _importFiles() {
    if (!_state.currentLib) return;
    const dirNode = _currentDirNode();
    const targetDir = dirNode ? dirNode.path : _state.currentLib;
    try {
      const res = await window.cogseed.invoke('contexts.pickAndUpload', { targetDir });
      if (res && res.ok === false) {
        if (typeof uiToast === 'function') uiToast('导入失败：' + _esc(res.error || 'unknown'), { variant: 'error' });
        return;
      }
      if (typeof uiToast === 'function') uiToast('已导入，开始索引…', { variant: 'success', timeoutMs: 1500 });
      _loadAll();
    } catch (err) {
      _log.warn('import failed', err);
      if (typeof uiToast === 'function') uiToast('导入取消或失败', { variant: 'warning' });
    }
  }

  // ── 资料库管理能力并入知识库（方案 A：复用 contexts.* IPC，主进程零改动）──
  // 新建目标目录：与导入一致（当前库根 / 内联展开的最新目录兜底）
  // 同级重名检测：目标名称是否已存在于同一目录（重命名前预检查，避免 EEXIST 报错）
  function _kbSiblingExists(parent, name) {
    if (!parent) return (_state.tree || []).some((n) => n.name === name);
    const lib = _findLibNode(_state.currentLib);
    if (!lib) return false;
    let node = lib;
    for (const seg of String(parent).split('/').filter(Boolean)) {
      if (seg === lib.name) continue; // 跳过库前缀
      const next = (node.children || []).find((n) => n.name === seg);
      if (!next) return false;
      node = next;
    }
    return (node.children || []).some((n) => n.name === name);
  }

  // 知识库文件扩展名白名单（与主进程 contexts ALLOWED_EXTS 对齐，用于重命名预校验）
  const _KB_ALLOWED_EXTS = new Set([
    '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
    '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
    '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
    '.sql', '.graphql', '.gql',
    '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
    '.png', '.jpg', '.jpeg', '.webp', '.gif',
  ]);
  const _KB_FORBIDDEN_CHARS = /[\\/:*?"<>|]/;

  // 重命名名字预校验：返回错误提示（'' 表示合法）
  function _kbValidateName(name, isFile) {
    if (_KB_FORBIDDEN_CHARS.test(name)) return '名称不能包含 / \\ : * ? " < > | 字符';
    if (name.startsWith('.')) return '名称不能以 . 开头';
    if (isFile) {
      const ext = '.' + String(name).split('.').pop().toLowerCase();
      if (!_KB_ALLOWED_EXTS.has(ext)) return '文件名需保留支持的扩展名（.md .txt .pdf .docx .xlsx .pptx 等）';
    }
    let w = 0;
    for (const ch of name) w += /[\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff]/.test(ch) ? 2 : 1;
    if (w > 100) return '名称过长，请缩短';
    return '';
  }

  async function _kbRename(path, isDir) {
    const cur = String(path || '').split('/').pop() || '';
    const next = typeof uiPrompt === 'function' ? await uiPrompt('重命名：', cur) : window.prompt('重命名：', cur);
    if (!next || !next.trim() || next.trim() === cur) return;
    // 父路径：仅当 path 含斜杠时才取前缀；顶层条目（如库 "2"）父路径为空
    const slashIdx = String(path || '').lastIndexOf('/');
    const parent = slashIdx >= 0 ? String(path).slice(0, slashIdx) : '';
    const newName = String(next).trim();
    // 名字预校验：非法字符 / 点开头 / 文件扩展名 / 长度
    const bad = _kbValidateName(newName, !isDir);
    if (bad) {
      if (typeof uiToast === 'function') uiToast('重命名失败：' + bad, { variant: 'warning' });
      return;
    }
    const dst = parent ? `${parent}/${newName}` : newName;
    // 预检查：同级已有同名条目 → 直接提示，不发 IPC
    if (_kbSiblingExists(parent, newName)) {
      if (typeof uiToast === 'function') uiToast('重命名失败：该名称已存在，请换一个名称', { variant: 'warning' });
      return;
    }
    try {
      const res = await window.cogseed.invoke('contexts.rename', { src: path, dst });
      if (res && res.ok === false) {
        const msg = String(res.error || '');
        if (typeof uiToast === 'function') {
          let friendly = null;
          if (/already exists|exists|eexist|enotempty/i.test(msg)) friendly = '该名称已存在，请换一个名称';
          else if (/unsupported extension/i.test(msg)) friendly = '文件名需保留支持的扩展名（.md .txt .pdf .docx 等）';
          else if (/invalid character/i.test(msg)) friendly = '名称含非法字符';
          else if (/invalid path segment/i.test(msg)) friendly = '名称无效，请检查是否包含非法路径';
          else if (/hidden entries are reserved/i.test(msg)) friendly = '名称不能以 . 开头';
          else if (/too long/i.test(msg)) friendly = '名称过长，请缩短';
          else if (/eacces|eperm/i.test(msg)) friendly = '没有权限重命名';
          uiToast(friendly ? '重命名失败：' + friendly : '重命名失败：' + _esc(msg), { variant: 'error' });
        }
        return;
      }
      // 重命名的是当前选中的库 → 同步选中态，避免跳回第一个库
      if (!_state.spaceId && _state.currentLib === path) _state.currentLib = dst;
      if (typeof uiToast === 'function') uiToast('已重命名', { variant: 'success', timeoutMs: 1500 });
      _loadAll();
    } catch (err) { _log.warn('rename failed', err); if (typeof uiToast === 'function') uiToast('重命名失败', { variant: 'error' }); }
  }

  async function _kbDelete(path) {
    const name = String(path || '').split('/').pop() || path || '';
    let ok = false;
    try {
      ok = typeof uiConfirmDanger === 'function'
        ? await uiConfirmDanger({ title: '删除到回收站', message: `确认删除「${name}」？删除后可在回收站恢复。`, dangerLabel: '删除', cancelLabel: '取消' })
        : window.confirm(`确认删除「${name}」？`);
    } catch (_) { return; }
    if (!ok) return;
    try {
      const res = await window.cogseed.invoke('contexts.delete', { path });
      if (res && res.ok === false) { if (typeof uiToast === 'function') uiToast('删除失败：' + _esc(res.error || 'unknown'), { variant: 'error' }); return; }
      if (typeof uiToast === 'function') uiToast('已删除到回收站（设置 → 回收站可恢复）', { variant: 'success', timeoutMs: 3000 });
      _loadAll();
    } catch (err) { _log.warn('delete failed', err); if (typeof uiToast === 'function') uiToast('删除失败', { variant: 'error' }); }
  }

  function _kbReveal(path) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    window.cogseed.invoke('contexts.reveal', { path }).catch(() => {});
  }

  // 右键 / ⋯ 菜单（body 级浮层）
  let _kbMenuEl = null;
  function _kbMenuShow(items, x, y) {
    _kbMenuHide();
    const el = document.createElement('div');
    el.className = 'kb-ctx-menu';
    el.innerHTML = items.map((it) =>
      `<button type="button" class="kb-ctx-menu-item${it.danger ? ' is-danger' : ''}" data-kb-ctx="${_esc(String(it.key))}">${_esc(it.label)}</button>`
    ).join('');
    el.style.left = Math.min(x, window.innerWidth - 180) + 'px';
    el.style.top = Math.min(y, window.innerHeight - items.length * 34 - 12) + 'px';
    document.body.appendChild(el);
    _kbMenuEl = el;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.kb-ctx-menu-item');
      if (!btn) return;
      const key = btn.dataset.kbCtx;
      _kbMenuHide();
      const item = items.find((i) => i.key === key);
      if (item && item.fn) item.fn();
    });
    setTimeout(() => document.addEventListener('click', _kbMenuHideOnce, { once: true }), 0);
  }
  function _kbMenuHideOnce() { _kbMenuHide(); }
  function _kbMenuHide() {
    if (_kbMenuEl) { _kbMenuEl.remove(); _kbMenuEl = null; }
  }

  function _kbRowMenu(path, isDir, x, y) {
    const items = [
      { key: 'rename', label: '✏️ 重命名', fn: () => _kbRename(path, isDir) },
      { key: 'delete', label: '🗑 删除到回收站', danger: true, fn: () => _kbDelete(path) },
    ];
    if (!isDir) items.push({ key: 'reveal', label: '📂 在文件夹中显示', fn: () => _kbReveal(path) });
    _kbMenuShow(items, x, y);
  }

  // ── 共享知识库（空间）重命名 / 删除（spaces.update / spaces.delete）──
  function _kbSpaceMenu(spaceId, x, y) {
    _kbMenuShow([
      { key: 'rename', label: '✏️ 重命名', fn: () => _kbRenameSpace(spaceId) },
      { key: 'members', label: '👥 知识库成员', fn: () => _kbMembersDialog(spaceId) },
      { key: 'delete', label: '🗑 删除共享知识库', danger: true, fn: () => _kbDeleteSpace(spaceId) },
    ], x, y);
  }

  // ── 共享库文件右键菜单（对齐 ima：置顶/编辑标签/重命名/成员权限▸/移动到/复制到/删除）──
  function _kbSpaceFileMenu(path, x, y) {
    _kbMenuHide();
    const el = document.createElement('div');
    el.className = 'kb-ctx-menu kb-file-menu';
    el.innerHTML = `
      <div class="kb-ctx-menu-item" data-fm="pin">📌 置顶</div>
      <div class="kb-ctx-menu-item" data-fm="tag">🏷 编辑标签</div>
      <div class="kb-ctx-menu-item" data-fm="rename">✏️ 重命名</div>
      <div class="kb-ctx-menu-item kb-has-sub" data-fm="perm">🔐 成员权限 <span class="kb-import-caret">▸</span>
        <div class="kb-ctx-sub" data-sub="perm">
          <div class="kb-ctx-menu-item is-selected" data-perm="view_export">✓ 内容可查看和导出</div>
          <div class="kb-ctx-menu-item" data-perm="view_only">内容可查看但不可导出</div>
          <div class="kb-ctx-menu-item" data-perm="hidden">内容不可查看</div>
        </div>
      </div>
      <div class="kb-ctx-menu-item" data-fm="move">➡ 移动到</div>
      <div class="kb-ctx-menu-item" data-fm="copy">⧉ 复制到</div>
      <div class="kb-ctx-menu-item is-danger" data-fm="del">🗑 删除</div>`;
    el.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    el.style.top = Math.min(y, window.innerHeight - 300) + 'px';
    document.body.appendChild(el);
    _kbMenuEl = el;
    const close = () => { el.remove(); _kbMenuEl = null; };
    const permLabel = { view_export: '内容可查看和导出', view_only: '内容可查看但不可导出', hidden: '内容不可查看' };
    el.addEventListener('click', (e) => {
      const subItem = e.target.closest('.kb-ctx-sub .kb-ctx-menu-item');
      if (subItem) {
        e.stopPropagation();
        const perm = subItem.dataset.perm;
        _state.filePerms = _state.filePerms || {};
        _state.filePerms[path] = perm;
        subItem.closest('.kb-ctx-sub').querySelectorAll('.kb-ctx-menu-item').forEach((x) => x.classList.remove('is-selected'));
        subItem.classList.add('is-selected');
        close();
        if (typeof uiToast === 'function') uiToast(`已设置成员权限：${permLabel[perm] || perm}`, { variant: 'success', timeoutMs: 2000 });
        return;
      }
      const item = e.target.closest('.kb-ctx-menu-item');
      if (!item) return;
      const act = item.dataset.fm;
      close();
      if (act === 'pin') { if (typeof uiToast === 'function') uiToast('置顶：即将上线', { variant: 'info' }); }
      else if (act === 'tag') { if (typeof uiToast === 'function') uiToast('编辑标签：即将上线', { variant: 'info' }); }
      else if (act === 'rename') _kbRenameSpaceFile(path);
      else if (act === 'move') { if (typeof uiToast === 'function') uiToast('移动到：即将上线', { variant: 'info' }); }
      else if (act === 'copy') { if (typeof uiToast === 'function') uiToast('复制到：即将上线', { variant: 'info' }); }
      else if (act === 'del') _kbDeleteSpaceFile(path);
    });
    const hasSub = el.querySelector('.kb-has-sub');
    if (hasSub) {
      const sub = hasSub.querySelector('.kb-ctx-sub');
      hasSub.addEventListener('mouseenter', () => { sub.classList.add('show'); });
      hasSub.addEventListener('mouseleave', () => { sub.classList.remove('show'); });
    }
    // 外部关闭用 mousedown（click 时序在菜单 append 之后，会把刚弹出的菜单误关）
    setTimeout(() => document.addEventListener('mousedown', function once(e) {
      if (!el.contains(e.target)) { close(); document.removeEventListener('mousedown', once); }
    }), 0);
  }

  async function _kbRenameSpaceFile(path) {
    const cur = String(path || '').split('/').pop() || '';
    const next = typeof uiPrompt === 'function' ? await uiPrompt('重命名文件：', cur) : window.prompt('重命名文件：', cur);
    if (!next || !next.trim() || next.trim() === cur) return;
    try {
      const res = await window.cogseed.invoke('spaces.files.rename', { spaceId: _state.spaceId, oldName: path, name: String(next).trim() });
      if (res && res.ok === false) throw new Error(res.error || 'rename failed');
      // 乐观更新 + 记录 pending（刷新快照合并，索引 upsert 完成前文件不消失）
      const parent = String(path).includes('/') ? String(path).slice(0, String(path).lastIndexOf('/') + 1) : '';
      const newRel = parent + String(next).trim();
      _state.pendingRename[path] = newRel;
      _state.spaceFiles = _state.spaceFiles.map((f) => {
        if ((f.path || f.name) === path) return { ...f, name: newRel, path: newRel };
        return f;
      });
      _renderFiles();
      if (typeof uiToast === 'function') uiToast('已重命名', { variant: 'success', timeoutMs: 1500 });
      _loadSpaceFiles(_state.spaceId); // 后台校正（合并逻辑保证不消失）
    } catch (err) {
      if (typeof uiToast === 'function') uiToast('重命名失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  async function _kbDeleteSpaceFile(path) {
    const name = String(path || '').split('/').pop() || path || '';
    let ok = false;
    try {
      ok = typeof uiConfirmDanger === 'function'
        ? await uiConfirmDanger({ title: '删除文件', message: `确认删除「${name}」？`, dangerLabel: '删除', cancelLabel: '取消' })
        : window.confirm(`确认删除「${name}」？`);
    } catch (_) { return; }
    if (!ok) return;
    try {
      const res = await window.cogseed.invoke('spaces.files.delete', { spaceId: _state.spaceId, name: path });
      if (res && res.ok === false) throw new Error(res.error || 'delete failed');
      // 乐观移除 + 记录 pending（刷新快照合并，索引删除完成前不残留）
      _state.pendingDelete.add(path);
      _state.spaceFiles = _state.spaceFiles.filter((f) => (f.path || f.name) !== path);
      _renderFiles();
      if (typeof uiToast === 'function') uiToast('已删除', { variant: 'success', timeoutMs: 1500 });
      _loadSpaceFiles(_state.spaceId);
    } catch (err) {
      if (typeof uiToast === 'function') uiToast('删除失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // ── 知识库成员弹窗（对齐 ima：标题+图标 / 搜索 / 创建者列表）──
  function _kbMembersDialog() {
    _kbMenuHide();
    const overlay = document.createElement('div');
    overlay.className = 'kb-members-overlay';
    overlay.innerHTML = `
      <div class="kb-members-dlg">
        <button type="button" class="kb-members-close" title="关闭">✕</button>
        <div class="kb-members-title">👥 知识库成员</div>
        <div class="kb-members-search"><input type="text" placeholder="搜索知识库成员" autocomplete="off" /></div>
        <div class="kb-members-list">
          <div class="kb-members-item">
            <span class="kb-members-avatar">我</span>
            <span class="kb-members-name">我</span>
            <span class="kb-members-role">创建者</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.kb-members-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.kb-members-search input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      overlay.querySelectorAll('.kb-members-item').forEach((item) => {
        const name = item.querySelector('.kb-members-name').textContent.toLowerCase();
        item.style.display = q && !name.includes(q) ? 'none' : '';
      });
    });
  }

  async function _kbRenameSpace(spaceId) {
    const sp = _state.spaces.find((s) => s.space_id === spaceId);
    const cur = (sp && sp.name) || '';
    const next = typeof uiPrompt === 'function' ? await uiPrompt('重命名共享知识库：', cur) : window.prompt('重命名共享知识库：', cur);
    if (!next || !next.trim() || next.trim() === cur) return;
    try {
      const res = await window.cogseed.invoke('spaces.update', { spaceId, name: String(next).trim() });
      if (res && res.ok === false) throw new Error(res.error || 'rename failed');
      if (_state.spaceId === spaceId) _state.spaceName = String(next).trim();
      if (typeof uiToast === 'function') uiToast('已重命名', { variant: 'success', timeoutMs: 1500 });
      _loadAll();
    } catch (err) {
      _log.warn('rename space failed', err);
      if (typeof uiToast === 'function') uiToast('重命名失败：' + _kbSpaceErrText((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  async function _kbDeleteSpace(spaceId) {
    const sp = _state.spaces.find((s) => s.space_id === spaceId);
    const name = (sp && sp.name) || spaceId;
    let ok = false;
    try {
      ok = typeof uiConfirmDanger === 'function'
        ? await uiConfirmDanger({ title: '删除共享知识库', message: `确认删除共享知识库「${name}」及其全部内容？删除后不可恢复。`, dangerLabel: '删除', cancelLabel: '取消' })
        : window.confirm(`确认删除共享知识库「${name}」及其全部内容？删除后不可恢复。`);
    } catch (_) { return; }
    if (!ok) return;
    try {
      const res = await window.cogseed.invoke('spaces.delete', { spaceId });
      if (res && res.ok === false) throw new Error(res.error || 'delete failed');
      if (_state.spaceId === spaceId) {
        _state.spaceId = null;
        _state.spaceName = '';
        _state.spaceFiles = [];
      }
      if (typeof uiToast === 'function') uiToast('已删除共享知识库', { variant: 'success', timeoutMs: 2000 });
      _loadAll();
    } catch (err) {
      _log.warn('delete space failed', err);
      if (typeof uiToast === 'function') uiToast('删除失败：' + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  window.renderKbWorkbench = renderKbWorkbench;
})();
