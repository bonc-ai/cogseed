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
let _skillsCognitionCaptureRequestId = 0;
let _skillsCognitionCaptureRequestsInFlight = 0;
let _recallSkillDraftAutoQueue = Promise.resolve();
const _recallSkillDraftAutoPending = new Set();
let _selectedSkill = null;    // { source, id }
let _expandedGlobalSkillGroups = new Set();
const _GLOBAL_SKILL_GROUP_MIN = 2;


const _skillsCognitionState = {
  page: 'overview',
  recallCandidates: [],
  sources: [],
  teachingSignals: [],
  captures: [],
  recentCaptures: [],
  captureCounts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 },
  captureNextCursor: null,
  captureFilter: 'all',
  captureSettings: null,
  captureModel: null,
  captureSettingsExpanded: false,
  selectedCaptureId: '',
  loadErrors: [],
  editingRecallCandidateId: '',
  writingRecallCandidateId: '',
  assets: [],
  selectedAssetId: '',
  assetCategoryFilter: '',
  assetSearchQuery: '',
  assetHistoryById: {},
  visibleAssetHistoryId: '',
  assetChainById: {},
  visibleAssetChainId: '',
  dashboard: null,
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
    pending_review: _cognitionText('cognition.status_pending', '待确认'),
    observed: _cognitionText('cognition.status_observed', '观察中'),
    weak_observation: _cognitionText('cognition.status_observed', '待补证'),
    deferred: _cognitionText('cognition.status_deferred', '稍后处理'),
    ignored: _cognitionText('cognition.status_ignored', '已忽略'),
    accepted: _cognitionText('cognition.status_accepted', '已确认'),
    preview: _cognitionText('cognition.status_preview', '预览'),
    confirmed: _cognitionText('cognition.status_confirmed', '已确认'),
    expired: _cognitionText('cognition.status_expired', '已失效'),
    revoked: _cognitionText('cognition.status_revoked', '已撤销'),
    ready: _cognitionText('cognition.source_ready', '可用'),
    empty: _cognitionText('cognition.source_empty', '暂无数据'),
    waiting: _cognitionText('cognition.capture_waiting', '等待中'),
    waiting_quiet: _cognitionText('cognition.capture_waiting_quiet', '等待会话静默'),
    waiting_completion: _cognitionText('cognition.capture_waiting_completion', '等待会话完成'),
    waiting_manual: _cognitionText('cognition.capture_waiting_manual', '等待手动执行'),
    scheduled: _cognitionText('cognition.capture_scheduled', '等待计划时间'),
    queued: _cognitionText('cognition.capture_queued', '等待提炼'),
    extracting: _cognitionText('cognition.capture_extracting', '正在整理'),
    writing: _cognitionText('cognition.capture_writing', '写入中'),
    paused: _cognitionText('cognition.capture_paused', '已暂停'),
    review_ready: _cognitionText('cognition.capture_review_ready', '等待审核'),
    no_candidate: _cognitionText('cognition.capture_no_candidate', '无需沉淀'),
    configuration_required: _cognitionText('cognition.capture_configuration_required', '需要配置模型'),
    failed: _cognitionText('cognition.capture_failed', '提炼失败'),
    cancelled: _cognitionText('cognition.capture_cancelled', '已取消'),
    completed: _cognitionText('cognition.capture_completed', '已完成'),
  };
  return labels[status] || status || _cognitionText('cognition.unknown', '未知');
}

function _captureWorkflowStatus(capture) {
  if (_skillsCognitionState.writingRecallCandidateId
    && Array.isArray(capture?.candidateIds)
    && capture.candidateIds.includes(_skillsCognitionState.writingRecallCandidateId)) return 'writing';
  return capture?.displayStatus || capture?.workflowStatus || capture?.status || '';
}

function _captureReviewSummary(capture) {
  const summary = capture?.reviewSummary || {};
  const hasSummary = !!capture?.reviewSummary && typeof capture.reviewSummary === 'object';
  const total = Number.isFinite(Number(summary.total)) ? Number(summary.total) : (capture?.candidateIds || []).length;
  return {
    total,
    pending: Number(summary.pending) || (!hasSummary && _captureWorkflowStatus(capture) === 'review_ready' ? total : 0),
    deferred: Number(summary.deferred) || 0,
    promoted: Number(summary.promoted) || 0,
    rejected: Number(summary.rejected) || 0,
    missing: Number(summary.missing) || 0,
  };
}

// Capture records created before the review-handoff receipt existed only carry
// linkedAssetIds. Keep those readable while preferring the persisted receipt
// supplied by the current capture workflow.
function _captureConfirmedAssetReceipts(capture) {
  const values = Array.isArray(capture?.confirmedAssetReceipts) ? capture.confirmedAssetReceipts : [];
  const byReceipt = new Map();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const assetId = String(value.assetId || '').trim();
    if (!assetId) continue;
    const candidateId = String(value.candidateId || '').trim();
    const reviewDecisionId = String(value.reviewDecisionId || '').trim();
    const sourceRefCount = Number(value.sourceRefCount);
    const receipt = {
      candidateId,
      assetId,
      assetType: String(value.assetType || '').trim(),
      version: String(value.version || '').trim(),
      scope: String(value.scope || '').trim(),
      sourceRefCount: Number.isFinite(sourceRefCount) && sourceRefCount >= 0 ? sourceRefCount : 0,
      reviewDecisionId,
    };
    const key = `${receipt.candidateId}\u0000${receipt.assetId}\u0000${receipt.reviewDecisionId}`;
    if (!byReceipt.has(key)) byReceipt.set(key, receipt);
  }
  return Array.from(byReceipt.values());
}

function _captureLinkedAssetIds(capture) {
  const ids = [
    ..._captureConfirmedAssetReceipts(capture).map((receipt) => receipt.assetId),
    ...(Array.isArray(capture?.linkedAssetIds) ? capture.linkedAssetIds : []),
  ].map((id) => String(id || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

function _cognitionDate(value) {
  if (!value) return '';
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  } catch (_) {
    return '';
  }
}

function _cognitionSetPageVisibility(page) {
  document.querySelectorAll('[data-cognition-page-body]').forEach((el) => {
    el.hidden = el.dataset.cognitionPageBody !== page;
  });
  document.querySelectorAll('[data-cognition-page]').forEach((el) => {
    const active = el.dataset.cognitionPage === page;
    el.classList.toggle('is-active', active);
    // 「管理来源」「沉淀活动」是页头辅助入口，不在 tablist 里：给它们套
    // aria-selected / roving tabindex 会对屏幕阅读器谎报成第 N 个标签页。
    if (el.getAttribute('role') !== 'tab') return;
    el.setAttribute('aria-selected', active ? 'true' : 'false');
    el.tabIndex = active ? 0 : -1;
  });
}

function switchSkillsCognitionPage(page) {
  const aliases = { candidates: 'captures', receipts: 'assets', brain: 'overview', context: 'overview', ontology: 'overview' };
  const requested = aliases[page] || page;
  const allowed = new Set(['overview', 'captures', 'assets', 'sources', 'proofs']);
  const next = allowed.has(requested) ? requested : 'overview';
  _skillsCognitionState.page = next;
  if (next === 'assets' && !_skillsCognitionState.assetCategoryFilter && !_skillsCognitionState.selectedAssetId) {
    _skillsCognitionState.assetCategoryFilter = 'personal';
  }
  _cognitionSetPageVisibility(next);
  if (next === 'overview') renderSkillsCognitionOverview();
  if (next === 'sources') renderSkillsCognitionSources();
  if (next === 'proofs') renderSkillsCognitionProofs();
  if (next === 'captures') renderSkillsCognitionCaptures();
  if (next === 'assets') renderSkillsCognitionAssets();
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
    skill_method: _cognitionText('cognition.asset_category_skill_method', '可复用方法'),
  };
  return labels[category] || category || _cognitionText('cognition.unknown', '未知');
}

// 作用域中文标签（交互规范 §17.3：作用域要"看得懂"，不暴露英文检索 token）。
function _abilityAssetScopeLabel(scope) {
  const labels = {
    report: '报告类任务',
    code: '代码类任务',
    review: '审查类任务',
    product: '产品类任务',
    general: '通用',
  };
  return labels[String(scope || '')] || String(scope || '');
}

// 候选/资产的展示标题（交互规范附录 A：标题体现内容）。
// - 旧候选可能带英文模板 summary（'Reusable experience lesson...' 等），
//   渲染层从 judgment 提炼中文标题，避免用户看到英文；
// - 其余情况返回原 summary/title。
function _abilityCandidateDisplayTitle(candidate) {
  const summary = String(candidate.summary || '').trim();
  const judgment = String(candidate.judgment || '').trim();
  const isLegacyEnglish = /^(Reusable experience lesson|KSTAR rule gap candidate|Verified multi-tool workflow|Reusable workflow lesson)/.test(summary);
  if (isLegacyEnglish && judgment) return _abilityTitleFromContent(judgment);
  return summary || _abilityTitleFromContent(judgment) || candidate.id || '';
}

// 从经验内容提炼标题核心：去掉引导前缀，取第一句主干，限 40 字。
// 与主进程 lessonTitleCore 同规则（渲染层是兜底路径）。
function _abilityTitleFromContent(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:遇到同类情况时，)?(?:应|须|要)?注意修正[:：]/, '')
    .replace(/^(?:当|对于|遇到|处理|在处理|在)[^，。；,.;:：]*?(?:时|后|中|之前|以后)?[，,。；;]/, '')
    .replace(/^(?:可|应|须|要|建议|务必|注意)[^，。；,.;:：]{0,2}/, '')
    .replace(/^(?:“|『|「)/, '')
    .replace(/([，。；,.;:：])[\s\S]*$/, '$1')
    .trim();
  if (!t) return '通用经验';
  return t.length <= 40 ? t : `${t.slice(0, 40)}…`;
}

// 成熟度的用户侧表达按 PRD 3.6「资产成熟度与默认使用契约」的五档写法。
// 内部枚举仍是 seed/bud/transfer_validated/effectiveness_validated（收敛枚举
// 涉及 28 处源码 + 23 个测试文件 + 数据迁移，另开一批做），这里只在展示边界
// 统一口径：seed 与 bud 都属于「已确认，尚未验证」——它们的差别是"谁写进来的"，
// 由 lifecycleStatus 表达，不该在成熟度轴上再分一档。
function _abilityAssetMaturityLabel(maturity, status) {
  if (status === 'paused') return _cognitionText('cognition.asset_status_paused', '已暂停');

  if (status === 'revoked') return _cognitionText('cognition.maturity_revoked', '已撤销');
  if (status === 'candidate') return _cognitionText('cognition.maturity_candidate', '待确认');
  if (maturity === 'effectiveness_validated' || maturity === 'stable') {
    return _cognitionText('cognition.maturity_effectiveness_validated', '已验证有效');
  }
  if (maturity === 'transfer_validated') return _cognitionText('cognition.maturity_transfer_verified', '已成功带入');
  if (maturity === 'seed' || maturity === 'bud') {
    return _cognitionText('cognition.maturity_confirmed_unverified', '已确认，尚未验证');
  }
  return maturity || status || _cognitionText('cognition.unknown', '未知');
}

// lifecycleStatus 有三个值，只有 user_confirmed_unverified 代表真实用户确认。
// 其余两个（会话自动抽取 / KStar 自进化沉淀）都不得显示成「确认入库」。
function _abilityAssetWriteOriginLabel(lifecycleStatus) {
  if (lifecycleStatus === 'automatically_extracted_unverified') {
    return _cognitionText('cognition.asset_write_origin_auto', '自动入库');
  }
  if (lifecycleStatus === 'system_precipitated_unverified') {
    return _cognitionText('cognition.asset_write_origin_system', '系统沉淀');
  }
  return _cognitionText('cognition.asset_write_origin_user', '确认入库');

}

function _abilityAssetSummary(items, category) {
  return items.filter((item) => (item.category || item.type) === category).length;
}

function _abilityAssetRecommendationLabel(action) {
  if (action === 'pause') return _cognitionText('cognition.recall_recommend_pause', '建议暂停');
  if (action === 'rework') return _cognitionText('cognition.recall_recommend_rework', '建议重做');
  return action || '';
}

function _abilityAssetScopePolicyLines(policy) {
  if (!policy || typeof policy !== 'object') return [];
  const fields = [
    ['purposeTags', _cognitionText('cognition.scope_policy_purpose_tags', 'Purpose tags')],
    ['agentIds', _cognitionText('cognition.scope_policy_agent_ids', 'Agents')],
    ['roleIds', _cognitionText('cognition.scope_policy_role_ids', 'Roles')],
    ['projectIds', _cognitionText('cognition.scope_policy_project_ids', 'Projects')],
    ['workspaceIds', _cognitionText('cognition.scope_policy_workspace_ids', 'Workspaces')],
    ['conversationKinds', _cognitionText('cognition.scope_policy_conversation_kinds', 'Conversation kinds')],
    ['fileKinds', _cognitionText('cognition.scope_policy_file_kinds', 'File kinds')],
  ];
  return fields.map(([field, label]) => {
    const values = Array.isArray(policy[field]) ? policy[field].filter(Boolean).map(String) : [];
    return values.length ? `${label}: ${values.join(', ')}` : '';
  }).filter(Boolean);
}

function _renderAbilityAssetGovernance(selected) {
  const policyLines = _abilityAssetScopePolicyLines(selected.scopePolicy);
  const policyHtml = policyLines.length
    ? `<div class="reference-strip ability-asset-scope-policy"><strong>${escapeHtml(_cognitionText('cognition.scope_policy', '结构化作用域'))}</strong><p>${escapeHtml(policyLines.join(' · '))}</p></div>`
    : '';
  const recommendationHtml = selected.recommendedAction
    ? `<div class="reference-strip ability-asset-recommendation is-${escapeHtml(selected.recommendedAction)}"><strong>${escapeHtml(_abilityAssetRecommendationLabel(selected.recommendedAction))}</strong><p>${escapeHtml(selected.recommendationReason || _cognitionText('cognition.recall_recommendation_needs_review', '该资产需要用户复核。'))}</p>${selected.recommendationAt ? `<small>${escapeHtml(_cognitionDate(selected.recommendationAt))}</small>` : ''}</div>`
    : '';
  const actions = [];
  if (selected.status === 'active') {
    actions.push(`<button class="btn btn-sm" data-ability-asset-action="pause" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_pause', '暂停'))}</button>`);
    actions.push(`<button class="btn btn-sm btn-danger" data-ability-asset-action="revoke" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_revoke', '撤销'))}</button>`);
  } else if (selected.status === 'paused') {
    actions.push(`<button class="btn btn-sm btn-primary" data-ability-asset-action="resume" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_resume', '恢复'))}</button>`);
    actions.push(`<button class="btn btn-sm btn-danger" data-ability-asset-action="revoke" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_revoke', '撤销'))}</button>`);
  }
  if (selected.recommendedAction && selected.status !== 'revoked') {
    actions.push(`<button class="btn btn-sm btn-primary" data-ability-asset-action="acknowledge-recommendation" data-ability-asset-id="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.asset_acknowledge_recommendation', '确认建议'))}</button>`);
  }
  const actionHtml = actions.length
    ? `<div class="asset-controls ability-asset-governance-actions">${actions.join('')}</div>`
    : `<div class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.asset_no_governance_actions', '该资产当前无可用治理动作。'))}</div>`;
  return `<div class="ability-asset-governance"><div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.asset_governance', '治理状态'))}</strong><p>${escapeHtml(selected.status || 'active')}${selected.recommendedAction ? ` · ${escapeHtml(_abilityAssetRecommendationLabel(selected.recommendedAction))}` : ''}</p></div>${policyHtml}${recommendationHtml}${actionHtml}</div>`;
}

function _abilityAssetDisplayTitle(asset) {
  const title = String(asset?.title || asset?.id || '').trim();
  const scope = String(asset?.scope || '').trim();
  const category = asset?.category || asset?.type;
  if (category === 'skill_method' && title.length > 56 && scope.length >= 8 && scope.length <= 60) return _abilityAssetScopeLabel(scope);
  return title || _abilityAssetScopeLabel(scope);
}

function _abilityAssetContentSummary(asset) {
  const summary = String(asset?.summary || asset?.statement || '').trim();
  if (summary) return summary;
  const title = String(asset?.title || '').trim();
  return title && title !== _abilityAssetDisplayTitle(asset) ? title : '';
}

