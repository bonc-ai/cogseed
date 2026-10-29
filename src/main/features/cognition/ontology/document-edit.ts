/** A narrow document editor over the canonical ontology command boundary. */
import { z } from 'zod';
import { type OntologyAction, type OntologyCommand } from './commands';
import { OntologyError, ontologyValueSchema, validateOntologyId, type OntologyRecord, type OntologyValue } from './model';
import { commitOntologyCommand, readOntologyDocument, readOntologyView } from './service';

const requestSchema = z.object({
  commandId: z.string(), recordId: z.string(),
  expectedRevision: z.number().int().nonnegative(), expectedVersion: z.number().int().positive(),
  changes: z.record(z.string(), z.unknown()),
}).strict();
export type OntologyDocumentEdit = z.infer<typeof requestSchema>;

const fields: Record<OntologyRecord['kind'], readonly string[]> = {
  module: ['name', 'description', 'scopeNote', 'summaryPoints'],
  definition: ['name', 'description', 'subjectTypes', 'objectTypes', 'valueType', 'cardinality', 'cardinalityAnchor'],
  entity: ['name', 'description', 'aliases'],
  assertion: ['object.value', 'object.id', 'subjectId', 'certainty'],
  rule: ['name', 'requirement', 'exception', 'strength'],
  reference: [],
};
const sourceLabel = '用户编辑本体文档';

function assertionObject(record: Extract<OntologyRecord, { kind: 'assertion' }>, changes: Record<string, unknown>): OntologyValue | undefined {
  if (Object.hasOwn(changes, 'object.value')) {
    if (record.object.kind !== 'literal') throw new OntologyError('invalid_input', 'entity fact has no literal value');
    const candidate = { ...record.object, value: changes['object.value'] };
    const parsed = ontologyValueSchema.safeParse(candidate);
    if (!parsed.success) throw new OntologyError('invalid_input', 'fact value must match its existing type');
    return parsed.data as OntologyValue;
  }
  if (Object.hasOwn(changes, 'object.id')) {
    if (record.object.kind !== 'entity') throw new OntologyError('invalid_input', 'literal fact has no entity id');
    validateOntologyId(changes['object.id']);
    return { kind: 'entity', id: changes['object.id'] as string };
  }
  return undefined;
}

function actionFor(record: OntologyRecord, input: OntologyDocumentEdit): OntologyAction {
  const entries = Object.entries(input.changes);
  if (!entries.length || entries.length > 20) throw new OntologyError('invalid_input', 'edit must contain 1 to 20 fields');
  for (const [field] of entries) if (!fields[record.kind].includes(field))
    throw new OntologyError('invalid_input', `field cannot be edited: ${field}`);
  if (record.kind === 'assertion') {
    if (Object.hasOwn(input.changes, 'object.value') && Object.hasOwn(input.changes, 'object.id'))
      throw new OntologyError('invalid_input', 'choose one fact object field');
    const object = assertionObject(record, input.changes);
    const subject = input.changes.subjectId;
    if (subject !== undefined) validateOntologyId(subject);
    const certainty = input.changes.certainty;
    if (certainty !== undefined && !['confirmed', 'inferred', 'unknown'].includes(String(certainty)))
      throw new OntologyError('invalid_input', 'invalid fact certainty');
    // The command layer requires a subject/object; a certainty-only correction keeps the object.
    return { intent: 'correct', recordId: record.id, expectedVersion: input.expectedVersion,
      object: object ?? (subject === undefined ? record.object : undefined),
      ...(subject !== undefined ? { subjectId: subject as string } : {}),
      ...(certainty !== undefined ? { certainty: certainty as 'confirmed' | 'inferred' | 'unknown' } : {}), sourceLabel };
  }
  return { intent: 'update', recordId: record.id, expectedVersion: input.expectedVersion,
    patch: input.changes, sourceLabel };
}

export async function editOntologyDocument(userId: string, raw: unknown) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new OntologyError('invalid_input', 'invalid ontology document edit request');
  const input = parsed.data;
  validateOntologyId(input.commandId);
  validateOntologyId(input.recordId);
  const canonical = readOntologyDocument(userId);
  const record = canonical.records[input.recordId];
  if (!record) {
    const view = await readOntologyView(userId);
    if (view.records[input.recordId]?.source.kind === 'legacy')
      throw new OntologyError('legacy_read_only', 'legacy ontology projection is read only; migrate explicitly before editing');
    throw new OntologyError('not_found', 'ontology record unavailable');
  }
  const command: OntologyCommand = { commandId: input.commandId, expectedRevision: input.expectedRevision,
    actions: [actionFor(record, input)] };
  // The command layer checks matching command IDs before CAS, so retries survive later revisions.
  if (!canonical.receipts[input.commandId]) {
    const module = record.kind === 'module' ? record : canonical.records[record.moduleId];
    if (record.source.kind === 'legacy' || module?.source.kind === 'legacy')
      throw new OntologyError('legacy_read_only', 'legacy ontology content is read only; migrate explicitly before editing');
    if (record.status !== 'active' || module?.kind !== 'module' || module.status !== 'active')
      throw new OntologyError('invalid_intent', 'only records in an active ontology module can be edited');
  }
  const outcome = await commitOntologyCommand(userId, command);
  const saved = readOntologyDocument(userId);
  const receipt = saved.receipts[input.commandId];
  if (!receipt || receipt.requestHash !== outcome.receipt.requestHash || receipt.revision !== outcome.receipt.revision)
    throw new OntologyError('commit_failed', 'ontology edit receipt read-back failed');
  const successor = record.kind === 'assertion'
    ? saved.history.find(entry => entry.commandId === input.commandId && entry.intent === 'correct')?.after.id
    : undefined;
  const recordId = successor ?? input.recordId;
  if (!receipt.changedIds.includes(recordId) || !saved.records[recordId])
    throw new OntologyError('commit_failed', 'ontology edit record read-back failed');
  return { receipt, duplicate: outcome.duplicate, ontology: await readOntologyView(userId), recordId };
}
