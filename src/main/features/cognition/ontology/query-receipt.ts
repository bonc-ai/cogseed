/** Persist which ontology record versions were included in a task query result. */
import { genId12, safeId } from '../../../storage';
import { appendRecallJsonlRecord, listRecallJsonlRecords } from '../../recall/store';
import type { RecallJsonRecord } from '../../recall/types';

export interface OntologyQueryReadRef {
  moduleId: string;
  recordId: string;
  recordVersion: number;
  kind: 'assertion' | 'rule';
  sourceKind: 'user' | 'candidate' | 'legacy';
}

export interface OntologyQueryReadReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  status: 'result_produced';
  recordRefs: OntologyQueryReadRef[];
  createdAt: string;
}

function validateRef(value: OntologyQueryReadRef): OntologyQueryReadRef {
  if (!value || !safeId(value.moduleId) || !safeId(value.recordId)
    || !Number.isSafeInteger(value.recordVersion) || value.recordVersion < 1
    || (value.kind !== 'assertion' && value.kind !== 'rule')
    || !['user', 'candidate', 'legacy'].includes(value.sourceKind)) {
    throw new Error('invalid ontology query read reference');
  }
  return value;
}

/** One bounded receipt per tool result; it stores IDs and versions, never task text or record contents. */
export async function recordOntologyQueryReadReceipt(
  userId: string,
  taskRunId: string | undefined,
  refs: readonly OntologyQueryReadRef[],
): Promise<OntologyQueryReadReceipt | undefined> {
  if (!taskRunId) return undefined;
  if (!safeId(userId) || !safeId(taskRunId)) throw new Error('invalid ontology query receipt owner or turn');
  if (refs.length > 150) throw new Error('ontology query receipt exceeds result limit');
  const unique = new Map<string, OntologyQueryReadRef>();
  for (const raw of refs) {
    const ref = validateRef(raw);
    unique.set(`${ref.moduleId}:${ref.recordId}:${ref.recordVersion}`, ref);
  }
  if (!unique.size) return undefined;
  const receipt: OntologyQueryReadReceipt = {
    schemaVersion: 1, ownerId: userId, id: `ontread-${genId12()}`, taskRunId,
    status: 'result_produced', recordRefs: [...unique.values()], createdAt: new Date().toISOString(),
  };
  await appendRecallJsonlRecord(userId, 'ontology-query-receipts', 'events', receipt);
  return receipt;
}

/** Read validated query receipts for a turn; consumers still verify exact record versions. */
export async function listOntologyQueryReadReceipts(
  userId: string,
  taskRunId: string,
): Promise<OntologyQueryReadReceipt[]> {
  if (!safeId(userId) || !safeId(taskRunId)) throw new Error('invalid ontology query receipt reference');
  const values = await listRecallJsonlRecords(userId, 'ontology-query-receipts', 'events', 0);
  const output: OntologyQueryReadReceipt[] = [];
  for (const value of values) {
    if (value.schemaVersion !== 1 || value.ownerId !== userId || value.taskRunId !== taskRunId
      || value.status !== 'result_produced' || typeof value.id !== 'string' || !/^ontread-[A-Za-z0-9_-]{8,40}$/.test(value.id)
      || typeof value.createdAt !== 'string' || !Array.isArray(value.recordRefs) || value.recordRefs.length > 150) continue;
    try {
      const recordRefs = value.recordRefs.map(ref => validateRef(ref as OntologyQueryReadRef));
      output.push({ ...value, recordRefs } as OntologyQueryReadReceipt);
    } catch { /* malformed historic receipt is not evidence of a readable version */ }
  }
  return output;
}
