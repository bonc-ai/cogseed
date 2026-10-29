import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import type { SaveRecallCandidateInput } from '../../../../src/main/features/recall/candidate-service';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
vi.mock('../../../../src/main/features/auth', () => ({ listEntriesForUser: async () => ({ entries: [{ provider: 'configured-provider', model: 'configured-check-model' }] }) }));

vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {} }));
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({ suggestAbilityAssetTitle: async () => ({ title: '技术说明表达偏好' }) }));
vi.mock('../../../../src/main/features/kb_embed', () => ({ closeEmbedder: vi.fn(), embedQuery: async () => { throw new Error('optional embedding unavailable'); } }));
const run = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: run }));
let root: string, previous: string | undefined;
const accepted = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
  priorContentPreserved: true, evidence: [{ label: 'm1', quote: '解释复杂问题时长期偏好先给结论' }] };
const source = '我以后解释复杂问题时长期偏好先给结论，再说明关键理由和依据，并明确标注尚未验证的部分；只适用于我自己的技术说明。';
const inflated = `${source}这也表示另一位成员同样偏好此顺序。`;
beforeEach(() => { vi.resetModules(); run.mockReset().mockResolvedValue({ result: { text: JSON.stringify(accepted), meta: {} } }); root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-semantic-support-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(async () => { await drainMainRuntimeForTest('alice'); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function supportReceipts() {
  const { recallJsonRecordPath } = await import('../../../../src/main/features/recall/paths');
  const directory = path.dirname(recallJsonRecordPath('alice', 'automatic-source-support', 'placeholder'));
  return fs.existsSync(directory) ? fs.readdirSync(directory).map(file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))) : [];
}
async function fixture(judgment = inflated, overrides: Partial<SaveRecallCandidateInput> = {}, sourceText = source) {
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const store = await import('../../../../src/main/features/recall/store');
  const summaryTools = await import('../../../../src/main/features/recall/capture-context-summary');
  const provenance = await import('../../../../src/main/features/recall/capture-provenance');
  const layout = await import('../../../../src/main/util/project-layout');
  await settings.updateRecallCaptureSettings('alice', { autoApproval: true });
  let candidate = await createNightlyCandidateFixture('alice', { judgment, value: '以后表达技术说明时保留明确的依据与范围。', summary: '技术说明表达偏好', suggestedType: 'personal', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [], rawStatement: true, ...overrides });
  const capture = (await store.readRecallJsonRecord('alice', 'captures', candidate.captureProvenance!.captureId))!;
  const messageId = candidate.captureProvenance!.messageIds[0];
  const messages = [{ id: messageId, role: 'user', text: sourceText, discovery: true }];
  fs.writeFileSync(layout.conversationMessageFile('alice', String(capture.conversationId)), `${JSON.stringify({ id: messageId, ts: String(capture.createdAt), from: 'user', to: ['commander'], text: sourceText })}\n`);
  const summary = summaryTools.validateCaptureContextSummary({ ...capture.contextSummary as any,
    sourceDigest: summaryTools.captureContextSourceDigest(messages),
    topics: [{ title: '长期技术说明偏好', content: sourceText, conditions: ['仅自己的技术说明'], unresolved: [], attribution: 'user_requirement', evidence: [{ messageId, role: 'user', quote: sourceText, start: 0, end: sourceText.length }] }],
    coverage: { ...(capture.contextSummary as any).coverage, sourceChars: sourceText.length, maxInputChars: Math.max(4000, 1000 + sourceText.length * 8) } }, messages);
  const proof = candidate.captureProvenance!;
  const valueJudgment = { ...proof.valueJudgment, evidence: proof.valueJudgment.evidence.map(item => ({ ...item, quote: sourceText })), summaryDigest: provenance.captureSummaryDecisionDigest(summary) };
  await store.writeRecallJsonRecord('alice', 'captures', capture.id, { ...capture, contextSummary: summary, valueJudgment,
    ...settings.captureAutoApprovalAuthorization(await settings.readRecallCaptureSettings('alice')) });
  candidate = { ...candidate, captureProvenance: { ...proof, valueJudgment } };
  await store.writeRecallJsonRecord('alice', 'candidates', candidate.id, candidate);
  const { invalidateConversationCaches } = await import('../../../../src/main/features/chats');
  invalidateConversationCaches('alice');
  return { candidate, store, settings, capture, messageId, layout }; 
}
it('holds a high-overlap unsupported subject even though the extraction lexical gate accepts it', async () => {
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, supported: false, noUnsupportedClaims: false }), meta: {} } });
  const { candidate } = await fixture();
  const lexical = await import('../../../../src/main/features/recall/capture-value-screening');
  expect(lexical.isRecallCaptureCandidateGrounded({ ...candidate, valueProvided: true, actionProvided: true }, [{ id: 'm1', role: 'user', text: source, artifacts: [] }])).toBe(true);
  const { evaluateNightlyAutomaticApproval } = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect(await evaluateNightlyAutomaticApproval('alice', candidate)).toMatchObject({ eligible: false, reasons: ['candidate_semantic_support_failed'] });
});

