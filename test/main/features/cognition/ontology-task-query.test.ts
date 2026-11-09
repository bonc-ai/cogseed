import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
let previousRoot: string | undefined;
const userId = 'ontology-task-query-user';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-task-query-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/cognition/ontology/source-admission');
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedOntology(extraActions: Array<Record<string, unknown>> = []): Promise<void> {
  const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
  const action = (recordId: string, record: Record<string, unknown>) => ({
    intent: 'create', recordId, record, sourceLabel: '用户确认',
  });
  await commitOntologyCommand(userId, {
    commandId: 'ontology-task-query-seed',
    expectedRevision: 0,
    actions: [
      action('project-module', { kind: 'module', name: '研发项目', description: '', scope: { kind: 'project', id: 'project-a' } }),
      action('other-module', { kind: 'module', name: '另一个项目', description: '', scope: { kind: 'project', id: 'project-b' } }),
      action('project-type', { kind: 'definition', moduleId: 'project-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('person-type', { kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('owner-def', { kind: 'definition', moduleId: 'project-module', name: '负责人', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('salary-def', { kind: 'definition', moduleId: 'project-module', name: '内部薪酬', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('other-project-type', { kind: 'definition', moduleId: 'other-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('project-a', { kind: 'entity', moduleId: 'project-module', typeId: 'project-type', name: 'CogSeed', description: '', aliases: [], identityStatus: 'confirmed' }),
      action('person-a', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '王工', description: '', aliases: [], identityStatus: 'confirmed' }),
      action('other-project', { kind: 'entity', moduleId: 'other-module', typeId: 'other-project-type', name: 'CogSeed', description: '不得跨项目回传', aliases: [], identityStatus: 'confirmed' }),
      action('owner-fact', { kind: 'assertion', moduleId: 'project-module', subjectId: 'project-a', definitionId: 'owner-def', object: { kind: 'entity', id: 'person-a' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
      action('private-fact', { kind: 'assertion', moduleId: 'project-module', subjectId: 'person-a', definitionId: 'salary-def', object: { kind: 'literal', valueType: 'text', value: 'private-salary-marker' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' }, access: 'owner_only' }),
      action('weekly-rule', { kind: 'rule', moduleId: 'project-module', name: '周报规则', requirement: '周报发给负责人', strength: 'required', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'include_recipient', entityId: 'person-a' }, exception: '' }),
      ...Array.from({ length: 5 }, (_, index) => action(`chooser-${index}-a`, {
        kind: 'rule', moduleId: 'project-module', name: `周报选项${index}甲`, requirement: `周报选项${index}`,
        strength: 'suggestion', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' },
        effect: { kind: 'choice', key: `choice_${index}`, value: 'a' }, exception: '',
      })),
      ...Array.from({ length: 5 }, (_, index) => action(`chooser-${index}-b`, {
        kind: 'rule', moduleId: 'project-module', name: `周报选项${index}乙`, requirement: `周报选项${index}`,
        strength: 'suggestion', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' },
        effect: { kind: 'choice', key: `choice_${index}`, value: 'b' }, exception: '',
      })),
      ...Array.from({ length: 3 }, (_, index) => action(`weekly-extra-${index}`, {
        kind: 'rule', moduleId: 'project-module', name: `周报附加${index}`, requirement: `周报附加检查${index}`,
        strength: 'suggestion', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'note' }, exception: '',
      })),
      ...extraActions,
    ],
  });
}

describe('runOntologyTaskQuery', () => {
  it('returns admitted task facts and rules for multiple mentions with deterministic limits', async () => {
    await seedOntology();
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a', taskText: '准备 CogSeed 周报' },
      query: 'CogSeed',
      queries: ['周报'],
      at: '2026-10-05',
      purpose: 'weekly_report',
      limits: { maxRules: 2 },
    });

    expect(result.modules.map(module => module.id)).toEqual(['project-module']);
    expect(result.facts).toContainEqual(expect.objectContaining({
      statement: 'CogSeed · 负责人 · 王工',
      citation: '[[ontology:project-module/owner-fact@1]]',
      source: expect.objectContaining({ recordId: 'owner-fact', version: 1 }),
    }));
    expect(result.facts.some(fact => fact.source.recordId === 'private-fact')).toBe(false);
    expect(result.rules).toContainEqual(expect.objectContaining({
      name: '周报规则',
      match: 'matched',
      citation: '[[ontology:project-module/weekly-rule@1]]',
    }));
    expect(result.rules).toHaveLength(2);
    expect(result.truncated.rules).toBe(12);
    expect(result.sourceCoverage.complete).toBe(true);
    const full = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a', taskText: '准备 CogSeed 周报' },
      query: 'CogSeed',
      queries: ['周报'],
      at: '2026-10-05',
      purpose: 'weekly_report',
    });
    // 工具零漂移：调用方没有给 maxConflicts 时不得截断冲突组。
    expect(full.conflicts).toHaveLength(5);
    expect(full.truncated.rules).toBe(0);
    expect(result.readRefs).toContainEqual(expect.objectContaining({
      moduleId: 'project-module', recordId: 'owner-fact', recordVersion: 1, kind: 'assertion',
    }));
    expect(result.readRefs).toContainEqual(expect.objectContaining({
      moduleId: 'project-module', recordId: 'weekly-rule', recordVersion: 1, kind: 'rule',
    }));
    expect(JSON.stringify(result)).not.toContain('private-salary-marker');
    expect(JSON.stringify(result)).not.toContain('other-module');
  });

  it('rejects an explicit module outside the current task scope', async () => {
    await seedOntology();
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    await expect(runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      moduleId: 'other-module',
      at: '2026-10-05',
    })).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('reports scope-excluded counts without leaking private or cross-project content', async () => {
    await seedOntology([
      {
        intent: 'create', recordId: 'private-module', sourceLabel: '用户确认',
        record: { kind: 'module', name: '私密本体', description: '', scope: { kind: 'personal' }, access: 'owner_only' },
      },
    ]);
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: '不存在的主题',
      at: '2026-10-05',
    });
    expect(result.modules).toEqual([]);
    expect(result.revision).toBeGreaterThan(0);
    expect(result.scopeExcluded).toEqual({
      ownerOnly: { modules: 1, records: 1 },
      otherScope: { modules: 1, records: 2 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-salary-marker');
    expect(serialized).not.toContain('私密本体');
    expect(serialized).not.toContain('other-module');
  });

  it('reports incomplete source coverage without converting unavailable sources into absent facts', async () => {
    await seedOntology();
    vi.doMock('../../../../src/main/features/cognition/ontology/source-admission', () => ({
      assessOntologySources: async () => new Map([['project-module', 'allowed'], ['owner-fact', 'unavailable']]),
      ontologyWithAdmittedSources: <T>(doc: T) => doc,
    }));
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      at: '2026-10-05',
    });
    expect(result.sourceCoverage.complete).toBe(false);
  });

  it('orders modules, facts and rules deterministically', async () => {
    await seedOntology();
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      queries: ['周报'],
      at: '2026-10-05',
      purpose: 'weekly_report',
    });
    const moduleIds = result.modules.map(module => module.id);
    const factCitations = result.facts.map(fact => fact.citation);
    const ruleRanks = result.rules.map(rule => rule.strength === 'required' ? 0 : 1);
    const ruleMatches = result.rules.map(rule => rule.match === 'matched' ? 0 : rule.match === 'unknown' ? 1 : 2);
    expect(moduleIds).toEqual([...moduleIds].sort());
    expect(factCitations).toEqual([...factCitations].sort());
    expect(ruleRanks).toEqual([...ruleRanks].sort((left, right) => left - right));
    expect(ruleMatches).toEqual([...ruleMatches].sort((left, right) => left - right));
    const again = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      queries: ['周报'],
      at: '2026-10-05',
      purpose: 'weekly_report',
    });
    expect(again).toEqual(result);
  });

  it('keeps conflict groups derived from rules dropped by maxRules', async () => {
    await seedOntology();
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      queries: ['周报'],
      at: '2026-10-05',
      purpose: 'weekly_report',
      limits: { maxRules: 2, maxConflicts: 10 },
    });
    expect(result.rules).toHaveLength(2);
    expect(result.conflicts).toHaveLength(5);
    expect(result.conflictsComplete).toBe(false);
  });

  it('reports incomplete coverage when an in-scope source is disabled', async () => {
    await seedOntology();
    vi.doMock('../../../../src/main/features/cognition/ontology/source-admission', () => ({
      assessOntologySources: async (_userId: string, doc: { records: Record<string, unknown> }) => new Map(
        Object.keys(doc.records).map(id => [id, id === 'owner-fact' ? 'disabled' : 'allowed']),
      ),
      ontologyWithAdmittedSources: <T>(doc: T) => doc,
    }));
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      at: '2026-10-05',
    });
    expect(result.sourceCoverage.complete).toBe(false);
  });

  it('does not count out-of-scope owner_only records as source gaps', async () => {
    await seedOntology();
    vi.doMock('../../../../src/main/features/cognition/ontology/source-admission', () => ({
      assessOntologySources: async (_userId: string, doc: { records: Record<string, unknown> }) => new Map(
        Object.keys(doc.records).map(id => [id, id === 'private-fact' ? 'disabled' : 'allowed']),
      ),
      ontologyWithAdmittedSources: <T>(doc: T) => doc,
    }));
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      at: '2026-10-05',
    });
    expect(result.sourceCoverage.complete).toBe(true);
  });

  it('does not use owner_only records as task search seeds', async () => {
    await seedOntology();
    const { readOntologyView } = await import('../../../../src/main/features/cognition/ontology/service');
    const { searchOntologyRecordsWithMeta } = await import('../../../../src/main/features/cognition/ontology/query');
    const doc = await readOntologyView(userId);
    const all = searchOntologyRecordsWithMeta(doc, 'private-salary-marker');
    const task = searchOntologyRecordsWithMeta(doc, 'private-salary-marker', undefined, { taskOnly: true });
    expect(all.rows.length).toBe(1);
    expect(task.rows).toEqual([]);
  });

  it('reports the internal search cap instead of silently dropping matches', async () => {
    await seedOntology();
    const { readOntologyView } = await import('../../../../src/main/features/cognition/ontology/service');
    const { searchOntologyRecordsWithMeta } = await import('../../../../src/main/features/cognition/ontology/query');
    const doc = await readOntologyView(userId);
    const capped = searchOntologyRecordsWithMeta(doc, 'CogSeed', undefined, { limit: 1 });
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it('rejects an invalid at before reading records', async () => {
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    await expect(runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      at: 'not-a-date',
    })).rejects.toMatchObject({ code: 'invalid_time' });
  });

  it('does not mark coverage incomplete for an unrelated disabled module', async () => {
    await seedOntology([
      { intent: 'create', recordId: 'unrelated-module', record: {
        kind: 'module', name: '无关模块', description: '', scope: { kind: 'project', id: 'project-a' },
      }, sourceLabel: '用户确认' },
      { intent: 'create', recordId: 'unrelated-def', record: {
        kind: 'definition', moduleId: 'unrelated-module', name: '无关定义', description: '',
        definitionKind: 'attribute', subjectTypes: [], objectTypes: [], valueType: 'text',
        cardinality: 'one', cardinalityAnchor: 'subject',
      }, sourceLabel: '用户确认' },
    ]);
    vi.doMock('../../../../src/main/features/cognition/ontology/source-admission', () => ({
      assessOntologySources: async (_userId: string, doc: { records: Record<string, unknown> }) => new Map(
        Object.keys(doc.records).map(id => [id, id === 'unrelated-def' ? 'disabled' : 'allowed']),
      ),
      ontologyWithAdmittedSources: <T>(doc: T) => doc,
    }));
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      at: '2026-10-05',
    });
    expect(result.sourceCoverage.complete).toBe(true);
  });

  it('keeps related records inside the modules actually queried after maxModules truncation', async () => {
    await seedOntology([
      { intent: 'create', recordId: 'a-extra', record: {
        kind: 'module', name: 'A Extra Module', description: '', scope: { kind: 'project', id: 'project-a' },
      }, sourceLabel: '用户确认' },
      { intent: 'create', recordId: 'extra-type', record: {
        kind: 'definition', moduleId: 'a-extra', name: 'Extra Type', description: '',
        definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity',
        cardinality: 'many', cardinalityAnchor: 'subject',
      }, sourceLabel: '用户确认' },
      { intent: 'create', recordId: 'extra-entity', record: {
        kind: 'entity', moduleId: 'a-extra', typeId: 'extra-type', name: 'CogSeedExtra',
        description: '', aliases: [], identityStatus: 'confirmed',
      }, sourceLabel: '用户确认' },
    ]);
    const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
    const result = await runOntologyTaskQuery({
      userId,
      context: { projectId: 'project-a' },
      query: 'CogSeed',
      at: '2026-10-05',
      limits: { maxModules: 1 },
    });
    expect(result.modules.map(module => module.id)).toEqual(['a-extra']);
    expect(result.truncated.modules).toBe(1);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.every(record => (
      record.kind === 'module' ? record.id === 'a-extra' : record.moduleId === 'a-extra'
    ))).toBe(true);
  });
});
