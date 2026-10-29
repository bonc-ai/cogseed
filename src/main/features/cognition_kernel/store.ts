/**
 * cognition_kernel/store — 统一认知库存储内核。
 *
 * 单一事实源：`<uid>/cloud/cognition/cognition-store.json`（object-model.ts 的
 * CognitionStoreDocument）。一切写入皆 Delta：唯一写入口 applyCognitionDeltas
 * （锁 → 加载 → 坏档门 → 纯函数落地 → 原子写主档 → 版本流追加 → 台账追加）。
 *
 * 工程骨架吸收 po v2（文件锁/坏档三件套/原子写/schemaVersion）与 recall
 * （每对象 append-only 版本流 jsonl）。落盘形态=单 JSON 主档+版本流+台账，
 * 不做事件溯源，云同步单元保持单文件。
 *
 * 本模块是可剥离内核：只依赖 node fs 与仓内基础层（storage/paths/locks/
 * corrupt-guard/logger），不 import electron/ipc/renderer/索引器——索引与
 * 通知钩子由消费面以注入方式挂回。
 */

import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { applyOntologyCommand, type OntologyCommandOutcome, type OntologyCommandSourceOverride } from '../cognition/ontology/commands';
import { emptyOntologyDocument, OntologyError, validateOntologyDocument } from '../cognition/ontology/model';
import type { CognitionEditDecision } from '../cognition/edit-decision';
import * as path from 'node:path';
import { fileEditLock } from '../../util/locks';
import { corruptRecordFor, readTextGuarded, reportCorruptFile } from '../../util/corrupt-guard';
import { userCognitionDir } from '../../paths';
import { genId12, nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import type { CognitionDelta } from './types';
import { validateDelta } from './delta';
import {
  COGNITION_STORE_SCHEMA_VERSION,
  APPLIED_DELTA_INDEX_MAX,
  DEFAULT_HOME_REGISTRY,
  type CognitionObject,
  type CognitionObjectKind,
  type CognitionStoreDocument,
  type HomeRegistryEntry,
  emptyCognitionStore,
  findAssertionSlot,
  normalizeCognitionStoreDocument,
  storeShapeForHomes,
  validateHomeRegistry,
} from './object-model';

const log = createLogger('cognition-store');

type CommitLifetime = { uid: string; signal?: AbortSignal; active: boolean; started: boolean; onCommitStarted?: () => void };
const commitLifetimes = new AsyncLocalStorage<CommitLifetime>();
/** Host-only lifetime for one save and its receipt/recovery chain. Waiting for
 * a write lock remains cancellable; once the first durable write starts, the
 * operation completes normally instead of abandoning a partially saved result. */
export async function withCognitionCommitLifetime<T>(uid: string, signal: AbortSignal | undefined,
  work: () => Promise<T>, onCommitStarted?: () => void): Promise<T> {
  if (!signal && !onCommitStarted) return work();
  signal?.throwIfAborted();
  const lifetime: CommitLifetime = { uid, signal, active: true, started: false, onCommitStarted };
  try { return await commitLifetimes.run(lifetime, work); } finally { lifetime.active = false; }
}
export function assertCognitionCommitActive(uid: string): void {
  const lifetime = commitLifetimes.getStore();
  if (lifetime?.active && lifetime.uid === uid && !lifetime.started) lifetime.signal?.throwIfAborted();
}
/** Call synchronously after the last write lock, immediately before I/O. */
export function beginCognitionCommit(uid: string): void {
  assertCognitionCommitActive(uid);
  const lifetime = commitLifetimes.getStore();
  if (lifetime?.active && lifetime.uid === uid && !lifetime.started) {
    lifetime.onCommitStarted?.();
    lifetime.started = true;
  }
}

/** 坏档三件套的业务域名（恢复通道按 domain 寻址，与 po / ontology-candidates 并列）。 */
export const COGNITION_STORE_CORRUPT_DOMAIN = 'cognition-store';

const VERSIONS_DIR = 'cognition-versions';
const AUDIT_FILE = 'cognition-audit.jsonl';
const AUDIT_SUMMARY_MAX_CHARS = 200;

export function cognitionStorePath(uid: string): string {
  return path.join(userCognitionDir(uid), 'cognition-store.json');
}

function versionsDir(uid: string): string {
  return path.join(userCognitionDir(uid), VERSIONS_DIR);
}

function versionStreamPath(uid: string, objectId: string): string {
  return path.join(versionsDir(uid), `${objectId}.jsonl`);
}

export function cognitionAuditPath(uid: string): string {
  return path.join(userCognitionDir(uid), AUDIT_FILE);
}

// ── 读取 ─────────────────────────────────────────────────────────────────

/**
 * 同步加载：坏档三件套读侧（copy 备份 + 登记拒写 latch）后返回空库供展示；
 * ENOENT → 空库（懒创建，读路径零副作用、永不写盘）。
 */
export function loadCognitionStoreSync(uid: string): CognitionStoreDocument {
  if (!safeId(uid)) return emptyCognitionStore();
  const filePath = cognitionStorePath(uid);
  if (!fs.existsSync(filePath)) return emptyCognitionStore();
  const guarded = readTextGuarded(filePath, { domain: COGNITION_STORE_CORRUPT_DOMAIN });
  if (guarded.status === 'corrupt') return emptyCognitionStore();
  if (guarded.status !== 'ok') return emptyCognitionStore();
  try {
    const parsed = JSON.parse(guarded.text) as Record<string, unknown>;
    if (parsed.schemaVersion !== COGNITION_STORE_SCHEMA_VERSION) {
      // 版本不符属「未来档」：按坏档处理（不猜结构），等迁移通道升版。
      reportCorruptFile(filePath, `unsupported schemaVersion ${String(parsed.schemaVersion)}`, {
        domain: COGNITION_STORE_CORRUPT_DOMAIN,
      });
      return emptyCognitionStore();
    }
    return normalizeCognitionStoreDocument(parsed);
  } catch (err) {
    reportCorruptFile(filePath, `bad JSON: ${(err as Error).message}`, {
      domain: COGNITION_STORE_CORRUPT_DOMAIN,
    });
    log.warn('cognition store unreadable; corrupt-guard engaged', { uid, error: (err as Error).message });
    return emptyCognitionStore();
  }
}

// ── 纯函数落地器 ─────────────────────────────────────────────────────────

export type DeltaApplyResult =
  | { applied: true; objectId: string; op: CognitionDelta['op'] }
  | { applied: false; reason: string; duplicate?: boolean };

/** 硬失败（非重复跳过）才让整批回滚；duplicate 是合法的幂等跳过。 */
function isDeltaFailure(r: DeltaApplyResult): r is Extract<DeltaApplyResult, { applied: false }> {
  return r.applied === false && r.duplicate !== true;
}

function deltaFingerprint(delta: CognitionDelta): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(delta))).digest('hex');
}

