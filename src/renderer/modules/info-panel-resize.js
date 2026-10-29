/**
 * Drag-to-resize for the right "run context" panel.
 *
 * Drives `--info-panel-width` on `<html>`; `.conversation-info-panel` consumes
 * it and clamps with min-width / max-width. The handle sits on the panel's left
 * edge, so dragging left widens the panel. Width persists in localStorage
 * (machine-local layout preference). Double-click resets to the default.
 */
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const STORAGE_KEY = 'cogseed:info-panel-width';
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 560;
  const DEFAULT_WIDTH = 336;

  function clamp(n) {
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  }

  function applyWidth(px) {
    document.documentElement.style.setProperty('--info-panel-width', px + 'px');
  }

  function loadSavedWidth() {
    try {
      const n = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10);
      return Number.isFinite(n) ? clamp(n) : null;
    } catch (_) { return null; }
  }

  function saveWidth(px) {
    try { localStorage.setItem(STORAGE_KEY, String(px)); } catch (_) { /* quota / private mode */ }
  }

  function init() {
    const saved = loadSavedWidth();
    if (saved != null) applyWidth(saved);

    const handle = document.getElementById('conversation-info-resize-handle');
    const panel = document.getElementById('conversation-info-panel');
    if (!handle || !panel) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    let pendingWidth = null;
    let rafId = 0;

    function flushWidth() {
      rafId = 0;
      if (pendingWidth == null) return;
      applyWidth(pendingWidth);
      pendingWidth = null;
    }

    function onMove(e) {
      if (!dragging) return;
      pendingWidth = clamp(startWidth + (startX - e.clientX));
      if (!rafId) rafId = requestAnimationFrame(flushWidth);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (pendingWidth != null) applyWidth(pendingWidth);
      pendingWidth = null;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      document.body.classList.remove('is-sidebar-resizing');
      handle.classList.remove('is-active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      document.documentElement.removeEventListener('mouseleave', onUp);
      saveWidth(Math.round(panel.getBoundingClientRect().width));
    }

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = panel.getBoundingClientRect().width;
      // Shared with the sidebar handle: window-wide col-resize cursor and
      // no iframe pointer events while dragging.
      document.body.classList.add('is-sidebar-resizing');
      handle.classList.add('is-active');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onUp);
      document.documentElement.addEventListener('mouseleave', onUp);
    });

    handle.addEventListener('dblclick', () => {
      applyWidth(DEFAULT_WIDTH);
      saveWidth(DEFAULT_WIDTH);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
