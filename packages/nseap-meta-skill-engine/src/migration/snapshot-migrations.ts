/**
 * Snapshot migrations
 * Continuous schema migration for snapshots
 */
import type { SkillSnapshot } from '../types/snapshot.js';
import { stableHash } from '../persistence/canonical-json.js';

const CURRENT_SCHEMA_VERSION = '1.0.0';

export function getCurrentSchemaVersion(): string {
  return CURRENT_SCHEMA_VERSION;
}

/**
 * Migrate snapshot from old version to current schema
 */
export function migrateSnapshot(oldSnapshot: any, fromVersion: string): SkillSnapshot {
  // If already current version, return as-is
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return oldSnapshot as SkillSnapshot;
  }

  // Migration from v0.9.0 to v1.0.0
  if (fromVersion === '0.9.0') {
    return migrateFrom090(oldSnapshot);
  }

  // Unknown version, attempt best-effort migration
  return migrateFrom090(oldSnapshot);
}

/**
 * Migrate from v0.9.0 schema to v1.0.0
 * Changes:
 * - version -> generation
 * - hash -> snapshot_hash
 * - created -> created_at
 * - updated -> updated_at
 */
function migrateFrom090(old: any): SkillSnapshot {
  const now = new Date().toISOString();

  const migrated: SkillSnapshot = {
    skill_id: old.skill_id,
    generation: old.version ?? old.generation ?? 1,
    snapshot_hash: '', // Will be computed below
    episodes: migrateEpisodes(old.episodes ?? []),
    created_at: old.created ?? old.created_at ?? now,
    updated_at: old.updated ?? old.updated_at ?? now
  };

  // Preserve optional fields
  if (old.name) migrated.name = old.name;
  if (old.category) migrated.category = old.category;
  if (old.description) migrated.description = old.description;

  // Compute new hash
  migrated.snapshot_hash = computeHash(migrated);

  return migrated;
}

/**
 * Migrate episodes array
 */
function migrateEpisodes(oldEpisodes: any[]): any[] {
  return oldEpisodes.map(ep => ({
    evidence_id: ep.evidence_id,
    task_description: ep.task ?? ep.task_description ?? '',
    outcome: ep.outcome ?? 'success',
    timestamp: ep.timestamp ?? new Date().toISOString(),
    context: ep.context
  }));
}

/**
 * Compute hash for migrated snapshot
 */
function computeHash(snapshot: SkillSnapshot): string {
  const { snapshot_hash, ...hashable } = snapshot;
  return stableHash(hashable);
}
