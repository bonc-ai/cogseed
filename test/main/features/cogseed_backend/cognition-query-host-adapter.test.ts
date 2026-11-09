import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
let previousRoot: string | undefined;
const userId = 'cognition-query-host-user';

const baseTask = {
  taskId: 'cogseed-task-query1',
  sessionId: 'cogseed-session-query1',
  runtimeSessionId: 'mruntime-query1',
  requestId: 'req-query1',
  executionId: 'cogseed-exec-query1',
  task: 'Use the cognition query host tools',
};
const baseSession = {
  ownerId: userId,
  lifecycleState: 'active',
  runtimeSessionId: 'mruntime-query1',
  activeTaskId: 'cogseed-task-query1',
};
const baseConversation = {
  conversation_id: 'conv-query1',
  project_id: 'project-a',
  space_id: '',
  kind: 'task' as const,
};

const { readTask, readSession, getConversation, reception } = vi.hoisted(() => ({
  readTask: vi.fn(),
  readSession: vi.fn(),
  getConversation: vi.fn(),
  reception: vi.fn(),
}));

vi.mock('../../../../src/main/features/cogseed_backend/task-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/cogseed_backend/task-store')>(),
  readCogSeedTaskByRequestId: readTask,
}));
vi.mock('../../../../src/main/features/cogseed_backend/session-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/cogseed_backend/session-store')>(),
  readCogSeedSession: readSession,
}));
vi.mock('../../../../src/main/features/chats', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/chats')>(),
  getConversation,
}));
vi.mock('../../../../src/main/features/cogseed_backend/runtime-tool-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/cogseed_backend/runtime-tool-policy')>(),
  isA2AReceptionRequest: reception,
}));

import { boundCognitionQueryResult, runCognitionQueryHostTool } from '../../../../src/main/features/cogseed_backend/cognition-query-host-adapter';
import type { OntologyTaskQueryResult } from '../../../../src/main/features/cognition/ontology/task-query';
import type { CogSeedHostToolScope } from '../../../../src/main/features/cogseed_backend/office-adapter';

const scope: CogSeedHostToolScope = {
  userId, requestId: 'req-query1', runtimeSessionId: 'mruntime-query1',
  readOnlyRoots: [], writableRoots: [],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cognition-query-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  readTask.mockReset().mockResolvedValue({ ...baseTask, conversationId: 'conv-query1' });
  readSession.mockReset().mockResolvedValue({ ...baseSession });
  getConversation.mockReset().mockResolvedValue({ ...baseConversation });
  reception.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedOntology() {
  const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
  const action = (recordId: string, record: Record<string, unknown>) => ({
    intent: 'create', recordId, record, sourceLabel: '用户确认',
  });
  await commitOntologyCommand(userId, {
    commandId: 'cognition-query-seed',
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
    ],
  });
}

