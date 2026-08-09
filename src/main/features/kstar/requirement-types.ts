import type { CognitionSourceRef } from '../recall/source-service';
import type { KstarAttribution, KstarJsonRecord, KstarOutcome } from './types';

export const KSTAR_PRM_WEIGHTS = Object.freeze({
  accuracy: 0.3,
  completeness: 0.3,
  usefulness: 0.2,
  clarity: 0.2,
});

export type KstarRequirementIntent = 'new' | 'continue' | 'complete' | 'topic_switch';
export type KstarTaskPhase = 'open' | 'closing' | 'closed' | 'abandoned';
export type KstarRequirementStatus = 'open' | 'waiting_review' | 'closed' | 'abandoned';

export interface KstarPrmScores {
  accuracy: number;
  completeness: number;
  usefulness: number;
  clarity: number;
}

export interface KstarExpectedResult {
  summary: string;
  acceptanceSignals: string[];
  source: 'user_message' | 'router' | 'model' | 'unknown';
  confidence: number;
}

export interface KstarAfterActionReview {
  keep: string[];
  change: string[];
  lesson: string;
  candidateSeed?: string;
  evidenceRefs: CognitionSourceRef[];
}

export interface KstarRequirementPrmReview {
  expectedResult?: string;
  actualResult?: string;
  scores: KstarPrmScores;
  weightedScore: number;
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  outcome: KstarOutcome;
  attribution: KstarAttribution;
  reason: string;
  confidence: number;
  evidenceRefs: CognitionSourceRef[];
}

export interface KstarPendingTaskStart {
  userMessageId: string;
  text: string;
  workspaceId?: string;
  reason: 'topic_switch';
}

export interface KstarTaskRecord extends KstarJsonRecord {
  schemaVersion: 1;
  conversationId: string;
  workspaceId?: string;
  title: string;
  status: KstarTaskPhase;
  requirementIds: string[];
  currentRequirementId?: string;
  closeReason?: 'user_complete' | 'topic_switch' | 'aborted';
  aggregateReviewId?: string;
  candidateRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KstarRequirementRecord extends KstarJsonRecord {
  schemaVersion: 1;
  taskId: string;
  conversationId: string;
  userMessageIds: string[];
  episodeIds: string[];
  status: KstarRequirementStatus;
  title: string;
  goalText: string;
  rHat?: KstarExpectedResult;
  /** Task-scoped Recall projection used as the preloaded asset list for this requirement. */
  projectionId?: string;
  /** Wake request bound when the preloaded asset list is confirmed and the Agent is woken. */
  wakeRequestId?: string;
  prmReview?: KstarRequirementPrmReview;
  aar?: KstarAfterActionReview;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KstarConversationTaskStateRecord extends KstarJsonRecord {
  schemaVersion: 1;
  conversationId: string;
  currentTaskId?: string;
  currentRequirementId?: string;
  requirementJustClosed?: string;
  taskComplete: boolean;
  pendingTaskStart?: KstarPendingTaskStart;
  lastRoutedUserMessageId?: string;
  createdAt: string;
  updatedAt: string;
}
