import { describe, expect, it, vi } from 'vitest';

import { NoopJevClient } from '../../../../src/main/features/jev/adapter';
import type { JevClient, JevDecision } from '../../../../src/main/features/jev/types';
import {
  recordOntologyAnswerValidation,
  validateOntologyAnswer,
  type OntologyAnswerValidationInput,
} from '../../../../src/main/features/recall/ontology-answer-validation';
import type { OntologyAssetQueryResult } from '../../../../src/main/features/recall/ontology-asset-query';
import { appendRecallJsonlRecord } from '../../../../src/main/features/recall/store';

vi.mock('../../../../src/main/features/recall/store', () => ({
  appendRecallJsonlRecord: vi.fn(async (_userId, _collection, _stream, record) => record),
}));

function asset(id: string, title: string) {
  return {
    id,
    title,
    type: 'rule',
    scope: 'general',
    maturity: 'bud',
    version: '1',
    activeVersion: '1',
  };
}

function relationResult(distance = 1): Extract<OntologyAssetQueryResult, { status: 'ok' }> {
  const gateway = asset('aa-gateway', 'API 网关');
  const client = asset('aa-client', '调用客户端');
  const auth = asset('aa-auth', '认证服务');
  return {
    status: 'ok',
    intent: {
      target: gateway.title,
      relationKind: 'depends_on',
      direction: 'incoming',
      maxHops: Math.max(1, distance),
    },
    target: gateway,
    matches: [{
      asset: client,
      distance,
      evidencePath: distance === 1
        ? [{
          fromAssetId: client.id,
          fromTitle: client.title,
          kind: 'depends_on',
          toAssetId: gateway.id,
          toTitle: gateway.title,
        }]
        : [
          {
            fromAssetId: client.id,
            fromTitle: client.title,
            kind: 'depends_on',
            toAssetId: auth.id,
            toTitle: auth.title,
          },
          {
            fromAssetId: auth.id,
            fromTitle: auth.title,
            kind: 'depends_on',
            toAssetId: gateway.id,
            toTitle: gateway.title,
          },
        ],
    }],
    truncated: false,
  };
}

