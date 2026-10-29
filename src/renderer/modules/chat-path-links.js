// ─── Clickable workspace files in chat replies ───
//
// Agents cite workspace files as inline code in many shapes: a bare file
// name (`纪要_v001.md`), a shortened path (`.../<conv dir>/<file>.md`), or an
// absolute path. Text alone can't tell a real file from a mention, so a
// `<code>` span only becomes a link after main resolves it to an existing
// file inside the file-action sandbox (`workspace.resolvePathHints`, batched
// per paint). Unresolved spans stay plain code — no dead links.
//
// Resolutions are cached per conversation: hits stick (painting the same
// reply again is synchronous), misses expire quickly because an agent often
// names a file before writing it. `{ fresh: true }` (reply finalize, history
// render) ignores cached misses.
//
// Block code (`pre code`) and code already inside a link are never touched.

(function () {
  const MAX_HINT_LENGTH = 1024;
  const MISS_TTL_MS = 5000;
  const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
  // Extension must start with a letter: rejects `v1.2`, `3.14`.
  const FILE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
  const SHORTENED_PREFIX_RE = /^(?:\.{3}|…|~|\.)?[\\/]/;

  const _cache = new Map(); // `${cid}\n${hint}` -> { path: string|null, at: number }
  const _inflight = new Map(); // same key -> Promise<void>

  // Pure: could this inline-code text name a file? Only a pre-filter — the
  // link appears after main confirms the file exists.
  function looksLikeFileHint(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (text.length < 3 || text.length > MAX_HINT_LENGTH) return false;
    if (/[\r\n\0]/.test(text) || URL_SCHEME_RE.test(text)) return false;
    const last = text.split(/[\\/]/).pop() || '';
    if (!FILE_EXT_RE.test(last) || last.length < 3) return false;
    if (!/[\\/]/.test(text)) return !/\s/.test(text);
    // Command lines (`cat a/b.md`): first token has no separator.
    const firstToken = text.split(/\s+/)[0];
    if (firstToken !== text && !SHORTENED_PREFIX_RE.test(text) && !/[\\/]/.test(firstToken)) return false;
    return true;
  }

  function _t(key, vars) {
    try {
      if (typeof t === 'function') {
        const v = t(key, vars);
        if (v && v !== key) return v;
      }
    } catch (_) { /* fall through */ }
    return '';
  }

  function _cidFor(code, fallback) {
    const owner = typeof code.closest === 'function' ? code.closest('[data-cid]') : null;
    const cid = owner && owner.dataset ? owner.dataset.cid : '';
    if (cid) return cid;
    if (fallback) return fallback;
    return typeof currentCid !== 'undefined' && currentCid ? currentCid : '';
  }

  function _key(cid, hint) { return `${cid}\n${hint}`; }

  function _cached(cid, hint, fresh) {
    const hit = _cache.get(_key(cid, hint));
    if (!hit) return undefined;
    if (hit.path) return hit.path;
    if (fresh || Date.now() - hit.at > MISS_TTL_MS) return undefined;
    return null;
  }

  function _markLink(code, absPath) {
    if (code.dataset.path === absPath) return;
    code.dataset.path = absPath;
    code.classList.add('chat-path-link');
    code.setAttribute('role', 'link');
    code.setAttribute('tabindex', '0');
    const title = _t('chat.produced_open');
    if (title) code.setAttribute('title', title);
  }

  async function _resolve(cid, hints) {
    const invoke = window.cogseed && typeof window.cogseed.invoke === 'function' ? window.cogseed.invoke : null;
    if (!invoke || !hints.length) return;
    let results = null;
    try {
      const res = await invoke.call(window.cogseed, 'workspace.resolvePathHints', { hints, ...(cid ? { cid } : {}) });
      results = res && res.results && typeof res.results === 'object' ? res.results : null;
    } catch (_) {
      results = null;
    }
    // A failed call caches nothing: the next paint retries.
    if (!results) return;
    const at = Date.now();
    for (const hint of hints) {
      const p = typeof results[hint] === 'string' && results[hint] ? results[hint] : null;
      _cache.set(_key(cid, hint), { path: p, at });
    }
  }

  // Returns a promise that settles once every candidate in `root` has been
  // resolved and marked (callers may ignore it).
  function decorateChatPathCodes(root, opts = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return Promise.resolve();
    const fresh = !!opts.fresh;
    const pending = new Map(); // cid -> Map(hint -> code[])
    const waits = [];
    for (const code of root.querySelectorAll('code')) {
      if (!code) continue;
      if (typeof code.closest === 'function' && code.closest('pre, a')) continue;
      const hint = String(code.textContent || '').trim();
      if (!looksLikeFileHint(hint)) continue;
      const cid = _cidFor(code, opts.cid);
      const cached = _cached(cid, hint, fresh);
      if (cached) { _markLink(code, cached); continue; }
      if (cached === null) continue;
      const k = _key(cid, hint);
      if (_inflight.has(k)) {
        waits.push(_inflight.get(k).then(() => {
          const p = _cached(cid, hint, false);
          if (p) _markLink(code, p);
        }));
        continue;
      }
      if (!pending.has(cid)) pending.set(cid, new Map());
      const byHint = pending.get(cid);
      if (!byHint.has(hint)) byHint.set(hint, []);
      byHint.get(hint).push(code);
    }
    for (const [cid, byHint] of pending) {
      const hints = Array.from(byHint.keys());
      const job = _resolve(cid, hints).finally(() => {
        for (const hint of hints) _inflight.delete(_key(cid, hint));
      });
      for (const hint of hints) _inflight.set(_key(cid, hint), job);
      waits.push(job.then(() => {
        for (const [hint, codes] of byHint) {
          const p = _cached(cid, hint, false);
          if (!p) continue;
          for (const code of codes) _markLink(code, p);
        }
      }));
    }
    return Promise.all(waits).then(() => undefined);
  }

  function _baseName(p) {
    return String(p || '').split(/[\\/]/).pop() || String(p || '');
  }

  function activateChatPathLink(code) {
    const absPath = code && code.dataset ? code.dataset.path : '';
    if (!absPath) return false;
    const cid = _cidFor(code);
    const name = _baseName(absPath);
    // The file may have been deleted since it resolved; drop the cached hit
    // so the next paint re-checks. The viewer reports the missing file itself.
    const hint = String(code.textContent || '').trim();
    if (hint) _cache.delete(_key(cid, hint));
    if (typeof openSideBrowser === 'function' && openSideBrowser(absPath, name, cid ? { cid } : {})) return true;
    if (typeof openChatFileViewer === 'function') {
      openChatFileViewer(absPath, name, cid ? { cid } : undefined);
      return true;
    }
    return false;
  }

  function _pathCodeFromEvent(ev) {
    const target = ev && ev.target;
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest('code.chat-path-link[data-path]');
  }

  function _bindDelegation(doc) {
    if (!doc || typeof doc.addEventListener !== 'function') return;
    doc.addEventListener('click', (ev) => {
      const code = _pathCodeFromEvent(ev);
      if (!code) return;
      // Let a drag-select inside the code span keep its selection.
      try {
        const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
        if (sel && !sel.isCollapsed && String(sel).trim()) return;
      } catch (_) { /* ignore */ }
      ev.preventDefault();
      activateChatPathLink(code);
    });
    doc.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
      const code = _pathCodeFromEvent(ev);
      if (!code) return;
      ev.preventDefault();
      activateChatPathLink(code);
    });
  }

  if (typeof window !== 'undefined') {
    window.decorateChatPathCodes = decorateChatPathCodes;
    window.activateChatPathLink = activateChatPathLink;
    if (typeof document !== 'undefined') _bindDelegation(document);
  }
})();
