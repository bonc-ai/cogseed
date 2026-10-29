/**
 * po/store — 个人本体 v2 存储内核。
 *
 * 单一事实源：`<uid>/cloud/cognition/personal-ontology.json`（po/model.ts 定义的
 * PoDocument）。所有业务读写都走这里；`.personal_ontology_groups/` 下的 md
 * 文件只是写时渲染的视图副本（po/view.ts），专供 kb 检索索引、transcript 术语
 * 桥与人类调试，不承担任何事实职责。
 *
 * 关键机制：
 * - 文档级 fileEditLock 串行化一切写入（v1 是每组一把文件锁 + 台账无锁，竞态面更大）；
 * - editPoDoc 统一「改前快照 → 落盘 → 渲染同步 → 索引钩子 → 通知」的写路径，
 *   业务层只描述变更；
 * - 历史快照 / 摘要台账迁到 `<uid>/cloud/cognition/po-history/<groupId>/`，
 *   行格式与 v1 兼容（audit.jsonl 原样沿用，旧快照由迁移转成 JSON 快照）；
 * - 删除的分组进文档内 trash（回收站），整状态可恢复；
 * - loadPoDocSync 兜底一次性 v1 导入（po/migrate.ts），读路径永不阻塞在异步上。
 */

import * as fs from 'node:fs';
import { readUnifiedPoDocument, persistPoSource, withCognitionTransition } from '../cognition_bridge';
import * as path from 'node:path';
import { fileEditLock } from '../../util/locks';
import { corruptRecordFor, readTextGuarded, reportCorruptFile } from '../../util/corrupt-guard';
import { userCognitionDir, userContextsDir, userOntologyGroupsDir } from '../../paths';
import { genId12, nowIso, safeId, writeJson, writeJsonSync } from '../../storage';
import { writeTextAtomicSync } from '../../storage';
import { notifyCognitionWrite } from '../recall/store-events';
import * as search from '../search';
import * as kbIndexer from '../kb_indexer';
import { createLogger } from '../../logger';
import { emptyPoDocument, normalizePoDocument, type PoDocument, type PoGroup } from './model';
import { poGroupRelPath, renderGroupMarkdown, renderGroupMarkdownCopy } from './view';
// 与 migrate 的循环依赖是函数体级的（migrate 只在函数里用 poHistoryDir，
// store 只在函数里用 importFromV1Sync）——静态 import 在 ESM 下安全，
// 且必须静态：require 会绕过 vitest 的模块注册表，把冻结了旧 WS_ROOT 的
// 实例带进后续测试（paths.ts 的 WS_ROOT 在模块加载时定格）。
import { importFromV1Sync } from './migrate';

const log = createLogger('po-store');

/** 个人本体 JSON 文档路径（与 assets.json / ontology-graph.json 同目录，参与云同步）。 */
export function poDocPath(uid: string): string {
  return path.join(userCognitionDir(uid), 'personal-ontology.json');
}

/** 坏档三件套的业务域名（恢复通道 cognition.corrupt.* 按 domain 寻址）。 */
export const PO_CORRUPT_DOMAIN = 'po';

/**
 * 单份 po 文档写入总量上限：与 cognition 单店字节口径同值
 * （features/cognition/index.ts COGNITION_STORE_BYTE_LIMIT = 8MB；本地常量
 * 不跨模块取值，避免把整个 cognition 模块拉进依赖闭包）。超过上限的**增量**
 * 写被拒绝并给可操作错误；存量超限文档不追溯（见 editPoDoc 容量门）。
 */
export const PO_DOC_BYTE_LIMIT = 8 * 1024 * 1024;

/** 组历史目录（快照 + 摘要台账）。 */
export function poHistoryDir(uid: string, groupId: string): string {
  return path.join(userCognitionDir(uid), 'po-history', groupId);
}

const HISTORY_MAX_PER_GROUP = 50;
const AUDIT_FILE_NAME = 'audit.jsonl';
const AUDIT_SUMMARY_MAX_CHARS = 200;

function readTextSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

// ── 读取 ─────────────────────────────────────────────────────────────────

