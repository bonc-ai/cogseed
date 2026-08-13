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

export interface CompatPatchCandidate {
  id: string;
  source_run_id: string;
  source_experience_id?: string;
  conversation_id: string;
  agent_id: string;
  type: 'memory_patch' | 'skill_patch' | 'ontology_patch';
  target: { kind: 'kb' | 'memory' | 'custom_skill' | 'ontology'; id?: string; path?: string; version?: string };
  proposal: { title: string; summary: string; rationale: string; current_content?: string; proposed_content: string; diff?: string };
  engine: { attribution_id?: string; proposal_id?: string; governance_decision_id?: string; route_action?: string; raw?: Record<string, unknown> };
  status: 'proposed' | 'needs_review' | 'approved' | 'rejected' | 'applied' | 'failed';
  review?: { decision: 'approve' | 'reject'; notes?: string; reviewed_at: string };
  validation_id?: string;
  validation_status?: 'pass' | 'risk' | 'blocked' | 'degraded';
  execution_id?: string; receipt_id?: string; contrast_id?: string;
  boundary?: import('./execution-boundary').ExecutionBoundaryInfo;
  applied?: { target_path?: string; applied_at: string };
  created_at: string;
  updated_at: string;
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
  patch_status?: 'not_needed' | 'not_attempted_without_patch_candidate' | 'proposed' | 'governed' | 'human_reviewed';
  propose_patch?: Record<string, unknown>;
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

// ── Patch candidate projection ──────────────────────────────────────────

export function projectPatchToLegacy(
  enginePatch: Record<string, unknown>,
  sourceRunId: string,
  conversationId: string,
  agentId: string,
): CompatPatchCandidate {
  const target = (enginePatch.target as Record<string, unknown>) || {};
  const proposal = (enginePatch.proposal as Record<string, unknown>) || {};
  const engineMetadata = (enginePatch.engine_metadata as Record<string, unknown>) || {};

  return {
    id: String(enginePatch.id || ''),
    source_run_id: sourceRunId,
    source_experience_id: enginePatch.source_experience_id as string | undefined,
    conversation_id: conversationId,
    agent_id: agentId,
    type: (enginePatch.type as CompatPatchCandidate['type']) || 'memory_patch',
    target: {
      kind: (target.kind as CompatPatchCandidate['target']['kind']) || 'memory',
      id: target.id as string | undefined,
      path: target.path as string | undefined,
      version: target.version as string | undefined,
    },
    proposal: {
      title: String(proposal.title || ''),
      summary: String(proposal.summary || ''),
      rationale: String(proposal.rationale || ''),
      current_content: proposal.current_content as string | undefined,
      proposed_content: String(proposal.proposed_content || ''),
      diff: proposal.diff as string | undefined,
    },
    engine: {
      attribution_id: engineMetadata.attribution_id as string | undefined,
      proposal_id: engineMetadata.proposal_id as string | undefined,
      governance_decision_id: engineMetadata.governance_decision_id as string | undefined,
      route_action: engineMetadata.route_action as string | undefined,
      raw: engineMetadata as Record<string, unknown>,
    },
    status: (enginePatch.status as CompatPatchCandidate['status']) || 'proposed',
    review: enginePatch.review as CompatPatchCandidate['review'],
    applied: enginePatch.applied as CompatPatchCandidate['applied'],
    created_at: String(enginePatch.created_at || new Date().toISOString()),
    updated_at: String(enginePatch.updated_at || new Date().toISOString()),
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
