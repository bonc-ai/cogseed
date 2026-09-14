/**
 * Transcript correction panel for the knowledge-base source viewer.
 *
 * 用户旅程（方案 v0.2 · 宿主 A）：在知识库工作台打开一份逐字稿（.txt/.md）→
 * 点击工具栏「转写纠错」→ 扫描出候选（原词 → 建议）→ 逐条接受/忽略 →
 * 「生成清理版」拿到 run 快照与对照表 → 可预览、可另存到知识库、可回滚。
 *
 * 设计边界（与主进程能力对齐）：
 *   - 本面板**只调用** transcript.* IPC；不直接读写文件、不改原文
 *     （主进程的 apply 只产出清理版 + run 快照，回滚也只返回原文）。
 *   - 高危（high）候选**不会**默认进清理版：必须显式勾选，并计入「待确认」。
 *   - 「另存到知识库」走既有的 library.writeText 通道，文件名带 runId 短号，
 *     永不覆盖原文件。
 *
 * Renderer 约束：classic script（无 JSX/bundler）、可见文案走 i18n、
 * 控件用共享原语（uiButton/uiField/uiEmptyState/uiModal）、图标来自 icons.js。
 */

(function initKbTranscriptCorrect(root) {
  'use strict';

  const log = typeof createLogger === 'function' ? createLogger('kb-transcript-correct') : null;
  const MAX_TEXT_CHARS = 400000;

  // ── i18n（缺键回退到中文默认文案，与 anchored-source-view 同款）────────
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

  // ── 纯函数（可测）────────────────────────────────────────────────────
  /** 把扫描候选（逐 span）聚合成词条行。 */
  function groupCandidates(candidates) {
    const byEntry = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const ref = String(candidate?.entryRef || '');
      if (!ref) continue;
      const row = byEntry.get(ref) || {
        entryRef: ref,
        wrong: String(candidate.wrong || ''),
        correct: String(candidate.correct || ''),
        action: candidate.action === 'delete' ? 'delete' : 'replace',
        riskLevel: candidate.riskLevel === 'high' || candidate.riskLevel === 'medium' ? candidate.riskLevel : 'low',
        count: 0,
        spans: [],
      };
      row.count += 1;
      if (candidate.span) row.spans.push(candidate.span);
      byEntry.set(ref, row);
    }
    return [...byEntry.values()].sort((a, b) => (b.count - a.count) || a.wrong.localeCompare(b.wrong));
  }

  /** 汇总选择状态：已选词条数 / 待确认高危 / 影响 span 数。 */
  function summarizeRows(rows, acceptedIds) {
    const accepted = acceptedIds instanceof Set ? acceptedIds : new Set(acceptedIds || []);
    let selected = 0;
    let spans = 0;
    let pendingHigh = 0;
    for (const row of rows || []) {
      if (accepted.has(row.entryRef)) {
        selected += 1;
        spans += row.count;
      } else if (row.riskLevel === 'high') {
        pendingHigh += 1;
      }
    }
    return { total: (rows || []).length, selected, spans, pendingHigh };
  }

  /** 分组：高危优先展示，其余归入可折叠组（视觉噪声主要来自低风险条目）。 */
  function splitByRisk(rows) {
    const high = [];
    const other = [];
    for (const row of rows || []) {
      if (row.riskLevel === 'high') high.push(row);
      else other.push(row);
    }
    return { high, other };
  }

  /** apply 结果的展示摘要。 */
  function applySummary(result) {
    const retention = Number.isFinite(Number(result?.retention)) ? Number(result.retention) : 1;
    return {
      changed: Array.isArray(result?.applied) && result.applied.length > 0,
      replaced: (result?.applied || []).filter((a) => a.action !== 'delete').reduce((n, a) => n + (a.count || 0), 0),
      deleted: (result?.applied || []).filter((a) => a.action === 'delete').reduce((n, a) => n + (a.count || 0), 0),
      pendingTotal: Number(result?.pendingTotal || 0),
      retention,
      overRewrite: Boolean(result?.overRewriteSuspected),
      status: result?.status === 'draft' ? 'draft' : 'applied',
    };
  }

  function riskKey(level) {
    if (level === 'high') return 'risk_high';
    if (level === 'medium') return 'risk_medium';
    return 'risk_low';
  }

  /** 清理版文件名：带 runId 短号，永不覆盖原文件。 */
  function cleanedFileName(displayPath, runId) {
    const base = String(displayPath || 'transcript').split(/[\\/]/).pop() || 'transcript';
    const stem = base.replace(/\.[^.]+$/, '') || 'transcript';
    const suffix = String(runId || '').replace(/^run_/, '').slice(0, 12) || 'draft';
    return `${stem}-cleaned-${suffix}.txt`;
  }

  // ── 面板 ─────────────────────────────────────────────────────────────
  function panelHtml() {
    return [
      '<div class="kb-atc">',
      '  <div class="kb-atc__head">',
      '    <div class="kb-atc__head-main">',
      '      <div class="kb-atc__title" data-atc-title></div>',
      '      <div class="kb-atc__meta" data-atc-meta></div>',
      '    </div>',
      '    <div class="kb-atc__head-actions" data-atc-head-actions></div>',
      '  </div>',
      '  <div class="kb-atc__status" data-atc-status hidden></div>',
      '  <div class="kb-atc__summary" data-atc-summary hidden></div>',
      '  <div class="kb-atc__body" data-atc-body></div>',
      '  <div class="kb-atc__actions" data-atc-actions></div>',
      '  <details class="kb-atc__add" data-atc-add>',
      '    <summary data-atc-add-summary></summary>',
      '    <div class="kb-atc__add-form" data-atc-add-form></div>',
      '  </details>',
      '</div>',
    ].join('');
  }

  function createPanel(container, ctx) {
    const state = {
      rows: [],
      accepted: new Set(),
      ignored: new Set(),
      scanned: false,
      busy: false,
      apply: null,
      runId: '',
      cleanedText: '',
      error: '',
      collapsedOther: false,
    };

    container.classList.add('kb-atc-host');
    container.innerHTML = panelHtml();
    const q = (selector) => container.querySelector(selector);

    function toast(message, variant) {
      if (typeof root.uiToast === 'function') {
        try { root.uiToast(message, { variant: variant || 'success' }); return; } catch (_) { /* 忽略 */ }
      }
      setStatus(message, variant === 'warning' ? 'warning' : '');
    }

    function setStatus(message, tone) {
      const host = q('[data-atc-status]');
      if (!host) return;
      host.textContent = message || '';
      host.hidden = !message;
      host.dataset.tone = tone || '';
    }

    function button(options) {
      // 一律走共享原语：本模块不得出现裸控件（见 shared-ui-adoption-guard）。
      return root.uiButton(options);
    }

    function renderHead() {
      const title = q('[data-atc-title]');
      const meta = q('[data-atc-meta]');
      const actions = q('[data-atc-head-actions]');
      if (title) title.textContent = t('kb.transcriptCorrect.title', '转写纠错');
      if (meta) {
        meta.textContent = t('kb.transcriptCorrect.meta', '{file} · {count} 字符', {
          file: ctx.displayPath || ctx.docId || '',
          count: ctx.text.length,
        });
      }
      if (actions) {
        // 次级操作贴着标题行右侧，避免单独占一行（视觉反馈：纵向留白更省）。
        actions.innerHTML = button({
          label: state.scanned
            ? t('kb.transcriptCorrect.rescan', '重新扫描')
            : t('kb.transcriptCorrect.scan', '扫描'),
          role: 'ghost',
          size: 'sm',
          disabled: state.busy,
          attrs: { 'data-atc-action': 'scan' },
        }) + button({
          label: t('kb.transcriptCorrect.add_entry', '新增词条'),
          role: 'ghost',
          size: 'sm',
          disabled: state.busy,
          attrs: { 'data-atc-action': 'toggle-add' },
        });
      }
    }

    /** 一行候选：原文（弱）→ 建议（强）·风险标签·命中次数（右对齐）。 */
    function rowElement(row) {
      const el = document.createElement('div');
      el.className = 'kb-atc__row';
      el.dataset.atcRow = row.entryRef;
      el.dataset.risk = row.riskLevel;
      if (state.accepted.has(row.entryRef)) el.classList.add('is-accepted');
      if (state.ignored.has(row.entryRef)) el.classList.add('is-ignored');

      const main = document.createElement('div');
      main.className = 'kb-atc__row-main';
      const wrong = document.createElement('span');
      wrong.className = 'kb-atc__wrong';
      wrong.textContent = row.wrong;
      const arrow = document.createElement('span');
      arrow.className = 'kb-atc__arrow';
      arrow.textContent = row.action === 'delete'
        ? t('kb.transcriptCorrect.delete_arrow', '（删除）')
        : '→';
      const correct = document.createElement('span');
      correct.className = 'kb-atc__correct';
      correct.textContent = row.action === 'delete' ? '' : row.correct;
      main.append(wrong, arrow, correct);

      if (row.riskLevel !== 'low') {
        const badge = document.createElement('span');
        badge.className = 'kb-atc__badge';
        badge.textContent = t(`kb.transcriptCorrect.${riskKey(row.riskLevel)}`, row.riskLevel === 'high' ? '高危' : '谨慎');
        main.appendChild(badge);
      }

      const count = document.createElement('span');
      count.className = 'kb-atc__count';
      count.textContent = `×${row.count}`;

      const actions = document.createElement('div');
      actions.className = 'kb-atc__row-actions';
      const isAccepted = state.accepted.has(row.entryRef);
      const isIgnored = state.ignored.has(row.entryRef);
      // 高危行用纯文字按钮（hover 才出底色），把横向空间让给内容。
      const acceptRole = isAccepted ? 'primary' : (row.riskLevel === 'high' ? 'ghost' : 'secondary');
      actions.innerHTML = [
        button({
          label: isAccepted
            ? t('kb.transcriptCorrect.accepted', '已接受')
            : t('kb.transcriptCorrect.accept', '接受'),
          role: acceptRole,
          size: 'sm',
          className: 'kb-atc__btn',
          disabled: state.busy || isIgnored,
          attrs: { 'data-atc-accept': row.entryRef },
        }),
        button({
          label: t('kb.transcriptCorrect.ignore', '忽略'),
          role: 'ghost',
          size: 'sm',
          className: 'kb-atc__btn',
          disabled: state.busy || isAccepted,
          attrs: { 'data-atc-ignore': row.entryRef },
        }),
      ].join('');

      el.append(main, count, actions);
      return el;
    }

    function groupHeaderElement(label, tone) {
      const el = document.createElement('div');
      el.className = 'kb-atc__group';
      if (tone) el.dataset.tone = tone;
      el.textContent = label;
      return el;
    }

    /** 折叠组头：用按钮而非裸控件，便于键盘与样式统一。 */
    function groupToggleElement(label, collapsed) {
      const host = document.createElement('div');
      host.className = 'kb-atc__group kb-atc__group--toggle';
      host.innerHTML = button({
        label,
        icon: collapsed ? 'chevron-right' : 'chevron-down',
        role: 'ghost',
        size: 'sm',
        className: 'kb-atc__group-btn',
        attrs: { 'data-atc-action': 'toggle-other' },
      });
      return host;
    }

    function renderBody() {
      const body = q('[data-atc-body]');
      if (!body) return;
      body.textContent = '';
      if (state.error) {
        body.innerHTML = typeof root.uiEmptyState === 'function'
          ? root.uiEmptyState({ kind: 'quiet', title: state.error })
          : '';
        if (!body.innerHTML) body.textContent = state.error;
        return;
      }
      if (!state.scanned) {
        body.innerHTML = typeof root.uiEmptyState === 'function'
          ? root.uiEmptyState({
            kind: 'actionable',
            title: t('kb.transcriptCorrect.idle_title', '扫描这份逐字稿里需要纠正的词'),
            description: t('kb.transcriptCorrect.idle_desc', '只会替换你词表里确认过的词；原文不会被改动。'),
            action: { label: t('kb.transcriptCorrect.scan', '扫描'), attrs: { 'data-atc-action': 'scan' } },
          })
          : '';
        return;
      }
      if (state.rows.length === 0) {
        body.innerHTML = typeof root.uiEmptyState === 'function'
          ? root.uiEmptyState({
            kind: 'quiet',
            title: t('kb.transcriptCorrect.no_hits', '没有发现需要纠正的词'),
            description: t('kb.transcriptCorrect.no_hits_desc', '可以在下方新增词条后再扫描。'),
          })
          : '';
        return;
      }

      const { high, other } = splitByRisk(state.rows);
      if (high.length) {
        body.appendChild(groupHeaderElement(
          t('kb.transcriptCorrect.group_high', '高危 {count} 条 · 逐条确认', { count: high.length }),
          'high',
        ));
        for (const row of high) body.appendChild(rowElement(row));
      }
      if (other.length) {
        body.appendChild(groupToggleElement(
          state.collapsedOther
            ? t('kb.transcriptCorrect.group_other_collapsed', '其余 {count} 条（已折叠）', { count: other.length })
            : t('kb.transcriptCorrect.group_other', '其余 {count} 条', { count: other.length }),
          state.collapsedOther,
        ));
        if (!state.collapsedOther) {
          for (const row of other) body.appendChild(rowElement(row));
        }
      }
    }

    function renderSummary() {
      const host = q('[data-atc-summary]');
      if (!host) return;
      const stats = summarizeRows(state.rows, state.accepted);
      if (!state.scanned || stats.total === 0) {
        host.hidden = true;
        host.textContent = '';
        return;
      }
      const parts = [t('kb.transcriptCorrect.summary', '已选 {selected}/{total} 条 · 影响 {spans} 处', stats)];
      if (stats.pendingHigh > 0) parts.push(t('kb.transcriptCorrect.pending_high', '{count} 条高危待确认', { count: stats.pendingHigh }));
      host.hidden = false;
      host.textContent = parts.join(' · ');
    }

    function renderApplyInfo() {
      const host = q('[data-atc-summary]');
      if (!host || !state.apply) return;
      const info = applySummary(state.apply);
      const parts = [
        t('kb.transcriptCorrect.applied_summary', '已替换 {replaced} 处', { replaced: info.replaced }),
      ];
      if (info.deleted) parts.push(t('kb.transcriptCorrect.applied_deleted', '删除口癖 {deleted} 处', { deleted: info.deleted }));
      parts.push(t('kb.transcriptCorrect.retention', '字符保留率 {percent}%', { percent: (info.retention * 100).toFixed(1) }));
      if (info.pendingTotal) parts.push(t('kb.transcriptCorrect.applied_pending', '待确认 {count} 条', { count: info.pendingTotal }));
      if (info.overRewrite) parts.push(t('kb.transcriptCorrect.over_rewrite', '疑似过度改写'));
      host.hidden = false;
      host.textContent = parts.join(' · ');
    }

    function renderActions() {
      const host = q('[data-atc-actions]');
      if (!host) return;
      const buttons = [];
      buttons.push(button({
        label: state.busy
          ? t('kb.transcriptCorrect.applying', '正在生成…')
          : t('kb.transcriptCorrect.apply', '生成清理版'),
        icon: 'check-circle',
        role: 'primary',
        size: 'sm',
        disabled: state.busy || state.accepted.size === 0,
        loading: state.busy,
        attrs: { 'data-atc-action': 'apply' },
      }));
      if (state.cleanedText) {
        buttons.push(button({
          label: t('kb.transcriptCorrect.preview', '预览清理版'),
          icon: 'file-text',
          role: 'secondary',
          size: 'sm',
          attrs: { 'data-atc-action': 'preview' },
        }));
        buttons.push(button({
          label: t('kb.transcriptCorrect.save', '另存到知识库'),
          icon: 'folder-open',
          role: 'secondary',
          size: 'sm',
          attrs: { 'data-atc-action': 'save' },
        }));
        buttons.push(button({
          label: t('kb.transcriptCorrect.revert', '回滚',
          ),
          icon: 'x-circle',
          role: 'ghost',
          size: 'sm',
          attrs: { 'data-atc-action': 'revert' },
        }));
      }
      host.innerHTML = buttons.join('');
    }

    function renderAddForm() {
      const host = q('[data-atc-add-form]');
      if (!host) return;
      const summary = q('[data-atc-add-summary]');
      if (summary) summary.textContent = t('kb.transcriptCorrect.add_entry', '新增词条');
      if (typeof root.uiField !== 'function') { host.textContent = ''; return; }
      // uiField 契约：{ id, label, control: { kind, ... } } —— 顶层 kind 无效。
      try {
        host.innerHTML = [
          root.uiField({
            id: 'atc-wrong',
            label: t('kb.transcriptCorrect.wrong', '转写里出现的错词'),
            control: { kind: 'input', placeholder: 'coxy' },
          }),
          root.uiField({
            id: 'atc-correct',
            label: t('kb.transcriptCorrect.correct', '正确写法'),
            control: { kind: 'input', placeholder: 'Cogseed' },
          }),
          root.uiField({
            id: 'atc-kind',
            label: t('kb.transcriptCorrect.kind', '类别'),
            control: {
              kind: 'select',
              value: 'product',
              options: [
                { value: 'product', label: t('kb.transcriptCorrect.kind_product', '产品/项目') },
                { value: 'people', label: t('kb.transcriptCorrect.kind_people', '人名') },
                { value: 'org', label: t('kb.transcriptCorrect.kind_org', '组织') },
                { value: 'term', label: t('kb.transcriptCorrect.kind_term', '术语') },
                { value: 'course', label: t('kb.transcriptCorrect.kind_course', '课程') },
              ],
            },
          }),
          button({
            label: t('kb.transcriptCorrect.add', '加入词表'),
            icon: 'check-circle',
            role: 'secondary',
            size: 'sm',
            disabled: state.busy,
            attrs: { 'data-atc-action': 'add' },
          }),
        ].join('');
        // select 需要水合才可交互（与其它页面同一套 shared-ui 流程）。
        if (typeof root.hydrateUiFormSelects === 'function') root.hydrateUiFormSelects(host);
      } catch (error) {
        log?.warn('add-entry form render failed', { error: error?.message || String(error) });
        host.textContent = '';
      }
    }

    function render() {
      // 逐段尝试渲染：某个共享原语抛错时，不得连带把扫描/替换流程卡死
      // （真实事故：uiField 缺 id 抛错 → render() 在 runScan 的 try 之外抛出，
      //  扫描永远停在"正在扫描…"）。
      for (const step of [renderHead, renderBody, renderSummary, renderApplyInfo, renderActions, renderAddForm]) {
        try {
          step();
        } catch (error) {
          log?.warn('panel render step failed', { step: step.name, error: error?.message || String(error) });
        }
      }
    }

    // ── 动作 ──────────────────────────────────────────────────────────
    async function runScan() {
      if (state.busy) return;
      state.busy = true;
      state.error = '';
      setStatus(t('kb.transcriptCorrect.scanning', '正在扫描…'), 'loading');
      render();
      try {
        const result = await root.cogseed.invoke('transcript.correct.scan', {
          text: ctx.text,
          docId: ctx.docId,
          ...(Array.isArray(ctx.scenarioTags) && ctx.scenarioTags.length ? { scenarioTags: ctx.scenarioTags } : {}),
        });
        state.rows = groupCandidates(result?.candidates);
        state.scanned = true;
        state.accepted = new Set(state.rows.filter((row) => row.riskLevel === 'low').map((row) => row.entryRef));
        state.ignored = new Set();
        state.apply = null;
        state.cleanedText = '';
        state.collapsedOther = false;
        const stats = summarizeRows(state.rows, state.accepted);
        setStatus(stats.total === 0
          ? ''
          : t('kb.transcriptCorrect.scan_done', '扫描完成：{total} 条候选', { total: stats.total }), '');
      } catch (error) {
        log?.warn('transcript scan failed', { error: error?.message || String(error) });
        state.scanned = true;
        state.rows = [];
        state.error = t('kb.transcriptCorrect.scan_failed', '扫描失败，请稍后重试。');
        setStatus(state.error, 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function runApply() {
      if (state.busy || state.accepted.size === 0) return;
      state.busy = true;
      setStatus(t('kb.transcriptCorrect.applying', '正在生成…'), 'loading');
      render();
      try {
        const result = await root.cogseed.invoke('transcript.correct.apply', {
          text: ctx.text,
          docId: ctx.docId,
          acceptedIds: [...state.accepted],
        });
        state.apply = result?.result || null;
        state.runId = String(result?.run?.runId || '');
        state.cleanedText = String(result?.result?.text || '');
        setStatus(t('kb.transcriptCorrect.apply_done', '清理版已生成（原文未改动）'), '');
      } catch (error) {
        log?.warn('transcript apply failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.apply_failed', '生成失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    function openTextModal(title, text) {
      if (typeof root.uiModal !== 'function') return;
      // uiModal 的内容只能经 bodyHtml 注入；用户文本用 textContent 落地，避免 HTML 注入。
      const modal = root.uiModal({
        title,
        size: 'lg',
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        bodyHtml: '<pre class="kb-atc__preview" data-atc-preview></pre>',
        actions: [],
      });
      const host = modal?.dialog?.querySelector('[data-atc-preview]');
      if (host) host.textContent = text;
      return modal;
    }

    async function runSave() {
      if (state.busy || !state.cleanedText) return;
      state.busy = true;
      render();
      try {
        const targetPath = cleanedFileName(ctx.displayPath, state.runId);
        const result = await root.cogseed.invoke('library.writeText', { content: state.cleanedText, targetPath });
        if (result?.ok === false) throw new Error(result.error || 'write failed');
        toast(t('kb.transcriptCorrect.saved', '已保存到知识库：{name}', { name: targetPath }));
      } catch (error) {
        log?.warn('cleaned transcript save failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.save_failed', '保存失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function runRevert() {
      if (state.busy || !state.runId) return;
      state.busy = true;
      render();
      try {
        const result = await root.cogseed.invoke('transcript.run.revert', { runId: state.runId });
        openTextModal(
          t('kb.transcriptCorrect.revert_title', '本次清理的原文（未改动）'),
          String(result?.text || ''),
        );
        setStatus(result?.sha1Matched
          ? t('kb.transcriptCorrect.revert_ok', '已回滚：快照校验通过，原文保持不变。')
          : t('kb.transcriptCorrect.revert_mismatch', '回滚快照校验不一致，请人工确认。'), result?.sha1Matched ? '' : 'warning');
      } catch (error) {
        log?.warn('transcript revert failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.revert_failed', '回滚失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function runAddEntry() {
      const wrongInput = container.querySelector('#atc-wrong');
      const correctInput = container.querySelector('#atc-correct');
      // uiSelect 由 shared-ui 水合为 AiSelect：值从挂载后的 api 读取。
      const kindHost = container.querySelector('#atc-kind');
      const kind = String(kindHost?._uiSelectApi?.getValue?.() || 'product');
      const wrong = String(wrongInput?.value || '').trim();
      const correct = String(correctInput?.value || '').trim();
      if (!wrong || !correct) {
        setStatus(t('kb.transcriptCorrect.need_both', '请同时填写错词与正确写法。'), 'warning');
        return;
      }
      try {
        const result = await root.cogseed.invoke('transcript.glossary.upsert', {
          wrong,
          correct,
          kind,
          source: 'manual',
        });
        if (result?.skippedReason === 'pure_digit_variant') {
          setStatus(t('kb.transcriptCorrect.reject_digits', '纯数字变体不入册（无法与真实数字区分）。'), 'warning');
          return;
        }
        setStatus(t('kb.transcriptCorrect.added', '已加入词表：{wrong} → {correct}', { wrong, correct }), '');
        if (wrongInput) wrongInput.value = '';
        if (correctInput) correctInput.value = '';
        await runScan();
      } catch (error) {
        log?.warn('glossary upsert failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.add_failed', '加入词表失败，请稍后重试。'), 'warning');
      }
    }

    function onClick(event) {
      const toggleAdd = event.target.closest('[data-atc-action="toggle-add"]');
      if (toggleAdd) {
        const details = container.querySelector('[data-atc-add]');
        if (details) details.open = !details.open;
        return;
      }
      const accept = event.target.closest('[data-atc-accept]');
      if (accept) {
        const ref = accept.getAttribute('data-atc-accept');
        if (state.accepted.has(ref)) state.accepted.delete(ref);
        else { state.accepted.add(ref); state.ignored.delete(ref); }
        render();
        return;
      }
      const ignore = event.target.closest('[data-atc-ignore]');
      if (ignore) {
        const ref = ignore.getAttribute('data-atc-ignore');
        state.ignored.add(ref);
        state.accepted.delete(ref);
        render();
        return;
      }
      const action = event.target.closest('[data-atc-action]');
      if (!action) return;
      const kind = action.getAttribute('data-atc-action');
      if (kind === 'scan') void runScan();
      else if (kind === 'toggle-other') { state.collapsedOther = !state.collapsedOther; render(); }
      else if (kind === 'apply') void runApply();
      else if (kind === 'preview') openTextModal(t('kb.transcriptCorrect.preview_title', '清理版预览'), state.cleanedText);
      else if (kind === 'save') void runSave();
      else if (kind === 'revert') void runRevert();
      else if (kind === 'add') void runAddEntry();
    }

    container.addEventListener('click', onClick);
    render();

    return {
      destroy() { container.removeEventListener('click', onClick); },
      getState() { return state; },
    };
  }

  const api = {
    mount(container, ctx) {
      if (!container) throw new Error('kb transcript correct: container required');
      if (!root.cogseed || typeof root.cogseed.invoke !== 'function') throw new Error('kb transcript correct: ipc unavailable');
      if (typeof root.uiButton !== 'function') throw new Error('kb transcript correct: shared ui primitives unavailable');
      const text = String(ctx?.text || '');
      if (!text) throw new Error('kb transcript correct: text required');
      if (text.length > MAX_TEXT_CHARS) throw new Error('kb transcript correct: text too long');
      return createPanel(container, {
        text,
        docId: String(ctx?.docId || ctx?.displayPath || 'transcript'),
        displayPath: String(ctx?.displayPath || ''),
        scenarioTags: Array.isArray(ctx?.scenarioTags) ? ctx.scenarioTags : [],
      });
    },
    // 测试桥（仅纯函数；DOM/IPC 逻辑不进测试桥）
    __test: { groupCandidates, summarizeRows, splitByRisk, applySummary, cleanedFileName, riskKey },
  };

  root.KbTranscriptCorrect = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { groupCandidates, summarizeRows, splitByRisk, applySummary, cleanedFileName, riskKey };
  }
})(typeof window !== 'undefined' ? window : globalThis);