function rememberAppliedDelta(doc: CognitionStoreDocument, delta: CognitionDelta): void {
  // 幂等口径=按 deltaId 精确重放去重（双提交/崩溃重试）；槽位键（idempotencyKey）
  // 是候选池「同槽只留最新提议」的语义，不用于存储侧——同一对象的后续变更
  // 是新 Delta，必须放行，不能按槽位键吞掉后续版本。
  doc.deltaReceipts ??= {};
  doc.deltaReceipts[delta.deltaId] = deltaFingerprint(delta);
  doc.appliedDeltas[delta.deltaId] = true;
  doc.appliedOrder.push(delta.deltaId);
  while (doc.appliedOrder.length > APPLIED_DELTA_INDEX_MAX) {
    const oldest = doc.appliedOrder.shift();
    if (oldest) delete doc.appliedDeltas[oldest];
  }
}

function newObject(
  delta: CognitionDelta,
  shape: { kind: CognitionObjectKind; bundleKind?: string },
  now: string,
): CognitionObject | null {
  const id = delta.target.objectId?.trim() || `co-${genId12()}`;
  const isAssertion = shape.kind === 'assertion';
  return {
    id,
    kind: shape.kind,
    home: delta.target.home,
    title: (isAssertion ? delta.target.fieldName ?? delta.after ?? '' : delta.after ?? '').slice(0, 200),
    statement: delta.after ?? '',
    origin: delta.origin,
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...(delta.target.groupId ? { groupId: delta.target.groupId } : {}),
    ...(delta.target.fieldName ? { fieldName: delta.target.fieldName } : {}),
    ...(shape.bundleKind ? { bundleKind: shape.bundleKind as CognitionObject['bundleKind'] } : {}),
    ...(delta.evidenceRefs.length ? { evidenceRefs: [...delta.evidenceRefs] } : {}),
  };
}

