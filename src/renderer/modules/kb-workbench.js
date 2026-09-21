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
    externalSources: [],
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
    // 当前脑图的**作用域**：{ doc, scope }。刷新/保存必须沿用同一作用域，
    // 否则"本文档脑图"会被刷新成整库脑图、或按库 key 存进档（真机出过这个问题）。
    mmScope: null,
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
    rightPanelOpen: true, // 受限宽度下的 AI 解析 / 问答抽屉
    treeFilter: '', // 库树搜索关键词（过滤个人库+共享库）
    qaAttachments: [], // 本次提问挂载的附件 [{name, path, size}]（最多 5 个）
    qaHistory: [], // 当前会话消息 [{role, content}]（多轮上下文）；脑图条目 {role:'assistant', kind:'mindmap', key, label, ts}
    qaSessions: [], // 会话列表 [{id, title, msgs, ts}]（持久化 localStorage）
    qaSessionId: null, // 当前会话 id
  };

  // 文件类型徽标：只有 img 需要翻译（其余是格式缩写，各语言一致）
  const _TYPE_LABEL = { pdf: 'PDF', excel: 'EXCEL', ppt: 'PPT', img: _tr('kb.workbench.type_img', '图片'), word: 'WORD', txt: 'TXT' };

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _tr(key, fallback, vars) {
    const translated = typeof window.t === 'function' ? window.t(key, vars || {}) : '';
    return translated && translated !== key ? translated : fallback;
  }

  /**
   * 定点重标签：把 `data-wb-*` 钩子上的文案按当前语言重刷一遍。
   *
   * 为什么必须"定点"而不是重渲染：`renderKbWorkbench()` 有 `_state.rendered` 守卫
   * ——外壳只注入一次；而且右列里住着问答输入框（用户可能已经打了一半问题）。
   * 重建 = 丢掉这些即时状态。
   *
   * - `data-wb-text`        → 元素整段文字（textContent）
   * - `data-wb-title`       → title 属性
   * - `data-wb-placeholder` → placeholder 属性（uiInput / uiTextarea）
   * - `data-wb-label`       → 共享按钮的可见文字（uiButton 的 label span / 图标按钮的 aria-label）
   * - `data-wb-aria`        → aria-label 属性
   *
   * 注意：**动态文案不挂钩子**。库名、标签、描述、头像由 `_renderRight()` 按当前库与
   * 语言重写，挂静态钩子会让重标签把它们覆盖掉（描述会变回占位符）。那几处改为在
   * `_renderRight()` 里走 `_tr(...)`，并依靠它本来就在 i18n-change 里被重跑。
   */
  function _relabelWorkbench(root) {
    const scope = root || document.getElementById('kb-workbench');
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    scope.querySelectorAll('[data-wb-text]').forEach((el) => { el.textContent = _tr(el.dataset.wbText); });
    scope.querySelectorAll('[data-wb-title]').forEach((el) => { el.title = _tr(el.dataset.wbTitle); });
    scope.querySelectorAll('[data-wb-placeholder]').forEach((el) => { el.placeholder = _tr(el.dataset.wbPlaceholder); });
    scope.querySelectorAll('[data-wb-aria]').forEach((el) => { el.setAttribute('aria-label', _tr(el.dataset.wbAria)); });
    scope.querySelectorAll('[data-wb-label]').forEach((el) => {
      const label = _tr(el.dataset.wbLabel);
      const span = el.querySelector && el.querySelector('.ui-button__label');
      if (span) span.textContent = label;
      else el.setAttribute('aria-label', label);
    });
  }

  function _externalSourceLabel(source) {
    if (source && source.id === 'feishu-wiki') {
      return _tr('kb.workbench.external_feishu', '飞书 Wiki');
    }
    return (source && source.id) || _tr('kb.workbench.external_source', '外部来源');
  }

  function _currentExternalSource() {
    return _state.externalSources.find((source) => source.path === _state.currentLib) || null;
  }

  function _isExternalSourceSelected() {
    return !_state.spaceId && !!_currentExternalSource();
  }

  // 统一图标：一律走 icons.js 的 uiIconHtml（仓库规范：图标只来自 icons.js）。
  // 2026-09-21 迁移：此前这里还有一套自带的 svg path 表（_SVGS，22 条）与 _svg()，
  // 属"硬编码 svg 路径"违规；实测那张表只被 3 个名字用到（sparkles/search/chevron-down），
  // 且这三个名字 icons.js 里都有 → 整表删除，_svg() 改为转发共享注册表。
  function _icon(name, cls) {
    if (typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, cls || 'kb-ico');
    }
    // 无 icons.js 的环境（部分单测的 window mock）：不再退回手写 svg（规范禁止），
    // 返回空串由调用方降级，避免"缺图标就自己画一个"的老路。
    return '';
  }

  // 旧调用名 → 共享注册表名的别名（保持调用点不变）
  const _ICON_ALIAS = {
    more: 'more-horizontal',
    'more-h': 'more-horizontal',
    share: 'share-2',
    chip: 'cpu',
    qrcode: 'qr-code',
    close: 'x',
    popout: 'external',
  };

  function _svg(name) {
    return _icon(_ICON_ALIAS[name] || name, 'kb-ico-svg');
  }

  // 共享原语包装：**不再自带降级模板**（2026-09-21）。此前这里把 uiIconButton / uiButton /
  // uiInput / uiTextarea 的标记各抄了一份作为兜底 —— 等于在页面里维护第二套原语实现：
  // 既被共享组件闸门计为"裸控件"，也让"缺原语"静默通过。现在缺失即抛错（与 kb-notes 同风格），
  // 让缺原语的事实当场暴露，而不是各自画一份。
  function _requirePrimitive(name) {
    if (typeof window[name] !== 'function') throw new Error(`knowledge base workbench requires ${name}`);
    return window[name];
  }

  function _uiIconButton(options) { return _requirePrimitive('uiIconButton')(options); }

  function _uiButton(options) { return _requirePrimitive('uiButton')(options); }

  function _uiInput(options) { return _requirePrimitive('uiInput')(options); }

  function _uiTextarea(options) { return _requirePrimitive('uiTextarea')(options); }

  // 复选框一律走共享 uiCheckbox（规范原文：不得手写原生 checkbox 元素）。
  // 与上面四份同款：不保留本地降级模板——缺原语时直接抛错，问题当场暴露。
  function _uiCheckbox(options) { return _requirePrimitive('uiCheckbox')(options); }

  function _uiSwitch(options) {
    if (typeof window.uiSwitch !== 'function') throw new Error('knowledge base requires uiSwitch');
    return window.uiSwitch(options);
  }

  function _uiSelect(options) {
    if (typeof window.uiSelect !== 'function') throw new Error('knowledge base requires uiSelect');
    return window.uiSelect(options);
  }

  function _uiSelectValue(scope, id, fallback) {
    const host = scope && scope.querySelector(`#${id}`);
    if (!host) return fallback;
    if (host._uiSelectApi && typeof host._uiSelectApi.getValue === 'function') {
      return host._uiSelectApi.getValue() || fallback;
    }
    return host.dataset.value || fallback;
  }

  function _uiEmptyState(options) {
    if (typeof window.uiEmptyState !== 'function') throw new Error('knowledge base requires uiEmptyState');
    return window.uiEmptyState(options);
  }

  function _elementFromHtml(markup) {
    const host = document.createElement('div');
    host.innerHTML = String(markup || '').trim();
    const element = host.firstElementChild;
    if (!element) throw new Error('expected shared UI markup to create an element');
    return element;
  }

  function _setUiButtonPresentation(button, label, icon) {
    if (!button) return;
    const labelEl = button.querySelector('.ui-button__label');
    if (labelEl) labelEl.textContent = label;
    else button.textContent = label;
    if (!icon) return;
    const iconEl = button.querySelector('.ui-button__icon');
    if (iconEl) iconEl.outerHTML = _icon(icon, 'ui-button__icon');
  }

  function _mountKbDialog({ overlay, dialogSelector, initialFocus, fallbackFocus, trigger, onClose }) {
    const dialog = overlay.querySelector(dialogSelector);
    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      overlay.remove();
      if (typeof onClose === 'function') onClose();
    };
    const controller = typeof uiModalController === 'function'
      ? uiModalController({ overlay, dialog, initialFocus, fallbackFocus, onClose: cleanup })
      : null;
    const close = (reason = 'close', options) => {
      if (controller && controller.isOpen()) controller.close(reason, options);
      else cleanup();
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close('backdrop');
    });
    if (controller) controller.open(trigger);
    else {
      overlay.hidden = false;
      overlay.style.display = 'flex';
      setTimeout(() => overlay.querySelector(initialFocus)?.focus(), 0);
    }
    return { close, controller };
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
    const target = String(name || '');
    const find = (nodes) => {
      for (const node of nodes || []) {
        if (!node || node.type !== 'dir') continue;
        if (node.path === target || node.name === target) return node;
        const nested = find(node.children || []);
        if (nested) return nested;
      }
      return null;
    };
    return find(_state.tree);
  }

  // `_state.tree` 这份快照里有没有这个相对路径（文件/目录都用 path 精确比对）。
  // 判定"快照是否过期"的唯一依据：kb.events 只报某个路径的索引进度，不带目录树；
  // 快照里查不到的路径 = 别处刚写进库的新文件，必须重拉树才可能出现行。
  function _treeHasPath(relPath) {
    const target = String(relPath || '').replace(/\\/g, '/');
    if (!target) return false;
    const find = (nodes) => {
      for (const node of nodes || []) {
        if (!node) continue;
        if (node.path === target) return true;
        if (node.children && find(node.children)) return true;
      }
      return false;
    };
    try { return find(_state.tree); } catch (_) { return false; }
  }

  // 库树兜底重载（去抖）：新文件首次被索引、或文件在别处被删掉时，
  // 快照就过期了——只更新「已索引」徽标是不够的，列表读的是 `_state.tree`
  // 快照。真机反馈：在「转写纠错」里另存到知识库后，列表里找不到刚存的文件。
  let _treeReloadTimer = null;
  function _scheduleTreeReload() {
    if (_treeReloadTimer) return;
    _treeReloadTimer = setTimeout(() => {
      _treeReloadTimer = null;
      if (_state.loading) { _scheduleTreeReload(); return; } // 正在加载 → 顺延，别丢这次刷新
      _loadAll();
    }, 400);
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
    if (!st) return `<span class="kb-file-status is-none">${_esc(_tr('kb.workbench.file_unindexed', '未索引'))}</span>`;
    if (st.status === 'ready') return `<span class="kb-file-status is-ready" title="chunks: ${st.chunks ?? 0}">${_icon('check')} ${_esc(_tr('kb.workbench.file_indexed', '已索引'))}</span>`;
    if (st.status === 'processing') return `<span class="kb-file-status is-run">${_esc(_tr('kb.workbench.file_indexing', '索引中…'))}</span>`;
    if (st.status === 'pending') return `<span class="kb-file-status is-run">${_esc(_tr('kb.workbench.file_queued', '排队中'))}</span>`;
    if (st.status === 'failed') return '<span class="kb-file-status is-failed" title="' + _esc(st.error || '') + '">' + _esc(_tr('kb.workbench.file_failed', '失败')) + '</span>';
    return `<span class="kb-file-status is-none">${_esc(_tr('kb.workbench.file_unindexed', '未索引'))}</span>`;
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
      const externalRoot = _state.tree.find((node) => node && node.type === 'dir' && (node.path === 'external' || node.name === 'external')) || null;
      _state.libs = _state.tree.filter((node) => node && node.type === 'dir' && node !== externalRoot);
      _state.externalSources = externalRoot
        ? (externalRoot.children || []).filter((node) => node && node.type === 'dir').map((node) => ({
          id: node.name,
          path: node.path || `external/${node.name}`,
          node,
        }))
        : [];
      _state.spaces = (spacesRes && Array.isArray(spacesRes.spaces)) ? spacesRes.spaces : [];
      _state.kbStatus = new Map();
      const files = (kbRes && Array.isArray(kbRes.files)) ? kbRes.files : [];
      for (const f of files) {
        if (!f || !f.path) continue;
        _state.kbStatus.set(f.path, { status: f.status, chunks: f.chunks, kind: f.kind, error: f.error });
      }
      const availableLibs = [
        ..._state.libs.map((lib) => lib.name),
        ..._state.externalSources.map((source) => source.path),
      ];
      if (!availableLibs.includes(_state.currentLib)) {
        _state.currentLib = availableLibs[0] || '';
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
    const personalLabel = _tr('kb.workbench.group_personal', '个人知识库');
    // 共享知识库已暂停：分组/标签统一标"待开发"（9.17 会议 P1），别再给自己起
    // "共享知识库"这种像能用的名字
    const sharedLabel = _tr('kb.workbench.group_shared', '待开发');
    const externalLabel = _tr('kb.workbench.group_external', '外部来源');
    const externalItems = _state.externalSources
      .filter((source) => {
        if (!_state.treeFilter) return true;
        const query = _state.treeFilter.toLowerCase();
        return source.id.toLowerCase().includes(query) || _externalSourceLabel(source).toLowerCase().includes(query);
      })
      .map((source) =>
        `<div class="kb-tree-item${source.path === _state.currentLib && !_state.spaceId ? ' active' : ''}" data-kb-external-source="${_esc(source.path)}">
          ${_icon('book-open', 'kb-tree-ico')}<span class="kb-tree-name">${_esc(_externalSourceLabel(source))}</span></div>`
      ).join('');
    const groups = [
      { key: 'personal', label: personalLabel, plus: true, btnId: 'kb-new-lib', btnTitle: _tr('kb.workbench.create_personal', '创建个人知识库'), html: _state.libs.filter((l) => !_state.treeFilter || l.name.toLowerCase().includes(_state.treeFilter)).map((l) =>
        `<div class="kb-tree-item${l.name === _state.currentLib && !_state.spaceId ? ' active' : ''}" data-kb-lib="${_esc(l.name)}">
          ${_icon('folder', 'kb-tree-ico')}<span class="kb-tree-name">${_esc(l.name)}</span></div>`
      ).join('') || `<div class="kb-tree-empty">${_esc(_tr('kb.workbench.tree_empty', '暂无知识库，可使用右侧按钮创建'))}</div>` },
      { key: 'shared', label: sharedLabel, plus: true, btnId: 'kb-new-shared-space', btnTitle: _tr('kb.workbench.create_shared', '创建共享知识库'), html: _state.spaces.filter((sp) => !_state.treeFilter || (sp.name || sp.space_id).toLowerCase().includes(_state.treeFilter)).map((sp) =>
        `<div class="kb-tree-item${sp.space_id === _state.spaceId ? ' active' : ''}" data-kb-space="${_esc(sp.space_id)}">
          ${_icon('folder', 'kb-tree-ico kb-tree-ico-space')}<span class="kb-tree-name">${_esc(sp.name || sp.space_id)}</span><span class="kb-badge-share" title="${_esc(sharedLabel)}">${_icon('users', 'kb-share-ico')}</span></div>`
      ).join('') || `<div class="kb-tree-placeholder">${_esc(_state.treeFilter ? _tr('kb.workbench.tree_no_match', '无匹配知识库') : _tr('kb.workbench.tree_no_space', '暂无共享空间'))}</div>` },
      { key: 'external', label: externalLabel, plus: false, html: externalItems || `<div class="kb-tree-placeholder">${_esc(_state.treeFilter ? _tr('kb.workbench.no_matching_sources', '无匹配来源') : _tr('kb.workbench.external_empty', '暂无外部来源'))}</div>` },
    ];
    const groupHtml = groups.map((g) => {
      const open = !_state.treeGroups.has(g.key);
      return `<div class="kb-tree-group">
        <div class="kb-tree-group-label" data-kb-group="${_esc(g.key)}" title="${_esc(open ? _tr('kb.workbench.collapse', '收起') : _tr('kb.workbench.expand', '展开'))}">
          <span class="kb-tree-caret">${_icon(open ? 'chevron-down' : 'chevron-right', 'kb-tree-caret-icon')}</span><span class="kb-tree-group-name">${_esc(g.label)}</span>
          ${g.plus ? _uiIconButton({
            label: g.btnTitle || _tr('kb.workbench.tree_create', '创建'),
            icon: 'plus',
            className: 'kb-tree-plus',
            attrs: { id: g.btnId || 'kb-new-lib' },
          }) : ''}
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
    tree.querySelectorAll('[data-kb-external-source]').forEach((el) => {
      el.addEventListener('click', () => _selectLib(el.dataset.kbExternalSource));
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
      name = typeof uiPrompt === 'function' ? await uiPrompt(_tr('kb.workbench.create_lib_prompt', '新建个人知识库名称：')) : window.prompt(_tr('kb.workbench.create_lib_prompt', '新建个人知识库名称：'));
    } catch (_) { /* cancelled */ }
    if (!name || !name.trim()) return;
    const clean = name.trim().replace(/[\/\\]/g, '-');
    try {
      await window.cogseed.invoke('contexts.mkdir', { path: clean });
      await _loadAll();
      _selectLib(clean);
    } catch (err) {
      _log.warn('create lib failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.create_failed', '创建失败：') + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // ── 创建共享知识库（对标 ima：名称*/封面/描述/加入方式/成员权限/推荐问题）──
  let _kbShareDialog = null;
  let _kbShareDialogController = null;
  let _kbShareCover = ''; // 封面 base64（'' = 默认）

  function _createSharedSpace() {
    const trigger = document.activeElement;
    _kbShareCloseDialog();
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-dlg-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal kb-share-dlg" role="dialog" aria-modal="true" aria-labelledby="kb-share-dlg-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title" id="kb-share-dlg-title">${_esc(_tr('kb.workbench.create_shared_title', '创建共享知识库'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.create_shared_close', '关闭创建共享知识库弹窗'), icon: 'x', className: 'kb-share-dlg-close' })}
        </header>
        <div class="ui-modal__body kb-share-dlg-body">
          <div class="kb-share-form">
            <div class="kb-share-field">
              <label class="kb-share-label" for="kb-share-name">${_esc(_tr('kb.workbench.field_name', '名称'))} <span class="kb-share-required">*</span></label>
              ${_uiInput({ id: 'kb-share-name', className: 'kb-share-input', placeholder: _tr('kb.workbench.field_name_placeholder', '请输入知识库名称'), attrs: { autocomplete: 'off', spellcheck: 'false' } })}
            </div>
            <div class="kb-share-field">
              <span class="kb-share-label">${_esc(_tr('kb.workbench.field_cover', '封面'))}</span>
              <div class="kb-share-cover">
                <div class="kb-share-cover-preview" id="kb-share-cover-preview"><span class="kb-share-cover-default">${_icon('folder', 'kb-share-cover-default-icon')}</span></div>
                ${_uiIconButton({ label: _tr('kb.workbench.cover_upload', '上传或更换知识库封面'), icon: 'edit-pencil', className: 'kb-share-cover-edit', attrs: { id: 'kb-share-cover-edit' } })}
                <input type="file" id="kb-share-cover-file" accept="image/*" hidden />
              </div>
            </div>
            <div class="kb-share-field">
              <label class="kb-share-label" for="kb-share-desc">${_esc(_tr('kb.workbench.field_desc', '描述'))}</label>
              ${_uiTextarea({ id: 'kb-share-desc', className: 'kb-share-input', placeholder: _tr('kb.workbench.field_desc_placeholder', '为你的共享知识库填写描述'), attrs: { rows: 3 } })}
            </div>
            <div class="kb-share-field">
              <span class="kb-share-label" id="kb-share-join-label">${_esc(_tr('kb.workbench.field_join_mode', '加入方式'))}</span>
              <div class="kb-share-select-wrap">
                ${_uiSelect({
                  id: 'kb-share-join',
                  value: 'direct',
                  labelId: 'kb-share-join-label',
                  options: [
                    { value: 'direct', label: _tr('kb.workbench.join_direct', '直接加入') },
                    { value: 'apply', label: _tr('kb.workbench.join_apply', '申请加入（管理员批准）') },
                    { value: 'invite', label: _tr('kb.workbench.join_invite', '仅邀请加入') },
                  ],
                })}
              </div>
            </div>
            <div class="kb-share-field">
              <span class="kb-share-label" id="kb-share-perm-field-label">${_esc(_tr('kb.workbench.menu_perm', '成员权限'))}</span>
              <div class="kb-share-perm" id="kb-share-perm">
                <button type="button" class="kb-share-perm-trigger" id="kb-share-perm-trigger" aria-labelledby="kb-share-perm-field-label kb-share-perm-label" aria-haspopup="listbox" aria-expanded="false">
                  <span class="kb-share-perm-label" id="kb-share-perm-label">${_esc(_tr('kb.workbench.perm_view_export', '内容可查看和导出'))}</span><span class="kb-share-caret">${_icon('chevron-down', 'kb-share-caret-icon')}</span>
                </button>
                <div class="kb-share-perm-menu" id="kb-share-perm-menu" role="listbox" aria-labelledby="kb-share-perm-field-label" data-ui-modal-popover data-trigger-id="kb-share-perm-trigger" data-open="false" hidden>
                  <div class="kb-share-perm-item is-selected" role="option" aria-selected="true" data-perm="view_export"><span class="kb-share-perm-check">${_icon('check', 'kb-share-perm-check-icon')}</span>${_esc(_tr('kb.workbench.perm_view_export', '内容可查看和导出'))}</div>
                  <div class="kb-share-perm-item" role="option" aria-selected="false" data-perm="view_only">${_esc(_tr('kb.workbench.perm_view_only', '内容可查看但不可导出'))}</div>
                  <div class="kb-share-perm-item" role="option" aria-selected="false" data-perm="hidden">${_esc(_tr('kb.workbench.perm_hidden', '内容不可查看'))}</div>
                </div>
              </div>
            </div>
            <div class="kb-share-field">
              <label class="kb-share-label" for="kb-share-questions">${_esc(_tr('kb.workbench.field_questions', '设置推荐问题'))}</label>
              ${_uiTextarea({ id: 'kb-share-questions', className: 'kb-share-input', placeholder: _tr('kb.workbench.field_questions_placeholder', '为你的知识库预设推荐问题（每行一个）'), attrs: { rows: 2 } })}
            </div>
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-dlg-actions">
          ${_uiButton({ label: _tr('kb.workbench.cancel', '取消'), role: 'secondary', className: 'kb-share-btn', attrs: { id: 'kb-share-cancel' } })}
          ${_uiButton({ label: _tr('kb.workbench.confirm', '确定'), role: 'primary', className: 'kb-share-btn', disabled: true, attrs: { id: 'kb-share-ok' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    _kbShareDialog = overlay;
    _kbShareCover = '';
    _kbShareDialogController = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-dlg',
      initialFocus: '#kb-share-name',
      fallbackFocus: '#kb-empty-create',
      trigger,
      onClose: () => {
        if (_kbShareDialog === overlay) _kbShareDialog = null;
        _kbShareDialogController = null;
      },
    });
    if (typeof window.hydrateUiFormSelects === 'function') window.hydrateUiFormSelects(overlay);

    const nameInput = overlay.querySelector('#kb-share-name');
    const okBtn = overlay.querySelector('#kb-share-ok');
    const syncOk = () => {
      const disabled = !String(nameInput.value || '').trim();
      okBtn.disabled = disabled;
      okBtn.classList.toggle('is-disabled', disabled);
    };
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
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.cover_too_large', '封面图片过大，请选择 3MB 以内的图片'), { variant: 'warning' });
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
    const permTrigger = overlay.querySelector('#kb-share-perm-trigger');
    permTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      permMenu.hidden = !permMenu.hidden;
      permMenu.dataset.open = permMenu.hidden ? 'false' : 'true';
      permTrigger.setAttribute('aria-expanded', permMenu.hidden ? 'false' : 'true');
    });
    permMenu.querySelectorAll('.kb-share-perm-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        permMenu.querySelectorAll('.kb-share-perm-item').forEach((x) => x.classList.remove('is-selected'));
        permMenu.querySelectorAll('.kb-share-perm-item').forEach((x) => x.setAttribute('aria-selected', x === item ? 'true' : 'false'));
        item.classList.add('is-selected');
        overlay.querySelector('#kb-share-perm-label').textContent = item.textContent.trim();
        permMenu.hidden = true;
        permMenu.dataset.open = 'false';
        permTrigger.setAttribute('aria-expanded', 'false');
      });
    });

    overlay.querySelector('#kb-share-cancel').addEventListener('click', _kbShareCloseDialog);
    overlay.querySelector('.kb-share-dlg-close').addEventListener('click', _kbShareCloseDialog);
    overlay.addEventListener('click', (e) => {
      if (!e.target.closest('#kb-share-perm')) {
        permMenu.hidden = true;
        permMenu.dataset.open = 'false';
        permTrigger.setAttribute('aria-expanded', 'false');
      }
    });
    okBtn.addEventListener('click', _kbShareSubmit);
  }

  async function _kbShareSubmit() {
    const overlay = _kbShareDialog;
    if (!overlay) return;
    const name = String(overlay.querySelector('#kb-share-name').value || '').trim();
    if (!name) return;
    const desc = String(overlay.querySelector('#kb-share-desc').value || '').trim();
    const joinMode = _uiSelectValue(overlay, 'kb-share-join', 'direct');
    const permItem = overlay.querySelector('.kb-share-perm-item.is-selected');
    const memberPermission = permItem ? permItem.dataset.perm : 'view_export';
    const questions = String(overlay.querySelector('#kb-share-questions').value || '')
      .split(/\n+/).map((q) => q.trim()).filter(Boolean).slice(0, 10);
    const okBtn = overlay.querySelector('#kb-share-ok');
    okBtn.disabled = true;
    okBtn.classList.add('is-loading');
    okBtn.setAttribute('aria-busy', 'true');
    _setUiButtonPresentation(okBtn, _tr('kb.workbench.creating', '创建中…'));
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
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.space_created', '共享知识库已创建'), { variant: 'success', timeoutMs: 2000 });
      await _loadAll();
      if (res && res.space && res.space.space_id) _selectSpace(res.space.space_id);
    } catch (err) {
      _log.warn('create shared space failed', err);
      okBtn.disabled = false;
      okBtn.classList.remove('is-loading');
      okBtn.removeAttribute('aria-busy');
      _setUiButtonPresentation(okBtn, _tr('kb.workbench.confirm', '确定'));
      const raw = String((err && err.message) || err || '');
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.create_failed', '创建失败：') + _kbSpaceErrText(raw), { variant: 'error', timeoutMs: 3000 });
    }
  }

  // 共享库创建/重命名错误码 → 友好中文（name_dup 等英文码对用户不可读）
  function _kbSpaceErrText(raw) {
    if (!raw) return _tr('kb.workbench.unknown_error', '未知错误');
    const m = String(raw);
    if (m.includes('name_dup') || m.includes('duplicate')) return _tr('kb.workbench.rename_err_exists', '该名称已存在，请换一个名称');
    if (m.includes('name_empty')) return _tr('kb.workbench.space_err_name_empty', '名称不能为空');
    if (m.includes('too_long')) return _tr('kb.workbench.space_err_too_long', '名称或描述过长');
    if (m.includes('invalid_space_type')) return _tr('kb.workbench.space_err_type', '空间类型无效');
    if (m.includes('not_found')) return _tr('kb.workbench.space_err_not_found', '目标不存在');
    if (m.includes('invalid')) return _tr('kb.workbench.space_err_invalid', '参数无效');
    if (m.includes('network') || m.includes('timed out')) return _tr('kb.workbench.space_err_network', '网络超时，请重试');
    return m;
  }

  function _kbShareCloseDialog() {
    if (_kbShareDialogController) _kbShareDialogController.close('close');
    else if (_kbShareDialog) { _kbShareDialog.remove(); _kbShareDialog = null; }
  }

  // 空态：居中插图 + 大号主按钮（保留库头部骨架，不一片白板）
  // 空库（左侧无库）→ 创建知识库；库内无内容 → 「添加内容」打开与工具栏一致的导入菜单
  function _emptyStateHtml(kind) {
    const isLibrary = kind === 'lib';
    return _uiEmptyState({
      kind: 'actionable',
      title: isLibrary ? _tr('kb.workbench.empty_no_library', '还没有知识库') : _tr('kb.workbench.empty_library', '知识库什么也没有，去这里添加'),
      hint: isLibrary ? _tr('kb.workbench.empty_no_library_hint', '创建一个知识库，或导入资料开始使用') : _tr('kb.workbench.empty_library_hint', '支持文件、文件夹、网页、笔记等多种方式导入'),
      icon: 'book-open',
      action: {
        label: isLibrary ? _tr('kb.workbench.empty_create_library', '创建知识库') : _tr('kb.workbench.empty_add_content', '添加内容'),
        icon: 'plus',
        attrs: { id: isLibrary ? 'kb-empty-create' : 'kb-empty-add' },
      },
    });
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
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.upload_failed', '上传失败：') + _esc(res.error || 'unknown'), { variant: 'error' });
        return;
      }
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.upload_done', '已上传，开始索引…'), { variant: 'success', timeoutMs: 1500 });
      _loadSpaceFiles(_state.spaceId);
    } catch (err) {
      _log.warn('space upload failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.upload_cancelled', '上传取消或失败'), { variant: 'warning' });
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
        uiToast(imported ? _tr('kb.workbench.dir_import_done', '已导入 {count} 个文件（扫描 {scanned}）', { count: imported, scanned }) : _tr('kb.workbench.dir_import_none', '所选文件夹没有可导入的文件'), {
          variant: imported ? 'success' : 'warning', timeoutMs: 2500,
        });
      }
      _loadSpaceFiles(_state.spaceId);
    } catch (err) {
      _log.warn('space import dir failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.dir_import_failed', '导入文件夹失败'), { variant: 'error' });
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
        <span class="kb-import-dlg-meta">${_esc(_tr('kb.workbench.node_folder', '文件夹'))}</span>
      </div>`;
    }
    for (const [fileIndex, f] of files.entries()) {
      const rel = _importDlgRelPath(_dlgLib, _dlgDir.split('/').filter(Boolean), f.name);
      const checked = _dlgSelected.has(rel) ? ' checked' : '';
      html += `<div class="kb-import-dlg-row${checked}" data-import-file="${_esc(rel)}">
        ${_uiCheckbox({ id: `kb-import-check-${fileIndex}`, className: 'kb-import-dlg-check', checked: Boolean(_dlgSelected.has(rel)), attrs: { 'data-import-check': rel, 'aria-label': f.name } })}
        <span class="kb-import-dlg-icon is-${_extClass(f.name)}">${_extLabel(f.name)}</span>
        <span class="kb-import-dlg-name" title="${_esc(f.name)}">${_esc(f.name)}</span>
        <span class="kb-import-dlg-meta">${_esc(_extLabel(f.name))}</span>
      </div>`;
    }
    if (!dirs.length && !files.length) {
      html = _uiEmptyState({ kind: 'quiet', title: q ? _tr('kb.workbench.files_no_match', '无匹配文档') : _tr('kb.workbench.dir_empty', '此目录为空') });
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
    if (countEl) countEl.textContent = _tr('kb.workbench.import_selected_count', '已选中 {count} 个文件', { count: _dlgSelected.size });
    if (okBtn) okBtn.disabled = _dlgSelected.size === 0;
  }

  function _bindImportDlgEvents(overlay) {
    const trigger = document.getElementById('kb-wb-import');
    const dialog = overlay.querySelector('[role="dialog"]');
    const controller = typeof uiModalController === 'function'
      ? uiModalController({
          overlay,
          dialog,
          initialFocus: '#kb-import-dlg-search-input',
          onClose: () => overlay.remove(),
        })
      : null;
    function closeImportDialog(restoreFocus = true) {
      if (controller) controller.close('action', { restoreFocus });
      else {
        overlay.remove();
        if (restoreFocus) trigger?.focus();
      }
    }
    overlay.querySelector('.kb-import-dlg-close')?.addEventListener('click', () => closeImportDialog());
    overlay.querySelector('.kb-import-dlg-cancel')?.addEventListener('click', () => closeImportDialog());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeImportDialog(); });
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
      okBtn.classList.add('is-loading');
      okBtn.setAttribute('aria-busy', 'true');
      const okIcon = okBtn.querySelector('.ui-button__icon');
      if (okIcon) okIcon.hidden = true;
      _setUiButtonPresentation(okBtn, _tr('kb.workbench.import_busy', '导入中…'));
      try {
        const res = await window.cogseed.invoke('spaces.files.importFromLibFiles', { spaceId: _state.spaceId, paths: files });
        if (!res || res.ok === false) {
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.import_failed', '导入失败：') + ((res && res.error) || 'unknown'), { variant: 'error' });
          return;
        }
        if (typeof uiToast === 'function') {
          uiToast(_tr('kb.workbench.import_done', '已导入 {count} 个文件', { count: Number(res.imported) || 0 }), { variant: 'success', timeoutMs: 2500 });
        }
        closeImportDialog();
        _loadSpaceFiles(_state.spaceId);
      } catch (err) {
        _log.warn('import dlg files failed', err);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.import_failed_short', '导入失败'), { variant: 'error' });
      } finally {
        if (overlay.isConnected) {
          okBtn.classList.remove('is-loading');
          okBtn.removeAttribute('aria-busy');
          _setUiButtonPresentation(okBtn, _tr('kb.workbench.import_confirm', '导入'), 'upload');
          okBtn.disabled = _dlgSelected.size === 0;
        }
      }
    });
    if (controller) controller.open(trigger);
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
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.import_no_library', '没有可导入的个人知识库'), { variant: 'warning' });
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
      </div>`).join('') || _uiEmptyState({ kind: 'quiet', title: _tr('kb.workbench.import_no_library_empty', '暂无个人知识库') });
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-import-dlg-overlay';
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--lg kb-import-dlg" role="dialog" aria-modal="true" aria-labelledby="kb-import-dlg-title">
        <header class="ui-modal__header kb-import-dlg-head">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-import-dlg-title" id="kb-import-dlg-title"><span class="kb-import-dlg-title-ico">${_icon('upload', 'kb-import-dlg-title-icon')}</span>${_esc(_tr('kb.workbench.import_title', '导入内容'))}</h2>
          </div>
          <div class="kb-import-dlg-search">
            <span class="kb-import-dlg-search-ico">${_icon('search', 'kb-import-dlg-search-icon')}</span>
            ${_uiInput({ id: 'kb-import-dlg-search-input', type: 'search', placeholder: _tr('kb.workbench.search_short', '搜索'), attrs: { autocomplete: 'off', spellcheck: 'false' } })}
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.import_close', '关闭导入弹窗'), icon: 'x', className: 'kb-import-dlg-close' })}
        </header>
        <div class="ui-modal__body kb-import-dlg-content">
          <div class="kb-import-dlg-nav">
            ${_uiIconButton({ label: _tr('kb.workbench.import_back', '返回'), icon: 'chevron-left', className: 'kb-import-dlg-back' })}
            ${_uiIconButton({ label: _tr('kb.workbench.import_forward', '前进'), icon: 'chevron-right', className: 'kb-import-dlg-forward' })}
            <span class="kb-import-dlg-path"></span>
          </div>
          <div class="kb-import-dlg-body">
            <div class="kb-import-dlg-tree">
              <div class="kb-import-dlg-group">${_esc(_tr('kb.workbench.import_personal_group', '个人知识库'))}</div>
              <div class="kb-import-dlg-libs">${libItems}</div>
            </div>
            <div class="kb-import-dlg-files"></div>
          </div>
        </div>
        <footer class="ui-modal__footer kb-import-dlg-foot">
          <span class="kb-import-dlg-count" data-kb-import-count>${_esc(_tr('kb.workbench.import_selected_count', '已选中 {count} 个文件', { count: 0 }))}</span>
          <div class="kb-import-dlg-actions">
            ${_uiButton({ label: _tr('kb.workbench.cancel', '取消'), role: 'secondary', size: 'sm', className: 'kb-import-dlg-cancel' })}
            ${_uiButton({ label: _tr('kb.workbench.import_confirm', '导入'), role: 'primary', size: 'sm', icon: 'upload', disabled: true, className: 'kb-import-dlg-ok' })}
          </div>
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    _bindImportDlgEvents(overlay);
    _renderImportDlgList();
    _syncImportDlgNav(overlay);
  }

  // 导入菜单「新建文件夹」：个人库 contexts.mkdir / 空间 spaces.files.mkdir
  async function _kbNewFolder() {
    const name = typeof uiPrompt === 'function' ? await uiPrompt(_tr('kb.workbench.new_folder_prompt', '新建文件夹名称：'), '') : window.prompt(_tr('kb.workbench.new_folder_prompt', '新建文件夹名称：'), '');
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
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.folder_created', '文件夹已创建'), { variant: 'success', timeoutMs: 1500 });
      _loadAll();
    } catch (err) {
      _log.warn('new folder failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.create_failed', '创建失败：') + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // 导入菜单「新建笔记」：在库内创建一篇 Markdown 笔记
  async function _kbNewNote() {
    const title = typeof uiPrompt === 'function' ? await uiPrompt(_tr('kb.workbench.note_title_prompt', '笔记标题：'), '') : window.prompt(_tr('kb.workbench.note_title_prompt', '笔记标题：'), '');
    const name = (title && title.trim()) ? String(title).trim() : _tr('kb.workbench.note_untitled', '笔记-{ts}', { ts: Date.now() });
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
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.note_created', '笔记「{name}」已创建', { name: fileName }), { variant: 'success', timeoutMs: 2000 });
      _loadAll();
    } catch (err) {
      _log.warn('new note failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.note_create_failed', '创建笔记失败：') + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // 导入菜单「网页链接」：抓取网页 → 存为 Markdown 到当前库
  async function _kbImportWebUrl() {
    const url = typeof uiPrompt === 'function' ? await uiPrompt(_tr('kb.workbench.web_url_prompt', '输入网页链接（http/https）：'), 'https://') : window.prompt(_tr('kb.workbench.web_url_prompt', '输入网页链接（http/https）：'), 'https://');
    if (!url || !url.trim()) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.web_url_fetching', '正在抓取网页内容…'), { variant: 'info' });
    try {
      const res = await window.cogseed.invoke('kb.importWebUrl', {
        dir: _state.spaceId ? null : (_state.currentLib || null),
        spaceId: _state.spaceId || null,
        url: String(url).trim(),
      });
      if (!res || res.ok === false) {
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.import_failed', '导入失败：') + ((res && res.error) || 'unknown'), { variant: 'error' });
        return;
      }
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.web_url_done', '已导入网页：{name}', { name: res.fileName || '' }), { variant: 'success', timeoutMs: 2500 });
      if (_state.spaceId) _loadSpaceFiles(_state.spaceId); else _loadAll();
    } catch (err) {
      _log.warn('web import failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.import_failed', '导入失败：') + ((err && err.message) || String(err)), { variant: 'error' });
    }
  }

  // 导入菜单「个人知识库」：把其他个人库的内容复制进当前库
  async function _kbMigrateLib() {
    if (!_state.currentLib) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.migrate_pick_target', '请先选择目标知识库'), { variant: 'warning' });
      return;
    }
    const sources = (_state.libs || []).map((l) => l.name).filter((n) => n !== _state.currentLib);
    if (!sources.length) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.migrate_no_source', '没有其他可迁移的个人知识库'), { variant: 'warning' });
      return;
    }
    const prompt = typeof uiPrompt === 'function' ? uiPrompt : (m, d) => Promise.resolve(window.prompt(m, d));
    const src = await prompt(_tr('kb.workbench.migrate_prompt', '从哪个个人知识库迁移内容到「{target}」？\n可选：{sources}', { target: _state.currentLib, sources: sources.join(_tr('kb.workbench.list_separator', '、')) }), '');
    if (!src || !src.trim()) return;
    const clean = String(src).trim();
    if (!sources.includes(clean)) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.migrate_source_missing', '源知识库不存在'), { variant: 'warning' });
      return;
    }
    try {
      const res = await window.cogseed.invoke('kb.migrateLib', { from: clean, to: _state.currentLib });
      if (!res || res.ok === false) {
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.migrate_failed', '迁移失败：') + ((res && res.error) || 'unknown'), { variant: 'error' });
        return;
      }
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.migrate_done', '已从「{from}」迁移到「{to}」，正在重新索引…', { from: clean, to: _state.currentLib }), { variant: 'success', timeoutMs: 2500 });
      await _loadAll();
      window.cogseed.invoke('kb.reconcile', {}).catch(() => {});
    } catch (err) {
      _log.warn('migrate lib failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.migrate_failed', '迁移失败：') + ((err && err.message) || String(err)), { variant: 'error' });
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
    const endTip = parts.length ? `<div class="kb-files-end">${_esc(_tr('kb.workbench.files_end', '没有更多内容了'))}</div>` : '';
    if (!parts.length && q) {
      // 搜索无结果：显示"无匹配"占位，不显示空库引导（避免误导为新库）
      list.innerHTML = _uiEmptyState({
        kind: 'explained',
        title: _tr('kb.workbench.files_no_match', '无匹配文档'),
        hint: _tr('kb.workbench.files_no_match_hint', '换个关键词试试，支持按文件名搜索库内所有文件（含文件夹中的文件）'),
        icon: 'search',
      });
    } else {
      list.innerHTML = (parts.join('') + endTip) || _emptyStateHtml('file');
      if (!parts.length) _bindEmptyActions();
    }

    list.querySelectorAll('[data-kb-dir]').forEach((el) => {
      el.addEventListener('click', () => _toggleDir(el.dataset.kbDir));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (_isExternalSourceSelected()) return;
        _kbRowMenu(el.dataset.kbDir, true, e.clientX, e.clientY);
      });
    });
    list.querySelectorAll('[data-kb-file]').forEach((el) => {
      el.addEventListener('click', () => _openFile(el.dataset.kbFile));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (_isExternalSourceSelected()) _kbExternalFileMenu(el.dataset.kbFile, e.clientX, e.clientY);
        else _kbRowMenu(el.dataset.kbFile, false, e.clientX, e.clientY);
      });
      const moreBtn = el.querySelector('.kb-mini-btn[title="更多"]');
      if (moreBtn) moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_isExternalSourceSelected()) _kbExternalFileMenu(el.dataset.kbFile, e.clientX, e.clientY);
        else _kbRowMenu(el.dataset.kbFile, false, e.clientX, e.clientY);
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
    return rel ? `${_icon('folder')} ${rel}` : _tr('kb.workbench.lib_root', '库根');
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
          <span class="kb-file-meta">${_esc(_tr('kb.workbench.node_count', '{count} 项', { count: _countFiles(d) }))}</span>
          <span class="kb-file-actions">${_uiIconButton({ label: _tr('kb.workbench.expand', '展开'), icon: 'chevron-right', className: 'kb-mini-btn', attrs: { 'data-kb-dir-toggle': path } })}</span>
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
          <span class="kb-file-actions">${_uiIconButton({ label: _tr('kb.workbench.file_gen_mindmap', '生成思维导图（S3）'), icon: 'sparkles', className: 'kb-mini-btn' })}${_uiIconButton({ label: '更多', icon: 'more-horizontal', className: 'kb-mini-btn' })}</span>
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
        <span class="kb-file-meta">${_esc(_tr('kb.workbench.node_count', '{count} 项', { count: _countFiles(d) }))}</span>
        <span class="kb-file-actions">${_uiIconButton({ label: open ? _tr('kb.workbench.collapse', '收起') : _tr('kb.workbench.expand', '展开'), icon: open ? 'chevron-down' : 'chevron-right', className: 'kb-mini-btn', attrs: { 'data-kb-dir-toggle': path } })}</span>
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
        <span class="kb-file-actions">${_uiIconButton({ label: _tr('kb.workbench.file_gen_mindmap', '生成思维导图（S3）'), icon: 'sparkles', className: 'kb-mini-btn' })}${_uiIconButton({ label: '更多', icon: 'more-horizontal', className: 'kb-mini-btn' })}</span>
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
        ? `<span class="kb-file-status is-ready" title="chunks: ${f.chunks ?? 0}">${_icon('check')} ${_esc(_tr('kb.workbench.file_indexed', '已索引'))}</span>`
        : status === 'processing' ? `<span class="kb-file-status is-run">${_esc(_tr('kb.workbench.file_indexing', '索引中…'))}</span>`
          : status === 'failed' ? '<span class="kb-file-status is-failed" title="' + _esc(f.error || '') + '">' + _esc(_tr('kb.workbench.file_failed', '失败')) + '</span>'
            : `<span class="kb-file-status is-run">${_esc(_tr('kb.workbench.file_queued', '排队中'))}</span>`;
      html += `<div class="kb-file-row" data-kb-space-file="${_esc(f.path || f.name)}">
        <span class="kb-file-icon is-${_extClass(f.name || f.path)}">${_extLabel(f.name || f.path)}</span>
        <span class="kb-file-name">${_esc(f.name || f.path)}</span>
        <span class="kb-file-meta">${_esc(_extLabel(f.name || f.path))}</span>
        <span class="kb-file-date">${_fmtDate(f.mtime)}</span>
        ${chip}
        <span class="kb-file-actions">${_uiIconButton({ label: _tr('kb.workbench.file_gen_mindmap', '生成思维导图（S3）'), icon: 'sparkles', className: 'kb-mini-btn' })}${_uiIconButton({ label: '更多', icon: 'more-horizontal', className: 'kb-mini-btn' })}</span>
      </div>`;
    }
    // 底部：没有更多内容了（对齐 ima 列表结束提示）
    if (files.length) html += `<div class="kb-files-end">${_esc(_tr('kb.workbench.files_end', '没有更多内容了'))}</div>`;
    if (!html && q) {
      // 搜索无结果：不显示空库引导
      list.innerHTML = _uiEmptyState({
        kind: 'explained',
        title: _tr('kb.workbench.files_no_match', '无匹配文档'),
        hint: _tr('kb.workbench.files_no_match_hint', '换个关键词试试，支持按文件名搜索库内所有文件（含文件夹中的文件）'),
        icon: 'search',
      });
      _renderCount(0);
      _renderRight();
      return;
    }
    if (!html) html = _emptyStateHtml('file');
    list.innerHTML = html;
    _bindEmptyActions();
    list.querySelectorAll('[data-kb-space-file]').forEach((el) => {
      el.addEventListener('click', () => {
        _openFile(el.dataset.kbSpaceFile);
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

  async function _openFileViewer(payload, scopeName, opts) {
    const scope = scopeName || (payload && payload.spaceId ? payload.spaceId : '');
    const hl = (opts && typeof opts === 'object') ? opts : null;
    let overlay = _ensureFileViewerOverlay();
    const dialog = overlay.querySelector('.kb-fv-dialog');
    // 先显示再恢复上次的窗口尺寸/位置：overlay 关着时是 display:none，量出来的
    // 宽高全是 0，位置就夹不住——保存的位置会带着窗口跑到当前可视区外（窗口变小
    // 之后尤其明显），用户既看不全也抓不到右下角手柄。
    overlay.hidden = false;
    if (_fvController) _fvController.open(document.activeElement);
    if (dialog) _fvApplyWindowRect(dialog);
    _fvResetZoom(dialog);
    _setFileViewerState(overlay, { loading: true, title: (payload && payload.path || '').split('/').pop() || _tr('kb.workbench.viewer_title', '原文查看'), scope });
    try {
      const res = await window.cogseed.invoke('kb.openFile', payload);
      if (!res || !res.ok) {
        const errMsg = (res && res.error) || _tr('kb.workbench.viewer_open_failed', '打开失败');
        const friendly = errMsg === 'too_large'
          ? _tr('kb.workbench.viewer_too_large', '文件超过 2MB 预览上限（{size}MB），暂不支持在线预览', { size: res && res.size ? Math.round(res.size / 1024 / 1024) : '' })
          : errMsg === 'file not found' ? _tr('kb.workbench.viewer_missing', '文件不存在或已被移动')
            : /暂不支持预览/.test(errMsg) ? errMsg : errMsg;
        _setFileViewerState(overlay, {
          error: friendly,
          title: (payload && payload.path || '').split('/').pop() || _tr('kb.workbench.viewer_title', '原文查看'),
          scope,
        });
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.viewer_cannot_preview', '无法预览该文件'), { variant: 'warning' });
        return;
      }
      _setFileViewerState(overlay, { content: res, title: res.name || (payload && payload.path || '').split('/').pop(), scope }, hl);
    } catch (err) {
      _setFileViewerState(overlay, {
        error: (err && err.message) || String(err),
        title: (payload && payload.path || '').split('/').pop() || _tr('kb.workbench.viewer_title', '原文查看'),
        scope,
      });
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.viewer_open_error', '打开文件失败'), { variant: 'error' });
    }
  }

  // 惰性构建查看 overlay（body 级，复用一次；样式自包含，风格对齐 anchored-source-view）
  // 全 DOM 构建（createElement），不引入 raw-control 字面量（shared-ui guard 冻结计数）。
  let _fileViewerOverlay = null;
  let _fvController = null; // 共享 modal controller：焦点陷阱/焦点返回/Escape 归共享层
  let _mmController = null; // 共享 modal controller：媒体管理器外壳的焦点/Escape/焦点归还
  let _fvOfficeBlobUrl = null; // office HTML 预览 blob URL（下次打开前 revoke）
  function _ensureFileViewerOverlay() {
    if (_fileViewerOverlay && document.getElementById('kb-file-viewer')) return _fileViewerOverlay;
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const overlay = el('div', 'kb-fv-overlay');
    overlay.id = 'kb-file-viewer';
    overlay.hidden = true;

    const dialog = el('section', 'kb-fv-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const head = el('header', 'kb-fv-head');
    const headMain = el('div', 'kb-fv-head-main');
    const title = el('span', 'kb-fv-title', _tr('kb.workbench.viewer_title', '原文查看'));
    title.id = 'kb-fv-title';
    const scope = el('span', 'kb-fv-scope');
    scope.id = 'kb-fv-scope';
    headMain.append(title, scope);
    const headActions = el('div', 'kb-fv-head-actions');
    // 缩放控件：− / 百分比(可点重置) / ＋
    const zoomOutBtn = el('button', 'kb-fv-btn kb-fv-zoom-btn', '−');
    zoomOutBtn.type = 'button';
    zoomOutBtn.title = _tr('kb.workbench.viewer_zoom_out', '缩小');
    const zoomLabel = el('button', 'kb-fv-zoom-label', '100%');
    zoomLabel.type = 'button';
    zoomLabel.title = _tr('kb.workbench.viewer_zoom_reset', '重置缩放（点击回到 100%）');
    const zoomInBtn = el('button', 'kb-fv-btn kb-fv-zoom-btn', '＋');
    zoomInBtn.type = 'button';
    zoomInBtn.title = _tr('kb.workbench.viewer_zoom_in', '放大');
    // HTML 专用：默认渲染页面，一键切回源码（两种能力都保留）
    const sourceBtn = el('button', 'kb-fv-btn', _tr('kb.workbench.viewer_source', '</> 查看源码'));
    sourceBtn.type = 'button';
    sourceBtn.id = 'kb-fv-source';
    sourceBtn.title = _tr('kb.workbench.viewer_source_tip', '在“渲染页面”和“HTML 源码”之间切换');
    sourceBtn.hidden = true;
    // 交给系统应用：查看器只做只读预览，PDF 批注编辑 / 旧版或嵌入对象 Office
    // 文件要动本机原生应用时走这里（主进程 kb.openExternal，同一套防穿越解析）
    const externalBtn = el('button', 'kb-fv-btn', _tr('kb.workbench.viewer_external', '↗ 在系统中打开'));
    externalBtn.type = 'button';
    externalBtn.id = 'kb-fv-external';
    externalBtn.title = _tr('kb.workbench.viewer_external_tip', '用本机默认应用打开（可编辑/批注/打印）');
    externalBtn.hidden = true;
    const readerBtn = el('button', 'kb-fv-btn', _tr('kb.workbench.viewer_reader', '⇱ 阅读模式'));
    readerBtn.type = 'button';
    readerBtn.id = 'kb-fv-reader';
    readerBtn.title = _tr('kb.workbench.viewer_reader_tip', '切换阅读宽度');
    const closeBtn = el('button', 'kb-fv-close');
    closeBtn.innerHTML = _icon('x', 'kb-fv-close-ico');
    closeBtn.setAttribute('aria-label', _tr('kb.workbench.viewer_close', '关闭文件阅读器'));
    closeBtn.title = _tr('kb.workbench.viewer_close', '关闭文件阅读器');
    closeBtn.type = 'button';
    closeBtn.id = 'kb-fv-close';
    closeBtn.title = _tr('kb.workbench.viewer_close_esc', '关闭（Esc）');
    headActions.append(zoomOutBtn, zoomLabel, zoomInBtn, sourceBtn, externalBtn, readerBtn, closeBtn);
    head.append(headMain, headActions);

    const body = el('div', 'kb-fv-body');
    const loading = el('div', 'kb-fv-loading', _tr('kb.workbench.viewer_loading', '正在读取文件…'));
    loading.id = 'kb-fv-loading';
    loading.hidden = true;
    const errorEl = el('div', 'kb-fv-error');
    errorEl.id = 'kb-fv-error';
    errorEl.hidden = true;
    const textEl = el('pre', 'kb-fv-text');
    textEl.id = 'kb-fv-text';
    textEl.hidden = true;
    const mdEl = el('div', 'kb-fv-md');
    mdEl.id = 'kb-fv-md';
    mdEl.hidden = true;
    body.append(loading, errorEl, textEl, mdEl);

    const resizeHandle = el('div', 'kb-fv-resize');
    resizeHandle.title = _tr('kb.workbench.viewer_resize', '拖动调整窗口大小');

    dialog.append(head, body, resizeHandle);
    overlay.appendChild(dialog);
    // 点遮罩空白处关闭——但必须"按在遮罩上也松在遮罩上"才算点击：
    // 拖右下角手柄改大小时指针常常落到窗口外（=遮罩上），松手那次 click 的
    // target 就成了遮罩，会把窗口直接关掉（实测：拖完手柄窗口消失）。
    let pressedOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => { pressedOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && pressedOnOverlay) _fvHide();
    });
    document.body.appendChild(overlay);
    closeBtn.addEventListener('click', () => { _fvHide(); });
    readerBtn.addEventListener('click', () => {
      const isReader = dialog.classList.toggle('kb-fv-dialog--reader');
      readerBtn.textContent = isReader ? _tr('kb.workbench.viewer_reader_back', '⇱ 返回') : _tr('kb.workbench.viewer_reader', '⇱ 阅读模式');
      _fvSaveWindowRect();
    });
    overlay.tabIndex = -1;
    zoomOutBtn.addEventListener('click', () => _fvSetZoom(dialog, (_fvZoom - 0.1)));
    sourceBtn.addEventListener('click', () => {
      const cur = _fvCur;
      if (cur && cur.mode === 'html') _fvToggleHtmlSource(overlay, cur);
      else if (cur && cur.mode === 'text' && _fvHtmlCtx) _fvToggleHtmlSource(overlay, _fvHtmlCtx);
    });
    zoomInBtn.addEventListener('click', () => _fvSetZoom(dialog, (_fvZoom + 0.1)));
    zoomLabel.addEventListener('click', () => _fvSetZoom(dialog, 1));
    externalBtn.addEventListener('click', () => {
      const payload = _fvExternalTarget();
      if (!payload) return;
      void window.cogseed.invoke('kb.openExternal', payload).then((r) => {
        if (r && r.ok === false && typeof uiToast === 'function') {
          uiToast(_tr('kb.workbench.viewer_open_failed', '打开失败') + '：' + (r.error || _tr('kb.workbench.unknown_reason', '未知原因')), { variant: 'warning' });
        }
      }).catch(() => { /* ignore */ });
    });
    // Ctrl/Cmd + 滚轮 缩放内容（pdf 内部滚轮由 PDFium 自行处理，不劫持）
    body.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      _fvSetZoom(dialog, _fvZoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    _fvBindTitleDrag(dialog, head);
    _fvBindResize(dialog, resizeHandle);
    // 弹层外壳交给共享层：焦点陷阱、Escape、关闭后焦点返回（规范：seam 存在时不重复键盘/焦点行为）
    // 类名与可见性仍由本模块持有（不改 CSS），controller 只接管交互语义。
    if (typeof uiModalController === 'function') {
      _fvController = uiModalController({
        overlay,
        dialog,
        initialFocus: '#kb-fv-close',
        onClose: () => { overlay.hidden = true; },
      });
    }
    _fileViewerOverlay = overlay;
    _injectFileViewerStyle();
    return overlay;
  }

  // ── 预览窗交互：标题拖拽移动 / 右下角调整大小（尺寸与位置记忆） ──
  const _FV_RECT_KEY = 'cogseed.kb-file-viewer.rect';

  /**
   * 拖拽期间的"事件罩"：盖住整个 overlay 的透明层。
   *
   * 为什么必须有它：查看器里嵌的 PDF / HTML iframe 是**独立进程**，指针一旦划到
   * 它上面，mousemove 就被送进那个进程，主窗口的监听收不到。实测过：从右下角往
   * 右下拉能变大（指针落在窗口外的遮罩上），往左上拉完全没反应——也就是用户说的
   * "能移动，但不能调整大小"。罩子把指针事件截在主窗口里，拖拽才跟手。
   */
  /** 关闭阅读器：优先走共享 controller（释放焦点陷阱并归还焦点），无 controller 时退回自管隐藏。 */
  function _fvHide() {
    const overlay = document.getElementById('kb-file-viewer');
    if (!overlay) return;
    if (_fvController && _fvController.isOpen()) _fvController.close('close');
    else overlay.hidden = true;
  }

  function _fvOverlayOf(el) {
    return el?.closest?.('.kb-fv-overlay') || null;
  }
  function _fvBeginDragShield(overlay) {
    if (!overlay || overlay.querySelector('.kb-fv-drag-shield')) return;
    const shield = document.createElement('div');
    shield.className = 'kb-fv-drag-shield';
    overlay.appendChild(shield);
  }
  function _fvEndDragShield(overlay) {
    if (!overlay) return;
    overlay.querySelectorAll('.kb-fv-drag-shield').forEach((s) => s.remove());
  }

  function _fvClampRect(dialog) {
    const vw = window.innerWidth; const vh = window.innerHeight;
    const w = Math.min(Math.max(dialog.offsetWidth, 420), vw - 24);
    const h = Math.min(Math.max(dialog.offsetHeight, 280), vh - 24);
    dialog.style.width = w + 'px';
    dialog.style.height = h + 'px';
    const r = dialog.getBoundingClientRect();
    dialog.style.left = Math.max(0, Math.min(r.left, vw - w)) + 'px';
    dialog.style.top = Math.max(0, Math.min(r.top, vh - h)) + 'px';
  }
  function _fvAbsolute(dialog) {
    // 脱离 flex 居中流，改为 overlay 内的绝对定位（记忆 x/y 时用）
    if (dialog.style.position === 'absolute') return;
    const r = dialog.getBoundingClientRect();
    dialog.style.position = 'absolute';
    dialog.style.margin = '0';
    dialog.style.left = Math.max(0, r.left) + 'px';
    dialog.style.top = Math.max(0, r.top) + 'px';
  }
  function _fvApplyWindowRect(dialog) {
    try {
      const saved = JSON.parse(localStorage.getItem(_FV_RECT_KEY) || 'null');
      if (!saved || !(saved.w && saved.h)) return; // 无记忆 → flex 居中默认
      const vw = window.innerWidth; const vh = window.innerHeight;
      dialog.style.position = 'absolute';
      dialog.style.margin = '0';
      const w = Math.min(Math.max(Number(saved.w), 420), vw - 24);
      const h = Math.min(Math.max(Number(saved.h), 280), vh - 24);
      dialog.style.width = w + 'px';
      dialog.style.height = h + 'px';
      // 用刚算好的 w/h 夹位置，而不是 offsetWidth：刚显示出来的那一帧量到的值
      // 可能还没稳定，拿它夹会把窗口放到可视区外。
      const x = typeof saved.x === 'number' ? saved.x : Math.round((vw - w) / 2);
      const y = typeof saved.y === 'number' ? saved.y : Math.round((vh - h) / 2);
      dialog.style.left = Math.max(0, Math.min(x, vw - w)) + 'px';
      dialog.style.top = Math.max(0, Math.min(y, vh - h)) + 'px';
    } catch { /* localStorage 不可用：保持居中 */ }
  }
  function _fvSaveWindowRect() {
    const overlay = document.getElementById('kb-file-viewer');
    if (!overlay || overlay.hidden) return;
    const dialog = overlay.querySelector('.kb-fv-dialog');
    if (!dialog) return;
    try {
      const r = dialog.getBoundingClientRect();
      localStorage.setItem(_FV_RECT_KEY, JSON.stringify({
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left), y: Math.round(r.top),
      }));
    } catch { /* ignore */ }
  }
  function _fvBindTitleDrag(dialog, bar) {
    if (bar.dataset.fvDragBound) return;
    bar.dataset.fvDragBound = '1';
    let sx = 0; let sy = 0; let ox = 0; let oy = 0;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button,input,select,textarea')) return;
      e.preventDefault();
      _fvAbsolute(dialog);
      const fvOverlay = _fvOverlayOf(dialog);
      _fvBeginDragShield(fvOverlay);
      sx = e.clientX; sy = e.clientY;
      const r = dialog.getBoundingClientRect();
      ox = r.left; oy = r.top;
      const onMove = (ev) => {
        const w = dialog.offsetWidth; const h = dialog.offsetHeight;
        dialog.style.left = Math.max(0, Math.min(window.innerWidth - w, ox + (ev.clientX - sx))) + 'px';
        dialog.style.top = Math.max(0, Math.min(window.innerHeight - h, oy + (ev.clientY - sy))) + 'px';
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        _fvEndDragShield(fvOverlay);
        _fvSaveWindowRect();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }
  function _fvBindResize(dialog, handle) {
    if (handle.dataset.fvResizeBound) return;
    handle.dataset.fvResizeBound = '1';
    let sx = 0; let sy = 0; let sw = 0; let sh = 0;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _fvAbsolute(dialog);
      const fvOverlay = _fvOverlayOf(dialog);
      _fvBeginDragShield(fvOverlay);
      sx = e.clientX; sy = e.clientY;
      sw = dialog.offsetWidth; sh = dialog.offsetHeight;
      document.body.classList.add('kb-fv-resizing');
      const onMove = (ev) => {
        const w = Math.min(Math.max(sw + (ev.clientX - sx), 420), window.innerWidth - 24);
        const h = Math.min(Math.max(sh + (ev.clientY - sy), 280), window.innerHeight - 24);
        dialog.style.width = w + 'px';
        dialog.style.height = h + 'px';
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('kb-fv-resizing');
        _fvEndDragShield(fvOverlay);
        _fvSaveWindowRect();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  // ── 内容缩放（md/text 走容器 zoom；office 走 iframe 文档 zoom；pdf 走 URL zoom 重载） ──
  let _fvZoom = 1;
  let _fvCur = null; // { mode: 'md'|'text'|'office'|'pdf'|'html'|'image'|'media', el?, src? }
  let _fvCtx = null; // 当前文件的 { path, spaceId }：给"在系统中打开"用
  /** "在系统中打开"要发给主进程的参数（无当前文件 → null；纯函数，便于测试锁定载荷）。 */
  function _fvExternalTarget() {
    const cur = _fvCtx;
    if (!cur || !cur.path) return null;
    return cur.spaceId ? { spaceId: cur.spaceId, path: cur.path } : { path: cur.path };
  }
  /** HTML 文件：在"渲染页面"和"源码"之间切换（只对 html 显示该按钮）。 */
  function _fvToggleHtmlSource(overlay, content) {
    const body = overlay.querySelector('.kb-fv-body');
    const srcBtn = overlay.querySelector('#kb-fv-source');
    const frame = body?.querySelector('.kb-fv-frame--html');
    const pre = overlay.querySelector('#kb-fv-text');
    if (!body || !frame || !pre || !content) return;
    const showingSource = !pre.hidden;
    if (showingSource) {
      // 回渲染视图
      pre.hidden = true;
      pre.textContent = '';
      frame.hidden = false;
      if (srcBtn) srcBtn.textContent = _tr('kb.workbench.viewer_source', '</> 查看源码');
      _fvCur = { mode: 'html', el: frame, src: content.src, rel: content.rel, spaceId: content.spaceId };
      return;
    }
    // 切到源码：走主进程 kb.openFile(asText) 读同一份文件
    // （渲染进程 fetch('kb-file://…') 取不到——非 http 方案没有 CORS 头，实测 Failed to fetch）
    void (async () => {
      try {
        const payload = content.spaceId
          ? { spaceId: content.spaceId, path: content.rel, asText: true }
          : { path: content.rel, asText: true };
        const res = await window.cogseed.invoke('kb.openFile', payload);
        const text = res && res.ok ? String(res.content || '') : '';
        if (!text) {
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.viewer_source_failed', '读取源码失败，请在系统中打开查看'), { variant: 'warning' });
          return;
        }
        frame.hidden = true;
        pre.hidden = false;
        pre.textContent = text;
        if (srcBtn) srcBtn.textContent = _tr('kb.workbench.viewer_render', '⇲ 渲染视图');
        _fvCur = { mode: 'text', el: pre };
      } catch (_) {
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.viewer_source_failed', '读取源码失败，请在系统中打开查看'), { variant: 'warning' });
      }
    })();
  }

  function _fvResetZoom(dialog) {
    _fvZoom = 1;
    _fvRenderZoom(dialog);
  }
  function _fvSetZoom(dialog, z) {
    _fvZoom = Math.min(2.5, Math.max(0.6, Math.round((z || 1) * 10) / 10));
    _fvRenderZoom(dialog);
  }
  /** PDF iframe 的目标 URL（zoom 是 hash 参数，PDFium 只在**真正加载**时读它）。 */
  function _fvPdfSrcAt(cur, pct) {
    const base = String(cur.src || '').split('#')[0];
    const pagePart = cur.page ? `&page=${cur.page}` : '';
    return `${base}#toolbar=1&navpanes=0${pagePart}&zoom=${pct}`;
  }

  /**
   * 换一个新的 PDF iframe 来应用缩放。
   *
   * 为什么不直接改 `el.src`：zoom 写在 URL 的 hash 里，只改 hash 对 PDF 插件
   * 属于"同文档导航"——Chromium 的 PDF 阅读器不会重新按 zoom 排版。真机实测：
   * 标签从 100% 点到 144%、iframe src 也跟着变了，**画面像素一模一样**
   * （截图逐像素比对：dark 32360 三个档位完全相同）。所以必须让它真的加载一次：
   * 用同一个 URL（新的 zoom）替换掉这个 frame。
   */
  function _fvApplyPdfZoom(cur, pct) {
    const old = cur.el;
    if (!old) return;
    if (!old.isConnected || typeof old.replaceWith !== 'function') {
      old.src = _fvPdfSrcAt(cur, pct);
      return;
    }
    const frame = old.cloneNode(false); // 复制 class/title 等属性，保持样式一致
    frame.src = _fvPdfSrcAt(cur, pct);
    old.replaceWith(frame);
    cur.el = frame;
    _fvCur = cur;
  }

  function _fvRenderZoom(dialog) {
    const label = dialog.querySelector('.kb-fv-zoom-label');
    if (label) label.textContent = Math.round(_fvZoom * 100) + '%';
    const cur = _fvCur;
    if (!cur) return;
    if (cur.mode === 'office' && cur.el && cur.el.contentDocument && cur.el.contentDocument.documentElement) {
      // office blob iframe 已开 allow-same-origin：直接缩放其内部文档
      cur.el.contentDocument.documentElement.style.zoom = String(_fvZoom);
    } else if (cur.mode === 'pdf' && cur.el) {
      // PDFium 无外部 zoom API：缩放值变化时用新 zoom 重新加载 frame
      const pct = Math.round(_fvZoom * 100);
      if (cur.lastZoom === pct) return;
      cur.lastZoom = pct;
      _fvApplyPdfZoom(cur, pct);
    } else if (cur.el) {
      cur.el.style.zoom = String(_fvZoom);
    }
  }

  // ── 整篇查看器高亮：在渲染文档里定位引用文本并包 <mark>（兼容 md 渲染差异）──
  function _fvTextNodeList(root) {
    const doc = (root && root.ownerDocument) || root;
    if (!doc || !doc.createTreeWalker) return [];
    const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }
  function _fvNormSpace(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }
  function _fvWrapRaw(node, start, len) {
    if (!node || !node.nodeValue) return null;
    const end = Math.min(node.nodeValue.length, start + Math.max(len, 1));
    if (start >= end) return null;
    const doc = node.ownerDocument;
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const mark = doc.createElement('mark');
    mark.className = 'kb-fv-mark';
    try { range.surroundContents(mark); } catch (_) { return null; }
    return mark;
  }
  // 归一化后的索引 → 原始文本近似偏移（空白折叠为单个空格）
  function _fvApproxRawStart(raw, normIdx) {
    let p = 0;
    let inWS = false;
    for (let i = 0; i < raw.length; i++) {
      const ws = /\s/.test(raw[i]);
      if (ws) {
        if (!inWS) { if (p === normIdx) return i; p++; inWS = true; }
      } else {
        inWS = false;
        if (p === normIdx) return i;
        p++;
      }
    }
    return Math.max(0, raw.length - 1);
  }
  // 去掉行首 md 标记（标题/引用/无序与有序列表编号），便于与渲染后 DOM 比对
  function _fvStripMdMarks(s) {
    return String(s || '').split('\n').map((ln) => ln
      .replace(/^\s*(?:#{1,6}[ \t]+|>[\t ]?|[-*+•][ \t]+|\d+[.、)][ \t]+|```+[^\n]*|~~~+)/, ''))
      .join(' ');
  }
  // 高亮前最终清洗：行首标记 + 行内强调符 + 空白归一（与高亮实际使用一致）
  function _fvCleanQuote(q) {
    return _fvNormSpace(_fvStripMdMarks(q).replace(/\*\*|__|`/g, ''));
  }
  function _fvSignificantTokens(s) {
    const seen = new Set();
    const out = [];
    String(s || '').split(/[^\p{L}\p{N}]+/u).forEach((t) => {
      const c = (t || '').replace(/[^\p{L}\p{N}_-]/gu, '');
      if (c && c.length >= 3 && !seen.has(c)) { seen.add(c); out.push(c); }
    });
    return out;
  }
  function _fvHighlightContainer(container, quote) {
    if (!container || !quote) return false;
    // 渲染后正文不含 ** ` 与列表序号/标题标记，先清洗再比对
    const cleaned = _fvCleanQuote(quote);
    if (!cleaned) return false;
    const needles = [];
    const push = (s) => {
      const c = _fvNormSpace(s);
      if (c && c.length >= 3 && !needles.includes(c)) needles.push(c);
    };
    push(cleaned.slice(0, 140));
    if (cleaned.length > 140) push(cleaned.slice(0, 80));
    const headSentence = (cleaned.match(/^[^\n。！？!?；;，,]{0,60}/) || [''])[0];
    push(headSentence);
    const root = container.nodeType === 9 ? container.body : container;
    const nodes = _fvTextNodeList(root);
    for (const needle of needles) {
      const needleNorm = _fvNormSpace(needle);
      for (const node of nodes) {
        const raw = node.nodeValue || '';
        if (!raw.trim()) continue;
        const rawNorm = _fvNormSpace(raw);
        const idx = rawNorm.indexOf(needleNorm);
        let rawStart = -1;
        if (idx >= 0) {
          rawStart = _fvApproxRawStart(raw, idx);
        } else {
          const word = (needleNorm.match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/u) || [])[0];
          if (!word) continue;
          const w = raw.indexOf(word);
          if (w < 0) continue;
          rawStart = w;
        }
        if (rawStart < 0) continue;
        const mark = _fvWrapRaw(node, rawStart, Math.min(needleNorm.length * 2 + 8, 200));
        if (mark) {
          try { mark.scrollIntoView({ block: 'center' }); } catch (_) { /* ignore */ }
          return true;
        }
      }
    }
    // 单节点匹配失败（列表/加粗把一句话拆到多个节点）→ 块级兜底：高亮整段
    const blocks = root.querySelectorAll ? Array.from(root.querySelectorAll('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,td,dd,dt,summary')) : [];
    if (blocks.length) {
      const tokens = _fvSignificantTokens(cleaned);
      let best = null;
      let bestScore = 0;
      for (const b of blocks) {
        const bn = _fvNormSpace(b.textContent || '');
        if (!bn) continue;
        let score = 0;
        for (const t of tokens) if (bn.includes(t)) score++;
        if (score > bestScore) { bestScore = score; best = b; }
      }
      if (best && bestScore >= 1) {
        best.classList.add('kb-fv-block-mark');
        try { best.scrollIntoView({ block: 'center' }); } catch (_) { /* ignore */ }
        return true;
      }
    }
    return false;
  }
  function _fvHighlightFrame(frame, quote) {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.body && quote) return _fvHighlightContainer(doc.body, quote);
    } catch (_) { /* 跨域/未就绪 */ }
    return false;
  }

  /**
   * 进入"嵌入 iframe"模式（pdf/office/html/图片/音视频）：正文区与对话框同时标记。
   * 对话框那份给的是默认高度——iframe 撑不起固有高度，只靠 min-height 的话窗口
   * 一开只有 280px 高（真机反馈：一打开就想拉大它）。
   */
  function _fvEnterFrameMode(overlay, body) {
    body.classList.add('kb-fv-body--frame');
    overlay.querySelector('.kb-fv-dialog')?.classList.add('kb-fv-dialog--frame');
  }

  function _setFileViewerState(overlay, st, hl) {
    const loading = overlay.querySelector('#kb-fv-loading');
    const errorEl = overlay.querySelector('#kb-fv-error');
    const textEl = overlay.querySelector('#kb-fv-text');
    const mdEl = overlay.querySelector('#kb-fv-md');
    const body = overlay.querySelector('.kb-fv-body');
    // 清理上一个文件的嵌入 iframe（pdf / office html），释放 blob URL
    body.querySelectorAll('.kb-fv-frame').forEach((f) => f.remove());
    // 退出嵌入模式：正文区与对话框两个 class 一起清（--frame 负责给足高度）
    body.classList.remove('kb-fv-body--frame');
    overlay.querySelector('.kb-fv-dialog')?.classList.remove('kb-fv-dialog--frame');
    if (_fvOfficeBlobUrl) {
      try { URL.revokeObjectURL(_fvOfficeBlobUrl); } catch (_) { /* ignore */ }
      _fvOfficeBlobUrl = null;
    }
    _fvCur = null; // 内容视图变化：失效上一文件的缩放目标（error/loading 也走这里）
    loading.hidden = !st.loading;
    errorEl.hidden = true; errorEl.textContent = '';
    textEl.hidden = true; textEl.textContent = '';
    mdEl.hidden = true; mdEl.innerHTML = '';
    if (st.title) overlay.querySelector('#kb-fv-title').textContent = st.title;
    const scopeEl = overlay.querySelector('#kb-fv-scope');
    scopeEl.textContent = st.scope ? _tr('kb.workbench.viewer_scope', '来自「{scope}」', { scope: st.scope }) : '';
    scopeEl.hidden = !st.scope;
    overlay.querySelector('#kb-fv-reader').textContent = _tr('kb.workbench.viewer_reader', '⇱ 阅读模式');
    const srcBtn = overlay.querySelector('#kb-fv-source');
    if (srcBtn) srcBtn.hidden = !(st.content && st.content.kind === 'html');
    // "在系统中打开"的当前文件上下文（follow 每次内容视图变化；无内容时隐藏按钮）
    _fvCtx = st.content ? { path: String(st.content.path || st.content.relPath || ''), spaceId: st.content.spaceId ? String(st.content.spaceId) : '' } : null;
    const extBtn = overlay.querySelector('#kb-fv-external');
    if (extBtn) extBtn.hidden = !(_fvCtx && _fvCtx.path);
    overlay.querySelector('.kb-fv-dialog')?.classList.remove('kb-fv-dialog--reader');
    if (st.error) {
      errorEl.hidden = false;
      errorEl.textContent = String(st.error);
      return;
    }
    const c = st.content;
    if (!c || !c.kind) {
      errorEl.hidden = false;
      errorEl.textContent = _tr('kb.workbench.viewer_empty', '文件内容为空');
      return;
    }
    if (c.kind === 'markdown') {
      mdEl.hidden = false;
      const bodyMd = String(c.content || '');
      mdEl.innerHTML = `<div class="markdown-body kb-fv-markdown">${typeof renderMarkdown === 'function' ? renderMarkdown(bodyMd) : _esc(bodyMd)}</div>`;
      _fvCur = { mode: 'md', el: mdEl };
      if (hl && hl.quote) setTimeout(() => {
        if (!_fvHighlightContainer(mdEl, hl.quote)) {
          console.warn('[kb] highlight-miss', { kind: 'markdown', path: String(c.path || ''), quote: String(hl.quote).slice(0, 40) });
        }
      }, 60);
    } else if (c.kind === 'text') {
      textEl.hidden = false;
      textEl.textContent = String(c.content || '');
      _fvCur = { mode: 'text', el: textEl };
      if (hl && hl.quote) setTimeout(() => {
        if (!_fvHighlightContainer(textEl, hl.quote)) {
          console.warn('[kb] highlight-miss', { kind: 'text', path: String(c.path || ''), quote: String(hl.quote).slice(0, 40) });
        }
      }, 60);
    } else if (c.kind === 'pdf') {
      // 原生 PDFium iframe（排版 100% 保持）：个人库 kb-file://kb/<rel>；
      // 空间库 kb-file://space/<spaceId>/<rel>（主进程已注册空间路由）
      const rel = String(c.path || '');
      const sid = c.spaceId ? String(c.spaceId) : '';
      const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
      const src = sid
        ? `kb-file://space/${encodeURIComponent(sid)}/${enc(rel)}`
        : `kb-file://kb/${enc(rel)}`;
      const pagePart = hl && typeof hl.page === 'number' && hl.page > 0 ? `&page=${Math.floor(hl.page)}` : '';
      const frame = document.createElement('iframe');
      frame.className = 'kb-fv-frame kb-fv-frame--pdf';
      frame.src = `${src}#toolbar=1&navpanes=0${pagePart}`;
      frame.title = String(c.name || rel);
      body.appendChild(frame);
      _fvEnterFrameMode(overlay, body);
      _fvCur = { mode: 'pdf', el: frame, src, page: (hl && hl.page) || null, lastZoom: 100 };
    } else if (c.kind === 'html' || c.kind === 'image' || c.kind === 'media') {
      // 渲染型文件：直接用 kb-file:// 取字节，保留各自的原生排版/控件。
      // html 用 sandbox（不给脚本），image/media 用原生 <img>/<video>/<audio>。
      const rel = String(c.relPath || c.path || '');
      const sid = c.spaceId ? String(c.spaceId) : '';
      const enc = (v) => String(v).split('/').map(encodeURIComponent).join('/');
      const base = sid
        ? `kb-file://space/${encodeURIComponent(sid)}/${enc(rel)}`
        : `kb-file://kb/${enc(rel)}`;
      if (c.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'kb-fv-media kb-fv-image';
        img.src = base;
        img.alt = String(c.name || rel);
        img.style.maxWidth = `${_fvZoom * 100}%`;
        body.appendChild(img);
        _fvEnterFrameMode(overlay, body);
        _fvCur = { mode: 'image', el: img };
      } else if (c.kind === 'media') {
        const node = document.createElement(c.audio ? 'audio' : 'video');
        node.className = 'kb-fv-media';
        node.controls = true;
        node.src = base;
        body.appendChild(node);
        _fvEnterFrameMode(overlay, body);
        _fvCur = { mode: 'media', el: node };
      } else {
        // HTML：默认渲染页面（原排版 / 自带样式 / 相对路径 css+图片都能加载，
        // 交互卡片里的脚本也能跑），工具栏提供"查看源码"切回纯文本。
        // sandbox 与 chat-file-viewer.js 的 HTML 分支保持一致：只给 allow-scripts，
        // 不给 allow-same-origin——`kb-file://` origin ≠ 渲染进程 origin，SOP 已挡住
        // 父页访问，脚本只为让交互型 HTML 能用。缩放走父页对 iframe 元素的 zoom
        // （跨 origin 拿不到 contentDocument，也不需要）。
        const frame = document.createElement('iframe');
        frame.className = 'kb-fv-frame kb-fv-frame--html';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.src = base;
        frame.title = String(c.name || rel);
        body.appendChild(frame);
        _fvEnterFrameMode(overlay, body);
        _fvCur = { mode: 'html', el: frame, src: base, rel, spaceId: sid };
        _fvHtmlCtx = _fvCur;
      }
    } else if (c.kind === 'office') {
      // docx/xlsx/pptx → 排版化 HTML 预览（主进程已包裹样式）。
      // sandbox 保持无脚本；allow-same-origin 让父页可对内部文档做 CSS zoom 缩放
      const officeHtml = String(c.html || '');
      _fvOfficeBlobUrl = URL.createObjectURL(new Blob([officeHtml], { type: 'text/html;charset=utf-8' }));
      const frame = document.createElement('iframe');
      frame.className = 'kb-fv-frame kb-fv-frame--office';
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.src = _fvOfficeBlobUrl;
      frame.title = String(c.name || c.path || '');
      body.appendChild(frame);
      _fvEnterFrameMode(overlay, body);
      _fvCur = { mode: 'office', el: frame, src: _fvOfficeBlobUrl };
      // iframe 就绪后：应用缩放 + 尽力高亮引用段落（失败可见）
      frame.addEventListener('load', () => {
        if (hl && hl.quote) setTimeout(() => {
          if (!_fvHighlightFrame(frame, hl.quote)) {
            console.warn('[kb] highlight-miss', { kind: 'office', path: String(c.path || ''), quote: String(hl.quote).slice(0, 40) });
          }
        }, 80);
        if (_fvCur && _fvCur.el === frame && _fvZoom !== 1) {
          try { frame.contentDocument.documentElement.style.zoom = String(_fvZoom); } catch (_) { /* ignore */ }
        }
      });
    } else {
      errorEl.hidden = false;
      errorEl.textContent = _tr('kb.workbench.viewer_unsupported', '暂不支持预览该文件');
      return;
    }
    overlay.focus();
  }

  let _fvStyleInjected = false;
  /** 当前打开的 HTML 文件上下文（渲染 ⇄ 源码 切换用）。 */
  let _fvHtmlCtx = null;
  function _injectFileViewerStyle() {
    if (_fvStyleInjected || document.getElementById('kb-file-viewer-style')) return;
    _fvStyleInjected = true;
    const style = document.createElement('style');
    style.id = 'kb-file-viewer-style';
    style.textContent = `
      .kb-fv-overlay {
        position: fixed; inset: 0; z-index: var(--z-modal); background: rgba(15, 23, 42, .5);
        display: flex; align-items: center; justify-content: center; padding: 24px;
      }
      .kb-fv-overlay[hidden] { display: none; }
      .kb-fv-dialog {
        background: var(--surface, #fff); color: var(--text, #1f2329);
        width: min(860px, 96vw); max-height: 88vh; border-radius: 12px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 16px 48px rgba(0,0,0,.28); outline: none;
        min-width: 420px; min-height: 280px;
        /* 必须有自己的定位上下文：右下角缩放手柄是 absolute，缺了它手柄会挂到
           overlay（fixed）上 → 跑到屏幕角落，而窗口自己的那个角上什么都没有
           （真机反馈「能移动但不能调整大小」）。 */
        position: relative;
      }
      .kb-fv-dialog--reader { width: min(1160px, 98vw); max-height: 94vh; }
      /* 嵌入 iframe 的模式（pdf/office/html/图片/音视频）：高度给足，否则 iframe
         只能吃 min-height，窗口一开就是一条矮缝，用户第一件事就是想拉大它。
         用户拖过大小后 inline height 会覆盖这里（inline 优先级更高）。 */
      .kb-fv-dialog--frame { height: min(86vh, 780px); }
      .kb-fv-head {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 10px 14px; border-bottom: 1px solid rgba(128,128,128,.22);
        background: linear-gradient(180deg, rgba(14,159,110,.05), transparent);
        cursor: move; user-select: none;
      }
      .kb-fv-head-main { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
      .kb-fv-title { font-weight: 650; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .kb-fv-scope { font-size: 12px; color: #0E9F6E; opacity: .85; white-space: nowrap; }
      .kb-fv-head-actions { display: flex; align-items: center; gap: 5px; flex: none; }
      .kb-fv-btn, .kb-fv-close {
        border: 1px solid rgba(14,159,110,.35); background: transparent; color: #0E9F6E;
        font-size: 12px; padding: 3px 10px; border-radius: 8px; cursor: pointer;
      }
      .kb-fv-btn:hover { background: #E2F5EC; }
      .kb-fv-zoom-btn { padding: 3px 8px; font-size: 13px; }
      .kb-fv-zoom-label { min-width: 54px; text-align: center; }
      .kb-fv-close { border-color: transparent; font-size: 16px; padding: 1px 7px; color: #888; }
      .kb-fv-close:hover { background: rgba(128,128,128,.14); color: inherit; }
      .kb-fv-resize {
        position: absolute; right: 0; bottom: 0;
        width: 18px; height: 18px; cursor: nwse-resize; z-index: var(--z-raised);
      }
      .kb-fv-resize::after {
        content: ''; position: absolute; right: 5px; bottom: 5px;
        width: 7px; height: 7px;
        border-right: 2px solid rgba(128,128,128,.55);
        border-bottom: 2px solid rgba(128,128,128,.55);
      }
      .kb-fv-resize:hover::after { border-color: #0E9F6E; }
      /* 拖拽事件罩：拖窗口/调大小时盖住整个查看器，避免指针划到内嵌 iframe
         （PDF 插件是独立进程）上后主窗口收不到 mousemove。 */
      .kb-fv-drag-shield { position: absolute; inset: 0; z-index: var(--z-sticky); }
      body.kb-fv-resizing, body.kb-fv-resizing * { cursor: nwse-resize !important; user-select: none; }
      .kb-fv-body { overflow: auto; padding: 20px 24px; flex: 1; min-height: 120px; }
      .kb-fv-loading { color: #0E9F6E; font-size: 13px; }
      .kb-fv-error { color: #c0392b; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
      .kb-fv-text {
        white-space: pre-wrap; word-break: break-word; margin: 0;
        font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 13px; line-height: 1.7; color: inherit;
      }
      .kb-fv-markdown { font-size: 14px; line-height: 1.8; }
      .kb-fv-dialog--reader .kb-fv-body { padding: 32px 56px; }
      .kb-fv-dialog--reader .kb-fv-markdown { font-size: 16px; }
      .kb-fv-dialog--reader .kb-fv-text { font-size: 15px; font-family: inherit; }
      /* pdf / office 嵌入 iframe：占满正文区，独立滚动，正文区本身不滚 */
      .kb-fv-body--frame { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
      .kb-fv-body--frame .kb-fv-frame {
        flex: 1; width: 100%; border: 0; min-height: 0;
        background: #fff; border-radius: 0 0 12px 12px;
      }
      .kb-fv-dialog--reader .kb-fv-body--frame { padding: 0; }
      .kb-fv-frame--office { background: #eef2f7; }
      .kb-fv-mark { background: #ffe58a; color: inherit; padding: 0 1px; border-radius: 2px; scroll-margin-top: 64px; }
      .kb-fv-block-mark {
        background: rgba(255, 229, 138, .4); box-shadow: inset 3px 0 0 rgba(240, 173, 0, .75);
        border-radius: 2px; scroll-margin-top: 64px;
      }
    `;
    document.head.appendChild(style);
  }

  // 问答区提示：无消息时显示「基于某库提问」引导

  // ── 文件查看（点击文件行）──────────────────────────────────────────────
  // 分派原则（#214 曾把右侧这条全部换成纯文本查看器，PDF/Word 因此丢了排版与缩放）：
  //   排版/渲染类（pdf、Office、html、图片、音视频）→ 富查看器 `_openFileViewer`
  //     （PDF 走 PDFium：原生工具栏=缩放/翻页/下载/打印；Office 走主进程排版 HTML；
  //      html 走 sandbox iframe 渲染页面；图片/音视频用原生标签）
  //   纯文本类（md/txt/代码）→ 原文查看器 `__openAnchorViewer`
  //     （它是转写纠错面板的宿主，也是引用高亮用的那个）
  //
  // 清单来源：`anchored-source-view.js`（常驻加载）暴露的 `__kbRichPreviewExts`——
  // 分派必须与"阅读器的兜底分支"用同一份表，否则某类型会被一边当排版类、
  // 另一边当纯文本（PDF/Word 退化成没有排版的字符流）。这里保留同表副本只作为
  // 独立加载（隔离测试 / 加载顺序异常）时的降级。
  const _FV_RICH_EXTS_FALLBACK = [
    '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
    '.html', '.htm',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
    '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.mp4', '.mov', '.webm', '.mkv', '.avi',
  ];
  const _FV_RICH_EXTS = window.__kbRichPreviewExts instanceof Set
    ? window.__kbRichPreviewExts
    : new Set(_FV_RICH_EXTS_FALLBACK);

  function _extOfPath(relPath) {
    const name = String(relPath || '').split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
  }

  /** 该文件是否该走"保排版"的富查看器（纯文本返回 false）。 */
  function _isRichPreview(relPath) {
    if (typeof window.__kbIsRichPath === 'function') return window.__kbIsRichPath(relPath);
    return _FV_RICH_EXTS.has(_extOfPath(relPath));
  }

  /** 按类型打开文件：富查看器 or 原文查看器。返回打开方式，便于测试与埋点。 */
  function _openFile(relPath) {
    if (_isRichPreview(relPath)) {
      const spaceId = _state.spaceId || '';
      void _openFileViewer(
        spaceId ? { spaceId, path: relPath } : { path: relPath },
        spaceId ? String(spaceId) : (_state.currentLib || ''),
        null,
      );
      return 'rich';
    }
    if (typeof window.__openAnchorViewer === 'function') {
      window.__openAnchorViewer({
        source: 'library',
        scope: _state.spaceId ? 'space' : 'global',
        path: relPath,
        // 不带 chunkIdx/quote = 打开整篇（不是引用跳转）：主进程据此不做 chunk
        // 定位，正文不会被高亮、也不会出现"返回引用位置"。
        // （此前这里塞了占位 chunk 号，于是每份文件打开都像从引用进来的。）
        ...(_state.spaceId ? { spaceId: _state.spaceId } : {}),
        view: 'document',
      });
      return 'anchor';
    }
    if (typeof uiToast === 'function') {
      const translated = typeof window.t === 'function' ? window.t('kb.viewer.ui_unavailable') : '';
      uiToast(translated && translated !== 'kb.viewer.ui_unavailable' ? translated : _tr('kb.workbench.viewer_unavailable', '原文查看器暂时不可用'), { variant: 'warning' });
    }
    return 'unavailable';
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
        <div class="kb-qa-hint-title">${_esc(_tr('kb.workbench.qa_hint_title', '基于知识库问答'))}</div>
        <div class="kb-qa-hint-sub">${_esc(_tr('kb.workbench.qa_hint_sub', '提问后回答只引用库内资料并标注锚点'))}</div>`;
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
        ${_uiIconButton({ label: _tr('kb.workbench.qa_attach_remove', '移除附件'), icon: 'x', variant: 'danger', className: 'kb-qa-attach-rm', attrs: { 'data-attach-idx': i } })}
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
    const externalSource = _currentExternalSource();
    const isExternal = !isSpace && !!externalSource;
    const dispName = isSpace ? _state.spaceName : (isExternal ? _externalSourceLabel(externalSource) : (_state.currentLib || _tr('kb.workbench.untitled_lib', '知识库')));
    const nameEl = document.getElementById('kb-wb-lib-name');
    if (nameEl) nameEl.textContent = dispName;
    const cover = document.getElementById('kb-wb-lib-cover');
    if (cover) cover.style.background = isSpace
      ? 'linear-gradient(135deg, #BFF0DD, #7FDCB8)'
      : isExternal
        ? 'linear-gradient(135deg, #DCE8FF, #AFC8FF)'
        : 'linear-gradient(135deg, #D9F2E7, #A9E4C8)';
    const tagEl = document.getElementById('kb-wb-lib-tag');
    if (tagEl) tagEl.textContent = isSpace
      ? _tr('kb.workbench.group_shared', '待开发')
      : isExternal
        ? _tr('kb.workbench.external_source', '外部来源')
        : _tr('kb.workbench.group_personal', '个人知识库');
    // 创建者（单用户客户端 = 本人）+ 描述（共享库有 description，否则占位提示）
    const ownerEl = document.getElementById('kb-wb-owner-name');
    if (ownerEl) ownerEl.textContent = isExternal ? _externalSourceLabel(externalSource) : _tr('kb.workbench.me', '我');
    const avatarEl = document.getElementById('kb-wb-owner-avatar');
    if (avatarEl) avatarEl.textContent = (dispName || _tr('kb.workbench.me', '我')).trim().charAt(0);
    const descEl = document.getElementById('kb-wb-lib-desc');
    if (descEl) {
      const sp = isSpace ? _state.spaces.find((x) => x.space_id === _state.spaceId) : null;
      const desc = isExternal
        ? _tr('kb.workbench.external_description', '通过已授权的外部来源导入，内容由来源同步管理。')
        : (sp && sp.description ? String(sp.description) : '');
      descEl.textContent = desc || _tr('kb.workbench.lib_desc_placeholder', '快来填写描述吧~');
      descEl.classList.toggle('is-empty', !desc);
    }
    // 分享/双人入口只对「共享知识库」有意义（个人库单用户、外部来源只读），
    // 挂在个人知识库上只会误导 —— 整块（按钮 + "待开发" chip）一起收掉。
    // 9.17 会议 P1：去掉个人知识库里无实际作用的"分享/双人"引导入口。
    const shareWrap = document.getElementById('kb-wb-share-wrap');
    if (shareWrap) shareWrap.style.display = isSpace ? '' : 'none';
    const moreBtn = document.getElementById('kb-wb-more-btn');
    if (moreBtn) moreBtn.style.display = isExternal ? 'none' : '';
    const moreMenu = document.getElementById('kb-wb-more-menu');
    if (isExternal && moreMenu) moreMenu.hidden = true;
    const importBtn = document.getElementById('kb-wb-import');
    if (importBtn) importBtn.style.display = isExternal ? 'none' : '';
    const importMenu = document.getElementById('kb-wb-import-menu');
    if (isExternal && importMenu) importMenu.hidden = true;
    const membersEl = document.getElementById('kb-wb-members');
    if (membersEl) {
      // 成员入口仅共享知识库显示（个人知识库单用户，无成员概念）
      membersEl.style.display = isSpace ? '' : 'none';
      if (isSpace) {
        membersEl.textContent = _tr('kb.workbench.members_joined', '1 加入');
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
      sub.textContent = _tr('kb.workbench.right_lib_summary', '当前库：{name} · {count} 个内容', { name: dispName, count });
    }
    _maybeShowQaHint();
    // 文件树/空间文件是异步到的：这里按最新的文件数刷一次两个生成入口的可用性
    const analysisCard = document.getElementById('kb-wb-analysis-card');
    if (analysisCard) _bindAnalysisActions(analysisCard);
  }

  // ── AI 解析（S3：kb.summary → 逐文档要点 + 一句话总结 + 脑图骨架）──
  /**
   * 切换库/空间时把解析卡重置为「未解析」态。
   *
   * 注意：**脑图/测验入口与解析无关**（真机反馈"为什么只在 AI 解析后才能打开"）——
   * 它们各自独立取库内 ready 文档生成（kb.mindmap / kb.quiz），所以这里直接可用，
   * 只有"库是空的"才禁用。解析只是同一张卡上的另一个入口。
   */  function _resetAnalysisCard() {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    card.innerHTML = `
      <div class="kb-wb-right-card-title">
        <span><span class="kb-wb-ai-chip"></span><span data-wb-text="kb.workbench.analysis_title"></span></span>
        <span class="kb-wb-card-actions">
          ${_uiButton({ label: _tr('kb.workbench.gen_mindmap', '生成脑图'), role: 'secondary', size: 'sm', icon: 'brain-circuit', className: 'kb-wb-analysis-action', attrs: { id: 'kb-wb-gen-mm' } })}
          ${_uiButton({ label: _tr('kb.workbench.gen_quiz', '生成测验'), role: 'secondary', size: 'sm', icon: 'file-text', className: 'kb-wb-analysis-action', attrs: { id: 'kb-wb-gen-quiz' } })}        </span>
      </div>
      <div class="kb-wb-right-card-sub" id="kb-wb-analysis-sub">${_esc(_tr('kb.workbench.right_lib_placeholder', '当前库：—'))}</div>
      <div class="kb-wb-right-placeholder">${_uiButton({ label: _tr('kb.workbench.analysis_generate', '生成 AI 解析'), role: 'primary', size: 'sm', icon: 'sparkles', attrs: { id: 'kb-analyze-btn', 'data-wb-label': 'kb.workbench.analysis_generate' } })}</div>`;
    // 重新绑定手动解析按钮（原按钮随 innerHTML 替换销毁）
    const analyzeBtn = card.querySelector('#kb-analyze-btn');
    if (analyzeBtn) analyzeBtn.addEventListener('click', () => _loadSummary());
    _bindAnalysisActions(card);
  }

  /** 当前库/空间的文件数（两个生成入口的可用性只看这个）。 */
  function _libFileCount() {
    if (_state.spaceId) return _state.spaceFiles.length;
    const node = _findLibNode(_state.currentLib);
    return node ? _countFiles(node) : 0;
  }

  /**
   * 绑定「生成脑图 / 生成测验」两个入口。
   *
   * 两者都只依赖"库内有 ready 文档"：脑图走 kb.mindmap（多级层级 JSON），测验走
   * kb.quiz（本地出题）。**都不需要先生成 AI 解析**——此前它们被解析结果挡着，
   * 库空时才该禁用（点了也没有材料）。
   */
  function _bindAnalysisActions(card) {
    // 可用性每次重算（库树是异步加载的：首屏渲染时文件数还是 0，加载完要放行），
    // 但 listener 只挂一次——本文件既有的 dataset.*Bound 幂等写法。
    const empty = _libFileCount() === 0;
    const mmBtn = card.querySelector('#kb-wb-gen-mm');
    if (mmBtn) {
      mmBtn.disabled = empty;
      mmBtn.title = empty ? _tr('kb.workbench.lib_empty_short', '当前知识库还没有内容') : _tr('kb.workbench.gen_mm_tip', '基于当前库文档生成多级脑图（不依赖 AI 解析）');
      if (!mmBtn.dataset.kbGenBound) {
        mmBtn.dataset.kbGenBound = '1';
        mmBtn.addEventListener('click', () => _genMindmap());
      }
    }
    const quizBtn = card.querySelector('#kb-wb-gen-quiz');
    if (quizBtn) {
      quizBtn.disabled = empty;
      quizBtn.title = empty ? _tr('kb.workbench.lib_empty_short', '当前知识库还没有内容') : _tr('kb.workbench.gen_quiz_tip', '基于当前库文档生成测验题（不依赖 AI 解析）');
      if (!quizBtn.dataset.kbGenBound) {
        quizBtn.dataset.kbGenBound = '1';
        quizBtn.addEventListener('click', () => _genQuiz());
      }
    }
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
      card.innerHTML = `<div class="kb-wb-right-card-title"><span class="kb-wb-ai-chip"></span>${_esc(_tr('kb.workbench.analysis_title', 'AI 解析本知识库'))}</div><div class="kb-wb-right-placeholder">${_esc(_tr('kb.workbench.analysis_unavailable', '解析服务不可用'))}</div>`;
      return;
    }
    const holder = card.querySelector('.kb-wb-right-placeholder');
    if (holder) {
      const isSpace = !!_state.spaceId;
      const count = isSpace ? _state.spaceFiles.length
        : (_findLibNode(_state.currentLib) ? _countFiles(_findLibNode(_state.currentLib)) : 0);
      holder.textContent = isSpace ? _tr('kb.workbench.analysis_running', '正在解析…') : _tr('kb.workbench.analysis_running_files', '正在解析… 共 {count} 个文件', { count });
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
        if (h) h.textContent = _tr('kb.workbench.analysis_retry_hint', '解析失败，请点击「生成 AI 解析」重试。');
      });
  }

  // AI 解析卡：操作组（展开/生成脑图）归卡片标题行右侧；
  // 一句话总结 = 只读文本（左绿条，无输入框感）；降级态按钮置灰不可用。
  function _renderAnalysis(summary) {
    const card = document.getElementById('kb-wb-analysis-card');
    if (!card) return;
    const docs = Array.isArray(summary.docs) ? summary.docs : [];
    const oneLiner = String(summary.oneLiner || '');
    const mm = summary.mindmap || {};
    const hasMm = !!(mm.root && Array.isArray(mm.kids) && mm.kids.length);
    const ok = summary.source !== 'degraded' || docs.some((d) => d.text);
    const srcTag = summary.source === 'cached' ? ` <span class="kb-wb-card-src">${_esc(_tr('kb.workbench.analysis_cached', '(缓存)'))}</span>`
      : summary.source === 'degraded' ? ` <span class="kb-wb-card-src">${_esc(_tr('kb.workbench.analysis_degraded', '(降级)'))}</span>` : '';

    // 生成脑图 / 生成测验与解析成败无关：它们只用库内文档（禁用与否由 _bindAnalysisActions 按库是否为空决定）
    const actions = `<span class="kb-wb-card-actions">
      ${_uiButton({ label: _tr('kb.workbench.gen_mindmap', '生成脑图'), role: 'secondary', size: 'sm', icon: 'brain-circuit', className: 'kb-wb-analysis-action', attrs: { id: 'kb-wb-gen-mm' } })}
      ${_uiButton({ label: _tr('kb.workbench.gen_quiz', '生成测验'), role: 'secondary', size: 'sm', icon: 'file-text', className: 'kb-wb-analysis-action', attrs: { id: 'kb-wb-gen-quiz' } })}
      ${_uiButton({ label: _tr('kb.workbench.expand', '展开'), role: 'ghost', size: 'sm', iconEnd: 'chevron-down', className: 'kb-wb-analysis-toggle', attrs: { id: 'kb-wb-analysis-toggle', 'aria-expanded': 'false' } })}    </span>`;

    let html = `<div class="kb-wb-right-card-title">
      <span><span class="kb-wb-ai-chip"></span>${_esc(_tr('kb.workbench.analysis_title', 'AI 解析本知识库'))}${srcTag}<span class="kb-wb-card-src">${_esc(_tr('kb.workbench.analysis_docs', '（{count} 个文档）', { count: docs.length }))}</span></span>
      ${actions}
    </div>`;

    if (ok) {
      if (oneLiner) {
        html += `<div class="kb-wb-one-liner"><span class="kb-wb-one-liner-tag">${_icon('info')} ${_esc(_tr('kb.workbench.analysis_one_liner', '一句话总结'))}</span><span class="kb-wb-one-liner-text">${_esc(oneLiner)}</span></div>`;
      }
      html += `<div class="kb-wb-analysis-body" id="kb-wb-analysis-body" hidden>`;
      for (const d of docs) {
        html += `<div class="kb-wb-doc">
          <div class="kb-wb-doc-head">
            <span class="kb-wb-doc-name">${_esc(d.name)}</span>
            ${_uiButton({ label: `${d.file}#chunk 1`, role: 'ghost', size: 'sm', className: 'kb-qa-chip', attrs: { 'data-kb-anchor': d.file } })}
          </div>`;
        if (d.text) html += `<div class="kb-wb-doc-text">${_esc(d.text)}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
    } else {
      const degNote = document.getElementById('kb-qa-degraded-note');
      if (degNote) degNote.hidden = false;
      html += `<div class="kb-wb-right-placeholder">${_esc(oneLiner || _tr('kb.workbench.analysis_failed', 'AI 解析失败，已降级为文件清单。'))}</div>`;
      if (docs.length) {
        html += `<div class="kb-wb-doc-list">${docs.map((d) =>
          `<div class="kb-wb-doc-row"><span class="kb-wb-doc-name">${_esc(d.name)}</span></div>`).join('')}</div>`;
      }
    }
    card.innerHTML = html;
    const degNote = document.getElementById('kb-qa-degraded-note');
    if (degNote && ok) degNote.hidden = true;

    _bindAnalysisActions(card);    card.querySelector('#kb-wb-analysis-toggle')?.addEventListener('click', () => {
      const body = card.querySelector('#kb-wb-analysis-body');
      const btn = card.querySelector('#kb-wb-analysis-toggle');
      if (!body || !btn) return;
      const open = body.hidden;
      body.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      _setUiButtonPresentation(btn, open ? _tr('kb.workbench.collapse', '收起') : _tr('kb.workbench.expand', '展开'), open ? 'chevron-up' : 'chevron-down');
    });
    card.querySelectorAll('[data-kb-anchor]').forEach((el) => {
      // 摘要里提到的文件 = "打开这份文件"，不是引用跳转：不带 chunkIdx（没有真实
      // 片段可定位，塞占位值只会让正文前几行平白多一道高亮）
      el.addEventListener('click', () => _openAnchor({ source: 'library', scope: 'global', path: el.dataset.kbAnchor }));
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

  // 降级/失败提示（source='degraded'）：说明原因并给重试入口，
  // 避免把「单节点知识库」当正常脑图展示（此前用户以为模型只生成了这么点）。
  function _mmDegradedHtml(reason, doc) {
    const texts = {
      empty: doc
        ? _tr('kb.workbench.mm_degraded_doc_unparsed', '这份文档还没有解析好的要点，无法生成脑图（仅显示中心节点）。请等索引完成后再试。')
        : _tr('kb.workbench.mm_degraded_lib_empty', '当前知识库暂无已解析文档要点，无法生成多级脑图（仅显示中心节点）。请先在知识库中导入并解析文档。'),
      'not-found': doc
        ? _tr('kb.workbench.mm_degraded_doc_missing', '这份文档不在「当前知识库」的已索引列表里：可能还在索引中、刚被移动/改名，或者它属于另一个库（例如你在看共享库、文件却在个人库）。请切到它所在的库再试。')
        : _tr('kb.workbench.mm_degraded_doc_missing_short', '指定的文档不在当前知识库的已索引列表里。'),
      timeout: _tr('kb.workbench.mm_degraded_timeout', '脑图生成超时：本地模型排队/推理超过 3 分钟未返回，已降级为仅中心节点。模型通道繁忙，请稍后点击重试。'),
      'model-failed': _tr('kb.workbench.mm_degraded_model_failed', '脑图生成失败（模型暂不可用），已降级为仅中心节点。请稍后点击重试。'),
    };
    const tip = texts[reason] || texts['model-failed'];
    const withRetry = reason !== 'empty' && reason !== 'not-found';
    return '<div class="kb-mm-fail">' + tip
      + (withRetry ? `<br>${_uiButton({ label: _tr('kb.workbench.regenerate', '重新生成'), role: 'secondary', size: 'sm', icon: 'refresh', className: 'kb-mm-retry-btn' })}` : '')
      + '</div>';
  }

  // ── 脑图入会话历史（方案 A）：快照 key + kind:'mindmap' 消息条目 ──
  // 快照 key 与手动存档（space:xxx / dir:xxx）分开：`<base>#<会话>-<时间戳>`，
  // 每次生成独立快照，历史里的旧脑图不被新生成覆盖；'#' 标记在存档列表中被过滤。
  function _mmSnapshotKey(doc, scope) {
    // 存档 key 以**主进程回执的真实作用域**为准（调用方已校验 doc 匹配），
    // 避免"请求本文档、实际整库"的错误脑图也顶着 doc: 前缀存进档。
    const base = (doc && (!scope || scope === 'doc'))
      ? `doc:${doc}`
      : (_state.spaceId ? `space:${_state.spaceId}` : `dir:${_state.currentLib || 'global'}`);
    const sid = String(_state.qaSessionId || 'solo').replace(/[^0-9a-zA-Z_-]/g, '');
    return `${base}#${sid}-${Date.now()}`;
  }

  /**
   * 从存档 key 反推作用域（与 _mmSnapshotKey 的构造对称）。
   * 会话历史/存档恢复出来的脑图必须把作用域一起带回来，否则之后点"刷新/保存"
   * 会用到上一次生成留下的作用域，把某一份文档的脑图覆盖成整库脑图（或反之）。
   */
  function _mmScopeFromKey(key) {
    const k = String(key || '');
    if (k.startsWith('doc:')) return { doc: k.slice(4).split('#')[0], scope: 'doc' };
    if (k.startsWith('space:')) return { doc: null, scope: 'space' };
    if (k.startsWith('dir:')) return { doc: null, scope: 'dir' };
    return null;
  }

  // 生成成功（非降级）后：自动存档快照并写入当前会话历史，刷新/切会话可还原
  function _mmRecordToHistory(root, doc, scope) {
    if (!root || !root.label) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const key = _mmSnapshotKey(doc, scope);
    window.cogseed.invoke('kb.mindmap.save', { key, root })
      .then((r) => {
        if (!r || !r.ok) return;
        _state.qaHistory.push({ role: 'assistant', kind: 'mindmap', content: '', key, label: root.label, ts: Date.now() });
        if (_state.qaHistory.length > 40) _state.qaHistory.splice(0, _state.qaHistory.length - 40);
        _qaSaveCurrentSession();
      })
      .catch(() => { /* 快照失败不阻塞展示；手动存档通道不受影响 */ });
  }

  // 从“回答文本 → 脑图”记录快照到该回答消息（entry.mm），历史恢复时据此
  // 把按钮标为「重新生成脑图」并在答案区内恢复预览，不再额外生成独立气泡。
  function _recordAnswerMindmap(root, entry) {
    if (!root || !root.label || !entry || !window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const key = _mmSnapshotKey();
    window.cogseed.invoke('kb.mindmap.save', { key, root })
      .then((r) => {
        if (!r || !r.ok) return;
        entry.mm = { key, label: root.label, ts: Date.now() };
        _qaSaveCurrentSession();
      })
      .catch(() => { /* 快照失败不阻塞展示 */ });
  }

  // 从会话历史还原一条脑图消息：先占位，再按 key 异步读档渲染
  function _appendMindmapMessage(box, m) {
    const ai = document.createElement('div');
    ai.className = 'kb-qa-msg is-ai';
    const headLabel = m && m.label ? ' · ' + String(m.label).slice(0, 20) : '';
    const body = document.createElement('div');
    body.className = 'kb-qa-msg-body kb-mm-msg';
    body.innerHTML = '<div class="kb-mm-msg-head">' + _icon('brain-circuit') + ' ' + _esc(_tr('kb.workbench.mm_title', '脑图预览')) + _esc(headLabel) + '</div>'
      + `<div class="kb-wb-mm-canvas"><div class="kb-mm-loading">${_esc(_tr('kb.workbench.mm_loading', '正在载入脑图…'))}</div></div>`;
    ai.appendChild(body);
    if (box) box.appendChild(ai);
    const canvas = body.querySelector('.kb-wb-mm-canvas');
    if (!m || !m.key || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      if (canvas) canvas.innerHTML = `<div class="kb-mm-fail">${_esc(_tr('kb.workbench.mm_archive_unavailable', '脑图存档不可用'))}</div>`;
      return;
    }
    window.cogseed.invoke('kb.mindmap.load', { key: m.key })
      .then((r) => {
        if (!canvas) return;
        if (!r || !r.ok || !r.root) {
          canvas.innerHTML = `<div class="kb-mm-fail">${_esc(_tr('kb.workbench.mm_archive_stale', '脑图存档已失效（可能已被删除）'))}</div>`;
          return;
        }
        const root = r.root;
        _mmResetFoldToDefault(root); // 恢复出来的图也回到骨架层（首屏可读）
        canvas.innerHTML = _mmTreeSvg(root, _state.mmCollapsed, _mmRenderOpts());
        canvas._mmRoot = root;
        canvas._mmScope = _mmScopeFromKey(m.key); // 恢复存档也要带回作用域，否则刷新/保存会串味
        _bindMindCanvas(canvas);
      })
      .catch(() => { if (canvas) canvas.innerHTML = `<div class="kb-mm-fail">${_esc(_tr('kb.workbench.mm_load_failed_dot', '脑图载入失败'))}</div>`; });
  }

  // 历史恢复时，在答案的「重新生成脑图」按钮下方异步载入该答案已存的脑图快照
  function _qaSnapshotInto(row, key) {
    if (!row || !key || !window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const holder = document.createElement('div');
    holder.className = 'kb-mm-msg';
    holder.innerHTML = `<div class="kb-wb-mm-canvas"><div class="kb-mm-loading">${_esc(_tr('kb.workbench.mm_loading', '正在载入脑图…'))}</div></div>`;
    row.appendChild(holder);
    const canvas = holder.querySelector('.kb-wb-mm-canvas');
    window.cogseed.invoke('kb.mindmap.load', { key })
      .then((r) => {
        if (!canvas) return;
        if (!r || !r.ok || !r.root) {
          canvas.innerHTML = `<div class="kb-mm-fail">${_esc(_tr('kb.workbench.mm_archive_stale', '脑图存档已失效（可能已被删除）'))}</div>`;
          return;
        }
        const root = r.root;
        _mmResetFoldToDefault(root);
        canvas.innerHTML = _mmTreeSvg(root, _state.mmCollapsed, _mmRenderOpts());
        canvas._mmRoot = root;
        canvas._mmScope = _mmScopeFromKey(key);
        _bindMindCanvas(canvas);
      })
      .catch(() => { if (canvas) canvas.innerHTML = `<div class="kb-mm-fail">${_esc(_tr('kb.workbench.mm_load_failed_dot', '脑图载入失败'))}</div>`; });
  }

  // 生成脑图 → 作为产物追加到**对话消息区**（kb-qa-messages），
  // 与问答流同区可见、可滚动，不藏在解析卡的折叠区。
  // 生成脑图 → 调本地 kb.mindmap（多级层级 JSON）→ 对话区渲染精致树形脑图
  //
  // `doc` 存在时走**文档级脑图**（只读这一个文件的 chunk）；否则基于整个当前库
  // （`dir` / `spaceId`）。为什么必须有文档级入口：整库脑图的作用域是"目录"，
  // 根主题必然是"这个库是什么"。真机案例：一个目录里同时放了 Palantir 一本书的
  // 对照译文 + 一篇 209 号文文章，生成的根节点就成了「AI与软件行业资料梳理」，
  // 一级分支按**文件**分（帕兰提尔 / 工信部209号文 / 软件行业AI改写）而不是按
  // **内容主题**分——因为输入本身就是两份互不相关的资料。想要"以某一份文档为
  // 中心主题"的脑图，只能把作用域下沉到文档。
  function _genMindmap(doc) {
    if (_mmGenerating) return; // 生成中防重复
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    _mmGenerating = true;
    const docName = doc ? String(doc).split('/').pop() : '';
    const ai = document.createElement('div');
    ai.className = 'kb-qa-msg is-ai';
    const body = document.createElement('div');
    body.className = 'kb-qa-msg-body kb-mm-msg';
    body.innerHTML = '<div class="kb-mm-msg-head">' + _icon('brain-circuit') + ' ' + _esc(_tr('kb.workbench.mm_title', '脑图预览'))
      + (docName ? `<span class="kb-mm-msg-scope">${_esc(_tr('kb.workbench.mm_scope_doc', '本文档：{name}', { name: docName }))}</span>` : '')
      + '</div>'
      + '<div class="kb-wb-mm-canvas" id="kb-wb-mm-canvas">'
      + `<div class="kb-mm-loading">${_esc(_tr('kb.workbench.mm_generating', '正在生成多级脑图（本地模型推理中，约 30–90 秒，长文档最长约 3 分钟）…'))}</div></div>`;
    ai.appendChild(body);
    box.appendChild(ai);
    const canvas = body.querySelector('.kb-wb-mm-canvas');
    if (!canvas || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      _mmGenerating = false;
      return;
    }
    window.cogseed.invoke('kb.mindmap', doc
      // 文档级：带上 spaceId —— 共享库的文件必须去共享库的索引里找，
      // 否则同一份 rel_path 在个人库里找不到，会误报 not-found。
      ? { doc, spaceId: _state.spaceId || null }
      : {
        dir: _state.spaceId ? null : (_state.currentLib || null),
        spaceId: _state.spaceId || null,
      })
      .then((res) => {
        _mmGenerating = false;
        if (!res || !res.root) throw new Error('empty mindmap');
        // ── 作用域回执校验（顺序很关键！）───────────────────────────────
        // 请求了「本文档」就必须真的拿到 doc 作用域。主进程若是旧版本（不认识 doc
        // 参数，静默退回"整库前 N 个文件"），这里必须**丢弃结果**并说清原因——
        // 真机事故：一份 ECS 早会转写的"仅本文档"脑图里全是别的目录文件的内容，
        // 用户完全看不出问题出在作用域上（且这个错误脑图还会以 doc: 为 key 存档）。
        //
        // 顺序：先判 scope，再判 degraded，最后才判 files。因为**降级响应本来就没有
        // files**（not-found 时 files=[]），把 files 混进第一条会让"这份文档没索引到"
        // 被误报成"作用域不匹配，请重启"（2026-09-16 真机就此误报过，用户以为功能坏了）。
        const scopeMismatch = Boolean(doc) && res.scope !== 'doc';
        if (scopeMismatch) {
          canvas.innerHTML = '<div class="kb-mm-fail">'
            + _esc(_tr('kb.workbench.mm_scope_mismatch', '主进程没有按「本文档」作用域生成（返回作用域：{scope}），已丢弃这次结果。', { scope: res.scope || _tr('kb.workbench.unknown', '未知') }))
            + '<br>' + _esc(_tr('kb.workbench.mm_stale_process', '常见原因是应用主进程仍是旧代码（只刷新了界面，没重启进程）：请**完全退出 CogSeed 后重新启动**再试。'))
            + '<br>' + _uiButton({ label: _tr('kb.workbench.regenerate', '重新生成'), role: 'secondary', size: 'sm', icon: 'refresh', className: 'kb-mm-retry-btn' })
            + '</div>';
          // 标题行不能还挂着「本文档：xxx」——否则用户在错误提示上方仍看到"这是本文档的图"
          const scopeTag = body.querySelector('.kb-mm-msg-scope');
          if (scopeTag) scopeTag.textContent = _tr('kb.workbench.mm_scope_discarded', '作用域不匹配，已丢弃');
          const retry = canvas.querySelector('.kb-mm-retry-btn');
          if (retry) retry.addEventListener('click', () => { ai.remove(); _genMindmap(doc); });
          return;
        }
        if (res.source === 'degraded') {
          canvas.innerHTML = _mmDegradedHtml(res.reason, doc);
          const retryBtn = canvas.querySelector('.kb-mm-retry-btn');
          if (retryBtn) retryBtn.addEventListener('click', () => {
            ai.remove();
            _genMindmap(doc);
          });
          return;
        }
        // 走到这里一定是"真的生成/读到缓存"的响应：此时 files 必须恰好是请求的那一份。
        // 路径按 Unicode 归一化 + 文件名比较：macOS 上存在 NFC/NFD 两种等价形式，
        // 严格字符串相等会把同一文件判成两个（而这条校验的真正目的是"别把整库图冒充
        // 本文档图"，不是比对字节）。
        if (doc && !_mmSameDoc(res.files, doc)) {
          canvas.innerHTML = '<div class="kb-mm-fail">'
            + _esc(_tr('kb.workbench.mm_file_mismatch', '主进程读取的文件与请求的不是同一份（请求：{asked}；实际：{actual}），已丢弃这次结果。', { asked: doc, actual: Array.isArray(res.files) ? res.files.join(_tr('kb.workbench.list_separator', '、')) : _tr('kb.workbench.unknown', '未知') }))
            + '<br>' + _uiButton({ label: _tr('kb.workbench.regenerate', '重新生成'), role: 'secondary', size: 'sm', icon: 'refresh', className: 'kb-mm-retry-btn' })
            + '</div>';
          const retry2 = canvas.querySelector('.kb-mm-retry-btn');
          if (retry2) retry2.addEventListener('click', () => { ai.remove(); _genMindmap(doc); });
          return;
        }
        _state.lastMind = res.root;
        _state.mmScope = { doc: doc || null, scope: res.scope || (doc ? 'doc' : 'dir') };
        canvas._mmScope = _state.mmScope;
        _mmResetFoldToDefault(res.root); // 新生成 → 回到骨架层（首屏只到一级分支）
        _state.mmFocus = null;
        _state.mmSearchHits = new Set();
        canvas.innerHTML = _mmTreeSvg(res.root, _state.mmCollapsed, _mmRenderOpts());
        canvas._mmRoot = res.root;
        _bindMindCanvas(canvas);
        if (res.source === 'generated') _mmRecordToHistory(res.root, doc, res.scope);
      })
      .catch(() => {
        _mmGenerating = false;
        canvas.innerHTML = `<div class="kb-mm-fail">${_esc(_tr('kb.workbench.mm_generate_failed', '脑图生成失败，请稍后重试'))}</div>`;
      });
    box.scrollTop = box.scrollHeight;
  }

  /**
   * 主进程回执的文件列表是否就是请求的那一份。
   *
   * 只要求"恰好一份 + 文件名一致"：真正要守住的是"别把整库图冒充本文档图"，
   * 而不是比对字节。macOS 上文件名存在 NFC/NFD 两种等价形式（同一个文件两种字节），
   * 严格字符串相等会把它们判成两份，导致合法请求被当成错配丢弃。
   */
  function _mmSameDoc(files, doc) {
    if (!Array.isArray(files) || files.length !== 1) return false;
    const norm = (s) => String(s || '').normalize('NFC');
    const base = (s) => norm(s).split('/').pop();
    const want = norm(doc);
    const got = norm(files[0]);
    return got === want || base(got) === base(want);
  }

  /**
   * 文件右键 / 「…」菜单的「生成脑图（本文档）」入口。
   *
   * 直接把该文件的相对路径作为 `doc` 交给 kb.mindmap：主进程只读这一个文件的
   * chunk（`collectReadyDocLines({ doc })`），于是根主题 = 这份文档的主题、
   * 一级分支 = 这份文档的章节。整库脑图仍保留在「生成脑图」主按钮上。
   */
  function _kbMindmapForDoc(relPath) {
    if (!relPath) return;
    _genMindmap(relPath);
  }

  // ── 生成测验（kb.quiz）────────────────────────────────────────────────
  // 与脑图同规矩：产物追加到对话消息区，不藏在解析卡折叠区；不依赖 AI 解析。
  let _quizGenerating = false;

  function _quizFailHtml(reason) {
    const texts = {
      empty: _tr('kb.workbench.quiz_fail_empty', '当前知识库还没有已解析的文档，无法出题。请先导入内容并等索引完成。'),
      timeout: _tr('kb.workbench.quiz_fail_timeout', '出题超时：本地模型排队/推理超过 2 分钟未返回。模型通道繁忙，请稍后重试。'),
      'model-failed': _tr('kb.workbench.quiz_fail_model', '出题失败（模型暂不可用），请稍后重试。'),
      unparsable: _tr('kb.workbench.quiz_fail_unparsable', '模型返回的内容不是有效题目，请重试（或换个更聚焦的库）。'),
    };
    const tip = texts[reason] || _tr('kb.workbench.quiz_generate_failed_dot', '测验生成失败，请稍后重试。');
    return '<div class="kb-mm-fail">' + tip
      + '<br>' + _uiButton({ label: _tr('kb.workbench.regenerate', '重新生成'), role: 'secondary', size: 'sm', icon: 'refresh', className: 'kb-quiz-retry-btn' })
      + '</div>';
  }

  /**
   * 参考答案/解析的切分：把"多要点"的长句拆成条目。
   *
   * 为什么拆：模型给的参考答案常是「要点A；要点B（补充说明）。」这种多要点句子，
   * 直接整段显示就是一大坨（真机反馈原文："匹配角色只需要一个API Key；发版清理时
   * 应以CSV文件为准（提示词内是速览，以CSV为准）。"）。按换行 / 分号 / 序号拆开列点，
   * 一眼能看出有几个要点。拆不动（单句）时原样返回，不做二次加工。
   */
  function _quizAnswerClauses(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return [];
    const parts = raw
      .replace(/\r\n?/g, '\n')
      // 编号式要点（1. / 2、/ 3)）前断开
      .replace(/(?:^|[ \t])(?=[1-9][.、)）]\s)/gm, '\n')
      .split('\n')
      // 分号即要点分隔（分号留在句尾，读起来更自然）
      .flatMap((line) => line.split(/(?<=[；;])\s*/))
      // 成了列表项就不该再拖个分号（那是句子里的分隔符，不是要点本身）
      .map((x) => x.replace(/^[1-9][.、)）]\s*/, '').replace(/[；;]\s*$/, '').trim())
      .filter(Boolean);
    // 拆不出多个要点时退回整段，不把一句话切碎
    return parts.length > 1 ? parts : [raw];
  }

  /** 生成测验 → 追加到对话消息区（kb-qa-messages）；成功后落 qaHistory 供会话恢复。 */
  function _genQuiz() {
    if (_quizGenerating) return; // 生成中防重复
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.quiz_unavailable', '测验服务不可用'), { variant: 'warning' });
      return;
    }
    _quizGenerating = true;
    const ai = document.createElement('div');
    ai.className = 'kb-qa-msg is-ai';
    const body = document.createElement('div');
    body.className = 'kb-qa-msg-body kb-quiz-msg';
    body.innerHTML = '<div class="kb-mm-msg-head">' + _icon('document-pencil') + ' ' + _esc(_tr('kb.workbench.quiz_title', '测验')) + '</div>'
      + `<div class="kb-quiz-canvas"><div class="kb-mm-loading">${_esc(_tr('kb.workbench.quiz_generating', '正在生成测验题（本地模型推理中，约 30–60 秒）…'))}</div></div>`;
    ai.appendChild(body);
    box.appendChild(ai);
    box.scrollTop = box.scrollHeight;
    const canvas = body.querySelector('.kb-quiz-canvas');
    const replaceCard = (html) => {
      ai.remove();
      const next = document.createElement('div');
      next.className = 'kb-qa-msg is-ai';
      const nb = document.createElement('div');
      nb.className = 'kb-qa-msg-body kb-quiz-msg';
      nb.innerHTML = html;
      next.appendChild(nb);
      box.appendChild(next);
      box.scrollTop = box.scrollHeight;
      return nb;
    };
    window.cogseed.invoke('kb.quiz', {
      dir: _state.spaceId ? null : (_state.currentLib || null),
      spaceId: _state.spaceId || null,
    })
      .then((res) => {
        _quizGenerating = false;
        const questions = Array.isArray(res && res.questions) ? res.questions : [];
        if (!res || res.source === 'degraded' || !questions.length) {
          const nb = replaceCard('<div class="kb-mm-msg-head">' + _icon('document-pencil') + ' ' + _esc(_tr('kb.workbench.quiz_title', '测验')) + '</div>'
            + '<div class="kb-quiz-canvas">' + _quizFailHtml(res && res.reason) + '</div>');
          nb.querySelector('.kb-quiz-retry-btn')?.addEventListener('click', () => {
            nb.parentElement?.remove();
            _genQuiz();
          });
          return;
        }
        const payload = {
          questions,
          sources: Array.isArray(res && res.sources) ? res.sources : [],
          fingerprint: String((res && res.fingerprint) || ''),
        };
        const nb = replaceCard(_quizLauncherHtml(payload));
        // 落进会话历史（题目随消息存着，没有独立存档），并**立刻持久化**：
        // 只 push 不保存的话切库/换会话/重开就没了（真机反馈：「刚生成的测验没进
        // 历史会话」）。缓存命中（cached）同样是一张真卡片，也要记。
        const entry = { role: 'assistant', kind: 'quiz', ...payload, ts: Date.now() };
        _state.qaHistory.push(entry);
        if (_state.qaHistory.length > 40) _state.qaHistory.splice(0, _state.qaHistory.length - 40);
        _qaSaveCurrentSession(_tr('kb.workbench.quiz_title', '测验'));
        _bindQuizLauncher(nb, entry);
        // 生成完直接进入答题界面（NotebookLM 也是生成即答），卡片留在会话里可随时重开
        _openQuizPanel(entry);
      })
      .catch(() => {
        _quizGenerating = false;
        const nb = replaceCard('<div class="kb-mm-msg-head">' + _icon('document-pencil') + ' ' + _esc(_tr('kb.workbench.quiz_title', '测验')) + '</div>'
          + `<div class="kb-quiz-canvas"><div class="kb-mm-fail">${_esc(_tr('kb.workbench.quiz_generate_failed', '测验生成失败，请稍后重试'))}</div></div>`);
        nb.querySelector('.kb-quiz-retry-btn')?.addEventListener('click', () => {
          nb.parentElement?.remove();
          _genQuiz();
        });
      });
  }

  /** 会话历史恢复：按存下来的题目重建测验缩略卡（点开进答题面板，题目随消息保存）。 */
  function _appendQuizMessage(box, m) {
    const questions = Array.isArray(m.questions) ? m.questions : [];
    const el = document.createElement('div');
    el.className = 'kb-qa-msg is-ai';
    const body = document.createElement('div');
    body.className = 'kb-qa-msg-body kb-quiz-msg';
    body.innerHTML = _quizLauncherHtml({
      questions,
      sources: Array.isArray(m.sources) ? m.sources : [],
      fingerprint: String(m.fingerprint || ''),
    });
    el.appendChild(body);
    box.appendChild(el);
    _bindQuizLauncher(body, m);
  }

  /**
   * 测验缩略卡：只做"入口 + 事实"，真正的答题/结果在 window.KbQuizPanel 面板里
   * （NotebookLM 的测验是独立工作面：逐题作答、提示、结果页、再测/新测）。
   */
  function _quizLauncherHtml(payload) {
    const questions = Array.isArray(payload && payload.questions) ? payload.questions : [];
    const singles = questions.filter((q) => q && q.type === 'single').length;
    const shorts = questions.length - singles;
    const sources = Array.isArray(payload && payload.sources) ? payload.sources.length : 0;
    const meta = [
      `${_tr('kb.quiz.card_count', '共 {n} 题', { n: questions.length })}`,
      ...(shorts ? [`${_tr('kb.quiz.card_mix', '单选 {s} · 简答 {q}', { s: singles, q: shorts })}`] : []),
      ...(sources ? [`${_tr('kb.quiz.card_sources', '{n} 个来源', { n: sources })}`] : []),
    ].join(' · ');
    return '<div class="kb-mm-msg-head">' + _icon('document-pencil') + ' ' + _esc(_tr('kb.quiz.card_title', '测验')) + '</div>'
      + '<div class="kb-quiz-canvas">'
      + `<div class="kb-quiz-meta">${_esc(meta)}</div>`
      + `<div class="kb-quiz-launch">${_uiButton({ label: _tr('kb.quiz.start', '开始答题'), role: 'primary', size: 'sm', icon: 'check-circle', className: 'kb-quiz-start-btn', attrs: { id: 'kb-quiz-start' } })}</div>`
      + '</div>';
  }

  /** 缩略卡 → 面板：卡片本身可点，按钮也绑一次（键盘/鼠标都到位）。 */
  function _bindQuizLauncher(scopeEl, entry) {
    const open = () => _openQuizPanel(entry);
    const btn = scopeEl.querySelector('#kb-quiz-start, .kb-quiz-start-btn');
    if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    const canvas = scopeEl.querySelector('.kb-quiz-canvas');
    if (canvas) canvas.addEventListener('click', open);
  }

  /**
   * 纯函数：从候选路径里挑出与该「来源名」匹配的那一个（"路径以该名结尾"，忽略大小写）。
   * 单独抽出来是为了能真跑单测（`__kbQuizSourceTest.resolvePath`），而不是只比对源码文本。
   */
  function _pickKbSourcePath(name, candidates) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return '';
    return (Array.isArray(candidates) ? candidates : [])
      .map((p) => String(p || ''))
      .find((p) => p.toLowerCase().endsWith(want)) || '';
  }

  /** 当前库的候选路径：空间库文件表 + 个人库树（两处都可能是空，调用方要判）。 */
  function _kbSourceCandidates() {
    const out = [];
    for (const f of (_state.spaceFiles || [])) if (f && f.path) out.push(String(f.path));
    const walk = (n) => {
      if (n && n.path) out.push(String(n.path));
      for (const c of (n && n.children) || []) walk(c);
    };
    walk({ children: _state.tree });
    return out;
  }

  /**
   * 把「来源」解析成知识库里的真实相对路径。
   *
   * 为什么必须有这一步：出题/溯源给回来的 source 常常只是**文件名**（"AAR复盘.md"），
   * 而库里存的是带目录的相对路径（"9.16产物/AAR复盘.md"）。主进程锚点解析是
   * `path.join(库根, 你给的路径)` 之后直接 stat —— 拿裸文件名去开，只会 ENOENT，
   * 查看器最后显示"暂时无法读取该文件的原文"（真机日志：
   * `anchor_resolver: extract failed { abs_path: 'AAR复盘.md' }`）。
   * 候选 = 当前库树 + 空间库文件表，按"路径以该名结尾"匹配（与脑图溯源同一套规则）。
   */
  function _resolveKbSourcePath(name) {
    if (!String(name || '').trim()) return '';
    return _pickKbSourcePath(name, _kbSourceCandidates());
  }

  /**
   * 测验「原文依据」→ 打开原文并锁定到片段。
   *
   * 先解析出真实路径（否则连文件都读不到），再走锚点通道 `_openFileViewerForAnchor`：
   * 纯文本（md/txt）会命中 charStart/charEnd → 查看器 `<mark>` 高亮 + 滚到该段；
   * PDF/Office 会解析出页码直接翻页。没有片段时退回"打开整篇"（`_openFile`）。
   */
  function _openQuizSource(rawSource, anchor) {
    const quote = anchor && typeof anchor.quote === 'string' ? anchor.quote.trim() : '';
    const candidates = _kbSourceCandidates();
    const matched = _pickKbSourcePath(rawSource, candidates);
    // 有候选但一个都不匹配 = 这份文档不在当前库里：别去开一个只会显示"不能读取原文"的
    // 查看器，如实说一句。候选为空（库树还没加载）时不做结论，仍按原样尽力打开。
    if (!matched && candidates.length) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.qa_source_missing', '没在当前知识库里找到来源文档：{name}', { name: String(rawSource || '') }), { variant: 'warning' });
      return 'missing';
    }
    const relPath = matched || String(rawSource || '');
    if (!relPath) return 'missing';
    if (!quote) return _openFile(relPath);
    const spaceId = _state.spaceId || '';
    return Promise.resolve(_openFileViewerForAnchor({
      source: 'library',
      scope: spaceId ? 'space' : 'global',
      path: relPath,
      quote,
      ...(spaceId ? { spaceId } : {}),
    })).then((ok) => (ok ? 'anchor' : _openFile(relPath)));
  }

  /** 打开测验面板：把"新题生成 / 打开来源 / 关闭"作为宿主能力交给面板。 */
  function _openQuizPanel(entry) {
    const panel = window.KbQuizPanel;
    if (!panel || typeof panel.open !== 'function') {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.quiz_panel_failed', '测验面板没能加载，请刷新后重试'), { variant: 'warning' });
      return;
    }
    panel.open({
      questions: Array.isArray(entry.questions) ? entry.questions : [],
      sources: Array.isArray(entry.sources) ? entry.sources : [],
      fingerprint: String(entry.fingerprint || ''),
      title: _tr('kb.quiz.panel_title', '{lib} · 测验', { lib: _state.spaceId ? (_state.spaceName || '共享库') : (_state.currentLib || _tr('kb.workbench.untitled_lib', '知识库')) }),
      dir: _state.spaceId ? null : (_state.currentLib || null),
      spaceId: _state.spaceId || null,
      host: {
        // 「生成后续测验」：同一份材料重新出题（force 绕过缓存），并把新题写回会话历史
        onRegenerate: () => window.cogseed.invoke('kb.quiz', {
          dir: _state.spaceId ? null : (_state.currentLib || null),
          spaceId: _state.spaceId || null,
          force: true,
        }).then((res) => {
          const questions = Array.isArray(res && res.questions) ? res.questions : [];
          if (!res || res.source === 'degraded' || !questions.length) return null;
          const next = {
            questions,
            sources: Array.isArray(res.sources) ? res.sources : [],
            fingerprint: String(res.fingerprint || ''),
          };
          entry.questions = next.questions;
          entry.sources = next.sources;
          entry.fingerprint = next.fingerprint;
          entry.ts = Date.now();
          _qaSaveCurrentSession(_tr('kb.workbench.quiz_title', '测验'));
          return next;
        }),
        onOpenSource: (path, anchor) => {
          if (!path) return false;
          _openQuizSource(String(path), anchor);
          return true;
        },
      },
    });
  }

  // 对话回答 → 脑图：基于本条回答文本生成（复用 kb.mindmap 的 text 参数）。
  // entry 是该回答在 qaHistory 里的消息对象：生成成功后把快照记到 entry.mm，
  // 使该回答的按钮变为「重新生成脑图」（可覆盖式再生成）。
  function _genMindmapFromText(text, btn, entry) {
    if (!text || !text.trim()) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_empty_answer', '回答内容为空，无法生成脑图'), { variant: 'warning' });
      return;
    }
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const anchor = btn && btn.parentElement ? btn.parentElement : null;
    // 覆盖式再生成：先移除该回答下已有的脑图预览，避免叠加
    if (anchor) {
      const old = anchor.querySelector('.kb-mm-msg');
      if (old) old.remove();
    }
    btn.disabled = true;
    const holder = document.createElement('div');
    holder.className = 'kb-mm-msg';
    holder.innerHTML = '<div class="kb-wb-mm-canvas">'
      + `<div class="kb-mm-loading">${_esc(_tr('kb.workbench.mm_generating_short', '正在生成脑图（本地模型推理中，约 10–30 秒）…'))}</div></div>`;
    if (anchor) anchor.appendChild(holder);
    const canvas = holder.querySelector('.kb-wb-mm-canvas');
    window.cogseed.invoke('kb.mindmap', { dir: null, spaceId: null, text })
      .then((res) => {
        btn.disabled = false;
        if (!res || !res.root) throw new Error('empty mindmap');
        // 「回答 → 脑图」的作用域必须显式归位为 text：否则会沿用上一次的 doc 作用域，
        // 让之后的"刷新/保存"跑到某一份文档上（作用域状态串味）。
        _state.mmScope = { doc: null, scope: 'text' };
        canvas._mmScope = _state.mmScope;
        if (res.source === 'degraded') {
          canvas.innerHTML = _mmDegradedHtml(res.reason);
          const retryBtn = canvas.querySelector('.kb-mm-retry-btn');
          if (retryBtn) retryBtn.addEventListener('click', () => {
            holder.remove();
            _genMindmapFromText(text, btn, entry);
          });
          return;
        }
        _state.lastMind = res.root;
        _mmResetFoldToDefault(res.root);
        _state.mmFocus = null;
        _state.mmSearchHits = new Set();
        canvas.innerHTML = _mmTreeSvg(res.root, _state.mmCollapsed, _mmRenderOpts());
        canvas._mmRoot = res.root;
        _bindMindCanvas(canvas);
        if (res.source === 'generated') {
          _setUiButtonPresentation(btn, _tr('kb.workbench.mm_regenerate', '重新生成脑图'), 'brain-circuit');
          btn.title = _tr('kb.workbench.mm_regenerate_answer_tip', '重新生成该回答的脑图');
          if (entry && typeof entry === 'object') _recordAnswerMindmap(res.root, entry);
          else _mmRecordToHistory(res.root);
        }
      })
      .catch(() => {
        btn.disabled = false;
        canvas.innerHTML = `<div class="kb-mm-fail">${_esc(_tr('kb.workbench.mm_generate_failed', '脑图生成失败，请稍后重试'))}</div>`;
      });
  }

  // 对话区脑图 = 缩略预览：点击 → 唤起弹窗（完整阅读/折叠/编辑/导出都在弹窗内）
  function _bindMindCanvas(canvas) {
    canvas.addEventListener('click', () => {
      // 历史里可能有多张脑图：优先打开当前画布对应的快照树
      if (canvas._mmRoot) _state.lastMind = canvas._mmRoot;
      // 作用域跟着画布走：弹窗里的"刷新/保存"必须作用在这张图真正的作用域上
      if (canvas._mmScope) _state.mmScope = canvas._mmScope;
      _openMindPreview();
    });
  }

  /**
   * 默认展开层级：**只展开根 + 一级分支**（所有"有子节点的节点"默认折叠），
   * 像 NotebookLM 的脑图那样先给一张骨架，点开哪一支再看哪一支的下一层。
   *
   * 为什么不默认全展开：一张 100+ 节点的图全展开后，节点会被压到只剩几个像素，
   * 用户必须先把图缩到看不清、再逐个放大才能读——顺序反了。先给骨架、按需逐层打开，
   * 首屏的信息密度才是"可读"的（每层节点的 +N 徽章也告诉用户"这里还有内容"）。
   *
   * 根节点永不折叠（否则首屏只剩一个孤点）；叶子没有子节点，不参与。
   */
  function _mmDefaultCollapsedFor(root) {
    const idxs = new Set();
    if (!root) return idxs;
    let idx = 0;
    const walk = (n, depth) => {
      const cur = idx++;
      const kids = n?.children || [];
      if (depth >= 1 && kids.length) idxs.add(cur);
      for (const c of kids) walk(c, depth + 1);
    };
    walk(root, 0);
    return idxs;
  }

  /** 新内容上场（生成 / 从历史或存档恢复 / 刷新）统一回到"骨架层"。 */
  function _mmResetFoldToDefault(root) {
    _state.mmCollapsed = _mmDefaultCollapsedFor(root);
  }

  // 折叠 / 展开节点（任意层级；数据驱动重渲染）
  function _mmToggleFold(idx) {
    if (_state.mmCollapsed.has(idx)) _state.mmCollapsed.delete(idx);
    else _state.mmCollapsed.add(idx);
    _rerenderMindmaps();
    // 收拢后画布收紧（折叠分支不再占位）：重新适应一次，避免留出大片空白
    if (_state.mmViewMode === 'graph') _mmFitToStage();
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
    _mmPinStageSvg();
    _bindPreviewNodes();
  }

  // 画布内 SVG 按 viewBox 固定像素尺寸：flex 居中与「适应画布」的缩放都以真实像素为基准。
  // 否则重渲染（折叠/搜索/背景/布局切换）后 SVG 回落到 .kb-mm-svg{width:100%;height:auto}，
  // 缩放基准变成画布宽度 → 图会缩放失真、偏出画布中心。
  function _mmPinStageSvg() {
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    const svg = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('svg') : null;
    if (!svg) return null;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width && vb.height) {
      if (svg.style) {
        svg.style.width = vb.width + 'px';
        svg.style.height = vb.height + 'px';
        svg.style.maxWidth = 'none';
        svg.style.maxHeight = 'none';
        svg.style.flex = 'none';
      }
    }
    return svg;
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
  // 原文查看器（kb-fv）：PDF/Office 走这里以保证排版与缩放（#214 曾把它删掉，
// 主进程 kb.openFile / kb-file:// 一直在，缺的就是这一层）；变量随查看器代码块一起恢复。
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
    _mmBindResize();
    _mmBindTitleDrag();
    // 先显示再套用尺寸/位置记忆：display:none 时量不到布局尺寸，居中位会被算成 0
    // （全程同步执行，同一帧内完成，不会看到窗口跳动）
    overlay.hidden = false;
    if (_mmController) _mmController.open(document.activeElement);
    _mmApplyWindowRect();
    _mmUpdateSaveState();
    _renderOverlay();
    const titleInput = document.getElementById('kb-mm-title-input');
    if (titleInput) titleInput.value = _state.spaceId ? _state.spaceName : (_state.currentLib || _tr('kb.workbench.untitled_lib', '知识库'));
    _mmUpdateSaveState();
    if (_state.mmViewMode === 'graph') {
      _mmPinStageSvg();
      _mmFitToStage();
    }
    _mmUpdateToolbarState();
  }

  // 打开弹窗时隐藏对话区缩略脑图卡，避免"两个悬浮窗"叠加（关闭时恢复）
  /** 关闭媒体管理器：优先走共享 controller（释放焦点陷阱并归还焦点），无 controller 时退回自管隐藏。 */
  function _mmClose() {
    const overlay = document.getElementById('kb-mm-overlay');
    if (!overlay) return;
    if (_mmController && _mmController.isOpen()) _mmController.close('close');
    else {
      overlay.hidden = true;
      _mmRestoreThumbs();
    }
  }

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
        // 尺寸变化后窗口可能越出视口：按新尺寸重新夹取偏移，保证仍完整可见
        const off = _mmWindowOffset();
        const clamped = _mmClampWindowOffset(off.x, off.y);
        _mmSetWindowOffset(clamped.x, clamped.y);
        _mmFitToStage();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('kb-wb-resizing');
        _mmSaveWindowRect();
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
      el.textContent = '● ' + _tr('kb.workbench.mm_unsaved', '未保存');
      el.className = 'kb-mm-save-state is-dirty';
    } else {
      el.innerHTML = `${_icon('check')} ${_esc(_tr('kb.workbench.mm_saved', '已保存'))}`;
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
    if (btn) {
      _setUiButtonPresentation(btn, _mmPreviewMode ? _tr('kb.workbench.mm_edit', '编辑') : _tr('kb.workbench.mm_preview', '预览'), _mmPreviewMode ? 'edit-pencil' : 'eye');
      btn.setAttribute('aria-pressed', String(_mmPreviewMode));
    }
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
      { k: 'fit', label: _tr('kb.workbench.mm_fit_tip', '适应画布'), icon: 'maximize', fn: () => _mmFitToStage() },
      { k: 'center', label: _tr('kb.workbench.mm_center_root', '居中根节点'), icon: 'target', fn: () => _mmCenterNode(0) },
      { k: 'center-window', label: _tr('kb.workbench.mm_center_window', '窗口居中'), icon: 'panel-collapse', fn: () => _mmCenterWindow() },
      { k: 'copy', label: _tr('kb.workbench.mm_copy_svg', '复制 SVG'), icon: 'copy', fn: () => _mmCopySvg() },
    ];
    menu.innerHTML = items.map((it) => `<div class="kb-mm-more-item" data-more="${it.k}">${_icon(it.icon, 'kb-mm-menu-icon')}<span>${it.label}</span></div>`).join('');
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
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_popout_none', '暂无可弹出的脑图'), { variant: 'warning' });
      return;
    }
    try {
      const svg = _mmTreeSvg(root, new Set(), _mmRenderOpts());
      // 独立窗口：SVG 撑满窗口内容盒，靠 preserveAspectRatio（默认 xMidYMid meet）居中缩放。
      // 此前 body 用 flex 居中 + min-height:100vh，图比窗口大时会被裁掉左上角且无法滚动（看着就没居中）。
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(_tr('kb.workbench.mm_title', '脑图预览'))}</title><style>html,body{height:100%}body{margin:0;box-sizing:border-box;padding:24px;background:#fff}svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`;
      const res = await window.cogseed.invoke('kb.mindmap.popout', { html });
      if (res && res.ok === false && typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_popout_unavailable', '独立窗口暂不可用'), { variant: 'info' });
    } catch (err) {
      _log.warn('mindmap popout failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_popout_unavailable', '独立窗口暂不可用'), { variant: 'info' });
    }
  }
  function _mmBindTitleDrag() {
    const bar = document.getElementById('kb-mm-titlebar');
    const dlg = document.getElementById('kb-mm-dlg');
    if (!bar || !dlg || bar.dataset.dragBound) return;
    bar.dataset.dragBound = '1';
    let sx = 0, sy = 0;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('input,button')) return;
      e.preventDefault();
      sx = e.clientX; sy = e.clientY;
      const start = _mmWindowOffset(); // 从当前视觉偏移起拖，位移量直接累加
      const onMove = (ev) => {
        const off = _mmClampWindowOffset(start.x + (ev.clientX - sx), start.y + (ev.clientY - sy));
        _mmSetWindowOffset(off.x, off.y);
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

  // ── 窗口位置：一律以「居中位 + translate 偏移」表达 ──
  // 居中由 .kb-mm-overlay 的 flex 布局负责（窗口始终先落在正中），用户拖动只改 translate。
  // 此前把记忆里的视口坐标直接写成 position:relative 的 left/top，会与居中位叠加：
  // 每开一次窗口就再往右下推一次，最终只在屏幕角落露出一角——这正是「窗口没在正中央」的根因。
  const _MM_RECT_KEY = 'cogseed.kb-mm.rect';
  // v1 的 x/y 语义（视口坐标）与写入方式（left/top 相对偏移）混在一起，旧值无法区分真假 → 一律作废并清除
  const _MM_RECT_VERSION = 2;
  function _mmDlgEl() { return document.getElementById('kb-mm-dlg'); }
  function _mmWindowOffset() {
    const dlg = _mmDlgEl();
    const m = dlg ? /^(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px$/.exec(String(dlg.style.translate || '').trim()) : null;
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
  }
  // 居中位与尺寸取布局值：offsetLeft/offsetWidth 不受 transform/translate 与淡入动画影响，量得准
  function _mmWindowBox() {
    const dlg = _mmDlgEl();
    if (!dlg) return null;
    return { x: dlg.offsetLeft || 0, y: dlg.offsetTop || 0, w: dlg.offsetWidth || 0, h: dlg.offsetHeight || 0 };
  }
  function _mmSetWindowOffset(x, y) {
    const dlg = _mmDlgEl();
    if (!dlg) return;
    dlg.style.left = ''; dlg.style.top = ''; dlg.style.margin = ''; // 清掉历史脏值，避免与居中位再叠加
    dlg.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  }
  // 夹取偏移，保证窗口**完整**落在视口内（此前只夹到"露出 200×100"，窗口能跑到屏幕外）
  function _mmClampWindowOffset(x, y) {
    const box = _mmWindowBox();
    if (!box || !box.w || !box.h) return { x, y };
    const maxX = Math.max(0, window.innerWidth - box.w - box.x);
    const maxY = Math.max(0, window.innerHeight - box.h - box.y);
    return { x: Math.max(-box.x, Math.min(x, maxX)), y: Math.max(-box.y, Math.min(y, maxY)) };
  }
  // 回到屏幕正中（更多菜单「窗口居中」）：清掉位置记忆，并顺手保尺寸
  function _mmCenterWindow() {
    _mmSetWindowOffset(0, 0);
    try { localStorage.removeItem(_MM_RECT_KEY); } catch { /* 无 localStorage */ }
    _mmSaveWindowRect();
  }
  // 打开弹窗时应用位置/尺寸记忆；无有效记忆 → 保持 CSS 默认（78vw×80vh，flex 居中）
  function _mmApplyWindowRect() {
    const dlg = _mmDlgEl();
    if (!dlg) return;
    _mmSetWindowOffset(0, 0); // 先归中：后续测量与越界兜底都以居中位为基准
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(_MM_RECT_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.v !== _MM_RECT_VERSION) {
      if (saved) { try { localStorage.removeItem(_MM_RECT_KEY); } catch { /* 无 localStorage */ } }
      _mmApplyWindowSize();
      return; // 记不住的旧值 → 居中显示
    }
    if (Number.isFinite(saved.w) && Number.isFinite(saved.h) && saved.w > 0 && saved.h > 0) {
      dlg.style.width = Math.max(560, Math.min(saved.w, window.innerWidth - 40)) + 'px';
      dlg.style.height = Math.max(400, Math.min(saved.h, window.innerHeight - 40)) + 'px';
    } else {
      _mmApplyWindowSize();
    }
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
    const box = _mmWindowBox();
    if (!box) return;
    const off = _mmClampWindowOffset(saved.x - box.x, saved.y - box.y);
    _mmSetWindowOffset(off.x, off.y);
  }
  function _mmSaveWindowRect() {
    try {
      const box = _mmWindowBox();
      if (!box || !box.w || !box.h) return;
      const off = _mmWindowOffset();
      localStorage.setItem(_MM_RECT_KEY, JSON.stringify({
        v: _MM_RECT_VERSION,
        w: Math.round(box.w), h: Math.round(box.h),
        x: Math.round(box.x + off.x), y: Math.round(box.y + off.y), // 视口绝对坐标
      }));
    } catch { /* ignore */ }
  }

  // 当前脑图的存档 key（与主进程 mindKey 对齐）。
  // 文档级脑图必须存到 `doc:<路径>`，否则"本文档脑图"会被存进整个库的档位里，
  // 下次打开这个库看到的却是某一份文档的脑图。
  function _mmCurrentKey() {
    const s = _state.mmScope;
    if (s && s.doc && s.scope === 'doc') return `doc:${s.doc}`;
    return _state.spaceId ? `space:${_state.spaceId}` : `dir:${_state.currentLib || 'global'}`;
  }

  // 保存：把当前脑图存入用户数据目录，下次打开本库可直接读取
  function _mmSaveMindmap() {
    const root = _state.lastMind;
    if (!root || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_save_none', '暂无可保存的脑图'), { variant: 'warning' });
      return;
    }
    const key = _mmCurrentKey();
    const isDoc = key.startsWith('doc:');
    window.cogseed.invoke('kb.mindmap.save', { key, root })
      .then((r) => {
        if (r && r.ok) {
          _mmMarkSaved();
          if (typeof uiToast === 'function') {
            uiToast(isDoc ? _tr('kb.workbench.mm_saved_to_doc', '脑图已保存到这份文档') : _tr('kb.workbench.mm_saved_to_lib', '脑图已保存到知识库（下次打开可直接读取）'), { variant: 'success' });
          }
        } else if (typeof uiToast === 'function') {
          uiToast(_tr('kb.workbench.save_failed_short', '保存失败'), { variant: 'warning' });
        }
      })
      .catch(() => { if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.save_failed_short', '保存失败'), { variant: 'warning' }); });
  }

  // ⟳ 刷新：强制重新生成脑图（不走缓存）。**沿用当前作用域**——文档级脑图刷新后
  // 仍是这份文档的脑图，不会被悄悄换成整库脑图（真机会话里这样错配过）。
  function _mmRefreshMindmap() {
    if (_mmGenerating) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const s = _state.mmScope;
    if (s && s.scope === 'text') {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_refresh_no_source', '这张脑图来自对话回答，无法重新生成'), { variant: 'warning' });
      return;
    }
    _mmGenerating = true;
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    if (wrap) wrap.innerHTML = `<div class="kb-mm-fail" style="color:var(--kb-muted,#6E8578)">${_esc(_tr('kb.workbench.mm_regenerating', '正在重新生成脑图（本地模型推理中，约 30–60 秒，长文档最长约 3 分钟）…'))}</div>`;
    window.cogseed.invoke('kb.mindmap', (s && s.doc)
      ? { doc: s.doc, force: true }
      : {
        dir: _state.spaceId ? null : (_state.currentLib || null),
        spaceId: _state.spaceId || null,
        force: true,
      })
      .then((res) => {
        _mmGenerating = false;
        if (!res || !res.root) throw new Error('empty mindmap');
        // 与首次生成同一套作用域回执校验：主进程没按本文档生成就丢弃结果
        if (s && s.doc && res.scope !== 'doc') {
          const w = document.getElementById('kb-mm-overlay-wrap');
          if (w) {
            w.innerHTML = _esc(_tr('kb.workbench.mm_refresh_scope_mismatch_dot', '主进程未按「本文档」作用域重新生成（返回：{scope}），已丢弃。请完全退出 CogSeed 后重启再试。', { scope: res.scope || _tr('kb.workbench.unknown', '未知') }))
              + `<div class="kb-mm-refresh-hint" style="font-size:12px;margin-top:8px">${_esc(_tr('kb.workbench.mm_original_kept', '原脑图已保留，未受影响'))}</div></div>`;
          }
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_refresh_scope_mismatch', '重新生成未按本文档作用域，已保留原脑图'), { variant: 'warning' });
          return;
        }
        if (res.source === 'degraded') {
          const wrap = document.getElementById('kb-mm-overlay-wrap');
          if (wrap) {
            wrap.innerHTML = _mmDegradedHtml(res.reason)
              + `<div class="kb-mm-refresh-hint" style="color:var(--kb-muted,#6E8578);font-size:12px;margin-top:8px">${_esc(_tr('kb.workbench.mm_original_kept', '原脑图已保留，未受影响'))}</div>`;
            const retryBtn = wrap.querySelector('.kb-mm-retry-btn');
            if (retryBtn) retryBtn.addEventListener('click', _mmRefreshMindmap);
          }
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_refresh_incomplete', '重新生成未完成，已保留原脑图'), { variant: 'warning' });
          return;
        }
        _state.lastMind = res.root;
        _state.mmScope = (s && s.doc) ? { doc: s.doc, scope: 'doc' } : { doc: null, scope: res.scope || 'dir' };
        _mmResetFoldToDefault(res.root);
        _state.mmFocus = null;
        _state.mmSearchHits = new Set();
        _rerenderMindmaps();
        _mmFitToStage();
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_refreshed', '脑图已重新生成'), { variant: 'success' });
      })
      .catch(() => {
        _mmGenerating = false;
        _rerenderMindmaps();
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_refresh_failed', '重新生成失败，请稍后重试'), { variant: 'warning' });
      });
  }

  // 存档：列出已保存脑图，点击载入预览
  function _mmFillOpenMenu() {
    const menu = document.getElementById('kb-mm-open-menu');
    if (!menu) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      menu.innerHTML = `<div class="kb-mm-open-item is-empty">${_esc(_tr('kb.workbench.mm_archive_unavailable_dot', '存档服务不可用'))}</div>`;
      return;
    }
    window.cogseed.invoke('kb.mindmap.list').then((r) => {
      // 历史快照（key 含 '#'）只随会话历史还原，不混进手动存档列表
      const items = (r && Array.isArray(r.items) ? r.items : [])
        .filter((m) => !String(m.key || '').includes('#'))
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      if (!items.length) {
        menu.innerHTML = `<div class="kb-mm-open-item is-empty">${_esc(_tr('kb.workbench.mm_archive_empty', '还没有保存的脑图'))}</div>`;
        return;
      }
      menu.innerHTML = items.map((m) => {
        const d = new Date(m.savedAt || Date.now());
        const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const pretty = m.key.startsWith('space:') ? _tr('kb.workbench.mm_scope_space', '共享空间 {name}', { name: m.key.slice(6) }) : _tr('kb.workbench.mm_scope_lib', '个人库 {name}', { name: m.key.slice(4) });
        return `<div class="kb-mm-open-item" data-key="${_esc(m.key)}">${_icon('brain-circuit', 'kb-mm-menu-icon')}<span class="kb-mm-open-item-name">${_esc(pretty)}</span><span class="kb-mm-open-item-time">${time}</span></div>`;
      }).join('');
      menu.querySelectorAll('.kb-mm-open-item[data-key]').forEach((el) => {
        el.addEventListener('click', () => {
          menu.hidden = true;
          _mmLoadMindmap(el.dataset.key);
        });
      });
    }).catch(() => {
      menu.innerHTML = `<div class="kb-mm-open-item is-empty">${_esc(_tr('kb.workbench.mm_archive_read_failed', '读取存档失败'))}</div>`;
    });
  }

  function _mmLoadMindmap(key) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    window.cogseed.invoke('kb.mindmap.load', { key })
      .then((r) => {
        if (!r || !r.ok || !r.root) {
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_archive_missing', '存档不存在或已损坏'), { variant: 'warning' });
          return;
        }
        _state.lastMind = r.root;
        // 载入存档同样要记住作用域：文档级存档（doc:）刷新/再保存时不能退回整库
        const isDocKey = key.startsWith('doc:');
        _state.mmScope = isDocKey
          ? { doc: key.slice(4).split('#')[0], scope: 'doc' }
          : { doc: null, scope: key.startsWith('space:') ? 'space' : 'dir' };
        const titleEl = document.getElementById('kb-mm-title-input');
        const overlay = document.getElementById('kb-mm-overlay');
        if (titleEl && overlay) {
          overlay.hidden = false;
          if (_mmController) _mmController.open(document.activeElement);
          const scopeLabel = key.startsWith('space:')
            ? _tr('kb.workbench.mm_scope_space', '共享空间 {name}', { name: key.slice(6) })
            : isDocKey
              ? _tr('kb.workbench.mm_scope_file', '文档 {name}', { name: String(key.slice(4).split('#')[0]).split('/').pop() })
              : _tr('kb.workbench.mm_scope_lib', '个人库 {name}', { name: key.slice(4) });
          titleEl.textContent = _tr('kb.workbench.mm_title_saved', '脑图预览 - {scope}（已保存）', { scope: scopeLabel });
        }
        _rerenderMindmaps();
        _mmFitToStage();
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_loaded', '已载入保存的脑图'), { variant: 'success' });
      })
      .catch(() => { if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_load_failed', '载入失败'), { variant: 'warning' }); });
  }

  // 预览层内：节点点击=逐层展开/聚焦；徽章点击=折叠；双击节点重命名
  function _bindPreviewNodes() {
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    const root = _state.lastMind;
    if (!wrap || !root) return;
    wrap.querySelectorAll('.kb-mm-node').forEach((el) => {
      const depth = Number(el.dataset.depth || 0);
      const hasKids = Number(el.dataset.children || 0) > 0;
      const idx = Number(el.dataset.mmIdx);
      // 渐进展开（任意层级）：徽章点击 = 折叠/展开；**折叠态下点节点主体 = 展开这一层**。
      // 这条监听必须最先注册并用 stopImmediatePropagation 截断——否则同一次点击还会
      // 命中后面的"聚焦/跳来源"监听（折叠节点点一下又跳原文，用户会莫名其妙）。
      if (hasKids) {
        el.addEventListener('click', (e) => {
          const onBadge = !!(e.target && e.target.closest && e.target.closest('.kb-mm-fold-badge'));
          if (onBadge || _state.mmCollapsed.has(idx)) {
            e.stopImmediatePropagation();
            _mmToggleFold(idx); // 内部已含"结构变化后重新适应画布"
          }
        });
        el.style.cursor = 'pointer';
      }
      if (depth === 1) {
        // 一级分支（已展开时）：主体点击 = 聚焦/取消聚焦该分支
        el.addEventListener('click', (e) => {
          e.stopPropagation();
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
            ? await uiPrompt(_tr('kb.workbench.mm_rename_node', '重命名节点：'), _mmLabelAt(root, idx))
            : window.prompt(_tr('kb.workbench.mm_rename_node', '重命名节点：'), _mmLabelAt(root, idx));
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
        _mmExpandPathTo(idx); // 折叠态下先展开到该节点，否则图里没有落点
        _renderOverlay();
        _mmFitToStage();
        _mmCenterNode(idx);
      });
    });
  }

  /**
   * 展开到指定节点：把"根 → 该节点"这条祖先链从折叠集里移除。
   *
   * 默认是骨架态（所有非叶子都折叠），所以"大纲点深层行 / 搜索命中深层节点"必须先
   * 展开路径，否则目标节点根本不在图里——`_mmCenterNode` 找不到元素会静默什么都不做，
   * 用户以为点击失效。
   */
  function _mmExpandPathTo(idx) {
    const root = _state.lastMind;
    if (!root || Number.isNaN(idx)) return false;
    let cur = 0;
    const path = [];
    let found = false;
    const walk = (n) => {
      const me = cur++;
      path.push(me);
      if (me === idx) { found = true; return true; }
      for (const c of (n.children || [])) if (walk(c)) return true;
      path.pop();
      return false;
    };
    walk(root);
    if (!found) return false;
    let changed = false;
    for (const i of path) if (_state.mmCollapsed.delete(i)) changed = true;
    return changed;
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
    // viewBox 原点不在 (0,0)（mind 布局最左分支会伸到负 x）：要减掉原点，否则偏移差一个 minX，节点落不到画布正中
    const vbX = vb && Number.isFinite(vb.x) ? vb.x : 0;
    const vbY = vb && Number.isFinite(vb.y) ? vb.y : 0;
    let bbox;
    try { bbox = el.getBBox(); } catch (_) { return; }
    if (!bbox || !bbox.width) return;
    const sx = bbox.x + bbox.width / 2;
    const sy = bbox.y + bbox.height / 2;
    _mmZoom = Math.max(_mmZoom, Math.min(1.4, Math.max(1, Math.min((stage.clientWidth || 800) / (bbox.width + 120), (stage.clientHeight || 600) / (bbox.height + 90)))));
    _mmPanX = -((sx - vbX) - svgW / 2) * _mmZoom;
    _mmPanY = -((sy - vbY) - svgH / 2) * _mmZoom;
    _applyMmTransform();
  }

  // ── 大纲视图（图形/文本双视图切换）──
  function _mmOutlineLines(root) {
    const lines = [];
    let idx = 0;
    const walk = (n, depth) => {
      const cur = idx++;
      lines.push({ label: String(n?.label || ''), source: n?.source || '', depth, idx: cur, childCount: (n?.children || []).length });
      if ((n.children || []).length && _state.mmCollapsed.has(cur)) return; // 折叠的分支不展开（任意层级）
      for (const c of (n?.children || [])) walk(c, depth + 1);
    };
    walk(root, 0);
    return lines;
  }

  function _mmOutlineHtml(root) {
    const lines = _mmOutlineLines(root).map((ln) => {
      const hit = _state.mmSearchHits && _state.mmSearchHits.has(ln.idx) ? ' kb-mm-outline-row--hit' : '';
      const src = ln.source ? ` <span class="kb-mm-outline-src">${_icon('file-text')} ${_esc(ln.source)}</span>` : '';
      const icon = ln.depth === 0 ? _icon('brain-circuit', 'kb-mm-outline-ico') : ln.depth === 1 ? '▸' : '·';
      return `<div class="kb-mm-outline-row${hit}" data-mm-idx="${ln.idx}" style="padding-left:${16 + ln.depth * 22}px">${ln.depth === 0 ? '' : `<span class="kb-mm-outline-dot"></span>`}<span class="kb-mm-outline-label">${icon} ${_esc(ln.label)}</span>${src}</div>`;
    }).join('');
    return `<div class="kb-mm-outline">${lines || `<div class="kb-mm-outline-empty">${_esc(_tr('kb.workbench.mm_outline_empty', '（空脑图）'))}</div>`}</div>`;
  }

  function _mmOutlineMd(root) {
    const lines = _mmOutlineLines(root).map((ln) => {
      const prefix = ln.depth === 0 ? '# ' : '  '.repeat(ln.depth - 1) + '- ';
      const src = ln.source ? _tr('kb.workbench.mm_outline_source', ' （来源：{source}）', { source: ln.source }) : '';
      return prefix + ln.label + src;
    });
    return `# ${_tr('kb.workbench.mm_outline_heading', '脑图大纲')}\n\n${lines.join('\n')}\n`;
  }

  function _mmExportMd() {
    const root = _state.lastMind;
    if (!root) return;
    const md = _mmOutlineMd(root);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mindmap-${_tr('kb.workbench.mm_outline_heading', '脑图大纲')}-${Date.now()}.md`; a.click();
    URL.revokeObjectURL(url);
    if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_export_md_done', '已导出 Markdown 大纲'), { variant: 'success' });
  }

  function _mmPdfHtml() {
    const svg = _mmCurrentSvg();
    if (!svg) return '';
    const titleEl = document.getElementById('kb-mm-title-input');
    const title = titleEl ? titleEl.textContent.replace(/^\s+/, '') : _tr('kb.workbench.mm_default_title', '知识库脑图');
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif}h1{font-size:15px;padding:14px 18px 6px;color:#14281E;border-bottom:1px solid #E5EDE8}svg{width:100%;height:auto}</style></head><body><h1>${_esc(title)}</h1>${new XMLSerializer().serializeToString(clone)}</body></html>`;
  }

  function _mmExportPdf() {
    if (!_mmNeedGraph()) return;
    const html = _mmPdfHtml();
    if (!html || !window.cogseed || typeof window.cogseed.invoke !== 'function') {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_pdf_unavailable', 'PDF 导出暂不可用'), { variant: 'warning' });
      return;
    }
    window.cogseed.invoke('kb.mindmap.exportPdf', { html })
      .then((r) => {
        if (r && r.ok) { if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_pdf_done', 'PDF 已导出'), { variant: 'success' }); }
        else if (r && r.canceled) { /* 用户取消 */ }
        else if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_pdf_failed', 'PDF 导出失败'), { variant: 'warning' });
      })
      .catch(() => { if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_pdf_failed', 'PDF 导出失败'), { variant: 'warning' }); });
  }

  /** 全部展开：清空折叠集 → 整图铺开（结构巨变，必须重新适应画布）。 */
  function _mmExpandAll() {
    if (!_state.lastMind) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_generate_first', '请先生成脑图'), { variant: 'info' });
      return;
    }
    _state.mmCollapsed.clear();
    _rerenderMindmaps();
    if (_state.mmViewMode === 'graph') _mmFitToStage();
  }

  /**
   * 全部收拢：回到"骨架层"（根 + 一级分支）= 与默认初始态一致。
   *
   * 幂等是有意为之：默认初始态就是收拢的，再按一次应当"维持收拢"。
   * （旧实现在"已全折叠"时会反过来全部展开，用来提示用户"点了有反应"；
   * 默认折叠后那条规则会把首次点击变成"全部铺开"，与按钮语义正好相反，故移除。）
   */
  function _mmCollapseAll() {
    const root = _state.lastMind;
    if (!root) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_generate_first', '请先生成脑图'), { variant: 'info' });
      return;
    }
    if (!_mmDefaultCollapsedFor(root).size) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_no_branches', '当前脑图没有可折叠的分支'), { variant: 'info' });
      return;
    }
    _mmResetFoldToDefault(root);
    _rerenderMindmaps();
    if (_state.mmViewMode === 'graph') _mmFitToStage();
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
      if (hint) hint.textContent = _tr('kb.workbench.mm_outline_tip', '点击行可跳转到对应节点 · 折叠的分支不展开');
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
      const first = [...hits][0];
      // 默认骨架态下命中节点可能被折叠隐藏：先展开路径再定位，否则"搜索了但看不到"
      if (_mmExpandPathTo(first)) _rerenderMindmaps();
      if (_state.mmViewMode === 'outline') {
        _state.mmViewMode = 'graph';
        _mmUpdateToolbarState();
        _renderOverlay();
        _mmFitToStage();
        _mmCenterNode(first);
      } else {
        _mmCenterNode(first);
      }
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_hits', '匹配 {count} 个节点', { count: hits.size }), { variant: 'info' });
    }
  }

  // 溯源：点击带来源的节点 → 跳转知识库原文片段
  function _mmOpenSource(source, idx) {
    const name = String(source || '');
    if (!name) return;
    if (typeof window.__openAnchorViewer === 'function') {
      // 与测验「原文依据」共用同一个"来源名 → 库内真实路径"解析（裸文件名很常见）
      const hit = _resolveKbSourcePath(name);
      if (hit) {
        // 与列表点击同一条分派：排版类（pdf/office/html/图片）走富查看器保排版，
        // 文本类才回落原文查看器（原先这里一律走文本查看器，PDF 来源跳转就丢排版）。
        // 来源只给了"文档名"（没有片段依据）⇒ 打开整篇，不带 chunkIdx。
        _openFileViewerForAnchor({
          source: _state.spaceId ? 'space' : 'library',
          scope: _state.spaceId ? 'space' : 'global',
          path: hit,
          ...(_state.spaceId ? { spaceId: _state.spaceId } : {}),
        });
        return;
      }
      return;
    }
    if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_source_missing', '未在知识库中找到来源文档：{name}', { name }), { variant: 'warning' });
  }

  // 工具栏状态同步（布局/聚焦/背景/大纲按钮）
  function _mmUpdateToolbarState() {
    const focusBtn = document.getElementById('kb-mm-focus-btn');
    if (focusBtn) {
      const on = _state.mmFocus !== null;
      focusBtn.classList.toggle('is-active', on);
      focusBtn.title = on ? _tr('kb.workbench.mm_focus_on_tip', '点击一级分支切换聚焦分支 · 点此取消聚焦') : _tr('kb.workbench.mm_focus_off_tip', '聚焦分支：点击一级分支只看该分支');
      focusBtn.setAttribute('aria-pressed', String(on));
      _setUiButtonPresentation(focusBtn, on ? _tr('kb.workbench.mm_focused', '聚焦中') : _tr('kb.workbench.mm_focus', '聚焦'), 'target');
    }
    const layoutBtn = document.getElementById('kb-mm-layout-btn');
    if (layoutBtn) _setUiButtonPresentation(layoutBtn, _state.mmMode === 'org' ? _tr('kb.workbench.mm_org', '组织结构') : _tr('kb.workbench.mm_mind', '思维导图'), 'layout-grid');
    const bgBtn = document.getElementById('kb-mm-bg-btn');
    if (bgBtn) {
      const names = { dots: _tr('kb.workbench.mm_bg_dots', '点阵'), plain: _tr('kb.workbench.mm_bg_plain', '纯白'), none: _tr('kb.workbench.mm_bg_none', '无') };
      _setUiButtonPresentation(bgBtn, names[_state.mmBg] || _tr('kb.workbench.mm_bg', '背景'), 'palette');
      bgBtn.title = _tr('kb.workbench.mm_bg_tip', '背景切换（点阵/纯白/无）');
    }
    const outlineBtn = document.getElementById('kb-mm-outline-btn');
    if (outlineBtn) {
      const on = _state.mmViewMode === 'outline';
      outlineBtn.classList.toggle('is-active', on);
      outlineBtn.setAttribute('aria-pressed', String(on));
    }
    const dotsBtn = document.getElementById('kb-mm-dots-btn');
    if (dotsBtn) {
      const on = _state.mmBg === 'dots';
      dotsBtn.classList.toggle('is-active', on);
      dotsBtn.setAttribute('aria-pressed', String(on));
    }
    const hint = document.querySelector('#kb-mm-overlay-stage .kb-mm-overlay-stage-hint');
    if (hint) {
      hint.textContent = _state.mmViewMode === 'outline'
        ? _tr('kb.workbench.mm_outline_tip', '点击行可跳转到对应节点 · 折叠的分支不展开')
        : _tr('kb.workbench.mm_canvas_tip', '滚轮缩放 · 拖拽平移 · 一级分支点击聚焦 · −/+ 折叠 · 双击重命名');
    }
  }

  // 打开/点击「适应」时：按弹窗视口自动缩放，脑图填满大部分画布（不再过小）
  function _mmFitToStage() {
    const stage = document.getElementById('kb-mm-overlay-stage');
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    const svg = _mmPinStageSvg();
    if (!stage || !wrap || !svg) return;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const svgW = vb && vb.width ? vb.width : (svg.style && svg.style.width ? parseFloat(svg.style.width) : 1200);
    const svgH = vb && vb.height ? vb.height : (svg.style && svg.style.height ? parseFloat(svg.style.height) : 800);
    // 以画布内容盒为准：stage 的 clientWidth 含 12px 内边距，会把图算大 ~3% 而略微溢出
    const stW = wrap.clientWidth || stage.clientWidth || 800;
    const stH = wrap.clientHeight || stage.clientHeight || 600;
    const scale = Math.min(stW / svgW, stH / svgH) * 0.92;
    _mmZoom = Math.max(0.15, Math.min(2.5, scale));
    _mmPanX = 0; _mmPanY = 0; // 平移归零：图正落画布中心
    _applyMmTransform();
  }

  function _applyMmTransform() {
    const wrap = document.getElementById('kb-mm-overlay-wrap');
    // 平移写在缩放外面：px 就是屏幕像素，拖拽 1:1 跟手，_mmCenterNode 的"逻辑位移×zoom"也对得上。
    // 写成 scale() translate() 的话平移量会被再乘一次 zoom（拖拽变迟钝、居中偏一半）。
    if (wrap) wrap.style.transform = `translate(${_mmPanX}px, ${_mmPanY}px) scale(${_mmZoom})`;
    const label = document.getElementById('kb-mm-zoom-label');
    if (label) label.textContent = Math.round(_mmZoom * 100) + '%';
  }

  // ── 脑图导出（SVG / PNG / PDF / Markdown / 剪贴板）──
  function _mmCurrentSvg() {
    return document.querySelector('#kb-mm-overlay-wrap svg');
  }
  function _mmNeedGraph() {
    if (_state.mmViewMode === 'outline') {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_switch_to_graph', '请先切回图形视图再导出图片'), { variant: 'info' });
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
        .then(() => { if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_svg_copied', '已复制脑图 SVG'), { variant: 'success' }); })
        .catch(() => { if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.mm_svg_copy_failed', '复制失败（剪贴板不支持 SVG）'), { variant: 'warning' }); });
    } else if (typeof uiToast === 'function') {
      uiToast(_tr('kb.workbench.clipboard_unsupported', '当前环境不支持剪贴板复制'), { variant: 'warning' });
    }
  }

  // ── 多级水平树脑图（双向放射/组织结构图、分支成套色系、紧凑列布局、卡片式节点）──
  // 成套色系：每分支一套 deep/mid/light/ink。deep 只给连线、色条、徽章描边；light 给一级分支底色；
  // ink 是"在 light 上仍然可读"的深色文字色（原来一级分支用 deep 实心填充 + 白字，整屏重色块，很"脏"）。
  const KB_MM_PALETTES = [
    { deep: '#0E9F6E', mid: '#6FC79F', light: '#EAF7F1', ink: '#096B47' }, // 绿
    { deep: '#2563EB', mid: '#7BA4F3', light: '#EBF1FE', ink: '#1D4ED8' }, // 蓝
    { deep: '#B4469F', mid: '#D08BC6', light: '#FBEFF8', ink: '#8E2F7F' }, // 品红（降饱和）
    { deep: '#C2740C', mid: '#E0A85C', light: '#FCF3E6', ink: '#96570A' }, // 琥珀
    { deep: '#0D9488', mid: '#63C2BA', light: '#E8F6F4', ink: '#0B7A70' }, // 青
  ];
  const KB_MM_ROOT = '#0B7A52';
  const KB_MM_INK = '#1F3A2E';      // 二级节点正文
  const KB_MM_INK_SOFT = '#456054'; // 三级及以下正文
  const KB_MM_LINE = '#E1E9E4';     // 卡片描边
  const KB_MM_LINE_SOFT = '#EAF0EC';

  // 字号层级：根 > 一级 > 二级 > 三级（叶子最小）
  function _mmFontSize(depth) {
    if (depth === 0) return 16;
    if (depth === 1) return 13;
    if (depth === 2) return 12.5;
    return 12;
  }

  // 单字宽度估算：中日韩/全角按 1em，拉丁词按字宽查表。
  // 原实现用"字符数 × 字号 × 1.02"估算，对英文/数字严重高估 → 11 个汉字的标签就被折成两行
  // （"文字折叠"的根因），而英文标签又留出大片空白。
  function _mmCharW(ch, size) {
    const code = ch.codePointAt(0) || 0;
    const wide = (code >= 0x1100 && code <= 0x115f)
      || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    if (wide) return size;
    if (ch === ' ') return size * 0.3;
    if (/[iIljtfr.,:;!'|]/.test(ch)) return size * 0.33;
    if (/[A-Z0-9]/.test(ch)) return size * 0.64;
    return size * 0.54;
  }
  function _mmTextW(text, size) {
    let w = 0;
    for (const ch of String(text || '')) w += _mmCharW(ch, size);
    return w;
  }

  // 换行：按真实字宽切行，优先在标点/空格处断；拉丁词不拦腰断；最多两行，剩下用省略号。
  function _mmWrap(text, size, maxW) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return { lines: [''], truncated: false };
    if (_mmTextW(raw, size) <= maxW) return { lines: [raw], truncated: false };
    const MAX_LINES = 2;
    const breakChars = /[\s，。；、,.!?：:;()（）\-—/·]/;
    const lines = [];
    let rest = raw;
    while (rest && lines.length < MAX_LINES) {
      if (_mmTextW(rest, size) <= maxW) { lines.push(rest); rest = ''; break; }
      let cut = 0, acc = 0, lastBreak = 0;
      for (const ch of rest) {
        const cw = _mmCharW(ch, size);
        if (acc + cw > maxW) break;
        acc += cw;
        cut += ch.length;
        if (breakChars.test(ch)) lastBreak = cut;
      }
      if (cut === 0) cut = Math.min(rest.length, 1);
      // 非末行优先在标点/空格处断（末行要留给省略号，尽量占满）
      if (lines.length < MAX_LINES - 1 && lastBreak > 0 && lastBreak < cut) cut = lastBreak;
      lines.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) {
      let last = lines[lines.length - 1] || '';
      while (last && _mmTextW(last + '…', size) > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
      return { lines, truncated: true };
    }
    return { lines, truncated: false };
  }

  // 节点尺寸：宽度随文本自适应（上限随层级放宽），高度按行数（单行 35 / 双行 52 附近）
  const KB_MM_MAXW = [300, 250, 276, 276];
  function _mmDims(label, depth) {
    const size = _mmFontSize(depth);
    const maxNodeW = KB_MM_MAXW[depth] === undefined ? 276 : KB_MM_MAXW[depth];
    const { lines, truncated } = _mmWrap(String(label || ''), size, maxNodeW - 30);
    const textW = lines.reduce((m, l) => Math.max(m, _mmTextW(l, size)), 0);
    const minW = depth === 0 ? 104 : 78;
    const w = Math.round(Math.min(maxNodeW, Math.max(minW, textW + (depth === 0 ? 40 : 30))));
    const lineH = Math.round(size * 1.38);
    const h = lines.length * lineH + 18;
    return { lines, truncated, w, h, lineH, size };
  }

  function _mmPalette(branch) {
    return branch === undefined || branch === null ? KB_MM_PALETTES[0] : KB_MM_PALETTES[branch % KB_MM_PALETTES.length];
  }

  // 渲染选项（模式/聚焦/搜索命中/背景）统一取自 state
  function _mmRenderOpts() {
    return { mode: _state.mmMode || 'mind', focus: _state.mmFocus, highlight: _state.mmSearchHits, bg: _state.mmBg || 'dots' };
  }

  // 布局常量：列间距（连线空间）、叶子行高、画布留白
  const KB_MM_COL_GAP = 68;
  const KB_MM_ROW = 54;
  const KB_MM_PAD_X = 56;
  const KB_MM_PAD_Y = 40;

  // 布局：mind=双向放射（一级分支左右分摊）；org=组织结构图（单向向右）
  function _mmTreeSvg(root, collapsed, opts) {
    collapsed = collapsed || new Set();
    opts = opts || {};
    const mode = opts.mode === 'org' ? 'org' : 'mind';
    const focus = opts.focus === undefined || opts.focus === null ? null : Number(opts.focus);
    const highlight = opts.highlight instanceof Set ? opts.highlight : new Set();
    const bg = opts.bg || 'dots';

    // 1) 建树 + 量尺寸（此时还没有坐标）
    const list = []; // {label, source, depth, branch, dir, kids, idx, childCount, w, h, lines, x, y}
    const weight = (n) => (n && n.children && n.children.length ? n.children.reduce((a, c) => a + weight(c), 0) : 1);
    const build = (n, depth, branch, dir) => {
      const label = String(n?.label || '');
      const node = {
        label, source: n?.source || '', depth, branch, dir, kids: [],
        idx: list.length, childCount: (n?.children || []).length,
        ..._mmDims(label, depth),
      };
      list.push(node);
      const kids = n?.children || [];
      if (depth === 0) {
        // 一级分支：mind 模式按权重折半左右分摊，org 模式全部向右
        const weights = kids.map((k) => weight(k));
        const total = weights.reduce((a, b) => a + b, 0) || 1;
        let acc = 0;
        kids.forEach((k, i) => {
          const side = mode === 'mind' && acc + weights[i] <= total / 2 + 1e-6 ? -1 : 1;
          acc += weights[i];
          node.kids.push(build(k, depth + 1, i, side));
        });
        return node;
      }
      kids.forEach((k) => node.kids.push(build(k, depth + 1, branch, dir)));
      return node;
    };
    const rootNode = build(root, 0, 0, 1);
    const maxDepth = list.reduce((m, n) => Math.max(m, n.depth), 0);

    // 折叠节点：其整棵子树不占位（收拢后脑图收紧，不留大片空档）。
    // 2026-09-16：由"只支持一级分支折叠"放开为**任意层级**——渐进展开要求
    // "点一层开一层"，二级/三级节点也必须能被折叠，否则展开一级分支时会把整支
    // 一次炸开（4 层图直接铺满窗口），退回"全展开才看得清"的老问题。
    const hidden = new Set();
    const hideSubtree = (n) => { for (const c of n.kids) { hidden.add(c.idx); hideSubtree(c); } };
    const walkCollapse = (n) => {
      for (const c of n.kids) {
        if (collapsed.has(c.idx)) hideSubtree(c);
        walkCollapse(c);
      }
    };
    walkCollapse(rootNode);

    // 2) 横向：每层列宽按该层最宽的节点算，列中心逐列累加（不再固定 300 的列距 → 图不再横向拉长）
    const colMax = { '-1': {}, 1: {} };
    for (const n of list) {
      if (n.depth === 0) continue;
      const key = String(n.dir);
      colMax[key][n.depth] = Math.max(colMax[key][n.depth] || 0, n.w);
    }
    const columnXs = (sideDir) => {
      const key = String(sideDir);
      const xs = { 0: 0 };
      let cursor = rootNode.w / 2;
      for (let d = 1; d <= maxDepth; d++) {
        const cw = colMax[key][d] || 0;
        if (!cw) { xs[d] = xs[d - 1] || 0; continue; }
        cursor += KB_MM_COL_GAP + cw / 2;
        xs[d] = sideDir * cursor;
        cursor += cw / 2;
      }
      return xs;
    };
    const xsLeft = columnXs(-1);
    const xsRight = columnXs(1);
    for (const n of list) {
      if (n.depth === 0) { n.x = 0; continue; }
      n.x = (n.dir < 0 ? xsLeft : xsRight)[n.depth] || 0;
    }

    // 3) 纵向：左右两侧各自排行，父节点对齐子节点中点（行高固定 → 疏密均匀）
    //    两侧共用一套行号的话，图高 = 全部叶子数 × 行高，画布被拉得又高又窄、缩放被迫变小；
    //    两侧各自排行后，图高只由"较满的一侧"决定，字号能大 30% 左右。
    let rowLeft = 0;
    let rowRight = 0;
    const place = (n) => {
      const kids = n.kids.filter((c) => !hidden.has(c.idx));
      if (!kids.length) {
        n.y = (n.dir < 0 ? rowLeft++ : rowRight++) * KB_MM_ROW;
        return n.y;
      }
      const ys = kids.map(place);
      n.y = (ys[0] + ys[ys.length - 1]) / 2;
      return n.y;
    };
    place(rootNode);

    // 两侧纵向跨度对齐到同一中轴（否则左右长短不一时，根节点会明显偏离画布中线）
    const visible = list.filter((n) => !hidden.has(n.idx));
    const sideSpan = (dir) => {
      const ns = visible.filter((n) => n.depth > 0 && n.dir === dir);
      if (!ns.length) return null;
      const top = Math.min(...ns.map((n) => n.y - n.h / 2));
      const bottom = Math.max(...ns.map((n) => n.y + n.h / 2));
      return (top + bottom) / 2;
    };
    const midL = sideSpan(-1);
    const midR = sideSpan(1);
    const mid = (midL !== null && midR !== null) ? (midL + midR) / 2 : (midL !== null ? midL : midR) || 0;
    if (mid) for (const n of visible) n.y -= mid;
    rootNode.y = 0;

    // 4) 画布范围：按可见节点包围盒 + 等宽留白（左右留白必须一致，否则整图被推向一侧）
    const minX = Math.min(...visible.map((n) => n.x - n.w / 2)) - KB_MM_PAD_X;
    const maxX = Math.max(...visible.map((n) => n.x + n.w / 2)) + KB_MM_PAD_X + 12; // 右侧给折叠徽章留位
    const minY = Math.min(...visible.map((n) => n.y - n.h / 2)) - KB_MM_PAD_Y;
    const maxY = Math.max(...visible.map((n) => n.y + n.h / 2)) + KB_MM_PAD_Y;
    const svgW = Math.max(360, maxX - minX);
    const svgH = Math.max(280, maxY - minY);
    const fc = (v) => (Math.round(v * 100) / 100).toString();

    // 5) 连线：父节点边缘 → 子节点边缘，两端留短横段，视觉上"接得住"节点
    const edges = [];
    const walkE = (n) => { for (const c of n.kids) { if (!hidden.has(c.idx)) edges.push([n, c]); walkE(c); } };
    walkE(rootNode);
    const edgeSvg = edges.map(([a, b]) => {
      const pal = _mmPalette(b.branch);
      const ax = a.x + a.dir * (a.w / 2 + 1);
      const bx = b.x - b.dir * (b.w / 2 + 1);
      const stub = Math.min(20, Math.max(8, Math.abs(bx - ax) / 3));
      const sx = ax + a.dir * stub;
      const ex = bx - b.dir * stub;
      const mid = (sx + ex) / 2;
      const width = a.depth === 0 ? 2.2 : a.depth === 1 ? 1.7 : 1.3;
      const op = a.depth === 0 ? 0.55 : a.depth === 1 ? 0.42 : 0.3;
      return `<path class="kb-mm-edge" d="M ${fc(ax)} ${fc(a.y)} L ${fc(sx)} ${fc(a.y)} C ${fc(mid)} ${fc(a.y)}, ${fc(mid)} ${fc(b.y)}, ${fc(ex)} ${fc(b.y)} L ${fc(bx)} ${fc(b.y)}" fill="none" stroke="${pal.deep}" stroke-width="${width}" stroke-opacity="${op}" stroke-linecap="round"/>`;
    }).join('');

    // 6) 节点：卡片式（根=实心品牌绿；一级=浅底色+色条；二三级=白卡片+细描边），字号/行高统一
    const nodeSvg = visible.map((n) => {
      const pal = _mmPalette(n.branch);
      const style = n.depth === 0
        ? { fill: KB_MM_ROOT, stroke: KB_MM_ROOT, sw: 0, text: '#FFFFFF', weight: 700, shadow: true, radius: 12 }
        : n.depth === 1
          ? { fill: pal.light, stroke: pal.deep, sw: 1.4, text: pal.ink, weight: 650, shadow: false, radius: 9 }
          : n.depth === 2
            ? { fill: '#FFFFFF', stroke: KB_MM_LINE, sw: 1, text: KB_MM_INK, weight: 550, shadow: true, radius: 8 }
            : { fill: '#FFFFFF', stroke: KB_MM_LINE_SOFT, sw: 1, text: KB_MM_INK_SOFT, weight: 450, shadow: true, radius: 8 };
      const w = n.w, h = n.h;
      const x = n.x - w / 2;
      const y = n.y - h / 2;
      // 有子节点且被折叠（任意层级都算）→ 画 +N 徽章，表示"这里还有一层，点开看"
      const folded = n.childCount > 0 && collapsed.has(n.idx);
      const badgeX = n.x + n.dir * (w / 2 + 10);
      const dim = focus !== null && n.depth >= 1 && n.branch !== focus;
      const hit = highlight.has(n.idx);
      const extra = (folded ? ' kb-mm-node--folded' : '') + (dim ? ' kb-mm-node--dim' : '') + (hit ? ' kb-mm-node--hit' : '');

      const hitRing = hit
        ? `<rect x="${x - 5}" y="${y - 5}" width="${w + 10}" height="${h + 10}" rx="${style.radius + 3}" fill="none" stroke="#F59E0B" stroke-width="2" stroke-dasharray="5 3"/>`
        : '';
      const accent = n.depth === 1
        ? `<rect x="${fc(n.dir > 0 ? x + 2 : x + w - 5)}" y="${fc(y + 8)}" width="3" height="${fc(h - 16)}" rx="1.5" fill="${pal.deep}"/>`
        : '';
      // 有来源的节点：前缘一个小圆点（原先用 emoji 挤在角上，很花）
      const srcDot = n.source && n.depth >= 2
        ? `<circle cx="${fc(n.dir > 0 ? x + 7 : x + w - 7)}" cy="${fc(n.y)}" r="2.4" fill="${pal.mid}"/>`
        : '';
      const foldBadge = folded
        ? `<circle class="kb-mm-fold-badge" cx="${fc(badgeX)}" cy="${fc(n.y)}" r="8" fill="#FFFFFF" stroke="${pal.deep}" stroke-width="1.2"/><text class="kb-mm-fold-badge" x="${fc(badgeX)}" y="${fc(n.y + 3.6)}" text-anchor="middle" font-size="10" font-weight="600" fill="${pal.ink}">+${n.childCount}</text>`
        : (n.childCount > 0 && n.depth >= 1
          ? `<circle class="kb-mm-fold-badge" cx="${fc(badgeX)}" cy="${fc(n.y)}" r="8" fill="#FFFFFF" stroke="${pal.mid}" stroke-width="1.2"/><text class="kb-mm-fold-badge" x="${fc(badgeX)}" y="${fc(n.y + 4)}" text-anchor="middle" font-size="11" font-weight="600" fill="${KB_MM_INK_SOFT}">−</text>`
          : '');
      const textLines = n.lines.map((ln, i) =>
        `<tspan x="${fc(n.x)}" dy="${fc(i === 0 ? -((n.lines.length - 1) / 2) * n.lineH + n.size * 0.36 : n.lineH)}" font-size="${n.size}">${_esc(ln)}</tspan>`).join('');
      return `<g class="kb-mm-node${extra}" data-depth="${n.depth}" data-mm-idx="${n.idx}" data-branch="${n.branch ?? -1}" data-dir="${n.dir}" data-folded="${folded ? '1' : '0'}" data-children="${n.childCount}"${n.source ? ` data-source="${_esc(n.source)}"` : ''}${dim ? ' opacity="0.16"' : ''}>
        ${hitRing}
        <rect x="${fc(x)}" y="${fc(y)}" width="${fc(w)}" height="${fc(h)}" rx="${style.radius}" fill="${style.fill}" stroke="${style.stroke}"${style.sw ? ` stroke-width="${style.sw}"` : ''}${style.shadow ? ' filter="url(#kb-mm-card-shadow)"' : ''}/>
        ${accent}
        ${srcDot}
        <text x="${fc(n.x)}" y="${fc(n.y)}" text-anchor="middle" font-weight="${style.weight}" fill="${style.text}">${textLines}</text>
        ${foldBadge}
        ${n.source ? `<title>${_esc(n.source)}</title>` : ''}
      </g>`;
    }).join('');

    // 7) 背景与阴影（点阵/纯白/无；卡片阴影只定义一次）
    const defs = '<defs>'
      + '<filter id="kb-mm-card-shadow" x="-24%" y="-48%" width="148%" height="196%">'
      + '<feDropShadow dx="0" dy="1.4" stdDeviation="1.8" flood-color="#0B2A1E" flood-opacity="0.10"/>'
      + '</filter>'
      + (bg === 'dots'
        ? '<pattern id="kb-mm-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="rgba(20,40,30,0.055)"/></pattern>'
        : '')
      + '</defs>';
    const bgSvg = bg === 'none'
      ? ''
      : bg === 'plain'
        ? `<rect x="${fc(minX)}" y="${fc(minY)}" width="${fc(svgW)}" height="${fc(svgH)}" fill="#FBFDFC"/>`
        : `<rect x="${fc(minX)}" y="${fc(minY)}" width="${fc(svgW)}" height="${fc(svgH)}" fill="url(#kb-mm-dots)"/>`;
    return `<svg class="kb-mm-svg" viewBox="${fc(minX)} ${fc(minY)} ${fc(svgW)} ${fc(svgH)}" xmlns="http://www.w3.org/2000/svg">${defs}${bgSvg}${edgeSvg}${nodeSvg}</svg>`;
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
      _state.qaSessions.unshift({ id: _state.qaSessionId, title: String(firstQuestion || _tr('kb.workbench.qa_history_untitled', '新对话')).slice(0, 30), msgs, ts: now });
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
    if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.qa_new_session_done', '已新建对话'), { variant: 'info' });
  }
  // 载入历史会话：恢复消息区 + 上下文（脑图消息按 kind 走快照读档渲染）
  function _qaLoadSession(id) {
    const s = _state.qaSessions.find((x) => x.id === id);
    if (!s) return;
    _state.qaSessionId = id;
    const migrated = (s.msgs || []).map((m) => {
      if (m && m.kind === 'mindmap') {
        return { role: m.role, content: m.content, kind: 'mindmap', key: m.key, label: m.label, ts: m.ts };
      }
      // 测验消息：题目就存在消息里（没有独立存档），载入必须带上——否则会话里
      // 只剩一条空回答（真机反馈：「刚生成的测验没进历史会话」的第二个原因：
      // 这里曾把所有非脑图消息都重建成 {role,content}，quiz 连同题目一起被丢掉）。
      if (m && m.kind === 'quiz') {
        const questions = Array.isArray(m.questions) ? m.questions.slice(0, 20) : [];
        return questions.length ? { role: m.role || 'assistant', kind: 'quiz', questions, ts: m.ts } : null;
      }
      return {
        role: m.role,
        content: m.content,
        ...(Array.isArray(m.evidence) && m.evidence.length ? { evidence: m.evidence } : {}),
        ...(m.mm && m.mm.key ? { mm: m.mm } : {}),
      };
    }).filter(Boolean);
    _state.qaHistory = migrated;
    _clearQa();
    const box = document.getElementById('kb-qa-messages');
    if (!box) return;
    // 上一个 AI 回答（供老会话的独立脑图气泡就近挂回所属回答）
    let prevAi = null;
    const refreshAiMm = (ai) => {
      const btn = ai.row.querySelector('.kb-qa-mm-btn');
      if (btn) {
        _setUiButtonPresentation(btn, _tr('kb.workbench.mm_regenerate', '重新生成脑图'), 'brain-circuit');
        btn.title = _tr('kb.workbench.mm_regenerate_answer_tip', '重新生成该回答的脑图');
      }
      if (ai.msg.mm && ai.msg.mm.key) _qaSnapshotInto(ai.row, ai.msg.mm.key);
    };
    let legacyAttached = false;
    const nextMsgs = [];
    for (const m of _state.qaHistory) {
      if (m.kind === 'quiz') {
        nextMsgs.push(m);
        _appendQuizMessage(box, m);
        prevAi = null;
        continue;
      }
      if (m.kind === 'mindmap') {
        // 老会话兼容：该脑图就近挂到它前面那条“还没有脑图”的回答，按钮变「重新生成脑图」
        if (prevAi && prevAi.msg && !(prevAi.msg.mm && prevAi.msg.mm.key)) {
          prevAi.msg.mm = { key: m.key, label: m.label || '', ts: m.ts };
          refreshAiMm(prevAi);
          legacyAttached = true;
          continue; // 已并入该回答，不再作为独立气泡/历史条目
        }
        nextMsgs.push(m);
        _appendMindmapMessage(box, m);
        continue;
      }
      nextMsgs.push(m);
      const el = document.createElement('div');
      el.className = m.role === 'user' ? 'kb-qa-msg is-user' : 'kb-qa-msg is-ai';
      const body = document.createElement('div');
      body.className = 'kb-qa-msg-body';
      if (m.role === 'user') body.textContent = m.content || '';
      else body.innerHTML = _decorateAnswerHtml(m.content || '', m.evidence);
      el.appendChild(body);
      prevAi = null;
      // 历史恢复：AI 回答重建引用 chips 与「生成脑图/重新生成脑图」按钮
      if (m.role === 'assistant') {
        if (Array.isArray(m.evidence) && m.evidence.length) el.appendChild(_qaRefsElement(m.evidence));
        const mmRow = _qaMmButtonRow(m.content || '', m);
        el.appendChild(mmRow);
        if (m.mm && m.mm.key) _qaSnapshotInto(mmRow, m.mm.key);
        prevAi = { row: mmRow, msg: m };
      }
      box.appendChild(el);
    }
    if (legacyAttached) {
      // 老会话结构顺带迁移为“回答内联脑图”，持久化后下次直接按 mm 读取
      _state.qaHistory = nextMsgs;
      _qaSaveCurrentSession();
    }
    _maybeShowQaHint();
  }
  // 历史面板：会话列表（新建/切换/删除）
  let _qaHistoryCleanup = null;
  function _qaOpenHistory() {
    _qaLoadSessions();
    if (_qaHistoryCleanup) _qaHistoryCleanup(false);
    let panel = document.getElementById('kb-qa-history-panel');
    if (panel) { panel.remove(); panel = null; }
    panel = document.createElement('div');
    panel.className = 'kb-qa-history-panel';
    panel.id = 'kb-qa-history-panel';
    panel.innerHTML = `
      <div class="kb-qa-history-head">
        <span>${_esc(_tr('kb.workbench.qa_history', '会话历史'))}</span>
        ${_uiIconButton({ label: _tr('kb.workbench.qa_history_close', '关闭会话历史'), icon: 'x', className: 'kb-qa-history-close' })}
      </div>
      ${_uiButton({ label: _tr('kb.workbench.qa_new_session', '新建对话'), role: 'secondary', size: 'sm', icon: 'plus', className: 'kb-qa-history-new', attrs: { id: 'kb-qa-history-new' } })}
      <div class="kb-qa-history-list">${_state.qaSessions.length
        ? _state.qaSessions.map((s) => `<div class="kb-qa-history-item${s.id === _state.qaSessionId ? ' is-active' : ''}" data-hist-id="${_esc(s.id)}">
            <span class="kb-qa-history-title">${_esc(s.title || _tr('kb.workbench.qa_history_untitled', '新对话'))}</span>
            <span class="kb-qa-history-meta">${_esc(_tr('kb.workbench.qa_history_meta', '{count} 条 · {time}', { count: s.msgs ? s.msgs.length : 0, time: _qaFmtTime(s.ts) }))}</span>
            ${_uiIconButton({ label: _tr('kb.workbench.qa_history_delete', '删除会话'), icon: 'trash-2', variant: 'danger', className: 'kb-qa-history-del', attrs: { 'data-hist-del': s.id } })}
          </div>`).join('')
        : _uiEmptyState({ kind: 'quiet', title: _tr('kb.workbench.qa_history_empty', '暂无历史对话') })}
      </div>`;
    document.body.appendChild(panel);
    const trigger = document.getElementById('kb-qa-history');
    function closePanel(restoreFocus = true) {
      document.removeEventListener('keydown', onHistoryKeydown);
      panel.remove();
      if (_qaHistoryCleanup === closePanel) _qaHistoryCleanup = null;
      if (restoreFocus) trigger?.focus();
    }
    function onHistoryKeydown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closePanel();
    }
    _qaHistoryCleanup = closePanel;
    document.addEventListener('keydown', onHistoryKeydown);
    panel.querySelector('.kb-qa-history-close').addEventListener('click', () => closePanel());
    const newSessionBtn = panel.querySelector('#kb-qa-history-new');
    newSessionBtn.addEventListener('click', () => { closePanel(false); _qaNewSession(); });
    newSessionBtn.focus();
    panel.querySelectorAll('[data-hist-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-hist-del]')) return;
        _qaLoadSession(el.dataset.histId);
        closePanel(false);
      });
    });
    panel.querySelectorAll('[data-hist-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.histDel;
        const gone = _state.qaSessions.find((x) => x.id === id);
        _state.qaSessions = _state.qaSessions.filter((x) => x.id !== id);
        if (_state.qaSessionId === id) { _state.qaSessionId = null; _state.qaHistory = []; _clearQa(); }
        // 删除会话时同步清理其脑图快照存档（kind='mindmap' 独立消息 + 答案内联 mm）
        if (gone && window.cogseed && typeof window.cogseed.invoke === 'function') {
          (gone.msgs || []).forEach((m) => {
            if (!m) return;
            const key = (m.kind === 'mindmap' && m.key) || (m.mm && m.mm.key);
            if (key) window.cogseed.invoke('kb.mindmap.delete', { key }).catch(() => { /* ignore */ });
          });
        }
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

  function _copyText(text, okMsg) {
    const done = () => {
      if (typeof uiToast === 'function') uiToast(okMsg || _tr('kb.workbench.copied', '已复制'), { variant: 'success', timeoutMs: 1500 });
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch { /* 复制失败静默 */ }
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  }

  // 引用区 = 底部「资料来源」折叠区：路径等宽小字，行内不打断正文，机器/溯源用途
  function _qaRefsElement(evidence) {
    const box = document.createElement('div');
    box.className = 'kb-qa-src';
    const n = evidence.length;
    const toggle = _elementFromHtml(_uiButton({
      label: _tr('kb.workbench.qa_sources', '资料来源 · {count}', { count: n }),
      role: 'ghost',
      size: 'sm',
      iconEnd: 'chevron-down',
      className: 'kb-qa-src-toggle',
      attrs: { 'aria-expanded': 'false' },
    }));
    const list = document.createElement('div');
    list.className = 'kb-qa-src-list';
    list.hidden = true;
    const setLabel = (open) => {
      _setUiButtonPresentation(toggle, _tr('kb.workbench.qa_sources', '资料来源 · {count}', { count: n }), open ? 'chevron-up' : 'chevron-down');
      toggle.setAttribute('aria-expanded', String(open));
    };
    setLabel(false);
    for (const r of evidence) {
      const row = document.createElement('div');
      row.className = 'kb-qa-src-row';
      const pathBtn = _elementFromHtml(_uiButton({
        label: `${r.path}#chunk ${r.chunkIdx}`,
        role: 'ghost',
        size: 'sm',
        className: 'kb-qa-src-path',
        attrs: { title: _tr('kb.workbench.qa_jump_source', '跳转到原文') },
      }));
      pathBtn.addEventListener('click', () => _openAnchor(r));
      const copy = _elementFromHtml(_uiIconButton({
        label: _tr('kb.workbench.qa_copy_ref_path', '复制引用路径'),
        icon: 'copy',
        className: 'kb-qa-src-copy',
      }));
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        _copyText(`${r.path}#chunk ${r.chunkIdx}`, _tr('kb.workbench.qa_ref_path_copied', '已复制引用路径'));
      });
      row.appendChild(pathBtn);
      row.appendChild(copy);
      list.appendChild(row);
    }
    toggle.addEventListener('click', () => {
      list.hidden = !list.hidden;
      setLabel(!list.hidden);
    });
    box.appendChild(toggle);
    box.appendChild(list);
    return box;
  }

  function _qaMmButtonRow(answerText, entry) {
    const row = document.createElement('div');
    row.className = 'kb-qa-mm-action';
    const hasMm = !!(entry && entry.mm && entry.mm.key);
    const btn = _elementFromHtml(_uiButton({
      label: hasMm ? _tr('kb.workbench.mm_regenerate', '重新生成脑图') : _tr('kb.workbench.gen_mindmap', '生成脑图'),
      role: 'primary',
      size: 'sm',
      icon: 'brain-circuit',
      className: 'kb-qa-mm-btn',
      attrs: { title: hasMm ? _tr('kb.workbench.mm_regenerate_answer_tip', '重新生成该回答的脑图') : _tr('kb.workbench.mm_answer_tip', '基于本条回答内容生成脑图') },
    }));
    btn.addEventListener('click', () => _genMindmapFromText(answerText, btn, entry));
    row.appendChild(btn);
    return row;
  }

  // ── 回答正文：行内引用 chip + 统一 Markdown 渲染 ────────────────────────
  //
  // 契约（2026-09 验收修订）：**正文里的引用要看得见、点得开**——模型标注的
  // `path#chunk N` 还原成行内可点 chip（`来源：1 ↗`），点击直接打开原文并定位；
  // 底部「资料来源」折叠区同时保留（机器/溯源用途）。
  //
  // 历史：#191 曾把行内引用整体删掉、只留底部折叠区，结果正文里既看不到引用、
  // 又残留 `[来源：1]()` 空壳（URL 被掏空、点不动），验收单据此判为缺陷。
  //
  // 解析分三层——因为「路径」没有可靠边界（真实路径含中文与空格，如
  // `external/feishu-wiki/SM 的交接.md`，而中文正文之间无词边界）：
  //   • 语法自带边界的形态（markdown 链接 / 括号 / 反引号 / 【】）→ 整体识别；
  //   • 裸锚点 → 只认 ASCII 路径集（中文正文因此天然不会被吞）；
  //   • 中文与含空格路径交给证据索引（final 阶段拿得到 evidence）精确匹配。
  //
  // 解析不出来的锚点（模型自创、不在证据里）**不留 chip**——宁可删掉也不给
  // 一个点开是"找不到"的死 chip。
  const _CITE_LABEL = '(?:来源|引用|source)';
  // 标签 + 括号包裹的锚点（全/半角、圆/方括号）
  const _CITE_LABEL_PAREN_RE = new RegExp(
    `${_CITE_LABEL}\\s*[：:]?\\s*\\d*\\s*[【\\[（(][^】\\]）)\\n]*#chunk\\s*\\d+[^】\\]）)\\n]*[】\\]）)]`, 'gi');
  // 【…锚点…】
  const _CITE_BRACKET_RE = /【[^】\n]*?#chunk\s*\d+[^】\n]*?】/g;
  // markdown 链接/图片：[label](target)——语法有界；非引用链接原样交给渲染管线
  const _CITE_LINK_RE = /!?\[([^\]\n]*)\]\(\s*([^)\n]*)\)/g;
  // 反引号包裹的锚点（允许路径含空格）
  const _CITE_TICK_RE = /`([^`\n]*?#chunk\s*\d+)`/g;
  // 裸锚点：ASCII 路径集，不吞中文正文
  const _CITE_BARE_RE = /([A-Za-z0-9][A-Za-z0-9._/-]*)#chunk\s*(\d+)/g;
  // chip 占位符：markdown 不会改写 `⟦…⟧`，渲染后再换成真 chip HTML
  const _citeToken = (i) => `⟦KBCITE:${i}⟧`;

  /**
   * 证据索引：锚点文本变体（全路径 + 文件名，口径对齐主进程 kb_qa.isAnchorCited）
   * → 证据条目。长串优先，避免短串（文件名）先命中而留下路径尾巴。
   */
  function _citationVariants(evidence) {
    const out = [];
    for (const r of evidence || []) {
      const p = String((r && r.path) || '');
      if (!p) continue;
      const base = p.slice(p.lastIndexOf('/') + 1);
      for (const name of [p, base]) {
        out.push([`${name}#chunk ${r.chunkIdx}`, r]);
        out.push([`${name}#chunk${r.chunkIdx}`, r]);
      }
    }
    out.sort((a, b) => b[0].length - a[0].length);
    return out;
  }

  /** 行内引用 chip：可点 → 打开原文并定位该 chunk。 */
  function _citeChipHtml(ref, label) {
    const path = String(ref.path || '');
    const chunkIdx = Number(ref.chunkIdx) || 0;
    const text = String(label || '').trim() || path.slice(path.lastIndexOf('/') + 1);
    const title = `${path}#chunk ${chunkIdx} — 打开原文`;
    return '<button type="button" class="kb-qa-chip kb-qa-cite" data-kb-cite="1"'
      + ` data-cite-path="${_esc(path)}" data-cite-chunk="${chunkIdx}"`
      + ` data-cite-scope="${_esc(ref.scope || 'global')}"`
      + ` data-cite-source="${_esc(ref.source || 'library')}"`
      + (ref.spaceId ? ` data-cite-space="${_esc(ref.spaceId)}"` : '')
      + ` title="${_esc(title)}">${_esc(text)} ↗</button>`;
  }

  /**
   * 把正文里的引用锚点换成 chip 占位符。
   * 返回 { text, chips }：text 交给 markdown 渲染，chips[i] 对应占位符 i。
   * 只有在证据索引里命中的锚点才出 chip —— 模型自创路径、或流式阶段尚未拿到
   * evidence 的，一律不留（宁可不显示，也不给点开是"找不到"的死 chip）。
   */
  function _chipifyCitationAnchors(text, evidence) {
    const variants = _citationVariants(evidence); // [[anchorText, ref], …]，长串优先
    const byAnchor = new Map();
    for (const [anchor, ref] of variants) if (!byAnchor.has(anchor)) byAnchor.set(anchor, ref);

    const chips = [];
    const emit = (anchorText, label) => {
      const ref = byAnchor.get(String(anchorText || '').trim());
      if (!ref) return '';
      const token = _citeToken(chips.length);
      chips.push(_citeChipHtml(ref, label));
      return token;
    };
    /** 从"标签+括号"或"【】"整段里取回锚点原文。 */
    const anchorIn = (whole, excluded) => {
      const m = new RegExp(`([^\\s${excluded}]*#chunk\\s*\\d+)`).exec(whole);
      return m ? m[1] : '';
    };

    let t = String(text || '');
    // ① 有界形态：标签+括号 / 【】 / markdown 链接 / 反引号
    t = t.replace(_CITE_LABEL_PAREN_RE, (whole) => emit(anchorIn(whole, '【[（('), ''));
    t = t.replace(_CITE_BRACKET_RE, (whole) => emit(anchorIn(whole, '【】'), ''));
    t = t.replace(_CITE_LINK_RE, (whole, label, target) => {
      if (/#chunk\s*\d+/.test(target)) return emit(target, label);
      if (/#chunk\s*\d+/.test(label)) return emit(label, '');
      return whole; // 非引用链接：保留，交给统一管线渲染成真链接
    });
    t = t.replace(_CITE_TICK_RE, (whole, anchor) => emit(anchor, ''));
    // ② 证据精确串（中文 / 含空格路径）——必须早于裸锚点正则，否则会被从
    //    `md#chunk N` 处截断，留下 `…SM 的交接.` 这类路径残尾。
    //    先吃掉"整对括号只包着锚点"的形态（`（锚点）` / `【锚点】`），
    //    否则 chip 会被一对空括号夹住、正文多出 `（）` 壳。
    for (const [anchor] of variants) {
      for (const [open, close] of [['（', '）'], ['(', ')'], ['【', '】'], ['[', ']']]) {
        const wrapped = `${open}${anchor}${close}`;
        if (t.includes(wrapped)) t = t.split(wrapped).join(emit(anchor, ''));
      }
      if (t.includes(anchor)) t = t.split(anchor).join(emit(anchor, ''));
    }
    // ③ 裸锚点兜底（ASCII）：证据命中出 chip，否则删除
    t = t.replace(_CITE_BARE_RE, (whole) => emit(whole, ''));
    // 空壳归一：引用标签已被换成 chip，这里只清残留的空括号/空方括号形态
    t = t
      .replace(/[（(]\s*[）)]/g, '')
      .replace(/[【[]\s*(?:来源|引用|source)\s*[：:]?\s*\d*\s*[】\]]/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+(?=\n|$)/g, '')
      .replace(/[ \t]+(?=[，。；：、！？）】])/g, '');
    return { text: t, chips };
  }

  // AI 回答正文 → HTML：引用锚点还原成可点 chip，再交给渲染层统一 Markdown 管线
  // （标题/列表/链接/表格/代码一次到位，末尾由 utils.js 的 sanitizeHtml 收口 XSS；
  // DOMPurify 由 index.html 在 utils.js 之前加载）。用法与 chat-stream 一致。
  function _decorateAnswerHtml(text, evidence) {
    const { text: withTokens, chips } = _chipifyCitationAnchors(text, evidence);
    let html = (typeof renderMarkdownFull === 'function')
      ? renderMarkdownFull(withTokens)
      // 理论不可达（index.html 先加载 utils.js）；保留纯文本兜底，避免正文空白
      : _esc(withTokens);
    // chip HTML 由 _citeChipHtml 构造（path/label 均经 _esc），且在 sanitize 之后
    // 注入，所以此处绝不能引入任何未转义的模型文本。
    for (let i = 0; i < chips.length; i++) html = html.split(_citeToken(i)).join(chips[i]);
    return `<div class="markdown-body kb-a-md">${html}</div>`;
  }

  /**
   * 正文行内引用 chip 的点击处置：事件委托挂在消息容器上（只挂一次）。
   * 用委托而不是逐元素绑定——流式回答每个 delta 都会重写 innerHTML，
   * 逐元素绑定会反复失效。
   */
  function _wireCitationChips() {
    const box = document.getElementById('kb-qa-messages');
    if (!box || box._kbCiteWired) return;
    box._kbCiteWired = true;
    box.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      const el = target.closest('[data-kb-cite]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      _openAnchor({
        source: el.dataset.citeSource || 'library',
        scope: el.dataset.citeScope || 'global',
        path: el.dataset.citePath || '',
        chunkIdx: Number(el.dataset.citeChunk) || 0,
        ...(el.dataset.citeSpace ? { spaceId: el.dataset.citeSpace } : {}),
      });
    });
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
        ${_uiIconButton({ label: _tr('kb.workbench.more', '更多'), icon: 'more-horizontal', className: 'kb-qa-more-btn' })}
        <div class="kb-qa-msg-menu" hidden>
          ${_uiButton({ label: _tr('kb.workbench.menu_rename', '重命名'), icon: 'edit-pencil', role: 'ghost', size: 'sm', className: 'kb-qa-msg-menu-item', attrs: { 'data-qa-act': 'rename' } })}
          ${_uiButton({ label: _tr('kb.workbench.menu_delete', '删除'), icon: 'trash-2', role: 'danger', size: 'sm', className: 'kb-qa-msg-menu-item', attrs: { 'data-qa-act': 'delete' } })}
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
          try { next = typeof uiPrompt === 'function' ? await uiPrompt(_tr('kb.workbench.qa_rename_prompt', '重命名问题：'), body.textContent) : window.prompt(_tr('kb.workbench.qa_rename_prompt', '重命名问题：'), body.textContent); }
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
      streamBody.textContent = _tr('kb.workbench.qa_unavailable', '问答服务不可用');
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
      const handle = window.cogseed.stream('kbqa.askStream', {
        question: q,
        space_id: _state.spaceId || null,
        // 问答检索范围跟随当前所在个人库目录（与 AI 解析/脑图一致）；整库视图时为 null。
        dir: _state.spaceId ? null : (_state.currentLib || null),
        k: 8,
        attach_paths: attachPaths,
        // 脑图/测验这类产物消息没有 content，不能进模型多轮上下文
        history: _state.qaHistory.filter((m) => m.kind !== 'mindmap' && m.kind !== 'quiz').slice(0, -1),
        // 用户在模型配置弹层里选定的模型（未选则走主进程默认）
        model: (_qaModelEntry && _qaModelEntry.provider && _qaModelEntry.model)
          ? { provider: _qaModelEntry.provider, model: _qaModelEntry.model }
          : undefined,
      }, (ev) => {
        if (!ev) return;
        if (ev.type === 'delta' && ev.text) {
          text += ev.text;
          // 流式期间证据尚未下发：先走常规消解，final 会用 evidence 白名单重渲染一遍
          streamBody.innerHTML = _decorateAnswerHtml(text);
          box.scrollTop = box.scrollHeight;
        } else if (ev.type === 'final') {
          ai.classList.remove('is-typing');
          text = ev.text || text;
          streamBody.innerHTML = _decorateAnswerHtml(text, ev.evidence);
          // 系统状态行（如“已读取知识库信息”）→ 浅灰小字置于回答顶部
          if (ev.sysNote) {
            const sysNoteIcon = typeof window.uiIconHtml === 'function'
              ? window.uiIconHtml('check', 'kb-qa-sysnote-icon')
              : '';
            streamBody.insertAdjacentHTML('afterbegin', `<div class="kb-qa-sysnote">${sysNoteIcon}<span>${_esc(ev.sysNote)}</span></div>`);
          }
          // 复制用“可读正文”：渲染后已去掉 markdown 标记与行内溯源锚点
          const readableText = streamBody.textContent || text;          // 明确“未找到/无相关”结论 → 浅灰提示块，与有效信息做视觉隔离
          if (ev.notFound) streamBody.classList.add('is-notfound');
          // 多轮上下文：回答入 history + 持久化当前会话（AI 回答额外存引用锚点，
          // 供“打开历史会话”时恢复引用 chips 与脑图按钮）
          const asstMsg = { role: 'assistant', content: text };
          _state.qaHistory.push(asstMsg);
          const evidence = Array.isArray(ev.evidence) ? ev.evidence : [];
          if (evidence.length) {
            // 精简持久化字段，控制 localStorage 体积（引用 chips/原文跳转只需这几项；
            // spaceId 不能省——共享库引用缺它会在跳转时报"缺少空间信息"）
            asstMsg.evidence = evidence.slice(0, 12).map((r) => ({
              source: r.source || 'library',
              scope: r.scope || 'global',
              path: r.path,
              chunkIdx: r.chunkIdx,
              ...(r.spaceId ? { spaceId: r.spaceId } : {}),
            }));
            streamBody.appendChild(_qaRefsElement(asstMsg.evidence));
          }
          _qaSaveCurrentSession(q);
          // 每条 AI 回答末尾附「生成脑图」按钮：基于本条回答文本生成（不是整库）
          streamBody.appendChild(_qaMmButtonRow(text, asstMsg));
          // 未找到时跨库引导：内容在其它个人库目录 → 提供“前往该库提问”按钮
          const sug = ev.suggestion;
          if (sug && typeof sug.dir === 'string' && sug.dir && sug.path) {
            const card = document.createElement('div');
            card.className = 'kb-qa-suggest';
            const txt = document.createElement('span');
            txt.className = 'kb-qa-suggest-txt';
            txt.innerHTML = _tr('kb.workbench.qa_lib_missing', '{icon} 当前库未找到，可能在「<b>{dir}</b>」：<code>{path}</code>', { icon: _icon('folder'), dir: _esc(sug.dir), path: _esc(sug.path) });
            const goBtn = _elementFromHtml(_uiButton({
              label: _tr('kb.workbench.qa_go_library', '前往该库提问'),
              role: 'primary',
              size: 'sm',
              iconEnd: 'arrow-right',
              className: 'kb-qa-suggest-btn',
            }));
            goBtn.addEventListener('click', () => {
              if (_state.currentLib !== sug.dir) _selectLib(sug.dir);
              _ask(q);
            });
            card.appendChild(txt);
            card.appendChild(goBtn);
            streamBody.appendChild(card);
          }
          // 轻工具条：复制回答全文（可读正文，不含行内溯源锚点）
          const tools = document.createElement('div');
          tools.className = 'kb-qa-tools';
          const copyBtn = _elementFromHtml(_uiButton({
            label: _tr('kb.qa.copy_answer', '复制'),
            role: 'ghost',
            size: 'sm',
            icon: 'copy',
            className: 'kb-qa-tools-btn',
            attrs: { title: _tr('kb.qa.copy_answer_title', '复制回答全文') },
          }));
          copyBtn.addEventListener('click', () => _copyText(readableText, _tr('kb.qa.copy_answer_done', '已复制回答全文')));
          tools.appendChild(copyBtn);
          streamBody.appendChild(tools);
          box.scrollTop = box.scrollHeight;
        } else if (ev.type === 'error') {
          ai.classList.remove('is-typing');
          streamBody.textContent = _tr('kb.workbench.qa_error', '出错了：') + (ev.text || 'unknown');
        }
      });
      if (handle && handle.promise) handle.promise.catch(() => { /* ignore */ });
    } catch (err) {
      ai.classList.remove('is-typing');
      streamBody.textContent = _tr('kb.workbench.qa_error', '出错了：') + ((err && err.message) || String(err));
    }
  }

  // 引用 → 统一原文查看器的整篇模式。
  async function _openFileViewerForAnchor(anchor) {
    if (!anchor || typeof anchor.path !== 'string' || !anchor.path) return false;
    const isSpace = anchor.source === 'space' || anchor.scope === 'space';
    const spaceId = isSpace ? String(anchor.spaceId || '') : '';
    if (isSpace && !spaceId) {
      if (typeof uiToast === 'function') uiToast('缺少空间信息，无法打开原文', { variant: 'warning' });
      return false;
    }
    // 排版类文件（pdf/office/…）用富查看器打开，并把页码/引用片段带过去定位；
    // 文本类仍用原文查看器（引用高亮 + 转写纠错面板都在那边）。
    if (_isRichPreview(anchor.path)) return _openRichForAnchor(anchor);
    if (typeof window.__openAnchorViewer !== 'function') return false;
    await window.__openAnchorViewer({
      source: 'library',
      scope: isSpace ? 'space' : 'global',
      path: anchor.path,
      // 只有真引用（带 chunkIdx）才带过去定位；"打开整篇"的 ref 不带 = 不高亮、
      // 也没有"返回引用位置"（此前这里缺省补 0，整篇打开也会被高亮第一章）
      ...(typeof anchor.chunkIdx === 'number' ? { chunkIdx: anchor.chunkIdx } : {}),
      ...(isSpace ? { spaceId } : {}),
      ...(typeof anchor.quote === 'string' && anchor.quote.trim() ? { quote: anchor.quote } : {}),
      view: 'document',
    });
    return true;
  }

  /**
   * 排版类文件按"保排版"方式打开（PDF 走 PDFium、Office 走排版化 HTML），
   * 并把引用定位（页码）带过去。返回 false = 这次没打开。
   *
   * 单独抽出来是因为它是**对外桥**：`anchored-source-view` 在把文件丢进
   * 纯文本阅读器之前会先调它（见 `window.__openKbRichFile`）。渲染进程的
   * 分派只有这一条路，PDF/Word 才不会退化成没有排版的字符流。
   */
  async function _openRichForAnchor(anchor) {
    if (!anchor || typeof anchor.path !== 'string' || !anchor.path) return false;
    const isSpace = anchor.source === 'space' || anchor.scope === 'space';
    const spaceId = isSpace ? String(anchor.spaceId || '') : '';
    if (isSpace && !spaceId) {
      if (typeof uiToast === 'function') uiToast('缺少空间信息，无法打开原文', { variant: 'warning' });
      return false;
    }
    let hl = null;
    try {
      if (window.cogseed && typeof window.cogseed.invoke === 'function') {
        const loc = await window.cogseed.invoke('cogseed.anchor.resolve', {
          source: isSpace ? 'space' : 'library',
          scope: isSpace ? 'space' : 'global',
          path: anchor.path,
          // 同上：没有真实 chunkIdx 就别造一个，否则排版类文件打开也会被"定位到第 1 节"
          ...(typeof anchor.chunkIdx === 'number' ? { chunkIdx: anchor.chunkIdx } : {}),
          ...(isSpace ? { spaceId } : {}),
          ...(typeof anchor.quote === 'string' && anchor.quote.trim() ? { quote: anchor.quote } : {}),
        });
        if (loc && loc.resolved) {
          hl = {};
          if (typeof loc.page === 'number' && loc.page > 0) hl.page = loc.page;
          // 片段文本一并带给富查看器：md/文本正文与 Office 排版 HTML 都有现成的
          // `_fvHighlightContainer` / `_fvHighlightFrame` 高亮分支（此前没有任何调用方
          // 设过 hl.quote，所以那两段代码一直是死的）。PDF 是原生 PDFium iframe，
          // 只能靠 hl.page 翻页——不给假承诺。
          if (typeof anchor.quote === 'string' && anchor.quote.trim()) hl.quote = anchor.quote.trim();
        }
      }
    } catch (_) { /* 定位失败不阻断打开整篇 */ }
    await _openFileViewer(isSpace ? { spaceId, path: anchor.path } : { path: anchor.path }, isSpace ? spaceId : '', hl);
    return true;
  }

  function _openAnchor(ref) {
    // library（个人库/空间库）引用 → 打开整篇原文并高亮/翻页；attachment 等回落片段查看器
    if (ref && ref.source !== 'attachment' && (ref.scope === 'global' || ref.scope === 'space')) {
      _openFileViewerForAnchor(ref);
      return;
    }
    if (typeof window.__openAnchorViewer === 'function') {
      window.__openAnchorViewer({
        source: ref.source || 'library',
        scope: ref.scope || 'global',
        path: ref.path,
        // 与 quote 同款：没有就整条不给（不给 = 打开整篇，给了 0 就变成"引用"）
        ...(typeof ref.chunkIdx === 'number' ? { chunkIdx: ref.chunkIdx } : {}),
        ...(ref.quote ? { quote: ref.quote } : {}),
        ...(ref.cid ? { cid: ref.cid } : {}),
        ...(ref.spaceId ? { spaceId: ref.spaceId } : {}),
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
      const handle = window.cogseed.stream('kb.events', {}, (ev) => {
        const inner = ev && ev.event;
        if (!inner || !inner.relPath) return;
        if (inner.status === 'deleted') _state.kbStatus.delete(inner.relPath);
        else _state.kbStatus.set(inner.relPath, { status: inner.status, chunks: inner.chunks, kind: inner.kind, error: inner.error });
        _renderFiles();
        // 索引事件同时也是"库内容变了"的信号：快照里查不到的路径说明库刚长了文件
        // （别人另存/导入/AI 落库），已删除的路径说明库少了文件。两种都要重拉树——
        // 只更新「已索引」徽标会让列表永远停在进入视图时的那份快照上。
        const known = _treeHasPath(inner.relPath);
        if ((inner.status === 'deleted' && known) || (inner.status !== 'deleted' && !known)) {
          _scheduleTreeReload();
        }
      });
      _state.streamHandle = handle;
      handle.promise.catch(() => { /* ignore */ }).finally(() => {
        if (_state.streamHandle === handle) _state.streamHandle = null;
      });
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
        ${_uiIconButton({ label: _tr('kb.workbench.side_expand', '展开知识库列表'), icon: 'chevron-right', className: 'kb-wb-side-expand', attrs: { id: 'kb-wb-side-expand', hidden: true, 'data-wb-label': 'kb.workbench.side_expand' } })}
        <aside class="kb-wb-side">
          <div class="kb-wb-side-head">
            <h2 data-wb-text="kb.workbench.side_title"></h2>
            <div class="kb-wb-side-actions">
              ${_uiIconButton({ label: _tr('kb.workbench.side_collapse', '收起知识库列表'), icon: 'panel-list', className: 'kb-wb-icon-btn', attrs: { id: 'kb-wb-side-collapse', 'data-wb-label': 'kb.workbench.side_collapse' } })}
              ${_uiIconButton({ label: _tr('kb.workbench.side_search', '搜索知识库'), icon: 'search', className: 'kb-wb-icon-btn', attrs: { id: 'kb-wb-side-search-btn', 'data-wb-label': 'kb.workbench.side_search' } })}
            </div>
          </div>
          <div class="kb-wb-side-search" id="kb-wb-side-search" hidden>
            <span class="kb-wb-side-search-ico">${_svg('search')}</span>
            ${_uiInput({ id: 'kb-wb-side-search-input', type: 'search', placeholder: _tr('kb.workbench.side_search_placeholder', '搜索知识库…'), attrs: { 'data-wb-placeholder': 'kb.workbench.side_search_placeholder', autocomplete: 'off', spellcheck: 'false' } })}
          </div>
          <div class="kb-wb-tree" id="kb-wb-tree"></div>
        </aside>
        <div class="kb-wb-divider" data-wb-divider="1" data-wb-title="kb.workbench.divider_drag"></div>
        <section class="kb-wb-mid">
          <div class="kb-wb-mid-head">
            <div class="kb-wb-lib-head">
              <div class="kb-wb-lib-cover" id="kb-wb-lib-cover"><svg class="kb-wb-cover-svg" viewBox="0 0 24 24" fill="rgba(255,255,255,.96)" stroke="rgba(255,255,255,.96)" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h4.2l1.8 2.2h7a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg></div>
              <div class="kb-wb-lib-meta">
                <div class="kb-wb-lib-name" id="kb-wb-lib-name">${_esc(_tr('kb.workbench.untitled_lib', '知识库'))}</div>
                <div class="kb-wb-lib-owner" id="kb-wb-lib-owner"><span class="kb-wb-owner-avatar" id="kb-wb-owner-avatar">我</span><span class="kb-wb-owner-name" id="kb-wb-owner-name">我</span></div>
                <div class="kb-wb-lib-desc" id="kb-wb-lib-desc">${_esc(_tr('kb.workbench.lib_desc_placeholder', '快来填写描述吧~'))}</div>
                <div class="kb-wb-lib-sub">
                  <span class="kb-wb-tag" id="kb-wb-lib-tag">${_esc(_tr('kb.workbench.group_personal', '个人知识库'))}</span>
                  <span class="kb-wb-members" id="kb-wb-members">${_esc(_tr('kb.workbench.members_joined', '1 加入'))}</span>
                </div>
              </div>
              <div class="kb-wb-lib-actions">
                ${_uiIconButton({
                  label: _tr('kb.workbench.open_ai_panel', '打开 AI 解析与问答'),
                  icon: 'message-square',
                  className: 'kb-wb-right-expand',
                  attrs: { id: 'kb-wb-right-expand', 'aria-controls': 'kb-wb-right-panel', 'aria-expanded': 'false' },
                })}
                <span class="kb-wb-share-wrap" id="kb-wb-share-wrap">
                  ${_uiIconButton({ label: _tr('kb.workbench.share_soon', '分享知识库（待开发）'), icon: 'users', className: 'kb-wb-icon-btn', attrs: { id: 'kb-wb-share', 'data-wb-label': 'kb.workbench.share_soon' } })}
                  <span class="kb-wb-soon-chip" data-wb-text="kb.workbench.coming_soon"></span>
                </span>
                <div class="kb-wb-more">
                  ${_uiIconButton({ label: _tr('kb.workbench.more', '更多'), icon: 'more-horizontal', className: 'kb-wb-icon-btn', attrs: { id: 'kb-wb-more-btn', 'data-wb-label': 'kb.workbench.more' } })}
                  <div class="kb-wb-more-menu" id="kb-wb-more-menu" hidden>
                    <div class="kb-wb-more-item" data-more="refresh"><span data-wb-text="kb.workbench.refresh"></span></div>
                    <div class="kb-wb-more-item" data-more="rename"><span data-wb-text="kb.workbench.rename"></span></div>
                    <div class="kb-wb-more-item is-danger" data-more="delete"><span data-wb-text="kb.workbench.delete_to_trash"></span></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="kb-wb-mid-sub">
              <div class="kb-wb-content-title"><span data-wb-text="kb.workbench.content"></span>(<span id="kb-wb-count">0</span>)</div>
              ${_uiInput({ id: 'kb-wb-search-input', type: 'search', placeholder: _tr('kb.workbench.search_docs_placeholder', '搜索文档…'), attrs: { 'data-wb-placeholder': 'kb.workbench.search_docs_placeholder', autocomplete: 'off' } })}
              <div class="kb-wb-tools">
                <div class="kb-wb-sort">
                  ${_uiIconButton({ label: _tr('kb.workbench.sort', '排序'), icon: 'list', className: 'kb-wb-icon-btn', attrs: { id: 'kb-wb-sort', 'data-wb-label': 'kb.workbench.sort' } })}
                  <div class="kb-wb-sort-menu" id="kb-wb-sort-menu" hidden>
                    <div class="kb-wb-sort-item is-selected" data-sort="updated">${_icon('check')} <span data-wb-text="kb.workbench.sort_updated"></span></div>
                    <div class="kb-wb-sort-item" data-sort="size"><span data-wb-text="kb.workbench.sort_size"></span></div>
                    <div class="kb-wb-sort-item" data-sort="type"><span data-wb-text="kb.workbench.sort_type"></span></div>
                    <div class="kb-wb-sort-item" data-sort="name"><span data-wb-text="kb.workbench.sort_name"></span></div>
                  </div>
                </div>
                ${_uiIconButton({ label: _tr('kb.workbench.reset_sort', '重置排序并刷新'), icon: 'refresh', className: 'kb-wb-icon-btn', attrs: { id: 'kb-wb-refresh', 'data-wb-label': 'kb.workbench.reset_sort' } })}
                <div class="kb-wb-import-wrap">
                  ${_uiIconButton({ label: _tr('kb.workbench.import', '导入内容'), icon: 'upload', className: 'kb-wb-icon-btn', attrs: { id: 'kb-wb-import', 'data-wb-label': 'kb.workbench.import' } })}
                  <div class="kb-wb-import-menu" id="kb-wb-import-menu" hidden>
                    <div class="kb-wb-import-item" data-imp="file">${_icon('file', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_file"></span></div>
                    <div class="kb-wb-import-item" data-imp="dir">${_icon('folder', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_dir"></span></div>
                    <div class="kb-wb-import-item" data-imp="kblib">${_icon('book-open', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_kblib"></span></div>
                    <div class="kb-wb-import-item" data-imp="url">${_icon('link', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_url"></span></div>
                    <div class="kb-wb-import-has-sub">
                      <div class="kb-wb-import-item" data-imp="note">${_icon('file-text', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_note"></span><span class="kb-import-caret">${_icon('chevron-left', 'kb-import-caret-icon')}</span></div>
                      <div class="kb-wb-import-sub" id="kb-wb-import-note-sub" hidden>
                        <div class="kb-wb-import-item" data-imp="note-new">${_icon('document-pencil', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_note_new"></span></div>
                        <div class="kb-wb-import-item" data-imp="note-import">${_icon('upload', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_note_import"></span></div>
                      </div>
                    </div>
                    <div class="kb-wb-import-item" data-imp="audio">${_icon('mic', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_audio"></span></div>
                    <div class="kb-wb-import-item" data-imp="folder">${_icon('folder', 'kb-wb-import-icon')}<span data-wb-text="kb.workbench.import_folder"></span></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="kb-wb-crumb" id="kb-wb-crumb" hidden></div>
          </div>
          <div class="kb-wb-files" id="kb-wb-files"></div>
        </section>
        <div class="kb-wb-divider" data-wb-divider="2" data-wb-title="kb.workbench.divider_drag"></div>
        <section class="kb-wb-right" id="kb-wb-right-panel">
          <div class="kb-wb-right-head"><span class="kb-wb-chip">${_icon('book-open', 'kb-wb-chip-icon')}<span id="kb-wb-right-lib">—</span></span><span class="kb-wb-local"><span class="kb-wb-dot"></span><span data-wb-text="kb.workbench.right_local"></span></span>${_uiIconButton({
            label: _tr('kb.workbench.close_ai_panel', '关闭 AI 解析与问答'),
            icon: 'x',
            className: 'kb-wb-right-collapse',
            attrs: { id: 'kb-wb-right-collapse', 'aria-controls': 'kb-wb-right-panel' },
          })}</div>
          <div class="kb-wb-right-body" id="kb-wb-right">
            <div class="kb-wb-right-card" id="kb-wb-analysis-card">
              <div class="kb-wb-right-card-title">
                <span><span class="kb-wb-ai-chip"></span><span data-wb-text="kb.workbench.analysis_title"></span></span>
                <span class="kb-wb-card-actions">
                  ${_uiButton({ label: _tr('kb.workbench.gen_mindmap', '生成脑图'), role: 'secondary', size: 'sm', icon: 'brain-circuit', className: 'kb-wb-analysis-action', attrs: { id: 'kb-wb-gen-mm' } })}
                  ${_uiButton({ label: _tr('kb.workbench.gen_quiz', '生成测验'), role: 'secondary', size: 'sm', icon: 'file-text', className: 'kb-wb-analysis-action', attrs: { id: 'kb-wb-gen-quiz' } })}                </span>
              </div>
              <div class="kb-wb-right-card-sub" id="kb-wb-analysis-sub">${_esc(_tr('kb.workbench.right_lib_placeholder', '当前库：—'))}</div>
              <div class="kb-wb-right-placeholder">${_uiButton({ label: _tr('kb.workbench.analysis_generate', '生成 AI 解析'), role: 'primary', size: 'sm', icon: 'sparkles', attrs: { id: 'kb-analyze-btn', 'data-wb-label': 'kb.workbench.analysis_generate' } })}</div>
            </div>
            <div class="kb-qa-session">
              <div class="kb-qa-session-head">
                <span class="kb-qa-session-date" id="kb-qa-session-date"></span>
                <div class="kb-qa-session-actions">
                  ${_uiIconButton({ label: _tr('kb.workbench.qa_new_session', '新建对话'), icon: 'plus', className: 'kb-qa-session-btn', attrs: { id: 'kb-qa-popout', 'data-wb-label': 'kb.workbench.qa_new_session' } })}
                  ${_uiIconButton({ label: _tr('kb.workbench.qa_history', '会话历史'), icon: 'history', className: 'kb-qa-session-btn', attrs: { id: 'kb-qa-history', 'data-wb-label': 'kb.workbench.qa_history' } })}
                  ${_uiIconButton({ label: _tr('kb.workbench.qa_clear', '清空当前对话'), icon: 'x', className: 'kb-qa-session-btn', attrs: { id: 'kb-qa-clear', 'data-wb-label': 'kb.workbench.qa_clear' } })}
                </div>
              </div>
              <div class="kb-qa-messages" id="kb-qa-messages"></div>
            </div>
          </div>
          <div class="kb-wb-right-input">
            <div class="kb-qa-degraded-note" id="kb-qa-degraded-note" data-wb-text="kb.workbench.qa_degraded" hidden></div>
            <div class="kb-qa-attach-strip" id="kb-qa-attach-strip" hidden></div>
            <div class="kb-qa-box">
              <button type="button" class="kb-qa-model-chip" id="kb-qa-tools" data-wb-title="kb.workbench.qa_pick_model" title="">
                ${_icon('brain-circuit', 'kb-qa-model-chip-ico')}
                <span class="kb-qa-model-chip-name" id="kb-qa-model-name">${_esc(_tr('kb.workbench.qa_default_model', '默认模型'))}</span>
                <span class="kb-qa-model-chip-caret">${_svg('chevron-down')}</span>
              </button>
              ${_uiTextarea({ id: 'kb-qa-input', className: 'kb-qa-input', placeholder: _tr('kb.workbench.qa_placeholder', '基于知识库提问'), attrs: { rows: 1, 'data-wb-placeholder': 'kb.workbench.qa_placeholder' } })}
              <div class="kb-qa-icon-wrap" id="kb-qa-attach-wrap">
                ${_uiIconButton({ label: _tr('kb.workbench.qa_attach', '上传附件'), icon: 'paperclip', className: 'kb-qa-icon-btn', attrs: { id: 'kb-qa-attach', 'data-wb-label': 'kb.workbench.qa_attach' } })}
                <div class="kb-qa-attach-tip" id="kb-qa-attach-tip" hidden>
                  <div class="kb-qa-attach-tip-title" data-wb-text="kb.workbench.qa_attach_tip_title"></div>
                  <div class="kb-qa-attach-tip-item" data-wb-text="kb.workbench.qa_attach_tip_count"></div>
                  <div class="kb-qa-attach-tip-item" data-wb-text="kb.workbench.qa_attach_tip_types"></div>
                  <div class="kb-qa-attach-tip-item" data-wb-text="kb.workbench.qa_attach_tip_context"></div>
                </div>
              </div>
              ${_uiIconButton({ label: _tr('kb.workbench.qa_send', '发送'), icon: 'send', className: 'kb-qa-send', disabled: true, attrs: { id: 'kb-qa-send', 'data-wb-label': 'kb.workbench.qa_send' } })}
            </div>
            <div class="kb-qa-note" data-wb-text="kb.workbench.qa_note"></div>
          </div>
        </section>
      </div>
      <div class="kb-mm-overlay" id="kb-mm-overlay" hidden>
        <div class="kb-mm-dlg" id="kb-mm-dlg" role="dialog" aria-modal="true" data-wb-aria="kb.workbench.mm_title" aria-label="">
        <div class="kb-mm-titlebar" id="kb-mm-titlebar">
          <span class="kb-mm-titlebar-ico">${_icon('brain-circuit', 'kb-mm-titlebar-icon')}</span>
          ${_uiInput({ id: 'kb-mm-title-input', className: 'kb-mm-title-input', value: _tr('kb.workbench.mm_title', '脑图预览'), attrs: { title: _tr('kb.workbench.mm_title_dblclick', '双击修改标题'), spellcheck: 'false' } })}
          <span class="kb-mm-save-state" id="kb-mm-save-state"></span>
          <div class="kb-mm-titlebar-actions">
            ${_uiButton({ label: _tr('kb.workbench.mm_preview', '预览'), role: 'secondary', size: 'sm', icon: 'eye', className: 'kb-mm-titlebar-btn', attrs: { id: 'kb-mm-mode-btn', title: _tr('kb.workbench.mm_mode_tip', '切换预览/编辑模式'), 'aria-pressed': 'false' } })}
            ${_uiButton({ label: _tr('kb.workbench.mm_popout', '独立窗口'), role: 'secondary', size: 'sm', icon: 'external', className: 'kb-mm-titlebar-btn', attrs: { id: 'kb-mm-popout-btn', title: _tr('kb.workbench.mm_popout_tip', '弹出独立窗口'), 'data-wb-label': 'kb.workbench.mm_popout', 'data-wb-title': 'kb.workbench.mm_popout_tip' } })}
            ${_uiIconButton({ label: _tr('kb.workbench.mm_close', '关闭脑图预览'), icon: 'x', className: 'kb-mm-overlay-close', attrs: { id: 'kb-mm-overlay-close', title: _tr('kb.workbench.viewer_close_esc', '关闭（Esc）'), 'data-wb-label': 'kb.workbench.mm_close', 'data-wb-title': 'kb.workbench.viewer_close_esc' } })}
          </div>
        </div>
        <div class="kb-mm-overlay-toolbar">
          <div class="kb-mm-tb-group">
            ${_uiButton({ label: _tr('kb.workbench.mm_undo', '撤销'), role: 'ghost', size: 'sm', icon: 'undo', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-undo', title: _tr('kb.workbench.mm_undo', '撤销'), 'data-wb-label': 'kb.workbench.mm_undo', 'data-wb-title': 'kb.workbench.mm_undo' } })}
            ${_uiButton({ label: _tr('kb.workbench.refresh', '刷新'), role: 'ghost', size: 'sm', icon: 'refresh', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-refresh', title: _tr('kb.workbench.mm_refresh_tip', '重新生成脑图'), 'data-wb-label': 'kb.workbench.refresh', 'data-wb-title': 'kb.workbench.mm_refresh_tip' } })}
          </div>
          <div class="kb-mm-tb-group">
            ${_uiButton({ label: _tr('kb.workbench.save_short', '保存'), role: 'ghost', size: 'sm', icon: 'archive', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-save', title: _tr('kb.workbench.mm_save_tip', '保存到知识库'), 'data-wb-label': 'kb.workbench.save_short', 'data-wb-title': 'kb.workbench.mm_save_tip' } })}
            <div class="kb-mm-open">
              ${_uiButton({ label: _tr('kb.workbench.mm_open', '存档'), role: 'ghost', size: 'sm', icon: 'folder-open', iconEnd: 'chevron-down', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-open-btn', title: _tr('kb.workbench.mm_open_tip', '打开已保存的脑图'), 'data-wb-label': 'kb.workbench.mm_open', 'data-wb-title': 'kb.workbench.mm_open_tip' } })}
              <div class="kb-mm-open-menu" id="kb-mm-open-menu" hidden></div>
            </div>
            <div class="kb-mm-export">
              ${_uiButton({ label: _tr('kb.workbench.mm_export', '导出'), role: 'ghost', size: 'sm', icon: 'download', iconEnd: 'chevron-down', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-export-btn', title: _tr('kb.workbench.mm_export', '导出'), 'data-wb-label': 'kb.workbench.mm_export', 'data-wb-title': 'kb.workbench.mm_export' } })}
              <div class="kb-mm-export-menu" id="kb-mm-export-menu" hidden>
                <div class="kb-mm-export-item" data-export="png">${_icon('image', 'kb-mm-menu-icon')}<span data-wb-text="kb.workbench.mm_export_png"></span></div>
                <div class="kb-mm-export-item" data-export="svg">${_icon('code', 'kb-mm-menu-icon')}<span data-wb-text="kb.workbench.mm_export_svg"></span></div>
                <div class="kb-mm-export-item" data-export="pdf">${_icon('file-text', 'kb-mm-menu-icon')}<span data-wb-text="kb.workbench.mm_export_pdf"></span></div>
                <div class="kb-mm-export-item" data-export="md">${_icon('list', 'kb-mm-menu-icon')}<span data-wb-text="kb.workbench.mm_export_md"></span></div>
                <div class="kb-mm-export-item" data-export="copy">${_icon('copy', 'kb-mm-menu-icon')}<span data-wb-text="kb.workbench.mm_export_copy"></span></div>
              </div>
            </div>
          </div>
          <div class="kb-mm-tb-group kb-mm-tb-view">
            <div class="kb-mm-layout">
              ${_uiButton({ label: _tr('kb.workbench.mm_layout', '布局'), role: 'ghost', size: 'sm', icon: 'layout-grid', iconEnd: 'chevron-down', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-layout-btn', title: _tr('kb.workbench.mm_layout_tip', '切换布局') } })}
              <div class="kb-mm-layout-menu" id="kb-mm-layout-menu" hidden>
                <div class="kb-mm-layout-item" data-mode="mind">${_icon('brain-circuit', 'kb-mm-menu-icon')}<span data-wb-text="kb.workbench.mm_layout_mind"></span></div>
                <div class="kb-mm-layout-item" data-mode="org">${_icon('layout-grid', 'kb-mm-menu-icon')}<span data-wb-text="kb.workbench.mm_layout_org"></span></div>
              </div>
            </div>
            ${_uiButton({ label: _tr('kb.workbench.expand', '展开'), role: 'ghost', size: 'sm', icon: 'chevron-down', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-expand-all', title: _tr('kb.workbench.mm_expand_all_tip', '全部展开'), 'data-wb-label': 'kb.workbench.expand', 'data-wb-title': 'kb.workbench.mm_expand_all_tip' } })}
            ${_uiButton({ label: _tr('kb.workbench.mm_collapse_all', '收拢'), role: 'ghost', size: 'sm', icon: 'chevron-up', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-collapse-all', title: _tr('kb.workbench.mm_collapse_all_tip', '全部收拢'), 'data-wb-label': 'kb.workbench.mm_collapse_all', 'data-wb-title': 'kb.workbench.mm_collapse_all_tip' } })}
            ${_uiButton({ label: _tr('kb.workbench.mm_focus', '聚焦'), role: 'ghost', size: 'sm', icon: 'target', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-focus-btn', title: _tr('kb.workbench.mm_focus_off_tip', '聚焦分支：点击一级分支只看该分支'), 'aria-pressed': 'false' } })}
            ${_uiButton({ label: _tr('kb.workbench.mm_outline', '大纲'), role: 'ghost', size: 'sm', icon: 'list', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-outline-btn', title: _tr('kb.workbench.mm_outline_toggle', '大纲视图切换'), 'data-wb-label': 'kb.workbench.mm_outline', 'data-wb-title': 'kb.workbench.mm_outline_toggle', 'aria-pressed': 'false' } })}
            ${_uiButton({ label: _tr('kb.workbench.mm_bg', '背景'), role: 'ghost', size: 'sm', icon: 'palette', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-bg-btn', title: _tr('kb.workbench.mm_bg_tip', '背景切换（点阵/纯白/无）') } })}
            ${_uiButton({ label: _tr('kb.workbench.mm_dots', '点阵'), role: 'ghost', size: 'sm', icon: 'dot', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-dots-btn', title: _tr('kb.workbench.mm_dots_tip', '点阵开关'), 'data-wb-label': 'kb.workbench.mm_dots', 'data-wb-title': 'kb.workbench.mm_dots_tip', 'aria-pressed': 'false' } })}
          </div>
          <div class="kb-mm-tb-group kb-mm-tb-more">
            ${_uiInput({ id: 'kb-mm-search', type: 'search', className: 'kb-mm-search', placeholder: _tr('kb.workbench.mm_search', '搜索节点…'), attrs: { 'data-wb-placeholder': 'kb.workbench.mm_search' } })}
            <div class="kb-mm-overlay-zoom">
              ${_uiIconButton({ label: _tr('kb.workbench.viewer_zoom_out', '缩小'), icon: 'minus', className: 'kb-mm-zoom-btn', attrs: { id: 'kb-mm-zoom-out', 'data-wb-label': 'kb.workbench.viewer_zoom_out' } })}
              <span id="kb-mm-zoom-label">100%</span>
              ${_uiIconButton({ label: _tr('kb.workbench.viewer_zoom_in', '放大'), icon: 'plus', className: 'kb-mm-zoom-btn', attrs: { id: 'kb-mm-zoom-in', 'data-wb-label': 'kb.workbench.viewer_zoom_in' } })}
              ${_uiButton({ label: _tr('kb.workbench.mm_fit', '适应'), role: 'ghost', size: 'sm', icon: 'maximize', className: 'kb-mm-tool-btn', attrs: { id: 'kb-mm-reset', title: _tr('kb.workbench.mm_fit_tip', '适应画布'), 'data-wb-label': 'kb.workbench.mm_fit', 'data-wb-title': 'kb.workbench.mm_fit_tip' } })}
            </div>
            <div class="kb-mm-more">
              ${_uiIconButton({ label: _tr('kb.workbench.more', '更多'), icon: 'more-horizontal', className: 'kb-mm-more-btn', attrs: { id: 'kb-mm-more-btn', 'data-wb-label': 'kb.workbench.more' } })}
              <div class="kb-mm-more-menu" id="kb-mm-more-menu" hidden></div>
            </div>
          </div>
        </div>
        <div class="kb-mm-overlay-stage" id="kb-mm-overlay-stage">
          <div class="kb-mm-overlay-wrap" id="kb-mm-overlay-wrap"></div>
          <div class="kb-mm-overlay-stage-hint" data-wb-text="kb.workbench.mm_stage_hint"></div>
        </div>
        <div class="kb-mm-resize" id="kb-mm-resize" data-wb-title="kb.workbench.viewer_resize"></div>
        </div>
      </div>`;
    // 首渲染即套用当前语言：与 i18n-change 走**同一个**函数（一处文案来源）
    _relabelWorkbench(host);
    // 右列强制 flex column（JS 兜底：个别环境下样式表规则未应用时保证输入栏贴底）
    const _kbRightEl = document.getElementById('kb-wb-right');
    if (_kbRightEl) {
      _kbRightEl.style.display = 'flex';
      _kbRightEl.style.flexDirection = 'column';
    }
    document.getElementById('kb-wb-lib-name').textContent = _state.currentLib || _tr('kb.workbench.untitled_lib', '知识库');
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
    // 受限宽度下将右侧 AI 区变为按需抽屉，避免三栏互相挤压成竖排文字。
    const wb = document.querySelector('.kb-wb');
    const rightPanel = document.getElementById('kb-wb-right-panel');
    const rightExpandBtn = document.getElementById('kb-wb-right-expand');
    const rightCollapseBtn = document.getElementById('kb-wb-right-collapse');
    const rightPanelMedia = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1100px)')
      : null;
    let rightPanelNarrow = Boolean(rightPanelMedia && rightPanelMedia.matches);
    _state.rightPanelOpen = !rightPanelNarrow;
    const applyRightPanel = () => {
      // 单一事实源：_state.rightPanelOpen。此前写成
      // `!rightPanelNarrow || _state.rightPanelOpen`，宽屏（>1100px）下左半恒为
      // true → 点「关闭 AI 解析与问答」（生成测验正上方的 ×）后 open 仍为 true，
      // DOM 被强制回展开态，真机上表现就是"按钮点了完全没反应"（9.17 P0）。
      const open = _state.rightPanelOpen;
      // 只有窄屏才把右列做成覆盖式抽屉；宽屏是常驻第三栏（收起后让宽度给中间列）。
      const drawer = rightPanelNarrow && open;
      wb?.classList.toggle('right-panel-open', drawer);
      wb?.classList.toggle('right-panel-collapsed', !open);
      if (rightPanel) rightPanel.setAttribute('aria-hidden', String(!open));
      if (rightExpandBtn) {
        rightExpandBtn.hidden = open;
        rightExpandBtn.setAttribute('aria-expanded', String(open));
      }
      if (rightCollapseBtn) rightCollapseBtn.hidden = !open;
    };
    rightExpandBtn?.addEventListener('click', () => {
      _state.rightPanelOpen = true;
      applyRightPanel();
    });
    rightCollapseBtn?.addEventListener('click', () => {
      _state.rightPanelOpen = false;
      applyRightPanel();
      rightExpandBtn?.focus();
    });
    rightPanelMedia?.addEventListener?.('change', (event) => {
      rightPanelNarrow = Boolean(event.matches);
      _state.rightPanelOpen = !rightPanelNarrow;
      applyRightPanel();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !rightPanelNarrow || !_state.rightPanelOpen) return;
      if (document.getElementById('kb-qa-history-panel') || document.querySelector('.kb-import-dlg-overlay')) return;
      _state.rightPanelOpen = false;
      applyRightPanel();
      rightExpandBtn?.focus();
    });
    applyRightPanel();
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
        const label = { updated: _tr('kb.workbench.sort_updated', '更新时间'), size: _tr('kb.workbench.sort_size', '大小'), type: _tr('kb.workbench.sort_type', '类型'), name: _tr('kb.workbench.sort_name', '名称') }[_state.sort] || _state.sort;
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.sorted', '排序：{name}', { name: label }), { variant: 'info' });
      });
    });
    // 分享 + 更多菜单
    document.getElementById('kb-wb-share')?.addEventListener('click', () => {
      if (_isExternalSourceSelected()) return;
      if (!KB_SHARE_READY) { _kbShareSoonOpen(); return; }
      _kbShareDialogOpen();
    });
    const moreMenu = document.getElementById('kb-wb-more-menu');
    document.getElementById('kb-wb-more-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_isExternalSourceSelected()) return;
      if (moreMenu) moreMenu.hidden = !moreMenu.hidden;
    });
    document.querySelectorAll('.kb-wb-more-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (moreMenu) moreMenu.hidden = true;
        if (_isExternalSourceSelected()) return;
        const act = item.dataset.more;
        if (act === 'refresh') { _loadAll(); if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.refreshed', '已刷新'), { variant: 'info' }); }
        else if (act === 'rename') {
          if (_state.spaceId) _kbRenameSpace(_state.spaceId);
          else if (_state.currentLib) _kbRename(_state.currentLib, true);
        }
        else if (act === 'delete') {
          if (_state.spaceId) _kbDeleteSpace(_state.spaceId);
          else if (_state.currentLib) _kbDelete(_state.currentLib);
        }
        else if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.action_unavailable', '该操作暂不可用'), { variant: 'info' });
      });
    });
    // 重置按钮：恢复默认排序（更新时间）+ 刷新数据 + 提示（对齐 ima 重置语义）
    document.getElementById('kb-wb-refresh')?.addEventListener('click', () => {
      _state.sort = 'updated';
      document.querySelectorAll('.kb-wb-sort-item').forEach((x) => x.classList.remove('is-selected'));
      const def = document.querySelector('.kb-wb-sort-item[data-sort="updated"]');
      if (def) def.classList.add('is-selected');
      _loadAll();
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.sort_reset', '已重置排序（更新时间）并刷新'), { variant: 'info', timeoutMs: 2000 });
    });
    // 导入按钮 → 多级导入菜单（对齐 ima：本地文件/文件夹/网页/笔记/新建文件夹等）
    const importMenu = document.getElementById('kb-wb-import-menu');
    const importNoteSub = document.getElementById('kb-wb-import-note-sub');
    document.getElementById('kb-wb-import')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_isExternalSourceSelected()) return;
      if (importMenu) importMenu.hidden = !importMenu.hidden;
    });
    document.querySelectorAll('.kb-wb-import-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = item.dataset.imp;
        if (!act || act === 'note') return;
        if (importMenu) importMenu.hidden = true;
        if (_isExternalSourceSelected()) return;
        const isSpace = !!_state.spaceId;
        if (act === 'file') { if (isSpace) _importSpaceFiles(); else _importFiles(); }
        else if (act === 'dir') { if (isSpace) _importSpaceDir(); else _importDir(); }
        else if (act === 'url') _kbImportWebUrl();
        else if (act === 'kblib') { if (isSpace) _importSpaceFromLib(); else _kbMigrateLib(); }
        else if (act === 'note-new') _kbNewNote();
        else if (act === 'note-import') { if (isSpace) _importSpaceFiles(); else _importFiles(); }
        else if (act === 'folder') _kbNewFolder();
        else if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.import_soon', '该导入渠道即将上线'), { variant: 'info' });
      });
    });
    // 笔记 → 二级子菜单（悬浮展开 + 点击保持展开，向左弹出以避开窗口右边界）
    const noteWrap = importMenu ? importMenu.querySelector('.kb-wb-import-has-sub') : null;
    if (noteWrap && importNoteSub) {
      noteWrap.addEventListener('mouseenter', () => { importNoteSub.hidden = false; });
      noteWrap.addEventListener('mouseleave', () => { importNoteSub.hidden = true; });
      const noteToggle = noteWrap.querySelector('[data-imp="note"]');
      if (noteToggle) {
        noteToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          importNoteSub.hidden = false;
        });
      }
      importNoteSub.querySelectorAll('.kb-wb-import-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = item.dataset.imp;
          if (importMenu) importMenu.hidden = true;
          if (_isExternalSourceSelected()) return;
          if (act === 'note-new') _kbNewNote();
          else if (act === 'note-import') { if (_state.spaceId) _importSpaceFiles(); else _importFiles(); }
        });
      });
    }
    document.getElementById('kb-qa-send')?.addEventListener('click', () => _submitQa());
    _wireCitationChips();
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
      _qaDate.textContent = _tr('kb.workbench.qa_date', '{year}年{month}月{day}日', { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
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
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.session_cleared', '会话已清空'), { variant: 'info' });
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
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.attach_limit', '最多支持 5 个附件'), { variant: 'warning' });
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
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.attach_pick_failed', '选择附件失败'), { variant: 'error' });
      }
    });
    // 模型配置：点击模型 chip 打开已配置模型选择弹层（不用填 key，key 在设置里配）
    document.getElementById('kb-qa-tools')?.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      _openQaModelPicker();
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
    document.getElementById('kb-mm-overlay-close')?.addEventListener('click', () => { _mmClose(); });
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
      else titleInput.value = _state.spaceId ? _state.spaceName : (_state.currentLib || _tr('kb.workbench.untitled_mindmap', '脑图'));
      _mmMarkDirty();
    });
    // 媒体管理器外壳交给共享层（M-3）：焦点陷阱 / Escape / 关闭后焦点归还。
    // 原先这里自己监听 document 的 Escape，且面板没有 role="dialog"。
    const mmOverlay = document.getElementById('kb-mm-overlay');
    const mmDialog = document.getElementById('kb-mm-dlg');
    if (mmOverlay && mmDialog && typeof uiModalController === 'function') {
      _mmController = uiModalController({
        overlay: mmOverlay,
        dialog: mmDialog,
        initialFocus: '#kb-mm-overlay-close',
        // 关闭后恢复对话区缩略脑图卡：此前只有"关闭按钮"这条路径做了恢复，Escape 关闭会漏，
        // 统一走 onClose 后两条路径行为一致。
        onClose: () => { mmOverlay.hidden = true; _mmRestoreThumbs(); },
      });
    }
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
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.rename_undo_none', '没有可撤销的重命名'), { variant: 'info' });
        return;
      }
      _mmSetLabelAt(root, step.idx, step.old);
      _rerenderMindmaps();
      _mmFitToStage();
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.rename_undone', '已撤销重命名'), { variant: 'info' });
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
    const qaInputEl = document.getElementById('kb-qa-input');
    qaInputEl?.addEventListener('input', () => { _autoGrowQaInput(qaInputEl); _syncSendState(); });
    qaInputEl?.addEventListener('keyup', _syncSendState);
    _autoGrowQaInput(qaInputEl);
    _syncSendState();
    _restoreQaModelSelection();
    _renderQaModelChip();
    _refreshQaModelChipLabel();
    // 首屏解析卡的两个生成入口必须当场绑上：静态模板里的按钮没有 listener，
    // 只把 disabled 去掉的话点了没反应（要等切换库才绑上）。
    const analysisCard = document.getElementById('kb-wb-analysis-card');
    if (analysisCard) _bindAnalysisActions(analysisCard);
    _loadAll();
  }

  // ── 问答模型配置：直接在已配置模型（设置里配好的 auth entries）中点选，
  //    无需在此填 key。选择记忆到 localStorage，重启后恢复。 ──
  const QA_MODEL_STORE_KEY = 'cogseed.kb-qa.model.entryId';
  let _qaModelEntry = null; // { entryId, provider, providerLabel, model, modelName } | null（null = 默认模型）

  function _restoreQaModelSelection() {
    try {
      const saved = localStorage.getItem(QA_MODEL_STORE_KEY);
      _qaModelEntry = saved ? { entryId: saved } : null;
    } catch (_) { _qaModelEntry = null; }
  }

  function _currentQaModelLabel(entries) {
    if (!_qaModelEntry || !_qaModelEntry.entryId) return '';
    const hit = (entries || []).find((e) => e && e.entryId === _qaModelEntry.entryId);
    if (!hit) return '';
    _qaModelEntry = {
      entryId: hit.entryId,
      provider: hit.provider,
      providerLabel: hit.providerLabel || hit.provider,
      model: hit.model,
      modelName: hit.modelName || hit.model,
    };
    return `${hit.providerLabel || hit.provider} · ${hit.modelName || hit.model}`;
  }

  function _renderQaModelChip() {
    const nameEl = document.getElementById('kb-qa-model-name');
    if (!nameEl) return;
    nameEl.textContent = _qaModelEntry && _qaModelEntry.entryId && _qaModelEntry.modelName
      ? `${_qaModelEntry.providerLabel || _qaModelEntry.provider} · ${_qaModelEntry.modelName}`
      : _tr('kb.workbench.qa_default_model', '默认模型');
    nameEl.title = nameEl.textContent;
  }

  // 仅存了 entryId 恢复时后台补拉一次真实条目，让 chip 显示模型名
  function _refreshQaModelChipLabel() {
    if (!_qaModelEntry || !_qaModelEntry.entryId) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    window.cogseed.invoke('auth.listEntries', {})
      .then((res) => {
        const entries = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
        const hit = entries.find((e) => e && e.entryId === _qaModelEntry.entryId);
        if (hit) {
          _qaModelEntry = {
            entryId: hit.entryId,
            provider: hit.provider,
            providerLabel: hit.providerLabel || hit.provider,
            model: hit.model,
            modelName: hit.modelName || hit.model,
          };
          _renderQaModelChip();
        }
      })
      .catch(() => { /* 保持默认标签 */ });
  }

  // 弹出模型选择：列出所有已配置（可用）模型；空态引导去设置一次配好 key
  function _openQaModelPicker() {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      if (typeof uiToast === 'function') uiToast('问答服务不可用', { variant: 'warning' });
      return;
    }
    const trigger = document.activeElement;
    window.cogseed.invoke('auth.listEntries', {})
      .then((res) => {
        const entries = (res && res.ok && Array.isArray(res.entries)) ? res.entries.filter((e) => e && e.modelAvailable !== false) : [];
        _buildQaModelPicker(entries, trigger);
      })
      .catch(() => {
        if (typeof uiToast === 'function') uiToast('获取模型列表失败', { variant: 'error' });
      });
  }

  function _buildQaModelPicker(entries, trigger) {
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const overlay = el('div', 'kb-qa-model-overlay');
    overlay.id = 'kb-qa-model-picker';
    overlay.hidden = true;
    const pop = el('div', 'kb-qa-model-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'kb-qa-model-pop-title');
    const head = el('div', 'kb-qa-model-pop-head');
    const title = el('span', 'kb-qa-model-pop-title', _tr('kb.workbench.qa_pick_model', '选择问答模型'));
    title.id = 'kb-qa-model-pop-title';
    head.append(title, el('span', 'kb-qa-model-pop-hint', _tr('kb.workbench.qa_model_hint', '已配置模型，点击即切换')));
    const closeBtn = _elementFromHtml(_uiIconButton({
      label: _tr('kb.workbench.qa_model_close', '关闭模型选择弹窗'),
      icon: 'x',
      className: 'kb-qa-model-pop-close',
      title: _tr('kb.workbench.viewer_close_esc', '关闭（Esc）'),
    }));
    head.appendChild(closeBtn);
    pop.appendChild(head);

    const list = el('div', 'kb-qa-model-pop-list');
    const currentId = _qaModelEntry && _qaModelEntry.entryId;

    // 「默认模型」行：清空自选，走系统默认
    const defRow = el('button', 'kb-qa-model-item');
    defRow.type = 'button';
    defRow.setAttribute('aria-pressed', String(!currentId));
    const defIco = el('span', 'kb-qa-model-item-check');
    if (!currentId) defIco.innerHTML = _icon('check', 'ui-icon');
    const defMain = el('span', 'kb-qa-model-item-main');
    defMain.append(el('span', 'kb-qa-model-item-name', _tr('kb.workbench.qa_default_model', '默认模型')), el('span', 'kb-qa-model-item-sub', _tr('kb.workbench.qa_model_default_sub', '系统配置的默认问答模型')));
    defRow.append(defIco, defMain);
    list.appendChild(defRow);

    if (!entries.length) {
      list.appendChild(_elementFromHtml(_uiEmptyState({
        kind: 'explained',
        title: _tr('kb.workbench.qa_model_none_title', '尚未配置模型'),
        hint: _tr('kb.workbench.qa_model_none_hint', '到设置中配置一次 API Key 后即可在此选择'),
      })));
    } else {
      for (const e of entries) {
        const row = el('button', 'kb-qa-model-item');
        row.type = 'button';
        row.dataset.entryId = String(e.entryId || '');
        const selected = currentId === e.entryId;
        row.setAttribute('aria-pressed', String(selected));
        const ico = el('span', 'kb-qa-model-item-check');
        if (selected) ico.innerHTML = _icon('check', 'ui-icon');
        const main = el('span', 'kb-qa-model-item-main');
        const name = el('span', 'kb-qa-model-item-name', `${e.providerLabel || e.provider} · ${e.modelName || e.model}`);
        const sub = el('span', 'kb-qa-model-item-sub', e.model || '');
        main.append(name, sub);
        row.append(ico, main);
        list.appendChild(row);
      }
    }
    pop.appendChild(list);

    const foot = el('div', 'kb-qa-model-pop-foot');
    const manageBtn = _elementFromHtml(_uiButton({
      label: _tr('kb.workbench.qa_model_manage', '去设置管理模型'),
      role: 'secondary',
      icon: 'settings',
      className: 'kb-qa-model-pop-manage',
    }));
    foot.appendChild(manageBtn);
    pop.appendChild(foot);

    overlay.appendChild(pop);
    document.body.appendChild(overlay);
    const modal = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-qa-model-pop',
      initialFocus: '[aria-pressed="true"]',
      fallbackFocus: '#kb-qa-tools',
      trigger,
    });
    closeBtn.addEventListener('click', () => modal.close('close-button'));
    defRow.addEventListener('click', () => {
      _selectQaModel(null);
      modal.close('select');
    });
    for (const row of list.querySelectorAll('.kb-qa-model-item[data-entry-id]')) {
      row.addEventListener('click', () => {
        const entry = entries.find((item) => String(item.entryId || '') === row.dataset.entryId);
        if (entry) _selectQaModel(entry);
        modal.close('select');
      });
    }
    manageBtn.addEventListener('click', () => {
      modal.close('manage', { restoreFocus: false });
      if (typeof window.setView === 'function') window.setView('settings');
      if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
    });
  }

  function _selectQaModel(entry) {
    if (entry) {
      _qaModelEntry = {
        entryId: entry.entryId,
        provider: entry.provider,
        providerLabel: entry.providerLabel || entry.provider,
        model: entry.model,
        modelName: entry.modelName || entry.model,
      };
    } else {
      _qaModelEntry = null;
    }
    try {
      localStorage.setItem(QA_MODEL_STORE_KEY, _qaModelEntry ? String(_qaModelEntry.entryId) : '');
    } catch (_) { /* localStorage 不可用 */ }
    _renderQaModelChip();
    if (typeof uiToast === 'function') {
      uiToast(_qaModelEntry ? `问答模型已切换：${_qaModelEntry.providerLabel || _qaModelEntry.provider} · ${_qaModelEntry.modelName}` : '已切回默认模型', { variant: 'success', timeoutMs: 2000 });
    }
  }

  // 无输入时发送按钮置灰；有内容恢复可用
  function _syncSendState() {
    const input = document.getElementById('kb-qa-input');
    const send = document.getElementById('kb-qa-send');
    if (!input || !send) return;
    send.disabled = !input.value.trim();
  }

  // 问答输入框自动扩容：多行输入随内容增高，避免长文本在单行里向前滚动、
  // 看不到前面输入的内容。上限与 CSS `.kb-qa-input { max-height }` 对齐，
  // 超过上限才启用纵向滚动；发送清空后复位到单行高度。
  const KB_QA_INPUT_MIN_HEIGHT = 26;
  const KB_QA_INPUT_MAX_HEIGHT = 120;
  function _autoGrowQaInput(el) {
    const input = el || document.getElementById('kb-qa-input');
    if (!input || !input.style) return;
    input.style.height = 'auto';
    const contentHeight = Number(input.scrollHeight) || 0;
    const next = Math.min(Math.max(contentHeight, KB_QA_INPUT_MIN_HEIGHT), KB_QA_INPUT_MAX_HEIGHT);
    input.style.height = `${next}px`;
    input.style.overflowY = contentHeight > KB_QA_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }

  function _submitQa() {
    const input = document.getElementById('kb-qa-input');
    if (!input) return;
    const q = input.value;
    if (!q || !q.trim()) return;
    input.value = '';
    _autoGrowQaInput(input);
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
        uiToast(imported ? _tr('kb.workbench.dir_import_done', '已导入 {count} 个文件（扫描 {scanned}）', { count: imported, scanned }) : _tr('kb.workbench.dir_import_none', '所选文件夹没有可导入的文件'), {
          variant: imported ? 'success' : 'warning', timeoutMs: 2500,
        });
      }
      _loadAll();
    } catch (err) {
      _log.warn('import dir failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.dir_import_failed', '导入文件夹失败'), { variant: 'error' });
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
    if (w > 100) return _tr('kb.workbench.rename_err_too_long', '名称过长，请缩短');
    return '';
  }

  async function _kbRename(path, isDir) {
    const cur = String(path || '').split('/').pop() || '';
    const next = typeof uiPrompt === 'function' ? await uiPrompt(_tr('kb.workbench.rename_prompt', '重命名：'), cur) : window.prompt(_tr('kb.workbench.rename_prompt', '重命名：'), cur);
    if (!next || !next.trim() || next.trim() === cur) return;
    // 父路径：仅当 path 含斜杠时才取前缀；顶层条目（如库 "2"）父路径为空
    const slashIdx = String(path || '').lastIndexOf('/');
    const parent = slashIdx >= 0 ? String(path).slice(0, slashIdx) : '';
    const newName = String(next).trim();
    // 名字预校验：非法字符 / 点开头 / 文件扩展名 / 长度
    const bad = _kbValidateName(newName, !isDir);
    if (bad) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.rename_failed', '重命名失败：') + bad, { variant: 'warning' });
      return;
    }
    const dst = parent ? `${parent}/${newName}` : newName;
    // 预检查：同级已有同名条目 → 直接提示，不发 IPC
    if (_kbSiblingExists(parent, newName)) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.rename_failed', '重命名失败：') + _tr('kb.workbench.rename_err_exists', '该名称已存在，请换一个名称'), { variant: 'warning' });
      return;
    }
    try {
      const res = await window.cogseed.invoke('contexts.rename', { src: path, dst });
      if (res && res.ok === false) {
        const msg = String(res.error || '');
        if (typeof uiToast === 'function') {
          let friendly = null;
          if (/already exists|exists|eexist|enotempty/i.test(msg)) friendly = _tr('kb.workbench.rename_err_exists', '该名称已存在，请换一个名称');
          else if (/unsupported extension/i.test(msg)) friendly = _tr('kb.workbench.rename_err_extension', '文件名需保留支持的扩展名（.md .txt .pdf .docx 等）');
          else if (/invalid character/i.test(msg)) friendly = _tr('kb.workbench.rename_err_invalid_char', '名称含非法字符');
          else if (/invalid path segment/i.test(msg)) friendly = _tr('kb.workbench.rename_err_invalid_path', '名称无效，请检查是否包含非法路径');
          else if (/hidden entries are reserved/i.test(msg)) friendly = _tr('kb.workbench.rename_err_hidden', '名称不能以 . 开头');
          else if (/too long/i.test(msg)) friendly = _tr('kb.workbench.rename_err_too_long', '名称过长，请缩短');
          else if (/eacces|eperm/i.test(msg)) friendly = _tr('kb.workbench.rename_err_no_permission', '没有权限重命名');
          uiToast(_tr('kb.workbench.rename_failed', '重命名失败：') + (friendly || _esc(msg)), { variant: 'error' });
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
        ? await uiConfirmDanger({ title: _tr('kb.workbench.delete_to_trash', '删除到回收站'), message: _tr('kb.workbench.delete_confirm', '确认删除「{name}」？删除后可在回收站恢复。', { name }), dangerLabel: _tr('kb.workbench.menu_delete', '删除'), cancelLabel: _tr('kb.workbench.cancel', '取消') })
        : window.confirm(_tr('kb.workbench.delete_confirm_short', '确认删除「{name}」？', { name }));
    } catch (_) { return; }
    if (!ok) return;
    try {
      const res = await window.cogseed.invoke('contexts.delete', { path });
      if (res && res.ok === false) { if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.delete_failed', '删除失败：') + _esc(res.error || 'unknown'), { variant: 'error' }); return; }
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.delete_done', '已删除到回收站（设置 → 回收站可恢复）'), { variant: 'success', timeoutMs: 3000 });
      _loadAll();
    } catch (err) { _log.warn('delete failed', err); if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.delete_failed_short', '删除失败'), { variant: 'error' }); }
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
    el.innerHTML = items.map((it) => _uiButton({
      label: it.label,
      icon: it.icon,
      role: it.danger ? 'danger' : 'ghost',
      size: 'sm',
      className: 'kb-ctx-menu-item',
      attrs: { 'data-kb-ctx': String(it.key) },
    })).join('');
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
      { key: 'rename', label: '重命名', icon: 'edit-pencil', fn: () => _kbRename(path, isDir) },
      { key: 'delete', label: '删除到回收站', icon: 'trash-2', danger: true, fn: () => _kbDelete(path) },
    ];
    if (!isDir) items.push({ key: 'reveal', label: '在文件夹中显示', icon: 'folder-open', fn: () => _kbReveal(path) });
    // 文档级脑图：以这一份文档为中心主题（整库脑图是按目录聚合的，多文档库里
    // 根主题会变成"这个库是什么"，一级分支按文件分而不是按内容主题分）。
    if (!isDir) items.unshift({ key: 'mindmap', label: '生成脑图（本文档）', icon: 'brain-circuit', fn: () => _kbMindmapForDoc(path) });
    _kbMenuShow(items, x, y);
  }

  function _kbExternalFileMenu(path, x, y) {
    _kbMenuShow([
      { key: 'reveal', label: _tr('kb.workbench.reveal_file', '在文件夹中显示'), icon: 'folder-open', fn: () => _kbReveal(path) },
    ], x, y);
  }

  // ── 共享知识库（空间）重命名 / 删除（spaces.update / spaces.delete）──
  function _kbSpaceMenu(spaceId, x, y) {
    _kbMenuShow([
      { key: 'rename', label: '重命名', icon: 'edit-pencil', fn: () => _kbRenameSpace(spaceId) },
      { key: 'members', label: '知识库成员', icon: 'users', fn: () => _kbMembersDialog(spaceId) },
      { key: 'delete', label: '删除共享知识库', icon: 'trash-2', danger: true, fn: () => _kbDeleteSpace(spaceId) },
    ], x, y);
  }

  // ── 共享库文件右键菜单（对齐 ima：置顶/编辑标签/重命名/成员权限子菜单/移动到/复制到/删除）──
  function _kbSpaceFileMenu(path, x, y) {
    _kbMenuHide();
    const el = document.createElement('div');
    el.className = 'kb-ctx-menu kb-file-menu';
    el.innerHTML = `
      ${_uiButton({ label: _tr('kb.workbench.menu_mindmap', '生成脑图（本文档）'), icon: 'brain-circuit', role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-fm': 'mind' } })}
      ${_uiButton({ label: _tr('kb.workbench.menu_pin', '置顶'), icon: 'pin', role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-fm': 'pin' } })}
      ${_uiButton({ label: _tr('kb.workbench.menu_tag', '编辑标签'), icon: 'tag', role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-fm': 'tag' } })}
      ${_uiButton({ label: _tr('kb.workbench.menu_rename', '重命名'), icon: 'edit-pencil', role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-fm': 'rename' } })}
      <div class="kb-ctx-menu-item kb-has-sub" data-fm="perm" role="button" tabindex="0">${_icon('lock', 'kb-ctx-menu-icon')}<span>${_tr('kb.workbench.menu_perm', '成员权限')}</span><span class="kb-import-caret">${_icon('chevron-right', 'kb-ctx-menu-caret-icon')}</span>
        <div class="kb-ctx-sub" data-sub="perm">
          ${_uiButton({ label: _tr('kb.workbench.perm_view_export', '内容可查看和导出'), icon: 'check', role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item is-selected', attrs: { 'data-perm': 'view_export' } })}
          ${_uiButton({ label: _tr('kb.workbench.perm_view_only', '内容可查看但不可导出'), role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-perm': 'view_only' } })}
          ${_uiButton({ label: _tr('kb.workbench.perm_hidden', '内容不可查看'), role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-perm': 'hidden' } })}
        </div>
      </div>
      ${_uiButton({ label: _tr('kb.workbench.menu_move', '移动到'), icon: 'arrow-right', role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-fm': 'move' } })}
      ${_uiButton({ label: _tr('kb.workbench.menu_copy', '复制到'), icon: 'copy', role: 'ghost', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-fm': 'copy' } })}
      ${_uiButton({ label: _tr('kb.workbench.menu_delete', '删除'), icon: 'trash-2', role: 'danger', size: 'sm', className: 'kb-ctx-menu-item', attrs: { 'data-fm': 'del' } })}`;
    el.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    el.style.top = Math.min(y, window.innerHeight - 300) + 'px';
    document.body.appendChild(el);
    _kbMenuEl = el;
    const close = () => { el.remove(); _kbMenuEl = null; };
    const permLabel = { view_export: _tr('kb.workbench.perm_view_export', '内容可查看和导出'), view_only: _tr('kb.workbench.perm_view_only', '内容可查看但不可导出'), hidden: _tr('kb.workbench.perm_hidden', '内容不可查看') };
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
      if (act === 'mind') _kbMindmapForDoc(path);
      else if (act === 'pin') { if (typeof uiToast === 'function') uiToast('置顶：即将上线', { variant: 'info' }); }
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
        : window.confirm(_tr('kb.workbench.delete_confirm_short', '确认删除「{name}」？', { name }));
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
    const trigger = document.activeElement;
    _kbMenuHide();
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-members-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-members-dlg" role="dialog" aria-modal="true" aria-labelledby="kb-members-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-members-title" id="kb-members-title">${_icon('users', 'kb-members-title-icon')}<span>${_esc(_tr('kb.workbench.members_title', '知识库成员'))}</span></h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.members_close', '关闭知识库成员弹窗'), icon: 'x', className: 'kb-members-close' })}
        </header>
        <div class="ui-modal__body kb-members-body">
          <div class="kb-members-search">${_uiInput({ id: 'kb-members-search-input', type: 'search', placeholder: _tr('kb.workbench.members_search', '搜索知识库成员'), attrs: { autocomplete: 'off' } })}</div>
          <div class="kb-members-list">
            <div class="kb-members-item">
              <span class="kb-members-avatar">${_esc(_tr('kb.workbench.me', '我'))}</span>
              <span class="kb-members-name">${_esc(_tr('kb.workbench.me', '我'))}</span>
              <span class="kb-members-role">${_esc(_tr('kb.workbench.members_owner_role', '创建者'))}</span>
            </div>
          </div>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    const modal = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-members-dlg',
      initialFocus: '.kb-members-search input',
      fallbackFocus: '#kb-wb-members',
      trigger,
    });
    overlay.querySelector('.kb-members-close').addEventListener('click', () => modal.close('close'));
    overlay.querySelector('.kb-members-search input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      overlay.querySelectorAll('.kb-members-item').forEach((item) => {
        const name = item.querySelector('.kb-members-name').textContent.toLowerCase();
        item.style.display = q && !name.includes(q) ? 'none' : '';
      });
    });
  }

  // ── 共享知识库分享弹窗（图 2）+ 权限设置弹窗（图 1，对标 ima）──
  let _kbShareDlg = null; // 分享弹窗
  let _kbPermDlg = null;  // 权限设置弹窗
  let _kbShareDlgController = null;
  let _kbPermDlgController = null;

  function _kbCurSpace() {
    return _state.spaces.find((s) => s.space_id === _state.spaceId) || null;
  }

  /**
   * 共享知识库的「分享」目前是**待开发**：飞书分享 / 复制链接 / 知识码 / 权限设置
   * 这一整套还没有真正落地，弹出来只会让人以为能用。按仓库既有约定
   * （kb-eco 的「发现待开发」）显示为待开发：按钮挂 chip，点击给一句说明。
   *
   * 真要做时把这里翻成 true 即可——下面 `_kbShareDialogOpen` 的实现原样保留。
   */
  const KB_SHARE_READY = false;

  /** 「分享（待开发）」说明小弹层：说清现状，别让用户白点。 */
  function _kbShareSoonOpen() {
    const trigger = document.activeElement;
    _kbMenuHide();
    _kbPermDlgClose();
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop kb-share-pop--soon" role="dialog" aria-modal="true" aria-labelledby="kb-share-soon-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-share-soon-title"><span class="kb-share-pop-head-ico">${_icon('share-2', 'kb-share-pop-head-icon')}</span>分享<span class="kb-wb-soon-chip" data-wb-text="kb.workbench.coming_soon"></span></h2>
          </div>
          ${_uiIconButton({ label: '关闭分享说明', icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body">
          <div class="kb-wb-right-placeholder kb-share-soon-body">
            共享知识库的分享（分享方式 / 飞书分享 / 复制链接 / 知识码）还在开发中，暂未开放。<br>
            当前可以用「成员」把库内资料共享给同一空间的同事。
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions">
          ${_uiButton({ label: '知道了', role: 'primary', className: 'kb-share-pop-btn', attrs: { id: 'kb-share-soon-ok' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    _kbShareDlg = overlay;
    _kbShareDlgController = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '#kb-share-soon-ok',
      fallbackFocus: '#kb-wb-share',
      trigger,
      onClose: () => {
        if (_kbShareDlg === overlay) { _kbShareDlg = null; _kbShareDlgController = null; }
      },
    });
    overlay.querySelector('.kb-share-pop-close')?.addEventListener('click', () => _kbShareDlgController?.close());
    overlay.querySelector('#kb-share-soon-ok')?.addEventListener('click', () => _kbShareDlgController?.close());
  }

  // 图 2：分享弹窗 —— 知识库信息卡 + 分享方式行（点击跳权限设置）+ 复制链接/生成知识码
  function _kbShareDialogOpen() {
    const trigger = document.activeElement;
    _kbMenuHide();
    const sp = _kbCurSpace();
    const isSpace = !!_state.spaceId;
    if (!isSpace || !sp) {
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_pick_first', '请先选择共享知识库'), { variant: 'warning' });
      return;
    }
    _kbPermDlgClose();
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop" role="dialog" aria-modal="true" aria-labelledby="kb-share-pop-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-share-pop-title"><span class="kb-share-pop-head-ico">${_icon('share-2', 'kb-share-pop-head-icon')}</span>${_esc(_tr('kb.workbench.share_title', '分享'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.share_close', '关闭分享弹窗'), icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body kb-share-pop-body">
          <div class="kb-share-pop-card">
            <span class="kb-share-pop-folder">${_icon('folder', 'kb-share-pop-folder-icon')}</span>
            <div class="kb-share-pop-card-meta">
              <div class="kb-share-pop-count">${_esc(sp.name || _tr('kb.workbench.share_shared_lib', '共享知识库'))}</div>
              <div class="kb-share-pop-creator"><span class="kb-share-pop-avatar">${_esc(_tr('kb.workbench.me', '我'))}</span>${_esc(_tr('kb.workbench.share_creator_me', '我创建'))}</div>
            </div>
          </div>
          <div class="kb-share-pop-row" id="kb-share-pop-perm-row" role="button" tabindex="0">
            <span class="kb-share-pop-row-label">${_esc(_tr('kb.workbench.share_way', '选择分享方式'))}</span>
            <span class="kb-share-pop-row-hint">${_kbSharePermSummary(sp)} <span class="kb-share-pop-row-arrow">${_icon('chevron-right', 'kb-share-row-arrow-icon')}</span></span>
          </div>
          <div class="kb-share-pop-row" id="kb-share-pop-status-row" role="button" tabindex="0">
            <span class="kb-share-pop-row-label">${_esc(_tr('kb.workbench.share_to_feishu', '分享到飞书'))}</span>
            <span class="kb-share-pop-row-hint" id="kb-share-pop-status-hint">${_esc(_tr('kb.workbench.share_status_none', '未分享'))} <span class="kb-share-pop-row-arrow">${_icon('chevron-right', 'kb-share-row-arrow-icon')}</span></span>
          </div>
          <div class="kb-share-pop-row" id="kb-share-cogseed-row" role="button" tabindex="0">
            <span class="kb-share-pop-row-label">${_esc(_tr('kb.workbench.share_to_cogseed', '发布到 CogSeed 问答'))}</span>
            <span class="kb-share-pop-row-hint" id="kb-share-cogseed-hint">${_esc(_tr('kb.workbench.share_status_unpublished', '未发布'))} <span class="kb-share-pop-row-arrow">${_icon('chevron-right', 'kb-share-row-arrow-icon')}</span></span>
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions">
          ${_uiButton({ label: _tr('kb.workbench.share_copy_link', '复制链接'), role: 'secondary', icon: 'link', className: 'kb-share-pop-btn', attrs: { id: 'kb-share-pop-copy-link' } })}
          ${_uiButton({ label: _tr('kb.workbench.share_gen_code', '生成知识码'), role: 'secondary', icon: 'qr-code', className: 'kb-share-pop-btn is-code', attrs: { id: 'kb-share-pop-code' } })}
          ${_uiButton({ label: _tr('kb.workbench.share_manage', '管理'), role: 'secondary', icon: 'settings', className: 'kb-share-pop-btn is-manage', attrs: { id: 'kb-share-pop-manage', hidden: true } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    _kbShareDlg = overlay;
    _kbShareDlgController = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '#kb-share-pop-copy-link',
      fallbackFocus: '#kb-wb-share',
      trigger,
      onClose: () => {
        if (_kbShareDlg === overlay) _kbShareDlg = null;
        _kbShareDlgController = null;
      },
    });
    overlay.querySelector('.kb-share-pop-close').addEventListener('click', () => _kbShareDlgClose());
    overlay.querySelectorAll('.kb-share-pop-row[role="button"]').forEach((row) => {
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        row.click();
      });
    });
    // 点分享方式行 → 跳权限设置弹窗
    overlay.querySelector('#kb-share-pop-perm-row').addEventListener('click', () => {
      _kbShareDlgClose({ restoreFocus: false });
      _kbPermDialogOpen();
    });
    // 分享状态行 → 已分享时跳管理面板
    overlay.querySelector('#kb-share-pop-status-row').addEventListener('click', async () => {
      const state = await _kbShareStateOf(sp.space_id);
      if (state) {
        _kbShareDlgClose({ restoreFocus: false });
        _kbShareManageOpen();
      } else {
        await _kbSharePublish(sp);
      }
    });
    // CogSeed 问答行 → 发布到 cogseed-share 后端（权限弹窗设置真实生效）
    overlay.querySelector('#kb-share-cogseed-row').addEventListener('click', async () => {
      const state = await _kbCogseedStateOf(sp.space_id);
      if (state) {
        _kbShareDlgClose({ restoreFocus: false });
        _kbCogseedManageOpen();
      } else {
        await _kbCogseedPublish(sp);
      }
    });
    // 复制链接：优先用飞书分享链接（未分享则先发布）
    overlay.querySelector('#kb-share-pop-copy-link').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.setAttribute('aria-busy', 'true');
      _setUiButtonPresentation(btn, _tr('kb.workbench.share_busy', '分享中…'));
      try {
        let state = await _kbShareStateOf(sp.space_id);
        if (!state) state = await _kbSharePublish(sp, { silent: true });
        if (!state) return;
        await navigator.clipboard.writeText(state.url);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_link_copied', '飞书分享链接已复制'), { variant: 'success', timeoutMs: 2000 });
        _kbRefreshShareStatus(sp);
      } catch (err) {
        _log.warn('kb share copy failed', err);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_failed', '分享失败：') + ((err && err.message) || String(err)), { variant: 'error' });
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-loading');
        btn.removeAttribute('aria-busy');
        _setUiButtonPresentation(btn, _tr('kb.workbench.share_copy_link', '复制链接'), 'link');
      }
    });
    // 生成知识码（二维码）：先确保已分享
    overlay.querySelector('#kb-share-pop-code').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        let state = await _kbShareStateOf(sp.space_id);
        if (!state) state = await _kbSharePublish(sp, { silent: true });
        if (!state) return;
        _kbQrCodeShow(state.url, sp.name);
      } catch (err) {
        _log.warn('kb share qr failed', err);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_code_failed', '生成知识码失败：') + ((err && err.message) || String(err)), { variant: 'error' });
      } finally {
        btn.disabled = false;
      }
    });
    // 管理面板
    overlay.querySelector('#kb-share-pop-manage').addEventListener('click', (e) => {
      e.stopPropagation();
      _kbShareDlgClose({ restoreFocus: false });
      _kbShareManageOpen();
    });
    _kbRefreshShareStatus(sp);
    _kbRefreshCogseedStatus(sp);
  }

  // 读取空间分享状态（无 → null）
  async function _kbShareStateOf(spaceId) {
    try {
      const res = await window.cogseed.invoke('kb.share.get', { spaceId });
      return (res && res.state) || null;
    } catch {
      return null;
    }
  }

  // ── CogSeed 问答分享（方案 C）──────────────────────────────────────────
  async function _kbCogseedStateOf(spaceId) {
    try {
      const res = await window.cogseed.invoke('kb.share.cogseed.get', { spaceId });
      return (res && res.state) || null;
    } catch {
      return null;
    }
  }

  async function _kbRefreshCogseedStatus(sp) {
    if (!_kbShareDlg) return;
    const hint = _kbShareDlg.querySelector('#kb-share-cogseed-hint');
    if (!hint) return;
    const state = await _kbCogseedStateOf(sp.space_id);
    if (state) {
      hint.innerHTML = `${_esc(state.url)}<span class="kb-share-pop-status-dot"></span><span class="kb-share-pop-row-arrow">${_icon('chevron-right', 'kb-share-row-arrow-icon')}</span>`;
    } else {
      hint.innerHTML = `未发布 <span class="kb-share-pop-row-arrow">${_icon('chevron-right', 'kb-share-row-arrow-icon')}</span>`;
    }
  }

  async function _kbCogseedPublish(sp) {
    try {
      const res = await window.cogseed.invoke('kb.share.cogseed.publish', { spaceId: sp.space_id });
      if (res && res.ok) {
        if (typeof uiToast === 'function') uiToast('已发布到 CogSeed 问答', { variant: 'success', timeoutMs: 2000 });
        _kbRefreshCogseedStatus(sp);
        return res.state;
      }
      if (res && res.code === 'not_configured') {
        _kbShareDlgClose({ restoreFocus: false });
        _kbCogseedConfigDialog(sp);
        return null;
      }
      if (typeof uiToast === 'function') uiToast('发布失败：' + ((res && res.error) || '未知错误'), { variant: 'error', timeoutMs: 4000 });
      return null;
    } catch (err) {
      _log.warn('kb cogseed publish failed', err);
      if (typeof uiToast === 'function') uiToast('发布失败：' + ((err && err.message) || String(err)), { variant: 'error' });
      return null;
    }
  }

  // CogSeed 共享服务配置弹窗（后端地址 + API Key）
  function _kbCogseedConfigDialog(sp) {
    const trigger = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop kb-share-pop--config" role="dialog" aria-modal="true" aria-labelledby="kb-cogseed-config-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-cogseed-config-title"><span class="kb-share-pop-head-ico">${_icon('link', 'kb-share-pop-head-icon')}</span>${_esc(_tr('kb.workbench.cogseed_config_title', '配置 CogSeed 共享服务'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.cogseed_config_close', '关闭 CogSeed 共享服务配置弹窗'), icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body">
          <div class="kb-share-config-tip">${_esc(_tr('kb.workbench.cogseed_config_tip', '发布到 CogSeed 问答需要共享服务地址与 API Key（由 CogSeed 共享服务提供方发放；自托管可自行部署）：'))}</div>
          <div class="kb-share-config-field">
            <label class="kb-share-config-label" for="kb-cogseed-baseurl">${_esc(_tr('kb.workbench.cogseed_config_baseurl', '服务地址'))}</label>
            ${_uiInput({ id: 'kb-cogseed-baseurl', className: 'kb-share-config-input', placeholder: 'https://share.cogseed.dev', attrs: { autocomplete: 'off', spellcheck: 'false' } })}
          </div>
          <div class="kb-share-config-field">
            <label class="kb-share-config-label" for="kb-cogseed-apikey">API Key</label>
            ${_uiInput({ id: 'kb-cogseed-apikey', type: 'password', className: 'kb-share-config-input', placeholder: _tr('kb.workbench.cogseed_config_apikey', '服务方发放的密钥'), attrs: { autocomplete: 'off', spellcheck: 'false' } })}
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions kb-share-pop-actions--right">
          ${_uiButton({ label: _tr('kb.workbench.cancel', '取消'), role: 'secondary', className: 'kb-share-pop-btn', attrs: { id: 'kb-cogseed-config-cancel' } })}
          ${_uiButton({ label: _tr('kb.workbench.cogseed_config_save', '保存并发布'), role: 'primary', className: 'kb-share-pop-btn', attrs: { id: 'kb-cogseed-config-save' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    const modal = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '#kb-cogseed-baseurl',
      fallbackFocus: '#kb-wb-share',
      trigger,
    });
    overlay.querySelector('.kb-share-pop-close').addEventListener('click', () => modal.close('close'));
    overlay.querySelector('#kb-cogseed-config-cancel').addEventListener('click', () => modal.close('cancel'));
    overlay.querySelector('#kb-cogseed-config-save').addEventListener('click', async (e) => {
      const baseUrl = overlay.querySelector('#kb-cogseed-baseurl').value.trim();
      const apiKey = overlay.querySelector('#kb-cogseed-apikey').value.trim();
      if (!baseUrl || !apiKey) {
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.cogseed_config_need_credentials', '请填写服务地址与 API Key'), { variant: 'warning' });
        return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.setAttribute('aria-busy', 'true');
      _setUiButtonPresentation(btn, _tr('kb.workbench.cogseed_config_save', '保存并发布'));
      try {
        const res = await window.cogseed.invoke('kb.share.cogseed.config.set', { baseUrl, apiKey });
        if (!res || res.ok !== true) throw new Error((res && res.error) || _tr('kb.workbench.save_failed', '保存失败'));
        modal.close('submit', { restoreFocus: false });
        await _kbCogseedPublish(sp);
      } catch (err) {
        _log.warn('kb cogseed config save failed', err);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.save_failed_prefix', '保存失败：') + ((err && err.message) || String(err)), { variant: 'error' });
        btn.disabled = false;
        btn.classList.remove('is-loading');
        btn.removeAttribute('aria-busy');
      }
    });
  }

  // CogSeed 问答管理面板（成员审核 + 复制链接 + 撤销）
  async function _kbCogseedManageOpen() {
    const trigger = document.activeElement;
    _kbMenuHide();
    const sp = _kbCurSpace();
    if (!sp) return;
    const state = await _kbCogseedStateOf(sp.space_id);
    let members = [];
    try {
      const mres = await window.cogseed.invoke('kb.share.cogseed.members', { spaceId: sp.space_id });
      members = (mres && mres.members) || [];
    } catch { /* 成员拉取失败不阻断 */ }
    const pending = members.filter((m) => m.status === 'pending');
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop kb-share-pop--manage" role="dialog" aria-modal="true" aria-labelledby="kb-cogseed-manage-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-cogseed-manage-title"><span class="kb-share-pop-head-ico">${_icon('share-2', 'kb-share-pop-head-icon')}</span>${_esc(_tr('kb.workbench.cogseed_manage_title', 'CogSeed 问答分享管理'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.cogseed_manage_close', '关闭 CogSeed 问答分享管理弹窗'), icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body">
          ${state ? `<div class="kb-share-manage-item">
            <div class="kb-share-manage-item-head">
              <span class="kb-share-manage-item-name">${_esc(state.spaceName)}</span>
              <span class="kb-share-manage-item-badge is-anyone">${_esc({ direct: _tr('kb.workbench.join_direct', '直接加入'), apply: _tr('kb.workbench.join_badge_apply', '需申请'), invite: _tr('kb.workbench.join_badge_invite', '仅邀请') }[state.joinMode] || state.joinMode)}</span>
            </div>
            <div class="kb-share-manage-item-meta">${_esc(state.url)}</div>
            <div class="kb-share-manage-item-actions">
              ${_uiButton({ label: _tr('kb.workbench.share_copy_link', '复制链接'), role: 'secondary', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-cogseed-act': 'copy' } })}
              ${_uiButton({ label: _tr('kb.workbench.share_revoke', '撤销'), role: 'danger', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-cogseed-act': 'revoke' } })}
            </div>
          </div>` : _uiEmptyState({ kind: 'quiet', title: _tr('kb.workbench.share_status_unpublished', '未发布') })}
          <div class="kb-share-cogseed-members">
            <div class="kb-share-cogseed-members-title">${_esc(_tr('kb.workbench.cogseed_members_title', '成员申请'))}${pending.length ? _esc(_tr('kb.workbench.cogseed_members_pending', '（{count} 待审）', { count: pending.length })) : ''}</div>
            ${pending.length === 0 ? _uiEmptyState({ kind: 'quiet', title: _tr('kb.workbench.cogseed_members_empty', '暂无待审申请') }) : ''}
            ${pending.map((m) => `
              <div class="kb-share-manage-item" data-member-id="${m.id}">
                <div class="kb-share-manage-item-head"><span class="kb-share-manage-item-name">${_esc(m.display_name || _tr('kb.workbench.anonymous_guest', '匿名访客'))}</span></div>
                <div class="kb-share-manage-item-meta">${_esc(m.note || _tr('kb.workbench.no_reason', '无理由'))} · ${_esc(String(m.created_at || '').slice(0, 16))}</div>
                <div class="kb-share-manage-item-actions">
                  ${_uiButton({ label: _tr('kb.workbench.approve', '通过'), role: 'secondary', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-member-act': 'approve' } })}
                  ${_uiButton({ label: _tr('kb.workbench.reject', '拒绝'), role: 'danger', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-member-act': 'reject' } })}
                </div>
              </div>`).join('')}
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions kb-share-pop-actions--right">
          ${_uiButton({ label: _tr('kb.workbench.close', '关闭'), role: 'secondary', className: 'kb-share-pop-btn', attrs: { id: 'kb-cogseed-manage-close' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    const modal = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '[data-cogseed-act="copy"], #kb-cogseed-manage-close',
      fallbackFocus: '#kb-wb-share',
      trigger,
    });
    overlay.querySelector('.kb-share-pop-close').addEventListener('click', () => modal.close('close'));
    overlay.querySelector('#kb-cogseed-manage-close').addEventListener('click', () => modal.close('close'));
    overlay.addEventListener('click', async (e) => {
      const actBtn = e.target.closest('[data-cogseed-act]');
      if (actBtn) {
        const act = actBtn.dataset.cogseedAct;
        if (act === 'copy') {
          try { await navigator.clipboard.writeText(state.url); uiToast && uiToast(_tr('kb.workbench.share_link_copied_short', '链接已复制'), { variant: 'success', timeoutMs: 1500 }); }
          catch { uiToast && uiToast(_tr('kb.workbench.share_copy_failed', '复制失败'), { variant: 'warning' }); }
        } else if (act === 'revoke') {
          const res = await window.cogseed.invoke('kb.share.cogseed.revoke', { spaceId: sp.space_id });
          if (res && res.ok) { uiToast && uiToast(_tr('kb.workbench.cogseed_revoked', '已撤销'), { variant: 'success' }); modal.close('revoke', { restoreFocus: false }); _kbShareDialogOpen(); }
          else uiToast && uiToast(_tr('kb.workbench.share_revoke_failed', '撤销失败'), { variant: 'error' });
        }
        return;
      }
      const memberBtn = e.target.closest('[data-member-act]');
      if (memberBtn) {
        const item = memberBtn.closest('[data-member-id]');
        const memberId = Number(item?.dataset.memberId);
        const verdict = memberBtn.dataset.memberAct;
        memberBtn.disabled = true;
        const res = await window.cogseed.invoke('kb.share.cogseed.review', { spaceId: sp.space_id, memberId, verdict });
        if (res && res.ok) { uiToast && uiToast(verdict === 'approve' ? _tr('kb.workbench.approved', '已通过') : _tr('kb.workbench.rejected', '已拒绝'), { variant: 'success', timeoutMs: 1500 }); modal.close('review', { restoreFocus: false }); _kbCogseedManageOpen(); }
        else { uiToast && uiToast(_tr('kb.workbench.action_failed', '操作失败'), { variant: 'error' }); memberBtn.disabled = false; }
      }
    });
  }

  // 刷新分享弹窗状态行：已分享显示链接状态 + 管理按钮
  async function _kbRefreshShareStatus(sp) {
    if (!_kbShareDlg) return;
    const hint = _kbShareDlg.querySelector('#kb-share-pop-status-hint');
    const manage = _kbShareDlg.querySelector('#kb-share-pop-manage');
    const state = await _kbShareStateOf(sp.space_id);
    if (!hint || !manage) return;
    if (state) {
      const accessText = { anyone: '互联网可读', tenant: '组织内可读', private: '已关闭' }[state.access] || state.access;
      hint.innerHTML = `${_esc(accessText)}<span class="kb-share-pop-status-dot"></span><span class="kb-share-pop-row-arrow">${_icon('chevron-right', 'kb-share-row-arrow-icon')}</span>`;
      manage.hidden = false;
    } else {
      hint.textContent = '未分享';
      manage.hidden = true;
    }
  }

  // 发布到飞书：返回分享状态；需要授权时引导重新授权
  async function _kbSharePublish(sp, opts = {}) {
    try {
      const res = await window.cogseed.invoke('kb.share.toFeishu', { spaceId: sp.space_id, access: 'anyone' });
      if (res && res.ok) {
        if (!opts.silent && typeof uiToast === 'function') {
          uiToast(_tr('kb.workbench.publish_done', '已发布到飞书'), { variant: 'success', timeoutMs: 2000 });
        }
        _kbRefreshShareStatus(sp);
        return res.state;
      }
      if (res && res.code === 'need_reauthorize') {
        const go = typeof uiConfirm === 'function'
          ? await uiConfirm(_tr('kb.workbench.publish_need_scope', '分享到飞书需要文档写权限，是否现在重新授权？'), _tr('kb.workbench.publish_reauthorize', '重新授权'))
          : window.confirm(_tr('kb.workbench.publish_need_scope', '分享到飞书需要文档写权限，是否现在重新授权？'));
        if (go) {
          try {
            await window.cogseed.invoke('kb.share.authorize', {});
            if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.publish_browser_hint', '请在浏览器完成飞书授权，完成后点击「复制链接」重试'), { variant: 'info', timeoutMs: 4000 });
          } catch (err) {
            _log.warn('kb share authorize failed', err);
          }
        }
        return null;
      }
      if (res && res.code === 'not_configured') {
        _kbShareDlgClose({ restoreFocus: false });
        _kbShareConfigDialog(sp);
        return null;
      }
      if (res && res.code === 'enterprise_share_disabled') {
        if (typeof uiToast === 'function') uiToast(res.error || _tr('kb.workbench.publish_blocked', '企业禁止组织外分享，请在飞书管理后台开启'), { variant: 'error', timeoutMs: 5000 });
        return null;
      }
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_failed', '分享失败：') + ((res && res.error) || _tr('kb.workbench.unknown_error', '未知错误')), { variant: 'error', timeoutMs: 4000 });
      return null;
    } catch (err) {
      _log.warn('kb share publish failed', err);
      if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_failed', '分享失败：') + ((err && err.message) || String(err)), { variant: 'error' });
      return null;
    }
  }

  // 分享应用配置弹窗（独立于消息机器人）：填写飞书开放平台应用 App ID/Secret
  function _kbShareConfigDialog(sp) {
    const trigger = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop kb-share-pop--config" role="dialog" aria-modal="true" aria-labelledby="kb-share-config-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-share-config-title"><span class="kb-share-pop-head-ico">${_icon('link', 'kb-share-pop-head-icon')}</span>${_esc(_tr('kb.workbench.feishu_config_title', '配置飞书分享'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.feishu_config_close', '关闭飞书分享配置弹窗'), icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body">
          <div class="kb-share-config-tip">${_tr('kb.workbench.feishu_config_tip', '分享到飞书需要一个飞书开放平台应用。到 <a href="https://open.feishu.cn/app" target="_blank" rel="noopener">open.feishu.cn/app</a> 创建企业自建应用后，在「凭证与基础信息」页复制 App ID 与 App Secret 填入：')}</div>
          <div class="kb-share-config-field">
            <label class="kb-share-config-label" for="kb-share-config-appid">App ID</label>
            ${_uiInput({ id: 'kb-share-config-appid', className: 'kb-share-config-input', placeholder: 'cli_xxxxxxxx', attrs: { autocomplete: 'off', spellcheck: 'false' } })}
          </div>
          <div class="kb-share-config-field">
            <label class="kb-share-config-label" for="kb-share-config-secret">App Secret</label>
            ${_uiInput({ id: 'kb-share-config-secret', type: 'password', className: 'kb-share-config-input', placeholder: _tr('kb.workbench.feishu_config_secret', '应用密钥'), attrs: { autocomplete: 'off', spellcheck: 'false' } })}
          </div>
          <div class="kb-share-config-tip is-warn">${_tr('kb.workbench.feishu_config_scopes', '应用需在「权限管理」开通：docx:document、wiki:wiki、drive:file、docs:permission.setting:write_only')}</div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions kb-share-pop-actions--right">
          ${_uiButton({ label: _tr('kb.workbench.cancel', '取消'), role: 'secondary', className: 'kb-share-pop-btn', attrs: { id: 'kb-share-config-cancel' } })}
          ${_uiButton({ label: _tr('kb.workbench.feishu_config_save_authorize', '保存并授权'), role: 'primary', className: 'kb-share-pop-btn', attrs: { id: 'kb-share-config-save' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    const modal = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '#kb-share-config-appid',
      fallbackFocus: '#kb-wb-share',
      trigger,
    });
    overlay.querySelector('.kb-share-pop-close').addEventListener('click', () => modal.close('close'));
    overlay.querySelector('#kb-share-config-cancel').addEventListener('click', () => modal.close('cancel'));
    overlay.querySelector('#kb-share-config-save').addEventListener('click', async (e) => {
      const appId = overlay.querySelector('#kb-share-config-appid').value.trim();
      const appSecret = overlay.querySelector('#kb-share-config-secret').value.trim();
      if (!appId || !appSecret) {
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.feishu_config_need_credentials', '请填写 App ID 与 App Secret'), { variant: 'warning' });
        return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.setAttribute('aria-busy', 'true');
      try {
        const res = await window.cogseed.invoke('kb.share.appConfig.set', { appId, appSecret });
        if (!res || res.ok !== true) throw new Error((res && res.error) || _tr('kb.workbench.save_failed', '保存失败'));
        modal.close('submit', { restoreFocus: false });
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.feishu_config_saved', '应用凭据已保存，正在发起授权…'), { variant: 'info', timeoutMs: 2500 });
        // 保存后触发重新授权（分享写权限 scope，走分享专用凭据）
        try {
          await window.cogseed.invoke('kb.share.authorize', {});
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.feishu_config_browser_hint', '请在浏览器完成飞书授权，完成后重新点击「复制链接」'), { variant: 'info', timeoutMs: 5000 });
        } catch (err) {
          _log.warn('kb share authorize after config failed', err);
        }
      } catch (err) {
        _log.warn('kb share app config save failed', err);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.save_failed_prefix', '保存失败：') + ((err && err.message) || String(err)), { variant: 'error' });
        btn.disabled = false;
        btn.classList.remove('is-loading');
        btn.removeAttribute('aria-busy');
      }
    });
  }

  // 知识码：二维码弹窗（复用内置 qrcode-generator）
  function _kbQrCodeShow(url, name) {
    const trigger = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop kb-share-pop--qr" role="dialog" aria-modal="true" aria-labelledby="kb-share-qr-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-share-qr-title"><span class="kb-share-pop-head-ico">${_icon('qr-code', 'kb-share-pop-head-icon')}</span>${_esc(_tr('kb.workbench.qr_title', '知识码'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.qr_close', '关闭知识码弹窗'), icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body">
          <div class="kb-share-qr-body">
            <div class="kb-share-qr-img" id="kb-share-qr-img"></div>
            <div class="kb-share-qr-name">${_esc(name || _tr('kb.workbench.share_shared_lib', '共享知识库'))}</div>
            <div class="kb-share-qr-url">${_esc(url)}</div>
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions">
          ${_uiButton({ label: _tr('kb.workbench.share_copy_link', '复制链接'), role: 'secondary', icon: 'link', className: 'kb-share-pop-btn', attrs: { id: 'kb-share-qr-copy' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    const modal = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '#kb-share-qr-copy',
      fallbackFocus: '#kb-wb-share',
      trigger,
    });
    overlay.querySelector('.kb-share-pop-close').addEventListener('click', () => modal.close('close'));
    // 生成二维码 SVG
    const host = overlay.querySelector('#kb-share-qr-img');
    try {
      if (typeof qrcode === 'function') {
        const code = qrcode(0, 'M');
        code.addData(url, 'Byte');
        code.make();
        host.innerHTML = code.createSvgTag(4, 4);
        const svg = host.querySelector('svg');
        if (svg) { svg.style.width = '160px'; svg.style.height = '160px'; }
      } else {
        host.innerHTML = `<span class="kb-share-qr-fallback">${_esc(_tr('kb.workbench.qr_unavailable', '扫码功能不可用'))}</span>`;
      }
    } catch (err) {
      _log.warn('kb qr generate failed', err);
      host.innerHTML = `<span class="kb-share-qr-fallback">${_esc(_tr('kb.workbench.qr_unavailable', '扫码功能不可用'))}</span>`;
    }
    overlay.querySelector('#kb-share-qr-copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(url);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_link_copied_short', '链接已复制'), { variant: 'success', timeoutMs: 1500 });
      } catch {
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.qr_copy_failed', '复制失败，请手动复制'), { variant: 'warning' });
      }
    });
  }

  // 分享管理面板（方案 B：列表 / 更新内容 / 撤销 / 复制链接 / 二维码）
  async function _kbShareManageOpen() {
    const trigger = document.activeElement;
    _kbMenuHide();
    let items = [];
    try {
      const res = await window.cogseed.invoke('kb.share.list', {});
      items = (res && res.items) || [];
    } catch (err) {
      _log.warn('kb share list failed', err);
    }
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop kb-share-pop--manage" role="dialog" aria-modal="true" aria-labelledby="kb-share-manage-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-share-manage-title"><span class="kb-share-pop-head-ico">${_icon('share-2', 'kb-share-pop-head-icon')}</span>${_esc(_tr('kb.workbench.share_manage_title', '分享管理'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.share_manage_close', '关闭分享管理弹窗'), icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body">
          <div class="kb-share-manage-list" id="kb-share-manage-list">
            ${items.length === 0 ? _uiEmptyState({
              kind: 'explained',
              title: _tr('kb.workbench.share_manage_empty_title', '还没有分享到飞书的知识库'),
              hint: _tr('kb.workbench.share_manage_empty_hint', '打开知识库 → 分享 → 复制链接'),
            }) : ''}
            ${items.map((item, idx) => `
              <div class="kb-share-manage-item" data-idx="${idx}">
                <div class="kb-share-manage-item-head">
                  <span class="kb-share-manage-item-name">${_esc(item.spaceName || item.spaceId)}</span>
                  <span class="kb-share-manage-item-badge is-${item.access}">${{ anyone: _tr('kb.workbench.share_access_anyone', '公开'), tenant: _tr('kb.workbench.share_access_tenant', '组织内'), private: _tr('kb.workbench.share_access_private', '私密') }[item.access] || item.access}</span>
                </div>
                <div class="kb-share-manage-item-meta">${_tr('kb.workbench.share_manage_item_meta', '{count} 个文档 · {url}', { count: item.fileCount, url: _esc(item.url) })}</div>
                <div class="kb-share-manage-item-actions">
                  ${_uiButton({ label: _tr('kb.workbench.share_copy_link', '复制链接'), role: 'secondary', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-act': 'copy' } })}
                  ${_uiButton({ label: _tr('kb.workbench.share_code_short', '知识码'), role: 'secondary', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-act': 'qr' } })}
                  ${_uiButton({ label: _tr('kb.workbench.share_update', '更新内容'), role: 'secondary', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-act': 'update' } })}
                  ${_uiButton({ label: _tr('kb.workbench.share_revoke', '撤销'), role: 'danger', size: 'sm', className: 'kb-share-manage-btn', attrs: { 'data-act': 'revoke' } })}
                </div>
              </div>`).join('')}
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions kb-share-pop-actions--right">
          ${_uiButton({ label: _tr('kb.workbench.close', '关闭'), role: 'secondary', className: 'kb-share-pop-btn', attrs: { id: 'kb-share-manage-close' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    const modal = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '[data-act="copy"], #kb-share-manage-close',
      fallbackFocus: '#kb-wb-share',
      trigger,
    });
    overlay.querySelector('.kb-share-pop-close').addEventListener('click', () => modal.close('close'));
    overlay.querySelector('#kb-share-manage-close').addEventListener('click', () => modal.close('close'));
    overlay.querySelector('#kb-share-manage-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const item = items[Number(btn.closest('.kb-share-manage-item').dataset.idx)];
      if (!item) return;
      const act = btn.dataset.act;
      if (act === 'copy') {
        try {
          await navigator.clipboard.writeText(item.url);
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_link_copied_short', '链接已复制'), { variant: 'success', timeoutMs: 1500 });
        } catch {
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_copy_failed', '复制失败'), { variant: 'warning' });
        }
      } else if (act === 'qr') {
        modal.close('qr', { restoreFocus: false });
        _kbQrCodeShow(item.url, item.spaceName);
      } else if (act === 'update') {
        btn.disabled = true;
        btn.classList.add('is-loading');
        btn.setAttribute('aria-busy', 'true');
        _setUiButtonPresentation(btn, _tr('kb.workbench.share_updating', '更新中…'));
        try {
          const res = await window.cogseed.invoke('kb.share.update', { spaceId: item.spaceId });
          if (res && res.ok) {
            if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_updated', '内容已更新'), { variant: 'success', timeoutMs: 1500 });
            modal.close('update', { restoreFocus: false });
            _kbShareManageOpen(); // 刷新面板
          } else {
            if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_update_failed_prefix', '更新失败：') + ((res && res.error) || _tr('kb.workbench.unknown_error', '未知错误')), { variant: 'error' });
            btn.disabled = false;
            btn.classList.remove('is-loading');
            btn.removeAttribute('aria-busy');
            _setUiButtonPresentation(btn, _tr('kb.workbench.share_update', '更新内容'));
          }
        } catch (err) {
          _log.warn('kb share update failed', err);
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_update_failed', '更新失败'), { variant: 'error' });
          btn.disabled = false;
          btn.classList.remove('is-loading');
          btn.removeAttribute('aria-busy');
          _setUiButtonPresentation(btn, _tr('kb.workbench.share_update', '更新内容'));
        }
      } else if (act === 'revoke') {
        const mode = typeof uiConfirm === 'function'
          ? await uiConfirm(_tr('kb.workbench.share_revoke_confirm', '撤销后链接将失效。同时删除飞书云端副本吗？'), _tr('kb.workbench.share_revoke_close_only', '仅关闭链接'), _tr('kb.workbench.share_revoke_delete_copy', '删除云端副本'))
          : (window.confirm(_tr('kb.workbench.share_revoke_confirm_plain', '撤销后链接将失效。是否同时删除飞书云端副本？')) ? 'delete_space' : 'close_link');
        if (!mode) return;
        btn.disabled = true;
        try {
          const res = await window.cogseed.invoke('kb.share.revoke', { spaceId: item.spaceId, mode });
          if (res && res.ok) {
            if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_revoked', '已撤销分享'), { variant: 'success', timeoutMs: 1500 });
            modal.close('revoke', { restoreFocus: false });
            _kbShareManageOpen();
          } else {
            if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_revoke_failed_prefix', '撤销失败：') + ((res && res.error) || _tr('kb.workbench.unknown_error', '未知错误')), { variant: 'error' });
            btn.disabled = false;
          }
        } catch (err) {
          _log.warn('kb share revoke failed', err);
          if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.share_revoke_failed', '撤销失败'), { variant: 'error' });
          btn.disabled = false;
        }
      }
    });
  }

  // 分享权限摘要（对齐图 2 说明行：成员可查看内容，加入无需确认）
  function _kbSharePermSummary(sp) {
    const perm = sp.member_permission || 'view_export';
    const join = sp.join_mode || 'direct';
    const permText = { view_export: '成员可查看导出', view_only: '成员仅可查看', hidden: '成员不可查看' }[perm] || '成员可查看导出';
    const joinText = { direct: '加入无需确认', apply: '加入需管理员确认', invite: '仅邀请加入' }[join] || '加入无需确认';
    return `${permText}，${joinText}`;
  }

  function _kbShareDlgClose(options) {
    if (_kbShareDlgController) _kbShareDlgController.close('close', options);
    else if (_kbShareDlg) { _kbShareDlg.remove(); _kbShareDlg = null; }
  }
  function _kbPermDlgClose(options) {
    if (_kbPermDlgController) _kbPermDlgController.close('close', options);
    else if (_kbPermDlg) { _kbPermDlg.remove(); _kbPermDlg = null; }
  }

  // 图 1：权限设置弹窗 —— 设为私密开关 + 成员权限/加入方式下拉 + 取消/确定
  function _kbPermDialogOpen() {
    const trigger = document.activeElement;
    _kbMenuHide();
    const sp = _kbCurSpace();
    if (!sp) return;
    const perm = sp.member_permission || 'view_export';
    const join = sp.join_mode || 'direct';
    const isPrivate = sp.shared !== true;
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay kb-share-pop-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="ui-modal ui-modal--sm kb-share-pop kb-share-pop--perm" role="dialog" aria-modal="true" aria-labelledby="kb-perm-title">
        <header class="ui-modal__header">
          <div class="ui-modal__heading">
            <h2 class="ui-modal__title kb-share-pop-head" id="kb-perm-title"><span class="kb-share-pop-head-ico">${_icon('lock', 'kb-share-pop-head-icon')}</span>${_esc(_tr('kb.workbench.perm_title', '权限设置'))}</h2>
          </div>
          ${_uiIconButton({ label: _tr('kb.workbench.perm_close', '关闭权限设置弹窗'), icon: 'x', className: 'kb-share-pop-close' })}
        </header>
        <div class="ui-modal__body">
          <div class="kb-share-perm-block">
            <div class="kb-share-perm-row">
              <div class="kb-share-perm-texts">
                <div class="kb-share-perm-title">${_esc(_tr('kb.workbench.perm_private', '设为私密'))}</div>
                <div class="kb-share-perm-desc">${_esc(_tr('kb.workbench.perm_private_hint', '开启后知识库仅自己可见'))}</div>
              </div>
              ${_uiSwitch({ label: _tr('kb.workbench.perm_private', '设为私密'), checked: isPrivate, attrs: { id: 'kb-perm-private' } })}
            </div>
          </div>
          <div class="kb-share-perm-block">
            <div class="kb-share-perm-row">
              <span class="kb-share-perm-title" id="kb-perm-member-label">${_esc(_tr('kb.workbench.menu_perm', '成员权限'))}</span>
              <div class="kb-share-select-wrap">
                ${_uiSelect({
                  id: 'kb-perm-member',
                  value: perm,
                  labelId: 'kb-perm-member-label',
                  options: [
                    { value: 'view_export', label: _tr('kb.workbench.perm_view_export', '内容可查看和导出') },
                    { value: 'view_only', label: _tr('kb.workbench.perm_view_only', '内容可查看但不可导出') },
                    { value: 'hidden', label: _tr('kb.workbench.perm_hidden', '内容不可查看') },
                  ],
                })}
              </div>
            </div>
            <div class="kb-share-perm-row">
              <span class="kb-share-perm-title" id="kb-perm-join-label">${_esc(_tr('kb.workbench.field_join_mode', '加入方式'))}</span>
              <div class="kb-share-select-wrap">
                ${_uiSelect({
                  id: 'kb-perm-join',
                  value: join,
                  labelId: 'kb-perm-join-label',
                  options: [
                    { value: 'direct', label: _tr('kb.workbench.join_direct', '直接加入') },
                    { value: 'apply', label: _tr('kb.workbench.join_apply', '申请加入（管理员批准）') },
                    { value: 'invite', label: _tr('kb.workbench.join_invite', '仅邀请加入') },
                  ],
                })}
              </div>
            </div>
          </div>
        </div>
        <footer class="ui-modal__footer kb-share-pop-actions kb-share-pop-actions--right">
          ${_uiButton({ label: _tr('kb.workbench.cancel', '取消'), role: 'secondary', className: 'kb-share-pop-btn', attrs: { id: 'kb-perm-cancel' } })}
          ${_uiButton({ label: _tr('kb.workbench.confirm', '确定'), role: 'primary', className: 'kb-share-pop-btn', attrs: { id: 'kb-perm-ok' } })}
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    _kbPermDlg = overlay;
    _kbPermDlgController = _mountKbDialog({
      overlay,
      dialogSelector: '.kb-share-pop',
      initialFocus: '#kb-perm-private',
      fallbackFocus: '#kb-wb-share',
      trigger,
      onClose: () => {
        if (_kbPermDlg === overlay) _kbPermDlg = null;
        _kbPermDlgController = null;
      },
    });
    if (typeof window.hydrateUiFormSelects === 'function') window.hydrateUiFormSelects(overlay);
    const privateBtn = overlay.querySelector('#kb-perm-private');
    const setPrivate = (on) => {
      privateBtn.classList.toggle('is-on', on);
      privateBtn.setAttribute('aria-checked', on ? 'true' : 'false');
    };
    privateBtn.addEventListener('click', () => setPrivate(!privateBtn.classList.contains('is-on')));
    overlay.querySelector('.kb-share-pop-close').addEventListener('click', () => _kbPermDlgClose());
    overlay.querySelector('#kb-perm-cancel').addEventListener('click', _kbPermDlgClose);
    overlay.querySelector('#kb-perm-ok').addEventListener('click', async () => {
      const nextPerm = _uiSelectValue(overlay, 'kb-perm-member', 'view_export');
      const nextJoin = _uiSelectValue(overlay, 'kb-perm-join', 'direct');
      const nextPrivate = privateBtn.classList.contains('is-on');
      const okBtn = overlay.querySelector('#kb-perm-ok');
      okBtn.disabled = true;
      try {
        const res = await window.cogseed.invoke('spaces.update', {
          spaceId: sp.space_id,
          shared: !nextPrivate,
          member_permission: nextPerm,
          join_mode: nextJoin,
        });
        if (res && res.ok === false) throw new Error(res.error || 'update failed');
        // 更新本地 state
        const local = _state.spaces.find((s) => s.space_id === sp.space_id);
        if (local) {
          local.shared = !nextPrivate;
          local.member_permission = nextPerm;
          local.join_mode = nextJoin;
        }
        if (typeof uiToast === 'function') uiToast(nextPrivate ? _tr('kb.workbench.perm_private_set', '已设为私密') : _tr('kb.workbench.perm_updated', '权限设置已更新'), { variant: 'success', timeoutMs: 1500 });
        _kbPermDlgClose();
        _loadAll();
        // 同步到 CogSeed 问答后端（权限弹窗设置真实生效；静默失败不打扰）
        void window.cogseed.invoke('kb.share.cogseed.syncPolicy', { spaceId: sp.space_id })
          .then((r) => {
            if (r && r.ok === false && typeof uiToast === 'function') {
              uiToast(_tr('kb.workbench.perm_sync_pending', '已保存到 CogSeed 分享（权限待同步）：') + (r.error || ''), { variant: 'info', timeoutMs: 3000 });
            }
          })
          .catch(() => { /* 未发布/未配置：无需同步 */ });
      } catch (err) {
        _log.warn('update space perm failed', err);
        if (typeof uiToast === 'function') uiToast(_tr('kb.workbench.save_failed_prefix', '保存失败：') + ((err && err.message) || String(err)), { variant: 'error' });
        okBtn.disabled = false;
      }
    });
  }

  async function _kbRenameSpace(spaceId) {    const sp = _state.spaces.find((s) => s.space_id === spaceId);
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

  window.addEventListener('i18n-change', () => {
    if (!_state.rendered) return;
    // 外壳只渲染一次 ⇒ 静态 chrome（侧栏/工具栏/菜单）靠定点重标签换语言；
    // 树与右列本来就能重渲染，顺手一起刷新。
    _relabelWorkbench();
    // 脑图里那几个「文案随状态变」的按钮（预览/编辑、聚焦/聚焦中、布局模式、背景）：
    // 静态钩子会把它们刷回初始文案，所以就地按当前状态重刷一遍。
    const _modeBtn = document.getElementById('kb-mm-mode-btn');
    if (_modeBtn) {
      _setUiButtonPresentation(_modeBtn, _mmPreviewMode ? _tr('kb.workbench.mm_edit', '编辑') : _tr('kb.workbench.mm_preview', '预览'), _mmPreviewMode ? 'edit-pencil' : 'eye');
    }
    _mmUpdateToolbarState();
    _renderTree();
    _renderRight();
  });

  window.renderKbWorkbench = renderKbWorkbench;

  function _fvNormSpace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function _fvStripMdMarks(value) {
    return String(value || '').split('\n').map((line) => line
      .replace(/^\s*(?:#{1,6}[ \t]+|>[\t ]?|[-*+•][ \t]+|\d+[.、)][ \t]+|```+[^\n]*|~~~+)/, ''))
      .join(' ');
  }

  function _fvCleanQuote(value) {
    return _fvNormSpace(_fvStripMdMarks(value).replace(/\*\*|__|`/g, ''));
  }

  function _fvSignificantTokens(value) {
    const seen = new Set();
    const tokens = [];
    String(value || '').split(/[^\p{L}\p{N}]+/u).forEach((token) => {
      const cleaned = (token || '').replace(/[^\p{L}\p{N}_-]/gu, '');
      if (cleaned && cleaned.length >= 3 && !seen.has(cleaned)) {
        seen.add(cleaned);
        tokens.push(cleaned);
      }
    });
    return tokens;
  }

  // 文件查看分派（供渲染层回归测试与自动化验证：返回 'rich'|'anchor'|'unavailable'）
  window.__kbWorkbenchOpenFile = function openFileForTest(relPath) {
    return _openFile(relPath);
  };

  // 测验「原文依据」的来源解析（同上规矩：让回归测试真跑匹配规则，而不是比对源码文本）
  window.__kbQuizSourceTest = {
    resolvePath: (name, candidates) => _pickKbSourcePath(name, candidates),
    /** 用当前库树 / 空间库文件表解析（与界面同一条路径）。 */
    resolveInLibrary: (name) => _resolveKbSourcePath(name),
  };

  // 脑图折叠/自适应用户可见行为的最小钩子（与 __kbWorkbenchOpenFile 同规矩）：
  // 让回归测试能真跑"默认骨架 → 点开一层 → 画布重算尺寸"这条链路，而不是只比对源码文本。
  window.__kbMindmapTest = {
    /** 默认折叠集（= 所有非叶子节点，根除外）：首屏只到一级分支。 */
    defaultCollapsed: (root) => [..._mmDefaultCollapsedFor(root || _state.lastMind)],
    collapsed: () => [..._state.mmCollapsed],
    resetFold: (root) => { _mmResetFoldToDefault(root || _state.lastMind); return [..._state.mmCollapsed]; },
    toggleFold: (idx) => { _mmToggleFold(idx); return [..._state.mmCollapsed]; },
    expandPathTo: (idx) => _mmExpandPathTo(idx),
    /** 「回执文件是否就是请求的那一份」的判定（NFC/NFD 容差 + 恰好一份）。 */
    sameDoc: (files, doc) => _mmSameDoc(files, doc),
    /** 用当前折叠态渲染 SVG（与界面同一条路径）。 */
    svg: (root) => _mmTreeSvg(root || _state.lastMind, _state.mmCollapsed, _mmRenderOpts()),
    /** 全展开渲染：导出与独立窗口就是"整图"语义（排版/尺寸类回归用这个基准）。 */
    svgExpanded: (root) => _mmTreeSvg(root || _state.lastMind, new Set(), _mmRenderOpts()),
  };

  // 高亮纯函数（供渲染层回归测试锁定清洗/分词逻辑）
  window.__kbFvUtils = {
    stripMdMarks: _fvStripMdMarks,
    cleanQuote: _fvCleanQuote,
    normSpace: _fvNormSpace,
    significantTokens: _fvSignificantTokens,
    externalTarget: _fvExternalTarget,
    pdfSrcAt: _fvPdfSrcAt,
    quizAnswerClauses: _quizAnswerClauses,
  };

  // 排版类文件的富查看器桥。调用方是常驻加载的 `anchored-source-view`：它拿到
  // 排版类路径（pdf/office/html/图片/音视频）时先问这里，只有这里答不上来才
  // 退回纯文本阅读器。返回 false = 不归我管（非排版类或参数不可用）。
  window.__openKbRichFile = function openKbRichFile(anchor) {
    if (!anchor || typeof anchor.path !== 'string' || !anchor.path) return Promise.resolve(false);
    if (!_isRichPreview(anchor.path)) return Promise.resolve(false);
    return Promise.resolve(_openRichForAnchor(anchor)).then((opened) => opened !== false, () => false);
  };

  // 回答正文渲染纯函数（供回归测试锁定引用 chip / 残片 / 标题渲染，A02 修复）
  window.__kbAnswerUtils = {
    chipifyCitationAnchors: _chipifyCitationAnchors,
    citationVariants: _citationVariants,
    citeChipHtml: _citeChipHtml,
    decorateAnswerHtml: _decorateAnswerHtml,
  };

  // 整篇原文打开桥（供 KB 面板外的引用点击复用，如 chat-citation）：
  // 返回 true = 已交给整篇查看器；false = 请回落片段查看器。
  window.__openKbSourceDocument = function openKbSourceDocument(anchor) {
    if (!anchor || anchor.source === 'attachment') return Promise.resolve(false);
    try {
      return Promise.resolve(_openFileViewerForAnchor(anchor));
    } catch (_) {
      return Promise.resolve(false);
    }
  };
})();
