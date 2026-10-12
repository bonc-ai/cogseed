// 对话内资产审批卡片（specs/008 US-406 / FR-014）：AI 自主提出的实质变化不直接生效，
// 转成这张卡片由用户三选一（保存更新 / 稍后处理 / 拒绝；确认词根统一「保存」系，
// 2026-09-28）。卡片是**提议不是锁**：没决定期间，这条资产照常可用。
//
// 单独成模块的原因：原先这套渲染挂在 conversation.js 里，只能用"源码里有这一行"的
// 断言去测，于是 `uiTextarea` 少传 id（该组件强制要求 id、会抛错）没被任何测试挡住——
// 真机上待处理卡片的可编辑区渲染不出来，异常又被 `.catch(() => {})` 吞掉，界面上只
// 剩一个空标题（2026-09-25 子安复现）。抽出来之后 `cardHtml` / `collectEdits` / `resolve`
// 都能被真实调用：共享组件用错会当场抛错，用户改完回传的载荷也能逐字段断言。
(function initChatAssetApproval(root) {
  'use strict';

  const log = typeof root.createLogger === 'function'
    ? root.createLogger('chat-asset-approval')
    : { warn() {} };

  // 超过这个长度的值先折叠：资产正文动辄上千字，整段铺在对话里没法看。
  const CLAMP_CHARS = 160;
  let anonymousSeq = 0;

  const FIELD_LABELS = {
    statement: ['cognition.asset_version_diff_statement', '正文'],
    title: ['cognition.asset_version_diff_title_field', '标题'],
    scope: ['cognition.asset_version_diff_scope', '适用范围'],
    applicableWhen: ['cognition.asset_edit_field_applicable', '适用场景'],
    forbiddenWhen: ['cognition.asset_edit_field_forbidden', '禁用场景'],
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

  /** 可编辑字段：字符串与字符串数组。（`sensitivity` 枚举字段已随敏感级机制
   *  整体删除，2026-09-28——自由文本改枚举本就没有意义。） */
  function editableKeysOf(payload) {
    return Object.keys(payload || {}).filter((key) => {
      const value = payload[key];
      return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
    });
  }

  function stateTag(state) {
    if (state === 'pending') return root.uiTag({ label: tr('recall.asset_approval.tag_pending', '待你定'), variant: 'accent' });
    if (state === 'confirmed') return root.uiTag({ label: tr('recall.asset_approval.tag_confirmed', '已确认'), variant: 'success' });
    if (state === 'deferred') return root.uiTag({ label: tr('recall.asset_approval.tag_deferred', '已稍后处理'), variant: 'outline' });
    if (state === 'rejected') return root.uiTag({ label: tr('recall.asset_approval.tag_rejected', '已拒绝'), variant: 'outline' });
    return '';
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

  function fieldRowHtml(uid, key, view, editableKeys) {
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

  /** 卡片 HTML。纯字符串构造，所以能被测试逐段断言；共享组件用错（比如 uiTextarea
   *  少给 id）会在这里当场抛错，而不是变成界面上的一块空白。 */
  function cardHtml(payload, view) {
    const source = payload || {};
    const state = String((view && view.state) || 'pending');
    const pending = state === 'pending';
    const diff = source.diff || {};
    // 字段值来自**提议记录**（view.proposed / view.current），不是消息载荷里的摘要：
    // 摘要只有"字数 + 60 字前缀"，用户据此判断不了要不要批（2026-09-25 真机抓出）。
    const proposed = (view && view.proposed && typeof view.proposed === 'object') ? view.proposed : null;
    const current = (view && view.current && typeof view.current === 'object') ? view.current : null;
    const uid = String(source.proposalId || `anonymous-${++anonymousSeq}`).replace(/[^A-Za-z0-9_-]/g, '')
      || `anonymous-${++anonymousSeq}`;
    const editableKeys = (pending && proposed) ? editableKeysOf(proposed) : [];
    const fields = (Array.isArray(diff.fields) ? diff.fields : [])
      .map((key) => fieldRowHtml(uid, key, { proposed, current, pending }, editableKeys))
      .join('');
    const baseline = String(source.baselineVersion || '').trim();
    const actions = pending
      ? `<div class="chat-asset-approval-actions">
        ${root.uiButton({ label: tr('recall.asset_approval.confirm', '保存更新'), role: 'primary', size: 'sm', attrs: { 'data-asset-approval-action': 'confirm' } })}
        ${root.uiButton({ label: tr('recall.asset_approval.defer', '稍后处理'), size: 'sm', attrs: { 'data-asset-approval-action': 'defer' } })}
        ${root.uiButton({ label: tr('recall.asset_approval.reject', '拒绝'), size: 'sm', attrs: { 'data-asset-approval-action': 'reject' } })}
      </div>`
      : `<div class="chat-asset-approval-state">${escapeText(stateText(state, view || {}))}</div>`;
    const readNote = view && view.readFailed
      ? `<div class="chat-asset-approval-read-failed">${escapeText(tr('recall.asset_approval.read_failed', '没能取到拟生效内容（刷新页面可重试；确认仍会按 AI 提议的原内容生效）'))}</div>`
      : '';
    const editHint = pending && editableKeys.length
      ? `<div class="chat-asset-approval-hint">${escapeText(tr('recall.asset_approval.edit_hint', '下面拟生效的内容可以直接改，改完再确认'))}</div>`
      : '';
    // 取不到内容时不留一排空壳字段（只有字段名、没有值，看着像坏了）。
    const fieldsBlock = (fields && !(view && view.readFailed))
      ? `<div class="chat-asset-approval-fields">${editHint}${fields}</div>`
      : '';
    return `
    <div class="chat-asset-approval-head">
      <div class="chat-asset-approval-title">${escapeText(tr('recall.asset_approval.card_title', 'AI 想改这条资产，请你定'))}</div>
      ${stateTag(state)}
    </div>
    <div class="chat-asset-approval-asset"><span class="chat-asset-approval-asset-label">${escapeText(tr('recall.asset_approval.asset_label', '目标资产'))}</span><span class="chat-asset-approval-asset-name">${escapeText(String(source.assetTitle || source.assetId || ''))}</span>${baseline ? `<span class="chat-asset-approval-baseline">${escapeText(tr('recall.asset_approval.baseline', '基于 v{v}', { v: baseline }))}</span>` : ''}</div>
    <div class="chat-asset-approval-diff"><span class="chat-asset-approval-diff-label">${escapeText(tr('recall.asset_approval.diff_label', '变更前后'))}</span>${escapeText(String(diff.before || '—'))} → ${escapeText(String(diff.after || '—'))}</div>
    <div class="chat-asset-approval-reason"><span class="chat-asset-approval-reason-label">${escapeText(tr('recall.asset_approval.reason_label', '依据'))}</span>${escapeText(String(source.reason || ''))}</div>
    ${readNote}
    ${fieldsBlock}
    ${pending ? `<div class="chat-asset-approval-note">${escapeText(tr('recall.asset_approval.pending_note', '卡片是提议不是锁：还没决定期间，这条资产照常可用。'))}</div>` : ''}
    ${actions}`;
  }

  function stateText(state, view) {
    if (state === 'confirmed') {
      return view.appliedVersion
        ? tr('recall.asset_approval.applied_version', '已按你保存的内容生效（v{n}）', { n: String(view.appliedVersion) })
        : tr('recall.asset_approval.state_confirmed', '已保存更新');
    }
    if (state === 'deferred') return tr('recall.asset_approval.state_deferred', '已稍后处理（在待确认清单里）');
    if (state === 'rejected') return tr('recall.asset_approval.state_rejected', '已拒绝');
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

  /** 收集用户在卡片上改过的值。按**原值类型**切回数组/字符串：只靠 textarea 里的
   *  文本分不出"适用场景"是数组还是字符串。 */
  function collectEdits(payload, controls) {
    const proposed = (payload && typeof payload === 'object') ? payload : {};
    const edited = {};
    for (const control of (controls || [])) {
      const key = String((control.dataset && control.dataset.assetApprovalField) || '');
      if (!key) continue;
      edited[key] = textToValue(proposed[key], control.value);
    }
    return edited;
  }

  function render(card, payload, view) {
    if (!card || !payload) return;
    const state = String((view && view.state) || 'pending');
    card.dataset.status = state;
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
    bindClampToggles(card);
  }

  /** 弹提示。uiAlert 是全局函数（有的文件从 window 取、有的靠全局作用域），两条都认；
   *  两条都没有时**留痕**——一句要用户知道的失败提示不能就这么没了。 */
  function alertUser(message) {
    const body = String(message == null ? '' : message);
    let fn = null;
    if (typeof uiAlert === 'function') fn = uiAlert;
    else if (typeof root.uiAlert === 'function') fn = root.uiAlert;
    if (fn) return Promise.resolve(fn(body));
    log.warn('uiAlert unavailable; user-facing message dropped', { message: body });
    return Promise.resolve();
  }

  function defaultPort() {
    return {
      invoke: (channel, body) => root.cogseed.invoke(channel, body),
      alert: alertUser,
    };
  }

  async function resolve(card, payload, action, port) {
    if (!card || card.dataset.busy === '1') return;
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
        // 版本重检不一致：卡片**保持待处理**，如实说明为什么没生效（不静默覆盖）。
        if (result && result.versionConflict) {
          card.dataset.busy = '';
          card.classList.remove('is-busy');
          render(card, payload, { ...(card._assetApprovalView || {}), state: 'pending' });
          await io.alert(tr('recall.asset_approval.version_conflict',
            '这条资产在你看卡片之后被改过（v{a} → v{b}），这次没有生效。请重新看一眼内容再决定。',
            { a: String(result.versionConflict.baselineVersion || ''), b: String(result.versionConflict.currentVersion || '') }));
          return;
        }
        throw new Error((result && result.error) || tr('recall.asset_approval.decide_failed', '处置失败：{message}', { message: '' }));
      }
      card.dataset.busy = '';
      card.classList.remove('is-busy');
      const state = String(result.state || (action === 'confirm' ? 'confirmed' : action === 'defer' ? 'deferred' : 'rejected'));
      render(card, payload, { state, ...(result.appliedVersion ? { appliedVersion: result.appliedVersion } : {}) });
    } catch (error) {
      card.dataset.busy = '';
      card.classList.remove('is-busy');
      card.querySelectorAll('button').forEach((button) => { button.disabled = false; });
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
    render(card, payload, { state: 'pending' });
    // 历史重载时卡片消息是静态载荷：查一次真实状态与拟生效内容——不查状态则已处置的
    // 卡片会又变回"待处理"；不查内容则"可编辑"只是一句空话（载荷里只有摘要）。
    root.cogseed.invoke('recall.assets.approval.read', { proposalId: payload.proposalId }).then((result) => {
      const proposal = result && result.proposal ? result.proposal : null;
      if (!proposal) return;
      render(card, payload, {
        state: String(proposal.state || 'pending'),
        ...(proposal.payload ? { proposed: proposal.payload } : {}),
        ...(proposal.beforeValues ? { current: proposal.beforeValues } : {}),
      });
    }).catch((error) => {
      // 这里以前是 `.catch(() => {})`：一旦取内容失败，卡片就停在只有一个标题的骨架上，
      // 而**没有任何地方**留下线索。失败要说出来，界面也要说清楚还能做什么。
      log.warn('asset approval card hydrate failed', {
        proposalId: String(payload.proposalId || ''),
        error: (error && error.message) || String(error),
      });
      render(card, payload, { state: 'pending', readFailed: true });
    });
    return card;
  }

  const api = {
    mount,
    render,
    resolve,
    cardHtml,
    collectEdits,
    editableKeysOf,
    textToValue,
    valueToText,
  };
  root.ChatAssetApproval = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
