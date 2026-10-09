import type { ContextConflict, SharedTaskContext, WorkflowRun } from './types';

export interface BlockerReconciliation { run: WorkflowRun; context: SharedTaskContext; runChanged: boolean; contextChanged: boolean }
const activeConflict = (conflict: ContextConflict) => conflict.status !== 'resolved' && conflict.status !== 'dismissed';
const unique = (values?: readonly string[]) => Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const safeId = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);

function clone(run: WorkflowRun, context: SharedTaskContext): { run: WorkflowRun; context: SharedTaskContext } {
  return {
    run: { ...run, steps: run.steps.map((step) => ({ ...step, depends_on: [...(step.depends_on || [])], ...(step.context_dependencies ? { context_dependencies: [...step.context_dependencies] } : {}), ...(step.blocked_by_conflict_ids ? { blocked_by_conflict_ids: [...step.blocked_by_conflict_ids] } : {}) })) },
    context: { ...context, gates: context.gates.map((gate) => ({ ...gate, checks: gate.checks.map((check) => ({ ...check })) })), conflicts: context.conflicts.map((conflict) => ({ ...conflict, proposal_ids: [...conflict.proposal_ids], affected_step_ids: [...conflict.affected_step_ids], ...(conflict.resolution ? { resolution: { ...conflict.resolution, selected_proposal_ids: [...conflict.resolution.selected_proposal_ids] } } : {}) })) },
  };
}

export function reconcileStepBlockers(runInput: WorkflowRun, contextInput: SharedTaskContext): BlockerReconciliation {
  const cloned = clone(runInput, contextInput); const run = cloned.run; const context = cloned.context;
  let runChanged = false; let contextChanged = false;
  const blockingGate = context.gates.find((gate) => gate.blocks_workflow !== false && (gate.status === 'needs_review' || gate.status === 'failed'));
  const wasGateBlocked = ['gate_needs_review', 'gate_failed', 'gate_rejected'].includes(run.phase);
  if (blockingGate) {
    if (run.status !== 'blocked') { run.status = 'blocked'; runChanged = true; }
    if (!wasGateBlocked) { run.phase = blockingGate.status === 'needs_review' ? 'gate_needs_review' : 'gate_failed'; runChanged = true; }
  } else if (run.status === 'blocked' && wasGateBlocked) { run.status = 'running'; run.phase = 'gate_approved'; runChanged = true; }

  const conflicts = context.conflicts.filter((conflict) => safeId(conflict.id));
  const active = conflicts.filter((conflict) => conflict.conflict_key.trim() && activeConflict(conflict));
  const activeGateSteps = new Set(context.gates.filter((gate) => gate.blocks_workflow !== false && (gate.status === 'needs_review' || gate.status === 'failed')).map((gate) => gate.step_id));
  const passedGateSteps = new Set(context.gates.filter((gate) => gate.status === 'passed').map((gate) => gate.step_id));
  const byId = new Map(run.steps.map((step) => [step.id, step]));
  for (const step of run.steps) {
    const dependencies = unique(step.context_dependencies);
    const previous = unique(step.blocked_by_conflict_ids);
    const desired = active.filter((conflict) => dependencies.includes(conflict.conflict_key.trim())).map((conflict) => conflict.id);
    const gateBlocked = step.depends_on.some((id) => activeGateSteps.has(id));
    const dependenciesReady = step.depends_on.every((id) => ['completed', 'skipped'].includes(byId.get(id)?.status || '') || passedGateSteps.has(id));
    if (!same(dependencies, step.context_dependencies || [])) { if (dependencies.length) step.context_dependencies = dependencies; else delete step.context_dependencies; runChanged = true; }
    if (step.status === 'pending' && (desired.length || gateBlocked)) { step.status = 'blocked'; runChanged = true; }
    else if (step.status === 'blocked' && !desired.length && !gateBlocked && dependenciesReady && (previous.length > 0 || step.depends_on.length > 0)) { step.status = 'pending'; runChanged = true; }
    const next = step.status === 'blocked' ? desired : [];
    if (!same(previous, next)) { if (next.length) step.blocked_by_conflict_ids = next; else delete step.blocked_by_conflict_ids; runChanged = true; }
  }
  for (const conflict of conflicts) {
    const affected = run.steps.filter((step) => step.blocked_by_conflict_ids?.includes(conflict.id)).map((step) => step.id);
    if (!same(conflict.affected_step_ids, affected)) { conflict.affected_step_ids = affected; contextChanged = true; }
  }
  return { run, context, runChanged, contextChanged };
}
