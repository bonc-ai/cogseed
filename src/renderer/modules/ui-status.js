(function initUiStatus(root) {
  'use strict';

  const TAG_VARIANTS = new Set(['solid', 'outline', 'accent', 'mono', 'version', 'success']);
  const STATUS_TONES = new Set(['success', 'attention', 'critical', 'neutral', 'idle']);

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

  function normalizedTone(tone, fallback) {
    const value = String(tone || fallback);
    return STATUS_TONES.has(value) ? value : fallback;
  }

  function uiTag(options) {
    const value = typeof options === 'string' ? { label: options } : (options || {});
    const label = String(value.label || '').trim();
    if (!label) throw new TypeError('uiTag requires visible text');
    const variant = TAG_VARIANTS.has(value.variant) ? value.variant : 'solid';
    const classes = ['ui-tag', `ui-tag--${variant}`, value.className || ''].filter(Boolean).join(' ');
    return `<span class="${escapeText(classes)}"${renderAttrs(value.attrs)}>${escapeText(label)}</span>`;
  }

  function uiChip(options) {
    const value = options || {};
    const label = String(value.label || '').trim();
    if (!label) throw new TypeError('uiChip requires visible text');
    const classes = ['ui-chip', value.selected ? 'is-selected' : '', value.className || ''].filter(Boolean).join(' ');
    const icon = value.icon && typeof root.uiIconHtml === 'function'
      ? root.uiIconHtml(value.icon, 'ui-chip__icon')
      : '';
    return `<button type="button" class="${escapeText(classes)}" aria-pressed="${value.selected ? 'true' : 'false'}"${value.disabled ? ' disabled' : ''}${renderAttrs(value.attrs)}>${icon}<span class="ui-chip__label">${escapeText(label)}</span></button>`;
  }

  function uiBadge(options) {
    const value = typeof options === 'string' || typeof options === 'number' ? { label: options } : (options || {});
    const label = String(value.label == null ? '' : value.label).trim();
    if (!label) throw new TypeError('uiBadge requires visible text');
    const tone = normalizedTone(value.tone, 'neutral');
    const classes = ['ui-badge', `ui-badge--${tone}`, value.className || ''].filter(Boolean).join(' ');
    return `<span class="${escapeText(classes)}"${renderAttrs(value.attrs)}>${escapeText(label)}</span>`;
  }

  function uiStatusPill(options) {
    const value = typeof options === 'string' ? { label: options } : (options || {});
    const label = String(value.label || '').trim();
    if (!label) throw new TypeError('uiStatusPill requires visible text');
    const tone = normalizedTone(value.tone, 'neutral');
    const classes = ['ui-status-pill', `ui-status-pill--${tone}`, value.className || ''].filter(Boolean).join(' ');
    const check = value.check && typeof root.uiIconHtml === 'function'
      ? root.uiIconHtml('check', 'ui-status-pill__icon')
      : '';
    return `<span class="${escapeText(classes)}" role="status"${renderAttrs(value.attrs)}>${check}<span>${escapeText(label)}</span></span>`;
  }

  function uiStatusDot(options) {
    const value = typeof options === 'string' ? { label: options } : (options || {});
    const label = String(value.label || '').trim();
    const tone = normalizedTone(value.tone, 'idle');
    const classes = ['ui-status-dot', `ui-status-dot--${tone}`, value.className || ''].filter(Boolean).join(' ');
    return `<span class="${escapeText(classes)}"${label ? ` role="status" aria-label="${escapeText(label)}"` : ' aria-hidden="true"'}${renderAttrs(value.attrs)}><span class="ui-status-dot__mark"></span>${label ? `<span class="ui-status-dot__label">${escapeText(label)}</span>` : ''}</span>`;
  }

  function uiProgressBar(options) {
    const value = options || {};
    const ariaLabel = String(value.ariaLabel || '').trim();
    if (!ariaLabel) throw new TypeError('uiProgressBar requires an accessible label');
    const max = Math.max(1, Number(value.max) || 100);
    const current = Math.max(0, Math.min(max, Number(value.value) || 0));
    const percent = Math.round((current / max) * 10000) / 100;
    const tone = value.tone === 'attention' ? 'attention' : 'ink';
    const classes = ['ui-progress', `ui-progress--${tone}`, value.className || ''].filter(Boolean).join(' ');
    return `<div class="${escapeText(classes)}" role="progressbar" aria-label="${escapeText(ariaLabel)}" aria-valuemin="0" aria-valuemax="${escapeText(max)}" aria-valuenow="${escapeText(current)}"${renderAttrs(value.attrs)}><span class="ui-progress__fill" style="--ui-progress-value:${percent}%"></span></div>`;
  }

  function uiSkeleton(options) {
    const value = options || {};
    const ariaLabel = String(value.ariaLabel || '').trim();
    if (!ariaLabel) throw new TypeError('uiSkeleton requires an accessible label');
    const rawLines = Array.isArray(value.lines) && value.lines.length ? value.lines : [72, 100, 88];
    const lines = rawLines.map((line, index) => {
      const width = Math.max(12, Math.min(100, Number(line) || 100));
      return `<span class="ui-skeleton__line${index === 0 ? ' is-title' : ''}" style="--ui-skeleton-width:${width}%"></span>`;
    }).join('');
    const media = value.withMedia ? '<span class="ui-skeleton__media" aria-hidden="true"></span>' : '';
    const classes = ['ui-skeleton', value.withMedia ? 'ui-skeleton--media' : '', value.className || ''].filter(Boolean).join(' ');
    return `<div class="${escapeText(classes)}" role="status" aria-label="${escapeText(ariaLabel)}"${renderAttrs(value.attrs)}>${media}<span class="ui-skeleton__lines" aria-hidden="true">${lines}</span></div>`;
  }

  root.uiTag = uiTag;
  root.uiChip = uiChip;
  root.uiBadge = uiBadge;
  root.uiStatusPill = uiStatusPill;
  root.uiStatusDot = uiStatusDot;
  root.uiProgressBar = uiProgressBar;
  root.uiSkeleton = uiSkeleton;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { uiTag, uiChip, uiBadge, uiStatusPill, uiStatusDot, uiProgressBar, uiSkeleton };
  }
})(typeof window !== 'undefined' ? window : globalThis);
