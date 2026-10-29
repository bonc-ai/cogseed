import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as users from '../../../../src/main/features/users';

import type { CreatorPresetManifestV1 } from '../../../../src/main/features/creator/types';
import {
  createCreatorLifecycleService,
  type CreatorApprovalInput,
} from '../../../../src/main/features/creator/lifecycle-service';
import {
  appendCreatorLifecycleAudit,
  creatorLifecycleStoreLock,
  listCreatorAudit,
  publishCreatorPresetVersion,
  readCreatorDraft,
  readCreatorPresetVersion,
  saveCreatorDraft,
  type CreatorPresetDraft,
} from '../../../../src/main/features/creator/store';
import {
  creatorManifestDigest,
  type CreatorVerificationReport,
} from '../../../../src/main/features/creator/verification-service';
import { verifyCreatorPreset } from '../../../../src/main/features/creator/verification-service';
import type { CreatorCapabilityDescriptor } from '../../../../src/main/features/creator/catalog';

const userId = 'creator-lifecycle-user';
const workspaceRoot = process.env.COGSEED_WORKSPACE_ROOT as string;

function manifest(description: string): CreatorPresetManifestV1 {
  return {
    schemaVersion: 1,
    presetId: 'local-research',
    version: 'draft',
    displayName: 'Local research agent',
    description,
    presetType: 'cogseed-agent',
    model: { providerId: 'provider-main', modelId: 'deepseek-chat' },
    capabilities: [
      { capabilityId: 'tool.search', version: '1' },
    ],
    prompt: { systemSections: ['research', 'citations'], locale: 'en' },
    runtime: {
      sessionPolicy: 'new-per-run',
      memoryPolicy: 'read-only',
      loopPolicy: 'single-agent',
      sandboxProfile: 'creator-read-only-v1',
      timeoutMs: 60_000,
      budget: { maxCost: 2, maxTokens: 8_000 },
    },
    permissions: {
      tools: ['tool.search'],
      files: ['workspace.readonly'],
      sideEffects: [],
      approvalMode: 'always',
    },
    provenance: {
      createdBy: 'creator-agent',
      sourceSessionId: 'creator-session-1',
      sourceAssetRefs: [],
    },
  };
}

function draft(draftId: string, description: string): CreatorPresetDraft {
  return {
    schemaVersion: 1,
    draftId,
    manifest: manifest(description),
    updatedAt: '2026-08-21T06:00:00.000Z',
  };
}

function verification(
  value: CreatorPresetManifestV1,
  runId: string,
  status: CreatorVerificationReport['status'] = 'passed',
): CreatorVerificationReport {
  return {
    schemaVersion: 1,
    runId,
    presetId: value.presetId,
    manifestDigest: creatorManifestDigest(value),
    status,
    checks: [
      'schema', 'catalog-resolution', 'tool-allow-list', 'file-grants',
      'side-effects', 'budget', 'timeout', 'cancel',
      'idempotency', 'audit-trajectory', 'agent-usefulness',
    ].map((id) => ({
      id,
      status: status === 'passed' ? 'passed' : 'failed',
      evidence: [status === 'passed' ? 'verified' : 'verification failed'],
    })) as CreatorVerificationReport['checks'],
    startedAt: '2026-08-21T06:01:00.000Z',
    completedAt: '2026-08-21T06:01:01.000Z',
  };
}

function approval(
  draftId: string,
  value: CreatorPresetManifestV1,
  verificationRunId: string,
): CreatorApprovalInput {
  return {
    draftId,
    manifestDigest: creatorManifestDigest(value),
    verificationRunId,
    actorId: 'user-reviewer',
    confirmedAt: '2026-08-21T06:02:00.000Z',
    approved: true,
    approvedCapabilities: ['tool.search'],
    approvedSideEffects: [],
  };
}

function verificationCatalog(): CreatorCapabilityDescriptor[] {
  return [
    { capabilityId: 'model.provider-main.deepseek-chat', version: '1', kind: 'model', displayName: 'Model', available: true, permissions: ['cost'], sourceRef: 'provider.provider-main', health: 'ready' },
    { capabilityId: 'tool.search', version: '1', kind: 'tool', displayName: 'Search', available: true, permissions: ['read'], sourceRef: 'agent-capability.search', health: 'ready' },
  ];
}

function trustedVerifierOptions() {
  return {
    getActiveUserId: () => userId,
    buildCatalog: async () => verificationCatalog(),
    verifyPreset: async (uid: string, value: CreatorPresetManifestV1, runId: string) => verifyCreatorPreset(
      uid,
      { manifest: value, catalogSnapshot: verificationCatalog() },
      { createId: () => runId, buildCatalog: async () => verificationCatalog() },
    ),
  };
}

beforeEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
  users.activateUser(userId);
});

afterEach(async () => {
  await fs.rm(path.join(workspaceRoot, userId), { recursive: true, force: true });
});

