import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as storage from '../../../../src/main/storage';
import * as users from '../../../../src/main/features/users';

import type { CreatorPresetManifestV1 } from '../../../../src/main/features/creator/types';
import {
  activateCreatorPresetVersion,
  appendCreatorAudit,
  listCreatorAudit,
  listCreatorPresetSummaries,
  publishCreatorPresetVersion,
  recoverCreatorStoreOperations,
  readCreatorDraft,
  readCreatorPresetState,
  readCreatorPresetVersion,
  rollbackCreatorPreset,
  saveCreatorDraft,
  type CreatorPresetDraft,
} from '../../../../src/main/features/creator/store';
import {
  userCreatorAuditFile,
  userCreatorDraftFile,
  userCreatorOperationJournalFile,
  userCreatorPresetStateFile,
  userCreatorPresetVersionFile,
} from '../../../../src/main/paths';

const userId = 'creator-store-user';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;

function manifest(version = 'draft', description = 'Bounded local research.'): CreatorPresetManifestV1 {
  return {
    schemaVersion: 1,
    presetId: 'local-research',
    version,
    displayName: 'Local research agent',
    description,
    presetType: 'cogseed-agent',
    model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
    capabilities: [
      { capabilityId: 'research.answer', version: '1', configRef: 'config.research.readonly' },
    ],
    prompt: { systemSections: ['research', 'citations'], locale: 'en' },
    runtime: {
      sessionPolicy: 'new-per-run',
      memoryPolicy: 'read-only',
      loopPolicy: 'single-agent',
      sandboxProfile: 'creator-read-only-v1',
      timeoutMs: 60_000,
      budget: { maxTokens: 8_000 },
    },
    permissions: {
      tools: ['search.read'],
      files: ['workspace.readonly'],
      sideEffects: [],
      approvalMode: 'always',
    },
    provenance: {
      createdBy: 'creator-agent',
      sourceSessionId: 'creator-session-1',
      sourceAssetRefs: ['asset.requirements'],
    },
  };
}

function draft(description = 'Bounded local research.'): CreatorPresetDraft {
  return {
    schemaVersion: 1,
    draftId: 'draft-local-research',
    manifest: manifest('draft', description),
    updatedAt: '2026-08-21T06:00:00.000Z',
  };
}

beforeEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
  users.activateUser(userId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
});

