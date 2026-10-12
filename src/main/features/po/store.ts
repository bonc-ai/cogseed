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
import * as path from 'node:path';
import { fileEditLock } from '../../util/locks';
import { userCognitionDir, userContextsDir, userOntologyGroupsDir } from '../../paths';
import { genId12, nowIso, safeId, writeJson, writeJsonSync } from '../../storage';
import { writeTextAtomicSync } from '../../storage';
import { notifyCognitionWrite } from '../recall/store-events';
import * as search from '../search';
import * as kbIndexer from '../kb_indexer';
import { createLogger } from '../../logger';
import { emptyPoDocument, normalizePoDocument, type PoDocument, type PoGroup } from './model';
import { poGroupRelPath, renderGroupMarkdown } from './view';
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
 */
export function loadPoDocSync(uid: string): PoDocument {
  if (!safeId(uid)) return emptyPoDocument();
  const filePath = poDocPath(uid);
  if (fs.existsSync(filePath)) {
    try {
      return normalizePoDocument(JSON.parse(readTextSafe(filePath)));
    } catch (err) {
      log.warn('po doc unreadable; starting from empty (v1 import skipped)', { uid, error: (err as Error).message });
      return emptyPoDocument();
    }
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
  const filePath = poDocPath(uid);
  if (fs.existsSync(filePath)) return loadPoDocSync(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    if (fs.existsSync(filePath)) return loadPoDocSync(uid); // 双检：锁内可能已被迁移
    const { backupV1Dir } = await import('./migrate') as typeof import('./migrate');
    const doc = importFromV1Sync(uid);
    if (doc) {
      // v1 目录存在（返回非 null）→ 无论导入结果空否都落盘结清：空 JSON 即
      // marker，此后读路径（loadPoDocSync）不再全量重扫 v1（读 groups.md、
      // 扫 .history、孤儿复活）；null = 新用户，维持懒创建不落盘。
      backupV1Dir(uid);
      doc.migratedFromV1At = doc.migratedFromV1At || nowIso();
      await writeJson(filePath, doc);
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

/** 写一个组的渲染副本；内容非空才收进 kb 索引（v1 口径：create/空内容
 *  不触发 reindex，只有内容写入会）。尽力而为，不阻塞主写路径。 */
function syncGroupRender(uid: string, group: PoGroup): void {
  try {
    const relPath = poGroupRelPath(group);
    const abs = groupAbsPath(uid, relPath);
    const rendered = renderGroupMarkdown(group);
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

/** 按渲染副本 relPath 找到组并重刷副本（v1 notifyGroupUpserted 的语义）。 */
export function syncRenderForRelPath(uid: string, relPath: string): void {
  const doc = loadPoDocSync(uid);
  const group = doc.groups.find((g) => poGroupRelPath(g) === relPath);
  if (group) syncGroupRender(uid, group);
}

/** 按渲染副本 relPath 删副本 + 踢索引（v1 notifyGroupDeleted 的语义）。 */
export function dropRenderForRelPath(uid: string, relPath: string): void {
  dropGroupRender(uid, relPath);
}

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
): Promise<PoEditOutcome> {
  if (!safeId(uid)) return { ok: false, error: 'invalid uid' };
  const filePath = poDocPath(uid);
  return fileEditLock(filePath).runExclusive(async () => {
    const doc = loadPoDocSync(uid);
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

    // 改前快照（有实际变化才留：touch 了但内容/标题完全没变的组跳过；
    // 改前为空的组跳过——对齐 v1「首次写入不留档」的口径）。
    const isEmptyGroup = (g: PoGroup): boolean =>
      !g.fields.length && !g.values.length && !g.entries.length;
    for (const [groupId, { before }] of touched) {
      const after = doc.groups.find((g) => g.id === groupId);
      if (!after) continue; // 已被移除（进 trash）——trash 本身就是留档
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      if (isEmptyGroup(before)) continue;
      snapshotPoGroup(uid, groupId, before);
    }

    // 首次落盘：如果 JSON 还不存在，这次写入就是迁移结果的持久化（或新用户
    // 的第一笔）——先把 v1 目录备份走，再落 marker 表示「v1 已结清」，此后
    // 读路径不会再尝试导入。
    const firstPersist = !fs.existsSync(filePath);
    if (firstPersist) {
      const { backupV1Dir } = await import('./migrate') as typeof import('./migrate');
      backupV1Dir(uid);
      doc.migratedFromV1At = doc.migratedFromV1At || nowIso();
    }
    await writeJson(filePath, doc);
    for (const [, { before }] of touched) {
      const after = doc.groups.find((g) => g.id === before.id);
      if (after) syncGroupRender(uid, after);
    }
    for (const relPath of removedRels) dropGroupRender(uid, relPath);
    notifyCognitionWrite(uid, 'ontology-groups', 'update');
    return { ok: true };
  });
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

/** 读一版快照的完整组状态；不存在/坏档 → null。 */
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
