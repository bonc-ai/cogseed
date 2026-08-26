/**
 * 空间产物聚合（空间化重构阶段 1 / T1.2）—— 空间「产物」tab 数据源。
 *
 * 遍历空间下会话，聚合两类产物：
 *   - 附件（attachment）：`cloud/spaces/<sid>/chat_attachments/<cid>/` 下的文件；
 *   - 交互产物（artifact）：`cloud/spaces/<sid>/chat_artifacts/<cid>/<aid>/` 目录
 *     （web app，读 `__cogseed-meta.json` 取标题/创建时间）。
 *
 * 为什么直接扫空间路径而不是复用 `chat_attachments.listAttachments` /
 * `artifactDirForConversation`：后两者经 `project-layout` 按 `project_id` 解析
 * 到 projects/ 或全局根，尚未支持空间根（阶段 4 T4.1 才改）。v5 迁移已把已绑空间
 * 会话的附件/产物搬到 `spaces/<sid>/`，故本模块直接读空间目录，与迁移落点对齐。
 * 阶段 4 统一路径解析后可再收敛。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { chatArtifactCidDir, chatAttachmentDir, spaceChatAttachmentDir, spaceChatArtifactCidDir, spaceChatIndexFile, spaceContentDir } from '../paths';
import { conversationMessageReadFile } from '../util/project-layout';
import { safeId } from '../storage';
import { ALLOWED_EXTENSIONS } from './chat_attachments';
import { getMessages, listSpaceConversations, listSpaceConversationsLight } from './chats';

/** AI 产出文件宽扩展名：附件上传白名单之外，工作区产物额外放行的常见格式
 *  （旧 Office / 矢量图 / 压缩包 / 电子书 / 网页等），保证「产出的都能落位」。 */
const PRODUCED_EXTRA_EXTS: ReadonlySet<string> = new Set([
  '.doc', '.xls', '.ppt',
  '.svg',
  '.zip', '.rar', '.7z', '.tar', '.gz',
  '.epub', '.pages', '.key', '.numbers',
  '.html', '.htm',
]);

function isProducedExt(ext: string): boolean {
  return ALLOWED_EXTENSIONS.has(ext) || PRODUCED_EXTRA_EXTS.has(ext);
}

const ARTIFACT_META_FILENAME = '__cogseed-meta.json';

// ── 附件/网页产物空间化迁移（搬家工人）────────────────────────────────────
// 历史数据：空间会话的附件/网页产物落在全局 cloud/chat_attachments|chat_artifacts/<cid>/，
// 空间化后应落 spaces/<sid>/chat_attachments|chat_artifacts/<cid>/。
// 幂等（目标已有内容则按文件名补漏，绝不覆盖）；失败只告警不阻断。
const _migratedSpaces = new Set<string>(); // 进程内已迁移空间（防重复扫描）