describe('Creator preset store', () => {
  it('overwrites drafts but never overwrites an immutable preset version', async () => {
    await saveCreatorDraft(userId, draft('first draft'));
    const published = await publishCreatorPresetVersion(userId, 'draft-local-research', '1');

    expect(published.presetId).toBe('local-research');
    expect(published.version).toBe('1');
    expect((await readCreatorPresetVersion(userId, 'local-research', '1'))?.description).toBe('first draft');

    await saveCreatorDraft(userId, draft('updated draft'));
    expect((await readCreatorDraft(userId, 'draft-local-research'))?.manifest.description).toBe('updated draft');
    await expect(
      publishCreatorPresetVersion(userId, 'draft-local-research', '1'),
    ).rejects.toThrow('creator_preset_version_exists');
    expect((await readCreatorPresetVersion(userId, 'local-research', '1'))?.description).toBe('first draft');
  });

  it('lists renderer-safe preset summaries without exposing storage paths', async () => {
    await saveCreatorDraft(userId, draft('published preset'));
    await publishCreatorPresetVersion(userId, 'draft-local-research', '1');
    await activateCreatorPresetVersion(userId, 'local-research', '1');

    await expect(listCreatorPresetSummaries(userId)).resolves.toEqual([{
      presetId: 'local-research',
      version: '1',
      activeVersion: '1',
      displayName: 'Local research agent',
      description: 'published preset',
      presetType: 'cogseed-agent',
      updatedAt: expect.any(String),
    }]);
  });

  it('atomically activates and rolls back immutable versions with append-only audit', async () => {
    await saveCreatorDraft(userId, draft('version one'));
    await publishCreatorPresetVersion(userId, 'draft-local-research', '1');
    await saveCreatorDraft(userId, draft('version two'));
    await publishCreatorPresetVersion(userId, 'draft-local-research', '2');

    await activateCreatorPresetVersion(userId, 'local-research', '1');
    await activateCreatorPresetVersion(userId, 'local-research', '2');
    await rollbackCreatorPreset(userId, 'local-research', '1');

    expect(await readCreatorPresetState(userId, 'local-research')).toMatchObject({
      presetId: 'local-research',
      activeVersion: '1',
      previousActiveVersion: '2',
    });
    expect((await listCreatorAudit(userId)).map((row) => row.event)).toEqual(expect.arrayContaining([
      'draft.saved',
      'preset.version_published',
      'preset.activated',
      'preset.rolled_back',
    ]));
  });

  it('serializes concurrent active-version switches without a torn state file', async () => {
    await saveCreatorDraft(userId, draft('version one'));
    await publishCreatorPresetVersion(userId, 'draft-local-research', '1');
    await saveCreatorDraft(userId, draft('version two'));
    await publishCreatorPresetVersion(userId, 'draft-local-research', '2');

    await Promise.all([
      activateCreatorPresetVersion(userId, 'local-research', '1'),
      activateCreatorPresetVersion(userId, 'local-research', '2'),
    ]);

    const rawState = JSON.parse(await fs.readFile(
      userCreatorPresetStateFile(userId, 'local-research'),
      'utf8',
    )) as { activeVersion: string };
    expect(['1', '2']).toContain(rawState.activeVersion);
    expect((await readCreatorPresetState(userId, 'local-research')).activeVersion).toBe(rawState.activeVersion);
  });

  it('recursively redacts sensitive audit metadata before appending it', async () => {
    await appendCreatorAudit(userId, {
      event: 'test.redaction',
      metadata: {
        apiKey: 'sk-live-secret',
        nested: { Authorization: 'Bearer private', safe: 'kept' },
        rows: [{ endpoint: 'https://internal.invalid/v1', label: 'peer-a' }],
      },
    });

    const auditText = await fs.readFile(userCreatorAuditFile(userId), 'utf8');
    expect(auditText).not.toContain('sk-live-secret');
    expect(auditText).not.toContain('Bearer private');
    expect(auditText).not.toContain('https://internal.invalid/v1');
    expect(auditText).toContain('[REDACTED]');
    expect((await listCreatorAudit(userId))[0]?.metadata).toMatchObject({
      apiKey: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', safe: 'kept' },
      rows: [{ endpoint: '[REDACTED]', label: 'peer-a' }],
    });
  });

  it('rejects forged lifecycle audit events from the generic audit API', async () => {
    for (const event of [
      'draft.saved',
      'creator.lifecycle.approved',
      'creator.verification.recorded',
      'preset.version_published',
      'preset.activated',
      'preset.rolled_back',
    ]) {
      await expect(appendCreatorAudit(userId, {
        event,
        draftId: 'draft-local-research',
        presetId: 'local-research',
        version: '1',
        metadata: { status: 'passed', manifestDigest: `sha256:${'0'.repeat(64)}` },
      })).rejects.toThrow('creator_audit_event_reserved');
    }

    const saved = await saveCreatorDraft(userId, draft('draft-local-research', 'legitimate internal save'));
    expect((await listCreatorAudit(userId)).find((entry) => entry.draftId === saved.draftId)?.event).toBe('draft.saved');
  });

  it('rejects unbounded or sensitive generic audit metadata before persistence', async () => {
    await expect(appendCreatorAudit(userId, {
      event: 'test.metadata-bound',
      metadata: { nested: { value: 'x'.repeat(20_000) } },
    })).rejects.toThrow('creator_audit_metadata_invalid');

    await expect(appendCreatorAudit(userId, {
      event: 'test.metadata-sensitive',
      metadata: { innocuous: 'https://private.invalid/path?token=secret' },
    })).resolves.toMatchObject({ metadata: { innocuous: '[REDACTED]' } });
  });

  it('fails closed before materializing oversized audit history', async () => {
    const auditFile = userCreatorAuditFile(userId);
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    const row = JSON.stringify({ schemaVersion: 1, auditId: 'audit-1', event: 'test.history', createdAt: '2026-08-21T06:00:00.000Z' });
    await fs.writeFile(auditFile, `${Array.from({ length: 5_000 }, () => row).join('\n')}\n`, 'utf8');
    await expect(listCreatorAudit(userId)).rejects.toThrow('creator_audit_history_too_large');
  });

  it('bounds preset summary directory enumeration', async () => {
    const presetsDir = path.dirname(path.dirname(userCreatorPresetStateFile(userId, 'placeholder')));
    await fs.mkdir(presetsDir, { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_unused, index) =>
      fs.mkdir(path.join(presetsDir, `preset-${index}`), { recursive: true })));
    await expect(listCreatorPresetSummaries(userId)).rejects.toThrow('creator_preset_summary_too_large');
  });

  it('returns an array and skips incomplete preset directories', async () => {
    await fs.mkdir(path.join(path.dirname(path.dirname(userCreatorPresetStateFile(userId, 'placeholder'))), 'incomplete'), { recursive: true });
    await expect(listCreatorPresetSummaries(userId)).resolves.toEqual([]);
  });

  it('returns stable errors for corrupt draft, version, state, and audit JSON', async () => {
    await fs.mkdir(path.dirname(userCreatorDraftFile(userId, 'draft-local-research')), { recursive: true });
    await fs.writeFile(userCreatorDraftFile(userId, 'draft-local-research'), '{broken', 'utf8');
    await expect(readCreatorDraft(userId, 'draft-local-research')).rejects.toThrow('creator_draft_corrupt');

    await fs.mkdir(path.dirname(userCreatorPresetVersionFile(userId, 'local-research', '1')), { recursive: true });
    await fs.writeFile(userCreatorPresetVersionFile(userId, 'local-research', '1'), '{broken', 'utf8');
    await expect(readCreatorPresetVersion(userId, 'local-research', '1')).rejects.toThrow('creator_preset_version_corrupt');

    await fs.writeFile(userCreatorPresetStateFile(userId, 'local-research'), '{broken', 'utf8');
    await expect(readCreatorPresetState(userId, 'local-research')).rejects.toThrow('creator_preset_state_corrupt');

    await fs.writeFile(userCreatorAuditFile(userId), '{broken\n', 'utf8');
    await expect(listCreatorAudit(userId)).rejects.toThrow('creator_audit_corrupt');
  });

  it('fails closed if a JSON document grows after its initial size check', async () => {
    const draftFile = userCreatorDraftFile(userId, 'draft-local-research');
    await fs.mkdir(path.dirname(draftFile), { recursive: true });
    await fs.writeFile(draftFile, 'x'.repeat(1_100_000), 'utf8');
    await expect(readCreatorDraft(userId, 'draft-local-research')).rejects.toThrow('creator_draft_too_large');
  });

  it('rejects an oversized prepared journal record before mutation and remains recoverable', async () => {
    const oversized = draft('valid large prompt');
    oversized.manifest.prompt.systemSections = Array.from({ length: 32 }, () => 'section '.repeat(300));

    await expect(saveCreatorDraft(userId, oversized))
      .rejects.toThrow('creator_operation_journal_record_too_large');
    await expect(readCreatorDraft(userId, oversized.draftId)).resolves.toBeNull();
    await expect(listCreatorAudit(userId)).resolves.toEqual([]);
    await expect(recoverCreatorStoreOperations(userId)).resolves.toBe(0);

    const recovered = await saveCreatorDraft(userId, draft('recovered after rejected oversized operation'));
    expect(recovered.manifest.description).toBe('recovered after rejected oversized operation');
    await expect(recoverCreatorStoreOperations(userId)).resolves.toBe(0);
  });

  it('rejects wrong-user and traversal-shaped ids before any Creator path is built', async () => {
    const invalidUserIds = ['other-user', '../outside', 'nested/user', 'C:\\outside'];
    for (const invalidUserId of invalidUserIds) {
      await expect(listCreatorAudit(invalidUserId)).rejects.toThrow('creator_user_not_active');
      await expect(recoverCreatorStoreOperations(invalidUserId)).rejects.toThrow('creator_user_not_active');
      await expect(appendCreatorAudit(invalidUserId, { event: 'test.scope' })).rejects.toThrow('creator_user_not_active');
      await expect(saveCreatorDraft(invalidUserId, draft())).rejects.toThrow('creator_user_not_active');
      await expect(readCreatorDraft(invalidUserId, 'draft-local-research')).rejects.toThrow('creator_user_not_active');
      await expect(readCreatorPresetVersion(invalidUserId, 'local-research', '1')).rejects.toThrow('creator_user_not_active');
      await expect(readCreatorPresetState(invalidUserId, 'local-research')).rejects.toThrow('creator_user_not_active');
      await expect(publishCreatorPresetVersion(invalidUserId, 'draft-local-research', '1')).rejects.toThrow('creator_user_not_active');
      await expect(activateCreatorPresetVersion(invalidUserId, 'local-research', '1')).rejects.toThrow('creator_user_not_active');
      await expect(rollbackCreatorPreset(invalidUserId, 'local-research', '1')).rejects.toThrow('creator_user_not_active');
    }
  });

  it('maps valid-JSON structural corruption to file-specific errors', async () => {
    const draftFile = userCreatorDraftFile(userId, 'draft-local-research');
    await fs.mkdir(path.dirname(draftFile), { recursive: true });
    await fs.writeFile(draftFile, JSON.stringify({
      ...draft(),
      unexpected: true,
    }), 'utf8');
    await expect(readCreatorDraft(userId, 'draft-local-research')).rejects.toThrow('creator_draft_corrupt');
    await fs.writeFile(draftFile, JSON.stringify({ ...draft(), draftId: '../invalid' }), 'utf8');
    await expect(readCreatorDraft(userId, 'draft-local-research')).rejects.toThrow('creator_draft_corrupt');

    const versionFile = userCreatorPresetVersionFile(userId, 'local-research', '1');
    await fs.mkdir(path.dirname(versionFile), { recursive: true });
    await fs.writeFile(versionFile, JSON.stringify({ ...manifest('1'), remote: { allowedPeers: ['peer-a'] } }), 'utf8');
    await expect(readCreatorPresetVersion(userId, 'local-research', '1')).rejects.toThrow('creator_preset_version_corrupt');

    const stateFile = userCreatorPresetStateFile(userId, 'local-research');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      presetId: 'local-research',
      unexpected: true,
    }), 'utf8');
    await expect(readCreatorPresetState(userId, 'local-research')).rejects.toThrow('creator_preset_state_corrupt');
    await fs.writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      presetId: 'local-research',
      activeVersion: '../invalid',
    }), 'utf8');
    await expect(readCreatorPresetState(userId, 'local-research')).rejects.toThrow('creator_preset_state_corrupt');

    await fs.writeFile(userCreatorAuditFile(userId), `${JSON.stringify({
      schemaVersion: 1,
      auditId: 'audit-1',
      event: 'test.corrupt',
      createdAt: '2026-08-21T06:00:00.000Z',
      unexpected: true,
    })}\n`, 'utf8');
    await expect(listCreatorAudit(userId)).rejects.toThrow('creator_audit_corrupt');
    await fs.writeFile(userCreatorAuditFile(userId), `${JSON.stringify({
      schemaVersion: 1,
      auditId: 'audit-1',
      event: 'test.corrupt',
      createdAt: '2026-08-21T06:00:00.000Z',
      presetId: '../invalid',
    })}\n`, 'utf8');
    await expect(listCreatorAudit(userId)).rejects.toThrow('creator_audit_corrupt');
  });

  it('requires canonical bounded ISO-8601 timestamps in persisted records', async () => {
    const draftFile = userCreatorDraftFile(userId, 'draft-local-research');
    await fs.mkdir(path.dirname(draftFile), { recursive: true });
    await fs.writeFile(draftFile, JSON.stringify({ ...draft(), updatedAt: 'August 21, 2026 06:00 UTC' }), 'utf8');
    await expect(readCreatorDraft(userId, 'draft-local-research')).rejects.toThrow('creator_draft_corrupt');

    const stateFile = userCreatorPresetStateFile(userId, 'local-research');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      presetId: 'local-research',
      updatedAt: '2026-08-21T06:00:00Z',
    }), 'utf8');
    await expect(readCreatorPresetState(userId, 'local-research')).rejects.toThrow('creator_preset_state_corrupt');

    await fs.writeFile(userCreatorAuditFile(userId), `${JSON.stringify({
      schemaVersion: 1,
      auditId: 'audit-1',
      event: 'test.timestamp',
      createdAt: '2026-08-21 06:00:00',
    })}\n`, 'utf8');
    await expect(listCreatorAudit(userId)).rejects.toThrow('creator_audit_corrupt');
  });

  type DurableStep = 'after_prepare' | 'after_mutation' | 'after_audit';

  async function injectFaultAfter(step: DurableStep, action: () => Promise<unknown>): Promise<void> {
    const journalFile = userCreatorOperationJournalFile(userId);
    const originalAppend = storage.appendJsonl;

    if (step === 'after_prepare') {
      vi.spyOn(storage, 'writeJson').mockImplementationOnce(async () => {
        throw new Error('injected_after_prepare');
      });
    } else {
      vi.spyOn(storage, 'appendJsonl').mockImplementation(async (filePath, record) => {
        if (step === 'after_mutation' && filePath === userCreatorAuditFile(userId)) {
          throw new Error('injected_after_mutation');
        }
        if (
          step === 'after_audit'
          && filePath === journalFile
          && (record as { recordType?: string }).recordType === 'completed'
        ) {
          throw new Error('injected_after_audit');
        }
        return originalAppend(filePath, record);
      });
    }

    await expect(action()).rejects.toThrow(`injected_${step}`);
    vi.restoreAllMocks();

    const journalText = await fs.readFile(journalFile, 'utf8');
    expect(journalText).toContain('"recordType":"prepared"');

    vi.resetModules();
    const restartedUsers = await import('../../../../src/main/features/users');
    restartedUsers.activateUser(userId);
    const restartedStore = await import('../../../../src/main/features/creator/store');
    await expect(restartedStore.recoverCreatorStoreOperations(userId)).resolves.toBe(1);
    await expect(restartedStore.recoverCreatorStoreOperations(userId)).resolves.toBe(0);
    await expect(fs.stat(journalFile)).rejects.toMatchObject({ code: 'ENOENT' });
  }

  describe.each<DurableStep>(['after_prepare', 'after_mutation', 'after_audit'])('durable recovery at %s', (step) => {
    it('recovers draft save exactly once across restart', async () => {
      await injectFaultAfter(step, () => saveCreatorDraft(userId, draft(`draft ${step}`)));

      expect((await readCreatorDraft(userId, 'draft-local-research'))?.manifest.description).toBe(`draft ${step}`);
      expect((await listCreatorAudit(userId)).filter((row) => row.event === 'draft.saved')).toHaveLength(1);
    });

    it('recovers immutable publish exactly once across restart', async () => {
      await saveCreatorDraft(userId, draft(`publish ${step}`));
      await injectFaultAfter(step, () => publishCreatorPresetVersion(userId, 'draft-local-research', '1'));

      expect((await readCreatorPresetVersion(userId, 'local-research', '1'))?.description).toBe(`publish ${step}`);
      expect((await listCreatorAudit(userId)).filter((row) => row.event === 'preset.version_published')).toHaveLength(1);
    });

    it('recovers activation exactly once across restart', async () => {
      await saveCreatorDraft(userId, draft(`activate ${step}`));
      await publishCreatorPresetVersion(userId, 'draft-local-research', '1');
      await injectFaultAfter(step, () => activateCreatorPresetVersion(userId, 'local-research', '1'));

      expect((await readCreatorPresetState(userId, 'local-research')).activeVersion).toBe('1');
      expect((await listCreatorAudit(userId)).filter((row) => row.event === 'preset.activated')).toHaveLength(1);
    });

    it('recovers rollback exactly once across restart', async () => {
      await saveCreatorDraft(userId, draft(`rollback ${step}`));
      await publishCreatorPresetVersion(userId, 'draft-local-research', '1');
      await saveCreatorDraft(userId, draft(`rollback two ${step}`));
      await publishCreatorPresetVersion(userId, 'draft-local-research', '2');
      await activateCreatorPresetVersion(userId, 'local-research', '2');
      await injectFaultAfter(step, () => rollbackCreatorPreset(userId, 'local-research', '1'));

      expect(await readCreatorPresetState(userId, 'local-research')).toMatchObject({
        activeVersion: '1',
        previousActiveVersion: '2',
      });
      expect((await listCreatorAudit(userId)).filter((row) => row.event === 'preset.rolled_back')).toHaveLength(1);
    });
  });

  it('truncates a torn prepared tail without replaying an incomplete operation', async () => {
    const journalFile = userCreatorOperationJournalFile(userId);
    await fs.mkdir(path.dirname(journalFile), { recursive: true });
    await fs.writeFile(journalFile, '{"schemaVersion":1,"recordType":"prepared","operation":', 'utf8');

    await expect(recoverCreatorStoreOperations(userId)).resolves.toBe(0);
    await expect(readCreatorDraft(userId, 'draft-local-research')).resolves.toBeNull();
    await expect(listCreatorAudit(userId)).resolves.toEqual([]);
    await expect(fs.stat(journalFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('truncates a torn audit tail and replays its prepared operation exactly once', async () => {
    const auditFile = userCreatorAuditFile(userId);
    const originalAppend = storage.appendJsonl;
    let injected = false;
    vi.spyOn(storage, 'appendJsonl').mockImplementation(async (filePath, record) => {
      if (!injected && filePath === auditFile) {
        injected = true;
        await fs.mkdir(path.dirname(auditFile), { recursive: true });
        await fs.appendFile(auditFile, '{"schemaVersion":1,"auditId":"torn', 'utf8');
        throw new Error('injected_torn_audit');
      }
      return originalAppend(filePath, record);
    });

    await expect(saveCreatorDraft(userId, draft('torn audit'))).rejects.toThrow('injected_torn_audit');
    vi.restoreAllMocks();
    vi.resetModules();
    const restartedUsers = await import('../../../../src/main/features/users');
    restartedUsers.activateUser(userId);
    const restartedStore = await import('../../../../src/main/features/creator/store');

    await expect(restartedStore.recoverCreatorStoreOperations(userId)).resolves.toBe(1);
    await expect(restartedStore.recoverCreatorStoreOperations(userId)).resolves.toBe(0);
    expect((await restartedStore.listCreatorAudit(userId)).filter((row) => row.event === 'draft.saved')).toHaveLength(1);
    expect((await restartedStore.readCreatorDraft(userId, 'draft-local-research'))?.manifest.description).toBe('torn audit');
  });

  it('truncates a torn completed tail and deduplicates the already durable audit', async () => {
    const journalFile = userCreatorOperationJournalFile(userId);
    const originalAppend = storage.appendJsonl;
    let injected = false;
    vi.spyOn(storage, 'appendJsonl').mockImplementation(async (filePath, record) => {
      if (
        !injected
        && filePath === journalFile
        && (record as { recordType?: string }).recordType === 'completed'
      ) {
        injected = true;
        await fs.appendFile(journalFile, '{"schemaVersion":1,"recordType":"completed"', 'utf8');
        throw new Error('injected_torn_completed');
      }
      return originalAppend(filePath, record);
    });

    await expect(saveCreatorDraft(userId, draft('torn completed'))).rejects.toThrow('injected_torn_completed');
    vi.restoreAllMocks();
    vi.resetModules();
    const restartedUsers = await import('../../../../src/main/features/users');
    restartedUsers.activateUser(userId);
    const restartedStore = await import('../../../../src/main/features/creator/store');

    await expect(restartedStore.recoverCreatorStoreOperations(userId)).resolves.toBe(1);
    await expect(restartedStore.recoverCreatorStoreOperations(userId)).resolves.toBe(0);
    expect((await restartedStore.listCreatorAudit(userId)).filter((row) => row.event === 'draft.saved')).toHaveLength(1);
    expect((await restartedStore.readCreatorDraft(userId, 'draft-local-research'))?.manifest.description).toBe('torn completed');
  });

  it('never truncates a malformed middle JSONL row', async () => {
    const auditFile = userCreatorAuditFile(userId);
    const row = (auditId: string) => JSON.stringify({
      schemaVersion: 1,
      auditId,
      event: 'test.middle',
      createdAt: '2026-08-21T06:00:00.000Z',
    });
    const original = `${row('audit-1')}\n{"broken"\n${row('audit-2')}\n`;
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, original, 'utf8');

    await expect(listCreatorAudit(userId)).rejects.toThrow('creator_audit_corrupt');
    await expect(fs.readFile(auditFile, 'utf8')).resolves.toBe(original);
  });

  it('repairs only a torn final audit fragment before a standalone fresh append', async () => {
    const auditFile = userCreatorAuditFile(userId);
    const first = JSON.stringify({
      schemaVersion: 1,
      auditId: 'audit-existing',
      event: 'test.existing',
      createdAt: '2026-08-21T06:00:00.000Z',
    });
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, `${first}\n{"schemaVersion":1,"auditId":"torn`, 'utf8');

    await appendCreatorAudit(userId, { event: 'test.fresh' });

    expect((await listCreatorAudit(userId)).map((row) => row.event)).toEqual(['test.existing', 'test.fresh']);
  });

  it('rejects an oversized newline-terminated final audit record before append', async () => {
    const auditFile = userCreatorAuditFile(userId);
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, `${JSON.stringify({
      schemaVersion: 1,
      auditId: 'oversized-final',
      event: `test.${'x'.repeat(70_000)}`,
      createdAt: '2026-08-21T06:00:00.000Z',
    })}\n`, 'utf8');
    await expect(appendCreatorAudit(userId, { event: 'test.fresh' }))
      .rejects.toThrow('creator_audit_record_too_large');
  });

  it('appends a fresh audit record without reading complete audit history', async () => {
    const auditFile = userCreatorAuditFile(userId);
    const history = Array.from({ length: 4_000 }, (_unused, index) => JSON.stringify({
      schemaVersion: 1,
      auditId: `audit-${index}`,
      event: 'test.history',
      createdAt: '2026-08-21T06:00:00.000Z',
    })).join('\n') + '\n';
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, `${history}{"malformed-middle"\n${JSON.stringify({
      schemaVersion: 1,
      auditId: 'audit-tail',
      event: 'test.tail',
      createdAt: '2026-08-21T06:00:00.000Z',
    })}\n`, 'utf8');

    await appendCreatorAudit(userId, { event: 'test.fresh' });

    const appended = await fs.readFile(auditFile, 'utf8');
    expect(appended.startsWith(history)).toBe(true);
    expect(appended).toContain('{"malformed-middle"\n');
    expect(appended).toContain('"event":"test.fresh"');
  });
});
