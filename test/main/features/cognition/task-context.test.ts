import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cold dynamic-import chains for cognition storage and legacy projections exceed
// Vitest's default timeout on first use in this file.
vi.setConfig({ testTimeout: 120_000 });

let root: string;
let previousRoot: string | undefined;
const userId = 'task-context-user';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-task-context-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser(userId);
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/cognition/ontology/calendar-day');
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedOntology(extraActions: Array<Record<string, unknown>> = []): Promise<void> {
  const { commitOntologyCommand, readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');
  const action = (recordId: string, record: Record<string, unknown>) => ({
    intent: 'create', recordId, record, sourceLabel: '用户确认',
  });
  await commitOntologyCommand(userId, {
    commandId: 'task-context-seed',
    expectedRevision: 0,
    actions: [
      action('project-module', { kind: 'module', name: '研发项目', description: '', scope: { kind: 'project', id: 'project-a' } }),
      action('other-module', { kind: 'module', name: '另一个项目', description: '', scope: { kind: 'project', id: 'project-b' } }),
      action('project-type', { kind: 'definition', moduleId: 'project-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('person-type', { kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('owner-def', { kind: 'definition', moduleId: 'project-module', name: '负责人', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('salary-def', { kind: 'definition', moduleId: 'project-module', name: '内部薪酬', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('sponsor-def', { kind: 'definition', moduleId: 'project-module', name: '赞助人', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('other-project-type', { kind: 'definition', moduleId: 'other-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('project-a', { kind: 'entity', moduleId: 'project-module', typeId: 'project-type', name: 'CogSeed', description: '', aliases: [], identityStatus: 'confirmed' }),
      action('person-a', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '王工', description: '', aliases: ['老王'], identityStatus: 'confirmed' }),
      action('other-project', { kind: 'entity', moduleId: 'other-module', typeId: 'other-project-type', name: 'CogSeed', description: '不得跨项目回传', aliases: [], identityStatus: 'confirmed' }),
      action('owner-fact', { kind: 'assertion', moduleId: 'project-module', subjectId: 'project-a', definitionId: 'owner-def', object: { kind: 'entity', id: 'person-a' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
      action('sponsor-fact', { kind: 'assertion', moduleId: 'project-module', subjectId: 'project-a', definitionId: 'sponsor-def', object: { kind: 'entity', id: 'person-a' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
      action('private-fact', { kind: 'assertion', moduleId: 'project-module', subjectId: 'person-a', definitionId: 'salary-def', object: { kind: 'literal', valueType: 'text', value: 'private-salary-marker' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' }, access: 'owner_only' }),
      action('weekly-rule', { kind: 'rule', moduleId: 'project-module', name: '周报规则', requirement: '周报发给负责人', strength: 'required', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'include_recipient', entityId: 'person-a' }, exception: '' }),
    ],
  });
  for (let offset = 0; offset < extraActions.length; offset += 50) {
    await commitOntologyCommand(userId, {
      commandId: `task-context-extra-${offset}`,
      expectedRevision: readOntologyDocument(userId).revision,
      actions: extraActions.slice(offset, offset + 50),
    });
  }
}

async function attachAssetRefs(recordId: string, assetIds: string[]): Promise<void> {
  const { cognitionStorePath } = await import('../../../../src/main/features/cognition_kernel/store');
  const storePath = cognitionStorePath(userId);
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
    ontology: { records: Record<string, { source: { refs?: Array<{ kind: string; id: string }> } }> };
  };
  const record = raw.ontology.records[recordId];
  if (!record) throw new Error(`record ${recordId} missing for ref attach`);
  record.source.refs = [...(record.source.refs || []), ...assetIds.map(id => ({ kind: 'asset', id }))];
  fs.writeFileSync(storePath, JSON.stringify(raw));
}

async function writeAbilityAsset(assetId: string): Promise<void> {
  const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
  await writeRecallJsonRecord(userId, 'ability-assets', assetId, {
    schemaVersion: 1, ownerId: userId,
    id: assetId, candidateId: `cand-${assetId}`, title: '测试资产', statement: '测试资产正文。',
    evidenceRefs: [], sourceCandidateIds: [], sourceSessionIds: [], origin: 'manual',
    scope: 'general', version: '1', activeVersion: '1', status: 'active',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

describe('buildTaskOntologyContext', () => {
  it('renders admitted facts and rules with matching read refs', async () => {
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '准备 CogSeed 周报',
      context: { projectId: 'project-a' },
      purpose: 'weekly_report',
    });

    expect(result.promptBlock).toContain('<task-ontology');
    expect(result.promptBlock).toContain('[[ontology:project-module/owner-fact@1]]');
    expect(result.promptBlock).toContain('[[ontology:project-module/weekly-rule@1]]');
    expect(result.promptBlock).not.toContain('private-salary-marker');
    expect(result.promptBlock).not.toContain('other-module');
    expect(result.mentions).toEqual(['CogSeed']);
    expect(result.complete).toBe(true);
    for (const ref of result.readRefs) {
      expect(result.promptBlock).toContain(`[[ontology:${ref.moduleId}/${ref.recordId}@${ref.recordVersion}]]`);
    }
  });

  it('returns no block when the task has no canonical mention and no topic query', async () => {
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '今天天气怎么样',
      context: { projectId: 'project-a' },
    });
    expect(result.promptBlock).toBe('');
    expect(result.readRefs).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('skips ambiguous mentions instead of guessing an identity', async () => {
    await seedOntology([
      { intent: 'create', recordId: 'dup-person-a', record: { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '重名同事', description: '', aliases: [], identityStatus: 'confirmed' }, sourceLabel: '用户确认' },
      { intent: 'create', recordId: 'dup-person-b', record: { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '重名同事', description: '', aliases: [], identityStatus: 'confirmed' }, sourceLabel: '用户确认' },
    ]);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '重名同事负责什么',
      context: { projectId: 'project-a' },
    });
    expect(result.mentions).not.toContain('重名同事');
    expect(result.ambiguousMentions).toContain('重名同事');
    expect(result.promptBlock).toBe('');
    expect(result.omitted).toContainEqual({ reason: 'ambiguous_mention', count: 1 });
    expect(result.complete).toBe(false);
  });

  it('signals scope-excluded content when nothing is task-visible', async () => {
    await seedOntology([
      { intent: 'create', recordId: 'private-module', record: { kind: 'module', name: '私密本体', description: '', scope: { kind: 'personal' }, access: 'owner_only' }, sourceLabel: '用户确认' },
    ]);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '查看 私密本体 里的内容',
      context: { projectId: 'project-a' },
    });
    expect(result.promptBlock).toBe('');
    expect(result.scopeExcluded).toEqual({
      ownerOnly: { modules: 1, records: 1 },
      otherScope: { modules: 1, records: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('private-salary-marker');
  });

  it('keeps project modules isolated while allowing an explicit topic query', async () => {
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const projectA = await buildTaskOntologyContext({
      userId,
      taskText: 'review status',
      context: { projectId: 'project-a' },
      topicQuery: 'CogSeed',
    });
    expect(projectA.promptBlock).toContain('[[ontology:project-module/owner-fact@1]]');
    expect(projectA.promptBlock).not.toContain('other-module');

    const projectB = await buildTaskOntologyContext({
      userId,
      taskText: 'review status',
      context: { projectId: 'project-b' },
      topicQuery: 'CogSeed',
    });
    expect(projectB.promptBlock).not.toContain('owner-fact');
  });

  it('drops a record already supplied through an injected asset source', async () => {
    await seedOntology();
    await writeAbilityAsset('asset-alpha');
    await attachAssetRefs('sponsor-fact', ['asset-alpha']);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const withoutAsset = await buildTaskOntologyContext({
      userId, taskText: 'CogSeed 王工', context: { projectId: 'project-a' },
    });
    expect(withoutAsset.promptBlock).toContain('sponsor-fact');

    const withAsset = await buildTaskOntologyContext({
      userId, taskText: 'CogSeed 王工', context: { projectId: 'project-a' }, injectedAssetIds: ['asset-alpha'],
    });
    expect(withAsset.promptBlock).not.toContain('sponsor-fact');
    expect(withAsset.promptBlock).toContain('owner-fact');
  });

  it('applies section and character budgets without cutting tags or citations', async () => {
    const manyRules = Array.from({ length: 20 }, (_, index) => ({
      intent: 'create' as const,
      recordId: `budget-rule-${index}`,
      record: {
        kind: 'rule' as const, moduleId: 'project-module', name: `周报规则${index}`,
        requirement: `周报要包含进展、风险与下周计划的第${index}条说明，并附确认记录和时间点`,
        strength: 'suggestion' as const,
        condition: { kind: 'task' as const, field: 'purpose' as const, equals: 'weekly_report' },
        effect: { kind: 'note' as const }, exception: '',
      },
      sourceLabel: '用户确认',
    }));
    await seedOntology(manyRules);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: 'CogSeed 周报',
      context: { projectId: 'project-a' },
      purpose: 'weekly_report',
      budget: { maxRules: 20, maxFacts: 12, maxChars: 1_200 },
    });
    expect(result.promptBlock.length).toBeLessThanOrEqual(1_200);
    expect(result.promptBlock.startsWith('<task-ontology')).toBe(true);
    expect(result.promptBlock.endsWith('</task-ontology>')).toBe(true);
    const opens = (result.promptBlock.match(/\[\[ontology:/g) || []).length;
    const closes = (result.promptBlock.match(/\]\]/g) || []).length;
    expect(opens).toBe(closes);
    expect(result.complete).toBe(false);
    expect(result.omitted.some(item => item.reason === 'budget_total_chars')).toBe(true);
  });

  it('soft-fails to an empty block on an invalid task query date', async () => {
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: 'CogSeed',
      context: { projectId: 'project-a' },
      at: 'not-a-date',
    });
    expect(result.promptBlock).toBe('');
    expect(result.readRefs).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.omitted).toContainEqual({ reason: 'context_unavailable', count: 1 });
    expect(result.errorCode).toBe('invalid_time');
  });

  it('does not match a short ASCII name inside another word', async () => {
    await seedOntology([{
      intent: 'create', recordId: 'ai-entity',
      record: { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: 'AI', description: '', aliases: [], identityStatus: 'confirmed' },
      sourceLabel: '用户确认',
    }]);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: 'email the summary',
      context: { projectId: 'project-a' },
    });
    expect(result.mentions).not.toContain('AI');
    expect(result.promptBlock).toBe('');
  });

  it('matches CJK names by substring', async () => {
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '请老王看一下',
      context: { projectId: 'project-a' },
    });
    expect(result.mentions).toContain('老王');
    expect(result.promptBlock).toContain('owner-fact');
  });

  it('seeds facts from a relation name mentioned in the task', async () => {
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '负责人是谁',
      context: { projectId: 'project-a' },
    });
    expect(result.mentions).toContain('负责人');
    expect(result.promptBlock).toContain('owner-fact');
  });

  it('infers a conservative task kind for automatic rule matching', async () => {
    await seedOntology([{
      intent: 'create', recordId: 'review-task-rule',
      record: {
        kind: 'rule', moduleId: 'project-module', name: '评审任务规则',
        requirement: '评审前确认负责人', strength: 'required',
        condition: { kind: 'task', field: 'taskKind', equals: 'review' },
        effect: { kind: 'note' }, exception: '',
      },
      sourceLabel: '用户确认',
    }]);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '准备研发项目评审会',
      context: { projectId: 'project-a' },
    });
    expect(result.promptBlock).toContain('review-task-rule');
    expect(result.promptBlock).toContain('match="matched"');
  });

  it('reports mentions dropped beyond MAX_MENTIONS as omitted', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `Mention${String.fromCharCode(65 + index)}`);
    await seedOntology(names.map((name, index) => ({
      intent: 'create', recordId: `mention-${index}`,
      record: { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name, description: '', aliases: [], identityStatus: 'confirmed' },
      sourceLabel: '用户确认',
    })));
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: names.join(' '),
      context: { projectId: 'project-a' },
    });
    expect(result.mentions).toHaveLength(8);
    expect(result.omitted).toContainEqual({ reason: 'budget_mentions', count: 2 });
    expect(result.complete).toBe(false);
  });

  it('uses the shared local calendar day when at is absent', async () => {
    vi.doMock('../../../../src/main/features/cognition/ontology/calendar-day', () => ({
      localCalendarDay: () => '2026-10-05',
    }));
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: 'CogSeed',
      context: { projectId: 'project-a' },
    });
    expect(result.at).toBe('2026-10-05');
  });

  it('ignores the non-rendered records limit when computing completeness', async () => {
    const extra = Array.from({ length: 101 }, (_, index) => ({
      intent: 'create' as const,
      recordId: `bulk-entity-${index}`,
      record: {
        kind: 'entity' as const, moduleId: 'project-module', typeId: 'person-type',
        name: `批量人员${index}`, description: '', aliases: [], identityStatus: 'confirmed' as const,
      },
      sourceLabel: '用户确认',
    }));
    await seedOntology(extra);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '研发项目',
      context: { projectId: 'project-a' },
    });
    expect(result.truncated.records).toBeGreaterThan(0);
    expect(result.complete).toBe(true);
  });

  it('clamps an oversized character budget to the hard ceiling', async () => {
    const manyRules = Array.from({ length: 60 }, (_, index) => ({
      intent: 'create' as const,
      recordId: `ceiling-rule-${index}`,
      record: {
        kind: 'rule' as const, moduleId: 'project-module', name: `上限规则${index}`,
        requirement: `上限规则正文${index} ${'内容'.repeat(200)}`,
        strength: 'suggestion' as const,
        condition: { kind: 'task' as const, field: 'purpose' as const, equals: 'weekly_report' },
        effect: { kind: 'note' as const }, exception: '',
      },
      sourceLabel: '用户确认',
    }));
    await seedOntology(manyRules);
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const result = await buildTaskOntologyContext({
      userId,
      taskText: '研发项目',
      context: { projectId: 'project-a' },
      purpose: 'weekly_report',
      budget: { maxChars: 50_000, maxRules: 60 },
    });
    expect(result.promptBlock.length).toBeLessThanOrEqual(8_000);
    expect(result.complete).toBe(false);
  });

  it('is deterministic for the same input', async () => {
    await seedOntology();
    const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const input = {
      userId,
      taskText: '准备 CogSeed 周报',
      context: { projectId: 'project-a' },
      purpose: 'weekly_report',
    };
    const first = await buildTaskOntologyContext(input);
    const second = await buildTaskOntologyContext(input);
    expect(second.promptBlock).toBe(first.promptBlock);
    expect(second.readRefs).toEqual(first.readRefs);
    expect(second.mentions).toEqual(first.mentions);
  });

  it('notes search truncation even when every rendered section fits', async () => {
    const { renderTaskOntologyBlock } = await import('../../../../src/main/features/cognition/ontology/task-context');
    const rendered = renderTaskOntologyBlock({
      query: 'CogSeed',
      at: '2026-10-05',
      modules: [],
      revision: 1,
      records: [],
      facts: [{
        match: 'matched',
        statement: 'CogSeed · 负责人 · 王工',
        validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' },
        module: { id: 'project-module', name: '研发项目' },
        citation: '[[ontology:project-module/owner-fact@1]]',
        source: { recordId: 'owner-fact', version: 1, label: '用户确认', kind: 'user' },
      }],
      uncertainFacts: [],
      rules: [],
      conflicts: [],
      conflictsComplete: true,
      searchTruncated: true,
      truncated: { facts: 0, uncertainFacts: 0, rules: 0, modules: 0, records: 0 },
      queryScope: 'task_topic_search_not_owner_inventory',
      sourceCoverage: { complete: true },
      scopeExcluded: { ownerOnly: { modules: 0, records: 0 }, otherScope: { modules: 0, records: 0 } },
      useBoundary: '',
      readRefs: [],
    }, {}, ['CogSeed']);
    expect(rendered.promptBlock).toContain('Candidate search results were truncated');
    expect(rendered.complete).toBe(false);
  });
});
