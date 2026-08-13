import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-timeline-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(() => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, projection, proofs, timeline] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/proof-service'),
    import('../../../../src/main/features/recall/timeline-service'),
  ]);
  return { candidates, assets, projection, proofs, timeline };
}

async function promoteAsset(userId: string, statement: string, scope = 'review') {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment: statement,
    suggestedType: 'rule',
    suggestedScope: scope,
    sourceRefs: [{ kind: 'memory', id: `mem-${scope}` }],
  });
  return (await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' })).asset;
}

describe('Recall asset proof timeline', () => {
  it('aggregates one asset lifecycle, usage, transfer, and effectiveness evidence in reverse time order', async () => {
    const { assets, projection, proofs, timeline } = await modules();

    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    const asset = await promoteAsset('user-a', 'Always include decision evidence.', 'review');

    vi.setSystemTime(new Date('2026-08-06T00:01:00.000Z'));
    await assets.updateAbilityAsset('user-a', asset.id, { statement: 'Always include decision evidence and rationale.', reason: 'Refine the reused statement.', actor: 'user' });

    vi.setSystemTime(new Date('2026-08-06T00:02:00.000Z'));
    await assets.pauseAbilityAsset('user-a', asset.id, { actor: 'user', reason: 'needs verification' });

    vi.setSystemTime(new Date('2026-08-06T00:03:00.000Z'));
    await assets.resumeAbilityAsset('user-a', asset.id, { actor: 'user', reason: 'verification complete' });

    vi.setSystemTime(new Date('2026-08-06T00:04:00.000Z'));
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', purpose: 'review', authorization: 'user_confirmed' });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    const prepared = await proofs.prepareTransferProof('user-a', { projectionId: confirmed.id, executionId: 'exec-a', expectedResultSnapshot: 'Decision includes evidence.' });

    vi.setSystemTime(new Date('2026-08-06T00:05:00.000Z'));
    await proofs.completeTransferProof('user-a', prepared.id, { status: 'succeeded', receiptId: 'receipt-a', observedTransfer: 'Evidence guidance was applied.' });

    vi.setSystemTime(new Date('2026-08-06T00:06:00.000Z'));
    await proofs.evaluateEffectivenessProof('user-a', { transferProofId: prepared.id, outcome: 'better', observedResult: 'Review quality improved.', evidenceRefs: [{ kind: 'artifact', id: 'artifact-a' }] });

    const items = await timeline.listAbilityAssetTimeline('user-a', asset.id);
    expect(items.map((item) => item.kind)).toEqual([
      'effectiveness_recorded',
      'transfer_completed',
      'usage_recorded',
      'projection_confirmed',
      'transfer_prepared',
      'asset_resumed',
      'asset_paused',
      'asset_updated',
      'asset_version',
      'asset_created',
      'asset_version',
    ]);
    expect(items.every((item) => item.refs?.assetId === asset.id)).toBe(true);
    expect(items.find((item) => item.kind === 'projection_confirmed')).toMatchObject({ refs: { projectionId: confirmed.id, taskRunId: 'task-a' } });
    expect(items.find((item) => item.kind === 'transfer_prepared')).toMatchObject({ refs: { projectionId: confirmed.id, taskRunId: 'task-a', transferProofId: prepared.id } });
    expect(items.find((item) => item.kind === 'transfer_completed')).toMatchObject({ status: 'succeeded', refs: { usageReceiptId: 'receipt-a' } });
    expect(items.find((item) => item.kind === 'effectiveness_recorded')).toMatchObject({ status: 'valid', refs: { transferProofId: prepared.id } });
    expect(items.map((item) => item.occurredAt)).toEqual([...items.map((item) => item.occurredAt)].sort().reverse());
  });

  it('excludes transfer and effectiveness proofs for unrelated assets', async () => {
    const { projection, proofs, timeline } = await modules();
    const target = await promoteAsset('user-a', 'Review target guidance.', 'review');
    const unrelated = await promoteAsset('user-a', 'Research-only guidance.', 'research');

    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-research', purpose: 'research', authorization: 'user_confirmed' });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    expect(confirmed.assetIds).toEqual([unrelated.id]);
    const prepared = await proofs.prepareTransferProof('user-a', { projectionId: confirmed.id, executionId: 'exec-research', expectedResultSnapshot: 'Research result.' });
    await proofs.completeTransferProof('user-a', prepared.id, { status: 'succeeded', observedTransfer: 'Research guidance applied.' });
    await proofs.evaluateEffectivenessProof('user-a', { transferProofId: prepared.id, outcome: 'better', observedResult: 'Research improved.', evidenceRefs: [] });

    const items = await timeline.listAbilityAssetTimeline('user-a', target.id);
    expect(items.map((item) => item.kind)).toEqual(['asset_created', 'asset_version']);
    expect(items.some((item) => item.refs?.projectionId === confirmed.id)).toBe(false);
  });

  it('reports Evidence-driven maturity downgrade without presenting it as asset revocation', async () => {
    const { assets, timeline } = await modules();
    const asset = await promoteAsset('user-a', 'Keep source-backed guidance.', 'review');
    await assets.setAbilityAssetMaturity('user-a', asset.id, 'transfer_validated');

    await assets.downgradeAbilityAssetMaturityForRevokedEvidence('user-a', asset.id, {
      kind: 'memory',
      id: 'mem-review',
    });

    const items = await timeline.listAbilityAssetTimeline('user-a', asset.id);
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'asset_maturity_downgraded',
      title: 'Asset maturity downgraded',
      summary: 'evidence_revoked:memory:mem-review',
    }));
    expect(items.filter((item) => item.kind === 'asset_revoked')).toEqual([]);
  });
});
