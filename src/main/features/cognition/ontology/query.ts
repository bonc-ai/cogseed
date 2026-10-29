/** 查询区分现实有效时间与当时系统知道的版本；未知起点不自动当成有效。 */
import { createHash } from 'node:crypto';
import { OntologyError, isCalendarDate, type OntologyAssertion, type OntologyDocument, type OntologyModule, type OntologyRecord } from './model';
import { moduleCanUse, resolveOntologyRecordForModule } from './commands';

/** 任务侧上下文的最小结构（与 cognition_kernel 的 RecallAgentReadContextLike 同形）。 */
export interface OntologyTaskScopeContext { projectId?: string; workspaceId?: string }

/** 模块对一次任务是否可见（personal 恒可见；project/workspace 须 id 匹配）。 */
export function ontologyModuleVisibleToTask(module: OntologyModule, context?: OntologyTaskScopeContext): boolean {
  if (module.access !== 'task') return false;
  if (module.scope.kind === 'personal') return true;
  if (module.scope.kind === 'project') return Boolean(module.scope.id && module.scope.id === context?.projectId);
  if (module.scope.kind === 'workspace') return Boolean(module.scope.id && module.scope.id === context?.workspaceId);
  return false;
}

export type OntologyTruth = 'true' | 'false' | 'unknown';
export function assertionValidityAt(assertion: OntologyAssertion, day: string): OntologyTruth {
  if (!isCalendarDate(day)) throw new OntologyError('invalid_time', 'query date must be a calendar day');
  if (assertion.status !== 'active') return 'false';
  const { from, until, precision } = assertion.validity;
  const start = from && (precision === 'month' ? from + '-01' : from);
  const end = until && (precision === 'month' ? until + '-01' : until);
  if ((start && day < start) || (end && day >= end)) return 'false';
  return from === null || assertion.certainty && assertion.certainty !== 'confirmed' ? 'unknown' : 'true';
}

/** 不返回未来才录入的事实。结果是不可写的派生视图，不伪装成可提交主档。 */
export function ontologyRecordsKnownAt(doc: OntologyDocument, recordedAt?: string, knownRevision?: number): Record<string, OntologyRecord> {
  if (knownRevision !== undefined && (!Number.isSafeInteger(knownRevision) || knownRevision < 0 || knownRevision > doc.revision))
    throw new OntologyError('invalid_time', 'knowledge revision is outside the document history');
  if (!recordedAt && knownRevision === undefined) return structuredClone(doc.records);
  if (recordedAt && (!/^\d{4}-\d{2}-\d{2}T/.test(recordedAt) || Number.isNaN(Date.parse(recordedAt))))
    throw new OntologyError('invalid_time', 'invalid knowledge timestamp');
  const cutoff = recordedAt ? Date.parse(recordedAt) : Infinity, records: Record<string, OntologyRecord> = {};
  for (const entry of doc.history) if (Date.parse(entry.recordedAt) <= cutoff && (knownRevision === undefined || entry.revision <= knownRevision)) records[entry.after.id] = structuredClone(entry.after);
  return records;
}

