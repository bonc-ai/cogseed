(function initUiCard(root) {
  'use strict';

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
      if (!/^(id|title|role|tabindex|aria-[a-z-]+|data-[a-z0-9-]+)$/.test(key)) continue;
      if (rawValue == null || rawValue === false) continue;
      safe.push(`${key}="${escapeText(rawValue === true ? '' : rawValue)}"`);
    }
    return safe.length ? ` ${safe.join(' ')}` : '';
  }

  function uiCard(options) {
    const value = options || {};
    const tag = value.tag === 'div' || value.tag === 'section' ? value.tag : 'article';
    const classes = [
      'ui-resource-card',
      value.layout === 'row' ? 'ui-resource-card--row' : '',
      value.readonly ? 'is-readonly' : '',
      value.disabled ? 'is-disabled' : '',
      value.className || '',
    ].filter(Boolean).join(' ');
    return `<${tag} class="${escapeText(classes)}"${renderAttrs(value.attrs)}>${String(value.bodyHtml || '')}</${tag}>`;
  }

  function uiResourceGrid(options) {
    const value = options || {};
    const classes = ['ui-resource-grid', value.className || ''].filter(Boolean).join(' ');
    return `<div class="${escapeText(classes)}"${renderAttrs(value.attrs)}>${String(value.bodyHtml || '')}</div>`;
  }

  function uiResourceCard(options) {
    const value = options || {};
    const title = String(value.title || '').trim();
    if (!title) throw new TypeError('uiResourceCard requires a title');
    const icon = value.icon && typeof root.uiIconHtml === 'function'
      ? `<span class="ui-resource-card__icon">${root.uiIconHtml(value.icon)}</span>`
      : '';
    const description = value.description
      ? `<p class="ui-resource-card__description">${escapeText(value.description)}</p>`
      : '';
    const status = value.status
      ? `<span class="ui-resource-card__status">${escapeText(value.status)}</span>`
      : '<span class="ui-resource-card__status"></span>';
    const action = value.action && typeof root.uiButton === 'function'
      ? root.uiButton({
        label: value.action.label,
        role: value.action.role || 'primary',
        size: value.action.size || 'sm',
        loading: value.action.loading,
        disabled: value.action.disabled,
        attrs: value.action.attrs,
      })
      : '';
    const body = [
      `<div class="ui-resource-card__header">${icon}<div class="ui-resource-card__heading"><h3 class="ui-resource-card__title">${escapeText(title)}</h3></div></div>`,
      description,
      String(value.bodyHtml || ''),
      `<div class="ui-resource-card__footer">${status}${action}</div>`,
    ].join('');
    return uiCard({ ...value, bodyHtml: body });
  }

  root.uiCard = uiCard;
  root.uiResourceGrid = uiResourceGrid;
  root.uiResourceCard = uiResourceCard;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiCard, uiResourceGrid, uiResourceCard };
})(typeof window !== 'undefined' ? window : globalThis);
