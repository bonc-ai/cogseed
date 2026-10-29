/* 本体页面：认知主档的列表、三盒内容与两层图谱投影。 */
(function initCognitionOntologyPage(root) {
  'use strict';
  const text = (key, fallback, vars) => {
    const value = typeof root.t === 'function' ? root.t(`ontologyWorkspace.${key}`, vars) : '';
    const output = value && value !== `ontologyWorkspace.${key}` ? value : fallback;
    return vars ? output.replace(/\{(\w+)\}/g, (match, name) => vars[name] == null ? match : String(vars[name])) : output;
  };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const invoke = async (channel, payload = {}) => {
    const result = await root.cogseed.invoke(channel, payload);
    if (!result || result.ok !== true) {
      const codes = ['legacy_read_only', 'baseline_changed', 'not_authorized', 'conflict', 'invalid_time', 'not_found', 'store_corrupt', 'capacity_exceeded', 'command_reused', 'commit_failed', 'invalid_intent', 'invalid_reference', 'conflicting_facts', 'ambiguous_identity', 'invalid_type', 'invalid_input'];
      const message = codes.includes(result?.code) ? text(`error_${result.code}`, result?.error || '', { count: result?.details?.submitted ?? 0 }) : result?.error;
      const error = new Error(message || text('error', '操作未完成，请稍后重试。'));
      error.details = result?.details || {};
      error.code = result?.code || '';
      throw error;
    }
    return result;
  };
  let state = null;

  function button(label, action, role = 'secondary', attrs = {}, icon = '') {
    return root.uiButton({ label, role, className: 'ontology-ws-button', ...(icon ? { icon } : {}), attrs: { 'data-ontology-action': action, ...attrs } });
  }
  function pageControl(label, action, className = '', attrs = {}, icon = '') {
    return root.uiButton({ label, role: 'ghost', size: 'sm', className, ...(icon ? { icon } : {}), attrs: { 'data-ontology-action': action, ...attrs } });
  }
  function tabs(items, selected, label, attrs = {}) {
    return root.uiTabs({ items: items.map(([value, itemLabel]) => ({ value, label: itemLabel })), value: selected, ariaLabel: label, attrs });
  }
  function field(label, id, value = '', type = 'text', hint = '') {
    return root.uiField({ id, label, hint, showRequirement: false, control: { kind: 'input', type, value, attrs: { 'data-ontology-field': id } } });
  }
  function textarea(label, id, value = '', hint = '') {
    return root.uiField({ id, label, hint, showRequirement: false, control: { kind: 'textarea', value, attrs: { 'data-ontology-field': id, rows: 4 } } });
  }
  function select(label, id, options, value = '', hint = '') {
    return root.uiField({ id, label, hint, showRequirement: false, control: { kind: 'select', value, options, searchable: options.length > 8 } });
  }

  async function loadPending(current) {
    try {
      const [result, legacy] = await Promise.all([
        invoke('recall.candidates.list', { view: 'review-queue' }),
        invoke('personalOntology.candidates.list'),
      ]);
      if (state !== current) return;
      const candidates = result.candidates;
      if (legacy.corrupt) throw new Error('legacy candidate queue unavailable');
      const legacyCandidates = legacy.candidate_updates || legacy.candidates;
      current.pendingCount = Array.isArray(candidates) && Array.isArray(legacyCandidates)
        ? candidates.filter(candidate => candidate.capabilities?.countsAsPending && !candidate.capabilities?.isSnoozed).length + legacyCandidates.length : null;
    } catch (_) { if (state === current) current.pendingCount = null; }
    if (state === current && current.doc && current.page === 'list') render();
  }
  function recentRecords() {
    return (state.recentIds || []).map(id => state.doc.records[id]).filter(record => record?.kind === 'entity'
      && record.status === 'active' && state.doc.records[record.moduleId]?.status === 'active');
  }
  function typeChoices(label, name, options, selected) {
    if (typeof root.uiCheckbox !== 'function') return select(label, name === 'subjectTypes' ? 'subjectType' : 'objectType', [{ value: '', label: text('noTypeLimit', '不限定') }, ...options], selected?.[0] || '');
    return `<fieldset class="ontology-ws-type-choices" data-ontology-multi-group="${name}"><legend>${esc(label)}</legend><small>${esc(text('noTypeLimit', '不限定'))} · ${esc(text('emptyTypeChoices', '不选择时不限定类型'))}</small>${options.map((option, index) => {
      const id = `ontology-${name}-${index}`;
      return `<label for="${id}">${root.uiCheckbox({ id, label: option.label, value: option.value, checked: (selected || []).includes(option.value), attrs: { 'data-ontology-multi': name } })}${esc(option.label)}</label>`;
    }).join('')}</fieldset>`;
  }
  async function refresh() {
    const current = state, request = ++current.snapshotRequest;
    const result = await invoke('cognition.ontology.snapshot');
    if (state !== current || request !== current.snapshotRequest) return;
    current.doc = result.ontology;
    current.lastLoadedAt = Date.now();
    void loadPending(current);
    render();
  }
  function modules(includeInactive = false) {
    return Object.values(state.doc.records).filter(r => r.kind === 'module' && (includeInactive || r.status === 'active'))
      .sort((a, b) => (String(b.updatedAt || '') > String(a.updatedAt || '') ? 1 : String(b.updatedAt || '') < String(a.updatedAt || '') ? -1 : 0)
        || a.name.localeCompare(b.name));
  }
  function moduleMenu(module) {
    const attrs = { 'data-record-id': module.id };
    return `${button(text('deleteModule', '删除'), 'delete-module', 'danger', attrs)}${module.status === 'active' ? button(text('archiveModule', '归档'), 'archive-module', 'ghost', attrs) : button(text('resumeModule', '恢复'), 'resume-module', 'ghost', attrs)}`;
  }

  function moduleDescription(module) {
    if (module.description) return module.description;
    return module.source.kind === 'legacy'
      ? text('legacyModuleCardHint', '旧内容只读保留。打开单条记录可送入待我处理，核对后再整理。')
      : text('noDescription', '还没有填写简介。');
  }
  function moduleVisual(module) {
    if (module.source.kind === 'legacy') return { kind: 'legacy', icon: 'archive', label: text('legacy', '旧来源') };
    if (module.scope.kind === 'project') return { kind: 'project', icon: 'folder', label: text('project', '项目') };
    if (module.scope.kind === 'workspace') return { kind: 'workspace', icon: 'users', label: text('workspace', '工作区') };
    return { kind: 'personal', icon: 'user', label: text('personal', '个人') };
  }
  function intlLocale() {
    try {
      if (typeof root.getLocaleMeta === 'function' && typeof root.getLang === 'function') {
        return root.getLocaleMeta(root.getLang()).intlLocale || 'zh-CN';
      }
    } catch (_) { /* Fall back to a stable locale. */ }
    return 'zh-CN';
  }
  function loadedTimeLabel() {
    if (!state?.lastLoadedAt) return '';
    try { return new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(state.lastLoadedAt)); }
    catch (_) { return ''; }
  }
  function updatedTimeLabel(module) {
    if (!module?.updatedAt) return '';
    const date = new Date(module.updatedAt);
    if (Number.isNaN(date.getTime())) return '';
    try {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const days = Math.round((day.getTime() - today.getTime()) / 86400000);
      if (days <= 0 && days >= -7) return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(days, 'day');
      const options = date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' };
      return new Intl.DateTimeFormat(intlLocale(), options).format(date);
    } catch (_) { return ''; }
  }
  function rememberRecentModule(id) {
    const record = state?.doc?.records?.[id];
    if (!record || record.kind !== 'module') return;
    state.recentModuleIds = [id, ...(state.recentModuleIds || []).filter(item => item !== id)].slice(0, 20);
    try { root.localStorage?.setItem(`ontology-recent-modules:${state.doc.ownerId}`, JSON.stringify(state.recentModuleIds)); }
    catch (_) { /* Recent modules are optional layout preferences. */ }
  }
  function latestRecentModuleId() {
    for (const id of state?.recentModuleIds || []) {
      const record = state.doc.records[id];
      if (record?.kind === 'module' && record.status === 'active') return id;
    }
    return '';
  }
  function moduleAccess() { return state.doc.records[state.moduleId]?.access || 'task'; }
  function recordsIn(moduleId, kind) {
    return Object.values(state.doc.records).filter(r => r.kind === kind && r.moduleId === moduleId && r.status === 'active');
  }
  function usableRecords(kind) {
    const refs = recordsIn(state.moduleId, 'reference').filter(ref => ref.access === 'task');
    return Object.values(state.doc.records).filter(record => record.kind === kind && record.status === 'active'
      && (record.moduleId === state.moduleId || record.access === 'task'
        && state.doc.records[record.moduleId]?.status === 'active' && state.doc.records[record.moduleId]?.access === 'task'
        && refs.some(ref => ref.targetModuleId === record.moduleId && (!ref.targetRecordId || ref.targetRecordId === record.id))));
  }
  function choiceLabel(record) { return record.moduleId === state.moduleId ? record.name : `${record.name} · ${moduleName(record.moduleId)}`; }
  function moduleName(id) { return state.doc.records[id]?.name || text('unknown', '未命名本体'); }
  function recordName(record) {
    if (!record) return text('unknown', '已删除或不可用');
    if (record.kind === 'assertion') {
      const predicate = state.doc.records[record.definitionId];
      const subject = state.doc.records[record.subjectId];
      const value = record.object.kind === 'entity' ? state.doc.records[record.object.id]?.name : record.object.value;
      return `${subject?.name || text('unknown', '对象')} · ${predicate?.name || text('relation', '关系')} · ${value ?? ''}`;
    }
    if (record.kind === 'reference') {
      const targetModule = state.doc.records[record.targetModuleId];
      const targetRecord = record.targetRecordId ? state.doc.records[record.targetRecordId] : null;
      return `${text('reference', '引用')}：${targetRecord ? recordName(targetRecord) : targetModule?.kind === 'module' ? targetModule.name : text('unknown', '本体')}`;
    }
    return record.name || record.id;
  }
  function searchResultContext(row) {
    const record = state.doc.records[row.id], module = row.moduleId ? state.doc.records[row.moduleId] : null;
    const parts = [];
    if (module?.kind === 'module') parts.push(module.name);
    if (record?.kind === 'entity') {
      const type = state.doc.records[record.typeId];
      if (type?.kind === 'definition') parts.push(type.name);
      const facts = Object.values(state.doc.records).filter(item => item.kind === 'assertion' && item.status === 'active'
        && item.moduleId === record.moduleId && item.subjectId === record.id).slice(0, 2);
      for (const fact of facts) {
        const definition = state.doc.records[fact.definitionId];
        if (definition?.kind === 'definition') parts.push(`${definition.name}：${valueLabel(fact.object)}`);
      }
    }
    const description = String(row.description || (record && 'description' in record ? record.description : '') || '').trim();
    if (description && !parts.includes(description)) parts.push(description);
    return [...new Set(parts)].join(' · ').slice(0, 180);
  }
  function searchResultRows(rows, action) {
    const counts = new Map();
    for (const row of rows) {
      const key = `${row.kind}:${String(row.name).toLocaleLowerCase()}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return rows.map(row => {
      const duplicate = (counts.get(`${row.kind}:${String(row.name).toLocaleLowerCase()}`) || 0) > 1;
      const context = searchResultContext(row);
      const disambiguator = duplicate ? context || row.id.slice(-8) : text(row.kind, row.kind);
      return `<div class="ontology-ws-search-result">${button(`${row.name} · ${disambiguator}`, action, 'ghost', { 'data-record-id': row.id, 'data-module-id': row.moduleId || '' })}${context ? `<small>${esc(context)}</small>` : ''}</div>`;
    }).join('');
  }
  function searchResultRow(row) {
    const isModule = row.kind === 'module';
    const source = isModule ? '' : moduleName(row.moduleId || row.id);
    let snippet = searchResultContext(row);
    if (isModule && row.name && snippet.startsWith(row.name + ' · ')) snippet = snippet.slice(row.name.length + 3);
    if (!isModule && source && snippet.startsWith(source + ' · ')) snippet = snippet.slice(source.length + 3);
    if (!isModule && snippet === source) snippet = '';
    const kindClass = /^(module|reference|entity|assertion|definition|rule|value|asset|candidate|legacy)$/.test(row.kind) ? row.kind : 'other';
    const action = root.uiButton({ label: isModule ? text('open', '打开本体') : text('openRecord', '打开记录'), role: 'secondary', size: 'sm', iconEnd: 'arrow-right', className: 'ont-result-action',
      attrs: { 'data-ontology-action': 'search-result', 'data-record-id': row.id, 'data-module-id': row.moduleId || row.id } });
    return `<article class="ont-search-result" data-search-kind="${esc(row.kind)}"><span class="ont-result-type is-${esc(kindClass)}">${esc(text(row.kind, row.kind))}</span><div class="ont-result-main"><h3 class="ont-result-title">${esc(row.name)}</h3>${snippet ? `<p class="ont-result-snippet">${esc(snippet)}</p>` : ''}${source ? `<div class="ont-result-source">${esc(text('sourceOntology', '所属本体'))} · ${esc(source)}</div>` : ''}</div>${action}</article>`;
  }
  function valueLabel(value) {
    if (value?.kind === 'entity') return state.doc.records[value.id]?.name || text('unavailableObject', '当前不可用的对象');
    if (value?.kind === 'literal') return String(value.value);
    return '';
  }
  function conditionLabel(condition) {
    if (!condition) return text('noCondition', '所有任务');
    if (condition.kind === 'task') return `${text(condition.field, condition.field === 'purpose' ? text('taskPurpose', '任务目的') : condition.field === 'taskKind' ? text('taskKind', '任务类型') : text('taskEntity', '涉及对象'))} = ${condition.equals}`;
    if (condition.kind === 'assertion') {
      const subject = state.doc.records[condition.subjectId], definition = state.doc.records[condition.definitionId];
      return `${subject?.kind === 'entity' ? subject.name : text('unknown', '对象')} · ${definition?.kind === 'definition' ? definition.name : text('unknown', '关系')}${condition.object ? ` · ${valueLabel(condition.object)}` : ''}`;
    }
    if (condition.kind === 'not') return `${text('not', '不满足')} ${conditionLabel(condition.condition)}`;
    return condition.conditions.map(conditionLabel).join(condition.kind === 'all' ? ` ${text('and', '并且')} ` : ` ${text('or', '或者')} `);
  }
  function detailRows(record) {
    const row = (key, value) => `<p class="ontology-ws-detail-row"><b>${esc(text(key, key))}</b><span>${esc(value)}</span></p>`;
    if (record.kind === 'entity') return [
      row('type', state.doc.records[record.typeId]?.name || text('unknown', '未知类型')),
      row('description', record.description || text('noDescription', '还没有填写简介。')),
      row('aliases', record.aliases.join('、') || '—'),
      row('access', record.access === 'owner_only' ? text('privateAccess', '仅自己查看，不提供给任务') : text('taskAccess', '认知资产可按引用供任务使用')),
    ].join('');
    if (record.kind === 'definition') return [
      row('definitionKind', text(record.definitionKind, record.definitionKind)),
      row('subjectTypes', record.subjectTypes.map(id => state.doc.records[id]?.name || id).join('、') || text('noTypeLimit', '不限定')),
      row('objectTypes', record.objectTypes.map(id => state.doc.records[id]?.name || id).join('、') || text('noTypeLimit', '不限定')),
      row('valueType', text(record.valueType, record.valueType)),
      row('cardinality', text(record.cardinality, record.cardinality)),
      row('description', record.description || '—'),
    ].join('');
    if (record.kind === 'rule') {
      const effect = record.effect.kind === 'include_recipient' ? `${text('includeRecipient', '加入接收人')}：${state.doc.records[record.effect.entityId]?.name || text('unknown', '对象')}`
        : record.effect.kind === 'required_section' ? `${text('requiredSection', '必需章节')}：${record.effect.name}`
          : record.effect.kind === 'choice' ? `${record.effect.key}：${record.effect.value}` : text('noteOnly', '显示说明');
      return [row('requirement', record.requirement), row('strength', text(record.strength, record.strength)),
        row('condition', conditionLabel(record.condition)), row('effect', effect), row('exception', record.exception || '—'),
        row('access', record.access === 'owner_only' ? text('privateAccess', '仅自己查看，不提供给任务') : text('taskAccess', '认知资产可按引用供任务使用'))].join('');
    }
    if (record.kind === 'reference') return [
      row('targetModule', state.doc.records[record.targetModuleId]?.name || record.targetModuleId),
      ...(record.targetRecordId ? [row('targetRecord', recordName(state.doc.records[record.targetRecordId]))] : []),
      row('versionPolicy', record.versionPolicy === 'current' ? text('currentVersion', '使用当前版本') : `${text('pinnedVersion', '固定版本')} ${record.targetVersion || ''}`),
    ].join('');
    return '';
  }
  function provenance(record) {
    const refs = record.source.refs || [];
    return `<div class="ontology-ws-provenance"><b>${esc(text('source', '来源'))}</b><span>${esc(record.source.label)}</span>${refs.length ? `<ul>${refs.map(ref => `<li>${esc(text(ref.kind, ref.kind))} · ${esc(ref.id)}</li>`).join('')}</ul>` : ''}</div>`;
  }
  function stat(label, value) { return `<div class="ontology-ws-stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`; }
  function pageHeader({ kicker, title, description = '', actions = '', back = '' }) {
    return `<header class="ontology-ws-header">${back}<div class="ontology-ws-heading"><div class="ontology-ws-kicker">${esc(kicker)}</div><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</div><div class="ontology-ws-actions">${actions}</div></header>`;
  }
  function pageControls(kind, page, count, pageSize) {
    const pages = Math.ceil(count / pageSize);
    if (pages <= 1) return '';
    const current = Math.max(0, Math.min(page, pages - 1));
    const start = current * pageSize + 1, end = Math.min(count, start + pageSize - 1);
    const previous = current > 0 ? button(text('previousPage', '上一页'), 'change-page', 'secondary', { 'data-page-kind': kind, 'data-page': current - 1 }) : '';
    const next = current < pages - 1 ? button(text('nextPage', '下一页'), 'change-page', 'secondary', { 'data-page-kind': kind, 'data-page': current + 1 }) : '';
    return `<nav class="ontology-ws-pagination" aria-label="${esc(text('pagination', '分页'))}">${previous}<span role="status" aria-live="polite">${esc(text('pageSummary', '{start}–{end} / {total}', { start, end, total: count }))}</span>${next}</nav>`;
  }
  function revealDocument(element) {
    const scroll = state?.root.querySelector?.('.ont-document-scroll');
    if (!element || !scroll?.scrollTo) return;
    const top = scroll.scrollTop + element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
    scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function keepDocumentAnchor(anchor, update) {
    const scroll = state.root.querySelector?.('[data-ontology-scroll]');
    const top = anchor?.getBoundingClientRect?.().top;
    update();
    if (scroll?.scrollTo && Number.isFinite(top) && anchor?.isConnected) {
      // Closing an earlier panel can move this row. Keep the clicked control in place.
      scroll.scrollTo({ top: scroll.scrollTop + anchor.getBoundingClientRect().top - top, left: scroll.scrollLeft, behavior: 'instant' });
    }
  }
  function toggleDocumentDisclosure(id, target) {
    const panels = [...state.root.querySelectorAll('[data-ontology-panel]')];
    const panel = panels.find(node => node.dataset.ontologyPanel === id);
    const expandedId = state.documentExpandedId === id ? '' : id;
    state.documentExpandedId = expandedId;
    state.recordId = id;
    if (!panel) { render(); return; }
    const controls = [...state.root.querySelectorAll('[data-ontology-action="document-disclosure"]')];
    const trigger = controls.find(node => node.dataset.recordId === id && node.classList.contains('ont-record-disclosure'))
      || controls.find(node => node.dataset.recordId === id && !node.closest('[data-ontology-panel]'));
    const anchor = target.closest?.('[data-ontology-panel]') ? trigger : target;
    keepDocumentAnchor(anchor, () => {
      for (const node of panels) {
        const open = node.dataset.ontologyPanel === expandedId;
        if (open || !node.hidden) {
          const body = node.tagName === 'TR' ? node.querySelector('td') : node;
          body.innerHTML = open ? inlineInspector(state.doc.records[expandedId]) : '';
          node.hidden = !open;
        }
      }
      for (const control of controls) {
        if (control.classList.contains('ont-record-disclosure')) control.setAttribute('aria-expanded', String(control.dataset.recordId === expandedId));
      }
    });
    if (target.closest?.('[data-ontology-panel]') || !target.isConnected) trigger?.focus({ preventScroll: true });
  }
  function listPage() {
    const allModules = modules(state.showInactive).filter(m => (!state.showInactive || m.status !== 'active')
      && (!state.scopeFilter || state.scopeFilter === 'all' || m.scope.kind === state.scopeFilter));
    const query = String(state.searchQuery || '').trim().toLocaleLowerCase();
    const matching = query ? allModules.filter(m => [m.name, m.description, m.scope.id].join(' ').toLocaleLowerCase().includes(query)) : allModules;
    const modulePageSize = 20, pageCount = Math.max(1, Math.ceil(matching.length / modulePageSize));
    state.modulePage = Math.min(state.modulePage || 0, pageCount - 1);
    const visibleModules = matching.slice(state.modulePage * modulePageSize, (state.modulePage + 1) * modulePageSize);
    const baseModules = modules(true);
    const activeModules = baseModules.filter(m => m.status === 'active');
    const scopeCounts = {
      all: activeModules.length,
      personal: activeModules.filter(m => m.scope.kind === 'personal').length,
      project: activeModules.filter(m => m.scope.kind === 'project').length,
      workspace: activeModules.filter(m => m.scope.kind === 'workspace').length,
      inactive: baseModules.filter(m => m.status !== 'active').length,
    };
    const scopeOptions = [
      ['all', text('all', '全部')],
      ['personal', text('personal', '个人')],
      ['project', text('project', '项目')],
      ['workspace', text('workspaceScopeLabel', '工作空间')],
    ];
    const currentScopeLabel = state.showInactive
      ? text('inactiveModules', '已停用本体')
      : (scopeOptions.find(([value]) => value === (state.scopeFilter || 'all'))?.[1] || scopeOptions[0][1]);
    const toggle = (label, action, selected, attrs = {}) => pageControl(label, action, selected ? 'active' : '', { 'aria-pressed': String(selected), ...attrs });
    const heading = query ? text('searchResults', '搜索结果') : state.showInactive ? text('inactiveModules', '已停用本体') : text('title', '本体');
    const results = (state.searchResults || []).filter(row => allModules.some(m => m.id === (row.moduleId || row.id)));
    const headingCount = query ? results.length + matching.filter(m => !results.some(r => r.id === m.id)).length : allModules.length;
    const title = query || state.showInactive
      ? `<div class="ont-library-title"><h1>${esc(heading)}<span class="ont-count-text">${headingCount}</span></h1></div>`
      : '';
    const recentModuleId = latestRecentModuleId();
    const loadedAt = loadedTimeLabel();
    const card = m => {
      const records = Object.values(state.doc.records).filter(r => r.moduleId === m.id && r.status === 'active');
      const description = moduleDescription(m).split(/[。；\n]/)[0];
      const scope = m.source.kind === 'legacy'
        ? { kind: 'legacy', label: text('legacyDocumentReadOnlyShort', '旧来源 · 只读') }
        : { kind: m.scope.kind, label: text(m.scope.kind === 'workspace' ? 'workspaceScopeLabel' : m.scope.kind, ({ personal: '个人', project: '项目', workspace: '工作空间' })[m.scope.kind]) };
      const tags = `<span class="ont-card-tag is-${esc(scope.kind)}" data-card-tag="scope">${esc(scope.label)}</span>`
        + (m.id === recentModuleId ? `<span class="ont-card-tag is-recent" data-card-tag="recent">${esc(text('recentlyOpened', '最近打开'))}</span>` : '')
        + (m.access === 'owner_only' ? `<span class="ont-card-tag is-private" data-card-tag="private" title="${esc(text('privateAccess', '仅自己查看，不提供给任务'))}">${root.uiIconHtml('lock', 'ont-card-tag-icon')}${esc(text('privateAccessShort', '仅自己'))}</span>` : '');
      const stats = [['definition', '定义'], ['rule', '规则'], ['entity', '对象'], ['assertion', '事实']].map(([kind, label]) => {
        const value = records.filter(r => r.kind === kind).length;
        return `<div class="ont-card-stat${value ? '' : ' is-zero'}"><b>${value}</b><span>${esc(text(kind + 'CountLabel', label))}</span></div>`;
      }).join('');
      const updated = updatedTimeLabel(m);
      const updatedMarkup = updated ? `<div class="ont-card-head-side"><time datetime="${esc(m.updatedAt)}">${root.uiIconHtml('clock', 'ont-card-clock')}${esc(updated)}</time></div>` : '';
      return `<article class="ont-module-card" role="link" tabindex="0" data-card-module="${esc(m.id)}" data-record-id="${esc(m.id)}" aria-label="${esc(text('openModuleDocument', '打开{name}本体文档', { name: m.name }))}"><div class="ont-card-head"><h3 title="${esc(m.name)}">${esc(m.name)}</h3>${updatedMarkup}</div><div class="ont-card-meta">${tags}</div><p class="ont-card-purpose">${esc(description)}</p><div class="ont-card-stats">${stats}</div></article>`;
    };
    const createCard = () => root.uiCard({
      className: 'ont-module-card ont-create-card',
      bodyHtml: `${root.uiButton({ label: text('createModule', '创建本体'), role: 'ghost', icon: 'plus', className: 'ont-create-button', attrs: { 'data-ontology-action': 'create-module' } })}<p class="ont-create-hint">${esc(text('directoryEmptyHint', '人物、项目、事实与规则，都可以从这里建立联系。'))}</p>`,
    });
    const scopePicker = `<details class="ont-scope" data-ontology-scope><summary class="ont-scope-trigger"><span class="ont-scope-label">${esc(text('scopeShort', '范围'))}</span><span class="ont-scope-current">${esc(currentScopeLabel)}</span><span class="ont-scope-caret">${root.uiIconHtml('chevron-down', 'ont-scope-caret-icon')}</span></summary><div class="ont-scope-menu"><div class="ont-scope-options" id="scope-tabs">${scopeOptions.map(([value, label]) => toggle(`${label} ${scopeCounts[value]}`, 'directory-scope', !state.showInactive && (state.scopeFilter || 'all') === value, { 'data-scope': value })).join('')}</div><div class="ont-scope-divider" role="separator"></div>${toggle(`${text('inactiveModules', '已停用本体')} ${scopeCounts.inactive}`, 'toggle-inactive', state.showInactive)}${pageControl(text('archiveHistory', '归档旧历史…'), 'archive-history', 'ont-scope-archive')}</div></details>`;
    const viewToggle = `<div class="ont-library-view-toggle" id="view-toggle" aria-label="${esc(text('viewMode', '本体展示方式'))}">${toggle(text('cards', '卡片'), 'directory-view', state.mode !== 'graph', { 'data-view': 'list' })}${toggle(text('graph', '关系图'), 'directory-view', state.mode === 'graph', { 'data-view': 'graph' })}</div>`;
    return `<section class="ontology-page ont-premium ont-directory-compact${state.mode === 'graph' ? ' ont-directory-graph' : ''}"><div class="ont-library-scroll" data-ontology-scroll>
      <header class="ont-library-heading">${title}<div class="ont-library-toolbar"><div class="ont-toolbar-main">${viewToggle}${scopePicker}</div><div class="ont-toolbar-end"><div class="ont-search-line ontology-ws-search"><label class="sr-only" for="ontology-search-input">${esc(text('search', '搜索本体、人物、项目或关系'))}</label><div class="search">${root.uiIconHtml('search', 'ont-search-glyph')}${root.uiInput({ id: 'ontology-search-input', type: 'search', value: state.searchQuery || '', placeholder: text('directorySearchPlaceholder', '搜索本体或其中的内容'), attrs: { 'data-ontology-field': 'search' } })}<span${query ? '' : ' hidden'}>${root.uiIconButton({ label: text('clearSearch', '清空本体搜索'), icon: 'x', size: 'sm', className: 'search-clear', attrs: { 'data-ontology-action': 'directory-clear-search' } })}</span></div></div>${button(text('refresh', '刷新'), 'refresh-directory', 'secondary', { title: `${text('updatedAt', '更新时间')} ${loadedAt}`.trim() }, 'refresh')}</div></div></header>
      <div data-ontology-directory-content>${state.mode === 'graph' ? graphCanvas(state.graph, false) : query ? `<div class="ont-search-results">${[...matching.filter(m => !results.some(r => r.id === m.id)).map(m => ({ id: m.id, name: m.name, kind: 'module', moduleId: m.id })), ...results].map(searchResultRow).join('') || `<div class="ontology-ws-search-empty">${esc(text('noSearchResults', '没有找到匹配内容。'))}</div>`}</div>` : `<div class="ont-module-cards">${visibleModules.map(card).join('')}${!query && state.modulePage === 0 && visibleModules.length ? createCard() : ''}${visibleModules.length ? '' : `<div class="empty"><h3>${esc(text('emptyTitle', '从一个领域开始'))}</h3><p>${esc(text('directoryEmptyHint', '人物、项目、事实与规则，都可以从这里建立联系。'))}</p>${button(text('createModule', '创建本体'), 'create-module')}</div>`}</div>${pageControls('modules', state.modulePage, matching.length, modulePageSize)}`}</div>
      </div></section>`;
  }
  function modulePage() {
    const module = state.doc.records[state.moduleId];
    if (!module || module.kind !== 'module') { state.page = 'list'; return listPage(); }
    const dateView = state.at !== root.CogOntologyDocument.today();
    const readOnly = dateView || module.source.kind === 'legacy' || module.status !== 'active';
    const isGraph = state.tab === 'graph';
    const backControl = isGraph
      ? pageControl(text('allModules', '全部本体'), 'back-graph', 'ont-back-button', {}, 'arrow-left')
      : pageControl(text('title', '本体'), 'back-list', 'ont-back-button', {}, 'arrow-left');
    const menu = `${button(text('history', '历史与版本'), 'module-history', 'ghost')}${button(text('queryDate', '按日期查看'), 'document-date', 'ghost')}${button(text('viewSources', '查看来源'), 'document-section', 'ghost', { 'data-section': 'ontology-doc-sources' })}${button(text('export', '导出本体'), 'export', 'ghost')}${module.source.kind === 'legacy' ? '' : moduleMenu(module)}${readOnly ? '' : `${button(text('addDefinition', '添加定义'), 'create-definition', 'ghost')}${button(text('addEntity', '添加对象'), 'create-entity', 'ghost')}${button(text('addFact', '记录关系或事实'), 'create-assertion', 'ghost')}${button(text('addRule', '添加规则'), 'create-rule', 'ghost')}${button(text('createReference', '引用其他本体'), 'create-reference', 'ghost')}`}`;
    return `<section class="ontology-document-workspace ont-premium ${isGraph ? 'ont-is-graph' : 'ont-is-document'}" data-ontology-module-view="${esc(module.id)}"><div class="ont-workbar ontology-document-toolbar">${backControl}<span class="ont-breadcrumb-separator">/</span><span class="ont-breadcrumb-title">${esc(module.name)}</span><span class="grow"></span><div class="ont-document-view-toggle">${pageControl(text('document', '文档'), 'document-view-toggle', '', { 'data-view': 'document', 'aria-pressed': String(!isGraph) })}${pageControl(text('graph', '关系图'), 'document-view-toggle', '', { 'data-view': 'graph', 'aria-pressed': String(isGraph) })}</div><span class="ont-save-caption" data-document-save role="status" aria-live="polite"></span><details class="ont-overflow"><summary aria-label="${esc(text('moduleMore', '本体更多操作'))}">···</summary><div class="ont-menu">${menu}</div></details></div><div data-document-error></div>
      ${dateView ? `<div class="ont-state-notice">${esc(text('asOf', '截至'))} ${esc(state.at)} · ${esc(text('readonly', '只读'))}${button(text('viewCurrentVersion', '返回当前'), 'document-current-date', 'ghost')}</div>` : readOnly ? `<p class="ont-state-notice">${esc(module.source.kind === 'legacy' ? text('legacyDocumentReadOnly', '旧来源内容以只读方式展示，来源与原始记录保持不变。') : text('archivedDocumentReadOnly', '此本体已归档，恢复后可继续编辑。'))}</p>` : ''}
      <div class="ont-workgrid"><div class="ont-document-scroll" data-ontology-scroll>${isGraph ? graphCanvas(null, true) : root.CogOntologyDocument.render({ doc: state.doc, moduleId: module.id, text, esc, drafts: state.editor?.getDrafts() || {}, editable: !readOnly, at: state.at, expandedId: state.documentExpandedId || '', inspector: inlineInspector, openDetails: state.documentDetails || {} })}</div></div></section>`;
  }
  function inlineInspector(record) {
    const readonly = state.at !== root.CogOntologyDocument.today() || record.source?.kind === 'legacy' || record.status !== 'active' || state.doc.records[record.moduleId]?.status !== 'active';
    const attrs = { 'data-record-id': record.id };
    const actions = readonly ? '' : (record.kind === 'assertion' ? `${button(text('correctFact', '以前记错了 · 纠正'), 'correct-fact', 'primary', attrs)}${button(text('changeFact', '从某天起变化了'), 'change-fact', 'secondary', attrs)}` : button(text('editDetails', '编辑字段'), 'edit-record', 'secondary', attrs)) + button(text('archiveKeepHistory', '停用并保留历史'), 'archive-record', 'ghost', attrs);
    return `<aside class="ont-inspector ca-detail-card" role="region" aria-label="${esc(text('recordDetails', '本体记录详情'))}"><header class="detail-head ca-detail-head"><div class="ca-detail-title-row"><h2>${esc(recordName(record))}</h2>${pageControl(text('closeDetails', '关闭记录详情'), 'document-disclosure', '', { 'data-record-id': record.id })}</div><p>${esc(text(record.kind, record.kind))} · v${record.version}</p></header><div class="detail-body ca-detail-body">${detailRows(record)}${provenance(record)}${button(text('history', '查看版本与管理记录'), 'record-details', 'ghost', attrs)}${record.kind === 'entity' ? button(text('viewObjectGraph', '查看邻近关系'), 'object-graph', 'secondary', attrs) : ''}</div><footer class="detail-actions ca-detail-footer">${actions}</footer></aside>`;
  }
  function candidateScopeAllowsModule(candidate, module) {
    if (!module || module.kind !== 'module' || module.source.kind === 'legacy') return false;
    const policy = candidate.scopePolicy;
    if (!policy) return true;
    if (policy.agentIds !== undefined || policy.roleIds !== undefined || policy.purposeTags !== undefined
      || policy.conversationKinds !== undefined || policy.fileKinds !== undefined) return false;
    if (policy.projectIds !== undefined && (policy.workspaceIds !== undefined || module.scope.kind !== 'project'
      || !module.scope.id || !policy.projectIds.includes(module.scope.id))) return false;
    if (policy.workspaceIds !== undefined && (module.scope.kind !== 'workspace'
      || !module.scope.id || !policy.workspaceIds.includes(module.scope.id))) return false;
    return true;
  }
  function candidateLinkedRecords(candidate) {
    return Object.values(state.doc.records).filter(record => record.source.kind === 'candidate' && record.source.recordId === candidate.id);
  }
  function candidateOrganizePage() {
    const candidate = state.candidateDraft;
    if (!candidate) { state.page = 'list'; return listPage(); }
    const linked = candidateLinkedRecords(candidate);
    const completed = candidate.status === 'integrated';
    const linkedModuleIds = [...new Set(linked.filter(record => record.kind !== 'module').map(record => record.moduleId))];
    const targetModuleId = state.candidateModuleId || linkedModuleIds[0] || '';
    const module = targetModuleId ? state.doc.records[targetModuleId] : null;
    const sourceText = String(candidate.value || candidate.judgment || '').slice(0, 4000);
    const sourceRefs = (Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : []).filter(ref => !/^ontimport-[a-f0-9]{64}$/.test(ref.id || ''));
    const sourceHtml = `<section class="ontology-ws-candidate-source"><div class="ontology-ws-candidate-source-meta"><span>${esc(text('candidateSource', '待我处理候选'))}</span>${esc(candidate.suggestedType || '')} · ${esc(candidate.suggestedScope || '')}</div><h2>${esc(candidate.summary || candidate.judgment || text('unknown', '未命名候选'))}</h2><pre>${esc(sourceText)}</pre>${sourceRefs.length ? `<small>${esc(text('source', '来源'))}：${sourceRefs.slice(0, 5).map(ref => esc(ref.title || `${ref.kind}:${ref.id}`)).join(' · ')}</small>` : ''}</section>`;
    const back = button(text('backToReview', '← 返回待我处理'), 'candidate-back');
    if (completed) {
      return `${pageHeader({ kicker: text('candidateSource', '待我处理候选'), title: text('candidateIntegratedTitle', '已整理到本体'), description: text('candidateIntegratedHint', '候选已转成结构化本体记录；来源与记录链接已保留。'), back, actions: '' })}${sourceHtml}<section class="ontology-ws-candidate-linked"><h2>${esc(text('candidateLinkedRecords', '整理到本体的记录'))}</h2>${renderRecordList(linked)}</section>`;
    }
    return `${pageHeader({ kicker: text('candidateSource', '待我处理候选'), title: text('candidateUnavailableTitle', '这条候选目前不能继续整理'), description: text('candidateUnavailableHint', '请先回到待我处理查看它的状态。'), back, actions: '' })}${sourceHtml}${linked.length ? `<section class="ontology-ws-candidate-linked"><h2>${esc(text('candidateLinkedRecords', '整理到本体的记录'))}</h2>${renderRecordList(linked)}</section>` : ''}`;
  }

  function renderRecordList(rows) {
    if (!rows.length) return `<div class="ontology-ws-empty-inline">${esc(text('boxEmpty', '这里还没有内容。'))}</div>`;
    const pageSize = 100, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    state.recordPage = Math.min(state.recordPage || 0, pageCount - 1);
    const start = state.recordPage * pageSize;
    const visible = rows.slice(start, start + pageSize);
    return `<div class="ontology-ws-record-list">${visible.map(r => `<article class="ontology-ws-record-row"><span class="ontology-ws-record-kind">${esc(text(r.kind, r.kind === 'entity' ? '对象' : r.kind === 'assertion' ? '事实' : r.kind === 'rule' ? '规则' : r.kind === 'reference' ? '引用' : r.definitionKind === 'type' ? '类型' : r.definitionKind === 'relation' ? '关系定义' : '属性定义'))}</span>${button(recordName(r), 'open-record', 'ghost', { 'data-record-id': r.id })}<span class="ontology-ws-record-detail">${esc('description' in r ? r.description : r.kind === 'rule' ? r.requirement : r.kind === 'assertion' ? `${r.validity.from || text('unknownDate', '开始时间未确认')} → ${r.validity.until || text('ongoing', '持续有效')}` : '')}</span><span class="ontology-ws-row-arrow" aria-hidden="true">›</span></article>`).join('')}</div>${pageControls('records', state.recordPage, rows.length, pageSize)}`;
  }
  function graphPage() {
    const graph = state.graph;
    return `${pageHeader({ kicker: 'ONTOLOGY WORKSPACE', title: text('globalGraphTitle', '本体关系图谱'), description: text('globalGraphHint', '只展示本体之间明确建立的引用关系。'), back: button(text('backModules', '← 本体列表'), 'back-list'), actions: '' })}
      ${graphCanvas(graph, false)}`;
  }
  function graphCanvas(_graph, local) {
    return `<div class="ontology-document-graph" data-ontology-graph-mount data-module-id="${esc(local ? state.moduleId : '')}"></div>`;
  }
  function moduleScope(id) { const module = state.doc.records[id]; return module ? text(module.scope.kind, module.scope.kind === 'personal' ? '个人本体' : module.scope.kind === 'project' ? '项目本体' : '工作区本体') : ''; }
  function factAt(record, at) {
    if (record.status !== 'active') return false;
    const from = record.validity.from && (record.validity.precision === 'month' ? record.validity.from + '-01' : record.validity.from);
    const until = record.validity.until && (record.validity.precision === 'month' ? record.validity.until + '-01' : record.validity.until);
    return (!from || at >= from) && (!until || at < until);
  }
  function entityContent(record) {
    const all = Object.values(state.doc.records);
    const related = all.filter(item => item.kind === 'assertion' && state.doc.records[item.moduleId]?.status === 'active'
      && (item.subjectId === record.id || item.object.kind === 'entity' && item.object.id === record.id));
    const current = related.filter(item => factAt(item, state.at));
    const rules = all.filter(item => item.kind === 'rule' && item.status === 'active' && item.moduleId === record.moduleId);
    const controls = `<div class="ontology-ws-detail-actions"><label>${esc(text('queryDate', '查询日期'))} ${root.uiInput({ id: 'ontology-object-date', type: 'date', value: state.at, attrs: { 'data-ontology-field': 'objectAt' } })}</label>${button(text('viewObjectGraph', '查看对象图谱'), 'object-graph', 'secondary', { 'data-record-id': record.id })}${record.status === 'active' && state.doc.records[record.moduleId]?.status === 'active' && record.source.kind !== 'legacy' ? button(text('addFact', '补充关系或事实'), 'create-assertion') : ''}</div>`;
    const nav = tabs([['current', text('currentInfo', '当前信息')], ['relations', text('relations', '关系')], ['rules', text('applicableRules', '相关规则')], ['usage', text('taskUsage', '任务采用')]], state.objectTab || 'current', text('objectViews', '对象详情'), { 'data-ontology-tabs': 'object' });
    let content;
    if (state.objectTab === 'usage') content = state.usage?.length ? state.usage.map(row => `<article class="ontology-ws-detail-section"><p>${esc(row.taskRunId)} · ${esc(text('consumed', '已进入最终成果'))}</p><p>${esc(row.recordId)} @ v${row.recordVersion} · ${esc(row.createdAt)}</p><p>${esc(text('effectUnknown', '外部执行与效果尚无验证证据。'))}</p>${button(text('viewUsedVersion', '查看当时版本'), 'used-version', 'secondary', { 'data-record-id': row.recordId, 'data-version': String(row.recordVersion) })}</article>`).join('') : `<p>${esc(text('noTaskUsage', '还没有可核对的任务采用记录。'))}</p>`;
    else if (state.objectTab === 'rules') content = `<p>${esc(text('rulesReferenceOnly', '以下是本体的相关规则；条件适用与实际检查由本次任务分别判断，不能视为检查通过。'))}</p>${renderRecordList(rules)}`;
    else content = `${state.objectTab === 'relations' ? '' : detailRows(record)}${renderRecordList(current)}${current.some(item => item.validity.from === null) ? `<p role="status">${esc(text('unknownDate', '开始时间未确认'))}</p>` : ''}`;
    return `${controls}${nav}<section class="ontology-ws-detail-section">${content}</section>`;
  }
  function recordPage() {
    const record = state.recordSnapshot || state.doc.records[state.recordId];
    if (!record) { state.page = 'module'; return modulePage(); }
    const history = state.history || [];
    const merged = [...(state.doc.history || [])].reverse().find(entry => entry.after.id === record.id)?.intent === 'merge_source';
    const isLegacy = record.source.kind === 'legacy' || Boolean(state.recordVersion) || state.doc.records[record.moduleId]?.status !== 'active';
    const legacyAction = record.source.kind === 'legacy' ? `<section class="ontology-ws-legacy-note"><p>${esc(text('legacyReadOnly', '这条内容来自旧本体，只读展示并保留原始数据。'))}</p></section>` : '';
    const summary = record.kind === 'assertion'
      ? `<section class="ontology-ws-detail-section"><h2>${esc(record.status === 'corrected' || record.status === 'archived' || record.validity.until && state.at >= record.validity.until ? text('historicalFact', '历史事实') : text('currentFact', '当前事实'))}</h2><p>${esc(recordName(record))}</p><p>${esc(record.validity.from || text('unknownDate', '开始时间未确认'))} → ${esc(record.validity.until || text('ongoing', '持续有效'))}</p>${provenance(record)}<p>${esc(text(record.status, record.status))}</p>${isLegacy || record.status !== 'active' ? '' : `<div class="ontology-ws-detail-actions">${button(text('changeFact', '从某天起变更'), 'change-fact', 'primary')}${button(text('correctFact', '纠正记错的事实'), 'correct-fact')}</div>`}</section>`
      : `<section class="ontology-ws-detail-section"><h2>${esc(text('details', '详情'))}</h2>${record.kind === 'entity' && !state.recordVersion ? '' : detailRows(record)}${provenance(record)}</section><div class="ontology-ws-detail-actions">${!isLegacy && !merged && ['entity', 'definition', 'rule', 'reference'].includes(record.kind) ? button(text('edit', '编辑'), 'edit-record', 'primary') : ''}${!isLegacy && record.status === 'active' ? button(text('archive', '停用'), 'archive-record', 'danger') : ''}${!isLegacy && record.kind === 'entity' && record.status === 'active' ? button(text('mergeIdentity', '合并确认为同一对象的身份'), 'merge-identity', 'secondary', {}, 'git-merge') : ''}</div>`;
    return `<div class="ca-detail-card ca-detail-record-page">${pageHeader({ kicker: text(record.kind, record.kind === 'entity' ? '具体对象' : record.kind === 'assertion' ? '关系或事实' : '本体定义'), title: recordName(record), back: button(text('backModule', '← 返回本体'), 'back-module'), actions: '' })}
      <div class="ca-detail-body">${!isLegacy && record.status === 'archived' ? merged ? button(text('undoMerge', '撤销身份合并'), 'undo-merge', 'secondary', {}, 'undo') : button(text('restoreRecord', '恢复停用内容'), 'restore-record', 'secondary') : ''}${state.recordVersion ? `<p role="status">${esc(text('historicalReadOnly', '正在查看当时版本，当前内容未改变。'))} v${record.version} ${button(text('viewCurrentVersion', '查看当前版本'), 'used-current', 'secondary', { 'data-record-id': record.id })}</p>` : ''}${record.kind === 'entity' && !state.recordVersion ? entityContent(record) : ''}${summary}${!isLegacy && record.status === 'active' ? `<div class="ontology-ws-detail-actions">${button(text('deleteRecoverable', '删除（可恢复）'), 'delete-record', 'danger', {}, 'trash-2')}</div>` : ''}${state.recordVersion ? '' : legacyAction}<section class="ontology-ws-history"><h2>${esc(text('history', '变更记录'))}</h2>${state.historyTruncated ? `<p role="status">${esc(text('historyTruncated', '当前显示最近100条变更，完整历史仍保留在主档。'))}</p>` : ''}${history.length ? history.map(entry => `<article><time>${esc(entry.recordedAt)}</time><strong>${esc(text(entry.intent, entry.intent))}</strong><p>${esc(entry.before ? recordName(entry.before) : text('created', '创建记录'))} → ${esc(recordName(entry.after))}</p><p>${esc(entry.after.source.label)} · v${entry.after.version}</p></article>`).join('') : `<p>${esc(isLegacy ? text('legacyHistory', '旧资料没有提供可验证的版本历史。') : text('noHistory', '暂无变更记录'))}</p>`}</section></div></div>`;
  }

  async function loadGraph() {
    // 兼容旧深链；图谱内容和文档始终来自同一份主档快照。
    return state?.doc;
  }
  async function enterGraph(global) {
    state.page = global ? 'list' : 'module';
    if (global) state.mode = 'graph'; else state.tab = 'graph';
    render();
  }
  async function openModuleGraph(moduleId) {
    const module = state?.doc?.records?.[moduleId];
    if (!module || module.kind !== 'module') return;
    const current = state, request = ++current.recordRequest;
    current.listGraphSelection = { kind: 'node', id: moduleId };
    clearTimeout(current.documentRenderTimer);
    current.documentNeedsRender = false;
    await current.editor?.flush();
    if (state !== current || request !== current.recordRequest) return;
    clearTimeout(current.documentRenderTimer);
    current.documentNeedsRender = false;
    rememberRecentModule(moduleId);
    current.page = 'module'; current.tab = 'graph'; current.moduleId = moduleId;
    current.recordId = ''; current.recordPage = 0; current.documentExpandedId = '';
    current.graphFocusId = ''; current.graphSearchQuery = ''; current.graphSearchResults = [];
    render();
  }
  async function commit(actions) {
    if (state.rebaseApproved) actions = actions.map(action => action.expectedVersion && state.doc.records[action.recordId] ? { ...action, expectedVersion: state.doc.records[action.recordId].version } : action);
    if (state.page === 'candidate-organize') return false;
    const current = state;
    const fingerprint = JSON.stringify(actions);
    if (!current.pendingCommand || current.pendingCommand.fingerprint !== fingerprint) {
      current.pendingCommand = { fingerprint, command: { commandId: `ont-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, expectedRevision: current.doc.revision, actions } };
    }
    const command = current.pendingCommand.command;
    if (current.pendingCommand.approved !== true) {
      const preview = await invoke('cognition.ontology.command.preview', { command });
      if (state !== current) return false;
      const affected = Object.values(current.doc.records).filter(record => command.actions.some(action => action.recordId
        && record.id !== action.recordId && JSON.stringify(record).includes(`"${action.recordId}"`)));
      const lines = preview.changes.map(record => `${text(record.kind, record.kind)} · ${recordName(record)} · ${record.id} @ v${record.version}`);
      const approved = await root.uiConfirm?.(`${text('savePreview', '以下变更将写入长期认知与历史。后续任务只能使用当前有效且有权限的内容。')}\n${lines.join('\n')}\n${text('source', '依据')}：${command.actions.map(action => action.sourceLabel).join('；')}\n${text('affectedRecords', '当前关联内容数量')}：${affected.length}\n${affected.slice(0, 20).map(recordName).join(' · ')}\n${text(command.actions.some(action => action.intent === 'merge' || action.intent === 'undo_merge') ? 'mergeBoundary' : 'restoreBoundary', command.actions.some(action => action.intent === 'merge' || action.intent === 'undo_merge') ? '合并只重定向当前有效的关系、规则与当前引用，保留双方身份及历史。固定版本引用须先核对。撤销仅在受影响记录未继续修改时可执行。' : '停用会保留历史，可在原本体的历史或停用内容中恢复。恢复会重新校验当前定义、权限和冲突。')}`);
      if (!approved || state !== current) return false;
      current.pendingCommand.approved = true; current.rebaseApproved = false;
    }
    const result = await invoke('cognition.ontology.command.commit', { command });
    if (state !== current) return result;
    state.modulePage = 0; state.recordPage = 0;
    await refresh();
    current.pendingCommand = null;
    const factAction = actions.find(action => action.intent === 'change' || action.intent === 'correct');
    if (factAction) {
      const originId = current.originObjectId || current.doc.records[factAction.recordId]?.subjectId;
      if (originId) { current.originObjectId = ''; await openRecord(originId); }
    } else if (current.page === 'record' && current.recordId) await openRecord(current.recordId);
    root.uiToast?.(text('savedReadBack', '已保存并回读确认。'), { variant: 'success' });
    return result;
  }
  function sourceLabel() { return text('userConfirmed', '用户确认'); }
  function openDialog({ title, body, trigger, onSubmit }) {
    const modal = root.uiModal({ title, closeLabel: text('close', '关闭'), size: 'md', initialFocus: '.ontology-ws-form input,.ontology-ws-form textarea,.ai-select-trigger',
      bodyHtml: `<form class="ontology-ws-form">${body}<p class="ontology-ws-form-error" role="alert" hidden></p><div class="ontology-ws-form-actions">${button(text('cancel', '取消'), 'dialog-cancel')}${button(text('save', '保存'), 'dialog-save', 'primary')}</div></form>` });
    void modal.catch(() => {});
    const dialogState = state;
    const overlay = modal.overlay, form = overlay.querySelector('form'), selectionValues = {};
    if (typeof root.hydrateUiFormSelects === 'function') {
      const callbacks = {};
      for (const host of form.querySelectorAll('[data-ui-select]')) {
        try { selectionValues[host.id] = JSON.parse(host.dataset.uiSelectConfig || '{}').value || ''; } catch (_) { selectionValues[host.id] = ''; }
        callbacks[host.id] = value => { selectionValues[host.id] = value; };
      }
      root.hydrateUiFormSelects(form, callbacks);
    }
    overlay.addEventListener('click', async event => {
      const control = event.target.closest('[data-ontology-action]'); if (!control) return;
      const action = control.dataset.ontologyAction;
      if (action === 'dialog-cancel') { dialogState.pendingCommand = null; dialogState.rebaseApproved = false; dialogState.candidateBatchId = ''; modal.close('cancel', 'close'); return; }
      if (action === 'open-review') { modal.close('cancel', 'close'); return handleAction(action, control); }
      if (action === 'archive-history') { modal.close('cancel', 'close'); return handleAction(action, control); }
      if (action !== 'dialog-save' || control.disabled) return;
      if (state !== dialogState) { modal.close('cancel', 'close'); return; }
      event.preventDefault();
      const data = {};
      for (const input of form.querySelectorAll('[data-ontology-field]')) data[input.dataset.ontologyField] = input.value;
      Object.assign(data, selectionValues);
      for (const group of form.querySelectorAll('[data-ontology-multi-group]')) {
        const name = group.dataset.ontologyMultiGroup;
        data[name] = [...group.querySelectorAll('[data-ontology-multi]')].filter(input => input.checked).map(input => input.value);
      }
      const error = form.querySelector('.ontology-ws-form-error');
      try {
        control.disabled = true;
        error.hidden = false; error.setAttribute?.('role', 'status'); error.textContent = text('saving', '正在处理，请稍候…');
        if (form.dataset.baselineChanged === 'true') {
          const approved = await root.uiConfirm?.(text('reviewChangedBaseline', '本体已被其他操作修改。页面已更新，请核对当前内容及本表单后确认继续提交。'));
          if (!approved) { error.hidden = true; error.textContent = ''; control.disabled = false; return; }
          delete form.dataset.baselineChanged; dialogState.rebaseApproved = true;
        }
        const submitted = await onSubmit(data);
        if (submitted === false) { error.hidden = true; error.textContent = ''; control.disabled = false; return; }
        modal.close('saved', 'action');
      }
      catch (err) {
        if (err.code === 'baseline_changed' && state === dialogState) {
          dialogState.pendingCommand = null; dialogState.candidateBatchId = ''; form.dataset.baselineChanged = 'true';
          try { await refresh(); } catch (_) { /* Keep the user's form even when reloading fails. */ }
        }
        error.hidden = false; error.textContent = err.message || text('error', '操作未完成，请稍后重试。');
        if (err.code === 'capacity_exceeded' && err.details?.remedy === 'archive_history') {
          error.innerHTML = `${esc(err.message || text('error', '操作未完成，请稍后重试。'))} ${button(text('archiveHistory', '归档旧历史…'), 'archive-history', 'secondary')}`;
        }
        control.disabled = false; }
    });
    return modal;
  }
  function openModuleDialog(trigger, record) {
    const body = `${field(text('name', '名称'), 'name', record?.name || '')}${textarea(text('description', '简介'), 'description', record?.description || '')}${select(text('scope', '范围'), 'scope', [
      { value: 'personal', label: text('personal', '个人') }, { value: 'project', label: text('project', '项目') }, { value: 'workspace', label: text('workspace', '工作区') },
    ], record?.scope.kind || 'personal')}${field(text('scopeId', '项目或工作区标识'), 'scopeId', record?.scope.id || '', 'text', text('scopeIdHint', '个人本体无需填写。'))}${select(text('access', '谁可以在任务中使用'), 'access', [
      { value: 'task', label: text('taskAccess', '认知资产可按引用供任务使用') }, { value: 'owner_only', label: text('privateAccess', '仅自己查看，不提供给任务') },
    ], record?.access || 'task')}`;
    return openDialog({ title: record ? text('editModule', '编辑本体') : text('createModuleTitle', '创建本体'), body, trigger, onSubmit: data => {
      if (!data.name.trim()) throw new Error(text('requiredName', '请填写名称。'));
      const scope = { kind: data.scope, ...(data.scope === 'personal' ? {} : { id: data.scopeId.trim() }) };
      if (data.scope !== 'personal' && !scope.id) throw new Error(text('requiredScope', '该范围需要填写标识。'));
      const patch = { name: data.name.trim(), description: data.description.trim(), scope, access: data.access };
      return commit([record ? { intent: 'update', recordId: record.id, expectedVersion: record.version, patch, sourceLabel: sourceLabel() }
        : { intent: 'create', record: { kind: 'module', ...patch }, sourceLabel: sourceLabel() }]);
    } });
  }
  function openDefinitionDialog(trigger, initialKind = 'type', record) {
    const typeOptions = usableRecords('definition').filter(r => r.definitionKind === 'type').map(r => ({ value: r.id, label: choiceLabel(r) }));
    const body = `${field(text('name', '名称'), 'name', record?.name || '')}${textarea(text('description', '说明'), 'description', record?.description || '')}${select(text('definitionKind', '定义类型'), 'definitionKind', [
      { value: 'type', label: text('type', '概念类型') }, { value: 'relation', label: text('relation', '对象之间的关系') }, { value: 'attribute', label: text('attribute', '对象的属性') },
    ], record?.definitionKind || initialKind)}${select(text('valueType', '关系值类型'), 'valueType', [
      { value: 'entity', label: text('otherEntity', '另一个对象') }, { value: 'text', label: text('text', '文字') }, { value: 'number', label: text('number', '数字') }, { value: 'date', label: text('date', '日期') }, { value: 'boolean', label: text('boolean', '是或否') },
    ], record?.valueType || 'entity')}${typeChoices(text('subjectTypes', '起点对象类型'), 'subjectTypes', typeOptions, record?.subjectTypes)}${typeChoices(text('objectTypes', '终点对象类型'), 'objectTypes', typeOptions, record?.objectTypes)}${select(text('cardinality', '对象数量'), 'cardinality', [{ value: 'one', label: text('one', '一个') }, { value: 'many', label: text('many', '多个') }], record?.cardinality || 'many')}${select(text('cardinalityAnchor', '单值约束针对'), 'cardinalityAnchor', [{ value: 'subject', label: text('subject', '起点对象') }, { value: 'object', label: text('object', '终点对象') }], record?.cardinalityAnchor || 'subject')}`;
    return openDialog({ title: record ? text('editDefinition', '编辑定义') : text('addDefinition', '添加定义'), body, trigger, onSubmit: data => {
      const valueType = data.definitionKind === 'type' ? 'entity' : data.valueType;
      const patch = { name: data.name.trim(), description: data.description.trim(), definitionKind: data.definitionKind, access: record?.access || moduleAccess(),
        subjectTypes: data.subjectTypes || (record?.subjectTypes?.length > 1 && data.subjectType === record.subjectTypes[0] ? record.subjectTypes : data.subjectType ? [data.subjectType] : []),
        objectTypes: data.objectTypes || (record?.objectTypes?.length > 1 && data.objectType === record.objectTypes[0] ? record.objectTypes : data.objectType ? [data.objectType] : []), valueType,
        cardinality: data.cardinality, cardinalityAnchor: valueType === 'entity' ? data.cardinalityAnchor : 'subject' };
      return commit([record ? { intent: 'update', recordId: record.id, expectedVersion: record.version, patch, sourceLabel: sourceLabel() }
        : { intent: 'create', record: { kind: 'definition', moduleId: state.moduleId, ...patch }, sourceLabel: sourceLabel() }]);
    } });
  }
  function openEntityDialog(trigger, record) {
    const typeOptions = usableRecords('definition').filter(r => r.definitionKind === 'type').map(r => ({ value: r.id, label: choiceLabel(r) }));
    if (!typeOptions.length && !record) { root.uiToast?.(text('createTypeFirst', '请先在 TBox 中创建一个概念类型。'), { variant: 'warning' }); state.tab = 'T'; render(); return null; }
    const typeId = record?.typeId || typeOptions[0]?.value || '';
    const body = `${field(text('name', '名称'), 'name', record?.name || '')}${textarea(text('description', '说明'), 'description', record?.description || '')}${select(text('type', '所属类型'), 'typeId', typeOptions, typeId)}${field(text('aliases', '别名，用逗号分隔'), 'aliases', record?.aliases?.join(', ') || '')}${select(text('access', '谁可以在任务中使用'), 'access', [
      { value: 'task', label: text('taskAccess', '认知资产可按引用供任务使用') }, { value: 'owner_only', label: text('privateAccess', '仅自己查看，不提供给任务') },
    ], record?.access || moduleAccess())}`;
    return openDialog({ title: record ? text('editEntity', '编辑对象') : text('addEntity', '添加对象'), body, trigger, onSubmit: data => {
      if (!data.name.trim() || !data.typeId) throw new Error(text('requiredEntityFields', '名称和所属类型为必填项。'));
      const patch = { ...(record ? {} : { moduleId: state.moduleId }), typeId: data.typeId, name: data.name.trim(), description: data.description.trim(), aliases: data.aliases.split(',').map(x => x.trim()).filter(Boolean), identityStatus: record?.identityStatus || 'confirmed', access: data.access };
      return record ? commit([{ intent: 'update', recordId: record.id, expectedVersion: record.version, patch: { typeId: patch.typeId, name: patch.name, description: patch.description, aliases: patch.aliases, access: patch.access }, sourceLabel: sourceLabel() }])
        : commit([{ intent: 'create', record: { kind: 'entity', ...patch }, sourceLabel: sourceLabel() }]);
    } });
  }
  function openMergeDialog(trigger) {
    const record = state.doc.records[state.recordId];
    const choices = Object.values(state.doc.records).filter(other => other.kind === 'entity' && other.id !== record.id
      && other.status === 'active' && other.identityStatus === 'confirmed' && other.moduleId === record.moduleId
      && other.typeId === record.typeId && other.access === record.access)
      .map(other => ({ value: other.id, label: `${other.name} · ${other.description || other.id} · ${other.id} @ v${other.version}` }));
    if (!choices.length) { root.uiToast?.(text('noMergeTarget', '没有同本体、同类型、同权限的可合并对象。'), { variant: 'info' }); return; }
    return openDialog({ title: text('mergeIdentity', '合并确认为同一对象的身份'), trigger,
      body: `<p>${esc(record.name)} · ${esc(record.id)} @ v${record.version}</p>${select(text('mergeTarget', '保留的确切对象'), 'mergeTarget', choices, '')}${textarea(text('identityEvidence', '确认是同一对象的依据'), 'identityEvidence', '')}<p>${esc(text('mergeBoundary', '合并只重定向当前有效的关系、规则与当前引用，保留双方身份及历史。固定版本引用须先核对。撤销仅在受影响记录未继续修改时可执行。'))}</p>`,
      onSubmit: data => {
        const target = state.doc.records[data.mergeTarget];
        if (!target || data.identityEvidence.trim().length < 5) throw new Error(text('mergeEvidenceRequired', '请选择确切对象，并填写至少5个字符的身份依据。'));
        return commit([{ intent: 'merge', recordId: record.id, expectedVersion: record.version, targetId: target.id,
          expectedTargetVersion: target.version, sourceLabel: data.identityEvidence.trim() }]);
      } });
  }
  function openAssertionDialog(trigger) {
    const entities = usableRecords('entity').map(r => ({ value: r.id, label: choiceLabel(r) }));
    const predicates = usableRecords('definition').filter(r => r.definitionKind !== 'type').map(r => ({ value: r.id, label: `${choiceLabel(r)} · ${r.valueType}` }));
    if (!entities.length || !predicates.length) { state.box = 'T'; state.tab = 'T'; render(); root.uiToast?.(text('createDefinitionFirst', '请先创建关系定义和具体对象。'), { variant: 'warning' }); return null; }
    const body = `${select(text('subject', '对象'), 'subjectId', entities, state.page === 'record' && state.doc.records[state.recordId]?.kind === 'entity' ? state.recordId : '')}${select(text('predicate', '关系或属性'), 'definitionId', predicates)}${select(text('valueType', '关联对象'), 'objectId', [{ value: '', label: text('chooseValueTypeFirst', '选择定义后再填写值') }, ...entities])}${field(text('value', '事实值（实体关系请使用上方关联对象）'), 'value')}${select(text('precision', '日期精度'), 'precision', [{ value: 'day', label: text('dayPrecision', '精确到日') }, { value: 'month', label: text('monthPrecision', '精确到月') }], 'day')}${field(text('validFrom', '从哪天开始生效'), 'validFrom', '', 'text', text('validFromHint', '不知道开始日期时留空，系统会标为待确认。'))}${select(text('access', '谁可以在任务中使用'), 'access', [
      { value: 'task', label: text('taskAccess', '认知资产可按引用供任务使用') }, { value: 'owner_only', label: text('privateAccess', '仅自己查看，不提供给任务') },
    ], moduleAccess())}`;
    return openDialog({ title: text('addFact', '记录关系或事实'), body, trigger, onSubmit: data => {
      const predicate = state.doc.records[data.definitionId]; if (!data.subjectId || !predicate || predicate.kind !== 'definition') throw new Error(text('requiredEntityFields', '请选择对象和关系定义。'));
      let value;
      if (predicate.valueType === 'entity') { if (!data.objectId) throw new Error(text('chooseEntity', '请选择关联对象。')); value = { kind: 'entity', id: data.objectId }; }
      else if (predicate.valueType === 'number') { if (!data.value.trim()) throw new Error(text('invalidNumber', '请输入有效数字。')); value = { kind: 'literal', valueType: 'number', value: Number(data.value) }; if (!Number.isFinite(value.value)) throw new Error(text('invalidNumber', '请输入有效数字。')); }
      else if (predicate.valueType === 'boolean') {
        const raw = data.value.trim().toLowerCase();
        if (!['true', 'false', text('yes', '是'), text('no', '否')].includes(raw)) throw new Error(text('invalidBoolean', '请输入 true 或 false（是或否）。'));
        value = { kind: 'literal', valueType: 'boolean', value: raw === 'true' || raw === text('yes', '是') };
      }
      else value = { kind: 'literal', valueType: predicate.valueType, value: data.value };
      return commit([{ intent: 'create', record: { kind: 'assertion', moduleId: state.moduleId, subjectId: data.subjectId, definitionId: data.definitionId, object: value, access: data.access,
        validity: { from: data.validFrom || null, until: null, precision: data.precision || 'day', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } }, sourceLabel: sourceLabel() }]);
    } });
  }
  function openRuleDialog(trigger, record) {
    const entities = usableRecords('entity').map(r => ({ value: r.id, label: choiceLabel(r) }));
    const body = `${field(text('name', '规则名称'), 'name', record?.name || '')}${textarea(text('requirement', '规则内容'), 'requirement', record?.requirement || '')}${select(text('conditionKind', '适用条件'), 'conditionKind', [
      { value: '', label: text('noCondition', '所有任务') }, { value: 'purpose', label: text('taskPurpose', '任务目的') }, { value: 'taskKind', label: text('taskKind', '任务类型') }, { value: 'entityId', label: text('taskEntity', '涉及对象') },
    ], record?.condition?.kind === 'task' ? record.condition.field : '')}${field(text('conditionValue', '条件值'), 'conditionValue', record?.condition?.kind === 'task' ? record.condition.equals : '')}${select(text('strength', '使用方式'), 'strength', [
      { value: 'required', label: text('required', '必须遵守') }, { value: 'default', label: text('default', '默认采用') }, { value: 'suggestion', label: text('suggestion', '建议') }, { value: 'logic', label: text('logic', '逻辑关系') },
    ], record?.strength || 'default')}${select(text('effect', '执行时帮助'), 'effect', [{ value: 'note', label: text('noteOnly', '显示说明') }, { value: 'section', label: text('requiredSection', '必需章节') }, { value: 'choice', label: text('choiceEffect', '可调整选择项') }, ...entities.map(e => ({ value: `recipient:${e.value}`, label: `${text('includeRecipient', '加入接收人')}：${e.label}` }))], record?.effect.kind === 'include_recipient' ? `recipient:${record.effect.entityId}` : record?.effect.kind === 'required_section' ? 'section' : record?.effect.kind || 'note')}${field(text('effectKey', '选择项名称或章节名称'), 'effectKey', record?.effect.kind === 'choice' ? record.effect.key : record?.effect.kind === 'required_section' ? record.effect.name : '')}${field(text('effectValue', '选择项的值'), 'effectValue', record?.effect.kind === 'choice' ? record.effect.value : '')}${textarea(text('exception', '例外情况'), 'exception', record?.exception || '')}${select(text('access', '谁可以在任务中使用'), 'access', [
      { value: 'task', label: text('taskAccess', '认知资产可按引用供任务使用') }, { value: 'owner_only', label: text('privateAccess', '仅自己查看，不提供给任务') },
    ], record?.access || moduleAccess())}`;
    return openDialog({ title: record ? text('editRule', '编辑规则') : text('addRule', '添加关系或规则'), body, trigger, onSubmit: data => {
      const recipient = data.effect.startsWith('recipient:');
      if (data.conditionKind && !data.conditionValue.trim()) throw new Error(text('requiredCondition', '请填写条件值，不能把未知条件当作所有任务。'));
      const condition = record?.condition && record.condition.kind !== 'task' && !data.conditionKind ? record.condition
        : data.conditionKind ? { kind: 'task', field: data.conditionKind, equals: data.conditionValue.trim() } : null;
      const effect = recipient ? { kind: 'include_recipient', entityId: data.effect.slice('recipient:'.length) }
        : data.effect === 'section' ? { kind: 'required_section', name: data.effectKey.trim() }
          : data.effect === 'choice' ? { kind: 'choice', key: data.effectKey.trim(), value: data.effectValue.trim() } : { kind: 'note' };
      const patch = { name: data.name.trim(), requirement: data.requirement.trim(), strength: data.strength, condition, access: data.access, effect, exception: data.exception.trim() };
      return commit([record ? { intent: 'update', recordId: record.id, expectedVersion: record.version, patch, sourceLabel: sourceLabel() }
        : { intent: 'create', record: { kind: 'rule', moduleId: state.moduleId, ...patch }, sourceLabel: sourceLabel() }]);
    } });
  }
  function openReferenceDialog(trigger, record) {
    const options = modules().filter(m => m.id !== state.moduleId && m.source.kind !== 'legacy' && m.access === 'task').map(m => ({ value: m.id, label: `${m.name} · ${moduleScope(m.id)}` }));
    if (!options.length) { root.uiToast?.(text('noOtherModules', '创建另一个本体后，就可以在这里建立引用。'), { variant: 'info' }); return null; }
    return openDialog({ title: text('createReference', '引用其他本体'), body: `${select(text('targetModule', '要引用的本体'), 'targetModuleId', options, record?.targetModuleId || '')}${select(text('referenceVersion', '引用版本'), 'versionPolicy', [{ value: 'current', label: text('currentReference', '跟随当前版本') }, { value: 'pinned', label: text('pinnedReference', '固定已知版本') }], record?.versionPolicy || 'current')}${field(text('targetVersion', '固定版本号'), 'targetVersion', record?.targetVersion || '', 'number')}<p class="ontology-ws-form-note">${esc(text('referenceHint', '引用建立后，这个本体可以按权限使用对方明确公开的内容。'))}</p>`, trigger, onSubmit: data => {
      const patch = { targetModuleId: data.targetModuleId, versionPolicy: data.versionPolicy || 'current', ...(data.versionPolicy === 'pinned' ? { targetVersion: Number(data.targetVersion) } : {}) };
      if (patch.versionPolicy === 'pinned' && (!Number.isSafeInteger(patch.targetVersion) || patch.targetVersion < 1)) throw new Error(text('invalidNumber', '请输入有效数字。'));
      return commit([record ? { intent: 'update', recordId: record.id, expectedVersion: record.version, patch, sourceLabel: sourceLabel() }
        : { intent: 'create', record: { kind: 'reference', moduleId: state.moduleId, ...patch, access: moduleAccess() }, sourceLabel: sourceLabel() }]);
    } });
  }
  async function openRecord(recordId, version, options = {}) {
    const item = state.doc.records[recordId];
    if (item && !version && !state.candidateDraft && !options.details) {
      if (item.kind === 'module') rememberRecentModule(item.id);
      state.recordId = recordId; state.documentExpandedId = recordId; state.moduleId = item.kind === 'module' ? item.id : item.moduleId;
      state.page = 'module'; state.tab = 'document'; render();
      revealDocument(state.root.querySelector?.(`[data-record-id="${recordId}"]`));
      return;
    }

    const current = state, request = ++current.recordRequest;
    const previous = current.doc.records[current.recordId];
    if (!version && previous?.kind === 'entity' && current.page === 'record' && previous.id !== recordId) current.originObjectId = previous.id;
    current.recordId = recordId; current.recordSnapshot = null;
    const result = await invoke('cognition.ontology.history.get', { recordId, limit: 100, ...(version ? { version } : {}) });
    if (state !== current || request !== current.recordRequest) return;
    if (result.record) {
      if (!version) state.doc.records[result.record.id] = result.record;
      state.recordSnapshot = version ? result.record : null;
      if (result.record.kind !== 'module' && result.record.moduleId) state.moduleId = result.record.moduleId;
    }
    state.history = result.history; state.usage = result.usage || [];
    state.historyTruncated = result.historyTruncated === true; state.recordVersion = version || null; state.objectTab = 'current';
    state.page = 'record';
    if (!version && state.doc.records[recordId]?.kind === 'entity') {
      state.recentIds = [recordId, ...(state.recentIds || []).filter(id => id !== recordId)].slice(0, 20);
      try { root.localStorage?.setItem(`ontology-recent:${state.doc.ownerId}`, JSON.stringify(state.recentIds)); } catch (_) { /* Recent views are optional layout preferences. */ }
    }
    render();
  }
  async function handleAction(action, target) {
    if (!state) return;
    state.root.querySelector?.('.ont-scope')?.removeAttribute('open');
    const current = state;
    if (state.selectionController?.hasDraft() && !state.selectionController.close(false, () => { if (state === current) void handleAction(action, target).catch(showError); })) return;
    if (['back-list', 'back-module', 'open-module', 'open-record', 'search-result', 'select-box', 'candidate-back', 'back-graph'].includes(action)) { state.graphRequest++; state.recordRequest++; }
    const id = target.dataset.recordId || target.closest('[data-record-id]')?.dataset.recordId || '';
    if (action === 'selection-edit') { state.selectionController?.open(id, target.dataset.field); return; }
    if (action === 'document-retry') { await state.editor?.retry(id); return; }
    if (action === 'document-rebase') { await state.editor?.retry(id, true); return; }
    if (action === 'document-discard') { state.editor?.discard(id); render(); return; }
    if (action === 'document-add-toggle') { state.documentAddOpen = !state.documentAddOpen; render(); return; }
    if (action === 'document-view-toggle') { await state.editor?.flush(); state.tab = target.dataset.view || (state.tab === 'graph' ? 'document' : 'graph'); state.documentAddOpen = false; render(); return; }
    if (action === 'directory-view') { if (target.dataset.view === 'graph') await enterGraph(true); else { state.mode = 'list'; render(); } return; }
    if (action === 'directory-scope') { state.scopeFilter = target.dataset.scope; state.showInactive = false; state.modulePage = 0; render(); return; }
    if (action === 'directory-clear-search') { state.searchQuery = ''; state.searchResults = []; state.modulePage = 0; render(); return; }
    if (action === 'refresh-directory') return refresh();
    if (action === 'document-source') {
      const record = state.doc.records[id]; if (!record?.source) return;
      const source = record.source;
      const refs = (source.refs || []).filter(ref => !/^ontimport-[a-f0-9]{64}$/.test(ref.id || '')).map(ref => `<li>${esc(text(ref.kind, ref.kind))} · ${esc(ref.id)}</li>`).join('');
      const modal = root.uiModal({ title: source.label || text('source', '来源'), closeLabel: text('close', '关闭'), bodyHtml: `<div class="ontology-ws-source-text"><p>${esc(text(source.kind, source.kind))}</p>${source.recordId ? `<p>${esc(text('sourceRecord', '来源记录'))}：${esc(source.recordId)}</p>` : ''}${refs ? `<ul>${refs}</ul>` : ''}${provenance(record)}</div>` });
      modal.overlay?.addEventListener('click', event => {
        const action = event.target.closest('[data-ontology-action]');
        if (action) void handleAction(action.dataset.ontologyAction, action).catch(showError);
      });
      void modal.catch(() => {});
      return;
    }
    if (action === 'document-section') {
      const section = state.root.querySelector?.('#' + target.dataset.section);
      let parent = section?.parentElement;
      while (parent && parent !== state.root) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
      revealDocument(section); return;
    }
    if (action === 'document-disclosure') {
      toggleDocumentDisclosure(id, target);
      return;
    }
    if (action === 'document-current-date') { state.at = root.CogOntologyDocument.today(); render(); return; }
    if (action === 'document-date') {
      openDialog({ title: text('queryDate', '按日期查看'), body: `${field(text('queryDate', '查询日期'), 'documentAt', state.at, 'date')}<p class="ontology-ws-form-note">${esc(text('dateViewHint', '按有效时间查看事实；未记录的起点保持未知。'))}</p>`, onSubmit: async data => {
        const date = data.documentAt; if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(text('invalidDate', '请选择有效日期。'));
        state.at = date; render(); return true;
      }, trigger: target }); return;
    }
    if (action === 'module-history') {
      const result = await invoke('cognition.ontology.history.get', { recordId: state.moduleId });
      const rows = result.history || [];
      void root.uiModal({ title: text('history', '历史与版本'), closeLabel: text('close', '关闭'), bodyHtml: `<div class="ontology-ws-history">${rows.map(row => `<article><time>${esc(row.recordedAt)}</time><strong>${esc(text(row.intent, row.intent))} · v${row.after?.version || '—'}</strong><p>${esc(row.after?.source?.label || '')}</p></article>`).join('') || `<p>${esc(text('noHistory', '暂无变更记录'))}</p>`}</div>` }).catch(() => {}); return;
    }

    if (action === 'open-review') { root.CogAssets?.router?.go({ name: 'activity' }); return; }
    if (action === 'toggle-inactive-records') { state.showRecordInactive = !state.showRecordInactive; render(); return; }
    if (action === 'merge-identity') return openMergeDialog(target);
    if (action === 'undo-merge') {
      const record = state.doc.records[state.recordId];
      const merge = [...state.doc.history].reverse().find(entry => entry.after.id === record.id && entry.intent === 'merge_source');
      if (!merge) return;
      await commit([{ intent: 'undo_merge', recordId: record.id, expectedVersion: record.version, mergeCommandId: merge.commandId, sourceLabel: sourceLabel() }]);
      render(); return;
    }
    if (action === 'restore-record') {
      const record = state.doc.records[state.recordId];
      await commit([{ intent: 'restore', recordId: record.id, expectedVersion: record.version, sourceLabel: sourceLabel() }]); render(); return;
    }
    if (action === 'toggle-inactive') { state.showInactive = !state.showInactive; state.mode = 'list'; if (state.showInactive) state.scopeFilter = 'all'; render(); return; }
    if (action === 'module-menu') { state.moduleMenuId = state.moduleMenuId === id ? '' : id; render(); return; }
    if (['delete-module', 'archive-module', 'resume-module'].includes(action)) {
      const module = state.doc.records[id];
      if (!module || module.kind !== 'module' || state.moduleLifecycleBusy) return;
      const current = state;
      current.moduleMenuId = ''; render();
      const intent = action === 'delete-module' ? 'delete' : action === 'archive-module' ? 'archive' : 'restore';
      if (intent === 'delete' && !await root.uiConfirm?.(text('deleteModuleConfirm', '确认删除本体「{name}」？删除后将从当前列表移除，新任务不再使用其中内容。原文、来源和历史仍保留，可从归档列表恢复。', { name: module.name }))) return;
      if (state !== current) return;
      current.moduleLifecycleBusy = true;
      try {
        await invoke('cognition.ontology.module.lifecycle', { moduleId: id, intent, expectedRevision: current.doc.revision, expectedVersion: module.version });
        if (state !== current) return;
        await refresh();
        root.uiToast?.(text(intent === 'delete' ? 'moduleDeleted' : intent === 'archive' ? 'moduleArchived' : 'moduleRestored', intent === 'delete' ? '本体已删除，可从归档列表恢复。' : intent === 'archive' ? '本体已归档。' : '本体已恢复。'), { variant: 'success' });
      } finally { current.moduleLifecycleBusy = false; }
      return;
    }
    if (action === 'create-module') return openModuleDialog(target);
    if (action === 'archive-history') {
      const current = state;
      if (!current || current.archiveBusy) return;
      const history = current.doc.history.length;
      const receipts = Object.keys(current.doc.receipts || {}).length;
      const approved = await root.uiConfirm?.({
        title: text('archiveHistoryTitle', '归档本体历史'),
        message: text('archiveHistoryConfirm', '将较早的历史与未被保留历史引用的回执移到同步侧文件；主档 revision 会递增。归档后旧命令的撤销和来源准入可能不可用，记录与主档大小不变。当前 {history} 条历史、{receipts} 条回执。继续？', { history: String(history), receipts: String(receipts) }),
        okLabel: text('archiveHistoryConfirmOk', '归档'),
      });
      if (!approved || state !== current) return;
      current.archiveBusy = true;
      try {
        await current.editor?.flush();
        const result = await invoke('cognition.ontology.history.archive', { keepHistory: 500, keepReceipts: 500 });
        if (state !== current) return;
        await refresh();
        root.uiToast?.(text('archiveHistoryDone', '已归档 {history} 条历史、{receipts} 条回执。', {
          history: String(result.archivedHistory ?? 0), receipts: String(result.archivedReceipts ?? 0),
        }), { variant: 'success' });
      } catch (error) {
        root.uiToast?.(text('archiveHistoryFailed', '归档未完成：{message}', {
          message: error?.message || text('error', '操作未完成，请稍后重试。'),
        }), { variant: 'error' });
      } finally { current.archiveBusy = false; }
      return;
    }
    if (action === 'export') {
      const result = await invoke('cognition.ontology.export', state.page === 'module' ? { moduleId: state.moduleId } : {});
      if (result.canceled) return;
      root.uiToast?.(text('exportSaved', '已导出本体快照：{path}', { path: result.filePath }), { variant: 'success' });
      return;
    }
    if (action === 'candidate-back') {
      const candidateId = state.candidateDraft?.id;
      if (candidateId) root.CogAssets?.router?.go({ name: 'activity', candidateId });
      return;
    }
    if (action === 'back-list') {
      await state.editor?.flush();
      state.page = 'list'; state.mode = state.workspaceReturn ? 'graph' : 'list';
      state.workspaceReturn = null; render(); return;
    }
    if (action === 'back-graph') {
      await state.editor?.flush();
      clearTimeout(state.documentRenderTimer);
      state.documentNeedsRender = false;
      state.page = 'list'; state.mode = 'graph'; state.recordId = '';
      render(); return;
    }
    if (action === 'back-module') {
      if (state.candidateDraft) { state.page = 'candidate-organize'; render(); return; }
      state.page = 'module'; state.tab = 'document'; render(); return;
    }
    if (action === 'open-module') {
      await state.editor?.flush();
      rememberRecentModule(id);
      if (state.page === 'list' && state.mode === 'graph') state.workspaceReturn = { zoom: state.graphZoom, pan: state.graphPan,
        layout: state.graphLayout, fullscreen: state.graphFullscreen, selectedId: state.selectedId || id, edgeId: state.selectedEdgeId,
        showInactive: state.showInactive, searchQuery: state.searchQuery };
      state.graphFullscreen = false;
      state.moduleId = id; state.page = 'module'; state.tab = 'document'; state.box = 'T'; state.recordPage = 0; state.graphFocusId = ''; state.graphSearchQuery = ''; state.graphSearchResults = []; state.graphZoom = 1; state.graphLayout = 'radial'; render(); return; }
    if (action === 'change-page') {
      const page = Number(target.dataset.page);
      if (!Number.isInteger(page) || page < 0) return;
      if (target.dataset.pageKind === 'modules') state.modulePage = page;
      else if (target.dataset.pageKind === 'candidateModules') state.candidateModulePage = page;
      else if (target.dataset.pageKind === 'records') state.recordPage = page;
      else return;
      render(); return;
    }
    if (action === 'open-record') return openRecord(id);
    if (action === 'record-details') { await state.editor?.flush(); return openRecord(id, undefined, { details: true }); }
    if (action === 'used-version') return openRecord(id, Number(target.dataset.version));
    if (action === 'used-current') return openRecord(id);
    if (action === 'object-graph') { await enterGraph(false); state.graphFocusId = id; await loadGraph(state.moduleId); render(); return; }
    if (action === 'search-result') {
      const moduleId = target.dataset.moduleId;
      if (moduleId) state.moduleId = moduleId;
      const record = state.doc.records[id];
      if (record?.kind === 'module') { rememberRecentModule(record.id); state.moduleId = record.id; state.page = 'module'; state.tab = 'document'; render(); return; }
      return openRecord(id);
    }
    if (action === 'create-reference') return openReferenceDialog(target);
    if (action === 'add-content') { state.documentAddOpen = true; render(); return; }
    if (action === 'create-definition') return openDefinitionDialog(target);
    if (action === 'create-relation-definition') return openDefinitionDialog(target, 'relation');
    if (action === 'create-entity') return openEntityDialog(target);
    if (action === 'create-assertion') return openAssertionDialog(target);
    if (action === 'create-rule') return openRuleDialog(target);
    if (action === 'select-box') { state.tab = 'document'; render(); return; }
    if (action === 'change-fact' || action === 'correct-fact') { if (id) state.recordId = id; await state.editor?.flush(); return openFactChange(target, action === 'change-fact'); }
    if (action === 'edit-module') return openModuleDialog(target, state.doc.records[state.moduleId]);
    if (action === 'edit-record') {
      if (id) state.recordId = id;
      await state.editor?.flush();
      const record = state.doc.records[state.recordId];
      if (record?.kind === 'entity') return openEntityDialog(target, record);
      if (record?.kind === 'definition') return openDefinitionDialog(target, record.definitionKind, record);
      if (record?.kind === 'rule') return openRuleDialog(target, record);
      if (record?.kind === 'reference') return openReferenceDialog(target, record);
    }
    if (action === 'delete-record') {
      if (id) state.recordId = id;
      const record = state.doc.records[state.recordId]; if (!record) return;
      if (!await root.uiConfirm?.(text('deleteBoundary', '删除会移出当前内容并停止新任务使用；原文、来源与历史仍保留，可从停用内容恢复。被其他有效内容依赖的对象不能直接删除。是否查看影响并继续？'))) return;
      if (await commit([{ intent: 'delete', recordId: record.id, expectedVersion: record.version, sourceLabel: sourceLabel() }])) { state.page = 'module'; state.tab = 'document'; render(); }
      return;
    }
    if (action === 'archive-record') {
      if (id) state.recordId = id;
      const record = state.doc.records[state.recordId]; if (!record) return;
      const confirmed = typeof root.uiConfirm === 'function' ? await root.uiConfirm(text('archiveConfirm', '停用后，任务将不再采用这条内容。是否继续？')) : false;
      if (!confirmed) return;
      await commit([{ intent: 'archive', recordId: record.id, expectedVersion: record.version, sourceLabel: sourceLabel() }]);
      state.page = 'module'; state.tab = 'document'; render(); return;
    }
  }
  function openFactChange(trigger, change) {
    const fact = state.doc.records[state.recordId]; if (!fact || fact.kind !== 'assertion') return;
    const definition = state.doc.records[fact.definitionId];
    if (!definition || definition.kind !== 'definition') return;
    const objects = usableRecords('entity').map(r => ({ value: r.id, label: choiceLabel(r) }));
    const valueField = definition.valueType === 'entity'
      ? select(text('newValue', '新的关联对象'), 'newObject', objects, fact.object.kind === 'entity' ? fact.object.id : '')
      : definition.valueType === 'boolean'
        ? select(text('newValue', '新的事实值'), 'newValue', [{ value: 'true', label: text('yes', '是') }, { value: 'false', label: text('no', '否') }], fact.object.kind === 'literal' ? String(fact.object.value) : 'false')
        : field(text('newValue', '新的事实值'), 'newValue', fact.object.kind === 'literal' ? String(fact.object.value) : '', definition.valueType === 'date' ? 'date' : definition.valueType === 'number' ? 'number' : 'text');
    const body = `${valueField}${change ? field(text('effectiveFrom', '从哪天开始生效'), 'effectiveFrom', '', fact.validity.precision === 'month' ? 'month' : 'date') : textarea(text('correctionReason', '纠正说明'), 'reason')}`;
    openDialog({ title: change ? text('changeFactTitle', '记录负责人或关系变更') : text('correctFactTitle', '纠正记错的事实'), body, trigger, onSubmit: data => {
      let value;
      if (definition.valueType === 'entity') {
        if (!data.newObject) throw new Error(text('chooseEntity', '请选择关联对象。'));
        value = { kind: 'entity', id: data.newObject };
      } else {
        const raw = data.newValue;
        if (definition.valueType === 'number') { if (!String(raw || '').trim()) throw new Error(text('invalidNumber', '请输入有效数字。')); value = { kind: 'literal', valueType: 'number', value: Number(raw) }; if (!Number.isFinite(value.value)) throw new Error(text('invalidNumber', '请输入有效数字。')); }
        else if (definition.valueType === 'boolean') value = { kind: 'literal', valueType: 'boolean', value: raw === 'true' };
        else value = { kind: 'literal', valueType: definition.valueType, value: raw };
      }
      return commit([{ intent: change ? 'change' : 'correct', recordId: fact.id, expectedVersion: fact.version, ...(change ? { effectiveFrom: data.effectiveFrom } : {}), object: value, sourceLabel: data.reason?.trim() || sourceLabel() }]);
    } });
  }
  function updateDocumentSaveState(current, value, item) {
    current.editorStatus = { value, item };
    if (state !== current) return;
    const label = current.root.querySelector?.('[data-document-save]');
    const idle = !['saved', 'saving', 'error', 'pending'].includes(value);
    if (label) label.textContent = idle ? '' : text(value === 'saved' ? 'documentSaved' : value === 'saving' ? 'documentSaving' : value === 'error' ? 'documentUnsaved' : 'documentPending', value === 'saved' ? '已保存到本体' : value === 'saving' ? '正在保存…' : value === 'error' ? '修改尚未保存' : '有待保存的修改');
    const error = current.root.querySelector?.('[data-document-error]');
    if (!error) return;
    if (!item?.error) { error.innerHTML = ''; return; }
    const conflict = item.error.code === 'baseline_changed';
    const message = conflict ? text('documentConflict', '内容已被其他操作更新。你的修改已保留，请核对后选择如何保存。')
      : text(`error_${item.error.code}`, item.error.message || text('error', '保存未完成，请重试。'));
    const archiveAction = item.error.code === 'capacity_exceeded' && item.error.details?.remedy === 'archive_history'
      ? button(text('archiveHistory', '归档旧历史…'), 'archive-history', 'secondary') : '';
    error.innerHTML = `<div class="ontology-document-error" role="alert"><span>${esc(message)}</span>${button(conflict ? text('documentRebase', '按最新版本保存我的修改') : text('retry', '重试'), conflict ? 'document-rebase' : 'document-retry', 'secondary', { 'data-record-id': item.recordId })}${button(text('documentDiscard', '恢复已保存内容'), 'document-discard', 'secondary', { 'data-record-id': item.recordId })}${archiveAction}</div>`;
  }
  function ensureDocumentEditor(current) {
    if (current.editor || !current.doc || !root.CogOntologyEditor) return;
    current.editor = root.CogOntologyEditor.create({
      invoke, getDocument: () => current.doc, ownerId: current.doc.ownerId, storage: root.localStorage,
      onStatus: (value, item) => updateDocumentSaveState(current, value, item),
      onSnapshot(doc) { if (doc && doc.revision >= current.doc.revision) current.doc = doc; },
      onCommit(result, { previousId }) {
        if (result.ontology.revision >= current.doc.revision) current.doc = result.ontology;
        if (current.recordId === previousId) current.recordId = result.recordId;
        if (state !== current) return;
        // correct 会新建事实身份；在当前编辑节点上更新 ID，保留输入光标。
        if (previousId !== result.recordId) current.root.querySelectorAll?.('[data-record-id]').forEach(element => {
          if (element.dataset.recordId === previousId) element.dataset.recordId = result.recordId;
        });
        if (current.graphController) current.graphController.update({ doc: current.doc, moduleId: current.page === 'module' ? current.moduleId : '', at: current.at });
        const focused = document.activeElement;
        if (current.documentPointerDown || focused && current.root.contains?.(focused) && focused.matches?.('[data-ontology-edit]')) current.documentNeedsRender = true;
        else render();
      },
    });
    current.editor.resume();
  }
  function documentEditValue(element) {
    const raw = element.tagName === 'SELECT' || element.tagName === 'INPUT' ? element.value : element.textContent;
    if (element.dataset.editType === 'number') {
      if (!String(raw).trim() || !Number.isFinite(Number(raw))) throw new Error(text('invalidNumber', '请输入有效数字。'));
      return Number(raw);
    }
    if (element.dataset.editType === 'boolean') return String(raw) === 'true';
    if (element.dataset.editType === 'array') return [...new Set(String(raw).split(/[、,，\n]/).map(value => value.trim()).filter(Boolean))];
    return String(raw ?? '');
  }
  function onDocumentInput(event) {
    if (!state || event.isComposing || event.keyCode === 229) return;
    const element = event.target.closest?.('[data-ontology-edit]'); if (!element) return;
    try {
      const value = documentEditValue(element), field = element.dataset.ontologyEdit;
      if (field === 'name' && !value.trim()) throw new Error(text('documentNameRequired', '名称不能为空。'));
      delete element.dataset.error;
      state.editor?.enqueue(element.dataset.recordId, field, value);
    } catch (error) { element.dataset.error = 'true'; updateDocumentSaveState(state, 'error', { recordId: element.dataset.recordId, error: { code: 'invalid_input', message: error.message } }); }
  }
  function onDocumentFocusOut(event) {
    if (!event.target.closest?.('[data-ontology-edit]') || !event.target.isContentEditable || !state) return;
    onDocumentInput(event);
    const current = state;
    // 等焦点落到下一控件，避免重画吞掉随后发生的点击。
    setTimeout(() => {
      if (state !== current) return;
      void current.editor?.flush();
      settleDocumentRender(current);
    }, 0);
  }
  function settleDocumentRender(current) {
    clearTimeout(current.documentRenderTimer);
    current.documentRenderTimer = setTimeout(() => {
      if (state !== current || !current.documentNeedsRender || current.documentPointerDown
        || document.activeElement?.closest?.('[data-ontology-edit]')) return;
      current.documentNeedsRender = false; render();
    }, 100);
  }
  function onDocumentPointerStart(event) { if (state) { state.documentPointerDown = true; state.cardPointer = event.target.closest?.('[data-card-module]') ? { x: event.clientX, y: event.clientY, moved: false } : null; } }
  function onDocumentPointerMove(event) { if (state?.cardPointer && Math.hypot(event.clientX - state.cardPointer.x, event.clientY - state.cardPointer.y) > 6) state.cardPointer.moved = true; }
  function onDocumentPointerEnd() { if (state) { state.documentPointerDown = false; settleDocumentRender(state); } }
  function graphDocFor(current, doc, moduleId) {
    if (moduleId) return doc;
    const allowed = new Set(modules(current.showInactive)
      .filter(module => (!current.showInactive || module.status !== 'active')
        && (!current.scopeFilter || current.scopeFilter === 'all' || module.scope.kind === current.scopeFilter))
      .map(module => module.id));
    return {
      ...doc,
      records: Object.fromEntries(Object.entries(doc.records)
        .filter(([id, record]) => allowed.has(record.kind === 'module' ? id : record.moduleId))),
    };
  }
  function mountDocumentGraph() {
    const current = state;
    const mount = current.root.querySelector?.('[data-ontology-graph-mount]');
    if (!mount || !root.CogOntologyGraph) return;
    const graphDoc = graphDocFor(current, current.doc, mount.dataset.moduleId || '');
    const allowed = new Set(Object.keys(graphDoc.records));
    const isGlobal = !mount.dataset.moduleId;
    let initialSelection = null;
    if (isGlobal && current.listGraphSelection) {
      if (allowed.has(current.listGraphSelection.id)) initialSelection = { ...current.listGraphSelection };
      else current.listGraphSelection = null;
    }
    current.graphController = root.CogOntologyGraph.mount(mount, { prototype: true, doc: graphDoc, moduleId: mount.dataset.moduleId || '', at: current.at, text,
      initialSelection,
      onSelect({ recordId, kind, open }) {
        if (state !== current) return;
        current.recordId = recordId;
        if (isGlobal && kind === 'module' && recordId) current.listGraphSelection = { kind: 'node', id: recordId };
        if (open) void openRecord(recordId).catch(showError);
      },
      onInspectorClose() { if (state === current && isGlobal) current.listGraphSelection = null; },
      onOpenModuleGraph(moduleId) { if (state === current) return openModuleGraph(moduleId).catch(showError); },
    });
  }
  function render() {
    if (!state?.root || !state.root.isConnected) return;
    state.documentNeedsRender = false;
    const workspace = state.root.querySelector?.('[data-ontology-scroll]') || state.root.querySelector?.('.ontology-workspace');
    const scrollTop = workspace?.scrollTop || 0;
    const scrollLeft = workspace?.scrollLeft || 0;
    state.graphController?.destroy(); state.graphController = null;
    const focused = document.activeElement;
    const focus = state.graphRestoreFocus || (focused?.dataset?.ontologyNode ? { node: focused.dataset.ontologyNode } : focused?.dataset?.ontologyEdge ? { edge: focused.dataset.ontologyEdge } : null);
    state.graphRestoreFocus = null;
    for (const node of state.root.querySelectorAll?.('[data-document-details]') || []) {
      const key = node.dataset?.documentDetails;
      if (key) state.documentDetails[key] = node.open;
    }
    let content;
    if (state.page === 'global-graph') content = graphPage();
    else if (state.page === 'module') content = modulePage();
    else if (state.page === 'record') content = recordPage();
    else if (state.page === 'candidate-organize') content = candidateOrganizePage();
    else content = listPage();
    state.root.innerHTML = `<main class="ontology-workspace ont-prototype${state.page === 'module' ? ' ontology-workspace--document' : ''}">${content}</main>`;
    const nextWorkspace = state.root.querySelector?.('[data-ontology-scroll]') || state.root.querySelector?.('.ontology-workspace');
    // Restoration is immediate; only explicit chapter navigation should animate.
    if (nextWorkspace?.scrollTo) nextWorkspace.scrollTo({ top: scrollTop, left: scrollLeft, behavior: 'instant' });
    else if (nextWorkspace) { nextWorkspace.scrollTop = scrollTop; nextWorkspace.scrollLeft = scrollLeft; }
    mountDocumentGraph();
    state.selectionController?.refresh();
    if (state.editorStatus) updateDocumentSaveState(state, state.editorStatus.value, state.editorStatus.item);
    if (focus) state.root.querySelector?.(`[data-ontology-${focus.node ? 'node' : 'edge'}="${focus.node || focus.edge}"]`)?.focus?.();
    if (typeof root.hydrateUiFormSelects === 'function') root.hydrateUiFormSelects(state.root, {
      'ontology-graph-relation': value => { if (!state || value === (state.graphDefinitionId || '')) return; state.graphDefinitionId = value; void loadGraph(state.moduleId).then(render).catch(showError); },
      'ontology-graph-scale': value => {
        if (!state || !['schema', 'instances'].includes(value) || state.graphScale === value) return;
        state.graphScale = value; state.graphFocusId = ''; state.selectedId = ''; state.selectedEdgeId = '';
        void loadGraph(state.moduleId).then(render).catch(showError);
      },
    });
    if (typeof root.hydrateUiTabs === 'function') root.hydrateUiTabs(state.root);
    state.root.querySelectorAll('[data-ui-tabs]').forEach(group => group.addEventListener('ui-tabs-change', event => {
      if (group.dataset.ontologyTabs === 'workspace') {
        state.mode = event.detail.value;
        state.graphRequest++;
        if (state.mode === 'graph') void enterGraph(true).catch(showError); else render();
      } else if (group.dataset.ontologyTabs === 'object') {
        state.objectTab = event.detail.value; render();
      } else if (group.dataset.ontologyTabs === 'candidateBoxes') {
        if (['T', 'A', 'R'].includes(event.detail.value)) state.candidateBox = event.detail.value;
        state.recordPage = 0; render();
      }
    }));
  }
  async function loadInitial(options = {}) {
    const current = state, request = ++current.snapshotRequest;
    state.mountOptions = options;
    state.page = 'list'; state.mode = 'list'; state.candidateDraft = null; state.candidateModuleId = '';
    const result = await invoke('cognition.ontology.snapshot');
    if (state !== current || request !== current.snapshotRequest) return;
    state.doc = result.ontology;
    state.lastLoadedAt = Date.now();
    ensureDocumentEditor(state);
    try { state.recentIds = JSON.parse(root.localStorage?.getItem(`ontology-recent:${state.doc.ownerId}`) || '[]'); if (!Array.isArray(state.recentIds)) state.recentIds = []; } catch (_) { state.recentIds = []; }
    try { state.recentModuleIds = JSON.parse(root.localStorage?.getItem(`ontology-recent-modules:${state.doc.ownerId}`) || '[]'); if (!Array.isArray(state.recentModuleIds)) state.recentModuleIds = []; } catch (_) { state.recentModuleIds = []; }
    void loadPending(current);
    if (!options.resetToOverview && options.candidateId) {
      const loaded = await invoke('recall.candidates.read', { candidateId: String(options.candidateId) });
      if (state !== current || request !== current.snapshotRequest) return;
      state.candidateDraft = loaded.candidate;
      state.candidateModuleId = loaded.candidate.ontologyHandoff?.moduleIds?.[0] || '';
      state.moduleId = state.candidateModuleId;
      state.candidateBox = 'A'; state.candidateRiskAcknowledged = false; state.page = 'candidate-organize';
      render(); return;
    }
    const moduleId = String(options.moduleId || '');
    if (!options.resetToOverview && moduleId && state.doc.records[moduleId]?.kind === 'module') {
      rememberRecentModule(moduleId);
      state.moduleId = moduleId; state.page = 'module'; state.tab = 'document';
      if (options.recordId) { await openRecord(String(options.recordId), options.recordVersion ? Number(options.recordVersion) : undefined); return; }
    } else if (!options.resetToOverview && options.recordId) {
      await openRecord(String(options.recordId), options.recordVersion ? Number(options.recordVersion) : undefined); return;
    }
    render();
  }
  async function mountCognitionOntology(container, options = {}) {
    // Re-mounting without unmounting leaves the previous root/window listeners
    // and controllers alive; each i18n change would then render every old tree.
    if (state) unmountCognitionOntology();
    state = { snapshotRequest: 0, graphRequest: 0, recordRequest: 0, root: container, page: 'list', mode: 'list', moduleId: '', tab: 'document', box: 'T', modulePage: 0, recordPage: 0, lastLoadedAt: 0, recentModuleIds: [],
      selectedId: '', selectedEdgeId: '', listGraphSelection: null, graphFocusId: '', graphSearchQuery: '', graphSearchResults: [], graphZoom: 1, graphLayout: 'radial', graphScale: 'instances', graphRules: true, at: root.CogOntologyDocument.today(), graph: null, history: [], documentDetails: {} };
    state.selectionController = root.CogOntologySelection?.mount(container, { getDocument: () => state?.doc, text, esc, save: async (id, field, value, options = {}) => {
      const current = state;
      if (!current?.editor) throw new Error(text('documentEditorUnavailable', '文档编辑器尚未就绪。'));
      const record = current.doc.records[id];
      if (record?.kind === 'assertion' && options.intent === 'change') {
        const object = field === 'object.id' ? { kind: 'entity', id: value } : { ...record.object, value };
        const saved = await commit([{ intent: 'change', recordId: id, expectedVersion: record.version, effectiveFrom: options.effectiveFrom, object, sourceLabel: sourceLabel() }]);
        if (!saved) throw new Error(text('documentUnsaved', '修改尚未保存'));
        return;
      }
      current.editor.enqueue(id, field, value); await current.editor.flush();
      const errors = Object.values(current.editor.getDrafts()).filter(draft => draft.changes && Object.keys(draft.changes).length);
      if (errors.length) throw new Error(text('documentUnsaved', '修改尚未保存'));
    } });
    state.root.addEventListener('click', onClick);
    state.root.addEventListener('input', onInput);
    state.root.addEventListener('compositionend', onInput);
    state.root.addEventListener('keydown', onKeydown);
    state.root.addEventListener('change', onChange);
    state.root.addEventListener('focusout', onDocumentFocusOut);
    state.root.addEventListener('pointerdown', onDocumentPointerStart, true);
    state.root.addEventListener('pointermove', onDocumentPointerMove, true);
    state.root.addEventListener('pointerup', onDocumentPointerEnd, true);
    state.root.addEventListener('pointercancel', onDocumentPointerEnd, true);
    window.addEventListener('i18n-change', onI18nChange);
    state.root.innerHTML = `<main class="ontology-workspace"><div class="ontology-ws-loading" role="status">${esc(text('loading', '正在加载本体…'))}</div></main>`;
    const current = state;
    try { await loadInitial(options); }
    catch (error) { if (state !== current) return; state.root.innerHTML = `<main class="ontology-workspace"><div class="ontology-ws-error" role="alert"><h1>${esc(text('loadFailed', '本体暂时无法加载'))}</h1><p>${esc(error.message)}</p>${button(text('retry', '重试'), 'retry', 'primary')}</div></main>`; }
  }
  function onClick(event) {
    if (state && !event.target.closest?.('.ont-scope')) state.root.querySelector?.('.ont-scope[open]')?.removeAttribute('open');
    const card = event.target.closest?.('[data-card-module]');
    if (card && !event.target.closest?.('button,a,input,select,textarea,summary')) {
      if (event.defaultPrevented || event.detail > 1 || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || state?.cardPointer?.moved) return;
      const selection = root.getSelection?.();
      if (selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(card)) return;
      event.preventDefault(); void handleAction('open-module', card).catch(showError); return;
    }
    if (!state || event.target.closest?.('[data-ontology-edit]')) return;
    const action = event.target.closest('[data-ontology-action]'); if (!action) return;
    event.preventDefault();
    void handleAction(action.dataset.ontologyAction, action).catch(showError);
  }
  let searchTimer = null;
  function showError(error) { root.uiToast?.(error.message || text('error', '操作未完成，请稍后重试。'), { variant: 'error' }); }
  function onInput(event) {
    if (event.target.closest?.('[data-ontology-edit]')) { onDocumentInput(event); return; }
    if (!state || event.isComposing || event.keyCode === 229) return;
    const input = event.target.closest('[data-ontology-field="search"]');
    if (!input || !state || state.page !== 'list') return;
    if (state.mode === 'graph') { state.mode = 'list'; state.modulePage = 0; }
    state.searchQuery = input.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (!state || state.page !== 'list') return;
      try {
        const current = state, query = current.searchQuery;
        const result = state.searchQuery ? await invoke('cognition.ontology.search', { query: state.searchQuery }) : { results: [] };
        if (state !== current || current.searchQuery !== query || current.page !== 'list') return;
        state.searchResults = result.results;
        const focused = document.activeElement === input, caret = input.selectionStart;
        state.modulePage = 0; render();
        if (focused) { const next = state.root.querySelector?.('[data-ontology-field="search"]'); next?.focus(); try { next?.setSelectionRange(caret, caret); } catch (_) {} }
      } catch (error) { root.uiToast?.(error.message, { variant: 'error' }); }
    }, 180);
  }
  function onKeydown(event) {
    const card = event.target.closest?.('[data-card-module]');
    if (card && event.target === card && ['Enter', ' '].includes(event.key) && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); void handleAction('open-module', card).catch(showError); return; }
    if (event.key === 'Escape') {
      if (event.defaultPrevented) return;
    }
    if (event.isComposing || event.keyCode === 229) return;
    const edit = event.target.closest?.('[data-ontology-edit]');
    if (edit?.isContentEditable && event.key === 'Enter' && !event.shiftKey && edit.tagName !== 'P') { event.preventDefault(); edit.blur?.(); }
  }
  // 数据未落地前（mount→snapshot 在途）i18n-change 只能重绘加载骨架；
  // 全量 render 会经 listPage→modules 读 state.doc.records 而崩溃。
  function onI18nChange() {
    if (!state || !state.root || !state.root.isConnected) return;
    if (!state.doc) {
      state.root.innerHTML = `<main class="ontology-workspace"><div class="ontology-ws-loading" role="status">${esc(text('loading', '正在加载本体…'))}</div></main>`;
      return;
    }
    render();
  }
  function onChange(event) {
    if (event.target.closest?.('[data-ontology-edit]')) { onDocumentInput(event); void state?.editor?.flush(); return; }
    if (!state) return;
    const objectDate = event.target.closest('[data-ontology-field="objectAt"]');
    if (objectDate) { state.at = objectDate.value || root.CogOntologyDocument.today(); render(); return; }
    const input = event.target.closest('[data-ontology-field="graphAt"]'); if (!input) return;
    state.at = input.value;
    void loadGraph(state.moduleId).then(render).catch(error => root.uiToast?.(error.message, { variant: 'error' }));
  }
  function syncCognitionOntology(doc) {
    const current = state;
    if (!current || !doc || doc.ownerId !== current.doc?.ownerId) return;
    void loadPending(current);
    if (doc.revision <= current.doc.revision) return;
    current.doc = doc;
    if (current.documentPointerDown || current.root.contains?.(document.activeElement) && document.activeElement?.matches?.('[data-ontology-edit]')) { current.documentNeedsRender = true; return; }
    if (current.graphController) {
      const moduleId = current.page === 'module' ? current.moduleId : '';
      const graphDoc = graphDocFor(current, doc, moduleId);
      current.graphController.update({ doc: graphDoc, moduleId, at: current.at });
      const visible = new Set(Object.keys(graphDoc.records));
      if (current.listGraphSelection && !visible.has(current.listGraphSelection.id)) current.listGraphSelection = null;
      if (current.recordId && !visible.has(current.recordId)) current.recordId = undefined;
      return;
    }
    if (current.tab === 'graph' || (current.page === 'list' && current.mode === 'graph')) {
      void loadGraph(current.page === 'list' ? undefined : current.moduleId).then(() => { if (state === current) render(); }).catch(showError);
    } else render();
  }
  function unmountCognitionOntology() {
    if (!state?.root) return;
    state.root.removeEventListener('click', onClick);
    state.root.removeEventListener('input', onInput);
    state.root.removeEventListener('compositionend', onInput);
    clearTimeout(searchTimer);
    state.root.removeEventListener('keydown', onKeydown);
    state.root.removeEventListener('change', onChange);
    state.root.removeEventListener('focusout', onDocumentFocusOut);
    state.root.removeEventListener('pointerdown', onDocumentPointerStart, true);
    state.root.removeEventListener('pointermove', onDocumentPointerMove, true);
    state.root.removeEventListener('pointerup', onDocumentPointerEnd, true);
    state.root.removeEventListener('pointercancel', onDocumentPointerEnd, true);
    clearTimeout(state.documentRenderTimer);
    const closing = state;
    const closingEditor = closing.editor;
    if (closingEditor) void closingEditor.flush().catch(error => {
      if (state === closing) showError(error);
    }).finally(() => closingEditor.destroy());
    closing.graphController?.destroy();
    closing.selectionController?.destroy();
    window.removeEventListener('i18n-change', onI18nChange);
    state.root.innerHTML = '';
    state = null;
  }
  window.mountCognitionOntology = mountCognitionOntology;
  window.unmountCognitionOntology = unmountCognitionOntology;
  window.syncCognitionOntology = syncCognitionOntology;
})(typeof window !== 'undefined' ? window : globalThis);
