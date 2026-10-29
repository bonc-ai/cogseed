/** Host-verified evidence that a queried ontology record version was cited in a persisted reply. */
import { createHash } from 'node:crypto';
import { nowIso, safeId } from '../../../storage';
import { fileEditLock } from '../../../util/locks';
import { listOntologyQueryReadReceipts, type OntologyQueryReadRef } from './query-receipt';
import { recallJsonlPath } from '../../recall/paths';
import { appendRecallJsonlRecord, listRecallJsonlRecords } from '../../recall/store';
import type { RecallJsonRecord } from '../../recall/types';

export interface OntologyUsageReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  moduleId: string;
  recordId: string;
  recordVersion: number;
  readReceiptId: string;
  recordKind: OntologyQueryReadRef['kind'];
  sourceKind: OntologyQueryReadRef['sourceKind'];
  status: 'applied';
  boundary: 'real';
  evidenceKind: 'final_output';
  messageId: string;
  effectVerified: false;
  createdAt: string;
}

interface OntologyCitation {
  moduleId: string;
  recordId: string;
  recordVersion: number;
}

const CITATION_PATTERN = /\[\[ontology:([A-Za-z0-9_-]{1,160})\/([A-Za-z0-9_-]{1,160})@([1-9]\d{0,8})\]\]/g;

function parseCitations(finalText: string): OntologyCitation[] {
  const found = new Map<string, OntologyCitation>();
  for (const match of finalText.matchAll(CITATION_PATTERN)) {
    const recordVersion = Number(match[3]);
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) continue;
    const citation = { moduleId: match[1], recordId: match[2], recordVersion };
    found.set(`${citation.moduleId}:${citation.recordId}:${citation.recordVersion}`, citation);
  }
  return [...found.values()];
}

function matches(ref: OntologyQueryReadRef, citation: OntologyCitation): boolean {
  return ref.moduleId === citation.moduleId && ref.recordId === citation.recordId && ref.recordVersion === citation.recordVersion;
}

function receiptId(input: OntologyCitation & { taskRunId: string }): string {
  const key = JSON.stringify([input.taskRunId, input.moduleId, input.recordId, input.recordVersion]);
  return `ontuse-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function asReceipt(userId: string, value: RecallJsonRecord): OntologyUsageReceipt {
  if (value.schemaVersion !== 1 || value.ownerId !== userId || typeof value.id !== 'string'
    || !/^ontuse-[a-f0-9]{24}$/.test(value.id) || !safeId(String(value.taskRunId || ''))
    || !safeId(String(value.moduleId || '')) || !safeId(String(value.recordId || ''))
    || typeof value.recordVersion !== 'number' || !Number.isSafeInteger(value.recordVersion) || value.recordVersion < 1
    || !safeId(String(value.readReceiptId || '')) || !safeId(String(value.messageId || ''))
    || !['assertion', 'rule'].includes(String(value.recordKind))
    || !['user', 'candidate', 'legacy'].includes(String(value.sourceKind))
    || value.status !== 'applied' || value.boundary !== 'real' || value.evidenceKind !== 'final_output'
    || value.effectVerified !== false || typeof value.createdAt !== 'string') {
    throw new Error('malformed ontology usage receipt');
  }
  return value as unknown as OntologyUsageReceipt;
}

async function writeOntologyUsageReceipt(userId: string, taskRunId: string, messageId: string, citation: OntologyCitation,
  readReceiptId: string, source: Pick<OntologyQueryReadRef, 'kind' | 'sourceKind'>): Promise<OntologyUsageReceipt> {
  const id = receiptId({ ...citation, taskRunId });
  const record: OntologyUsageReceipt = {
    schemaVersion: 1, ownerId: userId, id, taskRunId, moduleId: citation.moduleId, recordId: citation.recordId,
    recordVersion: citation.recordVersion, readReceiptId, recordKind: source.kind, sourceKind: source.sourceKind,
    status: 'applied', boundary: 'real', evidenceKind: 'final_output', messageId, effectVerified: false, createdAt: nowIso(),
  };
  const streamPath = recallJsonlPath(userId, 'ontology-usage-receipts', 'events');
  return fileEditLock(streamPath).runExclusive(async () => {
    const existing = (await listOntologyUsageReceipts(userId, taskRunId)).find(item => item.id === id);
    if (existing) return existing;
    await appendRecallJsonlRecord(userId, 'ontology-usage-receipts', 'events', record);
    return record;
  });
}

/** Cite markers count only when the same version was returned by a query in this turn. */
export async function finalizeOntologyUsageCitations(userId: string, input: {
  taskRunId: string; messageId: string; finalText: string;
}): Promise<OntologyUsageReceipt[]> {
  if (!safeId(userId) || !safeId(input.taskRunId) || !safeId(input.messageId)) throw new Error('invalid ontology usage final message');
  const citations = parseCitations(input.finalText);
  if (!citations.length) return [];
  const readReceipts = await listOntologyQueryReadReceipts(userId, input.taskRunId);
  const finalized: OntologyUsageReceipt[] = [];
  for (const citation of citations) {
    const readReceipt = [...readReceipts].reverse().find(receipt => receipt.recordRefs.some(ref => matches(ref, citation)));
    const source = readReceipt?.recordRefs.find(ref => matches(ref, citation));
    if (!readReceipt || !source) continue;
    finalized.push(await writeOntologyUsageReceipt(userId, input.taskRunId, input.messageId, citation, readReceipt.id, source));
  }
  return finalized;
}

export async function listOntologyUsageReceipts(userId: string, taskRunId?: string): Promise<OntologyUsageReceipt[]> {
  if (!safeId(userId) || (taskRunId !== undefined && !safeId(taskRunId))) throw new Error('invalid ontology usage receipt query');
  const rows = await listRecallJsonlRecords(userId, 'ontology-usage-receipts', 'events', 0);
  const latest = new Map<string, OntologyUsageReceipt>();
  for (const row of rows) {
    try {
      const receipt = asReceipt(userId, row);
      latest.set(receipt.id, receipt);
    } catch { /* A damaged legacy row must not hide the remaining verified receipts. */ }
  }
  return [...latest.values()].filter(receipt => taskRunId === undefined || receipt.taskRunId === taskRunId);
}
