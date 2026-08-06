import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import {
  MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
  type MigrationCheckpointEntry,
  type MigrationDecision,
  type MigrationDecisionEntry,
  type MigrationJournalDocument,
  type MigrationJournalEntry,
  type MigrationJournalState,
  type MigrationMapping,
  type MigrationMappingEntry,
  type MigrationPhase,
  type MigrationPhaseEntry,
  type MigrationPhaseStatus,
  type MigrationRollbackWindow,
  type MigrationScope,
  type MigrationSourceRecord,
  type MigrationTransformInput,
  type MigrationTransformResult,
  type MigrationWarning,
  type MigrationWarningEntry,
} from './migration-types';

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`malformed migration ${label}`);
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`malformed migration ${label}`);
  return value;
}

function assertOptionalStringOrNumber(value: unknown, label: string): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error(`malformed migration ${label}`);
}

function assertTimestamp(value: unknown, label: string): string {
  return assertNonEmptyString(value, label);
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableSortValue(item));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) out[key] = stableSortValue(item);
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value));
}

function digest(parts: Array<unknown>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const encoded = stableStringify(part);
    hash.update(encoded === undefined ? 'undefined' : encoded);
    hash.update('\\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

export function assertMigrationScope(scope: unknown): MigrationScope {
  const row = assertPlainObject(scope, 'scope');
  const userId = assertNonEmptyString(row.userId, 'scope user id');
  const sourceSessionId = assertNonEmptyString(row.sourceSessionId, 'scope source session id');
  const targetSessionId = assertNonEmptyString(row.targetSessionId, 'scope target session id');
  if (!safeId(userId) || !safeId(sourceSessionId) || !safeId(targetSessionId)) {
    throw new Error('invalid migration scope');
  }
  const sourceActorId = row.sourceActorId === undefined ? undefined : assertNonEmptyString(row.sourceActorId, 'scope source actor id');
  const targetActorId = row.targetActorId === undefined ? undefined : assertNonEmptyString(row.targetActorId, 'scope target actor id');
  if (sourceActorId && !safeId(sourceActorId)) throw new Error('invalid migration scope');
  if (targetActorId && !safeId(targetActorId)) throw new Error('invalid migration scope');
  const sourceSchemaVersion = assertOptionalStringOrNumber(row.sourceSchemaVersion, 'scope source schema version');
  const targetSchemaVersion = assertOptionalStringOrNumber(row.targetSchemaVersion, 'scope target schema version');
  return {
    userId,
    sourceSessionId,
    targetSessionId,
    sourceActorId,
    targetActorId,
    sourceSchemaVersion,
    targetSchemaVersion,
  };
}

export function deriveMigrationJournalId(scope: MigrationScope): string {
  const normalized = assertMigrationScope(scope);
  return `mate-migration-journal-${digest([
    normalized.userId,
    normalized.sourceSessionId,
    normalized.targetSessionId,
    normalized.sourceActorId ?? '',
    normalized.targetActorId ?? '',
    normalized.sourceSchemaVersion ?? '',
    normalized.targetSchemaVersion ?? '',
  ])}`;
}

export function deriveMigrationEntryId(kind: MigrationJournalEntry['kind'], scope: MigrationScope, stableKey: unknown): string {
  const normalized = assertMigrationScope(scope);
  return `mate-migration-entry-${kind}-${digest([
    normalized.userId,
    normalized.sourceSessionId,
    normalized.targetSessionId,
    normalized.sourceActorId ?? '',
    normalized.targetActorId ?? '',
    normalized.sourceSchemaVersion ?? '',
    normalized.targetSchemaVersion ?? '',
    kind,
    stableStringify(stableKey),
  ])}`;
}

export function deriveMigrationTargetId(
  scope: MigrationScope,
  sourceRecordId: string,
  targetKind: string,
  sourceRecordType = targetKind,
): string {
  const normalized = assertMigrationScope(scope);
  const safeSourceRecordId = assertNonEmptyString(sourceRecordId, 'source record id');
  const safeTargetKind = assertNonEmptyString(targetKind, 'target kind');
  const safeSourceRecordType = assertNonEmptyString(sourceRecordType, 'source record type');
  return `mate-migration-target-${digest([
    normalized.userId,
    normalized.sourceSessionId,
    normalized.targetSessionId,
    normalized.sourceActorId ?? '',
    normalized.targetActorId ?? '',
    normalized.sourceSchemaVersion ?? '',
    normalized.targetSchemaVersion ?? '',
    safeSourceRecordId,
    safeSourceRecordType,
    safeTargetKind,
  ])}`;
}

export function createMigrationPhaseEntry(
  scope: MigrationScope,
  phase: MigrationPhase,
  status: MigrationPhaseStatus,
  now: string,
  details?: Record<string, unknown>,
): MigrationPhaseEntry {
  const normalized = assertMigrationScope(scope);
  const createdAt = assertTimestamp(now, 'phase timestamp');
  const entry: MigrationPhaseEntry = {
    schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    entryId: deriveMigrationEntryId('phase', normalized, { phase, status, createdAt, details: details ?? null }),
    kind: 'phase',
    scope: normalized,
    createdAt,
    phase,
    status,
  };
  if (details && Object.keys(details).length > 0) entry.details = clonePlain(details);
  return entry;
}

export function createMigrationMappingEntry(
  scope: MigrationScope,
  mapping: MigrationMapping,
  now: string,
): MigrationMappingEntry {
  const normalized = assertMigrationScope(scope);
  const createdAt = assertTimestamp(now, 'mapping timestamp');
  const safeMapping = validateMapping(mapping);
  return {
    schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    entryId: deriveMigrationEntryId('mapping', normalized, safeMapping),
    kind: 'mapping',
    scope: normalized,
    createdAt,
    mapping: safeMapping,
  };
}

export function createMigrationWarningEntry(
  scope: MigrationScope,
  warning: MigrationWarning,
  now: string,
): MigrationWarningEntry {
  const normalized = assertMigrationScope(scope);
  const createdAt = assertTimestamp(now, 'warning timestamp');
  const safeWarning = validateWarning(warning);
  return {
    schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    entryId: deriveMigrationEntryId('warning', normalized, { createdAt, warning: safeWarning }),
    kind: 'warning',
    scope: normalized,
    createdAt,
    warning: safeWarning,
  };
}

export function createMigrationDecisionEntry(
  scope: MigrationScope,
  decision: MigrationDecision,
  now: string,
): MigrationDecisionEntry {
  const normalized = assertMigrationScope(scope);
  const createdAt = assertTimestamp(now, 'decision timestamp');
  const safeDecision = validateDecision(decision);
  return {
    schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    entryId: deriveMigrationEntryId('decision', normalized, { createdAt, decision: safeDecision }),
    kind: 'decision',
    scope: normalized,
    createdAt,
    decision: safeDecision,
  };
}

export function createMigrationCheckpointEntry(
  scope: MigrationScope,
  now: string,
  rollbackWindow: MigrationRollbackWindow,
): MigrationCheckpointEntry {
  const normalized = assertMigrationScope(scope);
  const createdAt = assertTimestamp(now, 'checkpoint timestamp');
  const safeWindow = validateRollbackWindow(rollbackWindow);
  return {
    schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    entryId: deriveMigrationEntryId('checkpoint', normalized, { createdAt, rollbackWindow: safeWindow }),
    kind: 'checkpoint',
    scope: normalized,
    createdAt,
    rollbackWindow: safeWindow,
  };
}

function validateMapping(mapping: unknown): MigrationMapping {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('malformed migration mapping');
  const row = mapping as Record<string, unknown>;
  const sourceId = assertNonEmptyString(row.sourceId, 'mapping source id');
  const targetId = assertNonEmptyString(row.targetId, 'mapping target id');
  const deterministicKey = assertNonEmptyString(row.deterministicKey, 'mapping deterministic key');
  const sourceKind = row.sourceKind === undefined ? undefined : assertNonEmptyString(row.sourceKind, 'mapping source kind');
  const targetKind = row.targetKind === undefined ? undefined : assertNonEmptyString(row.targetKind, 'mapping target kind');
  return { sourceId, targetId, deterministicKey, sourceKind, targetKind };
}

function validateWarning(warning: unknown): MigrationWarning {
  if (!warning || typeof warning !== 'object' || Array.isArray(warning)) throw new Error('malformed migration warning');
  const row = warning as Record<string, unknown>;
  const code = assertNonEmptyString(row.code, 'warning code');
  const message = assertNonEmptyString(row.message, 'warning message');
  if (!['unsupported_record', 'historical_tool_call', 'scope_mismatch', 'duplicate_entry', 'malformed_record', 'rollback_window'].includes(code)) {
    throw new Error('malformed migration warning');
  }
  const sourceRecordId = row.sourceRecordId === undefined ? undefined : assertNonEmptyString(row.sourceRecordId, 'warning source record id');
  const sourceRecordType = row.sourceRecordType === undefined ? undefined : assertNonEmptyString(row.sourceRecordType, 'warning source record type');
  const details = row.details === undefined ? undefined : assertPlainObject(row.details, 'warning details');
  return { code: code as MigrationWarning['code'], message, sourceRecordId, sourceRecordType, details: details ? clonePlain(details) : undefined };
}

function validateDecision(decision: unknown): MigrationDecision {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('malformed migration decision');
  const row = decision as Record<string, unknown>;
  if (row.action !== 'skipped' || row.executable !== false) throw new Error('malformed migration decision');
  const reason = assertNonEmptyString(row.reason, 'decision reason');
  if (!['historical_tool_call', 'unsupported_record'].includes(reason)) throw new Error('malformed migration decision');
  const sourceRecordId = assertNonEmptyString(row.sourceRecordId, 'decision source record id');
  const sourceRecordType = assertNonEmptyString(row.sourceRecordType, 'decision source record type');
  const targetRecordId = assertNonEmptyString(row.targetRecordId, 'decision target record id');
  const toolName = row.toolName === undefined ? undefined : assertNonEmptyString(row.toolName, 'decision tool name');
  const details = row.details === undefined ? undefined : assertPlainObject(row.details, 'decision details');
  return {
    action: 'skipped',
    executable: false,
    reason: reason as MigrationDecision['reason'],
    sourceRecordId,
    sourceRecordType,
    targetRecordId,
    toolName,
    details: details ? clonePlain(details) : undefined,
  };
}

function validateRollbackWindow(rollbackWindow: unknown): MigrationRollbackWindow {
  if (!rollbackWindow || typeof rollbackWindow !== 'object' || Array.isArray(rollbackWindow)) throw new Error('malformed migration rollback window');
  const row = rollbackWindow as Record<string, unknown>;
  const openedAt = assertTimestamp(row.openedAt, 'rollback openedAt');
  const closesAt = row.closesAt === undefined ? undefined : assertTimestamp(row.closesAt, 'rollback closesAt');
  const closedAt = row.closedAt === undefined ? undefined : assertTimestamp(row.closedAt, 'rollback closedAt');
  const retainedUntil = row.retainedUntil === undefined ? undefined : assertTimestamp(row.retainedUntil, 'rollback retainedUntil');
  return { openedAt, closesAt, closedAt, retainedUntil };
}

function validatePhaseEntry(entry: unknown): MigrationPhaseEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('malformed migration phase entry');
  const row = entry as Record<string, unknown>;
  if (row.schemaVersion !== MATE_MIGRATION_JOURNAL_SCHEMA_VERSION || row.kind !== 'phase') throw new Error('malformed migration phase entry');
  const scope = assertMigrationScope(row.scope);
  const entryId = assertNonEmptyString(row.entryId, 'phase entry id');
  const createdAt = assertTimestamp(row.createdAt, 'phase createdAt');
  const phase = assertNonEmptyString(row.phase, 'phase');
  const status = assertNonEmptyString(row.status, 'phase status');
  if (!['preview', 'validate', 'transform', 'write', 'verify', 'finalize', 'rollback', 'resume'].includes(phase)) throw new Error('malformed migration phase entry');
  if (!['pending', 'running', 'completed', 'failed', 'skipped'].includes(status)) throw new Error('malformed migration phase entry');
  const details = row.details === undefined ? undefined : assertPlainObject(row.details, 'phase details');
  return {
    schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    entryId,
    kind: 'phase',
    scope,
    createdAt,
    phase: phase as MigrationPhase,
    status: status as MigrationPhaseStatus,
    details: details ? clonePlain(details) : undefined,
  };
}

function validateMappingEntry(entry: unknown): MigrationMappingEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('malformed migration mapping entry');
  const row = entry as Record<string, unknown>;
  if (row.schemaVersion !== MATE_MIGRATION_JOURNAL_SCHEMA_VERSION || row.kind !== 'mapping') throw new Error('malformed migration mapping entry');
  const scope = assertMigrationScope(row.scope);
  const entryId = assertNonEmptyString(row.entryId, 'mapping entry id');
  const createdAt = assertTimestamp(row.createdAt, 'mapping createdAt');
  const mapping = validateMapping(assertPlainObject(row.mapping, 'mapping'));
  return { schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION, entryId, kind: 'mapping', scope, createdAt, mapping };
}

