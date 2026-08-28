// Shared Modal runtime for classic renderer scripts. Owns focus entry/trap/
// return, Escape handling, background scroll lock, and action settlement.
(function initUiModal(root) {
  'use strict';

  const MODAL_SIZES = new Set(['sm', 'md', 'lg']);
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  let modalSequence = 0;
  let openModalCount = 0;
  let previousBodyOverflow = '';

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function visibleFocusable(dialog) {
    return Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((element) => (
      !element.hidden
      && element.getAttribute('aria-hidden') !== 'true'
      && element.offsetParent !== null
    ));
  }

  function lockBody() {
    if (openModalCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.classList.add('ui-modal-open');
      document.body.style.overflow = 'hidden';
    }
    openModalCount += 1;
  }

  function unlockBody() {
    openModalCount = Math.max(0, openModalCount - 1);
    if (openModalCount === 0) {
      document.body.classList.remove('ui-modal-open');
      document.body.style.overflow = previousBodyOverflow;
    }
  }

  // Adopt an existing business dialog without replacing its DOM. This keeps
  // feature-owned fields and event wiring intact while centralizing the same
  // focus, Escape, scroll-lock, and focus-return behavior as uiModal().
  function uiModalController(options) {
    const value = options || {};
    const overlay = value.overlay;
    const dialog = value.dialog || (overlay && overlay.querySelector('[role="dialog"]'));
    if (!overlay || !dialog) throw new TypeError('uiModalController requires an overlay and dialog');

    let isOpen = false;
    let previousFocus = null;

    function searchIsOpen() {
      const search = document.getElementById('search-overlay');
      return Boolean(search && search.style.display !== 'none' && !search.hidden);
    }

    function closeTopPopover() {
      const openSelects = Array.from(dialog.querySelectorAll('.ai-select.open'));
      const openSelect = openSelects[openSelects.length - 1];
      if (openSelect) {
        const trigger = openSelect.querySelector('.ai-select-trigger');
        if (trigger && typeof trigger.click === 'function') trigger.click();
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
        return true;
      }
      const open = Array.from(dialog.querySelectorAll('[data-ui-modal-popover][data-open="true"]'));
      const popover = open[open.length - 1];
      if (!popover) return false;
      popover.dataset.open = 'false';
      popover.hidden = true;
      const triggerId = popover.getAttribute('data-trigger-id');
      const trigger = triggerId ? dialog.querySelector(`#${triggerId}`) : null;
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
      return true;
    }

    function onKeyDown(event) {
      if (event.isComposing || event.keyCode === 229) return;
      // Cmd/Ctrl+K owns its overlay and Escape path while it is visible.
      if (searchIsOpen()) return;
      if (event.key === 'Escape') {
        if (closeTopPopover()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (value.dismissible !== false) {
          event.preventDefault();
          event.stopImmediatePropagation();
          close('escape');
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = visibleFocusable(dialog);
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function open(trigger) {
      if (isOpen) return;
      isOpen = true;
      previousFocus = trigger || document.activeElement;
      overlay.dataset.uiModalRoot = 'true';
      overlay.hidden = false;
      overlay.style.display = 'flex';
      overlay.classList.add('open');
      lockBody();
      document.addEventListener('keydown', onKeyDown, true);
      const initial = typeof value.initialFocus === 'string'
        ? dialog.querySelector(value.initialFocus)
        : value.initialFocus;
      const fallback = initial || visibleFocusable(dialog)[0] || dialog;
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
      requestAnimationFrame(() => fallback.focus());
    }

    function close(reason, closeOptions) {
      if (!isOpen) return;
      isOpen = false;
      closeTopPopover();
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.classList.remove('open');
      overlay.style.display = 'none';
      overlay.hidden = true;
      unlockBody();
      const shouldRestoreFocus = !closeOptions || closeOptions.restoreFocus !== false;
      let returnTarget = previousFocus && document.contains(previousFocus) ? previousFocus : null;
      if (!returnTarget && value.fallbackFocus) {
        returnTarget = typeof value.fallbackFocus === 'function'
          ? value.fallbackFocus()
          : (typeof value.fallbackFocus === 'string'
              ? document.querySelector(value.fallbackFocus)
              : value.fallbackFocus);
      }
      if (shouldRestoreFocus && returnTarget && typeof returnTarget.focus === 'function') {
        returnTarget.focus();
      }
      if (typeof value.onClose === 'function') value.onClose(reason || 'close');
    }

    return {
      open,
      close,
      isOpen: () => isOpen,
      closeTopPopover,
      overlay,
      dialog,
    };
  }

  function uiModal(options) {
    const value = options || {};
    const title = String(value.title || '').trim();
    if (!title) throw new TypeError('uiModal requires a title');
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('uiModal requires a browser document');
    }

    const size = MODAL_SIZES.has(value.size) ? value.size : 'md';
    const dismissible = value.dismissible !== false;
    const closeLabel = String(value.closeLabel || '').trim();
    if (dismissible && !closeLabel) {
      throw new TypeError('uiModal requires a localized closeLabel when dismissible');
    }
    const dismissOnBackdrop = value.dismissOnBackdrop === true;
    const titleId = `ui-modal-title-${++modalSequence}`;
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay';
    overlay.dataset.uiModalRoot = 'true';

    const closeButton = dismissible
      ? root.uiIconButton({
          icon: 'x',
          label: closeLabel,
          attrs: { 'data-ui-modal-close': 'true' },
        })
      : '';
    const actions = Array.isArray(value.actions) ? value.actions : [];
    const actionHtml = actions.map((action, index) => root.uiButton({
      ...action,
      attrs: {
        ...(action.attrs || {}),
        'data-ui-modal-action': action.id == null ? String(index) : String(action.id),
      },
    })).join('');
    const description = value.description
      ? `<p class="ui-modal__description">${escapeText(value.description)}</p>`
      : '';
    const toneClass = value.tone === 'danger' ? ' ui-modal--danger' : '';

    overlay.innerHTML = [
      `<section class="ui-modal ui-modal--${size}${toneClass}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">`,
      '<header class="ui-modal__header">',
      '<div class="ui-modal__heading">',
      `<h2 class="ui-modal__title" id="${titleId}">${escapeText(title)}</h2>`,
      description,
      '</div>',
      closeButton,
      '</header>',
      `<div class="ui-modal__body">${value.bodyHtml || ''}</div>`,
      actionHtml ? `<footer class="ui-modal__footer">${actionHtml}</footer>` : '',
      '</section>',
    ].join('');

    const dialog = overlay.querySelector('.ui-modal');
    let settled = false;
    let resolvePromise;
    const result = new Promise((resolve) => { resolvePromise = resolve; });

    function close(resultValue, reason) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.removeEventListener('click', onClick);
      overlay.remove();
      unlockBody();
      if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) {
        previousFocus.focus();
      }
      resolvePromise({ value: resultValue, reason });
    }

    function closeTopPopover() {
      const open = Array.from(dialog.querySelectorAll('[data-ui-modal-popover][data-open="true"]'));
      const popover = open[open.length - 1];
      if (!popover) return false;
      popover.dataset.open = 'false';
      popover.hidden = true;
      const triggerId = popover.getAttribute('data-trigger-id');
      const trigger = triggerId ? dialog.querySelector(`#${triggerId}`) : null;
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
      return true;
    }

    function onKeyDown(event) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        if (closeTopPopover()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (dismissible) {
          event.preventDefault();
          close(null, 'escape');
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = visibleFocusable(dialog);
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onClick(event) {
      const closeControl = event.target.closest('[data-ui-modal-close]');
      if (closeControl && dismissible) {
        close(null, 'close');
        return;
      }
      const actionControl = event.target.closest('[data-ui-modal-action]');
      if (actionControl) {
        close(actionControl.dataset.uiModalAction, 'action');
        return;
      }
      if (event.target === overlay && dismissible && dismissOnBackdrop) {
        close(null, 'backdrop');
      }
    }

    lockBody();
    document.body.appendChild(overlay);
    overlay.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown, true);

    const initial = value.initialFocus
      ? dialog.querySelector(value.initialFocus)
      : dialog.querySelector('[autofocus]');
    const fallback = visibleFocusable(dialog)[0] || dialog;
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => (initial || fallback).focus());

    return Object.assign(result, { close, overlay, dialog });
  }

  root.uiModal = uiModal;
  root.uiModalController = uiModalController;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiModal, uiModalController };
})(typeof window !== 'undefined' ? window : globalThis);
