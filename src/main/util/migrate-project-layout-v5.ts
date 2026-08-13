/**
 * v5 migration: 空间化重构（删项目层）— 阶段 0 地基。
 *
 * v4 把会话/任务/附件/产物从顶层搬进 `cloud/projects/<pid>/`；
 * v5 把 `conversation.project_id` 迁移为 `conversation.space_id`，并把项目内
 * 字节搬到 `cloud/spaces/<sid>/`。
 *
 * 分工：
 *   - T0.1 `collectProjectSpaceStats(uid)`：只读存量统计（迁移前备份统计的数据源）。
 *   - T0.3 `migrateProjectLayoutV5(uid)`：搬移执行（project_id→space_id 复制 +
 *     `cloud/projects/<pid>/{chats,sessions,chat_attachments,chat_artifacts}` →
 *     `cloud/spaces/<sid>/{...}`）。当前未加锁/未建 marker/未注册——T0.4 补。
 *
 * 关键语义（拍板决策 ③ 删法 B）：
 *   - 有 space_id 的项目 → 其会话 space_id = project.space_id，文件搬到空间内容目录。
 *   - 无 space_id 的项目（orphan）→ 本阶段不动，空间列表不纳入（决策 ① + 开放问题 3）。
 *   - 会话记录上 project_id 与 space_id 双字段并存（阶段 0 兼容期），阶段 4 再清 project_id。
 *   - 多个项目可指向同一空间：会话索引按 conversation_id 合并（incoming 带 space_id 胜出），
 *     会话/附件/产物按 cid 唯一不冲突。
 *
 * 顺序纪律：先落地 `Conversation.space_id`（T0.2）+ 本搬移（T0.3），再改执行路径
 * （T4.1 `resolveSpaceScope` + `conversationLayout` 认 space 根）。中间态（搬完但
 * 执行路径仍读 projects/）会断——这是计划明示接受的未发布分支中间态，T4.1 前不对外。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  projectMetaFile,
  projectChatIndexFile,
  projectChatsDir,
  projectSessionsDir,
  projectChatAttachmentsDir,
  projectChatArtifactsDir,
  spaceChatIndexFile,
  spaceChatsDir,
  spaceSessionsDir,
  spaceChatAttachmentsDir,
  spaceChatArtifactsDir,
} from '../paths';
import { readJsonSync, safeId, writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { listProjectIds, cloudRelForAbs } from './project-layout';

const log = createLogger('migrate-project-layout-v5');

export const MIGRATION_VERSION = 5;

// ── 存量统计（T0.1 只读）──────────────────────────────────────────────────

export interface ProjectSpaceMigrationStats {
  projects_total: number;
  projects_with_space: number;
  projects_orphan: number;
  conversations_total: number;
  conversations_with_space: number;
  conversations_orphan: number;
  by_project: Array<{
    project_id: string;
    space_id: string | null;
    name: string;
    conversations: number;
  }>;
  warnings: string[];
}

function emptyStats(): ProjectSpaceMigrationStats {
  return {
    projects_total: 0,
    projects_with_space: 0,
    projects_orphan: 0,
    conversations_total: 0,
    conversations_with_space: 0,
    conversations_orphan: 0,
    by_project: [],
    warnings: [],
  };
}

function readJsonArray(file: string): any[] {
  const raw: any = readJsonSync(file);
  return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
}

/** T0.1 只读存量统计：遍历所有 project，读其 space_id 与会话数（排除墓碑）。不写盘。 */
export function collectProjectSpaceStats(uid: string): ProjectSpaceMigrationStats {
  const stats = emptyStats();
  if (!safeId(uid)) {
    stats.warnings.push(`invalid uid: ${String(uid)}`);
    return stats;
  }

  for (const pid of listProjectIds(uid)) {
    stats.projects_total += 1;

    const meta: any = readJsonSync(projectMetaFile(uid, pid));
    const rawSpaceId = typeof meta?.space_id === 'string' ? meta.space_id : '';
    const spaceId = safeId(rawSpaceId) ? rawSpaceId : null;

    let convCount = 0;
    for (const row of readJsonArray(projectChatIndexFile(uid, pid))) {
      const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
      if (!safeId(cid)) continue;
      if (typeof row?.deleted_at === 'string' && row.deleted_at) continue;
      convCount += 1;
    }

    if (spaceId) {
      stats.projects_with_space += 1;
      stats.conversations_with_space += convCount;
    } else {
      stats.projects_orphan += 1;
      stats.conversations_orphan += convCount;
    }
    stats.conversations_total += convCount;

    stats.by_project.push({
      project_id: pid,
      space_id: spaceId,
      name: typeof meta?.name === 'string' ? meta.name : '',
      conversations: convCount,
    });
  }

  return stats;
}