function validateWarningEntry(entry: unknown): MigrationWarningEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('malformed migration warning entry');
  const row = entry as Record<string, unknown>;
  if (row.schemaVersion !== MATE_MIGRATION_JOURNAL_SCHEMA_VERSION || row.kind !== 'warning') throw new Error('malformed migration warning entry');
  const scope = assertMigrationScope(row.scope);
  const entryId = assertNonEmptyString(row.entryId, 'warning entry id');
  const createdAt = assertTimestamp(row.createdAt, 'warning createdAt');
  const warning = validateWarning(assertPlainObject(row.warning, 'warning'));
  return { schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION, entryId, kind: 'warning', scope, createdAt, warning };
}

function validateDecisionEntry(entry: unknown): MigrationDecisionEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('malformed migration decision entry');
  const row = entry as Record<string, unknown>;
  if (row.schemaVersion !== MATE_MIGRATION_JOURNAL_SCHEMA_VERSION || row.kind !== 'decision') throw new Error('malformed migration decision entry');
  const scope = assertMigrationScope(row.scope);
  const entryId = assertNonEmptyString(row.entryId, 'decision entry id');
  const createdAt = assertTimestamp(row.createdAt, 'decision createdAt');
  const decision = validateDecision(assertPlainObject(row.decision, 'decision'));
  return { schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION, entryId, kind: 'decision', scope, createdAt, decision };
}

