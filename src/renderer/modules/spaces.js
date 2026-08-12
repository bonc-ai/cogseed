// 工作空间面板 — classic script (window.renderSpaces)
// 空间 = 主界面 + 资源作用域限制（本体/skill/task agent）。
// 广场视图：标题 + 新建按钮 + 分类 chips + 卡片网格（照 AI 团队页骨架）。
// 详情视图：项目列表 tab（+ 新建项目自动绑定）+ 资源 tab（空间级扩充/失效清理）+ 本体 tab（模板字段静态展示）。
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _t(key, fallback, vars) {
    try {
      if (typeof t === 'function') { const v = t(key, vars); if (v && v !== key) return v; }
    } catch (_) {}
    if (vars && fallback != null) {
      return String(fallback).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m));
    }
    return fallback;
  }

  function _notifyFail(prefix, err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    try {
      if (typeof uiAlert === 'function') uiAlert(msg ? `${prefix}: ${msg}` : prefix);
      else console.warn('[spaces]', prefix, msg);
    } catch (_) {}
  }

  async function _invoke(channel, payload) {
    try {
      const res = await window.cogseed.invoke(channel, payload || {});
      return res || {};
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  }

  // ── state ────────────────────────────────────────────────────────────────
  let _spaces = [];            // SpaceWithMeta[]
  let _templates = [];         // RoleTemplate[]（含 bundle）
  let _skillNames = new Map(); // skill id → name
  let _agentNames = new Map(); // agent id → name
  let _filter = 'all';         // chips 筛选：'all' | 'mine' | template_id | 'custom'
  let _detail = null;          // 当前详情 space_id | null（null = 广场）
  let _detailTab = 'projects'; // 'projects' | 'resources' | 'ontology'
  let _projects = [];          // 项目列表（详情页用）
  let _loaded = false;

  // ── data ─────────────────────────────────────────────────────────────────
  async function _loadData() {
    const [spacesRes, templatesRes, skillsRes, agentsRes] = await Promise.all([
      _invoke('spaces.list'),
      _invoke('spaces.templates.list'),
      _invoke('skills.list'),
      _invoke('agents.list', { summary: true }),
    ]);
    _spaces = Array.isArray(spacesRes.spaces) ? spacesRes.spaces : [];
    _templates = Array.isArray(templatesRes.templates) ? templatesRes.templates : [];
    _skillNames = new Map((skillsRes.skills || []).map((s) => [s.id, s.name || s.id]));
    _agentNames = new Map((agentsRes.agents || []).map((a) => [a.agent_id, a.name || a.agent_id]));
    _loaded = true;
  }

  async function _loadProjects() {
    const res = await _invoke('projects.list');
    _projects = Array.isArray(res.projects) ? res.projects : [];
  }

  // ── render: 广场 ─────────────────────────────────────────────────────────
  function _templateName(templateId) {
    const tpl = _templates.find((t) => t.template_id === templateId);
    return tpl ? tpl.name : null;
  }

  function _chipLabel(key) {
    if (key === 'all') return _t('spaces.chip_all', '全部');
    if (key === 'mine') return _t('spaces.chip_mine', '我的空间');
    if (key === 'custom') return _t('spaces.chip_custom', '自定义');
    return _templateName(key) || key;
  }

  /** 模板 → 已创建的空间（无则 null）。 */
  function _spaceForTemplate(tpl) {
    return _spaces.find((s) => s.template_id === tpl.template_id) || null;
  }

  /** 模板 emoji 图标。 */
  function _templateIcon(tpl) {
    const map = {
      student: '🎓', scholar: '📚', fde: '🛠️',
      product_manager: '📱', project_manager: '📋',
      technical_writer: '📝', recruiter: '👥', software_engineer: '💻',
    };
    return map[tpl.template_id] || '🧩';
  }

  /** 模板卡（复用 AI 团队 agent-card 结构）：图标 + 名称 + 描述 + 技能/智能体 chips + 按钮。 */
  function _templateCardHtml(tpl) {
    const existing = _spaceForTemplate(tpl);
    const icon = _templateIcon(tpl);
    const desc = tpl.description || '';
    const skillIds = (tpl.bundle?.skill_ids || []).slice(0, 4);
    const agentIds = (tpl.bundle?.agent_ids || []).slice(0, 3);
    const nSkills = (tpl.bundle?.skill_ids || []).length;
    const nAgents = (tpl.bundle?.agent_ids || []).length;
    const skillTags = skillIds.map((id) => `<span class="agent-card-chip">${escapeHtml(_skillNames.get(id) || id)}</span>`).join('');
    const agentTags = agentIds.map((id) => `<span class="agent-card-chip">${escapeHtml(_agentNames.get(id) || id)}</span>`).join('');
    const badge = existing
      ? `<span class="agent-card-source is-builtin">${_t('spaces.created_badge', '已创建')}</span>`
      : '';
    const btnLabel = existing ? _t('spaces.enter_btn', '进入空间') : _t('spaces.create_btn2', '创建空间');
    const btnClass = 'agent-card-use';
    return `
      <div class="agent-card spaces-tpl-card" data-template-id="${escapeHtml(tpl.template_id)}" data-space-id="${existing ? escapeHtml(existing.space_id) : ''}">
        <div class="agent-card-header">
          <span class="agent-card-avatar spaces-tpl-icon">${icon}</span>
          <div class="agent-card-title">
            <span class="agent-card-name">${escapeHtml(tpl.name)}</span>
            <span class="agent-card-meta">${_t('spaces.role_template', '角色模板')} · v${escapeHtml(tpl.version || '')}</span>
          </div>
          ${badge}
        </div>
        <div class="agent-card-desc">${escapeHtml(desc)}</div>
        <div class="agent-card-actions">
          ${skillTags}
          ${agentTags}
          <button type="button" class="${btnClass}" data-template-enter>${btnLabel}</button>
        </div>
      </div>`;
  }

  /** 已创建空间卡（我的空间 / 自定义筛选用）。 */
  function _spaceCardHtml(s) {
    const tplName = s.template_name || _t('spaces.no_template', '未选模板');
    const icon = escapeHtml(s.icon || '🧩');
    return `<div class="agent-card spaces-space-card" data-space-id="${escapeHtml(s.space_id)}">
      <div class="agent-card-header">
        <span class="agent-card-avatar spaces-tpl-icon">${icon}</span>
        <div class="agent-card-title">
          <span class="agent-card-name">${escapeHtml(s.name)}</span>
          <span class="agent-card-meta">${escapeHtml(tplName)}</span>
        </div>
      </div>
      <div class="agent-card-desc">${_t('spaces.card_desc', '{n} 技能 · {m} 智能体', { n: s.skill_count || 0, m: s.agent_count || 0 })}</div>
      <div class="agent-card-actions">
        <span class="agent-card-chip">${s.skill_count || 0} ${_t('spaces.skills_unit', '技能')}</span>
        <span class="agent-card-chip">${s.agent_count || 0} ${_t('spaces.agents_unit', '智能体')}</span>
        <button type="button" class="agent-card-use" data-space-enter>${_t('spaces.enter_btn', '进入空间')}</button>
      </div>
    </div>`;
  }

  function _filteredCards() {
    if (_filter === 'mine') return _spaces;                       // 我的空间：所有已创建
    if (_filter === 'custom') return _spaces.filter((s) => !s.template_id);
    if (_filter === 'all') return _templates;                     // 全部：8 个角色模板
    return _templates.filter((t) => t.template_id === _filter);   // 单个模板
  }

  function _renderGrid(container) {
    const items = _filteredCards();
    const isTemplateView = _filter === 'all' || _templates.some((t) => t.template_id === _filter);
    if (!items.length) {
      container.innerHTML = `<div class="agents-empty">${_t('spaces.empty', '还没有工作空间，点右上角「新建空间」开始')}</div>`;
      return;
    }
    container.innerHTML = items.map(isTemplateView ? _templateCardHtml : _spaceCardHtml).join('');
    container.querySelectorAll('[data-template-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const tpl = _templates.find((t) => t.template_id === el.dataset.templateId);
        if (!tpl) return;
        const existing = _spaceForTemplate(tpl);
        if (existing) _openDetail(existing.space_id);
        else _createFromTemplate(tpl);
      });
    });
    container.querySelectorAll('.spaces-space-card[data-space-id]').forEach((el) => {
      el.addEventListener('click', () => _openDetail(el.dataset.spaceId));
    });
  }

  /** 从模板卡一键创建空间（名称 = 模板名，绑定模板）。 */
  async function _createFromTemplate(tpl) {
    const res = await _invoke('spaces.create', { name: tpl.name, template_id: tpl.template_id });
    if (res.error) { _notifyFail(_t('spaces.create_fail', '创建失败'), res.error); return; }
    await _loadData();
    _openDetail(res.space.space_id);
  }

  function _renderGallery() {
    const view = document.getElementById('spaces-view');
    if (!view) return;
    const chips = ['all', 'mine', ..._templates.map((t) => t.template_id)]
      .map((key) => `<button class="marketplace-chip${_filter === key ? ' is-active' : ''}" data-chip="${key}">${escapeHtml(_chipLabel(key))}</button>`)
      .join('');
    view.innerHTML = `
      <div class="agents-grid-view">
        <div class="agents-grid-header">
          <div class="agents-grid-header-titles">
            <span class="agents-grid-title">${_t('sidebar.spaces', '工作空间')}</span>
            <span class="agents-grid-subtitle">${_t('spaces.subtitle', '每个空间 = 一套受限的干活环境：限定本体 / 技能 / 智能体')}</span>
          </div>
          <div class="header-actions">
            <button class="btn btn-sm btn-primary" id="spaces-new-btn">+ ${_t('spaces.new_btn', '新建空间')}</button>
          </div>
        </div>
        <div class="marketplace-categories agents-categories" id="spaces-chips">${chips}</div>
        <div class="agents-grid-scroll">
          <div class="agents-grid" id="spaces-grid"></div>
        </div>
      </div>`;

    view.querySelectorAll('.marketplace-chip').forEach((el) => {
      el.addEventListener('click', () => { _filter = el.dataset.chip; _renderGallery(); });
    });
    document.getElementById('spaces-new-btn').addEventListener('click', () => _openCreateModal());
    _renderGrid(document.getElementById('spaces-grid'));
  }

  // ── render: 详情（对齐 agent 详情页：标题行 + 纵向区块）─────────────
  function _space() {
    return _spaces.find((s) => s.space_id === _detail) || null;
  }

  function _detailSection(label, bodyHtml, extraClass = '') {
    return `<div class="agents-detail-section ${extraClass}">
      <div class="agents-detail-label">${label}</div>
      ${bodyHtml}
    </div>`;
  }

  function _renderDetailIntro(space, tpl) {
    const mission = tpl ? (tpl.description || '') : '';
    const icon = escapeHtml(space.icon || '🧩');
    const nSkills = tpl ? (tpl.bundle?.skill_ids || []).length : (space.skill_count || 0);
    const nAgents = tpl ? (tpl.bundle?.agent_ids || []).length : (space.agent_count || 0);
    const stats = `
      <div class="agents-detail-stats">
        <span class="agent-card-chip">${nSkills} ${_t('spaces.skills_unit', '技能')}</span>
        <span class="agent-card-chip">${nAgents} ${_t('spaces.agents_unit', '智能体')}</span>
        <span class="agent-card-chip">${space.invalid_count || 0} ${_t('spaces.invalid_label', '失效')}</span>
      </div>`;
    const desc = mission || _t('spaces.space_no_desc', '本空间未套模板，自由使用全部资源。');
    return _detailSection(
      `${icon} ${_t('spaces.detail_intro', '空间简介')}`,
      `<div class="agents-detail-desc">${escapeHtml(desc)}</div>${stats}`,
    );
  }

  function _renderDetailSkills(tpl) {
    const skillIds = tpl?.bundle?.skill_ids || [];
    const rows = skillIds.map((id) => `
      <div class="agents-detail-list-item">
        <span class="agents-detail-list-text">${escapeHtml(_skillNames.get(id) || id)}</span>
        <span class="agent-card-source is-builtin">${_t('spaces.skills_unit', '技能')}</span>
      </div>`).join('');
    return _detailSection(
      _t('spaces.detail_skills', '自带技能'),
      rows || `<div class="agents-detail-desc is-empty">${_t('spaces.none', '无')}</div>`,
    );
  }

  function _renderDetailAgents(tpl) {
    const agentIds = tpl?.bundle?.agent_ids || [];
    const rows = agentIds.map((id) => `
      <div class="agents-detail-list-item">
        <span class="agents-detail-list-text">${escapeHtml(_agentNames.get(id) || id)}</span>
        <span class="agent-card-source is-custom">${_t('spaces.agents_unit', '智能体')}</span>
      </div>`).join('');
    return _detailSection(
      _t('spaces.detail_agents', '自带智能体'),
      rows || `<div class="agents-detail-desc is-empty">${_t('spaces.none', '无')}</div>`,
    );
  }

  function _renderDetailProjects(space) {
    const owned = _projects.filter((p) => p.space_id === space.space_id);
    const rows = owned.map((p) => `<div class="agents-detail-list-item spaces-proj-row" data-pid="${escapeHtml(p.project_id)}">
      <span class="agents-detail-list-text">${escapeHtml(p.name)}</span>
      <span class="agents-detail-list-meta">${p.conv_count || 0} ${_t('spaces.convs_unit', '会话')}</span>
    </div>`).join('');
    return _detailSection(
      `${_t('spaces.projects_label', '空间内项目')} <button class="btn btn-sm" id="spaces-proj-new">+ ${_t('spaces.new_project_btn', '新建项目')}</button>`,
      rows || `<div class="agents-detail-desc is-empty">${_t('spaces.projects_empty', '还没有项目，新建一个开始干活')}</div>`,
    );
  }

  function _renderDetailOntology(tpl) {
    if (!tpl) {
      return _detailSection(_t('spaces.tab_ontology', '本体'), `<div class="agents-detail-desc is-empty">${_t('spaces.ontology_none', '未套模板：本空间记忆为自由文本，不受字段限制')}</div>`);
    }
    const groups = (tpl.preset_groups || []).map((g) => `
      <div class="spaces-onto-group">
        <div class="spaces-onto-group-title">${escapeHtml(g.title)}</div>
        <div class="spaces-onto-fields">${(g.fields || []).map((f) => `<span class="spaces-res-chip static">${escapeHtml(f.name)}${f.isRelation ? ' →' : ''}</span>`).join('') || '<span class="muted">—</span>'}</div>
      </div>`).join('');
    return _detailSection(
      _t('spaces.ontology_label', '本空间按角色模板记录（一期静态展示，候选路由二期接入）'),
      `<div class="spaces-onto-groups">${groups}</div>`,
    );
  }

  function _renderDetailResources(space) {
    const extraSkills = (space.extra_skills || []).map((id) => `<span class="spaces-res-chip" data-kind="skill" data-id="${escapeHtml(id)}">${escapeHtml(_skillNames.get(id) || id)} <b title="${_t('spaces.remove_tip', '移除')}">×</b></span>`).join('');
    const extraAgents = (space.extra_agents || []).map((id) => `<span class="spaces-res-chip" data-kind="agent" data-id="${escapeHtml(id)}">${escapeHtml(_agentNames.get(id) || id)} <b title="${_t('spaces.remove_tip', '移除')}">×</b></span>`).join('');
    const invalid = space.invalid_count > 0
      ? `<button class="btn btn-sm" id="spaces-prune-btn">${_t('spaces.prune_btn', '清理失效引用（{n}）', { n: space.invalid_count })}</button>` : '';
    const addRow = `
      <div class="spaces-detail-row">
        <select id="spaces-add-kind"><option value="skill">${_t('spaces.skills_unit', '技能')}</option><option value="agent">${_t('spaces.agents_unit', '智能体')}</option></select>
        <select id="spaces-add-id"></select>
        <button class="btn btn-sm" id="spaces-add-btn">${_t('spaces.add_btn', '添加')}</button>
        ${invalid}
      </div>`;
    const extras = `
      <div class="agents-detail-list-item">
        <span class="agents-detail-list-text">${_t('spaces.extra_skills', '空间级扩充 · 技能')}</span>
      </div>
      <div class="spaces-res-chips" style="margin:4px 0 10px">${extraSkills || `<span class="muted">${_t('spaces.none', '无')}</span>`}</div>
      <div class="agents-detail-list-item">
        <span class="agents-detail-list-text">${_t('spaces.extra_agents', '空间级扩充 · 智能体')}</span>
      </div>
      <div class="spaces-res-chips" style="margin:4px 0 10px">${extraAgents || `<span class="muted">${_t('spaces.none', '无')}</span>`}</div>`;
    return _detailSection(
      _t('spaces.detail_extra', '空间级扩充'),
      `${extras}${addRow}`,
    );
  }

  function _renderDetail() {
    const view = document.getElementById('spaces-view');
    const space = _space();
    if (!space) { _detail = null; _renderGallery(); return; }
    const tpl = _templates.find((t) => t.template_id === space.template_id) || null;
    const tplName = tpl ? tpl.name : (space.template_name || _t('spaces.no_template', '未选模板'));
    const icon = escapeHtml(space.icon || '🧩');

    view.innerHTML = `
      <div class="agents-grid-view">
        <div class="agents-detail-header">
          <div class="agents-detail-title-row">
            <button type="button" class="btn btn-sm" id="spaces-back-btn">← ${_t('spaces.back', '返回')}</button>
            <span class="agents-detail-avatar-slot">${icon}</span>
            <div class="agents-detail-name" id="spaces-detail-name">${escapeHtml(space.name)}</div>
            <span class="agents-detail-source is-builtin">${escapeHtml(tplName)}</span>
            <div class="detail-actions">
              <button class="btn btn-sm" id="spaces-rename-btn">${_t('spaces.rename_btn', '重命名')}</button>
              <button class="btn btn-sm btn-danger" id="spaces-delete-btn">${_t('spaces.delete_btn', '删除')}</button>
            </div>
          </div>
        </div>
        <div class="agents-detail-body">
          ${_renderDetailIntro(space, tpl)}
          ${_renderDetailSkills(tpl)}
          ${_renderDetailAgents(tpl)}
          ${_renderDetailResources(space)}
          ${_renderDetailProjects(space)}
          ${_renderDetailOntology(tpl)}
        </div>
      </div>`;

    document.getElementById('spaces-back-btn').addEventListener('click', () => { _detail = null; _renderGallery(); });
    document.getElementById('spaces-delete-btn').addEventListener('click', () => _deleteSpace(space));
    document.getElementById('spaces-rename-btn').addEventListener('click', () => _renameSpace(space));
    _bindDetailBody(space);
  }

  async function _bindDetailBody(space) {
    // 项目区块
    document.getElementById('spaces-proj-new')?.addEventListener('click', () => _createProjectInSpace(space));
    document.querySelectorAll('.spaces-proj-row').forEach((el) => {
      el.addEventListener('click', () => {
        try { if (typeof setView === 'function') setView('project', el.dataset.pid); } catch (_) {}
      });
    });
    // 资源扩充区块
    const kindSel = document.getElementById('spaces-add-kind');
    kindSel?.addEventListener('change', () => _fillAddIdSelect(space));
    await _fillAddIdSelect(space);
    document.getElementById('spaces-add-btn')?.addEventListener('click', () => _addResource(space));
    document.querySelectorAll('.spaces-res-chip[data-kind]').forEach((el) => {
      el.addEventListener('click', () => _removeResource(space, el.dataset.kind, el.dataset.id));
    });
    document.getElementById('spaces-prune-btn')?.addEventListener('click', () => _pruneInvalid(space));
  }

  // ── actions ──────────────────────────────────────────────────────────────
  async function _fillAddIdSelect(space) {
    const sel = document.getElementById('spaces-add-id');
    if (!sel) return;
    const kind = document.getElementById('spaces-add-kind')?.value || 'skill';
    const [skillsRes, agentsRes] = await Promise.all([
      kind === 'skill' ? _invoke('skills.list') : Promise.resolve({}),
      kind === 'agent' ? _invoke('agents.list') : Promise.resolve({}),
    ]);
    const items = kind === 'skill'
      ? ((skillsRes.skills || skillsRes.list || [])).map((s) => ({ id: s.id, name: s.name }))
      : ((agentsRes.agents || agentsRes.list || [])).map((a) => ({ id: a.agent_id, name: a.name || a.agent_id }));
    const existing = new Set(kind === 'skill' ? space.extra_skills : space.extra_agents);
    const opts = items.filter((i) => !existing.has(i.id))
      .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name || i.id)}</option>`).join('');
    sel.innerHTML = opts || `<option value="">${_t('spaces.no_options', '无可用项')}</option>`;
  }

  async function _addResource(space) {
    const kind = document.getElementById('spaces-add-kind')?.value || 'skill';
    const id = document.getElementById('spaces-add-id')?.value;
    if (!id) return;
    const res = await _invoke('spaces.resources.add', { spaceId: space.space_id, kind, id });
    if (res.error) { _notifyFail(_t('spaces.add_fail', '添加失败'), res.error); return; }
    await _refreshDetail();
  }

  async function _removeResource(space, kind, id) {
    const res = await _invoke('spaces.resources.remove', { spaceId: space.space_id, kind, id });
    if (res.error) { _notifyFail(_t('spaces.remove_fail', '移除失败'), res.error); return; }
    await _refreshDetail();
  }

  async function _pruneInvalid(space) {
    const res = await _invoke('spaces.resources.pruneInvalid', { spaceId: space.space_id });
    if (res.error) { _notifyFail(_t('spaces.prune_fail', '清理失败'), res.error); return; }
    await _refreshDetail();
  }

  async function _refreshDetail() {
    await _loadData();
    await _loadProjects();
    _renderDetail();
  }

  async function _createProjectInSpace(space) {
    let name = `${space.name} ${_t('spaces.project_suffix', '项目')}`;
    for (let i = 2; i <= 50; i++) {
      const res = await _invoke('projects.create', { name });
      if (!res.error && res.project) {
        const bind = await _invoke('projects.bindSpace', { projectId: res.project.project_id, spaceId: space.space_id });
        if (bind.error) _notifyFail(_t('spaces.bind_fail', '绑定空间失败'), bind.error);
        try { if (typeof setView === 'function') setView('project', res.project.project_id); } catch (_) {}
        return;
      }
      if (res.error === 'name_dup') { name = `${space.name} ${_t('spaces.project_suffix', '项目')} ${i}`; continue; }
      _notifyFail(_t('spaces.create_project_fail', '新建项目失败'), res.error);
      return;
    }
  }

  function _openDetail(spaceId) {
    _detail = spaceId;
    _detailTab = 'projects';
    _loadProjects().then(() => _renderDetail());
  }

  async function _deleteSpace(space) {
    const msg = `${_t('spaces.delete_confirm', '删除工作空间？')}\n${_t('spaces.delete_confirm2', '将解绑引用它的项目（项目退回全资源），空间内会话不受影响（会话属于项目）。')}`;
    let ok = false;
    try { ok = typeof confirm === 'function' && confirm(msg); } catch (_) { ok = false; }
    if (!ok) return;
    const res = await _invoke('spaces.delete', { spaceId: space.space_id });
    if (res.error) { _notifyFail(_t('spaces.delete_fail', '删除失败'), res.error); return; }
    _detail = null;
    await _loadData();
    _renderGallery();
  }

  async function _renameSpace(space) {
    let name = '';
    try { name = (typeof prompt === 'function' && prompt(_t('spaces.rename_prompt', '新名称：'), space.name)) || ''; } catch (_) {}
    if (!name.trim() || name.trim() === space.name) return;
    const res = await _invoke('spaces.update', { spaceId: space.space_id, name: name.trim() });
    if (res.error) { _notifyFail(_t('spaces.rename_fail', '重命名失败'), res.error); return; }
    await _refreshDetail();
  }

  // ── create modal ─────────────────────────────────────────────────────────
  function _openCreateModal() {
    const overlay = document.getElementById('spaces-modal');
    if (!overlay) return;
    const tplGrid = document.getElementById('spaces-modal-templates');
    const cards = ['', ..._templates].map((t) => {
      if (!t) {
        return `<label class="spaces-tpl-card${'' ? ' is-selected' : ''}" data-template="">
          <span class="spaces-tpl-name">${_t('spaces.blank_tpl', '空白空间')}</span>
          <span class="spaces-tpl-desc">${_t('spaces.blank_tpl_desc', '不套模板：全资源可用，手动拼装')}</span>
        </label>`;
      }
      const nSkills = (t.bundle?.skill_ids || []).length;
      const nAgents = (t.bundle?.agent_ids || []).length;
      return `<label class="spaces-tpl-card" data-template="${escapeHtml(t.template_id)}">
        <span class="spaces-tpl-name">${escapeHtml(t.name)}</span>
        <span class="spaces-tpl-desc">${escapeHtml(t.description || '')}</span>
        <span class="spaces-tpl-bundle">${_t('spaces.tpl_bundle', '自带')} ${nSkills} ${_t('spaces.skills_unit', '技能')} · ${nAgents} ${_t('spaces.agents_unit', '智能体')}</span>
      </label>`;
    }).join('');
    tplGrid.innerHTML = cards;
    let selectedTemplate = '';
    const cardEls = tplGrid.querySelectorAll('.spaces-tpl-card');
    cardEls.forEach((el) => {
      el.addEventListener('click', () => {
        cardEls.forEach((c) => c.classList.remove('is-selected'));
        el.classList.add('is-selected');
        selectedTemplate = el.dataset.template || '';
      });
    });
    const nameInput = document.getElementById('spaces-modal-name');
    nameInput.value = '';
    nameInput.focus();
    overlay.style.display = 'flex';

    const close = () => { overlay.style.display = 'none'; };
    document.getElementById('spaces-modal-cancel').onclick = close;
    document.getElementById('spaces-modal-create').onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const res = await _invoke('spaces.create', { name, template_id: selectedTemplate || undefined });
      if (res.error) { _notifyFail(_t('spaces.create_fail', '创建失败'), res.error); return; }
      close();
      await _loadData();
      _filter = 'all';
      _openDetail(res.space.space_id);
    };
  }

  // ── entry ────────────────────────────────────────────────────────────────
  async function renderSpaces() {
    const view = document.getElementById('spaces-view');
    if (!view) return;
    try {
      await _loadData();
      _renderGallery();
    } catch (err) {
      console.error('[spaces] render failed', err);
      view.innerHTML = `<div class="spaces-empty">${_t('spaces.load_error', '加载失败')}: ${escapeHtml((err && err.message) || String(err))}</div>`;
    }
  }

  window.renderSpaces = renderSpaces;
  console.log('[spaces] module loaded, renderSpaces available');
})();
