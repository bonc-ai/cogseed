import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const { _aiSelectFilterOptions, _aiSelectNextZIndex } = utils as {
  _aiSelectFilterOptions: (options: Array<{ value: string; label: string; hint?: string }>, query: string) => Array<{ value: string }>;
  _aiSelectNextZIndex: (values: unknown[], fallback?: number) => number;
};

describe('AiSelect searchable filtering', () => {
  const options = [
    { value: 'core', label: 'Core Agent', hint: 'Built in' },
    { value: 'openai', label: 'OpenAI', hint: 'API Key / OAuth' },
    { value: 'custom', label: '自定义供应商', hint: 'OpenAI compatible' },
  ];

  it('matches labels and hints without mutating the source list', () => {
    expect(_aiSelectFilterOptions(options, 'openai').map((item) => item.value)).toEqual(['openai', 'custom']);
    expect(_aiSelectFilterOptions(options, 'oauth').map((item) => item.value)).toEqual(['openai']);
    expect(_aiSelectFilterOptions(options, '').map((item) => item.value)).toEqual(['core', 'openai', 'custom']);
    expect(options).toHaveLength(3);
  });

  it('returns a stable empty result for an unmatched IME query', () => {
    expect(_aiSelectFilterOptions(options, '不存在')).toEqual([]);
  });
});

describe('AiSelect popover layering', () => {
  it('stays at the base layer when no ancestor has a z-index', () => {
    expect(_aiSelectNextZIndex(['auto', '', undefined])).toBe(14000);
  });

  it('stays above the shared dialog overlay by default', () => {
    expect(_aiSelectNextZIndex(['auto', '13000', '100'])).toBe(14000);
  });

  it('raises above future overlay layers higher than the base layer', () => {
    expect(_aiSelectNextZIndex(['auto', '15000', '100'])).toBe(15001);
  });

});
