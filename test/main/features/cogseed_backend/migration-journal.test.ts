import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_ID = 'mate-migration-user';
const SOURCE_SESSION_ID = 'legacy-session-001';
const TARGET_SESSION_ID = 'mate-session-001';
const SOURCE_ACTOR_ID = 'legacy-actor-001';
const TARGET_ACTOR_ID = 'mate-actor-001';
const scope = {
  userId: USER_ID,
  sourceSessionId: SOURCE_SESSION_ID,
  targetSessionId: TARGET_SESSION_ID,
  sourceActorId: SOURCE_ACTOR_ID,
  targetActorId: TARGET_ACTOR_ID,
  sourceSchemaVersion: 'legacy-v1',
  targetSchemaVersion: 'mate-v1',
};

let tmpDir: string;
let journalFile: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-migration-journal-'));
  journalFile = path.join(tmpDir, 'migration.json');
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Mate historical migration journal', () => {
  it('appends phase entries idempotently and replays phase/rollback metadata', async () => {
    const migration = await import('../../../../src/main/features/cogseed_backend/migration-journal');

    const entries = [
      migration.createMigrationPhaseEntry(scope, 'preview', 'running', '2026-08-05T10:00:00', {
        sourceSchemaVersion: 'legacy-v1',
        targetSchemaVersion: 'mate-v1',
      }),
      migration.createMigrationPhaseEntry(scope, 'validate', 'completed', '2026-08-05T10:00:01'),
      migration.createMigrationPhaseEntry(scope, 'transform', 'completed', '2026-08-05T10:00:02'),
      migration.createMigrationCheckpointEntry(scope, '2026-08-05T10:00:03', {
        openedAt: '2026-08-05T10:00:03',
        closesAt: '2026-08-05T11:00:03',
        closedAt: '2026-08-05T10:30:03',
      }),
      migration.createMigrationPhaseEntry(scope, 'write', 'completed', '2026-08-05T10:00:04'),
      migration.createMigrationPhaseEntry(scope, 'verify', 'completed', '2026-08-05T10:00:05'),
      migration.createMigrationPhaseEntry(scope, 'finalize', 'completed', '2026-08-05T10:00:06'),
      migration.createMigrationPhaseEntry(scope, 'rollback', 'completed', '2026-08-05T10:00:07'),
      migration.createMigrationPhaseEntry(scope, 'resume', 'completed', '2026-08-05T10:00:08'),
    ];

    const first = await migration.appendMigrationJournalEntry(journalFile, entries[0]);
    const duplicate = await migration.appendMigrationJournalEntry(journalFile, entries[0]);
    expect(duplicate.entries).toHaveLength(1);
    expect(duplicate.state.currentPhase).toBe('preview');
    expect(duplicate.state.currentPhaseStatus).toBe('running');

    let snapshot = first;
    for (const entry of entries.slice(1)) {
      snapshot = await migration.appendMigrationJournalEntry(journalFile, entry);
    }

    expect(snapshot.entries).toHaveLength(entries.length);
    expect(snapshot.state.currentPhase).toBe('resume');
    expect(snapshot.state.currentPhaseStatus).toBe('completed');
    expect(snapshot.state.phaseStatus.preview).toBe('running');
    expect(snapshot.state.phaseStatus.validate).toBe('completed');
    expect(snapshot.state.phaseStatus.transform).toBe('completed');
    expect(snapshot.state.phaseStatus.write).toBe('completed');
    expect(snapshot.state.phaseStatus.verify).toBe('completed');
    expect(snapshot.state.phaseStatus.finalize).toBe('completed');
    expect(snapshot.state.phaseStatus.rollback).toBe('completed');
    expect(snapshot.state.phaseStatus.resume).toBe('completed');
    expect(snapshot.state.rollbackWindow).toEqual({
      openedAt: '2026-08-05T10:00:03',
      closesAt: '2026-08-05T11:00:03',
      closedAt: '2026-08-05T10:30:03',
    });

    const replayed = await migration.readMigrationJournal(journalFile);
    expect(replayed?.entries).toHaveLength(entries.length);
    expect(replayed?.state.phaseHistory.map((item) => item.phase)).toEqual([
      'preview',
      'validate',
      'transform',
      'write',
      'verify',
      'finalize',
      'rollback',
      'resume',
    ]);
    expect(replayed?.state.lastCompletedPhase).toBe('resume');
  });

  it('derives deterministic target ids from explicit user/session scope and rejects scope drift', async () => {
    const migration = await import('../../../../src/main/features/cogseed_backend/migration-journal');

    const firstTarget = migration.deriveMigrationTargetId(scope, 'legacy-message-001', 'message');
    const secondTarget = migration.deriveMigrationTargetId(scope, 'legacy-message-001', 'message');
    const differentScopeTarget = migration.deriveMigrationTargetId(
      { ...scope, sourceSessionId: 'legacy-session-002' },
      'legacy-message-001',
      'message',
    );

    expect(firstTarget).toBe(secondTarget);
    expect(firstTarget).not.toBe(differentScopeTarget);
    expect(firstTarget).toMatch(/^mate-migration-target-/);

    const entry = migration.createMigrationPhaseEntry(scope, 'preview', 'running', '2026-08-05T10:01:00');
    await migration.appendMigrationJournalEntry(journalFile, entry);
    const mapped = await migration.appendMigrationJournalEntry(
      journalFile,
      migration.createMigrationMappingEntry(
        scope,
        {
          sourceId: 'legacy-message-001',
          targetId: firstTarget,
          sourceKind: 'message',
          targetKind: 'message',
          deterministicKey: `legacy-message-001->${firstTarget}`,
        },
        '2026-08-05T10:01:01',
      ),
    );
    expect(mapped.state.sourceToTarget['legacy-message-001']).toBe(firstTarget);

    await expect(
      migration.appendMigrationJournalEntry(journalFile, {
        ...migration.createMigrationPhaseEntry({ ...scope, userId: 'other-user' }, 'validate', 'running', '2026-08-05T10:01:01'),
      }),
    ).rejects.toThrow(/scope/i);
  });

  it('turns historical tool calls into skipped non-executable decisions and warns about unsupported records', async () => {
    const migration = await import('../../../../src/main/features/cogseed_backend/migration-journal');

    const toolCall = migration.transformHistoricalMigrationRecord({
      scope,
      now: '2026-08-05T10:02:00',
      sourceRecord: {
        sourceRecordId: 'legacy-tool-001',
        sourceRecordType: 'tool_call',
        payload: {
          toolName: 'shell',
          args: { secret: 'never execute this' },
        },
      },
    });

    expect(toolCall.decision).toMatchObject({
      action: 'skipped',
      executable: false,
      reason: 'historical_tool_call',
      sourceRecordId: 'legacy-tool-001',
    });
    expect(toolCall.targetRecord).toMatchObject({
      executable: false,
      action: 'skipped',
      sourceRecordId: 'legacy-tool-001',
      sourceRecordType: 'tool_call',
      transformedAt: '2026-08-05T10:02:00',
    });
    expect(JSON.stringify(toolCall.targetRecord)).not.toContain('never execute this');

    const unsupported = migration.transformHistoricalMigrationRecord({
      scope,
      now: '2026-08-05T10:02:01',
      sourceRecord: {
        sourceRecordId: 'legacy-unknown-001',
        sourceRecordType: 'legacy_blob',
        payload: { unexpected: true },
      },
    });

    expect(unsupported.warnings).toEqual([
      expect.objectContaining({
        code: 'unsupported_record',
        sourceRecordId: 'legacy-unknown-001',
        sourceRecordType: 'legacy_blob',
      }),
    ]);
    expect(unsupported.decision).toMatchObject({
      action: 'skipped',
      executable: false,
      reason: 'unsupported_record',
      sourceRecordId: 'legacy-unknown-001',
    });

    await migration.appendMigrationJournalEntry(
      journalFile,
      migration.createMigrationDecisionEntry(scope, toolCall.decision, '2026-08-05T10:02:00'),
    );
    await migration.appendMigrationJournalEntry(
      journalFile,
      migration.createMigrationDecisionEntry(scope, unsupported.decision, '2026-08-05T10:02:01'),
    );
    await migration.appendMigrationJournalEntry(
      journalFile,
      migration.createMigrationWarningEntry(scope, unsupported.warnings[0], '2026-08-05T10:02:01'),
    );

    const replayed = await migration.readMigrationJournal(journalFile);
    expect(replayed?.state.decisions).toHaveLength(2);
    expect(replayed?.state.warnings).toHaveLength(1);
    expect(replayed?.state.counts.toolCallsSkipped).toBe(1);
    expect(replayed?.state.counts.unsupportedRecords).toBe(1);
  });
});
