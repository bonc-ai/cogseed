// Bottom-docked integrated terminal panel (real PTY via node-pty + xterm.js).
//
// The top-right button slides this up from the bottom of the conversation
// pane, mirroring the Codex desktop terminal. Each tab is a real shell
// session: input goes to the backend PTY via `terminal.write`, output streams
// back via `terminal.stream` and renders in xterm.js.
//
// Toggle model = "A": the button shows/hides the panel WITHOUT destroying it —
// tabs and their live shells survive a hide/show cycle.
//
// Classic script (no import/export). Top-level `function` declarations are
// implicitly global so index.html can call `toggleTerminalPanel()`.

const _termLog =
  typeof createLogger === 'function' ? createLogger('terminal-panel') : console;

// tabId -> {
//   id, sessionId, title,
//   term (xterm.Terminal), fit (FitAddon), streamCancel,
//   viewEl, tabEl, opened (bool)
// }
const _termTabs = new Map();
let _termActiveId = null;
let _termSeq = 0;
let _termBound = false;
let _termResizeObserver = null;

// ── helpers ──────────────────────────────────────────────────────────────

function _termT(key, fallback, vars) {
  try {
    if (typeof t === 'function') {
      const v = t(key, vars);
      if (v && v !== key) return v;
    }
  } catch (_) {
    /* ignore */
  }
  return fallback;
}

function _termEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _termIcon(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className || 'ui-icon');
  }
  return '';
}

function _termPanelEl() {
  return document.getElementById('terminal-panel');
}

function _termToggleBtn() {
  return document.getElementById('chat-terminal-toggle');
}

// Publish the panel's live height to the conversation pane as `--terminal-height`
// so the (absolutely-positioned) chat composer can sit just above the terminal
// and the history keeps enough bottom padding. 0 when closed → no layout change.
function _termSyncHeight() {
  const panel = _termPanelEl();
  if (!panel) return;
  const pane = panel.closest('.chat-main-pane');
  if (!pane) return;
  const h = _termIsOpen() ? panel.offsetHeight : 0;
  pane.style.setProperty('--terminal-height', `${h}px`);
}

function _termHasXterm() {
  return typeof window !== 'undefined' && typeof window.Terminal === 'function';
}

function _termHasIpc() {
  return (
    typeof window !== 'undefined' &&
    window.cogseed &&
    typeof window.cogseed.invoke === 'function' &&
    typeof window.cogseed.stream === 'function'
  );
}

// xterm theme derived from the app's CSS variables (light/dark aware).
function _termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, dflt) => (cs.getPropertyValue(name) || '').trim() || dflt;
  const bg = v('--surface', '#ffffff');
  const fg = v('--text', '#161a26');
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: 'rgba(24,84,60,0.18)',
  };
}

// ── open / close (toggle model A: hide, don't destroy) ─────────────────────

function _termIsOpen() {
  const panel = _termPanelEl();
  return !!panel && !panel.hidden;
}

