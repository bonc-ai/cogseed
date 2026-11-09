import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
let previousRoot: string | undefined;
const userId = 'ontology-access-promotion-user';

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-access-promotion-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser(userId);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

type Action = Record<string, unknown>;

async function commitChunks(actions: Action[], prefix: string): Promise<void> {
  const { commitOntologyCommand, readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');
  let index = 0;
  while (actions.length) {
    await commitOntologyCommand(userId, {
      commandId: `${prefix}-${index++}`,
      expectedRevision: readOntologyDocument(userId).revision,
      actions: actions.splice(0, 50),
    });
  }
}

function createAction(recordId: string, record: Record<string, unknown>): Action {
  return { intent: 'create', recordId, record: { access: 'owner_only', ...record }, sourceLabel: '批量放开测试' };
}

/** 3 modules / 3 mutual references / 30 definitions / 45 entities / 55 facts / 12 rules = 148. */
async function seedLargeOntology(): Promise<void> {
  const actions: Action[] = [];
  const modules = ['mod-a', 'mod-b', 'mod-c'];
  for (const moduleId of modules) {
    actions.push(createAction(moduleId, { kind: 'module', name: `模块 ${moduleId}`, description: '', scope: { kind: 'personal' } }));
  }
  for (const [from, to] of [['mod-a', 'mod-b'], ['mod-b', 'mod-c'], ['mod-c', 'mod-a']]) {
    actions.push(createAction(`ref-${from}-${to}`, { kind: 'reference', moduleId: from, targetModuleId: to, versionPolicy: 'current' }));
  }
  for (const moduleId of modules) {
    for (let index = 0; index < 9; index += 1) {
      actions.push(createAction(`type-${moduleId}-${index}`, {
        kind: 'definition', moduleId, name: `类型${index}`, description: '',
        definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject',
      }));
    }
  }
  for (const moduleId of modules) {
    actions.push(createAction(`attr-${moduleId}`, {
      kind: 'definition', moduleId, name: '属性', description: '',
      definitionKind: 'attribute', subjectTypes: [], objectTypes: [],
      valueType: 'text', cardinality: 'many', cardinalityAnchor: 'subject',
    }));
  }
  for (const moduleId of modules) {
    for (let index = 0; index < 15; index += 1) {
      actions.push(createAction(`ent-${moduleId}-${index}`, {
        kind: 'entity', moduleId, typeId: `type-${moduleId}-${index % 9}`, name: `对象${index}`,
        description: '', aliases: [], identityStatus: 'confirmed',
      }));
    }
  }
  const assertions: Record<string, number> = { 'mod-a': 19, 'mod-b': 18, 'mod-c': 18 };
  for (const moduleId of modules) {
    for (let index = 0; index < assertions[moduleId]; index += 1) {
      actions.push(createAction(`fact-${moduleId}-${index}`, {
        kind: 'assertion', moduleId, subjectId: `ent-${moduleId}-${index % 15}`, definitionId: `attr-${moduleId}`,
        object: { kind: 'literal', valueType: 'text', value: `事实-${moduleId}-${index}` },
        validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' },
      }));
    }
  }
  for (const moduleId of modules) {
    for (let index = 0; index < 4; index += 1) {
      actions.push(createAction(`rule-${moduleId}-${index}`, {
        kind: 'rule', moduleId, name: `规则${index}`, requirement: `要求${index}`,
        strength: 'suggestion', condition: null, effect: { kind: 'note' }, exception: '',
      }));
    }
  }
  await commitChunks(actions, 'seed-large');
}

/** Two independent private modules with one fact each. */
async function seedTwoModules(): Promise<void> {
  const actions: Action[] = [];
  for (const moduleId of ['mod-x', 'mod-y']) {
    actions.push(createAction(moduleId, { kind: 'module', name: `模块 ${moduleId}`, description: '', scope: { kind: 'personal' } }));
    actions.push(createAction(`type-${moduleId}`, {
      kind: 'definition', moduleId, name: '类型', description: '',
      definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject',
    }));
    actions.push(createAction(`attr-${moduleId}`, {
      kind: 'definition', moduleId, name: '属性', description: '',
      definitionKind: 'attribute', subjectTypes: [`type-${moduleId}`], objectTypes: [],
      valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject',
    }));
    actions.push(createAction(`ent-${moduleId}`, {
      kind: 'entity', moduleId, typeId: `type-${moduleId}`, name: `对象-${moduleId}`,
      description: '', aliases: [], identityStatus: 'confirmed',
    }));
    actions.push(createAction(`fact-${moduleId}`, {
      kind: 'assertion', moduleId, subjectId: `ent-${moduleId}`, definitionId: `attr-${moduleId}`,
      object: { kind: 'literal', valueType: 'text', value: `事实-${moduleId}` },
      validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' },
    }));
  }
  await commitChunks(actions, 'seed-two');
}

describe('ontology access promotion', () => {
  it('reports the reference closure and every record to promote', async () => {
    await seedLargeOntology();
    const { previewOntologyAccessPromotion } = await import('../../../../src/main/features/cognition/ontology/access-promotion');
    const plan = previewOntologyAccessPromotion(userId, ['mod-a']);

    expect([...plan.closure].sort()).toEqual(['mod-a', 'mod-b', 'mod-c']);
    expect(plan.modules.map(module => module.id).sort()).toEqual(['mod-a', 'mod-b', 'mod-c']);
    expect(plan.counts.modules).toBe(3);
    expect(plan.counts.records).toBe(145);
    expect(plan.counts.byKind).toMatchObject({ module: 3, reference: 3, definition: 30, entity: 45, assertion: 55, rule: 12 });
    expect(plan.blocked).toEqual([]);
  });

  it('promotes modules before dependents across three batches of at most fifty actions', async () => {
    await seedLargeOntology();
    const { promoteOntologyAccess } = await import('../../../../src/main/features/cognition/ontology/access-promotion');
    const { readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');

    const result = await promoteOntologyAccess(userId, ['mod-a']);
    expect(result.partial).toBe(false);
    expect(result.promoted).toEqual({ modules: 3, records: 145 });
    expect(result.batches.map(batch => batch.changedIds.length)).toEqual([50, 50, 48]);

    const doc = readOntologyDocument(userId);
    const firstBatchKinds = result.batches[0].changedIds.slice(0, 6).map(id => doc.records[id].kind);
    expect(firstBatchKinds).toEqual(['module', 'module', 'module', 'reference', 'reference', 'reference']);
    expect(Object.values(doc.records).every(record => record.access === 'task')).toBe(true);
    expect(doc.history.filter(entry => entry.commandId.startsWith('ont-access-promo-'))).toHaveLength(148);
    expect(doc.revision).toBe(6);
  });

  it('is idempotent after a completed promotion', async () => {
    await seedLargeOntology();
    const { promoteOntologyAccess } = await import('../../../../src/main/features/cognition/ontology/access-promotion');
    const { readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');
    await promoteOntologyAccess(userId, ['mod-a']);
    const revision = readOntologyDocument(userId).revision;

    const again = await promoteOntologyAccess(userId, ['mod-a']);
    expect(again.batches).toEqual([]);
    expect(again.promoted).toEqual({ modules: 0, records: 0 });
    expect(readOntologyDocument(userId).revision).toBe(revision);
  });

  it('converges when a concurrent promotion lands between batches', async () => {
    await seedLargeOntology();
    const { promoteOntologyAccess } = await import('../../../../src/main/features/cognition/ontology/access-promotion');
    const { readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');

    const [first, second] = await Promise.all([
      promoteOntologyAccess(userId, ['mod-a']),
      promoteOntologyAccess(userId, ['mod-a']),
    ]);
    expect(first.partial).toBe(false);
    expect(second.partial).toBe(false);
    const doc = readOntologyDocument(userId);
    expect(Object.values(doc.records).every(record => record.access === 'task')).toBe(true);
    expect(doc.revision).toBe(6);
  });

  it('keeps references to unavailable modules private and reports them blocked', async () => {
    const actions: Action[] = [
      createAction('mod-a', { kind: 'module', name: '模块 A', description: '', scope: { kind: 'personal' } }),
      createAction('mod-dead', { kind: 'module', name: '已归档模块', description: '', scope: { kind: 'personal' } }),
      createAction('ref-dead', { kind: 'reference', moduleId: 'mod-a', targetModuleId: 'mod-dead', versionPolicy: 'current' }),
    ];
    await commitChunks(actions, 'seed-blocked');
    const { commitOntologyCommand, readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');
    await commitOntologyCommand(userId, {
      commandId: 'archive-dead',
      expectedRevision: readOntologyDocument(userId).revision,
      actions: [{ intent: 'archive', recordId: 'mod-dead', expectedVersion: 1, sourceLabel: '测试归档' }],
    });

    const { previewOntologyAccessPromotion, promoteOntologyAccess } =
      await import('../../../../src/main/features/cognition/ontology/access-promotion');
    const plan = previewOntologyAccessPromotion(userId, ['mod-a']);
    expect(plan.blocked).toContainEqual({ recordId: 'ref-dead', kind: 'reference', reason: 'target_module_unavailable' });

    const result = await promoteOntologyAccess(userId, ['mod-a']);
    expect(result.partial).toBe(false);
    expect(result.blocked).toContainEqual({ recordId: 'ref-dead', kind: 'reference', reason: 'target_module_unavailable' });
    const doc = readOntologyDocument(userId);
    expect(doc.records['mod-a'].access).toBe('task');
    expect(doc.records['ref-dead'].access).toBe('owner_only');
  });

  it('answers task queries for promoted modules while other private modules stay excluded', async () => {
    await seedTwoModules();
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const before = await runOntologyTaskQuery({ userId, query: '对象', at: '2026-10-05' });
    expect(before.modules).toEqual([]);
    expect(before.scopeExcluded.ownerOnly.modules).toBe(2);

    const { promoteOntologyAccess } = await import('../../../../src/main/features/cognition/ontology/access-promotion');
    await promoteOntologyAccess(userId, ['mod-x']);

    const after = await runOntologyTaskQuery({ userId, query: '对象', at: '2026-10-05' });
    expect(after.modules.map(module => module.id)).toContain('mod-x');
    expect(after.modules.map(module => module.id)).not.toContain('mod-y');
    expect(after.facts.length).toBeGreaterThan(0);
    expect(after.scopeExcluded.ownerOnly.modules).toBe(1);
    expect(JSON.stringify(after)).not.toContain('事实-mod-y');
  });

  it('rejects unknown module ids and empty selections', async () => {
    await seedTwoModules();
    const { previewOntologyAccessPromotion, promoteOntologyAccess } =
      await import('../../../../src/main/features/cognition/ontology/access-promotion');
    expect(() => previewOntologyAccessPromotion(userId, [])).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => previewOntologyAccessPromotion(userId, ['missing-module'])).toThrowError(expect.objectContaining({ code: 'not_found' }));
    await expect(promoteOntologyAccess(userId, ['missing-module'])).rejects.toMatchObject({ code: 'not_found' });
  });
});
