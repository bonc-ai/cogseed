export const COGSEED_MIGRATION_JOURNAL_SCHEMA_VERSION = 1 as const;

export type MigrationPhase = 'preview' | 'validate' | 'transform' | 'write' | 'verify' | 'finalize' | 'rollback' | 'resume';

export type MigrationPhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface MigrationScope {
  userId: string;
  sourceSessionId: string;
  targetSessionId: string;
  sourceActorId?: string;
  targetActorId?: string;
  sourceSchemaVersion?: string | number;
  targetSchemaVersion?: string | number;
}

export interface MigrationRollbackWindow {
  openedAt: string;
  closesAt?: string;
  closedAt?: string;
  retainedUntil?: string;
}

export interface MigrationPhaseEntry {
  schemaVersion: typeof COGSEED_MIGRATION_JOURNAL_SCHEMA_VERSION;
  entryId: string;
  kind: 'phase';
  scope: MigrationScope;
  createdAt: string;
  phase: MigrationPhase;
  status: MigrationPhaseStatus;
  details?: Record<string, unknown>;
}

export interface MigrationMapping {
  sourceId: string;
  targetId: string;
  sourceKind?: string;
  targetKind?: string;
  deterministicKey: string;
}

export interface MigrationMappingEntry {
  schemaVersion: typeof COGSEED_MIGRATION_JOURNAL_SCHEMA_VERSION;
  entryId: string;
  kind: 'mapping';
  scope: MigrationScope;
  createdAt: string;
  mapping: MigrationMapping;
}

export interface MigrationWarning {
  code: 'unsupported_record' | 'historical_tool_call' | 'scope_mismatch' | 'duplicate_entry' | 'malformed_record' | 'rollback_window';
  message: string;
  sourceRecordId?: string;
  sourceRecordType?: string;
  details?: Record<string, unknown>;
}

export interface MigrationWarningEntry {
  schemaVersion: typeof COGSEED_MIGRATION_JOURNAL_SCHEMA_VERSION;
  entryId: string;
  kind: 'warning';
  scope: MigrationScope;
  createdAt: string;
  warning: MigrationWarning;
}

export interface MigrationDecision {
  action: 'skipped';
  executable: false;
  reason: 'historical_tool_call' | 'unsupported_record';
  sourceRecordId: string;
  sourceRecordType: string;
  targetRecordId: string;
  toolName?: string;
  details?: Record<string, unknown>;
}

export interface MigrationDecisionEntry {
  schemaVersion: typeof COGSEED_MIGRATION_JOURNAL_SCHEMA_VERSION;
  entryId: string;
  kind: 'decision';
  scope: MigrationScope;
  createdAt: string;
  decision: MigrationDecision;
}

export interface MigrationCheckpointEntry {
  schemaVersion: typeof COGSEED_MIGRATION_JOURNAL_SCHEMA_VERSION;
  entryId: string;
  kind: 'checkpoint';
  scope: MigrationScope;
  createdAt: string;
  rollbackWindow: MigrationRollbackWindow;
}

export type MigrationJournalEntry =
  | MigrationPhaseEntry
  | MigrationMappingEntry
  | MigrationWarningEntry
  | MigrationDecisionEntry
  | MigrationCheckpointEntry;

export interface MigrationJournalState {
  currentPhase: MigrationPhase | null;
  currentPhaseStatus: MigrationPhaseStatus | null;
  phaseStatus: Partial<Record<MigrationPhase, MigrationPhaseStatus>>;
  phaseHistory: Array<Pick<MigrationPhaseEntry, 'entryId' | 'createdAt' | 'phase' | 'status'> & { details?: Record<string, unknown> }>;
  mappings: MigrationMapping[];
  warnings: MigrationWarning[];
  decisions: MigrationDecision[];
  rollbackWindow?: MigrationRollbackWindow;
  sourceToTarget: Record<string, string>;
  counts: {
    entries: number;
    mappings: number;
    warnings: number;
    decisions: number;
    toolCallsSkipped: number;
    unsupportedRecords: number;
  };
  lastCompletedPhase: MigrationPhase | null;
}

export interface MigrationJournalDocument {
  schemaVersion: typeof COGSEED_MIGRATION_JOURNAL_SCHEMA_VERSION;
  journalId: string;
  scope: MigrationScope;
  createdAt: string;
  updatedAt: string;
  entries: MigrationJournalEntry[];
  state: MigrationJournalState;
}

export interface MigrationSourceRecord {
  sourceRecordId: string;
  sourceRecordType: string;
  payload: Record<string, unknown>;
}

export interface MigrationTransformInput {
  scope: MigrationScope;
  now: string;
  sourceRecord: MigrationSourceRecord;
}

export interface MigrationTransformResult {
  mapping: MigrationMapping;
  targetRecord: Record<string, unknown>;
  warnings: MigrationWarning[];
  decision?: MigrationDecision;
}
