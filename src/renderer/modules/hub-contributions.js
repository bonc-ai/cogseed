// Hub Skill contribution pages (registry HUBC-PV-001/002/003). Two same-level
// views of the Skills page: the four-stage contribution flow and "My
// contributions". Business sequencing stays page-owned; every control, prompt,
// decision and overlay comes from the shared ui* seams. Pure derivations
// (check rows, history stats/filter) live in hub-contributions-model.js.
(function initHubContributions(root) {
  'use strict';

  const model = root.HubContributionsModel;
  const STAGES = ['complete', 'check', 'preview', 'send'];
  const MINE_POLL_MS = 55_000;
  const MINE_FILTERS = ['all', 'pending', 'rejected', 'published', 'withdrawal'];
  const ORIGIN_TYPES = ['original', 'derived_from_hub', 'third_party'];
  const HUB_CONTENT_ID = /^[0-9a-f]{12}$/;
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  const MISSING_FALLBACK = {
    origin: 'origin declaration',
    origin_note: 'third-party origin note',
    terms: 'accept the terms',
    maintenance: 'confirm maintenance responsibility',
  };

  let session = null;
  let mine = null;
  let minePoll = null;

  // Hub's message plus the details it returned (blocking items etc.), never the message alone.
  function errorText(error, fallback) {
    return model.describeApiError(error, fallback);
  }

  function tr(key, fallback) {
    const value = typeof root.t === 'function' ? root.t(key) : '';
    return value && value !== key ? value : fallback;
  }

  function fmt(template, values) {
    return Object.entries(values || {}).reduce((out, [key, value]) => out.split(`{${key}}`).join(String(value)), template);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function modal(options) {
    if (typeof root.uiModal !== 'function') throw new Error('contribution requires uiModal');
    return root.uiModal({ closeLabel: tr('common.close', 'Close'), ...options });
  }

  function icon(name) {
    return typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name, 'hubc-icon') : '';
  }

  function button(options) {
    return root.uiButton(options);
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function statusTone(status) {
    const normalized = String(status || '').toUpperCase();
    if (['ACCEPTED', 'PUBLISHED', 'WITHDRAWN', 'APPROVED'].includes(normalized)) return 'success';
    if (['PENDING', 'PENDING_REVIEW', 'PENDING_WITHDRAWAL'].includes(normalized)) return 'attention';
    if (['RETURNED', 'REJECTED', 'FAILED', 'DISABLED'].includes(normalized)) return 'critical';
    return 'neutral';
  }

  function statusDescriptor(status, namespace = 'skills.contribute_status') {
    const normalized = String(status || tr('skills.contribute_status_unknown', 'Unknown')).toUpperCase();
    return {
      label: tr(`${namespace}.${normalized}`, String(status || tr('skills.contribute_status_unknown', 'Unknown'))),
      tone: statusTone(normalized),
      check: ['ACCEPTED', 'PUBLISHED', 'WITHDRAWN', 'APPROVED'].includes(normalized),
    };
  }

  function admissionDetails(state) {
    const admission = state?.admission || {};
    const issues = [
      ...(Array.isArray(admission.issues) ? admission.issues.map((issue) =>
        [issue.path || issue.file || issue.rule || issue.rule_id, issue.rule || issue.rule_id, issue.message].filter(Boolean).join(' · ')) : []),
      ...(Array.isArray(admission.declaration?.findings) ? admission.declaration.findings.map((finding) =>
        [finding.ruleId, finding.message].filter(Boolean).join(' · ')) : []),
      ...(Array.isArray(admission.componentsBlocking) ? admission.componentsBlocking : []),
    ].filter(Boolean);
    return {
      reason: tr(`skills.contribute_reason.${admission.reason}`, tr('skills.contribute_blocked', 'Local checks blocked contribution.')),
      issues,
    };
  }

  // ── Identity (login-required prompt, reused by the entry and My contributions) ──

  async function ensureIdentity(name) {
    const preflight = await root.cogseed.invoke('contribution.preflight', {});
    if (preflight?.identity?.outcome === 'ready') return preflight;
    if (preflight?.identity?.reason !== 'not_signed_in') {
      await root.uiAlert(tr(`skills.contribute_reason.${preflight?.identity?.reason}`, tr('skills.contribute_unavailable', 'Contribution is unavailable.')));
      return null;
    }
    const proceed = await root.uiConfirm({
      message: tr('skills.login_required_hint', 'Sign in to continue.').replace('{target}', name || ''),
      okLabel: tr('skills.login_goto_web', 'Go to web sign-in'),
    });
    if (!proceed) return null;
    const loginResult = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (typeof unsubscribe === 'function') unsubscribe();
        resolve(value);
      };
      const unsubscribe = root.cogseed.onPushEvent('hub-account:login-result', (outcome) => {
        finish(outcome?.result === 'success');
      });
      const timeout = setTimeout(() => finish(false), 5 * 60_000);
    });
    await root.cogseed.invoke('hub-account.start_login', {});
    if (!await loginResult) return null;
    const resumed = await root.cogseed.invoke('contribution.preflight', {});
    return resumed?.identity?.outcome === 'ready' ? resumed : null;
  }

  // ── View plumbing ──

  function hostOf(kind) {
    return document.getElementById(kind === 'mine' ? 'skills-contributions-view' : 'skills-contribute-view');
  }

  function showView(kind) {
    const grid = document.getElementById('skills-grid-view');
    const detail = document.getElementById('skills-detail-view');
    if (grid) grid.style.display = 'none';
    if (detail) detail.style.display = 'none';
    hostOf('contribute').style.display = kind === 'contribute' ? 'flex' : 'none';
    hostOf('mine').style.display = kind === 'mine' ? 'flex' : 'none';
  }

  function viewVisible(kind) {
    const host = hostOf(kind);
    return Boolean(host) && host.style.display !== 'none';
  }

  function stopMinePoll() {
    if (minePoll) clearInterval(minePoll);
    minePoll = null;
  }

  async function endSession() {
    const current = session;
    session = null;
    if (!current) return;
    if (typeof current.cancelCheck === 'function') current.cancelCheck();
    if (typeof current.cancelUpload === 'function') current.cancelUpload();
    if (current.token) await root.cogseed.invoke('contribution.cancel', { token: current.token }).catch(() => {});
  }

  // Called by skills.js whenever the grid or detail view takes over again.
  function hideContributionViews() {
    stopMinePoll();
    mine = null;
    void endSession();
    for (const kind of ['contribute', 'mine']) {
      const host = hostOf(kind);
      if (host) {
        host.style.display = 'none';
        host.innerHTML = '';
      }
    }
  }

  function leaveToSkills() {
    if (typeof _showSkillsGridView === 'function') _showSkillsGridView();
    else {
      hideContributionViews();
      const grid = document.getElementById('skills-grid-view');
      if (grid) grid.style.display = 'flex';
    }
  }

  function backline(label) {
    return `<div class="hubc-backline">${button({
      label: tr('skills.contribute_back', 'Back to Skills'), role: 'ghost', size: 'sm', icon: 'chevron-left',
      attrs: { 'data-hubc-action': 'back' },
    })}<span class="hubc-backline__sep" aria-hidden="true">/</span><span>${esc(label)}</span></div>`;
  }

  function hydrateSelects(container, callbacks) {
    const apis = {};
    if (typeof root.hydrateUiFormSelects !== 'function') return apis;
    const hosts = Array.from(container.querySelectorAll('[data-ui-select]'));
    const hydrated = root.hydrateUiFormSelects(container, callbacks) || [];
    hosts.forEach((host, index) => { apis[host.id] = hydrated[index]; });
    return apis;
  }

  // ── Contribution page ──

  function hasMissing(state) {
    return Boolean(state?.completion?.missing?.length || state?.completion?.conflicts?.length);
  }

  function stepIndex() {
    if (!session) return 0;
    if (session.stage === 'complete') return 0;
    if (session.stage === 'check') return 1;
    return session.sending ? 3 : 2;
  }

  function stepsHtml() {
    const current = stepIndex();
    const labels = [
      tr('skills.contribute_step_complete', 'Complete details'),
      tr('skills.contribute_step_check', 'Local checks'),
      tr('skills.contribute_step_preview', 'Preview and declarations'),
      tr('skills.contribute_step_send', 'Submit for review'),
    ];
    return `<ol class="hubc-steps" aria-label="${esc(tr('skills.contribute_steps_label', 'Contribution steps'))}">${STAGES.map((stage, index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'todo';
      const word = state === 'done' ? tr('skills.contribute_step_done', 'Done')
        : state === 'current' ? tr('skills.contribute_step_current', 'Current step') : '';
      return `<li class="hubc-step is-${state}"${state === 'current' ? ' aria-current="step"' : ''}>`
        + `<span class="hubc-step__mark" aria-hidden="true">${state === 'done' ? icon('check') : index + 1}</span>`
        + `<span class="hubc-step__label">${esc(labels[index])}</span>`
        + `${word ? `<span class="ui-visually-hidden">${esc(word)}</span>` : ''}</li>`;
    }).join('')}</ol>`;
  }

  function pageShell(stageHtml) {
    const s = session;
    const subtitle = s.targetContentId
      ? fmt(tr('skills.contribute_page_subtitle_version', 'Submit a new version of {id} from “{name}”.'), { id: s.targetContentId, name: s.name })
      : fmt(tr('skills.contribute_page_subtitle', 'Contribute “{name}” to Hub. Submissions enter review first; accepted content still needs publishing.'), { name: s.name });
    return `<div class="hubc-page" data-hubc-page="contribute">
      ${backline(tr('skills.contribute_page_title', 'Contribute Skill'))}
      <header class="hubc-heading"><div><h1>${esc(tr('skills.contribute_page_title', 'Contribute Skill'))}</h1><p>${esc(subtitle)}</p></div>
        ${root.uiStatusPill({ label: tr('skills.contribute_pill_review_only', 'Submitted for review only'), tone: 'neutral' })}</header>
      ${stepsHtml()}
      <div class="hubc-stage" data-hubc-stage="${esc(s.stage)}">${stageHtml}</div>
    </div>`;
  }

  function renderContribute() {
    if (!session) return;
    const host = hostOf('contribute');
    const html = session.stage === 'complete' ? completeHtml()
      : session.stage === 'check' ? checkHtml() : previewHtml();
    host.innerHTML = pageShell(html);
    showView('contribute');
    if (session.stage === 'complete') hydrateComplete(host);
    if (session.stage === 'preview') hydratePreview(host);
  }

  // Stage 1 — complete missing or conflicting details.
  function fieldLabels() {
    return {
      skill_md: tr('skills.contribute_skill_md', 'SKILL.md'),
      name: tr('skills.contribute_meta_name', 'Name'),
      description: tr('skills.contribute_meta_desc', 'Description'),
      version: tr('skills.contribute_meta_version', 'Version'),
      security_manifest: tr('skills.contribute_security_manifest', 'Security declaration'),
    };
  }

  function completionAlertHtml() {
    const completion = session.state?.completion || {};
    const labels = fieldLabels();
    const lines = [
      ...(completion.missing || []).map((field) =>
        fmt(tr('skills.contribute_missing_field', '{field}: required.'), { field: labels[field] || field })),
      ...(completion.conflicts || []).map((conflict) => {
        const values = (conflict.values || []).map((item) => `${item.source}: ${item.value}`).join(' · ');
        return fmt(tr('skills.contribute_conflict_field', '{field}: conflicting values ({values}).'),
          { field: labels[conflict.field] || conflict.field, values });
      }),
    ];
    if (session.declarationNote) lines.push(session.declarationNote);
    return lines.length ? `<div class="hubc-alert" role="alert">${lines.map((line) => `<p>${esc(line)}</p>`).join('')}</div>` : '';
  }

  function securityFieldsHtml() {
    const draft = session.draft.security;
    const choose = tr('skills.contribute_security_choose', 'Choose one');
    const select = (id, label, value, options, extra = {}) => ({
      html: root.uiField({ id, label, required: !extra.optional, hint: extra.hint, control: { kind: 'select', value, placeholder: choose, options } }),
    });
    return [
      select('contrib-network-access', tr('skills.contribute_security_network', 'External network access'), draft.network_access, [
        { value: 'none', label: tr('skills.contribute_security_network_none', 'Does not access external networks') },
        { value: 'restricted', label: tr('skills.contribute_security_network_restricted', 'Accesses declared domains only') },
      ], { hint: tr('skills.contribute_security_network_hint', 'Choose restricted access only when the Skill contacts specific services.') }),
      {
        html: root.uiField({
          id: 'contrib-network-allowlist', label: tr('skills.contribute_security_network_allowlist', 'Allowed domains'),
          hint: tr('skills.contribute_security_network_allowlist_hint', 'Required only for restricted network access. Enter one domain or HTTPS address per line.'),
          control: { kind: 'textarea', value: draft.network_allowlist, attrs: { rows: 3, spellcheck: 'false' } },
        }),
      },
      select('contrib-file-access', tr('skills.contribute_security_files', 'Local file access'), draft.file_access, [
        { value: 'none', label: tr('skills.contribute_security_files_none', 'Does not directly read or write local files') },
        { value: 'read_selected', label: tr('skills.contribute_security_files_read', 'Reads only files selected by the user') },
        { value: 'read_write_selected', label: tr('skills.contribute_security_files_write', 'Reads and writes only files selected by the user') },
      ]),
      select('contrib-command-access', tr('skills.contribute_security_commands', 'Commands and external tools'), draft.command_access, [
        { value: 'none', label: tr('skills.contribute_security_commands_none', 'Does not execute commands or external tools') },
        { value: 'declared_tools', label: tr('skills.contribute_security_commands_declared', 'Uses the tools listed below') },
      ]),
      {
        html: root.uiField({
          id: 'contrib-external-tools', label: tr('skills.contribute_security_tool_names', 'Tool names'),
          hint: tr('skills.contribute_security_tool_names_hint', 'Required only when tools are used. Enter executable or package names, one per line.'),
          control: { kind: 'textarea', value: draft.external_tools, attrs: { rows: 3, spellcheck: 'false' } },
        }),
      },
      select('contrib-sensitive-data', tr('skills.contribute_security_data', 'Sensitive data'), draft.sensitive_data, [
        { value: 'none', label: tr('skills.contribute_security_data_none', 'Not intended to process personal information or credentials') },
        { value: 'personal', label: tr('skills.contribute_security_data_personal', 'May process personal information') },
        { value: 'credentials', label: tr('skills.contribute_security_data_credentials', 'May process credentials or secrets') },
      ]),
    ];
  }

  function completeHtml() {
    const draft = session.draft;
    const detailsForm = root.uiForm({
      ariaLabel: tr('skills.contribute_metadata', 'Submission metadata'),
      columns: 2,
      fields: [
        { html: root.uiField({ id: 'contrib-name', label: tr('skills.contribute_meta_name', 'Name'), required: true, control: { kind: 'input', value: draft.name } }) },
        { html: root.uiField({ id: 'contrib-version', label: tr('skills.contribute_meta_version', 'Version'), required: true, hint: tr('skills.contribute_version_hint', 'Standard SemVer, for example 1.0.0.'), control: { kind: 'input', value: draft.version, placeholder: '1.0.0' } }) },
        { wide: true, html: root.uiField({ id: 'contrib-description', label: tr('skills.contribute_meta_desc', 'Description'), required: true, control: { kind: 'textarea', value: draft.description, attrs: { rows: 3 } } }) },
      ],
    });
    const security = session.needsSecurity ? `
      <div class="hubc-divider"></div>
      <div class="hubc-section-head"><div><h2>${esc(tr('skills.contribute_security_title', 'Security declaration'))}</h2>
        <p>${esc(tr('skills.contribute_security_hint', 'Answer from the Skill’s real behavior. An unanswered fact is never treated as “none”.'))}</p></div>
        ${root.uiStatusPill({ label: tr('skills.contribute_security_pill', 'Declaration precheck'), tone: 'neutral' })}</div>
      ${root.uiForm({ ariaLabel: tr('skills.contribute_security_title', 'Security declaration'), columns: 2, fields: securityFieldsHtml() })}` : '';
    return `<section class="hubc-panel" aria-labelledby="hubc-complete-title">
      <div class="hubc-section-head"><div><h2 id="hubc-complete-title">${esc(tr('skills.contribute_complete_title', 'Complete this submission’s details'))}</h2>
        <p>${esc(tr('skills.contribute_metadata_hint', 'Changes apply only to the submission copy.'))}</p></div>
        ${root.uiStatusPill({ label: tr('skills.contribute_complete_pill', 'Needs details'), tone: 'attention' })}</div>
      ${completionAlertHtml()}
      ${detailsForm}
      ${security}
      <div class="hubc-actions"><p>${esc(tr('skills.contribute_complete_note', 'Existing values are prefilled. After saving, all checks run again on the final copy.'))}</p>
        ${button({ label: tr('skills.contribute_complete_save', 'Save and recheck'), role: 'primary', attrs: { 'data-hubc-action': 'complete-save' } })}</div>
    </section>`;
  }

  function hydrateComplete(host) {
    session.selects = hydrateSelects(host, {});
  }

  function readComplete() {
    const host = hostOf('contribute');
    const value = (id) => host.querySelector(`#${id}`)?.value || '';
    const select = (id) => session.selects?.[id]?.getValue?.() || '';
    const draft = session.draft;
    draft.name = value('contrib-name');
    draft.description = value('contrib-description');
    draft.version = value('contrib-version');
    if (session.needsSecurity) {
      draft.security = {
        network_access: select('contrib-network-access'),
        network_allowlist: value('contrib-network-allowlist'),
        file_access: select('contrib-file-access'),
        command_access: select('contrib-command-access'),
        external_tools: value('contrib-external-tools'),
        sensitive_data: select('contrib-sensitive-data'),
      };
    }
    return draft;
  }

  async function saveComplete() {
    const draft = readComplete();
    const security = draft.security;
    if (session.needsSecurity) {
      if (!security.network_access || !security.file_access || !security.command_access || !security.sensitive_data) {
        await root.uiAlert(tr('skills.contribute_security_required', 'Choose an answer for every security item.'));
        return;
      }
      if (security.network_access === 'restricted' && !security.network_allowlist.trim()) {
        await root.uiAlert(tr('skills.contribute_security_network_required', 'List at least one allowed domain.'));
        return;
      }
      if (security.command_access === 'declared_tools' && !security.external_tools.trim()) {
        await root.uiAlert(tr('skills.contribute_security_tools_required', 'List at least one command or external tool.'));
        return;
      }
    }
    const token = session.token;
    const next = await root.cogseed.invoke('contribution.complete', {
      token,
      name: draft.name,
      description: draft.description,
      version: draft.version,
      ...(session.needsSecurity ? { security_declaration: security } : {}),
    });
    if (!session || session.token !== token) return;
    next.originPrefill = session.originPrefill;
    session.state = next;
    session.declarationNote = '';
    if (hasMissing(next)) {
      if ((next.completion?.missing || []).includes('security_manifest')) session.needsSecurity = true;
      seedDraft(next);
      renderContribute();
      return;
    }
    await runCheck();
  }

  function seedDraft(state) {
    const present = state?.completion?.present || {};
    const draft = session.draft;
    draft.name = present.name || draft.name || '';
    draft.description = present.description || draft.description || '';
    draft.version = present.version || draft.version || '';
  }

  // Stage 2 — local checks (one recheck call; progress is indeterminate by design).
  async function runCheck() {
    const token = session.token;
    session.stage = 'check';
    session.checkResult = 'running';
    renderContribute();
    const cancelled = new Promise((resolve) => { session.cancelCheck = () => resolve({ kind: 'cancel' }); });
    const check = root.cogseed.invoke('contribution.recheck', { token })
      .then((result) => ({ kind: 'result', result }), (error) => ({ kind: 'error', error }));
    const outcome = await Promise.race([check, cancelled]);
    if (!session || session.token !== token) return;
    session.cancelCheck = null;
    if (outcome.kind === 'cancel') {
      await root.cogseed.invoke('contribution.cancel', { token });
      session.token = null;
      leaveToSkills();
      return;
    }
    if (outcome.kind === 'error') throw outcome.error;
    const result = outcome.result;
    result.originPrefill = session.originPrefill;
    session.state = result;
    const kind = model.classifyAdmission(result?.admission);
    if (kind === 'needs_declaration') {
      session.needsSecurity = true;
      session.state.completion = {
        ...(result.completion || {}),
        missing: Array.from(new Set([...(result.completion?.missing || []), 'security_manifest'])),
      };
      session.declarationNote = tr(`skills.contribute_reason.${result.admission.reason}`, '');
      seedDraft(result);
      session.stage = 'complete';
      renderContribute();
      return;
    }
    if (kind === 'passed') {
      session.stage = 'preview';
      session.selectedFile = 0;
      session.fileCache = {};
      session.sending = false;
      renderContribute();
      void loadFile(0);
      return;
    }
    session.checkResult = kind;
    renderContribute();
  }

  function checkRowHtml(row) {
    const tone = row.state === 'ok' ? 'success' : row.state === 'blocked' ? 'critical' : 'attention';
    const name = tr(`skills.contribute_check_row.${row.id}`, row.id);
    const version = row.version ? ` v${row.version}` : '';
    const detail = row.id === 'local' && row.count
      ? fmt(tr('skills.contribute_check_issue_count', '{count} issues'), { count: row.count })
      : row.id === 'declaration' && row.ontologyVersion
        ? `${tr(`skills.contribute_check_state.${row.state}`, row.state)} · ${tr('skills.contribute_check_ontology', 'Ontology')} ${row.ontologyVersion}`
        : tr(`skills.contribute_check_state.${row.state}`, row.state);
    const mark = row.state === 'ok' ? 'check-circle' : row.state === 'blocked' ? 'x-circle' : row.state === 'skipped' ? 'dot' : 'warning';
    return `<li class="hubc-check-row is-${tone}" data-check-state="${esc(row.state)}">${icon(mark)}<strong>${esc(name + version)}</strong><span>${esc(detail)}</span></li>`;
  }

  function checkHtml() {
    const s = session;
    const result = s.checkResult;
    const running = result === 'running';
    const pill = running ? { label: tr('skills.contribute_check_running', 'Checking'), tone: 'attention' }
      : result === 'blocked' ? { label: tr('skills.contribute_check_blocked', 'Blocking issues'), tone: 'critical' }
        : { label: tr('skills.contribute_check_unavailable', 'Check unavailable'), tone: 'attention' };
    const title = running ? tr('skills.contribute_checking', 'Running local checks')
      : result === 'blocked' ? tr('skills.contribute_check_blocked_title', 'Local checks found blocking issues')
        : tr('skills.contribute_check_unavailable_title', 'Local checks could not finish');
    const hint = running ? tr('skills.contribute_checking_hint', 'No package bytes are sent while local checks run.')
      : tr('skills.contribute_check_done_hint', 'No file left this device. Fix the items below, then check again.');
    let body;
    if (running) {
      body = root.uiSkeleton({ ariaLabel: tr('skills.contribute_checking', 'Running local checks'), lines: [54, 92, 78, 66, 84] });
    } else {
      const details = admissionDetails(s.state);
      const rows = model.checkRows(s.state?.admission).map(checkRowHtml).join('');
      body = `<p class="hubc-alert" role="alert">${esc(details.reason)}</p>
        <ul class="hubc-check-list" aria-label="${esc(tr('skills.contribute_check_panel_title', 'Local checks'))}">${rows}</ul>
        ${details.issues.length ? `<ul class="hubc-issues" aria-label="${esc(tr('skills.contribute_check_issues', 'Findings'))}">${details.issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul>` : ''}`;
    }
    return `<section class="hubc-panel" aria-labelledby="hubc-check-title" aria-busy="${running ? 'true' : 'false'}">
      <div class="hubc-section-head"><div><h2 id="hubc-check-title">${esc(title)}</h2><p>${esc(hint)}</p></div>${root.uiStatusPill(pill)}</div>
      ${body}
      <div class="hubc-actions"><p>${esc(running ? tr('skills.contribute_check_footnote_running', 'Files stay on this device until checks finish.') : '')}</p>
        ${running
    ? button({ label: tr('skills.contribute_check_cancel', 'Cancel check'), attrs: { 'data-hubc-action': 'cancel-check' } })
    : button({ label: tr('skills.contribute_check_recheck', 'Check again'), role: 'primary', attrs: { 'data-hubc-action': 'recheck' } })}</div>
    </section>`;
  }

  // Stage 3/4 — preview, declarations and submission.
  function previewFiles() {
    return Array.isArray(session.state?.preview?.files) ? session.state.preview.files : [];
  }

  function originSelected() {
    return session.origin.type || '';
  }

  function previewHtml() {
    const s = session;
    const files = previewFiles();
    const present = s.state?.completion?.present || {};
    const metadata = {
      name: present.name || s.name,
      version: present.version || '',
      description: present.description || '',
    };
    const selected = files[s.selectedFile];
    const fileRows = files.length ? files.map((file, index) => `<li class="hubc-file${index === s.selectedFile ? ' is-selected' : ''}">${button({
      label: file.path, role: 'ghost', size: 'sm', icon: 'file-text',
      attrs: { 'data-hubc-action': 'select-file', 'data-hubc-file-index': index, 'aria-pressed': index === s.selectedFile ? 'true' : 'false' },
    })}<span class="hubc-file__size">${esc(`${Number(file.size) || 0} B`)}</span></li>`).join('')
      : `<li>${root.uiEmptyState({ title: tr('skills.contribute_preview_files_empty', 'No files in this submission') })}</li>`;
    const sending = s.sending === true;
    const originLocked = Boolean(s.originPrefill?.locked);
    const origin = s.origin;
    const originOptions = ORIGIN_TYPES.map((type) => ({ value: type, label: tr(`skills.contribute_origin.${type}`, type) }));
    const derived = origin.type === 'derived_from_hub';
    const refs = originLocked && s.originPrefill?.forked_from
      ? `<p class="hubc-origin-ref">${esc(fmt(tr('skills.contribute_origin_derived_from_ref', 'Derived from Hub content {content_id} v{version}; type and link cannot be changed.'),
        { content_id: s.originPrefill.forked_from.content_id, version: s.originPrefill.forked_from.version }))}</p>`
      : `<div class="hubc-origin-refs" data-hubc-origin-refs${derived ? '' : ' hidden'}>${root.uiForm({
        ariaLabel: tr('skills.contribute_origin_derived_from', 'Derived from Hub content'),
        columns: 2,
        fields: [
          { html: root.uiField({ id: 'hubc-origin-content-id', label: tr('skills.contribute_origin_source_id', 'Hub content ID'), required: true, hint: tr('skills.contribute_origin_content_id', 'Enter the Hub content ID (12 lowercase hex characters).'), control: { kind: 'input', value: origin.contentId } }) },
          { html: root.uiField({ id: 'hubc-origin-version', label: tr('skills.contribute_origin_source_version_label', 'Source version'), required: true, hint: tr('skills.contribute_origin_source_version', 'Enter the Hub source version (SemVer).'), control: { kind: 'input', value: origin.version, placeholder: '1.0.0' } }) },
        ],
      })}</div>`;
    const termsLink = button({
      label: fmt(tr('skills.contribute_terms_link', 'Community Contribution Terms {version}'), { version: s.terms?.version || '' }),
      role: 'ghost', size: 'sm', className: 'hubc-inline-link', attrs: { 'data-hubc-action': 'read-terms' },
    });
    return `<div class="hubc-preview-head hubc-section-head"><div><h2>${esc(tr('skills.contribute_preview_heading', 'Submission preview'))}</h2>
        <p>${esc(tr('skills.contribute_preview_hint', 'These files and details are sent to Hub with this contribution. Open each file to read it.'))}</p></div>
        ${root.uiStatusPill({ label: tr('skills.contribute_preview_readonly', 'Read-only preview'), tone: 'success', check: true })}</div>
      <div class="hubc-preview" data-contribution-preview>
        <section class="hubc-file-list" aria-label="${esc(tr('skills.contribute_file_list_label', 'Submission files'))}">
          <div class="hubc-panel-head"><span>${esc(tr('skills.contribute_file_list_label', 'Submission files'))}</span><span>${esc(fmt(tr('skills.contribute_file_count', '{count} files'), { count: files.length }))}</span></div>
          <ul>${fileRows}</ul>
          <p class="hubc-panel-foot">${esc(tr('skills.contribute_files_note', 'Only the listed files and metadata will be sent.'))}</p>
        </section>
        <section class="hubc-file-content" aria-label="${esc(tr('skills.contribute_file_content_label', 'File content'))}" aria-live="polite">
          <div class="hubc-panel-head">${icon('file-text')}<strong>${esc(selected?.path || '')}</strong><span>${esc(`${Number(selected?.size) || 0} B · ${tr('skills.contribute_file_readonly', 'Read-only')}`)}</span></div>
          <pre data-hubc-file-content>${esc(session.fileCache[s.selectedFile] ?? '')}</pre>
        </section>
      </div>
      <section class="hubc-panel" aria-labelledby="hubc-metadata-title">
        <div class="hubc-section-head"><div><h2 id="hubc-metadata-title">${esc(tr('skills.contribute_metadata_title', 'Details to be submitted'))}</h2>
          <p>${esc(tr('skills.contribute_metadata_source', 'Files and details come from the rechecked submission copy.'))}</p></div>
          ${button({ label: tr('skills.contribute_edit_draft', 'Edit details'), attrs: { 'data-hubc-action': 'edit-draft' } })}</div>
        <dl class="hubc-meta">
          <div><dt>${esc(tr('skills.contribute_meta_name', 'Name'))}</dt><dd>${esc(metadata.name)}</dd></div>
          <div><dt>${esc(tr('skills.contribute_meta_version', 'Version'))}</dt><dd>${esc(metadata.version)}</dd></div>
          <div><dt>${esc(tr('skills.contribute_contributor', 'Contributor'))}</dt><dd>${esc(s.displayName || '')}</dd></div>
          <div><dt>${esc(tr('skills.contribute_terms_version_label', 'Terms version'))}</dt><dd>${esc(s.terms?.version || '')}</dd></div>
        </dl>
        <div class="hubc-meta-desc"><span>${esc(tr('skills.contribute_meta_desc', 'Description'))}</span><p>${esc(metadata.description)}</p></div>
      </section>
      <section class="hubc-panel" aria-labelledby="hubc-declarations-title">
        <h2 id="hubc-declarations-title">${esc(tr('skills.contribute_declarations', 'Contribution declarations'))}</h2>
        <div class="hubc-declaration">
          ${root.uiField({
    id: 'hubc-origin-type', label: tr('skills.contribute_origin_title', 'Origin declaration'), required: true,
    hint: tr('skills.contribute_origin_hint', 'Describe where this Skill really comes from.'),
    control: { kind: 'select', value: origin.type, placeholder: tr('skills.contribute_origin_choose', 'Choose the true origin.'), options: originOptions, disabled: originLocked || sending },
  })}
          ${refs}
          ${root.uiField({
    id: 'hubc-origin-note', label: tr('skills.contribute_origin_note', 'Origin note'),
    control: { kind: 'textarea', value: origin.note, placeholder: tr('skills.contribute_origin_note_optional', 'Add an origin note (optional)'), attrs: { rows: 2 }, disabled: sending },
  })}
        </div>
        <div class="hubc-check"><span class="hubc-check__control">${root.uiCheckbox({ id: 'hubc-accept-terms', label: tr('skills.contribute_terms_accept', 'I have read and accept'), checked: s.accepted.terms, disabled: sending })}</span>
          <span><label for="hubc-accept-terms">${esc(tr('skills.contribute_terms_accept', 'I have read and accept'))}</label> ${termsLink}</span></div>
        <div class="hubc-check"><span class="hubc-check__control">${root.uiCheckbox({ id: 'hubc-accept-maintenance', label: tr('skills.contribute_maint_note', 'I confirm maintenance responsibility.'), checked: s.accepted.maintenance, disabled: sending })}</span>
          <label for="hubc-accept-maintenance">${esc(tr('skills.contribute_maint_note', 'I confirm maintenance responsibility.'))}</label></div>
        <p class="hubc-privacy">${icon('shield-check')}<span>${esc(tr('skills.contribute_privacy_note', 'Install lists, user settings, task text, device information and other Skills are never sent with this submission.'))}</span></p>
      </section>
      <div class="hubc-submit-bar">
        <div><strong>${esc(tr('skills.contribute_submit_bar_title', 'Enters review after submission'))}</strong>
          <span>${esc(tr('skills.contribute_submit_bar_hint', 'Accepted content still needs publishing before it appears in the Hub catalog.'))}</span>
          <span class="hubc-missing" data-hubc-missing role="status"></span></div>
        <div class="hubc-submit-actions">
          ${sending ? button({ label: tr('skills.contribute_cancel_submit', 'Cancel submission'), attrs: { 'data-hubc-action': 'cancel-submit' } }) : ''}
          ${button({
    label: sending ? tr('skills.contribute_submitting', 'Submitting') : tr('skills.contribute_submit', 'Submit for review'),
    role: 'primary', icon: sending ? 'loader' : 'upload', loading: sending, disabled: true,
    attrs: { 'data-hubc-action': 'submit' },
  })}
        </div>
      </div>`;
  }

  function hydratePreview(host) {
    session.selects = hydrateSelects(host, {
      'hubc-origin-type': (value) => {
        session.origin.type = value || '';
        const refs = host.querySelector('[data-hubc-origin-refs]');
        if (refs) refs.hidden = session.origin.type !== 'derived_from_hub';
        updateSubmit();
      },
    });
    updateSubmit();
  }

  function captureDeclarations() {
    const host = hostOf('contribute');
    if (!session || session.stage !== 'preview' || !host.querySelector('#hubc-accept-terms')) return;
    const origin = session.origin;
    const field = (id) => host.querySelector(`#${id}`);
    origin.type = session.selects?.['hubc-origin-type']?.getValue?.() || origin.type || '';
    origin.note = field('hubc-origin-note')?.value ?? origin.note;
    origin.contentId = field('hubc-origin-content-id')?.value ?? origin.contentId;
    origin.version = field('hubc-origin-version')?.value ?? origin.version;
    session.accepted.terms = field('hubc-accept-terms')?.checked === true;
    session.accepted.maintenance = field('hubc-accept-maintenance')?.checked === true;
  }

  function missingDeclarations() {
    const origin = session.origin;
    const missing = [];
    if (!origin.type) missing.push('origin');
    else if (origin.type === 'derived_from_hub' && !session.originPrefill?.locked
      && !(HUB_CONTENT_ID.test(origin.contentId.trim()) && SEMVER.test(origin.version.trim()))) missing.push('origin');
    else if (origin.type === 'third_party' && !origin.note.trim()) missing.push('origin_note');
    if (!session.accepted.terms) missing.push('terms');
    if (!session.accepted.maintenance) missing.push('maintenance');
    return missing;
  }

  // C-FR-005: the submit action stays unavailable and names what is missing.
  function updateSubmit() {
    if (!session || session.stage !== 'preview') return;
    captureDeclarations();
    const host = hostOf('contribute');
    const submit = host.querySelector('[data-hubc-action="submit"]');
    const missing = session.sending ? [] : missingDeclarations();
    if (submit) {
      const blocked = session.sending || missing.length > 0;
      submit.disabled = blocked;
      // uiButton renders `is-disabled` with the attribute; the class carries pointer-events:none.
      submit.classList.toggle('is-disabled', blocked);
    }
    const note = host.querySelector('[data-hubc-missing]');
    if (note) {
      note.textContent = missing.length
        ? fmt(tr('skills.contribute_missing_prefix', 'Still needed: {items}'),
          { items: missing.map((item) => tr(`skills.contribute_missing_item.${item}`, MISSING_FALLBACK[item] || item)).join(', ') })
        : '';
    }
  }

  async function loadFile(index) {
    const s = session;
    const token = s?.token;
    const file = previewFiles()[index];
    if (!s || !file || Object.hasOwn(s.fileCache, index)) return;
    let content;
    try {
      const result = await root.cogseed.invoke('contribution.readFile', { token, path: file.path });
      content = result.binary
        ? tr('skills.contribute_binary_file', 'Binary file ({size} bytes)').replace('{size}', String(result.size || file.size))
        : result.content || '';
    } catch (error) {
      await root.uiAlert(tr('skills.contribute_file_read_failed', 'Could not read this file. Please restart the preview.'));
      return;
    }
    if (session !== s || s.token !== token) return;
    s.fileCache[index] = content;
    if (s.selectedFile === index) {
      const pre = hostOf('contribute').querySelector('[data-hubc-file-content]');
      if (pre) pre.textContent = content;
    }
  }

  function selectFile(index) {
    const files = previewFiles();
    if (!files[index]) return;
    captureDeclarations();
    session.selectedFile = index;
    renderContribute();
    void loadFile(index);
  }

  async function showTerms() {
    if (typeof renderMarkdown !== 'function') throw new Error('contribution requires renderMarkdown');
    const terms = session.terms || {};
    await modal({
      title: tr('skills.contribute_terms_title', 'Community Contribution Terms'),
      description: `${tr('skills.contribute_terms_version', 'Version')} ${terms.version || ''}`,
      size: 'lg',
      bodyHtml: `<article class="markdown-body hubc-terms">${renderMarkdown(terms.body_markdown)}</article>`,
      actions: [{ id: 'close', label: tr('common.close', 'Close'), role: 'primary' }],
    });
  }

  async function submitContribution() {
    const s = session;
    captureDeclarations();
    const missing = missingDeclarations();
    if (missing.length) {
      updateSubmit();
      return;
    }
    const token = s.token;
    const origin = s.origin;
    let forkedFrom = null;
    let note = origin.note;
    if (s.originPrefill?.locked) {
      forkedFrom = s.originPrefill.forked_from;
      if (!forkedFrom?.content_id || !forkedFrom?.version) return;
    } else if (origin.type === 'derived_from_hub') {
      forkedFrom = { content_id: origin.contentId.trim(), version: origin.version.trim() };
    }
    await root.cogseed.invoke('contribution.declare', {
      token, kind: 'origin', origin_type: origin.type, note,
      ...(forkedFrom && !s.originPrefill?.locked ? { forked_from: forkedFrom } : {}),
    });
    await root.cogseed.invoke('contribution.declare', { token, kind: 'terms' });
    await root.cogseed.invoke('contribution.declare', { token, kind: 'maintenance' });
    const confirmed = await root.cogseed.invoke('contribution.confirm', { token, digest: s.state?.preview?.digest });
    if (confirmed?.confirmed !== true) {
      await root.uiAlert(tr('skills.contribute_snapshot_changed', 'The submission no longer matches the preview. Check and preview it again.'));
      await runCheck();
      return;
    }
    await sendSubmission();
  }

  async function sendSubmission() {
    const s = session;
    const token = s.token;
    let replaceConfirmed = false;
    s.sending = true;
    renderContribute();
    try {
      for (;;) {
        const attempt = root.cogseed.invoke('contribution.submit', {
          token,
          ...(s.targetContentId ? { target_content_id: s.targetContentId } : {}),
          ...(replaceConfirmed ? { replace_confirmed: true } : {}),
        }).then((result) => ({ kind: 'result', result }), (error) => ({ kind: 'error', error }));
        const cancelled = new Promise((resolve) => { s.cancelUpload = () => resolve({ kind: 'cancel' }); });
        const outcome = await Promise.race([attempt, cancelled]);
        s.cancelUpload = null;
        if (session !== s) return;
        if (outcome.kind === 'cancel') {
          await root.cogseed.invoke('contribution.abortUpload', { token });
          await attempt;
          if (typeof root.uiToast === 'function') root.uiToast(tr('skills.contribute_cancelled_toast', 'Submission cancelled. The preview stays on this device.'));
          break;
        }
        if (outcome.kind === 'error') throw outcome.error;
        const submitted = outcome.result;
        if (submitted?.reason === 'replacement_confirmation_required') {
          replaceConfirmed = await root.uiConfirm({
            message: tr('skills.contribute_replace_confirm', 'This will replace your pending submission for the same content. Continue?'),
            okLabel: tr('common.continue', 'Continue'),
          });
          if (replaceConfirmed) continue;
          break;
        }
        if (submitted?.ok) {
          s.token = null;
          if (typeof root.uiToast === 'function') root.uiToast(tr('skills.contribute_submitted_toast', 'Submitted for review. Track progress in My contributions.'), { variant: 'success' });
          await endSession();
          await openMyContributions({ skipIdentity: true });
          return;
        }
        const retryable = submitted?.error?.retryable === true || submitted?.retryable === true || submitted?.reason === 'snapshot_drift';
        if (!retryable) {
          const localMessage = submitted?.reason === 'version_not_higher'
            ? tr('skills.contribute_version_not_higher', 'The version must be higher than {version}.').replace('{version}', submitted.current_version || '')
            : submitted?.reason === 'invalid_semver'
              ? tr('skills.contribute_invalid_semver', 'Enter a valid semantic version, for example 1.2.0.')
              : submitted?.reason === 'target_version_unavailable'
                ? tr('skills.contribute_target_refresh', 'Refresh My contributions before submitting a new version.')
                : '';
          await root.uiAlert(localMessage || errorText(submitted?.error, tr('skills.contribute_submit_failed', 'Submission was not confirmed.')));
          break;
        }
        const retry = await root.uiConfirm({
          message: errorText(submitted?.error, tr('skills.contribute_submit_retry', 'Hub did not confirm receipt. Retry the exact same package?')),
          okLabel: tr('common.retry', 'Retry'),
        });
        if (!retry) break;
      }
    } finally {
      if (session === s) {
        s.sending = false;
        s.cancelUpload = null;
        if (s.stage === 'preview') renderContribute();
      }
    }
  }

  async function startSkillContribution(skillId, name, targetContentId, previousOrigin) {
    try {
      await endSession();
      const preflight = await ensureIdentity(name);
      if (!preflight) return;
      const termsResponse = await root.cogseed.invoke('contribution.terms', {});
      if (termsResponse?.state?.status !== 'open') {
        await root.uiAlert(termsResponse?.state?.status === 'closed'
          ? tr('skills.contribute_terms_closed', 'Contribution is not open right now.')
          : tr('skills.contribute_terms_unavailable', 'Could not load the current terms.'));
        return;
      }
      const state = await root.cogseed.invoke('contribution.start', { skill_id: skillId, defer_check: true });
      if (!state?.token) return;
      const prefill = state.originPrefill || null;
      session = {
        token: state.token,
        skillId,
        name: name || skillId,
        targetContentId: targetContentId || '',
        terms: termsResponse.state.terms,
        displayName: state.identity?.displayName || preflight.identity?.displayName || '',
        originPrefill: prefill,
        state,
        stage: 'complete',
        needsSecurity: (state.completion?.missing || []).includes('security_manifest'),
        declarationNote: '',
        checkResult: 'running',
        draft: {
          name: '', description: '', version: '',
          security: { network_access: '', network_allowlist: '', file_access: '', command_access: '', external_tools: '', sensitive_data: '' },
        },
        origin: {
          type: prefill?.locked ? 'derived_from_hub' : (previousOrigin?.type || ''),
          note: prefill?.locked ? '' : String(previousOrigin?.note || ''),
          contentId: String(previousOrigin?.forked_from?.content_id || ''),
          version: String(previousOrigin?.forked_from?.version || ''),
        },
        accepted: { terms: false, maintenance: false },
        selectedFile: 0,
        fileCache: {},
        sending: false,
        selects: {},
      };
      seedDraft(state);
      stopMinePoll();
      if (hasMissing(state)) {
        renderContribute();
        return;
      }
      await runCheck();
    } catch (error) {
      await failFlow(error);
    }
  }

  async function failFlow(error) {
    if (root.createLogger) root.createLogger('hub-contributions').warn('flow failed', { error: String(error) });
    await root.uiAlert(tr('skills.contribute_start_failed', 'Could not start contribution.'));
    if (session) leaveToSkills();
  }

  async function chooseLocalSkill(targetContentId, previousOrigin) {
    const skills = typeof root.getCustomContributionSkills === 'function' ? root.getCustomContributionSkills() : [];
    if (!skills.length) {
      await root.uiAlert(tr('skills.contribute_no_local_skill', 'Create or import a local Skill before submitting a new version.'));
      return;
    }
    const selected = await root.uiChoice({
      title: tr('skills.contribute_new_version', 'Submit new version'),
      message: tr('skills.contribute_choose_local', 'Choose the local Skill that contains the new version.'),
      choices: skills.map((skill) => ({ id: skill.id, label: skill.name || skill.id })),
    });
    const skill = skills.find((entry) => entry.id === selected);
    if (skill) await startSkillContribution(skill.id, skill.name || skill.id, targetContentId, previousOrigin);
  }

  // ── My contributions page ──

  function mineFilterControl() {
    return root.uiSegmentedControl({
      ariaLabel: tr('skills.contribute_mine_filters', 'Filter contributions'),
      value: mine.filter,
      items: MINE_FILTERS.map((value) => ({
        value, label: tr(`skills.contribute_mine_filter.${value}`, value), attrs: { 'data-hubc-filter': value },
      })),
    });
  }

  function mineDetailMessage(entry) {
    if (entry.status === 'PENDING_REVIEW' || entry.status === 'PENDING') {
      return tr('skills.contribute_mine_msg.pending', 'Operations is reviewing this submission. You can withdraw it before review.');
    }
    if (entry.status === 'RETURNED' || entry.status === 'REJECTED') {
      return entry.returnedReason || tr('skills.contribute_mine_msg.returned', 'The submission was returned. Revise it and submit again.');
    }
    if (entry.status === 'WITHDRAWN') return tr('skills.contribute_mine_msg.withdrawn', 'You withdrew this pending submission.');
    return entry.publishedVersion
      ? fmt(tr('skills.contribute_mine_msg.published', 'Published version v{version}. A new version needs review and publishing again.'), { version: entry.publishedVersion })
      : tr('skills.contribute_mine_msg.accepted', 'Review accepted; the publisher has not published it yet.');
  }

  function mineDetailHtml(entry) {
    if (!entry) {
      return root.uiEmptyState({
        title: tr('skills.contribute_mine_pick', 'Select a contribution'),
        hint: tr('skills.contribute_mine_pick_hint', 'See its status and the actions available.'),
      });
    }
    const actions = model.detailActions(entry);
    const buttons = [
      actions.newVersion ? button({
        label: entry.status === 'RETURNED' ? tr('skills.contribute_resubmit', 'Revise and resubmit') : tr('skills.contribute_new_version', 'Submit new version'),
        role: 'primary', attrs: { 'data-hubc-action': 'new-version', 'data-hubc-key': entry.key },
      }) : (actions.resubmit ? button({
        label: tr('skills.contribute_resubmit', 'Revise and resubmit'), role: 'primary', attrs: { 'data-hubc-action': 'resubmit' },
      }) : ''),
      actions.withdrawPending ? button({
        label: tr('skills.contribute_withdraw_pending', 'Withdraw submission'), role: 'danger', attrs: { 'data-hubc-action': 'withdraw-pending', 'data-hubc-key': entry.key },
      }) : '',
      actions.requestWithdrawal ? button({
        label: tr('skills.contribute_request_withdrawal', 'Request withdrawal'), role: 'danger', attrs: { 'data-hubc-action': 'request-withdrawal', 'data-hubc-key': entry.key },
      }) : '',
      actions.withdrawalHistory ? button({
        label: tr('skills.contribute_withdrawal_history', 'Withdrawal history'), attrs: { 'data-hubc-action': 'withdrawal-history', 'data-hubc-key': entry.key },
      }) : '',
    ].filter(Boolean).join('');
    const lifecycle = ['disabled', 'withdrawn'].includes(entry.contentStatus)
      ? `<p class="hubc-detail__note">${esc(fmt(tr('skills.contribute_lifecycle_recovery_notice',
        'This content is {status}. A higher-version submission still requires a governance role to restore availability after publication.'),
      { status: tr(`skills.contribute_lifecycle.${entry.contentStatus}`, entry.contentStatus) }))}</p>` : '';
    const origin = entry.origin?.type
      ? `<div class="hubc-block"><span>${esc(tr('skills.contribute_origin_title', 'Origin declaration'))}</span><strong>${esc(tr(`skills.contribute_origin.${entry.origin.type}`, entry.origin.type))}</strong></div>` : '';
    const withdrawal = entry.withdrawal
      ? `<div class="hubc-block"><span>${esc(tr('skills.contribute_withdrawal_status', 'Withdrawal'))}</span><strong>${esc(tr(`skills.contribute_withdrawal_state.${entry.withdrawal.status}`, entry.withdrawal.status))}</strong>
          <p>${esc(entry.withdrawal.rejectedReason || entry.withdrawal.reason)}</p></div>` : '';
    return `<h2>${esc(entry.title)}</h2>
      <span class="hubc-detail__id">${esc(entry.contentId || entry.submissionId || entry.key)}</span>
      ${root.uiStatusPill(statusDescriptor(entry.status || tr('skills.contribute_status_unknown', 'Unknown')))}
      <div class="hubc-block"><span>${esc(tr('skills.contribute_mine_latest', 'Latest submission'))}</span>
        <strong>${esc([entry.version ? `v${entry.version}` : '', formatTime(entry.submittedAt)].filter(Boolean).join(' · '))}</strong>
        <p>${esc(mineDetailMessage(entry))}</p></div>
      ${entry.publishedVersion ? `<div class="hubc-block"><span>${esc(tr('skills.contribute_published_version', 'Published version'))}</span><strong>v${esc(entry.publishedVersion)}</strong></div>` : ''}
      ${origin}${withdrawal}${lifecycle}
      <div class="hubc-detail__actions">${buttons}</div>`;
  }

  function mineRowHtml(entry) {
    const selected = entry.key === mine.selected;
    const withdrawal = entry.withdrawal
      ? ` · ${tr(`skills.contribute_withdrawal_state.${entry.withdrawal.status}`, entry.withdrawal.status)}` : '';
    return `<li class="hubc-row${selected ? ' is-selected' : ''}" data-hubc-row="${esc(entry.key)}">
      <div class="hubc-row__name">${button({
    label: entry.title, role: 'ghost', size: 'sm',
    attrs: { 'data-hubc-action': 'select-row', 'data-hubc-key': entry.key, 'aria-pressed': selected ? 'true' : 'false' },
  })}<small>${esc((entry.contentId || entry.submissionId || entry.key) + withdrawal)}</small></div>
      <div class="hubc-row__cell">${root.uiStatusPill(statusDescriptor(entry.status || tr('skills.contribute_status_unknown', 'Unknown')))}<small>${esc(formatTime(entry.submittedAt))}</small></div>
      <div class="hubc-row__cell">${esc(entry.publishedVersion ? `v${entry.publishedVersion}` : '—')}</div>
    </li>`;
  }

  function renderMineList() {
    const host = hostOf('mine');
    const visible = model.filterHistory(mine.items, { filter: mine.filter, query: mine.query });
    if (!visible.some((entry) => entry.key === mine.selected)) mine.selected = visible[0]?.key || null;
    const list = host.querySelector('[data-hubc-list]');
    const detail = host.querySelector('[data-hubc-detail]');
    if (!list || !detail) return;
    // The list is rebuilt on every selection; keep keyboard focus on the selected row.
    const listHadFocus = list.contains(document.activeElement);
    list.innerHTML = visible.length
      ? `<ul>${visible.map(mineRowHtml).join('')}</ul>`
      : mine.loading && !mine.items.length
        ? root.uiSkeleton({ ariaLabel: tr('skills.contribute_mine', 'My contributions'), lines: [48, 90, 74] })
        : root.uiEmptyState({
        title: mine.items.length ? tr('skills.contribute_mine_no_match', 'No matching contributions') : tr('skills.contribute_mine_empty', 'No contributions yet'),
        hint: mine.items.length ? tr('skills.contribute_mine_no_match_hint', 'Adjust the filters and try again.') : undefined,
      });
    detail.innerHTML = mineDetailHtml(visible.find((entry) => entry.key === mine.selected));
    if (listHadFocus) list.querySelector('[aria-pressed="true"]')?.focus();
    const filters = host.querySelector('[data-hubc-filters]');
    if (filters) {
      const hadFocus = filters.contains(document.activeElement);
      filters.innerHTML = mineFilterControl();
      if (hadFocus) filters.querySelector('[aria-pressed="true"]')?.focus();
    }
  }

  function renderMine() {
    const host = hostOf('mine');
    if (!mine || !host) return;
    const stats = model.historyStats(mine.items);
    const synced = formatTime(mine.generatedAt);
    const searchFocused = document.activeElement?.id === 'hubc-mine-search';
    host.innerHTML = `<div class="hubc-page" data-hubc-page="mine">
      ${backline(tr('skills.contribute_mine', 'My contributions'))}
      <header class="hubc-heading hubc-heading--center"><div><h1>${esc(tr('skills.contribute_mine', 'My contributions'))}</h1>
        <p>${esc(tr('skills.contribute_mine_desc', 'See submissions and review status, and look after published Skills.'))}</p></div>
        ${button({ label: tr('common.refresh', 'Refresh'), icon: 'refresh', loading: mine.loading, attrs: { 'data-hubc-action': 'mine-refresh' } })}</header>
      ${mine.stale ? `<p class="hubc-alert" role="status">${esc(tr('skills.contribute_mine_stale', 'Hub could not be refreshed; showing the last saved result.'))}</p>` : ''}
      <div class="hubc-summary">
        <span><strong>${esc(stats.total)}</strong>${esc(tr('skills.contribute_mine_total', 'contributions'))}</span>
        <span><strong>${esc(stats.pending)}</strong>${esc(tr('skills.contribute_mine_pending', 'pending review'))}</span>
        <span><strong>${esc(stats.published)}</strong>${esc(tr('skills.contribute_mine_published', 'published'))}</span>
        <small>${esc(synced ? fmt(tr('skills.contribute_mine_synced', 'Last synced {time}'), { time: synced }) : '')}</small>
      </div>
      <div class="hubc-toolbar"><div data-hubc-filters>${mineFilterControl()}</div>
        <div class="hubc-search">${root.uiInput({ id: 'hubc-mine-search', type: 'search', value: mine.query, placeholder: tr('skills.contribute_mine_search', 'Search my contributions'), attrs: { 'aria-label': tr('skills.contribute_mine_search', 'Search my contributions') } })}</div></div>
      <div class="hubc-master">
        <section class="hubc-list" aria-label="${esc(tr('skills.contribute_mine_list', 'Contribution list'))}">
          <div class="hubc-list__head"><span>${esc(tr('skills.contribute_mine_col_skill', 'Skill'))}</span><span>${esc(tr('skills.contribute_mine_col_latest', 'Latest submission'))}</span><span>${esc(tr('skills.contribute_published_version', 'Published version'))}</span></div>
          <div data-hubc-list></div>
        </section>
        <aside class="hubc-detail" aria-label="${esc(tr('skills.contribute_mine_detail', 'Contribution details'))}" data-hubc-detail></aside>
      </div></div>`;
    showView('mine');
    renderMineList();
    if (searchFocused) {
      const search = host.querySelector('#hubc-mine-search');
      if (search) {
        search.focus();
        search.setSelectionRange?.(search.value.length, search.value.length);
      }
    }
  }

  async function loadMine() {
    if (!mine) return false;
    mine.loading = true;
    let response;
    try {
      response = await root.cogseed.invoke('contribution.mine', { refresh: true });
    } catch (error) {
      mine.loading = false;
      await root.uiAlert(tr('skills.contribute_start_failed', 'Could not load contributions.'));
      return false;
    }
    if (!mine) return false;
    mine.loading = false;
    if (!response?.cache) {
      await root.uiAlert(tr(`skills.contribute_reason.${response?.reason}`, tr('skills.contribute_unavailable', 'Contribution is unavailable.')));
      return false;
    }
    mine.items = model.normalizeItems(response.cache.items);
    mine.stale = response.stale === true;
    mine.generatedAt = response.cache.last_success_at || response.cache.generated_at || '';
    renderMine();
    return true;
  }

  async function openMyContributions(options) {
    try {
      if (!options?.skipIdentity && !await ensureIdentity(tr('skills.contribute_mine', 'My contributions'))) return;
      await endSession();
      mine = { items: [], filter: 'all', query: '', selected: null, stale: false, generatedAt: '', loading: true };
      renderMine();
      if (!await loadMine()) {
        leaveToSkills();
        return;
      }
      stopMinePoll();
      // Refresh only while this page is foregrounded; leaving it stops polling.
      minePoll = setInterval(() => {
        if (!viewVisible('mine')) { stopMinePoll(); return; }
        void loadMine();
      }, MINE_POLL_MS);
    } catch (error) {
      await root.uiAlert(tr('skills.contribute_start_failed', 'Could not load contributions.'));
      if (mine) leaveToSkills();
    }
  }

  async function mineAction(action, key) {
    const entry = mine?.items.find((item) => item.key === key);
    if (action === 'resubmit') return chooseLocalSkill();
    if (!entry) return undefined;
    if (action === 'new-version') return chooseLocalSkill(entry.contentId, entry.origin || null);
    if (action === 'withdraw-pending') {
      if (!await root.uiConfirmDanger({ message: tr('skills.contribute_withdraw_pending_confirm', 'Withdraw this pending submission?') })) return undefined;
      const result = await root.cogseed.invoke('contribution.withdrawPending', { submission_id: entry.submissionId });
      if (!result?.ok) await root.uiAlert(errorText(result?.error, tr('skills.contribute_action_failed', 'The action could not be completed.')));
      else {
        if (typeof root.uiToast === 'function') root.uiToast(tr('skills.contribute_withdrawn_toast', 'Pending submission withdrawn.'), { variant: 'success' });
        await loadMine();
      }
      return undefined;
    }
    if (action === 'request-withdrawal') {
      const understood = await root.uiConfirm({
        message: tr('skills.contribute_withdrawal_notice', 'A withdrawal request takes effect only after governance review. The content remains published while pending.'),
        okLabel: tr('common.continue', 'Continue'),
      });
      if (!understood) return undefined;
      const reason = await root.uiPrompt(tr('skills.contribute_withdrawal_reason', 'Explain why this published content should be withdrawn.'), '');
      if (!reason) return undefined;
      const result = await root.cogseed.invoke('contribution.requestWithdrawal', { content_id: entry.contentId, reason });
      if (!result?.ok) await root.uiAlert(errorText(result?.error, tr('skills.contribute_action_failed', 'The action could not be completed.')));
      else {
        if (typeof root.uiToast === 'function') root.uiToast(tr('skills.contribute_withdrawal_requested_toast', 'Withdrawal request submitted; waiting for governance review.'), { variant: 'success' });
        await loadMine();
      }
      return undefined;
    }
    if (action === 'withdrawal-history') {
      const result = await root.cogseed.invoke('contribution.withdrawalHistory', { content_id: entry.contentId });
      if (!result?.ok) {
        await root.uiAlert(errorText(result?.error, tr('skills.contribute_action_failed', 'The action could not be completed.')));
        return undefined;
      }
      const rows = Array.isArray(result.result?.items) ? result.result.items : [];
      const historyBody = rows.length ? rows.map((row) => root.uiResourceCard({
        title: tr('skills.contribute_withdrawal_record', 'Withdrawal request'),
        description: [String(row.requested_at || ''), String(row.rejected_reason || row.reason || '')].filter(Boolean).join(' · '),
        status: statusDescriptor(row.status, 'skills.contribute_withdrawal_state'),
      })).join('') : root.uiEmptyState({ title: tr('skills.contribute_withdrawal_history_empty', 'No withdrawal requests') });
      await modal({
        title: tr('skills.contribute_withdrawal_history', 'Withdrawal history'),
        bodyHtml: root.uiResourceGrid({ bodyHtml: historyBody }),
        actions: [{ id: 'close', label: tr('common.close', 'Close') }],
      });
    }
    return undefined;
  }

  // ── Events ──

  async function onClick(event) {
    const target = event.target.closest('[data-hubc-action], [data-hubc-row]');
    if (!target) return;
    const action = target.dataset.hubcAction || 'select-row';
    const key = target.dataset.hubcKey || target.dataset.hubcRow || '';
    try {
      if (action === 'back') leaveToSkills();
      else if (action === 'complete-save') await saveComplete();
      else if (action === 'cancel-check') session?.cancelCheck?.();
      else if (action === 'recheck') await runCheck();
      else if (action === 'select-file') selectFile(Number(target.dataset.hubcFileIndex));
      else if (action === 'edit-draft') {
        captureDeclarations();
        seedDraft(session.state);
        session.stage = 'complete';
        renderContribute();
      } else if (action === 'read-terms') await showTerms();
      else if (action === 'submit') await submitContribution();
      else if (action === 'cancel-submit') session?.cancelUpload?.();
      else if (action === 'mine-refresh') {
        mine.loading = true;
        renderMine();
        await loadMine();
      } else if (action === 'select-row') {
        mine.selected = key;
        renderMineList();
      } else await mineAction(action, key);
    } catch (error) {
      if (session) await failFlow(error);
      else {
        if (root.createLogger) root.createLogger('hub-contributions').warn('action failed', { error: String(error) });
        await root.uiAlert(tr('skills.contribute_action_failed', 'The action could not be completed.'));
      }
    }
  }

  function onInput(event) {
    if (event.target?.id === 'hubc-mine-search' && mine) {
      mine.query = event.target.value || '';
      renderMineList();
      return;
    }
    if (session?.stage === 'preview') updateSubmit();
  }

  function onFilterClick(event) {
    const filter = event.target.closest('[data-hubc-filter]');
    if (!filter || !mine) return;
    mine.filter = filter.dataset.hubcFilter;
    renderMineList();
  }

  function mountMineAction() {
    const actions = document.querySelector('#skills-grid-view .skills-resource-toolbar-controls .header-actions');
    if (!actions || actions.querySelector('[data-contribution-mine]') || typeof root.uiButton !== 'function') return;
    const html = root.uiButton({ label: tr('skills.contribute_mine', 'My contributions'), size: 'sm', attrs: { 'data-contribution-mine': true } });
    const more = actions.querySelector('#skills-more-btn');
    if (more) more.insertAdjacentHTML('beforebegin', html);
    else actions.insertAdjacentHTML('beforeend', html);
    actions.querySelector('[data-contribution-mine]').addEventListener('click', () => openMyContributions().catch(async () => {
      await root.uiAlert(tr('skills.contribute_start_failed', 'Could not load contributions.'));
    }));
  }

  function bindViews() {
    for (const kind of ['contribute', 'mine']) {
      const host = hostOf(kind);
      if (!host || host.dataset.hubcBound === 'true') continue;
      host.dataset.hubcBound = 'true';
      host.addEventListener('click', (event) => { void onClick(event); });
      host.addEventListener('click', onFilterClick);
      host.addEventListener('input', onInput);
      host.addEventListener('change', onInput);
    }
  }

  function onLanguageChange() {
    const label = document.querySelector('[data-contribution-mine] .ui-button__label');
    if (label) label.textContent = tr('skills.contribute_mine', 'My contributions');
    if (session && viewVisible('contribute')) {
      if (session.stage === 'complete') readComplete();
      else captureDeclarations();
      renderContribute();
    }
    if (mine && viewVisible('mine')) renderMine();
  }

  root.startSkillContribution = startSkillContribution;
  root.openMyContributions = openMyContributions;
  root.hideContributionViews = hideContributionViews;
  if (typeof root.addEventListener === 'function') root.addEventListener('i18n-change', onLanguageChange);
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    bindViews();
    mountMineAction();
  }
})(window);
