/** 本体语义记录：认知主档的一个领域，三盒与图谱均由这些记录派生。 */
import { z } from 'zod';
import { cognitionEditDecisionSchema, type CognitionEditDecision } from '../edit-decision';

export type OntologyKind = 'module' | 'definition' | 'entity' | 'assertion' | 'rule' | 'reference';
export type OntologyStatus = 'active' | 'paused' | 'archived' | 'corrected';
export type OntologyAccess = 'task' | 'owner_only';
export interface OntologySourceRef { kind: 'asset' | 'candidate' | 'legacy'; id: string }
export interface OntologyBase {
  id: string; kind: OntologyKind; version: number; status: OntologyStatus;
  access: OntologyAccess;
  /** Undefined is legacy confirmed; new conversation writes explicitly distinguish uncertainty. */
  certainty?: 'confirmed' | 'inferred' | 'unknown';
  createdAt: string | null; updatedAt: string | null;
  source: { kind: 'user' | 'candidate' | 'legacy'; label: string; recordId?: string;
    refs?: OntologySourceRef[] };
}
export interface OntologySummaryPoint {
  text: string;
  evidenceIds: string[];
}
export interface OntologyModule extends OntologyBase {
  kind: 'module'; name: string; description: string;
  scope: { kind: 'personal' | 'project' | 'workspace'; id?: string };
  summaryPoints?: OntologySummaryPoint[];
  scopeNote?: string;
}
export interface OntologyDefinition extends OntologyBase {
  kind: 'definition'; moduleId: string; name: string; description: string;
  definitionKind: 'type' | 'relation' | 'attribute';
  subjectTypes: string[]; objectTypes: string[];
  valueType: 'entity' | 'text' | 'number' | 'boolean' | 'date';
  cardinality: 'one' | 'many'; cardinalityAnchor: 'subject' | 'object';
}
export interface OntologyEntity extends OntologyBase {
  kind: 'entity'; moduleId: string; typeId: string; name: string;
  description: string; aliases: string[]; identityStatus: 'confirmed' | 'unresolved';
}
export type OntologyValue = { kind: 'entity'; id: string }
  | { kind: 'literal'; valueType: 'text' | 'number' | 'boolean' | 'date'; value: string | number | boolean };
export interface OntologyValidity {
  from: string | null; until: string | null; precision: 'day' | 'month'; timezone: string;
}
export interface OntologyAssertion extends OntologyBase {
  kind: 'assertion'; moduleId: string; subjectId: string; definitionId: string;
  object: OntologyValue; validity: OntologyValidity; supersedesId?: string;
}
export type OntologyCondition = { kind: 'task'; field: 'purpose' | 'taskKind' | 'entityId'; equals: string }
  | { kind: 'assertion'; subjectId: string; definitionId: string; object?: OntologyValue }
  | { kind: 'all' | 'any'; conditions: OntologyCondition[] }
  | { kind: 'not'; condition: OntologyCondition };
export type OntologyEffect = { kind: 'include_recipient'; entityId: string }
  | { kind: 'required_section'; name: string }
  | { kind: 'choice'; key: string; value: string }
  | { kind: 'note' };
export interface OntologyRule extends OntologyBase {
  kind: 'rule'; moduleId: string; name: string; requirement: string;
  strength: 'required' | 'default' | 'suggestion' | 'logic';
  condition: OntologyCondition | null; effect: OntologyEffect;
  exception: string;
}
export interface OntologyReference extends OntologyBase {
  kind: 'reference'; moduleId: string; targetModuleId: string; targetRecordId?: string;
  versionPolicy: 'current' | 'pinned'; targetVersion?: number;
}
export type OntologyRecord = OntologyModule | OntologyDefinition | OntologyEntity
  | OntologyAssertion | OntologyRule | OntologyReference;
export interface OntologyRevision {
  commandId: string; revision: number; intent: string; recordedAt: string;
  before?: OntologyRecord; after: OntologyRecord;
}
export interface OntologyReceipt {
  commandId: string; requestHash: string; revision: number; recordedAt: string;
  changedIds: string[];
  userEditDecision?: CognitionEditDecision;
}
export interface OntologyDocument {
  schemaVersion: 1; ownerId: string; revision: number;
  records: Record<string, OntologyRecord>;
  history: OntologyRevision[];
  receipts: Record<string, OntologyReceipt>;
}
export class OntologyError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message); this.name = 'OntologyError';
  }
}
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
  .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const text = (max = 4000) => z.string().max(max);
