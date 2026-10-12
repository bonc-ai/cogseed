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
    if (value.action && value.actions) throw new TypeError('uiResourceCard accepts either action or actions, not both');
    const usesLegacyAction = value.actions == null && Boolean(value.action);
    const actions = value.actions == null
      ? (value.action ? [value.action] : [])
      : value.actions;
    if (!Array.isArray(actions)) throw new TypeError('uiResourceCard actions must be an array');
    const icon = value.icon && typeof root.uiIconHtml === 'function'
      ? `<span class="ui-resource-card__icon">${root.uiIconHtml(value.icon)}</span>`
      : '';
    const description = value.description
      ? `<p class="ui-resource-card__description">${escapeText(value.description)}</p>`
      : '';
    let status = '';
    if (value.status && typeof value.status === 'object') {
      if (typeof root.uiStatusPill !== 'function') throw new TypeError('uiResourceCard semantic status requires uiStatusPill');
      status = `<div class="ui-resource-card__status">${root.uiStatusPill(value.status)}</div>`;
    } else if (value.status) {
      status = `<span class="ui-resource-card__status">${escapeText(value.status)}</span>`;
    }
    if (actions.length && typeof root.uiButton !== 'function') throw new TypeError('uiResourceCard actions require uiButton');
    const actionHtml = actions.map((action) => root.uiButton({
      label: action.label,
      role: action.role || (usesLegacyAction ? 'primary' : 'secondary'),
      size: action.size || 'sm',
      loading: action.loading,
      disabled: action.disabled,
      icon: action.icon,
      iconEnd: action.iconEnd,
      attrs: action.attrs,
    })).join('');
    const actionGroup = actionHtml ? `<div class="ui-resource-card__actions">${actionHtml}</div>` : '';
    const footer = status || actionGroup
      ? `<div class="ui-resource-card__footer">${status}${actionGroup}</div>`
      : '';
    const body = [
      `<div class="ui-resource-card__header">${icon}<div class="ui-resource-card__heading"><h3 class="ui-resource-card__title">${escapeText(title)}</h3></div></div>`,
      description,
      String(value.bodyHtml || ''),
      footer,
    ].join('');
    const className = ['ui-resource-card--standard', value.className || ''].filter(Boolean).join(' ');
    return uiCard({ ...value, className, bodyHtml: body });
  }

  root.uiCard = uiCard;
  root.uiResourceGrid = uiResourceGrid;
  root.uiResourceCard = uiResourceCard;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiCard, uiResourceGrid, uiResourceCard };
})(typeof window !== 'undefined' ? window : globalThis);
