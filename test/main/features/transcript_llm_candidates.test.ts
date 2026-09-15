import { describe, it, expect } from 'vitest';
import {
  buildCandidateRequest,
  generateCandidates,
  parseCandidateResponse,
  LLM_CANDIDATE_MIN_CONFIDENCE,
} from '../../../src/main/features/transcript_llm_candidates';

const suspects = [
  { text: 'roadmap', context: '这块是 roadmap 在跟', start: 100 },
  { text: 'coxyx', context: '用 coxyx 上课', start: 200 },
];
const allowed = ['Raymond', 'Cogseed', 'KSTAR'];

describe('受约束候选：白名单是硬边界', () => {
  it('白名单外的目标一律丢弃，并如实记录模型编了什么', () => {
    const raw = JSON.stringify([
      { wrong: 'roadmap', correct: 'Raymond', confidence: 0.9, reason: '上下文在讲人名' },
      { wrong: 'roadmap', correct: 'Rollout Plan', confidence: 0.95, reason: '编的' },
      { wrong: 'coxyx', correct: 'Cogseed', confidence: 0.4, reason: '形近' },
    ]);
    const { candidates, rejected } = parseCandidateResponse(raw, suspects, allowed);
    expect(candidates.map((c) => c.correct).sort()).toEqual(['Cogseed', 'Raymond']);
    expect(rejected).toEqual([{ wrong: 'roadmap', correct: 'Rollout Plan', why: 'not_in_allowlist' }]);
  });

  it('低置信标 pending（只能进待确认，不允许自动替换）', () => {
    const raw = JSON.stringify([
      { wrong: 'coxyx', correct: 'Cogseed', confidence: 0.3, reason: '形近' },
      { wrong: 'roadmap', correct: 'Raymond', confidence: 0.95, reason: '人名' },
    ]);
    const { candidates } = parseCandidateResponse(raw, suspects, allowed);
    expect(candidates.find((c) => c.wrong === 'coxyx')?.pending).toBe(true);
    expect(candidates.find((c) => c.wrong === 'roadmap')?.pending).toBe(false);
    expect(LLM_CANDIDATE_MIN_CONFIDENCE).toBeGreaterThan(0.3);
  });

  it('原文里没出现过的片段（模型幻觉的位置）丢弃', () => {
    const raw = JSON.stringify([{ wrong: '不存在的词', correct: 'Raymond', confidence: 0.9, reason: '' }]);
    const { candidates, rejected } = parseCandidateResponse(raw, suspects, allowed);
    expect(candidates).toEqual([]);
    expect(rejected[0].why).toBe('unknown_span');
  });

  it('模型输出被包在 ```json 里 / 夹带解释也能解析；纯废话返回空', () => {
    const wrapped = '```json\n[{"wrong":"roadmap","correct":"Raymond","confidence":0.8,"reason":"x"}]\n```';
    expect(parseCandidateResponse(wrapped, suspects, allowed).candidates).toHaveLength(1);
    expect(parseCandidateResponse('我不知道', suspects, allowed).candidates).toEqual([]);
    expect(parseCandidateResponse('[不是合法 json', suspects, allowed).candidates).toEqual([]);
  });

  it('同位置多条只留置信最高的', () => {
    const raw = JSON.stringify([
      { wrong: 'roadmap', correct: 'Raymond', confidence: 0.6, reason: 'a' },
      { wrong: 'roadmap', correct: 'Cogseed', confidence: 0.9, reason: 'b' },
    ]);
    const { candidates } = parseCandidateResponse(raw, suspects, allowed);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].correct).toBe('Cogseed');
  });
});

describe('请求构造与跳过条件', () => {
  it('提示词把白名单与上下文都写进去，并限制条数', () => {
    const request = buildCandidateRequest(suspects, allowed);
    expect(request.message).toContain('Raymond、Cogseed、KSTAR');
    expect(request.message).toContain('上下文：这块是 roadmap 在跟');
    expect(request.systemPrompt).toContain('绝对不要');
  });

  it('没有疑似专名 / 白名单为空 → 根本不发请求，并说明原因', async () => {
    expect(await generateCandidates('u', [], allowed, { runModel: async () => '[]' })).toMatchObject({ skipped: 'no_suspects' });
    expect(await generateCandidates('u', suspects, [], { runModel: async () => '[]' })).toMatchObject({ skipped: 'no_allowed' });
  });

  it('注入 runModel 时能跑通闭环', async () => {
    const result = await generateCandidates('u', suspects, allowed, {
      runModel: async () => JSON.stringify([{ wrong: 'roadmap', correct: 'Raymond', confidence: 0.85, reason: '人名' }]),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ wrong: 'roadmap', correct: 'Raymond', pending: false, start: 100 });
  });
});
