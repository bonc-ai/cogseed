import { describe, expect, it } from 'vitest';
import { emptyOntologyDocument, type OntologyDocument } from '../../../src/main/features/cognition/ontology/model';
import { queryOntologyGraph } from '../../../src/main/features/cognition/ontology/query';

function graphDocument(entityCount: number, assertionCount: number): OntologyDocument {
  const doc = emptyOntologyDocument('ontology-graph-test-user');
  const moduleId = 'graph-module';
  const common = { version: 1, status: 'active' as const, access: 'task' as const, createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', source: { kind: 'user' as const, label: 'test' } };
  const module = { ...common, id: moduleId, kind: 'module' as const, name: '关系较多的本体', description: '', scope: { kind: 'personal' as const } };
  const typeId = 'graph-person-type';
  const relationId = 'graph-related-to';
  doc.records[moduleId] = module;
  doc.records[typeId] = { ...common, id: typeId, kind: 'definition', moduleId, name: '人物', description: '', definitionKind: 'type',
    subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' };
  doc.records[relationId] = { ...common, id: relationId, kind: 'definition', moduleId, name: '关联对象', description: '', definitionKind: 'relation',
    subjectTypes: [typeId], objectTypes: [typeId], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' };
  const entities = Array.from({ length: entityCount }, (_, index) => {
    const id = `graph-person-${String(index).padStart(4, '0')}`;
    doc.records[id] = { ...common, id, kind: 'entity', moduleId, typeId, name: `人物${index}`, description: '', aliases: [], identityStatus: 'confirmed' };
    return id;
  });
  for (let index = 0; index < assertionCount; index++) {
    const subjectId = entities[index % entities.length], objectId = entities[(index + 1) % entities.length];
    const id = `graph-assertion-${String(index).padStart(4, '0')}`;
    doc.records[id] = { ...common, id, kind: 'assertion', moduleId, subjectId, definitionId: relationId,
      object: { kind: 'entity', id: objectId }, validity: { from: null, until: null, precision: 'day', timezone: 'UTC' } };
  }
  return doc;
}

describe('本体图谱输出边界', () => {
  it('大本体优先保留关联度高的节点，并明确报告裁剪且不留下悬空连线', () => {
    const projection = queryOntologyGraph(graphDocument(340, 340), { moduleId: 'graph-module', at: '2026-10-05' });
    const visibleIds = new Set(projection.nodes.map(node => node.id));
    expect(projection.truncated).toBe(true);
    expect(projection.nodes).toHaveLength(220);
    expect(projection.totalNodes).toBeGreaterThan(projection.nodes.length);
    expect(projection.nodes.some(node => node.id === 'graph-person-type')).toBe(true);
    expect(projection.edges.every(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to))).toBe(true);
  });

  it('节点都可见但连线超限时限制传输量并保留未知有效期标记', () => {
    const projection = queryOntologyGraph(graphDocument(20, 501), { moduleId: 'graph-module', at: '2026-10-05' });
    expect(projection.nodes).toHaveLength(22);
    expect(projection.totalEdges).toBeGreaterThan(projection.edges.length);
    expect(projection.edges).toHaveLength(500);
    expect(projection.truncated).toBe(true);
    expect(projection.edges.some(edge => edge.truth === 'unknown')).toBe(true);
  });

  it('按确切对象或事实聚焦其邻接关系，并返回能打开详情的来源记录ID', () => {
    const doc = graphDocument(8, 8);
    const focusedNode = queryOntologyGraph(doc, { moduleId: 'graph-module', at: '2026-10-05', focusId: 'graph-person-0003' });
    expect(focusedNode.focusId).toBe('graph-person-0003');
    expect(focusedNode.focusNodeId).toBe('graph-person-0003');
    expect(focusedNode.nodes.map(node => node.id)).toContain('graph-person-0002');
    expect(focusedNode.nodes.map(node => node.id)).toContain('graph-person-0004');
    expect(focusedNode.edges.every(edge => edge.from === 'graph-person-0003' || edge.to === 'graph-person-0003')).toBe(true);

    const focusedFact = queryOntologyGraph(doc, { moduleId: 'graph-module', at: '2026-10-05', focusId: 'graph-assertion-0003' });
    expect(focusedFact.focusEdgeId).toBe('graph-assertion-0003');
    expect(focusedFact.edges.some(edge => edge.id === focusedFact.focusEdgeId && edge.recordId === 'graph-assertion-0003')).toBe(true);
  });

  it('拒绝把其他本体或不存在的记录当成本体图谱焦点', () => {
    expect(() => queryOntologyGraph(graphDocument(3, 2), { moduleId: 'graph-module', at: '2026-10-05', focusId: 'unknown-record' }))
      .toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});


describe('图谱尺度与可续读边界', () => {
  it('按稳定游标继续加载，变化的版本或筛选条件必须重新读取', () => {
    const doc = graphDocument(340, 340);
    const input = { moduleId: 'graph-module', at: '2026-10-05', contentScale: 'instances' as const };
    const first = queryOntologyGraph(doc, input);
    expect(first.nextCursor).toBeTruthy();
    const next = queryOntologyGraph(doc, { ...input, cursor: first.nextCursor });
    expect(next.nodes).toHaveLength(340);
    expect(next.truncated).toBe(false);
    expect(() => queryOntologyGraph({ ...doc, revision: doc.revision + 1 }, { ...input, cursor: first.nextCursor })).toThrow(expect.objectContaining({ code: 'baseline_changed' }));
    expect(() => queryOntologyGraph(doc, { ...input, at: '2026-10-06', cursor: first.nextCursor })).toThrow(expect.objectContaining({ code: 'baseline_changed' }));
  });
  it('结构、实例、关系筛选来自同一记录且所有连线都可定位凭证', () => {
    const doc = graphDocument(8, 8);
    const schema = queryOntologyGraph(doc, { moduleId: 'graph-module', contentScale: 'schema' });
    expect(schema.nodes.every(node => node.kind === 'definition')).toBe(true);
    const instances = queryOntologyGraph(doc, { moduleId: 'graph-module', at: '2026-10-05', contentScale: 'instances', definitionId: 'graph-related-to' });
    expect(instances.edges).toHaveLength(8);
    expect(instances.edges.every(edge => edge.version === 1 && edge.source?.kind === 'user' && edge.recordId)).toBe(true);
    const filtered = queryOntologyGraph(doc, { moduleId: 'graph-module', at: '2026-10-05', contentScale: 'instances', definitionId: 'unmatched-relation' });
    expect(filtered.edges).toHaveLength(0);
  });
});
