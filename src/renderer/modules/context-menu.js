// Shared menu runtime: cursor context menus and button-anchored dropdowns.
// Items: {label, onClick, icon?, disabled?, loading?, danger?, separatorBefore?, attrs?}.
// One menu at a time. Page callbacks own business state; this module owns
// placement, roving focus, IME-safe navigation and dismissal/focus return.
const _ctxMenuLog = createLogger('context-menu');
let _ctxMenuEl = null;
let _ctxMenuItems = [];
let _ctxMenuActiveIdx = -1;
let _ctxMenuTrigger = null;
let _ctxMenuOwner = null;
let _ctxMenuId = 0;

function showContextMenu(event, items, options = {}) {
  closeContextMenu(false);
  if (!Array.isArray(items)) return;
  _ctxMenuItems = items.filter((it) => it && typeof it.label === 'string' && typeof it.onClick === 'function');
  if (!_ctxMenuItems.length) return;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = `ui-menu-${++_ctxMenuId}`;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = _ctxMenuItems.map((it, idx) => (
    (it.separatorBefore ? '<div class="context-menu-separator" role="separator"></div>' : '')
    + uiButton({ label: it.label, icon: it.icon, role: it.danger ? 'danger' : 'ghost', size: 'sm',
      loading: it.loading, disabled: it.disabled, className: 'context-menu-item',
      attrs: { ...it.attrs, role: 'menuitem', 'data-context-menu-idx': idx },
    })
  )).join('');
  // A menu opened from a row inside a modal must sit above the modal overlay;
  // otherwise it opens correctly but is painted behind the dimmer.
  if (options.trigger && typeof options.trigger.closest === 'function'
    && options.trigger.closest('.ui-modal, .ui-dialog')) {
    menu.classList.add('context-menu--above-modal');
  }
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
  _ctxMenuOwner = options.owner || null;
  _ctxMenuTrigger = options.trigger || null;
  if (_ctxMenuTrigger) {
    _ctxMenuTrigger.setAttribute('aria-expanded', 'true');
    _ctxMenuTrigger.setAttribute('aria-controls', menu.id);
    menu.setAttribute('aria-labelledby', _ctxMenuTrigger.id || '');
    if (!_ctxMenuTrigger.id) {
      menu.removeAttribute('aria-labelledby');
      menu.setAttribute('aria-label', _ctxMenuTrigger.getAttribute('aria-label') || '');
    }
  }
  const bounds = menu.getBoundingClientRect();
  const anchor = _ctxMenuTrigger && _ctxMenuTrigger.getBoundingClientRect();
  const x = anchor ? anchor.right - bounds.width : (event.clientX || 0);
  const y = anchor ? anchor.bottom + 4 : (event.clientY || 0);
  const left = anchor ? x : (x + bounds.width > window.innerWidth - 8 ? x - bounds.width : x);
  const top = y + bounds.height > window.innerHeight - 8
    ? (anchor ? anchor.top - bounds.height - 4 : y - bounds.height) : y;
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
  menu.querySelectorAll('.context-menu-item').forEach((button) => {
    button.tabIndex = -1;
    const idx = Number(button.dataset.contextMenuIdx);
    button.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _activateContextMenuItem(idx); });
    button.addEventListener('mouseenter', () => { if (!button.disabled) _setActiveIdx(idx, false); });
    button.addEventListener('focus', () => _setActiveIdx(idx, false));
  });
  if (options.focus === 'first' || options.focus === 'last') {
    _moveContextMenuFocus(options.focus === 'first' ? 1 : -1, true);
  }
}

function closeContextMenu(restoreFocus = true) {
  if (!_ctxMenuEl) return;
  const trigger = _ctxMenuTrigger;
  const hadFocus = _ctxMenuEl.contains(document.activeElement);
  _ctxMenuEl.remove();
  _ctxMenuEl = null;
  _ctxMenuItems = [];
  _ctxMenuActiveIdx = -1;
  _ctxMenuTrigger = null;
  _ctxMenuOwner = null;
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    if (restoreFocus && hadFocus && trigger.isConnected) trigger.focus();
  }
}

