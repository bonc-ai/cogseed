import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assessFormationBatch, analyzeFormationDependencies } from '../../../../src/main/features/recall/formation-batch-assessment';
import { validateFormationComparison } from '../../../../src/main/features/recall/formation-comparison';
import { reviseFormationRuleSemantics, formationRuleContracts, validateFormationRuleChecks, parseSourceRuleConclusions } from '../../../../src/main/features/recall/ontology-rule-semantics';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: run }));
const sources = [{ label: 'm1', text: '按刚才那套结构作为以后周报的默认格式，临时简报除外。', approvedQuotes: ['按刚才那套结构作为以后周报的默认格式，临时简报除外。'] }];
const checks = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true,
  evidence: [{ label: 'm1', quote: sources[0].text }] };
const coverage = { total: 0, selected: 0, truncated: false, unavailable: 0 };
const item = (index: number) => ({ index, candidate: { judgment: '周报先列结论再列事实，临时简报除外。', value: '减少阅读负担。', suggestedScope: 'report', uncertainty: '尚未验证实际效果' }, sources });
const input = () => ({ sessionId: 'one-shot-formation', items: [item(0), item(1)], contextMessages: [{ label: 'm0', role: 'assistant', text: '周报先列结论再列事实。' }, { label: 'm1', role: 'user', text: sources[0].text }], summary: [], existing: { assets: [], coverage }, ontology: {}, feedback: [], modelCandidates: [] });
const rows = () => [0, 1].map(index => ({ index, checks, uncertaintyDisposition: 'effect_unverified', comparison: { relation: 'new', reason: '来源对象与范围明确，当前可读池为空。' } }));
beforeEach(() => { run.mockReset(); });
it('permits contextual R field evidence but rejects context-only topic authority', () => {
  const earlier = 'Deployment reviews must include risks.';
  const latest = 'That requirement applies to Project Alpha.';
  const admittedSources = [
    { label: 'm1', text: earlier, approvedQuotes: [] },
    { label: 'm2', text: latest, approvedQuotes: [latest] },
  ];
  const contract = { recordId: 'review-rule', strength: 'required' as const, condition: null, effect: { kind: 'note' as const }, exception: '' };
  const conclusion = { recordId: contract.recordId, status: 'resolved',
    expectedContract: { strength: contract.strength, condition: contract.condition, effect: contract.effect, exception: contract.exception },
    topicEvidence: [{ label: 'm2', quote: latest }],
    fieldEvidence: { strength: [{ label: 'm1', quote: earlier }], condition: [], effect: [], exception: [] },
  };
  expect(parseSourceRuleConclusions([conclusion], [contract], admittedSources)[0]).toMatchObject(conclusion);
  expect(() => parseSourceRuleConclusions([{ ...conclusion, topicEvidence: [{ label: 'm1', quote: earlier }] }],
    [contract], admittedSources)).toThrow('supported grounding needs approved topic evidence');
});
describe('single merged formation adjudication', () => {
  it('checks all ambiguous proposals once, preserving assistant context and explicit user adoption, and reuses the same source snapshot', async () => {
    run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: rows() }), meta: {} } });
    const checkpoint = await assessFormationBatch('user-a', input());
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(run.mock.calls[0][1].message).completeConversationContext[0].role).toBe('assistant');
    expect(await assessFormationBatch('user-a', { ...input(), checkpoint })).toEqual(checkpoint);
    expect(run).toHaveBeenCalledTimes(1);
    const changed = input(); changed.items[0].sources = [{ ...sources[0], text: sources[0].text + '更正。' }];
    await assessFormationBatch('user-a', { ...changed, checkpoint });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('cannot repair a missing/duplicate verdict or manufacture user assent from assistant text', async () => {
    run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [rows()[0], rows()[0]] }), meta: {} } });
    await expect(assessFormationBatch('user-a', input())).rejects.toThrow();
    run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: rows().map(row => ({ ...row, checks: { ...checks, evidence: [{ label: 'm0', quote: '周报先列结论再列事实。' }] } })) }), meta: {} } });
    await expect(assessFormationBatch('user-a', input())).rejects.toThrow();
  });
  it('does not establish new identity from truncated context or a target from another object/version', () => {
    expect(() => validateFormationComparison({ relation: 'new', reason: 'unseen' }, [], { ...coverage, truncated: true })).toThrow();
    expect(() => validateFormationComparison({ relation: 'changed', reason: 'dated owner change', targetAssetId: 'same-name-other-project', targetVersion: '1', targetQuote: 'owner' }, [], coverage)).toThrow();
  });
  it('uses the complete summary and every original evidence passage when the full day exceeds the formation budget', async () => {
    const text = sources[0].text + '\n' + '长篇讨论。'.repeat(40_000) + '\n最后更正：仍保留临时简报的例外。';
    const finalQuote = '最后更正：仍保留临时简报的例外。';
    const summary = { sourceDigest: 'complete-source', completedAt: new Date().toISOString(),
      topics: [{ title: '周报', content: '保留完整默认及最后例外。', conditions: [], unresolved: [], attribution: 'user_requirement' as const,
        evidence: [sources[0].text, finalQuote].map(quote => ({ messageId: 'user-1', quote, role: 'user', start: text.indexOf(quote), end: text.indexOf(quote) + quote.length })) }],
      coverage: { messageCount: 1, sourceChars: text.length, segmentCount: 80, processedSegmentIds: ['complete'], maxInputChars: 24_000 } };
    run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: rows() }), meta: {} } });
    await assessFormationBatch('user-a', { ...input(), contextSummary: summary,
      contextMessages: [{ id: 'user-1', label: 'm1', role: 'user', text }], conversationId: 'conversation-a' });
    const dispatched = run.mock.calls[0][1];
    const payload = JSON.parse(dispatched.message);
    expect(dispatched.message.length).toBeLessThan(128_000);
    expect(payload.summary).toEqual(summary.topics);
    expect(payload.completeConversationContext[0].text).toContain(finalQuote);
    expect(payload.completeConversationContext[0].text).toContain(sources[0].text);
    expect(payload.contextCoverage.sourceChars).toBe(text.length);
    expect(dispatched.cliContext).toEqual({ conversationId: 'conversation-a' });
  });
  it('distinguishes invalid assessments from unavailable models and oversized complete targets', async () => {
    run.mockResolvedValue({ result: { text: 'not json', meta: {} } });
    await expect(assessFormationBatch('user-a', input())).rejects.toMatchObject({ reason: 'assessment_invalid' });
    run.mockRejectedValue(new Error('offline'));
    await expect(assessFormationBatch('user-a', input())).rejects.toMatchObject({ reason: 'model_unavailable' });
    await expect(assessFormationBatch('user-a', { ...input(), ontology: 'x'.repeat(128_000) })).rejects.toMatchObject({ reason: 'context_too_large' });
  });
});