/**
 * 同步加载文档：JSON 存在 → 读 + 修复；不存在 → 尝试一次性 v1 导入（同步，
 * 全程 fs 同步 API）；v1 也没有 → 空文档。**本函数永不写盘**——迁移的持久化
 * 由写路径（editPoDoc → persistWhenMigrated）或启动钩子完成，读路径零副作用。
 *
 * 坏档保护：读到坏档（非 ENOENT 读错 /
 * JSON 解析失败）→ 先 copy `.corrupt-<ts>` 备份并登记拒写 latch，再返回空
 * 文档供展示（写侧 editPoDoc 会拒绝；恢复入口走 cognition.corrupt.*）。
 * 旧病：坏档仅 warn + 空文档，下一次成功写入把旧文档整体替换，无备份。
 */
/** 坏组登记：normalize 丢弃 title 为空的坏组时按 corrupt-guard 口径
 *  上报——copy 备份 + 拒写 latch；读侧仍降级（好组照常展示），下一次写被
 *  写侧门拒绝，坏组不再随写入从盘上静默永久删除。 */
function droppedGroupCorruptGuard(uid: string, rawGroup: unknown): void {
  const filePath = poDocPath(uid);
  reportCorruptFile(filePath, `group row invalid (empty title, fields=${Array.isArray((rawGroup as { fields?: unknown })?.fields) ? (rawGroup as { fields: unknown[] }).fields.length : -1})`, { domain: PO_CORRUPT_DOMAIN });
  log.warn('po group row dropped on load; corrupt-guard engaged', { uid });
}

export function loadPoDocSync(uid: string): PoDocument {
  if (!safeId(uid)) return emptyPoDocument();
  const unified = readUnifiedPoDocument(uid);
  if (unified) return normalizePoDocument(unified, { onDroppedGroup: (g) => droppedGroupCorruptGuard(uid, g) });
  const filePath = poDocPath(uid);
  if (fs.existsSync(filePath)) {
    const guarded = readTextGuarded(filePath, { domain: PO_CORRUPT_DOMAIN });
    if (guarded.status === 'corrupt') return emptyPoDocument();
    if (guarded.status === 'ok') {
      try {
        return normalizePoDocument(JSON.parse(guarded.text), { onDroppedGroup: (g) => droppedGroupCorruptGuard(uid, g) });
      } catch (err) {
        reportCorruptFile(filePath, `bad JSON: ${(err as Error).message}`, { domain: PO_CORRUPT_DOMAIN });
        log.warn('po doc unreadable; corrupt-guard engaged', { uid, error: (err as Error).message });
        return emptyPoDocument();
      }
    }
    // existsSync 与读取之间文件消失（迁移/外部操作竞态）：按空文档处理。
    return emptyPoDocument();
  }
  try {
    const imported = importFromV1Sync(uid);
    if (imported) return imported;
  } catch (err) {
    log.warn('po v1 import failed; starting from empty', { uid, error: (err as Error).message });
  }
  return emptyPoDocument();
}

/** 异步加载（迁移完成时会持久化 + 渲染副本 + 备份 v1 目录；写路径与启动钩子用）。 */
export async function ensurePoDoc(uid: string): Promise<PoDocument> {
  if (!safeId(uid)) return emptyPoDocument();
  const unified = readUnifiedPoDocument(uid);
  if (unified) return normalizePoDocument(unified);
  const filePath = poDocPath(uid);
  if (fs.existsSync(filePath)) return loadPoDocSync(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    if (fs.existsSync(filePath)) return loadPoDocSync(uid); // 双检：锁内可能已被迁移
    const doc = importFromV1Sync(uid);
    if (doc) {
      // v1 目录存在（返回非 null）→ 无论导入结果空否都落盘结清：空 JSON 即
      // marker，此后读路径（loadPoDocSync）不再全量重扫 v1（读 groups.md、
      // 扫 .history、孤儿复活）；null = 新用户，维持懒创建不落盘。
      // 顺序约束：必须先落盘再退役 v1 台账（backupV1Dir 内删 groups.md）——
      // 落盘失败时 v1 原文仍在，迁移可无损重试；否则空文档会被当作迁移结果固化。
      doc.migratedFromV1At = doc.migratedFromV1At || nowIso();
      await writeJson(filePath, doc);
      const { backupV1Dir, persistV1History } = await import('./migrate') as typeof import('./migrate');
      backupV1Dir(uid);
      // 旧 .history → po-history 的转换只在结清步落盘（读路径零副作用）。
      persistV1History(uid);
      renderAllGroups(uid, doc);
      log.info('po v1 import persisted', { uid, groups: doc.groups.length, trash: doc.trash.length });
    }
    return doc ?? emptyPoDocument();
  });
}

