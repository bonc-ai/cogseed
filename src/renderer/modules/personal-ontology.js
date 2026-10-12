// 个人本体工作区 — classic script (window.renderPersonalOntology)
// 嵌入“认知资产 -> 本体”：总览路由下包含个人与事项浏览，个人区保留模板字段与原文。
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

  function _pocOperationErrorText(error) {
    if (error === 'asset_projection_read_only') {
      return _t('personalOntology.asset_projection_read_only_error', '这条内容由正式认知资产维护，请从来源资产中修改或停用。');
    }
    if (error === 'template_metadata_read_only') {
      return _t('personalOntology.template_metadata_read_only_error', '模板标识和版本信息由系统维护；请只编辑分节与字段内容。');
    }
    if (error === 'template_section_required') {
      return _t('personalOntology.template_section_required_error', '模板值操作需要明确的分节。');
    }
    return error || _t('personalOntology.op_failed', '操作失败');
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

  /** 非交互元数据标记（US-102 T023；US-105 T040 收敛）：统一走共享 uiTag
   *  （ui-status.js，index.html 全局加载）；中性缺省 solid，语义成功用 success。 */
  function _tag(label, variant) {
    const text = String(label == null ? '' : label);
    if (!text) return '';
    if (typeof window.uiTag !== 'function') throw new Error('personal ontology requires uiTag');
    return window.uiTag({ label: text, variant: variant || undefined });
  }

  /** 状态胶囊（US-105 T040）：琥珀=需要注意（可能过时/受限），红=矛盾。
   *  与中性 _tag 分流——警示语义走共享 uiStatusPill，仍可辨。 */
  function _statusPill(label, tone) {
    const text = String(label == null ? '' : label);
    if (!text) return '';
    if (typeof window.uiStatusPill !== 'function') throw new Error('personal ontology requires uiStatusPill');
    return window.uiStatusPill({ label: text, tone: tone || 'neutral' });
  }

  /** 状态点（US-105 T041）：值行唯一可见的状态指示，共享 uiStatusDot（无文字纯色点）。 */
  function _statusDot(tone) {
    if (!tone) return '';
    if (typeof window.uiStatusDot !== 'function') throw new Error('personal ontology requires uiStatusDot');
    return window.uiStatusDot({ tone });
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
  /** 三盒数据（盒子化重构）：A/R/T 盒共用一次加载——资产 + 全组字段与
   *  流水 + 全量冲突台账。groups: [{gid,title,fields,entries}]。 */
  let _pocBoxData = {
    loaded: false, loadError: '', groups: [], assets: [], sourceAssets: [], conflicts: [],
    graph: { loaded: false, loadError: '', categories: [], entities: [], relations: [] },
  };
  /** R 盒分类筛选：'all' | 'operation' | 'preference' | 'constraint' */
  let _pocTriBoxRuleFilter = 'all';
  /** 本体工作区首层：总览、个人本体、事项本体、显式关系。 */
  let _pocView = 'personal';
  let _pocTaxonomyDomain = 'affairs';
  let _pocDomainCategoryFilter = 'all';
  /** 值行展开状态：`gid\x00field\x00value` 集合（点击行 toggle）。 */
  const _pocExpandedValues = new Set();
  // 导航就是三个盒子（词汇 T / 事实 A / 规则 R）；模板编辑器是 T 盒的下钻。
  let _pocSelected = { kind: 'facts', id: 'facts' };
  // 模板文件编辑器 { groupId, templateId, sections, content, view:'form'|'raw' }
  let _pocGroupEditor = null;
  /** D5b（spec 009 T027）：「已删除分组」折叠块。懒加载——首次展开才拉
   *  deleted.list（IPC 纪律 contracts/ipc.md §5.4：不给每次渲染加调用）。 */
  let _pocDeletedGroups = { open: false, loaded: false, loadError: '', list: [] };
  /** po.snapshot（2026-09-29 v2 重构）：一次快照拿全分组/字段/值/流水/回收站。 */
  let _pocPo = { snapshot: null, loaded: false, loadError: '' };
  /** 事实页筛选：分组下拉 + 搜索词。 */
  let _pocFactsFilter = { group: 'all', q: '' };
  /** 规则页分类筛选：'all'|'operation'|'preference'|'constraint'|'none'。 */
  let _pocRuleFilter = 'all';

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
      title: '我在哪些项目与关系里',
      descriptionKey: 'personalOntology.ontology_environment_hint',
      description: '和你协作的人、项目与使用环境',
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
          assetId: String(asset.id || ''),
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
                  <span class="memory-group-field-source muted">${escapeHtml(v.recallAssetId
                    ? _t('personalOntology.asset_projection_origin', '由正式认知资产维护')
                    : _tv('memory.group_field_value_source', { value: '', source: v.source }))}</span>
                  ${v.project ? `<span class="memory-group-field-project">@${escapeHtml(_pocProjectNames ? (_pocProjectNames.get(v.project) || v.project) : v.project)}</span>` : ''}
                  ${v.recallAssetId
                    ? _button({ label: _t('personalOntology.asset_projection_open', '查看来源资产'), size: 'sm', attrs: { 'data-poc-group-action': 'open-formal-asset', 'data-poc-asset-id': v.recallAssetId } })
                    : `${_iconButton({ label: _t('memory.edit', '编辑'), icon: 'edit-pencil', className: 'memory-icon-btn', attrs: { 'data-poc-group-action': 'field-edit-value', 'data-poc-ref': ref, 'data-poc-field': f.name, 'data-poc-value': v.value } })}
                       ${_iconButton({ label: _t('memory.delete', '删除'), icon: 'x', variant: 'danger', className: 'memory-icon-btn is-muted', attrs: { 'data-poc-group-action': 'field-remove-value', 'data-poc-ref': ref, 'data-poc-field': f.name, 'data-poc-value': v.value } })}`}
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
    return `<section class="personal-onto-template-profile-bridge" aria-label="${escapeHtml(_t('personalOntology.template_profile_bridge_title', '已确认但未匹配到模板的信息'))}">
      <div class="personal-onto-template-profile-bridge-head">
        <div>
          <div class="personal-onto-template-profile-bridge-title">${escapeHtml(_t('personalOntology.template_profile_bridge_title', '已确认但未匹配到模板的信息'))}</div>
          <div class="personal-onto-template-profile-bridge-hint">${escapeHtml(_t('personalOntology.template_profile_bridge_hint', '这些信息已确认，但暂未匹配到当前角色模板字段；不会自动填入错误字段。'))}</div>
        </div>
        <span class="personal-onto-template-profile-bridge-count">${escapeHtml(String(pending.length))}</span>
      </div>
      <div class="personal-onto-template-profile-bridge-list">
        ${pending.map((entry) => `<div class="personal-onto-template-profile-bridge-entry">
          <span class="personal-onto-profile-entry-icon">${_icon('file-text', 'ui-icon')}</span>
          <span>${_pocProfileEntryHtml(entry)}</span>
          ${entry.assetId ? _button({ label: _t('personalOntology.asset_projection_open', '查看来源资产'), size: 'sm', attrs: { 'data-poc-group-action': 'open-formal-asset', 'data-poc-asset-id': entry.assetId } }) : ''}
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
    _pocView = 'personal';
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
      _notifyFail(_t('personalOntology.op_failed', '操作失败'), new Error(_pocOperationErrorText((res && res.error) || '')));
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
  /** 三个盒子的数量口径（nav 角标与主区页头共用，2026-09-21 抽出）。 */
  function _pocAffairAssets() {
    return (_pocBoxData.assets || []).filter((asset) => asset && asset.type === 'fact');
  }

  function _pocTextSnippet(value, limit = 320) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
  }

  function _pocOntologyGraph() {
    return _pocBoxData.graph || { loaded: false, loadError: '', categories: [], entities: [], relations: [] };
  }

  function _pocGraphCategories(domain) {
    return (_pocOntologyGraph().categories || []).filter((category) => category && category.domain === domain);
  }

  function _pocGraphEntities(domain) {
    return (_pocOntologyGraph().entities || []).filter((entity) => entity && (!domain || entity.domain === domain));
  }

  function _pocGraphCategoryLabel(category) {
    if (!category) return _t('ontologyGraph.category_unavailable', '分类不可用');
    return category.nameKey ? _t(category.nameKey, category.name) : String(category.name || '');
  }

  function _pocGraphFieldLabel(field) {
    return field && field.nameKey ? _t(field.nameKey, field.name) : String((field && field.name) || '');
  }

  function _pocGraphDomainLabel(domain) {
    const key = domain === 'affairs' ? 'ontologyGraph.domain_affairs'
      : domain === 'resources' ? 'ontologyGraph.domain_resources'
        : domain === 'concepts' ? 'ontologyGraph.domain_concepts' : 'ontologyGraph.domain_personal';
    const fallback = domain === 'affairs' ? '事项本体'
      : domain === 'resources' ? '对象与资源'
        : domain === 'concepts' ? '概念本体' : '个人本体';
    return _t(key, fallback);
  }

  function _pocGraphEntityLabel(entity) {
    if (!entity) return _t('ontologyGraph.entity_unavailable', '实体当前不可见');
    return String(entity.name || '');
  }

  function _pocGraphSourceLabel(sourceRef) {
    if (!sourceRef) return '';
    const id = String(sourceRef.id || '');
    if (sourceRef.kind === 'asset') {
      const asset = (_pocBoxData.sourceAssets || _pocBoxData.assets || []).find((item) => String(item.id || '') === id);
      return asset
        ? _pocTextSnippet(asset.title || asset.statement, 120) || _t('ontologyGraph.source_asset', '正式认知资产')
        : _t('ontologyGraph.source_asset_unavailable', '正式认知资产（来源当前不可见）');
    }
    const candidate = (_pocPendingCandidates || []).find((item) => String(item.candidate_id || item.id || '') === id);
    return candidate
      ? _pocTextSnippet(candidate.summary, 120) || _t('ontologyGraph.source_candidate', '审核候选')
      : _t('ontologyGraph.source_candidate_unavailable', '审核候选（来源当前不可见）');
  }

  function _pocRenderGraphSourceRefs(sourceRefs) {
    const refs = Array.isArray(sourceRefs) ? sourceRefs : [];
    if (!refs.length) return '';
    return `<div class="personal-onto-graph-sources">
      <span class="muted">${escapeHtml(_t('ontologyGraph.source_refs', '来源引用'))}：</span>
      ${refs.map((sourceRef) => {
        const kind = sourceRef.kind === 'asset' ? _t('ontologyGraph.source_asset_kind', '认知资产') : _t('ontologyGraph.source_candidate_kind', '审核候选');
        const label = _pocGraphSourceLabel(sourceRef);
        const openAttrs = sourceRef.kind === 'asset'
          ? { 'data-poc-open-asset': String(sourceRef.id || '') }
          : { 'data-poc-open-candidate': String(sourceRef.id || '') };
        const openLabel = sourceRef.kind === 'asset'
          ? _t('ontologyGraph.source_open_asset', '打开来源资产')
          : _t('ontologyGraph.source_open_candidate', '打开来源候选');
        return `<span class="personal-onto-graph-source-ref">${_tag(kind)}<span>${escapeHtml(label)}</span>${_button({ label: openLabel, size: 'sm', className: 'o', attrs: openAttrs })}</span>`;
      }).join('')}
    </div>`;
  }

  function _pocRelationRows() {
    const rows = [];
    const relationKinds = {
      refines: ['personalOntology.relationship_kind_refines', '细化'],
      depends_on: ['personalOntology.relationship_kind_depends_on', '依赖'],
      replaces: ['personalOntology.relationship_kind_replaces', '替代'],
      conflicts_with: ['personalOntology.relationship_kind_conflicts_with', '存在冲突'],
      related_to: ['personalOntology.relationship_kind_related_to', '相关'],
      same_family: ['personalOntology.relationship_kind_same_family', '同来源'],
    };
    const activeAssets = _pocBoxData.assets || [];
    const assetsById = new Map(activeAssets.map((asset) => [String(asset.id || ''), asset]));

    (_pocBoxData.groups || []).forEach((group) => {
      (group.fields || []).forEach((field) => {
        (field.values || []).forEach((fieldValue) => {
          const value = String((fieldValue && fieldValue.value) || '').trim();
          const match = value.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
          if (!match) return;
          rows.push({
            from: match[1].trim(),
            predicate: String(field.name || '').trim() || _t('personalOntology.relationship_default', '关联'),
            to: match[2].trim(),
            source: String(group.title || ''),
            sourceKind: 'ontology',
          });
        });
      });
    });

    activeAssets.forEach((asset) => {
      (Array.isArray(asset.relations) ? asset.relations : []).forEach((relation) => {
        if (!relation || !relation.assetId) return;
        const target = assetsById.get(String(relation.assetId));
        // same_family is stored in both directions. Show each group once in
        // the relationship list so one source pair does not look like two
        // independent business relationships.
        if (relation.kind === 'same_family' && target
            && String(asset.id || '').localeCompare(String(target.id || '')) > 0) return;
        const kind = relationKinds[String(relation.kind || '')];
        const from = _pocTextSnippet(asset.title || asset.statement, 180);
        const to = target
          ? _pocTextSnippet(target.title || target.statement, 180)
          : _t('personalOntology.relationship_target_unavailable', '关联条目当前不可见');
        if (!from || !to) return;
        rows.push({
          from,
          predicate: kind ? _t(kind[0], kind[1]) : _t('personalOntology.relationship_default', '关联'),
          to,
          source: _t('personalOntology.relationship_source_assets', '正式认知资产'),
          sourceKind: 'asset',
          relationKind: String(relation.kind || ''),
          assetId: String(asset.id || ''),
          targetAssetId: target ? String(target.id || '') : '',
          note: String(relation.note || ''),
        });
      });
    });

    const graph = _pocOntologyGraph();
    const entitiesById = new Map((graph.entities || []).map((entity) => [String(entity.id || ''), entity]));
    const endpointLabel = (endpoint) => endpoint && endpoint.kind === 'self'
      ? _t('ontologyGraph.self_entity', '我')
      : _pocGraphEntityLabel(endpoint && entitiesById.get(String(endpoint.id || '')));
    (graph.relations || []).forEach((relation) => {
      rows.push({
        from: endpointLabel(relation.subject),
        predicate: String(relation.predicate || ''),
        to: endpointLabel(relation.object),
        source: _t('ontologyGraph.source_graph', '本体图谱'),
        sourceKind: 'graph',
        relationId: String(relation.id || ''),
        note: String(relation.note || ''),
        sourceRefs: Array.isArray(relation.sourceRefs) ? relation.sourceRefs : [],
      });
    });
    return rows;
  }

  function _pocNavigate(action) {
    if (_pocSelected.kind === 'template') _pocSelected = { kind: 'facts', id: 'facts' };
    if (action === 'ontology-home') {
      _pocView = 'overview';
      _pocGroupEditor = null;
    } else if (action === 'personal-domain') {
      _pocView = 'personal';
      _pocSelected = { kind: 'facts', id: 'facts' };
      _pocGroupEditor = null;
    } else if (action === 'affairs-domain') {
      _pocView = 'affairs';
      _pocGroupEditor = null;
      _pocDomainCategoryFilter = 'all';
    } else if (action === 'resources-domain') {
      _pocView = 'resources';
      _pocGroupEditor = null;
      _pocDomainCategoryFilter = 'all';
    } else if (action === 'concepts-domain') {
      _pocView = 'concepts';
      _pocGroupEditor = null;
      _pocDomainCategoryFilter = 'all';
    } else if (action === 'taxonomy-domain') {
      _pocView = 'taxonomy';
      _pocGroupEditor = null;
    } else if (action === 'relationships-domain') {
      _pocView = 'relationships';
      _pocGroupEditor = null;
    } else if (action === 'facts' || action === 'rules' || action === 'groups') {
      _pocView = 'personal';
      _pocSelected = { kind: action, id: action };
      _pocGroupEditor = null;
    }
    renderPersonalOntology();
  }

  function _pocNavButton(action, titleKey, fallback, icon, active) {
    return _button({
      label: _t(titleKey, fallback),
      icon,
      size: 'sm',
      className: `personal-onto-hub-nav-item${active ? ' is-active' : ''}`,
      attrs: {
        'data-poc-nav': action,
        ...(active ? { 'aria-current': 'page' } : {}),
      },
    });
  }

  function _pocRenderNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;
    const counts = _pocBoxCounts();
    const row = (kind, icon, labelKey, fallback, count, subKey, subFallback) => {
      const active = _pocSelected.kind === kind;
      return `<button type="button" class="personal-onto-nav-row${active ? ' is-active' : ''}" data-poc-nav="${kind}" data-poc-id="${kind}">
        <span class="personal-onto-nav-file-icon">${_icon(icon, 'ui-icon')}</span>
        <span class="personal-onto-nav-row-text is-stacked"><span class="personal-onto-nav-row-name">${escapeHtml(_t(labelKey, fallback))}</span><span class="personal-onto-nav-row-sub">${escapeHtml(_t(subKey, subFallback))}</span></span>
        ${count !== undefined ? `<span class="muted">${count}</span>` : ''}
      </button>`;
    };
    const personalActive = _pocView === 'personal';
    const taxonomyActive = _pocView === 'taxonomy' || (_pocView === 'personal' && _pocSelected.kind === 'tbox');
    const affairsActive = _pocView === 'affairs';
    const resourcesActive = _pocView === 'resources';
    const conceptsActive = _pocView === 'concepts';
    const relationsActive = _pocView === 'relationships';
    const homeActive = _pocView === 'overview';
    const hubNav = `<div class="personal-onto-nav-section personal-onto-hub-nav-list">
      ${_pocNavButton('ontology-home', 'personalOntology.nav_home', '本体总览', 'brain-circuit', homeActive)}
      ${_pocNavButton('personal-domain', 'personalOntology.nav_personal_domain', '个人本体', 'user', personalActive)}
      ${_pocNavButton('affairs-domain', 'personalOntology.nav_affairs_domain', '事项本体', 'file-text', affairsActive)}
      ${_pocNavButton('resources-domain', 'personalOntology.nav_resources_domain', '对象与资源', 'folder', resourcesActive)}
      ${_pocNavButton('concepts-domain', 'personalOntology.nav_concepts_domain', '概念本体', 'tag', conceptsActive)}
      ${_pocNavButton('taxonomy-domain', 'personalOntology.nav_taxonomy_domain', '分类与字段', 'list', taxonomyActive)}
      ${_pocNavButton('relationships-domain', 'personalOntology.nav_relationships_domain', '关系网络', 'link', relationsActive)}
    </div>`;

    if (_pocView !== 'personal') {
      nav.innerHTML = hubNav;
      return;
    }

    nav.innerHTML = `${hubNav}
    <div class="personal-onto-nav-section personal-onto-personal-subnav">
      <div class="personal-onto-nav-section-title">${escapeHtml(_t('personalOntology.personal_sections', '个人本体内容'))}</div>
      ${row('facts', 'user', 'personalOntology.nav_abox', '事实与条目', counts.facts, 'personalOntology.nav_abox_sub', '身份、偏好、项目——AI 长期记住的「关于我」')}
      ${row('rules', 'terminal', 'personalOntology.nav_rbox', '规则', counts.rules, 'personalOntology.nav_rbox_sub', 'AI 该怎么配合你做事、什么别做')}
      ${row('groups', 'type', 'personalOntology.nav_groups', '分组与模板', counts.groups, 'personalOntology.nav_groups_sub', '管理分组与角色模板')}
      ${_pocPendingCandidates.length ? `<div class="personal-onto-backflow-badge" style="padding:2px 10px 8px">${escapeHtml(_tv('personalOntology.backflow_badge', { n: _pocPendingCandidates.length }, '待添加 {n}'))}</div>` : ''}
    </div>
    <div class="personal-onto-nav-section">
      <div class="personal-onto-group-io">
        ${_button({ label: _t('personalOntology.memory_export', '导出记忆'), size: 'sm', className: 'personal-onto-group-io-btn o', attrs: { 'data-poc-nav': 'memory-export' } })}
        ${_button({ label: _t('personalOntology.memory_import', '导入记忆'), size: 'sm', className: 'personal-onto-group-io-btn o', attrs: { 'data-poc-nav': 'memory-import' } })}
      </div>
      <div class="personal-onto-io-hint">${escapeHtml(_t('personalOntology.io_hint', '导出：把事实与规则保存为文本文件。导入：从粘贴或文件加入条目，导入前可预览确认。'))}</div>
    </div>`;
  }

  // ── 右栏渲染 ─────────────────────────────────────────────────────────────
  // ── 本体分组子页数据加载 ─────────────────────────────────────────────

  /** asof 超龄（与主进程 isStaleAsOf 同口径：月差 > 12 标「可能过时」）。 */
  // 超龄判定（M5 暂留）：「截至/可能过时」chip 与超龄琥珀点已隐藏（审计
  // G5/D2），本函数当前无消费点；M5 时间锚控件落地时随展示一并恢复。
  function _pocIsStaleAsOf(asOf) {
    if (typeof asOf !== 'string') return false;
    const match = asOf.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/);
    if (!match) return false;
    const now = new Date();
    return (now.getFullYear() - Number(match[1])) * 12 + (now.getMonth() + 1 - Number(match[2])) > 12;
  }

  /** 普通分组列表（v2：从 po.snapshot 投影；模板组归「分组与模板」的角色模板区）。 */
  async function _pocLoadGroups() {
    if (!_pocPo.loaded && !(await _pocLoadPoSnapshot())) {
      _pocGroups = { list: [], loaded: true, loadError: _pocPo.loadError || _t('personalOntology.load_error', '加载失败') };
      return false;
    }
    _pocGroups = {
      list: _pocPoGroups().filter((g) => g.kind === 'user').map((g) => ({ group_id: g.id, title: g.title })),
      loaded: true,
      loadError: '',
    };
    return true;
  }

  /** 本体候选池（回流候选在这里确认）。 */
  /** 三盒数据（v2）：一次 po.snapshot + 资产库 + 冲突台账 + 图谱，域页共用。 */
  async function _pocLoadBoxData() {
    const assetsRes = await _pocInvoke('recall.assets.list', {});
    const sourceAssets = assetsRes && Array.isArray(assetsRes.assets)
      ? assetsRes.assets.filter((asset) => asset && asset.id)
      : [];
    const assets = sourceAssets.filter((asset) => asset.status === 'active');
    const snapshotOk = _pocPo.loaded ? true : await _pocLoadPoSnapshot();
    const groupsWithFields = snapshotOk ? _pocProjectBoxGroups(_pocPo.snapshot) : [];
    const [conflictsRes, graphRes] = await Promise.all([
      _pocInvoke('personalOntology.conflicts.list', {}),
      _pocInvoke('ontology.graph.read', {}),
    ]);
    _pocBoxData = {
      loaded: true,
      loadError: _pocPo.loadError || '',
      groups: groupsWithFields,
      assets,
      sourceAssets,
      conflicts: conflictsRes && Array.isArray(conflictsRes.conflicts) ? conflictsRes.conflicts : [],
      graph: graphRes && graphRes.ok !== false && graphRes.graph
        ? {
          loaded: true,
          loadError: '',
          categories: Array.isArray(graphRes.graph.categories) ? graphRes.graph.categories : [],
          entities: Array.isArray(graphRes.graph.entities) ? graphRes.graph.entities : [],
          relations: Array.isArray(graphRes.graph.relations) ? graphRes.graph.relations : [],
        }
        : { loaded: true, loadError: (graphRes && graphRes.error) || _t('ontologyGraph.load_error', '本体图谱读取失败'), categories: [], entities: [], relations: [] },
    };
    return true;
  }

  /** 盒数据变更后的统一重载（保持当前盒选中态）。 */
  async function _pocReloadBoxData() {
    _pocBoxData = {
      loaded: false, loadError: '', groups: [], assets: [], sourceAssets: [], conflicts: [],
      graph: { loaded: false, loadError: '', categories: [], entities: [], relations: [] },
    };
    await renderPersonalOntology();
  }

  async function refreshOntologyGraph() {
    const route = window.CogAssets && window.CogAssets.store && window.CogAssets.store.route;
    if (!_pocBoxData.loaded || (route && route.name !== 'ontology')) return;
    const previous = _pocBoxData.graph || { categories: [], entities: [], relations: [] };
    const result = await _pocInvoke('ontology.graph.read', {});
    if (!result || result.ok === false || !result.graph) {
      _pocBoxData.graph = { ...previous, loaded: true, loadError: (result && result.error) || _t('ontologyGraph.load_error', '本体图谱读取失败') };
    } else {
      _pocBoxData.graph = {
        loaded: true,
        loadError: '',
        categories: Array.isArray(result.graph.categories) ? result.graph.categories : [],
        entities: Array.isArray(result.graph.entities) ? result.graph.entities : [],
        relations: Array.isArray(result.graph.relations) ? result.graph.relations : [],
      };
    }
    const nav = document.getElementById('personal-onto-nav');
    const body = document.getElementById('personal-onto-main-body');
    if (nav && body) {
      _pocRenderNav();
      _pocBindNav();
      _pocRenderMain();
    }
  }

  /** 值冲突命中（按 gid+字段+值，冲突数据来自全量台账）。 */
  function _pocConflictFor(gid, field, value) {
    return (_pocBoxData.conflicts || []).some((c) => c && c.group_id === gid
      && c.field === field && (c.value_a === value || c.value_b === value));
  }

  // ════════════════════════════════════════════════════════════════════════
  // 个人本体 v2 视图（2026-09-29 重构）：po.snapshot 单次快照驱动三个页面
  // （事实 / 规则 / 分组与模板）。全部按 id 寻址，规则分类是一等列——
  // v1「筛选全空、不可编辑」两个痛点在这里根治。
  // ════════════════════════════════════════════════════════════════════════

  /** 加载 po.snapshot（一次调用拿全分组/字段/值/流水/计数/回收站）。 */
  async function _pocLoadPoSnapshot() {
    const res = await _pocInvoke('po.snapshot', {});
    if (!res || !Array.isArray(res.groups)) {
      _pocPo = { snapshot: null, loaded: true, loadError: (res && res.error) || _t('personalOntology.load_error', '加载失败') };
      return false;
    }
    _pocPo = { snapshot: res, loaded: true, loadError: '' };
    return true;
  }

  function _pocPoGroups() {
    return (_pocPo.snapshot && _pocPo.snapshot.groups) || [];
  }

  function _pocPoGroupById(gid) {
    return _pocPoGroups().find((g) => g.id === gid);
  }

  /** 规则形值判定（与主进程口径一致）：关系字段 / 带分类 / 文本含箭头。 */
  function _pocRuleShaped(field, value) {
    if (!value) return false;
    if (field && field.isRelation) return true;
    if (value.ruleKind) return true;
    return /→|->/.test(String(value.text || ''));
  }

  /** 把 po.snapshot 投影成旧消费方（关系网络 / 分类页 / 总览）吃的
   *  _pocBoxData.groups 形状：{gid,title,fields:[{name,isRelation,values[]}],entries}。 */
  function _pocProjectBoxGroups(snapshot) {
    return (snapshot.groups || []).map((g) => {
      const valueById = new Map((g.values || []).map((v) => [v.id, v]));
      return {
        gid: g.id,
        title: g.title,
        kind: g.kind,
        templateName: g.templateName,
        fields: (g.fields || []).map((f) => ({
          name: f.name,
          isRelation: f.isRelation,
          description: f.description,
          sectionTitle: f.section,
          status: f.status,
          values: (f.valueIds || []).map((vid) => valueById.get(vid)).filter(Boolean).map((v) => ({
            value: v.text,
            source: v.source,
            asOf: v.asOf,
            verified: v.verified,
            ruleKind: v.ruleKind,
            sensitivity: v.restricted ? 'restricted' : undefined,
            recallAssetId: v.assetId,
            id: v.id,
            fieldId: v.fieldId,
          })),
        })),
        entries: (g.entries || []).filter((e) => !e.section).map((e) => e.text),
      };
    });
  }

  /** 兼容旧调用点（nav / 总览 / 域页）： po.snapshot 优先，未加载时给零值。 */
  function _pocBoxCounts() {
    const snapshot = _pocPo.snapshot;
    if (!snapshot) {
      return { tbox: 0, abox: 0, rbox: 0, facts: 0, rules: 0, groups: 0, pending: _pocPendingCandidates.length };
    }
    const fieldById = new Map();
    for (const g of snapshot.groups) for (const f of g.fields) fieldById.set(f.id, f);
    let facts = 0;
    let rules = 0;
    for (const g of snapshot.groups) {
      for (const v of g.values) {
        if (_pocRuleShaped(fieldById.get(v.fieldId), v)) rules += 1;
        else facts += 1;
      }
    }
    return {
      tbox: snapshot.groups.length,
      abox: facts + _pocProfile.entries.length,
      rbox: rules + (_pocBoxData.assets || []).filter((a) => a.type === 'rule').length,
      facts,
      rules,
      groups: snapshot.groups.length,
      pending: _pocPendingCandidates.length,
    };
  }

  /** 状态点（琥珀=需要注意，红=矛盾）。 */
  function _pocStatusDotTone(value, conflicted) {
    if (conflicted) return 'danger';
    if (value && value.restricted) return 'warning';
    return '';
  }

  /** 值行元数据 chips。 */
  function _pocValueMetaChips(gid, field, value) {
    const chips = [];
    if (value.restricted) chips.push(_statusPill(_t('personalOntology.po2_restricted', '仅自己可见'), 'warning'));
    if (value.verified) chips.push(_tag(value.verified === 'independent'
      ? _t('personalOntology.po2_verified_independent', '已独立核实')
      : _t('personalOntology.po2_verified', '已核实')));
    if (value.asOf) chips.push(_tag(_tv('personalOntology.po2_asof_chip', { asof: value.asOf }, '截至 {asof}')));
    if (value.ruleKind) chips.push(_tag(_t(`personalOntology.rulekind_${value.ruleKind}`, '')));
    if (conflictedStatus(gid, field, value)) chips.push(_statusPill(_t('personalOntology.po2_conflict', '存在矛盾'), 'danger'));
    return chips.join('');
    function conflictedStatus(g, f, v) {
      return _pocConflictFor(g, f ? f.name : '', v.text);
    }
  }

  /** 值行「⋯」菜单（details 下拉；操作全部走 po.values.*）。 */
  function _pocValueMenuHtml(gid, field, value) {
    const item = (op, labelKey, fallback, opts = {}) =>
      _button({ label: _t(labelKey, fallback), size: 'xs', className: `po2-menu-item${opts.danger ? ' is-danger' : ''}`, attrs: { 'data-poc-value-op': op, 'data-poc-gid': gid, 'data-poc-value-id': value.id } });
    const kindItem = (kind, labelKey, fallback) =>
      _button({ label: _t(labelKey, fallback), size: 'xs', className: `po2-menu-item${value.ruleKind === kind ? ' is-active' : ''}`, attrs: { 'data-poc-value-op': `kind:${kind}`, 'data-poc-gid': gid, 'data-poc-value-id': value.id } });
    if (value.assetId) {
      // 资产投影只读：唯一出口是回来源资产改。
      return `<details class="po2-menu"><summary class="po2-menu-trigger" aria-label="menu">${_icon('more-horizontal', 'ui-icon')}</summary><div class="po2-menu-list">
        ${_button({ label: _t('personalOntology.po2_open_source_asset', '查看来源资产'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-value-op': 'open-asset', 'data-poc-gid': gid, 'data-poc-asset-id': value.assetId } })}
      </div></details>`;
    }
    return `<details class="po2-menu"><summary class="po2-menu-trigger" aria-label="menu">${_icon('more-horizontal', 'ui-icon')}</summary><div class="po2-menu-list">
      ${item('edit', 'personalOntology.po2_edit', '编辑')}
      ${_pocRuleShaped(field, value) ? `<div class="po2-menu-sep"></div>
        <div class="po2-menu-title">${escapeHtml(_t('personalOntology.po2_rule_kind_title', '规则分类'))}</div>
        ${kindItem('operation', 'personalOntology.rulekind_operation', '操作规则')}
        ${kindItem('preference', 'personalOntology.rulekind_preference', '偏好')}
        ${kindItem('constraint', 'personalOntology.rulekind_constraint', '约束')}
        ${kindItem('none', 'personalOntology.po2_kind_none', '移除分类')}` : ''}
      <div class="po2-menu-sep"></div>
      ${item(value.restricted ? 'unrestrict' : 'restrict', value.restricted ? 'personalOntology.po2_make_standard' : 'personalOntology.po2_make_restricted', value.restricted ? '恢复可见' : '仅自己可见')}
      ${item(value.verified === 'independent' ? 'unverify' : 'verify-independent', value.verified === 'independent' ? 'personalOntology.po2_unverify' : 'personalOntology.po2_verify_independent', value.verified === 'independent' ? '取消核实' : '标记独立核实')}
      ${value.verified !== 'independent' ? item(value.verified ? 'unverify' : 'verify', value.verified ? 'personalOntology.po2_unverify' : 'personalOntology.po2_verify', value.verified ? '取消核实' : '标记已核实') : ''}
      <div class="po2-menu-sep"></div>
      ${item('delete', 'common.delete', '删除', { danger: true })}
    </div></details>`;
  }

  /** 值行：文本 + chips + 菜单。 */
  function _pocRenderValueRow(gid, field, value) {
    const conflicted = _pocConflictFor(gid, field ? field.name : '', value.text);
    const dot = _statusDot(_pocStatusDotTone(value, conflicted));
    const assetBtn = value.assetId
      ? `<span class="po2-value-src">${_tag(_t('personalOntology.abox_asset_src', '来自认知资产'))}${_button({ label: _t('personalOntology.po2_open_source_asset', '查看来源资产'), size: 'xs', className: 'o po2-link-btn', attrs: { 'data-poc-value-op': 'open-asset', 'data-poc-gid': gid, 'data-poc-asset-id': value.assetId } })}</span>`
      : '';
    return `<div class="po2-value-row${value.restricted ? ' is-restricted' : ''}${conflicted ? ' is-conflict' : ''}" data-poc-value-id="${escapeHtml(value.id)}">
      <span class="po2-value-dot">${dot}</span>
      <span class="po2-value-text">${escapeHtml(value.text)}</span>
      <span class="po2-value-meta">${_pocValueMetaChips(gid, field, value)}</span>
      ${assetBtn}
      ${_pocValueMenuHtml(gid, field, value)}
    </div>`;
  }

  /** 字段块：字段头（名称/关系标记/操作）+ 值列表。 */
  function _pocRenderFieldBlock(gid, group, field) {
    const values = (field.valueIds || [])
      .map((vid) => (group.values || []).find((v) => v.id === vid))
      .filter(Boolean);
    const editableField = group.kind !== 'template' || field.origin === 'user';
    const fieldMenu = editableField
      ? `<details class="po2-menu"><summary class="po2-menu-trigger po2-menu-trigger-plain" aria-label="menu">${_icon('more-horizontal', 'ui-icon')}</summary><div class="po2-menu-list">
          ${_button({ label: _t('personalOntology.po2_rename_field', '重命名字段'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-field-op': 'rename', 'data-poc-gid': gid, 'data-poc-field-id': field.id } })}
          ${_button({ label: field.isRelation ? _t('personalOntology.po2_unset_relation', '取消关系字段') : _t('personalOntology.po2_set_relation', '设为关系字段'), size: 'xs', className: `po2-menu-item${field.isRelation ? ' is-active' : ''}`, attrs: { 'data-poc-field-op': 'toggle-relation', 'data-poc-gid': gid, 'data-poc-field-id': field.id } })}
          <div class="po2-menu-sep"></div>
          ${_button({ label: _t('personalOntology.po2_delete_field', '删除字段'), size: 'xs', className: 'po2-menu-item is-danger', attrs: { 'data-poc-field-op': 'delete', 'data-poc-gid': gid, 'data-poc-field-id': field.id } })}
        </div></details>`
      : '';
    const relTag = field.isRelation ? _tag(_t('personalOntology.po2_relation_tag', '关系')) : '';
    const customTag = group.kind === 'template' && field.origin === 'user' ? _tag(_t('personalOntology.po2_custom_field_tag', '自定义')) : '';
    const retiredTag = field.status === 'retired' ? _statusPill(_t('personalOntology.po2_retired_field_tag', '已下架'), 'warning') : '';
    return `<div class="po2-field" data-poc-field-id="${escapeHtml(field.id)}">
      <div class="po2-field-head">
        <span class="po2-field-name">${escapeHtml(field.name)}</span>
        ${relTag}${customTag}${retiredTag}
        ${field.description ? `<span class="po2-field-desc" title="${escapeHtml(field.description)}">${_icon('info', 'ui-icon')}</span>` : ''}
        <span class="po2-field-actions">
          ${_button({ label: _t('personalOntology.po2_add_value', '加一条'), size: 'xs', className: 'o', attrs: { 'data-poc-field-op': 'add-value', 'data-poc-gid': gid, 'data-poc-field-id': field.id } })}
          ${fieldMenu}
        </span>
      </div>
      <div class="po2-field-values">
        ${values.length ? values.map((v) => _pocRenderValueRow(gid, field, v)).join('') : `<div class="po2-value-empty muted">${escapeHtml(_t('personalOntology.po2_field_empty', '还没有内容'))}</div>`}
      </div>
    </div>`;
  }

  /** 分组块（按分节组织；普通组无分节）。 */
  function _pocRenderGroupBlock(group) {
    const gid = group.id;
    const isTemplate = group.kind === 'template';
    const templateTag = isTemplate ? _tag(group.templateName || group.templateId || _t('personalOntology.po2_template_tag', '角色模板')) : '';
    const sections = [];
    const sectionOrder = [];
    for (const f of group.fields || []) {
      const s = f.section || '';
      if (!sectionOrder.includes(s)) sectionOrder.push(s);
    }
    for (const e of group.entries || []) {
      const s = e.section || '';
      if (!sectionOrder.includes(s)) sectionOrder.push(s);
    }
    if (!sectionOrder.length) sectionOrder.push('');
    const groupMenu = `<details class="po2-menu"><summary class="po2-menu-trigger po2-menu-trigger-plain" aria-label="menu">${_icon('more-horizontal', 'ui-icon')}</summary><div class="po2-menu-list">
      ${isTemplate ? '' : _button({ label: _t('personalOntology.po2_add_field', '新字段'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-group-op': 'add-field', 'data-poc-gid': gid } })}
      ${_button({ label: _t('personalOntology.po2_add_entry', '记一笔'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-group-op': 'add-entry', 'data-poc-gid': gid } })}
      ${_button({ label: _t('personalOntology.po2_history', '历史版本'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-group-op': 'history', 'data-poc-gid': gid } })}
      ${isTemplate ? '' : `<div class="po2-menu-sep"></div>
        ${_button({ label: _t('personalOntology.po2_rename_group', '重命名分组'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-group-op': 'rename', 'data-poc-gid': gid } })}
        ${_button({ label: _t('personalOntology.po2_delete_group', '删除分组'), size: 'xs', className: 'po2-menu-item is-danger', attrs: { 'data-poc-group-op': 'delete', 'data-poc-gid': gid } })}`}
    </div></details>`;
    for (const section of sectionOrder) {
      const fields = (group.fields || []).filter((f) => (f.section || '') === section);
      const entries = (group.entries || []).filter((e) => (e.section || '') === section);
      const entryItems = entries.map((entry) => `<div class="po2-entry-row" data-poc-entry-id="${escapeHtml(entry.id)}">
        <span class="po2-entry-text">${escapeHtml(entry.text)}</span>
        <span class="po2-entry-actions">
          ${_button({ label: _t('personalOntology.po2_entry_promote', '转正为字段'), size: 'xs', className: 'o po2-link-btn', attrs: { 'data-poc-entry-op': 'promote', 'data-poc-gid': gid, 'data-poc-entry-id': entry.id } })}
          ${_button({ label: _t('common.delete', '删除'), size: 'xs', className: 'o po2-link-btn is-danger', attrs: { 'data-poc-entry-op': 'delete', 'data-poc-gid': gid, 'data-poc-entry-id': entry.id } })}
        </span>
      </div>`).join('');
      sections.push(`<div class="po2-section">
        ${section ? `<div class="po2-section-title">${escapeHtml(section)}</div>` : ''}
        ${fields.map((f) => _pocRenderFieldBlock(gid, group, f)).join('')}
        ${entryItems ? `<div class="po2-entries">${entryItems}</div>` : ''}
      </div>`);
    }
    return `<section class="po2-group" data-poc-gid="${escapeHtml(gid)}">
      <header class="po2-group-head">
        <span class="po2-group-title">${escapeHtml(group.title)}</span>
        ${templateTag}
        <span class="po2-group-count muted">${escapeHtml(_tv('personalOntology.po2_group_count', { n: (group.values || []).length }, '{n} 条'))}</span>
        <span class="po2-group-actions">
          ${_button({ label: _t('personalOntology.po2_add_value', '加一条'), size: 'xs', className: 'o', attrs: { 'data-poc-group-op': 'add-entry', 'data-poc-gid': gid } })}
          ${groupMenu}
        </span>
      </header>
      <div class="po2-group-body">${sections.join('')}</div>
    </section>`;
  }

  /** 来自认知资产的画像条目（正式资产是事实来源，这里只读呈现 + 跳转）。
   *  分节按关键词现算（与 profile 数据层解耦，条目本身不带 section）。 */
  function _pocRenderProfileSection() {
    const entries = _pocProfile.entries || [];
    if (!entries.length) return '';
    const sections = _pocProfileSections();
    const item = (entry) => `<details class="poc-entry"><summary class="poc-entry-clamp">${escapeHtml(_pocTextSnippet(entry.text, 160))}</summary>
      <div class="poc-entry-full">${escapeHtml(entry.text)}</div>
      <div class="po2-entry-src">
        ${_tag(_t('personalOntology.abox_asset_src', '来自认知资产'))}
        ${_button({ label: _t('personalOntology.po2_open_source_asset', '查看来源资产'), size: 'xs', className: 'o po2-link-btn', attrs: { 'data-poc-value-op': 'open-asset', 'data-poc-gid': '', 'data-poc-asset-id': entry.assetId } })}
      </div>
    </details>`;
    const sectionHtml = sections.map((section) => {
      if (!section.entries || !section.entries.length) return '';
      return `<div class="po2-profile-section">
        <div class="po2-profile-title">${escapeHtml(_t(section.titleKey, section.title))}</div>
        ${section.entries.map(item).join('')}
      </div>`;
    }).join('');
    const classified = new Set(sections.flatMap((s) => s.entries || []).map((e) => e.assetId + '\u0000' + e.text));
    const rest = entries.filter((entry) => !classified.has(entry.assetId + '\u0000' + entry.text));
    return `<section class="po2-group po2-profile-group">
      <header class="po2-group-head">
        <span class="po2-group-title">${escapeHtml(_t('personalOntology.po2_profile_title', '来自对话的个人信息'))}</span>
        <span class="po2-group-count muted">${escapeHtml(_tv('personalOntology.po2_group_count', { n: entries.length }, '{n} 条'))}</span>
      </header>
      <div class="po2-group-body">${sectionHtml}
        ${rest.length ? `<div class="po2-profile-section"><div class="po2-profile-title">${escapeHtml(_t('personalOntology.ontology_other', '其他沉淀'))}</div>${rest.map(item).join('')}</div>` : ''}
      </div>
    </section>`;
  }

  /** 待确认候选横幅（AI 提议 → 用户拍板：收下时选去向）。 */
  function _pocRenderCandidateBanner() {
    if (!_pocPendingCandidates.length) return '';
    const rows = _pocPendingCandidates.map((candidate) => {
      if (!candidate || !candidate.candidate_id) return '';
      const text = String(candidate.memory_text || candidate.summary || '').trim();
      const kindTag = candidate.kind === 'rule' ? _tag(_t('personalOntology.po2_candidate_rule', '规则')) : '';
      return `<div class="po2-candidate" data-poc-candidate-id="${escapeHtml(candidate.candidate_id)}">
        <span class="po2-candidate-tag">${_statusPill(_t('personalOntology.po2_candidate_pending', '待确认'), 'warning')}</span>
        <span class="po2-candidate-text">${escapeHtml(_pocTextSnippet(text || candidate.summary || '', 200))}</span>
        ${kindTag}
        <span class="po2-candidate-actions">
          ${_button({ label: _t('personalOntology.po2_candidate_accept', '收下'), size: 'sm', attrs: { 'data-poc-candidate-op': 'confirm', 'data-poc-candidate-id': candidate.candidate_id } })}
          ${_button({ label: _t('personalOntology.po2_candidate_skip', '跳过'), size: 'sm', className: 'o', attrs: { 'data-poc-candidate-op': 'reject', 'data-poc-candidate-id': candidate.candidate_id } })}
        </span>
      </div>`;
    }).join('');
    return `<section class="po2-candidates">
      <div class="po2-candidates-title">${escapeHtml(_tv('personalOntology.po2_candidates_title', { n: _pocPendingCandidates.length }, 'AI 建议加入个人本体 · {n} 条'))}</div>
      ${rows}
    </section>`;
  }

  // ── 页面一：事实与条目 ──────────────────────────────────────────────────

  function _pocRenderFactsView() {
    const groups = _pocPoGroups();
    const filter = _pocFactsFilter;
    const q = String(filter.q || '').trim().toLowerCase();
    const matchGroup = (group) => {
      if (filter.group !== 'all' && group.id !== filter.group) return false;
      if (!q) return true;
      const inTitle = String(group.title || '').toLowerCase().includes(q);
      const inValues = (group.values || []).some((v) => String(v.text || '').toLowerCase().includes(q));
      const inEntries = (group.entries || []).some((e) => String(e.text || '').toLowerCase().includes(q));
      return inTitle || inValues || inEntries;
    };
    const options = [`<option value="all"${filter.group === 'all' ? ' selected' : ''}>${escapeHtml(_t('personalOntology.po2_filter_all_groups', '全部分组'))}</option>`]
      .concat(groups.map((g) => `<option value="${escapeHtml(g.id)}"${filter.group === g.id ? ' selected' : ''}>${escapeHtml(g.title)}</option>`));
    const visible = groups.filter(matchGroup);
    const groupBlocks = visible.map((g) => _pocRenderGroupBlock(g)).join('');
    return `<div class="po2-view">
      ${_pocRenderCandidateBanner()}
      <div class="po2-toolbar">
        <select class="po2-select" data-poc-facts-group-filter aria-label="filter">${options.join('')}</select>
        <input type="search" class="po2-search po2-input" data-poc-facts-q value="${escapeHtml(filter.q || '')}" placeholder="${escapeHtml(_t('personalOntology.po2_search_placeholder', '搜索事实…'))}" aria-label="search">
        ${_button({ label: _t('personalOntology.po2_compose_value', '记一条'), icon: 'plus', size: 'sm', attrs: { 'data-poc-op': 'compose-value' } })}
      </div>
      ${_pocRenderProfileSection()}
      ${groupBlocks}
      ${!visible.length ? `<div class="po2-empty">${_emptyState({
        kind: 'actionable',
        title: q || filter.group !== 'all'
          ? _t('personalOntology.po2_filter_empty', '没有匹配的事实')
          : _t('personalOntology.po2_facts_empty', '个人本体还是空的。点「记一条」写下第一件想让 AI 记住的事，或到「分组与模板」装一个角色模板开始。'),
        icon: 'user',
        action: (q || filter.group !== 'all') ? undefined : { label: _t('personalOntology.po2_compose_value', '记一条'), icon: 'plus', size: 'sm', attrs: { 'data-poc-op': 'compose-value' } },
      })}</div>` : ''}
    </div>`;
  }

  // ── 页面二：规则 ────────────────────────────────────────────────────────

  /** 规则清单行。 */
  function _pocRenderRuleRow(group, field, value) {
    const kindLabels = { operation: 'rulekind_operation', preference: 'rulekind_preference', constraint: 'rulekind_constraint' };
    const kindTag = value.ruleKind
      ? _tag(_t(`personalOntology.${kindLabels[value.ruleKind]}`, ''))
      : _statusPill(_t('personalOntology.po2_kind_none_short', '未分类'), 'warning');
    const where = `${group.title} · ${field.name}`;
    const restricted = value.restricted ? _statusPill(_t('personalOntology.po2_restricted', '仅自己可见'), 'warning') : '';
    const assetBtn = value.assetId
      ? _button({ label: _t('personalOntology.po2_open_source_asset', '查看来源资产'), size: 'xs', className: 'o po2-link-btn', attrs: { 'data-poc-value-op': 'open-asset', 'data-poc-gid': group.id, 'data-poc-asset-id': value.assetId } })
      : _pocValueMenuHtml(group.id, field, value);
    return `<div class="po2-rule-row" data-poc-value-id="${escapeHtml(value.id)}">
      <span class="po2-rule-where">${escapeHtml(where)}</span>
      <span class="po2-rule-text">${escapeHtml(value.text)}</span>
      ${kindTag}${restricted}
      ${assetBtn}
    </div>`;
  }

  function _pocRenderRulesView() {
    const groups = _pocPoGroups();
    const fieldById = new Map();
    for (const g of groups) for (const f of g.fields) fieldById.set(f.id, f);
    const rows = [];
    for (const g of groups) {
      for (const v of g.values || []) {
        const field = fieldById.get(v.fieldId);
        if (!_pocRuleShaped(field, v)) continue;
        rows.push({ group: g, field, value: v });
      }
    }
    const filter = _pocRuleFilter;
    const countBy = { all: rows.length, operation: 0, preference: 0, constraint: 0, none: 0 };
    for (const row of rows) {
      if (row.value.ruleKind) countBy[row.value.ruleKind] += 1;
      else countBy.none += 1;
    }
    const chip = (key, labelKey, fallback, n) =>
      _button({ label: `${_t(labelKey, fallback)} ${n}`, size: 'sm', className: `personal-onto-filter-chip${filter === key ? ' is-active' : ''}`, attrs: { 'data-poc-rule-filter': key, 'aria-pressed': String(filter === key) } });
    const visible = rows.filter((row) => filter === 'all' || (filter === 'none' ? !row.value.ruleKind : row.value.ruleKind === filter));
    const ruleAssets = (_pocBoxData.assets || []).filter((a) => a.type === 'rule');
    return `<div class="po2-view">
      <div class="po2-toolbar">
        <div class="po2-chips">
          ${chip('all', 'personalOntology.tribox_filter_all', '全部', countBy.all)}
          ${chip('operation', 'personalOntology.rulekind_operation', '操作规则', countBy.operation)}
          ${chip('preference', 'personalOntology.rulekind_preference', '偏好', countBy.preference)}
          ${chip('constraint', 'personalOntology.rulekind_constraint', '约束', countBy.constraint)}
          ${chip('none', 'personalOntology.po2_kind_none_short', '未分类', countBy.none)}
        </div>
        ${_button({ label: _t('personalOntology.po2_compose_rule', '加规则'), icon: 'plus', size: 'sm', attrs: { 'data-poc-op': 'compose-rule' } })}
      </div>
      ${visible.length ? visible.map((row) => _pocRenderRuleRow(row.group, row.field, row.value)).join('') : `<div class="po2-empty">${_emptyState({
        kind: 'actionable',
        title: rows.length
          ? _t('personalOntology.po2_rules_filter_empty', '这个分类下还没有规则')
          : _t('personalOntology.po2_rules_empty', '还没有规则。写一条「A → B」形状的规则（如「回复长任务 → 先给分段结论」），AI 会照着做。'),
        icon: 'terminal',
        action: rows.length ? undefined : { label: _t('personalOntology.po2_compose_rule', '加规则'), icon: 'plus', size: 'sm', attrs: { 'data-poc-op': 'compose-rule' } },
      })}</div>`}
      ${ruleAssets.length ? `<section class="po2-group po2-rule-assets">
        <header class="po2-group-head"><span class="po2-group-title">${escapeHtml(_t('personalOntology.po2_rule_assets_title', '来自认知资产的规则'))}</span>
          <span class="po2-group-count muted">${escapeHtml(_tv('personalOntology.po2_group_count', { n: ruleAssets.length }, '{n} 条'))}</span></header>
        <div class="po2-group-body">
          ${ruleAssets.map((asset) => `<div class="po2-rule-row">
            <span class="po2-rule-text">${escapeHtml(_pocTextSnippet(asset.statement || asset.title || '', 220))}</span>
            ${_button({ label: _t('personalOntology.po2_open_source_asset', '查看来源资产'), size: 'xs', className: 'o po2-link-btn', attrs: { 'data-poc-value-op': 'open-asset', 'data-poc-gid': '', 'data-poc-asset-id': asset.id } })}
          </div>`).join('')}
        </div>
      </section>` : ''}
    </div>`;
  }

  // ── 页面三：分组与模板 ──────────────────────────────────────────────────

  function _pocRenderDeletedGroupsHtml() {
    const deleted = (_pocPo.snapshot && _pocPo.snapshot.deleted) || [];
    if (!deleted.length) return '';
    const rows = deleted.map((d) => `<div class="po2-deleted-row">
      <span class="po2-deleted-title">${escapeHtml(d.title)}</span>
      <span class="muted">${escapeHtml(d.deletedAt || '')}</span>
      ${_button({ label: _t('personalOntology.po2_restore_group', '恢复'), size: 'xs', className: 'o', attrs: { 'data-poc-deleted-op': 'restore', 'data-poc-gid': d.groupId } })}
    </div>`).join('');
    return `<details class="po2-deleted">
      <summary class="po2-deleted-summary">${escapeHtml(_tv('personalOntology.po2_deleted_title', { n: deleted.length }, '已删除分组 · {n}'))}</summary>
      <div class="po2-deleted-body">${rows}</div>
    </details>`;
  }

  function _pocRenderGroupsView() {
    const groups = _pocPoGroups();
    const userGroups = groups.filter((g) => g.kind === 'user');
    const templates = _pocTemplates.filter((t) => t.installed && t.group_id);
    const groupCards = userGroups.map((g) => {
      const fieldCount = (g.fields || []).length;
      const valueCount = (g.values || []).length;
      return `<section class="po2-group-card" data-poc-gid="${escapeHtml(g.id)}">
        <header class="po2-group-card-head">
          <span class="po2-group-title">${escapeHtml(g.title)}</span>
          <span class="muted">${escapeHtml(_tv('personalOntology.po2_group_card_meta', { fields: fieldCount, values: valueCount }, '{fields} 个字段 · {values} 条'))}</span>
          <span class="po2-group-actions">
            ${_button({ label: _t('personalOntology.po2_add_field', '新字段'), size: 'xs', className: 'o', attrs: { 'data-poc-group-op': 'add-field', 'data-poc-gid': g.id } })}
            <details class="po2-menu"><summary class="po2-menu-trigger po2-menu-trigger-plain" aria-label="menu">${_icon('more-horizontal', 'ui-icon')}</summary><div class="po2-menu-list">
              ${_button({ label: _t('personalOntology.po2_rename_group', '重命名分组'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-group-op': 'rename', 'data-poc-gid': g.id } })}
              ${_button({ label: _t('personalOntology.po2_history', '历史版本'), size: 'xs', className: 'po2-menu-item', attrs: { 'data-poc-group-op': 'history', 'data-poc-gid': g.id } })}
              <div class="po2-menu-sep"></div>
              ${_button({ label: _t('personalOntology.po2_delete_group', '删除分组'), size: 'xs', className: 'po2-menu-item is-danger', attrs: { 'data-poc-group-op': 'delete', 'data-poc-gid': g.id } })}
            </div></details>
          </span>
        </header>
        <div class="po2-group-card-body">
          ${(g.fields || []).length ? (g.fields || []).map((f) => `<div class="po2-field-line">
            <span class="po2-field-name">${escapeHtml(f.name)}</span>
            ${f.isRelation ? _tag(_t('personalOntology.po2_relation_tag', '关系')) : ''}
            <span class="muted">${escapeHtml(_tv('personalOntology.po2_field_value_count', { n: (f.valueIds || []).length }, '{n} 条'))}</span>
          </div>`).join('') : `<div class="po2-value-empty muted">${escapeHtml(_t('personalOntology.po2_group_no_fields', '还没有字段，点「新字段」创建'))}</div>`}
        </div>
      </section>`;
    }).join('');
    const templateRows = templates.map((t) => `<div class="po2-template-row" data-poc-template-id="${escapeHtml(t.template_id)}">
      <button type="button" class="personal-onto-nav-row is-file" data-poc-nav="template" data-poc-id="${escapeHtml(t.group_id)}">
        <span class="personal-onto-nav-file-icon">${_icon('package', 'ui-icon')}</span>
        <span class="personal-onto-nav-row-text is-stacked"><span class="personal-onto-nav-row-name">${escapeHtml(t.name)}</span><span class="personal-onto-nav-row-sub">${escapeHtml(_tv('personalOntology.po2_template_version', { v: t.installed_version || t.version }, '版本 {v}'))}</span></span>
      </button>
      ${_iconButton({ icon: 'trash', label: _t('personalOntology.po2_uninstall_template', '卸载模板'), variant: 'danger', className: 'personal-onto-template-uninstall', size: 'sm', attrs: { 'data-poc-nav': 'template-uninstall', 'data-poc-template-id': t.template_id } })}
    </div>`).join('');
    return `<div class="po2-view">
      <div class="po2-toolbar">
        ${_button({ label: _t('personalOntology.po2_create_group', '新建分组'), icon: 'plus', size: 'sm', attrs: { 'data-poc-op': 'new-group' } })}
        <span class="po2-toolbar-hint muted">${escapeHtml(_t('personalOntology.po2_groups_hint', '分组是事实的抽屉；角色模板是现成的表格。'))}</span>
      </div>
      ${groupCards}
      ${!userGroups.length ? `<div class="po2-empty">${_emptyState({
        kind: 'actionable',
        title: _t('personalOntology.po2_groups_empty', '还没有自己的分组。新建一个，或从下面的模板库装一个现成表格。'),
        icon: 'folder',
        action: { label: _t('personalOntology.po2_create_group', '新建分组'), icon: 'plus', size: 'sm', attrs: { 'data-poc-op': 'new-group' } },
      })}</div>` : ''}
      ${_pocRenderDeletedGroupsHtml()}
      <section class="po2-group po2-templates">
        <header class="po2-group-head">
          <span class="po2-group-title">${escapeHtml(_t('personalOntology.po2_templates_title', '角色模板'))}</span>
          <span class="po2-group-actions">${_button({ label: _t('personalOntology.template_library', '角色模板库'), size: 'sm', className: 'o personal-onto-template-library-btn', attrs: { 'data-poc-op': 'template-library' } })}</span>
        </header>
        <div class="po2-group-body">
          ${templateRows || `<div class="po2-value-empty muted">${escapeHtml(_t('personalOntology.dest_no_roles', '尚未安装角色模板，可在「角色模板库」中安装'))}</div>`}
        </div>
      </section>
    </div>`;
  }

  // ── 候选池加载 ──────────────────────────────────────────────────────────

  async function _pocLoadPendingCandidates() {
    const res = await _pocInvoke('personalOntology.candidates.list', {});
    _pocPendingCandidates = res && Array.isArray(res.candidate_updates) ? res.candidate_updates.filter((c) => c && c.candidate_id) : [];
    _pocCandidatesLoaded = true;
  }

  // ── 弹层表单小助手（uiModal 契约：actions 返回 {value}，字段按 id 取值）──

  async function _pocModalForm({ title, bodyHtml, actions, submitLabel }) {
    if (typeof window.uiModal !== 'function') return null;
    return window.uiModal({
      title,
      closeLabel: _t('personalOntology.dialog_close', '关闭'),
      bodyHtml,
      actions: actions || [
        { label: _t('common.cancel', '取消'), id: 'cancel', role: 'secondary' },
        { label: submitLabel || _t('common.confirm', '确定'), id: 'save', role: 'primary' },
      ],
    });
  }

  function _checkbox(options) {
    if (typeof window.uiCheckbox === 'function') return window.uiCheckbox(options);
    throw new Error('personal ontology requires uiCheckbox');
  }

  function _pocFieldText(id, label, value, opts = {}) {
    if (typeof window.uiField === 'function') {
      return window.uiField({ id, label, ...(opts.hint ? { hint: opts.hint } : {}), control: { id, value: value || '', ...(opts.placeholder ? { attrs: { placeholder: opts.placeholder } } : {}) } });
    }
    return `<label class="field"><span>${escapeHtml(label)}</span>${_input({ id, value: value || '', ...(opts.placeholder ? { attrs: { placeholder: opts.placeholder } } : {}) })}</label>`;
  }

  function _pocFieldTextarea(id, label, value, opts = {}) {
    if (typeof window.uiField === 'function') {
      return window.uiField({ id, label, ...(opts.hint ? { hint: opts.hint } : {}), control: { kind: 'textarea', id, value: value || '', rows: opts.rows || 3 } });
    }
    return `<label class="field"><span>${escapeHtml(label)}</span>${_textarea({ id, value: value || '', rows: opts.rows || 3 })}</label>`;
  }

  function _pocFieldSelect(id, label, options, value, opts = {}) {
    const optionHtml = options.map((opt) => `<option value="${escapeHtml(opt.value)}"${opt.value === value ? ' selected' : ''}${opt.disabled ? ' disabled' : ''}>${escapeHtml(opt.label)}</option>`).join('');
    return `<label class="field po2-field-wrap"><span>${escapeHtml(label)}</span><select id="${escapeHtml(id)}" class="po2-select">${optionHtml}</select>${opts.hint ? `<span class="po2-field-hint muted">${escapeHtml(opts.hint)}</span>` : ''}</label>`;
  }

  /** 变更后的统一刷新：重拉快照与盒数据（保持页面与选中态）。 */
  async function _pocReloadPo() {
    _pocPo = { snapshot: null, loaded: false, loadError: '' };
    _pocBoxData = { loaded: false, loadError: '', groups: [], assets: [], sourceAssets: [], conflicts: [], graph: _pocBoxData.graph };
    await renderPersonalOntology();
  }

  // ── 组操作 ──────────────────────────────────────────────────────────────

  async function _pocCreateGroupPrompt() {
    const id = 'po2-new-group-title';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_create_group', '新建分组'),
      bodyHtml: _pocFieldText(id, _t('personalOntology.po2_group_name_label', '分组名'), '', { placeholder: _t('personalOntology.po2_group_name_placeholder', '如：工作偏好 / 项目 / 习惯') }),
    });
    if (!dialog || dialog.value !== 'save') return;
    const title = String((document.getElementById(id) || {}).value || '').trim();
    if (!title) {
      _pocToast('personalOntology.po2_name_required', '名称不能为空', 'error');
      return;
    }
    const res = await _pocInvoke('po.groups.create', { title });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    _pocToast('personalOntology.po2_group_created', '分组已创建', 'success');
    await _pocReloadPo();
  }

  async function _pocRenameGroupPromptV2(gid) {
    const group = _pocPoGroupById(gid);
    if (!group) return;
    const id = 'po2-rename-group-title';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_rename_group', '重命名分组'),
      bodyHtml: _pocFieldText(id, _t('personalOntology.po2_group_name_label', '分组名'), group.title),
    });
    if (!dialog || dialog.value !== 'save') return;
    const title = String((document.getElementById(id) || {}).value || '').trim();
    if (!title || title === group.title) return;
    const res = await _pocInvoke('po.groups.rename', { groupId: gid, title });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocDeleteGroupConfirmV2(gid) {
    const group = _pocPoGroupById(gid);
    if (!group) return;
    const confirmed = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({
        title: _t('personalOntology.po2_delete_group', '删除分组'),
        message: _tv('personalOntology.po2_delete_group_confirm', { title: group.title }, `删除「${group.title}」？分组内全部字段与值会进「已删除分组」，可恢复。`),
        dangerLabel: _t('common.delete', '删除'),
      })
      : typeof uiConfirm === 'function' ? await uiConfirm({ message: _t('personalOntology.po2_delete_group_confirm', '删除这个分组？') }) : false;
    if (!confirmed) return;
    const res = await _pocInvoke('po.groups.delete', { groupId: gid });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    _pocToast('personalOntology.po2_group_deleted', '已删除（可恢复）', 'success');
    await _pocReloadPo();
  }

  async function _pocRestoreDeletedGroupV2(el, gid) {
    const res = await _pocRunOnce(`po-restore:${gid}`, el, () => _pocInvoke('po.groups.restore', { groupId: gid }));
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    _pocToast('personalOntology.po2_group_restored', '已恢复', 'success');
    await _pocReloadPo();
  }

  // ── 字段操作 ────────────────────────────────────────────────────────────

  async function _pocAddFieldPromptV2(gid, section) {
    const group = _pocPoGroupById(gid);
    if (!group) return;
    const nameId = 'po2-add-field-name';
    const relId = 'po2-add-field-relation';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_add_field', '新字段'),
      bodyHtml: `${_pocFieldText(nameId, _t('personalOntology.po2_field_name_label', '字段名'), '', { placeholder: _t('personalOntology.po2_field_name_placeholder', '如：常用工具 / 汇报关系') })}
        <label class="field po2-field-wrap"><span>${escapeHtml(_t('personalOntology.po2_relation_field_label', '关系字段'))}</span>${_checkbox({ id: relId, label: _t('personalOntology.po2_relation_field_label', '关系字段'), className: 'po2-checkbox' })}<span class="po2-field-hint muted">${escapeHtml(_t('personalOntology.po2_relation_field_hint', '值形如「A → B」，会按规则进入世界模型'))}</span></label>`,
    });
    if (!dialog || dialog.value !== 'save') return;
    const name = String((document.getElementById(nameId) || {}).value || '').trim();
    if (!name) {
      _pocToast('personalOntology.po2_name_required', '名称不能为空', 'error');
      return;
    }
    const isRelation = (document.getElementById(relId) || {}).checked === true;
    const res = await _pocInvoke('po.fields.create', { groupId: gid, name, isRelation, ...(section ? { section } : {}) });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocRenameFieldPromptV2(gid, fieldId) {
    const group = _pocPoGroupById(gid);
    const field = group && (group.fields || []).find((f) => f.id === fieldId);
    if (!field) return;
    const id = 'po2-rename-field-name';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_rename_field', '重命名字段'),
      bodyHtml: _pocFieldText(id, _t('personalOntology.po2_field_name_label', '字段名'), field.name),
    });
    if (!dialog || dialog.value !== 'save') return;
    const name = String((document.getElementById(id) || {}).value || '').trim();
    if (!name || name === field.name) return;
    const res = await _pocInvoke('po.fields.rename', { groupId: gid, fieldId, name });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocToggleFieldRelationV2(gid, fieldId) {
    const group = _pocPoGroupById(gid);
    const field = group && (group.fields || []).find((f) => f.id === fieldId);
    if (!field) return;
    const res = await _pocInvoke('po.fields.setRelation', { groupId: gid, fieldId, isRelation: !field.isRelation });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocDeleteFieldConfirmV2(gid, fieldId) {
    const group = _pocPoGroupById(gid);
    const field = group && (group.fields || []).find((f) => f.id === fieldId);
    if (!field) return;
    const confirmed = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({
        title: _t('personalOntology.po2_delete_field', '删除字段'),
        message: _tv('personalOntology.po2_delete_field_confirm', { name: field.name }, `删除字段「${field.name}」及其全部值？`),
        dangerLabel: _t('common.delete', '删除'),
      })
      : false;
    if (!confirmed) return;
    const res = await _pocInvoke('po.fields.delete', { groupId: gid, fieldId });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  // ── 值操作 ──────────────────────────────────────────────────────────────

  /** 目标字段选择数据：分组下拉 → 字段下拉（联动用 data 属性静态联动，简单二列）。 */
  function _pocDestinationOptions() {
    const groups = _pocPoGroups();
    return groups.map((g) => ({
      value: g.id,
      label: g.title,
      fields: (g.fields || []).filter((f) => f.status !== 'retired').map((f) => ({ value: f.id, label: f.name + (f.section ? ` · ${f.section}` : '') })),
    }));
  }

  /** 记一条（可选预选组/字段；规则走独立入口带分类）。 */
  async function _pocComposeValuePrompt(presetGid, presetFieldId, presetKind) {
    const dests = _pocDestinationOptions();
    if (!dests.length) {
      _pocToast('personalOntology.po2_need_group_first', '先到「分组与模板」建一个分组（或装一个角色模板）', 'error');
      return;
    }
    const gid = presetGid || dests[0].value;
    const dest = dests.find((d) => d.value === gid) || dests[0];
    const groupSelectId = 'po2-compose-group';
    const fieldSelectId = 'po2-compose-field';
    const textId = 'po2-compose-text';
    const asOfId = 'po2-compose-asof';
    const kindId = 'po2-compose-kind';
    const fieldOptions = [{ value: '', label: _t('personalOntology.po2_pick_field', '选择字段…'), disabled: true }].concat(dest.fields.map((f) => ({ value: f.value, label: f.label })));
    const kindOptions = [
      { value: '', label: _t('personalOntology.po2_kind_none_short', '未分类') },
      { value: 'operation', label: _t('personalOntology.rulekind_operation', '操作规则') },
      { value: 'preference', label: _t('personalOntology.rulekind_preference', '偏好') },
      { value: 'constraint', label: _t('personalOntology.rulekind_constraint', '约束') },
    ];
    const dialog = await _pocModalForm({
      title: presetKind ? _t('personalOntology.po2_compose_rule', '加规则') : _t('personalOntology.po2_compose_value', '记一条'),
      bodyHtml: `
        ${_pocFieldSelect(groupSelectId, _t('personalOntology.po2_dest_group', '写进哪个分组'), dests, gid)}
        ${_pocFieldSelect(fieldSelectId, _t('personalOntology.po2_dest_field', '哪个字段'), fieldOptions, presetFieldId || '')}
        ${_pocFieldTextarea(textId, _t('personalOntology.po2_value_label', presetKind ? '规则内容' : '内容'), '', { placeholder: presetKind ? _t('personalOntology.po2_rule_placeholder', '如：改完代码 → 必须先跑全量测试') : _t('personalOntology.po2_value_placeholder', '一件想让 AI 长期记住的事'), rows: 3 })}
        ${presetKind ? _pocFieldSelect(kindId, _t('personalOntology.po2_rule_kind_title', '规则分类'), kindOptions, presetKind) : ''}
        ${_pocFieldText(asOfId, _t('personalOntology.po2_asof_label', '信息截至时间（可选）'), '', { placeholder: 'YYYY-MM', hint: _t('personalOntology.po2_asof_hint', '让 AI 知道这条信息什么时候还可靠') })}`,
    });
    if (!dialog || dialog.value !== 'save') return;
    const nextGid = String((document.getElementById(groupSelectId) || {}).value || '');
    const fieldId = String((document.getElementById(fieldSelectId) || {}).value || '');
    const text = String((document.getElementById(textId) || {}).value || '').trim();
    const asOf = String((document.getElementById(asOfId) || {}).value || '').trim();
    const kind = String((document.getElementById(kindId) || {}).value || '').trim();
    if (!nextGid || !fieldId) {
      _pocToast('personalOntology.po2_pick_field_first', '选一个分组和字段', 'error');
      return;
    }
    if (!text) {
      _pocToast('personalOntology.po2_value_empty_error', '内容不能为空', 'error');
      return;
    }
    if (asOf && !/^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/.test(asOf)) {
      _pocToast('personalOntology.asof_invalid_error', '时间格式应为 YYYY-MM（如 2026-09）', 'error');
      return;
    }
    const res = await _pocInvoke('po.values.add', { groupId: nextGid, fieldId, text, ...(asOf ? { asOf } : {}), ...(kind ? { ruleKind: kind } : {}) });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    if (/→|->/.test(text)) {
      _pocToast('personalOntology.rule_saved', '已按规则保存（A → B）：将作为规则进入世界模型', 'success');
    } else {
      _pocToast('personalOntology.po2_value_saved', '已记下', 'success');
    }
    await _pocReloadPo();
  }

  /** 编辑一条值：文本 + 时间锚三态 + 规则分类。 */
  async function _pocEditValuePromptV2(gid, valueId) {
    const group = _pocPoGroupById(gid);
    const value = group && (group.values || []).find((v) => v.id === valueId);
    if (!value) return;
    const field = (group.fields || []).find((f) => f.id === value.fieldId);
    const textId = 'po2-edit-text';
    const asOfId = 'po2-edit-asof';
    const kindId = 'po2-edit-kind';
    const ruleShaped = _pocRuleShaped(field, value);
    const kindOptions = [
      { value: '', label: _t('personalOntology.po2_kind_none_short', '未分类') },
      { value: 'operation', label: _t('personalOntology.rulekind_operation', '操作规则') },
      { value: 'preference', label: _t('personalOntology.rulekind_preference', '偏好') },
      { value: 'constraint', label: _t('personalOntology.rulekind_constraint', '约束') },
    ];
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_edit_value_title', '编辑这条内容'),
      bodyHtml: `
        ${_pocFieldTextarea(textId, _t('personalOntology.po2_value_label', '内容'), value.text, { rows: 3 })}
        ${ruleShaped ? _pocFieldSelect(kindId, _t('personalOntology.po2_rule_kind_title', '规则分类'), kindOptions, value.ruleKind || '') : ''}
        ${_pocFieldText(asOfId, _t('personalOntology.po2_asof_label', '信息截至时间（可选）'), value.asOf || '', { placeholder: 'YYYY-MM', hint: _t('personalOntology.po2_asof_edit_hint', '清空并保存 = 删除时间标注；不动 = 保留') })}`,
    });
    if (!dialog || dialog.value !== 'save') return;
    const text = String((document.getElementById(textId) || {}).value || '').trim();
    const asOf = String((document.getElementById(asOfId) || {}).value || '').trim();
    const kind = String((document.getElementById(kindId) || {}).value || '').trim();
    if (!text) {
      _pocToast('personalOntology.po2_value_empty_error', '内容不能为空', 'error');
      return;
    }
    if (asOf && !/^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/.test(asOf)) {
      _pocToast('personalOntology.asof_invalid_error', '时间格式应为 YYYY-MM（如 2026-09）', 'error');
      return;
    }
    const patch = { text };
    if (ruleShaped) patch.ruleKind = kind || null;
    if (asOf !== (value.asOf || '')) {
      if (asOf) patch.asOf = asOf;
      else patch.clearAsOf = true;
    }
    const res = await _pocInvoke('po.values.update', { groupId: gid, valueId, patch });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    _pocToast('personalOntology.field_value_updated', '已更新');
    await _pocReloadPo();
  }

  async function _pocDeleteValueConfirmV2(gid, valueId) {
    const confirmed = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({
        title: _t('common.delete', '删除'),
        message: _t('personalOntology.po2_delete_value_confirm', '删除这条内容？'),
        dangerLabel: _t('common.delete', '删除'),
      })
      : false;
    if (!confirmed) return;
    const res = await _pocInvoke('po.values.delete', { groupId: gid, valueId });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocSetValueKindV2(gid, valueId, kind) {
    const res = await _pocInvoke('po.values.update', { groupId: gid, valueId, patch: { ruleKind: kind === 'none' ? null : kind } });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocToggleValueRestrictedV2(gid, valueId) {
    const group = _pocPoGroupById(gid);
    const value = group && (group.values || []).find((v) => v.id === valueId);
    if (!value) return;
    const res = await _pocInvoke('po.values.update', { groupId: gid, valueId, patch: { sensitivity: value.restricted ? 'standard' : 'restricted' } });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocSetValueVerifiedV2(gid, valueId, level) {
    const res = await _pocInvoke('po.values.update', { groupId: gid, valueId, patch: { verified: level } });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  // ── 流水操作 ────────────────────────────────────────────────────────────

  async function _pocAddEntryPromptV2(gid, section) {
    const id = 'po2-entry-text';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_add_entry', '记一笔'),
      bodyHtml: _pocFieldTextarea(id, _t('personalOntology.po2_entry_label', '随手记'), '', { rows: 3, hint: _t('personalOntology.po2_entry_hint', '先记下来；之后可以「转正为字段」') }),
    });
    if (!dialog || dialog.value !== 'save') return;
    const text = String((document.getElementById(id) || {}).value || '').trim();
    if (!text) return;
    const res = await _pocInvoke('po.entries.add', { groupId: gid, text, ...(section ? { section } : {}) });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocDeleteEntryV2(gid, entryId) {
    const res = await _pocInvoke('po.entries.delete', { groupId: gid, entryId });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  async function _pocPromoteEntryPromptV2(gid, entryId) {
    const group = _pocPoGroupById(gid);
    const entry = group && (group.entries || []).find((e) => e.id === entryId);
    if (!entry) return;
    const id = 'po2-promote-field';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_entry_promote', '转正为字段'),
      bodyHtml: _pocFieldText(id, _t('personalOntology.po2_field_name_label', '字段名'), '', { placeholder: _t('personalOntology.po2_field_name_placeholder', '如：常用工具') }),
    });
    if (!dialog || dialog.value !== 'save') return;
    const fieldName = String((document.getElementById(id) || {}).value || '').trim();
    if (!fieldName) return;
    const res = await _pocInvoke('po.entries.promote', { groupId: gid, entryId, fieldName });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    _pocToast('personalOntology.po2_entry_promoted', '已转正为字段值', 'success');
    await _pocReloadPo();
  }

  // ── 历史 / 恢复 ─────────────────────────────────────────────────────────

  function _pocHistoryAuditHtml(audit) {
    if (!audit) return '';
    const parts = [` ${_t('personalOntology.po2_audit_action', '动作')}: ${escapeHtml(audit.action)}`];
    if (audit.field) parts.push(` · ${escapeHtml(audit.field)}`);
    if (audit.beforeSummary) parts.push(` · ${escapeHtml(_pocTextSnippet(audit.beforeSummary, 40))} → ${escapeHtml(_pocTextSnippet(audit.afterSummary || '', 40))}`);
    return `<div class="po2-history-audit muted">${parts.join('')}</div>`;
  }

  async function _pocShowGroupHistoryV2(gid) {
    const res = await _pocInvoke('po.history.list', { groupId: gid });
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    const history = res && Array.isArray(res.history) ? res.history : [];
    const group = _pocPoGroupById(gid);
    if (!history.length) {
      _pocToast('personalOntology.po2_history_empty', '这个分组还没有历史版本', 'info');
      return;
    }
    const rows = history.map((entry) => `<div class="po2-history-row">
      <div class="po2-history-main">
        <span class="po2-history-time">${escapeHtml(entry.savedAt)}</span>
        <span class="muted">${escapeHtml(_tv('personalOntology.po2_history_bytes', { n: entry.bytes }, '{n} 字节'))}</span>
        <span class="po2-history-preview muted">${escapeHtml(entry.preview || '')}</span>
        ${_pocHistoryAuditHtml(entry.audit)}
      </div>
      ${_button({ label: _t('personalOntology.po2_history_restore', '恢复到这版'), size: 'xs', className: 'o', attrs: { 'data-poc-history-restore': entry.id, 'data-poc-gid': gid } })}
    </div>`).join('');
    const dialog = await _pocModalForm({
      title: _tv('personalOntology.po2_history_title', { title: (group && group.title) || '' }, '「{title}」的历史版本'),
      bodyHtml: `<div class="po2-history-list">${rows}</div>`,
      actions: [{ label: _t('common.close', '关闭'), id: 'close', role: 'secondary' }],
    });
    void dialog;
  }

  async function _pocRestoreHistoryV2(el, gid, snapshotId) {
    const res = await _pocRunOnce(`po-history-restore:${gid}:${snapshotId}`, el, () => _pocInvoke('po.history.restore', { groupId: gid, snapshotId }));
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    _pocToast('personalOntology.po2_history_restored', '已恢复到该版本', 'success');
    await _pocReloadPo();
  }

  // ── 候选确认 / 跳过 ─────────────────────────────────────────────────────

  async function _pocConfirmCandidateV2(candidateId) {
    const candidate = _pocPendingCandidates.find((c) => c && c.candidate_id === candidateId);
    if (!candidate) return;
    const dests = _pocDestinationOptions();
    if (!dests.length) {
      _pocToast('personalOntology.po2_need_group_first', '先到「分组与模板」建一个分组', 'error');
      return;
    }
    const gid = dests[0].value;
    const groupSelectId = 'po2-candidate-group';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_candidate_accept', '收下这条建议'),
      bodyHtml: `
        <div class="po2-candidate-preview">${escapeHtml(_pocTextSnippet(candidate.memory_text || candidate.summary || '', 240))}</div>
        ${_pocFieldSelect(groupSelectId, _t('personalOntology.po2_dest_group', '写进哪个分组'), dests, gid, { hint: _t('personalOntology.po2_candidate_dest_hint', 'AI 会按内容挑最合适的字段落位；落不进字段的先进流水') })}`,
    });
    if (!dialog || dialog.value !== 'save') return;
    const nextGid = String((document.getElementById(groupSelectId) || {}).value || '');
    if (!nextGid) return;
    const res = await _pocInvoke('po.candidates.confirm', { candidateId, dest: { toGlobalMemory: false, toGroupIds: [nextGid] } });
    if (!res || res.ok === false) {
      if (res && res.error === 'conflict_detected') {
        const ack = typeof uiConfirm === 'function' && await uiConfirm({ message: _t('personalOntology.po2_candidate_conflict', '这条内容与已有内容疑似矛盾。仍要写入吗？') });
        if (ack) {
          const retry = await _pocInvoke('po.candidates.confirm', { candidateId, dest: { toGlobalMemory: false, toGroupIds: [nextGid] }, acknowledgeConflict: true });
          if (retry && retry.ok !== false) {
            _pocToast('personalOntology.po2_candidate_accepted', '已收下', 'success');
            await _pocReloadPo();
          } else {
            _pocToast('personalOntology.op_failed', _pocOperationErrorText(retry && retry.error), 'error');
          }
        }
        return;
      }
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    _pocToast('personalOntology.po2_candidate_accepted', '已收下', 'success');
    await _pocReloadPo();
  }

  async function _pocRejectCandidateV2(candidateId, el) {
    const res = await _pocRunOnce(`po-candidate-reject:${candidateId}`, el, () => _pocInvoke('po.candidates.reject', { candidateId }));
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    await _pocReloadPo();
  }

  // ── 导出 / 导入（个人本体自己的 markdown，可回灌）────────────────────────

  async function _pocOpenExportModal() {
    const res = await _pocInvoke('po.data.export', {});
    if (!res || res.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(res && res.error), 'error');
      return;
    }
    const markdown = res && res.markdown ? String(res.markdown) : '';
    const id = 'po2-export-text';
    await _pocModalForm({
      title: _t('personalOntology.po2_export_title', '导出个人本体'),
      bodyHtml: `${_pocFieldTextarea(id, _t('personalOntology.po2_export_hint', '全文可复制保存；之后可原样导入回灌'), markdown, { rows: 12 })}`,
      actions: [{ label: _t('common.close', '关闭'), id: 'close', role: 'secondary' }],
    });
  }

  async function _pocOpenImportModal() {
    const id = 'po2-import-text';
    const dialog = await _pocModalForm({
      title: _t('personalOntology.po2_import_title', '导入个人本体'),
      bodyHtml: `${_pocFieldTextarea(id, _t('personalOntology.po2_import_hint', '粘贴导出的文本（或「## 分组名」组织的任意清单）'), '', { rows: 10 })}`,
    });
    if (!dialog || dialog.value !== 'save') return;
    const text = String((document.getElementById(id) || {}).value || '');
    if (!text.trim()) return;
    const preview = await _pocInvoke('po.data.importPreview', { text });
    if (!preview || preview.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(preview && preview.error), 'error');
      return;
    }
    if (!Array.isArray(preview.items) || !preview.items.length) {
      _pocToast('personalOntology.po2_import_nothing', '没有解析出可导入的内容', 'error');
      return;
    }
    const listHtml = preview.items.map((item) => `<div class="po2-import-item">
      <strong>${escapeHtml(item.title)}</strong>
      <span class="muted">${escapeHtml(_tv('personalOntology.po2_import_item_meta', { fields: (item.fields || []).length, values: (item.fields || []).reduce((n, f) => n + (f.values || []).length, 0), entries: (item.entries || []).length }, '{values} 条值 · {entries} 条流水'))}</span>
      ${item.mergeIntoExisting ? _tag(_t('personalOntology.po2_import_merge', '并入同名分组')) : ''}
    </div>`).join('');
    const confirmDialog = await _pocModalForm({
      title: _t('personalOntology.po2_import_preview_title', '确认导入'),
      bodyHtml: `<div class="po2-import-list">${listHtml}</div>`,
    });
    if (!confirmDialog || confirmDialog.value !== 'save') return;
    const applied = await _pocInvoke('po.data.importApply', { items: preview.items });
    if (!applied || applied.ok === false) {
      _pocToast('personalOntology.op_failed', _pocOperationErrorText(applied && applied.error), 'error');
      return;
    }
    _pocToast('personalOntology.po2_import_done', `已导入 ${applied.applied} 条`, 'success');
    await _pocReloadPo();
  }

  function _pocGraphInputField(id, label, value, options = {}) {
    return window.uiField({
      id,
      label,
      required: Boolean(options.required),
      hint: options.hint || '',
      showRequirement: options.showRequirement,
      control: {
        kind: 'input',
        type: options.type || 'text',
        value: value == null ? '' : String(value),
        placeholder: options.placeholder || '',
      },
    });
  }

  function _pocGraphTextareaField(id, label, value, options = {}) {
    return window.uiField({
      id,
      label,
      required: Boolean(options.required),
      hint: options.hint || '',
      showRequirement: options.showRequirement,
      control: {
        kind: 'textarea',
        value: value == null ? '' : String(value),
        placeholder: options.placeholder || '',
        rows: options.rows || 3,
      },
    });
  }

  function _pocGraphSelectField(id, label, options, value, placeholder) {
    return window.uiField({
      id,
      label,
      control: {
        kind: 'select',
        value: value || '',
        placeholder: placeholder || _t('ontologyGraph.select_placeholder', '请选择'),
        options,
        searchable: options.length > 8,
        searchPlaceholder: _t('ontologyGraph.search_placeholder', '搜索'),
      },
    });
  }

  function _pocGraphSourcePickerHtml(existingRefs = []) {
    const refs = Array.isArray(existingRefs) ? existingRefs : [];
    const existingKeys = new Set(refs.map((ref) => `${ref.kind}:${ref.id}`));
    const assets = (_pocBoxData.sourceAssets || []).slice(0, 48);
    const candidates = (_pocPendingCandidates || []).slice(0, Math.max(0, 64 - assets.length));
    const availableKeys = new Set([
      ...assets.map((asset) => `asset:${asset.id}`),
      ...candidates.map((candidate) => `candidate:${candidate.candidate_id || candidate.id}`),
    ]);
    const retainedMissing = refs.filter((ref) => !availableKeys.has(`${ref.kind}:${ref.id}`));
    const choices = [
      ...assets.map((asset) => {
        const id = String(asset.id || '');
        const title = _pocTextSnippet(asset.title || asset.statement, 100) || _t('ontologyGraph.source_asset', '正式认知资产');
        return window.uiCheckbox({
          id: `ontology-source-asset-${id}`,
          label: `${_t('ontologyGraph.source_asset_kind', '认知资产')} · ${title}`,
          checked: existingKeys.has(`asset:${id}`),
          attrs: { 'data-ontology-source-kind': 'asset', 'data-ontology-source-id': id },
        });
      }),
      ...candidates.map((candidate) => {
        const id = String(candidate.candidate_id || candidate.id || '');
        const title = _pocTextSnippet(candidate.summary, 100) || _t('ontologyGraph.source_candidate', '审核候选');
        return window.uiCheckbox({
          id: `ontology-source-candidate-${id}`,
          label: `${_t('ontologyGraph.source_candidate_kind', '审核候选')} · ${title}`,
          checked: existingKeys.has(`candidate:${id}`),
          attrs: { 'data-ontology-source-kind': 'candidate', 'data-ontology-source-id': id },
        });
      }),
      ...retainedMissing.map((sourceRef, index) => window.uiCheckbox({
        id: `ontology-source-unavailable-${sourceRef.kind}-${index}`,
        label: sourceRef.kind === 'asset'
          ? _t('ontologyGraph.source_asset_unavailable_keep', '来源资产当前不可见（取消勾选可移除此引用）')
          : _t('ontologyGraph.source_candidate_unavailable_keep', '来源候选当前不可见（取消勾选可移除此引用）'),
        checked: true,
        attrs: { 'data-ontology-source-kind': sourceRef.kind, 'data-ontology-source-id': sourceRef.id },
      })),
    ];
    return `<section class="personal-onto-graph-source-picker">
      <div class="personal-onto-graph-section-label">${escapeHtml(_t('ontologyGraph.source_refs', '来源引用'))}</div>
      <p class="muted">${escapeHtml(_t('ontologyGraph.source_refs_hint', '只保存来源 ID；来源正文继续由原资产或候选管理。'))}</p>
      <div class="personal-onto-graph-source-options">${choices.join('') || `<span class="muted">${escapeHtml(_t('ontologyGraph.no_sources', '当前没有可关联的来源条目'))}</span>`}</div>
    </section>`;
  }

  async function _pocGraphFormModal(options) {
    if (typeof window.uiModal !== 'function' || typeof window.uiForm !== 'function' || typeof window.uiField !== 'function') {
      _pocToast('personalOntology.op_failed', _t('ontologyGraph.modal_unavailable', '编辑表单暂不可用'), 'error');
      return null;
    }
    let selectedValues = Object.assign({}, options.selectDefaults || {});
    let submitted = null;
    const modal = window.uiModal({
      title: options.title,
      description: options.description || '',
      closeLabel: _t('common.close', '关闭'),
      size: 'lg',
      bodyHtml: window.uiForm({ ariaLabel: options.title, fields: options.fields }),
      actions: [
        { id: 'cancel', label: _t('common.cancel', '取消'), role: 'secondary' },
        { id: 'save', label: _t('common.save', '保存'), role: 'primary' },
      ],
    });
    if (options.selectCallbacks && typeof window.hydrateUiFormSelects === 'function') {
      window.hydrateUiFormSelects(modal.overlay, Object.fromEntries(Object.entries(options.selectCallbacks).map(([id, callback]) => [
        id,
        (value) => {
          selectedValues[id] = value;
          callback?.(value);
        },
      ])));
    }
    modal.overlay.addEventListener('submit', (event) => event.preventDefault());
    modal.overlay.addEventListener('click', (event) => {
      const action = event.target && event.target.closest && event.target.closest('[data-ui-modal-action="save"]');
      if (!action) return;
      const form = modal.overlay.querySelector('.ui-modal__body form');
      if (form && !form.checkValidity()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        form.reportValidity?.();
        return;
      }
      try {
        submitted = options.collect(modal.overlay, selectedValues);
      } catch (error) {
        event.preventDefault();
        event.stopImmediatePropagation();
        _pocToast('personalOntology.op_failed', _pocGraphErrorText((error && error.message) || error), 'error');
      }
    }, true);
    const result = await modal;
    return result && result.value === 'save' ? submitted : null;
  }

  function _pocGraphErrorText(error) {
    const key = {
      'ontology category already exists': ['ontologyGraph.error_category_duplicate', '同级分类已存在'],
      'ontology category contains entities': ['ontologyGraph.error_category_has_entities', '分类下还有实体，请先移动或删除这些实体'],
      'ontology category contains child categories': ['ontologyGraph.error_category_has_children', '分类下还有子分类，请先调整分类层级'],
      'ontology category field is used by entities': ['ontologyGraph.error_field_in_use', '字段仍被实体使用，不能删除或更名'],
      'ontology entity has relationships': ['ontologyGraph.error_entity_has_relations', '实体仍有关联关系，请先删除相关关系'],
      'ontology relation already exists': ['ontologyGraph.error_relation_duplicate', '这条关系已经存在'],
      'ontology relation endpoint is archived': ['ontologyGraph.error_archived_endpoint', '已归档实体不能建立新关系'],
      'ontology relation endpoint not found': ['ontologyGraph.error_endpoint_missing', '关系的一端已不存在'],
      'ontology entity category is unavailable': ['ontologyGraph.error_category_missing', '所选分类不可用'],
    }[String(error || '')];
    return key ? _t(key[0], key[1]) : _t('ontologyGraph.error_generic', '保存失败，请检查填写内容后重试');
  }

  function _pocCollectSourceRefs(root, existingRefs = []) {
    const choices = Array.from(root.querySelectorAll('[data-ontology-source-kind][data-ontology-source-id]'));
    const available = new Set(choices.map((input) => `${input.getAttribute('data-ontology-source-kind')}:${input.getAttribute('data-ontology-source-id')}`));
    const out = existingRefs.filter((ref) => !available.has(`${ref.kind}:${ref.id}`));
    choices.forEach((input) => {
      if (!input.checked) return;
      out.push({ kind: input.getAttribute('data-ontology-source-kind'), id: input.getAttribute('data-ontology-source-id') });
    });
    const seen = new Set();
    return out.filter((ref) => {
      const key = `${ref.kind}:${ref.id}`;
      if (!ref.kind || !ref.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function _pocGraphMutation(channel, payload, successKey, fallback) {
    const result = await _pocInvoke(channel, payload);
    if (!result || result.ok === false) {
      _pocToast('personalOntology.op_failed', _pocGraphErrorText((result && result.error) || ''), 'error');
      return false;
    }
    await _pocReloadBoxData();
    _pocToast(successKey || 'ontologyGraph.saved', fallback || _t('ontologyGraph.saved', '已保存'), 'success');
    return true;
  }

  function _pocCategoryDescendants(categoryId, domain) {
    const categories = _pocGraphCategories(domain);
    const descendants = new Set([categoryId]);
    let changed = true;
    while (changed) {
      changed = false;
      categories.forEach((category) => {
        if (category.parentId && descendants.has(category.parentId) && !descendants.has(category.id)) {
          descendants.add(category.id);
          changed = true;
        }
      });
    }
    return descendants;
  }

  async function _pocOpenGraphCategoryForm(domain, category) {
    const existing = category || null;
    const categories = _pocGraphCategories(domain).filter((item) => (
      !existing || ! _pocCategoryDescendants(existing.id, domain).has(item.id)
    ));
    const parentId = existing ? (existing.parentId || '') : '';
    const parentOptions = [
      { value: '', label: _t('ontologyGraph.category_root', '顶层分类') },
      ...categories.map((item) => ({ value: item.id, label: _pocGraphCategoryLabel(item) })),
    ];
    const fields = [
      _pocGraphInputField('ontology-category-name', _t('ontologyGraph.category_name', '分类名称'), existing ? existing.name : '', { required: true }),
      _pocGraphTextareaField('ontology-category-description', _t('ontologyGraph.category_description', '分类说明'), existing ? existing.description : ''),
      _pocGraphSelectField('ontology-category-parent', _t('ontologyGraph.category_parent', '上级分类'), parentOptions, parentId, _t('ontologyGraph.category_root', '顶层分类')),
      ...(existing ? existing.fields.map((field) => `<div class="personal-onto-category-field-edit-row">
        ${_pocGraphInputField(`ontology-category-field-${field.id}`, _t('ontologyGraph.field_name', '字段名称'), field.name, { required: true })}
        ${window.uiCheckbox({ id: `ontology-category-field-remove-${field.id}`, label: _t('ontologyGraph.field_remove', '删除此字段'), attrs: { 'data-ontology-category-field-remove': field.id } })}
      </div>`) : []),
      _pocGraphTextareaField('ontology-category-new-fields', _t('ontologyGraph.category_new_fields', '新增字段'), '', { hint: _t('ontologyGraph.category_new_fields_hint', '每行填写一个字段名称。') }),
    ];
    const parentState = { 'ontology-category-parent': parentId };
    const submitted = await _pocGraphFormModal({
      title: existing ? _t('ontologyGraph.category_edit', '编辑分类') : _t('ontologyGraph.category_new', '新建分类'),
      description: _t('ontologyGraph.category_form_hint', '分类定义实体的类型和可填写字段；已有实体使用的字段不能直接删除。'),
      fields,
      selectDefaults: parentState,
      selectCallbacks: { 'ontology-category-parent': (value) => { parentState['ontology-category-parent'] = value; } },
      collect: (root) => {
        const newFields = String(root.querySelector('#ontology-category-new-fields')?.value || '')
          .split(/[\n,，]/).map((name) => name.trim()).filter(Boolean).map((name) => ({ name }));
        const retainedFields = existing ? existing.fields.reduce((out, field) => {
          const remove = root.querySelector(`[data-ontology-category-field-remove="${CSS.escape(field.id)}"]`);
          if (remove && remove.checked) return out;
          const input = root.querySelector(`#ontology-category-field-${CSS.escape(field.id)}`);
          out.push({ id: field.id, name: String((input && input.value) || '').trim(), kind: field.kind });
          return out;
        }, []) : [];
        return {
          name: String(root.querySelector('#ontology-category-name')?.value || '').trim(),
          description: String(root.querySelector('#ontology-category-description')?.value || '').trim(),
          parentId: parentState['ontology-category-parent'] || '',
          fields: [...retainedFields, ...newFields],
        };
      },
    });
    if (!submitted) return;
    const channel = existing ? 'ontology.category.update' : 'ontology.category.create';
    await _pocGraphMutation(channel, {
      ...(existing ? { categoryId: existing.id } : { domain }),
      ...submitted,
    }, 'ontologyGraph.category_saved', _t('ontologyGraph.category_saved', '分类已保存'));
  }

  async function _pocDeleteGraphCategory(category) {
    if (!category || category.builtIn) return;
    const message = _t('ontologyGraph.category_delete_confirm', '删除分类不会删除实体；如果分类仍被实体或子分类使用，系统会阻止删除。');
    const confirmed = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({ title: _t('ontologyGraph.category_delete', '删除分类'), message, dangerLabel: _t('ontologyGraph.category_delete', '删除分类') })
      : typeof uiConfirm === 'function' ? await uiConfirm({ message }) : false;
    if (!confirmed) return;
    await _pocGraphMutation('ontology.category.delete', { categoryId: category.id }, 'ontologyGraph.category_deleted', _t('ontologyGraph.category_deleted', '分类已删除'));
  }

  async function _pocOpenGraphEntityForm(domain, category, entity) {
    const existing = entity || null;
    const currentCategory = existing
      ? _pocGraphCategories(existing.domain).find((item) => item.id === existing.categoryId)
      : category;
    if (!currentCategory) {
      _pocToast('personalOntology.op_failed', _t('ontologyGraph.category_missing', '请先选择一个分类'), 'error');
      return;
    }
    const fields = [
      _pocGraphInputField('ontology-entity-name', _t('ontologyGraph.entity_name', '实体名称'), existing ? existing.name : '', { required: true }),
      _pocGraphTextareaField('ontology-entity-description', _t('ontologyGraph.entity_description', '说明'), existing ? existing.description : ''),
      `<div class="personal-onto-graph-selected-category">${_tag(_pocGraphCategoryLabel(currentCategory))}</div>`,
      ...(currentCategory.fields || []).map((field) => _pocGraphInputField(
        `ontology-entity-property-${field.id}`,
        _pocGraphFieldLabel(field),
        existing && existing.properties ? existing.properties[field.id] : '',
        { type: field.kind },
      )),
      _pocGraphSourcePickerHtml(existing ? existing.sourceRefs : []),
    ];
    const submitted = await _pocGraphFormModal({
      title: existing ? _t('ontologyGraph.entity_edit', '编辑实体') : _t('ontologyGraph.entity_new', '新建实体'),
      description: _tv('ontologyGraph.entity_form_hint', { domain: _pocGraphDomainLabel(currentCategory.domain) }, '填写实体自己的信息；个人资料和正式认知资产只通过来源引用关联，不复制正文。'),
      fields,
      collect: (root) => {
        const properties = {};
        (currentCategory.fields || []).forEach((field) => {
          const input = root.querySelector(`#ontology-entity-property-${CSS.escape(field.id)}`);
          const value = String((input && input.value) || '').trim();
          if (value) properties[field.id] = value;
        });
        return {
          name: String(root.querySelector('#ontology-entity-name')?.value || '').trim(),
          description: String(root.querySelector('#ontology-entity-description')?.value || '').trim(),
          properties,
          sourceRefs: _pocCollectSourceRefs(root, existing ? existing.sourceRefs : []),
        };
      },
    });
    if (!submitted) return;
    await _pocGraphMutation(existing ? 'ontology.entity.update' : 'ontology.entity.create', {
      ...(existing ? { entityId: existing.id } : { categoryId: currentCategory.id }),
      ...submitted,
    }, 'ontologyGraph.entity_saved', _t('ontologyGraph.entity_saved', '实体已保存'));
  }

  async function _pocDeleteGraphEntity(entity) {
    if (!entity) return;
    const message = _t('ontologyGraph.entity_delete_confirm', '删除实体前需先移除它参与的关系；来源资产和候选不会受影响。');
    const confirmed = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({ title: _t('ontologyGraph.entity_delete', '删除实体'), message, dangerLabel: _t('ontologyGraph.entity_delete', '删除实体') })
      : typeof uiConfirm === 'function' ? await uiConfirm({ message }) : false;
    if (!confirmed) return;
    await _pocGraphMutation('ontology.entity.delete', { entityId: entity.id }, 'ontologyGraph.entity_deleted', _t('ontologyGraph.entity_deleted', '实体已删除'));
  }

  async function _pocToggleGraphEntityStatus(entity) {
    if (!entity) return;
    const status = entity.status === 'archived' ? 'active' : 'archived';
    await _pocGraphMutation('ontology.entity.update', {
      entityId: entity.id,
      status,
    }, 'ontologyGraph.entity_status_saved', status === 'archived' ? _t('ontologyGraph.entity_archived_toast', '实体已归档') : _t('ontologyGraph.entity_restored_toast', '实体已恢复'));
  }

  function _pocRelationSelectOptions(includeArchived = false) {
    const entities = _pocGraphEntities().filter((entity) => includeArchived || entity.status === 'active');
    return [
      { value: 'self', label: _t('ontologyGraph.self_entity', '我') },
      ...entities.map((entity) => {
        const category = _pocGraphCategories(entity.domain).find((item) => item.id === entity.categoryId);
        return { value: entity.id, label: `${_pocGraphDomainLabel(entity.domain)} · ${_pocGraphCategoryLabel(category)} · ${entity.name}${entity.status === 'archived' ? ` · ${_t('ontologyGraph.entity_archived', '已归档')}` : ''}` };
      }),
    ];
  }

  async function _pocOpenGraphRelationForm(relation, initialSubject) {
    const existing = relation || null;
    const options = _pocRelationSelectOptions(Boolean(existing));
    const toSelectValue = (endpoint) => endpoint && endpoint.kind === 'entity' ? endpoint.id : 'self';
    const defaultObject = initialSubject && initialSubject !== 'self'
      ? 'self'
      : (_pocGraphEntities().find((entity) => entity.status === 'active')?.id || 'self');
    const selectState = {
      'ontology-relation-subject': existing ? toSelectValue(existing.subject) : initialSubject || 'self',
      'ontology-relation-object': existing ? toSelectValue(existing.object) : defaultObject,
    };
    const fields = [
      _pocGraphSelectField('ontology-relation-subject', _t('ontologyGraph.relation_subject', '起点'), options, selectState['ontology-relation-subject']),
      _pocGraphInputField('ontology-relation-predicate', _t('ontologyGraph.relation_predicate', '关系名称'), existing ? existing.predicate : '', { required: true, placeholder: _t('ontologyGraph.relation_predicate_placeholder', '例如：负责、包含、依赖') }),
      _pocGraphSelectField('ontology-relation-object', _t('ontologyGraph.relation_object', '终点'), options, selectState['ontology-relation-object']),
      _pocGraphTextareaField('ontology-relation-note', _t('ontologyGraph.relation_note', '关系说明'), existing ? existing.note : ''),
      _pocGraphSourcePickerHtml(existing ? existing.sourceRefs : []),
    ];
    const submitted = await _pocGraphFormModal({
      title: existing ? _t('ontologyGraph.relation_edit', '编辑关系') : _t('ontologyGraph.relation_new', '新建关系'),
      description: _t('ontologyGraph.relation_form_hint', '选择关系两端并填写关系名称。引用只保存来源 ID，不复制个人资料或资产正文。'),
      fields,
      selectDefaults: selectState,
      selectCallbacks: {
        'ontology-relation-subject': (value) => { selectState['ontology-relation-subject'] = value; },
        'ontology-relation-object': (value) => { selectState['ontology-relation-object'] = value; },
      },
      collect: (root, selected) => {
        const toEndpoint = (value) => value === 'self' ? { kind: 'self' } : { kind: 'entity', id: String(value || '') };
        return {
          subject: toEndpoint(selected['ontology-relation-subject']),
          predicate: String(root.querySelector('#ontology-relation-predicate')?.value || '').trim(),
          object: toEndpoint(selected['ontology-relation-object']),
          note: String(root.querySelector('#ontology-relation-note')?.value || '').trim(),
          sourceRefs: _pocCollectSourceRefs(root, existing ? existing.sourceRefs : []),
        };
      },
    });
    if (!submitted) return;
    await _pocGraphMutation(existing ? 'ontology.relation.update' : 'ontology.relation.create', {
      ...(existing ? { relationId: existing.id } : {}),
      ...submitted,
    }, 'ontologyGraph.relation_saved', _t('ontologyGraph.relation_saved', '关系已保存'));
  }

  async function _pocDeleteGraphRelation(relationId) {
    if (!relationId) return;
    const message = _t('ontologyGraph.relation_delete_confirm', '只删除这条关系，不删除关系两端的实体或来源条目。');
    const confirmed = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({ title: _t('ontologyGraph.relation_delete', '删除关系'), message, dangerLabel: _t('ontologyGraph.relation_delete', '删除关系') })
      : typeof uiConfirm === 'function' ? await uiConfirm({ message }) : false;
    if (!confirmed) return;
    await _pocGraphMutation('ontology.relation.delete', { relationId }, 'ontologyGraph.relation_deleted', _t('ontologyGraph.relation_deleted', '关系已删除'));
  }

  function _pocRenderOntologyOverview() {
    const counts = _pocBoxCounts();
    const facts = _pocAffairAssets();
    const relations = _pocRelationRows();
    const graph = _pocOntologyGraph();
    const graphEntities = graph.entities || [];
    const affairs = graphEntities.filter((entity) => entity.domain === 'affairs' && entity.status === 'active');
    const resources = graphEntities.filter((entity) => entity.domain === 'resources' && entity.status === 'active');
    const concepts = graphEntities.filter((entity) => entity.domain === 'concepts' && entity.status === 'active');
    const graphFields = (graph.categories || []).reduce((count, category) => count + (category.fields || []).length, 0);
    const personalFields = (_pocBoxData.groups || []).reduce((count, group) => count + (group.fields || []).length, 0);
    const graphErrorStatus = graph.loadError ? _t('ontologyGraph.load_error_short', '读取失败') : '';
    const explicitRelations = relations.filter((row) => row.relationKind !== 'same_family');
    const sameSourceRelations = relations.filter((row) => row.relationKind === 'same_family');
    if (typeof window.uiResourceGrid !== 'function' || typeof window.uiResourceCard !== 'function') {
      throw new Error('personal ontology requires uiResourceGrid and uiResourceCard');
    }
    const card = (titleKey, title, descriptionKey, description, icon, count, unit, action, meta, statusOverride) => window.uiResourceCard({
      title: _t(titleKey, title),
      description: _t(descriptionKey, description),
      icon,
      status: statusOverride || _tv('personalOntology.overview_count', { n: count, unit }, `${count} ${unit}`),
      className: 'personal-onto-domain-card',
      bodyHtml: `<div class="personal-onto-domain-card-meta"><span>${escapeHtml(meta || _t('personalOntology.overview_data_source', '按当前已有数据展示'))}</span></div>`,
      action: {
        label: _t('personalOntology.overview_open', '进入查看'),
        role: 'secondary',
        size: 'sm',
        attrs: { 'data-poc-domain-action': action },
      },
    });
    const cards = [
      card('personalOntology.nav_personal_domain', '个人本体', 'personalOntology.overview_personal_hint', '整理身份、偏好、方法与个人关系', '', counts.abox, _t('personalOntology.count_items', '条'), 'personal-domain'),
      card('personalOntology.nav_affairs_domain', '事项本体', 'personalOntology.overview_affairs_hint', '浏览项目、任务、事件与相关事实', '', affairs.length + facts.length, _t('personalOntology.count_items', '条'), 'affairs-domain', _tv('ontologyGraph.overview_mix_counts', { entities: affairs.length, facts: facts.length }, `${affairs.length} 个事项 · ${facts.length} 条事实`), graphErrorStatus),
      card('personalOntology.nav_resources_domain', '对象与资源', 'personalOntology.overview_resources_hint', '整理人物、组织、工具、产品与资料', '', resources.length, _t('personalOntology.count_entities', '个实体'), 'resources-domain', _t('personalOntology.overview_data_source', '按当前已有数据展示'), graphErrorStatus),
      card('personalOntology.nav_concepts_domain', '概念本体', 'personalOntology.overview_concepts_hint', '整理术语、方法与规则等概念', '', concepts.length, _t('personalOntology.count_entities', '个实体'), 'concepts-domain', _t('personalOntology.overview_data_source', '按当前已有数据展示'), graphErrorStatus),
      card('personalOntology.nav_taxonomy_domain', '分类与字段', 'personalOntology.overview_taxonomy_hint', '查看事项、资源、概念与个人本体分类', '', (graph.categories || []).length + _pocGroups.list.length, _t('personalOntology.count_categories', '个分类'), 'taxonomy-domain', _tv('personalOntology.overview_count', { n: graphFields + personalFields, unit: _t('personalOntology.count_fields', '个字段') }, `${graphFields + personalFields} 个字段`), graphErrorStatus),
      card('personalOntology.nav_relationships_domain', '关系网络', 'personalOntology.overview_relationships_hint', '查看已保存的明确关系', '', explicitRelations.length, _t('personalOntology.count_relations', '条关系'), 'relationships-domain', _tv('personalOntology.overview_relationships_meta', { relations: explicitRelations.length, groups: sameSourceRelations.length }, `${explicitRelations.length} 条明确关系 · ${sameSourceRelations.length} 组同来源`), graphErrorStatus),
    ];
    const graphError = graph.loadError
      ? `<p class="personal-onto-domain-error" role="alert">${escapeHtml(_t('ontologyGraph.load_error', '本体图谱读取失败'))}：${escapeHtml(_pocGraphErrorText(graph.loadError))}</p>`
      : '';
    return `<div class="personal-onto-overview">
      <div class="personal-onto-overview-intro">${escapeHtml(_t('personalOntology.overview_hint', '本体把关于你、正在处理的事情、分类和它们之间的关系整理在同一个知识地图里。'))}</div>
      ${window.uiResourceGrid({ className: 'personal-onto-domain-grid', bodyHtml: cards.join('') })}
      ${graphError}
      <p class="personal-onto-overview-note">${escapeHtml(_t('personalOntology.overview_truth_note', '条目数量来自当前已保存的数据；没有明确分类或关系的内容不会被系统猜测。'))}</p>
    </div>`;
  }

  function _pocEntityRelationCount(entityId) {
    return (_pocOntologyGraph().relations || []).filter((relation) => (
      (relation.subject && relation.subject.kind === 'entity' && relation.subject.id === entityId)
      || (relation.object && relation.object.kind === 'entity' && relation.object.id === entityId)
    )).length;
  }

  function _pocRenderGraphEntityCard(entity) {
    const graph = _pocOntologyGraph();
    const category = (graph.categories || []).find((item) => item.id === entity.categoryId);
    const fields = (category && Array.isArray(category.fields) ? category.fields : [])
      .filter((field) => entity.properties && entity.properties[field.id])
      .map((field) => `<div class="personal-onto-graph-property"><span>${escapeHtml(_pocGraphFieldLabel(field))}</span><strong>${escapeHtml(entity.properties[field.id])}</strong></div>`)
      .join('');
    const archived = entity.status === 'archived';
    const statusAction = archived ? 'entity-reactivate' : 'entity-archive';
    const statusLabel = archived
      ? _t('ontologyGraph.entity_restore', '恢复')
      : _t('ontologyGraph.entity_archive', '归档');
    const bodyHtml = `<div class="personal-onto-graph-entity-head">
        <div class="personal-onto-graph-entity-titles"><h3>${escapeHtml(entity.name)}</h3><div>${_tag(_pocGraphCategoryLabel(category))} ${archived ? _tag(_t('ontologyGraph.entity_archived', '已归档')) : ''}</div></div>
        <span class="muted">${escapeHtml(_tv('ontologyGraph.entity_relation_count', { n: _pocEntityRelationCount(entity.id) }, `关联 ${_pocEntityRelationCount(entity.id)} 条`))}</span>
      </div>
      ${entity.description ? `<p class="personal-onto-affair-statement">${escapeHtml(entity.description)}</p>` : ''}
      ${fields ? `<div class="personal-onto-graph-properties">${fields}</div>` : ''}
      ${_pocRenderGraphSourceRefs(entity.sourceRefs)}
      <div class="personal-onto-graph-entity-actions">
        ${_button({ label: _t('ontologyGraph.entity_edit', '编辑'), size: 'sm', className: 'o', attrs: { 'data-poc-graph-op': 'entity-edit', 'data-entity-id': entity.id } })}
        ${_button({ label: _t('ontologyGraph.relation_add', '添加关系'), size: 'sm', className: 'o', disabled: archived, attrs: { 'data-poc-graph-op': 'relation-create', 'data-subject-kind': 'entity', 'data-subject-id': entity.id } })}
        ${_button({ label: statusLabel, size: 'sm', className: 'o', attrs: { 'data-poc-graph-op': statusAction, 'data-entity-id': entity.id } })}
        ${_button({ label: _t('ontologyGraph.entity_delete', '删除'), size: 'sm', className: 'is-danger', attrs: { 'data-poc-graph-op': 'entity-delete', 'data-entity-id': entity.id } })}
      </div>`;
    return window.uiCard({ tag: 'article', className: 'personal-onto-graph-entity-card', bodyHtml });
  }

  function _pocRenderFormalFactsSection() {
    const facts = _pocAffairAssets();
    const rows = facts.map((asset) => {
      const title = String(asset.title || '').trim() || _t('personalOntology.affairs_untitled', '未命名事实');
      const statement = _pocTextSnippet(asset.statement, 480);
      return `<article class="personal-onto-affair-row">
        <div class="personal-onto-affair-heading"><h3>${escapeHtml(title)}</h3>${_tag(_t('personalOntology.affairs_fact_kind', '事实与知识'))}</div>
        ${statement ? `<p class="personal-onto-affair-statement">${escapeHtml(statement)}</p>` : ''}
        <div class="personal-onto-affair-footer">
          <span class="muted">${escapeHtml(_t('personalOntology.affairs_active', '生效中'))} · ${escapeHtml(_t('personalOntology.affairs_source_asset', '来自正式认知资产'))}</span>
          ${_button({ label: _t('personalOntology.affairs_open_asset', '查看来源条目'), size: 'sm', className: 'o', attrs: { 'data-poc-open-asset': String(asset.id || '') } })}
        </div>
      </article>`;
    }).join('');
    return `<section class="personal-onto-graph-formal-facts"><div class="personal-onto-zone-head">${escapeHtml(_t('personalOntology.affairs_fact_list', '事实与知识'))} <span class="muted">${facts.length}</span></div>
      ${rows || `<div class="personal-onto-domain-empty">${_emptyState({ kind: 'quiet', title: _t('personalOntology.affairs_empty_title', '暂时没有事项类事实'), hint: _t('personalOntology.affairs_empty_hint', '确认保存的事实与知识资产会在这里显示；你仍可在「我的认知」中查看全部正式资产。') })}</div>`}
    </section>`;
  }

  function _pocRenderOntologyDomain(domain) {
    const graph = _pocOntologyGraph();
    const categories = _pocGraphCategories(domain);
    const entities = _pocGraphEntities(domain).filter((entity) => (
      _pocDomainCategoryFilter === 'all' || entity.categoryId === _pocDomainCategoryFilter
    ));
    const allEntities = _pocGraphEntities(domain);
    const entityCards = entities.map(_pocRenderGraphEntityCard).join('');
    const defaultCategory = _pocDomainCategoryFilter === 'all'
      ? categories[0]
      : categories.find((category) => category.id === _pocDomainCategoryFilter);
    const categoryFilters = [_button({
      label: _t('ontologyGraph.category_all', '全部分类'),
      size: 'sm',
      className: `personal-onto-filter-chip${_pocDomainCategoryFilter === 'all' ? ' is-on' : ''}`,
      attrs: { 'data-poc-graph-op': 'category-filter', 'data-domain': domain, 'data-category-id': 'all', 'aria-pressed': String(_pocDomainCategoryFilter === 'all') },
    }), ...categories.map((category) => {
      const count = allEntities.filter((entity) => entity.categoryId === category.id).length;
      return _button({
        label: `${_pocGraphCategoryLabel(category)} · ${count}`,
        size: 'sm',
        className: `personal-onto-filter-chip${_pocDomainCategoryFilter === category.id ? ' is-on' : ''}`,
        attrs: { 'data-poc-graph-op': 'category-filter', 'data-domain': domain, 'data-category-id': category.id, 'aria-pressed': String(_pocDomainCategoryFilter === category.id) },
      });
    })].join('');
    const error = graph.loadError
      ? `<p class="personal-onto-domain-error" role="alert">${escapeHtml(_pocGraphErrorText(graph.loadError))}</p>`
      : '';
    const domainHint = domain === 'affairs' ? _t('ontologyGraph.domain_affairs_hint', '把项目、任务、事件、目标与决策组织成可关联的事项实体。')
      : domain === 'resources' ? _t('ontologyGraph.domain_resources_hint', '把人物、组织、产品、工具、文档与地点组织成可关联的对象。')
        : _t('ontologyGraph.domain_concepts_hint', '把术语、方法与规则整理成可复用的概念实体。');
    const countLabel = _tv('ontologyGraph.domain_counts', { entities: allEntities.length, categories: categories.length }, `${allEntities.length} 个实体 · ${categories.length} 个分类`);
    const topActions = `<section class="personal-onto-graph-management" aria-labelledby="personal-onto-entity-management-title">
      <div class="personal-onto-graph-management-copy">
        <h2 id="personal-onto-entity-management-title">${escapeHtml(_t('personalOntology.domain_manage_title', '实体与分类'))}</h2>
        <p>${escapeHtml(_t('personalOntology.domain_manage_hint', '实体是具体的项目、人物或概念；分类定义实体可以填写哪些字段。'))}</p>
      </div>
      <div class="personal-onto-graph-toolbar">
        ${_button({ label: _t('ontologyGraph.entity_new', '新建实体'), icon: 'plus', size: 'sm', attrs: { 'data-poc-graph-op': 'entity-create', 'data-domain': domain, 'data-category-id': (defaultCategory && defaultCategory.id) || '' } })}
        ${_button({ label: _t('ontologyGraph.category_new', '新建分类'), size: 'sm', className: 'o', attrs: { 'data-poc-graph-op': 'category-create', 'data-domain': domain } })}
        ${_button({ label: _t('ontologyGraph.open_taxonomy', '管理分类与字段'), size: 'sm', className: 'o', attrs: { 'data-poc-domain-action': 'taxonomy-domain', 'data-taxonomy-domain': domain } })}
      </div>
    </section>`;
    const empty = !entityCards
      ? `<div class="personal-onto-domain-empty">${_emptyState({
        kind: 'actionable',
        title: _pocDomainCategoryFilter === 'all' ? _t('ontologyGraph.entities_empty_title', '这里还没有实体') : _t('ontologyGraph.category_entities_empty_title', '这个分类里还没有实体'),
        hint: _t('ontologyGraph.entities_empty_hint', '新建实体后，可以补充字段、关联来源，并与“我”或其他实体建立关系。'),
        action: { label: _t('ontologyGraph.entity_new', '新建实体'), icon: 'plus', size: 'sm', attrs: { 'data-poc-graph-op': 'entity-create', 'data-domain': domain, 'data-category-id': (defaultCategory && defaultCategory.id) || '' } },
      })}</div>`
      : '';
    return `<div class="personal-onto-domain-view">
      <div class="personal-onto-domain-intro">${escapeHtml(domainHint)}</div>
      ${error}
      ${topActions}
      <section class="personal-onto-graph-filter-panel" aria-labelledby="personal-onto-filter-title">
        <div class="personal-onto-graph-filter-heading">
          <h2 id="personal-onto-filter-title">${escapeHtml(_t('personalOntology.domain_filter_title', '按分类筛选实体'))}</h2>
          <p>${escapeHtml(_t('personalOntology.domain_filter_hint', '筛选只改变当前列表，不会修改实体或分类。'))}</p>
        </div>
        <div class="personal-onto-graph-filters">${categoryFilters}</div>
      </section>
      <div class="personal-onto-zone-head"><span>${escapeHtml(_t('ontologyGraph.entities_heading', '实体'))}</span><span class="muted">${escapeHtml(countLabel)}</span></div>
      <div class="personal-onto-graph-entity-grid">${entityCards || empty}</div>
      ${domain === 'affairs' ? _pocRenderFormalFactsSection() : ''}
    </div>`;
  }

  function _pocRenderAffairsView() { return _pocRenderOntologyDomain('affairs'); }
  function _pocRenderResourcesView() { return _pocRenderOntologyDomain('resources'); }
  function _pocRenderConceptsView() { return _pocRenderOntologyDomain('concepts'); }

  function _pocRenderPersonalTaxonomy() {
    const sections = _pocProfileSections();
    const profile = sections.map((section) => `<article class="personal-onto-taxonomy-row">
      <div class="personal-onto-affair-heading"><strong>${escapeHtml(_t(section.titleKey, section.title))}</strong><span class="muted">${section.entries.length}</span></div>
      <p class="muted">${escapeHtml(_t(section.descriptionKey, section.description))}</p>
    </article>`).join('');
    const groups = (_pocBoxData.groups || []).map((group) => `<article class="personal-onto-taxonomy-row">
      <div class="personal-onto-affair-heading"><strong>${escapeHtml(group.title)}</strong>${_tag(_t('ontologyGraph.personal_manual_group', '个人本体分组'))}</div>
      <div class="personal-onto-taxonomy-fields">${(group.fields || []).map((field) => _tag(String(field.name || ''))).join('') || `<span class="muted">${escapeHtml(_t('ontologyGraph.no_fields', '还没有字段'))}</span>`}</div>
    </article>`).join('');
    return `<section class="personal-onto-taxonomy-personal">
      <div class="personal-onto-zone-head">${escapeHtml(_t('ontologyGraph.personal_profile_categories', '个人信息分类'))}</div>
      ${profile || `<p class="muted">${escapeHtml(_t('ontologyGraph.personal_categories_empty', '保存个人信息后，系统会在这里按现有分类展示。'))}</p>`}
      <div class="personal-onto-zone-head">${escapeHtml(_t('ontologyGraph.personal_groups_categories', '个人本体分组与字段'))}</div>
      ${groups || `<p class="muted">${escapeHtml(_t('ontologyGraph.personal_groups_empty', '还没有个人本体分组。'))}</p>`}
      ${_button({ label: _t('ontologyGraph.manage_personal_categories', '打开个人本体分类管理'), size: 'sm', className: 'o', attrs: { 'data-poc-nav': 'groups' } })}
    </section>`;
  }

  function _pocRenderTaxonomyView() {
    const graph = _pocOntologyGraph();
    const domains = ['personal', 'affairs', 'resources', 'concepts'];
    const tabs = domains.map((domain) => _button({
      label: _pocGraphDomainLabel(domain),
      size: 'sm',
      className: `personal-onto-filter-chip${_pocTaxonomyDomain === domain ? ' is-on' : ''}`,
      attrs: { 'data-poc-graph-op': 'taxonomy-domain', 'data-domain': domain, 'aria-pressed': String(_pocTaxonomyDomain === domain) },
    })).join('');
    if (_pocTaxonomyDomain === 'personal') {
      return `<div class="personal-onto-domain-view"><div class="personal-onto-graph-filters">${tabs}</div>${_pocRenderPersonalTaxonomy()}</div>`;
    }
    const categories = _pocGraphCategories(_pocTaxonomyDomain);
    const entities = _pocGraphEntities(_pocTaxonomyDomain);
    const children = new Map();
    categories.forEach((category) => {
      const key = category.parentId || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(category);
    });
    const renderCategory = (category, depth = 0) => {
      const used = entities.filter((entity) => entity.categoryId === category.id).length;
      const childrenHtml = (children.get(category.id) || []).map((child) => renderCategory(child, depth + 1)).join('');
      return `<article class="personal-onto-taxonomy-row personal-onto-taxonomy-depth-${Math.min(depth, 6)}${category.builtIn ? ' is-built-in' : ''}">
        <div class="personal-onto-affair-heading"><strong>${escapeHtml(_pocGraphCategoryLabel(category))}</strong><span>${_tag(category.builtIn ? _t('ontologyGraph.category_builtin', '内置分类') : _t('ontologyGraph.category_custom', '自定义分类'))}<span class="muted">${used}</span></span></div>
        ${category.description ? `<p class="muted">${escapeHtml(category.descriptionKey ? _t(category.descriptionKey, category.description) : category.description)}</p>` : ''}
        <div class="personal-onto-taxonomy-fields">${(category.fields || []).map((field) => _tag(_pocGraphFieldLabel(field))).join('') || `<span class="muted">${escapeHtml(_t('ontologyGraph.no_fields', '还没有字段'))}</span>`}</div>
        ${!category.builtIn ? `<div class="personal-onto-graph-entity-actions">
          ${_button({ label: _t('ontologyGraph.category_edit', '编辑分类'), size: 'sm', className: 'o', attrs: { 'data-poc-graph-op': 'category-edit', 'data-category-id': category.id } })}
          ${_button({ label: _t('ontologyGraph.category_delete', '删除分类'), size: 'sm', className: 'is-danger', attrs: { 'data-poc-graph-op': 'category-delete', 'data-category-id': category.id } })}
        </div>` : ''}
      </article>${childrenHtml}`;
    };
    const categoriesHtml = (children.get('') || []).map((category) => renderCategory(category)).join('');
    const error = graph.loadError ? `<p class="personal-onto-domain-error" role="alert">${escapeHtml(_pocGraphErrorText(graph.loadError))}</p>` : '';
    return `<div class="personal-onto-domain-view"><div class="personal-onto-graph-filters">${tabs}</div>${error}
      <div class="personal-onto-graph-toolbar">${_button({ label: _t('ontologyGraph.category_new', '新建分类'), icon: 'plus', size: 'sm', attrs: { 'data-poc-graph-op': 'category-create', 'data-domain': _pocTaxonomyDomain } })}</div>
      <div class="personal-onto-zone-head">${escapeHtml(_t('ontologyGraph.categories_heading', '分类'))} <span class="muted">${categories.length}</span></div>
      ${categoriesHtml || `<div class="personal-onto-domain-empty">${_emptyState({ kind: 'quiet', title: _t('ontologyGraph.categories_empty_title', '暂无分类'), hint: _t('ontologyGraph.categories_empty_hint', '可以为这个领域创建自己的分类与字段。') })}</div>`}
    </div>`;
  }

  function _pocRenderRelationshipsView() {
    const rows = _pocRelationRows();
    const explicitRows = rows.filter((row) => row.relationKind !== 'same_family');
    const sameSourceRows = rows.filter((row) => row.relationKind === 'same_family');
    const canCreateGraphRelation = _pocGraphEntities().some((entity) => entity.status === 'active');
    const renderRelation = (row) => {
      const isSameSource = row.relationKind === 'same_family';
      return `<article class="personal-onto-relation-row">
      <div class="personal-onto-relation-edge">
        <span class="personal-onto-relation-node">${escapeHtml(row.from)}</span>
        <span class="personal-onto-relation-predicate">${escapeHtml(row.predicate)}</span>
        <span class="personal-onto-relation-node">${escapeHtml(row.to)}</span>
      </div>
      <div class="personal-onto-relation-footer">
        ${!isSameSource ? `<span class="muted">${escapeHtml(_tv('personalOntology.relationship_source', { source: row.source }, `来源：${row.source}`))}</span>` : ''}
        ${!isSameSource && row.note ? `<span class="muted">${escapeHtml(row.note)}</span>` : ''}
        ${row.assetId ? _button({ label: _t('personalOntology.relationship_open_source', '打开来源条目'), size: 'sm', className: isSameSource ? 'o personal-onto-relation-source-action' : 'o', attrs: { 'data-poc-open-asset': row.assetId } }) : ''}
        ${row.targetAssetId ? _button({ label: _t('personalOntology.relationship_open_target', '打开关联条目'), size: 'sm', className: isSameSource ? 'o personal-onto-relation-target-action' : 'o', attrs: { 'data-poc-open-asset': row.targetAssetId } }) : ''}
        ${row.relationId ? _button({ label: _t('ontologyGraph.relation_edit', '编辑关系'), size: 'sm', className: 'o', attrs: { 'data-poc-graph-op': 'relation-edit', 'data-relation-id': row.relationId } }) : ''}
        ${row.relationId ? _button({ label: _t('ontologyGraph.relation_delete', '删除关系'), size: 'sm', className: 'is-danger', attrs: { 'data-poc-graph-op': 'relation-delete', 'data-relation-id': row.relationId } }) : ''}
      </div>
      ${row.sourceRefs && row.sourceRefs.length ? _pocRenderGraphSourceRefs(row.sourceRefs) : ''}
    </article>`;
    };
    const relationHtml = explicitRows.map(renderRelation).join('');
    const sameSourceHtml = sameSourceRows.map(renderRelation).join('');
    const graphError = _pocOntologyGraph().loadError
      ? `<p class="personal-onto-domain-error" role="alert">${escapeHtml(_pocGraphErrorText(_pocOntologyGraph().loadError))}</p>`
      : '';
    return `<div class="personal-onto-domain-view">
      <div class="personal-onto-domain-intro">${escapeHtml(_t('personalOntology.relationships_hint', '每条明确关系按“起点 → 关系 → 终点”读取；来源用于说明关系是从哪里保存的。'))}</div>
      <div class="personal-onto-graph-toolbar">${_button({ label: _t('ontologyGraph.relation_new', '新建关系'), icon: 'plus', size: 'sm', disabled: !canCreateGraphRelation, attrs: { 'data-poc-graph-op': 'relation-create' } })}${!canCreateGraphRelation ? `<span class="muted">${escapeHtml(_t('ontologyGraph.relation_needs_entity', '先创建至少一个实体，再添加关系。'))}</span>` : ''}</div>
      ${graphError}
      <section class="personal-onto-relation-section" aria-labelledby="personal-onto-explicit-relations-title">
        <div class="personal-onto-zone-head" id="personal-onto-explicit-relations-title">${escapeHtml(_t('personalOntology.relationships_explicit_title', '明确关系'))} <span class="muted">${explicitRows.length}</span></div>
        <p class="personal-onto-relation-help">${escapeHtml(_t('personalOntology.relationships_explicit_hint', '这些关系明确记录了起点、关系名称和终点，例如“我 → 负责 → 项目”。'))}</p>
        ${relationHtml || `<div class="personal-onto-domain-empty">${_emptyState({
          kind: 'quiet',
          title: _t('personalOntology.relationships_empty_title', '还没有明确保存的关系'),
          hint: _t('personalOntology.relationships_empty_hint', '创建至少一个实体后，使用“新建关系”记录它与其他实体或“我”的关系。'),
        })}</div>`}
      </section>
      ${sameSourceRows.length ? `<details class="details personal-onto-related-groups">
        <summary>${escapeHtml(_tv('personalOntology.relationships_same_source_title', { n: sameSourceRows.length }, `同来源分组（系统整理）· ${sameSourceRows.length} 组`))}</summary>
        <p class="personal-onto-relation-help">${escapeHtml(_t('personalOntology.relationships_same_source_hint', '这些资产来自相同来源，被系统归为一组；这不表示它们之间存在业务依赖关系。'))}</p>
        ${sameSourceHtml}
      </details>` : ''}
      <p class="personal-onto-overview-note">${escapeHtml(_t('personalOntology.relationships_boundary_note', '关系图当前以清单呈现，避免把文本相似或模型猜测误显示成真实连接。'))}</p>
    </div>`;
  }

  function _pocBindMainView(bodyEl) {
    if (!bodyEl) return;
    bodyEl.querySelectorAll('[data-poc-domain-action]').forEach((el) => {
      el.addEventListener('click', () => {
        const action = el.getAttribute('data-poc-domain-action');
        if (action === 'taxonomy-domain' && el.getAttribute('data-taxonomy-domain')) {
          _pocTaxonomyDomain = el.getAttribute('data-taxonomy-domain');
        }
        _pocNavigate(action);
      });
    });
    bodyEl.querySelectorAll('[data-poc-open-asset]').forEach((el) => {
      el.addEventListener('click', () => {
        const assetId = el.getAttribute('data-poc-open-asset');
        if (assetId && typeof window.openCognitionAssetById === 'function') window.openCognitionAssetById(assetId);
      });
    });
    bodyEl.querySelectorAll('[data-poc-open-candidate]').forEach((el) => {
      el.addEventListener('click', () => {
        const candidateId = el.getAttribute('data-poc-open-candidate');
        if (candidateId && typeof window.openCognitionCandidateById === 'function') window.openCognitionCandidateById(candidateId);
      });
    });
    bodyEl.querySelectorAll('[data-poc-graph-op]').forEach((el) => {
      el.addEventListener('click', async (event) => {
        event.stopPropagation();
        await _pocHandleGraphOperation(el);
      });
    });
  }

  async function _pocHandleGraphOperation(el) {
    const op = String(el.getAttribute('data-poc-graph-op') || '');
    if (op === 'category-filter') {
      const domain = String(el.getAttribute('data-domain') || '');
      _pocDomainCategoryFilter = String(el.getAttribute('data-category-id') || 'all');
      if (_pocView === 'affairs' || _pocView === 'resources' || _pocView === 'concepts') {
        if (domain !== _pocView) return;
      }
      _pocRenderMain();
      return;
    }
    if (op === 'taxonomy-domain') {
      const domain = String(el.getAttribute('data-domain') || 'affairs');
      if (['personal', 'affairs', 'resources', 'concepts'].includes(domain)) {
        _pocTaxonomyDomain = domain;
        _pocRenderMain();
      }
      return;
    }
    const graph = _pocOntologyGraph();
    const categoryId = String(el.getAttribute('data-category-id') || '');
    const entityId = String(el.getAttribute('data-entity-id') || '');
    const relationId = String(el.getAttribute('data-relation-id') || '');
    const category = (graph.categories || []).find((item) => item.id === categoryId);
    const entity = (graph.entities || []).find((item) => item.id === entityId);
    const relation = (graph.relations || []).find((item) => item.id === relationId);
    if (op === 'category-create') await _pocOpenGraphCategoryForm(String(el.getAttribute('data-domain') || 'affairs'));
    else if (op === 'category-edit' && category) await _pocOpenGraphCategoryForm(category.domain, category);
    else if (op === 'category-delete' && category) await _pocDeleteGraphCategory(category);
    else if (op === 'entity-create') {
      const domain = String(el.getAttribute('data-domain') || 'affairs');
      const selectedCategory = category || _pocGraphCategories(domain)[0];
      await _pocOpenGraphEntityForm(domain, selectedCategory);
    } else if (op === 'entity-edit' && entity) await _pocOpenGraphEntityForm(entity.domain, undefined, entity);
    else if (op === 'entity-delete' && entity) await _pocDeleteGraphEntity(entity);
    else if ((op === 'entity-archive' || op === 'entity-reactivate') && entity) await _pocToggleGraphEntityStatus(entity);
    else if (op === 'relation-create') {
      const subjectId = String(el.getAttribute('data-subject-id') || '');
      await _pocOpenGraphRelationForm(null, subjectId || 'self');
    } else if (op === 'relation-edit' && relation) await _pocOpenGraphRelationForm(relation);
    else if (op === 'relation-delete' && relationId) await _pocDeleteGraphRelation(relationId);
  }

  function _pocRenderMain() {
    const headerEl = document.getElementById('personal-onto-main-header');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!headerEl || !bodyEl) return;

    if (['overview', 'affairs', 'resources', 'concepts', 'taxonomy', 'relationships'].includes(_pocView)) {
      headerEl.classList.remove('is-profile');
      if (_pocView === 'overview') {
        headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.overview_title', '本体总览'))}</span>`
          + `<div class="sub">${escapeHtml(_t('personalOntology.overview_subtitle', '从个人信息到项目事项，查看已保存的分类与关系。'))}</div>`;
        bodyEl.innerHTML = _pocRenderOntologyOverview();
      } else if (_pocView === 'affairs') {
        const n = _pocGraphEntities('affairs').length + _pocAffairAssets().length;
        headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_affairs_domain', '事项本体'))}</span>`
          + `<div class="sub">${escapeHtml(_tv('ontologyGraph.domain_counts', { entities: _pocGraphEntities('affairs').length, categories: _pocGraphCategories('affairs').length }, `${n} 个事项`))}</div>`;
        bodyEl.innerHTML = _pocRenderAffairsView();
      } else if (_pocView === 'resources') {
        const entities = _pocGraphEntities('resources');
        headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_resources_domain', '对象与资源'))}</span>`
          + `<div class="sub">${escapeHtml(_tv('ontologyGraph.domain_counts', { entities: entities.length, categories: _pocGraphCategories('resources').length }, `${entities.length} 个实体`))}</div>`;
        bodyEl.innerHTML = _pocRenderResourcesView();
      } else if (_pocView === 'concepts') {
        const entities = _pocGraphEntities('concepts');
        headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_concepts_domain', '概念本体'))}</span>`
          + `<div class="sub">${escapeHtml(_tv('ontologyGraph.domain_counts', { entities: entities.length, categories: _pocGraphCategories('concepts').length }, `${entities.length} 个实体`))}</div>`;
        bodyEl.innerHTML = _pocRenderConceptsView();
      } else if (_pocView === 'taxonomy') {
        headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_taxonomy_domain', '分类与字段'))}</span>`
          + `<div class="sub">${escapeHtml(_t('ontologyGraph.taxonomy_hint', '跨领域浏览分类、层级和字段定义。'))}</div>`;
        bodyEl.innerHTML = _pocRenderTaxonomyView();
        if (_pocTaxonomyDomain === 'personal') _pocBindBoxView(bodyEl);
      } else {
        const rows = _pocRelationRows();
        const explicitCount = rows.filter((row) => row.relationKind !== 'same_family').length;
        const sameSourceCount = rows.filter((row) => row.relationKind === 'same_family').length;
        headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_relationships_domain', '关系网络'))}</span>`
          + `<div class="sub">${escapeHtml(_tv('personalOntology.overview_relationships_meta', { relations: explicitCount, groups: sameSourceCount }, `${explicitCount} 条明确关系 · ${sameSourceCount} 组同来源`))}</div>`;
        bodyEl.innerHTML = _pocRenderRelationshipsView();
      }
      _pocBindMainView(bodyEl);
      return;
    }

    if (_pocSelected.kind === 'facts' || _pocSelected.kind === 'rules' || _pocSelected.kind === 'groups') {
      headerEl.classList.remove('is-profile');
      /* 三页页头都带一句白话导语（v2）。 */
      const counts = _pocBoxCounts();
      const boxInfo = {
        facts: { title: _t('personalOntology.nav_abox', '事实与条目'), n: counts.facts, unit: _t('personalOntology.count_items', '条'), def: _t('personalOntology.po2_facts_def', 'AI 长期记住的「关于我」——身份、偏好、项目，一条一条可改可删') },
        rules: { title: _t('personalOntology.nav_rbox', '规则'), n: counts.rules, unit: _t('personalOntology.count_items', '条'), def: _t('personalOntology.po2_rules_def', 'AI 该怎么配合你做事——按 操作规则 / 偏好 / 约束 分类') },
        groups: { title: _t('personalOntology.nav_groups', '分组与模板'), n: counts.groups, unit: _t('personalOntology.count_categories', '个'), def: _t('personalOntology.po2_groups_def', '事实的抽屉与现成的表格') },
      }[_pocSelected.kind];
      headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(boxInfo.title)}</span>` +
        `<div class="sub">${escapeHtml(boxInfo.def)} · ${boxInfo.n} ${escapeHtml(boxInfo.unit)}</div>`;
      bodyEl.innerHTML = _pocSelected.kind === 'facts' ? _pocRenderFactsView()
        : _pocSelected.kind === 'rules' ? _pocRenderRulesView()
        : _pocRenderGroupsView();
      _pocBindBoxView(bodyEl);
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

  // ── 事件绑定（v2：data-poc-*-op 属性驱动；菜单点完即重渲）──
  function _pocBindBoxView(bodyEl) {
    if (!bodyEl) return;
    bodyEl.querySelectorAll('[data-poc-value-op]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const menu = el.closest('details.po2-menu');
        if (menu) menu.removeAttribute('open');
        const op = el.getAttribute('data-poc-value-op');
        const gid = el.getAttribute('data-poc-gid');
        const valueId = el.getAttribute('data-poc-value-id');
        if (op === 'open-asset') {
          const assetId = el.getAttribute('data-poc-asset-id');
          if (assetId && typeof window.openCognitionAssetById === 'function') window.openCognitionAssetById(assetId);
        } else if (op === 'edit' && valueId) await _pocEditValuePromptV2(gid, valueId);
        else if (op === 'delete' && valueId) await _pocDeleteValueConfirmV2(gid, valueId);
        else if (op.startsWith('kind:') && valueId) await _pocSetValueKindV2(gid, valueId, op.slice('kind:'.length));
        else if ((op === 'restrict' || op === 'unrestrict') && valueId) await _pocToggleValueRestrictedV2(gid, valueId);
        else if (op === 'verify' && valueId) await _pocSetValueVerifiedV2(gid, valueId, true);
        else if (op === 'verify-independent' && valueId) await _pocSetValueVerifiedV2(gid, valueId, 'independent');
        else if (op === 'unverify' && valueId) await _pocSetValueVerifiedV2(gid, valueId, false);
      });
    });
    bodyEl.querySelectorAll('[data-poc-field-op]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const menu = el.closest('details.po2-menu');
        if (menu) menu.removeAttribute('open');
        const op = el.getAttribute('data-poc-field-op');
        const gid = el.getAttribute('data-poc-gid');
        const fieldId = el.getAttribute('data-poc-field-id');
        if (op === 'add-value') await _pocComposeValuePrompt(gid, fieldId);
        else if (op === 'rename' && fieldId) await _pocRenameFieldPromptV2(gid, fieldId);
        else if (op === 'toggle-relation' && fieldId) await _pocToggleFieldRelationV2(gid, fieldId);
        else if (op === 'delete' && fieldId) await _pocDeleteFieldConfirmV2(gid, fieldId);
      });
    });
    bodyEl.querySelectorAll('[data-poc-group-op]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const menu = el.closest('details.po2-menu');
        if (menu) menu.removeAttribute('open');
        const op = el.getAttribute('data-poc-group-op');
        const gid = el.getAttribute('data-poc-gid');
        const group = _pocPoGroupById(gid);
        if (op === 'add-field' && group) await _pocAddFieldPromptV2(gid);
        else if (op === 'add-entry' && group) await _pocAddEntryPromptV2(gid);
        else if (op === 'rename' && gid) await _pocRenameGroupPromptV2(gid);
        else if (op === 'delete' && gid) await _pocDeleteGroupConfirmV2(gid);
        else if (op === 'history' && gid) await _pocShowGroupHistoryV2(gid);
      });
    });
    bodyEl.querySelectorAll('[data-poc-entry-op]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const op = el.getAttribute('data-poc-entry-op');
        const gid = el.getAttribute('data-poc-gid');
        const entryId = el.getAttribute('data-poc-entry-id');
        if (op === 'promote' && entryId) await _pocPromoteEntryPromptV2(gid, entryId);
        else if (op === 'delete' && entryId) await _pocDeleteEntryV2(gid, entryId);
      });
    });
    bodyEl.querySelectorAll('[data-poc-candidate-op]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const op = el.getAttribute('data-poc-candidate-op');
        const cid = el.getAttribute('data-poc-candidate-id');
        if (op === 'confirm' && cid) await _pocConfirmCandidateV2(cid);
        else if (op === 'reject' && cid) await _pocRejectCandidateV2(cid, el);
      });
    });
    bodyEl.querySelectorAll('[data-poc-rule-filter]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        _pocRuleFilter = el.getAttribute('data-poc-rule-filter') || 'all';
        _pocRenderMain();
      });
    });
    const groupFilter = bodyEl.querySelector('[data-poc-facts-group-filter]');
    if (groupFilter) {
      groupFilter.addEventListener('change', () => {
        _pocFactsFilter.group = groupFilter.value || 'all';
        _pocRenderMain();
      });
    }
    const searchInput = bodyEl.querySelector('[data-poc-facts-q]');
    if (searchInput) {
      searchInput.addEventListener('change', () => {
        _pocFactsFilter.q = searchInput.value || '';
        _pocRenderMain();
      });
    }
    bodyEl.querySelectorAll('[data-poc-op]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const op = el.getAttribute('data-poc-op');
        if (op === 'compose-value') await _pocComposeValuePrompt();
        else if (op === 'compose-rule') await _pocComposeValuePrompt('', '', 'operation');
        else if (op === 'new-group') await _pocCreateGroupPrompt();
        else if (op === 'template-library') _pocOpenTemplateLibrary();
      });
    });
    bodyEl.querySelectorAll('[data-poc-history-restore]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const snapshotId = el.getAttribute('data-poc-history-restore');
        const gid = el.getAttribute('data-poc-gid');
        if (snapshotId && gid) await _pocRestoreHistoryV2(el, gid, snapshotId);
      });
    });
    bodyEl.querySelectorAll('[data-poc-deleted-op]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const op = el.getAttribute('data-poc-deleted-op');
        const gid = el.getAttribute('data-poc-gid');
        if (op === 'restore' && gid) await _pocRestoreDeletedGroupV2(el, gid);
      });
    });
    bodyEl.querySelectorAll('[data-poc-nav]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const action = el.getAttribute('data-poc-nav');
        const id = el.getAttribute('data-poc-id');
        if (action === 'template' && id) { _pocOpenGroup(id); }
        else if (action === 'template-library') { e.stopPropagation(); _pocOpenTemplateLibrary(); }
        else if (action === 'template-uninstall') {
          e.stopPropagation();
          const tid = el.getAttribute('data-poc-template-id');
          if (tid) await _pocRunOnce(`template-uninstall:${tid}`, el, () => _pocUninstallTemplate(tid));
        }
      });
    });
  }

function _pocBindNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;
    nav.querySelectorAll('[data-poc-nav]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const action = el.getAttribute('data-poc-nav');
        const id = el.getAttribute('data-poc-id');
        if (action === 'ontology-home' || action === 'personal-domain' || action === 'affairs-domain'
          || action === 'resources-domain' || action === 'concepts-domain'
          || action === 'taxonomy-domain' || action === 'relationships-domain'
          || action === 'facts' || action === 'rules' || action === 'groups') {
          _pocNavigate(action);
        }
        else if (action === 'new-group') {
          e.stopPropagation();
          _pocCreateGroupPrompt();
        }
        else if (action === 'memory-export' || action === 'memory-import') {
          e.stopPropagation();
          // v2：导出/导入个人本体自己的 markdown（po.data.*），不再指向已退役的记忆文件。
          if (action === 'memory-export') await _pocOpenExportModal();
          else await _pocOpenImportModal();
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
        if (action === 'open-formal-asset') {
          const assetId = el.getAttribute('data-poc-asset-id');
          if (assetId && typeof window.openCognitionAssetById === 'function') window.openCognitionAssetById(assetId);
          return;
        }
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
  async function renderPersonalOntology(options = {}) {
    if (options && ['overview', 'personal', 'affairs', 'resources', 'concepts', 'taxonomy', 'relationships'].includes(options.view)) {
      _pocView = options.view;
    }
    // 深链直达个人本体某一页（facts / rules / groups）。
    if (options && ['facts', 'rules', 'groups'].includes(options.box)) {
      _pocView = 'personal';
      _pocSelected = { kind: options.box, id: options.box };
    }
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
      // 模板编辑器只在个人视图下钻时进入。
      if (_pocView === 'personal' && _pocSelected.kind === 'template') {
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
        return;
      }

      // 其余页面（个人三页 + 总览 + 各域页）：一次快照拉齐（v2 修复了域页
      // 不装盒数据就渲染的隐患——关系网络/总览计数都吃这一份）。
      if (!_pocBoxData.loaded) {
        nav.innerHTML = '<div class="personal-onto-nav-empty muted">' + _t('personalOntology.loading', '加载中...') + '</div>';
        bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.loading', '加载中...') + '</div>';
        await _pocLoadBoxData();
      }
      // 非法选中态回事实页。
      if (_pocView === 'personal' && !['facts', 'rules', 'groups', 'template'].includes(_pocSelected.kind)) {
        _pocSelected = { kind: 'facts', id: 'facts' };
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
    _pocBoxData = {
      loaded: false, loadError: '', groups: [], assets: [], sourceAssets: [], conflicts: [],
      graph: { loaded: false, loadError: '', categories: [], entities: [], relations: [] },
    };
    _pocPo = { snapshot: null, loaded: false, loadError: '' };
    _pocFactsFilter = { group: 'all', q: '' };
    _pocRuleFilter = 'all';
    _pocExpandedValues.clear();
    const route = window.CogAssets && window.CogAssets.store && window.CogAssets.store.route;
    if (options.deferWhenHidden && route && route.name !== 'ontology') return Promise.resolve();
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
  window.refreshOntologyGraph = refreshOntologyGraph;
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('i18n-change', () => { void _pocRefreshForLanguage(); });
  }
})();
