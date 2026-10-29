/**
 * cognition_kernel/pool — 统一候选池。
 *
 * 池条目就是一个 status:'proposed' 的 Delta，来源与原始候选引用随条目保留。
 * 确认后经统一库写入口提交，候选状态与正式对象状态分别管理。
 *
 * 生命周期（池级，最小完备）：pending → confirmed / rejected / deferred
 *（deferred=「稍后再说」，到点回到 pending 由消费面拉起；对象级的
 * paused/merged 等状态属统一库对象，不属池）。
 *
 * 幂等与去重分两层：
 *  · 槽位键（idempotencyKey）：同一槽位的重复提议，池内只留最新一条（旧
 *    pending 项被顶替进 rejected，注明 superseded）——这是槽位键的正确用途；
 *  · deltaId：confirm 后的精确重放由统一库 appliedDeltas 索引拦截。
 *
 * 存储独立于主档（cognition-pool.json，同目录同锁纪律同坏档三件套）：
 * 池是高频流转的工作区，不搅动事实源主档。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileEditLock } from '../../util/locks';
import { corruptRecordFor, readTextGuarded, reportCorruptFile } from '../../util/corrupt-guard';
import { userCognitionDir } from '../../paths';
import { genId12, nowIso, safeId, writeJsonSync } from '../../storage';
import { createLogger } from '../../logger';
import type { CognitionDelta } from './types';
import { validateDelta } from './delta';
import { applyCognitionDeltas, loadCognitionStoreSync } from './store';

const log = createLogger('cognition-pool');

export const POOL_SCHEMA_VERSION = 1 as const;
export const POOL_CORRUPT_DOMAIN = 'cognition-pool';
export const POOL_MAX_ITEMS = 500;

export type PoolItemStatus = 'pending' | 'confirmed' | 'rejected' | 'deferred';
export type PoolSourceKind = 'judge' | 'capture' | 'backflow' | 'import' | 'user';

export interface PoolItem {
  /** 池条目 id（与 delta.deltaId 分离：同槽顶替会产生新条目）。 */
  id: string;
  delta: CognitionDelta;
  status: PoolItemStatus;
  sourceKind: PoolSourceKind;
  createdAt: string;
  updatedAt: string;
  /** deferred 到期时刻（消费面扫描回 pending）。 */
  resumeAt?: string;
  note?: string;
  decidedAt?: string;
  /** 顶替关系：本条被哪个新条目顶掉（仅 superseded 的 rejected 项有）。 */
  supersededBy?: string;
  /** 迁移映射：来自旧 po/recall 候选时的原 id。 */
  originalRef?: { kind: 'po_candidate' | 'recall_candidate'; id: string };
  /** 判定层给出的次候选（主候选在 delta.target.home；确认界面可「换主家」）。 */
  alternatives?: Array<{ home: string; confidence: number }>;
}

/** 未分类出口：判不出来（空候选/降级）的内容先进这里，用户选家或丢弃——不给黑洞。 */
export interface UnroutedItem {
  id: string;
  statement: string;
  sourceKind: PoolSourceKind;
  createdAt: string;
}

export interface PoolDocument {
  schemaVersion: 1;
  items: PoolItem[];
  /** 未分类暂存（≤100，FIFO）：有出口、不进任何家。 */
  unrouted: UnroutedItem[];
  updatedAt: string;
}

export function poolPath(uid: string): string {
  return path.join(userCognitionDir(uid), 'cognition-pool.json');
}

export const UNROUTED_MAX = 100;

export function emptyPool(): PoolDocument {
  return { schemaVersion: POOL_SCHEMA_VERSION, items: [], unrouted: [], updatedAt: nowIso() };
}