// ── 渲染副本 + 索引钩子 ──────────────────────────────────────────────────

function groupAbsPath(uid: string, relPath: string): string {
  return path.join(userOntologyGroupsDir(uid), relPath.replace('.personal_ontology_groups/', ''));
}

/**
 * 渲染副本相对路径的安全段校验（路径穿越守卫）：必须形如
 * `.personal_ontology_groups/<safeId>.md`。字符集权威复用 storage.safeId
 * （与快照 / 台账 / 历史读入口同一把尺，不自造规则）；段外字符——含 `../`
 * 穿越、路径分隔符、绝对路径——一律不进渲染写。
 */
function safeRenderRelPath(relPath: string): string | null {
  const prefix = '.personal_ontology_groups/';
  if (!relPath.startsWith(prefix) || !relPath.endsWith('.md')) return null;
  const idSegment = relPath.slice(prefix.length, relPath.length - '.md'.length);
  return safeId(idSegment) ? relPath : null;
}

/**
 * 非法组 id / relPath 的统一处置：该组的渲染副本丢弃（不写盘、不进索引），
 * 并按 corrupt-guard 同一口径登记坏档（domain 'po'：copy 备份 + 拒写 latch，
 * 恢复通道 cognition.corrupt.*）。理由串与日志只含长度等元信息，不落 id 原文
 * （它可能携带任意用户字节）。
 */
function rejectUnsafeRenderRelPath(uid: string, relPath: string): void {
  reportCorruptFile(
    poDocPath(uid),
    `unsafe group render relPath rejected (id charset, relPathLen=${relPath.length})`,
    { domain: PO_CORRUPT_DOMAIN },
  );
  log.warn('po render refused: unsafe group id/relPath; copy dropped', {
    uid,
    domain: PO_CORRUPT_DOMAIN,
    relPathLen: relPath.length,
  });
}

/** 写一个组的渲染副本；内容非空才收进 kb 索引（v1 口径：create/空内容
 *  不触发 reindex，只有内容写入会）。尽力而为，不阻塞主写路径。 */
function syncGroupRender(uid: string, group: PoGroup): void {
  try {
    const relPath = poGroupRelPath(group);
    // 渲染写前校验组 id/relPath；非法（含路径穿越）→ 副本丢弃 + 坏档登记。
    if (!safeRenderRelPath(relPath)) {
      rejectUnsafeRenderRelPath(uid, relPath);
      return;
    }
    const abs = groupAbsPath(uid, relPath);
    // 渲染隐私边界：写盘副本 restricted 值占位化（不出现正文），索引钩子
    // 照常——副本可继续索引。读路径/授权视图/归档仍走原文渲染。
    const rendered = renderGroupMarkdownCopy(group);
    writeTextAtomicSync(abs, rendered);
    if (rendered.trim()) {
      search.upsertContext(uid, relPath);
      kbIndexer.enqueue(uid, relPath, 'upsert');
    }
  } catch (err) {
    log.warn('po render sync failed', { uid, groupId: group.id, error: (err as Error).message });
  }
}

