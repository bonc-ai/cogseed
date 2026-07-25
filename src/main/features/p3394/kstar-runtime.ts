import { Mutex } from 'async-mutex';
import * as path from 'node:path';

import { userLocalRoot } from '../../paths';
import { genId12, nowIso, readJson, safeId, writeJson } from '../../storage';

export interface EvidenceItem {
  id: string;
  type: 'agent_run_result' | 'conversation_message' | 'tool_cycle';
  source_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface KStarToolCycle {
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

export interface KStarVerification {
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

export interface KStarEpisode {
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


export interface KStarEngineToolCall {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  arguments?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export interface KStarEngineRun {
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

export interface ExperienceCandidateNotionSync {
  status: 'synced' | 'failed';
  page_id?: string;
  url?: string;
  synced_at?: string;
  error?: string;
  result?: Record<string, unknown>;
}


export interface PatchCandidate {
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
  applied?: { target_path?: string; applied_at: string };
  created_at: string;
  updated_at: string;
}

export interface ExperienceCandidate {
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
  notion_sync?: ExperienceCandidateNotionSync;
  created_at: string;
  updated_at: string;
}

export interface KStarRun {
  id: string;
  conversation_id: string;
  agent_id: string;
  turn_id: string;
  status: 'running' | 'needs_review' | 'completed' | 'failed';
  actual_result: string;
  evidence_items: EvidenceItem[];
  verification: KStarVerification | null;
  kstar_decision?: KStarDecisionRecord;
  kstar_episode?: KStarEpisode;
  kstar_engine?: KStarEngineRun;
  experience_candidate_id?: string;
  created_at: string;
  updated_at: string;
}

interface KStarState {
  version: 1;
  runs: KStarRun[];
  experience_candidates: ExperienceCandidate[];
  patch_candidates: PatchCandidate[];
  tool_cycles: KStarToolCycle[];
  updated_at: string;
}

const locks = new Map<string, Mutex>();
function lockFor(uid: string): Mutex {
  const found = locks.get(uid);
  if (found) return found;
  const created = new Mutex();
  locks.set(uid, created);
  return created;
}
function stateFile(uid: string): string {
  return path.join(userLocalRoot(uid), 'p3394', 'kstar-state.json');
}
async function readState(uid: string): Promise<KStarState> {
  const raw = await readJson<Partial<KStarState>>(stateFile(uid));
  return {
    version: 1,
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    experience_candidates: Array.isArray(raw.experience_candidates) ? raw.experience_candidates : [],
    patch_candidates: Array.isArray((raw as Partial<KStarState>).patch_candidates) ? (raw as Partial<KStarState>).patch_candidates as PatchCandidate[] : [],
    tool_cycles: Array.isArray((raw as Partial<KStarState>).tool_cycles) ? (raw as Partial<KStarState>).tool_cycles as KStarToolCycle[] : [],
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
  };
}
async function mutate<T>(uid: string, fn: (state: KStarState) => T | Promise<T>): Promise<T> {
  return lockFor(uid).runExclusive(async () => {
    const state = await readState(uid);
    const result = await fn(state);
    state.updated_at = nowIso();
    await writeJson(stateFile(uid), state);
    return result;
  });
}
function validateScope(conversationId: string, agentId: string, turnId: string): void {
  if (!safeId(conversationId)) throw new Error('invalid conversation id');
  if (!safeId(agentId)) throw new Error('invalid agent id');
  if (!safeId(turnId)) throw new Error('invalid turn id');
}
function findOrCreateRun(state: KStarState, input: { conversationId: string; agentId: string; turnId: string }): KStarRun {
  let run = state.runs.find((item) => item.conversation_id === input.conversationId && item.turn_id === input.turnId);
  if (run) return run;
  const now = nowIso();
  run = {
    id: genId12(), conversation_id: input.conversationId, agent_id: input.agentId,
    turn_id: input.turnId, status: 'running', actual_result: '', evidence_items: [],
    verification: null, created_at: now, updated_at: now,
  };
  state.runs.push(run);
  return run;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function rHatForTool(toolName: string): number {
  const name = toolName.toLowerCase();
  if (/read|search|grep|stat|kb/.test(name)) return 0.85;
  if (/write|edit|patch|file/.test(name)) return 0.8;
  if (/bash|shell|exec|terminal|command/.test(name)) return 0.72;
  if (/browser|web|connector|mcp/.test(name)) return 0.62;
  return 0.55;
}

function hasErrorSignal(text: string): boolean {
  return /\b(error|failed|failure|traceback|exception|permission denied|not found|exit code [1-9]|exit_code[=: ]+[1-9])\b/i.test(text);
}

function scoreToolResult(input: { toolName: string; resultPreview: string; resultSize?: number; isError: boolean }): Pick<KStarToolCycle, 'r' | 'status' | 'verifier_method'> {
  const name = input.toolName.toLowerCase();
  const text = input.resultPreview || '';
  if (input.isError || hasErrorSignal(text)) {
    return { r: 0.15, status: 'failed', verifier_method: 'error_signal' };
  }
  if (/write|edit|patch|file/.test(name)) {
    return { r: text.trim() || Number(input.resultSize || 0) > 0 ? 0.86 : 0.45, status: 'succeeded', verifier_method: 'file_signal' };
  }
  if (text.trim().length >= 80 || Number(input.resultSize || 0) >= 500) {
    return { r: 0.78, status: 'succeeded', verifier_method: 'content_signal' };
  }
  if (text.trim()) return { r: 0.58, status: 'unknown', verifier_method: 'generic_signal' };
  return { r: 0.35, status: 'unknown', verifier_method: 'generic_signal' };
}

function clippedPreview(value: string): string {
  const text = String(value || '').trim();
  return text.length > 1000 ? text.slice(0, 1000) : text;
}

function toolCycleEvidenceData(cycle: KStarToolCycle): Record<string, unknown> {
  return {
    tool_name: cycle.tool_name,
    status: cycle.status,
    verifier_method: cycle.verifier_method,
    r_hat: cycle.r_hat,
    r: cycle.r,
    delta_r: cycle.delta_r,
    is_error: cycle.is_error,
    ...(typeof cycle.duration_ms === 'number' ? { duration_ms: cycle.duration_ms } : {}),
    ...(typeof cycle.result_size === 'number' ? { result_size: cycle.result_size } : {}),
    ...(cycle.result_preview ? { result_preview: cycle.result_preview } : {}),
  };
}

export async function recordKStarToolCycle(uid: string, input: {
  conversationId: string;
  agentId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  phase?: 'end';
  argumentsShape?: Record<string, unknown>;
  resultPreview?: string;
  resultSize?: number;
  isError?: boolean;
  durationMs?: number;
}): Promise<KStarToolCycle> {
  validateScope(input.conversationId, input.agentId, input.turnId);
  if (!safeId(input.toolCallId)) throw new Error('invalid KSTAR tool call id');
  const toolName = String(input.toolName || '').trim().slice(0, 120);
  if (!toolName) throw new Error('tool name required');
  return mutate(uid, (state) => {
    const existing = state.tool_cycles.find((item) => item.conversation_id === input.conversationId
      && item.agent_id === input.agentId
      && item.turn_id === input.turnId
      && item.tool_call_id === input.toolCallId);
    if (existing) return existing;
    const resultPreview = clippedPreview(input.resultPreview || '');
    const rHat = rHatForTool(toolName);
    const scored = scoreToolResult({
      toolName,
      resultPreview,
      resultSize: input.resultSize,
      isError: !!input.isError,
    });
    const now = nowIso();
    const cycle: KStarToolCycle = {
      id: genId12(),
      conversation_id: input.conversationId,
      agent_id: input.agentId,
      turn_id: input.turnId,
      tool_call_id: input.toolCallId,
      tool_name: toolName,
      phase: 'end',
      ...(input.argumentsShape ? { arguments_shape: input.argumentsShape } : {}),
      result_preview: resultPreview,
      ...(Number.isFinite(input.resultSize) ? { result_size: Math.max(0, Math.round(Number(input.resultSize))) } : {}),
      is_error: !!input.isError,
      status: scored.status,
      r_hat: rHat,
      r: clampScore(scored.r),
      delta_r: clampScore(scored.r) - rHat,
      verifier_method: scored.verifier_method,
      ...(Number.isFinite(input.durationMs) ? { duration_ms: Math.max(0, Math.round(Number(input.durationMs))) } : {}),
      created_at: now,
    };
    cycle.delta_r = Math.round(cycle.delta_r * 100) / 100;
    state.tool_cycles.push(cycle);
    return cycle;
  });
}

export async function listKStarToolCycles(uid: string, conversationId?: string): Promise<KStarToolCycle[]> {
  const state = await readState(uid);
  return state.tool_cycles
    .filter((cycle) => !conversationId || cycle.conversation_id === conversationId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function recordAgentRunEvidence(uid: string, input: {
  conversationId: string; agentId: string; turnId: string; data: Record<string, unknown>;
}): Promise<KStarRun> {
  validateScope(input.conversationId, input.agentId, input.turnId);
  return mutate(uid, (state) => {
    const run = findOrCreateRun(state, input);
    if (!run.evidence_items.some((item) => item.type === 'agent_run_result' && item.source_id === input.turnId)) {
      run.evidence_items.push({
        id: genId12(), type: 'agent_run_result', source_id: input.turnId,
        data: { ...input.data }, created_at: nowIso(),
      });
    }
    run.updated_at = nowIso();
    return run;
  });
}

export async function finalizeAgentTurn(uid: string, input: {
  conversationId: string; agentId: string; turnId: string; messageId: string; actualResult: string;
  kstarDecision?: KStarDecisionRecord; actualAction?: string;
}): Promise<KStarRun> {
  validateScope(input.conversationId, input.agentId, input.turnId);
  if (!safeId(input.messageId)) throw new Error('invalid message id');
  return mutate(uid, (state) => {
    const run = findOrCreateRun(state, input);
    for (const cycle of state.tool_cycles.filter((item) => item.conversation_id === input.conversationId
      && item.agent_id === input.agentId
      && item.turn_id === input.turnId)) {
      if (!run.evidence_items.some((item) => item.type === 'tool_cycle' && item.source_id === cycle.id)) {
        run.evidence_items.push({
          id: genId12(), type: 'tool_cycle', source_id: cycle.id,
          data: toolCycleEvidenceData(cycle), created_at: nowIso(),
        });
      }
    }
    if (!run.evidence_items.some((item) => item.type === 'conversation_message' && item.source_id === input.messageId)) {
      run.evidence_items.push({
        id: genId12(), type: 'conversation_message', source_id: input.messageId,
        data: { text: input.actualResult }, created_at: nowIso(),
      });
    }
    run.actual_result = input.actualResult;
    if (input.kstarDecision?.required) {
      const expectation = input.kstarDecision.expectation || {};
      const timestamp = nowIso();
      run.kstar_decision = {
        ...input.kstarDecision,
        required: true,
        reason: input.kstarDecision.reason || 'Commander marked this delegated task as requiring KSTAR review.',
        expectation: { ...expectation },
      };
      run.kstar_episode = {
        episode_id: run.kstar_episode?.episode_id || genId12(),
        bundle_id: run.kstar_episode?.bundle_id || genId12(),
        k_snapshot_ref: expectation.k_snapshot_ref || `conversation:${input.conversationId}`,
        situation: expectation.situation || '',
        task: expectation.task || '',
        action_hat: expectation.action_hat || '',
        result_hat: expectation.result_hat || '',
        actual_action: input.actualAction || 'agent turn completed',
        actual_result: input.actualResult,
        delta_r: 0,
        delta_a: 0,
        delta_a_confidence_gate: input.actualResult.trim() ? 'pass' : 'warn',
        timestamp,
        session_id: input.conversationId,
      };
    }
    run.status = 'needs_review';
    run.updated_at = nowIso();
    return run;
  });
}


export async function getKStarRun(uid: string, runId: string): Promise<KStarRun | null> {
  if (!safeId(runId)) throw new Error('invalid KSTAR run id');
  const state = await readState(uid);
  return state.runs.find((item) => item.id === runId) || null;
}

export async function updateKStarEngineRun(uid: string, runId: string, engine: KStarEngineRun): Promise<KStarRun> {
  if (!safeId(runId)) throw new Error('invalid KSTAR run id');
  return mutate(uid, (state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error('KSTAR run not found');
    run.kstar_engine = { ...engine, tool_calls: Array.isArray(engine.tool_calls) ? engine.tool_calls : [] };
    run.updated_at = nowIso();
    return run;
  });
}

export async function listKStarRuns(uid: string, conversationId?: string): Promise<KStarRun[]> {
  const state = await readState(uid);
  return state.runs.filter((run) => !conversationId || run.conversation_id === conversationId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function reviewKStarRun(uid: string, runId: string, input: {
  decision: 'pass' | 'fail'; notes?: string;
}): Promise<{ run: KStarRun; experience_candidate: ExperienceCandidate | null }> {
  if (!safeId(runId)) throw new Error('invalid KSTAR run id');
  return mutate(uid, (state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error('KSTAR run not found');
    if (run.status !== 'needs_review') throw new Error(`KSTAR run cannot be reviewed from ${run.status}`);
    const now = nowIso();
    run.verification = {
      status: input.decision === 'pass' ? 'passed' : 'failed',
      notes: input.notes?.trim() || '', reviewed_at: now,
    };
    run.status = input.decision === 'pass' ? 'completed' : 'failed';
    run.updated_at = now;
    if (input.decision === 'fail') return { run, experience_candidate: null };
    let candidate = state.experience_candidates.find((item) => item.source_run_id === run.id);
    if (!candidate) {
      candidate = {
        id: genId12(), source_run_id: run.id, conversation_id: run.conversation_id,
        agent_id: run.agent_id, summary: run.actual_result.slice(0, 1000), status: 'pending',
        created_at: now, updated_at: now,
      };
      state.experience_candidates.push(candidate);
      run.experience_candidate_id = candidate.id;
    }
    return { run, experience_candidate: candidate };
  });
}

export async function listExperienceCandidates(
  uid: string,
  conversationId?: string,
): Promise<ExperienceCandidate[]> {
  const state = await readState(uid);
  return state.experience_candidates
    .filter((candidate) => !conversationId || candidate.conversation_id === conversationId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}


function patchTypeForRoute(routeAction: string): PatchCandidate['type'] {
  if (/ontology/i.test(routeAction)) return 'ontology_patch';
  if (/memory|kb|experience/i.test(routeAction)) return 'memory_patch';
  return 'skill_patch';
}

function patchTargetForType(type: PatchCandidate['type'], run: KStarRun): PatchCandidate['target'] {
  if (type === 'ontology_patch') return { kind: 'ontology', id: run.kstar_episode?.k_snapshot_ref || 'unknown' };
  if (type === 'memory_patch') return { kind: 'kb', path: 'kstar-experiences' };
  return { kind: 'custom_skill', id: run.agent_id };
}

export async function createPatchCandidateFromEngineRun(
  uid: string,
  runId: string,
  engine: KStarEngineRun,
): Promise<PatchCandidate | null> {
  if (!safeId(runId)) throw new Error('invalid KSTAR run id');
  const routeAction = typeof engine.route_recommendation?.action === 'string'
    ? String(engine.route_recommendation.action)
    : '';
  if (!routeAction || routeAction === 'no_action') return null;
  return mutate(uid, (state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error('KSTAR run not found');
    const existing = state.patch_candidates.find((item) => item.source_run_id === run.id && item.engine.route_action === routeAction);
    if (existing) return existing;
    const now = nowIso();
    const type = patchTypeForRoute(routeAction);
    const routeMessage = typeof engine.route_recommendation?.message === 'string'
      ? String(engine.route_recommendation.message)
      : '';
    const candidate: PatchCandidate = {
      id: genId12(),
      source_run_id: run.id,
      conversation_id: run.conversation_id,
      agent_id: run.agent_id,
      type,
      target: patchTargetForType(type, run),
      proposal: {
        title: `KSTAR ${routeAction}`,
        summary: routeMessage || engine.reason || 'KSTAR engine recommended a reviewable improvement.',
        rationale: engine.reason || routeMessage || 'Generated from KSTAR engine route recommendation.',
        proposed_content: routeMessage || engine.reason || 'Review KSTAR engine output before applying changes.',
      },
      engine: {
        attribution_id: typeof engine.analyze_attribution?.attribution_id === 'string' ? String(engine.analyze_attribution.attribution_id) : undefined,
        route_action: routeAction,
        raw: engine.route_recommendation,
      },
      status: 'needs_review',
      created_at: now,
      updated_at: now,
    };
    state.patch_candidates.push(candidate);
    return candidate;
  });
}

export async function listPatchCandidates(uid: string, conversationId?: string): Promise<PatchCandidate[]> {
  const state = await readState(uid);
  return state.patch_candidates
    .filter((candidate) => !conversationId || candidate.conversation_id === conversationId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function reviewPatchCandidate(
  uid: string,
  candidateId: string,
  decision: 'approve' | 'reject',
  notes = '',
): Promise<PatchCandidate> {
  if (!safeId(candidateId)) throw new Error('invalid patch candidate id');
  return mutate(uid, (state) => {
    const candidate = state.patch_candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('patch candidate not found');
    if (candidate.status !== 'needs_review' && candidate.status !== 'proposed') {
      throw new Error(`patch candidate cannot be reviewed from ${candidate.status}`);
    }
    const now = nowIso();
    candidate.status = decision === 'approve' ? 'approved' : 'rejected';
    candidate.review = { decision, ...(notes.trim() ? { notes: notes.trim() } : {}), reviewed_at: now };
    candidate.updated_at = now;
    return candidate;
  });
}

export async function getExperienceCandidate(uid: string, candidateId: string): Promise<ExperienceCandidate | null> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  const state = await readState(uid);
  return state.experience_candidates.find((item) => item.id === candidateId) || null;
}


export async function markExperienceCandidateKnowledgePromotion(
  uid: string,
  candidateId: string,
  input: { status: 'promoted'; path: string } | { status: 'failed'; error: string },
): Promise<ExperienceCandidate> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  return mutate(uid, (state) => {
    const candidate = state.experience_candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('experience candidate not found');
    const now = nowIso();
    if (input.status === 'promoted') {
      candidate.promotion_status = 'promoted';
      candidate.kb_path = input.path;
      candidate.promoted_at = now;
      delete candidate.promotion_error;
    } else {
      candidate.promotion_status = 'failed';
      candidate.promotion_error = input.error;
    }
    candidate.updated_at = now;
    return candidate;
  });
}


export async function markExperienceCandidateNotionSync(
  uid: string,
  candidateId: string,
  input: { status: 'synced'; page_id?: string; url?: string; result?: Record<string, unknown> } | { status: 'failed'; error: string },
): Promise<ExperienceCandidate> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  return mutate(uid, (state) => {
    const candidate = state.experience_candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('experience candidate not found');
    const now = nowIso();
    if (input.status === 'synced') {
      candidate.notion_sync = {
        status: 'synced',
        ...(input.page_id ? { page_id: input.page_id } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.result ? { result: input.result } : {}),
        synced_at: now,
      };
    } else {
      candidate.notion_sync = { status: 'failed', error: input.error, synced_at: now };
    }
    candidate.updated_at = now;
    return candidate;
  });
}

export async function decideExperienceCandidate(
  uid: string,
  candidateId: string,
  decision: 'approve' | 'reject',
): Promise<ExperienceCandidate> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  return mutate(uid, (state) => {
    const candidate = state.experience_candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('experience candidate not found');
    if (candidate.status !== 'pending') throw new Error(`experience candidate cannot change from ${candidate.status}`);
    candidate.status = decision === 'approve' ? 'approved' : 'rejected';
    candidate.updated_at = nowIso();
    return candidate;
  });
}
