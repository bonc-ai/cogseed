import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let root: string, previousRoot: string | undefined;
const userId = 'ontology-tool-user';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-tool-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });

describe('cognition_ontology_query', () => {
  it('returns scoped current facts, rule status and version citations while excluding private and other-project records', async () => {
    const [{ createOntologyTools }, { commitOntologyCommand }] = await Promise.all([
      import('../../../../src/main/model/core-agent/ontology-tools'),
      import('../../../../src/main/features/cognition/ontology/service'),
    ]);
    const action = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: '用户确认' });
    await commitOntologyCommand(userId, { commandId: 'ontology-seed', expectedRevision: 0, actions: [
      action('project-module', { kind: 'module', name: '研发项目', description: '', scope: { kind: 'project', id: 'project-a' } }),
      action('other-module', { kind: 'module', name: '另一个项目', description: '', scope: { kind: 'project', id: 'project-b' } }),
      action('project-type', { kind: 'definition', moduleId: 'project-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('other-project-type', { kind: 'definition', moduleId: 'other-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('person-type', { kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('owner-def', { kind: 'definition', moduleId: 'project-module', name: '负责人', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('salary-def', { kind: 'definition', moduleId: 'project-module', name: '内部薪酬', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      action('weekly-recipient-def', { kind: 'definition', moduleId: 'project-module', name: '周报接收人', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      action('project-a', { kind: 'entity', moduleId: 'project-module', typeId: 'project-type', name: 'CogSeed', description: '', aliases: [], identityStatus: 'confirmed' }),
      action('person-a', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '示例同名成员', description: '', aliases: [], identityStatus: 'confirmed' }),
      action('person-b', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '示例同名成员', description: '另一个人', aliases: [], identityStatus: 'confirmed' }),
      action('project-b-record', { kind: 'entity', moduleId: 'other-module', typeId: 'other-project-type', name: 'CogSeed', description: '不得跨项目回传', aliases: [], identityStatus: 'confirmed' }),
      action('owner-fact', { kind: 'assertion', moduleId: 'project-module', subjectId: 'project-a', definitionId: 'owner-def', object: { kind: 'entity', id: 'person-a' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
      action('private-fact', { kind: 'assertion', moduleId: 'project-module', subjectId: 'person-a', definitionId: 'salary-def', object: { kind: 'literal', valueType: 'text', value: 'private-salary-marker' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' }, access: 'owner_only' }),
      action('weekly-rule', { kind: 'rule', moduleId: 'project-module', name: '周报规则', requirement: '周报发给负责人', strength: 'required', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'include_recipient', entityId: 'person-a' }, exception: '本次另有指定时遵循本次安排。' }),
      action('choice-rule-a', { kind: 'rule', moduleId: 'project-module', name: '周报样式甲', requirement: '采用简洁格式', strength: 'required', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'choice', key: 'report_style', value: 'brief' }, exception: '' }),
      action('choice-rule-b', { kind: 'rule', moduleId: 'project-module', name: '周报样式乙', requirement: '采用详细格式', strength: 'required', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'choice', key: 'report_style', value: 'detailed' }, exception: '' }),
      ...Array.from({ length: 31 }, (_, index) => action(`extra-weekly-rule-${index}`, { kind: 'rule', moduleId: 'project-module', name: `周报附加项${index}`, requirement: `附加检查${index}`, strength: 'suggestion', condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'note' }, exception: '' })),
    ] });
    const [tool] = createOntologyTools({ userId, turnId: 'turn-ontology-query-1', context: { projectId: 'project-a', taskText: '准备 CogSeed 周报' } });
    const result = await tool.execute({ query: 'CogSeed', purpose: 'weekly_report', at: '2026-10-05' });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content) as { modules: Array<{ id: string }>; facts: Array<{ source: { recordId: string; version: number }; citation: string }>; rules: Array<{ source: { recordId: string }; strength: string; match: string; citation: string }>; conflicts: Array<{ key: string; values: string[]; state: string }>; conflictsComplete: boolean; uncertainFacts: unknown[]; readReceipt: { status: string; id?: string }; truncated: { rules: number }; usageReceiptPolicy: string; useBoundary: string };
    expect(payload.modules.map(m => m.id)).toEqual(['project-module']);
    expect(payload.facts.some(f => f.source.recordId === 'owner-fact' && f.source.version === 1)).toBe(true);
    expect(payload.facts.find(f => f.source.recordId === 'owner-fact')?.citation).toBe('[[ontology:project-module/owner-fact@1]]');
    expect(payload.facts.some(f => f.source.recordId === 'private-fact')).toBe(false);
    expect(payload.rules).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ recordId: 'weekly-rule', version: 1, label: '用户确认' }), strength: 'required', match: 'matched' }));
    expect(payload.rules.find(rule => rule.source.recordId === 'weekly-rule')?.citation).toBe('[[ontology:project-module/weekly-rule@1]]');
    expect(payload.conflicts).toContainEqual(expect.objectContaining({ key: 'report_style', values: expect.arrayContaining(['brief', 'detailed']), state: 'confirmed' }));
    expect(payload.truncated.rules).toBe(4);
    expect(payload.conflictsComplete).toBe(false);
    // 执行证据边界防漂移：查询/采用回证只证明「读到了、引用进了答复」，
    // 不证明外部动作已执行或生效——这两句被删改时测试必须失败。
    expect(payload.usageReceiptPolicy).toContain('does not prove external action execution or effectiveness');
    expect(payload.useBoundary).toContain('A rule match does not mean rule execution');
    expect(payload.readReceipt.status).toBe('recorded');
    const { listRecallJsonlRecords } = await import('../../../../src/main/features/recall/store');
    const receipts = await listRecallJsonlRecords(userId, 'ontology-query-receipts', 'events', 0);
    expect(receipts).toHaveLength(1);
    const refs = receipts[0].recordRefs as Array<{ moduleId: string; recordId: string; recordVersion: number; kind: string }>;
    expect(refs).toContainEqual(expect.objectContaining({ moduleId: 'project-module', recordId: 'owner-fact', recordVersion: 1, kind: 'assertion' }));
    expect(refs).toContainEqual(expect.objectContaining({ moduleId: 'project-module', recordId: 'weekly-rule', recordVersion: 1, kind: 'rule' }));
    expect(refs.some(ref => ref.recordId === 'private-fact' || ref.moduleId === 'other-module')).toBe(false);
    expect(JSON.stringify(receipts[0])).not.toContain('准备 CogSeed 周报');
    expect(JSON.stringify(payload)).not.toContain('private-salary-marker');

    const { finalizeOntologyUsageCitations } = await import('../../../../src/main/features/cognition/ontology/usage-receipt');
    const finalText = `本周安排：${payload.facts.find(f => f.source.recordId === 'owner-fact')?.citation}`;
    const finalized = await finalizeOntologyUsageCitations(userId, { taskRunId: 'turn-ontology-query-1', messageId: 'persisted-answer-1', finalText });
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ recordId: 'owner-fact', recordVersion: 1, messageId: 'persisted-answer-1', effectVerified: false });

    const [emptyTool] = createOntologyTools({ userId, turnId: 'turn-ontology-empty', context: { projectId: 'project-a' } });
    const emptyResult = await emptyTool.execute({ query: '不存在的主题', at: '2026-10-05' });
    expect(JSON.parse(emptyResult.content).readReceipt.status).toBe('no_result_refs');
    const [noTurnTool] = createOntologyTools({ userId, context: { projectId: 'project-a' } });
    const noTurnResult = await noTurnTool.execute({ query: 'CogSeed', at: '2026-10-05' });
    expect(JSON.parse(noTurnResult.content).readReceipt.status).toBe('no_turn_id');
    expect(await listRecallJsonlRecords(userId, 'ontology-query-receipts', 'events', 0)).toHaveLength(1);
  });

  it('rejects a query receipt over the returned-record cap instead of silently omitting citations', async () => {
    const { recordOntologyQueryReadReceipt } = await import('../../../../src/main/features/cognition/ontology/query-receipt');
    const refs = Array.from({ length: 151 }, (_, index) => ({ moduleId: 'module-1', recordId: `record-${index}`, recordVersion: 1,
      kind: 'assertion' as const, sourceKind: 'user' as const }));
    await expect(recordOntologyQueryReadReceipt(userId, 'turn-ontology-cap', refs)).rejects.toThrow(/exceeds result limit/);
  });
});