function validateCheckpointEntry(entry: unknown): MigrationCheckpointEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('malformed migration checkpoint entry');
  const row = entry as Record<string, unknown>;
  if (row.schemaVersion !== MATE_MIGRATION_JOURNAL_SCHEMA_VERSION || row.kind !== 'checkpoint') throw new Error('malformed migration checkpoint entry');
  const scope = assertMigrationScope(row.scope);
  const entryId = assertNonEmptyString(row.entryId, 'checkpoint entry id');
  const createdAt = assertTimestamp(row.createdAt, 'checkpoint createdAt');
  const rollbackWindow = validateRollbackWindow(assertPlainObject(row.rollbackWindow, 'rollback window'));
  return { schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION, entryId, kind: 'checkpoint', scope, createdAt, rollbackWindow };
}

function validateEntry(entry: unknown): MigrationJournalEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('malformed migration entry');
  const kind = (entry as Record<string, unknown>).kind;
  if (kind === 'phase') return validatePhaseEntry(entry as MigrationPhaseEntry);
  if (kind === 'mapping') return validateMappingEntry(entry as MigrationMappingEntry);
  if (kind === 'warning') return validateWarningEntry(entry as MigrationWarningEntry);
  if (kind === 'decision') return validateDecisionEntry(entry as MigrationDecisionEntry);
  if (kind === 'checkpoint') return validateCheckpointEntry(entry as MigrationCheckpointEntry);
  throw new Error('malformed migration entry');
}

