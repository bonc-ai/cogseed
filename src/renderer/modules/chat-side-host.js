/**
 * Right-side panel host — owns the tab strip and shows exactly one pane.
 *
 * Why a host at all: the ask-aside thread and the file browser both want the
 * right side of the conversation view. Letting each be its own `<aside>` would
 * squeeze the conversation column whenever both are open, so they share one
 * column and switch by tab instead.
 *
 * Tabs are registered by their panes, and a tab is only visible once its pane
 * has content. That keeps an empty "Browser" tab from sitting in the strip
 * before the user has opened any file.
 *
 * Classic script, consistent with sibling renderer modules.
 */

/** paneId → { tabEl, paneEl, onActivate, onClose } */
const _sideTabs = new Map();
let _sideActive = null;

function _sideEl(id) { return document.getElementById(id); }

function _sideHost() { return _sideEl('chat-side-host'); }

/**
 * Register a pane. Called once per pane module at load time; registration alone
 * does not reveal the tab (see `setSideTabAvailable`).
 */
function registerSidePane(paneId, opts = {}) {
  const tabEl = _sideEl(`chat-side-tab-${paneId}`);
  const paneEl = _sideEl(opts.paneElId || `chat-side-${paneId}`);
  if (!tabEl || !paneEl) return false;
  _sideTabs.set(paneId, {
    tabEl,
    paneEl,
    onActivate: typeof opts.onActivate === 'function' ? opts.onActivate : null,
    onClose: typeof opts.onClose === 'function' ? opts.onClose : null,
  });
  if (tabEl.dataset.bound !== '1') {
    tabEl.dataset.bound = '1';
    tabEl.addEventListener('click', () => activateSidePane(paneId));
  }
  return true;
}

/** Show or hide a pane's tab. A pane with no content should not offer a tab. */
function setSideTabAvailable(paneId, available) {
  const entry = _sideTabs.get(paneId);
  if (!entry) return;
  entry.tabEl.hidden = !available;
  // The last available tab going away means nothing is left to show.
  if (!available && _sideActive === paneId) {
    const next = [..._sideTabs.keys()].find((id) => id !== paneId && !_sideTabs.get(id).tabEl.hidden);
    if (next) activateSidePane(next);
    else closeSideHost();
  }
}

function activateSidePane(paneId) {
  const entry = _sideTabs.get(paneId);
  if (!entry) return;
  const host = _sideHost();
  if (!host) return;
  entry.tabEl.hidden = false;
  host.hidden = false;
  for (const [id, item] of _sideTabs) {
    const on = id === paneId;
    item.paneEl.hidden = !on;
    item.tabEl.classList.toggle('is-active', on);
    item.tabEl.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  _sideActive = paneId;
  if (typeof applyDomI18n === 'function') applyDomI18n(host);
  if (entry.onActivate) {
    try { entry.onActivate(); } catch (_) { /* a pane hook must not break switching */ }
  }
}

/** Close the whole host. Each pane gets a chance to release in-flight work. */
function closeSideHost() {
  const host = _sideHost();
  if (host) host.hidden = true;
  for (const entry of _sideTabs.values()) {
    if (entry.onClose) {
      try { entry.onClose(); } catch (_) { /* keep closing the rest */ }
    }
  }
  _sideActive = null;
}

function isSideHostOpen() {
  const host = _sideHost();
  return !!host && !host.hidden;
}

function activeSidePane() { return _sideActive; }

function bindSideHost() {
  const close = _sideEl('chat-side-close');
  if (close && close.dataset.bound !== '1') {
    close.dataset.bound = '1';
    close.addEventListener('click', closeSideHost);
  }
  const wide = _sideEl('chat-side-wide');
  if (wide && wide.dataset.bound !== '1') {
    wide.dataset.bound = '1';
    wide.addEventListener('click', () => {
      const host = _sideHost();
      if (host) host.classList.toggle('is-wide');
    });
  }
  const host = _sideHost();
  if (host && host.dataset.keyBound !== '1') {
    host.dataset.keyBound = '1';
    // Escape closes the column, matching the fullscreen viewer and the md
    // drawer. Scoped to the host so it cannot swallow Escape from the main
    // composer, and ignored while a text field inside has focus so the key
    // still cancels IME composition first.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !isSideHostOpen()) return;
      const el = document.activeElement;
      if (el && host.contains(el) && /^(TEXTAREA|INPUT)$/.test(el.tagName || '')) return;
      closeSideHost();
    });
  }
  if (host && host.dataset.i18nBound !== '1') {
    host.dataset.i18nBound = '1';
    // Tab labels are `data-i18n`, so they need a re-render on language change;
    // without this the strip keeps the old language until the next activate.
    window.addEventListener('i18n-change', () => {
      if (typeof applyDomI18n === 'function') applyDomI18n(host);
    });
  }
}

/** Which tab should be visible given each pane's content state. Pure — tested. */
function computeVisibleSideTabs(state) {
  const out = [];
  for (const [id, has] of Object.entries(state || {})) {
    if (has) out.push(id);
  }
  return out;
}

/**
 * Which pane to activate after one becomes unavailable. Pure — tested.
 * Returns null when nothing is left, meaning the host should close.
 */
function nextSidePaneAfterClose(closingId, available) {
  const rest = (available || []).filter((id) => id !== closingId);
  return rest.length ? rest[0] : null;
}

if (typeof window !== 'undefined') {
  window.registerSidePane = registerSidePane;
  window.setSideTabAvailable = setSideTabAvailable;
  window.activateSidePane = activateSidePane;
  window.closeSideHost = closeSideHost;
  window.isSideHostOpen = isSideHostOpen;
  window.activeSidePane = activeSidePane;
  window.bindSideHost = bindSideHost;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeVisibleSideTabs, nextSidePaneAfterClose };
}
