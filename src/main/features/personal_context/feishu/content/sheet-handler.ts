import { nowIso } from '../../../../storage';
import { buildResourceKey, type ExternalResource, type ResourceCapability } from '../../contract';
import { boundedEvidence, type NormalizedContent, type StructuredValue } from './types';

export interface SheetContentInput {
  tenant: string;
  unionId: string;
  spreadsheetId: string;
  title: string;
  sourceVersion: string;
  sourceUrl?: string;
  rows: Array<Array<string | number | boolean | null>>;
}

const CAPABILITY: ResourceCapability = Object.freeze({ canList: true, canReadMetadata: true, canReadContent: true, canSyncIncrementally: true, canGenerateCandidates: true });

export function normalizeSheetContent(input: SheetContentInput): NormalizedContent {
  if (!input.tenant || !input.unionId || !input.spreadsheetId || !input.sourceVersion) throw new Error('sheet content identifiers are required');
  const resourceId = buildResourceKey('feishu', input.tenant, 'document', input.spreadsheetId);
  const limitedRows = input.rows.slice(0, 5_000).map((row) => row.slice(0, 200));
  const text = limitedRows.map((row) => row.map((cell) => String(cell ?? '')).join('\t')).join('\n');
  const resource: ExternalResource = {
    resourceId,
    resourceType: 'document',
    sourceVersion: input.sourceVersion,
    title: input.title || input.spreadsheetId,
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
    structured: { rows: limitedRows } as StructuredValue,
    evidence: limitedRows.slice(0, 50).map((row, index) => ({ sourceResourceId: resourceId, excerpt: boundedEvidence(row.map(String).join(' | ')), locator: `row:${index + 1}` })),
    warnings: input.rows.length > limitedRows.length ? [{ code: 'truncated', message: 'sheet row limit reached' }] : [],
  };
}
