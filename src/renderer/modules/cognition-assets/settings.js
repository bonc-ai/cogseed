/* 资产设置：夜间发现、模型顺序与自动确认的真实状态。由 app.js 委托动作调用。 */
(function () {
  'use strict';
  const NS = window.CogAssets;
  if (!NS) return;

  function discoveryStatus(snapshot, readError) {
    if (readError || !snapshot) return { state: 'unknown' };
    const sweep = snapshot.sweep || {};
    const result = sweep.lastResult;
    const base = {
      at: result?.finishedAt || sweep.lastRunAt,
      reviewDay: typeof result?.reviewDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.reviewDay) ? result.reviewDay : '',
      scanned: Math.max(0, Number(result?.scanned) || 0),
      queued: Math.max(0, Number(result?.queued) || 0),
      failed: Math.max(0, Number(result?.failed) || 0),
      deferred: Math.max(0, Number(result?.deferred) || 0),
    };
    const windowState = snapshot.window?.state;
    if (snapshot.runtime && snapshot.runtime.running) return { ...base, state: 'running', at: snapshot.runtime.startedAt };
    if (sweep.phase === 'partial_complete') return { ...base, state: 'partial_complete' };
    if (windowState === 'missed') return { ...base, state: 'missed' };
    if (windowState === 'scheduled') return { ...base, state: 'scheduled' };
    if (windowState === 'failure_held') return { ...base, state: 'failure_held' };
    if (windowState === 'stopped') return { ...base, state: 'stopped' };
    if (windowState === 'error') return { ...base, state: 'failed' };
    if (windowState === 'completed') return { ...base, state: 'completed' };
    if (snapshot.budget?.failureGuard?.held) return { ...base, state: 'failure_held' };
    if (['stopped', 'budget_held', 'failure_held'].includes(sweep.phase)) return { ...base, state: sweep.phase };
    if (!result) return { ...base, state: 'never' };
    return {
      ...base,
      state: sweep.phase === 'failed' || result.error || Number(result.failed) > 0 || Number(sweep.stock?.failed) > 0 ? 'failed' : 'completed',
    };
  }

  // Model rows are a business-owned composition (COG-PV-020), using shared
  // controls and modal lifecycle. The backend owns the configured model set.
  let catalog = { status: 'idle', models: [] };
  let catalogRead = 0;
  let saving = false;
  let picker = null;
  let pickerError = '';
  let pendingModel = '';
  let modelDrag = null;
  let autoApprovalSaving = false;
  let windowSaving = false;
  let windowError = '';
  let windowInvalid = false;
  let windowDraft = null;
  const RUN_TABS = ['overview', 'conversations', 'existing', 'failures'];
  let runTab = 'overview';
  function getRunTab() { return RUN_TABS.includes(runTab) ? runTab : 'overview'; }
  function setRunTab(value) {
    const next = String(value || '');
    if (!RUN_TABS.includes(next) || next === runTab) return;
    runTab = next;
    NS.notify();
  }
  function supportsAutoApproval() {
    return !NS.store.captureModelError && !!NS.store.captureSettings
      && NS.store.captureCapabilities?.autoApproval === true;
  }
  function settingCard({ title, hint, hintInline, controls, bodyHtml, id, className, attrs }) {
    const { esc } = NS;
    // hintInline（2026-11-06）：时间·触发这类短元数据跟标题同行；其余卡的说明句仍独占 note 段。
    const hintHtml = !hint ? '' : hintInline
      ? `<span class="ca-setting-head-hint">${esc(hint)}</span>`
      : `<p class="note">${esc(hint)}</p>`;
    return window.uiCard({
      tag: 'section',
      className: `ca-setting-card${className ? ` ${className}` : ''}`,
      attrs: { ...(id ? { id, tabindex: '-1' } : {}), ...(attrs || {}) },
      bodyHtml: `<div class="ca-setting-head"><div class="ca-setting-head-copy"><div class="tt">${esc(title)}${hintInline ? hintHtml : ''}</div>${hintInline ? '' : hintHtml}</div><div class="ca-setting-head-ctl">${controls || ''}</div></div>${bodyHtml ? `<div class="ca-setting-body">${bodyHtml}</div>` : ''}`,
    });
  }
  function autoApprovalControls() {
    const { T, esc } = NS;
    const known = !NS.store.captureModelError && !!NS.store.captureSettings;
    const supported = supportsAutoApproval();
    const on = supported && NS.store.captureSettings.autoApproval === true;
    const status = autoApprovalSaving ? T('cognition.settings_auto_confirmation_saving', '保存中…') : !known
      ? T('cognition.settings_policy_unknown', '状态未知') : on
        ? T('cognition.settings_discovery_allowed', '允许') : T('cognition.settings_auto_confirmation_off', '需逐条确认');
    return settingCard({
      title: T('cognition.settings_auto_confirmation_title', '自动确认'),
      hint: T('cognition.settings_auto_confirmation_hint', '依据完整、范围明确且无冲突的更新可自动保存；结构变化、冲突和不确定内容仍需你确认。'),
      controls: `${window.uiStatusPill({ label: status, tone: on ? 'success' : 'neutral' })}${window.uiSwitch({
        label: T('cognition.settings_auto_confirmation_switch', '允许自动确认'), checked: on,
        disabled: !supported || autoApprovalSaving, attrs: { 'data-act': 'auto-approval-toggle' },
      })}`,
      bodyHtml: `<div class="ca-auto-actions"><p>${esc(T('cognition.settings_auto_confirmation_history', '自动保存会保留依据、来源和版本，可在“已处理”里修改、暂停或撤回。'))}</p>${window.uiButton({
        label: T('cognition.settings_view_processed', '查看已处理 →'), role: 'ghost', className: 'ca-link-btn',
        attrs: { 'data-act': 'go-processed' },
      })}</div>${known && !supported ? `<p class="note" role="status">${esc(T('cognition.settings_auto_confirmation_unavailable', '当前运行版本尚不支持自动确认；请保持逐条确认。'))}</p>` : ''}`,
    });
  }

  /* ── 关联超过上限：合并或保留 ──
   * 溢出项没有候选可打开，清单只带身份元数据（标题/版本/是否可读），
   * 处置记录写回 capture；合并后由主进程重新核对这项源提案。 */
  let overflowRead = 0;
  let overflowRefreshTimer = null;
  const overflowItemKey = item => `${String(item.captureId || '')}:${Number(item.candidateIndex)}`;
  function overflowState() {
    const current = NS.store.relatedOverflow;
    return current && typeof current === 'object'
      ? current
      : { status: 'idle', runId: '', items: [], targets: {}, savingKey: '', actionErrors: {}, error: '' };
  }
  function firstReadableTarget(item) {
    return (item.assets || []).find(asset => asset.readable)?.id || '';
  }
  function scheduleOverflowRefresh() {
    // Background re-formation does not push through this page's read blocks;
    // one bounded re-read keeps "re-checking" honest without loading assets.
    if (overflowRefreshTimer || typeof setTimeout !== 'function') return;
    overflowRefreshTimer = setTimeout(() => {
      overflowRefreshTimer = null;
      if (NS.store.route?.name === 'settings') void loadRelatedOverflow(true);
    }, 10_000);
  }
  function selectedOverflowTarget(item, state = overflowState()) {
    const choices = (item.assets || []).filter(asset => asset.readable).map(asset => String(asset.id));
    const key = overflowItemKey(item);
    const previous = state.targets?.[key];
    return previous && choices.includes(previous) ? previous : choices[0] || '';
  }
  async function loadRelatedOverflow(force = false) {
    const S = NS.store;
    const current = overflowState();
    const statsRunId = String(S.captureStats?.sweep?.receipt?.runId || '');
    const expectedRunId = statsRunId || current.runId || '';
    if (!force && (current.status === 'loading' || current.status === 'refreshing')) return;
    if (!force && ['ready', 'error'].includes(current.status) && current.runId === expectedRunId) return;
    const generation = ++overflowRead;
    S.relatedOverflow = { ...current, status: (current.items || []).length ? 'refreshing' : 'loading', error: '' };
    NS.notify();
    try {
      const result = await NS.api.call('recall.captures.relatedOverflow.list', statsRunId ? { runId: statsRunId } : {});
      if (generation !== overflowRead) return;
      const items = Array.isArray(result.items) ? result.items : [];
      const targets = {};
      for (const item of items) if (!item.resolution) targets[overflowItemKey(item)] = selectedOverflowTarget(item, current);
      S.relatedOverflow = { status: 'ready', runId: String(result.runId || statsRunId || ''), items,
        targets, savingKey: '', actionErrors: {}, error: '' };
      if (items.some(item => item.reformation?.status === 'running')) scheduleOverflowRefresh();
    } catch {
      if (generation !== overflowRead) return;
      S.relatedOverflow = { ...current, status: 'error', runId: expectedRunId,
        error: 'related_overflow_read_failed', savingKey: '' };
    }
    NS.notify();
  }
  function selectOverflowTarget(key, assetId) {
    const state = overflowState();
    const item = (state.items || []).find(row => overflowItemKey(row) === key);
    if (!item || item.resolution) return;
    if (!(item.assets || []).some(asset => asset.id === assetId && asset.readable)) return;
    NS.store.relatedOverflow = { ...state, targets: { ...state.targets, [key]: assetId } };
    NS.notify();
  }
  async function relatedOverflowAction(action, el) {
    const { T } = NS;
    const state = overflowState();
    if (state.savingKey) return;
    if (action === 'related-overflow-reload') { await loadRelatedOverflow(true); return; }
    const key = String(el?.dataset?.overflowKey || '');
    const item = (state.items || []).find(row => overflowItemKey(row) === key);
    if (!item || item.captureUnavailable) return;
    const retry = action === 'related-overflow-retry';
    const keep = action === 'related-overflow-keep';
    const target = keep ? '' : (retry && item.resolution?.targetAssetId) || selectedOverflowTarget(item, state);
    if (!keep && !target) {
      NS.toast(T('cognition.settings_overflow_target_required', '请选择要合并到的内容。'), 'warning');
      return;
    }
    if (!retry) {
      const targetName = (item.assets || []).find(asset => asset.id === target)?.title || target;
      const message = keep
        ? T('cognition.settings_overflow_keep_confirm', '保留全部关联内容，不合并。这项建议不会形成候选；之后仍可在认知资产中手动整理。继续？')
        : T('cognition.settings_overflow_merge_confirm', '将把「{target}」以外的 {count} 条关联内容合并到「{target}」，然后重新核对这项建议。类型或范围不一致的内容会跳过；原内容保留版本记录。继续？', {
          target: targetName, count: String(Math.max(0, (item.relatedAssetIds || []).length - 1)),
        });
      if (!(await NS.confirmUser(message))) return;
    }
    const errors = { ...(state.actionErrors || {}) };
    delete errors[key];
    NS.store.relatedOverflow = { ...state, savingKey: `${key}:${action}`, actionErrors: errors };
    NS.notify();
    try {
      const result = await NS.api.call('recall.captures.relatedOverflow.resolve', {
        captureId: item.captureId, candidateIndex: item.candidateIndex,
        action: keep ? 'keep' : 'merge', ...(!keep && target ? { targetAssetId: target } : {}),
      });
      const skipped = Number(result?.merge?.skipped) || 0;
      if (keep) NS.toast(T('cognition.settings_overflow_kept_toast', '已保留全部关联内容。'), 'success');
      else if (retry) NS.toast(T('cognition.settings_overflow_retry_done', '已重新发起核对。'), 'success');
      else if (skipped) NS.toast(T('cognition.settings_overflow_merged_skipped_toast', '已合并，{count} 条不兼容内容已跳过；正在重新核对。', { count: String(skipped) }), 'success');
      else NS.toast(T('cognition.settings_overflow_merged_toast', '已合并，正在重新核对。'), 'success');
      await loadRelatedOverflow(true);
    } catch {
      NS.store.relatedOverflow = { ...overflowState(), savingKey: '',
        actionErrors: { ...errors, [key]: 'related_overflow_action_failed' } };
      NS.notify();
    }
  }
  function relatedOverflowSection() {
    const { T, esc } = NS;
    const state = overflowState();
    const items = Array.isArray(state.items) ? state.items : [];
    if (!items.length && state.status !== 'error') return '';
    const pendingCount = items.filter(item => !item.resolution && !item.captureUnavailable).length;
    const controls = `${window.uiStatusPill({ label: state.status === 'error' && !items.length
      ? T('cognition.settings_policy_unknown', '状态未知')
      : pendingCount
        ? T('cognition.settings_overflow_pending_count', '{count} 项待决定', { count: String(pendingCount) })
        : T('cognition.settings_overflow_all_resolved', '已全部处理'),
      tone: state.status === 'error' && !items.length ? 'neutral' : pendingCount ? 'attention' : 'success' })}${window.uiButton({
      label: T('cognition.settings_overflow_refresh', '刷新'), size: 'sm',
      disabled: state.status === 'loading' || state.status === 'refreshing',
      attrs: { 'data-act': 'related-overflow-reload' },
    })}`;
    const errorNote = state.status === 'error' && items.length
      ? `<p role="alert">${esc(T('cognition.settings_overflow_stale', '关联项暂时无法刷新；下方为上次读取结果。'))}</p>` : '';
    const emptyError = state.status === 'error' && !items.length
      ? `<p role="alert">${esc(T('cognition.settings_overflow_load_failed', '关联项暂时无法读取，请稍后重试。'))}</p>` : '';
    const rows = items.map(item => {
      const key = overflowItemKey(item);
      const pending = !item.resolution && !item.captureUnavailable;
      const saving = state.savingKey?.startsWith(`${key}:`) ? state.savingKey.slice(key.length + 1) : '';
      const assets = (item.assets || []).map(asset => `<li class="ca-overflow-asset${asset.readable ? '' : ' is-unreadable'}">
        <span class="ca-overflow-asset-name">${esc(asset.title || asset.id)}</span>
        <span class="note">${esc(asset.version ? T('cognition.settings_overflow_version', 'v{version}', { version: String(asset.version) }) : '')}</span>
        ${asset.readable ? '' : window.uiStatusPill({ label: T('cognition.settings_overflow_unreadable', '不可读取'), tone: 'neutral' })}
      </li>`).join('');
      const readableAssets = (item.assets || []).filter(asset => asset.readable);
      // A merge is only actionable when the owning capture can rejudge it.
      const canMerge = pending && item.reformable !== false;
      const target = selectedOverflowTarget(item, state);
      const targetField = canMerge && readableAssets.length
        ? `<label class="ca-overflow-target-field"><span>${esc(T('cognition.settings_overflow_target', '合并到'))}</span>${window.uiSelect({
          native: true, id: `ca-overflow-target-${key}`, ariaLabel: T('cognition.settings_overflow_target', '合并到'),
          value: target,
          options: readableAssets.map(asset => ({ value: String(asset.id), label: `${asset.title || asset.id} · v${String(asset.version || '')}` })),
          attrs: { 'data-overflow-target-field': '', 'data-overflow-key': key },
        })}</label>` : '';
      const actions = pending
        ? `<div class="actions ca-overflow-actions">${canMerge ? window.uiButton({
          label: saving === 'related-overflow-merge' ? T('cognition.settings_overflow_merging', '合并中…') : T('cognition.settings_overflow_merge', '合并并重新核对'),
          role: 'primary', size: 'sm', disabled: Boolean(state.savingKey) || !readableAssets.length,
          attrs: { 'data-act': 'related-overflow-merge', 'data-overflow-key': key },
        }) : ''}${window.uiButton({
          label: saving === 'related-overflow-keep' ? T('cognition.settings_overflow_keeping', '保留中…') : T('cognition.settings_overflow_keep', '保留全部'),
          size: 'sm', disabled: Boolean(state.savingKey),
          attrs: { 'data-act': 'related-overflow-keep', 'data-overflow-key': key },
        })}</div>` : '';
      const notReformableNote = pending && item.reformable === false
        ? `<p class="note">${esc(T('cognition.settings_overflow_not_reformable', '所属整理任务不能重新核对这项建议，只能保留全部关联内容。'))}</p>` : '';
      const resolution = item.resolution;
      const reform = item.reformation || { status: 'none' };
      const statusPill = item.captureUnavailable
        ? window.uiStatusPill({ label: T('cognition.settings_overflow_capture_missing', '记录不可读取'), tone: 'neutral' })
        : resolution?.action === 'kept'
          ? window.uiStatusPill({ label: T('cognition.settings_overflow_kept', '已保留全部'), tone: 'success' })
          : resolution?.action === 'merged'
            ? window.uiStatusPill({ label: reform.status === 'running'
              ? T('cognition.settings_overflow_rechecking', '重新核对中…')
              : T('cognition.settings_overflow_recheck_failed', '重新核对未完成'), tone: 'attention' })
            : window.uiStatusPill({ label: T('cognition.settings_overflow_pending', '待决定'), tone: 'attention' });
      const targetName = (item.assets || []).find(asset => asset.id === resolution?.targetAssetId)?.title || resolution?.targetAssetId || '';
      const skipped = (resolution?.receipts || []).filter(row => row.status !== 'merged').length;
      const resolvedNote = resolution?.action === 'kept'
        ? `<p class="note">${esc(T('cognition.settings_overflow_kept_note', '已按你的决定保留全部关联内容，没有形成候选。'))}</p>`
        : resolution?.action === 'merged'
          ? `<p class="note">${esc(skipped
            ? T('cognition.settings_overflow_merged_skipped_note', '已合并到「{target}」，{count} 条不兼容内容已跳过。', { target: targetName, count: String(skipped) })
            : T('cognition.settings_overflow_merged_note', '已合并到「{target}」。', { target: targetName }))}</p>`
          : '';
      const retryButton = resolution?.action === 'merged' && reform.status !== 'running'
        ? window.uiButton({ label: saving === 'related-overflow-retry'
          ? T('cognition.settings_overflow_retrying', '正在重试…') : T('cognition.settings_overflow_retry', '重试重新核对'),
          size: 'sm', disabled: Boolean(state.savingKey),
          attrs: { 'data-act': 'related-overflow-retry', 'data-overflow-key': key } })
        : '';
      const recheckNote = resolution?.action === 'merged' && reform.status === 'running'
        ? `<p class="note" role="status">${esc(T('cognition.settings_overflow_rechecking_note', '正在当前认知库上重新核对这项建议；完成后本项自动消失。'))}</p>`
        : resolution?.action === 'merged' && reform.status !== 'running'
          ? `<p role="alert">${esc(T('cognition.settings_overflow_recheck_failed_note', '合并已保存，但重新核对没有完成。可重试；原建议仍会保留。'))}</p>` : '';
      const actionError = state.actionErrors?.[key]
        ? `<p role="alert">${esc(T('cognition.settings_overflow_action_failed', '操作未完成，请重试。'))}</p>` : '';
      const conversation = item.conversationTitle || item.conversationId || T('cognition.settings_run_conversation', '对话');
      return `<li class="ca-overflow-item" data-overflow-key="${esc(key)}">
        <div class="ca-overflow-head"><div class="ca-overflow-head-copy"><strong>${esc(conversation)}</strong><p class="note">${esc(T('cognition.settings_overflow_item_meta', '第 {number} 项 · {count} 条关联内容', {
          number: String(Number(item.candidateIndex) + 1), count: String((item.relatedAssetIds || []).length),
        }))}</p></div>${statusPill}</div>
        <ul class="ca-overflow-assets">${assets}</ul>
        ${targetField}${notReformableNote}${resolvedNote}${recheckNote}${retryButton ? `<div class="actions ca-overflow-actions">${retryButton}</div>` : ''}${actionError}${actions}
      </li>`;
    }).join('');
    return settingCard({
      className: 'ca-decision-card',
      title: T('cognition.settings_overflow_title', '需要你决定'),
      hint: T('cognition.settings_overflow_hint', '这些建议关联了过多已有内容，系统没有自动形成候选。逐项核对后，把相关内容合并到一条，或全部保留；本页只读取名称、版本和可读性。'),
      controls,
      bodyHtml: `${errorNote}${emptyError}<ul class="ca-overflow-list">${rows}</ul>`,
    });
  }
  async function toggleAutoApproval() {
    if (!supportsAutoApproval() || autoApprovalSaving) return;
    const on = NS.store.captureSettings.autoApproval !== true;
    autoApprovalSaving = true;
    NS.notify();
    try {
      if (on && !(await NS.confirmUser(NS.T('cognition.settings_auto_confirmation_confirm', '开启后，系统可自动保存原文依据完整、范围明确且无冲突的认知和 A/R 更新。T 结构变化、冲突和不确定内容仍由你确认；自动处理均保留依据与版本，可查、可改、可撤回。确认开启？')))) return;
      await NS.actions.updateCaptureSettings({ autoApproval: on });
    } finally { autoApprovalSaving = false; NS.notify(); }
  }
  const keyOf = (model) => JSON.stringify([model.provider, model.model]);
  function candidates() { return (NS.store.captureSettings?.modelCandidates || []).map(item => ({ provider: item.provider, model: item.model })); }
  function effectiveModels() {
    const selected = candidates();
    if (!selected.length) return catalog.models.slice(0, 1);
    return selected.map(item => catalog.models.find(model => keyOf(model) === keyOf(item)) || {
      ...item, label: `${item.provider} · ${item.model}`, configured: false,
    });
  }
  async function loadModels(force = false) {
    if (!force && catalog.status !== 'idle') return;
    const generation = ++catalogRead;
    if (!force && Array.isArray(NS.store.captureModelSelection?.configured)) {
      catalog = { status: 'ready', models: NS.store.captureModelSelection.configured };
      NS.notify();
      renderPicker();
      return;
    }
    catalog = { ...catalog, status: 'loading' };
    NS.notify();
    renderPicker();
    try {
      const result = await window.cogseed.invoke('recall.captures.settings.get', {});
      if (!result?.ok || !Array.isArray(result.modelSelection?.configured)) throw new Error('model directory unavailable');
      if (generation !== catalogRead) return;
      catalog = { status: 'ready', models: result.modelSelection.configured };
    } catch {
      if (generation !== catalogRead) return;
      catalog = { ...catalog, status: 'error' };
    }
    NS.notify();
    renderPicker();
  }
  function modelNote(item) {
    if (item.available === false) return NS.T('cognition.settings_nightly_model_unavailable', '系统配置中已停用或移除');
    if (item.configured === false) return NS.T('cognition.settings_nightly_model_legacy', '已不在设置列表，保留原配置');
    return '';
  }
  function modelIdentity(item) {
    const label = item.label || `${item.provider} · ${item.model}`;
    const divider = label.indexOf(' · ');
    return { title: divider < 0 ? item.model : label.slice(divider + 3),
      provider: divider < 0 ? item.provider : label.slice(0, divider) };
  }
  // Shared card shell; only the model identity, status and actions are page-owned.
  // The title button stretches its native click target over interactive cards.
  function modelCard({ title, provider, label, icon = 'cpu', status = '', actions = '', action = null, note = '', leading = '' }) {
    const { esc } = NS;
    const heading = action ? window.uiButton({ label: title, role: 'ghost', className: 'ca-nightly-model-hit', ...action })
      : `<strong class="ca-nightly-model-name">${esc(title)}</strong>`;
    return window.uiCard({ tag: 'div', className: 'ca-nightly-model-card', readonly: !action,
      attrs: { 'aria-label': label, ...(action ? {} : { 'data-readonly': 'true' }) },
      bodyHtml: `${leading}<span class="ui-resource-card__icon">${window.uiIconHtml(icon)}</span><div class="ca-nightly-model-copy">${heading}<span class="ca-nightly-model-provider">${esc(provider)}</span>${note ? `<span class="ca-nightly-model-note">${esc(note)}</span>` : ''}</div><div class="ca-nightly-model-trailing">${status}${actions}</div>`,
    });
  }
  function modelControls() {
    const { T, esc } = NS;
    const selected = candidates();
    const models = effectiveModels();
    const blocked = saving || Boolean(NS.store.captureModelError) || !NS.store.captureSettings;
    const rows = models.map((item, index) => {
      const identity = modelIdentity(item);
      const role = index === 0 ? T('cognition.settings_model_role_first', '首选')
        : T('cognition.settings_model_role_backup', '备用 {number}', { number: String(index) });
      const sortable = selected.length > 1 && !blocked;
      const rank = sortable
        ? window.uiButton({
          label: String(index + 1), size: 'sm', className: 'ca-model-rank', disabled: blocked,
          attrs: {
            'data-model-sort-handle': '', 'data-model-key': keyOf(item), 'data-index': String(index),
            'aria-label': T('cognition.settings_nightly_model_drag_label', '拖动或按上下键调整 {model} 顺序', { model: identity.title }),
          },
        })
        : `<span class="ca-model-rank" aria-hidden="true">${index + 1}</span>`;
      const remove = selected.length ? window.uiButton({
        label: '×', role: 'ghost', className: 'ca-model-x', disabled: blocked,
        attrs: { 'data-act': 'nightly-model-remove', 'data-index': String(index), 'aria-label': `${T('cognition.settings_nightly_model_remove', '移除')} · ${identity.title}` },
      }) : '';
      const note = modelNote(item);
      return `<li class="ca-model-row" data-model-sort-index="${index}"${sortable ? ' draggable="true"' : ''}>${rank}<span class="ca-model-copy"><strong>${esc(identity.title)}</strong><span>${esc(identity.provider)}</span>${note ? `<span class="ca-model-note">${esc(note)}</span>` : ''}</span><span class="ca-model-trailing">${window.uiStatusPill({ label: role, tone: index === 0 && selected.length ? 'success' : 'neutral' })}${remove}</span></li>`;
    }).join('');
    const state = catalog.status === 'error' ? T('cognition.settings_nightly_model_error', '模型列表读取失败，已保存的顺序保持不变。')
      : catalog.status !== 'ready' ? T('cognition.settings_nightly_model_loading', '正在读取系统模型列表…')
      : !models.length ? T(NS.store.captureModel?.channel === 'cli' ? 'cognition.settings_nightly_model_system_cli'
        : NS.store.captureModel?.apiConfigured ? 'cognition.settings_nightly_model_environment' : 'cognition.settings_nightly_model_empty',
        NS.store.captureModel?.channel === 'cli' ? '未配置系统模型，将使用可用的本地助手；具体模型由本地助手决定。'
          : NS.store.captureModel?.apiConfigured ? '未配置系统模型，将使用环境变量配置的模型。' : '系统中没有可选模型。') : '';
    const add = window.uiButton({
      label: T('cognition.settings_nightly_model_add_row', '添加模型'), icon: 'plus', size: 'sm', className: 'ca-model-add',
      disabled: blocked || catalog.status !== 'ready' || !catalog.models.length || models.length >= 32,
      attrs: { 'data-act': 'nightly-model-add', 'aria-haspopup': 'dialog' },
    });
    return `<section class="ca-run-panel" data-settings-models${saving ? ' aria-busy="true"' : ''}>
      <div class="ca-run-panel-head"><div class="ca-run-panel-title"><span class="ca-run-panel-icon" aria-hidden="true">${window.uiIconHtml('cpu')}</span><h4>${esc(T('cognition.settings_model_title', '模型顺序'))}</h4></div><p class="ca-run-panel-meta">${esc(T('cognition.settings_model_order_hint', '首选失败时按顺序尝试备用'))}</p></div>
      ${rows ? `<ol class="ca-model-list">${rows}</ol>` : ''}
      ${add}
      <div class="ca-run-panel-foot"><p class="note">${esc(T('cognition.settings_model_drag_hint', '拖动模型行可调整顺序。'))}</p><div class="ca-model-footer">${catalog.status === 'error' ? window.uiButton({
        label: T('cognition.settings_nightly_model_retry', '重试读取'), role: 'ghost', className: 'ca-link-btn', disabled: saving,
        attrs: { 'data-act': 'nightly-model-retry' },
      }) : ''}${selected.length ? window.uiButton({
        label: T('cognition.settings_nightly_model_reset', '恢复跟随系统'), role: 'ghost', className: 'ca-link-btn', disabled: blocked,
        attrs: { 'data-act': 'nightly-model-reset' },
      }) : ''}</div></div>
      ${state ? `<p class="note" role="status">${esc(state)}</p>` : ''}
      ${saving ? `<p class="note" role="status">${esc(T('cognition.settings_nightly_model_saving', '正在保存…'))}</p>` : ''}
    </section>`;
  }
  function pickerBody() {
    const { T, esc } = NS;
    const models = effectiveModels();
    return `<div class="ca-nightly-model-picker" aria-busy="${saving}"><ul class="ca-nightly-model-list">${catalog.models.map(item => {
      const added = models.some(model => keyOf(model) === keyOf(item));
      const note = added ? T('cognition.settings_nightly_model_added', '已添加') : modelNote(item);
      const selectable = !added && item.available;
      const busy = saving && pendingModel === keyOf(item);
      const status = busy ? window.uiStatusPill({ label: T('cognition.settings_nightly_model_saving', '正在保存…'), tone: 'neutral' })
        : note ? window.uiStatusPill({ label: added ? note : T('cognition.settings_nightly_model_unavailable_short', '不可用'), tone: added ? 'success' : 'attention', check: added }) : window.uiIconHtml('plus', 'ca-nightly-model-chevron');
      return `<li>${modelCard({ ...modelIdentity(item), label: item.label,
        status, note: !added && note ? note : '',
        action: selectable ? { disabled: saving || catalog.status !== 'ready' || models.length >= 32,
          loading: busy, attrs: { 'data-model-key': keyOf(item), 'aria-label': `${item.label} — ${T('cognition.settings_nightly_model_add_row', '添加模型')}` } } : null })}</li>`;
    }).join('')}</ul>${pickerError ? `<p class="ui-form-modal__feedback" role="alert">${esc(pickerError)}</p>` : ''}${catalog.status === 'error' ? `<p role="alert">${esc(T('cognition.settings_nightly_model_error', '模型列表读取失败，已保存的顺序保持不变。'))}</p>` : ''}</div>`;
  }
  function renderPicker() {
    if (!picker) return;
    const { T } = NS;
    const focused = picker.dialog.querySelector(':focus')?.dataset.modelKey;
    picker.dialog.querySelector('.ui-modal__title').textContent = T('cognition.settings_nightly_model_choose', '选择模型');
    picker.dialog.querySelector('[data-ui-modal-close]').setAttribute('aria-label', T('common.close', '关闭'));
    picker.dialog.querySelector('.ui-modal__body').innerHTML = pickerBody();
    if (saving) picker.dialog.focus();
    else if (focused || pickerError) Array.from(picker.dialog.querySelectorAll('[data-model-key]')).find(node => node.dataset.modelKey === (focused || pendingModel))?.focus();
  }
  async function saveModels(selected) {
    saving = true;
    NS.notify();
    renderPicker();
    try { await NS.actions.updateCaptureSettings({ modelCandidates: selected.map(item => ({ provider: item.provider, model: item.model })) }); }
    finally { saving = false; NS.notify(); }
  }
  function clearModelDrag(root) {
    modelDrag = null;
    root?.querySelectorAll?.('[data-model-sort-index]')?.forEach(row => row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
  }
  function focusModelHandle(root, key) {
    Array.from(root?.querySelectorAll?.('[data-model-sort-handle]') || []).find(node => node.dataset.modelKey === key)?.focus();
  }
  async function moveModel(sourceKey, targetKey, after, root, expectedOrder) {
    if (saving || NS.store.captureModelError || !NS.store.captureSettings) return;
    const selected = candidates();
    const order = selected.map(keyOf);
    if (expectedOrder && JSON.stringify(order) !== JSON.stringify(expectedOrder)) return;
    const from = order.indexOf(sourceKey);
    const target = order.indexOf(targetKey);
    if (from < 0 || target < 0 || from === target) return;
    const [moved] = selected.splice(from, 1);
    const targetIndex = selected.findIndex(item => keyOf(item) === targetKey);
    selected.splice(targetIndex + (after ? 1 : 0), 0, moved);
    if (JSON.stringify(selected.map(keyOf)) === JSON.stringify(order)) return;
    try { await saveModels(selected); }
    catch { await NS.alertUser(NS.T('cognition.settings_nightly_model_save_error', '未能保存模型列表，请重试。')); }
    finally { focusModelHandle(root, sourceKey); }
  }
  function modelDragStart(event, root) {
    const row = event.target?.closest?.('[data-model-sort-index]');
    const selected = candidates();
    const index = Number(row?.dataset.modelSortIndex);
    if (!row?.draggable || saving || NS.store.captureModelError || !Number.isInteger(index) || !selected[index]) return;
    modelDrag = { key: keyOf(selected[index]), order: selected.map(keyOf) };
    row.classList.add('is-dragging');
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'cogseed-model-order'); }
  }
  function modelDragOver(event, root) {
    if (!modelDrag) return;
    const row = event.target?.closest?.('[data-model-sort-index]');
    if (!row || !root?.contains?.(row)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('[data-model-sort-index]').forEach(node => node.classList.remove('is-drop-before', 'is-drop-after'));
    const targetIndex = Number(row.dataset.modelSortIndex);
    const sourceIndex = modelDrag.order.indexOf(modelDrag.key);
    if (targetIndex !== sourceIndex) row.classList.add(sourceIndex < targetIndex ? 'is-drop-after' : 'is-drop-before');
  }
  async function modelDrop(event, root) {
    if (!modelDrag) return;
    const row = event.target?.closest?.('[data-model-sort-index]');
    if (!row || !root?.contains?.(row)) { clearModelDrag(root); return; }
    event.preventDefault();
    const drag = modelDrag;
    const selected = candidates();
    const target = selected[Number(row.dataset.modelSortIndex)];
    const after = drag.order.indexOf(drag.key) < Number(row.dataset.modelSortIndex);
    clearModelDrag(root);
    if (target) await moveModel(drag.key, keyOf(target), after, root, drag.order);
  }
  async function modelSortKeydown(event, root) {
    if (event.isComposing || event.keyCode === 229 || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const handle = event.target?.closest?.('[data-model-sort-handle]');
    if (!handle || handle.disabled) return;
    const selected = candidates();
    const from = selected.findIndex(item => keyOf(item) === handle.dataset.modelKey);
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    const target = selected[from + direction];
    event.preventDefault();
    if (from >= 0 && target) await moveModel(keyOf(selected[from]), keyOf(target), direction > 0, root);
  }
  async function openModelPicker(root) {
    if (picker || catalog.status !== 'ready') return;
    pickerError = '';
    const modal = window.uiModal({ title: NS.T('cognition.settings_nightly_model_choose', '选择模型'),
      closeLabel: NS.T('common.close', '关闭'), size: 'md', bodyHtml: pickerBody(), initialFocus: '[data-model-key]:not([disabled])' });
    picker = modal;
    const onChoose = async event => {
      const control = event.target.closest('[data-model-key]');
      if (!control || control.disabled || saving) return;
      const item = catalog.models.find(model => keyOf(model) === control.dataset.modelKey);
      const selected = effectiveModels();
      if (!item?.available || selected.some(model => keyOf(model) === keyOf(item)) || selected.length >= 32) return;
      pendingModel = keyOf(item);
      pickerError = '';
      try {
        await saveModels([...selected, item]);
        modal.close(null, 'saved');
      } catch {
        pickerError = NS.T('cognition.settings_nightly_model_save_error', '未能保存模型列表，请重试。');
        renderPicker();
      }
    };
    modal.dialog.addEventListener('click', onChoose);
    await modal;
    modal.dialog.removeEventListener('click', onChoose);
    if (picker === modal) picker = null;
    root?.querySelector('[data-act="nightly-model-add"]')?.focus();
  }
  async function modelAction(action, element, root) {
    if (action === 'nightly-model-retry') { await loadModels(true); return; }
    if (saving || NS.store.captureModelError || !NS.store.captureSettings) return;
    if (action === 'nightly-model-add') { await openModelPicker(root); return; }
    const selected = candidates();
    const index = Number(element.dataset.index);
    if (action === 'nightly-model-reset') selected.length = 0;
    else {
      if (!Number.isInteger(index) || index < 0 || index >= selected.length) return;
      if (action === 'nightly-model-remove') selected.splice(index, 1);
      else if (action === 'nightly-model-up' || action === 'nightly-model-down') {
        const target = index + (action === 'nightly-model-up' ? -1 : 1);
        if (target < 0 || target >= selected.length) return;
        [selected[index], selected[target]] = [selected[target], selected[index]];
      } else return;
    }
    await saveModels(selected);
  }
  window.addEventListener?.('cogseed:model-entries-changed', () => {
    NS.store.captureModelSelection = null;
    if (NS.store.route?.name === 'settings' || picker) void loadModels(true);
    else { ++catalogRead; catalog.status = 'idle'; }
  });
  window.addEventListener?.('i18n-change', renderPicker);
  function timezoneLabel() {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const offset = -new Date().getTimezoneOffset();
      const sign = offset >= 0 ? '+' : '-';
      const absolute = Math.abs(offset);
      const formatted = `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
      return zone ? `${zone}（${formatted}）` : formatted;
    } catch {
      return '';
    }
  }

  function windowSpan(startValue, endValue) {
    const { T } = NS;
    const minutes = value => {
      const [h, m] = String(value || '').split(':').map(Number);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
    };
    const start = minutes(startValue), end = minutes(endValue);
    if (start == null || end == null || start === end) {
      return { text: T('cognition.settings_window_duration_unknown', '时长待核对'), overnight: false, valid: false };
    }
    const overnight = end < start;
    const span = overnight ? 1440 - start + end : end - start;
    const hours = Math.floor(span / 60), rest = span % 60;
    return {
      text: rest
        ? T('cognition.settings_window_duration_minutes', '{hours} 小时 {minutes} 分钟', { hours: String(hours), minutes: String(rest) })
        : T('cognition.settings_window_duration_hours', '{hours} 小时', { hours: String(hours) }),
      overnight,
      valid: true,
    };
  }

  function dayLabel(date) {
    const { T } = NS;
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const now = new Date();
    if (sameDay(date, now)) return T('cognition.settings_window_day_today', '今天');
    if (sameDay(date, new Date(now.getTime() + 86400000))) return T('cognition.settings_window_day_tomorrow', '明天');
    return T('cognition.settings_window_day_dated', '{month} 月 {day} 日', { month: String(date.getMonth() + 1), day: String(date.getDate()) });
  }

  function nextRunParts(windowState) {
    const { T } = NS;
    if (windowState?.withinWindow) return { label: T('cognition.settings_window_due', '本次窗口内，可立即扫描。'), time: '' };
    const date = windowState?.nextRunAt ? new Date(windowState.nextRunAt) : null;
    if (!date || Number.isNaN(date.getTime())) return { label: T('cognition.settings_window_next_unknown', '下次运行时间待核对。'), time: '' };
    return { label: dayLabel(date), time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` };
  }

  function nextRunText(parts) {
    return parts.time ? `${parts.label} ${parts.time}` : parts.label;
  }

  function nextRunValue(windowState) {
    const { T } = NS;
    const parts = nextRunParts(windowState);
    if (parts.time) return `${parts.label} ${parts.time}`;
    if (windowState?.withinWindow) return parts.label;
    return T('cognition.settings_window_next_unknown_short', '待核对');
  }

  function previewNextText(startValue) {
    const { T } = NS;
    const [h, m] = String(startValue || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return T('cognition.settings_window_next_unknown', '下次运行时间待核对。');
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return `${dayLabel(target)} ${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  }

  function windowControls() {
    const { T, esc } = NS;
    const settings = NS.store.captureSettings || {};
    const windowState = NS.store.captureStats?.window || {};
    const known = !NS.store.captureModelError && !!NS.store.captureSettings;
    const disabled = windowSaving || !known;
    const start = windowDraft?.start ?? settings.nightlyStart ?? (known ? '02:00' : '');
    const end = windowDraft?.end ?? settings.nightlyEnd ?? (known ? '06:00' : '');
    const span = windowSpan(start, end);
    const next = known ? nextRunValue(windowState) : T('cognition.settings_window_next_unknown_short', '待核对');
    const field = (labelKey, fallback, name, value) => `<label class="ca-run-field"><span>${esc(T(labelKey, fallback))}</span>${window.uiInput({
      id: `ca-window-${name}`, type: 'time', value, disabled, invalid: windowInvalid,
      ...(windowError ? { describedBy: 'ca-window-error' } : {}),
      attrs: { 'data-window-field': name, 'aria-label': T(labelKey, fallback) },
    })}</label>`;
    return `<section class="ca-run-panel" data-settings-window>
      <div class="ca-run-panel-head"><div class="ca-run-panel-title"><span class="ca-run-panel-icon" aria-hidden="true">${window.uiIconHtml('clock')}</span><h4>${esc(T('cognition.settings_window_title', '每日运行窗口'))}</h4></div>${known ? '' : `<p class="ca-run-panel-meta">${esc(T('cognition.settings_policy_unknown', '状态未知'))}</p>`}</div>
      <div class="ca-run-lines">
        <div class="ca-run-line">
          <div class="ca-run-fields">${field('cognition.settings_window_start', '开始时间', 'start', start)}<span class="ca-run-to">${esc(T('cognition.settings_window_to', '至'))}</span>${field('cognition.settings_window_end', '结束时间', 'end', end)}</div>
          <p class="ca-run-read">${esc(T('cognition.settings_window_duration_label', '共'))} <span data-window-duration>${esc(span.text)}</span><span class="ca-run-sep">·</span><span data-window-wrap>${esc(span.overnight ? T('cognition.settings_window_overnight', '跨夜到次日') : T('cognition.settings_window_same_day', '不跨夜'))}</span></p>
          <p class="ca-run-note" title="${esc(timezoneLabel())}">${esc(`${T('cognition.settings_window_cadence', '每天运行一次')} · ${T('cognition.settings_window_timezone_follow', '时区跟随系统')}`)}</p>
        </div>
        <div class="ca-run-line">
          <p class="ca-run-read">${esc(T('cognition.settings_window_next_label', '下次运行'))} <b data-window-next>${esc(next)}</b></p>
          <p class="ca-run-note">${esc(T('cognition.settings_window_rule', '应用需保持运行，错过窗口不补扫；修改从下一轮生效。'))}</p>
          <div class="ca-run-acts">${window.uiButton({
            label: T('cognition.settings_window_reset', '恢复默认'), role: 'ghost', className: 'ca-link-btn', disabled,
            attrs: { 'data-act': 'nightly-window-reset' },
          })}${window.uiButton({
            label: windowSaving ? T('cognition.settings_window_saving', '保存中…') : T('cognition.settings_window_save', '保存'),
            role: 'primary', size: 'sm', disabled, attrs: { 'data-act': 'nightly-window-save' },
          })}</div>
        </div>
      </div>
      <p class="note ca-run-error" id="ca-window-error" role="alert" data-window-error ${windowError ? '' : 'hidden'}>${esc(windowError)}</p>
    </section>`;
  }

  function runSettingsCard(options) {
    const { T } = NS;
    return settingCard({
      title: T('cognition.settings_run_section_title', '运行设置'),
      hint: T('cognition.settings_run_section_hint', '决定什么时候运行，以及按什么顺序尝试模型。'),
      id: options?.id,
      bodyHtml: `<div class="ca-run-panels">${windowControls()}${modelControls()}</div>`,
    });
  }

  async function saveWindow(startValue, endValue, successMessage) {
    const { T } = NS;
    const start = String(startValue || '').trim();
    const end = String(endValue || '').trim();
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!timePattern.test(start) || !timePattern.test(end)) {
      windowInvalid = true;
      windowError = T('cognition.settings_window_invalid', '请填写 HH:mm 格式的时间。');
      NS.notify();
      return;
    }
    if (start === end) {
      windowInvalid = true;
      windowError = T('cognition.settings_window_same', '开始和结束时间不能相同，请调整其中一个。');
      NS.notify();
      return;
    }
    windowSaving = true;
    windowError = '';
    windowInvalid = false;
    NS.notify();
    try {
      await NS.actions.updateCaptureSettings({ nightlyStart: start, nightlyEnd: end }, { silent: true });
      windowDraft = null;
      NS.toast(successMessage || T('cognition.settings_window_saved', '已保存，下一轮生效。'), 'success');
    } catch {
      windowError = T('cognition.settings_window_save_failed', '未能保存时间，请重试。');
    } finally {
      windowSaving = false;
      NS.notify();
    }
  }

  async function windowAction(action, el, root) {
    if (windowSaving || NS.store.captureModelError || !NS.store.captureSettings) return;
    const container = el?.closest?.('[data-settings-window]') || root?.querySelector?.('[data-settings-window]') || (typeof document !== 'undefined' ? document : null);
    const read = name => container?.querySelector?.(`[data-window-field="${name}"]`)?.value
      ?? root?.querySelector?.(`[data-window-field="${name}"]`)?.value
      ?? windowDraft?.[name];
    if (action === 'nightly-window-reset') {
      await saveWindow('02:00', '06:00', NS.T('cognition.settings_window_reset_done', '已恢复默认，下一轮生效。'));
      return;
    }
    if (action === 'nightly-window-save') {
      windowDraft = { start: String(read('start') ?? ''), end: String(read('end') ?? '') };
      await saveWindow(windowDraft.start, windowDraft.end);
    }
  }

  function windowInput(event) {
    const field = String(event?.target?.dataset?.windowField || '');
    if (field !== 'start' && field !== 'end') return;
    const { T } = NS;
    windowDraft = { ...(windowDraft || {}), [field]: String(event.target.value || '') };
    windowError = '';
    windowInvalid = false;
    const group = event.target.closest?.('[data-settings-window]');
    group?.querySelectorAll?.('[data-window-field]')?.forEach(input => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); });
    const node = group?.querySelector?.('[data-window-error]');
    if (node) { node.textContent = ''; node.hidden = true; }
    const start = group?.querySelector?.('[data-window-field="start"]')?.value ?? windowDraft.start;
    const end = group?.querySelector?.('[data-window-field="end"]')?.value ?? windowDraft.end;
    const span = windowSpan(start, end);
    const duration = group?.querySelector?.('[data-window-duration]');
    if (duration) duration.textContent = span.text;
    const wrap = group?.querySelector?.('[data-window-wrap]');
    if (wrap) wrap.textContent = span.overnight ? T('cognition.settings_window_overnight', '跨夜到次日') : T('cognition.settings_window_same_day', '不跨夜');
    const next = group?.querySelector?.('[data-window-next]');
    if (next) next.textContent = previewNextText(start);
  }

  NS.assetSettings = { discoveryStatus, loadModels, modelControls, modelAction,
    modelDragStart, modelDragOver, modelDrop, clearModelDrag, modelSortKeydown,
    supportsAutoApproval, autoApprovalControls, toggleAutoApproval, settingCard, runSettingsCard,
    windowControls, windowAction, windowInput, nextRunParts, nextRunText, nextRunValue,
    getRunTab, setRunTab,
    loadRelatedOverflow, relatedOverflowSection, relatedOverflowAction, selectOverflowTarget };
})();
