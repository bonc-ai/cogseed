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
        '  <div class="kb-glo__filters" data-glo-filters></div>',
        '  <div class="kb-glo__status" data-glo-status hidden></div>',
        '  <div class="kb-glo__bulk" data-glo-bulk></div>',
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
        if (typeof root.hydrateUiFormSelects === 'function') root.hydrateUiFormSelects(host);
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
        if (typeof root.hydrateUiFormSelects === 'function') root.hydrateUiFormSelects(host);
      } catch (error) {
        log?.warn('glossary io render failed', { error: error?.message || String(error) });
      }
    }

    function render() {
      for (const step of [renderMeta, renderFilters, renderStatus, renderBulk, renderList, renderIo]) {
        try { step(); } catch (error) {
          log?.warn('glossary manager render step failed', { step: step.name, error: error?.message || String(error) });
        }
      }
    }

    // ── 数据动作 ────────────────────────────────────────────────────────
    async function reload() {
      state.busy = true;
      render();
      try {
        const result = await root.cogseed.invoke('transcript.glossary.list', {});
        state.entries = Array.isArray(result?.entries) ? result.entries : [];
        state.meta = result?.meta && typeof result.meta === 'object'
          ? result.meta
          : { ownerNote: '', lastReconcileAt: 0 };
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

    function readFilters() {
      const search = String(dialog.querySelector('#glo-search')?.value || '');
      const kind = String(dialog.querySelector('#glo-kind')?._uiSelectApi?.getValue?.() || '');
      const riskLevel = String(dialog.querySelector('#glo-risk')?._uiSelectApi?.getValue?.() || '');
      const status = String(dialog.querySelector('#glo-status')?._uiSelectApi?.getValue?.() || '');
      return { search, kind, riskLevel, status };
    }

    async function setStatusBulk(status) {
      if (state.busy || state.selected.size === 0) return;
      state.busy = true;
      render();
      let updated = 0;
      try {
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
      render();
      try {
        await root.cogseed.invoke('transcript.glossary.delete', { id });
        state.selected.delete(id);
        setStatus(t('kb.glossary.deleted', '已删除词条。'), '');
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
      render();
      try {
        await root.cogseed.invoke('transcript.glossary.setStatus', {
          id,
          status: current === 'paused' ? 'active' : 'paused',
        });
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
      render();
      try {
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
      if (state.busy || !state.exportText) return;
      state.busy = true;
      render();
      try {
        const stamp = new Date().toISOString().slice(0, 10);
        const targetPath = t('kb.glossary.export_filename', '转写词表-{date}.json', { date: stamp });
        const result = await root.cogseed.invoke('library.writeText', { content: state.exportText, targetPath });
        if (result?.ok === false) {
          const duplicate = result.code === 'duplicate_content';
          setStatus(duplicate
            ? t('kb.glossary.export_duplicate', '库里已有相同内容的导出文件，无需重复保存。')
            : t('kb.glossary.export_save_failed', '保存失败：{error}', { error: String(result.error || '') }),
            duplicate ? '' : 'warning');
          return;
        }
        setStatus(t('kb.glossary.export_saved', '已另存：{path}', { path: result?.path || targetPath }), '');
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
      if (!parsed || !state.importPreview) return;
      state.busy = true;
      render();
      try {
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
      if (event.target.id === 'glo-import-mode') {
        const value = String(event.target._uiSelectApi?.getValue?.() || event.target.value || 'merge');
        state.importMode = value === 'replace' ? 'replace' : 'merge';
        state.importPreview = null;
        renderIo();
      }
    }

    dialog.addEventListener('click', onClick);
    dialog.addEventListener('input', onFilterChange);
    dialog.addEventListener('change', onFilterChange);
    render();
    void reload();

    return modal;
  }

  const api = {
    open,
    // 测试桥（仅纯函数）
    __test: { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf },
    _internals: { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf },
  };

  root.KbGlossaryManager = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { filterEntries, sortEntries, summarizeImport, kindKey, riskKeyOf };
  }
})(typeof window !== 'undefined' ? window : globalThis);