/**
 * 单个 Delta 的纯落地（不碰盘）。op 语义：
 *  add=新建对象；update=按 objectId 改 statement/title 并升版；
 *  set=断言槽位 (groupId,fieldName) 赋值（无则建）；remove=软删（留墓碑）。
 * 幂等：同一 idempotencyKey 重复落地 → duplicate 跳过；status≠applied 一律拒收
 *（proposed 属候选池，不进本库）。
 */
export function applyCognitionDelta(doc: CognitionStoreDocument, delta: CognitionDelta): DeltaApplyResult {
  return applyCognitionDeltaAtReceiptCount(doc, delta, Object.keys(doc.deltaReceipts ?? {}).length);
}

function applyCognitionDeltaAtReceiptCount(doc: CognitionStoreDocument, delta: CognitionDelta, receiptCount: number): DeltaApplyResult {
  const knownHomes = new Set<string>(doc.homes.map((entry) => entry.home));
  const checked = validateDelta(delta, knownHomes);
  if (checked.ok === false) {
    return { applied: false, reason: `invalid delta: ${checked.reason}` };
  }
  if (delta.status !== 'applied') {
    return { applied: false, reason: `delta status '${delta.status}' not appliable (proposed 属候选池)` };
  }
  if (delta.op !== 'remove' && !delta.evidenceRefs.length) return { applied: false, reason: 'authoritative value requires evidenceRefs' };
  const receipt = doc.deltaReceipts?.[delta.deltaId];
  if (receipt && receipt !== deltaFingerprint(delta)) return { applied: false, reason: 'deltaId reused with different content' };
  if (receipt || doc.appliedDeltas[delta.deltaId]) {
    return { applied: false, reason: 'delta already applied (exact replay)', duplicate: true };
  }
  // 永久回执不能随热索引淘汰，否则旧请求重放会再次写入。容量满时明确失败。
  if (receiptCount >= 100000) return { applied: false, reason: 'durable replay receipt capacity exceeded' };
  const objectId0 = delta.target.objectId?.trim() ?? '';
  if (objectId0 && !safeId(objectId0)) {
    return { applied: false, reason: 'invalid objectId' };
  }
  const shape = storeShapeForHomes(doc.homes, delta.target.home);
  if (!shape) {
    return { applied: false, reason: `家 '${delta.target.home}' 不可存（experience/task_local 类只判不存，走各自支撑位）` };
  }
  const now = new Date().toISOString();

  let objectId = delta.target.objectId?.trim() || '';
  if (delta.op === 'add') {
    if (objectId && doc.objects[objectId]) {
      return { applied: false, reason: `object ${objectId} already exists` };
    }
    const created = newObject(delta, shape, now);
    if (!created) return { applied: false, reason: 'cannot build object from delta' };
    objectId = created.id;
    doc.objects[objectId] = created;
  } else if (delta.op === 'set') {
    if (shape.kind !== 'assertion') {
      return { applied: false, reason: 'op set 只用于断言槽位（rule/bundle 用 update）' };
    }
    const slot = findAssertionSlot(doc, delta.target.groupId, delta.target.fieldName ?? '');
    if (slot) {
      if (slot.managedSource) return { applied: false, reason: 'source-managed slot; use canonical business API' };
      slot.statement = delta.after ?? '';
      slot.updatedAt = now;
      slot.version += 1;
      objectId = slot.id;
    } else {
      const created = newObject(delta, shape, now);
      if (!created) return { applied: false, reason: 'cannot build assertion from delta' };
      objectId = created.id;
      doc.objects[objectId] = created;
    }
  } else {
    // update / remove：必须能定位对象（objectId 或断言槽位）。
    let target: CognitionObject | undefined =
      (objectId && doc.objects[objectId]) || undefined;
    if (!target && shape.kind === 'assertion') {
      target = findAssertionSlot(doc, delta.target.groupId, delta.target.fieldName ?? '');
    }
    if (!target) return { applied: false, reason: `object not found: ${objectId || delta.target.fieldName || '?'}` };
    objectId = target.id;
    if (target.managedSource) return { applied: false, reason: 'source-managed object; use canonical business API' };
    if (delta.op === 'update') {
      if (target.status === 'deleted') return { applied: false, reason: `object ${objectId} 已删除，先恢复再改` };
      target.statement = delta.after ?? '';
      if (delta.target.fieldName) target.fieldName = delta.target.fieldName;
      target.updatedAt = now;
      target.version += 1;
    } else {
      target.status = 'deleted';
      target.deletedAt = now;
      target.updatedAt = now;
    }
  }
  rememberAppliedDelta(doc, delta);
  doc.updatedAt = now;
  return { applied: true, objectId, op: delta.op };
}