function createInitialState(): MigrationJournalState {
  return {
    currentPhase: null,
    currentPhaseStatus: null,
    phaseStatus: {},
    phaseHistory: [],
    mappings: [],
    warnings: [],
    decisions: [],
    sourceToTarget: {},
    counts: {
      entries: 0,
      mappings: 0,
      warnings: 0,
      decisions: 0,
      toolCallsSkipped: 0,
      unsupportedRecords: 0,
    },
    lastCompletedPhase: null,
  };
}

function applyEntry(state: MigrationJournalState, entry: MigrationJournalEntry): void {
  state.counts.entries += 1;
  if (entry.kind === 'phase') {
    state.currentPhase = entry.phase;
    state.currentPhaseStatus = entry.status;
    state.phaseStatus[entry.phase] = entry.status;
    state.phaseHistory.push({
      entryId: entry.entryId,
      createdAt: entry.createdAt,
      phase: entry.phase,
      status: entry.status,
      details: entry.details ? clonePlain(entry.details) : undefined,
    });
    if (entry.status === 'completed') state.lastCompletedPhase = entry.phase;
    return;
  }
  if (entry.kind === 'mapping') {
    state.mappings.push(clonePlain(entry.mapping));
    state.sourceToTarget[entry.mapping.sourceId] = entry.mapping.targetId;
    state.counts.mappings += 1;
    return;
  }
  if (entry.kind === 'warning') {
    state.warnings.push(clonePlain(entry.warning));
    state.counts.warnings += 1;
    if (
      entry.warning.code === 'unsupported_record'
      && !state.decisions.some((decision) => decision.sourceRecordId === entry.warning.sourceRecordId && decision.reason === 'unsupported_record')
    ) {
      state.counts.unsupportedRecords += 1;
    }
    return;
  }
  if (entry.kind === 'decision') {
    state.decisions.push(clonePlain(entry.decision));
    state.counts.decisions += 1;
    if (entry.decision.reason === 'historical_tool_call') state.counts.toolCallsSkipped += 1;
    if (entry.decision.reason === 'unsupported_record' && !state.warnings.some((warning) => warning.sourceRecordId === entry.decision.sourceRecordId && warning.code === 'unsupported_record')) {
      state.counts.unsupportedRecords += 1;
    }
    return;
  }
  if (entry.kind === 'checkpoint') {
    state.rollbackWindow = clonePlain(entry.rollbackWindow);
  }
}

