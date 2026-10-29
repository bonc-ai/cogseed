import { beforeEach, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: run }));
import { parseCaptureGroundingAssessment, semanticallyGroundCaptureCandidate } from '../../../../src/main/features/recall/capture-grounding';
const text = '自2026年10月11日起，以后解释复杂问题先给结论，再说明原因，避免先铺很长背景，但不要省略必要证据。';
const approved = '解释复杂问题先给结论，再说明原因';
const sources = [{ label: 'm1', text, approvedQuotes: [approved] }];
const accepted = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
  priorContentPreserved: true, evidence: [{ label: 'm1', quote: approved }] };
beforeEach(() => run.mockReset());

it('uses approved topic plus original conditions to check a faithful paraphrase without a lexical threshold', async () => {
  run.mockResolvedValue({ result: { text: JSON.stringify(accepted), meta: {} } });
  const candidate = { judgment: '对于复杂问题，用户从2026年10月11日起长期偏好结论优先的解释方式；原因随后展开，必要证据仍应完整。', value: '指导以后回答结构', suggestedScope: 'general', suggestedAction: 'create' };
  expect(await semanticallyGroundCaptureCandidate('user-a', { sessionId: 'one-shot-grounding', candidate, sources, summary: [], modelCandidates: [] })).toBe(true);
  expect(JSON.parse(run.mock.calls[0][1].message)).toMatchObject({ candidate, approvedUserSources: sources });
});

it('can check a full revision using the real target while citing only the new correction', async () => {
  run.mockResolvedValue({ result: { text: JSON.stringify(accepted), meta: {} } });
  const existingTarget = { id: 'aa-pref', version: '1', scope: 'general', statement: '回答复杂问题应保留证据。' };
  const candidate = { judgment: text, value: '保持已有证据边界并调整回答顺序', suggestedScope: 'general', suggestedAction: 'update', targetAssetId: 'aa-pref' };
  expect(await semanticallyGroundCaptureCandidate('user-a', { sessionId: 'one-shot-grounding', candidate, sources, summary: [], existingTarget, modelCandidates: [] })).toBe(true);
  expect(JSON.parse(run.mock.calls[0][1].message).existingTarget).toEqual(existingTarget);
  expect(await semanticallyGroundCaptureCandidate('user-a', { sessionId: 'one-shot-grounding', candidate, sources, summary: [], modelCandidates: [] })).toBe(false);
});

it.each(['supported', 'noUnsupportedClaims', 'scopePreserved', 'finalDecisionPreserved', 'priorContentPreserved'])('holds a proposal when semantic check %s fails', async key => {
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, [key]: false }), meta: {} } });
  expect(await semanticallyGroundCaptureCandidate('user-a', { sessionId: 'one-shot-grounding', candidate: { judgment: text, value: '未来用途', suggestedScope: 'general' }, sources, summary: [], modelCandidates: [] })).toBe(false);
});

it('rejects fabricated quotes, unrelated topic citations, invented labels and malformed permission booleans', () => {
  for (const malformed of [
    { ...accepted, evidence: [] }, { ...accepted, evidence: [{ label: 'm1', quote: '模型编造内容' }] },
    { ...accepted, evidence: [{ label: 'm2', quote: approved }] }, { ...accepted, supported: 'true' },
    { ...accepted, evidence: [{ label: 'm1', quote: '自2026年10月11日起' }] },
    { ...accepted, permissions: 'save now' },
  ]) expect(() => parseCaptureGroundingAssessment(JSON.stringify(malformed), sources)).toThrow();
});

it('distinguishes model unavailability from completed negative judgments and preserves runner interruption', async () => {
  const input = { sessionId: 'one-shot-grounding', candidate: { judgment: text, value: '未来用途', suggestedScope: 'general' }, sources, summary: [], modelCandidates: [] };
  run.mockResolvedValueOnce({ result: { text: JSON.stringify(accepted), meta: { error: { kind: 'network', message: 'private provider diagnostics' } } } });
  await expect(semanticallyGroundCaptureCandidate('user-a', input)).rejects.toMatchObject({ code: 'capture_grounding_unavailable', reason: 'model_unavailable' });
  run.mockResolvedValueOnce({ result: { text: JSON.stringify(accepted), meta: { aborted: true } } });
  await expect(semanticallyGroundCaptureCandidate('user-a', input)).rejects.toMatchObject({ code: 'ABORT_ERR' });
  run.mockResolvedValueOnce({ result: { text: 'not a complete assessment', meta: {} } });
  await expect(semanticallyGroundCaptureCandidate('user-a', input)).rejects.toMatchObject({ code: 'capture_grounding_unavailable', reason: 'assessment_invalid' });
  run.mockRejectedValueOnce(new Error('private provider diagnostics'));
  await expect(semanticallyGroundCaptureCandidate('user-a', input)).rejects.toThrow('candidate source support could not be evaluated: model_unavailable');
});