it('accepts a faithful paraphrase and reuses only the exact persisted assessment across promotion and retry', async () => {
  const f = await fixture('以后为用户本人解释技术问题，应采用结论优先的表达顺序，随后陈述理由、依据，并区分已验证和未验证部分。', { suggestedType: 'cognition' });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.reasons).toEqual([]);
  expect(result).toMatchObject({ approved: true, candidate: { status: 'confirmed' }, asset: { lifecycleStatus: 'automatically_extracted_unverified', maturity: 'bud' } });
  await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(run).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(run.mock.calls[0][1].message);
  expect(payload.completeConversationContext[0].text).toBe(source);
  expect(payload.approvedUserSources[0].approvedQuotes).toEqual([source]);
  const receipts = await supportReceipts();
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ method: 'model_assisted', modelCompleted: true, candidateId: f.candidate.id });
  expect(JSON.stringify(receipts)).not.toContain(source);
  expect(JSON.stringify(receipts)).not.toContain(f.candidate.judgment);
  expect(receipts[0].evidence).toEqual([expect.objectContaining({ start: expect.any(Number), end: expect.any(Number), quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
});

it('does not invoke a model inside a locked gate without a matching persisted observation', async () => {
  const f = await fixture(source);
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  await expect(policy.requireNightlyAutomaticApproval('alice', f.candidate)).rejects.toMatchObject({ reasons: ['candidate_semantic_support_unavailable'] });
  expect(run).not.toHaveBeenCalled();
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  await expect(policy.requireNightlyAutomaticApproval('alice', f.candidate)).resolves.toMatchObject({ eligible: true });
  expect(run).toHaveBeenCalledTimes(1);
});

it('invalidates a previously supported assessment when body or access scope changes', async () => {
  const f = await fixture(source);
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  for (const patch of [{ judgment: inflated }, { scopePolicy: { workspaceIds: ['workspace-new'] } }]) {
    await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, { ...f.candidate, ...patch });
    const fresh = await candidates.readRecallCandidate('alice', f.candidate.id);
    await expect(policy.requireNightlyAutomaticApproval('alice', fresh)).rejects.toMatchObject({ reasons: ['candidate_semantic_support_unavailable'] });
  }
  expect(run).toHaveBeenCalledTimes(1);
});

it.each(['supported', 'noUnsupportedClaims', 'scopePreserved', 'finalDecisionPreserved', 'priorContentPreserved'])('retains the same pending candidate when semantic %s is false', async key => {
  const f = await fixture(source);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, [key]: false }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: false, candidate: { id: f.candidate.id, status: 'pending_review' }, reasons: ['candidate_semantic_support_failed'] });
  expect(await supportReceipts()).toEqual([]);
});

it.each([{ error: { kind: 'network' } }, { aborted: true }])('holds interrupted model output without persisting an authorization: %j', async meta => {
  const f = await fixture(source);
  run.mockResolvedValue({ result: { text: JSON.stringify(accepted), meta } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect(await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).toMatchObject({ approved: false, candidate: { status: 'pending_review' }, reasons: ['candidate_semantic_support_unavailable'] });
  expect(await supportReceipts()).toEqual([]);
});

it('rejects a fabricated model evidence quote even when every declared semantic check is true', async () => {
  const f = await fixture(source);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, evidence: [{ label: 'm1', quote: '另一位成员明确授权此偏好。' }] }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).reasons).toEqual(['candidate_semantic_support_unavailable']);
});

it.each(['candidate', 'scope', 'epoch', 'source_permission', 'source_text'])('discards support when %s changes while the independent model is waiting', async change => {
  const f = await fixture(source);
  run.mockImplementationOnce(async () => {
    if (change === 'candidate' || change === 'scope') await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id,
      { ...f.candidate, ...(change === 'candidate' ? { judgment: inflated } : { scopePolicy: { workspaceIds: ['workspace-new'] } }) });
    if (change === 'epoch') await f.settings.updateRecallCaptureSettings('alice', { autoApproval: false });
    if (change === 'source_permission') {
      const control = await import('../../../../src/main/features/recall/source-control');
      await control.pauseCognitionSource('alice', f.candidate.sourceRefs[0]);
    }
    if (change === 'source_text') fs.writeFileSync(f.layout.conversationMessageFile('alice', String(f.capture.conversationId)),
      JSON.stringify({ id: f.messageId, ts: String(f.capture.createdAt), from: 'user', to: ['commander'], text: `${source}最后更正：这项偏好已撤回。` }) + '\n');
    return { result: { text: JSON.stringify(accepted), meta: {} } };
  });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.approved).toBe(false);
  expect(result.candidate.status).toBe('pending_review');
  expect(await supportReceipts()).toEqual([]);
});

it('shares one independent model check for parallel evaluations of an unchanged candidate', async () => {
  const f = await fixture(source);
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const results = await Promise.all([policy.evaluateNightlyAutomaticApproval('alice', f.candidate), policy.evaluateNightlyAutomaticApproval('alice', f.candidate)]);
  expect(results.every(result => result.eligible)).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
});

