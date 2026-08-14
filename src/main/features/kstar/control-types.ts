import type { KstarExpectedResult } from './requirement-types';

export type KstarControlOperation =
  | 'upsert_state'
  | 'request_projection'
  | 'commit_forecast'
  | 'finish'
  | 'abandon';

export interface KstarTaskMutation {
  operation: 'keep' | 'create' | 'update' | 'close';
  taskId?: string;
  title?: string;
  closeReason?: string;
}

export interface KstarRequirementMutation {
  operation: 'keep' | 'create' | 'update' | 'close';
  requirementId?: string;
  goalText?: string;
  expectedResult?: KstarExpectedResult;
}

export interface KstarProjectionProposal {
  requirementId: string;
  purpose: string;
  taskText?: string;
}

export interface KstarForecastProposal {
  taskRunId: string;
  requirementId: string;
  projectionId: string;
  candidates: unknown[];
  constraints?: string[];
  acceptanceCriteria?: string[];
}

export interface KstarResultProposal {
  finalStatus?: 'completed' | 'failed' | 'cancelled';
  finalText?: string;
  producedFiles?: string[];
  acceptanceEvidence?: string[];
  closeReason?: string;
}

export interface KstarControlInput {
  operation: KstarControlOperation;
  idempotencyKey: string;
  task?: KstarTaskMutation;
  requirement?: KstarRequirementMutation;
  projection?: KstarProjectionProposal;
  forecast?: KstarForecastProposal;
  result?: KstarResultProposal;
}

export type KstarControlErrorCode =
  | 'kstar_control_invalid_input'
  | 'kstar_projection_not_confirmed'
  | 'kstar_invalid_candidate'
  | 'kstar_unavailable_tool'
  | 'kstar_invalid_rule_ref'
  | 'kstar_persistence_failed';

export type KstarControlResult =
  | { ok: true; status: 'state_committed'; taskId: string; requirementId: string; replayed?: boolean }
  | { ok: true; status: 'projection_confirmed'; taskId: string; requirementId: string; projectionId: string; replayed?: boolean }
  | { ok: true; status: 'confirmation_required'; taskId: string; requirementId: string; projectionId: string; replayed?: boolean }
  | { ok: true; status: 'forecast_committed'; taskId: string; requirementId: string; projectionId: string; forecastId: string; selectedCandidateId: string; replayed?: boolean }
  | { ok: true; status: 'finished' | 'abandoned'; taskId: string; requirementId?: string; replayed?: boolean }
  | { ok: false; code: KstarControlErrorCode; message: string };


export interface KstarControlHostContext {
  userId: string;
  conversationId: string;
  sourceMessageId?: string;
  workspaceId?: string;
  allowedToolNames: ReadonlySet<string>;
  model?: {
    providerId?: string;
    modelId?: string;
    profileId?: string;
    entryId?: string;
  };
}

export interface KstarControlReceipt {
  idempotencyKey: string;
  inputHash: string;
  operation: KstarControlOperation;
  actor: 'commander';
  conversationId: string;
  taskId?: string;
  requirementId?: string;
  projectionId?: string;
  forecastId?: string;
  status: 'ok' | 'rejected' | 'failed';
  result: KstarControlResult;
  createdAt: string;
}
