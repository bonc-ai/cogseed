// 情境空间面板 — classic script (window.renderSpaces)
// 空间 = 主界面 + 资源作用域限制（本体/skill/task agent）。
// 广场视图：标题 + 新建按钮 + 分类 chips + 卡片网格（照 AI 团队页骨架）。
// 详情视图：资源 tab（空间级扩充/失效清理）+ 本体 tab（模板字段静态展示）。
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

  /** SVG 图标（AGENTS.md：图标走 icons.js，不用 emoji）。 */
  function _icon(name, className) {
    try {
      if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
        return window.uiIconHtml(name, className || 'ui-icon');
      }
    } catch (_) {}
    return '';
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
  let _scenarios = [];         // Scenario[]（M2 情境入口）
  let _skillNames = new Map(); // skill id → { name, desc }
  let _agentNames = new Map(); // agent id → { name, desc }
  let _filter = 'scenarios';   // chips 筛选：'scenarios' | 'mine' | scenario_id
  let _detail = null;          // 当前详情 space_id | null（null = 广场）
  let _detailRenderSeq = 0;    // 详情页异步渲染并发防护
  let _loaded = false;

  // ── data ─────────────────────────────────────────────────────────────────
  async function _loadData() {
    const [spacesRes, templatesRes, scenariosRes, skillsRes, agentsRes] = await Promise.all([
      _invoke('spaces.list'),
      _invoke('spaces.templates.list'),
      _invoke('spaces.scenarios.list'),
      _invoke('skills.list'),
      _invoke('agents.list'),
    ]);
    _spaces = Array.isArray(spacesRes.spaces) ? spacesRes.spaces : [];
    _templates = Array.isArray(templatesRes.templates) ? templatesRes.templates : [];
    _scenarios = Array.isArray(scenariosRes.scenarios) ? scenariosRes.scenarios : [];
    _skillNames = new Map((skillsRes.skills || []).map((s) => [s.id, { name: s.name || s.id, desc: (s.description_zh || s.description_en || '').trim(), version: s.version }]));
    _agentNames = new Map((agentsRes.agents || []).map((a) => [a.agent_id, { name: a.name || a.agent_id, desc: (a.description_zh || a.description_en || '').trim() }]));
    _loaded = true;
  }

  // ── render: 广场 ─────────────────────────────────────────────────────────

  /** 场景卡（M2 情境入口）：图标 + 名称 + 描述 + 建议角色标签 + 按钮。 */
  function _chipLabel(key) {
    if (key === 'scenarios') return _t('spaces.chip_scenarios', '场景');
    if (key === 'mine') return _t('spaces.chip_mine', '我的空间');
    if (key === 'templates') return _t('spaces.chip_templates', '角色模板');
    if (key === 'custom') return _t('spaces.chip_custom', '自定义');
    // 按 scenario_id 找场景名
    const sc = _scenarios.find((s) => s.scenario_id === key);
    if (sc) return sc.name;
    return key;
  }

  /** 场景模板组合标签（如「学生+学者」）。 */
  function _scenarioTplLabel(scenario) {
    const names = [];
    if (scenario.suggested_primary_template_id) {
      const tpl = _templates.find((t) => t.template_id === scenario.suggested_primary_template_id);
      if (tpl) names.push(tpl.name);
    }
    for (const sid of scenario.suggested_secondary_template_ids) {
      const tpl = _templates.find((t) => t.template_id === sid);
      if (tpl) names.push(tpl.name);
    }
    return names.length ? names.join(' + ') : '';
  }

  /** 场景卡（复用 agent-card 骨架）：图标 + 名称 + 描述 + 建议角色标签 + 按钮。 */
  function _scenarioCardHtml(scenario) {
    const icon = scenario.icon ? escapeHtml(scenario.icon) : _icon('layout-grid', 'ui-icon spaces-tpl-icon');
    const desc = scenario.description || '';
    const tplLabel = _scenarioTplLabel(scenario);
    const tplTag = tplLabel ? `<span class="agent-card-chip">${escapeHtml(tplLabel)}</span>` : '';
    const btnLabel = _t('spaces.create_btn2', '创建空间');
    return `
      <div class="agent-card spaces-scenario-card" data-scenario-id="${escapeHtml(scenario.scenario_id)}">
        <div class="agent-card-header">
          <span class="agent-card-avatar spaces-tpl-icon">${icon}</span>
          <div class="agent-card-title">
            <span class="agent-card-name">${escapeHtml(scenario.name)}</span>
            <span class="agent-card-meta">${_t('spaces.scenario_tag', '场景')}</span>
          </div>
        </div>
        <div class="agent-card-desc">${escapeHtml(desc)}</div>
        <div class="agent-card-actions">
          ${tplTag}
          <button type="button" class="agent-card-use" data-scenario-create>${btnLabel}</button>
        </div>
      </div>`;
  }

  /** 已创建空间卡（我的空间筛选用）。 */
  function _spaceCardHtml(s) {
    const tplName = s.template_name || _t('spaces.no_template', '未选模板');
    const icon = s.icon ? escapeHtml(s.icon) : _icon('box', 'ui-icon spaces-tpl-icon');
    const typeLabel = _spaceTypeLabel(s.space_type);
    return `<div class="agent-card spaces-space-card" data-space-id="${escapeHtml(s.space_id)}">
      <div class="agent-card-header">
        <span class="agent-card-avatar spaces-tpl-icon">${icon}</span>
        <div class="agent-card-title">
          <span class="agent-card-name">${escapeHtml(s.name)}</span>
          <span class="agent-card-meta">${escapeHtml(tplName)}${typeLabel ? ` · ${escapeHtml(typeLabel)}` : ''}</span>
        </div>
      </div>
      <div class="agent-card-desc">${_t('spaces.card_desc', '{n} 技能 · {m} 智能体', { n: s.skill_count || 0, m: s.agent_count || 0 })}</div>
      <div class="agent-card-actions">
        ${_gateChip(s.gate_status)}
        <span class="agent-card-chip">${s.skill_count || 0} ${_t('spaces.skills_unit', '技能')}</span>
        <span class="agent-card-chip">${s.agent_count || 0} ${_t('spaces.agents_unit', '智能体')}</span>
        <button type="button" class="agent-card-use" data-space-enter>${_t('spaces.enter_btn', '进入空间')}</button>
      </div>
    </div>`;
  }

  /** 空间类型标签（i18n key: spaces.type_<space_type>）；未知类型返回空。 */
  function _spaceTypeLabel(spaceType) {
    if (!spaceType) return '';
    const label = _t(`spaces.type_${spaceType}`, '');
    return label && label !== `spaces.type_${spaceType}` ? label : '';
  }

  /** 上架 Gate 状态徽标：passed=已就绪(绿) / failed=未就绪(红) / not_checked=待评估(灰)。 */
  function _gateChip(gateStatus) {
    if (gateStatus === 'passed') return `<span class="agent-card-chip spaces-gate is-gate-passed">${_t('spaces.gate_passed', '已就绪')}</span>`;
    if (gateStatus === 'failed') return `<span class="agent-card-chip spaces-gate is-gate-failed">${_t('spaces.gate_failed', '未就绪')}</span>`;
    return `<span class="agent-card-chip spaces-gate is-gate-not-checked">${_t('spaces.gate_not_checked', '待评估')}</span>`;
  }

  function _filteredCards() {
    if (_filter === 'mine') return _spaces;  // 我的空间：所有已创建
    if (_filter === 'scenarios') return _scenarios; // 场景入口
    if (_filter === 'templates') return _templates; // 角色模板入口
    return _scenarios.filter((s) => s.scenario_id === _filter);
  }

  function _renderGrid(container) {
    const items = _filteredCards();
    const isScenarioView = _filter === 'scenarios' || _scenarios.some((s) => s.scenario_id === _filter);
    const isTemplateView = _filter === 'templates';
    if (!items.length) {
      container.innerHTML = `<div class="agents-empty">${_t('spaces.empty', '还没有情境空间，点右上角「新建空间」开始')}</div>`;
      return;
    }
    container.innerHTML = items.map(isTemplateView ? _templateCardHtml : (isScenarioView ? _scenarioCardHtml : _spaceCardHtml)).join('');
    container.querySelectorAll('.spaces-scenario-card[data-scenario-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const scenarioId = el.dataset.scenarioId;
        const scenario = _scenarios.find((s) => s.scenario_id === scenarioId);
        if (scenario) _createFromScenario(scenario);
      });
    });
    container.querySelectorAll('.spaces-space-card[data-space-id]').forEach((el) => {
      el.addEventListener('click', () => _openDetail(el.dataset.spaceId));
    });
    container.querySelectorAll('.spaces-tpl-entry-card[data-tpl-id]').forEach((el) => {
      el.addEventListener('click', () => _openCreateModal(el.dataset.tplId));
    });
  }

  /** 角色模板入口卡（"角色模板" tab）：点卡 → 创建弹窗预选该模板。 */
  function _templateCardHtml(tpl) {
    const nSkills = (tpl.bundle?.skill_ids || []).length;
    const nAgents = (tpl.bundle?.agent_ids || []).length;
    return `<div class="agent-card spaces-tpl-entry-card" data-tpl-id="${escapeHtml(tpl.template_id)}">
      <div class="agent-card-header">
        <span class="agent-card-avatar spaces-tpl-icon">${_icon('users', 'ui-icon')}</span>
        <div class="agent-card-title">
          <span class="agent-card-name">${escapeHtml(tpl.name)}</span>
          <span class="agent-card-meta">${_t('spaces.tpl_role_label', '角色模板')}</span>
        </div>
      </div>
      <div class="agent-card-desc">${escapeHtml(tpl.description || '')}</div>
      <div class="agent-card-actions">
        <span class="agent-card-chip">${nSkills} ${_t('spaces.skills_unit', '技能')}</span>
        <span class="agent-card-chip">${nAgents} ${_t('spaces.agents_unit', '智能体')}</span>
        <button type="button" class="agent-card-use">${_t('spaces.create_from_tpl', '用此模板创建')}</button>
      </div>
    </div>`;
  }

  /** 从场景入口一键创建空间（名称 = 场景名，模板预填）。 */
  async function _createFromScenario(scenario) {
    // 如果场景已有建议主模板 → 直接创建（名称 = 场景名 + 数字后缀防重名）
    // 自定义场景 → 打开创建弹窗让用户自选
    if (scenario.scenario_id === 'custom') { _openCreateModal(); return; }
    if (!scenario.suggested_primary_template_id) { _openCreateModal(); return; }
    let name = scenario.name;
    for (let i = 1; i <= 50; i++) {
      const res = await _invoke('spaces.create', {
        name,
        primary_template_id: scenario.suggested_primary_template_id,
        secondary_template_ids: scenario.suggested_secondary_template_ids,
        icon: scenario.icon,
      });
      if (!res.error && res.space) {
        await _loadData();
        _openDetail(res.space.space_id);
        return;
      }
      if (res.error === 'name_dup') { name = `${scenario.name} ${i + 1}`; continue; }
      _notifyFail(_t('spaces.create_fail', '创建失败'), res.error);
      return;
    }
  }

  /** 旧兼容：供创建弹窗内模板选择用（保留但不再作为入口卡）。 */
  function _templateName(templateId) {
    const tpl = _templates.find((t) => t.template_id === templateId);
    return tpl ? tpl.name : null;
  }

  function _renderGallery() {
    const view = document.getElementById('spaces-view');
    if (!view) return;
    const hasCustom = _scenarios.some((s) => s.scenario_id === 'custom');
    const chips = ['scenarios', 'mine', 'templates', ...(hasCustom ? ['custom'] : [])]
      .map((key) => `<button class="marketplace-chip${_filter === key ? ' is-active' : ''}" data-chip="${key}">${escapeHtml(_chipLabel(key))}</button>`)
      .join('');
    view.innerHTML = `
      <div class="agents-grid-view">
        <div class="agents-grid-header">
          <div class="agents-grid-header-titles">
            <span class="agents-grid-title">${_t('sidebar.spaces', '情境空间')}</span>
            <span class="agents-grid-subtitle">${_t('spaces.subtitle', '选择一个场景开始，情境空间会自动装配角色模板与配套资源')}</span>
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
    const icon = space.icon ? escapeHtml(space.icon) : _icon('box', 'ui-icon spaces-tpl-icon');
    const nSkills = space.skill_count || 0; // 全量口径：模板 bundle + 空间扩充（与卡片一致）
    const nAgents = space.agent_count || 0;
    const typeLabel = _spaceTypeLabel(space.space_type);
    const stats = `
      <div class="agents-detail-stats">
        ${typeLabel ? `<span class="agent-card-chip">${escapeHtml(typeLabel)}</span>` : ''}
        ${_gateChip(space.gate_status)}
        <span class="agent-card-chip">${nSkills} ${_t('spaces.skills_unit', '技能')}</span>
        <span class="agent-card-chip">${nAgents} ${_t('spaces.agents_unit', '智能体')}</span>
        <span class="agent-card-chip">${space.invalid_count || 0} ${_t('spaces.invalid_label', '不可用')}</span>
      </div>`;
    const desc = mission || _t('spaces.space_no_desc', '未选择角色模板，全部技能与智能体可用。');
    const goal = space.sustained_outcome || '';
    const goalBlock = `
      <div class="spaces-goal-block${goal ? '' : ' is-empty'}">
        <div class="spaces-goal-head">
          <span class="spaces-goal-label">${_icon('zap', 'ui-icon spaces-goal-icon')} ${_t('spaces.goal_label', '空间目标')}</span>
          <button type="button" class="btn btn-sm" id="spaces-goal-edit-btn">${goal ? _t('spaces.goal_edit', '编辑') : _t('spaces.goal_set', '设置')}</button>
        </div>
        <div class="spaces-goal-body" id="spaces-goal-body">
          ${goal
            ? `<p class="spaces-goal-text">${escapeHtml(goal)}</p>`
            : `<p class="agents-detail-desc is-empty">${_t('spaces.goal_empty', '未设置：写下这个空间长期要达成什么，AI 干活时会参考。')}</p>`}
        </div>
      </div>`;
    return _detailSection(
      `${icon} ${_t('spaces.detail_intro', '空间简介')}`,
      `<div class="agents-detail-desc">${escapeHtml(desc)}</div>${stats}${goalBlock}`,
    );
  }

  /** 空间目标行内编辑：切换 textarea + 保存/取消，保存走 spaces.update。 */
  function _bindGoalEditor(space) {
    const editBtn = document.getElementById('spaces-goal-edit-btn');
    const body = document.getElementById('spaces-goal-body');
    if (!editBtn || !body) return;
    editBtn.addEventListener('click', async () => {
      const editing = body.querySelector('textarea');
      if (editing) return; // 已在编辑态
      const current = space.sustained_outcome || '';
      body.innerHTML = `
        <textarea class="spaces-goal-input" maxlength="200" rows="3" placeholder="${_t('spaces.goal_placeholder', '例如：这个空间长期服务于 XX 交付，目标是……')}">${escapeHtml(current)}</textarea>
        <div class="spaces-goal-actions">
          <button type="button" class="btn btn-sm btn-primary" id="spaces-goal-save-btn">${_t('common.save', '保存')}</button>
          <button type="button" class="btn btn-sm" id="spaces-goal-cancel-btn">${_t('common.cancel', '取消')}</button>
        </div>`;
      const saveBtn = body.querySelector('#spaces-goal-save-btn');
      const cancelBtn = body.querySelector('#spaces-goal-cancel-btn');
      const input = body.querySelector('textarea');
      cancelBtn.addEventListener('click', () => _renderDetail());
      saveBtn.addEventListener('click', async () => {
        const value = input.value.trim();
        const res = await _invoke('spaces.update', {
          spaceId: space.space_id,
          ...(value ? { sustained_outcome: value } : { sustained_outcome: null }),
        });
        if (res.error) { _notifyFail(_t('spaces.update_fail', '保存失败'), res.error); return; }
        await _loadData();
        _renderDetail();
      });
    });
  }

  function _renderDetailSkills(tpl) {
    const skillIds = tpl?.bundle?.skill_ids || [];
    const rows = skillIds.map((id) => {
      const info = _skillNames.get(id) || {};
      return `
      <div class="agents-detail-list-item">
        <div class="agents-detail-list-main">
          <span class="agents-detail-list-text">${escapeHtml(info.name || id)}</span>
          ${info.desc ? `<span class="agents-detail-list-desc">${escapeHtml(info.desc)}</span>` : ''}
        </div>
        <span class="agent-card-source is-builtin">${_t('spaces.skills_unit', '技能')}</span>
      </div>`;
    }).join('');
    return _detailSection(
      _t('spaces.detail_skills', '自带技能'),
      rows || `<div class="agents-detail-desc is-empty">${_t('spaces.none', '无')}</div>`,
    );
  }

  function _renderDetailAgents(tpl) {
    const agentIds = tpl?.bundle?.agent_ids || [];
    const rows = agentIds.map((id) => {
      const info = _agentNames.get(id) || {};
      return `
      <div class="agents-detail-list-item">
        <div class="agents-detail-list-main">
          <span class="agents-detail-list-text">${escapeHtml(info.name || id)}</span>
          ${info.desc ? `<span class="agents-detail-list-desc">${escapeHtml(info.desc)}</span>` : ''}
        </div>
        <span class="agent-card-source is-custom">${_t('spaces.agents_unit', '智能体')}</span>
      </div>`;
    }).join('');
    return _detailSection(
      _t('spaces.detail_agents', '自带智能体'),
      rows || `<div class="agents-detail-desc is-empty">${_t('spaces.none', '无')}</div>`,
    );
  }

  function _renderDetailResources(space) {
    const extraSkills = (space.extra_skills || []).map((id) => { const info = _skillNames.get(id) || {}; return `<span class="spaces-res-chip" data-kind="skill" data-id="${escapeHtml(id)}">${escapeHtml(info.name || id)} <b title="${_t('spaces.remove_tip', '移除')}">${_icon('x', 'ui-icon spaces-res-chip-x')}</b></span>`; }).join('');
    const extraAgents = (space.extra_agents || []).map((id) => { const info = _agentNames.get(id) || {}; return `<span class="spaces-res-chip" data-kind="agent" data-id="${escapeHtml(id)}">${escapeHtml(info.name || id)} <b title="${_t('spaces.remove_tip', '移除')}">${_icon('x', 'ui-icon spaces-res-chip-x')}</b></span>`; }).join('');
    const invalid = space.invalid_count > 0
      ? `<button class="btn btn-sm" id="spaces-prune-btn">${_t('spaces.prune_btn', '清理失效引用（{n}）', { n: space.invalid_count })}</button>` : '';
    const addRow = `
      <div class="spaces-res-add-row">
        <span class="spaces-res-add-label">${_t('spaces.res_add_label', '添加资源')}</span>
        <select id="spaces-add-kind"><option value="skill">${_t('spaces.skills_unit', '技能')}</option><option value="agent">${_t('spaces.agents_unit', '智能体')}</option></select>
        <select id="spaces-add-id"></select>
        <button class="btn btn-sm btn-primary" id="spaces-add-btn">${_t('spaces.add_btn', '添加')}</button>
        ${invalid}
      </div>`;
    const extras = `
      <div class="spaces-res-group">
        <div class="spaces-res-group-label">${_t('spaces.extra_skills', '空间级扩充 · 技能')}</div>
        <div class="spaces-res-chips">${extraSkills || `<span class="muted">${_t('spaces.none', '无')}</span>`}</div>
      </div>
      <div class="spaces-res-group">
        <div class="spaces-res-group-label">${_t('spaces.extra_agents', '空间级扩充 · 智能体')}</div>
        <div class="spaces-res-chips">${extraAgents || `<span class="muted">${_t('spaces.none', '无')}</span>`}</div>
      </div>`;
    return _detailSection(
      _t('spaces.detail_extra', '空间级扩充'),
      `${extras}${addRow}`,
    );
  }

  /** 主技能（Main Skill）区块：显示绑定状态，可绑定/解除。 */
  function _renderDetailMainSkill(space) {
    const ref = space.main_skill_ref;
    const body = ref
      ? (() => {
        const info = _skillNames.get(ref.asset_id) || {};
        return `<div class="agents-detail-list-item">
          <span class="agents-detail-list-text">${escapeHtml(info.name || ref.asset_id)}</span>
          <span class="agent-card-chip is-version">v${escapeHtml(ref.version || '?')}</span>
          <button type="button" class="btn btn-sm" data-space-unbind-main>${_t('spaces.main_skill_unbind', '解除')}</button>
        </div>`;
      })()
      : `<div class="agents-detail-desc is-empty">${_t('spaces.main_skill_empty', '未绑定主技能：绑定后 Gate 评估与能力包组装会以此技能为基准。')}</div>`;
    return _detailSection(
      _t('spaces.main_skill_label', '主技能（Main Skill）'),
      `${body}<button type="button" class="btn btn-sm" id="spaces-main-skill-bind-btn">${_t('spaces.main_skill_bind', '绑定主技能')}</button>`,
    );
  }

  /** 主技能选择弹窗：列技能库（名字+版本+描述），点行即绑定。 */
  function _openMainSkillPicker(space) {
    const overlay = document.getElementById('spaces-main-skill-modal');
    if (!overlay) return;
    const list = document.getElementById('spaces-main-skill-list');
    const skills = Array.from(_skillNames.entries())
      .map(([id, info]) => ({ id, name: info.name || id, desc: info.desc || '', version: info.version || '1.0' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    list.innerHTML = skills.length
      ? skills.map((s) => `
        <button type="button" class="spaces-skill-pick-row" data-skill-id="${escapeHtml(s.id)}" data-skill-version="${escapeHtml(s.version)}">
          <span class="spaces-skill-pick-name">${escapeHtml(s.name)}</span>
          <span class="agent-card-chip is-version">v${escapeHtml(s.version)}</span>
          <span class="spaces-skill-pick-desc">${escapeHtml(s.desc || '')}</span>
        </button>`).join('')
      : `<div class="agents-detail-desc is-empty">${_t('spaces.skills_empty', '暂无可用技能')}</div>`;
    const close = () => { overlay.style.display = 'none'; };
    overlay.style.display = 'flex';
    document.getElementById('spaces-main-skill-cancel').onclick = close;
    list.querySelectorAll('.spaces-skill-pick-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const assetId = row.dataset.skillId;
        const version = row.dataset.skillVersion || '1.0';
        const res = await _invoke('spaces.update', {
          spaceId: space.space_id,
          main_skill_ref: { asset_id: assetId, version },
        });
        close();
        if (res.error) { _notifyFail(_t('spaces.update_fail', '保存失败'), res.error); return; }
        await _loadData();
        _renderDetail();
      });
    });
  }

  async function _renderDetail() {
    const seq = ++_detailRenderSeq;
    const view = document.getElementById('spaces-view');
    const space = _space();
    if (!space) { _detail = null; _renderGallery(); return; }
    const tpl = _templates.find((t) => t.template_id === space.template_id) || null;
    const tplName = tpl ? tpl.name : (space.template_name || _t('spaces.no_template', '未选模板'));
    const icon = space.icon ? escapeHtml(space.icon) : _icon('box', 'ui-icon');
    if (seq !== _detailRenderSeq) return; // 过期渲染丢弃（chips 快速切换时旧 fetch 不覆盖）

    view.innerHTML = `
      <div class="agents-grid-view">
        <div class="agents-detail-header">
          <div class="agents-detail-title-row">
            <button type="button" class="btn btn-sm" id="spaces-back-btn">${_icon('chevron-left', 'ui-icon')} ${_t('spaces.back', '返回')}</button>
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
          ${_renderDetailMainSkill(space)}
          ${_renderDetailSkills(tpl)}
          ${_renderDetailAgents(tpl)}
          ${_renderDetailResources(space)}
        </div>
      </div>`;

    document.getElementById('spaces-back-btn').addEventListener('click', () => { _detail = null; _renderGallery(); });
    document.getElementById('spaces-delete-btn').addEventListener('click', () => _deleteSpace(space));
    document.getElementById('spaces-rename-btn').addEventListener('click', () => _renameSpace(space));
    _bindDetailBody(space);
  }

  async function _bindDetailBody(space) {
    // 空间目标行内编辑
    _bindGoalEditor(space);
    // 主技能绑定/解除
    document.getElementById('spaces-main-skill-bind-btn')?.addEventListener('click', () => _openMainSkillPicker(space));
    document.querySelector('[data-space-unbind-main]')?.addEventListener('click', async () => {
      const res = await _invoke('spaces.update', { spaceId: space.space_id, main_skill_ref: null });
      if (res.error) { _notifyFail(_t('spaces.update_fail', '保存失败'), res.error); return; }
      await _loadData();
      _renderDetail();
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
    await _renderDetail();
  }

  function _openDetail(spaceId) {
    _detail = spaceId;
    _renderDetail();
  }

  async function _deleteSpace(space) {
    const msg = `${_t('spaces.delete_confirm', '删除情境空间？')}\n${_t('spaces.delete_confirm2', '空间配置将被删除，空间内会话不受影响。')}`;
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
  function _openCreateModal(preselectTemplateId) {
    const overlay = document.getElementById('spaces-modal');
    if (!overlay) return;
    const tplGrid = document.getElementById('spaces-modal-templates');
    const cards = ['', ..._templates].map((t) => {
      if (!t) {
        return `<label class="spaces-tpl-card" data-template="">
          <span class="spaces-tpl-tag"></span>
          <span class="spaces-tpl-name">${_t('spaces.blank_tpl', '空白空间')}</span>
          <span class="spaces-tpl-desc">${_t('spaces.blank_tpl_desc', '不套模板：全资源可用，手动拼装')}</span>
        </label>`;
      }
      const nSkills = (t.bundle?.skill_ids || []).length;
      const nAgents = (t.bundle?.agent_ids || []).length;
      return `<label class="spaces-tpl-card" data-template="${escapeHtml(t.template_id)}">
        <span class="spaces-tpl-tag"></span>
        <span class="spaces-tpl-name">${escapeHtml(t.name)}</span>
        <span class="spaces-tpl-desc">${escapeHtml(t.description || '')}</span>
        <span class="spaces-tpl-bundle">${_t('spaces.tpl_bundle', '自带')} ${nSkills} ${_t('spaces.skills_unit', '技能')} · ${nAgents} ${_t('spaces.agents_unit', '智能体')}</span>
      </label>`;
    }).join('');
    tplGrid.innerHTML = cards;
    // 按点击顺序选中：第 1 个为主模板，第 2/3 个为副模板（1 主 + 最多 2 副）
    // 预选（角色模板 tab 点卡进入）：第 1 个即主模板
    const selected = preselectTemplateId ? [preselectTemplateId] : [];
    const cardEls = tplGrid.querySelectorAll('.spaces-tpl-card');
    const refreshTplSelection = () => {
      cardEls.forEach((el) => {
        const idx = selected.indexOf(el.dataset.template);
        el.classList.toggle('is-selected', idx >= 0);
        el.classList.toggle('is-primary', idx === 0);
        el.classList.toggle('is-secondary', idx > 0);
        const tag = el.querySelector('.spaces-tpl-tag');
        if (tag) {
          tag.textContent = idx === 0 ? _t('spaces.tpl_primary', '主') : idx > 0 ? _t('spaces.tpl_secondary', '副') : '';
          tag.classList.toggle('is-visible', idx >= 0);
        }
      });
    };
    cardEls.forEach((el) => {
      el.addEventListener('click', () => {
        const tpl = el.dataset.template || '';
        const idx = selected.indexOf(tpl);
        if (idx >= 0) {
          selected.splice(idx, 1);
        } else {
          if (selected.length >= 3) return; // 1 主 + 2 副
          selected.push(tpl);
        }
        refreshTplSelection();
      });
    });
    if (selected.length) refreshTplSelection(); // 预选模板时立即标"主"
    const nameInput = document.getElementById('spaces-modal-name');
    nameInput.value = '';
    nameInput.focus();
    overlay.style.display = 'flex';

    const close = () => { overlay.style.display = 'none'; };
    document.getElementById('spaces-modal-cancel').onclick = close;
    document.getElementById('spaces-modal-create').onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const primary = selected[0] || undefined;
      const secondary = selected.slice(1, 3);
      const res = await _invoke('spaces.create', {
        name,
        ...(primary ? { primary_template_id: primary } : {}),
        ...(secondary.length ? { secondary_template_ids: secondary } : {}),
      });
      if (res.error) { _notifyFail(_t('spaces.create_fail', '创建失败'), res.error); return; }
      close();
      await _loadData();
      _filter = 'scenarios';
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