function taskDependencyAvailable(doc: OntologyDocument, moduleId: string, id: string): boolean {
  const record = doc.records[id];
  return Boolean(record && record.kind !== 'module' && record.status === 'active' && record.access === 'task'
    && doc.records[record.moduleId]?.status === 'active' && doc.records[record.moduleId]?.access === 'task'
    && moduleCanUse(doc, moduleId, record));
}
export function queryOntologyFacts(doc: OntologyDocument, input: {
  moduleId: string; subjectId?: string; definitionId?: string; at: string; knownAt?: string; knownRevision?: number;
}): { matched: OntologyAssertion[]; uncertain: OntologyAssertion[] } {
  if (!isCalendarDate(input.at)) throw new OntologyError('invalid_time', 'query date must be a calendar day');
  const records = ontologyRecordsKnownAt(doc, input.knownAt, input.knownRevision);
  const view: OntologyDocument = { ...doc, records };
  const module = records[input.moduleId];
  if (!module || module.kind !== 'module' || module.status !== 'active' || module.access !== 'task') throw new OntologyError('not_found', 'ontology module unavailable');
  if (doc.records[input.moduleId]?.status !== 'active' || doc.records[input.moduleId]?.access !== 'task') throw new OntologyError('not_authorized', 'current ontology permission unavailable');
  const matched: OntologyAssertion[] = [], uncertain: OntologyAssertion[] = [];
  for (const record of Object.values(records)) {
    if (record.kind !== 'assertion' || record.access === 'owner_only' || !moduleCanUse(view, input.moduleId, record)
      || records[record.moduleId]?.status !== 'active' || records[record.moduleId]?.access !== 'task'
      || (input.subjectId && record.subjectId !== input.subjectId)
      || (input.definitionId && record.definitionId !== input.definitionId)) continue;
    if (doc.records[record.id]?.access !== 'task' || !taskDependencyAvailable(doc, record.moduleId, record.subjectId)
      || !taskDependencyAvailable(doc, record.moduleId, record.definitionId)
      || record.object.kind === 'entity' && !taskDependencyAvailable(doc, record.moduleId, record.object.id)) continue;
    const dependencies = [records[record.subjectId], ...(record.object.kind === 'entity' ? [records[record.object.id]] : [])];
    const unsure = record.certainty && record.certainty !== 'confirmed' || dependencies.some(row => row && ((row.certainty && row.certainty !== 'confirmed') || row.kind === 'entity' && row.identityStatus === 'unresolved'));
    const validityTruth = assertionValidityAt(record, input.at);
    const truth = validityTruth === 'false' ? 'false' : unsure ? 'unknown' : validityTruth;
    if (truth === 'true') matched.push(record);
    if (truth === 'unknown') uncertain.push(record);
  }
  return { matched, uncertain };
}

export type OntologyMatch = 'matched' | 'not_matched' | 'unknown';
export interface OntologyTaskContext {
  purpose?: string; taskKind?: string; entityId?: string;
  at: string; knownAt?: string; knownRevision?: number;
}
function evaluateCondition(doc: OntologyDocument, moduleId: string, condition: import('./model').OntologyCondition | null, task: OntologyTaskContext): OntologyMatch {
  if (!condition) return 'matched';
  if (condition.kind === 'task') {
    const value = task[condition.field];
    return value === undefined ? 'unknown' : value === condition.equals ? 'matched' : 'not_matched';
  }
  if (condition.kind === 'all' || condition.kind === 'any') {
    const children = condition.conditions.map(item => evaluateCondition(doc, moduleId, item, task));
    if (condition.kind === 'all') return children.includes('not_matched') ? 'not_matched' : children.includes('unknown') ? 'unknown' : 'matched';
    return children.includes('matched') ? 'matched' : children.includes('unknown') ? 'unknown' : 'not_matched';
  }
  if (condition.kind === 'not') {
    const result = evaluateCondition(doc, moduleId, condition.condition, task);
    return result === 'unknown' ? 'unknown' : result === 'matched' ? 'not_matched' : 'matched';
  }
  if (condition.kind !== 'assertion') throw new OntologyError('invalid_rule', 'unknown ontology rule condition');
  const queried = queryOntologyFacts(doc, { moduleId, subjectId: condition.subjectId, definitionId: condition.definitionId, at: task.at, ...(task.knownAt ? { knownAt: task.knownAt } : {}), ...(task.knownRevision !== undefined ? { knownRevision: task.knownRevision } : {}) });
  const equal = (assertion: OntologyAssertion) => {
    const expected = condition.object;
    if (!expected) return true;
    if (expected.kind === 'entity') return assertion.object.kind === 'entity' && assertion.object.id === expected.id;
    return assertion.object.kind === 'literal' && assertion.object.valueType === expected.valueType && assertion.object.value === expected.value;
  };
  if (queried.matched.some(equal)) return 'matched';
  if (queried.uncertain.some(equal)) return 'unknown';
  return 'unknown'; // 开放世界：没有记录表示未知，不等于条件为假。
}

