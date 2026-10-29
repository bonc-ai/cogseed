// 对话内资产审批卡片：AI 提出的实质变化由用户决定保存、稍后处理或拒绝。
// 提议不是锁；尚未决定时，资产仍按当前状态使用。
(function initChatAssetApproval(root) {
  'use strict';

  const log = typeof root.createLogger === 'function'
    ? root.createLogger('chat-asset-approval')
    : { warn() {} };

  // 超过这个长度的值先折叠：资产正文动辄上千字，整段铺在对话里没法看。
  const CLAMP_CHARS = 160;
  let anonymousSeq = 0;
  const STATES = new Set(['pending', 'deferred', 'confirmed', 'rejected', 'superseded']);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

  function canConfirm(payload, view) {
    if (view?.readState !== 'ready' || view.state !== 'pending' || !object(view.proposed)) return false;
    const keys = [...new Set([...(Array.isArray(payload.diff?.fields) ? payload.diff.fields : []), ...Object.keys(view.proposed)])];
    return keys.length > 0 && keys.every(key => Object.hasOwn(FIELD_LABELS, key) && Object.hasOwn(view.proposed, key)
      && (typeof view.proposed[key] === 'string' || (Array.isArray(view.proposed[key]) && view.proposed[key].every(item => typeof item === 'string'))));
  }

  // 字段与 main 的 SUBSTANTIAL_FIELDS 白名单一致；标题修改不走实质内容审批。
  const FIELD_LABELS = {
    statement: ['cognition.asset_version_diff_statement', '正文'],
    title: ['cognition.asset_version_diff_title_field', '标题'],
    value: ['cognition.detail_future_use', '用途'],
    scope: ['cognition.asset_version_diff_scope', '适用范围'],
    applicableWhen: ['cognition.asset_edit_field_applicable', '适用场景'],
    forbiddenWhen: ['cognition.asset_edit_field_forbidden', '禁用场景'],
    tags: ['cognition.asset_edit_field_tags', '标签'],
  };

  const STATE_META = {
    pending: ['recall.asset_approval.tag_pending', '待你定', 'attention'],
    confirmed: ['recall.asset_approval.tag_confirmed', '已确认', 'success'],
    deferred: ['recall.asset_approval.tag_deferred', '已稍后处理', 'idle'],
    rejected: ['recall.asset_approval.tag_rejected', '已拒绝', 'neutral'],
    superseded: ['recall.asset_approval.tag_superseded', '已作废', 'neutral'],
  };

  /** 取词：拿不到译文就用代码里的中文兜底；兜底也要补变量——
   *  否则一句「已按你确认的内容生效（v{n}）」会把花括号直接摆到用户眼前。 */
  function tr(key, fallback, vars) {
    let value = fallback;
    try {
      const translated = root.t(key, vars || {});
      if (translated && translated !== key) value = translated;
    } catch (_) {
      // 词条缺失/取词器不可用：用兜底，不改行为。
    }
    return Object.entries(vars || {}).reduce(
      (acc, [name, replacement]) => acc.split(`{${name}}`).join(String(replacement)),
      value,
    );
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fieldLabel(key) {
    const entry = FIELD_LABELS[key];
    return entry ? tr(entry[0], entry[1]) : String(key);
  }

  function valueToText(value) {
    return Array.isArray(value) ? value.join('\n') : String(value == null ? '' : value);
  }

  /** 数组字段按行/顿号/分号切回数组：用户怎么分都行，别逼他用某一种分隔符。 */
  function textToValue(original, text) {
    if (!Array.isArray(original)) return String(text == null ? '' : text);
    return String(text || '').split(/[\n、；;]+/).map((part) => part.trim()).filter(Boolean);
  }

  /** 读取 chip 隐藏值：新格式是 JSON 数组，旧卡片/textarea 仍按分隔符切分。 */
  function readChipValues(control) {
    if (!control) return [];
    if (control.getAttribute?.('data-asset-approval-encoding') === 'json') {
      try {
        const parsed = JSON.parse(String(control.value || '[]'));
        if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string');
      } catch (_) { /* fall through to the legacy separator split */ }
    }
    return textToValue([], control.value);
  }

  /** 可编辑字段只接受字符串与字符串数组。 */
  function editableKeysOf(payload) {
    return Object.keys(payload || {}).filter((key) => {
      const value = payload[key];
      return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
    });
  }

  /** 数组值 = 短值。不在渲染层维护第二份字段白名单：值类型本身就是分密度的依据。 */
  function isCompactValue(value) {
    return Array.isArray(value);
  }

  /** chip 增删的纯函数：不修改入参，返回新数组。 */
  function applyChipEdit(values, edit, options) {
    const list = Array.isArray(values) ? values.slice() : [];
    const action = edit || {};
    if (action.kind === 'remove') {
      const index = Number(action.index);
      if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
      list.splice(index, 1);
      return list;
    }
    if (action.kind === 'add') {
      const insensitive = !options || options.caseInsensitive !== false;
      const seen = new Set(list.map((item) => (insensitive ? item.toLocaleLowerCase() : item)));
      for (const item of textToValue([], action.text)) {
        const key = insensitive ? item.toLocaleLowerCase() : item;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(item);
      }
    }
    return list;
  }

  function stateIndicator(state) {
    const meta = STATE_META[state] || STATE_META.pending;
    return root.uiStatusDot({ label: tr(meta[0], meta[1]), tone: meta[2] });
  }

  function formatWhen(iso) {
    const ms = Date.parse(String(iso || ''));
    if (!Number.isFinite(ms)) return '';
    const value = new Date(ms);
    const pad = number => String(number).padStart(2, '0');
    return `${value.getFullYear()}/${pad(value.getMonth() + 1)}/${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }

  function chipItemsHtml(key, values, removable) {
    return (Array.isArray(values) ? values : []).map((value, index) => {
      const remove = removable ? root.uiIconButton({
        label: tr('recall.asset_approval.chip_remove', '移除：{value}', { value }),
        icon: 'x',
        size: 'sm',
        className: 'chat-asset-approval-chip-remove',
        attrs: {
          'data-asset-approval-chip-remove': key,
          'data-asset-approval-chip-index': String(index),
        },
      }) : '';
      return `<span class="chat-asset-approval-chip">${root.uiTag({ label: value, variant: 'outline' })}${remove}</span>`;
    }).join('');
  }

  function emptyChipHtml() {
    return '<span class="chat-asset-approval-chip-empty">—</span>';
  }

  /** 长文本块：超长才给「展开全部」，短文本直出——别给用户一个没用的按钮。 */
  function clampedBlock(slot, className, text) {
    const body = String(text == null ? '' : text);
    if (body.length <= CLAMP_CHARS) return `<div class="${className}">${escapeText(body)}</div>`;
    return [
      `<div class="${className} is-clamped" data-asset-approval-clamp="${escapeText(slot)}">${escapeText(body)}</div>`,
      `<div class="chat-asset-approval-toggle">${root.uiButton({
        label: tr('recall.asset_approval.expand', '展开全部'),
        role: 'ghost',
        size: 'sm',
        className: 'chat-asset-approval-toggle-btn',
        attrs: { 'data-asset-approval-toggle': slot },
      })}</div>`,
    ].join('');
  }

  function clampSlot(uid, key, which) {
    return `${uid}:${key}:${which}`;
  }

  /** 短值字段：一行「当前 + 拟生效 chip」，chip 可删，入口回车可加。 */
  function compactFieldHtml(uid, key, view, editableKeys) {
    const proposed = view.proposed;
    const current = view.current;
    const next = proposed ? proposed[key] : undefined;
    const prev = current ? current[key] : undefined;
    const canEdit = editableKeys.includes(key);
    const values = Array.isArray(next) ? next : [];
    const prevText = Array.isArray(prev) ? (prev.join('、') || '—') : (String(prev == null ? '' : prev) || '—');
    const editTag = canEdit
      ? root.uiTag({
        label: tr('recall.asset_approval.editable_hint', '可改'),
        variant: 'outline',
        className: 'chat-asset-approval-edit-tag',
      })
      : '';
    const prevBlock = (view.pending && current)
      ? `<span class="chat-asset-approval-prev-inline"><span class="chat-asset-approval-prev-label">${escapeText(tr('recall.asset_approval.current_label', '当前'))}</span>${escapeText(prevText)}</span>`
      : '';
    const chips = canEdit
      ? [
        `<span class="chat-asset-approval-chip-list" data-asset-approval-chip-list="${escapeText(key)}">${chipItemsHtml(key, values, true) || emptyChipHtml()}</span>`,
        root.uiInput({
          id: `chat-asset-approval-${uid}-${key}-entry`,
          type: 'text',
          className: 'chat-asset-approval-chip-input',
          placeholder: tr('recall.asset_approval.chip_placeholder', '输入后回车添加'),
          attrs: {
            'data-asset-approval-chip-entry': key,
            'aria-label': tr('recall.asset_approval.chip_entry', '添加{field}', { field: fieldLabel(key) }),
          },
        }),
        root.uiButton({
          label: tr('recall.asset_approval.chip_add', '添加'),
          role: 'ghost',
          size: 'sm',
          className: 'chat-asset-approval-chip-add',
          attrs: { 'data-asset-approval-chip-add': key },
        }),
        // canonical value：collectEdits 按 data-asset-approval-field 读 .value。
        // 数组用 JSON 编码，避免标签名里的「、；;」被当成多项分隔符。
        root.uiInput({
          id: `chat-asset-approval-${uid}-${key}`,
          type: 'hidden',
          value: JSON.stringify(values),
          attrs: {
            'data-asset-approval-field': key,
            'data-asset-approval-encoding': 'json',
            'aria-label': fieldLabel(key),
          },
        }),
      ].join('')
      : `<span class="chat-asset-approval-chip-list">${chipItemsHtml(key, values, false) || emptyChipHtml()}</span>`;
    return `<div class="chat-asset-approval-row chat-asset-approval-compact" data-asset-approval-row="${escapeText(key)}"><div class="chat-asset-approval-row-head"><span class="chat-asset-approval-label">${escapeText(fieldLabel(key))}</span>${editTag}${prevBlock}</div><div class="chat-asset-approval-chips">${chips}</div></div>`;
  }

  /** 长值字段：保留「当前」折叠块 + 可编辑全文。 */
  function longFieldHtml(uid, key, view, editableKeys) {
    const proposed = view.proposed;
    const current = view.current;
    const next = proposed ? proposed[key] : undefined;
    const prev = current ? current[key] : undefined;
    const canEdit = editableKeys.includes(key);
    let control;
    if (canEdit) {
      control = root.uiTextarea({
        id: `chat-asset-approval-${uid}-${key}`,
        className: 'chat-asset-approval-input',
        value: valueToText(next),
        attrs: {
          rows: key === 'statement' ? '6' : '3',
          'data-asset-approval-field': key,
          'aria-label': fieldLabel(key),
        },
      });
    } else if (proposed) {
      control = clampedBlock(clampSlot(uid, key, 'next'), 'chat-asset-approval-value', valueToText(next));
    } else {
      control = '';
    }
    // 「当前」只在**待决定**时给：用户要比的是"改成什么"与"原来是什么"；
    // 已经处置完的卡片再摆一份旧值只是噪音。
    const prevBlock = (view.pending && current)
      ? `<div class="chat-asset-approval-prev"><span class="chat-asset-approval-prev-label">${escapeText(tr('recall.asset_approval.current_label', '当前'))}</span>${clampedBlock(clampSlot(uid, key, 'prev'), 'chat-asset-approval-prev-text', valueToText(prev) || '—')}</div>`
      : '';
    const editTag = canEdit
      ? root.uiTag({
        label: tr('recall.asset_approval.editable_hint', '可改'),
        variant: 'outline',
        className: 'chat-asset-approval-edit-tag',
      })
      : '';
    return `<div class="chat-asset-approval-row" data-asset-approval-row="${escapeText(key)}"><div class="chat-asset-approval-row-head"><span class="chat-asset-approval-label">${escapeText(fieldLabel(key))}</span>${editTag}</div>${prevBlock}${control}</div>`;
  }

  function fieldRowHtml(uid, key, view, editableKeys) {
    const next = view.proposed ? view.proposed[key] : undefined;
    const prev = view.current ? view.current[key] : undefined;
    return isCompactValue(next) || isCompactValue(prev)
      ? compactFieldHtml(uid, key, view, editableKeys)
      : longFieldHtml(uid, key, view, editableKeys);
  }

  /** 头部：资产名是主角，状态点在前，版本/时间靠右。 */
  function headHtml(source, state, view, options) {
    const title = String(source.assetTitle || source.assetId || '');
    const baseline = String(source.baselineVersion || '').trim();
    const time = options && options.time;
    const meta = time
      ? `<time class="chat-asset-approval-time" datetime="${escapeText(time)}">${escapeText(formatWhen(time))}</time>`
      : (baseline ? `<span class="chat-asset-approval-baseline">${escapeText(tr('recall.asset_approval.baseline', '基于 v{v}', { v: baseline }))}</span>` : '');
    return `<div class="chat-asset-approval-head">${stateIndicator(state)}<span class="chat-asset-approval-title" title="${escapeText(title)}">${escapeText(title)}</span><span class="chat-asset-approval-meta">${meta}</span></div>`;
  }

  /** 依据：默认一行摘要，展开看全文。 */
  function basisHtml(reason) {
    const text = String(reason || '');
    if (!text) return '';
    const summary = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    return `<details class="chat-asset-approval-basis"><summary class="chat-asset-approval-basis-summary"><span class="chat-asset-approval-reason-label">${escapeText(tr('recall.asset_approval.reason_label', '依据'))}</span><span class="chat-asset-approval-basis-text">${escapeText(summary)}</span></summary><div class="chat-asset-approval-basis-body">${escapeText(text)}</div></details>`;
  }

  /** 摘要只在拿不到字段值时才摆：有 proposed 时字段区已经是"改成什么"。 */
  function diffHtml(source, proposed) {
    if (proposed) return '';
    const diff = source.diff || {};
    return `<div class="chat-asset-approval-diff"><span class="chat-asset-approval-diff-label">${escapeText(tr('recall.asset_approval.diff_label', '变更前后'))}</span>${escapeText(String(diff.before || '—'))} → ${escapeText(String(diff.after || '—'))}</div>`;
  }

  function actionsHtml(source, view) {
    return `<div class="chat-asset-approval-actions">
      ${root.uiButton({ label: tr('recall.asset_approval.confirm', '保存更新'), role: 'primary', size: 'sm', disabled: !canConfirm(source, view), attrs: { 'data-asset-approval-action': 'confirm' } })}
      ${root.uiButton({ label: tr('recall.asset_approval.defer', '稍后处理'), size: 'sm', attrs: { 'data-asset-approval-action': 'defer' } })}
      ${root.uiButton({ label: tr('recall.asset_approval.reject', '拒绝'), size: 'sm', attrs: { 'data-asset-approval-action': 'reject' } })}
    </div>`;
  }

  function skeletonHtml(source, view) {
    return `${headHtml(source, 'pending', view)}<div class="chat-asset-approval-skeleton">${root.uiSkeleton({
      ariaLabel: tr('recall.asset_approval.read_loading', '正在核对完整提议，读取完成后才能确认。'),
      lines: [64, 92],
    })}</div>${actionsHtml(source, view)}`;
  }

  function readFailedHtml(source, view) {
    return `${headHtml(source, 'pending', view)}<div class="chat-asset-approval-read-failed" role="status">${escapeText(tr('recall.asset_approval.read_failed', '完整内容尚未读取，不能确认。请重试。'))}</div>${root.uiButton({ label: tr('common.retry', '重试'), size: 'sm', attrs: { 'data-asset-approval-retry': '1' } })}${diffHtml(source, null)}${basisHtml(source.reason)}${actionsHtml(source, view)}`;
  }

  function pendingHtml(source, view) {
    const uid = String(source.proposalId || `anonymous-${++anonymousSeq}`).replace(/[^A-Za-z0-9_-]/g, '')
      || `anonymous-${++anonymousSeq}`;
    const proposed = object(view.proposed) ? view.proposed : null;
    const current = object(view.current) ? view.current : null;
    const editableKeys = proposed ? editableKeysOf(proposed) : [];
    const keys = Array.isArray(source.diff?.fields) ? source.diff.fields : [];
    const fields = keys.map(key => fieldRowHtml(uid, key, { proposed, current, pending: true }, editableKeys)).join('');
    const compactOnly = proposed && keys.length > 0 && keys.every(key => isCompactValue(proposed[key]));
    const fieldsBlock = fields
      ? `<div class="chat-asset-approval-fields${compactOnly ? ' is-compact' : ''}">${fields}</div>`
      : '';
    return `${headHtml(source, 'pending', view)}${fieldsBlock}${diffHtml(source, proposed)}${basisHtml(source.reason)}${actionsHtml(source, view)}`;
  }

  /** 已处置：收起时一行，展开能看正文、结果和依据。正文始终同步渲染在 DOM 里。 */
  function disposedHtml(source, view) {
    const state = String(view.state || 'pending');
    const uid = String(source.proposalId || 'anonymous').replace(/[^A-Za-z0-9_-]/g, '') || 'anonymous';
    const proposed = object(view.proposed) ? view.proposed : null;
    const keys = Array.isArray(source.diff?.fields) ? source.diff.fields : [];
    const facts = proposed ? keys.map((key) => {
      const value = proposed[key];
      if (Array.isArray(value)) {
        const chips = chipItemsHtml(key, value, false) || emptyChipHtml();
        return `<div class="chat-asset-approval-fact"><span class="chat-asset-approval-label">${escapeText(fieldLabel(key))}</span><span class="chat-asset-approval-chip-list">${chips}</span></div>`;
      }
      return `<div class="chat-asset-approval-fact"><span class="chat-asset-approval-label">${escapeText(fieldLabel(key))}</span>${clampedBlock(clampSlot(uid, key, 'next'), 'chat-asset-approval-value', valueToText(value))}</div>`;
    }).join('') : '';
    const meta = view.decidedAt
      ? `<time class="chat-asset-approval-time" datetime="${escapeText(view.decidedAt)}">${escapeText(formatWhen(view.decidedAt))}</time>`
      : '';
    const caret = root.uiIconHtml ? root.uiIconHtml('chevron-right', '') : '';
    return `<details class="chat-asset-approval-disposed"><summary class="chat-asset-approval-summary">${stateIndicator(state)}<span class="chat-asset-approval-title">${escapeText(String(source.assetTitle || source.assetId || ''))}</span><span class="chat-asset-approval-meta">${meta}<span class="chat-asset-approval-caret">${caret}</span></span></summary><div class="chat-asset-approval-body"><div class="chat-asset-approval-state">${escapeText(stateText(state, view))}</div>${diffHtml(source, proposed)}${facts}${basisHtml(source.reason)}</div></details>`;
  }

  /** 使用共享组件构造卡片 HTML。 */
  function cardHtml(payload, view) {
    const source = payload || {};
    const safeView = view || {};
    const state = String(safeView.state || 'pending');
    if (state !== 'pending') return disposedHtml(source, safeView);
    if (safeView.readState === 'loading' && !object(safeView.proposed)) return skeletonHtml(source, safeView);
    if (safeView.readFailed) return readFailedHtml(source, safeView);
    return pendingHtml(source, safeView);
  }

  function stateText(state, view) {
    if (state === 'confirmed') {
      return view.appliedVersion
        ? tr('recall.asset_approval.applied_version', '已按你保存的内容生效（v{n}）', { n: String(view.appliedVersion) })
        : tr('recall.asset_approval.state_confirmed', '已保存更新');
    }
    if (state === 'deferred') return tr('recall.asset_approval.state_deferred', '已稍后处理（在待确认清单里）');
    if (state === 'rejected') return tr('recall.asset_approval.state_rejected', '已拒绝');
    if (state === 'superseded') return tr('recall.asset_approval.state_superseded', '基于的版本已过期，这条提议已作废；AI 会基于最新内容重新提议');
    return '';
  }

  function bindClampToggles(card) {
    for (const toggle of card.querySelectorAll('[data-asset-approval-toggle]')) {
      toggle.addEventListener('click', () => {
        const slot = String(toggle.dataset.assetApprovalToggle || '');
        const block = card.querySelector(`[data-asset-approval-clamp="${slot}"]`);
        if (!block) return;
        const collapsed = block.classList.contains('is-clamped');
        block.classList.toggle('is-clamped', !collapsed);
        const label = toggle.querySelector('.ui-button__label');
        if (label) {
          label.textContent = collapsed
            ? tr('recall.asset_approval.collapse', '收起')
            : tr('recall.asset_approval.expand', '展开全部');
        }
      });
    }
  }

  function updateChipField(card, key, values) {
    const hidden = card.querySelector(`[data-asset-approval-field="${cssEscape(key)}"]`);
    if (hidden) hidden.value = JSON.stringify(values);
    const list = card.querySelector(`[data-asset-approval-chip-list="${cssEscape(key)}"]`);
    if (list) list.innerHTML = chipItemsHtml(key, values, true) || emptyChipHtml();
    card._assetApprovalDirty = true;
  }

  function commitChipEntry(card, key, entry) {
    if (!key) return;
    const hidden = card.querySelector(`[data-asset-approval-field="${cssEscape(key)}"]`);
    const current = readChipValues(hidden);
    const next = applyChipEdit(current, { kind: 'add', text: entry ? entry.value : '' }, { caseInsensitive: key === 'tags' });
    updateChipField(card, key, next);
    if (entry) entry.value = '';
  }

  /** chip 交互用根节点委托：卡片重渲染后不会重复绑定，fakeCard 没有 addEventListener 时安静跳过。 */
  function bindChipEditors(card) {
    if (!card || card._assetApprovalChipBound || typeof card.addEventListener !== 'function') return;
    card._assetApprovalChipBound = true;
    card.addEventListener('click', (event) => {
      const target = event.target;
      const remove = target?.closest?.('[data-asset-approval-chip-remove]');
      if (remove) {
        const key = String(remove.getAttribute('data-asset-approval-chip-remove') || '');
        const index = Number(remove.getAttribute('data-asset-approval-chip-index'));
        const hidden = card.querySelector(`[data-asset-approval-field="${cssEscape(key)}"]`);
        const current = readChipValues(hidden);
        updateChipField(card, key, applyChipEdit(current, { kind: 'remove', index }, { caseInsensitive: key === 'tags' }));
        return;
      }
      const add = target?.closest?.('[data-asset-approval-chip-add]');
      if (add) {
        const key = String(add.getAttribute('data-asset-approval-chip-add') || '');
        commitChipEntry(card, key, card.querySelector(`[data-asset-approval-chip-entry="${cssEscape(key)}"]`));
      }
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      const entry = event.target?.closest?.('[data-asset-approval-chip-entry]');
      if (!entry) return;
      event.preventDefault?.();
      commitChipEntry(card, String(entry.getAttribute('data-asset-approval-chip-entry') || ''), entry);
    });
  }

  /** 收集用户在卡片上改过的值。按**原值类型**切回数组/字符串：只靠 textarea 里的
   *  文本分不出"适用场景"是数组还是字符串。 */
  function collectEdits(payload, controls) {
    const proposed = (payload && typeof payload === 'object') ? payload : {};
    const edited = {};
    for (const control of (controls || [])) {
      const key = String((control.dataset && control.dataset.assetApprovalField) || '');
      if (!key) continue;
      edited[key] = control.getAttribute?.('data-asset-approval-encoding') === 'json'
        ? readChipValues(control)
        : textToValue(proposed[key], control.value);
    }
    return edited;
  }

  function render(card, payload, view) {
    if (!card || !payload) return;
    const state = String((view && view.state) || 'pending');
    card.dataset.status = state;
    card.dataset.readState = view?.readState || 'loading';
    card.className = `chat-asset-approval is-${state}`;
    card.dataset.proposalId = String(payload.proposalId || '');
    // 挂在元素上：确认时要把 textarea 的文本按原值类型切回数组/字符串。
    card._assetApprovalProposed = (view && view.proposed && typeof view.proposed === 'object') ? view.proposed : null;
    card._assetApprovalView = view || {};
    card._assetApprovalPayload = payload;
    card.innerHTML = cardHtml(payload, view);
    for (const button of card.querySelectorAll('[data-asset-approval-action]')) {
      button.addEventListener('click', () => { void resolve(card, payload, button.dataset.assetApprovalAction); });
    }
    card.querySelector('[data-asset-approval-retry]')?.addEventListener('click', () => { void readCard(card, payload); });
    for (const control of card.querySelectorAll('[data-asset-approval-field]')) {
      control.addEventListener?.('input', () => { card._assetApprovalDirty = true; });
    }
    bindClampToggles(card);
    bindChipEditors(card);
  }

  /** 兼容全局和 window 上的 uiAlert。提示不可用或执行失败时记录警告，
   *  不让提示本身的异常再次打断处置流程。 */
  function alertUser(message) {
    const body = String(message == null ? '' : message);
    let fn = null;
    if (typeof uiAlert === 'function') fn = uiAlert;
    else if (typeof root.uiAlert === 'function') fn = root.uiAlert;
    if (!fn) {
      log.warn('uiAlert unavailable; user-facing message dropped', { message: body });
      return Promise.resolve();
    }
    try {
      return Promise.resolve(fn(body)).catch((error) => {
        log.warn('uiAlert threw; user-facing message dropped', {
          message: body,
          error: (error && error.message) || String(error),
        });
      });
    } catch (error) {
      log.warn('uiAlert threw; user-facing message dropped', {
        message: body,
        error: (error && error.message) || String(error),
      });
      return Promise.resolve();
    }
  }

  function defaultPort() {
    return {
      invoke: (channel, body) => root.cogseed.invoke(channel, body),
      alert: alertUser,
    };
  }

  async function resolve(card, payload, action, port) {
    if (!card || card.dataset.busy === '1') return;
    if (!['confirm', 'defer', 'reject'].includes(action)) return;
    if (action === 'confirm' && !canConfirm(payload, card._assetApprovalView)) return;
    const io = port || defaultPort();
    card.dataset.busy = '1';
    card.classList.add('is-busy');
    card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      const body = { proposalId: String(payload.proposalId || ''), decision: String(action || '') };
      if (action === 'confirm') {
        const edited = collectEdits(
          card._assetApprovalProposed || {},
          card.querySelectorAll('[data-asset-approval-field]'),
        );
        if (Object.keys(edited).length) body.payload = edited;
      }
      const result = await io.invoke('recall.assets.approval.decide', body);
      if (!result || !result.ok) {
        // 版本重检不一致（冲突即作废重提）：主进程已把提议置为
        // superseded——基线版本永不刷新，confirm 对这条提议永久不可达，卡片
        // 落终态作废，AI 会基于最新内容重新提议（不再让用户「再决定」一条
        // 永远再冲突的死路提议）。
        if (result && result.versionConflict) {
          card.dataset.busy = '';
          card.classList.remove('is-busy');
          card._assetApprovalPendingHydration = null;
          render(card, payload, { ...(card._assetApprovalView || {}), state: String(result.state || 'superseded') });
          await io.alert(tr('recall.asset_approval.version_conflict_superseded',
            '这条资产在你看卡片之后被改过（v{a} → v{b}），这条提议已作废；AI 会基于最新内容重新提议。',
            { a: String(result.versionConflict.baselineVersion || ''), b: String(result.versionConflict.currentVersion || '') }));
          return;
        }
        // 标签在提议后别处被改过：标签不 bump 版本，版本重检看不见它；
        // 主进程的标签 CAS 已把提议作废，这里按同一终态收口并说明原因。
        if (result && result.tagConflict) {
          card.dataset.busy = '';
          card.classList.remove('is-busy');
          card._assetApprovalPendingHydration = null;
          render(card, payload, { ...(card._assetApprovalView || {}), state: String(result.state || 'superseded') });
          await io.alert(tr('recall.asset_approval.tag_conflict_superseded',
            '这条资产的标签在你看卡片之后被改过，这条提议已作废；AI 会基于最新内容重新提议。'));
          return;
        }
        // 按真实终态关闭卡片，保留回执说明，避免把已结束的提议恢复为可操作。
        if (result && result.state && String(result.state) !== 'pending') {
          card.dataset.busy = '';
          card.classList.remove('is-busy');
          card._assetApprovalPendingHydration = null;
          render(card, payload, { ...(card._assetApprovalView || {}), state: String(result.state) });
          const receiptMessage = String(result.message || '');
          await io.alert(receiptMessage
            ? tr('recall.asset_approval.decide_failed', '处置失败：{message}', { message: receiptMessage })
            : tr('recall.asset_approval.already_decided', '这条提议已经处置过了。'));
          return;
        }
        // 这里只抛裸 message（主进程回执的
        // error/message 原文），「处置失败：」前缀由 catch 的 decide_failed
        // 模板统一包一次——旧实现两边各包一层，用户看到双重前缀。
        throw new Error(String((result && (result.error || result.message)) || 'decide failed'));
      }
      card.dataset.busy = '';
      card.classList.remove('is-busy');
      card._assetApprovalPendingHydration = null;
      const state = String(result.state || (action === 'confirm' ? 'confirmed' : action === 'defer' ? 'deferred' : 'rejected'));
      render(card, payload, {
        ...(card._assetApprovalView || {}),
        state,
        decidedAt: new Date().toISOString(),
        ...(result.appliedVersion ? { appliedVersion: result.appliedVersion } : {}),
      });
      void refreshVisible();
    } catch (error) {
      card.dataset.busy = '';
      card.classList.remove('is-busy');
      card.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      const confirm = card.querySelector('[data-asset-approval-action="confirm"]');
      if (confirm) confirm.disabled = !canConfirm(payload, card._assetApprovalView);
      // 处置失败回到 pending 的卡片，若在 busy
      // 窗口内收到过 mount 发出的 hydrate 结果（read 通道真实状态与拟生效
      // 内容），此刻回放——否则卡片停在只有标题、无内容、无提示、按钮可点
      // 的骨架态（守卫丢弃+失败回滚两件事叠加出的空壳卡形态）。
      const pendingHydration = card._assetApprovalPendingHydration;
      card._assetApprovalPendingHydration = null;
      if (pendingHydration && card.dataset.busy !== '1' && card.dataset.status === 'pending') {
        render(card, payload, pendingHydration);
      }
      await io.alert(tr('recall.asset_approval.decide_failed', '处置失败：{message}', { message: (error && error.message) || String(error) }));
    }
  }

  function cssEscape(value) {
    return (root.CSS && typeof root.CSS.escape === 'function')
      ? root.CSS.escape(value)
      : String(value).replace(/["\\]/g, '\\$&');
  }

  function mount(host, payload) {
    if (!host || !payload || !payload.proposalId) return null;
    const selector = `.chat-asset-approval[data-proposal-id="${cssEscape(String(payload.proposalId))}"]`;
    if (host.querySelector(selector)) return host.querySelector(selector);
    const card = root.document.createElement('div');
    host.appendChild(card);
    render(card, payload, { state: 'pending', readState: 'loading' });
    void readCard(card, payload);
    return card;
  }

  async function readCard(card, payload, request) {
    const generation = (card._assetApprovalReadGeneration || 0) + 1;
    card._assetApprovalReadGeneration = generation;
    // 历史重载时卡片消息是静态载荷：查一次真实状态与拟生效内容——不查状态则已处置的
    // 卡片会又变回"待处理"；不查内容则"可编辑"只是一句空话（载荷里只有摘要）。
    try {
      const result = await (request || root.cogseed.invoke('recall.assets.approval.read', { proposalId: payload.proposalId }));
      if (generation !== card._assetApprovalReadGeneration || card.isConnected === false) return;
      const proposal = result && result.proposal ? result.proposal : null;
      if (!proposal || proposal.id !== payload.proposalId || proposal.assetId !== payload.assetId
        || String(proposal.baselineVersion) !== String(payload.baselineVersion) || !STATES.has(proposal.state)
        || !object(proposal.payload)) throw new Error('invalid approval read response');
      const view = { state: proposal.state, readState: 'ready', proposed: proposal.payload,
        ...(object(proposal.beforeValues) ? { current: proposal.beforeValues } : {}),
        ...(proposal.decidedAt ? { decidedAt: proposal.decidedAt } : {}) };
      if (proposal.state === 'pending' && !canConfirm(payload, view)) throw new Error('incomplete approval fields');
      // 正忙或不待处理时不插手，免得把处置中/已处置的卡还原成可点
      // （与 conversation.js 的 kstar 复查卡同一口径）。
      // busy 窗口内到达的 hydrate 结果不丢弃而是
      // 暂存——处置失败回 pending 时回放（见 resolve 的 catch），否则卡片停在
      // 只有标题、无内容、无提示、按钮可点的骨架态；处置成功落终态则暂存随
      // 之作废，终态卡永不回放。已终态（status!=='pending'）的卡无需暂存。
      if (card.dataset.busy === '1' && card.dataset.status === 'pending') {
        card._assetApprovalPendingHydration = view;
        return;
      }
      if (card.dataset.busy === '1' || !['pending', 'deferred'].includes(card.dataset.status)
        || (card.dataset.status === 'deferred' && proposal.state === 'pending')) return;
      // Unrelated collection writes must not overwrite the user's local edits.
      if (proposal.state === 'pending' && card._assetApprovalDirty
        && JSON.stringify(proposal.payload) === JSON.stringify(card._assetApprovalProposed)) return;
      card._assetApprovalDirty = false;
      render(card, payload, view);
    } catch (error) {
      // 这里以前是 `.catch(() => {})`：一旦取内容失败，卡片就停在只有一个标题的骨架上，
      // 而**没有任何地方**留下线索。失败要说出来，界面也要说清楚还能做什么。
      log.warn('asset approval card hydrate failed', {
        proposalId: String(payload.proposalId || ''),
        error: (error && error.message) || String(error),
      });
      if (generation !== card._assetApprovalReadGeneration || card.isConnected === false
        || card.dataset.busy === '1' || card.dataset.status !== 'pending') return;
      render(card, payload, { state: 'pending', readState: 'failed', readFailed: true });
    }
  }

  let refreshRunning = null, refreshRequested = false;
  function refreshVisible() {
    refreshRequested = true;
    if (refreshRunning) return refreshRunning;
    refreshRunning = Promise.resolve().then(async () => {
      do {
        refreshRequested = false;
        const groups = new Map();
        for (const node of root.document?.querySelectorAll?.('[data-proposal-citation], .chat-asset-approval[data-proposal-id]') || []) {
          const id = node.dataset.proposalCitation || node.dataset.proposalId;
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id || '') || node.isConnected === false) continue;
          if (!groups.has(id)) groups.set(id, []);
          groups.get(id).push(node);
        }
        await Promise.all([...groups].map(async ([id, nodes]) => {
          const request = root.cogseed.invoke('recall.assets.approval.read', { proposalId: id });
          const cards = nodes.filter(node => node._assetApprovalPayload);
          const updates = cards.map(node => readCard(node, node._assetApprovalPayload, request));
          try {
            const result = await request;
            const proposal = result?.proposal;
            if (!proposal || proposal.id !== id || !STATES.has(proposal.state)) throw new Error('invalid approval state');
            for (const node of nodes.filter(node => node.dataset.proposalCitation)) {
              if (node.isConnected === false) continue;
              node.dataset.proposalState = proposal.state;
              const label = node.querySelector('.ui-button__label');
              if (label) label.textContent = `${tr('chat.proposal_citation_open', '查看变更提议')} · ${proposal.state === 'pending'
                ? tr('recall.asset_approval.tag_pending', '待你定') : stateText(proposal.state, {})}`;
            }
          } catch (_) {
            for (const node of nodes.filter(node => node.dataset.proposalCitation)) {
              node.dataset.proposalState = 'unavailable';
              const label = node.querySelector('.ui-button__label');
              if (label) label.textContent = tr('chat.proposal_citation_unavailable', '变更提议 · 状态待核对');
            }
          }
          await Promise.all(updates);
        }));
      } while (refreshRequested);
    }).finally(() => { refreshRunning = null; });
    return refreshRunning;
  }
  root.cogseed?.onPushEvent?.('cognition:changed', notice => {
    if (notice?.collection === 'asset-approvals') void refreshVisible();
  });
  root.document?.addEventListener?.('visibilitychange', () => {
    if (root.document.visibilityState !== 'hidden') void refreshVisible();
  });

  const api = {
    mount,
    refreshVisible,
    render,
    resolve,
    cardHtml,
    collectEdits,
    editableKeysOf,
    textToValue,
    valueToText,
    applyChipEdit,
  };
  root.ChatAssetApproval = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