const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'Synthetic approved user evidence' });
async function withJointPlan(assertionText = source, exception = '', sourceText = source) {
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  const ontology = await import('../../../../src/main/features/cognition/ontology/service');
  const formation = await import('../../../../src/main/features/recall/ontology-formation');
  await bridge.replaceCognitionSources('alice', { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
  await ontology.commitOntologyCommand('alice', { commandId: 'seed', expectedRevision: 0, actions: [
    create('personal', { kind: 'module', name: 'Synthetic personal module', description: '', scope: { kind: 'personal' } }),
    create('person-type', { kind: 'definition', moduleId: 'personal', name: 'Synthetic person type', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('self', { kind: 'entity', moduleId: 'personal', typeId: 'person-type', name: 'Synthetic user', description: '', aliases: [], identityStatus: 'confirmed' }),
    create('preference', { kind: 'definition', moduleId: 'personal', name: 'Synthetic preference', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
  ] });
  const f = await fixture(sourceText, { suggestedType: 'cognition' }, sourceText);
  const plan = formation.parseOntologyFormationProposal(ontology.readOntologyDocument('alice'), f.candidate.id, { reason: 'Synthetic approved preference and guidance', evidence: ['m1'], actions: [
    create('expression', { kind: 'assertion', moduleId: 'personal', subjectId: 'self', definitionId: 'preference', object: { kind: 'literal', valueType: 'text', value: assertionText }, validity: { from: null, until: null, precision: 'day', timezone: 'Asia/Shanghai' }, certainty: 'confirmed' }),
    create('guidance', { kind: 'rule', moduleId: 'personal', name: 'Synthetic guidance', requirement: sourceText, strength: 'default', condition: null, effect: { kind: 'note' }, exception }),
  ], refs: [{ moduleId: 'personal', recordId: 'guidance', versionPolicy: 'current', sharedBody: true }] }, sourceText)!;
  expect(plan.requiresTReview).toBe(false); expect(plan.blockedReasons).toEqual([]);
  f.candidate = { ...f.candidate, ontologyFormation: plan };
  await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, f.candidate);
  const sourceRuleConclusions = [{ recordId: 'guidance', status: 'resolved',
    expectedContract: { strength: 'default', condition: null, effect: { kind: 'note' }, exception },
    topicEvidence: [{ label: 'm1', quote: sourceText }], fieldEvidence: { strength: [{ label: 'm1', quote: sourceText }],
      condition: [], effect: [], exception: exception ? [{ label: 'm1', quote: sourceText }] : [] } }];
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, sourceRuleConclusions }), meta: {} } });
  return { ...f, ontology, sourceRuleConclusions };
}

it('holds a rule-strength downgrade even when the complete cognition is exact source text and never repairs a persisted automatic proposal', async () => {
  const mandatory = '部署评审必须写风险和回退条件；普通例会不加这两栏。';
  const f = await withJointPlan(mandatory, '普通例会不适用', mandatory);
  run.mockImplementation(async (_user, request) => {
    const payload = JSON.parse(request.message);
    expect(payload.completeConversationContext[0].text).toBe(mandatory);
    expect(payload.candidate.ontologyFormation.actions.find(action => action.recordId === 'guidance').record.strength).toBeUndefined();
    expect(payload.ruleSourceRequests[0].recordId).toBe('guidance');
    expect(request.systemPrompt).toContain('Never weaken an obligation');
    expect(request.systemPrompt).toContain('check is read-only');
    return { result: { text: JSON.stringify({ ...accepted, evidence: [{ label: 'm1', quote: mandatory }],
      sourceRuleConclusions: [{ ...f.sourceRuleConclusions[0], expectedContract: { ...f.sourceRuleConclusions[0].expectedContract, strength: 'required' } }] }), meta: {} } };
  });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: false, candidate: { status: 'pending_review' }, reasons: ['candidate_semantic_support_failed'] });
  expect(result.candidate.ontologyFormation!.actions.find(action => action.recordId === 'guidance')).toMatchObject({ record: { strength: 'default', effect: { kind: 'note' } } });
  expect(await supportReceipts()).toEqual([]);
  expect(f.ontology.readOntologyDocument('alice').records.guidance).toBeUndefined();
});

it.each(['missing', 'duplicate', 'difference', 'not_supported', 'old_ruleChecks'])('holds an otherwise true automatic assessment with %s source proof without rewriting the plan', async mode => {
  const f = await withJointPlan();
  const check = f.sourceRuleConclusions[0];
  const sourceRuleConclusions = ['missing', 'old_ruleChecks'].includes(mode) ? undefined : mode === 'duplicate' ? [check, check]
    : mode === 'difference' ? [{ ...check, expectedContract: { ...check.expectedContract, strength: 'required' } }]
      : [{ recordId: check.recordId, status: 'not_supported', reason: 'Different topic has no adoption.' }];
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, ...(sourceRuleConclusions ? { sourceRuleConclusions } : {}),
    ...(mode === 'old_ruleChecks' ? { ruleChecks: [] } : {}) }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: false, candidate: { status: 'pending_review' } });
  expect(result.reasons).toEqual([['difference', 'not_supported'].includes(mode) ? 'candidate_semantic_support_failed' : 'candidate_semantic_support_unavailable']);
  expect(result.candidate.ontologyFormation!.actions.find(action => action.recordId === 'guidance')).toMatchObject({ record: { strength: 'default' } });
  expect(await supportReceipts()).toEqual([]);
  expect(f.ontology.readOntologyDocument('alice').records.guidance).toBeUndefined();
});

