/**
 * Side file-browser pane — previews a local file next to the conversation.
 *
 * Local files only. There is deliberately no address bar, and the frame markup
 * comes from `chat-file-viewer.js`'s shared builder (`allow-scripts` sandbox
 * over `chat-media://`), so this pane cannot reach the open web and cannot
 * drift from the fullscreen viewer on security.
 *
 * No forward/back: the frame is cross-origin, so its navigation history is not
 * readable. For single local files that history is also meaningless.
 *
 * Classic script — relies on the globals `t`, `escapeHtml`, `uiAlert`,
 * `renderFilePreviewInto`, `previewKindOf`, `isSidePreviewableKind`, and the
 * side host API from `chat-side-host.js`.
 */

/** Current file, so reload / reveal / fullscreen know what they act on. */
let _sbFile = null;      // { absPath, name, cid, projectId, kind }
let _sbZoom = 1;

const SB_ZOOM_MIN = 0.5;
const SB_ZOOM_MAX = 2;
const SB_ZOOM_STEP = 0.1;

function _sbEl(id) { return document.getElementById(id); }

function _sbT(key, fallback) {
  try { if (typeof t === 'function') { const v = t(key); if (v && v !== key) return v; } } catch (_) { /* pre-i18n */ }
  return fallback;
}

/** Clamp a zoom factor to the supported range. Pure — exported for tests. */
function clampSideZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(SB_ZOOM_MAX, Math.max(SB_ZOOM_MIN, Math.round(n * 100) / 100));
}

/** Zoom label shown on the reset button. Pure — exported for tests. */
function formatSideZoom(value) {
  return `${Math.round(clampSideZoom(value) * 100)}%`;
}

function _applySideZoom() {
  const wrap = _sbEl('chat-side-browser-body')?.querySelector('.chat-side-browser-zoom');
  if (wrap) {
    wrap.style.transform = _sbZoom === 1 ? '' : `scale(${_sbZoom})`;
    // Counter-size so the scaled content still fills (and scrolls within) the
    // pane instead of leaving dead space at 50%.
    wrap.style.width = _sbZoom === 1 ? '100%' : `${100 / _sbZoom}%`;
    wrap.style.height = _sbZoom === 1 ? '100%' : `${100 / _sbZoom}%`;
  }
  const reset = _sbEl('chat-side-browser-zoom-reset');
  if (reset) reset.textContent = formatSideZoom(_sbZoom);
}

function _setSideZoom(next) {
  _sbZoom = clampSideZoom(next);
  _applySideZoom();
}

function _renderSideBrowserEmpty(messageKey, fallback) {
  const body = _sbEl('chat-side-browser-body');
  if (!body) return;
  body.innerHTML = `<div class="chat-side-browser-empty empty muted">${escapeHtml(_sbT(messageKey, fallback))}</div>`;
}

/**
 * Open a local file in the side pane. Returns false when the kind is not
 * something this pane renders, so the caller can fall back to the fullscreen
 * viewer instead of leaving the user with an empty panel.
 */
function openSideBrowser(absPath, displayName, opts = {}) {
  const body = _sbEl('chat-side-browser-body');
  if (!body || !absPath) return false;
  const name = displayName || String(absPath).split('/').pop() || '';
  const kind = typeof previewKindOf === 'function' ? previewKindOf(name) : '';
  if (typeof isSidePreviewableKind === 'function' && !isSidePreviewableKind(kind)) return false;

  bindSideBrowser();
  _sbFile = { absPath, name, cid: opts.cid || '', projectId: opts.projectId || '', kind };
  _sbZoom = 1;

  const nameEl = _sbEl('chat-side-browser-name');
  if (nameEl) {
    nameEl.textContent = name;
    nameEl.title = name;
  }

  // The zoom wrapper is ours; the frame inside comes from the shared builder.
  body.innerHTML = '<div class="chat-side-browser-zoom"></div>';
  const wrap = body.querySelector('.chat-side-browser-zoom');
  const ok = typeof renderFilePreviewInto === 'function'
    && renderFilePreviewInto(wrap, absPath, name, { kind });
  if (!ok) {
    _renderSideBrowserEmpty('sideBrowser.unsupported', 'This file type cannot be previewed');
    return false;
  }
  _applySideZoom();

  if (typeof setSideTabAvailable === 'function') setSideTabAvailable('browser', true);
  if (typeof activateSidePane === 'function') activateSidePane('browser');
  return true;
}

function closeSideBrowser() {
  const body = _sbEl('chat-side-browser-body');
  // Drop the frame so a hidden pane stops holding the file / running its scripts.
  if (body) body.innerHTML = '';
  _sbFile = null;
  if (typeof setSideTabAvailable === 'function') setSideTabAvailable('browser', false);
}

function _reloadSideBrowser() {
  if (!_sbFile) return;
  const keepZoom = _sbZoom;
  openSideBrowser(_sbFile.absPath, _sbFile.name, {
    cid: _sbFile.cid,
    projectId: _sbFile.projectId,
  });
  _setSideZoom(keepZoom);
}

function _sideBrowserFullscreen() {
  if (!_sbFile || typeof openChatFileViewer !== 'function') return;
  const opts = {};
  if (_sbFile.cid) opts.cid = _sbFile.cid;
  if (_sbFile.projectId) opts.projectId = _sbFile.projectId;
  openChatFileViewer(_sbFile.absPath, _sbFile.name, opts);
}

async function _revealSideBrowserFile() {
  if (!_sbFile) return;
  try {
    const payload = { path: _sbFile.absPath };
    if (_sbFile.cid) payload.cid = _sbFile.cid;
    if (_sbFile.projectId) payload.projectId = _sbFile.projectId;
    // Main re-validates the path against the workspace / attachment / project
    // scope; the renderer never gets to reveal an arbitrary location.
    await window.orkas.invoke('workspace.revealPath', payload);
  } catch (err) {
    if (typeof uiAlert === 'function') uiAlert(String(err && err.message || err));
  }
}

function bindSideBrowser() {
  if (typeof bindSideHost === 'function') bindSideHost();
  if (typeof registerSidePane === 'function') {
    registerSidePane('browser', {
      paneElId: 'chat-side-browser',
      // Closing the column must not leave a frame running behind a hidden pane.
      onClose: () => {
        const body = _sbEl('chat-side-browser-body');
        if (body) body.innerHTML = '';
        _sbFile = null;
      },
    });
  }
  const wire = (id, fn) => {
    const el = _sbEl(id);
    if (el && el.dataset.bound !== '1') {
      el.dataset.bound = '1';
      el.addEventListener('click', fn);
    }
  };
  wire('chat-side-browser-reload', _reloadSideBrowser);
  wire('chat-side-browser-zoom-in', () => _setSideZoom(_sbZoom + SB_ZOOM_STEP));
  wire('chat-side-browser-zoom-out', () => _setSideZoom(_sbZoom - SB_ZOOM_STEP));
  wire('chat-side-browser-zoom-reset', () => _setSideZoom(1));
  wire('chat-side-browser-fullscreen', _sideBrowserFullscreen);
  wire('chat-side-browser-reveal', () => { _revealSideBrowserFile(); });
}

if (typeof window !== 'undefined') {
  window.openSideBrowser = openSideBrowser;
  window.closeSideBrowser = closeSideBrowser;
  window.bindSideBrowser = bindSideBrowser;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { clampSideZoom, formatSideZoom, SB_ZOOM_MIN, SB_ZOOM_MAX };
}