const name = z.string().trim().min(1).max(200);
const stamp = z.string().datetime({ offset: true });
export function isCalendarDate(value: string, precision: 'day' | 'month' = 'day'): boolean {
  const pattern = precision === 'day' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
  if (!pattern.test(value) || value.slice(0, 4) === '0000') return false;
  const normalized = precision === 'month' ? value + '-01' : value;
  const date = new Date(normalized + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === normalized;
}
const validity = z.object({
  from: z.string().nullable(), until: z.string().nullable(),
  precision: z.enum(['day', 'month']), timezone: z.string().min(1).max(100),
}).strict().superRefine((v, ctx) => {
  if ([v.from, v.until].some(date => date !== null && !isCalendarDate(date, v.precision)))
    ctx.addIssue({ code: 'custom', message: 'invalid validity date' });
  if (v.from !== null && v.until !== null && v.from >= v.until)
    ctx.addIssue({ code: 'custom', message: 'empty or reversed validity interval' });
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); }
  catch { ctx.addIssue({ code: 'custom', message: 'invalid validity timezone' }); }
});
const entityValue = z.object({ kind: z.literal('entity'), id }).strict();
const literalValue = z.object({ kind: z.literal('literal'), valueType: z.enum(['text', 'number', 'boolean', 'date']),
  value: z.union([text(10000), z.number().finite(), z.boolean()]),
}).strict().superRefine((v, ctx) => {
  const expected = v.valueType === 'number' ? 'number' : v.valueType === 'boolean' ? 'boolean' : 'string';
  if (typeof v.value !== expected || (v.valueType === 'date' && !isCalendarDate(String(v.value))))
    ctx.addIssue({ code: 'custom', message: 'literal type mismatch' });
});
export const ontologyValueSchema = z.union([entityValue, literalValue]);
const condition: z.ZodTypeAny = z.lazy(() => z.union([
  z.object({ kind: z.literal('task'), field: z.enum(['purpose', 'taskKind', 'entityId']), equals: name }).strict(),
  z.object({ kind: z.literal('assertion'), subjectId: id, definitionId: id, object: ontologyValueSchema.optional() }).strict(),
  z.object({ kind: z.enum(['all', 'any']), conditions: z.array(condition).min(1).max(32) }).strict(),
  z.object({ kind: z.literal('not'), condition }).strict(),
]));
const base = {
  id, version: z.number().int().positive(), status: z.enum(['active', 'paused', 'archived', 'corrected']),
  access: z.enum(['task', 'owner_only']).default('task'),
  certainty: z.enum(['confirmed', 'inferred', 'unknown']).optional(),
  createdAt: stamp.nullable(), updatedAt: stamp.nullable(),
  source: z.object({ kind: z.enum(['user', 'candidate', 'legacy']), label: name, recordId: id.optional(),
    refs: z.array(z.object({ kind: z.enum(['asset', 'candidate', 'legacy']), id }).strict()).max(100).optional() }).strict(),
};
const summaryPoint = z.object({
  text: z.string().trim().min(1).max(600),
  evidenceIds: z.array(id).min(1).max(30)
    .refine(ids => new Set(ids).size === ids.length, 'duplicate evidence id'),
}).strict();
const recordSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('module'), name, description: text(),
    scope: z.object({ kind: z.enum(['personal', 'project', 'workspace']), id: id.optional() }).strict()
      .refine(scope => scope.kind === 'personal' ? scope.id === undefined : scope.id !== undefined),
    summaryPoints: z.array(summaryPoint).max(5).optional(),
    scopeNote: z.string().trim().max(300).optional(),
  }).strict(),
  z.object({ ...base, kind: z.literal('definition'), moduleId: id, name, description: text(),
    definitionKind: z.enum(['type', 'relation', 'attribute']), subjectTypes: z.array(id).max(32), objectTypes: z.array(id).max(32),
    valueType: z.enum(['entity', 'text', 'number', 'boolean', 'date']), cardinality: z.enum(['one', 'many']),
    cardinalityAnchor: z.enum(['subject', 'object']),
  }).strict(),
  z.object({ ...base, kind: z.literal('entity'), moduleId: id, typeId: id, name, description: text(),
    aliases: z.array(name).max(30), identityStatus: z.enum(['confirmed', 'unresolved']),
  }).strict(),
  z.object({ ...base, kind: z.literal('assertion'), moduleId: id, subjectId: id, definitionId: id,
    object: ontologyValueSchema, validity, supersedesId: id.optional(),
  }).strict(),
  z.object({ ...base, kind: z.literal('rule'), moduleId: id, name, requirement: text(10000),
    strength: z.enum(['required', 'default', 'suggestion', 'logic']), condition: condition.nullable(),
    effect: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('include_recipient'), entityId: id }).strict(),
      z.object({ kind: z.literal('required_section'), name }).strict(),
      z.object({ kind: z.literal('choice'), key: name, value: text(1000) }).strict(),
      z.object({ kind: z.literal('note') }).strict(),
    ]), exception: text(),
  }).strict(),
  z.object({ ...base, kind: z.literal('reference'), moduleId: id, targetModuleId: id,
    targetRecordId: id.optional(), versionPolicy: z.enum(['current', 'pinned']), targetVersion: z.number().int().positive().optional(),
  }).strict(),
]);

