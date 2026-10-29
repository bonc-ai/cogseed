/**
 * 转写词表管理页（方案 §七「词表管理」/§2.1-11 贡献包）——知识库里的一个模态面板。
 *
 * 为什么做成模态而不是新页面：转写纠错的宿主是知识库文件查看器（方案 §六
 * 的"宿主二选一"），词表管理必须从那里一步可达；新开一个顶层路由要动导航与
 * 路由表，收益不成比例。
 *
 * 职责边界：
 *   - 只调 `transcript.glossary.*` IPC；不直接读写文件、不改原文；
 *   - 列表支持 搜索 / 按 kind·riskLevel·status 过滤 / 批量暂停·启用·删除；
 *   - 导入导出都是**显式的用户动作**（导出 JSON 文本另存知识库；导入前先给出
 *     "会新增/会更新/会跳过"的预览，不静默覆盖）；
 *   - 人名类默认不导出（方案 §5.1 红线）。
 *
 * Renderer 约束：classic script、可见文案走 i18n、控件走共享原语
 * （uiModal/uiField/uiButton/uiEmptyState），图标来自 icons.js。
 */

(function initKbGlossaryManager(root) {
  'use strict';

  const log = typeof createLogger === 'function' ? createLogger('kb-glossary-manager') : null;

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

  /**
   * 请知识库视图重载目录树：词表导出走 `library.writeText` 直接落盘，
   * 而库列表（contexts.js / kb-workbench.js）渲染的是各自进入视图时的树快照，
   * 不显式通知就会出现"已另存：…"却列表里找不到文件（同一个真机问题）。
   */
  function notifyLibraryChanged() {
    try {
      if (typeof root.loadContexts === 'function') root.loadContexts();
      if (typeof root.renderKbWorkbench === 'function') root.renderKbWorkbench();
    } catch (error) {
      log?.warn('library refresh after export failed', { error: error?.message || String(error) });
    }
  }

  // ── 纯函数（可测）────────────────────────────────────────────────────
  const KINDS = ['product', 'people', 'org', 'term', 'venue', 'course', 'filler'];
  const RISKS = ['high', 'medium', 'low'];
  const STATUSES = ['active', 'paused'];

  /** 过滤：搜索（折叠子串）+ 三档筛选。空条件 = 不过滤。 */
  function filterEntries(entries, filter) {
    const f = filter || {};
    const needle = String(f.search || '').trim().toLowerCase();
    return (Array.isArray(entries) ? entries : []).filter((entry) => {
      if (f.kind && entry.kind !== f.kind) return false;
      if (f.riskLevel && entry.riskLevel !== f.riskLevel) return false;
      if (f.status && entry.status !== f.status) return false;
      if (needle) {
        const hay = `${entry.wrong || ''} ${entry.correct || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }

  /** 排序：最近维护在前，其次被确认次数多的在前（面板里也是这个口径）。 */
  function sortEntries(entries) {
    return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => {
      const at = Number(a?.updatedAt || 0);
      const bt = Number(b?.updatedAt || 0);
      if (bt !== at) return bt - at;
      const af = Number(a?.freq || 0);
      const bf = Number(b?.freq || 0);
      if (bf !== af) return bf - af;
      return String(a?.wrong || '').localeCompare(String(b?.wrong || ''));
    });
  }

  /**
   * 导入预览（纯函数）：把"导入后会发生什么"先算出来给人看。
   * 键 = 折叠后的 wrong|correct（与主进程 upsert 的同一性口径一致）。
   */
  function summarizeImport(current, incoming, mode) {
    const fold = (s) => String(s || '').normalize('NFKC').toLowerCase().trim();
    const keyOf = (e) => `${fold(e?.wrong)}|${fold(e?.correct)}`;
    const existing = new Set((current || []).map(keyOf));
    const list = (incoming || []).filter((e) => e && e.wrong && e.correct);
    // 「错词 = 正确写法」不会产生任何纠错，导入预览单独计数并默认跳过。
    const noEffect = list.filter((e) => fold(e.wrong) === fold(e.correct));
    const usable = list.filter((e) => fold(e.wrong) !== fold(e.correct));
    const added = usable.filter((e) => !existing.has(keyOf(e)));
    const updated = usable.filter((e) => existing.has(keyOf(e)));
    const invalid = (incoming || []).length - list.length;
    return {
      mode: mode === 'replace' ? 'replace' : 'merge',
      total: usable.length,
      added: added.length,
      updated: updated.length,
      invalid,
      noEffect: noEffect.length,
      /** replace 模式下"会被清掉的现有词条数"——这是破坏性操作，必须显式提示。 */
      replacedExisting: mode === 'replace' ? (current || []).length : 0,
    };
  }

  /** 角色标签（filler 在方案里是"口癖删除"类，展示要能分辨）。 */
  function kindKey(kind) {
    return KINDS.includes(kind) ? kind : 'term';
  }

  function riskKeyOf(level) {
    return RISKS.includes(level) ? level : 'low';
  }

  /** 错词与正确写法相同的条目不会产生任何替换，只增加列表噪音。 */
  function isNoEffect(entry) {
    return String(entry?.wrong || '') === String(entry?.correct || '');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatWhen(value) {
    if (!value) return '—';
    const ts = Number(value);
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    if (typeof root.formatTime === 'function') {
      try {
        const text = root.formatTime(new Date(ts).toISOString());
        if (text && text !== '-') return text;
      } catch (_) { /* 回退到下面 */ }
    }
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * 会议引用指标的呈现行（纯函数，specs/013 T057 / US-506）。
   *
   * 纪律（不变量「指标不编数字」）：每项比率**必须**带分子/分母与样本数，
   * 口径说明与数字一起呈现（不只裸数）；`rate === null`（无样本）如实显示
   * 「暂无样本」，不编 0%。数据形态 = `meeting.metrics.summary` 的
   * `MeetingMetricsSummary`（五口径 + notMeasurable）。
   */
  function meetingMetricsLines(summary) {
    if (!summary || typeof summary !== 'object') return [];
    const noSample = t('kb.glossary.meeting_metrics_no_sample', '暂无样本（不编数字）');
    const rateValue = (r) => (r && Number.isFinite(Number(r.numerator)) && Number(r.denominator) > 0 && r.rate !== null
      ? `${Number(r.numerator)}/${Number(r.denominator)} · ${t('kb.glossary.meeting_metrics_sample', '样本 {samples}', { samples: Number(r.samples) })}`
      : noSample);
    const lines = [
      t('kb.glossary.meeting_metrics_title', '会议引用指标（口径与数字一起给出）'),
      t('kb.glossary.meeting_metrics_runs', '会议场景扫描 {count} 次', { count: Number(summary.glossaryRuns) || 0 }),
      t('kb.glossary.meeting_metrics_adoption', '采纳率 {value}（口径：采纳 /（采纳+修改+拒绝+忽略）；稍后处理与引例项不计入）', { value: rateValue(summary.adoption) }),
      t('kb.glossary.meeting_metrics_mis_reference', '误引用率 {value}（口径：判为引用不当的条数 / 被引用资产数；未评判不算错）', { value: rateValue(summary.misReference) }),
      t('kb.glossary.meeting_metrics_token', '模型 token：输入 {input} · 输出 {output} · 样本 {samples}（绝对累计，不宣称因果）', {
        input: Number(summary.token?.inputTokens) || 0,
        output: Number(summary.token?.outputTokens) || 0,
        samples: Number(summary.token?.samples) || 0,
      }),
      t('kb.glossary.meeting_metrics_term_fixed', '术语改对率 {value}（口径：术语类采纳 / 术语类候选出现次数）', { value: rateValue(summary.entity?.termFixedRate) }),
      t('kb.glossary.meeting_metrics_over_correction', '过纠正率 {value}（口径：采纳后被回滚条数 / 采纳总数）', { value: rateValue(summary.entity?.overCorrectionRate) }),
    ];
    const notMeasurable = Array.isArray(summary.notMeasurable)
      ? summary.notMeasurable.filter((item) => typeof item === 'string' && item)
      : [];
    if (notMeasurable.length) {
      lines.push(t('kb.glossary.meeting_metrics_not_measurable', '会议侧测不了的指标（不编数字）：{list}', { list: notMeasurable.join('；') }));
    }
    return lines;
  }

  // ── 面板 ─────────────────────────────────────────────────────────────
  /**
   * 前置条件预检（纯函数，可单测）。
   *
   * 返回 null = 可以继续；否则返回一个必须展示给用户的原因。
   * 存在的意义：杜绝“点了没反应也不说为什么”。每一个拦截都必须带原因，
   * 否则用户无法区分“按钮坏了”和“前置条件没满足”。
   */
  function guardReason(action, snapshot) {
    const s = snapshot || {};
    switch (action) {
      case 'bulk-status':
        return s.selectedCount > 0
          ? null
          : { key: 'kb.glossary.select_required', fallback: '请先选择要操作的词条。' };
      case 'save-export':
        return s.hasExportText
          ? null
          : { key: 'kb.glossary.export_generate_required', fallback: '请先点「生成导出内容」，再另存。' };
      case 'apply-import':
        return s.hasImportPreview
          ? null
          : { key: 'kb.glossary.import_preview_required', fallback: '请先点「预览」确认新增/更新条数，再应用导入。' };
      default:
        return null;
    }
  }

  function open(options) {
    const opts = options || {};
    if (typeof root.uiModal !== 'function') throw new Error('kb glossary manager: uiModal unavailable');
    if (!root.cogseed || typeof root.cogseed.invoke !== 'function') throw new Error('kb glossary manager: ipc unavailable');

    const state = {
      entries: [],
      meta: { ownerNote: '', lastReconcileAt: 0 },
      filter: { search: '', kind: '', riskLevel: '', status: '' },
      selected: new Set(),
      busy: false,
      status: '',
      statusTone: '',
      queryRewrite: false,
      metrics: null,
      meetingMetrics: null,
      packReview: null,
      packScope: 'personal',
      healthOnly: false,
      exportText: '',
      exportIncludePeople: false,
      importText: '',
      importEntries: [],
      importMode: 'merge',
      importPreview: null,
    };

    const modal = root.uiModal({
      title: t('kb.glossary.title', '转写词表'),
      size: 'lg',
      closeLabel: t('kb.transcriptCorrect.close', '关闭'),
      bodyHtml: [
        '<div class="kb-glo">',
        '  <div class="kb-glo__header">',
        '    <div class="kb-glo__meta" data-glo-meta></div>',
        '    <div class="kb-glo__toolbar" data-glo-toolbar></div>',
        '  </div>',
        '  <div class="kb-glo__metrics" data-glo-metrics hidden></div>',
        '  <div class="kb-glo__health" data-glo-health hidden></div>',
        '  <div class="kb-glo__filters" data-glo-filters></div>',
        '  <p class="kb-glo__risk-legend" data-glo-risk-legend></p>',
        '  <div class="kb-glo__status" data-glo-status hidden></div>',
        '  <div class="kb-glo__bulk" data-glo-bulk></div>',
        '  <div class="kb-glo__list" data-glo-list></div>',
        '  <details class="kb-glo__io" data-glo-io hidden>',
        '    <summary data-glo-io-summary></summary>',
        '    <div class="kb-glo__io-body" data-glo-io-body></div>',
        '  </details>',
        '</div>',
      ].join(''),
    });

    const dialog = modal?.dialog;
    if (!dialog) return modal;
    const q = (selector) => dialog.querySelector(selector);

    function button(config) {
      return root.uiButton(config);
    }

    function setStatus(message, tone) {
      state.status = message || '';
      state.statusTone = tone || '';
      renderStatus();
    }

    function renderStatus() {
      const host = q('[data-glo-status]');
      if (!host) return;
      host.textContent = state.status;
      host.hidden = !state.status;
      host.dataset.tone = state.statusTone;
    }

    /**
     * 编辑一条词条（方案 §七人工维护入口）。
     *
     * 用户视角（2026-10-15 反馈）：「发现有个地方明显有问题，但其实不能改，
     * 那就等于说这个路径是不通的」。此前词表面板只能暂停/删除，改不了内容。
     *
     * 文案原则：不出现"身份""作用域""派生"这类内部词。风险等级由用户最终判断：
     * 编辑框里直接可选低/中/高，同时用一句人话说明三档各自的行为。
     */
    /** 打开任何浮层前先收掉上下文菜单，避免菜单压在弹窗/抽屉上。 */
    function closeFloatingMenu() {
      try { root.closeContextMenu?.(false); } catch { /* menu runtime is optional */ }
    }

    /** 详情抽屉：所有系统记账字段都收在这里，首屏列表不再平铺。 */
    function openDetail(entry) {
      closeFloatingMenu();
      if (typeof root.uiModal !== 'function') {
        setStatus(t('kb.glossary.unavailable', '词表管理暂不可用。'), 'warning');
        return;
      }
      const risk = riskKeyOf(entry.riskLevel);
      const riskNote = risk === 'high'
        ? t('kb.glossary.risk_note_high', '命中不自动改，需你确认')
        : risk === 'medium'
          ? t('kb.glossary.risk_note_medium', '命中先给候选再确认')
          : t('kb.glossary.risk_note_low', '命中可直接替换');
      const source = entry.source === 'ontology_seed'
        ? t('kb.glossary.source_value_ontology', '本体分组')
        : entry.source === 'import'
          ? t('kb.glossary.source_value_import', '导入')
          : entry.source === 'meeting_accept'
            ? t('kb.glossary.source_value_meeting', '会议确认')
            : t('kb.glossary.source_value_manual', '手工');
      const rows = [
        [t('kb.glossary.detail_risk', '风险'), `${t(`kb.transcriptCorrect.risk_${risk}`, risk)} · ${riskNote}`],
        [t('kb.glossary.detail_scope', '作用域'), entry.scope?.global === false
          ? t('kb.glossary.scope_value_limited', '受限')
          : t('kb.glossary.scope_value_global', '全局')],
        [t('kb.glossary.detail_source', '来源'), source],
        ...(Number(entry.freq || 0) > 0
          ? [[t('kb.glossary.detail_freq', '已确认'), t('kb.glossary.freq', '确认 {count} 次', { count: Number(entry.freq) })]]
          : []),
        [t('kb.glossary.detail_updated', '维护时间'), formatWhen(entry.updatedAt)],
        ...(Array.isArray(entry.contextAllow) && entry.contextAllow.length
          ? [[t('kb.glossary.detail_allow', '加白'), t('kb.glossary.allow_listed', '加白 {count} 个', { count: entry.contextAllow.length })]] : []),
        ...((entry.ignoredCount || 0) > 0
          ? [[t('kb.glossary.detail_ignored', '已忽略'), t('kb.glossary.ignored_times', '已忽略 {count} 次', { count: entry.ignoredCount })]] : []),
      ];
      if (isNoEffect(entry)) rows.push([t('kb.glossary.detail_status', '状态'), t('kb.glossary.no_effect_long', '无效果：错词和正确写法相同')]);
      const bodyHtml = [
        '<div class="kb-glo-detail">',
        `<div class="kb-glo__pair kb-glo-detail__pair"><span class="kb-atc__wrong">${escapeHtml(entry.wrong)}</span><span class="kb-atc__arrow">→</span><span class="kb-atc__correct">${escapeHtml(entry.correct)}</span></div>`,
        `<p class="kb-glo-detail__sub">${escapeHtml(t(`kb.transcriptCorrect.kind_${kindKey(entry.kind)}`, kindKey(entry.kind)))} · ${escapeHtml(entry.status === 'paused' ? t('kb.glossary.status_paused', '已暂停') : t('kb.glossary.status_active', '启用中'))}</p>`,
        '<dl class="kb-glo-detail__list">',
        ...rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`),
        '</dl>',
        `<p class="ui-field__hint">${escapeHtml(t('kb.glossary.detail_risk_hint', '风险可以按你的判断调整：低=命中直接改，中=先给候选，高=每次确认。'))}</p>`,
        '</div>',
      ].join('');
      const modal = root.uiModal({
        title: t('kb.glossary.detail_title', '词条详情'),
        size: 'md',
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        bodyHtml,
      });
    }

    /** 新增词条：默认个人全局（以后所有转写生效），作用域留在高级里。 */
    function openAdd() {
      closeFloatingMenu();
      if (typeof root.uiFormModal !== 'function') {
        setStatus(t('kb.glossary.unavailable', '词表管理暂不可用。'), 'warning');
        return;
      }
      const ids = { wrong: 'glo-add-wrong', correct: 'glo-add-correct', kind: 'glo-add-kind', risk: 'glo-add-risk' };
      const bodyHtml = root.uiForm({
        columns: 1,
        fields: [
          {
            wide: true,
            html: root.uiField({
              id: ids.wrong,
              label: t('kb.glossary.add_wrong', '错词'),
              showRequirement: false,
              control: { kind: 'input', value: '', placeholder: t('kb.glossary.add_wrong_placeholder', '转写里被写错的词') },
            }),
          },
          {
            wide: true,
            html: root.uiField({
              id: ids.correct,
              label: t('kb.glossary.add_correct', '正确写法'),
              showRequirement: false,
              control: { kind: 'input', value: '', placeholder: t('kb.glossary.add_correct_placeholder', '应该写成什么') },
            }),
          },
          {
            wide: true,
            html: root.uiField({
              id: ids.kind,
              label: t('kb.glossary.add_kind', '类别'),
              showRequirement: false,
              control: {
                kind: 'select', value: 'term',
                options: KINDS.map((k) => ({ value: k, label: t(`kb.transcriptCorrect.kind_${k}`, k) })),
              },
            }),
          },
          {
            wide: true,
            html: root.uiField({
              id: ids.risk,
              label: t('kb.glossary.risk', '风险'),
              hint: t('kb.glossary.risk_edit_hint', '低：命中直接改；中：先给候选；高：每次确认。按你的判断选。'),
              showRequirement: false,
              control: {
                kind: 'select', value: 'medium',
                options: RISKS.map((risk) => ({ value: risk, label: t(`kb.transcriptCorrect.risk_${risk}`, risk) })),
              },
            }),
          },
          {
            wide: true,
            html: `<p class="ui-field__hint">${t('kb.glossary.add_scope_hint', '保存后默认对所有转写生效；只想对某一次转写生效，请在该次纠错面板里加入。')}</p>`,
          },
        ],
      });
      const modal = root.uiFormModal({
        title: t('kb.glossary.add_title', '添加词条'),
        size: 'md',
        bodyHtml,
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        cancelLabel: t('common.cancel', '取消'),
        submitLabel: t('kb.glossary.add_save', '保存'),
        busyLabel: t('kb.glossary.add_saving', '保存中…'),
        initialFocus: `#${ids.wrong}`,
        feedbackAttrs: { 'data-glo-add-feedback': 'true' },
        onSubmit: async () => {
          const read = (id) => modal.dialog.querySelector(`#${id}`);
          const wrong = String(read(ids.wrong)?.value || '').trim();
          const correct = String(read(ids.correct)?.value || '').trim();
          const kindHost = read(ids.kind);
          const kind = String(kindHost?._uiSelectApi?.getValue?.() || kindHost?.value || 'term');
          const riskHost = read(ids.risk);
          const riskLevel = String(riskHost?._uiSelectApi?.getValue?.() || riskHost?.value || 'medium');
          if (!wrong || !correct) {
            modal.setFeedback(t('kb.glossary.add_need_both', '错词和正确写法都要填。'));
            return;
          }
          if (wrong === correct) {
            modal.setFeedback(t('kb.glossary.add_no_effect', '错词和正确写法相同，不会产生纠错效果。'));
            return;
          }
          modal.setBusy(true);
          try {
            const result = await root.cogseed.invoke('transcript.glossary.upsert', { wrong, correct, kind, riskLevel, riskOverride: true });
            if (result?.skippedReason) {
              modal.setBusy(false);
              modal.setFeedback(t('kb.glossary.add_rejected', '这条不能加入词表：{reason}', { reason: result.skippedReason }));
              return;
            }
            modal.close('saved');
            setStatus(t('kb.glossary.add_saved', '已添加：{wrong} → {correct}', { wrong, correct }), '');
            await reload();
            opts.onChanged?.();
          } catch (error) {
            log?.warn('glossary add failed', { error: error?.message || String(error) });
            modal.setBusy(false);
            modal.setFeedback(t('kb.glossary.add_failed', '保存失败，请稍后重试。'));
          }
        },
      });
      try {
        if (typeof root.hydrateUiFormSelects === 'function') root.hydrateUiFormSelects(modal.dialog, {});
      } catch (error) {
        log?.warn('glossary add selects hydrate failed', { error: error?.message || String(error) });
      }
      return modal;
    }

    function openEdit(entry) {
      closeFloatingMenu();
      const fieldIds = { wrong: 'glo-edit-wrong', correct: 'glo-edit-correct', kind: 'glo-edit-kind', risk: 'glo-edit-risk' };
      const riskLabel = entry.status === 'paused'
        ? t('kb.glossary.status_paused', '已暂停')
        : t(`kb.transcriptCorrect.risk_${riskKeyOf(entry.riskLevel)}`, riskKeyOf(entry.riskLevel));
      const riskNote = t('kb.glossary.edit_risk_note', '当前风险：{risk}。你可以按自己的判断调整：低=命中直接改，中=先给候选，高=每次确认。', { risk: riskLabel });

      const bodyHtml = root.uiForm({
        fields: [
          {
            wide: true,
            html: root.uiField({
              id: fieldIds.wrong,
              label: t('kb.glossary.edit_wrong', '转写里出现的错词'),
              hint: t('kb.glossary.edit_intro', '左边是转写里出现的错词，右边是应该改成的写法。改完保存即可。'),
              showRequirement: false,
              control: { kind: 'input', value: entry.wrong, attrs: { maxlength: '80' } },
            }),
          },
          {
            wide: true,
            html: root.uiField({
              id: fieldIds.correct,
              label: t('kb.glossary.edit_correct', '正确写法'),
              showRequirement: false,
              control: { kind: 'input', value: entry.action === 'delete' ? '' : entry.correct, attrs: { maxlength: '200' } },
            }),
          },
          {
            wide: true,
            html: root.uiField({
              id: fieldIds.kind,
              label: t('kb.glossary.edit_kind', '类别（只影响分组与排序）'),
              showRequirement: false,
              control: {
                kind: 'select',
                value: kindKey(entry.kind),
                options: KINDS.map((k) => ({
                  value: k,
                  label: t(`kb.transcriptCorrect.kind_${k}`, k),
                })),
              },
            }),
          },
          {
            wide: true,
            html: root.uiField({
              id: fieldIds.risk,
              label: t('kb.glossary.risk', '风险'),
              hint: riskNote,
              showRequirement: false,
              control: {
                kind: 'select',
                value: riskKeyOf(entry.riskLevel),
                options: RISKS.map((risk) => ({ value: risk, label: t(`kb.transcriptCorrect.risk_${risk}`, risk) })),
              },
            }),
          },
        ],
      });

      const editModal = root.uiFormModal({
        title: t('kb.glossary.edit_title', '编辑词条'),
        size: 'md',
        bodyHtml,
        // uiModal 的可关闭模态**必须**给本地化 closeLabel，否则构造直接抛
        // `uiModal requires a localized closeLabel when dismissible`。
        // 此前漏了它，异常又被事件处理器吞掉，用户看到的就是"点了没反应"
        // （2026-10-15 实测日志：open glossary edit failed）。诊断兜底见 onClick。
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        cancelLabel: t('common.cancel', '取消'),
        submitLabel: t('kb.glossary.edit_save', '保存'),
        busyLabel: t('kb.glossary.edit_saving', '保存中…'),
        initialFocus: `#${fieldIds.wrong}`,
        feedbackAttrs: { 'data-glo-edit-feedback': 'true' },
        onSubmit: async () => {
          const read = (id) => editModal.dialog.querySelector(`#${id}`);
          const kindHost = read(fieldIds.kind);
          const wrong = String(read(fieldIds.wrong)?.value || '').trim();
          const correct = String(read(fieldIds.correct)?.value || '').trim();
          const kind = String(kindHost?._uiSelectApi?.getValue?.() || kindKey(entry.kind));
          const riskHost = read(fieldIds.risk);
          const riskLevel = String(riskHost?._uiSelectApi?.getValue?.() || riskKeyOf(entry.riskLevel));
          if (!wrong || !correct) {
            editModal.setFeedback(t('kb.glossary.edit_need_both', '错词和正确写法都要填。如果这条是「见到就删」的规则，请改用列表里的删除。'));
            return;
          }
          editModal.setBusy(true);
          try {
            const result = await root.cogseed.invoke('transcript.glossary.update', {
              id: entry.id, wrong, correct, kind, riskLevel,
            });
            if (!result?.ok) {
              editModal.setBusy(false);
              editModal.setFeedback(editFailureText(result?.reason));
              return;
            }
            editModal.close('saved');
            setStatus(t('kb.glossary.edit_saved', '已保存：{wrong} → {correct}', { wrong, correct }), '');
            await reload();
          } catch (error) {
            log?.warn('glossary update failed', { error: error?.message || String(error) });
            editModal.setBusy(false);
            editModal.setFeedback(t('kb.glossary.edit_failed', '保存失败，请稍后重试。'));
          }
        },
      });
      try {
        if (typeof root.hydrateUiFormSelects === 'function') root.hydrateUiFormSelects(editModal.dialog, {});
      } catch (error) {
        log?.warn('glossary edit selects hydrate failed', { error: error?.message || String(error) });
      }
      return editModal;
    }

    /** 把主进程的失败原因翻成人话（主进程不拼用户文案）。 */
    function editFailureText(reason) {
      if (reason === 'pure_digit_variant') {
        return t('kb.glossary.edit_reject_digits', '纯数字不能作为错词：会被当成真实的学号、分数或金额，误伤正常内容。');
      }
      if (reason === 'duplicate') {
        return t('kb.glossary.edit_duplicate', '已经有一条完全一样的词条了。请先删掉旧的那条，或改成别的写法。');
      }
      if (reason === 'not_found') {
        return t('kb.glossary.edit_missing', '这条词条已经不存在了（可能在别处被删掉）。关闭后刷新列表即可。');
      }
      if (reason === 'invalid_risk') {
        return t('kb.glossary.edit_invalid_risk', '风险等级不是有效值，请重新选择。');
      }
      if (reason === 'empty') {
        return t('kb.glossary.edit_need_both', '错词和正确写法都要填。如果这条是「见到就删」的规则，请改用列表里的删除。');
      }
      return t('kb.glossary.edit_failed', '保存失败，请稍后重试。');
    }

    /** 本地埋点汇总（方案 §8.2）：确认耗时中位数 / 保留率分布 / 词表里程碑。 */
    async function loadMetrics() {
      try {
        const result = await root.cogseed.invoke('transcript.metrics.summary', {});
        state.metrics = result?.summary ?? null;
      } catch (error) {
        log?.warn('metrics summary failed', { error: error?.message || String(error) });
        state.metrics = null;
      }
    }

    /**
     * 指标区（方案 §8.2 本地埋点）。
     *
     * **首屏只放一句人话状态，全部口径细节收进可展开区。**
     *
     * 为什么改（2026-10-15 反馈「上面那几行字还是没有去掉」）：原实现把
     * `已记录 0 次清理 · 确认耗时：暂无样本 · 保留率分布：… · 词表 44 条（里程碑 ≥20：已达成）`
     * 外加一整条「测不了的指标（不编数字）：…」**全部平铺在面板顶部**。
     * 那段文字本来是"不编数字"的诚实声明，但对用户是**诊断口径**，不是他要的信息——
     * 打开词表的人想知道的是"我的词表有多少条、能不能用"，不是校准指标怎么算。
     *
     * 依据 Nielsen Norman Group 的渐进式披露（Progressive Disclosure）：
     *   1. 首屏只放最常用的少数信息，次要信息按需展开；
     *   2. 展开入口要显眼，且标签要能预告里面是什么。
     * 所以这里保留一句状态 + 一个写明内容的「查看指标口径」开关，
     * **不删除任何测量透明度**——点开就能看到原来那两行。
     */
    function renderMetrics() {
      const host = q('[data-glo-metrics]');
      if (!host) return;
      const m = state.metrics;
      host.textContent = '';
      if (!m || Number(m.runs || 0) <= 0) { host.hidden = true; return; }
      host.hidden = false;

      const details = [
        t('kb.glossary.metrics_runs', '已记录 {count} 次清理', { count: m.runs }),
        m.confirmLatency.median === null
          ? t('kb.glossary.metrics_no_latency', '确认耗时：暂无样本')
          : t('kb.glossary.metrics_latency', '确认耗时中位数 {seconds}s（目标 <{target}s：{verdict}）', {
            seconds: (m.confirmLatency.median / 1000).toFixed(1),
            target: (m.confirmLatency.targetMs / 1000).toFixed(0),
            verdict: m.confirmLatency.withinTarget ? t('kb.glossary.metrics_ok', '达标') : t('kb.glossary.metrics_over', '偏慢'),
          }),
        t('kb.glossary.metrics_retention', '保留率分布：区间内 {inRange} · 低于 55% {below} · 高于 85% {above}', {
          inRange: m.retention.inRange, below: m.retention.belowRange, above: m.retention.aboveRange,
        }),
        t('kb.glossary.metrics_glossary', '词表 {entries} 条（里程碑 ≥{milestone}：{verdict}）', {
          entries: m.glossary.entries, milestone: m.glossary.milestone,
          verdict: m.glossary.reached ? t('kb.glossary.metrics_reached', '已达成') : t('kb.glossary.metrics_not_reached', '未达成'),
        }),
      ];

      // 首屏：一句用户看得懂的状态。
      const summary = document.createElement('div');
      summary.className = 'kb-glo__metrics-summary';
      summary.textContent = t('kb.glossary.metrics_status_active', '词表已参与 {count} 次会议的转写纠错。', { count: m.runs });
      host.appendChild(summary);

      const fold = document.createElement('details');
      fold.className = 'kb-glo__metrics-more';
      const label = t('kb.glossary.metrics_details', '查看指标口径');
      fold.innerHTML = `<summary>${label}</summary>`
        + `<p class="kb-glo__metrics-line">${details.join(' · ')}</p>`
        + `<p class="kb-glo__metrics-line">${t('kb.glossary.metrics_not_measurable', '测不了的指标（不编数字）：{list}', { list: (m.notMeasurable || []).join('；') })}</p>`;
      host.appendChild(fold);
    }

    /**
     * 会议引用指标（specs/013 T057 / US-506）：**独立通道独立数据源**
     * （meeting-metrics.jsonl），与既有 transcript 指标分两区呈现（D16）。
     * 通道失败 ⇒ 置 null（分区不渲染，不编数字、不弹错误框）。
     */
    async function loadMeetingMetrics() {
      try {
        const result = await root.cogseed.invoke('meeting.metrics.summary', {});
        state.meetingMetrics = result?.summary ?? null;
      } catch (error) {
        log?.warn('meeting metrics summary failed', { error: error?.message || String(error) });
        state.meetingMetrics = null;
      }
    }

    /**
     * 「会议引用」指标分区：挂在既有指标区（data-glo-metrics）末尾的追加节点。
     * 只重建自己的节点（`data-glo-meeting` 锚点）。
     *
     * **并进同一个折叠区**（2026-10-15）：这段会议引用口径本身也很长，若平铺在
     * 首屏，`renderMetrics` 刚折起来的诊断文字会由它原样补回来 —— 用户看到的
     * 还是"上面那几行字"。两段同属"口径说明"，共用一个 `查看指标口径` 入口，
     * 符合渐进式披露"不要多个并列的展开入口"（NN/g）。
     */
    function renderMeetingMetrics() {
      const host = q('[data-glo-metrics]');
      if (!host) return;
      // 先摘自己上一次的节点（真 DOM 下 children 是 HTMLCollection，须按锚点查）。
      if (typeof host.querySelectorAll === 'function') {
        for (const node of Array.from(host.querySelectorAll('[data-glo-meeting="metrics"]'))) {
          try { node.remove(); } catch (_) { /* 非节点形态忽略 */ }
        }
      }
      // 转写指标还没有样本时，会议引用口径也不占首屏；等有真实纠错记录再一起折叠展示。
      if (!state.metrics || Number(state.metrics.runs || 0) <= 0) return;
      const lines = meetingMetricsLines(state.meetingMetrics);
      if (!lines.length) return;
      const block = document.createElement('p');
      block.className = 'kb-glo__metrics-line';
      block.dataset.gloMeeting = 'metrics';
      block.textContent = lines.join(' · ');
      // 有折叠区就挂进去（与转写口径同处），否则退回直接挂指标区。
      const fold = host.querySelector('.kb-glo__metrics-more');
      (fold || host).appendChild(block);
    }

    function renderMeta() {
      const host = q('[data-glo-meta]');
      if (!host) return;
      // 首屏只保留条数。owner/维护时间是内部记账，移动到设置/详情。
      host.textContent = t('kb.glossary.count', '共 {count} 条', { count: state.entries.length });
    }

    function renderMetrics() {
      const host = q('[data-glo-metrics]');
      if (!host) return;
      const m = state.metrics;
      host.textContent = '';
      // 没有可统计的纠错记录时不占用首屏；空话不是空状态。
      if (!m || Number(m.runs || 0) <= 0) return;

      const details = [
        t('kb.glossary.metrics_runs', '已记录 {count} 次清理', { count: m.runs }),
        m.confirmLatency.median === null
          ? t('kb.glossary.metrics_no_latency', '确认耗时：暂无样本')
          : t('kb.glossary.metrics_latency', '确认耗时中位数 {seconds}s（目标 <{target}s：{verdict}）', {
            seconds: (m.confirmLatency.median / 1000).toFixed(1),
            target: (m.confirmLatency.targetMs / 1000).toFixed(0),
            verdict: m.confirmLatency.withinTarget ? t('kb.glossary.metrics_ok', '达标') : t('kb.glossary.metrics_over', '偏慢'),
          }),
        t('kb.glossary.metrics_retention', '保留率分布：区间内 {inRange} · 低于 55% {below} · 高于 85% {above}', {
          inRange: m.retention.inRange, below: m.retention.belowRange, above: m.retention.aboveRange,
        }),
        t('kb.glossary.metrics_glossary', '词表 {entries} 条（里程碑 ≥{milestone}：{verdict}）', {
          entries: m.glossary.entries, milestone: m.glossary.milestone,
          verdict: m.glossary.reached ? t('kb.glossary.metrics_reached', '已达成') : t('kb.glossary.metrics_not_reached', '未达成'),
        }),
      ];

      const summary = document.createElement('div');
      summary.className = 'kb-glo__metrics-summary';
      summary.textContent = t('kb.glossary.metrics_status_active', '词表已参与 {count} 次会议的转写纠错。', { count: m.runs });
      host.appendChild(summary);

      const fold = document.createElement('details');
      fold.className = 'kb-glo__metrics-more';
      const label = t('kb.glossary.metrics_details', '查看指标口径');
      fold.innerHTML = `<summary>${label}</summary>`
        + `<p class="kb-glo__metrics-line">${details.join(' · ')}</p>`
        + `<p class="kb-glo__metrics-line">${t('kb.glossary.metrics_not_measurable', '测不了的指标（不编数字）：{list}', { list: (m.notMeasurable || []).join('；') })}</p>`;
      host.appendChild(fold);
    }

    /** 首屏数据体检：只提示真正会影响纠错的“无效果”条目，不做静默删除。 */
    function renderHealth() {
      const host = q('[data-glo-health]');
      if (!host) return;
      const count = state.entries.filter(isNoEffect).length;
      if (!count) { host.hidden = true; host.textContent = ''; return; }
      host.hidden = false;
      host.innerHTML = `<div class="kb-glo__health-text">${t('kb.glossary.health_no_effect', '有 {count} 条「错词 = 正确写法」，不会产生纠错效果。', { count })}</div>`
        + '<div class="kb-glo__health-actions">'
        + button({
          label: state.healthOnly
            ? t('kb.glossary.health_show_all', '看全部')
            : t('kb.glossary.health_show', '只看这些'),
          role: 'ghost', size: 'sm',
          attrs: { 'data-glo-action': 'health-toggle' },
        })
        + button({
          label: t('kb.glossary.health_clean', '清理这些'),
          role: 'danger', size: 'sm',
          attrs: { 'data-glo-action': 'health-clean' },
        })
        + '</div>';
    }

    function renderFilters() {
      const host = q('[data-glo-filters]');
      if (!host) return;
      if (typeof root.uiField !== 'function') return;
      const kindOptions = [''].concat(KINDS).map((kind) => ({
        value: kind,
        label: kind
          ? t(`kb.transcriptCorrect.kind_${kind}`, kind)
          : t('kb.glossary.all_kinds', '全部类别'),
      }));
      const riskOptions = [''].concat(RISKS).map((risk) => ({
        value: risk,
        label: risk ? t(`kb.transcriptCorrect.risk_${risk}`, risk) : t('kb.glossary.all_risks', '全部风险'),
      }));
      const statusOptions = [''].concat(STATUSES).map((status) => ({
        value: status,
        label: status === 'active'
          ? t('kb.glossary.status_active', '启用中')
          : status === 'paused'
            ? t('kb.glossary.status_paused', '已暂停')
            : t('kb.glossary.all_status', '全部状态'),
      }));
      try {
        host.innerHTML = [
          root.uiField({
            id: 'glo-search',
            label: t('kb.glossary.search', '搜索'),
            showRequirement: false,
            control: { kind: 'input', value: state.filter.search, placeholder: t('kb.glossary.search_placeholder', '错词或正确写法') },
          }),
          root.uiField({
            id: 'glo-kind',
            label: t('kb.glossary.kind', '类别'),
            showRequirement: false,
            control: { kind: 'select', value: state.filter.kind, options: kindOptions },
          }),
          root.uiField({
            id: 'glo-risk',
            label: t('kb.glossary.risk', '风险'),
            showRequirement: false,
            control: { kind: 'select', value: state.filter.riskLevel, options: riskOptions },
          }),
          root.uiField({
            id: 'glo-status',
            label: t('kb.glossary.status', '状态'),
            showRequirement: false,
            control: { kind: 'select', value: state.filter.status, options: statusOptions },
          }),
        ].join('');
        if (typeof root.hydrateUiFormSelects === 'function') {
          root.hydrateUiFormSelects(host, {
            'glo-kind': (value) => applyFilter('kind', value),
            'glo-risk': (value) => applyFilter('riskLevel', value),
            'glo-status': (value) => applyFilter('status', value),
          });
        }
      } catch (error) {
        log?.warn('glossary filters render failed', { error: error?.message || String(error) });
      }
    }

    function visibleEntries() {
      const rows = sortEntries(filterEntries(state.entries, state.filter));
      return state.healthOnly ? rows.filter(isNoEffect) : rows;
    }

    function renderToolbar() {
      const host = q('[data-glo-toolbar]');
      if (!host) return;
      const more = typeof root.uiIconButton === 'function'
        ? root.uiIconButton({
          label: t('kb.glossary.more', '更多操作'),
          icon: 'more-horizontal',
          className: 'kb-glo__more',
          attrs: { 'data-glo-action': 'more' },
        })
        : '';
      host.innerHTML = [
        button({
          label: t('kb.glossary.add', '添加词条'),
          role: 'primary', size: 'sm',
          attrs: { 'data-glo-action': 'add' },
        }),
        button({
          label: t('kb.glossary.import_action', '导入'),
          role: 'secondary', size: 'sm',
          attrs: { 'data-glo-action': 'open-io' },
        }),
        more,
      ].join('');
    }

    function renderRiskLegend() {
      const host = q('[data-glo-risk-legend]');
      if (!host) return;
      host.textContent = t('kb.glossary.risk_legend', '风险：低 = 命中直接改 · 中 = 先给候选 · 高 = 每次确认。可以点「编辑」按自己的判断调整。');
    }

    function renderBulk() {
      const host = q('[data-glo-bulk]');
      if (!host) return;
      const count = state.selected.size;
      // 未选中时不给批量按钮，也不给常驻说明；选中后才出现动作条。
      if (count === 0) { host.innerHTML = ''; host.hidden = true; return; }
      host.hidden = false;
      const rows = visibleEntries();
      host.innerHTML = [
        `<span class="kb-glo__bulk-count">${t('kb.glossary.bulk_selected', '已选 {count} 条', { count })}</span>`,
        button({
          label: t('kb.glossary.select_all', '全选（{count}）', { count: rows.length }),
          role: 'ghost', size: 'sm', disabled: state.busy || rows.length === 0,
          attrs: { 'data-glo-action': 'select-all' },
        }),
        button({
          label: t('kb.glossary.pause_selected_short', '暂停'),
          role: 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-action': 'pause-selected' },
        }),
        button({
          label: t('kb.glossary.resume_selected_short', '启用'),
          role: 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-action': 'resume-selected' },
        }),
        button({
          label: t('kb.glossary.clear_selection_short', '取消选择'),
          role: 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-action': 'clear-selection' },
        }),
      ].join('');
    }

    function rowElement(entry) {
      const el = document.createElement('div');
      el.className = 'kb-glo__row';
      el.dataset.gloRow = entry.id;
      el.dataset.risk = riskKeyOf(entry.riskLevel);
      if (entry.status === 'paused') el.dataset.paused = '1';
      if (state.selected.has(entry.id)) el.classList.add('is-selected');

      const main = document.createElement('div');
      main.className = 'kb-glo__row-main';
      const pair = document.createElement('div');
      pair.className = 'kb-glo__pair';
      const wrong = document.createElement('span');
      wrong.className = 'kb-atc__wrong';
      wrong.textContent = entry.wrong;
      const arrow = document.createElement('span');
      arrow.className = 'kb-atc__arrow';
      arrow.textContent = entry.action === 'delete' ? t('kb.transcriptCorrect.delete_arrow', '（删除）') : '→';
      const correct = document.createElement('span');
      correct.className = 'kb-atc__correct';
      correct.textContent = entry.action === 'delete' ? '' : entry.correct;
      pair.append(wrong, arrow, correct);

      const meta = document.createElement('div');
      meta.className = 'kb-glo__row-meta';
      const kindLabel = t(`kb.transcriptCorrect.kind_${kindKey(entry.kind)}`, kindKey(entry.kind));
      const risk = riskKeyOf(entry.riskLevel);
      const bits = [kindLabel];
      // 低风险是默认路径，不占视觉；中/高才提示“这次不会直接改”。
      if (risk !== 'low') {
        bits.push(t('kb.glossary.risk_badge', '{risk}，需确认', { risk: t(`kb.transcriptCorrect.risk_${risk}`, risk) }));
      }
      if (entry.status === 'paused') bits.push(t('kb.glossary.status_paused', '已暂停'));
      if (entry.scope?.global === false) bits.push(t('kb.glossary.scope_value_limited', '受限'));
      if (isNoEffect(entry)) bits.push(t('kb.glossary.no_effect', '无效果'));
      meta.textContent = bits.join(' · ');
      main.append(pair, meta);

      const select = document.createElement('label');
      select.className = 'kb-glo__select';
      if (typeof root.uiCheckbox === 'function') {
        select.innerHTML = root.uiCheckbox({
          id: `glo-sel-${entry.id}`,
          label: t('kb.glossary.select', '选择'),
          checked: state.selected.has(entry.id),
          className: 'kb-glo__checkbox',
          attrs: { 'data-glo-select': entry.id },
        });
      }

      const actions = document.createElement('div');
      actions.className = 'kb-glo__row-actions';
      if (typeof root.uiIconButton === 'function') {
        actions.innerHTML = root.uiIconButton({
          label: t('kb.glossary.row_menu', '更多操作'),
          icon: 'more-horizontal',
          className: 'kb-glo__row-menu',
          attrs: { 'data-glo-menu': entry.id },
        });
      }

      el.append(select, main, actions);
      return el;
    }


    function renderList() {
      const host = q('[data-glo-list]');
      if (!host) return;
      host.textContent = '';
      const rows = visibleEntries();
      if (rows.length === 0) {
        if (state.entries.length === 0) {
          const wrap = document.createElement('div');
          wrap.className = 'kb-glo__empty';
          wrap.innerHTML = [
            `<h3 class="kb-glo__empty-title">${t('kb.glossary.empty_title', '还没有纠错词表')}</h3>`,
            `<p class="kb-glo__empty-hint">${t('kb.glossary.empty_hint', '导入现有词表，或先添加一条经常被转错的词。')}</p>`,
            '<div class="kb-glo__empty-actions">',
            button({
              label: t('kb.glossary.add', '添加词条'),
              role: 'primary', size: 'sm',
              attrs: { 'data-glo-action': 'add' },
            }),
            button({
              label: t('kb.glossary.import_action', '导入'),
              role: 'secondary', size: 'sm',
              attrs: { 'data-glo-action': 'open-io' },
            }),
            '</div>',
          ].join('');
          host.appendChild(wrap);
          return;
        }
        const empty = typeof root.uiEmptyState === 'function'
          ? root.uiEmptyState({
            kind: 'quiet',
            title: t('kb.glossary.no_match', '没有符合条件的词条'),
          })
          : '';
        host.innerHTML = empty;
        if (!empty) host.textContent = t('kb.glossary.no_match', '没有符合条件的词条');
        return;
      }
      for (const entry of rows.slice(0, 300)) host.appendChild(rowElement(entry));
    }

    function renderIo() {
      const host = q('[data-glo-io-body]');
      const summary = q('[data-glo-io-summary]');
      if (summary) summary.textContent = t('kb.glossary.io', '导入 / 导出');
      if (!host) return;
      if (typeof root.uiField !== 'function') return;
      const preview = state.importPreview;
      try {
        host.innerHTML = [
          '<div class="kb-glo__io-block">',
          root.uiField({
            id: 'glo-export-text',
            label: t('kb.glossary.export', '导出（JSON）'),
            control: {
              kind: 'textarea',
              value: state.exportText,
              rows: 5,
              placeholder: t('kb.glossary.export_placeholder', '点「生成导出内容」后出现'),
            },
          }),
          '<div class="kb-glo__io-actions">',
          button({
            label: t('kb.glossary.pack_export', '生成贡献包（可共享）'),
            role: 'ghost', size: 'sm', disabled: state.busy,
            attrs: { 'data-glo-action': 'pack-export' },
          }),
          button({
            label: t('kb.glossary.pack_review', '预览贡献包导入'),
            role: 'ghost', size: 'sm', disabled: state.busy || !state.importText,
            attrs: { 'data-glo-action': 'pack-review' },
          }),
          button({
            label: t('kb.glossary.pack_import', '导入贡献包'),
            role: 'ghost', size: 'sm', disabled: state.busy || !state.importText || !state.packReview,
            attrs: { 'data-glo-action': 'pack-import' },
          }),
          button({
            label: t('kb.glossary.export_generate', '生成导出内容'),
            role: 'ghost', size: 'sm', disabled: state.busy,
            attrs: { 'data-glo-action': 'export-generate' },
          }),
          button({
            label: state.exportIncludePeople
              ? t('kb.glossary.include_people', '包含人名（默认不含）')
              : t('kb.glossary.exclude_people', '不含人名（默认）'),
            role: 'ghost', size: 'sm', disabled: state.busy,
            attrs: { 'data-glo-action': 'toggle-people' },
          }),
          button({
            label: t('kb.glossary.export_save', '另存到知识库'),
            role: 'secondary', size: 'sm', disabled: state.busy || !state.exportText,
            attrs: { 'data-glo-action': 'export-save' },
          }),
          '</div>',
          '</div>',
          '<div class="kb-glo__io-block">',
          root.uiField({
            id: 'glo-import-text',
            label: t('kb.glossary.import', '导入（粘贴 CSV / JSON）'),
            control: { kind: 'textarea', value: state.importText, rows: 5, placeholder: 'wrong,correct,kind,riskLevel\n或 {"entries":[…]}' },
          }),
          root.uiField({
            id: 'glo-import-mode',
            label: t('kb.glossary.import_mode', '导入方式'),
            control: {
              kind: 'select',
              value: state.importMode,
              options: [
                { value: 'merge', label: t('kb.glossary.import_merge', '合并（同词条更新，其余保留）') },
                { value: 'replace', label: t('kb.glossary.import_replace', '替换（清空后导入）') },
              ],
            },
          }),
          state.packReview
            ? `<p class="kb-glo__preview" data-tone="${state.packReview.conflicts.length ? 'warning' : 'plain'}">${t(
              'kb.glossary.pack_review_result',
              '贡献包预览（{scope} 层）：共 {total} 条 · 新增 {added} · 更新 {updates} · 冲突 {conflicts} · 高风险 {highRisk} · 含人名 {people}{conflictHint}',
              {
                scope: state.packReview.ownerScope,
                total: state.packReview.total,
                added: state.packReview.added,
                updates: state.packReview.updates,
                conflicts: state.packReview.conflicts.length,
                highRisk: state.packReview.highRisk,
                people: state.packReview.people,
                conflictHint: state.packReview.conflicts.length
                  ? t('kb.glossary.pack_conflict_hint', '；冲突按"组织 > 团队 > 个人"裁决，本地层级更高时保留本地')
                  : '',
              },
            )}</p>`
            : '',
          preview
            ? `<p class="kb-glo__preview" data-tone="${preview.mode === 'replace' ? 'warning' : 'plain'}">${t(
              'kb.glossary.import_preview',
              '将新增 {added} 条、更新 {updated} 条、跳过 {invalid} 条{noEffectHint}{replaceHint}',
              {
                added: preview.added,
                updated: preview.updated,
                invalid: preview.invalid,
                noEffectHint: preview.noEffect > 0
                  ? `；无效果 ${preview.noEffect} 条（默认跳过）`
                  : '',
                replaceHint: preview.mode === 'replace'
                  ? t('kb.glossary.import_replace_hint', '；替换模式会先清掉现有 {count} 条', { count: preview.replacedExisting })
                  : '',
              },
            )}</p>`
            : '',
          '<div class="kb-glo__io-actions">',
          button({
            label: t('kb.glossary.import_file', '选择文件'),
            role: 'ghost', size: 'sm', disabled: state.busy,
            attrs: { 'data-glo-action': 'import-file' },
          }),
          button({
            label: t('kb.glossary.clear_all', '清空词表'),
            role: 'ghost', size: 'sm', disabled: state.busy || state.entries.length === 0,
            attrs: { 'data-glo-action': 'clear-all' },
          }),
          button({
            label: t('kb.glossary.import_preview_btn', '预览导入结果'),
            role: 'ghost', size: 'sm', disabled: state.busy || !state.importText,
            attrs: { 'data-glo-action': 'import-preview' },
          }),
          button({
            label: t('kb.glossary.import_apply', '确认导入'),
            role: 'secondary', size: 'sm', disabled: state.busy || !state.importText || !preview,
            attrs: { 'data-glo-action': 'import-apply' },
          }),
          '</div>',
          '</div>',
        ].join('');
        if (typeof root.hydrateUiFormSelects === 'function') {
          root.hydrateUiFormSelects(host, {
            // 同一个缺陷也波及这里：靠 dialog 委派读值 ⇒ 从未生效，
            // 「替换」模式根本选不中（选了也回落 merge）。
            'glo-import-mode': (value) => {
              state.importMode = value === 'replace' ? 'replace' : 'merge';
              state.importPreview = null;
              renderIo();
            },
          });
        }
      } catch (error) {
        log?.warn('glossary io render failed', { error: error?.message || String(error) });
      }
    }

    function render() {
      for (const step of [
        renderMeta, renderToolbar, renderMetrics, renderMeetingMetrics, renderHealth, renderFilters, renderRiskLegend, renderStatus, renderBulk, renderList, renderIo,
      ]) {
        try { step(); } catch (error) {
          log?.warn('glossary manager render step failed', { step: step.name, error: error?.message || String(error) });
        }
      }
    }

    // ── 数据动作 ────────────────────────────────────────────────────────
    async function reload() {
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.list', {});
        state.entries = Array.isArray(result?.entries) ? result.entries : [];
        state.meta = result?.meta && typeof result.meta === 'object'
          ? result.meta
          : { ownerNote: '', lastReconcileAt: 0 };
        state.queryRewrite = state.meta.queryRewrite === true;
        await loadMetrics();
        await loadMeetingMetrics();
        const ids = new Set(state.entries.map((e) => e.id));
        state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
      } catch (error) {
        log?.warn('glossary reload failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.load_failed', '读取词表失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /**
     * 下拉筛选的写入口。
     *
     * 自定义 select（`_aiSelectMount`）**不派发 DOM 事件**，只在选中时调 `onChange`
     * 回调（见 utils.js `_aiSelectPick`），所以挂在 dialog 上的 input/change 事件委派
     * 对它永远不触发。唯一可用通道是 `hydrateUiFormSelects(host, { <id>: fn })`
     * 的按 id 回调。
     *
     * 这里原本是一个**没有任何调用方**的 DOM 读函数（readFilters），于是三个筛选下拉
     * 从头到尾没生效：改了类别/风险/状态，state.filter 不动、列表也不重渲染。
     */
    function applyFilter(field, value) {
      state.filter[field] = String(value || '');
      renderBulk();
      renderList();
    }

    async function setStatusBulk(status) {
      if (state.busy) return;
      const blocked = guardReason('bulk-status', { selectedCount: state.selected.size });
      if (blocked) {
        setStatus(t(blocked.key, blocked.fallback), 'warning');
        render();
        return;
      }
      state.busy = true;
      let updated = 0;
      try {
        render();
        for (const id of state.selected) {
          await root.cogseed.invoke('transcript.glossary.setStatus', { id, status });
          updated += 1;
        }
        setStatus(t('kb.glossary.bulk_status_done', '已更新 {count} 条。', { count: updated }), '');
      } catch (error) {
        log?.warn('bulk status failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.bulk_status_failed', '批量更新失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }

    async function deleteOne(id) {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.delete', { id });
        state.selected.delete(id);
        const missing = result?.deleted === false;
        setStatus(
          missing
            ? t('kb.glossary.delete_missing', '没有删除任何词条：该词条已不存在，列表已刷新。')
            : t('kb.glossary.deleted', '已删除词条。'),
          missing ? 'warning' : '',
        );
      } catch (error) {
        log?.warn('glossary delete failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.delete_failed', '删除失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }

    async function toggleStatus(id, current) {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.setStatus', {
          id,
          status: current === 'paused' ? 'active' : 'paused',
        });
        if (!result?.entry) {
          setStatus(t('kb.glossary.entry_missing', '该词条已不存在（可能已在别处删除），列表已刷新。'), 'warning');
        } else {
          setStatus(
            current === 'paused'
              ? t('kb.glossary.status_resumed_one', '已启用该词条。')
              : t('kb.glossary.status_paused_one', '已暂停该词条。'),
            '',
          );
        }
      } catch (error) {
        log?.warn('glossary status failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.bulk_status_failed', '批量更新失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }



    async function generateExport() {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.export', {
          includePeople: state.exportIncludePeople,
        });
        state.exportText = JSON.stringify(result?.bundle ?? {}, null, 2);
        const textarea = dialog.querySelector('#glo-export-text');
        if (textarea) textarea.value = state.exportText;
        setStatus(t('kb.glossary.export_generated', '导出内容已生成（{count} 条）；可另存到知识库。', {
          count: Array.isArray(result?.bundle?.entries) ? result.bundle.entries.length : 0,
        }), '');
      } catch (error) {
        log?.warn('glossary export failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.export_failed', '导出失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function saveExport() {
      if (state.busy) return;
      const blocked = guardReason('save-export', { hasExportText: Boolean(state.exportText) });
      if (blocked) {
        setStatus(t(blocked.key, blocked.fallback), 'warning');
        render();
        return;
      }
      state.busy = true;
      try {
        render();
        const stamp = new Date().toISOString().slice(0, 10);
        const targetPath = t('kb.glossary.export_filename', '转写词表-{date}.json', { date: stamp });
        const result = await root.cogseed.invoke('library.writeText', { content: state.exportText, targetPath });
        if (result?.ok === false) {
          const duplicate = result.code === 'duplicate_content';
          setStatus(duplicate
            ? (result.existingPath
              ? t('kb.glossary.export_duplicate_file', '库里已有相同内容的导出文件：{path}，无需重复保存。', { path: String(result.existingPath) })
              : t('kb.glossary.export_duplicate', '库里已有相同内容的导出文件，无需重复保存。'))
            : t('kb.glossary.export_save_failed', '保存失败：{error}', { error: String(result.error || '') }),
            duplicate ? '' : 'warning');
          notifyLibraryChanged();
          return;
        }
        setStatus(t('kb.glossary.export_saved', '已另存：{path}', { path: result?.path || targetPath }), '');
        notifyLibraryChanged();
      } catch (error) {
        log?.warn('glossary export save failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.export_save_failed', '保存失败：{error}', { error: error?.message || '' }), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function parseImportText() {
      const raw = String(dialog.querySelector('#glo-import-text')?.value || '').trim();
      state.importText = raw;
      if (!raw) return null;
      // 解析放在主进程：CSV 引号/转义/表头等边界只维护一份，预览与导入同口径。
      const parsed = await root.cogseed.invoke('transcript.glossary.parseImport', { text: raw });
      if (!parsed || parsed.ok === false) throw new Error('invalid import text');
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        skipped: Number(parsed.skipped || 0),
        format: parsed.format === 'json' ? 'json' : 'csv',
      };
    }

    async function previewImport() {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const parsed = await parseImportText();
        if (!parsed) {
          state.importPreview = null;
          state.importEntries = [];
          setStatus(t('kb.glossary.import_empty', '这段内容里没有可导入的词条。'), 'warning');
          return;
        }
        if (!parsed.entries.length) {
          state.importPreview = null;
          state.importEntries = [];
          setStatus(t('kb.glossary.import_empty', '这段内容里没有可导入的词条。'), 'warning');
          return;
        }
        state.importEntries = parsed.entries;
        const preview = summarizeImport(state.entries, parsed.entries, state.importMode);
        preview.invalid += parsed.skipped;
        state.importPreview = preview;
        setStatus('', '');
      } catch (error) {
        log?.warn('glossary import preview failed', { error: error?.message || String(error) });
        state.importPreview = null;
        state.importEntries = [];
        setStatus(t('kb.glossary.import_invalid', '导入内容不是合法的 CSV 或 JSON。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function pickImportFile() {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const picked = await root.cogseed.invoke('transcript.glossary.pickImportFile', {});
        if (!picked || picked.canceled) return;
        if (picked.ok === false) throw new Error(String(picked.error || 'read failed'));
        state.importText = String(picked.text || '');
        state.importEntries = [];
        state.importPreview = null;
        const textarea = dialog.querySelector('#glo-import-text');
        if (textarea) textarea.value = state.importText;
        setStatus(t('kb.glossary.import_file_loaded', '已读取：{path}', { path: String(picked.path || '') }), '');
      } catch (error) {
        log?.warn('glossary import file failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.import_file_failed', '读取文件失败：{error}', { error: error?.message || '' }), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function clearAll() {
      if (state.busy || !state.entries.length) return;
      const ask = typeof root.confirm === 'function'
        ? root.confirm.bind(root)
        : (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm.bind(window) : null);
      if (ask && !ask(t('kb.glossary.clear_confirm', '清空词表前会先备份到本机。确定清空？'))) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.clear', {});
        setStatus(t('kb.glossary.clear_done', '已清空 {count} 条；备份：{path}', {
          count: Number(result?.cleared || 0),
          path: String(result?.backupPath || ''),
        }), '');
        state.selected = new Set();
        state.importPreview = null;
        state.importEntries = [];
      } catch (error) {
        log?.warn('glossary clear failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.clear_failed', '清空失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }

    async function applyImport() {
      if (state.busy) return;
      if (!state.importEntries.length) {
        setStatus(t('kb.glossary.import_empty', '这段内容里没有可导入的词条。'), 'warning');
        return;
      }
      const blocked = guardReason('apply-import', { hasImportPreview: Boolean(state.importPreview) });
      if (blocked) {
        setStatus(t(blocked.key, blocked.fallback), 'warning');
        render();
        return;
      }
      state.busy = true;
      try {
        render();
        const usable = state.importEntries.filter((e) => String(e?.wrong || '').trim() !== String(e?.correct || '').trim());
        if (!usable.length) {
          setStatus(t('kb.glossary.import_all_no_effect', '这些条目的错词和正确写法都相同，没有可导入的有效词条。'), 'warning');
          return;
        }
        const result = await root.cogseed.invoke('transcript.glossary.import', {
          payload: { entries: usable },
          mode: state.importMode,
        });
        setStatus(t('kb.glossary.import_done', '导入完成：新增 {added} 条、更新 {updated} 条、跳过 {invalid} 条。', {
          added: Number(result?.added || 0),
          updated: Number(result?.updated || 0),
          invalid: Number(result?.invalid || result?.skipped || 0),
        }), '');
        state.importText = '';
        state.importEntries = [];
        state.importPreview = null;
      } catch (error) {
        log?.warn('glossary import failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.import_failed', '导入失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }

    /**
     * 装入方案附 A 的初始词表（幂等）。方案明写"默认不入册"的词（`for → Foo`）
     * 不在种子里，返回里会说明被排除的是哪些，避免用户以为装漏了。
     */
    /**
     * 贡献包导出（方案 §五 P3-1）：人名默认不导；包里不含本地文档名/runId。
     * 生成后写进同一个导出文本框，用户可以直接另存或复制给别人。
     */
    async function exportPack() {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.exportPack', {
          includePeople: state.exportIncludePeople,
          ownerScope: state.packScope,
        });
        const pack = result?.pack;
        state.exportText = JSON.stringify(pack, null, 2);
        const textarea = dialog.querySelector('#glo-export-text');
        if (textarea) textarea.value = state.exportText;
        setStatus(t('kb.glossary.pack_exported', '贡献包已生成：{total} 条（排除人名 {people} 条，层级 {scope}）', {
          total: Number(pack?.counts?.total || 0),
          people: Number(pack?.counts?.peopleExcluded || 0),
          scope: String(pack?.ownerScope || 'personal'),
        }), '');
      } catch (error) {
        log?.warn('export pack failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.pack_export_failed', '生成贡献包失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /** 贡献包导入预览（治理闸门：先看新增/冲突/高风险/人名）。 */
    async function reviewPack() {
      const parsed = parseImportText();
      if (!parsed) {
        setStatus(t('kb.glossary.pack_content_required', '请先把贡献包 JSON 粘贴到下面的输入框。'), 'warning');
        render();
        return;
      }
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.reviewPack', { pack: parsed });
        state.packReview = result?.review ?? null;
        setStatus('', '');
      } catch (error) {
        log?.warn('review pack failed', { error: error?.message || String(error) });
        state.packReview = null;
        setStatus(t('kb.glossary.pack_invalid', '这不是一份可识别的贡献包。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /** 导入贡献包（优先级 组织 > 团队 > 个人；本地更高时保留本地并如实计数）。 */
    async function importPack() {
      if (state.busy) return;
      const parsed = parseImportText();
      if (!parsed) {
        setStatus(t('kb.glossary.pack_content_required', '请先把贡献包 JSON 粘贴到下面的输入框。'), 'warning');
        render();
        return;
      }
      if (!state.packReview) {
        setStatus(t('kb.glossary.pack_review_required', '请先点「复核」检查这份贡献包，再导入。'), 'warning');
        render();
        return;
      }
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.importPack', { pack: parsed });
        setStatus(t('kb.glossary.pack_imported', '贡献包已导入：新增 {added} · 更新 {updated} · 覆盖 {overwritten} · 保留本地 {keptLocal}', {
          added: Number(result?.added || 0),
          updated: Number(result?.updated || 0),
          overwritten: Number(result?.overwritten || 0),
          keptLocal: Number(result?.keptLocal || 0),
        }), '');
        state.packReview = null;
      } catch (error) {
        log?.warn('import pack failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.pack_import_failed', '导入贡献包失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }

    /** 检索前 query 同义改写开关（方案 §五 P2-3）：默认关，改检索行为要用户点头。 */
    async function toggleQueryRewrite() {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.queryRewrite.set', { enabled: !state.queryRewrite });
        state.queryRewrite = result?.enabled === true;
        setStatus(state.queryRewrite
          ? t('kb.glossary.qrw_enabled', '已开启：检索前会把词表里的错形改写成正确写法（高危词不改）。')
          : t('kb.glossary.qrw_disabled', '已关闭检索改写。'), '');
      } catch (error) {
        log?.warn('query rewrite toggle failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.qrw_failed', '切换失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function seedInitial() {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.seedInitial', {});
        const excluded = Array.isArray(result?.excluded) ? result.excluded : [];
        setStatus(t('kb.glossary.seed_initial_done', '产品词表已导入：新增 {created} 条、更新 {updated} 条{excluded}', {
          created: Number(result?.created || 0),
          updated: Number(result?.updated || 0),
          excluded: excluded.length
            ? t('kb.glossary.seed_initial_excluded', '；按方案刻意不入册：{list}', { list: excluded.join('、') })
            : '',
        }), '');
      } catch (error) {
        log?.warn('seed initial failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.seed_initial_failed', '导入产品词表失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }

    async function editOwnerNote() {
      const current = String(state.meta?.ownerNote || '');
      let next = null;
      if (typeof root.uiPrompt === 'function') {
        next = await root.uiPrompt(t('kb.glossary.owner_prompt', '词表 owner（谁维护这份词表）'), current);
      } else {
        next = root.prompt ? root.prompt(t('kb.glossary.owner_prompt', '词表 owner（谁维护这份词表）'), current) : null;
      }
      if (next === null || next === undefined) return;
      try {
        await root.cogseed.invoke('transcript.glossary.setOwnerNote', { note: String(next) });
        await reload();
        setStatus(t('kb.glossary.owner_saved', '已更新词表 owner。'), '');
      } catch (error) {
        log?.warn('owner note failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.owner_failed', '更新失败，请稍后重试。'), 'warning');
      }
    }

    async function openLearningSettings() {
      closeFloatingMenu();
      if (typeof root.uiModal !== 'function') return;
      let stateResult;
      try {
        stateResult = await root.cogseed.invoke('transcript.glossary.learning.get', {});
      } catch (error) {
        log?.warn('learning settings load failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.learning_load_failed', '读取自动学习设置失败。'), 'warning');
        return;
      }
      const settings = stateResult?.settings || { enabled: true, threshold: 3, notify: true };
      const recent = Array.isArray(stateResult?.recent) ? stateResult.recent : [];
      const modal = root.uiModal({
        title: t('kb.glossary.learning_title', '自动学习'),
        size: 'md',
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        bodyHtml: [
          '<div class="kb-glo-learn">',
          `<p class="ui-field__hint">${t('kb.glossary.learning_hint', '同一对词被确认达到设定次数后，自动加入词表，以后所有转写都生效。可以随时关闭或撤销。')}</p>`,
          root.uiField({
            id: 'glo-learn-enabled',
            label: t('kb.glossary.learning_enabled', '开启自动学习'),
            showRequirement: false,
            control: { kind: 'checkbox', checked: settings.enabled === true, value: '1' },
          }),
          root.uiField({
            id: 'glo-learn-threshold',
            label: t('kb.glossary.learning_threshold', '确认几次后加入'),
            showRequirement: false,
            control: {
              kind: 'select', value: String(settings.threshold || 3),
              options: [2, 3, 5].map((n) => ({ value: String(n), label: t('kb.glossary.learning_times', '{count} 次', { count: n }) })),
            },
          }),
          root.uiField({
            id: 'glo-learn-notify',
            label: t('kb.glossary.learning_notify', '自动加入时告诉我'),
            showRequirement: false,
            control: { kind: 'checkbox', checked: settings.notify !== false, value: '1' },
          }),
          '<div class="kb-glo-learn__recent" data-glo-learn-recent></div>',
          '<div class="kb-glo-learn__actions">',
          button({ label: t('common.cancel', '取消'), role: 'ghost', size: 'sm', attrs: { 'data-learn-action': 'cancel' } }),
          button({ label: t('kb.glossary.learning_save', '保存设置'), role: 'primary', size: 'sm', attrs: { 'data-learn-action': 'save' } }),
          '</div>',
          '</div>',
        ].join(''),
      });
      const host = modal.dialog.querySelector('[data-glo-learn-recent]');
      const renderRecent = () => {
        if (!host) return;
        host.innerHTML = recent.length
          ? `<p class="kb-glo-learn__title">${t('kb.glossary.learning_recent', '最近自动加入')}</p>`
            + recent.map((r, index) => `<div class="kb-glo-learn__row"><span>${escapeHtml(r.wrong)} → ${escapeHtml(r.correct)}</span>`
              + button({ label: t('kb.glossary.learning_undo', '撤销'), role: 'ghost', size: 'sm', attrs: { 'data-learn-undo': r.learnedEntryId || String(index) } })
              + '</div>').join('')
          : `<p class="ui-field__hint">${t('kb.glossary.learning_none', '还没有自动加入的词。')}</p>`;
      };
      renderRecent();
      modal.dialog.addEventListener('click', async (event) => {
        const action = event.target.closest?.('[data-learn-action]')?.getAttribute('data-learn-action');
        const undo = event.target.closest?.('[data-learn-undo]')?.getAttribute('data-learn-undo');
        if (undo) {
          try {
            await root.cogseed.invoke('transcript.glossary.learning.undo', { entryId: undo });
            const idx = recent.findIndex((r) => r.learnedEntryId === undo);
            if (idx >= 0) recent.splice(idx, 1);
            renderRecent();
            setStatus(t('kb.glossary.learning_undone', '已撤销这条自动学习。'), '');
            await reload();
          } catch (error) {
            log?.warn('learning undo failed', { error: error?.message || String(error) });
            setStatus(t('kb.glossary.learning_undo_failed', '撤销失败，请稍后重试。'), 'warning');
          }
          return;
        }
        if (action === 'cancel') { modal.close('cancel'); return; }
        if (action !== 'save') return;
        const read = (id) => modal.dialog.querySelector(`#${id}`);
        const enabled = read('glo-learn-enabled')?.checked === true;
        const notify = read('glo-learn-notify')?.checked === true;
        const thresholdHost = read('glo-learn-threshold');
        const threshold = Number(thresholdHost?._uiSelectApi?.getValue?.() || thresholdHost?.value || 3);
        try {
          await root.cogseed.invoke('transcript.glossary.learning.set', { enabled, notify, threshold });
          modal.close('saved');
          setStatus(t('kb.glossary.learning_saved', '自动学习设置已保存。'), '');
          await reload();
        } catch (error) {
          log?.warn('learning settings save failed', { error: error?.message || String(error) });
          setStatus(t('kb.glossary.learning_save_failed', '保存设置失败，请稍后重试。'), 'warning');
        }
      });
    }

    function openMoreMenu(event, trigger) {
      if (typeof root.showContextMenu !== 'function') return;
      root.showContextMenu(event, [
        {
          label: t('kb.glossary.owner_note_short', '词表备注'),
          onClick: () => { void editOwnerNote(); },
        },
        {
          label: state.queryRewrite
            ? t('kb.glossary.qrw_on', '检索改写：开')
            : t('kb.glossary.qrw_off', '检索改写：关'),
          onClick: () => { void toggleQueryRewrite(); },
        },
        {
          label: t('kb.glossary.learning_title', '自动学习'),
          onClick: () => { void openLearningSettings(); },
        },
        {
          label: t('kb.glossary.seed_initial', '导入产品词表（可选）'),
          onClick: () => { void seedInitial(); },
        },
        { separatorBefore: true, label: t('kb.glossary.clear_all', '清空词表'), danger: true, onClick: () => { void clearAll(); } },
      ], { trigger: trigger || event.target });
    }

    async function onClick(event) {
      // 行本身不再打开详情：只有行尾 ⋯ 菜单里的「详情」可以进。
      const menu = event.target.closest('[data-glo-menu]');
      if (menu) {
        const id = menu.getAttribute('data-glo-menu');
        const target = state.entries.find((e) => e.id === id);
        if (!target) { setStatus(t('kb.glossary.edit_missing', '这条词条已经不存在了（可能在别处被删掉）。关闭后刷新列表即可。'), 'warning'); void reload(); return; }
        if (typeof root.showContextMenu === 'function') {
          root.showContextMenu(event, [
            { label: t('kb.glossary.detail', '详情'), onClick: () => openDetail(target) },
            { label: t('kb.glossary.edit', '编辑'), onClick: () => openEdit(target) },
            {
              label: target.status === 'paused' ? t('kb.glossary.resume', '启用') : t('kb.glossary.pause', '暂停'),
              onClick: () => { void toggleStatus(target.id, target.status); },
            },
            { separatorBefore: true, label: t('kb.glossary.delete', '删除'), danger: true, onClick: () => { void deleteOne(target.id); } },
          ], { trigger: menu });
        }
        return;
      }
      const toggle = event.target.closest('[data-glo-toggle]');
      if (toggle) {
        void toggleStatus(toggle.getAttribute('data-glo-toggle'), toggle.getAttribute('data-glo-status'));
        return;
      }
      const edit = event.target.closest('[data-glo-edit]');
      if (edit) {
        const target = state.entries.find((e) => e.id === edit.getAttribute('data-glo-edit'));
        if (!target) {
          // 列表与数据不同步时的兜底：不弹空表单，直接说清并刷新。
          setStatus(t('kb.glossary.edit_missing', '这条词条已经不存在了（可能在别处被删掉）。关闭后刷新列表即可。'), 'warning');
          void reload();
          return;
        }
        // 编辑弹窗构造失败时**必须让用户看见**：此前这里直接调用，一旦
        // uiForm/uiFormModal 不可用，异常会被事件处理器吞掉，用户看到的就是
        // "点了没反应"（2026-10-15 反馈）。
        try {
          openEdit(target);
        } catch (error) {
          log?.warn('open glossary edit failed', { error: error?.message || String(error) });
          setStatus(t('kb.glossary.edit_open_failed', '打不开编辑框，请重开面板再试。'), 'warning');
          if (typeof root.toast === 'function') {
            root.toast(t('kb.glossary.edit_open_failed', '打不开编辑框，请重开面板再试。'));
          }
        }
        return;
      }
      const del = event.target.closest('[data-glo-delete]');
      if (del) { void deleteOne(del.getAttribute('data-glo-delete')); return; }
      // 候选区的采纳/丢弃入口已随「模型建议并入扫描」移除（候选在转写纠错面板里勾选即确认），
      // 这里不再有 data-glo-candidate-* 分支。
      const action = event.target.closest('[data-glo-action]');
      if (!action) return;
      const kind = action.getAttribute('data-glo-action');
      if (kind === 'add') { try { openAdd(); } catch (error) { log?.warn('open glossary add failed', { error: error?.message || String(error) }); setStatus(t('kb.glossary.edit_open_failed', '打不开编辑框，请重开面板再试。'), 'warning'); } return; }
      if (kind === 'open-io') {
        const io = q('[data-glo-io]');
        if (io) { io.hidden = false; io.open = true; io.scrollIntoView?.({ block: 'nearest' }); }
        return;
      }
      if (kind === 'more') { openMoreMenu(event, action); return; }
      if (kind === 'health-toggle') {
        state.healthOnly = !state.healthOnly;
        renderHealth(); renderList(); renderBulk();
        return;
      }
      if (kind === 'health-clean') {
        const targets = state.entries.filter(isNoEffect);
        if (!targets.length) return;
        const ask = typeof root.confirm === 'function'
          ? root.confirm.bind(root)
          : (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm.bind(window) : null);
        if (ask && !ask(t('kb.glossary.health_clean_confirm', '清理 {count} 条不会生效的词条？', { count: targets.length }))) return;
        state.busy = true;
        try {
          for (const entry of targets) await root.cogseed.invoke('transcript.glossary.delete', { id: entry.id });
          setStatus(t('kb.glossary.health_cleaned', '已清理 {count} 条无效果词条。', { count: targets.length }), '');
          state.healthOnly = false;
        } catch (error) {
          log?.warn('health clean failed', { error: error?.message || String(error) });
          setStatus(t('kb.glossary.health_clean_failed', '清理失败，请稍后重试。'), 'warning');
        } finally {
          state.busy = false;
          await reload();
          opts.onChanged?.();
        }
        return;
      }
      if (kind === 'select-all') {
        for (const entry of visibleEntries()) state.selected.add(entry.id);
        render();
      } else if (kind === 'clear-selection') {
        state.selected = new Set();
        render();
      } else if (kind === 'pause-selected') {
        void setStatusBulk('paused');
      } else if (kind === 'resume-selected') {
        void setStatusBulk('active');
      } else if (kind === 'pack-export') {
        void exportPack();
      } else if (kind === 'pack-review') {
        void reviewPack();
      } else if (kind === 'pack-import') {
        void importPack();
      } else if (kind === 'toggle-qrw') {
        void toggleQueryRewrite();
      } else if (kind === 'seed-initial') {
        void seedInitial();
      } else if (kind === 'owner-note') {
        void editOwnerNote();
      } else if (kind === 'export-generate') {
        void generateExport();
      } else if (kind === 'toggle-people') {
        state.exportIncludePeople = !state.exportIncludePeople;
        render();
      } else if (kind === 'export-save') {
        void saveExport();
      } else if (kind === 'import-file') {
        void pickImportFile();
      } else if (kind === 'clear-all') {
        void clearAll();
      } else if (kind === 'import-preview') {
        void previewImport();
      } else if (kind === 'import-apply') {
        void applyImport();
      }
    }

    function onFilterChange(event) {
      const select = event.target.closest?.('[data-glo-select]');
      if (select) {
        const id = select.getAttribute('data-glo-select');
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
        renderBulk();
        renderList();
        return;
      }
      if (event.target.id === 'glo-search') {
        state.filter.search = String(event.target.value || '');
        renderBulk();
        renderList();
        return;
      }
      if (event.target.id === 'glo-import-text') {
        state.importText = String(event.target.value || '');
        state.importEntries = [];
        state.importPreview = null;
        renderIo();
        return;
      }
    }

    dialog.addEventListener('click', onClick);
    dialog.addEventListener('input', onFilterChange);
    dialog.addEventListener('change', onFilterChange);

    // 语言切换：弹层文案全部经 t(...) 取值，重渲染即拿到新语言。弹层挂载后自己持有 DOM，
    // 视图不会重建它，所以必须自己响应 i18n-change；弹层关闭时解绑，避免监听器随开随积。
    const onI18nChange = () => { render(); };
    root.addEventListener('i18n-change', onI18nChange);
    if (modal && typeof modal.then === 'function') {
      const unbind = () => root.removeEventListener('i18n-change', onI18nChange);
      modal.then(unbind, unbind);
    }

    render();
    void reload();
    void loadMetrics().then(() => renderMetrics());
    void loadMeetingMetrics().then(() => renderMeetingMetrics());

    return modal;
  }

  const api = {
    open,
    // 测试桥（仅纯函数）
    __test: { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf, guardReason, meetingMetricsLines },
    _internals: { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf, guardReason, meetingMetricsLines },
  };

  root.KbGlossaryManager = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf, guardReason, meetingMetricsLines };
  }
})(typeof window !== 'undefined' ? window : globalThis);