describe('Creator preset lifecycle', () => {
  it('rejects skipped transitions, failed verification, and unpublished activation', async () => {
    const service = createCreatorLifecycleService({ isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions(), verifyPreset: async (_uid, value, runId) => verification(value, runId, 'failed') });
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const digest = creatorManifestDigest(saved.manifest);

    await expect(service.publishPreset(userId, 'draft-v1', {
      version: '1', manifestDigest: digest, verificationRunId: 'missing-run',
    })).rejects.toThrow('creator_verification_required');

    await service.sandboxPreset(userId, 'draft-v1', digest);
    await service.recordVerification(userId, 'draft-v1', verification(saved.manifest, 'failed-run', 'failed'));
    await expect(service.approvePreset(
      userId,
      'draft-v1',
      approval('draft-v1', saved.manifest, 'failed-run'),
    )).rejects.toThrow('creator_verification_not_passed');

    await expect(service.activatePreset(userId, 'local-research', '2'))
      .rejects.toThrow('creator_preset_version_not_published');
  });

  it('binds approval to the exact digest, verification, actor, and requested policy', async () => {
    const service = createCreatorLifecycleService({ isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-v1', digest);
    await service.recordVerification(userId, 'draft-v1', verification(saved.manifest, 'verify-v1'));

    await expect(service.approvePreset(userId, 'draft-v1', {
      ...approval('draft-v1', saved.manifest, 'verify-v1'),
      manifestDigest: `sha256:${'0'.repeat(64)}`,
    })).rejects.toThrow('creator_manifest_digest_mismatch');

    await expect(service.approvePreset(userId, 'draft-v1', {
      ...approval('draft-v1', saved.manifest, 'verify-v1'),
      approvedCapabilities: ['tool.search', 'tool.unknown'],
    })).rejects.toThrow('creator_approval_scope_mismatch');

    const approved = await service.approvePreset(
      userId,
      'draft-v1',
      approval('draft-v1', saved.manifest, 'verify-v1'),
    );
    expect(approved).toMatchObject({ status: 'approved', verificationRunId: 'verify-v1', approvalRef: expect.any(String) });
  });

  it('invalidates prior verification and approval when a draft manifest changes', async () => {
    const service = createCreatorLifecycleService({ isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-v1', digest);
    await service.recordVerification(userId, 'draft-v1', verification(saved.manifest, 'verify-v1'));
    await service.approvePreset(userId, 'draft-v1', approval('draft-v1', saved.manifest, 'verify-v1'));

    const changed = draft('draft-v1', 'changed after approval');
    await saveCreatorDraft(userId, changed);
    await expect(service.approvePreset(userId, 'draft-v1', approval('draft-v1', saved.manifest, 'verify-v1')))
      .rejects.toThrow('creator_manifest_digest_mismatch');
    await expect(service.approvePreset(userId, 'draft-v1', approval('draft-v1', changed.manifest, 'verify-v1')))
      .rejects.toThrow('creator_lifecycle_transition_invalid');
    await expect(service.publishPreset(userId, 'draft-v1', {
      version: '1', manifestDigest: creatorManifestDigest(changed.manifest), verificationRunId: 'verify-v1',
    })).rejects.toThrow('creator_manifest_digest_mismatch');
  });

  it('rejects incomplete verification evidence and supports an audited approved-to-rejected transition', async () => {
    const service = createCreatorLifecycleService({ isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-v1', digest);

    const incomplete = {
      ...verification(saved.manifest, 'verify-incomplete'),
      checks: verification(saved.manifest, 'verify-incomplete').checks.slice(0, 1),
    };
    await expect(service.recordVerification(userId, 'draft-v1', incomplete))
      .rejects.toThrow('creator_verification_report_invalid');

    await service.recordVerification(userId, 'draft-v1', {
      ...verification(saved.manifest, 'verify-v1'),
      checks: [
        'schema', 'catalog-resolution', 'tool-allow-list', 'file-grants',
        'side-effects', 'budget', 'timeout', 'cancel',
        'idempotency', 'audit-trajectory', 'agent-usefulness',
      ].map((id) => ({ id, status: 'passed', evidence: ['verified'] })) as CreatorVerificationReport['checks'],
    });
    await service.approvePreset(userId, 'draft-v1', approval('draft-v1', saved.manifest, 'verify-v1'));
    const rejected = await service.rejectPreset(userId, 'draft-v1', {
      actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:02:30.000Z',
    });

    expect(rejected.status).toBe('rejected');
    expect((await listCreatorAudit(userId)).map((entry) => entry.event))
      .toContain('creator.lifecycle.rejected');
  });

  it('publishes, activates, disables, and audits only legal state transitions', async () => {
    const isMaterialized = vi.fn(async (
      _uid: string,
      presetId: string,
      version: string,
      digest: string,
    ) => presetId === 'local-research' && version === '1' && digest.startsWith('sha256:'));
    const service = createCreatorLifecycleService({ isMaterialized, ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-v1', digest);
    await service.recordVerification(userId, 'draft-v1', verification(saved.manifest, 'verify-v1'));
    await service.approvePreset(userId, 'draft-v1', approval('draft-v1', saved.manifest, 'verify-v1'));

    const published = await service.publishPreset(userId, 'draft-v1', {
      version: '1', manifestDigest: digest, verificationRunId: 'verify-v1',
    });
    expect(published).toMatchObject({ status: 'published', presetId: 'local-research', version: '1' });
    await expect(service.publishPreset(userId, 'draft-v1', {
      version: '1', manifestDigest: digest, verificationRunId: 'verify-v1',
    })).resolves.toMatchObject({ status: 'published', version: '1', manifestDigest: published.manifestDigest });

    const active = await service.activatePreset(userId, 'local-research', '1');
    expect(active.status).toBe('active');
    await expect(service.activatePreset(userId, 'local-research', '1'))
      .resolves.toMatchObject({ status: 'active', version: '1', manifestDigest: published.manifestDigest });
    expect(isMaterialized).toHaveBeenCalledWith(
      userId, 'local-research', '1', published.manifestDigest,
    );

    const disabled = await service.disablePreset(userId, 'local-research', '1', {
      actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:03:00.000Z',
    });
    expect(disabled.status).toBe('disabled');
    await expect(service.disablePreset(userId, 'local-research', '1', {
      actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:03:00.000Z',
    })).resolves.toMatchObject({ status: 'disabled', version: '1' });
    await expect(service.activatePreset(userId, 'local-research', '1'))
      .rejects.toThrow('creator_preset_version_not_published');

    const events = (await listCreatorAudit(userId)).map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining([
      'creator.lifecycle.sandboxed',
      'creator.verification.recorded',
      'creator.lifecycle.verified',
      'creator.lifecycle.approved',
      'creator.lifecycle.published',
      'creator.lifecycle.active',
      'creator.lifecycle.disabled',
    ]));
    expect(events.filter((event) => event === 'creator.lifecycle.published')).toHaveLength(1);
    expect(events.filter((event) => event === 'creator.lifecycle.active')).toHaveLength(1);
    expect(events.filter((event) => event === 'creator.lifecycle.disabled')).toHaveLength(1);
  });

  it('fails closed when no runtime materialization verifier is installed', async () => {
    const service = createCreatorLifecycleService(trustedVerifierOptions());
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const draftDigest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-v1', draftDigest);
    await service.recordVerification(userId, 'draft-v1', verification(saved.manifest, 'verify-v1'));
    await service.approvePreset(userId, 'draft-v1', approval('draft-v1', saved.manifest, 'verify-v1'));
    await service.publishPreset(userId, 'draft-v1', {
      version: '1', manifestDigest: draftDigest, verificationRunId: 'verify-v1',
    });

    await expect(service.activatePreset(userId, 'local-research', '1'))
      .rejects.toThrow('creator_preset_not_materialized');
  });

  it('keeps a running immutable snapshot unchanged when a later version activates and rolls back', async () => {
    const service = createCreatorLifecycleService({ isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions() });

    const publishAndActivate = async (draftId: string, description: string, version: string, runId: string) => {
      const saved = await saveCreatorDraft(userId, draft(draftId, description));
      const digest = creatorManifestDigest(saved.manifest);
      await service.sandboxPreset(userId, draftId, digest);
      await service.recordVerification(userId, draftId, verification(saved.manifest, runId));
      await service.approvePreset(userId, draftId, approval(draftId, saved.manifest, runId));
      await service.publishPreset(userId, draftId, {
        version, manifestDigest: digest, verificationRunId: runId,
      });
      await service.activatePreset(userId, 'local-research', version);
    };

    await publishAndActivate('draft-v1', 'version one', '1', 'verify-v1');
    const runningV1 = await service.captureActiveSnapshot(userId, 'local-research');
    await publishAndActivate('draft-v2', 'version two', '2', 'verify-v2');
    const runningV2 = await service.captureActiveSnapshot(userId, 'local-research');

    const rolledBack = await service.rollbackPreset(userId, 'local-research', '1', {
      actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:04:00.000Z',
    });
    const afterRollback = await service.captureActiveSnapshot(userId, 'local-research');

    expect(rolledBack).toMatchObject({ status: 'active', version: '1' });
    expect(runningV1.manifest.description).toBe('version one');
    expect(runningV2.manifest.description).toBe('version two');
    expect(afterRollback.manifest.description).toBe('version one');
    expect(runningV2.manifest.description).toBe('version two');
    expect(Object.isFrozen(runningV2.manifest)).toBe(true);

    await expect(service.activatePreset(userId, 'local-research', '2'))
      .rejects.toThrow('creator_preset_version_not_published');
    await expect(service.disablePreset(userId, 'local-research', '2', {
      actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:05:00.000Z',
    })).rejects.toThrow('creator_lifecycle_transition_invalid');
  });

  it('recovers publish after the immutable version commits but lifecycle audit append fails', async () => {
    let failPublishedAudit = true;
    const service = createCreatorLifecycleService({
      ...trustedVerifierOptions(),
      isMaterialized: vi.fn(async () => true),
      appendAudit: async (uid, input) => {
        if (input.event === 'creator.lifecycle.published' && failPublishedAudit) {
          failPublishedAudit = false;
          throw new Error('injected_audit_failure');
        }
        return appendCreatorLifecycleAudit(uid, input);
      },
    });
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-v1', digest);
    await service.recordVerification(userId, 'draft-v1', verification(saved.manifest, 'verify-v1'));
    await service.approvePreset(userId, 'draft-v1', approval('draft-v1', saved.manifest, 'verify-v1'));
    const input = { version: '1', manifestDigest: digest, verificationRunId: 'verify-v1' };

    await expect(service.publishPreset(userId, 'draft-v1', input)).rejects.toThrow('injected_audit_failure');
    await expect(service.publishPreset(userId, 'draft-v1', input))
      .resolves.toMatchObject({ status: 'published', version: '1' });

    const events = (await listCreatorAudit(userId)).map((entry) => entry.event);
    expect(events.filter((event) => event === 'preset.version_published')).toHaveLength(1);
    expect(events.filter((event) => event === 'creator.lifecycle.published')).toHaveLength(1);
  });

  it('recovers rollback after state commits but the lifecycle audit append fails', async () => {
    let failRollbackAudit = false;
    const service = createCreatorLifecycleService({
      ...trustedVerifierOptions(),
      isMaterialized: vi.fn(async () => true),
      appendAudit: async (uid, input) => {
        if (input.event === 'creator.lifecycle.rolled_back' && failRollbackAudit) {
          failRollbackAudit = false;
          throw new Error('injected_audit_failure');
        }
        return appendCreatorLifecycleAudit(uid, input);
      },
    });
    const publishAndActivate = async (draftId: string, description: string, version: string, runId: string) => {
      const saved = await saveCreatorDraft(userId, draft(draftId, description));
      const digest = creatorManifestDigest(saved.manifest);
      await service.sandboxPreset(userId, draftId, digest);
      await service.recordVerification(userId, draftId, verification(saved.manifest, runId));
      await service.approvePreset(userId, draftId, approval(draftId, saved.manifest, runId));
      await service.publishPreset(userId, draftId, { version, manifestDigest: digest, verificationRunId: runId });
      await service.activatePreset(userId, 'local-research', version);
    };
    await publishAndActivate('draft-v1', 'version one', '1', 'verify-v1');
    await publishAndActivate('draft-v2', 'version two', '2', 'verify-v2');
    failRollbackAudit = true;
    const confirmation = { actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:06:00.000Z' };

    await expect(service.rollbackPreset(userId, 'local-research', '1', confirmation))
      .rejects.toThrow('injected_audit_failure');
    await expect(service.rollbackPreset(userId, 'local-research', '1', confirmation))
      .resolves.toMatchObject({ status: 'active', version: '1' });
    await expect(service.rollbackPreset(userId, 'local-research', '1', confirmation))
      .resolves.toMatchObject({ status: 'active', version: '1' });

    const events = await listCreatorAudit(userId);
    expect(events.filter((entry) => entry.event === 'preset.rolled_back')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'creator.lifecycle.rolled_back')).toHaveLength(1);
  });

  it('recovers activation without duplicating the durable state mutation audit', async () => {
    let failActiveAudit = true;
    const service = createCreatorLifecycleService({
      ...trustedVerifierOptions(),
      isMaterialized: vi.fn(async () => true),
      appendAudit: async (uid, input) => {
        if (input.event === 'creator.lifecycle.active' && failActiveAudit) {
          failActiveAudit = false;
          throw new Error('injected_audit_failure');
        }
        return appendCreatorLifecycleAudit(uid, input);
      },
    });
    const saved = await saveCreatorDraft(userId, draft('draft-v1', 'version one'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-v1', digest);
    await service.recordVerification(userId, 'draft-v1', verification(saved.manifest, 'verify-v1'));
    await service.approvePreset(userId, 'draft-v1', approval('draft-v1', saved.manifest, 'verify-v1'));
    await service.publishPreset(userId, 'draft-v1', {
      version: '1', manifestDigest: digest, verificationRunId: 'verify-v1',
    });

    await expect(service.activatePreset(userId, 'local-research', '1'))
      .rejects.toThrow('injected_audit_failure');
    await expect(service.activatePreset(userId, 'local-research', '1'))
      .resolves.toMatchObject({ status: 'active', version: '1' });

    const events = (await listCreatorAudit(userId)).map((entry) => entry.event);
    expect(events.filter((event) => event === 'preset.activated')).toHaveLength(1);
    expect(events.filter((event) => event === 'creator.lifecycle.active')).toHaveLength(1);
  });

  it('does not trust a forged all-passed report when the verifier rejects the draft', async () => {
    const service = createCreatorLifecycleService({
      getActiveUserId: () => userId,
      isMaterialized: vi.fn(async () => true),
      buildCatalog: async () => verificationCatalog(),
      verifyPreset: async (_uid, value, runId) => verification(value, runId, 'failed'),
    });
    const saved = await saveCreatorDraft(userId, draft('draft-forged', 'invalid for verification'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-forged', digest);
    await service.recordVerification(userId, 'draft-forged', verification(saved.manifest, 'forged-run', 'passed'));
    await expect(service.approvePreset(userId, 'draft-forged', approval('draft-forged', saved.manifest, 'forged-run')))
      .rejects.toThrow('creator_verification_not_passed');
    await expect(service.publishPreset(userId, 'draft-forged', {
      version: '1', manifestDigest: digest, verificationRunId: 'forged-run',
    })).rejects.toThrow('creator_verification_not_passed');
  });

  it('serializes concurrent transitions for one draft without duplicate audit success', async () => {
    const service = createCreatorLifecycleService({ isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-concurrent', 'concurrent'));
    const digest = creatorManifestDigest(saved.manifest);
    const results = await Promise.allSettled([
      service.sandboxPreset(userId, 'draft-concurrent', digest),
      service.sandboxPreset(userId, 'draft-concurrent', digest),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await listCreatorAudit(userId)).filter((entry) => entry.event === 'creator.lifecycle.sandboxed')).toHaveLength(1);
  });

  it('binds the published digest to the final version verified before storage', async () => {
    const verifiedManifests: CreatorPresetManifestV1[] = [];
    const service = createCreatorLifecycleService({
      getActiveUserId: () => userId,
      verifyPreset: async (uid, value, runId) => {
        verifiedManifests.push(value);
        return verifyCreatorPreset(uid, { manifest: value, catalogSnapshot: verificationCatalog() }, {
          createId: () => runId,
          buildCatalog: async () => verificationCatalog(),
        });
      },
    });
    const saved = await saveCreatorDraft(userId, draft('draft-version-bound', 'version bound'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, saved.draftId, digest);
    await service.recordVerification(userId, saved.draftId, verification(saved.manifest, 'verify-bound'));
    await service.approvePreset(userId, saved.draftId, approval(saved.draftId, saved.manifest, 'verify-bound'));

    const published = await service.publishPreset(userId, saved.draftId, {
      version: '1', manifestDigest: digest, verificationRunId: 'verify-bound',
    });
    const finalVerification = verifiedManifests.at(-1)!;
    expect(finalVerification.version).toBe('1');
    expect(published.manifestDigest).toBe(creatorManifestDigest(finalVerification));
    expect(published.manifestDigest).not.toBe(digest);
  });

  it('does not publish a draft replaced after verification', async () => {
    const service = createCreatorLifecycleService({
      getActiveUserId: () => userId,
      ...trustedVerifierOptions(),
    });
    const saved = await saveCreatorDraft(userId, draft('draft-publish-race', 'approved original'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, saved.draftId, digest);
    const report = verification(saved.manifest, 'publish-race-run');
    await service.recordVerification(userId, saved.draftId, report);
    await service.approvePreset(userId, saved.draftId, approval(saved.draftId, saved.manifest, report.runId));
    await saveCreatorDraft(userId, draft(saved.draftId, 'unapproved replacement'));

    await expect(service.publishPreset(userId, saved.draftId, {
      version: '1', manifestDigest: digest, verificationRunId: report.runId,
    })).rejects.toThrow('creator_manifest_digest_mismatch');
    await expect(readCreatorPresetVersion(userId, saved.manifest.presetId, '1')).resolves.toBeNull();
  });

  it('coordinates a draft save with publication before the published audit is committed', async () => {
    let versionPublished!: () => void;
    const versionReady = new Promise<void>((resolve) => { versionPublished = resolve; });
    let releasePublish!: () => void;
    const release = new Promise<void>((resolve) => { releasePublish = resolve; });
    let saveStarted!: () => void;
    const saveReady = new Promise<void>((resolve) => { saveStarted = resolve; });
    const service = createCreatorLifecycleService({
      ...trustedVerifierOptions(),
      isMaterialized: vi.fn(async () => true),
      publishVersion: (async (uid, draftId, version, expectedDigest) => {
        const published = await publishCreatorPresetVersion(uid, draftId, version, expectedDigest, { lifecycleLockHeld: true });
        versionPublished();
        await release;
        return published;
      }) as any,
    });
    const saved = await saveCreatorDraft(userId, draft('draft-save-publish-race', 'original'));
    const digest = creatorManifestDigest(saved.manifest);
    const report = verification(saved.manifest, 'save-publish-race');
    await service.sandboxPreset(userId, saved.draftId, digest);
    await service.recordVerification(userId, saved.draftId, report);
    await service.approvePreset(userId, saved.draftId, approval(saved.draftId, saved.manifest, report.runId));

    const publishing = service.publishPreset(userId, saved.draftId, {
      version: '1', manifestDigest: digest, verificationRunId: report.runId,
    });
    await versionReady;
    const changed = draft(saved.draftId, 'saved while publication was in flight');
    const saving = saveCreatorDraft(userId, changed).finally(() => saveStarted());
    await Promise.resolve();
    releasePublish();
    const [published] = await Promise.all([publishing, saving]);
    expect(published.status).toBe('published');
    const current = await readCreatorDraft(userId, saved.draftId);
    expect(current?.manifest.description).toBe('saved while publication was in flight');
    await expect(service.sandboxPreset(userId, saved.draftId, creatorManifestDigest(changed.manifest)))
      .resolves.toMatchObject({ status: 'sandboxed' });
  });

  it('rechecks an idempotent publication after a queued save changes the draft', async () => {
    const service = createCreatorLifecycleService({ isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-idempotent-save-race', 'original'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, saved.draftId, digest);
    const report = verification(saved.manifest, 'idempotent-save-race');
    await service.recordVerification(userId, saved.draftId, report);
    await service.approvePreset(userId, saved.draftId, approval(saved.draftId, saved.manifest, report.runId));
    await service.publishPreset(userId, saved.draftId, {
      version: '1', manifestDigest: digest, verificationRunId: report.runId,
    });

    const releaseStoreLock = await creatorLifecycleStoreLock(userId).acquire();
    const changed = draft(saved.draftId, 'replacement queued before idempotent publish');
    const saving = saveCreatorDraft(userId, changed);
    await Promise.resolve();
    const publishing = service.publishPreset(userId, saved.draftId, {
      version: '1', manifestDigest: digest, verificationRunId: report.runId,
    });
    releaseStoreLock();

    await saving;
    await expect(publishing).rejects.toThrow('creator_manifest_digest_mismatch');
    expect((await listCreatorAudit(userId)).filter((entry) => (
      entry.event === 'creator.lifecycle.published' && entry.draftId === saved.draftId
    ))).toHaveLength(1);
  });

  it('rejects a verification report with a hostile evidence iterator', async () => {
    const service = createCreatorLifecycleService({ ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-hostile-evidence', 'evidence'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, saved.draftId, digest);
    const report = verification(saved.manifest, 'hostile-evidence');
    let iteratorCalled = false;
    Object.defineProperty(report.checks[0].evidence, Symbol.iterator, {
      value: () => { iteratorCalled = true; throw new Error('hostile iterator'); },
    });
    await expect(service.recordVerification(userId, saved.draftId, report))
      .resolves.toMatchObject({ status: 'verified' });
    expect(iteratorCalled).toBe(false);
  });

  it('serializes active snapshot capture with lifecycle mutation', async () => {
    let holdSnapshot = false;
    let snapshotStarted!: () => void;
    const snapshotReady = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    let releaseSnapshot!: () => void;
    const snapshotRelease = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    let disabled!: () => void;
    const disabledAudit = new Promise<void>((resolve) => { disabled = resolve; });
    const baseReadState = (await import('../../../../src/main/features/creator/store')).readCreatorPresetState;
    const service = createCreatorLifecycleService({
      isMaterialized: vi.fn(async () => true),
      ...trustedVerifierOptions(),
      readPresetState: async (...args) => {
        const state = await baseReadState(...args);
        if (holdSnapshot) {
          holdSnapshot = false;
          snapshotStarted();
          await snapshotRelease;
        }
        return state;
      },
      appendAudit: async (uid, input) => {
        const record = await appendCreatorLifecycleAudit(uid, input);
        if (input.event === 'creator.lifecycle.disabled') disabled();
        return record;
      },
    });
    const saved = await saveCreatorDraft(userId, draft('draft-snapshot', 'snapshot'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, saved.draftId, digest);
    await service.recordVerification(userId, saved.draftId, verification(saved.manifest, 'verify-snapshot'));
    await service.approvePreset(userId, saved.draftId, approval(saved.draftId, saved.manifest, 'verify-snapshot'));
    await service.publishPreset(userId, saved.draftId, { version: '1', manifestDigest: digest, verificationRunId: 'verify-snapshot' });
    await service.activatePreset(userId, 'local-research', '1');

    holdSnapshot = true;
    const snapshot = service.captureActiveSnapshot(userId, 'local-research');
    await snapshotReady;
    const transition = service.disablePreset(userId, 'local-research', '1', {
      actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:07:00.000Z',
    });
    const raced = await Promise.race([
      disabledAudit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(raced).toBe(false);
    releaseSnapshot();
    await expect(snapshot).resolves.toMatchObject({
      version: '1', manifestDigest: creatorManifestDigest({ ...saved.manifest, version: '1' }),
    });
    await expect(transition).resolves.toMatchObject({ status: 'disabled', version: '1' });
  });

  it('rejects null, missing, and oversized verification reports with a stable error', async () => {
    const service = createCreatorLifecycleService({ getActiveUserId: () => userId, ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-report-shape', 'report shape'));
    await expect(service.recordVerification(userId, saved.draftId, null as any))
      .rejects.toThrow('creator_verification_report_invalid');
    await expect(service.recordVerification(userId, saved.draftId, { checks: [] } as any))
      .rejects.toThrow('creator_verification_report_invalid');
    const huge = verification(saved.manifest, 'verify-huge');
    huge.checks[0].evidence = Array.from({ length: 10_001 }, () => 'evidence');
    await expect(service.recordVerification(userId, saved.draftId, huge))
      .rejects.toThrow('creator_verification_report_invalid');
  });

  it('rejects wrong-user and traversal-shaped lifecycle access before storage reads', async () => {
    const readDraft = vi.fn(async () => null);
    const service = createCreatorLifecycleService({
      getActiveUserId: () => userId,
      readDraft,
    });
    await expect(service.sandboxPreset('other-user', 'draft-v1', `sha256:${'0'.repeat(64)}`))
      .rejects.toThrow('creator_user_not_active');
    await expect(service.sandboxPreset(`${userId}/../other`, 'draft-v1', `sha256:${'0'.repeat(64)}`))
      .rejects.toThrow('creator_user_not_active');
    expect(readDraft).not.toHaveBeenCalled();
  });

  it('recovers verification audit completion without rerunning verification or duplicating events', async () => {
    let failVerifiedAudit = true;
    const verifyPreset = vi.fn(async (uid: string, value: CreatorPresetManifestV1, runId: string) =>
      verifyCreatorPreset(uid, { manifest: value, catalogSnapshot: verificationCatalog() }, {
        createId: () => runId,
        buildCatalog: async () => verificationCatalog(),
      }));
    const baseAppend = appendCreatorLifecycleAudit;
    const appendAudit = vi.fn(async (uid: string, input: any) => {
      if (input.event === 'creator.lifecycle.verified' && failVerifiedAudit) {
        failVerifiedAudit = false;
        throw new Error('injected_second_append_failure');
      }
      return baseAppend(uid, input);
    });
    const service = createCreatorLifecycleService({ getActiveUserId: () => userId, verifyPreset, appendAudit });
    const saved = await saveCreatorDraft(userId, draft('draft-retry', 'retry'));
    const digest = creatorManifestDigest(saved.manifest);
    await service.sandboxPreset(userId, 'draft-retry', digest);
    const report = verification(saved.manifest, 'retry-run');
    await expect(service.recordVerification(userId, 'draft-retry', report)).rejects.toThrow('injected_second_append_failure');
    await service.recordVerification(userId, 'draft-retry', report);
    expect(verifyPreset).toHaveBeenCalledOnce();
    const events = await listCreatorAudit(userId);
    expect(events.filter((entry) => entry.event === 'creator.verification.recorded')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'creator.lifecycle.verified')).toHaveLength(1);
  });

  it('returns prior approval and rejection after durable append failures without duplicate audits', async () => {
    const failed = new Set<string>();
    const appendAudit = vi.fn(async (uid: string, input: any) => {
      const record = await appendCreatorLifecycleAudit(uid, input);
      if ((input.event === 'creator.lifecycle.approved' || input.event === 'creator.lifecycle.rejected')
        && !failed.has(input.event)) {
        failed.add(input.event);
        throw new Error(`injected_${input.event}`);
      }
      return record;
    });
    const service = createCreatorLifecycleService({
      getActiveUserId: () => userId,
      appendAudit,
      ...trustedVerifierOptions(),
    });
    const saved = await saveCreatorDraft(userId, draft('draft-approval-retry', 'retry approval'));
    const report = verification(saved.manifest, 'approval-retry-run');
    await service.sandboxPreset(userId, saved.draftId, creatorManifestDigest(saved.manifest));
    await service.recordVerification(userId, saved.draftId, report);
    const approvalInput = approval(saved.draftId, saved.manifest, report.runId);

    await expect(service.approvePreset(userId, saved.draftId, approvalInput)).rejects.toThrow('injected_creator.lifecycle.approved');
    const approved = await service.approvePreset(userId, saved.draftId, approvalInput);
    expect(approved.status).toBe('approved');

    const confirmation = { actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:03:00.000Z' };
    await expect(service.rejectPreset(userId, saved.draftId, confirmation)).rejects.toThrow('injected_creator.lifecycle.rejected');
    const rejected = await service.rejectPreset(userId, saved.draftId, confirmation);
    expect(rejected.status).toBe('rejected');

    const events = await listCreatorAudit(userId);
    expect(events.filter((entry) => entry.event === 'creator.lifecycle.approved')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'creator.lifecycle.rejected')).toHaveLength(1);
  });

  it('rejects hostile approval arrays with a stable scope error before sorting or copying', async () => {
    const service = createCreatorLifecycleService({ getActiveUserId: () => userId, ...trustedVerifierOptions() });
    const saved = await saveCreatorDraft(userId, draft('draft-approval-array', 'approval array'));
    const report = verification(saved.manifest, 'approval-array-run');
    await service.sandboxPreset(userId, saved.draftId, creatorManifestDigest(saved.manifest));
    await service.recordVerification(userId, saved.draftId, report);
    const hostile = new Proxy(['tool.search'], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('/private/approval-array token=secret');
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(service.approvePreset(userId, saved.draftId, {
      ...approval(saved.draftId, saved.manifest, report.runId),
      approvedCapabilities: hostile as any,
    })).rejects.toThrow('creator_approval_scope_mismatch');
  });

  it('rejects nullish lifecycle payloads with stable validation errors', async () => {
    const service = createCreatorLifecycleService({ getActiveUserId: () => userId, ...trustedVerifierOptions() });
    await expect(service.approvePreset(userId, 'draft-null-input', null as any))
      .rejects.toThrow('creator_approval_invalid');
    await expect(service.rejectPreset(userId, 'draft-null-input', null as any))
      .rejects.toThrow('creator_confirmation_invalid');
    await expect(service.publishPreset(userId, 'draft-null-input', null as any))
      .rejects.toThrow('creator_publish_input_invalid');
  });

  it('rejects noncanonical and oversized confirmation timestamps before parsing', async () => {
    const service = createCreatorLifecycleService({ getActiveUserId: () => userId, ...trustedVerifierOptions() });
    await expect(service.rejectPreset(userId, 'missing-draft', {
      actorId: 'user-reviewer', confirmedAt: 'August 21, 2026 06:03 UTC',
    })).rejects.toThrow('creator_approval_confirmation_invalid');
    await expect(service.rejectPreset(userId, 'missing-draft', {
      actorId: 'user-reviewer', confirmedAt: 'x'.repeat(10_000),
    })).rejects.toThrow('creator_approval_confirmation_invalid');
  });

  it('does not replay verification into approved or rejected drafts', async () => {
    for (const outcome of ['approved', 'rejected'] as const) {
      const service = createCreatorLifecycleService({ getActiveUserId: () => userId, ...trustedVerifierOptions() });
      const saved = await saveCreatorDraft(userId, draft(`draft-replay-${outcome}`, outcome));
      const digest = creatorManifestDigest(saved.manifest);
      const report = verification(saved.manifest, `replay-${outcome}`);
      await service.sandboxPreset(userId, saved.draftId, digest);
      await service.recordVerification(userId, saved.draftId, report);
      await service.approvePreset(userId, saved.draftId, approval(saved.draftId, saved.manifest, report.runId));
      if (outcome === 'rejected') {
        await service.rejectPreset(userId, saved.draftId, {
          actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:03:00.000Z',
        });
      }
      await expect(service.recordVerification(userId, saved.draftId, report))
        .rejects.toThrow('creator_lifecycle_transition_invalid');
    }
  });

  it('does not replay verification into a published draft', async () => {
    const service = createCreatorLifecycleService({
      getActiveUserId: () => userId,
      isMaterialized: vi.fn(async () => true),
      ...trustedVerifierOptions(),
    });
    const saved = await saveCreatorDraft(userId, draft('draft-replay-published', 'published'));
    const digest = creatorManifestDigest(saved.manifest);
    const report = verification(saved.manifest, 'replay-published');
    await service.sandboxPreset(userId, saved.draftId, digest);
    await service.recordVerification(userId, saved.draftId, report);
    await service.approvePreset(userId, saved.draftId, approval(saved.draftId, saved.manifest, report.runId));
    await service.publishPreset(userId, saved.draftId, { version: '1', manifestDigest: digest, verificationRunId: report.runId });
    await expect(service.recordVerification(userId, saved.draftId, report))
      .rejects.toThrow('creator_lifecycle_transition_invalid');
  });

  it('does not replay approval after rejection or publication', async () => {
    const rejectedService = createCreatorLifecycleService({ getActiveUserId: () => userId, ...trustedVerifierOptions() });
    const rejected = await saveCreatorDraft(userId, draft('draft-approval-replay-rejected', 'rejected'));
    const rejectedReport = verification(rejected.manifest, 'approval-replay-rejected');
    await rejectedService.sandboxPreset(userId, rejected.draftId, creatorManifestDigest(rejected.manifest));
    await rejectedService.recordVerification(userId, rejected.draftId, rejectedReport);
    const rejectedApproval = approval(rejected.draftId, rejected.manifest, rejectedReport.runId);
    await rejectedService.approvePreset(userId, rejected.draftId, rejectedApproval);
    await rejectedService.rejectPreset(userId, rejected.draftId, {
      actorId: 'user-reviewer', confirmedAt: '2026-08-21T06:03:00.000Z',
    });
    await expect(rejectedService.approvePreset(userId, rejected.draftId, rejectedApproval))
      .rejects.toThrow('creator_lifecycle_transition_invalid');

    const publishedService = createCreatorLifecycleService({
      getActiveUserId: () => userId, isMaterialized: vi.fn(async () => true), ...trustedVerifierOptions(),
    });
    const published = await saveCreatorDraft(userId, draft('draft-approval-replay-published', 'published'));
    const publishedReport = verification(published.manifest, 'approval-replay-published');
    await publishedService.sandboxPreset(userId, published.draftId, creatorManifestDigest(published.manifest));
    await publishedService.recordVerification(userId, published.draftId, publishedReport);
    const publishedApproval = approval(published.draftId, published.manifest, publishedReport.runId);
    await publishedService.approvePreset(userId, published.draftId, publishedApproval);
    await publishedService.publishPreset(userId, published.draftId, {
      version: '1', manifestDigest: creatorManifestDigest(published.manifest), verificationRunId: publishedReport.runId,
    });
    await expect(publishedService.approvePreset(userId, published.draftId, publishedApproval))
      .rejects.toThrow('creator_lifecycle_transition_invalid');
  });
});
