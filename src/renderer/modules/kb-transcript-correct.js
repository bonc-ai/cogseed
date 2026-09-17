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
 *   - 「另存到知识库」走既有的 library.writeText 通道：落在原文**同一个目录**、
 *     文件名加 i18n 后缀（zh `清理版`），永不覆盖原文件；内容级 sha1 去重命中时
 *     不重复写盘，并把已有文件的确切路径告知用户。
 *   - 另存成功后由本面板**显式**请求库视图重载目录树（`notifyLibraryChanged`）：
 *     库列表渲染的是进入视图时的树快照，不通知就会出现"另存了却找不到文件"
 *     （2026-09-16 真机反馈）。
 *
 * Renderer 约束：classic script（无 JSX/bundler）、可见文案走 i18n、
 * 控件用共享原语（uiButton/uiField/uiEmptyState/uiModal）、图标来自 icons.js。
 */

(function initKbTranscriptCorrect(root) {
  'use strict';

  const log = typeof createLogger === 'function' ? createLogger('kb-transcript-correct') : null;
  const MAX_TEXT_CHARS = 400000;

  // 共享 uiCheckbox 要求唯一 id；面板可能同时挂载多次（多文件对比），故按实例计数。
  let panelSeq = 0;

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
        ignoredCount: Number(candidate.ignoredCount || 0),
        contextAllow: Array.isArray(candidate.contextAllow) ? candidate.contextAllow.map(String) : [],
        context: String(candidate.context || ''),
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

  /**
   * 分组：高危优先展示，其余归入可折叠组（视觉噪声主要来自低风险条目），
   * 被忽略过的词条另外折叠到最后——这就是方案里的"忽略（降权）"，
   * 不是删除：用户仍能展开看到并恢复。
   */
  function splitByRisk(rows) {
    const high = [];
    const other = [];
    const ignored = [];
    for (const row of rows || []) {
      if (Number(row.ignoredCount || 0) > 0) ignored.push(row);
      else if (row.riskLevel === 'high') high.push(row);
      else other.push(row);
    }
    return { high, other, ignored };
  }

  /** 默认勾选的行：低风险且未被忽略（被忽略的词条降权，不默认重来一遍）。 */
  function defaultAcceptedIds(rows) {
    return (rows || [])
      .filter((row) => row.riskLevel === 'low' && Number(row.ignoredCount || 0) === 0)
      .map((row) => row.entryRef);
  }

  /**
   * 概念键：与主进程 `conceptKeyOf` 同规则（NFKC + 小写 + 抹掉一切分隔符号）。
   * `KSTAR`/`K-STAR`/`K star` 是同一个概念；同一个概念的多种错形必须归到一起，
   * 否则面板会把它们当互不相关的行，也会和本体里的规范名对不上。
   */
  function conceptKeyOfCorrect(text) {
    return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  /** 把候选行按概念归组（同一 correct → 同一概念），命中多的概念在前。 */
  function groupRowsByConcept(rows) {
    const byKey = new Map();
    for (const row of rows || []) {
      if (row?.action === 'delete') continue;
      const key = conceptKeyOfCorrect(row?.correct);
      if (!key) continue;
      const bucket = byKey.get(key) || { conceptKey: key, display: String(row.correct || ''), spans: 0, rows: 0 };
      bucket.spans += Number(row.count || 0);
      bucket.rows += 1;
      byKey.set(key, bucket);
    }
    return [...byKey.values()].sort((a, b) => (b.spans - a.spans) || a.display.localeCompare(b.display));
  }

  /**
   * 本体同步结果的展示摘要（纯函数）：
   * 只做形状收敛 + 过滤，不拼文案（文案走 i18n，在渲染层组装）。
   */
  function syncSummary(sync) {
    const raw = sync || {};
    const groups = Array.isArray(raw.groups) ? raw.groups : [];
    const alignments = (Array.isArray(raw.alignments) ? raw.alignments : [])
      .filter((item) => item && item.kind === 'canonical_spelling')
      .map((item) => ({
        entryId: String(item.entryId || ''),
        wrong: String(item.wrong || ''),
        current: String(item.currentCorrect || ''),
        suggested: String(item.suggestedCorrect || ''),
        source: item.source === 'memory' ? 'memory' : 'ontology',
      }))
      .filter((item) => item.entryId && item.suggested);
    const missing = (Array.isArray(raw.missing) ? raw.missing : [])
      .filter((item) => item && item.kind === 'missing_entry')
      .map((item) => ({
        conceptKey: conceptKeyOfCorrect(item.correct),
        correct: String(item.correct || ''),
      }))
      .filter((item) => item.conceptKey && item.correct);
    const canonicalNames = Number(raw.canonicalNames || 0);
    const rawStats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    const hasStats = typeof rawStats.ontologyValues === 'number'
      || typeof rawStats.ontologyFields === 'number'
      || typeof rawStats.memoryEntries === 'number';
    const stats = {
      ontologyValues: Number(rawStats.ontologyValues || 0),
      ontologyFields: Number(rawStats.ontologyFields || 0),
      memoryEntries: Number(rawStats.memoryEntries || 0),
    };
    return {
      stats,
      conceptGroups: groups.slice(0, 8).map((group) => ({
        display: String(group?.display || ''),
        count: Number(group?.entryCount || 0),
      })),
      groupCount: groups.length,
      linked: Number(raw.linked || 0),
      alignments,
      missing,
      contributed: Number(raw.contributed || 0),
      canonicalNames,
      /**
       * 本体与记忆都为空：本次同步什么都没改，界面必须如实说，不能装作做了事。
       * 主进程没给 stats（旧载荷）时退回"按规范名总数判断"，免得界面凭空数据
       * 断言"你什么都没有"。
       */
      noSources: hasStats
        ? (stats.ontologyValues === 0 && stats.memoryEntries === 0)
        : canonicalNames === 0,
      /** 只有结构标签（分组标题/字段名）：也没有可用的规范名，但说法要不一样。 */
      structureOnly: hasStats
        && stats.ontologyValues === 0
        && stats.memoryEntries === 0
        && stats.ontologyFields > 0,
    };
  }

  /**
   * 对照视图分段（纯函数）：按 offsetMap 把原文与清理版切成 keep / changed / deleted。
   * `changed` = 被替换或被插入标记；`deleted` 只在原文侧出现（口癖删除）。
   * 不复用 diff 算法——offsetMap 就是权威事实，重新算 diff 只会引入不一致。
   */
  function buildDiffPanes(beforeText, afterText, offsetMap) {
    const before = String(beforeText || '');
    const after = String(afterText || '');
    const segments = Array.isArray(offsetMap) ? offsetMap : [];
    const panes = { before: [], after: [], changedCount: 0, deletedCount: 0 };
    if (!segments.length) {
      panes.before.push({ kind: 'keep', text: before });
      panes.after.push({ kind: 'keep', text: after });
      return panes;
    }
    let beforeCursor = 0;
    let afterCursor = 0;
    const pushPane = (side, kind, text) => {
      if (!text) return;
      const list = panes[side];
      const last = list[list.length - 1];
      if (last && last.kind === kind) last.text += text;
      else list.push({ kind, text });
    };
    for (const seg of segments) {
      if (!seg || typeof seg.inStart !== 'number') continue;
      pushPane('before', 'keep', before.slice(beforeCursor, seg.inStart));
      pushPane('after', 'keep', after.slice(afterCursor, seg.outStart));
      const inText = before.slice(seg.inStart, seg.inEnd);
      const outText = after.slice(seg.outStart, seg.outEnd);
      if (seg.kind === 'delete') {
        pushPane('before', 'deleted', inText);
        panes.deletedCount += 1;
      } else if (seg.kind === 'replace') {
        pushPane('before', 'changed', inText);
        pushPane('after', 'changed', outText);
        panes.changedCount += 1;
      } else {
        pushPane('before', 'keep', inText);
        pushPane('after', 'keep', outText);
      }
      beforeCursor = seg.inEnd;
      afterCursor = seg.outEnd;
    }
    pushPane('before', 'keep', before.slice(beforeCursor));
    pushPane('after', 'keep', after.slice(afterCursor));
    return panes;
  }

  /** 待核项的展示摘要（纯函数）：条数、去重后的原词数、按理由分档。 */
  function flaggedSummary(flagged) {
    const list = Array.isArray(flagged) ? flagged : [];
    const byReason = {};
    const texts = new Set();
    for (const item of list) {
      const reason = String(item?.reason || 'unknown_entity');
      byReason[reason] = (byReason[reason] || 0) + 1;
      if (item?.text) texts.add(String(item.text));
    }
    return { count: list.length, distinct: texts.size, byReason };
  }

  /** 同位置重复标记要去重：一处只留一条待核（否则清理版会插两个标记）。 */
  function mergeFlagged(existing, incoming) {
    const seen = new Set((existing || []).map((i) => `${i.span?.start}|${i.span?.end}|${i.reason}`));
    const out = [...(existing || [])];
    for (const item of incoming || []) {
      const key = `${item?.span?.start}|${item?.span?.end}|${item?.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
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

  /**
   * 分类另存结果（纯函数，便于单测）：
   *   saved     —— 写入成功
   *   duplicate —— 库里已有相同内容（main 返回 code=duplicate_content + existingDir）
   *   retry     —— 同名冲突，可换 -2/-3 后缀重试
   *   failed    —— 其它错误
   */
  function classifySaveResult(result) {
    if (!result || result.ok !== false) return { kind: 'saved', path: String(result?.path || '') };
    const code = String(result.code || '');
    if (code === 'duplicate_content') {
      return {
        kind: 'duplicate',
        existingDir: String(result.existingDir || ''),
        // 去重命中时把**已有文件的确切路径**带出来：只说"在某个目录下"用户还是
        // 找不到（真机反馈），必须能给到一个可以直接去看的文件。
        existingPath: String(result.existingPath || ''),
      };
    }
    const message = String(result.error || '');
    if (/同名文件已存在|already exists|exist/i.test(message)) return { kind: 'retry', message };
    return { kind: 'failed', message };
  }

  /**
   * 请知识库视图重载它的目录树。
   *
   * 库列表（`contexts.js` 的资源树 / `kb-workbench.js` 的个人知识库文件列表）
   * 渲染的是**各自进入视图时拍的树快照**，main 侧写盘只回一条全局 kb.events
   * 状态事件。本面板另存的文件因此不会自己出现在列表里——真机反馈就是
   * 「另存到知识库了却找不到文件」。写入方负责显式通知，才能立刻看到。
   * 用内联的 typeof 守卫而不是固定引用：两个模块可能未加载（其他视图下面板也可用）。
   */
  function notifyLibraryChanged() {
    try {
      if (typeof root.loadContexts === 'function') root.loadContexts();
      if (typeof root.renderKbWorkbench === 'function') root.renderKbWorkbench();
    } catch (error) {
      log?.warn('library refresh after save failed', { error: error?.message || String(error) });
    }
  }

  function riskKey(level) {
    if (level === 'high') return 'risk_high';
    if (level === 'medium') return 'risk_medium';
    return 'risk_low';
  }

  /**
   * 清理版目标路径：**放在原文同一个目录**，名字尽量短且一眼可认。
   *   例：`1/9.15站会.txt` → `1/9.15站会-清理版.txt`
   * 同日再次另存由 nextCandidateName 追加 -2/-3（不覆盖上一次产物）。
   * 后缀走 i18n（zh=清理版 / en=cleaned …），因为它是用户直接看到的文件名。
   */
  function cleanedFileName(displayPath, suffix, extension) {
    const raw = String(displayPath || 'transcript');
    const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    const dir = cut >= 0 ? raw.slice(0, cut + 1) : '';
    const base = cut >= 0 ? raw.slice(cut + 1) : raw;
    const stem = (base || 'transcript').replace(/\.[^.]+$/, '') || 'transcript';
    const tail = String(suffix || '').trim() || 'cleaned';
    const ext = String(extension || 'txt').replace(/^\./, '') || 'txt';
    return `${dir}${stem}-${tail}.${ext}`;
  }

  /** 同分钟重复另存时给出 -2/-3 候选名，避免覆盖上一次的产物。 */
  function nextCandidateName(targetPath, attempt) {
    if (!attempt) return targetPath;
    return targetPath.replace(/(\.[^.]+)$/, `-${attempt + 1}$1`);
  }

  // ── 面板 ─────────────────────────────────────────────────────────────
  function panelHtml() {
    return [
      '<div class="kb-atc">',
      '  <div class="kb-atc__head">',
      '    <div class="kb-atc__head-main">',
      '      <div class="kb-atc__title" data-atc-title></div>',
      '      <div class="kb-atc__meta" data-atc-meta title=""></div>',
      '      <div class="kb-atc__hint" data-atc-hint></div>',
      '    </div>',
      '    <div class="kb-atc__head-actions" data-atc-head-actions></div>',
      '  </div>',
      '  <div class="kb-atc__status" data-atc-status hidden></div>',
      '  <div class="kb-atc__summary" data-atc-summary hidden></div>',
      '  <div class="kb-atc__body" data-atc-body></div>',
      '  <div class="kb-atc__scope" data-atc-scope></div>',
      '  <div class="kb-atc__actions" data-atc-actions></div>',
      '  <details class="kb-atc__issues" data-atc-issues>',
      '    <summary data-atc-issues-summary></summary>',
      '    <div class="kb-atc__issues-body" data-atc-issues-body></div>',
      '  </details>',
      '  <details class="kb-atc__sync" data-atc-sync>',
      '    <summary data-atc-sync-summary></summary>',
      '    <div class="kb-atc__sync-body" data-atc-sync-body></div>',
      '  </details>',
      '  <details class="kb-atc__add" data-atc-add>',
      '    <summary data-atc-add-summary></summary>',
      '    <div class="kb-atc__add-form" data-atc-add-form></div>',
      '  </details>',
      '</div>',
    ].join('');
  }

  function createPanel(container, ctx) {
    const panelId = ++panelSeq;
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
      savedPath: '',
      // 本体/记忆接线（P1）：sync = 主进程 SyncResult 原样，呈现交给 syncSummary
      sync: null,
      syncBusy: false,
      syncError: '',
      seedOpen: '',
      // 未决项（待核，方案 §4.3）：span 一律是**原文**坐标，apply 时由主进程映射
      flagged: [],
      truncated: false,
      scanDoneAt: 0,
      notesText: '',
      compareBusy: false,
      llmCandidates: [],
      llmBusy: false,
      llmNote: '',
      headings: [],
      headingBusy: false,
      // 接受的三个动作（方案 §七）：范围 / 忽略 / 加白 / 改写法
      scopeChoice: 'keep',
      // 同人段落合并（方案 §五 P1-2）：默认开——它是"清理版"能不能真正好用的关键
      mergeSpeaker: true,
      rowMenu: '',
      allowOpen: '',
      allowDraft: '',
      renameOpen: '',
      renameDraft: '',
      denied: [],
      showDenied: false,
      actionError: '',
      suspects: [],
      suspectBusy: false,
      suspectError: '',
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
        // 规范 §四-3：文件名过长时只显示尾段，hover 才给完整路径（title 属性）
        const full = ctx.displayPath || ctx.docId || '';
        const shortName = full.split(/[\\/]/).filter(Boolean).pop() || full;
        meta.textContent = t('kb.transcriptCorrect.meta', '{file} · {count} 字符', {
          file: shortName,
          count: ctx.text.length,
        });
        meta.setAttribute('title', t('kb.transcriptCorrect.meta_full', '完整路径：{path}（{count} 字符）', {
          path: full,
          count: ctx.text.length,
        }));
      }
      const hint = q('[data-atc-hint]');
      if (hint) {
        // 规范 §四-1：标题下给一句"这个面板是干什么的"
        hint.textContent = t(
          'kb.transcriptCorrect.panel_hint',
          '只替换你词表里确认过的词；原文不会被改动，生成的清理版是另一份文件。',
        );
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
        }) + button({
          label: t('kb.glossary.title', '词表'),
          icon: 'list',
          role: 'ghost',
          size: 'sm',
          disabled: state.busy,
          attrs: { 'data-atc-action': 'open-glossary' },
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

      const flaggedSpans = (row.spans || []).filter((span) => state.flagged.some(
        (issue) => issue.span?.start === span.start && issue.span?.end === span.end,
      ));
      if (flaggedSpans.length) {
        el.classList.add('is-flagged');
        const badge = document.createElement('span');
        badge.className = 'kb-atc__badge kb-atc__badge--issue';
        badge.textContent = t('kb.transcriptCorrect.issue_badge', '待核');
        main.appendChild(badge);
      }

      const count = document.createElement('span');
      count.className = 'kb-atc__count';
      count.textContent = `×${row.count}`;

      const actions = document.createElement('div');
      actions.className = 'kb-atc__row-actions';
      const isAccepted = state.accepted.has(row.entryRef);
      // 高危行用纯文字按钮（hover 才出底色），把横向空间让给内容。
      const acceptRole = isAccepted ? 'primary' : (row.riskLevel === 'high' ? 'ghost' : 'secondary');
      const isIgnoredRow = Number(row.ignoredCount || 0) > 0;
      actions.innerHTML = [
        button({
          label: isAccepted
            ? t('kb.transcriptCorrect.accepted', '已接受')
            : t('kb.transcriptCorrect.accept', '接受'),
          role: acceptRole,
          size: 'sm',
          className: 'kb-atc__btn',
          disabled: state.busy,
          attrs: { 'data-atc-accept': row.entryRef },
        }),
        button({
          label: isIgnoredRow
            ? t('kb.transcriptCorrect.restore', '恢复')
            : t('kb.transcriptCorrect.ignore', '忽略'),
          role: 'ghost',
          size: 'sm',
          className: 'kb-atc__btn',
          disabled: state.busy,
          attrs: { 'data-atc-ignore': row.entryRef, 'data-atc-ignored': isIgnoredRow ? '1' : '0' },
        }),
        button({
          label: t('kb.transcriptCorrect.more', '更多'),
          icon: state.rowMenu === row.entryRef ? 'chevron-down' : 'chevron-right',
          role: 'ghost',
          size: 'sm',
          className: 'kb-atc__btn',
          attrs: { 'data-atc-rowmenu': row.entryRef },
        }),
      ].join('');

      el.append(main, count, actions);
      if (state.rowMenu === row.entryRef) {
        el.appendChild(rowMenuElement(row, flaggedSpans, isIgnoredRow));
      }
      return el;
    }

    /** 行内次级动作：标待核 / 加白 / 改写法 / 恢复（默认收起，避免每行堆 5 个按钮）。 */
    function rowMenuElement(row, flaggedSpans, isIgnoredRow) {
      const wrap = document.createElement('div');
      wrap.className = 'kb-atc__row-menu';
      wrap.innerHTML = button({
        label: flaggedSpans.length
          ? t('kb.transcriptCorrect.issue_unmark', '取消待核')
          : t('kb.transcriptCorrect.issue_mark', '标待核'),
        role: 'ghost',
        size: 'sm',
        className: 'kb-atc__btn',
        attrs: { 'data-atc-flag': row.entryRef },
      }) + button({
        label: t('kb.transcriptCorrect.add_allow', '加白'),
        role: 'ghost',
        size: 'sm',
        className: 'kb-atc__btn',
        attrs: { 'data-atc-allow-open': row.entryRef },
      }) + button({
        label: t('kb.transcriptCorrect.rename_correct', '改写法'),
        role: 'ghost',
        size: 'sm',
        className: 'kb-atc__btn',
        attrs: { 'data-atc-rename-open': row.entryRef },
      }) + (isIgnoredRow ? button({
        label: t('kb.transcriptCorrect.reopen_row', '重新审视'),
        role: 'ghost',
        size: 'sm',
        className: 'kb-atc__btn',
        attrs: { 'data-atc-ignore': row.entryRef, 'data-atc-ignored': '1' },
      }) : '');

      if (state.allowOpen === row.entryRef) {
        const form = document.createElement('div');
        form.className = 'kb-atc__row-form';
        if (typeof root.uiField === 'function') {
          try {
            form.innerHTML = [
              root.uiField({
                id: 'atc-allow-' + row.entryRef,
                label: t('kb.transcriptCorrect.add_allow', '加白'),
                control: { kind: 'input', placeholder: t('kb.transcriptCorrect.add_allow_placeholder', '出现这个词时不要替换') },
              }),
              button({
                label: t('kb.transcriptCorrect.confirm', '确定'),
                role: 'secondary',
                size: 'sm',
                disabled: state.busy,
                attrs: { 'data-atc-allow-add': row.entryRef },
              }),
              button({
                label: t('kb.transcriptCorrect.cancel', '取消'),
                role: 'ghost',
                size: 'sm',
                attrs: { 'data-atc-allow-close': '1' },
              }),
            ].join('');
            const hint = document.createElement('div');
            hint.className = 'kb-atc__sync-note';
            hint.textContent = t('kb.transcriptCorrect.add_allow_context', '这一处的上下文：{context}', {
              context: row.context || t('kb.transcriptCorrect.no_context', '（无）'),
            });
            form.appendChild(hint);
            const existing = Array.isArray(row.contextAllow) ? row.contextAllow : [];
            if (existing.length) {
              const list = document.createElement('div');
              list.className = 'kb-atc__allow-list';
              const label = document.createElement('span');
              label.className = 'kb-atc__sync-row-label';
              label.textContent = t('kb.transcriptCorrect.add_allow_existing', '已加白：');
              list.appendChild(label);
              for (const term of existing) {
                const item = document.createElement('span');
                item.className = 'kb-atc__allow-item';
                item.textContent = term;
                const remove = document.createElement('span');
                remove.className = 'kb-atc__allow-remove';
                remove.textContent = t('kb.transcriptCorrect.remove', '移除');
                remove.setAttribute('data-atc-allow-remove', row.entryRef);
                remove.setAttribute('data-atc-allow-term', term);
                remove.setAttribute('role', 'button');
                item.appendChild(remove);
                list.appendChild(item);
              }
              form.appendChild(list);
            }
          } catch (error) {
            log?.warn('allow form render failed', { error: error?.message || String(error) });
          }
        }
        wrap.appendChild(form);
      }

      if (state.renameOpen === row.entryRef) {
        const form = document.createElement('div');
        form.className = 'kb-atc__row-form';
        if (typeof root.uiField === 'function') {
          try {
            form.innerHTML = [
              root.uiField({
                id: 'atc-rename-' + row.entryRef,
                label: t('kb.transcriptCorrect.rename_correct', '改写法'),
                control: { kind: 'input', placeholder: row.correct, value: row.correct },
              }),
              button({
                label: t('kb.transcriptCorrect.confirm', '确定'),
                role: 'secondary',
                size: 'sm',
                disabled: state.busy,
                attrs: { 'data-atc-rename-apply': row.entryRef },
              }),
              button({
                label: t('kb.transcriptCorrect.cancel', '取消'),
                role: 'ghost',
                size: 'sm',
                attrs: { 'data-atc-rename-close': '1' },
              }),
            ].join('');
          } catch (error) {
            log?.warn('rename form render failed', { error: error?.message || String(error) });
          }
        }
        wrap.appendChild(form);
      }
      return wrap;
    }

    function groupHeaderElement(label, tone) {
      const el = document.createElement('div');
      el.className = 'kb-atc__group';
      if (tone) el.dataset.tone = tone;
      el.textContent = label;
      return el;
    }

    /**
     * 折叠组头：用按钮而非裸控件，便于键盘与样式统一。
     * `action` 指定折叠开关（其余条目组用 toggle-other；被拒组用 toggle-denied）。
     */
    function groupToggleElement(label, collapsed, action) {
      const host = document.createElement('div');
      host.className = 'kb-atc__group kb-atc__group--toggle';
      if (action && action !== 'toggle-other') host.dataset.tone = action.replace('toggle-', '');
      host.innerHTML = button({
        label,
        icon: collapsed ? 'chevron-right' : 'chevron-down',
        role: 'ghost',
        size: 'sm',
        className: 'kb-atc__group-btn',
        attrs: { 'data-atc-action': action || 'toggle-other' },
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

      const { high, other, ignored } = splitByRisk(state.rows);
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
      if (ignored.length) {
        body.appendChild(groupHeaderElement(
          t('kb.transcriptCorrect.group_ignored', '已忽略 {count} 条（降权，可恢复）', { count: ignored.length }),
          'ignored',
        ));
        for (const row of ignored) body.appendChild(rowElement(row));
      }
      if (state.denied.length) {
        body.appendChild(groupToggleElement(
          t('kb.transcriptCorrect.denied', '被护栏拦下 {count} 处', { count: state.denied.length }),
          state.showDenied,
          'toggle-denied',
        ));
        if (state.showDenied) {
          for (const item of state.denied.slice(0, 50)) {
            const el = document.createElement('div');
            el.className = 'kb-atc__denied';
            el.dataset.denied = '1';
            el.textContent = `${item.wrong} → ${item.correct} · ${t('kb.transcriptCorrect.denied_reason_' + item.reason, item.reason)}`
              + (item.deniedBy ? `（${item.deniedBy}）` : '');
            body.appendChild(el);
          }
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
      // 同一个术语概念的多条错形归在一起数（主进程 conceptKeyOf 同规则）：
      // 用户关心的不是"几条词条"，而是"本文档涉及几个术语"。
      const concepts = groupRowsByConcept(state.rows);
      if (concepts.length > 1) {
        parts.push(t('kb.transcriptCorrect.summary_concepts', '{count} 个术语概念', { count: concepts.length }));
      }
      if (stats.pendingHigh > 0) parts.push(t('kb.transcriptCorrect.pending_high', '{count} 条高危待确认', { count: stats.pendingHigh }));
      const flagged = flaggedSummary(state.flagged);
      if (flagged.count > 0) parts.push(t('kb.transcriptCorrect.issue_summary', '待核 {count} 处', { count: flagged.count }));
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
      if (state.mergedBlocks > 0) {
        parts.push(t('kb.transcriptCorrect.merged_blocks', '合并为 {count} 块', { count: state.mergedBlocks }));
      }
      if (state.savedPath) parts.push(t('kb.transcriptCorrect.saved_to', '已另存：{path}', { path: state.savedPath }));
      host.hidden = false;
      host.textContent = parts.join(' · ');
    }

    /**
     * 接受范围（方案 §七：接受（范围：本文档 / 当前任务））。
     * 只影响"接受时把词条作用域改成什么"；默认 keep = 不动词条原有作用域。
     *
     * 控件分工（全部走共享原语，不建页面局部变体）：
     *   范围 = 互斥选择 → uiSegmentedControl；拟标题 = 动作 → uiButton；
     *   合并同人发言 = 开关 → uiCheckbox。
     * 点击委托仍按 data-atc-action / data-atc-scope 分派，故 attrs 原样透传给每个分段项。
     */
    function renderScope() {
      const host = q('[data-atc-scope]');
      if (!host) return;
      if (!state.scanned || state.rows.length === 0) { host.textContent = ''; return; }
      const scopeOptions = [
        { value: 'keep', label: t('kb.transcriptCorrect.scope_keep', '默认'), disabled: state.busy },
        { value: 'doc', label: t('kb.transcriptCorrect.scope_doc', '仅本文档'), disabled: state.busy },
        {
          value: 'task',
          label: t('kb.transcriptCorrect.scope_task', '仅本场景'),
          disabled: state.busy || !(ctx.scenarioTags || []).length,
        },
      ];
      host.innerHTML = [
        '<span class="kb-atc__scope-label">' + t('kb.transcriptCorrect.scope_label', '接受范围') + '</span>',
        root.uiSegmentedControl({
          ariaLabel: t('kb.transcriptCorrect.scope_label', '接受范围'),
          value: state.scopeChoice,
          className: 'kb-atc__scope-control',
          items: scopeOptions.map((option) => ({
            label: option.label,
            value: option.value,
            disabled: option.disabled,
            attrs: { 'data-atc-action': 'scope', 'data-atc-scope': option.value },
          })),
        }),
        button({
          label: state.headingBusy
            ? t('kb.transcriptCorrect.headings_running', '正在拟标题…')
            : t('kb.transcriptCorrect.headings_ask', '拟主题标题'),
          icon: 'book-open',
          role: 'ghost',
          size: 'sm',
          loading: state.headingBusy,
          disabled: state.busy || state.headingBusy,
          attrs: { 'data-atc-action': 'suggest-headings' },
        }),
        '<label class="kb-atc__scope-toggle">' + root.uiCheckbox({
          id: 'kb-atc-merge-speaker-' + panelId,
          checked: state.mergeSpeaker,
          disabled: state.busy,
          attrs: { 'data-atc-action': 'toggle-merge' },
        }) + '<span>' + t('kb.transcriptCorrect.merge_on', '合并同人发言') + '</span></label>',
      ].join('');
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
          label: t('kb.transcriptCorrect.diff', '对照原文'),
          icon: 'split',
          role: 'secondary',
          size: 'sm',
          disabled: !state.runId,
          attrs: { 'data-atc-action': 'diff' },
        }));
        buttons.push(button({
          label: t('kb.transcriptCorrect.save', '另存到知识库'),
          icon: 'folder-open',
          role: 'secondary',
          size: 'sm',
          attrs: { 'data-atc-action': 'save' },
        }));
        buttons.push(button({
          label: state.compareBusy
            ? t('kb.transcriptCorrect.compare_running', '正在检索…')
            : t('kb.transcriptCorrect.compare', '检索对比'),
          icon: 'search',
          role: 'ghost',
          size: 'sm',
          loading: state.compareBusy,
          disabled: state.compareBusy,
          attrs: { 'data-atc-action': 'compare-search' },
        }));
        buttons.push(button({
          label: t('kb.transcriptCorrect.notes', '清理附记'),
          icon: 'clipboard-list',
          // 低频操作 → 文字按钮（规范 §三-1）
          role: 'ghost',
          size: 'sm',
          disabled: !state.runId,
          attrs: { 'data-atc-action': 'notes' },
        }));
        buttons.push(button({
          label: t('kb.transcriptCorrect.revert', '回滚'),
          icon: 'x-circle',
          // 次要操作 → 线框按钮（规范 §三-1）
          role: 'secondary',
          size: 'sm',
          attrs: { 'data-atc-action': 'revert' },
        }));
      }
      host.innerHTML = buttons.join('');
    }

    /** 行上的"标待核"徽标：不猜的意思就是先标出来给人看。 */
    function issueReasonLabel(reason) {
      const map = {
        unknown_entity: t('kb.transcriptCorrect.issue_reason_unknown_entity', '未知实体'),
        ambiguous_name: t('kb.transcriptCorrect.issue_reason_ambiguous_name', '名称存疑'),
        mixed_speech: t('kb.transcriptCorrect.issue_reason_mixed_speech', '中英混杂'),
        asr_unrecoverable: t('kb.transcriptCorrect.issue_reason_asr_unrecoverable', '转写不可辨'),
      };
      return map[reason] || map.unknown_entity;
    }

    /**
     * 待核块（方案 §4.3 / §8.1-7）：把"不确定该不该纠"的地方标出来，
     * 生成清理版时以「【转写存疑】」写进正文，产物标 draft。
     * 视觉口径：待核是"需要人看一眼"的状态 → 只在这里用一次强调色。
     */
    function renderIssues() {
      const body = q('[data-atc-issues-body]');
      if (!body) return;
      const stats = flaggedSummary(state.flagged);
      const summary = q('[data-atc-issues-summary]');
      if (summary) {
        const title = t('kb.transcriptCorrect.issue_section', '待核');
        summary.textContent = stats.count
          ? t('kb.transcriptCorrect.issue_section_count', '{title}（{count} 处）', { title, count: stats.count })
          : title;
      }

      body.textContent = '';
      const hint = document.createElement('div');
      hint.className = 'kb-atc__issues-hint';
      hint.textContent = t(
        'kb.transcriptCorrect.issue_hint',
        '拿不准的地方不要猜：标出来会以「【转写存疑】」写进清理版，有未决项时产物标为草稿。',
      );
      body.appendChild(hint);

      const actions = document.createElement('div');
      actions.className = 'kb-atc__sync-actions';
      const buttons = [button({
        label: state.suspectBusy
          ? t('kb.transcriptCorrect.issue_finding', '正在查找…')
          : t('kb.transcriptCorrect.issue_find_suspects', '查找疑似专名'),
        icon: 'search',
        role: 'ghost',
        size: 'sm',
        loading: state.suspectBusy,
        disabled: state.suspectBusy || !state.scanned,
        attrs: { 'data-atc-action': 'find-suspects' },
      })];
      buttons.push(button({
        label: state.llmBusy
          ? t('kb.transcriptCorrect.llm_running', '正在问模型…')
          : t('kb.transcriptCorrect.llm_ask', '让模型给候选（受约束）'),
        icon: 'brain-circuit',
        role: 'ghost',
        size: 'sm',
        loading: state.llmBusy,
        disabled: state.llmBusy || !state.scanned,
        attrs: { 'data-atc-action': 'llm-candidates' },
      }));
      if (state.flagged.length) {
        buttons.push(button({
          label: t('kb.transcriptCorrect.issue_clear', '清空待核'),
          role: 'ghost',
          size: 'sm',
          attrs: { 'data-atc-action': 'clear-issues' },
        }));
      }
      actions.innerHTML = buttons.join('');
      body.appendChild(actions);

      if (state.suspectError) {
        const note = document.createElement('div');
        note.className = 'kb-atc__sync-note';
        note.dataset.tone = 'warning';
        note.textContent = state.suspectError;
        body.appendChild(note);
      } else if (state.suspects.length) {
        const note = document.createElement('div');
        note.className = 'kb-atc__sync-note';
        note.textContent = t('kb.transcriptCorrect.issue_suspects_found', '找到 {count} 处疑似专名（词表与记忆分组里都没有）：', { count: state.suspects.length });
        body.appendChild(note);
      }

      for (const candidate of state.llmCandidates.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = 'kb-atc__sync-row';
        const main = document.createElement('div');
        main.className = 'kb-atc__sync-row-main';
        const label = document.createElement('span');
        label.className = 'kb-atc__sync-row-label';
        label.textContent = t('kb.transcriptCorrect.llm_row', '{wrong} → {correct}（置信 {percent}%{pending}）', {
          wrong: candidate.wrong,
          correct: candidate.correct,
          percent: Math.round((Number(candidate.confidence) || 0) * 100),
          pending: candidate.pending ? t('kb.transcriptCorrect.llm_pending', '，待确认') : '',
        });
        main.appendChild(label);
        if (candidate.reason) {
          const why = document.createElement('div');
          why.className = 'kb-atc__sync-note';
          why.textContent = candidate.reason;
          main.appendChild(why);
        }
        const acts = document.createElement('div');
        acts.className = 'kb-atc__sync-row-actions';
        acts.innerHTML = button({
          label: t('kb.transcriptCorrect.llm_adopt', '采纳为词条'),
          role: 'ghost',
          size: 'sm',
          disabled: state.busy || state.llmBusy,
          attrs: {
            'data-atc-llm-adopt': candidate.wrong,
            'data-atc-llm-correct': candidate.correct,
          },
        });
        row.append(main, acts);
        body.appendChild(row);
      }
      if (state.llmNote) {
        const note = document.createElement('div');
        note.className = 'kb-atc__sync-note';
        note.textContent = state.llmNote;
        body.appendChild(note);
      }

      for (const suspect of state.suspects.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = 'kb-atc__sync-row';
        const main = document.createElement('div');
        main.className = 'kb-atc__sync-row-main';
        const label = document.createElement('span');
        label.className = 'kb-atc__sync-row-label';
        label.textContent = t('kb.transcriptCorrect.issue_suspect_row', '{text}（第 {offset} 字符处）', {
          text: suspect.text,
          offset: suspect.span?.start ?? 0,
        });
        main.appendChild(label);
        const acts = document.createElement('div');
        acts.className = 'kb-atc__sync-row-actions';
        acts.innerHTML = button({
          label: t('kb.transcriptCorrect.issue_mark', '标待核'),
          role: 'ghost',
          size: 'sm',
          attrs: { 'data-atc-flag-suspect': suspect.text },
        });
        row.append(main, acts);
        body.appendChild(row);
      }

      if (!state.flagged.length) {
        const empty = document.createElement('div');
        empty.className = 'kb-atc__sync-note';
        empty.textContent = t('kb.transcriptCorrect.issue_empty', '还没有标出的待核项。');
        body.appendChild(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'kb-atc__issues-list';
      list.textContent = t('kb.transcriptCorrect.issue_list_title', '已标 {count} 处：', { count: stats.count });
      body.appendChild(list);
      state.flagged.slice(0, 50).forEach((issue, index) => {
        const row = document.createElement('div');
        row.className = 'kb-atc__sync-row';
        const main = document.createElement('div');
        main.className = 'kb-atc__sync-row-main';
        const label = document.createElement('span');
        label.className = 'kb-atc__sync-row-label';
        label.textContent = `「${issue.text}」· ${issueReasonLabel(issue.reason)} · ${t('kb.transcriptCorrect.issue_at', '第 {offset} 字符处', { offset: issue.span?.start ?? 0 })}`;
        main.appendChild(label);
        const acts = document.createElement('div');
        acts.className = 'kb-atc__sync-row-actions';
        acts.innerHTML = button({
          label: t('kb.transcriptCorrect.issue_cancel', '取消'),
          role: 'ghost',
          size: 'sm',
          attrs: { 'data-atc-unflag': issue.span?.start + ':' + issue.span?.end + ':' + issue.reason },
        });
        row.append(main, acts);
        body.appendChild(row);
      });
    }

    /**
     * 记忆分组/长期记忆同步块（P1）：概念归组 + 与规范名对齐。
     * 文案口径：来源按界面用词说（「记忆分组」而不是"本体分组"），并写明
     * 长期记忆是散文、只在词表已有该术语时用于对齐——不能让人以为
     * 记忆这半边会源源不断产出建议。
     * 视觉口径：这里全是"建议"，一律弱化色（ghost/次级文字），只有真正被采纳
     * 或需要用户注意的状态才用色调——颜色只表达状态。
     */
    function renderSync() {
      const body = q('[data-atc-sync-body]');
      if (!body) return;
      const summary = q('[data-atc-sync-summary]');
      if (summary) summary.textContent = t('kb.transcriptCorrect.sync_section', '本体 / 记忆同步');
      if (state.syncBusy) state.syncError = '';

      body.textContent = '';
      const intro = document.createElement('div');
      intro.className = 'kb-atc__sync-hint';
      intro.textContent = t(
        'kb.transcriptCorrect.sync_hint',
        '把词表按概念归组，并与个人本体、长期记忆里的规范名对齐。同步不改原文，也不会自动新增词条。',
      );
      body.appendChild(intro);

      const actions = document.createElement('div');
      actions.className = 'kb-atc__sync-actions';
      actions.innerHTML = button({
        label: state.syncBusy
          ? t('kb.transcriptCorrect.syncing', '正在同步…')
          : (state.sync
            ? t('kb.transcriptCorrect.resync', '重新同步')
            : t('kb.transcriptCorrect.sync', '从本体/记忆同步')),
        icon: 'refresh',
        role: 'ghost',
        size: 'sm',
        loading: state.syncBusy,
        disabled: state.syncBusy,
        attrs: { 'data-atc-action': 'sync-ontology' },
      });
      body.appendChild(actions);

      if (state.syncError) {
        const note = document.createElement('div');
        note.className = 'kb-atc__sync-note';
        note.dataset.tone = 'warning';
        note.textContent = state.syncError;
        body.appendChild(note);
        return;
      }
      if (!state.sync) return;

      const info = syncSummary(state.sync);
      const stats = document.createElement('div');
      stats.className = 'kb-atc__sync-stats';
      stats.textContent = [
        t('kb.transcriptCorrect.sync_groups', '概念 {count} 组', { count: info.groupCount }),
        t('kb.transcriptCorrect.sync_linked', '挂上本体引用 {count} 条', { count: info.linked }),
        t('kb.transcriptCorrect.sync_align', '写法对齐 {count}', { count: info.alignments.length }),
        t('kb.transcriptCorrect.sync_missing', '待补词条 {count}', { count: info.missing.length }),
        t('kb.transcriptCorrect.sync_contributed', '投递候选 {count}', { count: info.contributed }),
      ].join(' · ');
      body.appendChild(stats);

      if (info.noSources) {
        const note = document.createElement('div');
        note.className = 'kb-atc__sync-note';
        note.textContent = info.structureOnly
          ? t(
            'kb.transcriptCorrect.sync_structure_only',
            '只找到 {count} 个分组/字段名（结构标签），没有你填写过的字段值：本次同步没有改动任何词条。',
            { count: info.stats.ontologyFields },
          )
          : t(
            'kb.transcriptCorrect.sync_no_source',
            '没有找到记忆分组或用户级长期记忆（偏好 / 共享）：本次同步没有改动任何词条。',
          );
        body.appendChild(note);
      }

      if (info.conceptGroups.length > 1) {
        const chips = document.createElement('div');
        chips.className = 'kb-atc__sync-chips';
        for (const group of info.conceptGroups) {
          const chip = document.createElement('span');
          chip.className = 'kb-atc__sync-chip';
          chip.textContent = `${group.display} ×${group.count}`;
          chips.appendChild(chip);
        }
        // 只展示前几组时不装作"就这么多"：剩余组数如实标出来。
        const rest = info.groupCount - info.conceptGroups.length;
        if (rest > 0) {
          const more = document.createElement('span');
          more.className = 'kb-atc__sync-chip';
          more.dataset.tone = 'more';
          more.textContent = t('kb.transcriptCorrect.sync_chips_more', '还有 {count} 组', { count: rest });
          chips.appendChild(more);
        }
        body.appendChild(chips);
      }

      for (const item of info.alignments) {
        const row = document.createElement('div');
        row.className = 'kb-atc__sync-row';
        const main = document.createElement('div');
        main.className = 'kb-atc__sync-row-main';
        const label = document.createElement('span');
        label.className = 'kb-atc__sync-row-label';
        label.textContent = t('kb.transcriptCorrect.sync_align_row', '「{wrong}」现在写作 {current}，{source}里是 {suggested}', {
          wrong: item.wrong,
          current: item.current,
          source: item.source === 'memory'
            ? t('kb.transcriptCorrect.sync_source_memory', '长期记忆')
            : t('kb.transcriptCorrect.sync_source_ontology', '本体'),
          suggested: item.suggested,
        });
        main.appendChild(label);
        const acts = document.createElement('div');
        acts.className = 'kb-atc__sync-row-actions';
        acts.innerHTML = button({
          label: t('kb.transcriptCorrect.sync_align_use', '采用'),
          role: 'ghost',
          size: 'sm',
          disabled: state.busy || state.syncBusy,
          attrs: { 'data-atc-align': item.entryId, 'data-atc-suggest': item.suggested },
        });
        row.append(main, acts);
        body.appendChild(row);
      }

      info.missing.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'kb-atc__sync-row';
        const main = document.createElement('div');
        main.className = 'kb-atc__sync-row-main';
        const label = document.createElement('span');
        label.className = 'kb-atc__sync-row-label';
        label.textContent = t('kb.transcriptCorrect.sync_missing_row', '{correct}：本体里有这个词，词表里还没有', {
          correct: item.correct,
        });
        main.appendChild(label);

        const acts = document.createElement('div');
        acts.className = 'kb-atc__sync-row-actions';
        if (state.seedOpen === item.conceptKey) {
          acts.innerHTML = button({
            label: t('kb.transcriptCorrect.sync_cancel', '取消'),
            role: 'ghost',
            size: 'sm',
            attrs: { 'data-atc-action': 'seed-close' },
          });
        } else {
          acts.innerHTML = button({
            label: t('kb.transcriptCorrect.sync_seed', '补错形'),
            role: 'ghost',
            size: 'sm',
            disabled: state.busy || state.syncBusy,
            attrs: { 'data-atc-seed-open': item.conceptKey },
          });
        }
        row.append(main, acts);
        body.appendChild(row);

        if (state.seedOpen !== item.conceptKey) return;
        const form = document.createElement('div');
        form.className = 'kb-atc__sync-seed';
        if (typeof root.uiField !== 'function') return;
        try {
          form.innerHTML = [
            root.uiField({
              // 用字符串拼接而不是模板串：uiField 的 id 契约由源码守卫按引号形态校验
              id: 'atc-seed-' + index,
              label: t('kb.transcriptCorrect.wrong', '转写里出现的错词'),
              control: { kind: 'input', placeholder: item.correct },
            }),
            button({
              label: t('kb.transcriptCorrect.sync_seed_add', '加入词表'),
              icon: 'check-circle',
              role: 'secondary',
              size: 'sm',
              disabled: state.busy,
              attrs: { 'data-atc-seed-adopt': item.correct, 'data-atc-seed-input': `atc-seed-${index}` },
            }),
          ].join('');
          body.appendChild(form);
        } catch (error) {
          log?.warn('sync seed form render failed', { error: error?.message || String(error) });
        }
      });
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
          button({
            label: t('kb.transcriptCorrect.seed_fillers', '装入口癖规则包'),
            icon: 'sparkles',
            role: 'ghost',
            size: 'sm',
            disabled: state.busy,
            attrs: { 'data-atc-action': 'seed-fillers' },
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
      for (const step of [renderHead, renderBody, renderSummary, renderApplyInfo, renderScope, renderActions, renderIssues, renderSync, renderAddForm]) {
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
          // 口癖规则包装进词表后是 action=delete 词条：不带这个开关它们不会出现，
          // 用户会以为"装了规则包却没反应"（真机踩过）。
          includeDelete: true,
          ...(Array.isArray(ctx.scenarioTags) && ctx.scenarioTags.length ? { scenarioTags: ctx.scenarioTags } : {}),
        });
        state.rows = groupCandidates(result?.candidates);
        state.denied = Array.isArray(result?.denied) ? result.denied : [];
        state.showDenied = false;
        state.scanned = true;
        state.accepted = new Set(defaultAcceptedIds(state.rows));
        state.ignored = new Set();
        state.apply = null;
        state.cleanedText = '';
        state.collapsedOther = false;
        // 重扫后旧的 span/坐标全部失效，待核与疑似清单必须一起清掉
        state.flagged = [];
        state.suspects = [];
        state.suspectError = '';
        state.llmCandidates = [];
        state.llmNote = '';
        // 埋点起点：从"扫描完成"到"生成清理版"的秒数（方案 §8.2 可选埋点，本地）
        state.scanDoneAt = Date.now();
        const stats = summarizeRows(state.rows, state.accepted);
        state.truncated = Boolean(result?.stats?.truncated);
        setStatus(stats.total === 0
          ? ''
          : (state.truncated
            ? t('kb.transcriptCorrect.scan_truncated', '扫描完成：{total} 条候选（已达上限，可能还有更多；建议先暂停部分词条）', { total: stats.total })
            : t('kb.transcriptCorrect.scan_done', '扫描完成：{total} 条候选', { total: stats.total })), '');
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
          includeDelete: true,
          mergeSpeaker: state.mergeSpeaker,
          ...(state.headings.length ? { headings: state.headings } : {}),
          // 附记要能说清"这份清理版是从哪份转写来的"
          ...(ctx.displayPath ? { sourcePath: ctx.displayPath } : {}),
          acceptedIds: [...state.accepted],
          // 待核 span 是原文坐标，主进程按偏移映射后插「【转写存疑】」
          ...(state.flagged.length ? { issues: state.flagged } : {}),
        });
        state.apply = result?.result || null;
        state.mergedBlocks = Number(result?.run?.mergedBlocks || 0);
        reportMetrics(result?.result);
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

    /**
     * 对照视图（方案 §七「清理版预览与回滚：diff 视图，左原文/右清理版，逐处高亮」）。
     * 分段只认 offsetMap（权威事实），不另算 diff；回滚入口放在同一屏，
     * 用户看完差异就能撤，不用回面板找按钮。
     */
    async function openDiffModal() {
      if (!state.runId) return;
      state.busy = true;
      render();
      let payload = null;
      try {
        payload = await root.cogseed.invoke('transcript.run.get', { runId: state.runId });
      } catch (error) {
        log?.warn('run get failed', { error: error?.message || String(error) });
      } finally {
        state.busy = false;
        render();
      }
      if (!payload) {
        setStatus(t('kb.transcriptCorrect.diff_failed', '读取对照失败，请稍后重试。'), 'warning');
        return;
      }
      const panes = buildDiffPanes(payload.before, payload.after, payload.offsetMap);
      const run = payload.run || {};
      if (typeof root.uiModal !== 'function') return;
      const modal = root.uiModal({
        title: t('kb.transcriptCorrect.diff_title', '对照：原文 / 清理版'),
        size: 'lg',
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        description: t('kb.transcriptCorrect.diff_bar', 'run {runId} · 替换 {changed} 处 · 删除 {deleted} 处 · 字符保留率 {percent}%', {
          runId: String(run.runId || '').slice(0, 12),
          changed: panes.changedCount,
          deleted: panes.deletedCount,
          percent: ((Number(run.retention) || 1) * 100).toFixed(1),
        }),
        bodyHtml: [
          '<div class="kb-atc__diff">',
          '  <section class="kb-atc__diff-pane">',
          '    <header data-atc-diff-head-before></header>',
          '    <pre class="kb-atc__diff-text" data-atc-diff-before></pre>',
          '  </section>',
          '  <section class="kb-atc__diff-pane">',
          '    <header data-atc-diff-head-after></header>',
          '    <pre class="kb-atc__diff-text" data-atc-diff-after></pre>',
          '  </section>',
          '</div>',
          '<div class="kb-atc__diff-note" data-atc-diff-note></div>',
        ].join(''),
        actions: [
          { id: 'revert', label: t('kb.transcriptCorrect.revert', '回滚'), role: 'ghost', size: 'sm' },
        ],
      });
      const dialog = modal?.dialog;
      if (!dialog) return;
      const beforeHost = dialog.querySelector('[data-atc-diff-before]');
      const afterHost = dialog.querySelector('[data-atc-diff-after]');
      const headBefore = dialog.querySelector('[data-atc-diff-head-before]');
      const headAfter = dialog.querySelector('[data-atc-diff-head-after]');
      const note = dialog.querySelector('[data-atc-diff-note]');
      const drawPane = (host, list, side) => {
        if (!host) return;
        host.textContent = '';
        for (const segment of list) {
          if (segment.kind === 'keep') {
            host.appendChild(document.createTextNode(segment.text));
            continue;
          }
          const el = document.createElement(segment.kind === 'deleted' && side === 'before' ? 'del' : 'mark');
          el.className = segment.kind === 'deleted' ? 'kb-atc__diff-deleted' : 'kb-atc__diff-changed';
          el.textContent = segment.text;
          host.appendChild(el);
        }
      };
      drawPane(beforeHost, panes.before, 'before');
      drawPane(afterHost, panes.after, 'after');
      if (headBefore) headBefore.textContent = t('kb.transcriptCorrect.diff_before', '原文（不可变，sha1 {sha1}）', { sha1: String(run.sourceSha1 || '').slice(0, 8) });
      if (headAfter) headAfter.textContent = t('kb.transcriptCorrect.diff_after', '清理版（派生，未写回原文）');
      if (note) {
        note.textContent = t('kb.transcriptCorrect.diff_note', '高亮 = 本次替换，删除线 = 口癖删除；原文从未被改写，回滚只做校验与返回。');
      }
      const result = await modal.result;
      if (result?.reason === 'action' && result?.id === 'revert') {
        await runRevert();
      }
    }

    /** 另存清理版到知识库（同目录、-清理版 后缀、内容 sha1 去重）。 */
    /**
     * 本地埋点（方案 §8.2「可选埋点，本地」）：把"确认耗时"与"保留率"记进本机
     * metrics.jsonl。**失败不影响主流程**（埋点永远是旁路，不能因为它出错就
     * 让用户的清理失败）。
     */
    function reportMetrics(result) {
      if (!result || typeof root.cogseed?.invoke !== 'function') return;
      const retention = Number(result.retention);
      const send = (payload) => {
        root.cogseed.invoke('transcript.metrics.record', payload).catch((error) => {
          log?.warn('metrics record failed', { error: error?.message || String(error) });
        });
      };
      if (Number.isFinite(retention)) {
        send({
          kind: 'retention',
          retention,
          charsIn: Number(result.charsIn) || 0,
          charsOut: Number(result.charsOut) || 0,
          overRewrite: Boolean(result.overRewriteSuspected),
          docId: ctx.docId,
        });
      }
      if (state.scanDoneAt) {
        send({
          kind: 'confirm_latency',
          ms: Date.now() - state.scanDoneAt,
          docId: ctx.docId,
          rows: state.rows.length,
          accepted: state.accepted.size,
        });
        state.scanDoneAt = 0;
      }
    }

    async function runSave() {
      if (state.busy || !state.cleanedText) return;
      state.busy = true;
      render();
      try {
        const intentPath = cleanedFileName(ctx.displayPath, t('kb.transcriptCorrect.cleaned_suffix', '清理版'));
        let targetPath = intentPath;
        let verdict = { kind: 'failed', message: '' };
        // 同名冲突换 -2/-3 后缀；内容重复（main 的 sha1 去重）不重试，直接如实告知。
        for (let attempt = 0; attempt < 3; attempt += 1) {
          targetPath = nextCandidateName(intentPath, attempt);
          const result = await root.cogseed.invoke('library.writeText', { content: state.cleanedText, targetPath });
          verdict = classifySaveResult(result);
          if (verdict.kind === 'saved' || verdict.kind === 'duplicate' || verdict.kind === 'failed') break;
        }
        if (verdict.kind === 'duplicate') {
          const existing = verdict.existingPath;
          // 已有文件优先按"确切文件"告知；拿不到路径时才退回目录级提示。
          state.savedPath = existing || (verdict.existingDir ? `${verdict.existingDir}/` : '');
          setStatus(t('kb.transcriptCorrect.save_duplicate', '库里已有相同内容的清理版{where}，无需重复保存。', {
            where: existing
              ? t('kb.transcriptCorrect.save_duplicate_file', '（已有文件：{path}）', { path: existing })
              : (verdict.existingDir
                ? t('kb.transcriptCorrect.save_duplicate_dir', '（在「{dir}」目录下）', { dir: verdict.existingDir })
                : ''),
          }), '');
          // 没有新文件可"看"，但用户要的是那份已有文件——列表得刷出来。
          notifyLibraryChanged();
          return;
        }
        if (verdict.kind === 'failed') throw new Error(verdict.message || 'write failed');
        // 只追加的交付台账：把"哪次清理写到了哪个文件"绑定到 run（文件名已不含 runId）。
        try {
          await root.cogseed.invoke('transcript.run.annotate', { runId: state.runId, kind: 'cleaned_copy', path: targetPath });
        } catch (annotateError) {
          log?.warn('run annotate failed', { error: annotateError?.message || String(annotateError) });
        }
        state.savedPath = targetPath;
        toast(t('kb.transcriptCorrect.saved', '已保存到知识库：{name}', { name: targetPath }));
        // 保存成功即刻刷新库列表：别让用户对着"已保存"的提示却找不到文件。
        notifyLibraryChanged();
      } catch (error) {
        log?.warn('cleaned transcript save failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.save_failed', '保存失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /**
     * 清理附记（方案 §五 P1-3）：术语对照表 / 口癖删除 / 未决项 / 上下文材料 /
     * 本次参数，渲染成 Markdown。可以预览，也可以另存到知识库（同目录 .md）。
     */
    async function openNotesModal() {
      if (!state.runId) return;
      state.busy = true;
      render();
      let payload = null;
      try {
        payload = await root.cogseed.invoke('transcript.run.notes', { runId: state.runId });
      } catch (error) {
        log?.warn('run notes failed', { error: error?.message || String(error) });
      } finally {
        state.busy = false;
        render();
      }
      if (!payload?.markdown) {
        setStatus(t('kb.transcriptCorrect.notes_failed', '生成清理附记失败，请稍后重试。'), 'warning');
        return;
      }
      state.notesText = String(payload.markdown);
      if (typeof root.uiModal !== 'function') return;
      const modal = root.uiModal({
        title: t('kb.transcriptCorrect.notes_title', '清理附记'),
        size: 'lg',
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        description: t('kb.transcriptCorrect.notes_desc', '对照表 / 口癖删除 / 未决项 / 材料 / 参数；附记只记录事实，不含推断。'),
        bodyHtml: '<pre class="kb-atc__preview kb-atc__notes" data-atc-notes></pre>',
        actions: [
          { id: 'save-notes', label: t('kb.transcriptCorrect.notes_save', '另存到知识库'), role: 'primary', size: 'sm' },
        ],
      });
      const host = modal?.dialog?.querySelector('[data-atc-notes]');
      if (host) host.textContent = state.notesText;
      const result = await modal.result;
      if (result?.reason === 'action' && result?.id === 'save-notes') {
        await saveNotes();
      }
    }

    /** 另存附记：与清理版同目录，`<stem>-清理附记.md`。 */
    async function saveNotes() {
      if (!state.notesText) return;
      try {
        const targetPath = cleanedFileName(
          ctx.displayPath,
          t('kb.transcriptCorrect.notes_suffix', '清理附记'),
          'md',
        );
        const result = await root.cogseed.invoke('library.writeText', { content: state.notesText, targetPath });
        if (result?.ok === false) {
          setStatus(result.code === 'duplicate_content'
            ? t('kb.transcriptCorrect.notes_duplicate', '库里已有相同内容的附记，无需重复保存。')
            : t('kb.transcriptCorrect.notes_save_failed', '保存失败：{error}', { error: String(result.error || '') }), 'warning');
          return;
        }
        setStatus(t('kb.transcriptCorrect.notes_saved', '附记已另存：{path}', { path: result?.path || targetPath }), '');
        notifyLibraryChanged();
      } catch (error) {
        log?.warn('save notes failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.notes_save_failed', '保存失败：{error}', { error: error?.message || '' }), 'warning');
      }
    }

    /** 回滚（面板与对照视图共用）：只校验 sha1 并返回原文，绝不写回文件。 */
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

    /**
     * 同步本体/记忆。主进程是唯一写入方：本面板只传 `contribute` 开关，
     * 不自己决定"投递什么候选"（幂等键在 bridge 里算）。
     */
    async function runSyncOntology() {
      if (state.syncBusy) return;
      state.syncBusy = true;
      state.syncError = '';
      render();
      try {
        state.sync = await root.cogseed.invoke('transcript.glossary.syncOntology', { contribute: true });
        setStatus(t('kb.transcriptCorrect.sync_done', '已与本体/记忆对齐（原文未改动）'), '');
      } catch (error) {
        log?.warn('ontology sync failed', { error: error?.message || String(error) });
        state.syncError = t('kb.transcriptCorrect.sync_failed', '同步失败，请稍后重试。');
        setStatus(state.syncError, 'warning');
      } finally {
        state.syncBusy = false;
        render();
      }
    }

    /** 采纳"写法对齐"建议：只改词条写法，不伪造一次确认。 */
    async function runApplyAlignment(entryId, suggested) {
      if (state.busy || !entryId || !suggested) return;
      state.busy = true;
      render();
      try {
        await root.cogseed.invoke('transcript.glossary.applyAlignment', { entryId, correct: suggested });
        // 先重跑同步让建议列表消失，再落本次动作的文案：同步会写自己的状态行，
        // 顺序反了用户就看不到"刚刚采纳了什么"。
        await runSyncOntology();
        setStatus(t('kb.transcriptCorrect.sync_aligned', '已采用本体写法：{correct}', { correct: suggested }), '');
      } catch (error) {
        log?.warn('alignment apply failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.sync_align_failed', '采用失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /** 采纳"待补错形"：用户必须自己填错形，面板不替用户编造错形。 */
    async function runAdoptSeed(correct, inputId) {
      if (state.busy) return;
      const input = inputId ? container.querySelector(`#${inputId}`) : null;
      const wrong = String(input?.value || '').trim();
      if (!wrong) {
        setStatus(t('kb.transcriptCorrect.sync_seed_need_wrong', '请先填写转写里实际出现的错词。'), 'warning');
        return;
      }
      state.busy = true;
      render();
      try {
        const result = await root.cogseed.invoke('transcript.glossary.adoptSeed', { wrong, correct });
        if (!result?.entry) {
          setStatus(t('kb.transcriptCorrect.sync_seed_skipped', '这条没能入册（错形与正确写法太接近，或与已有词条重复）。'), 'warning');
          return;
        }
        state.seedOpen = '';
        await runSyncOntology();
        setStatus(t('kb.transcriptCorrect.sync_seed_added', '已从本体补入词表：{wrong} → {correct}', { wrong, correct }), '');
      } catch (error) {
        log?.warn('ontology seed adopt failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.sync_seed_failed', '补入词表失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /** 接受范围（方案 §七）：把已接受的词条限定到本文档 / 本场景。 */
    async function applyScopeChoice(entryRef) {
      const choice = state.scopeChoice;
      if (choice === 'keep') return;
      if (choice === 'task' && !(ctx.scenarioTags || []).length) {
        setStatus(t('kb.transcriptCorrect.scope_need_tags', '当前文档没有场景标签，请改用「本文档」。'), 'warning');
        return;
      }
      try {
        const result = await root.cogseed.invoke('transcript.glossary.setScope', {
          ids: [entryRef],
          choice,
          docId: ctx.docId,
          ...(choice === 'task' ? { scenarioTags: ctx.scenarioTags } : {}),
        });
        const refused = Array.isArray(result?.refused) ? result.refused : [];
        if (refused.length) {
          setStatus(t('kb.transcriptCorrect.scope_refused', '高危词条不能设为全局（会误伤无关稿件），已保持原作用域。'), 'warning');
          return;
        }
        setStatus(t('kb.transcriptCorrect.scope_applied', '已限定作用域：{scope}', {
          scope: choice === 'doc'
            ? t('kb.transcriptCorrect.scope_doc', '仅本文档')
            : t('kb.transcriptCorrect.scope_task', '仅本场景'),
        }), '');
      } catch (error) {
        log?.warn('scope apply failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.scope_failed', '设置作用域失败，请稍后重试。'), 'warning');
      }
    }

    /**
     * 检索命中对比（方案 §五 P2-4 / §8.1-9，人工基线要求）：
     * 同一份库里"搜错形"和"搜正确写法"各命中多少，如实并列。
     * 这是**自测口径**，不宣称因果（库里本来有没有清理版会影响数字）。
     */
    async function runCompareSearch() {
      if (state.compareBusy) return;
      const suggestion = state.apply?.applied?.[0]?.wrong
        || state.rows.find((row) => row.riskLevel === 'low')?.wrong
        || '';
      let query = null;
      if (typeof root.uiPrompt === 'function') {
        query = await root.uiPrompt(t('kb.transcriptCorrect.compare_prompt', '要对比的检索词（用转写里的错形）'), suggestion);
      } else if (typeof root.prompt === 'function') {
        query = root.prompt(t('kb.transcriptCorrect.compare_prompt', '要对比的检索词（用转写里的错形）'), suggestion);
      }
      const text = String(query || '').trim();
      if (!text) return;
      state.compareBusy = true;
      render();
      try {
        const result = await root.cogseed.invoke('transcript.query.compare', { query: text, k: 10 });
        if (!result?.compareAvailable) {
          setStatus(t('kb.transcriptCorrect.compare_no_rewrite', '「{query}」没有可改写的词表命中，无法对比。', { query: text }), '');
          return;
        }
        const applied = (result.applied || []).map((item) => `${item.wrong} → ${item.correct}`).join('；');
        // 落台账：让"替换前后命中数"进入 run（方案 §五 P0-5），附记里可回看
        if (state.runId) {
          try {
            await root.cogseed.invoke('transcript.run.recordSearchCompare', {
              runId: state.runId,
              query: result.query,
              rewritten: result.rewritten,
              beforeHits: Number(result.beforeHits || 0),
              afterHits: Number(result.afterHits || 0),
              beforeSources: result.beforeSources || [],
              afterSources: result.afterSources || [],
              applied: result.applied || [],
            });
          } catch (error) {
            log?.warn('record search compare failed', { error: error?.message || String(error) });
          }
        }
        // 显示的是"命中片段（该段首行）"，不是文档名——如实这么叫
        const sources = (list) => (Array.isArray(list) && list.length ? list.slice(0, 2).join('、') : t('kb.transcriptCorrect.compare_no_source', '（未命中任何片段）'));
        setStatus(t('kb.transcriptCorrect.compare_result', '命中对比：搜「{before}」{beforeHits} 段（首行：{beforeSrc}）/ 搜「{after}」{afterHits} 段（首行：{afterSrc}）· {applied}', {
          before: result.query,
          beforeHits: Number(result.beforeHits || 0),
          beforeSrc: sources(result.beforeSources),
          after: result.rewritten,
          afterHits: Number(result.afterHits || 0),
          afterSrc: sources(result.afterSources),
          applied,
        }), '');
      } catch (error) {
        log?.warn('compare search failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.compare_failed', '检索对比失败，请稍后重试。'), 'warning');
      } finally {
        state.compareBusy = false;
        render();
      }
    }

    /**
     * 主题标题候选（方案 §五 P2-2）：**只提议**。用户在弹层里逐条"采用"，
     * 采用的标题进入 state.headings，生成清理版时作为结构编辑插入（不改正文语义）。
     */
    async function runSuggestHeadings() {
      if (state.headingBusy) return;
      state.headingBusy = true;
      render();
      let result = null;
      try {
        result = await root.cogseed.invoke('transcript.headings.suggest', { text: ctx.text, docId: ctx.docId });
      } catch (error) {
        log?.warn('heading suggest failed', { error: error?.message || String(error) });
      } finally {
        state.headingBusy = false;
        render();
      }
      const headings = Array.isArray(result?.headings) ? result.headings : [];
      const skipped = String(result?.skipped || '');
      if (!headings.length) {
        setStatus(skipped === 'no_model'
          ? t('kb.transcriptCorrect.headings_no_model', '还没有配置模型，无法拟标题。')
          : skipped === 'too_short'
            ? t('kb.transcriptCorrect.headings_too_short', '这份稿太短，不值得分主题。')
            : t('kb.transcriptCorrect.headings_none', '没有拟出合适的标题（宁缺勿滥）。'), '');
        return;
      }
      if (typeof root.uiModal !== 'function') return;
      const modal = root.uiModal({
        title: t('kb.transcriptCorrect.headings_title', '主题标题候选'),
        size: 'lg',
        closeLabel: t('kb.transcriptCorrect.close', '关闭'),
        description: t('kb.transcriptCorrect.headings_desc', '只生成标题、不改正文；逐条确认，采用的会在生成清理版时插入。'),
        bodyHtml: '<div class="kb-atc__headings" data-atc-headings></div>',
      });
      const host = modal?.dialog?.querySelector('[data-atc-headings]');
      if (host) {
        for (const item of headings) {
          const row = document.createElement('div');
          row.className = 'kb-atc__sync-row';
          const main = document.createElement('div');
          main.className = 'kb-atc__sync-row-main';
          const label = document.createElement('span');
          label.className = 'kb-atc__sync-row-label';
          label.textContent = item.title;
          main.appendChild(label);
          const acts = document.createElement('div');
          acts.className = 'kb-atc__sync-row-actions';
          const adopted = state.headings.some((h) => h.start === item.start);
          acts.innerHTML = button({
            label: adopted
              ? t('kb.transcriptCorrect.headings_adopted', '已采用')
              : t('kb.transcriptCorrect.headings_adopt', '采用'),
            role: adopted ? 'primary' : 'secondary',
            size: 'sm',
            attrs: { 'data-atc-heading-adopt': String(item.start), 'data-atc-heading-title': item.title },
          });
          row.append(main, acts);
          host.appendChild(row);
        }
      }
      await modal.result;
      render();
    }

    /** 采用/取消一条标题（纯状态操作，真正插入发生在 apply）。 */
    function toggleHeading(start, title) {
      const index = state.headings.findIndex((item) => item.start === start);
      if (index >= 0) state.headings.splice(index, 1);
      else state.headings.push({ start, title });
      setStatus(t('kb.transcriptCorrect.headings_count', '已采用 {count} 个标题（生成清理版时插入）', {
        count: state.headings.length,
      }), '');
      render();
    }

    /**
     * 受约束 LLM 候选（方案 §五 P2-1）：只对"疑似专名"问一次模型，
     * 目标必须落在词表白名单里；低置信只提示不采纳。
     * 采纳 = 用户显式点「采纳为词条」，之后重新扫描，替换仍受护栏管。
     */
    async function runLlmCandidates() {
      if (state.llmBusy || !state.scanned) return;
      state.llmBusy = true;
      state.llmNote = '';
      render();
      try {
        const result = await root.cogseed.invoke('transcript.correct.llmCandidates', {
          text: ctx.text,
          docId: ctx.docId,
        });
        state.llmCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
        const rejected = Array.isArray(result?.rejected) ? result.rejected.length : 0;
        const skipped = String(result?.skipped || '');
        state.llmNote = state.llmCandidates.length
          ? t('kb.transcriptCorrect.llm_found', '模型给出 {count} 条候选（白名单 {allowed} 个目标{rejected}）', {
            count: state.llmCandidates.length,
            allowed: Number(result?.allowedCount || 0),
            rejected: rejected
              ? t('kb.transcriptCorrect.llm_rejected', '，挡掉白名单外的 {count} 条', { count: rejected })
              : '',
          })
          : (skipped === 'no_model'
            ? t('kb.transcriptCorrect.llm_no_model', '还没有配置模型，无法生成候选。')
            : skipped === 'no_allowed'
              ? t('kb.transcriptCorrect.llm_no_allowed', '词表与记忆分组里没有可用目标，先补几条正确写法再试。')
              : skipped === 'no_suspects'
                ? t('kb.transcriptCorrect.llm_no_suspects', '没有发现疑似专名，不需要问模型。')
                : t('kb.transcriptCorrect.llm_none', '模型没有给出可信候选（宁可空着，也不硬猜）。'));
      } catch (error) {
        log?.warn('llm candidates failed', { error: error?.message || String(error) });
        state.llmNote = t('kb.transcriptCorrect.llm_failed', '生成候选失败，请稍后重试。');
      } finally {
        state.llmBusy = false;
        render();
      }
    }

    /** 采纳一条模型候选：写成词条（错形来自转写，正确写法来自白名单）。 */
    async function adoptLlmCandidate(wrong, correct) {
      if (state.busy) return;
      try {
        await root.cogseed.invoke('transcript.glossary.upsert', {
          wrong, correct, kind: 'people', source: 'manual',
        });
        state.llmCandidates = state.llmCandidates.filter((item) => item.wrong !== wrong);
        setStatus(t('kb.transcriptCorrect.llm_adopted', '已采纳为词条：{wrong} → {correct}', { wrong, correct }), '');
        await runScan();
      } catch (error) {
        log?.warn('adopt llm candidate failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.llm_adopt_failed', '采纳失败，请稍后重试。'), 'warning');
      } finally {
        render();
      }
    }

    /**
     * 装入口癖规则包（方案 §五 P1-1）：词条化 + 走既有链路。
     * 规则包本身是保守的：白名单词只在句首/独立出现时删，`就是/然后/对`
     * 只在重复或纯应答时删——面板必须把这件事说清楚。
     */
    async function runSeedFillers() {
      if (state.busy) return;
      state.busy = true;
      render();
      try {
        const result = await root.cogseed.invoke('transcript.glossary.seedFillers', {});
        setStatus(t('kb.transcriptCorrect.seed_fillers_done', '口癖规则包已装入：新增 {created} 条、更新 {updated} 条（保守删除，可随时暂停）。', {
          created: Number(result?.created || 0),
          updated: Number(result?.updated || 0),
        }), '');
        await runScan();
      } catch (error) {
        log?.warn('seed fillers failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.seed_fillers_failed', '装入口癖规则包失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /** 忽略 / 恢复（持久化，可逆）：不是删词条，只是降权。 */
    async function runIgnore(entryRef, restore) {
      if (state.busy) return;
      const row = state.rows.find((item) => item.entryRef === entryRef);
      try {
        await root.cogseed.invoke('transcript.glossary.setIgnored', { ids: [entryRef], ignored: !restore });
        if (row) row.ignoredCount = restore ? 0 : Number(row.ignoredCount || 0) + 1;
        if (restore) {
          state.accepted.add(entryRef);
        } else {
          state.accepted.delete(entryRef);
        }
        setStatus(restore
          ? t('kb.transcriptCorrect.restored', '已恢复：{wrong} 重新参与清理。', { wrong: row?.wrong || '' })
          : t('kb.transcriptCorrect.ignored_done', '已忽略：{wrong} 降权到末尾（可恢复）。', { wrong: row?.wrong || '' }), '');
      } catch (error) {
        log?.warn('ignore failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.ignore_failed', '忽略失败，请稍后重试。'), 'warning');
      } finally {
        render();
      }
    }

    /** 加白：把用户填的上下文词加入白名单，之后该语境静默（需重扫生效）。 */
    async function runAddAllow(entryRef) {
      if (state.busy) return;
      const input = container.querySelector('#atc-allow-' + entryRef);
      const term = String(input?.value || '').trim();
      if (!term) {
        setStatus(t('kb.transcriptCorrect.add_allow_need_term', '请填写一个上下文词。'), 'warning');
        return;
      }
      state.busy = true;
      render();
      try {
        await root.cogseed.invoke('transcript.glossary.addAllow', { ids: [entryRef], term });
        state.allowOpen = '';
        setStatus(t('kb.transcriptCorrect.add_allow_done', '已加白：出现「{term}」时不再替换 {wrong}。', {
          term,
          wrong: state.rows.find((r) => r.entryRef === entryRef)?.wrong || '',
        }), '');
        await runScan();
      } catch (error) {
        log?.warn('add allow failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.add_allow_failed', '加白失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /** 移除一条加白（白名单会静默候选，必须能撤）。 */
    async function runRemoveAllow(entryRef, term) {
      if (state.busy) return;
      try {
        await root.cogseed.invoke('transcript.glossary.removeAllow', { ids: [entryRef], term });
        setStatus(t('kb.transcriptCorrect.remove_allow_done', '已移除加白：{term}', { term }), '');
        await runScan();
      } catch (error) {
        log?.warn('remove allow failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.remove_allow_failed', '移除失败，请稍后重试。'), 'warning');
      } finally {
        render();
      }
    }

    /** 改写法（方案 §七「改别名」的词表侧）：只改 correct，不伪造一次确认。 */
    async function runRename(entryRef) {
      if (state.busy) return;
      const input = container.querySelector('#atc-rename-' + entryRef);
      const correct = String(input?.value || '').trim();
      if (!correct) {
        setStatus(t('kb.transcriptCorrect.rename_need_value', '请填写新的写法。'), 'warning');
        return;
      }
      state.busy = true;
      render();
      try {
        await root.cogseed.invoke('transcript.glossary.applyAlignment', { entryId: entryRef, correct });
        state.renameOpen = '';
        setStatus(t('kb.transcriptCorrect.rename_done', '已改为：{correct}', { correct }), '');
        await runScan();
      } catch (error) {
        log?.warn('rename failed', { error: error?.message || String(error) });
        setStatus(t('kb.transcriptCorrect.rename_failed', '改写失败，请稍后重试。'), 'warning');
      } finally {
        state.busy = false;
        render();
      }
    }

    /** 标/取消一行候选的全部出现处（一处也不猜，全标出来）。 */
    function toggleRowFlag(entryRef) {
      const row = state.rows.find((item) => item.entryRef === entryRef);
      if (!row) return;
      const spans = row.spans || [];
      const already = spans.length > 0 && spans.every((span) => state.flagged.some(
        (issue) => issue.span?.start === span.start && issue.span?.end === span.end,
      ));
      if (already) {
        state.flagged = state.flagged.filter((issue) => !spans.some(
          (span) => issue.span?.start === span.start && issue.span?.end === span.end,
        ));
      } else {
        state.flagged = mergeFlagged(state.flagged, spans.map((span) => ({
          span: { start: span.start, end: span.end },
          text: row.wrong,
          reason: 'ambiguous_name',
        })));
      }
      render();
    }

    /** 把一个疑似专名标成待核（未知实体）。 */
    function flagSuspect(text, span) {
      state.flagged = mergeFlagged(state.flagged, [{
        span: { start: span?.start ?? 0, end: span?.end ?? 0 },
        text,
        reason: 'unknown_entity',
      }]);
      state.suspects = state.suspects.filter((item) => item.text !== text);
      render();
    }

    function unflag(key) {
      const [start, end, reason] = String(key || '').split(':');
      state.flagged = state.flagged.filter((issue) => !(
        String(issue.span?.start) === start && String(issue.span?.end) === end && issue.reason === reason
      ));
      render();
    }

    /** 查找疑似专名：词表与记忆分组里都没有的英文专名（只提示，不自动标）。 */
    async function runDetectSuspects() {
      if (state.suspectBusy || !state.scanned) return;
      state.suspectBusy = true;
      state.suspectError = '';
      render();
      try {
        const result = await root.cogseed.invoke('transcript.correct.suspects', { text: ctx.text, limit: 200 });
        state.suspects = Array.isArray(result?.suspects) ? result.suspects : [];
        if (!state.suspects.length) {
          setStatus(t('kb.transcriptCorrect.issue_suspects_none', '没有发现疑似专名。'), '');
        } else {
          setStatus(t('kb.transcriptCorrect.issue_suspects_found', '找到 {count} 处疑似专名（词表与记忆分组里都没有）：', { count: state.suspects.length }), '');
        }
      } catch (error) {
        log?.warn('suspect detection failed', { error: error?.message || String(error) });
        state.suspectError = t('kb.transcriptCorrect.issue_suspects_failed', '查找失败，请稍后重试。');
        setStatus(state.suspectError, 'warning');
      } finally {
        state.suspectBusy = false;
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
        else {
          state.accepted.add(ref);
          state.ignored.delete(ref);
          // 接受时按当前范围选择落到词条（本文档 / 本场景），keep = 不动
          void applyScopeChoice(ref);
        }
        render();
        return;
      }
      const ignore = event.target.closest('[data-atc-ignore]');
      if (ignore) {
        const ref = ignore.getAttribute('data-atc-ignore');
        void runIgnore(ref, ignore.getAttribute('data-atc-ignored') === '1');
        return;
      }
      const rowMenu = event.target.closest('[data-atc-rowmenu]');
      if (rowMenu) {
        const ref = rowMenu.getAttribute('data-atc-rowmenu');
        state.rowMenu = state.rowMenu === ref ? '' : ref;
        state.allowOpen = '';
        state.renameOpen = '';
        render();
        return;
      }
      const allowRemove = event.target.closest('[data-atc-allow-remove]');
      if (allowRemove) {
        void runRemoveAllow(allowRemove.getAttribute('data-atc-allow-remove'), allowRemove.getAttribute('data-atc-allow-term'));
        return;
      }
      const allowOpen = event.target.closest('[data-atc-allow-open]');
      if (allowOpen) {
        const ref = allowOpen.getAttribute('data-atc-allow-open');
        state.allowOpen = state.allowOpen === ref ? '' : ref;
        state.renameOpen = '';
        render();
        return;
      }
      const allowClose = event.target.closest('[data-atc-allow-close]');
      if (allowClose) { state.allowOpen = ''; render(); return; }
      const allowAdd = event.target.closest('[data-atc-allow-add]');
      if (allowAdd) { void runAddAllow(allowAdd.getAttribute('data-atc-allow-add')); return; }
      const renameOpen = event.target.closest('[data-atc-rename-open]');
      if (renameOpen) {
        const ref = renameOpen.getAttribute('data-atc-rename-open');
        state.renameOpen = state.renameOpen === ref ? '' : ref;
        state.allowOpen = '';
        render();
        return;
      }
      const renameClose = event.target.closest('[data-atc-rename-close]');
      if (renameClose) { state.renameOpen = ''; render(); return; }
      const renameApply = event.target.closest('[data-atc-rename-apply]');
      if (renameApply) { void runRename(renameApply.getAttribute('data-atc-rename-apply')); return; }
      const flag = event.target.closest('[data-atc-flag]');
      if (flag) {
        toggleRowFlag(flag.getAttribute('data-atc-flag'));
        return;
      }
      const headingAdopt = event.target.closest('[data-atc-heading-adopt]');
      if (headingAdopt) {
        const start = Number(headingAdopt.getAttribute('data-atc-heading-adopt'));
        toggleHeading(start, headingAdopt.getAttribute('data-atc-heading-title'));
        headingAdopt.textContent = state.headings.some((h) => h.start === start)
          ? t('kb.transcriptCorrect.headings_adopted', '已采用')
          : t('kb.transcriptCorrect.headings_adopt', '采用');
        return;
      }
      const llmAdopt = event.target.closest('[data-atc-llm-adopt]');
      if (llmAdopt) {
        void adoptLlmCandidate(llmAdopt.getAttribute('data-atc-llm-adopt'), llmAdopt.getAttribute('data-atc-llm-correct'));
        return;
      }
      const flagSuspectBtn = event.target.closest('[data-atc-flag-suspect]');
      if (flagSuspectBtn) {
        const text = flagSuspectBtn.getAttribute('data-atc-flag-suspect');
        const found = state.suspects.find((item) => item.text === text);
        if (found) flagSuspect(text, found.span);
        return;
      }
      const unflagBtn = event.target.closest('[data-atc-unflag]');
      if (unflagBtn) {
        unflag(unflagBtn.getAttribute('data-atc-unflag'));
        return;
      }
      const align = event.target.closest('[data-atc-align]');
      if (align) {
        void runApplyAlignment(align.getAttribute('data-atc-align'), align.getAttribute('data-atc-suggest'));
        return;
      }
      const seedOpen = event.target.closest('[data-atc-seed-open]');
      if (seedOpen) {
        state.seedOpen = seedOpen.getAttribute('data-atc-seed-open');
        render();
        return;
      }
      const seedAdopt = event.target.closest('[data-atc-seed-adopt]');
      if (seedAdopt) {
        void runAdoptSeed(seedAdopt.getAttribute('data-atc-seed-adopt'), seedAdopt.getAttribute('data-atc-seed-input'));
        return;
      }
      const action = event.target.closest('[data-atc-action]');
      if (!action) return;
      const kind = action.getAttribute('data-atc-action');
      if (kind === 'sync-ontology') { void runSyncOntology(); return; }
      if (kind === 'scope') {
        const value = action.getAttribute('data-atc-scope') || 'keep';
        state.scopeChoice = value === 'doc' || value === 'task' ? value : 'keep';
        render();
        return;
      }
      if (kind === 'toggle-denied') { state.showDenied = !state.showDenied; render(); return; }
      if (kind === 'open-glossary') {
        if (root.KbGlossaryManager && typeof root.KbGlossaryManager.open === 'function') {
          root.KbGlossaryManager.open({ onChanged: () => { void runScan(); } });
        } else {
          setStatus(t('kb.glossary.unavailable', '词表管理暂不可用。'), 'warning');
        }
        return;
      }
      if (kind === 'find-suspects') { void runDetectSuspects(); return; }
      if (kind === 'llm-candidates') { void runLlmCandidates(); return; }
      if (kind === 'suggest-headings') { void runSuggestHeadings(); return; }
      if (kind === 'compare-search') { void runCompareSearch(); return; }
      if (kind === 'toggle-merge') { state.mergeSpeaker = !state.mergeSpeaker; render(); return; }
      if (kind === 'clear-issues') { state.flagged = []; render(); return; }
      if (kind === 'seed-close') { state.seedOpen = ''; render(); return; }
      if (kind === 'scan') void runScan();
      else if (kind === 'toggle-other') { state.collapsedOther = !state.collapsedOther; render(); }
      else if (kind === 'apply') void runApply();
      else if (kind === 'preview') openTextModal(t('kb.transcriptCorrect.preview_title', '清理版预览'), state.cleanedText);
      else if (kind === 'diff') void openDiffModal();
      else if (kind === 'notes') void openNotesModal();
      else if (kind === 'save') void runSave();
      else if (kind === 'revert') void runRevert();
      else if (kind === 'add') void runAddEntry();
      else if (kind === 'seed-fillers') void runSeedFillers();
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
      if (typeof root.uiSegmentedControl !== 'function' || typeof root.uiCheckbox !== 'function') {
        throw new Error('kb transcript correct: shared ui primitives unavailable (uiSegmentedControl / uiCheckbox)');
      }
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
    __test: {
      groupCandidates,
      groupRowsByConcept,
      flaggedSummary,
      mergeFlagged,
      buildDiffPanes,
      conceptKeyOfCorrect,
      syncSummary,
      summarizeRows,
      splitByRisk,
      defaultAcceptedIds,
      applySummary,
      cleanedFileName,
      nextCandidateName,
      classifySaveResult,
      riskKey,
    },
  };

  root.KbTranscriptCorrect = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      groupCandidates,
      groupRowsByConcept,
      flaggedSummary,
      mergeFlagged,
      buildDiffPanes,
      conceptKeyOfCorrect,
      syncSummary,
      summarizeRows,
      splitByRisk,
      defaultAcceptedIds,
      applySummary,
      cleanedFileName,
      nextCandidateName,
      classifySaveResult,
      riskKey,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
