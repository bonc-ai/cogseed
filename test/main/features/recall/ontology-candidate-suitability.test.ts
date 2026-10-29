import { describe, expect, it, vi } from 'vitest';

import { NoopJevClient } from '../../../../src/main/features/jev/adapter';
import type { JevClient, JevDecision } from '../../../../src/main/features/jev/types';
import { assessOntologyCandidateSuitability } from '../../../../src/main/features/recall/ontology-candidate-suitability';
import type { UnifiedRecallCandidate } from '../../../../src/main/features/recall/ontology-semantic-orchestrator';

function candidate(
  id: string,
  score: number,
  source: UnifiedRecallCandidate['source'] = 'semantic',
): UnifiedRecallCandidate {
  return {
    asset: {
      id,
      title: `候选 ${id}`,
      type: 'rule',
      scope: 'general',
      maturity: 'bud',
      version: '1',
      activeVersion: '1',
    },
    assetId: id,
    matchScore: score,
    source,
    ...(source !== 'ontology' ? { semanticScore: score } : {}),
    ...(source !== 'semantic' ? { ontologyScore: score } : {}),
  };
}

function jev(decision: JevDecision): JevClient {
  return {
    evaluate: vi.fn().mockImplementation(async (request) => ({
      status: 'ok',
      attempts: 1,
      response: {
        protocolVersion: 1,
        requestId: request.requestId,
        questionId: request.question.id,
        decision,
      },
    })),
  };
}

describe('ontology candidate suitability', () => {
  it('preserves deterministic candidates when Jev is unavailable', async () => {
    const candidates = [candidate('aa-first', 0.9), candidate('aa-second', 0.8)];
    const result = await assessOntologyCandidateSuitability(
      { query: '查找可复用资产', candidates },
      { jev: new NoopJevClient('unconfigured') },
    );

    expect(result.status).toBe('fallback');
    expect(result.candidates.map((item) => item.assetId)).toEqual(['aa-first', 'aa-second']);
    expect(result.jev).toEqual({ status: 'fallback', reason: 'unconfigured', attempts: 0 });
  });

  it('sends metadata-only candidates and applies the selected subset order', async () => {
    const first = candidate('aa-first', 0.9, 'semantic_ontology');
    const second = candidate('aa-second', 0.8, 'ontology');
    second.relationKind = 'depends_on';
    second.direction = 'incoming';
    second.distance = 1;
    second.evidencePath = [{
      fromAssetId: second.assetId,
      fromTitle: second.asset.title,
      kind: 'depends_on',
      toAssetId: 'aa-target',
      toTitle: '目标资产',
    }];
    const client = jev({ type: 'select', candidateIds: [second.assetId, first.assetId] });
    const result = await assessOntologyCandidateSuitability(
      { query: '哪些资产适合复用', candidates: [first, second], requestId: 'candidate-request' },
      { jev: client },
    );

    expect(result.status).toBe('selected');
    expect(result.candidates.map((item) => item.assetId)).toEqual([second.assetId, first.assetId]);
    expect(client.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      gate: 'candidate_suitability',
      candidates: [
        expect.objectContaining({ id: first.assetId, source: 'hybrid' }),
        expect.objectContaining({
          id: second.assetId,
          source: 'ontology',
          evidence: [expect.stringContaining('depends_on')],
        }),
      ],
    }), expect.any(Object));
    expect(JSON.stringify((client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain('正文');
  });

  it('sorts scored candidates and removes scores below the conservative threshold', async () => {
    const first = candidate('aa-first', 0.9);
    const second = candidate('aa-second', 0.8);
    const third = candidate('aa-third', 0.7);
    const result = await assessOntologyCandidateSuitability(
      { query: '查找适用资产', candidates: [first, second, third] },
      {
        jev: jev({
          type: 'score',
          scores: [
            { candidateId: first.assetId, score: 0.6 },
            { candidateId: second.assetId, score: 0.95 },
            { candidateId: third.assetId, score: 0.2 },
          ],
        }),
        minimumScore: 0.5,
      },
    );

    expect(result.status).toBe('selected');
    expect(result.candidates.map((item) => [item.assetId, item.suitabilityScore])).toEqual([
      [second.assetId, 0.95],
      [first.assetId, 0.6],
    ]);
  });

  it('does not replace an explicit none decision with deterministic candidates', async () => {
    const result = await assessOntologyCandidateSuitability(
      { query: '查找适用资产', candidates: [candidate('aa-first', 0.9)] },
      { jev: jev({ type: 'none', reason: '没有候选符合任务条件' }) },
    );

    expect(result).toMatchObject({ status: 'none', candidates: [], reason: '没有候选符合任务条件' });
  });

  it('does not inject candidates when Jev requires clarification', async () => {
    const result = await assessOntologyCandidateSuitability(
      { query: '查找适用资产', candidates: [candidate('aa-first', 0.9)] },
      { jev: jev({ type: 'clarify', question: '请说明具体使用场景' }) },
    );

    expect(result).toMatchObject({ status: 'clarify', candidates: [], reason: '请说明具体使用场景' });
  });

  it('cannot restore an ID outside the finite local candidate set', async () => {
    const result = await assessOntologyCandidateSuitability(
      { query: '查找适用资产', candidates: [candidate('aa-visible', 0.9)] },
      { jev: jev({ type: 'select', candidateIds: ['aa-filtered'] }) },
    );

    expect(result).toMatchObject({ status: 'none', candidates: [] });
  });
});

