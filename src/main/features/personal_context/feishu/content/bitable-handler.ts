import { nowIso } from '../../../../storage';
import { buildResourceKey, type ExternalResource, type ResourceCapability } from '../../contract';
import { boundedEvidence, type NormalizedContent, type StructuredValue } from './types';

export interface BitableField { fieldId: string; name: string; type: string }
export interface BitableRecord { recordId: string; fields: Record<string, string | number | boolean | null> }
export interface BitableContentInput {
  tenant: string;
  unionId: string;
  appToken: string;
  tableId: string;
  title: string;
  sourceVersion: string;
  sourceUrl?: string;
  fields: BitableField[];
  records: BitableRecord[];
}

const CAPABILITY: ResourceCapability = Object.freeze({ canList: true, canReadMetadata: true, canReadContent: true, canSyncIncrementally: true, canGenerateCandidates: true });

export function normalizeBitableContent(input: BitableContentInput): NormalizedContent {
  if (!input.tenant || !input.unionId || !input.appToken || !input.tableId || !input.sourceVersion) throw new Error('bitable content identifiers are required');
  const stableId = `${input.appToken}_${input.tableId}`;
  const resourceId = buildResourceKey('feishu', input.tenant, 'document', stableId);
  const fields = input.fields.slice(0, 500);
  const records = input.records.slice(0, 10_000);
  const text = records.map((record) => Object.entries(record.fields).map(([key, value]) => `${key}: ${String(value ?? '')}`).join(' | ')).join('\n');
  const structuredFields: StructuredValue[] = fields.map((field) => ({
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
  }));
  const structuredRecords: StructuredValue[] = records.map((record) => ({
    recordId: record.recordId,
    fields: Object.fromEntries(Object.entries(record.fields).map(([key, value]) => [key, value])),
  }));
  const structured: StructuredValue = { fields: structuredFields, records: structuredRecords };
  const resource: ExternalResource = {
    resourceId,
    resourceType: 'document',
    sourceVersion: input.sourceVersion,
    title: input.title || input.tableId,
    ownerRef: `feishu:union_id:${input.unionId}`,
    sourceUrl: input.sourceUrl,
    observedAt: nowIso(),
    accessLabel: 'shared',
    retentionPolicy: 'source-linked',
    bodyLoaded: true,
    capability: CAPABILITY,
    contentStatus: 'loaded',
    sourceValidity: 'active',
  };
  return {
    resource,
    version: input.sourceVersion,
    title: resource.title,
    text,
    structured,
    evidence: records.slice(0, 50).map((record) => ({ sourceResourceId: resourceId, excerpt: boundedEvidence(JSON.stringify(record.fields)), locator: `record:${record.recordId}` })),
    warnings: input.records.length > records.length ? [{ code: 'truncated', message: 'bitable record limit reached' }] : [],
  };
}
