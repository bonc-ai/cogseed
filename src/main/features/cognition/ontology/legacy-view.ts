/**
 * 只读展示旧图谱与旧个人本体的适配层。
 * 不落盘、不触发 v1 导入；旧记录仍由它们原来的存储和治理路径负责。
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readOntologyGraph, readOntologyGraphForManagement } from '../../ontology_graph';
import { userOntologyGraphFile } from '../../../paths';
import { loadPoDocSync, poDocPath } from '../../po/store';
import { emptyPoDocument, normalizePoDocument, type PoDocument } from '../../po/model';
import { readUnifiedPoDocument } from '../../cognition_bridge';
import { corruptRecordFor } from '../../../util/corrupt-guard';
import { OntologyError, isCalendarDate, type OntologyDocument, type OntologyKind, type OntologyRecord, type OntologySourceRef } from './model';

const legacyId = (kind: string, value: string) => `legacy-${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
const legacyBase = <K extends OntologyKind>(id: string, kind: K, sourceLabel: string, recordId: string, refs: OntologySourceRef[] = []) => ({
  id, kind, version: 1, status: 'active' as const, access: 'task' as const,
  createdAt: null, updatedAt: null,
  source: { kind: 'legacy' as const, label: sourceLabel, recordId, ...(refs.length ? { refs } : {}) },
});

function addUnique(target: Record<string, OntologyRecord>, record: OntologyRecord): void {
  const saved = target[record.id];
  // 旧模块的生命周期单独落主档；投影继续提供原始名称、来源和内容。
  if (record.kind === 'module' && saved?.kind === 'module' && saved.source.kind === 'legacy' && saved.source.recordId === record.id) {
    target[record.id] = { ...record, status: saved.status, version: saved.version, updatedAt: saved.updatedAt };
    return;
  }
  if (target[record.id]) throw new OntologyError('store_corrupt', 'legacy ontology identity collides with the common store', { recordId: record.id });
  Object.defineProperty(target, record.id, { value: record, writable: true, enumerable: true, configurable: true });
}

function graphProjection(doc: OntologyDocument, graph: Awaited<ReturnType<typeof readOntologyGraph>>): void {
  const hasLegacyGraph = graph.categories.some(category => !category.builtIn) || graph.entities.length > 0 || graph.relations.length > 0;
  if (!hasLegacyGraph) return;
  const moduleId = 'legacy-ontology-graph';
  addUnique(doc.records, { ...legacyBase(moduleId, 'module', '旧图谱', 'ontology-graph.json'),
    name: '旧图谱内容', description: '', scope: { kind: 'personal' } });
  const typeByCategory = new Map<string, string>();
  const fieldByKey = new Map<string, string>();
  for (const category of graph.categories) {
    const typeId = legacyId('graph-type', category.id);
    typeByCategory.set(category.id, typeId);
    addUnique(doc.records, { ...legacyBase(typeId, 'definition', '旧图谱分类', category.id), moduleId, name: category.name,
      description: category.description, definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' });
    for (const field of category.fields) {
      const defId = legacyId('graph-field', `${category.id}:${field.id}`);
      fieldByKey.set(`${category.id}:${field.id}`, defId);
      addUnique(doc.records, { ...legacyBase(defId, 'definition', '旧图谱字段', field.id), moduleId, name: field.name,
        description: `旧字段类型：${field.kind}。原始值仅按文字展示，未推断为日期、数值或关系。`, definitionKind: 'attribute',
        subjectTypes: [typeId], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' });
    }
  }
  const personTypeId = typeByCategory.get('builtin_resource_person') || legacyId('graph-type', 'builtin_resource_person');
  if (!typeByCategory.has('builtin_resource_person')) {
    typeByCategory.set('builtin_resource_person', personTypeId);
    addUnique(doc.records, { ...legacyBase(personTypeId, 'definition', '旧图谱分类', 'builtin_resource_person'), moduleId,
      name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' });
  }
  const usesSelf = graph.relations.some(relation => relation.subject.kind === 'self' || relation.object.kind === 'self');
  const selfId = legacyId('graph-entity', 'self');
  if (usesSelf) addUnique(doc.records, { ...legacyBase(selfId, 'entity', '旧图谱中的“我”对象', 'self'), moduleId, typeId: personTypeId,
    name: '我', description: '旧图谱关系端点。', aliases: [], identityStatus: 'confirmed' });
  const entityId = (id: string) => legacyId('graph-entity', id);
  for (const entity of graph.entities) {
    const typeId = typeByCategory.get(entity.categoryId);
    if (!typeId) continue;
    const refs = entity.sourceRefs.map(ref => ({ kind: ref.kind, id: ref.id })) as OntologySourceRef[];
    addUnique(doc.records, { ...legacyBase(entityId(entity.id), 'entity', '旧图谱对象', entity.id, refs), moduleId, typeId,
      name: entity.name, description: entity.description, aliases: [], identityStatus: 'confirmed',
    });
    const category = graph.categories.find(item => item.id === entity.categoryId);
    for (const [fieldId, raw] of Object.entries(entity.properties)) {
      const definitionId = fieldByKey.get(`${entity.categoryId}:${fieldId}`);
      if (!definitionId || !category?.fields.some(field => field.id === fieldId)) continue;
      const assertionId = legacyId('graph-value', `${entity.id}:${fieldId}`);
      addUnique(doc.records, { ...legacyBase(assertionId, 'assertion', '旧图谱对象属性', entity.id,
        [{ kind: 'legacy', id: fieldId }]), moduleId, subjectId: entityId(entity.id), definitionId,
        object: { kind: 'literal', valueType: 'text', value: raw },
        validity: { from: null, until: null, precision: 'day', timezone: 'UTC' },
      });
    }
  }
  const predicateGroups = new Map<string, typeof graph.relations>();
  for (const relation of graph.relations) {
    const key = relation.predicate.toLocaleLowerCase();
    predicateGroups.set(key, [...(predicateGroups.get(key) || []), relation]);
  }
  const predicateDefinitions = new Map<string, string>();
  const endpointType = (endpoint: typeof graph.relations[number]['subject']): string | undefined => {
    if (endpoint.kind === 'self') return personTypeId;
    const entity = graph.entities.find(item => item.id === endpoint.id);
    return entity ? typeByCategory.get(entity.categoryId) : undefined;
  };
  for (const [predicate, relations] of predicateGroups) {
    const definitionId = legacyId('graph-relation', predicate);
    predicateDefinitions.set(predicate, definitionId);
    const subjectTypes = [...new Set(relations.map(item => endpointType(item.subject)).filter((v): v is string => Boolean(v)))];
    const objectTypes = [...new Set(relations.map(item => endpointType(item.object)).filter((v): v is string => Boolean(v)))];
    addUnique(doc.records, { ...legacyBase(definitionId, 'definition', '旧图谱关系词', predicate), moduleId,
      name: relations[0].predicate, description: '由旧图谱关系词只读适配。原始有效时期未记录，查询状态为未知。', definitionKind: 'relation',
      subjectTypes, objectTypes, valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' });
  }
  for (const relation of graph.relations) {
    const subjectId = relation.subject.kind === 'self' ? selfId : entityId(relation.subject.id);
    const objectId = relation.object.kind === 'self' ? selfId : entityId(relation.object.id);
    if (!doc.records[subjectId] || !doc.records[objectId]) continue;
    const predicate = relation.predicate.toLocaleLowerCase();
    addUnique(doc.records, { ...legacyBase(entityId(`relation:${relation.id}`), 'assertion', '旧图谱关系', relation.id,
      relation.sourceRefs.map(ref => ({ kind: ref.kind, id: ref.id }) as OntologySourceRef)), moduleId,
      subjectId, definitionId: predicateDefinitions.get(predicate)!, object: { kind: 'entity', id: objectId },
      validity: { from: null, until: null, precision: 'day', timezone: 'UTC' },
    });
  }
}

function readExistingPo(userId: string): PoDocument {
  const unified = readUnifiedPoDocument(userId);
  if (unified) return normalizePoDocument(unified);
  const file = poDocPath(userId);
  if (!fs.existsSync(file)) return emptyPoDocument(); // deliberately do not invoke v1 auto-import on this read path.
  if (corruptRecordFor(file)) throw new OntologyError('store_corrupt', 'legacy personal ontology is marked corrupt');
  const doc = loadPoDocSync(userId); // the file exists, so the store does not enter its legacy-import branch.
  if (corruptRecordFor(file)) throw new OntologyError('store_corrupt', 'legacy personal ontology could not be read');
  return doc;
}

function personalOntologyProjection(doc: OntologyDocument, userId: string, fullText?: Map<string, string>): void {
  const po = readExistingPo(userId);
  for (const group of po.groups) {
    if (group.kind !== 'user' || !group.fields.length && !group.values.some(value => !value.assetId) && !group.entries.length) continue;
    const moduleId = legacyId('po-module', group.id), typeId = legacyId('po-type', group.id), selfId = legacyId('po-self', group.id);
    addUnique(doc.records, { ...legacyBase(moduleId, 'module', '舊個人本體', group.id), name: group.title,
      description: '', scope: { kind: 'personal' } });
    addUnique(doc.records, { ...legacyBase(typeId, 'definition', '舊個人本體類型', group.id), moduleId, name: '人物', description: '',
      definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' });
    addUnique(doc.records, { ...legacyBase(selfId, 'entity', '舊個人本體中的“我”', group.id), moduleId, typeId,
      name: '我', description: '', aliases: [], identityStatus: 'confirmed', access: 'task' });
    const fields = new Map<string, string>();
    for (const field of group.fields) {
      const definitionId = legacyId('po-field', `${group.id}:${field.id}`);
      fields.set(field.id, definitionId);
      addUnique(doc.records, { ...legacyBase(definitionId, 'definition', '旧个人本体字段', field.id,
        [{ kind: 'legacy', id: group.id }]), moduleId, name: field.name,
        description: field.description || (field.isRelation ? '旧关系字段原值是文字；尚未确认关系两端对象。' : ''),
        definitionKind: 'attribute', subjectTypes: [typeId], objectTypes: [], valueType: 'text', cardinality: 'many', cardinalityAnchor: 'subject' });
    }
    for (const value of group.values) {
      if (value.assetId) continue; // the formal asset is authoritative and already appears in the asset system.
      const definitionId = fields.get(value.fieldId);
      if (!definitionId) continue;
      const from = value.asOf && isCalendarDate(value.asOf, 'month') ? value.asOf : null;
      addUnique(doc.records, { ...legacyBase(legacyId('po-value', `${group.id}:${value.id}`), 'assertion', '旧个人本体值', value.id,
        [{ kind: 'legacy', id: group.id }, { kind: 'legacy', id: value.fieldId }]), moduleId, subjectId: selfId, definitionId,
        object: { kind: 'literal', valueType: 'text', value: value.text },
        validity: { from, until: null, precision: from ? 'month' : 'day', timezone: 'UTC' },
        access: value.restricted ? 'owner_only' : 'task',
      });
    }
    if (group.entries.length) {
      const entryTypeId = legacyId('po-entry-type', group.id);
      addUnique(doc.records, { ...legacyBase(entryTypeId, 'definition', '旧个人本体流水类型', group.id), moduleId,
        name: '非结构化记录', description: '旧个人本体中的自由文本条目。按原文展示，不自动推断成事实、关系或规则。',
        definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' });
      for (const [index, entry] of group.entries.entries()) {
        const firstLine = entry.text.replace(/\s+/g, ' ').trim().slice(0, 180);
        const truncated = entry.text.length > 3_800;
        const description = truncated
          ? `${entry.text.slice(0, 3_800)}\n\n[原始条目较长；当前只展示前3800字，旧来源未修改。]`
          : entry.text;
        const sourceRecordId = legacyId('po-entry-source', `${group.id}:${entry.id}`);
        const recordId = legacyId('po-entry', `${group.id}:${entry.id}`);
        fullText?.set(recordId, entry.text);
        addUnique(doc.records, { ...legacyBase(recordId, 'entity', '旧个人本体自由文本条目', sourceRecordId,
          [{ kind: 'legacy', id: group.id }]), moduleId, typeId: entryTypeId,
          name: firstLine || `旧记录条目 ${index + 1}`, description, aliases: [], identityStatus: 'confirmed',
          // PoEntry has no task-visibility field. Keep it owner-only until the user deliberately restructures it.
          access: 'owner_only',
        });
      }
    }
  }
}

export async function readOntologyWithLegacyView(canonical: OntologyDocument, userId: string): Promise<OntologyDocument> {
  return (await readOntologyManagementView(canonical, userId, false)).ontology;
}

/** Same read-only projection plus lossless owner-management content. A legacy
 * entry's 3,800-char display description is not its complete original text.
 * The sidecar never changes the schema-bounded projection or the old source. */
export async function readOntologyManagementView(canonical: OntologyDocument, userId: string, strictSources = true): Promise<{
  ontology: OntologyDocument; legacyFullText: Map<string, string>;
}> {
  const view: OntologyDocument = { ...canonical, records: { ...canonical.records } };
  const legacyFullText = new Map<string, string>();
  const graphPath = userOntologyGraphFile(userId);
  if (corruptRecordFor(graphPath)) throw new OntologyError('store_corrupt', 'legacy ontology graph is marked corrupt');
  const graph = await (strictSources ? readOntologyGraphForManagement(userId) : readOntologyGraph(userId));
  if (corruptRecordFor(graphPath)) throw new OntologyError('store_corrupt', 'legacy ontology graph could not be read');
  graphProjection(view, graph);
  personalOntologyProjection(view, userId, legacyFullText);
  return { ontology: view, legacyFullText };
}