// ── 搬移执行（T0.3）───────────────────────────────────────────────────────

export interface ProjectSpaceMoveStats {
  projects_migrated: number;
  conversations_moved: number;
  sessions_moved: number;
  attachments_moved: number;
  artifacts_moved: number;
  warnings: string[];
}

function emptyMoveStats(): ProjectSpaceMoveStats {
  return {
    projects_migrated: 0,
    conversations_moved: 0,
    sessions_moved: 0,
    attachments_moved: 0,
    artifacts_moved: 0,
    warnings: [],
  };
}

function sha256File(file: string): { sha256: string; size: number } | null {
  try {
    const buf = fs.readFileSync(file);
    return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  } catch {
    return null;
  }
}

function sameFileContent(a: string, b: string): boolean {
  const ha = sha256File(a);
  const hb = sha256File(b);
  return !!ha && !!hb && ha.size === hb.size && ha.sha256 === hb.sha256;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function pruneEmptyDirs(dir: string): void {
  let cur = dir;
  const stop = path.resolve(dir);
  while (path.resolve(cur).startsWith(stop)) {
    if (path.resolve(cur) === stop) break;
    try { fs.rmdirSync(cur); }
    catch { break; }
    cur = path.dirname(cur);
  }
}

function cloudRel(uid: string, abs: string): string {
  return cloudRelForAbs(uid, abs);
}

/** 单文件安全搬移：目标存在且内容相同 → 删源；目标存在内容不同 → 源改名保留为
 *  `.legacy-v5-<hash>`（绝不覆盖）；否则 rename（EXDEV 回退 copy+unlink）。 */
function moveFileSafe(uid: string, fromAbs: string, toAbs: string, warnings: string[]): boolean {
  if (!fs.existsSync(fromAbs)) return false;
  try {
    if (!fs.statSync(fromAbs).isFile()) return false;
  } catch {
    return false;
  }
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  if (fs.existsSync(toAbs)) {
    if (sameFileContent(fromAbs, toAbs)) {
      try { fs.unlinkSync(fromAbs); } catch { /* best effort */ }
      return true;
    }
    const h = sha256File(fromAbs);
    const preserved = `${toAbs}.legacy-v5-${h ? h.sha256.slice(0, 8) : Date.now().toString(16)}`;
    warnings.push(`target exists, preserved legacy file at ${cloudRel(uid, preserved)}`);
    fs.mkdirSync(path.dirname(preserved), { recursive: true });
    try { fs.renameSync(fromAbs, preserved); }
    catch {
      fs.copyFileSync(fromAbs, preserved);
      try { fs.unlinkSync(fromAbs); } catch { /* best effort */ }
    }
    return true;
  }
  try { fs.renameSync(fromAbs, toAbs); }
  catch {
    fs.copyFileSync(fromAbs, toAbs);
    try { fs.unlinkSync(fromAbs); } catch { /* best effort */ }
  }
  return true;
}

/** 整目录安全搬移：目标不存在 → 整目录 rename；目标存在 → 逐文件合并。返回搬移文件数。 */
function moveDirSafe(uid: string, fromDir: string, toDir: string, warnings: string[]): number {
  if (!fs.existsSync(fromDir)) return 0;
  try {
    if (!fs.statSync(fromDir).isDirectory()) return 0;
  } catch {
    return 0;
  }
  const files = walkFiles(fromDir);
  if (!files.length) {
    try { fs.mkdirSync(toDir, { recursive: true }); fs.rmdirSync(fromDir); } catch { /* best effort */ }
    return 0;
  }
  let moved = 0;
  if (!fs.existsSync(toDir)) {
    try {
      fs.mkdirSync(path.dirname(toDir), { recursive: true });
      fs.renameSync(fromDir, toDir);
      return files.length;
    } catch { /* fall through to per-file merge */ }
  }
  for (const f of files) {
    if (moveFileSafe(uid, f, path.join(toDir, path.relative(fromDir, f)), warnings)) moved += 1;
  }
  pruneEmptyDirs(fromDir);
  return moved;
}

/** 会话索引合并：按 conversation_id 去重，incoming（已带 space_id）覆盖既有。 */
function mergeConversationRows(existing: any[], incoming: any[]): any[] {
  const byCid = new Map<string, any>();
  for (const row of existing) {
    const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
    if (safeId(cid)) byCid.set(cid, row);
  }
  for (const row of incoming) {
    const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
    if (!safeId(cid)) continue;
    byCid.set(cid, row);
  }
  return Array.from(byCid.values());
}

/** 单个项目 → 其空间：索引加 space_id 合并、chats/jsonl/group 搬移、sessions/附件/产物搬移。 */
function migrateProjectToSpace(uid: string, pid: string, sid: string, stats: ProjectSpaceMoveStats): void {
  // 1. 索引：源行打 space_id，合并进空间索引（多项目同空间时按 cid 合并）。
  const srcIndex = projectChatIndexFile(uid, pid);
  const srcRows = readJsonArray(srcIndex);
  const tagged: any[] = [];
  for (const row of srcRows) {
    const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
    if (!safeId(cid)) continue;
    tagged.push({ ...row, space_id: sid });
  }
  const tgtIndex = spaceChatIndexFile(uid, sid);
  const merged = mergeConversationRows(readJsonArray(tgtIndex), tagged);
  if (merged.length) {
    fs.mkdirSync(path.dirname(tgtIndex), { recursive: true });
    writeJsonSync(tgtIndex, merged);
  }
  stats.conversations_moved += tagged.length;

  // 2. chats/ 内容（jsonl + group 目录）搬移；`_index.json` 已合并，跳过并删除源。
  const srcChats = projectChatsDir(uid, pid);
  let names: string[] = [];
  try { names = fs.readdirSync(srcChats); } catch { names = []; }
  for (const name of names) {
    if (name === '_index.json') continue;
    const fromAbs = path.join(srcChats, name);
    const toAbs = path.join(spaceChatsDir(uid, sid), name);
    let isDir = false;
    try { isDir = fs.statSync(fromAbs).isDirectory(); } catch { continue; }
    if (isDir) moveDirSafe(uid, fromAbs, toAbs, stats.warnings);
    else moveFileSafe(uid, fromAbs, toAbs, stats.warnings);
  }
  try { fs.rmSync(srcIndex, { force: true }); } catch { /* best effort */ }

  // 3. sessions / 附件 / 产物（按 cid 唯一，多项目不冲突）。
  stats.sessions_moved += moveDirSafe(uid, projectSessionsDir(uid, pid), spaceSessionsDir(uid, sid), stats.warnings);
  stats.attachments_moved += moveDirSafe(uid, projectChatAttachmentsDir(uid, pid), spaceChatAttachmentsDir(uid, sid), stats.warnings);
  stats.artifacts_moved += moveDirSafe(uid, projectChatArtifactsDir(uid, pid), spaceChatArtifactsDir(uid, sid), stats.warnings);

  stats.projects_migrated += 1;
}

/**
 * T0.3 搬移执行入口：对每个有 space_id 的项目，把会话/会话状态/附件/产物搬到
 * 空间内容目录，并把会话索引行 `space_id` 置为项目 space_id（project_id 保留，双字段兼容）。
 * 未加锁/未建 marker/未注册——T0.4 补（幂等 + boot 注册）。
 */
export function migrateProjectLayoutV5(uid: string): ProjectSpaceMoveStats {
  const stats = emptyMoveStats();
  if (!safeId(uid)) {
    stats.warnings.push(`invalid uid: ${String(uid)}`);
    return stats;
  }

  const before = collectProjectSpaceStats(uid);

  for (const pid of listProjectIds(uid)) {
    const meta: any = readJsonSync(projectMetaFile(uid, pid));
    const sid = typeof meta?.space_id === 'string' && safeId(meta.space_id) ? meta.space_id : '';
    if (!sid) continue; // orphan 项目（无 space_id）→ 阶段 4 处理
    try {
      migrateProjectToSpace(uid, pid, sid, stats);
    } catch (err) {
      stats.warnings.push(`migrate project ${pid} → space ${sid} failed: ${(err as Error).message}`);
    }
  }

  if (stats.projects_migrated || stats.warnings.length) {
    log.info('project layout v5 (space) migration complete', {
      uid,
      before: {
        projects_total: before.projects_total,
        projects_with_space: before.projects_with_space,
        projects_orphan: before.projects_orphan,
        conversations_total: before.conversations_total,
      },
      ...stats,
    });
  }
  return stats;
}
