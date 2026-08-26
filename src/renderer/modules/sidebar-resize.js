/**
 * Drag-to-resize for the left sidebar.
 *
 * Drives `--sidebar-width` on `<html>`; the CSS rule on `.sidebar` consumes it
 * and clamps with min-width / max-width as a second line of defense. Width
 * persists in localStorage so it survives reloads on this machine (machine-
 * local UI preference, not synced across devices — same shape as other layout
 * prefs like artifact-rail collapse state would be).
 *
 * Double-click on the handle resets to the default.
 */
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const STORAGE_KEY = 'cogseed:sidebar-width';
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 480;
  const DEFAULT_WIDTH = 260;

  function clamp(n) {
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    if (n < MIN_WIDTH) return MIN_WIDTH;
    if (n > MAX_WIDTH) return MAX_WIDTH;
    return n;
  }

  function applyWidth(px) {
    document.documentElement.style.setProperty('--sidebar-width', px + 'px');
  }

  function loadSavedWidth() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? clamp(n) : null;
    } catch (_) { return null; }
  }

  function saveWidth(px) {
    try { localStorage.setItem(STORAGE_KEY, String(px)); } catch (_) { /* quota / private mode */ }
  }

  function init() {
    const saved = loadSavedWidth();
    if (saved != null) applyWidth(saved);

    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.querySelector('.sidebar');
    if (!handle || !sidebar) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const next = clamp(startWidth + dx);
      applyWidth(next);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-sidebar-resizing');
      handle.classList.remove('is-active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Read back from the CSS var so we persist exactly the clamped value
      // we just rendered (covers the case where the pointer moved past the
      // limits during the drag).
      const cur = sidebar.getBoundingClientRect().width;
      saveWidth(Math.round(cur));
    }

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      document.body.classList.add('is-sidebar-resizing');
      handle.classList.add('is-active');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      applyWidth(DEFAULT_WIDTH);
      saveWidth(DEFAULT_WIDTH);
    });
  }

  // ── 收起侧边栏（窄图标条，Codex / WorkBuddy 风格）────────────────────
  // 点击 logo 行右侧的收起按钮切换 `body.sidebar-collapsed`（CSS 折叠成
  // 48px 窄条，只留图标）。状态持久化在 localStorage，折叠时隐藏拖拽把手。
  const COLLAPSE_KEY = 'cogseed:sidebar-collapsed';

  function applyCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const btn = document.getElementById('sidebar-collapse-btn');
    if (btn) {
      const key = collapsed ? 'sidebar.expand_title' : 'sidebar.collapse_title';
      const fallback = collapsed ? '展开侧边栏' : '收起侧边栏';
      const translated = typeof t === 'function' ? t(key) : key;
      btn.title = translated && translated !== key ? translated : fallback;
    }
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }

  function initCollapse() {
    const btn = document.getElementById('sidebar-collapse-btn');
    if (!btn) return;
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (_) {}
    applyCollapsed(collapsed);
    btn.addEventListener('click', () => {
      applyCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
    window.addEventListener('i18n-change', () => {
      applyCollapsed(document.body.classList.contains('sidebar-collapsed'));
    });
  }

  // 启动自愈：折叠态只应呈现在 48px 窄条。若 class 与真实渲染宽度不一致
  // （半程状态 / 早前异常残留），页面资源加载完成后按 class 重新落实一次。
  // 仅按宽度判定，正常路径宽度与 class 一致则无任何动作，不影响既有交互。
  window.addEventListener('load', () => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    const w = sidebar.getBoundingClientRect().width;
    if ((collapsed && w > 60) || (!collapsed && w < 100)) {
      applyCollapsed(collapsed);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
    document.addEventListener('DOMContentLoaded', initCollapse, { once: true });
  } else {
    init();
    initCollapse();
  }
})();
