/** Report rows retain identity-only ownership through purge and retry. */
import { isDeepStrictEqual } from 'node:util';
import { contentPurgedError } from './organization-content-lifecycle';
import type { RecallJsonRecord } from './types';

export interface ReportContentOwnership { contentAssetIds?: string[]; contentPurgedAt?: string }
type Row = Record<string, any>;
export const REPORT_CONTENT_REMOVED = '（内容已彻底清除）';
export const reportRowGroups = (collection: string): string[] => collection === 'cleanup-reports' ? ['items', 'uncertain'] : ['findings'];
export function reportRowAssetIds(row: Row): string[] {
  return [...new Set([row.assetId, row.mergedIntoAssetId, ...(row.assetIds || []), ...(row.contentAssetIds || [])]
    .filter((id): id is string => typeof id === 'string' && !!id))].sort();
}
export function clearedReportRow(group: string, row: Row, at: string): Row {
  const retained: Row = { contentAssetIds: reportRowAssetIds(row), contentPurgedAt: at };
  const keys = group === 'items' ? ['assetId', 'kind', 'status', 'ledgerRef', 'rollbackAnchor', 'mergedIntoAssetId']
    : group === 'uncertain' ? ['assetId', 'decision'] : ['key', 'category', 'assetIds'];
  for (const key of keys) if (row[key] !== undefined) retained[key] = row[key];
  for (const key of group === 'items' ? ['before', 'after', 'reason', 'note'] : group === 'uncertain' ? ['question', 'reason'] : ['title', 'detail']) {
    if (row[key] !== undefined) retained[key] = REPORT_CONTENT_REMOVED;
  }
  return retained;
}

/** Reports have fixed historical row positions; decision edits may not erase
 * ownership or restore cleared text from an earlier snapshot. */
export async function assertReportContentWrite(collection: string, current: RecallJsonRecord | undefined,
  next: RecallJsonRecord, isPurged: (id: string) => Promise<boolean>): Promise<void> {
  for (const group of reportRowGroups(collection)) {
    const before = (current?.[group] || []) as Row[], after = (next[group] || []) as Row[];
    for (let index = 0; index < Math.max(before.length, after.length); index++) {
      const old = before[index], row = after[index];
      if (old?.contentAssetIds?.length || old?.contentPurgedAt) {
        if (!row || (old.contentAssetIds || []).some((id: string) => !row.contentAssetIds?.includes(id))
          || old.contentPurgedAt && old.contentPurgedAt !== row.contentPurgedAt
          || old.assetId !== row.assetId || old.key !== row.key || old.kind !== row.kind) throw contentPurgedError();
      }
      if (!row) continue;
      const ids = reportRowAssetIds(row);
      const purged = (await Promise.all(ids.map(isPurged))).some(Boolean);
      if (purged || row.contentPurgedAt) {
        if (!old || !purged || typeof row.contentPurgedAt !== 'string' || !Number.isFinite(Date.parse(row.contentPurgedAt))
          || !isDeepStrictEqual(row, clearedReportRow(group, row, row.contentPurgedAt))) throw contentPurgedError();
      }
    }
  }
}
