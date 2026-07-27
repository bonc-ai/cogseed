/**
 * Snapshot state management
 * Implements generation CAS and idempotent evidence
 */
import type { SkillSnapshot, Episode, EvidenceInput, SnapshotMutation } from '../types/snapshot.js';
import { stableHash } from './canonical-json.js';

export class SnapshotGenerationConflictError extends Error {
  constructor(message: string) {
    super(`SNAPSHOT_GENERATION_CONFLICT: ${message}`);
    this.name = 'SNAPSHOT_GENERATION_CONFLICT';
  }
}

// Track highest generation seen per skill_id (simulates DB state)
const globalGenerations = new Map<string, number>();

/**
 * Create a new snapshot with generation 1
 */
export function createSnapshot(skill_id: string): SkillSnapshot {
  const now = new Date().toISOString();
  const snapshot: SkillSnapshot = {
    skill_id,
    generation: 1,
    snapshot_hash: '',
    episodes: [],
    created_at: now,
    updated_at: now
  };

  // Compute hash after all fields are set
  snapshot.snapshot_hash = computeSnapshotHash(snapshot);

  // Initialize tracking
  globalGenerations.set(skill_id, 1);

  return snapshot;
}

/**
 * Mutate snapshot with CAS semantics
 * Increments generation exactly once
 * Throws SNAPSHOT_GENERATION_CONFLICT if base generation doesn't match current
 */
export function mutateSnapshot(
  baseSnapshot: SkillSnapshot,
  mutation: SnapshotMutation
): SkillSnapshot {
  const currentGeneration = globalGenerations.get(baseSnapshot.skill_id) ?? baseSnapshot.generation;

  if (baseSnapshot.generation < currentGeneration) {
    throw new SnapshotGenerationConflictError(
      `Stale base_generation ${baseSnapshot.generation}, current is ${currentGeneration}`
    );
  }

  const newGeneration = baseSnapshot.generation + 1;
  globalGenerations.set(baseSnapshot.skill_id, newGeneration);

  const updated: SkillSnapshot = {
    ...baseSnapshot,
    ...mutation,
    generation: newGeneration,
    updated_at: new Date().toISOString(),
    snapshot_hash: ''
  };

  updated.snapshot_hash = computeSnapshotHash(updated);
  return updated;
}

/**
 * Add evidence with idempotent deduplication
 * Same evidence_id does not create duplicate episodes
 * Still increments generation for idempotency tracking
 */
export function addEvidence(
  baseSnapshot: SkillSnapshot,
  evidence: EvidenceInput
): SkillSnapshot {
  const currentGeneration = globalGenerations.get(baseSnapshot.skill_id) ?? baseSnapshot.generation;

  if (baseSnapshot.generation < currentGeneration) {
    throw new SnapshotGenerationConflictError(
      `Stale base_generation ${baseSnapshot.generation}, current is ${currentGeneration}`
    );
  }

  const existingEpisode = baseSnapshot.episodes.find(
    (ep: Episode) => ep.evidence_id === evidence.evidence_id
  );

  let newEpisodes = baseSnapshot.episodes;

  // Only add if evidence_id is new
  if (!existingEpisode) {
    const episode: Episode = {
      evidence_id: evidence.evidence_id,
      task_description: evidence.task_description,
      outcome: evidence.outcome,
      timestamp: evidence.timestamp,
      context: evidence.context
    };
    newEpisodes = [...baseSnapshot.episodes, episode];
  }

  // Always increment generation (even for deduplication)
  const newGeneration = baseSnapshot.generation + 1;
  globalGenerations.set(baseSnapshot.skill_id, newGeneration);

  const updated: SkillSnapshot = {
    ...baseSnapshot,
    episodes: newEpisodes,
    generation: newGeneration,
    updated_at: new Date().toISOString(),
    snapshot_hash: ''
  };

  updated.snapshot_hash = computeSnapshotHash(updated);
  return updated;
}

/**
 * Compute stable hash for snapshot
 */
function computeSnapshotHash(snapshot: SkillSnapshot): string {
  // Hash everything except the hash field itself
  const { snapshot_hash, ...hashable } = snapshot;
  return stableHash(hashable);
}
