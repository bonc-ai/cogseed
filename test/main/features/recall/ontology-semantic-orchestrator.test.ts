import { describe, expect, it } from 'vitest';

import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
import { queryOntologyAssets } from '../../../../src/main/features/recall/ontology-asset-query';
import { orchestrateOntologySemanticRecall } from '../../../../src/main/features/recall/ontology-semantic-orchestrator';

function asset(
  id: string,
  title: string,
  relations: RecallAbilityAssetRecord['relations'] = [],
): RecallAbilityAssetRecord {
  return {
    id,
    candidateId: `candidate-${id}`,
    reviewDecisionId: `decision-${id}`,
    type: 'rule',
    title,
    statement: `${title}正文不应进入统一候选`,
    evidenceRefs: [],
    relations,
    scope: 'general',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'bud',
    version: '1',
    activeVersion: '1',
    validationCount: 0,
    consecutiveFailures: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('ontology semantic orchestrator', () => {
  it('merges dual-route hits and preserves ontology evidence without content', () => {
    const gateway = asset('aa-gateway', 'API 网关');
    const auth = asset('aa-auth', '认证服务', [{ kind: 'depends_on', assetId: gateway.id }]);
    const ontology = queryOntologyAssets([gateway, auth], {
      query: '哪些资产依赖 API 网关',
    });
    const result = orchestrateOntologySemanticRecall({
      assets: [gateway, auth],
      ontologyQuery: ontology,
      semanticMatches: [{ assetId: auth.id, matchScore: 0.9 }],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      assetId: auth.id,
      source: 'semantic_ontology',
      semanticScore: 0.9,
      ontologyScore: 1,
      distance: 1,
      relationKind: 'depends_on',
      direction: 'incoming',
      maxHops: 1,
      evidencePath: [{ fromAssetId: auth.id, toAssetId: gateway.id }],
    });
    expect(result.candidates[0].asset).not.toHaveProperty('statement');
  });

  it('keeps single-route provenance separate', () => {
    const ontologyOnly = asset('aa-ontology', '本体命中');
    const semanticOnly = asset('aa-semantic', '语义命中');
    const result = orchestrateOntologySemanticRecall({
      assets: [ontologyOnly, semanticOnly],
      ontologyMatches: [{
        assetId: ontologyOnly.id,
        matchScore: 0.8,
        distance: 2,
        evidencePath: [],
      }],
      semanticMatches: [{ assetId: semanticOnly.id, matchScore: 0.85 }],
    });

    expect(result.candidates.map((candidate) => [candidate.assetId, candidate.source])).toEqual([
      [ontologyOnly.id, 'ontology'],
      [semanticOnly.id, 'semantic'],
    ]);
    expect(result.candidates[0]).toMatchObject({ distance: 2, ontologyScore: 0.8 });
    expect(result.candidates[0].semanticScore).toBeUndefined();
    expect(result.candidates[1].evidencePath).toBeUndefined();
  });

  it('deduplicates assets, filters out-of-catalog matches, and truncates deterministically', () => {
    const first = asset('aa-first', '第一条');
    const second = asset('aa-second', '第二条');
    const outside = asset('aa-outside', '目录外');
    const result = orchestrateOntologySemanticRecall({
      assets: [first, first, second],
      semanticMatches: [
        { assetId: outside.id, matchScore: 1 },
        { assetId: first.id, matchScore: 0.4 },
        { assetId: first.id, matchScore: 0.9 },
        { assetId: second.id, matchScore: 0.8 },
      ],
      limit: 1,
    });

    expect(result.candidates.map((candidate) => candidate.assetId)).toEqual([first.id]);
    expect(result.candidates[0].semanticScore).toBe(0.9);
    expect(result.truncated).toBe(true);
  });

  it('retains ontology candidates when semantic retrieval is degraded', () => {
    const ontologyOnly = asset('aa-ontology', '本体候选');
    const result = orchestrateOntologySemanticRecall({
      assets: [ontologyOnly],
      ontologyMatches: [{ assetId: ontologyOnly.id, matchScore: 0.7 }],
      semanticDegraded: true,
    });

    expect(result.candidates.map((candidate) => candidate.assetId)).toEqual([ontologyOnly.id]);
    expect(result.degraded).toEqual({ semantic: true, ontology: false });
  });
});