/** 任务规则只报告适用状态与条文；此查询不会代替任务引擎自动检查或执行规则。 */
export function queryOntologyRules(doc: OntologyDocument, input: { moduleId: string; task: OntologyTaskContext }): Array<{
  rule: OntologyRecord & { kind: 'rule' }; match: OntologyMatch;
}> {
  if (!isCalendarDate(input.task.at)) throw new OntologyError('invalid_time', 'task query date must be a calendar day');
  const records = ontologyRecordsKnownAt(doc, input.task.knownAt, input.task.knownRevision), view: OntologyDocument = { ...doc, records };
  const module = records[input.moduleId];
  if (!module || module.kind !== 'module' || module.status !== 'active' || module.access !== 'task') throw new OntologyError('not_found', 'ontology module unavailable');
  return Object.values(records).filter((r): r is OntologyRecord & { kind: 'rule' } => r.kind === 'rule'
    && r.status === 'active' && r.access !== 'owner_only' && records[r.moduleId]?.status === 'active'
    && records[r.moduleId]?.access === 'task' && moduleCanUse(view, input.moduleId, r)).map(rule => {
    const applicability = evaluateCondition(view, input.moduleId, rule.condition, input.task);
    return { rule, match: applicability === 'not_matched' ? applicability
      : rule.certainty && rule.certainty !== 'confirmed' ? 'unknown' as const : applicability };
  });
}

export interface OntologyGraphProjection {
  scale: 'modules' | 'module';
  contentScale?: 'schema' | 'instances';
  nodes: Array<{ id: string; kind: string; label: string; moduleId?: string; status: string; description?: string; version?: number; source?: OntologyRecord['source'] }>;
  edges: Array<{ id: string; from: string; to: string; label: string; labelKey?: string; kind: string; truth?: OntologyTruth; recordId?: string; version?: number; source?: OntologyRecord['source']; validity?: OntologyAssertion['validity'] }>;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  nextCursor?: string;
  focusId?: string;
  focusNodeId?: string;
  focusEdgeId?: string;
}

const GLOBAL_GRAPH_NODE_LIMIT = 200;
const GLOBAL_GRAPH_EDGE_LIMIT = 400;
const MODULE_GRAPH_NODE_LIMIT = 220;
const MODULE_GRAPH_EDGE_LIMIT = 500;

function boundOntologyGraph(
  scale: OntologyGraphProjection['scale'],
  nodes: OntologyGraphProjection['nodes'],
  edges: OntologyGraphProjection['edges'],
  nodeLimit: number,
  edgeLimit: number,
  focus?: Pick<OntologyGraphProjection, 'focusId' | 'focusNodeId' | 'focusEdgeId'>,
): OntologyGraphProjection {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const totalNodes = nodes.length, totalEdges = edges.length;
  const nodeRank: Record<string, number> = { module: 0, entity: 1, rule: 2, definition: 3, value: 4, assertion: 5, reference: 6 };
  const visibleNodes = (nodes.length > nodeLimit
    ? [...nodes].sort((a, b) => Number(b.id === focus?.focusNodeId) - Number(a.id === focus?.focusNodeId)
      || (degree.get(b.id) || 0) - (degree.get(a.id) || 0)
      || (nodeRank[a.kind] ?? 10) - (nodeRank[b.kind] ?? 10)
      || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)).slice(0, nodeLimit)
    : [...nodes]);
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  const edgeRank: Record<string, number> = { assertion: 0, rule: 1, reference: 2, definition: 3, type: 4 };
  const eligibleEdges = edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const visibleEdges = eligibleEdges.length > edgeLimit
    ? eligibleEdges.sort((a, b) => (edgeRank[a.kind] ?? 10) - (edgeRank[b.kind] ?? 10)
      || a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.id.localeCompare(b.id)).slice(0, edgeLimit)
    : eligibleEdges;
  return { scale, nodes: visibleNodes, edges: visibleEdges, totalNodes, totalEdges,
    truncated: visibleNodes.length < totalNodes || visibleEdges.length < totalEdges, ...focus };
}

