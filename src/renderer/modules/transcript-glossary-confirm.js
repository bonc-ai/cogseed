/**
 * 转写纠错 · 高危候选的**可点选确认卡片**（渲染侧）
 *
 * 会议工作流里纠错由 agent 触发，agent 没有界面，所以它把"哪些同音词要改"
 * 交给这张卡片，由人勾选。对应主进程：
 *   src/main/model/core-agent/glossary-confirm.ts   （发卡 / 收结果）
 *   src/main/model/core-agent/transcript-glossary-tools.ts（apply 工具发卡）
 *   src/main/ipc/index.ts 的 transcript_glossary.confirm / .visible
 *
 * 为什么不是弹窗：与 delete-file-confirm 同一结论——模态挡住整个界面，
 * 用户没法边看转写边决定。卡片挂在对话流底部。
 *
 * ── 三个必须照抄 delete-file-confirm 的地方（都是它踩过的坑）────────────
 *   1. **挂载后回执**（`transcript_glossary.visible`）：主进程要等这个回执
 *      才知道"卡片真的给用户看了"，没回执就改用文字问，而不是让模型对着
 *      不存在的卡片说"请点击"。
 *   2. **只在可见容器上回执**：卡片若挂进了 `display:none` 的容器（用户切到
 *      别的 tab），回执会骗主进程"已展示"。用 `offsetParent !== null` 判断。
 *   3. **提交后自动续跑**：令牌翻状态**不会唤醒 LLM**——工具已在上一轮结束。
 *      必须自动发一条短消息，agent 才会带着 token 再调一次工具。
 *
 * Renderer 约束：classic script（无 JSX/bundler）、文案走 i18n 并有中文兜底、
 * 控件用共享原语（btn / uiCheckbox）。
 */

