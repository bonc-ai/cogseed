// Shared SegmentedControl HTML factory for compact mutually exclusive filters.
// Callers keep ownership of state and click handling through data attributes.
(function initUiSegmentedControl(root) {
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
      if (!/^(id|title|aria-[a-z-]+|data-[a-z0-9-]+)$/.test(key)) continue;
      if (rawValue == null || rawValue === false) continue;
      safe.push(`${key}="${escapeText(rawValue === true ? '' : rawValue)}"`);
    }
    return safe.length ? ` ${safe.join(' ')}` : '';
  }

  function uiSegmentedControl(options) {
    const value = options || {};
    const ariaLabel = String(value.ariaLabel || '').trim();
    const items = Array.isArray(value.items) ? value.items : [];
    const tablist = value.role === 'tablist';
    if (!ariaLabel) throw new TypeError('uiSegmentedControl requires an accessible label');
    if (!items.length) throw new TypeError('uiSegmentedControl requires at least one item');

    const selectedValue = value.value;
    const classes = ['ui-segmented-control', value.className || ''].filter(Boolean).join(' ');
    const buttons = items.map((rawItem, index) => {
      const item = typeof rawItem === 'string' ? { label: rawItem } : (rawItem || {});
      const label = String(item.label || '').trim();
      if (!label) throw new TypeError('uiSegmentedControl items require visible labels');
      const itemValue = Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : index;
      const selected = String(itemValue) === String(selectedValue);
      const selectionAttrs = tablist
        ? ` role="tab" aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}"`
        : ` aria-pressed="${selected ? 'true' : 'false'}"`;
      const count = item.count == null || item.count === ''
        ? ''
        : `<span class="ui-segmented-control__count">${escapeText(item.count)}</span>`;
      return [
        `<button type="button"${selectionAttrs}${item.disabled ? ' disabled' : ''}${renderAttrs(item.attrs)}>`,
        `<span class="ui-segmented-control__label">${escapeText(label)}</span>`,
        count,
        '</button>',
      ].join('');
    }).join('');

    return `<div class="${escapeText(classes)}" role="${tablist ? 'tablist' : 'group'}" aria-label="${escapeText(ariaLabel)}"${renderAttrs(value.attrs)}>${buttons}</div>`;
  }

  root.uiSegmentedControl = uiSegmentedControl;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiSegmentedControl };
})(typeof window !== 'undefined' ? window : globalThis);
