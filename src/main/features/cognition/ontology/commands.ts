/** 纯命令落地：提交前在草稿上检查身份、引用、基线和时间；失败不改变输入。 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  OntologyError, boundedJson, isCalendarDate, validateOntologyDocument, validateOntologyId,
  validateOntologyRecord, ontologyValueSchema,
  type OntologyDocument, type OntologyRecord, type OntologyDefinition, type OntologyAssertion,
  type OntologyValue, type OntologyReceipt,
} from './model';

export type OntologyAction =
  | { intent: 'create'; recordId?: string; record: Record<string, unknown>; sourceLabel: string }
  | { intent: 'update'; recordId: string; expectedVersion: number; patch: Record<string, unknown>; sourceLabel: string }
  | { intent: 'restore'; recordId: string; expectedVersion: number; sourceLabel: string }
  | { intent: 'merge'; recordId: string; expectedVersion: number; targetId: string; expectedTargetVersion: number; sourceLabel: string }
  | { intent: 'undo_command'; recordId: string; expectedVersion: number; originalCommandId: string; sourceLabel: string }
  | { intent: 'undo_merge'; recordId: string; expectedVersion: number; mergeCommandId: string; sourceLabel: string }
  | { intent: 'archive'; recordId: string; expectedVersion: number; sourceLabel: string }
  | { intent: 'delete'; recordId: string; expectedVersion: number; sourceLabel: string }
  | { intent: 'change'; recordId: string; expectedVersion: number; effectiveFrom: string; certainty?: 'confirmed' | 'inferred' | 'unknown'; object?: OntologyValue; subjectId?: string; sourceLabel: string }
  | { intent: 'correct'; recordId: string; expectedVersion: number; certainty?: 'confirmed' | 'inferred' | 'unknown'; object?: OntologyValue; subjectId?: string; sourceLabel: string };
export interface OntologyCommand { commandId: string; expectedRevision: number; actions: OntologyAction[] }
export interface OntologyCommandSourceOverride { kind: 'candidate' | 'legacy'; recordId: string; label: string }
const key = z.string().refine(value => { try { validateOntologyId(value); return true; } catch { return false; } });
const sourceLabel = z.string().trim().min(1).max(200);
const target = { recordId: key, expectedVersion: z.number().int().positive(), sourceLabel };
const commandSchema = z.object({ commandId: key, expectedRevision: z.number().int().nonnegative(),
  actions: z.array(z.discriminatedUnion('intent', [
    z.object({ intent: z.literal('create'), recordId: key.optional(), record: z.record(z.unknown()), sourceLabel }).strict(),
    z.object({ intent: z.literal('update'), ...target, patch: z.record(z.unknown()) }).strict(),
    z.object({ intent: z.literal('archive'), ...target }).strict(),
    z.object({ intent: z.literal('delete'), ...target }).strict(),
    z.object({ intent: z.literal('restore'), ...target }).strict(),
    z.object({ intent: z.literal('merge'), ...target, targetId: key, expectedTargetVersion: z.number().int().positive() }).strict(),
    z.object({ intent: z.literal('undo_command'), ...target, originalCommandId: key }).strict(),
    z.object({ intent: z.literal('undo_merge'), ...target, mergeCommandId: key }).strict(),
    z.object({ intent: z.literal('change'), ...target, effectiveFrom: z.string(), certainty: z.enum(['confirmed', 'inferred', 'unknown']).optional(), object: ontologyValueSchema.optional(), subjectId: key.optional() }).strict(),
    z.object({ intent: z.literal('correct'), ...target, certainty: z.enum(['confirmed', 'inferred', 'unknown']).optional(), object: ontologyValueSchema.optional(), subjectId: key.optional() }).strict(),
  ])).min(1).max(50),
}).strict();
export function validateOntologyCommand(raw: unknown): OntologyCommand {
  boundedJson(raw);
  let serialized: string;
  try { serialized = JSON.stringify(raw); } catch { throw new OntologyError('invalid_input', 'ontology command must be JSON'); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) throw new OntologyError('invalid_input', 'ontology command too large');
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new OntologyError('invalid_input', 'invalid ontology command: ' + parsed.error.issues.slice(0,8).map(issue => issue.path.join('.') + ' ' + issue.message).join('; '), { issues: parsed.error.issues.slice(0,8).map(issue => ({ path: issue.path, message: issue.message,
    ...(issue.code === 'unrecognized_keys' ? { keys: issue.keys } : {}) })) });
  if (parsed.data.actions.length !== 1 && parsed.data.actions.some(a => a.intent === 'merge' || a.intent === 'undo_merge' || a.intent === 'undo_command'))
    throw new OntologyError('invalid_input', 'identity merge must be reviewed as one standalone operation');
  if (parsed.data.actions.some(a => (a.intent === 'change' || a.intent === 'correct') && !a.object && !a.subjectId))
    throw new OntologyError('invalid_input', 'fact change requires a new subject or object');
  return parsed.data as OntologyCommand;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function ontologyCommandHash(command: OntologyCommand): string {
  return createHash('sha256').update(canonical(command)).digest('hex');
}
function requireRecord(doc: OntologyDocument, id: string, kind?: OntologyRecord['kind']): OntologyRecord {
  const record = doc.records[id];
  if (!record || (kind && record.kind !== kind)) throw new OntologyError('not_found', 'ontology record unavailable', { recordId: id });
  return record;
}
export function moduleCanUse(doc: OntologyDocument, moduleId: string, record: OntologyRecord): boolean {
  if (record.kind === 'module') return moduleId === record.id;
  if (record.moduleId === moduleId) return true;
  const sourceModule = doc.records[record.moduleId];
  const current = doc.records[record.id];
  if (record.access !== 'task' || current?.status !== 'active' || current.access !== 'task'
    || sourceModule?.kind !== 'module' || sourceModule.status !== 'active' || sourceModule.access !== 'task') return false;
  return Object.values(doc.records).some(ref => ref.kind === 'reference' && ref.status === 'active' && ref.access === 'task'
    && ref.moduleId === moduleId && ref.targetModuleId === record.moduleId
    && (!ref.targetRecordId || ref.targetRecordId === record.id)
    && (ref.versionPolicy === 'current' || (ref.targetRecordId
      ? ref.targetVersion === record.version || doc.history.some(entry => entry.after.id === record.id && entry.after.version === ref.targetVersion)
      : ref.targetVersion === doc.records[record.moduleId]?.version
        || doc.history.some(entry => entry.after.id === record.moduleId && entry.after.version === ref.targetVersion))));
}
/** Resolve the exact record version a module is allowed to reference. */
export function resolveOntologyRecordForModule(doc: OntologyDocument, moduleId: string, recordId: string): OntologyRecord | undefined {
  const current = doc.records[recordId];
  if (!current || !moduleCanUse(doc, moduleId, current)) return undefined;
  if (current.kind === 'module' || current.moduleId === moduleId) return current;
  const pin = Object.values(doc.records).find(ref => ref.kind === 'reference' && ref.status === 'active'
    && ref.access === 'task' && ref.moduleId === moduleId && ref.targetModuleId === current.moduleId
    && ref.targetRecordId === recordId && ref.versionPolicy === 'pinned');
  if (pin?.kind !== 'reference' || !pin.targetVersion || pin.targetVersion === current.version) return current;
  return [...doc.history].reverse().find(entry => entry.after.id === recordId && entry.after.version === pin.targetVersion)?.after;
}
function usable(doc: OntologyDocument, moduleId: string, id: string, kind: OntologyRecord['kind'], access: OntologyRecord['access'] = 'task'): OntologyRecord {
  let record = requireRecord(doc, id, kind);
  if (record.kind !== 'module' && record.moduleId !== moduleId) {
    const resolved = resolveOntologyRecordForModule(doc, moduleId, record.id);
    if (resolved) record = resolved;
  }
  const home = record.kind === 'module' ? record : requireRecord(doc, record.moduleId, 'module');
  if (record.status !== 'active' || home.status !== 'active' || (access === 'task' && (record.access !== 'task' || home.access !== 'task'))
    || !moduleCanUse(doc, moduleId, record))
    throw new OntologyError('not_authorized', 'ontology record is not available in this module', { recordId: id });
  return record;
}
const intervalStart = (value: string | null) => value === null ? '' : value.length === 7 ? value + '-01' : value;
const intervalEnd = (value: string | null) => value === null ? '9999-12-31' : value.length === 7 ? value + '-01' : value;
export function intervalsOverlap(a: OntologyAssertion, b: OntologyAssertion): boolean {
  return intervalStart(a.validity.from) < intervalEnd(b.validity.until)
    && intervalStart(b.validity.from) < intervalEnd(a.validity.until);
}
function sameValue(a: OntologyValue, b: OntologyValue): boolean { return canonical(a) === canonical(b); }
/** One bucket per module + predicate; rebuilt per command and maintained by
 * save(). Conflict checks stay linear instead of scanning every record. */