function normalizeItem(raw: unknown): PoolItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const status = typeof r.status === 'string' ? r.status : '';
  if (!id || (status !== 'pending' && status !== 'confirmed' && status !== 'rejected' && status !== 'deferred')) {
    return null;
  }
  const sourceKind = typeof r.sourceKind === 'string' ? r.sourceKind : 'user';
  const now = nowIso();
  return {
    id,
    delta: r.delta as CognitionDelta,
    status,
    sourceKind: (['judge', 'capture', 'backflow', 'import', 'user'].includes(sourceKind) ? sourceKind : 'user') as PoolSourceKind,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
    ...(typeof r.resumeAt === 'string' && r.resumeAt ? { resumeAt: r.resumeAt } : {}),
    ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
    ...(typeof r.decidedAt === 'string' && r.decidedAt ? { decidedAt: r.decidedAt } : {}),
    ...(typeof r.supersededBy === 'string' && r.supersededBy ? { supersededBy: r.supersededBy } : {}),
    ...(r.originalRef && typeof r.originalRef === 'object'
      ? { originalRef: r.originalRef as PoolItem['originalRef'] }
      : {}),
    ...(Array.isArray(r.alternatives)
      ? { alternatives: (r.alternatives as PoolItem['alternatives']).slice(0, 3) }
      : {}),
  };
}

/** 整档归一。返回 null＝整档坏（非对象 / schemaVersion 不符 / 缺 items 或
 *  unrouted 数组）：调用方按 corrupt-guard 登记并阻止空池覆盖坏档，
 *  避免丢失待确认提议。条目级坏行逐条降级。 */
function normalizePool(raw: unknown): PoolDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== POOL_SCHEMA_VERSION) return null;
  if (!Array.isArray(r.items) || !Array.isArray(r.unrouted)) return null;
  const doc = emptyPool();
  for (const item of r.items) {
    const normalized = normalizeItem(item);
    if (normalized) doc.items.push(normalized);
  }
  for (const item of r.unrouted) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const u = item as Record<string, unknown>;
    const id = typeof u.id === 'string' ? u.id.trim() : '';
    const statement = typeof u.statement === 'string' ? u.statement.trim() : '';
    if (!id || !statement) continue;
    doc.unrouted.push({
      id,
      statement,
      sourceKind: (typeof u.sourceKind === 'string' ? u.sourceKind : 'user') as PoolSourceKind,
      createdAt: typeof u.createdAt === 'string' ? u.createdAt : nowIso(),
    });
  }
  doc.unrouted = doc.unrouted.slice(-UNROUTED_MAX);
  doc.updatedAt = typeof r.updatedAt === 'string' ? r.updatedAt : doc.updatedAt;
  return doc;
}

/** 读池（坏档三件套读侧：copy 备份+拒写 latch，返回空池供展示）。 */
export function loadPoolSync(uid: string): PoolDocument {
  if (!safeId(uid)) return emptyPool();
  const filePath = poolPath(uid);
  if (!fs.existsSync(filePath)) return emptyPool();
  const guarded = readTextGuarded(filePath, { domain: POOL_CORRUPT_DOMAIN });
  if (guarded.status !== 'ok') return emptyPool();
  let parsed: unknown;
  try {
    parsed = JSON.parse(guarded.text);
  } catch (err) {
    reportCorruptFile(filePath, `bad JSON: ${(err as Error).message}`, { domain: POOL_CORRUPT_DOMAIN });
    log.warn('cognition pool unreadable; corrupt-guard engaged', { uid, error: (err as Error).message });
    return emptyPool();
  }
  const doc = normalizePool(parsed);
  if (!doc) {
    // 形状/版本不符同样是坏档——登记 + 拒写 latch（写侧 corruptRecordFor
    // 拒绝整写），读侧降级空池仅供展示；绝不当作空池整写覆盖。
    reportCorruptFile(filePath, 'pool document shape or schemaVersion mismatch', { domain: POOL_CORRUPT_DOMAIN });
    log.warn('cognition pool malformed; corrupt-guard engaged', { uid });
    return emptyPool();
  }
  return doc;
}

/** 统一 storage 原子写原语（同目录 tmp + rename 带重试，与主档同纪律）；
 *  调用方必须已持有 poolPath 的 fileEditLock。 */
function writePoolSync(filePath: string, doc: PoolDocument): void {
  writeJsonSync(filePath, doc);
}