it.each([['unsupported A meaning', '另一位成员长期偏好此回答结构。', ''], ['unsupported R exception', source, '紧急时一律省略必要证据和未验证标记。']])('reviews full joint plan and holds %s even when the cognition body is exact source text', async (_label, assertion, exception) => {
  const f = await withJointPlan(assertion, exception);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, sourceRuleConclusions: f.sourceRuleConclusions, noUnsupportedClaims: false }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: false, candidate: { status: 'pending_review' }, reasons: ['candidate_semantic_support_failed'] });
  const payload = JSON.parse(run.mock.calls[0][1].message);
  expect(payload.candidate.ontologyFormation.actions.find(action => action.recordId === 'expression')).toEqual(f.candidate.ontologyFormation!.actions.find(action => action.recordId === 'expression'));
  expect(payload.candidate.ontologyFormation.actions.find(action => action.recordId === 'guidance').record.strength).toBeUndefined();
  expect(payload.ontology.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'self' }), expect.objectContaining({ id: 'preference' })]));
  expect(f.ontology.readOntologyDocument('alice').records.expression).toBeUndefined();
});

it('automatically commits a supported joint A/R plan while reusing only one semantic observation', async () => {
  const f = await withJointPlan();
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.reasons).toEqual([]); expect(result.approved).toBe(true);
  expect(f.ontology.readOntologyDocument('alice').records.expression).toMatchObject({ object: { value: source } });
  expect(f.ontology.readOntologyDocument('alice').records.guidance).toMatchObject({ requirement: source });
  expect(run).toHaveBeenCalledTimes(1);
});

it('reuses source meaning but holds a changed full R draft instead of recycling its old approval receipt', async () => {
  const f = await withJointPlan();
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  const originalReceipts = await supportReceipts();
  expect(originalReceipts).toHaveLength(1);
  const changed = structuredClone(f.candidate);
  const { parseOntologyFormationProposal } = await import('../../../../src/main/features/recall/ontology-formation');
  const actions = structuredClone(changed.ontologyFormation!.actions);
  (actions.find(action => action.recordId === 'guidance') as any).record.strength = 'required';
  changed.ontologyFormation = parseOntologyFormationProposal(f.ontology.readOntologyDocument('alice'), changed.id,
    { reason: changed.ontologyFormation!.reason, evidence: changed.ontologyFormation!.evidence,
      actions, refs: changed.ontologyFormation!.refs }, changed.judgment, changed.ontologyFormation!.previewChanges[0].after.updatedAt!)!;
  expect(changed.ontologyFormation.blockedReasons).toEqual([]);
  await f.store.writeRecallJsonRecord('alice', 'candidates', changed.id, changed);
  const result = await policy.evaluateNightlyAutomaticApproval('alice', changed);
  expect(result).toMatchObject({ eligible: false, reasons: ['candidate_semantic_support_failed'] });
  expect(run).toHaveBeenCalledTimes(1); // source conclusion, not grant, is reused
  expect(await supportReceipts()).toEqual(originalReceipts);
  const persisted = (await f.store.readRecallJsonRecord('alice', 'candidates', changed.id))!;
  expect((persisted.ontologyFormation as any).actions.find(action => action.recordId === 'guidance').record.strength).toBe('required');
  expect(f.ontology.readOntologyDocument('alice').records.guidance).toBeUndefined();
});

it('binds cached support to every joint-plan field and canonical ontology revision', async () => {
  const f = await withJointPlan();
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  const formation = structuredClone(f.candidate.ontologyFormation!);
  formation.reason += ' altered joint scope';
  const changed = { ...f.candidate, ontologyFormation: formation };
  await f.store.writeRecallJsonRecord('alice', 'candidates', changed.id, changed);
  await expect(policy.requireNightlyAutomaticApproval('alice', changed)).rejects.toMatchObject({ reasons: ['candidate_semantic_support_unavailable'] });
  await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, f.candidate);
  await f.ontology.commitOntologyCommand('alice', { commandId: 'concurrent-ontology-edit', expectedRevision: f.ontology.readOntologyDocument('alice').revision,
    actions: [{ intent: 'update', recordId: 'personal', expectedVersion: 1, sourceLabel: 'Synthetic edit', patch: { description: 'Concurrent updated canonical meaning' } }] });
  await expect(policy.requireNightlyAutomaticApproval('alice', f.candidate)).rejects.toMatchObject({ reasons: ['ontology_baseline_changed'] });
  expect(run).toHaveBeenCalledTimes(1);
});

