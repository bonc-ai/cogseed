// Shared sidebar UserMenu presentation.
//
// The host owns identity lookup, authentication, routing, and action handlers.
// This module only renders the trigger and menu structure used by the real
// sidebar footer and the component gallery.

(function initUiUserMenu(global) {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function iconHtml(name, className) {
    if (!name) return '';
    const html = typeof global.uiIconHtml === 'function'
      ? global.uiIconHtml(name, className)
      : '';
    return html || `<span class="${escapeHtml(className || 'ui-icon')}"></span>`;
  }

  function avatarHtml(avatar = {}) {
    const classes = ['hub-chip-avatar'];
    if (avatar.variant) classes.push(`is-${avatar.variant}`);
    const role = avatar.role ? ` data-chip-role="${escapeHtml(avatar.role)}"` : '';
    const content = avatar.text
      ? escapeHtml(avatar.text)
      : iconHtml(avatar.icon || 'user', 'hub-chip-avatar-icon');
    return `<span class="${classes.join(' ')}" aria-hidden="true"${role}>${content}</span>`;
  }

  function identityHtml(name, description, options = {}) {
    const nameRole = options.nameRole ? ` data-chip-role="${escapeHtml(options.nameRole)}"` : '';
    return `<span class="hub-chip-meta">
      <span class="hub-chip-name"${nameRole}>${escapeHtml(name)}</span>
      ${description ? `<span class="hub-chip-sub">${escapeHtml(description)}</span>` : ''}
    </span>`;
  }

  function uiUserMenuTrigger(options = {}) {
    const name = options.name || '';
    return `<button type="button" class="hub-chip" id="${escapeHtml(options.id || 'ui-user-menu-trigger')}"
      aria-label="${escapeHtml(options.ariaLabel || name)}" aria-haspopup="menu"
      aria-expanded="${options.open ? 'true' : 'false'}"${options.disabled ? ' disabled' : ''}>
      ${avatarHtml(options.avatar)}
      ${identityHtml(name, options.description, { nameRole: options.nameRole })}
      <span class="hub-chip-chev">${iconHtml('chevron-down')}</span>
    </button>`;
  }

  function uiUserMenuPanel(options = {}) {
    const items = Array.isArray(options.items) ? options.items : [];
    const note = options.note
      ? `<div class="hub-chip-menu-note">${iconHtml(options.note.icon || 'warning', 'hub-chip-menu-note-icon')}${escapeHtml(options.note.label)}</div>`
      : '';
    const header = options.header === false ? '' : `<div class="hub-chip-menu-head">
      ${avatarHtml(options.avatar)}
      ${identityHtml(options.name || '', options.description)}
    </div>`;
    const actions = items.map((item) => `${item.separatorBefore ? '<div class="hub-chip-menu-sep" role="separator"></div>' : ''}
      <button type="button" class="hub-chip-menu-item${item.danger ? ' is-danger' : ''}${item.active ? ' is-active' : ''}"
        data-chip-action="${escapeHtml(item.action)}" role="menuitem" tabindex="-1">
        ${iconHtml(item.icon, 'hub-chip-menu-item-icon')}${escapeHtml(item.label)}
      </button>`).join('');
    return `${header}${note}${actions}`;
  }

  global.uiUserMenuTrigger = uiUserMenuTrigger;
  global.uiUserMenuPanel = uiUserMenuPanel;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { uiUserMenuTrigger, uiUserMenuPanel };
  }
})(typeof window !== 'undefined' ? window : globalThis);
