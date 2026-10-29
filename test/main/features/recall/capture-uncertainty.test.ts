import { expect, it } from 'vitest';
import { parseCaptureUncertaintyAssessment } from '../../../../src/main/features/recall/capture-uncertainty';

const text = '以后诊断超时先读取时间线，按同一请求比较重试和依赖耗时，分别验证网络和服务端假设；证据不足时停止归因并保留未验证状态。';
const approved = '诊断超时先读取时间线';
const source = { label: 'm1', text, approvedQuotes: [approved] };
const positive = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
  priorContentPreserved: true, uncertaintyDisposition: 'effect_unverified', evidence: [{ label: 'm1', quote: approved }] };

it('accepts a complete assessment whose evidence resolves in an approved user quote', () => {
  expect(parseCaptureUncertaintyAssessment(JSON.stringify(positive), [source])).toMatchObject({
    supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
    priorContentPreserved: true, uncertaintyDisposition: 'effect_unverified',
  });
});

it('rejects alternative structured verdicts rather than choosing the first JSON payload', () => {
  const fenced = `\u0060\u0060\u0060json\n${JSON.stringify(positive)}\n\u0060\u0060\u0060`;
  for (const suffix of [fenced, JSON.stringify({ ...positive, supported: false }), '[{"supported":false}]', '\u0060\u0060\u0060text\nother payload\n\u0060\u0060\u0060']) {
    expect(() => parseCaptureUncertaintyAssessment(`${fenced}\n${suffix}`, [source])).toThrow();
  }
});

it('rejects fabricated evidence, unrelated topics, assistant labels, extra fields and malformed booleans', () => {
  for (const raw of [
    { ...positive, uncertaintyDisposition: 'safe_to_save' }, { ...positive, supported: 'true' },
    { ...positive, evidence: [] }, { ...positive, evidence: [{ label: 'm1', quote: '实际已经证明节省一半时间' }] },
    { ...positive, evidence: [{ label: 'm2', quote: approved }] }, { ...positive, judgment: 'model rewrite' },
    { ...positive, evidence: [{ label: 'm1', quote: '分别验证网络和服务端假设' }] },
  ]) expect(() => parseCaptureUncertaintyAssessment(JSON.stringify(raw), [source])).toThrow();
});