interface AssertionIndex {
  bySlot: Map<string, OntologyAssertion[]>;
  slotById: Map<string, string>;
}
const assertionSlot = (record: OntologyAssertion): string => `${record.moduleId}\0${record.definitionId}`;
function buildAssertionIndex(doc: OntologyDocument): AssertionIndex {
  const index: AssertionIndex = { bySlot: new Map(), slotById: new Map() };
  for (const record of Object.values(doc.records)) addAssertionToIndex(index, record);
  return index;
}
function addAssertionToIndex(index: AssertionIndex, record: OntologyRecord): void {
  if (record.kind !== 'assertion') return;
  const slot = assertionSlot(record);
  const bucket = index.bySlot.get(slot);
  if (bucket) bucket.push(record); else index.bySlot.set(slot, [record]);
  index.slotById.set(record.id, slot);
}
function removeAssertionFromIndex(index: AssertionIndex, id: string): void {
  const slot = index.slotById.get(id);
  if (slot === undefined) return;
  const bucket = index.bySlot.get(slot);
  const position = bucket?.findIndex(record => record.id === id) ?? -1;
  if (bucket && position >= 0) bucket.splice(position, 1);
  if (bucket && !bucket.length) index.bySlot.delete(slot);
  index.slotById.delete(id);
}
function assertRuleCondition(doc: OntologyDocument, moduleId: string, condition: import('./model').OntologyCondition | null, access: OntologyRecord['access']): void {
  if (!condition) return;
  if (condition.kind === 'all' || condition.kind === 'any') {
    condition.conditions.forEach(child => assertRuleCondition(doc, moduleId, child, access)); return;
  }
  if (condition.kind === 'not') { assertRuleCondition(doc, moduleId, condition.condition, access); return; }
  if (condition.kind !== 'assertion') return;
  const definition = usable(doc, moduleId, condition.definitionId, 'definition', access) as OntologyDefinition;
  if (definition.definitionKind === 'type') throw new OntologyError('invalid_rule', 'rule condition must use a relation or attribute');
  const subject = usable(doc, moduleId, condition.subjectId, 'entity', access);
  if (subject.kind !== 'entity' || subject.identityStatus !== 'confirmed') throw new OntologyError('ambiguous_identity', 'rule subject identity is unresolved');
  if (definition.subjectTypes.length && !definition.subjectTypes.includes(subject.typeId)) throw new OntologyError('invalid_rule', 'rule subject type mismatch');
  if (!condition.object) return;
  if (condition.object.kind === 'entity') {
    if (definition.valueType !== 'entity') throw new OntologyError('invalid_rule', 'rule object type mismatch');
    const object = usable(doc, moduleId, condition.object.id, 'entity', access);
    if (object.kind !== 'entity' || object.identityStatus !== 'confirmed'
      || (definition.objectTypes.length && !definition.objectTypes.includes(object.typeId))) throw new OntologyError('invalid_rule', 'rule object identity or type mismatch');
  } else if (definition.valueType !== condition.object.valueType) throw new OntologyError('invalid_rule', 'rule literal type mismatch');
}
function assertRecordSemantics(doc: OntologyDocument, record: OntologyRecord, assertions?: AssertionIndex): void {
  if (record.kind === 'module') return;
  const parentModule = requireRecord(doc, record.moduleId, 'module');
  if (parentModule.status !== 'active' || (record.access === 'task' && parentModule.access !== 'task'))
    throw new OntologyError('not_authorized', 'ontology module is not active');
  if (record.kind === 'definition') {
    for (const typeId of [...record.subjectTypes, ...record.objectTypes]) {
      const type = usable(doc, record.moduleId, typeId, 'definition', record.access) as OntologyDefinition;
      if (type.definitionKind !== 'type') throw new OntologyError('invalid_type', 'endpoint must reference a type definition');
    }
    if (record.definitionKind === 'relation' && record.valueType !== 'entity')
      throw new OntologyError('invalid_type', 'relation must reference an entity');
    if (record.valueType !== 'entity' && record.cardinalityAnchor === 'object')
      throw new OntologyError('invalid_type', 'literal cardinality must be anchored at subject');
  } else if (record.kind === 'entity') {
    const type = usable(doc, record.moduleId, record.typeId, 'definition', record.access) as OntologyDefinition;
    if (type.definitionKind !== 'type') throw new OntologyError('invalid_type', 'entity must reference a type');
  } else if (record.kind === 'assertion') {
    const definition = usable(doc, record.moduleId, record.definitionId, 'definition', record.access) as OntologyDefinition;
    if (definition.definitionKind === 'type') throw new OntologyError('invalid_type', 'type is not a fact predicate');
    const subject = usable(doc, record.moduleId, record.subjectId, 'entity', record.access);
    if (subject.kind !== 'entity' || subject.identityStatus !== 'confirmed' && (!record.certainty || record.certainty === 'confirmed'))
      throw new OntologyError('ambiguous_identity', 'assertion subject identity is unresolved');
    if (definition.subjectTypes.length && !definition.subjectTypes.includes(subject.typeId))
      throw new OntologyError('invalid_type', 'assertion subject type mismatch');
    if (record.object.kind === 'entity') {
      if (definition.valueType !== 'entity') throw new OntologyError('invalid_type', 'predicate expects a literal');
      const object = usable(doc, record.moduleId, record.object.id, 'entity', record.access);
      if (object.kind !== 'entity' || object.identityStatus !== 'confirmed' && (!record.certainty || record.certainty === 'confirmed'))
        throw new OntologyError('ambiguous_identity', 'assertion object identity is unresolved');
      if (definition.objectTypes.length && !definition.objectTypes.includes(object.typeId))
        throw new OntologyError('invalid_type', 'assertion object type mismatch');
    } else if (definition.valueType !== record.object.valueType) throw new OntologyError('invalid_type', 'assertion literal type mismatch');
    const conflicts = (assertions?.bySlot.get(assertionSlot(record)) ?? Object.values(doc.records)).filter((other): other is OntologyAssertion => {
      if (other.kind !== 'assertion' || other.id === record.id || other.status !== 'active'
        || other.definitionId !== record.definitionId || other.moduleId !== record.moduleId) return false;
      const slot = definition.cardinalityAnchor === 'subject' ? other.subjectId === record.subjectId
        : sameValue(other.object, record.object);
      const different = definition.cardinalityAnchor === 'subject' ? !sameValue(other.object, record.object)
        : other.subjectId !== record.subjectId;
      return definition.cardinality === 'one' && slot && different && intervalsOverlap(record, other);
    });
    if (conflicts.length) throw new OntologyError('conflicting_facts', 'single-valued relationship has overlapping facts', { recordIds: conflicts.map(r => r.id) });
  } else if (record.kind === 'reference') {
    const targetModule = requireRecord(doc, record.targetModuleId, 'module');
    if (targetModule.status !== 'active' || record.moduleId === record.targetModuleId
      || (record.access === 'task' && targetModule.access !== 'task'))
      throw new OntologyError('invalid_reference', 'reference target unavailable');
    const target = record.targetRecordId ? requireRecord(doc, record.targetRecordId) : targetModule;
    if ((target.kind === 'module' ? target.id : target.moduleId) !== record.targetModuleId)
      throw new OntologyError('invalid_reference', 'reference target module mismatch');
    if (record.versionPolicy === 'pinned' && !record.targetRecordId)
      throw new OntologyError('invalid_reference', 'pin a specific record version, not a changing module as a whole');
    if (record.versionPolicy === 'pinned' && record.targetVersion !== target.version)
      throw new OntologyError('baseline_changed', 'reference version does not match target');
    if (record.versionPolicy === 'current' && record.targetVersion !== undefined)
      throw new OntologyError('invalid_reference', 'current reference cannot specify a pinned version');
  } else if (record.kind === 'rule') {
    assertRuleCondition(doc, record.moduleId, record.condition, record.access);
    if (record.effect.kind === 'include_recipient') usable(doc, record.moduleId, record.effect.entityId, 'entity', record.access);
  }
}
function assertSummaryPoints(doc: OntologyDocument, module: Extract<OntologyRecord, { kind: 'module' }>): void {
  for (const point of module.summaryPoints || []) {
    for (const evidenceId of point.evidenceIds) {
      const evidence = doc.records[evidenceId];
      if (!evidence || evidence.kind === 'module' || evidence.kind === 'reference'
        || evidence.moduleId !== module.id)
        throw new OntologyError('invalid_reference', 'summary evidence unavailable', { recordId: evidenceId });
      if (module.access === 'task' && evidence.access !== 'task')
        throw new OntologyError('not_authorized', 'summary evidence exceeds module access', { recordId: evidenceId });
    }
  }
}
export interface OntologyCommandOutcome { document: OntologyDocument; receipt: OntologyReceipt; duplicate: boolean }
/** Editing authorship is not a replacement source grant. Keep the previous
 * candidate/asset chain on successors, lifecycle changes and merge redirects. */
