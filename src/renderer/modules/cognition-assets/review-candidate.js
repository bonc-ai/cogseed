/* ============================================================================
 * 认知资产 · 候选族零件（cognition-assets/review-candidate.js）
 *
 * 提供候选判定、徽章、列表卡、确认表单、依据链、版本冲突与详情。
 * 共享零件（按钮/章/术语表/来源解析/折叠件）经 NS.ui 取用——本文件必须
 * 晚于 views.js 加载（lazy-features.js recall 组顺序）。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets;
  if (!NS) return;
  const { T, esc } = NS;
  const S = NS.store;
  const {
    btn, roleBtn, chip, hero, empty,
    isKstarEvidenceRef, evidenceChip, evidenceGroupsHtml, stripMarkdown,
    attributionLabel, sourceRefKind, resolveSourceRef, reviewOutcomeText, otherActions,
    foldValue, kstarEpisodeSection, contentCategoryLabel, contentCategorySelect,
  } = NS.ui;

  // 当前主动创建由宿主给出独立来源；旧「对话中记」仍按原前缀显示。
  // 这里只选择来源徽章，不授予确认、夜间形成或任务使用资格。
  function isImmediateCandidate(candidate) {
    if (candidate?.humanInstructionProvenance?.pipeline === 'human_instruction') return true;
    if (candidate && typeof candidate.captureKey === 'string' && candidate.captureKey.startsWith('immediate-')) return true;
    return evidenceRefs(candidate).some((ref) => String(ref && ref.id || '').startsWith('immediate-'));
  }

  function evidenceRefs(candidate) {
    return candidate.evidenceRefs || candidate.sourceRefs || [];
  }
  // 归组口径：按 id 去重（sourceRefs/evidenceRefs 存储上就是同内容双份），
  // 且「对话中当场记」不计弱证据——只有目录真查无的才算。
  function evidenceMostlyUnavailable(candidate) {
    const refs = evidenceRefs(candidate);
    if (!refs.length) return false;
    const seen = new Set();
    let unavailable = 0;
    let total = 0;
    for (const ref of refs) {
      const id = String(ref && (ref.id || ref.conversationId || ref.ref) || '').trim();
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      total += 1;
      if (sourceRefKind(ref) === 'unavailable') unavailable += 1;
    }
    if (!total) return false;
    return unavailable * 2 > total;
  }

  const candidatePending = (candidate) => !!(candidate.capabilities && candidate.capabilities.countsAsPending);
  // A completed proposal whose user-confirmed save hit IO is still the same
  // decision. This never turns discovery/extraction failures into tasks.
  const candidateSaveUncertain = candidate => candidate.status === 'failed'
    && ['asset_write_failed', 'decision_write_failed'].includes(candidate.failureCode);
  // 系统活动只承接完整形成的夜间认知建议；能力可操作不等于形成完成。
  // provenance 由主进程核验并持久化，旧记录不能靠正文或待办能力猜测补齐。
  function attentionReady(candidate) {
    if (candidate.contentPurgedAt) return false;
    const caps = candidate.capabilities || {};
    const saveUncertain = candidateSaveUncertain(candidate);
    if ((!['pending_review', 'deferred'].includes(candidate.status) && !saveUncertain) || !caps.countsAsPending
      || caps.isTerminal || caps.needsUserAction === false || candidate.activityExclusionReason
      || candidate.ontologyHandoff || candidate.learningSignal || candidate.learningProvenance
      || ['manual', 'teaching', 'kstar'].includes(candidate.origin)) return false;
    if (candidate.contentOrganization) return caps.canPromote || caps.canEdit || caps.canReject;
    if (!['cognition', 'personal', 'rule', 'template', 'skill_method', 'fact'].includes(candidate.suggestedType)
      || !String(candidate.judgment || '').trim() || (!candidate.stockOrganizationProvenance && !String(candidate.value || '').trim())
      || !String(candidate.summary || '').trim() || !String(candidate.suggestedScope || '').trim()
      || !['create', 'update', 'limit_scope', 'pause', 'keep_current', 'reject'].includes(candidate.suggestedAction)) return false;
    if (caps.eligibility === 'ineligible' || (caps.ineligibleReasons || []).length
      || ['weak_evidence', 'unknown', 'ontology_in_progress'].includes(caps.displayState)
      || (candidate.statementIssues || []).length || (!saveUncertain && (caps.displayState === 'failed' || caps.canRetry))) return false;
    if (candidate.contentOrganization) return true;
    if (candidate.origin === 'stock_organization' && candidate.stockOrganizationProvenance?.jobId
      && candidate.stockOrganizationProvenance.checkedAt) return true;
    const provenance = candidate.captureProvenance;
    const judgment = provenance?.valueJudgment;
    if (provenance?.pipeline !== 'nightly_conversation' || !String(provenance.captureId || '').trim()
      || !provenance.extractionCompletedAt || !Number.isFinite(Date.parse(provenance.extractionCompletedAt))
      || judgment?.eligible !== true || !String(judgment.reason || '').trim()
      || !judgment.judgedAt || !Number.isFinite(Date.parse(judgment.judgedAt))
      || !Array.isArray(provenance.messageIds) || !provenance.messageIds.length
      || !Array.isArray(judgment.evidence) || !judgment.evidence.length) return false;
    const refs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [];
    const sourceIds = new Set(refs.filter(ref => ref.kind === 'conversation' && ref.subtype === 'message'
      && ref.id && ref.degraded !== true && !ref.reason).map(ref => ref.id));
    return judgment.evidence.every(item => item && typeof item.quote === 'string'
      && item.quote.trim().length > 0 && item.quote.length <= 1000
      && typeof item.sourceId === 'string' && item.sourceId.trim()
      && provenance.messageIds.includes(item.messageId))
      && judgment.evidence.some(item => sourceIds.has(item.sourceId));
  }
  /** 候选来源徽章：三条产出线可辨——KSTAR 复盘
   *  （learningSignal/learningProvenance）、KSTAR 偏好（source=preference_scan，
   *  确定性扫描线）、会话整理（capture 线，无信号）。KSTAR 两条线的徽章
   *  文案必须带 "KSTAR" 前缀，以便用户辨认。 */
  function candidateSourceBadge(candidate) {
    if (candidate.origin === 'stock_organization') return chip(T('cognition.source_stock', '存量整理'));
    if (candidate.origin === 'manual') return chip(T('cognition.source_manual', '手动输入'));
    const signal = candidate.learningSignal;
    if (signal && String(signal.source || '') === 'preference_scan') {
      return chip(T('cognition.source_pref_scan', '偏好扫描'));
    }
    if (signal || candidate.learningProvenance) return chip(T('cognition.source_kstar_review', '任务复盘'));
    if (isImmediateCandidate(candidate)) return chip(T('cognition.source_immediate', '对话中记'));
    return chip(T('cognition.source_capture', '会话整理'));
  }
  function candidateRiskBadge(candidate) {
    const risk = String(candidate && candidate.risk || 'low');
    const label = T(`cognition.capture.risk_${risk}`, ({ low: '低风险', medium: '中风险', high: '高风险' })[risk] || '风险待核对');
    return chip(label, risk === 'high' ? 'amber' : 'line');
  }

  /** KSTAR 候选的复盘依据块：预期/实际/结果四行——知道"这条
   *  是从哪次成败学来的"，确认保存才心里有底。
   *  更新型候选不再走这里（依据链已含预期→实际段，避免同屏两份）。 */
  function reviewSignalBlock(candidate) {
    const signal = candidate.learningSignal;
    const provenance = candidate.learningProvenance;
    if (!signal && !provenance) return '';
    const outcomeText = reviewOutcomeText(signal && signal.outcome);
    const row = (label, value) => value ? `<div class="meta-item"><span class="meta-k">${esc(label)}</span><span class="meta-v">${esc(String(value).slice(0, 200))}</span></div>` : '';
    return `<div class="sect-block">
      <div class="tt">${esc(T('cognition.review_signal_title', '复盘依据'))}</div>
      <div class="meta-row">
        ${row(T('cognition.review_signal_expected', '期望的结果'), stripMarkdown(signal && signal.expectedResult))}
        ${row(T('cognition.review_signal_actual', '实际发生'), stripMarkdown(signal && signal.actualResult).slice(0, 160))}
        ${row(T('cognition.review_signal_outcome', '结果'), outcomeText)}
        ${row(T('cognition.review_signal_attribution', '为什么'), attributionLabel(provenance && provenance.attribution))}
      </div>
    </div>`;
  }

  /* ────────────── 依据链──────────────
   * 更新型候选（update / limit_scope 且带目标方法）把「凭什么改这条方法」摊开：
   * 原方法与版本 / 同次任务 / 预期→实际 / 采用证据 / 为什么改 / 适用范围 / 改动点。
   * 口径：
   *  - 来源名一律走唯一解析器 resolveSourceRef（铁律：任何状态都不上屏 rawId）；
   *  - 长值复用既有折叠样式（foldValue），不新造控件、不加 CSS；
   *  - 只渲染候选自己的字段与已核对的回执摘要，**不整条 dump 记录**——受限正文
   *    不进界面；学习信号里的机器码评分（内部字段）一概不上屏；
   *  - 存量候选没有 targetVersionUsed 时如实说"无法核对改进对象"，不伪造版本；
   *  - 新建型没有"原方法"可回指，返回空串（措辞为「保存」）。 */

  /** 采用证据段（依据链第④段）：唯一权威 = usage 回执 `applied`（只读通道
   *  `recall.assets.adoptionReceipts` 按目标方法拉，见 core.loadAdoptionReceipts）。
   *  候选记录了 taskRunId（同次任务）时只认那一次：对不上就如实说这次任务里没有，
   *  不拿别的任务的采用记录凑数；存量候选没有 taskRunId 时才展示该方法的采用记录。 */
  function adoptionEvidenceHtml(candidate, target) {
    const state = (S.adoptionReceipts && String(S.adoptionReceipts.assetId || '') === String(target.id))
      ? S.adoptionReceipts
      : null;
    const items = (state && Array.isArray(state.items)) ? state.items : [];
    const applied = items.filter((receipt) => String(receipt.status || '') === 'applied');
    const taskRunId = String(candidate.taskRunId || '');
    const scoped = taskRunId ? applied.filter((receipt) => String(receipt.taskRunId || '') === taskRunId) : [];
    const picked = taskRunId ? scoped : applied;
    if (picked.length) {
      const first = picked[0];
      const version = String(first.assetVersion || '');
      const names = (Array.isArray(first.evidence) ? first.evidence : [])
        .map((ref) => resolveSourceRef(ref))
        .map((view) => view.name)
        .filter(Boolean);
      return [
        `<p class="note">${esc(version
          ? T('cognition.chain_adoption_line', '任务里实际采用了 v{version}', { version })
          : T('cognition.chain_adoption_line_bare', '任务里实际采用了这条方法'))}</p>`,
        names.length ? `<p class="note">${esc(T('cognition.adoption_evidence_line', '证据：{names}', { names: names.join('、') }))}</p>` : '',
        picked.length > 1 ? `<p class="note">${esc(T('cognition.chain_adoption_more', '另有 {n} 条采用记录', { n: String(picked.length - 1) }))}</p>` : '',
      ].filter(Boolean).join('');
    }
    // 还没读到（或正在读）：说"正在读"，不说"没有"——读不到 ≠ 没有。
    if (!state || state.loading) {
      return `<p class="note">${esc(T('cognition.chain_adoption_loading', '正在读取采用证据…'))}</p>`;
    }
    return `<p class="note">${esc(taskRunId
      ? T('cognition.chain_adoption_task_missing', '这次任务里没有查到实际采用的记录（只被带入不算采用）。')
      : T('cognition.chain_adoption_empty', '没有查到这条方法的实际采用记录。'))}</p>`;
  }

  /** 这条候选正在展示的"版本冲突"状态（core.openCandidateVersionConflict 写入）。
   *  冲突后依据链必须按**当前在用版**说话：正文与在用版号都以冲突返回体为准
   *  （资产列表即使没刷新成功，也不许拿旧版号/旧正文冒充当前版）。 */
  function candidateConflictState(candidate) {
    const state = S.candidateVersionConflict;
    if (!state || String(state.candidateId) !== String((candidate || {}).id)) return null;
    return state;
  }

  function improvementChainBlock(candidate) {
    const mutating = ['update', 'limit_scope'].includes(String(candidate.suggestedAction || ''));
    if (!mutating || !candidate.targetAssetId) return '';
    const target = S.assets.find((a) => String(a.id) === String(candidate.targetAssetId));
    if (!target) return '';
    const conflict = candidateConflictState(candidate);
    const activeVersion = String((conflict && conflict.currentVersion) || target.activeVersion || target.version || '1');
    // 冲突态下正文只认冲突返回体那一份（core 刚强制重拉的当前在用版快照）：
    // 读不到就说读不到，**不退回资产列表里的旧正文**——拿旧正文当"当前版"
    // 正是这一步要消灭的假象。
    const activeStatement = (conflict
      ? String(conflict.currentStatement || '')
      : String(target.statement || '')).trim();
    const usedVersion = String(candidate.targetVersionUsed || '');
    // 既有版本核对预提示原样保留（展示期口径；确认期冲突是另一回事）。
    const mismatch = usedVersion && usedVersion !== activeVersion
      ? `<div class="warn">${esc(T('cognition.candidate_version_mismatch', '核对改进对象：任务当时使用的是 v{used}，该资产当前在用 v{active}——确认这次更新应作用在当前在用版上。', { used: usedVersion, active: activeVersion }))}</div>`
      : '';
    const fusionNote = `<div class="note">${esc(T('cognition.candidate_fusion_note', '确认后会把这段内容与下面的当前版本融合成一个新版本（旧内容保留、可随时切回），不是覆盖。'))}</div>`;
    const field = (label, inner) => `<div class="field"><span>${esc(label)}</span>${inner}</div>`;

    // ① 原方法与版本：方法名 + 「任务当时用 v{n} / 当前在用 v{m}」。
    const targetName = String(target.title || '').trim() || T('cognition.candidate_untitled', '未命名候选');
    const targetField = field(
      T('cognition.chain_target_label', '这条改进针对的方法'),
      `<p class="note">${esc(targetName)}</p><p class="note">${esc(usedVersion
        ? T('cognition.chain_target_versions', '任务当时用 v{used}，当前在用 v{active}', { used: usedVersion, active: activeVersion })
        : T('cognition.chain_target_no_version', '这条候选没有记录任务当时的版本（存量数据），无法核对改进对象。'))}</p>`,
    );

    // ② 同次任务：优先 learningProvenance.episodeId，退回候选自带的 KSTAR 复盘证据引用；
    //    来源名走唯一解析器（点 chip 就地展开这次任务的经过）。
    const provenanceEpisodeId = String((candidate.learningProvenance && candidate.learningProvenance.episodeId) || '');
    const evidenceEpisodeId = String((evidenceRefs(candidate).find(isKstarEvidenceRef) || {}).id || '');
    const episodeId = provenanceEpisodeId || evidenceEpisodeId;
    const taskField = field(
      T('cognition.chain_task_label', '同次任务'),
      episodeId
        ? `<div class="chips">${evidenceChip({ kind: 'execution', id: episodeId })}</div>`
        : `<p class="note">${esc(T('cognition.chain_task_missing', '这条改进没有关联到具体的任务复盘，无法回看当时的经过。'))}</p>`,
    );

    // ③ 预期 → 实际（learningSignal）：期望 / 实际 / 结果，长值折叠。
    const signal = candidate.learningSignal || {};
    const expected = stripMarkdown(signal.expectedResult);
    const actual = stripMarkdown(signal.actualResult);
    const outcomeText = reviewOutcomeText(signal.outcome);
    const signalLines = [
      expected ? foldValue(`${T('cognition.review_signal_expected', '期望的结果')}：${expected}`) : '',
      actual ? foldValue(`${T('cognition.review_signal_actual', '实际发生')}：${actual}`) : '',
      outcomeText ? `<div class="chips">${chip(outcomeText, 'line')}</div>` : '',
    ].filter(Boolean).join('');
    const signalField = field(
      T('cognition.chain_signal_label', '预期 → 实际'),
      signalLines || `<p class="note">${esc(T('cognition.chain_signal_missing', '这次改进没有记录预期与实际结果。'))}</p>`,
    );

    // ④ 采用证据
    const adoptionField = field(T('cognition.chain_adoption_label', '采用证据'), adoptionEvidenceHtml(candidate, target));

    // ⑤ 为什么改：不确定的地方 + 用途（候选既有字段）。
    const reasonLines = [
      String(candidate.uncertainty || '').trim()
        ? foldValue(`${T('cognition.chain_uncertainty_label', '还不确定的地方')}：${String(candidate.uncertainty).trim()}`)
        : '',
      String(candidate.value || '').trim()
        ? foldValue(`${T('cognition.chain_value_label', '带来的价值')}：${String(candidate.value).trim()}`)
        : '',
    ].filter(Boolean).join('');
    const reasonField = field(
      T('cognition.chain_reason_label', '为什么改'),
      reasonLines || `<p class="note">${esc(T('cognition.chain_reason_missing', '这条候选没有记录改动原因。'))}</p>`,
    );

    // ⑥ 适用范围（沿用资产侧的既有措辞）。
    const applicable = (Array.isArray(candidate.applicableWhen) ? candidate.applicableWhen : []).map(String).filter(Boolean);
    const forbidden = (Array.isArray(candidate.forbiddenWhen) ? candidate.forbiddenWhen : []).map(String).filter(Boolean);
    const scopeLines = [
      applicable.length ? foldValue(`${T('cognition.asset_version_applicable', '适用场景')}：${applicable.join('；')}`) : '',
      forbidden.length ? foldValue(`${T('cognition.asset_version_forbidden', '禁用场景')}：${forbidden.join('；')}`) : '',
    ].filter(Boolean).join('');
    const scopeField = field(
      T('cognition.asset_scope_label', '适用范围'),
      scopeLines || `<p class="note">${esc(T('cognition.chain_scope_missing', '这条候选没有限定适用范围。'))}</p>`,
    );

    // ⑦ 改动点：当前在用版正文（长值折叠）+ 拟生效内容的位置提示。
    //    拟生效的正文就在紧跟本块的编辑区/正文里：这里再复制一份，用户改了控件
    //    上面的摘要还是旧文本（"显示 A 实际 B"）——所以只指位置，不复制内容。
    //    正处版本冲突时按冲突块的口径说话（当前在用版正文 / 确定性读不到）。
    const changedField = conflict
      ? field(
        T('cognition.chain_changed_label', '改动点'),
        activeStatement
          ? foldValue(`${T('cognition.candidate_current_version', '当前版本（v{n}）', { n: activeVersion })}：${activeStatement}`)
          : `<p class="note">${esc(T('cognition.candidate_version_conflict_body_missing', '没能读到当前在用版的正文，无法核对改进对象——先刷新页面再试；也可以先稍后处理或拒绝。'))}</p>`,
      )
      : field(
        T('cognition.chain_changed_label', '改动点'),
        `${foldValue(`${T('cognition.candidate_current_version', '当前版本（v{n}）', { n: activeVersion })}：${activeStatement}`)}<p class="note">${esc(T('cognition.chain_proposed_hint', '这条候选拟生效的内容在下面，可对照当前版本核对。'))}</p>`,
      );

    return `<div class="sect-block ca-chain">
      ${mismatch}
      <div class="tt">${esc(T('cognition.improvement_chain_title', '改进依据'))}</div>
      ${targetField}
      ${taskField}
      ${signalField}
      ${adoptionField}
      ${reasonField}
      ${scopeField}
      ${changedField}
      ${fusionNote}
    </div>`;
  }

  /* ────────────── 确认更新撞版本冲突──────
   * 确认时主进程在资产锁内判定"候选锚定的版本 ≠ 当前在用版"：这次**没有生效**
   * （资产零改动、候选仍待处理）。这里做四件事：
   *  ① 如实说清"没生效、也没覆盖"（不静默覆盖，更不假装成功）；
   *  ② 按**当前在用版**重新摆一次差异——正文取 versions.list 的当前在用版快照
   *     （core 已强制重拉，不是候选生成时那份旧差异）；
   *  ③ 给「按当前版本重新确认」——只有用户点它才会重发这次确认（core.adoptCandidate
   *     在该候选仍有冲突状态时随这次点击带 `confirmBaselineVersion = 当前在用版`），
   *     绝不自动重试；
   *  ④ 拿不到当前在用版正文时如实说"无法核对改进对象"，且**不给**重锚按钮
   *     （用户没看过最新差异就重锚 = 又一次盲确认，正是本流程要消灭的东西；
   *     稍后处理/拒绝仍在，不至于死锁）。存量候选没有版本锚点（versionCheckSkipped）
   *     走的是依据链既有的"无法核对改进对象"表述，同样没有重锚按钮。 */
  function candidateVersionConflictBlock(candidate, canPromote) {
    const state = candidateConflictState(candidate);
    if (!state) return '';
    const used = String(state.targetVersionUsed || '');
    const baseline = String(state.baselineVersion || used || '');
    const current = String(state.currentVersion || '');
    const field = (text, inner) => `<div class="field"><span>${esc(text)}</span>${inner}</div>`;
    // ① 不静默覆盖：事实优先，版本号读不全时退回不给数字的表述（不编版本号）。
    const notApplied = baseline && current
      ? T('cognition.candidate_version_conflict_not_applied', '这条方法在你确认之前被改过（v{baseline} → v{current}），这次确认没有生效，也没有覆盖现在的版本。', { baseline, current })
      : T('cognition.candidate_version_conflict_not_applied_plain', '这条方法在你确认之前被改过，这次确认没有生效，也没有覆盖现在的版本。');
    const head = `<div class="warn">${esc(notApplied)}</div>
      <div class="tt">${esc(T('cognition.candidate_version_conflict_title', '按当前在用版重新核对'))}</div>`;

    // 读不到当前在用版正文：如实说，不给重锚按钮（见文件头 ④）。
    if (state.versionsLoading) {
      return `<div class="sect-block ca-version-conflict" data-version-conflict="${esc(String(candidate.id || ''))}">
        ${head}<p class="note">${esc(T('cognition.candidate_version_conflict_loading', '正在读取当前在用版的正文…'))}</p>
      </div>`;
    }
    const snapshot = state.currentSnapshot || null;
    const currentStatement = String(((snapshot || {}).statement) || '').trim();
    if (state.versionsFailed || !currentStatement) {
      return `<div class="sect-block ca-version-conflict" data-version-conflict="${esc(String(candidate.id || ''))}">
        ${head}<p class="note">${esc(T('cognition.candidate_version_conflict_body_missing', '没能读到当前在用版的正文，无法核对改进对象——先刷新页面再试；也可以先稍后处理或拒绝。'))}</p>
      </div>`;
    }

    // ② 按当前在用版重新摆差异：短字段逐项「当前 → 拟生效」，正文两份摊开。
    //    只列真的不同的项（对齐资产侧版本对比的呈现口径），全同则明说一致。
    const text = (value) => (Array.isArray(value) ? value.join('、') : String(value || '')).trim() || '—';
    const rows = [
      [T('cognition.asset_version_diff_title_field', '标题'), text(snapshot.title), text(candidate.summary)],
      [T('cognition.asset_edit_field_applicable', '适用场景'), text(snapshot.applicableWhen), text(candidate.applicableWhen)],
      [T('cognition.asset_edit_field_forbidden', '禁用场景'), text(snapshot.forbiddenWhen), text(candidate.forbiddenWhen)],
      [T('cognition.asset_version_diff_scope', '适用范围'), text(snapshot.scope), text(candidate.suggestedScope)],
    ].filter((row) => row[1] !== row[2]);
    const fieldDiffRows = rows.length
      ? rows.map(([name, from, to]) => `<div class="meta-item"><span class="meta-k">${esc(name)}</span><span class="meta-v">${esc(from)} → ${esc(to)}</span></div>`).join('')
      : `<p class="note">${esc(T('cognition.asset_version_diff_same', '两版内容一致。'))}</p>`;
    const bodyFields = [
      field(T('cognition.candidate_version_conflict_current_body', '当前在用（v{n}）的正文', { n: current }), foldValue(currentStatement)),
      field(T('cognition.candidate_version_conflict_proposed_body', '这条候选拟生效的内容'), foldValue(String(candidate.judgment || ''))),
    ].join('');
    // ③ 再次确认：只有用户点它才重发确认（act 与「确认更新」同一个写入通道，
    //    区别由 core 侧的冲突状态承载——附带 confirmBaselineVersion = 当前在用版），
    //    绝不自动重试。重锚按钮只在能摆出差异时给（见文件头 ④）。
    const rebase = canPromote && current
      ? `<div class="actions actions-right">${btn(T('cognition.candidate_version_conflict_rebase', '按当前版本重新确认'), 'cand-adopt-with-form', { id: candidate.id, data: { rebase: '1' }, primary: true })}</div>`
      : '';
    return `<div class="sect-block ca-version-conflict" data-version-conflict="${esc(String(candidate.id || ''))}">
      ${head}
      ${fieldDiffRows}
      ${bodyFields}
      <div class="note">${esc(T('cognition.candidate_fusion_note', '确认后会把这段内容与下面的当前版本融合成一个新版本（旧内容保留、可随时切回），不是覆盖。'))}</div>
      ${rebase}
    </div>`;
  }

  /** 待确认口径：需要用户判断且未被"稍后处理"静音。
   *  统计卡与全局 stats 共用这一份（单一事实源），杜绝 7/5/0 三数分叉；
   *  deferred 行仍在列表可见，与待确认同形态，只是不占
   *  "等待确认"名额并带「已稍后处理」标注。 */
  const candidateAwaiting = (candidate) => candidatePending(candidate) && !(candidate.capabilities && candidate.capabilities.isSnoozed);
  /** 候选显示名：优先模型提炼的 summary 短标题——此前
   *  judgment 截断 60 字优先，卡片名成了"内容前缀"看不懂；无 summary 的
   *  存量候选用类别 + 判断前 12 字克制兜底，两者皆空给未命名。 */
  const candidateTitle = (candidate) => {
    if (candidate.contentPurgedAt) return T('cognition.content_purged', '内容已清除');
    const summary = String(candidate.summary || '').trim();
    if (summary) return summary.length > 24 ? `${summary.slice(0, 24)}…` : summary;
    const judgment = String(candidate.judgment || '').trim();
    if (judgment) {
      return `${judgment.slice(0, 12)}${judgment.length > 12 ? '…' : ''}`;
    }
    return T('cognition.candidate_untitled', '未命名候选');
  };

  /* ── 决策三态与按钮名──────────────
   * 判据只有一个：**改的是已存在的那条方法**才说「确认更新」——即
   * `suggestedAction ∈ {update, limit_scope}` **且**带 `targetAssetId`。
   *  - 没有目标方法的候选（`create`，或 `update` 却缺 `targetAssetId`）一律按
   *    新建型渲染：对不存在的旧版说"更新"是假话；
   *  - `pause` 提案（主进程走 pauseAbilityAsset，没有版本比对面）也保持既有
   *    措辞：它既不是"更新成新版"，也没有可重锚的差异面；
   *  - 更新型的「稍后处理 / 拒绝」与对话审批卡共用词条，避免按钮含义漂移。
   *  - 确认词根统一「保存」系：新建型「保存」（原
   *    「保存并使用」，"并使用"的语义并入按钮下的一句说明）、更新型「保存更新」
   *    （原「确认更新」，与对话内审批卡同键同步改）。 */
  const candidateUpdateType = (candidate) => {
    const action = String((candidate || {}).suggestedAction || '');
    return (action === 'update' || action === 'limit_scope') && !!String((candidate || {}).targetAssetId || '');
  };
  const candidateDecisionLabels = (candidate) => (candidate?.proposalTarget === 'ontology'
    ? { promote: T('cognition.ontology_proposal_save', '保存本体变化'), reject: T('cognition.candidate_reject', '不保存') }
    : candidateUpdateType(candidate)
    ? {
      promote: T('recall.asset_approval.confirm', '保存更新'),
      reject: T('recall.asset_approval.reject', '拒绝'),
    }
    : {
      promote: T('cognition.candidate_save_and_use', '保存'),
      reject: T('cognition.candidate_reject', '不保存'),
    });

  function candidateCard(candidate, broken) {
    const refs = evidenceRefs(candidate);
    // 同名兜底来源去重：两条失效来源都
    // 渲染成「来源记录不可用」时并列重复——按解析后的显示名聚合计数，
    // 与详情页来源组的同名合并同一口径。仍只展示前 4 组。
    const refNameCounts = new Map();
    for (const ref of refs.slice(0, 8)) {
      const view = resolveSourceRef(ref);
      const name = view.state === 'immediate' ? T('cognition.evidence_immediate_note', '对话中当场记（无独立会话出处）')
        : view.state === 'processing' ? T('cognition.evidence_source_processing', '来源整理中')
        : view.state === 'unavailable' ? T('cognition.source_unavailable_label', '来源记录不可用')
        : view.name || (view.kind === 'conversation'
          ? T('cognition.evidence_conversation_generic', '一段对话')
          : T('cognition.evidence_fallback', '来源记录'));
      refNameCounts.set(name, (refNameCounts.get(name) || 0) + 1);
    }
    const refsHtml = refs.length
      ? `<div class="c4">${esc(T('cognition.candidate_source', '来源'))}：${[...refNameCounts.entries()].slice(0, 4).map(([name, count]) => esc(count > 1 ? `${name} ×${count}` : name)).join(' · ')}</div>`
      : '';
    // 「来源已删」警示**与标题同一行**——
    // 标题在左，警示条靠右（chevron 之前），不再独立成行压在标题上面；
    // 行内放不下时省略号截断、悬浮 title 看全文。
    const warnHtml = broken
      ? `<span class="warn ca-card-warn-inline" title="${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源暂时无法核对。原会话可能仍然存在；请查看可打开的来源，补充依据或选择不保存。'))}">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源暂时无法核对。原会话可能仍然存在；请查看可打开的来源，补充依据或选择不保存。'))}</span>`
      : '';
    /* 直接保存沿用 cand-adopt-with-form；列表卡没有编辑表单时按未携带编辑处理。 */
    const caps = candidate.capabilities || {};
    const labels = candidateDecisionLabels(candidate);
    const primaryLabel = candidateUpdateType(candidate)
      ? T('recall.asset_approval.confirm', '保存更新')
      : T('cognition.review_card_confirm', '保存');
    const primaryBtn = caps.canPromote
      ? btn(primaryLabel, 'cand-adopt-with-form', { id: candidate.id, small: true, primary: true })
      : '';
    const actionBtns = [
      primaryBtn,
      caps.canReject ? btn(labels.reject, 'cand-decide', { id: candidate.id, data: { action: 'reject' }, small: true, className: 'o' }) : '',
      // 整卡打开详情；委托层的 closest 让行内按钮优先命中自身动作。
    ].filter(Boolean);
    const actionsHtml = actionBtns.length
      ? `<div class="c5 ca-card-actions ca-card-actions-flat">${actionBtns.join('')}</div>`
      : '';
    return `
    <div class="cand${broken ? ' is-broken' : ''}" data-act="open-candidate" data-id="${esc(candidate.id)}" role="button" tabindex="0">
      <div class="c1">${esc(candidateTitle(candidate))}${warnHtml}<span class="chev" aria-hidden="true">›</span></div>
      <div class="c2">${candidateSourceBadge(candidate)}${candidateRiskBadge(candidate)}${(candidate.capabilities && candidate.capabilities.isSnoozed) ? chip(T('cognition.candidate_system_hold', '系统保留（语义复核有发现）'), 'amber') : ''}${candidate.origin === 'manual' ? chip(T('cognition.candidate_user_provided', '用户直接提供')) : broken ? '' : chip(refs.length ? T('cognition.candidate_has_refs', '有来源引用') : T('cognition.candidate_missing_refs', '缺少来源引用'), refs.length ? '' : 'amber')}</div>
      <div class="c3">${esc(String(candidate.judgment || candidate.value || '').slice(0, 800))}</div>
      ${(refsHtml || actionsHtml) ? `<div class="ca-card-footer">${refsHtml}${actionsHtml}</div>` : ''}
    </div>`;
  }

  /* ────────────────────────── 视图：候选详情 ────────────────────────── */

  /* 候选确认表单：
   *  - candidateFormBody：纯表单区（警示/判断/高级/证据+动作），
   *    供整理详情页合并进执行信息卡（外层由调用方提供 ca-candidate-detail
   *    标识——readCandidateForm 靠它就近定位）；
   *  - candidateFormCard：带卡壳与标题行的完整卡（候选详情页用）。
   *  控件 id 带候选 id 后缀：一页多卡时全局 id 不重复（读取靠 [data-f]）。 */
  /** 候选卡的适用范围：新建型候选此前
   *  只显正文与来源，用户看不到它将来在什么范围生效。作用域 + 适用/禁用
   *  场景三行；一个都没有时如实说「没有限定」，不编造默认。更新型候选的
   *  适用范围已由依据链（improvementChainBlock ⑥）呈现，不重复。 */
  function candidateScopeField(candidate, opts = {}) {
    const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    const scope = String(candidate.suggestedScope || '').trim();
    // 适用范围映射走四语词条（与整理表单同源
    // cognition.capture.scope_*），不再硬编码中文——ja/pt 环境此前裸出中文。
    const scopeLabels = {
      general: T('cognition.capture.scope_general', '跨任务通用'),
      report: T('cognition.capture.scope_report', '报告'),
      code: T('cognition.capture.scope_code', '编程'),
      review: T('cognition.capture.scope_review', '审查与评审'),
      product: T('cognition.capture.scope_product', '产品工作'),
    };
    const scopeDisplay = scope.split(',').map((value) => value.trim())
      .filter(Boolean).map((value) => scopeLabels[value.toLocaleLowerCase()] || value).join('、');
    const applicable = (Array.isArray(candidate.applicableWhen) ? candidate.applicableWhen : []).map(String).filter(Boolean);
    const forbidden = (Array.isArray(candidate.forbiddenWhen) ? candidate.forbiddenWhen : []).map(String).filter(Boolean);
    const policy = candidate.scopePolicy && typeof candidate.scopePolicy === 'object' ? candidate.scopePolicy : {};
    const options = S.assetScopeOptions || { agents: [], spaces: [] };
    const names = (items, idField) => new Map((Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item[idField] === 'string' && item[idField])
      .map((item) => [String(item[idField]), String(item.name || item.displayName || item[idField])]));
    const agentNames = names(options.agents, 'agent_id');
    const spaceNames = names(options.spaces, 'space_id');
    if (!agentNames.has('commander')) agentNames.set('commander', T('cognition.asset_scope_main_agent', '主助手'));
    const policyLine = (key, label, lookup) => {
      if (!Object.prototype.hasOwnProperty.call(policy, key)) return '';
      const values = Array.isArray(policy[key]) ? policy[key].map(String) : [];
      if (!values.length) return `${label}：${T('cognition.asset_scope_denied_all', '明确禁止任何对象使用')}`;
      const directoryReady = S.assetScopeOptions && S.assetScopeOptions.status === 'ready';
      return `${label}：${values.map((id) => {
        const known = lookup && lookup.get(id);
        if (known) return known;
        return directoryReady ? `${id}（${T('cognition.asset_scope_missing_value', '当前目录中不可用')}）` : id;
      }).join('、')}`;
    };
    const restrictedDimensions = [
      policyLine('agentIds', T('cognition.asset_scope_visible_agents', '可使用的智能体'), agentNames),
      policyLine('workspaceIds', T('cognition.asset_scope_visible_spaces', '可使用的工作空间'), spaceNames),
      policyLine('roleIds', T('cognition.asset_scope_visible_roles', '可使用的角色'), null),
      policyLine('projectIds', T('cognition.asset_scope_visible_projects', '可使用的项目'), null),
      policyLine('purposeTags', T('cognition.asset_scope_visible_purposes', '适用任务'), null),
      policyLine('conversationKinds', T('cognition.asset_scope_visible_conversation_kinds', '适用会话类型'), null),
      policyLine('fileKinds', T('cognition.asset_scope_visible_file_kinds', '适用文件类型'), null),
    ].filter(Boolean);
    const directoryUnavailable = S.assetScopeOptions && S.assetScopeOptions.status === 'error'
      && ((Array.isArray(policy.agentIds) && policy.agentIds.length > 0)
        || (Array.isArray(policy.workspaceIds) && policy.workspaceIds.length > 0));
    const accessLine = restrictedDimensions.length
      ? restrictedDimensions.join('；')
      : T('cognition.candidate_scope_unrestricted', '没有智能体或工作空间使用限制');
    const accessDisplay = `${accessLine}${directoryUnavailable ? `（${T('cognition.asset_scope_names_unavailable', '名称目录暂不可用，按稳定 ID 显示')}）` : ''}`;
    const lines = [
      scopeDisplay
        ? foldValue(`${T('cognition.candidate_scope_domain', '适用任务范围')}：${scopeDisplay}`)
        : `<p class="note">${esc(T('cognition.candidate_scope_domain_missing', '尚未填写适用任务范围；确认保存前需要补全。'))}</p>`,
      foldValue(`${T('cognition.candidate_scope_access', '使用权限')}：${accessDisplay}`),
      opts.includeTaskConditions === false ? '' : applicable.length ? foldValue(`${T('cognition.asset_version_applicable', '适用场景')}：${applicable.join('；')}`) : '',
      opts.includeTaskConditions === false ? '' : forbidden.length ? foldValue(`${T('cognition.asset_version_forbidden', '禁用场景')}：${forbidden.join('；')}`) : '',
    ].filter(Boolean).join('');
    return `<div class="sect-block">${field(
      T('cognition.asset_scope_label', '适用范围'),
      lines || `<p class="note">${esc(T('cognition.chain_scope_missing', '这条候选没有限定适用范围。'))}</p>`,
    )}</div>`;
  }

  /** 正文规范警示：主进程读回时派生的
   *  statementIssues 在此显示——只提醒不拦截（把关权在人）；编辑后以
   *  表单当前值重算（前端不另立口径，仅按主进程下发的 issue 形态提示）。 */
  const STATEMENT_ISSUE_LABELS = {
    empty: T('cognition.statement_issue_empty', '正文不能为空'),
    too_long: T('cognition.statement_issue_too_long', '正文超长（规则/偏好/事实建议 120 字内、硬限 200；方法/模板不限）'),
    session_debris: T('cognition.statement_issue_session_debris', '正文带会话一次性标识（会话号/cid/turn 号），出处留在来历区'),
    local_path: T('cognition.statement_issue_local_path', '规则/偏好类正文带本机路径或源码文件名（事实类知识本身是该位置则合法）'),
  };
  const statementWarningHtml = (candidate) => {
    const issues = Array.isArray(candidate.statementIssues) ? candidate.statementIssues : [];
    if (!issues.length) return '';
    const lines = issues.map((issue) => STATEMENT_ISSUE_LABELS[issue] || String(issue)).join('；');
    return `<div class="note ca-statement-warning">${esc(T('cognition.statement_warning_prefix', '正文建议调整（可改后保存）：'))}${esc(lines)}</div>`;
  };

  /** 准入软提醒由主进程 capabilities.eligibilityAdvisories 下发，只提醒、不拦截保存。
   *  判定是最近一次读取的快照，编辑后不在前端重算；未知码不展示，避免暴露内部标识。
   *  fact_not_stable 与阻断原因共用词条。 */
  const CANDIDATE_ADVISORY_LABELS = {
    personal_not_stable: T('cognition.candidate_advisory_personal_not_stable', '个人条目没写明这是长期的，可能只是一次性状态，建议核对。'),
    fact_not_stable: T('cognition.candidate_block_fact_not_stable', 'fact 只收长期稳定的事实（项目、环境、领域、工具链）；带「今天/本次/当前」这类时间限定、又没写明长期有效的叙述只是任务状态，不算可复用事实。请核对长期有效性并改写内容。'),
    skill_shape_incomplete: T('cognition.candidate_advisory_skill_shape_incomplete', '方法的结构不完整（目标、步骤、输入输出、评估缺了几项），建议补齐。'),
    rule_missing_boundary: T('cognition.candidate_advisory_rule_missing_boundary', '规则没写适用或禁止范围；可以先保存，之后在待办里补齐边界。'),
    statement_over_soft_budget: T('cognition.candidate_advisory_statement_over_soft_budget', '正文超过 300 字软预算；长叙事建议移到来历区，正文只留结论与做法。'),
  };
  const candidateAdvisoryLines = (candidate) => {
    const caps = candidate.capabilities || {};
    if (String(caps.eligibility || '') !== 'soft_warning') return [];
    const advisories = Array.isArray(caps.eligibilityAdvisories) ? caps.eligibilityAdvisories : [];
    return advisories.map((code) => CANDIDATE_ADVISORY_LABELS[code] || '').filter(Boolean);
  };
  const candidateAdvisoryHtml = (candidate, opts = {}) => {
    const lines = candidateAdvisoryLines(candidate);
    if (!lines.length) return '';
    const head = esc(T('cognition.candidate_advisory_prefix', '以下欠缺不阻止确认，但建议先核对（按最近一次读取）：'));
    // 只读分支给简版一行；编辑分支逐条列出（与 ineligibleReasons 块同形）。
    return opts.inline
      ? `<p class="note">${head}${esc(lines.join('；'))}</p>`
      : `<div class="note cand-block-note">${head}${lines.map((line) => `<br>· ${esc(line)}`).join('')}</div>`;
  };

  function candidateTaskChoices(scope) {
    const choices = [
      ['general', 'cognition.capture.scope_general', '跨任务通用'],
      ['personal', 'cognition.capture.scope_personal', '个人偏好与身份'],
      ['report', 'cognition.detail_scope_report', '报告与文档'],
      ['code', 'cognition.detail_scope_code', '编程开发'],
      ['review', 'cognition.capture.scope_review', '审查与评审'],
      ['product', 'cognition.detail_scope_product', '产品与架构'],
    ].map(([value, key, fallback]) => ({ value, label: T(key, fallback) }));
    // 旧多值和自定义范围原样回写；打开表单绝不自动扩大到 general。
    if (scope && !choices.some(choice => choice.value === scope)) {
      const names = new Map(choices.map(choice => [choice.value, choice.label]));
      const label = String(scope).split(',').map(value => names.get(value.trim()) || value.trim()).join('、');
      choices.unshift({ value: scope, label: T('cognition.detail_scope_existing', '原有设置：{scope}', { scope: label }) });
    }
    if (!scope) choices.unshift({ value: '', label: T('cognition.detail_scope_choose', '请选择适用任务') });
    return choices;
  }
  // 活动详情沿用 HTML 的阅读顺序；数据、版本和能力仍以真实服务返回为准。
  function activityTarget(candidate) {
    if (candidate.proposalTarget === 'ontology') return T('cognition.ontology_proposal_target', '本体变更建议 · 确认前核对下面的记录与版本');
    const targetId = candidate.targetAssetId || candidate.mergedIntoAssetId;
    const target = S.assets.find(asset => String(asset.id) === String(targetId || ''));
    const action = String(candidate.suggestedAction || 'create');
    if (!targetId && action === 'create') return T('cognition.activity_target_create', '拟新建正式资产 · 无已有资产版本');
    if (!target) return T('cognition.activity_target_missing', '未读到目标资产，无法核对当前版本；请刷新后核对。');
    const conflict = candidateConflictState(candidate);
    const active = String(conflict?.currentVersion || target.activeVersion || target.version || '');
    const baseline = String(candidate.targetVersionUsed || '');
    return T('cognition.activity_target_version', '目标：{name} · 当前在用 {current} · 候选基于 {baseline}', {
      name: target.title || T('cognition.candidate_untitled', '未命名候选'),
      current: active ? `v${active}` : T('cognition.activity_version_unknown', '版本未记录'),
      baseline: baseline ? `v${baseline}` : T('cognition.activity_version_unknown', '版本未记录'),
    });
  }
  function activityImpact(candidate) {
    if (candidate.proposalTarget === 'ontology') return T('cognition.ontology_proposal_impact', '确认后一起保存所列本体变化及来源、时间和版本。后续使用仍须满足范围与权限；保存不代表实际采用。');
    const action = String(candidate.suggestedAction || 'create');
    if (action === 'pause') return T('cognition.activity_impact_pause', '确认后暂停目标资产的后续使用，保留正文、版本与历史记录；不会修改全局设置。');
    if (action === 'limit_scope') return T('cognition.activity_impact_boundary', '保存后更新目标资产的适用边界，保留版本记录；不修改全局设置，也不自动扩大对象授权。');
    if (candidate.targetAssetId || candidate.mergedIntoAssetId) return T('cognition.activity_impact_update', '保存后为目标资产生成新版本，保留旧版本；当前对象范围与授权仍受后端校验约束。');
    return T('cognition.activity_impact_create', '正式保存后新建认知资产，仅按该任务范围、对象授权与状态使用；保存不代表已被任务采用。');
  }
  function activityFold(label, html) {
    return html ? `<details class="details" data-activity-disclosure><summary>${esc(label)}</summary><div class="ca-activity-content-stack">${html}</div></details>` : '';
  }
  function activitySources(candidate, options = {}) {
    const refs = options.refs || (evidenceRefs(candidate).length ? evidenceRefs(candidate)
      : (S.reviewEvidence?.['candidate:' + candidate.id]?.items || []).map(item => item.ref));
    const stateKey = options.stateKey || 'candidate:' + candidate.id;
    const empty = options.empty !== undefined ? options.empty : `<p class="note">${esc(candidate.stockOrganizationProvenance?.originalSourceUnrecorded
      ? T('cognition.stock_source_unrecorded', '原始来源未记录；本次整理依据保存的内容，不补充无依据的用途或边界。')
      : T('cognition.activity_not_recorded', '未记录'))}</p>`;
    if (options.deferAlerts) {
      const parts = NS.ui.cognitionSourceParts(refs, stateKey, true);
      const content = refs.length ? parts.content : empty;
      return {
        html: NS.ui.cognitionSourceSection(`${options.before || ''}${content}${options.after || ''}`, { fold: false }),
        alerts: `${options.alerts || ''}${parts.alerts}`,
      };
    }
    return NS.ui.cognitionSources(refs, stateKey, { fold: true, open: true, empty, ...options });
  }
  function suggestedActionLabel(candidate) {
    if (candidate.contentOrganization) return candidate.contentOrganization.draft?.operation === 'merge' ? T('cognition.organization_merge', '内容合并') : T('cognition.organization_split', '内容拆分');
    if (candidate.proposalTarget === 'ontology') return T('cognition.activity_operation_update', '建议更新');
    const action = String(candidate.suggestedAction || 'create');
    return ({
      create: T('cognition.activity_operation_create', '建议新增'),
      update: T('cognition.activity_operation_update', '建议更新'),
      limit_scope: T('cognition.activity_operation_boundary', '建议补充边界'),
      pause: T('cognition.activity_operation_pause', '建议暂停'),
      keep_current: T('cognition.activity_history_keep', '保留现有内容'),
      reject: T('cognition.inbox_action_reject', '拒绝'),
    })[action] || T('cognition.activity_suggested_action', '建议动作');
  }
  function activityHistory(candidate, comparison = '') {
    const state = S.activityHistory?.[candidate.id];
    const labels = {
      accept: T('cognition.activity_history_accept', '确认保存'), modify: T('cognition.activity_history_modify', '修改后保存'),
      defer: T('cognition.activity_defer', '稍后处理'), reject: T('cognition.inbox_action_reject', '拒绝'),
      ignore: T('cognition.inbox_action_ignore', '忽略'), keep_current: T('cognition.activity_history_keep', '保留现有内容'),
      trial: T('cognition.activity_history_trial', '试用'),
    };
    const records = state?.items || [];
    const entries = records.map(item => `<li><strong>${esc(labels[item.decision_type] || T('cognition.activity_history_decision', '审查决定'))}</strong><time>${esc(NS.fmtDate(item.timestamp))}</time><p>${esc(item.actor === 'system' ? T('cognition.activity_history_system', '系统') : item.actor === 'user' ? T('cognition.activity_history_user', '你（人工）') : T('cognition.activity_actor_unknown', '历史记录未提供'))}${item.reason ? ` · ${esc(item.reason)}` : ''}</p>${item.outcome === 'asset_failed' ? `<p class="note">${esc(T('cognition.activity_history_failed', '正式保存未成功，不能视为已生效。'))}</p>` : ''}</li>`).join('');
    return NS.ui.cognitionHistory(`${comparison}${state?.open ? `${state.loading ? `<p class="note">${esc(T('common.loading', '加载中…'))}</p>` : state.error ? `<p role="alert" class="note">${esc(state.error)}</p>` : `<ol>${entries || `<li>${esc(T('cognition.activity_history_empty', '没有读到本条审查决定；不代表完整历史中从未发生过操作。'))}</li>`}</ol>`}${candidate.userModifiedAt ? `<p class="note">${esc(T('cognition.activity_history_last_edit', '最近候选修改：{at}', { at: NS.fmtDate(candidate.userModifiedAt) }))}</p>` : ''}${candidate.activityDeferredAt ? `<p class="note">${esc(T('cognition.activity_history_deferred', '标记稍后处理：{at}', { at: NS.fmtDate(candidate.activityDeferredAt) }))}</p>` : ''}` : ''}`, { candidateId: candidate.id, open: state?.open });
  }
  // One reviewed decision includes the cognition and dependent ontology changes.
  // Render named semantic fields rather than exposing a raw command or record IDs.
  function ontologyFormationHtml(candidate, terminal, options = {}) {
    const plan = candidate.ontologyFormation;
    if (!plan || plan.schemaVersion !== 1) return '';
    const changes = Array.isArray(plan.previewChanges) ? plan.previewChanges : [];
    const baseline = S.ontologySnapshot?.records || {};
    const beforeRecords = Object.assign({}, baseline);
    const afterRecords = Object.assign({}, baseline);
    for (const change of changes) {
      if (change.before?.id) beforeRecords[change.before.id] = change.before;
      if (change.after?.id) afterRecords[change.after.id] = change.after;
    }
    const standalone = options.standalone === true;
    const missing = () => T('cognition.activity_not_recorded', '未记录');
    const readable = value => {
      let text = String(value || '');
      for (const [id, record] of Object.entries(afterRecords)) if (record.name) text = text.split(id).join(record.name);
      return text === 'stored-version' ? T('cognition.ontology_stored_basis', '保存的本体版本') : text;
    };
    const named = (id, records) => records[id]?.name || T('cognition.formation_unresolved', '对象尚未解析');
    const valueText = (value, records) => value?.kind === 'entity' ? named(value.id, records)
      : value?.kind === 'literal' ? String(value.value) : missing();
    const enumText = value => ({
      active: T('cognition.asset_status.active', '生效中'), paused: T('cognition.asset_status.paused', '已暂停'),
      archived: T('cognition.asset_status.archived', '已归档'), corrected: T('cognition.formation_corrected', '已纠正'),
      confirmed: T('cognition.formation_confirmed', '已核实'), inferred: T('cognition.formation_inferred', '推测'), unknown: T('cognition.settings_policy_unknown', '状态未知'),
      task: T('cognition.formation_task_access', '允许在任务中选用'), owner_only: T('cognition.formation_owner_access', '仅本人查看'),
      required: T('cognition.formation_required', '必须满足'), default: T('cognition.formation_default', '默认采用'),
      suggestion: T('cognition.formation_suggestion', '建议采用'), logic: T('cognition.formation_logic', '推理规则'),
    })[value] || missing();
    const conditionText = (condition, records, depth = 0) => {
      if (!condition) return T('cognition.formation_all_tasks', '所有任务');
      if (depth > 8) return T('cognition.formation_unresolved', '对象尚未解析');
      if (condition.kind === 'task') {
        const field = ({ purpose: T('cognition.formation_purpose', '任务用途'), taskKind: T('cognition.formation_task_kind', '任务类型'), entityId: T('cognition.formation_object', '对象') })[condition.field] || missing();
        return field + '：' + (condition.field === 'entityId' ? named(condition.equals, records) : condition.equals);
      }
      if (condition.kind === 'assertion') return [named(condition.subjectId, records), named(condition.definitionId, records), condition.object ? valueText(condition.object, records) : ''].filter(Boolean).join(' · ');
      if (condition.kind === 'not') return T('cognition.formation_not', '不满足') + ' (' + conditionText(condition.condition, records, depth + 1) + ')';
      if (['all', 'any'].includes(condition.kind) && Array.isArray(condition.conditions)) return '(' + condition.conditions.map(item => conditionText(item, records, depth + 1)).join(' ' + (condition.kind === 'all' ? T('cognition.formation_and', '并且') : T('cognition.formation_or', '或者')) + ' ') + ')';
      return missing();
    };
    const effectText = (effect, records) => {
      if (effect?.kind === 'include_recipient') return T('cognition.formation_recipient', '加入接收人') + '：' + named(effect.entityId, records);
      if (effect?.kind === 'required_section') return T('cognition.formation_required_section', '必需章节') + '：' + effect.name;
      if (effect?.kind === 'choice') return effect.key + '：' + effect.value;
      return T('cognition.formation_reference_only', '提供认识与依据；未接入自动执行');
    };
    const read = (label, value) => `<dl class="ca-approval-fact"><dt>${esc(label)}</dt><dd class="content-text">${esc(value == null || value === '' ? missing() : value)}</dd></dl>`;
    const recordHtml = (record, records, onlyKeys) => {
      if (!record) return `<p class="note">${esc(T('cognition.formation_new_record', '此前没有这条记录'))}</p>`;
      const rows = [];
      const row = (keys, label, value) => { if (!onlyKeys || keys.some(key => onlyKeys.includes(key))) rows.push(read(label, value)); };
      if (record.name) row(["name"], T('cognition.capture.name', '认知名称'), record.name);
      if (record.description) row(["description"], T('cognition.formation_description', '含义与说明'), record.description);
      if (record.kind === 'module') row(["scope"], T('cognition.asset_version_diff_scope', '适用范围'), record.scope?.kind === 'personal' ? T('cognition.formation_personal', '个人') : record.scope?.kind === 'project' ? T('cognition.formation_project', '项目范围') : T('cognition.formation_workspace', '工作空间范围'));
      if (record.kind === 'definition') {
        row(["definitionKind", "valueType", "cardinality", "cardinalityAnchor"], T('cognition.formation_structure', '结构'), [record.definitionKind, record.valueType, record.cardinality, record.cardinalityAnchor].map(value => ({
          type: T('cognition.formation_type', '事物类型'), relation: T('cognition.formation_relation', '关系'), attribute: T('cognition.formation_attribute', '属性'),
          entity: T('cognition.formation_object', '对象'), text: T('cognition.formation_text', '文本'), number: T('cognition.formation_number', '数值'), boolean: T('cognition.formation_boolean', '是或否'), date: T('cognition.formation_date', '日期'),
          one: T('cognition.formation_one', '单值'), many: T('cognition.formation_many', '多值'), subject: T('cognition.formation_subject', '主体'), object: T('cognition.formation_value', '取值'),
        })[value] || missing()).join(' · '));
        row(["subjectTypes"], T('cognition.formation_subject_types', '允许的主体类型'), (record.subjectTypes || []).map(id => named(id, records)).join('；'));
        row(["objectTypes"], T('cognition.formation_object_types', '允许的取值类型'), (record.objectTypes || []).map(id => named(id, records)).join('；'));
      }
      if (record.kind === 'entity') {
        row(["typeId"], T('cognition.formation_type', '事物类型'), named(record.typeId, records));
        row(["aliases"], T('cognition.formation_aliases', '其他名称'), (record.aliases || []).join('；'));
        row(["identityStatus"], T('cognition.formation_identity', '身份核对'), record.identityStatus === 'confirmed' ? enumText('confirmed') : T('cognition.formation_unresolved', '对象尚未解析'));
      }
      if (record.kind === 'assertion') {
        row(["subjectId"], T('cognition.formation_subject', '主体'), named(record.subjectId, records));
        row(["definitionId"], T('cognition.formation_relation', '关系'), named(record.definitionId, records));
        row(["object"], T('cognition.formation_value', '取值'), valueText(record.object, records));
        row(["validity"], T('cognition.formation_validity', '有效时间'), [record.validity?.from || missing(), record.validity?.until || T('cognition.formation_no_end', '未设结束日期'), record.validity?.timezone].filter(Boolean).join(' · '));
      }
      if (record.kind === 'rule') {
        row(["requirement"], T('cognition.activity_body_read', '可复用正文'), record.requirement);
        row(["strength"], T('cognition.formation_strength', '采用要求'), enumText(record.strength));
        row(["condition"], T('cognition.formation_conditions', '适用条件'), conditionText(record.condition, records));
        row(["effect"], T('cognition.formation_effect', '对后续任务的影响'), effectText(record.effect, records));
        row(["exception"], T('cognition.formation_exception', '例外'), record.exception);
      }
      if (record.kind === 'reference') {
        row(["targetRecordId", "targetModuleId"], T('cognition.activity_target_label', '目标 / 版本'), named(record.targetRecordId || record.targetModuleId, records));
        row(["versionPolicy", "targetVersion"], T('cognition.formation_reference_version', '引用版本'), record.versionPolicy === 'pinned' ? 'v' + record.targetVersion : T('cognition.formation_current_version', '跟随有效版本'));
      }
      row(["status", "access"], T('cognition.formation_status', '状态与使用权限'), enumText(record.status) + ' · ' + enumText(record.access));
      if (record.certainty) row(["certainty"], T('cognition.formation_certainty', '确定程度'), enumText(record.certainty));
      // Activity has one resolved evidence section. Authorship/source metadata is
      // not a content change, and legacy labels may contain opaque locators.
      if (!options.activity) row(["source"], T('cognition.activity_evidence_title', '来源与证据'), record.source?.label);
      return rows.join('');
    };
    const boxName = box => ({ T: T('cognition.formation_t_box', 'T · 概念与结构'), R: T('cognition.formation_r_box', 'R · 规则与约束'), A: T('cognition.formation_a_box', 'A · 具体情况与依据') })[box] || missing();
    const intentText = intent => intent === 'correct' ? T('cognition.formation_correct_intent', '纠正记错的内容')
      : intent === 'change' ? T('cognition.formation_change_intent', '现实发生变化，保留过去')
        : intent === 'create' ? T('cognition.formation_create', '新增记录') : T('cognition.activity_operation_update', '建议更新');
    const changeHtml = changes.map(change => `<article class="ca-detail-group"><h4>${esc(boxName(change.box))} · ${esc(change.after?.name || change.before?.name || T('cognition.formation_record', '关联记录'))} · ${esc(intentText(change.intent))}</h4>
      ${read(T('cognition.activity_target_label', '目标 / 版本'), change.before ? T('cognition.formation_versions', '原 v{before} → 新 v{after}', { before: String(change.before.version), after: String(change.after?.version) }) : T('cognition.formation_create', '新增记录'))}
      <details class="details"><summary>${esc(T('cognition.formation_before', '修改前'))}</summary>${recordHtml(change.before, beforeRecords)}</details>
      <div class="ca-detail-after"><h4>${esc(T('cognition.formation_after', '拟保存内容'))}</h4>${recordHtml(change.after, afterRecords)}</div></article>`).join('');
    const standaloneChanges = standalone ? changes.map(change => {
      const before = change.before, after = change.after;
      if (!after) return `<p role="alert">${esc(T('cognition.ontology_preview_missing', '未读到拟保存内容，不能确认。请刷新后核对。'))}</p>`;
      const mainFields = after.kind === 'rule' ? ['requirement', 'condition', 'exception']
        : ['definition', 'entity', 'module'].includes(after.kind) ? ['description'] : [];
      const labels = { description: T('cognition.formation_description', '含义与说明'), requirement: T('cognition.asset_content_section', '内容'),
        condition: T('cognition.formation_conditions', '适用条件'), exception: T('cognition.formation_exception', '例外') };
      const renderValue = (record, key, records) => key === 'condition' ? conditionText(record?.condition, records) : record?.[key];
      if (before?.name !== after.name && after.name && mainFields.length) {
        mainFields.unshift('name'); labels.name = T('cognition.asset_version_diff_title_field', '标题');
      }
      // One prose field needs no nested label under “proposed / previous”.
      const mainContent = (record, records) => mainFields.length === 1
        ? `<p class="content-text">${esc(renderValue(record, mainFields[0], records) || missing())}</p>`
        : mainFields.length ? mainFields.map(key => read(labels[key], renderValue(record, key, records))).join('') : recordHtml(record, records);
      const body = mainContent(after, afterRecords);
      const old = mainContent(before, beforeRecords);
      return `<article class="ca-review-ontology-change">
        ${changes.length > 1 ? `<h3>${esc(after.name || named(after.subjectId, afterRecords))}</h3>` : ''}
        <p class="note">${esc(before ? T('cognition.formation_versions', '原 v{before} → 新 v{after}', { before: String(before.version), after: String(after.version) }) : T('cognition.formation_create', '新增记录'))}</p>
        <section class="ca-detail-after"><h3>${esc(T(candidate.status === 'integrated' ? 'cognition.ontology_saved_content' : 'cognition.formation_after', candidate.status === 'integrated' ? '本次保存内容' : '拟保存内容'))}</h3>${body}</section>
        <section class="ca-detail-before"><h3>${esc(T('cognition.formation_before', '修改前'))}</h3>${before ? old : `<p>${esc(T('cognition.formation_new_record', '此前没有这条记录'))}</p>`}</section>
        ${mainFields.length ? `<details class="details"><summary>${esc(T('cognition.ontology_structure_access', '结构、范围与使用权限'))}</summary>${recordHtml(after, afterRecords)}${before ? `<section class="ca-detail-group"><h4>${esc(T('cognition.ontology_original_record', '修改前的完整记录'))}</h4>${recordHtml(before, beforeRecords)}</section>` : ''}</details>` : ''}
      </article>`;
    }).join('') : '';
    const blocked = Array.isArray(plan.blockedReasons) && plan.blockedReasons.length;
    const reasonText = reason => {
      const [code, id] = String(reason).split(':');
      const explanation = ({
        content_review_required: T('cognition.activity_content_review_required', '这条建议需要核对来源与表述，核对完成前不能确认保存。'),
        stock_source_requires_review: T('cognition.activity_source_review_required', '记录的来源尚未核对，请检查对应消息与附件。'),
        stock_recheck_failed: T('cognition.formation_recheck_failed', '重新核对未完成。原建议和已保存修改仍保留，可重试。'),
        identity_evidence_required: T('cognition.formation_identity_evidence', '对象身份需要原文依据核对'),
        uncertain_ontology: T('cognition.formation_uncertain', '内容仍不确定，需要人工核对'),
        shared_rule_reference_required: T('cognition.formation_shared_body_required', '规则正文与认知需要建立共同引用'),
        ontology_scope_exceeds_cognition: T('cognition.formation_scope_exceeds_cognition', '关联本体的可用范围超出了这条认知的范围，需重新比较并保留来源限制。'),
        baseline_changed: T('cognition.activity_attention_version', '需重核版本'),
        candidate_edited_requires_ontology_review: standalone ? T('cognition.ontology_request_changed', '修改要求尚未应用到下方结果。生成新建议后才能确认保存，会调用模型。') : T('cognition.formation_edited_review', '你已修改认知内容，关联本体建议仍基于旧内容；请重新核对整体变化后再确认。'),
      })[code] || T('cognition.formation_blocked', '关联变化尚不能保存，需要重新核对或提取。');
      return explanation + (id && (afterRecords[id] || beforeRecords[id]) ? ' · ' + named(id, afterRecords) : '');
    };
    const references = (Array.isArray(plan.refs) ? plan.refs : []).map(ref => {
      const label = named(ref.recordId, afterRecords);
      return `<li>${btn(label, 'open-ontology', { small: true, disabled: !terminal && !baseline[ref.recordId], data: { 'module-id': ref.moduleId, 'record-id': ref.recordId } })} · ${esc(ref.versionPolicy === 'pinned' ? 'v' + ref.targetVersion : T('cognition.formation_current_version', '跟随有效版本'))}${ref.sharedBody ? ' · ' + esc(T('cognition.formation_shared_body', '与认知共用正文及有效版本')) : ''}</li>`;
    }).join('');
    const recheck = S.formationRechecks?.[candidate.id];
    const recheckHtml = terminal ? '' : `<div class="ca-formation-recheck">
      ${btn(standalone && plan.blockedReasons?.includes('candidate_edited_requires_ontology_review') && !recheck?.running ? T('cognition.ontology_generate_request', '按要求生成建议') : T(recheck?.running ? 'cognition.formation_rechecking' : 'cognition.formation_recheck', recheck?.running ? '正在重新核对…' : '重新核对关联建议'), 'formation-recheck', { id: candidate.id, small: true, disabled: recheck?.running || !attentionReady(candidate) })}
      ${recheck?.running ? `<p role="status">${esc(T('cognition.formation_recheck_progress', '正在结合已保存的认知修改、来源与当前本体重新核对；完成后仍需你确认整体变化。'))}</p>` : ''}
      ${recheck?.error ? `<p role="alert">${esc(recheck.error)}</p>` : ''}
      ${recheck?.completed ? `<p role="status">${esc(T('cognition.formation_recheck_complete', '已重新核对。请阅读更新后的整体差异，再决定是否确认保存。'))}</p>` : ''}
    </div>`;
    if (options.activity) {
      const bodies = [], previous = [], structures = [];
      for (const change of changes) {
        const before = change.before, after = change.after;
        if (!after) continue;
        const mainKeys = after.kind === 'rule' ? ['requirement', 'condition', 'exception']
          : after.kind === 'assertion' ? ['subjectId', 'definitionId', 'object', 'validity']
          : ['definition', 'entity', 'module'].includes(after.kind) ? ['description'] : ['targetRecordId', 'versionPolicy'];
        const labels = { description: T('cognition.formation_description', '含义与说明'), requirement: T('cognition.asset_content_section', '内容'),
          condition: T('cognition.formation_conditions', '适用条件'), exception: T('cognition.formation_exception', '例外'),
          subjectId: T('cognition.formation_subject', '主体'), definitionId: T('cognition.formation_relation', '关系'), object: T('cognition.formation_value', '取值'),
          validity: T('cognition.formation_validity', '有效时间'), targetRecordId: T('cognition.activity_target_label', '目标 / 版本'), versionPolicy: T('cognition.formation_reference_version', '引用版本'), name: T('cognition.asset_version_diff_title_field', '标题') };
        const value = (record, key, records) => !record ? missing() : key === 'condition' ? conditionText(record.condition, records)
          : ['subjectId', 'definitionId', 'targetRecordId'].includes(key) ? named(record[key] || record.targetModuleId, records)
          : key === 'object' ? valueText(record.object, records)
          : key === 'validity' ? [record.validity?.from || missing(), record.validity?.until || T('cognition.formation_no_end', '未设结束日期'), record.validity?.timezone].filter(Boolean).join(' · ')
          : key === 'versionPolicy' ? record.versionPolicy === 'pinned' ? 'v' + record.targetVersion : T('cognition.formation_current_version', '跟随有效版本') : record[key];
        const name = after.name || named(after.subjectId, afterRecords);
        const heading = changes.length > 1 || !standalone ? `<h4>${esc(boxName(change.box))} · ${esc(name)}</h4>` : '';
        const cleanSourceLabel = value => {
          const raw = String(value || '').trim();
          const strip = NS.ui?.stripInternalIds;
          return strip ? strip(raw) : raw;
        };
        const sourceLine = record => record?.source?.label
          ? read(T('cognition.activity_evidence_title', '来源与证据'), cleanSourceLabel(record.source.label)) : '';
        const versionLine = before
          ? read(T('cognition.activity_target_label', '目标 / 版本'), T('cognition.formation_versions', '原 v{before} → 新 v{after}', { before: String(before.version), after: String(after.version) }))
          : '';
        bodies.push(`<article class="ca-review-ontology-change">${heading}${mainKeys.length === 1
          ? `<p class="content-text">${esc(value(after, mainKeys[0], afterRecords) || missing())}</p>`
          : mainKeys.map(key => read(labels[key], value(after, key, afterRecords))).join('')}</article>`);
        const changed = ['name', ...mainKeys].filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]));
        const structureKeys = ['definitionKind','subjectTypes','objectTypes','valueType','cardinality','cardinalityAnchor','typeId','aliases','identityStatus','scope','access','status','certainty','strength','effect','targetVersion','targetModuleId'];
        const changedStructure = before ? structureKeys.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])) : [];
        const safetyTerms = text => String(text || '').match(/\d+(?:[.,]\d+)*|必须|不得|禁止|不|未|无|仅|只有|如果|除非|例外|应|预计|预期|可能|待|即可|已|保证|确定|must|shall|never|not|only|if|unless|except|may|might|expected|guaranteed/gi) || [];
        const needsComparison = changed.some(key => ['condition', 'exception', 'validity', 'object'].includes(key)
          || JSON.stringify(safetyTerms(value(before, key, beforeRecords))) !== JSON.stringify(safetyTerms(value(after, key, afterRecords))))
          || changedStructure.length > 0;
        if (!before || changed.length || changedStructure.length) previous.push(`<article class="ca-detail-group">${heading}${versionLine}${standalone ? '' : sourceLine(before)}${standalone ? '' : sourceLine(after)}
          ${before ? `<details${needsComparison ? ' open' : ''}><summary>${esc(T('cognition.activity_previous_content', '修改前内容'))}</summary>${changed.map(key => read(labels[key], value(before, key, beforeRecords))).join('')}${changedStructure.length ? recordHtml(before, beforeRecords, changedStructure) : ''}</details>${changedStructure.length ? `<section><h4>${esc(T('cognition.formation_after', '拟保存内容'))}</h4>${recordHtml(after, afterRecords, changedStructure)}</section>` : ''}` : `<p class="note">${esc(T('cognition.formation_new_record', '此前没有这条记录'))}</p>`}</article>`);
        structures.push(`<article class="ca-detail-group">${heading}${recordHtml(after, afterRecords)}${before ? activityFold(T('cognition.ontology_original_record', '修改前的完整记录'), recordHtml(before, beforeRecords)) : ''}</article>`);
      }
      const content = bodies.length ? `<section class="ca-review-formation ca-review-ontology"><h3>${esc(T(standalone ? candidate.status === 'integrated' ? 'cognition.ontology_saved_content' : 'cognition.formation_after' : terminal ? 'cognition.formation_saved_title' : 'cognition.formation_title', standalone ? candidate.status === 'integrated' ? '本次保存内容' : '拟保存内容' : terminal ? '本次关联本体的处理内容' : '一起确认的本体变化'))}</h3>${bodies.join('')}</section>`
        : `<p role="alert">${esc(T('cognition.ontology_preview_missing', '未读到拟保存内容，不能确认。请刷新后核对。'))}</p>`;
      const urgent = blocked || recheck?.running || recheck?.error || recheck?.completed;
      return { content,
        changes: previous.length ? `<section class="ca-review-changes"><h3>${esc(T('cognition.detail_changes', '本次变化'))}</h3><p class="content-text">${esc(readable(plan.reason || candidate.evidenceSummary || candidate.judgment))}</p>${previous.join('')}</section>` : '',
        basis: `${plan.evidence?.length ? `<p class="note">${esc(plan.evidence.map(readable).join('；'))}</p>` : ''}${plan.effectiveFrom ? read(T('cognition.formation_effective_from', '变更生效时间'), plan.effectiveFrom) : ''}`,
        details: activityFold(T('cognition.ontology_structure_access', '结构、范围与使用权限'), structures.join(''))
          + activityFold(T('cognition.formation_references', '关联已有与本次形成的对象'), references ? `<ul>${references}</ul>` : '')
          + (!terminal && !urgent ? activityFold(T('cognition.ontology_recheck_options', '重新核对建议'), `<p class="note">${esc(T('cognition.ontology_recheck_cost', '核对建议与当前来源是否相符，会调用模型；原记录不变。'))}</p>${recheckHtml}`) : ''),
        alerts: `${blocked ? `<p role="alert">${esc(plan.blockedReasons.map(reasonText).join('；'))}</p>` : ''}${plan.requiresTReview ? `<p class="note" role="status">${esc(T('cognition.formation_t_manual', '包含 T 概念或结构变化，必须由你人工确认；请核对已有记录是否仍能正确理解。'))}</p>` : ''}${urgent ? recheckHtml : ''}` };
    }
    if (standalone) return `<section class="ca-review-formation ca-review-ontology">
      ${standaloneChanges || `<p role="alert">${esc(T('cognition.ontology_preview_missing', '未读到拟保存内容，不能确认。请刷新后核对。'))}</p>`}
      <section><h3>${esc(T('cognition.ontology_change_basis', '整理依据'))}</h3><p class="content-text">${esc(readable(plan.reason || candidate.evidenceSummary || candidate.judgment))}</p>
      ${plan.evidence?.length ? `<p class="note">${esc(plan.evidence.map(readable).join('；'))}</p>` : ''}
      ${plan.effectiveFrom ? read(T('cognition.formation_effective_from', '变更生效时间'), plan.effectiveFrom) : ''}</section>
      ${references ? `<section><h3>${esc(T('cognition.formation_references', '关联已有与本次形成的对象'))}</h3><ul>${references}</ul></section>` : ''}
      ${blocked ? `<p role="alert">${esc(plan.blockedReasons.map(reasonText).join('；'))}</p>${recheckHtml}`
        : recheck?.running || recheck?.error || recheck?.completed ? recheckHtml : !terminal ? `<details class="details"><summary>${esc(T('cognition.ontology_recheck_options', '重新核对建议'))}</summary><p class="note">${esc(T('cognition.ontology_recheck_cost', '核对建议与当前来源是否相符，会调用模型；原记录不变。'))}</p>${recheckHtml}</details>` : ''}
    </section>`;
    return `<section class="ca-review-formation"><h3>${esc(T(terminal ? 'cognition.formation_saved_title' : 'cognition.formation_title', terminal ? '本次关联本体的处理内容' : '一起确认的本体变化'))}</h3>
      ${read(T('cognition.activity_reason', '处理依据'), plan.reason)}${read(T('cognition.activity_evidence_title', '来源与证据'), (plan.evidence || []).join('；'))}
      ${plan.effectiveFrom ? read(T('cognition.formation_effective_from', '变更生效时间'), plan.effectiveFrom) : ''}${changeHtml}
      ${references ? `<h4>${esc(T('cognition.formation_references', '关联已有与本次形成的对象'))}</h4><ul>${references}</ul>` : ''}
      ${plan.requiresTReview ? `<p class="note" role="status">${esc(T('cognition.formation_t_manual', '包含 T 概念或结构变化，必须由你人工确认；请核对已有记录是否仍能正确理解。'))}</p>` : ''}
      ${blocked ? `<p class="note" role="alert">${esc(plan.blockedReasons.map(reasonText).join('；'))}</p>` : ''}
      ${recheckHtml}
      <p class="note">${esc(candidate.proposalTarget === 'ontology' ? T('cognition.ontology_proposal_atomic_hint', '这组本体变化作为一次决定共同保存，并在提交前重新核对来源与版本。独立本体建议不会另存为认知资产。') : T('cognition.formation_atomic_hint', '认知和相互依赖的本体变化作为一次决定共同保存，并在保存前重新核对版本；不会只保存其中一半。保存不代表任务已采用。'))}</p></section>`;
  }
  function autoReviewReasonText(reason) {
    const value = String(reason || '').trim();
    const semanticReasons = {
      candidate_semantic_support_failed: ['cognition.auto_semantic_support_failed', '原文不足以支持整条认知或关联本体变化，请人工核对。'],
      candidate_semantic_support_unavailable: ['cognition.auto_semantic_support_unavailable', '暂未完成独立原文核查，请人工核对。'],
      candidate_semantic_support_changed: ['cognition.auto_semantic_support_changed', '核查期间原文、权限或候选发生变化，请重新核对。'],
    };
    const semanticKey = value.split(':')[0];
    const semantic = Object.prototype.hasOwnProperty.call(semanticReasons, semanticKey) ? semanticReasons[semanticKey] : undefined;
    if (semantic) return T(semantic[0], semantic[1]);
    // Unknown policy codes are not user-facing prose or evidence.
    if (/^[a-z][a-z0-9_]*(?::.*)?$/.test(value)) return NS.promotionBlockText?.(value)
      || T('cognition.activity_manual_review', '保留人工确认');
    return value;
  }
  function organizationForm(candidate, options) {
    const plan = candidate.contentOrganization, canEdit = !!candidate.capabilities?.canEdit && !candidate.organizationReceipt;
    const edit = canEdit && (!options.compact || !!options.editing);
    const missing = T('cognition.activity_not_recorded', '未记录');
    const sharedIds = new Set(plan.sources.flatMap(source => (source.content.ontologyRefs || []).filter(ref => ref.sharedBody).map(ref => ref.recordId)));
    const outputOntology = (output, index) => {
      const records = output.ontologyRecordIds.filter(id => !sharedIds.has(id)).map(id => plan.ontologyAfter.records[id] || plan.ontologyBaseline[id]).filter(Boolean);
      if (plan.ontologyAfter.records[`${plan.operationId}-rule-${index + 1}`]) records.push({ name: output.title });
      return records.length ? `<section class="ca-library-related"><h4>${index + 1}. ${esc(output.title)}</h4>${records.map(record => `<p>${esc(record.name || [plan.ontologyBaseline[record.subjectId]?.name || record.subjectId, plan.ontologyBaseline[record.definitionId]?.name || record.definitionId, record.object?.value].filter(Boolean).join(' · ') || record.id)}</p>`).join('')}</section>` : '';
    };
    const contentOf = output => ({ ...output, scope: plan.sources[0].head.scope, scopePolicy: plan.sources[0].head.scopePolicy });
    const controls = (output, index, part = 'all') => {
      const attrs = key => ({ 'data-org-index': String(index), 'data-org-field': key, 'data-f': `org-${index}-${key}` });
      const inputs = Object.fromEntries(['statement', 'value', 'applicableWhen', 'forbiddenWhen'].map(key => [key,
        window.uiTextarea({ id: `org-${candidate.id}-${index}-${key}`, value: Array.isArray(output[key]) ? output[key].join('\n') : output[key] || '',
          ariaLabel: T(key === 'statement' ? 'cognition.asset_content_section' : key === 'value' ? 'cognition.detail_future_use' : key === 'applicableWhen' ? 'cognition.detail_conditions' : 'cognition.detail_exceptions', key),
          attrs: { ...attrs(key), rows: key === 'statement' ? 5 : 2, maxlength: 4000, placeholder: missing } })]));
      const title = part === 'boundary' ? '' : window.uiField({ id: `org-${candidate.id}-${index}-title`, label: T('cognition.asset_version_diff_title_field', '标题'), showRequirement: false,
        control: { kind: 'input', value: output.title, attrs: { ...attrs('title'), maxlength: 1000 } } });
      return title + NS.ui.cognitionContentFields(contentOf(output), { controls: inputs, part: options.compact ? part : 'all', omitUseHint: !!options.compact });
    };
    const readContent = (output, part) => NS.ui.cognitionContentFields(contentOf(output), { part: options.compact ? part : 'all', omitUseHint: !!options.compact });
    const outputFields = (output, index, part) => edit ? controls(output, index, part) : readContent(output, part);
    const resultBody = plan.draft.outputs.map((output, index) => `<section class="ca-detail-group"><h4>${index + 1}. ${esc(output.title)}</h4>${candidate.organizationReceipt ? `<p class="note">${esc(T(candidate.organizationReceipt.undoneAt ? 'cognition.activity_archived_version' : 'cognition.detail_saved_version', candidate.organizationReceipt.undoneAt ? '归档 v{n}' : '已保存 v{n}', { n: candidate.organizationReceipt.assets[index].version }))}</p>` : ''}${outputFields(output, index, 'body')}
      ${candidate.organizationReceipt ? btn(T('cognition.organization_open_result', '查看结果'), 'open-asset', { id: plan.resultIds[index] }) : ''}</section>`).join('');
    const boundaryBody = options.compact ? plan.draft.outputs.map((output, index) => `<section class="ca-detail-group"><h4>${index + 1}. ${esc(output.title)}</h4>${outputFields(output, index, 'boundary')}</section>`).join('') : '';
    const originals = plan.sources.map(source => `<article class="ca-detail-group"><h4>${esc(source.content.title)} · v${esc(source.content.activeVersion || source.content.version)}</h4>${NS.ui.cognitionContentFields(source.content)}</article>`).join('');
    const sourceAlerts = [];
    const sources = plan.draft.outputs.map((output,index) => {
      const parts = NS.ui.cognitionSourceParts(plan.sources.filter(source => output.sourceAssetIds.includes(source.head.id)).flatMap(source => source.content.evidenceRefs || []), 'candidate:' + candidate.id, !!options.compact);
      sourceAlerts.push(parts.alerts);
      return `<article class="ca-detail-group"><h4>${index + 1}. ${esc(output.title)}</h4>${output.excerpts.map(part => `<div class="ca-review-source"><p class="note">${esc(plan.sources.find(source => source.head.id === part.assetId)?.content.title || part.assetId)}</p><blockquote>${esc(part.quote)}</blockquote></div>`).join('')}${options.compact ? parts.content : parts.rows}</article>`;
    }).join('');
    const impact = plan.ontologyChanges.length ? plan.ontologyChanges.map(change => `<article class="ca-detail-group"><h4>${esc(change.after.name || change.after.id)}</h4><p>${esc(T(change.after.status === 'archived' ? 'cognition.organization_ontology_archive' : change.before ? 'cognition.organization_ontology_relink' : 'cognition.organization_ontology_create', change.after.status === 'archived' ? '原共享规则归档，历史保留' : change.before ? '保留身份与有效时间，当前来源续接到新认知' : '为新认知建立共享规则'))}</p><p class="content-text">${esc(change.after.requirement || change.after.description || change.after.object?.value || '')}</p></article>`).join('') : `<p>${esc(T('cognition.organization_no_ontology', '无本体变化'))}</p>`;
    const actions = options.compact && edit ? btn(T('cognition.activity_keep_edits', '保留修改'), 'activity-save-draft', { id: candidate.id, primary: true }) + btn(T('common.cancel', '取消'), 'activity-edit-cancel', { id: candidate.id })
      : (canEdit ? btn(T('cognition.organization_confirm', '确认整组整理'), 'cand-adopt-with-form', { id: candidate.id, primary: true, disabled: !candidate.capabilities?.canPromote }) + (options.compact ? btn(T('cognition.activity_edit_plan', '修改方案'), 'activity-edit', { id: candidate.id }) : btn(T('cognition.activity_save_validate', '保存修改并校验'), 'activity-save-draft', { id: candidate.id })) : '')
      + (candidate.capabilities?.canReject ? btn(T('cognition.activity_defer', '稍后处理'), 'activity-defer', { id: candidate.id }) + btn(T('cognition.inbox_action_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true }) : '')
      + (candidate.organizationReceipt && !candidate.organizationReceipt.undoneAt ? btn(T('cognition.organization_undo', '撤销本次整理'), 'activity-undo-organization', { id: candidate.id }) : '');
    const relatedHtml = plan.draft.outputs.map(outputOntology).join('');
    return `<section><h3>${esc(T('cognition.organization_results', '整理后的完整内容'))}</h3>${resultBody}</section>
      <section class="ca-review-changes"><h3>${esc(T('cognition.detail_changes', '本次变化'))}</h3><p class="content-text">${esc(plan.draft.reason)}</p><p class="note">${esc(T(candidate.organizationReceipt?.undoneAt ? 'cognition.organization_undone' : candidate.organizationReceipt ? 'cognition.organization_saved' : 'cognition.organization_archive_note', candidate.organizationReceipt?.undoneAt ? '本次整理已撤销' : candidate.organizationReceipt ? '整组内容已保存，原条目已归档。' : '确认后新建以上内容，原条目归档；原正文、版本和历史引用保留。'))}</p>${originals}</section>
      ${NS.ui.cognitionSourceSection(sources, { fold: false, alerts: options.compact ? '' : sourceAlerts.join('') })}
      ${boundaryBody}
      ${options.compact ? `<section class="ca-library-related"><h3>${esc(T('cognition.detail_related', '关联认知与本体'))}</h3>${relatedHtml}</section><section class="ca-review-formation"><h3>${esc(T('cognition.organization_ontology', '本体影响'))}</h3>${impact}</section>` : `${activityFold(T('cognition.detail_related', '关联认知与本体'), relatedHtml)}${activityFold(T('cognition.organization_ontology', '本体影响'), impact)}`}
      ${activityHistory(candidate)}
      ${options.compact ? sourceAlerts.join('') : ''}
      <div class="actions actions-right" data-activity-primary-actions>${candidate.organizationReceipt ? '' : actions}${candidate.organizationReceipt && !candidate.organizationReceipt.undoneAt ? btn(T('cognition.organization_undo', '撤销本次整理'), 'activity-undo-organization', { id: candidate.id }) : ''}</div>`;
  }

  function readOrganizationOutputs(candidate, card) {
    const outputs = structuredClone(candidate.contentOrganization.draft.outputs);
    card?.querySelectorAll('[data-org-field]').forEach(control => {
      const key = control.dataset.orgField, output = outputs[Number(control.dataset.orgIndex)];
      const value = String(control.value);
      if (['applicableWhen', 'forbiddenWhen'].includes(key)) {
        const lines = value.split(/\r?\n/).filter(Boolean);
        if (lines.length || output[key] !== undefined) output[key] = lines;
      } else if (key === 'value' && !value) delete output[key];
      else output[key] = value;
    });
    return outputs;
  }
  function candidateFormBody(candidate, options = {}) {
    if (candidate.contentOrganization) return organizationForm(candidate, options);

    const ontologyOnly = candidate.proposalTarget === 'ontology';
    const ontologyEditing = options.editing && candidate.capabilities?.canEdit && !candidate.capabilities?.isTerminal
      && !['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(candidate.status);
    if (ontologyOnly && options.compact && !ontologyEditing) {
      const terminal = !!candidate.capabilities?.isTerminal || ['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(candidate.status);
      const caps = candidate.capabilities || {};
      const plan = candidate.ontologyFormation;
      const ready = plan?.schemaVersion === 1 && plan.previewChanges?.length && plan.previewChanges.every(change => change.after);
      const running = S.formationRechecks?.[candidate.id]?.running;
      const confirm = !terminal && caps.canPromote && ready && !running && !plan.blockedReasons?.length;
      const sections = ontologyFormationHtml(candidate, terminal, { standalone: true, activity: true });
      return `${sections?.content || `<p role="alert">${esc(T('cognition.ontology_preview_missing', '未读到拟保存内容，不能确认。请刷新后核对。'))}</p>`}
        ${sections?.changes || ''}
        ${activitySources(candidate, { before: sections?.basis || '' })}
        ${sections?.alerts || ''}
        ${sections?.details || ''}
        ${candidate.uncertainty ? activityFold(T('cognition.activity_uncertainty_label', '不确定性说明'), `<p>${esc(candidate.uncertainty)}</p>`) : ''}
        ${activityHistory(candidate)}
        ${terminal ? '' : `<p class="note">${esc(T('cognition.ontology_review_impact', '确认后保存所列本体变化并保留历史版本，不新建“我的认知”条目。'))}</p>`}
        ${terminal ? '' : `<div class="actions actions-right" data-activity-primary-actions>
          ${caps.canPromote || caps.canEdit ? btn(T('cognition.activity_history_accept', '确认保存'), 'cand-adopt-with-form', { id: candidate.id, primary: true, disabled: !confirm }) : ''}
          ${caps.canEdit ? btn(T('cognition.ontology_edit_request', '修改要求'), 'activity-edit', { id: candidate.id, disabled: !!running }) : ''}
          ${caps.canReject ? btn(T('cognition.activity_defer', '稍后处理'), 'activity-defer', { id: candidate.id, disabled: !!running }) + btn(T('cognition.inbox_action_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true, disabled: !!running }) : ''}
        </div>`}`;
    }
    const refs = evidenceRefs(candidate);
    const broken = evidenceMostlyUnavailable(candidate);
    // 能力只认主进程下发的 capability；缺失时视为只读，不推断可编辑或可处置。
    const terminal = !!candidate.capabilities?.isTerminal || ['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(String(candidate.status || ''));
    const caps = terminal ? Object.assign({}, candidate.capabilities, { canEdit: false, canPromote: false, canReject: false, canContinueOntology: false }) : candidate.capabilities || {};
    const rechecking = S.formationRechecks?.[candidate.id]?.running === true;
    const canEdit = !!caps.canEdit && !rechecking;
    const mutating = !ontologyOnly && ['update', 'limit_scope'].includes(candidate.suggestedAction);
    const target = (S.assets || []).find(item => item.id === candidate.targetAssetId);
    const baseline = mutating ? NS.ui.versionContent(candidate.targetAssetId, candidate.targetVersionUsed || target?.activeVersion || target?.version) : null;
    const stockChanges = candidate.stockOrganizationProvenance && baseline ? [
      [T('cognition.asset_version_diff_title_field', '标题'), baseline.title, candidate.summary],
      [T('cognition.asset_version_diff_statement', '正文'), baseline.statement, candidate.judgment],
      [T('cognition.detail_future_use', '用途'), baseline.value, candidate.value],
      [T('cognition.detail_conditions', '适用条件'), baseline.applicableWhen, candidate.applicableWhen ?? baseline.applicableWhen],
      [T('cognition.detail_exceptions', '禁止与例外'), baseline.forbiddenWhen, candidate.forbiddenWhen ?? baseline.forbiddenWhen],
    ].filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after)).map(([label, before, after]) => {
      const text = value => Array.isArray(value) ? value.join('；') : String(value || T('cognition.activity_not_recorded', '未记录'));
      return options.compact ? `<dl class="ca-approval-fact"><dt>${esc(label)}</dt><dd class="content-text">${esc(text(before))}</dd></dl>` : `<div class="field"><h4>${esc(label)}</h4><div><strong>${esc(T('cognition.formation_before', '修改前'))}</strong>${foldValue(text(before))}</div><div><strong>${esc(T('cognition.formation_after', '拟保存内容'))}</strong>${foldValue(text(after))}</div></div>`;
    }).join('') : '';
    const savedDecision = candidate.status === 'confirmed' && !ontologyOnly ? NS.ui.savedDecisionContent('candidate', candidate) : null;
    const awaitingSaved = candidate.status === 'confirmed' && !ontologyOnly && !savedDecision;
    const display = savedDecision?.content || { ...baseline, ...candidate, statement: candidate.judgment, scope: candidate.suggestedScope,
      applicableWhen: candidate.applicableWhen ?? baseline?.applicableWhen, forbiddenWhen: candidate.forbiddenWhen ?? baseline?.forbiddenWhen,
      evidenceRefs: [...(baseline?.evidenceRefs || []), ...refs] };
    const canPromote = (!options.compact || !mutating || !!baseline) && !!caps.canPromote && !rechecking && !(candidate.ontologyFormation?.blockedReasons || []).length;
    const canReject = !!caps.canReject && !rechecking;
    const edit = canEdit && (!options.compact || !!options.editing);
    const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    // 更新候选的差异确认卡：旧版全文对照 + 版本核对
    // 提示——任务所用版与当前在用版不一致时，确认前先核对改进对象。
    // 原「当前版本」差异区扩为**依据链**区块
    // （原方法与版本 / 同次任务 / 预期→实际 / 采用证据 / 为什么改 / 适用范围 /
    // 改动点，见 improvementChainBlock）。更新型候选的预期→实际由依据链呈现，
    // 不再叠加一份「复盘依据」，避免同屏两处同内容。
    const comparison = candidate.formationComparison;
    const relatedAssets = Array.isArray(comparison?.relatedAssets) ? comparison.relatedAssets : [];
    const relatedHtml = relatedAssets.length > 1 ? `<div class="ca-review-notice"><strong>${esc(T('cognition.formation_related_title', '这条建议涉及多条已有内容'))}</strong><p>${esc(T('cognition.formation_related_hint', '请先核对各条内容及版本；合并由你决定。'))}</p><ul>${relatedAssets.map((related, index) => {
      const asset = !S.assetsError && (S.assets || []).find(item => String(item.id) === String(related.assetId) && item.status === 'active');
      const label = asset?.title || T('cognition.formation_related_item', '关联内容 {n}', { n: String(index + 1) });
      const version = T('cognition.formation_related_version', '判断时使用 v{version}', { version: String(related.version || '') });
      return `<li>${esc(label)} · ${esc(version)}${asset ? ` ${btn(T('cognition.formation_related_open', '去认知详情核对'), 'open-asset', { id: asset.id, small: true })}` : ` · ${esc(T('cognition.formation_related_unavailable', '当前无法核对'))}`}</li>`;
    }).join('')}</ul></div>` : '';
    const comparisonHtml = comparison ? `<p class="note"><strong>${esc(T('cognition.formation_comparison', '与已有内容比较'))}</strong>：${esc(comparison.reason)}${comparison.targetVersion ? ` · v${esc(comparison.targetVersion)}` : ''}</p>
      ${comparison.targetQuote ? `<p class="content-text">${esc(comparison.targetQuote)}</p>` : ''}
      ${comparison.coverage?.truncated || comparison.coverage?.unavailable ? `<p class="note">${esc(T('cognition.formation_comparison_partial', '比较覆盖尚不完整，不能据此自动新增或覆盖。'))}</p>` : ''}${relatedHtml}` : '';
    const chainHtml = improvementChainBlock(candidate);
    // 确认时撞版本冲突的处置块：就地说明"没生效"、按当前在用版
    // 重摆差异、给「按当前版本重新确认」。它只描述这一次确认的事实，不改变候选的
    // 待处理性质（候选仍可稍后处理/拒绝）。
    const conflictHtml = candidateVersionConflictBlock(candidate, canPromote);
    const legacyEvidenceHtml = !candidate.stockOrganizationProvenance && candidate.evidenceSummary
      ? `<div class="note ca-candidate-legacy-evidence"><strong>${esc(T('cognition.candidate_legacy_evidence_summary', '旧版证据说明（已保留）'))}</strong><p class="content-text">${esc(candidate.evidenceSummary)}</p></div>`
      : '';
    const evidenceHtml = `${legacyEvidenceHtml}${refs.length
      ? evidenceGroupsHtml(refs)
      : `<span class="note">${esc(candidate.stockOrganizationProvenance ? T('cognition.stock_source_unrecorded', '原始来源未记录；本次整理依据保存的内容，不补充无依据的用途或边界。') : candidate.origin === 'manual'
        ? T('cognition.candidate_manual_evidence_note', '这条内容由你直接输入，可以确认保存；没有外部引用，保存不代表效果已验证。')
        : T('cognition.candidate_no_evidence', '没有可追溯的证据引用；确认前建议先补证。'))}</span>`}`;
    // 决策动作按 capability 收敛；终态候选和缺少 capabilities 的候选均只读。
    // 按钮名按型分支：更新型「保存更新」，新建型「保存」。
    const decisionLabels = candidateDecisionLabels(candidate);
    const promoteLabel = ontologyOnly ? decisionLabels.promote : options.compact && candidate.suggestedAction === 'pause' ? T('cognition.activity_confirm_pause', '确认暂停') : options.compact && candidate.suggestedAction === 'limit_scope' ? T('cognition.activity_save_boundary', '保存边界') : options.compact && !['update', 'limit_scope', 'pause'].includes(String(candidate.suggestedAction || 'create')) ? T(edit ? 'cognition.activity_formal_save' : 'cognition.activity_history_accept', edit ? '修改并保存' : '确认保存') : decisionLabels.promote;
    const extraActions = (canReject && (!options.compact || attentionReady(candidate)) ? btn(T('cognition.activity_defer', '稍后处理'), 'activity-defer', { id: candidate.id, className: 'o' }) : '') + (options.compact ? btn(T('cognition.activity_next_item', '下一项'), 'activity-next', { className: 'o' }) : '');
    const actionsHtml = options.compact ? `<div class="actions actions-right" data-activity-primary-actions>${edit
      ? btn(T('cognition.activity_keep_edits', '保留修改'), 'activity-save-draft', { id: candidate.id, primary: true }) + btn(T('common.cancel', '取消'), 'activity-edit-cancel', { id: candidate.id })
      : (canPromote || canEdit ? btn(promoteLabel, 'cand-adopt-with-form', { id: candidate.id, primary: true, disabled: !canPromote }) : '')
        + (canEdit ? btn(T('cognition.activity_edit_content', '修改内容'), 'activity-edit', { id: candidate.id }) : '')
        + (canReject ? btn(T('cognition.activity_defer', '稍后处理'), 'activity-defer', { id: candidate.id }) + btn(T('cognition.inbox_action_reject', '拒绝'), 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true }) : '')}</div>` : `<div class="actions actions-right"${options.compact ? ' data-activity-primary-actions' : ''}>
        ${canPromote || (options.compact && canEdit) ? btn(promoteLabel, 'cand-adopt-with-form', { id: candidate.id, primary: true, disabled: !canPromote }) : ''}
        ${canEdit ? btn(T('cognition.activity_save_validate', '保存修改并校验'), 'activity-save-draft', { id: candidate.id, className: 'o' }) : ''}
        ${canReject ? btn(options.compact ? T('cognition.inbox_action_reject', '拒绝') : decisionLabels.reject, 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true }) : ''}
        ${extraActions}
      </div>`;

    if (options.compact) {
      const scope = String(candidate.suggestedScope || '');
      const taskLabel = edit ? T('cognition.activity_task_label', '任务范围 *') : T('cognition.activity_task_label', '任务范围 *').replace(/\s*\*$/, '');
      const blockReasons = canPromote ? [] : (caps.ineligibleReasons || [])
        .map(reason => NS.promotionBlockText ? NS.promotionBlockText(reason) : '').filter(Boolean);
      const advisory = candidateAdvisoryHtml(candidate);
      const read = (label, value) => `<div class="field"><span>${esc(label)}</span><div class="content-text">${esc(value || T('cognition.activity_not_recorded', '未记录'))}</div></div>`;
      const input = (key, label, value, rows) => window.uiField({
        id: `ca-cand-${key}-${candidate.id}`, label, showRequirement: false,
        required: key === 'judgment', control: { kind: rows ? 'textarea' : 'input', value: value || '',
          attrs: { ...(rows ? { rows } : {}), 'data-f': key, maxlength: key === 'judgment' ? 4000 : key === 'uncertainty' ? 1000 : rows ? 4000 : 80 } },
      });
      const saved = S.activityDraftValidation?.[candidate.id];
      const formation = !ontologyOnly && candidate.ontologyFormation ? ontologyFormationHtml(candidate, terminal, { activity: true }) : null;
      if (ontologyOnly) return `<section class="ca-review-content">
        <p class="note">${esc(T('cognition.ontology_edit_request_hint', '说明你希望怎样调整这条建议。保存要求后，需要生成并核对新结果；这里的文字不会作为本体正文保存。'))}</p>
        ${input('summary', T('cognition.ontology_proposal_name', '变更名称'), candidate.summary)}
        ${input('judgment', T('cognition.ontology_edit_request', '修改要求'), candidate.judgment, 6)}
        </section><div class="actions actions-right" data-activity-primary-actions>
          ${btn(T('cognition.ontology_save_request', '保存要求'), 'activity-save-draft', { id: candidate.id, primary: true })}
          ${btn(T('common.cancel', '取消'), 'activity-edit-cancel', { id: candidate.id })}
        </div>`;
      const contentControls = edit ? {
        statement: window.uiTextarea({ id: `ca-cand-body-${candidate.id}`, value: candidate.judgment || '', ariaLabel: T('cognition.asset_content_section', '内容'), attrs: { 'data-f': 'judgment', rows: 5, maxlength: 4000 } }),
        value: window.uiTextarea({ id: `ca-cand-use-${candidate.id}`, value: candidate.value || '', ariaLabel: T('cognition.detail_future_use', '用途'), attrs: { 'data-f': 'value', rows: 3, maxlength: 4000 } }),
        scope: window.uiInput({ id: `ca-cand-scope-${candidate.id}`, value: candidateTaskChoices(scope).find(item => item.value === scope)?.label || scope, ariaLabel: taskLabel, required: true, attrs: { 'data-f': 'scope', maxlength: 160, ...(candidate.stockOrganizationProvenance ? { 'data-saved-scope': scope, readonly: true } : {}) } }),
        applicableWhen: window.uiTextarea({ id: `ca-cand-applicable-${candidate.id}`, value: (display.applicableWhen || []).join('\n'), ariaLabel: T('cognition.detail_conditions', '适用条件'), attrs: { 'data-f': 'applicable', rows: 2 } }),
        forbiddenWhen: window.uiTextarea({ id: `ca-cand-forbidden-${candidate.id}`, value: (display.forbiddenWhen || []).join('\n'), ariaLabel: T('cognition.detail_exceptions', '禁止与例外'), attrs: { 'data-f': 'forbidden', rows: 2 } }),
      } : {};
      const sources = activitySources(candidate, {
        deferAlerts: true,
        ...(awaitingSaved ? { refs: [], empty: '' } : display.evidenceRefs?.length ? { refs: display.evidenceRefs } : {}),
        stateKey: savedDecision ? 'asset:' + savedDecision.assetId : 'candidate:' + candidate.id,
        before: `${formation?.basis || ''}${candidate.stockOrganizationProvenance ? `<p class="content-text">${esc(candidate.evidenceSummary || '')}</p><p class="note">${esc(candidate.stockOrganizationProvenance.activeVersion ? T('cognition.stock_baseline', '依据：已保存的在用版本 v{version}。', { version: candidate.stockOrganizationProvenance.activeVersion }) : T('cognition.stock_ontology_baseline', '依据：保存的本体定义、规则或事实版本。'))}</p>` : ''}`,
        alerts: broken ? `<div class="ca-review-notice"><strong>${esc(T('cognition.candidate_evidence_weak', '来源待核对'))}</strong><p>${esc(T('cognition.detail_sources_warning_hint', '请先查看仍可打开的来源，确认内容可靠后再保存。'))}</p></div>` : '',
        after: legacyEvidenceHtml + kstarEpisodeSection(S.route),
      });
      const riskNote = candidate && ['medium', 'high'].includes(candidate.risk) ? `<div class="ca-review-notice" role="status"><strong>${esc(candidate.risk === 'high' ? T('cognition.activity_risk_high', '高风险候选') : T('cognition.activity_risk_medium', '需谨慎核对'))}</strong></div>` : '';
      const nearActions = `${formation?.alerts || ''}${conflictHtml}${sources.alerts || ''}${riskNote}${mutating && !baseline && !terminal ? `<p role="status">${esc(T('cognition.detail_baseline_unavailable', '原版本内容不可用，请读取版本记录后核对。'))}</p>${btn(T('common.retry', '重试'), 'asset-versions-retry', { id: candidate.targetAssetId })}` : ''}${!terminal && blockReasons.length ? `<div class="ca-review-notice" role="status"><strong>${esc(T('cognition.detail_block_title', '保存前还需要处理'))}</strong><p>${esc(blockReasons.join('；'))}</p></div>` : ''}${terminal ? candidateAdvisoryHtml(candidate, { inline: true }) : advisory}${saved ? `<div class="ca-review-notice${canPromote ? ' is-valid' : ''}" role="status" data-draft-validation>${esc(canPromote ? T('cognition.activity_draft_valid', '草稿已保存，当前校验允许正式保存；确认时仍会再次校验。') : T('cognition.activity_draft_invalid', '草稿已保存，仍有阻断项需要处理；尚未保存为正式资产。'))}</div>` : ''}`;
      return `
        ${candidate.activityDeferredAt ? `<p class="note">${esc(T('cognition.activity_deferred_hint', '已标记稍后处理，仍保留在需要关注中。'))}</p>` : ''}
        ${edit ? input('summary', ontologyOnly ? T('cognition.ontology_proposal_name', '变更名称') : T('cognition.capture.name', '认知名称'), candidate.summary) : ''}
        ${!ontologyOnly && edit ? window.uiField({ id: `ca-cand-category-${candidate.id}`, label: T('cognition.content_category', '分类'), showRequirement: false, control: { kind: 'select', native: true, value: NS.ui.contentCategoryOf(candidate), options: NS.ui.CONTENT_CATEGORIES.map(([value, key, fallback]) => ({ value, label: T(key, fallback) })), attrs: { 'data-f': 'contentCategory' } } }) : ''}
        ${awaitingSaved ? `<p role="status">${esc(T('cognition.detail_saved_unavailable', '保存版本尚未读到，请读取版本记录后核对。'))}</p>${btn(T('common.retry', '重试'), 'asset-versions-retry', { id: candidate.promotedAssetId })}` : NS.ui.cognitionContentFields(display, { ontologyOnly, omitUseHint: true, part: 'body', controls: contentControls })}
        ${formation?.content || ''}${comparisonHtml || stockChanges ? `<section class="ca-review-changes"><h3>${esc(T('cognition.detail_changes', '本次变化'))}</h3>${comparisonHtml}${stockChanges ? `<h4>${esc(T('cognition.formation_before', '修改前'))}</h4>${stockChanges}` : ''}</section>` : ''}${formation?.changes || ''}${statementWarningHtml(candidate)}
        ${sources.html}
        ${awaitingSaved ? '' : NS.ui.cognitionContentFields(display, { ontologyOnly, omitUseHint: true, part: 'boundary', controls: contentControls })}
        ${formation?.details || ''}${!awaitingSaved ? (NS.ui.cognitionRelated(display) || '') : ''}
        ${candidate.uncertainty || edit ? activityFold(T('cognition.activity_uncertainty_label', '不确定性说明'), edit ? input('uncertainty', T('cognition.activity_uncertainty_label', '不确定性说明'), candidate.uncertainty, 2) : `<p>${esc(candidate.uncertainty || T('cognition.activity_not_recorded', '未记录'))}</p>`) : ''}
        ${terminal ? '' : `<details class="details ca-review-impact"><summary>${esc(T('cognition.activity_impact_title', '保存的影响'))}</summary><p class="note">${esc(activityImpact(candidate))}</p>${formation ? `<p class="note">${esc(T('cognition.formation_atomic_compact', '认知和相互依赖的本体变化作为一次决定共同保存，并在保存前重新核对版本；不会只保存其中一半。'))}</p>` : ''}${candidate.scopePolicy && Object.keys(candidate.scopePolicy).length ? `<details class="details ca-review-permissions"><summary>${esc(T('cognition.detail_permissions', '查看使用权限'))}</summary>${candidateScopeField(candidate, { includeTaskConditions: false })}</details>` : ''}</details>`}
        ${activityFold(T('cognition.activity_target_label', '目标 / 版本'), read(T('cognition.activity_target_label', '目标 / 版本'), activityTarget(candidate)))}
        ${activityHistory(candidate, chainHtml || reviewSignalBlock(candidate))}
        ${candidate.autoReview?.eligible === false && candidate.autoReview.reasons?.length ? `<div class="ca-review-notice"><strong>${esc(T('cognition.activity_manual_review', '保留人工确认'))}</strong><p>${esc(candidate.autoReview.reasons.map(autoReviewReasonText).join('；'))}</p></div>` : ''}
        ${nearActions}
        ${terminal ? '' : actionsHtml}`;
    }

    return `
      ${candidate.activityDeferredAt ? `<div class="note">${esc(T('cognition.activity_deferred_hint', '已标记稍后处理，仍保留在需要关注中。'))}</div>` : ''}
      ${candidate.autoReview && candidate.autoReview.eligible === false && Array.isArray(candidate.autoReview.reasons) && candidate.autoReview.reasons.length ? `<div class="note ca-auto-review"><strong>${esc(T('cognition.activity_manual_review', '保留人工确认'))}</strong><p>${esc(candidate.autoReview.reasons.map(autoReviewReasonText).join('；'))}</p></div>` : ''}
      ${broken ? `<div class="warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源暂时无法核对。原会话可能仍然存在；请查看可打开的来源，补充依据或选择不保存。'))}</div>` : ''}
      ${candidate.mergedIntoAssetId ? `<div class="note">${esc(T('cognition.candidate_merged_into', '这条与已有资产相似：确认后会并入那条资产（融合出新版本），不会另开一条。'))}</div>` : ''}
      ${chainHtml ? '' : reviewSignalBlock(candidate)}
      ${comparisonHtml}
      ${chainHtml}
      ${ontologyFormationHtml(candidate, terminal)}
      ${options.compact && edit ? '' : candidateScopeField(candidate, { includeTaskConditions: !chainHtml })}
      ${conflictHtml}
      ${edit ? `
        ${options.compact ? field(ontologyOnly ? T('cognition.ontology_proposal_name', '变更名称') : T('cognition.capture.name', '认知名称'), window.uiInput({ id: `ca-cand-summary-${esc(candidate.id)}`, value: candidate.summary || '', attrs: { maxlength: 60, 'data-f': 'summary' } })) : ''}
        ${field(ontologyOnly ? T('cognition.ontology_proposal_description', '完整变更说明') : T('cognition.capture.summary', '可复用内容'), window.uiTextarea({ id: `ca-cand-judgment-${esc(candidate.id)}`, value: candidate.judgment || '', attrs: { 'data-f': 'judgment' } }))}
        ${ontologyOnly ? '' : field(T('cognition.content_category', '分类'), contentCategorySelect(`ca-cand-category-${candidate.id}`, candidate))}
        ${statementWarningHtml(candidate)}
        ${options.compact || chainHtml ? '' : field(T('cognition.detail_future_use', '用途'), window.uiTextarea({ id: `ca-cand-value-${esc(candidate.id)}`, value: candidate.value || '', attrs: { 'data-f': 'value' } }))}
        <details class="details">
          <summary>${esc(T('cognition.candidate_advanced', '高级选项（通常不用改）'))}</summary>
          ${options.compact ? '' : field(T('cognition.candidate_scope_domain', '适用任务范围'), window.uiInput({ id: `ca-cand-scope-${esc(candidate.id)}`, value: candidate.suggestedScope || '', placeholder: T('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'), attrs: { 'data-f': 'scope' } }))}
          <div class="note">${esc(T('cognition.candidate_scope_hint', '常用范围：跨对话通用（general）、个人偏好与身份（personal）、报告（report）、编程（code）、审查（review）、产品（product）。其他写法可能匹配不上任务，建议从这里选一个。'))}</div>
          ${options.compact ? '' : field(ontologyOnly ? T('cognition.ontology_proposal_name', '变更名称') : T('cognition.capture.name', '认知名称'), window.uiInput({ id: `ca-cand-summary-${esc(candidate.id)}`, value: candidate.summary || '', attrs: { maxlength: 60, 'data-f': 'summary' } }))}
          ${options.compact && (candidate.suggestedType === 'rule' || candidate.applicableWhen?.length || candidate.forbiddenWhen?.length) ? `${field(T('cognition.asset_version_applicable', '适用场景'), window.uiTextarea({ id: `ca-cand-applicable-${esc(candidate.id)}`, value: (display.applicableWhen || []).join('\n'), attrs: { 'data-f': 'applicable' } }))}${field(T('cognition.asset_version_forbidden', '禁用场景'), window.uiTextarea({ id: `ca-cand-forbidden-${esc(candidate.id)}`, value: (display.forbiddenWhen || []).join('\n'), attrs: { 'data-f': 'forbidden' } }))}` : ''}
          ${options.compact && !chainHtml ? field(T('cognition.detail_future_use', '用途'), window.uiTextarea({ id: `ca-cand-value-${esc(candidate.id)}`, value: candidate.value || '', attrs: { 'data-f': 'value' } })) : ''}
          ${chainHtml ? '' : field(T('cognition.chain_uncertainty_label', '仍不确定的地方'), window.uiTextarea({ id: `ca-cand-uncertainty-${esc(candidate.id)}`, value: candidate.uncertainty || '', attrs: { 'data-f': 'uncertainty' } }))}
        </details>
        <div class="ca-detail-foot">
          ${field(T('cognition.evidence_refs', '证据引用'), evidenceHtml)}
          ${kstarEpisodeSection(S.route)}
          ${(() => {
            /* 「保存」被能力门控关掉时必须说明原因——否则用户面前只有
               稍后/拒绝两个出口，不知道为什么不能确认。 */
            const capsAll = candidate.capabilities || {};
            const reasons = Array.isArray(capsAll.ineligibleReasons) ? capsAll.ineligibleReasons : [];
            if (canPromote || !reasons.length) return '';
            const lines = reasons.map((r) => NS.promotionBlockText ? NS.promotionBlockText(r) : '').filter(Boolean);
            if (!lines.length) return '';
            return `<div class="note cand-block-note">${esc(T('cognition.candidate_error_promotion_blocked', '这条候选还不够格成为正式资产：'))}${lines.map((line) => `<br>· ${esc(line)}`).join('')}<br>${esc(T('cognition.candidate_block_hint', '修改内容使其合格后，「保存」会自动出现。'))}</div>`;
          })()}
          ${candidateAdvisoryHtml(candidate)}
          ${actionsHtml}
        </div>
      ` : `
        <p class="note">${esc(T('cognition.content_category', '分类'))} · ${esc(contentCategoryLabel(candidate))}</p>
        <p class="content-text">${esc(candidate.judgment || '')}</p>
        ${refs.length ? evidenceGroupsHtml(refs) : ''}
        ${kstarEpisodeSection(S.route)}
        ${candidateAdvisoryHtml(candidate, { inline: true })}
        ${actionsHtml}
      `}`;
  }

  function candidateDisplayState(candidate) {
    const reported = String((candidate.capabilities || {}).displayState || '');
    if (reported) return reported;
    return ({
      observed: 'needs_review',
      weak_observation: 'weak_evidence',
      pending_review: 'needs_review',
      deferred: 'deferred',
      confirmed: 'confirmed',
      integrated: 'integrated',
      rejected: 'rejected',
      ignored: 'ignored',
      expired: 'expired',
      failed: 'failed',
      superseded: 'superseded',
    })[String(candidate.status || '')] || 'unknown';
  }

  function candidateStatusPresentation(candidate) {
    const state = candidateDisplayState(candidate);
    if (candidate.organizationReceipt?.undoneAt) return { state, label: T('cognition.organization_undone', '本次整理已撤销'), tone: 'gray' };
    if (candidate.automaticUndo) return { state, label: T('cognition.automatic_undo_done', '已撤销自动保存'), tone: 'gray' };
    const copy = {
      needs_review: ['cognition.candidate_status_pending', '待确认', 'amber'],
      weak_evidence: ['cognition.candidate_status_weak_evidence', '证据不足', 'amber'],
      deferred: ['cognition.candidate_system_hold', '系统保留（语义复核有发现）', 'amber'],
      ontology_in_progress: ['cognition.candidate_ontology_in_progress', '正在整理到本体', 'amber'],
      confirmed: ['cognition.candidate_status_promoted', '已保存', 'green'],
      integrated: ['cognition.candidate_status_integrated', '已整理到本体', 'green'],
      rejected: ['cognition.candidate_status_rejected', '未保存', 'gray'],
      ignored: ['cognition.candidate_status_ignored', '已忽略', 'gray'],
      expired: ['cognition.candidate_status_expired', '已失效', 'gray'],
      superseded: ['cognition.candidate_status_expired', '已失效', 'gray'],
      failed: candidateSaveUncertain(candidate) && attentionReady(candidate)
        ? ['cognition.activity_result_unlocated', '保存结果待核对', 'amber']
        : ['cognition.candidate_status_failed', '处理失败', 'amber'],
      unknown: ['cognition.candidate_status_other', '状态待核对', 'gray'],
    }[state] || ['cognition.candidate_status_other', '状态待核对', 'gray'];
    return { state, label: T(copy[0], copy[1]), tone: copy[2] };
  }

  function candidateFormCard(candidate, options = {}) {
    if (candidate.contentPurgedAt) return `<section class="ca-candidate-detail"><p role="status">${esc(T('cognition.content_purged_note', '关联资产的内容已清除。此记录保留处理状态，不能编辑、确认或恢复内容。'))}</p></section>`;
    const broken = evidenceMostlyUnavailable(candidate);
    const status = candidateStatusPresentation(candidate);
    const isTerminal = Boolean((candidate.capabilities || {}).isTerminal)
      || ['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(status.state);
    const stateHint = candidate.organizationReceipt ? '' : candidate.automaticUndo ? T('cognition.automatic_undo_done_hint', '本次自动保存已撤销，原决定和版本历史继续保留。') : status.state === 'confirmed' && !candidate.promotedAssetId
      ? T('cognition.activity_result_unlocated_hint', '记录已标为保存，但没有提供可定位的资产结果；请刷新核对，暂不重复确认。')
      : status.state === 'confirmed'
      ? T('cognition.candidate_detail_saved_hint', '已保存为正式资产。后续修改或暂停，请到资产详情操作。')
      : status.state === 'ontology_in_progress'
        ? T('cognition.candidate_detail_integrated_hint', '已整理到本体，没有另存为普通认知资产。')
      : status.state === 'integrated'
        ? T('cognition.candidate_detail_integrated_hint', '已整理到本体，没有另存为普通认知资产。')
        : T('cognition.candidate_detail_terminal_hint', '这条建议已处理，不能再次确认；原记录保留供查看。');
    const nextStep = candidate.automaticUndo ? '' : status.state === 'integrated' && candidate.ontologyHandoff?.recordIds?.length
      ? btn(T('cognition.candidate_detail_open_ontology', '查看本体记录'), 'open-ontology', {
        small: true, className: 'o', data: { 'module-id': String(candidate.ontologyHandoff.moduleIds?.[0] || ''), 'record-id': String(candidate.ontologyHandoff.recordIds[0]) },
      })
      : status.state === 'confirmed' && candidate.promotedAssetId
        ? btn(T('cognition.candidate_detail_open_asset', '查看已保存资产'), 'go-inbox-asset', {
        small: true, className: 'o', data: { id: String(candidate.promotedAssetId) },
      })
      : status.state === 'ignored' && candidate.mergedInto
        ? btn(T('cognition.candidate_detail_open_merged_candidate', '查看合并后的建议'), 'open-candidate', {
          small: true, className: 'o', data: { id: String(candidate.mergedInto) },
        })
        : '';
    /* 标题=完整 summary（不再截 24 字）：这是这条建议的名称，
       截断后「看起来没有标题」；CSS 限 3 行。 */
    const fullTitle = String(candidate.summary || candidate.judgment || T('cognition.candidate_untitled', '未命名候选')).trim();
    return `
    <div class="card ca-candidate-detail" data-cand-id="${esc(candidate.id)}" data-cand-type="${esc(candidate.suggestedType || '')}">
      ${options.compact ? '' : `<div class="cand-head">
        ${chip(status.label, status.tone)}${!options.compact || ['medium', 'high'].includes(candidate.risk) ? candidateRiskBadge(candidate) : ''}${broken ? chip(T('cognition.candidate_evidence_weak', '来源待核对'), 'amber') : ''}
      </div>`}
      ${candidate.capabilities?.canUndoAutomatic ? btn(T('cognition.automatic_undo_preview', '查看撤销影响'), 'activity-undo-automatic', { id: candidate.id, small: true, className: 'o' }) : ''}
      ${options.compact ? '' : `<h2 class="cand-title">${esc(fullTitle)}</h2>`}
      ${!options.compact && isTerminal && stateHint ? `<div class="note ca-candidate-state-note">${esc(stateHint)}${nextStep ? `<div class="actions">${nextStep}</div>` : ''}</div>` : ''}
      ${options.compact && isTerminal && (stateHint || nextStep || options.processing) ? `<section class="ca-review-result"><h3>${esc(T('cognition.activity_result', '处理结果'))}</h3>${stateHint ? `<p class="note">${esc(stateHint)}</p>` : ''}${nextStep}${options.processing || ''}</section>` : ''}
      ${candidateFormBody(candidate, options)}
    </div>`;
  }

  function viewCandidate(route) {
    const candidate = S.candidates.find((c) => String(c.id) === String(route.candidateId));
    // 顶部「返回」按钮（原卡片底部的返回列表按钮已删，返回入口收在此处）。
    const backHtml = btn(`← ${T('common.back', '返回')}`, 'go-back', { className: 'backlink' });
    if (!candidate) {
      return `${backHtml}${hero(T('cognition.candidate_detail_title', '建议详情'), '')}${empty(T('cognition.candidate_detail_missing', '这条建议已不在待处理列表中'), '')}`;
    }
    return `${backHtml}
    ${hero(
      T('cognition.candidate_detail_title', '建议详情'),
      T('cognition.candidate_detail_hint', '查看这条建议的内容、来源和当前处理状态。'),
    )}
    ${candidateFormCard(candidate)}`;
  }

  // 候选族命名空间：views.js（整理结果区）与 review-views.js（待我处理页）
  // 经此引用搬出本文件的函数；纯内部零件不导出。
  NS.candidate = {
    pending: candidatePending,
    attentionReady,
    saveOutcomeUncertain: candidateSaveUncertain,
    title: candidateTitle,
    card: candidateCard,
    awaiting: candidateAwaiting,
    evidenceMostlyUnavailable,
    viewCandidate,
    formCard: candidateFormCard, readOrganizationOutputs,
    activityTarget, activityImpact, activityHistory,
    suggestedActionLabel,
    statusPresentation: candidateStatusPresentation,
    formationPreviewHtml: ontologyFormationHtml,
  };
})();