it('rejects a cached check whose evidence coordinates have been replaced', async () => {
  const f = await fixture(source);
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  const [receipt] = await supportReceipts();
  await f.store.writeRecallJsonRecord('alice', 'automatic-source-support', receipt.id, { ...receipt,
    evidence: receipt.evidence.map((ref: Record<string, unknown>) => ({ ...ref, start: 0, end: source.length + 1 })) });
  await expect(policy.requireNightlyAutomaticApproval('alice', f.candidate)).rejects.toMatchObject({ reasons: ['candidate_semantic_support_unavailable'] });
  expect(run).toHaveBeenCalledTimes(1);
});

it('uses the configured model order and never turns its check into human confirmation', async () => {
  const f = await fixture(source);
  const configured = [{ provider: 'configured-provider', model: 'configured-check-model' }];
  await f.settings.updateRecallCaptureSettings('alice', { modelCandidates: configured });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  expect(run.mock.calls[0][1].modelCandidates).toEqual(configured);
  await expect((await import('../../../../src/main/features/recall/candidate-service')).readRecallCandidate('alice', f.candidate.id))
    .resolves.toMatchObject({ status: 'pending_review' });
});

it('checks complete revised content against the real target and publishes the checked body unchanged', async () => {
  const first = await fixture(source, { suggestedType: 'cognition' });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const initial = await policy.tryAutomaticallyApproveRecallCandidate('alice', first.candidate.id);
  expect(initial.approved).toBe(true);
  const revision = '我长期偏好技术说明采用结论优先的顺序，再说明关键依据和未验证之处，适用范围仅限我自己。';
  const f = await fixture(revision, { suggestedType: 'cognition', suggestedAction: 'update', targetAssetId: initial.asset!.id, targetVersionUsed: '1' });
  run.mockClear();
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.reasons).toEqual([]);
  expect(result).toMatchObject({ approved: true, asset: { id: initial.asset!.id, version: '2', statement: revision } });
  expect(run).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(run.mock.calls[0][1].message);
  expect(payload.existingTarget).toMatchObject({ id: initial.asset!.id, version: '1', statement: source });
});

it('discards an independent check if its target baseline changes while the model waits', async () => {
  const first = await fixture(source, { suggestedType: 'cognition' });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const initial = await policy.tryAutomaticallyApproveRecallCandidate('alice', first.candidate.id);
  expect(initial.approved).toBe(true);
  const f = await fixture('我长期偏好技术说明结论先行，保留依据和未验证标记，且仅用于自己的说明。', {
    suggestedType: 'cognition', suggestedAction: 'update', targetAssetId: initial.asset!.id, targetVersionUsed: '1' });
  const assets = await import('../../../../src/main/features/recall/asset-service');
  run.mockImplementationOnce(async () => {
    await assets.updateAbilityAsset('alice', initial.asset!.id, { actor: 'user', expectedVersion: '1', statement: '用户明确修改后的技术说明偏好。', reason: 'Synthetic concurrent revision' });
    return { result: { text: JSON.stringify(accepted), meta: {} } };
  });
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: false, candidate: { status: 'pending_review' }, reasons: ['candidate_semantic_support_changed'] });
  expect((await assets.readAbilityAsset('alice', initial.asset!.id)).statement).toBe('用户明确修改后的技术说明偏好。');
});

// Keep the source-bound summary intact while changing only its uncertainty
// observation. Updating the real value proof prevents testing a stale fixture.
async function withSummaryUnresolved<T extends Awaited<ReturnType<typeof fixture>>>(f: T, unresolved: string[]) {
  const provenance = await import('../../../../src/main/features/recall/capture-provenance');
  const capture = (await f.store.readRecallJsonRecord('alice', 'captures', f.candidate.captureProvenance!.captureId))!;
  const summary = { ...capture.contextSummary as any, topics: (capture.contextSummary as any).topics.map((topic: any) => ({ ...topic, unresolved })) };
  const valueJudgment = { ...f.candidate.captureProvenance!.valueJudgment, summaryDigest: provenance.captureSummaryDecisionDigest(summary) };
  await f.store.writeRecallJsonRecord('alice', 'captures', capture.id, { ...capture, contextSummary: summary, valueJudgment });
  f.candidate = { ...f.candidate, captureProvenance: { ...f.candidate.captureProvenance!, valueJudgment } };
  await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, f.candidate);
  return { ...f, summary };
}

it.each(['effect_unverified', 'outside_claim_scope', 'source_attribution_only'])('uses final independent %s classification for relevant summary uncertainty without altering the summary', async uncertaintyDisposition => {
  const f = await withSummaryUnresolved(await withJointPlan(), ['效果未改善（非待确认事项）']);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, sourceRuleConclusions: f.sourceRuleConclusions, uncertaintyDisposition }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.reasons).toEqual([]); expect(result.approved).toBe(true);
  expect(result.asset).toMatchObject({ maturity: 'bud', lifecycleStatus: 'automatically_extracted_unverified' });
  expect(run).toHaveBeenCalledTimes(1); // Commit is cached-only, never another classification.
  const payload = JSON.parse(run.mock.calls[0][1].message);
  expect(payload.relevantSummaryUnresolved).toEqual([{ topicIndex: 0, items: ['效果未改善（非待确认事项）'] }]);
  expect(payload.summary).toEqual(f.summary);
  expect(payload.candidate.ontologyFormation.refs).toEqual(f.candidate.ontologyFormation!.refs);
  expect(payload.candidate.ontologyFormation.actions.find(action => action.recordId === 'guidance').record.strength).toBeUndefined();
  expect(payload.completeConversationContext[0].text).toBe(source);
  const [receipt] = await supportReceipts();
  expect(receipt.summaryUncertainty).toEqual({ disposition: uncertaintyDisposition, unresolvedDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(receipt.checks).toMatchObject({ supported: true, scopePreserved: true, priorContentPreserved: true });
  expect(JSON.stringify(receipt)).not.toContain('效果未改善');
  const capture = (await f.store.readRecallJsonRecord('alice', 'captures', f.capture.id))!;
  expect(capture.contextSummary).toEqual(f.summary);
  expect(f.ontology.readOntologyDocument('alice').records.guidance).toMatchObject({ requirement: source });
});

