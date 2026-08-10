const _skillsLog = createLogger('skills');
// ─── Skills ───

let _skillsCache = null;
// Read-only open-tier entries. External packages render as package cards,
// while machine-global folders still render their individual skills. Package
// SKILL.md files remain available to the agent layer, but are not expanded into
// a wall of user-facing recipe cards.
let _openSkillsCache = [];
let _packagesCache = [];
let _skillsLoadInFlight = null;
let _skillsCognitionRefreshTimer = null;
let _selectedSkill = null;    // { source, id }
let _expandedGlobalSkillGroups = new Set();
const _GLOBAL_SKILL_GROUP_MIN = 2;


const _skillsCognitionState = {
  page: 'overview',
  depositionView: 'candidates',
  candidateCategoryFilter: '',
  assetSubview: 'list',
  candidates: [],
  recallCandidates: [],
  sources: [],
  recallViews: [],
  contextProjections: [],
  ontologyGroups: [],
  ontologyGroupContent: {},
  selectedOntologyGroupId: '',
  selectedContextKey: '',
  teachingSignals: [],
  captures: [],
  recentCaptures: [],
  captureCounts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 },
  captureNextCursor: null,
  captureFilter: 'all',
  captureSettings: null,
  captureModel: null,
  selectedCaptureId: '',
  selectedHistoricalConversationIds: [],
  loadErrors: [],
  editingRecallCandidateId: '',
  receipts: [],
  assets: [],
  selectedAssetId: '',
  assetCategoryFilter: '',
  dashboard: null,
  selectedReceiptId: '',
  receiptDetails: {},
  loadedAt: 0,
  loading: false,
};

function _cognitionText(key, fallback) {
  const value = typeof t === 'function' ? t(key) : key;
  return value && value !== key ? value : fallback;
}

function _cognitionTypeLabel(type) {
  const labels = {
    preference: _cognitionText('cognition.type_preference', '偏好'),
    ontology: _cognitionText('cognition.type_ontology', '本体'),
    rule: _cognitionText('cognition.type_rule', '规则'),
    experience: _cognitionText('cognition.type_experience', '经验'),
    skill_evolution: _cognitionText('cognition.type_skill_evolution', '技能进化'),
  };
  return labels[type] || type || _cognitionText('cognition.unknown', '未知');
}

function _cognitionStatusLabel(status) {
  const labels = {
    prepared: _cognitionText('cognition.status_prepared', '准备中'),
    succeeded: _cognitionText('cognition.status_success', '成功'),
    degraded: _cognitionText('cognition.status_degraded', '降级'),
    rejected: _cognitionText('cognition.status_rejected', '拒绝'),
    pending: _cognitionText('cognition.status_pending', '待确认'),
    accepted: _cognitionText('cognition.status_accepted', '已确认'),
    preview: _cognitionText('cognition.status_preview', '预览'),
    confirmed: _cognitionText('cognition.status_confirmed', '已确认'),
    expired: _cognitionText('cognition.status_expired', '已失效'),
    revoked: _cognitionText('cognition.status_revoked', '已撤销'),
    ready: _cognitionText('cognition.source_ready', '可用'),
    empty: _cognitionText('cognition.source_empty', '暂无数据'),
    waiting_quiet: _cognitionText('cognition.capture_waiting_quiet', '等待会话静默'),
    waiting_completion: _cognitionText('cognition.capture_waiting_completion', '等待会话完成'),
    waiting_manual: _cognitionText('cognition.capture_waiting_manual', '等待手动执行'),
    scheduled: _cognitionText('cognition.capture_scheduled', '等待计划时间'),
    queued: _cognitionText('cognition.capture_queued', '等待提炼'),
    extracting: _cognitionText('cognition.capture_extracting', '正在整理'),
    paused: _cognitionText('cognition.capture_paused', '已暂停'),
    review_ready: _cognitionText('cognition.capture_review_ready', '等待审核'),
    no_candidate: _cognitionText('cognition.capture_no_candidate', '无需沉淀'),
    configuration_required: _cognitionText('cognition.capture_configuration_required', '需要配置模型'),
    failed: _cognitionText('cognition.capture_failed', '提炼失败'),
    cancelled: _cognitionText('cognition.capture_cancelled', '已取消'),
  };
  return labels[status] || status || _cognitionText('cognition.unknown', '未知');
}

function _cognitionDate(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleString(); } catch (_) { return String(value); }
}

