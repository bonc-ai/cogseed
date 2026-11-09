/** Opt-in real-model graph acceptance. Runs against a disposable root and the
 * explicit encrypted config source; no real user data is read. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/util/boot_init', () => ({
  registerDeferred: () => {},
  scheduleBootBackground: () => ({ cancel: vi.fn(), promise: Promise.resolve() }),
}));

const suite = process.env.COGSEED_LIVE_GRAPH_TEST === '1' ? describe : describe.skip;
let root = '';
let previousRoot: string | undefined;
let uid = '';
const moduleId = 'live-graph-module';

suite('真实模型图谱生成', () => {
  beforeAll(async () => {
    const source = process.env.COGSEED_LIVE_SOURCE_CONFIG_DIR;
    uid = process.env.COGSEED_LIVE_SOURCE_UID || '';
    if (!source || !uid) throw new Error('explicit encrypted config source and owner uid required');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-graph-live-'));
    previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
    process.env.COGSEED_WORKSPACE_ROOT = root;
    vi.resetModules();
    const target = path.join(root, uid, 'local/config');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of ['auth-profiles.json', 'account.json']) {
      const file = path.join(source, name);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, name));
    }
    const { activateUser } = await import('../../src/main/features/users');
    activateUser(uid);
    const { migrateLegacyCognition } = await import('../../src/main/features/cognition_migration');
    expect((await migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
    const { commitOntologyCommand } = await import('../../src/main/features/cognition/ontology/service');
    const create = (recordId: string, record: Record<string, unknown>) => ({
      intent: 'create', recordId, record, sourceLabel: '隔离图谱验收',
    });
    await commitOntologyCommand(uid, {
      commandId: 'live-graph-seed',
      expectedRevision: 0,
      actions: [
        create(moduleId, { kind: 'module', name: '甲项目', description: '隔离图谱验收项目', scope: { kind: 'personal' } }),
        create('person-type', { kind: 'definition', moduleId, name: '人员', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
        create('owner-relation', { kind: 'definition', moduleId, name: '负责人', description: '', definitionKind: 'relation', subjectTypes: ['person-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' }),
        create('wang', { kind: 'entity', moduleId, typeId: 'person-type', name: '王工', description: '', aliases: [], identityStatus: 'confirmed' }),
        create('li', { kind: 'entity', moduleId, typeId: 'person-type', name: '李工', description: '', aliases: [], identityStatus: 'confirmed' }),
        create('owner-fact', { kind: 'assertion', moduleId, subjectId: 'wang', definitionId: 'owner-relation', object: { kind: 'entity', id: 'li' }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
      ],
    });
  }, 120_000);

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores a model-generated layout for the current ontology revision', async () => {
    const { requestGraphGeneration } = await import('../../src/main/features/cognition/ontology/graph-generation');
    const entry = await requestGraphGeneration({
      userId: uid,
      scope: { kind: 'module', moduleId },
      at: '2026-11-03',
      contentScale: 'instances',
    });
    expect(entry.status, entry.error || 'graph generation did not finish').toBe('ready');
    const snapshot = entry.snapshot!;
    expect(snapshot.generator.kind).toBe('model');
    expect(snapshot.generator.provider).toBe('zai');
    expect(snapshot.ontologyRevision).toBe(1);
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(snapshot.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(snapshot.edges.every(edge => edge.formal && edge.recordId && edge.version >= 1)).toBe(true);
    expect(snapshot.validation.valid).toBe(true);
  }, 180_000);
});