/** 图是当前本体记录按所选层级和日期形成的只读投影。 */
export function queryOntologyGraph(doc: OntologyDocument, input: { moduleId?: string; at?: string; focusId?: string; contentScale?: 'schema' | 'instances'; includeRules?: boolean; definitionId?: string; cursor?: string }): OntologyGraphProjection {
  if (input.contentScale !== undefined && !['schema', 'instances'].includes(input.contentScale)) throw new OntologyError('invalid_input', 'invalid graph content scale');
  const queryKey = createHash('sha256').update(JSON.stringify([doc.revision, input.moduleId, input.at, input.focusId, input.contentScale, input.includeRules, input.definitionId])).digest('hex').slice(0, 24);
  let page = 1;
  if (input.cursor) {
    const [key, rawPage] = input.cursor.split(':'); page = Number(rawPage);
    if (key !== queryKey || !Number.isSafeInteger(page) || page < 2 || page > 128) throw new OntologyError('baseline_changed', 'graph cursor expired; reload this view');
  }
  const bound = (scale: OntologyGraphProjection['scale'], nodes: OntologyGraphProjection['nodes'], edges: OntologyGraphProjection['edges'], nodeLimit: number, edgeLimit: number, focus?: Pick<OntologyGraphProjection, 'focusId' | 'focusNodeId' | 'focusEdgeId'>) => {
    const result = boundOntologyGraph(scale, nodes, edges, nodeLimit * page, edgeLimit * page, focus);
    return { ...result, ...(result.truncated && page < 128 ? { nextCursor: `${queryKey}:${page + 1}` } : {}) };
  };
  const modules = Object.values(doc.records).filter((r): r is Extract<OntologyRecord, { kind: 'module' }> => r.kind === 'module' && r.status === 'active');
  if (!input.moduleId) {
    const activeIds = new Set(modules.map(m => m.id));
    const nodes = modules.map(m => ({ id: m.id, kind: m.kind, label: m.name, status: m.status, description: m.description, version: m.version, source: m.source }));
    const edges = Object.values(doc.records).filter((r): r is Extract<OntologyRecord, { kind: 'reference' }> => r.kind === 'reference' && r.status === 'active'
        && activeIds.has(r.moduleId) && activeIds.has(r.targetModuleId)).map(r => ({
        id: r.id, from: r.moduleId, to: r.targetModuleId,
        label: r.targetRecordId ? '引用对象' : '引用本体', labelKey: r.targetRecordId ? 'graphRecordReference' : 'graphModuleReference', kind: 'reference', recordId: r.id, version: r.version, source: r.source,
      }));
    if (input.focusId) {
      const focusModule = modules.find(m => m.id === input.focusId);
      if (!focusModule) throw new OntologyError('not_found', 'ontology graph focus unavailable');
      const relatedEdges = edges.filter(edge => edge.from === focusModule.id || edge.to === focusModule.id);
      const relatedIds = new Set([focusModule.id, ...relatedEdges.flatMap(edge => [edge.from, edge.to])]);
      const relatedNodes = nodes.filter(node => relatedIds.has(node.id));
      return bound('modules', relatedNodes, relatedEdges, GLOBAL_GRAPH_NODE_LIMIT, GLOBAL_GRAPH_EDGE_LIMIT,
        { focusId: input.focusId, focusNodeId: input.focusId });
    }
    return bound('modules', nodes, edges, GLOBAL_GRAPH_NODE_LIMIT, GLOBAL_GRAPH_EDGE_LIMIT);
  }
  const module = doc.records[input.moduleId];
  if (!module || module.kind !== 'module' || module.status !== 'active') throw new OntologyError('not_found', 'ontology module unavailable');
  if (!input.at && input.contentScale !== 'schema') throw new OntologyError('invalid_time', 'module graph requires an explicit query date');
  const nodes = new Map<string, OntologyGraphProjection['nodes'][number]>(), edges: OntologyGraphProjection['edges'] = [];
  const addNode = (r: OntologyRecord) => {
    const label = r.kind === 'module' || r.kind === 'definition' || r.kind === 'entity' || r.kind === 'rule'
      ? r.name : r.kind === 'assertion' ? '事实' : '本体引用';
    nodes.set(r.id, { id: r.id, kind: r.kind, label, version: r.version, source: r.source,
      ...(r.kind === 'module' ? {} : { moduleId: r.moduleId }), status: r.status,
      ...('description' in r && r.description ? { description: r.description } : {}) });
  };
  const records = Object.values(doc.records).filter(r => r.kind !== 'module' && r.moduleId === module.id && r.status === 'active');
  records.filter(r => r.kind === 'definition' || r.kind === 'entity' || r.kind === 'rule').forEach(addNode);
  for (const record of records) {
    if (record.kind !== 'definition' || record.moduleId !== module.id) continue;
    for (const typeId of [...record.subjectTypes, ...record.objectTypes]) {
      const type = resolveOntologyRecordForModule(doc, module.id, typeId);
      if (type?.kind === 'definition' && type.status === 'active' && moduleCanUse(doc, module.id, type)) addNode(type);
    }
  }
  const day = input.at;
  if (day && !isCalendarDate(day)) throw new OntologyError('invalid_time', 'graph date must be a calendar day');
  for (const record of records) {
    if (record.kind === 'definition' && record.moduleId === module.id && record.status === 'active') {
      for (const typeId of record.subjectTypes) if (nodes.has(typeId)) edges.push({ id: `domain:${record.id}:${typeId}`, from: typeId, to: record.id, label: '適用於', labelKey: 'graphDomain', kind: 'definition', recordId: record.id });
      for (const typeId of record.objectTypes) if (nodes.has(typeId)) edges.push({ id: `range:${record.id}:${typeId}`, from: record.id, to: typeId, label: '指向類型', labelKey: 'graphRange', kind: 'definition', recordId: record.id });
      continue;
    }
    if (record.kind === 'entity' && record.status === 'active' && record.moduleId === module.id) {
      const type = resolveOntologyRecordForModule(doc, module.id, record.typeId);
      if (nodes.has(record.typeId)) edges.push({ id: `type:${record.id}`, from: record.id, to: record.typeId, label: '类型', labelKey: 'graphType', kind: 'type', recordId: record.id });
      continue;
    }
    if (record.kind === 'assertion' && record.moduleId === module.id && record.status === 'active') {
      const truth = day ? assertionValidityAt(record, day) : 'true';
      if (truth === 'false' || input.definitionId && record.definitionId !== input.definitionId) continue;
      const predicate = resolveOntologyRecordForModule(doc, module.id, record.definitionId);
      if (!nodes.has(record.subjectId) || !nodes.has(record.definitionId)) continue;
      if (record.object.kind === 'entity') {
        const target = resolveOntologyRecordForModule(doc, module.id, record.object.id);
        if (!target) continue;
        if (!nodes.has(target.id)) addNode(target);
        if (target.kind === 'entity') {
          const type = resolveOntologyRecordForModule(doc, module.id, target.typeId);
          if (type?.kind === 'definition' && type.status === 'active' && moduleCanUse(doc, module.id, type)) addNode(type);
        }
        edges.push({ id: record.id, from: record.subjectId, to: target.id,
          label: predicate?.kind === 'definition' ? predicate.name : '关系', kind: 'assertion', truth, recordId: record.id });
      } else {
        const literalId = `literal-${record.id}`;
        nodes.set(literalId, { id: literalId, kind: 'value', label: String(record.object.value), moduleId: module.id, status: record.status });
        edges.push({ id: record.id, from: record.subjectId, to: literalId,
          label: predicate?.kind === 'definition' ? predicate.name : '属性', kind: 'assertion', truth, recordId: record.id });
      }
    }
    if (record.kind === 'rule' && record.moduleId === module.id && record.status === 'active'
      && record.effect.kind === 'include_recipient') {
      const recipient = resolveOntologyRecordForModule(doc, module.id, record.effect.entityId);
      if (recipient) { if (!nodes.has(recipient.id)) addNode(recipient); edges.push({ id: record.id, from: record.id, to: recipient.id, label: '接收人', labelKey: 'graphRecipient', kind: 'rule', recordId: record.id }); }
    }
    if (record.kind === 'rule' && record.moduleId === module.id && record.status === 'active' && record.condition) {
      const walk = (condition: import('./model').OntologyCondition) => {
        if (condition.kind === 'all' || condition.kind === 'any') { condition.conditions.forEach(walk); return; }
        if (condition.kind === 'not') { walk(condition.condition); return; }
        if (condition.kind !== 'assertion') return;
        if (nodes.has(condition.subjectId)) edges.push({ id: `condition:${record.id}:${condition.subjectId}`, from: record.id, to: condition.subjectId, label: '條件對象', labelKey: 'graphConditionObject', kind: 'rule', recordId: record.id });
        if (nodes.has(condition.definitionId)) edges.push({ id: `predicate:${record.id}:${condition.definitionId}`, from: record.id, to: condition.definitionId, label: '條件關係', labelKey: 'graphConditionRelation', kind: 'rule', recordId: record.id });
      };
      walk(record.condition);
    }
  }
  for (const edge of edges) {
    const record = edge.recordId && doc.records[edge.recordId];
    if (record) { edge.version = record.version; edge.source = record.source; if (record.kind === 'assertion') edge.validity = record.validity; }
  }
  if (input.contentScale || input.includeRules === false) {
    const allowedKinds = input.contentScale === 'schema' ? new Set(['definition', 'rule'])
      : input.contentScale === 'instances' ? new Set(['entity', 'value', 'rule']) : null;
    for (const [id, node] of nodes) if (allowedKinds && !allowedKinds.has(node.kind) || input.includeRules === false && node.kind === 'rule') nodes.delete(id);
    for (let index = edges.length - 1; index >= 0; index--) if (!nodes.has(edges[index].from) || !nodes.has(edges[index].to)) edges.splice(index, 1);
  }
  if (input.focusId) {
    const focusNode = nodes.get(input.focusId);
    const focusEdge = edges.find(edge => edge.id === input.focusId || edge.recordId === input.focusId);
    if (!focusNode && !focusEdge) throw new OntologyError('not_found', 'ontology graph focus unavailable');
    const seedIds = new Set(focusNode ? [focusNode.id] : [focusEdge!.from, focusEdge!.to]);
    const relatedEdges = edges.filter(edge => seedIds.has(edge.from) || seedIds.has(edge.to));
    const relatedIds = new Set(seedIds);
    for (const edge of relatedEdges) { relatedIds.add(edge.from); relatedIds.add(edge.to); }
    const relatedNodes = [...nodes.values()].filter(node => relatedIds.has(node.id));
    return bound('module', relatedNodes, relatedEdges, MODULE_GRAPH_NODE_LIMIT, MODULE_GRAPH_EDGE_LIMIT,
      { focusId: input.focusId, ...(focusNode ? { focusNodeId: focusNode.id } : { focusNodeId: focusEdge!.from }), ...(focusEdge ? { focusEdgeId: focusEdge.id } : {}) });
  }
  return { ...bound('module', [...nodes.values()], edges, MODULE_GRAPH_NODE_LIMIT, MODULE_GRAPH_EDGE_LIMIT), ...(input.contentScale ? { contentScale: input.contentScale } : {}) };
}