function input(overrides: Partial<OntologyAnswerValidationInput> = {}): OntologyAnswerValidationInput {
  return {
    query: '哪些资产依赖 API 网关',
    answer: '调用客户端依赖 API 网关。[asset:aa-client]',
    assets: [{
      assetId: 'aa-client',
      title: '调用客户端',
      version: '1',
      statement: '调用客户端通过认证服务访问 API 网关。',
    }],
    ...overrides,
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

describe('ontology answer validation', () => {
  it('returns insufficient when no asset body or ontology result was used', async () => {
    const result = await validateOntologyAnswer(input({ assets: [], relations: [] }));

    expect(result.status).toBe('insufficient');
    expect(result.answer).toContain('没有足够');
  });

  it('rejects an asset citation outside this turn evidence set', async () => {
    const result = await validateOntologyAnswer(input({
      answer: '未知资产可以复用。[asset:aa-unknown]',
    }));

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('证据集合之外');
    expect(result.answer).not.toContain('aa-unknown');
  });

  it('accepts a natural task answer without exposing asset IDs', async () => {
    const result = await validateOntologyAnswer(input({
      query: '帮我安排下周工作日晚餐',
      answer: '周末先确定菜单并集中备菜，工作日回家后只需加热主菜并快炒蔬菜。',
    }), { jev: new NoopJevClient('unconfigured') });

    expect(result.status).toBe('fallback');
    expect(result.checks).toMatchObject({ citationsPresent: false, citationsValid: true });
    expect(result.answer).toBe('周末先确定菜单并集中备菜，工作日回家后只需加热主菜并快炒蔬菜。');
    expect(result.answer).not.toContain('[asset:');
  });

  it('does not treat ordinary direct/indirect wording as ontology relation claims', async () => {
    const result = await validateOntologyAnswer(input({
      query: '帮我安排下周工作日晚餐',
      answer: '周末集中备菜，工作日直接加热主菜并快炒蔬菜；如果时间不够，就间接改用提前分装的替代项。',
    }), { jev: new NoopJevClient('unconfigured') });

    expect(result.checks.directnessConsistent).toBe(true);
    expect(result.answer).toContain('直接加热');
    expect(result.answer).toContain('间接改用');
  });

  it('rejects a direct claim supported only by a multi-hop path', async () => {
    const result = await validateOntologyAnswer(input({
      assets: [],
      relations: [{ query: '哪些资产依赖 API 网关', result: relationResult(2) }],
      answer: '调用客户端直接依赖 API 网关。[asset:aa-client]',
    }));

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('直接或间接');
    expect(result.answer).toContain('间接相关');
    expect(result.answer).not.toContain('aa-client');
  });

  it('rejects a relation claim whose direction reverses the evidence edge', async () => {
    const result = await validateOntologyAnswer(input({
      assets: [],
      relations: [{ query: '哪些资产依赖 API 网关', result: relationResult(1) }],
      answer: 'API 网关依赖调用客户端。[asset:aa-client]',
    }));

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('关系方向');
    expect(result.answer).toContain('直接相关：调用客户端');
    expect(result.answer).not.toContain('-depends_on->');
  });

  it('preserves a locally valid answer when Jev is unconfigured', async () => {
    const original = input();
    const result = await validateOntologyAnswer(original, {
      jev: new NoopJevClient('unconfigured'),
    });

    expect(result.status).toBe('fallback');
    expect(result.answer).toBe(original.answer);
    expect(result.jev).toEqual({ status: 'fallback', reason: 'unconfigured', attempts: 0 });
  });

  it('accepts only the finite draft candidate selected by Jev', async () => {
    const client = jev({ type: 'select', candidateIds: ['answer-draft'] });
    const original = input();
    const result = await validateOntologyAnswer(original, { jev: client });

    expect(result.status).toBe('validated');
    expect(result.answer).toBe(original.answer);
    expect(client.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      gate: 'result_validation',
      candidates: [expect.objectContaining({ id: 'answer-draft' })],
    }), expect.any(Object));
  });

  it.each([
    { type: 'none', reason: '证据不足' } as const,
    { type: 'score', scores: [{ candidateId: 'answer-draft', score: 0.2 }] } as const,
  ])('replaces the draft with a conservative answer for $type', async (decision) => {
    const original = input();
    const result = await validateOntologyAnswer(original, { jev: jev(decision), mode: 'enforce' });

    expect(result.status).toBe('rejected');
    expect(result.answer).not.toBe(original.answer);
    expect(result.answer).toContain('调用客户端');
    expect(result.answer).not.toContain('[asset:');
  });

  it('keeps Jev as an observation signal by default, including for relation queries', async () => {
    const original = input({
      assets: [],
      relations: [{ query: '哪些资产依赖 API 网关', result: relationResult(1) }],
      answer: '调用客户端依赖 API 网关。',
    });
    const result = await validateOntologyAnswer(original, {
      jev: jev({ type: 'none', reason: '需要人工复核' }),
    });

    expect(result.status).toBe('observed');
    expect(result.answer).toBe(original.answer);
    expect(result.reason).toContain('观察模式');
  });

  it('allows controlled enforcement only when explicitly requested', async () => {
    const original = input({
      assets: [],
      relations: [{ query: '哪些资产依赖 API 网关', result: relationResult(1) }],
      answer: '调用客户端依赖 API 网关。',
    });
    const result = await validateOntologyAnswer(original, {
      jev: jev({ type: 'none', reason: '需要人工复核' }),
      mode: 'enforce',
    });

    expect(result.status).toBe('rejected');
    expect(result.answer).not.toBe(original.answer);
  });

  it.each([
    { type: 'none', reason: '具体菜式不在资产正文中' } as const,
    { type: 'score', scores: [{ candidateId: 'answer-draft', score: 0.2 }] } as const,
  ])('keeps a completed natural-task answer when Jev returns $type', async (decision) => {
    const answer = '周一吃番茄炒蛋，周二吃香菇滑鸡，并按两次采购批次准备食材。';
    const result = await validateOntologyAnswer(input({
      query: '帮我安排下周工作日晚餐',
      answer,
    }), { jev: jev(decision) });

    expect(result.status).toBe('observed');
    expect(result.answer).toBe(answer);
    expect(result.reason).toContain('保留已生成结果');
  });

  it('marks a long answer as observed even when Jev accepts its bounded summary', async () => {
    const client = jev({ type: 'select', candidateIds: ['answer-draft'] });
    const answer = `开头约束：先确认预算。${'中间执行细节。'.repeat(400)}结尾约束：保留返程缓冲。`;
    const result = await validateOntologyAnswer(input({
      query: '安排一份可执行计划',
      answer,
    }), { jev: client });

    expect(result.status).toBe('observed');
    expect(result.checks.answerFullyCoveredByJev).toBe(false);
    expect(result.answer).toBe(answer);
    const request = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.candidates[0].summary).toContain('ANSWER_MIDDLE_OMITTED');
    expect(request.candidates[0].summary).toContain('开头约束');
    expect(request.candidates[0].summary).toContain('结尾约束');
  });

  it('classifies automatic projected relation evidence as hybrid', async () => {
    const client = jev({ type: 'select', candidateIds: ['answer-draft'] });
    await validateOntologyAnswer(input({
      query: '帮我安排周末行程',
      answer: '先确认预算并保留返程缓冲。',
      relations: [{
        query: '帮我安排周末行程',
        paths: [{
          entryAssetId: 'aa-plan', entryTitle: '行程方案',
          assetId: 'aa-budget', assetTitle: '预算边界', distance: 1,
          relationKind: 'depends_on', direction: 'incoming', maxHops: 1,
          evidencePath: [{
            fromAssetId: 'aa-budget', fromTitle: '预算边界', kind: 'depends_on',
            toAssetId: 'aa-plan', toTitle: '行程方案',
          }],
        }],
      }],
    }), { jev: client });

    expect(client.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({ source: 'hybrid' })],
    }), expect.any(Object));
  });

  it('treats an empty successful ontology result as negative query evidence', async () => {
    const emptyResult = { ...relationResult(1), matches: [] };
    const result = await validateOntologyAnswer(input({
      assets: [],
      relations: [{ query: '哪些资产依赖 API 网关', result: emptyResult }],
      answer: '当前未发现依赖 API 网关的资产。',
    }), { jev: new NoopJevClient('unconfigured') });

    expect(result.checks.evidenceAvailable).toBe(true);
    expect(result.answer).toBe('当前未发现依赖 API 网关的资产。');
  });

  it('persists only hashes, IDs and validation metadata in the receipt', async () => {
    const secretQuery = '私密问题内容';
    const secretAnswer = '私密完整回答 [asset:aa-client]';
    const secretStatement = '私密资产正文';
    const validationInput = input({
      query: secretQuery,
      answer: secretAnswer,
      assets: [{
        assetId: 'aa-client', title: '调用客户端', version: '7', statement: secretStatement,
      }],
    });
    const validationResult = await validateOntologyAnswer(validationInput, {
      jev: new NoopJevClient('unconfigured'),
    });
    const receipt = await recordOntologyAnswerValidation('receipt-user', validationInput, validationResult);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({
      ownerId: 'receipt-user', assetIds: ['aa-client'], jevStatus: 'fallback',
    });
    expect(serialized).not.toContain(secretQuery);
    expect(serialized).not.toContain(secretAnswer);
    expect(serialized).not.toContain(secretStatement);
    expect(appendRecallJsonlRecord).toHaveBeenCalledWith(
      'receipt-user', 'ontology-answer-validations', 'events', receipt,
    );
  });
});
