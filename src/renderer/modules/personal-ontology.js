// 个人本体面板 — classic script (window.renderPersonalOntology)
// 资料库式布局：左栏文件列表（候选 / 角色模板 / 记忆分组），右栏内容
// （候选详情确认 / 分组 md 双区编辑器）。数据与记忆页、@ Picker 共享同一份。
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _t(key, fallback) {
    try { if (typeof t === 'function') { const v = t(key); if (v && v !== key) return v; } } catch (_) {}
    return fallback;
  }

  function _tv(key, vars, fallback) {
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
      else console.warn('[personal-ontology]', prefix, msg);
    } catch (_) {}
  }

  /** SVG 图标（AGENTS.md：图标走 icons.js，不用 emoji/文本符号）。 */
  function _icon(name, className) {
    try {
      if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
        return window.uiIconHtml(name, className || 'ui-icon');
      }
    } catch (_) {}
    return '';
  }

  // ── state ────────────────────────────────────────────────────────────────
  let _pocGroups = [];
  let _pocGroupsLoaded = false;
  let _pocTemplates = [];
  let _pocTemplatesLoaded = false;
  let _pocCandidates = [];
  let _pocBlocked = [];
  let _pocProjectNames = null; // Map(pid → name)，二期 D5 字段值 @项目 显示用（懒加载）
  let _pocSkillNames = null;  // Map(id → {name, desc})，模板库 bundle 展示用（懒加载）
  let _pocAgentNames = null;  // Map(id → {name, desc})
  let _pocLibraryModalBound = false; // 模板库弹窗持久节点只绑一次
  // 右栏选中：{kind:'candidates'} | {kind:'candidate',id} | {kind:'group',id}
  let _pocSelected = { kind: 'candidates' };
  // 每张候选卡片的去向选择状态：candidate_id -> { toGlobalMemory, groupIds, field }
  const _pocDestState = new Map();
  // 组 → 字段清单缓存（"填入字段"下拉选项）
  const _pocFieldCache = new Map();
  // 被收起的模板（template_id 集合）
  const _pocCollapsedTemplates = new Set();
  // 分组内容编辑器 { groupId, content, fields, entries, view:'form'|'flow'|'raw', isTemplated }
  let _pocGroupEditor = null;

  async function _pocInvoke(channel, payload) {
    try {
      const res = await window.orkas.invoke(channel, payload || {});
      return res || { ok: false, error: 'no response' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  async function _pocLoadGroups() {
    const res = await _pocInvoke('personalOntology.groups.list', {});
    _pocGroups = (res && res.ok !== false && Array.isArray(res.groups)) ? res.groups : [];
    _pocGroupsLoaded = true;
  }

  async function _pocLoadTemplates() {
    const res = await _pocInvoke('personalOntology.templates.list', {});
    _pocTemplates = (res && res.ok !== false && Array.isArray(res.templates)) ? res.templates : [];
    _pocTemplatesLoaded = true;
    // 已安装模板默认展开：_pocCollapsedTemplates 是"收起"集合，保持为空即全部展开
  }

  async function _pocLoadAll() {
    await Promise.all([_pocLoadGroups(), _pocLoadTemplates()]);
  }

  // ── 分组选择（去向面板）：模板文件分节（复合 id）+ 快捷全选 ───────────────
  function _pocRenderGroupRows(candidateId) {
    const state = _pocDestFor(candidateId);
    const plain = _pocGroups.filter((g) => !g.template_id);
    const rows = [];
    for (const g of plain) {
      const checked = state.groupIds.has(g.group_id);
      rows.push(`<label class="personal-onto-dest-group-row">
        <input type="checkbox" class="personal-onto-dest-group-checkbox"
               data-candidate-id="${escapeHtml(candidateId)}" data-group-id="${escapeHtml(g.group_id)}"
               ${checked ? 'checked' : ''} />
        <span>${escapeHtml(g.title || '')}</span>
      </label>`);
    }
    for (const t of _pocTemplates) {
      if (!t.installed || !t.sections || !t.sections.length) continue;
      const collapsed = _pocCollapsedTemplates.has(t.template_id);
      const refs = t.sections.map((s) => `${t.group_id}::${s.title}`);
      const allChecked = refs.every((r) => state.groupIds.has(r));
      const someChecked = refs.some((r) => state.groupIds.has(r));
      rows.push(`<div class="personal-onto-dest-template" data-template-id="${escapeHtml(t.template_id)}">
        <label class="personal-onto-dest-template-row">
          <input type="checkbox" class="personal-onto-dest-template-checkbox"
                data-candidate-id="${escapeHtml(candidateId)}" data-template-id="${escapeHtml(t.template_id)}"
                ${allChecked ? 'checked' : ''} />
          <span class="personal-onto-dest-template-caret" data-candidate-id="${escapeHtml(candidateId)}" data-template-id="${escapeHtml(t.template_id)}">${collapsed ? _icon('chevron-right', 'ui-icon personal-onto-dest-caret') : _icon('chevron-down', 'ui-icon personal-onto-dest-caret')}</span>
          <span class="personal-onto-dest-template-name">${escapeHtml(t.name)}</span>
          ${someChecked && !allChecked ? `<span class="personal-onto-dest-template-partial muted">(部分)</span>` : ''}
        </label>
        ${!collapsed ? `<div class="personal-onto-dest-template-groups">${t.sections.map((s) => {
          const ref = `${t.group_id}::${s.title}`;
          const checked = state.groupIds.has(ref);
          return `<label class="personal-onto-dest-group-row is-template-child">
            <input type="checkbox" class="personal-onto-dest-group-checkbox"
                  data-candidate-id="${escapeHtml(candidateId)}" data-group-id="${escapeHtml(ref)}"
                  ${checked ? 'checked' : ''} />
            <span>${escapeHtml(s.title)}</span>
          </label>`;
        }).join('')}</div>` : ''}
      </div>`);
    }
    return rows.join('');
  }

  // ── 字段清单懒加载（"填入字段"下拉）──────────────────────────────────────
  async function _pocFieldsForGroup(groupId) {
    if (_pocFieldCache.has(groupId)) return _pocFieldCache.get(groupId);
    try {
      const res = await window.orkas.invoke('personalOntology.groups.fields.list', { groupId });
      const fields = (res && res.ok !== false && Array.isArray(res.fields)) ? res.fields : [];
      _pocFieldCache.set(groupId, fields);
      return fields;
    } catch (_) {
      _pocFieldCache.set(groupId, []);
      return [];
    }
  }

  function _pocFieldOptionsFor(candidateId) {
    const state = _pocDestState.get(candidateId);
    if (!state || !state.groupIds.size) return null;
    const gid = Array.from(state.groupIds)[0];
    return _pocFieldCache.has(gid) ? _pocFieldCache.get(gid) : null;
  }

  function _pocMaybeLoadFieldOptions(candidateId) {
    const state = _pocDestState.get(candidateId);
    if (!state) return;
    const gid = state.groupIds.size ? Array.from(state.groupIds)[0] : (state.roleGroupId || null);
    if (!gid) return;
    if (_pocFieldCache.has(gid)) return;
    _pocFieldsForGroup(gid).then(() => {
      if (_pocDestState.has(candidateId)) _pocRerenderDetail();
    }).catch(() => {});
  }

  function _pocDestFor(candidateId, initialField) {
    let state = _pocDestState.get(candidateId);
    if (!state) {
      // 全局记忆恒写（确认 = 必进全局记忆）；角色为可选叠加层。
      state = { toGlobalMemory: true, groupIds: new Set(), field: initialField || 'flow', advancedOpen: false };
      _pocDestState.set(candidateId, state);
    }
    return state;
  }

  // ── 驳回原因 modal ───────────────────────────────────────────────────────
  function showRejectReasonModal() {
    return new Promise((resolve) => {
      const overlay = document.getElementById('personal-onto-modal');
      const textarea = document.getElementById('personal-onto-modal-reason');
      const okBtn = document.getElementById('personal-onto-modal-ok');
      const cancelBtn = document.getElementById('personal-onto-modal-cancel');
      if (!overlay || !textarea) { resolve(''); return; }
      textarea.value = '';
      overlay.style.display = 'flex';
      textarea.focus();
      function cleanup(value) {
        overlay.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onOk() { cleanup(textarea.value || ''); }
      function onCancel() { cleanup(null); }
      function onOverlay(e) { if (e.target === overlay) cleanup(null); }
      function onKey(e) {
        if (e.key === 'Escape') cleanup(null);
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cleanup(textarea.value || ''); }
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKey);
    });
  }

  // ── 候选详情（右栏）──────────────────────────────────────────────────────
  /** 已安装模板 → 角色单选列表。每个选项显示角色名 + 分节数·字段数。 */
  function _pocRenderRoleOptions(candidateId) {
    const state = _pocDestFor(candidateId);
    const installed = _pocTemplates.filter((t) => t.installed);
    if (!installed.length) {
      return `<div class="personal-onto-dest-empty muted">${_t('personalOntology.dest_no_roles', '尚未安装角色模板，可在「角色模板库」中安装')}</div>`;
    }
    const rows = installed.map((t) => {
      const nSections = (t.sections || []).length;
      const nFields = (t.sections || []).reduce((n, s) => n + (s.fields || []).length, 0);
      const selected = state.roleGroupId === t.group_id;
      return `<label class="personal-onto-dest-role-row${selected ? ' is-selected' : ''}">
        <input type="radio" name="personal-onto-dest-role" class="personal-onto-dest-role-radio"
               data-candidate-id="${escapeHtml(candidateId)}" data-group-id="${escapeHtml(t.group_id || '')}"
               ${selected ? 'checked' : ''} />
        <span class="personal-onto-dest-role-name">${escapeHtml(t.name)}</span>
        <span class="personal-onto-dest-role-meta">${nSections} ${_t('personalOntology.dest_role_sections', '分节')} · ${nFields} ${_t('personalOntology.dest_role_fields', '字段')}</span>
      </label>`;
    }).join('');
    return rows;
  }

  /** 高级区（默认折叠）：原分节树 + 填入字段 + 新建分组。 */
  function _pocRenderAdvanced(candidateId) {
    const state = _pocDestFor(candidateId);
    const fieldOptions = _pocFieldOptionsFor(candidateId);
    const fieldValue = state.field && state.field !== 'flow' ? state.field : 'flow';
    const fieldRows = fieldOptions && fieldOptions.length
      ? fieldOptions.map((f) => `<option value="${escapeHtml(f.name)}"${fieldValue === f.name ? ' selected' : ''}>${escapeHtml(f.name)}</option>`).join('')
      : (fieldOptions === null
          ? `<option value="flow" disabled>${escapeHtml(_t('personalOntology.dest_field_loading', '选中分组后加载字段…'))}</option>`
          : '');
    const fieldSelect = `
      <div class="personal-onto-dest-field-row">
        <label class="personal-onto-dest-field-label">${_t('personalOntology.dest_field_label', '填入字段')}</label>
        <select class="personal-onto-dest-field-select" data-candidate-id="${escapeHtml(candidateId)}">
          <option value="flow"${fieldValue === 'flow' ? ' selected' : ''}>${_t('personalOntology.dest_field_flow', '流水区（不填坑）')}</option>
          ${fieldRows}
        </select>
      </div>`;
    const groupsHtml = _pocGroupsLoaded && !_pocGroups.length
      ? `<div class="personal-onto-dest-empty muted">${_t('personalOntology.dest_no_groups', '暂无记忆分组')}</div>`
      : `<div class="personal-onto-dest-groups">${_pocRenderGroupRows(candidateId)}</div>`;
    return `
      <div class="personal-onto-dest-advanced" data-candidate-id="${escapeHtml(candidateId)}">
        <button type="button" class="personal-onto-dest-advanced-toggle" data-candidate-id="${escapeHtml(candidateId)}">
          ${state.advancedOpen ? _icon('chevron-down', 'ui-icon personal-onto-dest-advanced-caret') : _icon('chevron-right', 'ui-icon personal-onto-dest-advanced-caret')}
          <span>${_t('personalOntology.dest_advanced_label', '高级选项')}</span>
          <span class="muted">${_t('personalOntology.dest_advanced_hint', '精确到分组/字段')}</span>
        </button>
        ${state.advancedOpen ? `
          <div class="personal-onto-dest-advanced-body">
            ${groupsHtml}
            ${fieldSelect}
            <div class="personal-onto-dest-create-row">
              <input type="text" class="personal-onto-dest-new-group-input"
                     data-candidate-id="${escapeHtml(candidateId)}"
                     placeholder="${escapeHtml(_t('personalOntology.dest_new_group_placeholder', '新建分组名称...'))}" />
              <button type="button" class="btn btn-sm personal-onto-dest-create-btn" data-candidate-id="${escapeHtml(candidateId)}">
                ${_t('personalOntology.dest_create_group_btn', '新建')}
              </button>
            </div>
          </div>` : ''}
      </div>`;
  }

  function renderDestinationPanel(candidateId) {
    return `
      <div class="personal-onto-dest-panel" data-candidate-id="${escapeHtml(candidateId)}">
        <div class="personal-onto-dest-ai-hint">
          ${_icon('sparkles', 'ui-icon personal-onto-dest-ai-icon')}
          <span>${_t('personalOntology.dest_ai_hint', '确认时 AI 会自动把这条内容归入最合适的位置，你可在模板文件里随时调整')}</span>
        </div>
        <div class="personal-onto-dest-title">${_t('personalOntology.dest_role_title', '存入角色（可选）')}</div>
        <div class="personal-onto-dest-roles">
          ${_pocRenderRoleOptions(candidateId)}
        </div>
        ${_pocRenderAdvanced(candidateId)}
      </div>`;
  }

  function renderCandidateDetail(candidate) {
    _pocDestFor(candidate.candidate_id, candidate.target_field);
    const kindLabel = {
      preference: _t('personalOntology.kind_preference', '偏好'),
      instance: _t('personalOntology.kind_instance', '实例'),
      property: _t('personalOntology.kind_property', '属性'),
      relation: _t('personalOntology.kind_relation', '关系'),
      rule: _t('personalOntology.kind_rule', '规则'),
    }[candidate.kind] || candidate.kind;
    const confidenceLabel = {
      low: _t('personalOntology.confidence_low', '低'),
      medium: _t('personalOntology.confidence_medium', '中'),
      high: _t('personalOntology.confidence_high', '高'),
    }[candidate.confidence] || candidate.confidence;
    const scopeLabel = candidate.memory_scope === 'shared'
      ? _t('personalOntology.scope_shared', '共享记忆')
      : _t('personalOntology.scope_user', '个人画像');

    return `<div class="personal-onto-detail-card" data-candidate-id="${escapeHtml(candidate.candidate_id)}">
      <div class="personal-onto-card-header">
        <span class="personal-onto-card-kind">${escapeHtml(kindLabel)}</span>
        <span class="personal-onto-card-confidence">${_t('personalOntology.confidence', '置信度')}: ${escapeHtml(confidenceLabel)}</span>
        <span class="personal-onto-card-scope">${escapeHtml(scopeLabel)}</span>
      </div>
      <div class="personal-onto-card-body">
        <div class="personal-onto-card-field personal-onto-card-summary">${escapeHtml(candidate.summary || candidate.memory_text || '-')}</div>
        ${candidate.registry_like_path ? `<div class="personal-onto-card-field"><strong>${_t('personalOntology.path', '路径')}:</strong> ${escapeHtml(candidate.registry_like_path)}</div>` : ''}
        ${candidate.diff_summary ? `<div class="personal-onto-card-field"><strong>${_t('personalOntology.diff', '差异')}:</strong> ${escapeHtml(candidate.diff_summary)}</div>` : ''}
        <div class="personal-onto-card-field"><strong>${_t('personalOntology.sources', '来源')}:</strong> ${candidate.source_memory_refs && candidate.source_memory_refs.length ? escapeHtml(candidate.source_memory_refs.join(', ')) : '-'}</div>
      </div>
      ${renderDestinationPanel(candidate.candidate_id)}
      <div class="personal-onto-card-actions">
        <button class="btn btn-sm personal-onto-btn-confirm" data-candidate-id="${escapeHtml(candidate.candidate_id)}">${_t('personalOntology.confirm_btn', '确认')}</button>
        <button class="btn btn-sm personal-onto-btn-reject" data-candidate-id="${escapeHtml(candidate.candidate_id)}">${_t('personalOntology.reject_btn', '驳回')}</button>
      </div>
    </div>`;
  }

  function _pocRerenderDetail() {
    renderPersonalOntology();
  }

  function _pocRenderBlockedCard(item) {
    return `<div class="personal-onto-blocked-card">
      <div class="personal-onto-blocked-header">
        <span class="personal-onto-blocked-icon">${_icon('warning', 'ui-icon')}</span>
        <span class="personal-onto-blocked-source">${escapeHtml(item.source_ref || '-')}</span>
      </div>
      <div class="personal-onto-blocked-body">
        <div class="personal-onto-blocked-field"><strong>${_t('personalOntology.blocked_reason', '原因')}:</strong> ${escapeHtml(item.reason || '-')}</div>
        <div class="personal-onto-blocked-field"><strong>${_t('personalOntology.blocked_fix', '修复建议')}:</strong> ${escapeHtml(item.required_fix || '-')}</div>
      </div>
    </div>`;
  }

  // ── 分组内容编辑器（右栏，双区 md / 模板文件分节式）────────────────────────
  function _pocParseFlowEntries(content) {
    const flowIdx = String(content || '').indexOf('## 流水区');
    const flowText = flowIdx === -1 ? String(content || '') : String(content || '').slice(flowIdx + '## 流水区'.length);
    return flowText.split('\n§\n').map((s) => s.trim()).filter(Boolean);
  }

  // 模板文件分节解析（渲染层简易版，格式与主进程 parseTemplateContent 一致）：
  // 按 `## 分节` 切块，块内取 `### 流水` 小节按 § 切条目。
  function _pocParseTemplateSections(content) {
    const out = {};
    const parts = String(content || '').split(/^##\s+(.+)$/m);
    for (let i = 1; i < parts.length; i += 2) {
      const title = parts[i].trim();
      const body = parts[i + 1] || '';
      const flowIdx = body.indexOf('### 流水');
      const flowText = flowIdx === -1 ? '' : body.slice(flowIdx + '### 流水'.length);
      out[title] = flowText.split('\n§\n').map((s) => s.trim()).filter(Boolean);
    }
    return out;
  }

  // 模板文件表单视图：全部分节平铺，每分节 = 字段表单 + 分节流水。
  // 字段/流水操作走复合 id（`groupId::分节`）。
  function _pocRenderTemplateFormView(ed) {
    if (!ed.sections || !ed.sections.length) {
      return `<div class="memory-empty muted">${escapeHtml(_t('memory.group_form_no_fields', '该模板没有分节'))}</div>`;
    }
    return ed.sections.map((sec) => {
      const ref = `${ed.groupId}::${sec.title}`;
      const fields = (sec.fields || []).map((f) => `
        <div class="memory-group-field" data-mem-group-field="${escapeHtml(f.name)}">
          <div class="memory-group-field-name">
            <span class="memory-group-field-name-text">${escapeHtml(f.name)}</span>
            ${f.isCustom ? `<span class="memory-group-field-custom-badge">${escapeHtml(_t('memory.group_field_custom_badge', '自定义'))}</span>` : ''}
          </div>
          <div class="memory-group-field-values">
            ${f.values && f.values.length
              ? f.values.map((v) => `
                <div class="memory-group-field-value">
                  <span class="memory-group-field-value-text">${escapeHtml(v.value)}</span>
                  <span class="memory-group-field-source muted">${escapeHtml(_tv('memory.group_field_value_source', { value: '', source: v.source }))}</span>
                  ${v.project ? `<span class="memory-group-field-project">@${escapeHtml(_pocProjectNames ? (_pocProjectNames.get(v.project) || v.project) : v.project)}</span>` : ''}
                  <button type="button" class="memory-icon-btn" data-poc-group-action="field-edit-value"
                    data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}" data-poc-value="${escapeHtml(v.value)}"
                    title="${escapeHtml(_t('memory.edit', '编辑'))}">${_icon('edit-pencil', 'ui-icon')}</button>
                  <button type="button" class="memory-icon-btn is-muted" data-poc-group-action="field-remove-value"
                    data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}" data-poc-value="${escapeHtml(v.value)}"
                    title="${escapeHtml(_t('memory.delete', '删除'))}">${_icon('x', 'ui-icon')}</button>
                </div>`).join('')
              : `<span class="memory-group-field-empty muted">${escapeHtml(_t('memory.group_field_empty', '暂无值'))}</span>`}
          </div>
          <div class="memory-group-field-add">
            <input type="text" class="memory-group-field-input" data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}"
              placeholder="${escapeHtml(_t('memory.group_field_add_placeholder', '填值…'))}" />
            <button type="button" class="btn btn-sm btn-primary" data-poc-group-action="field-add-value"
              data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}">${escapeHtml(_t('memory.save', '保存'))}</button>
          </div>
        </div>`).join('');
      const flows = (ed.entriesBySection && ed.entriesBySection[sec.title]) || [];
      const flowRows = flows.length
        ? flows.map((e) => `
          <div class="memory-group-flow-entry">
            <span class="memory-group-flow-text">${escapeHtml(e)}</span>
            <button type="button" class="btn btn-sm" data-poc-group-action="entry-promote"
              data-poc-ref="${escapeHtml(ref)}" data-poc-entry="${escapeHtml(e)}">${escapeHtml(_t('memory.group_promote', '升格'))}</button>
            <button type="button" class="memory-icon-btn is-muted" data-poc-group-action="entry-remove"
              data-poc-ref="${escapeHtml(ref)}" data-poc-entry="${escapeHtml(e)}" title="${escapeHtml(_t('memory.delete', '删除'))}">${_icon('x', 'ui-icon')}</button>
          </div>`).join('')
        : `<div class="memory-empty muted">${escapeHtml(_t('memory.group_flow_empty', '暂无流水条目'))}</div>`;
      return `<div class="memory-group-template-section">
        <div class="memory-group-template-section-title">${escapeHtml(sec.title)}</div>
        <div class="memory-group-template-section-fields">${fields}</div>
        <div class="memory-group-template-section-flow">
          <div class="memory-group-template-flow-title">${escapeHtml(_t('memory.group_flow_view', '流水'))}</div>
          ${flowRows}
        </div>
      </div>`;
    }).join('');
  }

  function _pocRenderGroupFormView(ed) {
    if (!ed.fields) return `<div class="memory-empty muted">${escapeHtml(_t('common.loading', '加载中...'))}</div>`;
    if (!ed.fields.length) return `<div class="memory-empty muted">${escapeHtml(_t('memory.group_form_no_fields', '该组没有可填字段'))}</div>`;
    const rows = ed.fields.map((f) => `
      <div class="memory-group-field" data-mem-group-field="${escapeHtml(f.name)}">
        <div class="memory-group-field-name">
          <span class="memory-group-field-name-text">${escapeHtml(f.name)}</span>
          ${f.isRelation ? `<span class="memory-group-field-rel" title="关系字段">A → B</span>` : ''}
          ${f.description ? `<span class="memory-group-field-desc muted">${escapeHtml(f.description)}</span>` : ''}
        </div>
        <div class="memory-group-field-values">
          ${f.values && f.values.length
            ? f.values.map((v) => `
              <div class="memory-group-field-value">
                <span class="memory-group-field-value-text">${escapeHtml(v.value)}</span>
                <span class="memory-group-field-source muted">${escapeHtml(_tv('memory.group_field_value_source', { value: '', source: v.source }))}</span>
                ${v.project ? `<span class="memory-group-field-project">@${escapeHtml(_pocProjectNames ? (_pocProjectNames.get(v.project) || v.project) : v.project)}</span>` : ''}
                <button type="button" class="memory-icon-btn" data-poc-group-action="field-edit-value"
                  data-poc-field="${escapeHtml(f.name)}" data-poc-value="${escapeHtml(v.value)}"
                  title="${escapeHtml(_t('memory.edit', '编辑'))}">${_icon('edit-pencil', 'ui-icon')}</button>
                <button type="button" class="memory-icon-btn is-muted" data-poc-group-action="field-remove-value"
                  data-poc-field="${escapeHtml(f.name)}" data-poc-value="${escapeHtml(v.value)}"
                  title="${escapeHtml(_t('memory.delete', '删除'))}">${_icon('x', 'ui-icon')}</button>
              </div>`).join('')
            : `<span class="memory-group-field-empty muted">${escapeHtml(_t('memory.group_field_empty', '暂无值'))}</span>`}
        </div>
        <div class="memory-group-field-add">
          <input type="text" class="memory-group-field-input" data-poc-field="${escapeHtml(f.name)}"
            placeholder="${escapeHtml(_t('memory.group_field_add_placeholder', '填值…'))}" />
          <button type="button" class="btn btn-sm btn-primary" data-poc-group-action="field-add-value"
            data-poc-field="${escapeHtml(f.name)}">${escapeHtml(_t('memory.save', '保存'))}</button>
        </div>
      </div>`).join('');
    return `<div class="memory-group-form-view">${rows}</div>`;
  }

  function _pocRenderGroupFlowView(ed) {
    const entries = ed.entries || [];
    if (!entries.length) return `<div class="memory-empty muted">${escapeHtml(_t('memory.group_flow_empty', '暂无流水条目'))}</div>`;
    const rows = entries.map((e, i) => `
      <div class="memory-group-flow-entry">
        <span class="memory-group-flow-idx">${i + 1}.</span>
        <span class="memory-group-flow-text">${escapeHtml(e)}</span>
        <button type="button" class="btn btn-sm" data-poc-group-action="entry-promote" data-poc-entry="${escapeHtml(e)}">${escapeHtml(_t('memory.group_promote', '升格'))}</button>
        <button type="button" class="memory-icon-btn is-muted" data-poc-group-action="entry-remove" data-poc-entry="${escapeHtml(e)}" title="${escapeHtml(_t('memory.delete', '删除'))}">${_icon('x', 'ui-icon')}</button>
      </div>`).join('');
    return `<div class="memory-group-flow-view">${rows}</div>`;
  }

  function _pocRenderGroupRawView(ed) {
    return `<textarea class="memory-entry-textarea memory-group-editor-textarea" rows="14" data-poc-group-content>${escapeHtml(ed.content || '')}</textarea>`;
  }

  function _pocRenderGroupEditorHtml() {
    const ed = _pocGroupEditor;
    if (!ed) return '';
    if (ed.isTemplated) {
      // 模板文件：多分节平铺（表单 / 原文）
      const view = ed.view || 'form';
      const tab = (key, label) => `<button type="button" class="memory-group-editor-tab${view === key ? ' is-active' : ''}" data-poc-group-action="view-${key}">${escapeHtml(label)}</button>`;
      const group = _pocGroups.find((g) => g.group_id === ed.groupId);
      return `<div class="personal-onto-group-editor" data-poc-group-editor="${escapeHtml(ed.groupId)}">
        <div class="personal-onto-group-editor-head">
          <span class="personal-onto-group-editor-title">${escapeHtml((group && group.title) || ed.groupId)}</span>
          <span class="memory-template-name-suffix">${escapeHtml(_t('memory.templates_suffix', '模板'))}</span>
        </div>
        <div class="memory-group-editor-tabs">
          ${tab('form', _t('memory.group_form_view', '表单'))}
          ${tab('raw', _t('memory.group_raw_view', '原文'))}
        </div>
        <div class="personal-onto-group-editor-body">
          ${view === 'form' ? _pocRenderTemplateFormView(ed) : _pocRenderGroupRawView(ed)}
        </div>
        <div class="memory-entry-foot">
          <span class="memory-entry-charcount">${ed.content ? ed.content.length : 0}</span>
          <span class="memory-flex"></span>
          ${view === 'raw' ? `<button type="button" class="btn btn-sm btn-primary" data-poc-group-action="save-content">${escapeHtml(_t('memory.save', '保存'))}</button>` : ''}
        </div>
      </div>`;
    }
    const view = ed.view || 'raw';
    const tab = (key, label) => `<button type="button" class="memory-group-editor-tab${view === key ? ' is-active' : ''}" data-poc-group-action="view-${key}">${escapeHtml(label)}</button>`;
    const group = _pocGroups.find((g) => g.group_id === ed.groupId);
    const badge = (group && group.template_id)
      ? `<span class="memory-group-template-badge">${escapeHtml(_tv('memory.group_template_badge', { name: group.template_id, version: group.template_version }))}</span>`
      : '';
    const tabs = ed.isTemplated
      ? `<div class="memory-group-editor-tabs">
          ${tab('form', _t('memory.group_form_view', '表单'))}
          ${tab('flow', _t('memory.group_flow_view', '流水'))}
          ${tab('raw', _t('memory.group_raw_view', '原文'))}
        </div>`
      : '';
    return `<div class="personal-onto-group-editor" data-poc-group-editor="${escapeHtml(ed.groupId)}">
      <div class="personal-onto-group-editor-head">
        <span class="personal-onto-group-editor-title">${escapeHtml((group && group.title) || ed.groupId)}</span>${badge}
      </div>
      ${tabs}
      <div class="personal-onto-group-editor-body">
        ${view === 'form' ? _pocRenderGroupFormView(ed)
          : view === 'flow' ? _pocRenderGroupFlowView(ed)
          : _pocRenderGroupRawView(ed)}
      </div>
      <div class="memory-entry-foot">
        <span class="memory-entry-charcount">${ed.content ? ed.content.length : 0}</span>
        <span class="memory-flex"></span>
        ${view === 'raw' ? `<button type="button" class="btn btn-sm btn-primary" data-poc-group-action="save-content">${escapeHtml(_t('memory.save', '保存'))}</button>` : ''}
      </div>
    </div>`;
  }

  async function _pocEnsureProjectNames() {
    if (_pocProjectNames) return _pocProjectNames;
    try {
      const res = await window.orkas.invoke('projects.list');
      const projects = (res && Array.isArray(res.projects)) ? res.projects : [];
      _pocProjectNames = new Map(projects.map((p) => [p.project_id, p.name || p.project_id]));
    } catch (_) {
      _pocProjectNames = new Map();
    }
    return _pocProjectNames;
  }

  async function _pocOpenGroup(groupId) {
    _pocSelected = { kind: 'group', id: groupId };
    const group = _pocGroups.find((g) => g.group_id === groupId);
    const isTemplate = !!(group && group.template_id);
    const tmpl = isTemplate ? _pocTemplates.find((t) => t.template_id === group.template_id) : null;
    _pocGroupEditor = {
      groupId,
      content: '',
      loaded: false,
      isTemplated: isTemplate,
      templateId: isTemplate ? group.template_id : undefined,
      sections: isTemplate && tmpl ? tmpl.sections : undefined,
      entriesBySection: null,
      view: isTemplate ? 'form' : 'raw',
    };
    await _pocEnsureProjectNames(); // 二期 D5：字段值 @项目 显示需要项目名映射
    renderPersonalOntology();
    const res = await _pocInvoke('personalOntology.groups.read', { groupId });
    if (!_pocGroupEditor || _pocGroupEditor.groupId !== groupId) return;
    if (!res || res.ok === false) { _pocGroupEditor = null; renderPersonalOntology(); return; }
    _pocGroupEditor.content = res.content || '';
    _pocGroupEditor.loaded = true;
    if (_pocGroupEditor.isTemplated) {
      // 模板文件：分节流水从原文解析（渲染层简易解析，格式同主进程）
      _pocGroupEditor.entriesBySection = _pocParseTemplateSections(_pocGroupEditor.content);
    } else {
      const fieldsRes = await _pocInvoke('personalOntology.groups.fields.list', { groupId });
      if (_pocGroupEditor && _pocGroupEditor.groupId === groupId) {
        _pocGroupEditor.fields = (fieldsRes && fieldsRes.ok !== false && Array.isArray(fieldsRes.fields)) ? fieldsRes.fields : [];
        _pocGroupEditor.entries = _pocParseFlowEntries(_pocGroupEditor.content);
      }
    }
    renderPersonalOntology();
  }

  async function _pocRefreshGroupData() {
    const ed = _pocGroupEditor;
    if (!ed) return;
    // 模板文件：重新拉 templates（文件是唯一事实来源）刷新分节/字段/流水
    if (ed.isTemplated) {
      const [res, tRes] = await Promise.all([
        _pocInvoke('personalOntology.groups.read', { groupId: ed.groupId }),
        _pocInvoke('personalOntology.templates.list', {}),
      ]);
      if (!_pocGroupEditor || _pocGroupEditor.groupId !== ed.groupId) return;
      if (res && res.ok !== false) {
        _pocGroupEditor.content = res.content || '';
        _pocGroupEditor.entriesBySection = _pocParseTemplateSections(_pocGroupEditor.content);
      }
      if (tRes && tRes.ok !== false && Array.isArray(tRes.templates)) {
        _pocTemplates = tRes.templates;
        const tmpl = _pocTemplates.find((t) => t.template_id === ed.templateId);
        _pocGroupEditor.sections = tmpl && tmpl.sections ? tmpl.sections : [];
      }
      renderPersonalOntology();
      return;
    }
    const res = await _pocInvoke('personalOntology.groups.read', { groupId: ed.groupId });
    if (!_pocGroupEditor || _pocGroupEditor.groupId !== ed.groupId || !res || res.ok === false) return;
    _pocGroupEditor.content = res.content || '';
    if (_pocGroupEditor.isTemplated) {
      const fieldsRes = await _pocInvoke('personalOntology.groups.fields.list', { groupId: ed.groupId });
      if (_pocGroupEditor && _pocGroupEditor.groupId === ed.groupId) {
        _pocGroupEditor.fields = (fieldsRes && fieldsRes.ok !== false && Array.isArray(fieldsRes.fields)) ? fieldsRes.fields : [];
        _pocGroupEditor.entries = _pocParseFlowEntries(_pocGroupEditor.content);
      }
    }
    renderPersonalOntology();
  }

  async function _pocGroupAction(action, payload) {
    const res = await _pocInvoke(action, payload);
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.op_failed', '操作失败'), new Error((res && res.error) || ''));
      return false;
    }
    return true;
  }

  // ── 模板管理 ─────────────────────────────────────────────────────────────
  /** 安装模板：有归档 → 让用户选「恢复原数据 / 重建空模板」；无归档 → 直接装。 */
  async function _pocInstallTemplate(templateId) {
    const tmpl = _pocTemplates.find((x) => x.template_id === templateId);
    const groupCount = tmpl && tmpl.sections ? tmpl.sections.length : 0;
    let restoreData = false;
    // 有归档旧数据 → 提供恢复选项
    try {
      const ar = await _pocInvoke('personalOntology.templates.hasArchive', { templateId });
      if (ar && ar.hasArchive) {
        if (typeof uiConfirmDanger === 'function') {
          const restoreOk = await uiConfirmDanger({
            title: _t('personalOntology.template_reinstall_title', '重新安装'),
            message: _t('personalOntology.template_reinstall_prompt', '检测到该模板的归档数据。要恢复原数据，还是重建空模板？'),
            dangerLabel: _t('personalOntology.template_restore_btn', '恢复原数据'),
          });
          // uiConfirmDanger 确认 = 恢复；取消 = 询问是否重建空模板
          if (restoreOk) restoreData = true;
          else {
            const freshOk = (typeof uiConfirm === 'function')
              ? await uiConfirm({ message: _t('personalOntology.template_rebuild_prompt', '重建空模板？（不恢复归档数据）') })
              : true;
            if (!freshOk) return;
          }
        } else {
          restoreData = false;
        }
      }
    } catch (_) {}
    const res = await _pocInvoke('personalOntology.templates.install', { templateId, restoreData });
    if (!res || res.ok === false) {
      if (res && res.error === 'template_limit_reached') {
        try { if (typeof uiAlert === 'function') uiAlert(_t('personalOntology.template_limit', '最多安装 3 个角色模板，请先卸载一个')); } catch (_) {}
        return;
      }
      _notifyFail(_t('personalOntology.templates_install_error', '模板安装失败'), new Error((res && res.error) || ''));
      return;
    }
    try {
      if (typeof uiToast === 'function') {
        if (res.already_installed) uiToast(_t('memory.templates_already_installed', '该模板已安装'), { variant: 'info' });
        else if (res.restored_from_archive) uiToast(_t('personalOntology.template_restored_ok', '模板已安装，归档数据已恢复'), { variant: 'success' });
        else uiToast(_t('memory.templates_installed_ok', '模板安装成功'), { variant: 'success' });
        if (res.conflict_groups && res.conflict_groups.length) {
          uiToast(_t('memory.templates_conflict', { groups: res.conflict_groups.map((g) => g.title).join('、') }), { variant: 'warning' });
        }
      }
    } catch (_) {}
    await _pocLoadGroups();
    await _pocLoadTemplates();
    renderPersonalOntology();
  }

  /** 卸载模板：确认（含全局记忆归档选项）→ 主进程归档 + 台账移除 → 提示归档位置。 */
  async function _pocUninstallTemplate(templateId) {
    const tmpl = _pocTemplates.find((x) => x.template_id === templateId);
    const name = (tmpl && tmpl.name) || templateId;
    // 该角色有没有全局记忆归档可带走
    let memCount = 0;
    try {
      const mc = await _pocInvoke('memory.roleTemplateCount', { templateId });
      if (mc && typeof mc.count === 'number') memCount = mc.count;
    } catch (_) {}
    const archiveMemory = memCount > 0
      ? (typeof uiConfirm === 'function'
          ? await uiConfirm({
              message: _tv('personalOntology.template_uninstall_mem_confirm', { name, n: memCount },
                '「{name}」有 {n} 条全局记忆（该角色来源）。是否一起归档？归档后重装可一并恢复。'),
            })
          : true)
      : false;
    if (!archiveMemory && memCount > 0) {
      // 用户选择不归档全局记忆 → 只卸模板
      const ok2 = (typeof uiConfirmDanger === 'function')
        ? await uiConfirmDanger({
            title: _t('personalOntology.template_uninstall_title', '卸载角色模板'),
            message: _tv('personalOntology.template_uninstall_confirm', { name }, '卸载「{name}」？模板数据将归档保留（可重新安装恢复），不影响全局记忆。'),
            dangerLabel: _t('personalOntology.template_uninstall_btn', '卸载'),
          })
        : true;
      if (!ok2) return;
    }
    const res = await _pocInvoke('personalOntology.templates.uninstall', { templateId, archiveMemory: memCount > 0 ? !!archiveMemory : false });
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.template_uninstall_error', '卸载失败'), new Error((res && res.error) || ''));
      return;
    }
    try {
      if (typeof uiToast === 'function') {
        if (res.archived_memory_count > 0) {
          uiToast(_tv('personalOntology.template_uninstalled_mem_ok', { name, n: res.archived_memory_count }, '已卸载「{name}」，模板与 {n} 条全局记忆已一并归档'), { variant: 'success' });
        } else {
          uiToast(_tv('personalOntology.template_uninstalled_ok', { name }, '已卸载「{name}」，数据已归档'), { variant: 'success' });
        }
        if (res.archive_dir) uiToast(_tv('personalOntology.template_archive_path', { path: res.archive_dir }, '归档位置：{path}'), { variant: 'info' });
      }
    } catch (_) {}
    // 如果当前正打开该模板的分组编辑器 → 回退总览
    if (_pocSelected.kind === 'group' && _pocGroupEditor && _pocGroupEditor.templateId === templateId) {
      _pocSelected = { kind: 'candidates' };
      _pocGroupEditor = null;
    }
    await _pocLoadGroups();
    await _pocLoadTemplates();
    renderPersonalOntology();
  }

  /** 懒加载 skill/agent 名称映射（模板库 bundle 展示用）。 */
  async function _pocEnsureResourceNames() {
    if (_pocSkillNames && _pocAgentNames) return;
    try {
      const [skillsRes, agentsRes] = await Promise.all([
        _pocInvoke('skills.list'),
        _pocInvoke('agents.list'),
      ]);
      _pocSkillNames = new Map((skillsRes.skills || []).map((s) => [s.id, { name: s.name || s.id, desc: (s.description_zh || s.description_en || '').trim() }]));
      _pocAgentNames = new Map((agentsRes.agents || []).map((a) => [a.agent_id, { name: a.name || a.agent_id, desc: (a.description_zh || a.description_en || '').trim() }]));
    } catch (_) {
      _pocSkillNames = _pocSkillNames || new Map();
      _pocAgentNames = _pocAgentNames || new Map();
    }
  }

  /** 模板 bundle → skill/agent 行（名称 + 一句能力简介，与工作空间详情同源）。 */
  function _pocRenderBundle(t) {
    const skillIds = (t.bundle && t.bundle.skill_ids) || [];
    const agentIds = (t.bundle && t.bundle.agent_ids) || [];
    if (!skillIds.length && !agentIds.length) return '';
    const rows = [];
    for (const id of skillIds) {
      const info = _pocSkillNames ? _pocSkillNames.get(id) : null;
      rows.push(`<div class="personal-onto-library-res">
        <span class="personal-onto-library-res-tag is-skill">${_t('personalOntology.bundle_skill', '技能')}</span>
        <div class="personal-onto-library-res-main">
          <span class="personal-onto-library-res-name">${escapeHtml((info && info.name) || id)}</span>
          ${info && info.desc ? `<span class="personal-onto-library-res-desc">${escapeHtml(info.desc)}</span>` : ''}
        </div>
      </div>`);
    }
    for (const id of agentIds) {
      const info = _pocAgentNames ? _pocAgentNames.get(id) : null;
      rows.push(`<div class="personal-onto-library-res">
        <span class="personal-onto-library-res-tag is-agent">${_t('personalOntology.bundle_agent', '智能体')}</span>
        <div class="personal-onto-library-res-main">
          <span class="personal-onto-library-res-name">${escapeHtml((info && info.name) || id)}</span>
          ${info && info.desc ? `<span class="personal-onto-library-res-desc">${escapeHtml(info.desc)}</span>` : ''}
        </div>
      </div>`);
    }
    return `<div class="personal-onto-library-res-list">
      <div class="personal-onto-library-res-title">${_t('personalOntology.template_bundle_label', '配套能力')}</div>
      ${rows.join('')}
    </div>`;
  }

  /** 角色模板库弹窗：列出全部模板（已安装带卸载按钮，未安装带安装按钮），超 3 上限置灰。 */
  async function _pocOpenTemplateLibrary() {
    await _pocEnsureResourceNames();
    const installedCount = _pocTemplates.filter((t) => t.installed).length;
    const atLimit = installedCount >= 3;
    const all = _pocTemplates.slice().sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
    const listEl = document.getElementById('personal-onto-template-library-list');
    if (!listEl) return;
    listEl.innerHTML = all.length
      ? all.map((t) => {
          const nSections = (t.sections || []).length;
          const nFields = (t.sections || []).reduce((n, s) => n + (s.fields || []).length, 0);
          const uninstallBtn = t.installed
            ? `<button type="button" class="personal-onto-library-uninstall" data-template-id="${escapeHtml(t.template_id)}"
                 title="${escapeHtml(_t('personalOntology.template_uninstall_tip', '卸载（数据归档保留）'))}">${_icon('x', 'ui-icon')}</button>`
            : '';
          const installBtn = t.installed
            ? `<span class="personal-onto-library-installed muted">${_t('personalOntology.template_installed_badge', '已安装')}</span>`
            : `<button type="button" class="btn btn-sm btn-primary personal-onto-library-install" data-template-id="${escapeHtml(t.template_id)}"
                 ${atLimit ? 'disabled' : ''}>${_t('memory.templates_install', '安装')}</button>`;
          return `<div class="personal-onto-library-card${t.installed ? ' is-installed' : ''}" data-template-id="${escapeHtml(t.template_id)}">
            <div class="personal-onto-library-card-head">
              <span class="personal-onto-library-card-name">${escapeHtml(t.name)}</span>
              <span class="personal-onto-library-card-meta">${nSections} ${_t('personalOntology.dest_role_sections', '分节')} · ${nFields} ${_t('personalOntology.dest_role_fields', '字段')}</span>
              ${uninstallBtn}
            </div>
            ${t.description ? `<div class="personal-onto-library-card-desc">${escapeHtml(t.description)}</div>` : ''}
            ${_pocRenderBundle(t)}
            <div class="personal-onto-library-card-foot">
              ${installBtn}
              ${!t.installed && atLimit ? `<span class="personal-onto-library-limit muted">${_t('personalOntology.template_limit_hint', '已达 3 个上限，需先卸载一个')}</span>` : ''}
            </div>
          </div>`;
        }).join('')
      : `<div class="personal-onto-empty">${_t('personalOntology.template_library_empty', '模板库为空')}</div>`;
    // 事件绑定必须在 innerHTML 填充后做（弹窗每次打开都重写列表）
    listEl.querySelectorAll('.personal-onto-library-install').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.templateId;
        if (!tid || btn.disabled) return;
        await _pocInstallTemplate(tid);
        _pocOpenTemplateLibrary(); // 刷新列表（上限置灰变化）
      });
    });
    listEl.querySelectorAll('.personal-onto-library-uninstall').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.templateId;
        if (!tid) return;
        await _pocUninstallTemplate(tid);
        _pocOpenTemplateLibrary();
      });
    });
    const overlay = document.getElementById('personal-onto-template-library-modal');
    if (overlay) overlay.style.display = 'flex';
  }

  // ── 左栏导航渲染 ─────────────────────────────────────────────────────────
  function _pocRenderNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;

    const section = (title, count, body) => body
      ? `<div class="personal-onto-nav-section">
          <div class="personal-onto-nav-section-head"><span>${escapeHtml(title)}</span><span class="muted">${count}</span></div>
          ${body}
        </div>`
      : `<div class="personal-onto-nav-section">
          <div class="personal-onto-nav-section-head"><span>${escapeHtml(title)}</span><span class="muted">${count}</span></div>
          <div class="personal-onto-nav-empty muted">${escapeHtml(_t('personalOntology.nav_empty', '暂无'))}</div>
        </div>`;

    // 候选区
    const pendingCount = _pocCandidates.length;
    const blockedCount = _pocBlocked.length;
    const candRows = _pocCandidates.map((c) => {
      const selected = _pocSelected.kind === 'candidate' && _pocSelected.id === c.candidate_id;
      return `<button type="button" class="personal-onto-nav-row${selected ? ' is-active' : ''}" data-poc-nav="candidate" data-poc-id="${escapeHtml(c.candidate_id)}">
        <span class="personal-onto-nav-row-text">${escapeHtml(c.summary || c.memory_text || c.candidate_id)}</span>
        <span class="personal-onto-nav-row-meta">${escapeHtml(c.confidence || '')}</span>
      </button>`;
    }).join('');

    // 模板区：已安装 = 可点击文件行（带卸载按钮）；未安装 = 收进「角色模板库」
    const installedTmpls = _pocTemplates.filter((t) => t.installed);
    const uninstalledCount = _pocTemplates.length - installedTmpls.length;
    const templateRows = installedTmpls.map((tmpl) => {
      const selected = _pocSelected.kind === 'group' && _pocSelected.id === tmpl.group_id;
      return `<div class="personal-onto-nav-template-row${selected ? ' is-active' : ''}">
        <button type="button" class="personal-onto-nav-row is-file${selected ? ' is-active' : ''}" data-poc-nav="group" data-poc-id="${escapeHtml(tmpl.group_id || '')}">
          <span class="personal-onto-nav-file-icon">${_icon('file-text', 'ui-icon')}</span>
          <span class="personal-onto-nav-row-text">${escapeHtml(tmpl.name)}</span>
          <span class="memory-template-name-suffix">${escapeHtml(_t('memory.templates_suffix', '模板'))}</span>
        </button>
        <button type="button" class="personal-onto-template-uninstall" data-poc-nav="template-uninstall" data-poc-template-id="${escapeHtml(tmpl.template_id)}"
                title="${escapeHtml(_t('personalOntology.template_uninstall_tip', '卸载（数据归档保留）'))}">${_icon('x', 'ui-icon')}</button>
      </div>`;
    }).join('');
    const templateSection = section(
      _t('personalOntology.nav_templates', '角色模板'),
      installedTmpls.length,
      templateRows
        ? `<div class="personal-onto-nav-template-list">${templateRows}</div>
           ${uninstalledCount ? `<button type="button" class="personal-onto-template-library-btn" data-poc-nav="template-library">
             ${_icon('package', 'ui-icon personal-onto-template-library-icon')}
             <span>${_t('personalOntology.template_library', '角色模板库')}</span>
             <span class="personal-onto-template-library-count">${uninstalledCount}</span>
           </button>` : ''}`
        : (uninstalledCount
          ? `<button type="button" class="personal-onto-template-library-btn" data-poc-nav="template-library">
               ${_icon('package', 'ui-icon personal-onto-template-library-icon')}
               <span>${_t('personalOntology.template_library', '角色模板库')}</span>
               <span class="personal-onto-template-library-count">${uninstalledCount}</span>
             </button>`
          : `<div class="personal-onto-nav-empty muted">${escapeHtml(_t('personalOntology.nav_empty', '暂无'))}</div>`),
    );

    // 普通分组区
    const plainGroups = _pocGroups.filter((g) => !g.template_id);
    const groupRows = plainGroups.map((g) => {
      const selected = _pocSelected.kind === 'group' && _pocSelected.id === g.group_id;
      return `<button type="button" class="personal-onto-nav-row is-file${selected ? ' is-active' : ''}" data-poc-nav="group" data-poc-id="${escapeHtml(g.group_id)}">
        <span class="personal-onto-nav-file-icon">${_icon('file-text', 'ui-icon')}</span>
        <span class="personal-onto-nav-row-text">${escapeHtml(g.title)}</span>
      </button>`;
    }).join('');

    nav.innerHTML =
      section(_t('personalOntology.nav_candidates', '候选'), pendingCount, candRows) +
      templateSection +
      section(_t('personalOntology.nav_groups', '记忆分组'), plainGroups.length, groupRows);
  }

  // ── 右栏渲染 ─────────────────────────────────────────────────────────────
  function _pocRenderMain() {
    const headerEl = document.getElementById('personal-onto-main-header');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!headerEl || !bodyEl) return;

    if (_pocSelected.kind === 'candidate') {
      const c = _pocCandidates.find((x) => x.candidate_id === _pocSelected.id);
      if (c) {
        headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.candidate_detail', '候选详情'))}</span>`;
        bodyEl.innerHTML = renderCandidateDetail(c);
        _pocBindDetail(bodyEl);
        _pocMaybeLoadFieldOptions(c.candidate_id);
        return;
      }
    }
    if (_pocSelected.kind === 'group' && _pocGroupEditor) {
      headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.group_detail', '分组内容'))}</span>`;
      bodyEl.innerHTML = _pocRenderGroupEditorHtml();
      _pocBindGroupEditor(bodyEl);
      return;
    }
    // 默认：候选总览（统计 + 批量操作）
    const pendingCount = _pocCandidates.length;
    headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.candidates_title', '候选列表'))}</span>`;
    let html = `<div class="personal-onto-stats-row">
      <div class="personal-onto-stat-card"><div class="personal-onto-stat-value">${pendingCount}</div><div class="personal-onto-stat-label">${escapeHtml(_t('personalOntology.pending', '待确认'))}</div></div>
      <div class="personal-onto-stat-card personal-onto-stat-card-blocked"><div class="personal-onto-stat-value">${_pocBlocked.length}</div><div class="personal-onto-stat-label">${escapeHtml(_t('personalOntology.blocked', '已阻断'))}</div></div>
    </div>`;
    if (pendingCount > 0) {
      html += `<div class="personal-onto-overview-actions">
        <button class="btn btn-sm" id="personal-onto-confirm-all">${escapeHtml(_t('personalOntology.confirm_all_btn', '全部确认'))}</button>
        <button class="btn btn-sm" id="personal-onto-reject-all">${escapeHtml(_t('personalOntology.reject_all_btn', '全部驳回'))}</button>
      </div>`;
    }
    if (!pendingCount && !_pocBlocked.length) {
      html += `<div class="personal-onto-empty">${escapeHtml(_t('personalOntology.empty', '暂无候选'))}</div>`;
    }
    if (_pocBlocked.length) {
      html += `<div class="personal-onto-section"><h3 class="personal-onto-section-title">${escapeHtml(_t('personalOntology.blocked_title', '阻断项'))}</h3>${_pocBlocked.map(_pocRenderBlockedCard).join('')}</div>`;
    }
    bodyEl.innerHTML = html;
    const confirmAllBtn = document.getElementById('personal-onto-confirm-all');
    if (confirmAllBtn) confirmAllBtn.addEventListener('click', () => confirmAll(_pocCandidates));
    const rejectAllBtn = document.getElementById('personal-onto-reject-all');
    if (rejectAllBtn) rejectAllBtn.addEventListener('click', () => rejectAll(_pocCandidates));
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────
  function _pocBindNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;
    nav.querySelectorAll('[data-poc-nav]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const action = el.getAttribute('data-poc-nav');
        const id = el.getAttribute('data-poc-id');
        if (action === 'candidate') { _pocSelected = { kind: 'candidate', id }; renderPersonalOntology(); }
        else if (action === 'group') { _pocOpenGroup(id); }
        else if (action === 'template-library') {
          e.stopPropagation();
          _pocOpenTemplateLibrary();
        }
        else if (action === 'template-uninstall') {
          e.stopPropagation();
          const tid = el.getAttribute('data-poc-template-id');
          if (tid) _pocUninstallTemplate(tid);
        }
      });
    });
    // 角色模板库弹窗：关闭/遮罩点击 —— 持久节点，只绑一次（防监听器累积）
    const libOverlay = document.getElementById('personal-onto-template-library-modal');
    if (libOverlay && !_pocLibraryModalBound) {
      _pocLibraryModalBound = true;
      libOverlay.addEventListener('click', (e) => {
        if (e.target === libOverlay) libOverlay.style.display = 'none';
      });
      const closeBtn = document.getElementById('personal-onto-template-library-close');
      if (closeBtn) closeBtn.addEventListener('click', () => { libOverlay.style.display = 'none'; });
      const cancelBtn = document.getElementById('personal-onto-template-library-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', () => { libOverlay.style.display = 'none'; });
    }
    // 安装/卸载按钮绑定在 _pocOpenTemplateLibrary 内部完成（每次 innerHTML 重写后重新绑定）
  }

  function _pocBindDetail(root) {
    root.querySelectorAll('.personal-onto-btn-confirm').forEach((btn) => {
      btn.addEventListener('click', () => confirmCandidate(btn.dataset.candidateId));
    });
    root.querySelectorAll('.personal-onto-btn-reject').forEach((btn) => {
      btn.addEventListener('click', () => rejectCandidate(btn.dataset.candidateId));
    });
    _pocBindDestinationControls(root);
  }

  function _pocBindDestinationControls(root) {
    // 角色单选：选中 → 记录 roleGroupId 并清空分节勾选（角色层与高级层互斥）
    root.querySelectorAll('.personal-onto-dest-role-radio').forEach((radio) => {
      radio.addEventListener('change', () => {
        const state = _pocDestFor(radio.dataset.candidateId);
        state.roleGroupId = radio.dataset.groupId || null;
        if (state.roleGroupId) state.groupIds.clear();
        _pocRerenderDetail();
      });
    });
    // 高级区折叠开关
    root.querySelectorAll('.personal-onto-dest-advanced-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const state = _pocDestFor(btn.dataset.candidateId);
        state.advancedOpen = !state.advancedOpen;
        _pocRerenderDetail();
      });
    });
    // 高级区分节勾选：选中任一分节 → 视为精确模式，清掉角色层选择
    root.querySelectorAll('.personal-onto-dest-group-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const state = _pocDestFor(cb.dataset.candidateId);
        if (cb.checked) state.groupIds.add(cb.dataset.groupId);
        else state.groupIds.delete(cb.dataset.groupId);
        if (state.groupIds.size) state.roleGroupId = null;
        _pocRerenderDetail();
        _pocMaybeLoadFieldOptions(cb.dataset.candidateId);
      });
    });
    root.querySelectorAll('.personal-onto-dest-template-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const state = _pocDestFor(cb.dataset.candidateId);
        const t = _pocTemplates.find((x) => x.template_id === cb.dataset.templateId);
        if (!t || !t.installed || !t.sections) return;
        const refs = t.sections.map((s) => `${t.group_id}::${s.title}`);
        for (const ref of refs) {
          if (cb.checked) state.groupIds.add(ref);
          else state.groupIds.delete(ref);
        }
        if (state.groupIds.size) state.roleGroupId = null;
        _pocRerenderDetail();
        _pocMaybeLoadFieldOptions(cb.dataset.candidateId);
      });
    });
    root.querySelectorAll('.personal-onto-dest-template-caret').forEach((el) => {
      el.addEventListener('click', () => {
        const tid = el.dataset.templateId;
        if (!tid) return;
        if (_pocCollapsedTemplates.has(tid)) _pocCollapsedTemplates.delete(tid);
        else _pocCollapsedTemplates.add(tid);
        _pocRerenderDetail();
      });
    });
    root.querySelectorAll('.personal-onto-dest-field-select').forEach((sel) => {
      sel.addEventListener('change', () => { _pocDestFor(sel.dataset.candidateId).field = sel.value; });
    });
    root.querySelectorAll('.personal-onto-dest-create-btn').forEach((btn) => {
      btn.addEventListener('click', () => _createGroupInline(btn.dataset.candidateId));
    });
    root.querySelectorAll('.personal-onto-dest-new-group-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _createGroupInline(input.dataset.candidateId); }
      });
    });
  }

  async function _createGroupInline(candidateId) {
    const input = document.querySelector(`.personal-onto-dest-new-group-input[data-candidate-id="${CSS.escape(candidateId)}"]`);
    const title = (input && input.value || '').trim();
    if (!title) return;
    const res = await _pocInvoke('personalOntology.groups.create', { title });
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.dest_create_group_error', '新建分组失败'), new Error((res && res.error) || ''));
      return;
    }
    await _pocLoadGroups();
    if (res.group) _pocDestFor(candidateId).groupIds.add(res.group.group_id);
    renderPersonalOntology();
  }

  function _pocBindGroupEditor(root) {
    root.querySelectorAll('[data-poc-group-action]').forEach((el) => {
      el.addEventListener('click', async () => {
        const action = el.getAttribute('data-poc-group-action');
        const ed = _pocGroupEditor;
        if (!ed) return;
        // 模板文件分节操作走复合 id（data-poc-ref）；普通组回退 ed.groupId
        const groupId = el.getAttribute('data-poc-ref') || ed.groupId;
        if (action === 'view-form' || action === 'view-flow' || action === 'view-raw') {
          ed.view = action.slice('view-'.length);
          renderPersonalOntology();
          return;
        }
        if (action === 'save-content') {
          const ta = root.querySelector('[data-poc-group-content]');
          if (!ta) return;
          if (await _pocGroupAction('personalOntology.groups.write', { groupId, content: ta.value })) {
            try { if (typeof uiToast === 'function') uiToast(_t('memory.groups_saved', '已保存'), { variant: 'success' }); } catch (_) {}
            await _pocRefreshGroupData();
          }
          return;
        }
        if (action === 'field-add-value') {
          const fieldName = el.getAttribute('data-poc-field');
          const input = root.querySelector(`.memory-group-field-input[data-poc-field="${CSS.escape(fieldName)}"][data-poc-ref="${CSS.escape(groupId)}"]`);
          const value = (input && input.value || '').trim();
          if (!value) return;
          if (await _pocGroupAction('personalOntology.groups.fields.append', { groupId, fieldName, value, source: '手动' })) {
            await _pocRefreshGroupData();
          }
          return;
        }
        if (action === 'field-edit-value') {
          const fieldName = el.getAttribute('data-poc-field');
          const oldValue = el.getAttribute('data-poc-value');
          const newValue = (typeof uiPrompt === 'function') ? await uiPrompt(_t('memory.group_field_edit_prompt', '编辑字段值：'), oldValue) : null;
          if (newValue === null) return;
          const trimmed = String(newValue || '').trim();
          if (!trimmed || trimmed === oldValue) return;
          if (await _pocGroupAction('personalOntology.groups.fields.setValue', { groupId, fieldName, value: trimmed, oldValue })) {
            await _pocRefreshGroupData();
          }
          return;
        }
        if (action === 'field-remove-value') {
          const fieldName = el.getAttribute('data-poc-field');
          const value = el.getAttribute('data-poc-value');
          if (await _pocGroupAction('personalOntology.groups.fields.removeValue', { groupId, fieldName, value })) {
            await _pocRefreshGroupData();
          }
          return;
        }
        if (action === 'entry-promote') {
          const entryText = el.getAttribute('data-poc-entry');
          const fieldName = (typeof uiPrompt === 'function') ? await uiPrompt(_t('memory.group_promote_prompt', '升格为新字段，字段名：'), '') : null;
          if (fieldName === null) return;
          const trimmed = String(fieldName || '').trim();
          if (!trimmed) return;
          const res = await _pocInvoke('personalOntology.groups.entries.promote', { groupId, entryText, fieldName: trimmed });
          if (res && res.ok !== false) {
            if (res.isCustom && typeof uiToast === 'function') {
              uiToast(_tv('memory.group_promote_custom_done', { name: trimmed }, `已创建自定义字段「${trimmed}」（不在模板字段清单内）`), { variant: 'info' });
            }
            await _pocRefreshGroupData();
          } else {
            _pocNotifyFail(_t('personalOntology.op_failed', '操作失败'), new Error((res && res.error) || ''));
          }
          return;
        }
        if (action === 'entry-remove') {
          const entryText = el.getAttribute('data-poc-entry');
          const ok = (typeof uiConfirm === 'function') ? await uiConfirm({ message: _t('memory.group_entry_delete_confirm', '删除这条流水？') }) : true;
          if (!ok) return;
          if (await _pocGroupAction('personalOntology.groups.entries.remove', { groupId, entryText })) {
            await _pocRefreshGroupData();
          }
          return;
        }
      });
    });
  }

  // ── 确认 / 驳回 / 批量 ────────────────────────────────────────────────────
  // 复合 id（groupId::分节）→ 可读标签（模板名.分节名 / 组名）
  function _pocRefLabel(ref) {
    const parts = String(ref || '').split('::');
    const gid = parts[0];
    const sec = parts[1];
    const group = _pocGroups.find((g) => g.group_id === gid);
    if (group) return sec ? `${group.title}.${sec}` : group.title;
    return ref;
  }

  function _destPayloadFor(candidateId) {
    const state = _pocDestFor(candidateId);
    // 全局记忆恒写（确认 = 必进全局记忆）；去向 = 高级分节（精确）或角色模板组（AI 归位）
    let toGroupIds = Array.from(state.groupIds);
    if (!toGroupIds.length && state.roleGroupId) toGroupIds = [state.roleGroupId];
    const payload = { toGlobalMemory: true, toGroupIds };
    if (state.field && state.field !== 'flow') payload.targetField = state.field;
    // 二期 D5：候选自带来源项目标记 → 透传（主进程 dest.projectId 优先于候选）
    const cand = _pocCandidates.find((x) => x.candidate_id === candidateId);
    if (cand && cand.project_id) payload.projectId = cand.project_id;
    return payload;
  }

  function _destResultToWarnings(res) {
    const warnings = [];
    if (res && res.globalMemory && res.globalMemory.ok === false) {
      warnings.push(_tv('personalOntology.dest_global_failed', { error: res.globalMemory.error || '' },
        `全局记忆写入失败: ${res.globalMemory.error || ''}`));
    }
    if (res && Array.isArray(res.groups)) {
      res.groups.forEach((g) => {
        if (g.ok === false) {
          warnings.push(_tv('personalOntology.dest_group_failed', { group: _pocRefLabel(g.groupId), error: g.error || '' },
            `分组「${_pocRefLabel(g.groupId)}」写入失败: ${g.error || ''}`));
        }
      });
    }
    return warnings;
  }

  async function confirmCandidate(candidateId) {
    if (!candidateId) return;
    try {
      // routeWithLlm: true —— 确认时经 LLM 对号入座（用户指定字段时 LLM 不覆盖）
      const res = await window.orkas.invoke('personalOntology.candidates.confirm', {
        candidateId,
        ...(_destPayloadFor(candidateId)),
        routeWithLlm: true,
      });
      const warnings = _destResultToWarnings(res);
      if (res && res.ok === false) {
        _notifyFail(_t('personalOntology.confirm_error', '确认失败'), new Error((res.error || warnings.join('; ')) || ''));
        return;
      }
      try {
        if (typeof uiToast === 'function') {
          if (res.fieldWrites && res.fieldWrites.some((fw) => fw.ok)) {
            const fw = res.fieldWrites.find((x) => x.ok);
            uiToast(_tv('personalOntology.confirm_field_ok', { group: _pocRefLabel(fw.groupId), field: fw.fieldName },
              `已填入 ${_pocRefLabel(fw.groupId)}.${fw.fieldName}`), { variant: 'success' });
          } else if (res.groups && res.groups.some((g) => g.ok)) {
            // 未命中字段 → 进流水区（C-1：单条确认也要有反馈，否则用户以为候选被吞）
            const g = res.groups.find((x) => x.ok);
            uiToast(_tv('personalOntology.confirm_flow_ok', { group: _pocRefLabel(g.groupId) },
              `已进入 ${_pocRefLabel(g.groupId)} 流水区（未匹配到字段）`), { variant: 'info' });
          }
          warnings.forEach((w) => uiToast(w, { variant: 'warning' }));
        }
      } catch (_) {}
      _pocDestState.delete(candidateId);
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.confirm_error', '确认失败'), err);
    }
  }

  async function rejectCandidate(candidateId) {
    if (!candidateId) return;
    const reason = await showRejectReasonModal();
    if (reason === null) return;
    const res = await _pocInvoke('personalOntology.candidates.reject', { candidateId, reason: reason || '' });
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.reject_error', '驳回失败'), new Error((res && res.error) || ''));
      return;
    }
    _pocDestState.delete(candidateId);
    renderPersonalOntology();
  }

  async function confirmAll(pending) {
    if (!pending || !pending.length) return;
    if (!confirm(_t('personalOntology.confirm_all_prompt', `确认全部 ${pending.length} 个候选？`))) return;
    try {
      const failedIds = [];
      const fieldCounts = {};
      let toEntries = 0;
      let okCount = 0;
      for (const c of pending) {
        // 每条候选用各自的选择（角色/分节），不共享第一条的
        const dest = _destPayloadFor(c.candidate_id);
        const state = _pocDestState.get(c.candidate_id);
        const field = state && state.field ? state.field : (c.target_field || 'flow');
        if (field && field !== 'flow') dest.targetField = field;
        // 二期 D5：候选自带来源项目标记 → 透传
        if (c.project_id) dest.projectId = c.project_id;
        const res = await window.orkas.invoke('personalOntology.candidates.confirm', { candidateId: c.candidate_id, ...dest, routeWithLlm: true });
        if (res && res.ok) {
          okCount++;
          for (const fw of (res.fieldWrites || [])) if (fw.ok) fieldCounts[fw.fieldName] = (fieldCounts[fw.fieldName] || 0) + 1;
          for (const g of (res.groups || [])) {
            const hadFieldWrite = (res.fieldWrites || []).some((fw) => fw.ok && fw.groupId === g.groupId);
            if (g.ok && !hadFieldWrite) toEntries++;
          }
        } else {
          failedIds.push(c.candidate_id);
        }
      }
      try {
        if (typeof uiToast === 'function') {
          if (failedIds.length) uiToast(_tv('personalOntology.confirm_all_partial', { n: failedIds.length }, `${failedIds.length} 条确认失败`), { variant: 'warning' });
          const fieldsLabel = Object.keys(fieldCounts).map((f) => `${f}×${fieldCounts[f]}`).join('、') || '-';
          uiToast(_tv('personalOntology.batch_summary', { n: okCount, fields: fieldsLabel, m: toEntries },
            `${okCount} 条已确认：${fieldsLabel}；流水区 ${toEntries} 条`), { variant: 'success' });
        }
      } catch (_) {}
      pending.forEach((c) => _pocDestState.delete(c.candidate_id));
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.confirm_all_error', '批量确认失败'), err);
    }
  }

  async function rejectAll(pending) {
    if (!pending || !pending.length) return;
    const reason = await showRejectReasonModal();
    if (reason === null) return;
    const candidateIds = pending.map((c) => c.candidate_id);
    const res = await _pocInvoke('personalOntology.candidates.rejectBatch', { candidateIds, reason: reason || '' });
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.reject_all_error', '批量驳回失败'), new Error((res && res.error) || ''));
      return;
    }
    candidateIds.forEach((id) => _pocDestState.delete(id));
    renderPersonalOntology();
  }

  // ── 主渲染 ───────────────────────────────────────────────────────────────
  async function renderPersonalOntology() {
    const nav = document.getElementById('personal-onto-nav');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!nav || !bodyEl) {
      console.error('[personal-ontology] missing DOM elements');
      return;
    }

    if (!_pocGroupsLoaded) {
      nav.innerHTML = '<div class="personal-onto-nav-empty muted">' + _t('personalOntology.loading', '加载中...') + '</div>';
      bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.loading', '加载中...') + '</div>';
      await _pocLoadAll();
    }

    try {
      const data = await _pocInvoke('personalOntology.candidates.list', {});
      _pocCandidates = (data && data.candidate_updates) || [];
      _pocBlocked = (data && data.blocked_items) || [];

      // 清掉已不在池里的去向状态
      const liveIds = new Set(_pocCandidates.map((c) => c.candidate_id));
      for (const id of _pocDestState.keys()) {
        if (!liveIds.has(id)) _pocDestState.delete(id);
      }
      // 候选被处理后，右栏回退总览
      if (_pocSelected.kind === 'candidate' && !liveIds.has(_pocSelected.id)) {
        _pocSelected = { kind: 'candidates' };
      }

      _pocRenderNav();
      _pocBindNav();
      _pocRenderMain();
    } catch (err) {
      console.error('[personal-ontology] render failed', err);
      bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.load_error', '加载失败') + ': ' + escapeHtml((err && err.message) || String(err)) + '</div>';
    }
  }

  window.renderPersonalOntology = renderPersonalOntology;
  console.log('[personal-ontology] module loaded, renderPersonalOntology available');
})();