function _cognitionSetPageVisibility(page) {
  document.querySelectorAll('[data-cognition-page-body]').forEach((el) => {
    el.hidden = el.dataset.cognitionPageBody !== page;
  });
  document.querySelectorAll('[data-cognition-page]').forEach((el) => {
    const active = el.dataset.cognitionPage === page;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function _normalizeRecallLocation(page) {
  const ia = window.RecallInformationArchitecture;
  if (ia && typeof ia.normalizeRecallLocation === 'function') return ia.normalizeRecallLocation(page);
  if (page === 'sources' || page === 'captures' || page === 'candidates') return { page: 'deposition', subview: page };
  if (page === 'brain') return { page: 'assets', subview: 'tree' };
  if (page === 'context' || page === 'receipts') return { page: 'assets', subview: 'reuse' };
  if (page === 'ontology') return { page: 'assets', subview: 'list', category: 'personal' };
  if (page === 'assets') return { page: 'assets', subview: 'list' };
  if (page === 'deposition') return { page: 'deposition', subview: 'candidates' };
  return { page: 'overview', subview: '' };
}

function _renderCognitionPage(page) {
  if (page === 'overview') renderSkillsCognitionOverview();
  else if (page === 'deposition') renderSkillsCognitionDeposition();
  else if (page === 'assets') renderSkillsCognitionAssets();
}

function switchSkillsCognitionPage(page) {
  const location = _normalizeRecallLocation(page);
  _skillsCognitionState.page = location.page;
  if (location.page === 'deposition') _skillsCognitionState.depositionView = location.subview || 'candidates';
  if (location.page === 'assets') {
    _skillsCognitionState.assetSubview = location.subview || 'list';
    if (location.category) _skillsCognitionState.assetCategoryFilter = location.category;
  }
  _cognitionSetPageVisibility(location.page);
  _renderCognitionPage(location.page);
}

function _renderCognitionLoading(host) {
  if (host) host.innerHTML = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
}

function _renderCognitionError(host) {
  if (host) host.innerHTML = `<div class="skills-cognition-error">${escapeHtml(_cognitionText('cognition.load_failed', '认知资产数据加载失败'))}</div>`;
}

function _renderCognitionEmpty(text) {
  return `<div class="skills-cognition-empty">${escapeHtml(text)}</div>`;
}

function _cognitionRefText(ref) {
  if (ref && typeof ref === 'object') {
    const title = ref.title || ref.name || '';
    const id = ref.id || ref.ref || '';
    const type = ref.type || '';
    if (title && id) return `${title} (${type ? `${type}:` : ''}${id})`;
    if (title) return title;
    if (id) return type ? `${type}:${id}` : String(id);
  }
  return String(ref || '');
}

function _renderCognitionInlineRefs(refs) {
  const items = Array.isArray(refs) ? refs.map(_cognitionRefText).filter(Boolean) : [];
  return items.length ? items.map((item) => `<span>${escapeHtml(item)}</span>`).join('') : `<span>${escapeHtml(_cognitionText('cognition.no_refs', '未记录引用'))}</span>`;
}


function _abilityAssetCategoryLabel(category) {
  const labels = {
    personal: _cognitionText('cognition.asset_category_personal', '关于我'),
    rule: _cognitionText('cognition.asset_category_rule', '规则与判断'),
    template: _cognitionText('cognition.asset_category_template', '模板与范例'),
    skill_method: _cognitionText('cognition.asset_category_skill_method', '技能与方法'),
  };
  return labels[category] || category || _cognitionText('cognition.unknown', '未知');
}

function _abilityAssetMaturityLabel(maturity, status) {
  if (maturity === 'bud' || status === 'candidate') return _cognitionText('cognition.maturity_bud', '芽点');
  if (maturity === 'effectiveness_validated') return _cognitionText('cognition.maturity_deep_leaf', '深叶');
  if (maturity === 'transfer_validated') return 'Transfer Validated';
  if (maturity === 'seed') return _cognitionText('cognition.maturity_seed', '种子');
  return maturity || status || _cognitionText('cognition.unknown', '未知');
}

function _abilityAssetSummary(items, category) {
  return items.filter((item) => (item.category || item.type) === category).length;
}

function _cognitionSourceLabel(kind) {
  return _cognitionText(`cognition.source_${kind}`, kind || _cognitionText('cognition.unknown', '未知'));
}

function _cognitionSourceItemLabel(item) {
  if (!item) return _cognitionText('cognition.unknown', '未知');
  if (item.title) return item.title;
  const subtype = _cognitionText(`cognition.source_subtype_${item.subtype}`, item.subtype || 'source');
  const id = String(item.id || '');
  return id ? `${subtype} · ${id.slice(0, 18)}` : subtype;
}

function _cognitionLoadFailed(section) {
  return Array.isArray(_skillsCognitionState.loadErrors) && _skillsCognitionState.loadErrors.includes(section);
}

function _renderCognitionSourceStatus() {
  const sources = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const body = sources.length
    ? sources.map((source) => `<span class="skills-cognition-source-state is-${escapeHtml(source.status || 'empty')}"><b>${escapeHtml(_cognitionSourceLabel(source.kind))}</b><em>${escapeHtml(String(source.count || 0))} · ${escapeHtml(_cognitionStatusLabel(source.status))}</em></span>`).join('')
    : `<span class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.sources_empty', '尚未发现可接入的数据来源'))}</span>`;
  return `<section class="skills-cognition-flow-band"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.source_status', '数据来源'))}</h2><span>${escapeHtml(_cognitionText('cognition.source_status_hint', '当前可用于形成认知候选的来源'))}</span></div><div class="skills-cognition-source-row">${body}</div></section>`;
}

function renderSkillsCognitionSources() {
  const host = document.getElementById('skills-cognition-sources-body');
  if (!host) return;
  if (_cognitionLoadFailed('sources')) {
    host.innerHTML = `<div class="skills-cognition-warning"><span>${escapeHtml(_cognitionText('cognition.sources_load_failed', '数据来源读取失败'))}</span><button class="btn btn-sm" data-cognition-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`;
    return;
  }
  const groups = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const total = groups.reduce((sum, group) => sum + Number(group.count || 0), 0);
  const ready = groups.filter((group) => group.status === 'ready').length;
  const degraded = groups.filter((group) => group.status === 'degraded').length;
  const summary = [
    ['cognition.source_visible_items', '当前可见', total],
    ['cognition.source_ready_groups', '可用来源', ready],
    ['cognition.source_degraded_groups', '需关注', degraded],
  ].map(([key, fallback, value]) => `<div><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(_cognitionText(key, fallback))}</span></div>`).join('');
  const body = groups.length ? groups.map((group) => {
    const items = Array.isArray(group.items) ? group.items : [];
    const rows = items.length ? items.map((item) => {
      const openConversation = group.kind === 'conversation' && item.subtype === 'session'
        ? `<button type="button" class="btn btn-sm" data-cognition-source-conversation="${escapeHtml(item.id)}">${escapeHtml(_cognitionText('cognition.open_conversation', '打开会话'))}</button>` : '';
      const manageConnector = group.kind === 'authorized_external_system'
        ? `<button type="button" class="btn btn-sm" data-cognition-open-connectors>${escapeHtml(_cognitionText('cognition.manage_connectors', '管理连接器'))}</button>` : '';
      return `<article class="recall-source-item">
        <div class="recall-source-item-main"><strong>${escapeHtml(_cognitionSourceItemLabel(item))}</strong><span>${escapeHtml(_cognitionText(`cognition.source_subtype_${item.subtype}`, item.subtype || 'source'))} · ${escapeHtml(item.scope || '')}${item.sourceVersion ? ` · ${escapeHtml(_cognitionDate(item.sourceVersion))}` : ''}</span></div>
        ${item.degraded ? `<span class="skills-cognition-status is-degraded">${escapeHtml(_cognitionStatusLabel('degraded'))}</span>` : ''}
        ${openConversation || manageConnector ? `<div class="recall-source-item-actions">${openConversation}${manageConnector}</div>` : ''}
      </article>`;
    }).join('') : `<div class="recall-workbench-empty">${escapeHtml(_cognitionText('cognition.source_no_items', '当前没有可显示的数据'))}</div>`;
    return `<section class="recall-source-group">
      <div class="recall-workbench-section-head"><div><h2>${escapeHtml(_cognitionSourceLabel(group.kind))}</h2><p>${escapeHtml(_cognitionText(`cognition.source_hint_${group.kind}`, ''))}</p></div><span class="skills-cognition-status is-${escapeHtml(group.status || 'empty')}">${escapeHtml(String(group.count || 0))} · ${escapeHtml(_cognitionStatusLabel(group.status))}</span></div>
      <div class="recall-source-items">${rows}</div>
    </section>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.sources_empty', '尚未发现可接入的数据来源'));
  host.innerHTML = `<div class="recall-workbench-page-head"><div><h2>${escapeHtml(_cognitionText('cognition.sources', '数据来源'))}</h2><p>${escapeHtml(_cognitionText('cognition.sources_page_hint', '会话、文件、执行、教学信号与已授权系统'))}</p></div></div><div class="recall-workbench-summary">${summary}</div><div class="recall-source-groups">${body}</div>`;
}

function renderSkillsCognitionBrain() {
  const host = document.getElementById('skills-cognition-brain-body');
  if (!host) return;
  const sourceGroups = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const sourceCount = sourceGroups.reduce((sum, group) => sum + Number(group.count || 0), 0);
  const legacyCandidates = Array.isArray(_skillsCognitionState.candidates) ? _skillsCognitionState.candidates : [];
  const recallCandidates = Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [];
  const candidateCount = legacyCandidates.length + recallCandidates.length;
  const assets = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
  const receipts = Array.isArray(_skillsCognitionState.receipts) ? _skillsCognitionState.receipts : [];
  const stages = [
    ['cognition.brain_sources', '来源', sourceCount],
    ['cognition.brain_candidates', '候选', candidateCount],
    ['cognition.brain_assets', '正式资产', assets.length],
    ['cognition.brain_reuse', '复用记录', receipts.length],
  ].map(([key, fallback, count], index) => `<div class="recall-brain-stage"><span>${escapeHtml(_cognitionText(key, fallback))}</span><strong>${escapeHtml(String(count))}</strong></div>${index < 3 ? '<span class="recall-brain-arrow" aria-hidden="true">→</span>' : ''}`).join('');
  const recent = assets.length ? assets.slice(0, 20).map((asset) => {
    const refs = Array.isArray(asset.relationRefs) ? asset.relationRefs : [];
    return `<button type="button" class="recall-brain-asset" data-cognition-open-asset="${escapeHtml(asset.id)}">
      <span class="recall-brain-asset-main"><strong>${escapeHtml(asset.title || asset.id)}</strong><small>${escapeHtml(_abilityAssetCategoryLabel(asset.category || asset.type))} · ${escapeHtml(asset.source || '')}</small></span>
      <span class="recall-brain-asset-links">${escapeHtml(_cognitionText('cognition.brain_relations', '{count} 条关联').replace('{count}', String(refs.length)))}</span>
      <span class="skills-cognition-status">${escapeHtml(_abilityAssetMaturityLabel(asset.maturity, asset.status))}</span>
    </button>`;
  }).join('') : `<div class="recall-workbench-empty">${escapeHtml(_cognitionText('cognition.brain_empty', '尚无可展示的认知节点'))}</div>`;
  const sourceRows = sourceGroups.map((group) => `<span class="skills-cognition-source-state is-${escapeHtml(group.status || 'empty')}"><b>${escapeHtml(_cognitionSourceLabel(group.kind))}</b><em>${escapeHtml(String(group.count || 0))}</em></span>`).join('');
  host.innerHTML = `<div class="recall-workbench-page-head"><div><h2>Brain</h2><p>${escapeHtml(_cognitionText('cognition.brain_page_hint', '从来源证据到正式资产的可追溯认知结构'))}</p></div></div>
    <section class="recall-brain-flow" aria-label="Brain flow">${stages}</section>
    <section class="recall-workbench-section"><div class="recall-workbench-section-head"><div><h2>${escapeHtml(_cognitionText('cognition.brain_source_distribution', '来源分布'))}</h2></div><button type="button" class="btn btn-sm" data-cognition-page-link="sources">${escapeHtml(_cognitionText('cognition.view_sources', '查看来源'))}</button></div><div class="skills-cognition-source-row">${sourceRows || _renderCognitionEmpty(_cognitionText('cognition.sources_empty', '尚无来源'))}</div></section>
    <section class="recall-workbench-section"><div class="recall-workbench-section-head"><div><h2>${escapeHtml(_cognitionText('cognition.brain_nodes', '认知节点'))}</h2><p>${escapeHtml(_cognitionText('cognition.brain_nodes_hint', '显示 Orkas 现有认知资产及其来源关联'))}</p></div><button type="button" class="btn btn-sm" data-cognition-page-link="assets">${escapeHtml(_cognitionText('cognition.view_assets', '查看正式资产'))}</button></div><div class="recall-brain-assets">${recent}</div></section>`;
}

function _contextRecordKey(kind, id) {
  return `${kind}:${id}`;
}

function _contextPackRecords() {
  const views = (Array.isArray(_skillsCognitionState.recallViews) ? _skillsCognitionState.recallViews : []).map((view) => ({ ...view, recordKind: 'view', recordKey: _contextRecordKey('view', view.id) }));
  const projections = (Array.isArray(_skillsCognitionState.contextProjections) ? _skillsCognitionState.contextProjections : []).map((projection) => ({ ...projection, recordKind: 'projection', recordKey: _contextRecordKey('projection', projection.id) }));
  return [...views, ...projections].sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function _renderContextPackDetail(record) {
  if (!record) return `<div class="recall-workbench-empty">${escapeHtml(_cognitionText('cognition.context_select', '选择一个 Context Pack 查看引用'))}</div>`;
  const sourceRefs = Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
  const assetRefs = Array.isArray(record.assetRefs) ? record.assetRefs : Array.isArray(record.assetIds) ? record.assetIds : [];
  const omitted = Array.isArray(record.degradedRefs) ? record.degradedRefs : Array.isArray(record.omittedRefs) ? record.omittedRefs : [];
  const meta = [
    [_cognitionText('cognition.context_kind', '类型'), record.recordKind === 'projection' ? _cognitionText('cognition.context_projection', '任务投影') : 'RecallView'],
    [_cognitionText('cognition.context_purpose', '用途'), record.purpose || '—'],
    [_cognitionText('cognition.context_workspace', 'Workspace'), record.workspaceId || '—'],
    [_cognitionText('cognition.context_created', '创建时间'), _cognitionDate(record.createdAt) || '—'],
    [_cognitionText('cognition.context_expires', '失效时间'), _cognitionDate(record.expiresAt) || '—'],
  ].map(([label, value]) => `<div><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong></div>`).join('');
  const refs = sourceRefs.length ? sourceRefs.map((ref) => `<span>${escapeHtml(_cognitionRefText(ref))}</span>`).join('') : `<span>${escapeHtml(_cognitionText('cognition.no_refs', '未记录引用'))}</span>`;
  const assets = assetRefs.length ? assetRefs.map((ref) => `<span>${escapeHtml(_cognitionRefText(ref))}</span>`).join('') : `<span>${escapeHtml(_cognitionText('cognition.no_assets_in_context', '未带入正式资产'))}</span>`;
  const omittedRefs = omitted.length ? omitted.map((ref) => `<span class="is-warning">${escapeHtml(_cognitionRefText(ref))}</span>`).join('') : `<span>${escapeHtml(_cognitionText('cognition.no_omitted_refs', '没有降级或省略引用'))}</span>`;
  return `<div class="recall-context-detail-head"><div><h2>${escapeHtml(record.id)}</h2><span>${escapeHtml(record.status ? _cognitionStatusLabel(record.status) : record.purpose || '')}</span></div></div><div class="recall-context-meta">${meta}</div><div class="recall-context-ref-section"><strong>${escapeHtml(_cognitionText('cognition.context_source_refs', '来源引用'))}</strong><div>${refs}</div></div><div class="recall-context-ref-section"><strong>${escapeHtml(_cognitionText('cognition.context_asset_refs', '资产引用'))}</strong><div>${assets}</div></div><div class="recall-context-ref-section"><strong>${escapeHtml(_cognitionText('cognition.context_omitted_refs', '降级与省略'))}</strong><div>${omittedRefs}</div></div>`;
}

function renderSkillsCognitionContext() {
  const host = document.getElementById('skills-cognition-context-body');
  if (!host) return;
  const records = _contextPackRecords();
  if (!_skillsCognitionState.selectedContextKey && records[0]) _skillsCognitionState.selectedContextKey = records[0].recordKey;
  const selected = records.find((record) => record.recordKey === _skillsCognitionState.selectedContextKey) || records[0];
  const rows = records.length ? records.map((record) => {
    const refs = Array.isArray(record.sourceRefs) ? record.sourceRefs.length : 0;
    const assets = Array.isArray(record.assetRefs) ? record.assetRefs.length : Array.isArray(record.assetIds) ? record.assetIds.length : 0;
    return `<button type="button" class="recall-context-row${selected?.recordKey === record.recordKey ? ' is-selected' : ''}" data-recall-context-select="${escapeHtml(record.recordKey)}"><span><strong>${escapeHtml(record.recordKind === 'projection' ? record.taskRunId || record.id : record.id)}</strong><small>${escapeHtml(record.recordKind === 'projection' ? _cognitionText('cognition.context_projection', '任务投影') : 'RecallView')} · ${escapeHtml(record.purpose || '')}</small></span><em>${escapeHtml(_cognitionText('cognition.context_ref_count', '{sources} 来源 · {assets} 资产').replace('{sources}', String(refs)).replace('{assets}', String(assets)))}</em></button>`;
  }).join('') : `<div class="recall-workbench-empty">${escapeHtml(_cognitionText('cognition.context_empty', '尚无 Context Pack'))}</div>`;
  host.innerHTML = `<div class="recall-workbench-page-head"><div><h2>Context Pack</h2><p>${escapeHtml(_cognitionText('cognition.context_page_hint', '会话捕获与任务执行实际使用的有界引用包'))}</p></div></div><div class="recall-context-workbench"><section class="recall-context-list">${rows}</section><section class="recall-context-detail">${_renderContextPackDetail(selected)}</section></div>`;
}

async function loadRecallOntologyGroup(groupId) {
  const id = String(groupId || '');
  if (!id || Object.prototype.hasOwnProperty.call(_skillsCognitionState.ontologyGroupContent, id)) return;
  const result = await window.orkas.invoke('personalOntology.groups.read', { groupId: id });
  _skillsCognitionState.ontologyGroupContent[id] = result?.ok === false ? '' : String(result?.content || '');
}

function renderSkillsCognitionOntology() {
  const host = document.getElementById('skills-cognition-ontology-body');
  if (!host) return;
  const groups = Array.isArray(_skillsCognitionState.ontologyGroups) ? _skillsCognitionState.ontologyGroups : [];
  if (!_skillsCognitionState.selectedOntologyGroupId && groups[0]) _skillsCognitionState.selectedOntologyGroupId = groups[0].group_id;
  const selected = groups.find((group) => group.group_id === _skillsCognitionState.selectedOntologyGroupId) || groups[0];
  const ontologyCandidates = (Array.isArray(_skillsCognitionState.candidates) ? _skillsCognitionState.candidates : []).filter((candidate) => candidate.source === 'personal_ontology' || candidate.type === 'ontology');
  const rows = groups.length ? groups.map((group) => `<button type="button" class="recall-ontology-row${selected?.group_id === group.group_id ? ' is-selected' : ''}" data-recall-ontology-group="${escapeHtml(group.group_id)}"><span><strong>${escapeHtml(group.title || group.group_id)}</strong><small>${escapeHtml(group.rel_path || group.group_id)}</small></span><em>${escapeHtml(_cognitionDate(group.updated_at))}</em></button>`).join('') : `<div class="recall-workbench-empty">${escapeHtml(_cognitionText('cognition.ontology_empty', '尚无个人本体分组'))}</div>`;
  const content = selected ? _skillsCognitionState.ontologyGroupContent[selected.group_id] : '';
  const detail = selected ? `<div class="recall-ontology-detail-head"><div><h2>${escapeHtml(selected.title || selected.group_id)}</h2><span>${escapeHtml(selected.rel_path || '')}</span></div><button type="button" class="btn btn-sm" data-cognition-open-personal-ontology>${escapeHtml(_cognitionText('cognition.manage_ontology', '管理个人本体'))}</button></div><pre class="recall-ontology-content">${escapeHtml(content || _cognitionText('cognition.ontology_content_empty', '该分组暂无内容'))}</pre>` : `<div class="recall-workbench-empty"><button type="button" class="btn btn-sm" data-cognition-open-personal-ontology>${escapeHtml(_cognitionText('cognition.create_ontology_group', '创建个人本体分组'))}</button></div>`;
  host.innerHTML = `<div class="recall-workbench-page-head"><div><h2>Ontology</h2><p>${escapeHtml(_cognitionText('cognition.ontology_page_hint', '个人本体分组、候选与正式认知资产'))}</p></div><div class="recall-page-metrics"><span><strong>${escapeHtml(String(groups.length))}</strong>${escapeHtml(_cognitionText('cognition.ontology_groups', '分组'))}</span><span><strong>${escapeHtml(String(ontologyCandidates.length))}</strong>${escapeHtml(_cognitionText('cognition.ontology_candidates', '待审候选'))}</span></div></div><div class="recall-ontology-workbench"><section class="recall-ontology-list">${rows}</section><section class="recall-ontology-detail">${detail}</section></div>`;
}

function _renderCognitionCaptureStatus() {
  const captures = Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [];
  const counts = _skillsCognitionState.captureCounts || {};
  const conversationTitles = new Map((Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .map((item) => [item.id, item.title || item.id]));
  const rows = captures.length
    ? captures.slice(0, 5).map((capture) => {
      const title = conversationTitles.get(capture.conversationId) || capture.conversationId;
      const action = capture.status === 'review_ready'
        ? `<button class="btn btn-sm" data-cognition-page-link="candidates">${escapeHtml(_cognitionText('cognition.capture_review_action', '审核候选'))}</button>`
        : capture.status === 'failed'
          ? `<button class="btn btn-sm" data-recall-capture-retry="${escapeHtml(capture.id)}">${escapeHtml(_cognitionText('common.retry', '重试'))}</button>`
          : capture.status === 'configuration_required'
            ? `<button class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button>`
            : '';
      const stageDetail = capture.status === 'review_ready'
        ? _cognitionText('cognition.capture_candidates_ready', '{count} 个候选待审核').replace('{count}', String((capture.candidateIds || []).length))
        : capture.status === 'no_candidate'
          ? _cognitionText('cognition.capture_no_candidate_detail', '本轮没有需要长期保留的内容')
          : _cognitionStatusLabel(capture.status);
      const detail = capture.recoveredAt && (capture.status === 'queued' || capture.status === 'extracting')
        ? `${_cognitionText('cognition.capture_recovered', '已恢复处理')} · ${stageDetail}`
        : stageDetail;
      return `<div class="skills-cognition-capture-row"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)} · ${escapeHtml(_cognitionDate(capture.updatedAt))}</span></div><span class="skills-cognition-status is-${escapeHtml(capture.status || '')}">${escapeHtml(_cognitionStatusLabel(capture.status))}</span>${action}</div>`;
    }).join('')
    : _renderCognitionEmpty(_cognitionText('cognition.captures_empty', '完成一轮会话后，沉淀状态会显示在这里'));
  const summary = [
    ['waiting', 'cognition.capture_filter_waiting', '待处理'],
    ['processing', 'cognition.capture_filter_processing', '处理中'],
    ['review', 'cognition.capture_filter_review', '待审核'],
    ['failed', 'cognition.capture_filter_failed', '失败'],
  ].map(([key, labelKey, fallback]) => `<span><b>${escapeHtml(String(counts[key] || 0))}</b>${escapeHtml(_cognitionText(labelKey, fallback))}</span>`).join('');
  return `<section class="skills-cognition-flow-band"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.capture_status', '会话沉淀'))}</h2><span>${escapeHtml(_cognitionText('cognition.capture_status_hint', '查看当前进度和下一步操作'))}</span><button class="btn btn-sm" data-cognition-page-link="captures">${escapeHtml(_cognitionText('cognition.capture_view_all_tasks', '查看全部任务'))}</button></div><div class="recall-capture-overview-counts">${summary}</div><div class="skills-cognition-capture-list">${rows}</div></section>`;
}

const _CAPTURE_FILTERS = ['all', 'waiting', 'processing', 'review', 'failed', 'completed', 'cancelled'];

function _captureStatusesForFilter(filter) {
  const groups = {
    waiting: ['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'paused', 'configuration_required'],
    processing: ['extracting'],
    review: ['review_ready'],
    failed: ['failed'],
    completed: ['no_candidate'],
    cancelled: ['cancelled'],
  };
  return groups[filter] || [];
}

function _captureFilterLabel(filter) {
  const labels = {
    all: _cognitionText('cognition.capture_filter_all', '全部'),
    waiting: _cognitionText('cognition.capture_filter_waiting', '待处理'),
    processing: _cognitionText('cognition.capture_filter_processing', '处理中'),
    review: _cognitionText('cognition.capture_filter_review', '待审核'),
    failed: _cognitionText('cognition.capture_filter_failed', '失败'),
    completed: _cognitionText('cognition.capture_filter_completed', '已完成'),
    cancelled: _cognitionText('cognition.capture_filter_cancelled', '已取消'),
  };
  return labels[filter] || filter;
}

function _capturePolicyLabel(policy) {
  const labels = {
    smart: _cognitionText('cognition.capture_policy_smart', '智能静默'),
    immediate: _cognitionText('cognition.capture_policy_immediate', '立即'),
    nightly: _cognitionText('cognition.capture_policy_nightly', '夜间'),
    manual: _cognitionText('cognition.capture_policy_manual', '手动'),
  };
  return labels[policy] || policy || labels.smart;
}

function _captureStageLabel(stage) {
  const labels = {
    model_check: _cognitionText('cognition.capture_stage_model_check', '检查模型'),
    recall_view: _cognitionText('cognition.capture_stage_recall_view', '构建 RecallView'),
    model_extraction: _cognitionText('cognition.capture_stage_model_extraction', '提取内容'),
    candidate_save: _cognitionText('cognition.capture_stage_candidate_save', '保存 Candidate'),
  };
  return labels[stage] || '';
}

function _captureErrorLabel(code) {
  const labels = {
    model_not_configured: _cognitionText('cognition.capture_error_model_not_configured', '尚未配置可用模型'),
    model_auth_required: _cognitionText('cognition.capture_error_model_auth_required', '模型授权已失效，请重新授权'),
    source_unavailable: _cognitionText('cognition.capture_error_source_unavailable', '原会话内容暂时无法读取'),
    recall_view_failed: _cognitionText('cognition.capture_error_recall_view_failed', 'RecallView 构建失败'),
    model_failed: _cognitionText('cognition.capture_error_model_failed', '模型提取未成功完成'),
    invalid_model_output: _cognitionText('cognition.capture_error_invalid_model_output', '模型返回内容无法解析'),
    candidate_save_failed: _cognitionText('cognition.capture_error_candidate_save_failed', 'Candidate 保存失败'),
    conversation_failed: _cognitionText('cognition.capture_error_conversation_failed', '会话未成功完成，请手动决定是否沉淀'),
    conversation_cancelled: _cognitionText('cognition.capture_error_conversation_cancelled', '会话已取消，请手动决定是否沉淀'),
    capture_failed: _cognitionText('cognition.capture_error_unknown', '沉淀任务发生未知错误'),
  };
  return labels[code] || labels.capture_failed;
}

function _captureDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function _captureActionButton(capture, action, key, fallback, primary = false, danger = false) {
  const cls = danger ? 'btn-danger' : primary ? 'btn-primary' : '';
  return `<button type="button" class="btn btn-sm ${cls}" data-recall-capture-action="${escapeHtml(action)}" data-recall-capture-id="${escapeHtml(capture.id)}">${escapeHtml(_cognitionText(key, fallback))}</button>`;
}

function _captureTaskActions(capture) {
  const actions = [];
  const finalizing = capture.status === 'extracting' && capture.stage === 'candidate_save';
  if (['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'paused'].includes(capture.status)) {
    actions.push(_captureActionButton(capture, 'run-now', 'cognition.capture_run_now', '立即执行', true));
  }
  if (['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'extracting'].includes(capture.status) && !finalizing) {
    actions.push(_captureActionButton(capture, 'pause', 'cognition.capture_pause', '暂停'));
  }
  if (capture.status === 'paused') {
    actions.push(_captureActionButton(capture, 'resume', 'cognition.capture_resume', '继续', true));
  }
  if (capture.status === 'failed' || capture.status === 'configuration_required') {
    actions.push(_captureActionButton(capture, 'retry', 'common.retry', '重试', true));
  }
  if (!['review_ready', 'no_candidate', 'cancelled'].includes(capture.status) && !finalizing) {
    actions.push(_captureActionButton(capture, 'cancel', 'cognition.capture_cancel', '取消', false, true));
  }
  actions.push(_captureActionButton(capture, 'open-conversation', 'cognition.capture_open_conversation', '打开会话'));
  if ((capture.candidateIds || []).length) {
    actions.push(_captureActionButton(capture, 'view-candidates', 'cognition.capture_view_candidates', '查看 Candidate'));
  }
  return actions.join('');
}

function _captureTaskDetail(capture) {
  if (_skillsCognitionState.selectedCaptureId !== capture.id) return '';
  const usage = capture.modelUsage || {};
  const usageText = Number.isFinite(usage.totalTokens)
    ? String(usage.totalTokens)
    : [usage.inputTokens, usage.outputTokens].some(Number.isFinite)
      ? `${Number(usage.inputTokens) || 0} / ${Number(usage.outputTokens) || 0}`
      : '—';
  const timeline = [
    [_cognitionText('cognition.capture_created_at', '创建'), capture.createdAt],
    [_cognitionText('cognition.capture_last_activity_at', '最后活动'), capture.lastActivityAt],
    [_cognitionText('cognition.capture_scheduled_for', '计划执行'), capture.scheduledFor],
    [_cognitionText('cognition.capture_started_at', '开始'), capture.startedAt],
    [_cognitionText('cognition.capture_finished_at', '结束'), capture.finishedAt],
  ].filter((item) => item[1]).map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(_cognitionDate(value))}</span>`).join('');
  const error = capture.errorCode
    ? `<div class="recall-capture-task-error"><b>${escapeHtml(_cognitionText('cognition.capture_error', '失败原因'))}</b><span>${escapeHtml(_captureErrorLabel(capture.errorCode))}</span></div>`
    : '';
  return `<div class="recall-capture-task-detail">
    <div class="recall-capture-task-metrics">
      <span><b>${escapeHtml(_cognitionText('cognition.capture_policy', '执行策略'))}</b>${escapeHtml(_capturePolicyLabel(capture.executionPolicy))}</span>
      <span><b>${escapeHtml(_cognitionText('cognition.capture_attempt', '尝试次数'))}</b>${escapeHtml(String(capture.attempt || 1))}</span>
      <span><b>${escapeHtml(_cognitionText('cognition.capture_duration', '耗时'))}</b>${escapeHtml(_captureDuration(capture.durationMs))}</span>
      <span><b>${escapeHtml(_cognitionText('cognition.capture_token_usage', 'Token'))}</b>${escapeHtml(usageText)}</span>
      <span><b>Candidate</b>${escapeHtml(String((capture.candidateIds || []).length))}</span>
      <span><b>RecallView</b>${escapeHtml(capture.recallViewId || '—')}</span>
    </div>
    <div class="recall-capture-task-timeline">${timeline}</div>
    ${error}
    <div class="skills-cognition-actions">${_captureTaskActions(capture)}</div>
  </div>`;
}

function _renderCaptureSettings() {
  const settings = _skillsCognitionState.captureSettings || {
    enabled: true, executionPolicy: 'smart', quietMinutes: 10, nightlyStart: '02:00', nightlyEnd: '06:00', catchUpMissed: true,
  };
  const model = _skillsCognitionState.captureModel || {};
  const modelReady = !!model.configured && !model.authorizationRequired;
  const modelName = [model.provider, model.model].filter(Boolean).join(' · ')
    || (model.configured
      ? _cognitionText('cognition.capture_model_default', '默认模型')
      : _cognitionText('cognition.capture_model_unconfigured', '尚未配置模型'));
  const policies = ['smart', 'nightly', 'manual'].map((policy) => `<button type="button" class="recall-capture-policy${settings.executionPolicy === policy ? ' is-active' : ''}" data-recall-capture-policy="${policy}" aria-pressed="${settings.executionPolicy === policy ? 'true' : 'false'}" ${settings.enabled ? '' : 'disabled'}>${escapeHtml(_capturePolicyLabel(policy))}</button>`).join('');
  const quietMinutes = Number.isInteger(settings.quietMinutes) ? settings.quietMinutes : 10;
  const quietOptions = [...new Set([5, 10, 30, quietMinutes])].sort((left, right) => left - right)
    .map((minutes) => `<option value="${minutes}" ${quietMinutes === minutes ? 'selected' : ''}>${escapeHtml(_cognitionText('cognition.capture_quiet_minutes_option', '{count} 分钟').replace('{count}', String(minutes)))}</option>`).join('');
  return `<section class="recall-capture-control-panel">
    <div class="recall-capture-control-head">
      <div><h2>${escapeHtml(_cognitionText('cognition.capture_control_title', '沉淀控制'))}</h2><span>${escapeHtml(_cognitionText('cognition.capture_trigger_fixed', '会话完成后先等待静默；继续对话会自动顺延'))}</span></div>
      <label class="recall-capture-master"><input type="checkbox" data-recall-capture-enabled ${settings.enabled ? 'checked' : ''}><span>${escapeHtml(settings.enabled ? _cognitionText('common.enabled', '已开启') : _cognitionText('common.disabled', '已关闭'))}</span></label>
    </div>
    <div class="recall-capture-control-grid">
      <div class="recall-capture-control-field"><label>${escapeHtml(_cognitionText('cognition.capture_execution_policy', '执行时机'))}</label><div class="recall-capture-policy-group" role="group">${policies}</div></div>
      <div class="recall-capture-control-field recall-capture-quiet-window" ${settings.executionPolicy === 'manual' ? 'hidden' : ''}><label>${escapeHtml(_cognitionText('cognition.capture_quiet_period', '静默等待'))}</label><select data-recall-capture-quiet-minutes ${settings.enabled ? '' : 'disabled'}>${quietOptions}</select><span>${escapeHtml(_cognitionText('cognition.capture_quiet_hint', '期间继续对话会重新计时'))}</span></div>
      <div class="recall-capture-control-field recall-capture-night-window" ${settings.executionPolicy === 'nightly' ? '' : 'hidden'}><label>${escapeHtml(_cognitionText('cognition.capture_nightly_window', '夜间窗口'))}</label><div><input type="time" data-recall-capture-night-start value="${escapeHtml(settings.nightlyStart)}" ${settings.enabled ? '' : 'disabled'}><span>–</span><input type="time" data-recall-capture-night-end value="${escapeHtml(settings.nightlyEnd)}" ${settings.enabled ? '' : 'disabled'}></div><label class="recall-capture-check"><input type="checkbox" data-recall-capture-catch-up ${settings.catchUpMissed ? 'checked' : ''} ${settings.enabled ? '' : 'disabled'}>${escapeHtml(_cognitionText('cognition.capture_catch_up', '错过后空闲补跑'))}</label></div>
      <div class="recall-capture-model-state"><div><label>${escapeHtml(_cognitionText('cognition.capture_model', '沉淀模型'))}</label><strong>${escapeHtml(modelName)}</strong><span class="skills-cognition-status is-${modelReady ? 'ready' : 'configuration_required'}">${escapeHtml(modelReady ? _cognitionText('cognition.capture_model_ready', '可用') : _cognitionText('cognition.capture_configuration_required', '需要配置模型'))}</span></div><button type="button" class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button></div>
    </div>
  </section>`;
}

function _renderManualConversationPicker() {
  const settings = _skillsCognitionState.captureSettings || {};
  if (settings.executionPolicy !== 'manual') return '';

  const conversations = (Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .filter((item) => item.subtype === 'session')
    .sort((left, right) => String(right.sourceVersion || '').localeCompare(String(left.sourceVersion || '')));
  const selected = new Set(Array.isArray(_skillsCognitionState.selectedHistoricalConversationIds)
    ? _skillsCognitionState.selectedHistoricalConversationIds
    : []);
  const queued = new Set((Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : [])
    .filter((capture) => capture.status !== 'cancelled')
    .map((capture) => capture.conversationId));
  const rows = conversations.length ? conversations.map((conversation) => {
    const added = queued.has(conversation.id);
    const checked = selected.has(conversation.id) && !added;
    const state = added
      ? `<span class="skills-cognition-status is-waiting_manual">${escapeHtml(_cognitionText('cognition.capture_manual_history_added', '已加入任务'))}</span>`
      : '';
    return `<label class="recall-manual-conversation${added ? ' is-added' : ''}">
      <input type="checkbox" data-recall-manual-conversation="${escapeHtml(conversation.id)}" ${checked ? 'checked' : ''} ${added || !settings.enabled ? 'disabled' : ''}>
      <span class="recall-manual-conversation-main"><strong>${escapeHtml(conversation.title || conversation.id)}</strong><small>${escapeHtml(_cognitionDate(conversation.sourceVersion))}</small></span>
      ${state}
    </label>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.capture_manual_history_empty', '暂无可选择的历史会话'));
  const count = conversations.reduce((total, conversation) => total + (!queued.has(conversation.id) && selected.has(conversation.id) ? 1 : 0), 0);
  const actionLabel = _cognitionText('cognition.capture_manual_history_create', '加入沉淀任务');
  return `<section class="recall-manual-history">
    <div class="recall-manual-history-head">
      <div><h2>${escapeHtml(_cognitionText('cognition.capture_manual_history_title', '选择历史会话'))}</h2><p>${escapeHtml(_cognitionText('cognition.capture_manual_history_hint', '选择已完成的会话，加入待处理沉淀任务'))}</p></div>
      <button type="button" class="btn btn-sm btn-primary" data-recall-manual-create ${count && settings.enabled ? '' : 'disabled'}>${escapeHtml(actionLabel)}${count ? ` (${escapeHtml(String(count))})` : ''}</button>
    </div>
    <div class="recall-manual-history-source">${escapeHtml(_cognitionText('cognition.capture_manual_history_source', 'Orkas 历史会话'))}</div>
    <div class="recall-manual-conversation-list">${rows}</div>
  </section>`;
}

function renderSkillsCognitionCaptures() {
  const host = document.getElementById('skills-cognition-captures-body');
  if (!host) return;
  const captures = Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : [];
  const conversationTitles = new Map((Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .map((item) => [item.id, item.title || item.id]));
  const counts = _skillsCognitionState.captureCounts || {};
  const countValues = { all: Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0), ...counts };
  const filters = _CAPTURE_FILTERS.map((filter) => `<button type="button" class="recall-capture-filter${_skillsCognitionState.captureFilter === filter ? ' is-active' : ''}" data-recall-capture-filter="${filter}"><span>${escapeHtml(_captureFilterLabel(filter))}</span><b>${escapeHtml(String(countValues[filter] || 0))}</b></button>`).join('');
  const rows = captures.length ? captures.map((capture) => {
    const title = capture.conversationTitle || conversationTitles.get(capture.conversationId) || capture.conversationId;
    const stage = capture.stage ? ` · ${_captureStageLabel(capture.stage)}` : '';
    const schedule = ['waiting_quiet', 'scheduled'].includes(capture.status) && capture.scheduledFor
      ? ` · ${capture.status === 'waiting_quiet' ? _cognitionText('cognition.capture_quiet_until', '静默至') : _cognitionText('cognition.capture_scheduled_for', '计划执行')} ${_cognitionDate(capture.scheduledFor)}`
      : '';
    const selected = _skillsCognitionState.selectedCaptureId === capture.id ? ' is-selected' : '';
    return `<article class="recall-capture-task${selected}" data-recall-capture-task="${escapeHtml(capture.id)}">
      <button type="button" class="recall-capture-task-summary" data-recall-capture-select="${escapeHtml(capture.id)}" aria-expanded="${selected ? 'true' : 'false'}">
        <span class="recall-capture-task-main"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(_capturePolicyLabel(capture.executionPolicy))}${escapeHtml(stage)}${escapeHtml(schedule)}</small></span>
        <span class="recall-capture-task-result"><b>${escapeHtml(String((capture.candidateIds || []).length))}</b><small>Candidate</small></span>
        <span class="skills-cognition-status is-${escapeHtml(capture.status || '')}">${escapeHtml(_cognitionStatusLabel(capture.status))}</span>
        <span class="recall-capture-task-time">${escapeHtml(_cognitionDate(capture.updatedAt))}</span>
      </button>${_captureTaskDetail(capture)}
    </article>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.capture_tasks_empty', '暂无沉淀任务'));
  const more = _skillsCognitionState.captureNextCursor
    ? `<button type="button" class="btn btn-sm recall-capture-load-more" data-recall-capture-load-more>${escapeHtml(_cognitionText('common.load_more', '加载更多'))}</button>`
    : '';
  host.innerHTML = `${_renderCaptureSettings()}${_renderManualConversationPicker()}<section class="recall-capture-task-workbench"><div class="recall-capture-filter-bar">${filters}</div><div class="recall-capture-task-list">${rows}</div>${more}</section>`;
}

async function loadRecallCaptureTasks(options = {}) {
  const append = options.append === true;
  const filter = _skillsCognitionState.captureFilter || 'all';
  const statuses = _captureStatusesForFilter(filter);
  const payload = { limit: 25 };
  if (statuses.length) payload.statuses = statuses;
  if (append && _skillsCognitionState.captureNextCursor) payload.cursor = _skillsCognitionState.captureNextCursor;
  const result = await window.orkas.invoke('recall.captures.list', payload);
  if (!result?.ok) throw new Error(result?.error || 'recall capture list failed');
  if (append) {
    const byId = new Map((_skillsCognitionState.captures || []).map((capture) => [capture.id, capture]));
    for (const capture of result.captures || []) byId.set(capture.id, capture);
    _skillsCognitionState.captures = Array.from(byId.values());
  } else {
    _skillsCognitionState.captures = result.captures || [];
  }
  _skillsCognitionState.captureCounts = result.counts || _skillsCognitionState.captureCounts;
  _skillsCognitionState.captureNextCursor = result.nextCursor || null;
  renderSkillsCognitionCaptures();
}

async function updateRecallCaptureSettings(patch) {
  const result = await window.orkas.invoke('recall.captures.settings.update', patch);
  if (!result?.ok) throw new Error(result?.error || 'recall capture settings update failed');
  _skillsCognitionState.captureSettings = result.settings;
  renderSkillsCognitionCaptures();
}

function _renderCognitionPipelineStatus() {
  const sources = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const views = Array.isArray(_skillsCognitionState.recallViews) ? _skillsCognitionState.recallViews : [];
  const captures = Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [];
  const pendingCandidates = (Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [])
    .filter((candidate) => candidate.status === 'pending' || candidate.status === 'deferred');
  const latestCapture = captures[0];
  let next = _cognitionText('cognition.pipeline_next_conversation', '下一步：完成一轮会话，系统会自动整理 RecallView');
  let action = '';
  if (latestCapture?.status === 'configuration_required') {
    next = _cognitionText('cognition.pipeline_next_configure', '下一步：配置模型后重试本轮沉淀');
    action = `<button class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button>`;
  } else if (latestCapture?.status === 'failed') {
    next = _cognitionText('cognition.pipeline_next_retry', '下一步：重试失败的会话沉淀');
    action = `<button class="btn btn-sm" data-recall-capture-retry="${escapeHtml(latestCapture.id)}">${escapeHtml(_cognitionText('common.retry', '重试'))}</button>`;
  } else if (latestCapture?.status === 'waiting_completion') {
    next = _cognitionText('cognition.pipeline_next_completion', '下一步：先完成当前会话，完成后将重新计时');
  } else if (latestCapture?.status === 'waiting_quiet') {
    next = _cognitionText('cognition.pipeline_next_quiet', '下一步：等待静默期结束，继续对话会顺延沉淀');
  } else if (latestCapture?.status === 'waiting_manual' || latestCapture?.status === 'scheduled' || latestCapture?.status === 'queued' || latestCapture?.status === 'extracting' || latestCapture?.status === 'paused') {
    next = _cognitionText('cognition.pipeline_next_wait', '下一步：等待模型完成提炼');
  } else if (pendingCandidates.length || latestCapture?.status === 'review_ready') {
    next = _cognitionText('cognition.pipeline_next_review', '下一步：审核候选，确认后才会进入正式资产');
    action = `<button class="btn btn-sm" data-cognition-page-link="candidates">${escapeHtml(_cognitionText('cognition.capture_review_action', '审核候选'))}</button>`;
  }
  const stages = [
    [_cognitionText('cognition.pipeline_sources', '认知来源'), sources.reduce((sum, source) => sum + Number(source.count || 0), 0)],
    ['RecallView', views.length],
    [_cognitionText('cognition.pipeline_candidates', '待审 Candidate'), pendingCandidates.length],
  ].map(([label, count], index) => `<span class="skills-cognition-source-state"><b>${escapeHtml(label)}</b><em>${escapeHtml(String(count))}</em>${index < 2 ? '<i aria-hidden="true">→</i>' : ''}</span>`).join('');
  return `<section class="skills-cognition-flow-band"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.pipeline_title', '数据沉淀链路'))}</h2><span>${escapeHtml(next)}</span>${action}</div><div class="skills-cognition-source-row cognition-pipeline-row">${stages}</div></section>`;
}

function _renderTeachingSignalStatus() {
  const signals = Array.isArray(_skillsCognitionState.teachingSignals) ? _skillsCognitionState.teachingSignals : [];
  const rows = signals.length ? signals.slice(0, 5).map((signal) => {
    const status = signal.status === 'revoked'
      ? _cognitionText('cognition.teaching_revoked', '已撤销')
      : _cognitionText('cognition.teaching_pending', '已记住 · Candidate 待审');
    const action = signal.status === 'active'
      ? `<button class="btn btn-sm" data-recall-teaching-revoke="${escapeHtml(signal.id)}">${escapeHtml(_cognitionText('cognition.teaching_revoke', '撤销'))}</button>`
      : '';
    return `<div class="skills-cognition-capture-row"><div><strong>${escapeHtml(signal.summary || signal.id)}</strong><span>${escapeHtml(signal.scope || '')} · ${escapeHtml(_cognitionDate(signal.createdAt))}</span></div><span class="skills-cognition-status is-${escapeHtml(signal.status || '')}">${escapeHtml(status)}</span>${action}</div>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.teaching_empty', '明确的记住、偏好、避免或纠正会在这里留下可撤销回执'));
  return `<section class="skills-cognition-flow-band"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.teaching_title', '教学信号'))}</h2><span>${escapeHtml(_cognitionText('cognition.teaching_hint', 'Memory 即时生效，Candidate 仍需审核'))}</span></div><div class="skills-cognition-capture-list">${rows}</div></section>`;
}

function renderSkillsCognitionOverview() {
  const host = document.getElementById('skills-cognition-overview-body');
  if (!host) return;
  const d = _skillsCognitionState.dashboard || {};
  const counts = d.counts || {};
  const candidates = Array.isArray(d.pendingCandidates) ? d.pendingCandidates : _skillsCognitionState.candidates;
  const receipts = Array.isArray(d.recentReceipts) ? d.recentReceipts : _skillsCognitionState.receipts;
  const warnings = Array.isArray(d.warnings) ? d.warnings : [];
  const loadErrors = Array.isArray(_skillsCognitionState.loadErrors) ? _skillsCognitionState.loadErrors : [];
  const cards = [
    ['cognition.skill_count', '技能', counts.skills || 0],
    ['cognition.pending_candidates', '待审候选', counts.pendingCandidates || 0],
    ['cognition.reuse_receipts', '复用证明', counts.receipts || 0],
    ['cognition.assets_count', '资产', counts.assets || 0],
  ].map(([key, fallback, value]) => `<div class="skills-cognition-stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(_cognitionText(key, fallback))}</span></div>`).join('');
  const warningHtml = warnings.length
    ? `<div class="skills-cognition-warning">${escapeHtml(_cognitionText('cognition.warning_prefix', '需要关注'))}：${warnings.map((w) => `${escapeHtml(w.code)} (${escapeHtml(String(w.count))})`).join('、')}</div>`
    : '';
  const loadFailureHtml = loadErrors.length
    ? `<div class="skills-cognition-warning"><span>${escapeHtml(_cognitionText('cognition.load_failed', '认知资产数据加载失败'))}</span><button class="btn btn-sm" data-cognition-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`
    : '';
  const recentHtml = receipts.length
    ? receipts.slice(0, 5).map((r) => `<button type="button" class="skills-cognition-list-card" data-cognition-open-receipt="${escapeHtml(r.executionId)}"><strong>${escapeHtml(r.agentId || r.targetSessionId || r.executionId)}</strong><span>${escapeHtml(_cognitionStatusLabel(r.status))} · ${escapeHtml(_cognitionDate(r.createdAt))}</span></button>`).join('')
    : _renderCognitionEmpty(_cognitionText('cognition.no_receipts', '暂无复用证明'));
  const pendingHtml = candidates.length
    ? candidates.slice(0, 5).map((c) => `<button type="button" class="skills-cognition-list-card" data-cognition-open-candidate="${escapeHtml(c.id)}"><strong>${escapeHtml(c.title || c.summary)}</strong><span>${escapeHtml(_cognitionTypeLabel(c.type))} · ${escapeHtml(c.source)}</span></button>`).join('')
    : _renderCognitionEmpty(_cognitionText('cognition.no_candidates', '暂无待确认候选'));
  host.innerHTML = `
    ${d.degraded ? `<div class="skills-cognition-warning">${escapeHtml(_cognitionText('cognition.degraded', '部分认知数据处于降级状态'))}</div>` : ''}
    ${loadFailureHtml}
    ${warningHtml}
    ${_renderCognitionPipelineStatus()}
    ${_renderCognitionSourceStatus()}
    ${_renderCognitionCaptureStatus()}
    ${_renderTeachingSignalStatus()}
    <div class="skills-cognition-stat-grid">${cards}</div>
    <div class="skills-cognition-columns">
      <section class="skills-cognition-card"><h2>${escapeHtml(_cognitionText('cognition.recent_reuse', '最近复用'))}</h2>${recentHtml}</section>
      <section class="skills-cognition-card"><h2>${escapeHtml(_cognitionText('cognition.pending_review', '待确认认知候选'))}</h2>${pendingHtml}</section>
    </div>`;
}

function renderSkillsCognitionDeposition() {
  const view = _skillsCognitionState.depositionView || 'candidates';
  document.querySelectorAll('[data-cognition-deposition-body]').forEach((el) => {
    const active = el.dataset.cognitionDepositionBody === view;
    el.hidden = !active;
  });
  document.querySelectorAll('[data-cognition-deposition-view]').forEach((el) => {
    const active = el.dataset.cognitionDepositionView === view;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (view === 'sources') renderSkillsCognitionSources();
  else if (view === 'captures') renderSkillsCognitionCaptures();
  else renderSkillsCognitionCandidates();
}

function renderSkillsCognitionCandidates() {
  const host = document.getElementById('skills-cognition-candidates-body');
  if (!host) return;
  const items = _skillsCognitionState.candidates;
  const recallItems = Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [];
  if (!items.length && !recallItems.length) { host.innerHTML = _renderCognitionEmpty(_cognitionText('cognition.no_candidates', '暂无待确认候选')); return; }
  host.innerHTML = `<div class="skills-cognition-record-list">${items.map((c) => {
    const fallbackActions = c.source === 'personal_ontology' ? ['open_personal_ontology'] : ['source', 'accept', 'reject'];
    const actions = Array.isArray(c.actions) && c.actions.length ? c.actions : fallbackActions;
    const actionHtml = actions.map((action) => {
      if (action === 'open_personal_ontology') {
        return `<button class="btn btn-sm btn-primary" data-cognition-candidate-action="open-personal-ontology" data-cognition-candidate-id="${escapeHtml(c.sourceId)}">${escapeHtml(_cognitionText('cognition.open_personal_ontology', '去个人本体处理'))}</button>`;
      }
      if (action === 'source') {
        return `<button class="btn btn-sm" data-cognition-candidate-action="source" data-cognition-candidate-source="${escapeHtml(c.source)}" data-cognition-candidate-id="${escapeHtml(c.sourceId)}">${escapeHtml(_cognitionText('cognition.view_source', '查看来源'))}</button>`;
      }
      if (action === 'import_to_recall') {
        return `<button class="btn btn-sm btn-primary" data-cognition-candidate-action="import-to-recall" data-cognition-candidate-id="${escapeHtml(c.sourceId)}">${escapeHtml(_cognitionText('cognition.import_to_recall', '进入正式审查'))}</button>`;
      }
      if (action === 'accept') {
        return `<button class="btn btn-sm btn-primary" data-cognition-candidate-action="accept" data-cognition-candidate-source="${escapeHtml(c.source)}" data-cognition-candidate-id="${escapeHtml(c.sourceId)}">${escapeHtml(_cognitionText('cognition.accept', '保存'))}</button>`;
      }
      if (action === 'reject') {
        return `<button class="btn btn-sm btn-danger" data-cognition-candidate-action="reject" data-cognition-candidate-source="${escapeHtml(c.source)}" data-cognition-candidate-id="${escapeHtml(c.sourceId)}">${escapeHtml(_cognitionText('cognition.reject', '拒绝'))}</button>`;
      }
      return '';
    }).join('');
    const target = c.targetAssetId ? `<div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.target_asset', '目标资产'))}</strong><div class="skills-cognition-ref-row"><span>${escapeHtml(c.targetAssetTitle || c.targetAssetId)}</span>${c.targetAssetTitle ? `<span>${escapeHtml(c.targetAssetId)}</span>` : ''}</div></div>` : '';
    const sourceRefs = `<div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.source_refs', '来源引用'))}</strong><div class="skills-cognition-ref-row">${_renderCognitionInlineRefs(c.sourceRefs)}</div></div>`;
    const evidenceRefs = `<div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}</strong><div class="skills-cognition-ref-row">${_renderCognitionInlineRefs(c.evidenceRefs)}</div></div>`;
    const diff = `<span class="skills-cognition-diff" data-cognition-diff-available="${c.diffAvailable ? 'true' : 'false'}">${escapeHtml(c.diffAvailable ? _cognitionText('cognition.diff_available', '有变更预览') : _cognitionText('cognition.no_diff', '无变更预览'))}</span>`;
    return `
    <article class="skills-cognition-record cognition-candidate-row" data-cognition-candidate-id="${escapeHtml(c.id)}">
      <div class="skills-cognition-record-head"><h2>${escapeHtml(c.title || c.id)}</h2><span class="skills-cognition-status">${escapeHtml(_cognitionTypeLabel(c.type))}</span></div>
      <p>${escapeHtml(c.summary || '')}</p>
      <div class="skills-cognition-meta">${escapeHtml(c.source)}${c.scope ? ` · ${escapeHtml(c.scope)}` : ''}${c.confidence ? ` · ${escapeHtml(c.confidence)}` : ''} · ${diff}</div>
      ${target}${sourceRefs}${evidenceRefs}
      <div class="skills-cognition-actions">${actionHtml}</div>
    </article>`;
  }).join('')}</div>${recallItems.length ? `<section class="skills-cognition-record-list recall-candidate-list"><h2>${escapeHtml(_cognitionText('cognition.recall_candidates', '正式认知候选'))}</h2>${recallItems.map((candidate) => {
    const refs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`) : [];
    const actions = candidate.status === 'pending' ? ['edit', 'defer', 'reject', 'promote'] : candidate.status === 'deferred' ? ['edit', 'resume', 'reject', 'promote'] : [];
    const editing = _skillsCognitionState.editingRecallCandidateId === candidate.id;
    const editForm = editing ? `<div class="skills-cognition-detail-block recall-candidate-editor"><label>${escapeHtml(_cognitionText('cognition.judgment', '我的判断'))}<textarea data-recall-edit-judgment>${escapeHtml(candidate.judgment || '')}</textarea></label><label>${escapeHtml(_cognitionText('cognition.summary', '摘要'))}<input data-recall-edit-summary value="${escapeHtml(candidate.summary || '')}"></label><label>${escapeHtml(_cognitionText('cognition.scope', '作用域'))}<input data-recall-edit-scope value="${escapeHtml(candidate.suggestedScope || '')}"></label><label>${escapeHtml(_cognitionText('cognition.type', '类型'))}<select data-recall-edit-type>${['personal','rule','template','skill_method'].map((type) => `<option value="${type}" ${candidate.suggestedType === type ? 'selected' : ''}>${escapeHtml(_abilityAssetCategoryLabel(type))}</option>`).join('')}</select></label><label>${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}<textarea data-recall-edit-evidence>${escapeHtml((candidate.sourceRefs || []).map((ref) => `${ref.kind}:${ref.id}`).join('\n'))}</textarea></label><div class="skills-cognition-actions"><button class="btn btn-sm btn-primary" data-recall-candidate-action="save-edit" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('common.save', '保存'))}</button><button class="btn btn-sm" data-recall-candidate-action="cancel-edit" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('common.cancel', '取消'))}</button></div></div>` : '';
    return `<article class="skills-cognition-record cognition-candidate-row" data-recall-candidate-id="${escapeHtml(candidate.id)}"><div class="skills-cognition-record-head"><h2>${escapeHtml(candidate.summary || candidate.judgment || candidate.id)}</h2><span class="skills-cognition-status">${escapeHtml(candidate.status || '')}</span></div><p>${escapeHtml(candidate.judgment || '')}</p><div class="skills-cognition-meta">${escapeHtml(candidate.suggestedType || '')} · ${escapeHtml(candidate.suggestedScope || '')}</div><div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}</strong><div class="skills-cognition-ref-row">${_renderCognitionInlineRefs(refs)}</div></div>${editForm}<div class="skills-cognition-actions">${actions.map((action) => `<button class="btn btn-sm ${action === 'promote' ? 'btn-primary' : action === 'reject' ? 'btn-danger' : ''}" data-recall-candidate-action="${escapeHtml(action)}" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(action === 'edit' ? _cognitionText('skills.edit', '编辑') : _cognitionText(`cognition.${action}`, action))}</button>`).join('')}</div></article>`;
  }).join('')}</section>` : ''}`
}

function _renderCognitionRefs(titleKey, titleFallback, refs) {
  const items = Array.isArray(refs) ? refs : [];
  const body = items.length
    ? `<ul>${items.map((ref) => `<li>${escapeHtml(ref)}</li>`).join('')}</ul>`
    : `<div class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.no_refs', '未记录引用'))}</div>`;
  return `<div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText(titleKey, titleFallback))}</strong>${body}</div>`;
}

function _renderCognitionReceiptDetail(receipt) {
  if (!receipt) return '';
  const meta = [
    ['cognition.receipt_id', '证明 ID', receipt.receiptId],
    ['cognition.execution_id', '执行 ID', receipt.executionId],
    ['cognition.source_session', '来源会话', receipt.sourceSessionId],
    ['cognition.target_session', '目标会话', receipt.targetSessionId],
    ['cognition.permission_mode', '权限模式', receipt.permissionMode],
    ['cognition.boundary', '边界', receipt.boundary],
    ['cognition.execution_kind', '执行类型', receipt.executionKind],
    ['cognition.agent', 'Agent', receipt.agentId],
    ['cognition.conversation', '会话', receipt.conversationId],
    ['cognition.completed_at', '完成时间', _cognitionDate(receipt.completedAt)],
  ].filter((item) => item[2]).map(([key, label, value]) => `<span><b>${escapeHtml(_cognitionText(key, label))}</b>${escapeHtml(String(value))}</span>`).join('');
  return `<section class="skills-cognition-detail" data-cognition-receipt-detail="${escapeHtml(receipt.executionId || '')}">
    <div class="skills-cognition-detail-meta">${meta}</div>
    ${_renderCognitionRefs('cognition.reused_refs', '复用引用', receipt.reusedRefs)}
    ${_renderCognitionRefs('cognition.omitted_refs', '省略引用', receipt.omittedRefs)}
    ${_renderCognitionRefs('cognition.allowed_scopes', '允许范围', receipt.allowedScopes)}
  </section>`;
}

async function openSkillsCognitionReceiptDetail(executionId) {
  const id = String(executionId || '').trim();
  if (!id) return;
  _skillsCognitionState.selectedReceiptId = id;
  if (!_skillsCognitionState.receiptDetails[id]) {
    try {
      const result = await window.orkas.invoke('cognition.receipts.read', { executionId: id });
      if (!result?.ok) throw new Error(result?.error || 'receipt unavailable');
      _skillsCognitionState.receiptDetails[id] = result.receipt || null;
    } catch (error) {
      _skillsCognitionState.receiptDetails[id] = { executionId: id, receiptId: id, status: 'degraded', targetSessionId: id, reusedRefs: [], omittedRefs: [], allowedScopes: [], permissionMode: '', boundary: 'degraded', error: (error && error.message) || String(error) };
    }
  }
  switchSkillsCognitionPage('receipts');
  renderSkillsCognitionReceipts();
}

function renderSkillsCognitionReceipts() {
  const host = document.getElementById('skills-cognition-receipts-body');
  if (!host) return;
  const items = _skillsCognitionState.receipts;
  if (!items.length) { host.innerHTML = _renderCognitionEmpty(_cognitionText('cognition.no_receipts', '暂无复用证明')); return; }
  host.innerHTML = `<div class="skills-cognition-record-list">${items.map((r) => {
    const selected = _skillsCognitionState.selectedReceiptId === r.executionId;
    const detail = selected ? _renderCognitionReceiptDetail(_skillsCognitionState.receiptDetails[r.executionId] || r) : '';
    return `
    <article class="skills-cognition-record cognition-receipt-row">
      <div class="skills-cognition-record-head"><h2>${escapeHtml(r.agentId || r.targetSessionId || r.executionId)}</h2><span class="skills-cognition-status">${escapeHtml(_cognitionStatusLabel(r.status))}</span></div>
      <p>${escapeHtml(r.reusedRefs?.slice(0, 4).join('、') || _cognitionText('cognition.no_refs', '未记录引用'))}</p>
      <div class="skills-cognition-meta">${escapeHtml(r.targetSessionId)} · ${escapeHtml(_cognitionDate(r.createdAt))}</div>
      <div class="skills-cognition-actions"><button class="btn btn-sm" data-cognition-open-receipt="${escapeHtml(r.executionId)}">${escapeHtml(_cognitionText('cognition.view_details', '查看详情'))}</button></div>
      ${detail}
    </article>`;
  }).join('')}</div>`;
}

function renderSkillsCognitionAssets() {
  const host = document.getElementById('skills-cognition-assets-body');
  if (!host) return;
  const items = _skillsCognitionState.assets;
  const view = _skillsCognitionState.assetSubview === 'tree' ? 'tree' : 'list';
  if (view === 'tree') {
    const buds = items.filter((item) => item.maturity === 'bud' || item.status === 'candidate').length;
    const lightLeaves = items.filter((item) => item.maturity === 'transfer_validated').length;
    const deepLeaves = items.filter((item) => item.maturity === 'effectiveness_validated').length;
    host.innerHTML = `<div class="ability-assets-tree-page">
      <section class="ability-tree-stage">
        <div class="ability-tree-branch ability-tree-personal">${escapeHtml(_abilityAssetCategoryLabel('personal'))}</div>
        <div class="ability-tree-branch ability-tree-rule">${escapeHtml(_abilityAssetCategoryLabel('rule'))}</div>
        <div class="ability-tree-branch ability-tree-template">${escapeHtml(_abilityAssetCategoryLabel('template'))}</div>
        <div class="ability-tree-branch ability-tree-skill">${escapeHtml(_abilityAssetCategoryLabel('skill_method'))}</div>
        <div class="ability-tree-node seed">${escapeHtml(_cognitionText('cognition.maturity_seed', '种子'))}</div>
        <div class="ability-tree-node bud">${escapeHtml(String(buds))}</div>
        <div class="ability-tree-node leaf">${escapeHtml(String(lightLeaves))}</div>
        <div class="ability-tree-node deep-leaf">${escapeHtml(String(deepLeaves))}</div>
      </section>
      <aside class="ability-tree-inspector">
        <h2>${escapeHtml(_cognitionText('cognition.cognition_tree', '认知树'))}</h2>
        <p>${escapeHtml(_cognitionText('cognition.tree_semantics', '芽点代表候选；浅叶代表Transfer Validated；深叶代表Effectiveness Proof。'))}</p>
        <dl>
          <div><dt>${escapeHtml(_cognitionText('cognition.maturity_bud', '芽点'))}</dt><dd>${escapeHtml(String(buds))}</dd></div>
          <div><dt>Transfer Validated</dt><dd>${escapeHtml(String(lightLeaves))}</dd></div>
          <div><dt>${escapeHtml(_cognitionText('cognition.maturity_deep_leaf', '深叶'))}</dt><dd>${escapeHtml(String(deepLeaves))}</dd></div>
        </dl>
      </aside>
    </div>`;
    return;
  }
  const categories = [
    ['personal', 'cognition.asset_category_personal', '关于我', 'cognition.asset_category_personal_desc', '长期角色与个人边界'],
    ['rule', 'cognition.asset_category_rule', '规则与判断', 'cognition.asset_category_rule_desc', '可复用的决策约束'],
    ['template', 'cognition.asset_category_template', '模板与范例', 'cognition.asset_category_template_desc', '结构与参考样例'],
    ['skill_method', 'cognition.asset_category_skill_method', '技能与方法', 'cognition.asset_category_skill_method_desc', '流程、工具与评价方法'],
  ];
  const summary = categories.map(([category, key, fallback, descKey, descFallback]) => {
    const active = _skillsCognitionState.assetCategoryFilter === category ? ' is-active' : '';
    return `
    <button type="button" class="ability-asset-summary-card${active}" data-ability-asset-category="${escapeHtml(category)}"><span>${escapeHtml(_cognitionText(key, fallback))}</span><strong>${escapeHtml(String(_abilityAssetSummary(items, category)))}</strong><small>${escapeHtml(_cognitionText(descKey, descFallback))}</small></button>
  `;
  }).join('');
  const filteredItems = _skillsCognitionState.assetCategoryFilter
    ? items.filter((item) => (item.category || item.type) === _skillsCognitionState.assetCategoryFilter)
    : items;
  if (!items.length) {
    host.innerHTML = `<div class="ability-assets-workbench">
      <div class="ability-asset-summary-grid">${summary}</div>
      <div class="ability-assets-empty">${escapeHtml(_cognitionText('cognition.no_ability_assets', '尚无正式资产。完成复用证明、确认带入正确并保存后，资产才会出现在这里。'))}</div>
    </div>`;
    return;
  }
  if (!filteredItems.length) {
    const selectedCategory = _abilityAssetCategoryLabel(_skillsCognitionState.assetCategoryFilter);
    host.innerHTML = `<div class="ability-assets-workbench">
      <div class="ability-asset-summary-grid">${summary}</div>
      <div class="ability-assets-management">
        <section class="ability-asset-list"><div class="ability-asset-list-head"><input class="asset-search" placeholder="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索名称、来源或Asset ID'))}" aria-label="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索名称、来源或Asset ID'))}"></div><div class="ability-assets-empty">${escapeHtml(_cognitionText('cognition.empty_asset_category', '该分类暂无能力资产'))}</div></section>
        <section class="ability-asset-detail"><div class="ability-assets-empty"><strong>${escapeHtml(selectedCategory)}</strong><br>${escapeHtml(_cognitionText('cognition.empty_asset_category_hint', '当候选被确认并保存为正式资产后，会出现在这里。'))}</div></section>
      </div>
    </div>`;
    return;
  }
  const selected = filteredItems.find((item) => item.id === _skillsCognitionState.selectedAssetId) || filteredItems.find((item) => item.status === 'active') || filteredItems[0];
  _skillsCognitionState.selectedAssetId = selected.id;
  const rows = filteredItems.map((a) => {
    const category = a.category || a.type;
    const selectedClass = a.id === selected.id ? ' is-selected' : '';
    return `<button type="button" class="skills-cognition-record cognition-asset-row ability-asset-list-row${selectedClass}" data-ability-asset-id="${escapeHtml(a.id)}">
      <span class="ability-asset-row-main"><strong>${escapeHtml(a.title || a.id)}</strong><small>${escapeHtml(_abilityAssetCategoryLabel(category))}${a.version ? ` · ${escapeHtml(a.version)}` : ''}${a.scope ? ` · ${escapeHtml(a.scope)}` : ''}</small></span>
      <span class="skills-cognition-status">${escapeHtml(_abilityAssetMaturityLabel(a.maturity, a.status))}</span>
    </button>`;
  }).join('');
  const selectedCategory = selected.category || selected.type;
  const detailGrid = [
    ['Asset ID', selected.id],
    [_cognitionText('cognition.version', '版本'), selected.version || '—'],
    ['Owner', selected.owner || 'local_user'],
    [_cognitionText('cognition.source', '来源'), selected.source || '—'],
    [_cognitionText('cognition.scope', '作用域'), selected.scope || '—'],
    [_cognitionText('cognition.maturity', '成熟度'), _abilityAssetMaturityLabel(selected.maturity, selected.status)],
  ].map(([label, value]) => `<div><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong></div>`).join('');
  const workspace = selected.workspaceRefs?.length ? selected.workspaceRefs.join('、') : _cognitionText('cognition.no_workspace_refs', '当前没有Workspace引用；正式资产仍保存在个人能力资产中心。');
  const relationRefs = Array.isArray(selected.relationRefs) ? selected.relationRefs : [];
  const relationText = relationRefs.length ? relationRefs.map(_cognitionRefText).join('、') : _cognitionText('cognition.no_refs', '未记录引用');
  const injection = selected.candidateRefs?.length
    ? _cognitionText('cognition.asset_candidate_preview', '这是待确认芽点；保存后才会获得稳定版本和默认注入资格。')
    : _cognitionText('cognition.asset_injection_preview', '下一次任务将建议使用已确认资产；使用前仍需确认范围。');
  host.innerHTML = `<div class="ability-assets-workbench">
    <div class="ability-asset-summary-grid">${summary}</div>
    <div class="ability-assets-management">
      <section class="ability-asset-list">
        <div class="ability-asset-list-head"><input class="asset-search" placeholder="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索名称、来源或Asset ID'))}" aria-label="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索名称、来源或Asset ID'))}"></div>
        <div class="skills-cognition-record-list ability-asset-list-body">${rows}</div>
      </section>
      <section class="ability-asset-detail">
        <div class="asset-detail-head"><div><h2>${escapeHtml(selected.title || selected.id)}</h2><p>${escapeHtml(_abilityAssetCategoryLabel(selectedCategory))} · ${escapeHtml(selected.source || '')}</p></div><span class="skills-cognition-status">${escapeHtml(_abilityAssetMaturityLabel(selected.maturity, selected.status))}</span></div>
        <div class="asset-detail-body">
          <div class="asset-detail-grid">${detailGrid}</div>
          <div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.relation_refs', '关联引用'))}</strong><p>${escapeHtml(relationText)}</p></div>
          <div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.workspace_refs', 'Workspace引用'))}</strong><p>${escapeHtml(workspace)}</p></div>
          <div class="injection-preview"><strong>${escapeHtml(_cognitionText('cognition.next_injection_preview', '下一次任务认知注入预览'))}</strong><p>${escapeHtml(injection)}</p></div>
          <div class="asset-controls"><button class="btn btn-sm" data-cognition-page-link="receipts">${escapeHtml(_cognitionText('cognition.view_reuse', '查看复用证明'))}</button><button class="btn btn-sm" data-cognition-page-link="candidates">${escapeHtml(_cognitionText('cognition.view_candidates', '查看候选'))}</button></div>
        </div>
      </section>
    </div>
  </div>`;
}

async function loadSkillsCognitionSnapshot() {
  if (_skillsCognitionState.loading) return;
  _skillsCognitionState.loading = true;
  const capturePayload = { limit: 25 };
  const captureStatuses = _captureStatusesForFilter(_skillsCognitionState.captureFilter);
  if (captureStatuses.length) capturePayload.statuses = captureStatuses;
  const [dashboard, candidates, recallCandidates, receipts, assets, sources, captures, recentCaptures, recallViews, contextProjections, ontologyGroups, teachingSignals, captureSettings] = await Promise.allSettled([
    window.orkas.invoke('cognition.dashboard.read'),
    window.orkas.invoke('cognition.candidates.list', { status: 'pending', limit: 200 }),
    window.orkas.invoke('recall.candidates.list'),
    window.orkas.invoke('cognition.receipts.list', { limit: 100 }),
    window.orkas.invoke('cognition.assets.list', { limit: 500 }),
    window.orkas.invoke('recall.sources.list', { limit: 100 }),
    window.orkas.invoke('recall.captures.list', capturePayload),
    window.orkas.invoke('recall.captures.list', { limit: 5 }),
    window.orkas.invoke('recall.views.list', { includeExpired: true, limit: 100 }),
    window.orkas.invoke('recall.projections.list', { includeExpired: true, limit: 100 }),
    window.orkas.invoke('personalOntology.groups.list'),
    window.orkas.invoke('recall.teaching.list', { limit: 20 }),
    window.orkas.invoke('recall.captures.settings.get'),
  ]);
  _skillsCognitionState.dashboard = dashboard.status === 'fulfilled' && dashboard.value?.ok ? dashboard.value.dashboard : null;
  _skillsCognitionState.candidates = candidates.status === 'fulfilled' && candidates.value?.ok ? (candidates.value.candidates || []) : [];
  _skillsCognitionState.recallCandidates = recallCandidates.status === 'fulfilled' && recallCandidates.value?.ok ? (recallCandidates.value.candidates || []) : [];
  _skillsCognitionState.receipts = receipts.status === 'fulfilled' && receipts.value?.ok ? (receipts.value.receipts || []) : [];
  _skillsCognitionState.assets = assets.status === 'fulfilled' && assets.value?.ok ? (assets.value.assets || []) : [];
  _skillsCognitionState.sources = sources.status === 'fulfilled' && sources.value?.ok ? (sources.value.sources || []) : [];
  _skillsCognitionState.captures = captures.status === 'fulfilled' && captures.value?.ok ? (captures.value.captures || []) : [];
  _skillsCognitionState.recentCaptures = recentCaptures.status === 'fulfilled' && recentCaptures.value?.ok ? (recentCaptures.value.captures || []) : [];
  _skillsCognitionState.captureCounts = captures.status === 'fulfilled' && captures.value?.ok ? (captures.value.counts || _skillsCognitionState.captureCounts) : _skillsCognitionState.captureCounts;
  _skillsCognitionState.captureNextCursor = captures.status === 'fulfilled' && captures.value?.ok ? (captures.value.nextCursor || null) : null;
  _skillsCognitionState.recallViews = recallViews.status === 'fulfilled' && recallViews.value?.ok ? (recallViews.value.views || []) : [];
  _skillsCognitionState.contextProjections = contextProjections.status === 'fulfilled' && contextProjections.value?.ok ? (contextProjections.value.projections || []) : [];
  _skillsCognitionState.ontologyGroups = ontologyGroups.status === 'fulfilled' && Array.isArray(ontologyGroups.value?.groups) ? ontologyGroups.value.groups : [];
  if (_skillsCognitionState.ontologyGroups.length) {
    const selectedExists = _skillsCognitionState.ontologyGroups.some((group) => group.group_id === _skillsCognitionState.selectedOntologyGroupId);
    if (!selectedExists) _skillsCognitionState.selectedOntologyGroupId = _skillsCognitionState.ontologyGroups[0].group_id;
    try { await loadRecallOntologyGroup(_skillsCognitionState.selectedOntologyGroupId); } catch (_) {}
  } else {
    _skillsCognitionState.selectedOntologyGroupId = '';
  }
  _skillsCognitionState.teachingSignals = teachingSignals.status === 'fulfilled' && teachingSignals.value?.ok ? (teachingSignals.value.signals || []) : [];
  _skillsCognitionState.captureSettings = captureSettings.status === 'fulfilled' && captureSettings.value?.ok ? captureSettings.value.settings : _skillsCognitionState.captureSettings;
  _skillsCognitionState.captureModel = captureSettings.status === 'fulfilled' && captureSettings.value?.ok ? captureSettings.value.model : _skillsCognitionState.captureModel;
  _skillsCognitionState.loadErrors = [
    ['dashboard', dashboard],
    ['candidates', candidates],
    ['recallCandidates', recallCandidates],
    ['receipts', receipts],
    ['assets', assets],
    ['sources', sources],
    ['captures', captures],
    ['recentCaptures', recentCaptures],
    ['recallViews', recallViews],
    ['contextProjections', contextProjections],
    ['teachingSignals', teachingSignals],
    ['captureSettings', captureSettings],
  ].filter(([, result]) => result.status !== 'fulfilled' || !result.value?.ok).map(([name]) => name);
  if (ontologyGroups.status !== 'fulfilled' || !Array.isArray(ontologyGroups.value?.groups)) _skillsCognitionState.loadErrors.push('ontologyGroups');
  _skillsCognitionState.loadedAt = Date.now();
  _skillsCognitionState.loading = false;
  renderSkillsCognitionOverview();
  if (_skillsCognitionState.page !== 'overview') _renderCognitionPage(_skillsCognitionState.page);
  if (_skillsCognitionRefreshTimer) clearTimeout(_skillsCognitionRefreshTimer);
  const visibleCaptures = [...(_skillsCognitionState.captures || []), ...(_skillsCognitionState.recentCaptures || [])];
  const captureInProgress = Number(_skillsCognitionState.captureCounts?.processing || 0) > 0
    || visibleCaptures.some((capture) => capture.status === 'queued' || capture.status === 'extracting');
  if (captureInProgress) {
    _skillsCognitionRefreshTimer = setTimeout(() => {
      _skillsCognitionRefreshTimer = null;
      if (typeof currentView !== 'undefined' && currentView === 'recall') {
        loadSkillsCognitionSnapshot().catch(() => {});
      }
    }, 3000);
  }
}

function _renderSkillCognitionVersions(skillId, versions) {
  const items = Array.isArray(versions) ? versions : [];
  if (!items.length) return '';
  return `<div class="skills-cognition-version-list"><h4>${escapeHtml(_cognitionText('cognition.version_history', '版本历史'))}</h4>${items.map((v) => {
    const rollback = v.canRollback
      ? `<button class="btn btn-xs" data-cognition-rollback-skill="${escapeHtml(skillId)}" data-cognition-version="${escapeHtml(v.version)}">${escapeHtml(_cognitionText('cognition.rollback', '回滚'))}</button>`
      : `<span class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.not_rollbackable', '不可回滚'))}</span>`;
    return `<div class="skills-cognition-version-row"><span><strong>${escapeHtml(v.version || '')}</strong>${v.note ? ` · ${escapeHtml(v.note)}` : ''}${v.at ? ` · ${escapeHtml(_cognitionDate(v.at))}` : ''}</span>${rollback}</div>`;
  }).join('')}</div>`;
}

async function rollbackSkillCognitionVersionFromDetail(skillId, version) {
  const sid = String(skillId || '').trim();
  const ver = String(version || '').trim();
  if (!sid || !ver) return;
  const message = _cognitionText('cognition.rollback_confirm', `确认回滚到版本 ${ver}？`).replace('{version}', ver);
  if (typeof uiConfirm === 'function' && !(await uiConfirm(message))) return;
  const result = await window.orkas.invoke('cognition.skills.rollback', { skillId: sid, version: ver });
  if (!result?.ok) throw new Error(result?.error || 'rollback failed');
  await refreshSkillCognitionSummary(sid);
  if (_selectedSkill?.id === sid && typeof selectSkillFile === 'function') await selectSkillFile(_selectedSkill.filepath || 'SKILL.md');
}

async function refreshSkillCognitionSummary(skillId) {
  const section = document.getElementById('skills-section-cognition');
  const host = document.getElementById('skills-cognition-summary');
  if (!section || !host || !skillId) return;
  section.style.display = '';
  host.innerHTML = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
  try {
    const result = await window.orkas.invoke('cognition.skills.summary', { skillId });
    if (!result?.ok) throw new Error(result?.error || 'summary unavailable');
    const s = result.summary || {};
    host.innerHTML = `
      <div class="skills-cognition-inline-grid">
        <span><strong>${escapeHtml(s.version || '—')}</strong>${escapeHtml(_cognitionText('cognition.current_version', '当前版本'))}</span>
        <span><strong>${escapeHtml(String(s.pendingCandidateCount || 0))}</strong>${escapeHtml(_cognitionText('cognition.pending_candidates', '待审候选'))}</span>
        <span><strong>${escapeHtml(String((s.recentReceipts || []).length))}</strong>${escapeHtml(_cognitionText('cognition.reuse_receipts', '复用证明'))}</span>
      </div>
      <div class="skills-cognition-inline-actions">
        <button class="btn btn-sm" data-cognition-page-link="receipts">${escapeHtml(_cognitionText('cognition.view_reuse', '查看复用证明'))}</button>
        <button class="btn btn-sm" data-cognition-page-link="candidates">${escapeHtml(_cognitionText('cognition.view_candidates', '查看候选'))}</button>
      </div>
      ${_renderSkillCognitionVersions(skillId, s.versions || [])}`;
  } catch (_) {
    section.style.display = 'none';
  }
}

function initSkillsCognitionConsole() {
  const panel = document.getElementById('panel-recall');
  if (!panel || panel.dataset.cognitionInitialized === '1') return;
  panel.dataset.cognitionInitialized = '1';
  _cognitionSetPageVisibility('overview');
  loadSkillsCognitionSnapshot().catch(() => {});
}

function _skillSource(source) {
  return (typeof normalizeCatalogSource === 'function')
    ? normalizeCatalogSource(source)
    : String(source || '');
}

function _isSkillPlatformSource(source) {
  return (typeof isMarketplaceCatalogSource === 'function')
    ? isMarketplaceCatalogSource(source)
    : _skillSource(source) === 'marketplace';
}

function _skillUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

function _skillCardChipsHtml(s) {
  const lang = getLang();
  const parts = [];
  const isPlatform = _isSkillPlatformSource(s && s.source);
  if (isPlatform && s.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(s.version));
    parts.push(`<span class="skill-card-chip is-version">${escapeHtml(versionLabel)}</span>`);
  }
  const catLabel = _resolveCategoryLabel(s && s.category, lang);
  if (catLabel) parts.push(`<span class="skill-card-chip">${escapeHtml(catLabel)}</span>`);
  return parts.join('');
}

// Re-render the skill grid + currently selected detail page when the UI
// language changes — descriptions are bilingual now and `pickDesc` returns
// a different string after the locale flip. Detail re-render goes through
// `selectSkillFile` so the SKILL.md frontmatter re-parses and the description picks the
// right locale via `_renderSkillSections`.
window.addEventListener('i18n-change', () => {
  refreshChatUseChips();
  if (_skillsCache) renderSkillsGrid(_skillsCache);
  if (_selectedSkill?.id && _selectedSkill?.source) {
    // Re-read the same file the user was viewing; null nodeEl preserves
    // the current tree highlight (selectSkillFile is tolerant of null).
    selectSkillFile(_selectedSkill.source, _selectedSkill.id, 'SKILL.md', null)
      .catch(() => { /* ignore */ });
  }
});
let _expandedDirs = new Set(); // keys like "source:id" or "source:id/subdir"
let _skillTreeCache = new Map(); // key: "source:id" → tree array

// Cross-module hook (renderer is classic scripts — top-level let/const are
// visible across files per PC/CLAUDE.md §8). Called from
// `conversation.js::_mountCreatedSkillChip` whenever the commander writes
// `<<<skill-file>>>` blocks into a skill the user might be viewing in the
// detail panel. Without this, the file tree on the detail page keeps showing
// the pre-edit set of files until the user navigates away and back.
// `id` matches any source (custom + marketplace) — commander writes flow
// through `updateAgentSpec` / `_applySkillContainerEdit` for both sources,
// so we don't filter by source here. If the user is currently viewing the
// affected skill AND the source panel is expanded, also re-fetch the tree
// so the new files appear without a manual refresh.
async function invalidateSkillTreeCacheFor(skillId) {
  if (!skillId) { _skillTreeCache.clear(); return; }
  for (const key of Array.from(_skillTreeCache.keys())) {
    if (key.endsWith(`:${skillId}`)) _skillTreeCache.delete(key);
  }
  if (_selectedSkill?.id !== skillId) return;
  const toggle = document.getElementById('skills-source-toggle');
  const treeEl = document.getElementById('skills-source-tree');
  if (toggle?.getAttribute('aria-expanded') === 'true' && treeEl) {
    await expandSkillTree(_selectedSkill.source, _selectedSkill.id, treeEl);
    _markActiveSkillFileInTree(_selectedSkill.filepath || 'SKILL.md');
  }
}

async function refreshSkillsAfterMarketplaceReconcile() {
  _skillTreeCache.clear();
  await loadSkills(true);
  if (_skillEditMode) return;
  if (_selectedSkill?.id && _isSkillPlatformSource(_selectedSkill.source)) {
    const source = _selectedSkill.source;
    const id = _selectedSkill.id;
    const filepath = _selectedSkill.filepath || 'SKILL.md';
    await selectSkillFile(source, id, filepath, null);
    const toggle = document.getElementById('skills-source-toggle');
    const treeEl = document.getElementById('skills-source-tree');
    if (toggle?.getAttribute('aria-expanded') === 'true' && treeEl) {
      await expandSkillTree(source, id, treeEl);
      _markActiveSkillFileInTree(filepath);
    }
  }
}

async function _refreshOpenSkillsCache() {
  try {
    const openRes = await window.orkas.invoke('skills.listOpen');
    _openSkillsCache = (openRes && openRes.ok && Array.isArray(openRes.skills)) ? openRes.skills : [];
  } catch { _openSkillsCache = []; }
}

async function _refreshPackagesCache() {
  try {
    const res = await window.orkas.invoke('packages.list');
    _packagesCache = (res && res.ok && Array.isArray(res.packages)) ? res.packages : [];
  } catch (err) {
    _skillsLog.warn('packages load failed', err);
    _packagesCache = [];
  }
}

// Dev-only: agent-private (`ownerAgent`) skills are hidden from the normal
// list. In dev mode fetch them and merge into the cache (deduped by id+source)
// so the panel can show a separate inspection section grouped by owning agent.
// No-op in production — the IPC is dev-gated and returns nothing there.
async function _mergeAgentPrivateSkills() {
  if (typeof isDevMode !== 'function' || !false || !Array.isArray(_skillsCache)) return;
  try {
    const res = await window.orkas.invoke('skills.listPrivate');
    const priv = (res && res.ok && Array.isArray(res.skills)) ? res.skills : [];
    if (!priv.length) return;
    const key = (s) => `${s.id} ${s.source}`;
    const seen = new Set(_skillsCache.map(key));
    const merged = priv
      .map((s) => ({ ...s, source: _skillSource(s.source) }))
      .filter((s) => !seen.has(key(s)));
    if (merged.length) _skillsCache = _skillsCache.concat(merged);
  } catch { /* dev-only tab; ignore */ }
}

async function loadSkills(forceRefresh) {
  if (_skillsLoadInFlight) {
    if (!forceRefresh) return _skillsLoadInFlight;
    await _skillsLoadInFlight.catch(() => {});
  }
  if (_skillsCache && !forceRefresh) {
    // External packages are installed by an out-of-process CLI, so the
    // trusted skills cache can still be current while the open-tier list has
    // changed underneath us. Refresh it whenever the Skills page is revisited.
    await _refreshOpenSkillsCache();
    await _refreshPackagesCache();
    renderSkillsList(_skillsCache);
    return;
  }
  _skillsLoadInFlight = (async () => {
    try {
      const res = await apiFetch(forceRefresh ? '/api/skills/list?force=1' : '/api/skills/list');
      const data = await res.json();
      // Open-tier skills (from external packages + global folders) are
      // read-only and live in a separate listing; fetched alongside so the
      // panel can show them under their own group with a source badge.
      await _refreshOpenSkillsCache();
      await _refreshPackagesCache();
      if (data.ok) {
        _skillsCache = (data.skills || []).map((s) => ({
          ...s,
          source: _skillSource(s.source),
        })).sort((a, b) => {
          const ka = _skillNameSortKey(a);
          const kb = _skillNameSortKey(b);
          if (ka < kb) return -1;
          if (ka > kb) return 1;
          return String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true, sensitivity: 'base' });
        });
        await _mergeAgentPrivateSkills();
        renderSkillsList(_skillsCache);
      }
    } catch (e) {
      _skillsLog.error('load skills failed', e);
    } finally {
      _skillsLoadInFlight = null;
    }
  })();
  return _skillsLoadInFlight;
}

function _skillNameSortKey(skill) {
  const name = String(skill?.name || skill?.id || '');
  return (typeof pinyinSortKey === 'function') ? pinyinSortKey(name) : name.toLowerCase();
}

function renderSkillsList(skills) { renderSkillsGrid(skills); }

// Active category-chip selection for the Skills page. Empty string = "All";
// matches `_mpState.category` semantics in marketplace.js.
let _skillsActiveCategory = '';

function renderSkillsGrid(skills) {
  const emptyEl = document.getElementById('skills-empty');
  const chipsHost = document.getElementById('skills-categories');
  const gridEl = document.getElementById('skills-grid');
  if (!gridEl) return;

  if (!skills.length) {
    if (chipsHost) chipsHost.innerHTML = '';
    // Even with no editable skills, open-tier skills (packages/global) may
    // exist — render them so they're visible + togglable.
    const openHtml = _openSkillsSectionHtml();
    if (openHtml) {
      gridEl.classList.add('is-sectioned');
      gridEl.innerHTML = openHtml;
      _wireOpenSkillCards(gridEl);
      if (emptyEl) emptyEl.style.display = 'none';
      return;
    }
    gridEl.classList.remove('is-sectioned');
    gridEl.innerHTML = '';
    if (emptyEl) {
      if (typeof _mpUpdateInstallingEmptyStates === 'function') _mpUpdateInstallingEmptyStates();
      else emptyEl.textContent = t('skills.empty');
      emptyEl.style.display = '';
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const useTitle = escapeHtml(t('skills.use_tooltip'));
  const moreTitle = escapeHtml(t('skills.more_actions'));
  const lang = getLang();
  const customChipLabel = t('skills.custom_group');
  const marketplaceGroupLabel = (() => {
    const raw = t('skills.builtin_group');
    return (raw && raw !== 'skills.builtin_group') ? raw : t('skills.source_marketplace');
  })();
  const allLabel = (() => {
    const raw = t('marketplace.all');
    return (raw && raw !== 'marketplace.all') ? raw : 'All';
  })();

  // Chip strip — `_mpCategoriesCache` is defined in marketplace.js (flat top-level scope).
  // Missing categories and non-registry category codes are treated as General.
  const canonicalCategoryCode = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  const cats = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const knownCodes = _knownCategoryCodes(cats);
  const rawCodesPresent = new Set(skills.map((s) => canonicalCategoryCode(s && s.category)));
  const unknownCodes = [...rawCodesPresent].filter((c) => c && !knownCodes.has(c)).sort();
  if (unknownCodes.length && typeof _mpMaybeRefreshCategoriesForCodes === 'function') {
    _mpMaybeRefreshCategoriesForCodes(unknownCodes);
  }
  const codesPresent = new Set([...rawCodesPresent].map((c) => _effectiveCategoryCode(c, knownCodes)));
  const chipCodes = [];
  const chipCodeSeen = new Set();
  for (const c of cats) {
    const code = canonicalCategoryCode(c && c.code);
    if (!code || !codesPresent.has(code) || chipCodeSeen.has(code)) continue;
    chipCodes.push({ code, label: pickLocalizedName(c, lang) || code });
    chipCodeSeen.add(code);
  }
  if (codesPresent.has('general') && !chipCodeSeen.has('general')) {
    chipCodes.push({ code: 'general', label: _generalCategoryLabel(lang) });
    chipCodeSeen.add('general');
  }
  if (_skillsActiveCategory === '__uncategorized__' || _skillsActiveCategory === '__unknown__') {
    _skillsActiveCategory = codesPresent.has('general') ? 'general' : '';
  }
  if (_skillsActiveCategory && !chipCodes.some((c) => c.code === _skillsActiveCategory)) {
    _skillsActiveCategory = '';
  }

  if (chipsHost) {
    const allActive = _skillsActiveCategory === '' ? ' is-active' : '';
    const chipsHtml = [
      `<button type="button" class="marketplace-chip${allActive}" data-skills-cat="">${escapeHtml(allLabel)}</button>`,
      ...chipCodes.map((c) => {
        const active = _skillsActiveCategory === c.code ? ' is-active' : '';
        return `<button type="button" class="marketplace-chip${active}" data-skills-cat="${escapeHtml(c.code)}">${escapeHtml(c.label)}</button>`;
      }),
    ].join('');
    chipsHost.innerHTML = chipsHtml;
    chipsHost.querySelectorAll('[data-skills-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _skillsActiveCategory = btn.dataset.skillsCat || '';
        if (_skillsCache) renderSkillsGrid(_skillsCache);
      });
    });
  }

  const filtered = skills.filter((s) => {
    if (_skillsActiveCategory === '') return true;
    return _effectiveCategoryCode(s && s.category, knownCodes) === _skillsActiveCategory;
  });

  const cardHtml = (s) => {
    const desc = pickDesc(s, lang).trim();
    const descClass = desc ? 'skill-card-desc' : 'skill-card-desc is-empty';
    const descText = desc || t('skills.no_desc');
    const moreBtn = `<button type="button" class="skill-card-more" data-skill-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const enabled = s.enabled !== false;
    const cardChips = _skillCardChipsHtml(s);
    return `
      <div class="skill-card${enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(s.id)}" data-source="${escapeHtml(s.source || '')}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(s.name)}</span>
          ${moreBtn}
        </div>
        <div class="${descClass}">${escapeHtml(descText)}</div>
        <div class="skill-card-actions">
          ${cardChips}
          <button type="button" class="skill-card-use" data-skill-use title="${useTitle}" aria-label="${useTitle}" ${enabled ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>
            ${escapeHtml(t('skills.use'))}
          </button>
        </div>
      </div>
    `;
  };

  const groups = { custom: [], marketplace: [], private: [] };
  for (const s of filtered) {
    // Agent-private skills (dev-only, merged in `_mergeAgentPrivateSkills`)
    // get their own per-owner sections below; never folded into custom.
    if (s.ownerAgent) { groups.private.push(s); continue; }
    const source = _skillSource(s?.source);
    if (source === 'marketplace') groups.marketplace.push(s);
    else groups.custom.push(s);
  }
  const sectionHtml = (label, list) => {
    if (!list.length) return '';
    return `
      <section class="skills-source-section">
        <div class="skills-source-section-head">
          <span>${escapeHtml(label)}</span>
          <span class="skills-source-section-count">${list.length}</span>
        </div>
        <div class="skills-source-section-grid">
          ${list.map(cardHtml).join('')}
        </div>
      </section>
    `;
  };
  // Dev-only inspection sections — one per owning agent, reusing the same card
  // and section markup. Empty (so absent) in production: the source IPC is
  // dev-gated, so `groups.private` is always empty there.
  let privateHtml = '';
  if (groups.private.length) {
    const baseLabel = t('skills.agent_private_group');
    const byOwner = new Map();
    for (const s of groups.private) {
      const owner = s.ownerAgent || '?';
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(s);
    }
    for (const [owner, list] of byOwner) privateHtml += sectionHtml(`${baseLabel} · ${owner}`, list);
  }
  gridEl.classList.add('is-sectioned');
  gridEl.innerHTML = sectionHtml(customChipLabel, groups.custom)
    + sectionHtml(marketplaceGroupLabel, groups.marketplace)
    + privateHtml
    + _openSkillsSectionHtml();
  _wireOpenSkillCards(gridEl);

  // Wire card / ▶ / ⋯ click handlers. (Enable/disable lives in the ⋯ menu now.)
  // Scope to editable-tier cards (`data-id`): open-tier cards (`data-open-id`,
  // external/global) are read-only and intentionally not navigable to a detail
  // view — they only carry an enable/disable toggle, wired by
  // `_wireOpenSkillCards`. Binding them here would open a broken detail page
  // (no `data-id`/`data-source` → `invalid source` read).
  for (const card of gridEl.querySelectorAll('.skill-card[data-id]')) {
    const id = card.dataset.id;
    const source = card.dataset.source;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-skill-use]')) {
        e.stopPropagation();
        if (!card.classList.contains('is-disabled')) {
          const skill = _skillsCache?.find(s => s.id === id && s.source === source);
          useSkill(id, skill?.name || id);
        }
        return;
      }
      if (e.target.closest('[data-skill-more]')) {
        e.stopPropagation();
        _openSkillRowMenu(e.target.closest('[data-skill-more]'), id, source);
        return;
      }
      _showSkillsDetailView(source, id);
    });
  }
}

