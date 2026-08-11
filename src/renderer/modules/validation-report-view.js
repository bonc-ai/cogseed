// ─── Quality validation report modal ─────────────────────────────────────
//
// Renders a `ValidationReport` (from `src/main/quality/types.ts`) as a
// scrollable modal with per-level color cues. Used by:
//   - marketplace.js: when install is rejected by the quality validator
//   - (future) skill / agent inline edit chats
//
// Reuses the dialog overlay chrome from dialogs.js (.modal-overlay /
// .ui-dialog / .modal-actions / .btn) per CLAUDE.md §8 "Reuse UI
// components" — the only new structure is the per-violation card list,
// which is layout-specific.
//
// API:
//   showValidationReport({ title, report, okLabel?, forceLabel? }): Promise<'close'|'force'>
//     title  — header text (caller localized)
//     report — { ok, violations, validated_at, validator_version }
//     okLabel — defaults to common.close
//     forceLabel — when present, shows a neutral override button
//
//   readQualityReport(kind, id): Promise<ValidationReport | null>
//     thin wrapper around window.orkas.quality.read{Skill,Agent}Report
//     so callers don't have to remember the channel name.

function _levelColor(level) {
  if (level === 'EXTREME') return 'var(--danger, #c83030)';
  if (level === 'MEDIUM') return '#d97706';  // amber-600 — distinct from danger
  return 'var(--muted, #8c8c8c)';
}

function _levelLabel(level) {
  // Single i18n key per level — kept as one-word labels so the badge stays compact.
  const key = `quality.level.${level}`;
  try {
    const v = t(key);
    if (v && v !== key) return v;
  } catch (_) { /* t() not ready */ }
  return level;
}

function _suggestedFixText(v) {
  const rule = v && v.rule ? String(v.rule) : '';
  if (rule) {
    const key = `quality.fix.${rule}`;
    try {
      const localized = t(key);
      if (localized && localized !== key) return localized;
    } catch (_) { /* t() not ready */ }
  }
  return v && v.suggested_fix ? String(v.suggested_fix) : '';
}

/**
 * Group violations by rule so one problem reads as one problem.
 *
 * The validator emits one violation per match, which is right for a machine and
 * wrong for a person: scanning a skill whose own rule files contain the patterns
 * it detects produced eleven cards, four of them `no_credential_path_read` with
 * the identical remediation sentence repeated verbatim. The fix sentence is a
 * property of the rule, not of the match, so it belongs once per rule with the
 * locations listed under it.
 *
 * Level is taken as the most severe seen for that rule: grouping must not soften
 * an EXTREME hit by averaging it with a LOW one.
 */
function _groupViolationsByRule(sorted) {
  const order = { EXTREME: 0, MEDIUM: 1, LOW: 2 };
  const groups = new Map();
  for (const v of sorted) {
    // Keyed by rule alone, deliberately. Including the level in the key produced
    // two groups for one rule when it fired at different severities, and the
    // lesser group then rendered under its own softer badge — a grouping change
    // that downgraded a finding on screen. One rule is one card, carrying the
    // worst level seen.
    const rule = String((v && v.rule) || '');
    let g = groups.get(rule);
    if (!g) {
      g = { rule, level: v && v.level, occurrences: [] };
      groups.set(rule, g);
    }
    if ((order[v && v.level] ?? 9) < (order[g.level] ?? 9)) g.level = v.level;
    g.occurrences.push({
      field: (v && v.field) || '',
      snippet: (v && v.snippet) || '',
      suggested_fix: (v && v.suggested_fix) || '',
    });
  }
  return [...groups.values()];
}

/** How many locations to list before collapsing the rest into a count. */
const _MAX_SHOWN_OCCURRENCES = 3;