export function searchOntologyRecords(doc: OntologyDocument, query: string, moduleId?: string): Array<{
  id: string; kind: string; name: string; moduleId?: string; status: string; description: string;
}> {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const rows = Object.values(doc.records).filter(r => {
    if (r.status !== 'active' || (r.kind !== 'module' && doc.records[r.moduleId]?.status !== 'active')
      || (moduleId && (r.kind === 'module' ? r.id !== moduleId : r.moduleId !== moduleId))) return false;
    const subject = r.kind === 'assertion' ? doc.records[r.subjectId] : undefined;
    const definition = r.kind === 'assertion' ? doc.records[r.definitionId] : undefined;
    const value = r.kind === 'assertion' ? r.object.kind === 'entity' ? doc.records[r.object.id] : r.object.value : undefined;
    const targetModule = r.kind === 'reference' ? doc.records[r.targetModuleId] : undefined;
    const targetRecord = r.kind === 'reference' && r.targetRecordId ? doc.records[r.targetRecordId] : undefined;
    const searchable = [r.id, r.kind === 'module' || r.kind === 'definition' || r.kind === 'entity' || r.kind === 'rule' ? r.name : '',
      'description' in r ? r.description : '', 'aliases' in r ? r.aliases.join(' ') : '', 'requirement' in r ? r.requirement : '',
      r.kind === 'reference' && targetModule?.kind === 'module' ? targetModule.name : '',
      r.kind === 'reference' && targetRecord ? (targetRecord.kind === 'entity' || targetRecord.kind === 'definition' || targetRecord.kind === 'rule' ? targetRecord.name : targetRecord.id) : '',
      r.kind === 'assertion' && subject?.kind === 'entity' ? subject.name : '',
      r.kind === 'assertion' && definition?.kind === 'definition' ? definition.name : '',
      r.kind === 'assertion' && value && typeof value === 'object' && 'name' in value ? value.name : value]
      .filter(value => value != null).map(String);
    return searchable.some(value => value.toLocaleLowerCase().includes(q));
  }).map(r => {
    const subject = r.kind === 'assertion' ? doc.records[r.subjectId] : undefined;
    const definition = r.kind === 'assertion' ? doc.records[r.definitionId] : undefined;
    const value = r.kind === 'assertion' ? r.object.kind === 'entity' ? doc.records[r.object.id] : r.object.value : undefined;
    const statement = r.kind === 'assertion' ? `${subject?.kind === 'entity' ? subject.name : r.subjectId} · ${definition?.kind === 'definition' ? definition.name : r.definitionId} · ${value && typeof value === 'object' && 'name' in value ? value.name : value}` : undefined;
    const targetModule = r.kind === 'reference' ? doc.records[r.targetModuleId] : undefined;
    const targetRecord = r.kind === 'reference' && r.targetRecordId ? doc.records[r.targetRecordId] : undefined;
    const referenceName = r.kind === 'reference' ? `${targetRecord && (targetRecord.kind === 'entity' || targetRecord.kind === 'definition' || targetRecord.kind === 'rule') ? targetRecord.name : targetModule?.kind === 'module' ? targetModule.name : r.targetRecordId || r.targetModuleId}` : undefined;
    return { id: r.id, kind: r.kind,
      name: statement || referenceName || (r.kind === 'module' || r.kind === 'definition' || r.kind === 'entity' || r.kind === 'rule' ? r.name : r.id),
      ...(r.kind === 'module' ? {} : { moduleId: r.moduleId }), status: r.status,
      description: 'description' in r ? r.description : r.kind === 'rule' ? r.requirement : r.kind === 'assertion' ? `${r.validity.from || 'unknown'} → ${r.validity.until || 'open'}` : '' };
  });
  rows.sort((a, b) => Number(b.id.toLocaleLowerCase() === q) - Number(a.id.toLocaleLowerCase() === q)
    || a.name.localeCompare(b.name));
  return rows.slice(0, 100);
}
