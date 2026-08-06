/**
 * Ask-aside drawer — a read-only side thread for asking about the main
 * conversation.
 *
 * The user got a proposal in the task conversation and did not follow it.
 * Asking in the main thread derails the task; asking elsewhere loses context.
 * This drawer takes the third path: it receives the anchored context but its
 * Q/A never enters the main transcript.
 *
 * Read-only is STRUCTURAL, not a UI convention: `aside.askStream` calls the
 * model directly with no tools and never touches the group-chat bus (see
 * features/conversation_aside). This module therefore has no "are you sure"
 * guards around actions — there are no actions to guard.
 *
 * Classic script, consistent with sibling renderer modules: relies on the
 * globals `escapeHtml`, `t`, `renderMarkdown`, `uiConfirm` and `window.orkas`.
 */

/** Anchor of the current thread. null = nothing selected yet. */
let _asideAnchor = null;      // { msgId, index, excerpt }
let _asideCid = null;
let _asideProjectId = null;
let _asideStreaming = false;
/** Cancel handle for the in-flight ask, so closing/switching aborts cleanly. */
let _asideCancel = null;

function _asideEl(id) { return document.getElementById(id); }

function _asideMd(text) {
  // Reuse the chat markdown pipeline when present so explanations render code
  // blocks and lists the same way the main conversation does.
  if (typeof renderMarkdown === 'function') return renderMarkdown(String(text || ''));
  return escapeHtml(String(text || '')).replace(/\n/g, '<br>');
}

/** Build one Q/A block. Pure — exported for tests. */
function buildAsideTurnHtml(turn) {
  return `
    <div class="chat-aside-turn">
      <div class="chat-aside-q">${escapeHtml(turn.question || '')}</div>
      <div class="chat-aside-a markdown-body">${_asideMd(turn.answer)}</div>
    </div>`;
}

/** Build the whole thread body. Pure — exported for tests. */
function buildAsideBodyHtml(turns, opts = {}) {
  const rows = (turns || []).map(buildAsideTurnHtml).join('');
  const pending = opts.pendingQuestion
    ? `
      <div class="chat-aside-turn is-pending">
        <div class="chat-aside-q">${escapeHtml(opts.pendingQuestion)}</div>
        <div class="chat-aside-a markdown-body">${
  opts.pendingAnswer
    ? _asideMd(opts.pendingAnswer)
    : `<span class="muted">${escapeHtml(t('aside.thinking'))}</span>`
}</div>
      </div>`
    : '';
  if (!rows && !pending) {
    return `<div class="chat-aside-empty empty muted">${escapeHtml(t('aside.empty'))}</div>`;
  }
  return rows + pending;
}

/** Header line naming what this thread is about. Pure — exported for tests. */
function buildAsideAboutHtml(anchor) {
  if (!anchor || !anchor.excerpt) return '';
  return `<span class="chat-aside-about-label muted">${escapeHtml(t('aside.about'))}:</span> ${escapeHtml(anchor.excerpt)}`;
}

function _renderAsideAbout() {
  const el = _asideEl('chat-aside-about');
  if (!el) return;
  el.innerHTML = buildAsideAboutHtml(_asideAnchor);
  el.hidden = !_asideAnchor;
}

function _renderAsideBody(turns, pending) {
  const body = _asideEl('chat-aside-body');
  if (!body) return;
  body.innerHTML = buildAsideBodyHtml(turns, pending || {});
  // Keep the newest exchange in view; the user is reading top-down as it streams.
  body.scrollTop = body.scrollHeight;
}

let _asideTurns = [];

/** Load a conversation's aside thread. Called on open and on cid change. */
async function loadChatAside(cid, projectId) {
  _asideCid = cid || null;
  _asideProjectId = projectId || null;
  _asideTurns = [];
  if (!_asideCid) { _renderAsideBody([], {}); return; }
  const res = await window.orkas
    .invoke('aside.list', { cid: _asideCid, project_id: _asideProjectId })
    .catch(() => null);
  _asideTurns = (res && res.ok && res.turns) || [];
  _renderAsideBody(_asideTurns, {});
  _renderAsideAbout();
}

