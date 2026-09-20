// 个人本体工作区 — classic script (window.renderPersonalOntology)
// 嵌入“认知资产 -> 记忆内容 -> 关于我”：左栏角色模板，右栏模板字段与原文。
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

  function _button(options) {
    if (typeof window.uiButton !== 'function') throw new Error('personal ontology requires uiButton');
    return window.uiButton(options);
  }

  function _iconButton(options) {
    if (typeof window.uiIconButton !== 'function') throw new Error('personal ontology requires uiIconButton');
    return window.uiIconButton(options);
  }

  function _input(options) {
    if (typeof window.uiInput !== 'function') throw new Error('personal ontology requires uiInput');
    return window.uiInput(options);
  }

  function _textarea(options) {
    if (typeof window.uiTextarea !== 'function') throw new Error('personal ontology requires uiTextarea');
    return window.uiTextarea(options);
  }

  function _emptyState(options) {
    if (typeof window.uiEmptyState !== 'function') throw new Error('personal ontology requires uiEmptyState');
    return window.uiEmptyState(options);
  }

  // ── state ────────────────────────────────────────────────────────────────
  let _pocTemplates = [];
  let _pocTemplatesLoaded = false;
  let _pocTemplatesLoadError = '';
  let _pocProfile = { entries: [], loaded: false, loadError: '' };
  let _pocProjectNames = null; // Map(pid → name)，二期 D5 字段值 @项目 显示用（懒加载）
  let _pocSkillNames = null;  // Map(id → {name, desc})，模板库 bundle 展示用（懒加载）
  let _pocAgentNames = null;  // Map(id → {name, desc})
  let _pocLibraryModalBound = false; // 模板库弹窗持久节点只绑一次
  let _pocLibraryReturnFocus = null;
  let _pocLibrarySelectedId = ''; // 模板库弹窗当前选中的模板（左列表右详情布局）
  const _pocActionLocks = new Set();
  // ── 本体分组子页（2026-09-20 自记忆页迁入）：分组列表 + 结构化编辑 ──
  let _pocGroups = { list: [], loaded: false, loadError: '' };
  let _pocCandidatesLoaded = false;
  let _pocPendingCandidates = [];
  /** 当前打开的普通组详情 { groupId, title, fields, entries, conflicts, loaded, loadError } */
  let _pocGroupDetail = null;
  // 右栏展示会话沉淀出的基础画像和角色模板；旧候选审核仍由 Recall 正式资产页面负责。
  let _pocSelected = { kind: 'profile', id: 'user-profile' };
  // 模板文件编辑器 { groupId, templateId, sections, content, view:'form'|'raw' }
  let _pocGroupEditor = null;

  // PersonalOntology is stored as durable profile statements. Keep the
  // storage contract flat, but present those statements as a small ontology
  // in the UI so users can understand what kind of information was learned.
  // This is deliberately deterministic and display-only: a statement that
  // cannot be classified remains visible under "其他沉淀".
  const _pocOntologySections = [
    {
      id: 'identity',
      titleKey: 'personalOntology.ontology_identity',
      title: '身份与角色',
      descriptionKey: 'personalOntology.ontology_identity_hint',
      description: '你是谁、承担什么角色以及所在的环境',
      keywords: ['身份', '角色', '职业', '职位', '我是', '我是一名', '我叫', '来自', '居住', '公司', '团队', '程序员', '学生', '负责人', 'identity', 'role', 'job', 'profession', 'i am', 'i\'m'],
    },
    {
      id: 'workstyle',
      titleKey: 'personalOntology.ontology_workstyle',
      title: '工作方式',
      descriptionKey: 'personalOntology.ontology_workstyle_hint',
      description: '你习惯如何思考、决策和推进事情',
      keywords: ['工作方式', '做事', '习惯', '流程', '步骤', '先明确', '验收标准', '方法', '工作风格', 'workflow', 'work style', 'habit', 'process', 'method'],
    },
    {
      id: 'communication',
      titleKey: 'personalOntology.ontology_communication',
      title: '沟通与交互偏好',
      descriptionKey: 'personalOntology.ontology_communication_hint',
      description: '你偏好的表达方式、界面和反馈节奏',
      keywords: ['偏好', '喜欢', '沟通', '表达', '回复', '界面', '信息层次', '简洁', '结论', '语言', '交互', '沟通偏好', 'preference', 'prefer', 'communication', 'interface', 'concise', 'conclusion'],
    },
    {
      id: 'goals',
      titleKey: 'personalOntology.ontology_goals',
      title: '目标与边界',
      descriptionKey: 'personalOntology.ontology_goals_hint',
      description: '你正在追求什么，以及明确不希望发生什么',
      keywords: ['目标', '计划', '希望', '需要', '边界', '不要', '避免', '优先', '验收', '目标是', 'goal', 'plan', 'need', 'boundary', 'avoid', 'priority'],
    },
    {
      id: 'environment',
      titleKey: 'personalOntology.ontology_environment',
      title: '关系与环境',
      descriptionKey: 'personalOntology.ontology_environment_hint',
      description: '与你协作的人、项目和使用环境',
      keywords: ['同事', '家人', '客户', '朋友', '项目', '协作', '合作', '环境', '设备', '地点', '时区', '关系', 'team', 'project', 'collaboration', 'environment', 'device', 'location'],
    },
    {
      id: 'other',
      titleKey: 'personalOntology.ontology_other',
      title: '其他沉淀',
      descriptionKey: 'personalOntology.ontology_other_hint',
      description: '暂时无法归入固定类别的个人信息',
      keywords: [],
    },
  ];

  function _pocClassifyProfileEntry(entry) {
    const normalized = String(entry || '').trim().toLocaleLowerCase();
    if (!normalized) return 'other';
    const matched = _pocOntologySections.find((section) => (
      section.id !== 'other' && section.keywords.some((keyword) => normalized.includes(String(keyword).toLocaleLowerCase()))
    ));
    return matched ? matched.id : 'other';
  }

  function _pocProfileSections() {
    const grouped = new Map(_pocOntologySections.map((section) => [section.id, []]));
    _pocProfile.entries.forEach((entry) => {
      grouped.get(_pocClassifyProfileEntry(entry.text)).push(entry);
    });
    return _pocOntologySections
      .map((section) => ({ ...section, entries: grouped.get(section.id) || [] }))
      .filter((section) => section.entries.length > 0);
  }

  async function _pocInvoke(channel, payload) {
    try {
      const res = await window.cogseed.invoke(channel, payload || {});
      return res || { ok: false, error: 'no response' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  async function _pocLoadTemplates() {
    const res = await _pocInvoke('personalOntology.templates.list', {});
    if (!res || res.ok === false || !Array.isArray(res.templates)) {
      _pocTemplatesLoadError = (res && res.error) || _t('personalOntology.load_error', '加载失败');
      _pocTemplatesLoaded = true;
      return false;
    }
    _pocTemplates = res.templates;
    _pocTemplatesLoadError = '';
    _pocTemplatesLoaded = true;
    return true;
  }

  // 画像源（2026-09-19 记忆退役）：读资产库 personal 正式资产，与对话注入
  // （profile-block.ts）同源同口径——旧 USER.md 档已清空，读它只会得到假空态。
  // 排序对齐 profile-block 三档：72h 内新沉淀 > 用户确认过 > 其余；出身前缀
  // 让「谁说的」在页面上可见。
  async function _pocLoadProfile() {
    const res = await _pocInvoke('recall.assets.list', {});
    if (!res || res.ok === false || !Array.isArray(res.assets)) {
      _pocProfile = {
        entries: [],
        loaded: true,
        loadError: (res && res.error) || _t('personalOntology.load_error', '加载失败'),
      };
      return false;
    }
    const RECENT_MS = 72 * 60 * 60 * 1000;
    const now = Date.now();
    // 两档排序（出身收敛 2026-09-20）：72h 内新沉淀 > 其余；确认/模型记的
    // 不再是维度（与主进程 profile-block 同口径）。
    const tierOf = (asset) => {
      const ts = asset && asset.updatedAt ? Date.parse(asset.updatedAt) : 0;
      return ts && now - ts < RECENT_MS ? 2 : 1;
    };
    // entries 存 { text }：数据层裸文本（桥匹配、分节归组都用原文）。
    _pocProfile = {
      entries: res.assets
        .filter((asset) => asset && asset.type === 'personal' && asset.status === 'active')
        .sort((a, b) => tierOf(b) - tierOf(a)
          || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map((asset) => ({
          text: String(asset.statement || '').trim(),
        }))
        .filter((e) => e.text),
      loaded: true,
      loadError: '',
    };
    return true;
  }

  function _pocSetControlBusy(el, busy) {
    if (!el) return;
    if (busy) {
      el.__pocWasDisabled = !!el.disabled;
      el.disabled = true;
      el.setAttribute('aria-busy', 'true');
    } else {
      el.disabled = !!el.__pocWasDisabled;
      delete el.__pocWasDisabled;
      el.removeAttribute('aria-busy');
    }
  }

  async function _pocRunOnce(key, el, task) {
    if (_pocActionLocks.has(key)) return false;
    _pocActionLocks.add(key);
    _pocSetControlBusy(el, true);
    try {
      await task();
      return true;
    } finally {
      _pocActionLocks.delete(key);
      _pocSetControlBusy(el, false);
    }
  }

  function _pocToast(key, fallback, variant, vars) {
    try {
      const message = vars ? _tv(key, vars, fallback) : _t(key, fallback);
      if (typeof uiToast === 'function') uiToast(message, { variant: variant || 'success' });
    } catch (_) {}
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
    return ed.sections.map((sec, sectionIndex) => {
      const ref = `${ed.groupId}::${sec.title}`;
      const fields = (sec.fields || []).map((f, fieldIndex) => `
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
                  ${_iconButton({ label: _t('memory.edit', '编辑'), icon: 'edit-pencil', className: 'memory-icon-btn', attrs: { 'data-poc-group-action': 'field-edit-value', 'data-poc-ref': ref, 'data-poc-field': f.name, 'data-poc-value': v.value } })}
                  ${_iconButton({ label: _t('memory.delete', '删除'), icon: 'x', variant: 'danger', className: 'memory-icon-btn is-muted', attrs: { 'data-poc-group-action': 'field-remove-value', 'data-poc-ref': ref, 'data-poc-field': f.name, 'data-poc-value': v.value } })}
                </div>`).join('')
              : `<span class="memory-group-field-empty muted">${escapeHtml(_t('memory.group_field_empty', '暂无值'))}</span>`}
          </div>
          <div class="memory-group-field-add">
            ${_input({ id: `personal-onto-field-${sectionIndex}-${fieldIndex}`, className: 'memory-group-field-input', placeholder: _t('memory.group_field_add_placeholder', '填值…'), attrs: { 'data-poc-ref': ref, 'data-poc-field': f.name } })}
            ${_button({ label: _t('memory.save', '保存'), role: 'primary', size: 'sm', attrs: { 'data-poc-group-action': 'field-add-value', 'data-poc-ref': ref, 'data-poc-field': f.name } })}
          </div>
        </div>`).join('');
      const flows = (ed.entriesBySection && ed.entriesBySection[sec.title]) || [];
      const flowRows = flows.length
        ? flows.map((e) => `
          <div class="memory-group-flow-entry">
            <span class="memory-group-flow-text">${escapeHtml(e)}</span>
            ${_button({ label: _t('memory.group_promote', '升格'), size: 'sm', attrs: { 'data-poc-group-action': 'entry-promote', 'data-poc-ref': ref, 'data-poc-entry': e } })}
            ${_iconButton({ label: _t('memory.delete', '删除'), icon: 'x', variant: 'danger', className: 'memory-icon-btn is-muted', attrs: { 'data-poc-group-action': 'entry-remove', 'data-poc-ref': ref, 'data-poc-entry': e } })}
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

  function _pocRenderGroupRawView(ed) {
    return _textarea({ id: 'personal-ontology-group-content', className: 'memory-entry-textarea memory-group-editor-textarea', value: ed.content || '', attrs: { rows: 14, 'data-poc-group-content': '' } });
  }

  // A role template is a narrower projection than the general personal
  // profile. Keep un-routed statements visible while routing is unavailable
  // or ambiguous, but never pretend they belong to a template field.
  /** 出身收敛（2026-09-20 拍板）：模型记下来的=已确定——画像条目就是一条
   *  内容，不再带任何出身前缀/章（确认/模型记的区分全链退役）。 */
  function _pocProfileEntryHtml(entry) {
    return escapeHtml(String(entry && entry.text ? entry.text : ''));
  }

  function _pocRenderTemplateProfileBridge(ed) {
    if (!ed || !ed.loaded || ed.loadError || !_pocProfile.entries.length) return '';
    const content = String(ed.content || '');
    // 比对用裸文本：出身前缀是显示层的装饰，不参与「是否已匹配字段」判定。
    const pending = _pocProfile.entries.filter((entry) => !content.includes(entry.text));
    if (!pending.length) return '';
    return `<section class="personal-onto-template-profile-bridge" aria-label="${escapeHtml(_t('personalOntology.template_profile_bridge_title', '会话沉淀'))}">
      <div class="personal-onto-template-profile-bridge-head">
        <div>
          <div class="personal-onto-template-profile-bridge-title">${escapeHtml(_t('personalOntology.template_profile_bridge_title', '会话沉淀'))}</div>
          <div class="personal-onto-template-profile-bridge-hint">${escapeHtml(_t('personalOntology.template_profile_bridge_hint', '这些信息已确认，但暂未匹配到当前角色模板字段；不会自动填入错误字段。'))}</div>
        </div>
        <span class="personal-onto-template-profile-bridge-count">${escapeHtml(String(pending.length))}</span>
      </div>
      <div class="personal-onto-template-profile-bridge-list">
        ${pending.map((entry) => `<div class="personal-onto-template-profile-bridge-entry">
          <span class="personal-onto-profile-entry-icon">${_icon('file-text', 'ui-icon')}</span>
          <span>${_pocProfileEntryHtml(entry)}</span>
        </div>`).join('')}
      </div>
    </section>`;
  }

  function _pocRenderGroupEditorHtml() {
    const ed = _pocGroupEditor;
    if (!ed) return '';
    const view = ed.view || 'form';
    const ready = !!ed.loaded && !ed.loadError;
    const tab = (key, label) => `<button type="button" class="memory-group-editor-tab${view === key ? ' is-active' : ''}" data-poc-group-action="view-${key}"${ready ? '' : ' disabled'}>${escapeHtml(label)}</button>`;
    const body = !ed.loaded
      ? `<div class="personal-onto-editor-loading" aria-live="polite">${escapeHtml(_t('personalOntology.template_content_loading', '正在加载模板内容...'))}</div>`
      : ed.loadError
        ? `<div class="personal-onto-template-read-error" role="alert">
            <span>${escapeHtml(_t('personalOntology.load_error', '加载失败'))}: ${escapeHtml(ed.loadError)}</span>
            ${_button({ label: _t('personalOntology.retry', '重试'), size: 'sm', attrs: { 'data-poc-group-action': 'reload-group' } })}
          </div>`
        : (view === 'form' ? _pocRenderTemplateFormView(ed) : _pocRenderGroupRawView(ed));
    const profileBridge = _pocRenderTemplateProfileBridge(ed);
    return `<div class="personal-onto-group-editor" data-poc-group-editor="${escapeHtml(ed.groupId)}" aria-busy="${ready ? 'false' : 'true'}">
      <div class="personal-onto-group-editor-head">
        <span class="personal-onto-group-editor-title">${escapeHtml(ed.title || ed.groupId)}</span>
        <span class="memory-template-name-suffix">${escapeHtml(_t('memory.templates_suffix', '模板'))}</span>
      </div>
      <div class="memory-group-editor-tabs">
        ${tab('form', _t('memory.group_form_view', '表单'))}
        ${tab('raw', _t('memory.group_raw_view', '原文'))}
      </div>
      ${profileBridge}
      <div class="personal-onto-group-editor-body">
        ${body}
      </div>
      <div class="memory-entry-foot">
        <span class="memory-entry-charcount">${ready && ed.content ? ed.content.length : 0}</span>
        <span class="memory-flex"></span>
        ${view === 'raw' && ready ? _button({ label: _t('memory.save', '保存'), role: 'primary', size: 'sm', attrs: { 'data-poc-group-action': 'save-content' } }) : ''}
      </div>
    </div>`;
  }

  async function _pocEnsureProjectNames() {
    if (_pocProjectNames) return _pocProjectNames;
    try {
      const res = await window.cogseed.invoke('projects.list');
      const projects = (res && Array.isArray(res.projects)) ? res.projects : [];
      _pocProjectNames = new Map(projects.map((p) => [p.project_id, p.name || p.project_id]));
    } catch (_) {
      _pocProjectNames = new Map();
    }
    return _pocProjectNames;
  }

  async function _pocOpenGroup(groupId) {
    const tmpl = _pocTemplates.find((t) => t.installed && t.group_id === groupId);
    if (!tmpl) return;
    _pocSelected = { kind: 'template', id: groupId };
    const editor = {
      groupId,
      title: tmpl.name,
      content: '',
      loaded: false,
      templateId: tmpl.template_id,
      sections: tmpl.sections || [],
      entriesBySection: null,
      view: 'form',
    };
    _pocGroupEditor = editor;
    renderPersonalOntology();
    await _pocEnsureProjectNames(); // 二期 D5：字段值 @项目 显示需要项目名映射
    const res = await _pocInvoke('personalOntology.groups.read', { groupId });
    if (_pocGroupEditor !== editor) return;
    editor.loaded = true;
    if (!res || res.ok === false) {
      editor.loadError = (res && res.error) || _t('personalOntology.load_error', '加载失败');
      renderPersonalOntology();
      return;
    }
    editor.content = res.content || '';
    editor.entriesBySection = _pocParseTemplateSections(editor.content);
    renderPersonalOntology();
  }

  function _pocRenderProfileView() {
    if (_pocProfile.loadError) {
      return `<div class="personal-onto-profile-error" role="alert">
        <span>${escapeHtml(_t('personalOntology.profile_load_error', '个人画像加载失败'))}: ${escapeHtml(_pocProfile.loadError)}</span>
      </div>`;
    }
    if (!_pocProfile.entries.length) {
      return `<section class="personal-onto-profile-view personal-onto-ontology-view" aria-label="${escapeHtml(_t('personalOntology.ontology_title', '个人本体'))}">
        <div class="personal-onto-ontology-intro">
          <div class="personal-onto-ontology-hint">${escapeHtml(_t('personalOntology.ontology_hint', '从已确认的会话沉淀中归纳你的身份、工作方式和偏好'))}</div>
        </div>
        <div class="personal-onto-empty personal-onto-profile-empty">
          ${escapeHtml(_t('personalOntology.profile_empty', '完成会话沉淀后，个人信息会显示在这里'))}
        </div>
      </section>`;
    }
    const sections = _pocProfileSections();
    return `<section class="personal-onto-profile-view personal-onto-ontology-view" aria-label="${escapeHtml(_t('personalOntology.ontology_title', '个人本体'))}">
      <div class="personal-onto-ontology-intro">
        <div>
          <div class="personal-onto-ontology-hint">${escapeHtml(_t('personalOntology.ontology_hint', '从已确认的会话沉淀中归纳你的身份、工作方式和偏好'))}</div>
        </div>
        <div class="personal-onto-profile-head">
          <span class="personal-onto-profile-count">${escapeHtml(String(_pocProfile.entries.length))}</span>
          <span class="muted">${escapeHtml(_t('personalOntology.profile_source', '会话沉淀'))}</span>
        </div>
      </div>
      <div class="personal-onto-ontology-sections">
        ${sections.map((section) => `<section class="personal-onto-ontology-section" data-poc-ontology-section="${escapeHtml(section.id)}">
          <div class="personal-onto-ontology-section-head">
            <div class="personal-onto-ontology-section-title-row">
              <span class="personal-onto-profile-entry-icon">${_icon('user', 'ui-icon')}</span>
              <div>
                <div class="personal-onto-ontology-section-title">${escapeHtml(_t(section.titleKey, section.title))}</div>
                <div class="personal-onto-ontology-section-description">${escapeHtml(_t(section.descriptionKey, section.description))}</div>
              </div>
            </div>
            <span class="personal-onto-ontology-section-count">${escapeHtml(String(section.entries.length))}</span>
          </div>
          <div class="personal-onto-profile-list">
            ${section.entries.map((entry) => `<div class="personal-onto-profile-entry">
              <span class="personal-onto-profile-entry-icon">${_icon('file-text', 'ui-icon')}</span>
              <span class="personal-onto-profile-entry-text">${_pocProfileEntryHtml(entry)}</span>
            </div>`).join('')}
          </div>
        </section>`).join('')}
      </div>
    </section>`;
  }

  async function _pocRefreshGroupData() {
    const ed = _pocGroupEditor;
    if (!ed) return;
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
      _pocGroupEditor.title = (tmpl && tmpl.name) || _pocGroupEditor.title;
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
    await _pocLoadTemplates();
    const installed = _pocTemplates.find((t) => t.installed && t.template_id === templateId);
    if (installed) _pocSelected = { kind: 'template', id: installed.group_id };
    _pocGroupEditor = null;
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
    if (memCount === 0) {
      const ok = (typeof uiConfirmDanger === 'function')
        ? await uiConfirmDanger({
            title: _t('personalOntology.template_uninstall_title', '卸载角色模板'),
            message: _tv('personalOntology.template_uninstall_confirm', { name }, '卸载「{name}」？模板数据将归档保留（可重新安装恢复），不影响全局记忆。'),
            dangerLabel: _t('personalOntology.template_uninstall_btn', '卸载'),
          })
        : (typeof uiConfirm === 'function'
            ? await uiConfirm({ message: _tv('personalOntology.template_uninstall_confirm', { name }, '卸载「{name}」？模板数据将归档保留（可重新安装恢复），不影响全局记忆。') })
            : true);
      if (!ok) return;
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
    // 当前模板卸载后由渲染器自动切换到下一个已安装模板。
    if (_pocGroupEditor && _pocGroupEditor.templateId === templateId) {
      _pocSelected = { kind: 'template', id: null };
      _pocGroupEditor = null;
    }
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
    const detailEl = document.getElementById('personal-onto-template-library-detail');
    if (!listEl || !detailEl) return;
    if (!all.length) {
      listEl.innerHTML = `<div class="personal-onto-empty">${_t('personalOntology.template_library_empty', '模板库为空')}</div>`;
      detailEl.innerHTML = '';
    } else {
      if (!_pocLibrarySelectedId || !all.some((t) => t.template_id === _pocLibrarySelectedId)) {
        _pocLibrarySelectedId = all[0].template_id;
      }
      const selected = all.find((t) => t.template_id === _pocLibrarySelectedId) || all[0];
      listEl.innerHTML = all.map((t) => {
        const active = t.template_id === selected.template_id ? ' is-active' : '';
        const installedBadge = t.installed ? `<span class="personal-onto-library-installed muted">${_t('personalOntology.template_installed_badge', '已安装')}</span>` : '';
        return `<button type="button" class="personal-onto-library-row${active}" data-template-id="${escapeHtml(t.template_id)}">
          <span class="personal-onto-library-row-name">${escapeHtml(t.name)}</span>
          ${installedBadge}
        </button>`;
      }).join('');
      detailEl.innerHTML = _pocRenderLibraryDetail(selected, { atLimit, installedCount });
      // 列表点击 → 切换选中详情
      listEl.querySelectorAll('.personal-onto-library-row').forEach((row) => {
        row.addEventListener('click', () => {
          _pocLibrarySelectedId = row.dataset.templateId || '';
          const next = all.find((t) => t.template_id === _pocLibrarySelectedId) || all[0];
          listEl.querySelectorAll('.personal-onto-library-row').forEach((r) => {
            r.classList.toggle('is-active', r.dataset.templateId === next.template_id);
          });
          detailEl.innerHTML = _pocRenderLibraryDetail(next, { atLimit, installedCount });
          _pocBindLibraryDetail(detailEl, { atLimit, installedCount });
        });
      });
    }
    // 详情内安装/卸载按钮绑定
    _pocBindLibraryDetail(detailEl, { atLimit, installedCount });
    const overlay = document.getElementById('personal-onto-template-library-modal');
    if (overlay) {
      if (overlay.style.display === 'none') _pocLibraryReturnFocus = document.activeElement || null;
      overlay.style.display = 'flex';
      overlay.setAttribute('aria-hidden', 'false');
      const closeBtn = document.getElementById('personal-onto-template-library-close');
      if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
    }
  }

  /** 右栏详情：单个模板的名字、描述、bundle、安装/卸载按钮。 */
  function _pocRenderLibraryDetail(t, { atLimit }) {
    const nSections = (t.sections || []).length;
    const nFields = (t.sections || []).reduce((n, s) => n + (s.fields || []).length, 0);
    const uninstallBtn = t.installed
      ? _iconButton({ label: _t('personalOntology.template_uninstall_tip', '卸载（数据归档保留）'), icon: 'x', variant: 'danger', className: 'personal-onto-library-uninstall', attrs: { 'data-template-id': t.template_id } })
      : '';
    const installBtn = t.installed
      ? `<span class="personal-onto-library-installed muted">${_t('personalOntology.template_installed_badge', '已安装')}</span>`
      : _button({ label: _t('memory.templates_install', '安装'), role: 'primary', size: 'sm', className: 'personal-onto-library-install', disabled: atLimit, attrs: { 'data-template-id': t.template_id } });
    return `<div class="personal-onto-library-detail-card${t.installed ? ' is-installed' : ''}" data-template-id="${escapeHtml(t.template_id)}">
      <div class="personal-onto-library-detail-head">
        <div>
          <div class="personal-onto-library-detail-name">${escapeHtml(t.name)}</div>
          <div class="personal-onto-library-card-meta">${nSections} ${_t('personalOntology.dest_role_sections', '分节')} · ${nFields} ${_t('personalOntology.dest_role_fields', '字段')}</div>
        </div>
        ${uninstallBtn}
      </div>
      ${t.description ? `<div class="personal-onto-library-card-desc">${escapeHtml(t.description)}</div>` : ''}
      ${_pocRenderBundle(t)}
      <div class="personal-onto-library-card-foot">
        ${installBtn}
        ${!t.installed && atLimit ? `<span class="personal-onto-library-limit muted">${_t('personalOntology.template_limit_hint', '已达 3 个上限，需先卸载一个')}</span>` : ''}
      </div>
    </div>`;
  }

  function _pocBindLibraryDetail(root, { atLimit }) {
    if (!root) return;
    root.querySelectorAll('.personal-onto-library-install').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.templateId;
        if (!tid || btn.disabled) return;
        await _pocRunOnce(`template-install:${tid}`, btn, async () => {
          await _pocInstallTemplate(tid);
          await _pocOpenTemplateLibrary(); // 刷新列表（上限置灰变化）
        });
      });
    });
    root.querySelectorAll('.personal-onto-library-uninstall').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.templateId;
        if (!tid) return;
        await _pocRunOnce(`template-uninstall:${tid}`, btn, async () => {
          await _pocUninstallTemplate(tid);
          await _pocOpenTemplateLibrary();
        });
      });
    });
  }

  function _pocCloseTemplateLibrary() {
    const overlay = document.getElementById('personal-onto-template-library-modal');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.setAttribute('aria-hidden', 'true');
    }
    const returnFocus = _pocLibraryReturnFocus;
    _pocLibraryReturnFocus = null;
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }

  // ── 左栏导航渲染 ─────────────────────────────────────────────────────────
  function _pocRenderNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;
    const installedTmpls = _pocTemplates.filter((t) => t.installed);
    const uninstalledCount = _pocTemplates.length - installedTmpls.length;
    const templateRows = installedTmpls.map((tmpl) => {
      const selected = _pocSelected.kind === 'template' && _pocSelected.id === tmpl.group_id;
      return `<div class="personal-onto-nav-template-row${selected ? ' is-active' : ''}">
        <button type="button" class="personal-onto-nav-row is-file${selected ? ' is-active' : ''}" data-poc-nav="template" data-poc-id="${escapeHtml(tmpl.group_id || '')}">
          <span class="personal-onto-nav-file-icon">${_icon('file-text', 'ui-icon')}</span>
          <span class="personal-onto-nav-row-text">${escapeHtml(tmpl.name)}</span>
          <span class="memory-template-name-suffix">${escapeHtml(_t('memory.templates_suffix', '模板'))}</span>
        </button>
        ${_iconButton({ label: _t('personalOntology.template_uninstall_tip', '卸载（数据归档保留）'), icon: 'x', variant: 'danger', className: 'personal-onto-template-uninstall', attrs: { 'data-poc-nav': 'template-uninstall', 'data-poc-template-id': tmpl.template_id } })}
      </div>`;
    }).join('');
    const profileSelected = _pocSelected.kind === 'profile';
    const profileCount = _pocProfile.entries.length;
    const groupRows = _pocGroups.list.map((g) => {
      const selected = _pocSelected.kind === 'group' && _pocSelected.id === g.group_id;
      return `<button type="button" class="personal-onto-nav-row is-file${selected ? ' is-active' : ''}" data-poc-nav="group" data-poc-id="${escapeHtml(g.group_id || '')}">
        <span class="personal-onto-nav-file-icon">${_icon('folder', 'ui-icon')}</span>
        <span class="personal-onto-nav-row-text">${escapeHtml(g.title || g.group_id)}</span>
      </button>`;
    }).join('');
    const groupsNav = `<div class="personal-onto-nav-section">
      <div class="personal-onto-nav-section-head">
        <span>${escapeHtml(_t('personalOntology.groups_title', '本体分组'))}</span>
        <span class="muted">${_pocGroups.list.length}${_pocPendingCandidates.length ? ` · <span class="personal-onto-backflow-badge">${escapeHtml(_tv('personalOntology.backflow_badge', { n: _pocPendingCandidates.length }, '回流 {n}'))}</span>` : ''}</span>
      </div>
      ${groupRows || `<div class="personal-onto-nav-empty muted">${escapeHtml(_t('personalOntology.groups_empty', '还没有分组'))}</div>`}
      ${_button({ label: `＋ ${_t('personalOntology.group_new', '新建分组')}`, size: 'sm', className: 'personal-onto-group-new-btn', attrs: { 'data-poc-nav': 'new-group' } })}
      <div class="personal-onto-group-io">
        ${_button({ label: _t('personalOntology.memory_export', '导出记忆'), size: 'sm', className: 'personal-onto-group-io-btn', attrs: { 'data-poc-nav': 'memory-export' } })}
        ${_button({ label: _t('personalOntology.memory_import', '导入记忆'), size: 'sm', className: 'personal-onto-group-io-btn', attrs: { 'data-poc-nav': 'memory-import' } })}
      </div>
    </div>`;
    const profileNav = `<div class="personal-onto-nav-section personal-onto-profile-nav-section">
      <div class="personal-onto-nav-section-head">
        <span>${escapeHtml(_t('personalOntology.profile_title', '个人画像'))}</span>
        <span class="muted">${escapeHtml(String(profileCount))}</span>
      </div>
      <button type="button" class="personal-onto-nav-row${profileSelected ? ' is-active' : ''}" data-poc-nav="profile" data-poc-id="user-profile">
        <span class="personal-onto-nav-file-icon">${_icon('user', 'ui-icon')}</span>
        <span class="personal-onto-nav-row-text">${escapeHtml(_t('personalOntology.profile_source', '会话沉淀'))}</span>
      </button>
    </div>
    ${groupsNav}
    <div class="personal-onto-nav-section">
      <div class="personal-onto-nav-section-head">
        <span>${escapeHtml(_t('personalOntology.nav_templates', '角色模板'))}</span>
        <span class="muted">${installedTmpls.length}</span>
      </div>
      ${templateRows
        ? `<div class="personal-onto-nav-template-list">${templateRows}</div>`
        : `<div class="personal-onto-nav-empty muted">${escapeHtml(_t('personalOntology.dest_no_roles', '尚未安装角色模板，可在「角色模板库」中安装'))}</div>`}
      <button type="button" class="personal-onto-template-library-btn" data-poc-nav="template-library">
        ${_icon('package', 'ui-icon personal-onto-template-library-icon')}
        <span>${_t('personalOntology.template_library', '角色模板库')}</span>
        <span class="personal-onto-template-library-count">${uninstalledCount}</span>
      </button>
    </div>`;
    nav.innerHTML = profileNav;
  }

  // ── 右栏渲染 ─────────────────────────────────────────────────────────────
  // ── 本体分组子页数据加载 ─────────────────────────────────────────────

  /** asof 超龄（与主进程 isStaleAsOf 同口径：月差 > 12 标「可能过时」）。 */
  function _pocIsStaleAsOf(asOf) {
    if (typeof asOf !== 'string') return false;
    const match = asOf.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/);
    if (!match) return false;
    const now = new Date();
    return (now.getFullYear() - Number(match[1])) * 12 + (now.getMonth() + 1 - Number(match[2])) > 12;
  }

  /** 普通分组列表（模板组归角色模板区管，这里只显示 template_id 缺席的）。 */
  async function _pocLoadGroups() {
    const res = await _pocInvoke('personalOntology.groups.list', {});
    if (!res || res.ok === false || !Array.isArray(res.groups)) {
      _pocGroups = { list: [], loaded: true, loadError: (res && res.error) || _t('personalOntology.load_error', '加载失败') };
      return false;
    }
    _pocGroups = {
      list: res.groups.filter((g) => g && g.group_id && !g.template_id),
      loaded: true,
      loadError: '',
    };
    return true;
  }

  /** 本体候选池（回流候选在这里确认）。 */
  async function _pocLoadPendingCandidates() {
    const res = await _pocInvoke('personalOntology.candidates.list', {});
    _pocCandidatesLoaded = true;
    _pocPendingCandidates = res && Array.isArray(res.candidates) ? res.candidates : [];
    return true;
  }

  /** 打开普通组详情：字段词汇 + 原文（流水区）+ 冲突台账 一次取齐。 */
  async function _pocOpenGroupDetail(groupId) {
    _pocGroupDetail = { groupId, title: '', fields: [], entries: [], conflicts: [], loaded: false, loadError: '' };
    _pocSelected = { kind: 'group', id: groupId };
    _pocGroupEditor = null;
    _pocRenderNav();
    _pocBindNav();
    _pocRenderMain();
    const meta = _pocGroups.list.find((g) => g.group_id === groupId);
    if (_pocGroupDetail) _pocGroupDetail.title = (meta && meta.title) || groupId;
    const [fieldsRes, contentRes, conflictsRes] = await Promise.all([
      _pocInvoke('personalOntology.groups.fields.list', { groupId }),
      _pocInvoke('personalOntology.groups.read', { groupId }),
      _pocInvoke('personalOntology.conflicts.list', { groupId }),
    ]);
    if (!_pocGroupDetail || _pocGroupDetail.groupId !== groupId) return; // 用户已切走
    const entries = (() => {
      try {
        const raw = String((contentRes && contentRes.content) || '');
        const flowZone = raw.split('## 流水区')[1] || '';
        return flowZone.split('§').map((s) => s.trim()).filter(Boolean);
      } catch { return []; }
    })();
    _pocGroupDetail = {
      groupId,
      title: (meta && meta.title) || groupId,
      fields: fieldsRes && Array.isArray(fieldsRes.fields) ? fieldsRes.fields : [],
      entries,
      conflicts: conflictsRes && Array.isArray(conflictsRes.conflicts) ? conflictsRes.conflicts : [],
      loaded: true,
      loadError: fieldsRes && fieldsRes.ok === false ? fieldsRes.error || '加载失败' : '',
    };
    _pocRenderMain();
  }

  /** 值行是否处在某条冲突记录里（按 字段+值 匹配）。 */
  function _pocConflictChipsFor(field, value) {
    const hits = (_pocGroupDetail && _pocGroupDetail.conflicts || [])
      .filter((c) => c && c.field === field && (c.value_a === value || c.value_b === value));
    if (!hits.length) return { conflicted: false, html: '' };
    return {
      conflicted: true,
      html: `<span class="ca-chip is-red">${escapeHtml(_t('personalOntology.conflict_chip', '与同字段另一条值矛盾'))}</span>`,
    };
  }

  /** 组详情右栏：结构化字段区 + 流水区（替代记忆页的大文本框编辑）。 */
  function _pocRenderGroupDetailView() {
    const d = _pocGroupDetail;
    if (!d) return '';
    if (!d.loaded) return `<div class="personal-onto-empty">${escapeHtml(_t('personalOntology.loading', '加载中...'))}</div>`;
    if (d.loadError) {
      return `<div class="personal-onto-profile-error" role="alert">
        <span>${escapeHtml(_t('personalOntology.profile_load_error', '个人画像加载失败'))}: ${escapeHtml(d.loadError)}</span>
      </div>`;
    }
    // 三盒分区（spec 007 Phase 1）：字段值含 → / -> 形状，或模板声明 isRelation
    // → 归「规则」区（R 盒，值形状驱动——Richard 文档同款原则）；其余归
    // 「事实」区（A 盒）；字段名与说明即词汇（T 盒），跟字段块走。
    const isRelationShape = (v) => /→|->/.test(String(v || ''));
    const relationFields = [];
    const factFields = [];
    for (const field of d.fields) {
      const byShape = (field.values || []).some((fv) => isRelationShape(fv.value));
      if (field.isRelation === true || byShape) relationFields.push(field);
      else factFields.push(field);
    }

    const fieldBlocks = d.fields.length ? d.fields.map((field) => {
      const valueRows = (field.values || []).length
        ? (field.values || []).map((fv) => {
        const conflict = _pocConflictChipsFor(field.name, fv.value);
        return `<div class="personal-onto-value-row${conflict.conflicted ? ' is-conflicted' : ''}">
          <span class="personal-onto-value-text">${escapeHtml(String(fv.value || ''))}</span>
          <span class="personal-onto-value-meta">
            <span class="muted">${escapeHtml(String(fv.source || '手动'))}</span>
            ${fv.project ? `<span class="muted">@${escapeHtml(String(fv.project))}</span>` : ''}
            ${fv.asOf ? `<span class="ca-chip">${escapeHtml(_tv('personalOntology.asof_chip', { m: fv.asOf }, '截至 {m}'))}</span>` : ''}
            ${fv.asOf && _pocIsStaleAsOf(fv.asOf) ? `<span class="ca-chip is-amber">${escapeHtml(_t('personalOntology.stale_chip', '可能过时'))}</span>` : ''}
            ${fv.verified ? `<span class="ca-chip is-green">${escapeHtml(_t('personalOntology.verified_chip', '已核实'))}</span>` : ''}
            ${conflict.html}
          </span>
          ${_iconButton({ label: fv.verified ? _t('personalOntology.unverify_tip', '取消核实') : _t('personalOntology.verify_tip', '标记为已核实'), icon: fv.verified ? 'x' : 'check', size: 'sm', className: 'personal-onto-value-verify', attrs: { 'data-poc-group-op': 'verify-value', 'data-poc-field': field.name, 'data-poc-value': String(fv.value || ''), 'data-poc-verified': fv.verified ? '0' : '1' } })}
          ${_iconButton({ label: _t('personalOntology.value_remove_tip', '删除这条值'), icon: 'trash-2', size: 'sm', className: 'personal-onto-value-remove', attrs: { 'data-poc-group-op': 'remove-value', 'data-poc-field': field.name, 'data-poc-value': String(fv.value || '') } })}
        </div>`;
      }).join('') : `<div class="muted personal-onto-value-empty">${escapeHtml(_t('personalOntology.field_no_values', '尚无值'))}</div>`;
      return `<div class="personal-onto-field-block">
        <div class="personal-onto-field-name">${escapeHtml(field.name)}${field.description ? ` <span class="personal-onto-field-desc muted">${escapeHtml(String(field.description))}</span>` : ''}</div>
        ${valueRows}
        ${_button({ label: `＋ ${_t('personalOntology.value_add', '添加值')}`, size: 'sm', className: 'personal-onto-value-add', attrs: { 'data-poc-group-op': 'append-value', 'data-poc-field': field.name } })}
      </div>`;
    }).join('') : `<div class="muted personal-onto-value-empty">${escapeHtml(_t('personalOntology.group_no_fields', '这个分组还没有字段。用下面的“记一笔”开始积累。'))}</div>`;

    // 按 zone 归属重排 fieldBlocks：fields.map 的产物与 d.fields 同序，这里
    // 按分类索引拆开重拼（不做二次渲染，保证值行事件属性不变）。
    const blockByField = new Map();
    if (d.fields.length) {
      const blocks = fieldBlocks.split(/(?=<div class="personal-onto-field-block")/g).filter((b) => b.includes('personal-onto-field-block'));
      d.fields.forEach((field, i) => { blockByField.set(field, blocks[i] || ''); });
    }
    const zone = (titleKey, titleFallback, fields) => fields.length
      ? `<div class="personal-onto-zone">
          <div class="personal-onto-zone-head">${escapeHtml(_t(titleKey, titleFallback))} <span class="muted">${fields.length}</span></div>
          ${fields.map((f) => blockByField.get(f)).join('')}
        </div>`
      : '';

    const flowRows = d.entries.length ? d.entries.map((entry) => `
      <div class="personal-onto-flow-row">${escapeHtml(entry)}</div>`).join('') : '';

    return `<section class="personal-onto-group-detail">
      ${_pocRenderBackflowCandidates()}
      <div class="personal-onto-group-detail-head">
        <span class="personal-onto-main-title">${escapeHtml(d.title)}</span>
        <span class="personal-onto-group-actions">
          ${_button({ label: _t('personalOntology.group_rename', '重命名'), size: 'sm', className: 'personal-onto-group-action', attrs: { 'data-poc-group-op': 'rename-group' } })}
          ${_button({ label: _t('personalOntology.group_delete', '删除分组'), size: 'sm', className: 'personal-onto-group-action is-danger', attrs: { 'data-poc-group-op': 'delete-group' } })}
        </span>
      </div>
      <div class="personal-onto-group-detail-sub muted">${escapeHtml(_t('personalOntology.group_fields_hint', '字段区：一条值一行，来源与时间直接可见'))}</div>
      <div class="personal-onto-field-zone">
        ${zone('personalOntology.zone_facts', '事实', factFields)}
        ${zone('personalOntology.zone_rules', '规则（写成 A → B）', relationFields)}
        ${!d.fields.length ? fieldBlocks : ''}
        ${_button({ label: _t('personalOntology.field_add', '＋ 新字段'), size: 'sm', className: 'personal-onto-value-add', attrs: { 'data-poc-group-op': 'add-field' } })}
      </div>
      ${flowRows ? `<div class="personal-onto-flow-zone">
        <div class="personal-onto-field-name">${escapeHtml(_t('personalOntology.flow_zone', '流水区'))}</div>
        ${flowRows}
      </div>` : ''}
      <div class="personal-onto-group-note-entry">
        ${_input({ id: 'personal-onto-note-input', placeholder: _t('personalOntology.note_placeholder', '记一笔（追加到流水区）'), className: 'personal-onto-note-input' })}
        ${_button({ label: _t('personalOntology.note_append', '追加'), size: 'sm', className: 'personal-onto-group-action', attrs: { 'data-poc-group-op': 'append-entry' } })}
      </div>
    </section>`;
  }

  /** 回流候选确认区（组详情顶部）：确认=写入本组（toGlobalMemory=false），
   *  消化=reject 移出池。回流内容源自资产，确认去向不该再进资产库。 */
  function _pocRenderBackflowCandidates() {
    if (!_pocPendingCandidates.length) return '';
    const rows = _pocPendingCandidates.map((c) => {
      const text = String((c && c.memory_text) || (c && c.summary) || '').trim();
      if (!text) return '';
      const id = String(c.candidate_id || '');
      return `<div class="personal-onto-backflow-row" data-poc-candidate-id="${escapeHtml(id)}">
        <span class="ca-chip">${escapeHtml(_t('personalOntology.backflow_chip', '回流候选'))}</span>
        <span class="personal-onto-backflow-text">${escapeHtml(text)}</span>
        <span class="personal-onto-backflow-actions">
          ${_button({ label: _t('personalOntology.backflow_confirm', '写入本组'), size: 'sm', className: 'personal-onto-group-action', attrs: { 'data-poc-candidate-op': 'confirm', 'data-poc-candidate-id': id } })}
          ${_button({ label: _t('personalOntology.backflow_reject', '不用了'), size: 'sm', className: 'personal-onto-group-action is-ghost', attrs: { 'data-poc-candidate-op': 'reject', 'data-poc-candidate-id': id } })}
        </span>
      </div>`;
    }).join('');
    return `<section class="personal-onto-backflow-zone" aria-label="${escapeHtml(_t('personalOntology.backflow_zone_title', '待确认回流'))}">
      <div class="personal-onto-field-name">${escapeHtml(_t('personalOntology.backflow_zone_title', '待确认回流'))} <span class="muted">${_pocPendingCandidates.length}</span></div>
      ${rows}
    </section>`;
  }

  // ── 本体分组子页操作（IPC 全部复用既有通道，后端零改动）──────────────

  function _pocBindGroupDetail(bodyEl) {
    if (!bodyEl) return;
    bodyEl.querySelectorAll('[data-poc-group-op]').forEach((el) => {
      el.addEventListener('click', async () => {
        const op = el.getAttribute('data-poc-group-op');
        const field = el.getAttribute('data-poc-field');
        const value = el.getAttribute('data-poc-value');
        if (op === 'append-value') await _pocAppendValuePrompt(field);
        else if (op === 'remove-value') await _pocRemoveValue(field, value);
        else if (op === 'verify-value') await _pocToggleValueVerified(el, field, value);
        else if (op === 'add-field') await _pocAddFieldPrompt();
        else if (op === 'rename-group') await _pocRenameGroupPrompt();
        else if (op === 'delete-group') await _pocDeleteGroupConfirm();
        else if (op === 'append-entry') await _pocAppendEntryNote();
      });
    });
    bodyEl.querySelectorAll('[data-poc-candidate-op]').forEach((el) => {
      el.addEventListener('click', async () => {
        const op = el.getAttribute('data-poc-candidate-op');
        const cid = el.getAttribute('data-poc-candidate-id');
        if (op === 'confirm') await _pocConfirmBackflow(cid, el);
        else if (op === 'reject') await _pocRejectBackflow(cid, el);
      });
    });
  }

  async function _pocCreateGroupPrompt() {
    const title = (typeof uiPrompt === 'function')
      ? await uiPrompt(_t('personalOntology.group_new_prompt', '分组名称'), '')
      : null;
    if (title === null) return;
    const trimmed = String(title || '').trim();
    if (!trimmed) return;
    const res = await _pocInvoke('personalOntology.groups.create', { title: trimmed });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
      return;
    }
    await _pocLoadGroups();
    await _pocOpenGroupDetail(res.group.group_id);
  }

  async function _pocRenameGroupPrompt() {
    if (!_pocGroupDetail) return;
    const title = (typeof uiPrompt === 'function')
      ? await uiPrompt(_t('personalOntology.group_new_prompt', '分组名称'), _pocGroupDetail.title)
      : null;
    if (title === null) return;
    const trimmed = String(title || '').trim();
    if (!trimmed) return;
    const res = await _pocInvoke('personalOntology.groups.rename', { groupId: _pocGroupDetail.groupId, title: trimmed });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
      return;
    }
    await _pocLoadGroups();
    _pocGroupDetail.title = trimmed;
    _pocRenderNav();
    _pocBindNav();
    _pocRenderMain();
  }

  async function _pocDeleteGroupConfirm() {
    if (!_pocGroupDetail) return;
    const ok = (typeof uiConfirmDanger === 'function')
      ? await uiConfirmDanger({
        title: _t('personalOntology.group_delete', '删除分组'),
        message: _t('personalOntology.group_delete_confirm', '删除后分组文件（含全部字段与流水）不可恢复。'),
        dangerLabel: _t('personalOntology.group_delete', '删除分组'),
      })
      : (typeof uiConfirm === 'function' ? await uiConfirm({ message: _t('personalOntology.group_delete_confirm', '删除后分组文件（含全部字段与流水）不可恢复。') }) : true);
    if (!ok) return;
    const groupId = _pocGroupDetail.groupId;
    const res = await _pocInvoke('personalOntology.groups.delete', { groupId });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
      return;
    }
    _pocGroupDetail = null;
    _pocSelected = { kind: 'profile', id: 'user-profile' };
    await _pocLoadGroups();
    renderPersonalOntology();
  }

  async function _pocAppendValuePrompt(fieldName) {
    if (!_pocGroupDetail) return;
    const value = (typeof uiPrompt === 'function')
      ? await uiPrompt(`${_t('personalOntology.value_add', '添加值')} · ${fieldName}`, '')
      : null;
    if (value === null) return;
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const res = await _pocInvoke('personalOntology.groups.fields.append', {
      groupId: _pocGroupDetail.groupId, fieldName, value: trimmed, source: '手动',
    });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
      return;
    }
    // 关系值形状提示（spec 007 T103）：A → B 形状的值保存即成规则，读取侧
    // ontology-rules 自动解析进世界模型——用户第一次有 R 盒的界面入口。
    if (/→|->/.test(trimmed)) {
      _pocToast('personalOntology.rule_saved', '已按规则保存（A → B）：将作为规则进入世界模型', 'success');
    }
    await _pocOpenGroupDetail(_pocGroupDetail.groupId);
  }

  async function _pocAddFieldPrompt() {
    if (!_pocGroupDetail) return;
    const fieldName = (typeof uiPrompt === 'function')
      ? await uiPrompt(_t('personalOntology.field_name_prompt', '字段名（如：居住地 / 就读状态）· 值可写 A → B 成为规则'), '')
      : null;
    if (fieldName === null) return;
    const trimmedName = String(fieldName || '').trim();
    if (!trimmedName) return;
    const value = (typeof uiPrompt === 'function')
      ? await uiPrompt(_t('personalOntology.value_add', '添加值'), '')
      : null;
    if (value === null) return;
    const trimmedValue = String(value || '').trim();
    if (!trimmedValue) return;
    const res = await _pocInvoke('personalOntology.groups.fields.append', {
      groupId: _pocGroupDetail.groupId, fieldName: trimmedName, value: trimmedValue, source: '手动',
    });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
      return;
    }
    await _pocOpenGroupDetail(_pocGroupDetail.groupId);
  }

  async function _pocRemoveValue(fieldName, value) {
    if (!_pocGroupDetail) return;
    const res = await _pocInvoke('personalOntology.groups.fields.removeValue', {
      groupId: _pocGroupDetail.groupId, fieldName, value,
    });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
      return;
    }
    // 矛盾台账自愈在下次读取发生；值删掉后红标随重开消失。
    await _pocOpenGroupDetail(_pocGroupDetail.groupId);
  }

  /** 核实档 toggle（2026-09-20 断言核实维度）：章只由用户这一下产生。 */
  async function _pocToggleValueVerified(el, fieldName, value) {
    if (!_pocGroupDetail) return;
    const nextVerified = el.getAttribute('data-poc-verified') === '1';
    await _pocRunOnce(`verify:${fieldName}:${value}`, el, async () => {
      const res = await _pocInvoke('personalOntology.groups.fields.verify', {
        groupId: _pocGroupDetail.groupId, fieldName, value, verified: nextVerified,
      });
      if (!res || res.ok === false) {
        _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
        return;
      }
      await _pocOpenGroupDetail(_pocGroupDetail.groupId);
    });
  }

  async function _pocAppendEntryNote() {
    if (!_pocGroupDetail) return;
    const input = document.getElementById('personal-onto-note-input');
    const text = input ? String(input.value || '').trim() : '';
    if (!text) return;
    const readRes = await _pocInvoke('personalOntology.groups.read', { groupId: _pocGroupDetail.groupId });
    const base = String((readRes && readRes.content) || '');
    const content = `${base.trimEnd()}\n§ ${text}\n`;
    const res = await _pocInvoke('personalOntology.groups.write', { groupId: _pocGroupDetail.groupId, content });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
      return;
    }
    await _pocOpenGroupDetail(_pocGroupDetail.groupId);
  }

  async function _pocConfirmBackflow(candidateId, el) {
    if (!_pocGroupDetail) return;
    await _pocRunOnce(`backflow-confirm:${candidateId}`, el, async () => {
      const res = await _pocInvoke('personalOntology.candidates.confirm', {
        candidateId,
        dest: { toGlobalMemory: false, toGroupIds: [_pocGroupDetail.groupId] },
      });
      if (!res || res.ok === false) {
        _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
        return;
      }
      _pocToast('personalOntology.backflow_confirmed', '已写入本组（流水区，可升格为字段值）', 'success');
      await _pocLoadPendingCandidates();
      await _pocOpenGroupDetail(_pocGroupDetail.groupId);
      _pocRenderNav();
      _pocBindNav();
    });
  }

  async function _pocRejectBackflow(candidateId, el) {
    await _pocRunOnce(`backflow-reject:${candidateId}`, el, async () => {
      const res = await _pocInvoke('personalOntology.candidates.reject', { candidateId });
      if (!res || res.ok === false) {
        _pocToast('personalOntology.op_failed', (res && res.error) || '操作失败', 'error');
        return;
      }
      await _pocLoadPendingCandidates();
      _pocRenderNav();
      _pocBindNav();
      _pocRenderMain();
    });
  }

  function _pocRenderMain() {
    const headerEl = document.getElementById('personal-onto-main-header');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!headerEl || !bodyEl) return;

    if (_pocSelected.kind === 'profile') {
      headerEl.innerHTML = '';
      headerEl.classList.add('is-profile');
      bodyEl.innerHTML = _pocRenderProfileView();
      return;
    }
    if (_pocSelected.kind === 'group') {
      headerEl.classList.remove('is-profile');
      headerEl.innerHTML = '';
      bodyEl.innerHTML = _pocRenderGroupDetailView();
      _pocBindGroupDetail(bodyEl);
      return;
    }
    headerEl.classList.remove('is-profile');
    if (_pocSelected.kind === 'template' && _pocGroupEditor) {
      headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_pocGroupEditor.title || _t('personalOntology.nav_templates', '角色模板'))}</span>`;
      bodyEl.innerHTML = _pocRenderGroupEditorHtml();
      _pocBindGroupEditor(bodyEl);
      return;
    }
    headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_templates', '角色模板'))}</span>`;
    bodyEl.innerHTML = `<div class="personal-onto-empty personal-onto-template-empty">${_emptyState({
      kind: 'actionable',
      title: _t('personalOntology.dest_no_roles', '尚未安装角色模板，可在「角色模板库」中安装'),
      icon: 'package',
      action: { label: _t('personalOntology.template_library', '角色模板库'), icon: 'package', size: 'sm', attrs: { id: 'personal-onto-empty-open-library' } },
    })}</div>`;
    const emptyOpen = document.getElementById('personal-onto-empty-open-library');
    if (emptyOpen) emptyOpen.addEventListener('click', () => _pocOpenTemplateLibrary());
  }

  function _pocRenderTemplatesLoadError() {
    const nav = document.getElementById('personal-onto-nav');
    const headerEl = document.getElementById('personal-onto-main-header');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!nav || !headerEl || !bodyEl) return;
    const error = escapeHtml(_pocTemplatesLoadError || _t('personalOntology.load_error', '加载失败'));
    headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_templates', '角色模板'))}</span>`;
    nav.innerHTML = `<div class="personal-onto-nav-empty personal-onto-load-error" role="alert">${error}</div>`;
    bodyEl.innerHTML = `<div class="personal-onto-empty personal-onto-load-error" role="alert">${_emptyState({
      kind: 'actionable',
      title: `${_t('personalOntology.load_error', '加载失败')}: ${_pocTemplatesLoadError || _t('personalOntology.load_error', '加载失败')}`,
      icon: 'warning',
      action: { label: _t('personalOntology.retry', '重试'), size: 'sm', attrs: { id: 'personal-onto-load-retry' } },
    })}</div>`;
    const retry = document.getElementById('personal-onto-load-retry');
    if (retry) {
      retry.addEventListener('click', async () => {
        await _pocRunOnce('templates-load', retry, async () => {
          _pocTemplatesLoaded = false;
          _pocTemplatesLoadError = '';
          await renderPersonalOntology();
        });
      });
    }
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────
  function _pocBindNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;
    nav.querySelectorAll('[data-poc-nav]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const action = el.getAttribute('data-poc-nav');
        const id = el.getAttribute('data-poc-id');
        if (action === 'profile') {
          _pocSelected = { kind: 'profile', id: 'user-profile' };
          _pocGroupEditor = null;
          _pocGroupDetail = null;
          renderPersonalOntology();
        } else if (action === 'group') { _pocOpenGroupDetail(id); }
        else if (action === 'new-group') {
          e.stopPropagation();
          _pocCreateGroupPrompt();
        }
        else if (action === 'memory-export' || action === 'memory-import') {
          e.stopPropagation();
          // 记忆页退役（2026-09-20）：导出/导入功能保留，工具实现在 memory.js
          // （_memOpenExport/_memOpenImport），经 window.MemoryTools 暴露复用。
          const tools = window.MemoryTools || {};
          const fn = action === 'memory-export' ? tools.openExport : tools.openImport;
          if (typeof fn === 'function') fn();
          else _pocToast('personalOntology.op_failed', _t('personalOntology.io_unavailable', '导出/导入工具未就绪'), 'error');
        }
        else if (action === 'template') { _pocOpenGroup(id); }
        else if (action === 'template-library') {
          e.stopPropagation();
          _pocOpenTemplateLibrary();
        }
        else if (action === 'template-uninstall') {
          e.stopPropagation();
          const tid = el.getAttribute('data-poc-template-id');
          if (tid) await _pocRunOnce(`template-uninstall:${tid}`, el, () => _pocUninstallTemplate(tid));
        }
      });
    });
    // 角色模板库弹窗：关闭/遮罩点击 —— 持久节点，只绑一次（防监听器累积）
    const libOverlay = document.getElementById('personal-onto-template-library-modal');
    if (libOverlay && !_pocLibraryModalBound) {
      _pocLibraryModalBound = true;
      libOverlay.addEventListener('click', (e) => {
        if (e.target === libOverlay) _pocCloseTemplateLibrary();
      });
      const closeBtn = document.getElementById('personal-onto-template-library-close');
      if (closeBtn) closeBtn.addEventListener('click', () => _pocCloseTemplateLibrary());
      const cancelBtn = document.getElementById('personal-onto-template-library-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', () => _pocCloseTemplateLibrary());
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && libOverlay.style.display !== 'none') _pocCloseTemplateLibrary();
        });
      }
    }
    // 安装/卸载按钮绑定在 _pocOpenTemplateLibrary 内部完成（每次 innerHTML 重写后重新绑定）
  }

  function _pocBindGroupEditor(root) {
    root.querySelectorAll('[data-poc-group-action]').forEach((el) => {
      el.addEventListener('click', async () => {
        const action = el.getAttribute('data-poc-group-action');
        const ed = _pocGroupEditor;
        if (!ed) return;
        // 模板分节操作使用复合 id（data-poc-ref），原文操作使用模板 group id。
        const groupId = el.getAttribute('data-poc-ref') || ed.groupId;
        const run = async () => {
          if (action === 'view-form' || action === 'view-raw') {
            ed.view = action.slice('view-'.length);
            renderPersonalOntology();
            return;
          }
          if (action === 'reload-group') {
            await _pocOpenGroup(ed.groupId);
            return;
          }
          if (action === 'save-content') {
            const ta = root.querySelector('[data-poc-group-content]');
            if (!ta) return;
            if (await _pocGroupAction('personalOntology.groups.write', { groupId, content: ta.value })) {
              _pocToast('memory.groups_saved', '已保存');
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
              _pocToast('personalOntology.field_value_added', '已添加');
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
              _pocToast('personalOntology.field_value_updated', '已更新');
              await _pocRefreshGroupData();
            }
            return;
          }
          if (action === 'field-remove-value') {
            const fieldName = el.getAttribute('data-poc-field');
            const value = el.getAttribute('data-poc-value');
            const ok = (typeof uiConfirm === 'function')
              ? await uiConfirm({ message: _tv('personalOntology.field_value_delete_confirm', { value }, '删除字段值「{value}」？') })
              : true;
            if (!ok) return;
            if (await _pocGroupAction('personalOntology.groups.fields.removeValue', { groupId, fieldName, value })) {
              _pocToast('personalOntology.field_value_removed', '已删除');
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
              if (res.isCustom) {
                _pocToast('memory.group_promote_custom_done', `已创建自定义字段「${trimmed}」（不在模板字段清单内）`, 'info', { name: trimmed });
              } else {
                _pocToast('personalOntology.field_value_added', '已添加');
              }
              await _pocRefreshGroupData();
            } else {
              _notifyFail(_t('personalOntology.op_failed', '操作失败'), new Error((res && res.error) || ''));
            }
            return;
          }
          if (action === 'entry-remove') {
            const entryText = el.getAttribute('data-poc-entry');
            const ok = (typeof uiConfirm === 'function') ? await uiConfirm({ message: _t('memory.group_entry_delete_confirm', '删除这条流水？') }) : true;
            if (!ok) return;
            if (await _pocGroupAction('personalOntology.groups.entries.remove', { groupId, entryText })) {
              _pocToast('personalOntology.field_value_removed', '已删除');
              await _pocRefreshGroupData();
            }
          }
        };
        if (action === 'view-form' || action === 'view-raw') {
          await run();
          return;
        }
        const item = el.getAttribute('data-poc-field') || el.getAttribute('data-poc-entry') || el.getAttribute('data-poc-value') || '';
        await _pocRunOnce(`group-action:${action}:${groupId}:${item}`, el, run);
      });
    });
    root.querySelectorAll('.memory-group-field-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229 || e.key !== 'Enter') return;
        e.preventDefault();
        const fieldName = input.getAttribute('data-poc-field');
        const ref = input.getAttribute('data-poc-ref');
        const saveBtn = root.querySelector(`button[data-poc-group-action="field-add-value"][data-poc-field="${CSS.escape(fieldName)}"][data-poc-ref="${CSS.escape(ref)}"]`);
        if (saveBtn && !saveBtn.disabled) saveBtn.click();
      });
    });
  }

  // ── 主渲染 ───────────────────────────────────────────────────────────────
  async function renderPersonalOntology() {
    const nav = document.getElementById('personal-onto-nav');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!nav || !bodyEl) {
      console.error('[personal-ontology] missing DOM elements');
      return;
    }

    if (!_pocTemplatesLoaded || !_pocProfile.loaded || !_pocGroups.loaded || !_pocCandidatesLoaded) {
      nav.innerHTML = '<div class="personal-onto-nav-empty muted">' + _t('personalOntology.loading', '加载中...') + '</div>';
      bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.loading', '加载中...') + '</div>';
      await Promise.all([
        _pocLoadTemplates(),
        _pocLoadProfile(),
        _pocGroups.loaded ? Promise.resolve() : _pocLoadGroups(),
        _pocCandidatesLoaded ? Promise.resolve() : _pocLoadPendingCandidates(),
      ]);
    }

    if (_pocTemplatesLoadError) {
      _pocRenderTemplatesLoadError();
      return;
    }

    try {
      const installed = _pocTemplates.filter((t) => t.installed && t.group_id);
      // 本体分组子页（2026-09-20 迁入）：group 视图先于画像/模板链——
      // _pocOpenGroupDetail 已渲染，这里只负责刷新 nav 状态。
      if (_pocSelected.kind === 'group' && _pocGroupDetail && _pocGroupDetail.groupId === _pocSelected.id) {
        _pocRenderNav();
        _pocBindNav();
        if (_pocGroupDetail.loaded) _pocRenderMain();
        return;
      }
      if (_pocSelected.kind === 'group') {
        const exists = _pocGroups.list.some((g) => g.group_id === _pocSelected.id);
        if (exists) {
          await _pocOpenGroupDetail(_pocSelected.id);
          return;
        }
        _pocSelected = { kind: 'profile', id: 'user-profile' };
      }
      // 「关于我」首先回答用户画像是什么。即使当前还没有沉淀内容，也应保留
      // 画像空状态，不能因为安装了角色模板就自动跳到模板编辑器；否则会话沉淀
      // 入口和数据来源都被模板盖住。只有画像本身读取失败时才降级到可用模板。
      if (_pocSelected.kind === 'profile' && (!_pocProfile.loadError || !installed.length)) {
        _pocGroupEditor = null;
        _pocRenderNav();
        _pocBindNav();
        _pocRenderMain();
        return;
      }
      let selected = installed.find((t) => t.group_id === _pocSelected.id);
      if (!selected && installed.length) {
        selected = installed[0];
        _pocSelected = { kind: 'template', id: selected.group_id };
        _pocGroupEditor = null;
      }
      if (!selected) {
        _pocSelected = { kind: 'template', id: null };
        _pocGroupEditor = null;
      } else if (!_pocGroupEditor || _pocGroupEditor.groupId !== selected.group_id) {
        _pocOpenGroup(selected.group_id);
        return;
      }

      _pocRenderNav();
      _pocBindNav();
      _pocRenderMain();
    } catch (err) {
      console.error('[personal-ontology] render failed', err);
      bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.load_error', '加载失败') + ': ' + escapeHtml((err && err.message) || String(err)) + '</div>';
    }
  }

  function refreshPersonalOntology(options = {}) {
    if (options && options.selectProfile) {
      _pocSelected = { kind: 'profile', id: 'user-profile' };
    }
    _pocTemplatesLoaded = false;
    _pocTemplatesLoadError = '';
    _pocProfile = { entries: [], loaded: false, loadError: '' };
    _pocGroupEditor = null;
    // 分组与候选池一并重读（2026-09-20 分组迁入）：否则外部造组（如脚本/
    // 其他入口）后刷新不重读列表，nav 永远显示旧集合。
    _pocGroups = { list: [], loaded: false, loadError: '' };
    _pocCandidatesLoaded = false;
    _pocGroupDetail = null;
    return renderPersonalOntology();
  }

  async function _pocRefreshForLanguage() {
    const nav = document.getElementById('personal-onto-nav');
    const body = document.getElementById('personal-onto-main-body');
    if (!nav || !body) return;
    const activeBefore = document.activeElement;
    const activeField = activeBefore?.getAttribute?.('data-poc-field') || '';
    const activeRef = activeBefore?.getAttribute?.('data-poc-ref') || '';
    const activeRaw = activeBefore?.hasAttribute?.('data-poc-group-content');
    const selectionStart = activeBefore?.selectionStart ?? 0;
    const selectionEnd = activeBefore?.selectionEnd ?? 0;
    const fieldValues = Array.from(body.querySelectorAll('.memory-group-field-input')).map((input) => ({
      field: input.getAttribute('data-poc-field') || '',
      ref: input.getAttribute('data-poc-ref') || '',
      value: input.value,
    }));
    const rawValue = body.querySelector('[data-poc-group-content]')?.value;
    const navScrollTop = nav.scrollTop;
    const bodyScrollTop = body.scrollTop;
    const libraryModal = document.getElementById('personal-onto-template-library-modal');
    const libraryWasOpen = !!libraryModal && libraryModal.style.display !== 'none';

    await renderPersonalOntology();
    for (const item of fieldValues) {
      const input = body.querySelector(`.memory-group-field-input[data-poc-field="${CSS.escape(item.field)}"][data-poc-ref="${CSS.escape(item.ref)}"]`);
      if (input) input.value = item.value;
    }
    const raw = body.querySelector('[data-poc-group-content]');
    if (raw && rawValue != null) raw.value = rawValue;
    nav.scrollTop = navScrollTop;
    body.scrollTop = bodyScrollTop;
    if (libraryWasOpen) await _pocOpenTemplateLibrary();

    let nextActive = null;
    if (activeRaw) nextActive = body.querySelector('[data-poc-group-content]');
    else if (activeField || activeRef) {
      nextActive = body.querySelector(`.memory-group-field-input[data-poc-field="${CSS.escape(activeField)}"][data-poc-ref="${CSS.escape(activeRef)}"]`);
    }
    if (nextActive) {
      nextActive.focus();
      nextActive.setSelectionRange?.(selectionStart, selectionEnd);
    }
  }

  window.renderPersonalOntology = renderPersonalOntology;
  window.refreshPersonalOntology = refreshPersonalOntology;
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('i18n-change', () => { void _pocRefreshForLanguage(); });
  }
})();
