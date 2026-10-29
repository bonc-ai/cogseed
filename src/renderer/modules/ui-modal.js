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
          if (typeof value.onRequestClose === 'function') value.onRequestClose('escape');
          else close('escape');
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
      if (event.key === 'Escape') {
        if (closeTopPopover()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (dismissible) {
          event.preventDefault();
          event.stopImmediatePropagation();
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

  // Shared async form dialog: bodyHtml contains one uiForm without actions. The
  // caller owns fields, validation, localized copy, requests and successful close.
  // Submit stays open; setBusy locks controls, setFeedback shows text-only errors.
  // update may replace business content; callers restore values/hydrate selects.
  // Focus, Escape, scroll locking and settlement remain uiModal's responsibility.
  function uiFormModal(options) {
    let value = { ...options };
    if (!String(value.submitLabel || '').trim() || !String(value.busyLabel || '').trim()) {
      throw new TypeError('uiFormModal requires localized submitLabel and busyLabel');
    }
    const modal = root.uiModal({ ...value, actions: [] });
    const formId = `ui-form-modal-${++modalSequence}`;
    const body = modal.dialog.querySelector('.ui-modal__body');
    const footer = document.createElement('footer');
    footer.className = 'ui-modal__footer';
    modal.dialog.classList.add('ui-form-modal');
    modal.dialog.appendChild(footer);
    let busy = false;
    let closed = false;
    let message = '';
    let form;
    let feedback;
    let submitButton;
    const disabledControls = new Map();

    function restoreControls() {
      disabledControls.forEach((disabled, control) => { control.disabled = disabled; });
      disabledControls.clear();
    }
    function setBusy(next) {
      if (closed) return;
      busy = Boolean(next);
      if (busy) {
        for (const control of form.querySelectorAll('input, textarea, select, button')) {
          if (!disabledControls.has(control)) disabledControls.set(control, control.disabled);
          control.disabled = true;
        }
      } else restoreControls();
      form.setAttribute('aria-busy', String(busy));
      submitButton.disabled = busy;
      submitButton.classList.toggle('is-loading', busy);
      submitButton.classList.toggle('is-disabled', busy);
      if (busy) submitButton.setAttribute('aria-busy', 'true');
      else submitButton.removeAttribute('aria-busy');
      submitButton.querySelector('.ui-button__label').textContent = busy ? value.busyLabel : value.submitLabel;
      submitButton.querySelectorAll('.ui-button__icon').forEach(icon => { icon.hidden = busy; });
    }
    function setFeedback(text) {
      if (closed) return;
      message = String(text || '');
      feedback.textContent = message;
      feedback.hidden = !message;
    }
    function bindBody() {
      const forms = body.querySelectorAll('form');
      if (forms.length !== 1) {
        modal.close(null, 'invalid-form');
        throw new TypeError('uiFormModal requires exactly one form');
      }
      form = forms[0];
      form.setAttribute('id', formId);
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!busy && !closed && typeof value.onSubmit === 'function') return value.onSubmit(event);
      });
      feedback = document.createElement('p');
      feedback.className = 'ui-form-modal__feedback';
      feedback.setAttribute('role', 'alert');
      feedback.setAttribute('aria-live', 'polite');
      for (const [name, text] of Object.entries(value.feedbackAttrs || {})) {
        if (/^data-[a-z0-9-]+$/.test(name)) feedback.setAttribute(name, text);
      }
      feedback.setAttribute('hidden', '');
      body.appendChild(feedback);
      setFeedback(message);
    }
    function renderFooter() {
      footer.innerHTML = (value.cancelLabel ? root.uiButton({
        label: value.cancelLabel, role: 'secondary', attrs: { 'data-ui-form-cancel': 'true' },
      }) : '') + root.uiButton({
        label: value.submitLabel, role: 'primary', icon: value.submitIcon,
        attrs: { ...(value.submitAttrs || {}), 'data-ui-form-submit': 'true' },
      });
      submitButton = footer.querySelector('[data-ui-form-submit]');
      // uiButton deliberately filters native form/type attributes. Associate the
      // footer action here so click and Enter both use browser form validation.
      submitButton.type = 'submit';
      submitButton.setAttribute('form', formId);
      footer.querySelector('[data-ui-form-cancel]')?.addEventListener('click', () => modal.close(null, 'cancel'));
    }
    function update(next) {
      if (closed) return;
      const replacesBody = Object.prototype.hasOwnProperty.call(next, 'bodyHtml');
      const active = document.activeElement;
      const focusId = active && body.contains(active)
        ? (active.id || active.closest('[data-ui-select]')?.id) : null;
      value = { ...value, ...next };
      modal.dialog.querySelector('.ui-modal__title').textContent = value.title;
      const close = modal.dialog.querySelector('[data-ui-modal-close]');
      if (close) {
        close.setAttribute('aria-label', value.closeLabel);
        close.setAttribute('title', value.closeLabel);
      }
      if (replacesBody) {
        restoreControls();
        body.innerHTML = value.bodyHtml;
        bindBody();
      }
      const cancel = footer.querySelector('[data-ui-form-cancel]');
      if (cancel) cancel.querySelector('.ui-button__label').textContent = value.cancelLabel;
      setBusy(busy);
      if (replacesBody && focusId) requestAnimationFrame(() => {
        if (closed || busy) return;
        const host = Array.from(form.querySelectorAll('[id]')).find(node => node.id === focusId);
        const target = host?.hasAttribute('data-ui-select') ? host.querySelector('button') : host;
        target?.focus();
      });
    }
    bindBody();
    renderFooter();
    setBusy(false);
    modal.then(() => {
      closed = true;
      // Do not retain detached credential controls after closing during a request.
      disabledControls.clear();
    });
    return Object.assign(modal, { setBusy, setFeedback, update });
  }

  root.uiModal = uiModal;
  root.uiModalController = uiModalController;
  root.uiFormModal = uiFormModal;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiModal, uiModalController, uiFormModal };
})(typeof window !== 'undefined' ? window : globalThis);