it('uses the same batch to merge a reread target, preserving its default while adding a supported exception', async () => {
  const original = item(0);
  const target = { id: 'asset-a', version: '2', title: '周报结构', statement: '周报先列结论再列事实。', type: 'cognition' as const, scope: 'report', evidenceRefs: [] };
  run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [{ index: 0, checks, uncertaintyDisposition: 'effect_unverified',
    comparison: { relation: 'exception', targetAssetId: target.id, targetVersion: target.version, targetQuote: target.statement, reason: '保留默认，只补来源中的简报例外。' },
    revision: { judgment: '周报先列结论再列事实。临时简报除外。', applicableWhen: ['周报'], forbiddenWhen: ['临时简报'] } }] }), meta: {} } });
  const result = await assessFormationBatch('user-a', { ...input(), items: [{ ...original, candidate: { ...original.candidate, targetAssetId: target.id } }],
    existing: { assets: [target], coverage: { ...coverage, total: 1, selected: 1 } } });
  expect(result.assessments[0].revision?.judgment).toBe('周报先列结论再列事实。临时简报除外。');
  expect(run).toHaveBeenCalledTimes(1);
});

it('uses the host-owned extraction comparison and ignores a corrupted model copy', async () => {
  const original = item(0);
  const target = { id: 'asset-a', version: '2', title: '周报结构', statement: '周报先列结论再列事实。', type: 'cognition' as const, scope: 'report', evidenceRefs: [] };
  const hostComparison = { relation: 'correction' as const, targetAssetId: target.id, targetVersion: target.version,
    targetQuote: target.statement, reason: 'host-validated extraction comparison' };
  run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [{ index: 0, checks, uncertaintyDisposition: 'effect_unverified',
    comparison: { relation: 'evidence', targetAssetId: `${target.id}b`, targetVersion: target.version,
      targetQuote: 'short paraphrase', reason: 'model copy' } }] }), meta: {} } });
  const result = await assessFormationBatch('user-a', { ...input(),
    items: [{ ...original, candidate: { ...original.candidate, targetAssetId: target.id }, comparison: hostComparison }],
    existing: { assets: [target], coverage: { ...coverage, total: 1, selected: 1 } } });
  expect(result.assessments[0].comparison).toMatchObject({ relation: 'correction',
    targetAssetId: target.id, targetQuote: target.statement });
  expect(result.assessments[0].checks.supported).toBe(true);
});

