// ─── 工作空间中心（PRD v0.3 布局 UI 壳）— classic script (window.renderWorkspace) ───
// 按「CogSeed 工作空间原型设计说明 v0.3」+ HighFi Prototype v0.9.1 的布局盖 UI：
//   空间中心（我的空间 + 从模板创建）→ 空间详情（任务/产物/资产三页签 + 配置抽屉）
//   → 任务页（对话 + 产物/资产面板 + composer）+ 新建空间弹窗 + 能力选择弹窗。
// 接线状态：
//   ✅ 空间列表 / 模板列表 = 真实 IPC（spaces.list / spaces.templates.list）
//   ✅ 能力配置 = 真实目录（role=角色模板、task=agents.list、skill=skills.list，bundle 预选+解析名字）
//   ✅ 创建空间 = spaces.create + spaces.resources.add（额外勾选写入 extra_*）
//   ⏳ 空间详情「任务/产物/资产」数据源 = 后端尚无「空间→任务→产物/资产」聚合模型，暂用空态
//   ⏳ 任务页发送/保存 = _stub() 留空，待后端接入
// 与现有 spaces.js（项目/资源/本体布局）并存，互不影响。
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** i18n：优先全局 t()，否则回退中文兜底。 */
  function _t(key, fallback, vars) {
    try {
      if (typeof t === 'function') { const v = t(key, vars); if (v && v !== key) return v; }
    } catch (_) {}
    if (vars && fallback != null) {
      return String(fallback).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m));
    }
    return fallback;
  }

  /** SVG 图标（走 icons.js 的 uiIconHtml，不用 emoji）。 */
  function _icon(name, className) {
    try {
      if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
        return window.uiIconHtml(name, className || 'ui-icon');
      }
    } catch (_) {}
    return '';
  }

  /** IPC 调用（真实数据通道）。 */
  async function _invoke(channel, payload) {
    try {
      const res = await window.cogseed.invoke(channel, payload || {});
      return res || {};
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  }

  /** 业务动作留桩：弹一个「待接入」轻提示，不碰任何后端。 */
  function _stub(label) {
    let toast = document.getElementById('ws-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ws-toast';
      toast.className = 'ws-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = `${label || '该功能'}：UI 壳已就位，功能待接入`;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  /** 相对时间（updated_at ISO → 「刚刚 / N 分钟前 / …」）。 */
  function _relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    const diff = Date.now() - t.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚更新';
    if (min < 60) return `${min} 分钟前更新`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前更新`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前更新`;
    return t.toLocaleDateString('zh-CN') + ' 更新';
  }

  /** 空间类型 → 卡片配色（PRD 四类之一）。 */
  function _spaceTone(spaceType) {
    return ({ complex_project: 'violet', professional_work: 'green', recurring_routine: 'blue', temporary_task: 'green' })[spaceType] || 'green';
  }

  function _spaceTypeLabel(spaceType) {
    return ({ complex_project: '复杂项目', professional_work: '专业工作', recurring_routine: '重复事务', temporary_task: '临时任务' })[spaceType] || '';
  }

  // ── 三 tab 数据映射（后端形状 → 渲染形状）──────────────────────────────

  /** 会话 → 任务行。 */
  function _mapConversation(c) {
    return {
      id: c.conversation_id || '',
      title: c.title || '未命名任务',
      desc: (c.agent_ids && c.agent_ids.length) ? `${c.agent_ids.length} 个智能体` : '',
      results: c.processing ? '进行中' : '',
      time: _relTime(c.updated_at || c.last_active_at || c.created_at),
    };
  }

  /** 产物类别（供筛选 + 卡片角标）。 */
  function _artifactCategory(ext, type) {
    if (type === 'artifact') return '网页';
    const e = (ext || '').toLowerCase();
    if (['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.pdf', '.docx', '.docm'].includes(e)) return '文档';
    if (['.xlsx', '.xlsm'].includes(e)) return '表格';
    if (['.pptx', '.pptm'].includes(e)) return '演示文稿';
    if (['.html', '.htm', '.js', '.mjs', '.css', '.svg'].includes(e)) return '网页';
    return '文档'; // 图片/视频/音频兜底
  }

  /** 产物 → 产物卡。 */
  function _mapArtifact(a) {
    return {
      id: a.artifactId || a.name || '',
      name: a.name || '',
      desc: a.sourceSessionId ? `来源任务：${a.sourceSessionId}` : '',
      source: a.sourceSessionId || '',
      type: _artifactCategory(a.ext, a.type),
      ext: a.ext || '',
      isArtifact: a.type === 'artifact',
    };
  }

  /** 资产类型（英文 → 中文，供筛选/角标/文案）。 */
  function _assetTypeLabel(raw) {
    return ({ personal: '个人身份与偏好', rule: '决策规则与方法', template: '文档模板及项目事实', skill_method: '可复用的技能' })[raw] || '资产';
  }

  /** 资产引用绑定 → 资产卡。 */
  function _mapAsset(b) {
    const name = b.title || b.asset_id || '未命名资产';
    return {
      id: b.asset_id || '',
      name,
      desc: b.version ? `版本 ${b.version}` : '',
      type: _assetTypeLabel(b.asset_type),
      mark: (name || '资').charAt(0),
      reuse: 0,
    };
  }

  /** 加载某空间的三 tab 数据（真实 IPC；切空间才重载）。 */
  async function _loadSpaceDetail(spaceId) {
    if (!spaceId || _detailLoadedFor === spaceId) return;
    const [convRes, artRes, assetRes] = await Promise.all([
      _invoke('spaces.conversations.list', { spaceId }),
      _invoke('spaces.artifacts.list', { spaceId }),
      _invoke('spaces.assets.list', { spaceId }),
    ]);
    _sessions = (Array.isArray(convRes.conversations) ? convRes.conversations : []).map(_mapConversation);
    _artifacts = (Array.isArray(artRes.artifacts) ? artRes.artifacts : []).map(_mapArtifact);
    _assets = (Array.isArray(assetRes.bindings) ? assetRes.bindings : []).map(_mapAsset);
    _detailLoadedFor = spaceId;
  }

  // ── 真实数据（由 _loadData 填充）─────────────────────────────────────────

  let _spaces = [];        // SpaceWithMeta[]
  let _templates = [];     // RoleTemplate[]
  let _loaded = false;     // 是否已成功加载过（区分「加载中」与「加载失败」）
  let _loadError = '';     // 加载失败原因

  // 空间详情/任务页的三 tab 数据（阶段 2 起接真实 IPC：spaces.conversations/artifacts/assets.list）
  let _sessions = [];        // 任务 = 空间下会话（listSpaceConversations）
  let _artifacts = [];       // 产物 = 附件 + artifact（listSpaceArtifacts）
  let _assets = [];          // 资产 = asset_reference_bindings（listSpaceAssetBindings）
  let _detailLoadedFor = null;  // 已加载详情的 space_id（切空间才重载）
  const _assetTypes = ['全部', '个人身份与偏好', '决策规则与方法', '文档模板及项目事实', '可复用的技能'];
  const _baseAgents = ['Codex', 'ChatGPT', 'WorkBuddy'];

  // ── 能力真实数据源（与 personal-ontology 的 skills.list/agents.list 同源）──
  let _skillCatalog = [];       // [{ id, name, desc }]（技能库）
  let _agentCatalog = [];       // [{ id, name, desc }]（AI 团队）
  let _abilityPicks = { role: [], task: [], skill: [] }; // 新建空间弹窗已选（raw id；task=Task Agent）

  /** 能力目录（按 kind）：role=角色模板、task=AI 团队、skill=技能库。 */
  function _abilityCatalog(kind) {
    if (kind === 'role') return _templates.map((t) => ({ id: t.template_id, name: t.name, desc: t.description || '' }));
    if (kind === 'task') return _agentCatalog;
    return _skillCatalog;
  }

  /** 解析 raw id 列表 → [{id,name,desc}]；查不到回退显示 raw id（复用 personal-ontology 的解析范式）。 */
  function _resolveCatalog(kind, ids) {
    const map = new Map(_abilityCatalog(kind).map((o) => [o.id, o]));
    return (ids || []).map((id) => map.get(id) || { id, name: id, desc: '' });
  }

  async function _loadData() {
    const [spacesRes, templatesRes, skillsRes, agentsRes] = await Promise.all([
      _invoke('spaces.list'),
      _invoke('spaces.templates.list'),
      _invoke('skills.list'),
      _invoke('agents.list'),
    ]);
    if (spacesRes.error && templatesRes.error) {
      _loadError = (spacesRes.error || '') + ' / ' + (templatesRes.error || '');
      _loaded = false;
      return;
    }
    _spaces = Array.isArray(spacesRes.spaces) ? spacesRes.spaces : [];
    _templates = Array.isArray(templatesRes.templates) ? templatesRes.templates : [];
    _skillCatalog = Array.isArray(skillsRes.skills)
      ? skillsRes.skills.map((s) => ({ id: s.id, name: s.name || s.id, desc: (s.description_zh || s.description_en || '').trim() }))
      : [];
    _agentCatalog = Array.isArray(agentsRes.agents)
      ? agentsRes.agents.map((a) => ({ id: a.agent_id, name: a.name || a.agent_id, desc: (a.description_zh || a.description_en || '').trim() }))
      : [];
    _loaded = true;
    _loadError = '';
    // 详情默认指向第一个空间
    if (_detailSpaceId === null && _spaces.length) _detailSpaceId = _spaces[0].space_id;
  }

  // ── state ─────────────────────────────────────────────────────────────────

  let _view = 'center';            // 'center' | 'space' | 'task'
  let _detailSpaceId = null;       // 当前详情空间 space_id
  let _spaceTab = 'tasks';         // 详情页签：tasks | artifacts | assets
  let _configOpen = false;         // 详情页配置抽屉
  let _centerSearch = '';
  let _centerSort = 'recent';      // 空间中心排序：'recent' 最近使用 | 'name' 按名称
  let _artifactFilter = '全部';
  let _assetFilter = '全部';
  let _createOpen = false;         // 新建空间弹窗
  let _createName = '';            // 弹窗内已填空间名称（_reRender 时保留）
  let _createInstruction = '';     // 弹窗内已填默认目标/指令（_reRender 时保留）
  let _createTemplate = null;      // 弹窗套用的模板 template_id
  let _abilityKind = 'role';       // 能力弹窗当前 tab：role | task | skill
  let _abilityOpen = false;

  function _space() {
    return _spaces.find((s) => s.space_id === _detailSpaceId) || _spaces[0] || null;
  }

  // ── render 入口 ───────────────────────────────────────────────────────────

  async function renderWorkspace() {
    _view = 'center';
    _createOpen = false;
    _abilityOpen = false;
    _configOpen = false;
    const root = document.getElementById('ws-view');
    if (!root) return;
    root.innerHTML = `<div class="ws-loading">${_t('ws.loading', '加载中…')}</div>`;
    try {
      await _loadData();
      _reRender();
    } catch (err) {
      _loadError = (err && err.message) || String(err);
      _loaded = false;
      _reRender();
    }
  }

  function _go(view, opts) {
    _view = view;
    if (opts && opts.spaceId) _detailSpaceId = opts.spaceId;
    if (opts && opts.tab) _spaceTab = opts.tab;
    _configOpen = false;
    _createOpen = false;
    _abilityOpen = false;
    _reRender();
    // 进入空间详情时异步加载三 tab 真数据（切空间重载）
    if (view === 'space' && _detailSpaceId) {
      _loadSpaceDetail(_detailSpaceId).then(() => _reRender());
    }
  }

  function _render() {
    if (!_loaded) return _renderLoadError();
    if (_view === 'space') return _renderSpace();
    if (_view === 'task') return _renderTask();
    return _renderCenter();
  }

  function _renderLoadError() {
    return `
    <div class="ws-view ws-center">
      <div class="ws-load-error">
        <p>${_t('ws.load_error', '加载失败')}：${escapeHtml(_loadError)}</p>
        <button class="ws-primary" data-ws="retry-load">${_t('ws.retry', '重试')}</button>
      </div>
    </div>`;
  }

  // ── 空间中心 ──────────────────────────────────────────────────────────────

  function _renderCenter() {
    const spaces = _spaces.filter((s) => !_centerSearch
      || `${s.name} ${s.sustained_outcome || ''} ${s.template_names || ''} ${s.last_conversation_title || ''}`.toLowerCase().includes(_centerSearch.toLowerCase()));
    // 排序：最近使用（last_conversation_at/updated_at 降序）| 按名称（zh 词典序）
    const sorted = [...spaces].sort(_centerSort === 'name'
      ? (a, b) => String(a.name).localeCompare(String(b.name), 'zh') || String(a.space_id).localeCompare(String(b.space_id))
      : (a, b) => String(b.last_conversation_at || b.updated_at || '').localeCompare(String(a.last_conversation_at || a.updated_at || '')));

    return `
    <div class="ws-view ws-center">
      <header class="ws-page-top">
        <div>
          <h1>${_t('ws.center_title', '空间中心')}</h1>
          <p class="ws-tagline">${_t('ws.center_tagline', '工作空间越用越懂你的专属空间，让工作自然接续，让成果持续积累，让认知持续沉淀。')}</p>
        </div>
        <button class="ws-primary" data-ws="create-space">${_icon('plus', 'ui-icon ws-btn-ico')}${_t('ws.new_space', '新建空间')}</button>
      </header>

      <section class="ws-section">
        <div class="ws-section-head">
          <div class="ws-section-title"><h2>${_t('ws.my_spaces', '我的空间')}</h2><span class="ws-count">${_spaces.length}</span></div>
          <div class="ws-center-tools">
            <label class="ws-search">
              <span>${_icon('search', 'ui-icon')}</span>
              <input data-ws="center-search" value="${escapeHtml(_centerSearch)}" placeholder="${_t('ws.search_spaces', '搜索已创建的空间')}" autocomplete="off" spellcheck="false" />
            </label>
            <select class="ws-sort" data-ws="center-sort" title="${_t('ws.sort_title', '空间排序')}">
              <option value="recent" ${_centerSort === 'recent' ? 'selected' : ''}>${_t('ws.sort_recent', '最近使用')}</option>
              <option value="name" ${_centerSort === 'name' ? 'selected' : ''}>${_t('ws.sort_name', '按名称')}</option>
            </select>
          </div>
        </div>
        ${_spaces.length
          ? `<div class="ws-space-grid">${sorted.map(_spaceCardHtml).join('')}</div>`
          : `<div class="ws-empty">${_t('ws.no_spaces', '还没有工作空间，点右上角「新建空间」或从下方模板开始。')}</div>`}
      </section>

      <section class="ws-section ws-template-section">
        <div class="ws-section-head">
          <div class="ws-section-title"><h2>${_t('ws.from_template', '从模板创建')}</h2><span class="ws-count">${_templates.length}</span></div>
        </div>
        ${_templates.length
          ? `<div class="ws-template-grid">${_templates.map(_templateCardHtml).join('')}</div>`
          : `<div class="ws-empty">${_t('ws.no_templates', '暂无可用空间模板。')}</div>`}
      </section>
    </div>`;
  }

  function _spaceCardHtml(s) {
    const mark = s.icon ? s.icon : (s.name || '空').charAt(0);
    const typeLabel = _spaceTypeLabel(s.space_type);
    const desc = s.sustained_outcome || s.template_name || '';
    const invalid = s.invalid_count || 0;
    const metaRows = [
      typeLabel ? { k: _t('ws.meta_type', '类型'), v: typeLabel } : null,
      s.template_names ? { k: _t('ws.meta_template', '角色模板'), v: s.template_names } : null,
      { k: _t('ws.meta_skills', '技能'), v: `${s.skill_count || 0} 项` },
      { k: _t('ws.meta_agents', '智能体'), v: `${s.agent_count || 0} 个` },
      invalid ? { k: _t('ws.meta_invalid', '不可用引用'), v: `${invalid} 项` } : null,
    ].filter(Boolean);
    return `
    <article class="ws-space-card" data-ws="open-space" data-space="${escapeHtml(s.space_id)}">
      <div class="ws-card-top">
        <div class="ws-space-name">
          <div class="ws-space-icon ${_spaceTone(s.space_type)}">${escapeHtml(mark)}</div>
          <div><h3>${escapeHtml(s.name)}</h3><small>${escapeHtml(_relTime(s.updated_at))}</small></div>
        </div>
        <button class="ws-more" data-ws="space-more" data-space="${escapeHtml(s.space_id)}" aria-label="${escapeHtml(s.name)} 更多操作">${_icon('more-horizontal', 'ui-icon')}</button>
        <div class="ws-more-menu" hidden>
          ${metaRows.map((r) => `<div class="ws-more-row"><span>${escapeHtml(r.k)}</span><strong>${escapeHtml(r.v)}</strong></div>`).join('')}
        </div>
      </div>
      ${desc ? `<p class="ws-desc">${escapeHtml(desc)}</p>` : ''}
      <div class="ws-recent">
        <div><small>${_t('ws.recent_task', '最近')}</small><strong title="${escapeHtml(s.last_conversation_title || '')}">${escapeHtml(s.last_conversation_title || _t('ws.no_recent_task', '暂无最近任务'))}</strong></div>
        <button data-ws="continue" data-space="${escapeHtml(s.space_id)}">${_t('ws.enter_space', '继续工作')} →</button>
      </div>
    </article>`;
  }

  function _templateCardHtml(t) {
    const skillN = (t.bundle && t.bundle.skill_ids ? t.bundle.skill_ids.length : 0);
    const agentN = (t.bundle && t.bundle.agent_ids ? t.bundle.agent_ids.length : 0);
    return `
    <article class="ws-template-card" data-ws="create-from-tpl" data-tpl="${escapeHtml(t.template_id)}">
      <div class="ws-template-mark">${escapeHtml((t.name || '模').charAt(0))}</div>
      <h3>${escapeHtml(t.name)}</h3>
      <p>${escapeHtml(t.description || '')}</p>
      <div class="ws-template-bottom">
        <span>${skillN} 技能 · ${agentN} 智能体</span>
        <button data-ws="use-tpl" data-tpl="${escapeHtml(t.template_id)}">${_t('ws.use_template', '用此模板创建')}</button>
      </div>
    </article>`;
  }

  // ── 空间详情 ──────────────────────────────────────────────────────────────

  function _renderSpace() {
    const sp = _space();
    if (!sp) return `<div class="ws-view ws-center"><div class="ws-empty">${_t('ws.no_spaces', '还没有工作空间。')}</div></div>`;
    const tabMeta = { tasks: { label: _t('ws.tab_tasks', '任务'), count: _sessions.length },
      artifacts: { label: _t('ws.tab_artifacts', '产物'), count: _artifacts.length },
      assets: { label: _t('ws.tab_assets', '资产'), count: _assets.length } };

    return `
    <div class="ws-view ws-space-page ${_configOpen ? 'ws-config-open' : ''}">
      <div class="ws-space-main">
        <header class="ws-space-head">
          <div class="ws-space-head-row">
            <div class="ws-space-heading">
              <div class="ws-space-icon ${_spaceTone(sp.space_type)}">${escapeHtml(sp.icon || (sp.name || '空').charAt(0))}</div>
              <div><h1>${escapeHtml(sp.name)}</h1><p>${escapeHtml(sp.sustained_outcome || '')}</p></div>
            </div>
            <div>
              <button class="ws-secondary" data-ws="space-settings">${_t('ws.space_settings', '空间设置')}</button>
              <button class="ws-primary" data-ws="new-task">${_icon('plus', 'ui-icon ws-btn-ico')}${_t('ws.new_task', '新建任务')}</button>
            </div>
          </div>
          <nav class="ws-space-tabs">
            ${Object.keys(tabMeta).map((k) => `
              <button class="${_spaceTab === k ? 'active' : ''}" data-ws="space-tab" data-tab="${k}">
                ${tabMeta[k].label}<span>${tabMeta[k].count}</span>
              </button>`).join('')}
          </nav>
        </header>
        <div class="ws-space-pane">
          ${_renderSpacePane(sp)}
        </div>
      </div>
      ${_configOpen ? _renderConfigDrawer(sp) : ''}
    </div>`;
  }

  function _renderSpacePane(sp) {
    if (_spaceTab === 'artifacts') return _renderArtifactsPane();
    if (_spaceTab === 'assets') return _renderAssetsPane();
    return _renderTasksPane();
  }

  function _renderTasksPane() {
    if (!_sessions.length) {
      return `<div class="ws-empty">${_t('ws.tasks_empty', '该空间暂无任务。')}</div>`;
    }
    return `
    <div class="ws-toolbar"><span>${_sessions.length} 个任务 · 按最近更新时间排序</span></div>
    <div class="ws-session-list">
      ${_sessions.map((s) => `
        <button class="ws-session-row" data-ws="open-task" data-session="${s.id}">
          <span class="ws-session-icon">${_icon('message-square', 'ui-icon')}</span>
          <div><strong>${escapeHtml(s.title)}</strong><small>${escapeHtml(s.desc)}</small></div>
          <em>${escapeHtml(s.results)}</em>
          <time>${escapeHtml(s.time)}</time>
          <b>${_icon('more-horizontal', 'ui-icon')}</b>
        </button>`).join('')}
    </div>`;
  }

  function _renderArtifactsPane() {
    if (!_artifacts.length) {
      return `<div class="ws-empty">${_t('ws.artifacts_empty', '该空间暂无产物。')}</div>`;
    }
    const items = _artifacts.filter((a) => _artifactFilter === '全部' || a.type === _artifactFilter);
    return `
    <div class="ws-info-note"><span>i</span><div><strong>这里只展示已确认的正式产物。</strong> 候选产物仍保留在产生它的任务过程中，用户确认后才进入本页。</div></div>
    <div class="ws-toolbar">
      <div class="ws-filters ws-filters-compact">
        ${['全部', '文档', '表格', '演示文稿', '网页'].map((t) => `<button class="${_artifactFilter === t ? 'active' : ''}" data-ws="artifact-filter" data-type="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
      </div>
    </div>
    <div class="ws-artifact-grid">
      ${items.map((a) => `
        <article class="ws-artifact-card">
          <div class="ws-file-icon ${a.ext.toLowerCase()}">${escapeHtml(a.ext)}</div>
          <div>
            <h3>${escapeHtml(a.name)}</h3>
            <p>${escapeHtml(a.desc)}</p>
            <footer><span>${_t('ws.from', '来自')}：${escapeHtml(a.source)}</span><button data-ws="open-artifact" data-id="${a.id}">${_t('ws.open', '打开')}</button></footer>
          </div>
          <em>${escapeHtml(a.type)}</em>
        </article>`).join('')}
    </div>`;
  }

  function _renderAssetsPane() {
    if (!_assets.length) {
      return `<div class="ws-empty">${_t('ws.assets_empty', '该空间暂无资产。')}</div>`;
    }
    const items = _assets.filter((a) => _assetFilter === '全部' || a.type === _assetFilter);
    return `
    <div class="ws-info-note"><span>i</span><div><strong>资产仅包含四类经过确认、可持续复用的认知与能力。</strong> 引用资料不属于资产，也不在本页展示。</div></div>
    <div class="ws-asset-filters">
      ${_assetTypes.map((t) => `<button class="${_assetFilter === t ? 'active' : ''}" data-ws="asset-filter" data-type="${escapeHtml(t)}"><strong>${escapeHtml(t)}</strong><span>${t === '全部' ? _assets.length : _assets.filter((a) => a.type === t).length} 项</span></button>`).join('')}
    </div>
    <div class="ws-asset-grid">
      ${items.map((a) => `
        <article class="ws-asset-card">
          <div class="ws-asset-mark mark-${escapeHtml(a.type)}">${escapeHtml(a.mark)}</div>
          <div>
            <h3>${escapeHtml(a.name)}</h3>
            <p>${escapeHtml(a.desc)}</p>
            <footer>${escapeHtml(a.type)} · 已复用 ${a.reuse} 次</footer>
          </div>
          <button class="ws-unbind" data-ws="unbind-asset" data-asset="${escapeHtml(a.id)}" aria-label="${_t('ws.unbind_asset', '解绑资产')}">${_icon('x', 'ui-icon')}</button>
        </article>`).join('')}
    </div>`;
  }

  function _renderConfigDrawer(sp) {
    const cap = { role: { label: '角色', icon: 'users' }, task: { label: 'Task Agent', icon: 'terminal' }, skill: { label: 'Skill', icon: 'sparkles' } };
    // 角色 = 主/副模板名；task/skill = 模板 bundle ∪ extra（与后端 resolveSpaceResources 并集语义一致）
    const tmpls = _templates.filter((t) => t.template_id === sp.primary_template_id || t.template_id === sp.template_id
      || (sp.secondary_template_ids || []).includes(t.template_id));
    const bundleSkills = new Set(tmpls.flatMap((t) => (t.bundle ? t.bundle.skill_ids : [])));
    const bundleAgents = new Set(tmpls.flatMap((t) => (t.bundle ? t.bundle.agent_ids : [])));
    const pick = {
      role: tmpls.map((t) => t.name).filter(Boolean),
      task: _resolveCatalog('task', [...bundleAgents, ...(sp.extra_agents || [])]).map((o) => o.name),
      skill: _resolveCatalog('skill', [...bundleSkills, ...(sp.extra_skills || [])]).map((o) => o.name),
    };
    return `
    <aside class="ws-config-panel">
      <header><h2>${_t('ws.space_settings', '空间设置')}</h2><button class="ws-drawer-close" data-ws="config-close" aria-label="关闭">${_icon('x', 'ui-icon')}</button></header>
      <div class="ws-config-body">
        <section><label>${_t('ws.default_goal', '默认目标/指令')}</label>
          <p>${escapeHtml(sp.instructions || sp.sustained_outcome || _t('ws.no_goal', '未设置持续目标。'))}</p>
        </section>
        <section><label>${_t('ws.base_agent', '当前对话 Agent')}</label>
          <div class="ws-agent-row"><span>CX</span><div><strong>Codex</strong><small>${_t('ws.base_agent_hint', '承接空间内任务')}</small></div></div>
        </section>
        <section class="ws-config-ability">
          <label>${_t('ws.ability_config', '能力配置')}</label>
          ${Object.keys(cap).map((k) => `
            <div class="ws-config-ability-card ${k}">
              <div class="ws-config-ability-icon">${_icon(cap[k].icon, 'ui-icon')}</div>
              <div class="ws-config-ability-content">
                <div class="ws-config-ability-title"><strong>${cap[k].label}</strong><span>${pick[k].length}</span></div>
                <div class="ws-config-ability-chips">${pick[k].length ? pick[k].map((n) => `<span>${escapeHtml(n)}</span>`).join('') : '<em>未配置</em>'}</div>
              </div>
            </div>`).join('')}
        </section>
      </div>
      <footer>${_t('ws.config_footer', '配置更新后，从下一次交互开始生效。')}</footer>
    </aside>`;
  }

  // ── 任务页 ────────────────────────────────────────────────────────────────

  function _renderTask() {
    const sp = _space();
    if (!sp) return `<div class="ws-view ws-center"><div class="ws-empty">${_t('ws.no_spaces', '还没有工作空间。')}</div></div>`;
    return `
    <div class="ws-view ws-task-page">
      <section class="ws-task-area">
        <header class="ws-task-header">
          <button class="ws-breadcrumb" data-ws="back-space"><span>${escapeHtml(sp.name)}</span>${_icon('chevron-right', 'ui-icon')}<strong>${_t('ws.new_task_title', '新建任务')}</strong></button>
          <div class="ws-header-actions">
            <button aria-label="${_t('ws.search', '搜索')}" data-ws="stub-search">${_icon('search', 'ui-icon')}</button>
            <button aria-label="${_t('ws.rerun', '重新执行')}" data-ws="stub-rerun">${_icon('redo', 'ui-icon')}</button>
            <button aria-label="${_t('ws.more_actions', '更多操作')}" data-ws="stub-more">${_icon('more-horizontal', 'ui-icon')}</button>
          </div>
        </header>
        <div class="ws-conversation">
          <div class="ws-new-task-welcome">
            <div>${_icon('sparkles', 'ui-icon')}</div>
            <h1>${_t('ws.new_task_welcome', '在「')}${escapeHtml(sp.name)}${_t('ws.new_task_welcome2', '」中开启新任务')}</h1>
            <p>${_t('ws.new_task_welcome_hint', '任务输入与多 Agent 协作待接入；UI 壳已就位。')}</p>
          </div>
        </div>
        <div class="ws-composer-wrap">
          <div class="ws-composer">
            <textarea aria-label="${_t('ws.task_input', '任务输入')}" placeholder="${_t('ws.task_placeholder', '描述任务，或使用 + / @ 添加能力与上下文…')}"></textarea>
            <div class="ws-composer-actions">
              <button class="ws-round" data-ws="stub-add" aria-label="${_t('ws.add_content', '添加内容')}">${_icon('plus', 'ui-icon')}</button>
              <button class="ws-round at" data-ws="stub-mention" aria-label="${_t('ws.call_expert', '调用专家或技能')}">@</button>
              <span class="ws-composer-spacer"></span>
              <button class="ws-model-btn">CogSeed Agent ${_icon('chevron-down', 'ui-icon')}</button>
              <button class="ws-send" data-ws="stub-send" aria-label="${_t('ws.send', '发送')}">${_icon('send', 'ui-icon')}</button>
            </div>
          </div>
          <p>${_t('ws.disclaimer', 'CogSeed 可能会犯错，请检查重要信息')}</p>
        </div>
      </section>
      <aside class="ws-context-panel">
        <header><div><strong>${_t('ws.task_content', '任务内容')}</strong><small>${_t('ws.task_content_hint', '随任务实时更新')}</small></div><button aria-label="面板设置" data-ws="stub-panel-settings">${_icon('settings', 'ui-icon')}</button></header>
        <nav>
          <button class="active" data-ws="ctx-tab" data-tab="artifacts">${_t('ws.artifacts', '产物')}<span>0</span></button>
          <button data-ws="ctx-tab" data-tab="assets">${_t('ws.assets', '资产')}<span>0</span></button>
        </nav>
        <div class="ws-context-content">
          <div class="ws-empty-current"><span>${_icon('file-text', 'ui-icon')}</span><strong>${_t('ws.no_artifacts', '暂无产物')}</strong><p>${_t('ws.no_artifacts_hint', '产物与资产面板待接入。')}</p></div>
        </div>
      </aside>
    </div>`;
  }

  // ── 弹窗：新建空间 ────────────────────────────────────────────────────────

  function _renderCreateModal() {
    const tpl = _templates.find((t) => t.template_id === _createTemplate) || null;
    const cap = {
      role: { label: '角色', picked: _resolveCatalog('role', _abilityPicks.role) },
      task: { label: 'Task Agent', picked: _resolveCatalog('task', _abilityPicks.task) },
      skill: { label: 'Skill', picked: _resolveCatalog('skill', _abilityPicks.skill) },
    };
    return `
    <div class="ws-scrim" data-ws="close-create">
      <section class="ws-dialog" role="dialog" aria-modal="true" data-ws="noop">
        <header class="ws-dialog-head">
          <div><h2>${_t('ws.new_space', '新建空间')}</h2>${tpl ? `<span>${escapeHtml(tpl.name)}模板</span>` : ''}</div>
          <button data-ws="close-create">${_icon('x', 'ui-icon')}</button>
        </header>
        <div class="ws-dialog-body">
          <div class="ws-form-grid">
            <label class="full"><span>${_t('ws.space_name', '空间名称')} <em>${_t('ws.required', '必填')}</em></span>
              <input data-ws="create-name" value="${escapeHtml(_createName)}" placeholder="${_t('ws.space_name_ph', '请输入空间名称')}" maxlength="60" autocomplete="off" spellcheck="false" /></label>
            <label><span>${_t('ws.base_agent', '基础 Agent')} <em>${_t('ws.base_agent_hint', '负责承接任务')}</em></span>
              <select data-ws="create-agent">${_baseAgents.map((a) => `<option>${escapeHtml(a)}</option>`).join('')}</select></label>
            <label class="full instruction"><span>${_t('ws.default_goal', '默认目标/指令')} <em>0 / 500</em></span>
              <textarea data-ws="create-instruction" maxlength="500" placeholder="${_t('ws.instruction_ph', '填写空间的背景、目标、工作方式、输出要求等')}">${escapeHtml(_createInstruction)}</textarea></label>
          </div>
          <div class="ws-cap-heading">
            <div><h3>${_t('ws.ability_config', '能力配置')}</h3><p>${tpl ? '空间模板已同步预置指令与推荐能力，可按需调整。' : '角色、Task Agent 与 Skill 均为可选，可按需添加。'}</p></div>
          </div>
          <div class="ws-cap-list">
            ${Object.keys(cap).map((k) => `
              <div class="ws-cap-row">
                <div class="ws-cap-icon">${_icon(k === 'role' ? 'users' : k === 'task' ? 'terminal' : 'sparkles', 'ui-icon')}</div>
                <div class="ws-cap-main">
                  <div class="ws-cap-top"><strong>${cap[k].label}</strong><span>${cap[k].picked.length}</span></div>
                  <div class="ws-chips">${cap[k].picked.length ? cap[k].picked.map((o) => `<i>${escapeHtml(o.name)}</i>`).join('') : '<i>未选择</i>'}</div>
                </div>
                <button class="ws-secondary" data-ws="open-ability" data-kind="${k}">${_t('ws.adjust', '调整')}</button>
              </div>`).join('')}
          </div>
        </div>
        <footer class="ws-dialog-foot">
          <small>${_t('ws.create_footer', '创建后将自动进入空间的第一个新任务。')}</small>
          <div>
            <button class="ws-secondary" data-ws="close-create">${_t('ws.cancel', '取消')}</button>
            <button class="ws-primary" data-ws="confirm-create">${_t('ws.create_space', '创建空间')}</button>
          </div>
        </footer>
      </section>
    </div>`;
  }

  // ── 弹窗：能力选择 ────────────────────────────────────────────────────────

  function _renderAbilityModal() {
    const kindLabels = { role: '角色', task: 'Task Agent', skill: 'Skill' };
    const kind = _abilityKind;
    const list = _abilityCatalog(kind) || [];
    const tpl = _templates.find((t) => t.template_id === _createTemplate) || null;
    // 模板 bundle 内置项：固定开启、不可移除（后端派生，无排除机制）
    const bundleIds = new Set([
      ...((tpl && tpl.bundle ? tpl.bundle.agent_ids : []) || []),
      ...((tpl && tpl.bundle ? tpl.bundle.skill_ids : []) || []),
    ]);
    const picked = _abilityPicks[kind] || [];
    return `
    <div class="ws-scrim ws-ability-scrim" data-ws="close-ability">
      <section class="ws-ability-dialog" role="dialog" aria-modal="true" data-ws="noop">
        <header class="ws-ability-head">
          <div><h2>${_t('ws.choose_ability', '选择空间能力')}</h2><p>${_t('ws.choose_ability_hint', '角色决定工作视角，Task Agent 与 Skill 提供专项执行能力。')}</p></div>
          <button data-ws="close-ability">${_icon('x', 'ui-icon')}</button>
        </header>
        <div class="ws-ability-main">
          <nav>
            ${Object.keys(kindLabels).map((k) => `<button class="${_abilityKind === k ? 'active' : ''}" data-ws="ability-tab" data-kind="${k}">${kindLabels[k]}<span>${_abilityCatalog(k).length}</span></button>`).join('')}
          </nav>
          <div class="ws-ability-pane">
            <div class="ws-option-grid">
              ${list.map((o) => {
                const selected = picked.includes(o.id);
                const bundled = kind !== 'role' && bundleIds.has(o.id);
                return `
                <button class="ws-option-card ${selected ? 'selected' : ''}" data-ws="toggle-ability" data-kind="${kind}" data-id="${escapeHtml(o.id)}" ${bundled ? 'data-bundled="1"' : ''}>
                  <span class="ws-check">${selected ? '✓' : ''}</span>
                  <div><strong>${escapeHtml(o.name)}</strong>${bundled ? '<em>模板内置</em>' : ''}<p>${escapeHtml(o.desc)}</p></div>
                </button>`;
              }).join('')}
            </div>
          </div>
        </div>
        <footer class="ws-ability-foot">
          <div></div>
          <div><button class="ws-secondary" data-ws="close-ability">${_t('ws.cancel', '取消')}</button><button class="ws-primary" data-ws="save-ability">${_t('ws.save_choice', '保存选择')}</button></div>
        </footer>
      </section>
    </div>`;
  }

  // ── 事件绑定 ──────────────────────────────────────────────────────────────

  let _moreMenuDismissBound = false;
  /** 点击卡片外关闭「更多」菜单（只注册一次，避免 _bind 重复叠加监听）。 */
  function _bindMoreMenuDismiss() {
    if (_moreMenuDismissBound) return;
    _moreMenuDismissBound = true;
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.ws-more')) {
        document.querySelectorAll('.ws-more-menu').forEach((m) => { m.hidden = true; });
      }
    });
  }

  function _bind(root) {
    _bindMoreMenuDismiss();
    // 弹窗内层：阻止冒泡到 scrim（否则点 dialog 内部会触发关闭）
    root.querySelectorAll('[data-ws="noop"]').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));

    // 加载失败重试
    root.querySelectorAll('[data-ws="retry-load"]').forEach((el) => el.addEventListener('click', () => renderWorkspace()));

    // 空间中心
    root.querySelectorAll('[data-ws="create-space"]').forEach((el) => el.addEventListener('click', () => _openCreate(null)));
    root.querySelectorAll('[data-ws="open-space"]').forEach((el) => el.addEventListener('click', () => _go('space', { spaceId: el.dataset.space })));
    root.querySelectorAll('[data-ws="continue"]').forEach((el) => el.addEventListener('click', () => _go('space', { spaceId: el.dataset.space })));
    root.querySelectorAll('[data-ws="create-from-tpl"], [data-ws="use-tpl"]').forEach((el) => el.addEventListener('click', () => _openCreate(el.dataset.tpl)));
    root.querySelectorAll('[data-ws="space-more"]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = el.parentElement && el.parentElement.querySelector('.ws-more-menu');
      const wasOpen = menu && !menu.hidden;
      // 关掉其它已开菜单
      root.querySelectorAll('.ws-more-menu').forEach((m) => { m.hidden = true; });
      if (menu && !wasOpen) menu.hidden = false;
    }));
    const cs = root.querySelector('[data-ws="center-search"]');
    if (cs) cs.addEventListener('input', () => { _centerSearch = cs.value; _reRender(); });
    const sortSel = root.querySelector('[data-ws="center-sort"]');
    if (sortSel) sortSel.addEventListener('change', () => { _centerSort = sortSel.value; _reRender(); });

    // 空间详情
    root.querySelectorAll('[data-ws="space-tab"]').forEach((el) => el.addEventListener('click', () => { _spaceTab = el.dataset.tab; _reRender(); }));
    root.querySelectorAll('[data-ws="space-settings"]').forEach((el) => el.addEventListener('click', () => { _configOpen = !_configOpen; _reRender(); }));
    root.querySelectorAll('[data-ws="config-close"]').forEach((el) => el.addEventListener('click', () => { _configOpen = false; _reRender(); }));
    root.querySelectorAll('[data-ws="new-task"]').forEach((el) => el.addEventListener('click', () => _go('task')));
    root.querySelectorAll('[data-ws="open-task"]').forEach((el) => el.addEventListener('click', () => _go('task')));
    root.querySelectorAll('[data-ws="artifact-filter"]').forEach((el) => el.addEventListener('click', () => { _artifactFilter = el.dataset.type; _reRender(); }));
    root.querySelectorAll('[data-ws="asset-filter"]').forEach((el) => el.addEventListener('click', () => { _assetFilter = el.dataset.type; _reRender(); }));
    root.querySelectorAll('[data-ws="unbind-asset"]').forEach((el) => el.addEventListener('click', async () => {
      const assetId = el.dataset.asset;
      if (!assetId || !_detailSpaceId) return;
      const res = await _invoke('spaces.assets.unbind', { spaceId: _detailSpaceId, assetId });
      if (res && res.error) { _stub('解绑资产失败：' + res.error); return; }
      _detailLoadedFor = null; // 强制重载三 tab 数据
      _loadSpaceDetail(_detailSpaceId).then(() => _reRender());
    }));
    root.querySelectorAll('[data-ws="open-artifact"]').forEach((el) => el.addEventListener('click', () => _stub('打开产物')));

    // 任务页
    root.querySelectorAll('[data-ws="back-space"]').forEach((el) => el.addEventListener('click', () => _go('space')));
    root.querySelectorAll('[data-ws="ctx-tab"]').forEach((el) => el.addEventListener('click', () => _stub('任务内容面板切换')));

    // 新建空间弹窗
    root.querySelectorAll('[data-ws="close-create"]').forEach((el) => el.addEventListener('click', () => { _createOpen = false; _reRender(); }));
    root.querySelectorAll('[data-ws="open-ability"]').forEach((el) => el.addEventListener('click', () => { _abilityKind = el.dataset.kind; _abilityOpen = true; _reRender(); }));
    root.querySelectorAll('[data-ws="close-ability"]').forEach((el) => el.addEventListener('click', () => { _abilityOpen = false; _reRender(); }));
    root.querySelectorAll('[data-ws="ability-tab"]').forEach((el) => el.addEventListener('click', () => { _abilityKind = el.dataset.kind; _reRender(); }));
    root.querySelectorAll('[data-ws="confirm-create"]').forEach((el) => el.addEventListener('click', () => _createSpace()));
    root.querySelectorAll('[data-ws="toggle-ability"]').forEach((el) => el.addEventListener('click', () => _toggleAbility(el)));
    root.querySelectorAll('[data-ws="save-ability"]').forEach((el) => el.addEventListener('click', () => { _abilityOpen = false; _reRender(); }));
    // 表单输入持久化（调整能力会 _reRender，避免已填名称/指令被重置）
    const cnInput = root.querySelector('[data-ws="create-name"]');
    if (cnInput) cnInput.addEventListener('input', () => { _createName = cnInput.value; });
    const ciInput = root.querySelector('[data-ws="create-instruction"]');
    if (ciInput) ciInput.addEventListener('input', () => { _createInstruction = ciInput.value; });

    // 所有「功能待接入」桩（创建/能力选择已接真，走 confirm-create/toggle-ability/save-ability）
    root.querySelectorAll('[data-ws^="stub-"]').forEach((el) => el.addEventListener('click', () => _stub(_stubLabel(el))));
  }

  /** 能力选择：勾选/取消（模板内置项固定开启，不可移除）。 */
  function _toggleAbility(btn) {
    const kind = btn.dataset.kind;
    const id = btn.dataset.id;
    if (!kind || !id) return;
    if (btn.dataset.bundled) return; // 模板内置：固定开启
    const picks = _abilityPicks[kind] || [];
    _abilityPicks[kind] = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id];
    _reRender();
  }

  /** 创建空间（真实 IPC：spaces.create + 额外资源绑定）。 */
  async function _createSpace() {
    const name = String(_createName || '').trim();
    if (!name) { _stub('请填写空间名称'); return; }
    const instructions = String(_createInstruction || '').trim();
    const tpl = _templates.find((t) => t.template_id === _createTemplate) || null;
    // 角色 = 选中的角色模板（主模板优先；多余作副模板 ≤2）
    const roles = _abilityPicks.role || [];
    const primary = _createTemplate || roles[0] || undefined;
    const secondary = roles.filter((r) => r !== primary).slice(0, 2);
    // 模板 bundle 内置（后端 resolveSpaceResources 派生，无需 extra 存储）
    const bundleSkills = new Set(tpl && tpl.bundle ? tpl.bundle.skill_ids : []);
    const bundleAgents = new Set(tpl && tpl.bundle ? tpl.bundle.agent_ids : []);
    // 额外勾选（超出 bundle）创建后写入 extra_*
    const extraSkills = (_abilityPicks.skill || []).filter((id) => !bundleSkills.has(id));
    const extraAgents = (_abilityPicks.task || []).filter((id) => !bundleAgents.has(id));

    let name0 = name;
    let space = null;
    for (let i = 0; i < 50; i++) {
      const res = await _invoke('spaces.create', {
        name: name0,
        ...(primary ? { primary_template_id: primary } : {}),
        ...(secondary.length ? { secondary_template_ids: secondary } : {}),
        ...(instructions ? { instructions } : {}),
      });
      if (!res.error && res.space) { space = res.space; break; }
      if (res.error === 'name_dup') { name0 = `${name} ${i + 2}`; continue; }
      _stub('创建空间失败：' + (res.error || '未知错误'));
      return;
    }
    if (!space) { _stub('创建空间失败：多次重名'); return; }
    // 额外技能/智能体绑定（复用 spaces.resources.add）
    for (const id of extraSkills) await _invoke('spaces.resources.add', { spaceId: space.space_id, kind: 'skill', id });
    for (const id of extraAgents) await _invoke('spaces.resources.add', { spaceId: space.space_id, kind: 'agent', id });
    _createOpen = false;
    _abilityOpen = false;
    await _loadData();
    _go('space', { spaceId: space.space_id });
  }

  function _stubLabel(el) {
    const map = {
      'stub-preview': '预览候选产物', 'stub-edit': '继续修改',
      'stub-confirm-artifact': '确认产物', 'stub-edit-asset': '编辑资产', 'stub-ignore-asset': '忽略资产',
      'stub-confirm-asset': '沉淀资产', 'stub-add': '添加内容', 'stub-mention': '调用专家/技能',
      'stub-send': '发送任务', 'stub-search': '任务搜索', 'stub-rerun': '重新执行', 'stub-more': '更多操作',
      'stub-panel-settings': '面板设置', 'stub-open-artifact-row': '打开产物', 'stub-manage-assets': '管理资产',
      'stub-asset-row': '打开资产',
    };
    return map[el.dataset.ws] || '该操作';
  }

  function _openCreate(tplId) {
    _createTemplate = tplId || null;
    // 从模板创建：预选模板 bundle 的 skill/agent（角色 bundle 无字段，默认空，可手动叠加）
    const tpl = _templates.find((t) => t.template_id === _createTemplate) || null;
    _createName = tpl ? tpl.name : '';
    _createInstruction = tpl ? (tpl.description || '') : '';
    _abilityPicks = {
      role: [],
      task: (tpl && tpl.bundle ? tpl.bundle.agent_ids : []) || [],
      skill: (tpl && tpl.bundle ? tpl.bundle.skill_ids : []) || [],
    };
    _createOpen = true;
    _abilityOpen = false;
    _reRender();
  }

  function _reRender() {
    const root = document.getElementById('ws-view');
    if (!root) return;
    let html = _render();
    if (_createOpen) html += _renderCreateModal();
    if (_abilityOpen) html += _renderAbilityModal();
    root.innerHTML = html;
    _bind(root);
  }

  window.renderWorkspace = renderWorkspace;
  console.log('[workspace] UI 壳模块已加载，renderWorkspace 可用');
})();
