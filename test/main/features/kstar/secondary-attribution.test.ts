import { describe, expect, it } from 'vitest';
import type { KstarEpisodeRecord, KstarReviewRecord } from '../../../../src/main/features/kstar/types';

function episode(overrides: Partial<KstarEpisodeRecord> = {}): KstarEpisodeRecord {
  return {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'kse-secondary-a',
    sessionId: 'gconv-secondary-a',
    taskRunId: 'run-secondary-a',
    projectionId: 'projection-a',
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: ['asset-a'] },
    s: { workspaceId: 'workspace-a' },
    t: { userGoal: 'Fix the login bug.', constraints: [] },
    a: { toolCalls: [{ name: 'read_file', status: 'ok' }], agentActions: [] },
    r: { status: 'completed', finalText: 'Done.', producedFiles: [] },
    evidenceRefs: [{ kind: 'execution', id: 'run-secondary-a' }],
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:01:00.000Z',
    ...overrides,
  };
}

function review(overrides: Partial<KstarReviewRecord> = {}): KstarReviewRecord {
  const current = episode();
  return {
    schemaVersion: 1,
    ownerId: current.ownerId,
    id: `ksr-${current.id}`,
    episodeId: current.id,
    deltaR: -0.5,
    deltaA: -0.2,
    outcome: 'worse_than_expected',
    attribution: 'execution_gap',
    reason: 'The task did not meet the expected result.',
    confidence: 0.9,
    evidenceRefs: current.evidenceRefs,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    ...overrides,
  };
}

