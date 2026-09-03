// ─── Custom dialogs (replace native confirm/alert) ──────────────────────
// Native `confirm()` / `alert()` render OS-locale buttons ("OK"/"Cancel").
// These helpers give us a localized cancel / confirm pair every time
// and match the rest of the modal UI. Both return a Promise — callers
// must `await`.

// Pre-boot, `t()` may not yet have tables loaded — fall back to a
// Chinese source string so the dialog never renders blank if triggered
// early. (The fallback string itself is intentionally left as Chinese
// to match the historical default; the i18n key takes over once tables
// load.)
function _dialogLabel(key, zhFallback) {
  try { const v = t(key); return v === key ? zhFallback : v; } catch (_) { return zhFallback; }
}

// 统一弹窗运行时：动态创建 overlay/dialog 后交给 uiModalController 复用
// ESC、背景滚动锁定、焦点陷阱与焦点回归（四项行为只存在一处）；业务按钮的
// 结算值和初始焦点由调用方提供。uiModalController 缺失时走最小降级路径。
function _uiMountDialog({ title, bodyHtml, actionsHtml, initialFocus, cancelValue, onAction, afterMount, dialogClass = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay';
    const titleHtml = title ? `<div class="modal-title ui-dialog-title">${escapeHtml(String(title))}</div>` : '';
    overlay.innerHTML = `
      <div class="modal ui-dialog modal-standard${dialogClass}" role="dialog" aria-modal="true">
        ${titleHtml}
        <div class="modal-body ui-dialog-message">${bodyHtml}</div>
        <div class="modal-actions">${actionsHtml}</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('[role="dialog"]');
    let settled = false;
    const settle = (value) => { if (settled) return; settled = true; resolve(value); };
    const controller = typeof uiModalController === 'function'
      ? uiModalController({
          overlay,
          dialog,
          initialFocus,
          onClose: () => settle(cancelValue),
        })
      : null;
    const finish = (value) => { settle(value); if (controller) controller.close('action'); };

    if (typeof afterMount === 'function') afterMount(overlay, dialog, finish);

    overlay.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = onAction
          ? onAction(btn)
          : (btn.dataset.act === 'ok' ? true : cancelValue);
        finish(value);
      });
    });

    if (controller) {
      controller.open();
    } else {
      // 降级：无 uiModalController 时兜底（理论不走到——ui-modal.js 先于调用加载）。
      overlay.classList.add('open');
      overlay.style.display = 'flex';
      const onKey = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey, true);
          overlay.remove();
          settle(cancelValue);
        }
      };
      document.addEventListener('keydown', onKey, true);
    }
  });
}

function _uiShowDialog({ message, showCancel, okLabel, cancelLabel }) {
  const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
  const cancelText = escapeHtml(cancelLabel || _dialogLabel('common.cancel', 'Cancel'));
  const okText = escapeHtml(okLabel || _dialogLabel('common.confirm', 'Confirm'));
  const actionsHtml = `
    ${showCancel ? `<button class="btn" data-act="cancel"${cancelLabel ? '' : ' data-i18n="common.cancel"'}>${cancelText}</button>` : ''}
    <button class="btn btn-primary" data-act="ok"${okLabel ? '' : ' data-i18n="common.confirm"'}>${okText}</button>
  `;
  return _uiMountDialog({
    bodyHtml: msgHtml,
    actionsHtml,
    initialFocus: '[data-act="ok"]',
    cancelValue: false,
  });
}

// Backwards-compatible: `uiConfirm("message")` keeps the original
// "Confirm" / "Cancel" pair. Pass `{message, okLabel?, cancelLabel?}` when
// the action wants a more specific verb (e.g. "Open Folder" for the
// preview-fallback dialog) — avoids forking a near-duplicate confirm
// helper per CLAUDE.md §"Reuse UI components".
function uiConfirm(arg) {
  if (arg && typeof arg === 'object') {
    return _uiShowDialog({
      message: arg.message,
      showCancel: true,
      okLabel: arg.okLabel,
      cancelLabel: arg.cancelLabel,
    });
  }
  return _uiShowDialog({ message: arg, showCancel: true });
}

function uiAlert(message) {
  return _uiShowDialog({ message, showCancel: false }).then(() => {});
}

let _uiToastHost = null;
let _uiToastSeq = 0;

function _uiEnsureToastHost() {
  if (_uiToastHost && document.body.contains(_uiToastHost)) return _uiToastHost;
  _uiToastHost = document.createElement('div');
  _uiToastHost.className = 'ui-toast-host';
  _uiToastHost.setAttribute('aria-live', 'polite');
  _uiToastHost.setAttribute('aria-atomic', 'false');
  document.body.appendChild(_uiToastHost);
  return _uiToastHost;
}

function uiToast(message, opts) {
  const i18nKey = opts && typeof opts.i18nKey === 'string' ? opts.i18nKey : '';
  const i18nVars = opts && opts.i18nVars && typeof opts.i18nVars === 'object'
    ? { ...opts.i18nVars }
    : undefined;
  const text = i18nKey && typeof t === 'function'
    ? String(t(i18nKey, i18nVars) || '').trim()
    : String(message || '').trim();
  if (!text) return null;
  const host = _uiEnsureToastHost();
  const toast = document.createElement('div');
  const rawVariant = opts && opts.variant ? String(opts.variant) : 'info';
  const variant = ['info', 'success', 'warning', 'error'].includes(rawVariant) ? rawVariant : 'info';
  const timeout = Math.max(1200, Math.min(10000, Number(opts && opts.timeoutMs) || 3200));
  const id = `ui-toast-${++_uiToastSeq}`;
  toast.className = `ui-toast is-${variant}`;
  toast.id = id;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  toast.innerHTML = `
    <div class="ui-toast-bar" aria-hidden="true"></div>
    <div class="ui-toast-message">${escapeHtml(text)}</div>
  `;
  toast._uiToastI18n = i18nKey ? { key: i18nKey, vars: i18nVars } : null;
  host.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
    setTimeout(() => {
      toast.remove();
      if (host.childElementCount === 0) host.remove();
    }, 180);
  };
  toast._uiToastClose = close;
  toast.addEventListener('click', close);
  setTimeout(close, timeout);
  return { id, close };
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('i18n-change', () => {
    if (!_uiToastHost || !document.body.contains(_uiToastHost)) return;
    _uiToastHost.querySelectorAll('.ui-toast').forEach((toast) => {
      const descriptor = toast._uiToastI18n;
      const message = toast.querySelector('.ui-toast-message');
      if (descriptor && message && typeof t === 'function') {
        message.textContent = t(descriptor.key, descriptor.vars);
      } else if (typeof toast._uiToastClose === 'function') {
        // A resolved string cannot be translated safely after the fact.
        toast._uiToastClose();
      }
    });
  });
}

// Danger-styled confirm: title + multi-line message + custom danger button
// label. The primary button uses .btn-danger (red) so the user sees the
// destructive action signed by the action wording itself. Used by the
// project delete flow ("delete project + N conversations") — generic enough
// to adopt for other irreversible actions later.
//
// Returns true if the user confirmed (clicked the danger button), false on
// cancel / Esc.
function uiConfirmDanger({ title, message, dangerLabel, cancelLabel } = {}) {
  const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
  const cancelText = escapeHtml(cancelLabel || _dialogLabel('common.cancel', 'Cancel'));
  const dangerText = escapeHtml(dangerLabel || _dialogLabel('common.confirm', 'Confirm'));
  const actionsHtml = `
    <button class="btn" data-act="cancel"${cancelLabel ? '' : ' data-i18n="common.cancel"'}>${cancelText}</button>
    <button class="btn btn-danger" data-act="ok"${dangerLabel ? '' : ' data-i18n="common.confirm"'}>${dangerText}</button>
  `;
  // 危险确认：默认聚焦「取消」而非危险按钮——Enter 不会误触发不可逆动作。
  return _uiMountDialog({
    title,
    bodyHtml: msgHtml,
    actionsHtml,
    initialFocus: '[data-act="cancel"]',
    cancelValue: false,
    dialogClass: ' ui-dialog-danger',
  });
}

// Multi-button choice dialog. The user picks one of `choices[]` (each
// gets its own button); the resolved value is the chosen `id`, or `null`
// on cancel / Esc. Used when an action has two valid
// follow-up paths (e.g. close-sync with / without cloud purge) — a plain
// uiConfirm would force the user to imagine the alternative.
//
// `choices: [{ id, label, style? }]` — `style` may be 'primary' (default),
// 'danger', or '' for the neutral .btn look. `leadingChoices` renders one
// or more neutral/contextual choices on the left edge of the actions row.
function uiChoice({ title, message, choices = [], leadingChoices = [], cancelLabel } = {}) {
  const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
  const cancelText = escapeHtml(cancelLabel || _dialogLabel('common.cancel', 'Cancel'));
  const renderChoice = (c, extraClass = '') => {
    const cls = c.style === 'danger' ? 'btn btn-danger'
      : c.style === '' ? 'btn'
      : 'btn btn-primary';
    const className = `${cls}${extraClass ? ` ${extraClass}` : ''}`;
    return `<button class="${className}" data-act="choice" data-id="${escapeHtml(String(c.id))}">${escapeHtml(String(c.label || c.id))}</button>`;
  };
  const leadingChoiceHtml = leadingChoices.map((c) => renderChoice(c, 'ui-choice-leading')).join('');
  const choiceHtml = choices.map((c) => renderChoice(c)).join('');
  const actionsHtml = `
    ${leadingChoiceHtml}
    <button class="btn" data-act="cancel"${cancelLabel ? '' : ' data-i18n="common.cancel"'}>${cancelText}</button>
    ${choiceHtml}
  `;
  return _uiMountDialog({
    title,
    bodyHtml: msgHtml,
    actionsHtml,
    cancelValue: null,
    onAction: (btn) => (btn.dataset.act === 'choice' ? (btn.dataset.id || null) : null),
  });
}

// Text-input prompt with cancel / confirm buttons. Returns the entered string, or
// null on cancel. Mirrors native `prompt()` semantics.
function uiPrompt(message, defaultValue = '', options = {}) {
  const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
  const cancelText = escapeHtml(_dialogLabel('common.cancel', 'Cancel'));
  const okText = escapeHtml(_dialogLabel('common.confirm', 'Confirm'));
  const bodyHtml = `${msgHtml}<div class="form-row" style="margin-top:12px;margin-bottom:0"><input type="text" class="ui-dialog-input" /></div>`;
  const actionsHtml = `
    <button class="btn" data-act="cancel" data-i18n="common.cancel">${cancelText}</button>
    <button class="btn btn-primary" data-act="ok" data-i18n="common.confirm">${okText}</button>
  `;
  let promptInput = null;
  return _uiMountDialog({
    bodyHtml,
    actionsHtml,
    initialFocus: '.ui-dialog-input',
    cancelValue: null,
    onAction: (btn) => (btn.dataset.act === 'ok' ? (promptInput ? promptInput.value : '') : null),
    afterMount: (overlay, _dialog, finish) => {
      promptInput = overlay.querySelector('.ui-dialog-input');
      promptInput.value = defaultValue;
      if (options && options.nameLimit && typeof window.bindNameLimitControl === 'function') {
        window.bindNameLimitControl(promptInput);
      }
      // IME guard (CLAUDE.md §8)：输入框内的 Enter 属于 IME 候选确认，只有非
      // 组词态才提交。uiModalController 只接管 ESC/Tab，不拦 Enter。
      promptInput.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') finish(promptInput.value);
      });
      setTimeout(() => { promptInput.focus(); promptInput.select(); }, 0);
    },
  });
}
