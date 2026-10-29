// Shared instant tooltip. The native `title` tooltip waits ~1s and cannot be
// styled or sped up, so icon-only controls that must name themselves at once
// (the shell rail) opt in with `data-ui-tooltip` instead of `title`:
//
//   <button aria-label="任务" data-ui-tooltip>…</button>          text = aria-label
//   <button aria-label="…" data-ui-tooltip="Custom" data-ui-tooltip-side="bottom">
//
// One delegated listener set owns a single `position: fixed` bubble appended
// to <body>, so it is never clipped by scrolling or overflow ancestors. The
// bubble is `pointer-events: none` and the anchor keeps its aria-label as the
// accessible name; the bubble itself is decorative (aria-hidden).
(function initUiTooltip(root) {
  'use strict';

  const SELECTOR = '[data-ui-tooltip]';
  const GAP = 8;
  const EDGE = 4;
  let bubble = null;
  let anchor = null;

  function textFor(el) {
    const own = el.getAttribute('data-ui-tooltip');
    return (own && own.trim()) || el.getAttribute('aria-label') || '';
  }

  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'ui-tooltip';
    bubble.setAttribute('aria-hidden', 'true');
    bubble.hidden = true;
    document.body.appendChild(bubble);
    return bubble;
  }

  function place(el, side) {
    const box = el.getBoundingClientRect();
    const tip = bubble.getBoundingClientRect();
    const place = {
      right: () => ({ left: box.right + GAP, top: box.top + (box.height - tip.height) / 2 }),
      left: () => ({ left: box.left - GAP - tip.width, top: box.top + (box.height - tip.height) / 2 }),
      bottom: () => ({ left: box.left + (box.width - tip.width) / 2, top: box.bottom + GAP }),
      top: () => ({ left: box.left + (box.width - tip.width) / 2, top: box.top - GAP - tip.height }),
    };
    let at = (place[side] || place.right)();
    if (side === 'right' && at.left + tip.width > root.innerWidth - EDGE) at = place.left();
    const left = Math.min(Math.max(EDGE, at.left), root.innerWidth - tip.width - EDGE);
    const top = Math.min(Math.max(EDGE, at.top), root.innerHeight - tip.height - EDGE);
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
  }

  // The active rail entry opens the sidebar flyout on hover while the sidebar
  // is collapsed; a tooltip beside it would only compete with the flyout.
  function suppressed(el) {
    const cls = document.body.classList;
    return el.matches('.app-rail-btn.is-active')
      && cls.contains('sidebar-collapsed') && !cls.contains('shell-no-sidebar');
  }

  function show(el) {
    const text = textFor(el);
    if (!text || suppressed(el)) { hide(); return; }
    anchor = el;
    const node = ensureBubble();
    node.textContent = text;
    node.hidden = false;
    place(el, el.getAttribute('data-ui-tooltip-side') || 'right');
  }

  function hide() {
    anchor = null;
    if (bubble) bubble.hidden = true;
  }

  function anchorOf(event) {
    const target = event.target;
    return target && typeof target.closest === 'function' ? target.closest(SELECTOR) : null;
  }

  function bind() {
    document.addEventListener('mouseover', (event) => {
      const el = anchorOf(event);
      if (el && el !== anchor) show(el);
    });
    document.addEventListener('mouseout', (event) => {
      const el = anchorOf(event);
      if (!el || el !== anchor) return;
      const next = event.relatedTarget;
      if (next && el.contains(next)) return;
      hide();
    });
    document.addEventListener('focusin', (event) => {
      const el = anchorOf(event);
      if (el && typeof el.matches === 'function' && el.matches(':focus-visible')) show(el);
    });
    document.addEventListener('focusout', (event) => { if (anchorOf(event) === anchor) hide(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
    document.addEventListener('scroll', hide, true);
    root.addEventListener('blur', hide);
    root.addEventListener('resize', hide);
  }

  root.uiTooltip = { show, hide, textFor };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') bind();
  if (typeof module !== 'undefined' && module.exports) module.exports = { textFor };
})(typeof window !== 'undefined' ? window : globalThis);
