// Pure view-model helpers for the Hub contribution pages. No DOM, i18n or IPC:
// the page module renders what these functions derive from `contribution.*`
// results, and the guarded CommonJS bridge lets tests exercise them directly.
(function initHubContributionsModel(root) {
  'use strict';

  const PENDING_STATUSES = new Set(['PENDING', 'PENDING_REVIEW']);
  const RETURNED_STATUSES = new Set(['RETURNED', 'REJECTED']);
  const DECLARATION_FIXABLE = new Set(['declaration_absent', 'declaration_needs_input', 'declaration_mismatch']);
  // The check could not finish, as opposed to finishing with a blocking finding
  // (C-FR-003d): these never read as "passed" nor as "your content is unsafe".
  const CHECK_UNAVAILABLE = new Set([
    'scan_unavailable', 'scanner_absent', 'rules_degraded',
    'instruction_unavailable', 'components_not_ready', 'declaration_unavailable',
  ]);

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value) {
    return value == null ? '' : String(value);
  }

  function classifyAdmission(admission) {
    if (!isRecord(admission)) return 'unavailable';
    if (admission.outcome === 'pass') return 'passed';
    if (DECLARATION_FIXABLE.has(admission.reason)) return 'needs_declaration';
    if (admission.outcome === 'incomplete' || CHECK_UNAVAILABLE.has(admission.reason)) return 'unavailable';
    return 'blocked';
  }

  function componentVersion(component) {
    if (typeof component === 'string') return component;
    return isRecord(component) && component.version ? String(component.version) : '';
  }

  function componentReady(component) {
    return !isRecord(component) || component.ready !== false;
  }

  // One row per independent check. `state` is `ok | blocked | unavailable |
  // skipped`; the page maps it to tone, icon and localized wording.
  function checkRows(admission) {
    const source = isRecord(admission) ? admission : {};
    const components = isRecord(source.components) ? source.components : {};
    const scan = isRecord(source.scan) ? source.scan : null;
    const declaration = isRecord(source.declaration) ? source.declaration : null;
    const issues = Array.isArray(source.issues) ? source.issues : [];
    const localBlocked = source.reason === 'local_red_lines' || issues.length > 0;
    const scanRan = scan !== null;

    const scanState = !scanRan ? 'skipped'
      : scan.outcome === 'pass' ? 'ok'
        : scan.outcome === 'restricted' || scan.outcome === 'blocked' ? 'blocked'
          : 'unavailable';
    const instruction = scanRan ? text(scan.instructionRisk) : '';
    const instructionState = !scanRan ? 'skipped'
      : instruction === 'clean' ? 'ok'
        : instruction === 'suspicious' ? 'blocked'
          : 'unavailable';
    const declarationState = !declaration ? 'skipped'
      : declaration.outcome === 'pass' || declaration.outcome === 'pass_with_warnings' ? 'ok'
        : declaration.reason === 'declaration_unavailable' ? 'unavailable'
          : 'blocked';
    const rulesetState = !componentReady(components.ruleset) ? 'unavailable'
      : scanRan && scan.rulesDegraded === true ? 'unavailable' : (componentVersion(components.ruleset) || scanRan ? 'ok' : 'skipped');

    return [
      { id: 'local', state: localBlocked ? 'blocked' : 'ok', count: issues.length },
      { id: 'ruleset', state: rulesetState, version: componentVersion(components.ruleset) },
      {
        id: 'scan',
        state: componentReady(components.sentry) ? scanState : 'unavailable',
        version: componentVersion(components.sentry),
        isolated: scanRan ? scan.isolated === true : null,
      },
      { id: 'instruction', state: instructionState },
      {
        id: 'declaration',
        state: componentReady(components.declaration) ? declarationState : 'unavailable',
        version: componentVersion(components.declaration),
        ontologyVersion: text(components.ontologyVersion),
        findings: declaration && Array.isArray(declaration.findings) ? declaration.findings.length : 0,
      },
    ];
  }

  function latestOf(item) {
    return isRecord(item.latest_submission) ? item.latest_submission : {};
  }

  function timeOf(value) {
    const parsed = Date.parse(text(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Normalizes one cached `contribution.mine` item. Every field is optional on
  // the wire, so each one falls back to an empty value instead of throwing.
  function normalizeItem(item, index) {
    const latest = latestOf(item);
    const withdrawal = isRecord(item.withdrawal_request) ? item.withdrawal_request : null;
    const contentId = text(item.content_id);
    const submissionId = text(latest.submission_id || item.submission_id);
    return {
      key: text(item.entry_id || contentId || submissionId || `#${index + 1}`),
      raw: item,
      title: text(item.name || item.title || contentId || submissionId || item.entry_id || `#${index + 1}`),
      contentId,
      submissionId,
      status: text(latest.status || item.status || item.review_status || item.submission_status
        || item.content_status).toUpperCase(),
      contentStatus: text(item.content_status).toLowerCase(),
      publishedVersion: text(item.current_published_version),
      version: text(latest.version),
      submittedAt: text(latest.submitted_at || latest.updated_at || item.updated_at),
      updatedAt: text(item.updated_at || latest.updated_at || latest.submitted_at),
      returnedReason: text(latest.returned_reason || item.reason || item.review_reason),
      origin: isRecord(latest.declarations_origin) ? latest.declarations_origin : null,
      withdrawal: withdrawal ? {
        status: text(withdrawal.status).toUpperCase(),
        reason: text(withdrawal.reason),
        rejectedReason: text(withdrawal.rejected_reason),
      } : null,
    };
  }

  function normalizeItems(items) {
    const list = (Array.isArray(items) ? items : Object.values(isRecord(items) ? items : {}))
      .filter(isRecord)
      .map(normalizeItem);
    return list
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (timeOf(b.entry.updatedAt) - timeOf(a.entry.updatedAt)) || (a.index - b.index))
      .map(({ entry }) => entry);
  }

  function historyStats(list) {
    const items = Array.isArray(list) ? list : [];
    return {
      total: items.length,
      pending: items.filter((entry) => PENDING_STATUSES.has(entry.status)).length,
      published: items.filter((entry) => Boolean(entry.publishedVersion)).length,
    };
  }

  function matchesFilter(entry, filter) {
    if (filter === 'pending') return PENDING_STATUSES.has(entry.status);
    if (filter === 'rejected') return RETURNED_STATUSES.has(entry.status);
    if (filter === 'published') return Boolean(entry.publishedVersion);
    if (filter === 'withdrawal') return entry.withdrawal !== null;
    return true;
  }

  function filterHistory(list, options) {
    const { filter = 'all', query = '' } = options || {};
    const needle = text(query).trim().toLocaleLowerCase();
    return (Array.isArray(list) ? list : []).filter((entry) => {
      if (needle && !`${entry.title} ${entry.contentId} ${entry.key}`.toLocaleLowerCase().includes(needle)) return false;
      return matchesFilter(entry, filter);
    });
  }

  // Which detail actions apply to one item (C-FR-018/019/022/024a/025).
  function detailActions(entry) {
    const pendingSubmission = Boolean(entry.submissionId) && entry.status === 'PENDING_REVIEW';
    return {
      newVersion: Boolean(entry.contentId),
      resubmit: entry.status === 'RETURNED',
      withdrawPending: pendingSubmission,
      requestWithdrawal: Boolean(entry.contentId) && entry.contentStatus === 'published'
        && !(entry.withdrawal && entry.withdrawal.status === 'PENDING'),
      withdrawalHistory: Boolean(entry.contentId),
    };
  }

  const DETAIL_LINE_LIMIT = 8;
  const DETAIL_TEXT_LIMIT = 200;

  function clip(value) {
    const out = text(value).replace(/\s+/g, ' ').trim();
    return out.length > DETAIL_TEXT_LIMIT ? `${out.slice(0, DETAIL_TEXT_LIMIT - 1)}…` : out;
  }

  function describeDetail(item) {
    if (typeof item === 'string' || typeof item === 'number') return clip(item);
    if (!isRecord(item)) return '';
    const head = clip(item.message || item.title || item.reason || item.rule_id || item.code);
    const where = clip(item.path || item.file);
    const fix = clip(item.fix || item.suggestion || item.remediation);
    return [head, where && `(${where})`, fix && `→ ${fix}`].filter(Boolean).join(' ');
  }

  // Hub's `error.details` has no frozen shape, so expand it defensively: arrays become one
  // bullet per entry, scalars become `key: value`, and the total is bounded.
  function detailLines(details) {
    if (!isRecord(details)) return [];
    const lines = [];
    const push = (line) => { if (line && lines.length < DETAIL_LINE_LIMIT) lines.push(line); };
    for (const [key, value] of Object.entries(details)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          const line = describeDetail(entry);
          if (line) push(`· ${line}`);
        }
      } else if (isRecord(value)) {
        push(`${key}: ${describeDetail(value) || clip(JSON.stringify(value))}`);
      } else if (value != null && value !== '') {
        push(`${key}: ${clip(value)}`);
      }
    }
    return lines;
  }

  // The message Hub gave plus whatever it explained, so a rejection never shows only
  // "see server_check" while the client holds the blocking items.
  function describeApiError(error, fallback) {
    const message = text(isRecord(error) ? error.message : '').trim() || text(fallback);
    const lines = isRecord(error) ? detailLines(error.details) : [];
    return lines.length ? `${message}\n${lines.join('\n')}` : message;
  }

  const api = {
    classifyAdmission,
    checkRows,
    normalizeItems,
    historyStats,
    filterHistory,
    detailActions,
    detailLines,
    describeApiError,
  };

  root.HubContributionsModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