function _externalPackageRows(openRows) {
  const byName = new Map();
  for (const p of (_packagesCache || [])) {
    if (!p || !p.name) continue;
    byName.set(String(p.name), {
      ...p,
      display_name: String(p.display_name || p.name),
      enabled: p.enabled !== false,
      bin_names: Array.isArray(p.bin_names) ? p.bin_names : [],
    });
  }
  const fallbackCounts = new Map();
  for (const s of (openRows || [])) {
    if (!s || s.source !== 'external' || !s.package_name) continue;
    const packageName = String(s.package_name);
    fallbackCounts.set(packageName, (fallbackCounts.get(packageName) || 0) + 1);
    if (!byName.has(packageName)) {
      byName.set(packageName, {
        name: packageName,
        display_name: packageName,
        kind: s.package_kind || 'skill',
        enabled: s.package_enabled !== false,
        skill_count: 0,
        bin_names: [],
      });
    }
  }
  for (const [name, count] of fallbackCounts.entries()) {
    const row = byName.get(name);
    if (row && !row.skill_count) row.skill_count = count;
  }
  return Array.from(byName.values());
}

function _globalSkillNamespace(row) {
  const id = String(row && row.id || '').trim().toLowerCase();
  if (!id) return '';
  const m = /^([a-z0-9]+)-[a-z0-9]/.exec(id);
  return m ? m[1] : id;
}

