import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOntologyCommand, resolveOntologyRecordForModule, type OntologyCommand } from '../../../src/main/features/cognition/ontology/commands';
import { emptyOntologyDocument, type OntologyDocument, type OntologyAssertion, type OntologyRecord } from '../../../src/main/features/cognition/ontology/model';
import { queryOntologyFacts, queryOntologyRules, ontologyRecordsKnownAt } from '../../../src/main/features/cognition/ontology/query';

vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const uid = 'ontology-domain-user';
const t1 = '2026-09-01T00:00:00Z', t2 = '2026-10-05T00:00:00Z';
const validity = { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' };
const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create' as const, recordId, record, sourceLabel: '用户确认' });
const type = (moduleId: string, name: string) => ({ kind: 'definition', moduleId, name, description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' });
function seedCommand(): OntologyCommand {
  return { commandId: 'seed', expectedRevision: 0, actions: [
    create('people', { kind: 'module', name: '个人本体', description: '', scope: { kind: 'personal' } }),
    create('projects', { kind: 'module', name: '项目协作', description: '', scope: { kind: 'project', id: 'cogseed' } }),
    create('person-type', type('people', '人物')),
    create('project-type', type('projects', '项目')),
    create('ref-people', { kind: 'reference', moduleId: 'projects', targetModuleId: 'people', versionPolicy: 'current' }),
    create('zhang-a', { kind: 'entity', moduleId: 'people', typeId: 'person-type', name: '示例同名成员', description: '研发组', aliases: [], identityStatus: 'confirmed' }),
    create('zhang-b', { kind: 'entity', moduleId: 'people', typeId: 'person-type', name: '示例同名成员', description: '客户组', aliases: [], identityStatus: 'confirmed' }),
    create('project', { kind: 'entity', moduleId: 'projects', typeId: 'project-type', name: 'CogSeed', description: '', aliases: [], identityStatus: 'confirmed' }),
    create('owner-def', { kind: 'definition', moduleId: 'projects', name: '负责人', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' }),
    create('recipient-def', { kind: 'definition', moduleId: 'projects', name: '周报接收人', description: '', definitionKind: 'relation', subjectTypes: ['project-type'], objectTypes: ['person-type'], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('department-def', { kind: 'definition', moduleId: 'people', name: '部门', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
    create('owner', { kind: 'assertion', moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', object: { kind: 'entity', id: 'zhang-a' }, validity }),
    create('department', { kind: 'assertion', moduleId: 'people', subjectId: 'zhang-a', definitionId: 'department-def', object: { kind: 'literal', valueType: 'text', value: '产品部' }, validity }),
  ] };
}
const seed = () => applyOntologyCommand(emptyOntologyDocument(uid), seedCommand(), t1).document;
function fact(doc: OntologyDocument, id: string): OntologyAssertion { return doc.records[id] as OntologyAssertion; }
function mutation(intent: 'change' | 'correct') {
  return { commandId: intent, expectedRevision: 1, actions: [{ intent, recordId: 'owner', expectedVersion: 1,
    object: { kind: 'entity', id: 'zhang-b' }, ...(intent === 'change' ? { effectiveFrom: '2026-10-01' } : {}), sourceLabel: '用户说明' }] };
}
describe('本体领域的真实行为', () => {
  const mergeCommand = (doc: OntologyDocument): OntologyCommand => ({ commandId: 'merge-identities', expectedRevision: doc.revision,
    actions: [{ intent: 'merge', recordId: 'zhang-a', expectedVersion: doc.records['zhang-a'].version,
      targetId: 'zhang-b', expectedTargetVersion: doc.records['zhang-b'].version, sourceLabel: '用户核对唯一人员编号，确认为同一人' }] });
  it('显式合并重定向当前事实、规则和引用，保留双方身份和历史版本', () => {
    let doc = seed();
    doc = applyOntologyCommand(doc, { commandId: 'merge-dependencies', expectedRevision: doc.revision, actions: [
      create('specific-ref', { kind: 'reference', moduleId: 'projects', targetModuleId: 'people', targetRecordId: 'zhang-a', versionPolicy: 'current' }),
      create('merge-rule', { kind: 'rule', moduleId: 'projects', name: '必须通知此人', requirement: '通知此人', strength: 'required',
        condition: { kind: 'all', conditions: [{ kind: 'task', field: 'entityId', equals: 'zhang-a' },
          { kind: 'assertion', subjectId: 'zhang-a', definitionId: 'department-def' }] },
        effect: { kind: 'include_recipient', entityId: 'zhang-a' }, exception: '' }),
    ] }, t2).document;
    const merged = applyOntologyCommand(doc, mergeCommand(doc), t2).document;
    expect(merged.records['zhang-a'].status).toBe('archived');
    expect(fact(merged, 'owner').object).toEqual({ kind: 'entity', id: 'zhang-b' });
    expect(fact(merged, 'department').subjectId).toBe('zhang-b');
    expect(merged.records['specific-ref']).toMatchObject({ targetRecordId: 'zhang-b', version: 2 });
    expect(merged.records['merge-rule']).toMatchObject({ effect: { entityId: 'zhang-b' }, condition: { conditions: [
      { kind: 'task', equals: 'zhang-b' }, { kind: 'assertion', subjectId: 'zhang-b' } ] } });
    expect((ontologyRecordsKnownAt(merged, undefined, doc.revision).owner as OntologyAssertion).object).toEqual({ kind: 'entity', id: 'zhang-a' });
    expect(queryOntologyFacts(merged, { moduleId: 'projects', definitionId: 'owner-def', at: '2026-10-05', knownRevision: doc.revision }).matched).toEqual([]);
    expect(doc.records['zhang-a'].status).toBe('active');
  });
  it('撤销合并逐项升版恢复原身份和引用，旧合并历史继续保留', () => {
    const doc = seed();
    const result = applyOntologyCommand(doc, mergeCommand(doc), t2);
    const recovered = applyOntologyCommand(result.document, { commandId: 'undo-identity', expectedRevision: result.document.revision, actions: [
      { intent: 'undo_merge', recordId: 'zhang-a', expectedVersion: 2, mergeCommandId: 'merge-identities', sourceLabel: '用户确认撤销身份合并' },
    ] }, t2).document;
    expect(recovered.records['zhang-a']).toMatchObject({ status: 'active', version: 3 });
    expect(fact(recovered, 'owner')).toMatchObject({ object: { id: 'zhang-a' }, version: 3 });
    expect(recovered.history.some(entry => entry.intent === 'merge_source')).toBe(true);
    expect(recovered.history.some(entry => entry.intent === 'undo_merge')).toBe(true);
    expect(() => applyOntologyCommand(result.document, { commandId: 'wrong-restore', expectedRevision: result.document.revision,
      actions: [{ intent: 'restore', recordId: 'zhang-a', expectedVersion: 2, sourceLabel: '用户确认' }] }, t2)).toThrow(/undo_merge/);
  });
  it('合并后任一受影响记录被修改，撤销拒绝覆盖后续版本', () => {
    const original = seed();
    const merged = applyOntologyCommand(original, mergeCommand(original), t2).document;
    const changed = applyOntologyCommand(merged, { commandId: 'post-merge-edit', expectedRevision: merged.revision, actions: [
      { intent: 'update', recordId: 'zhang-b', expectedVersion: 2, patch: { description: '后续已核对的新资料' }, sourceLabel: '用户确认' },
    ] }, t2).document;
    expect(() => applyOntologyCommand(changed, { commandId: 'unsafe-undo', expectedRevision: changed.revision, actions: [
      { intent: 'undo_merge', recordId: 'zhang-a', expectedVersion: 2, mergeCommandId: 'merge-identities', sourceLabel: '用户确认' },
    ] }, t2)).toThrow(/impact changed/);
    expect(changed.records['zhang-b']).toMatchObject({ description: '后续已核对的新资料', version: 3 });
  });
  it('固定版本身份引用阻止合并；不会偷偷改写历史依据', () => {
    const initial = seed();
    const pinned = applyOntologyCommand(initial, { commandId: 'merge-pinned', expectedRevision: initial.revision, actions: [
      create('pin-source', { kind: 'reference', moduleId: 'projects', targetModuleId: 'people', targetRecordId: 'zhang-a', versionPolicy: 'pinned', targetVersion: 1 }),
    ] }, t2).document;
    expect(() => applyOntologyCommand(pinned, mergeCommand(pinned), t2)).toThrow(/pinned identity references/);
    expect(pinned.records['zhang-a'].status).toBe('active');
  });
  it('合并形成单值冲突时整批拒绝，不覆盖任何对象', () => {
    const initial = seed();
    const conflicting = applyOntologyCommand(initial, { commandId: 'merge-conflict', expectedRevision: initial.revision, actions: [
      create('other-department', { kind: 'assertion', moduleId: 'people', subjectId: 'zhang-b', definitionId: 'department-def',
        object: { kind: 'literal', valueType: 'text', value: '销售部' }, validity }),
    ] }, t2).document;
    expect(() => applyOntologyCommand(conflicting, mergeCommand(conflicting), t2)).toThrow(/overlapping facts/);
    expect(conflicting.records['zhang-a'].status).toBe('active');
    expect(fact(conflicting, 'department').subjectId).toBe('zhang-a');
  });
  it('合并要求确切双版本、身份依据及相同本体类型权限', () => {
    const doc = seed();
    const command = mergeCommand(doc);
    expect(() => applyOntologyCommand(doc, { ...command, actions: [{ ...command.actions[0], expectedTargetVersion: 2 }] }, t2)).toThrow(/target version changed/);
    expect(() => applyOntologyCommand(doc, { ...command, actions: [{ ...command.actions[0], sourceLabel: '同名' }] }, t2)).toThrow(/identity evidence/);
    expect(() => applyOntologyCommand(doc, { ...command, actions: [{ ...command.actions[0], targetId: 'project' }] }, t2)).toThrow(/same module/);
  });
  it('删除保留版本与来源，恢复重新校验；有有效依赖的身份不能直接删除', () => {
    const doc = seed();
    expect(() => applyOntologyCommand(doc, { commandId: 'delete-used-person', expectedRevision: doc.revision, actions: [
      { intent: 'delete', recordId: 'zhang-a', expectedVersion: 1, sourceLabel: '用户明确删除' },
    ] }, t2)).toThrow(/not available/);
    const deleted = applyOntologyCommand(doc, { commandId: 'delete-unused-person', expectedRevision: doc.revision, actions: [
      { intent: 'delete', recordId: 'zhang-b', expectedVersion: 1, sourceLabel: '用户明确删除' },
    ] }, t2).document;
    expect(deleted.records['zhang-b']).toMatchObject({ status: 'archived', version: 2 });
    expect(deleted.history.at(-1)).toMatchObject({ intent: 'delete', before: { status: 'active', version: 1 } });
    const restored = applyOntologyCommand(deleted, { commandId: 'restore-deleted-person', expectedRevision: deleted.revision, actions: [
      { intent: 'restore', recordId: 'zhang-b', expectedVersion: 2, sourceLabel: '用户确认恢复' },
    ] }, t2).document;
    expect(restored.records['zhang-b']).toMatchObject({ status: 'active', version: 3 });
  });
  it('同名人物保留不同身份，项目明确引用共同人物', () => {
    const doc = seed();
    expect(doc.records['zhang-a'].id).not.toBe(doc.records['zhang-b'].id);
    expect(queryOntologyFacts(doc, { moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', at: '2026-09-30' }).matched[0].object).toEqual({ kind: 'entity', id: 'zhang-a' });
    expect(queryOntologyFacts(doc, { moduleId: 'projects', subjectId: 'zhang-a', definitionId: 'department-def', at: '2026-09-30' }).matched[0].object).toEqual({ kind: 'literal', valueType: 'text', value: '产品部' });
    const command = seedCommand(); command.actions = command.actions.filter(a => a.intent !== 'create' || a.recordId !== 'ref-people');
    expect(() => applyOntologyCommand(emptyOntologyDocument(uid), command, t1)).toThrow(/not available/);
  });
  it('任务规则只按明确条件匹配；缺失任务信息标为未知，绝不代替任务引擎声称已执行', () => {
    let doc = seed();
    doc = applyOntologyCommand(doc, { commandId: 'report-rule', expectedRevision: doc.revision, actions: [create('report-rule', {
      kind: 'rule', moduleId: 'projects', name: '项目周报收件人', requirement: '周报发给负责人', strength: 'required',
      condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' }, effect: { kind: 'include_recipient', entityId: 'zhang-a' }, exception: '若项目负责人另有安排',
    })] }, t2).document;
    expect(queryOntologyRules(doc, { moduleId: 'projects', task: { at: '2026-10-05' } })).toMatchObject([{ match: 'unknown', rule: { strength: 'required' } }]);
    expect(queryOntologyRules(doc, { moduleId: 'projects', task: { at: '2026-10-05', purpose: 'weekly_report' } })).toMatchObject([{ match: 'matched', rule: { effect: { entityId: 'zhang-a' } } }]);
    expect(queryOntologyRules(doc, { moduleId: 'projects', task: { at: '2026-10-05', purpose: 'one_off_email' } })[0].match).toBe('not_matched');
  });
  it('负责人变更按左闭右开时间查询，并保留系统先前的认识', () => {
    const current = seed(), result = applyOntologyCommand(current, mutation('change'), t2);
    expect(fact(current, 'owner').validity.until).toBeNull();
    expect(fact(result.document, 'owner').validity.until).toBe('2026-10-01');
    expect(queryOntologyFacts(result.document, { moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', at: '2026-09-30' }).matched[0].object).toMatchObject({ id: 'zhang-a' });
    expect(queryOntologyFacts(result.document, { moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', at: '2026-10-01' }).matched[0].object).toMatchObject({ id: 'zhang-b' });
    expect(queryOntologyFacts(result.document, { moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', at: '2026-10-01', knownAt: t1 }).matched[0].object).toMatchObject({ id: 'zhang-a' });
    expect(queryOntologyFacts(result.document, { moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', at: '2026-10-01', knownRevision: 1 }).matched[0].object).toMatchObject({ id: 'zhang-a' });
  });
  it('固定引用保持所选对象旧版本，当前引用读取对象新版本', () => {
    const current = seed();
    const pinned = applyOntologyCommand(current, { commandId: 'pin-person', expectedRevision: 1, actions: [
      create('pinned-module', { kind: 'module', name: '固定快照测试', description: '', scope: { kind: 'workspace', id: 'ws-1' } }),
      create('pinned-person', { kind: 'reference', moduleId: 'pinned-module', targetModuleId: 'people', targetRecordId: 'zhang-a', targetVersion: 1, versionPolicy: 'pinned' }),
    ] }, t2).document;
    const updated = applyOntologyCommand(pinned, { commandId: 'rename-person', expectedRevision: 2, actions: [{ intent: 'update', recordId: 'zhang-a', expectedVersion: 1,
      patch: { name: '示例同名成员（新姓名）' }, sourceLabel: '用户确认' }] }, t2).document;
    expect(resolveOntologyRecordForModule(updated, 'pinned-module', 'zhang-a')?.kind === 'entity'
      ? (resolveOntologyRecordForModule(updated, 'pinned-module', 'zhang-a') as Extract<OntologyRecord, { kind: 'entity' }>).name : '').toBe('示例同名成员');
    expect(resolveOntologyRecordForModule(updated, 'projects', 'zhang-a')?.kind === 'entity'
      ? (resolveOntologyRecordForModule(updated, 'projects', 'zhang-a') as Extract<OntologyRecord, { kind: 'entity' }>).name : '').toBe('示例同名成员（新姓名）');
  });
  it('纠错保留原记录，但不再把错误事实作为有效答案', () => {
    const result = applyOntologyCommand(seed(), mutation('correct'), t2);
    expect(fact(result.document, 'owner').status).toBe('corrected');
    expect(queryOntologyFacts(result.document, { moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', at: '2026-09-30' }).matched[0].object).toMatchObject({ id: 'zhang-b' });
    expect(queryOntologyFacts(result.document, { moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', at: '2026-09-30', knownAt: t1 }).matched[0].object).toMatchObject({ id: 'zhang-a' });
    expect(result.document.history.some(h => h.intent === 'mark_corrected' && h.before?.id === 'owner')).toBe(true);
  });
  it('多个周报接收人合法，两个同时有效的负责人拒绝整批写入', () => {
    const current = seed();
    const records = ['zhang-a', 'zhang-b'].map((id, index) => create('recipient-' + index, { ...fact(current, 'owner'), id: undefined, version: undefined, source: undefined, createdAt: undefined, updatedAt: undefined, definitionId: 'recipient-def', object: { kind: 'entity', id } }));
    // 元数据属于服务；构造用户可提交的事实部分。
    records.forEach(a => { for (const key of ['id', 'version', 'status', 'access', 'source', 'createdAt', 'updatedAt']) delete a.record[key]; });
    const result = applyOntologyCommand(current, { commandId: 'recipients', expectedRevision: 1, actions: records }, t2);
    expect(queryOntologyFacts(result.document, { moduleId: 'projects', definitionId: 'recipient-def', at: '2026-10-05' }).matched).toHaveLength(2);
    records[0].record.definitionId = 'owner-def'; records[0].record.object = { kind: 'entity', id: 'zhang-b' };
    expect(() => applyOntologyCommand(current, { commandId: 'bad-owner', expectedRevision: 1, actions: records }, t2)).toThrow(/overlapping facts/);
    expect(current.revision).toBe(1); expect(current.records['recipient-0']).toBeUndefined();
  });
  it('没有确认开始时间的事实保留为不确定，不替用户猜日期', () => {
    const current = seed();
    const result = applyOntologyCommand(current, { commandId: 'unknown-start', expectedRevision: 1, actions: [create('unknown', { kind: 'assertion', moduleId: 'projects', subjectId: 'project', definitionId: 'recipient-def', object: { kind: 'entity', id: 'zhang-b' }, validity: { ...validity, from: null } })] }, t2);
    const facts = queryOntologyFacts(result.document, { moduleId: 'projects', definitionId: 'recipient-def', at: '2026-10-05' });
    expect(facts.matched).toHaveLength(0); expect(facts.uncertain).toHaveLength(1);
  });
  it('旧基线、错类型和未知身份不能覆盖有效记录', () => {
    const current = seed();
    expect(() => applyOntologyCommand(current, { ...mutation('change'), expectedRevision: 0 }, t2)).toThrow(/changed since/);
    expect(() => applyOntologyCommand(current, { commandId: 'bad-type', expectedRevision: 1, actions: [{ ...mutation('correct').actions[0], object: { kind: 'entity', id: 'project' } }] }, t2)).toThrow(/type mismatch/);
    expect(() => applyOntologyCommand(current, { commandId: 'unclear', expectedRevision: 1, actions: [{ intent: 'update', recordId: 'zhang-a', expectedVersion: 1, patch: { identityStatus: 'unresolved' }, sourceLabel: '尚未确认' }] }, t2)).toThrow(/unresolved/);
  });
  it('重试命令返回相同回执，复用命令ID提交不同内容会拒绝', () => {
    const command = mutation('change'), result = applyOntologyCommand(seed(), command, t2);
    const retry = applyOntologyCommand(result.document, { actions: command.actions, expectedRevision: 1, commandId: 'change' }, t2);
    expect(retry.duplicate).toBe(true); expect(retry.receipt).toEqual(result.receipt);
    expect(() => applyOntologyCommand(result.document, { ...command, expectedRevision: 2 }, t2)).toThrow(/reused/);
  });
  it('本次安排不被接受为长期修改命令，非法日期也不会落地', () => {
    expect(() => applyOntologyCommand(seed(), { commandId: 'local', expectedRevision: 1, actions: [{ intent: 'task_override' }] }, t2)).toThrow(/invalid ontology command/);
    const command = mutation('change'); command.actions[0].effectiveFrom = '2026-02-30';
    expect(() => applyOntologyCommand(seed(), command, t2)).toThrow(/change date/);
  });
});

let root: string, previousRoot: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-domain-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });
describe('主档持久化与保护', () => {
  it('读取空库不写文件，提交后重载保留三盒领域，重复提交不写文件', async () => {
    const service = await import('../../../src/main/features/cognition/ontology/service');
    expect(service.readOntologyDocument(uid).revision).toBe(0);
    const store = await import('../../../src/main/features/cognition_kernel/store');
    expect(fs.existsSync(store.cognitionStorePath(uid))).toBe(false);
    await service.commitOntologyCommand(uid, seedCommand());
    const filename = store.cognitionStorePath(uid), original = fs.readFileSync(filename, 'utf8');
    expect(service.readOntologyDocument(uid).records['owner'].kind).toBe('assertion');
    expect((await service.commitOntologyCommand(uid, seedCommand())).duplicate).toBe(true);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    await store.editCognitionCompatibility(uid, doc => { doc.appliedDeltas['other-operation'] = true; doc.appliedOrder.push('other-operation'); });
    expect(service.readOntologyDocument(uid).records['zhang-b'].kind).toBe('entity');
  });
  it('两个相同基线并发提交仅一个成功，失败不会留下部分记录', async () => {
    const service = await import('../../../src/main/features/cognition/ontology/service');
    await service.commitOntologyCommand(uid, seedCommand());
    const update = (commandId: string) => ({ commandId, expectedRevision: 1, actions: [{ intent: 'update', recordId: 'project', expectedVersion: 1, patch: { description: commandId }, sourceLabel: '并发编辑' }] });
    const results = await Promise.allSettled([service.commitOntologyCommand(uid, update('writer-a')), service.commitOntologyCommand(uid, update('writer-b'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(service.readOntologyDocument(uid).revision).toBe(2);
  });
  it('损坏本体拒读拒写，不用空档覆盖原文件', async () => {
    const service = await import('../../../src/main/features/cognition/ontology/service');
    const store = await import('../../../src/main/features/cognition_kernel/store');
    const filename = store.cognitionStorePath(uid);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const raw = JSON.stringify({ schemaVersion: 1, objects: {}, ontology: { schemaVersion: 1, ownerId: uid, revision: 0, records: { broken: {} }, history: [], receipts: {} } });
    fs.writeFileSync(filename, raw);
    expect(() => service.readOntologyDocument(uid)).toThrow(/unreadable/);
    await expect(service.commitOntologyCommand(uid, seedCommand())).rejects.toMatchObject({ code: 'store_corrupt' });
    expect(fs.readFileSync(filename, 'utf8')).toBe(raw);
  });
});

describe('旧内容只读兼容', () => {
  it('把旧图谱和个人字段显示为带来源的三盒投影，不迁移、改写或泄漏仅自己可见的值', async () => {
    const graph = await import('../../../src/main/features/ontology_graph');
    const category = await graph.createOntologyCategory(uid, { domain: 'resources', name: '团队成员', description: '旧分类', fields: [{ name: '角色', kind: 'text' }] });
    const person = await graph.createOntologyEntity(uid, { categoryId: category.id, name: '示例成员乙', description: '', properties: {}, sourceRefs: [] });
    const relation = await graph.createOntologyRelation(uid, { subject: { kind: 'self' }, predicate: '认识', object: { kind: 'entity', id: person.id }, note: '', sourceRefs: [] });
    const graphPath = path.join(root, uid, 'cloud', 'cognition', 'ontology-graph.json');
    const graphBytes = fs.readFileSync(graphPath, 'utf8');
    const poPath = path.join(root, uid, 'cloud', 'cognition', 'personal-ontology.json');
    const po = { schemaVersion: 2, groups: [{ id: 'profile-group', title: '个人资料', kind: 'user', fields: [
      { id: 'dept-field', name: '部门', origin: 'user', createdAt: '2026-09-01T00:00:00' },
      { id: 'timezone-field', name: '时区', origin: 'user', createdAt: '2026-09-01T00:00:00' },
    ], values: [
      { id: 'private-dept', fieldId: 'dept-field', text: '研发部', source: 'manual', restricted: true, createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00' },
      { id: 'public-zone', fieldId: 'timezone-field', text: 'Asia/Shanghai', source: 'manual', asOf: '2026-09', createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00' },
    ], entries: [], createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00' },
    { id: 'notes-only-group', title: '未整理记录', kind: 'user', fields: [], values: [],
      entries: [{ id: 'entry-note', text: '项目交付记录：周五安排复盘。', createdAt: '2026-09-02T00:00:00' }],
      createdAt: '2026-09-02T00:00:00', updatedAt: '2026-09-02T00:00:00' },
    ], trash: [] };
    fs.mkdirSync(path.dirname(poPath), { recursive: true }); fs.writeFileSync(poPath, JSON.stringify(po));
    const poBytes = fs.readFileSync(poPath, 'utf8');

    const { readOntologyWithLegacyView } = await import('../../../src/main/features/cognition/ontology/legacy-view');
    const view = await readOntologyWithLegacyView(emptyOntologyDocument(uid), uid);
    const legacyEntity = Object.values(view.records).find(r => r.kind === 'entity' && r.source.recordId === person.id);
    expect(legacyEntity).toBeDefined();
    expect(legacyEntity).toMatchObject({ name: '示例成员乙', source: { kind: 'legacy' }, createdAt: null, updatedAt: null });
    expect(Object.values(view.records).some(r => r.kind === 'assertion' && r.source.recordId === relation.id)).toBe(true);
    const noteModule = Object.values(view.records).find(r => r.kind === 'module' && r.source.recordId === 'notes-only-group');
    const noteEntry = Object.values(view.records).find(r => r.kind === 'entity' && r.source.label === '旧个人本体自由文本条目');
    expect(noteModule?.kind).toBe('module');
    expect(noteModule?.kind === 'module' && noteModule.description).toBe('');
    expect(noteEntry).toMatchObject({ kind: 'entity', moduleId: noteModule?.id, access: 'owner_only',
      description: '项目交付记录：周五安排复盘。', source: { kind: 'legacy' } });
    const legacyModule = Object.values(view.records).find(r => r.kind === 'module' && r.source.recordId === 'profile-group');
    expect(legacyModule?.kind).toBe('module');
    expect(legacyModule?.kind === 'module' && legacyModule.description).toBe('');
    const facts = queryOntologyFacts(view, { moduleId: legacyModule!.id, at: '2026-10-05' });
    expect(facts.matched.map(row => (row.object.kind === 'literal' ? row.object.value : row.object.id))).toContain('Asia/Shanghai');
    expect(facts.matched.some(row => row.source.recordId === 'private-dept')).toBe(false);
    expect(Object.values(view.records).some(r => r.kind === 'assertion' && r.source.recordId === 'private-dept' && r.access === 'owner_only')).toBe(true);
    const store = await import('../../../src/main/features/cognition_kernel/store');
    expect(fs.existsSync(store.cognitionStorePath(uid))).toBe(false);
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(graphBytes);
    expect(fs.readFileSync(poPath, 'utf8')).toBe(poBytes);
  });
});


describe('停用恢复仍走语义校验', () => {
  it('恢复停用事实产生新版本，并在当前单值冲突时拒绝整批提交', () => {
    const initial = seed();
    const archived = applyOntologyCommand(initial, { commandId: 'archive-fact', expectedRevision: initial.revision, actions: [{ intent: 'archive', recordId: 'owner', expectedVersion: 1, sourceLabel: '验收停用' }] }, t2).document;
    const restored = applyOntologyCommand(archived, { commandId: 'restore-fact', expectedRevision: archived.revision, actions: [{ intent: 'restore', recordId: 'owner', expectedVersion: 2, sourceLabel: '验收恢复' }] }, t2).document;
    expect(restored.records.owner).toMatchObject({ status: 'active', version: 3 });
    expect(restored.history.at(-1)?.intent).toBe('restore');
    const replacement = applyOntologyCommand(archived, { commandId: 'replacement-fact', expectedRevision: archived.revision, actions: [create('other-owner', { kind: 'assertion', moduleId: 'projects', subjectId: 'project', definitionId: 'owner-def', object: { kind: 'entity', id: 'zhang-b' }, validity })] }, t2).document;
    expect(() => applyOntologyCommand(replacement, { commandId: 'restore-conflict', expectedRevision: replacement.revision, actions: [{ intent: 'restore', recordId: 'owner', expectedVersion: 2, sourceLabel: '恢复' }] }, t2)).toThrow();
    expect(replacement.records.owner.status).toBe('archived');
  });
});

describe('本体卡片生命周期持久化', () => {
  it('正式本体删除保留历史，拒绝旧版本，恢复后可再次归档', async () => {
    const service = await import('../../../src/main/features/cognition/ontology/service');
    await service.commitOntologyCommand(uid, { commandId: 'module-seed', expectedRevision: 0,
      actions: [create('mod-card', { kind: 'module', name: '卡片本体', description: '', scope: { kind: 'personal' }, access: 'task' })] });
    const input = { moduleId: 'mod-card', intent: 'delete' as const, expectedRevision: 1, expectedVersion: 1 };
    const result = await service.changeOntologyModuleLifecycle(uid, input);
    expect(result.receipt.changedIds).toContain('mod-card');
    expect(service.readOntologyDocument(uid).records['mod-card'].status).toBe('archived');
    await expect(service.changeOntologyModuleLifecycle(uid, input)).rejects.toThrow(/revision changed/);
    await service.changeOntologyModuleLifecycle(uid, { ...input, intent: 'restore', expectedRevision: 2, expectedVersion: 2 });
    expect(service.readOntologyDocument(uid).records['mod-card'].status).toBe('active');
    await service.changeOntologyModuleLifecycle(uid, { ...input, intent: 'archive', expectedRevision: 3, expectedVersion: 3 });
    expect(service.readOntologyDocument(uid).history.map(row => row.intent)).toEqual(['create', 'delete', 'restore', 'archive']);
  });
  it('旧来源归档/恢复持久化，刷新不复活，也不改写原始资料', async () => {
    const graph = await import('../../../src/main/features/ontology_graph');
    await graph.createOntologyCategory(uid, { domain: 'resources', name: '旧卡片', description: '', fields: [] });
    const file = path.join(root, uid, 'cloud', 'cognition', 'ontology-graph.json');
    const original = fs.readFileSync(file, 'utf8');
    const service = await import('../../../src/main/features/cognition/ontology/service');
    const view = await service.readOntologyView(uid);
    const id = 'legacy-ontology-graph';
    expect(view.records[id].status).toBe('active');
    await service.changeOntologyModuleLifecycle(uid, { moduleId: id, intent: 'archive', expectedRevision: view.revision, expectedVersion: 1 });
    let after = await service.readOntologyView(uid);
    expect(after.records[id]).toMatchObject({ status: 'archived', version: 2, source: { kind: 'legacy' } });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    await service.changeOntologyModuleLifecycle(uid, { moduleId: id, intent: 'restore', expectedRevision: after.revision, expectedVersion: 2 });
    after = await service.readOntologyView(uid);
    expect(after.records[id].status).toBe('active');
    await service.changeOntologyModuleLifecycle(uid, { moduleId: id, intent: 'delete', expectedRevision: after.revision, expectedVersion: 3 });
    expect((await service.readOntologyView(uid)).records[id].status).toBe('archived');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});
