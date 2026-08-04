import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const W = require('../../src/renderer/modules/project-workbench.js');

const baseline = {
  baseline_id: 'baseline-1',
  skill_ref: { asset_id: 'asset-continuity', version: '1.0', content_hash: 'ab12cd34ef56'.padEnd(64, '0') },
};

describe('workbench gate rendering', () => {
  it('asks for a baseline first when none is frozen', () => {
    const html = W.buildWorkbenchGateHtml({ baseline: null, decision: null });
    expect(html).toContain('is-blocked');
    expect(html).toContain('project.wb_pick_baseline');
  });

  it('lists every gap when blocked, and withholds nothing about the cause', () => {
    const html = W.buildWorkbenchGateHtml({
      baseline,
      decision: { status: 'blocked', reasons: ['baseline_drift', 'receipt_not_real'] },
    });
    expect(html).toContain('is-blocked');
    expect(html).toContain('project.wb_reason_baseline_drift');
    expect(html).toContain('project.wb_reason_receipt_not_real');
    expect(html).toContain('project.wb_gap_intro');
  });

  it('surfaces an unmapped reason code rather than dropping it', () => {
    const html = W.buildWorkbenchGateHtml({
      baseline,
      decision: { status: 'blocked', reasons: ['some_future_code'] },
    });
    expect(html).toContain('some_future_code');
  });

  it('shows no gap list once ready', () => {
    const html = W.buildWorkbenchGateHtml({ baseline, decision: { status: 'ready', reasons: [] } });
    expect(html).toContain('is-ready');
    expect(html).not.toContain('workbench-gate-gaps');
    expect(html).not.toContain('project.wb_gap_intro');
  });

  it('shows a truncated baseline digest, never the full hash', () => {
    const html = W.buildWorkbenchGateHtml({ baseline, decision: { status: 'ready', reasons: [] } });
    expect(html).toContain('ab12cd34ef56');
    expect(html).not.toContain(baseline.skill_ref.content_hash);
  });

  it('maps every gate reason code the main process can emit', () => {
    // Keeping this in step with the gate's WorkspaceGateReason union prevents a
    // new blocker from rendering as a bare code in the UI.
    expect(Object.keys(W.WORKBENCH_REASON_KEYS).sort()).toEqual([
      'baseline_drift',
      'baseline_missing',
      'baseline_unreadable',
      'receipt_missing',
      'receipt_not_completed',
      'receipt_not_real',
      'validation_blocked',
    ]);
  });
});

describe('workbench action plan rendering', () => {
  it('renders steps with state, dependency and run counts', () => {
    const html = W.buildWorkbenchBodyHtml({
      steps: [
        { title: 'Draft deliverable', state: 'running', runCount: 2, unmetDependencies: [] },
        { title: 'Review', state: 'blocked_by_dependency', runCount: 0, unmetDependencies: ['t_1'] },
      ],
    });
    expect(html).toContain('Draft deliverable');
    expect(html).toContain('data-state="running"');
    expect(html).toContain('project.wb_state_blocked_dep');
    expect(html).toContain('project.wb_runs');
    // A step with no runs shows no run chip.
    expect(html.match(/workbench-step-runs/g)).toHaveLength(1);
  });

  it('renders an honest empty state instead of a fabricated plan', () => {
    const html = W.buildWorkbenchBodyHtml({ steps: [] });
    expect(html).toContain('project.wb_no_plan');
    expect(html).not.toContain('workbench-step"');
  });

  it('tolerates a missing plan', () => {
    expect(W.buildWorkbenchBodyHtml(null)).toContain('project.wb_no_plan');
  });

  it('escapes task titles', () => {
    const html = W.buildWorkbenchBodyHtml({
      steps: [{ title: '<img src=x onerror=alert(1)>', state: 'not_started', runCount: 0, unmetDependencies: [] }],
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('distinguishes dependency blocks from user blocks in the label', () => {
    expect(W._workbenchStepStateLabel('blocked_by_dependency')).toBe('project.wb_state_blocked_dep');
    expect(W._workbenchStepStateLabel('blocked_by_user')).toBe('project.wb_state_blocked_user');
  });
});

describe('workbench actions', () => {
  const skills = [{ id: 'sk-a', name: 'Delivery skill' }, { id: 'sk-b', name: 'Review' }];

  it('offers the project-bound skills as freeze candidates', () => {
    const html = W.buildWorkbenchActionsHtml({ skillChoices: skills });
    expect(html).toContain('workbench-freeze-btn');
    expect(html).toContain('value="sk-a"');
    expect(html).toContain('Delivery skill');
  });

  it('explains what to do when the project has no bound skills', () => {
    const html = W.buildWorkbenchActionsHtml({ skillChoices: [] });
    expect(html).toContain('project.wb_freeze_none');
    expect(html).not.toContain('workbench-freeze-btn');
  });

  it('escapes skill names', () => {
    const html = W.buildWorkbenchActionsHtml({
      skillChoices: [{ id: 'sk-x', name: '<script>alert(1)</script>' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('workbench run buttons', () => {
  const steps = [
    { taskId: 't1', title: 'Ready', state: 'not_started', runCount: 0, unmetDependencies: [] },
    { taskId: 't2', title: 'Waiting', state: 'blocked_by_dependency', runCount: 0, unmetDependencies: ['t1'] },
    { taskId: 't3', title: 'In flight', state: 'running', runCount: 1, unmetDependencies: [] },
    { taskId: 't4', title: 'Retryable', state: 'failed', runCount: 1, unmetDependencies: [] },
    { taskId: 't5', title: 'Closed', state: 'done', runCount: 1, unmetDependencies: [] },
  ];

  it('offers a run button only where running is meaningful', () => {
    const html = W.buildWorkbenchBodyHtml({ steps });
    const targets = [...html.matchAll(/data-task-id="([^"]+)"/g)].map((m: any) => m[1]);
    // A step waiting on a prerequisite must not be launchable from the plan —
    // that would make a read-only projection into a scheduling authority.
    // Running and closed steps have nothing to start.
    expect(targets).toEqual(['t1', 't4']);
  });

  it('maps every refusal code the main process can return', () => {
    expect(Object.keys(W.WORKBENCH_REFUSAL_KEYS).sort()).toEqual([
      'baseline_drift',
      'baseline_missing',
      'baseline_unreadable',
      'task_not_found',
    ]);
  });
});
