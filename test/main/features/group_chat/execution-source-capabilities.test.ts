import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/features/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/auth')>();
  return {
    ...actual,
    listEntries: vi.fn(async () => ({
      entries: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p1', model: 'm1' },
      ],
    })),
    listModels: vi.fn(async (provider: string) => ({
      models: provider === 'p1'
        ? [{ id: 'm1', name: 'm1', reasoning: false }, { id: 'm2', name: 'm2', reasoning: true }]
        : [],
    })),
  };
});

import { _executionSourceCapabilities, _validateExecutionConfigMapForSources } from '../../../../src/main/features/group_chat/index';

describe('execution source capabilities', () => {
  it('reports the full provider catalog, dedupes entries and accepts an unselected catalog model', async () => {
    const capabilities = await _executionSourceCapabilities('fixture-user', []);
    const internal = capabilities.internal as { kind: 'internal'; models: Array<{ provider: string; model: string; effort: boolean }> };
    expect(internal.models).toEqual([
      { provider: 'p1', model: 'm1', effort: false },
      { provider: 'p1', model: 'm2', effort: true },
    ]);
    expect(_validateExecutionConfigMapForSources({ internal: { provider: 'p1', model: 'm2' } }, capabilities)).toEqual({
      internal: { provider: 'p1', model: 'm2' },
    });
  });
});
