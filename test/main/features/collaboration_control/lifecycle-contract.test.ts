import { describe, expect, it } from 'vitest';
import { abortRun, resumeRun, retryStep, skipStep, transitionStep } from '../../../../src/main/features/collaboration_control/lifecycle';
import type { WorkflowRun } from '../../../../src/main/features/collaboration_control/types';

function run(): WorkflowRun {
  return { version: 1, id: 'wrun-1', cid: 'scope-1', objective: 'ship', kind: 'implementation', status: 'running', phase: 'planned', context_id: 'wctx-1', created_by: 'commander', created_at: 't0', updated_at: 't0', steps: [
    { id: 's1', run_id: 'wrun-1', title: 'first', actor_id: 'a1', type: 'dispatch', status: 'failed', depends_on: [], result_summary: 'bad', completed_at: 't1' },
    { id: 's2', run_id: 'wrun-1', title: 'second', actor_id: 'a2', type: 'dispatch', status: 'blocked', depends_on: ['s1'] },
  ] };
}

describe('collaboration lifecycle contract', () => {
  it('retries only failed/blocked/skipped steps and clears prior result state', () => {
    const result = retryStep(run(), 's1', 't2');
    expect(result.step).toMatchObject({ status: 'pending' });
    expect(result.step).not.toHaveProperty('result_summary');
    expect(result.run).toMatchObject({ status: 'running', phase: 'step_retry', updated_at: 't2' });
    const completed = run(); completed.steps[0].status = 'completed'; expect(() => retryStep(completed, 's1', 't3')).toThrow(/cannot be retried/);
  });

  it('skips an unfinished step and resumes a blocked or failed run', () => {
    expect(skipStep(run(), 's2', 'not needed', 't2').step).toMatchObject({ status: 'skipped', result_summary: 'not needed' });
    const blocked = { ...run(), status: 'blocked' as const };
    expect(resumeRun(blocked, 't3')).toMatchObject({ status: 'running', phase: 'resumed' });
  });

  it('aborts once and skips every active step without reviving terminal runs', () => {
    const aborted = abortRun(run(), 'user stopped', 't4');
    expect(aborted.status).toBe('cancelled');
    expect(aborted.steps.map((step) => step.status)).toEqual(['failed', 'skipped']);
    expect(() => resumeRun(aborted, 't5')).toThrow(/cannot be resumed/);
  });
});
