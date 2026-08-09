import { describe, expect, it } from 'vitest';
import { normalizeRecallLocation, normalizeAbilityCategory } from '../../src/renderer/modules/recall-information-architecture';

describe('Recall information architecture', () => {
  it.each([
    ['overview', { page: 'overview', subview: '' }],
    ['sources', { page: 'deposition', subview: 'sources' }],
    ['captures', { page: 'deposition', subview: 'captures' }],
    ['candidates', { page: 'deposition', subview: 'candidates' }],
    ['assets', { page: 'assets', subview: 'list' }],
    ['brain', { page: 'assets', subview: 'tree' }],
    ['context', { page: 'assets', subview: 'reuse' }],
    ['ontology', { page: 'assets', subview: 'list', category: 'personal' }],
    ['receipts', { page: 'assets', subview: 'reuse' }],
    ['not-a-real-page', { page: 'overview', subview: '' }],
  ])('maps legacy page %s into the new location', (legacy, expected) => {
    expect(normalizeRecallLocation(legacy)).toMatchObject(expected);
  });

  it.each([
    ['personal', 'personal'],
    ['preference', 'personal'],
    ['ontology', 'personal'],
    ['rule', 'rule'],
    ['template', 'template'],
    ['skill_method', 'skill_method'],
    ['skill_evolution', 'skill_method'],
    ['experience', 'skill_method'],
    ['evaluation', ''],
    ['', ''],
  ])('normalizes legacy type %s into the four-category contract', (value, expected) => {
    expect(normalizeAbilityCategory(value)).toBe(expected);
  });
});
