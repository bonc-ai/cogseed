/** Read-only task slot resolution, three-axis checked receipts, and legacy filled receipt compatibility.
 * All identities, projects and facts below are synthetic fixtures. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const userId = 'slots-user';
let root: string, previousRoot: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-slots-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });

async function seedOntology() {
  const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
  const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: '用户确认' });
  return commitOntologyCommand(userId, { commandId: 'slots-seed', expectedRevision: 0, actions: [
    create('project-module', { kind: 'module', name: '项目协作', description: '', scope: { kind: 'project', id: 'project-a' } }),
    create('project-type', { kind: 'definition', moduleId: 'project-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('person-type', { kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('recipient-definition', { kind: 'definition', moduleId: 'project-module', name: '接收周报', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('owner-definition', { kind: 'definition', moduleId: 'project-module', name: '负责', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' }),
    create('project-object', { kind: 'entity', moduleId: 'project-module', typeId: 'project-type', name: '项目甲', description: '', aliases: [], identityStatus: 'confirmed' }),
    create('wang-person', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '王芳', description: '研发部', aliases: [], identityStatus: 'confirmed' }),
    create('li-dev', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '李明', description: '研发部', aliases: ['研发部李明'], identityStatus: 'confirmed' }),
    create('li-sales', { kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '李明', description: '销售部', aliases: [], identityStatus: 'confirmed' }),
    create('wang-recipient', { kind: 'assertion', moduleId: 'project-module', subjectId: 'project-object', definitionId: 'recipient-definition', object: { kind: 'entity', id: 'wang-person' },
      validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
    create('weekly-rule', { kind: 'rule', moduleId: 'project-module', name: '周报包含进展和风险', requirement: '周报应包含本周进展及风险', strength: 'required',
      condition: null, effect: { kind: 'note' }, exception: '' }),
  ] });
}

const projectContext = { projectId: 'project-a' };

describe('resolveOntologySlots（本体轴只读解析）', () => {
  it('fact 槽位绑定当前事实，带 moduleId/recordId/version；规则槽位绑定适用规则', async () => {
    await seedOntology();
    const { resolveOntologySlots } = await import('../../../../src/main/features/cognition_kernel');
    const result = await resolveOntologySlots(userId, [
      { slot: '周报-固定接收人', kind: 'fact', relation: '接收周报', subjectRequired: true },
      { slot: '周报-适用要求', kind: 'rule', ruleKeyword: '周报', required: false },
    ], { context: projectContext, subjects: { '周报-固定接收人': '项目甲' } });
    expect(result.missing).toEqual([]);
    const fact = result.bound.find(hit => hit.kind === 'fact');
    expect(fact).toMatchObject({ slot: '周报-固定接收人', moduleId: 'project-module', recordId: 'wang-recipient', version: 1, truth: 'true' });
    expect(fact?.statement).toContain('王芳');
    const rule = result.bound.find(hit => hit.kind === 'rule');
    expect(rule).toMatchObject({ recordId: 'weekly-rule' });
  });

  it('主体未绑定／找不到主体→no_value；同名两个李明→拒绝并列说明；范围外→not_authorized', async () => {
    await seedOntology();
    const { resolveOntologySlots } = await import('../../../../src/main/features/cognition_kernel');
    const noSubject = await resolveOntologySlots(userId, [{ slot: '周报-固定接收人', kind: 'fact', relation: '接收周报', subjectRequired: true }], { context: projectContext });
    expect(noSubject.missing[0]).toMatchObject({ slot: '周报-固定接收人', reason: 'no_value' });
    expect(noSubject.missing[0].note).toContain('主体');

    const notFound = await resolveOntologySlots(userId, [{ slot: 's', kind: 'fact', relation: '接收周报', subjectRequired: true }], { context: projectContext, subjects: { s: '项目乙' } });
    expect(notFound.missing[0]?.note).toContain('项目乙');

    const ambiguous = await resolveOntologySlots(userId, [{ slot: 's', kind: 'fact', relation: '接收周报', subjectRequired: true }], { context: projectContext, subjects: { s: '李明' } });
    expect(ambiguous.bound).toEqual([]);
    expect(ambiguous.missing[0]?.note).toContain('同名对象有 2 个');

    const outOfScope = await resolveOntologySlots(userId, [{ slot: 's', kind: 'fact', relation: '接收周报', subjectRequired: true }], { context: { projectId: 'project-other' }, subjects: { s: '项目甲' } });
    expect(outOfScope.missing[0]).toMatchObject({ reason: 'no_value' });
    expect(outOfScope.bound).toEqual([]);
  });

  it('规则槽位找不到规则不算缺（没有规则不是缺口）', async () => {
    await seedOntology();
    const { resolveOntologySlots } = await import('../../../../src/main/features/cognition_kernel');
    const result = await resolveOntologySlots(userId, [{ slot: '合成任务-规则', kind: 'rule', ruleKeyword: '合成任务' }], { context: projectContext });
    expect(result.bound).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

describe('resolveAssetSlots（方法资产轴只读解析）', () => {
  it('按类型+标题绑定资产；没有该资产如实 no_value', async () => {
    await seedOntology();
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const now = new Date().toISOString();
    await writeRecallJsonRecord(userId, 'ability-assets', 'asset-template-1', {
      schemaVersion: 1, ownerId: userId, id: 'asset-template-1', candidateId: 'cand-1', type: 'template', title: '周报模板',
      statement: '进展/风险/下周计划', evidenceRefs: [], origin: 'manual', status: 'active', lifecycleStatus: 'user_confirmed_unverified',
      maturity: 'seed', scope: 'global', version: '3', activeVersion: '3', createdAt: now, updatedAt: now,
    });
    const { resolveAssetSlots } = await import('../../../../src/main/features/cognition_kernel');
    const bound = await resolveAssetSlots(userId, [{ slot: '周报-内容模板', assetType: 'template', title: '周报模板', required: false }]);
    expect(bound.bound[0]).toMatchObject({ slot: '周报-内容模板', assetId: 'asset-template-1', version: '3' });
    const missing = await resolveAssetSlots(userId, [{ slot: '周报-内容模板', assetType: 'template', title: '不存在的模板', required: false }]);
    expect(missing.missing[0]).toMatchObject({ slot: '周报-内容模板', reason: 'no_value', required: false });
  });
});

describe('checkTaskFields 三轴体检与回执', () => {
  it('三轴合并：本体轴缺口进 gaps，资产缺失不进 gaps；回执覆盖三轴；filled 事件闭环可读', async () => {
    await seedOntology();
    const { writeRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    const now = new Date().toISOString();
    await writeRecallJsonRecord(userId, 'ability-assets', 'asset-template-1', {
      schemaVersion: 1, ownerId: userId, id: 'asset-template-1', candidateId: 'cand-1', type: 'template', title: '周报模板',
      statement: '进展/风险/下周计划', evidenceRefs: [], origin: 'manual', status: 'active', lifecycleStatus: 'user_confirmed_unverified',
      maturity: 'seed', scope: 'global', version: '3', activeVersion: '3', createdAt: now, updatedAt: now,
    });
    const kernel = await import('../../../../src/main/features/cognition_kernel');
    const check = await kernel.checkTaskFields(userId, kernel.TASK_FIELD_PACKS.weekly_report, projectContext, { '周报-固定接收人': '项目甲' });
    expect(check.ontology?.bound.map(hit => hit.slot)).toContain('周报-固定接收人');
    expect(check.assets?.bound.map(hit => hit.slot)).toContain('周报-内容模板');
    expect(check.gaps.every(gap => gap.axis === 'personal' || gap.axis === 'ontology')).toBe(true);
    expect(check.totalCount).toBe(5);

    const receipt = await kernel.recordCognitionBoundReceipt(userId, 'turn-77', 'weekly_report', check);
    expect(receipt?.taskRunId).toBe('turn-77');
    const axes = new Set(receipt!.bound.map(ref => ref.axis));
    expect(axes).toEqual(new Set(['ontology', 'asset']));
    const stored = await kernel.listCognitionBoundReceipts(userId, 'turn-77');
    expect(stored[0].bound.find(ref => ref.axis === 'ontology')).toMatchObject({ moduleId: 'project-module', sourceId: 'wang-recipient', version: '1' });
    expect(stored[0].bound.find(ref => ref.axis === 'asset')).toMatchObject({ source: 'recall_asset', sourceId: 'asset-template-1' });

    // Previously saved filled events remain readable without a production writer.
    const { appendRecallJsonlRecord } = await import('../../../../src/main/features/recall/store');
    await appendRecallJsonlRecord(userId, 'cognition-bound-receipts', 'events', {
      ...receipt!, id: 'cbound-history77', status: 'filled', missing: [],
      bound: [receipt!.bound.find(ref => ref.axis === 'ontology')!], boundCount: 1, totalCount: 1,
    });
    const all = await kernel.listCognitionBoundReceipts(userId, 'turn-77');
    expect(all.filter(record => record.status === 'filled')).toHaveLength(1);
    expect(all.filter(record => record.status === 'checked')).toHaveLength(1);
  });

  it('P0 历史 axis=personal 回执在新读侧继续可读', async () => {
    const { recordCognitionBoundReceipt, listCognitionBoundReceipts, checkTaskFields } = await import('../../../../src/main/features/cognition_kernel');
    const check = await checkTaskFields(userId, { id: 'synthetic_task', title: '合成任务', fields: [{ fieldName: '姓名' }] });
    await recordCognitionBoundReceipt(userId, 'turn-p0', 'synthetic_task', check);
    const listed = await listCognitionBoundReceipts(userId, 'turn-p0');
    expect(listed[0].missing.map(ref => ref.axis)).toEqual(['personal']);
    expect(listed[0].bound).toEqual([]);
  });
});
