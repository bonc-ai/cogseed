/* ============================================================================
 * 认知资产 · 视图层：认知生长页（cognition-assets/review-views.js）
 *
 * 收敛：认知生长只承接已形成的夜间认知建议和真实处理历史。
 * viewActivity 提供需要关注（默认）与已处理两个视角：
 *  - 需要关注：夜间价值判断通过、提取完成且证据齐全的具体认知建议。
 *  - 已处理：保留候选的真实终态与历史；后台任务和治理问题不入列。
 * 候选详情（route.candidateId）复用 review-candidate.js 的 viewCandidate。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets;
  if (!NS) return;
  const { T, esc, fmtDate } = NS;
  const S = NS.store;
  const { btn, empty, chip } = NS.ui;
  const {
    evidenceMostlyUnavailable,
    title: candidateTitle,
  } = NS.candidate;

  /* ────────────────────────── 视图：认知生长 ────────────────────────── */

  const normalizeActivityText = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  function activityScope(scope) {
    const key = ['general', 'personal', 'report', 'code', 'review', 'product'].includes(scope) ? 'cognition.capture.scope_' + scope : '';
    return key ? T(key, scope) : scope || T('cognition.activity_scope_unknown', '范围待核对');
  }
  const activityDecisionLabels = {
    create: ['cognition.activity_decision_create', '确认保存'], update: ['cognition.activity_decision_update', '核对更新'],
    limit_scope: ['cognition.activity_decision_limit_scope', '核对范围'], pause: ['cognition.activity_decision_pause', '确认停用'],
    keep_current: ['cognition.activity_decision_keep_current', '确认保留现有内容'], reject: ['cognition.activity_decision_reject', '确认忽略'],
  };
  const activityOutcomeLabels = {
    confirmed: ['cognition.activity_outcome_confirmed', '已保存'], integrated: ['cognition.activity_outcome_integrated', '已纳入本体'],
    rejected: ['cognition.activity_outcome_rejected', '已拒绝'], ignored: ['cognition.activity_outcome_ignored', '已忽略'], superseded: ['cognition.candidate_status_expired', '已失效'], expired: ['cognition.activity_outcome_expired', '已过期'],
    update: ['cognition.activity_outcome_update', '已更新'], limit_scope: ['cognition.activity_outcome_limit_scope', '已调整范围'], pause: ['cognition.activity_outcome_pause', '已停用'],
    keep_current: ['cognition.activity_outcome_keep_current', '已保留现有内容'], reject: ['cognition.activity_outcome_reject', '已忽略'],
  };
  function activityResult(candidate, waiting) {
    if (candidate.contentPurgedAt) return T('cognition.content_purged', '内容已清除');
    if (candidate.organizationReceipt?.undoneAt) return T('cognition.organization_undone', '本次整理已撤销');
    if (!waiting) {
      // A proposed action describes intent, not the recorded outcome of a completed write.
      if (candidate.status === 'confirmed' && !candidate.promotedAssetId && !candidate.organizationReceipt)
        return T('cognition.activity_result_unlocated', '保存结果待核对');
      const label = activityOutcomeLabels[candidate.status];
      return label ? T(label[0], label[1]) : T('cognition.activity_check', '需要核对');
    }
    if (NS.candidate.saveOutcomeUncertain(candidate)) return T('cognition.activity_result_unlocated', '保存结果待核对');
    const caps = candidate.capabilities || {};
    const reasons = caps.ineligibleReasons || [];
    const target = (S.assets || []).find(asset => String(asset.id) === String(candidate.targetAssetId));
    if (S.candidateVersionConflict?.candidateId === candidate.id || (target && candidate.targetVersionUsed
      && String(target.activeVersion || target.version) !== String(candidate.targetVersionUsed)))
      return T('cognition.activity_attention_version', '需重核版本');
    if (reasons.includes('type_conflicts_with_existing')) return T('cognition.activity_attention_conflict', '需裁定冲突');
    if (reasons.some(reason => ['rule_boundary_required', 'rule_missing_boundary'].includes(reason))) return T('cognition.activity_attention_boundary', '需补充边界');
    if (caps.displayState === 'weak_evidence' || evidenceMostlyUnavailable(candidate) || reasons.includes('evidence_missing'))
      return T('cognition.activity_attention_evidence', '需补充或核对证据');
    if (caps.eligibility === 'ineligible') return T('cognition.activity_attention_content', '需修改内容后重核');
    const label = activityDecisionLabels[candidate.suggestedAction || 'create'];
    return label ? T(label[0], label[1]) : T('cognition.activity_check', '需要核对');
  }
  function activityModel(runFilter) {
    const attention = [], done = [];
    const candidates = (S.candidates || []).filter(c => !runFilter || runFilter.candidates.has(String(c.id)));
    const excluded = new Set(candidates.filter(c => c.activityExclusionReason || NS.isKstarCandidate?.(c)).map(c => c.id));
    const decisionGroups = new Map();
    const sorted = [...candidates].sort((a,b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    for (const c of sorted) {
      if (excluded.has(c.id)) continue;
      const waiting = NS.candidate.attentionReady(c);
      if (!waiting && !c.contentPurgedAt && !['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(c.status)) continue;
      if (!c.contentPurgedAt && c.status === 'weak_observation' && !c.capabilities?.countsAsPending) continue;
      const action = c.suggestedAction || 'create';
      const result = activityResult(c, waiting);
      const activityAt = waiting ? c.createdAt || c.updatedAt || '' : c.updatedAt || c.createdAt || '';
      const proposedText = c.proposalTarget === 'ontology' ? (c.ontologyFormation?.previewChanges || []).map(change => change.after?.description || change.after?.requirement || '').filter(Boolean).join('；') : '';
      const kind = c.contentOrganization || c.stockOrganizationProvenance ? 'organize'
        : (c.suggestedAction && c.suggestedAction !== 'create') ? 'update' : 'add';
      const assetIds = [...new Set([c.targetAssetId, c.mergedIntoAssetId,
        ...(c.contentOrganization?.draft.sourceAssetIds || [])].filter(Boolean).map(String))];
      const row = { key: 'candidate:' + c.id, title: candidateTitle(c), detail: proposedText || c.judgment || c.value || '', scope: activityScope(c.suggestedScope), rawAt: activityAt, at: fmtDate(activityAt), result: waiting && (c.activityDeferredAt || c.capabilities?.isSnoozed) ? T('cognition.activity_deferred_result', '稍后 · 待处理') + ' · ' + result : result, route: { candidateId: c.id }, candidateIds: [c.id], kind, source: c.stockOrganizationProvenance ? 'inspection' : 'discovery', assetIds };
      // 只折叠完全相同、同范围且同治理边界的建议；不同冲突/版本/风险绝不能合并。
      const hasConflict = (S.inbox || []).some(item => item.candidateId === c.id && item.kind !== 'candidate_pending_review');
      const identity = waiting && !hasConflict && !NS.candidate.saveOutcomeUncertain(c) ? JSON.stringify([normalizeActivityText(c.judgment), c.suggestedType, normalizeActivityText(c.suggestedScope), action, c.targetAssetId, c.targetVersionUsed, c.scopePolicy, c.applicableWhen, c.forbiddenWhen, c.risk, c.capabilities?.displayState, c.capabilities?.eligibility, c.ontologyFormation, c.contentOrganization?.operationId])
        : !waiting && c.reviewDecisionId ? JSON.stringify(['decision', c.reviewDecisionId, c.promotedAssetId || c.targetAssetId, c.suggestedType, c.suggestedScope, normalizeActivityText(c.judgment)]) : row.key;
      const previous = decisionGroups.get(identity);
      if (previous) { previous.candidateIds.push(c.id); continue; }
      decisionGroups.set(identity, row);
      (waiting ? attention : done).push(row);
    }
    const assetTitle = assetId => (S.assets || []).find(asset => String(asset.id) === String(assetId))?.title || '';
    const inspectionAt = S.captureStats?.sweep?.lastResult?.finishedAt || S.captureStats?.sweep?.lastRunAt || '';
    for (const item of S.inbox || []) {
      if (item.kind !== 'inspection_finding') continue;
      if (runFilter && !runFilter.findings.has(String(item.id))) continue;
      const category = item.findingCategory;
      const title = (item.assetIds || []).map(assetTitle).filter(Boolean).join(' / ')
        || item.title || T('cognition.activity_inbox_untitled', '巡检发现');
      const kind = category === 'conflict' ? 'conflict' : category === 'outdated' ? 'outdated' : 'organize';
      attention.push({
        key: `inbox:${item.id}`,
        title,
        detail: item.detail || '',
        scope: T('cognition.activity_scope_assets', '已有内容'),
        rawAt: inspectionAt,
        at: inspectionAt ? fmtDate(inspectionAt) : '',
        result: item.deferred ? T('cognition.activity_deferred_result', '稍后 · 待处理') : T('cognition.activity_inbox_pending', '巡检发现 · 待处理'),
        route: { inboxId: item.id },
        candidateIds: [],
        kind,
        source: 'inspection',
        assetIds: [...(item.assetIds || [])],
      });
    }
    for (const item of S.inboxResolved || []) {
      if (item.kind !== 'inspection_finding') continue;
      if (runFilter && !runFilter.findings.has(String(item.id))) continue;
      const category = item.findingCategory;
      const title = (item.assetIds || []).map(assetTitle).filter(Boolean).join(' / ')
        || item.title || T('cognition.activity_inbox_untitled', '巡检发现');
      const kind = category === 'conflict' ? 'conflict' : category === 'outdated' ? 'outdated' : 'organize';
      done.push({
        key: `inbox:${item.id}`,
        title,
        detail: item.detail || '',
        scope: T('cognition.activity_scope_assets', '已有内容'),
        rawAt: item.at || '',
        at: item.at ? fmtDate(item.at) : '',
        result: T('cognition.activity_inbox_dismissed', '不再提醒'),
        route: { inboxId: item.id },
        candidateIds: [],
        kind,
        source: 'inspection',
        assetIds: [...(item.assetIds || [])],
      });
    }
    // Asset update approvals already have their own version-checked decision service.
    // Project them directly; never manufacture nightly extraction provenance.
    for (const proposal of S.assetApprovals || []) {
      if (runFilter) continue;
      if (!proposal?.id || !proposal.assetId || !proposal.payload || !Array.isArray(proposal.fields)
        || !['pending', 'deferred', 'confirmed', 'rejected', 'superseded'].includes(proposal.state)) continue;
      const asset = (S.assets || []).find(item => String(item.id) === String(proposal.assetId));
      const waiting = !proposal.contentPurgedAt && ['pending', 'deferred'].includes(proposal.state);
      const label = proposal.contentPurgedAt ? T('cognition.content_purged', '内容已清除') : proposal.state === 'confirmed' ? T('cognition.activity_outcome_update', '已更新')
        : proposal.state === 'rejected' ? T('cognition.inbox_action_reject', '拒绝')
          : proposal.state === 'superseded' ? T('cognition.candidate_status_expired', '已失效')
            : proposal.state === 'deferred' ? T('cognition.activity_deferred_result', '稍后 · 待处理')
              : T('cognition.candidate_status_pending', '待确认');
      const at = waiting ? proposal.createdAt : proposal.decidedAt || proposal.createdAt;
      (waiting ? attention : done).push({ key: 'approval:' + proposal.id,
        title: proposal.contentPurgedAt ? T('cognition.content_purged', '内容已清除') : asset?.title || proposal.assetId, detail: proposal.reason, scope: activityScope(asset?.scope),
        result: label, rawAt: at, at: fmtDate(at), route: { approvalId: proposal.id }, candidateIds: [],
        kind: 'update', source: 'approval', assetIds: [String(proposal.assetId)],
      });
    }
    // 本体逐次保存历史只在对应对象的详情查看；共同确认结果由候选的 integrated 记录承载。
    const rows = [...attention, ...done];
    for (const row of rows) {
      const ids = new Set(row.assetIds || []);
      if (!ids.size) { row.relatedSuggestionIds = []; continue; }
      row.relatedSuggestionIds = rows
        .filter(other => other.key !== row.key && (other.assetIds || []).some(id => ids.has(String(id))))
        .map(other => other.key)
        .slice(0, 4);
    }
    return { attention, done, excludedCount: excluded.size };
  }
  NS.activityModel = activityModel;

  const ACTIVITY_PAGE_SIZE = 50;
  const ACTIVITY_ACTIONS = Object.freeze(['activity-edit', 'activity-edit-cancel', 'activity-select', 'activity-tab', 'activity-clear', 'activity-page-select', 'activity-close', 'activity-expand', 'activity-expand-close', 'activity-next', 'activity-save-draft', 'activity-defer', 'activity-history', 'activity-undo-automatic', 'activity-undo-organization', 'activity-approval', 'formation-recheck', 'activity-inbox', 'activity-filter']);
  const ACTIVITY_WRITE_ACTIONS = Object.freeze(['activity-save-draft', 'activity-defer']);
  const activityDrafts = new Map();
  const activityEditors = new Set();
  const activityReadingPositions = new Map();
  let activitySelection = '';
  let activityDrawer = false;
  let activityExpanded = false;
  let activityRendered = false;
  let activityWasNarrow = false;
  let activityQueryTimer;
  let activityFilterApis = [];
  let activityFilterFocus = '';
  const candidateFields = { contentCategory: 'contentCategory', judgment: 'judgment', value: 'value', uncertainty: 'uncertainty', summary: 'summary', scope: 'suggestedScope', applicable: 'applicableWhen', forbidden: 'forbiddenWhen' };
  const narrowActivity = () => !!window.matchMedia && window.matchMedia('(max-width: 1100px), (max-height: 500px)').matches;
  function focusAfterFrame(run) {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else run();
  }
  function blockingOverlay() {
    const modal = document.querySelector?.('.ui-modal:not([hidden]), .ca-modal:not([hidden])');
    if (modal) {
      if (typeof modal.getClientRects !== 'function') return true;
      if (!modal.closest?.('[hidden]') && modal.getClientRects().length) return true;
    }
    const viewer = document.querySelector?.('.chat-file-viewer.is-open');
    if (!viewer) return false;
    if (typeof viewer.getClientRects !== 'function') return true;
    return !viewer.closest?.('[hidden]') && viewer.getClientRects().length > 0;
  }
  const activityRoute = (patch = {}) => Object.assign({}, S.route, { name: 'activity', candidateId: '', inboxId: '', poCandidateId: '', captureId: '', approvalId: '' }, patch);
  function selectedActivityKey(route) {
    return route.approvalId ? 'approval:' + route.approvalId : route.candidateId ? 'candidate:' + route.candidateId : route.inboxId ? 'inbox:' + route.inboxId : route.poCandidateId ? 'legacy:' + route.poCandidateId : activitySelection;
  }
  function activityModelForRoute(route) {
    if (!route.activityRunId) return activityModel();
    const receipt = S.captureStats?.sweep?.receipt;
    const matching = receipt && String(receipt.runId) === String(route.activityRunId);
    const candidates = new Set(matching && Array.isArray(receipt.candidateIds) ? receipt.candidateIds.map(String) : []);
    const findings = new Set(matching && Array.isArray(receipt.findingKeys) ? receipt.findingKeys.map(key => 'inspection:' + String(key)) : []);
    return { ...activityModel({ candidates, findings }), runUnavailable: !matching };
  }
  function activityRowsFor(route, model = activityModelForRoute(route)) {
    const processed = route.activityView === 'done' || route.activityDone === '1';
    const query = normalizeActivityText(route.activityQuery).toLocaleLowerCase();
    const filter = String(route.activityFilter || 'all');
    return (processed ? model.done : model.attention).filter(row =>
      (filter === 'all' || row.kind === filter)
      && normalizeActivityText(row.title + ' ' + row.detail + ' ' + row.scope + ' ' + row.result).toLocaleLowerCase().includes(query))
      .sort((a,b) => String(b.rawAt).localeCompare(String(a.rawAt)));
  }
  function activityCandidate(row, processed) {
    const original = S.candidates.find(c => String(c.id) === String(row.route.candidateId));
    if (!original) return '';
    const draft = activityDrafts.get(String(original.id));
    const candidate = Object.assign({}, original, draft || {});
    // A processed record stays read-only even if a stale server snapshot carries old capabilities.
    if (processed || !NS.candidate.attentionReady(original)) candidate.capabilities = Object.assign({}, candidate.capabilities, { canEdit: false, canPromote: false, canReject: false, canContinueOntology: false, isTerminal: processed || !!original.capabilities?.isTerminal });
    const actor = original.processingActor;
    const reason = original.processingReason || original.decisionNote;
    const processing = processed ? `<div class="ca-activity-processing" role="status"><strong>${esc(row.result)} · ${esc(T('cognition.activity_readonly', '本记录为只读'))}</strong><p>${esc(T('cognition.activity_actor', '处理者'))}：${esc(actor || T('cognition.activity_actor_unknown', '历史记录未提供'))}</p><p>${esc(T('cognition.activity_reason', '处理依据'))}：${esc(reason || T('cognition.activity_reason_unknown', '历史记录未提供处理依据'))}</p></div>` : '';
    return NS.candidate.formCard(candidate, { compact: true, editing: activityEditors.has(String(candidate.id)), processing }) + (row.candidateIds.length > 1 ? `<p class="note">${esc(T('cognition.activity_related_proposals', '相同建议已在列表合并，原始建议和来源仍分别保留。'))} ${esc(String(row.candidateIds.length))}</p>` : '');
  }
  const approvalFields = ['value', 'statement', 'scope', 'applicableWhen', 'forbiddenWhen', 'tags'];
  function readableApproval(proposal) {
    if (proposal.contentPurgedAt) return false;
    const fields = [...new Set([...(proposal.fields || []), ...Object.keys(proposal.payload || {})])];
    return fields.length > 0 && fields.every(key => approvalFields.includes(key));
  }
  function activityApproval(row, processed) {
    const proposal = (S.assetApprovals || []).find(item => String(item.id) === String(row.route.approvalId));
    if (!proposal) return '';
    if (proposal.contentPurgedAt) return `<p role="status">${esc(T('cognition.content_purged_note', '关联资产的内容已清除。此记录保留处理状态，不能编辑、确认或恢复内容。'))}</p>`;
    const asset = (S.assets || []).find(item => String(item.id) === String(proposal.assetId));
    const read = (label, value) => `<dl class="ca-approval-fact"><dt>${esc(label)}</dt><dd class="content-text">${esc(Array.isArray(value) ? value.join('；') : value || T('cognition.activity_not_recorded', '未记录'))}</dd></dl>`;
    const labels = {
      value: T('cognition.detail_future_use', '用途'),
      statement: T('cognition.asset_version_diff_statement', '正文'), scope: T('cognition.asset_version_diff_scope', '适用范围'),
      applicableWhen: T('cognition.asset_version_applicable', '适用场景'), forbiddenWhen: T('cognition.asset_version_forbidden', '禁用场景'),
      tags: T('cognition.asset_edit_field_tags', '标签'),
    };
    const related = proposed => proposed ? NS.ui.cognitionRelated(proposed) : '';
    const target = asset ? T('cognition.activity_approval_target', '目标：{title} · 当前 v{current} · 提议基于 v{baseline}', { title: asset.title, current: asset.version, baseline: proposal.baselineActiveVersion || proposal.baselineVersion }) : T('cognition.activity_target_missing', '未读到目标资产');
    const requestedFields = [...new Set([...proposal.fields, ...Object.keys(proposal.payload)])];
    const fields = requestedFields.filter(key => Object.prototype.hasOwnProperty.call(labels, key));
    const baseline = NS.ui.versionContent(proposal.assetId, proposal.baselineActiveVersion || proposal.baselineVersion);
    const saved = proposal.state === 'confirmed' ? NS.ui.savedDecisionContent('approval', proposal) : null;
    const proposed = proposal.state === 'confirmed' ? saved?.content : baseline ? { ...baseline, ...proposal.payload } : null;
    const canConfirm = !!baseline && readableApproval(proposal) && !processed && !S.loading && !S.candidatesError && !S.assetsError && asset && ['active', 'paused'].includes(asset.status) && String(asset.version) === String(proposal.baselineVersion) && String(asset.activeVersion || asset.version) === String(proposal.baselineActiveVersion || proposal.baselineVersion);
    const blocked = !processed && !canConfirm ? `<p role="status">${esc(T('cognition.activity_approval_blocked', '目标资产不可用、版本已变化或清单读取失败，请刷新核对后再处理。'))}</p>` : '';
    return `${proposed ? NS.ui.cognitionContentFields(proposed, { part: 'body', omitUseHint: true }) : `<p role="status">${esc(T(proposal.state === 'confirmed' ? 'cognition.detail_saved_unavailable' : 'cognition.detail_baseline_unavailable', proposal.state === 'confirmed' ? '保存版本尚未读到，请读取版本记录后核对。' : '原版本内容不可用，请读取版本记录后核对。'))}</p>${btn(T('common.retry', '重试'), 'asset-versions-retry', { id: proposal.assetId })}`}
      <section class="ca-review-content"><h3>${esc(T('cognition.detail_changes', '本次变化'))}</h3><h4>${esc(T('cognition.formation_before', '修改前'))}</h4>${fields.map(key => read(labels[key], baseline?.[key] ?? proposal.beforeValues?.[key])).join('')}</section>
      ${NS.ui.cognitionSources(proposed?.evidenceRefs, 'asset:' + proposal.assetId, { fold: false, empty: proposed ? undefined : '',
        before: `<p class="content-text">${esc(proposal.reason)}</p>` })}
      ${proposed ? NS.ui.cognitionContentFields(proposed, { part: 'boundary', omitUseHint: true }) : ''}
      ${related(proposed) || ''}
      ${processed ? `<section class="ca-review-result"><h3>${esc(T('cognition.activity_result', '处理结果'))}</h3>${read(T('cognition.activity_result', '处理结果'), row.result)}${read(T('cognition.activity_time', '发生时间'), fmtDate(proposal.decidedAt || proposal.createdAt))}${saved?.version ? `<p class="note">${esc(T('cognition.detail_saved_version', '已保存 v{n}', { n: String(saved.version) }))}</p>` : ''}${saved?.assetId ? btn(T('cognition.candidate_detail_open_asset', '查看已保存资产'), 'go-inbox-asset', { id: saved.assetId, small: true }) : ''}</section>` : `<details class="details ca-review-impact"><summary>${esc(T('cognition.activity_impact_title', '保存的影响'))}</summary><p>${esc(T('cognition.activity_approval_impact', '批准后更新目标资产并记录新版本；稍后处理保留待审批状态，拒绝会关闭此提议。'))}</p><p class="note">${esc(T('cognition.activity_approval_origin', 'AI 提出的资产修改建议；是否生效以审批结果与版本记录为准。'))}</p></details>`}
      ${NS.ui.cognitionHistory(read(T('cognition.activity_target_label', '目标 / 版本'), target))}
      ${blocked}
      ${processed ? '' : `<div class="actions actions-right" data-activity-primary-actions>${btn(T('cognition.activity_save_update', '保存更新'), 'activity-approval', { id: proposal.id, data: { decision: 'confirm' }, primary: true, disabled: !canConfirm })}${btn(T('cognition.activity_defer', '稍后处理'), 'activity-approval', { id: proposal.id, data: { decision: 'defer' }, disabled: !!S.candidatesError })}${btn(T('cognition.inbox_action_reject', '拒绝'), 'activity-approval', { id: proposal.id, data: { decision: 'reject' }, danger: true, disabled: !!S.candidatesError })}</div>`}`;
  }
  function activityInbox(row, processed) {
    const item = [...(S.inbox || []), ...(S.inboxResolved || [])]
      .find(entry => String(entry.id) === String(row.route.inboxId));
    if (!item) return `<p role="status">${esc(T('cognition.activity_inbox_missing', '这条建议已处理或已刷新。'))}</p>${btn(T('common.refresh', '刷新'), 'refresh', { small: true })}`;
    const assets = (item.assetIds || [])
      .map(assetId => (S.assets || []).find(asset => String(asset.id) === String(assetId)))
      .filter(Boolean);
    const category = item.findingCategory;
    const categoryLabel = category === 'duplicate' ? T('cognition.activity_inbox_duplicate', '疑似重复')
      : category === 'conflict' ? T('cognition.activity_inbox_conflict', '类型冲突')
        : category === 'outdated' ? T('cognition.activity_inbox_outdated', '长期未更新')
          : T('cognition.activity_inbox_type', '巡检发现');
    const pair = category === 'duplicate' || category === 'conflict';
    const cards = assets.map(asset => `<div class="ca-inbox-asset">
      <strong>${esc(asset.title || asset.id)}</strong>
      <p class="note">${esc(String(asset.statement || '').slice(0, 240))}</p>
      <p class="note">${esc(T('cognition.activity_inbox_saved_version', '保存版本 v{n}', { n: String(asset.activeVersion || asset.version || '') }))}</p>
      ${pair && !processed ? `<div class="actions">${btn(T('cognition.activity_inbox_keep', '保留这条'), 'activity-inbox', { small: true, data: { id: item.id, action: 'keep', target: asset.id } })}${btn(T('cognition.activity_inbox_merge', '合并到这条'), 'activity-inbox', { small: true, data: { id: item.id, action: 'merge', target: asset.id } })}</div>` : ''}
    </div>`).join('');
    const actions = category === 'outdated'
      ? `<div class="actions actions-right">${assets[0] ? btn(T('cognition.activity_inbox_open', '去资产详情'), 'go-inbox-asset', { id: assets[0].id, small: true }) : ''}${btn(T('cognition.activity_defer', '稍后处理'), 'activity-inbox', { small: true, data: { id: item.id, action: 'defer' } })}${btn(T('cognition.inbox_action_reject', '不再提醒'), 'activity-inbox', { small: true, data: { id: item.id, action: 'reject' } })}</div>`
      : `<div class="actions actions-right">${btn(T('cognition.activity_defer', '稍后处理'), 'activity-inbox', { small: true, data: { id: item.id, action: 'defer' } })}${btn(T('cognition.inbox_action_reject', '不再提醒'), 'activity-inbox', { small: true, data: { id: item.id, action: 'reject' } })}</div>`;
    const related = (row.relatedSuggestionIds || []).length
      ? `<p class="note">${esc(T('cognition.activity_inbox_related', '这处内容还有 {n} 条可能相关的建议；处理前可先核对它们。', { n: String(row.relatedSuggestionIds.length) }))}</p>`
      : '';
    return `<p class="content-text">${esc(item.detail || '')}</p><p class="note">${esc(categoryLabel)}</p>${related}${cards}${processed ? '' : actions}`;
  }

  function activityChrome(presentation) {
    return NS.ui.detailTitleActions({
      expandAct: presentation === 'expanded' ? '' : 'activity-expand',
      closeAct: presentation === 'expanded' ? 'activity-expand-close' : 'activity-close',
    });
  }
  function activityDetail(row, processed, options = {}) {
    const chrome = activityChrome(options.presentation);
    if (!row) {
      if (S.route.approvalId) {
        const message = empty(
          T(S.loading ? 'cognition.activity_loading' : S.candidatesError ? 'cognition.review_load_failed_title' : 'cognition.activity_approval_missing', S.loading ? '正在读取活动…' : S.candidatesError ? '清单没能读取' : '这条提议暂不可用'),
          T('cognition.activity_approval_missing_hint', '请刷新核对；不会改为打开其他提议。'));
        return `<header class="ca-activity-detail-head ca-detail-head"><div class="ca-library-detail-title"><h2>${esc(T('cognition.activity_detail', '活动详情'))}</h2>${chrome}</div></header><div class="ca-activity-detail-body ca-detail-body" data-activity-key="approval:${esc(S.route.approvalId)}" role="${!S.loading && S.candidatesError ? 'alert' : 'status'}">${message}</div>`;
      }
      return '';
    }
    let content;
    if (row.route.candidateId) content = activityCandidate(row, processed);
    else if (row.route.approvalId) content = activityApproval(row, processed);
    else if (row.route.inboxId) content = activityInbox(row, processed);
    else content = '';
    let fixedActions = '';
    const actionPattern = (row.route.candidateId || row.route.approvalId) ? /<div class="actions actions-right" data-activity-primary-actions>([\s\S]*?)<\/div>/ : /<div class="actions actions-right">([\s\S]*?)<\/div>/;
    content = content.replace(actionPattern, (match, actions) => { fixedActions = actions; return ''; });
    const original = row.route.candidateId && S.candidates.find(item => String(item.id) === String(row.route.candidateId));
    const candidate = original ? Object.assign({}, original, processed ? {} : activityDrafts.get(String(original.id)) || {}) : null;
    const ontologyOnly = candidate?.proposalTarget === 'ontology';
    const ontologyChanges = candidate?.ontologyFormation?.previewChanges || [];
    const proposal = row.route.approvalId && (S.assetApprovals || []).find(item => item.id === row.route.approvalId);
    const inboxItem = row.route.inboxId && [...(S.inbox || []), ...(S.inboxResolved || [])]
      .find(item => String(item.id) === String(row.route.inboxId));
    const baseline = proposal && !proposal.contentPurgedAt && NS.ui.versionContent(proposal.assetId, proposal.baselineActiveVersion || proposal.baselineVersion);
    const saved = processed && !candidate?.contentPurgedAt && !proposal?.contentPurgedAt ? (candidate?.status === 'confirmed' && !candidate.contentOrganization ? NS.ui.savedDecisionContent('candidate', candidate) : proposal?.state === 'confirmed' ? NS.ui.savedDecisionContent('approval', proposal) : null) : null;
    const detailTitle = saved?.content.title || (ontologyOnly && ontologyChanges.length === 1 ? ontologyChanges[0].after?.name : '') || (candidate ? String(candidate.summary || row.title) : baseline?.title || row.title);
    const version = saved?.version || (ontologyOnly && ontologyChanges.length === 1 ? processed && candidate.status === 'integrated' ? ontologyChanges[0].after?.version : ontologyChanges[0].before?.version : '') || candidate?.targetVersionUsed || proposal?.baselineActiveVersion || proposal?.baselineVersion;
    const type = inboxItem ? T('cognition.activity_inbox_type', '巡检发现') : ontologyOnly ? T('cognition.ontology_record', '本体记录') : candidate ? NS.ui.contentCategoryLabel(candidate) : baseline ? NS.ui.contentCategoryLabel(baseline) : '';
    const subtitle = [version ? T(saved || (ontologyOnly && processed && candidate.status === 'integrated') ? 'cognition.detail_saved_version' : 'cognition.detail_based_version', saved || (ontologyOnly && processed && candidate.status === 'integrated') ? '已保存 v{n}' : '基于 v{n}', { n: String(version) }) : ''].filter(Boolean).join(' · ');
    const actionLabel = processed ? '' : inboxItem ? T('cognition.activity_inbox_action', '核对建议') : candidate ? NS.candidate.suggestedActionLabel(candidate) : proposal ? T('cognition.activity_operation_update', '建议更新') : '';
    const relatedHtml = !row.route.inboxId && (row.relatedSuggestionIds || []).length
      ? `<p class="note">${esc(T('cognition.activity_related_suggestions', '这处内容还有 {n} 条可能相关的建议；处理前可先核对它们。', { n: String(row.relatedSuggestionIds.length) }))}</p>`
      : '';
    return `<header class="ca-activity-detail-head ca-detail-head"><div class="ca-library-detail-title"><h2>${esc(detailTitle)}</h2>${chrome}</div><div class="ca-library-facts">${type ? window.uiTag({ label: type }) : ''}${actionLabel ? chip(actionLabel, 'green') : ''}${chip(processed ? row.result : T('cognition.candidate_status_pending', '待确认'), processed ? 'line' : 'amber')}${subtitle ? `<span class="note">${esc(subtitle)}</span>` : ''}</div></header><div class="ca-activity-detail-body ca-detail-body" data-activity-key="${esc(row.key)}">${relatedHtml}${content}</div><footer class="ca-activity-detail-footer ca-detail-footer">${fixedActions}${processed ? btn(T('cognition.activity_next_item', '下一项'), 'activity-next', { small: true }) + btn(T('cognition.activity_back_pending', '返回需要关注 ›'), 'activity-tab', { id: 'attention', small: true, className: 'o' }) : ''}</footer>`;
  }

  function viewActivity(route) {
    const model = activityModelForRoute(route);
    const isNarrow = narrowActivity();
    if (!activityRendered && isNarrow && (route.candidateId || route.approvalId || route.inboxId || route.poCandidateId)) activityDrawer = true;
    if (activityRendered && isNarrow !== activityWasNarrow) activityDrawer = false;
    activityRendered = true; activityWasNarrow = isNarrow;
    const processed = route.activityView === 'done' || route.activityDone === '1';
    const activeFilter = String(route.activityFilter || 'all');
    const filterSource = processed ? model.done : model.attention;
    const filterCounts = { all: filterSource.length };
    for (const row of filterSource) filterCounts[row.kind || 'add'] = (filterCounts[row.kind || 'add'] || 0) + 1;
    const filterDefs = [
      ['all', T('cognition.activity_filter_all_types', '全部类型')],
      ['add', T('cognition.activity_filter_add', '新增')],
      ['update', T('cognition.activity_filter_update', '更新')],
      ['organize', T('cognition.activity_filter_organize', '整理')],
      ['conflict', T('cognition.activity_filter_conflict', '冲突')],
      ['outdated', T('cognition.activity_filter_outdated', '建议复核')],
    ];
    const all = activityRowsFor(route, model);
    const page = Math.max(0, Math.min(Number(route.activityPage) || 0, Math.max(0, Math.ceil(all.length / ACTIVITY_PAGE_SIZE) - 1)));
    const rows = all.slice(page * ACTIVITY_PAGE_SIZE, (page + 1) * ACTIVITY_PAGE_SIZE);
    S.activityRows = rows;
    const key = selectedActivityKey(route);
    let selected = all.find(row => row.key === key || row.candidateIds.includes(route.candidateId));
    // Deep links can refer to an excluded or already processed item; retain its original content.
    if (!selected && !route.activityRunId && (route.candidateId || route.approvalId || route.inboxId || route.poCandidateId)) {
      selected = [...model.attention, ...model.done].find(row => row.key === key || row.candidateIds.includes(route.candidateId));
      if (!selected && route.candidateId) {
        const historical = S.candidates.find(c => c.id === route.candidateId);
        if (historical) selected = { key, title: candidateTitle(historical), detail: historical.judgment || '',
          scope: activityScope(historical.suggestedScope), route: { candidateId: route.candidateId },
          candidateIds: [route.candidateId], result: activityResult(historical, false) };
      }
    }

    if (selected) activitySelection = selected.key;
    else if (!(route.candidateId || route.approvalId || route.inboxId || route.poCandidateId)) activitySelection = '';
    S.activityDetailTarget = selected?.route || null;
    const showDetail = !!selected || !!route.approvalId;
    if (!showDetail) activityExpanded = false;
    const showDrawer = isNarrow && showDetail && activityDrawer;
    const failed = S.candidatesError || S.inboxError;
    const incomplete = failed || S.loading || model.runUnavailable;
    const count = value => incomplete ? T('cognition.activity_count_unknown', '待核对') : String(value);
    const viewOptions = ['attention', 'done'].map((value, index) => ({ value,
      label: `${T(index ? 'cognition.activity_done' : 'cognition.activity_attention', index ? '已处理' : '需要关注')} ${count(index ? model.done.length : model.attention.length)}` }));
    const typeOptions = filterDefs.map(([value, label]) => ({ value, label: `${label} ${count(filterCounts[value] || 0)}` }));
    const listEmpty = failed
      ? empty(T('cognition.review_load_failed_title', '清单没能读取'), T('cognition.activity_read_failed', '部分变化未能读取，请重试；不能据此判断没有待处理内容。'), { label: T('common.retry', '重试'), attrs: { 'data-act': 'refresh' } })
      : S.loading
        ? empty(T('cognition.activity_loading', '正在读取活动…'), '')
        : route.activityQuery
          ? empty(T('cognition.activity_search_empty', '没有匹配的变化，请调整搜索条件。'), '', { label: T('cognition.library_clear', '清空筛选'), attrs: { 'data-act': 'activity-clear' } })
          : activeFilter !== 'all'
            ? empty(T('cognition.activity_filter_empty', '当前筛选下没有建议。'), '', { label: T('cognition.activity_filter_clear', '查看全部'), attrs: { 'data-act': 'activity-filter', 'data-id': 'all' } })
          : model.runUnavailable
            ? empty(T('cognition.activity_run_unavailable', '本轮记录暂不可用'), T('cognition.activity_run_unavailable_hint', '请返回资产设置查看最近运行。'))
          : route.activityRunId
            ? empty(T('cognition.activity_run_empty', '本轮没有此类建议'), T('cognition.activity_run_empty_hint', '可切换“需要关注”或“已处理”查看。'))
          : selected
            ? empty(T('cognition.list_beside_selection', '当前筛选下无其他条目'), T('cognition.list_beside_selection_hint', '正在查看的这条不在当前列表中。'))
            : processed
            ? empty(T('cognition.activity_done_empty', '暂无已处理的认知变化'), T('cognition.activity_empty_hint', '没有有价值的结果时，这里保持空白。'))
            : empty(T('cognition.activity_empty', '当前没有需要关注的认知变化'), T('cognition.activity_organize_hint', '可以到资产设置整理已有内容。进入设置只打开整理操作，不会自动开始扫描。'), { label: T('cognition.activity_go_organize', '前往整理'), attrs: { 'data-act': 'go-organize-settings' } });
    const table = rows.length ? `<table class="ca-activity-table"><thead><tr><th>${esc(T('cognition.activity_proposed_change', '建议变化'))}</th><th>${esc(T('cognition.activity_scope', '适用范围'))}</th><th>${esc(T('cognition.activity_time', '发生时间'))}</th><th>${esc(T(processed ? 'cognition.activity_result' : 'cognition.activity_decision', processed ? '处理结果' : '需要你决定'))}</th></tr></thead><tbody>${rows.map(row => `<tr role="button" tabindex="0" aria-pressed="${selected?.key === row.key}" aria-label="${esc(row.title + '，' + row.result)}" class="${selected?.key === row.key ? 'is-selected' : ''}" data-act="activity-select" data-id="${esc(row.key)}"><td><strong>${esc(row.title)}</strong><p>${esc(normalizeActivityText(row.detail))}</p></td><td>${esc(row.scope)}</td><td>${esc(row.at)}</td><td>${esc(row.result)}<span aria-hidden="true"> ›</span></td></tr>`).join('')}</tbody></table>`
      : listEmpty;
    const pages = Math.max(1, Math.ceil(all.length / ACTIVITY_PAGE_SIZE));
    const detailProcessed = processed || (!!selected?.route.approvalId && model.done.some(row => row.key === selected.key)) || (!!selected?.route.candidateId && model.done.some(row => row.candidateIds.includes(selected.route.candidateId)));
    const activityCard = presentation => {
      const overlay = showDrawer && presentation !== 'expanded';
      const mirror = presentation === 'mirror';
      return window.uiCard({ tag: 'section', readonly: true, className: 'ca-detail-card ca-activity-detail' + (overlay ? ' is-drawer-open' : '') + (mirror ? ' is-mirror' : ''), attrs: { 'aria-label': T('cognition.activity_detail', '活动详情'), ...(overlay ? { role: 'dialog', 'aria-modal': 'true' } : {}), ...(mirror ? { 'data-detail-mirror': 'true' } : {}) }, bodyHtml: activityDetail(selected, detailProcessed, { presentation: mirror ? 'panel' : presentation }) });
    };
    const mirrorIds = html => html.replace(/\s(id|for|aria-controls)="([^"]+)"/g, (_, name, value) => ` ${name}="${value}-mirror"`);
    const expandHtml = showDetail && activityExpanded ? `<div class="ca-detail-expand" role="dialog" aria-modal="true" aria-label="${esc(T('cognition.detail_expand', '展开详情'))}"><div class="ca-detail-expand-panel">${activityCard('expanded')}</div></div>` : '';
    const detailHtml = !showDetail ? '' : activityExpanded ? `<div class="ca-detail-mirror" data-detail-mirror="true" inert>${mirrorIds(activityCard('mirror'))}</div>` : activityCard('panel');
    return `<section class="ca-activity-page">${expandHtml}
      ${route.activityRunId ? `<p class="note">${esc(T('cognition.activity_run_only', '正在查看本轮建议。'))} ${btn(T('cognition.settings_view_all_suggestions', '查看全部建议'), 'go-review', { small: true })}</p>` : ''}
      <div class="ca-activity-toolbar" ${showDrawer ? 'inert' : ''}><div class="ca-prototype-search">${window.uiIconHtml('cognition-search')}${window.uiInput({ id: 'ca-activity-query', type: 'search', value: route.activityQuery || '', placeholder: T('cognition.activity_search_placeholder', '搜索标题、摘要或适用范围'), attrs: { 'aria-label': T('cognition.activity_search', '搜索变化内容或适用范围') } })}</div>${route.activityQuery ? btn(T('cognition.activity_clear_search', '清空搜索'), 'activity-clear', { small: true }) : ''}</div>
      <div class="ca-library-filters" data-activity-selects ${showDrawer ? 'inert' : ''}><div class="ca-library-filter">${window.uiSelect({ id: 'ca-activity-view-filter', ariaLabel: T('cognition.activity_views', '活动视角'), value: processed ? 'done' : 'attention', options: viewOptions })}</div><div class="ca-library-filter">${window.uiSelect({ id: 'ca-activity-kind-filter', ariaLabel: T('cognition.activity_filters', '建议类型'), value: activeFilter, options: typeOptions })}</div><div class="ca-library-refresh"><span class="note ca-activity-sync" ${failed ? 'role="alert"' : 'role="status"'}>${esc(S.loading ? T('cognition.activity_loading', '正在读取活动…') : failed ? T('cognition.activity_read_failed', '部分变化未能读取，请重试；不能据此判断没有待处理内容。') : T('cognition.activity_updated', '已更新'))}</span>${btn(T(failed ? 'common.retry' : 'common.refresh', failed ? '重试' : '刷新'), 'refresh', { small: true })}</div></div>
      <div class="ca-activity-layout"><div class="ca-activity-list" ${showDrawer ? 'inert' : ''}><div class="ca-activity-table-wrap">${table}</div><div class="ca-activity-pagination"><span>${esc(T('cognition.activity_pagination', '每页 50 条 · 第 {start}–{end} 条 / 共 {total} 条（合并后）', { start: String(all.length ? page * ACTIVITY_PAGE_SIZE + 1 : 0), end: String(Math.min(all.length, (page + 1) * ACTIVITY_PAGE_SIZE)), total: incomplete ? T('cognition.activity_count_unknown', '待核对') : String(all.length) }))}</span><div>${btn(T('common.previous', '上一页'), 'activity-page-select', { id: String(page - 1), small: true, disabled: page === 0 })}<span>${page + 1} / ${pages}</span>${btn(T('common.next', '下一页'), 'activity-page-select', { id: String(page + 1), small: true, disabled: page + 1 >= pages })}</div></div></div>${detailHtml}</div>${showDrawer && !activityExpanded ? window.uiButton({ label: T('common.close', '关闭'), role: 'ghost', className: 'ca-activity-scrim', attrs: { 'data-act': 'activity-close', 'aria-label': T('common.close', '关闭'), tabindex: '-1' } }) : ''}</section>`;
  }

  async function mayLeaveActivity() {
    const id = activitySelection.startsWith('candidate:') ? activitySelection.slice(10) : '';
    if (!id || !activityDrafts.has(id)) return true;
    const leave = await NS.confirmUser(T('cognition.activity_unsaved_leave', '有尚未保存的修改。放弃修改并离开这条建议？'));
    if (leave) activityDrafts.delete(id);
    return !!leave;
  }
  function selectActivityRow(row, focusDetail = false) {
    if (!row) return;
    if (row.key !== activitySelection) activityExpanded = false;
    activitySelection = row.key;
    activityDrawer = narrowActivity();
    activityWasNarrow = narrowActivity();
    NS.router.go(activityRoute(row.route), { replace: true });
    if (focusDetail) document.querySelector?.('.ca-activity-detail [data-act="activity-close"]')?.focus();
  }
  NS.activityController = {
    handledActions: ACTIVITY_ACTIONS,
    writeActions: ACTIVITY_WRITE_ACTIONS,
    closeFilters() {
      for (const api of activityFilterApis) typeof api.destroy === 'function' ? api.destroy() : api.close();
      activityFilterApis = [];
    },
    hydrateFilters(root) {
      if (!root?.querySelectorAll || typeof window._aiSelectMount !== 'function') return;
      const filters = root.querySelector?.('[data-activity-selects]');
      if (!filters) return;
      const change = async (id, value) => {
        const isView = id === 'ca-activity-view-filter';
        const previous = isView ? (S.route.activityView === 'done' || S.route.activityDone === '1' ? 'done' : 'attention') : String(S.route.activityFilter || 'all');
        if (activityQueryTimer) { window.clearTimeout(activityQueryTimer); activityQueryTimer = undefined; }
        if (!(await mayLeaveActivity())) {
          filters.querySelector?.(`#${id}`)?._uiSelectApi?.setValue(previous);
          return;
        }
        activitySelection = ''; activityDrawer = false;
        activityFilterFocus = id;
        const patch = isView ? { activityView: value, activityDone: value === 'done' ? '1' : '', activityPage: '', activityQuery: '' }
          : { activityFilter: value, activityPage: '' };
        NS.router.go(activityRoute(patch), { replace: true });
      };
      const callbacks = {};
      for (const id of ['ca-activity-view-filter', 'ca-activity-kind-filter']) callbacks[id] = value => change(id, value);
      activityFilterApis = window.hydrateUiFormSelects(filters, callbacks);
      if (activityFilterFocus) {
        const id = activityFilterFocus;
        activityFilterFocus = '';
        root.querySelector?.(`#${id} .ai-select-trigger`)?.focus({ preventScroll: true });
      }
    },
    // An explicit conversation deep link is an open-detail action, unlike a
    // default list selection or a desktop-to-narrow resize.
    openLinkedDetail() {
      activityDrawer = narrowActivity();
      activityWasNarrow = narrowActivity();
    },
    closeForSourcePreview() {
      if (!activityDrawer) return;
      activityDrawer = false;
      NS.notify();
    },
    focusFormationRecovery(candidateId, operation) {
      const focus = () => {
        if (S.route.name !== 'activity' || activitySelection !== 'candidate:' + candidateId
          || (operation && activitySelection !== operation.selection)) return;
        // Retain an in-flight edit; saving the draft reveals the existing recheck action.
        const button = document.querySelector?.('.ca-detail-expand [data-act="formation-recheck"]')
          || document.querySelector?.('.ca-activity-detail:not(.is-mirror) [data-act="formation-recheck"]')
          || document.querySelector?.('.ca-detail-expand [data-act="activity-save-draft"]')
          || document.querySelector?.('.ca-activity-detail:not(.is-mirror) [data-act="activity-save-draft"]');
        if (!button || button.dataset.id !== candidateId) return;
        for (let parent = button.parentElement; parent; parent = parent.parentElement) {
          if (parent.tagName === 'DETAILS') parent.open = true;
        }
        button.scrollIntoView?.({ block: 'nearest' });
        button.focus({ preventScroll: true });
      };
      // notify batches DOM replacement into a frame; focus its resulting control.
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(focus);
      else focus();
    },
    captureRenderState(root) {
      const listed = typeof root?.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('.ca-activity-detail-body')) : [];
      const body = listed.find(node => node.closest?.('.ca-detail-expand')) || root?.querySelector?.('.ca-activity-detail-body');
      const list = root?.querySelector?.('.ca-activity-table-wrap');
      if (!body && !list) return null;
      const details = Array.from(body?.querySelectorAll?.('details') || []);
      return {
        key: body?.dataset.activityKey || '',
        bodyTop: body?.scrollTop || 0,
        listTop: list?.scrollTop || 0,
        listLeft: list?.scrollLeft || 0,
        fields: Array.from(body?.querySelectorAll?.('[data-f]') || []).map(field => ({
          name: field.dataset.f,
          top: field.scrollTop || 0,
          left: field.scrollLeft || 0,
          active: field === document.activeElement,
          start: field.selectionStart,
          end: field.selectionEnd,
          direction: field.selectionDirection,
        })),
        disclosures: details.filter(d => !d.dataset?.detailFoldKey).map(d => d.open),
        sections: Object.fromEntries(details.filter(d => d.dataset?.detailFoldKey).map(d => [d.dataset.detailFoldKey, d.open])),
      };
    },
    restoreRenderState(root, state) {
      const listed = typeof root?.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('.ca-activity-detail-body')) : [];
      const body = listed.find(node => node.closest?.('.ca-detail-expand')) || root?.querySelector?.('.ca-activity-detail-body');
      const list = root?.querySelector?.('.ca-activity-table-wrap');
      if (list && state) { list.scrollTop = state.listTop; list.scrollLeft = state.listLeft; }
      if (!body) return;
      // 新条目从头阅读；后台更新同一条目时，保留阅读位置和输入光标。
      const sameItem = state?.key && state.key === body.dataset.activityKey;
      if (sameItem) {
        let index = 0;
        Array.from(body.querySelectorAll?.('details') || []).forEach(details => {
          const key = details.dataset?.detailFoldKey;
          const open = key ? state.sections?.[key] : state.disclosures[index++];
          // History renders its open state from the lazy-load controller.
          // A captured DOM value predates the click and must not undo it.
          if (details.querySelector?.(':scope > summary[data-act="activity-history"]')) return;
          if (open !== undefined) details.open = open;
        });
      }
      for (const field of Array.from(body.querySelectorAll?.('[data-f]') || [])) {
        const saved = sameItem && state.fields.find(item => item.name === field.dataset.f);
        if (saved?.active) {
          field.focus?.({ preventScroll: true });
          if (typeof saved.start === 'number' && typeof field.setSelectionRange === 'function') {
            try { field.setSelectionRange(saved.start, saved.end, saved.direction); } catch (_) { /* Native selects do not have text selection. */ }
          }
        }
        field.scrollTop = saved ? saved.top : 0;
        field.scrollLeft = saved ? saved.left : 0;
      }
      body.scrollTop = sameItem ? state.bodyTop : 0;
    },
    async handleClick(el) {
      const act = el.dataset.act, id = el.dataset.id || '';
      if (activityQueryTimer) { window.clearTimeout(activityQueryTimer); activityQueryTimer = undefined; }
      if (act === 'cand-decide' && !(await mayLeaveActivity())) return true;
      if (!ACTIVITY_ACTIONS.includes(act)) return false;
      if (el.disabled || el.getAttribute('disabled') !== null) return true;
      if (act === 'activity-edit' || act === 'activity-edit-cancel') {
        const candidate = S.candidates.find(item => String(item.id) === id);
        if (!candidate || !NS.candidate.attentionReady(candidate) || !candidate.capabilities?.canEdit) return true;
        if (act === 'activity-edit') {
          activityReadingPositions.set(id, (document.querySelector?.('.ca-detail-expand .ca-activity-detail-body') || document.querySelector?.('.ca-activity-detail:not(.is-mirror) .ca-activity-detail-body'))?.scrollTop || 0);
          activityEditors.add(id);
        }
        else {
          if (!(await mayLeaveActivity())) return true;
          activityEditors.delete(id);
        }
        NS.notify();
        const restoreFocus = () => {
          const detail = document.querySelector?.('.ca-detail-expand .ca-activity-detail') || document.querySelector?.('.ca-activity-detail:not(.is-mirror)');
          const body = detail?.querySelector('.ca-activity-detail-body');
          if (body) body.scrollTop = act === 'activity-edit' ? 0 : activityReadingPositions.get(id) || 0;
          detail?.querySelector(act === 'activity-edit' ? candidate.proposalTarget === 'ontology' ? '[data-f="judgment"]' : '[data-f]' : '[data-act="activity-edit"]')?.focus({ preventScroll: act !== 'activity-edit' });
        };
        // notify replaces the detail DOM in the next frame; focus the new node.
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restoreFocus);
        else restoreFocus();
        return true;
      }
      if (act === 'formation-recheck') {
        if (activityDrafts.has(id)) {
          await NS.alertUser(T('cognition.formation_recheck_save_first', '请先点「保存修改并校验」保留当前修改，再核对关联本体建议。'));
          return true;
        }
        await NS.actions.recheckCandidateFormation(id);
        return true;
      }
      if (act === 'activity-approval') {
        const proposal = (S.assetApprovals || []).find(item => String(item.id) === id);
        const decision = el.dataset.decision;
        if (!proposal || proposal.contentPurgedAt || !['pending', 'deferred'].includes(proposal.state) || S.loading || S.candidatesError
          || !['confirm', 'defer', 'reject'].includes(decision)) return true;
        if (decision === 'confirm') {
          const asset = (S.assets || []).find(item => String(item.id) === String(proposal.assetId));
          if (!NS.ui.versionContent(proposal.assetId, proposal.baselineActiveVersion || proposal.baselineVersion) || S.assetsError || !readableApproval(proposal) || !asset || !['active', 'paused'].includes(asset.status) || String(asset.version) !== String(proposal.baselineVersion) || String(asset.activeVersion || asset.version) !== String(proposal.baselineActiveVersion || proposal.baselineVersion)) return true;
        }
        const operation = this.beginDecision();
        el.setAttribute('aria-busy', 'true'); el.setAttribute('disabled', 'disabled');
        try {
          let result;
          // The IPC client throws for ok:false, including conflicts. Re-read in
          // finally so a failed response cannot leave a superseded item editable.
          try { result = await NS.api.call('recall.assets.approval.decide', { proposalId: id, decision }); }
          finally { await NS.reload(); }
          if (!result?.ok) throw new Error(result?.message || T('cognition.activity_approval_blocked', '目标资产不可用、版本已变化或清单读取失败，请刷新核对后再处理。'));
          if (decision !== 'defer') this.afterDecision('', false, operation);
          NS.notify();
        } catch (error) { await NS.alertUser(NS.recallErrorText ? NS.recallErrorText(error) : String(error.message || error)); }
        finally { el.removeAttribute('aria-busy'); el.removeAttribute('disabled'); }
        return true;
      }
      if (act === 'activity-undo-automatic') {
        const candidate = S.candidates.find(item => String(item.id) === id);
        if (!candidate?.capabilities?.canUndoAutomatic || el.getAttribute('aria-busy') === 'true') return true;
        el.setAttribute('aria-busy', 'true'); el.setAttribute('disabled', 'disabled');
        try {
          const result = await NS.api.call('recall.candidates.undoAutomaticPreview', { candidateId: id });
          const preview = result.preview;
          if (!result.ok || !preview?.token || !Array.isArray(preview.ontologyChanges)) throw new Error(T('cognition.automatic_undo_changed', '保存内容已有变化，请刷新后重新核对。'));
          if (preview.alreadyUndone) { await NS.reload(); return true; }
          const note = T('cognition.automatic_undo_preserves_history', '原决定和版本历史继续保留。有后续修改或引用时，系统会要求重新核对。');
          const change = preview.assetChange;
          const assetHtml = change ? `<section class="ca-review-notice"><h3>${esc(change.title)}</h3><h4>${esc(T('cognition.automatic_undo_before', '当前内容：'))}</h4><p class="content-text">${esc(change.before)}</p><h4>${esc(T('cognition.automatic_undo_after', '恢复后的内容：'))}</h4><p class="content-text">${esc(change.action === 'delete' ? T('cognition.automatic_undo_delete', '撤销新增：移入已删除，保留历史。') : change.after)}</p></section>` : '';
          const ontologyHtml = preview.ontologyChanges.length ? NS.candidate.formationPreviewHtml({ ...candidate,
            ontologyFormation: { schemaVersion: 1, reason: note, blockedReasons: [], requiresTReview: false,
              previewChanges: preview.ontologyChanges.map(item => ({ ...item, intent: 'undo_command', recordId: item.after.id,
                box: item.after.kind === 'rule' ? 'R' : ['module', 'definition', 'reference'].includes(item.after.kind) ? 'T' : 'A' })) } }, true) : '';
          if (typeof window.uiModal !== 'function' || !document.getElementById('ca-root')) throw new Error(T('cognition.automatic_undo_changed', '保存内容已有变化，请刷新后重新核对。'));
          const dialog = window.uiModal({ title: T('cognition.automatic_undo_title', '撤销本次自动保存'), size: 'md',
            closeLabel: T('common.close', '关闭'), bodyHtml: `<p>${esc(note)}</p>${assetHtml}${ontologyHtml}`,
            actions: [{ id: 'cancel', label: T('common.cancel', '取消') }, { id: 'confirm', label: T('common.confirm', '确认'), role: 'danger' }] });
          document.getElementById('ca-root').appendChild(dialog.overlay);
          if ((await dialog).value !== 'confirm') return true;
          const saved = await NS.api.call('recall.candidates.undoAutomatic', { candidateId: id, previewToken: preview.token });
          if (!saved.ok || !saved.candidate?.automaticUndo) throw new Error(T('cognition.automatic_undo_changed', '保存内容已有变化，请刷新后重新核对。'));
          delete (S.activityHistory || {})[id];
          await NS.reload();
        } catch (error) { await NS.alertUser(NS.recallErrorText ? NS.recallErrorText(error) : String(error.message || error)); }
        finally { el.removeAttribute('aria-busy'); el.removeAttribute('disabled'); NS.notify(); }
        return true;
      }
      if (act === 'activity-undo-organization') {
        if (!(await mayLeaveActivity())) return true;
        const response = await NS.api.call('recall.candidates.organization.undoPreview', { candidateId: id });
        const preview = response.preview;
        if (!preview || preview.alreadyUndone) { await NS.reload(); return true; }
        const detail = `${T('cognition.organization_restore', '恢复原条目')}：${preview.restore.map(row => row.title).join('、')}\n${T('cognition.organization_archive_results', '归档本次结果')}：${preview.archive.map(row => row.title).join('、')}\n${T('cognition.organization_undo_note', '本体关系随本次整理恢复，版本与处理历史保留。')}`;
        const ontologyImpact = (preview.ontologyChanges || []).map(row => `${row.before ? T('cognition.organization_restore', '恢复原条目') : T('cognition.organization_archive_results', '归档本次结果')}：${row.after.name || row.after.id}`).join('\n');
        if (!(await NS.confirmUser([detail, ontologyImpact].filter(Boolean).join('\n')))) return true;
        await NS.api.call('recall.candidates.organization.undo', { candidateId: id, previewToken: preview.token });
        await NS.reload(); return true;
      }
      if (act === 'activity-history') {
        if (!S.candidates.some(item => String(item.id) === id)) return true;
        const histories = S.activityHistory || (S.activityHistory = {});
        const state = histories[id] || (histories[id] = { open: false, items: [], loaded: false, loading: false });
        state.open = state.error ? true : !state.open;
        if (!state.open || state.loaded || state.loading) { NS.notify(); return true; }
        state.loading = true; state.error = ''; NS.notify();
        try {
          const result = await NS.api.call('recall.candidates.history', { candidateId: id });
          if (!Array.isArray(result.items)) throw new Error(T('cognition.activity_history_unavailable', '本条处理记录暂时无法读取，请重试。'));
          state.items = result.items; state.loaded = true;
        } catch (error) { state.error = T('cognition.activity_history_unavailable', '本条处理记录暂时无法读取，请重试。'); }
        finally { state.loading = false; NS.notify(); }
        return true;
      }
      if (ACTIVITY_WRITE_ACTIONS.includes(act)) {
        if (el.getAttribute('aria-busy') === 'true') return true;
        el.setAttribute('aria-busy', 'true'); el.setAttribute('disabled', 'disabled');
        const operation = this.beginDecision();
        try {
          const candidate = S.candidates.find(item => String(item.id) === id);
          if (!candidate || !NS.candidate.attentionReady(candidate)) return true;
          const card = el.closest?.('.ca-candidate-detail') || el.closest?.('.ca-detail-expand')?.querySelector('.ca-candidate-detail') || el.closest?.('.ca-activity-detail')?.querySelector('.ca-candidate-detail');
          const values = {};
          for (const [field, property] of Object.entries(candidateFields)) {
            const control = card?.querySelector('[data-f="' + field + '"]');
            if (control) values[property] = ['applicableWhen', 'forbiddenWhen'].includes(property) ? String(control.value).split(/\r?\n/).map(value => value.trim()).filter(Boolean) : property === 'suggestedScope' ? control.dataset.savedScope ?? String(control.value) : String(control.value);
          }
          if (card?.dataset.candType) values.suggestedType = card.dataset.candType;
          if (act === 'activity-save-draft') {
            let result;
            if (candidate.contentOrganization) {
              const outputs = NS.candidate.readOrganizationOutputs(candidate, card);
              result = await NS.api.call('recall.candidates.organization.update', { candidateId: id, outputs });
            } else result = await NS.api.call('recall.candidates.update', Object.assign({}, candidate, values, { candidateId: id, sourceRefs: candidate.sourceRefs || candidate.evidenceRefs || [], evidenceRefs: candidate.evidenceRefs || candidate.sourceRefs || [] }));
            if (!result?.candidate?.id) throw new Error(T('cognition.activity_draft_missing', '没有读到保存后的候选，请刷新后核对。'));
            S.candidates[S.candidates.findIndex(item => String(item.id) === id)] = result.candidate;
            activityDrafts.delete(id);
            activityEditors.delete(id);
            (S.activityDraftValidation || (S.activityDraftValidation = {}))[id] = true;
            if (S.activityHistory?.[id]) S.activityHistory[id].loaded = false;
            NS.toast(candidate.proposalTarget === 'ontology' ? T('cognition.ontology_request_saved', '要求已保存。请重新生成建议，核对结果后确认。') : T('cognition.activity_draft_saved', '修改已保存；正式保存仍以最新校验结果为准。'), 'success'); NS.notify();
            const restoreAfterSave = () => {
              const body = document.querySelector?.('.ca-detail-expand .ca-activity-detail-body') || document.querySelector?.('.ca-activity-detail:not(.is-mirror) .ca-activity-detail-body');
              if (body) body.scrollTop = activityReadingPositions.get(id) || 0;
              if (candidate.proposalTarget === 'ontology') this.focusFormationRecovery(id, operation);
              else (document.querySelector?.('.ca-detail-expand [data-act="activity-edit"]') || document.querySelector?.('.ca-activity-detail:not(.is-mirror) [data-act="activity-edit"]'))?.focus({ preventScroll: true });
            };
            // notify replaces the detail DOM in the next frame; restore scroll and focus there.
            if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restoreAfterSave);
            else restoreAfterSave();
          } else {
            if (!(await mayLeaveActivity())) return true;
            const result = await NS.api.call('recall.candidates.defer', { candidateId: id });
            if (!result?.candidate?.id) throw new Error(T('cognition.activity_defer_missing', '没有读到稍后处理的结果，请刷新后核对。'));
            S.candidates[S.candidates.findIndex(item => String(item.id) === id)] = result.candidate;
            NS.toast(T('cognition.activity_deferred_hint', '已标记稍后处理，仍保留在需要关注中。')); this.afterDecision(id, true, operation); NS.notify();
          }
        } catch (error) { await NS.alertUser(NS.recallErrorText ? NS.recallErrorText(error) : String(error.message || error)); }
        finally { el.removeAttribute('aria-busy'); el.removeAttribute('disabled'); }
        return true;
      }
      if (act === 'activity-inbox') {
        const inboxId = String(el.dataset.id || '');
        const action = String(el.dataset.action || '');
        const targetAssetId = el.dataset.target ? String(el.dataset.target) : undefined;
        if (!inboxId || !action) return true;
        el.setAttribute('aria-busy', 'true');
        el.setAttribute('disabled', '');
        try {
          await NS.actions.resolveInbox(inboxId, action, targetAssetId ? { targetAssetId } : {});
          activitySelection = '';
          activityDrawer = false;
          NS.toast(action === 'reject' ? T('cognition.inbox_action_dismiss', '已不再提醒')
            : action === 'defer' ? T('cognition.activity_deferred_saved', '已标记稍后处理，仍保留在需要关注中。')
              : T('common.done', '已完成'), 'success');
          await NS.loadRoute();
          NS.notify();
        } catch (error) {
          await NS.alertUser(NS.recallErrorText ? NS.recallErrorText(error) : String(error.message || error));
        } finally {
          el.removeAttribute('aria-busy');
          el.removeAttribute('disabled');
        }
        return true;
      }
      if (act === 'activity-expand') {
        if (!(activitySelection || S.route.candidateId || S.route.approvalId || S.route.inboxId || S.route.poCandidateId)) return true;
        activityExpanded = true; NS.notify(); return true;
      }
      if (act === 'activity-expand-close') { activityExpanded = false; NS.notify(); focusAfterFrame(() => document.querySelector?.('.ca-activity-detail:not(.is-mirror) [data-act="activity-expand"]')?.focus?.({ preventScroll: true })); return true; }
      if (act === 'activity-select' && id === activitySelection) { selectActivityRow((S.activityRows || []).find(row => row.key === id), narrowActivity()); return true; }
      if (!(await mayLeaveActivity())) return true;
      if (act === 'activity-select') selectActivityRow((S.activityRows || []).find(row => row.key === id), narrowActivity());
      else if (act === 'activity-tab') { activitySelection = ''; activityDrawer = false; NS.router.go(activityRoute({ activityView: id, activityDone: id === 'done' ? '1' : '', activityPage: '', activityQuery: '' }), { replace: true }); }
      else if (act === 'activity-clear') NS.router.go(activityRoute({ activityQuery: '', activityPage: '' }), { replace: true });
      else if (act === 'activity-page-select') { activitySelection = ''; activityDrawer = false; NS.router.go(activityRoute({ activityPage: id }), { replace: true }); }
      else if (act === 'activity-filter') { activitySelection = ''; activityDrawer = false; NS.router.go(activityRoute({ activityFilter: id, activityPage: '' }), { replace: true }); }
      else if (act === 'activity-next') this.afterDecision('', true);
      else if (act === 'activity-close') {
        const previous = activitySelection;
        activityDrawer = false; activityExpanded = false; activitySelection = '';
        NS.router.go(activityRoute(), { replace: true });
        focusAfterFrame(() => {
          const row = Array.from(document.querySelectorAll?.('[data-act="activity-select"]') || []).find(node => node.dataset.id === previous);
          row?.focus();
        });
      }
      return true;
    },
    handleInput(event) {
      const field = event.target;
      if (field.id === 'ca-activity-query' && !event.isComposing) {
        if (activityQueryTimer) window.clearTimeout(activityQueryTimer);
        const value = field.value, caret = field.selectionStart;
        activityQueryTimer = window.setTimeout(async () => { if (!(await mayLeaveActivity())) return; NS.router.go(activityRoute({ activityQuery: value, activityPage: '' }), { replace: true }); const input = document.getElementById('ca-activity-query'); input?.focus(); try { input?.setSelectionRange(caret, caret); } catch (_) { /* search inputs do not support selection in all engines */ } }, 180);
        return true;
      }
      const card = field.closest?.('.ca-candidate-detail');
      if (card?.closest?.('[data-detail-mirror]')) return false;
      const property = candidateFields[field.dataset?.f];
      if (card && field.dataset?.orgField) {
        const candidateId = String(card.dataset.candId);
        const candidate = S.candidates.find(item => item.id === candidateId);
        if (!candidate?.contentOrganization) return false;
        const contentOrganization = structuredClone(candidate.contentOrganization);
        contentOrganization.draft.outputs = NS.candidate.readOrganizationOutputs(candidate, card);
        activityDrafts.set(candidateId, { contentOrganization });
        return true;
      }
      if (!card || !property) return false;
      const candidateId = String(card.dataset.candId);
      const draft = Object.assign({}, activityDrafts.get(candidateId) || {}, { suggestedType: card.dataset.candType });
      draft[property] = ['applicableWhen', 'forbiddenWhen'].includes(property) ? String(field.value).split(/\r?\n/).map(value => value.trim()).filter(Boolean) : String(field.value);
      activityDrafts.set(candidateId, draft);
      if (S.activityDraftValidation) delete S.activityDraftValidation[candidateId];
      card.querySelector?.('[data-draft-validation]')?.remove?.();
      return true;
    },
    async handleKeydown(event) {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || blockingOverlay()) return false;
      if (event.key === 'Tab' && activityExpanded) {
        const controls = Array.from(document.querySelectorAll('.ca-detail-expand button:not(:disabled), .ca-detail-expand input:not(:disabled), .ca-detail-expand textarea:not(:disabled), .ca-detail-expand select:not(:disabled), .ca-detail-expand [tabindex="0"]')).filter(control => !control.hidden && control.getAttribute('aria-hidden') !== 'true');
        if (controls.length && ((event.shiftKey && event.target === controls[0]) || (!event.shiftKey && event.target === controls[controls.length - 1]))) { event.preventDefault(); (event.shiftKey ? controls[controls.length - 1] : controls[0]).focus(); }
        return true;
      }
      if (event.key === 'Tab' && activityDrawer && narrowActivity()) {
        const controls = Array.from(document.querySelectorAll('.ca-activity-detail button:not(:disabled), .ca-activity-detail input:not(:disabled), .ca-activity-detail textarea:not(:disabled), .ca-activity-detail select:not(:disabled), .ca-activity-detail [tabindex="0"]')).filter(control => !control.hidden && control.getAttribute('aria-hidden') !== 'true');
        if (controls.length && ((event.shiftKey && event.target === controls[0]) || (!event.shiftKey && event.target === controls[controls.length - 1]))) { event.preventDefault(); (event.shiftKey ? controls[controls.length - 1] : controls[0]).focus(); }
        return false;
      }
      if (event.key === 'Escape' && activityExpanded) { event.preventDefault(); activityExpanded = false; NS.notify(); focusAfterFrame(() => document.querySelector?.('.ca-activity-detail:not(.is-mirror) [data-act="activity-expand"]')?.focus?.({ preventScroll: true })); return true; }
      if (event.key === 'Escape' && (activityDrawer || activitySelection || S.route.candidateId || S.route.approvalId)) { event.preventDefault(); await this.handleClick({ dataset: { act: 'activity-close' }, getAttribute: () => null }); return true; }
      const row = event.target.closest?.('[data-act="activity-select"]');
      if (!row) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = Array.from(document.querySelectorAll('[data-act="activity-select"]')); const index = rows.indexOf(row); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); return true; }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); await this.handleClick(row); return true; }
      return false;
    },
    async guardNavigation() { if (activityQueryTimer) { window.clearTimeout(activityQueryTimer); activityQueryTimer = undefined; } return mayLeaveActivity(); },
    clearDraft(candidateId) { activityDrafts.delete(String(candidateId)); activityEditors.delete(String(candidateId)); },
    beginDecision() { return { selection: activitySelection, routeName: S.route.name, view: S.route.activityView || S.route.activityDone || '', query: S.route.activityQuery || '', page: S.route.activityPage || '' }; },
    afterDecision(candidateId, nextOnly = false, operation) {
      if (candidateId) activityDrafts.delete(String(candidateId).replace(/^candidate:/, ''));
      if (operation && (S.route.name !== operation.routeName || activitySelection !== operation.selection || (S.route.activityView || S.route.activityDone || '') !== operation.view || (S.route.activityQuery || '') !== operation.query || (S.route.activityPage || '') !== operation.page)) return false;
      const previous = S.activityRows || [];
      const index = previous.findIndex(row => row.key === activitySelection || row.candidateIds.includes(candidateId));
      const available = activityRowsFor(S.route);
      const next = nextOnly ? available[(Math.max(0, available.findIndex(row => row.key === activitySelection)) + 1) % available.length] : available.find(row => row.key === previous[index + 1]?.key) || available[Math.min(Math.max(0, index), available.length - 1)];
      activitySelection = next?.key || '';
      NS.router.go(activityRoute(Object.assign({}, next?.route || {}, { activityPage: String(Math.max(0, Math.floor(available.indexOf(next) / ACTIVITY_PAGE_SIZE))) })), { replace: true });
      return true;
    },
  };

  NS.viewActivity = viewActivity;
  // 兼容别名：旧深链/测试曾调 NS.viewReview；行为同 viewActivity（review 路由
  // 已在 router.go 归一到 activity）。
  NS.viewReview = viewActivity;
})();
