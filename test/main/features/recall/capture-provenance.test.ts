import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let tmp: string, previous: string | undefined;
beforeEach(() => {
  vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-proof-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmp;
});
afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});
async function fixture(quote = '以后先说明结论，再说明理由。') {
  const store = await import('../../../../src/main/features/recall/store');
  const { cognitionMessageSourceId } = await import('../../../../src/main/features/recall/source-catalog');
  const service = await import('../../../../src/main/features/recall/capture-provenance');
  const summaryService = await import('../../../../src/main/features/recall/capture-context-summary');
  const messages = [{ id: 'msg-a', role: 'user', text: quote, discovery: true },
    { id: 'msg-b', role: 'assistant', text: '已理解这个长期表达偏好。', discovery: true }];
  const contextSummary = summaryService.validateCaptureContextSummary({
    sourceDigest: summaryService.captureContextSourceDigest(messages), completedAt: '2026-10-11T01:59:00.000Z',
    coverage: { messageCount: 2, sourceChars: messages.reduce((n, message) => n + message.text.length, 0),
      segmentCount: 2, processedSegmentIds: ['m0:0', 'm1:0'], maxInputChars: 10000 },
    topics: [{ title: '长期表达偏好', content: '用户希望先结论后理由。', conditions: [], unresolved: [], attribution: 'user_requirement',
      evidence: [{ messageId: 'msg-a', quote, role: 'user', start: 0, end: quote.length }] }],
  }, messages);
  const sourceId = cognitionMessageSourceId('conv-a', 'msg-a');
  const proof = { pipeline: 'nightly_conversation' as const, captureId: 'rcap-a', messageIds: ['msg-a', 'msg-b'],
    valueJudgment: { eligible: true as const, reason: '可在后续项目复用的明确表达偏好',
      evidence: [{ messageId: 'msg-a', sourceId, quote }], judgedAt: '2026-10-11T02:00:00.000Z',
      summaryDigest: service.captureSummaryDecisionDigest(contextSummary) }, extractionCompletedAt: '2026-10-11T02:01:00.000Z' };
  const refs = [{ taxonomyVersion: 2 as const, kind: 'conversation' as const, subtype: 'session' as const, id: 'conv-a' },
    { taxonomyVersion: 2 as const, kind: 'conversation' as const, subtype: 'message' as const, id: sourceId,
      excerpt: quote.replace(/\s+/g, ' ').slice(0, 240) }];
  const capture = { schemaVersion: 2, ownerId: 'alice', id: 'rcap-a', conversationId: 'conv-a', executionPolicy: 'nightly',
    reviewDay: '2026-10-10', status: 'extracting', candidateIds: [], messageIds: proof.messageIds,
    contextSummary, valueJudgment: proof.valueJudgment, extractionCompletedAt: proof.extractionCompletedAt };
  await store.writeRecallJsonRecord('alice', 'captures', 'rcap-a', capture);
  return { store, service, proof, refs, capture };
}
function workerFeedbackContext() {
  const observation = { id: 'nf-worker', messageId: 'msg-a', assetId: 'aa-worker', assetVersion: '1', taskRunId: 'synthetic-turn',
    feedback: 'negative' as const, updatedAt: '2026-10-11T02:00:00.000Z',
    resultSource: { kind: 'group_execution' as const, executionId: 'exec-worker', conversationId: 'conv-a', actorId: 'worker-1' } };
  const context = { ...observation, resultContext: { status: 'available', fingerprint: 'frozen-worker-result',
    text: 'The delivered report omitted source references.', refs: [], coverage: { complete: true, totalFiles: 0, readableFiles: 0 },
    sourceRefs: [{ kind: 'execution_evaluation', taxonomyVersion: 2, subtype: 'execution', id: 'exec-worker' }] } };
  return { observation, context };
}
describe('夜间两阶段形成证明', () => {
  it('要求真实夜间范围及同一次完整摘要、价值判断和提取完成记录', async () => {
    const f = await fixture();
    await expect(f.service.verifyCaptureProvenanceForWrite('alice', f.proof, f.refs)).resolves.toEqual(f.proof);
  });
  it('不能凭伪造capture、错范围、错source或错提取时间进入候选', async () => {
    const f = await fixture();
    for (const change of [{ captureId: 'rcap-missing' }, { messageIds: ['msg-a'] },
      { extractionCompletedAt: '2026-10-11T02:02:00.000Z' },
      { valueJudgment: { ...f.proof.valueJudgment, evidence: [{ ...f.proof.valueJudgment.evidence[0], sourceId: 'source-forged' }] } }]) {
      await expect(f.service.verifyCaptureProvenanceForWrite('alice', { ...f.proof, ...change }, f.refs)).rejects.toThrow();
    }
    await expect(f.service.verifyCaptureProvenanceForWrite('bob', f.proof, f.refs)).rejects.toThrow();
  });
  it('来源预览截断或空白压缩不能否定完整摘要已核对的长原文证据', async () => {
    const f = await fixture('明确规则。\n' + '长期使用的完整表达内容。'.repeat(40));
    expect(f.refs[1].excerpt).not.toContain('\n');
    expect(f.refs[1].excerpt!.length).toBeLessThan(f.proof.valueJudgment.evidence[0].quote.length);
    await expect(f.service.verifyCaptureProvenanceForWrite('alice', f.proof, f.refs)).resolves.toEqual(f.proof);
  });
  it('历史读取允许无证明，新写必须提供证明', async () => {
    const f = await fixture();
    expect(f.service.normalizeCaptureProvenance(undefined)).toBeUndefined();
    await expect(f.service.verifyCaptureProvenanceForWrite('alice', undefined, f.refs)).rejects.toThrow('required');
    await f.store.writeRecallJsonRecord('alice', 'captures', 'rcap-a', { ...f.capture, executionPolicy: 'manual' });
    await expect(f.service.verifyCaptureProvenanceForWrite('alice', f.proof, f.refs)).rejects.toThrow();
  });
  it('未完成摘要或摘要判断绑定已改变不能通过', async () => {
    const f = await fixture();
    for (const patch of [{ contextSummary: undefined },
      { contextSummary: { ...f.capture.contextSummary, coverage: { ...f.capture.contextSummary.coverage, processedSegmentIds: ['m0:0'] } } },
      { contextSummary: { ...f.capture.contextSummary, topics: [] } }]) {
      await f.store.writeRecallJsonRecord('alice', 'captures', 'rcap-a', { ...f.capture, ...patch });
      await expect(f.service.verifyCaptureProvenanceForWrite('alice', f.proof, f.refs)).rejects.toThrow('summary');
    }
  });
  it('价值未通过、引用越界或提取早于判断都不能通过', async () => {
    const f = await fixture();
    for (const change of [{ valueJudgment: { ...f.proof.valueJudgment, eligible: false } }, { messageIds: ['msg-b'] },
      { extractionCompletedAt: '2026-10-11T01:00:00.000Z' }]) {
      expect(() => f.service.normalizeCaptureProvenance({ ...f.proof, ...change })).toThrow();
    }
  });
  it.each(['write', 'promotion'] as const)('revalidates frozen worker feedback at the %s boundary', async boundary => {
    const f = await fixture();
    const { observation, context } = workerFeedbackContext();
    const candidate = { id: 'cand-worker', ownerId: 'alice', status: 'pending_review' as const,
      captureProvenance: f.proof, sourceRefs: f.refs, evidenceRefs: [f.refs[1]!] };
    await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture,
      status: boundary === 'write' ? 'extracting' : 'review_ready',
      candidateIds: boundary === 'write' ? [] : [candidate.id], feedbackObservations: [observation], feedbackVersionContexts: [context] });
    const feedback = await import('../../../../src/main/features/recall/feedback-version-context');
    const verify = vi.spyOn(feedback, 'assertFeedbackResultContextsCurrent').mockRejectedValue(new Error('worker result changed'));
    try {
      const result = boundary === 'write' ? f.service.verifyCaptureProvenanceForWrite('alice', f.proof, f.refs)
        : f.service.verifyCaptureProvenanceForPromotion('alice', candidate);
      await expect(result).rejects.toBeInstanceOf(f.service.CaptureFormationSourceUnavailableError);
      expect(verify).toHaveBeenCalledWith('alice', 'conv-a', [context]);
    } finally { verify.mockRestore(); }
  });
});

