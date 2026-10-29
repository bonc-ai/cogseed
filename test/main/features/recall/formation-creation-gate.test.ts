import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecallAbilityAssetRecord, RecallCandidateRecord } from '../../../../src/main/features/recall/candidate-service';
import type { CaptureContextSummary } from '../../../../src/main/features/recall/capture-context-summary';
let tmp: string, previous: string | undefined;
beforeEach(() => {
  vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'formation-gate-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmp;
});
afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});
async function fixture(contentCategory?: RecallCandidateRecord['contentCategory']) {
  const store = await import('../../../../src/main/features/recall/store');
  const service = await import('../../../../src/main/features/recall/capture-provenance');
  const gate = await import('../../../../src/main/features/recall/formation-creation-gate');
  const journal = await import('../../../../src/main/features/cognition/review-decision');
  const { cognitionMessageSourceId } = await import('../../../../src/main/features/recall/source-catalog');
  const { cognitionSourceRefKey } = await import('../../../../src/main/features/recall/source-service');
  const quote = '以后先说明结论，再说明理由。';
  const { captureContextSourceDigest } = await import('../../../../src/main/features/recall/capture-context-summary');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  await appendJsonlAtomic(conversationMessageFile('alice', 'conv-gate'), { id: 'msg-gate', from: 'user', to: ['commander'], text: quote, ts: '2026-10-10T00:00:00.000Z' });
  const sourceId = cognitionMessageSourceId('conv-gate', 'msg-gate');
  const summary: CaptureContextSummary = {
    sourceDigest: captureContextSourceDigest([{ id: 'msg-gate', role: 'user', text: quote, discovery: true }]), completedAt: '2026-10-11T01:00:00.000Z',
    coverage: { messageCount: 1, sourceChars: quote.length, segmentCount: 1, processedSegmentIds: ['segment-a'], maxInputChars: 4000 },
    topics: [{ title: '表达偏好', content: quote, conditions: [], unresolved: [], attribution: 'user_requirement',
      evidence: [{ messageId: 'msg-gate', quote, role: 'user', start: 0, end: quote.length }] }],
  };
  const proof = { pipeline: 'nightly_conversation' as const, captureId: 'capture-gate', messageIds: ['msg-gate'],
    valueJudgment: { eligible: true as const, reason: '可复用的表达偏好', judgedAt: '2026-10-11T01:01:00.000Z',
      summaryDigest: service.captureSummaryDecisionDigest(summary), evidence: [{ messageId: 'msg-gate', sourceId, quote }] },
    extractionCompletedAt: '2026-10-11T01:02:00.000Z' };
  const refs = [{ taxonomyVersion: 2 as const, kind: 'conversation' as const, subtype: 'session' as const, id: 'conv-gate' },
    { taxonomyVersion: 2 as const, kind: 'conversation' as const, subtype: 'message' as const, id: sourceId }];
  const capture = { schemaVersion: 2, ownerId: 'alice', id: 'capture-gate', conversationId: 'conv-gate',
    executionPolicy: 'nightly', reviewDay: '2026-10-10', status: 'review_ready', candidateIds: ['candidate-gate'],
    messageIds: proof.messageIds, valueJudgment: proof.valueJudgment, extractionCompletedAt: proof.extractionCompletedAt, contextSummary: summary };
  const candidate = { schemaVersion: 2, ownerId: 'alice', id: 'candidate-gate', status: 'pending_review', origin: 'capture',
    captureProvenance: proof, sourceRefs: refs, evidenceRefs: refs, judgment: quote, value: '改善长期沟通效率',
    ...(contentCategory !== undefined ? { contentCategory } : {}),
    suggestedType: 'personal', suggestedScope: 'general', suggestedAction: 'create',
    contentFormatVersion: 1, taxonomyVersion: 2, risk: 'low', summary: '表达偏好',
    createdAt: '2026-10-11T01:02:00.000Z', updatedAt: '2026-10-11T01:02:00.000Z',
    expiresAt: '2099-10-11T01:02:00.000Z' } as RecallCandidateRecord;
  const key = `confirm-${createHash('sha256').update(JSON.stringify({ candidateId: candidate.id, judgment: candidate.judgment,
    value: candidate.value, ...(candidate.contentCategory !== undefined ? { contentCategory: candidate.contentCategory } : {}), type: candidate.suggestedType, scope: candidate.suggestedScope, action: candidate.suggestedAction,
    targetAssetId: candidate.targetAssetId, evidence: refs.map(cognitionSourceRefKey).sort() })).digest('hex').slice(0, 32)}`;
  await store.writeRecallJsonRecord('alice', 'captures', capture.id, capture);
  await store.writeRecallJsonRecord('alice', 'candidates', candidate.id, candidate);
  const decision = await journal.writeReviewDecision('alice', { targetRef: `recall_candidate:${candidate.id}`,
    antecedentRef: candidate.id, decisionType: 'accept', decision: 'accept', actor: 'user', scope: candidate.suggestedScope, idempotencyKey: key });
  const asset = { ownerId: 'alice', id: `aa-${createHash('sha256').update(`${candidate.id}\n${decision.decision_id}`).digest('hex').slice(0, 24)}`,
    ...(contentCategory !== undefined ? { contentCategory } : {}),
    candidateId: candidate.id, sourceCandidateIds: [candidate.id], reviewDecisionId: decision.decision_id,
    status: 'active', lifecycleStatus: 'user_confirmed_unverified', statement: quote, type: candidate.suggestedType, scope: 'general', evidenceRefs: refs } as RecallAbilityAssetRecord;
  return { store, service, gate, capture, candidate, proof, refs, asset, decision };
}
describe('single nightly formation write boundary', () => {
  it('rejects absent proof and mismatched completed summary before saving', async () => {
    const f = await fixture();
    await expect(f.service.verifyCaptureProvenanceForWrite('alice', undefined, f.refs)).rejects.toThrow('required');
    await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture, status: 'extracting' });
    await expect(f.service.verifyCaptureProvenanceForWrite('alice', f.proof, f.refs)).resolves.toEqual(f.proof);
    await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture, status: 'extracting', contextSummary: undefined });
    await expect(f.service.verifyCaptureProvenanceForWrite('alice', f.proof, f.refs)).rejects.toThrow('summary');
  });
  it('requires capture membership and the same in-flight confirmation candidate', async () => {
    const f = await fixture();
    await expect(f.service.verifyCaptureProvenanceForPromotion('alice', f.candidate)).resolves.toEqual(f.proof);
    for (const patch of [{ candidateIds: [] }, { status: 'extracting' }, { status: 'writing', writingCandidateId: 'another' }]) {
      await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture, ...patch });
      await expect(f.service.verifyCaptureProvenanceForPromotion('alice', f.candidate)).rejects.toThrow();
    }
    await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture, status: 'writing', writingCandidateId: f.candidate.id });
    await expect(f.service.verifyCaptureProvenanceForPromotion('alice', f.candidate)).resolves.toEqual(f.proof);
    await expect(f.service.verifyCaptureProvenanceForPromotion('alice', { ...f.candidate, status: 'confirmed' })).rejects.toThrow('authority');
  });
  it.each([undefined, 'understanding', 'rule', 'preference', 'template', 'method', 'lesson', 'unclassified', 'experience_method', 'fact'] as const)('requires the actual matching user journal (category %s) and current candidate content at final creation', async (category) => {
    const f = await fixture(category);
    await expect(f.gate.verifyNightlyAssetCreation('alice', f.asset, 'user')).resolves.toBeUndefined();
    for (const patch of [{ reviewDecisionId: 'rd_forged123456' }, { statement: '绕过候选正文' }, { id: 'aa-forged' }, { contentCategory: 'mismatched' }]) {
      await expect(f.gate.verifyNightlyAssetCreation('alice', { ...f.asset, ...patch }, 'user')).rejects.toThrow();
    }
    await expect(f.gate.verifyNightlyAssetCreation('alice', f.asset, 'system')).rejects.toThrow();
    await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, { ...f.candidate, judgment: '确认后被另行替换的正文' });
    await expect(f.gate.verifyNightlyAssetCreation('alice', f.asset, 'user')).rejects.toThrow();
  });
  it('rejects a changed category even when the body remains identical to the reviewed candidate', async () => {
    const f = await fixture('rule');
    await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, { ...f.candidate, contentCategory: 'method' });
    await expect(f.gate.verifyNightlyAssetCreation('alice', { ...f.asset, contentCategory: 'method' }, 'user')).rejects.toThrow('journal_fingerprint');
  });
  it('compares extraction with the actual journal timestamp precision while rejecting an earlier second', async () => {
    const f = await fixture();
    const second = Math.floor(Date.parse(f.decision.timestamp) / 1000) * 1000;
    for (const [offset, accepted] of [[500, true], [1000, false]] as const) {
      const at = new Date(second + offset).toISOString();
      const proof = { ...f.proof, extractionCompletedAt: at, valueJudgment: { ...f.proof.valueJudgment, judgedAt: at } };
      await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id,
        { ...f.capture, extractionCompletedAt: at, valueJudgment: proof.valueJudgment });
      await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, { ...f.candidate, captureProvenance: proof });
      if (accepted) await expect(f.gate.verifyNightlyAssetCreation('alice', f.asset, 'user')).resolves.toBeUndefined();
      else await expect(f.gate.verifyNightlyAssetCreation('alice', f.asset, 'user')).rejects.toThrow('journal_time');
    }
  });

  it('keeps one capture idempotent and creates separate candidates for another capture', async () => {
    const f = await fixture();
    const { saveRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    await f.store.writeRecallJsonRecord('alice', 'captures', f.capture.id, { ...f.capture, status: 'extracting' });
    const input = { judgment: f.candidate.judgment, value: f.candidate.value, suggestedType: f.candidate.suggestedType,
      suggestedScope: f.candidate.suggestedScope, suggestedAction: f.candidate.suggestedAction,
      sourceRefs: f.refs, evidenceRefs: f.refs, captureProvenance: f.proof, rawStatement: true };
    expect((await saveRecallCandidate('alice', input)).id).toBe(f.candidate.id);
    const nextProof = { ...f.proof, captureId: 'capture-second' };
    await f.store.writeRecallJsonRecord('alice', 'captures', nextProof.captureId,
      { ...f.capture, id: nextProof.captureId, status: 'extracting', candidateIds: [] });
    const second = await saveRecallCandidate('alice', { ...input, captureProvenance: nextProof });
    expect(second.id).not.toBe(f.candidate.id);
    expect(second.captureProvenance).toEqual(nextProof);
    expect((await f.store.readRecallJsonRecord('alice', 'candidates', f.candidate.id))?.captureProvenance).toEqual(f.proof);
  });
  it('recognizes confirmed duplicates without rewriting their proof or formal asset', async () => {
    const f = await fixture();
    const { saveRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    const confirmed = { ...f.candidate, status: 'confirmed', promotedAssetId: 'asset-existing' };
    const existingAsset = { schemaVersion: 2, ownerId: 'alice', id: 'asset-existing', marker: 'unchanged historical commit' };
    await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, confirmed);
    await f.store.writeRecallJsonRecord('alice', 'ability-assets', existingAsset.id, existingAsset);
    const nextProof = { ...f.proof, captureId: 'capture-second' };
    await f.store.writeRecallJsonRecord('alice', 'captures', nextProof.captureId,
      { ...f.capture, id: nextProof.captureId, status: 'extracting', candidateIds: [] });
    const saved = await saveRecallCandidate('alice', { judgment: f.candidate.judgment, value: f.candidate.value,
      suggestedType: f.candidate.suggestedType, suggestedScope: f.candidate.suggestedScope,
      suggestedAction: f.candidate.suggestedAction, sourceRefs: f.refs, evidenceRefs: f.refs,
      captureProvenance: nextProof, rawStatement: true });
    expect(saved.id).toBe(f.candidate.id);
    expect(saved.captureProvenance).toEqual(f.proof);
    expect(await f.store.readRecallJsonRecord('alice', 'candidates', f.candidate.id)).toEqual(confirmed);
    expect(await f.store.readRecallJsonRecord('alice', 'ability-assets', existingAsset.id)).toEqual(existingAsset);
  });

});
