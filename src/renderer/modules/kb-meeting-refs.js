/**
 * Meeting references panel — 会议引用面板（specs/013 会议引用层）
 *
 * 是什么：一场会议「引用了哪些资产 / 纪要条目 / 待办草稿 / 跨会议关联 / 回执」
 * 的汇总面板。T014 落骨架（五分区空态）；本版接数据：
 *   - T038 纪要条目 = 双引用展开（转写锚点定位 + 资产引用「标题 · vN」）+
 *     「对比现状」（冻结版 vN vs 现状 vM + stale 标记；stale 呈现口径对齐
 *     recall-projection-card：小字告知、不提供就地升级）；
 *   - T039 available:false（被引用版本已彻底删除）⇒「被引用版本已不存在」，
 *     现状未知就不显示现状（不假装读到了那一版）；
 *   - T043 待办草稿视图：来源（说话人 + 段落锚点）/ 资产引用（标题 + 冻结版）/
 *     状态章（草稿/已确认/已丢弃，uiTag）/ 三个动作（确认更新·稍后处理·拒绝，
 *     按语境复用 recall.asset_approval.{confirm,defer,reject} 既有三键——
 *     草稿动作语义：确认 = meeting.actions.confirm、拒绝 = .discard、
 *     稍后处理 = 不动数据，草稿保留可续办）。
 *   - T051 关联建议（US-505）：「上次提到」列表（哪场会/哪条结论/相关资产 +
 *     命中方式章）——只呈现**建议**；「引用到本会议」按钮**点了才建立**（调
 *     既有 meeting.assets.attach + meeting.conclusions.save，不新建写通道），
 *     不点时引用包零变化；
 *   - 回执列表仍为空态骨架，不提前造数据。
 *
 * 设计边界（与 specs/013 契约对齐）：
 *   - 引用链只有 id/版本/标题/摘要/锚点——**不读资产正文、不读转写正文**
 *     （隐私边界 D20；渲染层也不做任何"什么算需要确认"的判据重算）。
 *   - `meeting.*` 通道不可用 / `ok:false` 时分区不渲染 + 一条带原因的空态，
 *     不静默空白、不弹错误框（renderer-seams §5 降级路径）。
 *   - 控件全走共享原语（uiButton/uiTag/uiEmptyState）；本模块不出现裸控件
 *     （shared-ui-adoption-guard：不在基线表内 = 允许 0）。
 *
 * Renderer 约束：classic script（IIFE + window.*，无 JSX/bundler）、文案走
 * i18n 且**内联键名**（kb.meetingRef.*，四语齐全由 kb-i18n-keys 门禁看守）、
 * 订阅 i18n-change（切语言重渲染）。
 */

