import { expect, it } from 'vitest';
import { reconcileStepBlockers } from '../../../../src/main/features/collaboration_control/dependency-reconciler';
import type { SharedTaskContext, WorkflowRun } from '../../../../src/main/features/collaboration_control/types';

function fixture() {
  const run: WorkflowRun = { version: 1, id: 'wrun-1', cid: 'scope', objective: 'x', kind: 'custom', status: 'running', phase: 'planned', context_id: 'ctx-1', created_by: 'c', created_at: 't', updated_at: 't', steps: [
    { id: 'gate-step', run_id: 'wrun-1', title: 'gate', actor_id: null, type: 'gate', status: 'completed', depends_on: [] },
    { id: 'work', run_id: 'wrun-1', title: 'work', actor_id: 'a', type: 'dispatch', status: 'pending', depends_on: ['gate-step'], context_dependencies: ['architecture'] },
  ] };
  const context: SharedTaskContext = { version: 1, id: 'ctx-1', cid: 'scope', run_id: 'wrun-1', objective: 'x', phase: 'planned', revision: 1, constraints: [], facts: [], decisions: [], open_questions: [], risks: [], artifacts: [], agent_outputs: {}, gates: [{ id: 'g1', run_id: 'wrun-1', step_id: 'gate-step', name: 'approval', status: 'needs_review', checks: [], blocks_workflow: true, created_at: 't' }], proposals: [], conflicts: [{ id: 'conf-1', conflict_key: 'architecture', type: 'implementation', status: 'detected', proposal_ids: [], affected_step_ids: [], created_at: 't', updated_at: 't' }], updated_at: 't' };
  return { run, context };
}

it('blocks on gates/conflicts and restores pending after both are resolved', () => {
  const first = reconcileStepBlockers(...Object.values(fixture()) as [WorkflowRun, SharedTaskContext]);
  expect(first.run.status).toBe('blocked');
  expect(first.run.steps[1]).toMatchObject({ status: 'blocked', blocked_by_conflict_ids: ['conf-1'] });
  expect(first.context.conflicts[0].affected_step_ids).toEqual(['work']);
  first.context.gates[0].status = 'passed'; first.context.conflicts[0].status = 'resolved';
  const second = reconcileStepBlockers(first.run, first.context);
  expect(second.run).toMatchObject({ status: 'running', phase: 'gate_approved' });
  expect(second.run.steps[1].status).toBe('pending');
});
