/**
 * Workbench panel — the complex-delivery Workspace view (US-20).
 *
 * The gate decides whether the body renders at all. Per T2-S3-02
 * ("未达Gate不得展示空Workspace") and RG-S3-03 ("不是空壳"), a Workspace that
 * has not met its conditions shows the concrete gap list instead of an empty
 * shell — the user learns what is missing rather than facing a silent wall.
 *
 * Read-only by design: this panel evaluates and projects, it never freezes a
 * baseline or starts a run. Those are deliberate user actions that belong to
 * their own flows.
 *
 * Classic script (no ESM): relies on the globals `escapeHtml`, `t` and
 * `window.orkas`, matching the sibling renderer modules. Local fallbacks keep
 * the pure builders usable under `require` in tests, where the renderer
 * globals are not installed.
 */

const _wbEscape = (value) => (
  typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
);
// Falling back to the key (rather than empty) keeps a missing locale visible
// instead of rendering a blank row.
const _wbT = (key) => (typeof t === 'function' ? t(key) : key);

/** Gate reason code → locale key. Codes are stable; copy is localized. */
const WORKBENCH_REASON_KEYS = {
  baseline_missing: 'project.wb_reason_baseline_missing',
  baseline_drift: 'project.wb_reason_baseline_drift',
  baseline_unreadable: 'project.wb_reason_baseline_unreadable',
  receipt_missing: 'project.wb_reason_receipt_missing',
  receipt_not_completed: 'project.wb_reason_receipt_not_completed',
  receipt_not_real: 'project.wb_reason_receipt_not_real',
  validation_blocked: 'project.wb_reason_validation_blocked',
};

/** Step state → a short localized label. */
function _workbenchStepStateLabel(state) {
  switch (state) {
    case 'running': return _wbT('project.wb_state_running');
    case 'done': return _wbT('project.wb_state_done');
    case 'failed': return _wbT('project.wb_state_failed');
    case 'cancelled': return _wbT('project.wb_state_cancelled');
    case 'blocked_by_user': return _wbT('project.wb_state_blocked_user');
    case 'blocked_by_dependency': return _wbT('project.wb_state_blocked_dep');
    default: return _wbT('project.wb_state_not_started');
  }
}

let _workbenchLoadSeq = 0;

/**
 * Load and render the panel for a project.
 *
 * The gate needs a baseline plus the receipt of the run it governs. Neither is
 * chosen here: the newest frozen baseline is used, and its own
 * `evaluation_contract_ref` is not a receipt, so with no run yet the gate is
 * simply reported as unmet. That is the honest empty state.
 */
async function loadProjectWorkbench(pid) {
  if (!pid) return;
  const seq = ++_workbenchLoadSeq;
  const gateEl = document.getElementById('workbench-gate');
  const bodyEl = document.getElementById('workbench-body');
  if (!gateEl || !bodyEl) return;

  gateEl.innerHTML = `<div class="empty muted">${_wbEscape(_wbT('chat.loading'))}</div>`;
  bodyEl.hidden = true;

  let baselines = [];
  let plan = null;
  try {
    const [baselineRes, planRes] = await Promise.all([
      window.orkas.invoke('workbench.baseline.list').catch(() => ({ ok: false })),
      window.orkas.invoke('workbench.actionPlan.read', { projectId: pid }).catch(() => ({ ok: false })),
    ]);
    if (seq !== _workbenchLoadSeq) return;  // a newer load superseded this one
    baselines = (baselineRes && baselineRes.ok && baselineRes.baselines) || [];
    plan = (planRes && planRes.ok && planRes.plan) || null;
  } catch {
    if (seq !== _workbenchLoadSeq) return;
  }

  const baseline = baselines[0] || null;
  let decision = null;
  if (baseline) {
    // No receipt id is known from this surface yet, so the gate is asked about
    // the baseline's own execution scope. A missing receipt is a legitimate
    // outcome, not an error to swallow.
    const res = await window.orkas
      .invoke('workbench.gate.evaluate', {
        baselineId: baseline.baseline_id,
        receiptExecutionId: baseline.baseline_id,
      })
      .catch(() => null);
    if (seq !== _workbenchLoadSeq) return;
    decision = (res && res.ok && res.decision) || null;
  }

  _renderProjectWorkbench({ baseline, decision, plan });
}