function dedupeEntries(entries: MigrationJournalEntry[]): MigrationJournalEntry[] {
  const seen = new Map<string, string>();
  const out: MigrationJournalEntry[] = [];
  for (const entry of entries) {
    const validated = validateEntry(entry);
    const current = stableStringify(validated);
    const previous = seen.get(validated.entryId);
    if (previous) {
      if (previous !== current) throw new Error('migration journal entry collision');
      continue;
    }
    seen.set(validated.entryId, current);
    out.push(validated);
  }
  return out;
}

function replayMigrationEntries(entries: MigrationJournalEntry[], scope: MigrationScope, journalId: string, createdAt: string): MigrationJournalDocument {
  const deduped = dedupeEntries(entries);
  const state = createInitialState();
  for (const entry of deduped) {
    if (stableStringify(entry.scope) !== stableStringify(scope)) throw new Error('migration journal scope mismatch');
    applyEntry(state, entry);
  }
  const updatedAt = deduped.length > 0 ? deduped[deduped.length - 1].createdAt : createdAt;
  return {
    schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    journalId,
    scope,
    createdAt,
    updatedAt,
    entries: deduped,
    state,
  };
}

function validateDocument(value: unknown): MigrationJournalDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed migration journal');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_MIGRATION_JOURNAL_SCHEMA_VERSION) throw new Error('unsupported migration journal schema');
  const scope = assertMigrationScope(row.scope);
  const journalId = assertNonEmptyString(row.journalId, 'journal id');
  const createdAt = assertTimestamp(row.createdAt, 'journal createdAt');
  const entriesValue = row.entries;
  if (!Array.isArray(entriesValue)) throw new Error('malformed migration journal');
  const entries = entriesValue.map((entry) => validateEntry(entry as MigrationJournalEntry));
  return replayMigrationEntries(entries, scope, journalId, createdAt);
}

export async function readMigrationJournal(filePath: string): Promise<MigrationJournalDocument | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return validateDocument(JSON.parse(text));
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed migration journal');
    throw error;
  }
}

export async function appendMigrationJournalEntry(filePath: string, entry: MigrationJournalEntry): Promise<MigrationJournalDocument> {
  const validated = validateEntry(entry);
  const lock = fileEditLock(filePath);
  return lock.runExclusive(async () => {
    const existing = await readMigrationJournal(filePath);
    if (!existing) {
      const journalId = deriveMigrationJournalId(validated.scope);
      const document = replayMigrationEntries([validated], validated.scope, journalId, validated.createdAt);
      await writeJson(filePath, document);
      return document;
    }

    if (stableStringify(existing.scope) !== stableStringify(validated.scope)) throw new Error('migration journal scope mismatch');

    const existingEntry = existing.entries.find((candidate) => candidate.entryId === validated.entryId);
    if (existingEntry) {
      if (stableStringify(existingEntry) !== stableStringify(validated)) throw new Error('migration journal entry collision');
      return existing;
    }

    const document = replayMigrationEntries([...existing.entries, validated], existing.scope, existing.journalId, existing.createdAt);
    await writeJson(filePath, document);
    return document;
  });
}

const SUPPORTED_SOURCE_RECORD_TYPES = new Set(['message', 'event', 'state', 'workflow', 'task', 'session', 'member', 'actor', 'artifact', 'checkpoint']);

