(function initUiDrawer(root) {
  'use strict';

  let drawerSequence = 0;

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uiDrawerController(options) {
    const value = options || {};
    const overlay = value.overlay;
    const drawer = value.drawer || value.dialog;
    if (!overlay || !drawer) throw new TypeError('uiDrawerController requires an overlay and drawer');
    if (typeof root.uiModalController !== 'function') throw new TypeError('uiDrawerController requires uiModalController');
    overlay.classList.add('ui-drawer-overlay');
    overlay.dataset.uiDrawerRoot = 'true';
    drawer.classList.add('ui-drawer');
    drawer.dataset.uiDrawerPanel = 'true';
    const controller = root.uiModalController({
      overlay,
      dialog: drawer,
      initialFocus: value.initialFocus,
      dismissible: value.dismissible,
      fallbackFocus: value.fallbackFocus,
      onClose: value.onClose,
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay && value.dismissible !== false) controller.close('backdrop');
    });
    return controller;
  }

  function uiDrawer(options) {
    const value = options || {};
    const title = String(value.title || '').trim();
    if (!title) throw new TypeError('uiDrawer requires a title');
    if (typeof document === 'undefined' || !document.body) throw new TypeError('uiDrawer requires a DOM');
    if (typeof root.uiIconButton !== 'function') throw new TypeError('uiDrawer requires uiIconButton');
    const overlay = document.createElement('div');
    overlay.className = 'ui-drawer-overlay';
    overlay.hidden = true;
    const closeLabel = String(value.closeLabel || 'Close');
    const closeButton = root.uiIconButton({
      label: closeLabel,
      icon: 'x',
      className: 'ui-drawer__close',
      attrs: { 'data-ui-drawer-close': 'true' },
    });
    const titleId = `ui-drawer-title-${++drawerSequence}`;
    overlay.innerHTML = `<aside class="ui-drawer" role="dialog" aria-modal="true" aria-labelledby="${titleId}"><header class="ui-drawer__header"><h2 id="${titleId}">${escapeText(title)}</h2>${closeButton}</header><div class="ui-drawer__body">${String(value.bodyHtml || '')}</div>${value.footerHtml ? `<footer class="ui-drawer__footer">${String(value.footerHtml)}</footer>` : ''}</aside>`;
    document.body.appendChild(overlay);
    const drawer = overlay.querySelector('[data-ui-drawer-panel], .ui-drawer');
    const controller = uiDrawerController({
      overlay,
      drawer,
      initialFocus: value.initialFocus || '[data-ui-drawer-close]',
      dismissible: value.dismissible,
      fallbackFocus: value.fallbackFocus,
      onClose(reason) {
        overlay.remove();
        if (typeof value.onClose === 'function') value.onClose(reason);
      },
    });
    overlay.querySelectorAll('[data-ui-drawer-close]').forEach((button) => {
      button.addEventListener('click', () => controller.close('close-button'));
    });
    controller.open(value.trigger);
    return { ...controller, overlay, drawer };
  }

  root.uiDrawer = uiDrawer;
  root.uiDrawerController = uiDrawerController;
  if (typeof module !== 'undefined' && module.exports) module.exports = { uiDrawer, uiDrawerController };
})(typeof window !== 'undefined' ? window : globalThis);
