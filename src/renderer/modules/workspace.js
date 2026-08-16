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
      refCount: Array.isArray(c.task_references) ? c.task_references.length : 0,
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
    const cid = a.sourceSessionId || '';
    return {
      id: a.artifactId || a.name || '',
      name: a.name || '',
      // 来源显示任务标题（不再是一串 cid 乱码）；跳转仍用 cid
      source: cid,
      sourceTitle: _sessionTitleById(cid) || cid,
      desc: cid ? `来源任务：${_sessionTitleById(cid) || cid}` : '',
      type: _artifactCategory(a.ext, a.type),
      ext: a.ext || '',
      isArtifact: a.type === 'artifact',
      // 确认流程：附件/网页直接正式；AI 产出需用户确认（候选）
      confirmed: a.confirmed !== false,
      sourceKind: a.source || 'attachment',
      path: a.path || '',
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

  /** recall 沉淀资产 → 资产卡（空间资产 tab：显示本空间产生的、已确认沉淀的认知资产）。 */
  function _mapRecallAsset(a) {
    const name = a.title || a.id || '未命名资产';
    const statusLabel = ({ active: '已沉淀', paused: '已暂停', revoked: '已撤销' })[a.status] || a.status || '';
    return {
      id: a.id || '',
      name,
      desc: `${_assetTypeLabel(a.type)}${statusLabel ? ` · ${statusLabel}` : ''}${a.maturity ? ` · ${a.maturity}` : ''}`,
      type: _assetTypeLabel(a.type),
      mark: (name || '资').charAt(0),
      reuse: 0,
      statement: a.statement || '',
      revoked: a.status === 'revoked',
    };
  }

  /** 加载某空间的三 tab 数据（真实 IPC；切空间才重载）。切空间重置筛选，避免残留困惑。 */
  async function _loadSpaceDetail(spaceId) {
    if (!spaceId || _detailLoadedFor === spaceId) return;
    _artifactFilter = '全部';
    _assetFilter = '全部';
    const [convRes, artRes, assetRes] = await Promise.all([
      _invoke('spaces.conversations.list', { spaceId }),
      _invoke('spaces.artifacts.list', { spaceId }),
      _invoke('recall.assets.listForSpace', { spaceId }),
    ]);
    _sessions = (Array.isArray(convRes.conversations) ? convRes.conversations : []).map(_mapConversation);
    _artifacts = (Array.isArray(artRes.artifacts) ? artRes.artifacts : []).map(_mapArtifact);
    // 资产 tab = 本空间沉淀的认知资产（recall 按 spaceId 过滤；空间可读全局但显示只显示本空间）
    _assets = (Array.isArray(assetRes.assets) ? assetRes.assets : []).map(_mapRecallAsset);
    _detailLoadedFor = spaceId;
  }

  // ── 真实数据（由 _loadData 填充）─────────────────────────────────────────

  let _spaces = [];        // SpaceWithMeta[]
  let _templates = [];     // RoleTemplate[]
  let _scenarios = [];     // Scenario[]（教育/写作/职场/自定义，从模板创建区的场景入口）
  let _loaded = false;     // 是否已成功加载过（区分「加载中」与「加载失败」）
  let _loadError = '';     // 加载失败原因

  // 空间详情/任务页的三 tab 数据（阶段 2 起接真实 IPC：spaces.conversations/artifacts/assets.list）
  let _sessions = [];        // 任务 = 空间下会话（listSpaceConversations）
  let _artifacts = [];       // 产物 = 附件 + artifact（listSpaceArtifacts）
  let _assets = [];          // 资产 = asset_reference_bindings（listSpaceAssetBindings）
  let _detailLoadedFor = null;  // 已加载详情的 space_id（切空间才重载）
  const _assetTypes = ['全部', '个人身份与偏好', '决策规则与方法', '文档模板及项目事实', '可复用的技能'];
  // 基础 Agent 候选 = 本机真实安装的 CLI agent（localAgents.list 探测，非硬编码）
  let _baseAgentCatalog = [];     // [{ id: cliType, name: 显示名 }]
  let _baseAgentProbeError = '';  // 探测失败时的提示文案

  /** CLI type → 显示名（与 onboarding 的 _csAgentNameForCli 同风格；未知原样返回）。 */
  function _baseAgentDisplayName(cli) {
    if (cli === 'claude') return 'Claude';
    if (cli === 'codex') return 'Codex';
    if (cli === 'opencode') return 'OpenCode';
    if (cli === 'hermes') return 'Hermes';
    if (cli === 'workbuddy') return 'WorkBuddy';
    if (cli === 'openclaw') return 'OpenClaw';
    return cli;
  }

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
    const [spacesRes, templatesRes, scenariosRes, skillsRes, agentsRes, cliRes] = await Promise.all([
      _invoke('spaces.list'),
      _invoke('spaces.templates.list'),
      _invoke('spaces.scenarios.list'),
      _invoke('skills.list'),
      _invoke('agents.list'),
      _invoke('localAgents.list'),
    ]);
    if (spacesRes.error && templatesRes.error) {
      _loadError = (spacesRes.error || '') + ' / ' + (templatesRes.error || '');
      _loaded = false;
      return;
    }
    _spaces = Array.isArray(spacesRes.spaces) ? spacesRes.spaces : [];
    _templates = Array.isArray(templatesRes.templates) ? templatesRes.templates : [];
    _scenarios = Array.isArray(scenariosRes.scenarios) ? scenariosRes.scenarios : [];
    _skillCatalog = Array.isArray(skillsRes.skills)
      ? skillsRes.skills.map((s) => ({ id: s.id, name: s.name || s.id, desc: (s.description_zh || s.description_en || '').trim() }))
      : [];
    _agentCatalog = Array.isArray(agentsRes.agents)
      ? agentsRes.agents.map((a) => ({
          id: a.agent_id, name: a.name || a.agent_id,
          desc: (a.description_zh || a.description_en || '').trim(),
          // 保留 runtime 供基础 Agent 合并使用（外接 CLI agent = 基础 Agent）
          runtime: (a && a.runtime) || null,
        }))
      : [];
    // 基础 Agent 候选 = AI 团队里的外接 CLI agent（注册名优先，如 ClaudeCode）
    //                 + 本机探测到但团队里还没注册的 CLI（如 Hermes），按 cli type 去重。
    // 与 AI 团队面板「基础 Agent」分组同源，不显示指挥官（指挥官默认隐形）。
    _baseAgentProbeError = '';
    const teamCli = (_agentCatalog || [])
      .filter((a) => a.runtime && a.runtime.kind === 'cli' && a.runtime.cli)
      .map((a) => ({ id: a.runtime.cli, name: a.name }));
    let probedCli = [];
    if (cliRes.error) {
      _baseAgentProbeError = String(cliRes.error);
    } else {
      const entries = Array.isArray(cliRes.entries) ? cliRes.entries : [];
      probedCli = entries
        .filter((e) => e && e.available && e.type)
        .map((e) => ({ id: e.type, name: _baseAgentDisplayName(e.type) }));
    }
    const seen = new Set();
    _baseAgentCatalog = [...teamCli, ...probedCli].filter((a) => {
      if (!a.id || seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    }).sort((x, y) => {
      // 固定优先级：claude 默认首选，其余按名字排（与探测体验一致，避免
      // agents.list 目录顺序决定默认值）
      const rank = { claude: 0, codex: 1, hermes: 2, opencode: 3, workbuddy: 4 };
      const rx = rank[x.id] !== undefined ? rank[x.id] : 9;
      const ry = rank[y.id] !== undefined ? rank[y.id] : 9;
      if (rx !== ry) return rx - ry;
      return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
    });
    // 已选值不在候选里（如装了新 CLI 或选了被卸载的）→ 回落首项
    if (!_baseAgentCatalog.some((a) => a.id === _createBaseAgent)) {
      _createBaseAgent = _baseAgentCatalog.length ? _baseAgentCatalog[0].id : '';
    }
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
  let _createBaseAgent = '';      // 弹窗选中的基础 Agent（cli type；探测结果首项为默认）
  let _abilityKind = 'role';       // 能力弹窗当前 tab：role | task | skill
  let _abilityOpen = false;
  // ── 任务引用选择器（@ 引用空间产物与资产）──────────────────────────────────
  let _refPickerOpen = false;      // 选择器浮层开关
  let _refPickerKind = 'artifact'; // 产物 | 资产
  let _refPickerSpaceId = null;    // 数据源空间
  let _refPickerTargetCid = null;  // null=新建任务待提交；cid=给已有任务补引用
  let _refSearch = '';
  let _artifactCatalog = [];       // 空间产物（spaces.artifacts.list）
  let _assetCatalog = [];          // 空间资产（spaces.assets.list）
  let _pendingRefs = [];           // 待提交/编辑的引用（TaskReference 形状）
  let _refBeforeRefs = [];         // 打开选择器时的已存引用（用于对比增删）
  // ── 空间设置抽屉（可编辑：指令 / 能力调整 / 主技能 / 失效清理）─────────────
  let _configInstructionsDraft = null;  // 指令编辑草稿（null = 未编辑，显示空间原值）
  let _editAbilityOpen = false;    // 详情页「调整」能力弹窗
  let _editAbilityKind = 'skill';  // 'task' | 'skill'
  let _editAbilityPicks = [];      // 调整中已选 raw ids（含模板 bundle 固定项）
  let _editAbilityBefore = [];     // 打开时的 extra（用于 diff 增删）
  let _mainSkillOpen = false;      // 主技能选择弹窗

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
          <div class="ws-section-title"><h2>${_t('ws.from_template', '从模板创建')}</h2><span class="ws-count">${_scenarios.length + _templates.length}</span></div>
        </div>
        ${_scenarios.length
          ? `<div class="ws-create-group-label">${_t('ws.scenes_group', '场景')}</div>
             <div class="ws-template-grid ws-scene-grid">${_scenarios.map(_sceneCardHtml).join('')}</div>`
          : ''}
        ${_templates.length
          ? `<div class="ws-create-group-label">${_t('ws.templates_group', '角色模板')}</div>
             <div class="ws-template-grid">${_templates.map(_templateCardHtml).join('')}</div>`
          : (!_scenarios.length ? `<div class="ws-empty">${_t('ws.no_templates', '暂无可用空间模板。')}</div>` : '')}
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
          <div class="ws-more-actions">
            <button class="ws-more-action" data-ws="rename-space" data-space="${escapeHtml(s.space_id)}">${_t('ws.rename_space', '重命名')}</button>
            <button class="ws-more-danger" data-ws="delete-space" data-space="${escapeHtml(s.space_id)}">${_t('ws.delete_space', '删除空间')}</button>
          </div>
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

  /** 场景建议角色组合标签（如「学生 + 学者」）。 */
  function _sceneTplLabel(sc) {
    const names = [];
    if (sc.suggested_primary_template_id) {
      const tpl = _templates.find((t) => t.template_id === sc.suggested_primary_template_id);
      if (tpl) names.push(tpl.name);
    }
    for (const sid of sc.suggested_secondary_template_ids || []) {
      const tpl = _templates.find((t) => t.template_id === sid);
      if (tpl) names.push(tpl.name);
    }
    return names.join(' + ');
  }

  /** 场景卡（教育/写作/职场/自定义）：点卡 → 预填主+副角色模板进新建弹窗。 */
  function _sceneCardHtml(sc) {
    const tplLabel = _sceneTplLabel(sc);
    return `
    <article class="ws-template-card ws-scene-card" data-ws="create-from-scene" data-scene="${escapeHtml(sc.scenario_id)}">
      <div class="ws-template-mark">${escapeHtml(sc.icon || '场')}</div>
      <h3>${escapeHtml(sc.name)}</h3>
      <p>${escapeHtml(sc.description || '')}</p>
      <div class="ws-template-bottom">
        <span>${tplLabel ? `${escapeHtml(tplLabel)} · ` : ''}${_t('ws.scene_tag', '场景')}</span>
        <button data-ws="use-scene" data-scene="${escapeHtml(sc.scenario_id)}">${_t('ws.use_scene', '用此场景创建')}</button>
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
          <div class="ws-space-back-row">
            <button class="ws-back" data-ws="back-to-center" title="${_t('ws.back_to_center', '返回空间中心')}">${_icon('chevron-left', 'ui-icon')}${_t('ws.back_to_center', '返回空间中心')}</button>
          </div>
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
    const list = _sessions.length
      ? `
    <div class="ws-toolbar"><span>${_sessions.length} 个任务 · 按最近更新时间排序</span></div>
    <div class="ws-session-list">
      ${_sessions.map((s) => `
        <button class="ws-session-row" data-ws="open-task" data-session="${escapeHtml(s.id)}">
          <span class="ws-session-icon">${_icon('message-square', 'ui-icon')}</span>
          <div><strong>${escapeHtml(s.title)}</strong><small>${escapeHtml(s.desc)}</small></div>
          ${s.refCount ? `<em class="ws-row-ref-badge">引用 ${s.refCount}</em>` : '<em></em>'}
          <time>${escapeHtml(s.time)}</time>
          <span class="ws-row-ref-btn" data-ws="task-ref" data-cid="${escapeHtml(s.id)}" role="button" title="${_t('ws.add_ref', '引用空间产物与资产')}">＋引用</span>
          <span class="ws-row-more-btn" data-ws="task-more" data-cid="${escapeHtml(s.id)}" role="button" title="${_t('ws.task_more', '更多操作')}">${_icon('more-horizontal', 'ui-icon')}</span>
        </button>`).join('')}
    </div>`
      : `<div class="ws-empty">${_t('ws.tasks_empty', '该空间暂无任务。')}<small>${_t('ws.tasks_empty_hint', '点右上角「新建任务」在标准对话框里开始第一项任务。')}</small></div>`;
    return list;
  }

  /** 开新任务 = 右上角「新建任务」：在当前空间建一个新会话并跳到标准会话对话框
   *  （与主对话同一个 composer：+ 附件 / To / 工作空间 / @ 引用产物资产 / 发送）。 */
  async function _startNewTask(spaceId) {
    if (!spaceId) return;
    const res = await _invoke('conversations.create', { spaceId });
    if (res.error || !res.conversation) { _stub('开新任务失败：' + (res.error || '未知错误')); return; }
    const cid = res.conversation.conversation_id;
    // 新任务同步进侧栏 conversations 缓存（否则空间组/最近区缺这条，直到下次刷新）
    if (typeof conversations !== 'undefined' && Array.isArray(conversations)
      && !conversations.some((c) => c && c.conversation_id === cid)) {
      const conv = { ...res.conversation, last_active_at: new Date().toISOString() };
      if (res.conversation.space_id) conversations.unshift(conv);
    }
    if (typeof renderConversationList === 'function') renderConversationList();
    // 刷新空间任务列表（回来时任务数/最近任务更新），然后跳到标准会话页
    _detailLoadedFor = null;
    _loadSpaceDetail(spaceId).then(() => { if (typeof setView === 'function') setView('conversation', cid, { skipLoad: true }); });
  }

  /** 任务行「移出空间」= 解绑会话（conversations.setSpace 传空 spaceId）。 */
  async function _unbindTaskFromSpace(cid, spaceId) {
    const res = await _invoke('conversations.setSpace', { cid, spaceId: '', project_id: null });
    if (res.error || !res.conversation) { _stub('移出空间失败：' + (res.error || '未知错误')); return; }
    // 同步侧栏：本地 conversations 里该会话 space_id 清掉（回「最近任务」，空间组消失）
    if (typeof conversations !== 'undefined' && Array.isArray(conversations)) {
      const idx = conversations.findIndex((c) => c && c.conversation_id === cid);
      if (idx >= 0) {
        const updated = { ...conversations[idx], ...res.conversation };
        delete updated.space_id;
        conversations[idx] = updated;
      }
    }
    if (typeof renderConversationList === 'function') renderConversationList();
    _detailLoadedFor = null; // 强制重载三 tab 数据（任务数/最近任务更新）
    await _loadSpaceDetail(spaceId);
    _reRender();
    if (typeof uiToast === 'function') uiToast(_t('ws.task_unbound', '已移出空间'), { variant: 'success' });
  }

  // ── 任务引用选择器（@ 引用空间产物与资产）──────────────────────────────────

  function _sessionTitleById(cid) {
    const s = _sessions.find((x) => x.id === cid);
    return s ? s.title : '';
  }

  function _sameRefKey(r) {
    return r && r.kind === 'asset'
      ? `asset:${r.asset_id || ''}`
      : `artifact:${r.source_cid || ''}:${r.file_name || ''}`;
  }

  function _sameRef(a, b) { return !!a && !!b && _sameRefKey(a) === _sameRefKey(b); }

  async function _openRefPicker(spaceId, targetCid) {
    _refPickerSpaceId = spaceId;
    _refPickerTargetCid = targetCid || null;
    _refSearch = '';
    if (!targetCid) _pendingRefs = _pendingRefs || []; // 新建任务：保留已选
    const [artRes, assetRes] = await Promise.all([
      _invoke('spaces.artifacts.list', { spaceId }),
      _invoke('recall.assets.listForSpace', { spaceId }),
    ]);
    _artifactCatalog = Array.isArray(artRes.artifacts) ? artRes.artifacts : [];
    // 引用资产 = 本空间沉淀资产（recall.assets.listForSpace，与空间资产 tab / @ 选择器同源）
    _assetCatalog = Array.isArray(assetRes.assets)
      ? assetRes.assets.map((a) => ({ asset_id: a.id, title: a.title, asset_type: a.type }))
      : [];
    if (targetCid) {
      const tRes = await _invoke('conversations.taskRefs.list', { cid: targetCid });
      _pendingRefs = Array.isArray(tRes.references) ? tRes.references : [];
      _refBeforeRefs = _pendingRefs.slice();
    }
    _refPickerOpen = true;
    _reRender();
  }

  function _toggleRef(kind, id) {
    if (kind === 'asset') {
      const idx = _pendingRefs.findIndex((r) => r.kind === 'asset' && r.asset_id === id);
      if (idx >= 0) { _pendingRefs.splice(idx, 1); }
      else {
        const it = _assetCatalog.find((a) => a.asset_id === id);
        if (it) _pendingRefs.push({ kind: 'asset', name: it.title || id, asset_id: it.asset_id, asset_type: it.asset_type || '' });
      }
    } else {
      const idx = _pendingRefs.findIndex((r) => r.kind === 'artifact' && r.file_name === id);
      if (idx >= 0) { _pendingRefs.splice(idx, 1); }
      else {
        const it = _artifactCatalog.find((a) => a.name === id);
        if (it) _pendingRefs.push({
          kind: 'artifact', name: it.name, source_cid: it.sourceSessionId,
          source_title: _sessionTitleById(it.sourceSessionId) || it.sourceSessionId,
          file_name: it.name,
          source_ts: it.time ? new Date(it.time * 1000).toISOString() : '',
        });
      }
    }
    _reRender();
  }

  async function _saveRefPicker() {
    const cid = _refPickerTargetCid;
    if (cid) {
      const before = _refBeforeRefs || [];
      const now = _pendingRefs || [];
      for (let i = before.length - 1; i >= 0; i--) {
        if (!now.some((r) => _sameRef(r, before[i]))) {
          await _invoke('conversations.taskRefs.remove', { cid, index: i });
        }
      }
      for (const r of now) {
        if (!before.some((b) => _sameRef(b, r))) {
          await _invoke('conversations.taskRefs.add', { cid, reference: r });
        }
      }
    }
    _refPickerOpen = false;
    _reRender();
    if (cid && _detailSpaceId) {
      _detailLoadedFor = null;
      _loadSpaceDetail(_detailSpaceId).then(() => _reRender());
    }
  }

  function _renderRefPicker() {
    if (!_refPickerOpen) return '';
    const kind = _refPickerKind;
    const arts = _artifactCatalog || [];
    const assets = _assetCatalog || [];
    const q = _refSearch.toLowerCase();
    const items = kind === 'asset' ? assets : arts;
    const filtered = q ? items.filter((it) => String(kind === 'asset' ? it.title : it.name).toLowerCase().includes(q)) : items;
    const isPicked = (it) => kind === 'asset'
      ? _pendingRefs.some((r) => r.kind === 'asset' && r.asset_id === it.asset_id)
      : _pendingRefs.some((r) => r.kind === 'artifact' && r.file_name === it.name);
    return `
    <div class="ws-ref-scrim" data-ws="close-ref">
      <section class="ws-ref-picker" data-ws="noop">
        <header class="ws-ref-head">
          <div class="ws-ref-tabs">
            <button class="${kind === 'artifact' ? 'active' : ''}" data-ws="ref-tab" data-kind="artifact">${_t('ws.ref_artifacts', '产物')}<span>${arts.length}</span></button>
            <button class="${kind === 'asset' ? 'active' : ''}" data-ws="ref-tab" data-kind="asset">${_t('ws.ref_assets', '资产')}<span>${assets.length}</span></button>
          </div>
          <input data-ws="ref-search" value="${escapeHtml(_refSearch)}" placeholder="${_t('ws.ref_search', '搜索…')}" autocomplete="off" spellcheck="false" />
          <button class="ws-ref-close" data-ws="close-ref" aria-label="关闭">${_icon('x', 'ui-icon')}</button>
        </header>
        <div class="ws-ref-list">
          ${filtered.length ? filtered.map((it) => {
            const name = kind === 'asset' ? it.title : it.name;
            const sub = kind === 'asset' ? (it.asset_type || '空间资产') : `${it.type === 'artifact' ? '确认产物' : '附件'} · ${it.ext}`;
            const picked = isPicked(it);
            const id = kind === 'asset' ? it.asset_id : it.name;
            return `
            <div class="ws-ref-item ${picked ? 'picked' : ''}" data-ws="toggle-ref" data-kind="${kind}" data-id="${escapeHtml(id)}">
              <span class="ws-ref-check">${picked ? '✓' : ''}</span>
              <div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(sub)}</small></div>
            </div>`;
          }).join('') : `<div class="ws-ref-empty">${_t('ws.ref_empty', '没有可引用的内容。')}</div>`}
        </div>
        <footer class="ws-ref-foot">
          <span>${_t('ws.ref_selected', '已选')} ${_pendingRefs.length} ${_t('ws.ref_items', '项')}</span>
          <button class="ws-primary" data-ws="save-ref">${_t('ws.save_ref', '保存引用')}</button>
        </footer>
      </section>
    </div>`;
  }

  function _renderArtifactsPane() {
    const items = _artifacts.filter((a) => _artifactFilter === '全部' || a.type === _artifactFilter);
    const pendingCount = items.filter((a) => !a.confirmed).length;
    const noteHtml = pendingCount
      ? `<div class="ws-info-note"><span>i</span><div><strong>${pendingCount} ${_t('ws.candidate_pending', '个候选产物待确认。</strong>')} ${_t('ws.candidate_hint', 'AI 产出的文件需确认后计入正式产物；附件直接计入。')}</div></div>`
      : `<div class="ws-info-note"><span>i</span><div><strong>${_t('ws.formal_artifacts', '这里展示正式产物。')}</strong> ${_t('ws.candidate_hint', 'AI 产出的文件需确认后计入正式产物；附件直接计入。')}</div></div>`;
    // 筛选工具栏常驻（空态也要能切回「全部」，否则用户被筛选"卡住"）
    const toolbarHtml = `
    <div class="ws-toolbar">
      <div class="ws-filters ws-filters-compact">
        ${['全部', '文档', '表格', '演示文稿', '网页'].map((t) => `<button class="${_artifactFilter === t ? 'active' : ''}" data-ws="artifact-filter" data-type="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
      </div>
    </div>`;
    if (!_artifacts.length) {
      return `${noteHtml}${toolbarHtml}<div class="ws-empty">${_t('ws.artifacts_empty', '该空间暂无产物。')}</div>`;
    }
    if (!items.length) {
      // 有产物但被筛选过滤：提示切回「全部」，避免「暂无产物」误导
      return `${noteHtml}${toolbarHtml}<div class="ws-empty">${_t('ws.artifacts_filtered', '没有符合「{filter}」筛选的产物，切回「全部」查看。', { filter: _artifactFilter })}</div>`;
    }
    return `
    ${noteHtml}
    ${toolbarHtml}
    <div class="ws-artifact-grid">
      ${items.map((a) => {
        const candidate = !a.confirmed;
        return `
        <article class="ws-artifact-card${candidate ? ' is-candidate' : ''}">
          <div class="ws-file-icon ${a.ext.toLowerCase()}">${escapeHtml(a.ext)}</div>
          <div>
            <h3>${escapeHtml(a.name)}</h3>
            <p>${escapeHtml(a.desc)}</p>
            <footer>
              <button data-ws="open-source" data-cid="${escapeHtml(a.source)}" title="${_t('ws.open_source_task', '打开来源任务')}">${_t('ws.from', '来自')}：${escapeHtml(a.sourceTitle)}</button>
              ${candidate
                ? `<span class="ws-candidate-actions">
                    <button class="ws-confirm-artifact" data-ws="confirm-artifact" data-cid="${escapeHtml(a.source)}" data-name="${escapeHtml(a.name)}">${_t('ws.confirm', '确认')}</button>
                    <button class="ws-reject-artifact" data-ws="reject-artifact" data-cid="${escapeHtml(a.source)}" data-name="${escapeHtml(a.name)}">${_t('ws.reject', '驳回')}</button>
                  </span>`
                : `<button data-ws="open-artifact" data-path="${escapeHtml(a.path)}" data-cid="${escapeHtml(a.source)}">${_t('ws.open', '打开')}</button>`}
            </footer>
          </div>
          <em>${candidate ? _t('ws.candidate', '待确认') : escapeHtml(a.type)}</em>
        </article>`;
      }).join('')}
    </div>`;
  }

  function _renderAssetsPane() {
    if (!_assets.length) {
      return `<div class="ws-empty">${_t('ws.assets_empty', '该空间暂无沉淀资产。空间内任务产出的认知确认后会沉淀到这里。')}</div>`;
    }
    const items = _assets.filter((a) => _assetFilter === '全部' || a.type === _assetFilter);
    return `
    <div class="ws-info-note"><span>i</span><div><strong>资产仅包含四类经过确认、可持续复用的认知与能力。</strong> 引用资料不属于资产，也不在本页展示。</div></div>
    <div class="ws-asset-filters">
      ${_assetTypes.map((t) => `<button class="${_assetFilter === t ? 'active' : ''}" data-ws="asset-filter" data-type="${escapeHtml(t)}"><strong>${escapeHtml(t)}</strong><span>${t === '全部' ? _assets.length : _assets.filter((a) => a.type === t).length} 项</span></button>`).join('')}
    </div>
    <div class="ws-asset-grid">
      ${items.map((a) => `
        <article class="ws-asset-card${a.revoked ? ' is-revoked' : ''}">
          <div class="ws-asset-mark mark-${escapeHtml(a.type)}">${escapeHtml(a.mark)}</div>
          <div>
            <h3>${escapeHtml(a.name)}</h3>
            <p>${escapeHtml(a.desc)}</p>
            <footer>${escapeHtml(a.type)}${a.revoked ? ` · ${_t('ws.revoked', '已撤销')}` : ''}</footer>
          </div>
          ${a.revoked ? '' : `<button class="ws-unbind" data-ws="revoke-asset" data-asset="${escapeHtml(a.id)}" aria-label="${_t('ws.revoke_asset', '撤销资产')}">${_icon('x', 'ui-icon')}</button>`}
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
    const invalidCount = sp.invalid_count || 0;
    // 主技能（main_skill_ref → 名字）
    const mainSkill = sp.main_skill_ref ? _resolveCatalog('skill', [sp.main_skill_ref.asset_id])[0] : null;
    const instructionsValue = _configInstructionsDraft !== null ? _configInstructionsDraft : (sp.instructions || '');
    return `
    <aside class="ws-config-panel">
      <header><h2>${_t('ws.space_settings', '空间设置')}</h2><button class="ws-drawer-close" data-ws="config-close" aria-label="关闭">${_icon('x', 'ui-icon')}</button></header>
      <div class="ws-config-body">
        <section><label>${_t('ws.default_goal', '默认目标/指令')}</label>
          <textarea data-ws="config-instructions" maxlength="4000" rows="4" placeholder="${_t('ws.instruction_ph', '填写空间的背景、目标、工作方式、输出要求等')}">${escapeHtml(instructionsValue)}</textarea>
          <div class="ws-config-actions"><button class="ws-secondary" data-ws="save-instructions">${_t('ws.save', '保存')}</button><span class="ws-config-hint">${_t('ws.config_footer', '配置更新后，从下一次交互开始生效。')}</span></div>
        </section>
        <section><label>${_t('ws.base_agent', '当前对话 Agent')}</label>
          <div class="ws-agent-row"><span>CX</span><div><strong>${sp.base_agent ? escapeHtml(_baseAgentDisplayName(sp.base_agent)) : escapeHtml(_t('ws.no_agent', '未设置'))}</strong><small>${_t('ws.base_agent_hint', '承接空间内任务')}</small></div></div>
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
              ${k === 'role' ? '' : `<button class="ws-secondary ws-ability-edit" data-ws="edit-ability" data-kind="${k}">${_t('ws.adjust', '调整')}</button>`}
            </div>`).join('')}
        </section>
        <section><label>${_t('ws.main_skill', '主技能')}</label>
          <div class="ws-config-row">
            <span class="ws-config-value">${mainSkill ? escapeHtml(mainSkill.name) : _t('ws.no_main_skill', '未设置')}</span>
            <button class="ws-secondary" data-ws="pick-main-skill">${_t('ws.choose', '选择')}</button>
          </div>
        </section>
        <section><label>${_t('ws.invalid_refs', '失效引用')}</label>
          <div class="ws-config-row">
            <span class="ws-config-value">${invalidCount ? `${invalidCount} ${_t('ws.invalid_items', '项')}` : _t('ws.no_invalid', '无失效引用')}</span>
            ${invalidCount ? `<button class="ws-secondary" data-ws="prune-invalid">${_t('ws.prune', '清理')}</button>` : ''}
          </div>
        </section>
      </div>
    </aside>`;
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
              <select data-ws="create-agent">${_baseAgentCatalog.length
                ? _baseAgentCatalog.map((a) => `<option value="${escapeHtml(a.id)}"${_createBaseAgent === a.id ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')
                : `<option value="" disabled>${_baseAgentProbeError ? escapeHtml('探测失败：' + _baseAgentProbeError) : escapeHtml(_t('ws.no_agent', '未检测到本机 Agent'))}</option>`}</select></label>
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
            ${kind === 'role' ? `<div class="ws-ability-limit-hint">${_t('ws.role_limit_hint', '最多选择 3 个角色模板（1 主 + 2 副），首个作为主角色。')}</div>` : ''}
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

  // ── 空间设置抽屉配套：能力调整 / 主技能 / 失效清理 / 重命名 ─────────────

  /** 详情页「调整」能力弹窗（task/skill；角色只读，新建时定）。模板 bundle 固定，extra 可勾选。 */
  function _renderEditAbilityModal() {
    const kind = _editAbilityKind;
    const list = _abilityCatalog(kind) || [];
    const sp = _space();
    const tmpls = _templates.filter((t) => t && sp && (t.template_id === sp.primary_template_id || t.template_id === sp.template_id
      || (sp.secondary_template_ids || []).includes(t.template_id)));
    const bundleIds = new Set(tmpls.flatMap((t) => (t.bundle
      ? (kind === 'task' ? t.bundle.agent_ids : t.bundle.skill_ids) : [])));
    const picked = _editAbilityPicks || [];
    const kindLabel = kind === 'task' ? 'Task Agent' : 'Skill';
    return `
    <div class="ws-scrim ws-ability-scrim" data-ws="close-edit-ability">
      <section class="ws-ability-dialog" role="dialog" aria-modal="true" data-ws="noop">
        <header class="ws-ability-head">
          <div><h2>${_t('ws.adjust_ability', '调整空间能力')}</h2><p>${kindLabel}：模板内置项固定开启，额外勾选的写入空间扩充配置。</p></div>
          <button data-ws="close-edit-ability">${_icon('x', 'ui-icon')}</button>
        </header>
        <div class="ws-ability-main ws-ability-main-solo">
          <div class="ws-ability-pane">
            <div class="ws-option-grid">
              ${list.map((o) => {
                const selected = picked.includes(o.id);
                const bundled = bundleIds.has(o.id);
                return `
                <button class="ws-option-card ${selected ? 'selected' : ''}" data-ws="toggle-edit-ability" data-id="${escapeHtml(o.id)}" ${bundled ? 'data-bundled="1"' : ''}>
                  <span class="ws-check">${selected ? '✓' : ''}</span>
                  <div><strong>${escapeHtml(o.name)}</strong>${bundled ? '<em>模板内置</em>' : ''}<p>${escapeHtml(o.desc)}</p></div>
                </button>`;
              }).join('')}
            </div>
          </div>
        </div>
        <footer class="ws-ability-foot">
          <div></div>
          <div><button class="ws-secondary" data-ws="close-edit-ability">${_t('ws.cancel', '取消')}</button><button class="ws-primary" data-ws="save-edit-ability">${_t('ws.save_choice', '保存选择')}</button></div>
        </footer>
      </section>
    </div>`;
  }

  /** 主技能选择弹窗（skills.list；单选，支持清除）。 */
  function _renderMainSkillModal() {
    const sp = _space();
    const current = (sp && sp.main_skill_ref) ? sp.main_skill_ref.asset_id : '';
    const list = (_skillCatalog || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    return `
    <div class="ws-scrim ws-ability-scrim" data-ws="close-main-skill">
      <section class="ws-ability-dialog" role="dialog" aria-modal="true" data-ws="noop">
        <header class="ws-ability-head">
          <div><h2>${_t('ws.pick_main_skill', '选择主技能')}</h2><p>${_t('ws.pick_main_skill_hint', '主技能作为空间的核心能力入口（可选）。')}</p></div>
          <button data-ws="close-main-skill">${_icon('x', 'ui-icon')}</button>
        </header>
        <div class="ws-ability-main ws-ability-main-solo">
          <div class="ws-ability-pane">
            <div class="ws-option-grid">
              ${list.map((o) => {
                const selected = o.id === current;
                return `
                <button class="ws-option-card ${selected ? 'selected' : ''}" data-ws="pick-skill" data-id="${escapeHtml(o.id)}" data-name="${escapeHtml(o.name || o.id)}">
                  <span class="ws-check">${selected ? '✓' : ''}</span>
                  <div><strong>${escapeHtml(o.name || o.id)}</strong><p>${escapeHtml(o.desc || '')}</p></div>
                </button>`;
              }).join('')}
            </div>
          </div>
        </div>
        <footer class="ws-ability-foot">
          <div></div>
          <div>${current ? `<button class="ws-secondary" data-ws="clear-main-skill">${_t('ws.clear', '清除')}</button>` : ''}<button class="ws-secondary" data-ws="close-main-skill">${_t('ws.cancel', '取消')}</button></div>
        </footer>
      </section>
    </div>`;
  }

  /** 打开详情页能力调整：预选 = 模板 bundle ∪ extra。 */
  function _openEditAbility(kind) {
    const sp = _space();
    if (!sp) return;
    _editAbilityKind = kind;
    const tmpls = _templates.filter((t) => t && (t.template_id === sp.primary_template_id || t.template_id === sp.template_id
      || (sp.secondary_template_ids || []).includes(t.template_id)));
    const bundleIds = new Set(tmpls.flatMap((t) => (t.bundle
      ? (kind === 'task' ? t.bundle.agent_ids : t.bundle.skill_ids) : [])));
    const extras = kind === 'task' ? (sp.extra_agents || []) : (sp.extra_skills || []);
    _editAbilityPicks = [...new Set([...bundleIds, ...extras])];
    _editAbilityBefore = extras.slice();
    _editAbilityOpen = true;
    _reRender();
  }

  /** 保存能力调整：diff extra → spaces.resources.add/remove。内部 kind（task/skill）映射为 IPC kind（agent/skill）。 */
  async function _saveEditAbility() {
    const sp = _space();
    if (!sp) return;
    const kind = _editAbilityKind;
    // IPC 契约只接受 'agent' | 'skill'；内部 UI 语义 task（Task Agent 分组）映射为 agent。
    const ipcKind = kind === 'task' ? 'agent' : kind;
    const tmpls = _templates.filter((t) => t && (t.template_id === sp.primary_template_id || t.template_id === sp.template_id
      || (sp.secondary_template_ids || []).includes(t.template_id)));
    const bundleIds = new Set(tmpls.flatMap((t) => (t.bundle
      ? (kind === 'task' ? t.bundle.agent_ids : t.bundle.skill_ids) : [])));
    const nextExtras = (_editAbilityPicks || []).filter((id) => !bundleIds.has(id));
    const beforeSet = new Set(_editAbilityBefore || []);
    const nextSet = new Set(nextExtras);
    // 移除
    for (const id of _editAbilityBefore || []) {
      if (!nextSet.has(id)) {
        const res = await _invoke('spaces.resources.remove', { spaceId: sp.space_id, kind: ipcKind, id });
        if (res.error) { _stub('保存失败：' + res.error); return; }
      }
    }
    // 新增
    for (const id of nextExtras) {
      if (!beforeSet.has(id)) {
        const res = await _invoke('spaces.resources.add', { spaceId: sp.space_id, kind: ipcKind, id });
        if (res.error) { _stub('保存失败：' + res.error); return; }
      }
    }
    _editAbilityOpen = false;
    await _loadData();
    if (_detailSpaceId) await _loadSpaceDetail(_detailSpaceId);
    _reRender();
    if (typeof uiToast === 'function') uiToast(_t('ws.saved', '已保存'), { variant: 'success' });
  }

  /** 保存指令（spaces.instructions.set）。 */
  async function _saveConfigInstructions() {
    const sp = _space();
    if (!sp) return;
    const content = String(_configInstructionsDraft !== null ? _configInstructionsDraft : (sp.instructions || '')).trim();
    const res = await _invoke('spaces.instructions.set', { spaceId: sp.space_id, content });
    if (res.error) { _stub('保存失败：' + res.error); return; }
    _configInstructionsDraft = null;
    await _loadData();
    _reRender();
    if (typeof uiToast === 'function') uiToast(_t('ws.saved', '已保存'), { variant: 'success' });
  }

  /** 选择主技能 → spaces.update main_skill_ref。 */
  async function _saveMainSkill(skillId, name) {
    const sp = _space();
    if (!sp) return;
    const skill = (_skillCatalog || []).find((s) => s.id === skillId);
    const ref = skill
      ? { asset_id: skillId, version: String(skill.version || '1.0.0') }
      : { asset_id: skillId, version: '1.0.0' };
    const res = await _invoke('spaces.update', { spaceId: sp.space_id, main_skill_ref: ref });
    if (res.error) { _stub('保存失败：' + res.error); return; }
    _mainSkillOpen = false;
    await _loadData();
    _reRender();
    void name;
  }

  /** 清除主技能。 */
  async function _clearMainSkill() {
    const sp = _space();
    if (!sp) return;
    await _invoke('spaces.update', { spaceId: sp.space_id, main_skill_ref: null });
    _mainSkillOpen = false;
    await _loadData();
    _reRender();
  }

  /** 清理失效引用。 */
  async function _pruneInvalidRefs() {
    const sp = _space();
    if (!sp) return;
    const res = await _invoke('spaces.resources.pruneInvalid', { spaceId: sp.space_id });
    if (res.error) { _stub('清理失败：' + res.error); return; }
    await _loadData();
    _reRender();
    if (typeof uiToast === 'function') uiToast(_t('ws.pruned', '已清理失效引用'), { variant: 'success' });
  }

  /** 重命名空间。 */
  async function _renameSpace() {
    const sp = _space();
    if (!sp) return;
    const next = prompt(_t('ws.rename_prompt', '新的空间名称：'), sp.name);
    if (next === null) return;
    const name = String(next || '').trim();
    if (!name || name === sp.name) return;
    const res = await _invoke('spaces.update', { spaceId: sp.space_id, name });
    if (res.error) { _stub('重命名失败：' + (res.error === 'name_dup' ? '名称已存在' : res.error)); return; }
    await _loadData();
    _reRender();
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
    root.querySelectorAll('[data-ws="create-from-scene"], [data-ws="use-scene"]').forEach((el) => el.addEventListener('click', () => {
      _openCreateFromScene(_scenarios.find((s) => s.scenario_id === el.dataset.scene));
    }));
    root.querySelectorAll('[data-ws="space-more"]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = el.parentElement && el.parentElement.querySelector('.ws-more-menu');
      const wasOpen = menu && !menu.hidden;
      // 关掉其它已开菜单
      root.querySelectorAll('.ws-more-menu').forEach((m) => { m.hidden = true; });
      if (menu && !wasOpen) menu.hidden = false;
    }));
    // 空间卡「⋯」→ 重命名
    root.querySelectorAll('[data-ws="rename-space"]').forEach((el) => el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = el.dataset.space;
      if (!sid) return;
      const sp = _spaces.find((s) => s.space_id === sid);
      const next = prompt(_t('ws.rename_prompt', '新的空间名称：'), (sp && sp.name) || '');
      if (next === null) return;
      const name = String(next || '').trim();
      if (!name || (sp && name === sp.name)) return;
      const res = await _invoke('spaces.update', { spaceId: sid, name });
      if (res.error) { _stub('重命名失败：' + (res.error === 'name_dup' ? '名称已存在' : res.error)); return; }
      await _loadData();
      _reRender();
      if (typeof window.invalidateSidebarSpaces === 'function') window.invalidateSidebarSpaces();
    }));
    // 空间卡「⋯」→ 删除空间（空间内任务移到「最近任务」，会话不删）
    root.querySelectorAll('[data-ws="delete-space"]').forEach((el) => el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = el.dataset.space;
      if (!sid) return;
      const sp = _spaces.find((s) => s.space_id === sid);
      const name = (sp && sp.name) || sid;
      // 任务数：查该空间会话（删除后落到最近任务）
      const listRes = await _invoke('spaces.conversations.list', { spaceId: sid });
      const count = Array.isArray(listRes.conversations) ? listRes.conversations.length : 0;
      if (!confirm(_t('ws.delete_space_confirm', '删除空间「{name}」？空间内 {count} 个任务将移到「最近任务」，会话本身不会被删除。', { name, count }))) return;
      const delRes = await _invoke('spaces.delete', { spaceId: sid });
      if (delRes.error) { _stub('删除空间失败：' + delRes.error); return; }
      // 刷新空间列表；若详情正指向被删空间则重置
      if (_detailSpaceId === sid) _detailSpaceId = null;
      await _loadData();
      _view = 'center';
      _reRender();
      // 侧栏同步：本地 conversations 数组里该空间会话的 space_id 清掉（后端已清，
      // 不更新本地会残留「已删空间组」），并失效侧栏空间缓存
      if (typeof conversations !== 'undefined' && Array.isArray(conversations)) {
        for (const c of conversations) {
          if (c && c.space_id === sid) delete c.space_id;
        }
      }
      if (typeof renderConversationList === 'function') renderConversationList();
      if (typeof window.invalidateSidebarSpaces === 'function') window.invalidateSidebarSpaces();
      if (typeof uiToast === 'function') uiToast(_t('ws.delete_space_done', '空间已删除，任务已移到「最近任务」'), { variant: 'success' });
    }));
    const cs = root.querySelector('[data-ws="center-search"]');
    if (cs) cs.addEventListener('input', () => { _centerSearch = cs.value; _reRender(); });
    const sortSel = root.querySelector('[data-ws="center-sort"]');
    if (sortSel) sortSel.addEventListener('change', () => { _centerSort = sortSel.value; _reRender(); });

    // 空间详情
    root.querySelectorAll('[data-ws="space-tab"]').forEach((el) => el.addEventListener('click', () => {
      _spaceTab = el.dataset.tab;
      // 产物/资产 tab：切到时强制重载（对话里新产出/新确认立即可见，避免缓存旧数据）
      if ((el.dataset.tab === 'artifacts' || el.dataset.tab === 'assets') && _detailSpaceId) {
        _detailLoadedFor = null;
        _loadSpaceDetail(_detailSpaceId).then(() => _reRender());
      } else {
        _reRender();
      }
    }));
    // 空间详情「返回空间中心」（返回上级）
    root.querySelectorAll('[data-ws="back-to-center"]').forEach((el) => el.addEventListener('click', () => _go('center')));
    root.querySelectorAll('[data-ws="space-settings"]').forEach((el) => el.addEventListener('click', () => { _configOpen = !_configOpen; _reRender(); }));
    root.querySelectorAll('[data-ws="config-close"]').forEach((el) => el.addEventListener('click', () => { _configOpen = false; _reRender(); }));
    // ── 空间设置抽屉（可编辑）──
    const ci = root.querySelector('[data-ws="config-instructions"]');
    if (ci) ci.addEventListener('input', () => { _configInstructionsDraft = ci.value; });
    root.querySelectorAll('[data-ws="save-instructions"]').forEach((el) => el.addEventListener('click', () => _saveConfigInstructions()));
    root.querySelectorAll('[data-ws="edit-ability"]').forEach((el) => el.addEventListener('click', () => _openEditAbility(el.dataset.kind)));
    root.querySelectorAll('[data-ws="pick-main-skill"]').forEach((el) => el.addEventListener('click', () => { _mainSkillOpen = true; _reRender(); }));
    root.querySelectorAll('[data-ws="prune-invalid"]').forEach((el) => el.addEventListener('click', () => _pruneInvalidRefs()));
    // ── 详情页能力调整弹窗 ──
    root.querySelectorAll('[data-ws="close-edit-ability"]').forEach((el) => el.addEventListener('click', () => { _editAbilityOpen = false; _reRender(); }));
    root.querySelectorAll('[data-ws="toggle-edit-ability"]').forEach((el) => el.addEventListener('click', () => {
      if (el.dataset.bundled) return; // 模板内置固定开启
      const id = el.dataset.id;
      const picks = _editAbilityPicks || [];
      _editAbilityPicks = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id];
      _reRender();
    }));
    root.querySelectorAll('[data-ws="save-edit-ability"]').forEach((el) => el.addEventListener('click', () => _saveEditAbility()));
    // ── 主技能弹窗 ──
    root.querySelectorAll('[data-ws="close-main-skill"]').forEach((el) => el.addEventListener('click', () => { _mainSkillOpen = false; _reRender(); }));
    root.querySelectorAll('[data-ws="pick-skill"]').forEach((el) => el.addEventListener('click', () => _saveMainSkill(el.dataset.id, el.dataset.name)));
    root.querySelectorAll('[data-ws="clear-main-skill"]').forEach((el) => el.addEventListener('click', () => _clearMainSkill()));
    // 「新建任务」→ 在该空间建新会话并跳到标准会话对话框（与主对话同一 composer）
    root.querySelectorAll('[data-ws="new-task"]').forEach((el) => el.addEventListener('click', () => _startNewTask(_detailSpaceId)));
    // 任务行 → 打开真实会话
    root.querySelectorAll('[data-ws="open-task"]').forEach((el) => el.addEventListener('click', () => {
      const cid = el.dataset.session;
      if (cid && typeof setView === 'function') setView('conversation', cid);
    }));

    // ── 任务引用选择器（任务行「＋引用」给已有任务补引用；新任务引用走标准对话 @）──
    root.querySelectorAll('[data-ws="task-ref"]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation(); // 行本身是 open-task 按钮，避免触发打开会话
      _openRefPicker(_detailSpaceId, el.dataset.cid);
    }));
    // 任务行「更多」→ 移出空间（解绑会话，回普通列表）
    root.querySelectorAll('[data-ws="task-more"]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation(); // 行本身是 open-task 按钮，避免触发打开会话
      const cid = el.dataset.cid;
      if (!cid || !_detailSpaceId) return;
      if (!confirm(_t('ws.task_unbind_confirm', '把该任务移出当前空间？会话保留，但不再计入该空间的任务列表。'))) return;
      _unbindTaskFromSpace(cid, _detailSpaceId);
    }));
    root.querySelectorAll('[data-ws="ref-tab"]').forEach((el) => el.addEventListener('click', () => { _refPickerKind = el.dataset.kind; _reRender(); }));
    root.querySelectorAll('[data-ws="close-ref"]').forEach((el) => el.addEventListener('click', () => { _refPickerOpen = false; _reRender(); }));
    root.querySelectorAll('[data-ws="toggle-ref"]').forEach((el) => el.addEventListener('click', () => _toggleRef(el.dataset.kind, el.dataset.id)));
    root.querySelectorAll('[data-ws="save-ref"]').forEach((el) => el.addEventListener('click', () => _saveRefPicker()));
    const refSearch = root.querySelector('[data-ws="ref-search"]');
    if (refSearch) refSearch.addEventListener('input', () => { _refSearch = refSearch.value; _reRender(); });
    root.querySelectorAll('[data-ws="artifact-filter"]').forEach((el) => el.addEventListener('click', () => { _artifactFilter = el.dataset.type; _reRender(); }));
    root.querySelectorAll('[data-ws="asset-filter"]').forEach((el) => el.addEventListener('click', () => { _assetFilter = el.dataset.type; _reRender(); }));
    // 资产卡 × → 撤销（弹确认 → 撤销；撤销后资产从空间列表消失——listAbilityAssetsForSpace 过滤 revoked）
    root.querySelectorAll('[data-ws="revoke-asset"]').forEach((el) => el.addEventListener('click', async () => {
      const assetId = el.dataset.asset;
      if (!assetId) return;
      if (!confirm(_t('ws.revoke_asset_confirm', '撤销该资产？撤销后将从本空间资产列表移除。'))) return;
      const res = await _invoke('recall.assets.revoke', { assetId, note: 'user revoke' });
      if (res && res.error) { _stub('撤销失败：' + res.error); return; }
      _detailLoadedFor = null;
      _loadSpaceDetail(_detailSpaceId).then(() => _reRender());
      if (typeof uiToast === 'function') uiToast(_t('ws.revoked', '已撤销'), { variant: 'warning' });
    }));
    // 产物：确认候选 / 打开文件（系统默认应用）/ 跳来源任务
    root.querySelectorAll('[data-ws="confirm-artifact"]').forEach((el) => el.addEventListener('click', async () => {
      const cid = el.dataset.cid;
      const name = el.dataset.name;
      if (!_detailSpaceId || !cid || !name) return;
      const res = await _invoke('spaces.artifacts.confirm', { spaceId: _detailSpaceId, cid, name });
      if (res.error) { _stub('确认失败：' + res.error); return; }
      _detailLoadedFor = null;
      _loadSpaceDetail(_detailSpaceId).then(() => _reRender());
      if (typeof uiToast === 'function') uiToast(_t('ws.artifact_confirmed', '已确认'), { variant: 'success' });
    }));
    // 驳回候选产物（不再作为候选展示）
    root.querySelectorAll('[data-ws="reject-artifact"]').forEach((el) => el.addEventListener('click', async () => {
      const cid = el.dataset.cid;
      const name = el.dataset.name;
      if (!_detailSpaceId || !cid || !name) return;
      if (!confirm(_t('ws.reject_confirm', '驳回该候选产物？将不再作为候选展示。'))) return;
      const res = await _invoke('spaces.artifacts.reject', { spaceId: _detailSpaceId, cid, name });
      if (res.error) { _stub('驳回失败：' + res.error); return; }
      _detailLoadedFor = null;
      _loadSpaceDetail(_detailSpaceId).then(() => _reRender());
      if (typeof uiToast === 'function') uiToast(_t('ws.artifact_rejected', '已驳回'), { variant: 'warning' });
    }));
    root.querySelectorAll('[data-ws="open-artifact"]').forEach((el) => el.addEventListener('click', async () => {
      const p = el.dataset.path;
      const cid = el.dataset.cid;
      if (!p) { _stub('打开产物'); return; }
      const res = await _invoke('workspace.openFile', { path: p, cid: cid || '' });
      if (res.error) _stub('打开失败：' + res.error);
    }));
    root.querySelectorAll('[data-ws="open-source"]').forEach((el) => el.addEventListener('click', () => {
      const cid = el.dataset.cid;
      if (cid && typeof setView === 'function') setView('conversation', cid);
    }));

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
    const caSel = root.querySelector('[data-ws="create-agent"]');
    if (caSel) caSel.addEventListener('change', () => { _createBaseAgent = caSel.value; });

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
    if (picks.includes(id)) {
      _abilityPicks[kind] = picks.filter((x) => x !== id);
      _reRender();
      return;
    }
    // 角色模板最多 3 个（1 主 + 2 副）：已选模板计 1 个角色，其余可再勾 2 个。
    if (kind === 'role') {
      const tpl = _templates.find((t) => t.template_id === _createTemplate) || null;
      const roleCount = (tpl ? 1 : 0) + picks.length;
      if (roleCount >= 3) {
        if (typeof uiToast === 'function') uiToast(_t('ws.role_limit', '角色最多选择 3 个（1 主 + 2 副）'), { variant: 'warning', timeoutMs: 3200 });
        return;
      }
    }
    _abilityPicks[kind] = [...picks, id];
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
        ...(_createBaseAgent ? { base_agent: _createBaseAgent } : {}),
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
    // 新空间进侧栏缓存（否则该空间建了会话后侧栏组名显示不了）
    if (typeof window.invalidateSidebarSpaces === 'function') window.invalidateSidebarSpaces();
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

  /** 从场景入口打开新建弹窗：预填主+副角色模板（≤3），名称 = 场景名。 */
  function _openCreateFromScene(sc) {
    if (!sc) return;
    _createTemplate = null; // 场景是组合，不是单一模板（不套 bundle 预选）
    _createName = sc.name || '';
    _createInstruction = '';
    const roles = [];
    if (sc.suggested_primary_template_id) roles.push(sc.suggested_primary_template_id);
    for (const sid of sc.suggested_secondary_template_ids || []) {
      if (roles.length >= 3) break;
      if (!roles.includes(sid)) roles.push(sid);
    }
    _abilityPicks = { role: roles.slice(0, 3), task: [], skill: [] };
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
    if (_editAbilityOpen) html += _renderEditAbilityModal();
    if (_mainSkillOpen) html += _renderMainSkillModal();
    if (_refPickerOpen) html += _renderRefPicker();
    root.innerHTML = html;
    _bind(root);
  }

  /** 侧栏「空间」＋ 入口：加载空间中心并打开新建空间弹窗（先渲染再弹窗）。 */
  async function openWorkspaceCreate() {
    try { await renderWorkspace(); } catch (_) {}
    _openCreate(null);
  }
  window.renderWorkspace = renderWorkspace;
  window.openWorkspaceCreate = openWorkspaceCreate;
  console.log('[workspace] UI 壳模块已加载，renderWorkspace 可用');
})();