it.each([
  ['missing disposition', accepted],
  ['unknown disposition', { ...accepted, uncertaintyDisposition: 'non_blocking' }],
  ['mixed identity and effectiveness unresolved', { ...accepted, uncertaintyDisposition: 'content_unresolved' }],
  ['nonblocking classification with failed scope', { ...accepted, uncertaintyDisposition: 'effect_unverified', scopePreserved: false }],
  ['nonliteral evidence', { ...accepted, uncertaintyDisposition: 'effect_unverified', evidence: [{ label: 'm1', quote: '伪造的效果来源' }] }],
])('keeps summary uncertainty manual for %s rather than trusting an old candidate observation', async (_label, response) => {
  const f = await withSummaryUnresolved(await fixture(source), ['效果尚未验证；适用对象身份仍待确认。']);
  await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, { ...f.candidate,
    autoReview: { eligible: true, reasons: [], checkedAt: new Date().toISOString(), policyVersion: 1 } });
  run.mockResolvedValue({ result: { text: JSON.stringify(response), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.approved).toBe(false); expect(result.candidate.status).toBe('pending_review');
  expect(result.reasons).toContain('conversation_has_unresolved_questions');
  expect(await supportReceipts()).toEqual([]);
});

it.each(['missing', 'content_unresolved', 'wrong_digest'])('rejects %s cached summary disposition without calling a model inside the locked gate', async tampering => {
  const f = await withSummaryUnresolved(await fixture(source), ['效果尚未验证。']);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, uncertaintyDisposition: 'effect_unverified' }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  const [receipt] = await supportReceipts();
  const changed = { ...receipt };
  if (tampering === 'missing') delete changed.summaryUncertainty;
  else changed.summaryUncertainty = { ...changed.summaryUncertainty,
    ...(tampering === 'wrong_digest' ? { unresolvedDigest: '0'.repeat(64) } : { disposition: 'content_unresolved' }) };
  await f.store.writeRecallJsonRecord('alice', 'automatic-source-support', receipt.id, changed);
  await expect(policy.requireNightlyAutomaticApproval('alice', f.candidate)).rejects.toMatchObject({ reasons: ['candidate_semantic_support_unavailable', 'conversation_has_unresolved_questions'] });
  expect(run).toHaveBeenCalledTimes(1);
});

it('invalidates classified support when the relevant unresolved items change during model waiting', async () => {
  const f = await withSummaryUnresolved(await fixture(source), ['效果尚未验证。']);
  run.mockImplementationOnce(async () => {
    await withSummaryUnresolved(f, ['效果尚未验证；适用范围待确认。']);
    return { result: { text: JSON.stringify({ ...accepted, uncertaintyDisposition: 'effect_unverified' }), meta: {} } };
  });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.approved).toBe(false); expect(await supportReceipts()).toEqual([]);
  expect(result.reasons).toContain('candidate_semantic_support_changed');
});

it('does not call the summary classifier when another hard approval gate is blocked', async () => {
  const f = await withSummaryUnresolved(await fixture(source, { risk: 'medium' }), ['效果尚未验证。']);
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).reasons).toContain('risk_requires_individual_review');
  expect(run).not.toHaveBeenCalled();
});

it.each([{ error: { kind: 'provider_unavailable' } }, { aborted: true }])('holds an unavailable final summary classifier without an authorization receipt: %j', async meta => {
  const f = await withSummaryUnresolved(await fixture(source), ['效果尚未验证。']);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, uncertaintyDisposition: 'effect_unverified' }), meta } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.reasons).toEqual(['candidate_semantic_support_unavailable', 'conversation_has_unresolved_questions']);
  expect(result.approved).toBe(false); expect(await supportReceipts()).toEqual([]);
});

