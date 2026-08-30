import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { abortRun as abortRunState, resumeRun as resumeRunState, retryStep as retryStepState, skipStep as skipStepState, transitionStep } from './lifecycle';
import { reconcileStepBlockers } from './dependency-reconciler';
import type { CollaborationEvent, SharedTaskContext, WorkflowRun, WorkflowStep } from './types';
import type { CollaborationDispatcher, CollaborationObserver, CollaborationScope, CollaborationStore } from './ports';

const log = createLogger('collaboration-control');

export interface CollaborationEngineDeps {
  store: CollaborationStore;
  dispatcher: CollaborationDispatcher;
  observer?: CollaborationObserver;
  now?: () => string;
  id?: (prefix?: string) => string;
}

export interface CreateRunInput { objective: string; kind?: WorkflowRun['kind']; createdBy: string }
export interface PlanStepInput { title: string; actorId: string | null; type?: WorkflowStep['type']; dependsOn?: string[]; contextDependencies?: string[]; expectedOutput?: WorkflowStep['expected_output']; resumeToken?: string; objective?: string }
export interface CompleteStepInput { status: 'completed' | 'blocked' | 'failed' | 'skipped'; resultSummary?: string; resultRef?: string }

export interface CollaborationEngine {
  createRun(scope: CollaborationScope, input: CreateRunInput): Promise<WorkflowRun>;
  planStep(scope: CollaborationScope, runId: string, input: PlanStepInput): Promise<WorkflowStep>;
  startStep(scope: CollaborationScope, runId: string, stepId: string): Promise<WorkflowStep>;
  completeStep(scope: CollaborationScope, runId: string, stepId: string, input: CompleteStepInput): Promise<WorkflowStep>;
  retryStep(scope: CollaborationScope, runId: string, stepId: string): Promise<{ run: WorkflowRun; step: WorkflowStep }>;
  skipStep(scope: CollaborationScope, runId: string, stepId: string, reason?: string): Promise<WorkflowStep>;
  resumeRun(scope: CollaborationScope, runId: string, reason?: string): Promise<WorkflowRun>;
  abortRun(scope: CollaborationScope, runId: string, reason?: string): Promise<WorkflowRun>;
  reviewGate(scope: CollaborationScope, runId: string, gateId: string, decision: 'approve' | 'reject', reason?: string): Promise<SharedTaskContext>;
  dismissConflict(scope: CollaborationScope, runId: string, conflictId: string, reason?: string): Promise<SharedTaskContext>;
}