const exactEffectQuote = '没有证据表明效果已经改善';
const mistypedEffectQuote = '没有证据表明效果已改善';
const effectSource = { label: 'm-effect', text: '用户明确保留完整步骤，但没有证据表明效果已经改善。', approvedQuotes: [exactEffectQuote] };
it('selects only the actual complete approved quote while refusing the observed literal typo and conflicting mixed form', () => {
  const indexed = { ...accepted, evidence: [{ label: effectSource.label, approvedQuoteIndex: 0 }] };
  const result = parseCaptureGroundingAssessment(JSON.stringify(indexed), [effectSource]);
  expect(result.evidence).toEqual([{ label: effectSource.label, quote: exactEffectQuote }]);
  expect(JSON.stringify(result)).not.toContain('approvedQuoteIndex');
  expect(indexed.evidence).toEqual([{ label: effectSource.label, approvedQuoteIndex: 0 }]);
  for (const evidence of [
    [{ label: effectSource.label, quote: mistypedEffectQuote }],
    [{ label: effectSource.label, quote: mistypedEffectQuote, approvedQuoteIndex: 0 }],
    [{ label: effectSource.label, quote: '效果已经改善', approvedQuoteIndex: 0 }],
  ]) expect(() => parseCaptureGroundingAssessment(JSON.stringify({ ...accepted, evidence }), [effectSource])).toThrow();
  expect(parseCaptureGroundingAssessment(JSON.stringify({ ...indexed, evidence: [{ ...indexed.evidence[0], quote: exactEffectQuote }] }), [effectSource]).evidence).toEqual(result.evidence);
});

it.each([-1, 0.5, '0', true, null, Number.MAX_SAFE_INTEGER + 1, 1])('rejects an invalid or absent approved quote index: %j', approvedQuoteIndex => {
  expect(() => parseCaptureGroundingAssessment(JSON.stringify({ ...accepted, evidence: [{ label: 'm1', approvedQuoteIndex }] }), sources)).toThrow();
});

it('does not index whole text, guessed approvals, empty approvals or an overlong passage', () => {
  for (const source of [
    { label: 'm1', text }, { label: 'm1', text, approvedQuotes: [] },
    { label: 'm1', text, approvedQuotes: [''] }, { label: 'm1', text, approvedQuotes: ['   '] },
    { label: 'm1', text, approvedQuotes: ['不存在于来源中的旧批准片段'] },
    { label: 'm1', text: '文'.repeat(1001), approvedQuotes: ['文'.repeat(1001)] },
  ]) expect(() => parseCaptureGroundingAssessment(JSON.stringify({ ...accepted, evidence: [{ label: 'm1', approvedQuoteIndex: 0 }] }), [source])).toThrow();
  // The old literal form remains compatible when no indexed approvals exist.
  expect(parseCaptureGroundingAssessment(JSON.stringify(accepted), [{ label: 'm1', text }]).evidence).toEqual(accepted.evidence);
});

it('rejects source-label ambiguity, assistant-only labels, extra selector fields and more than 32 references', () => {
  const indexed = { ...accepted, evidence: [{ label: 'm1', approvedQuoteIndex: 0 }] };
  expect(() => parseCaptureGroundingAssessment(JSON.stringify(indexed), [...sources, ...sources])).toThrow();
  expect(() => parseCaptureGroundingAssessment(JSON.stringify(accepted), [...sources, ...sources])).toThrow();
  for (const evidence of [
    [{ label: 'assistant-m2', approvedQuoteIndex: 0 }],
    [{ label: 'm1', approvedQuoteIndex: 0, sourceVersion: 1 }],
    [{ label: 'm1' }], Array.from({ length: 33 }, () => indexed.evidence[0]),
  ]) expect(() => parseCaptureGroundingAssessment(JSON.stringify({ ...accepted, evidence }), sources)).toThrow();
});

it('allows multiple exact approved fragments from one unambiguous source without conflating indices or labels', () => {
  const second = '不要省略必要证据';
  const selectedSources = [{ ...sources[0], approvedQuotes: [approved, second] }];
  expect(parseCaptureGroundingAssessment(JSON.stringify({ ...accepted, evidence: [
    { label: 'm1', approvedQuoteIndex: 1 }, { label: 'm1', approvedQuoteIndex: 0 },
  ] }), selectedSources).evidence).toEqual([{ label: 'm1', quote: second }, { label: 'm1', quote: approved }]);
});

it.each(['supported', 'noUnsupportedClaims', 'scopePreserved', 'finalDecisionPreserved', 'priorContentPreserved'])('does not let a valid source selector bypass a false %s check', async key => {
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, [key]: false, evidence: [{ label: 'm1', approvedQuoteIndex: 0 }] }), meta: {} } });
  expect(await semanticallyGroundCaptureCandidate('user-a', { sessionId: 'indexed-negative', candidate: { judgment: text, value: '未来用途', suggestedScope: 'general' }, sources, summary: [], modelCandidates: [] })).toBe(false);
});
