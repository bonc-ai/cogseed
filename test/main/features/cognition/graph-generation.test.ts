import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previous: string | undefined;
const userId = 'graph-generation-user';
const moduleId = 'graph-module';

vi.mock('../../../../src/main/util/boot_init', () => ({
  registerDeferred: () => {},
  scheduleBootBackground: () => ({ cancel: vi.fn(), promise: Promise.resolve() }),
}));

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-graph-generation-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser(userId);
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function seed() {
  const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
  const create = (recordId: string, record: Record<string, unknown>) => ({
    intent: 'create', recordId, record, sourceLabel: '图谱测试',
  });
  await commitOntologyCommand(userId, {
    commandId: 'graph-seed',
    expectedRevision: 0,
    actions: [
      create(moduleId, { kind: 'module', name: '图谱项目', description: '初始说明', scope: { kind: 'personal' } }),
      create('person-type', { kind: 'definition', moduleId, name: '人员', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('collaborates', { kind: 'definition', moduleId, name: '协作', description: '', definitionKind: 'relation', subjectTypes: ['person-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('person-a', { kind: 'entity', moduleId, typeId: 'person-type', name: '王工', description: '', aliases: [], identityStatus: 'confirmed' }),
      create('person-b', { kind: 'entity', moduleId, typeId: 'person-type', name: '李工', description: '', aliases: [], identityStatus: 'confirmed' }),
      create('collab-fact', { kind: 'assertion', moduleId, subjectId: 'person-a', definitionId: 'collaborates', object: { kind: 'entity', id: 'person-b' }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
    ],
  });
}

function layoutFor(projection: { nodes: Array<{ id: string; kind: string }>; edges: Array<{ id: string; label: string }> }) {
  return {
    nodes: projection.nodes.map((node, index) => ({
      id: node.id, x: index * 10, y: index * 20, group: node.kind === 'entity' ? '人员' : '结构',
    })),
    edges: projection.edges.map(edge => ({ id: edge.id, group: '关系', label: `模型:${edge.label}` })),
    suggestedEdges: [{ from: 'person-a', to: 'person-b', label: '共同评审', reason: '两人都参与同一项目' }],
  };
}

function fakeGenerator(overrides: { fail?: boolean; mutate?: () => Promise<void>; calls?: { count: number } } = {}) {
  return {
    async generate(input: { projection: any }) {
      if (overrides.calls) overrides.calls.count += 1;
      if (overrides.mutate) await overrides.mutate();
      if (overrides.fail) throw new Error('synthetic model failure');
      return { layout: layoutFor(input.projection), provider: 'test-provider', model: 'test-model' };
    },
  };
}

describe('ontology graph generation', () => {
  it('stores model layout and formal edges for a module snapshot', async () => {
    await seed();
    const { requestGraphGeneration } = await import('../../../../src/main/features/cognition/ontology/graph-generation');
    const entry = await requestGraphGeneration({
      userId, scope: { kind: 'module', moduleId }, at: '2026-10-05', contentScale: 'instances',
      generator: fakeGenerator() as any,
    });
    expect(entry).toMatchObject({
      status: 'ready', ontologyRevision: 1,
      snapshot: {
        scope: 'module', moduleId, contentScale: 'instances',
        generator: { kind: 'model', provider: 'test-provider', model: 'test-model', promptVersion: 'v1' },
        validation: { valid: true },
      },
    });
    const snapshot = entry.snapshot!;
    expect(snapshot.nodes.find(node => node.id === 'person-a')).toMatchObject({ x: expect.any(Number), y: expect.any(Number), group: '人员' });
    const edge = snapshot.edges.find(row => row.recordId === 'collab-fact');
    expect(edge).toMatchObject({ from: 'person-a', to: 'person-b', formal: true, label: '模型:协作', group: '关系' });
    expect(snapshot.suggestions).toEqual([
      expect.objectContaining({ from: 'person-a', to: 'person-b', label: '共同评审', status: 'pending_review' }),
    ]);
    expect(snapshot.validation.checkedRecordVersions['collab-fact']).toBe(1);
  });

  it('preserves the previous snapshot when generation fails and can retry', async () => {
    await seed();
    const { requestGraphGeneration } = await import('../../../../src/main/features/cognition/ontology/graph-generation');
    const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
    const first = await requestGraphGeneration({
      userId, scope: { kind: 'global' }, at: '2026-10-05', generator: fakeGenerator() as any,
    });
    expect(first.status).toBe('ready');
    await commitOntologyCommand(userId, {
      commandId: 'graph-retry-bump', expectedRevision: 1,
      actions: [{ intent: 'update', recordId: moduleId, expectedVersion: 1, patch: { description: '第二版' }, sourceLabel: '图谱测试' }],
    });
    const failed = await requestGraphGeneration({
      userId, scope: { kind: 'global' }, at: '2026-10-05', generator: fakeGenerator({ fail: true }) as any,
    });
    expect(failed).toMatchObject({ status: 'failed', ontologyRevision: 2, snapshot: { ontologyRevision: 1 } });
    const retried = await requestGraphGeneration({
      userId, scope: { kind: 'global' }, at: '2026-10-05', generator: fakeGenerator() as any,
    });
    expect(retried).toMatchObject({ status: 'ready', ontologyRevision: 2, snapshot: { ontologyRevision: 2 } });
  });

  it('regenerates when the ontology changes while the model is working', async () => {
    await seed();
    const { requestGraphGeneration } = await import('../../../../src/main/features/cognition/ontology/graph-generation');
    const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
    const calls = { count: 0 };
    const entry = await requestGraphGeneration({
      userId, scope: { kind: 'module', moduleId }, at: '2026-10-05',
      generator: fakeGenerator({
        calls,
        mutate: async () => {
          if (calls.count !== 1) return;
          await commitOntologyCommand(userId, {
            commandId: 'graph-during-model', expectedRevision: 1,
            actions: [{ intent: 'update', recordId: moduleId, expectedVersion: 1, patch: { description: '模型期间更新' }, sourceLabel: '图谱测试' }],
          });
        },
      }) as any,
    });
    expect(calls.count).toBe(2);
    expect(entry).toMatchObject({ status: 'ready', ontologyRevision: 2 });
  });

  it('does not share one in-flight run across different content scales', async () => {
    await seed();
    const { requestGraphGeneration } = await import('../../../../src/main/features/cognition/ontology/graph-generation');
    const calls = { count: 0 };
    const generator = fakeGenerator({ calls });
    const instances = requestGraphGeneration({
      userId, scope: { kind: 'global' }, at: '2026-10-05', contentScale: 'instances', generator: generator as any,
    });
    const schema = requestGraphGeneration({
      userId, scope: { kind: 'global' }, at: '2026-10-05', contentScale: 'schema', generator: generator as any,
    });
    const [instancesEntry, schemaEntry] = await Promise.all([instances, schema]);
    expect(calls.count).toBe(2);
    expect(instancesEntry.snapshot!.contentScale).toBe('instances');
    expect(schemaEntry.snapshot!.contentScale).toBe('schema');
  });

  it('resolves to a failed entry instead of rejecting when the snapshot store is corrupt', async () => {
    await seed();
    const { requestGraphGeneration } = await import('../../../../src/main/features/cognition/ontology/graph-generation');
    const { graphSnapshotStorePath } = await import('../../../../src/main/features/cognition/ontology/graph-snapshot');
    fs.mkdirSync(path.dirname(graphSnapshotStorePath(userId)), { recursive: true });
    fs.writeFileSync(graphSnapshotStorePath(userId), 'not a json store');
    const entry = await requestGraphGeneration({
      userId, scope: { kind: 'global' }, at: '2026-10-05', generator: fakeGenerator({ fail: true }) as any,
    });
    expect(entry).toMatchObject({ status: 'failed', ontologyRevision: 0 });
  });
});