// ── 提交（生产者入口）──────────────────────────────────────────────────

export interface SubmitOutcome {
  ok: boolean;
  error?: string;
  /** 本槽位当前的活条目 id（新建或顶替后的新条目）。 */
  itemId?: string;
  /** 被顶替进 rejected 的旧条目 id。 */
  supersededId?: string;
}

/**
 * 提议入池。同槽位（delta.idempotencyKey）已有 pending/deferred 条目时，
 * 旧条目顶替进 rejected（superseded，非用户决定、不进用户视野的历史噪声），
 * 池内每槽只留最新。
 */
export async function submitToPool(
  uid: string,
  delta: CognitionDelta,
  options?: {
    sourceKind?: PoolSourceKind;
    originalRef?: PoolItem['originalRef'];
    /** 判定层给出的次候选。 */
    alternatives?: Array<{ home: string; confidence: number }>;
  },
): Promise<SubmitOutcome> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const knownHomes = new Set(loadCognitionStoreSync(uid).homes.map((entry) => entry.home));
  const checked = validateDelta(delta, knownHomes);
  if (checked.ok === false) return { ok: false, error: `invalid delta: ${checked.reason}` };
  if (delta.status !== 'proposed') return { ok: false, error: 'pool 只收 proposed（applied 走统一库）' };
  const filePath = poolPath(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    const doc = loadPoolSync(uid);
    const corrupt = corruptRecordFor(filePath);
    if (corrupt) return { ok: false, error: `cognition pool corrupt; write refused (${corrupt.reason})` };

    const now = nowIso();
    const itemId = `pi-${genId12()}`; // 使用随机段，避免按条目数量编号在裁剪后重号。
    let supersededId: string | undefined;
    // 顶替只发生在「范围化槽位」（带 fieldName/objectId 的 set/update——新值
    // 换旧值是本意）；裸 add（无字段无对象）同家不同内容是不同提议，共存。
    const scopedSlot = Boolean(delta.target.fieldName || delta.target.objectId);
    const surviving: PoolItem[] = [];
    for (const item of doc.items) {
      const sameSlot =
        item.delta.idempotencyKey === delta.idempotencyKey &&
        scopedSlot &&
        (item.status === 'pending' || item.status === 'deferred');
      if (sameSlot) {
        supersededId = item.id;
        surviving.push({
          ...item,
          status: 'rejected',
          updatedAt: now,
          decidedAt: now,
          note: item.note ?? '同槽位被更新的提议顶替',
          supersededBy: itemId,
        });
      } else {
        surviving.push(item);
      }
    }
    const entry: PoolItem = {
      id: itemId,
      delta: { ...delta },
      status: 'pending',
      sourceKind: options?.sourceKind ?? 'user',
      createdAt: now,
      updatedAt: now,
      ...(options?.originalRef ? { originalRef: options.originalRef } : {}),
      ...(options?.alternatives?.length ? { alternatives: options.alternatives.slice(0, 3) } : {}),
    };
    surviving.push(entry);
    // 容量约束：确认/拒绝的旧条目先淘汰（最旧优先），活条目永不被挤出。
    while (surviving.length > POOL_MAX_ITEMS) {
      const idx = surviving.findIndex((item) => item.status === 'confirmed' || item.status === 'rejected');
      if (idx === -1) break;
      surviving.splice(idx, 1);
    }
    doc.items = surviving;
    doc.updatedAt = now;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writePoolSync(filePath, doc);
    return { ok: true, itemId, ...(supersededId ? { supersededId } : {}) };
  });
}

// ── 列表 ─────────────────────────────────────────────────────────────────

export interface PoolView {
  items: PoolItem[];
}

