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
    sort: 'name', // name | type
    rendered: false,
    streamHandle: null,
    loading: false,
    summaryLib: '',
    summary: null,
    lastMind: null, // 最近生成的脑图根节点（预览/编辑用）
    mmCollapsed: new Set(), // 已折叠的一级分支节点 idx
    mmMode: 'mind', // 布局模式 mind=双向放射 | org=组织结构图(单向)
    mmFocus: null, // 聚焦的一级分支 idx（其他分支淡化）
    mmBg: 'dots', // 背景 dots=点阵 | plain=纯白 | none=无
    mmSearchHits: new Set(), // 脑内搜索命中节点 idx
    mmViewMode: 'graph', // graph=图形 | outline=大纲
    expanded: new Set(), // 已展开的文件夹相对路径（内联展开/折叠）
    spaces: [],
    spaceId: null,
    spaceName: '',
    spaceFiles: [],
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
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  };
  function _svg(name) {
    return `<svg class="kb-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_SVGS[name] || ''}</svg>`;
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
    const libsHtml = _state.libs.map((l) =>
      `<div class="kb-tree-item${l.name === _state.currentLib && !_state.spaceId ? ' active' : ''}" data-kb-lib="${_esc(l.name)}">
        ${_icon('book-open', 'kb-tree-ico')}<span class="kb-tree-name">${_esc(l.name)}</span></div>`
    ).join('');
    const empty = libsHtml ? '' : '<div class="kb-tree-empty">暂无知识库，点击上方 ＋ 创建</div>';
    const spacesHtml = _state.spaces.map((sp) =>
      `<div class="kb-tree-item${sp.space_id === _state.spaceId ? ' active' : ''}" data-kb-space="${_esc(sp.space_id)}">
        ${_icon('folder-open', 'kb-tree-ico kb-tree-ico-space')}<span class="kb-tree-name">${_esc(sp.name || sp.space_id)}</span><span class="kb-badge-share">共享</span></div>`
    ).join('');
    tree.innerHTML = `
      <div class="kb-tree-group">
        <div class="kb-tree-group-label"><span>▶</span><span class="kb-tree-group-name">个人知识库</span><button type="button" class="kb-tree-plus" id="kb-new-lib" title="创建个人知识库">＋</button></div>
        <div class="kb-tree-items">${libsHtml || empty}</div>
      </div>
      <div class="kb-tree-group">
        <div class="kb-tree-group-label"><span>▶</span><span class="kb-tree-group-name">共享知识库</span></div>
        <div class="kb-tree-items">${spacesHtml || '<div class="kb-tree-placeholder">暂无共享空间</div>'}</div>
      </div>
      <div class="kb-tree-group">
        <div class="kb-tree-group-label"><span>▶</span><span class="kb-tree-group-name">订阅知识库</span></div>
        <div class="kb-tree-items"><div class="kb-tree-placeholder">订阅 · S4 上线</div></div>
      </div>`;
    tree.querySelectorAll('[data-kb-lib]').forEach((el) => {
      el.addEventListener('click', () => _selectLib(el.dataset.kbLib));
    });
    tree.querySelectorAll('[data-kb-space]').forEach((el) => {
      el.addEventListener('click', () => _selectSpace(el.dataset.kbSpace));
    });
    tree.querySelector('#kb-new-lib')?.addEventListener('click', _createLib);
  }

  // 共享知识库（空间库）：spaces.files.status 只读浏览 + 问答/解析走 space 模式。
  function _selectSpace(spaceId) {
    if (_state.spaceId === spaceId) return;
    _state.spaceId = spaceId;
    const sp = _state.spaces.find((x) => x.space_id === spaceId);
    _state.spaceName = (sp && sp.name) || spaceId;
    _state.spaceFiles = [];
    _state.dirStack = [];
    _state.summaryLib = '';
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
      _state.spaceFiles = (res && Array.isArray(res.files)) ? res.files : [];
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
    _state.summaryLib = '';
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

  // 空态：居中插图 + 大号主按钮（保留库头部骨架，不一片白板）
  function _emptyStateHtml(kind) {
    const createBtn = kind === 'lib'
      ? '<button type="button" class="kb-empty-btn" id="kb-empty-create">＋ 创建知识库</button>'
      : '<button type="button" class="kb-empty-btn" id="kb-empty-create">＋ 创建知识库</button>';
    return `<div class="kb-empty">
      <div class="kb-empty-illus">${_icon('book-open', 'kb-empty-ico')}</div>
      <div class="kb-empty-title">${kind === 'lib' ? '还没有知识库' : '这个知识库还没有内容'}</div>
      <div class="kb-empty-sub">${kind === 'lib' ? '创建一个知识库，或导入资料开始使用' : '导入文件，让 AI 帮你解析与问答'}</div>
      ${createBtn}
    </div>`;
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
    list.innerHTML = parts.join('') || _emptyStateHtml('file');
    if (!parts.length) document.getElementById('kb-empty-create')?.addEventListener('click', _createLib);

    list.querySelectorAll('[data-kb-dir]').forEach((el) => {
      el.addEventListener('click', () => _toggleDir(el.dataset.kbDir));
    });
    list.querySelectorAll('[data-kb-file]').forEach((el) => {
      el.addEventListener('click', () => _openFile(el.dataset.kbFile));
    });
    _renderCount(lib ? _countFiles(lib) : 0);
    _renderRight();
  }

  function _renderNodeRows(parts, children, level, parentPath, q) {
    const pad = 16 + level * 20;
    const dirs = (children || [])
      .filter((n) => n.type === 'dir')
      .filter((n) => !q || n.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = (children || [])
      .filter((n) => n.type === 'file')
      .filter((n) => !q || n.name.toLowerCase().includes(q));
    if (_state.sort === 'type') {
      files.sort((a, b) => _extLabel(a.name).localeCompare(_extLabel(b.name)) || a.name.localeCompare(b.name));
    } else {
      files.sort((a, b) => a.name.localeCompare(b.name));
    }
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
    const files = _state.spaceFiles
      .filter((f) => !q || (f.name || f.path || '').toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (a.name || a.path).localeCompare(b.name || b.path));
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
        ${chip}
        <span class="kb-file-actions"><button type="button" class="kb-mini-btn" title="生成思维导图（S3）">${_icon('sparkles', 'kb-mini-ico')}</button><button type="button" class="kb-mini-btn" title="更多">${_icon('more-horizontal', 'kb-mini-ico')}</button></span>
      </div>`;
    }
    if (!html) html = _emptyStateHtml('file');
    list.innerHTML = html;
    document.getElementById('kb-empty-create')?.addEventListener('click', _createLib);
    list.querySelectorAll('[data-kb-space-file]').forEach((el) => {
      el.addEventListener('click', () => {
        if (typeof uiToast === 'function') uiToast('空间库原文查看：后续版本支持', { variant: 'info' });
      });
    });
    const crumb = document.getElementById('kb-wb-crumb');
    if (crumb) crumb.hidden = true;
    const count = document.getElementById('kb-wb-count');
    if (count) count.textContent = `内容(${files.length})`;
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
    if (el) el.textContent = `内容(${n})`;
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
      const disp = _state.spaceId ? _state.spaceName : (_state.currentLib || '当前知识库');
      h.textContent = `基于「${disp}」提问，回答只引用库内资料并标注锚点。`;
      box.appendChild(h);
    } else if (hasMsg && hint) {
      hint.remove();
    }
  }

  function _clearQa() {
    const box = document.getElementById('kb-qa-messages');
    if (box) box.innerHTML = '';
    _maybeShowQaHint();
  }

  // ── 右区（S2：基于知识库问答；AI 解析卡 S3 填充）──
  function _renderRight() {
    const body = document.getElementById('kb-wb-right');
    const isSpace = !!_state.spaceId;
    const dispName = isSpace ? _state.spaceName : (_state.currentLib || '知识库');
    const nameEl = document.getElementById('kb-wb-lib-name');
    if (nameEl) nameEl.textContent = dispName;
    const cover = document.getElementById('kb-wb-lib-cover');
    if (cover) cover.textContent = (dispName || '书').trim().charAt(0) || '书';
    const tagEl = document.getElementById('kb-wb-lib-tag');
    if (tagEl) tagEl.textContent = isSpace ? '共享知识库' : '个人知识库';
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
    _loadSummary();
  }

  // ── AI 解析（S3：kb.summary → 逐文档要点 + 一句话总结 + 脑图骨架）──
  function _loadSummary() {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    const lib = _state.currentLib || '';
    const key = _state.spaceId ? `space:${_state.spaceId}` : lib;
    if (_state.summaryLib === key) return; // 同一库已解析过（缓存命中）
    _state.summaryLib = key;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      card.innerHTML = '<div class="kb-wb-right-card-title">✨ AI 解析本知识库</div><div class="kb-wb-right-placeholder">解析服务不可用</div>';
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
      .then((res) => { if (res) _renderAnalysis(res); })
      .catch(() => {
        const h = card.querySelector('.kb-wb-right-placeholder');
        if (h) h.textContent = '解析失败，请稍后重试（点击 ⟳ 刷新）。';
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
      <span>✨ AI 解析本知识库${srcTag}<span class="kb-wb-card-src">（${docs.length} 个文档）</span></span>
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
        canvas.innerHTML = _mmTreeSvg(res.root, _state.mmCollapsed, _mmRenderOpts());
        _bindMindCanvas(canvas);
      })
      .catch(() => {
        _mmGenerating = false;
        canvas.innerHTML = '<div class="kb-mm-fail">脑图生成失败，请稍后重试</div>';
      });
    box.scrollTop = box.scrollHeight;
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
    _renderOverlay();
    overlay.hidden = false;
    const titleEl = document.getElementById('kb-mm-overlay-title');
    if (titleEl) titleEl.textContent = `🧠 脑图预览 - ${_state.spaceId ? _state.spaceName : (_state.currentLib || '知识库')}`;
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
        const titleEl = document.getElementById('kb-mm-overlay-title');
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
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        let next = null;
        try { next = typeof uiPrompt === 'function' ? uiPrompt('重命名节点：', _mmLabelAt(root, idx)) : window.prompt('重命名节点：', _mmLabelAt(root, idx)); }
        catch (_) { return; }
        if (!next || !next.trim()) return;
        _mmUndoStack.push({ idx, old: _mmLabelAt(root, idx) });
        if (_mmUndoStack.length > 20) _mmUndoStack.shift();
        _mmSetLabelAt(root, idx, next.trim());
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
    const titleEl = document.getElementById('kb-mm-overlay-title');
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
    _state.mmCollapsed.clear();
    _rerenderMindmaps();
  }
  function _mmCollapseAll() {
    const idxs = _mmBranchIdxList();
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

  // 长文本自动换行：控制节点最大宽度，多行时增高节点
  function _mmDims(label, size) {
    const maxW = 180;
    const charW = size * 1.02;
    const perLine = Math.max(5, Math.floor((maxW - 22) / charW));
    const text = String(label || '');
    const lines = [];
    for (let i = 0; i < text.length; i += perLine) lines.push(text.slice(i, i + perLine));
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
    const XGAP = 252;
    const TOP = 52, BOT = 470;

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
    const visible = list.filter((n) => !hidden.has(n.idx));
    const minX = Math.min(...visible.map((n) => n.x - n.w / 2)) - 60;
    const maxX = Math.max(...visible.map((n) => n.x + n.w / 2)) + 160;
    const maxY = Math.max(BOT, ...visible.map((n) => n.y + n.h / 2)) + 30;
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
        if (n.depth === 0) return { fill: KB_MM_ROOT, stroke: '#065F46', text: '#fff', size: 15, sw: 2 };
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
      const foldBadge = folded
        ? `<circle cx="${badgeX}" cy="${n.y}" r="8" fill="#fff" stroke="${p.stroke}"/><text x="${badgeX}" y="${n.y + 4}" text-anchor="middle" font-size="10" fill="${p.stroke}">+${n.childCount}</text>`
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
  function _ask(question) {
    const q = String(question || '').trim();
    if (!q) return;
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    _maybeShowQaHint();

    const user = document.createElement('div');
    user.className = 'kb-qa-msg is-user';
    user.innerHTML = `<div class="kb-qa-msg-body">${_esc(q)}</div>`;
    box.appendChild(user);

    const ai = document.createElement('div');
    ai.className = 'kb-qa-msg is-ai is-typing';
    ai.innerHTML = '<div class="kb-qa-msg-body kb-qa-stream"></div>';
    box.appendChild(ai);
    const streamBody = ai.querySelector('.kb-qa-stream');
    box.scrollTop = box.scrollHeight;

    if (!window.cogseed || typeof window.cogseed.stream !== 'function') {
      ai.classList.remove('is-typing');
      streamBody.textContent = '问答服务不可用';
      return;
    }
    let text = '';
    try {
      const handle = window.cogseed.stream('kbqa.askStream', { question: q, space_id: _state.spaceId || null, k: 8 }, (ev) => {
        if (!ev) return;
        if (ev.type === 'delta' && ev.text) {
          text += ev.text;
          streamBody.textContent = text;
          box.scrollTop = box.scrollHeight;
        } else if (ev.type === 'final') {
          ai.classList.remove('is-typing');
          text = ev.text || text;
          streamBody.textContent = text;
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
        <aside class="kb-wb-side">
          <div class="kb-wb-side-head"><h2>知识库列表</h2><button type="button" class="kb-wb-icon-btn" id="kb-wb-global-search" title="全局搜索（搜-读-写入口）">${_svg('search')}</button></div>
          <div class="kb-wb-tree" id="kb-wb-tree"></div>
        </aside>
        <section class="kb-wb-mid">
          <div class="kb-wb-mid-head">
            <div class="kb-wb-lib-head">
              <div class="kb-wb-lib-cover" id="kb-wb-lib-cover">书</div>
              <div class="kb-wb-lib-meta">
                <div class="kb-wb-lib-name" id="kb-wb-lib-name">知识库</div>
                <div class="kb-wb-lib-sub"><span class="kb-wb-tag" id="kb-wb-lib-tag">个人知识库</span><span id="kb-wb-count">内容(0)</span></div>
              </div>
            </div>
            <div class="kb-wb-mid-sub">
              <input id="kb-wb-search-input" placeholder="搜索库内文件…" autocomplete="off">
              <div class="kb-wb-tools">
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-sort" title="排序：名称">${_svg('sort')}</button>
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-refresh" title="刷新（重新索引）">${_svg('refresh')}</button>
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-import" title="导入文件">${_svg('upload')}</button>
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-import-dir" title="导入文件夹">${_icon('folder-open', 'kb-ico')}</button>
              </div>
            </div>
            <div class="kb-wb-crumb" id="kb-wb-crumb" hidden></div>
          </div>
          <div class="kb-wb-files" id="kb-wb-files"></div>
        </section>
        <section class="kb-wb-right">
          <div class="kb-wb-right-head"><span class="kb-wb-chip">📚 <span id="kb-wb-right-lib">—</span></span><span class="kb-wb-local"><span class="kb-wb-dot"></span>本地推理 · 资料不上云</span></div>
          <div class="kb-wb-right-body" id="kb-wb-right">
            <div class="kb-wb-right-card" id="kb-wb-analysis-card">
              <div class="kb-wb-right-card-title">✨ AI 解析本知识库</div>
              <div class="kb-wb-right-card-sub" id="kb-wb-analysis-sub">当前库：—</div>
              <div class="kb-wb-right-placeholder">正在解析…</div>
            </div>
            <div class="kb-qa-messages" id="kb-qa-messages"></div>
          </div>
          <div class="kb-wb-right-input">
            <div class="kb-qa-degraded-note" id="kb-qa-degraded-note" hidden>当前解析降级，问答能力受限</div>
            <div class="kb-qa-box">
              <select class="kb-qa-model" id="kb-qa-model" title="问答模型（真实配置）"></select>
              <span class="kb-qa-divider"></span>
              <textarea class="kb-qa-input" id="kb-qa-input" rows="1" placeholder="基于知识库提问…"></textarea>
              <button type="button" class="kb-qa-send" id="kb-qa-send" title="发送" disabled>${_svg('send')}</button>
            </div>
            <div class="kb-qa-note">内容由 AI 生成仅供参考 · 引用均已核验锚点</div>
          </div>
        </section>
      </div>
      <div class="kb-mm-overlay" id="kb-mm-overlay" hidden>
        <div class="kb-mm-overlay-toolbar">
          <span class="kb-mm-overlay-title" id="kb-mm-overlay-title">🧠 脑图预览</span>
          <div class="kb-mm-overlay-actions">
            <button type="button" id="kb-mm-undo" title="撤销重命名">↩ 撤销</button>
            <button type="button" id="kb-mm-refresh" title="重新生成脑图（强制刷新）">⟳ 刷新</button>
            <button type="button" id="kb-mm-save" title="保存到知识库">💾 保存</button>
            <div class="kb-mm-open">
              <button type="button" id="kb-mm-open-btn" title="打开已保存的脑图">📂 存档 ▾</button>
              <div class="kb-mm-open-menu" id="kb-mm-open-menu" hidden></div>
            </div>
          </div>
          <div class="kb-mm-layout">
            <button type="button" id="kb-mm-layout-btn" title="切换布局">📐 布局</button>
            <div class="kb-mm-layout-menu" id="kb-mm-layout-menu" hidden>
              <div class="kb-mm-layout-item" data-mode="mind">🧠 思维导图（双向放射）</div>
              <div class="kb-mm-layout-item" data-mode="org">🏢 组织结构图（单向）</div>
            </div>
          </div>
          <button type="button" id="kb-mm-expand-all" title="全部展开">⤢ 展开</button>
          <button type="button" id="kb-mm-collapse-all" title="全部收拢">⤡ 收拢</button>
          <button type="button" id="kb-mm-focus-btn" title="聚焦分支：点击一级分支只看该分支">◎ 聚焦</button>
          <button type="button" id="kb-mm-outline-btn" title="大纲视图切换">☰ 大纲</button>
          <button type="button" id="kb-mm-bg-btn" title="背景切换（点阵/纯白/无）">▦ 背景</button>
          <input type="search" class="kb-mm-search" id="kb-mm-search" placeholder="搜索节点…" />
          <div class="kb-mm-overlay-zoom">
            <button type="button" id="kb-mm-zoom-out" title="缩小">−</button>
            <span id="kb-mm-zoom-label">100%</span>
            <button type="button" id="kb-mm-zoom-in" title="放大">＋</button>
            <button type="button" id="kb-mm-reset" title="适应画布">适应</button>
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
          <button type="button" class="kb-mm-overlay-close" id="kb-mm-overlay-close" title="关闭">✕</button>
        </div>
        <div class="kb-mm-overlay-stage" id="kb-mm-overlay-stage">
          <div class="kb-mm-overlay-wrap" id="kb-mm-overlay-wrap"></div>
          <div class="kb-mm-overlay-stage-hint">滚轮缩放 · 拖拽平移 · 一级分支点击折叠/展开 · 双击节点重命名</div>
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
    document.getElementById('kb-wb-global-search')?.addEventListener('click', () => {
      if (typeof uiToast === 'function') uiToast('全局搜索（Cmd/Ctrl+K）', { variant: 'info' });
    });
    document.getElementById('kb-wb-search-input')?.addEventListener('input', (e) => {
      _state.filter = e.target.value;
      _renderFiles();
    });
    document.getElementById('kb-wb-sort')?.addEventListener('click', () => {
      _state.sort = _state.sort === 'name' ? 'type' : 'name';
      _renderFiles();
      if (typeof uiToast === 'function') uiToast(`排序：${_state.sort === 'name' ? '名称' : '类型'}`, { variant: 'info' });
    });
    document.getElementById('kb-wb-refresh')?.addEventListener('click', () => _loadAll());
    document.getElementById('kb-wb-import')?.addEventListener('click', _importFiles);
    document.getElementById('kb-wb-import-dir')?.addEventListener('click', _importDir);
    document.getElementById('kb-qa-send')?.addEventListener('click', () => _submitQa());
    document.getElementById('kb-qa-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _submitQa();
      }
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
    });
    document.getElementById('kb-mm-overlay-close')?.addEventListener('click', () => {
      document.getElementById('kb-mm-overlay').hidden = true;
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

  window.renderKbWorkbench = renderKbWorkbench;
})();
