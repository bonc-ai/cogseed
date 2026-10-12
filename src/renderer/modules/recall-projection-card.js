// 「本次使用的记忆」卡（2026-09-28 四病整改拍板项 #8 / 设计 7.4）。
//
// 这张卡由两张卡合并而来——它们原本抢同一个语义位置（盘点 B5 互斥抑制）：
//   - 引用卡（conversation.js 旧 _renderRecallCitationsHtml）：事后回执——这条
//     回答**实际用了**哪些记忆（citations），带 有帮助/需改进 反馈；
//   - 投影卡（本文件旧 _renderModelSelectedReceipt）：事前面板——任务**带入了**
//     哪些、**省略了**哪些（projection 生命周期），带 撤销 操作。
//
// 合并后一张卡按「带入 → 使用 → 反馈」一条线讲完：
//   头部＝投影状态摘要（带入 N 条 · 省略 M 条）；列表＝资产行（带入 + 被实际
//   引用标记；省略灰显 + 原因）；尾部＝反馈（有帮助/需改进）＋投影操作（随
//   投影状态显隐）。数据源（citations 与 projection）与投影数据结构**不动**，
//   纯渲染层合并；壳沿用引用卡收敛后的单一样式（6dff92a5 契约）。
//
// 这张卡渲染的是**正式 Ability Asset**（context-projection 全程只有 assetId /
// maturity），不是候选池对象。文案一律用「资产」：叫成「候选」会把 Candidate
// 生命周期和 Asset 成熟度两层重新混掉，用户会以为这些东西还等着确认。
(function () {
  function _escape(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _label(key, fallback, vars) {
    try {
      if (typeof t === 'function') {
        const value = t(key, vars || undefined);
        if (value && value !== key) return value;
      }
    } catch (_) {}
    let out = String(fallback || '');
    if (vars) out = out.replace(/\{(\w+)\}/g, (match, name) => vars[name] != null ? String(vars[name]) : match);
    return out;
  }


  /**
   * 新控件一律走共享按钮原语（shared-ui-adoption-guard 的规矩）；本模块既有的
   * 四个历史控件保持原样、由守卫基线冻结。原语缺席（极简渲染上下文）时返回空串，
   * 不在这里自造控件标记——那又会在基线之外多出一个原始控件。
   */
  function _sharedButton(label, attrs) {
    if (typeof window.uiButton !== 'function') return '';
    return window.uiButton({ label, size: 'sm', attrs });
  }

  function _headIconHtml(name, iconClass) {
    if (typeof window.uiIconHtml !== 'function') return '';
    return `<span class="${iconClass}">${window.uiIconHtml(name, 'ui-icon')}</span>`;
  }

  /** 头部折叠箭头（2026-09-29 二轮）：只是指示图标，不是按钮——点击热区是整个
   *  头部（.chat-recall-citations-head，点击/键盘都由 conversation.js 的 hydrate
   *  委托认领）。展开时箭头朝上（点它收起），收起时朝下，换向由 CSS 按
   *  .is-collapsed 旋转。图标原语缺席（极简渲染上下文）时整颗降级为空串。 */
  function _toggleIconHtml() {
    if (typeof window.uiIconHtml !== 'function') return '';
    return `<span class="chat-recall-toggle" aria-hidden="true">${window.uiIconHtml('chevron-down', 'ui-icon')}</span>`;
  }

  function _assetStatusLabel(status) {
    if (status === 'active') return _label('recall.asset.status.active', 'Active');
    if (status === 'paused') return _label('recall.asset.status.paused', 'Paused');
    if (status === 'revoked') return _label('recall.asset.status.revoked', 'Revoked');
    return String(status || '');
  }

  function _assetRecommendationLabel(action) {
    if (action === 'pause') return _label('recall.asset.recommend.pause', 'Pause recommended');
    if (action === 'rework') return _label('recall.asset.recommend.rework', 'Rework recommended');
    return String(action || '');
  }

  /** 被拦规则标识 → 规则名（US-604 AC1）：与资产页/选择器共用同一套
   *  `cognition.block_reason_*` 文案，三处说法一致。只翻标识，不上屏原文。 */
  function _omissionReasonLabel(rule) {
    const key = String(rule || '');
    if (key === 'paused') return _label('cognition.block_reason_paused', 'Paused by you');
    if (key === 'archived') return _label('cognition.block_reason_archived', 'Archived');
    if (key === 'revoked') return _label('cognition.block_reason_revoked', 'Use revoked');
    if (key === 'deleted') return _label('cognition.block_reason_deleted', 'Deleted (recoverable)');
    if (key === 'purged') return _label('cognition.block_reason_purged', 'Permanently deleted');
    if (key === 'inactive') return _label('cognition.block_reason_inactive', 'Not in an active state');
    if (key === 'missing') return _label('cognition.block_reason_missing', 'No longer exists');
    if (key === 'source_unavailable') return _label('cognition.block_reason_source_unavailable', 'Source no longer available');
    if (key === 'agent') return _label('cognition.block_reason_agent', 'Recipient not allowed');
    if (key === 'scope') return _label('cognition.block_reason_scope', 'Scope not allowed');
    if (key === 'maturity') return _label('cognition.block_reason_maturity', 'Use contract does not allow it');
    if (key === 'forbidden_context') return _label('cognition.block_reason_forbidden_context', 'Forbidden context');
    if (key === 'not_applicable_context') return _label('cognition.block_reason_not_applicable_context', 'Not applicable here');
    if (key === 'version_changed') return _label('cognition.block_reason_version_changed', 'Version changed');
    if (key === 'versions_missing') return _label('cognition.block_reason_versions_missing', 'Version snapshot missing');
    return _label('cognition.block_reason_unknown', 'Blocked');
  }

  function _statusLabel(status) {
    if (status === 'revoked') return _label('recall.projection.status.revoked', 'Revoked');
    if (status === 'confirmed') return _label('recall.projection.status.confirmed', 'Confirmed');
    if (status === 'preview') return _label('recall.projection.status.preview', 'Preview');
    if (status === 'deferred') return _label('recall.projection.status.deferred', 'Deferred');
    if (status === 'rejected') return _label('recall.projection.status.rejected', 'Rejected');
    if (status === 'expired') return _label('recall.projection.status.expired', 'Expired');
    return String(status || '');
  }

  // ── 引用行（原 conversation.js 记忆卡的内容行，随两卡合并迁入本文件）──────

  /** 类型枚举 = candidate-service.ts::AbilityAssetType（IPC recall.candidates.save
   *  同集校验）。fact 的措辞与资产页 cognition.asset_category_fact（事实与知识）
   *  同词，不另造第三种叫法。 */
  function _citationTypeLabel(type) {
    const normalized = String(type || '').trim().toLowerCase();
    const key = normalized === 'personal' ? 'chat.recall.type_personal'
      : normalized === 'rule' ? 'chat.recall.type_rule'
      : normalized === 'template' ? 'chat.recall.type_template'
      : normalized === 'skill_method' ? 'chat.recall.type_skill_method'
      : normalized === 'fact' ? 'chat.recall.type_fact'
      : '';
    if (!key) return String(type || '').trim();
    const value = typeof t === 'function' ? t(key) : key;
    return value && value !== key ? value : String(type || '').trim();
  }

  /** 范围有两套取值：现行契约五枚（prompts/recall_candidate_contract.md：
   *  general | report | code | review | product）与历史值（global/project/agent/
   *  personal——含 transcript 纠错流程仍在写的 'personal'）。契约五枚直接复用
   *  整理表单的 cognition.capture.scope_* 词条（与 review-candidate.js 的
   *  candidateScopeField/A7 同源，三处同词）；历史值沿用本卡旧键做存量容错。 */
  function _citationScopeLabel(scope) {
    const normalized = String(scope || '').trim().toLowerCase();
    const keys = {
      general: 'cognition.capture.scope_general',
      report: 'cognition.capture.scope_report',
      code: 'cognition.capture.scope_code',
      review: 'cognition.capture.scope_review',
      product: 'cognition.capture.scope_product',
      global: 'chat.recall.scope_global',
      project: 'chat.recall.scope_project',
      agent: 'chat.recall.scope_agent',
      personal: 'chat.recall.scope_personal',
    };
    const key = Object.prototype.hasOwnProperty.call(keys, normalized) ? keys[normalized] : '';
    if (!key) return String(scope || '').trim();
    const value = typeof t === 'function' ? t(key) : key;
    return value && value !== key ? value : String(scope || '').trim();
  }

  function _assetLinkButton(title, assetId, className) {
    if (typeof window.uiButton !== 'function') return `<strong>${_escape(title)}</strong>`;
    return window.uiButton({
      label: title,
      role: 'ghost',
      size: 'sm',
      className,
      attrs: { 'data-asset-citation': assetId },
    });
  }

  /** 被实际引用的资产行（citations）：链接 + 类型·范围 + 「已引用」标记。 */
  function _citedRowHtml(citation) {
    const assetId = String(citation?.asset_id || '');
    const title = String(citation?.title || '').trim();
    if (!assetId || !title) return '';
    const meta = [
      _citationTypeLabel(citation.type),
      _citationScopeLabel(citation.scope),
      _label('chat.recall.memory_card_cited', '已引用'),
    ].filter(Boolean).join(' · ');
    return `<div class="chat-recall-citation is-cited" data-recall-asset-id="${_escape(assetId)}">${_assetLinkButton(title, assetId, 'chat-recall-citation-open')}${meta ? `<span>${_escape(meta)}</span>` : ''}</div>`;
  }

  /** 带入但未被引用的资产行（projection.assetSummaries）：同一行样式，无已引用
   *  标记。已确认投影注入的是确认时那一版，所以显示确认版本而不是 live 版本，
   *  否则用户会以为运行中用的是他刚改出来的新版。 */
  function _broughtRowHtml(asset, citedAssetIds) {
    const id = String(asset?.assetId || asset?.id || '');
    if (!id || citedAssetIds.has(id)) return '';
    // 资产 id 是定位键，不是名字：解析不出标题时给语义占位。
    const title = String(asset?.title || '').trim() || _label('recall.projection.asset_untitled', 'Untitled asset');
    const shownVersion = asset?.confirmedVersion || asset?.version;
    const governance = [
      asset?.status && asset.status !== 'active' ? _assetStatusLabel(asset.status) : '',
      asset?.recommendedAction ? _assetRecommendationLabel(asset.recommendedAction) : '',
    ].filter(Boolean).join(' · ');
    // 带入行与已引用行同一套白话（此前这里 type/scope 原文上屏，同一张卡
    // 两行两种语言）。词表门禁见 test/renderer/recall-citation-labels.test.ts。
    const meta = [_citationTypeLabel(asset?.type), _citationScopeLabel(asset?.scope), shownVersion ? `v${shownVersion}` : ''].filter(Boolean).join(' · ');
    // 版本钉住是有意的（不在用户背后换掉他确认过的内容），所以这里只告知，
    // 不提供"就地升到新版"——已确认投影不可再改，新版本要靠下次重新选择。
    const stale = asset?.stale
      ? `<span class="chat-recall-projection-stale">${_escape(_label(
          'recall.projection.asset_stale',
          'Still running the confirmed v{confirmed}; the asset is now v{current}. It takes effect after you select it again.',
          { confirmed: asset?.confirmedVersion || '', current: asset?.version || '' },
        ))}</span>`
      : '';
    return `<div class="chat-recall-citation" data-recall-projection-asset="${_escape(id)}">${_assetLinkButton(title, id, 'chat-recall-citation-open')}${meta ? `<span>${_escape(meta)}${governance ? ` · ${_escape(governance)}` : ''}</span>` : ''}${stale}</div>`;
  }

  /** 「本轮未带入」行（US-604 AC4/AC7）：发送前重检被拦不再静默——灰显并说明
   *  是哪条内容、被哪条规则拦下。只给标题与规则名，不含正文、不含内部 id。
   *  词表沿用 recall.projection.omitted 系词条。 */
  function _omittedRowHtml(item) {
    const title = String(item?.title || '').trim() || _label('recall.projection.asset_untitled', 'Untitled asset');
    const reason = _omissionReasonLabel(String(item?.reason || ''));
    return `<div class="chat-recall-citation is-omitted">${_escape(_label(
      'recall.projection.omitted_this_turn',
      'Not carried this turn: {title} ({reason})',
      { title, reason },
    ))}</div>`;
  }

  // ── 合并卡（拍板项 #8）：同步骨架与投影补全共用同一个构造器 ──────────────

  /** 有效引用行（与旧引用卡同口径：有 asset_id 且标题非空，最多 12 条）。 */
  function _validCitations(citations) {
    return (Array.isArray(citations) ? citations : [])
      .filter((citation) => citation && citation.asset_id && String(citation.title || '').trim())
      .slice(0, 12);
  }

  /**
   * 「本次使用的记忆」卡内容（不含外壳）：
   *  - card 为空 → 引用卡形态（标题+引用行+反馈尾部，投影槽位不渲染）；
   *  - card 到位 → 合并形态（头部投影摘要、带入行、省略行、投影操作并入同卡）。
   * 投影数据是异步拉取的，补全靠整体替换 host.innerHTML——反馈与投影操作的
   * 事件因此全部走委托（mountRecallProjectionCard 与 conversation.js 的
   * _hydrateRecallCitations 各自委托一次），不怕整卡重画。
   * 布局（2026-09-29 二轮）：计数内联在标题右侧；状态说明句挪到尾行、撤销左侧；
   * 头部即折叠热区（role=button），默认收起。
   */
  function _memoryCardInnerHtml(card, userPinned, omissions, citations, feedbackSent, collapsed = true) {
    const citedList = _validCitations(citations);
    const citedAssetIds = new Set(citedList.map((citation) => String(citation.asset_id)));
    const assets = card && Array.isArray(card.assetSummaries) ? card.assetSummaries : [];
    const modelIds = card && Array.isArray(card.modelSelectedAssetIds) ? card.modelSelectedAssetIds : null;
    const hasModelLedger = Boolean(modelIds);
    const revoked = card?.status === 'revoked';
    // 头部：投影状态摘要（带入 N 条 · 省略 M 条）。有模型点名账本时点明其中
    // 模型挑了几条（旧 model_selected_summary_precise 的信息量并进同一行）。
    const broughtCount = card
      ? Number(card.totalAssetCount ?? assets.length)
      : citedList.length;
    const omittedCount = Array.isArray(omissions) ? omissions.length : 0;
    const summaryLine = card
      ? [
          _label('chat.recall.memory_card_brought', '带入 {n} 条', { n: String(broughtCount) }),
          omittedCount > 0 ? _label('chat.recall.memory_card_omitted', '省略 {n} 条', { n: String(omittedCount) }) : '',
          hasModelLedger
            ? _label('chat.recall.memory_card_model_picked', '其中模型挑 {n} 条', { n: String(card.modelSelectedCount ?? modelIds.length) })
            : '',
        ].filter(Boolean).join(' · ')
      : '';
    // 状态说明（锁定/撤销语义，沿用投影卡既有词条）。
    const note = !card ? ''
      : revoked
        ? (userPinned
          // US-604 AC8：撤销要如实说明已生效范围——已经发出去的那一轮收不回来。
          ? _label('recall.projection.user_pinned_revoked_note', 'Revoked. What was already sent this turn cannot be recalled; later turns will not carry it.')
          : _label('recall.projection.revoked_note', 'Revoked: later turns no longer carry these assets.'))
        : userPinned
          // 用户自己 @ 钉的（2026-09-25 US-601）：说的是"你引用的"，且明确可撤销。
          ? _label('recall.projection.user_pinned_locked', 'You referenced these for this conversation; later turns keep carrying them until you revoke.')
          : _label('recall.projection.model_selected_locked', 'The model picked these for the current task; later turns keep carrying them until you revoke.');
    const badge = card
      ? (userPinned
        ? _label('recall.projection.user_pinned_badge', 'You referenced')
        : _label('recall.projection.model_selected_badge', 'Model-picked'))
      : '';
    const statusLabel = card ? _statusLabel(card.status) : '';
    const rows = [
      ...citedList.map(_citedRowHtml),
      ...(card ? assets.map((asset) => _broughtRowHtml(asset, citedAssetIds)) : []),
    ].filter(Boolean);
    const omittedRows = (Array.isArray(omissions) ? omissions : []).map(_omittedRowHtml).join('');
    // 尾部投影操作随状态显隐：撤销只在未撤销时提供（幂等语义由主进程保证，
    // 界面不重复提供入口）。
    const projectionActions = card && !revoked
      ? `<span class="chat-recall-projection-summary-actions">${_sharedButton(_label('recall.projection.revoke', 'Revoke'), { 'data-recall-projection-revoke': '1' })}</span>`
      : '';
    const helpful = _label('chat.recall.feedback_helpful', 'Helpful');
    const improve = _label('chat.recall.feedback_improve', 'Needs improvement');
    const feedbackStatus = feedbackSent
      ? `<span class="chat-recall-feedback-status" data-recall-feedback-status aria-live="polite">${_escape(_label('chat.recall.feedback_thanks', 'Thanks for the feedback'))}</span>`
      : '<span class="chat-recall-feedback-status" data-recall-feedback-status aria-live="polite"></span>';
    // 反馈按钮沿用原引用卡形态（共享 uiButton + 图标 + 专用类名——
    // .is-feedback-sent 的让位规则锚定 .chat-recall-feedback-btn）。
    const feedbackButton = (label, icon, value) => (typeof window.uiButton === 'function'
      ? window.uiButton({ label, role: 'ghost', size: 'sm', icon, className: 'chat-recall-feedback-btn', attrs: { 'data-recall-feedback': value, title: label } })
      : '');
    const feedbackButtons = feedbackButton(helpful, 'thumbs-up', 'positive')
      + feedbackButton(improve, 'thumbs-down', 'negative');
    const noteHtml = note
      ? `<small class="chat-recall-citations-note">${_escape(note)}</small>`
      : '';
    return `<div class="chat-recall-citations-head" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}">
        ${_headIconHtml('brain-circuit', 'chat-recall-citations-icon')}
        <div class="chat-recall-citations-title">
          <strong>${_escape(_label('chat.recall.memory_card_title', '本次使用的记忆'))}${summaryLine ? `<span class="chat-recall-citations-count">${_escape(summaryLine)}</span>` : ''}</strong>
        </div>
        ${badge ? `<span class="chat-recall-projection-badge">${_escape(badge)}</span>` : ''}
        ${statusLabel ? `<span class="chat-recall-projection-status">${_escape(statusLabel)}</span>` : ''}
        ${feedbackStatus}
        ${_toggleIconHtml()}
      </div>
      ${rows.length ? `<div class="chat-recall-citation-list">${rows.join('')}</div>` : ''}
      ${omittedRows ? `<div class="chat-recall-projection-omitted">${omittedRows}</div>` : ''}
      <div class="chat-recall-feedback-actions">${feedbackButtons}${noteHtml}${projectionActions}</div>`;
  }

  /**
   * 同步骨架（conversation.js 有引用数据先出卡；无有效引用行时返回空串——
   * 与旧引用卡同口径，不出空壳卡）。投影数据异步到位后由
   * mountRecallProjectionCard 在同一张卡里整卡补全。
   */
  function recallMemoryCardHtml(citations) {
    if (!_validCitations(citations).length) return '';
    return `<section class="chat-recall-citations">${_memoryCardInnerHtml(null, false, [], citations, false, true)}</section>`;
  }

  // ── 旧预载草稿渲染分支（2026-08-17 起生产不可达：对话侧只挂模型自选与
  // 用户 @ 钉住，其余授权维持"不挂卡"。保留给独立调用与既有测试契约。）────

  function _assetRow(asset, editable, openable = false) {
    const id = String(asset?.assetId || asset?.id || '');
    // 资产 id 是定位键，不是名字：解析不出标题时给语义占位。
    const title = String(asset?.title || '').trim() || _label('recall.projection.asset_untitled', 'Untitled asset');
    const titleContent = openable && id && typeof window.uiButton === 'function'
      ? window.uiButton({
          label: title,
          role: 'ghost',
          size: 'sm',
          className: 'chat-recall-projection-open-asset',
          attrs: { 'data-asset-citation': id },
        })
      : `<strong>${_escape(title)}</strong>`;
    const shownVersion = asset?.confirmedVersion || asset?.version;
    const meta = [asset?.type, asset?.scope, shownVersion ? `v${shownVersion}` : ''].filter(Boolean).join(' · ');
    const governance = [asset?.status && asset.status !== 'active' ? _assetStatusLabel(asset.status) : '', asset?.recommendedAction ? _assetRecommendationLabel(asset.recommendedAction) : ''].filter(Boolean).join(' · ');
    const reason = asset?.recommendationReason ? `<em>${_escape(asset.recommendationReason)}</em>` : '';
    const stale = asset?.stale
      ? `<small class="chat-recall-projection-stale">${_escape(_label(
          'recall.projection.asset_stale',
          'Still running the confirmed v{confirmed}; the asset is now v{current}. It takes effect after you select it again.',
          { confirmed: asset?.confirmedVersion || '', current: asset?.version || '' },
        ))}</small>`
      : '';
    return `<div class="chat-recall-projection-asset${asset?.stale ? ' is-stale' : ''}" data-recall-projection-asset="${_escape(id)}"><div>${titleContent}${meta ? `<small>${_escape(meta)}</small>` : ''}${governance ? `<small class="chat-recall-projection-governance">${_escape(governance)}</small>` : ''}${stale}${reason}</div>${editable ? `<button type="button" class="btn btn-sm" data-recall-projection-remove="${_escape(id)}">${_escape(_label('recall.projection.remove_task_asset', 'Remove asset'))}</button>` : ''}</div>`;
  }

  function _availableRow(asset) {
    const id = String(asset?.id || asset?.assetId || '');
    const title = String(asset?.title || id);
    const meta = [asset?.type, asset?.scope, asset?.version].filter(Boolean).join(' · ');
    return `<div class="chat-recall-projection-available"><div><strong>${_escape(title)}</strong>${meta ? `<small>${_escape(meta)}</small>` : ''}</div><button type="button" class="btn btn-sm" data-recall-projection-add="${_escape(id)}">${_escape(_label('recall.projection.add_task_asset', 'Add asset'))}</button></div>`;
  }

  function _renderLegacyDraft(host, card, available, opts, forecastFailure) {
    host.className = 'chat-recall-projection-card';
    host.dataset.projectionId = String(card?.projectionId || opts?.projectionId || '');
    const editable = card?.status === 'preview';
    const assets = Array.isArray(card?.assetSummaries) ? card.assetSummaries : [];
    const availableRows = editable && Array.isArray(available) && available.length
      ? `<div class="chat-recall-projection-available-list">${available.map(_availableRow).join('')}</div>`
      : editable
        ? `<div class="chat-recall-projection-empty">${_escape(_label('recall.projection.no_available_assets', 'No more assets to add.'))}</div>`
        : '';
    const revoked = card?.status === 'revoked';
    const actions = forecastFailure
      ? `<div class="chat-recall-projection-forecast-failure" role="alert"><strong>${_escape(_label('recall.projection.forecast_failed', 'Forecast failed; task has not started.'))}</strong><small>${_escape(forecastFailure.message || '')}</small><button type="button" class="btn btn-sm" data-recall-projection-retry="1">${_escape(_label('recall.projection.retry_forecast', 'Retry forecast'))}</button></div>`
      : editable
        ? `<div class="chat-recall-projection-actions"><button type="button" class="btn btn-primary btn-sm" data-recall-projection-confirm="1">${_escape(_label('recall.projection.confirm_assets', 'Confirm assets'))}</button></div>`
        : revoked
          ? ''
          : `<div class="chat-recall-projection-locked">${_escape(_label('recall.projection.locked', 'These preloaded assets are locked.'))}</div>`;
    host.innerHTML = `<div class="chat-recall-projection-head">${_headIconHtml('book-open', 'chat-recall-projection-icon')}<div><strong>${_escape(_label('recall.projection.title', 'Preloaded assets'))}</strong><small>${_escape(card?.purpose || '')}</small></div><span class="chat-recall-projection-status">${_escape(_statusLabel(card?.status))}</span></div>
      <div class="chat-recall-projection-summary">${_escape(_label('recall.projection.summary', '{count} preloaded assets.', { count: assets.length }))}</div>
      <div class="chat-recall-projection-section"><div class="chat-recall-projection-section-title">${_escape(_label('recall.projection.included_assets', 'Preloaded assets'))}</div>${assets.length ? assets.map((asset) => _assetRow(asset, editable)).join('') : `<div class="chat-recall-projection-empty">${_escape(_label('recall.projection.no_included_assets', 'No preloaded assets selected.'))}</div>`}</div>
      ${editable ? `<div class="chat-recall-projection-section"><div class="chat-recall-projection-section-title">${_escape(_label('recall.projection.add_assets', 'Add asset'))}</div>${availableRows}</div>` : ''}
      ${actions}`;
  }

  async function _loadCard(projectionId) {
    const result = await window.cogseed.invoke('recall.projections.card', { projectionId });
    if (!result?.ok || !result.card) throw new Error(result?.error || 'projection card unavailable');
    return result.card;
  }

  async function _loadAvailable(projectionId, editable) {
    if (!editable) return [];
    const result = await window.cogseed.invoke('recall.projections.availableAssets', { projectionId });
    if (!result?.ok) return [];
    return Array.isArray(result.assets) ? result.assets : [];
  }

  /** 合并卡（模型自选/用户 @ 钉住）与旧预载草稿分支的分派。 */
  function _render(host, card, available, opts, forecastFailure, omissions) {
    // 模型自选（2026-09-18）：卡片是"模型为这个任务挑的资产"，不是等用户
    // 确认的预载草稿。用户 @ 钉住（2026-09-25 US-601）：同一张卡，只是"谁
    // 做的决定"不同，撤销口也不同（revokePinned）——引用回执必须可撤销，
    // 否则挂上去就下不来。
    const modelSelected = card?.authorization === 'model_selected';
    const userPinned = card?.authorization === 'user_confirmed' && card?.purpose === 'user_pinned';
    if (opts?.onlyModelSelected && !modelSelected && !userPinned) {
      // 只挂"模型自选"与"用户 @ 钉住"两类回执：其它授权（工作区策略/预载
      // 草稿）保持"不挂卡"的现状（2026-08-17 决策不动）。合并卡形态下引用
      // 行由 conversation.js 的同步骨架持有——有引用数据时只撤投影侧标记，
      // 不清壳；无引用数据时与旧行为一致整卡清空。
      delete host.dataset.projectionId;
      if (!_validCitations(opts?.citations).length) {
        host.className = '';
        host.innerHTML = '';
      }
      return;
    }
    if (modelSelected || userPinned) {
      // 合并卡（拍板项 #8）：citations（本次实际引用）与投影数据合成一张
      // 「本次使用的记忆」，整卡替换 host 内容。反馈已发状态挂在
      // host.dataset 上（conversation.js 写入），整卡重画后照旧呈现。
      // 旧传输 sidecar 才隐藏 fallback 正文；挂在最终回复上的卡不隐藏正文。
      if (host.dataset.recallProjectionTransport === 'sidecar') {
        const bubble = typeof host.closest === 'function' ? host.closest('.chat-bubble') : null;
        const prose = bubble && typeof bubble.querySelector === 'function' ? bubble.querySelector('.markdown-body') : null;
        if (prose) prose.hidden = true;
      }
      // 折叠态记在 host dataset（不随 innerHTML 重画丢）：缺省=收起（2026-09-29
      // 二轮拍板），只有显式 '0' 才是展开；重建 className 时回读。
      const collapsed = host.dataset.recallCollapsed !== '0';
      host.className = `chat-recall-citations${card?.status === 'revoked' ? ' is-projection-revoked' : ''}${host.dataset.feedbackSent === '1' ? ' is-feedback-sent' : ''}${collapsed ? ' is-collapsed' : ''}`;
      host.dataset.projectionId = String(card?.projectionId || opts?.projectionId || '');
      host.innerHTML = _memoryCardInnerHtml(card, userPinned, omissions, opts?.citations, host.dataset.feedbackSent === '1', collapsed);
      return;
    }
    _renderLegacyDraft(host, card, available, opts, forecastFailure);
  }

  async function mountRecallProjectionCard(host, messageCard, opts = {}) {
    if (!host || !messageCard?.projectionId) return;
    const projectionId = String(messageCard.projectionId);
    const cid = String(opts.cid || '');
    let forecastFailure = null;
    async function refresh() {
      host.dataset.loading = '1';
      try {
        const card = await _loadCard(projectionId);
        const available = await _loadAvailable(projectionId, card.status === 'preview');
        // 用户引用的资产被拦留痕（US-604 AC4/AC7）：只有用户钉住的卡需要显示
        // 「本轮未带入」，模型自选/其它授权不查这个口。
        let omissions = [];
        if (cid && card?.authorization === 'user_confirmed' && card?.purpose === 'user_pinned') {
          try {
            const result = await window.cogseed.invoke('recall.injections.omissions', { cid });
            omissions = (result && result.ok && Array.isArray(result.omissions)) ? result.omissions : [];
          } catch (_) {
            omissions = [];
          }
        }
        host.__recallProjectionRenderState = { card, available, opts, forecastFailure, omissions };
        _render(host, card, available, { ...opts, projectionId }, forecastFailure, omissions);
      } catch (error) {
        host.className = 'chat-recall-projection-card is-error';
        host.innerHTML = _escape((error && error.message) || String(error));
      } finally {
        host.dataset.loading = '0';
      }
    }
    if (!host.dataset.recallProjectionBound) {
      host.dataset.recallProjectionBound = '1';
      host.addEventListener('click', async (event) => {
        const confirm = event.target.closest('[data-recall-projection-confirm]');
        const retry = !confirm ? event.target.closest('[data-recall-projection-retry]') : null;
        const revoke = !confirm && !retry ? event.target.closest('[data-recall-projection-revoke]') : null;
        const remove = !confirm && !retry && !revoke ? event.target.closest('[data-recall-projection-remove]') : null;
        const add = !confirm && !retry && !revoke && !remove ? event.target.closest('[data-recall-projection-add]') : null;
        const button = confirm || retry || revoke || remove || add;
        if (!button || button.disabled || host.dataset.loading === '1') return;
        const assetId = remove ? remove.dataset.recallProjectionRemove : add?.dataset.recallProjectionAdd;
        if (!confirm && !retry && !revoke && !assetId) return;
        button.disabled = true;
        try {
          const result = confirm
            ? await window.cogseed.invoke('recall.projections.confirm', { projectionId, ...(cid ? { cid } : {}) })
            : retry
              ? await window.cogseed.invoke('recall.projections.retryForecast', { projectionId, ...(cid ? { cid } : {}) })
              : revoke
                // 撤销口按授权分流（US-601 AC3）：用户 @ 钉住的走 revokePinned，
                // 模型自选仍走原口——两条线的授权语义不同，各自可审计。
                ? await window.cogseed.invoke(
                    (host.__recallProjectionRenderState?.card?.authorization === 'user_confirmed'
                      && host.__recallProjectionRenderState?.card?.purpose === 'user_pinned')
                      ? 'recall.projections.revokePinned'
                      : 'recall.projections.revoke',
                    { projectionId },
                  )
                : await window.cogseed.invoke('recall.projections.revise', remove
                  ? { projectionId, removeAssetIds: [assetId] }
                  : { projectionId, addAssetIds: [assetId] });
          if (!result?.ok) throw Object.assign(new Error(result?.error || (confirm ? 'projection confirmation failed' : retry ? 'forecast retry failed' : revoke ? 'projection revoke failed' : 'projection revision failed')), { code: result?.code });
          forecastFailure = null;
          await refresh();
        } catch (error) {
          const code = error && error.code;
          const retryable = ['model_not_configured', 'model_unavailable', 'model_auth_failed', 'forecast_unavailable'].includes(code);
          if (confirm && retryable) {
            forecastFailure = { message: (error && error.message) || String(error) };
            await refresh();
          } else if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
        } finally {
          button.disabled = false;
        }
      });
    }
    await refresh();
  }

  /** 折叠翻转的唯一实现（2026-09-29）：状态记在宿主 dataset（缺省=收起）、
   *  is-collapsed 挂在宿主 className 上（与卡内其余 className 直写同一套路，
   *  vm 测试宿主也好替），_render 整卡重画时回读不丢；返回翻转后的折叠态。
   *  点击/键盘由 conversation.js 的 hydrate 委托认领（热区=整个头部）后调这里；
   *  mount 的动作委托不认头部点击——同一颗 host 上两个委托监听，只由 hydrate
   *  翻，避免翻两次回到原样。 */
  function recallCardToggleCollapsed(host) {
    if (!host || !host.dataset) return undefined;
    const collapsed = host.dataset.recallCollapsed !== '0';
    const next = !collapsed;
    host.dataset.recallCollapsed = next ? '1' : '0';
    const classes = String(host.className || '').split(/\s+/).filter(Boolean).filter((name) => name !== 'is-collapsed');
    if (next) classes.push('is-collapsed');
    host.className = classes.join(' ');
    const head = typeof host.querySelector === 'function' ? host.querySelector('.chat-recall-citations-head') : null;
    if (head) head.setAttribute('aria-expanded', next ? 'false' : 'true');
    return next;
  }

  window.recallMemoryCardHtml = recallMemoryCardHtml;
  window.mountRecallProjectionCard = mountRecallProjectionCard;
  window.recallCardToggleCollapsed = recallCardToggleCollapsed;
  if (typeof window.addEventListener === 'function') window.addEventListener('i18n-change', () => {
    document.querySelectorAll('[data-recall-projection-bound]').forEach((host) => {
      const state = host.__recallProjectionRenderState;
      if (state) _render(host, state.card, state.available, { ...state.opts, projectionId: String(state.card?.projectionId || '') }, state.forecastFailure, state.omissions);
    });
  });
})();
