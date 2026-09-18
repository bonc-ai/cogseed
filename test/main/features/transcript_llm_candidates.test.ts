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
const known = ['SpeakerA', 'Cogseed', 'KSTAR'];

describe('已知写法是优先参考，不是硬边界', () => {
  it('名单外的写法保留并标注（放开白名单后模型可以有自己的判断）', () => {
    const raw = JSON.stringify([
      { wrong: 'roadmap', correct: 'SpeakerA', confidence: 0.9, reason: '上下文在讲人名' },
      { wrong: 'roadmap', correct: 'Rollout Plan', confidence: 0.95, reason: '词表里没有但更像原文' },
      { wrong: 'coxyx', correct: 'Cogseed', confidence: 0.4, reason: '形近' },
    ]);
    const { candidates, rejected, outsideAllowlist } = parseCandidateResponse(raw, suspects, known);
    // 同位置只留置信最高的一条 ⇒ Rollout Plan 胜出，且如实标注它不在名单里。
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ correct: 'Rollout Plan', inAllowlist: false });
    expect(candidates.find((c) => c.wrong === 'coxyx')).toMatchObject({ inAllowlist: true });
    expect(outsideAllowlist).toBe(1);
    // 名单外不再算"被丢弃"：丢弃只留给定位不到的位置。
    expect(rejected).toEqual([]);
  });

  it('名单为空时依然可以产出候选（这正是最需要模型看一眼的情况）', () => {
    const raw = JSON.stringify([{ wrong: 'roadmap', correct: '某位老师', confidence: 0.8, reason: '读音' }]);
    const { candidates, outsideAllowlist } = parseCandidateResponse(raw, suspects, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ correct: '某位老师', inAllowlist: false });
    expect(outsideAllowlist).toBe(1);
  });

  it('低置信标 pending（只能进待确认，不允许自动替换）', () => {
    const raw = JSON.stringify([
      { wrong: 'coxyx', correct: 'Cogseed', confidence: 0.3, reason: '形近' },
      { wrong: 'roadmap', correct: 'SpeakerA', confidence: 0.95, reason: '人名' },
    ]);
    const { candidates } = parseCandidateResponse(raw, suspects, known);
    expect(candidates.find((c) => c.wrong === 'coxyx')?.pending).toBe(true);
    expect(candidates.find((c) => c.wrong === 'roadmap')?.pending).toBe(false);
    expect(LLM_CANDIDATE_MIN_CONFIDENCE).toBeGreaterThan(0.3);
  });

  it('原文里没出现过的片段（模型幻觉的位置）丢弃 —— 定位不了就标不上待核', () => {
    const raw = JSON.stringify([{ wrong: '不存在的词', correct: 'SpeakerA', confidence: 0.9, reason: '' }]);
    const { candidates, rejected } = parseCandidateResponse(raw, suspects, known);
    expect(candidates).toEqual([]);
    expect(rejected[0].why).toBe('unknown_span');
  });

  it('目标与错形相同的自相矛盾项丢弃', () => {
    const raw = JSON.stringify([{ wrong: 'roadmap', correct: 'roadmap', confidence: 0.9, reason: '' }]);
    const { candidates, rejected } = parseCandidateResponse(raw, suspects, known);
    expect(candidates).toEqual([]);
    expect(rejected[0].why).toBe('identical_pair');
  });

  it('模型输出被包在 ```json 里 / 夹带解释也能解析；纯废话返回空', () => {
    const wrapped = '```json\n[{"wrong":"roadmap","correct":"SpeakerA","confidence":0.8,"reason":"x"}]\n```';
    expect(parseCandidateResponse(wrapped, suspects, known).candidates).toHaveLength(1);
    expect(parseCandidateResponse('我不知道', suspects, known).candidates).toEqual([]);
    expect(parseCandidateResponse('[不是合法 json', suspects, known).candidates).toEqual([]);
  });

  it('同位置多条只留置信最高的', () => {
    const raw = JSON.stringify([
      { wrong: 'roadmap', correct: 'SpeakerA', confidence: 0.6, reason: 'a' },
      { wrong: 'roadmap', correct: 'Cogseed', confidence: 0.9, reason: 'b' },
    ]);
    const { candidates } = parseCandidateResponse(raw, suspects, known);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].correct).toBe('Cogseed');
  });
});

describe('请求构造与跳过条件', () => {
  it('提示词把已知写法与上下文都写进去，并限制条数', () => {
    const request = buildCandidateRequest(suspects, known);
    expect(request.message).toContain('SpeakerA、Cogseed、KSTAR');
    expect(request.message).toContain('上下文：这块是 roadmap 在跟');
    // 提示词必须说清"产出只是候选"，否则模型会以为自己在下结论。
    expect(request.systemPrompt).toContain('给人复核的候选');
    expect(request.systemPrompt).toContain('已知写法');
  });

  it('已知写法为空时提示词如实说明"依据上下文判断"，不假装有名单', () => {
    const request = buildCandidateRequest(suspects, []);
    expect(request.message).toContain('（无；请完全依据上下文判断）');
  });

  it('没有疑似专名 → 根本不发请求；名单为空不再阻止发请求', async () => {
    expect(await generateCandidates('u', [], known, { runModel: async () => '[]' })).toMatchObject({ skipped: 'no_suspects' });
    const emptyAllowed = await generateCandidates('u', suspects, [], {
      runModel: async () => JSON.stringify([{ wrong: 'roadmap', correct: '某位老师', confidence: 0.9, reason: '读音' }]),
    });
    expect(emptyAllowed.skipped).toBeUndefined();
    expect(emptyAllowed.candidates).toHaveLength(1);
  });

  it('模型不可用时如实报 no_model，不假装问过', async () => {
    const result = await generateCandidates('u', suspects, known, {
      runModel: async () => { throw new Error('boom'); },
    });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toBe('model_failed');
  });

  it('注入 runModel 时能跑通闭环', async () => {
    const result = await generateCandidates('u', suspects, known, {
      runModel: async () => JSON.stringify([{ wrong: 'roadmap', correct: 'SpeakerA', confidence: 0.85, reason: '人名' }]),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      wrong: 'roadmap', correct: 'SpeakerA', pending: false, start: 100, inAllowlist: true,
    });
  });
});
