/* 我的认知：正式资产目录、筛选和详情工作台。所有写入复用既有 IPC 动作。 */
(function () {
  'use strict';
  const NS = window.CogAssets;
  if (!NS) return;
  const { T, esc } = NS;
  const S = NS.store;
  const { btn, empty, CATEGORIES, CONTENT_CATEGORIES, contentCategoryOf, contentCategoryLabel } = NS.ui;
  const PAGE_SIZE = 20;
  const state = S.libraryView = { query: '', status: 'library', scope: '', contentCategory: '', sort: 'recent', page: 1, drawer: false, closed: false, expanded: false, dirty: false };
  let sourcePreview = false;
  let libraryRendered = false;
  let libraryWasNarrow = false;
  let lastCategory = '';
  let busy = false;
  const actions = ['library-select', 'library-page', 'library-clear', 'library-close', 'library-expand', 'library-expand-close', 'library-refresh', 'library-review-conflict', 'library-open-inbox', 'library-show-sources', 'library-show-versions', 'library-show-records', 'library-show-merge'];
  const statusOf = a => String(a?.status || '');
  const formalTypes = new Set(['cognition', ...CATEGORIES.map(([id]) => id)]);
  const formalStatuses = new Set(['active', 'paused', 'archived', 'deleted']);
  const isFormalAsset = a => !!a && typeof a.id === 'string' && !!a.id.trim() && formalTypes.has(a.type) && formalStatuses.has(statusOf(a));
  const isNarrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1100px), (max-height: 500px)').matches;
  function focusAfterFrame(run) {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else run();
  }
  // Shell dialogs stay in the document without the hidden attribute. Only a visible one blocks Escape.
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
  function scopeNames(a) {
    const policy = a.scopePolicy || {};
    const dirs = S.assetScopeOptions || {};
    const list = (values, options, idKey) => (Array.isArray(values) ? values : []).map((id, index) => String((options || []).find(o => String(o[idKey]) === String(id))?.name
      || T(idKey === 'agent_id' ? 'cognition.asset_scope_missing_agent' : 'cognition.asset_scope_missing_space', idKey === 'agent_id' ? '已不可用的旧智能体限制 {n}' : '已不可用的旧工作空间限制 {n}', { n: String(index + 1) })));
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.values(policy).some(v => v != null && !Array.isArray(v))) return T('cognition.library_scope_incomplete', '范围信息不完整，请核对');
    const parts = [
      ...list(policy.workspaceIds, dirs.spaces, 'space_id'),
      ...list(policy.agentIds, dirs.agents, 'agent_id'),
      ...(Array.isArray(policy.projectIds) ? policy.projectIds : []), ...(Array.isArray(policy.purposeTags) ? policy.purposeTags : []),
    ];
    if (Object.values(policy).some(v => Array.isArray(v) && v.length === 0)) parts.push(T('cognition.library_scope_none', '存在禁止使用的范围'));
    return parts.length ? parts.join(' · ') : T('cognition.library_scope_open', '未限定使用对象');
  }
  function uses(a) { return NS.ui.broughtInCountFor ? NS.ui.broughtInCountFor(a.id) : 0; }
  function filtered() {
    const query = state.query.trim().toLocaleLowerCase();
    const rows = (S.assets || []).filter(a => {
      if (!isFormalAsset(a)) return false;
      if (state.status === 'library' ? !['active', 'paused'].includes(statusOf(a)) : state.status !== 'all' && statusOf(a) !== state.status) return false;
      if (state.contentCategory && contentCategoryOf(a) !== state.contentCategory) return false;
      if (state.scope === 'restricted' && !Object.values(a.scopePolicy || {}).some(v => Array.isArray(v))) return false;
      if (state.scope && state.scope !== 'restricted' && !(Array.isArray(a.scopePolicy?.workspaceIds) ? a.scopePolicy.workspaceIds : []).includes(state.scope)) return false;
      return !query || [a.title, a.statement, a.scope, scopeNames(a)].join(' ').toLocaleLowerCase().includes(query);
    });
    // Aggregate the timeline once, rather than scanning every proof for every
    // asset. Counts still use the shared real-usage and exposure-dedup formula.
    const usesByAsset = state.sort === 'used' ? NS.ui.broughtInCountsFor() : null;
    return rows.sort((a, b) => (state.sort === 'name' ? String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true })
      : state.sort === 'used' ? (usesByAsset.get(String(b.id)) || 0) - (usesByAsset.get(String(a.id)) || 0)
        : String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      || String(a.id).localeCompare(String(b.id)));
  }
  function currentRows() {
    const rows = filtered();
    state.page = Math.min(Math.max(1, state.page), Math.max(1, Math.ceil(rows.length / PAGE_SIZE)));
    return { rows, pageRows: rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE) };
  }
  function syncSelection() {
    const route = S.route || {};
    if (route.name !== 'overview' || route.experienceId || route.category === 'experiences') {
      const tabs = document.getElementById?.('ca-tabs-nav');
      if (tabs) tabs.inert = false;
      return;
    }
    const category = String(route.category || '');
    if (category !== lastCategory) {
      if (category === 'deleted') state.status = 'deleted';
      lastCategory = category;
    }
  }
  if (NS.onChange) NS.onChange(syncSelection);
  let filterApis = [];
  let focusFilterKey = '';
  function closeFilters() {
    filterApis.forEach(api => typeof api.destroy === 'function' ? api.destroy() : api.close());
    filterApis = [];
  }
  function filterControl(key, label, options) {
    return `<div class="ca-library-filter" data-library-filter-key="${key}" data-filter-kind="cog-${key}">${window.uiSelect({
      id: `ca-library-filter-${key}`, ariaLabel: label, value: state[key],
      options: options.map(([value, label]) => ({ value, label })),
    })}</div>`;
  }
  function hydrateFilters(root) {
    if (!root?.querySelectorAll || typeof window._aiSelectMount !== 'function') return;
    const callbacks = {};
    for (const key of ['status', 'scope', 'contentCategory', 'sort']) {
      callbacks[`ca-library-filter-${key}`] = async value => {
        if (!(await guardNavigation())) {
          filterApis.find(api => api.el.closest('[data-library-filter-key]')?.dataset.libraryFilterKey === key)?.setValue(state[key]);
          return;
        }
        focusFilterKey = key;
        state[key] = value; state.page = 1; resetSelection();
      };
    }
    filterApis = window.hydrateUiFormSelects(root, callbacks);
  }
  function statusLabel(a) {
    const key = statusOf(a);
    return key === 'active' ? T('cognition.library_active', '启用') : key === 'paused' ? T('cognition.library_paused', '暂停')
      : key === 'deleted' ? T('cognition.library_deleted', '已删除') : a.mergedInto ? T('cognition.library_merged', '已归并') : T('cognition.library_archived', '归档');
  }
  function render(route) {
    syncSelection();
    const { rows, pageRows } = currentRows();
    const selected = (S.assets || []).find(a => a && String(a.id) === String(route.assetId));
    const invalidCount = (S.assets || []).filter(a => !isFormalAsset(a) && !['purged', 'revoked'].includes(statusOf(a))).length;
    const dirs = S.assetScopeOptions || {};
    const scopes = [['', T('cognition.library_all_scopes', '所有范围')], ['restricted', T('cognition.library_restricted', '有指定对象限制')], ...(dirs.spaces || []).map(s => [s.space_id, s.name || s.space_id])];
    const hasFilter = state.query || state.scope || state.contentCategory || state.status !== 'library';
    const assetsLoading = S.blockStatus?.assets?.loading ?? S.loading;
    const totalsUnavailable = !(S.assets || []).length && (S.assetsError || assetsLoading);
    const emptyHtml = assetsLoading && !S.assetsError && !(S.assets || []).length ? empty(T('common.loading', '加载中…'), '') : S.assetsError && !S.assets.length ? empty(T('cognition.library_read_failed', '认知内容未能读取'), T('cognition.library_read_retry', '请重试读取，已有数据不会被清空。'), { label: T('common.retry', '重试'), attrs: { 'data-act': 'library-refresh' } })
      : hasFilter ? empty(T('cognition.library_no_match', '没有匹配内容'), T('cognition.library_nightly_empty_hint', '夜间发现的完整建议会进入需要关注，确认后保存在这里。'), { label: T('cognition.library_clear', '清空筛选'), attrs: { 'data-act': 'library-clear' } })
      : selected ? empty(T('cognition.list_beside_selection', '当前筛选下无其他条目'), T('cognition.list_beside_selection_hint', '正在查看的这条不在当前列表中。'))
      : empty(T('cognition.library_empty', '这里还没有已保存的认知'), T('cognition.library_nightly_empty_hint', '夜间发现的完整建议会进入需要关注，确认后保存在这里。'), { label: T('cognition.settings_activity_link', '查看认知生长 ›'), attrs: { 'data-act': 'go-review' } });
    const table = pageRows.length ? `<table class="ca-library-table"><thead><tr><th>${esc(T('cognition.library_content', '内容'))}</th><th>${esc(T('cognition.content_category', '分类'))}</th><th>${esc(T('cognition.library_range', '范围'))}</th><th>${esc(T('cognition.library_status', '状态'))}</th></tr></thead><tbody>${pageRows.map(a => `<tr role="button" tabindex="0" data-act="library-select" data-id="${esc(a.id)}" aria-label="${esc(a.title || a.id)}" aria-pressed="${String(a.id) === String(route.assetId)}" class="${String(a.id) === String(route.assetId) ? 'is-selected' : ''}"><td><strong>${esc(a.title || a.id)}</strong><p>${esc(String(a.statement || '').split('\n').filter(Boolean)[0]?.slice(0, 180) || '')}</p></td><td>${esc(contentCategoryLabel(a))}</td><td>${esc(scopeNames(a))}</td><td>${esc(statusLabel(a))}<span aria-hidden="true">›</span></td></tr>`).join('')}</tbody></table>` : emptyHtml;
    const deletedError = state.status === 'deleted' && S.deletedAssets?.error
      ? `<p class="note" role="alert">${esc(S.deletedAssets.error)} ${btn(T('common.retry', '重试'), 'deleted-retry', { small: true })}</p>` : '';
    const narrow = isNarrow();
    // A wide side panel becomes a hidden detail on the next narrow paint, so the list stays clickable until the row is chosen again.
    if (!libraryRendered && narrow && selected && !state.closed && !sourcePreview) state.drawer = true;
    if (libraryRendered && narrow !== libraryWasNarrow) state.drawer = false;
    libraryRendered = true;
    libraryWasNarrow = narrow;
    const drawer = !!(selected && narrow && !sourcePreview && (state.drawer || route.assetEdit === '1'));
    const mirrorIds = html => html.replace(/\s(id|for|aria-controls)="([^"]+)"/g, (_, name, value) => ` ${name}="${value}-mirror"`);
    const detail = selected ? NS.renderLibraryAssetDetail(selected, route, { presentation: state.expanded ? 'mirror' : 'panel' }) : '';
    const expand = selected && state.expanded ? `<div class="ca-detail-expand" role="dialog" aria-modal="true" aria-label="${esc(T('cognition.detail_expand', '展开详情'))}"><div class="ca-detail-expand-panel">${NS.renderLibraryAssetDetail(selected, route, { presentation: 'expanded' })}</div></div>` : '';
    const aside = selected ? `<aside class="ca-detail-card ca-library-detail${drawer ? ' is-drawer-open' : ''}${state.expanded ? ' is-mirror' : ''}" role="${drawer && !state.expanded ? 'dialog' : 'complementary'}"${drawer && !state.expanded ? ' aria-modal="true"' : ''}${state.expanded ? ' data-detail-mirror="true" inert' : ''} aria-label="${esc(T('cognition.library_detail', '认知详情'))}">${state.expanded ? mirrorIds(detail) : detail}</aside>` : '';
    return `<section class="ca-library-page" data-library-selected="${esc(`${route.assetId || ''}${route.assetEdit ? ':edit' : ''}`)}">${expand}
      <div class="ca-library-toolbar"><div class="ca-prototype-search">${window.uiIconHtml('cognition-search')}${window.uiInput({ id: 'ca-library-search', value: state.query, type: 'search', placeholder: T('cognition.library_search', '搜索标题、正文或范围'), attrs: { 'aria-label': T('cognition.library_search', '搜索标题、正文或范围') } })}</div></div>${invalidCount ? `<p class="note" role="alert">${esc(T('cognition.library_invalid_records', '{n} 条记录的信息不完整，未计入正式库。', { n: String(invalidCount) }))}</p>` : ''}
      <div class="ca-library-filters">${filterControl('status', T('cognition.library_status', '状态'), [['library', T('cognition.library_in_library', '全部在库')], ['active', T('cognition.library_active', '启用')], ['paused', T('cognition.library_paused', '暂停')], ['archived', T('cognition.library_archived_merged', '归档 / 已归并')], ['deleted', T('cognition.library_deleted', '已删除')], ['all', T('cognition.library_all_status', '所有状态')]])}${filterControl('contentCategory', T('cognition.content_category', '分类'), [['', T('cognition.content_category_all', '所有分类')], ...CONTENT_CATEGORIES.map(([id, key, fallback]) => [id, T(key, fallback)])])}${filterControl('scope', T('cognition.library_range', '范围'), scopes)}${filterControl('sort', T('cognition.library_sort', '排序'), [['recent', T('cognition.library_recent', '最近修改')], ['name', T('cognition.library_name', '名称')], ['used', T('cognition.library_used', '带入或读取次数')]])}${hasFilter ? btn(T('cognition.library_clear', '清空筛选'), 'library-clear', { small: true, className: 'rnm' }) : ''}<div class="ca-library-refresh"><span class="note"${S.assetsError ? ' role="alert"' : ''}>${esc(S.assetsError ? T('cognition.library_partial', '读取失败 · 当前显示上次读取的内容') : assetsLoading ? T('common.loading', '加载中…') : T('cognition.activity_updated', '已更新'))}</span>${btn(T('common.refresh', '刷新'), 'library-refresh', { small: true })}</div></div>
      ${deletedError}
      <div class="ca-library-layout"><div class="ca-library-list"><div class="ca-library-table-wrap" id="ca-asset-list">${table}</div><div class="ca-library-pagination"><span>${esc(totalsUnavailable ? T('cognition.library_total_unknown', '总数暂不可用') : T('cognition.library_page_count', '每页 20 条 · {start}–{end} / {total}', { start: String(rows.length ? (state.page - 1) * PAGE_SIZE + 1 : 0), end: String(Math.min(state.page * PAGE_SIZE, rows.length)), total: String(rows.length) }))}${S.assetsError && (S.assets || []).length ? ` · ${esc(T('cognition.library_cached', '上次读取'))}` : ''}</span><div>${btn(T('common.previous', '上一页'), 'library-page', { small: true, id: '-1', disabled: state.page <= 1 })}<span>${totalsUnavailable ? '—' : `${state.page}/${Math.max(1, Math.ceil(rows.length / PAGE_SIZE))}`}</span>${btn(T('common.next', '下一页'), 'library-page', { small: true, id: '1', disabled: state.page * PAGE_SIZE >= rows.length })}</div></div></div>
      ${drawer && !state.expanded ? window.uiButton({ label: T('common.close', '关闭'), role: 'ghost', className: 'ca-library-scrim', attrs: { 'data-act': 'library-close', 'aria-hidden': 'true' } }) : ''}${aside}</div></section>`;
  }
  function resetSelection() {
    state.closed = false;
    state.drawer = false;
    NS.router.go({ name: 'overview', assetId: '', assetEdit: '' }, { replace: true });
  }
  async function guardNavigation() {
    if (!state.dirty) return true;
    if (!(await NS.confirmUser(T('cognition.library_unsaved', '有未保存的修改。放弃这些修改并继续？')))) return false;
    const drafts = Object.assign({}, S.assetEditDrafts || {});
    delete drafts[String(S.route.assetId || '')];
    S.assetEditDrafts = drafts;
    state.dirty = false;
    return true;
  }
  async function handleClick(el) {
    const action = el.dataset.act;
    if (!actions.includes(action)) return false;
    if (busy || el.disabled) return true;
    if (action.startsWith('library-show-')) {
      if (el.dataset.pendingRead) return true;
      el.dataset.pendingRead = '1';
      el.classList.add('is-pending'); el.setAttribute('aria-busy', 'true');
      try { await NS.showLibraryDialog(action.slice('library-show-'.length), el.dataset.id); }
      finally { delete el.dataset.pendingRead; el.classList.remove('is-pending'); el.removeAttribute('aria-busy'); }
      return true;
    }
    if (!['library-review-conflict', 'library-expand', 'library-expand-close'].includes(action) && !(await guardNavigation())) return true;
    if (action === 'library-select') {
      if (String(el.dataset.id) !== String(S.route.assetId)) state.expanded = false;
      sourcePreview = false;
      state.drawer = true; state.closed = false;
      NS.router.go({ name: 'overview', assetId: el.dataset.id }, { replace: true });
    } else if (action === 'library-expand') {
      if (!S.route.assetId) return true;
      state.expanded = true;
      NS.notify();
    } else if (action === 'library-expand-close') {
      state.expanded = false;
      NS.notify();
      focusAfterFrame(() => document.querySelector?.('.ca-library-detail:not(.is-mirror) [data-act="library-expand"]')?.focus?.({ preventScroll: true }));
    } else if (action === 'library-page') {
      state.page += Number(el.dataset.id); resetSelection();
    } else if (action === 'library-clear') {
      Object.assign(state, { query: '', status: 'library', scope: '', contentCategory: '', page: 1 }); resetSelection();
    } else if (action === 'library-close') {
      sourcePreview = false;
      state.drawer = false; state.closed = true; state.expanded = false;
      const id = String(S.route.assetId || '');
      NS.router.go({ ...S.route, assetId: '', assetEdit: '' }, { replace: true });
      const restoreRow = () => {
        const rows = document.querySelectorAll?.('[data-act="library-select"]') || [];
        Array.from(rows).find(row => row.dataset.id === id)?.focus();
      };
      // The route render replaces the table in the next frame; focus the new row.
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restoreRow);
      else restoreRow();
    } else if (action === 'library-open-inbox') {
      NS.router.go({ name: 'activity', inboxId: el.dataset.id });
    } else {
      busy = true;
      try {
        if (action === 'library-refresh') {
          if (S.route.assetEdit) NS.router.go({ ...S.route, assetEdit: '' }, { replace: true });
          await NS.reload();
        }
        if (action === 'library-review-conflict') {
          const id = String(S.route.assetId || '');
          await NS.reload();
          const latest = !S.assetsError && (S.assets || []).find(a => String(a.id) === id);
          const draft = S.assetEditDrafts?.[id];
          if (!latest || !draft || !['active', 'paused'].includes(statusOf(latest))) throw new Error(T('cognition.library_read_retry', '请重试读取，已有数据不会被清空。'));
          const confirmed = await NS.confirmUser(T('cognition.library_rebase_confirm', '当前版本 v{version}：{title}\n\n{content}\n\n使用范围：{scope}\n\n确认已核对上述最新内容，并保留你的草稿继续编辑？再次保存将以此版本为基准。', { version: String(latest.activeVersion || latest.version), title: String(latest.title || ''), content: String(latest.statement || ''), scope: scopeNames(latest) }));
          if (confirmed && S.route.assetId === id && S.assetEditDrafts?.[id] === draft) {
            S.assetEditDrafts[id] = { ...draft, baseVersion: String(latest.version), baseActiveVersion: String(latest.activeVersion || latest.version), baseScopePolicy: JSON.parse(JSON.stringify(latest.scopePolicy || {})), saveError: '', saveConflict: false };
            NS.notify();
          }
        }
      } catch (error) { await NS.alertUser(String(error?.message || error)); }
      finally { busy = false; }
    }
    return true;
  }
  async function handleInput(event) {
    const el = event.target;
    if (el.id === 'ca-library-search' && event.isComposing) return true;
    if (el.id === 'ca-library-search' || el.dataset?.libraryFilter) {
      if (!(await guardNavigation())) { if (el.id === 'ca-library-search') el.value = state.query; else el.value = state[el.dataset.libraryFilter]; return true; }
      const key = el.id === 'ca-library-search' ? 'query' : el.dataset.libraryFilter;
      state[key] = el.value; state.page = 1; resetSelection(); return true;
    }
    const form = el.closest?.('.ca-asset-edit');
    if (form?.closest?.('[data-detail-mirror], .is-mirror')) return false;
    if (form) {
      state.dirty = true;
      form.querySelector?.('[data-library-dirty-marker]')?.removeAttribute?.('hidden');
      if (el.dataset.prototypeScopeMode || el.dataset.prototypeScopeMulti) {
        const id = String(form.dataset.assetEditId || '');
        const field = el.dataset.prototypeScopeMode || el.dataset.prototypeScopeMulti;
        const modeControl = form.querySelector('[data-prototype-scope-mode="' + field + '"]');
        const multi = form.querySelector('[data-prototype-scope-multi="' + field + '"]');
        const mode = modeControl.value;
        const kind = modeControl.dataset.scopeKind;
        const draft = (S.assetEditDrafts || (S.assetEditDrafts = {}))[id] || (S.assetEditDrafts[id] = {});
        draft.scopeSelectionModes = { ...draft.scopeSelectionModes, [field]: mode };
        draft.scopeUnrestrict = [...(draft.scopeUnrestrict || []).filter(value => value !== kind), ...(mode === 'clear' ? [kind] : [])];
        const selection = { ...draft.scopeSelection };
        if (mode === 'restrict') selection[field] = Array.from(multi.selectedOptions).map(option => option.value);
        else delete selection[field];
        draft.scopeSelection = selection;
        multi.disabled = mode !== 'restrict' || S.assetScopeOptions?.status !== 'ready';
      }

    }
    return false;
  }
  function shouldGuard(action) {
    return S.route.name === 'overview' && ['tab', 'go-back', 'open-asset', 'go-inbox-asset', 'open-conversation', 'open-cleanup', 'open-cleanup-report', 'open-candidate', 'asset-edit-cancel', 'asset-action', 'select-asset-version'].includes(action);
  }
  function actionFinished() {
    if (!S.route.assetEdit) state.dirty = false;
  }
  function revealAsset(id) {
    const asset = (S.assets || []).find(item => isFormalAsset(item) && String(item.id) === String(id));
    if (!asset) return false;
    Object.assign(state, { query: '', scope: '', contentCategory: '', status: asset && !['active', 'paused'].includes(statusOf(asset)) ? statusOf(asset) : 'library', page: 1, drawer: true, closed: false, expanded: false, dirty: false });
    const index = filtered().findIndex(item => String(item.id) === String(id));
    if (index >= 0) state.page = Math.floor(index / PAGE_SIZE) + 1;
    NS.notify();
  }
  async function handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;
    if (S.route.name !== 'overview' || !document.querySelector?.('.ca-library-page')) return false;
    // The recall panel stays mounted while another top-level page is active.
    // A shortcut may only act on the visible editor, not a hidden draft.
    const panel = document.getElementById?.('panel-recall');
    if (panel && panel.classList && !panel.classList.contains('active')) return false;
    if (blockingOverlay()) return false;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && (S.route.assetEdit)) {
      event.preventDefault();
      (document.querySelector('.ca-detail-expand [data-act="asset-edit-save"]') || document.querySelector('[data-act="asset-edit-save"]'))?.click();
      return true;
    }
    const dialog = state.expanded ? document.querySelector('.ca-detail-expand') : document.querySelector('.ca-library-detail.is-drawer-open');
    if (dialog && event.key === 'Tab') {
      const focusable = Array.from(dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return true;
    }
    if (event.key === 'Escape' && state.expanded) { event.preventDefault(); await handleClick({ dataset: { act: 'library-expand-close' } }); return true; }
    if (event.key === 'Escape' && (state.drawer || S.route.assetId)) { event.preventDefault(); await handleClick({ dataset: { act: 'library-close' } }); return true; }
    if (event.target.closest?.('input,textarea,select,button,summary')) return false;
    const row = event.target.closest?.('[data-act="library-select"]');
    if (!row) return false;
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); await handleClick(row); return true; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const rows = Array.from(document.querySelectorAll('[data-act="library-select"]'));
      const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)]; next?.focus(); return true;
    }
    return false;
  }
  function captureRenderState(root) {
    const page = root?.querySelector?.('.ca-library-page');
    if (!page) return null;
    const active = document.activeElement;
    const detailRoot = page.querySelector('.ca-detail-expand') || page.querySelector('.ca-library-detail') || page;
    const details = Array.from(detailRoot.querySelectorAll('details') || []);
    return { key: page.dataset.librarySelected, drawer: !!page.querySelector('.ca-library-detail.is-drawer-open'), tableScroll: page.querySelector('.ca-library-table-wrap')?.scrollTop || 0,
      bodyScroll: detailRoot.querySelector('.ca-library-detail-body')?.scrollTop || page.querySelector('.ca-library-detail-body')?.scrollTop || 0,
      open: details.filter(d => !d.dataset?.detailFoldKey).map(d => d.open),
      sections: Object.fromEntries(details.filter(d => d.dataset?.detailFoldKey).map(d => [d.dataset.detailFoldKey, d.open])),
      field: active && page.contains(active) ? { id: active.id, filterKey: active.closest?.('[data-library-filter-key]')?.dataset.libraryFilterKey, name: active.dataset?.f, start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop, searchNode: active.id === 'ca-library-search' ? active : null } : null };
  }
  function restoreRenderState(root, before) {
    const page = root?.querySelector?.('.ca-library-page');
    if (!page) return;
    const same = before && before.key === page.dataset.librarySelected;
    const table = page.querySelector('.ca-library-table-wrap'); if (table && before) table.scrollTop = before.tableScroll;
    const detailRoot = page.querySelector('.ca-detail-expand') || page.querySelector('.ca-library-detail') || page;
    const body = detailRoot.querySelector('.ca-library-detail-body') || page.querySelector('.ca-library-detail-body');
    if (body) body.scrollTop = same && before ? before.bodyScroll : 0;
    if (same && before) {
      let index = 0;
      Array.from(detailRoot?.querySelectorAll('details') || []).forEach(d => {
        const key = d.dataset?.detailFoldKey;
        const open = key ? before.sections?.[key] : before.open[index++];
        if (open !== undefined) d.open = open;
      });
    }
    const field = before?.field;
    if (field && (same || field.id === 'ca-library-search')) {
      let el = field.filterKey ? document.getElementById(`ca-library-filter-${field.filterKey}`)?.querySelector('.ai-select-trigger') : field.id ? document.getElementById(field.id) : field.name ? Array.from(page.querySelectorAll('[data-f]')).find(n => n.dataset.f === field.name) : null;
      if (el && field.searchNode && typeof el.replaceWith === 'function') {
        field.searchNode.value = state.query;
        el.replaceWith(field.searchNode);
        el = field.searchNode;
      }
      if (el) { el.focus({ preventScroll: true }); if (typeof field.start === 'number' && typeof el.setSelectionRange === 'function' && !['checkbox', 'radio'].includes(el.type)) el.setSelectionRange(field.start, field.end); el.scrollTop = field.scroll; }
    } else if (state.drawer && isNarrow()) page.querySelector('.ca-library-detail button')?.focus({ preventScroll: true });
    const drawer = !!page.querySelector('.ca-library-detail.is-drawer-open');
    for (const selector of ['#ca-tabs-nav', '.ca-library-topline', '.ca-library-toolbar', '.ca-library-filters', '.ca-library-conversation', '.ca-library-list']) {
      const element = document.querySelector(selector); if (element) element.inert = drawer;
    }
    if (!drawer && focusFilterKey) {
      document.getElementById(`ca-library-filter-${focusFilterKey}`)?.querySelector('.ai-select-trigger')?.focus({ preventScroll: true });
      focusFilterKey = '';
    }
    if (drawer && !before?.drawer) {
      const panel = page.querySelector('.ca-library-detail');
      (panel.querySelector('input,textarea,select') || panel.querySelector('button'))?.focus({ preventScroll: true });
    }
  }
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(max-width: 1100px), (max-height: 500px)');
    media.addEventListener?.('change', () => { if (S.route.name === 'overview') NS.notify(); });
  }
  function closeForSourcePreview() {
    sourcePreview = true;
    if (!state.drawer) return;
    state.drawer = false;
    NS.notify();
  }
  function restoreAfterSourcePreview() {
    if (!sourcePreview) return;
    sourcePreview = false;
    if (S.route.name === 'overview' && S.route.assetId && isNarrow() && !state.closed) {
      state.drawer = true;
      NS.notify();
    }
  }
  document?.addEventListener?.('cogseed:file-viewer-closed', restoreAfterSourcePreview);
  NS.library = { closeFilters, hydrateFilters, render, filtered, isFormalAsset, handledActions: actions, handleClick, handleInput, handleKeydown, shouldGuard, guardNavigation, actionFinished, revealAsset, captureRenderState, restoreRenderState, closeForSourcePreview, restoreAfterSourcePreview, state };
})();
