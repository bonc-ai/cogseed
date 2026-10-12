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

  it('binds every graph read and mutation to the authenticated IPC user', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/ontology-graph');
    const ctx = { userId: 'authenticated-user' };
    graphApi.readOntologyGraph.mockResolvedValue({ schemaVersion: 1, categories: [], entities: [], relations: [] });
    graphApi.createOntologyCategory.mockResolvedValue({ id: 'category-1' });
    graphApi.updateOntologyCategory.mockResolvedValue({ id: 'category-1' });
    graphApi.deleteOntologyCategory.mockResolvedValue(undefined);
    graphApi.createOntologyEntity.mockResolvedValue({ id: 'entity-1' });
    graphApi.updateOntologyEntity.mockResolvedValue({ id: 'entity-1' });
    graphApi.deleteOntologyEntity.mockResolvedValue(undefined);
    graphApi.createOntologyRelation.mockResolvedValue({ id: 'relation-1' });
    graphApi.updateOntologyRelation.mockResolvedValue({ id: 'relation-1' });
    graphApi.deleteOntologyRelation.mockResolvedValue(undefined);

    await invokeHandlers['ontology.graph.read']({ userId: 'attacker' }, ctx);
    await invokeHandlers['ontology.category.create']({ domain: 'affairs', name: 'Project', userId: 'attacker' }, ctx);
    await invokeHandlers['ontology.category.update']({ categoryId: 'category-1', name: 'Projects' }, ctx);
    await invokeHandlers['ontology.category.delete']({ categoryId: 'category-1' }, ctx);
    await invokeHandlers['ontology.entity.create']({ categoryId: 'category-1', name: 'Release' }, ctx);
    await invokeHandlers['ontology.entity.update']({ entityId: 'entity-1', name: 'Release 1' }, ctx);
    await invokeHandlers['ontology.entity.delete']({ entityId: 'entity-1' }, ctx);
    await invokeHandlers['ontology.relation.create']({ predicate: 'owns' }, ctx);
    await invokeHandlers['ontology.relation.update']({ relationId: 'relation-1', predicate: 'leads' }, ctx);
    await invokeHandlers['ontology.relation.delete']({ relationId: 'relation-1' }, ctx);

    expect(graphApi.readOntologyGraph).toHaveBeenCalledWith('authenticated-user');
    expect(graphApi.createOntologyCategory).toHaveBeenCalledWith('authenticated-user', { domain: 'affairs', name: 'Project', userId: 'attacker' });
    expect(graphApi.updateOntologyCategory).toHaveBeenCalledWith('authenticated-user', { categoryId: 'category-1', name: 'Projects' });
    expect(graphApi.deleteOntologyCategory).toHaveBeenCalledWith('authenticated-user', 'category-1');
    expect(graphApi.createOntologyEntity).toHaveBeenCalledWith('authenticated-user', { categoryId: 'category-1', name: 'Release' });
    expect(graphApi.updateOntologyEntity).toHaveBeenCalledWith('authenticated-user', { entityId: 'entity-1', name: 'Release 1' });
    expect(graphApi.deleteOntologyEntity).toHaveBeenCalledWith('authenticated-user', 'entity-1');
    expect(graphApi.createOntologyRelation).toHaveBeenCalledWith('authenticated-user', { predicate: 'owns' });
    expect(graphApi.updateOntologyRelation).toHaveBeenCalledWith('authenticated-user', { relationId: 'relation-1', predicate: 'leads' });
    expect(graphApi.deleteOntologyRelation).toHaveBeenCalledWith('authenticated-user', 'relation-1');
  });

  it('normalizes non-object payloads to empty input so the feature validator rejects them', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/ontology-graph');
    graphApi.createOntologyEntity.mockRejectedValue(new Error('entity category id required'));
    await expect(invokeHandlers['ontology.entity.create'](null, { userId: 'user-1' })).rejects.toThrow('entity category id required');
    expect(graphApi.createOntologyEntity).toHaveBeenCalledWith('user-1', {});
  });
});
