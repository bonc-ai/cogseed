/** Purge the user text an ability asset contributed to ontology records and
 *  their archived history. IDs, versions, receipts and graph edges stay so the
 *  ontology document keeps satisfying its history invariants; only the purged
 *  asset's text and asset source ref are removed. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyCognitionDeltas, cognitionStorePath } from '../../cognition_kernel/store';
import {
  validateOntologyDocument,
  type OntologyCondition,
  type OntologyDocument,
  type OntologyEffect,
  type OntologyRecord,
  type OntologyRule,
  type OntologyValue,
} from './model';

const PURGED_LABEL = '[已清除]';

function scrubValue(value: OntologyValue): OntologyValue {
  return value.kind === 'literal' && value.valueType === 'text' ? { ...value, value: '' } : value;
}

function scrubCondition(condition: OntologyCondition | null): OntologyCondition | null {
  if (!condition) return condition;
  if (condition.kind === 'task') {
    return condition.field === 'purpose' ? { ...condition, equals: PURGED_LABEL } : condition;
  }
  if (condition.kind === 'assertion') {
    return condition.object ? { ...condition, object: scrubValue(condition.object) } : condition;
  }
  if (condition.kind === 'all' || condition.kind === 'any') {
    return { ...condition, conditions: condition.conditions.map(scrubCondition) };
  }
  if (condition.kind === 'not') return { ...condition, condition: scrubCondition(condition.condition)! };
  return condition;
}

function scrubEffect(effect: OntologyEffect): OntologyEffect {
  if (effect.kind === 'required_section') return { ...effect, name: PURGED_LABEL };
  if (effect.kind === 'choice') return { ...effect, key: PURGED_LABEL, value: '' };
  return effect;
}

export function scrubOntologyRecord(record: OntologyRecord, assetId: string): OntologyRecord {
  const next = structuredClone(record) as OntologyRecord & Record<string, unknown>;
  const refs = (next.source.refs || []).filter(ref => !(ref.kind === 'asset' && ref.id === assetId));
  next.source = { ...next.source, label: PURGED_LABEL, ...(refs.length ? { refs } : {}) };
  if (typeof next.name === 'string') next.name = PURGED_LABEL;
  if (typeof next.description === 'string') next.description = '';
  if (next.kind === 'module') {
    if (Array.isArray(next.summaryPoints)) next.summaryPoints = next.summaryPoints.map(point => ({ ...point, text: PURGED_LABEL }));
    if (typeof next.scopeNote === 'string') next.scopeNote = '';
  }
  if (next.kind === 'entity') next.aliases = [];
  if (next.kind === 'rule') {
    const rule = next as OntologyRule;
    rule.requirement = '';
    rule.exception = '';
    rule.condition = scrubCondition(rule.condition);
    rule.effect = scrubEffect(rule.effect);
  }
  if (next.kind === 'assertion') next.object = scrubValue(next.object);
  return next as OntologyRecord;
}

function ownedRecordIds(doc: OntologyDocument, assetId: string, extra: readonly string[]): Set<string> {
  const owned = new Set(extra.filter(id => typeof id === 'string' && id));
  const isOwned = (record: OntologyRecord) =>
    record.source.recordId === assetId || (record.source.refs || []).some(ref => ref.kind === 'asset' && ref.id === assetId);
  for (const record of Object.values(doc.records)) if (isOwned(record)) owned.add(record.id);
  // A record may have been rewritten after formation; its history still carries
  // the original asset source and must be scrubbed too.
  for (const entry of doc.history) {
    if (isOwned(entry.after)) owned.add(entry.after.id);
    if (entry.before && isOwned(entry.before)) owned.add(entry.before.id);
  }
  return owned;
}

export interface OntologyPurgeResult {
  changed: boolean;
  recordIds: string[];
}

export function scrubOntologyDocument(
  doc: OntologyDocument,
  assetId: string,
  extraRecordIds: readonly string[] = [],
): { document: OntologyDocument; result: OntologyPurgeResult } {
  const owned = ownedRecordIds(doc, assetId, extraRecordIds);
  if (!owned.size) return { document: doc, result: { changed: false, recordIds: [] } };
  const next = structuredClone(doc);
  for (const id of owned) {
    const record = next.records[id];
    if (record) next.records[id] = scrubOntologyRecord(record, assetId);
  }
  for (const entry of next.history) {
    if (owned.has(entry.after.id)) {
      entry.after = scrubOntologyRecord(entry.after, assetId);
      entry.intent = 'purged';
    }
    if (entry.before && owned.has(entry.before.id)) entry.before = scrubOntologyRecord(entry.before, assetId);
  }
  for (const receipt of Object.values(next.receipts)) {
    if (receipt.changedIds.some(id => owned.has(id))) delete receipt.userEditDecision;
  }
  validateOntologyDocument(next);
  return { document: next, result: { changed: true, recordIds: [...owned] } };
}

export async function purgeOntologyAssetCopies(
  userId: string,
  assetId: string,
  extraRecordIds: readonly string[] = [],
): Promise<OntologyPurgeResult> {
  let result: OntologyPurgeResult = { changed: false, recordIds: [] };
  await applyCognitionDeltas(userId, {
    kind: 'document',
    edit: (draft) => {
      if (!draft.ontology) return false;
      const scrubbed = scrubOntologyDocument(draft.ontology, assetId, extraRecordIds);
      if (!scrubbed.result.changed) return false;
      draft.ontology = scrubbed.document;
      result = scrubbed.result;
    },
  });
  return result;
}

/** The archive is a sideline copy of removed history. It is not read by the
 *  live document validator, so it must be scrubbed separately. */
export async function scrubOntologyArchives(
  userId: string,
  assetId: string,
  recordIds: readonly string[],
): Promise<number> {
  if (!recordIds.length) return 0;
  const owned = new Set(recordIds);
  const storeFile = cognitionStorePath(userId);
  const dir = path.dirname(storeFile);
  const prefix = path.basename(storeFile) + '.archive-';
  let names: string[];
  try { names = fs.readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.jsonl')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let changedFiles = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let changed = false;
    const next = lines.map(line => {
      let entry: any;
      try { entry = JSON.parse(line); } catch { throw new Error(`ontology archive is unreadable: ${name}`); }
      if (entry?.kind === 'history' && entry.entry) {
        if (owned.has(entry.entry.after?.id)) {
          entry.entry.after = scrubOntologyRecord(entry.entry.after, assetId);
          entry.entry.intent = 'purged';
          changed = true;
        }
        if (entry.entry.before && owned.has(entry.entry.before.id)) {
          entry.entry.before = scrubOntologyRecord(entry.entry.before, assetId);
          changed = true;
        }
      }
      if (entry?.kind === 'receipt' && entry.receipt && Array.isArray(entry.receipt.changedIds)
        && entry.receipt.changedIds.some((id: unknown) => typeof id === 'string' && owned.has(id))) {
        if ('userEditDecision' in entry.receipt) { delete entry.receipt.userEditDecision; changed = true; }
      }
      return changed ? JSON.stringify(entry) : line;
    });
    if (!changed) continue;
    const tmp = `${file}.purge-${process.pid}`;
    fs.writeFileSync(tmp, next.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
    changedFiles += 1;
  }
  return changedFiles;
}
