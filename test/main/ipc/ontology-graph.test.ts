import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphApi = vi.hoisted(() => ({
  readOntologyGraph: vi.fn(),
  createOntologyCategory: vi.fn(),
  updateOntologyCategory: vi.fn(),
  deleteOntologyCategory: vi.fn(),
  createOntologyEntity: vi.fn(),
  updateOntologyEntity: vi.fn(),
  deleteOntologyEntity: vi.fn(),
  createOntologyRelation: vi.fn(),
  updateOntologyRelation: vi.fn(),
  deleteOntologyRelation: vi.fn(),
}));

vi.mock('../../../src/main/features/ontology_graph', () => graphApi);

describe('ontology graph IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps legacy reads authenticated and prevents legacy writes from bypassing common governance', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/ontology-graph');
    const ctx = { userId: 'authenticated-user' };
    graphApi.readOntologyGraph.mockResolvedValue({ schemaVersion: 1, categories: [], entities: [], relations: [] });

    await invokeHandlers['ontology.graph.read']({ userId: 'attacker' }, ctx);
    for (const channel of ['ontology.category.create', 'ontology.category.update', 'ontology.category.delete',
      'ontology.entity.create', 'ontology.entity.update', 'ontology.entity.delete',
      'ontology.relation.create', 'ontology.relation.update', 'ontology.relation.delete']) {
      await expect(invokeHandlers[channel]({ userId: 'attacker' }, ctx)).rejects.toMatchObject({ code: 'legacy_write_disabled' });
    }

    expect(graphApi.readOntologyGraph).toHaveBeenCalledWith('authenticated-user');
    for (const method of ['createOntologyCategory', 'updateOntologyCategory', 'deleteOntologyCategory', 'createOntologyEntity', 'updateOntologyEntity', 'deleteOntologyEntity', 'createOntologyRelation', 'updateOntologyRelation', 'deleteOntologyRelation'])
      expect(graphApi[method]).not.toHaveBeenCalled();
  });

  it('returns the same governance error for malformed legacy writes', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/ontology-graph');
    await expect(invokeHandlers['ontology.entity.create'](null, { userId: 'user-1' })).rejects.toMatchObject({ code: 'legacy_write_disabled' });
    expect(graphApi.createOntologyEntity).not.toHaveBeenCalled();
  });
});