function _migrateDirEntry(srcDir: string, dstDir: string): number {
  if (!srcDir || !dstDir || !fs.existsSync(srcDir)) return 0;
  let moved = 0;
  try {
    const srcExists = fs.existsSync(srcDir);
    const dstExists = fs.existsSync(dstDir) && fs.readdirSync(dstDir).length > 0;
    if (!srcExists) return 0;
    if (!dstExists) {
      // 目标空/不存在 → 整个目录搬过去（同盘 rename，跨盘 copy+rm）
      fs.mkdirSync(path.dirname(dstDir), { recursive: true });
      try { fs.renameSync(srcDir, dstDir); moved = 1; }
      catch {
        fs.cpSync(srcDir, dstDir, { recursive: true });
        fs.rmSync(srcDir, { recursive: true, force: true });
        moved = 1;
      }
    } else {
      // 目标已有内容 → 只补漏（源有目标没有的文件），搬完删源空壳
      let changed = false;
      for (const name of fs.readdirSync(srcDir)) {
        if (name.startsWith('.')) continue;
        const from = path.join(srcDir, name);
        const to = path.join(dstDir, name);
        if (fs.existsSync(to)) continue; // 目标已有 → 保留目标（更新版本优先）
        try {
          fs.copyFileSync(from, to);
          moved++;
          changed = true;
        } catch { /* best-effort */ }
      }
      if (changed || fs.readdirSync(srcDir).filter((n) => !n.startsWith('.')).length === 0) {
        try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* 单目录迁移失败不阻断 */ }
  return moved;
}

/** 空间附件/网页产物迁移：与主流 coding agent 一致——聊天上传附件留在全局
 *  cloud/chat_attachments/（不进空间目录），历史迁入空间目录的附件反向搬回
 *  全局；网页交互产物是 AI 产出（产物），继续收进空间目录。幂等。返回迁移的目录数。 */
export async function migrateSpaceAttachments(uid: string, spaceId: string): Promise<number> {
  if (!safeId(spaceId)) return 0;
  let conversations: Array<{ conversation_id: string }> = [];
  try { conversations = await listSpaceConversations(uid, spaceId); } catch { return 0; }
  let moved = 0;
  for (const c of conversations) {
    const cid = c.conversation_id;
    if (!cid) continue;
    // 附件（聊天上传）→ 全局（空间文件夹保持"只放产物"，与主流一致）
    moved += _migrateDirEntry(spaceChatAttachmentDir(uid, spaceId, cid), chatAttachmentDir(uid, cid));
    // 网页交互产物（AI 产出）→ 空间目录
    moved += _migrateDirEntry(chatArtifactCidDir(uid, cid), spaceChatArtifactCidDir(uid, spaceId, cid));
  }
  if (moved > 0) {
    try {
      const log = (await import('../logger')).createLogger('spaces_artifacts');
      log.info(`migrated space attachments user=${uid} sid=${spaceId} dirs=${moved}`);
    } catch { /* best-effort */ }
  }
  return moved;
}

export type SpaceArtifactType = 'attachment' | 'artifact';
/** 产物来源：attachment=上传附件；artifact=网页交互产物；produced=AI 工具产出文件。 */
export type SpaceArtifactSource = 'attachment' | 'artifact' | 'produced' | 'import';

export interface SpaceArtifactEntry {
  /** 附件 = 文件名；artifact = 标题（缺省用 artifactId）。 */
  name: string;
  type: SpaceArtifactType;
  /** 小写扩展名（含点）；artifact 固定 '.html'（入口 index.html）。 */
  ext: string;
  /** 来源会话 id（cid）。 */
  sourceSessionId: string;
  /** 时间戳（秒）：附件 = mtime，artifact = meta.createdAt 或目录 mtime。 */
  time: number;
  /** 产物来源（前端区分「待确认」的 AI 产出）。 */
  source: SpaceArtifactSource;
  /** 是否正式产物（COGSEED-16 起恒为 true：产物无确认态，产出即正式）。 */
  confirmed: boolean;
  /** 绝对路径（打开产物用）。 */
  path?: string;
  /** 仅 artifact：产物目录 id。 */
  artifactId?: string;
}

// ── 产物列表缓存 ─────────────────────────────────────────────────────────
// 打开/切换空间详情时渲染端会反复请求 artifacts.list，而聚合是一次全量
// 磁盘扫描（每个会话读消息 produced[] + 递归遍历工作区目录）。缓存策略：
//   - 「变更才扫」：每次调用先算一个廉价指纹（空间会话索引 + 每个会话的
//     附件/产物目录 + 消息文件 + imports 目录的 mtime:size），指纹与上次
//     扫描时一致 → 直接返回缓存，无论隔了多久；
//   - 兜底重扫：指纹一致但缓存超过 ARTIFACT_STAMP_BACKSTOP_MS 仍重扫一次，
//     覆盖指纹感知不到的变更（如外部手动往工作区深层目录放文件），保证
//     最坏情况下陈旧不超过该窗口；
//   - 空间内新建会话时主动失效（invalidateSpaceArtifacts）；
//   - 缓存值带 uid，多账号不会串数据。
const ARTIFACT_STAMP_BACKSTOP_MS = 3 * 60_000;
const _artifactCache = new Map<string, { uid: string; at: number; stamp: string; items: SpaceArtifactEntry[] }>();

/** 空间产物缓存失效：空间内新建会话后调用，保证下次列表新鲜。 */
export function invalidateSpaceArtifacts(spaceId: string): void {
  if (!spaceId) return;
  _artifactCache.delete(spaceId);
  // 持久化表同源失效（fire-and-forget；表是派生缓存，失败无害）
  const uid = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const users = require('./users') as typeof import('./users');
      return users.getActiveUserId();
    } catch { return ''; }
  })();
  if (uid) {
    void import('./workspace_meta').then((m) => m.dropEntry(uid, 'artifacts', spaceId)).catch(() => { /* best-effort */ });
  }
}

