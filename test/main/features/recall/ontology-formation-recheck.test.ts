import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
const model = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: model }));
vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {} }));
let root: string, previous: string | undefined;
beforeEach(() => { vi.resetModules(); model.mockReset(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'formation-recheck-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(async () => { await drainMainRuntimeForTest('alice'); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'Synthetic approved user evidence' });
const body = '以后回答先给结论，再说明关键依据。';
async function fixture(missingReferencePolicy = false) {
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  const ontology = await import('../../../../src/main/features/cognition/ontology/service');
  const formation = await import('../../../../src/main/features/recall/ontology-formation');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const recheck = await import('../../../../src/main/features/recall/ontology-formation-recheck');
  await bridge.replaceCognitionSources('alice', { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
  await ontology.commitOntologyCommand('alice', { commandId: 'seed', expectedRevision: 0, actions: [
    create('personal', { kind: 'module', name: '我的本体', description: '', scope: { kind: 'personal' } }),
    create('person-type', { kind: 'definition', moduleId: 'personal', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('self', { kind: 'entity', moduleId: 'personal', typeId: 'person-type', name: 'Synthetic user', description: '', aliases: [], identityStatus: 'confirmed' }),
    create('preference', { kind: 'definition', moduleId: 'personal', name: '表达偏好', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
  ] });
  const proposal = (text: string) => ({ reason: 'Synthetic approved preference', evidence: ['m1'], refs: [{ moduleId: 'personal', recordId: 'expression', versionPolicy: 'current' }], actions: [
    create('expression', { kind: 'assertion', moduleId: 'personal', subjectId: 'self', definitionId: 'preference', object: { kind: 'literal', valueType: 'text', value: text }, validity: { from: null, until: null, precision: 'day', timezone: 'Asia/Shanghai' }, certainty: 'confirmed' }),
  ] });
  const initialProposal = proposal(body);
  if (missingReferencePolicy) delete (initialProposal.refs[0] as Record<string, unknown>).versionPolicy;
  const plan = formation.parseOntologyFormationProposal(ontology.readOntologyDocument('alice'), 'temporary', initialProposal, body)!;
  expect(plan.blockedReasons).toEqual(missingReferencePolicy ? ['invalid_ontology_proposal'] : []);
  const candidate = await createNightlyCandidateFixture('alice', { judgment: body, summary: '回答表达顺序', value: '长期保持清晰的表达顺序有助于后续沟通。', suggestedType: 'cognition', suggestedScope: 'general', sourceRefs: [], rawStatement: true, ontologyFormation: plan });
  const edit = (text: string) => candidates.updateRecallCandidate('alice', candidate.id, { judgment: text, value: candidate.value, summary: candidate.summary, suggestedType: candidate.suggestedType, suggestedScope: candidate.suggestedScope, suggestedAction: candidate.suggestedAction, sourceRefs: candidate.sourceRefs, evidenceRefs: candidate.evidenceRefs });
  return { ontology, candidates, recheck, candidate, edit, proposal };
}
describe('explicit ontology dependency recheck', () => {
  it('blocks a stale non-shared A proposal after editing and only saves a new preview after complete recheck', async () => {
    const f = await fixture();
    const editedBody = '以后回答先给结论，再说明关键依据；无法核实的内容明确说明。';
    const edited = await f.edit(editedBody);
    expect(edited.ontologyFormation?.blockedReasons).toContain('candidate_edited_requires_ontology_review');
    await expect(f.candidates.promoteRecallCandidate('alice', edited.id, { actor: 'user' })).rejects.toMatchObject({ code: 'formation_blocked' });
    expect(f.ontology.readOntologyDocument('alice').records.expression).toBeUndefined();
    model.mockResolvedValue({ result: { text: JSON.stringify({ ontologyChanges: f.proposal(editedBody) }), meta: {} } });
    const rechecked = await f.recheck.recheckOntologyFormation('alice', edited.id);
    expect(rechecked).toMatchObject({ status: 'pending_review', judgment: editedBody, userModifiedAt: expect.any(String), ontologyFormation: { blockedReasons: [] } });
    expect(f.ontology.readOntologyDocument('alice').records.expression).toBeUndefined();
    const payload = JSON.parse(model.mock.calls[0][1].message);
    expect(payload.approvedUserEvidence).toEqual([expect.objectContaining({ label: 'm1', role: 'user', quote: expect.stringContaining('Synthetic test user evidence') })]);
    expect(payload.cognition.judgment).toBe(editedBody);
    expect(Object.fromEntries(payload.ontology.records.map((record: { id: string }) => [record.id, record])))
      .toEqual(f.ontology.readOntologyDocument('alice').records);
    const prompt = model.mock.calls[0][1].systemPrompt;
    expect(prompt).toContain('Return exactly one JSON object {"ontologyChanges":Proposal}');
    expect(prompt).toContain('CanonicalRef = {moduleId,recordId,versionPolicy:');
    expect(prompt).toContain("requirementSource:'cognition_body'");
    expect(prompt).not.toContain('INSIDE that candidate object');
    expect(prompt).not.toContain('NEVER at the top level');
    const { ontologyFormationPromptContract } = await import('../../../../src/main/features/recall/ontology-formation');
    expect(ontologyFormationPromptContract).toContain('proposalVersion:2');
    expect(ontologyFormationPromptContract).toContain('joint proposal owns cognition and ontologyChanges');
    expect(model).toHaveBeenCalledTimes(1);
    const saved = await f.candidates.promoteRecallCandidate('alice', edited.id, { actor: 'user' });
    expect(saved.candidate.status).toBe('confirmed');
    expect(f.ontology.readOntologyDocument('alice').records.expression).toMatchObject({ object: { value: editedBody } });
  });
  it('rejects a concurrent edit even if its timestamp is identical to the recheck snapshot', async () => {
    const f = await fixture();
    const store = await import('../../../../src/main/features/recall/store');
    model.mockImplementation(async () => {
      await store.updateRecallJsonRecord('alice', 'candidates', f.candidate.id, raw => ({ ...raw!, judgment: '并行编辑后的正文', updatedAt: f.candidate.updatedAt }));
      return { result: { text: JSON.stringify({ ontologyChanges: f.proposal(body) }), meta: {} } };
    });
    await expect(f.recheck.recheckOntologyFormation('alice', f.candidate.id)).rejects.toMatchObject({ code: 'ontology_recheck_candidate_changed' });
    expect((await f.candidates.readRecallCandidate('alice', f.candidate.id)).judgment).toBe('并行编辑后的正文');
  });
  it('holds invented evidence labels in the new preview and rejects a revoked source before a model call', async () => {
    const f = await fixture();
    model.mockResolvedValue({ result: { text: JSON.stringify({ ontologyChanges: { ...f.proposal(body), evidence: ['m999'] } }), meta: {} } });
    const held = await f.recheck.recheckOntologyFormation('alice', f.candidate.id);
    expect(held.ontologyFormation?.blockedReasons).toContain('ontology_evidence_unapproved');
    const controls = await import('../../../../src/main/features/recall/source-control');
    await controls.pauseCognitionSource('alice', held.sourceRefs[0]);
    model.mockClear();
    await expect(f.recheck.recheckOntologyFormation('alice', f.candidate.id)).rejects.toThrow(/unavailable/);
    expect(model).not.toHaveBeenCalled();
  });

  it('recovers a missing reference policy only from a new explicit complete model proposal, retaining the original body and provenance', async () => {
    const f = await fixture(true);
    expect(f.candidate.ontologyFormation?.blockedReasons).toEqual(['invalid_ontology_proposal']);
    await expect(f.candidates.promoteRecallCandidate('alice', f.candidate.id, { actor: 'user' })).rejects.toMatchObject({ code: 'formation_blocked' });
    model.mockResolvedValue({ result: { text: JSON.stringify({ ontologyChanges: f.proposal(body) }), meta: {} } });
    const rechecked = await f.recheck.recheckOntologyFormation('alice', f.candidate.id);
    expect(rechecked.judgment).toBe(f.candidate.judgment);
    expect(rechecked.captureProvenance).toEqual(f.candidate.captureProvenance);
    expect(rechecked.ontologyFormation?.blockedReasons).toEqual([]);
    expect(rechecked.ontologyFormation?.refs[0].versionPolicy).toBe('current');
    expect(rechecked.status).toBe(f.candidate.status);
    expect(f.ontology.readOntologyDocument('alice').records.expression).toBeUndefined();
    const saved = await f.candidates.promoteRecallCandidate('alice', f.candidate.id, { actor: 'user' });
    expect(saved.asset.statement).toBe(body);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each(['candidates', 'extra'] as const)('rejects a %s output envelope without replacing the existing preview', async shape => {
    const f = await fixture();
    const raw = shape === 'candidates' ? { candidates: [{ ontologyChanges: f.proposal(body) }] }
      : { ontologyChanges: f.proposal(body), permission: 'save now' };
    model.mockResolvedValue({ result: { text: JSON.stringify(raw), meta: {} } });
    await expect(f.recheck.recheckOntologyFormation('alice', f.candidate.id)).rejects.toMatchObject({ code: 'ontology_recheck_invalid_output' });
    expect(await f.candidates.readRecallCandidate('alice', f.candidate.id)).toEqual(f.candidate);
    expect(f.ontology.readOntologyDocument('alice').records.expression).toBeUndefined();
  });

  it('keeps a regenerated reference without versionPolicy blocked instead of defaulting it to current', async () => {
    const f = await fixture();
    const raw = f.proposal(body);
    delete (raw.refs[0] as Record<string, unknown>).versionPolicy;
    const original = structuredClone(raw);
    model.mockResolvedValue({ result: { text: JSON.stringify({ ontologyChanges: raw }), meta: {} } });
    const held = await f.recheck.recheckOntologyFormation('alice', f.candidate.id);
    expect(held.ontologyFormation?.blockedReasons).toContain('invalid_ontology_proposal');
    expect(raw).toEqual(original);
    expect(held.judgment).toBe(body);
    await expect(f.candidates.promoteRecallCandidate('alice', held.id, { actor: 'user' })).rejects.toMatchObject({ code: 'formation_blocked' });
    expect(f.ontology.readOntologyDocument('alice').records.expression).toBeUndefined();
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'ontology'] as const)('rejects changed %s state after the recheck model wait without replacing the proposal', async change => {
    const f = await fixture();
    model.mockImplementation(async () => {
      if (change === 'source') {
        const controls = await import('../../../../src/main/features/recall/source-control');
        await controls.pauseCognitionSource('alice', f.candidate.sourceRefs[0]);
      } else {
        const doc = f.ontology.readOntologyDocument('alice');
        await f.ontology.commitOntologyCommand('alice', { commandId: 'concurrent-ontology-edit', expectedRevision: doc.revision,
          actions: [{ intent: 'update', recordId: 'personal', expectedVersion: doc.records.personal.version,
            sourceLabel: 'Synthetic concurrent edit', patch: { description: 'Concurrent canonical context' } }] });
      }
      return { result: { text: JSON.stringify({ ontologyChanges: f.proposal(body) }), meta: {} } };
    });
    const call = f.recheck.recheckOntologyFormation('alice', f.candidate.id);
    if (change === 'source') await expect(call).rejects.toThrow(/unavailable/);
    else await expect(call).rejects.toMatchObject({ code: 'ontology_recheck_baseline_changed' });
    expect(await f.candidates.readRecallCandidate('alice', f.candidate.id)).toEqual(f.candidate);
    expect(f.ontology.readOntologyDocument('alice').records.expression).toBeUndefined();
  });
});
