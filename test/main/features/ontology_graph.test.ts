import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/features/recall/store-events', () => ({
  notifyCognitionWrite: vi.fn(),
}));

const UID = 'test-user-ontology-graph';
let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-graph-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadGraph() {
  return import('../../../src/main/features/ontology_graph');
}

function graphFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'ontology-graph.json');
}

describe('ontology_graph', () => {
  it('returns built-in categories without creating a graph file', async () => {
    const graph = await loadGraph();
    const snapshot = await graph.readOntologyGraph(UID);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.categories.some((category) => category.id === 'builtin_affairs_project')).toBe(true);
    expect(snapshot.categories.some((category) => category.id === 'builtin_resource_tool')).toBe(true);
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.relations).toEqual([]);
    expect(fs.existsSync(graphFile())).toBe(false);
  });

  it('persists custom categories and entities with stable IDs and source references only', async () => {
    const graph = await loadGraph();
    const category = await graph.createOntologyCategory(UID, {
      domain: 'affairs',
      name: '研发项目',
      description: '用户维护的项目分类',
      parentId: 'builtin_affairs_project',
      fields: ['负责人', '目标日期'],
    });
    const entity = await graph.createOntologyEntity(UID, {
      categoryId: category.id,
      name: '认知图谱上线',
      description: '完成可编辑的本体图谱。',
      properties: { [category.fields[0].id]: '子安' },
      sourceRefs: [
        { kind: 'asset', id: 'asset-123' },
        { kind: 'candidate', id: 'candidate-123' },
      ],
    });

    const updated = await graph.updateOntologyEntity(UID, {
      entityId: entity.id,
      name: '认知图谱正式上线',
      description: entity.description,
      properties: entity.properties,
      sourceRefs: entity.sourceRefs,
    });
    const snapshot = await graph.readOntologyGraph(UID);

    expect(updated.id).toBe(entity.id);
    expect(snapshot.entities).toHaveLength(1);
    expect(snapshot.entities[0]).toMatchObject({
      id: entity.id,
      name: '认知图谱正式上线',
      categoryId: category.id,
      properties: { [category.fields[0].id]: '子安' },
      sourceRefs: [{ kind: 'asset', id: 'asset-123' }, { kind: 'candidate', id: 'candidate-123' }],
    });
    expect(snapshot.entities[0]).not.toHaveProperty('judgment');
    expect(snapshot.entities[0]).not.toHaveProperty('evidence');
  });

  it('supports self-to-entity and cross-domain relationships and protects linked entities', async () => {
    const graph = await loadGraph();
    const project = await graph.createOntologyEntity(UID, {
      categoryId: 'builtin_affairs_project',
      name: '本体上线',
    });
    const tool = await graph.createOntologyEntity(UID, {
      categoryId: 'builtin_resource_tool',
      name: 'CogSeed',
    });
    const responsibility = await graph.createOntologyRelation(UID, {
      subject: { kind: 'self' },
      predicate: '负责',
      object: { kind: 'entity', id: project.id },
      note: '个人正在负责的项目',
      sourceRefs: [{ kind: 'asset', id: 'asset-source' }],
    });
    const uses = await graph.createOntologyRelation(UID, {
      subject: { kind: 'entity', id: project.id },
      predicate: '使用',
      object: { kind: 'entity', id: tool.id },
    });

    await expect(graph.deleteOntologyEntity(UID, project.id)).rejects.toThrow('ontology entity has relationships');
    const changed = await graph.updateOntologyRelation(UID, {
      relationId: uses.id,
      predicate: '依赖',
      note: '运行依赖',
    });
    expect(changed.id).toBe(uses.id);
    expect(changed.predicate).toBe('依赖');

    await graph.deleteOntologyRelation(UID, responsibility.id);
    await graph.deleteOntologyRelation(UID, uses.id);
    await graph.deleteOntologyEntity(UID, project.id);
    const snapshot = await graph.readOntologyGraph(UID);
    expect(snapshot.relations).toHaveLength(0);
    expect(snapshot.entities.map((entity) => entity.id)).toEqual([tool.id]);
  });

  it('prevents deleting categories or fields that are still in use', async () => {
    const graph = await loadGraph();
    const category = await graph.createOntologyCategory(UID, {
      domain: 'concepts',
      name: '运行手册',
      fields: ['适用场景'],
    });
    const entity = await graph.createOntologyEntity(UID, {
      categoryId: category.id,
      name: '上线检查',
      properties: { [category.fields[0].id]: '版本发布' },
    });

    await expect(graph.deleteOntologyCategory(UID, category.id)).rejects.toThrow('ontology category contains entities');
    await expect(graph.updateOntologyCategory(UID, {
      categoryId: category.id,
      fields: [],
    })).rejects.toThrow('ontology category field is used by entities');

    await graph.updateOntologyEntity(UID, { entityId: entity.id, properties: {} });
    await graph.deleteOntologyEntity(UID, entity.id);
    await graph.deleteOntologyCategory(UID, category.id);
    expect((await graph.readOntologyGraph(UID)).categories.some((item) => item.id === category.id)).toBe(false);
  });

  it('rejects invalid endpoints, duplicate relations, and category cycles', async () => {
    const graph = await loadGraph();
    const parent = await graph.createOntologyCategory(UID, { domain: 'affairs', name: '工作事项' });
    const child = await graph.createOntologyCategory(UID, { domain: 'affairs', name: '子事项', parentId: parent.id });
    await expect(graph.updateOntologyCategory(UID, { categoryId: parent.id, parentId: child.id }))
      .rejects.toThrow('ontology category cycle');

    const project = await graph.createOntologyEntity(UID, { categoryId: 'builtin_affairs_project', name: '项目' });
    const first = await graph.createOntologyRelation(UID, {
      subject: { kind: 'self' }, predicate: '负责', object: { kind: 'entity', id: project.id },
    });
    await expect(graph.createOntologyRelation(UID, {
      subject: { kind: 'self' }, predicate: '负责', object: { kind: 'entity', id: project.id },
    })).rejects.toThrow('ontology relation already exists');
    await expect(graph.createOntologyRelation(UID, {
      subject: { kind: 'entity', id: 'missing-entity' }, predicate: '依赖', object: { kind: 'self' },
    })).rejects.toThrow('ontology relation endpoint not found');
    expect((await graph.readOntologyGraph(UID)).relations.map((relation) => relation.id)).toEqual([first.id]);
  });

  it('rejects corrupted or foreign graph files without overwriting them', async () => {
    const graph = await loadGraph();
    fs.mkdirSync(path.dirname(graphFile()), { recursive: true });
    const foreign = JSON.stringify({ schemaVersion: 1, ownerId: 'other-user', categories: [], entities: [], relations: [] });
    fs.writeFileSync(graphFile(), foreign, 'utf8');
    await expect(graph.readOntologyGraph(UID)).rejects.toThrow('ontology graph owner mismatch');
    await expect(graph.createOntologyCategory(UID, { domain: 'affairs', name: '不会写入' }))
      .rejects.toThrow('ontology graph owner mismatch');
    expect(fs.readFileSync(graphFile(), 'utf8')).toBe(foreign);
  });

  it('serializes concurrent category writes without losing updates', async () => {
    const graph = await loadGraph();
    await Promise.all(Array.from({ length: 12 }, (_, index) => graph.createOntologyCategory(UID, {
      domain: 'concepts',
      name: `自定义概念 ${index}`,
    })));
    const snapshot = await graph.readOntologyGraph(UID);
    expect(snapshot.categories.filter((category) => !category.builtIn)).toHaveLength(12);
  });
});
