// Shared PageHeader factory. It owns a compact single-row title contract and
// caps the action area at three secondary/sm controls so headers cannot become
// toolbars or introduce a separate primary-action hierarchy.
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
    return [
      '<header class="ui-page-header">',
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
