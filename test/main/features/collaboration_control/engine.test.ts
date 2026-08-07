import { describe, expect, it, vi } from 'vitest';
import { createCollaborationEngine } from '../../../../src/main/features/collaboration_control/engine';
import type { CollaborationEvent, SharedTaskContext, WorkflowRun } from '../../../../src/main/features/collaboration_control/types';

function fixture() {
  const run: WorkflowRun = { version: 1, id: 'run-1', cid: 'scope-1', objective: 'ship', kind: 'implementation', status: 'running', phase: 'work', context_id: 'ctx-1', created_by: 'c', created_at: 't0', updated_at: 't0', steps: [
    { id: 's1', run_id: 'run-1', title: 'one', actor_id: 'a', type: 'dispatch', status: 'failed', depends_on: [], result_ref: 'exec-1' },
    { id: 's2', run_id: 'run-1', title: 'two', actor_id: 'b', type: 'dispatch', status: 'running', depends_on: [] },
  ] };
  const context: SharedTaskContext = { version: 1, id: 'ctx-1', cid: 'scope-1', run_id: 'run-1', objective: 'ship', phase: 'work', revision: 1, constraints: [], facts: [], decisions: [], open_questions: [], risks: [], artifacts: [], agent_outputs: {}, gates: [], proposals: [], conflicts: [], updated_at: 't0' };
  return { run, context };
}

function harness(observer = vi.fn()) {
  let { run, context } = fixture(); const events: CollaborationEvent[] = [];
  const store: any = {
    withLock: async (_scope: any, fn: any) => fn(), readRun: async () => run, writeRun: async (_s: any, next: WorkflowRun) => { run = next; },
    readContext: async () => context, writeContext: async (_s: any, next: SharedTaskContext) => { context = next; }, appendEvent: async (_s: any, event: CollaborationEvent) => { events.push(event); }, readEvents: async () => events,
  };
  const dispatcher = { dispatchStep: vi.fn(), cancelStep: vi.fn(async () => {}) };
  const engine = createCollaborationEngine({ store, dispatcher, observer: { onEvent: observer }, now: () => 't1', id: () => `evt-${events.length + 1}` });
  return { engine, dispatcher, events, read: () => ({ run, context }) };
}

const scope = { ownerId: 'u1', domain: 'mate' as const, scopeId: 'scope-1' };

describe('Collaboration engine', () => {
  it('persists retry before publishing an event', async () => {
    const h = harness(); const result = await h.engine.retryStep(scope, 'run-1', 's1');
    expect(result.step.status).toBe('pending'); expect(h.events.map((event) => event.type)).toEqual(['step_retried']);
    expect(h.read().run.updated_at).toBe('t1');
  });

  it('aborts state first and then cancels previously running executions', async () => {
    const h = harness(); const result = await h.engine.abortRun(scope, 'run-1', 'stop');
    expect(result.status).toBe('cancelled'); expect(h.dispatcher.cancelStep).toHaveBeenCalledWith(scope, expect.objectContaining({ id: 's2' }));
    expect(h.events.at(-1)?.type).toBe('workflow_aborted');
  });

  it('does not corrupt committed state when an observer fails', async () => {
    const h = harness(vi.fn(async () => { throw new Error('observer down'); }));
    await expect(h.engine.skipStep(scope, 'run-1', 's1', 'not needed')).resolves.toMatchObject({ status: 'skipped' });
    expect(h.read().run.steps[0].status).toBe('skipped');
  });
});

it('creates, plans, dispatches, and completes a workflow step through ports', async () => {
  let run: WorkflowRun | null = null; let context: SharedTaskContext | null = null; const events: CollaborationEvent[] = [];
  const store: any = { withLock: async (_s: any, fn: any) => fn(), readRun: async () => run, writeRun: async (_s: any, value: WorkflowRun) => { run = value; }, readContext: async () => context, writeContext: async (_s: any, value: SharedTaskContext) => { context = value; }, appendEvent: async (_s: any, value: CollaborationEvent) => { events.push(value); }, readEvents: async () => events };
  const dispatcher = { dispatchStep: vi.fn(async () => ({ executionId: 'mate-task-child', status: 'running' as const })), cancelStep: vi.fn() };
  let ids = 0; const engine = createCollaborationEngine({ store, dispatcher, now: () => 't1', id: (prefix?: string) => `${prefix || 'id'}-${++ids}` });
  const created = await engine.createRun(scope, { objective: 'Ship it', kind: 'implementation', createdBy: 'commander' });
  const planned = await engine.planStep(scope, created.id, { title: 'Research', actorId: 'researcher', type: 'dispatch', resumeToken: 'req-child' });
  expect(planned.status).toBe('pending');
  const started = await engine.startStep(scope, created.id, planned.id);
  expect(started).toMatchObject({ status: 'running', result_ref: 'mate-task-child' });
  const completed = await engine.completeStep(scope, created.id, planned.id, { status: 'completed', resultSummary: 'done' });
  expect(completed).toMatchObject({ status: 'completed', result_summary: 'done' });
  expect(events.map((event) => event.type)).toEqual(['workflow_created', 'workflow_planned', 'step_started', 'step_completed']);
});
