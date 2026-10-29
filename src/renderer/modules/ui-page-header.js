// Shared PageHeader factory. It owns a compact single-row title contract and
// caps the action area at three secondary/sm controls so headers cannot become
// toolbars or introduce a separate primary-action hierarchy.
//
// Every top-level page header starts with the shell slot (specs/008-shell-
// rail-layout, D12/D13): `[shell][title][actions]`. The slot holds the
// sidebar expand + search controls and is shown by CSS only when the sidebar
// is collapsed or absent. Headers nested inside a page pass `shell: false`.
(function initUiPageHeader(root) {
  'use strict';

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uiPageHeader(options) {
    const value = options || {};
    const title = String(value.title || '').trim();
    if (!title) throw new TypeError('uiPageHeader requires a title');

    const actions = Array.isArray(value.actions) ? value.actions.slice(0, 3) : [];
    const actionHtml = actions.map((action) => root.uiButton({
      ...(action || {}),
      role: 'secondary',
      size: 'sm',
    })).join('');
    const meta = value.meta == null || value.meta === ''
      ? ''
      : `<span class="ui-page-header__meta">${escapeText(value.meta)}</span>`;
    const shell = value.shell === false || typeof root.uiShellHeaderSlot !== 'function'
      ? ''
      : root.uiShellHeaderSlot();
    return [
      '<header class="ui-page-header">',
      shell,
      '<div class="ui-page-header__body">',
      '<div class="ui-page-header__title-row">',
      `<h1 class="ui-page-header__title">${escapeText(title)}</h1>`,
      meta,
      '</div>',
      '</div>',
      actionHtml ? `<div class="ui-page-header__actions">${actionHtml}</div>` : '',
      '</header>',
    ].join('');
  }

  root.uiPageHeader = uiPageHeader;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiPageHeader };
})(typeof window !== 'undefined' ? window : globalThis);
