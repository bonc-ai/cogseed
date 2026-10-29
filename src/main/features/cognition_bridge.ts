/**
 * 存储切换桥：旧业务 API 继续负责验证、版本、证据和治理；桥只负责事实主档。
 * mirror：旧文件权威，主档失写后可从旧文件重放；unified：主档权威，旧文件是
 * 可重建兼容投影。主档与 pendingProjection 同一次原子提交，崩溃后可恢复投影。
 * 全部写入/迁移共享 transition 锁，锁序 transition → record/po → store。
 * 不迁移 JSONL：版本快照、采用回执和审计是支撑账，原 id/version 完整保留。
 */
import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { userCognitionDir, userCloudRoot } from '../paths';
import { safeId, writeJson } from '../storage';
import { fileEditLock } from '../util/locks';
import { corruptRecordFor } from '../util/corrupt-guard';
import { createLogger } from '../logger';
import { cognitionStorePath, loadCognitionStoreSync, editCognitionCompatibility, assertCognitionCommitActive, beginCognitionCommit } from './cognition_kernel/store';
import type { CognitionCompatibilityState, CognitionObject, CognitionStoreDocument } from './cognition_kernel/object-model';
import type { PoDocument } from './po/model';
import { synchronizeOntologyRuleBodies } from './cognition/ontology/shared-body';
import { refreshPendingAssetVersion } from './recall/asset-version-journal';

const log = createLogger('cognition-bridge');
export const MANAGED_COLLECTIONS = ['ability-assets', 'candidates'] as const;
export function isManagedCognitionCollection(collection: string): boolean {
  return (MANAGED_COLLECTIONS as readonly string[]).includes(collection);
}
const transitionContext = new AsyncLocalStorage<{ uid: string; active: boolean }>();
type SourceDependency = { uid: string; collection: string; active: boolean;
  edit: (doc: CognitionStoreDocument, record: Record<string, unknown>) => void | { records: Record<string, string[]> } };
