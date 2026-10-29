/** A version snapshot travels in the same atomic record commit as its content.
 * The append-only ledger may lag; its pending snapshots are durable and replayable. */
import type { RecallJsonRecord } from './types';
import { AsyncLocalStorage } from 'node:async_hooks';
const metadataContext = new AsyncLocalStorage<{ actor: 'user' | 'system' | 'ai'; reason: string; active: boolean }>();
/** Host write context; callers cannot submit this metadata through record JSON. */
export async function withAssetVersionMetadata<T>(metadata: { actor: 'user' | 'system' | 'ai'; reason: string }, work: () => Promise<T>): Promise<T> {
  const context = { ...metadata, active: true };
  try { return await metadataContext.run(context, work); } finally { context.active = false; }
}
export const ASSET_VERSION_SNAPSHOT_FIELDS = ['title', 'statement', 'value', 'type', 'contentCategory', 'scope', 'scopePolicy', 'evidenceRefs',
  'learningSignal', 'learningProvenance', 'ontologyRefs', 'relations', 'derivedFrom', 'applicableWhen', 'forbiddenWhen',
  'sourceSessionIds', 'status', 'maturity', 'version', 'definition', 'standingPreferenceAuthority', 'userEditDecision'] as const;
export function assetVersionSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(ASSET_VERSION_SNAPSHOT_FIELDS.filter(k => record[k] !== undefined).map(k => [k, record[k]]));
}
export function pendingAssetVersions(record: RecallJsonRecord | undefined): RecallJsonRecord[] {
  const rows = record?.pendingVersionSnapshots;
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || row.ownerId !== record?.ownerId
    || row.assetId !== record?.id || row.id !== `${record?.id}-v${row.version}` || !/^\d+$/.test(String(row.version))
    || !row.snapshot || typeof row.snapshot !== 'object' || Array.isArray(row.snapshot)
    || String(row.snapshot.version) !== String(row.version) || typeof row.snapshot.title !== 'string'
    || typeof row.snapshot.statement !== 'string' || !['cognition', 'personal', 'rule', 'template', 'skill_method', 'fact'].includes(String(row.snapshot.type)))) throw new Error('invalid pending asset version snapshots');
  return rows;
}
export function withPendingAssetVersion(current: RecallJsonRecord | undefined, next: RecallJsonRecord): RecallJsonRecord {
  if (next.status === 'purged') { const clean = { ...next }; delete clean.pendingVersionSnapshots; return clean; }
  if (!['cognition', 'personal', 'rule', 'template', 'skill_method', 'fact'].includes(String(next.type))
    || typeof next.title !== 'string' || typeof next.statement !== 'string' || !/^\d+$/.test(String(next.version))
    ) return next;
  const pending = pendingAssetVersions(current);
  if (current?.version === next.version) return pending.length ? { ...next, pendingVersionSnapshots: pending } : next;
  const line = { schemaVersion: 1, ownerId: next.ownerId, id: `${next.id}-v${next.version}`, assetId: next.id,
    version: String(next.version), at: String(next.updatedAt || new Date().toISOString()),
    // The review identity must survive an interrupted ledger append together
    // with the content. Ordinary edits retain the old ID and are not new reviews.
    ...(typeof next.reviewDecisionId === 'string' && next.reviewDecisionId !== current?.reviewDecisionId
      ? { reason: `review_decision:${next.reviewDecisionId}` } : {}),
    ...(metadataContext.getStore()?.active ? { actor: metadataContext.getStore()!.actor, reason: metadataContext.getStore()!.reason } : {}),
    snapshot: assetVersionSnapshot(next) };
  return { ...next, pendingVersionSnapshots: [...pending.filter(row => row.version !== line.version), line] };
}
/** A same-commit dependency may finish ontology refs after the initial queue
 * was made. Refresh only the current pending content, preserving the actual
 * host actor/reason; historical snapshots remain immutable. */
export function refreshPendingAssetVersion(record: Record<string, unknown>): void {
  if (!Array.isArray(record.pendingVersionSnapshots)) return;
  const row = pendingAssetVersions(record as RecallJsonRecord).find(value => String(value.version) === String(record.version));
  if (row) row.snapshot = assetVersionSnapshot(record);
}