it('repairs only source-supported rule semantics before the first complete preview without changing body or source ownership', async () => {
  const { emptyOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/model');
  const { applyOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/commands');
  const { parseOntologyFormationProposal, validateOntologyFormationScope } = await import('../../../../src/main/features/recall/ontology-formation');
  const body = '部署评审必须写风险和回退条件；普通例会不加这两栏。';
  const raw = { reason: 'User scoped obligation', evidence: ['m1'], actions: [{ intent: 'create', recordId: 'review-rule', sourceLabel: 'Explicit deployment-review requirement',
    record: { kind: 'rule', moduleId: 'project-module', name: 'Deployment review', requirementSource: 'cognition_body',
      strength: 'default', condition: null, effect: { kind: 'note' }, exception: '普通例会不适用' } }],
    refs: [{ moduleId: 'project-module', recordId: 'review-rule', versionPolicy: 'current', sharedBody: true }] };
  const semantic = { recordId: 'review-rule', strength: 'required', condition: null, effect: { kind: 'note' }, exception: '普通例会不适用' };
  const doc = applyOntologyCommand(emptyOntologyDocument('user-a'), { commandId: 'seed-module', expectedRevision: 0,
    actions: [{ intent: 'create', recordId: 'project-module', sourceLabel: 'Fixture project scope', record: { kind: 'module', name: 'Scoped module', description: '', scope: { kind: 'project', id: 'project-a' } } }] }, new Date().toISOString()).document;
  run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [{ index: 0, checks: { ...checks, evidence: [{ label: 'm1', quote: body }] },
    uncertaintyDisposition: 'none', sourceRuleConclusions: [{ recordId: semantic.recordId, status: 'resolved',
      expectedContract: { strength: semantic.strength, condition: semantic.condition, effect: semantic.effect, exception: semantic.exception },
      topicEvidence: [{ label: 'm1', quote: body }], fieldEvidence: { strength: [{ label: 'm1', quote: body }], condition: [], effect: [],
        exception: [{ label: 'm1', quote: body }] } }] }] }), meta: {} } });
  const result = await assessFormationBatch('user-a', { ...input(), items: [{ index: 0, candidate: { judgment: body, value: 'Safe decision', suggestedScope: 'review', ontologyChanges: raw },
    sources: [{ label: 'm1', text: body, approvedQuotes: [body] }] }], ontology: { revision: doc.revision, records: Object.values(doc.records) } });
  const revised = reviseFormationRuleSemantics(raw, result.assessments[0].ruleRevisions!);
  const plan = validateOntologyFormationScope('user-a', doc, parseOntologyFormationProposal(doc, 'candidate-a', revised, body), { projectIds: ['project-a'] })!;
  expect(plan.blockedReasons).toEqual([]);
  expect(plan.previewChanges[0].after).toMatchObject({ kind: 'rule', requirement: body, strength: 'required', effect: { kind: 'note' }, exception: '普通例会不适用' });
  expect(raw.actions[0].record.strength).toBe('default');
  expect(doc.records['review-rule']).toBeUndefined();
  // Wrong scope and an invented typed effect remain blocked by the ordinary
  // canonical/parser gates rather than being inferred from the word 必须.
  expect(validateOntologyFormationScope('user-a', doc, plan, { projectIds: ['project-b'] })!.blockedReasons.length).toBeGreaterThan(0);
  expect(() => reviseFormationRuleSemantics(raw, [{ ...semantic, effect: { kind: 'run_arbitrary_code' } }] as any)).toThrow();
  expect(() => reviseFormationRuleSemantics(raw, [{ ...semantic, recordId: 'unowned-rule' }] as any)).toThrow();
  expect(() => reviseFormationRuleSemantics({ ...raw, actions: [{ ...raw.actions[0], record: { kind: 'assertion' } }] }, [semantic] as any)).toThrow();
});