function _renderViolationGroup(g) {
  const color = _levelColor(g.level);
  const label = _levelLabel(g.level);
  // Any occurrence carries the rule's fix text; they are identical by construction.
  const suggestedFix = _suggestedFixText({ rule: g.rule, suggested_fix: g.occurrences[0]?.suggested_fix });
  const total = g.occurrences.length;
  const shown = g.occurrences.slice(0, _MAX_SHOWN_OCCURRENCES);

  // Count in the header, so "4 places" is visible without counting cards.
  const countBadge = total > 1
    ? `<span style="font-size:11px;color:var(--muted);">${escapeHtml(
      _countLabel(total),
    )}</span>`
    : '';

  const rows = shown.map((o) => `
      <div style="margin-bottom:6px;">
        <div style="font-size:12px;color:var(--muted);font-family:var(--mono,monospace);">${escapeHtml(o.field)}</div>
        ${o.snippet ? `<pre style="margin:2px 0 0;padding:5px 8px;background:var(--surface-3,rgba(0,0,0,.05));border-radius:3px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(o.snippet)}</pre>` : ''}
      </div>`).join('');

  const more = total > _MAX_SHOWN_OCCURRENCES
    ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">${escapeHtml(
      _moreLabel(total - _MAX_SHOWN_OCCURRENCES),
    )}</div>`
    : '';

  return `
    <div class="quality-violation" style="border-left:3px solid ${color};padding:8px 12px;margin-bottom:10px;background:var(--surface-2,rgba(0,0,0,.03));border-radius:4px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
        <span style="font-size:11px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(label)}</span>
        <span style="font-family:var(--mono,monospace);font-size:12px;color:var(--muted);">${escapeHtml(g.rule)}</span>
        ${countBadge}
      </div>
      ${rows}
      ${more}
      ${suggestedFix ? `<div style="font-size:13px;line-height:1.5;">${escapeHtml(suggestedFix)}</div>` : ''}
    </div>
  `;
}

function _countLabel(n) {
  try {
    const v = t('quality.occurrences');
    if (v && v !== 'quality.occurrences') return v.replace('{n}', String(n));
  } catch (_) { /* t() not ready */ }
  return `${n} places`;
}

function _moreLabel(n) {
  try {
    const v = t('quality.occurrences_more');
    if (v && v !== 'quality.occurrences_more') return v.replace('{n}', String(n));
  } catch (_) { /* t() not ready */ }
  return `+${n} more`;
}

function showValidationReport({ title, report, okLabel, forceLabel } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';

    const violations = (report && Array.isArray(report.violations)) ? report.violations : [];
    // Sort: EXTREME first, then MEDIUM, then LOW. Within a level keep
    // original order (the validator already emits them in detection order).
    const order = { EXTREME: 0, MEDIUM: 1, LOW: 2 };
    const sorted = violations.slice().sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));

    const ok = escapeHtml(okLabel || (() => {
      try { const v = t('common.close'); return v === 'common.close' ? 'Close' : v; }
      catch (_) { return 'Close'; }
    })());
    const titleText = escapeHtml(title || 'Quality validation');

    const bodyHtml = sorted.length
      ? _groupViolationsByRule(sorted).map(_renderViolationGroup).join('')
      : `<div class="muted" style="text-align:center;padding:20px;">${escapeHtml((() => {
          try { const v = t('quality.empty'); return v === 'quality.empty' ? 'No findings.' : v; }
          catch (_) { return 'No findings.'; }
        })())}</div>`;

    const force = forceLabel ? escapeHtml(forceLabel) : '';

    overlay.innerHTML = `
      <div class="modal modal-standard ui-dialog quality-report-dialog" role="dialog" aria-modal="true" aria-labelledby="quality-report-title" style="max-width:640px;width:90vw;">
        <div class="modal-title ui-dialog-title" id="quality-report-title">${titleText}</div>
        <div class="modal-body quality-report-body" style="max-height:60vh;overflow-y:auto;">
          ${bodyHtml}
        </div>
        <div class="modal-actions">
          ${force ? `<button class="btn" data-act="force">${force}</button>` : ''}
          <button class="btn btn-primary" data-act="ok">${ok}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('[data-act="ok"]');
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || e.key === 'Enter') finish('close');
    };
    const finish = (action = 'close') => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(action);
    };
    overlay.querySelector('[data-act="force"]')?.addEventListener('click', () => finish('force'));
    okBtn.addEventListener('click', () => finish('close'));
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 0);
  });
}

/** Fetch the latest persisted quality report for a skill or agent.
 *  Returns null on missing report / IPC error. */
async function readQualityReport(kind, id) {
  if (!id || (kind !== 'skill' && kind !== 'agent')) return null;
  try {
    const channel = kind === 'skill' ? 'readSkillReport' : 'readAgentReport';
    const r = await window.orkas.quality[channel](id);
    if (!r || r.ok === false) return null;
    return r.report || null;
  } catch (_) {
    return null;
  }
}

/** Heuristic: was this error message thrown by the quality validator?
 *  The main-side error builder uses a stable prefix ("Quality validation
 *  rejected ...") — see `features/marketplace.ts::_qualityInstallError`. */
function isQualityRejectionError(message) {
  return typeof message === 'string' && /^Quality validation rejected\b/.test(message);
}
