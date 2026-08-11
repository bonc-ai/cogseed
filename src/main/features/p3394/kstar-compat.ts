/**
 * kstar-compat.ts — Compatibility layer for old P3394 DTOs
 *
 * Projects Engine types to legacy PC business-logic shapes. PC features only
 * see these projected DTOs, never raw Engine types. Engine-owned opaque fields
 * are preserved byte-for-byte.
 *
 * This layer exists to decouple PC business logic from Engine internal schema
 * changes during the migration.
 */

// ── Type definitions (extracted from old the deleted legacy PC KSTAR runtime) ─────────────────

export interface EvidenceItem {
  id: string;
  type: 'agent_run_result' | 'conversation_message' | 'tool_cycle';
  source_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface KStarCompatEpisode {
  episode_id: string;
  bundle_id: string;
  k_snapshot_ref: string;
  situation: string;
  task: string;
  action_hat: string;
  result_hat: string;
  actual_action: string;
  actual_result: string;
  delta_r: number;
  delta_a: number;
  delta_a_confidence_gate: 'pass' | 'warn' | 'fail';
  timestamp: string;
  session_id: string;
}

export interface CompatExperienceCandidateNotionSync {
  status: 'synced' | 'failed';
  page_id?: string;
  url?: string;
  synced_at?: string;
  error?: string;
  result?: Record<string, unknown>;
}

export interface CompatExperienceCandidate {
  id: string;
  source_run_id: string;
  conversation_id: string;
  agent_id: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  promotion_status?: 'none' | 'promoted' | 'failed';
  kb_path?: string;
  promoted_at?: string;
  promotion_error?: string;
  notion_sync?: CompatExperienceCandidateNotionSync;
  created_at: string;
  updated_at: string;
}

export interface KStarCompatVerification {
  status: 'passed' | 'failed';
  notes: string;
  reviewed_at: string;
}

export interface KStarExpectation {
  k_snapshot_ref?: string;
  situation?: string;
  task?: string;
  action_hat?: string;
  result_hat?: string;
}

export interface KStarDecisionRecord {
  required: boolean;
  reason: string;
  expectation: KStarExpectation;
  source?: 'commander' | 'bus_guard';
  commander_mode?: 'required' | 'skip';
  guard?: { upgraded: boolean; matched_rules: string[]; confidence: 'hard' | 'soft' };
}

export interface KStarCompatToolCycle {
  id: string;
  conversation_id: string;
  agent_id: string;
  turn_id: string;
  tool_call_id: string;
  tool_name: string;
  phase: 'end';
  arguments_shape?: Record<string, unknown>;
  result_preview: string;
  result_size?: number;
  is_error: boolean;
  status: 'succeeded' | 'failed' | 'unknown';
  r_hat: number;
  r: number;
  delta_r: number;
  verifier_method: 'error_signal' | 'file_signal' | 'content_signal' | 'generic_signal';
  duration_ms?: number;
  created_at: string;
}

export interface KStarEngineToolCall {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  arguments?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export interface KStarCompatEngineRun {
  status: 'skipped' | 'completed' | 'failed';
  reason?: string;
  tool_calls: KStarEngineToolCall[];
  capture_interaction?: Record<string, unknown>;
  analyze_attribution?: Record<string, unknown>;
  route_recommendation?: Record<string, unknown>;
  run_governance?: Record<string, unknown>;
  human_review?: Record<string, unknown>;
  error?: unknown;
  updated_at: string;
}

export interface KStarCompatRun {
  id: string;
  conversation_id: string;
  agent_id: string;
  turn_id: string;
  status: 'running' | 'needs_review' | 'completed' | 'failed';
  actual_result: string;
  evidence_items: EvidenceItem[];
  verification: KStarCompatVerification | null;
  kstar_decision?: KStarDecisionRecord;
  kstar_episode?: KStarCompatEpisode;
  kstar_engine?: KStarCompatEngineRun;
  experience_candidate_id?: string;
  created_at: string;
  updated_at: string;
}

export interface KStarCompatCollaborationEvidence {
  id: string;
  conversation_id: string;
  agent_id: string;
  turn_id: string;
  message_id: string;
  outcome_status: 'success' | 'failure' | 'error';
  actual_result: string;
  actual_action: string;
  kstar_decision: KStarDecisionRecord;
  evidence_items: EvidenceItem[];
  validation_run_id?: string;
  created_at: string;
  updated_at: string;
}

// ── Evidence projection ─────────────────────────────────────────────────

export function projectEvidenceToLegacy(engineEvidence: Record<string, unknown>): EvidenceItem {
  const { id, type, created_at, ...rest } = engineEvidence;

  return {
    id: String(id || 'unknown'),
    type: (type as EvidenceItem['type']) || 'tool_cycle',
    source_id: String(engineEvidence.source_id || engineEvidence.conversation_id || id || 'unknown'),
    data: rest as Record<string, unknown>,
    created_at: String(created_at || new Date().toISOString()),
  };
}

// ── Episode projection ──────────────────────────────────────────────────

export function projectEpisodeToLegacy(engineEpisode: Record<string, unknown>): KStarCompatEpisode {
  return {
    episode_id: String(engineEpisode.episode_id || ''),
    bundle_id: String(engineEpisode.bundle_id || ''),
    k_snapshot_ref: String(engineEpisode.k_snapshot_ref || ''),
    situation: String(engineEpisode.situation || ''),
    task: String(engineEpisode.task || ''),
    action_hat: String(engineEpisode.action_hat || ''),
    result_hat: String(engineEpisode.result_hat || ''),
    actual_action: String(engineEpisode.actual_action || ''),
    actual_result: String(engineEpisode.actual_result || ''),
    delta_r: Number(engineEpisode.delta_r || 0),
    delta_a: Number(engineEpisode.delta_a || 0),
    delta_a_confidence_gate: (engineEpisode.delta_a_confidence_gate as KStarCompatEpisode['delta_a_confidence_gate']) || 'warn',
    timestamp: String(engineEpisode.timestamp || new Date().toISOString()),
    session_id: String(engineEpisode.session_id || ''),
  };
}

// ── Experience candidate projection ─────────────────────────────────────

export function projectExperienceToLegacy(
  engineExperience: Record<string, unknown>,
  sourceRunId: string,
  conversationId: string,
  agentId: string,
): CompatExperienceCandidate {
  return {
    id: String(engineExperience.id || ''),
    source_run_id: sourceRunId,
    conversation_id: conversationId,
    agent_id: agentId,
    summary: String(engineExperience.summary || ''),
    status: (engineExperience.status as CompatExperienceCandidate['status']) || 'pending',
    promotion_status: engineExperience.promotion_status as CompatExperienceCandidate['promotion_status'],
    kb_path: engineExperience.kb_path as string | undefined,
    promoted_at: engineExperience.promoted_at as string | undefined,
    promotion_error: engineExperience.promotion_error as string | undefined,
    notion_sync: engineExperience.notion_sync as CompatExperienceCandidate['notion_sync'],
    created_at: String(engineExperience.created_at || new Date().toISOString()),
    updated_at: String(engineExperience.updated_at || new Date().toISOString()),
  };
}
