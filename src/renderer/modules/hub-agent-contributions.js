// Hub Agent contribution page (registry HUBC-PV-004). Same visual language and shared ui*
// seams as the Skill contribution flow (hub-contributions.js, HUBC-PV-001/002); it reuses that
// module's identity gate, error text and "My contributions" page through
// `window.hubContributionsShared`, so this file only owns what is Agent-specific:
//   checks (Agent + each bundled Skill) -> preview + declarations + version -> submit.
// Business rules live in main (features/contribution/agent-contribution.ts); this page only
// renders what the `contribution.agent.*` channels return. Pure derivations are in
// hub-contributions-model.js (agentCheckRows / agentMissing / classifyAgentAdmission).
(function initHubAgentContributions(root) {
  'use strict';

  const model = root.HubContributionsModel;
  const shared = root.hubContributionsShared;
  if (!model || !shared) return;
  const { tr, fmt, esc, errorText } = shared;
  // An Agent has no "derived from Hub" prefill (no forked_from source), so only these two apply.
  const ORIGIN_TYPES = ['original', 'third_party'];
  const STEPS = ['check', 'preview', 'send'];

  let session = null;

  function host() {
    return document.getElementById('agents-contribute-view');
  }

  function icon(name) {
    return typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name, 'hubc-icon') : '';
  }

  function button(options) {
    return root.uiButton(options);
  }

  function showView() {
    const grid = document.getElementById('agents-grid-view');
    const detail = document.getElementById('agents-detail-view');
    if (grid) grid.style.display = 'none';
    if (detail) detail.style.display = 'none';
    const el = host();
    if (el) el.style.display = 'flex';
  }

  async function endSession() {
    const current = session;
    session = null;
    if (!current) return;
    if (typeof current.cancelUpload === 'function') current.cancelUpload();
    if (current.token) await root.cogseed.invoke('contribution.cancel', { token: current.token }).catch(() => {});
  }

  // Called by agents.js whenever the grid or detail view takes over again.
  function hideAgentContributionViews() {
    void endSession();
    // 从智能体页进入的「我的贡献」也在智能体页签里，一并收起（该模块为懒加载，可能尚未加载）
    if (typeof root.hideContributionViews === 'function') root.hideContributionViews();
    const el = host();
    if (el) {
      el.style.display = 'none';
      el.innerHTML = '';
    }
  }

  function leaveToAgents() {
    hideAgentContributionViews();
    if (typeof root._showAgentsGridView === 'function') root._showAgentsGridView();
    else {
      const grid = document.getElementById('agents-grid-view');
      if (grid) grid.style.display = 'flex';
    }
  }

  function backline() {
    return `<div class="hubc-backline">${button({
      label: tr('agents.contribute_back', 'Back to agents'), role: 'ghost', size: 'sm', icon: 'arrow-left',
      attrs: { 'data-hubc-agent-action': 'back' },
    })}</div>`;
  }

  function stepIndex() {
    if (!session) return 0;
    if (session.stage === 'check') return 0;
    return session.sending ? 2 : 1;
  }

  function stepsHtml() {
    const current = stepIndex();
    const labels = [
      tr('agents.contribute_step_check', 'Local checks'),
      tr('agents.contribute_step_preview', 'Preview and declarations'),
      tr('agents.contribute_step_send', 'Submit for review'),
    ];
    return `<ol class="hubc-steps" aria-label="${esc(tr('agents.contribute_steps_label', 'Contribution steps'))}">${STEPS.map((stage, index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'todo';
      return `<li class="hubc-step is-${state}"${state === 'current' ? ' aria-current="step"' : ''}>`
        + `<span class="hubc-step__mark" aria-hidden="true">${state === 'done' ? icon('check') : index + 1}</span>`
        + `<span class="hubc-step__label">${esc(labels[index])}</span></li>`;
    }).join('')}</ol>`;
  }

  function pageShell(stageHtml) {
    const s = session;
    const subtitle = s.targetContentId
      ? fmt(tr('agents.contribute_subtitle_version', 'Submit a new version of {id} from “{name}”.'), { id: s.targetContentId, name: s.name })
      : fmt(tr('agents.contribute_subtitle', 'Contribute “{name}” to Hub. Submissions enter review first; accepted content still needs publishing.'), { name: s.name });
    return `<div class="hubc-page" data-hubc-page="agent-contribute">
      ${backline()}
      <header class="hubc-heading"><div><h1>${esc(tr('agents.contribute_title', 'Contribute agent'))}</h1><p>${esc(subtitle)}</p></div>
        ${root.uiStatusPill({ label: tr('agents.contribute_pill_review_only', 'Submitted for review only'), tone: 'neutral' })}</header>
      ${stepsHtml()}
      <div class="hubc-stage" data-hubc-stage="${esc(s.stage)}">${stageHtml}</div>
    </div>`;
  }

  // ── Stage 1: checks ──

  function checkRowHtml(row) {
    const tone = row.state === 'ok' ? 'success' : row.state === 'blocked' ? 'critical' : 'attention';
    const mark = row.state === 'ok' ? 'check-circle' : row.state === 'blocked' ? 'x-circle' : 'warning';
    const name = row.id === 'agent'
      ? tr('agents.contribute_check_agent', 'Agent definition')
      : fmt(tr('agents.contribute_check_skill', 'Bundled skill: {name}'), { name: row.name });
    const detail = row.id === 'agent' && row.count
      ? fmt(tr('agents.contribute_check_issue_count', '{count} issues'), { count: row.count })
      : tr(`agents.contribute_check_state.${row.state}`, row.state);
    return `<li class="hubc-check-row is-${tone}" data-check-state="${esc(row.state)}">${icon(mark)}<strong>${esc(name)}</strong><span>${esc(detail)}</span></li>`;
  }

  function issueText(issue) {
    const where = issue.skill ? `${issue.skill} · ` : '';
    return `${where}${tr(`agents.contribute_rule.${issue.rule}`, issue.message || issue.rule)}${issue.path ? ` (${issue.path})` : ''}`;
  }

  function checkHtml() {
    const s = session;
    const kind = model.classifyAgentAdmission(s.admission);
    const incomplete = kind === 'incomplete';
    const pill = incomplete
      ? { label: tr('agents.contribute_check_incomplete', 'Needs more details'), tone: 'attention' }
      : kind === 'blocked'
        ? { label: tr('agents.contribute_check_blocked', 'Blocking issues'), tone: 'critical' }
        : { label: tr('agents.contribute_check_unavailable', 'Check unavailable'), tone: 'attention' };
    const title = kind === 'blocked' ? tr('agents.contribute_check_blocked_title', 'Local checks found blocking issues')
      : incomplete ? tr('agents.contribute_check_incomplete_title', 'A bundled skill still needs details')
        : tr('agents.contribute_check_unavailable_title', 'Local checks could not finish');
    const blocking = Array.isArray(s.admission?.blocking) ? s.admission.blocking : [];
    const rows = model.agentCheckRows(s.admission).map(checkRowHtml).join('');
    return `<section class="hubc-panel" aria-labelledby="hubc-agent-check-title">
      <div class="hubc-section-head"><div><h2 id="hubc-agent-check-title">${esc(title)}</h2>
        <p>${esc(tr('agents.contribute_check_hint', 'No file left this device. Fix the items below, then check again.'))}</p></div>${root.uiStatusPill(pill)}</div>
      <ul class="hubc-check-list" aria-label="${esc(tr('agents.contribute_check_panel_title', 'Local checks'))}">${rows}</ul>
      ${blocking.length ? `<ul class="hubc-issues" aria-label="${esc(tr('agents.contribute_check_issues', 'Findings'))}">${blocking.map((issue) => `<li>${esc(issueText(issue))}</li>`).join('')}</ul>` : ''}
      <div class="hubc-actions"><p></p>${button({ label: tr('agents.contribute_check_recheck', 'Check again'), role: 'primary', attrs: { 'data-hubc-agent-action': 'recheck' } })}</div>
    </section>`;
  }

  // ── Stage 2: preview, declarations, version ──

  function previewFiles() {
    return Array.isArray(session?.preview?.files) ? session.preview.files : [];
  }

  function handledHtml() {
    const handled = Array.isArray(session.handled) ? session.handled : [];
    if (!handled.length) return '';
    const items = handled.map((item) => `<li>${esc(tr(`agents.contribute_handled.${item.kind}`, item.kind))}: <code>${esc(item.field)}</code></li>`).join('');
    return `<section class="hubc-panel" aria-labelledby="hubc-agent-handled-title">
      <div class="hubc-section-head"><div><h2 id="hubc-agent-handled-title">${esc(tr('agents.contribute_handled_title', 'Removed on this device'))}</h2>
        <p>${esc(tr('agents.contribute_handled_hint', 'These fields were removed from the copy before submission. Your local agent is unchanged, and Hub is not told what was removed.'))}</p></div></div>
      <ul class="hubc-issues">${items}</ul></section>`;
  }

  function referencesHtml() {
    const hub = Array.isArray(session.hubRefs) ? session.hubRefs : [];
    const bundled = Array.isArray(session.bundledSkills) ? session.bundledSkills : [];
    const builtin = Array.isArray(session.builtinRefs) ? session.builtinRefs : [];
    if (!hub.length && !bundled.length && !builtin.length) return '';
    const names = session.hubRefNames || {};
    const hubRows = hub.map((id) => `<li>${names[id] ? `<strong>${esc(names[id])}</strong> ` : ''}<code>${esc(id)}</code> <span>${esc(tr('agents.contribute_ref_hub', 'Hub skill — linked, not submitted'))}</span></li>`).join('');
    const builtinRows = builtin.map((ref) => `<li><strong>${esc(String(ref).replace(/^builtin:/, ''))}</strong> <span>${esc(tr('agents.contribute_ref_builtin', 'Built-in capability — provided by CogSeed, not submitted'))}</span></li>`).join('');
    const bundledRows = bundled.map((name) => `<li><strong>${esc(name)}</strong> <span>${esc(tr('agents.contribute_ref_bundled', 'Your local skill — submitted with this agent'))}</span></li>`).join('');
    return `<section class="hubc-panel" aria-labelledby="hubc-agent-refs-title">
      <div class="hubc-section-head"><div><h2 id="hubc-agent-refs-title">${esc(tr('agents.contribute_refs_title', 'Skills this agent uses'))}</h2></div></div>
      <ul class="hubc-issues">${hubRows}${builtinRows}${bundledRows}</ul></section>`;
  }

  // Spots in the files that may contain local paths or credential-like text. Highlight only: nothing is
  // rewritten, and the user confirms what will be sent (Hub spec US3 scenario 3a).
  function hintsHtml() {
    const grouped = model.hintsByFile(session.hints);
    if (!grouped.size) return '';
    const rows = [...grouped.values()].map((entry) => {
      const index = previewFiles().findIndex((f) => f.path === entry.file);
      const items = entry.items.map((item) => `<li><span class="hubc-hint-kind">${esc(tr(`agents.contribute_hint_kind.${item.kind}`, item.kind))}</span> `
        + `<code>${esc(item.excerpt)}</code> <span class="hubc-hint-where">${esc(fmt(tr('agents.contribute_hint_line', 'line {line}'), { line: item.line }))}</span></li>`).join('');
      const open = index >= 0 ? button({
        label: entry.file, role: 'ghost', size: 'sm', icon: 'file-text',
        attrs: { 'data-hubc-agent-action': 'select-file', 'data-hubc-file-index': index },
      }) : `<strong>${esc(entry.file)}</strong>`;
      return `<li class="hubc-hint-file">${open}<ul class="hubc-issues">${items}</ul></li>`;
    }).join('');
    return `<section class="hubc-panel" aria-labelledby="hubc-agent-hints-title" data-hubc-agent-hints>
      <div class="hubc-section-head"><div><h2 id="hubc-agent-hints-title">${esc(tr('agents.contribute_hints_title', 'May contain information from this device'))}</h2>
        <p>${esc(tr('agents.contribute_hints_hint', 'These places look like a local path or a secret. Nothing was changed — they are highlighted so you can check them. What you see in the preview is exactly what will be sent.'))}</p></div>
        ${root.uiStatusPill({ label: fmt(tr('agents.contribute_hints_count', '{count} places'), { count: session.hints.length }), tone: 'attention' })}</div>
      <ul class="hubc-hint-files">${rows}</ul></section>`;
  }

  function previewHtml() {
    const s = session;
    const files = previewFiles();
    const selected = files[s.selectedFile];
    const sending = s.sending === true;
    const draft = s.draft;
    const hasBundled = s.bundledSkills.length > 0;
    const fileRows = files.map((file, index) => `<li class="hubc-file${index === s.selectedFile ? ' is-selected' : ''}">${button({
      label: file.path, role: 'ghost', size: 'sm', icon: 'file-text',
      attrs: { 'data-hubc-agent-action': 'select-file', 'data-hubc-file-index': index, 'aria-pressed': index === s.selectedFile ? 'true' : 'false' },
    })}<span class="hubc-file__size">${esc(`${Number(file.size) || 0} B`)}</span></li>`).join('');
    const originOptions = ORIGIN_TYPES.map((type) => ({ value: type, label: tr(`skills.contribute_origin.${type}`, type) }));
    const termsLink = button({
      label: fmt(tr('skills.contribute_terms_link', 'Community Contribution Terms {version}'), { version: s.terms?.version || '' }),
      role: 'ghost', size: 'sm', className: 'hubc-inline-link', attrs: { 'data-hubc-agent-action': 'read-terms' },
    });
    return `<div class="hubc-preview-head hubc-section-head"><div><h2>${esc(tr('agents.contribute_preview_heading', 'Submission preview'))}</h2>
        <p>${esc(tr('agents.contribute_preview_hint', 'These files are sent to Hub with this contribution. Open each file to read it.'))}</p></div>
        ${root.uiStatusPill({ label: tr('skills.contribute_preview_readonly', 'Read-only preview'), tone: 'success', check: true })}</div>
      <div class="hubc-preview" data-contribution-preview>
        <section class="hubc-file-list" aria-label="${esc(tr('skills.contribute_file_list_label', 'Submission files'))}">
          <div class="hubc-panel-head"><span>${esc(tr('skills.contribute_file_list_label', 'Submission files'))}</span><span>${esc(fmt(tr('skills.contribute_file_count', '{count} files'), { count: files.length }))}</span></div>
          <ul>${fileRows}</ul>
          <p class="hubc-panel-foot">${esc(tr('skills.contribute_files_note', 'Only the listed files and metadata will be sent.'))}</p>
        </section>
        <section class="hubc-file-content" aria-label="${esc(tr('skills.contribute_file_content_label', 'File content'))}" aria-live="polite">
          <div class="hubc-panel-head">${icon('file-text')}<strong>${esc(selected?.path || '')}</strong></div>
          <pre data-hubc-file-content>${highlighted(s.selectedFile)}</pre>
        </section>
      </div>
      ${hintsHtml()}
      ${referencesHtml()}
      ${handledHtml()}
      <section class="hubc-panel" aria-labelledby="hubc-agent-declarations-title">
        <h2 id="hubc-agent-declarations-title">${esc(tr('agents.contribute_declarations', 'Version and declarations'))}</h2>
        <div class="hubc-declaration">
          ${root.uiField({
    id: 'hubc-agent-version', label: tr('agents.contribute_version', 'Version'), required: true,
    hint: tr('agents.contribute_version_hint', 'Semantic version, for example 1.0.0. A new version must be higher than the published one.'),
    control: { kind: 'input', type: 'text', value: draft.version, placeholder: '1.0.0', disabled: sending },
  })}
          ${root.uiField({
    id: 'hubc-agent-origin-type', label: tr('skills.contribute_origin_title', 'Origin declaration'), required: true,
    hint: tr('agents.contribute_origin_hint', 'Describe where this agent really comes from.'),
    control: { kind: 'select', value: draft.origin.type, placeholder: tr('skills.contribute_origin_choose', 'Choose the true origin.'), options: originOptions, disabled: sending },
  })}
          ${root.uiField({
    id: 'hubc-agent-origin-note', label: tr('skills.contribute_origin_note', 'Origin note'),
    control: { kind: 'textarea', value: draft.origin.note, placeholder: tr('skills.contribute_origin_note_optional', 'Add an origin note (optional)'), attrs: { rows: 2 }, disabled: sending },
  })}
        </div>
        ${session.hints.length ? `<div class="hubc-check"><span class="hubc-check__control">${root.uiCheckbox({
    id: 'hubc-agent-accept-hints', label: tr('agents.contribute_hints_accept', 'I have checked the highlighted places and want to send them as they are'), checked: draft.accepted.hints, disabled: sending,
  })}</span><label for="hubc-agent-accept-hints">${esc(tr('agents.contribute_hints_accept', 'I have checked the highlighted places and want to send them as they are'))}</label></div>` : ''}
        ${hasBundled ? `<div class="hubc-check"><span class="hubc-check__control">${root.uiCheckbox({
    id: 'hubc-agent-accept-skills', label: tr('agents.contribute_skills_accept', 'These skills will be contributed too'), checked: draft.accepted.skills, disabled: sending,
  })}</span><label for="hubc-agent-accept-skills">${esc(fmt(tr('agents.contribute_skills_notice', 'These skills are contributed together with this agent and can only be used by it: {names}'), { names: s.bundledSkills.join(', ') }))}</label></div>` : ''}
        <div class="hubc-check"><span class="hubc-check__control">${root.uiCheckbox({
    id: 'hubc-agent-accept-terms', label: tr('skills.contribute_terms_accept', 'I have read and accept'), checked: draft.accepted.terms, disabled: sending,
  })}</span><span><label for="hubc-agent-accept-terms">${esc(tr('skills.contribute_terms_accept', 'I have read and accept'))}</label> ${termsLink}</span></div>
        <div class="hubc-check"><span class="hubc-check__control">${root.uiCheckbox({
    id: 'hubc-agent-accept-maintenance', label: tr('skills.contribute_maint_note', 'I confirm maintenance responsibility.'), checked: draft.accepted.maintenance, disabled: sending,
  })}</span><label for="hubc-agent-accept-maintenance">${esc(tr('skills.contribute_maint_note', 'I confirm maintenance responsibility.'))}</label></div>
        <p class="hubc-privacy">${icon('shield-check')}<span>${esc(tr('agents.contribute_privacy_note', 'Connector settings, model preferences, install state and other agents are never sent.'))}</span></p>
      </section>
      <div class="hubc-submit-bar">
        <div><strong>${esc(tr('skills.contribute_submit_bar_title', 'Enters review after submission'))}</strong>
          <span>${esc(tr('skills.contribute_submit_bar_hint', 'Accepted content still needs publishing before it appears in the Hub catalog.'))}</span>
          <span class="hubc-missing" data-hubc-agent-missing role="status"></span></div>
        <div class="hubc-submit-actions">
          ${sending ? button({ label: tr('skills.contribute_cancel_submit', 'Cancel submission'), attrs: { 'data-hubc-agent-action': 'cancel-submit' } }) : ''}
          ${button({
    label: sending ? tr('skills.contribute_submitting', 'Submitting') : tr('skills.contribute_submit', 'Submit for review'),
    role: 'primary', icon: sending ? 'loader' : 'upload', loading: sending, disabled: true,
    attrs: { 'data-hubc-agent-action': 'submit' },
  })}
        </div>
      </div>`;
  }

  // Same helper the Skill page uses: hydrate shared selects and index their APIs by host id.
  // File text with the flagged lines marked. The text itself is untouched.
  function highlighted(index) {
    const file = previewFiles()[index];
    const lines = file ? (model.hintsByFile(session.hints).get(file.path)?.lines || new Set()) : new Set();
    // A flagged line is a block (it carries the highlight), so it already ends the line: adding "\n" after
    // it would show an empty line. Plain lines keep their newline.
    const all = model.flagLines(session.fileCache[index] ?? '', lines);
    return all.map((line, i) => {
      if (line.flagged) return `<mark class="hubc-hint-line">${esc(line.text)}</mark>`;
      return i < all.length - 1 ? `${esc(line.text)}\n` : esc(line.text);
    }).join('');
  }

  function hydrateSelects(container) {
    const apis = {};
    if (typeof root.hydrateUiFormSelects !== 'function') return apis;
    const hosts = Array.from(container.querySelectorAll('[data-ui-select]'));
    const hydrated = root.hydrateUiFormSelects(container, {
      'hubc-agent-origin-type': (value) => { session.draft.origin.type = value || ''; updateSubmit(); },
    }) || [];
    hosts.forEach((h, index) => { apis[h.id] = hydrated[index]; });
    return apis;
  }

  function capture() {
    const el = host();
    if (!session || session.stage !== 'preview' || !el?.querySelector('#hubc-agent-accept-terms')) return;
    const field = (id) => el.querySelector(`#${id}`);
    const d = session.draft;
    d.version = field('hubc-agent-version')?.value ?? d.version;
    d.origin.type = session.selects?.['hubc-agent-origin-type']?.getValue?.() || d.origin.type || '';
    d.origin.note = field('hubc-agent-origin-note')?.value ?? d.origin.note;
    d.accepted.terms = field('hubc-agent-accept-terms')?.checked === true;
    d.accepted.maintenance = field('hubc-agent-accept-maintenance')?.checked === true;
    if (session.bundledSkills.length) d.accepted.skills = field('hubc-agent-accept-skills')?.checked === true;
    if (session.hints.length) d.accepted.hints = field('hubc-agent-accept-hints')?.checked === true;
  }

  function missing() {
    const d = session.draft;
    return model.agentMissing({
      origin: d.origin, version: d.version, accepted: d.accepted, hasBundled: session.bundledSkills.length > 0,
      hintCount: session.hints.length,
    });
  }

  // The submit action stays unavailable and names what is missing (C-FR-005, same rule as Skills).
  function updateSubmit() {
    if (!session || session.stage !== 'preview') return;
    capture();
    const el = host();
    const submit = el.querySelector('[data-hubc-agent-action="submit"]');
    const need = session.sending ? [] : missing();
    if (submit) {
      const blocked = session.sending || need.length > 0;
      submit.disabled = blocked;
      submit.classList.toggle('is-disabled', blocked);
    }
    const note = el.querySelector('[data-hubc-agent-missing]');
    if (note) {
      note.textContent = need.length
        ? fmt(tr('skills.contribute_missing_prefix', 'Still needed: {items}'),
          { items: need.map((item) => tr(`agents.contribute_missing_item.${item}`, tr(`skills.contribute_missing_item.${item}`, item))).join(', ') })
        : '';
    }
  }

  function render() {
    if (!session) return;
    const el = host();
    el.innerHTML = pageShell(session.stage === 'check' ? checkHtml() : previewHtml());
    showView();
    if (session.stage === 'preview') {
      session.selects = hydrateSelects(el);
      updateSubmit();
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
      const pre = host().querySelector('[data-hubc-file-content]');
      if (pre) pre.innerHTML = highlighted(index);
    }
  }

  function selectFile(index) {
    if (!previewFiles()[index]) return;
    capture();
    session.selectedFile = index;
    render();
    void loadFile(index);
  }

  async function showTerms() {
    if (typeof renderMarkdown !== 'function') throw new Error('contribution requires renderMarkdown');
    const terms = session.terms || {};
    await root.uiModal({
      closeLabel: tr('common.close', 'Close'),
      title: tr('skills.contribute_terms_title', 'Community Contribution Terms'),
      description: `${tr('skills.contribute_terms_version', 'Version')} ${terms.version || ''}`,
      size: 'lg',
      bodyHtml: `<article class="markdown-body hubc-terms">${renderMarkdown(terms.body_markdown)}</article>`,
      actions: [{ id: 'close', label: tr('common.close', 'Close'), role: 'primary' }],
    });
  }

  // ── Submit ──

  async function submit() {
    const s = session;
    capture();
    if (missing().length) { updateSubmit(); return; }
    const token = s.token;
    const d = s.draft;
    await root.cogseed.invoke('contribution.declare', { token, kind: 'origin', origin_type: d.origin.type, note: d.origin.note });
    await root.cogseed.invoke('contribution.declare', { token, kind: 'terms' });
    await root.cogseed.invoke('contribution.declare', { token, kind: 'maintenance' });
    const confirmed = await root.cogseed.invoke('contribution.agent.confirm', {
      token, digest: s.preview?.digest, ...(s.hints.length ? { acknowledge_hints: s.draft.accepted.hints === true } : {}),
    });
    if (confirmed?.confirmed !== true) {
      await root.uiAlert(confirmedReason(confirmed));
      // Content or terms changed under us: start over so the preview is rebuilt from the current copy.
      await restart();
      return;
    }
    await send();
  }

  function confirmedReason(result) {
    if (result?.reason === 'package_limits') {
      return tr('agents.contribute_package_limits', 'The package is larger than Hub allows. Remove files or bundled skills and try again.');
    }
    if (result?.reason === 'hints_unacknowledged') return tr('agents.contribute_hints_unacknowledged', 'Check the highlighted places and confirm before submitting.');
    if (result?.reason === 'terms_stale') return tr('skills.contribute_terms_stale', 'The terms changed. Read and accept them again.');
    return tr('skills.contribute_snapshot_changed', 'The submission no longer matches the preview. Check and preview it again.');
  }

  async function send() {
    const s = session;
    const token = s.token;
    let replaceConfirmed = false;
    s.sending = true;
    render();
    try {
      for (;;) {
        const attempt = root.cogseed.invoke('contribution.agent.submit', {
          token,
          version: s.draft.version.trim(),
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
          if (typeof root.uiToast === 'function') root.uiToast(tr('agents.contribute_submitted_toast', 'Submitted for review. Track progress in My contributions.'), { variant: 'success' });
          await endSession();
          hideAgentContributionViews();
          if (typeof root._showAgentsGridView === 'function') root._showAgentsGridView();
          await openMine('agent');
          return;
        }
        const retryable = submitted?.error?.retryable === true || submitted?.retryable === true || submitted?.reason === 'snapshot_drift';
        if (!retryable) {
          await root.uiAlert(localReason(submitted) || errorText(submitted?.error, tr('skills.contribute_submit_failed', 'Submission was not confirmed.')));
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
        if (s.stage === 'preview') render();
      }
    }
  }

  function localReason(result) {
    if (result?.reason === 'version_not_higher') {
      return tr('skills.contribute_version_not_higher', 'The version must be higher than {version}.').replace('{version}', result.current_version || '');
    }
    if (result?.reason === 'invalid_semver') return tr('skills.contribute_invalid_semver', 'Enter a valid semantic version, for example 1.2.0.');
    if (result?.reason === 'target_version_unavailable') return tr('skills.contribute_target_refresh', 'Refresh My contributions before submitting a new version.');
    return '';
  }

  // The Mine page is shared with Skills. Opened from the Agent flow it renders inside the Agents tab
  // (tab stays on 智能体, back returns to the Agent grid), filtered to Agents.
  async function openMine(type) {
    await shared.openMyContributions({ skipIdentity: true, type, returnTo: 'agents' });
  }

  // ── Start ──

  async function start(agentId, name, targetContentId) {
    try {
      await endSession();
      const preflight = await shared.ensureIdentity(name);
      if (!preflight) return;
      const termsResponse = await root.cogseed.invoke('contribution.terms', {});
      if (termsResponse?.state?.status !== 'open') {
        await root.uiAlert(termsResponse?.state?.status === 'closed'
          ? tr('skills.contribute_terms_closed', 'Contribution is not open right now.')
          : tr('skills.contribute_terms_unavailable', 'Could not load the current terms.'));
        return;
      }
      const state = await root.cogseed.invoke('contribution.agent.start', { agent_id: agentId });
      if (!state?.token) return;
      const passed = model.classifyAgentAdmission(state.admission) === 'passed' && Boolean(state.preview);
      session = {
        token: state.token,
        agentId,
        name: name || agentId,
        targetContentId: targetContentId || '',
        terms: termsResponse.state.terms,
        displayName: state.identity?.displayName || preflight.identity?.displayName || '',
        admission: state.admission,
        preview: state.preview || null,
        handled: state.handled || [],
        bundledSkills: state.bundledSkills || [],
        hubRefs: state.hubRefs || [],
        hubRefNames: state.hubRefNames || {},
        builtinRefs: state.builtinRefs || [],
        hints: Array.isArray(state.hints) ? state.hints : [],
        stage: passed ? 'preview' : 'check',
        draft: { version: '', origin: { type: '', note: '' }, accepted: { terms: false, maintenance: false, skills: false, hints: false } },
        selectedFile: 0,
        fileCache: {},
        sending: false,
        selects: {},
      };
      render();
      if (passed) void loadFile(0);
    } catch (error) {
      await fail(error);
    }
  }

  async function restart() {
    const s = session;
    if (!s) return;
    await start(s.agentId, s.name, s.targetContentId);
  }

  async function fail(error) {
    if (root.createLogger) root.createLogger('hub-agent-contributions').warn('flow failed', { error: String(error) });
    await root.uiAlert(tr('agents.contribute_start_failed', 'Could not start contribution.'));
    if (session) leaveToAgents();
  }

  // Resubmit / new version from My contributions: choose which local agent holds the new version.
  async function chooseLocalAgent(targetContentId) {
    const agents = typeof root.getCustomContributionAgents === 'function' ? root.getCustomContributionAgents() : [];
    if (!agents.length) {
      await root.uiAlert(tr('agents.contribute_no_local_agent', 'Create a local agent before submitting a new version.'));
      return;
    }
    const selected = await root.uiChoice({
      title: tr('agents.contribute_new_version', 'Submit new version'),
      message: tr('agents.contribute_choose_local', 'Choose the local agent that contains the new version.'),
      choices: agents.map((agent) => ({ id: agent.id, label: agent.name || agent.id })),
    });
    const agent = agents.find((entry) => entry.id === selected);
    if (agent) {
      if (typeof root.activateConnectionsTab === 'function') root.activateConnectionsTab('agents');
      await start(agent.id, agent.name || agent.id, targetContentId);
    }
  }

  // ── Events ──

  async function onClick(event) {
    const target = event.target.closest('[data-hubc-agent-action]');
    if (!target) return;
    const action = target.dataset.hubcAgentAction;
    try {
      if (action === 'back') leaveToAgents();
      else if (action === 'recheck') await restart();
      else if (action === 'select-file') selectFile(Number(target.dataset.hubcFileIndex));
      else if (action === 'read-terms') await showTerms();
      else if (action === 'submit') await submit();
      else if (action === 'cancel-submit') session?.cancelUpload?.();
    } catch (error) {
      if (session) await fail(error);
      else await root.uiAlert(tr('skills.contribute_action_failed', 'The action could not be completed.'));
    }
  }

  function bind() {
    const el = host();
    if (!el || el.dataset.hubcBound === 'true') return;
    el.dataset.hubcBound = 'true';
    el.addEventListener('click', (event) => { void onClick(event); });
    el.addEventListener('input', () => updateSubmit());
    el.addEventListener('change', () => updateSubmit());
  }

  function onLanguageChange() {
    if (session && host()?.style.display !== 'none') {
      capture();
      render();
    }
  }

  root.startAgentContribution = start;
  root.chooseLocalAgentContribution = chooseLocalAgent;
  root.hideAgentContributionViews = hideAgentContributionViews;
  if (typeof root.addEventListener === 'function') root.addEventListener('i18n-change', onLanguageChange);
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') bind();
})(window);
