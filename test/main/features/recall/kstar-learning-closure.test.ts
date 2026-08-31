import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-learning-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('KSTAR learning evidence', () => {
  it('keeps injection receipts separate from validation and maturity changes', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Use a verified review checklist.',
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'episode-a' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    const receipt = await receipts.recordInjectionReceipt('user-a', {
      taskRunId: 'run-a', assetId: promoted.asset.id, assetVersion: promoted.asset.version,
      projectionId: 'projection-a', boundary: 'real', status: 'injected', messageId: 'message-a',
    });

    expect(receipt.id).toMatch(/^inj-/);
    await expect(receipts.listInjectionReceipts('user-a', 'run-a')).resolves.toEqual([expect.objectContaining({ id: receipt.id })]);
    expect((await candidates.readRecallCandidate('user-a', candidate.id)).validationCount).toBeUndefined();
    await expect((await import('../../../../src/main/features/recall/asset-service')).readAbilityAsset('user-a', promoted.asset.id)).resolves.toMatchObject({ maturity: 'bud' });
  });

  it('writes independent validation records and updates candidate counters', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const validation = await import('../../../../src/main/features/recall/validation-service');
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep validation evidence independent from injection.',
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'episode-b' }],
    });
    const first = await validation.recordValidation('user-a', {
      assetId: 'asset-b', candidateId: candidate.id, taskRunId: 'run-b', outcome: 'success',
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'evaluation-b' }],
    });
    const second = await validation.recordValidation('user-a', {
      assetId: 'asset-b', candidateId: candidate.id, taskRunId: 'run-c', outcome: 'failure',
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'evaluation-c' }],
    });
    expect(first.id).not.toBe(second.id);
    await expect(candidates.readRecallCandidate('user-a', candidate.id)).resolves.toMatchObject({
      validationCount: 1,
      consecutiveFailures: 1,
      lastValidatedAt: expect.any(String),
    });
    await expect(validation.listValidationRecords('user-a')).resolves.toHaveLength(2);
  });

  it('applies promotion policy thresholds without treating injection as proof', async () => {
    const policy = await import('../../../../src/main/features/recall/promotion-policy');
    expect(policy.evaluatePromotionPolicy({ risk: 'low', status: 'pending_review', validationCount: 0, consecutiveFailures: 0 })).toMatchObject({ action: 'hold' });
    expect(policy.evaluatePromotionPolicy({ risk: 'low', status: 'pending_review', validationCount: 1, consecutiveFailures: 0 })).toMatchObject({ action: 'promote' });
    expect(policy.evaluatePromotionPolicy({ risk: 'high', status: 'pending_review', validationCount: 10, consecutiveFailures: 0 })).toMatchObject({ action: 'hold' });
    expect(policy.evaluatePromotionPolicy({ risk: 'low', status: 'pending_review', validationCount: 1, consecutiveFailures: 3 })).toMatchObject({ action: 'pause' });
  });

  it('stops automatic promotion after three consecutive validation failures', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const validation = await import('../../../../src/main/features/recall/validation-service');
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Pause a candidate after repeated independent failures.',
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'episode-pause' }],
    });
    for (const taskRunId of ['run-pause-a', 'run-pause-b', 'run-pause-c']) {
      await validation.recordValidation('user-a', {
        assetId: 'asset-pause', candidateId: candidate.id, taskRunId, outcome: 'failure',
        evidenceRefs: [{ kind: 'execution_evaluation', id: `evaluation-${taskRunId}` }],
      });
    }
    await expect(candidates.autoApplyRecallCandidate('user-a', candidate.id, { semanticDedup: false })).rejects.toMatchObject({ code: 'promotion_paused' });
  });

  it('counts independent asset outcomes, advances a seed after two successes, and pauses after repeated failures', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const validation = await import('../../../../src/main/features/recall/validation-service');
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Repeat the independently validated review method.',
      suggestedType: 'rule', suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'episode-repeatability' }],
    });
    const asset = await assets.createSystemAbilityAsset('user-a', {
      schemaVersion: 1, ownerId: 'user-a', id: 'asset-repeatability', candidateId: candidate.id,
      title: 'Repeatable review method', statement: candidate.judgment, type: 'rule', scope: 'review',
      evidenceRefs: [{ kind: 'execution', id: 'episode-repeatability' }], reviewDecisionId: 'legacy-untracked',
      lifecycleStatus: 'system_precipitated_unverified', status: 'active', maturity: 'seed', version: '1',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, 'test validation asset');

    await validation.recordValidation('user-a', {
      assetId: asset.id, candidateId: candidate.id, taskRunId: 'repeat-run-1', outcome: 'success',
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'repeat-eval-1' }],
    });
    await validation.recordValidation('user-a', {
      assetId: asset.id, candidateId: candidate.id, taskRunId: 'repeat-run-2', outcome: 'success',
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'repeat-eval-2' }],
    });
    const duplicate = await validation.recordValidation('user-a', {
      assetId: asset.id, candidateId: candidate.id, taskRunId: 'repeat-run-2', outcome: 'failure',
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'repeat-eval-2-retry' }],
    });
    expect(duplicate.outcome).toBe('success');
    await expect(assets.readAbilityAsset('user-a', asset.id)).resolves.toMatchObject({
      validationCount: 2, consecutiveFailures: 0, maturity: 'bud', status: 'active',
    });

    for (const taskRunId of ['repeat-run-3', 'repeat-run-4', 'repeat-run-5']) {
      await validation.recordValidation('user-a', {
        assetId: asset.id, candidateId: candidate.id, taskRunId, outcome: 'failure',
        evidenceRefs: [{ kind: 'execution_evaluation', id: `repeat-eval-${taskRunId}` }],
      });
    }
    await expect(assets.readAbilityAsset('user-a', asset.id)).resolves.toMatchObject({
      validationCount: 2, consecutiveFailures: 3, status: 'paused', maturity: 'bud',
    });
    await expect(candidates.readRecallCandidate('user-a', candidate.id)).resolves.toMatchObject({
      validationCount: 2, consecutiveFailures: 3,
    });
  });
});

describe('world model snapshot persistence', () => {
  it('round-trips a user-scoped snapshot separately from its forecast', async () => {
    const worldModel = await import('../../../../src/main/features/recall/world-model');
    const snapshot = worldModel.collectWorldSnapshot('user-a', {
      taskRunId: 'run-snapshot', workspace: { ok: true }, model: { configured: true },
      tools: { fileSystem: true, bash: true }, groupChatStatus: 'running',
      skills: { total: 3, categories: ['review'], status: 'ok' },
      ontology: { totalAssets: 1, activeAssets: 1, totalRules: 2 },
    });
    await worldModel.saveWorldModelSnapshot('user-a', snapshot);
    await expect(worldModel.readWorldModelSnapshot('user-a', snapshot.id)).resolves.toEqual(snapshot);
    await expect(worldModel.readWorldModelSnapshot('user-b', snapshot.id)).resolves.toBeNull();
  });
});
