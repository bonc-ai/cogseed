/** Owner-scoped read helpers. They never grant editing or task-use authority;
 * each caller still checks current sources before returning a body. */
import { createHash } from 'node:crypto';
import { t } from '../../i18n';
import { esticogseedToolResultTokens } from '../../util/tool-result-cap';
import { OntologyError } from './ontology/model';

export type ManagementReadDomain = 'asset' | 'ontology';
export const MANAGEMENT_PAGE_TOKENS = 5_500;
export const MANAGEMENT_CHUNK_TOKENS = 1_500;
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
export const managementReadText = (v: unknown): string => JSON.stringify(stable(v));
/** Functional stale-read binding, not an authorization token. */
export const managementReadVersion = (v: unknown): string => createHash('sha256').update(managementReadText(v)).digest('hex');

type ReadCursor = { v: 1; key: string; version: string; offset: number };
export function encodeManagementCursor(key: string, version: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, key, version, offset })).toString('base64url');
}
export function decodeManagementCursor(raw: unknown, key: string, version: string): number {
  if (typeof raw !== 'string' || !raw || raw.length > 2_000) throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor'));
  let c: ReadCursor; try { c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor')); }
  if (!c || c.v !== 1 || c.key !== key || !Number.isSafeInteger(c.offset) || c.offset < 0) throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor'));
  if (c.version !== version) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
  return c.offset;
}
/** Rebuild this complete contract from current domains BEFORE every call.
 * Chunking JSON rather than just its body preserves all conditions/metadata. */
export function managementContentChunk(userId: string, domain: ManagementReadDomain, id: string, contract: unknown, cursor: unknown) {
  const text = managementReadText(contract), version = managementReadVersion(contract), key = `${userId}:${domain}:${id}:content`;
  const offset = cursor === 0 || cursor === '0' ? 0 : decodeManagementCursor(cursor, key, version);
  if (offset > text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] || '')) throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor'));
  let end = offset;
  for (const point of text.slice(offset)) {
    if (esticogseedToolResultTokens(text.slice(offset, end + point.length)) > MANAGEMENT_CHUNK_TOKENS) break;
    end += point.length;
  }
  const mode = contract && typeof contract === 'object' && 'mode' in contract && contract.mode === 'task' ? 'task' : 'manage';
  return { mode, format: 'complete-management-contract-json', id, version,
    contentRange: { start: offset, end, total: text.length }, content: text.slice(offset, end),
    nextContentCursor: end < text.length ? encodeManagementCursor(key, version, end) : null,
    contentComplete: offset === 0 && end === text.length,
    useBoundary: t('cognition.read.use_boundary') };
}