async function _entryStamp(dir: string): Promise<string> {
  try {
    const st = await fsp.stat(dir);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

async function _fileStamp(file: string): Promise<string> {
  try {
    const st = await fsp.stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/** 空间产物的廉价变更指纹：覆盖会话成员变化（空间会话索引）、附件/网页
 *  产物增删（各自目录 mtime）、消息 produced[] 登记（消息文件 mtime）、
 *  imports 增删（imports 根目录 mtime）。指纹一致即认为产物集合未变。 */
async function _spaceArtifactsStamp(uid: string, spaceId: string): Promise<string> {
  const parts: string[] = [];
  parts.push(`chatidx:${await _fileStamp(spaceChatIndexFile(uid, spaceId))}`);
  const conversations = await listSpaceConversationsLight(uid, spaceId);
  for (const c of conversations) {
    const cid = c.conversation_id;
    if (!cid) continue;
    parts.push([
      `c:${cid}`,
      `att:${await _entryStamp(spaceChatAttachmentDir(uid, spaceId, cid))},${await _entryStamp(chatAttachmentDir(uid, cid))}`,
      `art:${await _entryStamp(spaceChatArtifactCidDir(uid, spaceId, cid))},${await _entryStamp(chatArtifactCidDir(uid, cid))}`,
      `msg:${await _fileStamp(conversationMessageReadFile(uid, cid))}`,
    ].join('|'));
  }
  parts.push(`imports:${await _entryStamp(path.join(spaceContentDir(uid, spaceId), 'imports'))}`);
  return parts.join(';');
}

async function scanAttachments(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): Promise<void> {
  // 附件可能落在两处：空间目录（v5 迁移的历史项目数据）+ 全局会话附件目录（新上传）。
  // 都扫一遍按文件名去重，保证产物列表完整（引用时以 source_cid+文件名走跨任务引用链路）。
  const dirs = [spaceChatAttachmentDir(uid, spaceId, cid), chatAttachmentDir(uid, cid)];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const ext = path.extname(e.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      let mtime = 0;
      try { mtime = Math.floor((await fsp.stat(path.join(dir, e.name))).mtimeMs / 1000); } catch { /* keep 0 */ }
      out.push({
        name: e.name, type: 'attachment', ext, sourceSessionId: cid, time: mtime,
        source: 'attachment', confirmed: true, path: path.join(dir, e.name),
      });
    }
  }
}

async function scanArtifacts(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): Promise<void> {
  // 双目录：空间目录（v5 迁移）+ 全局 chat_artifacts（新产出；无 project 的会话落全局根）
  const dirs = [spaceChatArtifactCidDir(uid, spaceId, cid), chatArtifactCidDir(uid, cid)];
  const seenArt = new Set<string>();
  for (const cidDir of dirs) {
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(cidDir, { withFileTypes: true }); }
    catch { continue; }
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      if (seenArt.has(d.name)) continue;
      seenArt.add(d.name);
      const artifactId = d.name;
      const artDir = path.join(cidDir, artifactId);
      let name = artifactId;
      let time = 0;
      try {
        const raw = await fsp.readFile(path.join(artDir, ARTIFACT_META_FILENAME), 'utf8');
        const meta = JSON.parse(raw) as { title?: unknown; createdAt?: unknown };
        if (typeof meta?.title === 'string' && meta.title.trim()) name = meta.title.trim();
        const t = Date.parse(String(meta?.createdAt || ''));
        if (Number.isFinite(t)) time = Math.floor(t / 1000);
      } catch { /* missing / malformed meta */ }
      if (!time) {
        try { time = Math.floor((await fsp.stat(artDir)).mtimeMs / 1000); } catch { /* keep 0 */ }
      }
      out.push({
        name, type: 'artifact', ext: '.html', sourceSessionId: cid, time, artifactId,
        source: 'artifact', confirmed: true, path: path.join(artDir, 'index.html'),
      });
    }
  }
}

// ── 工作区兜底遍历护栏（2026-08-24 修复：会话工作目录解析异常导致全盘遍历）────
// 事故场景：导入的 Claude 会话被记为「工作目录 = 主目录」→ 兜底遍历递归扫出
// 29,266 条产物（主目录 222 万文件，打开空间卡顿 40s+）。护栏三件套：
//  1. 异常根目录黑名单（主目录本身 / 文件系统根 / 含 .cogseed 段）→ 跳过兜底遍历
//  2. 遍历计数上限 MAX_FALLBACK_WALK_FILES：超限中止并丢弃本次兜底结果
//     （produced[] 登记产物不受影响——兜底只是"锦上添花"，跳过不丢真产物）
//  3. 显式跳过 node_modules / __pycache__（`.` 开头目录原已跳过）
// 上限可经 SPACE_ARTIFACTS_WALK_LIMIT 覆盖（测试用）。
export const MAX_FALLBACK_WALK_FILES = (() => {
  const n = Number(process.env.SPACE_ARTIFACTS_WALK_LIMIT ?? 5000);
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();
const WALK_LIMIT = new Error('space_artifacts.walk_limit');

/** 异常工作目录黑名单判定（纯函数，可单测）。
 *  只拦截「明显不是会话工作目录」的根：主目录本身、文件系统根、CogSeed 自身数据目录。
 *  主目录下的正常项目目录（~/code/...）不在拦截范围——由计数护栏兜底。 */
export function isUnsafeWorkspaceRoot(dir: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return false; // 目录不存在/不可读 → 由上层 stat 处理
  }
  try {
    if (real === fs.realpathSync(os.homedir())) return true; // 整个主目录
  } catch {
    /* homedir 不可解析则跳过该项检查 */
  }
  if (real === path.parse(real).root) return true; // 文件系统根 '/'
  if (real.split(path.sep).includes('.cogseed')) return true; // CogSeed 自身数据目录
  return false;
}

/** 扫描 AI 产出文件：先走消息 produced[]（已登记），再兜底扫会话工作区目录
 *  （未登记进 produced 的产物，如部分工具直接写文件）。按文件名去重（附件优先）。
 *  COGSEED-16：产物无确认态——所有产出自动成为正式产物，直接可打开/引用/删除。 */
async function scanProducedFiles(
  uid: string,
  spaceId: string,
  cid: string,
  out: SpaceArtifactEntry[],
  walkedWorkspaces?: Set<string>,
): Promise<void> {
  const seen = new Set(out.map((o) => o.name));
  const add = async (abs: string, name: string): Promise<void> => {
    if (!name || seen.has(name)) return;
    const ext = path.extname(name).toLowerCase();
    // 宽扩展名：附件上传白名单之外，工作区产物放行旧 Office / svg / 压缩包 / html 等
    // （AI 产出的都能落位），不放松附件上传边界（上传仍走 ALLOWED_EXTENSIONS）。
    if (!isProducedExt(ext)) return;
    let st;
    try { st = await fsp.stat(abs); } catch { return; } // 文件已删不占位
    seen.add(name);
    out.push({
      name, type: 'attachment', ext, sourceSessionId: cid, time: Math.floor(st.mtimeMs / 1000),
      source: 'produced', confirmed: true, path: abs,
    });
  };
  // 1. 消息 produced[]（已登记为产物的文件；取最近一段即可，产物都产生在会话尾部）
  try {
    const messages = await getMessages(uid, cid, 300);
    for (const m of messages) {
      for (const raw of m.produced || []) {
        const p = typeof raw === 'string' ? raw : '';
        if (!p) continue;
        await add(p, path.basename(p));
      }
    }
  } catch (err) {
    // 消息读取失败不阻断（继续工作区兜底）
  }
  // 2. 会话工作区目录兜底（部分工具直接写文件、未登记 produced；递归子目录防漏）
  //    护栏：异常根目录直接跳过；遍历计数超限中止并回滚本次兜底新增（见顶部注释）。
  //    同一空间内所有会话共享同一工作区根（除非个别会话自定义 coding_project_dir），
  //    逐会话重复遍历同一目录是 O(会话数 × 文件数) 的浪费——同一目录在一次
  //    聚合中只遍历一次（walkedWorkspaces 记忆）。
  try {
    const { getConversationWorkspacePath } = await import('./group_chat/conv_workspace');
    const wsDir = await getConversationWorkspacePath(uid, cid);
    if (wsDir && !isUnsafeWorkspaceRoot(wsDir) && !walkedWorkspaces?.has(wsDir)) {
      walkedWorkspaces?.add(wsDir);
      const startLen = out.length;
      try {
        await fsp.stat(wsDir);
        let fileCount = 0;
        const walk = async (dir: string): Promise<void> => {
          let entries: fs.Dirent[] = [];
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            if (e.isDirectory() && (e.name === 'node_modules' || e.name === '__pycache__')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { await walk(full); continue; }
            if (!e.isFile()) continue;
            fileCount++;
            if (fileCount > MAX_FALLBACK_WALK_FILES) throw WALK_LIMIT;
            await add(full, e.name);
          }
        };
        await walk(wsDir);
      } catch (err) {
        if (err === WALK_LIMIT) {
          out.length = startLen; // 回滚本次兜底新增——防爆炸目录污染产物列表
          try {
            const log = (await import('../logger')).createLogger('spaces_artifacts');
            log.warn(`space artifacts fallback walk aborted: ${MAX_FALLBACK_WALK_FILES} file limit exceeded uid=${uid} cid=${cid}`);
          } catch { /* best-effort */ }
        }
        // 其它错误（工作区不存在/不可读）静默
      }
    }
  } catch (err) {
    // 工作区解析失败不阻断列表
  }
}

// COGSEED-18：本地文件夹整体导入的产物（<空间内容目录>/imports/**，保留目录结构）。
// 全部为正式产物（无确认态），打开/删除沿用产物既有能力。
async function scanImportedFiles(uid: string, spaceId: string, out: SpaceArtifactEntry[]): Promise<void> {
  const root = path.join(spaceContentDir(uid, spaceId), 'imports');
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      let mtime = 0;
      try { mtime = Math.floor((await fsp.stat(full)).mtimeMs / 1000); } catch { /* keep 0 */ }
      out.push({
        name: e.name, type: 'attachment', ext: path.extname(e.name).toLowerCase(),
        sourceSessionId: '', time: mtime, source: 'import', confirmed: true, path: full,
      });
    }
  };
  await walk(root);
}

