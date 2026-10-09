(function initUiStructure(root) {
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

  function uiDataTable(options) {
    const value = options || {};
    const label = String(value.label || '').trim();
    const columns = Array.isArray(value.columns) ? value.columns : [];
    const rows = Array.isArray(value.rows) ? value.rows : [];
    if (!label) throw new TypeError('uiDataTable requires an accessible label');
    if (!columns.length) throw new TypeError('uiDataTable requires columns');
    const headers = columns.map((column) => {
      const key = String(column.key || '').trim();
      const text = String(column.label || '').trim();
      if (!key || !text) throw new TypeError('uiDataTable columns require key and label');
      const sorted = String(value.sortKey || '') === key;
      const ariaSort = sorted ? (Number(value.sortDir) === -1 ? 'descending' : 'ascending') : 'none';
      const content = column.sortable
        ? `<button type="button" class="ui-data-table__sort" data-ui-table-sort="${escapeText(key)}">${escapeText(text)}<span aria-hidden="true">${sorted ? (Number(value.sortDir) === -1 ? '↓' : '↑') : '↕'}</span></button>`
        : escapeText(text);
      return `<th scope="col" class="${column.align === 'right' ? 'is-right' : ''}${column.primary ? ' is-primary' : ''}" aria-sort="${ariaSort}"${column.width ? ` style="width:${escapeText(column.width)}"` : ''}>${content}</th>`;
    }).join('');
    const body = rows.map((row, rowIndex) => {
      const selected = Number(value.selectedIndex) === rowIndex;
      const cells = columns.map((column) => `<td class="${column.align === 'right' ? 'is-right' : ''}${column.primary ? ' is-primary' : ''}">${escapeText(row[column.key] == null ? '' : row[column.key])}</td>`).join('');
      return `<tr${selected ? ' class="is-selected" aria-selected="true"' : ''} data-ui-table-row="${rowIndex}">${cells}</tr>`;
    }).join('');
    const classes = ['ui-data-table-wrap', value.className || ''].filter(Boolean).join(' ');
    return `<div class="${escapeText(classes)}"${renderAttrs(value.attrs)}><table class="ui-data-table" aria-label="${escapeText(label)}"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function uiAccordion(options) {
    const value = options || {};
    const items = Array.isArray(value.items) ? value.items : [];
    if (!items.length) throw new TypeError('uiAccordion requires items');
    const open = new Set(Array.isArray(value.defaultOpen) ? value.defaultOpen.map(Number) : [0]);
    const rows = items.map((item, index) => {
      const title = String(item && item.title || '').trim();
      if (!title) throw new TypeError('uiAccordion items require titles');
      const meta = item.meta ? `<span class="ui-accordion__meta">${escapeText(item.meta)}</span>` : '';
      return `<details class="ui-accordion__item"${open.has(index) ? ' open' : ''}><summary><span class="ui-accordion__chevron" aria-hidden="true"></span><span class="ui-accordion__title">${escapeText(title)}</span>${meta}</summary><div class="ui-accordion__body">${String(item.bodyHtml || '')}</div></details>`;
    }).join('');
    const classes = ['ui-accordion', value.className || ''].filter(Boolean).join(' ');
    return `<div class="${escapeText(classes)}"${renderAttrs(value.attrs)}>${rows}</div>`;
  }

  function treeItems(items, level) {
    return items.map((item, index) => {
      const children = Array.isArray(item.children) ? item.children : [];
      const id = String(item.id == null ? `${level}-${index}` : item.id);
      const label = String(item.label || '').trim();
      if (!label) throw new TypeError('uiTree items require labels');
      const expanded = children.length ? item.expanded !== false : false;
      const selected = item.selected === true;
      const toggle = children.length
        ? `<button type="button" class="ui-tree__toggle" aria-label="${escapeText(label)}" aria-expanded="${expanded ? 'true' : 'false'}" data-ui-tree-toggle>${typeof root.uiIconHtml === 'function' ? root.uiIconHtml('chevron-right') : ''}</button>`
        : '<span class="ui-tree__spacer" aria-hidden="true"></span>';
      const childTree = children.length
        ? `<ul role="group"${expanded ? '' : ' hidden'}>${treeItems(children, level + 1)}</ul>`
        : '';
      return `<li role="treeitem" aria-level="${level}"${children.length ? ` aria-expanded="${expanded ? 'true' : 'false'}"` : ''}${selected ? ' aria-selected="true"' : ''} data-ui-tree-item="${escapeText(id)}">${toggle}<button type="button" class="ui-tree__label${selected ? ' is-selected' : ''}" data-ui-tree-select tabindex="${selected ? '0' : '-1'}">${escapeText(label)}</button>${childTree}</li>`;
    }).join('');
  }

  function uiTree(options) {
    const value = options || {};
    const label = String(value.ariaLabel || '').trim();
    const items = Array.isArray(value.items) ? value.items : [];
    if (!label) throw new TypeError('uiTree requires an accessible label');
    if (!items.length) throw new TypeError('uiTree requires items');
    const classes = ['ui-tree', value.className || ''].filter(Boolean).join(' ');
    return `<ul class="${escapeText(classes)}" role="tree" aria-label="${escapeText(label)}" data-ui-tree${renderAttrs(value.attrs)}>${treeItems(items, 1)}</ul>`;
  }

  function visibleTreeLabels(tree) {
    return Array.from(tree.querySelectorAll('[data-ui-tree-select]')).filter((label) => {
      let parent = label.parentElement;
      while (parent && parent !== tree) {
        if (parent.hidden) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function dispatchTreeEvent(tree, name, item, expanded) {
    const EventCtor = root.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (!EventCtor || typeof tree.dispatchEvent !== 'function') return;
    tree.dispatchEvent(new EventCtor(name, {
      bubbles: true,
      detail: { id: item.dataset.uiTreeItem, expanded },
    }));
  }

  function toggleTreeItem(tree, item, force) {
    const group = item && item.querySelector(':scope > [role="group"]');
    const toggle = item && item.querySelector(':scope > [data-ui-tree-toggle]');
    if (!group || !toggle) return false;
    const expanded = typeof force === 'boolean' ? force : item.getAttribute('aria-expanded') !== 'true';
    item.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    group.hidden = !expanded;
    dispatchTreeEvent(tree, 'ui-tree-toggle', item, expanded);
    return expanded;
  }

  function selectTreeItem(tree, label, emit) {
    const item = label && label.closest('[data-ui-tree-item]');
    if (!item) return;
    tree.querySelectorAll('[data-ui-tree-item]').forEach((entry) => entry.removeAttribute('aria-selected'));
    tree.querySelectorAll('[data-ui-tree-select]').forEach((entry) => {
      entry.classList.toggle('is-selected', entry === label);
      entry.tabIndex = entry === label ? 0 : -1;
    });
    item.setAttribute('aria-selected', 'true');
    if (typeof label.focus === 'function') label.focus();
    if (emit) dispatchTreeEvent(tree, 'ui-tree-change', item);
  }

  function hydrateUiTrees(rootEl) {
    const scope = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return [];
    const trees = [];
    if (typeof scope.matches === 'function' && scope.matches('[data-ui-tree]')) trees.push(scope);
    trees.push(...scope.querySelectorAll('[data-ui-tree]'));
    trees.forEach((tree) => {
      if (tree.dataset.uiTreeHydrated === 'true') return;
      tree.dataset.uiTreeHydrated = 'true';
      const labels = visibleTreeLabels(tree);
      if (!labels.some((label) => label.tabIndex === 0) && labels[0]) labels[0].tabIndex = 0;
      tree.addEventListener('click', (event) => {
        const toggle = event.target && event.target.closest ? event.target.closest('[data-ui-tree-toggle]') : null;
        if (toggle && tree.contains(toggle)) {
          toggleTreeItem(tree, toggle.closest('[data-ui-tree-item]'));
          return;
        }
        const label = event.target && event.target.closest ? event.target.closest('[data-ui-tree-select]') : null;
        if (label && tree.contains(label)) selectTreeItem(tree, label, true);
      });
      tree.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        const label = event.target && event.target.closest ? event.target.closest('[data-ui-tree-select]') : null;
        if (!label || !tree.contains(label)) return;
        const visible = visibleTreeLabels(tree);
        const index = visible.indexOf(label);
        const item = label.closest('[data-ui-tree-item]');
        let next = null;
        if (event.key === 'ArrowDown') next = visible[index + 1] || visible[0];
        else if (event.key === 'ArrowUp') next = visible[index - 1] || visible[visible.length - 1];
        else if (event.key === 'Home') next = visible[0];
        else if (event.key === 'End') next = visible[visible.length - 1];
        else if (event.key === 'ArrowRight') {
          if (item.getAttribute('aria-expanded') === 'false') toggleTreeItem(tree, item, true);
          else next = item.querySelector(':scope > [role="group"] > [data-ui-tree-item] > [data-ui-tree-select]');
        } else if (event.key === 'ArrowLeft') {
          if (item.getAttribute('aria-expanded') === 'true') toggleTreeItem(tree, item, false);
          else next = item.parentElement && item.parentElement.closest('[data-ui-tree-item]')?.querySelector(':scope > [data-ui-tree-select]');
        } else if (event.key === 'Enter' || event.key === ' ') {
          selectTreeItem(tree, label, true);
        } else return;
        event.preventDefault();
        if (next) selectTreeItem(tree, next, false);
      });
    });
    return trees;
  }

  root.uiDataTable = uiDataTable;
  root.uiAccordion = uiAccordion;
  root.uiTree = uiTree;
  root.hydrateUiTrees = hydrateUiTrees;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiDataTable, uiAccordion, uiTree, hydrateUiTrees };
})(typeof window !== 'undefined' ? window : globalThis);
