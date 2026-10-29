/** Owner-wide, source-qualified management reads. No task eligibility, use
 * receipts, migration, persistent directory or authorization cache is created. */
import { t } from '../../../i18n';
import { esticogseedToolResultTokens } from '../../../util/tool-result-cap';
import { readAbilityAsset } from '../../recall/asset-service';
import { readRecallCandidate } from '../../recall/candidate-service';
import { cognitionSourceControlSnapshot, isCognitionSourceEnabled } from '../../recall/source-control';
import type { CognitionSourceRef } from '../../recall/source-service';
import { assertAssetManagementSources, type CognitionEditHost } from '../edit-service';
import { assertFullManagementRead, decodeManagementCursor, encodeManagementCursor, MANAGEMENT_PAGE_TOKENS,
  managementReadVersion, managementContentChunk } from '../management-read';
import { readOntologyManagementView } from './legacy-view';
import { OntologyError, type OntologyDocument, type OntologyRecord } from './model';
import { readOntologyDocument } from './service';

type SourceState = 'available' | 'withheld' | 'unavailable';
function sourcesForManagement(userId: string, doc: OntologyDocument) {
  const records = new Map<string, Promise<SourceState>>(), assets = new Map<string, Promise<SourceState>>(), candidates = new Map<string, Promise<SourceState>>();
  const controls = new Map<string, { ref: CognitionSourceRef; version: string }>();
  const sourceRows = new Map<string, { version: string; read: () => Promise<unknown> }>();
  const enabled = async (ref: CognitionSourceRef) => {
    const key = `${ref.kind}:${ref.id}`;
    controls.set(key, { ref, version: cognitionSourceControlSnapshot(userId, ref) });
    return isCognitionSourceEnabled(userId, ref);
  };
  const asset = (id: string): Promise<SourceState> => {
    if (!assets.has(id)) assets.set(id, (async (): Promise<SourceState> => {
      const row = await readAbilityAsset(userId, id);
      sourceRows.set(`asset:${id}`, { version: managementReadVersion(row), read: () => readAbilityAsset(userId, id) });
      if (row.ownerId !== userId || ['deleted', 'purged', 'revoked'].includes(row.status)) return 'withheld';
      for (const ref of row.evidenceRefs) if (!await enabled(ref)) return 'withheld';
      await assertAssetManagementSources(userId, row);
      return 'available';
    })().catch((): SourceState => 'unavailable'));
    return assets.get(id)!;
  };
  const candidate = (id: string): Promise<SourceState> => {
    if (!candidates.has(id)) candidates.set(id, (async (): Promise<SourceState> => {
      const row = await readRecallCandidate(userId, id);
      sourceRows.set(`candidate:${id}`, { version: managementReadVersion(row), read: () => readRecallCandidate(userId, id) });
      if (row.status === 'confirmed' && row.promotedAssetId) return asset(row.promotedAssetId);
      if (row.status !== 'integrated' || row.proposalTarget !== 'ontology') return 'withheld';
      for (const ref of [...row.sourceRefs, ...row.evidenceRefs]) if (!await enabled(ref)) return 'withheld';
      return 'available';
    })().catch((): SourceState => 'unavailable'));
    return candidates.get(id)!;
  };
  const record = (row: OntologyRecord): Promise<SourceState> => {
    if (!records.has(row.id)) records.set(row.id, (async (): Promise<SourceState> => {
      const results: SourceState[] = [];
      if (row.kind !== 'module') {
        const module = doc.records[row.moduleId];
        if (!module || module.kind !== 'module') return 'unavailable';
        results.push(await record(module));
      }
      const refs = [...(row.source.refs || [])];
      if (row.source.kind === 'candidate') {
        if (!row.source.recordId) return 'unavailable';
        refs.push({ kind: 'candidate', id: row.source.recordId });
      }
      for (const ref of refs) {
        if (ref.kind === 'asset') results.push(await asset(ref.id));
        if (ref.kind === 'candidate') results.push(await candidate(ref.id));
      }
      return results.includes('withheld') ? 'withheld' : results.includes('unavailable') ? 'unavailable' : 'available';
    })());
    return records.get(row.id)!;
  };
  return { record, verify: async () => {
    for (const { ref, version } of controls.values()) if (cognitionSourceControlSnapshot(userId, ref) !== version) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
    for (const { version, read } of sourceRows.values()) if (managementReadVersion(await read()) !== version) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
  } };
}

async function view(userId: string) {
  const canonical = readOntologyDocument(userId);
  try { return { canonical, ...await readOntologyManagementView(canonical, userId), legacyComplete: true }; }
  catch (error) {
    // A legacy failure is not an empty canonical document or a complete view.
    return { canonical, ontology: canonical, legacyFullText: new Map<string, string>(), legacyComplete: false };
  }
}
const viewVersion = (v: Awaited<ReturnType<typeof view>>) => managementReadVersion({ revision: v.canonical.revision,
  records: v.ontology.records, legacyFullText: [...v.legacyFullText].sort(([a], [b]) => a.localeCompare(b)), legacyComplete: v.legacyComplete });
export const ontologyManagementContract = (record: OntologyRecord, fullText?: string) => ({ record,
  ...(fullText !== undefined ? { legacySourceContent: { format: 'text', text: fullText, complete: true, readOnly: true } } : {}) });

