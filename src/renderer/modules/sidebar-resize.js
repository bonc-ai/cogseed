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
  const DEFAULT_WIDTH = 280;

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
    // rAF 节流：每次 mousemove 写 --sidebar-width 会触发 sidebar 的
    // container-query 同步重算布局，拖拽期间每帧写一次即可。
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
      const dx = e.clientX - startX;
      const next = clamp(startWidth + dx);
      pendingWidth = next;
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
      window.addEventListener('blur', onUp);
      document.documentElement.addEventListener('mouseleave', onUp);
    });

    handle.addEventListener('dblclick', () => {
      applyWidth(DEFAULT_WIDTH);
      saveWidth(DEFAULT_WIDTH);
    });
  }

  // ── 收起 / 展开侧边栏（specs/008-shell-rail-layout, D13）────────────────
  // 收起按钮在侧栏顶部行内；收起后展开入口在当前页面 header 的外壳位
  // （每个页面一份，无 id），统一按 `data-shell-action` 委托处理。按钮都是
  // header 行的真实子元素，不会被 macOS 原生拖拽区吞掉。
  const COLLAPSE_KEY = 'cogseed:sidebar-collapsed';

  // `shell-sidebar-hidden`: the user collapsed a sidebar this module has, so
  // page headers show their shell slot with the expand entry. Modules without
  // a sidebar (`shell-no-sidebar`) show the slot too, minus the expand entry.
  // The collapse preference itself stays one global value.
  function syncCollapseButton(collapsed) {
    const noSidebar = document.body.classList.contains('shell-no-sidebar');
    document.body.classList.toggle('shell-sidebar-hidden', collapsed && !noSidebar);
  }

  // Hover flyout: while collapsed, hovering the active rail entry shows the
  // sidebar as an overlay; it closes shortly after the pointer leaves both.
  const PEEK_CLOSE_DELAY = 250;
  let peekTimer = 0;

  function setPeek(on) {
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = 0; }
    document.body.classList.toggle('sidebar-peek', on);
  }

  function initPeek() {
    document.addEventListener('mouseover', (event) => {
      const body = document.body;
      if (!body.classList.contains('sidebar-collapsed') || body.classList.contains('shell-no-sidebar')) return;
      const t = event.target;
      if (!t || typeof t.closest !== 'function') return;
      const overTrigger = !!t.closest('.app-rail-btn.is-active[data-rail-module]');
      const overSidebar = !!t.closest('.sidebar');
      if (overTrigger || (overSidebar && body.classList.contains('sidebar-peek'))) {
        if (peekTimer) { clearTimeout(peekTimer); peekTimer = 0; }
        body.classList.add('sidebar-peek');
      } else if (body.classList.contains('sidebar-peek') && !peekTimer) {
        peekTimer = setTimeout(() => setPeek(false), PEEK_CLOSE_DELAY);
      }
    });
    document.documentElement.addEventListener('mouseleave', () => setPeek(false));
  }

  function applyCollapsed(collapsed) {
    setPeek(false);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    syncCollapseButton(collapsed);
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }

  window.syncSidebarShellState = () => {
    syncCollapseButton(document.body.classList.contains('sidebar-collapsed'));
  };

  // Keyboard users keep their place: focus follows the toggle to the control
  // that undoes it.
  function focusVisibleExpand() {
    const expand = Array.from(document.querySelectorAll('.panel.active [data-shell-action="expand-sidebar"]'))
      .find((el) => el.getClientRects().length > 0);
    expand?.focus();
  }

  function initCollapse() {
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (_) {}
    applyCollapsed(collapsed);
    document.addEventListener('click', (event) => {
      const control = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-shell-action="collapse-sidebar"], [data-shell-action="expand-sidebar"]')
        : null;
      if (!control) return;
      const collapse = control.dataset.shellAction === 'collapse-sidebar';
      applyCollapsed(collapse);
      if (collapse) focusVisibleExpand();
      else document.getElementById('sidebar-collapse-btn')?.focus();
    });
  }

  // 启动自愈：折叠态不应再占据布局宽度。若 class 与真实渲染宽度不一致
  // （半程状态 / 早前异常残留），页面资源加载完成后按 class 重新落实一次。
  // 仅按宽度判定，正常路径宽度与 class 一致则无任何动作，不影响既有交互。
  window.addEventListener('load', () => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    const w = sidebar.getBoundingClientRect().width;
    if ((collapsed && w > 1) || (!collapsed && w < 100)) {
      applyCollapsed(collapsed);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
    document.addEventListener('DOMContentLoaded', initCollapse, { once: true });
    document.addEventListener('DOMContentLoaded', initPeek, { once: true });
  } else {
    init();
    initCollapse();
    initPeek();
  }
})();
