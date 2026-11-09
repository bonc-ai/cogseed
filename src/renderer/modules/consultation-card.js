/**
 * A2A consultation strip — the receiver's private decision point (D-7/R-11).
 *
 * Shown above the composer of an A2A conversation while the assistant waits for the
 * receiver's answer. Three outcomes, matching the store: 同意 (send as proposed),
 * 改口径 (replace the wording), 不答 (send nothing).
 *
 * The strip is the whole surface on purpose: a consultation is a decision, not a
 * message, so it must not look like part of the transcript and must not be
 * scrollable history. It uses only shared components (`uiCard`, `uiButton`,
 * `uiEmptyState` is unnecessary here) and holds no state of its own beyond the
 * conversation it is rendering for.
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  function tr(key, fallback, vars) {
    try {
      if (typeof root.t === 'function') {
        const value = root.t(key, vars);
        if (value && value !== key) return String(value);
      }
    } catch (_) { /* i18n 未加载 */ }
    return String(fallback).replace(/\{(\w+)\}/g, (_, name) => (vars && vars[name] != null ? String(vars[name]) : `{${name}}`));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let currentCid = '';
  let consultations = [];
  /** 当前会话的 A2A 标识（仅为「确认中」提示服务）。 */
  let marker = null;
  let busy = false;
  let loadGeneration = 0;

  function host() {
    return typeof document !== 'undefined' ? document.getElementById('a2a-consultation-strip') : null;
  }

  function bridge() {
    const api = root.cogseed;
    return api && typeof api.invoke === 'function' ? api : null;
  }

  function pending() {
    return consultations.filter((row) => row && (row.state === 'pending'
      || (['approved', 'revised'].includes(row.state) && row.delivery && row.delivery.state !== 'sent')));
  }

  async function load(conversationId) {
    const generation = ++loadGeneration;
    const isCurrent = () => generation === loadGeneration && conversationId === currentCid;
    const api = bridge();
    if (!api || !conversationId) { consultations = []; marker = null; render(); return; }
    let nextRows = [];
    let nextMarker = null;
    try {
      const result = await api.invoke('a2a.consultations.list', { conversationId });
      const rows = result && (result.consultations || result.value);
      nextRows = Array.isArray(rows) ? rows : [];
    } catch (_) { /* Retain only this request's empty result. */ }
    if (!isCurrent()) return;
    try {
      const state = await api.invoke('a2a.conversationMarker', { conversationId });
      nextMarker = state && state.marker ? state.marker : null;
    } catch (_) { /* Marker hints are optional. */ }
    if (!isCurrent()) return;
    consultations = nextRows;
    marker = nextMarker;
    render();
  }

  /** Set the conversation this strip speaks for; an empty id clears it. */
  function setConversation(conversationId) {
    const nextCid = String(conversationId || '');
    if (nextCid !== currentCid) {
      ++loadGeneration;
      consultations = [];
      marker = null;
      currentCid = nextCid;
      render();
    }
    if (!currentCid) { ++loadGeneration; consultations = []; marker = null; render(); return Promise.resolve(); }
    return load(currentCid);
  }

  function cardHtml(row) {
    const title = tr('a2a.consultation.title', '助理在等你决定');
    const questionLabel = tr('a2a.consultation.question', '对方的问题');
    const replyLabel = tr('a2a.consultation.proposed', '准备这样回复');
    const inner = `
      <div class="a2a-consultation-body">
        <p class="a2a-consultation-label">${esc(questionLabel)}</p>
        <p class="a2a-consultation-question">${esc(row.question)}</p>
        <p class="a2a-consultation-label">${esc(replyLabel)}</p>
        <p class="a2a-consultation-reply">${esc(row.finalReply || row.proposedReply)}</p>
      </div>`;
    const decided = row.state !== 'pending';
    const deliveryState = row.delivery && row.delivery.state;
    const deliveryKey = deliveryState === 'failed' ? 'failed'
      : deliveryState === 'uncertain' ? 'uncertain' : 'sending';
    const actions = typeof root.uiButton === 'function' && !decided
      ? [
        ...(!row.creationError ? [{ label: tr('a2a.consultation.approve', '同意'), disabled: busy, attrs: { 'data-consult-approve': row.id } }] : []),
        { label: tr('a2a.consultation.revise', '改口径'), disabled: busy, attrs: { 'data-consult-revise': row.id } },
        { label: tr('a2a.consultation.decline', '不答'), disabled: busy, attrs: { 'data-consult-decline': row.id } },
      ]
      : (decided && deliveryState === 'failed' ? [
        { label: tr('common.retry', '重试'), disabled: busy, attrs: { 'data-consult-retry': row.id } },
      ] : []);
    if (typeof root.uiResourceCard === 'function') {
      return root.uiResourceCard({
        title: esc(title),
        description: row.peerName ? tr('a2a.consultation.from', '来自 {name}', { name: row.peerName }) : '',
        bodyHtml: inner,
        ...(row.creationError && !decided ? { status: {
          label: tr('a2a.consultation.creation_failed', '拟答复未能生成，请填写答复或选择不答。'),
          tone: 'attention',
        } } : decided ? { status: {
          label: tr(`a2a.consultation.delivery_${deliveryKey}`, deliveryKey === 'failed'
            ? '答复未送达，可重试原答复' : deliveryKey === 'uncertain'
              ? '发送结果待核实，未自动重发' : '正在发送答复'),
          tone: deliveryState === 'failed' || deliveryState === 'uncertain' ? 'attention' : 'neutral',
        } } : {}),
        actions,
        attrs: { 'data-consult-card': row.id },
      });
    }
    return `<section class="a2a-consultation" data-consult-card="${esc(row.id)}">${inner}</section>`;
  }

  function render() {
    const el = host();
    if (!el) return;
    const rows = pending();
    if (!rows.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const hint = marker && marker.state === 'confirming'
      && window.a2aMessageMarks && typeof window.a2aMessageMarks.confirmingHint === 'function'
      ? window.a2aMessageMarks.confirmingHint(marker.nudged === true)
      : '';
    el.hidden = false;
    el.innerHTML = `<div class="a2a-consult-strip" aria-live="polite">${hint}${rows.map(cardHtml).join('')}</div>`;
    bind(el);
  }

  function bind(el) {
    const on = (selector, handler) => {
      el.querySelectorAll(selector).forEach((node) => node.addEventListener('click', handler));
    };
    on('[data-consult-approve]', (event) => {
      event.preventDefault();
      void answer(event.currentTarget.dataset.consultApprove, 'approve');
    });
    on('[data-consult-revise]', (event) => {
      event.preventDefault();
      void answer(event.currentTarget.dataset.consultRevise, 'revise');
    });
    on('[data-consult-decline]', (event) => {
      event.preventDefault();
      void answer(event.currentTarget.dataset.consultDecline, 'decline');
    });
    on('[data-consult-retry]', (event) => {
      event.preventDefault();
      const row = consultations.find((item) => item.id === event.currentTarget.dataset.consultRetry);
      if (!row || !row.delivery || row.delivery.state !== 'failed') return;
      void answer(row.id, row.state === 'revised' ? 'revise' : 'approve', row.finalReply);
    });
  }

  async function answer(id, decision, chosenText) {
    const api = bridge();
    if (!api || !id || busy) return;
    let text = chosenText;
    if (decision === 'revise' && text === undefined) {
      if (typeof root.uiPrompt !== 'function') return;
      text = await root.uiPrompt(tr('a2a.consultation.revise_prompt', '改成怎么回复'), '');
      if (!text) return;
    }
    busy = true;
    render();
    try {
      const result = await api.invoke('a2a.consultations.answer', { id, decision, ...(text ? { text } : {}) });
      if (!result || result.ok === false || result.error) {
        const failure = new Error('consultation answer failed');
        failure.code = result && result.code;
        throw failure;
      }
      await load(currentCid);
    } catch (error) {
      if (typeof root.uiAlert === 'function') {
        const key = error && error.code === 'E_CONSULTATION_DELIVERY_UNCERTAIN'
          ? 'a2a.consultation.delivery_uncertain'
          : error && error.code === 'E_CONSULTATION_DELIVERY_FAILED'
            ? 'a2a.consultation.delivery_failed' : 'a2a.consultation.answer_failed';
        await root.uiAlert(tr(key, key.endsWith('delivery_uncertain')
          ? '发送结果待核实，未自动重发' : key.endsWith('delivery_failed')
            ? '答复未送达，可重试原答复' : '没能记录这次决定，请重试。'));
      }
    } finally {
      busy = false;
      render();
    }
  }

  if (root.cogseed && typeof root.cogseed.onPushEvent === 'function') {
    root.cogseed.onPushEvent('a2a:consultation', (notice) => {
      if (currentCid && notice && notice.conversationId === currentCid) return load(currentCid);
    });
  }
  if (typeof root.addEventListener === 'function') root.addEventListener('i18n-change', render);

  root.consultationStrip = { setConversation, refresh: () => load(currentCid), answer };
})();