it('rejects missing duplicate or mismatched per-rule fields instead of accepting a prose-only repair', () => {
  const first = { recordId: 'rule-a', strength: 'default' as const, condition: null, effect: { kind: 'note' }, exception: '临时简报除外' };
  const second = { ...first, recordId: 'rule-b' };
  const checked = { ...first, checks: { strengthPreserved: true, conditionPreserved: true, effectPreserved: true, exceptionPreserved: true }, evidence: checks.evidence };
  expect(() => validateFormationRuleChecks(undefined, [first], sources)).toThrow();
  expect(() => validateFormationRuleChecks([{ ...checked, effect: undefined }], [first], sources)).toThrow();
  expect(() => validateFormationRuleChecks([checked, checked], [first, second], sources)).toThrow();
  for (const mismatch of [{ strength: 'required' }, { condition: { kind: 'task', field: 'purpose', equals: 'invented' } },
    { effect: { kind: 'required_section', name: 'invented' } }, { exception: '' }]) {
    expect(() => validateFormationRuleChecks([{ ...checked, ...mismatch }], [first], sources)).toThrow();
  }
  // Normalized create shapes, inherited update metadata and unchanged R refs
  // all require an explicit check; none can hide behind lexical body support.
  const canonical = { id: 'rule-b', kind: 'rule', ...second };
  const raw = { actions: [{ intent: 'create', recordId: 'rule-a', record: { moduleId: 'module', name: 'Rule', requirement: 'Body', ...first } },
    { intent: 'update', recordId: 'rule-b', patch: { exception: 'changed' } }], refs: [{ recordId: 'rule-b' }] };
  expect(formationRuleContracts(raw, [canonical])).toEqual([first, { ...second, exception: 'changed' }]);
  const pinned = { refs: [{ recordId: 'rule-b', versionPolicy: 'pinned', targetVersion: 1 }] };
  expect(() => formationRuleContracts(pinned, [{ ...canonical, version: 2 }])).toThrow();
  expect(formationRuleContracts(pinned, [{ ...canonical, version: 2 }, { ...canonical, version: 1, strength: 'required' }]))
    .toEqual([{ ...second, strength: 'required' }]);
});

it.each(['unresolved', 'not_supported'])('holds an overall true verdict when source rule meaning is %s', async status => {
  const semantic = { recordId: 'rule-a', strength: 'default', condition: null, effect: { kind: 'note' }, exception: '临时简报除外' };
  const raw = { actions: [{ intent: 'create', recordId: semantic.recordId, record: { kind: 'rule', ...semantic } }] };
  const sourceRuleConclusions = [{ recordId: semantic.recordId, status, reason: 'Source meaning is unresolved or belongs to another topic.' }];
  run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [{ index: 0, checks, uncertaintyDisposition: 'none', sourceRuleConclusions }] }), meta: {} } });
  const result = await assessFormationBatch('user-a', { ...input(), items: [{ ...item(0), candidate: { ...item(0).candidate, ontologyChanges: raw } }] });
  expect(result.assessments[0].checks).toMatchObject({ supported: false, finalDecisionPreserved: false });
  expect(result.assessments[0].ruleRevisions).toBeUndefined();
});

it('isolates a malformed row and retries only that row against the same complete source', async () => {
  const bad = { ...rows()[1], checks: { ...checks, evidence: [{ label: 'm1', quote: 'invented source' }] } };
  run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [rows()[0], bad] }), meta: {} } });
  const partial = await assessFormationBatch('user-a', input());
  expect(partial.assessments.map(row => row.index)).toEqual([0]);
  expect(partial.itemFailures).toEqual([{ index: 1, reason: 'assessment_invalid' }]);
  run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [rows()[1]] }), meta: {} } });
  const complete = await assessFormationBatch('user-a', { ...input(), checkpoint: partial });
  expect(complete.assessments.map(row => row.index)).toEqual([0, 1]);
  expect(complete.itemFailures).toBeUndefined();
  expect(JSON.parse(run.mock.calls[1][1].message).candidates.map(row => row.index)).toEqual([1]);
  expect(JSON.parse(run.mock.calls[1][1].message).completeConversationContext).toEqual(input().contextMessages);
  expect(run).toHaveBeenCalledTimes(2);
});

it.each([
  { refs: [{ recordId: 'object-a', versionPolicy: 'current' }] },
  { actions: [{ intent: 'create', recordId: 'dependent-entity', record: { kind: 'entity', moduleId: 'object-a' } }] },
  { actions: [{ intent: 'update', recordId: 'dependent-assertion', patch: { object: { kind: 'entity', id: 'object-a' } } }] },
])('holds all writes and references in a failed dependency group while keeping an independent group (%j)', async dependency => {
  const items = [item(0), item(1), item(2)];
  Object.assign(items[0].candidate, { ontologyChanges: { actions: [{ intent: 'update', recordId: 'object-a', patch: { name: 'New name' } }] } });
  Object.assign(items[1].candidate, { ontologyChanges: dependency });
  run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [
    { ...rows()[0], checks: { ...checks, evidence: [{ label: 'm1', quote: 'invented' }] } },
    rows()[1], { ...rows()[0], index: 2 },
  ] }), meta: {} } });
  const result = await assessFormationBatch('user-a', { ...input(), items });
  expect(result.assessments.map(row => row.index)).toEqual([2]);
  expect(result.itemFailures).toEqual([{ index: 0, reason: 'assessment_invalid' }, { index: 1, reason: 'dependency_unavailable' }]);
  expect(run).toHaveBeenCalledTimes(1);
});

