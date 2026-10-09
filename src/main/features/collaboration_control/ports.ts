import type { CollaborationEvent, SharedTaskContext, WorkflowRun, WorkflowStep } from './types';

export interface CollaborationScope {
  ownerId: string;
  domain: 'group_chat' | 'cogseed';
  scopeId: string;
}

export interface CollaborationStore {
  withLock<T>(scope: CollaborationScope, fn: () => Promise<T>): Promise<T>;
  readRun(scope: CollaborationScope, runId: string): Promise<WorkflowRun | null>;
  writeRun(scope: CollaborationScope, run: WorkflowRun): Promise<void>;
  readContext(scope: CollaborationScope, contextId: string): Promise<SharedTaskContext | null>;
  writeContext(scope: CollaborationScope, context: SharedTaskContext): Promise<void>;
  appendEvent(scope: CollaborationScope, event: CollaborationEvent): Promise<void>;
  readEvents(scope: CollaborationScope, afterSequence?: number, limit?: number): Promise<CollaborationEvent[]>;
}

export interface DispatchReceipt { executionId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' }
export interface ExecutionSnapshot extends DispatchReceipt { resultRef?: string; resultSummary?: string }
export interface CollaborationDispatcher {
  dispatchStep(scope: CollaborationScope, run: WorkflowRun, step: WorkflowStep): Promise<DispatchReceipt>;
  cancelStep(scope: CollaborationScope, step: WorkflowStep): Promise<void>;
  readExecution?(scope: CollaborationScope, step: WorkflowStep): Promise<ExecutionSnapshot | null>;
}

export interface ApprovalReceipt { approvalId: string; status: 'pending' | 'approved' | 'rejected' | 'expired' }
export interface CollaborationApprovalPort {
  requestApproval(scope: CollaborationScope, input: { run: WorkflowRun; step: WorkflowStep; reason?: string }): Promise<ApprovalReceipt>;
  readApproval(scope: CollaborationScope, approvalId: string): Promise<ApprovalReceipt | null>;
}

export interface CollaborationObserver {
  onEvent(scope: CollaborationScope, event: CollaborationEvent): void | Promise<void>;
}
