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
    const added = list.filter((e) => !existing.has(keyOf(e)));
    const updated = list.filter((e) => existing.has(keyOf(e)));
    const invalid = (incoming || []).length - list.length;
    return {
      mode: mode === 'replace' ? 'replace' : 'merge',
      total: list.length,
      added: added.length,
      updated: updated.length,
      invalid,
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
      /** 待核候选（模型给的）：与词条分开存、分开显示——候选不参与扫描。 */
      candidates: [],
      meta: { ownerNote: '', lastReconcileAt: 0 },
      filter: { search: '', kind: '', riskLevel: '', status: '' },
      selected: new Set(),
      busy: false,
      status: '',
      statusTone: '',
      queryRewrite: false,
      metrics: null,
      packReview: null,
      packScope: 'personal',
      exportText: '',
      exportIncludePeople: false,
      importText: '',
      importMode: 'merge',
      importPreview: null,
    };

    const modal = root.uiModal({
      title: t('kb.glossary.title', '转写词表'),
      size: 'lg',
      closeLabel: t('kb.transcriptCorrect.close', '关闭'),
      bodyHtml: [
        '<div class="kb-glo">',
        '  <div class="kb-glo__meta" data-glo-meta></div>',
        '  <div class="kb-glo__metrics" data-glo-metrics></div>',
        '  <div class="kb-glo__filters" data-glo-filters></div>',
        '  <div class="kb-glo__status" data-glo-status hidden></div>',
        '  <div class="kb-glo__bulk" data-glo-bulk></div>',
        '  <div class="kb-glo__candidates" data-glo-candidates hidden></div>',
        '  <div class="kb-glo__list" data-glo-list></div>',
        '  <details class="kb-glo__io" data-glo-io>',
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

    function renderMetrics() {
      const host = q('[data-glo-metrics]');
      if (!host || !state.metrics) return;
      const m = state.metrics;
      const parts = [
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
      host.textContent = parts.join(' · ');
      const notMeasurable = document.createElement('div');
      notMeasurable.className = 'kb-glo__row-meta';
      notMeasurable.textContent = t('kb.glossary.metrics_not_measurable', '测不了的指标（不编数字）：{list}', {
        list: (m.notMeasurable || []).join('；'),
      });
      host.appendChild(notMeasurable);
    }

    function renderMeta() {
      const host = q('[data-glo-meta]');
      if (!host) return;
      const owner = String(state.meta?.ownerNote || '').trim();
      host.textContent = [
        t('kb.glossary.count', '共 {count} 条', { count: state.entries.length }),
        owner
          ? t('kb.glossary.owner_named', '词表 owner：{owner}', { owner })
          : t('kb.glossary.owner_unnamed', '词表 owner：未指定'),
        t('kb.glossary.maintained_at', '最后维护：{when}', {
          when: formatWhen(state.meta?.lastReconcileAt || state.entries.reduce((max, e) => Math.max(max, Number(e.updatedAt || 0)), 0)),
        }),
      ].join(' · ');
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
            control: { kind: 'input', value: state.filter.search, placeholder: t('kb.glossary.search_placeholder', '错词或正确写法') },
          }),
          root.uiField({
            id: 'glo-kind',
            label: t('kb.glossary.kind', '类别'),
            control: { kind: 'select', value: state.filter.kind, options: kindOptions },
          }),
          root.uiField({
            id: 'glo-risk',
            label: t('kb.glossary.risk', '风险'),
            control: { kind: 'select', value: state.filter.riskLevel, options: riskOptions },
          }),
          root.uiField({
            id: 'glo-status',
            label: t('kb.glossary.status', '状态'),
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
      return sortEntries(filterEntries(state.entries, state.filter));
    }

    function renderBulk() {
      const host = q('[data-glo-bulk]');
      if (!host) return;
      const rows = visibleEntries();
      const count = state.selected.size;
      host.innerHTML = [
        button({
          label: t('kb.glossary.select_all', '全选（{count}）', { count: rows.length }),
          role: 'ghost', size: 'sm', disabled: state.busy || rows.length === 0,
          attrs: { 'data-glo-action': 'select-all' },
        }),
        button({
          label: t('kb.glossary.clear_selection', '清空选择'),
          role: 'ghost', size: 'sm', disabled: state.busy || count === 0,
          attrs: { 'data-glo-action': 'clear-selection' },
        }),
        button({
          label: t('kb.glossary.pause_selected', '暂停所选（{count}）', { count }),
          role: 'ghost', size: 'sm', disabled: state.busy || count === 0,
          attrs: { 'data-glo-action': 'pause-selected' },
        }),
        button({
          label: t('kb.glossary.resume_selected', '启用所选（{count}）', { count }),
          role: 'ghost', size: 'sm', disabled: state.busy || count === 0,
          attrs: { 'data-glo-action': 'resume-selected' },
        }),
        button({
          label: t('kb.glossary.owner_note', '词表 owner 备注'),
          role: 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-action': 'owner-note' },
        }),
        button({
          label: state.queryRewrite
            ? t('kb.glossary.qrw_on', '检索改写：开')
            : t('kb.glossary.qrw_off', '检索改写：关'),
          role: state.queryRewrite ? 'primary' : 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-action': 'toggle-qrw' },
        }),
        button({
          label: t('kb.glossary.seed_initial', '补全初始词表（方案附 A）'),
          role: 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-action': 'seed-initial' },
        }),
      ].join('');
    }

    function rowElement(entry) {
      const el = document.createElement('div');
      el.className = 'kb-glo__row';
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
      meta.textContent = [
        t(`kb.transcriptCorrect.kind_${kindKey(entry.kind)}`, kindKey(entry.kind)),
        t(`kb.transcriptCorrect.risk_${riskKeyOf(entry.riskLevel)}`, riskKeyOf(entry.riskLevel)),
        t('kb.glossary.freq', '确认 {count} 次', { count: Number(entry.freq || 0) }),
        t('kb.glossary.owner_scope', '归属：{scope}', { scope: entry.ownerScope || 'personal' }),
        entry.source === 'ontology_seed'
          ? t('kb.glossary.source_ontology', '来源：记忆分组')
          : entry.source === 'import'
            ? t('kb.glossary.source_import', '来源：导入')
            : entry.source === 'meeting_accept'
              ? t('kb.glossary.source_meeting', '来源：会议确认')
              : t('kb.glossary.source_manual', '来源：手工'),
        t('kb.glossary.updated_at', '维护：{when}', { when: formatWhen(entry.updatedAt) }),
        entry.scope?.global === false
          ? t('kb.glossary.scope_limited', '作用域：受限')
          : t('kb.glossary.scope_global', '作用域：全局'),
        ...(Array.isArray(entry.contextAllow) && entry.contextAllow.length
          ? [t('kb.glossary.allow_listed', '加白 {count} 个', { count: entry.contextAllow.length })]
          : []),
        ...((entry.ignoredCount || 0) > 0
          ? [t('kb.glossary.ignored_times', '已忽略 {count} 次', { count: entry.ignoredCount })]
          : []),
        ...(entry.status === 'paused' ? [t('kb.glossary.status_paused', '已暂停')] : []),
      ].join(' · ');
      main.append(pair, meta);

      const actions = document.createElement('div');
      actions.className = 'kb-glo__row-actions';
      actions.innerHTML = [
        button({
          label: state.selected.has(entry.id)
            ? t('kb.glossary.selected', '已选')
            : t('kb.glossary.select', '选择'),
          role: state.selected.has(entry.id) ? 'primary' : 'ghost',
          size: 'sm',
          disabled: state.busy,
          attrs: { 'data-glo-select': entry.id },
        }),
        button({
          label: entry.status === 'paused'
            ? t('kb.glossary.resume', '启用')
            : t('kb.glossary.pause', '暂停'),
          role: 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-toggle': entry.id, 'data-glo-status': entry.status },
        }),
        button({
          label: t('kb.glossary.delete', '删除'),
          role: 'ghost', size: 'sm', disabled: state.busy,
          attrs: { 'data-glo-delete': entry.id },
        }),
      ].join('');

      el.append(main, actions);
      return el;
    }

    /**
     * 待核候选区（模型候选的唯一出口）。
     *
     * 为什么单独一块、且明确写"当前不生效"：候选与词条长得像（都是一对
     * wrong → correct），但语义完全不同——词条是扫描规则，候选只是一句建议。
     * 混进词条列表会让用户以为它已经生效了。这里只提供两个动作：
     * 「确认入表」（变成真词条，此后才参与扫描）与「丢弃」。
     */
    function renderCandidates() {
      const host = q('[data-glo-candidates]');
      if (!host) return;
      const pending = (state.candidates || []).filter((c) => c.state === 'pending');
      host.textContent = '';
      host.hidden = pending.length === 0;
      if (!pending.length) return;

      const head = document.createElement('div');
      head.className = 'kb-glo__candidates-head';
      const title = document.createElement('strong');
      title.textContent = t('kb.glossary.candidates_title', '待核候选（{count} 条）', { count: pending.length });
      head.appendChild(title);
      const hint = document.createElement('div');
      hint.className = 'kb-glo__preview';
      hint.textContent = t(
        'kb.glossary.candidates_hint',
        '这些是模型在转写纠错里给出的候选，当前不生效、不参与扫描替换；确认入表后才会成为词条。',
      );
      head.appendChild(hint);
      host.appendChild(head);

      for (const candidate of pending.slice(0, 50)) {
        const row = document.createElement('div');
        row.className = 'kb-glo__candidate-row';
        const main = document.createElement('div');
        main.className = 'kb-glo__candidate-main';
        const label = document.createElement('span');
        label.className = 'kb-glo__candidate-label';
        label.textContent = t('kb.glossary.candidate_pair', '{wrong} → {correct}（置信 {percent}%）', {
          wrong: candidate.wrong,
          correct: candidate.correct,
          percent: Math.round((Number(candidate.confidence) || 0) * 100),
        });
        main.appendChild(label);
        const meta = document.createElement('div');
        meta.className = 'kb-glo__candidate-meta';
        meta.textContent = [
          candidate.inAllowlist === false
            ? t('kb.glossary.candidate_outside_allowlist', '词表外写法')
            : t('kb.glossary.candidate_in_allowlist', '词表已有写法'),
          candidate.reason ? String(candidate.reason) : '',
          candidate.context ? String(candidate.context) : '',
        ].filter(Boolean).join(' · ');
        main.appendChild(meta);
        const acts = document.createElement('div');
        acts.className = 'kb-glo__candidate-actions';
        acts.innerHTML = [
          button({
            label: t('kb.glossary.candidate_adopt', '确认入表'),
            role: 'primary',
            size: 'sm',
            disabled: state.busy,
            attrs: { 'data-glo-candidate-adopt': candidate.id },
          }),
          button({
            label: t('kb.glossary.candidate_discard', '丢弃'),
            role: 'ghost',
            size: 'sm',
            disabled: state.busy,
            attrs: { 'data-glo-candidate-discard': candidate.id },
          }),
        ].join('');
        row.append(main, acts);
        host.appendChild(row);
      }
    }

    function renderList() {
      const host = q('[data-glo-list]');
      if (!host) return;
      host.textContent = '';
      const rows = visibleEntries();
      if (rows.length === 0) {
        const empty = typeof root.uiEmptyState === 'function'
          ? root.uiEmptyState({
            kind: 'quiet',
            title: state.entries.length
              ? t('kb.glossary.no_match', '没有符合条件的词条')
              : t('kb.glossary.empty', '词表还是空的：在转写纠错面板里新增词条，或从记忆分组同步。'),
          })
          : '';
        host.innerHTML = empty;
        if (!empty) host.textContent = t('kb.glossary.empty', '词表还是空的。');
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
            label: t('kb.glossary.import', '导入（粘贴 JSON）'),
            control: { kind: 'textarea', value: state.importText, rows: 5, placeholder: '{"version":2,"entries":[…]}' },
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
              '将新增 {added} 条、更新 {updated} 条、跳过 {invalid} 条{replaceHint}',
              {
                added: preview.added,
                updated: preview.updated,
                invalid: preview.invalid,
                replaceHint: preview.mode === 'replace'
                  ? t('kb.glossary.import_replace_hint', '；替换模式会先清掉现有 {count} 条', { count: preview.replacedExisting })
                  : '',
              },
            )}</p>`
            : '',
          '<div class="kb-glo__io-actions">',
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
        renderMeta, renderMetrics, renderFilters, renderStatus, renderBulk, renderCandidates, renderList, renderIo,
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
        // 候选区独立通道：词条列表只含已生效规则，候选不在其中。
        try {
          const cand = await root.cogseed.invoke('transcript.glossary.candidates', {});
          state.candidates = Array.isArray(cand?.candidates) ? cand.candidates : [];
        } catch (error) {
          log?.warn('glossary candidates load failed', { error: error?.message || String(error) });
          state.candidates = [];
        }
        state.meta = result?.meta && typeof result.meta === 'object'
          ? result.meta
          : { ownerNote: '', lastReconcileAt: 0 };
        state.queryRewrite = state.meta.queryRewrite === true;
        await loadMetrics();
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

    /**
     * 候选 → 词条（人工确认）。这是候选唯一能影响扫描的动作，必须由人点。
     * 采纳后重新扫描才可能替换——**候选本身在此之前一直不生效**。
     */
    async function adoptCandidate(id) {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.adoptCandidate', { id });
        if (!result?.entry) {
          const reason = String(result?.skippedReason || '');
          setStatus(reason === 'not_pending'
            ? t('kb.glossary.candidate_not_pending', '该候选已经处理过了。')
            : t('kb.glossary.candidate_adopt_failed', '确认入表失败，请稍后重试。'), 'warning');
        } else {
          setStatus(t('kb.glossary.candidate_adopted', '已入表：{wrong} → {correct}（之后参与扫描替换）', {
            wrong: result.entry.wrong,
            correct: result.entry.correct,
          }), '');
        }
      } catch (error) {
        log?.warn('candidate adopt failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.candidate_adopt_failed', '确认入表失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        await reload();
        opts.onChanged?.();
      }
    }

    async function discardCandidate(id) {
      if (state.busy) return;
      state.busy = true;
      try {
        render();
        await root.cogseed.invoke('transcript.glossary.discardCandidate', { id });
        setStatus(t('kb.glossary.candidate_discarded', '已丢弃该候选（不会进词表；模型再报同一对也不会重新翻出来）。'), '');
      } catch (error) {
        log?.warn('candidate discard failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.candidate_discard_failed', '丢弃失败，请稍后重试。'), 'warning');
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

    function parseImportText() {
      const raw = String(dialog.querySelector('#glo-import-text')?.value || '').trim();
      state.importText = raw;
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed?.payload && Array.isArray(parsed.payload.entries) ? parsed.payload : parsed;
      } catch (_) {
        return undefined; // 解析失败
      }
    }

    function previewImport() {
      const parsed = parseImportText();
      if (parsed === undefined) {
        state.importPreview = null;
        setStatus(t('kb.glossary.import_invalid_json', '导入内容不是合法 JSON。'), 'warning');
        render();
        return;
      }
      if (!parsed) {
        state.importPreview = null;
        setStatus(t('kb.glossary.import_empty', '这段内容里没有可导入的词条。'), 'warning');
        render();
        return;
      }
      const incoming = Array.isArray(parsed.entries) ? parsed.entries : [];
      state.importPreview = summarizeImport(state.entries, incoming, state.importMode);
      setStatus('', '');
      render();
    }

    async function applyImport() {
      if (state.busy) return;
      const parsed = parseImportText();
      if (parsed === undefined) {
        setStatus(t('kb.glossary.import_invalid_json', '导入内容不是合法 JSON。'), 'warning');
        return;
      }
      if (!parsed) return;
      const blocked = guardReason('apply-import', { hasImportPreview: Boolean(state.importPreview) });
      if (blocked) {
        setStatus(t(blocked.key, blocked.fallback), 'warning');
        render();
        return;
      }
      state.busy = true;
      try {
        render();
        const result = await root.cogseed.invoke('transcript.glossary.import', {
          payload: parsed,
          mode: state.importMode,
        });
        setStatus(t('kb.glossary.import_done', '导入完成：新增 {added} 条、更新 {updated} 条、跳过 {invalid} 条。', {
          added: Number(result?.added || 0),
          updated: Number(result?.updated || 0),
          invalid: Number(result?.invalid || result?.skipped || 0),
        }), '');
        state.importText = '';
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
        setStatus(t('kb.glossary.seed_initial_done', '初始词表已补全：新增 {created} 条、更新 {updated} 条{excluded}', {
          created: Number(result?.created || 0),
          updated: Number(result?.updated || 0),
          excluded: excluded.length
            ? t('kb.glossary.seed_initial_excluded', '；按方案刻意不入册：{list}', { list: excluded.join('、') })
            : '',
        }), '');
      } catch (error) {
        log?.warn('seed initial failed', { error: error?.message || String(error) });
        setStatus(t('kb.glossary.seed_initial_failed', '补全初始词表失败，请稍后重试。'), 'warning');
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

    function onClick(event) {
      const select = event.target.closest('[data-glo-select]');
      if (select) {
        const id = select.getAttribute('data-glo-select');
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
        render();
        return;
      }
      const toggle = event.target.closest('[data-glo-toggle]');
      if (toggle) {
        void toggleStatus(toggle.getAttribute('data-glo-toggle'), toggle.getAttribute('data-glo-status'));
        return;
      }
      const del = event.target.closest('[data-glo-delete]');
      if (del) { void deleteOne(del.getAttribute('data-glo-delete')); return; }
      const candAdopt = event.target.closest('[data-glo-candidate-adopt]');
      if (candAdopt) { void adoptCandidate(candAdopt.getAttribute('data-glo-candidate-adopt')); return; }
      const candDiscard = event.target.closest('[data-glo-candidate-discard]');
      if (candDiscard) { void discardCandidate(candDiscard.getAttribute('data-glo-candidate-discard')); return; }
      const action = event.target.closest('[data-glo-action]');
      if (!action) return;
      const kind = action.getAttribute('data-glo-action');
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
      } else if (kind === 'import-preview') {
        previewImport();
      } else if (kind === 'import-apply') {
        void applyImport();
      }
    }

    function onFilterChange(event) {
      if (event.target.id === 'glo-search') {
        state.filter.search = String(event.target.value || '');
        renderBulk();
        renderList();
        return;
      }
      if (event.target.id === 'glo-import-text') {
        state.importText = String(event.target.value || '');
        state.importPreview = null;
        renderIo();
        return;
      }
    }

    dialog.addEventListener('click', onClick);
    dialog.addEventListener('input', onFilterChange);
    dialog.addEventListener('change', onFilterChange);
    render();
    void reload();
    void loadMetrics().then(() => renderMetrics());

    return modal;
  }

  const api = {
    open,
    // 测试桥（仅纯函数）
    __test: { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf, guardReason },
    _internals: { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf, guardReason },
  };

  root.KbGlossaryManager = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf, guardReason };
  }
})(typeof window !== 'undefined' ? window : globalThis);