it('isolates malformed proposed rule metadata before requesting independent items', async () => {
  const args = input();
  Object.assign(args.items[0].candidate, { ontologyChanges: { actions: [{ intent: 'create', recordId: 'malformed-rule',
    record: { kind: 'rule', strength: 'default', condition: 'not a canonical condition', effect: { kind: 'note' }, exception: '' } }] } });
  run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [rows()[1]] }), meta: {} } });
  const result = await assessFormationBatch('user-a', args);
  expect(result.assessments.map(row => row.index)).toEqual([1]);
  expect(result.itemFailures).toEqual([{ index: 0, reason: 'assessment_invalid' }]);
  expect(JSON.parse(run.mock.calls[0][1].message).candidates.map(row => row.index)).toEqual([1]);
});

it.each([{ actions: [null] }, { actions: {} }, { actions: ['invalid'] }, { refs: [null] },
  { actions: [{ record: null }] }, { actions: [{ patch: 'invalid' }] }])('isolates malformed raw ontology shapes without assessing them (%j)', async ontologyChanges => {
  const args = input();
  Object.assign(args.items[0].candidate, { ontologyChanges });
  run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [rows()[1]] }), meta: {} } });
  const result = await assessFormationBatch('user-a', args);
  expect(result.assessments.map(row => row.index)).toEqual([1]);
  expect(result.itemFailures).toEqual([{ index: 0, reason: 'assessment_invalid' }]);
  expect(JSON.parse(run.mock.calls[0][1].message).candidates.map(row => row.index)).toEqual([1]);
});

it('holds known dependants of malformed actions while preserving independent and reference-only groups', async () => {
  const items = [item(0), item(1), item(2)];
  Object.assign(items[0].candidate, { ontologyChanges: { actions: [null, { recordId: 'synthetic-object' }] } });
  Object.assign(items[1].candidate, { ontologyChanges: { refs: [{ recordId: 'synthetic-object' }] } });
  Object.assign(items[2].candidate, { ontologyChanges: { refs: [{ recordId: 'independent-object' }] } });
  expect(analyzeFormationDependencies(items)).toEqual({ groups: [[0, 1], [2]], invalidIndexes: [0] });
  run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [{ ...rows()[0], index: 2 }] }), meta: {} } });
  const result = await assessFormationBatch('user-a', { ...input(), items });
  expect(result.assessments.map(row => row.index)).toEqual([2]);
  expect(result.itemFailures).toEqual([{ index: 0, reason: 'assessment_invalid' }, { index: 1, reason: 'dependency_unavailable' }]);
  expect(JSON.parse(run.mock.calls[0][1].message).candidates.map(row => row.index)).toEqual([2]);
});

