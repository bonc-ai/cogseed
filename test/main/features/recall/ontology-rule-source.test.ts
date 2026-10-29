import { beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assessFormationBatch } from '../../../../src/main/features/recall/formation-batch-assessment';
import { blindFormationRuleCandidate, deriveFormationRuleRevisions, formationRuleContext, formationRuleContracts,
  formationRuleSourceRequests, parseSourceRuleConclusions, reviseFormationRuleSemantics } from '../../../../src/main/features/recall/ontology-rule-semantics';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: run }));
const retained = JSON.parse(fs.readFileSync(path.resolve('test/main/features/recall/ontology-rule-source-f04.fixture.json'), 'utf8'));
const input = () => ({ sessionId: 'one-shot-rule-source', items: [structuredClone(retained.item)],
  contextMessages: retained.item.sources.map(source => ({ label: source.label, role: 'user', text: source.text })),
  summary: [], existing: { assets: [], coverage: { total: 0, selected: 0, truncated: false, unavailable: 0 } },
  ontology: retained.ontology, feedback: [], modelCandidates: [] });
beforeEach(() => { run.mockReset(); });
const contract = (strength = 'required') => ({ strength, condition: null, effect: { kind: 'note' }, exception: '' });
const conclusion = (recordId = 'rule-incident-review', expectedContract = contract()) => ({ recordId, status: 'resolved', expectedContract,
  topicEvidence: [{ label: 'm8', approvedQuoteIndex: 0 }], fieldEvidence: { strength: [{ label: 'm8', quote: retained.item.sources[0].approvedQuotes[0] }],
    condition: [], effect: [], exception: [] } });
const answer = (conclusions = [conclusion()]) => ({ result: { text: JSON.stringify({ assessments: [{ index: 2,
  checks: retained.assessment.checks, uncertaintyDisposition: 'none', sourceRuleConclusions: conclusions }] }), meta: {} } });

it('does not authorize the retained legal f04 default verdict through old self-preservation booleans', async () => {
  run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [retained.assessment] }), meta: {} } });
  await expect(assessFormationBatch('quality-benchmark-user', input())).rejects.toMatchObject({ reason: 'assessment_invalid' });
});

