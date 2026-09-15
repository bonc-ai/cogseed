/**
 * Chat citation chips (知识库问答 ② P2).
 *
 * Turns `path#chunk N` citations (optionally prefixed `[global]` / `[space]`)
 * inside rendered chat bubbles into clickable chips that open the anchored
 * source viewer (`window.__openAnchorViewer`, P3).
 *
 * Implementation notes:
 *   - A MutationObserver on the #chat-history container linkifies every
 *     newly rendered `.markdown-body` exactly once (WeakSet guard), so no
 *     message-render call site needs editing — zero impact on other render
 *     paths.
 *   - Chips are built with createElement + textContent only (the citation
 *     text comes from the LLM) — no innerHTML with model content.
 *   - Attachment citations (`[attachment]`) are intentionally left as text
 *     for now: resolving them needs a conversation cid that is not available
 *     at chip time (documented limitation, P4/5).
 */
(function () {
  'use strict';

  const CITATION_RE = /(?:\[(global|space)\]\s*)?([A-Za-z0-9._-]+)#chunk\s*(\d+)/g;
  const processed = new WeakSet();

  function _skipNode(node) {
    const tag = node.nodeType === Node.ELEMENT_NODE ? node.tagName : '';
    return tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE'
      || tag === 'A' || tag === 'BUTTON';
  }

  function _linkifyTextNode(textNode) {
    const text = textNode.nodeValue || '';
    if (!/#chunk\s*\d/i.test(text)) return;

    CITATION_RE.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    let made = false;
    let m;
    while ((m = CITATION_RE.exec(text)) !== null) {
      if (m.index > last) fragment.appendChild(document.createTextNode(text.slice(last, m.index)));
      const scope = m[1] || 'global';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'citation-chip';
      chip.dataset.citationScope = scope;
      chip.dataset.citationPath = m[2];
      chip.dataset.citationChunk = m[3];
      chip.textContent = m[0];
      chip.title = `跳转到原文：${m[2]} 第 ${m[3]} 块`;
      fragment.appendChild(chip);
      made = true;
      last = m.index + m[0].length;
    }
    if (!made) return;
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(fragment, textNode);
  }

  function linkify(root) {
    if (!root) return;
    if (processed.has(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (_skipNode(parent)) return NodeFilter.FILTER_REJECT;
        // Only walk text directly under a markdown body, not nested bubbles.
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const t of targets) _linkifyTextNode(t);
    processed.add(root);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const added of mut.addedNodes) {
        if (added.nodeType !== Node.ELEMENT_NODE) continue;
        if (added.classList && added.classList.contains('markdown-body')) {
          linkify(added);
        } else {
          const bodies = added.querySelectorAll ? added.querySelectorAll('.markdown-body') : [];
          for (const b of bodies) linkify(b);
        }
      }
    }
  });

  function start() {
    const history = document.getElementById('chat-history');
    if (!history) return;
    observer.observe(history, { childList: true, subtree: true });
    // Linkify whatever is already rendered.
    history.querySelectorAll('.markdown-body').forEach(linkify);
  }

  // 引用点击的统一入口：**排版类**（pdf/office/html/图片）交给 KB 富查看器保排版，
  // 纯文本仍走原文查看器（转写纠错面板的宿主）。
  // `__openKbSourceDocument` 由 kb-workbench.js 暴露，而 KB 是懒加载的——桥不在时
  // 直接回落原文查看器；空间库引用（chip 不带 spaceId）也走回落。
  // 排版类的最终兜底在 `__openAnchorViewer` 里：它自己会按需拉起富查看器桥，
  // 所以这里回落也不会把 PDF/Word 变成没有排版的纯文本。
  function _openCitationTarget(anchor) {
    const fallback = () => {
      if (typeof window.__openAnchorViewer === 'function') window.__openAnchorViewer({ ...anchor });
    };
    if (anchor.scope !== 'space' && typeof window.__openKbSourceDocument === 'function') {
      Promise.resolve(window.__openKbSourceDocument(anchor)).then((handled) => {
        if (!handled) fallback();
      }).catch(fallback);
      return;
    }
    fallback();
  }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest ? e.target.closest('[data-citation-chunk]') : null;
    if (!chip) return;
    e.preventDefault();
    const scope = chip.dataset.citationScope || 'global';
    if (scope === 'attachment') return; // needs cid — not resolvable from the chip yet
    _openCitationTarget({
      source: 'library',
      scope,
      path: chip.dataset.citationPath,
      chunkIdx: Number(chip.dataset.citationChunk),
    });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
