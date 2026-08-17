import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let tmp: string; let previous: string | undefined;
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-proof-')); previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmp; });
afterEach(() => { if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });
async function modules() { const [candidates, refs, projection, proofs, assets] = await Promise.all([import('../../../../src/main/features/recall/candidate-service'), import('../../../../src/main/features/recall/workspace-refs'), import('../../../../src/main/features/recall/context-projection'), import('../../../../src/main/features/recall/proof-service'), import('../../../../src/main/features/recall/asset-service')]); return { candidates, refs, projection, proofs, assets }; }
async function confirmedProjection() { const { candidates, refs, projection } = await modules(); const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Record decision evidence.', suggestedType: 'rule', suggestedScope: 'review', spaceId: 'workspace-a', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] }); const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' }); await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' }); const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed' }); return { asset, projection: await projection.confirmContextProjection('user-a', preview.id) }; }

describe('Recall transfer and effectiveness proofs', () => {
  it('freezes expected assets, completes transfer, and advances maturity only after better effectiveness evidence', async () => {
    const { asset, projection } = await confirmedProjection(); const { proofs, assets } = await modules();
    const prepared = await proofs.prepareTransferProof('user-a', { projectionId: projection.id, executionId: 'exec-a', expectedResultSnapshot: 'Decision includes evidence and rationale.' });
    expect(prepared.status).toBe('prepared'); expect(prepared.assetVersions).toEqual([{ assetId: asset.id, version: '1' }]);
    const completed = await proofs.completeTransferProof('user-a', prepared.id, { status: 'succeeded', receiptId: 'receipt-a', observedTransfer: 'Evidence was injected.' });
    expect(completed.status).toBe('succeeded');
    const evaluation = await proofs.evaluateEffectivenessProof('user-a', { transferProofId: prepared.id, outcome: 'better', observedResult: 'Review quality improved.', evidenceRefs: [{ kind: 'artifact', id: 'artifact-a' }] });
    expect(evaluation.status).toBe('valid'); expect(evaluation.outcome).toBe('better');
    expect((await assets.readAbilityAsset('user-a', asset.id)).maturity).toBe('effectiveness_validated');
  });

  it('rejects effectiveness before successful transfer and yields an explicit governance recommendation for negative outcomes', async () => {
    const { projection } = await confirmedProjection(); const { proofs } = await modules();
    const prepared = await proofs.prepareTransferProof('user-a', { projectionId: projection.id, executionId: 'exec-a', expectedResultSnapshot: 'Expected result.' });
    await expect(proofs.evaluateEffectivenessProof('user-a', { transferProofId: prepared.id, outcome: 'better', observedResult: 'better', evidenceRefs: [] })).rejects.toThrow(/successful transfer/i);
    await proofs.completeTransferProof('user-a', prepared.id, { status: 'succeeded', observedTransfer: 'done' });
    const evaluation = await proofs.evaluateEffectivenessProof('user-a', { transferProofId: prepared.id, outcome: 'worse', observedResult: 'Regression observed.', evidenceRefs: [] });
    expect(evaluation.recommendedAction).toBe('pause');
  });
});