/** 空间产物聚合：附件 + artifact + AI 产出文件统一列表，按时间倒序。空空间返回空数组（不 mock）。
 *  空间级「变更才扫」缓存：指纹一致直接返回（见 _spaceArtifactsStamp），
 *  指纹变化或超过兜底窗口才重扫；新建会话时由 invalidateSpaceArtifacts 失效。 */
export async function listSpaceArtifacts(uid: string, spaceId: string): Promise<SpaceArtifactEntry[]> {
  if (!spaceId) return [];
  const startedAt = Date.now();
  const stamp = await _spaceArtifactsStamp(uid, spaceId);
  const cached = _artifactCache.get(spaceId);
  if (cached && cached.uid === uid && cached.stamp === stamp && Date.now() - cached.at < ARTIFACT_STAMP_BACKSTOP_MS) {
    // 性能埋点：缓存命中路径（诊断用，仅计数/时长）。
    try {
      const perfLog = (await import('../logger')).createLogger('spaces_artifacts');
      perfLog.info('listSpaceArtifacts cache hit', { items: cached.items.length, ms: Date.now() - startedAt });
    } catch { /* best-effort */ }
    return [...cached.items];
  }
  // 持久化元数据表：重启后冷启动直接查表，不再全盘扫描。
  const meta = await import('./workspace_meta');
  const tableEntry = await meta.getEntry<SpaceArtifactEntry[]>(uid, 'artifacts', spaceId);
  if (tableEntry && tableEntry.stamp === stamp) {
    _artifactCache.set(spaceId, { uid, at: Date.now(), stamp, items: tableEntry.data });
    try {
      const perfLog = (await import('../logger')).createLogger('spaces_artifacts');
      perfLog.info('listSpaceArtifacts table hit', { items: tableEntry.data.length, ms: Date.now() - startedAt });
    } catch { /* best-effort */ }
    return [...tableEntry.data];
  }
  // 触发一次附件/网页产物空间化迁移（幂等，进程内只跑一次）
  if (!_migratedSpaces.has(spaceId)) {
    try { await migrateSpaceAttachments(uid, spaceId); } catch { /* 迁移失败不阻断列表 */ }
    _migratedSpaces.add(spaceId);
  }
  const conversations = await listSpaceConversations(uid, spaceId);
  const out: SpaceArtifactEntry[] = [];
  const walkedWorkspaces = new Set<string>();
  for (const c of conversations) {
    await scanAttachments(uid, spaceId, c.conversation_id, out);
    await scanArtifacts(uid, spaceId, c.conversation_id, out);
    await scanProducedFiles(uid, spaceId, c.conversation_id, out, walkedWorkspaces);
  }
  await scanImportedFiles(uid, spaceId, out);
  out.sort((a, b) => b.time - a.time);
  // 迁移可能搬动附件/产物目录——存缓存前按扫描后的状态重算指纹。
  const finalStamp = await _spaceArtifactsStamp(uid, spaceId);
  _artifactCache.set(spaceId, { uid, at: Date.now(), stamp: finalStamp, items: out });
  try {
    await meta.putEntry(uid, 'artifacts', spaceId, finalStamp, out);
  } catch { /* 表写入失败不阻断列表 */ }
  try {
    const perfLog = (await import('../logger')).createLogger('spaces_artifacts');
    perfLog.info('listSpaceArtifacts scanned', { items: out.length, convs: conversations.length, ms: Date.now() - startedAt });
  } catch { /* best-effort */ }
  return [...out];
}