function _globalSkillGroupLabel(key) {
  return key || t('skills.global_group');
}

function _globalSkillGroupRows(key) {
  return (_openSkillsCache || []).filter((row) => (
    row
    && row.source === 'global'
    && _globalSkillNamespace(row) === key
  ));
}

function _globalSkillGroupSummary(group) {
  const rows = Array.isArray(group?.rows) ? group.rows : [];
  const names = rows
    .map((row) => String(row?.name || row?.id || '').trim())
    .filter(Boolean)
    .sort((a, b) => _skillNameSortKey({ name: a }).localeCompare(_skillNameSortKey({ name: b })));
  const lang = String(typeof getLang === 'function' ? getLang() : '').toLowerCase();
  const cjk = lang.startsWith('zh') || lang.startsWith('ja');
  const countLabel = t('settings.packages.skills_count', { count: rows.length });
  const separator = cjk ? '、' : ', ';
  const colon = cjk ? '：' : ': ';
  return names.length ? `${countLabel}${colon}${names.join(separator)}` : countLabel;
}

function _groupGlobalSkills(rows) {
  const buckets = new Map();
  for (const row of (rows || [])) {
    const key = _globalSkillNamespace(row);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const entries = [];
  const groupedKeys = new Set();
  for (const [key, list] of buckets) {
    if (list.length >= _GLOBAL_SKILL_GROUP_MIN) {
      groupedKeys.add(key);
      entries.push({ kind: 'group', key, rows: list });
    }
  }
  for (const row of (rows || [])) {
    if (!groupedKeys.has(_globalSkillNamespace(row))) entries.push({ kind: 'skill', row });
  }
  entries.sort((a, b) => {
    const an = a.kind === 'group' ? _globalSkillGroupLabel(a.key) : (a.row.name || a.row.id || '');
    const bn = b.kind === 'group' ? _globalSkillGroupLabel(b.key) : (b.row.name || b.row.id || '');
    return _skillNameSortKey({ name: an }).localeCompare(_skillNameSortKey({ name: bn }));
  });
  return entries;
}

/** Read-only section for open-tier entries. External packages are package
 *  cards. Global folders auto-aggregate skills by the prefix before the first
 *  dash (`lark-*` → `lark`) so machine-shared roots don't become a wall of
 *  one-card-per-recipe rows. Management lives in per-card menus. Returns ''
 *  when none. */
function _openSkillsSectionHtml() {
  const rows = _openSkillsCache || [];
  const externalPackageRows = _externalPackageRows(rows);
  const globalSkillRows = rows.filter((s) => s.source === 'global');
  if (!externalPackageRows.length && !globalSkillRows.length) return '';
  const card = (s) => {
    // Same desc treatment as trusted/platform cards (flex:1, 3-line clamp,
    // empty placeholder) so open-tier cards match them in size and pin the
    // play button to the bottom regardless of description length.
    const descText = String(s.description || '').trim();
    const desc = `<div class="skill-card-desc${descText ? '' : ' is-empty'}">${escapeHtml(descText || t('skills.no_desc'))}</div>`;
    const packageName = s.source === 'external' ? String(s.package_name || '') : '';
    const displayName = String(s.name || s.id || '');
    const kindLabel = packageName ? _packageKindLabel(s.package_kind) : '';
    const packageMetaBits = [];
    if (packageName && packageName !== displayName) packageMetaBits.push(packageName);
    if (kindLabel) packageMetaBits.push(kindLabel);
    const packageMeta = packageMetaBits.length
      ? `<div class="skill-card-meta">${escapeHtml(packageMetaBits.join(' · '))}</div>`
      : '';
    const moreTitle = escapeHtml(t('skills.more_actions'));
    const useTitle = escapeHtml(t('skills.use_tooltip'));
    const enabled = s.enabled !== false;
    const moreAttr = packageName ? 'data-open-more data-open-package-more' : 'data-open-more';
    const moreBtn = `<button type="button" class="skill-card-more" ${moreAttr} title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const packageAttr = packageName ? ` data-open-package-name="${escapeHtml(packageName)}"` : '';
    const sourceAttr = ` data-open-source="${escapeHtml(s.source || '')}"`;
    // "Use" selects the skill in the Commander composer. Disabled when the
    // skill is turned off, mirroring trusted cards.
    const useBtn = `<button type="button" class="skill-card-use" data-open-use title="${useTitle}" aria-label="${useTitle}" ${enabled ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>${escapeHtml(t('skills.use'))}</button>`;
    return `
      <div class="skill-card is-readonly${enabled ? '' : ' is-disabled'}" data-open-id="${escapeHtml(s.id)}"${sourceAttr}${packageAttr}>
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(displayName)}</span>
          ${moreBtn}
        </div>
        ${packageMeta}
        ${desc}
        <div class="skill-card-actions">
          ${useBtn}
        </div>
      </div>`;
  };
  const packageCard = (p) => {
    const packageName = String(p.name || '');
    const packageDisplayName = String(p.display_name || packageName);
    const kindLabel = _packageKindLabel(p.kind);
    const metaBits = [];
    if (kindLabel) metaBits.push(kindLabel);
    if (p.skill_count) metaBits.push(t('settings.packages.skills_count', { count: p.skill_count }));
    if (p.bin_names && p.bin_names.length) metaBits.push(p.bin_names.map((b) => `\`${b}\``).join(' '));
    const meta = metaBits.length
      ? `<div class="skill-card-meta">${escapeHtml(metaBits.join(' · '))}</div>`
      : '';
    const moreTitle = escapeHtml(t('skills.more_actions'));
    return `
      <div class="skill-card is-readonly${p.enabled ? '' : ' is-disabled'}" data-open-package-card="1" data-open-package-name="${escapeHtml(packageName)}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(packageDisplayName)}</span>
          <button type="button" class="skill-card-more" data-open-package-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
        </div>
        ${meta}
      </div>`;
  };
  const globalGroupCard = (group) => {
    const name = _globalSkillGroupLabel(group.key);
    const expanded = _expandedGlobalSkillGroups.has(group.key);
    const enabled = (group.rows || []).some((row) => row.enabled !== false);
    const label = expanded ? t('skills.global_group_collapse') : t('skills.global_group_expand');
    const icon = _skillUiIconHtml(expanded ? 'chevron-down' : 'chevron-right', 'skill-card-disclosure-icon');
    const moreTitle = escapeHtml(t('skills.more_actions'));
    const summary = _globalSkillGroupSummary(group);
    return `
      <div class="skill-card is-readonly${enabled ? '' : ' is-disabled'} skill-card--global-group" data-global-skill-group="${escapeHtml(group.key)}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(name)}</span>
          <button type="button" class="skill-card-more" data-global-skill-group-more="${escapeHtml(group.key)}" title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
        </div>
        <div class="skill-card-desc skill-card-desc--global-summary">${escapeHtml(summary)}</div>
        <div class="skill-card-actions">
          <button type="button" class="skill-card-disclosure" data-global-skill-group-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${icon}
            <span>${escapeHtml(label)}</span>
          </button>
        </div>
      </div>`;
  };
  // Split external packages and global folders into their own sections so
  // user-installed packages read distinctly from machine-global skill dirs
  // (both are open-tier, but they have different provenance/management). A
  // short hint next to each title explains the provenance to the user.
  const globalSection = (list) => {
    if (!list.length) return '';
    const hint = t('skills.global_group_hint');
    const hintHtml = hint ? `<span class="skills-source-section-hint">${escapeHtml(hint)}</span>` : '';
    const grouped = _groupGlobalSkills(list);
    const tiles = [];
    for (const item of grouped) {
      if (item.kind === 'skill') {
        tiles.push(card(item.row));
        continue;
      }
      tiles.push(globalGroupCard(item));
      if (_expandedGlobalSkillGroups.has(item.key)) {
        for (const row of item.rows) tiles.push(card(row));
      }
    }
    return `
    <section class="skills-source-section skills-source-section--global">
      <div class="skills-source-section-head">
        <span>${escapeHtml(t('skills.global_group'))}</span>
        <span class="skills-source-section-count">${list.length}</span>
        ${hintHtml}
      </div>
      <div class="skills-source-section-grid">${tiles.join('')}</div>
    </section>`;
  };
  const externalHtml = externalPackageRows.length
    ? `
    <section class="skills-source-section">
      <div class="skills-source-section-head">
        <span>${escapeHtml(t('skills.external_group'))}</span>
        <span class="skills-source-section-count">${externalPackageRows.length}</span>
        <span class="skills-source-section-hint">${escapeHtml(t('skills.external_group_hint'))}</span>
      </div>
      <div class="skills-source-section-grid">${externalPackageRows.map(packageCard).join('')}</div>
    </section>`
    : '';
  return externalHtml
    + globalSection(globalSkillRows);
}