(function initKbMeetingRefs(root) {
  'use strict';

  const log = typeof createLogger === 'function' ? createLogger('kb-meeting-refs') : null;

  // ── i18n（缺键回退到中文默认文案，与 kb-transcript-correct 同款）────────
  function formatFallback(text, vars) {
    return String(text || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key) => String(vars?.[key] ?? ''));
  }

  function t(key, fallback, vars) {
    try {
      const value = typeof root.t === 'function' ? root.t(key, vars || {}) : '';
      return value && value !== key ? value : formatFallback(fallback, vars);
    } catch (_) {
      return formatFallback(fallback, vars);
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch] || ch));
  }

  // 骨架分区（顺序即面板呈现顺序；标题/空态文案全部内联键名，走 kb.meetingRef.*）
  const SECTION_KEYS = ['refs', 'conclusions', 'actions', 'related', 'receipts'];

  /** 分区文案（键名内联：kb-i18n-keys 门禁按 t('…') 字面扫描）。 */
  function sectionText(key) {
    if (key === 'refs') {
      return {
        title: t('kb.meetingRef.ref_section', '资产引用'),
        empty: t('kb.meetingRef.ref_empty', '暂无资产引用'),
      };
    }
    if (key === 'conclusions') {
      return {
        title: t('kb.meetingRef.conclusion_section', '纪要条目'),
        empty: t('kb.meetingRef.conclusion_empty', '暂无纪要条目'),
      };
    }
    if (key === 'actions') {
      return {
        title: t('kb.meetingRef.action_section', '待办草稿'),
        empty: t('kb.meetingRef.action_empty', '暂无待办草稿'),
      };
    }
    if (key === 'related') {
      return {
        title: t('kb.meetingRef.related_section', '关联建议'),
        empty: t('kb.meetingRef.related_empty', '暂无关联建议'),
      };
    }
    return {
      title: t('kb.meetingRef.receipt_section', '回执'),
      empty: t('kb.meetingRef.receipt_empty', '暂无回执（拒绝词条或应用清理后在这里留痕）'),
    };
  }

  /** 错误码 → 四语文案（渲染层按码翻译，不上屏英文原文；键名内联）。 */
  function errorText(code) {
    const key = String(code || '');
    if (key === 'invalid_doc_id') return t('kb.meetingRef.error_invalid_doc_id', '会议文档标识不合法');
    if (key === 'invalid_asset_id') return t('kb.meetingRef.error_invalid_asset_id', '资产标识不合法');
    if (key === 'invalid_via') return t('kb.meetingRef.error_invalid_via', '引用来源不合法');
    if (key === 'asset_missing') return t('kb.meetingRef.error_asset_missing', '该资产不存在或已彻底删除');
    if (key === 'asset_inactive') return t('kb.meetingRef.error_asset_inactive', '该资产已归档或暂停，不能引用');
    if (key === 'asset_ineligible') return t('kb.meetingRef.error_asset_ineligible', '该资产未通过引用准入，不能关联');
    if (key === 'ref_pack_full') return t('kb.meetingRef.error_ref_pack_full', '本会议的引用条目已达上限（100）');
    if (key === 'invalid_summary') return t('kb.meetingRef.error_invalid_summary', '摘要不合法（需 1~240 字）');
    if (key === 'invalid_item_id') return t('kb.meetingRef.error_invalid_item_id', '条目标识不合法');
    if (key === 'item_not_found' || key === 'draft_not_found') return t('kb.meetingRef.error_item_not_found', '条目不存在或已被删除');
    if (key === 'invalid_status_transition') return t('kb.meetingRef.error_status_transition', '状态已变更，请刷新后重试');
    if (key === 'draft_store_full') return t('kb.meetingRef.error_draft_store_full', '待办草稿已达上限（200）');
    if (key === 'draft_not_confirmed') return t('kb.meetingRef.error_draft_not_confirmed', '待办未确认，不能外发');
    if (key === 'target_already_set') return t('kb.meetingRef.error_target_set', '该待办已有落点，不能重复设置');
    if (key === 'invalid_input') return t('kb.meetingRef.error_invalid_input', '参数不合法');
    return t('kb.meetingRef.error_channel', '会议引用数据暂时不可用');
  }

  /** 段落锚点的定位描述（只有 id/段序/偏移——这是锚点，不是转写正文）。 */
  function anchorText(anchor) {
    return t('kb.meetingRef.conclusion_anchor', '转写锚点 {id}（段 {block}，偏移 {from}-{to}）', {
      id: String(anchor?.utteranceId || ''),
      block: String(anchor?.blockIndex ?? ''),
      from: String(anchor?.from ?? ''),
      to: String(anchor?.to ?? ''),
    });
  }

  /** 不可关联原因（旧数据如实降级，不猜位置、不报错；T036 口径）。 */
  function unlinkableText(reason) {
    if (reason === 'no_transcript_ref') return t('kb.meetingRef.conclusion_unlinkable_no_transcript_ref', '不可关联：该条目没有转写锚点');
    if (reason === 'anchor_not_found') return t('kb.meetingRef.conclusion_unlinkable_anchor_not_found', '不可关联：锚点在当前文稿中已解析不到');
    return t('kb.meetingRef.conclusion_unlinkable_legacy_record', '不可关联：旧记录缺少结构化引用');
  }

  function panelHtml() {
    return [
      '<div class="kb-mrf">',
      '  <div class="kb-mrf__head">',
      '    <div class="kb-mrf__title" data-mrf-title></div>',
      '    <div class="kb-mrf__meta" data-mrf-meta title=""></div>',
      '    <div class="kb-mrf__hint" data-mrf-hint></div>',
      '  </div>',
      '  <div class="kb-mrf__status" data-mrf-status hidden></div>',
      '  <div class="kb-mrf__sections" data-mrf-sections></div>',
      '</div>',
    ].join('');
  }

  // ── 面板 ─────────────────────────────────────────────────────────────
  function createPanel(container, ctx) {
    container.classList.add('kb-mrf-host');
    container.innerHTML = panelHtml();
    const q = (selector) => container.querySelector(selector);

    const state = {
      refs: [],
      refsError: '',
      conclusions: [],
      conclusionsError: '',
      actions: [],
      actionsError: '',
      related: [],
      relatedError: '',
      // 「对比现状」的展开状态（assetId → true）。refs 分区与纪要条目的资产行
      // 共享同一份（同一个 assetId 的冻结版对比只有一份数据）。
      expanded: {},
      status: '',
      statusTone: '',
    };

    function setStatus(message, tone) {
      state.status = message || '';
      state.statusTone = tone || '';
      renderStatus();
    }

    function renderStatus() {
      const host = q('[data-mrf-status]');
      if (!host) return;
      host.textContent = state.status;
      host.hidden = !state.status;
      host.dataset.tone = state.statusTone;
    }

    function renderHead() {
      const title = q('[data-mrf-title]');
      if (title) title.textContent = t('kb.meetingRef.panel_title', '会议引用');
      const meta = q('[data-mrf-meta]');
      if (meta) {
        // 规范 §四-3：文件名过长只显示尾段，hover 给完整路径（title 属性）。
        const full = ctx.displayPath || ctx.docId || '';
        const shortName = full.split(/[\\/]/).filter(Boolean).pop() || full;
        meta.textContent = shortName;
        meta.setAttribute('title', full);
      }
      const hint = q('[data-mrf-hint]');
      if (hint) {
        hint.textContent = t(
          'kb.meetingRef.panel_hint',
          '这里汇总这场会议的资产引用、纪要条目、待办草稿与回执；引用版本以挂载时的冻结版为准。',
        );
      }
    }

    // ── 数据加载（分区各自独立：一条通道失败不拖垮其它分区）──────────────
    async function callMeeting(channel, payload) {
      const result = await root.cogseed.invoke(channel, payload || {});
      if (result && result.ok === false) {
        const error = new Error(String(result.error || channel));
        error.code = result.code;
        throw error;
      }
      return result;
    }

    async function loadRefs() {
      try {
        const result = await callMeeting('meeting.assets.list', { docId: ctx.docId });
        state.refs = Array.isArray(result?.refs) ? result.refs : [];
        state.refsError = '';
      } catch (error) {
        log?.warn('meeting refs load failed', { error: error?.message || String(error) });
        state.refs = [];
        state.refsError = String(error?.code || '');
      }
    }

    async function loadConclusions() {
      try {
        const result = await callMeeting('meeting.conclusions.list', { docId: ctx.docId });
        state.conclusions = Array.isArray(result?.conclusions) ? result.conclusions : [];
        state.conclusionsError = '';
      } catch (error) {
        log?.warn('meeting conclusions load failed', { error: error?.message || String(error) });
        state.conclusions = [];
        state.conclusionsError = String(error?.code || '');
      }
    }

    async function loadActions() {
      try {
        const result = await callMeeting('meeting.actions.list', { docId: ctx.docId });
        state.actions = Array.isArray(result?.drafts) ? result.drafts : [];
        state.actionsError = '';
      } catch (error) {
        log?.warn('meeting actions load failed', { error: error?.message || String(error) });
        state.actions = [];
        state.actionsError = String(error?.code || '');
      }
    }

    /**
     * 加载「上次提到」关联建议（T051）。查询输入**只用本会议已挂载的引用**
     * （meeting.assets.list 的结果）：assetIds = 挂载资产 id；terms = 挂载资产
     * 的标题快照（确定性字符串——不做任何语义抽取）。通道只读、只给建议；
     * 不点「引用到本会议」本会议的引用包零变化。
     */
    async function loadRelated() {
      try {
        const assetIds = state.refs
          .map((ref) => String(ref?.assetId || '').trim())
          .filter(Boolean)
          .slice(0, 50);
        const terms = [...new Set(state.refs
          .map((ref) => String(ref?.title || '').trim())
          .filter(Boolean))]
          .slice(0, 20)
          .map((term) => term.slice(0, 60));
        const result = await callMeeting('meeting.refs.related', {
          docId: ctx.docId,
          ...(assetIds.length ? { assetIds } : {}),
          ...(terms.length ? { terms } : {}),
        });
        state.related = Array.isArray(result?.related) ? result.related : [];
        state.relatedError = '';
      } catch (error) {
        log?.warn('meeting related load failed', { error: error?.message || String(error) });
        state.related = [];
        state.relatedError = String(error?.code || '');
      }
    }

    async function loadAll() {
      await Promise.all([loadRefs(), loadConclusions(), loadActions()]);
      await loadRelated(); // 关联查询要等本会议引用清单（assetIds/terms 的来源）
      render();
    }

    // ── 渲染片段（全部 innerHTML 拼接共享原语的返回值；插值一律 escapeHtml）──
    function emptyHtml(message) {
      const html = typeof root.uiEmptyState === 'function'
        ? root.uiEmptyState({ kind: 'quiet', title: message })
        : '';
      return html || escapeHtml(message);
    }

    /** 「对比现状」按钮（共享 uiButton；原语缺失时不渲染，也不裸写 button）。 */
    function compareControlHtml(assetId) {
      if (typeof root.uiButton !== 'function') return '';
      return root.uiButton({
        label: t('kb.meetingRef.ref_compare', '对比现状'),
        role: 'ghost',
        size: 'sm',
        attrs: { 'data-act': 'meeting-ref-compare', 'data-mrf-id': assetId },
      });
    }

    /**
     * 冻结版 vs 现状对比区（T038）。stale 的呈现口径对齐 recall-projection-card：
     * 小字告知"引用仍按会议当时的冻结版"，不给"就地升到新版"——版本钉住是
     * 有意的，新版本要靠下次重新引用。
     */
    function refCompareHtml(version, currentVersion, stale) {
      const frozen = t('kb.meetingRef.ref_frozen', '冻结版 v{version}', { version });
      const current = t('kb.meetingRef.ref_current', '现状 v{version}', { version: currentVersion });
      const staleNote = stale
        ? `<small class="kb-mrf__ref-stale" data-mrf-ref-stale>${escapeHtml(t('kb.meetingRef.ref_stale', '资产已有新版本，引用仍按会议当时的冻结版'))}</small>`
        : '';
      return `<div class="kb-mrf__ref-compare" data-mrf-ref-compare>`
        + `<span data-mrf-ref-frozen>${escapeHtml(frozen)}</span>`
        + ` / `
        + `<span data-mrf-ref-current>${escapeHtml(current)}</span>`
        + `${staleNote}</div>`;
    }

    /** 资产引用行（refs 分区）：标题 · vN（冻结版）+ 缺失如实呈现（T039）。 */
    function refRowHtml(ref) {
      const id = String(ref?.assetId || '');
      const title = String(ref?.title || '').trim() || t('kb.meetingRef.ref_untitled', '（未命名资产）');
      const version = String(ref?.version || '');
      const currentVersion = String(ref?.currentVersion || '');
      const stale = ref?.stale === true;
      const available = ref?.available !== false;
      const parts = [
        `<div class="kb-mrf__ref${stale ? ' is-stale' : ''}" data-mrf-ref="${escapeHtml(id)}">`,
        '<div class="kb-mrf__ref-main">',
        `<span class="kb-mrf__ref-title" data-mrf-ref-title>${escapeHtml(title)} · v${escapeHtml(version)}</span>`,
      ];
      if (!available) {
        // T039：被引用版本已不存在——如实说明，不假装读到了那一版。
        parts.push(`<small class="kb-mrf__ref-missing" data-mrf-ref-missing>${escapeHtml(t('kb.meetingRef.ref_unavailable', '被引用版本已不存在'))}</small>`);
      }
      parts.push('</div>');
      // 现状未知（彻底删除 ⇒ currentVersion 为空）时无对比可言：只显示缺失说明。
      if (currentVersion) {
        parts.push(compareControlHtml(id));
        if (state.expanded[id]) parts.push(refCompareHtml(version, currentVersion, stale));
      }
      parts.push('</div>');
      return parts.join('');
    }

    /** 纪要条目里的资产引用：标题 · 冻结版 vN + （现状可查时）对比现状。 */
    function conclusionAssetHtml(asset) {
      const id = String(asset?.assetId || '');
      const title = String(asset?.title || '').trim() || t('kb.meetingRef.ref_untitled', '（未命名资产）');
      const version = String(asset?.version || '');
      let html = `<span class="kb-mrf__asset" data-mrf-conclusion-asset="${escapeHtml(id)}">${escapeHtml(title)} · v${escapeHtml(version)}</span>`;
      // 对比的"现状"取自引用包的读时派生视图（meeting.assets.list）；条目自己的
      // version 快照永远不回写（冻结版不变味）。
      const view = state.refs.find((r) => String(r?.assetId || '') === id);
      const currentVersion = view ? String(view.currentVersion || '') : '';
      const stale = !!(view && view.stale);
      if (currentVersion) {
        html += compareControlHtml(id);
        if (state.expanded[id]) html += refCompareHtml(version, currentVersion, stale);
      }
      return html;
    }

    /** 纪要条目（T038 双引用：转写锚点 + 资产引用，两处都不含正文）。 */
    function conclusionRowHtml(conclusion) {
      const id = String(conclusion?.id || '');
      const summary = String(conclusion?.summary || '');
      const anchors = Array.isArray(conclusion?.transcriptRefs) ? conclusion.transcriptRefs : [];
      const assets = Array.isArray(conclusion?.assetRefs) ? conclusion.assetRefs : [];
      const parts = [
        `<div class="kb-mrf__item" data-mrf-conclusion="${escapeHtml(id)}">`,
        `<div class="kb-mrf__item-summary" data-mrf-conclusion-summary>${escapeHtml(summary)}</div>`,
      ];
      if (conclusion?.unlinkable) {
        // 旧数据如实降级：条目照常可读，标"不可关联"（不报错、不猜位置）。
        parts.push(`<div class="kb-mrf__item-meta" data-mrf-conclusion-unlinkable>${escapeHtml(unlinkableText(conclusion.unlinkable))}</div>`);
      } else if (anchors.length) {
        parts.push(`<div class="kb-mrf__item-meta" data-mrf-conclusion-anchors>${anchors.map((a) => escapeHtml(anchorText(a))).join(' · ')}</div>`);
      }
      if (assets.length) {
        parts.push(`<div class="kb-mrf__item-assets" data-mrf-conclusion-assets>${assets.map((a) => conclusionAssetHtml(a)).join('')}</div>`);
      }
      parts.push('</div>');
      return parts.join('');
    }

    /** 草稿来源行（T043）：说话人 + 段落锚点；缺失如实标注，不编造。 */
    function sourceText(owner, anchor) {
      const who = String(owner?.speaker || '').trim();
      const where = anchor ? anchorText(anchor) : '';
      if (who && where) return t('kb.meetingRef.action_source', '来源：{who} · {where}', { who, where });
      if (who) return t('kb.meetingRef.action_source_speaker_only', '来源：{who}（段落锚点缺失）', { who });
      if (where) return t('kb.meetingRef.action_source_anchor_only', '来源：{where}', { where });
      return t('kb.meetingRef.action_source_missing', '来源：缺失（不猜说话人）');
    }

    /** 状态章（共享 uiTag；原语缺失时退化为纯文本 span，不是交互控件）。 */
    function statusTagHtml(status) {
      const label = status === 'confirmed'
        ? t('kb.meetingRef.action_status_confirmed', '已确认')
        : status === 'discarded'
          ? t('kb.meetingRef.action_status_discarded', '已丢弃')
          : t('kb.meetingRef.action_status_draft', '草稿');
      const variant = status === 'confirmed' ? 'success' : status === 'draft' ? 'accent' : 'outline';
      return typeof root.uiTag === 'function'
        ? root.uiTag({ label, variant })
        : `<span class="kb-mrf__tag">${escapeHtml(label)}</span>`;
    }

    /**
     * 三个动作（T043，仅 draft 态显示——状态机只允许 draft 迁移，重复动作在
     * features 被拒）。按钮名按语境复用既有三键（renderer-seams §3.3，不新造）：
     * 确认更新 = meeting.actions.confirm / 稍后处理 = 不动数据 / 拒绝 = discard。
     */
    function actionButtonsHtml(id) {
      if (typeof root.uiButton !== 'function') return '';
      return [
        root.uiButton({
          label: t('recall.asset_approval.confirm', '确认更新'),
          role: 'primary',
          size: 'sm',
          attrs: { 'data-act': 'meeting-action-confirm', 'data-mrf-id': id },
        }),
        root.uiButton({
          label: t('recall.asset_approval.defer', '稍后处理'),
          role: 'ghost',
          size: 'sm',
          attrs: { 'data-act': 'meeting-action-defer', 'data-mrf-id': id },
        }),
        root.uiButton({
          label: t('recall.asset_approval.reject', '拒绝'),
          role: 'ghost',
          size: 'sm',
          attrs: { 'data-act': 'meeting-action-discard', 'data-mrf-id': id },
        }),
      ].join('');
    }

    /** 命中方式章（T051，共享 uiTag；原语缺失退化为纯文本 span，非交互控件）。 */
    function matchedTagHtml(matchedBy) {
      const label = matchedBy === 'term'
        ? t('kb.meetingRef.related_match_term', '按术语命中')
        : t('kb.meetingRef.related_match_asset', '按资产命中');
      return typeof root.uiTag === 'function'
        ? root.uiTag({ label, variant: 'accent' })
        : `<span class="kb-mrf__tag">${escapeHtml(label)}</span>`;
    }

    /** 一条关联建议的唯一键（docId + conclusionId 定位「哪场会·哪条结论」）。 */
    function relatedKey(entry) {
      return `${String(entry?.docId || '')}::${String(entry?.conclusionId || '')}`;
    }

    /**
     * 关联建议行（T051）：哪场会（标题 + docId 尾段）/ 哪条结论（摘要）/
     * 相关资产标识（只有 id，契约 §1.5——不含资产正文）/ 命中方式章 +
     * 「引用到本会议」按钮（**点了才建立**；不点时引用包零变化）。
     */
    function relatedRowHtml(entry) {
      const key = relatedKey(entry);
      const summary = String(entry?.summary || '');
      const meetingTitle = String(entry?.title || '').trim()
        || (String(entry?.docId || '').split(/[\\/]/).filter(Boolean).pop() || String(entry?.docId || ''));
      const assetIds = (Array.isArray(entry?.assetIds) ? entry.assetIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      const meetingLine = t('kb.meetingRef.related_meeting', '会议：{title}', { title: meetingTitle });
      const assetsLine = assetIds.length
        ? t('kb.meetingRef.related_assets', '相关资产：{ids}', { ids: assetIds.join('、') })
        : '';
      const citeButton = typeof root.uiButton === 'function'
        ? root.uiButton({
          label: t('kb.meetingRef.related_cite', '引用到本会议'),
          role: 'primary',
          size: 'sm',
          attrs: { 'data-act': 'meeting-related-cite', 'data-mrf-id': key },
        })
        : '';
      const parts = [
        `<div class="kb-mrf__item" data-mrf-related="${escapeHtml(key)}">`,
        `<div class="kb-mrf__item-summary" data-mrf-related-summary>${escapeHtml(summary)}</div>`,
        `<div class="kb-mrf__item-meta" data-mrf-related-meeting>${escapeHtml(meetingLine)}</div>`,
      ];
      if (assetsLine) {
        parts.push(`<div class="kb-mrf__item-assets" data-mrf-related-assets>${escapeHtml(assetsLine)}</div>`);
      }
      parts.push(`<div class="kb-mrf__item-status" data-mrf-related-match>${matchedTagHtml(entry?.matchedBy)}</div>`);
      parts.push(`<div class="kb-mrf__item-actions" data-mrf-related-actions>${citeButton}</div>`);
      parts.push('</div>');
      return parts.join('');
    }

    /** 待办草稿行（T043）：来源 / 资产引用（冻结版）/ 状态章 / 三动作。 */
    function actionRowHtml(draft) {
      const id = String(draft?.id || '');
      const summary = String(draft?.summary || '');
      const status = draft?.status === 'confirmed' || draft?.status === 'discarded' ? draft.status : 'draft';
      const owner = draft?.owner || null;
      const anchor = (owner && owner.anchor)
        || (Array.isArray(draft?.transcriptRefs) && draft.transcriptRefs.length ? draft.transcriptRefs[0] : null);
      const assets = Array.isArray(draft?.assetRefs) ? draft.assetRefs : [];
      const parts = [
        `<div class="kb-mrf__item" data-mrf-action="${escapeHtml(id)}">`,
        `<div class="kb-mrf__item-summary" data-mrf-action-summary>${escapeHtml(summary)}</div>`,
        `<div class="kb-mrf__item-meta" data-mrf-action-source>${escapeHtml(sourceText(owner, anchor))}</div>`,
      ];
      if (assets.length) {
        const assetLines = assets.map((a) => {
          const title = String(a?.title || '').trim() || t('kb.meetingRef.ref_untitled', '（未命名资产）');
          return `<span class="kb-mrf__asset" data-mrf-action-asset="${escapeHtml(a?.assetId || '')}">${escapeHtml(title)} · v${escapeHtml(a?.version || '')}</span>`;
        });
        parts.push(`<div class="kb-mrf__item-assets" data-mrf-action-assets>${assetLines.join('')}</div>`);
      }
      parts.push(`<div class="kb-mrf__item-status" data-mrf-action-status data-status="${escapeHtml(status)}">${statusTagHtml(status)}</div>`);
      if (status === 'draft') {
        parts.push(`<div class="kb-mrf__item-actions" data-mrf-action-buttons>${actionButtonsHtml(id)}</div>`);
      }
      parts.push('</div>');
      return parts.join('');
    }

    /** 分区内容（{ html, empty }）：empty = 渲染的是一条 uiEmptyState（恰一处）。 */
    function sectionBody(key, text) {
      if (key === 'refs') {
        if (state.refsError) return { html: emptyHtml(errorText(state.refsError)), empty: true };
        if (!state.refs.length) return { html: emptyHtml(text.empty), empty: true };
        return { html: state.refs.map((ref) => refRowHtml(ref)).join(''), empty: false };
      }
      if (key === 'conclusions') {
        if (state.conclusionsError) return { html: emptyHtml(errorText(state.conclusionsError)), empty: true };
        if (!state.conclusions.length) return { html: emptyHtml(text.empty), empty: true };
        return { html: state.conclusions.map((c) => conclusionRowHtml(c)).join(''), empty: false };
      }
      if (key === 'actions') {
        if (state.actionsError) return { html: emptyHtml(errorText(state.actionsError)), empty: true };
        if (!state.actions.length) return { html: emptyHtml(text.empty), empty: true };
        return { html: state.actions.map((d) => actionRowHtml(d)).join(''), empty: false };
      }
      if (key === 'related') {
        if (state.relatedError) return { html: emptyHtml(errorText(state.relatedError)), empty: true };
        if (!state.related.length) return { html: emptyHtml(text.empty), empty: true };
        return { html: state.related.map((r) => relatedRowHtml(r)).join(''), empty: false };
      }
      // receipts（后续任务）：空态骨架，不提前造数据。
      return { html: emptyHtml(text.empty), empty: true };
    }

    function renderSections() {
      const host = q('[data-mrf-sections]');
      if (!host) return;
      host.textContent = '';
      for (const key of SECTION_KEYS) {
        const text = sectionText(key);
        const section = document.createElement('section');
        section.className = 'kb-mrf__section';
        section.dataset.mrfSection = key;
        const head = document.createElement('div');
        head.className = 'kb-mrf__section-title';
        head.textContent = text.title;
        const body = document.createElement('div');
        body.className = 'kb-mrf__section-body';
        const { html, empty } = sectionBody(key, text);
        if (empty) body.dataset.mrfEmpty = key;
        body.innerHTML = html;
        section.append(head, body);
        host.appendChild(section);
      }
    }

    function render() {
      // 逐段渲染：单个共享原语抛错不得拖垮整块面板（与 kb-transcript-correct 同款纪律）。
      for (const step of [renderHead, renderSections, renderStatus]) {
        try {
          step();
        } catch (error) {
          log?.warn('meeting refs render step failed', { step: step.name, error: error?.message || String(error) });
        }
      }
    }

    // ── 动作 ────────────────────────────────────────────────────────────
    async function toggleCompare(assetId) {
      state.expanded[assetId] = !state.expanded[assetId];
      // renderer-seams §3.2：「对比现状」挂 meeting.assets.list——点击时重读引用
      // 清单拿最新派生视图（失败不阻塞展开，用已加载的视图并留一条状态说明）。
      try {
        const result = await callMeeting('meeting.assets.list', { docId: ctx.docId });
        if (Array.isArray(result?.refs)) state.refs = result.refs;
        state.refsError = '';
      } catch (error) {
        log?.warn('meeting refs compare refresh failed', { error: error?.message || String(error) });
        setStatus(errorText(error?.code), 'warning');
      }
      render();
    }

    async function runAction(kind, draftId) {
      const channel = kind === 'confirm' ? 'meeting.actions.confirm' : 'meeting.actions.discard';
      try {
        await callMeeting(channel, { docId: ctx.docId, draftId });
        setStatus(kind === 'confirm'
          ? t('kb.meetingRef.action_confirm_done', '已确认该待办（默认落点为本地记录）')
          : t('kb.meetingRef.action_discard_done', '已丢弃该待办（条目保留可查）'), '');
        await loadActions();
      } catch (error) {
        log?.warn(`meeting action ${kind} failed`, { error: error?.message || String(error) });
        setStatus(errorText(error?.code), 'warning');
      }
      render();
    }

    function deferAction() {
      // 「稍后处理」= 不动数据：草稿保留可续办（T042 中断可续办的呈现面）。
      setStatus(t('kb.meetingRef.action_deferred_note', '已稍后处理：草稿保留，可随时回来确认'), '');
    }

    /**
     * 「引用到本会议」（T051）：**点击才建立**——把该条建议的相关资产挂到本
     * 会议（既有 `meeting.assets.attach`，准入/冻结版语义全在主进程），再把
     * 历史结论存为本会议的结论草稿（既有 `meeting.conclusions.save`；其
     * assetRefs 快照从本会议引用包取——所以先 attach 后 save）。**不新建写
     * 通道**；失败按码翻四语（部分成功时已建立的不回滚——引用是幂等可撤的）。
     */
    async function citeRelated(key) {
      const entry = state.related.find((r) => relatedKey(r) === key);
      if (!entry) return;
      const assetIds = (Array.isArray(entry.assetIds) ? entry.assetIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      try {
        for (const assetId of assetIds) {
          await callMeeting('meeting.assets.attach', { docId: ctx.docId, assetId, via: 'attach' });
        }
        await callMeeting('meeting.conclusions.save', {
          docId: ctx.docId,
          conclusion: {
            summary: String(entry.summary || ''),
            ...(assetIds.length ? { assetRefs: assetIds } : {}),
          },
        });
        setStatus(t('kb.meetingRef.related_cite_done', '已引用到本会议：挂载 {count} 项资产并保存结论草稿', { count: String(assetIds.length) }), '');
        await loadAll();
      } catch (error) {
        log?.warn('meeting related cite failed', { error: error?.message || String(error) });
        setStatus(errorText(error?.code), 'warning');
        render();
      }
    }

    function onClick(event) {
      const target = event && event.target;
      const holder = target && typeof target.closest === 'function' ? target.closest('[data-act]') : null;
      if (!holder || typeof holder.getAttribute !== 'function') return;
      const act = String(holder.getAttribute('data-act') || '');
      const id = String(holder.getAttribute('data-mrf-id') || '');
      if (act === 'meeting-ref-compare' && id) void toggleCompare(id);
      else if (act === 'meeting-action-confirm' && id) void runAction('confirm', id);
      else if (act === 'meeting-action-defer') deferAction();
      else if (act === 'meeting-action-discard' && id) void runAction('discard', id);
      else if (act === 'meeting-related-cite' && id) void citeRelated(id);
    }
    container.addEventListener('click', onClick);

    // 语言切换：面板自己持有 DOM，必须自响应 i18n-change（kb-i18n-keys 门禁要求）。
    const onI18nChange = () => { render(); };
    root.addEventListener('i18n-change', onI18nChange);

    render();
    const ready = loadAll();

    return {
      ready,
      destroy() {
        root.removeEventListener('i18n-change', onI18nChange);
        container.removeEventListener('click', onClick);
        container.textContent = '';
      },
    };
  }

  const api = {
    mount(container, ctx) {
      if (!container) throw new Error('kb meeting refs: container required');
      if (!root.cogseed || typeof root.cogseed.invoke !== 'function') {
        throw new Error('kb meeting refs: ipc unavailable');
      }
      if (typeof root.uiEmptyState !== 'function') {
        throw new Error('kb meeting refs: shared ui primitives unavailable');
      }
      const docId = String(ctx?.docId || '').trim();
      if (!docId) throw new Error('kb meeting refs: docId required');
      return createPanel(container, {
        docId,
        displayPath: String(ctx?.displayPath || ''),
      });
    },
  };

  root.KbMeetingRefs = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SECTION_KEYS };
  }
})(typeof window !== 'undefined' ? window : globalThis);