/** Check recursion before Zod traversal, including hostile in-process cyclic objects. */
export function boundedJson(value: unknown): void {
  let nodes = 0; const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (++nodes > 2_000_000 || depth > 30) throw new OntologyError('invalid_input', 'ontology structure exceeds limit');
    if (!v || typeof v !== 'object') return;
    if (ancestors.has(v)) throw new OntologyError('invalid_input', 'cyclic ontology input');
    ancestors.add(v);
    for (const entry of Object.values(v)) visit(entry, depth + 1);
    ancestors.delete(v);
  }
  visit(value, 0);
}
export function validateOntologyRecord(value: unknown): OntologyRecord {
  boundedJson(value);
  const result = recordSchema.safeParse(value);
  if (!result.success) throw new OntologyError('invalid_input', 'invalid ontology record', { issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message,
    ...(i.code === 'unrecognized_keys' ? { keys: i.keys } : {}) })) });
  return result.data as OntologyRecord;
}
export function emptyOntologyDocument(ownerId: string): OntologyDocument {
  if (!id.safeParse(ownerId).success) throw new OntologyError('invalid_user', 'invalid ontology owner');
  return { schemaVersion: 1, ownerId, revision: 0, records: {}, history: [], receipts: {} };
}
const documentSchema = z.object({
  schemaVersion: z.literal(1), ownerId: id, revision: z.number().int().nonnegative(),
  records: z.record(id, recordSchema),
  history: z.array(z.object({ commandId: id, revision: z.number().int().positive(), intent: name, recordedAt: stamp,
    before: recordSchema.optional(), after: recordSchema }).strict()).max(100000),
  receipts: z.record(id, z.object({ commandId: id, requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(), recordedAt: stamp, changedIds: z.array(id).min(1).max(100),
    userEditDecision: cognitionEditDecisionSchema.optional(),
  }).strict()),
}).strict();
export function validateOntologyDocument(raw: unknown): OntologyDocument {
  boundedJson(raw);
  const result = documentSchema.safeParse(raw);
  if (!result.success) throw new OntologyError('store_corrupt', 'invalid ontology document');
  const doc = result.data as OntologyDocument;
  const recordCount = Object.keys(doc.records).length;
  const receiptCount = Object.keys(doc.receipts).length;
  if (recordCount > 25000 || receiptCount > 20000)
    throw new OntologyError('capacity_exceeded',
      `ontology document exceeds capacity (${recordCount}/25000 records, ${receiptCount}/20000 commands); ${recordCount > 25000 ? 'export and split the ontology' : 'archive history'} before adding more`,
      { records: { limit: 25000, current: recordCount },
        receipts: { limit: 20000, current: receiptCount },
        remedy: recordCount > 25000 ? 'export_and_split' : 'archive_history' });
  for (const [key, record] of Object.entries(doc.records)) {
    if (key !== record.id) throw new OntologyError('store_corrupt', 'ontology record identity mismatch');
    if (record.kind !== 'module' && doc.records[record.moduleId]?.kind !== 'module')
      throw new OntologyError('store_corrupt', 'ontology module missing');
  }
  for (const [key, receipt] of Object.entries(doc.receipts)) {
    if (key !== receipt.commandId || receipt.revision > doc.revision)
      throw new OntologyError('store_corrupt', 'ontology receipt identity mismatch');
  }
  // 按 history 原序构建每条记录的最新历史项与 commandId:revision 的变更 id 集合。
  // id 不含冒号，组合键无碰撞。文档上限为 25000 记录和 100000 历史项；
  // 每次读写都需校验，单遍索引避免 O(records×history + receipts×changedIds×history)
  // 的重复历史扫描阻塞主进程。
  const latestByRecord = new Map<string, (typeof doc.history)[number]>();
  const changedByCommand = new Map<string, Set<string>>();
  for (const entry of doc.history) {
    if (entry.revision > doc.revision) throw new OntologyError('store_corrupt', 'ontology history exceeds document revision');
    if (entry.before && (entry.before.id !== entry.after.id || entry.before.kind !== entry.after.kind
      || entry.after.version !== entry.before.version + 1)) throw new OntologyError('store_corrupt', 'ontology history mismatch');
    if (!doc.receipts[entry.commandId] || doc.receipts[entry.commandId].revision !== entry.revision
      || !doc.receipts[entry.commandId].changedIds.includes(entry.after.id))
      throw new OntologyError('store_corrupt', 'ontology history receipt missing');
    latestByRecord.set(entry.after.id, entry);
    const commandKey = `${entry.commandId}:${entry.revision}`;
    const covered = changedByCommand.get(commandKey);
    if (covered) covered.add(entry.after.id);
    else changedByCommand.set(commandKey, new Set([entry.after.id]));
  }
  for (const [key, receipt] of Object.entries(doc.receipts)) {
    const covered = changedByCommand.get(`${key}:${receipt.revision}`);
    if (receipt.changedIds.some(id => !covered?.has(id)))
      throw new OntologyError('store_corrupt', 'ontology receipt has no matching history');
  }
  for (const record of Object.values(doc.records)) {
    if (record.source.kind === 'legacy') continue; // read-only projections intentionally have no invented history.
    const latest = latestByRecord.get(record.id);
    if (!latest || latest.after.version !== record.version || latest.after.kind !== record.kind)
      throw new OntologyError('store_corrupt', 'ontology record does not match its recorded history');
  }
  return doc;
}
export function validateOntologyId(value: unknown): string {
  const result = id.safeParse(value);
  if (!result.success) throw new OntologyError('invalid_input', 'invalid ontology id');
  return result.data;
}