export async function readOntologyManagementRecord(userId: string, recordId: string, contentCursor?: unknown, expectedRevision?: unknown) {
  const snapshot = await view(userId), record = snapshot.ontology.records[recordId];
  if (!record) throw new OntologyError('not_found', t('cognition.read.record_unavailable'));
  if (expectedRevision !== undefined && expectedRevision !== snapshot.canonical.revision) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
  const sources = sourcesForManagement(userId, snapshot.ontology), state = await sources.record(record);
  if (state !== 'available') throw new OntologyError('source_unavailable', t('cognition.read.source_unavailable'));
  const contract = { mode: 'manage', revision: snapshot.canonical.revision, ...ontologyManagementContract(record, snapshot.legacyFullText.get(recordId)),
    module: (() => { const m = record.kind === 'module' ? record : snapshot.ontology.records[record.moduleId]; return m ? { id: m.id, version: m.version, status: m.status } : null; })(),
    sharedBodyOwner: record.kind === 'rule' ? record.source.refs?.find(ref => ref.kind === 'asset')?.id : undefined,
    useBoundary: t('cognition.read.use_boundary') };
  const version = viewVersion(snapshot);
  await sources.verify();
  if (viewVersion(await view(userId)) !== version) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
  return { doc: snapshot.ontology, record, contract,
    content: contentCursor === undefined ? contract : managementContentChunk(userId, 'ontology', recordId, contract, contentCursor) };
}

function counts(rows: OntologyRecord[]) {
  const tally = (key: 'kind' | 'status' | 'access') => rows.reduce((out, r) => { out[r[key]] = (out[r[key]] || 0) + 1; return out; }, {} as Record<string, number>);
  return { total: rows.length, modules: rows.filter(r => r.kind === 'module').length, byKind: tally('kind'), byStatus: tally('status'), byAccess: tally('access') };
}
export async function readOntologyInventory(userId: string, host: CognitionEditHost, input: { limit?: unknown; cursor?: unknown; expectedRevision?: unknown }) {
  await assertFullManagementRead(userId, host, 'ontology');
  const limit = input.limit === undefined ? 25 : input.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new OntologyError('invalid_input', t('cognition.read.invalid_limit'));
  const snapshot = await view(userId), revision = snapshot.canonical.revision;
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
  const rows = Object.values(snapshot.ontology.records).sort((a, b) => a.id.localeCompare(b.id));
  const sources = sourcesForManagement(userId, snapshot.ontology), states = new Map<string, SourceState>();
  for (const row of rows) states.set(row.id, await sources.record(row));
  const version = managementReadVersion({ view: viewVersion(snapshot), sources: [...states] }), key = `${userId}:ontology:inventory`;
  const offset = input.cursor === undefined ? 0 : decodeManagementCursor(input.cursor, key, version);
  if (offset > rows.length) throw new OntologyError('invalid_cursor', t('cognition.read.invalid_cursor'));
  const records: Record<string, unknown>[] = [];
  for (const row of rows.slice(offset, offset + limit)) {
    const origin = Object.hasOwn(snapshot.canonical.records, row.id) ? 'canonical' : 'legacy_projection';
    const meta = { id: row.id, kind: row.kind, ...(row.kind !== 'module' ? { moduleId: row.moduleId } : {}), version: row.version, status: row.status, access: row.access };
    const state = states.get(row.id)!;
    let entry: Record<string, unknown> = state !== 'available' ? { origin, ...meta, contentState: state, reasonCode: 'source_unavailable' }
      : { origin, contentState: 'complete', ...ontologyManagementContract(row, snapshot.legacyFullText.get(row.id)) };
    if (esticogseedToolResultTokens(JSON.stringify(entry)) > MANAGEMENT_PAGE_TOKENS - 1_000) entry = { origin, ...meta,
      contentState: 'requires_chunk_read', managementRead: { mode: 'manage', recordId: row.id, contentCursor: 0, expectedRevision: revision } };
    if (records.length && esticogseedToolResultTokens(JSON.stringify([...records, entry])) > MANAGEMENT_PAGE_TOKENS - 1_000) break;
    records.push(entry);
  }
  await sources.verify();
  if (viewVersion(await view(userId)) !== viewVersion(snapshot)) throw new OntologyError('inventory_snapshot_changed', t('cognition.read.snapshot_changed'));
  const canonicalRows = Object.values(snapshot.canonical.records), legacyRows = rows.filter(r => !Object.hasOwn(snapshot.canonical.records, r.id));
  const next = offset + records.length;
  return { mode: 'inventory', status: snapshot.legacyComplete ? 'ok' : 'partial', snapshot: { revision, token: version },
    counts: { ...(snapshot.legacyComplete ? counts(rows) : { total: null, modules: null }), canonical: counts(canonicalRows),
      legacyAdditional: snapshot.legacyComplete ? counts(legacyRows) : null }, records,
    page: { offset, returned: records.length, nextCursor: snapshot.legacyComplete && next < rows.length ? encodeManagementCursor(key, version, next) : null },
    coverage: { scope: 'owner_all_current_records', totalKnown: snapshot.legacyComplete, legacy: snapshot.legacyComplete ? 'complete' : 'unavailable',
      withheldSourceCount: [...states.values()].filter(s => s === 'withheld').length, unavailableSourceCount: [...states.values()].filter(s => s === 'unavailable').length,
      pageContentComplete: records.every(r => r.contentState === 'complete') },
    useBoundary: t('cognition.read.inventory_boundary') };
}
