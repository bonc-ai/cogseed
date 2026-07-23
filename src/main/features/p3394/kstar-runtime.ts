import { Mutex } from 'async-mutex';
import * as path from 'node:path';

import { userLocalRoot } from '../../paths';
import { genId12, nowIso, readJson, safeId, writeJson } from '../../storage';

export interface EvidenceItem {
  id: string;
  type: 'agent_run_result' | 'conversation_message';
  source_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface KStarVerification {
  status: 'passed' | 'failed';
  notes: string;
  reviewed_at: string;
}

export interface ExperienceCandidate {
  id: string;
  source_run_id: string;
  conversation_id: string;
  agent_id: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
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
  experience_candidate_id?: string;
  created_at: string;
  updated_at: string;
}

interface KStarState {
  version: 1;
  runs: KStarRun[];
  experience_candidates: ExperienceCandidate[];
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
}): Promise<KStarRun> {
  validateScope(input.conversationId, input.agentId, input.turnId);
  if (!safeId(input.messageId)) throw new Error('invalid message id');
  return mutate(uid, (state) => {
    const run = findOrCreateRun(state, input);
    if (!run.evidence_items.some((item) => item.type === 'conversation_message' && item.source_id === input.messageId)) {
      run.evidence_items.push({
        id: genId12(), type: 'conversation_message', source_id: input.messageId,
        data: { text: input.actualResult }, created_at: nowIso(),
      });
    }
    run.actual_result = input.actualResult;
    run.status = 'needs_review';
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

export async function getExperienceCandidate(uid: string, candidateId: string): Promise<ExperienceCandidate | null> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  const state = await readState(uid);
  return state.experience_candidates.find((item) => item.id === candidateId) || null;
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
