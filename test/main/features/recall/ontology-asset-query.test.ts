import { describe, expect, it } from 'vitest';

import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
import {
  parseOntologyAssetQuery,
  queryOntologyAssets,
} from '../../../../src/main/features/recall/ontology-asset-query';

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
    statement: `${title}的正文`,
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

describe('ontology asset query', () => {
  it('parses incoming and outgoing dependency questions', () => {
    expect(parseOntologyAssetQuery({ query: '哪些资产依赖 本体查询示例：API 网关' })).toMatchObject({
      target: '本体查询示例：API 网关', relationKind: 'depends_on', direction: 'incoming', maxHops: 1,
    });
    expect(parseOntologyAssetQuery({ query: '认证服务依赖哪些资产' })).toMatchObject({
      target: '认证服务', relationKind: 'depends_on', direction: 'outgoing', maxHops: 1,
    });
  });

  it('returns direct and bounded multi-hop matches with evidence paths', () => {
    const gateway = asset('aa-gateway', 'API 网关');
    const auth = asset('aa-auth', '认证服务', [{ kind: 'depends_on', assetId: gateway.id }]);
    const client = asset('aa-client', '调用客户端', [{ kind: 'depends_on', assetId: auth.id }]);
    const result = queryOntologyAssets([gateway, auth, client], {
      query: '哪些资产依赖 API 网关',
      maxHops: 2,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.matches.map((match) => [match.asset.id, match.distance])).toEqual([
      ['aa-auth', 1],
      ['aa-client', 2],
    ]);
    expect(result.matches[1].evidencePath.map((edge) => `${edge.fromAssetId}:${edge.kind}:${edge.toAssetId}`)).toEqual([
      'aa-client:depends_on:aa-auth',
      'aa-auth:depends_on:aa-gateway',
    ]);
  });

  it('does not traverse relations to assets outside the supplied governed catalog', () => {
    const gateway = asset('aa-gateway', 'API 网关');
    const visible = asset('aa-visible', '可用认证服务', [{ kind: 'depends_on', assetId: gateway.id }]);
    const hidden = asset('aa-hidden', '不可用认证服务', [{ kind: 'depends_on', assetId: gateway.id }]);
    const result = queryOntologyAssets([gateway, visible], {
      query: '哪些资产依赖 API 网关',
      maxHops: 2,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.matches.map((match) => match.asset.id)).toEqual(['aa-visible']);
    expect(JSON.stringify(result)).not.toContain(hidden.id);
  });

  it('honors the automatic expansion relation allow-list', () => {
    const entry = asset('aa-entry', '入口资产', [
      { kind: 'depends_on', assetId: 'aa-dependency' },
      { kind: 'conflicts_with', assetId: 'aa-conflict' },
      { kind: 'replaces', assetId: 'aa-replacement' },
    ]);
    const result = queryOntologyAssets([
      entry,
      asset('aa-dependency', '依赖资产'),
      asset('aa-conflict', '冲突资产'),
      asset('aa-replacement', '替代资产'),
    ], {
      query: entry.id,
      target: entry.id,
      direction: 'both',
      maxHops: 2,
      relationKinds: ['depends_on', 'refines', 'related_to', 'same_family'],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.matches.map((match) => match.asset.id)).toEqual(['aa-dependency']);
  });

  it('reports ambiguous targets instead of choosing one silently', () => {
    const result = queryOntologyAssets([
      asset('aa-a', 'API 网关 A'),
      asset('aa-b', 'API 网关 B'),
    ], { query: '哪些资产依赖 API 网关' });

    expect(result.status).toBe('target_ambiguous');
    if (result.status !== 'target_ambiguous') return;
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['aa-a', 'aa-b']);
  });
});