/** Open the drawer, optionally anchored to a specific message. */
function openChatAside(anchor) {
  const panel = _asideEl('chat-aside-panel');
  if (!panel) return;
  // Bind on first open rather than at startup: the drawer is opt-in, and this
  // keeps it out of the boot path entirely.
  bindChatAside();
  // A rendered bubble always has a msgId; msgIndex only exists for anchored
  // history reads. Accept the anchor when either locator is present.
  if (anchor && (anchor.msgId || (Number.isInteger(anchor.index) && anchor.index >= 0))) {
    _asideAnchor = {
      ...(anchor.msgId ? { msgId: String(anchor.msgId) } : {}),
      ...(Number.isInteger(anchor.index) && anchor.index >= 0 ? { index: anchor.index } : {}),
      excerpt: String(anchor.excerpt || '').slice(0, 200),
    };
  }
  panel.hidden = false;
  _renderAsideAbout();
  if (typeof applyDomI18n === 'function') applyDomI18n(panel);
  const input = _asideEl('chat-aside-input');
  if (input) input.focus();
}

function closeChatAside() {
  const panel = _asideEl('chat-aside-panel');
  if (panel) panel.hidden = true;
  // An in-flight ask is abandoned rather than left writing into a hidden panel.
  if (_asideCancel) { try { _asideCancel(); } catch { /* already settled */ } }
  _asideCancel = null;
  _asideStreaming = false;
}

function isChatAsideOpen() {
  const panel = _asideEl('chat-aside-panel');
  return !!panel && !panel.hidden;
}

async function _submitAside() {
  if (_asideStreaming) return;
  const input = _asideEl('chat-aside-input');
  const question = (input && input.value || '').trim();
  if (!question || !_asideCid) return;
  if (!_asideAnchor) {
    if (typeof uiAlert === 'function') uiAlert(t('aside.anchor_missing'));
    return;
  }

  _asideStreaming = true;
  input.value = '';
  let answer = '';
  _renderAsideBody(_asideTurns, { pendingQuestion: question, pendingAnswer: '' });

  // `window.orkas.stream` returns { promise, cancel } — not a thenable.
  const call = window.orkas.stream('aside.askStream', {
    cid: _asideCid,
    project_id: _asideProjectId,
    ...(_asideAnchor.msgId
      ? { anchor_msg_id: _asideAnchor.msgId }
      : { anchor_index: _asideAnchor.index }),
    question,
  }, (event) => {
    if (event.type === 'delta' && event.text) {
      answer += event.text;
      _renderAsideBody(_asideTurns, { pendingQuestion: question, pendingAnswer: answer });
    } else if (event.type === 'final' && event.turn) {
      _asideTurns = _asideTurns.concat([event.turn]);
      _renderAsideBody(_asideTurns, {});
    } else if (event.type === 'error') {
      _renderAsideBody(_asideTurns, {
        pendingQuestion: question,
        pendingAnswer: `${t('aside.failed')}: ${event.text || ''}`,
      });
    }
  });
  _asideCancel = call && typeof call.cancel === 'function' ? call.cancel : null;

  try { await call.promise; }
  catch { /* cancelled or failed — the panel already shows the outcome */ }
  finally {
    _asideStreaming = false;
    _asideCancel = null;
  }
}

async function _clearAside() {
  if (!_asideCid) return;
  const confirmed = typeof uiConfirm === 'function'
    ? await uiConfirm({ message: t('aside.clear_confirm') })
    : true;
  if (!confirmed) return;
  await window.orkas.invoke('aside.clear', { cid: _asideCid, project_id: _asideProjectId })
    .catch(() => null);
  _asideTurns = [];
  _renderAsideBody([], {});
}

function bindChatAside() {
  const form = _asideEl('chat-aside-form');
  if (form && form.dataset.bound !== '1') {
    form.dataset.bound = '1';
    form.addEventListener('submit', (event) => { event.preventDefault(); _submitAside(); });
  }
  const input = _asideEl('chat-aside-input');
  if (input && input.dataset.bound !== '1') {
    input.dataset.bound = '1';
    // Enter sends, Shift+Enter newlines — same convention as the main input.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        _submitAside();
      }
    });
  }
  const close = _asideEl('chat-aside-close');
  if (close && close.dataset.bound !== '1') {
    close.dataset.bound = '1';
    close.addEventListener('click', closeChatAside);
  }
  const clear = _asideEl('chat-aside-clear');
  if (clear && clear.dataset.bound !== '1') {
    clear.dataset.bound = '1';
    clear.addEventListener('click', () => { _clearAside(); });
  }
}

if (typeof window !== 'undefined') {
  window.openChatAside = openChatAside;
  window.closeChatAside = closeChatAside;
  window.isChatAsideOpen = isChatAsideOpen;
  window.loadChatAside = loadChatAside;
  window.bindChatAside = bindChatAside;
}

// Test seam: the builders are pure (inputs → HTML) and are asserted directly.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAsideTurnHtml, buildAsideBodyHtml, buildAsideAboutHtml };
}
