import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/features/recall/store-events', () => ({
  notifyCognitionWrite: vi.fn(),
}));

const UID = 'test-user-meeting-ontology';
let tmpDir: string;
let workspace: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-host-'));
  workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  const graph = await import('../../../src/main/features/ontology_graph');
  const adapter = await import('../../../src/main/features/meeting_ontology_projection');
  return { graph, adapter };
}

function scope(roots: string[] = [workspace]) {
  return { userId: UID, roots, workingDir: workspace };
}

function writeRecord(name: string, record: unknown): string {
  fs.writeFileSync(path.join(workspace, name), JSON.stringify(record), 'utf8');
  return name;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'meeting_record.v1',
    meeting: { ref: 'tm-rec-001', title: '认知资产评审会', date: '2026-10-12', minutes_version: 'v002', confirmed: true },
    participants: [{ name: '周岚' }, { name: '王伟' }],
    decisions: [
      { id: 'D1', text: '先完成连接验证，验证通过后再发布', source_refs: ['原始转写 v001 · U0003'] },
      { id: 'D2', text: '录制权限由周岚申请', source_refs: ['原始转写 v001 · U0007'] },
    ],
    open_questions: [{ id: 'Q1', text: '空间知识库是否参与检索？', status: 'open', source_refs: ['原始转写 v001 · U0010'] }],
    action_items: [{ id: 'A1', text: '申请录制权限', owner_text: '周岚', deadline_text: '本周五', status: 'clue', derived_from: ['D2'], source_refs: ['原始转写 v001 · U0007'] }],
    ...overrides,
  };
}

async function apply(adapter: Awaited<ReturnType<typeof load>>['adapter'], file: string, roots?: string[]) {
  const result = await adapter.runMeetingOntologyTool('ontology_projection_apply', { record_path: file }, scope(roots));
  return { result, body: result.isError ? null : JSON.parse(result.content) };
}