function _wireOpenSkillCards(gridEl) {
  for (const btn of gridEl.querySelectorAll('[data-global-skill-group-toggle]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.globalSkillGroupToggle || '';
      if (!key) return;
      if (_expandedGlobalSkillGroups.has(key)) _expandedGlobalSkillGroups.delete(key);
      else _expandedGlobalSkillGroups.add(key);
      renderSkillsList(_skillsCache || []);
    });
  }
  for (const btn of gridEl.querySelectorAll('[data-global-skill-group-more]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.globalSkillGroupMore || '';
      if (key) _openGlobalSkillGroupMenu(btn, key);
    });
  }
  for (const card of gridEl.querySelectorAll('.skill-card[data-open-id], .skill-card[data-open-package-card]')) {
    const id = card.dataset.openId;
    const source = card.dataset.openSource || '';
    const useBtn = card.querySelector('[data-open-use]');
    if (useBtn) {
      useBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (card.classList.contains('is-disabled')) return;
        const packageName = card.dataset.openPackageName || '';
        const row = _openSkillsCache.find((s) => (
          s.id === id
          && (s.source || '') === source
          && (source !== 'external' || String(s.package_name || '') === packageName)
        ));
        useSkill(id, (row && row.name) || id);
      });
    }
    const menuBtn = card.querySelector('[data-open-more]');
    const packageOnlyMenuBtn = card.querySelector('[data-open-package-more]');
    if (packageOnlyMenuBtn && card.dataset.openPackageCard === '1') {
      packageOnlyMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const packageName = card.dataset.openPackageName || '';
        const pkg = (_packagesCache || []).find((p) => String(p.name || '') === packageName);
        if (pkg) {
          const packageDisplayName = String(pkg.display_name || packageName);
          _openExternalPackageMenu(packageOnlyMenuBtn, {
            id: packageName,
            package_name: packageName,
            package_display_name: packageDisplayName,
            package_kind: pkg.kind,
            package_enabled: pkg.enabled !== false,
            enabled: pkg.enabled !== false,
          });
        }
      });
    } else if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (source === 'external') {
          const packageName = card.dataset.openPackageName || '';
          const row = _openSkillsCache.find((s) => (
            s.id === id
            && s.source === 'external'
            && String(s.package_name || '') === packageName
          ));
          if (row) _openExternalPackageMenu(menuBtn, row);
          return;
        }
        if (source === 'global') _openSkillRowMenu(menuBtn, id, source);
      });
    }
  }
}

async function _setOpenSkillEnabled(id, nextEnabled) {
  try {
    const res = await window.orkas.invoke('skills.setEnabled', { id, enabled: nextEnabled });
    if (!res || !res.ok) { await uiAlert(t('component.toggle_failed')); return false; }
    // enable/disable is keyed by id; the same skill can appear under both
    // external and global, so flip every matching row's optimistic state.
    for (const r of _openSkillsCache) if (r.id === id) r.enabled = nextEnabled;
    renderSkillsList(_skillsCache || []);
    return true;
  } catch {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

async function _setGlobalSkillGroupEnabled(key, nextEnabled) {
  const rows = _globalSkillGroupRows(key);
  const targetIds = new Set(rows
    .filter((row) => (row.enabled !== false) !== nextEnabled)
    .map((row) => row.id));
  if (!targetIds.size) return true;
  try {
    const results = await Promise.allSettled(Array.from(targetIds).map((id) => (
      window.orkas.invoke('skills.setEnabled', { id, enabled: nextEnabled })
    )));
    if (results.some((res) => res.status === 'rejected' || !res.value || !res.value.ok)) {
      await loadSkills(true);
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    for (const row of (_openSkillsCache || [])) {
      if (targetIds.has(row.id)) row.enabled = nextEnabled;
    }
    renderSkillsList(_skillsCache || []);
    return true;
  } catch {
    await loadSkills(true);
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

function _packageKindLabel(kind) {
  if (kind === 'skill' || kind === 'cli' || kind === 'both') {
    const label = t(`settings.packages.kind_${kind}`);
    return label && label !== `settings.packages.kind_${kind}` ? label : kind;
  }
  return '';
}

function _packageActionBusyLabel(command) {
  if (command === 'update') return t('settings.packages.updating');
  if (command === 'enable') return t('settings.packages.enabling');
  if (command === 'disable') return t('settings.packages.disabling');
  if (command === 'remove') return t('settings.packages.removing');
  return t('common.loading');
}

// Per-card busy overlay shown while an external-package action (update /
// enable / disable / remove) runs — these spawn orkas-pkg.cjs (git pull +
// optional dep install) and can take several seconds. Without it the card
// sits inert with no feedback. Cleared by the post-action re-render on
// success, or in `_runOpenPackageAction`'s finally on the error path.
function _setSkillCardBusy(card, command) {
  if (!card) return;
  card.classList.add('is-busy');
  card.setAttribute('aria-busy', 'true');
  if (card.querySelector('.skill-card-busy')) return;
  const overlay = document.createElement('div');
  overlay.className = 'skill-card-busy';
  overlay.innerHTML = `<span class="skill-card-busy-spinner" aria-hidden="true"></span>`
    + `<span class="skill-card-busy-label">${escapeHtml(_packageActionBusyLabel(command))}</span>`;
  card.appendChild(overlay);
}

function _clearSkillCardBusy(card) {
  if (!card) return;
  card.classList.remove('is-busy');
  card.removeAttribute('aria-busy');
  card.querySelector('.skill-card-busy')?.remove();
}

function _openExternalPackageMenu(anchorBtn, row) {
  const packageName = String(row?.package_name || '');
  if (!packageName) return;
  const packageDisplayName = String(row?.package_display_name || packageName);
  const card = anchorBtn.closest('.skill-card');
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.packageName === packageName
    && menu.dataset.openSkillId === row.id
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.packageName = packageName;
  menu.dataset.openSkillId = row.id;
  menu.dataset.source = 'external';
  const packageEnabled = row.package_enabled !== false;
  const toggleLabel = packageEnabled ? t('component.disable') : t('component.enable');
  menu.innerHTML = [
    `<div class="skill-row-menu-item" data-action="update-package">${escapeHtml(t('settings.packages.update'))}</div>`,
    `<div class="skill-row-menu-item" data-action="toggle-package">${escapeHtml(toggleLabel)}</div>`,
    `<div class="skill-row-menu-item is-danger" data-action="remove-package">${escapeHtml(t('settings.packages.remove'))}</div>`,
  ].join('');
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'update-package') {
        await _runOpenPackageAction('update', packageName, card, packageDisplayName);
      } else if (action === 'toggle-package') {
        await _runOpenPackageAction(packageEnabled ? 'disable' : 'enable', packageName, card, packageDisplayName);
      } else if (action === 'remove-package') {
        const ok = await uiConfirmDanger({
          title: t('settings.packages.remove_title', { name: packageDisplayName }),
          message: t('settings.packages.remove_msg'),
          dangerLabel: t('settings.packages.remove'),
        });
        if (ok) await _runOpenPackageAction('remove', packageName, card, packageDisplayName);
      }
    });
  }
}

function _openGlobalSkillGroupMenu(anchorBtn, key) {
  const rows = _globalSkillGroupRows(key);
  if (!rows.length) return;
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.globalSkillGroup === key
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.globalSkillGroup = key;
  menu.dataset.source = 'global-group';
  const enabled = rows.some((row) => row.enabled !== false);
  const toggleLabel = enabled ? t('component.disable') : t('component.enable');
  menu.innerHTML = `<div class="skill-row-menu-item" data-action="toggle-global-group">${escapeHtml(toggleLabel)}</div>`;
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'toggle-global-group') {
        await _setGlobalSkillGroupEnabled(key, !enabled);
      }
    });
  }
}

