import { describe, expect, it } from 'vitest';
import { captureValueJudgmentInput, parseCaptureValueJudgment } from '../../../../src/main/features/recall/capture-value-judgment';
import type { CaptureContextSummary } from '../../../../src/main/features/recall/capture-context-summary';

const messages = [
  { id: 'u1', sourceId: 'source-u1', role: 'user', text: '以后写报告时保留关键决策的原始来源。' },
  { id: 'a1', sourceId: 'source-a1', role: 'assistant', text: '以后写报告时保留关键决策的原始来源。' },
];
describe('independent capture value decision', () => {
  it('never manufactures a source newline by joining separated excerpts', () => {
    const source = '以后解释复杂问题，先结论。这里是另一个临时话题。必要证据不能省略。';
    const summary = { topics: [{ evidence: [{ messageId: 'u1', role: 'user', quote: '先结论。' },
      { messageId: 'u1', role: 'user', quote: '必要证据不能省略。' }] }] } as CaptureContextSummary;
    const input = captureValueJudgmentInput(summary, [{ id: 'u1', role: 'user', text: source }]);
    expect(input.messages[0].excerpts).toEqual(['先结论。', '必要证据不能省略。']);
    expect(input.messages[0]).not.toHaveProperty('text');
    expect(() => parseCaptureValueJudgment(JSON.stringify({ eligible: true, reason: '长期解释偏好',
      evidence: [{ messageId: 'u1', quote: input.messages[0].excerpts.join('\n') }] }), [{ id: 'u1', sourceId: 'source-u1', role: 'user', text: source }])).toThrow('unsupported');
  });
  it('accepts a quote covered by adjacent summary passages but rejects joined gaps or assistant evidence', () => {
    const source = messages[0];
    const quote = source.text;
    const result = JSON.stringify({ eligible: true, reason: '明确的以后报告来源规则', evidence: [{ messageId: 'u1', quote }] });
    const parts = (ranges: Array<[number, number]>, role = 'user') => ({ topics: [{ evidence: ranges.map(([start, end]) => ({ messageId: 'u1', role, start, end, quote: quote.slice(start, end) })) }] }) as CaptureContextSummary;
    expect(parseCaptureValueJudgment(result, messages, parts([[0, 8], [8, quote.length]]))).toMatchObject({ eligible: true });
    expect(() => parseCaptureValueJudgment(result, messages, parts([[0, 8], [9, quote.length]]))).toThrow('unsupported');
    expect(() => parseCaptureValueJudgment(result, messages, parts([[0, quote.length]], 'assistant'))).toThrow('unsupported');
  });
  it('requires literal user evidence and derives the source ID from the input', () => {
    expect(parseCaptureValueJudgment(JSON.stringify({ eligible: true, reason: '跨任务可复用的来源规则',
      evidence: [{ messageId: 'u1', quote: '保留关键决策的原始来源' }] }), messages))
      .toMatchObject({ eligible: true, evidence: [{ messageId: 'u1', sourceId: 'source-u1', quote: '保留关键决策的原始来源' }] });
  });
  it.each([
    { eligible: true, reason: 'reusable', evidence: [] },
    { eligible: true, reason: 'reusable', evidence: [{ messageId: 'invented', quote: '保留关键决策的原始来源' }] },
    { eligible: true, reason: 'reusable', evidence: [{ messageId: 'a1', quote: '保留关键决策的原始来源' }] },
    { eligible: true, reason: 'reusable', evidence: [{ messageId: 'u1', quote: '伪造的长期记忆来源' }] },
    { eligible: true, reason: 'reusable', evidence: [{ messageId: 'u1', quote: '   ' }] },
    { eligible: true, reason: 'reusable', evidence: [], candidates: [] },
    { candidates: [{ judgment: 'assets are not a value decision' }] },
    { eligible: 'true', reason: 'reusable', evidence: [] },
  ])('rejects extraction-shaped, fabricated, or assistant-only evidence: %j', result => {
    expect(() => parseCaptureValueJudgment(JSON.stringify(result), messages)).toThrow();
  });
  it('accepts a negative decision without requiring invented evidence', () => {
    expect(parseCaptureValueJudgment('```json\n{"eligible":false,"reason":"一次临时操作","evidence":[]}\n```', messages))
      .toMatchObject({ eligible: false, reason: '一次临时操作', evidence: [] });
  });
  it('allows short explicit preferences but cannot turn earlier context into new evidence', () => {
    const source = { id: 'u2', sourceId: 'source-u2', role: 'user', text: '默认中文' };
    const result = JSON.stringify({ eligible: true, reason: '明确的后续沟通偏好', evidence: [{ messageId: 'u2', quote: '默认中文' }] });
    expect(parseCaptureValueJudgment(result, [source])).toMatchObject({ eligible: true });
    expect(() => parseCaptureValueJudgment(result, [{ ...source, discovery: false }])).toThrow('unsupported');
  });
});
