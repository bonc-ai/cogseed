/** Shared task-scoped ontology query. The Agent tool owns transport and receipts;
 * every consumer uses this service so scope, admission and output stay identical. */
import { isCalendarDate, OntologyError, validateOntologyId, type OntologyDocument, type OntologyRecord, type OntologyRule, type OntologyValidity } from './model';
import { readOntologyView } from './service';
import { assessOntologySources, ontologyWithAdmittedSources, type OntologySourceContext } from './source-admission';
import { ontologyModuleVisibleToTask, queryOntologyFacts, queryOntologyRules, searchOntologyRecordsWithMeta } from './query';
import { resolveOntologyRecordForModule } from './commands';
import type { OntologyQueryReadRef } from './query-receipt';

export interface OntologyTaskQueryLimits {
  maxModules: number;
  maxRecords: number;
  maxFacts: number;
  maxUncertainFacts: number;
  maxRules: number;
  maxConflicts: number;
}

export interface OntologyTaskQueryRequest {
  userId: string;
  context?: OntologySourceContext;
  query: string;
  queries?: string[];
  moduleId?: string;
  at: string;
  purpose?: string;
  taskKind?: string;
  entityId?: string;
  limits?: Partial<OntologyTaskQueryLimits>;
}

export interface OntologyQueryFactRow {
  match: 'matched' | 'unknown';
  statement: string;
  validity: OntologyValidity;
  module: { id: string; name?: string };
  citation: string;
  source: { recordId: string; version: number; label: string; kind: OntologyRecord['source']['kind'] };
}

export interface OntologyQueryRuleRow {
  name: string;
  requirement: string;
  strength: OntologyRule['strength'];
  match: 'matched' | 'not_matched' | 'unknown';
  exception: string;
  effect: OntologyRule['effect'] & { entityName?: string };
  module: { id: string; name: string };
  citation: string;
  source: { recordId: string; version: number; label: string; kind: OntologyRecord['source']['kind'] };
}

export interface OntologyQueryConflict {
  key: string;
  values: string[];
  state: 'potential' | 'confirmed';
  sources: Array<{ value: string; match: string; recordId: string; moduleId: string; version: number; sourceKind: string }>;
  omittedSourceCount: number;
}

/** Counts of active content the task scope excludes. Counts only: no record
 * ids, names or bodies cross the boundary. A zero module list next to a
 * nonzero count means "content exists but is not provided to tasks", never
 * "the ontology is empty". */
export interface OntologyTaskScopeExcluded {
  ownerOnly: { modules: number; records: number };
  otherScope: { modules: number; records: number };
}

export interface OntologyTaskQueryResult {
  query: string;
  at: string;
  modules: Array<{ id: string; name: string; scope: { kind: 'personal' | 'project' | 'workspace'; id?: string } }>;
  revision: number;
  records: OntologyRecord[];
  facts: OntologyQueryFactRow[];
  uncertainFacts: OntologyQueryFactRow[];
  rules: OntologyQueryRuleRow[];
  conflicts: OntologyQueryConflict[];
  conflictsComplete: boolean;
  searchTruncated: boolean;
  truncated: { facts: number; uncertainFacts: number; rules: number; modules: number; records: number };
  scopeExcluded: OntologyTaskScopeExcluded;
  queryScope: 'task_topic_search_not_owner_inventory';
  sourceCoverage: { complete: boolean };
  useBoundary: string;
  readRefs: OntologyQueryReadRef[];
}

const DEFAULT_LIMITS: OntologyTaskQueryLimits = {
  maxModules: 50, maxRecords: 100, maxFacts: 60, maxUncertainFacts: 60, maxRules: 30,
  maxConflicts: Number.MAX_SAFE_INTEGER,
};

export const ONTOLOGY_TASK_USAGE_RECEIPT_POLICY = 'If a fact or rule materially informs the final answer, copy its citation marker exactly into that answer. The host records use only when the same-turn query returned that exact version and the marker appears in the persisted reply. This does not prove external action execution or effectiveness.';
export const ONTOLOGY_TASK_USE_BOUNDARY = 'The read receipt means this tool produced a result containing the cited record versions; it does not prove adoption or execution. A rule match does not mean rule execution. If any truncated count is nonzero, searchTruncated is true, or sourceCoverage.complete is false, this result is incomplete and cannot certify that all requirements were checked.';

