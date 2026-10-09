// Shared Tabs factory and keyboard behavior for same-object view navigation.
// Business pages keep ownership of routing, data loading and panel rendering.
(function initUiTabs(root) {
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

  function uiTabs(options) {
    const value = options || {};
    const ariaLabel = String(value.ariaLabel || '').trim();
    const items = Array.isArray(value.items) ? value.items : [];
    if (!ariaLabel) throw new TypeError('uiTabs requires an accessible label');
    if (!items.length) throw new TypeError('uiTabs requires at least one item');

    const selectedValue = Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : 0;
    const classes = ['ui-tabs', value.className || ''].filter(Boolean).join(' ');
    const buttons = items.map((rawItem, index) => {
      const item = typeof rawItem === 'string' ? { label: rawItem } : (rawItem || {});
      const label = String(item.label || '').trim();
      if (!label) throw new TypeError('uiTabs items require visible labels');
      const itemValue = Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : index;
      const selected = String(itemValue) === String(selectedValue);
      const itemClasses = ['ui-tab', selected ? 'is-active' : '', item.className || ''].filter(Boolean).join(' ');
      const count = item.count == null || item.count === ''
        ? ''
        : `<span class="ui-tab__count">${escapeText(item.count)}</span>`;
      return [
        `<button type="button" class="${escapeText(itemClasses)}" role="tab" aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}" data-ui-tab="${escapeText(itemValue)}"${item.disabled ? ' disabled' : ''}${renderAttrs(item.attrs)}>`,
        `<span class="ui-tab__label">${escapeText(label)}</span>`,
        count,
        '</button>',
      ].join('');
    }).join('');

    return `<div class="${escapeText(classes)}" role="tablist" aria-label="${escapeText(ariaLabel)}" data-ui-tabs data-ui-tabs-value="${escapeText(selectedValue)}"${renderAttrs(value.attrs)}>${buttons}</div>`;
  }

  function enabledTabs(group) {
    return Array.from(group.querySelectorAll('[data-ui-tab]')).filter((tab) => (
      !tab.disabled && tab.getAttribute('aria-disabled') !== 'true'
    ));
  }

  function emitChange(group, tab, index) {
    const EventCtor = root.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (!EventCtor || typeof group.dispatchEvent !== 'function') return;
    group.dispatchEvent(new EventCtor('ui-tabs-change', {
      bubbles: true,
      detail: { value: tab.dataset.uiTab, index },
    }));
  }

  function activateTab(group, tab, options) {
    if (!tab || tab.disabled || tab.getAttribute('aria-disabled') === 'true') return false;
    const tabs = Array.from(group.querySelectorAll('[data-ui-tab]'));
    const enabled = enabledTabs(group);
    const index = enabled.indexOf(tab);
    if (index < 0) return false;
    const changed = tab.getAttribute('aria-selected') !== 'true';
    tabs.forEach((item) => {
      const selected = item === tab;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      item.tabIndex = selected ? 0 : -1;
    });
    group.dataset.uiTabsValue = tab.dataset.uiTab || '';
    if (options && options.focus && typeof tab.focus === 'function') tab.focus();
    if (typeof tab.scrollIntoView === 'function') tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (changed && (!options || options.emit !== false)) emitChange(group, tab, index);
    return changed;
  }

  function hydrateUiTabs(rootEl) {
    const scope = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return [];
    const groups = [];
    if (typeof scope.matches === 'function' && scope.matches('[data-ui-tabs]')) groups.push(scope);
    groups.push(...scope.querySelectorAll('[data-ui-tabs]'));
    groups.forEach((group) => {
      if (group.dataset.uiTabsHydrated === 'true') return;
      group.dataset.uiTabsHydrated = 'true';
      group.addEventListener('click', (event) => {
        const tab = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-ui-tab]')
          : null;
        if (!tab || !group.contains(tab)) return;
        activateTab(group, tab, { focus: false });
      });
      group.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        const current = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-ui-tab]')
          : null;
        if (!current || !group.contains(current)) return;
        const tabs = enabledTabs(group);
        const index = tabs.indexOf(current);
        if (index < 0) return;
        let next = null;
        if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
        else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === 'Home') next = tabs[0];
        else if (event.key === 'End') next = tabs[tabs.length - 1];
        else if (event.key === 'Enter' || event.key === ' ') next = current;
        if (!next) return;
        event.preventDefault();
        activateTab(group, next, { focus: true });
      });
    });
    return groups;
  }

  root.uiTabs = uiTabs;
  root.hydrateUiTabs = hydrateUiTabs;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiTabs, hydrateUiTabs };
})(typeof window !== 'undefined' ? window : globalThis);
