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
      `<div class="kb-tree-item${l.name === _state.currentLib ? ' active' : ''}" data-kb-lib="${_esc(l.name)}">
        <span class="kb-tree-ico">📚</span><span class="kb-tree-name">${_esc(l.name)}</span></div>`
    ).join('');
    const empty = libsHtml ? '' : '<div class="kb-tree-empty">暂无知识库，点击上方 ＋ 创建</div>';
    const spacesHtml = _state.spaces.map((sp) =>
      `<div class="kb-tree-item${sp.space_id === _state.spaceId ? ' active' : ''}" data-kb-space="${_esc(sp.space_id)}">
        <span class="kb-tree-ico">📁</span><span class="kb-tree-name">${_esc(sp.name || sp.space_id)}</span><span class="kb-badge-share">共享</span></div>`
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

  // ── 文件列表 ──
  function _renderFiles() {
    const list = document.getElementById('kb-wb-files');
    if (!list) return;
    if (_state.spaceId) {
      _renderSpaceFiles(list);
      return;
    }
    const dirNode = _currentDirNode();
    const children = dirNode ? (dirNode.children || []) : [];
    const q = _state.filter.trim().toLowerCase();
    const dirs = children.filter((n) => n.type === 'dir').filter((n) => !q || n.name.toLowerCase().includes(q));
    const files = children
      .filter((n) => n.type === 'file')
      .filter((n) => !q || n.name.toLowerCase().includes(q));
    if (_state.sort === 'type') {
      files.sort((a, b) => _extLabel(a.name).localeCompare(_extLabel(b.name)) || a.name.localeCompare(b.name));
    } else {
      files.sort((a, b) => a.name.localeCompare(b.name));
    }
    let html = '';
    for (const d of dirs) {
      html += `<div class="kb-file-row is-dir" data-kb-dir="${_esc(d.name)}">
        <span class="kb-file-icon is-dir">📁</span>
        <span class="kb-file-name">${_esc(d.name)}</span>
        <span class="kb-file-meta">${_countFiles(d)} 项</span>
        <span class="kb-file-actions"><button type="button" class="kb-mini-btn" data-kb-dir-open="${_esc(d.name)}" title="打开">›</button></span>
      </div>`;
    }
    for (const f of files) {
      const rel = _relPath(f.name);
      html += `<div class="kb-file-row" data-kb-file="${_esc(rel)}">
        <span class="kb-file-icon is-${_extClass(f.name)}">${_extLabel(f.name)}</span>
        <span class="kb-file-name">${_esc(f.name)}</span>
        <span class="kb-file-meta">${_esc(_extLabel(f.name))}</span>
        ${_statusChip(rel)}
        <span class="kb-file-actions"><button type="button" class="kb-mini-btn" title="生成思维导图（S3）">🧠</button><button type="button" class="kb-mini-btn" title="更多">⋯</button></span>
      </div>`;
    }
    if (!dirs.length && !files.length) {
      html = '<div class="kb-tree-empty">没有更多内容了</div>';
    }
    list.innerHTML = html;

    list.querySelectorAll('[data-kb-dir-open]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _pushDir(btn.dataset.kbDirOpen);
      });
    });
    list.querySelectorAll('[data-kb-dir]').forEach((el) => {
      el.addEventListener('click', () => _pushDir(el.dataset.kbDir));
    });
    list.querySelectorAll('[data-kb-file]').forEach((el) => {
      el.addEventListener('click', () => _openFile(el.dataset.kbFile));
    });
    _renderCrumb();
    _renderCount(files.length + dirs.length);
    _renderRight();
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
        <span class="kb-file-actions"><button type="button" class="kb-mini-btn" title="生成思维导图（S3）">🧠</button><button type="button" class="kb-mini-btn" title="更多">⋯</button></span>
      </div>`;
    }
    list.innerHTML = html || '<div class="kb-tree-empty">没有更多内容了</div>';
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

  // ── 右区（S2：基于知识库问答；AI 解析卡 S3 填充）──
  function _renderRight() {
    const body = document.getElementById('kb-wb-right');
    const isSpace = !!_state.spaceId;
    const dispName = isSpace ? _state.spaceName : (_state.currentLib || '知识库');
    const nameEl = document.getElementById('kb-wb-lib-name');
    if (nameEl) nameEl.textContent = dispName;
    const tagEl = document.getElementById('kb-wb-lib-tag');
    if (tagEl) tagEl.textContent = isSpace ? '共享知识库' : '个人知识库';
    const rightLib = document.getElementById('kb-wb-right-lib');
    if (rightLib) rightLib.textContent = dispName;
    if (!body) return;
    if (!body.querySelector('#kb-qa-messages')) {
      body.innerHTML = `
        <div class="kb-wb-right-card" id="kb-wb-analysis-card">
          <div class="kb-wb-right-card-title">✨ AI 解析本知识库</div>
          <div class="kb-wb-right-card-sub" id="kb-wb-analysis-sub">当前库：${_esc(_state.currentLib || '—')}</div>
          <div class="kb-wb-right-placeholder">正在解析…</div>
        </div>
        <div class="kb-qa-messages" id="kb-qa-messages"></div>`;
    }
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
    if (holder) holder.textContent = '正在解析…';
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

  function _renderAnalysis(summary) {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    const docs = Array.isArray(summary.docs) ? summary.docs : [];
    const oneLiner = String(summary.oneLiner || '');
    const mm = summary.mindmap || {};
    const hasMm = !!(mm.root && Array.isArray(mm.kids) && mm.kids.length);
    const srcTag = summary.source === 'cached' ? ' <span class="kb-wb-card-src">(缓存)</span>'
      : summary.source === 'degraded' ? ' <span class="kb-wb-card-src">(降级)</span>' : '';

    let html = `<div class="kb-wb-right-card-title">✨ AI 解析本知识库${srcTag}</div>`;
    const degraded = summary.source === 'degraded' && !docs.some((d) => d.text);
    if (degraded) {
      html += `<div class="kb-wb-right-placeholder">${_esc(oneLiner || 'AI 解析失败，已降级为文件清单。')}</div>`;
      if (docs.length) {
        html += `<div class="kb-wb-doc-list">${docs.map((d) =>
          `<div class="kb-wb-doc-row"><span class="kb-wb-doc-name">${_esc(d.name)}</span></div>`).join('')}</div>`;
      }
      card.innerHTML = html;
      return;
    }
    for (const d of docs) {
      html += `<div class="kb-wb-doc">
        <div class="kb-wb-doc-head">
          <span class="kb-wb-doc-name">${_esc(d.name)}</span>
          <button type="button" class="kb-qa-chip" data-kb-anchor="${_esc(d.file)}">${_esc(d.file)}#chunk 1 ↗</button>
        </div>`;
      if (d.text) html += `<div class="kb-wb-doc-text">${_esc(d.text)}</div>`;
      html += `</div>`;
    }
    if (oneLiner) {
      html += `<div class="kb-wb-one-liner"><span class="kb-wb-one-liner-tag">💡 一句话总结</span>${_esc(oneLiner)}</div>`;
    }
    html += `<div class="kb-wb-a-actions">`;
    if (hasMm) html += `<button type="button" class="kb-wb-a-btn" id="kb-wb-gen-mm">🧠 生成脑图</button>`;
    html += `<button type="button" class="kb-wb-a-btn" id="kb-wb-gen-quiz">📝 生成测验</button></div>`;
    if (hasMm) {
      html += `<div class="kb-wb-mm"><div class="kb-wb-mm-head">🧠 脑图预览</div>
        <div class="kb-wb-mm-canvas" id="kb-wb-mm-canvas"><button type="button" class="kb-wb-mm-load" id="kb-wb-mm-load">⬇ 生成</button></div></div>`;
    }
    card.innerHTML = html;
    card.querySelectorAll('[data-kb-anchor]').forEach((el) => {
      el.addEventListener('click', () => _openAnchor({ source: 'library', scope: 'global', path: el.dataset.kbAnchor, chunkIdx: 1 }));
    });
    document.getElementById('kb-wb-gen-mm')?.addEventListener('click', () => _renderMindmap(mm));
    document.getElementById('kb-wb-mm-load')?.addEventListener('click', () => _renderMindmap(mm));
    document.getElementById('kb-wb-gen-quiz')?.addEventListener('click', () => _renderQuiz(summary));
    _state.summary = summary;
  }

  function _renderMindmap(mm) {
    const canvas = document.getElementById('kb-wb-mm-canvas');
    if (!canvas) return;
    canvas.classList.add('is-loading');
    canvas.innerHTML = '';
    setTimeout(() => {
      canvas.classList.remove('is-loading');
      canvas.innerHTML = _mmSvg(mm);
    }, 700);
  }

  function _mmSvg(m) {
    const kids = Array.isArray(m.kids) ? m.kids : [];
    let y = 105 - (kids.length - 1) * 30;
    let nodes = '';
    for (const k of kids) {
      const bw = Math.min(220, String(k).length * 12 + 24);
      nodes += `<g><path d="M120 105 L150 ${y + 22}" stroke="#cbd5e1" fill="none"/><rect x="150" y="${y}" width="${bw}" height="44" rx="10" fill="#eaf2ff" stroke="#bfdbfe"/><text x="${150 + bw / 2}" y="${y + 27}" text-anchor="middle" font-size="12" fill="#1e40af">${_esc(k)}</text></g>`;
      y += 60;
    }
    return `<svg class="kb-wb-mm-svg" viewBox="0 0 420 210" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="88" width="104" height="34" rx="17" fill="#3b82f6"/><text x="70" y="110" text-anchor="middle" font-size="13" fill="#fff">${_esc(m.root || '')}</text>${nodes}</svg>`;
  }

  // ── 测验简版（S3）：基于解析结果出 3 道判断题/选择题，卡内自检 ──
  function _renderQuiz(summary) {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    const docs = (summary.docs || []).filter((d) => d.text);
    const base = summary.oneLiner || (docs[0] ? docs[0].text : '');
    const qs = [
      { q: '这个知识库的核心主题是？', options: [base.slice(0, 24) || '主题 X', '与资料无关的干扰项', '另一干扰项'], answer: 0 },
      { q: '引用锚点的格式是？', options: ['path#chunk N', 'page N', '无引用'], answer: 0 },
      { q: '资料中没有的内容，正确做法是？', options: ['明确说未找到', '自行编造', '联网搜索代替'], answer: 0 },
    ];
    let html = `<div class="kb-wb-quiz"><div class="kb-wb-quiz-title">📝 测验（简版）</div>`;
    qs.forEach((item, i) => {
      html += `<div class="kb-wb-quiz-q" data-q="${i}"><div class="kb-wb-quiz-qtext">${i + 1}. ${_esc(item.q)}</div>`;
      item.options.forEach((opt, j) => {
        html += `<button type="button" class="kb-wb-quiz-opt" data-q="${i}" data-opt="${j}">${_esc(opt)}</button>`;
      });
      html += `</div>`;
    });
    html += `<div class="kb-wb-quiz-foot"><button type="button" class="kb-wb-a-btn" id="kb-wb-quiz-close">关闭</button></div></div>`;
    card.insertAdjacentHTML('beforeend', html);
    card.querySelectorAll('[data-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = Number(btn.dataset.q);
        const opt = Number(btn.dataset.opt);
        const correct = qs[q].answer === opt;
        const qEl = card.querySelector(`[data-q="${q}"].kb-wb-quiz-q`);
        qEl.querySelectorAll('.kb-wb-quiz-opt').forEach((b, j) => {
          b.classList.add(j === qs[q].answer ? 'is-correct' : 'is-wrong');
          b.disabled = true;
        });
        if (!correct && typeof uiToast === 'function') uiToast('再想想——再选一次？', { variant: 'warning' });
      });
    });
    card.querySelector('#kb-wb-quiz-close')?.addEventListener('click', () => {
      card.querySelector('.kb-wb-quiz')?.remove();
    });
  }

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

  // ── 模型下拉：真实配置（auth.listEntries）──
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
        sel.innerHTML = entries.map((e, i) =>
          `<option value="${i}">${_esc(`${e.provider || ''} · ${e.modelName || e.model || ''}`)}</option>`
        ).join('');
      })
      .catch(() => {
        sel.innerHTML = '<option>默认模型</option>';
      });
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
            const refs = document.createElement('div');
            refs.className = 'kb-qa-refs';
            refs.innerHTML = '<span class="kb-qa-refs-label">引用</span>';
            for (const r of evidence) {
              const chip = document.createElement('button');
              chip.type = 'button';
              chip.className = 'kb-qa-chip';
              chip.textContent = `${r.path}#chunk ${r.chunkIdx} ↗`;
              chip.title = '跳转到原文';
              chip.addEventListener('click', () => _openAnchor(r));
              refs.appendChild(chip);
            }
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
          <div class="kb-wb-side-head"><h2>知识库</h2><button type="button" class="kb-wb-icon-btn" id="kb-wb-global-search" title="全局搜索（搜-读-写入口）">⌕</button></div>
          <div class="kb-wb-tree" id="kb-wb-tree"></div>
          <div class="kb-wb-foot"><span class="kb-wb-dot"></span>本地优先 · 索引与向量仅在本机</div>
        </aside>
        <section class="kb-wb-mid">
          <div class="kb-wb-mid-head">
            <div class="kb-wb-title"><span id="kb-wb-lib-name">知识库</span><span class="kb-wb-tag" id="kb-wb-lib-tag">个人知识库</span></div>
            <div class="kb-wb-mid-sub">
              <span id="kb-wb-count">内容(0)</span>
              <input id="kb-wb-search-input" placeholder="搜索库内文件…" autocomplete="off">
              <div class="kb-wb-tools">
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-sort" title="排序：名称">⇅</button>
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-refresh" title="刷新（重新索引）">⟳</button>
                <button type="button" class="kb-wb-icon-btn" id="kb-wb-import" title="批量导入">⤴</button>
              </div>
            </div>
            <div class="kb-wb-crumb" id="kb-wb-crumb" hidden></div>
          </div>
          <div class="kb-wb-files" id="kb-wb-files"></div>
        </section>
        <section class="kb-wb-right">
          <div class="kb-wb-right-head"><span class="kb-wb-chip">📚 <span id="kb-wb-right-lib">—</span></span><span class="kb-wb-local"><span class="kb-wb-dot"></span>本地推理 · 资料不上云</span></div>
          <div class="kb-wb-right-body" id="kb-wb-right"></div>
          <div class="kb-wb-right-input">
            <div class="kb-qa-box">
              <select class="kb-qa-model" id="kb-qa-model" title="问答模型（真实配置）"></select>
              <textarea class="kb-qa-input" id="kb-qa-input" rows="1" placeholder="基于知识库提问…"></textarea>
              <button type="button" class="kb-qa-send" id="kb-qa-send" title="发送">➤</button>
            </div>
            <div class="kb-qa-note">内容由 AI 生成仅供参考 · 引用均已核验锚点</div>
          </div>
        </section>
      </div>`;
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
    document.getElementById('kb-qa-send')?.addEventListener('click', () => _submitQa());
    document.getElementById('kb-qa-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _submitQa();
      }
    });
    _loadModelOptions();
    _loadAll();
  }

  function _submitQa() {
    const input = document.getElementById('kb-qa-input');
    if (!input) return;
    const q = input.value;
    if (!q || !q.trim()) return;
    input.value = '';
    _ask(q);
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
