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
import { writeJson } from '../storage';
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

export type SpaceArtifactType = 'attachment' | 'artifact';
/** 产物来源：attachment=上传附件；artifact=网页交互产物；produced=AI 工具产出文件。 */
export type SpaceArtifactSource = 'attachment' | 'artifact' | 'produced';

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
  /** 是否正式产物：附件/网页直接算；AI 产出需用户确认（确认清单）。 */
  confirmed: boolean;
  /** 绝对路径（打开产物用）。 */
  path?: string;
  /** 仅 artifact：产物目录 id。 */
  artifactId?: string;
}

function scanAttachments(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): void {
  // 附件可能落在两处：空间目录（v5 迁移的历史项目数据）+ 全局会话附件目录（新上传）。
  // 都扫一遍按文件名去重，保证产物列表完整（引用时以 source_cid+文件名走跨任务引用链路）。
  const dirs = [spaceChatAttachmentDir(uid, spaceId, cid), chatAttachmentDir(uid, cid)];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const ext = path.extname(e.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      let mtime = 0;
      try { mtime = Math.floor(fs.statSync(path.join(dir, e.name)).mtimeMs / 1000); } catch { /* keep 0 */ }
      out.push({
        name: e.name, type: 'attachment', ext, sourceSessionId: cid, time: mtime,
        source: 'attachment', confirmed: true, path: path.join(dir, e.name),
      });
    }
  }
}

function scanArtifacts(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): void {
  // 双目录：空间目录（v5 迁移）+ 全局 chat_artifacts（新产出；无 project 的会话落全局根）
  const dirs = [spaceChatArtifactCidDir(uid, spaceId, cid), chatArtifactCidDir(uid, cid)];
  const seenArt = new Set<string>();
  for (const cidDir of dirs) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(cidDir, { withFileTypes: true }); }
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
        const raw = fs.readFileSync(path.join(artDir, ARTIFACT_META_FILENAME), 'utf8');
        const meta = JSON.parse(raw) as { title?: unknown; createdAt?: unknown };
        if (typeof meta?.title === 'string' && meta.title.trim()) name = meta.title.trim();
        const t = Date.parse(String(meta?.createdAt || ''));
        if (Number.isFinite(t)) time = Math.floor(t / 1000);
      } catch { /* missing / malformed meta */ }
      if (!time) {
        try { time = Math.floor(fs.statSync(artDir).mtimeMs / 1000); } catch { /* keep 0 */ }
      }
      out.push({
        name, type: 'artifact', ext: '.html', sourceSessionId: cid, time, artifactId,
        source: 'artifact', confirmed: true, path: path.join(artDir, 'index.html'),
      });
    }
  }
}

/** 空间级产物确认/驳回清单落点：`<sid>/artifacts_state.json` = { confirmed: {[cid]:string[]}, rejected: {[cid]:string[]} }。
 *  确认 = 正式产物；驳回 = 不再作为候选展示。随 deleteSpace 的 spaceContentDir 一起删。 */
function artifactsStateFile(uid: string, spaceId: string): string {
  return path.join(spaceContentDir(uid, spaceId), 'artifacts_state.json');
}

interface ArtifactsState {
  confirmed: Record<string, string[]>;
  rejected: Record<string, string[]>;
}

function readArtifactsState(uid: string, spaceId: string): ArtifactsState {
  const out: ArtifactsState = { confirmed: {}, rejected: {} };
  const norm = (v: unknown): Record<string, string[]> => {
    const r: Record<string, string[]> = {};
    if (v && typeof v === 'object') {
      for (const [cid, names] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(names)) r[cid] = (names as unknown[]).filter((n): n is string => typeof n === 'string');
      }
    }
    return r;
  };
  try {
    const raw = JSON.parse(fs.readFileSync(artifactsStateFile(uid, spaceId), 'utf8'));
    if (raw && typeof raw === 'object') {
      out.confirmed = norm((raw as ArtifactsState).confirmed);
      out.rejected = norm((raw as ArtifactsState).rejected);
      return out;
    }
  } catch { /* new file missing/malformed → fall through */ }
  // 兼容旧版 confirmed_artifacts.json（{ [cid]: string[] }）：迁移到新结构
  const legacy = path.join(spaceContentDir(uid, spaceId), 'confirmed_artifacts.json');
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (raw && typeof raw === 'object') {
      out.confirmed = norm(raw);
      // 迁移：写新文件（保留旧文件不动，避免回滚丢状态）
      void writeArtifactsState(uid, spaceId, out).catch(() => {});
    }
  } catch { /* no legacy either */ }
  return out;
}

async function writeArtifactsState(uid: string, spaceId: string, state: ArtifactsState): Promise<void> {
  const f = artifactsStateFile(uid, spaceId);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await writeJson(f, state);
}

