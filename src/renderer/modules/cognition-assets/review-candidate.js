/* ============================================================================
 * 认知资产 · 候选族零件（cognition-assets/review-candidate.js）
 *
 * 2026-09-29 自 views.js 机械拆出（零行为变更）：候选判定 / 徽章 / 列表卡 /
 * 确认表单 / 依据链 / 版本冲突块 / 候选详情等候选族函数原样迁入。
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
    btn, roleBtn, chip, hero, empty, CATEGORIES, categoryLabel,
    isKstarEvidenceRef, evidenceChip, evidenceGroupsHtml, stripMarkdown,
    attributionLabel, sourceRefKind, resolveSourceRef, reviewOutcomeText,
    foldValue, kstarEpisodeSection,
  } = NS.ui;

  // 「对话中记」候选身份：captureKey `immediate-` 前缀（新）或引用 id 的
  // `immediate-` 前缀（存量）——两个信号源同前缀。
  function isImmediateCandidate(candidate) {
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
  /** 候选来源徽章（2026-09-16 KSTAR 融合）：三条产出线可辨——KSTAR 复盘
   *  （learningSignal/learningProvenance）、KSTAR 偏好（source=preference_scan，
   *  确定性扫描线）、会话整理（capture 线，无信号）。KSTAR 两条线的徽章
   *  文案必须带 "KSTAR" 前缀（子安口径：用户可辨，不接受裸"任务复盘"）。 */
  function candidateSourceBadge(candidate) {
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

  /** KSTAR 候选的复盘依据块（2026-09-16）：预期/实际/结果四行——知道"这条
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

  /* ────────────── 依据链（specs/015 US-701 AC1/AC2，2026-09-25）──────────────
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

    // ⑤ 为什么改：不确定的地方 + 带来的价值（候选既有字段）。
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

  /* ────────────── 确认更新撞版本冲突（specs/015 US-702 T022，2026-09-25）──────
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

  /** 待确认口径（2026-09-16 B1 统一）：需要用户判断且未被"稍后处理"静音。
   *  统计卡与全局 stats 共用这一份（单一事实源），杜绝 7/5/0 三数分叉；
   *  deferred 行仍在列表可见（子安口径：与待确认同形态），只是不占
   *  "等待确认"名额并带「已稍后处理」标注。 */
  const candidateAwaiting = (candidate) => candidatePending(candidate) && !(candidate.capabilities && candidate.capabilities.isSnoozed);
  /** 候选显示名（2026-09-16 修）：优先模型提炼的 summary 短标题——此前
   *  judgment 截断 60 字优先，卡片名成了"内容前缀"看不懂；无 summary 的
   *  存量候选用类别 + 判断前 12 字克制兜底，两者皆空给未命名。 */
  const candidateTitle = (candidate) => {
    const summary = String(candidate.summary || '').trim();
    if (summary) return summary.length > 24 ? `${summary.slice(0, 24)}…` : summary;
    const judgment = String(candidate.judgment || '').trim();
    if (judgment) {
      const label = categoryLabel(candidate.suggestedType);
      return `${label ? `${label} · ` : ''}${judgment.slice(0, 12)}${judgment.length > 12 ? '…' : ''}`;
    }
    return T('cognition.candidate_untitled', '未命名候选');
  };

  /* ── 决策三态与按钮名（specs/015 US-702 T023，2026-09-25）──────────────
   * 判据只有一个：**改的是已存在的那条方法**才说「确认更新」——即
   * `suggestedAction ∈ {update, limit_scope}` **且**带 `targetAssetId`。
   *  - 没有目标方法的候选（`create`，或 `update` 却缺 `targetAssetId`）一律按
   *    新建型渲染：对不存在的旧版说"更新"是假话；
   *  - `pause` 提案（主进程走 pauseAbilityAsset，没有版本比对面）也保持既有
   *    措辞：它既不是"更新成新版"，也没有可重锚的差异面；
   *  - 「稍后处理 / 拒绝」的**更新型**文案与 008 审批卡片共用同一批词条：
   *    产品口径是"两边三态与按钮名统一"（spec.md L40），共用键从源头杜绝
   *    两处各写一套后漂移。
   *  - 确认词根统一「保存」系（2026-09-28 词表统一）：新建型「保存」（原
   *    「保存并使用」，"并使用"的语义并入按钮下的一句说明）、更新型「保存更新」
   *    （原「确认更新」，与对话内审批卡同键同步改）。 */
  const candidateUpdateType = (candidate) => {
    const action = String((candidate || {}).suggestedAction || '');
    return (action === 'update' || action === 'limit_scope') && !!String((candidate || {}).targetAssetId || '');
  };
  const candidateDecisionLabels = (candidate) => (candidateUpdateType(candidate)
    ? {
      promote: T('recall.asset_approval.confirm', '保存更新'),
      defer: T('recall.asset_approval.defer', '稍后处理'),
      reject: T('recall.asset_approval.reject', '拒绝'),
    }
    : {
      promote: T('cognition.candidate_save_and_use', '保存'),
      defer: T('cognition.candidate_defer_action', '稍后处理'),
      reject: T('cognition.candidate_reject', '不保存'),
    });

  function candidateCard(candidate, broken) {
    const refs = evidenceRefs(candidate);
    // 同名兜底来源去重（2026-09-29 子安拍板的视觉整改③）：两条失效来源都
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
    // 2026-09-29 子安标注整改（第三轮定稿）：「来源已删」警示**与标题同一行**——
    // 标题在左，警示条靠右（chevron 之前），不再独立成行压在标题上面；
    // 行内放不下时省略号截断、悬浮 title 看全文。
    const warnHtml = broken
      ? `<span class="warn ca-card-warn-inline" title="${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}</span>`
      : '';
    /* 动作区（同轮标注）：「…其他处理」折叠开关撤下——保存/稍后处理/
     * 不保存/看内容与证据（稍后处理态另有「恢复」）**全部平铺、右侧、
     * 同一行**；不再藏二级折叠。候选确认闸与通道不变，纯呈现层收敛。 */
    /* 三件套（specs/018 T011）沿革：主按钮 primary 视觉保留；直接确认沿
     * 既有 cand-adopt-with-form 通道：卡片不在 .ca-candidate-detail 里，
     * readCandidateForm 就近找不到表单 → 按未携带编辑确认（内容原样保存）。
     * 卡片整体不再是点击区——标题行与「看内容与证据」进详情，避免行内按钮
     * 与卡片跳转抢点击（2026-09-26 旅程雕刻前的老问题，这次一并解掉）。 */
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
      // A3（2026-09-29）：「已稍后处理」的候选可就地恢复回待确认——
      // recall.candidates.resume 通道与 CANDIDATE_CHANNELS 映射早已就绪，
      // 此前缺的就是这个入口，静音候选只能一直躺在折叠区。
      caps.isSnoozed ? btn(T('cognition.candidate_resume', '恢复'), 'cand-decide', { id: candidate.id, data: { action: 'resume' }, small: true, className: 'o' }) : '',
      caps.canDefer ? btn(labels.defer, 'cand-decide', { id: candidate.id, data: { action: 'defer' }, small: true, className: 'o' }) : '',
      caps.canReject ? btn(labels.reject, 'cand-decide', { id: candidate.id, data: { action: 'reject' }, small: true, className: 'o' }) : '',
      // 「看内容与证据」按钮已删（2026-09-29 子安指令）：整卡即详情入口
      // （act 提到卡根，委托层 closest 最近匹配——点按钮命中按钮自身动作，
      // 不会误触跳转），按钮成了第四个重复入口。
    ].filter(Boolean);
    const actionsHtml = actionBtns.length
      ? `<div class="c5 ca-card-actions ca-card-actions-flat">${actionBtns.join('')}</div>`
      : '';
    return `
    <div class="cand${broken ? ' is-broken' : ''}" data-act="open-candidate" data-id="${esc(candidate.id)}" role="button" tabindex="0">
      <div class="c1">${esc(candidateTitle(candidate))}${warnHtml}<span class="chev" aria-hidden="true">›</span></div>
      <div class="c2">${chip(categoryLabel(candidate.suggestedType))}${candidateSourceBadge(candidate)}${candidateRiskBadge(candidate)}${(candidate.capabilities && candidate.capabilities.isSnoozed) ? chip(T('cognition.candidate_snoozed', '已稍后处理'), 'amber') : ''}${broken ? '' : chip(T('cognition.candidate_evidence_ok', '证据充足'), 'green')}</div>
      <div class="c3">${esc(String(candidate.judgment || candidate.value || '').slice(0, 800))}</div>
      ${(refsHtml || actionsHtml) ? `<div class="ca-card-footer">${refsHtml}${actionsHtml}</div>` : ''}
    </div>`;
  }

  /** 来源异常的判定与统计（与 stats.sourceIssues 同口径）：failed，或非用户
   *  主动暂停的 paused。2026-09-15 重构：来源健康不再有常态页，异常条目
   *  就地展开在「待我处理」，健康时完全沉默。 */
  function sourceItemNeedsAttention(item) {
    // 执行失败轮次（execution_evaluation/failed）不算来源异常（2026-09-16）：
    // 它是 agent 执行失败的历史记录，不是用户能修复的数据源——进异常区只
    // 显示成 turn-哈希 + 无效重试；执行失败在对话侧已可见。
    if (String(item.kind || '') === 'execution_evaluation') return false;
    return item.status === 'failed'
      || (item.status === 'paused' && String(item.statusReason || '') !== 'source_paused');
  }
  function sourceIssueItems() {
    return S.sources
      .flatMap((group) => (Array.isArray(group.items) ? group.items : []))
      .filter(sourceItemNeedsAttention);
  }
  /** 来源异常展开区：只讲需要处理的那几条（标题/原因人话/动作）。 */
  function sourceIssuesSection(route) {
    const issues = sourceIssueItems();
    if (!issues.length) return '';
    const open = String(route.sourceIssueOpen || '') === 'open';
    if (!open) return '';
    const vocab = NS.vocabulary;
    const rows = issues.slice(0, 20).map((item) => {
      const reasonText = vocab ? vocab.sourceReasonText(item.statusReason) : '';
      // 重试只给 actions 里真支持 retry 的项（2026-09-16）：无差别给重试会让
      // 不支持重试的来源（如 actions 仅 remove）点了无效、误导用户。
      const actions = Array.isArray(item.actions) ? item.actions : [];
      const action = item.status === 'failed' && actions.includes('retry')
        ? btn(T('cognition.source_retry', '重试'), 'source-action', { id: item.id, data: { action: 'retry', kind: item.kind }, small: true })
        : item.status !== 'failed' && actions.includes('resume')
          ? btn(T('cognition.source_resume', '恢复'), 'source-action', { id: item.id, data: { action: 'resume', kind: item.kind }, small: true })
          : '';
      return `<div class="row is-flat">
        <div class="tw">
          <div class="tt">${esc(String(item.title || '').trim() || T('cognition.evidence_fallback', '来源记录'))}</div>
          <div class="mm">${esc(vocab ? vocab.kindLabel(item.kind) : T('cognition.source_kind_other', '其他来源'))}${reasonText ? ` · ${esc(reasonText)}` : ''}</div>
        </div>
        <div class="sd">${action}</div>
      </div>`;
    }).join('');
    return `<div class="card">${rows}
      ${issues.length > 20 ? `<div class="sub">${esc(T('cognition.source_issues_more', '仅显示前 {n} 条', { n: '20' }))}</div>` : ''}
    </div>`;
  }

  /** 任务执行失败展开区（A4，2026-09-29）：口径与 stats.taskFailed 同源——
   *  sources 里 lastTurnFailed 且未被整理会话覆盖的条目（core.stats 里是
   *  计数，这里是逐条；两边谓词必须同步改）。重跑入口=回到会话本身再说
   *  一次，这里不造第二种重试。 */
  function taskFailedSection(route) {
    const open = String(route.taskFailedOpen || '') === 'open';
    if (!open) return '';
    const captureConvIds = new Set((Array.isArray(S.captures) ? S.captures : [])
      .map((capture) => String((capture || {}).conversationId || '')).filter(Boolean));
    const rows = (Array.isArray(S.sources) ? S.sources : [])
      .flatMap((group) => (Array.isArray(group && group.items) ? group.items : []))
      .filter((item) => item && item.lastTurnFailed === true
        && !captureConvIds.has(String(item.id || '')))
      .slice(0, 20)
      .map((item) => `<div class="row is-flat">
        <div class="tw">
          <div class="tt">${esc(String(item.title || '').trim() || T('cognition.evidence_fallback', '来源记录'))}</div>
          <div class="mm">${esc(T('cognition.review_task_failed_row_hint', '任务没有跑出结果；回到会话重新发起即可'))}</div>
        </div>
        <div class="sd">${btn(T('cognition.review_task_failed_go', '回到会话'), 'open-conversation', { id: String(item.id || ''), small: true, className: 'o' })}</div>
      </div>`).join('');
    return `<div class="card">${rows || `<div class="sub">${esc(T('cognition.review_task_failed_none', '刚才那几条已经不在了'))}</div>`}</div>`;
  }

  /* ────────────────────────── 视图：候选详情 ────────────────────────── */

  /* 候选确认表单（2026-09-15 自 viewCandidate 抽出共享）：
   *  - candidateFormBody：纯表单区（警示/类型/判断/高级/证据+动作），
   *    供整理详情页合并进执行信息卡（外层由调用方提供 ca-candidate-detail
   *    标识——cand-type 与 readCandidateForm 靠它就近定位）；
   *  - candidateFormCard：带卡壳与标题行的完整卡（候选详情页用）。
   *  控件 id 带候选 id 后缀：一页多卡时全局 id 不重复（读取靠 [data-f]）。 */
  /** 候选卡的适用范围（承接表 02 / G2，2026-09-26 补落点）：新建型候选此前
   *  只显正文与来源，用户看不到它将来在什么范围生效。作用域 + 适用/禁用
   *  场景三行；一个都没有时如实说「没有限定」，不编造默认。更新型候选的
   *  适用范围已由依据链（improvementChainBlock ⑥）呈现，不重复。 */
  function candidateScopeField(candidate, opts = {}) {
    const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    const scope = String(candidate.suggestedScope || '').trim();
    // A7（2026-09-29）：适用范围映射走四语词条（与整理表单同源
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

  /** 正文规范警示（2026-09-29 正文一等规范）：主进程读回时派生的
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
  function candidateFormBody(candidate) {
    const refs = evidenceRefs(candidate);
    const broken = evidenceMostlyUnavailable(candidate);
    // 能力一律按主进程下发的 capability 判定，**缺失即视为只读**——与旧模块
    // "treats a candidate without capabilities as read-only instead of guessing"
    // 的口径一致。2026-09-20 统一：此前同一函数里并存三种读法（canEdit 用
    // `capabilities && …`、canPromote 用真值、canDefer/canReject 用 `!== false`），
    // 于是"capabilities 缺失"时仍会渲染出「稍后处理 / 拒绝」——正是本 PR 要消灭的
    // 那类必然失败的按钮。
    const caps = candidate.capabilities || {};
    const canEdit = !!caps.canEdit;
    const canPromote = !!caps.canPromote;
    const canDefer = !!caps.canDefer;
    const canReject = !!caps.canReject;
    const edit = canEdit;
    const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
    // 更新候选的差异确认卡（2026-09-16 版本组）：旧版全文对照 + 版本核对
    // 提示——任务所用版与当前在用版不一致时，确认前先核对改进对象。
    // 2026-09-25（specs/015 T014）：原「当前版本」差异区扩为**依据链**区块
    // （原方法与版本 / 同次任务 / 预期→实际 / 采用证据 / 为什么改 / 适用范围 /
    // 改动点，见 improvementChainBlock）。更新型候选的预期→实际由依据链呈现，
    // 不再叠加一份「复盘依据」，避免同屏两处同内容。
    const chainHtml = improvementChainBlock(candidate);
    // 确认时撞版本冲突的处置块（specs/015 T022）：就地说明"没生效"、按当前在用版
    // 重摆差异、给「按当前版本重新确认」。它只描述这一次确认的事实，不改变候选的
    // 待处理性质（候选仍可稍后处理/拒绝）。
    const conflictHtml = candidateVersionConflictBlock(candidate, canPromote);
    const legacyEvidenceHtml = candidate.evidenceSummary
      ? `<div class="note ca-candidate-legacy-evidence"><strong>${esc(T('cognition.candidate_legacy_evidence_summary', '旧版证据说明（已保留）'))}</strong><p class="content-text">${esc(candidate.evidenceSummary)}</p></div>`
      : '';
    const evidenceHtml = `${legacyEvidenceHtml}${refs.length
      ? evidenceGroupsHtml(refs)
      : `<span class="note">${esc(T('cognition.candidate_no_evidence', '没有可追溯的证据引用；确认前建议先补证。'))}</span>`}`;
    // 决策动作同样按 capability 收敛（2026-09-20 修）：终态候选（confirmed /
    // rejected / ignored）的映射是 canDefer=false、canReject=false、isTerminal=true，
    // 此前这两个按钮**无条件**渲染，用户点下去必然被后端状态机拒绝——旧 skills.js
    // 模块有一条 "never renders decision actions for terminal candidates" 的用例守着，
    // 2026-09-15 #266 重写时没带过来。口径见函数开头：缺失 capabilities 即只读。
    // 按钮名按型分支（specs/015 T023；2026-09-28 词表统一）：更新型「保存更新」，新建型「保存」。
    const decisionLabels = candidateDecisionLabels(candidate);
    const actionsHtml = `<div class="actions actions-right">
        ${canPromote ? btn(decisionLabels.promote, 'cand-adopt-with-form', { id: candidate.id, primary: true }) : ''}
        ${canDefer ? btn(decisionLabels.defer, 'cand-decide', { id: candidate.id, data: { action: 'defer' }, className: 'o' }) : ''}
        ${canReject ? btn(decisionLabels.reject, 'cand-decide', { id: candidate.id, data: { action: 'reject' }, danger: true }) : ''}
      </div>`;
    return `
      ${broken ? `<div class="warn">${esc(T('cognition.candidate_evidence_all_unavailable', '这条候选的大部分来源记录已被删除，无法核对证据。建议补充新证据后保存，或选择不保存。'))}</div>` : ''}
      ${candidate.mergedIntoAssetId ? `<div class="note">${esc(T('cognition.candidate_merged_into', '这条与已有资产相似：确认后会并入那条资产（融合出新版本），不会另开一条。'))}</div>` : ''}
      ${chainHtml ? '' : reviewSignalBlock(candidate)}
      ${chainHtml}
      ${candidateScopeField(candidate, { includeTaskConditions: !chainHtml })}
      ${conflictHtml}
      ${edit ? `
        ${field(T('cognition.type', '类型'), `<div class="chips">${CATEGORIES.map(([id, key, fb]) => { const on = String(candidate.suggestedType || '') === id; return `<span class="ca-chip ca-chip-opt${on ? ' is-green' : ''}" data-act="cand-type" data-id="${esc(id)}" ${roleBtn(`aria-pressed="${on ? 'true' : 'false'}"`)}>${esc(T(key, fb))}</span>`; }).join('')}</div>`)}
        ${field(T('cognition.capture.summary', '可复用内容'), window.uiTextarea({ id: `ca-cand-judgment-${esc(candidate.id)}`, value: candidate.judgment || '', attrs: { 'data-f': 'judgment' } }))}
        ${statementWarningHtml(candidate)}
        ${chainHtml ? '' : field(T('cognition.chain_value_label', '带来的价值'), window.uiTextarea({ id: `ca-cand-value-${esc(candidate.id)}`, value: candidate.value || '', attrs: { 'data-f': 'value' } }))}
        <details class="details">
          <summary>${esc(T('cognition.candidate_advanced', '高级选项（通常不用改）'))}</summary>
          ${field(T('cognition.candidate_scope_domain', '适用任务范围'), window.uiInput({ id: `ca-cand-scope-${esc(candidate.id)}`, value: candidate.suggestedScope || '', placeholder: T('cognition.candidate_scope_placeholder', '例如：仅产品工作空间'), attrs: { 'data-f': 'scope' } }))}
          <div class="note">${esc(T('cognition.candidate_scope_hint', '常用范围：跨对话通用（general）、报告（report）、编程（code）、审查（review）、产品（product）。其他写法可能匹配不上任务，建议从这里选一个。'))}</div>
          ${field(T('cognition.capture.name', '认知名称'), window.uiInput({ id: `ca-cand-summary-${esc(candidate.id)}`, value: candidate.summary || '', attrs: { maxlength: 60, 'data-f': 'summary' } }))}
          ${chainHtml ? '' : field(T('cognition.chain_uncertainty_label', '仍不确定的地方'), window.uiTextarea({ id: `ca-cand-uncertainty-${esc(candidate.id)}`, value: candidate.uncertainty || '', attrs: { 'data-f': 'uncertainty' } }))}
        </details>
        <div class="ca-detail-foot">
          ${field(T('cognition.evidence_refs', '证据引用'), evidenceHtml)}
          ${kstarEpisodeSection(S.route)}
          ${(() => {
            /* 「保存」被能力门控关掉时必须说明原因——否则用户面前只有
               稍后/拒绝两个出口，不知道为什么不能确认（2026-09-21 真机抓出）。 */
            const capsAll = candidate.capabilities || {};
            const reasons = Array.isArray(capsAll.ineligibleReasons) ? capsAll.ineligibleReasons : [];
            if (canPromote || !reasons.length) return '';
            const lines = reasons.map((r) => NS.promotionBlockText ? NS.promotionBlockText(r) : '').filter(Boolean);
            if (!lines.length) return '';
            return `<div class="note cand-block-note">${esc(T('cognition.candidate_error_promotion_blocked', '这条候选还不够格成为正式资产：'))}${lines.map((line) => `<br>· ${esc(line)}`).join('')}<br>${esc(T('cognition.candidate_block_hint', '修改内容或类型使其合格后，「保存」会自动出现。'))}</div>`;
          })()}
          ${actionsHtml}
        </div>
      ` : `
        <p class="content-text">${esc(candidate.judgment || '')}</p>
        ${refs.length ? evidenceGroupsHtml(refs) : ''}
        ${kstarEpisodeSection(S.route)}
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
      rejected: 'rejected',
      ignored: 'ignored',
      expired: 'expired',
      failed: 'failed',
      superseded: 'superseded',
    })[String(candidate.status || '')] || 'unknown';
  }

  function candidateStatusPresentation(candidate) {
    const state = candidateDisplayState(candidate);
    const copy = {
      needs_review: ['cognition.candidate_status_pending', '待确认', 'amber'],
      weak_evidence: ['cognition.candidate_status_weak_evidence', '证据不足', 'amber'],
      deferred: ['cognition.candidate_snoozed', '已稍后处理', 'amber'],
      confirmed: ['cognition.candidate_status_promoted', '已保存', 'green'],
      rejected: ['cognition.candidate_status_rejected', '未保存', 'gray'],
      ignored: ['cognition.candidate_status_ignored', '已忽略', 'gray'],
      expired: ['cognition.candidate_status_expired', '已失效', 'gray'],
      superseded: ['cognition.candidate_status_expired', '已失效', 'gray'],
      failed: ['cognition.candidate_status_failed', '处理失败', 'amber'],
      unknown: ['cognition.candidate_status_other', '状态待核对', 'gray'],
    }[state] || ['cognition.candidate_status_other', '状态待核对', 'gray'];
    return { state, label: T(copy[0], copy[1]), tone: copy[2] };
  }

  function candidateFormCard(candidate) {
    const broken = evidenceMostlyUnavailable(candidate);
    const status = candidateStatusPresentation(candidate);
    const isTerminal = Boolean((candidate.capabilities || {}).isTerminal)
      || ['confirmed', 'rejected', 'ignored', 'expired', 'superseded'].includes(status.state);
    const stateHint = status.state === 'confirmed'
      ? T('cognition.candidate_detail_saved_hint', '已保存为正式资产。后续修改或暂停，请到资产详情操作。')
      : T('cognition.candidate_detail_terminal_hint', '这条建议已处理，不能再次确认；原记录保留供查看。');
    const nextStep = status.state === 'confirmed' && candidate.promotedAssetId
      ? btn(T('cognition.candidate_detail_open_asset', '查看已保存资产'), 'go-inbox-asset', {
        small: true, className: 'o', data: { id: String(candidate.promotedAssetId) },
      })
      : status.state === 'ignored' && candidate.mergedInto
        ? btn(T('cognition.candidate_detail_open_merged_candidate', '查看合并后的建议'), 'open-candidate', {
          small: true, className: 'o', data: { id: String(candidate.mergedInto) },
        })
        : '';
    /* 标题=完整 summary（不再截 24 字）：这是这条建议的名称，
       截断后「看起来没有标题」（2026-09-21 子安真机抓出）；CSS 限 3 行。 */
    const fullTitle = String(candidate.summary || candidate.judgment || T('cognition.candidate_untitled', '未命名候选')).trim();
    return `
    <div class="card ca-candidate-detail" data-cand-id="${esc(candidate.id)}" data-cand-type="${esc(candidate.suggestedType || '')}">
      <div class="cand-head">
        ${chip(status.label, status.tone)}${chip(categoryLabel(candidate.suggestedType))}${candidateRiskBadge(candidate)}${broken ? chip(T('cognition.candidate_evidence_weak', '来源已删'), 'amber') : ''}
      </div>
      <h2 class="cand-title">${esc(fullTitle)}</h2>
      ${isTerminal ? `<div class="note ca-candidate-state-note">${esc(stateHint)}${nextStep ? `<div class="actions">${nextStep}</div>` : ''}</div>` : ''}
      ${candidateFormBody(candidate)}
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
    title: candidateTitle,
    card: candidateCard,
    awaiting: candidateAwaiting,
    evidenceMostlyUnavailable,
    sourceIssuesSection,
    taskFailedSection,
    viewCandidate,
  };
})();