function preserveEditSources(value: Record<string, unknown>, before?: OntologyRecord): Record<string, unknown> {
  if (!before || !value.source || typeof value.source !== 'object') return value;
  const source = value.source as OntologyRecord['source'];
  const refs = [...(source.refs || []), ...(before.source.refs || [])];
  if (source.kind === 'user' && before.source.kind !== 'user' && before.source.recordId)
    refs.push({ kind: before.source.kind, id: before.source.recordId });
  const unique = [...new Map(refs.map(ref => [`${ref.kind}:${ref.id}`, ref])).values()];
  return { ...value, source: { ...source, ...(unique.length ? { refs: unique } : {}) } };
}
export function applyOntologyCommand(current: OntologyDocument, input: unknown, recordedAt: string, sourceOverride?: OntologyCommandSourceOverride): OntologyCommandOutcome {
  const command = validateOntologyCommand(input);
  if (sourceOverride) {
    validateOntologyId(sourceOverride.recordId);
    if (!['candidate', 'legacy'].includes(sourceOverride.kind) || typeof sourceOverride.label !== 'string' || !sourceOverride.label.trim() || sourceOverride.label.length > 200)
      throw new OntologyError('invalid_input', 'invalid ontology candidate source');
  }
  const requestHash = sourceOverride
    ? createHash('sha256').update(`${ontologyCommandHash(command)}\n${canonical(sourceOverride)}`).digest('hex')
    : ontologyCommandHash(command);
  const old = current.receipts[command.commandId];
  if (old) {
    if (old.requestHash !== requestHash) throw new OntologyError('command_reused', 'command id reused with different input');
    return { document: current, receipt: old, duplicate: true };
  }
  if (command.expectedRevision !== current.revision)
    throw new OntologyError('baseline_changed', 'ontology changed since it was loaded', { expected: command.expectedRevision, actual: current.revision });
  const doc: OntologyDocument = structuredClone(current), changed = new Set<string>();
  const summaryTouched = new Set<string>();
  const assertions = buildAssertionIndex(doc);
  if (Object.keys(doc.receipts).length >= 20000 || doc.history.length + command.actions.length * 2 > 100000)
    throw new OntologyError('capacity_exceeded',
      `ontology change history is full (${doc.history.length}/100000 entries, ${Object.keys(doc.receipts).length}/20000 commands); archive older changes before adding more`,
      { limit: 100000, current: doc.history.length, receipts: Object.keys(doc.receipts).length, remedy: 'archive_history' });
  function save(value: unknown, intent: string, before?: OntologyRecord, sourceBefore = before): OntologyRecord {
    const record = validateOntologyRecord(preserveEditSources(value as Record<string, unknown>, sourceBefore));
    removeAssertionFromIndex(assertions, record.id);
    doc.records[record.id] = record;
    addAssertionToIndex(assertions, record);
    doc.history.push({ commandId: command.commandId, revision: current.revision + 1, intent, recordedAt, ...(before ? { before } : {}), after: structuredClone(record) });
    changed.add(record.id); return record;
  }
  const newId = (index: string) => 'ont-' + createHash('sha256').update(current.ownerId + ':' + command.commandId + ':' + index).digest('hex').slice(0, 24);
  command.actions.forEach((action, index) => {
    const source = sourceOverride ? { ...sourceOverride, label: sourceOverride.label.trim() } : { kind: 'user' as const, label: action.sourceLabel };
    if (action.intent === 'create') {
      if (Object.keys(doc.records).length >= 25000) throw new OntologyError('capacity_exceeded',
        `ontology record capacity is full (${Object.keys(doc.records).length}/25000 records); export the ontology and split it into modules before adding more`,
        { limit: 25000, current: Object.keys(doc.records).length, remedy: 'export_and_split' });
      const id = action.recordId || newId(String(index));
      if (doc.records[id]) throw new OntologyError('already_exists', 'ontology id is already in use');
      if (['id', 'version', 'status', 'createdAt', 'updatedAt', 'source'].some(key => Object.hasOwn(action.record, key)))
        throw new OntologyError('invalid_input', 'record metadata is assigned by the service');
      save({ ...action.record, id, version: 1, access: action.record.access ?? 'task', status: 'active', source, createdAt: recordedAt, updatedAt: recordedAt }, action.intent);
      const saved = doc.records[id];
      if (saved.kind === 'module' && saved.summaryPoints?.length) summaryTouched.add(saved.id);
      return;
    }
    const before = structuredClone(requireRecord(doc, action.recordId));
    if (before.version !== action.expectedVersion) throw new OntologyError('baseline_changed', 'record version changed', { recordId: before.id });
    if (before.status === 'archived' && [...doc.history].reverse().find(row => row.after.id === before.id)?.intent === 'merge_source'
      && action.intent !== 'undo_merge')
      throw new OntologyError('invalid_intent', 'merged identities require undo_merge to restore their references');
    if (action.intent === 'undo_command') {
      // The inverse comes exclusively from immutable committed history, never
      // from caller-supplied snapshots. Preserve newer edits and dependencies.
      if (sourceOverride) throw new OntologyError('invalid_intent', 'candidate formation cannot undo a saved command');
      const original = doc.receipts[action.originalCommandId];
      const entries = doc.history.filter(row => row.commandId === action.originalCommandId);
      if (!original || !entries.length || !original.changedIds.includes(action.recordId)
        || entries.some(row => row.intent.startsWith('undo_')))
        throw new OntologyError('invalid_intent', 'a committed forward command is required');
      const first = new Map<string, typeof entries[number]>(), last = new Map<string, typeof entries[number]>();
      for (const row of entries) { if (!first.has(row.after.id)) first.set(row.after.id, row); last.set(row.after.id, row); }
      for (const [id, row] of last) if (!isDeepStrictEqual(doc.records[id], row.after))
        throw new OntologyError('baseline_changed', 'saved impact has subsequent changes; compare again', { recordId: id });
      for (const record of Object.values(doc.records)) if (record.status === 'active' && record.kind === 'reference'
        && !last.has(record.id) && (last.has(record.targetModuleId) || record.targetRecordId && last.has(record.targetRecordId)))
        throw new OntologyError('invalid_reference', 'another module now references the saved impact; compare again', { recordId: record.id });
      for (const [id, row] of first) {
        const latest = last.get(id)!.after;
        // New records remain as historical tombstones; existing records gain
        // a new version restoring their former content and attribution.
        save({ ...(row.before || latest), ...(row.before ? {} : { status: 'archived' }),
          version: latest.version + 1, updatedAt: recordedAt }, 'undo_command', latest);
      }
    } else if (action.intent === 'merge') {
      const targetRecord = structuredClone(requireRecord(doc, action.targetId, 'entity'));
      if (targetRecord.version !== action.expectedTargetVersion) throw new OntologyError('baseline_changed', 'merge target version changed');
      if (before.kind !== 'entity' || targetRecord.kind !== 'entity' || before.id === targetRecord.id
        || before.status !== 'active' || targetRecord.status !== 'active'
        || before.identityStatus !== 'confirmed' || targetRecord.identityStatus !== 'confirmed'
        || before.moduleId !== targetRecord.moduleId || before.typeId !== targetRecord.typeId || before.access !== targetRecord.access
        || doc.records[before.moduleId]?.status !== 'active')
        throw new OntologyError('invalid_intent', 'merge requires two confirmed active identities with the same module, type and access');
      if (action.sourceLabel.trim().length < 5) throw new OntologyError('invalid_input', 'explicit identity evidence is required for merge');
      const redirects: Array<{ before: OntologyRecord; after: OntologyRecord }> = [];
      function redirectCondition(condition: unknown): unknown {
        if (!condition || typeof condition !== 'object') return condition;
        const value = condition as Record<string, unknown>;
        if (value.kind === 'assertion') return { ...value, subjectId: value.subjectId === before.id ? targetRecord.id : value.subjectId,
          ...(value.object ? { object: redirectValue(value.object) } : {}) };
        if (value.kind === 'task' && value.field === 'entityId' && value.equals === before.id) return { ...value, equals: targetRecord.id };
        if (value.kind === 'not') return { ...value, condition: redirectCondition(value.condition) };
        if (value.kind === 'all' || value.kind === 'any') return { ...value, conditions: (value.conditions as unknown[]).map(redirectCondition) };
        return value;
      }
      function redirectValue(value: unknown): unknown {
        const object = value as Record<string, unknown>;
        return object.kind === 'entity' && object.id === before.id ? { ...object, id: targetRecord.id } : object;
      }
      for (const record of Object.values(doc.records)) {
        if (record.status !== 'active') continue;
        let redirected = record;
        if (record.kind === 'assertion') redirected = { ...record, subjectId: record.subjectId === before.id ? targetRecord.id : record.subjectId,
          object: redirectValue(record.object) as OntologyValue };
        else if (record.kind === 'rule') redirected = { ...record, condition: redirectCondition(record.condition) as typeof record.condition,
          effect: record.effect.kind === 'include_recipient' && record.effect.entityId === before.id ? { ...record.effect, entityId: targetRecord.id } : record.effect };
        else if (record.kind === 'reference' && record.targetRecordId === before.id) {
          if (record.versionPolicy === 'pinned') throw new OntologyError('invalid_reference', 'pinned identity references must be reviewed before merge', { recordId: record.id });
          redirected = { ...record, targetRecordId: targetRecord.id };
        }
        if (JSON.stringify(redirected) !== JSON.stringify(record)) redirects.push({ before: structuredClone(record), after: redirected });
      }
      if (redirects.length + 2 > 100 || doc.history.length + redirects.length + 2 > 100000)
        throw new OntologyError('capacity_exceeded',
          `merge would exceed the safe impact limit (${redirects.length} affected records, ${doc.history.length}/100000 history entries); archive older changes or split the merge`,
          { limit: 100, current: redirects.length, history: doc.history.length, remedy: 'archive_history' });
      save({ ...targetRecord, aliases: [...new Set([...targetRecord.aliases, ...before.aliases, before.name])].filter(name => name !== targetRecord.name),
        source, version: targetRecord.version + 1, updatedAt: recordedAt }, 'merge_target', targetRecord);
      for (const redirect of redirects) save({ ...redirect.after, source, version: redirect.before.version + 1, updatedAt: recordedAt }, 'merge_redirect', redirect.before);
      save({ ...before, status: 'archived', source, version: before.version + 1, updatedAt: recordedAt }, 'merge_source', before);
    } else if (action.intent === 'undo_merge') {
      const entries = doc.history.filter(row => row.commandId === action.mergeCommandId && row.intent.startsWith('merge_'));
      if (!entries.some(row => row.intent === 'merge_source' && row.after.id === before.id)
        || entries.some(row => !row.before) || before.status !== 'archived')
        throw new OntologyError('invalid_intent', 'no reversible identity merge for this record');
      if (entries.length > 100 || doc.history.length + entries.length > 100000) throw new OntologyError('capacity_exceeded',
        `merge recovery would exceed history capacity (${entries.length} entries to restore, ${doc.history.length}/100000 used); archive older changes first`,
        { limit: 100000, current: doc.history.length, entries: entries.length, remedy: 'archive_history' });
      for (const entry of entries) {
        const latest = requireRecord(doc, entry.after.id);
        if (latest.version !== entry.after.version || JSON.stringify(latest) !== JSON.stringify(entry.after))
          throw new OntologyError('baseline_changed', 'merge impact changed; automatic recovery refused', { recordId: latest.id });
      }
      for (const entry of entries) save({ ...entry.before, source, version: entry.after.version + 1, updatedAt: recordedAt }, 'undo_merge', entry.after);
    } else if (action.intent === 'update') {
      if (before.kind === 'assertion' && Object.keys(action.patch).some(key => key !== 'access'))
        throw new OntologyError('invalid_intent', 'facts require change or correction, not overwrite');
      if (['id', 'kind', 'moduleId', 'version', 'createdAt', 'updatedAt', 'source'].some(key => Object.hasOwn(action.patch, key)))
        throw new OntologyError('invalid_input', 'record identity cannot be patched');
      if (action.patch.status === 'corrected') throw new OntologyError('invalid_intent', 'corrected status requires a correction command');
      // 模块不能被整体置为 paused；停用具体条目或对象应使用 archive。
      // retireOntologyModulePause 迁移旧 paused 模块，恢复 active 不受此限。
      if (before.kind === 'module' && action.patch.status === 'paused')
        throw new OntologyError('invalid_intent', 'module-level pause is retired; archive individual records instead');
      if (before.kind === 'module' && Object.hasOwn(action.patch, 'summaryPoints')) summaryTouched.add(before.id);
      save({ ...before, ...action.patch, source: { ...source, ...(before.source.refs ? { refs: before.source.refs } : {}) }, version: before.version + 1, updatedAt: recordedAt }, action.intent, before);
    } else if (action.intent === 'restore') {
      if (before.status !== 'archived') throw new OntologyError('invalid_intent', 'only archived records can be restored; corrections retain their history');
      if ([...doc.history].reverse().find(row => row.after.id === before.id)?.intent === 'merge_source')
        throw new OntologyError('invalid_intent', 'merged identities require undo_merge to restore their references');
      save({ ...before, status: 'active', source, version: before.version + 1, updatedAt: recordedAt }, action.intent, before);
    } else if (action.intent === 'archive' || action.intent === 'delete') {
      save({ ...before, status: 'archived', source, version: before.version + 1, updatedAt: recordedAt }, action.intent, before);
    } else {
      if (before.kind !== 'assertion' || before.status !== 'active') throw new OntologyError('invalid_intent', 'only active facts can change or be corrected');
      const successorId = newId(String(index) + '-successor');
      if (doc.records[successorId]) throw new OntologyError('already_exists', 'successor id is already in use');
      if (action.intent === 'change') {
        if (!isCalendarDate(action.effectiveFrom, before.validity.precision)
          || (before.validity.from !== null && action.effectiveFrom <= before.validity.from) || (before.validity.until !== null && action.effectiveFrom >= before.validity.until))
          throw new OntologyError('invalid_time', 'change date must be inside the known fact interval');
        save({ ...before, validity: { ...before.validity, until: action.effectiveFrom }, version: before.version + 1, updatedAt: recordedAt }, 'close_validity', before);
      } else save({ ...before, status: 'corrected', version: before.version + 1, updatedAt: recordedAt }, 'mark_corrected', before);
      save({ ...before, id: successorId, version: 1, object: action.object ?? before.object, subjectId: action.subjectId ?? before.subjectId, source, status: 'active',
        validity: { ...before.validity, ...(action.intent === 'change' ? { from: action.effectiveFrom } : {}) },
        ...(action.certainty ? { certainty: action.certainty } : {}), supersedesId: before.id, createdAt: recordedAt, updatedAt: recordedAt,
      }, action.intent, undefined, before);
    }
  });
  // Check the final batch, so creating a module and its definitions in one atomic group is valid.
  for (const id of changed) {
    const record = doc.records[id];
    if (record.status === 'active') assertRecordSemantics(doc, record, assertions);
  }
  // Definition/reference edits must not invalidate any already saved active content.
  if ([...changed].some(id => ['definition', 'reference', 'entity', 'module'].includes(doc.records[id].kind))) {
    for (const record of Object.values(doc.records)) if (record.status === 'active'
      && (record.kind === 'module' || doc.records[record.moduleId]?.status === 'active')
      && ['entity', 'assertion', 'rule'].includes(record.kind)) assertRecordSemantics(doc, record, assertions);
  }
  for (const id of summaryTouched) {
    const record = doc.records[id];
    if (record?.kind === 'module' && record.status === 'active') assertSummaryPoints(doc, record);
  }
  doc.revision++;
  const receipt: OntologyReceipt = { commandId: command.commandId, requestHash, revision: doc.revision, recordedAt, changedIds: [...changed] };
  doc.receipts[command.commandId] = receipt;
  return { document: validateOntologyDocument(doc), receipt, duplicate: false };
}