// ── 持久化（唯一写入口）─────────────────────────────────────────────────

export interface ApplyDeltasOutcome {
  ok: boolean;
  error?: string;
  results: DeltaApplyResult[];
  appliedCount: number;
  pendingHistory?: boolean;
  ontology?: Omit<OntologyCommandOutcome, 'document'>;
}

interface VersionLine {
  at: string;
  deltaId: string;
  op: string;
  version: number;
  origin: string;
  before?: string;
  after?: string;
}

function appendJsonl(filePath: string, line: unknown, maxChars: number): void {
  const text = JSON.stringify(line);
  if (text.length > maxChars) throw new Error('journal line exceeds capacity');
  const fd = fs.openSync(filePath, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > 0) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1); if (last[0] !== 10) fs.writeSync(fd, '\n'); }
    fs.writeFileSync(fd, text + '\n', 'utf8'); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function summary(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > AUDIT_SUMMARY_MAX_CHARS ? `${t.slice(0, AUDIT_SUMMARY_MAX_CHARS)}…` : t;
}

/**
 * 唯一写入口：文件锁内 加载→坏档门→逐个纯落地→原子写主档→版本流→台账。
 * 全批原子语义：任何一个 Delta 非法/失败都不落盘（要么全生效，要么全不动）。
 */
type CognitionDocumentBatch = { kind: 'document'; edit: (doc: CognitionStoreDocument) => void | false };
export type OntologyDeltaBatch = { kind: 'ontology'; command: unknown; sourceOverride?: OntologyCommandSourceOverride; userEditDecision?: CognitionEditDecision };

/** Retry projections under the same store lock. The durable main-file journal is authoritative until drained. */
function drainJournal(uid: string, doc: CognitionStoreDocument): boolean {
  const remaining: NonNullable<CognitionStoreDocument['pendingJournal']> = [];
  const journalKeys = new Map<string, Set<string>>();
  for (const entry of doc.pendingJournal ?? []) {
    try {
      const target = entry.objectId ? versionStreamPath(uid, entry.objectId) : cognitionAuditPath(uid);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let keys = journalKeys.get(target);
      if (!keys) {
        keys = new Set<string>();
        const prior = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').split('\n') : [];
        for (const text of prior) { try { const key = JSON.parse(text).journalKey; if (typeof key === 'string') keys.add(key); } catch { /* retain malformed historical lines */ } }
        journalKeys.set(target, keys);
      }
      if (!keys.has(entry.key)) {
        appendJsonl(target, { ...entry.line, journalKey: entry.key }, 16 * 1024 * 1024);
        keys.add(entry.key);
      }
    } catch (error) {
      remaining.push(entry);
      log.warn('cognition journal projection pending', { uid, key: entry.key, error: String(error) });
    }
  }
  doc.pendingJournal = remaining;
  return remaining.length > 0;
}