/** 删一个组的渲染副本 + 踢出 kb 索引（尽力而为）。 */
function dropGroupRender(uid: string, relPath: string): void {
  // 删除路径同样先过安全段校验——非法 relPath 不做任何盘上/索引操作，
  // 与 syncGroupRender 同口径丢弃 + 登记（rm/索引钩子都不吃穿越路径）。
  if (!safeRenderRelPath(relPath)) {
    rejectUnsafeRenderRelPath(uid, relPath);
    return;
  }
  try {
    fs.rmSync(groupAbsPath(uid, relPath), { force: true });
  } catch { /* 尽力而为 */ }
  try {
    search.dropContext(uid, relPath);
    kbIndexer.enqueue(uid, relPath, 'delete');
  } catch (err) {
    log.warn('po render drop failed', { uid, relPath, error: (err as Error).message });
  }
}

/** 全量渲染（迁移完成时用）：把每个组副本刷成与 JSON 一致。 */
function renderAllGroups(uid: string, doc: PoDocument): void {
  for (const group of doc.groups) syncGroupRender(uid, group);
}

// 组渲染由写路径内部的 touch / markRemoved 更新（见 PoEditContext）。

// ── 统一写路径 ───────────────────────────────────────────────────────────

export interface PoEditContext {
  /** 被编辑的文档（直接改它）。 */
  doc: PoDocument;
  /** 标记某组已变更：首次 touch 时抓下改前状态（用于历史快照），返回该组活引用。 */
  touch(groupId: string): PoGroup | undefined;
  /** 标记某组的渲染副本待删除（组已从 doc 移除后调用）。 */
  markRemoved(relPath: string): void;
  /** 校验失败：中止本次编辑（不落盘、不留快照）。 */
  fail(error: string): void;
}

export interface PoEditOutcome {
  ok: boolean;
  error?: string;
}

/**
 * 统一写路径：锁 → 加载 → 业务变更 → （成功时）改前快照 + 持久化 + 渲染同步 +
 * 认知写通知。业务函数只操作 ctx.doc 并在参数非法时 ctx.fail。
 */
