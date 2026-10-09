import { describe, expect, it } from 'vitest';
import { getRuntimeOpenAIToolCatalog, getRuntimeToolCatalog } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/catalog';

describe('CogSeed Office tool contract', () => {
  it('exposes only CogSeed host Office tools', () => {
    const catalog = getRuntimeToolCatalog();
    expect(catalog.filter((x) => x.name.startsWith('office_')).map((x) => [x.name, x.kind])).toEqual([
      ['office_read', 'host'], ['office_create', 'host'], ['office_edit', 'host'], ['office_render', 'host'],
    ]);
    expect(getRuntimeOpenAIToolCatalog().map((x) => x.name)).toContain('office_create');
  });
});
