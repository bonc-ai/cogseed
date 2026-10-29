import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string; let previous: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['reviewing governed work'], forbiddenWhen: ['outside the review scope'] };
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-feedback-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmp; });
afterEach(() => { if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });

async function modules() { const [candidates, refs, projection, proofs, feedback, assets] = await Promise.all([import('../../../../src/main/features/recall/candidate-service'), import('../../../../src/main/features/recall/workspace-refs'), import('../../../../src/main/features/recall/context-projection'), import('../../../../src/main/features/recall/proof-service'), import('../../../../src/main/features/recall/effectiveness-feedback'), import('../../../../src/main/features/recall/asset-service')]); return { candidates, refs, projection, proofs, feedback, assets }; }
async function successfulTransfer() { const { candidates, refs, projection, proofs } = await modules(); const candidate = await createNightlyCandidateFixture('user-a', { judgment: 'Record decision evidence.', summary: 'Evidence record habit', suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'review', spaceId: 'workspace-a', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] }); const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' }); await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' }); const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review' }); const confirmed = await projection.confirmContextProjection('user-a', preview.id); const prepared = await proofs.prepareTransferProof('user-a', { projectionId: confirmed.id, executionId: 'run-a', expectedResultSnapshot: 'Expected result.' }); const receipt = await realReceipt(asset.id, 'receipt-feedback-a'); await proofs.completeTransferProofWithReceipt('user-a', prepared.id, { status: 'succeeded', receiptExecutionId: receipt.executionId, observedTransfer: 'done' }); return { prepared, asset }; }
async function realReceipt(assetId: string, executionId: string) { const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt'); return receipts.prepareReceipt('user-a', { executionId, targetSessionId: `session-${executionId}`, reusedRefs: [`asset:${assetId}@v1`], omittedRefs: [], permissionMode: 'read-only', allowedScopes: ['cognition:inherited'], boundary: 'real' }, { sessionId: `session-${executionId}` }); }

async function successfulAttemptTransfer() {
  const { candidates, refs, projection, proofs } = await modules();
  const candidate = await createNightlyCandidateFixture('user-a', { judgment: 'Keep retry attempts on the same confirmed projection.', summary: 'Retry attempts habit', suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'review', spaceId: 'workspace-a', sourceRefs: [{ kind: 'execution', id: 'exec-attempt' }] });

  const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
  await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection('user-a', { taskRunId: 'logical-task-a', workspaceId: 'workspace-a', purpose: 'review' });
  const confirmed = await projection.confirmContextProjection('user-a', preview.id);
  const prepared = await proofs.prepareTransferProof('user-a', { projectionId: confirmed.id, executionId: 'cogseed-attempt-a', expectedResultSnapshot: 'Expected result.' });
  const receipt = await realReceipt(asset.id, 'receipt-feedback-attempt');
  await proofs.completeTransferProofWithReceipt('user-a', prepared.id, { status: 'succeeded', receiptExecutionId: receipt.executionId, observedTransfer: 'done' });
  return prepared;
}

describe('Recall effectiveness feedback', () => {
  it('finds old task results after 1000 newer messages and does not let twenty missing transfers starve them', async () => {
    const { prepared: transfer, asset } = await successfulTransfer();
    const { feedback, candidates, proofs } = await modules();
    const store = await import('../../../../src/main/features/recall/store');
    const nightly = await import('../../../../src/main/features/recall/nightly-feedback');
    const candidate = await candidates.readRecallCandidate('user-a', asset.candidateId);
    const cid = candidate.sourceRefs.find(ref => ref.subtype === 'session')!.id;
    await store.updateRecallJsonRecord('user-a', 'projections', transfer.projectionId, current => ({ ...current!, conversationId: cid }));
    const proof = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: transfer.id, feedback: 'negative' });
    expect(proof.nightlyFeedback?.status).toBe('pending');
    const { conversationLayout } = await import('../../../../src/main/util/project-layout');
    const file = conversationLayout('user-a', cid, null).messageFile;
    fs.appendFileSync(file, [{ id: 'old-feedback-answer', from: 'commander', to: ['user'], ts: new Date().toISOString(), turn_id: 'task-a', text: 'Actual old task result.' },
      ...Array.from({ length: 1001 }, (_, i) => ({ id: `newer-${i}`, from: 'commander', to: ['user'], ts: new Date().toISOString(), text: 'Unrelated new result.' }))]
      .map(row => JSON.stringify(row) + '\n').join(''));
    const pending = vi.spyOn(proofs, 'listEffectivenessProofs').mockResolvedValue([
      ...Array.from({ length: 20 }, (_, i) => ({ ...proof, id: `missing-${i}`, transferProofId: `missing-transfer-${i}` })), proof,
    ]);
    await feedback.recoverNightlyEffectivenessFeedback('user-a');
    pending.mockRestore();
    expect(await nightly.queuedNightlyFeedback('user-a')).toEqual([expect.objectContaining({ messageId: 'old-feedback-answer', assetId: asset.id })]);
  });
  it('preserves persisted feedback on enqueue failure and recovers it once in the next nightly sweep', async () => {
    const { prepared: transfer, asset } = await successfulTransfer();
    const { feedback } = await modules();
    const store = await import('../../../../src/main/features/recall/store');
    const nightly = await import('../../../../src/main/features/recall/nightly-feedback');
    const candidate = await (await modules()).candidates.readRecallCandidate('user-a', asset.candidateId);
    const cid = candidate.sourceRefs.find(ref => ref.subtype === 'session')!.id;
    await store.updateRecallJsonRecord('user-a', 'projections', transfer.projectionId, current => ({ ...current!, conversationId: cid }));
    const { conversationLayout } = await import('../../../../src/main/util/project-layout');
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    await appendJsonlAtomic(conversationLayout('user-a', cid, null).messageFile, {
      id: 'feedback-result-message', ts: new Date().toISOString(), from: 'commander', to: ['user'], turn_id: 'task-a', text: 'Synthetic actual persisted result.' });
    const enqueue = vi.spyOn(nightly, 'queueNightlyFeedback').mockRejectedValueOnce(new Error('temporary write failure'));
    const proof = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: transfer.id, feedback: 'negative', note: 'The actual result missed evidence.' });
    expect(proof.nightlyFeedback?.status).toBe('pending');
    expect(await nightly.queuedNightlyFeedback('user-a')).toEqual([]);
    await feedback.recoverNightlyEffectivenessFeedback('user-a');
    expect(await nightly.queuedNightlyFeedback('user-a')).toEqual([expect.objectContaining({ conversationId: cid, messageId: 'feedback-result-message', assetId: asset.id, feedback: 'negative' })]);
    await feedback.recoverNightlyEffectivenessFeedback('user-a');
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect((await store.readRecallJsonRecord('user-a', 'effectiveness-proofs', proof.id))?.nightlyFeedback).toMatchObject({ status: 'queued' });
    await nightly.queueNightlyFeedback('user-a', { conversationId: cid, messageId: 'feedback-result-message', assetId: asset.id,
      assetVersion: asset.version, taskRunId: 'task-a', feedback: 'positive', note: 'Newer user feedback',
      observedAt: new Date(Date.parse(proof.createdAt) + 1_000).toISOString() });
    await store.updateRecallJsonRecord('user-a', 'effectiveness-proofs', proof.id, current => ({ ...current!, nightlyFeedback: { ...proof.nightlyFeedback!, status: 'pending' } }));
    await feedback.recoverNightlyEffectivenessFeedback('user-a');
    expect(await nightly.queuedNightlyFeedback('user-a')).toEqual([expect.objectContaining({ feedback: 'positive', note: 'Newer user feedback' })]);
  });
  it('maps user feedback to effectiveness proof outcomes', async () => {
    const { prepared: transfer } = await successfulTransfer();
    const { feedback } = await modules();

    const positive = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: transfer.id, feedback: 'positive', note: 'This improved the result.' });
    expect(positive).toMatchObject({ outcome: 'insufficient_evidence', status: 'valid', observedResult: 'This improved the result.', evidenceRefs: [] });

    const negative = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: transfer.id, feedback: 'negative' });
    expect(negative).toMatchObject({ outcome: 'worse', recommendedAction: 'pause' });
  });

  it('does not mistake a completed adopted result for an improvement without a baseline', async () => {
    const { prepared: transfer, asset } = await successfulTransfer();
    const { feedback, assets } = await modules();
    const before = await (await modules()).candidates.readRecallCandidate('user-a', asset.candidateId);

    const executions = await import('../../../../src/main/features/execution-records');
    await executions.create('user-a', { executionId: 'receipt-feedback-a', kind: 'core-agent', sessionId: 'session-effect', boundary: 'real', permissionMode: 'read-only' });
    await executions.complete('user-a', 'receipt-feedback-a', { status: 'completed', output: 'Decision includes the applied evidence and its result.' });

    const positive = await feedback.recordEffectivenessFeedback('user-a', {
      transferProofId: transfer.id,
      feedback: 'positive',
      note: 'This improved the result.',
      evidenceRefs: [{ kind: 'execution_evaluation', subtype: 'execution', taxonomyVersion: 2, id: 'receipt-feedback-a' }],
    });

    expect(positive).toMatchObject({ outcome: 'insufficient_evidence', status: 'valid' });
    expect((await assets.readAbilityAsset('user-a', asset.id)).maturity).toBe('transfer_validated');
    expect((await (await modules()).candidates.readRecallCandidate('user-a', asset.candidateId)).validationCount).toBe(before.validationCount);
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
    expect(result.proofs[0]).toMatchObject({ outcome: 'insufficient_evidence', status: 'valid' });
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