export async function editPoDoc(
  uid: string,
  fn: (ctx: PoEditContext) => Promise<void> | void,
  options: { suppressSnapshots?: boolean } = {},
): Promise<PoEditOutcome> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const filePath = poDocPath(uid);
  return withCognitionTransition(uid, () => fileEditLock(filePath).runExclusive(async () => {
    const doc = loadPoDocSync(uid);
    // 容量门基线：编辑前的序列化字节数（紧凑口径，与下方 nextBytes
    // 同尺，只用于「是否变大」的比较，不要求与盘上缩进字节一致）。
    const preEditBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    // 坏档三件套·写侧门：load 探测到坏档（已 copy 备份 + 登记）→ 拒绝落盘。
    // 只有真 ENOENT（文件不存在）走空初始化后落盘；恢复/重置后才恢复可写。
    const corrupt = corruptRecordFor(filePath);
    if (corrupt) {
      log.warn('po doc corrupt; write refused', { uid, reason: corrupt.reason });
      return { ok: false, error: `po doc corrupt; write refused (${corrupt.reason}); use backup recovery` };
    }
    const touched = new Map<string, { before: PoGroup }>();
    const removedRels: string[] = [];
    let failure: string | undefined;
    const ctx: PoEditContext = {
      doc,
      touch(groupId: string): PoGroup | undefined {
        const group = doc.groups.find((g) => g.id === groupId);
        if (!group) return undefined;
        if (!touched.has(groupId)) {
          touched.set(groupId, { before: JSON.parse(JSON.stringify(group)) as PoGroup });
        }
        return group;
      },
      markRemoved(relPath: string): void {
        if (!removedRels.includes(relPath)) removedRels.push(relPath);
      },
      fail(error: string): void {
        failure = failure || error;
      },
    };
    try {
      await fn(ctx);
    } catch (err) {
      failure = failure || (err as Error).message || 'po edit failed';
    }
    if (failure) return { ok: false, error: failure };

    // 容量门：把文档推过上限的写被拒绝并给可操作错误；存量不
    // 追溯——已超限的文档允许「不使总量变大」的编辑（清理/删减/持平照常
    // 可写），否则一次超限就永久锁死用户的本体。
    const nextBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (nextBytes > PO_DOC_BYTE_LIMIT && nextBytes > preEditBytes) {
      log.warn('po doc over byte limit; growth write refused', {
        uid, nextBytes, preEditBytes, limit: PO_DOC_BYTE_LIMIT,
      });
      return {
        ok: false,
        error: `po document exceeds ${PO_DOC_BYTE_LIMIT} UTF-8 bytes (${nextBytes}); remove or trim entries before adding more`,
      };
    }

    // 改前快照（有实际变化才留：touch 了但内容/标题完全没变的组跳过；
    // 改前为空的组跳过——对齐 v1「首次写入不留档」的口径）。
    const isEmptyGroup = (g: PoGroup): boolean =>
      !g.fields.length && !g.values.length && !g.entries.length;
    for (const [groupId, { before }] of touched) {
      if (options.suppressSnapshots) break;
      const after = doc.groups.find((g) => g.id === groupId);
      if (!after) continue; // 已被移除（进 trash）——trash 本身就是留档
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      if (isEmptyGroup(before)) continue;
      snapshotPoGroup(uid, groupId, before);
    }

    // 首次落盘：如果 JSON 还不存在，这次写入就是迁移结果的持久化（或新用户
    // 的第一笔）。顺序约束：先落 marker（JSON），落盘成功后再备份走 v1 目录、
    // 退役 groups.md 台账——落盘失败时 v1 原文仍在，可无损重试；且备份必须
    // 抢在下方 syncGroupRender 覆写 v1 渲染副本之前，备份里才是 v1 原始字节。
    const firstPersist = !fs.existsSync(filePath);
    if (firstPersist) {
      doc.migratedFromV1At = doc.migratedFromV1At || nowIso();
    }
    await persistPoSource(uid, doc, () => writeJson(filePath, doc));
    if (firstPersist) {
      const { backupV1Dir, persistV1History } = await import('./migrate') as typeof import('./migrate');
      backupV1Dir(uid);
      // 旧 .history → po-history 的转换只在结清步落盘（读路径零副作用）。
      persistV1History(uid);
    }
    for (const [, { before }] of touched) {
      const after = doc.groups.find((g) => g.id === before.id);
      if (after) syncGroupRender(uid, after);
    }
    for (const relPath of removedRels) dropGroupRender(uid, relPath);
    notifyCognitionWrite(uid, 'ontology-groups', 'update');
    return { ok: true };
  }));
}

// ── 历史快照（写前留档，滚动 50 份）──────────────────────────────────────

interface PoSnapshotFile {
  group: PoGroup;
  savedAt: string;
}

function snapshotFileName(stamp: string, seq: number): string {
  return `${stamp}-${String(seq).padStart(2, '0')}.json`;
}

/** 写前快照（尽力而为：失败只记日志，绝不阻塞主写路径）。 */
function snapshotPoGroup(uid: string, groupId: string, before: PoGroup): void {
  writePoGroupSnapshot(uid, groupId, before);
}