describe('meeting ontology projection', () => {
  it('projects a confirmed record into meeting-owned categories with fixed relations, then re-applies idempotently', async () => {
    const { graph, adapter } = await load();
    const first = await apply(adapter, writeRecord('r.json', record()));
    expect(first.result.isError).toBeFalsy();
    expect(first.body.entities).toEqual({ created: 5, updated: 0, unchanged: 0, archived: 0 });
    expect(first.body.relations.created).toBe(5); // 2×作出决议, 提出问题, 产生行动项, 派生自

    const snapshot = await graph.readOntologyGraph(UID);
    const names = new Map(snapshot.categories.map((category) => [category.id, category.name]));
    const meeting = snapshot.entities.find((entity) => names.get(entity.categoryId) === '会议记录');
    expect(meeting?.name).toBe('认知资产评审会');
    const meetingCategory = snapshot.categories.find((category) => category.name === '会议记录');
    expect(meetingCategory?.parentId).toBe('builtin_affairs_event');
    expect(snapshot.categories.find((category) => category.name === '团队成员')?.parentId).toBe('builtin_resource_person');
    expect(snapshot.relations.map((relation) => relation.predicate).sort())
      .toEqual(['产生行动项', '作出决议', '作出决议', '提出问题', '派生自'].sort());

    const again = await apply(adapter, 'r.json');
    expect(again.body.entities).toEqual({ created: 0, updated: 0, unchanged: 5, archived: 0 });
    expect(again.body.relations).toEqual({ created: 0, existing: 5 });
    expect((await graph.readOntologyGraph(UID)).entities).toHaveLength(5);
  });

  it('archives items dropped by a revised minutes version and keeps user-added properties', async () => {
    const { graph, adapter } = await load();
    await apply(adapter, writeRecord('r.json', record()));
    let snapshot = await graph.readOntologyGraph(UID);
    const decisionCategory = snapshot.categories.find((category) => category.name === '会议决议')!;
    await graph.updateOntologyCategory(UID, { categoryId: decisionCategory.id, fields: [...decisionCategory.fields, { name: '用户备注' }] });
    snapshot = await graph.readOntologyGraph(UID);
    const noteField = snapshot.categories.find((category) => category.id === decisionCategory.id)!.fields.find((field) => field.name === '用户备注')!;
    const d1 = snapshot.entities.find((entity) => entity.name.startsWith('先完成连接验证'))!;
    await graph.updateOntologyEntity(UID, { entityId: d1.id, properties: { ...d1.properties, [noteField.id]: '已同步给产品' } });

    const revised = record({
      meeting: { ref: 'tm-rec-001', title: '认知资产评审会', minutes_version: 'v003', confirmed: true },
      decisions: [{ id: 'D1', text: '先完成连接验证，验证通过后再发布（含回归）', source_refs: ['原始转写 v001 · U0003'] }],
      action_items: [],
    });
    const second = await apply(adapter, writeRecord('r3.json', revised));
    expect(second.body.entities.archived).toBe(2); // D2 and A1
    snapshot = await graph.readOntologyGraph(UID);
    const archived = snapshot.entities.filter((entity) => entity.status === 'archived').map((entity) => entity.name).sort();
    expect(archived).toEqual(['录制权限由周岚申请', '申请录制权限']);
    const updatedD1 = snapshot.entities.find((entity) => entity.id === d1.id)!;
    expect(updatedD1.name).toContain('含回归');
    expect(updatedD1.properties[noteField.id]).toBe('已同步给产品');
    expect(snapshot.entities).toHaveLength(5); // nothing deleted
  });

  it('links people, projects and series only through ids in the expected category family', async () => {
    const { graph, adapter } = await load();
    await apply(adapter, writeRecord('seed.json', record({ decisions: [], open_questions: [], action_items: [] })));
    let snapshot = await graph.readOntologyGraph(UID);
    const member = snapshot.categories.find((category) => category.name === '团队成员')!;
    const series = snapshot.categories.find((category) => category.name === '会议系列')!;
    const zhou = await graph.createOntologyEntity(UID, { categoryId: member.id, name: '周岚' });
    const project = await graph.createOntologyEntity(UID, { categoryId: 'builtin_affairs_project', name: '认知资产' });
    const weekly = await graph.createOntologyEntity(UID, { categoryId: series.id, name: '认知资产周会' });
    const tool = await graph.createOntologyEntity(UID, { categoryId: 'builtin_resource_tool', name: '腾讯会议' });

    const linked = record({
      meeting: { ref: 'tm-rec-001', title: '认知资产评审会', minutes_version: 'v002', confirmed: true, project_entity_id: project.id, series_entity_id: weekly.id },
      participants: [{ name: '周岚', entity_id: zhou.id }, { name: '王伟', entity_id: tool.id }],
      action_items: [{ id: 'A1', text: '申请录制权限', owner_entity_id: zhou.id, derived_from: ['D2'], source_refs: [] }],
    });
    const { body } = await apply(adapter, writeRecord('linked.json', linked));
    expect(body.skipped).toEqual([expect.objectContaining({ item: 'participant:王伟' })]);
    snapshot = await graph.readOntologyGraph(UID);
    const predicates = snapshot.relations.map((relation) => relation.predicate);
    expect(predicates).toEqual(expect.arrayContaining(['参与', '指派给', '属于项目', '属于系列']));
    expect(snapshot.relations.some((relation) => relation.object.kind === 'entity' && relation.object.id === tool.id)).toBe(false);
    expect(snapshot.relations.some((relation) => relation.subject.kind === 'entity' && relation.subject.id === tool.id)).toBe(false);
  });

  it('creates only user-confirmed people, series and projects, links them, and reuses them on re-run', async () => {
    const { graph, adapter } = await load();
    const proposed = record({
      meeting: { ref: 'tm-rec-001', title: '认知资产评审会', minutes_version: 'v002', confirmed: true, series_new_entity: 'N3', project_new_entity: 'N4' },
      participants: [{ name: '周岚', new_entity: 'N1' }, { name: '王伟', new_entity: 'N2' }],
      action_items: [{ id: 'A1', text: '申请录制权限', owner_new_entity: 'N1', derived_from: ['D2'], source_refs: ['原始转写 v001 · U0007'] }],
      new_entities: [
        { key: 'N1', kind: 'member', name: '周岚', aliases: ['小周'], tencent_account: '周岚', confirmed: true },
        { key: 'N2', kind: 'member', name: '王伟', aliases: [], confirmed: false },
        { key: 'N3', kind: 'series', name: '认知资产评审会', aliases: ['评审会'], confirmed: true },
        { key: 'N4', kind: 'project', name: '认知资产', aliases: [], confirmed: true },
      ],
    });
    const first = await apply(adapter, writeRecord('proposed.json', proposed));
    expect(first.result.isError).toBeFalsy();
    expect(first.body.skeleton).toEqual({ created: 3, reused: 0 });
    expect(first.body.skipped).toEqual([expect.objectContaining({ item: 'participant:王伟', reason: 'new entity N2 was not confirmed' })]);

    let snapshot = await graph.readOntologyGraph(UID);
    const byName = (name: string) => snapshot.entities.find((entity) => entity.name === name)!;
    const member = snapshot.categories.find((category) => category.name === '团队成员')!;
    const zhou = byName('周岚');
    expect(zhou.categoryId).toBe(member.id);
    expect(zhou.properties[member.fields.find((field) => field.name === '别名')!.id]).toBe('小周');
    expect(zhou.properties[member.fields.find((field) => field.name === '腾讯会议账号')!.id]).toBe('周岚');
    expect(byName('认知资产').categoryId).toBe('builtin_affairs_project');
    expect(snapshot.entities.some((entity) => entity.name === '王伟')).toBe(false);
    const predicates = snapshot.relations.map((relation) => relation.predicate);
    expect(predicates).toEqual(expect.arrayContaining(['参与', '指派给', '属于系列', '属于项目']));

    const again = await apply(adapter, 'proposed.json');
    expect(again.body.skeleton).toEqual({ created: 0, reused: 3 });
    snapshot = await graph.readOntologyGraph(UID);
    expect(snapshot.entities.filter((entity) => entity.name === '周岚')).toHaveLength(1);
  });

  it('rejects references to proposals of the wrong kind or unknown keys', async () => {
    const { adapter } = await load();
    const wrongKind = record({
      meeting: { ref: 'tm-rec-001', title: 't', minutes_version: 'v001', confirmed: true, series_new_entity: 'N1' },
      new_entities: [{ key: 'N1', kind: 'member', name: '周岚', confirmed: true }],
    });
    expect((await apply(adapter, writeRecord('w.json', wrongKind))).result.content).toMatch(/series_new_entity must reference a series/);
    const unknown = record({ participants: [{ name: '周岚', new_entity: 'N9' }] });
    expect((await apply(adapter, writeRecord('u.json', unknown))).result.content).toMatch(/must reference a member entry/);
  });

  it('marks a prior open question resolved when a later meeting records the resolving decision', async () => {
    const { graph, adapter } = await load();
    await apply(adapter, writeRecord('first.json', record()));
    const later = record({
      meeting: { ref: 'tm-rec-002', title: '认知资产评审会（第二次）', minutes_version: 'v001', confirmed: true },
      decisions: [{ id: 'D1', text: '空间知识库暂不参与检索', source_refs: [] }],
      open_questions: [],
      action_items: [],
      resolves: [{ prior_meeting_ref: 'tm-rec-001', prior_item_id: 'Q1', by: 'D1' }, { prior_meeting_ref: 'tm-rec-000', prior_item_id: 'Q9', by: 'D1' }],
    });
    const { body } = await apply(adapter, writeRecord('later.json', later));
    expect(body.skipped).toEqual([expect.objectContaining({ item: 'resolves:meeting:tm-rec-000#Q9' })]);
    const snapshot = await graph.readOntologyGraph(UID);
    const questionCategory = snapshot.categories.find((category) => category.name === '会议未决问题')!;
    const statusField = questionCategory.fields.find((field) => field.name === '状态')!;
    const question = snapshot.entities.find((entity) => entity.categoryId === questionCategory.id)!;
    expect(question.properties[statusField.id]).toBe('已解决');
    expect(snapshot.relations.filter((relation) => relation.predicate === '解决了')).toHaveLength(1);
  });

  it('rejects unconfirmed records, unknown references and paths outside the Runtime scope without writing', async () => {
    const { graph, adapter } = await load();
    const unconfirmed = await apply(adapter, writeRecord('u.json', record({ meeting: { ref: 'tm-rec-001', title: 't', minutes_version: 'v001', confirmed: false } })));
    expect(unconfirmed.result.content).toMatch(/^\[E_ONTOLOGY_RECORD_INVALID\].*confirmed/);
    const badRef = await apply(adapter, writeRecord('b.json', record({ action_items: [{ id: 'A1', text: 'x', derived_from: ['D9'] }] })));
    expect(badRef.result.content).toMatch(/unknown decision D9/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'r.json'), JSON.stringify(record()), 'utf8');
      const escaped = await apply(adapter, path.join(outside, 'r.json'));
      expect(escaped.result.content).toMatch(/^\[E_PATH_OUT_OF_SCOPE\]/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    const snapshot = await graph.readOntologyGraph(UID);
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.categories.every((category) => category.builtIn)).toBe(true);
  });

  it('reports untraceable sources and unlinked action items as warnings without blocking the projection', async () => {
    const { adapter } = await load();
    const vague = record({
      meeting: { ref: 'tm-rec-009', title: '模糊出处会', minutes_version: 'v001', minutes_file: '会议纪要_已确认_v001.md', confirmed: true },
      decisions: [{ id: 'D1', text: '明日交付试用', source_refs: ['tm-rec-009 · 转写片段'] }],
      open_questions: [{ id: 'Q1', text: '知识库是否支持编辑？' }],
      action_items: [
        { id: 'A1', text: '完成词表', derived_from: [], source_refs: ['tm-rec-009 · p4'] },
        { id: 'A2', text: '同步试用名单', derived_from: ['D1'], source_refs: ['tm-rec-009 · U0012 · 00:03:10'] },
      ],
    });
    const { result, body } = await apply(adapter, writeRecord('vague.json', vague));
    expect(result.isError).toBeFalsy();
    expect(body.entities.created).toBe(5);
    expect(body.warnings).toEqual([
      'D1: source reference lacks a segment id',
      'Q1: no source reference',
      'A1: not linked to any decision (derived_from is empty)',
      'meeting.minutes_file is not an absolute path',
    ]);
    const clean = await apply(adapter, writeRecord('clean.json', record()));
    expect(clean.body.warnings).toEqual([]);
  });

  it('refuses a reused meeting ref that belongs to a meeting on another date', async () => {
    const { graph, adapter } = await load();
    await apply(adapter, writeRecord('first.json', record()));
    const next = record({ meeting: { ref: 'tm-rec-001', title: '认知资产评审会', date: '2026-10-19', minutes_version: 'v001', confirmed: true } });
    const { result } = await apply(adapter, writeRecord('next.json', next));
    expect(result.content).toMatch(/^\[E_ONTOLOGY_MEETING_REF_CONFLICT\]/);
    expect((await graph.readOntologyGraph(UID)).entities.filter((entity) => entity.status === 'archived')).toEqual([]);
  });

  it('refuses to write into a same-named user category that lacks the record-key field', async () => {
    const { graph, adapter } = await load();
    await graph.createOntologyCategory(UID, { domain: 'affairs', name: '会议记录', parentId: 'builtin_affairs_event', fields: ['主持人'] });
    const { result } = await apply(adapter, writeRecord('r.json', record()));
    expect(result.content).toMatch(/^\[E_ONTOLOGY_CATEGORY_CONFLICT\]/);
    expect((await graph.readOntologyGraph(UID)).entities).toEqual([]);
  });
});

