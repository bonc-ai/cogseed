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
import * as path from 'node:path';

import { chatArtifactCidDir, chatAttachmentDir, spaceChatAttachmentDir, spaceChatArtifactCidDir, spaceContentDir } from '../paths';
import { safeId } from '../storage';
import { ALLOWED_EXTENSIONS } from './chat_attachments';
import { getMessages, listSpaceConversations } from './chats';

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
// 磁盘扫描（每个会话读消息 produced[] + 递归遍历工作区目录）。不加缓存时
// 每次切空间都重扫，会话多/聊天长/产物多时延迟随数据量线性放大，且同步
// 扫描会阻塞主进程（整个应用卡顿）。这里做空间级缓存：
//   - TTL 内命中直接返回（切空间/反复进出秒回）；
//   - 空间内新建会话时主动失效（invalidateSpaceArtifacts）；
//   - 缓存值带 uid，多账号不会串数据。
const ARTIFACT_CACHE_TTL_MS = 30_000;
const _artifactCache = new Map<string, { uid: string; at: number; items: SpaceArtifactEntry[] }>();

/** 空间产物缓存失效：空间内新建会话后调用，保证下次列表新鲜。 */
export function invalidateSpaceArtifacts(spaceId: string): void {
  if (!spaceId) return;
  _artifactCache.delete(spaceId);
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

/** 扫描 AI 产出文件：先走消息 produced[]（已登记），再兜底扫会话工作区目录
 *  （未登记进 produced 的产物，如部分工具直接写文件）。按文件名去重（附件优先）。
 *  COGSEED-16：产物无确认态——所有产出自动成为正式产物，直接可打开/引用/删除。 */
async function scanProducedFiles(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): Promise<void> {
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
  try {
    const { getConversationWorkspacePath } = await import('./group_chat/conv_workspace');
    const wsDir = await getConversationWorkspacePath(uid, cid);
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[] = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) await add(full, e.name);
      }
    };
    if (wsDir) {
      try { await fsp.stat(wsDir); await walk(wsDir); } catch { /* 工作区不存在/不可读 */ }
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
 *  空间级缓存：TTL 内命中直接返回；新建会话时由 invalidateSpaceArtifacts 失效。 */
export async function listSpaceArtifacts(uid: string, spaceId: string): Promise<SpaceArtifactEntry[]> {
  if (!spaceId) return [];
  const cached = _artifactCache.get(spaceId);
  if (cached && cached.uid === uid && Date.now() - cached.at < ARTIFACT_CACHE_TTL_MS) {
    return [...cached.items];
  }
  // 触发一次附件/网页产物空间化迁移（幂等，进程内只跑一次）
  if (!_migratedSpaces.has(spaceId)) {
    try { await migrateSpaceAttachments(uid, spaceId); } catch { /* 迁移失败不阻断列表 */ }
    _migratedSpaces.add(spaceId);
  }
  const conversations = await listSpaceConversations(uid, spaceId);
  const out: SpaceArtifactEntry[] = [];
  for (const c of conversations) {
    await scanAttachments(uid, spaceId, c.conversation_id, out);
    await scanArtifacts(uid, spaceId, c.conversation_id, out);
    await scanProducedFiles(uid, spaceId, c.conversation_id, out);
  }
  await scanImportedFiles(uid, spaceId, out);
  out.sort((a, b) => b.time - a.time);
  _artifactCache.set(spaceId, { uid, at: Date.now(), items: out });
  return [...out];
}