function _termSetOpen(open) {
  const panel = _termPanelEl();
  if (!panel) return;
  panel.hidden = !open;
  const btn = _termToggleBtn();
  if (btn) {
    btn.classList.toggle('is-active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (open) {
    if (_termTabs.size === 0) _termNewTab();
    // Fit + focus after layout settles; publish height so composer sits above.
    requestAnimationFrame(() => {
      _termSyncHeight();
      _termFitActive();
      _termFocusActive();
    });
  } else {
    // Closed → reset height so the composer returns to the bottom.
    _termSyncHeight();
  }
}

function toggleTerminalPanel() {
  _termSetOpen(!_termIsOpen());
}

function _termClosePanel() {
  _termSetOpen(false);
}

// ── tabs ───────────────────────────────────────────────────────────────────

function _termNewTab() {
  const panel = _termPanelEl();
  if (!panel) return null;
  _termSeq += 1;
  const id = `t${_termSeq}`;
  const tab = {
    id,
    sessionId: null,
    title: _termT('terminal_panel.tab_title', 'shell'),
    term: null,
    fit: null,
    streamCancel: null,
    viewEl: null,
    tabEl: null,
    opened: false,
  };
  _termTabs.set(id, tab);
  _termRenderChrome();
  _termActivate(id);
  return id;
}

function _termCloseTab(id) {
  const tab = _termTabs.get(id);
  if (!tab) return;
  _termDisposeTab(tab);
  _termTabs.delete(id);
  if (_termActiveId === id) {
    const remaining = Array.from(_termTabs.keys());
    _termActiveId = remaining.length ? remaining[remaining.length - 1] : null;
  }
  if (_termTabs.size === 0) {
    _termSetOpen(false);
  }
  _termRenderChrome();
  _termShowActiveView();
  _termFitActive();
  _termFocusActive();
}

function _termDisposeTab(tab) {
  try { tab.streamCancel && tab.streamCancel(); } catch (_) { /* ignore */ }
  if (tab.sessionId && _termHasIpc()) {
    window.cogseed.invoke('terminal.close', { session_id: tab.sessionId }).catch(() => {});
  }
  try { tab.term && tab.term.dispose(); } catch (_) { /* ignore */ }
  tab.term = null;
  tab.fit = null;
  tab.streamCancel = null;
}

function _termActivate(id) {
  if (!_termTabs.has(id)) return;
  _termActiveId = id;
  _termRenderChrome();
  _termShowActiveView();
  // Lazily open the shell the first time this tab becomes active.
  const tab = _termTabs.get(id);
  if (tab && !tab.opened) _termOpenSession(tab);
  requestAnimationFrame(() => {
    _termFitActive();
    _termFocusActive();
  });
}

function _termFocusActive() {
  const tab = _termActiveId && _termTabs.get(_termActiveId);
  if (tab && tab.term) {
    try { tab.term.focus(); } catch (_) { /* ignore */ }
  }
}

function _termFitActive() {
  const tab = _termActiveId && _termTabs.get(_termActiveId);
  if (tab && tab.fit && tab.term) {
    try {
      tab.fit.fit();
      if (tab.sessionId && _termHasIpc()) {
        window.cogseed.invoke('terminal.resize', {
          session_id: tab.sessionId,
          cols: tab.term.cols,
          rows: tab.term.rows,
        }).catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }
}

// ── DOM chrome (tab bar + view containers) ─────────────────────────────────

function _termRenderChrome() {
  const panel = _termPanelEl();
  if (!panel) return;

  // Build tab bar fresh each time; view containers are created lazily and
  // reused (we don't rebuild xterm DOM on every chrome render).
  let bar = panel.querySelector('.terminal-tabbar');
  let body = panel.querySelector('.terminal-body');
  if (!bar || !body) {
    panel.innerHTML =
      '<div class="terminal-tabbar"></div><div class="terminal-body"></div>';
    bar = panel.querySelector('.terminal-tabbar');
    body = panel.querySelector('.terminal-body');
  }

  const tabsHtml = Array.from(_termTabs.values())
    .map((tab) => {
      const active = tab.id === _termActiveId ? ' is-active' : '';
      return (
        `<div class="terminal-tab${active}" data-term-tab="${_termEsc(tab.id)}" role="tab" tabindex="0">` +
        `<span class="terminal-tab-icon">${_termIcon('terminal', 'terminal-tab-icon-svg')}</span>` +
        `<span class="terminal-tab-title">${_termEsc(tab.title)}</span>` +
        `<button type="button" class="terminal-tab-close" data-term-close-tab="${_termEsc(tab.id)}" ` +
        `title="${_termEsc(_termT('terminal_panel.close_tab', 'Close tab'))}" ` +
        `aria-label="${_termEsc(_termT('terminal_panel.close_tab', 'Close tab'))}">` +
        `${_termIcon('x', 'terminal-tab-close-svg')}</button>` +
        `</div>`
      );
    })
    .join('');

  bar.innerHTML =
    `<div class="terminal-tabs" role="tablist">${tabsHtml}</div>` +
    `<button type="button" class="terminal-newtab" data-term-new ` +
    `title="${_termEsc(_termT('terminal_panel.new_tab', 'New terminal'))}" ` +
    `aria-label="${_termEsc(_termT('terminal_panel.new_tab', 'New terminal'))}">${_termIcon('plus', 'terminal-newtab-svg')}</button>` +
    `<div class="terminal-tabbar-spacer"></div>` +
    `<button type="button" class="terminal-close-panel" data-term-close-panel ` +
    `title="${_termEsc(_termT('terminal_panel.close_panel', 'Close terminal'))}" ` +
    `aria-label="${_termEsc(_termT('terminal_panel.close_panel', 'Close terminal'))}">${_termIcon('x', 'terminal-close-panel-svg')}</button>`;

  // Ensure a view container exists for each tab.
  for (const tab of _termTabs.values()) {
    if (!tab.viewEl || !body.contains(tab.viewEl)) {
      const view = document.createElement('div');
      view.className = 'terminal-view';
      view.dataset.termView = tab.id;
      body.appendChild(view);
      tab.viewEl = view;
    }
    tab.tabEl = bar.querySelector(`[data-term-tab="${tab.id}"]`);
  }
  // Remove orphan view containers (closed tabs).
  body.querySelectorAll('.terminal-view').forEach((el) => {
    if (!_termTabs.has(el.dataset.termView)) el.remove();
  });
}

function _termShowActiveView() {
  const body = _termPanelEl()?.querySelector('.terminal-body');
  if (!body) return;
  body.querySelectorAll('.terminal-view').forEach((el) => {
    el.hidden = el.dataset.termView !== _termActiveId;
  });
}

// ── PTY session lifecycle ──────────────────────────────────────────────────

async function _termOpenSession(tab) {
  tab.opened = true;

  if (!_termHasXterm()) {
    _termRenderUnavailable(tab, _termT('terminal_panel.no_xterm', 'terminal renderer unavailable'));
    return;
  }

  // Create xterm instance.
  const term = new window.Terminal({
    cursorStyle: 'bar',
    cursorBlink: true,
    fontFamily: (getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || '').trim()
      || 'ui-monospace, Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.2,
    letterSpacing: 0,
    allowProposedApi: true,
    theme: _termTheme(),
  });
  tab.term = term;

  // FitAddon (vendored global is FitAddon.FitAddon).
  try {
    const FitCtor = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
    if (FitCtor) {
      tab.fit = new FitCtor();
      term.loadAddon(tab.fit);
    }
  } catch (_) { /* fit optional */ }

  term.open(tab.viewEl);

  // Input → backend PTY.
  term.onData((data) => {
    if (tab.sessionId && _termHasIpc()) {
      window.cogseed.invoke('terminal.write', { session_id: tab.sessionId, data }).catch(() => {});
    }
  });

  if (!_termHasIpc()) {
    term.writeln(_termT('terminal_panel.no_ipc', '\x1b[31m[terminal backend unavailable]\x1b[0m'));
    return;
  }

  // Create backend PTY session sized to the fitted terminal.
  try {
    if (tab.fit) tab.fit.fit();
    const res = await window.cogseed.invoke('terminal.create', {
      cols: term.cols,
      rows: term.rows,
    });
    if (!res || res.ok === false || !res.session) {
      term.writeln(`\x1b[31m[failed to start terminal: ${_termEsc((res && res.error) || 'unknown')}]\x1b[0m`);
      return;
    }
    tab.sessionId = res.session.session_id;
  } catch (err) {
    term.writeln(`\x1b[31m[failed to start terminal: ${_termEsc(err && err.message)}]\x1b[0m`);
    return;
  }

  // Open the output stream.
  const { promise, cancel } = window.cogseed.stream(
    'terminal.stream',
    { session_id: tab.sessionId },
    (ev) => {
      if (!ev) return;
      if (ev.type === 'output' && typeof ev.data === 'string') {
        term.write(ev.data);
      } else if (ev.type === 'exit') {
        term.writeln(`\r\n\x1b[90m[process exited${ev.exit_code != null ? ' with code ' + ev.exit_code : ''}]\x1b[0m`);
      }
    },
  );
  tab.streamCancel = cancel;
  promise.catch(() => { /* cancelled / ended */ });

  if (_termLog && typeof _termLog.info === 'function') {
    _termLog.info('terminal session opened', { sessionId: tab.sessionId });
  }
}

function _termRenderUnavailable(tab, msg) {
  if (tab.viewEl) {
    tab.viewEl.innerHTML =
      `<div class="terminal-unavailable">${_termEsc(msg)}</div>`;
  }
}

// ── event delegation ───────────────────────────────────────────────────────

function _termOnClick(e) {
  const closeTabBtn = e.target.closest && e.target.closest('[data-term-close-tab]');
  if (closeTabBtn) {
    e.stopPropagation();
    _termCloseTab(closeTabBtn.getAttribute('data-term-close-tab'));
    return;
  }
  if (e.target.closest && e.target.closest('[data-term-new]')) {
    _termNewTab();
    return;
  }
  if (e.target.closest && e.target.closest('[data-term-close-panel]')) {
    _termClosePanel();
    return;
  }
  const tabEl = e.target.closest && e.target.closest('[data-term-tab]');
  if (tabEl) {
    _termActivate(tabEl.getAttribute('data-term-tab'));
  }
}

// ── binding ────────────────────────────────────────────────────────────────

function _termBind() {
  if (_termBound) return;
  const btn = _termToggleBtn();
  const panel = _termPanelEl();
  if (!btn || !panel) return; // conversation view not mounted yet
  _termBound = true;

  btn.addEventListener('click', () => toggleTerminalPanel());
  panel.addEventListener('click', _termOnClick);

  // Global toggle shortcut: Cmd/Ctrl + backtick (like VS Code's Ctrl+`).
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === '`' || e.code === 'Backquote')) {
      e.preventDefault();
      toggleTerminalPanel();
    }
  });

  // Refit the active terminal when the panel resizes.
  if (typeof ResizeObserver === 'function') {
    _termResizeObserver = new ResizeObserver(() => {
      if (_termIsOpen()) { _termSyncHeight(); _termFitActive(); }
    });
    _termResizeObserver.observe(panel);
  }

  // Re-render tab chrome labels on locale change.
  window.addEventListener('i18n-change', () => {
    if (_termTabs.size) _termRenderChrome();
  });

  if (_termLog && typeof _termLog.info === 'function') {
    _termLog.info('terminal-panel bound (real PTY)');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _termBind);
} else {
  _termBind();
}
