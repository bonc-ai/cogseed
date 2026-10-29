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

  function captureDisclosures(root) {
    return Array.from(root?.querySelectorAll?.('[data-settings-disclosure]') || []).map((node) => ({
      key: node.dataset.settingsDisclosure,
      open: node.querySelector('details')?.open === true,
    }));
  }

  function restoreDisclosures(root, state) {
    for (const node of root?.querySelectorAll?.('[data-settings-disclosure]') || []) {
      const previous = (state || []).find((item) => item.key === node.dataset.settingsDisclosure);
      const details = node.querySelector('details');
      if (previous && details) details.open = previous.open;
    }
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
  function supportsAutoApproval() {
    return !NS.store.captureModelError && !!NS.store.captureSettings
      && NS.store.captureCapabilities?.autoApproval === true;
  }
  function settingCard({ title, hint, controls, bodyHtml }) {
    const { esc } = NS;
    return window.uiCard({
      tag: 'section',
      className: 'ca-setting-card',
      bodyHtml: `<div class="ca-setting-head"><div class="ca-setting-head-copy"><div class="tt">${esc(title)}</div>${hint ? `<p class="note">${esc(hint)}</p>` : ''}</div><div class="ca-setting-head-ctl">${controls || ''}</div></div>${bodyHtml ? `<div class="ca-setting-body">${bodyHtml}</div>` : ''}`,
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
    const flowNote = NS.store.captureSettings?.autoApproval === true && supported
      ? T('cognition.settings_nightly_auto_review_hint', '符合自动确认规则的完整建议保存后进入“已处理”；其余完整建议留在“需要关注”，由你决定。')
      : T('cognition.settings_nightly_review_hint', '完整建议进入“需要关注”，由你确认后保存到“我的认知”。');
    return settingCard({
      title: T('cognition.settings_auto_confirmation_title', '自动确认'),
      controls: `${window.uiStatusPill({ label: status, tone: on ? 'success' : 'neutral' })}${window.uiSwitch({
        label: T('cognition.settings_auto_confirmation_switch', '允许自动确认'), checked: on,
        disabled: !supported || autoApprovalSaving, attrs: { 'data-act': 'auto-approval-toggle' },
      })}`,
      bodyHtml: `<p class="note">${esc(T('cognition.settings_auto_confirmation_hint', '默认关闭。开启后，原文依据完整、范围明确且无冲突的认知和 A/R 更新可自动保存；T 结构变化、冲突和不确定内容仍需人工确认。'))}</p>
        <p class="note">${esc(T('cognition.settings_auto_confirmation_history', '自动保存也会留下处理依据、来源和版本；可在认知生长的“已处理”查看，再到认知详情修改、暂停或撤回。'))}</p>
        ${known && !supported ? `<p class="note" role="status">${esc(T('cognition.settings_auto_confirmation_unavailable', '当前运行版本尚不支持自动确认；请保持逐条确认。'))}</p>` : ''}
        <p class="note">${esc(flowNote)}</p>`,
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
    const button = (key, fallback, act, index, disabled = blocked) => window.uiButton({
      label: T(key, fallback), size: 'sm', disabled,
      attrs: { 'data-act': act, ...(index === undefined ? {} : { 'data-index': String(index) }) },
    });
    const rows = models.map((item, index) => {
      const role = index === 0 ? T('cognition.settings_nightly_model_first', '首选模型')
        : T('cognition.settings_nightly_model_backup', '备用 {number}', { number: String(index) });
      const action = (key, fallback, icon, act, disabled = blocked) => window.uiIconButton({ icon, label: `${T(key, fallback)} · ${modelIdentity(item).title}`, size: 'sm', disabled,
        attrs: { 'data-act': act, 'data-index': String(index) } });
      const sortable = selected.length > 1 && !blocked;
      const leading = selected.length > 1 ? window.uiIconButton({ icon: 'grip-vertical', size: 'sm', className: 'ca-model-sort-handle', disabled: blocked,
        label: T('cognition.settings_nightly_model_drag_label', '拖动或按上下键调整 {model} 顺序', { model: modelIdentity(item).title }),
        attrs: { 'data-model-sort-handle': '', 'data-model-key': keyOf(item), 'data-index': String(index) } }) : '';
      const actions = selected.length ? `<div class="actions">${action('cognition.settings_nightly_model_remove', '移除', 'x', 'nightly-model-remove')}</div>` : '';
      return `<li data-model-sort-index="${index}"${sortable ? ' draggable="true"' : ''}>${modelCard({ ...modelIdentity(item), label: item.label, note: modelNote(item),
        status: window.uiStatusPill({ label: role, tone: 'neutral' }), actions, leading })}</li>`;
    }).join('');
    const state = catalog.status === 'error' ? T('cognition.settings_nightly_model_error', '模型列表读取失败，已保存的顺序保持不变。')
      : catalog.status !== 'ready' ? T('cognition.settings_nightly_model_loading', '正在读取系统模型列表…')
      : !models.length ? T(NS.store.captureModel?.channel === 'cli' ? 'cognition.settings_nightly_model_system_cli'
        : NS.store.captureModel?.apiConfigured ? 'cognition.settings_nightly_model_environment' : 'cognition.settings_nightly_model_empty',
        NS.store.captureModel?.channel === 'cli' ? '未配置系统模型，将使用可用的本地助手；具体模型由本地助手决定。'
          : NS.store.captureModel?.apiConfigured ? '未配置系统模型，将使用环境变量配置的模型。' : '系统中没有可选模型。') : '';
    const addLabel = T('cognition.settings_nightly_model_add_row', '添加模型');
    const add = window.uiButton({ label: addLabel, icon: 'plus', size: 'sm',
      disabled: blocked || catalog.status !== 'ready' || !catalog.models.length || models.length >= 32,
      attrs: { 'data-act': 'nightly-model-add', 'aria-haspopup': 'dialog' } });
    return `<section class="ca-nightly-model-controls"${saving ? ' aria-busy="true"' : ''}>
      <div class="ca-advanced-section-head"><div class="ca-advanced-heading"><span class="ca-advanced-icon" aria-hidden="true">${window.uiIconHtml('cpu')}</span><div><h4>${esc(T('cognition.settings_nightly_model_title', '夜间发现模型'))}</h4><p class="note">${esc(T(selected.length ? 'cognition.settings_nightly_model_custom' : 'cognition.settings_nightly_model_system', selected.length ? '使用夜间专用顺序' : '跟随系统首个模型'))}</p></div></div><p class="note ca-model-order-hint">${esc(T('cognition.settings_nightly_model_hint', '按列表顺序调用，前一个模型重试后仍不可用时尝试下一个。'))}</p></div>
      ${rows ? `<ol class="ca-nightly-model-list">${rows}</ol>` : ''}
      <div class="ca-model-footer"><div class="actions">${add}${catalog.status === 'error' ? button('cognition.settings_nightly_model_retry', '重试读取', 'nightly-model-retry', undefined, saving) : ''}</div>${selected.length ? button('cognition.settings_nightly_model_reset', '恢复跟随系统', 'nightly-model-reset') : ''}</div>
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

  function windowControls() {
    const { T, esc } = NS;
    const settings = NS.store.captureSettings || {};
    const windowState = NS.store.captureStats?.window || {};
    const known = !NS.store.captureModelError && !!NS.store.captureSettings;
    const disabled = windowSaving || !known;
    const start = windowDraft?.start ?? settings.nightlyStart ?? (known ? '02:00' : '');
    const end = windowDraft?.end ?? settings.nightlyEnd ?? (known ? '06:00' : '');
    const stateLabels = {
      running: T('cognition.settings_window_state_running', '运行中'),
      scheduled: T('cognition.settings_window_state_scheduled', '等待运行'),
      completed: T('cognition.settings_window_state_completed', '上次运行已完成'),
      stopped: T('cognition.settings_window_state_stopped', '上次运行已停止'),
      partial: T('cognition.settings_discovery_partial', '部分完成'),
      failure_held: T('cognition.settings_window_state_failure', '模型异常，运行暂停'),
      missed: T('cognition.settings_window_state_missed', '上次窗口未运行'),
      error: T('cognition.settings_window_state_error', '上次运行有失败'),
      unknown: T('cognition.settings_window_state_unknown', '状态未知'),
    };
    const stateLabel = known ? stateLabels[windowState.state] || stateLabels.unknown : stateLabels.unknown;
    const tone = windowState.state === 'completed' ? 'success'
      : ['running', 'failure_held', 'missed', 'partial', 'error'].includes(windowState.state) ? 'attention' : 'neutral';
    const next = windowState.nextRunAt ? new Date(windowState.nextRunAt) : null;
    const nextText = windowState.withinWindow
      ? T('cognition.settings_window_due', '本次窗口内，可立即扫描。')
      : next && !Number.isNaN(next.getTime())
        ? T('cognition.settings_window_next', '下次自动运行：{time}', { time: next.toLocaleString() })
        : T('cognition.settings_window_next_unknown', '下次运行时间待核对。');
    const field = (labelKey, fallback, name, value) => `<label class="ca-window-field"><span>${esc(T(labelKey, fallback))}</span>${window.uiInput({
      id: `ca-window-${name}`, type: 'time', value, disabled, invalid: windowInvalid,
      ...(windowError ? { describedBy: 'ca-window-error' } : {}),
      attrs: { 'data-window-field': name, 'aria-label': T(labelKey, fallback) },
    })}</label>`;
    return `<section class="ca-advanced-window" data-advanced-window>
      <div class="ca-advanced-window-head"><div class="ca-advanced-heading"><span class="ca-advanced-icon" aria-hidden="true">${window.uiIconHtml('clock')}</span><h4>${esc(T('cognition.settings_window_title', '每日运行窗口'))}</h4></div><div class="ca-window-head-meta"><p class="note">${esc(T('cognition.settings_window_timezone', '当前时区：{zone}；跟随系统。', {
        zone: timezoneLabel() || T('cognition.settings_window_timezone_unknown', '系统时区'),
      }))}</p>${known && windowState.state === 'completed' ? '' : window.uiStatusPill({ label: stateLabel, tone: known ? tone : 'neutral' })}</div></div>
      <p class="note">${esc(T('cognition.settings_window_hint', '窗口内启动；应用需运行；错过不补扫；中断的范围下一窗口续接。'))}</p>
      <div class="ca-window-fields">${field('cognition.settings_window_start', '开始时间', 'start', start)}${field('cognition.settings_window_end', '结束时间', 'end', end)}</div>
      <p class="note" id="ca-window-error" role="alert" data-window-error ${windowError ? '' : 'hidden'}>${esc(windowError)}</p>
      <div class="ca-window-footer"><p class="note">${esc(known ? nextText : T('cognition.settings_window_next_unknown', '下次运行时间待核对。'))}</p><div class="actions ca-window-actions">${window.uiButton({
        label: T('cognition.settings_window_reset', '恢复默认'), size: 'sm', disabled,
        attrs: { 'data-act': 'nightly-window-reset' },
      })}${window.uiButton({
        label: windowSaving ? T('cognition.settings_window_saving', '保存中…') : T('cognition.settings_window_save', '保存'),
        role: 'primary', size: 'sm', disabled, attrs: { 'data-act': 'nightly-window-save' },
      })}</div></div>
    </section>`;
  }

  function advancedControls() {
    const { T, esc } = NS;
    return `<section class="ca-advanced-card" data-settings-disclosure="advanced">
      <details class="settings-model-form__advanced">
        <summary><span>${esc(T('cognition.settings_advanced_features', '高级功能'))}</span><span class="note ca-model-fold-meta">${esc(T('cognition.settings_advanced_meta', '模型顺序与每日运行窗口'))}</span></summary>
        <div class="ca-setting-body ca-advanced-body">${modelControls()}${windowControls()}</div>
      </details>
    </section>`;
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
    const container = root || el?.closest?.('.ca-advanced-card') || (typeof document !== 'undefined' ? document : null);
    const read = name => container?.querySelector?.(`[data-window-field="${name}"]`)?.value ?? windowDraft?.[name];
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
    windowDraft = { ...(windowDraft || {}), [field]: String(event.target.value || '') };
    windowError = '';
    windowInvalid = false;
    const group = event.target.closest?.('[data-advanced-window]');
    group?.querySelectorAll?.('[data-window-field]')?.forEach(input => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); });
    const node = group?.querySelector?.('[data-window-error]');
    if (node) { node.textContent = ''; node.hidden = true; }
  }

  NS.assetSettings = { discoveryStatus, captureDisclosures, restoreDisclosures, loadModels, modelControls, modelAction,
    modelDragStart, modelDragOver, modelDrop, clearModelDrag, modelSortKeydown,
    supportsAutoApproval, autoApprovalControls, toggleAutoApproval, settingCard, advancedControls, windowControls, windowAction, windowInput };
})();