/** 显式快照写入（组删除前的留档、按文本快照的兼容层用）。 */
export function writePoGroupSnapshot(uid: string, groupId: string, before: PoGroup): void {
  try {
    // 与同族入口（listPoGroupHistory / readPoGroupSnapshot / appendPoAudit /
    // readPoGroupAudit）同构的 safeId 双校验：poHistoryDir 直接拼 groupId，
    // 非 [A-Za-z0-9_-] 串可路径穿越，静默拒绝（尽力而为写入口，不 throw）。
    if (!safeId(uid) || !safeId(groupId)) return;
    const dir = poHistoryDir(uid, groupId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let seq = 0;
    let fileName = snapshotFileName(stamp, seq);
    while (fs.existsSync(path.join(dir, fileName))) {
      seq += 1;
      fileName = snapshotFileName(stamp, seq);
    }
    const payload: PoSnapshotFile = { group: before, savedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== AUDIT_FILE_NAME).sort();
    while (files.length > HISTORY_MAX_PER_GROUP) {
      fs.rmSync(path.join(dir, files.shift() as string));
    }
  } catch (err) {
    log.warn('po snapshot failed (best effort)', { uid, groupId, error: (err as Error).message });
  }
}

export interface PoHistoryEntry {
  id: string;
  savedAt: string;
  bytes: number;
  preview: string;
  audit?: { action: string; field?: string; beforeSummary?: string; afterSummary?: string; at: string };
}

/** 组变更历史（新→旧）。旧 v1 的 .md 快照由迁移转成 .json；转不了的忽略。 */
export function listPoGroupHistory(uid: string, groupId: string): PoHistoryEntry[] {
  if (!safeId(uid) || !safeId(groupId)) return [];
  try {
    const dir = poHistoryDir(uid, groupId);
    const auditPoints = readPoGroupAudit(uid, groupId)
      .map((line) => ({ line, ms: Date.parse(line.at) }))
      .filter((p) => !Number.isNaN(p.ms));
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => {
        let savedAt = '';
        let text = '';
        try {
          const parsed = JSON.parse(readTextSafe(path.join(dir, f))) as PoSnapshotFile;
          savedAt = String(parsed?.savedAt || '');
          text = renderGroupMarkdown(parsed.group);
        } catch { return null; }
        let audit: PoHistoryEntry['audit'];
        const savedMs = Date.parse(savedAt);
        if (!Number.isNaN(savedMs)) {
          let best: PoHistoryEntry['audit'] | undefined;
          let bestAbs = Number.POSITIVE_INFINITY;
          for (const p of auditPoints) {
            const abs = Math.abs(p.ms - savedMs);
            if (abs < bestAbs) {
              bestAbs = abs;
              best = {
                action: p.line.action,
                field: p.line.field,
                beforeSummary: p.line.beforeSummary,
                afterSummary: p.line.afterSummary,
                at: p.line.at,
              };
            }
          }
          if (best && bestAbs <= 2000) audit = best;
        }
        return {
          id: f.slice(0, -'.json'.length),
          savedAt: savedAt || f.slice(0, 24),
          bytes: Buffer.byteLength(text, 'utf8'),
          preview: text.replace(/\s+/g, ' ').slice(0, 80),
          ...(audit ? { audit } : {}),
        };
      })
      .filter((e): e is PoHistoryEntry => e !== null);
  } catch {
    return [];
  }
}

/** Read a snapshot's full group state; missing/corrupt → null. */
export function readPoGroupSnapshot(uid: string, groupId: string, snapshotId: string): PoGroup | null {
  if (!safeId(uid) || !safeId(groupId)) return null;
  if (!/^[0-9TZ-]{20,}(?:-\d{2})?$/.test(snapshotId)) return null;
  try {
    const parsed = JSON.parse(readTextSafe(path.join(poHistoryDir(uid, groupId), `${snapshotId}.json`))) as PoSnapshotFile;
    return parsed?.group ? normalizePoDocument({ groups: [parsed.group] }).groups[0] || null : null;
  } catch {
    return null;
  }
}

export interface PoAssetPurgeResult {
  liveValues: number;
  trashValues: number;
  historyFiles: number;
  historyValues: number;
}

/** Remove every PO copy owned by a purged asset. Live groups, trash and the
 *  rolling history snapshots are separate stores; only values carrying the
 *  assetId are touched, so manual values and sibling assets stay intact.
 *  `po-history/<groupId>/audit.jsonl` is a manual-action ledger: its rows have
 *  no assetId and are deliberately not rewritten by an asset purge. */