async function _runOpenPackageAction(command, packageName, cardEl, packageDisplayName) {
  const card = cardEl && cardEl.isConnected ? cardEl : null;
  const displayName = String(packageDisplayName || packageName);
  if (card) _setSkillCardBusy(card, command);
  const startedAt = Date.now();
  if (window.Monitor) (() => {})('package_action', { surface: 'skills', command });
  try {
    const res = await window.orkas.invoke('packages.action', { command, name: packageName });
    if (!res || res.ok === false) {
      const errorMessage = (res && res.error) || t('settings.packages.action_failed');
      if (window.Monitor) {
        (() => {})('package_action_result', {
          surface: 'skills',
          command,
          result: 'failure',
          duration_ms: Date.now() - startedAt,
        });
        (() => {})('package_action', {
          surface: 'skills',
          command,
          error_type: 'runtime',
          error_message: errorMessage,
        });
      }
      await uiAlert((res && res.error) || t('settings.packages.action_failed'));
      return;
    }
    if (window.Monitor) {
      (() => {})('package_action_result', {
        surface: 'skills',
        command,
        result: 'success',
        duration_ms: Date.now() - startedAt,
      });
    }
    if (command === 'update' && typeof uiToast === 'function') {
      uiToast(t('settings.packages.updated', { name: displayName }), { variant: 'success' });
    }
    await loadSkills(true);
  } catch (err) {
    if (window.Monitor) {
      (() => {})('package_action_result', {
        surface: 'skills',
        command,
        result: 'failure',
        duration_ms: Date.now() - startedAt,
      });
      (() => {})('package_action', {
        surface: 'skills',
        command,
        error_type: 'ipc',
        error_message: (err && err.message) || String(err || 'unknown'),
      });
    }
    _skillsLog.warn('package action failed', err);
    await uiAlert(t('settings.packages.action_failed'));
  } finally {
    // Success re-renders the grid (card replaced), so this only fires on the
    // failure path where the original card is still mounted.
    if (card && card.isConnected) _clearSkillCardBusy(card);
  }
}

async function _flipOpenSkillEnabled(id) {
  const row = (_openSkillsCache || []).find((s) => s.id === id);
  return _setOpenSkillEnabled(id, !(row && row.enabled));
}

/** Flip a skill's enabled override (used by both the ⋯ menu's toggle item
 *  and the detail-page enable/disable button). On failure, alerts and does
 *  not mutate UI state; on success, refreshes the grid + detail page. */
