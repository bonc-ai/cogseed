import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {} }));
const semanticModel = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: semanticModel }));
let root: string, previous: string | undefined;
const user = 'ontology-only-user';
beforeEach(() => {
  vi.resetModules();
  semanticModel.mockReset().mockImplementation(async (_userId: string, input: { message: string }) => {
    const payload = JSON.parse(input.message);
    expect(payload.ruleSourceRequests).toEqual([expect.objectContaining({ recordId: 'source-rule' })]);
    const evidence = [{ label: 'm1', approvedQuoteIndex: 0 }];
    return { result: { text: JSON.stringify({ supported: true, noUnsupportedClaims: true,
      scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true, evidence,
      sourceRuleConclusions: [{ recordId: 'source-rule', status: 'resolved',
        expectedContract: { strength: 'suggestion', condition: null, effect: { kind: 'note' }, exception: '' },
        topicEvidence: evidence, fieldEvidence: { strength: evidence, condition: [], effect: [], exception: [] } }],
    }), meta: {} } };
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-only-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(async () => {
  await drainMainRuntimeForTest(user);
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'Synthetic user evidence' });
const rule = { kind: 'rule', moduleId: 'personal', name: '核对来源', requirement: '项目记录使用可核对的来源。',
  strength: 'suggestion', condition: null, effect: { kind: 'note' }, exception: '' };
async function fixture(target = 'source-rule', risk: 'low' | 'high' = 'low', autoApproval = false) {
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  const ontology = await import('../../../../src/main/features/cognition/ontology/service');
  const formation = await import('../../../../src/main/features/recall/ontology-formation');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  await bridge.replaceCognitionSources(user, { mode: 'unified', revision: 1,
    records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
  await ontology.commitOntologyCommand(user, { commandId: 'seed', expectedRevision: 0, actions: [
    create('personal', { kind: 'module', name: '我的本体', description: '', scope: { kind: 'personal' } }),
  ] });
  const raw = { reason: 'Synthetic explicitly approved independent rule', evidence: ['m1'], actions: [create(target, rule)] };
  const plan = formation.parseOntologyFormationProposal(ontology.readOntologyDocument(user), 'temporary', raw,
    '新增项目记录来源规则，后续核对记录时使用。', undefined, 'ontology')!;
  expect(plan.blockedReasons).toEqual([]);
  if (autoApproval) await settings.updateRecallCaptureSettings(user, { autoApproval: true });
  const candidate = await createNightlyCandidateFixture(user, { proposalTarget: 'ontology', formationProposalId: target,
    judgment: '新增项目记录来源规则，后续核对记录时使用。', summary: '本体来源规则', value: '后续项目记录使用可核对的来源，减少错误事实。',
    suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create', risk, sourceRefs: [], ontologyFormation: plan });
  if (autoApproval) {
    const store = await import('../../../../src/main/features/recall/store');
    await store.updateRecallJsonRecord(user, 'captures', candidate.captureProvenance!.captureId, async raw => ({ ...raw!,
      ...settings.captureAutoApprovalAuthorization(await settings.readRecallCaptureSettings(user)) }));
  }
  return { bridge, ontology, formation, candidates, candidate, settings };
}
describe('independent ontology proposals use the canonical formation chain', () => {
  it('confirms only ontology and its candidate, preserves a real receipt, and deduplicates a repeated confirmation', async () => {
    const f = await fixture();
    const captures = await import('../../../../src/main/features/recall/capture-service');
    const result = await captures.promoteRecallCaptureCandidate(user, f.candidate.id);
    expect(result.candidate).toMatchObject({ status: 'integrated', proposalTarget: 'ontology', ontologyHandoff: { recordIds: ['source-rule'] } });
    expect(result).not.toHaveProperty('asset');
    expect(result.candidate).not.toHaveProperty('promotedAssetId');
    const document = f.ontology.readOntologyDocument(user);
    expect(document.records['source-rule']).toMatchObject({ kind: 'rule', requirement: rule.requirement,
      source: { kind: 'candidate', recordId: f.candidate.id } });
    expect(document.receipts[f.candidate.ontologyFormation!.commandId].changedIds).toEqual(['source-rule']);
    expect(f.bridge.cognitionCompatibility(user)?.records['ability-assets']).toEqual({});
    await f.candidates.confirmRecallOntologyCandidate(user, f.candidate.id);
    expect(f.ontology.readOntologyDocument(user).revision).toBe(document.revision);
  });
  it('cannot be saved as a cognition or mixed into the batch asset path', async () => {
    const f = await fixture();
    await expect(f.candidates.promoteRecallCandidate(user, f.candidate.id, { actor: 'user' })).rejects.toThrow('ontology-only');
    const caps = await import('../../../../src/main/features/recall/candidate-capabilities');
    expect(caps.getRecallCandidateCapabilities(f.candidate)).toMatchObject({ canPromote: true, canBatchSelect: false });
    expect(f.ontology.readOntologyDocument(user).records['source-rule']).toBeUndefined();
  });
  it('does not let a rejected identical group block a fresh ontology review, and clears explicit uncertainty', async () => {
    const f = await fixture();
    await f.candidates.rejectRecallCandidate(user, f.candidate.id);
    const next = await createNightlyCandidateFixture(user, { proposalTarget: 'ontology', formationProposalId: 'fresh-group',
      captureKey: 'fresh-group', judgment: f.candidate.judgment, summary: f.candidate.summary, value: f.candidate.value,
      suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create', uncertainty: 'Needs review.', sourceRefs: [], ontologyFormation: f.candidate.ontologyFormation });
    await expect(f.candidates.confirmRecallOntologyCandidate(user, next.id)).rejects.toMatchObject({ code: 'ontology_meaning_unresolved' });
    const edited = await f.candidates.updateRecallCandidate(user, next.id, { judgment: next.judgment, summary: next.summary, value: next.value,
      suggestedType: next.suggestedType, suggestedScope: next.suggestedScope, uncertainty: '', sourceRefs: next.sourceRefs, evidenceRefs: next.evidenceRefs });
    expect(edited.uncertainty).toBeUndefined();
    const saved = await f.candidates.confirmRecallOntologyCandidate(user, next.id);
    expect(saved.candidate.status).toBe('integrated');
    expect(f.ontology.readOntologyDocument(user).records['source-rule'].source.recordId).toBe(next.id);
  });
  it('keeps groups with the same explanation and different ontology actions independently decidable', async () => {
    const f = await fixture();
    const plan = f.formation.parseOntologyFormationProposal(f.ontology.readOntologyDocument(user), 'temporary-2',
      { reason: 'Another independent source-grounded change', evidence: ['m1'], actions: [create('second-rule', { ...rule, name: '另一条来源规则' })] },
      f.candidate.judgment, undefined, 'ontology')!;
    const second = await createNightlyCandidateFixture(user, { proposalTarget: 'ontology', formationProposalId: 'second-rule',
      judgment: f.candidate.judgment, summary: f.candidate.summary, value: f.candidate.value, suggestedType: 'cognition',
      suggestedScope: 'general', suggestedAction: 'create', sourceRefs: [], ontologyFormation: plan });
    expect(second.id).not.toBe(f.candidate.id);
    await f.candidates.rejectRecallCandidate(user, f.candidate.id);
    const result = await f.candidates.confirmRecallOntologyCandidate(user, second.id);
    expect(result.candidate.status).toBe('integrated');
    expect(f.ontology.readOntologyDocument(user).records['source-rule']).toBeUndefined();
    expect(f.ontology.readOntologyDocument(user).records['second-rule']).toBeDefined();
  });
  it('refuses a changed ontology baseline without partially confirming the candidate', async () => {
    const f = await fixture();
    await f.ontology.commitOntologyCommand(user, { commandId: 'concurrent', expectedRevision: 1,
      actions: [create('concurrent-rule', { ...rule, name: '其他规则' })] });
    await expect(f.candidates.confirmRecallOntologyCandidate(user, f.candidate.id)).rejects.toMatchObject({ code: 'baseline_changed' });
    expect((await f.candidates.readRecallCandidate(user, f.candidate.id)).status).toBe('pending_review');
    expect(f.ontology.readOntologyDocument(user).records['source-rule']).toBeUndefined();
    expect(f.bridge.cognitionCompatibility(user)?.records['ability-assets']).toEqual({});
  });
  it('refuses revoked source authority and leaves the proposal intact', async () => {
    const f = await fixture();
    const controls = await import('../../../../src/main/features/recall/source-control');
    await controls.pauseCognitionSource(user, f.candidate.sourceRefs.find(ref => ref.subtype === 'session')!);
    await expect(f.candidates.confirmRecallOntologyCandidate(user, f.candidate.id)).rejects.toThrow();
    expect((await f.candidates.readRecallCandidate(user, f.candidate.id)).status).toBe('pending_review');
    expect(f.ontology.readOntologyDocument(user).records['source-rule']).toBeUndefined();
  });
  it('uses the saved independent required rule in both the actual query and write preflight, then stops using it after source revocation', async () => {
    const f = await fixture();
    const plan = f.formation.parseOntologyFormationProposal(f.ontology.readOntologyDocument(user), 'temporary-required',
      { reason: 'Synthetic explicit required report section', evidence: ['m1'], actions: [create('required-report', {
        ...rule, name: '报告风险项', requirement: '报告写入前包含完整风险部分。', strength: 'required',
        condition: { kind: 'task', field: 'taskKind', equals: 'write_file' }, effect: { kind: 'required_section', name: '风险' },
      })] }, f.candidate.judgment, undefined, 'ontology')!;
    const candidate = await createNightlyCandidateFixture(user, { proposalTarget: 'ontology', formationProposalId: 'required-report',
      judgment: '报告写入前需要完整的风险部分。', summary: '报告风险项', value: '后续报告写入前核对完整的风险说明。',
      suggestedType: 'cognition', suggestedScope: 'report', suggestedAction: 'create', sourceRefs: [], ontologyFormation: plan });
    await f.candidates.confirmRecallOntologyCandidate(user, candidate.id);
    const guard = await import('../../../../src/main/features/cognition/ontology/operation-guard');
    expect(await guard.checkOntologyMarkdownWrite(user, { operation: 'write_file', path: path.join(root, 'report.md'), content: '# 进展\n已完成。' }))
      .toMatchObject({ allowed: false });
    expect(await guard.checkOntologyMarkdownWrite(user, { operation: 'write_file', path: path.join(root, 'report.md'), content: '# 风险\n剩余风险需要跟进。' }))
      .toMatchObject({ allowed: true });
    const { createOntologyTools } = await import('../../../../src/main/model/core-agent/ontology-tools');
    const [tool] = createOntologyTools({ userId: user, turnId: 'independent-query', context: { taskText: '报告写入' } });
    const before = await tool.execute({ query: '风险', taskKind: 'write_file' });
    expect(before.isError).toBeUndefined();
    expect(JSON.parse(before.content).rules.some(row => row.source.recordId === 'required-report')).toBe(true);
    const comparisonBefore = await f.formation.buildSourceQualifiedOntologyFormationContext(user, f.ontology.readOntologyDocument(user), { queryText: '报告风险' });
    expect(comparisonBefore.records.some(row => row.id === 'required-report')).toBe(true);
    const controls = await import('../../../../src/main/features/recall/source-control');
    await controls.pauseCognitionSource(user, candidate.sourceRefs.find(ref => ref.subtype === 'session')!);
    const after = await tool.execute({ query: '风险', taskKind: 'write_file' });
    expect(JSON.parse(after.content).rules.some(row => row.source.recordId === 'required-report')).toBe(false);
    const comparisonAfter = await f.formation.buildSourceQualifiedOntologyFormationContext(user, f.ontology.readOntologyDocument(user), { queryText: '报告风险' });
    expect(comparisonAfter.records.some(row => row.id === 'required-report')).toBe(false);
    const comparison = await import('../../../../src/main/features/recall/ontology-automatic-comparison');
    const similarity = await import('../../../../src/main/features/recall/similarity');
    const embedding = vi.spyOn(similarity, 'embedForDedup');
    const replacementPlan = f.formation.parseOntologyFormationProposal(f.ontology.readOntologyDocument(user), 'replacement-rule',
      { reason: 'Synthetic separate rule', evidence: ['m1'], actions: [create('replacement-rule', { ...rule, name: '另一个来源规则' })] },
      f.candidate.judgment, undefined, 'ontology')!;
    expect(await comparison.independentOntologyComparisonReasons(user, { ...candidate, ontologyFormation: replacementPlan })).toEqual([]);
    expect(embedding).not.toHaveBeenCalled();
    embedding.mockRestore();
    expect(await guard.checkOntologyMarkdownWrite(user, { operation: 'write_file', path: path.join(root, 'report.md'), content: '# 进展\n已完成。' }))
      .toMatchObject({ allowed: true });
  });
  it('requires individual acknowledgment for high risk', async () => {
    const f = await fixture('source-rule', 'high');
    await expect(f.candidates.confirmRecallOntologyCandidate(user, f.candidate.id)).rejects.toThrow('high-risk');
    const saved = await f.candidates.confirmRecallOntologyCandidate(user, f.candidate.id, { riskAcknowledged: true });
    expect(saved.candidate.status).toBe('integrated');
  });
  it('does not let an explanation edit turn an ontology group into an asset update', async () => {
    const f = await fixture();
    await expect(f.candidates.updateRecallCandidate(user, f.candidate.id, { judgment: f.candidate.judgment,
      suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'update', targetAssetId: 'unrelated-asset',
      sourceRefs: f.candidate.sourceRefs })).rejects.toThrow('ontology-only edits');
    expect((await f.candidates.readRecallCandidate(user, f.candidate.id)).targetAssetId).toBeUndefined();
  });
  it('keeps relevant A/R and their required definitions inside a tight context instead of filling it with unrelated T', async () => {
    const f = await fixture();
    await f.ontology.commitOntologyCommand(user, { commandId: 'context-records', expectedRevision: 1, actions: [
      ...Array.from({ length: 18 }, (_, index) => create(`unrelated-${index}`, { kind: 'definition', moduleId: 'personal',
        name: `不相关的概念 ${index}`, description: '仅用于不相关领域的结构说明。'.repeat(20), definitionKind: 'type',
        subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' })),
      create('report-rule', { ...rule, name: '风险周报要求', requirement: '周报先列风险和负责人。' }),
      create('other-project', { kind: 'module', name: '另一项目', description: '', scope: { kind: 'project', id: 'project-b' } }),
      create('private-rule', { ...rule, moduleId: 'other-project', name: '风险周报要求', requirement: '另一项目私有内容。' }),
    ] });
    const context = f.formation.buildOntologyFormationContext(user, f.ontology.readOntologyDocument(user),
      { queryText: '风险周报要求', projectId: 'project-a', scopeBound: true, maxChars: 1400 });
    expect(context.records.map(record => record.id)).toContain('report-rule');
    expect(context.records.map(record => record.id)).toContain('personal');
    expect(context.records.map(record => record.id)).not.toContain('private-rule');
    expect(context.truncated).toBe(true);
  });
  it('automatically confirms a supported independent rule under the fresh grant, without making an asset or granting user review', async () => {
    const f = await fixture('source-rule', 'low', true);
    const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
    const result = await policy.tryAutomaticallyApproveRecallCandidate(user, f.candidate.id);
    expect(result).toMatchObject({ approved: true, candidate: { status: 'integrated', autoReview: { eligible: true } }, reasons: [] });
    expect(result.asset).toBeUndefined();
    expect(f.bridge.cognitionCompatibility(user)?.records['ability-assets']).toEqual({});
    const decisions = await import('../../../../src/main/features/cognition/review-decision');
    expect(await decisions.readReviewDecision(user, `recall_candidate:${result.candidate.id}`, result.candidate.reviewDecisionId!)).toMatchObject({ actor: 'system' });
    expect(semanticModel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(semanticModel.mock.calls[0][1].message).candidate.proposalTarget).toBe('ontology');
    const repeated = await policy.tryAutomaticallyApproveRecallCandidate(user, f.candidate.id);
    expect(repeated).toMatchObject({ approved: false, reasons: ['already_confirmed'] });
    expect(semanticModel).toHaveBeenCalledTimes(1);
  });
  it('previews and atomically undoes an independent automatic save while preserving both decisions and history', async () => {
    const f = await fixture('source-rule', 'low', true);
    const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
    const approved = await policy.tryAutomaticallyApproveRecallCandidate(user, f.candidate.id);
    expect(approved.approved).toBe(true);
    const undo = await import('../../../../src/main/features/recall/automatic-formation-undo');
    const preview = await undo.previewAutomaticFormationUndo(user, f.candidate.id);
    expect(preview.assetChange).toBeUndefined();
    expect(preview.ontologyChanges).toEqual([expect.objectContaining({ before: expect.objectContaining({ status: 'active' }),
      after: expect.objectContaining({ status: 'archived', version: 2 }) })]);
    expect(f.ontology.readOntologyDocument(user).records['source-rule'].status).toBe('active');
    const result = await undo.undoAutomaticFormation(user, f.candidate.id, preview.token);
    expect(result.candidate.automaticUndo).toMatchObject({ originalDecisionId: approved.candidate.reviewDecisionId });
    const doc = f.ontology.readOntologyDocument(user);
    expect(doc.records['source-rule']).toMatchObject({ status: 'archived', version: 2 });
    expect(doc.receipts[f.candidate.ontologyFormation!.commandId]).toBeDefined();
    expect(doc.receipts[result.candidate.automaticUndo!.commandId]).toBeDefined();
    expect(await undo.undoAutomaticFormation(user, f.candidate.id, preview.token)).toMatchObject({ alreadyUndone: true });
    expect(f.ontology.readOntologyDocument(user).revision).toBe(doc.revision);
    const decisions = await import('../../../../src/main/features/cognition/review-decision');
    expect(await decisions.readReviewDecision(user, `recall_candidate:${f.candidate.id}`, result.candidate.automaticUndo!.decisionId))
      .toMatchObject({ actor: 'user', decision: 'undo_automatic_save', supersedes_ref: approved.candidate.reviewDecisionId });
    expect(semanticModel).toHaveBeenCalledTimes(1);
  });
  it('does not undo a new ontology record that another module now references', async () => {
    const f = await fixture('source-rule', 'low', true);
    const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
    await policy.tryAutomaticallyApproveRecallCandidate(user, f.candidate.id);
    const doc = f.ontology.readOntologyDocument(user);
    await f.ontology.commitOntologyCommand(user, { commandId: 'later-reference', expectedRevision: doc.revision, actions: [
      create('other', { kind: 'module', name: 'Later user module', description: '', scope: { kind: 'personal' } }),
      create('later-rule-reference', { kind: 'reference', moduleId: 'other', targetModuleId: 'personal', targetRecordId: 'source-rule', versionPolicy: 'current' }),
    ] });
    const undo = await import('../../../../src/main/features/recall/automatic-formation-undo');
    await expect(undo.previewAutomaticFormationUndo(user, f.candidate.id)).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(f.ontology.readOntologyDocument(user).records['source-rule'].status).toBe('active');
    expect((await f.candidates.readRecallCandidate(user, f.candidate.id)).automaticUndo).toBeUndefined();
  });
  it('refuses automatic undo after a later ontology edit without partially changing the candidate', async () => {
    const f = await fixture('source-rule', 'low', true);
    const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
    await policy.tryAutomaticallyApproveRecallCandidate(user, f.candidate.id);
    const undo = await import('../../../../src/main/features/recall/automatic-formation-undo');
    const preview = await undo.previewAutomaticFormationUndo(user, f.candidate.id);
    const doc = f.ontology.readOntologyDocument(user);
    await f.ontology.commitOntologyCommand(user, { commandId: 'later-user-edit', expectedRevision: doc.revision,
      actions: [{ intent: 'update', recordId: 'source-rule', expectedVersion: 1,
        patch: { requirement: 'The user has refined this rule after its original save.' }, sourceLabel: 'Later explicit edit' }] });
    await expect(undo.undoAutomaticFormation(user, f.candidate.id, preview.token)).rejects.toMatchObject({ code: 'baseline_changed' });
    expect((await f.candidates.readRecallCandidate(user, f.candidate.id)).automaticUndo).toBeUndefined();
    expect(f.ontology.readOntologyDocument(user).records['source-rule'].version).toBe(2);
  });
  it('does not use an old grant after automatic confirmation is disabled during semantic support', async () => {
    const f = await fixture('source-rule', 'low', true);
    const accepted = semanticModel.getMockImplementation()!;
    semanticModel.mockImplementationOnce(async (...args) => {
      await f.settings.updateRecallCaptureSettings(user, { autoApproval: false });
      return accepted(...args);
    });
    const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
    const result = await policy.tryAutomaticallyApproveRecallCandidate(user, f.candidate.id);
    expect(result.approved).toBe(false);
    expect(f.ontology.readOntologyDocument(user).records['source-rule']).toBeUndefined();
    expect((await f.candidates.readRecallCandidate(user, f.candidate.id)).status).toBe('pending_review');
  });
});