export async function purgePoAssetProjections(uid: string, assetId: string): Promise<PoAssetPurgeResult> {
  if (!safeId(uid) || !safeId(assetId)) throw new Error('invalid PO purge identity');
  const result: PoAssetPurgeResult = { liveValues: 0, trashValues: 0, historyFiles: 0, historyValues: 0 };
  const edited = await editPoDoc(uid, (ctx) => {
    for (const group of ctx.doc.groups) {
      const before = group.values.length;
      group.values = group.values.filter(value => value.assetId !== assetId);
      if (group.values.length !== before) {
        group.updatedAt = nowIso();
        ctx.touch(group.id);
        result.liveValues += before - group.values.length;
      }
    }
    for (const item of ctx.doc.trash) {
      const before = item.group.values.length;
      item.group.values = item.group.values.filter(value => value.assetId !== assetId);
      if (item.group.values.length !== before) {
        item.group.updatedAt = nowIso();
        result.trashValues += before - item.group.values.length;
      }
    }
  }, { suppressSnapshots: true });
  if (!edited.ok) throw new Error(edited.error || 'PO projection purge failed');

  await withCognitionTransition(uid, () => fileEditLock(poDocPath(uid)).runExclusive(async () => {
    const base = path.dirname(poHistoryDir(uid, 'placeholder'));
    let groups: string[];
    try { groups = fs.readdirSync(base); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const groupId of groups) {
      if (!safeId(groupId)) continue;
      const dir = poHistoryDir(uid, groupId);
      let files: string[];
      try { files = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { continue; }
      for (const name of files) {
        const file = path.join(dir, name);
        let parsed: PoSnapshotFile;
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PoSnapshotFile; } catch {
          throw new Error(`PO history is unreadable: ${groupId}/${name}`);
        }
        if (!parsed?.group || !Array.isArray(parsed.group.values)) continue;
        const before = parsed.group.values.length;
        parsed.group.values = parsed.group.values.filter(value => value.assetId !== assetId);
        if (parsed.group.values.length === before) continue;
        const tmp = `${file}.purge-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8');
        fs.renameSync(tmp, file);
        result.historyFiles += 1;
        result.historyValues += before - parsed.group.values.length;
      }
    }
  }));
  return result;
}

// ── 摘要台账（audit.jsonl，行格式与 v1 一致）─────────────────────────────

export interface PoAuditLine {
  at: string;
  actor: 'user';
  action: string;
  groupId: string;
  field?: string;
  beforeSummary?: string;
  afterSummary?: string;
  reason?: string;
}

export interface PoAuditOpts {
  field?: string;
  beforeSummary?: string;
  afterSummary?: string;
  reason?: string;
}

/** 追加一行摘要台账（尽力而为：任何失败都被吞，绝不阻塞主写路径）。 */
export function appendPoAudit(uid: string, groupId: string, action: string, opts?: PoAuditOpts): void {
  try {
    if (!safeId(uid) || !safeId(groupId)) return;
    const clip = (s?: string): string | undefined =>
      typeof s === 'string' ? s.slice(0, AUDIT_SUMMARY_MAX_CHARS) : undefined;
    const line: PoAuditLine = { at: new Date().toISOString(), actor: 'user', action, groupId };
    if (opts?.field) line.field = opts.field;
    const before = clip(opts?.beforeSummary);
    if (before !== undefined) line.beforeSummary = before;
    const after = clip(opts?.afterSummary);
    if (after !== undefined) line.afterSummary = after;
    const reason = clip(opts?.reason);
    if (reason !== undefined && reason !== '') line.reason = reason;
    const dir = poHistoryDir(uid, groupId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, AUDIT_FILE_NAME), `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // 尽力而为。
  }
}

/** 读取某组的台账行（无文件 / 坏行 / 任何失败 → 空数组，绝不 throw）。 */
export function readPoGroupAudit(uid: string, groupId: string): PoAuditLine[] {
  try {
    if (!safeId(uid) || !safeId(groupId)) return [];
    const text = readTextSafe(path.join(poHistoryDir(uid, groupId), AUDIT_FILE_NAME));
    const out: PoAuditLine[] = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as PoAuditLine;
        if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') out.push(parsed);
      } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ── 杂项 ─────────────────────────────────────────────────────────────────

/** v1 目录路径（渲染副本 + 归档 + conflicts.md 的家，路径不变）。 */
export function poLegacyDir(uid: string): string {
  return userOntologyGroupsDir(uid);
}

/** 新字段/值/条目 id。 */
export function poGenId(): string {
  return genId12();
}

/** contexts 根（readContentById 等做路径解释用）。 */
export function poContextsDir(uid: string): string {
  return userContextsDir(uid);
}
