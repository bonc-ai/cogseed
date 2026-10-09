import type { WorkflowRun, WorkflowStep, WorkflowStepStatus } from './types';

export interface StepTransitionResult { run: WorkflowRun; step: WorkflowStep }

function cloneRun(run: WorkflowRun): WorkflowRun {
  return { ...run, steps: run.steps.map((step) => ({ ...step, depends_on: [...(step.depends_on || [])], ...(step.context_dependencies ? { context_dependencies: [...step.context_dependencies] } : {}), ...(step.blocked_by_conflict_ids ? { blocked_by_conflict_ids: [...step.blocked_by_conflict_ids] } : {}) })) };
}

function activeRun(run: WorkflowRun): void {
  if (run.status === 'completed' || run.status === 'cancelled') throw new Error(`workflow run is terminal: ${run.status}`);
}

function findStep(run: WorkflowRun, stepId: string): WorkflowStep {
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  return step;
}

const STEP_TRANSITIONS: Readonly<Record<WorkflowStepStatus, readonly WorkflowStepStatus[]>> = {
  pending: ['running', 'blocked', 'skipped'],
  running: ['completed', 'blocked', 'failed', 'skipped'],
  blocked: ['pending', 'failed', 'skipped'],
  failed: ['pending', 'skipped'],
  completed: [],
  skipped: [],
};

export function transitionStep(runInput: WorkflowRun, stepId: string, next: WorkflowStepStatus, now: string): StepTransitionResult {
  activeRun(runInput);
  const run = cloneRun(runInput); const step = findStep(run, stepId);
  if (step.status === next) return { run, step };
  if (!STEP_TRANSITIONS[step.status].includes(next)) throw new Error(`invalid workflow step transition ${step.status} -> ${next}`);
  step.status = next;
  if (next === 'running') { step.started_at = now; delete step.completed_at; }
  if (next === 'completed' || next === 'failed' || next === 'skipped') step.completed_at = now;
  run.updated_at = now;
  return { run, step };
}

export function retryStep(runInput: WorkflowRun, stepId: string, now: string): StepTransitionResult {
  activeRun(runInput);
  const run = cloneRun(runInput); const step = findStep(run, stepId);
  if (!['failed', 'blocked', 'skipped'].includes(step.status)) throw new Error(`workflow step cannot be retried from status: ${step.status}`);
  step.status = 'pending';
  delete step.started_at; delete step.completed_at; delete step.result_summary; delete step.result_ref; delete step.gate_result_id;
  run.status = 'running'; run.phase = 'step_retry'; run.updated_at = now;
  return { run, step };
}

export function skipStep(runInput: WorkflowRun, stepId: string, reason: string | undefined, now: string): StepTransitionResult {
  activeRun(runInput);
  const run = cloneRun(runInput); const step = findStep(run, stepId);
  if (step.status === 'completed' || step.status === 'skipped') throw new Error(`workflow step cannot be skipped from status: ${step.status}`);
  step.status = 'skipped'; step.completed_at = now; step.result_summary = reason || 'Skipped.';
  run.status = 'running'; run.phase = 'step_skipped'; run.updated_at = now;
  return { run, step };
}

export function resumeRun(runInput: WorkflowRun, now: string): WorkflowRun {
  if (runInput.status !== 'blocked' && runInput.status !== 'failed') throw new Error(`workflow run cannot be resumed from status: ${runInput.status}`);
  const run = cloneRun(runInput); run.status = 'running'; run.phase = 'resumed'; run.updated_at = now; return run;
}

export function abortRun(runInput: WorkflowRun, reason: string | undefined, now: string): WorkflowRun {
  if (runInput.status === 'completed' || runInput.status === 'cancelled') throw new Error(`workflow run cannot be aborted from status: ${runInput.status}`);
  const run = cloneRun(runInput); run.status = 'cancelled'; run.phase = 'aborted'; run.updated_at = now;
  for (const step of run.steps) if (step.status === 'pending' || step.status === 'running' || step.status === 'blocked') {
    step.status = 'skipped'; step.completed_at = now; step.result_summary = reason || 'Workflow aborted.';
  }
  return run;
}
