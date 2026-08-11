/**
 * kstar-legacy-data.ts — Legacy P3394 KSTAR data access (no delta computation)
 *
 * Holds the pre-migration `kstar-state.json` read/write helpers that manage
 * KStarCompatRun / CompatExperienceCandidate records. This module never
 * computes delta_a, delta_r, or route_recommendation locally — those values
 * are Engine-owned and only read here when already present on an
 * Engine-produced payload.
 *
 * `the deleted legacy PC KSTAR runtime` and `the deleted legacy PC KSTAR engine` (the old local fact model that DID
 * compute delta_a/delta_r) have been deleted. Any new evidence recording must
 * go through `kstar-adapter.ts` / `kstar-bus-integration.ts` instead of this
 * file.
 */

import * as path from 'node:path';
import { withKstarUserLock } from './kstar-lock';

import { userLocalRoot } from '../../paths';
import { genId12, nowIso, readJson, safeId, writeJson } from '../../storage';
import type {
  CompatExperienceCandidate,
  CompatExperienceCandidateNotionSync,
  KStarCompatEngineRun,
  KStarCompatRun,
} from './kstar-compat';

interface KStarLegacyState {
  version: 1;
  runs: KStarCompatRun[];
  experience_candidates: CompatExperienceCandidate[];
  updated_at: string;
  /**
   * Historical fields from the deleted the deleted legacy PC KSTAR runtime state shape
   * (tool_cycles, collaboration_evidence, ...). This module no longer reads
   * or computes them, but preserves them byte-for-byte on every write so
   * that kstar-migration.ts can still migrate/archive the full legacy
   * record later. Do not add typed accessors for these here — evidence
   * recording now goes through kstar-adapter.ts / kstar-bus-integration.ts.
   */
  [passthroughKey: string]: unknown;
}

function stateFile(uid: string): string {
  return path.join(userLocalRoot(uid), 'p3394', 'kstar-state.json');
}

async function readState(uid: string): Promise<KStarLegacyState> {
  const raw = await readJson<Partial<KStarLegacyState>>(stateFile(uid));
  return {
    ...raw,
    version: 1,
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    experience_candidates: Array.isArray(raw.experience_candidates) ? raw.experience_candidates : [],
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
  };
}

async function mutate<T>(uid: string, fn: (state: KStarLegacyState) => T | Promise<T>): Promise<T> {
  return await withKstarUserLock(uid, async () => {
    const state = await readState(uid);
    const result = await fn(state);
    state.updated_at = nowIso();
    await writeJson(stateFile(uid), state);
    return result;
  });
}

// ── Exported data-access functions (no delta computation) ──────────────────

export async function getKstarCompatProjection(uid: string, runId: string): Promise<KStarCompatRun | null> {
  if (!safeId(runId)) throw new Error('invalid KSTAR run id');
  const state = await readState(uid);
  return state.runs.find((item) => item.id === runId) || null;
}

export async function listKstarCompatProjections(uid: string, conversationId?: string): Promise<KStarCompatRun[]> {
  const state = await readState(uid);
  return state.runs
    .filter((run) => !conversationId || run.conversation_id === conversationId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function reviewKstarCompatProjection(
  uid: string,
  runId: string,
  input: { decision: 'pass' | 'fail'; notes?: string },
): Promise<{ run: KStarCompatRun; experience_candidate: CompatExperienceCandidate | null }> {
  if (!safeId(runId)) throw new Error('invalid KSTAR run id');
  return mutate(uid, (state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error('KSTAR run not found');
    if (run.status !== 'needs_review') throw new Error(`KSTAR run cannot be reviewed from ${run.status}`);
    const now = nowIso();
    run.verification = {
      status: input.decision === 'pass' ? 'passed' : 'failed',
      notes: input.notes?.trim() || '',
      reviewed_at: now,
    };
    run.status = input.decision === 'pass' ? 'completed' : 'failed';
    run.updated_at = now;
    if (input.decision === 'fail') return { run, experience_candidate: null };
    let candidate = state.experience_candidates.find((item) => item.source_run_id === run.id);
    if (!candidate) {
      candidate = {
        id: genId12(),
        source_run_id: run.id,
        conversation_id: run.conversation_id,
        agent_id: run.agent_id,
        summary: run.actual_result.slice(0, 1000),
        status: 'pending',
        created_at: now,
        updated_at: now,
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
): Promise<CompatExperienceCandidate[]> {
  const state = await readState(uid);
  return state.experience_candidates
    .filter((candidate) => !conversationId || candidate.conversation_id === conversationId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getExperienceCandidate(
  uid: string,
  candidateId: string,
): Promise<CompatExperienceCandidate | null> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  const state = await readState(uid);
  return state.experience_candidates.find((item) => item.id === candidateId) || null;
}

export async function markExperienceCandidateKnowledgePromotion(
  uid: string,
  candidateId: string,
  input: { status: 'promoted'; path: string } | { status: 'failed'; error: string },
): Promise<CompatExperienceCandidate> {
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
  input:
    | { status: 'synced'; page_id?: string; url?: string; result?: Record<string, unknown> }
    | { status: 'failed'; error: string },
): Promise<CompatExperienceCandidate> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  return mutate(uid, (state) => {
    const candidate = state.experience_candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('experience candidate not found');
    const now = nowIso();
    if (input.status === 'synced') {
      const sync: CompatExperienceCandidateNotionSync = {
        status: 'synced',
        ...(input.page_id ? { page_id: input.page_id } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.result ? { result: input.result } : {}),
        synced_at: now,
      };
      candidate.notion_sync = sync;
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
): Promise<CompatExperienceCandidate> {
  if (!safeId(candidateId)) throw new Error('invalid experience candidate id');
  return mutate(uid, (state) => {
    const candidate = state.experience_candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('experience candidate not found');
    if (candidate.status !== 'pending')
      throw new Error(`experience candidate cannot change from ${candidate.status}`);
    candidate.status = decision === 'approve' ? 'approved' : 'rejected';
    candidate.updated_at = nowIso();
    return candidate;
  });
}