const sourceDependencyContext = new AsyncLocalStorage<SourceDependency>();
/** A business dependency is applied inside the same fresh main-file draft as its source. */
export async function withCognitionSourceDependency<T>(uid: string, collection: string,
  edit: SourceDependency['edit'], work: () => Promise<T>): Promise<T> {
  const context: SourceDependency = { uid, collection, edit, active: true };
  try { return await sourceDependencyContext.run(context, work); } finally { context.active = false; }
}
export function withCognitionTransition<T>(uid: string, work: () => Promise<T>): Promise<T> {
  if (!safeId(uid)) throw new Error('invalid uid');
  assertCognitionCommitActive(uid);
  const held = transitionContext.getStore();
  if (held?.uid === uid && held.active) return work();
  return fileEditLock(path.join(userCognitionDir(uid), 'cognition-transition')).runExclusive(async () => {
    assertCognitionCommitActive(uid);
    const context = { uid, active: true };
    try { return await transitionContext.run(context, work); } finally { context.active = false; }
  });
}
function checkedStore(uid: string): CognitionStoreDocument {
  const doc = loadCognitionStoreSync(uid);
  if (corruptRecordFor(cognitionStorePath(uid))) throw Object.assign(new Error('cognition store corrupt; legacy fallback refused'), { code: 'COGNITION_CORRUPT' });
  return doc;
}
export function cognitionCompatibility(uid: string): CognitionCompatibilityState | undefined {
  return checkedStore(uid).compatibility;
}
export function readUnifiedCognitionRecord(uid: string, collection: string, id: string): {
  authoritative: boolean; record?: Record<string, unknown>;
} {
  if (!isManagedCognitionCollection(collection)) return { authoritative: false };
  const c = cognitionCompatibility(uid);
  return c?.mode === 'unified' ? { authoritative: true, record: Object.hasOwn(c.records[collection] ?? {}, id) ? c.records[collection][id] : undefined } : { authoritative: false };
}
/** One fresh, request-local collection snapshot; never reused by a later read/write. */
export function readUnifiedCognitionCollection(uid: string, collection: string): {
  authoritative: boolean; records: Record<string, Record<string, unknown>>;
} {
  if (!isManagedCognitionCollection(collection)) return { authoritative: false, records: {} };
  const c = cognitionCompatibility(uid);
  return { authoritative: c?.mode === 'unified', records: c?.mode === 'unified' ? c.records[collection] ?? {} : {} };
}
export function unifiedCognitionRecordIds(uid: string, collection: string): string[] | undefined {
  const c = cognitionCompatibility(uid);
  return c?.mode === 'unified' ? Object.keys(c.records[collection] ?? {}) : undefined;
}
export function readUnifiedPoDocument(uid: string): PoDocument | undefined {
  const c = cognitionCompatibility(uid);
  return c?.mode === 'unified' ? c.po as unknown as PoDocument : undefined;
}
function objectIdForPo(groupId: string, valueId: string): string {
  return 'co-po-' + createHash('sha256').update(JSON.stringify([groupId, valueId])).digest('hex').slice(0, 24);
}
/** 完整记录留兼容契约，规范对象用于统一读取；字段不猜测、不改写正文、不按正文去重。 */
function sourceObjects(c: CognitionCompatibilityState, includePoValues = true): CognitionObject[] {
  const out: CognitionObject[] = [];
  const homes: Record<string, CognitionObject['home']> = { cognition: 'cognition', personal: 'personal_fact', fact: 'personal_fact', rule: 'rule', template: 'template', skill_method: 'method' };
  const po = c.po as unknown as PoDocument | undefined;
  const projected = new Map<string, { g: PoDocument['groups'][number]; v: PoDocument['groups'][number]['values'][number] }>();
  for (const g of po?.groups ?? []) for (const v of g.values) if (v.assetId && !projected.has(v.assetId)) projected.set(v.assetId, { g, v });
  for (const a of Object.values(c.records['ability-assets'] ?? {})) {
    const home = homes[String(a.type)];
    if (!home) throw new Error(`unsupported asset type: ${String(a.id)}`);
    const status = String(a.status);
    if (!['active', 'paused', 'archived', 'deleted', 'purged', 'revoked'].includes(status)) throw new Error(`invalid asset status: ${String(a.id)}`);
    const version = Number(a.activeVersion ?? a.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`invalid asset version: ${String(a.id)}`);
    const projection = projected.get(String(a.id));
    const fieldName = projection?.g.fields.find(f => f.id === projection.v.fieldId)?.name;
    out.push({
      id: String(a.id), kind: home === 'cognition' || home === 'personal_fact' ? 'assertion' : home === 'rule' ? 'rule' : 'bundle', home,
      title: String(a.title ?? ''), statement: String(a.statement ?? ''), origin: String(a.origin ?? 'import'),
      status: status === 'revoked' ? 'paused' : status === 'purged' ? 'deleted' : status as CognitionObject['status'],
      version, createdAt: String(a.createdAt ?? ''), updatedAt: String(a.updatedAt ?? ''),
      managedSource: `recall:${String(a.id)}`,
      ...(home === 'template' || home === 'method' ? { bundleKind: home } : {}),
      ...(home === 'personal_fact' ? { fieldName: fieldName ?? String(a.title ?? ''), ...(projection ? { groupId: projection.g.id } : {}) } : {}),
      ...(a.deletedAt ? { deletedAt: String(a.deletedAt) } : {}),
      ...(a.mergedIntoAssetId ? { mergedIntoId: String(a.mergedIntoAssetId) } : {}),
      ...(a.restricted === true || projection?.v.restricted === true ? { restricted: true } : {}),
      ...(a.scope ? { scope: String(a.scope) } : {}),
    });
  }
  for (const g of includePoValues ? po?.groups ?? [] : []) for (const v of g.values) {
    if (v.assetId) continue; // 引用态仍由资产治理、版本和来源准入负责。
    const fieldName = g.fields.find(f => f.id === v.fieldId)?.name;
    if (!fieldName) throw new Error(`orphan ontology value: ${v.id}`);
    out.push({ id: objectIdForPo(g.id, v.id), kind: 'assertion', home: 'personal_fact', title: fieldName,
      statement: v.text, origin: v.source, status: 'active', version: 1, createdAt: v.createdAt,
      updatedAt: v.updatedAt, groupId: g.id, fieldName, managedSource: `po:${g.id}:${v.id}`,
      ...(v.restricted === true ? { restricted: true } : {}), ...(v.asOf ? { asOf: v.asOf } : {}),
      ...(v.verified !== undefined ? { verified: v.verified } : {}), ...(v.ruleKind ? { ruleKind: v.ruleKind } : {}),
    });
  }
  return out;
}
function rebuildObjects(doc: CognitionStoreDocument, c: CognitionCompatibilityState): void {
  const objects = sourceObjects(c);
  const unmanagedSlots = new Map(Object.values(doc.objects).filter(x => !x.managedSource && x.home !== 'cognition' && x.kind === 'assertion' && x.status !== 'deleted')
    .map(x => [JSON.stringify([x.groupId ?? '', x.fieldName]), x.id]));
  for (const o of objects) {
    const old = Object.hasOwn(doc.objects, o.id) ? doc.objects[o.id] : undefined;
    if (old && !old.managedSource) throw new Error(`unmanaged cognition object conflicts with source: ${o.id}`);
    const conflict = o.home !== 'cognition' && o.kind === 'assertion' ? unmanagedSlots.get(JSON.stringify([o.groupId ?? '', o.fieldName])) : undefined;
    if (conflict) throw new Error(`unmanaged cognition slot conflicts with source: ${conflict}`);
  }
  for (const [id, o] of Object.entries(doc.objects)) if (o.managedSource) delete doc.objects[id];
  for (const o of objects) Object.defineProperty(doc.objects, o.id, { value: o, writable: true, enumerable: true, configurable: true });
}
export async function replaceCognitionSources(uid: string, c: CognitionCompatibilityState): Promise<void> {
  await editCognitionCompatibility(uid, doc => { rebuildObjects(doc, c); doc.compatibility = c; });
}
/** mirror 失写不能让已提交的旧库操作变成假失败；完整旧记录就是重放日志。
 * 切权威必须再次全量核对。unified 失写则直接失败，绝不回落旧库。 */
