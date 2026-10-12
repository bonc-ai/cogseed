import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphMock = vi.hoisted(() => ({ readOntologyGraph: vi.fn() }));

vi.mock('../../../../src/main/features/ontology_graph', () => graphMock);
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../../../src/main/features/personal_ontology_contract', () => ({
  describeRoleTemplateFieldRef: () => null,
  listRoleTemplateFieldTargets: vi.fn(async () => []),
}));

import { createPersonalOntologyTools } from '../../../../src/main/model/core-agent/personal-ontology-tools';

describe('Personal Ontology agent tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads categories, matching entities, and their relations without exposing a write path', async () => {
    graphMock.readOntologyGraph.mockResolvedValue({
      schemaVersion: 1,
      categories: [
        { id: 'cat-project', domain: 'affairs', name: '项目', description: '', fields: [{ id: 'status', name: '状态', kind: 'text' }], builtIn: true },
        { id: 'cat-person', domain: 'resources', name: '人物', description: '', fields: [], builtIn: true },
      ],
      entities: [
        { id: 'project-a', domain: 'affairs', categoryId: 'cat-project', name: '发布项目', description: '月底发布', properties: { status: '进行中' }, sourceRefs: [{ kind: 'asset', id: 'asset-a' }], status: 'active' },
        { id: 'person-a', domain: 'resources', categoryId: 'cat-person', name: '负责人', description: '', properties: {}, sourceRefs: [], status: 'active' },
      ],
      relations: [{
        id: 'relation-a', subject: { kind: 'self' }, predicate: '负责', object: { kind: 'entity', id: 'project-a' },
        note: '项目负责人', sourceRefs: [],
      }],
    });
    const tools = createPersonalOntologyTools({ userId: 'user-a' });
    const graphTool = tools.find((tool) => tool.name === 'list_ontology_graph');
    expect(graphTool).toBeDefined();
    expect(graphTool?.inputSchema).toMatchObject({ additionalProperties: false });

    const result = await graphTool!.execute({ domain: 'affairs', query: '发布' });
    const payload = JSON.parse(result.content);

    expect(graphMock.readOntologyGraph).toHaveBeenCalledWith('user-a');
    expect(payload).toMatchObject({
      readOnly: true,
      domain: 'affairs',
      totals: { categories: 1, entities: 1, relations: 1 },
      entities: [{ id: 'project-a', name: '发布项目', category: '项目' }],
      relations: [{ id: 'relation-a', predicate: '负责' }],
    });
    expect(graphTool?.name).not.toContain('create');
    expect(graphTool?.name).not.toContain('edit');
  });

  it('rejects invalid filters before reading the graph', async () => {
    const graphTool = createPersonalOntologyTools({ userId: 'user-a' })
      .find((tool) => tool.name === 'list_ontology_graph')!;

    await expect(graphTool.execute({ domain: 'unknown' })).resolves.toMatchObject({ isError: true });
    await expect(graphTool.execute({ query: 'x'.repeat(201) })).resolves.toMatchObject({ isError: true });
    expect(graphMock.readOntologyGraph).not.toHaveBeenCalled();
  });
});