function validateSourceRecord(sourceRecord: unknown): MigrationSourceRecord {
  if (!sourceRecord || typeof sourceRecord !== 'object' || Array.isArray(sourceRecord)) throw new Error('malformed migration source record');
  const row = sourceRecord as Record<string, unknown>;
  const sourceRecordId = assertNonEmptyString(row.sourceRecordId, 'source record id');
  const sourceRecordType = assertNonEmptyString(row.sourceRecordType, 'source record type');
  const payload = assertPlainObject(row.payload, 'source payload');
  return {
    sourceRecordId,
    sourceRecordType,
    payload: clonePlain(payload),
  };
}

export function isSupportedMigrationSourceRecordType(sourceRecordType: string): boolean {
  return SUPPORTED_SOURCE_RECORD_TYPES.has(sourceRecordType);
}

export function transformHistoricalMigrationRecord(input: MigrationTransformInput): MigrationTransformResult {
  const scope = assertMigrationScope(input.scope);
  const now = assertTimestamp(input.now, 'migration timestamp');
  const sourceRecord = validateSourceRecord(input.sourceRecord);
  const targetRecordId = deriveMigrationTargetId(scope, sourceRecord.sourceRecordId, sourceRecord.sourceRecordType);
  const mapping: MigrationMapping = {
    sourceId: sourceRecord.sourceRecordId,
    targetId: targetRecordId,
    sourceKind: sourceRecord.sourceRecordType,
    targetKind: sourceRecord.sourceRecordType,
    deterministicKey: stableStringify({
      scope,
      sourceRecordId: sourceRecord.sourceRecordId,
      sourceRecordType: sourceRecord.sourceRecordType,
      targetRecordId,
    }),
  };

  if (sourceRecord.sourceRecordType === 'tool_call') {
    const decision: MigrationDecision = {
      action: 'skipped',
      executable: false,
      reason: 'historical_tool_call',
      sourceRecordId: sourceRecord.sourceRecordId,
      sourceRecordType: sourceRecord.sourceRecordType,
      targetRecordId,
      toolName: typeof sourceRecord.payload.toolName === 'string' ? sourceRecord.payload.toolName : undefined,
      details: {
        preserved: false,
        reason: 'historical tool calls are never executed',
      },
    };
    return {
      mapping,
      warnings: [],
      decision,
      targetRecord: {
        schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
        kind: 'historical_tool_call_decision',
        executable: false,
        action: 'skipped',
        reason: 'historical_tool_call',
        sourceRecordId: sourceRecord.sourceRecordId,
        sourceRecordType: sourceRecord.sourceRecordType,
        targetRecordId,
        toolName: decision.toolName,
        transformedAt: now,
      },
    };
  }

  if (!isSupportedMigrationSourceRecordType(sourceRecord.sourceRecordType)) {
    const warning: MigrationWarning = {
      code: 'unsupported_record',
      message: 'unsupported historical record skipped',
      sourceRecordId: sourceRecord.sourceRecordId,
      sourceRecordType: sourceRecord.sourceRecordType,
      details: {
        sourceRecordId: sourceRecord.sourceRecordId,
        sourceRecordType: sourceRecord.sourceRecordType,
      },
    };
    const decision: MigrationDecision = {
      action: 'skipped',
      executable: false,
      reason: 'unsupported_record',
      sourceRecordId: sourceRecord.sourceRecordId,
      sourceRecordType: sourceRecord.sourceRecordType,
      targetRecordId,
      details: {
        warning: warning.message,
      },
    };
    return {
      mapping,
      warnings: [warning],
      decision,
      targetRecord: {
        schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
        kind: 'unsupported_record_decision',
        executable: false,
        action: 'skipped',
        reason: 'unsupported_record',
        sourceRecordId: sourceRecord.sourceRecordId,
        sourceRecordType: sourceRecord.sourceRecordType,
        targetRecordId,
        transformedAt: now,
      },
    };
  }

  return {
    mapping,
    warnings: [],
    targetRecord: {
      schemaVersion: MATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
      kind: sourceRecord.sourceRecordType,
      sourceRecordId: sourceRecord.sourceRecordId,
      sourceRecordType: sourceRecord.sourceRecordType,
      targetRecordId,
      transformedAt: now,
      payload: clonePlain(sourceRecord.payload),
    },
  };
}