function normalizedLimits(input: Partial<OntologyTaskQueryLimits> = {}): OntologyTaskQueryLimits {
  const limit = (value: unknown, fallback: number) => Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), 500) : fallback;
  return {
    maxModules: limit(input.maxModules, DEFAULT_LIMITS.maxModules),
    maxRecords: limit(input.maxRecords, DEFAULT_LIMITS.maxRecords),
    maxFacts: limit(input.maxFacts, DEFAULT_LIMITS.maxFacts),
    maxUncertainFacts: limit(input.maxUncertainFacts, DEFAULT_LIMITS.maxUncertainFacts),
    maxRules: limit(input.maxRules, DEFAULT_LIMITS.maxRules),
    maxConflicts: limit(input.maxConflicts, DEFAULT_LIMITS.maxConflicts),
  };
}

function citation(moduleId: string, recordId: string, version: number): string {
  return `[[ontology:${moduleId}/${recordId}@${version}]]`;
}

function contains(value: unknown, needle: string): boolean {
  return String(value ?? '').toLowerCase().includes(needle.toLowerCase());
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byCitation(left: { citation: string }, right: { citation: string }): number {
  return compareText(left.citation, right.citation);
}

function byRuleOrder(left: { strength: OntologyRule['strength']; match: 'matched' | 'not_matched' | 'unknown'; citation: string },
  right: { strength: OntologyRule['strength']; match: 'matched' | 'not_matched' | 'unknown'; citation: string }): number {
  const requirementRank = (strength: OntologyRule['strength']) => strength === 'required' ? 0 : 1;
  const matchRank = (match: 'matched' | 'not_matched' | 'unknown') => match === 'matched' ? 0 : match === 'unknown' ? 1 : 2;
  return requirementRank(left.strength) - requirementRank(right.strength)
    || matchRank(left.match) - matchRank(right.match)
    || byCitation(left, right);
}

export function ontologyQueryReadRef(
  row: Record<string, unknown>,
  kind: OntologyQueryReadRef['kind'],
): OntologyQueryReadRef | undefined {
  const module = row.module && typeof row.module === 'object' ? row.module as Record<string, unknown> : {};
  const source = row.source && typeof row.source === 'object' ? row.source as Record<string, unknown> : {};
  const sourceKind = source.kind;
  const recordVersion = Number(source.version);
  if (typeof module.id !== 'string' || typeof source.recordId !== 'string'
    || !['user', 'candidate', 'legacy'].includes(String(sourceKind))
    || !Number.isSafeInteger(recordVersion)) return undefined;
  return { moduleId: module.id, recordId: source.recordId, recordVersion,
    kind, sourceKind: sourceKind as OntologyQueryReadRef['sourceKind'] };
}

function uniqueReadRefs(rows: readonly Record<string, unknown>[], kind: OntologyQueryReadRef['kind']): OntologyQueryReadRef[] {
  const refs = new Map<string, OntologyQueryReadRef>();
  for (const row of rows) {
    const ref = ontologyQueryReadRef(row, kind);
    if (ref) refs.set(`${ref.moduleId}:${ref.recordId}:${ref.recordVersion}`, ref);
  }
  return [...refs.values()];
}

/** Counts what the task scope withholds. Legacy projections are excluded so
 * the signal reflects the current ontology only. */
export function summarizeOntologyScopeExclusion(doc: OntologyDocument, context?: OntologySourceContext): OntologyTaskScopeExcluded {
  const summary: OntologyTaskScopeExcluded = {
    ownerOnly: { modules: 0, records: 0 },
    otherScope: { modules: 0, records: 0 },
  };
  const ownerOnlyModules = new Set<string>();
  const otherScopeModules = new Set<string>();
  for (const record of Object.values(doc.records)) {
    if (record.kind !== 'module' || record.status !== 'active' || record.source.kind === 'legacy') continue;
    if (record.access === 'owner_only') {
      summary.ownerOnly.modules += 1;
      ownerOnlyModules.add(record.id);
    } else if (!ontologyModuleVisibleToTask(record, context)) {
      summary.otherScope.modules += 1;
      otherScopeModules.add(record.id);
    }
  }
  for (const record of Object.values(doc.records)) {
    if (record.kind === 'module' || record.status !== 'active' || record.source.kind === 'legacy') continue;
    const module = doc.records[record.moduleId];
    if (!module || module.kind !== 'module' || module.status !== 'active') continue;
    if (ownerOnlyModules.has(module.id) || record.access === 'owner_only') summary.ownerOnly.records += 1;
    else if (otherScopeModules.has(module.id)) summary.otherScope.records += 1;
  }
  return summary;
}

export async function runOntologyTaskQuery(
  request: OntologyTaskQueryRequest,
  document?: OntologyDocument,
): Promise<OntologyTaskQueryResult> {
  const limits = normalizedLimits(request.limits);
  const queries = [...new Set([request.query, ...(request.queries || [])].map(value => String(value || '').trim()).filter(Boolean))];
  if (!queries.length) throw new Error('ontology task query requires a query');
  const moduleId = request.moduleId ? validateOntologyId(request.moduleId) : undefined;
  const entityId = request.entityId ? validateOntologyId(request.entityId) : undefined;
  const at = request.at;
  if (!isCalendarDate(at)) throw new OntologyError('invalid_time', 'query date must be a calendar day');

  const sourceDoc = document ?? await readOntologyView(request.userId);
  const sourceStatuses = await assessOntologySources(request.userId, sourceDoc, request.context);
  // Coverage follows the modules this query actually depends on. Searching the
  // pre-admission document keeps a relevant module visible even when its source
  // is disabled, without counting unrelated visible modules that were never hit.
  const coverageSearchResults = queries.map(query => searchOntologyRecordsWithMeta(sourceDoc, query, undefined, { taskOnly: true }));
  const coverageModuleIds = new Set<string>();
  for (const result of coverageSearchResults) for (const row of result.rows) {
    const relatedModuleId = row.kind === 'module' ? row.id : row.moduleId;
    if (relatedModuleId) coverageModuleIds.add(String(relatedModuleId));
  }
  if (moduleId) coverageModuleIds.add(moduleId);
  const doc = ontologyWithAdmittedSources(sourceDoc, sourceStatuses);
  const searchTruncated = coverageSearchResults.some(result => result.truncated);
  const candidateRows = coverageSearchResults.flatMap(result => result.rows)
    .filter(row => Boolean(doc.records[row.id]));
  const modules = Object.values(doc.records).filter((row): row is Extract<OntologyRecord, { kind: 'module' }> => (
    row.kind === 'module' && row.status === 'active' && ontologyModuleVisibleToTask(row, request.context)
  )).sort((left, right) => compareText(left.id, right.id));
  let targetModules = modules;
  if (moduleId) {
    const selected = doc.records[moduleId];
    if (!selected || selected.kind !== 'module' || !ontologyModuleVisibleToTask(selected, request.context))
      throw new OntologyError('not_authorized', '所选本体不存在或不属于当前任务范围');
    targetModules = [selected];
  } else {
    const moduleIds = new Set(candidateRows.flatMap(row => [row.kind === 'module' ? row.id : row.moduleId]
      .filter((value): value is string => Boolean(value))));
    targetModules = modules.filter(module => moduleIds.has(module.id));
  }
  for (const module of targetModules) coverageModuleIds.add(module.id);
  const queryModules = targetModules.slice(0, limits.maxModules);
  const visibleModuleIds = new Set(modules.map(module => module.id));
  const scopedCandidateRows = candidateRows.filter(row => visibleModuleIds.has(
    row.kind === 'module' ? row.id : String(row.moduleId || ''),
  ));
  const candidateRowIds = new Map(scopedCandidateRows.map(row => [row.id, row]));
  const entityIds = new Set(scopedCandidateRows.filter(row => row.kind === 'entity').map(row => row.id));
  const definitionIds = new Set(scopedCandidateRows.filter(row => row.kind === 'definition').map(row => row.id));
  const facts: OntologyQueryFactRow[] = [];
  const uncertain: OntologyQueryFactRow[] = [];
  const rules: OntologyQueryRuleRow[] = [];
  const visible = (value: unknown) => queries.some(query => contains(value, query));
  const resolvedRecords = new Map<string, ReturnType<typeof resolveOntologyRecordForModule>>();
  const resolveRecord = (targetModuleId: string, recordId: string) => {
    const key = `${targetModuleId}\0${recordId}`;
    if (!resolvedRecords.has(key)) resolvedRecords.set(key, resolveOntologyRecordForModule(doc, targetModuleId, recordId));
    return resolvedRecords.get(key);
  };

  for (const module of queryModules) {
    const queried = queryOntologyFacts(doc, { moduleId: module.id, at });
    const relevant = (assertion: typeof queried.matched[number]) => {
      const definition = resolveRecord(module.id, assertion.definitionId);
      const subject = resolveRecord(module.id, assertion.subjectId);
      const object = assertion.object.kind === 'entity'
        ? resolveRecord(module.id, assertion.object.id) : null;
      const sourceModule = doc.records[assertion.moduleId];
      if (!sourceModule || sourceModule.kind !== 'module' || !ontologyModuleVisibleToTask(sourceModule, request.context)) return false;
      if (moduleId) return true;
      return candidateRowIds.has(module.id) || entityIds.has(assertion.subjectId)
        || (assertion.object.kind === 'entity' && entityIds.has(assertion.object.id))
        || definitionIds.has(assertion.definitionId)
        || visible(definition?.kind === 'definition' ? definition.name : '')
        || visible(subject?.kind === 'entity' ? subject.name : '')
        || visible(object?.kind === 'entity' ? object.name : assertion.object.kind === 'literal' ? assertion.object.value : '');
    };
    const toFact = (assertion: typeof queried.matched[number], match: 'matched' | 'unknown'): OntologyQueryFactRow => {
      const subject = resolveRecord(module.id, assertion.subjectId);
      const definition = resolveRecord(module.id, assertion.definitionId);
      const object = assertion.object.kind === 'entity'
        ? resolveRecord(module.id, assertion.object.id) : null;
      return {
        match,
        statement: `${subject?.kind === 'entity' ? subject.name : assertion.subjectId} · ${definition?.kind === 'definition' ? definition.name : assertion.definitionId} · ${object?.kind === 'entity' ? object.name : assertion.object.kind === 'literal' ? assertion.object.value : assertion.object.id}`,
        validity: assertion.validity,
        module: { id: assertion.moduleId, name: (doc.records[assertion.moduleId] as { name?: string })?.name },
        citation: citation(assertion.moduleId, assertion.id, assertion.version),
        source: { recordId: assertion.id, version: assertion.version, label: assertion.source.label, kind: assertion.source.kind },
      };
    };
    for (const assertion of queried.matched.filter(relevant)) facts.push(toFact(assertion, 'matched'));
    for (const assertion of queried.uncertain.filter(relevant)) uncertain.push(toFact(assertion, 'unknown'));
    for (const result of queryOntologyRules(doc, {
      moduleId: module.id,
      task: {
        at,
        ...(request.purpose ? { purpose: request.purpose } : {}),
        ...(request.taskKind ? { taskKind: request.taskKind } : {}),
        ...(entityId ? { entityId } : {}),
      },
    })) {
      const sourceModule = doc.records[result.rule.moduleId];
      if (!sourceModule || sourceModule.kind !== 'module' || !ontologyModuleVisibleToTask(sourceModule, request.context)) continue;
      if (!moduleId && result.match === 'not_matched'
        && !visible(result.rule.name) && !visible(result.rule.requirement)) continue;
      const effect = result.rule.effect.kind === 'include_recipient'
        ? { ...result.rule.effect, entityName: (() => {
            const recipient = resolveRecord(module.id, result.rule.effect.entityId);
            return recipient?.kind === 'entity' ? recipient.name : '';
          })() }
        : result.rule.effect;
      rules.push({
        name: result.rule.name,
        requirement: result.rule.requirement,
        strength: result.rule.strength,
        match: result.match,
        exception: result.rule.exception,
        effect,
        module: { id: result.rule.moduleId, name: sourceModule.name },
        citation: citation(result.rule.moduleId, result.rule.id, result.rule.version),
        source: { recordId: result.rule.id, version: result.rule.version, label: result.rule.source.label, kind: result.rule.source.kind },
      });
    }
  }

  facts.sort(byCitation);
  uncertain.sort(byCitation);
  rules.sort(byRuleOrder);
  const visibleFacts = facts.slice(0, limits.maxFacts);
  const visibleUncertainFacts = uncertain.slice(0, limits.maxUncertainFacts);
  const visibleRules = rules.slice(0, limits.maxRules);
  const choiceGroups = new Map<string, Array<{ value: string; match: string; recordId: string; moduleId: string; version: number; sourceKind: string }>>();
  for (const rule of rules) {
    const effect = rule.effect;
    if (effect.kind !== 'choice' || !effect.key || typeof effect.value !== 'string' || rule.match === 'not_matched') continue;
    choiceGroups.set(effect.key, [...(choiceGroups.get(effect.key) || []), {
      value: effect.value,
      match: String(rule.match),
      recordId: String(rule.source.recordId || ''),
      moduleId: String(rule.module.id || ''),
      version: Number(rule.source.version || 0),
      sourceKind: String(rule.source.kind || ''),
    }]);
  }
  const conflictGroups = [...choiceGroups]
    .filter(([, entries]) => new Set(entries.map(item => item.value)).size > 1)
    .sort(([left], [right]) => compareText(left, right));
  const conflicts = conflictGroups.slice(0, limits.maxConflicts).map(([key, entries]) => {
    const sortedEntries = [...entries].sort((left, right) => (
      compareText(left.moduleId, right.moduleId) || compareText(left.recordId, right.recordId)
      || left.version - right.version
    ));
    return {
      key,
      values: [...new Set(sortedEntries.map(item => item.value))].sort(compareText).slice(0, 10),
      state: sortedEntries.some(item => item.match === 'unknown') ? 'potential' as const : 'confirmed' as const,
      sources: sortedEntries.slice(0, 10),
      omittedSourceCount: Math.max(0, sortedEntries.length - 10),
    };
  });

  const relatedRecords = Object.values(doc.records).filter(record => (
    queryModules.some(module => (record.kind === 'module' ? record.id : record.moduleId) === module.id)
    && record.access === 'task'
    && record.status === 'active'
    && (record.kind !== 'assertion' || [...visibleFacts, ...visibleUncertainFacts]
      .some(fact => String(fact.source.recordId) === record.id))
  )).sort((left, right) => compareText(left.id, right.id));
  const readRefs = [
    ...uniqueReadRefs(visibleFacts as unknown as Array<Record<string, unknown>>, 'assertion'),
    ...uniqueReadRefs(visibleUncertainFacts as unknown as Array<Record<string, unknown>>, 'assertion'),
    ...uniqueReadRefs(visibleRules as unknown as Array<Record<string, unknown>>, 'rule'),
  ];
  const inScopeForCoverage = Object.values(sourceDoc.records).filter(record => {
    const moduleId = record.kind === 'module' ? record.id : record.moduleId;
    if (!coverageModuleIds.has(moduleId)) return false;
    const module = sourceDoc.records[moduleId];
    if (!module || module.kind !== 'module' || module.status !== 'active'
      || !ontologyModuleVisibleToTask(module, request.context)) return false;
    return record.kind === 'module' || (record.status === 'active' && record.access === 'task');
  });
  const sourceCoverageComplete = inScopeForCoverage.every(record => sourceStatuses.get(record.id) === 'allowed');
  const conflictsComplete = rules.length <= limits.maxRules && targetModules.length <= limits.maxModules
    && conflictGroups.length <= limits.maxConflicts
    && conflicts.every(conflict => conflict.omittedSourceCount === 0);

  return {
    query: request.query,
    at,
    modules: queryModules.map(module => ({ id: module.id, name: module.name, scope: module.scope })),
    revision: doc.revision,
    records: relatedRecords.slice(0, limits.maxRecords),
    facts: visibleFacts,
    uncertainFacts: visibleUncertainFacts,
    rules: visibleRules,
    conflicts,
    conflictsComplete,
    searchTruncated,
    truncated: {
      facts: Math.max(0, facts.length - limits.maxFacts),
      uncertainFacts: Math.max(0, uncertain.length - limits.maxUncertainFacts),
      rules: Math.max(0, rules.length - limits.maxRules),
      modules: Math.max(0, targetModules.length - limits.maxModules),
      records: Math.max(0, relatedRecords.length - limits.maxRecords),
    },
    queryScope: 'task_topic_search_not_owner_inventory',
    sourceCoverage: { complete: sourceCoverageComplete },
    scopeExcluded: summarizeOntologyScopeExclusion(sourceDoc, request.context),
    useBoundary: ONTOLOGY_TASK_USE_BOUNDARY,
    readRefs,
  };
}