describe('KSTAR secondary attribution', () => {
  it('validates evidence-bound details and blocks only excluded-only learning', async () => {
    const attribution = await import('../../../../src/main/features/kstar/secondary-attribution');
    const current = episode();
    const valid = [{
      category: 'permission_blocked',
      confidence: 1,
      evidenceRefs: current.evidenceRefs,
      source: 'deterministic',
    }] as const;

    expect(attribution.normalizeKstarAttributionDetails(valid, current.evidenceRefs)).toMatchObject(valid);
    expect(attribution.attributionAllowsReusableLearning(review({ attributionDetails: valid }))).toBe(false);
    expect(attribution.attributionAllowsReusableLearning(review({
      attributionDetails: [
        ...valid,
        {
          category: 'execution_error',
          confidence: 0.8,
          evidenceRefs: current.evidenceRefs,
          source: 'model',
        },
      ],
    }))).toBe(true);

    expect(() => attribution.normalizeKstarAttributionDetails([{
      ...valid[0], category: 'not_a_real_category',
    }], current.evidenceRefs)).toThrow(/category/);
    expect(() => attribution.normalizeKstarAttributionDetails([{
      ...valid[0], confidence: 2,
    }], current.evidenceRefs)).toThrow(/confidence/);
    expect(() => attribution.normalizeKstarAttributionDetails([{
      ...valid[0], evidenceRefs: [],
    }], current.evidenceRefs)).toThrow(/evidence/);
    expect(() => attribution.normalizeKstarAttributionDetails([{
      ...valid[0], evidenceRefs: [{ kind: 'execution', id: 'other-run' }],
    }], current.evidenceRefs)).toThrow(/evidence/);
  });

  it('prefers deterministic forecast, permission, and usage facts over prose', async () => {
    const attribution = await import('../../../../src/main/features/kstar/secondary-attribution');
    const current = episode({
      r: { status: 'failed', failureKind: 'permission', failureCode: 'permission_denied', producedFiles: [] },
    });
    const detail = attribution.deriveDeterministicAttributionDetails({
      episode: current,
      forecastStatus: 'failed',
      injectionReceipts: [{
        taskRunId: current.taskRunId,
        projectionId: current.projectionId,
        assetId: 'asset-a',
        assetVersion: '1',
        status: 'injected',
      }],
      usageReceipts: [{
        taskRunId: current.taskRunId,
        projectionId: current.projectionId,
        assetId: 'asset-a',
        assetVersion: '1',
        status: 'usage_unknown',
      }],
    });
    expect(detail).toMatchObject({
      category: 'forecast_error',
      source: 'deterministic',
      evidenceRefs: current.evidenceRefs,
    });

    const permissionDetail = attribution.deriveDeterministicAttributionDetails({
      episode: current,
      injectionReceipts: [],
      usageReceipts: [],
    });
    expect(permissionDetail?.category).toBe('permission_blocked');
  });

  it('uses insufficient_evidence when no stronger structured fact is available', async () => {
    const attribution = await import('../../../../src/main/features/kstar/secondary-attribution');
    const current = episode({ k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] } });
    expect(attribution.deriveDeterministicAttributionDetails({ episode: current })).toMatchObject({
      category: 'insufficient_evidence',
      confidence: expect.any(Number),
      evidenceRefs: current.evidenceRefs,
      source: 'deterministic',
    });
  });

  it('scopes deterministic receipt facts to authoritative reuse turn ids', async () => {
    const attribution = await import('../../../../src/main/features/kstar/secondary-attribution');
    const current = episode({
      taskRunId: 'aggregate-secondary-a',
      reuseTurnIds: ['turn-secondary-a'],
    });
    const detail = attribution.deriveDeterministicAttributionDetails({
      episode: current,
      injectionReceipts: [{
        schemaVersion: 1,
        ownerId: current.ownerId,
        id: 'injection-secondary-a',
        taskRunId: 'turn-secondary-a',
        projectionId: current.projectionId,
        assetId: 'asset-a',
        assetVersion: '1',
        boundary: 'real',
        status: 'injected',
        createdAt: current.createdAt,
      }],
      usageReceipts: [{
        schemaVersion: 1,
        ownerId: current.ownerId,
        id: 'usage-secondary-a',
        taskRunId: 'turn-secondary-a',
        projectionId: current.projectionId!,
        assetId: 'asset-a',
        assetVersion: '1',
        injectionReceiptId: 'injection-secondary-a',
        status: 'contradicted',
        evidenceRefs: current.evidenceRefs,
        evidenceKind: 'agent_action',
        boundary: 'real',
        createdAt: current.createdAt,
      }],
    });

    expect(detail?.category).toBe('asset_conflict');
  });

  it('requires every Usage relationship field to match an owned Injection', async () => {
    const attribution = await import('../../../../src/main/features/kstar/secondary-attribution');
    const current = episode({
      taskRunId: 'aggregate-secondary-relationship',
      reuseTurnIds: ['turn-secondary-relationship'],
    });
    const injection = {
      schemaVersion: 1 as const,
      ownerId: current.ownerId,
      id: 'injection-secondary-relationship',
      taskRunId: 'turn-secondary-relationship',
      projectionId: current.projectionId,
      assetId: 'asset-a',
      assetVersion: '1',
      boundary: 'real' as const,
      status: 'injected' as const,
      createdAt: current.createdAt,
    };
    const usage = {
      schemaVersion: 1 as const,
      ownerId: current.ownerId,
      id: 'usage-secondary-relationship',
      taskRunId: injection.taskRunId,
      projectionId: injection.projectionId!,
      assetId: injection.assetId,
      assetVersion: injection.assetVersion,
      injectionReceiptId: injection.id,
      status: 'contradicted' as const,
      evidenceRefs: current.evidenceRefs,
      evidenceKind: 'agent_action' as const,
      boundary: injection.boundary,
      createdAt: current.createdAt,
    };

    expect(attribution.deriveDeterministicAttributionDetails({
      episode: current,
      injectionReceipts: [injection],
      usageReceipts: [usage],
    })?.category).toBe('asset_conflict');

    for (const override of [
      { injectionReceiptId: 'injection-other' },
      { taskRunId: 'turn-other' },
      { projectionId: 'projection-other' },
      { assetId: 'asset-other' },
      { assetVersion: '2' },
      { boundary: 'degraded' as const },
    ]) {
      expect(attribution.deriveDeterministicAttributionDetails({
        episode: current,
        injectionReceipts: [injection],
        usageReceipts: [{ ...usage, ...override }],
      })?.category, JSON.stringify(override)).not.toBe('asset_conflict');
    }
  });

  it('does not fall back to the aggregate run id when an authoritative reuse turn list is present but empty', async () => {
    const attribution = await import('../../../../src/main/features/kstar/secondary-attribution');
    const current = episode({ taskRunId: 'aggregate-empty', reuseTurnIds: [] });

    expect(attribution.deriveDeterministicAttributionDetails({
      episode: current,
      injectionReceipts: [{
        schemaVersion: 1,
        ownerId: current.ownerId,
        id: 'injection-aggregate-empty',
        taskRunId: 'aggregate-empty',
        projectionId: current.projectionId,
        assetId: 'asset-a',
        assetVersion: '1',
        boundary: 'real',
        status: 'injected',
        createdAt: current.createdAt,
      }],
    })?.category).toBe('injection_failure');
  });

  it('classifies a terminal timeout as execution_error, not environment_failure', async () => {
    const attribution = await import('../../../../src/main/features/kstar/secondary-attribution');
    const current = episode({
      r: { status: 'timed_out', failureKind: 'runtime_error', failureCode: 'timed_out', producedFiles: [] },
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    });

    expect(attribution.deriveDeterministicAttributionDetails({ episode: current })?.category)
      .toBe('execution_error');
  });

  it('persists valid details and rejects a model citation outside the Episode evidence', async () => {
    const { saveKstarReview, readKstarReview } = await import('../../../../src/main/features/kstar/review-service');
    const { writeKstarEpisode } = await import('../../../../src/main/features/kstar/episode-store');
    const current = episode();
    await writeKstarEpisode('user-a', current);
    const saved = await saveKstarReview('user-a', current, {
      deltaR: -0.5,
      deltaA: -0.2,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'A structured permission gate stopped the operation.',
      confidence: 0.9,
      attributionDetails: [{
        category: 'permission_blocked',
        confidence: 1,
        evidenceRefs: current.evidenceRefs,
        source: 'model',
      }],
      evidenceRefs: current.evidenceRefs,
    });
    expect(saved.attributionDetails).toMatchObject([{
      category: 'permission_blocked', source: 'model',
    }]);
    expect((await readKstarReview('user-a', current.id))?.attributionDetails).toMatchObject([{
      category: 'permission_blocked',
    }]);

    await expect(saveKstarReview('user-a', current, {
      deltaR: -0.5,
      deltaA: -0.2,
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: 'The model cited an unavailable source.',
      confidence: 0.9,
      attributionDetails: [{
        category: 'execution_error',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'execution', id: 'not-in-episode' }],
        source: 'model',
      }],
      evidenceRefs: current.evidenceRefs,
    })).rejects.toThrow(/episode/);
  });

  it('enforces Episode evidence when saving a complete review record', async () => {
    const { createInitialKstarReview, saveKstarReviewRecord } = await import('../../../../src/main/features/kstar/review-service');
    const { writeKstarEpisode } = await import('../../../../src/main/features/kstar/episode-store');
    const current = episode();
    await writeKstarEpisode('user-a', current);
    const initial = createInitialKstarReview(current);

    await expect(saveKstarReviewRecord('user-a', {
      ...initial,
      attributionDetails: [{
        category: 'execution_error',
        confidence: 0.8,
        evidenceRefs: [{ kind: 'execution', id: 'not-in-episode' }],
        source: 'user',
      }],
      evidenceRefs: [
        ...current.evidenceRefs,
        { kind: 'execution', id: 'not-in-episode' },
      ],
    })).rejects.toThrow(/episode/);
  });
});