/**
 * Build the gate card. Pure: inputs → HTML, no DOM access, so the
 * gate-withholding rule is directly testable.
 */
function buildWorkbenchGateHtml({ baseline, decision }) {
  if (!baseline) {
    return `
      <div class="workbench-gate-card is-blocked">
        <div class="workbench-gate-title">${_wbEscape(_wbT('project.wb_blocked'))}</div>
        <div class="workbench-gate-hint muted">${_wbEscape(_wbT('project.wb_pick_baseline'))}</div>
      </div>`;
  }
  const ready = !!decision && decision.status === 'ready';
  const reasons = (decision && decision.reasons) || [];
  const gapList = reasons.length
    ? `<ul class="workbench-gate-gaps">${reasons
      .map((code) => {
        const key = WORKBENCH_REASON_KEYS[code];
        // An unmapped code still surfaces — silently dropping it would hide a
        // real blocker behind an empty list.
        return `<li>${_wbEscape(key ? _wbT(key) : code)}</li>`;
      })
      .join('')}</ul>`
    : '';
  return `
    <div class="workbench-gate-card ${ready ? 'is-ready' : 'is-blocked'}">
      <div class="workbench-gate-title">${_wbEscape(ready ? _wbT('project.wb_ready') : _wbT('project.wb_blocked'))}</div>
      ${ready ? '' : `<div class="workbench-gate-hint muted">${_wbEscape(_wbT('project.wb_gap_intro'))}</div>${gapList}`}
      <div class="workbench-gate-baseline muted">
        ${_wbEscape(_wbT('project.wb_baseline'))}:
        ${_wbEscape(baseline.skill_ref.asset_id)} · v${_wbEscape(baseline.skill_ref.version)}
        · <code>${_wbEscape(String(baseline.skill_ref.content_hash).slice(0, 12))}</code>
      </div>
    </div>`;
}

/** Build the Action Plan body. Pure, same reasoning as the gate builder. */
function buildWorkbenchBodyHtml(plan) {
  const steps = (plan && plan.steps) || [];
  const stepRows = steps.length
    ? steps
      .map((step) => {
        const deps = (step.unmetDependencies || []).length
          ? `<span class="workbench-step-deps muted">← ${_wbEscape(String(step.unmetDependencies.length))}</span>`
          : '';
        const runs = step.runCount
          ? `<span class="workbench-step-runs muted">${_wbEscape(_wbT('project.wb_runs'))} ${_wbEscape(String(step.runCount))}</span>`
          : '';
        return `
          <div class="workbench-step" data-state="${_wbEscape(step.state)}">
            <span class="workbench-step-title">${_wbEscape(step.title)}</span>
            <span class="workbench-step-state">${_wbEscape(_workbenchStepStateLabel(step.state))}</span>
            ${deps}${runs}
          </div>`;
      })
      .join('')
    : `<div class="empty muted">${_wbEscape(_wbT('project.wb_no_plan'))}</div>`;
  return `
    <div class="workbench-section-title">${_wbEscape(_wbT('project.wb_plan'))}</div>
    <div class="workbench-steps">${stepRows}</div>`;
}

function _renderProjectWorkbench({ baseline, decision, plan }) {
  const gateEl = document.getElementById('workbench-gate');
  const bodyEl = document.getElementById('workbench-body');
  if (!gateEl || !bodyEl) return;

  gateEl.innerHTML = buildWorkbenchGateHtml({ baseline, decision });

  // Gate closed (or no baseline at all) → no body. This is the
  // "不得展示空Workspace" rule in effect.
  const ready = !!baseline && !!decision && decision.status === 'ready';
  if (!ready) {
    bodyEl.hidden = true;
    bodyEl.innerHTML = '';
    return;
  }
  bodyEl.innerHTML = buildWorkbenchBodyHtml(plan);
  bodyEl.hidden = false;
}

if (typeof window !== 'undefined') {
  window.loadProjectWorkbench = loadProjectWorkbench;
}

// Test seam: the render step is pure (inputs → HTML) and is exercised directly
// so gate-withholding behaviour is verifiable without a DOM-driven load.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WORKBENCH_REASON_KEYS,
    _workbenchStepStateLabel,
    buildWorkbenchGateHtml,
    buildWorkbenchBodyHtml,
  };
}