async function commitSourceChange(uid: string, change: (c: CognitionCompatibilityState) => void, dirty: NonNullable<CognitionCompatibilityState['projectionChanges']>, dependencyRecord?: Record<string, unknown>): Promise<void> {
  await editCognitionCompatibility(uid, doc => {
    if (!doc.compatibility) throw new Error('missing compatibility state');
    const committingAssetVersion = Boolean(dependencyRecord && dirty.records['ability-assets']?.length
      && doc.compatibility.records['ability-assets']?.[String(dependencyRecord.id)]?.version !== dependencyRecord.version);
    const dependency = sourceDependencyContext.getStore();
    if (dependency?.active && dependency.uid === uid && dirty.records[dependency.collection]?.length && dependencyRecord) {
      if (doc.compatibility.mode !== 'unified') throw new Error('atomic cognition dependencies require unified storage');
      const additional = dependency.edit(doc, dependencyRecord);
      if (additional) for (const [collection, ids] of Object.entries(additional.records)) {
        if (!isManagedCognitionCollection(collection) || ids.some(id => !safeId(id))) throw new Error('invalid atomic dependency source');
        dirty.records[collection] = [...new Set([...(dirty.records[collection] || []), ...ids])];
      }
    }
    if (dependencyRecord && dirty.records['ability-assets']?.length) synchronizeOntologyRuleBodies(doc, dependencyRecord);
    // Joint ontology edits can add canonical references to the actual asset.
    // Queue that final snapshot in this same atomic draft, so interrupted ledger
    // appends recover the saved version exactly. Metadata-only writes must never
    // rewrite an already queued historical snapshot.
    if (committingAssetVersion && dependencyRecord) refreshPendingAssetVersion(dependencyRecord);
    // editCognitionCompatibility loads a fresh draft under the document lock.
    const next = doc.compatibility;
    if (next.mode === 'unified') {
      if (!next.pendingProjection) next.projectionChanges = { records: {} };
      if (next.projectionChanges) {
        for (const [collection, ids] of Object.entries(dirty.records)) next.projectionChanges.records[collection] = [...new Set([...(next.projectionChanges.records[collection] ?? []), ...ids])];
        if (dirty.po) next.projectionChanges.po = true;
        if (dirty.ontologyCandidates) next.projectionChanges.ontologyCandidates = true;
      }
    }
    change(next); next.revision++; next.pendingProjection = next.mode === 'unified';
    if (dirty.po) rebuildObjects(doc, next);
    else for (const id of dirty.records['ability-assets'] ?? []) {
      const source = next.records['ability-assets'][id];
      if (!source) { if (doc.objects[id]?.managedSource === `recall:${id}`) delete doc.objects[id]; continue; }
      const object = sourceObjects({ ...next, records: { 'ability-assets': { [id]: source } } }, false).find(o => o.managedSource === `recall:${id}`);
      if (!object) throw new Error('asset source object missing');
      const old = Object.hasOwn(doc.objects, id) ? doc.objects[id] : undefined;
      if (old && !old.managedSource) throw new Error(`unmanaged cognition object conflicts with source: ${id}`);
      if (object.home !== 'cognition' && object.kind === 'assertion' && Object.values(doc.objects).some(x => !x.managedSource && x.home !== 'cognition' && x.kind === 'assertion' && x.status !== 'deleted'
        && (x.groupId ?? '') === (object.groupId ?? '') && x.fieldName === object.fieldName)) throw new Error('unmanaged cognition slot conflicts with source');
      Object.defineProperty(doc.objects, id, { value: object, enumerable: true, configurable: true, writable: true });
    }
  });
}
export async function persistCognitionSource(uid: string, collection: string, id: string, record: Record<string, unknown>, legacyWrite: () => Promise<void>): Promise<void> {
  const c = cognitionCompatibility(uid);
  const dependency = sourceDependencyContext.getStore();
  if (dependency?.active && dependency.uid === uid && dependency.collection === collection && c?.mode !== 'unified')
    throw new Error('atomic cognition dependencies require unified storage');
  if (collection === 'ability-assets' && c?.mode !== 'unified'
    && [record, c?.records['ability-assets']?.[id]].some(source => Array.isArray(source?.ontologyRefs)
      && source.ontologyRefs.some(ref => ref && typeof ref === 'object' && (ref as Record<string, unknown>).sharedBody === true)))
    throw new Error('shared ontology bodies require unified storage');
  if (!c) { beginCognitionCommit(uid); await legacyWrite(); return; }
  const commit = () => commitSourceChange(uid, next => { Object.defineProperty(next.records[collection] ??= {}, id, { value: record, writable: true, enumerable: true, configurable: true }); }, { records: { [collection]: [id] } }, record);
  if (c.mode === 'mirror') {
    beginCognitionCommit(uid);
    await legacyWrite();
    try { await commit(); } catch { log.warn('cognition mirror needs reconciliation', { collection, id }); }
  } else {
    await commit();
    await recoverCognitionProjectionLocked(uid);
  }
}
export async function persistPoSource(uid: string, doc: PoDocument, legacyWrite: () => Promise<void>): Promise<void> {
  const c = cognitionCompatibility(uid);
  if (!c) { beginCognitionCommit(uid); await legacyWrite(); return; }
  const commit = () => commitSourceChange(uid, next => { next.po = doc as unknown as Record<string, unknown>; }, { records: {}, po: true });
  if (c.mode === 'mirror') {
    beginCognitionCommit(uid);
    await legacyWrite();
    try { await commit(); } catch { log.warn('ontology mirror needs reconciliation'); }
  } else { await commit(); await recoverCognitionProjectionLocked(uid); }
}
async function project(uid: string, c: CognitionCompatibilityState, full = true): Promise<void> {
  const dirty = full ? undefined : c.projectionChanges;
  for (const collection of MANAGED_COLLECTIONS) {
    if (dirty && !dirty.records[collection]?.length) continue;
    const dir = path.join(userCloudRoot(uid), 'recall', 'records', collection);
    fs.mkdirSync(dir, { recursive: true });
    for (const id of dirty ? dirty.records[collection] ?? [] : Object.keys(c.records[collection] ?? {})) {
      const record = c.records[collection]?.[id];
      if (!safeId(id)) throw new Error('invalid projection id');
      if (record) await writeJson(path.join(dir, `${id}.json`), record);
      else fs.rmSync(path.join(dir, `${id}.json`), { force: true });
    }
    if (!dirty) for (const name of fs.readdirSync(dir)) if (name.endsWith('.json') && !Object.hasOwn(c.records[collection] ?? {}, name.slice(0, -5))) {
      fs.unlinkSync(path.join(dir, name));
    }
  }
  if (c.po && (!dirty || dirty.po)) await writeJson(path.join(userCognitionDir(uid), 'personal-ontology.json'), c.po);
  if (c.ontologyCandidates && (!dirty || dirty.ontologyCandidates)) {
    const { candidatesMdPath, serializeCandidatesMarkdown } = await import('./personal_ontology_candidates');
    const { writeTextAtomicSync } = await import('../storage');
    writeTextAtomicSync(candidatesMdPath(uid), serializeCandidatesMarkdown(c.ontologyCandidates as never));
  }
}
/** 主档成功后的投影失败只留 pending，后续启动/迁移可重试；不能把操作报告为未写。 */
export async function recoverCognitionProjectionLocked(uid: string): Promise<boolean> {
  return fileEditLock(path.join(userCognitionDir(uid), 'cognition-projection')).runExclusive(() => projectPending(uid));
}
async function projectPending(uid: string): Promise<boolean> {
  const c = cognitionCompatibility(uid);
  if (!c || c.mode !== 'unified' || !c.pendingProjection) return true;
  try {
    await project(uid, c, false);
    await editCognitionCompatibility(uid, doc => {
      if (doc.compatibility?.revision === c.revision) {
        doc.compatibility.pendingProjection = false;
        delete doc.compatibility.projectionChanges;
      }
    });
    return true;
  } catch { log.warn('cognition compatibility projection pending recovery'); return false; }
}
export async function recoverCognitionProjection(uid: string, full = false): Promise<boolean> {
  return withCognitionTransition(uid, async () => {
    if (full) await editCognitionCompatibility(uid, doc => {
      if (doc.compatibility?.mode !== 'unified') return;
      doc.compatibility.pendingProjection = true;
      delete doc.compatibility.projectionChanges;
    });
    return recoverCognitionProjectionLocked(uid);
  });
}
export async function rollbackCognitionAuthority(uid: string): Promise<void> {
  await withCognitionTransition(uid, async () => {
    const c = cognitionCompatibility(uid);
    if (!c || c.mode !== 'unified') return;
    await project(uid, c); // 完整导出成功后才切回，半导出不能降权威。
    await editCognitionCompatibility(uid, doc => {
      if (!doc.compatibility) throw new Error('missing compatibility state');
      doc.compatibility.mode = 'mirror'; doc.compatibility.pendingProjection = false; delete doc.compatibility.projectionChanges;
    });
  });
}
/** 预检与真实提交共用冲突判定；返回差异前不写用户数据。 */
export function validateCognitionSources(uid: string, c: CognitionCompatibilityState): void {
  const draft = JSON.parse(JSON.stringify(checkedStore(uid))) as CognitionStoreDocument;
  rebuildObjects(draft, c);
}

export function readUnifiedOntologyCandidates(uid: string): Record<string, unknown>[] | undefined {
  const c = cognitionCompatibility(uid);
  return c?.mode === 'unified' ? c.ontologyCandidates ?? [] : undefined;
}
export async function persistOntologyCandidates(uid: string, candidates: Record<string, unknown>[], legacyWrite: () => Promise<void>): Promise<void> {
  await withCognitionTransition(uid, async () => {
    const c = cognitionCompatibility(uid);
    if (!c) { beginCognitionCommit(uid); await legacyWrite(); return; }
    const commit = () => commitSourceChange(uid, next => { next.ontologyCandidates = candidates; }, { records: {}, ontologyCandidates: true });
    if (c.mode === 'mirror') {
      beginCognitionCommit(uid);
      await legacyWrite();
      try { await commit(); } catch { log.warn('ontology candidate mirror needs reconciliation'); }
    } else { await commit(); await recoverCognitionProjectionLocked(uid); }
  });
}
