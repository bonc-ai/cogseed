/** Content-bearing organization records share the owning asset's purge boundary.
 * This module is pure so storage can enforce the boundary under its existing
 * cognition transition lock without importing candidate or model services. */
import type { RecallJsonRecord } from './types';

const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.map(object) : [];

export function organizationContentAssetIds(record: RecallJsonRecord): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && value) ids.add(value); };
  const plan = (value: unknown) => {
    const p = object(value);
    for (const id of object(p.draft).sourceAssetIds || []) add(id);
    for (const id of p.resultIds || []) add(id);
    for (const source of rows(p.sources)) {
      add(object(source.head).id); add(object(source.rawHead).id); add(object(source.content).id);
    }
  };
  const candidate = (value: unknown) => {
    const c = object(value);
    add(c.targetAssetId); add(c.promotedAssetId); add(c.mergedIntoAssetId);
    add(object(c.stockOrganizationProvenance).assetId);
    plan(c.contentOrganization);
    const receipt = object(c.organizationReceipt);
    for (const id of Object.keys(object(receipt.afterAssets))) add(id);
    for (const row of rows(receipt.assets)) add(row.id);
    for (const id of receipt.archivedIds || []) add(id);
  };
  for (const id of Array.isArray(record.contentAssetIds) ? record.contentAssetIds : []) add(id);
  add(record.assetId);
  candidate(record); candidate(record.prepared);
  add(object(object(record.unit).asset).id);
  plan(record.plan); plan(record.organizationPlan);
  for (const id of object(object(record.draft).organization).sourceAssetIds || []) add(id);
  return [...ids].sort();
}

/** Allowlist rather than deleting known text fields: a future draft field must
 * not survive purge by default. Independent formal assets are never changed. */
export function purgedOrganizationRecord(collection: string, record: RecallJsonRecord, at: string): RecallJsonRecord {
  const retained: RecallJsonRecord = { schemaVersion: record.schemaVersion, ownerId: record.ownerId, id: record.id,
    contentPurgedAt: at, contentAssetIds: organizationContentAssetIds(record) };
  const keys = collection === 'candidates'
    ? ['createdAt', 'updatedAt', 'expiresAt', 'status', 'origin', 'suggestedType', 'suggestedAction', 'risk',
      'contentFormatVersion', 'taxonomyVersion', 'captureKey', 'captureReceiptKeys', 'reviewDecisionId', 'promotedAssetId', 'targetAssetId',
      'targetVersionUsed', 'processingDecisionActor', 'processingDecisionAt']
    : collection === 'asset-approvals' ? ['assetId', 'baselineVersion', 'baselineActiveVersion', 'state', 'createdAt', 'decidedAt', 'appliedVersion', 'cardMessageId']
    : ['kind', 'candidateId', 'createdAt', 'updatedAt', 'checkedAt', 'lastWindow', 'replacesJobId', 'reviewKind'];
  for (const key of keys) if (record[key] !== undefined) retained[key] = record[key];
  if (collection === 'candidates') {
    // These empty fields mean removed content, not missing evidence. Readers
    // and capabilities must handle contentPurgedAt before normal formation.
    Object.assign(retained, { judgment: '', summary: '', suggestedScope: '', sourceRefs: [], evidenceRefs: [] });
  } else if (collection === 'asset-approvals') {
    Object.assign(retained, { before: '', after: '', fields: [], payload: {}, reason: '' });
  } else {
    retained.state = 'purged';
  }
  return retained;
}

export function contentPurgedError(): Error & { code: string } {
  return Object.assign(new Error('organization content has been purged'), { code: 'recall_content_purged' });
}