export async function applyCognitionDeltas(uid: string, deltas: readonly CognitionDelta[] | OntologyDeltaBatch | CognitionDocumentBatch): Promise<ApplyDeltasOutcome> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid', results: [], appliedCount: 0 };
  const filePath = cognitionStorePath(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    assertCognitionCommitActive(uid);
    const doc = loadCognitionStoreSync(uid);
    if (corruptRecordFor(filePath)) return { ok: false, error: 'cognition store corrupt; write refused', results: [], appliedCount: 0 };
    const draft: CognitionStoreDocument = JSON.parse(JSON.stringify(doc));
    const results: DeltaApplyResult[] = [];
    let ontology: ApplyDeltasOutcome['ontology'];
    let appliedCount = 0;
    draft.pendingJournal ??= [];
    if (!Array.isArray(deltas)) {
      const batch = deltas as OntologyDeltaBatch | CognitionDocumentBatch;
      if (batch.kind === 'document') {
        if (batch.edit(draft) === false) return { ok: true, results, appliedCount: 0 };
        const commitKey = createHash('sha256').update(JSON.stringify([doc, draft])).digest('hex');
        for (const id of new Set([...Object.keys(doc.objects), ...Object.keys(draft.objects)])) {
          const before = doc.objects[id], after = draft.objects[id];
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          draft.pendingJournal.push({ key: `document-${commitKey}-${id}`, objectId: id, line: {
            at: new Date().toISOString(), deltaId: `document-${commitKey}-${id}`, op: after ? before ? 'update' : 'add' : 'remove',
            version: after?.version ?? (before.version + 1), origin: 'projection', before: before?.statement, after: after?.statement,
            evidenceRefs: after?.evidenceRefs ?? before?.evidenceRefs ?? [],
          } });
        }
        draft.pendingJournal.push({ key: `document-${commitKey}`, line: { at: new Date().toISOString(), kind: 'compatibility', commitKey } });
        appliedCount = 1;
      } else {
      const current = draft.ontology ?? emptyOntologyDocument(uid);
      if (current.ownerId !== uid) throw new OntologyError('store_corrupt', 'ontology owner mismatch');
      const outcome = applyOntologyCommand(current, batch.command, new Date().toISOString(), batch.sourceOverride);
      if (!outcome.duplicate) {
        if (batch.userEditDecision) {
          outcome.receipt.userEditDecision = batch.userEditDecision;
          outcome.document.receipts[outcome.receipt.commandId] = outcome.receipt;
        }
        if (Buffer.byteLength(JSON.stringify(outcome.document), 'utf8') > 16 * 1024 * 1024) throw new OntologyError('capacity_exceeded', 'ontology document exceeds size limit');
        draft.ontology = outcome.document;
        appliedCount = 1;
        draft.pendingJournal.push({ key: `ontology-${outcome.receipt.commandId}`, line: { at: nowIso(), kind: 'ontology', receipt: outcome.receipt } });
      }
      ontology = { receipt: outcome.receipt, duplicate: outcome.duplicate };
      }
    } else {
      let receiptCount = Object.keys(draft.deltaReceipts ?? {}).length;
      for (const delta of deltas) {
        const result = applyCognitionDeltaAtReceiptCount(draft, delta, receiptCount);
        results.push(result);
        if (isDeltaFailure(result)) return { ok: false, error: result.reason, results, appliedCount: 0 };
        if (!result.applied) continue;
        appliedCount++;
        receiptCount++;
        const object = draft.objects[result.objectId];
        draft.pendingJournal.push({ key: `version-${delta.deltaId}`, objectId: result.objectId, line: {
          at: object.updatedAt, deltaId: delta.deltaId, op: delta.op, version: object.version, origin: delta.origin, evidenceRefs: [...delta.evidenceRefs],
          ...(delta.before != null ? { before: delta.before } : {}), ...(delta.after != null ? { after: delta.after } : {}),
        } });
        draft.pendingJournal.push({ key: `audit-${delta.deltaId}`, line: { at: nowIso(), ops: [{ objectId: result.objectId,
          op: delta.op, home: delta.target.home, origin: delta.origin, summary: summary(delta.after ?? delta.before ?? delta.deltaId) }] } });
      }
    }
    if (!appliedCount && !draft.pendingJournal.length) return { ok: true, results, appliedCount, ontology };
    if (appliedCount) draft.updatedAt = nowIso();
    if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > 64 * 1024 * 1024) return { ok: false, error: 'cognition store capacity exceeded', results, appliedCount: 0 };
    beginCognitionCommit(uid);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeStoreFileSync(filePath, draft);
    const pendingHistory = drainJournal(uid, draft);
    // Projection cleanup is optional: a crash or failure leaves replayable entries in the committed file.
    try { writeStoreFileSync(filePath, draft); } catch (error) { log.warn('cognition journal cleanup pending', { uid, error: String(error) }); }
    return { ok: true, results, appliedCount, pendingHistory, ontology };
  });
}

