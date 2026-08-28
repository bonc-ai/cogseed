// Shared form primitives for classic renderer scripts. The factories own
// field semantics and composition; existing business workflows keep their
// data, validation, and submission behavior.
(function initUiForm(root) {
  'use strict';

  const INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'password', 'number']);

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
      if (!/^(name|autocomplete|inputmode|min|max|minlength|maxlength|step|aria-[a-z-]+|data-[a-z0-9-]+)$/.test(key)) continue;
      if (rawValue == null || rawValue === false) continue;
      safe.push(`${key}="${escapeText(rawValue === true ? '' : rawValue)}"`);
    }
    return safe.length ? ` ${safe.join(' ')}` : '';
  }

  function controlStateAttrs(value) {
    return [
      value.disabled ? ' disabled' : '',
      value.readOnly ? ' readonly' : '',
      value.required ? ' required' : '',
      value.invalid ? ' aria-invalid="true"' : '',
      value.describedBy ? ` aria-describedby="${escapeText(value.describedBy)}"` : '',
      value.previewState ? ` data-preview-state="${escapeText(value.previewState)}"` : '',
    ].join('');
  }

  function uiInput(options) {
    const value = options || {};
    const id = String(value.id || '').trim();
    if (!id) throw new TypeError('uiInput requires an id');
    const type = INPUT_TYPES.has(value.type) ? value.type : 'text';
    return `<input class="form-input ui-control ui-input" id="${escapeText(id)}" type="${type}"${value.value == null ? '' : ` value="${escapeText(value.value)}"`}${value.placeholder ? ` placeholder="${escapeText(value.placeholder)}"` : ''}${controlStateAttrs(value)}${renderAttrs(value.attrs)} />`;
  }

  function uiTextarea(options) {
    const value = options || {};
    const id = String(value.id || '').trim();
    if (!id) throw new TypeError('uiTextarea requires an id');
    return `<textarea class="form-input ui-control ui-textarea" id="${escapeText(id)}"${value.placeholder ? ` placeholder="${escapeText(value.placeholder)}"` : ''}${controlStateAttrs(value)}${renderAttrs(value.attrs)}>${escapeText(value.value)}</textarea>`;
  }

  function uiSelect(options) {
    const value = options || {};
    const id = String(value.id || '').trim();
    if (!id) throw new TypeError('uiSelect requires an id');
    const config = {
      value: String(value.value == null ? '' : value.value),
      placeholder: value.placeholder == null ? null : String(value.placeholder),
      options: (Array.isArray(value.options) ? value.options : []).map((option) => ({
        value: String(option.value == null ? '' : option.value),
        label: String(option.label == null ? '' : option.label),
        ...(option.hint ? { hint: String(option.hint) } : {}),
        ...(option.iconName ? { iconName: String(option.iconName) } : {}),
      })),
      labelId: value.labelId || '',
      describedBy: value.describedBy || '',
      disabled: Boolean(value.disabled),
      invalid: Boolean(value.invalid),
      required: Boolean(value.required),
      previewState: value.previewState || '',
    };
    const classes = [
      'ui-select-host',
      config.disabled ? 'is-disabled' : '',
      config.invalid ? 'is-error' : '',
    ].filter(Boolean).join(' ');
    return `<div class="${classes}" id="${escapeText(id)}" data-ui-select data-ui-select-config="${escapeText(JSON.stringify(config))}"></div>`;
  }

  function hydrateUiFormSelects(container, callbacks) {
    if (typeof document === 'undefined') throw new Error('hydrateUiFormSelects requires a browser document');
    if (typeof root._aiSelectMount !== 'function') throw new Error('hydrateUiFormSelects requires the existing AiSelect runtime');
    const scope = container || document;
    const hosts = [
      ...(scope.matches && scope.matches('[data-ui-select]') ? [scope] : []),
      ...Array.from(scope.querySelectorAll('[data-ui-select]')),
    ];
    return hosts.map((host) => {
      if (host.dataset.uiSelectHydrated === 'true') return host._uiSelectApi;
      let config;
      try {
        config = JSON.parse(host.dataset.uiSelectConfig || '{}');
      } catch (_) {
        throw new TypeError(`Invalid uiSelect config for ${host.id || 'unknown host'}`);
      }
      const onChange = callbacks && typeof callbacks[host.id] === 'function'
        ? callbacks[host.id]
        : () => {};
      const api = root._aiSelectMount(host, {
        options: config.options || [],
        value: config.value || '',
        ...(config.placeholder == null ? {} : { placeholder: config.placeholder }),
        onChange,
      });
      const trigger = api.el.querySelector('.ai-select-trigger');
      const valueLabel = api.el.querySelector('.ai-select-label');
      if (valueLabel && host.id) valueLabel.id = `${host.id}-selected-value`;
      const labelledBy = [config.labelId, valueLabel && valueLabel.id].filter(Boolean).join(' ');
      if (labelledBy) trigger.setAttribute('aria-labelledby', labelledBy);
      if (config.describedBy) trigger.setAttribute('aria-describedby', config.describedBy);
      if (config.required) trigger.setAttribute('aria-required', 'true');
      if (config.invalid) trigger.setAttribute('aria-invalid', 'true');
      if (config.previewState) trigger.dataset.previewState = config.previewState;
      if (config.disabled) {
        trigger.disabled = true;
        api.el.classList.add('is-disabled');
      }
      host.dataset.uiSelectHydrated = 'true';
      host._uiSelectApi = api;
      return api;
    });
  }

  function renderControl(options) {
    if (options.kind === 'textarea') return uiTextarea(options);
    if (options.kind === 'select') return uiSelect(options);
    return uiInput(options);
  }

  function uiField(options) {
    const value = options || {};
    const id = String(value.id || '').trim();
    const label = String(value.label || '').trim();
    if (!id || !label) throw new TypeError('uiField requires an id and label');
    const hintId = value.hint ? `${id}-hint` : '';
    const errorId = value.error ? `${id}-error` : '';
    const describedBy = [hintId, errorId].filter(Boolean).join(' ');
    const isSelect = value.control && value.control.kind === 'select';
    const labelId = isSelect ? `${id}-label` : '';
    const control = renderControl({
      ...(value.control || {}),
      id,
      required: Boolean(value.required),
      invalid: Boolean(value.error),
      describedBy,
      labelId,
    });
    const requirement = value.required
      ? '<span class="ui-field__requirement">必填</span>'
      : '<span class="ui-field__requirement">选填</span>';
    const hint = value.hint
      ? `<p class="ui-field__hint" id="${escapeText(hintId)}">${escapeText(value.hint)}</p>`
      : '';
    const error = value.error
      ? `<p class="ui-field__error" id="${escapeText(errorId)}">${escapeText(value.error)}</p>`
      : '';
    return [
      `<div class="ui-field${value.error ? ' is-error' : ''}">`,
      '<div class="ui-field__label-row">',
      isSelect
        ? `<span class="ui-field__label" id="${escapeText(labelId)}">${escapeText(label)}</span>`
        : `<label for="${escapeText(id)}">${escapeText(label)}</label>`,
      requirement,
      '</div>',
      control,
      hint,
      error,
      '</div>',
    ].join('');
  }

  function uiForm(options) {
    const value = options || {};
    const twoColumns = value.columns === 2;
    const fields = (Array.isArray(value.fields) ? value.fields : []).map((field) => {
      const item = typeof field === 'string' ? { html: field } : field;
      return `<div class="ui-form__item${item.wide ? ' ui-form__item--wide' : ''}">${item.html || ''}</div>`;
    }).join('');
    const actions = (Array.isArray(value.actions) ? value.actions.slice(0, 2) : [])
      .map((action) => root.uiButton(action))
      .join('');
    return `<form class="ui-form${twoColumns ? ' ui-form--two-column' : ''}"${value.ariaLabel ? ` aria-label="${escapeText(value.ariaLabel)}"` : ''}>${fields}${actions ? `<div class="ui-form__actions">${actions}</div>` : ''}</form>`;
  }

  root.uiInput = uiInput;
  root.uiTextarea = uiTextarea;
  root.uiSelect = uiSelect;
  root.hydrateUiFormSelects = hydrateUiFormSelects;
  root.uiField = uiField;
  root.uiForm = uiForm;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { uiInput, uiTextarea, uiSelect, hydrateUiFormSelects, uiField, uiForm };
  }
})(typeof window !== 'undefined' ? window : globalThis);