async function generateRecallSkillFromAsset(assetId) {
  const id = String(assetId || '').trim();
  if (!id) return null;
  const prepared = await window.cogseed.invoke('recall.skills.prepare', { assetId: id });
  if (!prepared?.ok || !prepared.draft) throw new Error(prepared?.error || _cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'));
  const draft = prepared.draft;
  const asset = (_skillsCognitionState.assets || []).find((item) => item.id === id);
  if (draft.status === 'failed') {
    if (asset) {
      asset.recallSkillDraftStatus = 'failed';
      asset.recallSkillDraftErrorCode = draft.errorCode || 'model_failed';
      delete asset.recallSkillDraft;
    }
    renderSkillsCognitionAssets();
    return prepared;
  }
  if (draft.installedSkillId) {
    if (asset) {
      asset.generatedSkillId = draft.installedSkillId;
      delete asset.recallSkillDraftStatus;
      delete asset.recallSkillDraftErrorCode;
      delete asset.recallSkillDraft;
      renderSkillsCognitionAssets();
    }
    return prepared;
  }
  if (asset) {
    asset.recallSkillDraftStatus = 'draft';
    delete asset.recallSkillDraftErrorCode;
    asset.recallSkillDraft = {
      draftHash: draft.draftHash,
      fileCount: Number(draft.fileCount) || 0,
      workflowSteps: Array.isArray(draft.workflowSteps) ? draft.workflowSteps : [],
      validationOk: draft.validation?.ok === true,
      ...(draft.recallContext ? {
        recallContext: {
          assetCount: Number(draft.recallContext.assetCount) || 0,
          sourceCount: Number(draft.recallContext.sourceCount) || 0,
        },
      } : {}),
    };
    renderSkillsCognitionAssets();
  }
  return prepared;
}

async function importRecallSkillFromAsset(assetId) {
  const id = String(assetId || '').trim();
  if (!id) return null;
  let asset = (_skillsCognitionState.assets || []).find((item) => item.id === id);
  if (!asset?.recallSkillDraft?.draftHash) {
    const prepared = await generateRecallSkillFromAsset(id);
    if (prepared?.draft?.status !== 'draft') return prepared;
    asset = (_skillsCognitionState.assets || []).find((item) => item.id === id);
  }
  const draftHash = asset?.recallSkillDraft?.draftHash;
  if (!draftHash) throw new Error(_cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'));
  const confirmed = await window.cogseed.invoke('recall.skills.confirm', { assetId: id, draftHash });
  if (!confirmed?.ok || !confirmed.skill?.id) throw new Error(confirmed?.error || _cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'));
  if (asset) {
    asset.generatedSkillId = confirmed.skill.id;
    delete asset.recallSkillDraftStatus;
    delete asset.recallSkillDraftErrorCode;
    delete asset.recallSkillDraft;
  }
  renderSkillsCognitionAssets();
  if (typeof uiToast === 'function') uiToast(_cognitionText('cognition.skill_created', '已加入技能库'), { variant: 'success' });
  return confirmed;
}

function openRecallSkillModelSettings() {
  _setViewFromSidebar('settings');
  if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
  setTimeout(() => document.getElementById('settings-model-authorizations')?.scrollIntoView({ block: 'start' }), 0);
}

function queueMissingRecallSkillDrafts() {
  // 不再判断"这条是不是真资产"：后端 canonical layer 保证列表里只有四类
  // 正式资产（formal-assets/repository.ts），支撑对象根本进不来。
  const targets = (_skillsCognitionState.assets || []).filter((asset) => (
    asset.category === 'skill_method'
    && asset.status === 'active'
    && !asset.generatedSkillId
    && !asset.recallSkillDraftStatus
    && !_recallSkillDraftAutoPending.has(asset.id)
  ));
  if (!targets.length) return;
  for (const asset of targets) {
    asset.recallSkillDraftStatus = 'generating';
    _recallSkillDraftAutoPending.add(asset.id);
  }
  _recallSkillDraftAutoQueue = _recallSkillDraftAutoQueue.then(async () => {
    for (const asset of targets) {
      try { await generateRecallSkillFromAsset(asset.id); }
      catch (error) {
        const current = (_skillsCognitionState.assets || []).find((item) => item.id === asset.id);
        if (current) {
          current.recallSkillDraftStatus = 'failed';
          current.recallSkillDraftErrorCode = 'model_failed';
          delete current.recallSkillDraft;
        }
        _skillsLog.warn('automatic Recall skill draft request failed', error);
      } finally {
        _recallSkillDraftAutoPending.delete(asset.id);
        renderSkillsCognitionAssets();
      }
    }
  });
}

function _recallSkillDraftErrorLabel(code) {
  const labels = {
    model_not_configured: _cognitionText('cognition.skill_draft_error_model_not_configured', '尚未配置可用模型。'),
    model_auth_required: _cognitionText('cognition.skill_draft_error_model_auth_required', '模型授权已失效，请重新授权。'),
    model_failed: _cognitionText('cognition.skill_draft_error_model_failed', '模型未能完成 Skill 生成。'),
    model_timeout: _cognitionText('cognition.skill_draft_error_model_timeout', 'Skill 生成超时。'),
    invalid_model_output: _cognitionText('cognition.skill_draft_error_invalid_output', '模型返回内容不符合 Skill 提案结构。'),
    level_a_validation_failed: _cognitionText('cognition.skill_draft_error_level_a', '生成结果未通过 Level A 校验。'),
  };
  return labels[code] || _cognitionText('cognition.skill_draft_failed', 'Skill 生成失败');
}

function _cognitionSourceLabel(kind) {
  return _cognitionText(`cognition.source_${kind}`, kind || _cognitionText('cognition.unknown', '未知'));
}

function _cognitionSourceItemLabel(item) {
  if (!item) return _cognitionText('cognition.unknown', '未知');
  if (item.title) return item.title;
  const subtype = _cognitionText(`cognition.source_subtype_${item.subtype}`, item.subtype || 'source');
  return subtype;
}

function _cognitionSourceItemMeta(item, groupKind) {
  if (!item) return '';
  const parts = [];
  const subtype = item.title && item.subtype ? _cognitionText(`cognition.source_subtype_${item.subtype}`, '') : '';
  if (subtype && subtype !== _cognitionSourceLabel(groupKind)) parts.push(subtype);
  if (item.sourceVersion) parts.push(_cognitionDate(item.sourceVersion));
  return parts.join(' · ');
}

function _cognitionSourceStatusLabel(status) {
  const labels = {
    pending: _cognitionText('cognition.source_pending', '待处理'),
    processing: _cognitionText('cognition.source_processing', '处理中'),
    ready: _cognitionText('cognition.source_ready', '可用'),
    failed: _cognitionText('cognition.source_failed', '失败'),
    paused: _cognitionText('cognition.source_paused', '已暂停'),
    empty: _cognitionText('cognition.source_empty', '暂无数据'),
  };
  return labels[status] || status || _cognitionText('cognition.unknown', '未知');
}

function _cognitionSourceReason(reason) {
  if (!reason) return '';
  const fallbacks = {
    conversation_processing: '会话仍在进行，结束后会继续处理',
    file_index_pending: '文件正在等待建立索引',
    file_index_failed: '文件处理失败，可以重试',
    execution_queued: '执行正在等待开始',
    execution_running: '执行仍在进行',
    execution_failed: '执行失败',
    execution_cancelled: '执行已取消',
    execution_timed_out: '执行超时',
    degraded_execution: '执行结果暂时不可用',
    connector_connecting: '连接器正在连接',
    connector_disconnected: '连接器尚未连接',
    connector_degraded: '连接器当前异常，请检查连接',
    connector_error: '连接器连接失败，请重新授权或连接',
    teaching_revoked: '这条教学信号已撤销',
    source_paused: '已暂停后续处理，已有记忆不受影响',
    source_removed: '已从 Recall 移除，原始数据仍然保留',
    source_retry_failed: '重试未成功，请检查来源后再试',
    asset_revoke_partial: '部分关联记忆未能撤销，请重试',
    source_unavailable: '来源暂时无法读取',
  };
  return _cognitionText(`cognition.source_reason_${reason}`, fallbacks[reason] || reason);
}

function _cognitionSourceNextAction(nextAction) {
  const labels = {
    wait: _cognitionText('cognition.source_next_wait', '下一步：等待处理完成'),
    use_source: '',
    retry: _cognitionText('cognition.source_next_retry', '下一步：重试处理'),
    resume: _cognitionText('cognition.source_next_resume', '下一步：恢复来源'),
    reconnect: _cognitionText('cognition.source_next_reconnect', '下一步：重新接入来源'),
    manage_connector: _cognitionText('cognition.source_next_connector', '下一步：检查连接器状态'),
    none: '',
  };
  return labels[nextAction] || '';
}

function _cognitionSourceActionLabel(action) {
  const labels = {
    pause: _cognitionText('cognition.source_action_pause', '暂停'),
    resume: _cognitionText('cognition.source_action_resume', '恢复'),
    retry: _cognitionText('cognition.source_action_retry', '重试'),
    remove: _cognitionText('cognition.source_action_remove', '从 Recall 移除'),
    reconnect: _cognitionText('cognition.source_action_reconnect', '重新接入'),
    manage_connector: _cognitionText('cognition.manage_connectors', '管理连接器'),
  };
  return labels[action] || action;
}

function _cognitionPrimarySourceItems(group) {
  const items = Array.isArray(group?.items) ? group.items : [];
  return items.filter((item) => item.subtype !== 'message' && item.subtype !== 'evaluation');
}

function _cognitionSourceActionButton(action, group, item) {
  if (action === 'manage_connector') {
    return `<button type="button" class="btn btn-sm" data-cognition-open-connectors>${escapeHtml(_cognitionSourceActionLabel(action))}</button>`;
  }
  return `<button type="button" class="btn btn-sm" data-cognition-source-action="${escapeHtml(action)}" data-cognition-source-kind="${escapeHtml(group.kind)}" data-cognition-source-id="${escapeHtml(item.id)}">${escapeHtml(_cognitionSourceActionLabel(action))}</button>`;
}

function _cognitionSourceMoreButton(actions, group, item) {
  if (!actions.length) return '';
  const label = _cognitionText('common.more', '更多');
  const icon = typeof uiIconHtml === 'function' ? uiIconHtml('more-horizontal') : '<span aria-hidden="true">...</span>';
  return `<button type="button" class="btn btn-sm recall-source-more" data-cognition-source-more data-cognition-source-actions="${escapeHtml(actions.join(','))}" data-cognition-source-kind="${escapeHtml(group.kind)}" data-cognition-source-id="${escapeHtml(item.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
}

function _cognitionRelationRefText(ref) {
  const title = ref && typeof ref === 'object' ? String(ref.title || ref.name || '').trim() : '';
  if (title) return title;
  const rawId = ref && typeof ref === 'object' ? String(ref.id || ref.ref || '') : String(ref || '');
  const normalizedId = rawId.includes(':') ? rawId.slice(rawId.indexOf(':') + 1) : rawId;
  const sourceItem = (Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .flatMap((group) => group.items || [])
    .find((item) => item.id === rawId || item.id === normalizedId);
  if (sourceItem?.title) return sourceItem.title;
  const kind = ref && typeof ref === 'object' ? String(ref.kind || ref.type || '') : String(ref || '').split(':')[0];
  const sourceKinds = new Set(['conversation', 'artifact_file', 'execution_evaluation', 'user_teaching_signal', 'authorized_external_system']);
  return sourceKinds.has(kind) ? _cognitionSourceLabel(kind) : _cognitionText('cognition.relation_refs', '关联引用');
}

function _cognitionVisibleSourceCount(groups) {
  return (Array.isArray(groups) ? groups : [])
    .reduce((sum, group) => sum + _cognitionPrimarySourceItems(group).length, 0);
}

function _cognitionLoadFailed(section) {
  return Array.isArray(_skillsCognitionState.loadErrors) && _skillsCognitionState.loadErrors.includes(section);
}

function _conversationCapturePipelineStatus(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const capturesById = new Map();
  for (const capture of [
    ...(Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : []),
    ...(Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : []),
  ]) {
    if (capture?.id && capture.conversationId === id) capturesById.set(capture.id, capture);
  }
  const capture = [...capturesById.values()].sort((left, right) => String(
    right.updatedAt || right.finishedAt || right.createdAt || '',
  ).localeCompare(String(left.updatedAt || left.finishedAt || left.createdAt || '')))[0];
  if (!capture) {
    return { status: 'empty', label: _cognitionText('cognition.source_capture_none', '未沉淀') };
  }
  const status = _captureWorkflowStatus(capture);
  if (['waiting', 'waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'paused'].includes(status)) {
    return { status: 'waiting', label: _cognitionText('cognition.source_capture_waiting', '等待中') };
  }
  if (status === 'extracting' || status === 'writing') {
    return { status: 'processing', label: _cognitionText('cognition.source_capture_processing', '处理中') };
  }
  if (status === 'review_ready') {
    return { status: 'review_ready', label: _cognitionText('cognition.source_capture_review', '待审核') };
  }
  if (status === 'completed') {
    const count = _captureLinkedAssetIds(capture).length;
    return {
      status: 'completed',
      label: _cognitionText('cognition.source_capture_completed', '已形成 {count} 条记忆').replace('{count}', String(count)),
    };
  }
  if (status === 'failed' || status === 'configuration_required') {
    return { status: 'failed', label: _cognitionText('cognition.source_capture_failed', '沉淀失败') };
  }
  return { status: 'empty', label: _cognitionText('cognition.source_capture_none', '未沉淀') };
}

function _renderCognitionSourceStatus() {
  const sources = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const visibleSources = sources.filter((source) => _cognitionPrimarySourceItems(source).length > 0 || source.status === 'failed');
  const body = visibleSources.length
    ? visibleSources.map((source) => `<span class="skills-cognition-source-state is-${escapeHtml(source.status || 'empty')}"><b>${escapeHtml(_cognitionSourceLabel(source.kind))}</b><em>${escapeHtml(String(_cognitionPrimarySourceItems(source).length))} · ${escapeHtml(_cognitionSourceStatusLabel(source.status))}</em></span>`).join('')
    : `<span class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.sources_empty', '尚未发现可接入的数据来源'))}</span>`;
  return `<section class="skills-cognition-flow-band recall-overview-panel recall-overview-sources"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.source_status', '数据来源'))}</h2><span>${escapeHtml(_cognitionText('cognition.source_status_hint', '当前可用于形成认知候选的来源'))}</span></div><div class="skills-cognition-source-row">${body}</div></section>`;
}

function renderSkillsCognitionSources() {
  const host = document.getElementById('skills-cognition-sources-body');
  if (!host) return;
  if (_cognitionLoadFailed('sources')) {
    host.innerHTML = `<div class="skills-cognition-warning"><span>${escapeHtml(_cognitionText('cognition.sources_load_failed', '数据来源读取失败'))}</span><button class="btn btn-sm" data-cognition-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`;
    return;
  }
  const groups = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const visibleGroups = groups.filter((group) => _cognitionPrimarySourceItems(group).length > 0 || group.status === 'failed');
  const sourceItems = visibleGroups.flatMap(_cognitionPrimarySourceItems);
  const total = sourceItems.length;
  const ready = sourceItems.filter((item) => item.status === 'ready').length;
  const needsAttention = sourceItems.filter((item) => item.status === 'failed' || item.status === 'paused').length;
  const summary = visibleGroups.length ? [
    ['cognition.source_visible_items', '当前可见', total],
    ['cognition.source_ready_groups', '可用来源', ready],
    ['cognition.source_degraded_groups', '需关注', needsAttention],
  ].map(([key, fallback, value]) => `<div><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(_cognitionText(key, fallback))}</span></div>`).join('') : '';
  const body = visibleGroups.length ? visibleGroups.map((group) => {
    const items = _cognitionPrimarySourceItems(group);
    const rows = items.length ? items.map((item) => {
      const openConversation = group.kind === 'conversation' && item.subtype === 'session'
        ? `<button type="button" class="btn btn-sm" data-cognition-source-conversation="${escapeHtml(item.id)}">${escapeHtml(_cognitionText('cognition.open_conversation', '打开会话'))}</button>` : '';
      const itemActions = Array.isArray(item.actions) ? item.actions : [];
      const menuActions = itemActions.filter((action) => action === 'pause' || action === 'remove');
      const directActions = itemActions.filter((action) => !menuActions.includes(action)).map((action) => _cognitionSourceActionButton(action, group, item)).join('');
      const actions = `${directActions}${_cognitionSourceMoreButton(menuActions, group, item)}`;
      const reason = _cognitionSourceReason(item.statusReason);
      const next = _cognitionSourceNextAction(item.nextAction);
      const meta = _cognitionSourceItemMeta(item, group.kind);
      const pipelineStatus = group.kind === 'conversation' && item.subtype === 'session'
        ? _conversationCapturePipelineStatus(item.id)
        : null;
      const visibleStatus = pipelineStatus?.status || item.status || 'ready';
      const visibleStatusLabel = pipelineStatus?.label || _cognitionSourceStatusLabel(item.status);
      return `<article class="recall-source-item">
        <div class="recall-source-item-main"><strong>${escapeHtml(_cognitionSourceItemLabel(item))}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}${reason ? `<small>${escapeHtml(reason)}</small>` : ''}${next ? `<small class="recall-source-next">${escapeHtml(next)}</small>` : ''}</div>
        <span class="skills-cognition-status is-${escapeHtml(visibleStatus)}">${escapeHtml(visibleStatusLabel)}</span>
        ${openConversation || actions ? `<div class="recall-source-item-actions">${openConversation}${actions}</div>` : ''}
      </article>`;
    }).join('') : `<div class="recall-workbench-empty">${escapeHtml(_cognitionText('cognition.source_no_items', '当前没有可显示的数据'))}</div>`;
    const groupReason = _cognitionSourceReason(group.reason);
    const groupHead = `<div><h2>${escapeHtml(_cognitionSourceLabel(group.kind))}</h2><p>${escapeHtml(groupReason || _cognitionText(`cognition.source_hint_${group.kind}`, ''))}</p></div><span class="skills-cognition-status is-${escapeHtml(group.status || 'empty')}">${escapeHtml(String(items.length))} · ${escapeHtml(_cognitionSourceStatusLabel(group.status))}</span>`;
    if (group.kind === 'execution_evaluation') {
      return `<details class="recall-source-group recall-source-group-advanced"><summary class="recall-workbench-section-head">${groupHead}</summary><div class="recall-source-items">${rows}</div></details>`;
    }
    return `<section class="recall-source-group"><div class="recall-workbench-section-head">${groupHead}</div><div class="recall-source-items">${rows}</div></section>`;
  }).join('') : `<div class="recall-workbench-empty-state">
    <strong>${escapeHtml(_cognitionText('cognition.sources_empty', '尚未发现可接入的数据来源'))}</strong>
    <span>${escapeHtml(_cognitionText('cognition.pipeline_next_conversation', '下一步：完成一轮会话，系统会自动整理内容'))}</span>
    <button type="button" class="btn btn-sm" data-cognition-page-link="captures">${escapeHtml(_cognitionText('cognition.capture_tasks', '沉淀任务'))}</button>
  </div>`;
  host.innerHTML = `<div class="recall-workbench-page-head"><div><h2>${escapeHtml(_cognitionText('cognition.sources', '数据来源'))}</h2><p>${escapeHtml(_cognitionText('cognition.sources_page_hint', '会话、文件、执行、教学信号与已授权系统'))}</p></div></div>${summary ? `<div class="recall-workbench-summary">${summary}</div>` : ''}<div class="recall-source-groups">${body}</div>`;
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
      const workflowStatus = _captureWorkflowStatus(capture);
      const action = workflowStatus === 'review_ready'
        ? _captureActionButton(capture, 'view-candidates', 'cognition.capture_review_action', '审核候选')
        : workflowStatus === 'completed' && _captureLinkedAssetIds(capture).length
          ? _captureActionButton(capture, 'view-assets', 'cognition.capture_view_assets', '查看记忆')
          : workflowStatus === 'failed' && capture.status !== 'configuration_required'
          ? `<button class="btn btn-sm" data-recall-capture-retry="${escapeHtml(capture.id)}">${escapeHtml(_cognitionText('common.retry', '重试'))}</button>`
          : capture.status === 'configuration_required'
            ? `<button class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button>`
            : '';
      const reviewSummary = _captureReviewSummary(capture);
      const unresolvedCount = reviewSummary.pending + reviewSummary.deferred + reviewSummary.missing;
      const stageDetail = workflowStatus === 'review_ready'
        ? _cognitionText('cognition.capture_candidates_ready', '{count} 个候选待审核').replace('{count}', String(unresolvedCount))
        : workflowStatus === 'completed'
          ? _captureCompletionDetail(capture)
          : _captureNextActionText(capture);
      const detail = capture.recoveredAt && (capture.status === 'queued' || capture.status === 'extracting')
        ? `${_cognitionText('cognition.capture_recovered', '已恢复处理')} · ${stageDetail}`
        : stageDetail;
      return `<div class="skills-cognition-capture-row"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)} · ${escapeHtml(_cognitionDate(capture.updatedAt))}</span></div><span class="skills-cognition-status is-${escapeHtml(workflowStatus)}">${escapeHtml(_cognitionStatusLabel(workflowStatus))}</span>${action}</div>`;
    }).join('')
    : _renderCognitionEmpty(_cognitionText('cognition.captures_empty', '完成一轮会话后，沉淀状态会显示在这里'));
  const summary = [
    ['waiting', 'cognition.capture_filter_waiting', '待处理'],
    ['processing', 'cognition.capture_filter_processing', '处理中'],
    ['review', 'cognition.capture_filter_review', '待审核'],
    ['failed', 'cognition.capture_filter_failed', '失败'],
  ].filter(([key]) => Number(counts[key] || 0) > 0)
    .map(([key, labelKey, fallback]) => `<span><b>${escapeHtml(String(counts[key] || 0))}</b>${escapeHtml(_cognitionText(labelKey, fallback))}</span>`).join('');
  return `<section class="skills-cognition-flow-band recall-overview-panel recall-overview-captures"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.capture_status', '会话沉淀'))}</h2><span>${escapeHtml(_cognitionText('cognition.capture_status_hint', '查看当前进度和下一步操作'))}</span></div>${summary ? `<div class="recall-capture-overview-counts">${summary}</div>` : ''}<div class="skills-cognition-capture-list">${rows}</div></section>`;
}

const _CAPTURE_FILTERS = ['all', 'waiting', 'processing', 'review', 'failed', 'completed', 'cancelled'];

function _captureNextActionText(capture) {
  const actions = {
    wait_quiet: _cognitionText('cognition.capture_next_wait_quiet', '下一步：等待静默期结束'),
    complete_conversation: _cognitionText('cognition.capture_next_complete_conversation', '下一步：完成当前会话'),
    run_now: _cognitionText('cognition.capture_next_run_now', '下一步：等待手动执行'),
    wait_nightly: _cognitionText('cognition.capture_next_wait_nightly', '下一步：等待夜间窗口'),
    wait_processing: _cognitionText('cognition.capture_next_wait_processing', '下一步：等待提炼完成'),
    resume: _cognitionText('cognition.capture_next_resume', '下一步：继续已暂停的任务'),
    review_candidates: _cognitionText('cognition.capture_next_review_candidates', '下一步：审核候选'),
    configure_model: _cognitionText('cognition.capture_next_configure_model', '下一步：配置模型后重试'),
    retry: _cognitionText('cognition.capture_next_retry', '下一步：重试本次沉淀'),
    view_assets: _cognitionText('cognition.capture_next_view_assets', '已完成：查看写入的记忆'),
    none: _cognitionText('cognition.capture_next_none', '已完成：无需后续操作'),
  };
  if (capture?.nextAction && actions[capture.nextAction]) return actions[capture.nextAction];
  const status = _captureWorkflowStatus(capture);
  if (status === 'completed') return _captureLinkedAssetIds(capture).length ? actions.view_assets : actions.none;
  if (status === 'review_ready') return actions.review_candidates;
  if (status === 'failed') return actions.retry;
  if (capture?.status === 'configuration_required') return actions.configure_model;
  if (status === 'paused') return actions.resume;
  if (status === 'waiting_completion') return actions.complete_conversation;
  if (status === 'waiting_quiet') return actions.wait_quiet;
  return actions.wait_processing;
}

function _captureCompletionDetail(capture) {
  const summary = _captureReviewSummary(capture);
  if (!summary.total) return _cognitionText('cognition.capture_no_candidate_detail', '未发现有明确长期价值的用户信息，未写入记忆');
  if (capture?.autoWrite) {
    return _cognitionText('cognition.capture_auto_completed_detail', '已写入记忆：{promoted} 条，{rejected} 条未写入')
      .replace('{promoted}', String(summary.promoted))
      .replace('{rejected}', String(summary.rejected));
  }
  return _cognitionText('cognition.capture_review_completed_detail', '候选审核已完成：{promoted} 个已入库，{rejected} 个已拒绝')
    .replace('{promoted}', String(summary.promoted))
    .replace('{rejected}', String(summary.rejected));
}

function _captureAssetReceiptDetail(capture) {
  const receipts = _captureConfirmedAssetReceipts(capture);
  if (!receipts.length) return '';
  const notRecorded = _cognitionText('cognition.not_recorded', '未记录');
  const rows = receipts.map((receipt) => {
    const type = receipt.assetType ? _abilityAssetCategoryLabel(receipt.assetType) : notRecorded;
    const version = receipt.version || notRecorded;
    const scope = receipt.scope ? _abilityAssetScopeLabel(receipt.scope) : notRecorded;
    const decision = receipt.reviewDecisionId || notRecorded;
    return `<article class="recall-capture-asset-receipt">
      <div class="recall-capture-asset-receipt-head"><span><b>asset_id</b><code>${escapeHtml(receipt.assetId)}</code></span><em>${escapeHtml(type)}</em></div>
      <dl>
        <div><dt>${escapeHtml(_cognitionText('cognition.version', '版本'))}</dt><dd>${escapeHtml(version)}</dd></div>
        <div><dt>${escapeHtml(_cognitionText('cognition.scope', '作用域'))}</dt><dd>${escapeHtml(scope)}</dd></div>
        <div><dt>${escapeHtml(_cognitionText('cognition.source_refs', '来源引用'))}</dt><dd>${escapeHtml(String(receipt.sourceRefCount))}</dd></div>
        <div class="is-decision"><dt>review_decision_id</dt><dd><code>${escapeHtml(decision)}</code></dd></div>
      </dl>
      <button type="button" class="btn btn-sm" data-recall-open-asset="${escapeHtml(receipt.assetId)}">${escapeHtml(_cognitionText('cognition.capture_view_assets', '查看记忆'))}</button>
    </article>`;
  }).join('');
  return `<section class="recall-capture-asset-receipts" aria-label="${escapeHtml(_cognitionText('cognition.formal_assets', '正式资产'))}">
    <div class="recall-capture-asset-receipts-head"><strong>${escapeHtml(_cognitionText('cognition.formal_assets', '正式资产'))}</strong><span>${escapeHtml(String(receipts.length))}</span></div>
    <div class="recall-capture-asset-receipts-list">${rows}</div>
  </section>`;
}

function _captureStatusesForFilter(filter) {
  const groups = {
    waiting: ['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'paused'],
    processing: ['extracting', 'writing'],
    review: ['review_ready'],
    failed: ['failed'],
    completed: ['completed'],
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
    asset_write: _cognitionText('cognition.capture_stage_asset_write', '写入 Recall'),
  };
  return labels[stage] || '';
}

function _captureErrorLabel(code, capture) {
  const labels = {
    model_not_configured: _cognitionText('cognition.capture_error_model_not_configured', '尚未配置可用模型'),
    model_auth_required: _cognitionText('cognition.capture_error_model_auth_required', '模型授权已失效，请重新授权'),
    source_unavailable: _cognitionText('cognition.capture_error_source_unavailable', '原会话内容暂时无法读取'),
    recall_view_failed: _cognitionText('cognition.capture_error_recall_view_failed', 'RecallView 构建失败'),
    model_failed: _cognitionText('cognition.capture_error_model_failed', '模型提取未成功完成'),
    invalid_model_output: _cognitionText('cognition.capture_error_invalid_model_output', '模型返回内容无法解析'),
    candidate_save_failed: _cognitionText('cognition.capture_error_candidate_save_failed', 'Candidate 保存失败'),
    asset_write_failed: capture?.autoWrite
      ? _cognitionText('cognition.capture_error_auto_write_failed', '自动写入记忆失败，请重试本次沉淀')
      : _cognitionText('cognition.capture_error_asset_write_failed', '审核内容写入 Recall 失败，请重试审核'),
    asset_write_interrupted: _cognitionText('cognition.capture_error_asset_write_interrupted', '写入被应用重启中断，已恢复到待审核'),
    conversation_failed: _cognitionText('cognition.capture_error_conversation_failed', '会话未成功完成，请手动决定是否沉淀'),
    conversation_cancelled: _cognitionText('cognition.capture_error_conversation_cancelled', '会话已取消，请手动决定是否沉淀'),
    capture_failed: _cognitionText('cognition.capture_error_unknown', '沉淀任务发生未知错误'),
  };
  return labels[code] || labels.capture_failed;
}

function _captureActionButton(capture, action, key, fallback, primary = false, danger = false) {
  const cls = danger ? 'btn-danger' : primary ? 'btn-primary' : '';
  return `<button type="button" class="btn btn-sm ${cls}" data-recall-capture-action="${escapeHtml(action)}" data-recall-capture-id="${escapeHtml(capture.id)}">${escapeHtml(_cognitionText(key, fallback))}</button>`;
}

function _captureTaskActions(capture) {
  const actions = [];
  const workflowStatus = _captureWorkflowStatus(capture);
  const linkedAssetIds = _captureLinkedAssetIds(capture);
  const finalizing = capture.status === 'extracting' && capture.stage === 'candidate_save';
  const actionContract = Array.isArray(capture.actions) ? new Set(capture.actions) : null;
  const allows = (action, fallback) => actionContract ? actionContract.has(action) : fallback;
  if (allows('run_now', ['waiting_quiet', 'waiting_manual', 'scheduled', 'paused'].includes(capture.status))) {
    actions.push(_captureActionButton(capture, 'run-now', 'cognition.capture_run_now', '立即执行', true));
  }
  if (allows('configure_model', capture.status === 'configuration_required')) {
    actions.push(`<button type="button" class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button>`);
  }
  if (allows('retry', workflowStatus === 'failed' || workflowStatus === 'configuration_required')) {
    actions.push(_captureActionButton(capture, 'retry', 'common.retry', '重试', true));
  }
  if (allows('pause', false)) {
    actions.push(_captureActionButton(capture, 'pause', 'cognition.capture_pause', '暂停'));
  }
  if (allows('resume', capture.status === 'paused')) {
    actions.push(_captureActionButton(capture, 'resume', 'cognition.capture_resume', '继续', true));
  }
  if (allows('cancel', ['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'paused'].includes(capture.status) && !finalizing)) {
    actions.push(_captureActionButton(capture, 'cancel', 'cognition.capture_cancel', '取消', false, true));
  }
  if (allows('view_assets', workflowStatus === 'completed' && linkedAssetIds.length > 0)) {
    actions.push(_captureActionButton(capture, 'view-assets', 'cognition.capture_view_assets', '查看记忆', true));
  } else {
    if (allows('review_candidates', (capture.candidateIds || []).length > 0)) {
      actions.push(_captureActionButton(capture, 'view-candidates', 'cognition.capture_view_candidates', '查看候选', workflowStatus === 'review_ready'));
    }
    if (!actionContract && linkedAssetIds.length) {
      actions.push(_captureActionButton(capture, 'view-assets', 'cognition.capture_view_assets', '查看记忆'));
    }
  }
  if (allows('open_conversation', workflowStatus !== 'completed')) {
    actions.push(_captureActionButton(capture, 'open-conversation', 'cognition.capture_open_conversation', '打开会话'));
  }
  return actions.join('');
}

function _captureTaskDetail(capture) {
  if (_skillsCognitionState.selectedCaptureId !== capture.id) return '';
  const reviewSummary = _captureReviewSummary(capture);
  const taskMeta = `<div class="recall-capture-task-meta"><span><b>${escapeHtml(_cognitionText('cognition.capture_execution_policy', '执行时机'))}</b>${escapeHtml(_capturePolicyLabel(capture.executionPolicy))}${capture.stage ? ` · ${escapeHtml(_captureStageLabel(capture.stage))}` : ''}</span><span><b>${escapeHtml(_cognitionText('cognition.candidate_count', '候选'))}</b>${escapeHtml(String(reviewSummary.total))}</span></div>`;
  const timeline = [
    [_cognitionText('cognition.capture_scheduled_for', '计划执行'), capture.scheduledFor],
    [_cognitionText('cognition.capture_started_at', '开始'), capture.startedAt],
    [_cognitionText('cognition.capture_finished_at', '结束'), capture.finishedAt],
  ].filter((item) => item[1]).map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(_cognitionDate(value))}</span>`).join('');
  const error = capture.errorCode
    ? `<div class="recall-capture-task-error"><b>${escapeHtml(_cognitionText('cognition.capture_error', '失败原因'))}</b><span>${escapeHtml(_captureErrorLabel(capture.errorCode, capture))}</span></div>`
    : '';
  const workflowStatus = _captureWorkflowStatus(capture);
  const reviewMetrics = workflowStatus !== 'completed' && reviewSummary.total ? `<div class="recall-capture-review-summary">
    ${reviewSummary.promoted ? `<span><b>${escapeHtml(_cognitionText('cognition.candidate_status_promoted', '已确认入库'))}</b>${escapeHtml(String(reviewSummary.promoted))}</span>` : ''}
    ${reviewSummary.pending + reviewSummary.deferred ? `<span><b>${escapeHtml(_cognitionText('cognition.candidate_status_pending', '需要确认'))}</b>${escapeHtml(String(reviewSummary.pending + reviewSummary.deferred))}</span>` : ''}
    ${reviewSummary.rejected ? `<span><b>${escapeHtml(_cognitionText('cognition.candidate_status_rejected', '已忽略'))}</b>${escapeHtml(String(reviewSummary.rejected))}</span>` : ''}
  </div>` : '';
  const recovered = capture.recoveredAt
    ? `<div class="recall-capture-task-feedback is-recovered">${escapeHtml(_cognitionText('cognition.capture_recovered_detail', '应用重启后已恢复该任务，将继续原流程。'))}</div>`
    : '';
  const completion = workflowStatus === 'completed'
    ? `<div class="recall-capture-task-feedback is-completed">${escapeHtml(_captureCompletionDetail(capture))}</div>`
    : '';
  const receipts = _captureAssetReceiptDetail(capture);
  return `<div class="recall-capture-task-detail">
    ${taskMeta}
    <div class="recall-capture-task-timeline">${timeline}</div>
    ${reviewMetrics}
    ${recovered}
    ${completion}
    ${receipts}
    ${error}
    ${workflowStatus === 'completed' ? '' : `<div class="recall-capture-next-action"><span>${escapeHtml(_captureNextActionText(capture))}</span></div>`}
    <div class="skills-cognition-actions">${_captureTaskActions(capture)}</div>
  </div>`;
}

function _renderCaptureSettings() {
  const settings = _skillsCognitionState.captureSettings || {
    enabled: true, executionPolicy: 'smart', reviewPolicy: 'auto', quietMinutes: 10, nightlyStart: '02:00', nightlyEnd: '06:00', catchUpMissed: true,
  };
  const model = _skillsCognitionState.captureModel || {};
  const modelReady = !!model.configured && !model.authorizationRequired;
  const modelName = [model.provider, model.model].filter(Boolean).join(' · ')
    || (model.configured
      ? _cognitionText('cognition.capture_model_default', '默认模型')
      : _cognitionText('cognition.capture_model_unconfigured', '尚未配置模型'));
  const policies = ['smart', 'nightly', 'manual'].map((policy) => `<button type="button" class="recall-capture-policy${settings.executionPolicy === policy ? ' is-active' : ''}" data-recall-capture-policy="${policy}" aria-pressed="${settings.executionPolicy === policy ? 'true' : 'false'}" ${settings.enabled ? '' : 'disabled'}>${escapeHtml(_capturePolicyLabel(policy))}</button>`).join('');
  const reviewPolicy = settings.reviewPolicy === 'manual' ? 'manual' : 'auto';
  const reviewPolicies = ['auto', 'manual'].map((policy) => `<button type="button" class="recall-capture-policy${reviewPolicy === policy ? ' is-active' : ''}" data-recall-review-policy="${policy}" aria-pressed="${reviewPolicy === policy ? 'true' : 'false'}" ${settings.enabled ? '' : 'disabled'}>${escapeHtml(_cognitionText(`cognition.capture_review_policy_${policy}`, policy === 'auto' ? '自动入库' : '集中确认'))}</button>`).join('');
  const quietMinutes = Number.isInteger(settings.quietMinutes) ? settings.quietMinutes : 10;
  const quietOptions = [...new Set([5, 10, 30, quietMinutes])].sort((left, right) => left - right)
    .map((minutes) => `<option value="${minutes}" ${quietMinutes === minutes ? 'selected' : ''}>${escapeHtml(_cognitionText('cognition.capture_quiet_minutes_option', '{count} 分钟').replace('{count}', String(minutes)))}</option>`).join('');
  const expanded = _skillsCognitionState.captureSettingsExpanded === true;
  const enabledLabel = settings.enabled
    ? _cognitionText('common.enabled', '已开启')
    : _cognitionText('common.disabled', '已关闭');
  const reviewLabel = _cognitionText(
    `cognition.capture_review_policy_${reviewPolicy}`,
    reviewPolicy === 'auto' ? '自动入库' : '集中确认',
  );
  const modelWarning = modelReady ? '' : `<div class="recall-capture-model-state is-compact"><div><label>${escapeHtml(_cognitionText('cognition.capture_model', '沉淀模型'))}</label><strong>${escapeHtml(modelName)}</strong><span class="skills-cognition-status is-configuration_required">${escapeHtml(_cognitionText('cognition.capture_configuration_required', '需要配置模型'))}</span></div><button type="button" class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button></div>`;
  return `<section class="recall-capture-control-panel${expanded ? ' is-expanded' : ''}">
    <div class="recall-capture-control-summary">
      <div><h2>${escapeHtml(_cognitionText('cognition.capture_control_title', '沉淀控制'))}</h2><span>${escapeHtml([enabledLabel, _capturePolicyLabel(settings.executionPolicy), reviewLabel].join(' · '))}</span></div>
      <button type="button" class="btn btn-sm recall-capture-settings-toggle" data-recall-capture-settings-toggle aria-expanded="${expanded ? 'true' : 'false'}">${escapeHtml(expanded ? _cognitionText('common.close', '收起') : _cognitionText('cognition.capture_settings_action', '设置'))}</button>
    </div>
    ${modelWarning}
    <div class="recall-capture-control-expanded" ${expanded ? '' : 'hidden'}>
      <div class="recall-capture-control-head">
        <span>${escapeHtml(_cognitionText('cognition.capture_trigger_fixed', '会话完成后先等待静默；继续对话会自动顺延'))}</span>
        <label class="recall-capture-master"><input type="checkbox" data-recall-capture-enabled ${settings.enabled ? 'checked' : ''}><span>${escapeHtml(enabledLabel)}</span></label>
      </div>
      <div class="recall-capture-control-grid">
      <div class="recall-capture-control-field"><label>${escapeHtml(_cognitionText('cognition.capture_execution_policy', '执行时机'))}</label><div class="recall-capture-policy-group" role="group">${policies}</div></div>
      <div class="recall-capture-control-field"><label>${escapeHtml(_cognitionText('cognition.capture_review_policy', '写入方式'))}</label><div class="recall-capture-policy-group is-review" role="group">${reviewPolicies}</div><span>${escapeHtml(_cognitionText(`cognition.capture_review_policy_${reviewPolicy}_hint`, reviewPolicy === 'auto' ? '提取完成后，合格内容会自动写入记忆，可在记忆内容中查看或撤回。' : '先整理候选，确认后才会写入记忆。'))}</span></div>
      <div class="recall-capture-control-field recall-capture-quiet-window" ${settings.executionPolicy === 'smart' ? '' : 'hidden'}><label>${escapeHtml(_cognitionText('cognition.capture_quiet_period', '静默等待'))}</label><select data-recall-capture-quiet-minutes ${settings.enabled ? '' : 'disabled'}>${quietOptions}</select><span>${escapeHtml(_cognitionText('cognition.capture_quiet_hint', '期间继续对话会重新计时'))}</span></div>
      <div class="recall-capture-control-field recall-capture-night-window" ${settings.executionPolicy === 'nightly' ? '' : 'hidden'}><label>${escapeHtml(_cognitionText('cognition.capture_nightly_window', '夜间窗口'))}</label><div><input type="time" data-recall-capture-night-start value="${escapeHtml(settings.nightlyStart)}" ${settings.enabled ? '' : 'disabled'}><span>–</span><input type="time" data-recall-capture-night-end value="${escapeHtml(settings.nightlyEnd)}" ${settings.enabled ? '' : 'disabled'}></div><label class="recall-capture-check"><input type="checkbox" data-recall-capture-catch-up ${settings.catchUpMissed ? 'checked' : ''} ${settings.enabled ? '' : 'disabled'}>${escapeHtml(_cognitionText('cognition.capture_catch_up', '错过后空闲补跑'))}</label></div>
      </div>
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
  const visibleCaptures = [...(Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : []), ...(Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [])];
  const latestCaptureByConversation = new Map();
  for (const capture of visibleCaptures) {
    const current = latestCaptureByConversation.get(capture.conversationId);
    if (!current || String(capture.updatedAt || '').localeCompare(String(current.updatedAt || '')) > 0) {
      latestCaptureByConversation.set(capture.conversationId, capture);
    }
  }
  const rows = conversations.length ? conversations.map((conversation) => {
    const capture = latestCaptureByConversation.get(conversation.id);
    const sourceVersion = Date.parse(conversation.sourceVersion || '');
    const captureVersion = Date.parse(capture?.lastActivityAt || capture?.finishedAt || capture?.updatedAt || '');
    const currentSnapshot = Boolean(capture && (
      !Number.isFinite(sourceVersion)
      || !Number.isFinite(captureVersion)
      || captureVersion >= sourceVersion
    ));
    const conversationBusy = conversation.status === 'processing';
    const status = currentSnapshot ? String(capture?.status || '') : '';
    const workflowStatus = currentSnapshot ? _captureWorkflowStatus(capture) : '';
    const processing = Boolean(currentSnapshot && (
      ['queued', 'extracting', 'writing'].includes(status)
      || ['queued', 'extracting', 'writing'].includes(workflowStatus)
    ));
    const noCandidate = Boolean(currentSnapshot && status === 'no_candidate');
    const completed = Boolean(currentSnapshot && !noCandidate && (status === 'completed' || workflowStatus === 'completed'));
    const existingActionLabels = {
      waiting_manual: _cognitionText('cognition.capture_run_now', '去执行'),
      waiting_quiet: _cognitionText('cognition.capture_manual_history_view_waiting', '查看等待任务'),
      waiting_completion: _cognitionText('cognition.capture_manual_history_view_waiting', '查看等待任务'),
      scheduled: _cognitionText('cognition.capture_manual_history_view_waiting', '查看等待任务'),
      review_ready: _cognitionText('cognition.capture_review_action', '去审核'),
      configuration_required: _cognitionText('cognition.capture_configure_action', '去配置'),
      failed: _cognitionText('common.retry', '去重试'),
      paused: _cognitionText('cognition.capture_resume', '去恢复'),
    };
    const existingStatus = existingActionLabels[status] ? status : workflowStatus;
    const existingActionLabel = currentSnapshot && status !== 'cancelled'
      ? existingActionLabels[existingStatus] || _cognitionText('cognition.capture_manual_history_view_task', '查看任务')
      : '';
    const linkedAssetCount = currentSnapshot ? _captureLinkedAssetIds(capture).length : 0;
    const openExisting = Boolean(currentSnapshot && existingActionLabel && !processing && !completed && !noCandidate);
    const createNew = !currentSnapshot || status === 'cancelled';
    const sourceUnavailable = createNew && (
      conversation.availability === 'paused'
      || conversation.availability === 'removed'
      || conversation.status === 'paused'
    );
    const state = processing
      ? `<span class="skills-cognition-status is-processing" aria-live="polite">${escapeHtml(_cognitionText('cognition.capture_manual_history_processing', '正在提取'))}</span>`
      : noCandidate
        ? `<span class="skills-cognition-status is-completed">${escapeHtml(_cognitionText('cognition.capture_manual_history_no_write', '无需写入'))}</span>`
        : completed
          ? linkedAssetCount
            ? `<span class="skills-cognition-status is-completed">${escapeHtml(_cognitionText('cognition.capture_manual_history_written', '已写入记忆'))}</span>`
            : `<span class="skills-cognition-status is-completed">${escapeHtml(_cognitionText('cognition.capture_manual_history_no_write', '无需写入'))}</span>`
          : openExisting
            ? `<span class="recall-manual-conversation-action">${escapeHtml(existingActionLabel)}</span>`
            : sourceUnavailable
              ? `<span class="skills-cognition-status is-paused">${escapeHtml(_cognitionText('cognition.source_paused', '已暂停'))}</span>`
            : conversationBusy
              ? `<span class="skills-cognition-status is-waiting">${escapeHtml(_cognitionText('cognition.capture_waiting_completion', '等待会话完成'))}</span>`
              : `<span class="recall-manual-conversation-action">${escapeHtml(_cognitionText('cognition.capture_manual_history_create', '提取并写入记忆'))}</span>`;
    const actionAttribute = openExisting
      ? `data-recall-manual-open="${escapeHtml(capture.id)}"`
      : `data-recall-manual-add="${escapeHtml(conversation.id)}"`;
    const disabled = processing || completed || noCandidate || sourceUnavailable
      || (conversationBusy && !openExisting) || (createNew && !settings.enabled);
    return `<button type="button" class="recall-manual-conversation${currentSnapshot && status !== 'cancelled' ? ' is-added' : ''}" ${actionAttribute} ${disabled ? 'disabled' : ''}>
      <span class="recall-manual-conversation-main"><strong>${escapeHtml(conversation.title || conversation.id)}</strong><small>${escapeHtml(_cognitionDate(conversation.sourceVersion))}</small></span>
      ${state}
    </button>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.capture_manual_history_empty', '暂无可选择的历史会话'));
  return `<section class="recall-manual-history">
    <div class="recall-manual-history-head">
      <div><h2>${escapeHtml(_cognitionText('cognition.capture_manual_history_title', '提取历史会话'))}</h2><p>${escapeHtml(_cognitionText('cognition.capture_manual_history_hint', '点击后立即提取；仅明确且可复用的内容会自动写入记忆。'))}</p></div>
    </div>
    <div class="recall-manual-history-source">${escapeHtml(_cognitionText('cognition.capture_manual_history_source', 'CogSeed 历史会话'))}</div>
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
  const filters = _CAPTURE_FILTERS.filter((filter) => filter === 'all' || filter === _skillsCognitionState.captureFilter || Number(countValues[filter] || 0) > 0)
    .map((filter) => `<button type="button" class="recall-capture-filter${_skillsCognitionState.captureFilter === filter ? ' is-active' : ''}" data-recall-capture-filter="${filter}"><span>${escapeHtml(_captureFilterLabel(filter))}</span><b>${escapeHtml(String(countValues[filter] || 0))}</b></button>`).join('');
  const rows = captures.length ? captures.map((capture) => {
    const workflowStatus = _captureWorkflowStatus(capture);
    const title = capture.conversationTitle || conversationTitles.get(capture.conversationId) || capture.conversationId;
    const selected = _skillsCognitionState.selectedCaptureId === capture.id ? ' is-selected' : '';
    return `<article class="recall-capture-task${selected}" data-recall-capture-task="${escapeHtml(capture.id)}">
      <button type="button" class="recall-capture-task-summary" data-recall-capture-select="${escapeHtml(capture.id)}" aria-expanded="${selected ? 'true' : 'false'}">
        <span class="recall-capture-task-main"><strong>${escapeHtml(title)}</strong></span>
        <span class="skills-cognition-status is-${escapeHtml(workflowStatus)}">${escapeHtml(_cognitionStatusLabel(workflowStatus))}</span>
        <span class="recall-capture-task-time">${escapeHtml(_cognitionDate(capture.updatedAt))}</span>
      </button>${_captureTaskDetail(capture)}
    </article>`;
  }).join('') : `<div class="recall-capture-empty"><strong>${escapeHtml(_cognitionText('cognition.capture_tasks_empty', '暂无沉淀任务'))}</strong><span>${escapeHtml(_cognitionText('cognition.capture_tasks_empty_hint', '完成一轮会话后，系统会在静默期结束后创建沉淀任务。'))}</span></div>`;
  const more = _skillsCognitionState.captureNextCursor
    ? `<button type="button" class="btn btn-sm recall-capture-load-more" data-recall-capture-load-more>${escapeHtml(_cognitionText('common.load_more', '加载更多'))}</button>`
    : '';
  host.innerHTML = `${_renderCaptureSettings()}${_renderManualConversationPicker()}<section class="recall-capture-task-workbench"><div class="recall-capture-filter-bar">${filters}</div><div class="recall-capture-task-list">${rows}</div>${more}</section>`;
  renderSkillsCognitionCandidates();
}

async function loadRecallCaptureTasks(options = {}) {
  const append = options.append === true;
  const filter = _skillsCognitionState.captureFilter || 'all';
  const requestId = ++_skillsCognitionCaptureRequestId;
  _skillsCognitionCaptureRequestsInFlight += 1;
  const statuses = _captureStatusesForFilter(filter);
  const payload = { limit: 25 };
  if (statuses.length) payload.statuses = statuses;
  if (append && _skillsCognitionState.captureNextCursor) payload.cursor = _skillsCognitionState.captureNextCursor;
  try {
    const result = await window.cogseed.invoke('recall.captures.list', payload);
    if (!result?.ok) throw new Error(result?.error || 'recall capture list failed');
    if (requestId !== _skillsCognitionCaptureRequestId || filter !== _skillsCognitionState.captureFilter) return false;
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
    return true;
  } finally {
    _skillsCognitionCaptureRequestsInFlight = Math.max(0, _skillsCognitionCaptureRequestsInFlight - 1);
  }
}

async function updateRecallCaptureSettings(patch) {
  const result = await window.cogseed.invoke('recall.captures.settings.update', patch);
  if (!result?.ok) throw new Error(result?.error || 'recall capture settings update failed');
  _skillsCognitionState.captureSettings = result.settings;
  renderSkillsCognitionCaptures();
}

function _renderCognitionOverviewMetrics() {
  const sources = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const captures = _skillsCognitionState.captureCounts || {};
  const candidates = (Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [])
    .filter((candidate) => candidate.status === 'pending_review' || candidate.status === 'failed');
  const assets = (Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [])
    .filter((asset) => asset.status === 'active');
  const skillCandidates = assets.filter((asset) => (
    (asset.category || asset.type) === 'skill_method' && !asset.generatedSkillId
  ));
  const metrics = [
    ['sources', 'cognition.pipeline_sources', '数据来源', _cognitionVisibleSourceCount(sources)],
    ['captures', 'cognition.overview_active_tasks', '进行中任务', Number(captures.waiting || 0) + Number(captures.processing || 0)],
    ['captures', 'cognition.pipeline_candidates', '待审核', Math.max(candidates.length, Number(captures.review || 0))],
    ['assets', 'cognition.ability_assets', '能力资产', assets.length],
    ['assets', 'cognition.overview_skill_candidates', '可生成 Skill', skillCandidates.length],
  ];
  return `<section class="recall-overview-metrics" aria-label="${escapeHtml(_cognitionText('cognition.overview_metrics', 'Recall 核心指标'))}">${metrics.map(([page, key, fallback, value]) => `
    <button type="button" class="recall-overview-metric" data-cognition-page-link="${page}">
      <span>${escapeHtml(_cognitionText(key, fallback))}</span><strong>${escapeHtml(String(value))}</strong>
    </button>`).join('')}</section>`;
}

function _renderCognitionOverviewAttention() {
  const captures = _skillsCognitionState.captureCounts || {};
  const recentCaptures = Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [];
  const sourceItems = (Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .flatMap((source) => _cognitionPrimarySourceItems(source));
  const captureModel = _skillsCognitionState.captureModel;
  const failedTasks = Number(captures.failed || 0);
  const sourceIssues = sourceItems.filter((item) => item.status === 'failed' || item.status === 'paused').length;
  const modelAuthorizationRequired = !!captureModel?.authorizationRequired;
  const modelRequired = (!!captureModel && (!captureModel.configured || modelAuthorizationRequired))
    || recentCaptures.some((capture) => capture.status === 'configuration_required');
  const modelIssue = modelAuthorizationRequired
    ? _captureErrorLabel('model_auth_required')
    : _cognitionText('cognition.overview_model_required', '沉淀模型尚未配置');
  if (!failedTasks && !sourceIssues && !modelRequired) return '';
  const issues = [
    modelRequired ? `<button type="button" class="recall-overview-attention-row" data-recall-capture-settings><span>${escapeHtml(modelIssue)}</span><b>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</b></button>` : '',
    failedTasks ? `<button type="button" class="recall-overview-attention-row" data-cognition-page-link="captures"><span>${escapeHtml(_cognitionText('cognition.overview_failed_tasks', '{count} 个沉淀任务需要重试').replace('{count}', String(failedTasks)))}</span><b>${escapeHtml(_cognitionText('common.view', '查看'))}</b></button>` : '',
    sourceIssues ? `<button type="button" class="recall-overview-attention-row" data-cognition-page-link="sources"><span>${escapeHtml(_cognitionText('cognition.overview_source_issues', '{count} 个数据来源需要处理').replace('{count}', String(sourceIssues)))}</span><b>${escapeHtml(_cognitionText('common.view', '查看'))}</b></button>` : '',
  ].filter(Boolean).join('');
  return `<section class="recall-overview-attention"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.overview_attention', '需要处理'))}</h2><span>${escapeHtml(_cognitionText('cognition.overview_attention_hint', '解决后沉淀链路会自动继续'))}</span></div><div>${issues}</div></section>`;
}

function _renderCognitionRecentActivity() {
  const captures = Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [];
  const assets = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
  const conversationTitles = new Map((Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [])
    .filter((source) => source.kind === 'conversation')
    .flatMap((source) => source.items || [])
    .map((item) => [item.id, item.title || item.id]));
  const activity = [
    ...captures.map((capture) => ({
      kind: 'capture', id: capture.id, at: capture.updatedAt || capture.createdAt || '',
      title: conversationTitles.get(capture.conversationId) || capture.conversationTitle || capture.conversationId,
      status: _cognitionStatusLabel(_captureWorkflowStatus(capture)),
      detail: _captureNextActionText(capture),
    })),
    ...assets.map((asset) => ({
      kind: 'asset', id: asset.id, at: asset.updatedAt || asset.createdAt || '',
      title: _abilityAssetDisplayTitle(asset),
      status: _abilityAssetCategoryLabel(asset.category || asset.type),
      detail: _cognitionText('cognition.overview_activity_asset', '记忆已入库'),
    })),
  ].sort((left, right) => {
    const leftTime = Date.parse(left.at) || 0;
    const rightTime = Date.parse(right.at) || 0;
    return rightTime - leftTime;
  }).slice(0, 5);
  const rows = activity.length ? activity.map((item) => {
    const action = item.kind === 'asset'
      ? `data-cognition-open-asset="${escapeHtml(item.id)}"`
      : 'data-cognition-page-link="captures"';
    const kind = item.kind === 'asset'
      ? _cognitionText('cognition.overview_activity_memory', '能力资产')
      : _cognitionText('cognition.overview_activity_capture', '会话沉淀');
    return `<button type="button" class="recall-overview-activity-row" ${action}><span class="recall-overview-activity-main"><strong>${escapeHtml(item.title || item.id)}</strong><small>${escapeHtml(kind)} · ${escapeHtml(item.detail)}</small></span><span class="recall-overview-activity-meta"><b>${escapeHtml(item.status)}</b>${item.at ? `<small>${escapeHtml(_cognitionDate(item.at))}</small>` : ''}</span></button>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.overview_activity_empty', '完成会话沉淀后，最近变化会显示在这里'));
  return `<section class="skills-cognition-card recall-overview-panel recall-overview-activity"><div class="skills-cognition-card-head"><h2>${escapeHtml(_cognitionText('cognition.overview_recent_activity', '最近动态'))}</h2></div><div class="recall-overview-activity-list">${rows}</div></section>`;
}

function _renderCognitionPipelineStatus() {
  const sources = Array.isArray(_skillsCognitionState.sources) ? _skillsCognitionState.sources : [];
  const captures = Array.isArray(_skillsCognitionState.recentCaptures) ? _skillsCognitionState.recentCaptures : [];
  const pendingCandidates = (Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [])
    .filter((candidate) => candidate.status === 'pending_review' || candidate.status === 'failed');
  const assets = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
  const latestCapture = captures[0];
  let next = _cognitionText('cognition.pipeline_next_conversation', '下一步：完成一轮会话，系统会自动整理内容');
  let action = '';
  const workflowStatus = _captureWorkflowStatus(latestCapture);
  if (latestCapture) next = _captureNextActionText(latestCapture);
  if (latestCapture?.status === 'configuration_required') {
    action = `<button class="btn btn-sm" data-recall-capture-settings>${escapeHtml(_cognitionText('cognition.capture_configure_action', '配置模型'))}</button>`;
  } else if (workflowStatus === 'failed') {
    action = `<button class="btn btn-sm" data-recall-capture-retry="${escapeHtml(latestCapture.id)}">${escapeHtml(_cognitionText('common.retry', '重试'))}</button>`;
  } else if (workflowStatus === 'review_ready') {
    action = _captureActionButton(latestCapture, 'view-candidates', 'cognition.capture_review_action', '审核候选');
  } else if (pendingCandidates.length) {
    next = _cognitionText('cognition.pipeline_next_review', '下一步：审核候选，确认后才会进入正式资产');
    action = `<button class="btn btn-sm" data-cognition-page-link="captures">${escapeHtml(_cognitionText('cognition.capture_review_action', '审核候选'))}</button>`;
  }
  const stages = [
    [_cognitionText('cognition.pipeline_sources', '数据来源'), _cognitionVisibleSourceCount(sources)],
    [_cognitionText('cognition.pipeline_views', '已整理会话'), captures.filter((capture) => capture.recallViewId).length],
    [_cognitionText('cognition.pipeline_candidates', '待审核'), pendingCandidates.length],
    [_cognitionText('cognition.ability_assets', '能力资产'), assets.length],
  ].map(([label, count], index) => `<span class="skills-cognition-source-state"><b>${escapeHtml(label)}</b><em>${escapeHtml(String(count))}</em></span>${index < 3 ? '<i class="cognition-pipeline-arrow" aria-hidden="true">→</i>' : ''}`).join('');
  return `<section class="skills-cognition-flow-band recall-overview-pipeline"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.pipeline_title', '沉淀进度'))}</h2><span>${escapeHtml(next)}</span>${action}</div><div class="skills-cognition-source-row cognition-pipeline-row">${stages}</div></section>`;
}

function _renderTeachingSignalStatus() {
  const signals = Array.isArray(_skillsCognitionState.teachingSignals) ? _skillsCognitionState.teachingSignals : [];
  const rows = signals.length ? signals.slice(0, 5).map((signal) => {
    const status = signal.status === 'revoked'
      ? _cognitionText('cognition.teaching_revoked', '已撤销')
      : _cognitionText('cognition.teaching_pending', '已记住 · 待审核');
    const action = signal.status === 'active'
      ? `<button class="btn btn-sm" data-recall-teaching-revoke="${escapeHtml(signal.id)}">${escapeHtml(_cognitionText('cognition.teaching_revoke', '撤销'))}</button>`
      : '';
    return `<div class="skills-cognition-capture-row"><div><strong>${escapeHtml(signal.summary || signal.id)}</strong><span>${escapeHtml(signal.scope || '')} · ${escapeHtml(_cognitionDate(signal.createdAt))}</span></div><span class="skills-cognition-status is-${escapeHtml(signal.status || '')}">${escapeHtml(status)}</span>${action}</div>`;
  }).join('') : _renderCognitionEmpty(_cognitionText('cognition.teaching_empty', '明确的记住、偏好、避免或纠正会在这里留下可撤销回执'));
  return `<section class="skills-cognition-flow-band recall-overview-panel recall-overview-teaching"><div class="skills-cognition-band-head"><h2>${escapeHtml(_cognitionText('cognition.teaching_title', '教学信号'))}</h2><span>${escapeHtml(_cognitionText('cognition.teaching_hint', '已记住的内容立即生效，长期资产仍需审核'))}</span></div><div class="skills-cognition-capture-list">${rows}</div></section>`;
}

function renderSkillsCognitionOverview() {
  const host = document.getElementById('skills-cognition-overview-body');
  if (!host) return;
  const d = _skillsCognitionState.dashboard || {};
  const candidates = (Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [])
    .filter((candidate) => candidate.status === 'pending_review' || candidate.status === 'failed');
  const warnings = Array.isArray(d.warnings) ? d.warnings : [];
  const primarySections = new Set(['dashboard', 'recallCandidates', 'assets', 'sources', 'captures', 'recentCaptures', 'captureSettings']);
  const loadErrors = (Array.isArray(_skillsCognitionState.loadErrors) ? _skillsCognitionState.loadErrors : [])
    .filter((section) => primarySections.has(section));
  const warningHtml = d.degraded || warnings.length
    ? `<div class="skills-cognition-warning">${escapeHtml(_cognitionText('cognition.degraded', '部分认知数据处于降级状态'))}</div>`
    : '';
  const loadFailureHtml = loadErrors.length
    ? `<div class="skills-cognition-warning"><span>${escapeHtml(_cognitionText('cognition.load_failed', '认知资产数据加载失败'))}</span><button class="btn btn-sm" data-cognition-reload>${escapeHtml(_cognitionText('common.retry', '重试'))}</button></div>`
    : '';
  const pendingHtml = candidates.length
    ? candidates.slice(0, 5).map((c) => `<button type="button" class="skills-cognition-list-card" data-cognition-open-candidate="${escapeHtml(c.id)}"><strong>${escapeHtml(c.title || c.summary || c.judgment || c.id)}</strong><span>${escapeHtml(_cognitionStatusLabel(c.status))} · ${escapeHtml(_abilityAssetCategoryLabel(c.suggestedType || c.type))}</span></button>`).join('')
    : '';
  const teachingSignals = Array.isArray(_skillsCognitionState.teachingSignals) ? _skillsCognitionState.teachingSignals : [];
  const activityPanels = [
    _renderCognitionRecentActivity(),
    teachingSignals.length ? _renderTeachingSignalStatus() : '',
    candidates.length ? `<section class="skills-cognition-card recall-overview-panel"><div class="skills-cognition-card-head"><h2>${escapeHtml(_cognitionText('cognition.pending_review', '待确认认知候选'))}</h2><button type="button" class="btn btn-sm" data-cognition-page-link="captures">${escapeHtml(_cognitionText('cognition.view_candidates', '查看候选'))}</button></div>${pendingHtml}</section>` : '',
  ].filter(Boolean).join('');
  const notices = `${loadFailureHtml}${warningHtml}`;
  host.innerHTML = `
    <div class="skills-cognition-overview">
      ${notices ? `<div class="recall-overview-notices">${notices}</div>` : ''}
      ${_renderCognitionOverviewMetrics()}
      ${_renderCognitionOverviewAttention()}
      ${_renderCognitionPipelineStatus()}
      <div class="recall-overview-operation-grid">
        ${_renderCognitionSourceStatus()}
        ${_renderCognitionCaptureStatus()}
      </div>
      ${activityPanels ? `<div class="recall-overview-activity-grid">${activityPanels}</div>` : ''}
    </div>`;
}

// 「使用与证明」：回答"这些资产究竟在哪里用过、真的起作用了吗"。
// 事实全部来自 timeline-service 已聚合的一条链（usage / transfer proof /
// effectiveness proof / receipt），这里只翻译成用户能理解的说法，不造事实。
const _COGNITION_PROOF_KINDS = new Set([
  'usage_recorded', 'transfer_prepared', 'transfer_completed', 'effectiveness_recorded', 'projection_confirmed',
]);

// 结果状态用用户能读懂的话，不露出内部枚举。
function _cognitionProofOutcomeLabel(item) {
  const status = String(item && item.status || '');
  if (item.kind === 'transfer_completed') {
    if (status === 'succeeded') return _cognitionText('cognition.proof_carried_in', '已正确带入');
    if (status === 'degraded') return _cognitionText('cognition.proof_degraded', 'Evidence 不足');
    return _cognitionText('cognition.proof_rejected', '未能带入');
  }
  if (item.kind === 'effectiveness_recorded') {
    if (status === 'better') return _cognitionText('cognition.proof_effective', '使用结果有效');
    if (status === 'no_improvement') return _cognitionText('cognition.proof_no_diff', '未产生明显差异');
    if (status === 'worse') return _cognitionText('cognition.proof_negative', '出现负面影响');
    if (status === 'rework') return _cognitionText('cognition.proof_rework', '需要修正');
    if (status === 'insufficient_evidence') return _cognitionText('cognition.proof_degraded', 'Evidence 不足');
  }
  if (item.kind === 'usage_recorded') return _cognitionText('cognition.proof_used', '被引用');
  if (item.kind === 'projection_confirmed') return _cognitionText('cognition.proof_projected', '已带入本次任务');
  return '';
}

async function renderSkillsCognitionProofs() {
  const host = document.getElementById('skills-cognition-proofs-body');
  if (!host) return;
  _renderCognitionLoading(host);
  let items = [];
  try {
    const result = await window.cogseed.invoke('recall.timeline.list', { limit: 500 });
    items = Array.isArray(result && result.items) ? result.items : [];
  } catch (error) {
    _skillsLog.warn('recall timeline load failed', { error: (error && error.message) || String(error) });
    _renderCognitionError(host);
    return;
  }
  const assets = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
  const titleById = new Map(assets.map((asset) => [asset.id, _abilityAssetDisplayTitle(asset)]));

  // 只保留"用过/证明过"的事实；治理事件属于「版本与治理」，不在这一页。
  const byAsset = new Map();
  for (const item of items) {
    if (!_COGNITION_PROOF_KINDS.has(item.kind)) continue;
    const assetId = item.refs && item.refs.assetId;
    if (!assetId) continue;
    if (!byAsset.has(assetId)) byAsset.set(assetId, []);
    byAsset.get(assetId).push(item);
  }
  if (!byAsset.size) {
    host.innerHTML = `<div class="skills-cognition-empty">${escapeHtml(_cognitionText('cognition.proofs_empty', '还没有资产被真正带入过任务。资产被使用后，这里会显示它在哪里用过、结果如何。'))}</div>`;
    return;
  }

  const sections = [...byAsset.entries()].map(([assetId, entries]) => {
    entries.sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
    const title = titleById.get(assetId) || assetId;
    const rows = entries.slice(0, 20).map((item) => {
      const outcome = _cognitionProofOutcomeLabel(item);
      const refs = item.refs || {};
      const meta = [
        refs.taskRunId ? `${escapeHtml(_cognitionText('cognition.proof_task', '任务'))} ${escapeHtml(refs.taskRunId)}` : '',
        refs.version ? `v${escapeHtml(refs.version)}` : '',
        refs.usageReceiptId ? escapeHtml(_cognitionText('cognition.proof_receipt', '有回执')) : '',
      ].filter(Boolean).join(' · ');
      return `<div class="recall-proof-row">
        <span class="recall-proof-outcome">${escapeHtml(outcome || item.title || item.kind)}</span>
        <span class="recall-proof-summary">${escapeHtml(item.summary || item.title || '')}</span>
        <span class="recall-proof-meta">${meta}</span>
        <span class="recall-proof-time">${escapeHtml(_cognitionDate(item.occurredAt))}</span>
      </div>`;
    }).join('');
    return `<section class="skills-cognition-card recall-proof-asset">
      <div class="skills-cognition-card-head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="btn btn-sm" data-ability-asset-id="${escapeHtml(assetId)}" data-cognition-page-link="assets">${escapeHtml(_cognitionText('cognition.proof_open_asset', '查看资产'))}</button>
      </div>
      ${rows}
    </section>`;
  }).join('');
  host.innerHTML = `<div class="recall-proof-list">${sections}</div>`;
}

function renderSkillsCognitionCandidates() {
  const host = document.getElementById('skills-cognition-capture-review-body')
    || document.getElementById('skills-cognition-candidates-body');
  if (!host) return;
  const allCandidates = Array.isArray(_skillsCognitionState.recallCandidates) ? _skillsCognitionState.recallCandidates : [];
  const selectedCapture = (Array.isArray(_skillsCognitionState.captures) ? _skillsCognitionState.captures : [])
    .find((capture) => capture.id === _skillsCognitionState.selectedCaptureId);
  const selectedIds = selectedCapture ? new Set(selectedCapture.candidateIds || []) : null;
  const recallItems = allCandidates.filter((candidate) => (
    (candidate.status === 'pending_review' || candidate.status === 'failed')
    && (!selectedIds || selectedIds.has(candidate.id))
  ));
  if (!recallItems.length) {
    host.innerHTML = '';
    return;
  }
  const reviewActions = `<div class="recall-capture-review-head-actions"><span class="skills-cognition-status is-review_ready">${escapeHtml(String(recallItems.length))}</span>${recallItems.length > 1 ? `<button type="button" class="btn btn-sm btn-primary" data-recall-candidate-promote-all>${escapeHtml(_cognitionText('cognition.capture_save_all_to_recall', '全部保存'))}</button>` : ''}</div>`;
  host.innerHTML = `<section class="recall-capture-review"><div class="recall-workbench-section-head"><div><h2>${escapeHtml(_cognitionText('cognition.capture_review_title', '待审核内容'))}</h2><p>${escapeHtml(_cognitionText('cognition.capture_review_hint', '确认后写入 Recall；不需要的内容可以忽略'))}</p></div>${reviewActions}</div><div class="skills-cognition-record-list recall-candidate-list">${recallItems.map((candidate) => {
    const primaryAction = candidate.suggestedAction === 'keep_current'
      ? 'keep-current'
      : candidate.suggestedAction === 'reject' ? 'reject' : 'promote';
    const actions = candidate.status === 'pending_review' || candidate.status === 'failed'
      ? [primaryAction, 'edit', 'defer', ...(primaryAction === 'reject' ? [] : ['reject']), 'ignore']
      : [];
    const editing = _skillsCognitionState.editingRecallCandidateId === candidate.id;
    const editForm = editing ? `<div class="skills-cognition-detail-block recall-candidate-editor"><label>${escapeHtml(_cognitionText('cognition.judgment', '我的判断'))}<textarea data-recall-edit-judgment>${escapeHtml(candidate.judgment || '')}</textarea></label><label>${escapeHtml(_cognitionText('cognition.summary', '摘要'))}<input data-recall-edit-summary value="${escapeHtml(candidate.summary || '')}"></label><label>${escapeHtml(_cognitionText('cognition.scope', '作用域'))}<input data-recall-edit-scope value="${escapeHtml(candidate.suggestedScope || '')}"></label><label>${escapeHtml(_cognitionText('cognition.type', '类型'))}<select data-recall-edit-type>${['personal','rule','template','skill_method'].map((type) => `<option value="${type}" ${candidate.suggestedType === type ? 'selected' : ''}>${escapeHtml(_abilityAssetCategoryLabel(type))}</option>`).join('')}</select></label><label>${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}<textarea data-recall-edit-evidence>${escapeHtml((candidate.sourceRefs || []).map((ref) => `${ref.kind}:${ref.id}`).join('\n'))}</textarea></label><div class="skills-cognition-actions"><button class="btn btn-sm btn-primary" data-recall-candidate-action="save-and-promote" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('cognition.candidate_modify_and_save', '修改后保存'))}</button><button class="btn btn-sm" data-recall-candidate-action="cancel-edit" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(_cognitionText('common.cancel', '取消'))}</button></div></div>` : '';
    return `<article class="skills-cognition-record cognition-candidate-row recall-collapsible" data-recall-candidate-id="${escapeHtml(candidate.id)}"><details class="recall-collapsible-body"><summary class="skills-cognition-record-head recall-collapsible-summary"><span class="recall-collapsible-title"><h2>${escapeHtml(_abilityCandidateDisplayTitle(candidate))}</h2><span class="skills-cognition-meta">${escapeHtml(_abilityAssetCategoryLabel(candidate.suggestedType))} · ${escapeHtml(_abilityAssetScopeLabel(candidate.suggestedScope))}</span></span><span class="skills-cognition-status is-${escapeHtml(candidate.status || '')}">${escapeHtml(_cognitionStatusLabel(candidate.status))}</span></summary><p>${escapeHtml(candidate.judgment || '')}</p>${candidate.value ? `<p class="skills-cognition-meta">${escapeHtml(candidate.value)}</p>` : ''}<div class="skills-cognition-meta">${escapeHtml(_abilityAssetCategoryLabel(candidate.suggestedType))} · ${escapeHtml(_abilityAssetScopeLabel(candidate.suggestedScope))}</div>${candidate.failureMessage ? `<div class="skills-cognition-error">${escapeHtml(candidate.failureMessage)}</div>` : ''}<div class="skills-cognition-detail-block"><strong>${escapeHtml(_cognitionText('cognition.evidence_refs', '证据引用'))}</strong><div class="skills-cognition-ref-row">${_renderCognitionInlineRefs(candidate.evidenceRefs || candidate.sourceRefs)}</div></div>${editForm}<div class="skills-cognition-actions">${actions.map((action) => `<button class="btn btn-sm ${action === primaryAction ? 'btn-primary' : ''}" data-recall-candidate-action="${escapeHtml(action)}" data-recall-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(action === 'promote' ? _cognitionText('cognition.capture_save_to_recall', '保存到 Recall') : action === 'keep-current' ? _cognitionText('cognition.candidate_keep_current', '保持当前版本') : action === 'reject' ? _cognitionText('cognition.candidate_reject', '拒绝') : action === 'ignore' ? _cognitionText('cognition.capture_ignore', '忽略') : action === 'defer' ? _cognitionText('cognition.status_deferred', '稍后') : _cognitionText('skills.edit', '编辑'))}</button>`).join('')}</div></details></article>`;
  }).join('')}</div></section>`;
}

/**
 * 当前状态下允许的治理动作（规范 22.1）。
 *
 * 按状态生成而不是全部列出再逐个禁用：一个点不动的「恢复」不会告诉用户为什么
 * 点不动，不如不给。彻底清除后只剩版本入口——墓碑没有内容可治理，其余动作在
 * 服务端也会被 assertNotPurged 挡掉，摆出来只会让人以为还能操作。
 */
function _recallAssetActions(status) {
  // 彻底清除后仍留「使用与证明」：墓碑没有内容可治理，但它过去被谁带走过、
  // 用过几次是既成事实，回执还在，不该跟着内容一起消失。
  if (status === 'purged') return ['versions', 'chain'];
  const actions = [];
  if (status === 'active') actions.push('pause');
  if (status === 'paused') actions.push('resume');
  if (status === 'active' || status === 'paused') actions.push('archive');
  if (status === 'archived' || status === 'deleted') actions.push('restore');
  if (status !== 'deleted' && status !== 'revoked') actions.push('delete');
  if (status !== 'revoked') actions.push('revoke');
  actions.push('purge', 'versions', 'chain');
  return actions;
}

function _recallAssetActionLabel(action) {
  const labels = {
    pause: _cognitionText('cognition.asset_action_pause', '暂停使用'),
    resume: _cognitionText('cognition.asset_action_resume', '恢复使用'),
    archive: _cognitionText('cognition.asset_action_archive', '归档'),
    restore: _cognitionText('cognition.asset_action_restore', '恢复'),
    delete: _cognitionText('cognition.asset_action_delete', '删除'),
    purge: _cognitionText('cognition.asset_action_purge', '彻底清除'),
    revoke: _cognitionText('cognition.asset_action_revoke', '移除记忆'),
    versions: _cognitionText('cognition.asset_action_versions', '查看版本'),
    chain: _cognitionText('cognition.asset_action_chain', '使用与证明'),
  };
  return labels[action] || action;
}

/** 履历五段的用户层命名。刻意不叫 pack / receipt——那是实现名。 */
function _cognitionChainStageLabel(stage) {
  const labels = {
    formation: _cognitionText('cognition.chain_stage_formation', '从哪来'),
    settling: _cognitionText('cognition.chain_stage_settling', '成了什么'),
    inheritance: _cognitionText('cognition.chain_stage_inheritance', '谁带着它'),
    use: _cognitionText('cognition.chain_stage_use', '真用过几次'),
    evidence: _cognitionText('cognition.chain_stage_evidence', '哪几次没用上'),
  };
  return labels[stage] || stage;
}

/** 某次没带上的原因。后端给的是机器码，这里翻成人话。
 *
 *  取值来自 WithheldReason（选择层）加上渲染侧的两个：needs_confirmation、
 *  truncated。注意与 Agent 详情页那套 InheritanceExclusionReason 不是一回事——
 *  那个说的是「出生时没带走」，这个说的是「某一次运行没带上」。 */
function _cognitionWithheldReasonLabel(reason) {
  const labels = {
    scope_agent_not_allowed: _cognitionText('cognition.withheld_scope_agent', '这个智能体不在允许范围内'),
    scope_role_not_allowed: _cognitionText('cognition.withheld_scope_role', '这个角色不在允许范围内'),
    scope_project_not_allowed: _cognitionText('cognition.withheld_scope_project', '这个项目不在允许范围内'),
    scope_workspace_not_allowed: _cognitionText('cognition.withheld_scope_workspace', '这个空间不在允许范围内'),
    sensitivity_above_destination: _cognitionText('cognition.withheld_sensitivity_high', '敏感级高于这次允许的上限'),
    sensitivity_unclassified: _cognitionText('cognition.withheld_sensitivity_unknown', '还没分过敏感级，这次不敢默认放行'),
    asset_paused: _cognitionText('cognition.withheld_paused', '当时已暂停'),
    asset_archived: _cognitionText('cognition.withheld_archived', '当时已归档'),
    asset_revoked: _cognitionText('cognition.withheld_revoked', '当时已撤销'),
    asset_deleted: _cognitionText('cognition.withheld_deleted', '当时已删除'),
    asset_purged: _cognitionText('cognition.withheld_purged', '当时已彻底清除'),
    use_policy_never: _cognitionText('cognition.withheld_maturity', '成熟度还不够默认带入'),
    asset_missing: _cognitionText('cognition.withheld_missing', '当时读不到这条资产'),
    content_changed: _cognitionText('cognition.withheld_content_changed', '内容和继承时那份对不上了'),
    version_changed: _cognitionText('cognition.withheld_version_changed', '版本和继承时那版对不上了'),
    needs_confirmation: _cognitionText('cognition.withheld_needs_confirmation', '跨作用域，等你确认'),
    truncated: _cognitionText('cognition.withheld_truncated', '这次篇幅放不下'),
    unknown: _cognitionText('cognition.withheld_unknown', '没有记录原因'),
  };
  return labels[reason] || reason;
}

/** 迁移证明的状态：它只说明「有没有真的被带过去用上」，不说明用了好不好。 */
function _transferProofLabel(status) {
  const labels = {
    prepared: _cognitionText('cognition.proof_transfer_prepared', '已准备，还没回执'),
    succeeded: _cognitionText('cognition.proof_transfer_succeeded', '确实被带过去用了'),
    degraded: _cognitionText('cognition.proof_transfer_degraded', '带过去了，但过程降级'),
    rejected: _cognitionText('cognition.proof_transfer_rejected', '这次迁移被拒'),
  };
  return labels[status] || status;
}

/** 效果结论。**worse 与 no_improvement 也是证明**——证明它没帮上忙。
 *  只显示 better 会把「证明」变成宣传：一条被证明有害的资产会和一条从没被
 *  评价过的资产在界面上长得一样。 */
function _effectivenessProofLabel(outcome) {
  const labels = {
    better: _cognitionText('cognition.proof_outcome_better', '用了之后确实更好'),
    no_improvement: _cognitionText('cognition.proof_outcome_no_improvement', '用了没什么差别'),
    worse: _cognitionText('cognition.proof_outcome_worse', '用了反而更差'),
    insufficient_evidence: _cognitionText('cognition.proof_outcome_insufficient', '证据不足，下不了结论'),
    invalid: _cognitionText('cognition.proof_outcome_invalid', '这次评价本身作废'),
    rework: _cognitionText('cognition.proof_outcome_rework', '需要返工'),
  };
  return labels[outcome] || outcome;
}

/**
 * 「使用与证明」：这条认知从哪来、进过哪些智能体、真用过几次、哪几次没用上为什么。
 *
 * **这是履历，不是进度条。** 五段里 `not_yet` 表示「还没发生」，不是「欠着一步」
 * ——所以它渲染成中性的 is-not-yet，不能是红色或警告色。一条只在两个智能体里
 * 躺着、还没被任务带入的认知，不是「五步只走了三步」，它就是一条还没被用过的
 * 认知。这两种说法给用户的暗示完全不同。
 */
function _renderRecallAssetChain(assetId) {
  if (_skillsCognitionState.visibleAssetChainId !== assetId) return '';
  const state = _skillsCognitionState.assetChainById?.[assetId];
  const closeLabel = _cognitionText('common.close', '关闭');
  const closeIcon = typeof uiIconHtml === 'function' ? uiIconHtml('x') : '<span aria-hidden="true">×</span>';
  let body = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;

  if (state?.error) {
    body = `<div class="skills-cognition-error">${escapeHtml(state.error)}</div>`;
  } else if (state && !state.loading) {
    const chain = state.chain || {};
    const segments = Array.isArray(chain.segments) ? chain.segments : [];
    const withheld = Array.isArray(chain.withheld) ? chain.withheld : [];
    const usage = Array.isArray(state.usage) ? state.usage : [];

    const segmentsHtml = segments.map((segment) => {
      const happened = segment.status === 'happened';
      return `<div class="cognition-chain-segment is-${happened ? 'happened' : 'not-yet'}">
        <span class="cognition-chain-stage">${escapeHtml(_cognitionChainStageLabel(segment.stage))}</span>
        <p class="cognition-chain-detail">${escapeHtml(segment.detail || '')}</p>
        ${segment.at ? `<small>${escapeHtml(_cognitionDate(segment.at))}</small>` : ''}
      </div>`;
    }).join('');

    const agents = Array.isArray(chain.carriedByAgentIds) ? chain.carriedByAgentIds : [];
    const carriedHtml = agents.length
      ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.chain_carried_by', '带着它的智能体'))}</strong><p>${escapeHtml(agents.join('、'))}</p></div>`
      : '';

    // 未带入原因单独成块：用户问「为什么这次没用我这条」时，答案必须是具体原因。
    const withheldHtml = withheld.length
      ? `<div class="cognition-chain-withheld"><strong>${escapeHtml(_cognitionText('cognition.chain_withheld', '没带上的那几次'))}</strong>${
        withheld.map((entry) => `<div class="cognition-chain-withheld-row"><span>${escapeHtml(_cognitionWithheldReasonLabel(entry.reason))}</span><small>${escapeHtml(_cognitionDate(entry.at))}</small></div>`).join('')
      }</div>`
      : '';

    // 跨作用域授权：用户在履历上看到「等你确认」，确认的按钮就该在这里。
    // 没有这个入口，confirm 档等于承诺了一个不存在的动作。
    const asset = _skillsCognitionState.assets?.find((item) => item.id === assetId);
    const crossScopeConfirmed = !!asset?.crossScopeConfirmedAt;
    const waitingConfirmation = withheld.some((entry) => entry.reason === 'needs_confirmation');
    const crossScopeHtml = (crossScopeConfirmed || waitingConfirmation)
      ? `<div class="reference-strip cognition-chain-cross-scope"><div><strong>${escapeHtml(_cognitionText('cognition.cross_scope', '跨作用域使用'))}</strong><p>${escapeHtml(crossScopeConfirmed
        ? _cognitionText('cognition.cross_scope_confirmed', '你已允许这条认知在其他作用域使用。')
        : _cognitionText('cognition.cross_scope_waiting', '这条认知被带到了它作用域之外，需要你确认才会带入。'))}</p></div><button type="button" class="btn btn-sm${crossScopeConfirmed ? '' : ' btn-primary'}" data-recall-cross-scope="${escapeHtml(assetId)}" data-recall-cross-scope-next="${crossScopeConfirmed ? '0' : '1'}">${escapeHtml(crossScopeConfirmed
        ? _cognitionText('cognition.cross_scope_withdraw', '撤回许可')
        : _cognitionText('cognition.cross_scope_confirm', '允许跨作用域使用'))}</button></div>`
      : '';

    const usageHtml = usage.length
      ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.chain_usage', '使用记录'))}</strong><p>${escapeHtml(
        _cognitionText('cognition.chain_usage_count', '共 {n} 条').replace('{n}', String(usage.length)),
      )}</p></div>`
      : '';

    // 证明：迁移与效果分两层显示，不合并成一个「已验证」。没有证明就说没有，
    // 不留空白——「还没被证明过」本身是个结论，比什么都不说清楚。
    const proofs = Array.isArray(state.proofs) ? state.proofs : [];
    const proofRows = proofs.map((entry) => {
      const effects = (entry.effectiveness || []).map((e) => (
        `<div class="cognition-proof-outcome is-${escapeHtml(e.outcome)}"><span>${escapeHtml(_effectivenessProofLabel(e.outcome))}</span><small>${escapeHtml(_cognitionDate(e.createdAt))}</small></div>`
      )).join('') || `<div class="cognition-proof-outcome is-none"><span>${escapeHtml(_cognitionText('cognition.proof_not_evaluated', '这次迁移还没有人评价效果'))}</span></div>`;
      return `<div class="cognition-proof-row"><div class="cognition-proof-transfer"><span>${escapeHtml(_transferProofLabel(entry.transfer?.status))}</span><small>v${escapeHtml(String(entry.version || ''))} · ${escapeHtml(_cognitionDate(entry.transfer?.createdAt))}</small></div>${effects}</div>`;
    }).join('');
    const proofHtml = `<div class="cognition-chain-proofs"><strong>${escapeHtml(_cognitionText('cognition.proofs', '证明'))}</strong>${
      proofs.length ? proofRows : `<div class="skills-cognition-muted">${escapeHtml(_cognitionText('cognition.proofs_empty', '还没有人证明过这条认知有没有用。'))}</div>`
    }</div>`;

    body = `<div class="cognition-chain-body">
      <div class="cognition-chain-segments">${segmentsHtml}</div>
      ${crossScopeHtml}${carriedHtml}${usageHtml}${proofHtml}${withheldHtml}
    </div>`;
  }

  return `<section class="recall-asset-chain-panel"><div class="recall-asset-version-head"><strong>${escapeHtml(_cognitionText('cognition.chain_title', '使用与证明'))}</strong><button type="button" class="btn btn-sm recall-asset-version-close" data-recall-asset-chain-close title="${escapeHtml(closeLabel)}" aria-label="${escapeHtml(closeLabel)}">${closeIcon}</button></div>${body}</section>`;
}

function _renderRecallAssetHistory(assetId) {
  if (_skillsCognitionState.visibleAssetHistoryId !== assetId) return '';
  const history = _skillsCognitionState.assetHistoryById?.[assetId];
  const closeLabel = _cognitionText('common.close', '关闭');
  const closeIcon = typeof uiIconHtml === 'function' ? uiIconHtml('x') : '<span aria-hidden="true">×</span>';
  let body = `<div class="skills-cognition-loading">${escapeHtml(_cognitionText('cognition.loading', '加载中…'))}</div>`;
  if (history?.error) {
    body = `<div class="skills-cognition-error">${escapeHtml(history.error)}</div>`;
  } else if (history && !history.loading) {
    const versions = Array.isArray(history.versions) ? history.versions : [];
    // 回滚按钮挂在版本行上：要回到哪一版是选择题，放进「更多」菜单就没地方选。
    // 当前版本不给回滚按钮——回滚到自己没有意义，服务端也会拒。
    const currentVersion = String(_skillsCognitionState.assets?.find((item) => item.id === assetId)?.version || '');
    const rollbackLabel = _cognitionText('cognition.asset_action_rollback', '回滚到此版本');
    body = versions.length ? versions.map((version) => {
      const value = String(version.version || '');
      const rollback = value && value !== currentVersion
        ? `<button type="button" class="btn btn-sm recall-asset-rollback" data-recall-asset-rollback="${escapeHtml(assetId)}" data-recall-asset-version="${escapeHtml(value)}">${escapeHtml(rollbackLabel)}</button>`
        : '';
      return `<div class="recall-asset-version-row"><span><strong>v${escapeHtml(value)}</strong><small>${escapeHtml(_cognitionDate(version.at))}</small></span><p>${escapeHtml(version.snapshot?.title || '')}</p>${rollback}</div>`;
    }).join('') : `<div class="skills-cognition-empty">${escapeHtml(_cognitionText('cognition.asset_versions_empty', '暂无版本记录'))}</div>`;
  }
  return `<section class="recall-asset-version-panel"><div class="recall-asset-version-head"><strong>${escapeHtml(_cognitionText('cognition.version_history', '版本历史'))}</strong><button type="button" class="btn btn-sm recall-asset-version-close" data-recall-asset-history-close title="${escapeHtml(closeLabel)}" aria-label="${escapeHtml(closeLabel)}">${closeIcon}</button></div>${body}</section>`;
}

function renderSkillsCognitionAssets() {
  const host = document.getElementById('skills-cognition-assets-body');
  if (!host) return;
  const summaryHost = document.getElementById('skills-cognition-assets-summary');
  const personalMemoryHead = document.getElementById('skills-cognition-formal-assets')
    ?.querySelector?.('.recall-personal-memory-head');
  const previousListScrollTop = Number(host.querySelector?.('.ability-asset-list-body')?.scrollTop || 0);
  const items = _skillsCognitionState.assets;
  const categories = [
    ['personal', 'cognition.asset_category_personal', '关于我', 'cognition.asset_category_personal_desc', '长期角色与个人边界'],
    ['rule', 'cognition.asset_category_rule', '规则与判断', 'cognition.asset_category_rule_desc', '可复用的决策约束'],
    ['template', 'cognition.asset_category_template', '模板与范例', 'cognition.asset_category_template_desc', '结构与参考样例'],
    ['skill_method', 'cognition.asset_category_skill_method', '可复用方法', 'cognition.asset_category_skill_method_desc', '流程、工具与评价方法'],
  ];
  const summary = categories.map(([category, key, fallback, descKey, descFallback]) => {
    const active = _skillsCognitionState.assetCategoryFilter === category ? ' is-active' : '';
    return `
    <button type="button" class="ability-asset-summary-card${active}" data-ability-asset-category="${escapeHtml(category)}"><span>${escapeHtml(_cognitionText(key, fallback))}</span><strong>${escapeHtml(String(_abilityAssetSummary(items, category)))}</strong><small>${escapeHtml(_cognitionText(descKey, descFallback))}</small></button>
  `;
  }).join('');
  const summaryMarkup = `<div class="ability-asset-summary-grid">${summary}</div>`;
  if (summaryHost) summaryHost.innerHTML = summaryMarkup;
  const isPersonalCategory = _skillsCognitionState.assetCategoryFilter === 'personal';
  // 「关于我」是四类资产之一，不再是独立任务页：选中 personal 分类时在本页
  // 展开个人本体。骨架全仓只有这一处，渲染函数按 id 定位即可命中。
  const personalOntologyHost = document.getElementById('skills-cognition-personal-ontology');
  const shouldRenderPersonalOntology = Boolean(personalOntologyHost && isPersonalCategory && personalOntologyHost.hidden);
  if (personalOntologyHost) personalOntologyHost.hidden = !isPersonalCategory;
  if (personalMemoryHead) personalMemoryHead.hidden = !isPersonalCategory;
  if (shouldRenderPersonalOntology) {
    const renderOntology = typeof window.refreshPersonalOntology === 'function'
      ? window.refreshPersonalOntology
      : window.renderPersonalOntology;
    if (typeof renderOntology === 'function') {
      Promise.resolve(renderOntology()).catch((error) => {
        _skillsLog.warn('personal ontology render failed', { error: (error && error.message) || String(error) });
      });
    }
  }
  // 这里不再补救过滤 personal_ontology 代理项：后端 assets-adapter 已不再把
  // 个人本体分组合成为资产，列表与上方分类计数因此天然一致。过去列表过滤、
  // 计数不过滤，卡片数字会大于实际可见条数。
  const categoryItems = _skillsCognitionState.assetCategoryFilter
    ? items.filter((item) => (item.category || item.type) === _skillsCognitionState.assetCategoryFilter)
    : items;
  const searchQuery = String(_skillsCognitionState.assetSearchQuery || '').trim().toLocaleLowerCase();
  const filteredItems = searchQuery
    ? categoryItems.filter((item) => [item.title, item.summary, item.statement, item.id, item.scope, item.category, item.type]
      .some((value) => String(value || '').toLocaleLowerCase().includes(searchQuery)))
    : categoryItems;
  const searchInput = `<input class="asset-search" value="${escapeHtml(_skillsCognitionState.assetSearchQuery || '')}" placeholder="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索记忆内容'))}" aria-label="${escapeHtml(_cognitionText('cognition.search_ability_assets', '搜索记忆内容'))}">`;
  if (!items.length) {
    host.innerHTML = `${summaryHost ? '' : summaryMarkup}<div class="ability-assets-workbench is-asset-management-only">
      <div class="ability-assets-empty">${escapeHtml(_cognitionText('cognition.no_ability_assets', '尚无正式资产。完成复用证明、确认带入正确并保存后，资产才会出现在这里。'))}</div>
    </div>`;
    return;
  }
  if (!filteredItems.length) {
    const selectedCategory = _abilityAssetCategoryLabel(_skillsCognitionState.assetCategoryFilter);
    host.innerHTML = `${summaryHost ? '' : summaryMarkup}<div class="ability-assets-workbench is-asset-management-only">
      <div class="ability-assets-management">
        <section class="ability-asset-list"><div class="ability-asset-list-head">${searchInput}</div><div class="ability-assets-empty">${escapeHtml(searchQuery ? _cognitionText('cognition.asset_search_empty', '未找到匹配的能力资产') : _cognitionText('cognition.empty_asset_category', '该分类暂无能力资产'))}</div></section>
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
    const displayTitle = _abilityAssetDisplayTitle(a);
    const contentSummary = _abilityAssetContentSummary(a);
    return `<button type="button" class="skills-cognition-record cognition-asset-row ability-asset-list-row${selectedClass}" data-ability-asset-id="${escapeHtml(a.id)}">
      <span class="ability-asset-row-main"><strong>${escapeHtml(displayTitle)}</strong><small>${escapeHtml(_abilityAssetCategoryLabel(category))}${a.version ? ` · ${escapeHtml(a.version)}` : ''} · ${escapeHtml(_abilityAssetScopeLabel(a.scope || 'general'))}</small>${contentSummary ? `<details class="recall-collapsible-body ability-asset-row-details" onclick="event.stopPropagation()"><summary>${escapeHtml(_cognitionText('cognition.asset_view_content', '查看内容'))}</summary><span class="ability-asset-row-summary">${escapeHtml(contentSummary)}</span></details>` : ''}</span>
      <span class="skills-cognition-status">${escapeHtml(_abilityAssetMaturityLabel(a.maturity, a.status))}</span>
    </button>`;
  }).join('');
  const selectedCategory = selected.category || selected.type;
  const selectedDisplayTitle = _abilityAssetDisplayTitle(selected);
  const selectedContentSummary = _abilityAssetContentSummary(selected);
  const selectedContentSummaryBlock = selectedContentSummary
    ? `<div class="asset-content-summary"><strong>${escapeHtml(_cognitionText('cognition.deposited_content', '沉淀内容'))}</strong><p>${escapeHtml(selectedContentSummary)}</p></div>`
    : '';
  const workspaceRefs = Array.isArray(selected.workspaceRefs) ? selected.workspaceRefs.filter(Boolean) : [];
  const relationRefs = Array.isArray(selected.relationRefs) ? selected.relationRefs : [];
  const relationText = relationRefs.length ? [...new Set(relationRefs.map(_cognitionRelationRefText).filter(Boolean))].join('、') : _cognitionText('cognition.no_refs', '未记录引用');
  // 列表里的每一条都是正式资产，治理动作与写入来源一律可显示。
  const writeOrigin = _abilityAssetWriteOriginLabel(selected.lifecycleStatus);
  const assetManagementActions = _recallAssetActions(selected.status);
  const assetMoreLabel = _cognitionText('common.more', '更多');
  const assetMoreIcon = typeof uiIconHtml === 'function' ? uiIconHtml('more-horizontal') : '<span aria-hidden="true">...</span>';
  const assetMore = assetManagementActions.length
    ? `<button type="button" class="btn btn-sm recall-asset-more" data-recall-asset-more="${escapeHtml(selected.id)}" data-recall-asset-actions="${escapeHtml(assetManagementActions.join(','))}" title="${escapeHtml(assetMoreLabel)}" aria-label="${escapeHtml(assetMoreLabel)}">${assetMoreIcon}</button>`
    : '';
  const skillDraftFailed = selected.recallSkillDraftStatus === 'failed';
  const skillDraftNeedsModel = skillDraftFailed && (selected.recallSkillDraftErrorCode === 'model_not_configured' || selected.recallSkillDraftErrorCode === 'model_auth_required');
  const skillDraftReady = selected.recallSkillDraftStatus === 'draft';
  const isRecallSkillAsset = selectedCategory === 'skill_method' && selected.status === 'active';
  const skillInstalled = isRecallSkillAsset && Boolean(selected.generatedSkillId);
  const skillDraftGenerating = isRecallSkillAsset && (selected.recallSkillDraftStatus === 'generating' || (!selected.recallSkillDraftStatus && !selected.generatedSkillId));
  const skillDraftRecallContext = selected.recallSkillDraft?.recallContext;
  const skillDraftRecallSummary = Number(skillDraftRecallContext?.assetCount) > 0
    ? _cognitionText('cognition.skill_draft_recall_context', '依据：{assets} 条记忆 · {sources} 个来源')
      .replace('{assets}', String(skillDraftRecallContext.assetCount))
      .replace('{sources}', String(skillDraftRecallContext.sourceCount || 0))
    : '';
  const skillAction = isRecallSkillAsset
    ? selected.generatedSkillId
      ? `<button type="button" class="btn btn-sm btn-primary" data-cognition-open-skill="${escapeHtml(selected.generatedSkillId)}">${escapeHtml(_cognitionText('cognition.open_skill', '查看技能'))}</button>`
      : skillDraftReady
        ? `<button type="button" class="btn btn-sm btn-primary" data-recall-skill-import="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.add_to_skill_library', '加入技能库'))}</button>`
        : skillDraftNeedsModel
          ? `<button type="button" class="btn btn-sm btn-primary" data-recall-skill-configure>${escapeHtml(_cognitionText('cognition.configure_model', '配置模型'))}</button>`
          : skillDraftFailed
          ? `<button type="button" class="btn btn-sm btn-primary" data-recall-skill-generate="${escapeHtml(selected.id)}">${escapeHtml(_cognitionText('cognition.retry_skill_draft', '重试生成'))}</button>`
          : `<button type="button" class="btn btn-sm btn-primary" disabled>${escapeHtml(_cognitionText('cognition.skill_draft_auto_generating', '正在生成 Skill…'))}</button>`
    : '';
  const skillDraftFeedback = skillInstalled
    ? `<div class="reference-strip recall-skill-draft-state"><div><strong>${escapeHtml(_cognitionText('cognition.skill_installed_status', '已加入技能库'))}</strong><p>${escapeHtml(_cognitionText('cognition.skill_installed_hint', '现在可在技能库中查看和使用。'))}</p></div>${skillAction}</div>`
    : skillDraftFailed
    ? `<div class="recall-capture-task-error recall-skill-draft-state"><div><b>${escapeHtml(_cognitionText('cognition.skill_draft_failed', 'Skill 生成失败'))}</b><span>${escapeHtml(_recallSkillDraftErrorLabel(selected.recallSkillDraftErrorCode))}</span></div>${skillAction}</div>`
    : skillDraftReady
      ? `<div class="reference-strip recall-skill-draft-state"><div><strong>${escapeHtml(_cognitionText('cognition.skill_draft_ready', 'Skill 已生成'))}</strong><p>${escapeHtml([skillDraftRecallSummary, _cognitionText('cognition.skill_draft_ready_hint', '已通过校验，等待加入技能库。')].filter(Boolean).join(' · '))}</p></div>${skillAction}</div>`
      : skillDraftGenerating
        ? `<div class="reference-strip recall-skill-draft-state"><div><strong>${escapeHtml(_cognitionText('cognition.skill_draft_auto_generating', '正在生成 Skill…'))}</strong><p>${escapeHtml(_cognitionText('cognition.skill_draft_auto_hint', '正在整理相关记忆与来源。'))}</p></div>${skillAction}</div>`
        : '';
  host.innerHTML = `${summaryHost ? '' : summaryMarkup}<div class="ability-assets-workbench is-asset-management-only">
    <div class="ability-assets-management">
      <section class="ability-asset-list">
        <div class="ability-asset-list-head">${searchInput}</div>
        <div class="skills-cognition-record-list ability-asset-list-body">${rows}</div>
      </section>
      <section class="ability-asset-detail">
        <div class="asset-detail-head"><div><h2>${escapeHtml(selectedDisplayTitle)}</h2><p>${escapeHtml(_abilityAssetCategoryLabel(selectedCategory))}</p></div><div class="asset-detail-head-actions"><span class="skills-cognition-status is-${escapeHtml(selected.status || '')}">${escapeHtml(_abilityAssetMaturityLabel(selected.maturity, selected.status))}</span>${assetMore}</div></div>
        <div class="asset-detail-body">
          ${skillDraftFeedback}
          ${selectedContentSummaryBlock}
          ${writeOrigin ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.asset_write_origin', '写入来源'))}</strong><p>${escapeHtml(writeOrigin)}</p></div>` : ''}
          <div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.relation_refs', '关联引用'))}</strong><p>${escapeHtml(relationText)}</p></div>
          ${workspaceRefs.length ? `<div class="reference-strip"><strong>${escapeHtml(_cognitionText('cognition.workspace_refs', 'Workspace引用'))}</strong><p>${escapeHtml(workspaceRefs.join('、'))}</p></div>` : ''}
          ${_renderAbilityAssetGovernance(selected)}
          ${_renderRecallAssetHistory(selected.id)}
          ${_renderRecallAssetChain(selected.id)}
        </div>
      </section>
    </div>
  </div>`;
  const nextList = host.querySelector?.('.ability-asset-list-body');
  if (nextList) nextList.scrollTop = previousListScrollTop;
}

function openRecallPersonalOntology() {
  _skillsCognitionState.assetCategoryFilter = 'personal';
  _skillsCognitionState.selectedAssetId = '';
  switchSkillsCognitionPage('assets');
}

window.openRecallPersonalOntology = openRecallPersonalOntology;

async function loadSkillsCognitionSnapshot() {
  if (_skillsCognitionState.loading) return;
  _skillsCognitionState.loading = true;
  const snapshotCaptureFilter = _skillsCognitionState.captureFilter;
  const snapshotCaptureRequestId = _skillsCognitionCaptureRequestId;
  const captureRequestWasInFlight = _skillsCognitionCaptureRequestsInFlight > 0;
  const capturePayload = { limit: 25 };
  const captureStatuses = _captureStatusesForFilter(snapshotCaptureFilter);
  if (captureStatuses.length) capturePayload.statuses = captureStatuses;
  const [dashboard, recallCandidates, assets, sources, captures, recentCaptures, teachingSignals, captureSettings] = await Promise.allSettled([
    Promise.resolve().then(() => window.cogseed.invoke('cognition.dashboard.read')),
    Promise.resolve().then(() => window.cogseed.invoke('recall.candidates.list')),
    Promise.resolve().then(() => window.cogseed.invoke('cognition.assets.list', { limit: 500 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.sources.list', { limit: 100 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.captures.list', capturePayload)),
    Promise.resolve().then(() => window.cogseed.invoke('recall.captures.list', { limit: 5 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.teaching.list', { limit: 20 })),
    Promise.resolve().then(() => window.cogseed.invoke('recall.captures.settings.get')),
  ]);
  const captureResultIsCurrent = !captureRequestWasInFlight
    && snapshotCaptureRequestId === _skillsCognitionCaptureRequestId
    && snapshotCaptureFilter === _skillsCognitionState.captureFilter;
  if (dashboard.status === 'fulfilled' && dashboard.value?.ok) _skillsCognitionState.dashboard = dashboard.value.dashboard;
  if (recallCandidates.status === 'fulfilled' && recallCandidates.value?.ok) _skillsCognitionState.recallCandidates = recallCandidates.value.candidates || [];
  if (assets.status === 'fulfilled' && assets.value?.ok) {
    _skillsCognitionState.assets = assets.value.assets || [];
    queueMissingRecallSkillDrafts();
  }
  if (sources.status === 'fulfilled' && sources.value?.ok) _skillsCognitionState.sources = sources.value.sources || [];
  if (captureResultIsCurrent && captures.status === 'fulfilled' && captures.value?.ok) {
    const nextCaptures = captures.value.captures || [];
    const existingCaptures = _skillsCognitionState.captures || [];
    if (existingCaptures.length > 25) {
      const merged = new Map(nextCaptures.map((capture) => [capture.id, capture]));
      for (const capture of existingCaptures) if (!merged.has(capture.id)) merged.set(capture.id, capture);
      _skillsCognitionState.captures = Array.from(merged.values());
    } else {
      _skillsCognitionState.captures = nextCaptures;
      _skillsCognitionState.captureNextCursor = captures.value.nextCursor || null;
    }
    _skillsCognitionState.captureCounts = captures.value.counts || _skillsCognitionState.captureCounts;
  }
  if (recentCaptures.status === 'fulfilled' && recentCaptures.value?.ok) _skillsCognitionState.recentCaptures = recentCaptures.value.captures || [];
  if (teachingSignals.status === 'fulfilled' && teachingSignals.value?.ok) _skillsCognitionState.teachingSignals = teachingSignals.value.signals || [];
  _skillsCognitionState.captureSettings = captureSettings.status === 'fulfilled' && captureSettings.value?.ok ? captureSettings.value.settings : _skillsCognitionState.captureSettings;
  _skillsCognitionState.captureModel = captureSettings.status === 'fulfilled' && captureSettings.value?.ok ? captureSettings.value.model : _skillsCognitionState.captureModel;
  _skillsCognitionState.loadErrors = [
    ['dashboard', dashboard],
    ['recallCandidates', recallCandidates],
    ['assets', assets],
    ['sources', sources],
    ...(captureResultIsCurrent ? [['captures', captures]] : []),
    ['recentCaptures', recentCaptures],
    ['teachingSignals', teachingSignals],
    ['captureSettings', captureSettings],
  ].filter(([, result]) => result.status !== 'fulfilled' || !result.value?.ok).map(([name]) => name);
  _skillsCognitionState.loadedAt = Date.now();
  _skillsCognitionState.loading = false;
  renderSkillsCognitionOverview();
  if (_skillsCognitionState.page === 'sources') renderSkillsCognitionSources();
  if (_skillsCognitionState.page === 'captures') renderSkillsCognitionCaptures();
  if (_skillsCognitionState.page === 'assets') renderSkillsCognitionAssets();
  if (_skillsCognitionRefreshTimer) clearTimeout(_skillsCognitionRefreshTimer);
  const visibleCaptures = [...(_skillsCognitionState.captures || []), ...(_skillsCognitionState.recentCaptures || [])];
  const captureInProgress = Number(_skillsCognitionState.captureCounts?.processing || 0) > 0
    || visibleCaptures.some((capture) => capture.status === 'queued' || capture.status === 'extracting' || capture.status === 'writing');
  if (captureInProgress) {
    _skillsCognitionRefreshTimer = setTimeout(() => {
      _skillsCognitionRefreshTimer = null;
      if (typeof currentView !== 'undefined' && currentView === 'recall') {
        loadSkillsCognitionSnapshot().catch(() => {});
      }
    }, 3000);
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
  // Withheld state leads the chip row: it explains why the card is inert, so it
  // has to be readable before the version/category chips.
  if (_isSkillWithheld(s)) {
    parts.unshift(
      `<span class="skill-card-chip is-withheld" title="${escapeHtml(t('skills.security_withheld_hint'))}">`
      + `${escapeHtml(t('skills.security_withheld'))}</span>`,
    );
  }
  return parts.join('');
}

/** True when the main process reported this skill as held back by the
 *  security-receipt check. Absent field = nothing to report (NOT "verified"). */
function _isSkillWithheld(s) {
  return !!(s && s.security && s.security.status === 'withheld');
}

/** "3 天前" for a scan timestamp. '' when absent, so callers can omit the clause
 *  rather than print a fake time. Mirrors connectors.js::_formatLastVerified. */
function _formatScannedAgo(iso) {
  const at = iso ? Date.parse(iso) : 0;
  if (!at || Number.isNaN(at)) return '';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return t('skills.security_scanned_just_now');
  if (mins < 60) return t('skills.security_scanned_minutes_ago', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('skills.security_scanned_hours_ago', { n: hours });
  return t('skills.security_scanned_days_ago', { n: Math.floor(hours / 24) });
}

/**
 * Shield badge for a marketplace skill's security state.
 *
 * Deliberately quiet for the healthy case: a filled shield with no text, so the
 * row reads as "checked" at a glance without competing with the skill's own
 * metadata. Only `withheld` gets a worded chip (see `_skillCardChipsHtml`),
 * because that is the one state the user has to act on.
 *
 * The tooltip carries the audit detail — verdict, when it was scanned, and the
 * validator build — so "was this actually checked, and when" is answerable
 * without a separate panel.
 */
function _skillSecurityBadgeHtml(s) {
  const sec = s && s.security;
  if (!sec || !sec.status) return '';
  const status = String(sec.status);
  // Withheld already renders as a worded chip; a second marker would be noise.
  if (status === 'withheld') return '';

  const ago = _formatScannedAgo(sec.scannedAt);
  const lines = [];
  if (status === 'verified') lines.push(t('skills.security_verified'));
  else if (status === 'risk') lines.push(t('skills.security_risk'));
  else lines.push(t('skills.security_unchecked'));
  if (ago) lines.push(ago);
  if (status === 'risk' && sec.findingCount) {
    lines.push(t('skills.security_findings', { n: sec.findingCount }));
  }
  // Deep-scan score, when a deep scan produced this verdict. Shown before the
  // version lines because it is the part a user can actually judge.
  if (typeof sec.securityScore === 'number') {
    lines.push(t('skills.security_score', { n: sec.securityScore }));
  }
  // Disclosures, not decorations. A verdict from fallback rules or a
  // non-isolated run has weaker standing than a clean isolated pass, and the
  // spec forbids presenting a degraded check as an unqualified one — so both
  // caveats are stated on the badge rather than left to a details pane the user
  // may never open.
  if (sec.rulesDegraded) lines.push(t('skills.security_rules_degraded'));
  if (sec.isolated === false) lines.push(t('skills.security_not_isolated'));
  // Which rule set stood behind the verdict. Stated because a `local` pass and a
  // `deep` pass are not equivalent — the local subset is regex-only and passes
  // payloads the full scanner blocks — so a badge that looked identical for both
  // would overstate the weaker one. Absent on older receipts, which record no
  // depth; those simply omit the line rather than claiming either.
  if (sec.scanner === 'deep') lines.push(t('skills.security_scanner_deep'));
  else if (sec.scanner === 'local') lines.push(t('skills.security_scanner_local'));
  if (sec.rulesetVersion) {
    lines.push(t('skills.security_ruleset', { version: sec.rulesetVersion }));
  } else if (sec.validatorVersion) {
    lines.push(t('skills.security_validator', { version: sec.validatorVersion }));
  }
  // A degraded-rules pass gets the risk styling rather than the clean one: the
  // colour is the only part most users read, so it must not say "fine" when the
  // check behind it was weakened. A `local`-only pass is the same situation by a
  // different route — the deep scanner never ran, and that subset clears content
  // the full ruleset blocks — so it is toned down too. `deep` and older receipts
  // with no recorded depth keep the plain verdict colour.
  const weakened = sec.rulesDegraded || sec.scanner === 'local';
  const tone = weakened && status === 'verified' ? 'risk' : status;
  // A button, not a decorative span: the same disclosures are available on hover
  // as a tooltip, but hover is unreachable by keyboard and by touch, and the
  // attack-surface breakdown is too long for a title attribute. Clicking opens
  // the full panel.
  return `<button type="button" class="skill-card-shield is-${escapeHtml(tone)}"`
    + ` data-skill-security="${escapeHtml(String(s.id || ''))}"`
    + ` title="${escapeHtml(lines.join(' · '))}" aria-label="${escapeHtml(lines.join(' · '))}">🛡</button>`;
}

/**
 * Compose the security detail panel for one skill.
 *
 * Text rather than markup: it goes through `uiAlert`, which escapes its input —
 * so this inherits the existing modal's focus trap, Escape handling and IME
 * guard instead of hand-rolling another dialog.
 *
 * Every line is omitted when its datum is absent. A panel that printed
 * "score —" or "egress 0" for a receipt that never recorded either would assert
 * a measurement that was not taken; absent and zero are different claims.
 */
function _skillSecurityPanelText(s) {
  const sec = (s && s.security) || {};
  const L = [];

  const verdict = sec.status === 'withheld' ? t('skills.security_withheld')
    : sec.status === 'risk' ? t('skills.security_risk')
      : sec.status === 'verified' ? t('skills.security_verified')
        : t('skills.security_unchecked');
  L.push(verdict);
  if (typeof sec.securityScore === 'number') {
    L.push(`${t('skills.secpanel_score')}: ${sec.securityScore}/100`);
  }
  // Why a previously-good verdict stopped applying, e.g. the payload changed
  // after install. Only withheld receipts carry it.
  if (sec.status === 'withheld') L.push(t('skills.security_withheld_hint'));
  L.push('');

  if (sec.scanner === 'deep') L.push(`${t('skills.secpanel_method')}: ${t('skills.security_scanner_deep')}`);
  else if (sec.scanner === 'local') L.push(`${t('skills.secpanel_method')}: ${t('skills.security_scanner_local')}`);
  if (sec.rulesDegraded) L.push(t('skills.security_rules_degraded'));
  if (sec.rulesetVersion) L.push(`${t('skills.secpanel_ruleset')}: ${sec.rulesetVersion}`);
  if (sec.scannerVersion) L.push(`${t('skills.secpanel_scanner')}: ${sec.scannerVersion}`);
  else if (sec.validatorVersion) L.push(`${t('skills.secpanel_scanner')}: ${sec.validatorVersion}`);
  if (typeof sec.isolated === 'boolean') {
    L.push(`${t('skills.secpanel_isolation')}: `
      + (sec.isolated ? t('skills.secpanel_isolated_yes') : t('skills.secpanel_isolated_no')));
  }
  const ago = _formatScannedAgo(sec.scannedAt);
  if (ago) L.push(`${t('skills.secpanel_checked_at')}: ${ago}`);

  const surf = sec.attackSurface;
  if (surf) {
    L.push('');
    L.push(t('skills.secpanel_surface'));
    const rows = [
      [t('skills.secpanel_egress'), surf.egressPoints],
      [t('skills.secpanel_dynexec'), surf.dynamicExecPoints],
      [t('skills.secpanel_persist'), surf.persistencePoints],
    ];
    const anyFound = rows.some(([, n]) => n > 0) || surf.hasBinaries;
    if (!anyFound) {
      L.push(`  ${t('skills.secpanel_surface_clean')}`);
    } else {
      for (const [label, n] of rows) L.push(`  ${label}: ${n}`);
      // Boolean upstream, so it is listed as a present/absent fact rather than a
      // count — printing "1" would invent a number the scanner did not report.
      if (surf.hasBinaries) L.push(`  ${t('skills.secpanel_binaries')}`);
      // The engine truncates each category at 20, so a displayed count can
      // understate reality. Say so rather than presenting it as exact.
      L.push(`  ${t('skills.secpanel_surface_floor')}`);
    }
    L.push(`  ${t('skills.secpanel_surface_note')}`);
  }

  // A user override outranks everything else in this panel: it is the one fact
  // that explains why a skill is present at all despite the gate refusing it.
  // Shown first so it is not buried under the surface counts.
  if (sec.userOverride) {
    L.push('');
    L.push(t('skills.secpanel_user_override'));
  }

  // Instruction-type risk. Shown separately from the attack surface because the
  // two measure different things and fail independently: the code rules can
  // return a clean 100 while the instruction layer has a finding, which is
  // exactly what a credential-harvesting skill written entirely in prose does.
  const instr = sec.instructionRisk;
  if (instr && instr.status !== 'clean') {
    L.push('');
    L.push(t('skills.secpanel_instruction'));
    if (instr.status === 'unavailable') {
      // Not "nothing found": passages were flagged and nobody read them. Saying
      // otherwise would repeat the mistake of rendering "not checked" as clean.
      L.push(`  ${t('skills.secpanel_instruction_unavailable')}`);
    } else {
      L.push(`  ${t('skills.secpanel_instruction_suspicious')}`);
    }
    // The passage itself, verbatim. This verdict is fuzzier than the code rules,
    // so the user gets the evidence rather than only a label — for most of these
    // one glance beats any threshold we could pick.
    for (const seg of (instr.segments || []).slice(0, 3)) {
      const where = `${seg.file}:${seg.line}`;
      const quote = String(seg.text || '').replace(/\s+/g, ' ').slice(0, 160);
      L.push(`  · ${where} — "${quote}"`);
    }
    if ((instr.segments || []).length > 3) {
      L.push(`  ${t('skills.secpanel_instruction_more')
        .replace('{n}', String(instr.segments.length - 3))}`);
    }
    L.push(`  ${t('skills.secpanel_instruction_note')}`);
  }

  // NSEAP declaration check: what the skill's security manifest claims versus
  // what its tree contains. Last in the panel, and deliberately quieter than the
  // blocks above: those report what the skill might DO, this reports whether its
  // paperwork is complete. A mismatch is an authoring defect, so it must not be
  // dressed up in the same language as a finding.
  //
  // `absent` and `pass` both render nothing, for opposite reasons. No shipped
  // skill carries a security manifest today, so printing `absent` would add a
  // line to every skill in the library that reads as a defect while describing
  // one that does not exist. `pass` is silent because a panel that says "nothing
  // wrong" for each check that passed buries the one line that matters.
  const nseap = sec.nseapDeclaration;
  if (nseap && nseap.status !== 'absent' && nseap.status !== 'pass') {
    L.push('');
    L.push(t('skills.secpanel_nseap'));
    if (nseap.status === 'unavailable') {
      // The engine could not run. Distinct from "checked and found nothing":
      // reporting infrastructure failure as a clean result is the same error as
      // rendering "not checked" as safe.
      L.push(`  ${t('skills.secpanel_nseap_unavailable')}`);
    } else if (nseap.status === 'mismatch') {
      L.push(`  ${t('skills.secpanel_nseap_mismatch')}`);
    } else if (nseap.status === 'needs_input') {
      L.push(`  ${t('skills.secpanel_nseap_needs_input')}`);
    } else {
      L.push(`  ${t('skills.secpanel_nseap_warnings')}`);
    }
    // Rule id plus message, capped. The id is what makes a gap actionable — the
    // author can look it up — while the message alone often is not.
    for (const f of (nseap.findings || []).slice(0, 3)) {
      const msg = String(f.message || '').replace(/\s+/g, ' ').slice(0, 160);
      L.push(`  · ${f.ruleId}${msg ? ` — ${msg}` : ''}`);
    }
    if ((nseap.findings || []).length > 3) {
      L.push(`  ${t('skills.secpanel_nseap_more')
        .replace('{n}', String(nseap.findings.length - 3))}`);
    }
    L.push(`  ${t('skills.secpanel_nseap_note')}`);
  }

  if (!sec.status || sec.status === 'unchecked') {
    L.push('');
    L.push(t('skills.secpanel_no_record'));
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One-line rollup above the grid: how many installed skills are verified, and
 * whether any need attention.
 *
 * Exists so the mechanism is visible when nothing is wrong. Without it the only
 * evidence the checks run at all is a card going amber, which means the feature
 * looks like it does nothing right up until it blocks something.
 *
 * Returns '' when there are no marketplace skills — nothing to summarize, and an
 * empty "0 verified" line would just be clutter.
 */
function _skillsSecuritySummaryHtml(skills) {
  const rows = (skills || []).filter((s) => s && s.security && s.security.status);
  if (!rows.length) return '';
  const counts = { verified: 0, risk: 0, withheld: 0, unchecked: 0 };
  for (const s of rows) {
    const k = String(s.security.status);
    if (counts[k] !== undefined) counts[k] += 1;
  }
  const parts = [t('skills.security_summary_verified', { n: counts.verified })];
  if (counts.risk) parts.push(t('skills.security_summary_risk', { n: counts.risk }));
  if (counts.withheld) parts.push(t('skills.security_summary_withheld', { n: counts.withheld }));
  if (counts.unchecked) parts.push(t('skills.security_summary_unchecked', { n: counts.unchecked }));
  const attention = counts.withheld > 0;
  return `<div class="skills-security-summary${attention ? ' needs-attention' : ''}">`
    + `<span class="skills-security-summary-text">${escapeHtml(parts.join(' · '))}</span>`
    + `<button type="button" class="skills-security-recheck" data-skills-recheck>`
    + `${escapeHtml(t('skills.security_recheck'))}</button>`
    + `</div>`;
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
    const openRes = await window.cogseed.invoke('skills.listOpen');
    _openSkillsCache = (openRes && openRes.ok && Array.isArray(openRes.skills)) ? openRes.skills : [];
  } catch { _openSkillsCache = []; }
}

async function _refreshPackagesCache() {
  try {
    const res = await window.cogseed.invoke('packages.list');
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
    const res = await window.cogseed.invoke('skills.listPrivate');
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
    const withheld = _isSkillWithheld(s);
    const usable = enabled && !withheld;
    const thisUseTitle = withheld ? escapeHtml(t('skills.security_withheld_hint')) : useTitle;
    return `
      <div class="skill-card${enabled ? '' : ' is-disabled'}${withheld ? ' is-withheld' : ''}" data-id="${escapeHtml(s.id)}" data-source="${escapeHtml(s.source || '')}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(s.name)}</span>
          ${_skillSecurityBadgeHtml(s)}
          ${moreBtn}
        </div>
        <div class="${descClass}">${escapeHtml(descText)}</div>
        <div class="skill-card-actions">
          ${cardChips}
          <button type="button" class="skill-card-use" data-skill-use title="${thisUseTitle}" aria-label="${thisUseTitle}" ${usable ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>
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
  gridEl.innerHTML = _skillsSecuritySummaryHtml(filtered)
    + sectionHtml(customChipLabel, groups.custom)
    + sectionHtml(marketplaceGroupLabel, groups.marketplace)
    + privateHtml
    + _openSkillsSectionHtml();
  _wireOpenSkillCards(gridEl);
  _wireSkillsSecurityRecheck(gridEl);
  _wireSkillSecurityPanels(gridEl);

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
        if (!card.classList.contains('is-disabled') && !card.classList.contains('is-withheld')) {
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

/** Re-run trust verification without spawning one scanner per skill at once. */
function _wireSkillsSecurityRecheck(gridEl) {
  const btn = gridEl.querySelector('[data-skills-recheck]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.textContent;
    btn.textContent = t('skills.security_rechecking');
    try {
      const ids = (_skillsCache || [])
        .filter((s) => s && s.security && s.security.status)
        .map((s) => s.id);
      for (const id of ids) {
        try {
          await window.orkas.invoke('skills.trust.reverify', { skillId: id });
        } catch { /* one unreadable skill must not abort the sweep */ }
      }
      await loadSkills(true);
    } catch {
      btn.textContent = original;
    } finally {
      btn.dataset.busy = '';
    }
  });
}

function _wireSkillSecurityPanels(gridEl) {
  for (const btn of gridEl.querySelectorAll('[data-skill-security]')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.dataset.skillSecurity || '';
      const skill = (_skillsCache || []).find((s) => s && String(s.id) === id);
      if (!skill) return;
      const heading = `${skill.name || id} · ${t('skills.secpanel_title')}`;
      await uiAlert(`${heading}\n\n${_skillSecurityPanelText(skill)}`);
    });
  }
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
    const res = await window.cogseed.invoke('skills.setEnabled', { id, enabled: nextEnabled });
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
      window.cogseed.invoke('skills.setEnabled', { id, enabled: nextEnabled })
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
    const res = await window.cogseed.invoke('packages.action', { command, name: packageName });
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
    const res = await window.cogseed.invoke('skills.setEnabled', { id: skillId, enabled: nextEnabled });
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
      const r = await window.cogseed.invoke('skills.discardImportDraft', { id: draftId });
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
        const res = await window.cogseed.invoke('skills.update', {
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
  // CogSeed skill frontmatter is intentionally tiny: name, bilingual
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
      const data = await window.cogseed.invoke('skills.updateForEdit', {
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

function _nseapDeclarationLines(nseap) {
  if (!nseap) return [];
  const out = [];
  if (nseap.status === 'unavailable') out.push(`• ${t('skills.secpanel_nseap_unavailable')}`);
  else if (nseap.status === 'mismatch') out.push(`• ${t('skills.secpanel_nseap_mismatch')}`);
  else if (nseap.status === 'needs_input') out.push(`• ${t('skills.secpanel_nseap_needs_input')}`);
  else if (nseap.status === 'pass_with_warnings') out.push(`• ${t('skills.secpanel_nseap_warnings')}`);
  for (const f of (nseap.findings || []).slice(0, 6)) {
    out.push(`• ${f.ruleId}${f.message ? ` — ${f.message}` : ''}`);
  }
  return out;
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

    try {
      const precheck = await window.cogseed.invoke('skills.checkNseapDeclaration', {
        id: _skillEditSkillId,
      });
      const lines = _nseapDeclarationLines(precheck?.nseapDeclaration);
      if (lines.length) {
        const choice = typeof uiChoice === 'function'
          ? await uiChoice({
            title: t('skills.edit_nseap_precheck_title'),
            message: `${t('skills.edit_nseap_precheck_body')}\n\n${lines.join('\n')}`,
            choices: [
              { id: 'continue', label: t('skills.edit_nseap_precheck_continue'), style: 'primary' },
              { id: 'back', label: t('skills.edit_nseap_precheck_back'), style: '' },
            ],
          })
          : 'continue';
        if (choice !== 'continue') return;
      }
    } catch (_) { /* precheck is advisory */ }

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

async function _afterImportedSkill(data) {
  closeSkillModal();
  _skillsCache = null;
  await loadSkills();
  setView('skills');

  const skills = Array.isArray(data?.skills) ? data.skills : (data?.skill ? [data.skill] : []);
  const ids = skills.map((s) => String(s?.id || '')).filter(Boolean);
  const names = skills.map((s) => String(s?.name || s?.id || '')).filter(Boolean).join('、');

  const warnings = [];
  if (typeof readQualityReport === 'function') {
    for (const id of ids) {
      try {
        const report = await readQualityReport('skill', id);
        const violations = Array.isArray(report?.violations) ? report.violations : [];
        for (const v of violations) {
          if (!v) continue;
          warnings.push(`• ${String(v.rule || '')}${v.field ? ` · ${String(v.field)}` : ''}`);
        }
      } catch (_) { /* report is best-effort */ }
    }
  }

  const nseapWarnings = ids.flatMap((id) => {
    const cached = (_skillsCache || []).find((s) => String(s?.id || '') === id);
    return _nseapDeclarationLines(cached?.security?.nseapDeclaration);
  });

  const seen = new Set();
  const uniqueWarnings = warnings
    .filter((w) => {
      if (seen.has(w)) return false;
      seen.add(w);
      return true;
    })
    .slice(0, 8);
  const seenNseap = new Set();
  const uniqueNseapWarnings = nseapWarnings
    .filter((w) => {
      if (seenNseap.has(w)) return false;
      seenNseap.add(w);
      return true;
    })
    .slice(0, 8);

  const lines = [t('skills.import_review_body', { count: ids.length })];
  if (names) lines.push(`\n${names}`);
  if (uniqueWarnings.length) {
    lines.push(`\n${t('skills.import_review_issues')}\n${uniqueWarnings.join('\n')}`);
  }
  if (uniqueNseapWarnings.length) {
    lines.push(`\n${t('skills.import_review_nseap_issues')}\n${uniqueNseapWarnings.join('\n')}`);
  }
  if (!uniqueWarnings.length && !uniqueNseapWarnings.length) {
    lines.push(`\n${t('skills.import_review_no_issues')}`);
  }

  const choice = typeof uiChoice === 'function'
    ? await uiChoice({
      title: t('skills.import_review_title'),
      message: lines.join('\n'),
      choices: [
        { id: 'keep', label: t('skills.import_review_keep'), style: 'primary' },
        { id: 'discard', label: t('skills.import_review_discard'), style: 'danger' },
      ],
    })
    : 'keep';

  if (choice !== 'discard') return;

  await Promise.allSettled(ids.map((id) => apiFetch(`/api/skills/${id}`, { method: 'DELETE' })));
  _skillsCache = null;
  await loadSkills();
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
      ? await window.cogseed.invoke('skills.builtin.delete', { id: sid })
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