describe('source proposal comparison against the formation snapshot', () => {
  const target = { id: 'asset-source-test', version: '7', title: '周报结构', statement: '周报先列结论再列事实。',
    type: 'cognition' as const, scope: 'report', evidenceRefs: [] };
  const sourceItem = () => ({ ...item(0), sourceProposal: true });
  const formationInput = (assets = [target], selection = { ...coverage, total: 1, selected: 1 }) => ({
    ...input(), items: [sourceItem()], existing: { assets, coverage: selection, baselineDigest: 'source-test-baseline' },
  });
  const comparison = { relation: 'exception', targetAssetId: target.id, targetVersion: target.version,
    targetQuote: target.statement, reason: '保留默认格式，增加来源中的例外。' };
  const revision = { judgment: '周报先列结论再列事实，临时简报除外。', forbiddenWhen: ['临时简报'] };
  const respond = (extra: object) => run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [
    { index: 0, checks, uncertaintyDisposition: 'effect_unverified', ...extra },
  ] }), meta: {} } });

  it('normalizes a nested revision without changing the reviewed target or evidence', async () => {
    respond({ comparison: { ...comparison, revision: { ...revision, applicableWhen: null } } });
    const result = await assessFormationBatch('user-a', formationInput());
    expect(result.assessments[0]).toMatchObject({ comparison, revision });
    expect(result.assessments[0].revision).not.toHaveProperty('applicableWhen');
  });

  it('rejects a misplaced revision when two different revisions are supplied', async () => {
    respond({ comparison: { ...comparison, revision: { judgment: 'Different version.' } }, revision });
    await expect(assessFormationBatch('user-a', formationInput())).rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('accepts null optional target fields for a new item without weakening coverage', async () => {
    respond({ comparison: { relation: 'new', reason: 'New topic.', targetAssetId: null, targetVersion: null, targetQuote: null, relatedAssets: null } });
    const result = await assessFormationBatch('user-a', formationInput());
    expect(result.assessments[0].comparison).toMatchObject({ relation: 'new', reason: 'New topic.' });
    expect(result.assessments[0].comparison).not.toHaveProperty('targetAssetId');
    await expect(assessFormationBatch('user-a', formationInput([target], { ...coverage, total: 2, selected: 1, truncated: true })))
      .rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('drops a singleton related asset only when it exactly repeats the current target', async () => {
    respond({ comparison: { ...comparison, relatedAssets: [{ assetId: target.id, version: target.version, quote: target.statement }] }, revision });
    const result = await assessFormationBatch('user-a', formationInput());
    expect(result.assessments[0]).toMatchObject({ comparison, revision });
    expect(result.assessments[0].comparison).not.toHaveProperty('relatedAssets');
  });

  it.each([
    { assetId: target.id, version: '6', quote: target.statement },
    { assetId: target.id, version: target.version, quote: '不存在' },
    { assetId: 'different-id', version: target.version, quote: target.statement },
    { assetId: target.id, version: target.version, quote: null },
  ])('rejects a singleton related reference that does not exactly match target (%j)', async related => {
    respond({ comparison: { ...comparison, relatedAssets: [related] }, revision });
    await expect(assessFormationBatch('user-a', formationInput())).rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('does not invent a target for a singleton related reference on an ambiguous decision', async () => {
    respond({ comparison: { relation: 'ambiguous', reason: 'Needs review.', relatedAssets: [
      { assetId: target.id, version: target.version, quote: target.statement },
    ] } });
    await expect(assessFormationBatch('user-a', formationInput())).rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('still rejects update targets when optional null fields leave no exact proof', async () => {
    respond({ comparison: { ...comparison, targetVersion: null }, revision });
    await expect(assessFormationBatch('user-a', formationInput())).rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('retains all identities when the model returns more than six related assets', async () => {
    const assets = Array.from({ length: 7 }, (_, index) => ({ ...target, id: `asset-overflow-${index}` }));
    respond({ comparison: { relation: 'ambiguous', reason: 'Multiple sources need review', relatedAssets: assets.map(asset => ({
      assetId: asset.id, version: asset.version, quote: asset.statement,
    })) } });
    const result = await assessFormationBatch('user-a', formationInput(assets, { ...coverage, total: 7, selected: 7 }));
    expect(result.assessments).toEqual([]);
    expect(result.itemFailures).toEqual([{ index: 0, reason: 'related_assets_overflow', relatedAssetIds: assets.map(asset => asset.id) }]);
  });

  it('holds related old assets together with a new source for human review', async () => {
    const second = { ...target, id: 'asset-second', version: '3', statement: '周报应先列结论再列事实。' };
    respond({ comparison: { ...comparison, relation: 'duplicate' } });
    const args = { ...formationInput([target, second], { ...coverage, total: 2, selected: 2 }),
      relatedFindings: [{ category: 'duplicate' as const, assetIds: [target.id, second.id], detail: '相近内容需要核对。' }] };
    const result = await assessFormationBatch('user-a', args);
    const compared = result.assessments[0].comparison!;
    expect(compared).toMatchObject({ relation: 'ambiguous', relatedAssets: [
      { assetId: target.id, version: target.version },
      { assetId: second.id, version: second.version },
    ] });
    expect(result.assessments[0].revision).toBeUndefined();
    const sent = JSON.parse(run.mock.calls[0][1].message);
    expect(sent.existingAssets.map((asset: {id: string}) => asset.id)).toEqual([target.id, second.id]);
    expect(sent.relatedFindings).toEqual(args.relatedFindings);
    expect(sent.candidates[0].sources[0].approvedQuotes).toEqual(sources[0].approvedQuotes);
    expect(await assessFormationBatch('user-a', { ...args, checkpoint: result })).toEqual(result);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { assetId: 'asset-second', version: '2', quote: '周报应先列结论再列事实。' },
    { assetId: 'asset-second', version: '3', quote: '不存在的原文。' },
    { assetId: 'asset-second', version: '3' },
    { assetId: 'unreadable', version: '3', quote: '周报应先列结论再列事实。' },
  ])('rejects a related asset without an exact readable current-version quote: %j', async bad => {
    const second = { ...target, id: 'asset-second', version: '3', statement: '周报应先列结论再列事实。' };
    respond({ comparison: { relation: 'ambiguous', reason: '需要核对', relatedAssets: [
      { assetId: target.id, version: target.version, quote: target.statement }, bad,
    ] } });
    await expect(assessFormationBatch('user-a', formationInput([target, second], { ...coverage, total: 2, selected: 2 })))
      .rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('accepts a complete merged revision tied to the current target version and quote', async () => {
    respond({ comparison, revision });
    const result = await assessFormationBatch('user-a', formationInput());
    expect(result.assessments[0]).toMatchObject({ comparison: { ...comparison }, revision });
    expect(JSON.parse(run.mock.calls[0][1].message).candidates[0]).toMatchObject({ sourceProposal: true });
  });

  it('rejects an update without a complete merged revision', async () => {
    respond({ comparison });
    await expect(assessFormationBatch('user-a', formationInput())).rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it.each([
    ['previous version', { ...comparison, targetVersion: '6' }],
    ['incorrect quote', { ...comparison, targetQuote: '周报先列事实。' }],
    ['missing quote', { ...comparison, targetQuote: undefined }],
    ['different target', { ...comparison, targetAssetId: 'other-asset' }],
  ])('rejects the %s even when the source proposal has a revision', async (_name, invalidComparison) => {
    respond({ comparison: invalidComparison, revision });
    await expect(assessFormationBatch('user-a', formationInput())).rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('rejects a target that is no longer readable in the snapshot', async () => {
    respond({ comparison, revision });
    await expect(assessFormationBatch('user-a', formationInput([], { ...coverage, unavailable: 1, total: 1 })))
      .rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('accepts an exact duplicate in a partial pool without creating an update', async () => {
    respond({ comparison: { ...comparison, relation: 'duplicate' } });
    const result = await assessFormationBatch('user-a', formationInput([target], { ...coverage, total: 2, selected: 1, truncated: true }));
    expect(result.assessments[0].comparison).toMatchObject({ relation: 'duplicate', targetAssetId: target.id, targetVersion: target.version });
    expect(result.assessments[0].revision).toBeUndefined();
  });

  it.each([
    { ...coverage, truncated: true, total: 1 },
    { ...coverage, unavailable: 1, total: 1 },
  ])('rejects a new identity when the readable pool is incomplete (%j)', async selection => {
    respond({ comparison: { relation: 'new', reason: 'No matching identity is visible.' } });
    await expect(assessFormationBatch('user-a', formationInput([], selection))).rejects.toMatchObject({ reason: 'assessment_invalid' });
  });

  it('accepts a host-owned new comparison in an empty pool during uncertainty assessment', async () => {
    respond({});
    const result = await assessFormationBatch('user-a', { ...formationInput([], coverage), items: [{ ...sourceItem(),
      comparison: { relation: 'new' as const, reason: 'No active readable asset.', coverage } }] });
    expect(result.assessments[0].comparison).toMatchObject({ relation: 'new', coverage });
  });
});

describe('bounded formation JSON repair', () => {
  it('repairs malformed JSON once with the same frozen input and unchanged budget', async () => {
    run.mockResolvedValueOnce({ result: { text: '{"assessments":[', meta: {} } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: rows() }), meta: {} } });
    const args = { ...input(), budget: { jobId: 'formation-job', stage: 'grounding' as const } };
    const result = await assessFormationBatch('user-a', args);
    expect(result.assessments.map(row => row.index)).toEqual([0, 1]);
    expect(run).toHaveBeenCalledTimes(2);
    const repairedInput = JSON.parse(run.mock.calls[1][1].message);
    expect(repairedInput.expectedResponseIndexes).toEqual([0, 1]);
    delete repairedInput.expectedResponseIndexes;
    expect(repairedInput).toEqual(JSON.parse(run.mock.calls[0][1].message));
    expect(run.mock.calls[1][1].budget).toEqual(args.budget);
    expect(run.mock.calls[1][1].systemPrompt).toContain('previous response was not a complete parseable assessment envelope');
  });
  it('retains valid rows and requests only missing rows from an incomplete envelope', async () => {
    run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [rows()[0]] }), meta: {} } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [rows()[1]] }), meta: {} } });
    const result = await assessFormationBatch('user-a', input());
    expect(result.assessments.map(row => row.index)).toEqual([0, 1]);
    expect(JSON.parse(run.mock.calls[1][1].message).candidates.map(row => row.index)).toEqual([0, 1]);
    expect(JSON.parse(run.mock.calls[1][1].message).expectedResponseIndexes).toEqual([1]);
    expect(JSON.parse(run.mock.calls[1][1].message).completeConversationContext).toEqual(input().contextMessages);
  });
  it('does not retry an invalid source row in an otherwise complete envelope', async () => {
    const invalid = { ...rows()[1], checks: { ...checks, evidence: [{ label: 'm1', quote: 'not in source' }] } };
    run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [rows()[0], invalid] }), meta: {} } });
    const result = await assessFormationBatch('user-a', input());
    expect(result.assessments.map(row => row.index)).toEqual([0]);
    expect(result.itemFailures).toEqual([{ index: 1, reason: 'assessment_invalid' }]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reports assessment_invalid after one malformed repair', async () => {
    run.mockResolvedValue({ result: { text: '{"assessments":[', meta: {} } });
    await expect(assessFormationBatch('user-a', input())).rejects.toMatchObject({ reason: 'assessment_invalid' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not repair after an abort', async () => {
    const controller = new AbortController();
    run.mockImplementationOnce(async () => { controller.abort(); return { result: { text: '{', meta: {} } }; });
    await expect(assessFormationBatch('user-a', { ...input(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('stops before a repair when the task window closes', async () => {
    run.mockResolvedValueOnce({ result: { text: '{', meta: {} } });
    const shouldContinue = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(assessFormationBatch('user-a', { ...input(), shouldContinue })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects an invented target quote after format repair', async () => {
    const target = { id: 'asset-repair', version: '7', title: 'Report', statement: 'Existing statement.',
      type: 'cognition' as const, scope: 'report', evidenceRefs: [] };
    const invalid = { index: 0, checks, uncertaintyDisposition: 'effect_unverified',
      comparison: { relation: 'exception', reason: 'Add the exception.', targetAssetId: target.id, targetVersion: '7', targetQuote: 'Invented quote.' },
      revision: { judgment: 'Existing statement. Add the exception.' } };
    run.mockResolvedValueOnce({ result: { text: '{', meta: {} } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [invalid] }), meta: {} } });
    await expect(assessFormationBatch('user-a', { ...input(), items: [{ ...item(0), sourceProposal: true }],
      existing: { assets: [target], coverage: { ...coverage, total: 1, selected: 1 }, baselineDigest: 'fixed' } }))
      .rejects.toMatchObject({ reason: 'assessment_invalid' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('repairs an envelope containing an unknown index and rejects it when repair remains invalid', async () => {
    const unknown = { ...rows()[0], index: 99 };
    run.mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [...rows(), unknown] }), meta: {} } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: rows() }), meta: {} } });
    expect((await assessFormationBatch('user-a', input())).assessments.map(row => row.index)).toEqual([0, 1]);
    expect(run).toHaveBeenCalledTimes(2);
    run.mockReset().mockResolvedValue({ result: { text: JSON.stringify({ assessments: [...rows(), unknown] }), meta: {} } });
    await expect(assessFormationBatch('user-a', input())).rejects.toMatchObject({ reason: 'assessment_invalid' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('discards repair results when the task window closes while the second model is running', async () => {
    run.mockResolvedValueOnce({ result: { text: '{', meta: {} } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: rows() }), meta: {} } });
    const shouldContinue = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(assessFormationBatch('user-a', { ...input(), shouldContinue })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('keeps valid rows from an incomplete repair and fails only the missing rows', async () => {
    const items = [item(0), item(1), item(2)];
    run.mockResolvedValueOnce({ result: { text: '{', meta: {} } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: rows() }), meta: {} } });
    const result = await assessFormationBatch('user-a', { ...input(), items });
    expect(result.assessments.map(row => row.index)).toEqual([0, 1]);
    expect(result.itemFailures).toEqual([{ index: 2, reason: 'assessment_invalid' }]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('rejects all rows of a repaired envelope that includes an unknown index', async () => {
    run.mockResolvedValueOnce({ result: { text: '{', meta: {} } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ assessments: [rows()[0], { ...rows()[1], index: 99 }] }), meta: {} } });
    await expect(assessFormationBatch('user-a', input())).rejects.toMatchObject({ reason: 'assessment_invalid' });
    expect(run).toHaveBeenCalledTimes(2);
  });

});