async function writeAbilityAsset(assetId: string) {
  const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
  await writeRecallJsonRecord(userId, 'ability-assets', assetId, {
    schemaVersion: 1, ownerId: userId,
    id: assetId, candidateId: `cand-${assetId}`, title: '测试资产', statement: '周报要先发负责人再抄送项目组。',
    evidenceRefs: [], sourceCandidateIds: [], sourceSessionIds: [], origin: 'manual',
    scope: 'general', version: '1', activeVersion: '1', status: 'active',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

describe('cognition query host adapter — input whitelist', () => {
  it('rejects scope-bearing and unknown fields for ontology_task_query', async () => {
    for (const extra of [
      { user_id: 'attacker' }, { userId: 'attacker' }, { project_id: 'project-b' }, { projectId: 'project-b' },
      { workspace_id: 'ws' }, { agent_id: 'agent-x' }, { agentId: 'agent-x' }, { mode: 'owner' },
      { ownerId: 'attacker' }, { scope: 'owner' }, { sessionId: 's' }, { conversationId: 'c' },
      { taskId: 't' }, { runtimeSessionId: 'r' }, { task_text: 'x' }, { file_kinds: ['pdf'] },
      { injected_asset_ids: ['a'] }, { unknown_field: 1 },
    ]) {
      const result = await runCognitionQueryHostTool('ontology_task_query',
        { query: 'CogSeed', ...extra }, scope);
      expect(result.isError, `field ${JSON.stringify(extra)} must be rejected`).toBe(true);
      expect(result.content).toContain('[E_COGNITION_QUERY_INPUT_REJECTED]');
    }
  });

  it('rejects unknown fields for search_ability_assets', async () => {
    for (const extra of [
      { mode: 'owner' }, { userId: 'attacker' }, { project_id: 'project-b' }, { agentId: 'agent-x' },
      { taskText: 'x' }, { unknown: true },
    ]) {
      const result = await runCognitionQueryHostTool('search_ability_assets',
        { query: '周报', ...extra }, scope);
      expect(result.isError, `field ${JSON.stringify(extra)} must be rejected`).toBe(true);
      expect(result.content).toContain('[E_COGNITION_QUERY_INPUT_REJECTED]');
    }
  });

  it('rejects an empty ontology query', async () => {
    const result = await runCognitionQueryHostTool('ontology_task_query', { query: '   ' }, scope);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[E_COGNITION_QUERY_INVALID_INPUT]');
  });
});

describe('cognition query host adapter — host-side scope re-derivation', () => {
  it('rejects when the persisted task is missing', async () => {
    readTask.mockResolvedValue(undefined);
    const result = await runCognitionQueryHostTool('ontology_task_query', { query: 'CogSeed' }, scope);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[E_COGNITION_QUERY_SCOPE_UNAVAILABLE]');
  });

  it('rejects when task.runtimeSessionId does not match the runtime request', async () => {
    readTask.mockResolvedValue({ ...baseTask, runtimeSessionId: 'mruntime-other', conversationId: 'conv-query1' });
    const result = await runCognitionQueryHostTool('ontology_task_query', { query: 'CogSeed' }, scope);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[E_COGNITION_QUERY_SCOPE_UNAVAILABLE]');
  });

  it('rejects when the session is missing, not owned, inactive, or not on this task', async () => {
    const variants = [
      undefined,
      { ...baseSession, ownerId: 'someone-else' },
      { ...baseSession, lifecycleState: 'ended' },
      { ...baseSession, activeTaskId: 'cogseed-task-other' },
    ];
    for (const session of variants) {
      readSession.mockResolvedValue(session);
      const result = await runCognitionQueryHostTool('ontology_task_query', { query: 'CogSeed' }, scope);
      expect(result.isError, `session ${JSON.stringify(session?.ownerId ?? session)} must be rejected`).toBe(true);
      expect(result.content).toContain('[E_COGNITION_QUERY_SCOPE_UNAVAILABLE]');
    }
  });

  it('rejects when the bound conversation is unavailable', async () => {
    getConversation.mockResolvedValue(null);
    const result = await runCognitionQueryHostTool('ontology_task_query', { query: 'CogSeed' }, scope);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[E_COGNITION_QUERY_SCOPE_UNAVAILABLE]');
  });

  it('rejects delegated child tasks and A2A reception tasks', async () => {
    readTask.mockResolvedValue({ ...baseTask, conversationId: 'conv-query1', parentTaskId: 'cogseed-task-parent' });
    const child = await runCognitionQueryHostTool('ontology_task_query', { query: 'CogSeed' }, scope);
    expect(child).toEqual({ content: expect.stringMatching(/^\[E_COGNITION_QUERY_FORBIDDEN\]/), isError: true });

    readTask.mockResolvedValue({ ...baseTask, conversationId: 'conv-query1' });
    reception.mockResolvedValue(true);
    const receptionResult = await runCognitionQueryHostTool('search_ability_assets', {}, scope);
    expect(receptionResult).toEqual({ content: expect.stringMatching(/^\[E_COGNITION_QUERY_FORBIDDEN\]/), isError: true });
  });

  it('scopes the ontology query to the conversation project (cross-project invisible)', async () => {
    await seedOntology();
    const result = await runCognitionQueryHostTool('ontology_task_query',
      { query: 'CogSeed', at: '2026-11-02' }, scope);
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content);
    expect(payload.facts.some((fact: { citation: string }) => fact.citation === '[[ontology:project-module/owner-fact@1]]')).toBe(true);
    expect(result.content).not.toContain('other-module');
    expect(result.content).not.toContain('private-salary-marker');

    // Same query under the other project: project-a facts stay invisible.
    getConversation.mockResolvedValue({ ...baseConversation, project_id: 'project-b' });
    const other = await runCognitionQueryHostTool('ontology_task_query',
      { query: 'CogSeed', at: '2026-11-02' }, scope);
    expect(other.content).not.toContain('owner-fact');
    expect(other.content).not.toContain('private-salary-marker');
  });

  it('records an ontology query read receipt bound to the persisted task', async () => {
    await seedOntology();
    const result = await runCognitionQueryHostTool('ontology_task_query',
      { query: 'CogSeed', at: '2026-11-02' }, scope);
    expect(result.isError).toBeFalsy();
    const { listOntologyQueryReadReceipts } = await import('../../../../src/main/features/cognition/ontology/query-receipt');
    const receipts = await listOntologyQueryReadReceipts(userId, baseTask.taskId);
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts[0].recordRefs).toContainEqual(expect.objectContaining({
      moduleId: 'project-module', recordId: 'owner-fact', recordVersion: 1, kind: 'assertion',
    }));
    expect(receipts[0].executionId).toBe('cogseed-exec-query1');
  });
});

describe('cognition query host adapter — search_ability_assets', () => {
  it('reads an admitted asset body and records the agent-read receipt for the task turn', async () => {
    await writeAbilityAsset('aa-hostread1');
    const result = await runCognitionQueryHostTool('search_ability_assets',
      { assetIds: ['aa-hostread1'] }, scope);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('[asset:aa-hostread1]');
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    const receipts = await listInjectionReceipts(userId, baseTask.taskId);
    const agentRead = receipts.filter(row => row.channel === 'agent_read' && row.assetId === 'aa-hostread1');
    expect(agentRead.length).toBeGreaterThan(0);
  });

  it('returns the catalog page without a query', async () => {
    await writeAbilityAsset('aa-hostcat1');
    const result = await runCognitionQueryHostTool('search_ability_assets', {}, scope);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('aa-hostcat1');
  });

  it('reports failures as errors instead of throwing', async () => {
    readTask.mockRejectedValue(new Error('store boom'));
    const result = await runCognitionQueryHostTool('search_ability_assets', { query: 'x' }, scope);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[E_COGNITION_QUERY_FAILED]');
  });
});

describe('cognition query host adapter — transport bounding', () => {
  const factRow = (index = 0) => ({
    match: 'matched' as const,
    statement: `事实 ${index}`,
    validity: { from: '2026-01-01', until: null, precision: 'day' as const, timezone: 'Asia/Shanghai' },
    module: { id: 'project-module', name: '研发项目' },
    citation: `[[ontology:project-module/fact-${index}@1]]`,
    source: { recordId: `fact-${index}`, version: 1, label: '用户确认', kind: 'user' as const },
  });
  const readRef = (index = 0) => ({
    moduleId: 'project-module', recordId: `fact-${index}`, recordVersion: 1,
    kind: 'assertion' as const, sourceKind: 'user' as const,
  });
  const queryResult = (overrides: Partial<OntologyTaskQueryResult> = {}): OntologyTaskQueryResult => ({
    query: 'CogSeed',
    at: '2026-10-05',
    modules: [],
    revision: 1,
    records: [],
    facts: [],
    uncertainFacts: [],
    rules: [],
    conflicts: [],
    conflictsComplete: true,
    searchTruncated: false,
    truncated: { facts: 0, uncertainFacts: 0, rules: 0, modules: 0, records: 0 },
    queryScope: 'task_topic_search_not_inventory',
    sourceCoverage: { complete: true },
    scopeExcluded: { ownerOnly: { modules: 0, records: 0 }, otherScope: { modules: 0, records: 0 } },
    useBoundary: '',
    readRefs: [],
    ...overrides,
  });

  it('drops oversized records before they cross the host transport', () => {
    const result = queryResult({
      records: Array.from({ length: 10 }, (_, index) => ({
        id: `record-${index}`, description: 'x'.repeat(2_000),
      })) as any,
      facts: [factRow()],
      readRefs: [readRef()],
    });
    const bounded = boundCognitionQueryResult(result, 4_000);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(4_000);
    expect(bounded.records).toEqual([]);
    expect(bounded.truncated.records).toBe(10);
    expect(bounded.readRefs).toEqual([readRef()]);
  });

  it('keeps read refs aligned with the facts that survive trimming', () => {
    const facts = Array.from({ length: 20 }, (_, index) => ({
      ...factRow(index), statement: `事实 ${'x'.repeat(500)}`,
    }));
    const result = queryResult({
      facts,
      readRefs: facts.map((_, index) => readRef(index)),
    });
    const bounded = boundCognitionQueryResult(result, 2_000);
    expect(bounded.facts.length).toBeLessThan(20);
    expect(bounded.truncated.facts).toBeGreaterThan(0);
    expect(bounded.readRefs.every(ref => bounded.facts.some(row => row.source.recordId === ref.recordId))).toBe(true);
  });

  it('rejects an invalid at with a stable code', async () => {
    const result = await runCognitionQueryHostTool('ontology_task_query',
      { query: 'CogSeed', at: 'not-a-date' }, scope);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[E_COGNITION_QUERY_INVALID_TIME]');
  });

  it('rejects oversized purpose and task_kind fields', async () => {
    const purpose = await runCognitionQueryHostTool('ontology_task_query',
      { query: 'CogSeed', purpose: 'x'.repeat(201) }, scope);
    expect(purpose.isError).toBe(true);
    expect(purpose.content).toContain('[E_COGNITION_QUERY_INVALID_INPUT]');
    const taskKind = await runCognitionQueryHostTool('ontology_task_query',
      { query: 'CogSeed', task_kind: 'x'.repeat(81) }, scope);
    expect(taskKind.isError).toBe(true);
    expect(taskKind.content).toContain('[E_COGNITION_QUERY_INVALID_INPUT]');
  });
});