it('binds a summary disposition to the real update target and exact committed body', async () => {
  const first = await fixture(source, { suggestedType: 'cognition' });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const created = await policy.tryAutomaticallyApproveRecallCandidate('alice', first.candidate.id);
  expect(created.approved).toBe(true);
  const revised = '我长期偏好技术说明采用结论优先的顺序，再说明关键依据和未验证之处，适用范围仅限我自己。';
  const f = await withSummaryUnresolved(await fixture(revised, { suggestedType: 'cognition', suggestedAction: 'update', targetAssetId: created.asset!.id, targetVersionUsed: '1' }), ['尚未证明表达效果有所改善。']);
  run.mockClear().mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, uncertaintyDisposition: 'effect_unverified' }), meta: {} } });
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.reasons).toEqual([]);
  expect(result).toMatchObject({ approved: true, asset: { id: created.asset!.id, version: '2', statement: revised } });
  expect(run).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(run.mock.calls[0][1].message);
  expect(payload.existingTarget).toMatchObject({ id: created.asset!.id, version: '1', statement: source });
  expect(payload.candidate.judgment).toBe(revised);
  expect((await supportReceipts()).find(row => row.candidateId === f.candidate.id)).toMatchObject({ targetVersion: '1', summaryUncertainty: { disposition: 'effect_unverified' } });
});

it.each(['scope', 'epoch', 'source_permission', 'source_text'])('rejects a classified summary when %s changes during its final independent check', async change => {
  const f = await withSummaryUnresolved(await fixture(source), ['效果尚未验证。']);
  run.mockImplementationOnce(async () => {
    if (change === 'scope') await f.store.writeRecallJsonRecord('alice', 'candidates', f.candidate.id, { ...f.candidate, scopePolicy: { workspaceIds: ['workspace-new'] } });
    if (change === 'epoch') await f.settings.updateRecallCaptureSettings('alice', { autoApproval: false });
    if (change === 'source_permission') {
      const control = await import('../../../../src/main/features/recall/source-control');
      await control.pauseCognitionSource('alice', f.candidate.sourceRefs[0]);
    }
    if (change === 'source_text') fs.writeFileSync(f.layout.conversationMessageFile('alice', String(f.capture.conversationId)),
      JSON.stringify({ id: f.messageId, ts: String(f.capture.createdAt), from: 'user', to: ['commander'], text: source + '最后更正：该偏好已撤销。' }) + '\n');
    return { result: { text: JSON.stringify({ ...accepted, uncertaintyDisposition: 'effect_unverified' }), meta: {} } };
  });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.approved).toBe(false);
  expect(result.candidate.status).toBe('pending_review');
  expect(await supportReceipts()).toEqual([]);
});

const completeLongPreference = source + [
  '每次解释都先列本次有直接依据的结论，并区分原始材料中的陈述和为了说明而举的虚构例子。',
  '关键理由应逐条对应原始材料；若只知道一个有限范围内的事实，就明确写出该范围，不推成普遍事实。',
  '遇到条件、日期、主体或例外时完整说明这些限制；原始资料没有明确的部分保留待核，不能自行补齐。',
  '引用用户描述时保留来源归属；第三方尚未独立验证的陈述只作为来源报告，不写成客观证实的结论。',
  '技术故障分析先说明已经观察到的证据和复现条件，再给解释与下一步；猜测要与已经验证的事实分开。',
  '若用户对某次问题提出临时要求，则只在该次问题采用临时顺序，后续技术说明仍使用这项长期偏好。',
  '这项约定仅适用于用户本人技术说明，不能自动推给同事、项目成员或其它场景，也不代表效果已经提高。',
].join('\n');

it('retains complete content beyond the 300-character soft budget after full semantic checks and cached-only confirmation', async () => {
  expect(completeLongPreference.length).toBeGreaterThan(300);
  expect(completeLongPreference.length).toBeLessThan(4000);
  const f = await fixture(completeLongPreference, { suggestedType: 'cognition' }, completeLongPreference);
  const promotion = await import('../../../../src/main/features/recall/formal-assets/promotion');
  expect(promotion.validatePromotionByAssetType(f.candidate, { actor: 'system' })).toMatchObject({ ok: true, advisories: ['statement_over_soft_budget'] });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  await expect(policy.requireNightlyAutomaticApproval('alice', f.candidate)).resolves.toMatchObject({ eligible: true });
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: true, asset: { statement: completeLongPreference, maturity: 'bud' } });
  expect(result.asset!.statement.length).toBe(completeLongPreference.length);
  expect(run).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(run.mock.calls[0][1].message);
  expect(payload.candidate.judgment).toBe(completeLongPreference);
  expect(payload.completeConversationContext[0].text).toBe(completeLongPreference);
  const [receipt] = await supportReceipts();
  expect(receipt.checks).toEqual({ supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true });
});

it('keeps complete long content pending when the final preservation check fails', async () => {
  const f = await fixture(completeLongPreference, { suggestedType: 'cognition' }, completeLongPreference);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, priorContentPreserved: false }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: false, candidate: { status: 'pending_review', judgment: completeLongPreference }, reasons: ['candidate_semantic_support_failed'] });
  expect(await supportReceipts()).toEqual([]);
});

