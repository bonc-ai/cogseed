/** Explicit, auditable widening of private ontology modules for task use.
 * The command layer owns validation; this module only plans the dependency
 * order, batches it within the command limit and reports what stays private. */
import { createHash } from 'node:crypto';
import type { OntologyAction } from './commands';
import { ontologyDependencyClosure } from './dependencies';
import { OntologyError, validateOntologyId, type OntologyDocument, type OntologyRecord } from './model';
import { commitOntologyCommand, readOntologyDocument } from './service';

export type OntologyAccessPromotionBlockedReason =
  | 'target_module_unavailable'
  | 'dependency_outside_selection'
  | 'dependency_inactive'
  | 'missing_dependency'
  | 'dependency_blocked';

export interface OntologyAccessPromotionBlocked {
  recordId: string;
  kind: OntologyRecord['kind'];
  reason: OntologyAccessPromotionBlockedReason;
}

export interface OntologyAccessPromotionPlan {
  closure: string[];
  modules: Array<{ id: string; name: string }>;
  counts: {
    modules: number;
    records: number;
    byKind: Record<OntologyRecord['kind'], number>;
  };
  blocked: OntologyAccessPromotionBlocked[];
}

export interface OntologyAccessPromotionBatch {
  commandId: string;
  revision: number;
  changedIds: string[];
}

export interface OntologyAccessPromotionResult {
  promoted: { modules: number; records: number };
  skippedAlreadyTask: number;
  blocked: OntologyAccessPromotionBlocked[];
  batches: OntologyAccessPromotionBatch[];
  retries: number;
  revision: number;
  partial: boolean;
  errorCode?: string;
}

const BATCH_LIMIT = 50;
const MAX_RETRIES = 5;
const SOURCE_LABEL = '用户确认：允许该本体用于任务';

function rank(record: OntologyRecord): number {
  if (record.kind === 'module') return 0;
  if (record.kind === 'reference') return 1;
  if (record.kind === 'definition') return record.definitionKind === 'type' ? 2 : 3;
  if (record.kind === 'entity') return 4;
  if (record.kind === 'assertion') return 5;
  return 6;
}

function moduleOf(record: OntologyRecord): string {
  return record.kind === 'module' ? record.id : record.moduleId;
}

function normalizeModuleIds(doc: OntologyDocument, moduleIds: readonly string[]): string[] {
  if (!Array.isArray(moduleIds) || !moduleIds.length) throw new OntologyError('invalid_input', 'at least one ontology module is required');
  if (moduleIds.length > 20) throw new OntologyError('invalid_input', 'at most 20 ontology modules per promotion');
  const unique = [...new Set(moduleIds.map(value => validateOntologyId(String(value))))];
  for (const id of unique) {
    const record = doc.records[id];
    if (!record || record.kind !== 'module' || record.status !== 'active') throw new OntologyError('not_found', 'ontology module unavailable');
  }
  return unique;
}

function closureOf(doc: OntologyDocument, selection: string[]): {
  closure: Set<string>;
  blockedReferences: OntologyAccessPromotionBlocked[];
} {
  const closure = new Set(selection);
  const blockedReferences = new Map<string, OntologyAccessPromotionBlocked>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const record of Object.values(doc.records)) {
      if (record.kind !== 'reference' || record.status !== 'active' || record.source.kind === 'legacy') continue;
      if (!closure.has(record.moduleId)) continue;
      const target = doc.records[record.targetModuleId];
      if (!target || target.kind !== 'module' || target.status !== 'active') {
        if (record.access === 'owner_only') blockedReferences.set(record.id, {
          recordId: record.id, kind: 'reference', reason: 'target_module_unavailable',
        });
        continue;
      }
      if (!closure.has(target.id)) {
        closure.add(target.id);
        expanded = true;
      }
    }
  }
  return { closure, blockedReferences: [...blockedReferences.values()] };
}

interface InternalPlan extends OntologyAccessPromotionPlan {
  actions: OntologyAction[];
  alreadyTask: number;
}

