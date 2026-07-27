/**
 * Skill snapshot types
 * Immutable versioned representation of a meta-skill
 */

export interface SkillSnapshot {
  skill_id: string;
  generation: number;
  snapshot_hash: string;

  // Metadata
  name?: string;
  category?: string;
  description?: string;

  // Episodes (evidence of use)
  episodes: Episode[];

  // Timestamps
  created_at: string;
  updated_at: string;
}

export interface Episode {
  evidence_id: string;
  task_description: string;
  outcome: 'success' | 'failure' | 'partial';
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface EvidenceInput {
  evidence_id: string;
  task_description: string;
  outcome: 'success' | 'failure' | 'partial';
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface SnapshotMutation {
  name?: string;
  category?: string;
  description?: string;
}
