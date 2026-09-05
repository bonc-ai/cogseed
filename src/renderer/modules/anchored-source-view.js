/**
 * Anchored source viewer (知识库问答 ② P3).
 *
 * Opens a modal showing the resolved source location for a citation anchor:
 * display path, PDF page (when known), and the located text window with the
 * exact [charStart, charEnd) range highlighted. Reads the location via the
 * `cogseed.anchor.resolve` IPC channel (P1).
 *
 * Exposes `window.__openAnchorViewer(anchor)` so both the chat citation
 * chips (chat-citation.js) and future artifact payloads (P4, via the
 * artifact postMessage contract) can open the same viewer.
 *
 * Safety: the located text comes from user documents — it is rendered with
 * textContent / DOM building only, never innerHTML.
 */
(function () {
  'use strict';

  const VIEWER_ID = 'anchored-source-view';
  let _overlay = null;

  function _ensureOverlay() {
    if (_overlay && document.getElementById(VIEWER_ID)) return _overlay;

    const overlay = document.createElement('div');
    overlay.id = VIEWER_ID;
    overlay.className = 'anchored-source-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'anchored-source-dialog';

    const header = document.createElement('header');
    header.className = 'anchored-source-header';
    const title = document.createElement('span');
    title.className = 'anchored-source-title';
    title.textContent = '原文位置';
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'anchored-source-jump';
    jump.textContent = '在阅读器打开';
    jump.setAttribute('aria-label', '在阅读器打开');
    jump.addEventListener('click', () => {
      const isReader = dialog.classList.toggle('anchored-source-dialog--reader');
      jump.textContent = isReader ? '返回定位' : '在阅读器打开';
      meta.hidden = isReader;
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'anchored-source-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => overlay.hidden = true);
    header.append(title, jump, close);

    const meta = document.createElement('div');
    meta.className = 'anchored-source-meta';

    const body = document.createElement('div');
    body.className = 'anchored-source-body';
    const pre = document.createElement('pre');
    pre.className = 'anchored-source-text';
    body.appendChild(pre);

    dialog.append(header, meta, body);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });
    document.body.appendChild(overlay);
    _overlay = overlay;
    return overlay;
  }

  function _setMeta(text) {
    _ensureOverlay().querySelector('.anchored-source-meta').textContent = text;
  }

  function _renderBody(loc) {
    const pre = _ensureOverlay().querySelector('.anchored-source-text');
    pre.textContent = '';
    if (!loc.resolved) {
      const msg = document.createElement('span');
      msg.className = 'anchored-source-unresolved';
      msg.textContent = loc.reason === 'no_cache'
        ? '该文件尚未提取文本（可能仍在索引中），暂时无法定位到具体位置。'
        : loc.reason === 'out_of_scope'
          ? '该文件不在当前资料边界内，无法打开。'
          : loc.reason === 'not_found'
            ? '未能在原文中定位到该引用片段。'
            : '无法定位该引用。';
      pre.appendChild(msg);
      return;
    }
    const text = loc.text || '';
    // `loc.text` starts at charStart, so the cited range is [0, markLen).
    const markLen = Math.max(0, Math.min((loc.charEnd ?? loc.charStart ?? 0) - (loc.charStart ?? 0), text.length));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(0, markLen);
    pre.appendChild(mark);
    pre.appendChild(document.createTextNode(text.slice(markLen)));
  }

  async function openAnchorViewer(anchor) {
    // 整篇原文优先：library 源且 KB 工作台已提供整篇查看器桥 → 打开整篇并高亮/翻页
    if (anchor && anchor.source !== 'attachment' && typeof window.__openKbSourceDocument === 'function') {
      try {
        const ok = await window.__openKbSourceDocument(anchor);
        if (ok) return;
      } catch (_) { /* 打开失败回落片段查看器 */ }
    }
    const overlay = _ensureOverlay();
    overlay.hidden = false;
    _setMeta('定位中…');
    _renderBody({ resolved: false, reason: 'no_text' });
    try {
      const loc = await window.cogseed.invoke('cogseed.anchor.resolve', anchor);
      const metaBits = [String(anchor.path || '')];
      if (loc.page) metaBits.push(`第 ${loc.page} 页`);
      if (loc.resolved) metaBits.push(`字符 ${loc.charStart}–${loc.charEnd}`);
      if (!loc.resolved && loc.reason) metaBits.push(`（${loc.reason}）`);
      _setMeta(metaBits.join(' · '));
      _renderBody(loc);
    } catch (err) {
      _setMeta('定位失败');
      _renderBody({ resolved: false, reason: 'no_text' });
    }
  }

  window.__openAnchorViewer = openAnchorViewer;

  // Self-contained styles (reviewers may move to style.css).
  const style = document.createElement('style');
  style.textContent = `
    .anchored-source-overlay {
      position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,.45);
      display: flex; align-items: center; justify-content: center;
    }
    .anchored-source-overlay[hidden] { display: none; }
    .anchored-source-dialog {
      background: var(--surface, #fff); color: var(--text, #222);
      width: min(720px, 92vw); max-height: 80vh; border-radius: 10px;
      display: flex; flex-direction: column; box-shadow: 0 8px 40px rgba(0,0,0,.25);
    }
    .anchored-source-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 16px; border-bottom: 1px solid rgba(128,128,128,.3);
    }
    .anchored-source-title { font-weight: 600; }
    .anchored-source-jump {
      margin-left: auto; margin-right: 10px; border: 1px solid rgba(128,128,128,.4);
      background: transparent; color: inherit; font-size: 12px; padding: 3px 10px;
      border-radius: 6px; cursor: pointer;
    }
    .anchored-source-jump:hover { background: rgba(128,128,128,.12); }
    .anchored-source-dialog--reader {
      width: min(1100px, 96vw); max-height: 92vh;
    }
    .anchored-source-dialog--reader .anchored-source-body { padding: 28px 44px; }
    .anchored-source-dialog--reader .anchored-source-text {
      font-family: inherit; font-size: 15px; line-height: 2; color: inherit;
    }
    .anchored-source-close {
      border: 0; background: transparent; font-size: 20px; cursor: pointer; line-height: 1;
    }
    .anchored-source-meta {
      padding: 8px 16px; font-size: 12px; opacity: .75;
      border-bottom: 1px solid rgba(128,128,128,.2);
    }
    .anchored-source-body { overflow: auto; padding: 12px 16px; }
    .anchored-source-text {
      white-space: pre-wrap; word-break: break-word; margin: 0;
      font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px; line-height: 1.6;
    }
    .anchored-source-text mark {
      background: var(--accent, #ffe08a); padding: 0 1px; border-radius: 2px;
    }
    .anchored-source-unresolved { color: var(--danger, #c0392b); }
  `;
  document.head.appendChild(style);
})();