export function listPool(uid: string, filter?: { status?: PoolItemStatus; sourceKind?: PoolSourceKind }): PoolView {
  const doc = loadPoolSync(uid);
  const items = doc.items.filter(
    (item) =>
      (!filter?.status || item.status === filter.status) &&
      (!filter?.sourceKind || item.sourceKind === filter.sourceKind),
  );
  // pending 最优先，同状态内新→旧。
  const rank: Record<PoolItemStatus, number> = { pending: 0, deferred: 1, confirmed: 2, rejected: 3 };
  items.sort((a, b) => rank[a.status] - rank[b.status] || (a.createdAt < b.createdAt ? 1 : -1));
  return { items };
}

// ── 决定（confirm / reject / defer）────────────────────────────────────

export interface DecideOutcome {
  ok: boolean;
  error?: string;
  /** confirm 成功后的统一库落地结果。 */
  appliedCount?: number;
}

/**
 * 用户决定。confirm = delta 转 applied 经统一库唯一写入口落地 + 池条目
 * confirmed（双失败安全：库落地失败则池不动；池写失败库已落地，重试 confirm
 * 会命中统一库 appliedDeltas 幂等索引安全返回）。
 */
export async function decidePoolItem(
  uid: string,
  itemId: string,
  decision: 'confirm' | 'reject' | 'defer',
  options?: { note?: string; resumeAt?: string },
): Promise<DecideOutcome> {
  if (!safeId(uid) || !safeId(itemId)) return { ok: false, error: 'invalid uid or itemId' };
  const filePath = poolPath(uid);
  if (decision === 'confirm') {
    // 先在锁外读条目（读侧安全），confirm 的原子性由统一库幂等索引兜底。
    const current = loadPoolSync(uid).items.find((item) => item.id === itemId);
    if (!current) return { ok: false, error: 'pool item not found' };
    if (current.status !== 'pending' && current.status !== 'deferred') {
      return { ok: false, error: `pool item 已 ${current.status}` };
    }
    const applied: CognitionDelta = { ...current.delta, status: 'applied', evidenceRefs: current.delta.evidenceRefs.length ? current.delta.evidenceRefs : [{ kind: 'candidate', id: current.id, title: current.delta.after?.slice(0, 200) }] };
    const result = await applyCognitionDeltas(uid, [applied]);
    if (!result.ok) return { ok: false, error: `统一库落地失败：${result.error ?? 'unknown'}` };
  }
  return fileEditLock(filePath).runExclusive(async () => {
    const doc = loadPoolSync(uid);
    const corrupt = corruptRecordFor(filePath);
    if (corrupt) return { ok: false, error: `cognition pool corrupt; write refused (${corrupt.reason})` };
    const item = doc.items.find((entry) => entry.id === itemId);
    if (!item) return { ok: false, error: 'pool item not found' };
    // 锁内终态复查（confirm/reject 与 defer 分支同款）：confirm 的统一库落地
    // 在锁外（上方 await applyCognitionDeltas），窗口内同槽 submitToPool 可能把
    // 该条顶替成 rejected(superseded)、或并发决定已改变状态——不复查会把已
    // 拒/已被顶替的条目改写成 confirmed，违背池『同槽只留最新』『已决定不可
    // 再决定』的语义。
    if (item.status !== 'pending' && item.status !== 'deferred') {
      return { ok: false, error: `pool item 已 ${item.status}` };
    }
    const now = nowIso();
    if (decision === 'confirm') {
      item.status = 'confirmed';
    } else if (decision === 'reject') {
      item.status = 'rejected';
    } else {
      // defer 原有的终态检查已被上方锁内复查覆盖（同谓词，TS 已证不可达）。
      item.status = 'deferred';
      if (options?.resumeAt) item.resumeAt = options.resumeAt;
    }
    item.updatedAt = now;
    item.decidedAt = now;
    if (options?.note) item.note = options.note;
    doc.updatedAt = now;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writePoolSync(filePath, doc);
    return { ok: true };
  });
}

/** deferred 到期扫描（消费面轮询用）：到点条目回 pending。
 * 与 submit/decide 同款写纪律：fileEditLock 串行 + corrupt latch 拒写——
 * 此前无锁整写，与并发 submit/decide 互覆会丢对方的条目状态。 */