(function initTranscriptGlossaryConfirm(root) {
  'use strict';

  const log = typeof createLogger === 'function' ? createLogger('glossary-confirm') : null;
  let subscription = null;
  const batches = new Map();
  /** 同一轮内多张卡片合并的时间窗（无 turn_id 时的兜底，与 delete_file 同值）。 */
  const FALLBACK_BATCH_MS = 1000;

  function tOr(key, fallback, vars) {
    let out = fallback;
    try {
      const v = typeof root.t === 'function' ? root.t(key, vars || {}) : '';
      if (v && v !== key) out = v;
    } catch (_) { /* fall through to the literal */ }
    if (vars) {
      for (const [k, val] of Object.entries(vars)) {
        out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(val));
      }
    }
    return out;
  }

  function startTranscriptGlossaryConfirmSubscription() {
    if (subscription) return; // idempotent
    if (!window.cogseed || typeof window.cogseed.onPushEvent !== 'function') return;
    try {
      subscription = window.cogseed.onPushEvent(
        'transcript_glossary.confirmation_required',
        handleConfirmRequest,
      );
    } catch (err) {
      if (log) log.warn('subscribe failed: ' + ((err && err.message) || String(err)));
    }
  }

  let restoreRevision = 0;
  async function restoreTranscriptGlossaryConfirmations(cid) {
    const revision = ++restoreRevision;
    const container = document.getElementById('chat-history');
    if (!cid || !container || !root.cogseed?.invoke) return;
    try {
      const pending = await root.cogseed.invoke('transcript_glossary.pending', { cid });
      if (revision !== restoreRevision || container !== document.getElementById('chat-history')) return;
      if (typeof currentCid !== 'undefined' && currentCid !== cid) return;
      for (const payload of Array.isArray(pending?.confirmations) ? pending.confirmations : []) {
        if (payload.cid !== cid) continue;
        const mounted = [...batches.values()].some(batch => batch.ids.has(payload.confirm_id)
          && batch.card.parentNode === container);
        if (!mounted) mountCard(payload, container);
      }
    } catch (err) {
      if (log) log.warn('restore failed: ' + ((err && err.message) || String(err)));
    }
  }

  function handleConfirmRequest(payload) {
    if (!payload || typeof payload.confirm_id !== 'string') return;
    if (payload.status === 'resolved') {
      for (const batch of batches.values()) {
        if (!batch.ids.has(payload.confirm_id) || batch.submitting) continue;
        const entry = batch.entries.find(item => item.confirm_id === payload.confirm_id);
        entry.resolved = Array.isArray(payload.accepted) ? payload.accepted : [];
        if (!batch.entries.every(item => Array.isArray(item.resolved))) continue;
        const picked = batch.entries.flatMap(item => item.resolved);
        for (const box of batch.listEl.querySelectorAll('input[type="checkbox"]')) {
          box.checked = picked.includes(box.getAttribute('data-entry-ref'));
          box.disabled = true;
        }
        batch.okBtn.disabled = true;
        batch.noneBtn.disabled = true;
        finishBatch(batch, picked, true);
      }
      return;
    }
    mountCard(payload);
  }

  /** 与 delete-file-confirm 同一套"找当前可见对话容器"的逻辑。 */
  function findActiveChatContainer() {
    const ids = ['skills-chat-messages', 'agents-chat-messages', 'chat-history'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.offsetParent !== null) return el;
    }
    return document.getElementById('chat-history');
  }

  function turnIdOf(payload) {
    return String((payload && (payload.turn_id || payload.turnId)) || '');
  }

  function batchKey(container, payload) {
    const surface = container.id || 'chat-history';
    const cid = String(payload && payload.cid ? payload.cid : '');
    const turnId = turnIdOf(payload);
    return surface + ':' + cid + ':' + (turnId ? ('turn:' + turnId) : 'fallback');
  }

  function mountCard(payload, targetContainer) {
    const container = targetContainer || findActiveChatContainer();
    if (!container) {
      // No visible surface is not a human decision. Keep the token pending;
      // the host's visible-ack timeout triggers the textual candidate fallback.
      return;
    }
    const key = batchKey(container, payload);
    const hasTurnId = !!turnIdOf(payload);
    let batch = batches.get(key);
    if (!batch
      || batch.settled
      || batch.container !== container
      || batch.card.parentNode !== container
      || (!hasTurnId && !batch.accepting)) {
      batch = createBatch(container, key, hasTurnId);
      batches.set(key, batch);
    }
    addItems(batch, payload);
  }

  /**
   * 共享原语**直接**取用，不包本地同名函数。
   *
   * 踩过的坑：这里原本包了一层同名薄函数，函数体里出现了裸控件标签串，
   * 结果 `shared-ui-adoption-guard` 直接判违规。该闸门是**纯文本**统计：
   * 连注释里写出控件标签字面量都会计数，包一层并不能把违规藏起来。
   * 仓库纪律是"不建局部控件变体"，所以一律直接调 `root.uiCheckbox` / `root.uiButton`。
   */
  function requirePrimitive(name) {
    if (typeof root[name] !== 'function') {
      throw new Error('transcript glossary confirm: shared ' + name + ' unavailable');
    }
    return root[name];
  }

  function createBatch(container, key, hasTurnId) {
    const card = document.createElement('div');
    card.className = 'glossary-confirm-card';
    card.dataset.glossaryConfirmBatch = key;
    // 动作键走共享原语（字符串），点击用委托分派——不建局部控件变体。
    card.innerHTML = `
      <div class="glossary-confirm-title"></div>
      <div class="glossary-confirm-hint"></div>
      <div class="glossary-confirm-list"></div>
      <div class="glossary-confirm-actions">
        ${requirePrimitive('uiButton')({ label: tOr('transcript.glossary.confirm.none', '都不用改'), role: 'secondary', size: 'sm', attrs: { 'data-glossary-act': 'none' } })}
        ${requirePrimitive('uiButton')({ label: tOr('transcript.glossary.confirm.apply', '应用勾选项'), role: 'primary', size: 'sm', attrs: { 'data-glossary-act': 'ok' } })}
      </div>
      <div class="glossary-confirm-result" hidden></div>
    `;
    container.appendChild(card);
    scrollIntoView(card);

    const batch = {
      key,
      container,
      card,
      titleEl: card.querySelector('.glossary-confirm-title'),
      hintEl: card.querySelector('.glossary-confirm-hint'),
      listEl: card.querySelector('.glossary-confirm-list'),
      okBtn: card.querySelector('[data-glossary-act="ok"]'),
      noneBtn: card.querySelector('[data-glossary-act="none"]'),
      resultEl: card.querySelector('.glossary-confirm-result'),
      /** confirm_id → 该卡片的条目数组（一次请求一张卡，但保留批量合并能力）。 */
      entries: [],
      ids: new Set(),
      settled: false,
      accepting: true,
      hasTurnId,
      fallbackTimer: null,
    };
    refreshFallbackWindow(batch);

    // 标签文案已由 uiButton 渲染，这里不再回填 textContent。
    batch.okBtn.addEventListener('click', () => settleBatch(batch, 'apply'));
    batch.noneBtn.addEventListener('click', () => settleBatch(batch, 'none'));
    return batch;
  }

  function refreshFallbackWindow(batch) {
    if (!batch || batch.hasTurnId) return;
    if (batch.fallbackTimer) clearTimeout(batch.fallbackTimer);
    batch.accepting = true;
    batch.fallbackTimer = setTimeout(() => {
      batch.accepting = false;
      batch.fallbackTimer = null;
    }, FALLBACK_BATCH_MS);
  }

  function addItems(batch, payload) {
    const confirmId = String(payload.confirm_id || '');
    if (!confirmId || batch.ids.has(confirmId) || batch.settled) return;
    refreshFallbackWindow(batch);
    const items = Array.isArray(payload.items) ? payload.items : [];
    batch.ids.add(confirmId);
    batch.entries.push({ confirm_id: confirmId, items });
    batch.card.dataset.glossaryConfirmId = confirmId;
    batch.card.dataset.glossaryConfirmCount = String(items.length);
    renderBatch(batch);
    scrollIntoView(batch.card);
    ackVisible(batch.card, confirmId, items.length);
  }

  function riskLabel(risk) {
    if (risk === 'high') return tOr('transcript.glossary.risk.high', '需确认');
    if (risk === 'medium') return tOr('transcript.glossary.risk.medium', '中风险');
    return tOr('transcript.glossary.risk.low', '低风险');
  }

  function renderBatch(batch) {
    const items = batch.entries.flatMap((e) => e.items);
    batch.titleEl.textContent = tOr(
      'transcript.glossary.confirm.title',
      '有 {count} 项转写纠错建议需要你确认',
      { count: items.length },
    );
    batch.hintEl.textContent = tOr(
      'transcript.glossary.confirm.hint',
      '请结合上下文选择需要替换的内容。未勾选的内容保留原文；也可以选择都不用改。',
    );

    // 整列表一次 innerHTML 拼装：勾选框走共享 uiCheckbox（字符串）。
    // 不为每行建 DOM 节点，也不手写原生输入控件 —— 两者都被闸门禁止。
    const rows = items.map((item, index) => {
      // Every row here awaits a human decision. A glossary entry's low risk
      // does not establish that a fuzzy occurrence refers to that entry.
      const checked = false;
      const boxId = 'glossary-confirm-' + batch.key.replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + index;

      const changeText = item.action === 'delete'
        ? tOr('transcript.glossary.confirm.delete', '删除「{wrong}」', { wrong: item.wrong })
        : '「' + item.wrong + '」 → 「' + item.correct + '」';
      const bits = [riskLabel(item.riskLevel)];
      if (Number(item.count || 1) > 1) {
        bits.push(tOr('transcript.glossary.confirm.count', '出现 {count} 次', { count: item.count }));
      }
      if (item.context) bits.push('…' + item.context + '…');

      return '<label class="glossary-confirm-row" for="' + boxId + '">'
        + requirePrimitive('uiCheckbox')({
          id: boxId,
          label: changeText,
          checked,
          // entryRef 放在 data-* 上：提交时按它回填 accepted（不依赖行序，行序会随扫描变）。
          attrs: { 'data-entry-ref': String(item.entryRef || '') },
        })
        + '<span class="glossary-confirm-row-body">'
        + '<span class="glossary-confirm-row-change">' + escapeHtml(changeText) + '</span>'
        + '<span class="glossary-confirm-row-meta">' + escapeHtml(bits.join(' · ')) + '</span>'
        + '</span></label>';
    });
    batch.listEl.innerHTML = rows.join('');

    /**
     * 一个都没勾时**禁用主按钮**。
     *
     * 「应用勾选项」在 0 勾选下的语义是空的 —— "一个都不应用"本来就是旁边那个
     * 「都不用改」。此前 0 勾选仍可点，且会被当成"全选"（见 settleBatch 的
     * acceptAll），用户正是这样把 6 条全确认掉的。
     * 两道防线：这里让它点不了，settleBatch 那边也不再误判。
     */
    syncApplyEnabled(batch);
    batch.listEl.addEventListener('change', () => syncApplyEnabled(batch));
  }

  /** 按当前勾选情况开关「应用勾选项」：勾了才可点。 */
  function syncApplyEnabled(batch) {
    if (!batch || batch.settled || !batch.okBtn) return;
    const boxes = batch.listEl.querySelectorAll('input[type="checkbox"]');
    let checked = 0;
    for (const box of boxes) if (box.checked) checked += 1;
    const enabled = checked > 0;
    batch.okBtn.disabled = !enabled;
    // 可点性也告诉读屏软件，不只靠样式。方法存在性做防御：
    // 测试装置里的假按钮只有 disabled，没有 DOM 方法。
    if (enabled) {
      if (typeof batch.okBtn.removeAttribute === 'function') batch.okBtn.removeAttribute('aria-disabled');
    } else if (typeof batch.okBtn.setAttribute === 'function') {
      batch.okBtn.setAttribute('aria-disabled', 'true');
    }
  }

  /** 候选文本来自转写正文（用户内容），进 innerHTML 前必须转义。 */
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function checkedRefs(batch) {
    const out = [];
    // uiCheckbox 会把 attrs 里的 data-entry-ref 原样渲染成属性，
    // 读回时用 getAttribute（不是 dataset，因为属性名带连字符）。
    for (const box of batch.listEl.querySelectorAll('input[type="checkbox"]')) {
      if (!box.checked) continue;
      const ref = box.getAttribute ? box.getAttribute('data-entry-ref') : '';
      if (ref) out.push(ref);
    }
    return out;
  }

  async function settleBatch(batch, mode) {
    if (batch.settled || batch.submitting) return;
    batch.submitting = true;
    if (batch.fallbackTimer) {
      clearTimeout(batch.fallbackTimer);
      batch.fallbackTimer = null;
    }
    batch.okBtn.disabled = true;
    batch.noneBtn.disabled = true;

    const picked = mode === 'apply' ? checkedRefs(batch) : [];
    /**
     * `acceptAll` 只在**用户确实勾满了**时才成立。
     *
     * 注意：此前漏了 `picked.length > 0` —— 一个都没勾时 `0 === 0` 也为真，于是
     * 「一个没勾 + 点『应用勾选项』」被当成"全选" ⇒ **把全部高风险项确认掉**。
     * 真实事故（2026-10-15）：用户本意是"都不用改"，点到了蓝色的主按钮，
     * 结果 6 条同音词全被确认并应用。
     *
     * 0 勾选根本不该走到这里 —— 卡片上的「都不用改」才是那个语义。见下方按钮禁用。
     */
    const boxCount = batch.listEl.querySelectorAll('input[type="checkbox"]').length;
    const acceptAll = mode === 'apply' && picked.length > 0 && picked.length === boxCount;

    let resumed = true;
    try {
      for (const entry of batch.entries) {
        const result = await respond(entry.confirm_id, picked, acceptAll);
        if (!result || result.ok !== true) throw new Error('confirmation rejected');
        resumed = resumed && result.resumed === true;
      }
    } catch (err) {
      batch.submitting = false;
      batch.noneBtn.disabled = false;
      batch.okBtn.disabled = checkedRefs(batch).length === 0;
      batch.resultEl.textContent = tOr('transcript.glossary.confirm.failed', '确认未提交成功，请重试。');
      batch.resultEl.hidden = false;
      return;
    }
    finishBatch(batch, picked, resumed);
  }

  function finishBatch(batch, picked, resumed) {
    if (batch.fallbackTimer) clearTimeout(batch.fallbackTimer);
    batch.submitting = false;
    batch.settled = true;
    batches.delete(batch.key);
    batch.card.classList.add(picked.length ? 'is-confirmed' : 'is-dismissed');
    batch.resultEl.textContent = picked.length
      ? tOr(
        'transcript.glossary.confirm.applied',
        '已确认 {count} 处，正在继续…',
        { count: picked.length },
      )
      : tOr('transcript.glossary.confirm.none_applied', '已选择都不修改，正在继续…');
    batch.resultEl.hidden = false;

    // Main resumes the card's owning actor. Never type into whichever
    // composer happens to be mounted or enqueue a second generic follow-up.
    const fired = resumed;
    if (!fired) {
      batch.resultEl.textContent += ' — '
        + tOr('transcript.glossary.confirm.send_hint', '请发送一条消息让智能体继续。');
    }
  }

  async function respond(confirmId, accepted, acceptAll) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    try {
      return await window.cogseed.invoke('transcript_glossary.confirm', {
        confirm_id: confirmId,
        accepted,
        accept_all: !!acceptAll,
      });
    } catch (err) {
      if (log) log.warn('respond failed: ' + ((err && err.message) || String(err)));
    }
  }

  function ackVisible(card, confirmId, itemCount) {
    // 只在**真的可见**时回执：隐藏容器里的卡片用户看不见，回执会骗主进程。
    if (!confirmId || !card || card.offsetParent === null) return;
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    try {
      window.cogseed.invoke('transcript_glossary.visible', { confirm_id: confirmId })
        .catch((err) => {
          if (log) log.warn('visible ack failed: ' + ((err && err.message) || String(err)));
        });
    } catch (err) {
      if (log) log.warn('visible ack failed: ' + ((err && err.message) || String(err)));
    }
  }

  function scrollIntoView(card) {
    try { card.scrollIntoView({ behavior: 'smooth', block: 'end' }); }
    catch (_) { /* Electron only; no legacy fallback needed */ }
  }

  root.restoreTranscriptGlossaryConfirmations = restoreTranscriptGlossaryConfirmations;
  root.startTranscriptGlossaryConfirmSubscription = startTranscriptGlossaryConfirmSubscription;
  // 暴露给单测（渲染层测试在 jsdom 里直接调纯函数）。
  root._glossaryConfirmTestHooks = {
    renderBatch,
    checkedRefs,
    riskLabel,
    batchKey,
    turnIdOf,
  };
})(window);