function writeStoreFileSync(filePath: string, doc: CognitionStoreDocument): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(doc, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

const PURGED_AUDIT_SUMMARY = '[已清除]';

/** Audit entries keep governance coordinates; only the purged object's summary loses its text. */
function scrubAuditLine(line: Record<string, unknown>, objectId: string): boolean {
  if (!Array.isArray(line.ops)) return false;
  let changed = false;
  for (const raw of line.ops) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const op = raw as Record<string, unknown>;
    if (op.objectId !== objectId) continue;
    if (op.summary !== PURGED_AUDIT_SUMMARY) { op.summary = PURGED_AUDIT_SUMMARY; changed = true; }
  }
  return changed;
}

function writeTextFileAtomicSync(filePath: string, text: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

/** Rewrite persisted audit summaries for one purged object; malformed lines cannot
 *  prove they are free of its text, so purge drops them. */
function scrubCognitionAuditFile(uid: string, objectId: string): number {
  const filePath = cognitionAuditPath(uid);
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let changed = 0;
  let dropped = 0;
  const kept: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { dropped += 1; continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { dropped += 1; continue; }
    if (scrubAuditLine(parsed as Record<string, unknown>, objectId)) changed += 1;
    kept.push(JSON.stringify(parsed));
  }
  if (!changed && !dropped) return 0;
  if (!kept.length) fs.rmSync(filePath, { force: true });
  else writeTextFileAtomicSync(filePath, kept.join('\n') + '\n');
  if (dropped) log.warn('cognition audit purge dropped malformed lines', { uid, dropped });
  return changed + dropped;
}

export interface PurgeCognitionObjectOutcome {
  removedVersions: boolean;
  pendingRemoved: number;
}

/** Remove the unified-store history and replayable journal entries for an
 *  ability asset. The tombstone object/record stays for ID traceability, but no
 *  old statement may survive in the version stream or the pending journal. */
export async function purgeCognitionObject(uid: string, objectId: string): Promise<PurgeCognitionObjectOutcome> {
  if (!safeId(uid) || !safeId(objectId)) throw new Error('invalid cognition purge identity');
  const filePath = cognitionStorePath(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    assertCognitionCommitActive(uid);
    const doc = loadCognitionStoreSync(uid);
    if (corruptRecordFor(filePath)) throw new Error('cognition store corrupt; purge refused');
    const next = structuredClone(doc);
    let pendingRemoved = 0;
    next.pendingJournal = (next.pendingJournal || []).filter(entry => {
      if (entry.objectId === objectId) {
        pendingRemoved += 1;
        return false;
      }
      if (!entry.objectId) scrubAuditLine(entry.line, objectId);
      return true;
    });
    const object = next.objects?.[objectId] as { statement?: string; title?: string } | undefined;
    if (object && typeof object.statement === 'string') object.statement = '';
    if (object && typeof object.title === 'string') object.title = '';
    // The compatibility mirror is read by older callers; never leave the body
    // there after the canonical tombstone has been written.
    const compatibility = next.compatibility?.records?.['ability-assets']?.[objectId] as
      { statement?: string; title?: string } | undefined;
    if (compatibility && typeof compatibility === 'object') {
      if (typeof compatibility.statement === 'string') compatibility.statement = '';
      if (typeof compatibility.title === 'string') compatibility.title = '';
    }
    beginCognitionCommit(uid);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeStoreFileSync(filePath, next);
    const pendingHistory = drainJournal(uid, next);
    try { writeStoreFileSync(filePath, next); } catch (error) {
      log.warn('cognition purge journal cleanup pending', { uid, objectId, error: String(error) });
    }
    // Audit lines carry the objectId inside ops, not at the journal-entry top
    // level; scrub after draining so replayed and historical lines are covered.
    scrubCognitionAuditFile(uid, objectId);
    // Delete the per-object stream only after the journal is drained: a retry
    // must not find a replayable entry that recreates it.
    fs.rmSync(versionStreamPath(uid, objectId), { force: true });
    return { removedVersions: true, pendingRemoved };
  });
}

export interface ArchiveOntologyHistoryOptions { keepHistory: number; keepReceipts: number }
export interface ArchiveOntologyHistoryOutcome {
  ok: boolean;
  error?: string;
  archivedHistory: number;
  archivedReceipts: number;
  archivePath?: string;
  pendingHistory?: boolean;
}