describe('meeting ontology graph read', () => {
  it('filters by ancestor category and returns one-hop neighbours for an entity', async () => {
    const { graph, adapter } = await load();
    await apply(adapter, writeRecord('r.json', record({ decisions: [], open_questions: [], action_items: [] })));
    const member = (await graph.readOntologyGraph(UID)).categories.find((category) => category.name === '团队成员')!;
    const alias = member.fields.find((field) => field.name === '别名')!;
    const zhou = await graph.createOntologyEntity(UID, { categoryId: member.id, name: '周岚', properties: { [alias.id]: '小周' } });
    await graph.createOntologyEntity(UID, { categoryId: 'builtin_resource_person', name: '李强' });
    const archived = await graph.createOntologyEntity(UID, { categoryId: 'builtin_resource_person', name: '离职同事' });
    await graph.updateOntologyEntity(UID, { entityId: archived.id, status: 'archived' });

    const people = JSON.parse((await adapter.runMeetingOntologyTool('ontology_graph_read', { category: '人物' }, scope())).content);
    expect(people.entities.map((entity: { name: string }) => entity.name).sort()).toEqual(['周岚', '李强']);
    const byAlias = JSON.parse((await adapter.runMeetingOntologyTool('ontology_graph_read', { query: '小周' }, scope())).content);
    expect(byAlias.entities).toEqual([expect.objectContaining({ id: zhou.id, category: '人物 > 团队成员', properties: { 别名: '小周' } })]);

    const meeting = (await graph.readOntologyGraph(UID)).entities.find((entity) => entity.name === '认知资产评审会')!;
    await graph.createOntologyRelation(UID, { subject: { kind: 'entity', id: zhou.id }, predicate: '参与', object: { kind: 'entity', id: meeting.id } });
    const hood = JSON.parse((await adapter.runMeetingOntologyTool('ontology_graph_read', { entity_id: zhou.id }, scope())).content);
    expect(hood.neighbours.map((entity: { name: string }) => entity.name)).toEqual(['认知资产评审会']);
    expect(hood.relations).toEqual([expect.objectContaining({ predicate: '参与', subject: expect.objectContaining({ name: '周岚' }) })]);

    const bad = await adapter.runMeetingOntologyTool('ontology_graph_read', { domain: 'people' }, scope());
    expect(bad).toEqual({ content: expect.stringMatching(/^\[E_ONTOLOGY_INPUT\]/), isError: true });
  });
});