async function historicalSourceFixture() {
  const f = await fixture();
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const file = conversationMessageFile('alice', 'conv-a');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [{ id: 'msg-a', from: 'user', to: ['commander'], text: f.proof.valueJudgment.evidence[0]!.quote },
    { id: 'msg-b', from: 'commander', to: ['user'], text: '已理解这个长期表达偏好。' }];
  fs.writeFileSync(file, rows.map(row => JSON.stringify({ ...row, ts: '2026-10-10T10:00:00.000Z' })).join('\n') + '\n');
  await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture, status: 'completed', candidateIds: ['cand-history'] });
  // This tests source validation only, without manufacturing a ReviewDecision
  // or an authorization proof. Full real commit chains have separate tests.
  const candidate = { id: 'cand-history', ownerId: 'alice', status: 'confirmed' as const,
    captureProvenance: f.proof, sourceRefs: f.refs, evidenceRefs: [f.refs[1]!],
    promotedAssetId: 'aa-history', reviewDecisionId: 'rd_history_source_test' };
  return { ...f, candidate, file, rows };
}

describe('已保存认知的来源只读复核', () => {
  it('reads committed worker feedback without a new current-result prerequisite', async () => {
    const f = await historicalSourceFixture();
    const { observation, context } = workerFeedbackContext();
    const summaryService = await import('../../../../src/main/features/recall/capture-context-summary');
    const contextSummary = { ...f.capture.contextSummary, sourceDigest: summaryService.captureContextSourceDigest(f.rows.map(row => ({
      id: row.id, role: row.from === 'user' ? 'user' : 'assistant', text: row.text, discovery: true,
      ...(row.id === observation.messageId ? { observations: [context] } : {}),
    }))) };
    const valueJudgment = { ...f.proof.valueJudgment, summaryDigest: f.service.captureSummaryDecisionDigest(contextSummary) };
    const proof = { ...f.proof, valueJudgment };
    await f.store.updateRecallJsonRecord('alice', 'captures', f.capture.id, current => ({ ...current!,
      contextSummary, valueJudgment, feedbackObservations: [observation], feedbackVersionContexts: [context] }));
    const feedback = await import('../../../../src/main/features/recall/feedback-version-context');
    const verify = vi.spyOn(feedback, 'assertFeedbackResultContextsCurrent').mockRejectedValue(new Error('worker result unavailable'));
    try {
      await expect(f.service.verifyCaptureProvenanceForCommittedCandidate('alice', { ...f.candidate, captureProvenance: proof })).resolves.toEqual(proof);
      expect(verify).not.toHaveBeenCalled();
    } finally { verify.mockRestore(); }
  });
  it('允许核对已完成capture原文，却仍拒绝已确认候选再次获得新写权限', async () => {
    const f = await historicalSourceFixture();
    await expect(f.service.verifyCaptureProvenanceForCommittedCandidate('alice', f.candidate)).resolves.toEqual(f.proof);
    await expect(f.service.verifyCaptureProvenanceForPromotion('alice', f.candidate)).rejects.toThrow('no new formation write authority');
    expect((await f.store.readRecallJsonRecord('alice', 'captures', f.capture.id))?.status).toBe('completed');
  });
  it('同一消息ID下原文发生变化不能借旧摘要通过', async () => {
    const f = await historicalSourceFixture();
    fs.writeFileSync(f.file, f.rows.map(row => JSON.stringify({ ...row, text: row.id === 'msg-a' ? '已改成另一条偏好。' : row.text })).join('\n') + '\n');
    await expect(f.service.verifyCaptureProvenanceForCommittedCandidate('alice', f.candidate)).rejects.toThrow('unavailable');
  });
  it('未真正完成或不属于该capture的候选不得通过历史核对', async () => {
    const f = await historicalSourceFixture();
    for (const patch of [{ status: 'extracting' }, { status: 'completed', candidateIds: ['cand-other'] }]) {
      await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture, candidateIds: [f.candidate.id], ...patch });
      await expect(f.service.verifyCaptureProvenanceForCommittedCandidate('alice', f.candidate)).rejects.toThrow('does not match');
    }
    await expect(f.service.verifyCaptureProvenanceForCommittedCandidate('alice', { ...f.candidate, status: 'pending_review' })).rejects.toThrow('no committed');
  });
  it('核对时继续尊重现有来源的暂停状态', async () => {
    const f = await historicalSourceFixture();
    const { pauseCognitionSource } = await import('../../../../src/main/features/recall/source-control');
    await pauseCognitionSource('alice', f.refs[1]!);
    await expect(f.service.verifyCaptureProvenanceForCommittedCandidate('alice', f.candidate)).rejects.toThrow('unavailable');
  });
});