async function _flipSkillEnabled(skillId, nextEnabled) {
  try {
    const res = await window.orkas.invoke('skills.setEnabled', { id: skillId, enabled: nextEnabled });
    if (!res || !res.ok) {
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    const cached = _skillsCache?.find((s) => s.id === skillId);
    if (cached) cached.enabled = nextEnabled;
    await loadSkills();
    if (_selectedSkill?.id === skillId) {
      _renderSkillEnabledButton({ id: skillId, enabled: nextEnabled });
    }
    return true;
  } catch (err) {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

// ─── View switching: grid ↔ detail ─────────────────────────────────────

// Back from the skill detail/edit view. An unconfirmed URL-import draft (a
// placeholder that was never authored — set in `_saveSkillFromUrl`, cleared
// once real content is written or the user clicks Done) prompts before
// leaving: the user explicitly chooses to discard the half-finished import or
// keep working. Authored/committed skills and ordinary edits just leave.
async function _onSkillsBack() {
  if (_importDraftId) {
    const discard = await uiConfirm({
      message: t('skills.import.back_confirm'),
      okLabel: t('skills.import.back_discard'),
      cancelLabel: t('skills.import.back_continue'),
    });
    if (!discard) return; // "keep editing" — stay in the edit chat
    const draftId = _importDraftId;
    _importDraftId = null;
    try {
      const r = await window.orkas.invoke('skills.discardImportDraft', { id: draftId });
      if (r && r.discarded) { _skillsCache = null; await loadSkills(); }
    } catch (_) { /* best effort — a leftover empty draft is non-fatal */ }
  }
  _showSkillsGridView();
}

function _showSkillsGridView() {
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  // Exit edit mode if active so chat panel is hidden too.
  if (_skillEditMode) {
    // Abort any in-flight reply (same reason as toggleSkillEditMode exit
    // branch — singleton controller, leaving pending leaks streaming UI).
    try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    _skillEditMode = false;
    _skillEditSkillId = null;
    const chatCol = document.getElementById('skills-chat-col');
    if (chatCol) chatCol.style.display = 'none';
    _updateEditButtonLabel();
  }
  if (grid) grid.style.display = 'flex';
  if (detail) detail.style.display = 'none';
  // Collapse source tree so next detail open starts clean.
  const panel = document.getElementById('skills-source-panel');
  const toggle = document.getElementById('skills-source-toggle');
  if (panel) panel.style.display = 'none';
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  // Drop any pinned body min-height from the previous session.
  const body = document.getElementById('skills-detail-body');
  if (body) body.style.minHeight = '';
  _selectedSkill = null;
  _closeSkillRowMenu();
}

async function _showSkillsDetailView(source, id, opts = {}) {
  source = _skillSource(source);
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  await loadSkills(true);
  _dropSkillTreeCache(source, id);
  // Reset scroll only on initial detail entry — file switching inside the
  // tree (handled by selectSkillFile) preserves position.
  const detailContent = document.getElementById('skills-detail-content');
  if (detailContent) detailContent.scrollTop = 0;
  // Clear stale body min-height pin from a previous detail session so the
  // body can shrink/grow naturally for the fresh skill.
  const body = document.getElementById('skills-detail-body');
  if (body) body.style.minHeight = '';
  await selectSkillFile(source, id, 'SKILL.md', null);
  // Every fresh detail entry starts with source visible; the toggle's
  // collapsed state is local to the current view and is not remembered.
  if (opts.expandSource !== false) await _ensureSkillsSourceExpanded();
}

// Switch the detail pane to the "installed as an external package" state.
// A URL import can resolve to a verbatim package (in the per-user packages
// tree) rather than an editable skill; main already removed the placeholder
// skill, so there is no skill content to render. Point the user to package
// management instead.
function _showSkillAsPackageState(name) {
  _skillEditMode = false;
  _skillEditSkillId = null;
  _selectedSkill = null;
  _skillsCache = null;
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  const detailCol = document.getElementById('skills-detail-col');
  if (detailCol) detailCol.style.display = 'none';
  const chatCol = document.getElementById('skills-chat-col');
  if (chatCol) chatCol.style.display = 'none';
  const panel = document.getElementById('skills-as-package');
  if (panel) panel.style.display = '';
  const nameEl = document.getElementById('skills-as-package-name');
  if (nameEl) nameEl.textContent = name || t('skills.as_package.title');
  const descEl = document.getElementById('skills-as-package-desc');
  if (descEl) descEl.textContent = t('skills.as_package.desc');
  const manageBtn = document.getElementById('skills-as-package-manage');
  if (manageBtn) manageBtn.onclick = () => {
    _showSkillsGridView();
    Promise.resolve(loadSkills(true)).finally(() => {
      _scrollPackageCardIntoView(name);
    });
  };
  const backBtn = document.getElementById('skills-as-package-back');
  if (backBtn) backBtn.onclick = () => _onSkillsBack();
  // Placeholder skill is gone and a package may now contribute skills —
  // refresh the grid in the background so a later "Back" shows fresh state.
  Promise.resolve().then(() => loadSkills()).catch(() => {});
}

function _scrollPackageCardIntoView(packageName) {
  const wanted = String(packageName || '');
  const cards = document.querySelectorAll('.skill-card[data-open-package-name]');
  for (const card of cards) {
    if (String(card.dataset.openPackageName || '') !== wanted) continue;
    card.scrollIntoView({ block: 'center' });
    card.classList.add('is-menu-open');
    setTimeout(() => card.classList.remove('is-menu-open'), 1200);
    return;
  }
  document.querySelector('.skills-source-section')?.scrollIntoView({ block: 'start' });
}

function _dropSkillTreeCache(source, id) {
  const key = `${_skillSource(source)}:${id}`;
  _skillTreeCache.delete(key);
}

async function refreshSelectedSkillDetail() {
  if (_skillEditMode || !_selectedSkill?.id || !_selectedSkill?.source) return;
  const detail = document.getElementById('skills-detail-view');
  if (!detail || detail.style.display === 'none') return;
  const source = _selectedSkill.source;
  const id = _selectedSkill.id;
  const filepath = _selectedSkill.filepath || 'SKILL.md';
  _dropSkillTreeCache(source, id);
  await selectSkillFile(source, id, filepath, null);
  const toggle = document.getElementById('skills-source-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'true') {
    await _ensureSkillsSourceExpanded();
  }
}

async function _ensureSkillsSourceExpanded() {
  const toggle = document.getElementById('skills-source-toggle');
  const panel = document.getElementById('skills-source-panel');
  const treeEl = document.getElementById('skills-source-tree');
  if (!toggle || !panel || !treeEl || !_selectedSkill) return;
  panel.style.display = '';
  toggle.setAttribute('aria-expanded', 'true');
  treeEl.innerHTML = `<div style="color:#94a3b8;padding:8px 12px">${escapeHtml(t('skills.loading'))}</div>`;
  await expandSkillTree(_selectedSkill.source, _selectedSkill.id, treeEl);
  _markActiveSkillFileInTree(_selectedSkill.filepath || 'SKILL.md');
}

// Highlight whichever file row in the source tree corresponds to the file
// currently rendered in the body — initial load points at SKILL.md, later
// changes track user clicks via `selectSkillFile`'s nodeEl path.
function _markActiveSkillFileInTree(filepath) {
  const treeEl = document.getElementById('skills-source-tree');
  if (!treeEl) return;
  treeEl.querySelectorAll('.skill-tree-node').forEach(n => n.classList.remove('active'));
  // Use attribute selector with quoted value — file paths can contain `.`,
  // `/` etc. that confuse class-based selectors.
  const safe = String(filepath).replace(/(["\\])/g, '\\$1');
  const target = treeEl.querySelector(`.skill-tree-file[data-path="${safe}"]`);
  if (target) target.classList.add('active');
}

// ─── Per-card ⋯ popover menu (custom / platform / open-tier) ──────────

function _openSkillRowMenu(anchorBtn, id, source) {
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.skillId === id
    && menu.dataset.source === source
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.skillId = id;
  menu.dataset.source = source;
  // Edit/delete are gated: custom always allowed; built-in only in dev mode.
  // Enable/disable is always shown (lives in this menu now since cards no
  // longer carry a toggle).
  // Open-tier (external package / global folder): package/filesystem managed —
  // enable/disable only, no edit/delete/upload. Its rows live in a separate
  // cache.
  const isOpenTier = source === 'external' || source === 'global';
  const cached = isOpenTier
    ? (_openSkillsCache || []).find((s) => s.id === id)
    : _skillsCache?.find((s) => s.id === id && s.source === source);
  const enabled = cached ? cached.enabled !== false : true;
  const canEdit = !isOpenTier && (source === 'custom' || (_isSkillPlatformSource(source) && false));
  // Dev-only entry on marketplace items: tag the label so the user knows this isn't a
  // normal user capability (mirrors marketplace.upload's "(dev)" treatment).
  const editLabelSuffix = (_isSkillPlatformSource(source) && false) ? t('common.dev_suffix') : '';
  const items = [];
  if (canEdit) {
    items.push(`<div class="skill-row-menu-item" data-action="edit">${escapeHtml(t('skills.edit') + editLabelSuffix)}</div>`);
  }
  items.push(
    `<div class="skill-row-menu-item" data-action="toggle-enabled">${escapeHtml(enabled ? t('component.disable') : t('component.enable'))}</div>`,
  );
  if (canEdit) {
    items.push(`<div class="skill-row-menu-item is-danger" data-action="delete">${escapeHtml(t('skills.delete'))}</div>`);
  }
  menu.innerHTML = items.join('');
  // While menu open, force the source card's ⋯ visible.
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'edit') {
        await _showSkillsDetailView(source, id);
        if (_selectedSkill && _selectedSkill.id === id && _selectedSkill.source === source) {
          await toggleSkillEditMode();
        }
      } else if (action === 'delete') {
        // Mimic the existing delete flow (from detail page) but for any card.
        _selectedSkill = { source, id, filepath: 'SKILL.md', name: '' };
        await deleteSelectedSkill();
      } else if (action === 'toggle-enabled') {
        if (isOpenTier) {
          await _flipOpenSkillEnabled(id);
        } else {
          const cur = _skillsCache?.find((s) => s.id === id && s.source === source);
          const nextEnabled = !(cur ? cur.enabled !== false : true);
          await _flipSkillEnabled(id, nextEnabled);
        }
      }
    });
  }
}

function _closeSkillRowMenu() {
  const menu = document.getElementById('skill-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.skillId;
    delete menu.dataset.openSkillId;
    delete menu.dataset.packageName;
    delete menu.dataset.globalSkillGroup;
    delete menu.dataset.source;
  }
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
}

function _positionSkillRowMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

// ─── "View source" collapsible (detail page bottom) ─────────────────

async function _toggleSkillsSource() {
  const toggle = document.getElementById('skills-source-toggle');
  const panel = document.getElementById('skills-source-panel');
  if (!toggle || !panel || !_selectedSkill) return;
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    panel.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }
  await _ensureSkillsSourceExpanded();
}

async function expandSkillTree(source, id, childrenEl) {
  source = _skillSource(source);
  const key = `${source}:${id}`;
  let tree = _skillTreeCache.get(key);
  if (!tree) {
    try {
      const res = await apiFetch(`/api/skills/tree?source=${source}&id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.ok) return;
      tree = data.tree || [];
      _skillTreeCache.set(key, tree);
    } catch (e) {
      _skillsLog.error('skill tree failed', e);
      return;
    }
  }
  childrenEl.innerHTML = renderTreeNodes(tree, source, id, 1);
  bindTreeNodes(childrenEl, source, id);
}

// Tree icons are centralized in modules/icons.js; classes here only control sizing/color.
const ICON_FOLDER_CLOSED = _skillUiIconHtml('folder', 'skill-tree-node-svg');
const ICON_FOLDER_OPEN = _skillUiIconHtml('folder-open', 'skill-tree-node-svg');
const ICON_FILE = _skillUiIconHtml('file', 'skill-tree-node-svg');

function fileIconSvg(ext) {
  // Generic file icon; color is differentiated via data-ext
  return ICON_FILE;
}

function _setDirIcon(nodeEl, open) {
  const caret = nodeEl.querySelector('.skill-tree-caret');
  if (caret) {
    caret.classList.toggle('collapsed', !open);
  }
  const icon = nodeEl.querySelector('.skill-tree-icon');
  if (icon) icon.innerHTML = open ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED;
}

function renderTreeNodes(nodes, source, id, depth) {
  const indent = depth * 18;
  return nodes.map(n => {
    if (n.type === 'dir') {
      const childrenHtml = `<div class="skill-tree-children" data-dir-path="${escapeHtml(n.path)}" style="display:none"></div>`;
      return `
        <div class="skill-tree-node skill-tree-dir" data-type="dir" data-path="${escapeHtml(n.path)}" style="padding-left:${indent}px">
          <span class="skill-tree-caret collapsed"></span>
          <span class="skill-tree-icon icon-folder">${ICON_FOLDER_CLOSED}</span>
          <span class="skill-tree-label">${escapeHtml(n.name)}</span>
        </div>
        ${childrenHtml}
      `;
    }
    return `
      <div class="skill-tree-node skill-tree-file" data-type="file" data-path="${escapeHtml(n.path)}" data-ext="${n.ext || ''}" style="padding-left:${indent}px">
        <span class="skill-tree-caret skill-tree-caret-empty"></span>
        <span class="skill-tree-icon icon-file" data-ext="${n.ext || ''}">${fileIconSvg(n.ext)}</span>
        <span class="skill-tree-label">${escapeHtml(n.name)}</span>
      </div>
    `;
  }).join('');
}

function bindTreeNodes(containerEl, source, id) {
  // File nodes
  containerEl.querySelectorAll(':scope > .skill-tree-file').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSkillFile(source, id, el.dataset.path, el);
    });
  });
  // Directory nodes (direct children)
  const dirs = containerEl.querySelectorAll(':scope > .skill-tree-dir');
  dirs.forEach(dirEl => {
    const dirPath = dirEl.dataset.path;
    const childrenEl = dirEl.nextElementSibling;
    if (!childrenEl || !childrenEl.classList.contains('skill-tree-children')) return;
    dirEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = `${source}:${id}/${dirPath}`;
      const isExpanded = _expandedDirs.has(key);
      if (isExpanded) {
        _expandedDirs.delete(key);
        childrenEl.style.display = 'none';
        _setDirIcon(dirEl, false);
      } else {
        _expandedDirs.add(key);
        const tree = _skillTreeCache.get(`${source}:${id}`);
        if (tree) {
          const dirNode = findDirInTree(tree, dirPath);
          if (dirNode && dirNode.children) {
            const depth = dirPath.split('/').length + 1;
            childrenEl.innerHTML = renderTreeNodes(dirNode.children, source, id, depth);
            bindTreeNodes(childrenEl, source, id);
          }
        }
        childrenEl.style.display = '';
        _setDirIcon(dirEl, true);
      }
    });
    if (_expandedDirs.has(`${source}:${id}/${dirPath}`)) {
      const tree = _skillTreeCache.get(`${source}:${id}`);
      if (tree) {
        const dirNode = findDirInTree(tree, dirPath);
        if (dirNode && dirNode.children) {
          const depth = dirPath.split('/').length + 1;
          childrenEl.innerHTML = renderTreeNodes(dirNode.children, source, id, depth);
          bindTreeNodes(childrenEl, source, id);
          childrenEl.style.display = '';
          _setDirIcon(dirEl, true);
        }
      }
    }
  });
}

function findDirInTree(tree, targetPath) {
  for (const n of tree) {
    if (n.type === 'dir' && n.path === targetPath) return n;
    if (n.type === 'dir' && n.children) {
      const found = findDirInTree(n.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

async function selectSkillFile(source, id, filepath, nodeEl) {
  source = _skillSource(source);
  const skill = _skillsCache?.find(s => s.id === id && s.source === source);
  // Detect "same-skill file switch" vs initial / cross-skill load — only the
  // former needs scroll preservation (user is mid-page browsing source files).
  // Capture this BEFORE _selectedSkill is overwritten.
  const sameSkill = _selectedSkill?.id === id && _selectedSkill?.source === source;
  _selectedSkill = { source, id, filepath, name: skill?.name || id };
  Promise.resolve().then(() => refreshSkillCognitionSummary(id)).catch(() => {});
  // Clear previous active state across all tree nodes (in source-wrap)
  document.querySelectorAll('.skill-tree-node').forEach(n => n.classList.remove('active'));
  if (nodeEl) nodeEl.classList.add('active');
  const content = document.getElementById('skills-detail-content');
  // Defer to CSS — was 'flex' from the old 3-column layout, which now
  // overrides `display: block` and forces sections into horizontal flex.
  if (content) content.style.display = '';
  // Leaving any external-package result state: restore the normal columns.
  const asPkgPanel = document.getElementById('skills-as-package');
  if (asPkgPanel) asPkgPanel.style.display = 'none';
  const detailCol = document.getElementById('skills-detail-col');
  if (detailCol) detailCol.style.display = '';

  const nameEl = document.getElementById('skills-detail-name');
  nameEl.textContent = skill?.name || id;
  nameEl.dataset.skillId = id;
  nameEl.dataset.source = source;
  // Name is editable ONLY in edit mode (req: "非编辑状态不能修改名称").
  // Editability is wired below alongside the description-section toggle —
  // both depend on `editingThis` which is computed a few lines down.
  nameEl.classList.remove('editable');
  nameEl.removeAttribute('title');

  // Header chips: custom = "自定义"; marketplace-installed = category only.
  // Same `_renderSourceMetaHtml` helper as the agent detail page (defined in agents.js,
  // shared via the renderer's flat top-level scope per CLAUDE.md §8).
  const sourceEl = document.getElementById('skills-detail-source');
  sourceEl.className = 'skills-doc-source-row';
  sourceEl.innerHTML = _renderSourceMetaHtml({
    source,
    version: skill?.version || '',
    category: skill?.category || '',
  });
  _renderSkillDetailCategory(skill, source);

  // Doc sections (description / external dependencies / dependent
  // skills / other attributes) — seed with the cached description so
  // the page isn't blank on first paint; refined once SKILL.md
  // frontmatter parses.
  const seedDesc = pickDesc(skill, getLang()).trim();
  _renderSkillSections(seedDesc ? [['description', seedDesc]] : []);

  // Actions bar: visible when a skill is selected.
  // Order: use (icon) / edit / enable-disable / delete.
  // In edit mode only the "done" button (the relabeled "edit") is
  // shown; everything else hides.
  const canEditThisSkill = source === 'custom' || (_isSkillPlatformSource(source) && false);
  const editingThis = _skillEditMode && _skillEditSkillId === id && canEditThisSkill;
  const actions = document.getElementById('skills-detail-actions');
  if (actions) {
    actions.classList.remove('is-hidden');
    const useBtn = document.getElementById('skill-use-btn');
    const editBtn = document.getElementById('skill-edit-btn');
    const enableBtn = document.getElementById('skill-enabled-btn');
    const uploadBtn = document.getElementById('skill-upload-marketplace-btn');
    const delBtn = document.getElementById('skill-delete-btn');
    if (useBtn) {
      useBtn.style.display = editingThis ? 'none' : '';
      useBtn.disabled = skill?.enabled === false;
      useBtn.setAttribute('aria-disabled', skill?.enabled === false ? 'true' : 'false');
    }
    if (editBtn) editBtn.style.display = canEditThisSkill ? '' : 'none';
    if (enableBtn) enableBtn.style.display = editingThis ? 'none' : '';
    // Marketplace publishing is not part of the open-source build.
    if (uploadBtn) uploadBtn.style.display = 'none';
    if (delBtn) delBtn.style.display = (canEditThisSkill && !editingThis) ? '' : 'none';
  }

  // Wire name editability and hide the
  // description section while editing (req #3: edit description by editing
  // the `description_*:` frontmatter in SKILL.md, not via a separate UI
  // block). In dev mode, marketplace skill names are display metadata only:
  // saving writes SKILL.md frontmatter without renaming the marketplace id dir.
  const nameEditable = editingThis && (source === 'custom' || (_isSkillPlatformSource(source) && false));
  _toggleSkillNameEditable(nameEl, nameEditable);
  const summarySection = document.getElementById('skills-section-summary');
  if (summarySection) summarySection.style.display = editingThis ? 'none' : '';

  // Refresh the per-skill enable/disable button label + click handler.
  _renderSkillEnabledButton({ id, enabled: skill?.enabled !== false });

  const body = document.getElementById('skills-detail-body');
  // Don't show a loading placeholder — it would collapse body height
  // before the new content arrives. Keep the previous content visible.
  // For same-skill file switches, pin body's min-height to its current
  // rendered height ONLY for the duration of the fetch + render so the
  // body doesn't visibly collapse while the network call is in flight.
  // The pin is cleared right after render so the body resettles to the
  // new file's natural height — otherwise switching from a long source
  // (e.g. SKILL.md) back to a short script leaves the body padded to
  // the previous height and a large blank area appears below the new
  // content. `_showSkillsGridView` / `_showSkillsDetailView` also reset
  // minHeight on grid return / skill switch as a defensive backstop.
  const detailContent = document.getElementById('skills-detail-content');
  const savedScroll = detailContent ? detailContent.scrollTop : 0;
  if (sameSkill) {
    const oldBodyHeight = body.offsetHeight || 0;
    if (oldBodyHeight) body.style.minHeight = oldBodyHeight + 'px';
  }

  // Kick off the current-file read and (if we aren't already reading it) a
  // parallel SKILL.md read to populate header metadata. The extra fetch is
  // ~1 round-trip on a sub-KB file, and lets the header stay accurate when
  // the user is browsing `scripts/*.ts` inside a skill.
  const mainPromise = apiFetch(`/api/skills/read?source=${source}&id=${encodeURIComponent(id)}&file=${encodeURIComponent(filepath)}`)
    .then((r) => r.json());
  const skillMdPromise = filepath === 'SKILL.md'
    ? mainPromise
    : apiFetch(`/api/skills/read?source=${source}&id=${encodeURIComponent(id)}&file=SKILL.md`)
        .then((r) => r.json())
        .catch(() => null);

  // Render the doc sections as soon as SKILL.md comes back — don't block
  // on the main file body.
  skillMdPromise.then((md) => {
    // Guard: selection may have changed while we were awaiting.
    if (_selectedSkill?.id !== id || _selectedSkill?.source !== source) return;
    const content = md && md.ok ? (md.content || '') : '';
    const pairs = _parseSkillFrontmatterPairs(content);
    const fallbackDesc = pickDesc(skill, getLang()).trim();
    _renderSkillSections(pairs.length
      ? pairs
      : (fallbackDesc ? [['description', fallbackDesc]] : []));
  });

  try {
    const data = await mainPromise;
    if (data.ok) {
      const editable = _skillEditMode && _skillEditSkillId === id && canEditThisSkill;
      if (editable) _renderSkillFileEditor(body, data.content || '', data.ext);
      else _renderSkillFileView(body, data.content || '', data.ext);
    } else {
      body.innerHTML = `<span style="color:var(--danger)">${escapeHtml(data.error)}</span>`;
    }
  } catch (e) {
    body.innerHTML = `<span style="color:var(--danger)">${escapeHtml(t('skills.load_failed'))}</span>`;
  }
  // Release the loading-time minHeight pin so the body collapses to the
  // new file's natural height. Without this, switching from a long file
  // back to a short one leaves a blank area below the new content (the
  // pin was kept monotonically across same-skill file switches).
  if (sameSkill) body.style.minHeight = '';
  // Restore scroll defensively. innerHTML swaps + section re-renders can
  // shift scrollHeight before the new content settles; clamping pulls
  // scrollTop unexpectedly. Setting it back is cheap and idempotent — the
  // browser will clamp scrollTop to the new (possibly smaller) scrollHeight
  // when the new file is shorter, which is the right outcome now that the
  // body height honestly reflects the new content.
  if (detailContent) detailContent.scrollTop = savedScroll;

  // Chat column visibility is driven by edit-mode toggle.
  // Selecting a different skill resets edit mode off.
  const chatCol = document.getElementById('skills-chat-col');
  if (_skillEditMode && _skillEditSkillId === id && canEditThisSkill) {
    chatCol.style.display = 'flex';
  } else {
    // Switching skill mid-stream needs to abort, otherwise the singleton
    // controller's pending state bleeds into the next skill's edit panel
    // (the send button shows streaming for a fresh chat).
    if (_skillEditMode) {
      try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    }
    _skillEditMode = false;
    _skillEditSkillId = null;
    chatCol.style.display = 'none';
  }
  _updateEditButtonLabel();
}

// Parse SKILL.md YAML frontmatter into ordered [key, value] pairs.
// Mirrors the server-side parser in `core-agent/src/skills/frontmatter.ts`
// but also collects indented block values (`key:` followed by `  - item`
// or `  text`) so multi-line fields like `read_when:` render correctly.
function _normalizeSkillFrontmatterDisplayValue(value) {
  if (typeof normalizeDisplayText === 'function') return normalizeDisplayText(value);
  return String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\{2,}/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

function _parseSkillFrontmatterPairs(content) {
  if (!content) return [];
  const first = content.indexOf('\n');
  const head = (first >= 0 ? content.slice(0, first) : content).trim();
  if (head !== '---') return [];
  const lines = content.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close < 0) return [];

  const pairs = [];
  let i = 1;
  while (i < close) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    value = _normalizeSkillFrontmatterDisplayValue(value);
    if (!value) {
      // Collect indented continuation (block list or folded scalar).
      const block = [];
      while (i < close) {
        const next = lines[i];
        if (!next.trim() || /^\s+\S/.test(next)) {
          if (next.trim()) block.push(next.replace(/^\s+/, '').replace(/^-\s*/, ''));
          i++;
        } else break;
      }
      value = block.join('\n');
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function _renderSkillDetailCategory(skill, source) {
  const section = document.getElementById('skills-section-category');
  const slot = document.getElementById('skills-detail-category');
  if (section) section.style.display = 'none';
  if (slot) slot.innerHTML = '';
  const isCustom = source === 'custom';
  if (!isCustom) return;
  const sourceEl = document.getElementById('skills-detail-source');
  if (!sourceEl) return;
  const skillId = skill?.id || _selectedSkill?.id;
  _mountDetailCategorySelect(sourceEl, {
    value: skill?.category || 'general',
    onChange: async (category, api) => {
      try {
        const res = await window.orkas.invoke('skills.update', {
          id: skillId,
          updates: { category: category || 'general' },
          skipRename: true,
        });
        if (!res || res.ok === false || !res.skill) {
          api.setValue(skill?.category || 'general');
          uiAlert((res && res.error) || t('skills.save_failed'));
          return;
        }
        skill.category = res.skill.category || category || 'general';
        _skillsCache = null;
        await loadSkills(true);
        if (_selectedSkill?.id === skillId) {
          await selectSkillFile('custom', skillId, _selectedSkill.filepath || 'SKILL.md', null);
        }
      } catch (err) {
        api.setValue(skill?.category || 'general');
        uiAlert((err && err.message) || t('skills.save_failed'));
      }
    },
  }).catch((err) => _skillsLog.warn('render category select failed', err));
}

// Single source of truth for rendering frontmatter fields into the
// document. Splits known fields into their own dedicated sections (with
// labels) and tucks any unknown leftover keys under "other
// attributes". Hides any section whose content is empty (except the
// description, which always renders so the reader sees a placeholder
// when missing).
function _renderSkillSections(pairs) {
  const map = new Map();
  for (const [k, v] of (pairs || [])) {
    if (k && k !== 'name') map.set(k, v);
  }
  // — Description — pick by current UI language with cross-language fallback (so a
  // single-language skill still shows something instead of going blank).
  const summaryEl = document.getElementById('skills-detail-summary');
  if (summaryEl) {
    const desc = pickDesc({
      description_zh: map.get('description_zh'),
      description_en: map.get('description_en'),
    }, getLang()).trim() || (map.get('description') || '').trim();
    if (desc) {
      summaryEl.classList.remove('is-empty');
      summaryEl.textContent = desc;
    } else {
      summaryEl.classList.add('is-empty');
      summaryEl.textContent = _selectedSkill?.source === 'custom'
        ? t('skills.no_desc') : '';
    }
  }

  // — Other attributes —
  // Orkas skill frontmatter is intentionally tiny: name, bilingual
  // description, and category. Unknown/external metadata has no runtime
  // effect, so authoring writes strip it and the read-only view hides any
  // legacy leftovers instead of presenting them as meaningful properties.
  const extraSection = document.getElementById('skills-section-extra');
  const extraBody = document.getElementById('skills-detail-extra');
  if (extraSection && extraBody) {
    extraSection.style.display = 'none';
    extraBody.innerHTML = '';
  }
}

// Read-only view of a skill file. Markdown renders, other formats get a
// code block. Stores the raw content on the element so the editor variant
// can reset on "discard changes" without re-fetching.
function _renderSkillFileView(body, content, ext) {
  body.className = 'skills-detail-body';
  body.dataset.rawContent = content;
  if (ext === 'md') {
    body.classList.add('markdown-body');
    body.innerHTML = renderMarkdownFull(content);
  } else {
    body.innerHTML = `<pre class="code-view"><code>${escapeHtml(content)}</code></pre>`;
  }
}

// Editable textarea view with debounced auto-save. Shown when _skillEditMode
// is on for a custom skill. No explicit save button — edits flush to disk
// ~600ms after the user pauses typing. Target id/file are captured in the
// closure so a save in flight always targets the file it was scheduled for,
// even if the user navigates to another file meanwhile.
function _renderSkillFileEditor(body, content, _ext) {
  body.className = 'skills-detail-body skills-detail-editing';
  body.dataset.rawContent = content;
  body.innerHTML = `
    <div class="skill-file-toolbar">
      <span class="skill-file-status" data-role="status"></span>
    </div>
    <textarea class="skill-file-editor" spellcheck="false"></textarea>
  `;

  const ta = body.querySelector('.skill-file-editor');
  const statusEl = body.querySelector('[data-role="status"]');
  ta.value = content;

  const skillId = _selectedSkill?.id || '';
  const filepath = _selectedSkill?.filepath || 'SKILL.md';

  const setStatus = (text, kind = '') => {
    statusEl.textContent = text;
    statusEl.className = 'skill-file-status' + (kind ? ' is-' + kind : '');
  };

  let saveTimer = null;
  let saving = false;
  let queuedValue = null;

  const performSave = async (value) => {
    saving = true;
    setStatus(t('skills.saving'), 'saving');
    try {
      const res = await apiFetch('/api/skills/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skillId, file: filepath, content: value }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || t('skills.unknown_error'));
      body.dataset.rawContent = value;
      setStatus(t('skills.saved'), 'ok');
      // SKILL.md edits change name/description/frontmatter — refresh side list.
      if (filepath === 'SKILL.md') {
        _skillsCache = null;
        await loadSkills();
      }
    } catch (e) {
      setStatus(t('skills.save_failed_with', { reason: e.message || e }), 'err');
    } finally {
      saving = false;
      if (queuedValue !== null) {
        const next = queuedValue;
        queuedValue = null;
        performSave(next);
      }
    }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    setStatus(t('skills.editing'));
    saveTimer = setTimeout(() => {
      const value = ta.value;
      if (value === body.dataset.rawContent) { setStatus(''); return; }
      if (saving) { queuedValue = value; return; }
      performSave(value);
    }, 600);
  };

  ta.addEventListener('input', scheduleSave);
}

// ─── Skill name inline edit (mirrors agents.js's name editor) ───
//
// Replaces the older click-to-prompt rename path. The name field is now
// only editable inside Skill detail's edit mode (req: 非编辑状态不能修改名称).
// Wire-up:
//   - Enter edit  → contenteditable + bind input/blur (one-time per element)
//   - Type        → debounce 800ms → save SKILL.md frontmatter `name:`
//                   via `skipRename:true` (no dir rename mid-typing)
//   - Blur        → flush pending save
//   - Done click  → flush + validate; if invalid alert + revert DOM;
//                   if valid AND name actually changed, fire one final
//                   `skipRename:false` to commit the directory rename.

const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
function _isValidSkillNameCharset(name) {
  if (typeof name !== 'string' || name.length <= 0) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(name) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return SKILL_NAME_RE.test(name);
}

function _isEditablePlatformSkill(skill) {
  return !!skill && _isSkillPlatformSource(skill.source) && false;
}

function _canEditSelectedSkillName() {
  return !!_selectedSkill && (_selectedSkill.source === 'custom' || _isEditablePlatformSkill(_selectedSkill));
}

function _selectedSkillNameFallback() {
  if (!_selectedSkill) return '';
  return String(_selectedSkill.source === 'custom'
    ? _selectedSkill.id
    : (_selectedSkill.name || _selectedSkill.id || '')).trim();
}

function _isValidSkillDisplayName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(trimmed) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return true;
}

function _isValidSkillNameForSelected(name) {
  return _isEditablePlatformSkill(_selectedSkill)
    ? _isValidSkillDisplayName(name)
    : _isValidSkillNameCharset(name);
}

function _toggleSkillNameEditable(nameEl, on) {
  if (!nameEl) return;
  nameEl.setAttribute('contenteditable', on ? 'plaintext-only' : 'false');
  nameEl.classList.toggle('is-editing', !!on);
  if (on) _bindSkillNameSave(nameEl);
}

function _bindSkillNameSave(nameEl) {
  if (nameEl.dataset.bound === '1') return;
  nameEl.dataset.bound = '1';
  if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(nameEl);
  nameEl.addEventListener('input', () => _scheduleSkillFieldSave('name', nameEl.innerText));
  nameEl.addEventListener('blur', () => _flushSkillFieldSave());
}

let _pendingSkillField = null;
let _skillFieldSaveTimer = null;
function _scheduleSkillFieldSave(field, value) {
  if (!_canEditSelectedSkillName()) return;
  _pendingSkillField = { field, value };
  clearTimeout(_skillFieldSaveTimer);
  _skillFieldSaveTimer = setTimeout(_flushSkillFieldSave, 800);
}

// `validate` is true ONLY when the user explicitly commits (clicks 完成);
// typing-debounced and blur-triggered flushes pass false — bad names
// silently skip the save (DOM keeps the in-progress text) instead of
// popping a uiAlert mid-keystroke. Mirrors agents.js::_flushAgentFieldSave.
//
// During typing we use `skipRename:true` so the directory id stays as the
// original until Done; that keeps the URL / cache keyed by the same id and
// avoids a flurry of dir renames per keystroke. The Done branch fires a
// final `skipRename:false` update to commit the directory rename when the
// new name passed validation and actually differs from the original id.
async function _flushSkillFieldSave({ validate = false } = {}) {
  clearTimeout(_skillFieldSaveTimer);
  _skillFieldSaveTimer = null;
  // Clicking Done blurs the contenteditable title before the click handler
  // runs. That blur autosave can clear `_pendingSkillField`; recover the
  // current DOM value so the explicit commit still performs the dir rename.
  if (!_pendingSkillField && validate && _canEditSelectedSkillName()) {
    const nameEl = document.getElementById('skills-detail-name');
    if (nameEl && String(nameEl.innerText || '').trim() !== _selectedSkillNameFallback()) {
      _pendingSkillField = { field: 'name', value: nameEl.innerText };
    }
  }
  if (!_pendingSkillField || !_selectedSkill) return true;
  const { field, value } = _pendingSkillField;
  if (field === 'name') {
    const invalid = !_isValidSkillNameForSelected(String(value || ''));
    if (invalid) {
      if (!validate) return false;
      _pendingSkillField = null;
      await uiAlert(t('skills.name_invalid'));
      const nameEl = document.getElementById('skills-detail-name');
      if (nameEl) nameEl.innerText = _selectedSkillNameFallback();
      if (_selectedSkill.source === 'custom') {
        // Roll the SKILL.md frontmatter back to the original id too — the
        // skipRename:true writes during typing left a possibly-invalid name
        // on disk; revert so the next listSkills auto-heal doesn't misfire.
        try {
          await apiFetch(`/api/skills/${encodeURIComponent(_selectedSkill.id)}/update?skipRename=1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: _selectedSkill.id }),
          });
        } catch (_) { /* best-effort revert */ }
      }
      return false;
    }
  }
  _pendingSkillField = null;
  const currentId = _selectedSkill.id;
  const newName = String(value || '').trim();
  if (_isEditablePlatformSkill(_selectedSkill)) {
    try {
      const data = await window.orkas.invoke('skills.updateForEdit', {
        id: currentId,
        updates: { [field]: value },
      });
      if (!data || data.ok === false) {
        throw new Error(data?.error || 'save failed');
      }
      if (field === 'name') {
        const nextName = data.skill?.name || newName || currentId;
        _skillsCache = null;
        _skillTreeCache.clear();
        await loadSkills();
        _selectedSkill = { ..._selectedSkill, name: nextName };
        const nameEl = document.getElementById('skills-detail-name');
        if (nameEl) nameEl.innerText = nextName;
      }
      return true;
    } catch (e) {
      if (validate && field === 'name') {
        await uiAlert(t('skills.rename_failed', { reason: e.message || e }));
        const nameEl = document.getElementById('skills-detail-name');
        if (nameEl) nameEl.innerText = _selectedSkillNameFallback();
      }
      return false;
    }
  }
  const skipRename = !validate || newName === currentId;
  // ipc-shim's `wrapAsUpdates` wraps the body under `updates`, so the
  // request body holds only field values; `skipRename` rides on the URL
  // query string so it lands as a sibling of `updates` in the IPC payload.
  const url = `/api/skills/${encodeURIComponent(currentId)}/update${skipRename ? '?skipRename=1' : ''}`;
  try {
    const res = await apiFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || 'save failed');
    }
    if (validate && field === 'name' && !skipRename) {
      // Directory was renamed — refresh caches + update _selectedSkill.id
      // so subsequent calls (selectSkillFile / chat dir lookup) hit the
      // new id, not the stale one.
      const resultId = data.skill?.id || newName;
      _skillsCache = null;
      _skillTreeCache.clear();
      _expandedDirs.delete(`custom:${currentId}`);
      await loadSkills();
      _selectedSkill = { ..._selectedSkill, id: resultId };
      _skillEditSkillId = resultId;
    }
    return true;
  } catch (e) {
    if (validate && field === 'name') {
      await uiAlert(t('skills.rename_failed', { reason: e.message || e }));
      const nameEl = document.getElementById('skills-detail-name');
      if (nameEl) nameEl.innerText = _selectedSkill.id;
    }
    return false;
  }
}

// ─── Inline skill chat (edit-mode only, per-skill storage) ───

let _skillEditMode = false;
let _skillEditSkillId = null;
// Id of an unconfirmed URL-import placeholder skill. While set, leaving the
// import chat discards the draft if it was never authored (e.g. the source was
// installed as an external package, or the install failed). Cleared once the
// import produces real content or finalizes as a package.
let _importDraftId = null;

function _updateEditButtonLabel() {
  const btn = document.getElementById('skill-edit-btn');
  if (!btn) return;
  if (_skillEditMode) {
    btn.textContent = t('skills.edit_btn_done');
    return;
  }
  // Tag the "Edit" label on marketplace skills (dev-only entry); the "Done"
  // branch above stays bare — in edit mode the marker is redundant.
  const suffix = (_isSkillPlatformSource(_selectedSkill?.source) && false) ? t('common.dev_suffix') : '';
  btn.textContent = t('skills.edit_btn_edit') + suffix;
}

function _skillImportAutoSeedFromResponse(data) {
  if (data?.seedModelText === false || data?.seedMessage === false) return false;
  const modelText = typeof data?.seedModelText === 'string' && data.seedModelText.trim()
    ? data.seedModelText.trim()
    : (typeof data?.seedMessage === 'string' ? data.seedMessage.trim() : '');
  if (!modelText) return true;
  const displayText = typeof data?.seedDisplayText === 'string' && data.seedDisplayText.trim()
    ? data.seedDisplayText.trim()
    : t('skills.import_seed_display');
  return { displayText, modelText, force: true };
}

function _skillAutoSeedHasModelText(autoSeed) {
  if (typeof autoSeed === 'string') return !!autoSeed.trim();
  return !!(autoSeed && typeof autoSeed === 'object' && typeof autoSeed.modelText === 'string' && autoSeed.modelText.trim());
}

// When called with {autoSeed: true} (e.g. right after skill creation), sends
// a short "help me refine this skill" message to kick off the LLM. Import
// flows pass {displayText, modelText}: the chat bubble stays concise, while
// model_text carries the full source-inspection instructions. In plain edit
// mode (user clicks "edit" on an existing skill) no message is sent
// automatically — the user drives the conversation from a blank input.
async function toggleSkillEditMode(opts = {}) {
  if (!_selectedSkill) return;
  // Marketplace editing is dev-only; lift the source guard accordingly.
  if (_selectedSkill.source !== 'custom'
      && !(_isSkillPlatformSource(_selectedSkill.source) && false)) return;
  if (_skillEditMode && _skillEditSkillId === _selectedSkill.id) {
    // Abort any in-flight reply so "done" means "stop + exit", not
    // "exit but keep streaming". The chat controller is a singleton;
    // leaving it pending also leaks the streaming-button state into
    // the next skill's edit panel when the user clicks "edit"
    // elsewhere.
    try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    // Done click is the explicit commit point: flush any pending name
    // edit + validate. Invalid name → alert + revert DOM (and roll the
    // SKILL.md frontmatter back to the original id, see the validate
    // branch in `_flushSkillFieldSave`). Valid + actually-changed name
    // → fires a `skipRename:false` update which commits the directory
    // rename + refreshes caches before we re-render readonly view.
    const committed = await _flushSkillFieldSave({ validate: true });
    if (committed === false) return;
    // Explicit "Done" is a commit: keep the skill (even an empty import draft
    // the user chose to finalize) and stop the back-prompt from firing.
    _importDraftId = null;
    _skillEditMode = false;
    _skillEditSkillId = null;
    document.getElementById('skills-chat-col').style.display = 'none';
    _updateEditButtonLabel();
    // Swap the body back to read-only view of the current file. Use the
    // _selectedSkill.id snapshot — flush may have rotated it if the
    // directory got renamed.
    await selectSkillFile(_selectedSkill.source, _selectedSkill.id,
      _selectedSkill.filepath || 'SKILL.md', null);
    return;
  }
  _skillEditMode = true;
  _skillEditSkillId = _selectedSkill.id;
  document.getElementById('skills-chat-col').style.display = 'flex';
  _updateEditButtonLabel();
  // Re-render the currently selected file as an editor.
  await selectSkillFile(_selectedSkill.source, _selectedSkill.id,
    _selectedSkill.filepath || 'SKILL.md', null);
  _ensureSkillChatController();
  await _skillChatCtrl.loadHistory();
  await _chatAttachRefreshFromServer(_skillEditAttachmentCid(_skillEditSkillId));
  if (opts.autoSeed) {
    const existing = document.querySelectorAll('#skills-chat-messages .chat-message');
    const forceAutoSeed = !!(opts.autoSeed && typeof opts.autoSeed === 'object' && opts.autoSeed.force === true);
    if (forceAutoSeed || existing.length === 0) {
      const baseSeed = t('skills.help_finish_seed_model');
      const importSeed = typeof opts.autoSeed === 'string'
        ? opts.autoSeed.trim()
        : (opts.autoSeed && typeof opts.autoSeed === 'object' && typeof opts.autoSeed.modelText === 'string'
            ? opts.autoSeed.modelText.trim()
            : '');
      const seed = importSeed
        ? [baseSeed, importSeed].filter(Boolean).join('\n\n')
        : baseSeed;
      const displayText = importSeed
        ? (opts.autoSeed && typeof opts.autoSeed === 'object' && typeof opts.autoSeed.displayText === 'string' && opts.autoSeed.displayText.trim()
            ? opts.autoSeed.displayText.trim()
            : t('skills.import_seed_display'))
        : t('skills.help_finish_seed');
      await _skillChatCtrl.send(displayText, { model_text: seed });
    }
  }
}

// Lazy singleton — created once, driven by `_skillEditSkillId` via the id
// resolver so it follows the currently active skill.
let _skillChatCtrl = null;
let _skillEditAttachmentsBound = false;
let _pendingSkillImportReplacementId = null;

function _skillEditAttachmentCid(skillId) {
  return skillId ? `skill-edit-${skillId}` : '';
}

function _bindSkillEditAttachments() {
  if (_skillEditAttachmentsBound) return;
  _skillEditAttachmentsBound = true;
  const btn = document.getElementById('skills-chat-attach-btn');
  const area = document.querySelector('.skills-chat-input-area');
  const input = document.getElementById('skills-chat-input');
  const currentCid = () => _skillEditAttachmentCid(_skillEditSkillId || '');
  if (btn) {
    btn.addEventListener('click', async () => {
      const cid = currentCid();
      if (cid) await _chatAttachPickAndUpload(cid, 'picker');
    });
  }
  if (area) {
    area.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length;
      const hasInternal = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(ORKAS_FILE_DRAG_MIME);
      if (!hasFiles && !hasInternal) return;
      e.preventDefault();
      area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', async (e) => {
      const cid = currentCid();
      if (!cid) return;
      const internal = _chatAttachInternalDragItems(e.dataTransfer);
      if (internal.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachImportPaths(cid, internal, 'internal_drop');
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachUpload(cid, e.dataTransfer.files, 'drop');
      }
    });
  }
  if (input) {
    input.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      const cid = currentCid();
      if (!cid) return;
      e.preventDefault();
      await _chatAttachUpload(cid, e.clipboardData.files, 'paste');
    });
  }
}

async function _buildSkillEditChatExtraBody(_content, skillId, state) {
  const cid = _skillEditAttachmentCid(skillId);
  const items = _chatAttachList(cid);
  if (!items.length) return undefined;
  if (items.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return null;
  }
  const attachments = items.filter((a) => a.status !== 'error').map((a) => a.name);
  if (!attachments.length) return undefined;
  if (state && (state.pending || state.hasQueue)) {
    await uiAlert(t('chat.attach_queue_blocked'));
    return null;
  }
  _chatAttachClear(cid);
  return { attachments, attachment_cid: cid };
}

function _ensureSkillChatController() {
  if (_skillChatCtrl) return _skillChatCtrl;
  _bindSkillEditAttachments();
  _skillChatCtrl = createChatController({
    historyEl: 'skills-chat-messages',
    inputEl: 'skills-chat-input',
    sendBtnEl: 'skills-chat-send-btn',
    getCurrentId: () => _skillEditSkillId,
    historyEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat`,
    streamEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat/send/stream`,
    clearEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat`,
    features: { archive: false, scrollPin: true, queue: true },
    queue: {
      keyPrefix: 'skill',
      panelId: 'skills-chat-queue',
      listId: 'skills-chat-queue-list',
      countId: 'skills-chat-queue-count',
    },
    hooks: {
      buildExtraBody: _buildSkillEditChatExtraBody,
      async onFinal(ev, msgEl, id) {
        // Authoring wrote real files → this import produced a genuine custom
        // skill; commit it so backing out no longer prompts/discards.
        if (ev?.written?.length || ev?.created?.length) _importDraftId = null;
        if (_pendingSkillImportReplacementId) {
          const nextId = _pendingSkillImportReplacementId;
          _pendingSkillImportReplacementId = null;
          _importDraftId = null;
          _skillEditSkillId = nextId;
          _selectedSkill = { source: 'custom', id: nextId, filepath: 'SKILL.md' };
          _skillsCache = null;
          await _showSkillsDetailView('custom', nextId);
          await _skillChatCtrl.loadHistory();
          return;
        }
        // Skill chat may rewrite files on disk; refresh the detail pane so
        // the tree and SKILL.md display reflect the new state.
        await _refreshSkillView();
      },
      onStreamEvent(ev, msgEl, id) {
        const inner = ev?.event;
        if (!inner) return;
        // `skill_as_package`: the URL import was installed as an external
        // package and main deleted the placeholder skill. Switch the detail
        // pane to the package result state (no skill content to show).
        if (inner.stream === 'skill_as_package') {
          // Placeholder already deleted by main; clear the draft guard so the
          // grid-view exit doesn't try to re-discard a gone id.
          _importDraftId = null;
          _showSkillAsPackageState(inner.data?.name || '');
          return;
        }
        if (inner.stream === 'skill_import_replaced') {
          const nextId = inner.data?.skillId || inner.data?.skills?.[0]?.skill_id || '';
          if (nextId) {
            _pendingSkillImportReplacementId = nextId;
            _importDraftId = null;
            _skillsCache = null;
          }
          return;
        }
        // Auto-rename on `skill_renamed` event from main: the skill's
        // SKILL.md `name:` differs from its dir id, so main moved the dir
        // (and its chat dir + session id) to the new id. Switch the
        // active edit chat to the new id transparently.
        if (inner.stream !== 'skill_renamed') return;
        const { oldId, newId } = inner.data || {};
        if (!oldId || !newId || oldId === newId) return;
        if (id !== oldId && _skillEditSkillId !== oldId) return;
        // A rename means real content was authored — commit the import draft.
        _importDraftId = null;
        // Update active selection / id-resolver target
        _skillEditSkillId = newId;
        if (_selectedSkill && _selectedSkill.id === oldId) {
          _selectedSkill = { ..._selectedSkill, id: newId };
        }
        _skillsCache = null;
        // Refresh list + detail pane lazily — avoid blocking the stream
        // reader. If the user is mid-stream we can't reload mid-flight, so
        // fire-and-forget; the stream reader will keep yielding into the
        // (still attached) msgEl.
        Promise.resolve().then(() => loadSkills()).catch(() => {});
      },
    },
  });
  return _skillChatCtrl;
}

async function clearSkillChat() {
  if (!_skillEditSkillId) return;
  if (!(await uiConfirm(t('skills.clear_confirm')))) return;
  _ensureSkillChatController();
  await _skillChatCtrl.clear();
}

async function _refreshSkillView() {
  if (!_skillEditSkillId) return;
  const sid = _skillEditSkillId;
  // Source must come from the active selection, not be hardcoded — dev-mode
  // built-in editing reuses this same path and was previously bailing here
  // because of a 'custom'-only equality check.
  const source = _selectedSkill?.source || 'custom';

  // Refresh the skill list cache (in case name/description in SKILL.md changed)
  _skillsCache = null;
  await loadSkills();

  // Refresh the tree cache so subsequent expansion sees the latest files
  const treeKey = `${source}:${sid}`;
  _skillTreeCache.delete(treeKey);

  // Bail if user navigated away while we were awaiting above.
  if (!_selectedSkill || _selectedSkill.id !== sid || _selectedSkill.source !== source) return;

  // Re-render the whole detail page via selectSkillFile so the header
  // (name) and the doc sections (description / external deps /
  // dependent skills / ...) pick up SKILL.md frontmatter changes the
  // LLM just made — without this, the description chip stayed on the
  // pre-edit value until the user clicked "done". selectSkillFile
  // also re-reads the body, so we
  // don't need a separate body refetch here.
  const filepath = _selectedSkill.filepath || 'SKILL.md';
  await selectSkillFile(source, sid, filepath, null);

  // selectSkillFile clears tree active state. If the source panel is
  // expanded, refresh it in case files were added/removed (e.g. the LLM
  // wrote a new script) and re-mark the active file.
  const sourceToggle = document.getElementById('skills-source-toggle');
  const sourcePanel = document.getElementById('skills-source-panel');
  const sourceTreeEl = document.getElementById('skills-source-tree');
  const expanded = sourceToggle?.getAttribute('aria-expanded') === 'true';
  if (expanded && sourcePanel && sourceTreeEl) {
    await expandSkillTree(source, sid, sourceTreeEl);
  }
  _markActiveSkillFileInTree(filepath);
}

// ─── Custom skill CRUD ───

let _skillModalBusy = false;

function _setSkillModalBusy(busy) {
  _skillModalBusy = !!busy;
  const modal = document.getElementById('skill-modal');
  if (modal) modal.setAttribute('aria-busy', _skillModalBusy ? 'true' : 'false');
  const ids = [
    'skill-save-btn',
    'skill-dir-pick-btn',
    'skill-url-input',
    'skill-name',
    'skill-description',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = _skillModalBusy;
  }
  document.querySelectorAll('#skill-modal .modal-actions .btn, #skill-modal .skill-modal-tab')
    .forEach((el) => { el.disabled = _skillModalBusy; });
}

function _waitForSkillModalBusyPaint() {
  return new Promise((resolve) => {
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 0);
    raf(() => resolve());
  });
}

function _switchSkillTab(tab) {
  if (_skillModalBusy) return;
  const tabs = document.querySelectorAll('.skill-modal-tab');
  tabs.forEach((el) => el.classList.toggle('is-active', el.dataset.skillTab === tab));
  const panels = document.querySelectorAll('.skill-modal-panel');
  panels.forEach((el) => el.classList.toggle('is-active', el.dataset.skillPanel === tab));
  // Clear error msg when switching tabs
  const msgEl = document.getElementById('skill-form-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'form-msg'; }
  // Focus primary input of the new tab
  setTimeout(() => {
    const focusId = tab === 'url' ? 'skill-url-input'
                  : tab === 'dir' ? 'skill-dir-pick-btn'
                  : 'skill-name';
    const el = document.getElementById(focusId);
    if (el) el.focus();
  }, 30);
}
window._switchSkillTab = _switchSkillTab;

async function openSkillModal(editId) {
  const modal = document.getElementById('skill-modal');
  const title = document.getElementById('skill-modal-title');
  const editIdInput = document.getElementById('skill-edit-id');
  const msgEl = document.getElementById('skill-form-msg');
  const saveBtn = document.getElementById('skill-save-btn');
  const tabBar = document.getElementById('skill-modal-tabs');
  _setSkillModalBusy(false);
  msgEl.textContent = '';
  msgEl.className = 'form-msg';

  // Reset all inputs across all panels
  for (const id of [
    'skill-name', 'skill-description',
    'skill-url-input',
    'skill-dir-path',
  ]) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  const sel = document.getElementById('skill-dir-selected');
  if (sel) sel.textContent = t('skill_modal.dir_none');

  if (editId) {
    title.textContent = t('skills.modal_edit_title');
    saveBtn.textContent = t('common.confirm');
    editIdInput.value = editId;
    if (tabBar) tabBar.style.display = 'none'; // edit mode: no tabs, manual only
    _switchSkillTab('manual');
    const cached = _skillsCache?.find(s => s.id === editId && s.source === 'custom');
    if (cached) {
      document.getElementById('skill-name').value = cached.name || '';
      // Edit modal keeps a single description field for now (UX kept simple);
      // form input is merely a seed — the full bilingual pair is authored
      // through the inline edit-chat. Show whichever locale matches the
      // active UI language with cross-fallback.
      document.getElementById('skill-description').value = pickDesc(cached, getLang()) || '';
    }
  } else {
    title.textContent = t('skills.modal_new_title');
    saveBtn.textContent = t('common.confirm');
    editIdInput.value = '';
    if (tabBar) tabBar.style.display = '';
    _switchSkillTab('manual');
  }

  // Wire tab buttons (idempotent — checks a flag)
  if (tabBar && !tabBar.dataset.wired) {
    tabBar.querySelectorAll('.skill-modal-tab').forEach((btn) => {
      btn.addEventListener('click', () => _switchSkillTab(btn.dataset.skillTab));
    });
    tabBar.dataset.wired = '1';
  }

  modal.classList.add('open');
  if (typeof window.bindNameLimitControl === 'function') {
    window.bindNameLimitControl(document.getElementById('skill-name'));
  }
}
window.openSkillModal = openSkillModal;

function closeSkillModal() {
  document.getElementById('skill-modal').classList.remove('open');
}
window.closeSkillModal = closeSkillModal;

async function pickSkillImportDir() {
  const msgEl = document.getElementById('skill-form-msg');
  msgEl.textContent = '';
  try {
    const res = await apiFetch('/api/skills/pick-import-dir', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skill_modal.dir_pick_failed');
      msgEl.className = 'form-msg err';
      return;
    }
    if (data.cancelled) return;
    const p = String(data.path || '');
    document.getElementById('skill-dir-path').value = p;
    document.getElementById('skill-dir-selected').textContent = p;
  } catch (_) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
  }
}
window.pickSkillImportDir = pickSkillImportDir;

function _skillCreateNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function _skillCreateDuration(startedAt) {
  return Math.max(0, Math.round(_skillCreateNow() - Number(startedAt || 0)));
}

function _skillCreatePayload(creationMethod, data) {
  return Object.assign({ creation_method: creationMethod }, data || {});
}

function _skillCreateTrackClick(creationMethod, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.click === 'function') {
      monitor.click('skill_create_submit', _skillCreatePayload(creationMethod, data));
    }
  } catch (_) {}
}

function _skillCreateTrackResult(tracking, result, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.event === 'function') {
      monitor.event('skill_create_result', _skillCreatePayload(tracking.creationMethod, Object.assign({
        result,
        duration_ms: _skillCreateDuration(tracking.startedAt),
      }, data || {})));
    }
  } catch (_) {}
}