export async function resumeDuePoolItems(uid: string, now: string = nowIso()): Promise<number> {
  if (!safeId(uid)) return 0;
  const filePath = poolPath(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    const doc = loadPoolSync(uid);
    if (corruptRecordFor(filePath)) return 0;
    let resumed = 0;
    for (const item of doc.items) {
      if (item.status === 'deferred' && item.resumeAt && item.resumeAt <= now) {
        item.status = 'pending';
        item.updatedAt = now;
        resumed += 1;
      }
    }
    if (resumed > 0) {
      doc.updatedAt = now;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writePoolSync(filePath, doc);
      } catch (err) {
        log.warn('pool resume persist failed', { uid, error: (err as Error).message });
        return 0;
      }
    }
    return resumed;
  });
}
// ── 未分类出口（判定为空的内容：有出口、不给黑洞）──────────────────────

export interface UnroutedOutcome {
  ok: boolean;
  error?: string;
  unroutedId?: string;
}

/** 未分类暂存（judge 空候选/降级时由 pipeline 调用；≤100 FIFO）。 */
export async function addUnrouted(uid: string, statement: string, sourceKind: PoolSourceKind = 'judge'): Promise<UnroutedOutcome> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const text = String(statement ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!text) return { ok: false, error: 'empty statement' };
  const filePath = poolPath(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    const doc = loadPoolSync(uid);
    const corrupt = corruptRecordFor(filePath);
    if (corrupt) return { ok: false, error: `cognition pool corrupt; write refused (${corrupt.reason})` };
    const now = nowIso();
    const unroutedId = `ur-${genId12()}`;
    doc.unrouted.push({ id: unroutedId, statement: text, sourceKind, createdAt: now });
    doc.unrouted = doc.unrouted.slice(-UNROUTED_MAX);
    doc.updatedAt = now;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writePoolSync(filePath, doc);
    return { ok: true, unroutedId };
  });
}

export function listUnrouted(uid: string): UnroutedItem[] {
  return loadPoolSync(uid).unrouted.slice().reverse();
}

/** 用户为未分类内容选家 → 变成该家的 proposed 提议进池（仍需确认）；discard 直接清掉。 */
export async function decideUnrouted(
  uid: string,
  unroutedId: string,
  decision: { routeHome: string } | { discard: true },
): Promise<UnroutedOutcome & { poolItemId?: string }> {
  if (!safeId(uid) || !safeId(unroutedId)) return { ok: false, error: 'invalid uid or unroutedId' };
  const doc = loadPoolSync(uid);
  const item = doc.unrouted.find((entry) => entry.id === unroutedId);
  if (!item) return { ok: false, error: 'unrouted item not found' };
  if ('discard' in decision && decision.discard) {
    const filePath = poolPath(uid);
    return fileEditLock(filePath).runExclusive(async () => {
      const latest = loadPoolSync(uid);
      latest.unrouted = latest.unrouted.filter((entry) => entry.id !== unroutedId);
      latest.updatedAt = nowIso();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writePoolSync(filePath, latest);
      return { ok: true };
    });
  }
  const home = ('routeHome' in decision && decision.routeHome) || '';
  const knownHomes = new Set(loadCognitionStoreSync(uid).homes.map((entry) => entry.home));
  if (!knownHomes.has(home)) return { ok: false, error: `unknown home: ${home || '(空)'}` };
  const { buildDelta } = await import('./delta');
  const delta = buildDelta({
    op: 'add',
    target: { home: home as never },
    origin: 'user',
    after: item.statement,
    status: 'proposed',
  });
  const submit = await submitToPool(uid, delta, { sourceKind: item.sourceKind });
  if (!submit.ok) return submit;
  const filePath = poolPath(uid);
  await fileEditLock(filePath).runExclusive(async () => {
    const latest = loadPoolSync(uid);
    latest.unrouted = latest.unrouted.filter((entry) => entry.id !== unroutedId);
    latest.updatedAt = nowIso();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writePoolSync(filePath, latest);
  });
  return { ok: true, poolItemId: submit.itemId };
}