export function createCollaborationEngine(deps: CollaborationEngineDeps): CollaborationEngine {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? ((prefix = 'wevt') => `${prefix}-${Math.random().toString(16).slice(2)}`);

  async function load(scope: CollaborationScope, runId: string): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
    const run = await deps.store.readRun(scope, runId); if (!run) throw new Error('workflow run not found');
    const context = await deps.store.readContext(scope, run.context_id); if (!context) throw new Error('shared task context not found');
    return { run, context };
  }

  function event(scope: CollaborationScope, run: WorkflowRun, type: CollaborationEvent['type'], input: Partial<CollaborationEvent> = {}): CollaborationEvent {
    return { version: 1, id: id('wevt'), cid: scope.scopeId, run_id: run.id, context_id: run.context_id, type, created_at: now(), ...input };
  }

  async function publish(scope: CollaborationScope, item: CollaborationEvent): Promise<void> {
    try { await deps.observer?.onEvent(scope, item); }
    catch (error) { log.warn('collaboration observer failed after commit', { error: logErrorRef(error), event_type: item.type }); }
  }

  async function persist(scope: CollaborationScope, run: WorkflowRun, context: SharedTaskContext, item: CollaborationEvent): Promise<void> {
    await deps.store.writeRun(scope, run); await deps.store.writeContext(scope, context); await deps.store.appendEvent(scope, item);
  }

  return {
    async createRun(scope, input) {
      let output!: WorkflowRun; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const timestamp = now(); const runId = id('wrun'); const contextId = id('wctx');
        output = { version: 1, id: runId, cid: scope.scopeId, objective: String(input.objective || '').trim(), kind: input.kind ?? 'custom', status: 'running', phase: 'created', steps: [], context_id: contextId, created_by: input.createdBy, created_at: timestamp, updated_at: timestamp };
        if (!output.objective) throw new Error('workflow objective is required');
        const context: SharedTaskContext = { version: 1, id: contextId, cid: scope.scopeId, run_id: runId, objective: output.objective, phase: output.phase, revision: 1, constraints: [], facts: [], decisions: [], open_questions: [], risks: [], artifacts: [], agent_outputs: {}, gates: [], proposals: [], conflicts: [], updated_at: timestamp };
        committed = event(scope, output, 'workflow_created', { actor_id: input.createdBy, summary: output.objective });
        await persist(scope, output, context, committed);
      });
      await publish(scope, committed); return output;
    },
    async planStep(scope, runId, input) {
      let output!: WorkflowStep; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId); if (loaded.run.status === 'completed' || loaded.run.status === 'cancelled') throw new Error('workflow run is terminal');
        const timestamp = now(); output = { id: id('wstep'), run_id: runId, title: String(input.title || '').trim(), actor_id: input.actorId, type: input.type ?? 'dispatch', status: 'pending', depends_on: [...(input.dependsOn ?? [])], ...(input.contextDependencies?.length ? { context_dependencies: [...input.contextDependencies] } : {}), ...(input.expectedOutput ? { expected_output: input.expectedOutput } : {}), ...(input.resumeToken ? { resume_token: input.resumeToken } : {}), ...(input.objective ? { objective: input.objective } : {}) };
        if (!output.title) throw new Error('workflow step title is required');
        const run = { ...loaded.run, steps: [...loaded.run.steps, output], phase: 'planned', updated_at: timestamp };
        const reconciled = reconcileStepBlockers(run, loaded.context); output = reconciled.run.steps.find((step) => step.id === output.id)!;
        committed = event(scope, reconciled.run, 'workflow_planned', { actor_id: input.actorId, step_id: output.id, summary: output.title, payload: { step_ids: [output.id], step_count: 1 } });
        await persist(scope, reconciled.run, reconciled.context, committed);
      });
      await publish(scope, committed); return output;
    },
    async startStep(scope, runId, stepId) {
      let run!: WorkflowRun; let output!: WorkflowStep; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId); const reconciled = reconcileStepBlockers(loaded.run, loaded.context); const step = reconciled.run.steps.find((item) => item.id === stepId); if (!step) throw new Error('workflow step not found');
        const ready = step.depends_on.every((dependencyId) => { const dependency = reconciled.run.steps.find((item) => item.id === dependencyId); return dependency?.status === 'completed' || dependency?.status === 'skipped'; });
        if (reconciled.run.status === 'blocked' || step.status === 'blocked' || !ready) throw new Error('workflow step is blocked');
        const changed = transitionStep(reconciled.run, stepId, 'running', now()); run = changed.run; output = changed.step;
        committed = event(scope, run, 'step_started', { actor_id: output.actor_id, step_id: output.id, summary: output.title }); await persist(scope, run, reconciled.context, committed);
      });
      await publish(scope, committed);
      try {
        const receipt = await deps.dispatcher.dispatchStep(scope, run, output);
        await deps.store.withLock(scope, async () => { const loaded = await load(scope, runId); const step = loaded.run.steps.find((item) => item.id === stepId); if (!step) throw new Error('workflow step not found'); step.result_ref = receipt.executionId; loaded.run.updated_at = now(); await deps.store.writeRun(scope, loaded.run); output = step; });
        return output;
      } catch (error) {
        await this.completeStep(scope, runId, stepId, { status: 'failed', resultSummary: error instanceof Error ? error.message : String(error) }); throw error;
      }
    },
    async completeStep(scope, runId, stepId, input) {
      let output!: WorkflowStep; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId); const changed = transitionStep(loaded.run, stepId, input.status, now()); changed.step.result_summary = input.resultSummary; if (input.resultRef) changed.step.result_ref = input.resultRef;
        if (input.resultSummary && changed.step.actor_id) loaded.context.agent_outputs[stepId] = { actor_id: changed.step.actor_id, step_id: stepId, summary: input.resultSummary, created_at: now() };
        const reconciled = reconcileStepBlockers(changed.run, loaded.context); output = reconciled.run.steps.find((step) => step.id === stepId)!;
        committed = event(scope, reconciled.run, 'step_completed', { actor_id: output.actor_id, step_id: stepId, summary: input.resultSummary, payload: { status: output.status } }); await persist(scope, reconciled.run, reconciled.context, committed);
      });
      await publish(scope, committed); return output;
    },
    async retryStep(scope, runId, stepId) {
      let output!: { run: WorkflowRun; step: WorkflowStep }; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId); const changed = retryStepState(loaded.run, stepId, now());
        const reconciled = reconcileStepBlockers(changed.run, loaded.context); output = { run: reconciled.run, step: reconciled.run.steps.find((step) => step.id === stepId)! };
        committed = event(scope, output.run, 'step_retried', { actor_id: output.step.actor_id, step_id: stepId, summary: output.step.title });
        await persist(scope, output.run, reconciled.context, committed);
      });
      await publish(scope, committed); return output;
    },
    async skipStep(scope, runId, stepId, reason) {
      let output!: WorkflowStep; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId); const changed = skipStepState(loaded.run, stepId, reason, now());
        const reconciled = reconcileStepBlockers(changed.run, loaded.context); output = reconciled.run.steps.find((step) => step.id === stepId)!;
        committed = event(scope, reconciled.run, 'step_skipped', { actor_id: output.actor_id, step_id: stepId, summary: reason || output.title });
        await persist(scope, reconciled.run, reconciled.context, committed);
      });
      await publish(scope, committed); return output;
    },
    async resumeRun(scope, runId, reason) {
      let output!: WorkflowRun; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId); const resumed = resumeRunState(loaded.run, now()); const reconciled = reconcileStepBlockers(resumed, loaded.context); output = reconciled.run;
        committed = event(scope, output, 'workflow_resumed', { actor_id: 'user', summary: reason || 'Workflow resumed.' });
        await persist(scope, output, reconciled.context, committed);
      });
      await publish(scope, committed); return output;
    },
    async abortRun(scope, runId, reason) {
      let output!: WorkflowRun; let committed!: CollaborationEvent; let running: WorkflowStep[] = [];
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId); running = loaded.run.steps.filter((step) => step.status === 'running'); output = abortRunState(loaded.run, reason, now());
        const context = { ...loaded.context, phase: output.phase, updated_at: output.updated_at };
        committed = event(scope, output, 'workflow_aborted', { actor_id: 'user', summary: reason || 'Workflow aborted.' });
        await persist(scope, output, context, committed);
      });
      await publish(scope, committed);
      for (const step of running) {
        try { await deps.dispatcher.cancelStep(scope, step); }
        catch (error) { log.warn('collaboration step cancellation failed after abort', { error: logErrorRef(error), step_id: step.id }); }
      }
      return output;
    },
    async reviewGate(scope, runId, gateId, decision, reason) {
      let output!: SharedTaskContext; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId);
        const gate = loaded.context.gates.find((item) => item.id === gateId);
        if (!gate) throw new Error('collaboration gate not found');
        const timestamp = now();
        gate.review_decision = decision === 'approve' ? 'approved' : 'rejected';
        gate.reviewed_by = 'user';
        gate.reviewed_at = timestamp;
        if (reason?.trim()) gate.review_reason = reason.trim();
        else delete gate.review_reason;
        gate.status = decision === 'approve' ? 'passed' : 'failed';
        if (decision === 'reject' && gate.review_reason) gate.reason = gate.review_reason;
        if (decision === 'reject') { loaded.run.status = 'blocked'; loaded.run.phase = 'gate_rejected'; }
        const reconciled = reconcileStepBlockers(loaded.run, loaded.context);
        reconciled.run.updated_at = timestamp;
        reconciled.context.revision += 1;
        reconciled.context.phase = reconciled.run.phase;
        reconciled.context.updated_at = timestamp;
        output = reconciled.context;
        committed = event(scope, reconciled.run, 'gate_reviewed', {
          actor_id: 'user',
          step_id: gate.step_id,
          gate_id: gate.id,
          summary: gate.review_reason || gate.name,
          payload: { decision: gate.review_decision, status: gate.status },
        });
        await persist(scope, reconciled.run, reconciled.context, committed);
      });
      await publish(scope, committed); return output;
    },
    async dismissConflict(scope, runId, conflictId, reason) {
      let output!: SharedTaskContext; let committed!: CollaborationEvent;
      await deps.store.withLock(scope, async () => {
        const loaded = await load(scope, runId);
        const conflict = loaded.context.conflicts.find((item) => item.id === conflictId);
        if (!conflict) throw new Error('context conflict not found');
        if (conflict.status === 'resolved' || conflict.status === 'dismissed') throw new Error('context conflict is already closed');
        const timestamp = now();
        conflict.status = 'dismissed';
        conflict.updated_at = timestamp;
        const reconciled = reconcileStepBlockers(loaded.run, loaded.context);
        reconciled.run.updated_at = timestamp;
        reconciled.context.revision += 1;
        reconciled.context.phase = reconciled.run.phase;
        reconciled.context.updated_at = timestamp;
        output = reconciled.context;
        committed = event(scope, reconciled.run, 'conflict_status_updated', {
          actor_id: 'user',
          summary: reason?.trim() || undefined,
          payload: { conflict_id: conflict.id, status: conflict.status },
        });
        await persist(scope, reconciled.run, reconciled.context, committed);
      });
      await publish(scope, committed); return output;
    },
  };
}