function _setActiveIdx(idx, focus = true) {
  if (!_ctxMenuEl || !_ctxMenuItems[idx] || _ctxMenuItems[idx].disabled || _ctxMenuItems[idx].loading) return;
  _ctxMenuActiveIdx = idx;
  _ctxMenuEl.querySelectorAll('.context-menu-item').forEach((button, i) => {
    button.classList.toggle('is-active', i === idx);
    if (focus && i === idx) button.focus();
  });
}

function _moveContextMenuFocus(direction, edge = false) {
  let idx = edge || _ctxMenuActiveIdx < 0 ? (direction > 0 ? -1 : 0) : _ctxMenuActiveIdx;
  for (let count = 0; count < _ctxMenuItems.length; count++) {
    idx = (idx + direction + _ctxMenuItems.length) % _ctxMenuItems.length;
    if (!_ctxMenuItems[idx].disabled && !_ctxMenuItems[idx].loading) { _setActiveIdx(idx); return; }
  }
}

function _activateContextMenuItem(idx) {
  const item = _ctxMenuItems[idx];
  if (!item || item.disabled || item.loading) return;
  closeContextMenu();
  try { Promise.resolve(item.onClick()).catch((err) => _ctxMenuLog.warn('menu action failed', err)); }
  catch (err) { _ctxMenuLog.warn('menu action failed', err); }
}

function uiDropdownMenu({ trigger, items }) {
  const owner = {};
  const open = (focus = 'first') => {
    if (!trigger.isConnected || trigger.disabled) return;
    showContextMenu({}, typeof items === 'function' ? items() : items, { trigger, owner, focus });
  };
  const click = (e) => { e.stopPropagation(); if (_ctxMenuOwner === owner) closeContextMenu(); else open(); };
  const keydown = (e) => {
    if (e.isComposing || e.keyCode === 229 || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); open(e.key === 'ArrowUp' ? 'last' : 'first');
  };
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', click);
  trigger.addEventListener('keydown', keydown);
  return {
    open,
    close() { if (_ctxMenuOwner === owner) closeContextMenu(); },
    refresh() {
      if (_ctxMenuOwner !== owner) return;
      const idx = _ctxMenuActiveIdx;
      open();
      _setActiveIdx(idx);
    },
    destroy() {
      if (_ctxMenuOwner === owner) closeContextMenu();
      trigger.removeEventListener('click', click);
      trigger.removeEventListener('keydown', keydown);
    },
  };
}

document.addEventListener('mousedown', (e) => {
  if (!_ctxMenuEl || _ctxMenuEl.contains(e.target) || _ctxMenuTrigger?.contains(e.target)) return;
  closeContextMenu(false);
}, true);
document.addEventListener('keydown', (e) => {
  if (!_ctxMenuEl || e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation(); closeContextMenu();
  } else if (e.key === 'Tab') {
    // Return to the anchor, then let the native Tab order continue from it.
    closeContextMenu();
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); e.stopImmediatePropagation();
    _moveContextMenuFocus(e.key === 'ArrowUp' || e.key === 'End' ? -1 : 1, e.key === 'Home' || e.key === 'End');
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (_ctxMenuActiveIdx < 0) return;
    e.preventDefault(); e.stopImmediatePropagation(); _activateContextMenuItem(_ctxMenuActiveIdx);
  }
}, true);
window.addEventListener('scroll', (e) => { if (!_ctxMenuEl?.contains(e.target)) closeContextMenu(); }, true);
window.addEventListener('resize', () => closeContextMenu());
window.addEventListener('i18n-change', () => closeContextMenu());
window.showContextMenu = showContextMenu;
window.closeContextMenu = closeContextMenu;
window.uiDropdownMenu = uiDropdownMenu;
