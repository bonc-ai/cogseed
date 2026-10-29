import { describe, expect, it } from 'vitest';
import { parseFormationProposalEnvelope } from '../../../../src/main/features/recall/formation-proposal';

const labels = new Set(['m1', 'm2']);
const content = { summary: 'Project owner changes', value: 'Use the correct responsible person in future project work.',
  suggestedScope: 'project', risk: 'low', evidence: ['m1'] };
const cognition = { ...content, judgment: 'When preparing a project report, verify the current owner.', suggestedAction: 'create' };
const ontologyChanges = { reason: 'The user explicitly described a dated owner change.', evidence: ['m1'],
  actions: [{ intent: 'change', recordId: 'owner', expectedVersion: 1, effectiveFrom: '2026-11-01', sourceLabel: 'm1', object: { kind: 'entity', id: 'person-2' } }] };
const ontology = { id: 'owner-change', target: 'ontology', explanation: { ...content, description: 'From November, person 2 takes over this project.' }, ontologyChanges };
const parse = (proposals: unknown[]) => parseFormationProposalEnvelope({ proposalVersion: 2, proposals }, labels);

describe('explicit formation proposal ownership', () => {
  it('represents an ontology-only change without inventing cognition content', () => {
    const result = parse([ontology]);
    expect(result.proposals[0].target).toBe('ontology');
    expect(result.proposals[0]).not.toHaveProperty('cognition');
    expect(result.proposals[0]).not.toHaveProperty('judgment');
  });
  it('keeps independent cognition and ontology proposals separate while grouping joint changes', () => {
    const result = parse([{ id: 'report-check', target: 'cognition', cognition }, ontology,
      { id: 'joint-rule', target: 'joint', cognition, ontologyChanges }]);
    expect(result.proposals.map(item => item.target)).toEqual(['cognition', 'ontology', 'joint']);
  });
  it.each([
    { ...ontology, cognition },
    { ...ontology, ontologyChanges: { ...ontologyChanges, actions: [] } },
    { ...ontology, explanation: { ...ontology.explanation, evidence: ['missing'] } },
    { ...ontology, dependsOn: ['another-group'] },
  ])('drops one malformed proposal without voiding its valid siblings %#', invalid => {
    const result = parse([invalid, { id: 'report-check', target: 'cognition', cognition }]);
    expect(result.proposals.map(item => item.id)).toEqual(['report-check']);
    expect(result.emittedCount).toBe(2);
    expect(result.firstDroppedReason).toBeTruthy();
  });
  it('drops a malformed duplicate: identity applies to the surviving proposals', () => {
    const result = parse([{ ...ontology, dependsOn: ['later'] }, ontology]);
    expect(result.proposals.map(item => item.id)).toEqual(['owner-change']);
    expect(result.emittedCount).toBe(2);
  });
  it('keeps identity and dependency checks batch-level: duplicate ids and unowned ontology evidence still reject the envelope', () => {
    expect(() => parse([ontology, ontology])).toThrow('duplicate');
    expect(() => parse([{ ...ontology, ontologyChanges: { ...ontologyChanges, evidence: ['m2'] } }]))
      .toThrow('ontology evidence must belong to its proposal');
    expect(() => parseFormationProposalEnvelope({ candidates: [cognition], ontologyChanges }, labels)).toThrow();
    expect(() => parseFormationProposalEnvelope({ proposalVersion: 2, proposals: [ontology], ontologyChanges }, labels)).toThrow();
  });
  it('retains the supported body and allows a correctly empty extraction', () => {
    const body = 'Use the template.\n\nExcept when the user explicitly asks for a different format.';
    expect(parse([{ id: 'template', target: 'cognition', cognition: { ...cognition, judgment: body } }]).proposals[0])
      .toMatchObject({ cognition: { judgment: body } });
    expect(parse([]).proposals).toEqual([]);
  });
});