function _skillCreateTrackError(tracking, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.error === 'function') {
      monitor.error('skill_create', _skillCreatePayload(tracking.creationMethod, data || {}));
    }
  } catch (_) {}
}

function _skillCreateTracking(creationMethod, clickData) {
  const tracking = {
    creationMethod,
    startedAt: _skillCreateNow(),
  };
  _skillCreateTrackClick(creationMethod, clickData);
  return tracking;
}

function _skillCreateIdFromResponse(data) {
  return data?.skill?.id || data?.skills?.[0]?.id || '';
}

function _skillCreateCountFromResponse(data) {
  if (Array.isArray(data?.skills)) return data.skills.length;
  return data?.skill ? 1 : 0;
}

function _skillCreateResourceFromResponse(data, fallbackName = '') {
  const skill = data?.skill || data?.skills?.[0] || {};
  const id = String(skill.id || '').trim().slice(0, 128);
  const name = String(skill.name || fallbackName || id).replace(/\s+/g, ' ').trim().slice(0, 128);
  return {
    resource_kind: 'skill',
    resource_id: id,
    resource_name: name,
  };
}

async function saveSkill() {
  if (_skillModalBusy) return;
  const editId = document.getElementById('skill-edit-id').value;
  const msgEl = document.getElementById('skill-form-msg');

  // Edit mode: always manual path.
  if (editId) {
    return _saveSkillManual({ editId, msgEl });
  }

  const activeTab = document.querySelector('.skill-modal-tab.is-active')?.dataset.skillTab || 'manual';
  if (activeTab === 'url') return _saveSkillFromUrl({ msgEl });
  if (activeTab === 'dir') return _saveSkillFromDir({ msgEl });
  return _saveSkillManual({ editId: '', msgEl });
}
window.saveSkill = saveSkill;

async function _saveSkillManual({ editId, msgEl }) {
  const rawName = document.getElementById('skill-name').value;
  const name = rawName.trim();
  const description = document.getElementById('skill-description').value.trim();
  if (!name) {
    msgEl.textContent = t('skills.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-name').focus();
    return;
  }
  if (!_isValidSkillNameCharset(rawName)) {
    msgEl.textContent = t('skills.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-name').focus();
    return;
  }
  if (!description) {
    msgEl.textContent = t('skills.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-description').focus();
    return;
  }
  const tracking = editId ? null : _skillCreateTracking('manual', { category: 'general' });
  try {
    // Create: stamp the marketplace default since the modal has no category picker.
    // Edit: omit category so the on-disk frontmatter value is preserved (LLM-authored
    // edits via `skill-creator` are the only source of category mutation).
    const body = editId ? { name, description } : { name, description, category: 'general' };
    const res = editId
      ? await apiFetch(`/api/skills/${editId}/update`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await apiFetch('/api/skills/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      if (tracking) {
        _skillCreateTrackResult(tracking, 'failure', {
          category: 'general',
          error_code: data.code || '',
        });
        _skillCreateTrackError(tracking, {
          category: 'general',
          error_type: 'api',
          error_code: data.code || '',
          error_message: data.error || 'unknown',
        });
      }
      return;
    }
    if (tracking) {
      _skillCreateTrackResult(tracking, 'success', {
        skill_id: _skillCreateIdFromResponse(data),
        ..._skillCreateResourceFromResponse(data, name),
        skill_count: _skillCreateCountFromResponse(data),
        category: 'general',
      });
    }
    await _afterSkillCreated(data.skill?.id || editId, !editId, null);
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    if (tracking) {
      _skillCreateTrackResult(tracking, 'failure', { category: 'general' });
      _skillCreateTrackError(tracking, {
        category: 'general',
        error_type: 'network',
        error_message: e && e.message ? e.message : String(e),
      });
    }
  }
}

async function _saveSkillFromUrl({ msgEl }) {
  const url = document.getElementById('skill-url-input').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    msgEl.textContent = t('skill_modal.err_url_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-url-input').focus();
    return;
  }
  const tracking = _skillCreateTracking('url');
  try {
    msgEl.textContent = t('skills.saving');
    msgEl.className = 'form-msg';
    _setSkillModalBusy(true);
    await _waitForSkillModalBusyPaint();
    const res = await apiFetch('/api/skills/create-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null, description: null, url }),
    });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      _setSkillModalBusy(false);
      _skillCreateTrackResult(tracking, 'failure', {
        error_code: data.code || '',
      });
      _skillCreateTrackError(tracking, {
        error_type: 'api',
        error_code: data.code || '',
        error_message: data.error || 'unknown',
      });
      return;
    }
    const createdId = _skillCreateIdFromResponse(data);
    const autoSeed = _skillImportAutoSeedFromResponse(data);
    // URL imports start as empty placeholders. If the user backs out before
    // the edit chat authors real content, offer to discard that placeholder.
    _importDraftId = data.skill?.id && _skillAutoSeedHasModelText(autoSeed) ? data.skill.id : null;
    _skillCreateTrackResult(tracking, 'success', {
      skill_id: createdId,
      ..._skillCreateResourceFromResponse(data),
      skill_count: _skillCreateCountFromResponse(data),
    });
    await _afterSkillCreated(createdId, true, autoSeed);
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    _skillCreateTrackResult(tracking, 'failure');
    _skillCreateTrackError(tracking, {
      error_type: 'network',
      error_message: e && e.message ? e.message : String(e),
    });
  } finally {
    _setSkillModalBusy(false);
  }
}

async function _saveSkillFromDir({ msgEl }) {
  const srcDir = document.getElementById('skill-dir-path').value.trim();
  if (!srcDir) {
    msgEl.textContent = t('skill_modal.err_dir_missing');
    msgEl.className = 'form-msg err';
    return;
  }
  return _saveSkillFromDirWithQuality({
    msgEl,
    srcDir,
    force: false,
    tracking: _skillCreateTracking('dir', { forced: false }),
  });
}

function _qualityImportRejectedTitle(name) {
  const tmpl = t('quality.import_rejected_title');
  const fallback = `Import rejected by quality validator: ${name}`;
  return tmpl === 'quality.import_rejected_title'
    ? fallback
    : tmpl.replace('{name}', name);
}

async function _saveSkillFromDirWithQuality({ msgEl, srcDir, force, tracking }) {
  tracking = tracking || _skillCreateTracking('dir', { forced: !!force });
  try {
    msgEl.textContent = t('skills.saving');
    msgEl.className = 'form-msg';
    _setSkillModalBusy(true);
    await _waitForSkillModalBusyPaint();
    const res = await apiFetch('/api/skills/create-from-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null, description: null, srcDir, ...(force ? { force: true } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) {
      _setSkillModalBusy(false);
      if (data.report && typeof showValidationReport === 'function') {
        const titleName = data.skillId || srcDir.split(/[\\/]/).filter(Boolean).pop() || srcDir;
        // Report-only: an EXTREME violation is not overridable, so no force
        // action is offered. Previously a "force import" button re-invoked
        // this with force:true, which skipped the main-process red-flag gate
        // for everything except the runner-convention rule.
        await showValidationReport({
          title: _qualityImportRejectedTitle(titleName),
          report: data.report,
        });
        _skillCreateTrackResult(tracking, 'blocked', {
          forced: false,
          error_code: data.code || 'quality_validation',
        });
        _skillCreateTrackError(tracking, {
          forced: false,
          error_type: 'validation',
          error_code: data.code || 'quality_validation',
          error_message: data.error || 'quality validation failed',
        });
        msgEl.textContent = data.error || t('skills.save_failed');
        msgEl.className = 'form-msg err';
        return;
      }
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      _skillCreateTrackResult(tracking, 'failure', {
        forced: !!force,
        error_code: data.code || '',
      });
      _skillCreateTrackError(tracking, {
        forced: !!force,
        error_type: data.report ? 'validation' : 'api',
        error_code: data.code || '',
        error_message: data.error || 'unknown',
      });
      return;
    }
    const createdId = _skillCreateIdFromResponse(data);
    _skillCreateTrackResult(tracking, 'success', {
      skill_id: createdId,
      ..._skillCreateResourceFromResponse(data),
      skill_count: _skillCreateCountFromResponse(data),
      forced: !!force,
    });
    await _afterSkillCreated(createdId, true, _skillImportAutoSeedFromResponse(data));
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    _skillCreateTrackResult(tracking, 'failure', { forced: !!force });
    _skillCreateTrackError(tracking, {
      forced: !!force,
      error_type: 'network',
      error_message: e && e.message ? e.message : String(e),
    });
  } finally {
    _setSkillModalBusy(false);
  }
}

// Shared "after create" tail: close modal, refresh list, jump to edit view.
// `autoSeed` — optional first message descriptor for the skill edit chat.
//              Pass null to let toggleSkillEditMode use its default seed
//              ("help me refine this skill"). Pass false to skip entering
//              edit chat. Ignored in edit mode (isNew=false).
async function _afterSkillCreated(sid, isNew, autoSeed) {
  closeSkillModal();
  _skillsCache = null;
  await loadSkills();
  if (!sid) return;
  setView('skills');
  // Jump straight into detail view for the new skill (skipping the grid
  // landing) so the user can see what they just created and start editing.
  // This must finish before entering edit chat: selectSkillFile() owns the
  // detail/chat visibility state, so racing it against toggleSkillEditMode()
  // can leave imports on the readonly detail page.
  await _showSkillsDetailView('custom', sid, { expandSource: false });
  if (isNew) {
    if (!_selectedSkill || _selectedSkill.source !== 'custom' || _selectedSkill.id !== sid) {
      _selectedSkill = { source: 'custom', id: sid, filepath: 'SKILL.md' };
    }
    if (autoSeed === false) return;
    await toggleSkillEditMode({ autoSeed: autoSeed || true });
    Promise.resolve().then(() => {
      if (_selectedSkill?.source === 'custom' && _selectedSkill?.id === sid) {
        return _ensureSkillsSourceExpanded();
      }
    }).catch(() => {});
  }
}

function editSelectedSkill() {
  if (!_selectedSkill || _selectedSkill.source !== 'custom') return;
  // Custom skills are edited via the inline AI chat (already visible on the right)
  const input = document.getElementById('skills-chat-input');
  if (input) {
    input.focus();
    // Scroll chat into view if needed
    input.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

async function deleteSelectedSkill() {
  if (!_selectedSkill) return;
  const src = _selectedSkill.source;
  if (src !== 'custom' && !(_isSkillPlatformSource(src) && false)) return;
  const sid = _selectedSkill.id;
  const cached = _skillsCache?.find(s => s.id === sid && s.source === src);
  if (!(await uiConfirm(t('skills.delete_confirm', { name: cached?.name || sid })))) return;
  try {
    const result = _isSkillPlatformSource(src)
      ? await window.orkas.invoke('skills.builtin.delete', { id: sid })
      : await (await apiFetch(`/api/skills/${sid}`, { method: 'DELETE' })).json();
    if (!result.ok) {
      await uiAlert(t('skills.delete_failed_with', { reason: result.error || '' }));
      return;
    }
    _selectedSkill = null;
    _skillsCache = null;
    _skillTreeCache.clear();
    await loadSkills();
    // Snap back to grid view (detail panel is for whole skills, the one
    // we just deleted no longer exists).
    _showSkillsGridView();
  } catch (e) {
    await uiAlert(t('skills.delete_failed_with', { reason: e.message || e }));
  }
}

/**
 * Per-skill enable / disable button in the detail header.
 * Clone-replace the node each render to drop any prior click handler
 * bound to a stale skill id. The button label flips between "enable"
 * and "disable" (whichever the click would do).
 */
function _renderSkillEnabledButton(skill) {
  const oldBtn = document.getElementById('skill-enabled-btn');
  if (!oldBtn) return;
  const enabled = skill.enabled !== false;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);
  btn.textContent = enabled ? t('component.disable') : t('component.enable');
  btn.title = enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await _flipSkillEnabled(skill.id, !enabled); }
    finally { btn.disabled = false; }
  });
}
