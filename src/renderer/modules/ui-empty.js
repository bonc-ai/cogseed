// Shared EmptyState factory. The three product types are explicit so callers
// cannot accidentally turn an informational state into a multi-action panel.
(function initUiEmpty(root) {
  'use strict';

  const EMPTY_KINDS = new Set(['quiet', 'explained', 'actionable']);

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uiEmptyState(options) {
    const value = options || {};
    const kind = EMPTY_KINDS.has(value.kind) ? value.kind : 'quiet';
    const title = String(value.title || '').trim();
    if (!title) throw new TypeError('uiEmptyState requires a title');
    if (kind === 'actionable' && (!value.action || typeof value.action !== 'object')) {
      throw new TypeError('actionable EmptyState requires exactly one action');
    }
    if (kind !== 'actionable' && value.action) {
      throw new TypeError('only actionable EmptyState accepts an action');
    }

    const icon = kind !== 'quiet' && value.icon && typeof root.uiIconHtml === 'function'
      ? `<div class="ui-empty-state__icon" aria-hidden="true">${root.uiIconHtml(String(value.icon), '')}</div>`
      : '';
    const hint = value.hint
      ? `<p class="ui-empty-state__hint">${escapeText(value.hint)}</p>`
      : '';
    const action = kind === 'actionable'
      ? `<div class="ui-empty-state__action">${root.uiButton({
          ...value.action,
          role: value.action.role || 'primary',
        })}</div>`
      : '';

    return [
      `<section class="ui-empty-state ui-empty-state--${kind}" data-empty-kind="${kind}">`,
      icon,
      `<h3 class="ui-empty-state__title">${escapeText(title)}</h3>`,
      hint,
      action,
      '</section>',
    ].join('');
  }

  root.uiEmptyState = uiEmptyState;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiEmptyState };
})(typeof window !== 'undefined' ? window : globalThis);