it.each([
  ['personal', '解释问题先给结论，再列出关键理由与原始依据。', 'personal_not_stable'],
  ['fact', '说明问题采用结论在前、依据在后的顺序。', 'fact_not_stable'],
] as const)('keeps the %s content advisory manual even alongside a length-only advisory', async (suggestedType, judgment, expectedAdvisory) => {
  const f = await fixture(judgment, { suggestedType, summary: '说明顺序', value: '便于对照解释顺序和信息来源。'.repeat(30) });
  expect(f.candidate.statementIssues).toBeUndefined();
  const promotion = await import('../../../../src/main/features/recall/formal-assets/promotion');
  expect(promotion.validatePromotionByAssetType(f.candidate, { actor: 'system' }).advisories).toEqual(expect.arrayContaining([expectedAdvisory, 'statement_over_soft_budget']));
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).reasons).toContain('formal_asset_requirements_incomplete');
  expect(run).not.toHaveBeenCalled();
});

it('still requires a rule boundary even with a length-only display advisory', async () => {
  const f = await fixture('复杂问题必须先给结论，再说明关键理由和依据。', { suggestedType: 'rule', value: '便于对照解释顺序和信息来源。'.repeat(30) });
  expect(f.candidate.statementIssues).toBeUndefined();
  const promotion = await import('../../../../src/main/features/recall/formal-assets/promotion');
  expect(promotion.validatePromotionByAssetType(f.candidate, { actor: 'system' })).toMatchObject({ ok: false, reasons: ['rule_boundary_required'] });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).reasons).toContain('formal_asset_requirements_incomplete');
  expect(run).not.toHaveBeenCalled();
});

it.each(['judgment', 'value'] as const)('preserves the existing 4000-character hard limit for %s', async field => {
  await expect(fixture(source, { [field]: '界'.repeat(4001) })).rejects.toThrow(field + ' is too long');
  expect(run).not.toHaveBeenCalled();
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  expect(await candidates.listRecallCandidates('alice')).toEqual([]);
  const assets = await import('../../../../src/main/features/recall/asset-service');
  expect(await assets.listAbilityAssets('alice')).toEqual([]);
});

it('binds an explicitly selected exact approved fragment to the final whole joint plan and cached-only automatic commit', async () => {
  const f = await withSummaryUnresolved(await withJointPlan(), ['效果尚未验证。']);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, sourceRuleConclusions: f.sourceRuleConclusions, uncertaintyDisposition: 'effect_unverified', evidence: [{ label: 'm1', approvedQuoteIndex: 0 }] }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect((await policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
  await expect(policy.requireNightlyAutomaticApproval('alice', f.candidate)).resolves.toMatchObject({ eligible: true });
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result).toMatchObject({ approved: true, candidate: { status: 'confirmed' }, asset: { statement: source } });
  expect(run).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(run.mock.calls[0][1].message);
  expect(payload.approvedUserSources[0].approvedQuotes).toEqual([source]);
  expect(payload.candidate.ontologyFormation.refs).toEqual(f.candidate.ontologyFormation!.refs);
  expect(payload.candidate.ontologyFormation.actions.find(action => action.recordId === 'guidance').record.strength).toBeUndefined();
  const [receipt] = await supportReceipts();
  expect(receipt.evidence).toEqual([{ messageId: f.messageId, start: 0, end: source.length, quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(receipt.summaryUncertainty).toMatchObject({ disposition: 'effect_unverified' });
  expect(JSON.stringify(receipt)).not.toContain('approvedQuoteIndex');
  expect(JSON.stringify(receipt)).not.toContain(source);
  expect(f.ontology.readOntologyDocument('alice').records.guidance).toMatchObject({ requirement: source });
});

it.each(['supported', 'noUnsupportedClaims', 'scopePreserved', 'finalDecisionPreserved', 'priorContentPreserved'])('holds final indexed support when %s is false instead of treating evidence selection as authority', async key => {
  const f = await fixture(source);
  run.mockResolvedValue({ result: { text: JSON.stringify({ ...accepted, [key]: false, evidence: [{ label: 'm1', approvedQuoteIndex: 0 }] }), meta: {} } });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  expect(await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).toMatchObject({ approved: false, candidate: { status: 'pending_review' }, reasons: ['candidate_semantic_support_failed'] });
  expect(await supportReceipts()).toEqual([]);
});

it.each(['epoch', 'source_permission', 'source_text'])('does not retain an indexed observation after its %s baseline becomes stale during model waiting', async change => {
  const f = await fixture(source);
  run.mockImplementationOnce(async () => {
    if (change === 'epoch') await f.settings.updateRecallCaptureSettings('alice', { autoApproval: false });
    if (change === 'source_permission') {
      const control = await import('../../../../src/main/features/recall/source-control');
      await control.pauseCognitionSource('alice', f.candidate.sourceRefs[0]);
    }
    if (change === 'source_text') fs.writeFileSync(f.layout.conversationMessageFile('alice', String(f.capture.conversationId)),
      JSON.stringify({ id: f.messageId, ts: String(f.capture.createdAt), from: 'user', to: ['commander'], text: source + '最终更正：不再采用该偏好。' }) + '\n');
    return { result: { text: JSON.stringify({ ...accepted, evidence: [{ label: 'm1', approvedQuoteIndex: 0 }] }), meta: {} } };
  });
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  const result = await policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
  expect(result.approved).toBe(false); expect(result.candidate.status).toBe('pending_review');
  expect(await supportReceipts()).toEqual([]);
});