/**
 * Move old ontology history and its unreferenced command receipts into a
 * sideline JSONL file, then trim the live document. Nothing is deleted: the
 * archive is written and fsynced before the main store is replaced. Receipts
 * referenced by retained history always stay, regardless of keepReceipts.
 */
export async function archiveCognitionOntologyHistory(
  uid: string,
  options: ArchiveOntologyHistoryOptions,
): Promise<ArchiveOntologyHistoryOutcome> {
  const empty = { archivedHistory: 0, archivedReceipts: 0 };
  if (!safeId(uid)) return { ok: false, error: 'invalid uid', ...empty };
  const { keepHistory, keepReceipts } = options;
  if (!Number.isSafeInteger(keepHistory) || keepHistory < 0 || keepHistory > 100000
    || !Number.isSafeInteger(keepReceipts) || keepReceipts < 0 || keepReceipts > 20000)
    return { ok: false, error: 'invalid archive bounds (history 0..100000, receipts 0..20000)', ...empty };
  const filePath = cognitionStorePath(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    assertCognitionCommitActive(uid);
    const doc = loadCognitionStoreSync(uid);
    if (corruptRecordFor(filePath)) return { ok: false, error: 'cognition store corrupt; write refused', ...empty };
    const ontology = doc.ontology;
    if (!ontology) return { ok: true, ...empty };
    const allHistory = ontology.history;
    // Keep every current record's latest history, every retained receipt's
    // complete command unit, and the newest keepHistory entries. Slicing by
    // count alone can drop another record's latest version or a receipt's
    // changed-id coverage, which the validator (correctly) rejects.
    const latestIndex = new Map<string, number>();
    for (let index = 0; index < allHistory.length; index++) latestIndex.set(allHistory[index].after.id, index);
    const keepIndexes = new Set<number>();
    for (const record of Object.values(ontology.records)) {
      if (record.source.kind === 'legacy') continue;
      const index = latestIndex.get(record.id);
      if (index !== undefined) keepIndexes.add(index);
    }
    for (let index = Math.max(0, allHistory.length - keepHistory); index < allHistory.length; index++) keepIndexes.add(index);
    const newestReceipts = Object.entries(ontology.receipts)
      .sort((left, right) => right[1].revision - left[1].revision)
      .slice(0, keepReceipts).map(([commandId]) => commandId);
    const retainedReceipts = new Set(newestReceipts);
    const addCommandUnit = (commandId: string): boolean => {
      let added = false;
      for (let index = 0; index < allHistory.length; index++) {
        if (allHistory[index].commandId === commandId && !keepIndexes.has(index)) {
          keepIndexes.add(index);
          added = true;
        }
      }
      return added;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const index of keepIndexes) {
        const commandId = allHistory[index].commandId;
        if (!retainedReceipts.has(commandId)) { retainedReceipts.add(commandId); changed = true; }
      }
      for (const commandId of [...retainedReceipts]) if (addCommandUnit(commandId)) changed = true;
    }
    const keptHistory = allHistory.filter((_, index) => keepIndexes.has(index));
    const removedHistory = allHistory.filter((_, index) => !keepIndexes.has(index));
    const removedReceipts = Object.entries(ontology.receipts).filter(([commandId]) => !retainedReceipts.has(commandId));
    if (!removedHistory.length && !removedReceipts.length) return { ok: true, ...empty };

    // Validate the trimmed document before writing the sideline archive: a
    // rejected trim must not leave an archive that claims history was moved.
    const next = structuredClone(ontology);
    next.history = keptHistory.map(entry => structuredClone(entry));
    next.receipts = Object.fromEntries([...retainedReceipts]
      .filter(commandId => ontology.receipts[commandId])
      .sort((left, right) => ontology.receipts[left].revision - ontology.receipts[right].revision)
      .map(commandId => [commandId, structuredClone(ontology.receipts[commandId])]));
    next.revision += 1;
    validateOntologyDocument(next);

    const archivePath = `${filePath}.archive-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`;
    const lines = [
      ...removedHistory.map(entry => JSON.stringify({ kind: 'history', entry })),
      ...removedReceipts.map(([commandId, receipt]) => JSON.stringify({ kind: 'receipt', commandId, receipt })),
    ];
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const archive = fs.openSync(archivePath, 'wx');
    try {
      fs.writeFileSync(archive, lines.join('\n') + '\n', 'utf8');
      fs.fsyncSync(archive);
    } finally { fs.closeSync(archive); }

    const draft: CognitionStoreDocument = structuredClone(doc);
    draft.ontology = next;
    draft.pendingJournal ??= [];
    draft.pendingJournal.push({ key: `ontology-archive-${next.revision}-${Date.now()}`, line: {
      at: nowIso(), kind: 'ontology_archive', revision: next.revision,
      archivedHistory: removedHistory.length, archivedReceipts: removedReceipts.length,
      keepHistory, keepReceipts, archivePath,
    } });
    draft.updatedAt = nowIso();
    beginCognitionCommit(uid);
    writeStoreFileSync(filePath, draft);
    const pendingHistory = drainJournal(uid, draft);
    try { writeStoreFileSync(filePath, draft); } catch (error) { log.warn('cognition archive journal cleanup pending', { uid, error: String(error) }); }
    return { ok: true, archivedHistory: removedHistory.length, archivedReceipts: removedReceipts.length, archivePath, pendingHistory };
  });
}

