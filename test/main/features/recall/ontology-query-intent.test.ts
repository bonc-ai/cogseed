import { describe, expect, it, vi } from 'vitest';

import { NoopJevClient } from '../../../../src/main/features/jev/adapter';
import {
  buildOntologyQueryIntentCandidates,
  resolveOntologyQueryIntent,
  type OntologyQueryIntentInput,
} from '../../../../src/main/features/recall/ontology-query-intent';
import type { OntologyGraphSnapshot } from '../../../../src/main/features/ontology_graph';
import type { JevClient } from '../../../../src/main/features/jev/types';

const graph: OntologyGraphSnapshot = {
  schemaVersion: 1,
  categories: [],
  entities: [
    {
      id: 'entity-xiaoming',
      domain: 'resources',
      categoryId: 'builtin_resource_person',
      name: '小明',
      description: '项目成员',
      properties: { role: '开发工程师' },
      sourceRefs: [],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'entity-api-gateway',
      domain: 'resources',
      categoryId: 'builtin_resource_product',
      name: 'API 网关',
      description: '统一服务入口',
      properties: {},
      sourceRefs: [],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  relations: [],
};

function request(overrides: Partial<OntologyQueryIntentInput> = {}): OntologyQueryIntentInput {
  return { query: '哪些资产依赖 API 网关', ...overrides };
}

describe('ontology query intent planning', () => {
  it('keeps relation direction and direct/indirect scope in the candidate', () => {
    const [candidate] = buildOntologyQueryIntentCandidates(
      request({ query: '哪些资产间接依赖 API 网关' }),
      graph,
    );

    expect(candidate).toMatchObject({
      route: 'ontology',
      targetText: 'API 网关',
      targetEntityId: 'entity-api-gateway',
      relationKind: 'depends_on',
      direction: 'incoming',
      relationScope: 'indirect',
      maxHops: 2,
      targetSource: 'graph',
    });
  });

  it('turns a unique user-ontology mention into an ontology candidate', () => {
    const [candidate] = buildOntologyQueryIntentCandidates({ query: '小明的爸爸是谁' }, graph);

    expect(candidate).toMatchObject({
      route: 'ontology',
      targetText: '小明',
      targetEntityId: 'entity-xiaoming',
      relationText: '爸爸',
      targetSource: 'graph',
    });
  });

  it('does not silently choose when two active entities have the same name', async () => {
    const ambiguousGraph: OntologyGraphSnapshot = {
      ...graph,
      entities: [
        graph.entities[0],
        { ...graph.entities[0], id: 'entity-xiaoming-2' },
      ],
    };
    const result = await resolveOntologyQueryIntent({ query: '小明是谁' }, { graph: ambiguousGraph });

    expect(result.status).toBe('clarify');
    expect(result.selected).toBeUndefined();
    expect(result.candidates.map((candidate) => candidate.targetEntityId)).toEqual([
      'entity-xiaoming',
      'entity-xiaoming-2',
    ]);
  });

  it('preserves asset-title compatibility when no user graph is available', async () => {
    const result = await resolveOntologyQueryIntent({ query: '哪些资产依赖 API 网关' });

    expect(result.status).toBe('selected');
    expect(result.selected).toMatchObject({
      route: 'ontology',
      targetText: 'API 网关',
      targetSource: 'unresolved',
      relationKind: 'depends_on',
    });
  });

  it('uses deterministic selection when Jev is unavailable', async () => {
    const result = await resolveOntologyQueryIntent(request(), {
      graph,
      jev: new NoopJevClient('unconfigured'),
    });

    expect(result.status).toBe('fallback');
    expect(result.selected?.targetEntityId).toBe('entity-api-gateway');
    expect(result.jev).toEqual({ status: 'fallback', reason: 'unconfigured', attempts: 0 });
  });

  it('accepts only a Jev-selected candidate from the local candidate set', async () => {
    const jev: JevClient = {
      evaluate: vi.fn().mockResolvedValue({
        status: 'ok',
        attempts: 1,
        response: {
          protocolVersion: 1,
          requestId: 'intent-request',
          questionId: 'ontology-query-intent-v1',
          decision: { type: 'select', candidateIds: ['intent-ontology-entity-api-gateway'] },
        },
      }),
    };
    const result = await resolveOntologyQueryIntent(request(), {
      graph,
      jev,
      requestId: 'intent-request',
    });

    expect(result.status).toBe('selected');
    expect(result.selected?.targetEntityId).toBe('entity-api-gateway');
    expect(jev.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      gate: 'intent',
      candidates: [expect.objectContaining({ id: 'intent-ontology-entity-api-gateway' })],
    }), expect.any(Object));
  });

  it('lets Jev choose only among finite automatic recall plans', async () => {
    const candidates = buildOntologyQueryIntentCandidates({
      query: '下周聚餐怎么安排更稳妥',
      target: 'aa-entry',
      candidatePlans: [
        { route: 'semantic', direction: 'both', relationScope: 'direct', maxHops: 1 },
        { route: 'hybrid', relationKind: 'depends_on', direction: 'incoming', relationScope: 'direct', maxHops: 1 },
      ],
    });
    const client: JevClient = {
      evaluate: vi.fn().mockResolvedValue({
        status: 'ok', attempts: 1, response: {
          protocolVersion: 1,
          requestId: 'automatic-intent',
          questionId: 'ontology-query-intent-v1',
          decision: { type: 'select', candidateIds: [candidates[1].id] },
        },
      }),
    };

    const result = await resolveOntologyQueryIntent({
      query: '下周聚餐怎么安排更稳妥',
      target: 'aa-entry',
      candidatePlans: [
        { route: 'semantic', direction: 'both', relationScope: 'direct', maxHops: 1 },
        { route: 'hybrid', relationKind: 'depends_on', direction: 'incoming', relationScope: 'direct', maxHops: 1 },
      ],
    }, { jev: client, requestId: 'automatic-intent' });

    expect(result.selected).toMatchObject({
      route: 'hybrid', relationKind: 'depends_on', direction: 'incoming', maxHops: 1,
    });
    expect(client.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      candidates: candidates.map((candidate) => expect.objectContaining({ id: candidate.id })),
    }), expect.any(Object));
  });

  it('returns a clarification when Jev asks for one', async () => {
    const jev: JevClient = {
      evaluate: vi.fn().mockResolvedValue({
        status: 'ok',
        attempts: 1,
        response: {
          protocolVersion: 1,
          requestId: 'intent-request',
          questionId: 'ontology-query-intent-v1',
          decision: { type: 'clarify', question: '你要查询直接依赖还是间接依赖？' },
        },
      }),
    };
    const result = await resolveOntologyQueryIntent(request(), {
      graph,
      jev,
      requestId: 'intent-request',
    });

    expect(result.status).toBe('clarify');
    expect(result.reason).toBe('你要查询直接依赖还是间接依赖？');
    expect(result.selected).toBeUndefined();
  });
});