function buildPlan(doc: OntologyDocument, moduleIds: readonly string[]): InternalPlan {
  const selection = normalizeModuleIds(doc, moduleIds);
  const { closure, blockedReferences } = closureOf(doc, selection);
  const inClosure = (record: OntologyRecord) => closure.has(moduleOf(record));
  const blocked = new Map<string, OntologyAccessPromotionBlocked>();
  for (const entry of blockedReferences) blocked.set(entry.recordId, entry);

  const active = Object.values(doc.records).filter(record => (
    record.status === 'active' && record.source.kind !== 'legacy' && inClosure(record)
  ));
  const alreadyTask = active.filter(record => record.access === 'task').length;
  const candidates = active.filter(record => record.access === 'owner_only');

  for (const record of candidates) {
    if (record.kind === 'module' || blocked.has(record.id)) continue;
    const dependencies = ontologyDependencyClosure(doc.records, [record.id]);
    if (!dependencies) {
      blocked.set(record.id, { recordId: record.id, kind: record.kind, reason: 'missing_dependency' });
      continue;
    }
    for (const dependency of dependencies) {
      if (dependency.id === record.id) continue;
      if (!closure.has(moduleOf(dependency))) {
        blocked.set(record.id, { recordId: record.id, kind: record.kind, reason: 'dependency_outside_selection' });
        break;
      }
      if (dependency.status !== 'active') {
        blocked.set(record.id, { recordId: record.id, kind: record.kind, reason: 'dependency_inactive' });
        break;
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of candidates) {
      if (record.kind === 'module' || blocked.has(record.id)) continue;
      const dependencies = ontologyDependencyClosure(doc.records, [record.id]) || [];
      if (dependencies.some(dependency => dependency.id !== record.id && blocked.has(dependency.id))) {
        blocked.set(record.id, { recordId: record.id, kind: record.kind, reason: 'dependency_blocked' });
        grew = true;
      }
    }
  }

  const actions = candidates.filter(record => !blocked.has(record.id))
    .sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id))
    .map(record => ({
      intent: 'update' as const, recordId: record.id, expectedVersion: record.version,
      patch: { access: 'task' }, sourceLabel: SOURCE_LABEL,
    }));
  const byKind: Record<OntologyRecord['kind'], number> = { module: 0, reference: 0, definition: 0, entity: 0, assertion: 0, rule: 0 };
  for (const action of actions) byKind[doc.records[action.recordId].kind] += 1;
  const modules = [...closure].map(id => doc.records[id])
    .filter((record): record is Extract<OntologyRecord, { kind: 'module' }> => record?.kind === 'module' && record.status === 'active')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(record => ({ id: record.id, name: record.name }));
  return {
    closure: [...closure].sort(),
    modules,
    counts: {
      modules: modules.length,
      records: actions.filter(action => doc.records[action.recordId].kind !== 'module').length,
      byKind,
    },
    blocked: [...blocked.values()].sort((left, right) => left.recordId.localeCompare(right.recordId)),
    actions,
    alreadyTask,
  };
}

function promotionCommandId(actions: OntologyAction[]): string {
  const digest = createHash('sha256')
    .update(actions.map(action => `${action.intent}:${action.recordId}@${'expectedVersion' in action ? action.expectedVersion : 0}`).join('|'))
    .digest('hex').slice(0, 24);
  return `ont-access-promo-${digest}`;
}

/** Read-only plan for the confirmation dialog. */
export function previewOntologyAccessPromotion(userId: string, moduleIds: readonly string[]): OntologyAccessPromotionPlan {
  const { actions: _actions, alreadyTask: _alreadyTask, ...plan } = buildPlan(readOntologyDocument(userId), moduleIds);
  return plan;
}

/** Promote in dependency order, at most 50 actions per command. Commands are
 * idempotent and baseline conflicts re-read and continue; already succeeded
 * batches are never rolled back. */
export async function promoteOntologyAccess(userId: string, moduleIds: readonly string[]): Promise<OntologyAccessPromotionResult> {
  let doc = readOntologyDocument(userId);
  let retries = 0;
  let partial = false;
  let errorCode: string | undefined;
  let skippedAlreadyTask = 0;
  let blocked: OntologyAccessPromotionBlocked[] = [];
  let first = true;
  const promotedModules = new Set<string>();
  const promotedRecords = new Set<string>();
  const batches: OntologyAccessPromotionBatch[] = [];

  while (true) {
    const plan = buildPlan(doc, moduleIds);
    blocked = plan.blocked;
    if (first) {
      skippedAlreadyTask = plan.alreadyTask;
      first = false;
    }
    if (!plan.actions.length) break;
    const actions = plan.actions.slice(0, BATCH_LIMIT);
    const commandId = promotionCommandId(actions);
    try {
      const outcome = await commitOntologyCommand(userId, {
        commandId, expectedRevision: doc.revision, actions,
      }, undefined, undefined, { scheduleGraphGeneration: false });
      batches.push({ commandId, revision: outcome.receipt.revision, changedIds: outcome.receipt.changedIds });
      doc = readOntologyDocument(userId);
      for (const id of outcome.receipt.changedIds) {
        const record = doc.records[id];
        if (!record) continue;
        if (record.kind === 'module') promotedModules.add(id);
        else promotedRecords.add(id);
      }
    } catch (error) {
      if (error instanceof OntologyError && error.code === 'baseline_changed' && retries < MAX_RETRIES) {
        retries += 1;
        doc = readOntologyDocument(userId);
        continue;
      }
      partial = true;
      errorCode = error instanceof OntologyError ? error.code : 'unexpected';
      break;
    }
  }

  if (batches.length) {
    const changedIds = batches.flatMap(batch => batch.changedIds);
    const revision = readOntologyDocument(userId).revision;
    void import('./graph-generation')
      .then(module => module.scheduleGraphGenerationForOntologyChange(userId, changedIds, revision))
      .catch(() => undefined);
  }

  return {
    promoted: { modules: promotedModules.size, records: promotedRecords.size },
    skippedAlreadyTask,
    blocked,
    batches,
    retries,
    revision: readOntologyDocument(userId).revision,
    partial,
    ...(errorCode ? { errorCode } : {}),
  };
}