/** 确认某 AI 产出文件为正式产物（幂等；确认即从驳回态移除）。 */
export async function confirmSpaceArtifact(
  uid: string,
  spaceId: string,
  cid: string,
  name: string,
): Promise<{ ok: true; confirmed: string[] } | { ok: false; error: string }> {
  if (!spaceId || !cid || !name) return { ok: false, error: 'invalid_artifact' };
  const state = readArtifactsState(uid, spaceId);
  const confirmed = state.confirmed[cid] ? [...state.confirmed[cid]] : [];
  if (!confirmed.includes(name)) confirmed.push(name);
  state.confirmed[cid] = confirmed;
  // 确认后不再处于驳回态
  if (state.rejected[cid]) state.rejected[cid] = state.rejected[cid].filter((n) => n !== name);
  await writeArtifactsState(uid, spaceId, state);
  return { ok: true, confirmed };
}

/** 驳回某候选产物（幂等；驳回后不再作为候选展示）。 */
export async function rejectSpaceArtifact(
  uid: string,
  spaceId: string,
  cid: string,
  name: string,
): Promise<{ ok: true; rejected: string[] } | { ok: false; error: string }> {
  if (!spaceId || !cid || !name) return { ok: false, error: 'invalid_artifact' };
  const state = readArtifactsState(uid, spaceId);
  const rejected = state.rejected[cid] ? [...state.rejected[cid]] : [];
  if (!rejected.includes(name)) rejected.push(name);
  state.rejected[cid] = rejected;
  // 驳回后不再是正式产物
  if (state.confirmed[cid]) state.confirmed[cid] = state.confirmed[cid].filter((n) => n !== name);
  await writeArtifactsState(uid, spaceId, state);
  return { ok: true, rejected };
}

/** 扫描 AI 产出文件：先走消息 produced[]（已登记），再兜底扫会话工作区目录
 *  （未登记进 produced 的产物，如部分工具直接写文件）。按文件名去重（附件优先）。
 *  这些是「候选产物」：confirmed 由空间确认清单决定（用户确认后正式）。 */
async function scanProducedFiles(uid: string, spaceId: string, cid: string, out: SpaceArtifactEntry[]): Promise<void> {
  const state = readArtifactsState(uid, spaceId);
  const confirmedSet = new Set(state.confirmed[cid] || []);
  const rejectedSet = new Set(state.rejected[cid] || []);
  const seen = new Set(out.map((o) => o.name));
  const add = (abs: string, name: string): void => {
    if (!name || seen.has(name)) return;
    // 已驳回的候选不再展示
    if (rejectedSet.has(name)) return;
    const ext = path.extname(name).toLowerCase();
    // 宽扩展名：附件上传白名单之外，工作区产物放行旧 Office / svg / 压缩包 / html 等
    // （AI 产出的都能落位），不放松附件上传边界（上传仍走 ALLOWED_EXTENSIONS）。
    if (!isProducedExt(ext)) return;
    if (!fs.existsSync(abs)) return;
    seen.add(name);
    let t = 0;
    try { t = Math.floor(fs.statSync(abs).mtimeMs / 1000); } catch { /* keep 0 */ }
    out.push({
      name, type: 'attachment', ext, sourceSessionId: cid, time: t,
      source: 'produced', confirmed: confirmedSet.has(name), path: abs,
    });
  };
  // 1. 消息 produced[]（已登记为产物的文件）
  try {
    const messages = await getMessages(uid, cid, 1000);
    for (const m of messages) {
      for (const raw of m.produced || []) {
        const p = typeof raw === 'string' ? raw : '';
        if (!p) continue;
        add(p, path.basename(p));
      }
    }
  } catch (err) {
    // 消息读取失败不阻断（继续工作区兜底）
  }
  // 2. 会话工作区目录兜底（部分工具直接写文件、未登记 produced；递归子目录防漏）
  try {
    const { getConversationWorkspacePath } = await import('./group_chat/conv_workspace');
    const wsDir = await getConversationWorkspacePath(uid, cid);
    const walk = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) add(full, e.name);
      }
    };
    if (wsDir && fs.existsSync(wsDir)) walk(wsDir);
  } catch (err) {
    // 工作区解析失败不阻断列表
  }
}

/** 空间产物聚合：附件 + artifact + AI 产出文件统一列表，按时间倒序。空空间返回空数组（不 mock）。 */
export async function listSpaceArtifacts(uid: string, spaceId: string): Promise<SpaceArtifactEntry[]> {
  if (!spaceId) return [];
  const conversations = await listSpaceConversations(uid, spaceId);
  const out: SpaceArtifactEntry[] = [];
  for (const c of conversations) {
    scanAttachments(uid, spaceId, c.conversation_id, out);
    scanArtifacts(uid, spaceId, c.conversation_id, out);
    await scanProducedFiles(uid, spaceId, c.conversation_id, out);
  }
  out.sort((a, b) => b.time - a.time);
  return out;
}
