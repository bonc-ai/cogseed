import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {} }));
let root: string, previous: string | undefined;
beforeEach(() => { vi.resetModules(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-source-integrity-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(async () => { await drainMainRuntimeForTest('alice'); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const candidate = await createNightlyCandidateFixture('alice', { judgment: '回答先给结论，再说明依据。', summary: '表达顺序偏好', value: '后续保持明确的表达结构。', suggestedType: 'cognition', suggestedScope: 'general', sourceRefs: [], rawStatement: true });
  const store = await import('../../../../src/main/features/recall/store');
  const provenance = await import('../../../../src/main/features/recall/capture-provenance');
  const summary = await import('../../../../src/main/features/recall/capture-context-summary');
  const storage = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const capture = await store.readRecallJsonRecord('alice', 'captures', candidate.captureProvenance!.captureId);
  const file = conversationMessageFile('alice', String(capture!.conversationId));
  const [original] = await storage.readJsonl<any>(file);
  const limit = { id: 'unquoted-constraint', ts: original.ts, from: 'user', to: ['commander'], text: '此表达偏好仅用于技术讨论；个人沟通需要完整上下文。' };
  const messages = [limit, original];
  const oldSummary = capture!.contextSummary as any;
  const contextSummary = { ...oldSummary,
    sourceDigest: summary.captureContextSourceDigest(messages.map(message => ({ id: message.id, role: 'user', text: message.text, discovery: message.id === original.id }))),
    coverage: { ...oldSummary.coverage, messageCount: 2, sourceChars: limit.text.length + original.text.length, segmentCount: 2, processedSegmentIds: ['m0:0', 'm1:0'] },
    topics: [...oldSummary.topics, { title: '表达偏好的限制', content: limit.text, conditions: [limit.text], unresolved: [], attribution: 'user_requirement', evidence: [{ messageId: limit.id, quote: limit.text, role: 'user', start: 0, end: limit.text.length }] }],
  };
  const valueJudgment = { ...candidate.captureProvenance!.valueJudgment, summaryDigest: provenance.captureSummaryDecisionDigest(contextSummary) };
  const proof = { ...candidate.captureProvenance!, valueJudgment };
  await store.updateRecallJsonRecord('alice', 'captures', capture!.id, current => ({ ...current!, contextMessageIds: [limit.id], contextSummary, valueJudgment }));
  await store.updateRecallJsonRecord('alice', 'candidates', candidate.id, current => ({ ...current!, captureProvenance: proof }));
  fs.writeFileSync(file, messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const current = { ...candidate, captureProvenance: proof };
  return { current, file, original, limit, messages, provenance, store };
}
describe('promotion source integrity covers all frozen context', () => {
  it('accepts the unchanged original source and frozen contextual restriction', async () => {
    const f = await fixture();
    await expect(f.provenance.verifyCaptureProvenanceForPromotion('alice', f.current)).resolves.toEqual(f.current.captureProvenance);
    expect(f.current.evidenceRefs.some(ref => ref.id === f.limit.id)).toBe(false);
  });
  it.each(['evidence_body', 'context_body', 'context_deleted', 'context_role', 'context_internal'] as const)('rejects source mutation beyond direct evidence: %s', async kind => {
    const f = await fixture();
    const messages = structuredClone(f.messages);
    if (kind === 'evidence_body') messages[1].text += '用户已修改原证据。';
    if (kind === 'context_body') messages[0].text = '现在不再采用此前表达偏好。';
    if (kind === 'context_deleted') messages.splice(0, 1);
    if (kind === 'context_role') messages[0].from = 'commander';
    if (kind === 'context_internal') messages[0].system_kind = 'internal';
    fs.writeFileSync(f.file, messages.map(message => JSON.stringify(message)).join('\n') + '\n');
    await expect(f.provenance.verifyCaptureProvenanceForPromotion('alice', f.current)).rejects.toBeInstanceOf(f.provenance.CaptureFormationSourceUnavailableError);
  });
  it('rejects a frozen context message whose source is paused', async () => {
    const f = await fixture();
    const identity = await import('../../../../src/main/features/recall/source-identity');
    const controls = await import('../../../../src/main/features/recall/source-control');
    const capture = await f.store.readRecallJsonRecord('alice', 'captures', f.current.captureProvenance!.captureId);
    const conversationId = String(capture!.conversationId);
    await controls.pauseCognitionSource('alice', {
      kind: 'conversation', subtype: 'message', taxonomyVersion: 2, scope: 'conversation',
      id: identity.cognitionMessageSourceId(conversationId, f.limit.id),
      locator: { conversationId, messageId: f.limit.id },
    });
    await expect(f.provenance.verifyCaptureProvenanceForPromotion('alice', f.current))
      .rejects.toBeInstanceOf(f.provenance.CaptureFormationSourceUnavailableError);
  });

  it('marks a newly promoted candidate failed after source changes without rewriting its original capture', async () => {
    const f = await fixture();
    const before = await f.store.readRecallJsonRecord('alice', 'captures', f.current.captureProvenance!.captureId);
    fs.writeFileSync(f.file, JSON.stringify({ ...f.original, text: '已改变的原文证据' }) + '\n');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await expect(candidates.promoteRecallCandidate('alice', f.current.id, { actor: 'user' })).rejects.toBeInstanceOf(f.provenance.CaptureFormationSourceUnavailableError);
    expect(await candidates.readRecallCandidate('alice', f.current.id)).toMatchObject({ status: 'failed', failureCode: 'source_unavailable' });
    expect(await f.store.readRecallJsonRecord('alice', 'captures', before!.id)).toEqual(before);
  });
});
