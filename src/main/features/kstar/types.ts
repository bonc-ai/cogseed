import type { AbilityAssetType } from '../recall/candidate-service';
import type { CognitionSourceRef } from '../recall/source-service';
import type { ActionDeltaDetail, ResultDeltaDetail } from '../recall/world-model-types';

export const KSTAR_SCHEMA_VERSION = 1;

export type KstarTaskStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'waiting_input';
export type KstarOutcome = 'better_than_expected' | 'met_expected' | 'worse_than_expected' | 'unclear';
export type KstarAttribution = 'knowledge_gap' | 'rule_gap' | 'template_gap' | 'skill_gap' | 'execution_gap' | 'unclear';

export interface KstarJsonRecord {
  schemaVersion: number;
  ownerId: string;
  id: string;
  [key: string]: unknown;
}

export interface KstarToolCall {
  id?: string;
  sequence?: number;
  actor?: string;
  name: string;
  argumentsSummary?: string;
  status?: 'ok' | 'error' | 'cancelled' | 'unknown';
}

export interface KstarAgentAction {
  sequence?: number;
  actor?: string;
  action: string;
  summary?: string;
  status?: 'ok' | 'error' | 'cancelled' | 'unknown';
}

export interface KstarEpisodeRecord extends KstarJsonRecord {
  schemaVersion: 1;
  sessionId: string;
  sessionKind?: string;
  taskRunId?: string;
  requestId?: string;
  runtimeSessionId?: string;
  /** Provenance hints for group-chat captures when a terminal event can be tied to a wake request. */
  logicalRunId?: string;
  executionId?: string;
  projectionId?: string;
  forecastId?: string;
  wakeRequestId?: string;
  k: {
    memoryRefs: string[];
    contextRefs: string[];
    abilityAssetRefs: string[];
    promptContextSummary?: string;
  };
  s: {
    conversationSummary?: string;
    workspaceId?: string;
    workingDir?: string;
    modelProfile?: string;
  };
  t: {
    userGoal: string;
    normalizedTask?: string;
    constraints: string[];
  };
  a: {
    plan?: unknown;
    toolCalls: KstarToolCall[];
    agentActions: KstarAgentAction[];
  };
  r: {
    status: KstarTaskStatus;
    finalText?: string;
    producedFiles: string[];
    verification?: unknown;
    userFeedback?: unknown;
    failureKind?: string;
    failureCode?: string;
    durationMs?: number;
    toolCallCount?: number;
    failedToolCount?: number;
    networkAccess?: boolean;
  };
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
  updatedAt: string;
}

export type KstarReviewState = 'inferred' | 'needs_confirmation' | 'confirmed' | 'unknown';
export type KstarReviewInferenceMethod = 'deterministic' | 'model' | 'commander' | 'user' | 'unknown';
export type KstarEvidenceLayer = 'fact' | 'inference' | 'experience';
export type KstarReviewStatus = 'pending' | 'confirmed' | 'rejected' | 'skipped';

export interface KstarReviewRecord extends KstarJsonRecord {
  schemaVersion: 1;
  episodeId: string;
  expectedResult?: string;
  actualResult?: string;
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  outcome: KstarOutcome;
  attribution: KstarAttribution;
  reason: string;
  confidence: number;
  actionDelta?: ActionDeltaDetail;
  resultDelta?: ResultDeltaDetail;
  reviewState?: KstarReviewState;
  inferenceMethod?: KstarReviewInferenceMethod;
  needsConfirmation?: boolean;
  evidenceLayer?: KstarEvidenceLayer;
  reviewStatus?: KstarReviewStatus;
  confirmedAt?: string;
  /** Model-reasoned reusable lesson ("why the gap happened + what is worth
   *  reusing"). When present it becomes the precipitation judgment instead
   *  of a fixed template sentence. */
  lesson?: string;
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface KstarLearningSignal {
  expectedResult?: string;
  actualResult?: string;
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  outcome: KstarOutcome;
  confidence: number;
  source: 'review';
}

export interface KstarLearningProvenance {
  projectionId: string;
  /** Missing only when advisory Forecast generation degraded before execution. */
  forecastId?: string;
  episodeId: string;
  ruleRefs: string[];
  attribution: KstarAttribution;
  actionDelta?: ActionDeltaDetail;
  resultDelta?: ResultDeltaDetail;
}

export interface KstarCandidateProposal {
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedAction?: 'create' | 'update' | 'limit_scope' | 'pause' | 'keep_current' | 'reject';
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  /** 适用范围。规则类候选必须带（PRD 3.1 的 RuleAsset 最低门槛）。
   *  只能写 Episode 真实支撑得起的范围——这条教训是在哪类任务上学到的，
   *  就只声明适用于哪类任务；不编造禁止范围。 */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  sourceRefs: CognitionSourceRef[];
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
}

export interface KstarExtractionRunRecord extends KstarJsonRecord {
  schemaVersion: 1;
  episodeId: string;
  reviewId: string;
  candidateIds: string[];
  status: 'created' | 'partial' | 'degraded' | 'failed';
  /** Result ids are populated when the requirement-level extraction pass runs. */
  createdAssetIds?: string[];
  mergedIntoIds?: string[];
  updateCandidateIds?: string[];
  failureIds?: string[];
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type KstarFailureStage = 'capture' | 'review_inference' | 'precipitation' | 'control_receipt';

export interface KstarFailureRecord extends KstarJsonRecord {
  schemaVersion: 1;
  stage: KstarFailureStage;
  errorCode: string;
  errorMessage: string;
  at: string;
  operationKey: string;
  conversationId?: string;
  episodeId?: string;
  requirementId?: string;
  taskId?: string;
}
