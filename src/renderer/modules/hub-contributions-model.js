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

  const CONTENT_TYPES = new Set(['agent', 'skill']);

  function contentTypeOf(item, latest) {
    const raw = text(item.content_type || latest.content_type).toLowerCase();
    return CONTENT_TYPES.has(raw) ? raw : 'skill';
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
      // Hub 未带 content_type（Skill 时代的数据）一律按 skill 处理；只认 agent / skill 两个值
      contentType: contentTypeOf(item, latest),
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
    const { filter = 'all', query = '', type = 'all' } = options || {};
    const needle = text(query).trim().toLocaleLowerCase();
    return (Array.isArray(list) ? list : []).filter((entry) => {
      if (CONTENT_TYPES.has(type) && entry.contentType !== type) return false;
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

  // ── Agent contribution (agent-contribution.ts → contribution.agent.start) ──

  // Agent admission is `{ outcome, blocking[], skills[] }`. `pass` is the only outcome that lets
  // the preview appear; anything unexpected reads as unavailable, never as passed.
  function classifyAgentAdmission(admission) {
    if (!isRecord(admission)) return 'unavailable';
    if (admission.outcome === 'pass') return 'passed';
    if (admission.outcome === 'incomplete') return 'incomplete';
    if (admission.outcome === 'blocked') return 'blocked';
    return 'unavailable';
  }

  // One row for the Agent itself, then one per bundled Skill so a failing private Skill is named.
  function agentCheckRows(admission) {
    const blocking = isRecord(admission) && Array.isArray(admission.blocking) ? admission.blocking : [];
    const agentIssues = blocking.filter((issue) => isRecord(issue) && !text(issue.skill));
    const rows = [{ id: 'agent', state: agentIssues.length ? 'blocked' : 'ok', count: agentIssues.length }];
    const skills = isRecord(admission) && Array.isArray(admission.skills) ? admission.skills : [];
    for (const skill of skills) {
      if (!isRecord(skill)) continue;
      rows.push({
        id: 'skill',
        name: text(skill.name),
        state: skill.outcome === 'pass' ? 'ok' : skill.outcome === 'incomplete' ? 'attention' : 'blocked',
        reason: text(skill.reason),
      });
    }
    return rows;
  }

  // Declarations still needed before submit; mirrors the Skill flow's C-FR-005 gate, plus the
  // version the contributor must enter (agent.json carries none).
  function agentMissing(draft) {
    const d = isRecord(draft) ? draft : {};
    const missing = [];
    const origin = isRecord(d.origin) ? d.origin : {};
    if (!text(origin.type)) missing.push('origin');
    else if (origin.type === 'third_party' && !text(origin.note).trim()) missing.push('origin_note');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text(d.version).trim())) missing.push('version');
    if (!(isRecord(d.accepted) && d.accepted.terms === true)) missing.push('terms');
    if (!(isRecord(d.accepted) && d.accepted.maintenance === true)) missing.push('maintenance');
    if (d.hasBundled === true && !(isRecord(d.accepted) && d.accepted.skills === true)) missing.push('skills');
    // Spots that may hold local paths or credential-like text: the user must say they looked.
    if (Number(d.hintCount) > 0 && !(isRecord(d.accepted) && d.accepted.hints === true)) missing.push('hints');
    return missing;
  }

  // Group the main process's hint list by file, with the set of 1-based lines per file, so the
  // preview can mark those lines in the file view and list them in the hints panel.
  function hintsByFile(hints) {
    const out = new Map();
    for (const hint of Array.isArray(hints) ? hints : []) {
      if (!isRecord(hint) || !text(hint.file)) continue;
      const entry = out.get(hint.file) || { file: hint.file, lines: new Set(), items: [] };
      const line = Number(hint.line);
      if (Number.isInteger(line) && line > 0) entry.lines.add(line);
      entry.items.push({ kind: text(hint.kind), line, excerpt: text(hint.excerpt) });
      out.set(hint.file, entry);
    }
    return out;
  }

  // Split file content into lines and say which are flagged. The page decides how to render them (the
  // model stays markup-free). Joining the `text` fields with "\n" gives back the content unchanged:
  // nothing is rewritten, only marked.
  function flagLines(content, lines) {
    const flagged = lines instanceof Set ? lines : new Set(Array.isArray(lines) ? lines : []);
    return text(content).split('\n').map((line, index) => ({ text: line, flagged: flagged.has(index + 1) }));
  }

  const api = {
    hintsByFile,
    flagLines,
    classifyAgentAdmission,
    agentCheckRows,
    agentMissing,
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
