import type { CognitionSourceRef } from '../recall/source-service';
import type { ActionDeltaDetail, ResultDeltaDetail } from '../recall/world-model-types';
import type { KstarAttribution, KstarJsonRecord, KstarOutcome } from './types';
import type { KstarControlReceipt } from './control-types';

export const KSTAR_PRM_WEIGHTS = Object.freeze({
  accuracy: 0.3,
  completeness: 0.3,
  usefulness: 0.2,
  clarity: 0.2,
});

/**
 * @deprecated Legacy audit vocabulary from the removed pre-Commander router.
 * Kept only for schema/source compatibility of persisted records. No new
 * runtime code may import or write this intent; the Commander decides the
 * lifecycle through kstar_control operations.
 */
export type KstarRequirementIntent = 'new' | 'continue' | 'complete' | 'topic_switch';
export type KstarTaskPhase = 'open' | 'closing' | 'closed' | 'abandoned';
export type KstarRequirementStatus = 'open' | 'waiting_review' | 'closed' | 'abandoned';
export type KstarForecastStatus = 'pending' | 'committed' | 'failed' | 'skipped';

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
  actionDelta?: ActionDeltaDetail;
  resultDelta?: ResultDeltaDetail;
  evidenceRefs: CognitionSourceRef[];
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
  /** Durable bridge to the CogSeed backend task, when this requirement uses it. */
  cogseedTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KstarRequirementRecord extends KstarJsonRecord {
  schemaVersion: 1;
  taskId: string;
  conversationId: string;
  /** 工作空间归属（空间会话即空间 id）；store 层校验并落盘（requirement-store:161/288）。 */
  workspaceId?: string;
  userMessageIds: string[];
  episodeIds: string[];
  status: KstarRequirementStatus;
  title: string;
  goalText: string;
  rHat?: KstarExpectedResult;
  /** Task-scoped Recall projection used as the preloaded asset list for this requirement. */
  projectionId?: string;
  /** Full ordered history of Recall projections created for this requirement.
   *  `projectionId` stays as the latest pointer for backward-compatible
   *  lifecycle/wake lookups; this array retains every prior projection. */
  projectionIds: string[];
  /** World-model forecast record produced at task boundary ((A_hat, R_hat)). */
  forecastId?: string;
  forecastStatus?: KstarForecastStatus;
  forecastError?: string;
  /** Wake request bound when the preloaded asset list is confirmed and the Agent is woken. */
  wakeRequestId?: string;
  /** Commander-submitted terminal evidence via kstar_control.finish/abandon. */
  completionEvidence?: KstarCompletionEvidence;
  prmReview?: KstarRequirementPrmReview;
  aar?: KstarAfterActionReview;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KstarCompletionEvidence {
  finalStatus?: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  finalText?: string;
  producedFiles: string[];
  acceptanceEvidence: string[];
  closeReason?: string;
}

export interface KstarProjectionDecisionMarker {
  /** `${projectionId}:${decision}` — the idempotency key of a resumed decision. */
  key: string;
  projectionId: string;
  decision: 'approved' | 'rejected';
  resumed: boolean;
  createdAt: string;
}

/**
 * Routing-decision kinds — the single source of truth.
 *
 * The type below is derived from this array and `normalizeRoutingDecisions`
 * filters against it, so a kind can no longer exist in the type while being
 * dropped by the store. That divergence is exactly how `answer_confirmation`
 * silently failed to persist when it was added: the array is checked on both
 * write and read.
 *
 * `trivial` and `dispatch_auto` were removed rather than kept as legacy: no
 * commit in this repository's history ever wrote them, so no persisted record
 * can contain them. (`obviously_trivial` below is the live gate, named after
 * `isObviouslyTrivial`; it is not a revival of that dead `trivial` string.)
 *
 * The two silent gates were added last: `obviously_trivial` short-circuited
 * with no record and no log at all, and `routing_unavailable` (no configured
 * model) was logged but never persisted. Without them the gate distribution
 * was not countable — only the gates that happened to log could be seen.
 */
export const KSTAR_ROUTING_KINDS = [
  'closing_intent',
  'obviously_trivial',
  'answer_confirmation',
  'model_judged',
  'routing_failed',
  'routing_unavailable',
] as const;

export type KstarRoutingKind = (typeof KSTAR_ROUTING_KINDS)[number];

export interface KstarRoutingDecision {
  at: string;
  kind: KstarRoutingKind;
  isTask: boolean;
  continuation?: boolean;
  reason?: string;
  sourceMessageId?: string;
}

export interface KstarConversationTaskStateRecord extends KstarJsonRecord {
  schemaVersion: 1;
  conversationId: string;
  currentTaskId?: string;
  currentRequirementId?: string;
  requirementJustClosed?: string;
  taskComplete: boolean;
  /** ISO timestamp of the scheduled auto-close (静默窗口到期)。任务终态后
   *  写入；用户新消息到达即清除；重启后由 recoverPendingAutoClosures 恢复。 */
  pendingAutoCloseAt?: string;
  lastRoutedUserMessageId?: string;
  controlReceipts?: KstarControlReceipt[];
  projectionDecisions?: KstarProjectionDecisionMarker[];
  routingDecisions?: KstarRoutingDecision[];
  createdAt: string;
  updatedAt: string;
}