it('derives the actual required revision from independent source meaning and reparses the complete unchanged scoped body', async () => {
  run.mockResolvedValue(answer());
  const result = await assessFormationBatch('quality-benchmark-user', input());
  expect(result.assessments[0].ruleRevisions).toEqual([{ recordId: 'rule-incident-review', ...contract() }]);
  const { emptyOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/model');
  const { applyOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/commands');
  const { parseOntologyFormationProposal, validateOntologyFormationScope } = await import('../../../../src/main/features/recall/ontology-formation');
  // A source-qualified read context is not a persisted document: reconstruct
  // its real command/history/receipt baseline through the canonical domain.
  const doc = applyOntologyCommand(emptyOntologyDocument('quality-benchmark-user'), { commandId: 'source-f04-seed', expectedRevision: 0,
    actions: [...retained.ontology.records].sort((a, b) => ['module', 'definition', 'entity'].indexOf(a.kind) - ['module', 'definition', 'entity'].indexOf(b.kind)).map(value => {
      const { id, version, status, source, createdAt, updatedAt, ...record } = value;
      return { intent: 'create' as const, recordId: id, record, sourceLabel: 'Retained synthetic canonical T fixture' };
    }) }, '2026-10-14T19:00:00.000Z').document;
  const candidate = retained.item.candidate;
  const repaired = reviseFormationRuleSemantics(candidate.ontologyChanges, result.assessments[0].ruleRevisions!, formationRuleContext(retained.ontology));
  const plan = validateOntologyFormationScope('quality-benchmark-user', doc,
    parseOntologyFormationProposal(doc, 'source-f04', repaired, candidate.judgment), candidate.scopePolicy)!;
  expect(plan.blockedReasons).toEqual([]);
  expect(plan.previewChanges.find(row => row.after.kind === 'rule')!.after).toMatchObject({ requirement: candidate.judgment, ...contract() });
  expect(retained.item.candidate.ontologyChanges.actions.find(action => action.record.kind === 'rule').record.strength).toBe('default');
  expect((repaired as any).refs).toEqual(candidate.ontologyChanges.refs);
  expect((repaired as any).actions[0]).toEqual(candidate.ontologyChanges.actions[0]);
});

it('hides every proposed four-field copy and producer commentary while preserving confirmed before and pinned history', async () => {
  const args = input();
  const raw = args.items[0].candidate.ontologyChanges;
  const r = raw.actions.find(action => action.record.kind === 'rule');
  raw.reason = 'draft says default condition effect exception';
  raw.ruleContracts = [{ recordId: r.recordId, ...contract('default') }];
  raw.previewChanges = [{ before: { ...r.record, id: r.recordId, version: 1, strength: 'required' }, after: { ...r.record, id: r.recordId, version: 2 } }];
  args.items[0].candidate.ontologyFormation = structuredClone(raw);
  args.items[0].candidate.comparison = { relation: 'new', reason: 'copy draft default' };
  args.items[0].candidate.ruleContracts = raw.ruleContracts;
  run.mockImplementation(async (_uid, request) => {
    const item = JSON.parse(request.message).candidates[0];
    for (const plan of [item.candidate.ontologyChanges, item.candidate.ontologyFormation]) {
      const action = plan.actions.find(action => action.recordId === r.recordId);
      for (const key of ['strength', 'condition', 'effect', 'exception']) {
        expect(Object.hasOwn(action.record, key)).toBe(false);
        expect(Object.hasOwn(plan.previewChanges[0].after, key)).toBe(false);
        expect(Object.hasOwn(item.ruleSourceRequests[0], key)).toBe(false);
      }
      expect(plan.previewChanges[0].before).toBeUndefined(); // producer-created "before" is not canonical
      expect(plan.reason).toBeUndefined(); expect(plan.ruleContracts).toBeUndefined();
      expect(action.sourceLabel).toBeUndefined();
    }
    expect(item.candidate.comparison.reason).toBeUndefined();
    expect(item.candidate.ruleContracts).toBeUndefined(); expect(item.ruleContracts).toBeUndefined();
    return answer();
  });
  await assessFormationBatch('quality-benchmark-user', args);
  const canonical = { id: 'pinned-rule', kind: 'rule', version: 2, name: 'confirmed', moduleId: 'module', requirement: 'confirmed source', ...contract('default') };
  const history = { ...canonical, version: 1, ...contract('required') };
  const pinned = { actions: [], refs: [{ recordId: canonical.id, versionPolicy: 'pinned', targetVersion: 1 }] };
  expect(formationRuleSourceRequests(pinned, [canonical, history], '')[0].before).toEqual(history);
  const update = { actions: [{ intent: 'update', recordId: canonical.id, expectedVersion: 2, patch: { strength: 'required' } }],
    refs: [{ recordId: canonical.id, versionPolicy: 'current' }] };
  expect(formationRuleSourceRequests(update, [canonical, history], '')[0].before).toEqual(canonical);
  expect(blindFormationRuleCandidate({ ontologyChanges: pinned }, [canonical, history])).toEqual({ ontologyChanges: pinned });
});

it('recomputes a changed full draft from the same source and never reuses an old grant fingerprint', async () => {
  run.mockResolvedValue(answer());
  const first = await assessFormationBatch('quality-benchmark-user', input());
  const args = input();
  args.items[0].candidate.ontologyChanges.actions.find(action => action.record.kind === 'rule').record.strength = 'required';
  const next = await assessFormationBatch('quality-benchmark-user', { ...args, checkpoint: first });
  // A changed full draft cannot reuse the earlier assessment, even when the
  // source observation is identical; the host rechecks it with a fresh call.
  expect(run).toHaveBeenCalledTimes(2);
  expect(next.sourceFingerprint).toBe(first.sourceFingerprint); expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(first.assessments[0].ruleRevisions).toHaveLength(1); expect(next.assessments[0].ruleRevisions).toBeUndefined();
  // An old ruleChecks checkpoint cannot be elevated to this source protocol.
  await assessFormationBatch('quality-benchmark-user', { ...args, checkpoint: { fingerprint: next.fingerprint, sourceFingerprint: next.sourceFingerprint,
    assessments: [retained.assessment] } as any });
  expect(run).toHaveBeenCalledTimes(3);
});

it('keeps the whole f12 rule when its field evidence is outside the value anchor but refers to the same complete source', () => {
  const body = '部署评审必须在材料里额外写风险和回退条件。普通例会不加这两栏。';
  const sources = [{ label: 'm24', text: body, approvedQuotes: ['普通例会不加这两栏。'] }];
  const actual = { recordId: 'rule-f12', ...contract('default'), exception: '普通例会不加这两栏。' };
  const source = { recordId: actual.recordId, status: 'resolved', expectedContract: { ...contract(), exception: actual.exception },
    topicEvidence: [{ label: 'm24', approvedQuoteIndex: 0 }], fieldEvidence: {
      strength: [{ label: 'm24', quote: '部署评审必须在材料里额外写风险和回退条件。' }], condition: [], effect: [], exception: [{ label: 'm24', quote: actual.exception }] } };
  const parsed = parseSourceRuleConclusions([source], [actual], sources);
  const raw = { actions: [{ intent: 'create', recordId: actual.recordId, record: { kind: 'rule', ...actual } }] };
  expect(deriveFormationRuleRevisions(raw, parsed, [], true).ruleRevisions[0]).toEqual({ ...actual, strength: 'required' });
  expect(() => parseSourceRuleConclusions([{ ...source, topicEvidence: source.fieldEvidence.strength }], [actual], sources)).toThrow();
  expect(() => parseSourceRuleConclusions([{ ...source, fieldEvidence: { ...source.fieldEvidence,
    strength: [{ label: 'another-topic', quote: body }] } }], [actual], sources)).toThrow();
});

it('holds unowned referenced differences and unresolved same-message topics without manufacturing an action', () => {
  const record = { id: 'rule-incident-review', kind: 'rule', version: 1, ...contract('default') };
  const raw = { actions: [], refs: [{ recordId: record.id, versionPolicy: 'current' }] };
  const parsed = parseSourceRuleConclusions([conclusion()], formationRuleContracts(raw, [record]), retained.item.sources);
  expect(deriveFormationRuleRevisions(raw, parsed, [record], true)).toMatchObject({ supported: false, ruleRevisions: [] });
  expect(raw.actions).toEqual([]);
  const separate = [{ recordId: record.id, status: 'not_supported' as const, reason: 'The quoted requirement concerns another project, not the anchored incident-review topic.' }];
  expect(deriveFormationRuleRevisions(raw, separate, [record], true).supported).toBe(false);
});

it.each(['missing', 'duplicate', 'invalid_effect', 'unanchored', 'old_patch'])('fails closed on %s source conclusions', async mode => {
  const source: any = conclusion();
  if (mode === 'invalid_effect') source.expectedContract.effect = { kind: 'execute_code' };
  if (mode === 'unanchored') source.topicEvidence = [];
  const row: any = { index: 2, checks: retained.assessment.checks, uncertaintyDisposition: 'none' };
  if (mode === 'old_patch') row.ruleRevisions = [{ recordId: source.recordId, ...contract() }];
  else if (mode !== 'missing') row.sourceRuleConclusions = mode === 'duplicate' ? [source, source] : [source];
  run.mockResolvedValue({ result: { text: JSON.stringify({ assessments: [row] }), meta: {} } });
  await expect(assessFormationBatch('quality-benchmark-user', input())).rejects.toMatchObject({ reason: 'assessment_invalid' });
});

it('retains the final real malformed source response as rejection and keeps canonical types and literal evidence strict', () => {
  const invalid = JSON.parse(fs.readFileSync(path.resolve('test/main/features/recall/ontology-rule-source-invalid-live.fixture.json'), 'utf8'));
  const response = JSON.parse(invalid.rawResponse);
  let rejected = 0;
  for (const item of invalid.sourceRows) {
    const row = response.assessments.find(row => row.index === item.index);
    const identities = item.ruleSourceRequests.map(request => ({ recordId: request.recordId, ...contract('default') }));
    expect(() => parseSourceRuleConclusions(row.sourceRuleConclusions, identities, item.sources)).toThrow();
    rejected += identities.length;
  }
  expect(rejected).toBe(9);
  const actual = [{ recordId: 'rule-incident-review', ...contract('default') }];
  for (const patch of [{ condition: '事故复盘时' }, { exception: null }, { effect: 'note' }]) {
    expect(() => parseSourceRuleConclusions([{ ...conclusion(), expectedContract: { ...contract(), ...patch } }], actual, retained.item.sources)).toThrow();
  }
  expect(() => parseSourceRuleConclusions([{ ...conclusion(), fieldEvidence: { ...conclusion().fieldEvidence,
    strength: [{ label: 'm8', quote: '事故复盘今后要记影响……每项改进有负责人和期限' }] } }], actual, retained.item.sources)).toThrow();
  expect(parseSourceRuleConclusions([conclusion()], actual, retained.item.sources)[0]).toMatchObject({ status: 'resolved', expectedContract: contract() });
});
