import type { AbilityAssetType } from '../recall/candidate-service';
import type { CognitionSourceRef } from '../recall/source-service';

export const KSTAR_SCHEMA_VERSION = 1;

export type KstarTaskStatus = 'completed' | 'failed' | 'cancelled' | 'waiting_input';
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
  name: string;
  argumentsSummary?: string;
  status?: 'ok' | 'error' | 'cancelled' | 'unknown';
}

export interface KstarAgentAction {
  actor?: string;
  action: string;
  summary?: string;
}

export interface KstarEpisodeRecord extends KstarJsonRecord {
  schemaVersion: 1;
  sessionId: string;
  sessionKind?: string;
  taskRunId?: string;
  requestId?: string;
  runtimeSessionId?: string;
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
  };
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface KstarReviewRecord extends KstarJsonRecord {
  schemaVersion: 1;
  episodeId: string;
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  outcome: KstarOutcome;
  attribution: KstarAttribution;
  reason: string;
  confidence: number;
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface KstarCandidateProposal {
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: CognitionSourceRef[];
}

export interface KstarExtractionRunRecord extends KstarJsonRecord {
  schemaVersion: 1;
  episodeId: string;
  reviewId: string;
  candidateIds: string[];
  status: 'created' | 'partial' | 'failed';
  createdAt: string;
  updatedAt: string;
  error?: string;
}
