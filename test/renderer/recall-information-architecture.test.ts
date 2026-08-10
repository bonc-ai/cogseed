import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  normalizeRecallLocation,
  normalizeAbilityCategory,
} from '../../src/renderer/modules/recall-information-architecture';

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/recall-information-architecture.js'),
  'utf8',
);

function loadClassicScriptApi() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context, { filename: 'recall-information-architecture.js' });
  return (context.window as Record<string, any>).RecallInformationArchitecture;
}

describe('Recall information architecture', () => {
  it('exports the frozen four-category contract to classic scripts', () => {
    const api = loadClassicScriptApi();

    expect(api).toBeDefined();
    expect(api.normalizeRecallLocation).toBeTypeOf('function');
    expect(api.normalizeAbilityCategory).toBeTypeOf('function');
    expect(Array.from(api.CATEGORY_ORDER)).toEqual(['personal', 'rule', 'template', 'skill_method']);
    expect(Object.isFrozen(api.CATEGORY_ORDER)).toBe(true);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it('exports CATEGORY_ORDER through the CommonJS bridge in the required order', () => {
    expect(CATEGORY_ORDER).toEqual(['personal', 'rule', 'template', 'skill_method']);
    expect(Object.isFrozen(CATEGORY_ORDER)).toBe(true);
  });

  it.each([
    ['overview', { page: 'overview', subview: '' }],
    ['deposition', { page: 'deposition', subview: 'candidates' }],
    ['sources', { page: 'deposition', subview: 'sources' }],
    ['captures', { page: 'deposition', subview: 'captures' }],
    ['candidates', { page: 'deposition', subview: 'candidates' }],
    ['assets', { page: 'assets', subview: 'list' }],
    ['brain', { page: 'assets', subview: 'tree' }],
    ['context', { page: 'assets', subview: 'reuse' }],
    ['ontology', { page: 'assets', subview: 'list', category: 'personal' }],
    ['receipts', { page: 'assets', subview: 'reuse' }],
    ['not-a-real-page', { page: 'overview', subview: '' }],
  ])('maps route %s into the exact new location', (legacy, expected) => {
    expect(normalizeRecallLocation(legacy)).toEqual(expected);
  });

  it.each([
    [null],
    [undefined],
    ['   '],
    [42],
    [['deposition']],
    [{ toString: () => 'assets' }],
  ])('defaults invalid route input %j to overview', (value) => {
    expect(normalizeRecallLocation(value)).toEqual({ page: 'overview', subview: '' });
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

  it.each([
    [null],
    [undefined],
    ['   '],
    [42],
    [['rule']],
    [{ toString: () => 'template' }],
  ])('rejects invalid category input %j', (value) => {
    expect(normalizeAbilityCategory(value)).toBe('');
  });
});