// ── 家注册表写口 ─────────────────────────────────────────────────────────

export interface ReplaceHomesOutcome {
  ok: boolean;
  error?: string;
  homes?: HomeRegistryEntry[];
}

/**
 * 家注册表写口：锁内 校验（id 唯一/合法、内置六家
 * 不可删、存储映射合法）→ 替换 homes → 原子写 + 台账。内置家的判据文案允许
 * 被覆盖（用户可改措辞），id 与存储映射以出厂为准不可漂移。
 */
export async function replaceCognitionHomes(uid: string, homes: readonly HomeRegistryEntry[]): Promise<ReplaceHomesOutcome> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const validated = validateHomeRegistry(homes);
  if (validated.ok === false) return { ok: false, error: validated.reason };
  const builtinById = new Map(DEFAULT_HOME_REGISTRY.map(entry => [entry.home, entry]));
  const merged = homes.map(entry => {
    const builtin = builtinById.get(entry.home);
    return builtin ? { ...entry, pool: builtin.pool, store: builtin.store, builtin: true as const } : entry;
  });
  const outcome = await applyCognitionDeltas(uid, { kind: 'document', edit: doc => { doc.homes = merged; } });
  return outcome.ok ? { ok: true, homes: merged } : { ok: false, error: outcome.error };
}

// ── 读辅助（版本流/台账）────────────────────────────────────────────────

export interface CognitionVersionLine extends VersionLine {}

export function listCognitionVersions(uid: string, objectId: string): CognitionVersionLine[] {
  if (!safeId(uid) || !safeId(objectId)) return [];
  const lines: VersionLine[] = [];
  try {
    for (const text of fs.readFileSync(versionStreamPath(uid, objectId), 'utf8').split('\n')) {
      try { if (text.trim()) lines.push(JSON.parse(text)); } catch { /* Bad lines cannot conceal other versions. */ }
    }
  } catch { /* A pending journal may be the only readable history. */ }
  for (const entry of loadCognitionStoreSync(uid).pendingJournal ?? []) {
    if (entry.objectId === objectId && !lines.some(line => line.deltaId === entry.line.deltaId)) lines.push(entry.line as unknown as VersionLine);
  }
  return lines.sort((a, b) => a.version - b.version);
}

/** 兼容桥的原子入口：调用者提供已验证的来源快照，仍复用库锁、坏档拒写和原子落盘。
 * 变更不会伪造新内容版本；版本/审计 JSONL 由既有资产业务服务维护。 */
export async function editCognitionDocument(
  uid: string, edit: (doc: CognitionStoreDocument) => void | false,
): Promise<void> {
  if (!safeId(uid)) throw new Error('invalid uid');
  const outcome = await applyCognitionDeltas(uid, { kind: 'document', edit });
  if (!outcome.ok) throw new Error(outcome.error || 'cognition document commit failed');
}

/** 保留兼容桥的既有调用契约。 */
export async function editCognitionCompatibility(
  uid: string, edit: (doc: CognitionStoreDocument) => void,
): Promise<void> {
  return editCognitionDocument(uid, edit);
}
