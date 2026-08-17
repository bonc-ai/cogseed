import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string; let previous: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['reviewing governed work'], forbiddenWhen: ['outside the review scope'] };
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-feedback-')); previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmp; });
afterEach(() => { if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });

async function modules() { const [candidates, refs, projection, proofs, feedback, assets] = await Promise.all([import('../../../../src/main/features/recall/candidate-service'), import('../../../../src/main/features/recall/workspace-refs'), import('../../../../src/main/features/recall/context-projection'), import('../../../../src/main/features/recall/proof-service'), import('../../../../src/main/features/recall/effectiveness-feedback'), import('../../../../src/main/features/recall/asset-service')]); return { candidates, refs, projection, proofs, feedback, assets }; }
async function successfulTransfer() { const { candidates, refs, projection, proofs } = await modules(); const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Record decision evidence.', suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'review', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] }); const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' }); await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' }); const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review' }); const confirmed = await projection.confirmContextProjection('user-a', preview.id); const prepared = await proofs.prepareTransferProof('user-a', { projectionId: confirmed.id, executionId: 'run-a', expectedResultSnapshot: 'Expected result.' }); const receipt = await realReceipt(asset.id, 'receipt-feedback-a'); await proofs.completeTransferProofWithReceipt('user-a', prepared.id, { status: 'succeeded', receiptExecutionId: receipt.executionId, observedTransfer: 'done' }); return { prepared, asset }; }
async function realReceipt(assetId: string, executionId: string) { const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt'); return receipts.prepareReceipt('user-a', { executionId, targetSessionId: `session-${executionId}`, reusedRefs: [`asset:${assetId}@v1`], omittedRefs: [], permissionMode: 'read-only', allowedScopes: ['cognition:inherited'], boundary: 'real' }, { sessionId: `session-${executionId}` }); }

async function successfulAttemptTransfer() {
  const { candidates, refs, projection, proofs } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Keep retry attempts on the same confirmed projection.', suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'review', sourceRefs: [{ kind: 'execution', id: 'exec-attempt' }] });
  const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
  await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection('user-a', { taskRunId: 'logical-task-a', workspaceId: 'workspace-a', purpose: 'review' });
  const confirmed = await projection.confirmContextProjection('user-a', preview.id);
  const prepared = await proofs.prepareTransferProof('user-a', { projectionId: confirmed.id, executionId: 'mate-attempt-a', expectedResultSnapshot: 'Expected result.' });
  const receipt = await realReceipt(asset.id, 'receipt-feedback-attempt');
  await proofs.completeTransferProofWithReceipt('user-a', prepared.id, { status: 'succeeded', receiptExecutionId: receipt.executionId, observedTransfer: 'done' });
  return prepared;
}

describe('Recall effectiveness feedback', () => {
  it('maps user feedback to effectiveness proof outcomes', async () => {
    const { prepared: transfer } = await successfulTransfer();
    const { feedback } = await modules();

    const positive = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: transfer.id, feedback: 'positive', note: 'This improved the result.' });
    expect(positive).toMatchObject({ outcome: 'insufficient_evidence', status: 'valid', observedResult: 'This improved the result.', evidenceRefs: [] });

    const negative = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: transfer.id, feedback: 'negative' });
    expect(negative).toMatchObject({ outcome: 'worse', recommendedAction: 'pause' });
  });

  it('accepts positive effectiveness only when traceable evidence is supplied', async () => {
    const { prepared: transfer, asset } = await successfulTransfer();
    const { feedback, assets } = await modules();

    const positive = await feedback.recordEffectivenessFeedback('user-a', {
      transferProofId: transfer.id,
      feedback: 'positive',
      note: 'This improved the result.',
      evidenceRefs: [{ kind: 'artifact', id: 'feedback-artifact-a' }],
    });

    expect(positive).toMatchObject({ outcome: 'better', status: 'valid' });
    expect((await assets.readAbilityAsset('user-a', asset.id)).maturity).toBe('effectiveness_validated');
  });

  it('records user feedback by taskRunId for successful transfer proofs', async () => {
    await successfulTransfer();
    const { feedback } = await modules();

    const result = await feedback.recordTaskEffectivenessFeedback('user-a', {
      taskRunId: 'run-a',
      feedback: 'positive',
      note: 'The task result was better because Recall guidance transferred.',
      evidenceRefs: [{ kind: 'execution', id: 'feedback-run-a' }],
    });

    expect(result.proofs).toHaveLength(1);
    expect(result.proofs[0]).toMatchObject({ outcome: 'better', status: 'valid' });
  });


  it('feeds negative and rework task feedback back into asset governance recommendations', async () => {
    const { asset } = await successfulTransfer();
    const { feedback, assets } = await modules();

    const result = await feedback.recordTaskEffectivenessFeedback('user-a', {
      taskRunId: 'run-a',
      feedback: 'rework',
      note: 'The reused rule needs rework before the next run.',
    });

    expect(result.proofs).toHaveLength(1);
    expect(result.proofs[0]).toMatchObject({ outcome: 'rework', recommendedAction: 'rework' });
    await expect(assets.readAbilityAsset('user-a', asset.id)).resolves.toMatchObject({
      recommendedAction: 'rework',
      recommendationReason: 'The reused rule needs rework before the next run.',
    });
    await expect(assets.listAbilityAssetAudit('user-a', asset.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'rework_recommended', actor: 'system', note: 'The reused rule needs rework before the next run.' }),
    ]));
  });

  it('groups retry attempt proofs by the confirmed projection logical taskRunId', async () => {
    await successfulAttemptTransfer();
    const { feedback } = await modules();

    const result = await feedback.recordTaskEffectivenessFeedback('user-a', {
      taskRunId: 'logical-task-a',
      feedback: 'positive',
    });

    expect(result.proofs).toHaveLength(1);
    expect(result.proofs[0]).toMatchObject({ outcome: 'insufficient_evidence', status: 'valid' });
  });

});
