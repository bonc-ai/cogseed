/**
 * Shared source viewer for knowledge-base files and citation anchors.
 *
 * The compact view resolves and highlights a cited chunk. The reader view
 * lazily asks the same read-only resolver for a bounded document payload, so
 * opening a file never writes data or triggers rich-document extraction.
 */
(function initAnchoredSourceView(root) {
  'use strict';

  const log = typeof createLogger === 'function' ? createLogger('anchored-source-view') : null;
  let activeModal = null;
  let activeAnchor = null;
  let activeView = 'anchor';
  let activeResult = null;
  let requestSequence = 0;

  function formatFallback(text, vars) {
    return String(text || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(vars?.[key] ?? ''));
  }

  function t(key, fallback, vars) {
    try {
      const value = typeof root.t === 'function' ? root.t(key, vars || {}) : '';
      return value && value !== key ? value : formatFallback(fallback, vars);
    } catch (_) {
      return formatFallback(fallback, vars);
    }
  }

  function viewerBodyHtml() {
    return [
      '<div class="anchored-source-viewer">',
      '<div class="anchored-source-toolbar">',
      '<div class="anchored-source-meta" data-anchor-view-meta></div>',
      '<div class="anchored-source-actions" data-anchor-view-actions></div>',
      '</div>',
      '<div class="anchored-source-body">',
      '<div class="anchored-source-status" data-anchor-view-status></div>',
      '<pre class="anchored-source-text" data-anchor-view-text></pre>',
      '<div class="anchored-source-note" data-anchor-view-note hidden></div>',
      '</div>',
      '</div>',
    ].join('');
  }

  function modalIsOpen() {
    return Boolean(activeModal?.overlay && document.body.contains(activeModal.overlay));
  }

  function ensureModal() {
    if (modalIsOpen()) return activeModal;
    if (typeof root.uiModal !== 'function' || typeof root.uiButton !== 'function') return null;

    const modal = root.uiModal({
      title: t('kb.viewer.title', '原文查看器'),
      description: t('kb.viewer.description', '查看知识库原文，并定位到引用片段。'),
      closeLabel: t('common.close', '关闭'),
      size: 'lg',
      bodyHtml: viewerBodyHtml(),
    });
    modal.dialog.classList.add('anchored-source-modal');
    modal.then(() => {
      if (activeModal === modal) activeModal = null;
    });
    activeModal = modal;
    return modal;
  }

  function element(selector) {
    return activeModal?.dialog?.querySelector(selector) || null;
  }

  function setMeta(text) {
    const meta = element('[data-anchor-view-meta]');
    if (meta) meta.textContent = text;
  }

  function setStatus(text, tone) {
    const status = element('[data-anchor-view-status]');
    if (!status) return;
    status.textContent = text || '';
    status.hidden = !text;
    status.dataset.tone = tone || '';
  }

  function renderActions() {
    const host = element('[data-anchor-view-actions]');
    if (!host) return;
    const canReturnToAnchor = activeView === 'document'
      && activeAnchor
      && (Number.isFinite(Number(activeAnchor.chunkIdx)) || String(activeAnchor.quote || '').trim());
    const label = activeView === 'anchor'
      ? t('kb.viewer.read_full', '阅读全文')
      : canReturnToAnchor
        ? t('kb.viewer.back_to_anchor', '返回引用位置')
        : '';
    if (!label) {
      host.textContent = '';
      return;
    }
    host.innerHTML = root.uiButton({
      label,
      icon: activeView === 'anchor' ? 'book-open' : 'quote',
      role: 'secondary',
      size: 'sm',
      attrs: { 'data-anchor-view-toggle': 'true' },
    });
    host.querySelector('[data-anchor-view-toggle]')?.addEventListener('click', () => {
      void loadView(activeView === 'anchor' ? 'document' : 'anchor');
    });
  }

  function reasonText(reason) {
    if (reason === 'no_cache') return t('kb.viewer.no_cache', '该文件仍在索引中，暂时无法读取原文。');
    if (reason === 'out_of_scope') return t('kb.viewer.out_of_scope', '该文件不在当前资料边界内，无法打开。');
    if (reason === 'not_found') return t('kb.viewer.not_found', '已打开文件，但未找到对应的引用片段。');
    return t('kb.viewer.unavailable', '暂时无法读取该文件的原文。');
  }

  function renderText(result) {
    const pre = element('[data-anchor-view-text]');
    const note = element('[data-anchor-view-note]');
    if (!pre || !note) return;
    pre.textContent = '';
    note.hidden = true;
    note.textContent = '';

    if (!result?.resolved) {
      setStatus(reasonText(result?.reason), 'warning');
      return;
    }

    setStatus('', '');
    const text = String(result.text || '');
    const textStart = Number.isFinite(Number(result.textStart)) ? Number(result.textStart) : 0;
    const absoluteStart = Number(result.charStart);
    const absoluteEnd = Number(result.charEnd);
    const markStart = Number.isFinite(absoluteStart) ? Math.max(0, Math.min(text.length, absoluteStart - textStart)) : 0;
    const markEnd = Number.isFinite(absoluteEnd) ? Math.max(markStart, Math.min(text.length, absoluteEnd - textStart)) : markStart;

    pre.appendChild(document.createTextNode(text.slice(0, markStart)));
    if (markEnd > markStart) {
      const mark = document.createElement('mark');
      mark.textContent = text.slice(markStart, markEnd);
      pre.appendChild(mark);
    }
    pre.appendChild(document.createTextNode(text.slice(markEnd)));

    if (result.truncated) {
      note.hidden = false;
      note.textContent = t('kb.viewer.truncated', '文档较长，当前显示包含引用位置的部分内容。');
    }
    requestAnimationFrame(() => pre.querySelector('mark')?.scrollIntoView({ block: 'center' }));
  }

  function renderMeta(result) {
    const bits = [String(result?.displayPath || activeAnchor?.path || '')].filter(Boolean);
    if (result?.page) bits.push(t('kb.viewer.page', '第 {page} 页', { page: result.page }));
    if (Number.isFinite(Number(result?.charStart)) && Number.isFinite(Number(result?.charEnd))) {
      bits.push(t('kb.viewer.characters', '字符 {start}–{end}', { start: result.charStart, end: result.charEnd }));
    }
    if (Number.isFinite(Number(result?.totalChars))) {
      bits.push(t('kb.viewer.total_chars', '共 {count} 字符', { count: result.totalChars }));
    }
    setMeta(bits.join(' · '));
  }

  function renderResult(result) {
    activeResult = result;
    activeModal?.dialog?.classList.toggle('anchored-source-modal--reader', activeView === 'document');
    renderMeta(result);
    renderText(result);
    renderActions();
  }

  function renderLoading() {
    activeResult = null;
    activeModal?.dialog?.classList.toggle('anchored-source-modal--reader', activeView === 'document');
    setMeta(String(activeAnchor?.path || ''));
    setStatus(activeView === 'document'
      ? t('kb.viewer.loading_document', '正在读取原文…')
      : t('kb.viewer.locating', '正在定位引用…'), 'loading');
    const pre = element('[data-anchor-view-text]');
    if (pre) pre.textContent = '';
    renderActions();
  }

  async function loadView(view) {
    if (!activeAnchor || !ensureModal()) return;
    activeView = view === 'document' ? 'document' : 'anchor';
    const sequence = ++requestSequence;
    renderLoading();
    try {
      const result = await root.cogseed.invoke('cogseed.anchor.resolve', { ...activeAnchor, view: activeView });
      if (sequence !== requestSequence || !modalIsOpen()) return;
      if (result?.ok === false) throw new Error(result.error || 'anchor resolve failed');
      renderResult(result || { resolved: false, reason: 'no_text' });
    } catch (error) {
      if (sequence !== requestSequence || !modalIsOpen()) return;
      log?.warn('source viewer load failed', { error: error?.message || String(error) });
      renderResult({ resolved: false, reason: 'no_text' });
    }
  }

  function openAnchorViewer(anchor) {
    const path = String(anchor?.path || '').trim();
    if (!path) return Promise.resolve();
    if (!ensureModal()) {
      if (typeof root.uiToast === 'function') {
        root.uiToast(t('kb.viewer.ui_unavailable', '原文查看器暂时不可用'), { variant: 'warning' });
      }
      return Promise.resolve();
    }
    activeAnchor = { ...anchor, path };
    return loadView(anchor?.view === 'document' ? 'document' : 'anchor');
  }

  root.addEventListener?.('i18n-change', () => {
    if (!modalIsOpen()) return;
    const title = activeModal.dialog.querySelector('.ui-modal__title');
    const description = activeModal.dialog.querySelector('.ui-modal__description');
    if (title) title.textContent = t('kb.viewer.title', '原文查看器');
    if (description) description.textContent = t('kb.viewer.description', '查看知识库原文，并定位到引用片段。');
    if (activeResult) renderResult(activeResult);
    else renderLoading();
  });

  root.__openAnchorViewer = openAnchorViewer;

  if (typeof module !== 'undefined' && module.exports) module.exports = { formatFallback };
})(typeof window !== 'undefined' ? window : globalThis);
