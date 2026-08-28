// Shared Button and IconButton HTML factories for classic renderer scripts.
// Callers supply product copy; icons always route through icons.js.
(function initUiButton(root) {
  'use strict';

  const BUTTON_ROLES = new Set(['primary', 'secondary', 'danger', 'ghost']);
  const BUTTON_SIZES = new Set(['md', 'sm']);
  const ICON_VARIANTS = new Set(['plain', 'danger']);

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderAttrs(attrs) {
    const safe = [];
    for (const [key, rawValue] of Object.entries(attrs || {})) {
      if (!/^(id|role|title|aria-[a-z-]+|data-[a-z0-9-]+)$/.test(key)) continue;
      if (rawValue == null || rawValue === false) continue;
      safe.push(`${key}="${escapeText(rawValue === true ? '' : rawValue)}"`);
    }
    return safe.length ? ` ${safe.join(' ')}` : '';
  }

  function renderIcon(name, className) {
    if (!name) return '';
    if (typeof root.uiIconHtml !== 'function') return '';
    return root.uiIconHtml(String(name), className);
  }

  function uiButton(options) {
    const value = options || {};
    const label = String(value.label || '').trim();
    if (!label) throw new TypeError('uiButton requires a visible label; use uiIconButton for icon-only controls');

    const role = BUTTON_ROLES.has(value.role) ? value.role : 'secondary';
    const size = BUTTON_SIZES.has(value.size) ? value.size : 'md';
    const loading = Boolean(value.loading);
    const disabled = Boolean(value.disabled) || loading;
    const classes = [
      'btn',
      'ui-button',
      `ui-button--${role}`,
      `ui-button--${size}`,
      loading ? 'is-loading' : '',
      disabled ? 'is-disabled' : '',
      value.className || '',
    ].filter(Boolean).join(' ');
    const attrs = {
      ...(value.attrs || {}),
      'aria-busy': loading ? 'true' : null,
    };

    return [
      `<button type="button" class="${escapeText(classes)}"${disabled ? ' disabled' : ''}${renderAttrs(attrs)}>`,
      loading ? '' : renderIcon(value.icon, 'ui-button__icon'),
      `<span class="ui-button__label">${escapeText(label)}</span>`,
      loading ? '' : renderIcon(value.iconEnd, 'ui-button__icon'),
      '</button>',
    ].join('');
  }

  function uiIconButton(options) {
    const value = options || {};
    const label = String(value.label || '').trim();
    const icon = String(value.icon || '').trim();
    if (!label) throw new TypeError('uiIconButton requires an accessible label');
    if (!icon) throw new TypeError('uiIconButton requires an icon name from icons.js');

    const variant = ICON_VARIANTS.has(value.variant) ? value.variant : 'plain';
    const disabled = Boolean(value.disabled);
    const classes = [
      'ui-icon-button',
      variant === 'danger' ? 'ui-icon-button--danger' : '',
      disabled ? 'is-disabled' : '',
      value.className || '',
    ].filter(Boolean).join(' ');
    const attrs = {
      ...(value.attrs || {}),
      'aria-label': label,
      title: value.title || label,
    };

    return `<button type="button" class="${escapeText(classes)}"${disabled ? ' disabled' : ''}${renderAttrs(attrs)}>${renderIcon(icon, '')}</button>`;
  }

  root.uiButton = uiButton;
  root.uiIconButton = uiIconButton;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { uiButton, uiIconButton };
  }
})(typeof window !== 'undefined' ? window : globalThis);
